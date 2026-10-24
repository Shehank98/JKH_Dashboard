'use strict';
// The data cube behind a shared client dashboard: the spot log summed down to one record per
// month, channel, product group, advertiser, mother brand + sub category, daypart, ad length and ad type
// (commercial or value addition). No programme, campaign, brand name, break, time of day or individual spot is kept,
// so the raw spot log cannot be rebuilt from it. The cube loads into the same engine as the full dataset
// (records carry how many spots they stand for), so every chart works on it unchanged.

const D = require('./derive');
const { guessMother, keyOf, clean } = require('./brand-derive');

const THEMES = ['Commercials', 'Value additions -BB']; // the second name is recognised as a value addition by derive.js
const VERSION = 2; // 2: the time-of-day dimension is prime / non prime time (version 1 kept daypart numbers; still opens)

// Detail levels: how finely a cube is cut. Every extra dimension multiplies the number of records.
//   full      month, channel, product group, advertiser, mother brand, sub category, prime time or not, ad length and the campaign
//             (Advt_Theme), so campaigns, Value additions and the Duration Mix work exactly as in the full file
//   standard  the same without ad length (the Duration Mix card is left out)
//   compact   without ad length and prime time (the Duration Mix card and the prime time filter are left out)
const LEVELS = ['full', 'standard', 'compact'];

// lookup(pg, brand) -> { mother, sub } | null (the shared Brand Map). opts.pg locks the cube to one product group.
function buildCube(ds, lookup, opts) {
  opts = opts || {};
  const level = LEVELS.includes(opts.level) ? opts.level : 'full';
  const keepDur = level === 'full', keepDp = level !== 'compact', keepTheme = level === 'full';
  const { dicts, cols } = ds;
  const n = cols.mon.length;
  const hasProduct = !!(dicts.product && cols.product);
  const lockId = opts.pg ? dicts.pg.indexOf(opts.pg) : -1;
  if (opts.pg && lockId < 0) throw new Error('Unknown product group');
  const excluded = dicts.theme.map(t => (D.isExcludedTheme(t, { tagCommercial: !!opts.tagCommercial }) ? 1 : 0));
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
    let raw = keepDur && durRaw ? durRaw[i] : NaN, sec, du, hr = 0;
    if (keepTheme) {
      // Real campaign names are kept, so whether an ad is a value addition is decided when the client looks (the Tag
      // tick box works). Length is therefore grouped as recorded; value additions are put in the 5s bucket by the engine.
      hr = raw > 0 ? 1 : 0;
      sec = hr ? raw : 0; du = hr ? D.durBucketOf(raw, false) : 255;
    } else {
      sec = keepDur && durRaw ? D.durSecondsOf(raw, th === 1) : NaN;
      du = keepDur && durRaw ? D.durBucketOf(raw, th === 1) : 255;
    }
    const dpv = keepDp ? D.slotOf(cols.hour ? cols.hour[i] : 255) : 0; // 0 neither, 1 prime time, 2 non prime time
    const pr = prodFor(cols.pg[i], hasProduct ? cols.product[i] : 0);
    const thv = keepTheme ? cols.theme[i] : th;
    const key = cols.mon[i] + ',' + cols.pg[i] + ',' + cols.adv[i] + ',' + pr + ',' + cols.ch[i] + ',' + dpv + ',' + du + ',' + thv + ',' + hr;
    let a = agg.get(key);
    if (!a) { a = [cols.mon[i], cols.pg[i], cols.adv[i], pr, cols.ch[i], dpv, du, thv, 0, 0, 0, 0]; agg.set(key, a); }
    a[8] += cols.cost[i]; a[9]++;
    if (keepTheme) { a[10] += sec; a[11]++; } else if (sec > 0) { a[10] += sec; a[11]++; }
  }
  const rows = [...agg.values()];
  if (!rows.length) throw new Error('There is no data to share for this selection.');
  // Only the product groups, advertisers and channels that remain are kept, renumbered.
  const remap = (list, idx) => {
    const m = new Map(), out = [];
    for (const r of rows) if (!m.has(r[idx])) { m.set(r[idx], out.length); out.push(r[idx]); }
    return { m, ids: out };
  };
  const pgR = remap(dicts.pg, 1), advR = remap(dicts.adv, 2), chR = remap(dicts.channel, 4), thR = keepTheme ? remap(dicts.theme, 7) : null;
  const c = { mon: [], pg: [], adv: [], pr: [], ch: [], dp: [], du: [], th: [], cost: [], n: [], ns: [], sec: [] };
  for (const r of rows) {
    c.mon.push(r[0]); c.pg.push(pgR.m.get(r[1])); c.adv.push(advR.m.get(r[2])); c.pr.push(r[3]); c.ch.push(chR.m.get(r[4]));
    c.dp.push(r[5]); c.du.push(r[6]); c.th.push(keepTheme ? thR.m.get(r[7]) : r[7]); c.cost.push(Math.round(r[8])); c.n.push(r[9]); c.ns.push(r[11]); c.sec.push(Math.round(r[10]));
  }
  let minMon = Infinity, maxMon = -Infinity, spots = 0;
  for (let i = 0; i < c.mon.length; i++) { if (c.mon[i] < minMon) minMon = c.mon[i]; if (c.mon[i] > maxMon) maxMon = c.mon[i]; spots += c.n[i]; }
  return {
    v: VERSION,
    meta: { minMon, maxMon, spots, records: rows.length, hasMap: hasProduct, lockedPg: opts.pg || '', level, tagCommercial: !!opts.tagCommercial, campaigns: keepTheme },
    dicts: {
      pg: pgR.ids.map(i => dicts.pg[i]), adv: advR.ids.map(i => dicts.adv[i]), channel: chR.ids.map(i => dicts.channel[i]),
      channelMedium: chR.ids.map(i => dicts.channelMedium[i]), channelName: chR.ids.map(i => dicts.channelName[i]),
      mother: prodList.map(p => p[0]), sub: prodList.map(p => p[1]),
      theme: keepTheme ? thR.ids.map(i => dicts.theme[i]) : undefined,
    },
    cols: c,
  };
}

// The cube as an engine dataset (typed arrays, the same shape as a loaded spot log).
function unpackCube(cube) {
  if (!cube || (cube.v !== VERSION && cube.v !== 1)) throw new Error('This shared dashboard was made by a different version. Ask for a new link.');
  const { dicts: d, cols: c } = cube;
  const n = c.mon.length;
  const day = new Int32Array(n), mon = Int32Array.from(c.mon);
  for (let i = 0; i < n; i++) day[i] = Math.round(Date.UTC(Math.floor(mon[i] / 12), mon[i] % 12, 1) / 86400000);
  const durRaw = new Float32Array(n);
  for (let i = 0; i < n; i++) durRaw[i] = c.ns[i] > 0 ? c.sec[i] / c.ns[i] : NaN;
  const zero8 = new Uint8Array(n);
  // A cube only knows prime time, non prime time or neither, so each record gets an hour inside that slot.
  const hourOf = (dp, ver) => {
    const h = new Uint8Array(n).fill(255);
    for (let i = 0; i < n; i++) h[i] = ver === 1 ? ([9, 14, 20, 255, 255][dp[i]] ?? 255) : dp[i] === 1 ? 20 : dp[i] === 2 ? 12 : 255;
    return h;
  };
  const lastMon = cube.meta.maxMon;
  return {
    meta: {
      cube: true, rows: n, spots: cube.meta.spots, skipped: 0, hasProduct: false, hasMap: cube.meta.hasMap, lockedPg: cube.meta.lockedPg, level: cube.meta.level || 'full', tagCommercial: !!cube.meta.tagCommercial, campaigns: !!cube.meta.campaigns,
      minDay: Math.round(Date.UTC(Math.floor(cube.meta.minMon / 12), cube.meta.minMon % 12, 1) / 86400000),
      maxDay: Math.round(Date.UTC(Math.floor(lastMon / 12), (lastMon % 12) + 1, 1) / 86400000) - 1,
      fileName: 'Shared dashboard', uploadedAt: new Date().toISOString(), parseMs: 0,
    },
    dicts: {
      pg: d.pg, adv: d.adv, channel: d.channel, channelMedium: d.channelMedium, channelName: d.channelName,
      theme: d.theme ? d.theme.slice() : THEMES.slice(), program: ['(blank)'], adPos: ['(blank)'],
      product: d.mother.map((m, i) => (d.sub[i] ? m + ' · ' + d.sub[i] : m)), productMother: d.mother, productSub: d.sub,
    },
    cols: {
      pg: Int32Array.from(c.pg), adv: Int32Array.from(c.adv), ch: Int32Array.from(c.ch), theme: Int32Array.from(c.th),
      day, mon, dp: new Uint8Array(n).fill(4), dur: Uint8Array.from(c.du), durRaw, bq: new Uint8Array(n).fill(2),
      cost: Float64Array.from(c.cost), prog: new Int32Array(n), adPos: new Int32Array(n),
      brk: zero8, pos: zero8, ads: zero8, hour: hourOf(c.dp, cube.v),
      product: Int32Array.from(c.pr), n: Int32Array.from(c.n), ns: Int32Array.from(c.ns),
    },
  };
}

// The Category dashboard's data for a share: its monthly rows (optionally one product group only), with the
// dictionaries renumbered so names from other product groups are not included.
function packCategory(ds, pg) {
  const { dicts, cols } = ds;
  const lockId = pg ? dicts.pg.indexOf(pg) : -1;
  if (pg && lockId < 0) throw new Error('Unknown product group');
  const n = cols.mon.length;
  const keep = [];
  for (let i = 0; i < n; i++) if (lockId < 0 || cols.pg[i] === lockId) keep.push(i);
  if (!keep.length) throw new Error('There is no category data to share for this selection.');
  const renum = key => {
    const m = new Map(), names = [], ids = new Array(keep.length);
    keep.forEach((i, k) => { const v = cols[key][i]; let j = m.get(v); if (j === undefined) { j = names.length; names.push(dicts[key][v]); m.set(v, j); } ids[k] = j; });
    return { names, ids };
  };
  const r = { pg: renum('pg'), mb: renum('mb'), adv: renum('adv'), brand: renum('brand'), sub: renum('sub') };
  const med = k => keep.map(i => Math.round(cols[k][i] * 1000) / 1000);
  let minMon = Infinity, maxMon = -Infinity;
  const mon = keep.map(i => { const v = cols.mon[i]; if (v < minMon) minMon = v; if (v > maxMon) maxMon = v; return v; });
  return {
    v: VERSION, meta: { minMon, maxMon, hasSub: !!ds.meta.hasSub && r.sub.names.some(x => x !== '(none)') },
    dicts: { pg: r.pg.names, mb: r.mb.names, adv: r.adv.names, brand: r.brand.names, sub: r.sub.names },
    cols: { mon, pg: r.pg.ids, mb: r.mb.ids, adv: r.adv.ids, brand: r.brand.ids, sub: r.sub.ids, tv: med('tv'), radio: med('radio'), press: med('press') },
  };
}
function unpackCategory(c) {
  if (!c || c.v !== VERSION) throw new Error('This shared dashboard was made by a different version. Ask for a new link.');
  const k = c.cols;
  return {
    meta: { kind: 'category', shared: true, rows: k.mon.length, skipped: 0, minMon: c.meta.minMon, maxMon: c.meta.maxMon, hasSub: !!c.meta.hasSub, fileName: 'Shared dashboard', uploadedAt: new Date().toISOString() },
    dicts: c.dicts,
    cols: {
      mon: Int32Array.from(k.mon), pg: Int32Array.from(k.pg), mb: Int32Array.from(k.mb), adv: Int32Array.from(k.adv), brand: Int32Array.from(k.brand), sub: Int32Array.from(k.sub),
      tv: Float64Array.from(k.tv), radio: Float64Array.from(k.radio), press: Float64Array.from(k.press),
    },
  };
}

module.exports = { buildCube, unpackCube, packCategory, unpackCategory, THEMES, LEVELS };
