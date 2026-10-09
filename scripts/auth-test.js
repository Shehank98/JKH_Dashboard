'use strict';
// End-to-end checks for sign-up, email codes, sign-in, sign-out and password reset. Run: npm run test:auth
// Starts the real server on a spare port with an empty data folder and a fake Apps Script mailer
// that behaves like Google's (POST answered with a 302 to a GET that returns the JSON result).
const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const http = require('http');
const { spawn } = require('child_process');

const PORT = 3200 + Math.floor(Math.random() * 500);
const MAIL_PORT = PORT + 600;
const BASE = `http://127.0.0.1:${PORT}`;
const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ooc-auth-'));
const inbox = [];

const mailer = http.createServer((req, res) => {
  if (req.method === 'POST' && req.url === '/exec') {
    let body = '';
    req.on('data', c => { body += c; });
    req.on('end', () => {
      const m = JSON.parse(body);
      const ok = m.secret === 'test-secret';
      if (ok) inbox.push(m);
      res.writeHead(302, { Location: `/echo?ok=${ok}` });
      res.end();
    });
  } else if (req.method === 'GET' && req.url.startsWith('/echo')) {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify(req.url.includes('ok=true') ? { ok: true } : { ok: false, error: 'unauthorised' }));
  } else { res.writeHead(404); res.end(); }
});

let cookie = '';
async function call(method, url, body, opts = {}) {
  const r = await fetch(BASE + url, {
    method, redirect: 'manual',
    headers: { 'Content-Type': 'application/json', ...(opts.noCookie || !cookie ? {} : { Cookie: cookie }) },
    body: body ? JSON.stringify(body) : undefined,
  });
  const set = r.headers.get('set-cookie');
  if (set && !opts.noCookie) cookie = set.split(';')[0].includes('=;') || /Expires=Thu, 01 Jan 1970/.test(set) ? '' : set.split(';')[0];
  const text = await r.text();
  let json = null;
  try { json = JSON.parse(text); } catch (e) { /* not JSON */ }
  return { status: r.status, json, text, headers: r.headers };
}
// Separate cookie jars for a second browser (another user, or the admin panel).
async function callJar(jar, method, url, body) {
  const r = await fetch(BASE + url, {
    method, redirect: 'manual',
    headers: { 'Content-Type': 'application/json', ...(jar.c ? { Cookie: jar.c } : {}) },
    body: body ? JSON.stringify(body) : undefined,
  });
  for (const set of r.headers.getSetCookie()) {
    const [pair] = set.split(';');
    const [k, v] = pair.split('=');
    const rest = jar.c.split('; ').filter(x => x && !x.startsWith(k + '='));
    if (v && !/Expires=Thu, 01 Jan 1970/.test(set)) rest.push(pair);
    jar.c = rest.join('; ');
  }
  const text = await r.text();
  let json = null;
  try { json = JSON.parse(text); } catch (e) { /* not JSON */ }
  return { status: r.status, json, text, headers: r.headers };
}
const lastCode = to => { const m = [...inbox].reverse().find(x => x.to === to); return m && /(\d{6}) is your/.exec(m.subject)[1]; };
const wrong = c => String((Number(c) + 1) % 1e6).padStart(6, '0');

(async () => {
  await new Promise(ok => mailer.listen(MAIL_PORT, ok));
  const server = spawn(process.execPath, [path.join(__dirname, '..', 'server.js')], {
    env: { ...process.env, PORT: String(PORT), DATA_DIR: dataDir, AUTH_DISABLED: '', APPS_SCRIPT_URL: `http://127.0.0.1:${MAIL_PORT}/exec`, APPS_SCRIPT_SECRET: 'test-secret', CODE_RESEND_SECONDS: '2', ADMIN_EMAILS: 'jane.perera@ogilvy.com' },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let log = '';
  server.stdout.on('data', d => { log += d; });
  server.stderr.on('data', d => { log += d; });
  try {
    for (let i = 0; i < 50 && !log.includes('running on'); i++) await new Promise(r => setTimeout(r, 100));
    let r;
    const email = 'jane.perera@ogilvy.com';

    // Locked down until signed in.
    r = await call('GET', '/');
    assert.strictEqual(r.status, 302); assert.strictEqual(r.headers.get('location'), '/login');
    r = await call('GET', '/login'); assert.strictEqual(r.status, 200); assert.ok(r.text.includes('Sign in to the <em>Live Dashboard.</em>'));
    r = await call('GET', '/api/status'); assert.strictEqual(r.status, 401); assert.strictEqual(r.json.signIn, true);
    r = await call('POST', '/api/planning', {}); assert.strictEqual(r.status, 401);
    r = await call('GET', '/api/auth/me'); assert.strictEqual(r.status, 401);
    r = await call('GET', '/healthz'); assert.strictEqual(r.status, 200, 'health check is public');
    r = await call('GET', '/ogilvy-orbit-chub-stacked.png'); assert.strictEqual(r.status, 200, 'login page assets are public');

    // Sign-up rules.
    r = await call('POST', '/api/auth/signup', { name: 'Jane Perera', email: 'jane@gmail.com', password: 'abc123' });
    assert.strictEqual(r.status, 400); assert.match(r.json.error, /Ogilvy email/);
    r = await call('POST', '/api/auth/signup', { name: 'Jane Perera', email, password: 'abcdef' });
    assert.strictEqual(r.status, 400); assert.match(r.json.error, /letter and one number/);
    r = await call('POST', '/api/auth/signup', { name: 'Jane Perera', email, password: 'ab1' });
    assert.strictEqual(r.status, 400); assert.match(r.json.error, /at least 6/);
    r = await call('POST', '/api/auth/signup', { name: 'Jane Perera', email, password: 'abc123', confirm: 'abc124' });
    assert.strictEqual(r.status, 400); assert.match(r.json.error, /do not match/);
    assert.strictEqual(inbox.length, 0);

    // Sign up, code by email, confirm.
    r = await call('POST', '/api/auth/signup', { name: 'Jane Perera', email: ' Jane.Perera@Ogilvy.com ', password: 'abc123', confirm: 'abc123' });
    assert.strictEqual(r.status, 200); assert.strictEqual(r.json.next, 'verify');
    assert.strictEqual(inbox.length, 1); assert.strictEqual(inbox[0].to, email);
    const code1 = lastCode(email);
    assert.match(code1, /^\d{6}$/); assert.ok(inbox[0].html.includes(code1) && inbox[0].text.includes(code1));
    r = await call('POST', '/api/auth/login', { email, password: 'abc123' });
    assert.strictEqual(r.json.next, 'verify', 'unverified account is asked for the code'); assert.strictEqual(cookie, '');
    r = await call('POST', '/api/auth/resend', { email, purpose: 'verify' });
    assert.strictEqual(r.status, 429, 'resend is throttled');
    r = await call('POST', '/api/auth/verify', { email, code: wrong(code1) });
    assert.strictEqual(r.status, 400); assert.match(r.json.error, /4 attempts left/);
    r = await call('POST', '/api/auth/verify', { email, code: code1 });
    assert.strictEqual(r.status, 200); assert.strictEqual(r.json.user.name, 'Jane Perera');
    assert.ok(cookie.startsWith('ooc_session='));
    const setCookie = r.headers.get('set-cookie');
    assert.match(setCookie, /HttpOnly/i); assert.match(setCookie, /SameSite=Lax/i);
    r = await call('POST', '/api/auth/verify', { email, code: code1 });
    assert.strictEqual(r.status, 400, 'a code works once');

    // Signed in: dashboard and API open, login page bounces to the dashboard.
    r = await call('GET', '/'); assert.strictEqual(r.status, 200); assert.ok(r.text.includes('JKH Group Dashboard'));
    r = await call('GET', '/login'); assert.strictEqual(r.status, 302);
    r = await call('GET', '/api/status'); assert.strictEqual(r.status, 200);
    r = await call('GET', '/api/auth/me'); assert.strictEqual(r.json.user.email, email);
    r = await call('POST', '/api/planning', {}); assert.strictEqual(r.status, 404, 'no dataset yet, but past the sign-in check');

    // Sign out.
    const oldCookie = cookie;
    r = await call('POST', '/api/auth/logout');
    assert.strictEqual(r.status, 200); assert.strictEqual(cookie, '');
    cookie = oldCookie;
    r = await call('GET', '/api/status'); assert.strictEqual(r.status, 401, 'signed-out session is dead');
    cookie = '';

    // Sign in.
    r = await call('POST', '/api/auth/login', { email, password: 'wrong123' });
    assert.strictEqual(r.status, 401);
    r = await call('POST', '/api/auth/login', { email: 'JANE.PERERA@ogilvy.com', password: 'abc123' });
    assert.strictEqual(r.status, 200); assert.ok(cookie);
    const sessionBeforeReset = cookie;
    r = await call('POST', '/api/auth/signup', { name: 'Jane', email, password: 'abc123' }, { noCookie: true });
    assert.strictEqual(r.status, 409);

    // Forgot password: same answer for unknown emails, no email sent.
    const before = inbox.length;
    r = await call('POST', '/api/auth/forgot', { email: 'nobody.here@ogilvy.com' }, { noCookie: true });
    assert.strictEqual(r.status, 200); assert.strictEqual(inbox.length, before);
    r = await call('POST', '/api/auth/forgot', { email }, { noCookie: true });
    assert.strictEqual(r.status, 200); assert.strictEqual(inbox.length, before + 1);
    const code2 = lastCode(email);
    assert.match(inbox[inbox.length - 1].text, /reset your password/);
    r = await call('POST', '/api/auth/reset', { email, code: code2, password: 'short' }, { noCookie: true });
    assert.strictEqual(r.status, 400);
    for (let i = 0; i < 5; i++) await call('POST', '/api/auth/reset', { email, code: wrong(code2), password: 'newpass9' }, { noCookie: true });
    r = await call('POST', '/api/auth/reset', { email, code: code2, password: 'newpass9' }, { noCookie: true });
    assert.strictEqual(r.status, 400); assert.match(r.json.error, /Too many wrong attempts/);
    await new Promise(res => setTimeout(res, 2100)); // past the resend wait
    r = await call('POST', '/api/auth/resend', { email, purpose: 'reset' }, { noCookie: true });
    assert.strictEqual(r.status, 200);
    const code3 = lastCode(email);
    cookie = '';
    r = await call('POST', '/api/auth/reset', { email, code: code3, password: 'newpass9', confirm: 'newpass9' });
    assert.strictEqual(r.status, 200); assert.ok(cookie);
    const fresh = cookie;
    cookie = sessionBeforeReset;
    r = await call('GET', '/api/status'); assert.strictEqual(r.status, 401, 'reset signs out other sessions');
    cookie = '';
    r = await call('POST', '/api/auth/login', { email, password: 'abc123' }); assert.strictEqual(r.status, 401, 'old password no longer works');
    r = await call('POST', '/api/auth/login', { email, password: 'newpass9' }); assert.strictEqual(r.status, 200);
    cookie = fresh;
    r = await call('GET', '/api/status'); assert.strictEqual(r.status, 200);

    // ---- Admin panel ----
    const adm = { c: '' }, bob = { c: '' }, carol = { c: '' };
    const bobEmail = 'bob.silva@ogilvy.com';
    r = await callJar(adm, 'GET', '/admin'); assert.strictEqual(r.status, 302); assert.strictEqual(r.headers.get('location'), '/admin/login');
    r = await callJar(adm, 'GET', '/admin/login'); assert.strictEqual(r.status, 200); assert.ok(r.text.includes('Admin panel'));
    r = await callJar(adm, 'GET', '/api/admin/overview'); assert.strictEqual(r.status, 401); assert.strictEqual(r.json.adminSignIn, true);
    r = await call('GET', '/api/admin/overview'); assert.strictEqual(r.status, 401, 'a dashboard session does not open the admin API');
    r = await call('GET', '/api/auth/me'); assert.strictEqual(r.json.user.admin, true, 'ADMIN_EMAILS user is an admin');

    r = await callJar(bob, 'POST', '/api/auth/signup', { name: 'Bob Silva', email: bobEmail, password: 'bobpass1', confirm: 'bobpass1' });
    assert.strictEqual(r.status, 200);
    r = await callJar(bob, 'POST', '/api/auth/verify', { email: bobEmail, code: lastCode(bobEmail) }); assert.strictEqual(r.status, 200);
    assert.strictEqual(r.json.user.admin, false);
    r = await callJar(bob, 'POST', '/api/admin/login', { email: bobEmail, password: 'bobpass1' });
    assert.strictEqual(r.status, 403); assert.match(r.json.error, /does not have admin access/);
    r = await callJar(adm, 'POST', '/api/admin/login', { email, password: 'wrong999' }); assert.strictEqual(r.status, 401);
    r = await callJar(adm, 'POST', '/api/admin/login', { email, password: 'newpass9' });
    assert.strictEqual(r.status, 200); assert.ok(adm.c.includes('ooc_admin=')); assert.match(r.headers.get('set-cookie'), /SameSite=Strict/i);
    r = await callJar(adm, 'GET', '/admin'); assert.strictEqual(r.status, 200); assert.ok(r.text.includes('Invite user'));
    r = await callJar(adm, 'GET', '/admin/login'); assert.strictEqual(r.status, 302, 'signed-in admin skips the admin sign-in page');
    r = await callJar(adm, 'GET', '/api/status'); assert.strictEqual(r.status, 401, 'an admin session alone does not open the dashboard');

    r = await callJar(adm, 'GET', '/api/admin/overview');
    assert.strictEqual(r.status, 200); assert.strictEqual(r.json.stats.total, 2); assert.strictEqual(r.json.stats.admins, 1);
    const bobRow = r.json.users.find(u => u.email === bobEmail);
    assert.ok(bobRow && bobRow.verified && !bobRow.admin && bobRow.sessions === 1 && bobRow.devices.length === 1);
    assert.ok(r.json.events.some(e => e.type === 'login_failed' && e.email === email));
    assert.ok(r.json.events.some(e => e.type === 'admin_login_denied' && e.email === bobEmail));
    assert.ok(!JSON.stringify(r.json).includes('"hash"') && !JSON.stringify(r.json).includes('"salt"'), 'no password hashes in the admin API');

    // Promote and demote.
    r = await callJar(adm, 'POST', '/api/admin/action', { action: 'make_admin', email: bobEmail }); assert.strictEqual(r.status, 200); assert.strictEqual(r.json.user.admin, true);
    const bobAdm = { c: '' };
    r = await callJar(bobAdm, 'POST', '/api/admin/login', { email: bobEmail, password: 'bobpass1' }); assert.strictEqual(r.status, 200);
    r = await callJar(bobAdm, 'POST', '/api/admin/action', { action: 'remove_admin', email });
    assert.strictEqual(r.status, 400); assert.match(r.json.error, /ADMIN_EMAILS/, 'env admins cannot be demoted');
    r = await callJar(adm, 'POST', '/api/admin/action', { action: 'remove_admin', email: bobEmail }); assert.strictEqual(r.status, 200);
    r = await callJar(bobAdm, 'GET', '/api/admin/overview'); assert.strictEqual(r.status, 401, 'demoted admin loses the panel at once');
    for (const act of ['disable', 'delete', 'remove_admin']) {
      r = await callJar(adm, 'POST', '/api/admin/action', { action: act, email }); assert.strictEqual(r.status, 400, act + ' self is refused');
    }

    // Disable and enable.
    r = await callJar(adm, 'POST', '/api/admin/action', { action: 'disable', email: bobEmail }); assert.strictEqual(r.status, 200);
    r = await callJar(bob, 'GET', '/api/status'); assert.strictEqual(r.status, 401, 'disabled user is signed out');
    r = await callJar(bob, 'POST', '/api/auth/login', { email: bobEmail, password: 'bobpass1' });
    assert.strictEqual(r.status, 403); assert.match(r.json.error, /disabled/);
    let n = inbox.length;
    r = await callJar(bob, 'POST', '/api/auth/forgot', { email: bobEmail }); assert.strictEqual(r.status, 200); assert.strictEqual(inbox.length, n, 'no reset email for a disabled account');
    r = await callJar(adm, 'POST', '/api/admin/action', { action: 'enable', email: bobEmail }); assert.strictEqual(r.status, 200);
    r = await callJar(bob, 'POST', '/api/auth/login', { email: bobEmail, password: 'bobpass1' }); assert.strictEqual(r.status, 200);

    // Sign out everywhere.
    r = await callJar(adm, 'POST', '/api/admin/action', { action: 'signout', email: bobEmail }); assert.strictEqual(r.status, 200); assert.strictEqual(r.json.user.sessions, 0);
    r = await callJar(bob, 'GET', '/api/status'); assert.strictEqual(r.status, 401);

    // Admin-sent reset code, with a link straight to the reset screen.
    r = await callJar(adm, 'POST', '/api/admin/action', { action: 'reset', email: bobEmail }); assert.strictEqual(r.status, 200);
    let m = inbox[inbox.length - 1];
    assert.strictEqual(m.to, bobEmail); assert.ok(m.html.includes(`/login?email=${encodeURIComponent(bobEmail)}#reset`)); assert.match(m.text, /24 hours/);

    // Invite: they set their own password with the emailed code.
    const carolEmail = 'carol.fernando@ogilvy.com';
    r = await callJar(adm, 'POST', '/api/admin/invite', { name: 'Carol Fernando', email: 'carol@gmail.com' }); assert.strictEqual(r.status, 400);
    r = await callJar(adm, 'POST', '/api/admin/invite', { name: 'Carol Fernando', email: carolEmail });
    assert.strictEqual(r.status, 200); assert.ok(r.json.user.invited && !r.json.user.verified);
    m = inbox[inbox.length - 1];
    assert.strictEqual(m.to, carolEmail); assert.match(m.subject, /invited/); assert.match(m.text, /3 days/);
    const carolCode = /code (\d{6})/.exec(m.subject)[1];
    r = await callJar(adm, 'POST', '/api/admin/invite', { name: 'Jane', email }); assert.strictEqual(r.status, 409);
    r = await callJar(carol, 'POST', '/api/auth/reset', { email: carolEmail, code: carolCode, password: 'carol123', confirm: 'carol123' });
    assert.strictEqual(r.status, 200);
    r = await callJar(carol, 'GET', '/api/status'); assert.strictEqual(r.status, 200);
    r = await callJar(adm, 'GET', '/api/admin/overview');
    const carolRow = r.json.users.find(u => u.email === carolEmail);
    assert.ok(carolRow.verified && !carolRow.invited);
    assert.ok(r.json.events.some(e => e.type === 'admin_invite' && e.by === email));

    // Delete.
    r = await callJar(adm, 'POST', '/api/admin/action', { action: 'delete', email: bobEmail }); assert.strictEqual(r.status, 200); assert.strictEqual(r.json.user, null);
    r = await callJar(bob, 'POST', '/api/auth/login', { email: bobEmail, password: 'bobpass1' }); assert.strictEqual(r.status, 401);
    r = await callJar(adm, 'POST', '/api/admin/action', { action: 'delete', email: bobEmail }); assert.strictEqual(r.status, 404);

    // Admin sign-out.
    r = await callJar(adm, 'POST', '/api/admin/logout'); assert.strictEqual(r.status, 200);
    r = await callJar(adm, 'GET', '/api/admin/overview'); assert.strictEqual(r.status, 401);

    // Per-IP cap on code emails (test server allows 15 an hour; some used above).
    for (let i = 0; i < 10; i++) await call('POST', '/api/auth/forgot', { email: `x${i}.y@ogilvy.com` }, { noCookie: true });
    r = await call('POST', '/api/auth/forgot', { email: 'z.y@ogilvy.com' }, { noCookie: true });
    assert.strictEqual(r.status, 429); assert.match(r.json.error, /Too many code requests/);

    // Stored data: no plain passwords, codes or tokens.
    const saved = fs.readFileSync(path.join(dataDir, 'auth.json'), 'utf8');
    assert.ok(!saved.includes('newpass9') && !saved.includes(code3) && !saved.includes(fresh.split('=')[1]));

    console.log('All auth checks passed');
  } catch (e) {
    console.error(e);
    console.error('--- server log ---\n' + log);
    process.exitCode = 1;
  } finally {
    server.kill();
    mailer.close();
    fs.rmSync(dataDir, { recursive: true, force: true });
  }
})();
