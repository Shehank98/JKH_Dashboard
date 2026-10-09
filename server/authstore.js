'use strict';
// Where sign-in data lives: Postgres when DATABASE_URL is set (survives redeploys), otherwise DATA_DIR/auth.json.
// Auth keeps everything in memory (a few hundred accounts at most) and calls persist() after each change;
// the Postgres store writes only the rows that changed since the last successful write, in one transaction.

const fs = require('fs');
const path = require('path');

const empty = () => ({ users: {}, sessions: {}, codes: {}, adminSessions: {}, events: [] });
const KEEP_EVENTS_IN_DB = 20000;

// ---------- file (local development, or no database) ----------
function fileStore(dataDir) {
  const file = path.join(dataDir, 'auth.json');
  return {
    kind: 'file',
    label: `file ${file}`,
    async load() {
      try { return { ...empty(), ...JSON.parse(fs.readFileSync(file, 'utf8')) }; } catch (e) { return empty(); }
    },
    persist(db) {
      const tmp = file + '.tmp';
      fs.writeFileSync(tmp, JSON.stringify(db));
      fs.renameSync(tmp, file);
      return Promise.resolve();
    },
    async flush() {},
    async close() {},
  };
}

// ---------- Postgres ----------
const SCHEMA = `
CREATE TABLE IF NOT EXISTS ooc_users (
  email          text PRIMARY KEY,
  name           text NOT NULL,
  role           text,
  verified       boolean NOT NULL DEFAULT false,
  disabled       boolean NOT NULL DEFAULT false,
  invited        boolean NOT NULL DEFAULT false,
  password_salt  text NOT NULL,
  password_hash  text NOT NULL,
  created_at     timestamptz,
  last_login     timestamptz,
  last_seen      timestamptz,
  updated_at     timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE IF NOT EXISTS ooc_sessions (
  token_hash  text PRIMARY KEY,
  kind        text NOT NULL,            -- 'user' (dashboard) or 'admin' (admin panel)
  email       text NOT NULL,
  expires_at  timestamptz NOT NULL,
  data        jsonb NOT NULL
);
CREATE INDEX IF NOT EXISTS ooc_sessions_email ON ooc_sessions (email);
CREATE TABLE IF NOT EXISTS ooc_codes (
  key         text PRIMARY KEY,         -- email:purpose
  expires_at  timestamptz NOT NULL,
  data        jsonb NOT NULL            -- hashed code, tries, sent time (never the code itself)
);
CREATE TABLE IF NOT EXISTS ooc_events (
  id        bigserial PRIMARY KEY,
  at        timestamptz NOT NULL,
  type      text NOT NULL,
  email     text,
  ip        text,
  by_email  text
);
CREATE INDEX IF NOT EXISTS ooc_events_at ON ooc_events (at);
`;

const iso = v => (v ? new Date(v).toISOString() : null);
const toUser = r => {
  const u = { name: r.name, email: r.email, salt: r.password_salt, hash: r.password_hash, verified: r.verified };
  if (r.role) u.role = r.role;
  if (r.disabled) u.disabled = true;
  if (r.invited) u.invited = true;
  if (r.created_at) u.created = iso(r.created_at);
  if (r.last_login) u.lastLogin = iso(r.last_login);
  if (r.last_seen) u.lastSeen = iso(r.last_seen);
  return u;
};

function connectionConfig(url) {
  // Railway's private network (*.railway.internal) and localhost need no TLS; public proxies do.
  let host = '';
  try { host = new URL(url).hostname; } catch (e) { /* let pg report it */ }
  const local = /(^localhost$|^127\.|\.railway\.internal$|^::1$)/.test(host);
  const mode = (/[?&]sslmode=([^&]*)/.exec(url) || [])[1];
  const want = process.env.PGSSL === '1' ? true : process.env.PGSSL === '0' ? false : mode ? mode !== 'disable' : !local;
  // Drop sslmode from the URL so our ssl setting applies (pg would otherwise insist on a verified certificate).
  const clean = url.replace(/([?&])sslmode=[^&]*(&|$)/, (m, a, b) => (b ? a : '')).replace(/[?&]$/, '');
  return { connectionString: clean, ssl: want ? { rejectUnauthorized: false } : false, max: 4, idleTimeoutMillis: 30000, connectionTimeoutMillis: 10000 };
}

function pgStore(url, dataDir) {
  const { Pool } = require('pg');
  const pool = new Pool(connectionConfig(url));
  pool.on('error', e => console.error('[db] idle client error:', e.message));
  // What the database holds right now, per collection: key -> JSON of the stored value.
  const snap = { users: new Map(), sessions: new Map(), codes: new Map() };
  const savedEvents = new WeakSet();
  let running = null, again = false, lastError = null;

  const sessionsOf = db => {
    const all = new Map();
    for (const [k, s] of Object.entries(db.sessions)) all.set('u:' + k, { kind: 'user', key: k, s });
    for (const [k, s] of Object.entries(db.adminSessions)) all.set('a:' + k, { kind: 'admin', key: k, s });
    return all;
  };

  async function sync(db) {
    const users = new Map(Object.entries(db.users).map(([k, u]) => [k, JSON.stringify(u)]));
    const sessions = sessionsOf(db);
    const sessionJson = new Map([...sessions].map(([k, v]) => [k, JSON.stringify(v.s)]));
    for (const [k, v] of sessions) sessions.set(k, { ...v, s: JSON.parse(sessionJson.get(k)) });
    const codes = new Map(Object.entries(db.codes).map(([k, c]) => [k, JSON.stringify(c)]));
    const newEvents = db.events.filter(e => !savedEvents.has(e));
    const changed = (cur, old) => [...cur].filter(([k, v]) => old.get(k) !== v).map(([k]) => k);
    const removed = (cur, old) => [...old.keys()].filter(k => !cur.has(k));
    const work = {
      users: [changed(users, snap.users), removed(users, snap.users)],
      sessions: [changed(sessionJson, snap.sessions), removed(sessionJson, snap.sessions)],
      codes: [changed(codes, snap.codes), removed(codes, snap.codes)],
    };
    if (!newEvents.length && Object.values(work).every(([c, r]) => !c.length && !r.length)) return;

    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      // Write from the snapshot taken above: db can change while these queries run.
      for (const k of work.users[0]) {
        const u = JSON.parse(users.get(k));
        await client.query(
          `INSERT INTO ooc_users (email, name, role, verified, disabled, invited, password_salt, password_hash, created_at, last_login, last_seen, updated_at)
           VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11, now())
           ON CONFLICT (email) DO UPDATE SET name=$2, role=$3, verified=$4, disabled=$5, invited=$6, password_salt=$7, password_hash=$8,
             created_at=$9, last_login=$10, last_seen=$11, updated_at=now()`,
          [u.email, u.name, u.role || null, !!u.verified, !!u.disabled, !!u.invited, u.salt, u.hash, u.created || null, u.lastLogin || null, u.lastSeen || null]);
      }
      if (work.users[1].length) await client.query('DELETE FROM ooc_users WHERE email = ANY($1)', [work.users[1]]);
      for (const k of work.sessions[0]) {
        const { kind, key, s } = sessions.get(k);
        await client.query(
          `INSERT INTO ooc_sessions (token_hash, kind, email, expires_at, data) VALUES ($1,$2,$3,$4,$5)
           ON CONFLICT (token_hash) DO UPDATE SET kind=$2, email=$3, expires_at=$4, data=$5`,
          [key, kind, s.email, new Date(s.exp), s]);
      }
      if (work.sessions[1].length) await client.query('DELETE FROM ooc_sessions WHERE token_hash = ANY($1)', [work.sessions[1].map(k => k.slice(2))]);
      for (const k of work.codes[0]) {
        const c = JSON.parse(codes.get(k));
        await client.query(
          `INSERT INTO ooc_codes (key, expires_at, data) VALUES ($1,$2,$3) ON CONFLICT (key) DO UPDATE SET expires_at=$2, data=$3`,
          [k, new Date(c.exp), c]);
      }
      if (work.codes[1].length) await client.query('DELETE FROM ooc_codes WHERE key = ANY($1)', [work.codes[1]]);
      for (const e of newEvents) {
        await client.query('INSERT INTO ooc_events (at, type, email, ip, by_email) VALUES ($1,$2,$3,$4,$5)', [e.t, e.type, e.email || null, e.ip || null, e.by || null]);
      }
      await client.query('COMMIT');
    } catch (e) {
      await client.query('ROLLBACK').catch(() => {});
      throw e;
    } finally {
      client.release();
    }
    // Only after the commit: remember what the database now holds.
    snap.users = users;
    snap.sessions = sessionJson;
    snap.codes = codes;
    for (const e of newEvents) savedEvents.add(e);
  }

  return {
    kind: 'postgres',
    get label() { try { const u = new URL(url); return `Postgres ${u.hostname}${u.pathname}`; } catch (e) { return 'Postgres'; } },
    get lastError() { return lastError; },
    async load() {
      await pool.query(SCHEMA);
      await pool.query('DELETE FROM ooc_sessions WHERE expires_at < now()');
      await pool.query(`DELETE FROM ooc_codes WHERE expires_at < now() - interval '1 hour'`);
      await pool.query('DELETE FROM ooc_events WHERE id <= (SELECT max(id) FROM ooc_events) - $1', [KEEP_EVENTS_IN_DB]);
      const db = empty();
      for (const r of (await pool.query('SELECT * FROM ooc_users')).rows) db.users[r.email] = toUser(r);
      for (const r of (await pool.query('SELECT token_hash, kind, data FROM ooc_sessions')).rows) {
        (r.kind === 'admin' ? db.adminSessions : db.sessions)[r.token_hash] = r.data;
      }
      for (const r of (await pool.query('SELECT key, data FROM ooc_codes')).rows) db.codes[r.key] = r.data;
      const ev = (await pool.query('SELECT at, type, email, ip, by_email FROM ooc_events ORDER BY id DESC LIMIT 2000')).rows.reverse();
      db.events = ev.map(r => { const e = { t: iso(r.at), type: r.type, email: r.email || '', ip: r.ip || '' }; if (r.by_email) e.by = r.by_email; return e; });
      db.events.forEach(e => savedEvents.add(e));
      snap.users = new Map(Object.entries(db.users).map(([k, u]) => [k, JSON.stringify(u)]));
      snap.sessions = new Map([...sessionsOf(db)].map(([k, v]) => [k, JSON.stringify(v.s)]));
      snap.codes = new Map(Object.entries(db.codes).map(([k, c]) => [k, JSON.stringify(c)]));

      // One-time move: an empty database picks up accounts from an old auth.json, if one is still on disk.
      const file = path.join(dataDir, 'auth.json');
      if (!Object.keys(db.users).length && fs.existsSync(file)) {
        try {
          const old = { ...empty(), ...JSON.parse(fs.readFileSync(file, 'utf8')) };
          if (Object.keys(old.users).length) {
            console.log(`[db] importing ${Object.keys(old.users).length} account(s) from ${file}`);
            await sync(old);
            fs.renameSync(file, file + '.imported');
            return old;
          }
        } catch (e) { console.error('[db] could not import auth.json:', e.message); }
      }
      return db;
    },
    // Writes are queued: one transaction at a time, and changes made meanwhile go in the next one.
    persist(db) {
      if (running) { again = true; return running; }
      running = (async () => {
        do {
          again = false;
          try { await sync(db); lastError = null; }
          catch (e) {
            lastError = e.message;
            console.error('[db] save failed, retrying in 5 seconds:', e.message);
            setTimeout(() => this.persist(db), 5000).unref();
            break;
          }
        } while (again);
      })().finally(() => { running = null; });
      return running;
    },
    async flush(db) { if (running) await running; if (db) await this.persist(db); },
    async close() { await pool.end(); },
  };
}

function createStore(dataDir) {
  const url = process.env.DATABASE_URL || process.env.DATABASE_PRIVATE_URL || '';
  return url ? pgStore(url, dataDir) : fileStore(dataDir);
}

module.exports = { createStore, connectionConfig };
