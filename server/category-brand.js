'use strict';
// The full brand view behind a click in the Category dashboard. It reads the main spot log (so it knows channel,
// campaign, ad type and spots) and the shared Brand Map (mother brand and sub category of each brand). Spend is in
// thousand rupees, like the rest of the Category dashboard.
//
// scope can combine: mb, mbs (a set), brand, adv, sub, ch (channel), theme (campaign), medium, vt ('C' commercials,
// 'V' value additions), dur (an ad length such as '30s', TV and Radio), from + to (a month range other than the dashboard's). Medium, channel, ad type and the
// dashboard's sub category are the "context": they narrow the whole category too, so share of spend stays like for like.
// Mother brand, brand, advertiser, campaign and a scope sub category narrow only the brand being looked at.
// Value additions follow the Spot Log rules (derive.js), including its "count Tag as a commercial" tick box.

const D = require('./derive');
const { guessMother, clean } = require('./brand-derive');
const { excludedThemes } = require('./compute');
const { periodsOf, windows } = require('./periods');

const MONTHS = D.MONTHS, MED = D.MEDIA;
const keyToMon = k => { const [y, m] = String(k).split('-').map(Number); return y * 12 + m - 1; };
const monthKey = i => `${Math.floor(i / 12)}-${String((i % 12) + 1).padStart(2, '0')}`;
const mk = () => ({ s: [0, 0, 0], n: [0, 0, 0], c: [0, 0], cn: [0, 0] });
function add(a, fl, v, isC, w) {
  if (w === undefined) w = 1;
  if (fl & 1) { a.s[0] += v; a.n[0] += w; if (isC) { a.c[0] += v; a.cn[0] += w; } }
  if (fl & 2) { a.s[1] += v; a.n[1] += w; if (isC) { a.c[1] += v; a.cn[1] += w; } }
  if (fl & 4) { a.s[2] += v; a.n[2] += w; }
}
const get = (map, key) => { let a = map.get(key); if (!a) { a = mk(); map.set(key, a); } return a; };
const arr = (map, key, len) => { let a = map.get(key); if (!a) { a = new Float64Array(len); map.set(key, a); } return a; };

function brandView(ds, lookup, f, scope, opts) {
  scope = scope || {};
  opts = opts || {};
  const { dicts, cols } = ds;
  if (!dicts.product || !cols.product) throw new Error('This data file was loaded before brands were read. Please load it again.');
  const pgId = dicts.pg.indexOf(f.pg);
  if (pgId < 0) throw new Error('Unknown product group');
  // The period may be several runs of months added up (for example Q1 and Q3); k is a month's place among the selected ones.
  const win = windows(periodsOf(f, scope));
  const { m0, m1, len, lo } = win, hi = m1;
  const flag = win.bits;
  const kOf = new Int32Array(m1 - lo + 1).fill(-1);
  win.months.forEach((m, k) => { kOf[m - lo] = k; });

  // Mother brand and sub category of each brand (product) in this product group.
  const nProd = dicts.product.length;
  const mbNames = [], mbIdx = new Map(), subNames = [], subIdx = new Map();
  const prodMb = new Int32Array(nProd), prodSub = new Int32Array(nProd);
  const idOf = (names, map, v) => { const k = v.toLowerCase(); let i = map.get(k); if (i === undefined) { i = names.length; names.push(v); map.set(k, i); } return i; };
  for (let p = 0; p < nProd; p++) {
    const brand = dicts.product[p], found = lookup ? lookup(f.pg, brand) : null;
    prodMb[p] = idOf(mbNames, mbIdx, clean(found && found.mother) || guessMother(brand, []));
    prodSub[p] = idOf(subNames, subIdx, clean(found && found.sub) || '(none)');
  }
  const find = (map, v, what) => { if (v == null || v === '') return -1; const i = map.get(String(v).toLowerCase()); if (i === undefined) throw new Error('Unknown ' + what); return i; };
  const sMb = find(mbIdx, scope.mb, 'mother brand');
  const mbsSet = Array.isArray(scope.mbs) ? new Set(scope.mbs.map(n => find(mbIdx, n, 'mother brand'))) : null;
  const scSub = find(subIdx, scope.sub, 'sub category'), ctxSub = find(subIdx, f.sub, 'sub category');
  const idxIn = (list, v, what) => { if (v == null || v === '') return -1; const i = list.indexOf(v); if (i < 0) throw new Error('Unknown ' + what); return i; };
  const sBrand = idxIn(dicts.product, scope.brand, 'brand'), sAdv = idxIn(dicts.adv, scope.adv, 'advertiser');
  const sCh = idxIn(dicts.channel, scope.ch, 'channel'), sTheme = idxIn(dicts.theme, scope.theme, 'campaign');
  const sMed = scope.medium ? MED.indexOf(scope.medium) : -1;
  if (scope.medium && sMed < 0) throw new Error('Unknown medium');
  const sVt = scope.vt === 'C' ? 1 : scope.vt === 'V' ? 2 : 0;
  const sDur = scope.dur ? D.DUR_BUCKETS.indexOf(scope.dur) : -1;
  if (scope.dur && sDur < 0) throw new Error('Unknown ad length');
  const tag = !!opts.tagCommercial;
  const excluded = excludedThemes(ds, tag);
  const mine = new Uint8Array(dicts.adv.length);
  for (const n of f.mine || []) { const i = dicts.adv.indexOf(n); if (i >= 0) mine[i] = 1; }

  // The level of the thing being looked at decides what the first section lists and who it is compared with.
  const level = sBrand >= 0 ? 'brand' : sMb >= 0 ? 'mb' : sAdv >= 0 ? 'adv' : 'category';
  const entKind = level === 'brand' ? 'brand' : level === 'adv' ? 'adv' : 'mb';
  const childKind = level === 'brand' ? null : (level === 'mb' || level === 'adv') ? 'brand' : 'mb';
  const entId = level === 'brand' ? sBrand : level === 'mb' ? sMb : level === 'adv' ? sAdv : -1;
  const nCh = dicts.channel.length, nTheme = dicts.theme.length;

  const num = mk(), cat = mk();
  const ent = new Map(), entMonthly = new Map(), mineEnt = new Set();
  const mbEnt = new Map(), mineMb = new Set(), themeBrand = new Map(); // every mother brand in the context (quick-jump buttons); brands behind each campaign
  const NB = D.DUR_BUCKETS.length, durRaw = cols.durRaw || null;
  const durB = { counts: new Array(NB).fill(0), sum: 0, n: 0 }, durC = { counts: new Array(NB).fill(0), sum: 0, n: 0 };
  const catMonthly = new Float64Array(len), catMed = [mk(), mk(), mk()], catVt = [0, 0], catByCh = new Map();
  const children = new Map(), childMonthly = new Map(), childCh = new Map(), mineChild = new Set();
  const medAcc = [mk(), mk(), mk()], byCh = new Map(), byAdv = new Map(), byTheme = new Map();
  const mCur = new Float64Array(len), mN = new Float64Array(len), mYoy = new Float64Array(len);
  const mC = new Float64Array(len), mV = new Float64Array(len), mCn = new Float64Array(len), mVn = new Float64Array(len);
  let numMine = false;

  const { pg, adv, ch, theme, mon, cost, product } = cols;
  const chMed = dicts.channelMedium;
  // A shared dashboard's records stand for several spots (cols.n) and for several timed spots (cols.ns); the full file is one record per spot.
  const wN = cols.n || null, wS = cols.ns || null;
  for (let i = 0, n = pg.length; i < n; i++) {
    if (pg[i] !== pgId) continue;
    const m = mon[i];
    if (m < lo || m > hi) continue;
    const fl = flag(m);
    if (!fl) continue;
    const p = product[i];
    if (ctxSub >= 0 && prodSub[p] !== ctxSub) continue;
    const c = ch[i], md = chMed[c];
    if (sMed >= 0 && md !== sMed) continue;
    if (sCh >= 0 && c !== sCh) continue;
    const th = theme[i], isC = excluded[th] !== 1;
    const raw = durRaw ? durRaw[i] : NaN, bucket = durRaw && md < 2 ? D.durBucketOf(raw, !isC) : 255;
    if (sDur >= 0 && bucket !== sDur) continue;
    if (sVt === 1 && !isC) continue;
    if (sVt === 2 && isC) continue;
    const v = cost[i] / 1000, a = adv[i], mb = prodMb[p];
    const w = wN ? wN[i] : 1, wd = wS ? wS[i] : 1;
    // Context: the category the brand is compared with.
    add(cat, fl, v, isC, w);
    const ek = level === 'brand' ? p : level === 'adv' ? a : mb;
    add(get(ent, ek), fl, v, isC, w);
    add(get(mbEnt, mb), fl, v, isC, w);
    if ((fl & 1) && mine[a]) mineMb.add(mb);
    if (fl & 1) {
      const k = kOf[m - lo];
      catMonthly[k] += v; add(catMed[md], 1, v, isC, w); catVt[isC ? 0 : 1] += v; add(get(catByCh, c), 1, v, isC, w);
      arr(entMonthly, ek, len)[k] += v;
      if (mine[a]) mineEnt.add(ek);
      if (bucket < NB) { durC.counts[bucket] += wd; const sec = D.durSecondsOf(raw, !isC); if (sec > 0) { durC.sum += sec * wd; durC.n += wd; } }
    }
    // The brand being looked at.
    if (sMb >= 0 && mb !== sMb) continue;
    if (mbsSet && !mbsSet.has(mb)) continue;
    if (sBrand >= 0 && p !== sBrand) continue;
    if (sAdv >= 0 && a !== sAdv) continue;
    if (sTheme >= 0 && th !== sTheme) continue;
    if (scSub >= 0 && prodSub[p] !== scSub) continue;
    add(num, fl, v, isC, w);
    if (mine[a]) numMine = true;
    add(medAcc[md], fl, v, isC, w);
    add(get(byCh, c), fl, v, isC, w);
    add(get(byAdv, a), fl, v, isC, w);
    add(get(byTheme, a * nTheme + th), fl, v, isC, w);
    if (fl & 1) { const tk = a * nTheme + th; let tb = themeBrand.get(tk); if (!tb) { tb = new Map(); themeBrand.set(tk, tb); } tb.set(p, (tb.get(p) || 0) + v); }
    if (childKind) {
      const ck = childKind === 'mb' ? mb : p;
      add(get(children, ck), fl, v, isC, w);
      if (mine[a]) mineChild.add(ck);
      if (fl & 1) { arr(childMonthly, ck, len)[kOf[m - lo]] += v; childCh.set(ck * nCh + c, (childCh.get(ck * nCh + c) || 0) + v); }
    }
    if ((fl & 1) && bucket < NB) { durB.counts[bucket] += wd; const sec = D.durSecondsOf(raw, !isC); if (sec > 0) { durB.sum += sec * wd; durB.n += wd; } }
    if (fl & 1) {
      const k = kOf[m - lo];
      mCur[k] += v; mN[k] += w;
      if (isC) { mC[k] += v; mCn[k] += w; } else { mV[k] += v; mVn[k] += w; }
    }
    if (fl & 2) mYoy[kOf[m + 12 - lo]] += v;
  }

  const pct = (a, b) => (b > 0 ? (a / b) * 100 : null);
  const chName = c => dicts.channelName[c];
  const entName = k => (entKind === 'brand' ? dicts.product[k] : entKind === 'adv' ? dicts.adv[k] : mbNames[k]);

  // Who is compared with whom (same level), ranked on this period.
  const ranked = [...ent].filter(([, a]) => a.s[0] > 0 || a.s[1] > 0).sort((x, y) => y[1].s[0] - x[1].s[0]);
  const rankIdx = entId >= 0 ? ranked.findIndex(([k]) => k === entId) : -1;
  const ranking = ranked.slice(0, 6).map(([k, a]) => ({ key: entName(k), cur: a.s[0], yoy: a.s[1], share: pct(a.s[0], cat.s[0]), us: mineEnt.has(k), self: k === entId }));
  if (rankIdx >= 6) { const [k, a] = ranked[rankIdx]; ranking.push({ key: entName(k), cur: a.s[0], yoy: a.s[1], share: pct(a.s[0], cat.s[0]), us: mineEnt.has(k), self: true, rank: rankIdx + 1 }); }
  // Other brands of the same mother brand (shown as chips when one brand is open).
  const siblings = level === 'brand' ? ranked.filter(([k]) => prodMb[k] === prodMb[sBrand]).map(([k, a]) => ({ name: dicts.product[k], cur: a.s[0], self: k === sBrand })) : [];
  const sosOf = (vals, tot) => Array.from(vals, (v, k) => (tot[k] > 0 ? (v / tot[k]) * 100 : null));
  const competitors = ranked.filter(([k]) => k !== entId).slice(0, 3).map(([k]) => ({ name: entName(k), us: mineEnt.has(k), values: sosOf(entMonthly.get(k) || new Float64Array(len), catMonthly) }));

  const split = a => ({ C: a.c[0], V: a.s[0] - a.c[0], Cn: a.cn[0], Vn: a.n[0] - a.cn[0], Cy: a.c[1], Vy: a.s[1] - a.c[1], Cny: a.cn[1], Vny: a.n[1] - a.cn[1] });
  const label = k => ({ key: monthKey(k), label: MONTHS[k % 12], year: Math.floor(k / 12) });

  // The first section: the mother brands (or brands) inside what is being looked at.
  const childRows = [...children].filter(([, a]) => a.s[0] > 0 || a.s[1] > 0).map(([k, a]) => {
    let top = null;
    for (let c = 0; c < nCh; c++) { const v = childCh.get(k * nCh + c); if (v && (!top || v > top.v)) top = { c, v }; }
    const sp = split(a), mm = childMonthly.get(k) || new Float64Array(len);
    return {
      name: childKind === 'mb' ? mbNames[k] : dicts.product[k], sub: childKind === 'brand' ? (subNames[prodSub[k]] === '(none)' ? '' : subNames[prodSub[k]]) : '',
      cur: a.s[0], yoy: a.s[1], prev: a.s[2], share: pct(a.s[0], num.s[0]), ...sp, spots: a.n[0], monthly: Array.from(mm),
      topChannel: top ? { name: chName(top.c), share: pct(top.v, a.s[0]) } : null, us: mineChild.has(k),
    };
  }).sort((x, y) => y.cur - x.cur);

  const channels = [...byCh].filter(([, a]) => a.s[0] > 0 || a.s[1] > 0).map(([c, a]) => ({
    key: dicts.channel[c], name: chName(c), medium: MED[chMed[c]], cur: a.s[0], yoy: a.s[1], prev: a.s[2], share: pct(a.s[0], num.s[0]), ...split(a),
    sosHere: pct(a.s[0], (catByCh.get(c) || mk()).s[0]), spots: a.n[0],
    catShare: pct((catByCh.get(c) || mk()).s[0], cat.s[0]),
  })).sort((x, y) => y.cur - x.cur);
  const advertisers = [...byAdv].filter(([, a]) => a.s[0] > 0 || a.s[1] > 0).map(([a2, a]) => ({
    name: dicts.adv[a2], us: !!mine[a2], cur: a.s[0], yoy: a.s[1], share: pct(a.s[0], num.s[0]), ...split(a), spots: a.n[0],
  })).sort((x, y) => y.cur - x.cur);
  const campaigns = { C: [], V: [] };
  for (const [key, a] of byTheme) {
    if (!(a.s[0] > 0)) continue;
    const t = key % nTheme, ad = (key - t) / nTheme;
    const tb = [...(themeBrand.get(key) || [])].sort((x, y) => y[1] - x[1]);
    (excluded[t] === 1 ? campaigns.V : campaigns.C).push({
      name: dicts.theme[t], advertiser: dicts.adv[ad], us: !!mine[ad], cur: a.s[0], yoy: a.s[1], share: pct(a.s[0], num.s[0]), spots: a.n[0],
      brand: tb.length ? dicts.product[tb[0][0]] : '', brands: tb.length,
    });
  }
  campaigns.C.sort((x, y) => y.cur - x.cur); campaigns.V.sort((x, y) => y.cur - x.cur);
  const totC = { C: campaigns.C.length, V: campaigns.V.length };
  campaigns.C = campaigns.C.slice(0, 50); campaigns.V = campaigns.V.slice(0, 50);

  const monthsList = Array.from({ length: len }, (_, k) => ({
    ...label(win.months[k]), spend: mCur[k], spots: mN[k], yoy: mYoy[k], sos: pct(mCur[k], catMonthly[k]), C: mC[k], V: mV[k], Cn: mCn[k], Vn: mVn[k], cat: catMonthly[k],
  }));

  // Name and the parts that make up the scope (for the trail and the chips).
  const parts = [];
  if (scope.mbs) parts.push({ k: 'mbs', v: `${scope.mbs.length} mother brands` });
  if (sMb >= 0) parts.push({ k: 'mb', v: mbNames[sMb] });
  if (sBrand >= 0) parts.push({ k: 'brand', v: dicts.product[sBrand] });
  if (sAdv >= 0) parts.push({ k: 'adv', v: dicts.adv[sAdv] });
  if (scSub >= 0) parts.push({ k: 'sub', v: subNames[scSub] });
  if (sCh >= 0) parts.push({ k: 'ch', v: chName(sCh) });
  if (sTheme >= 0) parts.push({ k: 'theme', v: dicts.theme[sTheme] });
  if (sMed >= 0) parts.push({ k: 'medium', v: MED[sMed] });
  if (sVt) parts.push({ k: 'vt', v: sVt === 1 ? 'Commercials' : 'Value additions' });
  if (sDur >= 0) parts.push({ k: 'dur', v: scope.dur + ' ads' });
  // The name on top is the thing you drilled into (brand, mother brand, advertiser, sub category), never a channel, campaign, medium or length: those are shown as filters.
  const mainKey = sBrand >= 0 ? 'brand' : sMb >= 0 ? 'mb' : sAdv >= 0 ? 'adv' : scSub >= 0 ? 'sub' : mbsSet ? 'mbs' : null;
  const main = mainKey ? parts.find(p => p.k === mainKey) : null;
  const kindNames = { theme: 'Campaign', ch: 'Channel', brand: 'Brand', adv: 'Advertiser', mb: 'Mother brand', sub: 'Sub category', mbs: 'Group' };

  const topCh = channels[0] || null;
  return {
    filters: { pg: f.pg, sub: f.sub || '' }, tagCommercial: tag, level, entKind, childKind,
    // A shared dashboard holds mother brand and sub category only (no brand names), and campaign names only at the Full level.
    limits: { brands: !(ds.meta && ds.meta.cube), campaigns: !(ds.meta && ds.meta.cube && ds.meta.level !== 'full') },
    ranges: win.ranges, months: len,
    name: main ? main.v : f.pg, kind: main ? kindNames[main.k] : 'Category', parts, us: numMine,
    head: {
      cur: num.s[0], yoy: num.s[1], prev: num.s[2], spots: num.n[0], spotsYoy: num.n[1], spotsPrev: num.n[2],
      cat: { cur: cat.s[0], yoy: cat.s[1], prev: cat.s[2] },
      sos: { cur: pct(num.s[0], cat.s[0]), yoy: pct(num.s[1], cat.s[1]), prev: pct(num.s[2], cat.s[2]) },
      rank: rankIdx >= 0 ? rankIdx + 1 : null, rankOf: ranked.length, rankKind: entKind,
      channels: channels.length, topChannel: topCh ? { name: topCh.name, share: topCh.share } : null,
      mediums: medAcc.map(a => a.s[0]), split: split(num),
    },
    children: childRows, siblings,
    mothers: [...mbEnt].filter(([, a]) => a.s[0] > 0 || a.s[1] > 0).sort((x, y) => y[1].s[0] - x[1].s[0]).map(([k, a]) => ({ name: mbNames[k], cur: a.s[0], share: pct(a.s[0], cat.s[0]), us: mineMb.has(k), self: k === sMb })),
    adType: {
      cur: split(num), monthly: monthsList.map(m => ({ key: m.key, label: m.label, year: m.year, C: m.C, V: m.V, Cn: m.Cn, Vn: m.Vn })),
      byMedium: medAcc.map((a, k) => ({ medium: MED[k], ...split(a) })).filter(x => x.C + x.V > 0 || x.Cy + x.Vy > 0),
      counts: totC,
    },
    sos: {
      self: sosOf(mCur, catMonthly), competitors, ranking,
      byMedium: medAcc.map((a, k) => ({ medium: MED[k], share: pct(a.s[0], catMed[k].s[0]) })).filter(x => x.share != null),
      byAdType: { C: pct(split(num).C, catVt[0]), V: pct(split(num).V, catVt[1]) },
    },
    mediums: medAcc.map((a, k) => ({
      medium: MED[k], cur: a.s[0], yoy: a.s[1], prev: a.s[2], share: pct(a.s[0], num.s[0]), ...split(a), spots: a.n[0],
      sos: pct(a.s[0], catMed[k].s[0]), catShare: pct(catMed[k].s[0], cat.s[0]), catCur: catMed[k].s[0],
    })),
    duration: {
      buckets: D.DUR_BUCKETS, hasLengths: !!durRaw && !(ds.meta && ds.meta.cube && ds.meta.level !== 'full'),
      brand: { counts: durB.counts, acd: durB.n ? durB.sum / durB.n : null }, cat: { counts: durC.counts, acd: durC.n ? durC.sum / durC.n : null },
    },
    channels, advertisers, campaigns, monthsList,
  };
}

// Channel preference by brands: for each mother brand shown (and the whole category), how its spend in the selected
// period is spread across channels. Channels are the biggest ones of the category first; the small rest is one slice.
// opts.brands: the mother brands to show (in that order); opts.medium: 'TV' | 'Radio' | 'Press' or '' for all.
function channelPreference(ds, lookup, f, opts) {
  opts = opts || {};
  const { dicts, cols } = ds;
  if (!dicts.product || !cols.product) throw new Error('This data file was loaded before brands were read. Please load it again.');
  const pgId = dicts.pg.indexOf(f.pg);
  if (pgId < 0) throw new Error('Unknown product group');
  const win = windows(periodsOf(f, {}));
  const nProd = dicts.product.length;
  const mbNames = [], mbIdx = new Map(), subNames = [], subIdx = new Map();
  const prodMb = new Int32Array(nProd), prodSub = new Int32Array(nProd);
  const idOf = (names, map, v) => { const k = v.toLowerCase(); let i = map.get(k); if (i === undefined) { i = names.length; names.push(v); map.set(k, i); } return i; };
  for (let p = 0; p < nProd; p++) {
    const brand = dicts.product[p], found = lookup ? lookup(f.pg, brand) : null;
    prodMb[p] = idOf(mbNames, mbIdx, clean(found && found.mother) || guessMother(brand, []));
    prodSub[p] = idOf(subNames, subIdx, clean(found && found.sub) || '(none)');
  }
  const ctxSub = f.sub ? subIdx.get(String(f.sub).toLowerCase()) : -1;
  if (f.sub && ctxSub === undefined) throw new Error('Unknown sub category');
  const med = opts.medium ? MED.indexOf(opts.medium) : -1;
  const wanted = (opts.brands || []).map(n => mbIdx.get(String(n).toLowerCase())).filter(x => x !== undefined);
  const want = new Set(wanted);
  const mine = new Uint8Array(dicts.adv.length);
  for (const n of f.mine || []) { const i = dicts.adv.indexOf(n); if (i >= 0) mine[i] = 1; }
  const nCh = dicts.channel.length, chMed = dicts.channelMedium;
  const catCh = new Float64Array(nCh), byBrand = new Map(), mineMb = new Set();
  const { pg, adv, ch, mon, cost, product } = cols;
  for (let i = 0, n = pg.length; i < n; i++) {
    if (pg[i] !== pgId) continue;
    if (!(win.bits(mon[i]) & 1)) continue;
    const p = product[i];
    if (ctxSub >= 0 && prodSub[p] !== ctxSub) continue;
    const c = ch[i];
    if (med >= 0 && chMed[c] !== med) continue;
    const v = cost[i] / 1000, mb = prodMb[p];
    catCh[c] += v;
    if (want.has(mb)) {
      let a = byBrand.get(mb); if (!a) { a = new Float64Array(nCh); byBrand.set(mb, a); }
      a[c] += v;
      if (mine[adv[i]]) mineMb.add(mb);
    }
  }
  const order = [...catCh.keys()].filter(c => catCh[c] > 0).sort((x, y) => catCh[y] - catCh[x]);
  const TOP = 9, top = order.slice(0, TOP), rest = order.slice(TOP);
  const series = top.map(c => ({ key: dicts.channel[c], name: dicts.channelName[c], medium: MED[chMed[c]] }));
  if (rest.length) series.push({ key: '', name: `Other channels (${rest.length})`, medium: '', other: true });
  const column = arr => {
    const values = top.map(c => arr[c]);
    if (rest.length) values.push(rest.reduce((a, c) => a + arr[c], 0));
    const total = values.reduce((a, b) => a + b, 0);
    return { total, values, shares: values.map(v => (total > 0 ? (v / total) * 100 : 0)) };
  };
  const brands = wanted.filter(mb => byBrand.has(mb)).map(mb => ({ name: mbNames[mb], us: mineMb.has(mb), ...column(byBrand.get(mb)) })).filter(b => b.total > 0);
  return { series, brands, category: column(catCh), medium: opts.medium || '', months: win.len, ranges: win.ranges };
}

module.exports = { brandView, channelPreference };
