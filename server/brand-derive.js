'use strict';
// Shared by the server (Brand Map store) and the browser engine: how a brand is looked up in the shared Brand Map,
// how a mother brand is guessed for a new brand, and how the Category dataset is derived from the main spot-log dataset.

const clean = s => String(s == null ? '' : s).replace(/\s+/g, ' ').trim();
const norm = s => clean(s).toLowerCase();
// A brand is looked up by product group + brand, ignoring case and extra spaces.
const keyOf = (pg, brand) => norm(pg) + '|' + norm(brand);

// First word of the brand, unless the brand starts with a mother brand that is already known in this product
// group (longest match wins), so "Close Up Triple Fresh" joins "Close Up" rather than becoming "Close".
function guessMother(brand, knownMothers) {
  const b = clean(brand);
  if (!b || b === '(blank)') return '(blank)';
  const low = b.toLowerCase();
  let best = '';
  for (const m of knownMothers || []) {
    const ml = clean(m).toLowerCase();
    if (ml && (low === ml || low.startsWith(ml + ' ')) && ml.length > best.length) best = clean(m);
  }
  if (best) return best;
  return b.split(' ')[0].replace(/[,;:]+$/, '');
}

// Category dataset (the same shape CategoryBuilder produces) from the spot-log dataset.
// lookup(pg, brand) returns { mother, sub } or null. Spend is in thousand rupees, split by medium.
function deriveCategory(ds, lookup, meta) {
  const { dicts, cols } = ds;
  if (!dicts.product || !cols.product) throw new Error('This data file was loaded before brands were read. Please load it again to build the Category dashboard.');
  const n = cols.mon.length;
  const pgD = dicts.pg, advD = dicts.adv, prodD = dicts.product;
  const medOf = dicts.channelMedium;
  const mbList = [], mbMap = new Map(), subList = [], subMap = new Map();
  const idOf = (list, map, v) => { const k = v.toLowerCase(); let i = map.get(k); if (i === undefined) { i = list.length; list.push(v); map.set(k, i); } return i; };
  // The mother brand and sub category of each (product group, brand) pair, looked up once.
  const pairInfo = new Map();
  const infoFor = (pg, prod) => {
    const k = pg * prodD.length + prod;
    let v = pairInfo.get(k);
    if (!v) {
      const found = lookup(pgD[pg], prodD[prod]);
      const mother = clean(found && found.mother) || guessMother(prodD[prod], []);
      const sub = clean(found && found.sub);
      v = { mb: idOf(mbList, mbMap, mother), sub: sub ? idOf(subList, subMap, sub) : -1 };
      pairInfo.set(k, v);
    }
    return v;
  };
  // Sum spot cost per month, product group, mother brand, advertiser, brand and sub category.
  const agg = new Map();
  for (let i = 0; i < n; i++) {
    const info = infoFor(cols.pg[i], cols.product[i]);
    const key = [cols.mon[i], cols.pg[i], info.mb, cols.adv[i], cols.product[i], info.sub].join(',');
    let a = agg.get(key);
    if (!a) { a = [cols.mon[i], cols.pg[i], info.mb, cols.adv[i], cols.product[i], info.sub, 0, 0, 0]; agg.set(key, a); }
    const m = medOf[cols.ch[i]];
    a[6 + (m === 0 ? 0 : m === 1 ? 1 : 2)] += cols.cost[i] / 1000;
  }
  const rows = [...agg.values()];
  if (!rows.length) throw new Error('No rows to build the Category dashboard from.');
  const subs = ['(none)', ...subList];
  const c = { mon: [], pg: [], mb: [], adv: [], brand: [], sub: [], tv: [], radio: [], press: [] };
  for (const r of rows) {
    c.mon.push(r[0]); c.pg.push(r[1]); c.mb.push(r[2]); c.adv.push(r[3]); c.brand.push(r[4]); c.sub.push(r[5] + 1);
    c.tv.push(r[6]); c.radio.push(r[7]); c.press.push(r[8]);
  }
  let minMon = Infinity, maxMon = -Infinity;
  for (const m of c.mon) { if (m < minMon) minMon = m; if (m > maxMon) maxMon = m; }
  return {
    meta: { ...(meta || {}), kind: 'category', derived: true, rows: rows.length, skipped: 0, minMon, maxMon, hasSub: subList.length > 0 },
    dicts: { pg: pgD.slice(), mb: mbList, adv: advD.slice(), brand: prodD.slice(), sub: subs },
    cols: {
      mon: Int32Array.from(c.mon), pg: Int32Array.from(c.pg), mb: Int32Array.from(c.mb), adv: Int32Array.from(c.adv),
      brand: Int32Array.from(c.brand), sub: Int32Array.from(c.sub),
      tv: Float64Array.from(c.tv), radio: Float64Array.from(c.radio), press: Float64Array.from(c.press),
    },
  };
}

module.exports = { clean, norm, keyOf, guessMother, deriveCategory };
