'use strict';
// Self-service sign-in: Ogilvy email + password, confirmed with a 6-digit code sent by email.
// Accounts, sessions and pending codes live in DATA_DIR/auth.json (the same Railway volume as the data).
// Passwords are scrypt hashes; codes and session tokens are stored as SHA-256 hashes only.

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const COOKIE = 'ooc_session';
const ADMIN_COOKIE = 'ooc_admin';
const ADMIN_HOURS = Number(process.env.ADMIN_SESSION_HOURS || 12);
// People in ADMIN_EMAILS are always admins (the first admin has to come from somewhere); others can be promoted in the panel.
const ENV_ADMINS = String(process.env.ADMIN_EMAILS || '').toLowerCase().split(',').map(s => s.trim()).filter(Boolean);
const MAX_EVENTS = 2000;
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
  let db = { users: {}, sessions: {}, codes: {}, adminSessions: {}, events: [] };
  try { db = { ...db, ...JSON.parse(fs.readFileSync(file, 'utf8')) }; } catch (e) { /* first run */ }
  const save = () => {
    const t = now();
    for (const [k, s] of Object.entries(db.sessions)) if (s.exp < t) delete db.sessions[k];
    for (const [k, c] of Object.entries(db.codes)) if (c.exp < t - 3600e3) delete db.codes[k];
    for (const [k, s] of Object.entries(db.adminSessions)) if (s.exp < t) delete db.adminSessions[k];
    if (db.events.length > MAX_EVENTS) db.events.splice(0, db.events.length - MAX_EVENTS);
    const tmp = file + '.tmp';
    fs.writeFileSync(tmp, JSON.stringify(db));
    fs.renameSync(tmp, file);
  };

  const isAdmin = u => !!u && (u.role === 'admin' || ENV_ADMINS.includes(u.email));
  // Activity log for the admin panel: sign-ups, sign-ins (and failures), resets and admin actions.
  const log = (req, type, email, extra) => {
    db.events.push({ t: new Date().toISOString(), type, email: email || '', ip: (req && req.ip) || '', ...(extra || {}) });
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

  async function sendCode(email, purpose, opts = {}) {
    const key = email + ':' + purpose;
    const prev = db.codes[key];
    if (prev && now() - prev.sentAt < RESEND_SECONDS * 1000) {
      throw new HttpError(429, `Please wait ${Math.ceil((prev.sentAt + RESEND_SECONDS * 1000 - now()) / 1000)} seconds before asking for another code.`);
    }
    const code = String(crypto.randomInt(0, 1e6)).padStart(6, '0');
    db.codes[key] = { hash: sha(key + ':' + code), exp: now() + CODE_MINUTES * 60e3, tries: 0, sentAt: now() };
    save();
    const name = (db.users[email] && db.users[email].name) || '';
    const what = purpose === 'reset' ? (opts.invite ? 'set your password' : 'reset your password') : 'confirm your email';
    const intro = opts.invite ? `You have been invited to the ${APP_NAME} Live Dashboard.` : '';
    const minutes = opts.minutes || CODE_MINUTES;
    const lasts = m => (m >= 2880 && m % 1440 === 0 ? m / 1440 + ' days' : m >= 120 ? Math.round(m / 60) + ' hours' : m + ' minutes');
    if (opts.minutes) db.codes[key].exp = now() + minutes * 60e3;
    const subject = opts.invite ? `You're invited to ${APP_NAME} (code ${code})` : `${code} is your ${APP_NAME} code`;
    const linkText = opts.link ? `\n\nOpen ${opts.link} and enter the code there.` : '';
    const text = `Hi ${name || 'there'},\n\n${intro ? intro + '\n\n' : ''}Use this code to ${what}: ${code}${linkText}\n\nIt expires in ${lasts(minutes)}. If you did not ask for it, you can ignore this email.\n\n${APP_NAME} Live Dashboard`;
    const html = `<div style="font-family:Arial,sans-serif;max-width:480px;margin:auto;color:#1A1F36">
      <p style="font-size:20px;font-weight:bold;color:#E0383E;margin:0 0 16px">${APP_NAME}</p>
      <p>Hi ${escHtml(name || 'there')},</p>${intro ? `<p>${escHtml(intro)}</p>` : ''}<p>Use this code to ${what}:</p>
      <p style="font-size:32px;font-weight:bold;letter-spacing:8px;background:#F4F6FA;padding:16px;text-align:center;border-radius:10px">${code}</p>
      ${opts.link ? `<p style="text-align:center"><a href="${escHtml(opts.link)}" style="display:inline-block;background:#E0383E;color:#fff;text-decoration:none;font-weight:bold;padding:12px 22px;border-radius:10px">${opts.invite ? 'Set my password' : 'Reset my password'}</a></p>` : ''}
      <p style="color:#6B7590;font-size:13px">It expires in ${lasts(minutes)}. If you did not ask for it, you can ignore this email.</p>
      <p style="color:#8A93AD;font-size:12px">${APP_NAME} Live Dashboard</p></div>`;
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

  const deviceOf = req => String(req.headers['user-agent'] || '').slice(0, 160);
  function startSession(res, req, email) {
    const token = crypto.randomBytes(32).toString('base64url');
    db.sessions[sha(token)] = { email, exp: now() + SESSION_DAYS * 86400e3, created: new Date().toISOString(), lastSeen: now(), ip: req.ip || '', ua: deviceOf(req) };
    db.users[email].lastLogin = db.users[email].lastSeen = new Date().toISOString();
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
    if (!u || !u.verified || u.disabled) return null;
    // "Last active" for the admin panel, written at most every 5 minutes per session.
    if (!s.lastSeen || now() - s.lastSeen > 5 * 60e3) { s.lastSeen = now(); u.lastSeen = new Date().toISOString(); save(); }
    return u;
  }
  const publicUser = u => ({ name: u.name, email: u.email, admin: isAdmin(u) });
  const DISABLED = 'This account has been disabled. Please contact the automation team.';
  const endSessions = email => { for (const [k, s] of Object.entries(db.sessions)) if (s.email === email) delete db.sessions[k]; };

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
      if (existing && existing.disabled) throw new HttpError(403, DISABLED);
      if (existing && existing.verified) throw new HttpError(409, 'An account with this email already exists. Please sign in.');
      limitIp(req);
      db.users[email] = { ...(existing || {}), name, email, ...hashPassword(req.body.password), verified: false, created: (existing && existing.created) || new Date().toISOString() };
      log(req, 'signup', email);
      save();
      await sendCode(email, 'verify');
      res.json({ ok: true, next: 'verify', email });
    },
    async verify(req, res) {
      const email = normEmail(req.body.email);
      const u = db.users[email];
      if (!u) throw new HttpError(400, 'No account found for this email.');
      if (u.disabled) throw new HttpError(403, DISABLED);
      checkCode(email, 'verify', req.body.code);
      u.verified = true;
      log(req, 'verified', email);
      startSession(res, req, email);
      res.json({ ok: true, user: publicUser(u) });
    },
    async login(req, res) {
      const email = normEmail(req.body.email);
      const wait = lockedFor(email);
      if (wait) throw new HttpError(429, `Too many failed attempts. Try again in ${wait} minute${wait === 1 ? '' : 's'} or reset your password.`);
      const u = db.users[email];
      if (!u || !passwordMatches(u, req.body.password)) {
        failed(email); log(req, 'login_failed', email); save();
        throw new HttpError(401, 'Email or password is not right.');
      }
      fails.delete(email);
      if (u.disabled) { log(req, 'login_blocked', email); save(); throw new HttpError(403, DISABLED); }
      if (!u.verified) {
        try { await sendCode(email, 'verify'); } catch (e) { if (e.status !== 429) throw e; }
        return res.json({ ok: true, next: 'verify', email });
      }
      log(req, 'login', email);
      startSession(res, req, email);
      res.json({ ok: true, user: publicUser(u) });
    },
    async forgot(req, res) {
      const email = normEmail(req.body.email);
      if (!emailOk(email)) throw new HttpError(400, `Please enter your Ogilvy email address (@${DOMAINS.join(' or @')}).`);
      // Same answer whether or not the account exists, so the form cannot be used to find accounts.
      limitIp(req);
      if (db.users[email] && !db.users[email].disabled) { await sendCode(email, 'reset'); log(req, 'reset_requested', email); save(); }
      res.json({ ok: true, next: 'reset', email });
    },
    async reset(req, res) {
      const email = normEmail(req.body.email);
      const bad = passwordProblem(req.body.password);
      if (bad) throw new HttpError(400, bad);
      if (req.body.confirm != null && req.body.confirm !== req.body.password) throw new HttpError(400, 'Passwords do not match.');
      const u = db.users[email];
      if (!u) throw new HttpError(400, 'This code has expired. Ask for a new one.');
      if (u.disabled) throw new HttpError(403, DISABLED);
      checkCode(email, 'reset', req.body.code);
      Object.assign(u, hashPassword(req.body.password), { verified: true });
      delete u.invited;
      // A password reset signs out every other device.
      endSessions(email);
      log(req, 'password_reset', email);
      fails.delete(email);
      startSession(res, req, email);
      res.json({ ok: true, user: publicUser(u) });
    },
    async resend(req, res) {
      const email = normEmail(req.body.email);
      const purpose = req.body.purpose === 'reset' ? 'reset' : 'verify';
      const u = db.users[email];
      limitIp(req);
      if (u && !u.disabled && (purpose === 'reset' || !u.verified)) await sendCode(email, purpose);
      res.json({ ok: true });
    },
    async logout(req, res) {
      const token = readCookie(req, COOKIE);
      const s = token && db.sessions[sha(token)];
      if (s) { log(req, 'logout', s.email); delete db.sessions[sha(token)]; save(); }
      res.clearCookie(COOKIE, { path: '/' });
      res.json({ ok: true });
    },
    async me(req, res) {
      const u = userOf(req);
      if (!u) throw new HttpError(401, 'Not signed in');
      res.json({ user: publicUser(u) });
    },
  };

  // ---------- admin panel ----------
  function adminOf(req) {
    const token = readCookie(req, ADMIN_COOKIE);
    if (!token) return null;
    const s = db.adminSessions[sha(token)];
    if (!s || s.exp < now()) return null;
    const u = db.users[s.email];
    return u && u.verified && !u.disabled && isAdmin(u) ? u : null;
  }
  const siteUrl = req => `${req.protocol}://${req.get('host')}`;
  const userRow = u => {
    const sess = Object.values(db.sessions).filter(s => s.email === u.email && s.exp > now());
    return {
      name: u.name, email: u.email, verified: !!u.verified, disabled: !!u.disabled, invited: !!u.invited,
      admin: isAdmin(u), envAdmin: ENV_ADMINS.includes(u.email),
      created: u.created || null, lastLogin: u.lastLogin || null, lastSeen: u.lastSeen || null,
      sessions: sess.length,
      devices: sess.sort((a, b) => (b.lastSeen || 0) - (a.lastSeen || 0)).slice(0, 5).map(s => ({ ip: s.ip || '', ua: s.ua || '', lastSeen: s.lastSeen ? new Date(s.lastSeen).toISOString() : s.created })),
      failed: (fails.get(u.email) || {}).n || 0,
    };
  };
  const needUser = email => {
    const u = db.users[normEmail(email)];
    if (!u) throw new HttpError(404, 'No account found for this email.');
    return u;
  };
  const notSelf = (admin, u, what) => { if (admin.email === u.email) throw new HttpError(400, `You cannot ${what} your own account.`); };

  const adminHandlers = {
    async login(req, res) {
      const email = normEmail(req.body.email);
      const wait = lockedFor(email);
      if (wait) throw new HttpError(429, `Too many failed attempts. Try again in ${wait} minute${wait === 1 ? '' : 's'}.`);
      const u = db.users[email];
      // An ADMIN_EMAILS address with no account yet: say so, instead of a confusing "wrong password".
      if (!u && ENV_ADMINS.includes(email)) throw new HttpError(404, 'This admin email has no account yet. Create it first on the dashboard sign-in page (Create account), confirm the emailed code, then come back here with the same password.', { setup: true });
      if (u && !u.verified && ENV_ADMINS.includes(email)) throw new HttpError(403, 'Please confirm this account first: sign in on the dashboard sign-in page and enter the emailed code, then come back here.', { setup: true });
      if (!u || !passwordMatches(u, req.body.password)) { failed(email); log(req, 'admin_login_failed', email); save(); throw new HttpError(401, 'Email or password is not right. Use the password of your dashboard account, or reset it with "Forgot password?" on the dashboard sign-in page.'); }
      fails.delete(email);
      if (u.disabled) throw new HttpError(403, DISABLED);
      if (!u.verified) throw new HttpError(403, 'Please confirm your email first by signing in to the dashboard.');
      if (!isAdmin(u)) { log(req, 'admin_login_denied', email); save(); throw new HttpError(403, 'This account does not have admin access.'); }
      const token = crypto.randomBytes(32).toString('base64url');
      db.adminSessions[sha(token)] = { email, exp: now() + ADMIN_HOURS * 3600e3, created: new Date().toISOString() };
      log(req, 'admin_login', email);
      save();
      res.cookie(ADMIN_COOKIE, token, { httpOnly: true, sameSite: 'strict', secure: req.secure, maxAge: ADMIN_HOURS * 3600e3, path: '/' });
      res.json({ ok: true, user: publicUser(u) });
    },
    async logout(req, res) {
      const token = readCookie(req, ADMIN_COOKIE);
      if (token) { delete db.adminSessions[sha(token)]; save(); }
      res.clearCookie(ADMIN_COOKIE, { path: '/' });
      res.json({ ok: true });
    },
    async overview(req, res) {
      const users = Object.values(db.users).map(userRow).sort((a, b) => String(b.lastSeen || b.lastLogin || b.created).localeCompare(String(a.lastSeen || a.lastLogin || a.created)));
      const week = now() - 7 * 86400e3, day = now() - 86400e3;
      const at = iso => (iso ? Date.parse(iso) : 0);
      const events = db.events.slice(-500).reverse();
      res.json({
        me: publicUser(req.admin),
        stats: {
          total: users.length,
          active7: users.filter(u => Math.max(at(u.lastSeen), at(u.lastLogin)) > week).length,
          online: users.filter(u => at(u.lastSeen) > now() - 15 * 60e3).length,
          pending: users.filter(u => !u.verified && !u.disabled).length,
          disabled: users.filter(u => u.disabled).length,
          admins: users.filter(u => u.admin).length,
          logins24: db.events.filter(e => e.type === 'login' && at(e.t) > day).length,
          failed24: db.events.filter(e => /failed/.test(e.type) && at(e.t) > day).length,
        },
        users, events,
        settings: {
          domains: DOMAINS, mail: !!MAIL_URL, sessionDays: SESSION_DAYS, adminHours: ADMIN_HOURS,
          envAdmins: ENV_ADMINS, codeMinutes: CODE_MINUTES,
        },
      });
    },
    async invite(req, res) {
      const name = String(req.body.name || '').trim().slice(0, 80);
      const email = normEmail(req.body.email);
      if (name.length < 2) throw new HttpError(400, 'Please enter their full name.');
      if (!emailOk(email)) throw new HttpError(400, `Only @${DOMAINS.join(' or @')} addresses can have an account.`);
      const existing = db.users[email];
      if (existing && existing.verified) throw new HttpError(409, 'This person already has an account.');
      db.users[email] = { ...(existing || {}), name, email, ...hashPassword(crypto.randomBytes(24).toString('hex')), verified: false, invited: true, disabled: false,
        created: (existing && existing.created) || new Date().toISOString(), role: req.body.admin ? 'admin' : (existing && existing.role) || undefined };
      delete db.codes[email + ':reset'];
      log(req, 'admin_invite', email, { by: req.admin.email });
      save();
      await sendCode(email, 'reset', { invite: true, minutes: 72 * 60, link: `${siteUrl(req)}/login?email=${encodeURIComponent(email)}#reset` });
      res.json({ ok: true, user: userRow(db.users[email]) });
    },
    async action(req, res) {
      const u = needUser(req.body.email), me = req.admin, act = String(req.body.action || '');
      switch (act) {
        case 'disable': notSelf(me, u, 'disable'); u.disabled = true; endSessions(u.email); break;
        case 'enable': u.disabled = false; fails.delete(u.email); break;
        case 'signout': endSessions(u.email); break;
        case 'verify': u.verified = true; break;
        case 'unlock': fails.delete(u.email); break;
        case 'make_admin': u.role = 'admin'; break;
        case 'remove_admin':
          notSelf(me, u, 'remove admin rights from');
          if (ENV_ADMINS.includes(u.email)) throw new HttpError(400, 'This person is an admin through the ADMIN_EMAILS setting on Railway. Remove them there.');
          delete u.role; break;
        case 'reset':
          if (u.disabled) throw new HttpError(400, 'Enable the account first.');
          delete db.codes[u.email + ':reset'];
          await sendCode(u.email, 'reset', { link: `${siteUrl(req)}/login?email=${encodeURIComponent(u.email)}#reset`, minutes: 24 * 60 });
          break;
        case 'delete':
          notSelf(me, u, 'delete');
          endSessions(u.email);
          for (const k of Object.keys(db.codes)) if (k.startsWith(u.email + ':')) delete db.codes[k];
          delete db.users[u.email];
          break;
        default: throw new HttpError(400, 'Unknown action.');
      }
      log(req, 'admin_' + act, u.email, { by: me.email });
      save();
      res.json({ ok: true, user: db.users[u.email] ? userRow(db.users[u.email]) : null });
    },
  };

  function adminRouter(express) {
    const r = express.Router();
    const wrap = fn => (req, res) => {
      req.body = req.body || {};
      Promise.resolve(fn(req, res)).catch(e => {
        if (!(e instanceof HttpError)) console.error('[admin]', e);
        res.status(e.status || 500).json({ error: e instanceof HttpError ? e.message : 'Something went wrong. Please try again.', ...((e instanceof HttpError && e.extra) || {}) });
      });
    };
    r.post('/login', wrap(adminHandlers.login));
    r.post('/logout', wrap(adminHandlers.logout));
    r.use((req, res, next) => {
      const a = adminOf(req);
      if (!a) return res.status(401).json({ error: 'Please sign in as an admin', adminSignIn: true });
      req.admin = a;
      next();
    });
    r.get('/overview', wrap(adminHandlers.overview));
    r.post('/invite', wrap(adminHandlers.invite));
    r.post('/action', wrap(adminHandlers.action));
    return r;
  }
  const requireAdminPage = (req, res, next) => (adminOf(req) ? next() : res.redirect('/admin/login'));

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

  return { router, adminRouter, requireApi, requirePage, requireAdminPage, userOf, adminOf, mailConfigured: !!MAIL_URL, domains: DOMAINS, envAdmins: ENV_ADMINS };
}

module.exports = { createAuth };
