'use strict';
// The shared Brand Map: for each product group + brand, the mother brand and (optional) sub category.
// Everyone signed in shares one map and can edit it; every change is recorded (who, when, old value, new value) so
// it can be undone. Postgres when DATABASE_URL is set (survives redeploys), otherwise DATA_DIR/brandmap.json.
// The whole map lives in memory (a few thousand rows) and each change is written straight to the store.

const fs = require('fs');
const path = require('path');
const { keyOf, clean } = require('./brand-derive');
const { connectionConfig } = require('./authstore');

const MAX_TEXT = 120;
const MAX_SAVE_ROWS = 20000;
const KEEP_HISTORY_IN_FILE = 20000;

const SCHEMA = `
CREATE TABLE IF NOT EXISTS ooc_brand_map (
  key         text PRIMARY KEY,
  pg          text NOT NULL,
  brand       text NOT NULL,
  mother      text NOT NULL,
  sub         text NOT NULL DEFAULT '',
  by_email    text,
  updated_at  timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE IF NOT EXISTS ooc_brand_history (
  id        bigserial PRIMARY KEY,
  at        timestamptz NOT NULL DEFAULT now(),
  by_email  text,
  batch     text NOT NULL,
  key       text NOT NULL,
  pg        text NOT NULL,
  brand     text NOT NULL,
  old       jsonb,
  new       jsonb,
  kind      text NOT NULL DEFAULT 'edit'
);
CREATE INDEX IF NOT EXISTS ooc_brand_history_batch ON ooc_brand_history (batch);
`;

// ---------- file store ----------
function fileStore(dataDir) {
  const file = path.join(dataDir, 'brandmap.json');
  let state = { rows: {}, history: [], lastId: 0 };
  return {
    kind: 'file',
    async load() {
      try { state = { rows: {}, history: [], lastId: 0, ...JSON.parse(fs.readFileSync(file, 'utf8')) }; } catch (e) { /* first run */ }
      return state;
    },
    async write(rowOps, hist) {
      for (const [k, v] of rowOps) { if (v) state.rows[k] = v; else delete state.rows[k]; }
      for (const h of hist) { h.id = ++state.lastId; state.history.push(h); }
      if (state.history.length > KEEP_HISTORY_IN_FILE) state.history.splice(0, state.history.length - KEEP_HISTORY_IN_FILE);
      const tmp = file + '.tmp';
      fs.writeFileSync(tmp, JSON.stringify(state));
      fs.renameSync(tmp, file);
    },
    async history(limit) { return state.history.slice(-limit).reverse(); },
    async batchEntries(batch) { return state.history.filter(h => h.batch === batch); },
    async close() {},
  };
}

// ---------- Postgres ----------
function pgStore(url) {
  const { Pool } = require('pg');
  const pool = new Pool(connectionConfig(url));
  pool.on('error', e => console.error('[brandmap db] idle client error:', e.message));
  const toRow = r => ({ pg: r.pg, brand: r.brand, mother: r.mother, sub: r.sub, by: r.by_email, at: new Date(r.updated_at).toISOString() });
  const toHist = r => ({ id: Number(r.id), at: new Date(r.at).toISOString(), by: r.by_email, batch: r.batch, key: r.key, pg: r.pg, brand: r.brand, old: r.old, new: r.new, kind: r.kind });
  return {
    kind: 'postgres',
    async load() {
      await pool.query(SCHEMA);
      const rows = {};
      for (const r of (await pool.query('SELECT * FROM ooc_brand_map')).rows) rows[r.key] = toRow(r);
      const last = (await pool.query('SELECT COALESCE(MAX(id), 0) AS m FROM ooc_brand_history')).rows[0].m;
      return { rows, history: [], lastId: Number(last) };
    },
    async write(rowOps, hist) {
      const c = await pool.connect();
      try {
        await c.query('BEGIN');
        for (const [k, v] of rowOps) {
          if (v) await c.query(`INSERT INTO ooc_brand_map (key, pg, brand, mother, sub, by_email, updated_at) VALUES ($1,$2,$3,$4,$5,$6,$7)
            ON CONFLICT (key) DO UPDATE SET pg=$2, brand=$3, mother=$4, sub=$5, by_email=$6, updated_at=$7`, [k, v.pg, v.brand, v.mother, v.sub, v.by, v.at]);
          else await c.query('DELETE FROM ooc_brand_map WHERE key = $1', [k]);
        }
        for (const h of hist) {
          const r = await c.query(`INSERT INTO ooc_brand_history (at, by_email, batch, key, pg, brand, old, new, kind) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9) RETURNING id`,
            [h.at, h.by, h.batch, h.key, h.pg, h.brand, h.old ? JSON.stringify(h.old) : null, h.new ? JSON.stringify(h.new) : null, h.kind]);
          h.id = Number(r.rows[0].id);
        }
        await c.query('COMMIT');
      } catch (e) { await c.query('ROLLBACK').catch(() => {}); throw e; } finally { c.release(); }
    },
    async history(limit) { return (await pool.query('SELECT * FROM ooc_brand_history ORDER BY id DESC LIMIT $1', [limit])).rows.map(toHist); },
    async batchEntries(batch) { return (await pool.query('SELECT * FROM ooc_brand_history WHERE batch = $1 ORDER BY id', [batch])).rows.map(toHist); },
    async close() { await pool.end(); },
  };
}

async function createBrandMap(dataDir) {
  const url = process.env.DATABASE_URL || process.env.DATABASE_PRIVATE_URL || '';
  const store = url ? pgStore(url) : fileStore(dataDir);
  const state = await store.load();
  const rows = new Map(Object.entries(state.rows));
  let version = state.lastId;
  let chain = Promise.resolve(); // writes run one at a time

  const text = (v, what, required) => {
    const s = clean(v);
    if (required && !s) throw Object.assign(new Error(`${what} is required`), { status: 400 });
    if (s.length > MAX_TEXT) throw Object.assign(new Error(`${what} is too long (max ${MAX_TEXT} characters)`), { status: 400 });
    return s;
  };

  // Applies changes: list of { pg, brand, mother, sub } (set) or { pg, brand, remove: true }. Returns { version, batch, changed }.
  function apply(changes, by, kind, batchId) {
    const run = chain.then(async () => {
      const batch = batchId || `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
      const at = new Date().toISOString();
      const ops = [], hist = [];
      const staged = new Map(rows);
      for (const ch of changes) {
        const pg = text(ch.pg, 'Product group', true), brand = text(ch.brand, 'Brand', true), key = keyOf(pg, brand);
        const old = staged.get(key) || null;
        if (ch.remove) {
          if (!old) continue;
          staged.delete(key); ops.push([key, null]);
          hist.push({ at, by, batch, key, pg: old.pg, brand: old.brand, old: { mother: old.mother, sub: old.sub }, new: null, kind });
          continue;
        }
        const mother = text(ch.mother, 'Mother brand', true), sub = text(ch.sub, 'Sub category', false);
        if (old && old.mother === mother && old.sub === sub) continue;
        const row = { pg: old ? old.pg : pg, brand: old ? old.brand : brand, mother, sub, by, at };
        staged.set(key, row); ops.push([key, row]);
        hist.push({ at, by, batch, key, pg: row.pg, brand: row.brand, old: old ? { mother: old.mother, sub: old.sub } : null, new: { mother, sub }, kind });
      }
      if (ops.length) {
        await store.write(ops, hist);
        for (const [k, v] of ops) { if (v) rows.set(k, v); else rows.delete(k); }
        version = Math.max(version, ...hist.map(h => h.id));
      }
      return { version, batch, changed: ops.length };
    });
    chain = run.catch(() => {});
    return run;
  }

  async function undo(batch, by) {
    const entries = await store.batchEntries(batch);
    if (!entries.length) throw Object.assign(new Error('Nothing to undo for that change'), { status: 404 });
    const changes = entries.slice().reverse().map(h => (h.old
      ? { pg: h.pg, brand: h.brand, mother: h.old.mother, sub: h.old.sub }
      : { pg: h.pg, brand: h.brand, remove: true }));
    return apply(changes, by, 'undo');
  }

  const rowOut = r => ({ pg: r.pg, brand: r.brand, mother: r.mother, sub: r.sub, by: r.by, at: r.at });
  const nameOf = req => (req.user && (req.user.name || req.user.email)) || 'local';

  function router(express) {
    const r = express.Router();
    const wrap = fn => (req, res) => Promise.resolve(fn(req, res)).catch(e => res.status(e.status || 500).json({ error: e.message }));
    r.get('/version', (req, res) => res.json({ version, count: rows.size }));
    // Which of these (product group, brand) pairs are in the map? Also the mothers and subs known per product group.
    r.post('/check', wrap(async (req, res) => {
      const pairs = Array.isArray(req.body && req.body.pairs) ? req.body.pairs : [];
      if (pairs.length > 100000) throw Object.assign(new Error('Too many brands in one check'), { status: 400 });
      const results = pairs.map(p => { const row = rows.get(keyOf(p[0], p[1])); return row ? [row.mother, row.sub] : null; });
      const mothers = {}, subs = {};
      const want = new Set(pairs.map(p => clean(p[0]).toLowerCase()));
      for (const row of rows.values()) {
        const g = clean(row.pg).toLowerCase();
        if (!want.has(g)) continue;
        (mothers[row.pg] = mothers[row.pg] || new Set()).add(row.mother);
        if (row.sub) (subs[row.pg] = subs[row.pg] || new Set()).add(row.sub);
      }
      const arr = o => Object.fromEntries(Object.entries(o).map(([k, v]) => [k, [...v].sort()]));
      res.json({ version, results, mothers: arr(mothers), subs: arr(subs) });
    }));
    r.get('/all', (req, res) => res.json({ version, rows: [...rows.values()].map(v => [v.pg, v.brand, v.mother, v.sub]) }));
    r.get('/list', (req, res) => {
      const q = clean(req.query.q).toLowerCase(), filter = String(req.query.filter || '');
      const offset = Math.max(0, Number(req.query.offset) || 0), limit = Math.min(500, Math.max(1, Number(req.query.limit) || 100));
      let list = [...rows.values()];
      if (q) list = list.filter(v => (v.pg + ' ' + v.brand + ' ' + v.mother + ' ' + v.sub).toLowerCase().includes(q));
      if (filter === 'nosub') list = list.filter(v => !v.sub);
      list.sort((a, b) => a.pg.localeCompare(b.pg) || a.mother.localeCompare(b.mother) || a.brand.localeCompare(b.brand));
      const mothers = {}, subs = {};
      for (const v of rows.values()) { (mothers[v.pg] = mothers[v.pg] || new Set()).add(v.mother); if (v.sub) (subs[v.pg] = subs[v.pg] || new Set()).add(v.sub); }
      const arr = o => Object.fromEntries(Object.entries(o).map(([k, s]) => [k, [...s].sort()]));
      res.json({ version, total: list.length, count: rows.size, rows: list.slice(offset, offset + limit).map(rowOut), mothers: arr(mothers), subs: arr(subs) });
    });
    r.post('/save', wrap(async (req, res) => {
      const list = Array.isArray(req.body && req.body.rows) ? req.body.rows : [];
      if (!list.length) throw Object.assign(new Error('Nothing to save'), { status: 400 });
      if (list.length > MAX_SAVE_ROWS) throw Object.assign(new Error(`Too many rows in one save (max ${MAX_SAVE_ROWS})`), { status: 400 });
      // onlyNew: add brands that are not in the map yet and leave existing ones alone (used by file imports).
      const rowsIn = req.body.onlyNew ? list.filter(c => !rows.has(keyOf(c && c.pg, c && c.brand))) : list;
      if (!rowsIn.length) return res.json({ version, batch: null, changed: 0 });
      const kind = req.body.kind === 'import' ? 'import' : req.body.kind === 'upload' ? 'upload' : 'edit';
      res.json(await apply(rowsIn, nameOf(req), kind));
    }));
    r.get('/history', wrap(async (req, res) => {
      const limit = Math.min(500, Math.max(1, Number(req.query.limit) || 200));
      const entries = await store.history(limit * 20);
      // Group the entries of one save (a batch) into a single line.
      const batches = new Map();
      for (const h of entries) {
        let b = batches.get(h.batch);
        if (!b) { b = { batch: h.batch, at: h.at, by: h.by, kind: h.kind, count: 0, sample: [] }; batches.set(h.batch, b); }
        b.count++;
        if (b.sample.length < 3) b.sample.push(`${h.brand}: ${h.old ? h.old.mother + (h.old.sub ? ' / ' + h.old.sub : '') : '(new)'} → ${h.new ? h.new.mother + (h.new.sub ? ' / ' + h.new.sub : '') : '(removed)'}`);
      }
      res.json({ version, batches: [...batches.values()].slice(0, limit) });
    }));
    r.post('/undo', wrap(async (req, res) => res.json(await undo(String(req.body && req.body.batch || ''), nameOf(req)))));
    return r;
  }

  return { router, apply, undo, close: () => store.close(), storage: store.kind, size: () => rows.size, get: (pg, brand) => rows.get(keyOf(pg, brand)) || null, version: () => version };
}

module.exports = { createBrandMap };
