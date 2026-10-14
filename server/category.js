'use strict';
// Aggregations for the Category dashboard: mother brand cards for a month range, with the same range a year
// earlier and the range just before it. Spend is kept in thousand rupees, as in the file.

const { monthKey } = require('./category-builder');
const { periodsOf, windows } = require('./periods');

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
  const win = windows(periodsOf(f, {}));
  const { m0, m1, len } = win;
  const subId = f.sub ? ds.dicts.sub.indexOf(f.sub) : -1;
  const mine = new Uint8Array(ds.dicts.adv.length), comp = new Uint8Array(ds.dicts.adv.length);
  let nComp = 0;
  for (const n of f.comps || []) { const i = ds.dicts.adv.indexOf(n); if (i >= 0) { comp[i] = 1; nComp++; } }
  for (const n of f.mine || []) { const i = ds.dicts.adv.indexOf(n); if (i >= 0) { mine[i] = 1; comp[i] = 0; } }
  return { pgId, subId, m0, m1, len, win, mine, comp, nComp };
}

function dashboard(ds, f) {
  const { dicts, cols } = ds;
  const { pgId, subId, m0, m1, len, win, mine, comp, nComp } = resolve(ds, f);
  const { pg, sub, mon, mb, adv, tv, radio, press } = cols;
  const nMb = dicts.mb.length;
  const cur = new Float64Array(nMb), yoy = new Float64Array(nMb), prev = new Float64Array(nMb);
  const med = new Float64Array(nMb * 3);
  // Month by month history for the chart, from the first month in the file to the last selected month, so the
  // dashboard can show months, quarters, half years or years.
  const w0 = ds.meta.minMon, nW = m1 - w0 + 1;
  const catMon = new Float64Array(nW), mbMon = new Float64Array(nMb * nW);
  const hTv = new Float64Array(nW), hRadio = new Float64Array(nW), hPress = new Float64Array(nW);
  const subMonSize = dicts.sub.length;
  const subMon = new Float64Array(subMonSize * nW);
  // Sub category x mother brand, for the sub category tables.
  const nSub = dicts.sub.length;
  const sCur = new Float64Array(nSub * nMb), sYoy = new Float64Array(nSub * nMb), sPrev = new Float64Array(nSub * nMb);
  const isMine = new Uint8Array(nMb), isComp = new Uint8Array(nMb), seen = new Uint8Array(nMb);
  const cat = { cur: 0, yoy: 0, prev: 0 };
  for (let i = 0, n = pg.length; i < n; i++) {
    if (pg[i] !== pgId) continue;
    if (subId >= 0 && sub[i] !== subId) continue;
    const b = mb[i], a = adv[i];
    seen[b] = 1;
    if (mine[a]) isMine[b] = 1; else if (comp[a]) isComp[b] = 1;
    const m = mon[i], t = tv[i], r = radio[i], p = press[i], v = t + r + p;
    if (m >= w0 && m <= m1) { catMon[m - w0] += v; mbMon[b * nW + m - w0] += v; hTv[m - w0] += t; hRadio[m - w0] += r; hPress[m - w0] += p; subMon[sub[i] * nW + m - w0] += v; }
    const sb = sub[i] * nMb + b;
    const bt = win.bits(m);
    if (bt & 1) { sCur[sb] += v; cur[b] += v; cat.cur += v; med[b * 3] += t; med[b * 3 + 1] += r; med[b * 3 + 2] += p; }
    if (bt & 2) { sYoy[sb] += v; yoy[b] += v; cat.yoy += v; }
    if (bt & 4) { sPrev[sb] += v; prev[b] += v; cat.prev += v; }
  }
  const covered = (a, b) => a >= ds.meta.minMon && b <= ds.meta.maxMon;
  const hasYoy = win.yoy.every(([a, b]) => covered(a, b)), hasPrev = covered(win.prev[0], win.prev[1]);
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
    if (rest.length) rows.push(mk(`Others (${rest.length})`, rest.reduce((a, x) => a + x.c, 0), rest.reduce((a, x) => a + x.y, 0), rest.reduce((a, x) => a + x.p, 0), { others: true, names: rest.map(x => dicts.mb[x.b]) }));
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
    ranges: win.ranges,
    // Category investment by medium and by sub category, month by month (the dashboard groups it into years).
    history: { tv: Array.from(hTv), radio: Array.from(hRadio), press: Array.from(hPress),
      subs: ds.meta.hasSub ? dicts.sub.map((name, k) => ({ name, values: Array.from(subMon.subarray(k * nW, (k + 1) * nW)) })).filter(x => x.values.some(v => v > 0)) : [] },
    monthly: { months: Array.from({ length: nW }, (_, k) => monthKey(w0 + k)), selStart: m0 - w0, sel: Array.from({ length: nW }, (_, k) => !!(win.bits(w0 + k) & 1)), cat: Array.from(catMon) },
    hasYoy, hasPrev, total: { cur: cat.cur, yoy: hasYoy ? cat.yoy : null, prev: hasPrev ? cat.prev : null },
    brandCount: ranked.length, shown: cards.length, cards,
    hasSubs: !!ds.meta.hasSub, tables, mix, contribution, net,
  };
}

// Drill-down. The scope can combine: mb (one mother brand), mbs (a set, e.g. the folded "Others"), sub, adv, brand,
// medium (TV / Radio / Press), from + to (a month range other than the selected one), or all: true.
// Everything is returned for that slice: advertisers, brands, mother brands, sub categories and month by month by medium,
// next to the same months a year earlier, with the category total for share.
function detail(ds, f, scope = {}) {
  const { dicts, cols } = ds;
  const base = resolve(ds, f);
  const { pgId, subId } = base;
  // The period of this slice: a clicked period or month, else the dashboard's (possibly several quarters added up).
  const win = windows(periodsOf(f, scope));
  const { m0, m1, len } = win;
  const selIdx = new Map(win.months.map((m, k) => [m, k]));
  const idOf = (list, name, what) => { if (name == null || name === '') return -1; const i = list.indexOf(name); if (i < 0) throw new Error('Unknown ' + what); return i; };
  const mbId = idOf(dicts.mb, scope.mb, 'mother brand'), scSub = idOf(dicts.sub, scope.sub, 'sub category');
  const advId = idOf(dicts.adv, scope.adv, 'advertiser'), brId = idOf(dicts.brand, scope.brand, 'brand');
  const mbSet = Array.isArray(scope.mbs) ? new Set(scope.mbs.map(n => idOf(dicts.mb, n, 'mother brand'))) : null;
  const med = scope.medium ? MEDIA.indexOf(scope.medium) : -1;
  if (scope.medium && med < 0) throw new Error('Unknown medium');
  const { pg, sub, mon, mb, adv, brand, tv, radio, press } = cols;
  const group = (n) => ({ cur: new Float64Array(n), yoy: new Float64Array(n), seen: new Uint8Array(n) });
  const A = group(dicts.adv.length), B = group(dicts.brand.length), S = group(dicts.sub.length), MB = group(dicts.mb.length);
  const monthly = win.months.map(m => ({ key: monthKey(m), tv: 0, radio: 0, press: 0, yoy: 0 }));
  let cur = 0, yoy = 0, catCur = 0, catYoy = 0;
  const mediumTotals = [0, 0, 0];
  for (let i = 0, n = pg.length; i < n; i++) {
    if (pg[i] !== pgId) continue;
    if (subId >= 0 && sub[i] !== subId) continue;
    const m = mon[i];
    const bt = win.bits(m), inCur = !!(bt & 1), inYoy = !!(bt & 2);
    if (!inCur && !inYoy) continue;
    const t = med < 0 || med === 0 ? tv[i] : 0, r = med < 0 || med === 1 ? radio[i] : 0, p = med < 0 || med === 2 ? press[i] : 0, v = t + r + p;
    if (inCur) catCur += v;
    if (inYoy) catYoy += v;
    if ((mbId >= 0 && mb[i] !== mbId) || (scSub >= 0 && sub[i] !== scSub) || (advId >= 0 && adv[i] !== advId) || (brId >= 0 && brand[i] !== brId) || (mbSet && !mbSet.has(mb[i]))) continue;
    if (inCur) {
      cur += v;
      for (const [G, id] of [[A, adv[i]], [B, brand[i]], [S, sub[i]], [MB, mb[i]]]) { G.cur[id] += v; G.seen[id] = 1; }
      const row = monthly[selIdx.get(m)]; row.tv += t; row.radio += r; row.press += p;
      mediumTotals[0] += t; mediumTotals[1] += r; mediumTotals[2] += p;
    }
    if (inYoy) {
      yoy += v;
      for (const [G, id] of [[A, adv[i]], [B, brand[i]], [S, sub[i]], [MB, mb[i]]]) { G.yoy[id] += v; G.seen[id] = 1; }
      monthly[selIdx.get(m + 12)].yoy += v;
    }
  }
  const list = (G, names) => {
    const out = [];
    G.seen.forEach((s, i) => { if (s && (G.cur[i] > 0 || G.yoy[i] > 0)) out.push({ name: names[i], cur: G.cur[i], yoy: G.yoy[i], share: cur ? (G.cur[i] / cur) * 100 : 0 }); });
    return out.sort((a, b) => b.cur - a.cur);
  };
  return {
    name: scope.title || scope.mb || scope.adv || scope.brand || scope.sub || f.pg,
    cur, yoy, catCur, catYoy, months: len, from: monthKey(m0), to: monthKey(m1), periods: win.ranges.curList, medium: scope.medium || null, mediumTotals,
    mothers: list(MB, dicts.mb), advertisers: list(A, dicts.adv), brands: list(B, dicts.brand), subs: ds.meta.hasSub ? list(S, dicts.sub) : [],
    monthly,
  };
}

module.exports = { overview, options, dashboard, detail, MEDIA };
