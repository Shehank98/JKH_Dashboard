'use strict';
// Self-service sign-in: Ogilvy email + password, confirmed with a 6-digit code sent by email.
// Accounts, sessions and pending codes live in DATA_DIR/auth.json (the same Railway volume as the data).
// Passwords are scrypt hashes; codes and session tokens are stored as SHA-256 hashes only.

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const COOKIE = 'ooc_session';
const SESSION_DAYS = Number(process.env.SESSION_DAYS || 30);
const CODE_MINUTES = 10;
const CODE_TRIES = 5;
const RESEND_SECONDS = Number(process.env.CODE_RESEND_SECONDS || 60);
const DOMAINS = String(process.env.ALLOWED_EMAIL_DOMAINS || 'ogilvy.com').toLowerCase().split(',').map(s => s.trim()).filter(Boolean);
const MAIL_URL = process.env.APPS_SCRIPT_URL || '';
const MAIL_SECRET = process.env.APPS_SCRIPT_SECRET || '';
const APP_NAME = 'Ogilvy Orbit Chub';

const sha = s => crypto.createHash('sha256').update(String(s)).digest('hex');
const now = () => Date.now();
const normEmail = e => String(e || '').trim().toLowerCase();
const emailOk = e => /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(e) && DOMAINS.includes(e.split('@')[1]);
const passwordProblem = p => {
  p = String(p || '');
  if (p.length < 6) return 'Password must be at least 6 characters.';
  if (!/[a-z]/i.test(p) || !/\d/.test(p)) return 'Password needs at least one letter and one number.';
  if (p.length > 200) return 'Password is too long.';
  return null;
};
const hashPassword = (pw, salt = crypto.randomBytes(16).toString('hex')) =>
  ({ salt, hash: crypto.scryptSync(String(pw), salt, 64).toString('hex') });
const passwordMatches = (user, pw) => {
  const h = crypto.scryptSync(String(pw), user.salt, 64);
  const want = Buffer.from(user.hash, 'hex');
  return want.length === h.length && crypto.timingSafeEqual(h, want);
};
const escHtml = s => String(s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

class HttpError extends Error { constructor(status, msg, extra) { super(msg); this.status = status; this.extra = extra; } }

function createAuth(dataDir) {
  const file = path.join(dataDir, 'auth.json');
  let db = { users: {}, sessions: {}, codes: {} };
  try { db = { ...db, ...JSON.parse(fs.readFileSync(file, 'utf8')) }; } catch (e) { /* first run */ }
  const save = () => {
    const t = now();
    for (const [k, s] of Object.entries(db.sessions)) if (s.exp < t) delete db.sessions[k];
    for (const [k, c] of Object.entries(db.codes)) if (c.exp < t - 3600e3) delete db.codes[k];
    const tmp = file + '.tmp';
    fs.writeFileSync(tmp, JSON.stringify(db));
    fs.renameSync(tmp, file);
  };

  // Failed sign-ins per email, to slow down password guessing.
  const fails = new Map();
  const lockedFor = email => {
    const f = fails.get(email);
    if (!f || f.n < 8) return 0;
    const wait = f.at + 15 * 60e3 - now();
    if (wait <= 0) { fails.delete(email); return 0; }
    return Math.ceil(wait / 60e3);
  };
  const failed = email => { const f = fails.get(email) || { n: 0, at: 0 }; fails.set(email, { n: f.n + 1, at: now() }); };

  // Code emails per IP address per hour, so the form cannot be used to burn the daily email quota.
  const IP_LIMIT = Number(process.env.CODE_EMAILS_PER_IP_HOUR || 15);
  const ipSends = new Map();
  const limitIp = req => {
    const ip = req.ip || 'unknown', t = now();
    const recent = (ipSends.get(ip) || []).filter(x => t - x < 3600e3);
    if (recent.length >= IP_LIMIT) throw new HttpError(429, 'Too many code requests from this network. Please try again later.');
    recent.push(t);
    ipSends.set(ip, recent);
  };

  async function sendMail(to, subject, text, html) {
    if (!MAIL_URL) {
      console.log(`[mail:dev] APPS_SCRIPT_URL not set, not emailing. to=${to} subject="${subject}" ${text.replace(/\s+/g, ' ')}`);
      return;
    }
    const r = await fetch(MAIL_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'text/plain;charset=utf-8' }, // Apps Script reads e.postData.contents
      body: JSON.stringify({ secret: MAIL_SECRET, to, subject, text, html, name: APP_NAME }),
      redirect: 'follow',
    });
    const body = await r.text();
    let j = null;
    try { j = JSON.parse(body); } catch (e) { /* not JSON */ }
    if (!r.ok || !j || !j.ok) throw new Error('Mail service error: ' + ((j && j.error) || r.status + ' ' + body.slice(0, 120)));
  }

  async function sendCode(email, purpose) {
    const key = email + ':' + purpose;
    const prev = db.codes[key];
    if (prev && now() - prev.sentAt < RESEND_SECONDS * 1000) {
      throw new HttpError(429, `Please wait ${Math.ceil((prev.sentAt + RESEND_SECONDS * 1000 - now()) / 1000)} seconds before asking for another code.`);
    }
    const code = String(crypto.randomInt(0, 1e6)).padStart(6, '0');
    db.codes[key] = { hash: sha(key + ':' + code), exp: now() + CODE_MINUTES * 60e3, tries: 0, sentAt: now() };
    save();
    const name = (db.users[email] && db.users[email].name) || '';
    const what = purpose === 'reset' ? 'reset your password' : 'confirm your email';
    const subject = `${code} is your ${APP_NAME} code`;
    const text = `Hi ${name || 'there'},\n\nUse this code to ${what}: ${code}\n\nIt expires in ${CODE_MINUTES} minutes. If you did not ask for it, you can ignore this email.\n\n${APP_NAME} · JKH Group Dashboard`;
    const html = `<div style="font-family:Arial,sans-serif;max-width:480px;margin:auto;color:#1A1F36">
      <p style="font-size:20px;font-weight:bold;color:#E0383E;margin:0 0 16px">${APP_NAME}</p>
      <p>Hi ${escHtml(name || 'there')},</p><p>Use this code to ${what}:</p>
      <p style="font-size:32px;font-weight:bold;letter-spacing:8px;background:#F4F6FA;padding:16px;text-align:center;border-radius:10px">${code}</p>
      <p style="color:#6B7590;font-size:13px">It expires in ${CODE_MINUTES} minutes. If you did not ask for it, you can ignore this email.</p>
      <p style="color:#8A93AD;font-size:12px">${APP_NAME} · JKH Group Dashboard</p></div>`;
    try { await sendMail(email, subject, text, html); }
    catch (e) {
      delete db.codes[key]; save();
      console.error('[mail] send failed:', e.message);
      throw new HttpError(502, 'We could not send the email right now. Please try again in a minute.');
    }
  }

  function checkCode(email, purpose, code) {
    const key = email + ':' + purpose;
    const c = db.codes[key];
    if (!c || c.exp < now()) throw new HttpError(400, 'This code has expired. Ask for a new one.');
    if (c.tries >= CODE_TRIES) throw new HttpError(400, 'Too many wrong attempts. Ask for a new code.');
    if (sha(key + ':' + String(code || '').trim()) !== c.hash) {
      c.tries++; save();
      throw new HttpError(400, `That code is not right. ${CODE_TRIES - c.tries} attempt${CODE_TRIES - c.tries === 1 ? '' : 's'} left.`);
    }
    delete db.codes[key];
  }

  function startSession(res, req, email) {
    const token = crypto.randomBytes(32).toString('base64url');
    db.sessions[sha(token)] = { email, exp: now() + SESSION_DAYS * 86400e3, created: new Date().toISOString() };
    db.users[email].lastLogin = new Date().toISOString();
    save();
    res.cookie(COOKIE, token, { httpOnly: true, sameSite: 'lax', secure: req.secure, maxAge: SESSION_DAYS * 86400e3, path: '/' });
  }

  const readCookie = (req, name) => {
    for (const part of String(req.headers.cookie || '').split(';')) {
      const i = part.indexOf('=');
      if (i > 0 && part.slice(0, i).trim() === name) return decodeURIComponent(part.slice(i + 1).trim());
    }
    return null;
  };
  function userOf(req) {
    const token = readCookie(req, COOKIE);
    if (!token) return null;
    const s = db.sessions[sha(token)];
    if (!s || s.exp < now()) return null;
    const u = db.users[s.email];
    return u && u.verified ? u : null;
  }
  const publicUser = u => ({ name: u.name, email: u.email });

  // ---- route handlers ----
  const handlers = {
    async signup(req, res) {
      const name = String(req.body.name || '').trim().slice(0, 80);
      const email = normEmail(req.body.email);
      if (name.length < 2) throw new HttpError(400, 'Please enter your full name.');
      if (!emailOk(email)) throw new HttpError(400, `Please use your Ogilvy email address (@${DOMAINS.join(' or @')}).`);
      const bad = passwordProblem(req.body.password);
      if (bad) throw new HttpError(400, bad);
      if (req.body.confirm != null && req.body.confirm !== req.body.password) throw new HttpError(400, 'Passwords do not match.');
      const existing = db.users[email];
      if (existing && existing.verified) throw new HttpError(409, 'An account with this email already exists. Please sign in.');
      limitIp(req);
      db.users[email] = { name, email, ...hashPassword(req.body.password), verified: false, created: (existing && existing.created) || new Date().toISOString() };
      save();
      await sendCode(email, 'verify');
      res.json({ ok: true, next: 'verify', email });
    },
    async verify(req, res) {
      const email = normEmail(req.body.email);
      const u = db.users[email];
      if (!u) throw new HttpError(400, 'No account found for this email.');
      checkCode(email, 'verify', req.body.code);
      u.verified = true;
      startSession(res, req, email);
      res.json({ ok: true, user: publicUser(u) });
    },
    async login(req, res) {
      const email = normEmail(req.body.email);
      const wait = lockedFor(email);
      if (wait) throw new HttpError(429, `Too many failed attempts. Try again in ${wait} minute${wait === 1 ? '' : 's'} or reset your password.`);
      const u = db.users[email];
      if (!u || !passwordMatches(u, req.body.password)) { failed(email); throw new HttpError(401, 'Email or password is not right.'); }
      fails.delete(email);
      if (!u.verified) {
        try { await sendCode(email, 'verify'); } catch (e) { if (e.status !== 429) throw e; }
        return res.json({ ok: true, next: 'verify', email });
      }
      startSession(res, req, email);
      res.json({ ok: true, user: publicUser(u) });
    },
    async forgot(req, res) {
      const email = normEmail(req.body.email);
      if (!emailOk(email)) throw new HttpError(400, `Please enter your Ogilvy email address (@${DOMAINS.join(' or @')}).`);
      // Same answer whether or not the account exists, so the form cannot be used to find accounts.
      limitIp(req);
      if (db.users[email]) await sendCode(email, 'reset');
      res.json({ ok: true, next: 'reset', email });
    },
    async reset(req, res) {
      const email = normEmail(req.body.email);
      const bad = passwordProblem(req.body.password);
      if (bad) throw new HttpError(400, bad);
      if (req.body.confirm != null && req.body.confirm !== req.body.password) throw new HttpError(400, 'Passwords do not match.');
      const u = db.users[email];
      if (!u) throw new HttpError(400, 'This code has expired. Ask for a new one.');
      checkCode(email, 'reset', req.body.code);
      Object.assign(u, hashPassword(req.body.password), { verified: true });
      // A password reset signs out every other device.
      for (const [k, s] of Object.entries(db.sessions)) if (s.email === email) delete db.sessions[k];
      fails.delete(email);
      startSession(res, req, email);
      res.json({ ok: true, user: publicUser(u) });
    },
    async resend(req, res) {
      const email = normEmail(req.body.email);
      const purpose = req.body.purpose === 'reset' ? 'reset' : 'verify';
      const u = db.users[email];
      limitIp(req);
      if (u && (purpose === 'reset' || !u.verified)) await sendCode(email, purpose);
      res.json({ ok: true });
    },
    async logout(req, res) {
      const token = readCookie(req, COOKIE);
      if (token && db.sessions[sha(token)]) { delete db.sessions[sha(token)]; save(); }
      res.clearCookie(COOKIE, { path: '/' });
      res.json({ ok: true });
    },
    async me(req, res) {
      const u = userOf(req);
      if (!u) throw new HttpError(401, 'Not signed in');
      res.json({ user: publicUser(u) });
    },
  };

  function router(express) {
    const r = express.Router();
    for (const [name, fn] of Object.entries(handlers)) {
      r[name === 'me' ? 'get' : 'post']('/' + name, (req, res) => {
        req.body = req.body || {};
        Promise.resolve(fn(req, res)).catch(e => {
          if (!(e instanceof HttpError)) console.error('[auth]', e);
          res.status(e.status || 500).json({ error: e instanceof HttpError ? e.message : 'Something went wrong. Please try again.' });
        });
      });
    }
    return r;
  }

  // API calls without a session get 401; page loads are sent to the sign-in page.
  const requireApi = (req, res, next) => {
    const u = userOf(req);
    if (!u) return res.status(401).json({ error: 'Please sign in', signIn: true });
    req.user = u;
    next();
  };
  const requirePage = (req, res, next) => {
    if (userOf(req)) return next();
    res.redirect('/login');
  };

  return { router, requireApi, requirePage, userOf, mailConfigured: !!MAIL_URL, domains: DOMAINS };
}

module.exports = { createAuth };
