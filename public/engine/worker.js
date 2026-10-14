'use strict';
// The dashboard's data engine, running in the person's own browser (a Web Worker, so the page stays responsive).
// It reads the spot log they choose, keeps it in memory, saves it in this browser's IndexedDB under their
// account, and answers the same questions the server used to: overview, options, dashboard, detail, planning.
// The file never leaves the computer. The calculation code is the same as the server's (served from /engine/lib).

importScripts('/vendor/jszip/jszip.min.js');

// ---- a tiny CommonJS loader for the shared modules ----
const LIB = ['derive', 'brand-derive', 'cube', 'builder', 'compute', 'planning', 'competitor', 'periods', 'category-builder', 'category', 'category-brand', 'browser-readers'];
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
let heldLookup = null, heldVersion = null; // the Brand Map the Category data was built with, for the brand view
let sharedMode = false; // a client's data cube: nothing is read from or written to this browser's storage
let pending = null; // a file that has been read but whose brands are not confirmed yet
let catDataset = null; // the Category file, saved under the same person with a ':category' suffix
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
  // Step 1 of loading a main file: read it and list its brands. Nothing is saved until commitIngest, because the
  // brands must first be confirmed in the shared Brand Map. A file with no Product column loads straight away.
  async ingest({ file }, progress) {
    const { readSpotFile } = requireLib('browser-readers');
    const ds = await readSpotFile(file, (pct, rows) => progress({ pct, rows }));
    if (!ds.meta.hasProduct) {
      pending = null;
      return { needsMap: false, ...(await saveSpot(ds, progress)) };
    }
    pending = ds;
    const { dicts, cols } = ds;
    const seen = new Set(), pairs = [];
    const nProd = dicts.product.length;
    for (let i = 0; i < cols.pg.length; i++) {
      const k = cols.pg[i] * nProd + cols.product[i];
      if (seen.has(k)) continue;
      seen.add(k);
      pairs.push([dicts.pg[cols.pg[i]], dicts.product[cols.product[i]]]);
    }
    return { needsMap: true, pairs, rows: ds.meta.rows, fileName: ds.meta.fileName };
  },
  // Step 2: the brands are confirmed. Save the file, then build the Category data from it with the confirmed map.
  async commitIngest({ map, version }, progress) {
    if (!pending) throw new Error('No file is waiting to be loaded. Please choose the file again.');
    const ds = pending;
    pending = null;
    const out = await saveSpot(ds, progress);
    const cat = await buildCategory(map, version);
    return { ...out, category: cat };
  },
  // ---- shared client dashboards ----
  // The data cube for the loaded file: monthly records only (see cube.js), with mother brand and sub category from the Brand Map.
  buildCube({ map, pg, level, tagCommercial }) {
    const { keyOf } = requireLib('brand-derive');
    const lookup = new Map();
    for (const r of map || []) lookup.set(keyOf(r[0], r[1]), { mother: r[2], sub: r[3] });
    const t = Date.now();
    const cube = requireLib('cube').buildCube(need(), (g, b) => lookup.get(keyOf(g, b)) || null, { pg: pg || '', level, tagCommercial: !!tagCommercial });
    return { cube, ms: Date.now() - t };
  },
  // The Category dashboard's rows for a share (needs Category data, built from the main file or loaded).
  buildCategoryCube({ pg }) { return requireLib('cube').packCategory(needCat(), pg || ''); },
  // The client's side: a cube replaces the dataset in memory only (nothing is saved in this browser).
  initShared({ cube }) {
    const lib = requireLib('cube');
    dataset = lib.unpackCube(cube);
    sharedMode = true;
    catDataset = cube.category ? lib.unpackCategory(cube.category) : null;
    return { dataset: describe(dataset), category: describeCat(catDataset) };
  },
  // The Brand Map for the brand view (when the page was opened without loading a file, the map is fetched and handed over).
  setMap({ map, version }) {
    const { keyOf } = requireLib('brand-derive');
    const lookup = new Map();
    for (const r of map || []) lookup.set(keyOf(r[0], r[1]), { mother: r[2], sub: r[3] });
    heldLookup = lookup; heldVersion = version;
    return { ok: true };
  },
  // Full brand view for a click in the Category dashboard (channels, ad types and campaigns come from the main file).
  catBrand({ filters, scope, tagCommercial }) {
    if (!heldLookup) throw new Error('The Brand Map is not loaded yet.');
    const { keyOf } = requireLib('brand-derive');
    return requireLib('category-brand').brandView(need(), (pg, b) => heldLookup.get(keyOf(pg, b)) || null, filters || {}, scope || {}, { tagCommercial: !!tagCommercial });
  },
  // What the Category data currently is, so the page can tell when the Brand Map has moved on.
  catStatus() { return { has: !!catDataset, derived: !sharedMode && !!(catDataset && catDataset.meta.derived), mapVersion: catDataset ? catDataset.meta.mapVersion : null, mapHeld: heldVersion, canDerive: !!(dataset && dataset.dicts.product) }; },
  async cancelIngest() { pending = null; return { ok: true }; },
  // The Brand Map changed (someone edited it): rebuild the Category data from the saved main file.
  async rederiveCategory({ map, version }) {
    if (!dataset || !dataset.dicts.product) return { category: null };
    return { category: await buildCategory(map, version) };
  },
  // Reads a Category file only to list its product group, brand, mother brand and sub category (to fill the Brand Map).
  async readMapping({ file }, progress) {
    const { readCategoryFile } = requireLib('browser-readers');
    const ds = await readCategoryFile(file, (pct, rows) => progress({ pct, rows }));
    const { dicts, cols } = ds;
    const seen = new Set(), rows = [];
    for (let i = 0; i < cols.mb.length; i++) {
      const k = cols.pg[i] * 1e8 + cols.brand[i];
      if (seen.has(k)) continue;
      seen.add(k);
      const brand = dicts.brand[cols.brand[i]], sub = dicts.sub[cols.sub[i]];
      rows.push([dicts.pg[cols.pg[i]], brand, dicts.mb[cols.mb[i]], !sub || sub === '(none)' ? '' : sub]);
    }
    return { rows, skipped: ds.meta.skipped };
  },
  async clear() {
    dataset = null;
    try { await idbDo('readwrite', s => s.delete(owner)); } catch (e) { /* nothing saved */ }
    return { ok: true };
  },
  // ---- Category dashboard (a second, independent file) ----
  async catInit() {
    if (sharedMode) return { dataset: describeCat(catDataset), storageError: null };
    catDataset = null;
    let saved = null, storageError = null;
    try { saved = await idbDo('readonly', s => s.get(owner + ':category')); } catch (e) { storageError = e.message; }
    if (saved && saved.cols && saved.dicts && saved.meta && saved.meta.kind === 'category') catDataset = saved;
    return { dataset: describeCat(catDataset), storageError };
  },
  async catIngest({ file }, progress) {
    const { readCategoryFile } = requireLib('browser-readers');
    const ds = await readCategoryFile(file, (pct, rows) => progress({ pct, rows }));
    catDataset = ds;
    let saved = true, storageError = null;
    progress({ pct: 1, rows: ds.meta.rows, saving: true });
    try { await idbDo('readwrite', s => s.put(ds, owner + ':category')); } catch (e) { saved = false; storageError = e.message; }
    return { dataset: describeCat(ds), saved, storageError };
  },
  async catClear() {
    catDataset = null;
    try { await idbDo('readwrite', s => s.delete(owner + ':category')); } catch (e) { /* nothing saved */ }
    return { ok: true };
  },
  catOverview() { return requireLib('category').overview(needCat()); },
  catOptions({ pg, sub }) { return requireLib('category').options(needCat(), String(pg || ''), sub ? String(sub) : ''); },
  catDashboard(filters) { return requireLib('category').dashboard(needCat(), filters || {}); },
  catDetail({ filters, scope }) { return requireLib('category').detail(needCat(), filters || {}, scope || {}); },
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
const monKey = m => `${Math.floor(m / 12)}-${String((m % 12) + 1).padStart(2, '0')}`;
const describeCat = ds => (ds ? { ...ds.meta, minMonth: monKey(ds.meta.minMon), maxMonth: monKey(ds.meta.maxMon), storedIn: 'browser' } : null);

async function saveSpot(ds, progress) {
  dataset = ds;
  let saved = true, storageError = null;
  progress({ pct: 1, rows: ds.meta.rows, saving: true });
  try { await idbDo('readwrite', s => s.put(ds, owner)); } catch (e) { saved = false; storageError = e.message; }
  return { dataset: describe(ds), saved, storageError };
}
// Category data derived from the saved main file, using the shared Brand Map (rows of [pg, brand, mother, sub]).
async function buildCategory(map, version) {
  const { deriveCategory, keyOf } = requireLib('brand-derive');
  const lookup = new Map();
  for (const r of map || []) lookup.set(keyOf(r[0], r[1]), { mother: r[2], sub: r[3] });
  heldLookup = lookup; heldVersion = version;
  const m = dataset.meta;
  const cat = deriveCategory(dataset, (pg, brand) => lookup.get(keyOf(pg, brand)) || null,
    { fileName: m.fileName, size: m.size, uploadedAt: m.uploadedAt, mapVersion: version });
  catDataset = cat;
  let saved = true, storageError = null;
  try { await idbDo('readwrite', s => s.put(cat, owner + ':category')); } catch (e) { saved = false; storageError = e.message; }
  return { dataset: describeCat(cat), saved, storageError };
}
function needCat() {
  if (!catDataset) throw new Error('No category file loaded yet. Open Filters, Data file, and choose your category file.');
  return catDataset;
}
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
