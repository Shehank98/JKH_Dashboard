'use strict';
// Shared client dashboards. The agency saves a data cube (the spot log summed down to monthly records, see cube.js),
// gets a link, and the client opens /share/<token> with no sign-in. The link carries an unguessable token, can expire
// and can be revoked. Postgres when DATABASE_URL is set (table shared_dashboards), otherwise files under DATA_DIR/shared.

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { connectionConfig } = require('./authstore');

const MAX_CUBE_BYTES = 40 * 1024 * 1024; // as JSON text, before compression
const TOKEN_RE = /^[A-Za-z0-9_-]{20,64}$/;

const SCHEMA = `
CREATE TABLE IF NOT EXISTS shared_dashboards (
  share_token    text PRIMARY KEY,
  title          text NOT NULL,
  client_name    text NOT NULL DEFAULT '',
  created_by     text,
  data_cube      jsonb NOT NULL,
  locked_filters jsonb,
  view_state     jsonb,
  expires_at     timestamptz,
  created_at     timestamptz NOT NULL DEFAULT now(),
  revoked_at     timestamptz,
  views          integer NOT NULL DEFAULT 0,
  last_viewed    timestamptz
);
CREATE INDEX IF NOT EXISTS shared_dashboards_by ON shared_dashboards (created_by);
`;

const iso = v => (v ? new Date(v).toISOString() : null);
const metaOf = r => ({ token: r.share_token || r.token, title: r.title, clientName: r.client_name ?? r.clientName ?? '', createdBy: r.created_by ?? r.createdBy,
  expiresAt: iso(r.expires_at ?? r.expiresAt), createdAt: iso(r.created_at ?? r.createdAt), revokedAt: iso(r.revoked_at ?? r.revokedAt), views: r.views || 0, lastViewed: iso(r.last_viewed ?? r.lastViewed) });

function fileStore(dataDir) {
  const dir = path.join(dataDir, 'shared');
  fs.mkdirSync(dir, { recursive: true });
  const f = (t, kind) => path.join(dir, `${t}.${kind}.json`);
  const readJson = file => { try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch (e) { return null; } };
  const writeJson = (file, v) => { const tmp = file + '.tmp'; fs.writeFileSync(tmp, JSON.stringify(v)); fs.renameSync(tmp, file); };
  return {
    kind: 'file',
    async init() {},
    async insert(r) {
      const { cube, ...meta } = r;
      writeJson(f(r.token, 'cube'), cube);
      writeJson(f(r.token, 'meta'), meta);
    },
    async get(token, withCube) {
      const meta = readJson(f(token, 'meta'));
      if (!meta) return null;
      return withCube ? { ...meta, cube: readJson(f(token, 'cube')) } : meta;
    },
    async list(email) {
      return fs.readdirSync(dir).filter(n => n.endsWith('.meta.json')).map(n => readJson(path.join(dir, n))).filter(m => m && (!email || m.createdBy === email));
    },
    async revoke(token, at) { const m = readJson(f(token, 'meta')); if (m) { m.revokedAt = at; writeJson(f(token, 'meta'), m); } },
    async touch(token) { const m = readJson(f(token, 'meta')); if (m) { m.views = (m.views || 0) + 1; m.lastViewed = new Date().toISOString(); writeJson(f(token, 'meta'), m); } },
    async close() {},
  };
}

function pgStore(url) {
  const { Pool } = require('pg');
  const pool = new Pool(connectionConfig(url));
  pool.on('error', e => console.error('[shares db] idle client error:', e.message));
  const cols = 'share_token, title, client_name, created_by, locked_filters, view_state, expires_at, created_at, revoked_at, views, last_viewed';
  const fromRow = r => ({ ...metaOf(r), lockedFilters: r.locked_filters, state: r.view_state, cube: r.data_cube });
  return {
    kind: 'postgres',
    async init() { await pool.query(SCHEMA); },
    async insert(r) {
      await pool.query(`INSERT INTO shared_dashboards (share_token, title, client_name, created_by, data_cube, locked_filters, view_state, expires_at, created_at)
        VALUES ($1,$2,$3,$4,$5::jsonb,$6::jsonb,$7::jsonb,$8,$9)`,
        [r.token, r.title, r.clientName, r.createdBy, JSON.stringify(r.cube), JSON.stringify(r.lockedFilters || null), JSON.stringify(r.state || null), r.expiresAt, r.createdAt]);
    },
    async get(token, withCube) {
      const q = await pool.query(`SELECT ${cols}${withCube ? ', data_cube' : ''} FROM shared_dashboards WHERE share_token = $1`, [token]);
      return q.rows[0] ? fromRow(q.rows[0]) : null;
    },
    async list(email) {
      const q = await pool.query(`SELECT ${cols} FROM shared_dashboards ${email ? 'WHERE created_by = $1' : ''} ORDER BY created_at DESC LIMIT 200`, email ? [email] : []);
      return q.rows.map(fromRow);
    },
    async revoke(token, at) { await pool.query('UPDATE shared_dashboards SET revoked_at = $2 WHERE share_token = $1', [token, at]); },
    async touch(token) { await pool.query('UPDATE shared_dashboards SET views = views + 1, last_viewed = now() WHERE share_token = $1', [token]); },
    async close() { await pool.end(); },
  };
}

async function createShares(dataDir) {
  const url = process.env.DATABASE_URL || process.env.DATABASE_PRIVATE_URL || '';
  const store = url ? pgStore(url) : fileStore(dataDir);
  await store.init();

  const clean = (v, max) => String(v == null ? '' : v).replace(/\s+/g, ' ').trim().slice(0, max);
  const fail = (status, message) => Object.assign(new Error(message), { status });
  const origin = req => `${req.protocol}://${req.get('host')}`;

  // auth: the sign-in module (null when sign-in is off for local development).
  function router(express, auth) {
    const r = express.Router();
    const wrap = fn => (req, res) => Promise.resolve(fn(req, res)).catch(e => res.status(e.status || 500).json({ error: e.message }));
    const agency = (req, res, next) => {
      if (!auth) { req.user = { email: 'local', name: 'local' }; return next(); }
      const u = auth.userOf(req);
      if (!u) return res.status(401).json({ error: 'Please sign in', signIn: true });
      req.user = u; next();
    };
    // Only the data cube is large; it is parsed here with a bigger limit than the rest of the API.
    r.post('/', agency, express.json({ limit: MAX_CUBE_BYTES }), wrap(async (req, res) => {
      const b = req.body || {};
      const title = clean(b.title, 140);
      if (!title) throw fail(400, 'Please give the dashboard a title');
      const cube = b.cube;
      if (!cube || !cube.cols || !cube.dicts || !cube.meta || !Array.isArray(cube.cols.mon) || !cube.cols.mon.length) throw fail(400, 'The data for this dashboard is missing or empty');
      const n = cube.cols.mon.length;
      for (const k of Object.keys(cube.cols)) if (!Array.isArray(cube.cols[k]) || cube.cols[k].length !== n) throw fail(400, 'The data for this dashboard is not valid');
      let expiresAt = null;
      if (b.expiresAt) {
        const t = new Date(b.expiresAt);
        if (Number.isNaN(t.getTime())) throw fail(400, 'The expiry date is not valid');
        if (t.getTime() <= Date.now()) throw fail(400, 'The expiry date must be in the future');
        expiresAt = t.toISOString();
      }
      const token = crypto.randomBytes(24).toString('base64url');
      const createdBy = req.user.email;
      await store.insert({
        token, title, clientName: clean(b.clientName, 140), createdBy, cube, lockedFilters: b.lockedFilters && typeof b.lockedFilters === 'object' ? b.lockedFilters : null,
        state: b.state && typeof b.state === 'object' ? b.state : null, expiresAt, createdAt: new Date().toISOString(),
      });
      res.json({ token, url: `${origin(req)}/share/${token}`, expiresAt });
    }));
    r.get('/', agency, wrap(async (req, res) => {
      const all = auth && auth.adminOf && auth.adminOf(req);
      const rows = await store.list(all ? null : req.user.email);
      res.json({ shares: rows.map(m => ({ ...metaOf(m), url: `${origin(req)}/share/${m.token || m.share_token}` })).sort((a, b) => String(b.createdAt).localeCompare(String(a.createdAt))) });
    }));
    r.delete('/:token', agency, wrap(async (req, res) => {
      if (!TOKEN_RE.test(req.params.token)) throw fail(404, 'Not found');
      const m = await store.get(req.params.token, false);
      if (!m) throw fail(404, 'Not found');
      const mine = (m.createdBy) === req.user.email;
      if (!mine && !(auth && auth.adminOf && auth.adminOf(req))) throw fail(403, 'Only the person who shared it can turn the link off');
      await store.revoke(req.params.token, new Date().toISOString());
      res.json({ ok: true });
    }));
    // Public: whoever has the link. No sign-in, no listing, nothing but the one dashboard.
    r.get('/:token', wrap(async (req, res) => {
      res.setHeader('Cache-Control', 'no-store');
      res.setHeader('X-Robots-Tag', 'noindex, nofollow');
      if (!TOKEN_RE.test(req.params.token)) throw fail(404, 'This link is not valid.');
      const s = await store.get(req.params.token, true);
      if (!s) throw fail(404, 'This link is not valid.');
      if (s.revokedAt) throw fail(410, 'This link has been turned off.');
      if (s.expiresAt && new Date(s.expiresAt).getTime() <= Date.now()) throw fail(410, 'This link has expired.');
      store.touch(req.params.token).catch(() => {});
      res.json({ title: s.title, clientName: s.clientName, createdAt: s.createdAt, expiresAt: s.expiresAt, lockedFilters: s.lockedFilters, state: s.state, cube: s.cube });
    }));
    return r;
  }
  return { router, close: () => store.close(), storage: store.kind };
}

module.exports = { createShares };
