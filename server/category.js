'use strict';
// Aggregations for the Category dashboard: mother brand cards for a month range, with the same range a year
// earlier and the range just before it. Spend is kept in thousand rupees, as in the file.

const { monthKey } = require('./category-builder');

const MEDIA = ['TV', 'Radio', 'Press'];
const keyToMon = key => { const [y, m] = String(key).split('-').map(Number); return y * 12 + (m - 1); };
const sum3 = (a, b, c) => a + b + c;

function overview(ds) {
  const { pg, tv, radio, press } = ds.cols;
  const spend = new Float64Array(ds.dicts.pg.length);
  for (let i = 0; i < pg.length; i++) spend[pg[i]] += sum3(tv[i], radio[i], press[i]);
  const months = [];
  for (let m = ds.meta.minMon; m <= ds.meta.maxMon; m++) months.push(monthKey(m));
  return {
    meta: ds.meta, months, minMonth: monthKey(ds.meta.minMon), maxMonth: monthKey(ds.meta.maxMon),
    productGroups: ds.dicts.pg.map((name, i) => ({ name, spend: spend[i] })).sort((a, b) => b.spend - a.spend),
    hasSub: !!ds.meta.hasSub,
  };
}

// Advertisers and sub categories active inside one product group, biggest first.
function options(ds, pgName, subName) {
  const pgId = ds.dicts.pg.indexOf(pgName);
  if (pgId < 0) return { advertisers: [], subs: [] };
  const subId = subName ? ds.dicts.sub.indexOf(subName) : -1;
  const { pg, adv, sub, tv, radio, press } = ds.cols;
  const advSpend = new Float64Array(ds.dicts.adv.length), advSeen = new Uint8Array(ds.dicts.adv.length);
  const subSpend = new Float64Array(ds.dicts.sub.length), subSeen = new Uint8Array(ds.dicts.sub.length);
  for (let i = 0; i < pg.length; i++) {
    if (pg[i] !== pgId) continue;
    const v = sum3(tv[i], radio[i], press[i]);
    subSpend[sub[i]] += v; subSeen[sub[i]] = 1;
    if (subId >= 0 && sub[i] !== subId) continue;
    advSpend[adv[i]] += v; advSeen[adv[i]] = 1;
  }
  const advertisers = [], subs = [];
  advSeen.forEach((s, i) => { if (s) advertisers.push({ name: ds.dicts.adv[i], spend: advSpend[i] }); });
  subSeen.forEach((s, i) => { if (s) subs.push({ name: ds.dicts.sub[i], spend: subSpend[i] }); });
  advertisers.sort((a, b) => b.spend - a.spend); subs.sort((a, b) => b.spend - a.spend);
  return { advertisers, subs };
}

function resolve(ds, f) {
  const pgId = ds.dicts.pg.indexOf(f.pg);
  if (pgId < 0) throw new Error('Unknown product group');
  const m0 = keyToMon(f.from), m1 = keyToMon(f.to);
  if (!(m1 >= m0)) throw new Error('Invalid month range');
  const len = m1 - m0 + 1;
  const subId = f.sub ? ds.dicts.sub.indexOf(f.sub) : -1;
  const mine = new Uint8Array(ds.dicts.adv.length), comp = new Uint8Array(ds.dicts.adv.length);
  let nComp = 0;
  for (const n of f.comps || []) { const i = ds.dicts.adv.indexOf(n); if (i >= 0) { comp[i] = 1; nComp++; } }
  for (const n of f.mine || []) { const i = ds.dicts.adv.indexOf(n); if (i >= 0) { mine[i] = 1; comp[i] = 0; } }
  return { pgId, subId, m0, m1, len, mine, comp, nComp };
}

function dashboard(ds, f) {
  const { dicts, cols } = ds;
  const { pgId, subId, m0, m1, len, mine, comp, nComp } = resolve(ds, f);
  const { pg, sub, mon, mb, adv, tv, radio, press } = cols;
  const nMb = dicts.mb.length;
  const cur = new Float64Array(nMb), yoy = new Float64Array(nMb), prev = new Float64Array(nMb);
  const med = new Float64Array(nMb * 3);
  // Month by month history for the chart, from the first month in the file to the last selected month, so the
  // dashboard can show months, quarters, half years or years.
  const w0 = ds.meta.minMon, nW = m1 - w0 + 1;
  const catMon = new Float64Array(nW), mbMon = new Float64Array(nMb * nW);
  // Sub category x mother brand, for the sub category tables.
  const nSub = dicts.sub.length;
  const sCur = new Float64Array(nSub * nMb), sYoy = new Float64Array(nSub * nMb), sPrev = new Float64Array(nSub * nMb);
  const isMine = new Uint8Array(nMb), isComp = new Uint8Array(nMb), seen = new Uint8Array(nMb);
  const cat = { cur: 0, yoy: 0, prev: 0 };
  const y0 = m0 - 12, y1 = m1 - 12, p0 = m0 - len, p1 = m0 - 1;
  for (let i = 0, n = pg.length; i < n; i++) {
    if (pg[i] !== pgId) continue;
    if (subId >= 0 && sub[i] !== subId) continue;
    const b = mb[i], a = adv[i];
    seen[b] = 1;
    if (mine[a]) isMine[b] = 1; else if (comp[a]) isComp[b] = 1;
    const m = mon[i], t = tv[i], r = radio[i], p = press[i], v = t + r + p;
    if (m >= w0 && m <= m1) { catMon[m - w0] += v; mbMon[b * nW + m - w0] += v; }
    const sb = sub[i] * nMb + b;
    if (m >= m0 && m <= m1) { sCur[sb] += v; cur[b] += v; cat.cur += v; med[b * 3] += t; med[b * 3 + 1] += r; med[b * 3 + 2] += p; }
    if (m >= y0 && m <= y1) { sYoy[sb] += v; yoy[b] += v; cat.yoy += v; }
    if (m >= p0 && m <= p1) { sPrev[sb] += v; prev[b] += v; cat.prev += v; }
  }
  const covered = (a, b) => a >= ds.meta.minMon && b <= ds.meta.maxMon;
  const hasYoy = covered(y0, y1), hasPrev = covered(p0, p1);
  // Rank over every mother brand in the group, then pick the cards.
  const ranked = [];
  for (let b = 0; b < nMb; b++) if (seen[b] && (cur[b] > 0 || isMine[b])) ranked.push(b);
  ranked.sort((x, y) => cur[y] - cur[x]);
  const rankOf = new Map(ranked.map((b, i) => [b, i + 1]));
  const top = f.top === 0 || f.top === '0' || f.top === 'all' ? ranked.length : Math.max(1, Number(f.top) || 10);
  const pool = nComp ? ranked.filter(b => isMine[b] || isComp[b]) : ranked;
  const picked = pool.slice(0, top);
  for (const b of ranked) if (isMine[b] && !picked.includes(b)) picked.push(b);
  picked.sort((x, y) => cur[y] - cur[x]);

  // Sub category tables (or one table of mother brands when the file has no sub categories).
  const growthOf = (c, y) => (y > 0 ? ((c - y) / y) * 100 : null);
  const ROWS = 8;
  const tables = [];
  for (let sIdx = 0; sIdx < nSub; sIdx++) {
    const base = sIdx * nMb;
    const brands = [];
    let tc = 0, ty = 0, tp = 0;
    for (let b = 0; b < nMb; b++) {
      const c = sCur[base + b], y = sYoy[base + b], p = sPrev[base + b];
      if (c > 0 || y > 0 || p > 0) { brands.push({ b, c, y, p, key: Math.max(c, y, p) }); tc += c; ty += y; tp += p; }
    }
    if (!brands.length || (tc <= 0 && ty <= 0 && tp <= 0)) continue;
    brands.sort((a, z) => z.key - a.key);
    const keep = brands.filter((x, i) => i < ROWS || isMine[x.b]);
    const rest = brands.filter(x => !keep.includes(x));
    keep.sort((a, z) => z.c - a.c || z.y - a.y);
    const mk = (name, c, y, p, extra) => ({ name, cur: c, yoy: hasYoy ? y : null, prev: hasPrev ? p : null, growth: hasYoy ? growthOf(c, y) : null, share: tc ? (c / tc) * 100 : 0, ...extra });
    const rows = keep.map(x => mk(dicts.mb[x.b], x.c, x.y, x.p, { mine: !!isMine[x.b] }));
    if (rest.length) rows.push(mk(`Others (${rest.length})`, rest.reduce((a, x) => a + x.c, 0), rest.reduce((a, x) => a + x.y, 0), rest.reduce((a, x) => a + x.p, 0), { others: true }));
    tables.push({
      name: ds.meta.hasSub ? dicts.sub[sIdx] : f.pg, none: dicts.sub[sIdx] === '(none)' && ds.meta.hasSub,
      cur: tc, yoy: hasYoy ? ty : null, prev: hasPrev ? tp : null, growth: hasYoy ? growthOf(tc, ty) : null,
      share: cat.cur ? (tc / cat.cur) * 100 : 0, brandCount: brands.length, rows,
    });
  }
  tables.sort((a, z) => z.cur - a.cur || (z.yoy || 0) - (a.yoy || 0));
  // Mix of sub categories in the three periods, and each one's part of the net change on last year.
  const mix = tables.length > 1 ? {
    cur: tables.map(t => (cat.cur ? (t.cur / cat.cur) * 100 : 0)),
    yoy: hasYoy ? tables.map(t => (cat.yoy ? (t.yoy / cat.yoy) * 100 : 0)) : null,
    prev: hasPrev ? tables.map(t => (cat.prev ? (t.prev / cat.prev) * 100 : 0)) : null,
  } : null;
  const net = hasYoy ? cat.cur - cat.yoy : null;
  const contribution = hasYoy && tables.length > 1 ? tables.map(t => ({ name: t.name, cur: t.cur, yoy: t.yoy, growth: t.growth, part: net ? ((t.cur - t.yoy) / net) * 100 : null })) : null;
  const cards = picked.map(b => ({
    name: dicts.mb[b], mine: !!isMine[b], rank: rankOf.get(b) || null,
    cur: cur[b], yoy: hasYoy ? yoy[b] : null, prev: hasPrev ? prev[b] : null,
    growth: hasYoy && yoy[b] > 0 ? ((cur[b] - yoy[b]) / yoy[b]) * 100 : null,
    share: cat.cur ? (cur[b] / cat.cur) * 100 : 0,
    medium: [med[b * 3], med[b * 3 + 1], med[b * 3 + 2]],
    monthly: Array.from(mbMon.subarray(b * nW, (b + 1) * nW)),
  }));
  return {
    filters: { ...f, top: f.top },
    ranges: { cur: [monthKey(m0), monthKey(m1)], yoy: [monthKey(y0), monthKey(y1)], prev: [monthKey(p0), monthKey(p1)], months: len },
    monthly: { months: Array.from({ length: nW }, (_, k) => monthKey(w0 + k)), selStart: m0 - w0, cat: Array.from(catMon) },
    hasYoy, hasPrev, total: { cur: cat.cur, yoy: hasYoy ? cat.yoy : null, prev: hasPrev ? cat.prev : null },
    brandCount: ranked.length, shown: cards.length, cards,
    hasSubs: !!ds.meta.hasSub, tables, mix, contribution, net,
  };
}

// One mother brand: its advertisers, brands and sub categories, and the month by month spend by medium.
function detail(ds, f, scope) {
  const { dicts, cols } = ds;
  const { pgId, subId, m0, m1, len } = resolve(ds, f);
  // scope: { mb } one mother brand, { sub } one sub category, { all: true } the whole selection.
  const mbId = scope.mb ? dicts.mb.indexOf(scope.mb) : -1;
  if (scope.mb && mbId < 0) throw new Error('Unknown mother brand');
  const scSub = scope.sub ? dicts.sub.indexOf(scope.sub) : -1;
  if (scope.sub && scSub < 0) throw new Error('Unknown sub category');
  if (!scope.mb && !scope.sub && !scope.all) throw new Error('Nothing to show');
  const { pg, sub, mon, mb, adv, brand, tv, radio, press } = cols;
  const y0 = m0 - 12, y1 = m1 - 12;
  const group = (n) => ({ cur: new Float64Array(n), yoy: new Float64Array(n), seen: new Uint8Array(n) });
  const A = group(dicts.adv.length), B = group(dicts.brand.length), S = group(dicts.sub.length), MB = group(dicts.mb.length);
  const monthly = Array.from({ length: len }, (_, k) => ({ key: monthKey(m0 + k), tv: 0, radio: 0, press: 0, yoy: 0 }));
  let cur = 0, yoy = 0;
  for (let i = 0, n = pg.length; i < n; i++) {
    if (pg[i] !== pgId || (mbId >= 0 && mb[i] !== mbId) || (scSub >= 0 && sub[i] !== scSub)) continue;
    if (subId >= 0 && sub[i] !== subId) continue;
    const m = mon[i], v = tv[i] + radio[i] + press[i];
    if (m >= m0 && m <= m1) {
      cur += v;
      for (const [G, id] of [[A, adv[i]], [B, brand[i]], [S, sub[i]], [MB, mb[i]]]) { G.cur[id] += v; G.seen[id] = 1; }
      const row = monthly[m - m0]; row.tv += tv[i]; row.radio += radio[i]; row.press += press[i];
    }
    if (m >= y0 && m <= y1) {
      yoy += v;
      for (const [G, id] of [[A, adv[i]], [B, brand[i]], [S, sub[i]], [MB, mb[i]]]) { G.yoy[id] += v; G.seen[id] = 1; }
      monthly[m - y0].yoy += v;
    }
  }
  const list = (G, names) => {
    const out = [];
    G.seen.forEach((s, i) => { if (s && (G.cur[i] > 0 || G.yoy[i] > 0)) out.push({ name: names[i], cur: G.cur[i], yoy: G.yoy[i], share: cur ? (G.cur[i] / cur) * 100 : 0 }); });
    return out.sort((a, b) => b.cur - a.cur);
  };
  return {
    name: scope.mb || scope.sub || f.pg, kind: scope.mb ? 'mb' : scope.sub ? 'sub' : 'all', cur, yoy, months: len,
    mothers: list(MB, dicts.mb), advertisers: list(A, dicts.adv), brands: list(B, dicts.brand), subs: ds.meta.hasSub ? list(S, dicts.sub) : [],
    monthly,
  };
}

module.exports = { overview, options, dashboard, detail, MEDIA };
