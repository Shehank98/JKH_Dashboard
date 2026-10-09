'use strict';
// Proves sign-in data survives a redeploy when DATABASE_URL points at Postgres. Run:
//   TEST_DATABASE_URL=postgres://user@host:port/db npm run test:db
// Uses a throwaway database created next to the one given, so real data is never touched.
// Each "deploy" is a fresh server process with a new, empty DATA_DIR, like a new Railway container.
const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const http = require('http');
const { spawn } = require('child_process');
const { Client } = require('pg');

const BASE_URL = process.env.TEST_DATABASE_URL;
if (!BASE_URL) { console.log('Skipped: set TEST_DATABASE_URL to a Postgres server to run this test.'); process.exit(0); }
const dbName = `ooc_test_${process.pid}`;
const url = new URL(BASE_URL); url.pathname = '/' + dbName;
const DB = url.toString();
const PORT = 3800 + Math.floor(Math.random() * 300);
const MAIL_PORT = PORT + 400;
const BASE = `http://127.0.0.1:${PORT}`;
const inbox = [];
const dirs = [];

const mailer = http.createServer((req, res) => {
  let body = '';
  req.on('data', c => { body += c; });
  req.on('end', () => { inbox.push(JSON.parse(body)); res.writeHead(200, { 'Content-Type': 'application/json' }); res.end('{"ok":true}'); });
});

async function call(jar, method, p, body) {
  const r = await fetch(BASE + p, { method, redirect: 'manual', headers: { 'Content-Type': 'application/json', ...(jar.c ? { Cookie: jar.c } : {}) }, body: body ? JSON.stringify(body) : undefined });
  for (const set of r.headers.getSetCookie()) {
    const [pair] = set.split(';'); const [k, v] = pair.split('=');
    const rest = jar.c.split('; ').filter(x => x && !x.startsWith(k + '='));
    if (v && !/Expires=Thu, 01 Jan 1970/.test(set)) rest.push(pair);
    jar.c = rest.join('; ');
  }
  const text = await r.text(); let json = null; try { json = JSON.parse(text); } catch (e) { /* not JSON */ }
  return { status: r.status, json };
}
const codeFor = to => /(\d{6})/.exec([...inbox].reverse().find(m => m.to === to).subject)[1];

let server = null, log = '';
async function deploy(extraEnv = {}) {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ooc-db-'));
  dirs.push(dataDir);
  if (extraEnv.seedFile) { fs.writeFileSync(path.join(dataDir, 'auth.json'), extraEnv.seedFile); delete extraEnv.seedFile; }
  log = '';
  server = spawn(process.execPath, [path.join(__dirname, '..', 'server.js')], {
    env: { ...process.env, PORT: String(PORT), DATA_DIR: dataDir, DATABASE_URL: DB, AUTH_DISABLED: '', ADMIN_EMAILS: 'ann.admin@ogilvy.com',
      APPS_SCRIPT_URL: `http://127.0.0.1:${MAIL_PORT}/exec`, APPS_SCRIPT_SECRET: 's', CODE_RESEND_SECONDS: '1', ...extraEnv },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  server.stdout.on('data', d => { log += d; });
  server.stderr.on('data', d => { log += d; });
  for (let i = 0; i < 100 && !log.includes('running on'); i++) await new Promise(r => setTimeout(r, 100));
  assert.ok(log.includes('running on'), 'server started:\n' + log);
  return dataDir;
}
async function stop() {
  const done = new Promise(r => server.once('exit', r));
  server.kill('SIGTERM');
  await done;
}

(async () => {
  const admin = new Client({ connectionString: BASE_URL });
  admin.on('error', () => {}); // dropping the test database at the end can end this connection
  await admin.connect();
  await admin.query(`CREATE DATABASE ${dbName}`);
  await new Promise(ok => mailer.listen(MAIL_PORT, ok));
  try {
    // ---- deploy 1: create accounts ----
    await deploy();
    assert.match(log, /stored in Postgres/);
    let r = await call({ c: '' }, 'GET', '/healthz'); assert.strictEqual(r.json.accounts, 'postgres');
    const ann = { c: '' }, ben = { c: '' }, adm = { c: '' };
    r = await call(ann, 'POST', '/api/auth/signup', { name: 'Ann Admin', email: 'ann.admin@ogilvy.com', password: 'annpass1', confirm: 'annpass1' }); assert.strictEqual(r.status, 200);
    r = await call(ann, 'POST', '/api/auth/verify', { email: 'ann.admin@ogilvy.com', code: codeFor('ann.admin@ogilvy.com') }); assert.strictEqual(r.status, 200);
    r = await call(ben, 'POST', '/api/auth/signup', { name: 'Ben User', email: 'ben.user@ogilvy.com', password: 'benpass1', confirm: 'benpass1' }); assert.strictEqual(r.status, 200);
    r = await call(ben, 'POST', '/api/auth/verify', { email: 'ben.user@ogilvy.com', code: codeFor('ben.user@ogilvy.com') }); assert.strictEqual(r.status, 200);
    r = await call(adm, 'POST', '/api/admin/login', { email: 'ann.admin@ogilvy.com', password: 'annpass1' }); assert.strictEqual(r.status, 200);
    r = await call(adm, 'POST', '/api/admin/invite', { name: 'Cara Invited', email: 'cara.invited@ogilvy.com' }); assert.strictEqual(r.status, 200);
    r = await call(adm, 'POST', '/api/admin/action', { action: 'make_admin', email: 'ben.user@ogilvy.com' }); assert.strictEqual(r.status, 200);
    r = await call(adm, 'GET', '/api/admin/overview'); assert.strictEqual(r.json.settings.storage, 'postgres');
    await stop(); // SIGTERM flushes pending writes

    // What is in the database (readable columns, no plain passwords or codes).
    const rows = (await new Client({ connectionString: DB }).connect().then(async c => { const q = await c.query('SELECT email, name, role, verified, invited, password_hash FROM ooc_users ORDER BY email'); await c.end(); return q.rows; }));
    assert.deepStrictEqual(rows.map(x => [x.email, x.name, x.role, x.verified, x.invited]), [
      ['ann.admin@ogilvy.com', 'Ann Admin', null, true, false],
      ['ben.user@ogilvy.com', 'Ben User', 'admin', true, false],
      ['cara.invited@ogilvy.com', 'Cara Invited', null, false, true],
    ]);
    assert.ok(rows.every(x => /^[0-9a-f]{128}$/.test(x.password_hash) && !x.password_hash.includes('annpass1')));

    // ---- deploy 2: brand-new container, empty disk ----
    const dir2 = await deploy();
    assert.ok(!fs.existsSync(path.join(dir2, 'auth.json')), 'nothing is written to disk when Postgres is used');
    r = await call(ann, 'GET', '/api/status'); assert.strictEqual(r.status, 200, 'dashboard session survives the redeploy');
    r = await call(adm, 'GET', '/api/admin/overview'); assert.strictEqual(r.status, 200, 'admin session survives the redeploy');
    assert.strictEqual(r.json.stats.total, 3);
    assert.ok(r.json.users.find(u => u.email === 'ben.user@ogilvy.com').admin, 'promoted admin is remembered');
    assert.ok(r.json.events.some(e => e.type === 'admin_invite' && e.by === 'ann.admin@ogilvy.com'), 'activity log is remembered');
    r = await call({ c: '' }, 'POST', '/api/auth/login', { email: 'ben.user@ogilvy.com', password: 'benpass1' }); assert.strictEqual(r.status, 200, 'password still works');
    // Invite code from deploy 1 still works after the redeploy.
    const inv = [...inbox].reverse().find(m => m.to === 'cara.invited@ogilvy.com');
    const cara = { c: '' };
    r = await call(cara, 'POST', '/api/auth/reset', { email: 'cara.invited@ogilvy.com', code: /code (\d{6})/.exec(inv.subject)[1], password: 'carapass1', confirm: 'carapass1' });
    assert.strictEqual(r.status, 200);
    // Changes in deploy 2: disable Ben, sign Ann out.
    r = await call(adm, 'POST', '/api/admin/action', { action: 'disable', email: 'ben.user@ogilvy.com' }); assert.strictEqual(r.status, 200);
    r = await call(ann, 'POST', '/api/auth/logout'); assert.strictEqual(r.status, 200);
    await stop();

    // ---- deploy 3: the deploy-2 changes are there too ----
    await deploy();
    r = await call({ c: '' }, 'POST', '/api/auth/login', { email: 'ben.user@ogilvy.com', password: 'benpass1' }); assert.strictEqual(r.status, 403, 'disabled stays disabled');
    r = await call(cara, 'GET', '/api/status'); assert.strictEqual(r.status, 200, 'invited user who set a password stays signed in');
    r = await call({ c: 'ooc_session=' + 'x'.repeat(43) }, 'GET', '/api/status'); assert.strictEqual(r.status, 401);
    r = await call(adm, 'POST', '/api/admin/action', { action: 'delete', email: 'cara.invited@ogilvy.com' }); assert.strictEqual(r.status, 200);
    await stop();
    await deploy();
    r = await call(cara, 'GET', '/api/status'); assert.strictEqual(r.status, 401, 'deleted account and its sessions are gone after redeploy');
    r = await call(adm, 'GET', '/api/admin/overview'); assert.strictEqual(r.json.stats.total, 2);
    await stop();

    // ---- an existing auth.json is moved into an empty database once ----
    const c2 = new Client({ connectionString: DB }); await c2.connect();
    await c2.query('TRUNCATE ooc_users, ooc_sessions, ooc_codes, ooc_events'); await c2.end();
    const salt = 'ab'.repeat(16);
    const oldUser = { name: 'Old User', email: 'old.user@ogilvy.com', salt, hash: require('crypto').scryptSync('oldpass1', salt, 64).toString('hex'), verified: true, created: '2026-01-01T00:00:00.000Z' };
    const seed = JSON.stringify({ users: { [oldUser.email]: oldUser }, sessions: {}, codes: {}, adminSessions: {}, events: [] });
    const dir5 = await deploy({ seedFile: seed });
    assert.match(log, /importing 1 account/);
    assert.ok(fs.existsSync(path.join(dir5, 'auth.json.imported')));
    r = await call({ c: '' }, 'POST', '/api/auth/login', { email: 'old.user@ogilvy.com', password: 'oldpass1' }); assert.strictEqual(r.status, 200, 'imported account can sign in');
    await stop();

    // ---- database down at start: the server refuses to run without accounts ----
    const badUrl = new URL(BASE_URL); badUrl.port = '1'; badUrl.pathname = '/nope';
    const bad = spawn(process.execPath, [path.join(__dirname, '..', 'server.js')], { env: { ...process.env, PORT: String(PORT), DATA_DIR: dirs[0], DATABASE_URL: badUrl.toString(), AUTH_DISABLED: '' }, stdio: ['ignore', 'pipe', 'pipe'] });
    let badLog = ''; bad.stderr.on('data', d => { badLog += d; });
    const code = await new Promise(r => bad.once('exit', r));
    assert.strictEqual(code, 1); assert.match(badLog, /Could not open the sign-in database/);

    console.log('All database checks passed');
  } catch (e) {
    console.error(e); console.error('--- server log ---\n' + log); process.exitCode = 1;
    if (server && server.exitCode === null) server.kill();
  } finally {
    mailer.close();
    await admin.query(`DROP DATABASE IF EXISTS ${dbName} WITH (FORCE)`).catch(() => {});
    await admin.end();
    for (const d of dirs) fs.rmSync(d, { recursive: true, force: true });
  }
})();
