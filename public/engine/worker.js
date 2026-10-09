'use strict';
// The dashboard's data engine, running in the person's own browser (a Web Worker, so the page stays responsive).
// It reads the spot log they choose, keeps it in memory, saves it in this browser's IndexedDB under their
// account, and answers the same questions the server used to: overview, options, dashboard, detail, planning.
// The file never leaves the computer. The calculation code is the same as the server's (served from /engine/lib).

importScripts('/vendor/jszip/jszip.min.js');

// ---- a tiny CommonJS loader for the shared modules ----
const LIB = ['derive', 'builder', 'compute', 'planning', 'competitor', 'browser-readers'];
const SRC = {}, CACHE = {};
function requireLib(name) {
  if (name === 'jszip') return self.JSZip;
  const key = name.replace(/^\.\//, '').replace(/\.js$/, '');
  if (CACHE[key]) return CACHE[key].exports;
  if (!(key in SRC)) throw new Error('Unknown module ' + name);
  const module = { exports: {} };
  CACHE[key] = module;
  new Function('module', 'exports', 'require', SRC[key] + '\n//# sourceURL=engine/' + key + '.js')(module, module.exports, requireLib);
  return module.exports;
}
const ready = (async () => {
  const v = (self.location.search.match(/[?&]v=([^&]+)/) || [])[1] || '';
  await Promise.all(LIB.map(async n => {
    const r = await fetch(`/engine/lib/${n}.js?v=${v}`, { cache: 'no-cache' });
    if (!r.ok) throw new Error(`Could not load the data engine (${n}: ${r.status})`);
    SRC[n] = await r.text();
  }));
})();

// ---- IndexedDB: one saved dataset per signed-in person in this browser ----
const DB_NAME = 'ooc-live-dashboard', STORE = 'datasets';
function idb() {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, 1);
    req.onupgradeneeded = () => req.result.createObjectStore(STORE);
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}
async function idbDo(mode, fn) {
  const db = await idb();
  try {
    return await new Promise((resolve, reject) => {
      const tx = db.transaction(STORE, mode);
      const out = fn(tx.objectStore(STORE));
      tx.oncomplete = () => resolve(out && 'result' in out ? out.result : undefined);
      tx.onerror = () => reject(tx.error);
      tx.onabort = () => reject(tx.error || new Error('Saving in the browser was cancelled'));
    });
  } finally { db.close(); }
}

let owner = 'local';
let dataset = null;
const isoDay = d => new Date(d * 86400000).toISOString().slice(0, 10);
const describe = ds => (ds ? { ...ds.meta, minDate: isoDay(ds.meta.minDay), maxDate: isoDay(ds.meta.maxDay), storedIn: 'browser' } : null);

const handlers = {
  async init({ user }) {
    owner = user || 'local';
    dataset = null;
    let saved = null, storageError = null;
    try { saved = await idbDo('readonly', s => s.get(owner)); } catch (e) { storageError = e.message; }
    if (saved && saved.cols && saved.dicts && saved.meta) dataset = saved;
    return { dataset: describe(dataset), storageError };
  },
  async ingest({ file }, progress) {
    const { readSpotFile } = requireLib('browser-readers');
    const ds = await readSpotFile(file, (pct, rows) => progress({ pct, rows }));
    dataset = ds;
    let saved = true, storageError = null;
    progress({ pct: 1, rows: ds.meta.rows, saving: true });
    try { await idbDo('readwrite', s => s.put(ds, owner)); } catch (e) { saved = false; storageError = e.message; }
    return { dataset: describe(ds), saved, storageError };
  },
  async clear() {
    dataset = null;
    try { await idbDo('readwrite', s => s.delete(owner)); } catch (e) { /* nothing saved */ }
    return { ok: true };
  },
  overview() { return requireLib('compute').overview(need()); },
  options({ pg }) { return requireLib('compute').groupOptions(need(), String(pg || '')); },
  dashboard(filters) {
    const t = Date.now();
    const out = requireLib('compute').dashboard(need(), filters || {});
    out.computeMs = Date.now() - t;
    return out;
  },
  detail({ filters, scope }) { return requireLib('compute').detail(need(), filters || {}, scope || {}); },
  planning({ filters, user }) { return requireLib('planning').planning(need(), filters || {}, { user: user || '' }); },
  competitor({ filters, user }) { return requireLib('competitor').competitorIntel(need(), filters || {}, { user: user || '' }); },
};
function need() {
  if (!dataset) throw new Error('No data file loaded yet. Open Filters, Data file, and choose your file.');
  return dataset;
}

self.onmessage = async e => {
  const { id, cmd, args } = e.data || {};
  try {
    await ready;
    if (!handlers[cmd]) throw new Error('Unknown command ' + cmd);
    const result = await handlers[cmd](args || {}, p => self.postMessage({ id, progress: p }));
    self.postMessage({ id, result });
  } catch (err) {
    self.postMessage({ id, error: (err && err.message) || String(err) });
  }
};
