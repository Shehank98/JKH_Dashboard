'use strict';
// The data cube behind a shared client dashboard: the spot log summed down to one record per
// month, channel, product group, advertiser, mother brand + sub category, daypart, ad length and ad type
// (commercial or value addition). No programme, campaign, brand name, break, time of day or individual spot is kept,
// so the raw spot log cannot be rebuilt from it. The cube loads into the same engine as the full dataset
// (records carry how many spots they stand for), so every chart works on it unchanged.

const D = require('./derive');
const { guessMother, keyOf, clean } = require('./brand-derive');

const THEMES = ['Commercials', 'Value additions -BB']; // the second name is recognised as a value addition by derive.js
const VERSION = 1;

// Detail levels: how finely a cube is cut. Every extra dimension multiplies the number of records.
//   full      month, channel, product group, advertiser, mother brand, sub category, daypart, ad length, ad type
//   standard  the same without ad length (the Duration Mix card is left out)
//   compact   without ad length and daypart (the Duration Mix card and the daypart filter are left out)
const LEVELS = ['full', 'standard', 'compact'];

// lookup(pg, brand) -> { mother, sub } | null (the shared Brand Map). opts.pg locks the cube to one product group.
function buildCube(ds, lookup, opts) {
  opts = opts || {};
  const level = LEVELS.includes(opts.level) ? opts.level : 'full';
  const keepDur = level === 'full', keepDp = level !== 'compact';
  const { dicts, cols } = ds;
  const n = cols.mon.length;
  const hasProduct = !!(dicts.product && cols.product);
  const lockId = opts.pg ? dicts.pg.indexOf(opts.pg) : -1;
  if (opts.pg && lockId < 0) throw new Error('Unknown product group');
  const excluded = dicts.theme.map(t => (D.isExcludedTheme(t, { tagCommercial: false }) ? 1 : 0));
  // Mother brand + sub category entries, numbered as they are met.
  const prodList = [], prodMap = new Map();
  const prodOf = (mother, sub) => {
    const k = mother.toLowerCase() + '\u0001' + sub.toLowerCase();
    let i = prodMap.get(k);
    if (i === undefined) { i = prodList.length; prodList.push([mother, sub]); prodMap.set(k, i); }
    return i;
  };
  const infoCache = new Map();
  const prodFor = (pgId, productId) => {
    if (!hasProduct) return prodOf('All brands', '');
    const k = pgId * dicts.product.length + productId;
    let v = infoCache.get(k);
    if (v === undefined) {
      const brand = dicts.product[productId], found = lookup ? lookup(dicts.pg[pgId], brand) : null;
      v = prodOf(clean(found && found.mother) || guessMother(brand, []), clean(found && found.sub));
      infoCache.set(k, v);
    }
    return v;
  };
  const agg = new Map();
  const durRaw = cols.durRaw || null;
  for (let i = 0; i < n; i++) {
    if (lockId >= 0 && cols.pg[i] !== lockId) continue;
    const th = excluded[cols.theme[i]] ? 1 : 0;
    const raw = keepDur && durRaw ? durRaw[i] : NaN;
    const sec = keepDur && durRaw ? D.durSecondsOf(raw, th === 1) : NaN;
    const du = keepDur && durRaw ? D.durBucketOf(raw, th === 1) : 255;
    const dpv = keepDp ? cols.dp[i] : 4;
    const pr = prodFor(cols.pg[i], hasProduct ? cols.product[i] : 0);
    const key = cols.mon[i] + ',' + cols.pg[i] + ',' + cols.adv[i] + ',' + pr + ',' + cols.ch[i] + ',' + dpv + ',' + du + ',' + th;
    let a = agg.get(key);
    if (!a) { a = [cols.mon[i], cols.pg[i], cols.adv[i], pr, cols.ch[i], dpv, du, th, 0, 0, 0, 0]; agg.set(key, a); }
    a[8] += cols.cost[i]; a[9]++;
    if (sec > 0) { a[10] += sec; a[11]++; }
  }
  const rows = [...agg.values()];
  if (!rows.length) throw new Error('There is no data to share for this selection.');
  // Only the product groups, advertisers and channels that remain are kept, renumbered.
  const remap = (list, idx) => {
    const m = new Map(), out = [];
    for (const r of rows) if (!m.has(r[idx])) { m.set(r[idx], out.length); out.push(r[idx]); }
    return { m, ids: out };
  };
  const pgR = remap(dicts.pg, 1), advR = remap(dicts.adv, 2), chR = remap(dicts.channel, 4);
  const c = { mon: [], pg: [], adv: [], pr: [], ch: [], dp: [], du: [], th: [], cost: [], n: [], ns: [], sec: [] };
  for (const r of rows) {
    c.mon.push(r[0]); c.pg.push(pgR.m.get(r[1])); c.adv.push(advR.m.get(r[2])); c.pr.push(r[3]); c.ch.push(chR.m.get(r[4]));
    c.dp.push(r[5]); c.du.push(r[6]); c.th.push(r[7]); c.cost.push(Math.round(r[8])); c.n.push(r[9]); c.ns.push(r[11]); c.sec.push(Math.round(r[10]));
  }
  let minMon = Infinity, maxMon = -Infinity, spots = 0;
  for (let i = 0; i < c.mon.length; i++) { if (c.mon[i] < minMon) minMon = c.mon[i]; if (c.mon[i] > maxMon) maxMon = c.mon[i]; spots += c.n[i]; }
  return {
    v: VERSION,
    meta: { minMon, maxMon, spots, records: rows.length, hasMap: hasProduct, lockedPg: opts.pg || '', level },
    dicts: {
      pg: pgR.ids.map(i => dicts.pg[i]), adv: advR.ids.map(i => dicts.adv[i]), channel: chR.ids.map(i => dicts.channel[i]),
      channelMedium: chR.ids.map(i => dicts.channelMedium[i]), channelName: chR.ids.map(i => dicts.channelName[i]),
      mother: prodList.map(p => p[0]), sub: prodList.map(p => p[1]),
    },
    cols: c,
  };
}

// The cube as an engine dataset (typed arrays, the same shape as a loaded spot log).
function unpackCube(cube) {
  if (!cube || cube.v !== VERSION) throw new Error('This shared dashboard was made by a different version. Ask for a new link.');
  const { dicts: d, cols: c } = cube;
  const n = c.mon.length;
  const day = new Int32Array(n), mon = Int32Array.from(c.mon);
  for (let i = 0; i < n; i++) day[i] = Math.round(Date.UTC(Math.floor(mon[i] / 12), mon[i] % 12, 1) / 86400000);
  const durRaw = new Float32Array(n);
  for (let i = 0; i < n; i++) durRaw[i] = c.ns[i] > 0 ? c.sec[i] / c.ns[i] : NaN;
  const zero8 = new Uint8Array(n);
  const lastMon = cube.meta.maxMon;
  return {
    meta: {
      cube: true, rows: n, spots: cube.meta.spots, skipped: 0, hasProduct: false, hasMap: cube.meta.hasMap, lockedPg: cube.meta.lockedPg, level: cube.meta.level || 'full',
      minDay: Math.round(Date.UTC(Math.floor(cube.meta.minMon / 12), cube.meta.minMon % 12, 1) / 86400000),
      maxDay: Math.round(Date.UTC(Math.floor(lastMon / 12), (lastMon % 12) + 1, 1) / 86400000) - 1,
      fileName: 'Shared dashboard', uploadedAt: new Date().toISOString(), parseMs: 0,
    },
    dicts: {
      pg: d.pg, adv: d.adv, channel: d.channel, channelMedium: d.channelMedium, channelName: d.channelName,
      theme: THEMES.slice(), program: ['(blank)'], adPos: ['(blank)'],
      product: d.mother.map((m, i) => (d.sub[i] ? m + ' · ' + d.sub[i] : m)), productMother: d.mother, productSub: d.sub,
    },
    cols: {
      pg: Int32Array.from(c.pg), adv: Int32Array.from(c.adv), ch: Int32Array.from(c.ch), theme: Int32Array.from(c.th),
      day, mon, dp: Uint8Array.from(c.dp), dur: Uint8Array.from(c.du), durRaw, bq: new Uint8Array(n).fill(2),
      cost: Float64Array.from(c.cost), prog: new Int32Array(n), adPos: new Int32Array(n),
      brk: zero8, pos: zero8, ads: zero8, hour: new Uint8Array(n).fill(255),
      product: Int32Array.from(c.pr), n: Int32Array.from(c.n), ns: Int32Array.from(c.ns),
    },
  };
}

module.exports = { buildCube, unpackCube, THEMES, LEVELS };
