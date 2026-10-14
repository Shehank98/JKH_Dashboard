'use strict';
// Aggregations for the dashboard. One pass over the rows per request, so filtering 400k+ rows stays fast.

const D = require('./derive');

const toDay = iso => Math.round(Date.parse(iso + 'T00:00:00Z') / 86400000);
const toIso = day => new Date(day * 86400000).toISOString().slice(0, 10);
const monthKey = mon => `${Math.floor(mon / 12)}-${String((mon % 12) + 1).padStart(2, '0')}`;

// Everything the filter drawer needs when nothing is selected yet.
function overview(ds) {
  const { pg, cost } = ds.cols;
  const spend = new Float64Array(ds.dicts.pg.length);
  for (let i = 0; i < pg.length; i++) spend[pg[i]] += cost[i];
  const groups = ds.dicts.pg.map((name, i) => ({ name, spend: spend[i] })).sort((a, b) => b.spend - a.spend);
  return {
    meta: ds.meta,
    minDate: toIso(ds.meta.minDay), maxDate: toIso(ds.meta.maxDay),
    productGroups: groups, dayparts: D.DAYPARTS.map((name, i) => ({ name, time: D.DAYPART_TIMES[i] })),
  };
}

// Advertisers and channels active inside one product group, ordered by spend.
function groupOptions(ds, pgName) {
  const pgId = ds.dicts.pg.indexOf(pgName);
  if (pgId < 0) return { advertisers: [], channels: [] };
  const { pg, adv, ch, cost } = ds.cols;
  const advSpend = new Float64Array(ds.dicts.adv.length);
  const chSpend = new Float64Array(ds.dicts.channel.length);
  const advSeen = new Uint8Array(ds.dicts.adv.length);
  const chSeen = new Uint8Array(ds.dicts.channel.length);
  const prodSpend = ds.dicts.productMother ? new Float64Array(ds.dicts.product.length) : null; // data cubes: mother brand + sub category
  for (let i = 0; i < pg.length; i++) {
    if (pg[i] !== pgId) continue;
    advSpend[adv[i]] += cost[i]; advSeen[adv[i]] = 1;
    chSpend[ch[i]] += cost[i]; chSeen[ch[i]] = 1;
    if (prodSpend) prodSpend[ds.cols.product[i]] += cost[i];
  }
  const advertisers = [];
  advSeen.forEach((s, i) => { if (s) advertisers.push({ name: ds.dicts.adv[i], spend: advSpend[i] }); });
  advertisers.sort((a, b) => b.spend - a.spend);
  const channels = [];
  chSeen.forEach((s, i) => {
    if (s) channels.push({ name: ds.dicts.channel[i], medium: D.MEDIA[ds.dicts.channelMedium[i]], spend: chSpend[i] });
  });
  channels.sort((a, b) => a.medium.localeCompare(b.medium) || b.spend - a.spend);
  const out = { advertisers, channels };
  if (prodSpend) {
    out.brands = [];
    prodSpend.forEach((v, i) => { if (v > 0) out.brands.push({ mother: ds.dicts.productMother[i], sub: ds.dicts.productSub[i] || '', spend: v }); });
    out.brands.sort((x, y) => y.spend - x.spend);
  }
  return out;
}

// Old saved datasets (no raw Dur) store the previous buckets 5/15/20/30/30+; map them onto 5/10/15/20/30/30+.
const LEGACY_DUR = [0, 2, 3, 4, 5];
const legacyDur = i => (i < LEGACY_DUR.length ? LEGACY_DUR[i] : 255);

// Theme ids that are sponsorship or filler items, cached per dataset and per "Tag counts as commercial" choice.
const excludedCache = new WeakMap();
function excludedThemes(ds, tagCommercial) {
  let byFlag = excludedCache.get(ds);
  if (!byFlag) { byFlag = {}; excludedCache.set(ds, byFlag); }
  const key = tagCommercial ? 'tagC' : 'tagVA';
  if (!byFlag[key]) {
    const set = new Uint8Array(ds.dicts.theme.length);
    ds.dicts.theme.forEach((t, i) => { if (D.isExcludedTheme(t, { tagCommercial })) set[i] = 1; });
    byFlag[key] = set;
  }
  return byFlag[key];
}

// Shared filter resolution for the dashboard and the detail view.
function resolve(ds, f) {
  const { dicts } = ds;
  const pgId = dicts.pg.indexOf(f.pg);
  if (pgId < 0) throw new Error('Unknown product group');
  let from = toDay(f.from), to = toDay(f.to);
  if (!(to >= from)) throw new Error('Invalid date range');
  let len = to - from + 1;
  // A shared data cube holds whole months only, so the range snaps to whole months and the previous period is the
  // same number of months just before it.
  let pFrom0 = null;
  if (ds.meta.cube) {
    const a = new Date(from * 86400000), b = new Date(to * 86400000);
    const ma = a.getUTCFullYear() * 12 + a.getUTCMonth(), mb = b.getUTCFullYear() * 12 + b.getUTCMonth();
    const first = m => Math.round(Date.UTC(Math.floor(m / 12), m % 12, 1) / 86400000);
    from = first(ma); to = first(mb + 1) - 1; len = to - from + 1;
    pFrom0 = first(ma - (mb - ma + 1));
  }
  // Mother brand and sub category filters (data cubes only): which "product" entries pass.
  let prodMask = null;
  if ((f.mb || f.sub) && dicts.productMother) {
    prodMask = new Uint8Array(dicts.product.length);
    dicts.product.forEach((_, i) => { prodMask[i] = (!f.mb || dicts.productMother[i] === f.mb) && (!f.sub || (dicts.productSub[i] || '') === f.sub) ? 1 : 0; });
  }
  // role: 1 = mine, 2 = competitor. Mine wins if a name is in both lists.
  const role = new Uint8Array(dicts.adv.length);
  const compIds = [];
  for (const n of f.comps || []) { const i = dicts.adv.indexOf(n); if (i >= 0) { role[i] = 2; compIds.push(i); } }
  const mineIds = [];
  for (const n of f.mine || []) { const i = dicts.adv.indexOf(n); if (i >= 0) { role[i] = 1; mineIds.push(i); } }
  return {
    pgId, from, to, pFrom: pFrom0 != null ? pFrom0 : from - len, pTo: from - 1, prodMask,
    mediumId: D.MEDIA.indexOf(f.medium),
    chId: f.channel ? dicts.channel.indexOf(f.channel) : -1,
    dpId: f.daypart ? D.DAYPARTS.indexOf(f.daypart) : -1,
    role, mineIds, comps: compIds.filter(i => role[i] === 2),
    // Ad type: 0 = all, 1 = commercials only, 2 = sponsorship items only.
    adType: f.adType === 'Sponsorship' ? 2 : f.adType === 'Commercial' ? 1 : 0,
  };
}

// Calendar year y is Jan-Dec y; financial year y is 1 Apr y to 31 Mar y+1.
const yearBounds = (y, fy) => (fy ? { from: `${y}-04-01`, to: `${y + 1}-03-31` } : { from: `${y}-01-01`, to: `${y}-12-31` });
const yearLabel = (y, fy) => (fy ? `FY ${String(y).slice(2)}/${String(y + 1).slice(2)}` : String(y));

function dashboard(ds, f) {
  const { dicts, cols } = ds;
  const nAdv = dicts.adv.length, nCh = dicts.channel.length, nTheme = dicts.theme.length;
  const { pgId, from, to, pFrom, pTo, mediumId, chId, dpId, role, mineIds, comps, adType, prodMask } = resolve(ds, f);
  const excluded = excludedThemes(ds, !!f.tagCommercial);
  // Month Drill Down never picks a sponsorship item as the lead campaign, except when only sponsorships are shown.
  const skipCampaign = adType === 2 ? null : excluded;

  const mon0 = new Date(from * 86400000), mon1 = new Date(to * 86400000);
  const m0 = mon0.getUTCFullYear() * 12 + mon0.getUTCMonth();
  const nM = mon1.getUTCFullYear() * 12 + mon1.getUTCMonth() - m0 + 1;

  const advSpend = new Float64Array(nAdv), advSpots = new Float64Array(nAdv);
  const monAdv = new Float64Array(nM * nAdv);
  const monCat = new Float64Array(nM), monMine = new Float64Array(nM);
  const medCat = [0, 0, 0], medMine = [0, 0, 0];
  const monMedCat = new Float64Array(nM * 3), monMedMine = new Float64Array(nM * 3);
  const chCat = new Float64Array(nM * nCh), chMine = new Float64Array(nM * nCh), chTot = new Float64Array(nCh);
  const NB = D.DUR_BUCKETS.length;
  // Duration counts and ACD sums per medium (0 = TV, 1 = Radio); ACD = sum of raw Dur / ads.
  const durM = [0, 1].map(() => ({
    adv: new Float64Array(nAdv * NB), mine: new Array(NB).fill(0), cat: new Array(NB).fill(0),
    acdSum: new Float64Array(nAdv), acdN: new Float64Array(nAdv), mineSum: 0, mineN: 0, catSum: 0, catN: 0,
  }));
  const themeAgg = new Map(); // key (month, advertiser, theme) -> [spend, spots]
  let catSpend = 0, catSpots = 0, mineSpend = 0, mineSpots = 0, catPrev = 0, minePrev = 0;
  let prevRows = 0;

  const { pg, adv, ch, theme, day, mon, dp, dur, cost } = cols;
  const durRaw = cols.durRaw || null; // missing on datasets saved before raw Dur was stored
  const chMed = dicts.channelMedium;

  const wN = cols.n || null, wS = cols.ns || null, prodCol = cols.product;
  for (let i = 0, n = pg.length; i < n; i++) {
    if (pg[i] !== pgId) continue;
    if (prodMask && !prodMask[prodCol[i]]) continue;
    const d = day[i];
    if (d < pFrom || d > to) continue;
    const c = ch[i], md = chMed[c];
    if (mediumId >= 0 && md !== mediumId) continue;
    if (chId >= 0 && c !== chId) continue;
    if (dpId >= 0 && dp[i] !== dpId) continue;
    if (adType && (excluded[theme[i]] ? 2 : 1) !== adType) continue;
    const a = adv[i], v = cost[i], isMine = role[a] === 1, w = wN ? wN[i] : 1;

    if (d < from) {
      prevRows++;
      catPrev += v;
      if (isMine) minePrev += v;
      continue;
    }

    const mi = mon[i] - m0;
    catSpend += v; catSpots += w;
    advSpend[a] += v; advSpots[a] += w;
    monAdv[mi * nAdv + a] += v;
    monCat[mi] += v;
    medCat[md] += v;
    monMedCat[mi * 3 + md] += v;
    chCat[mi * nCh + c] += v; chTot[c] += v;
    const sponsor = excluded[theme[i]] === 1;
    const raw = durRaw ? D.durSecondsOf(durRaw[i], sponsor) : NaN;
    const du = durRaw ? D.durBucketOf(durRaw[i], sponsor) : (sponsor ? 0 : legacyDur(dur[i]));
    if (md < 2 && du < NB) {
      const M = durM[md];
      M.adv[a * NB + du] += w; M.cat[du] += w;
      if (isMine) M.mine[du] += w;
      if (raw > 0) {
        const ws = wS ? wS[i] : 1; // spots that have a length (a data cube keeps their total seconds as raw * ws)
        M.acdSum[a] += raw * ws; M.acdN[a] += ws; M.catSum += raw * ws; M.catN += ws;
        if (isMine) { M.mineSum += raw * ws; M.mineN += ws; }
      }
    }
    if (isMine) {
      mineSpend += v; mineSpots += w;
      monMine[mi] += v;
      medMine[md] += v;
      monMedMine[mi * 3 + md] += v;
      chMine[mi * nCh + c] += v;
    }
    if (skipCampaign && skipCampaign[theme[i]]) continue;
    const key = (mi * nAdv + a) * nTheme + theme[i];
    const t = themeAgg.get(key);
    if (t) { t[0] += v; t[1] += w; } else themeAgg.set(key, [v, w]);
  }

  // Rank: my advertisers count as one entity against every other advertiser with spend.
  let others = 0, above = 0, activeAdv = 0;
  for (let a = 0; a < nAdv; a++) {
    if (advSpend[a] <= 0) continue;
    activeAdv++;
    if (role[a] === 1) continue;
    others++;
    if (advSpend[a] > mineSpend) above++;
  }

  const mineLabel = mineIds.length === 1 ? dicts.adv[mineIds[0]] : mineIds.length ? `My advertisers (${mineIds.length})` : 'My advertiser';
  const months = [];
  for (let k = 0; k < nM; k++) months.push({ key: monthKey(m0 + k), label: D.MONTHS[(m0 + k) % 12], year: Math.floor((m0 + k) / 12) });

  // Monthly trend.
  const compSorted = comps.slice().sort((x, y) => advSpend[y] - advSpend[x]);
  const trend = {
    mine: Array.from(monMine),
    categoryTotal: Array.from(monCat),
    // Spend per month split by medium [TV, Radio, Press], for the stacked YOY / quarter / half-year bars.
    mediumCat: months.map((_, k) => [monMedCat[k * 3], monMedCat[k * 3 + 1], monMedCat[k * 3 + 2]]),
    mediumMine: months.map((_, k) => [monMedMine[k * 3], monMedMine[k * 3 + 1], monMedMine[k * 3 + 2]]),
    competitors: compSorted.map(a => ({ name: dicts.adv[a], values: months.map((_, k) => monAdv[k * nAdv + a]) })),
    categoryAvg: months.map((_, k) => {
      let active = 0;
      for (let a = 0; a < nAdv; a++) if (monAdv[k * nAdv + a] > 0) active++;
      return active ? monCat[k] / active : 0;
    }),
  };

  // Month drill down: leader and runner up across the whole category, mine treated as one entity.
  const drill = months.map((m, k) => {
    const ents = [];
    if (monMine[k] > 0) ents.push({ id: -1, name: mineLabel, spend: monMine[k], mine: true });
    for (let a = 0; a < nAdv; a++) {
      if (role[a] === 1) continue;
      const v = monAdv[k * nAdv + a];
      if (v > 0) ents.push({ id: a, name: dicts.adv[a], spend: v, mine: false });
    }
    ents.sort((x, y) => y.spend - x.spend);
    return { key: m.key, label: m.label, year: m.year, category: monCat[k], mineSpend: monMine[k], leader: ents[0] || null, runnerUp: ents[1] || null };
  });
  const leadThemes = drill.map(() => new Map());
  for (const [key, val] of themeAgg) {
    const t = key % nTheme, rest = (key - t) / nTheme, a = rest % nAdv, k = (rest - a) / nAdv;
    const L = drill[k].leader;
    if (!L) continue;
    if (L.id === -1 ? role[a] !== 1 : L.id !== a) continue;
    const ck = a * nTheme + t;
    const agg = leadThemes[k].get(ck);
    if (agg) { agg[0] += val[0]; agg[1] += val[1]; } else leadThemes[k].set(ck, [val[0], val[1]]);
  }
  drill.forEach((m, k) => {
    let best = null;
    for (const [ck, v] of leadThemes[k]) if (!best || v[0] > best[1]) best = [ck, v[0], v[1]];
    m.campaign = best ? {
      name: dicts.theme[best[0] % nTheme], advertiser: dicts.adv[Math.floor(best[0] / nTheme)], spend: best[1], spots: best[2],
    } : null;
    if (m.leader) delete m.leader.id;
    if (m.runnerUp) delete m.runnerUp.id;
  });

  // Channel mix: every channel in the medium, ordered by category spend in the period.
  const channelMix = medium => {
    const ids = [];
    for (let c = 0; c < nCh; c++) if (chMed[c] === medium && chTot[c] > 0) ids.push(c);
    ids.sort((x, y) => chTot[y] - chTot[x]);
    const series = src => months.map((_, k) => {
      let total = 0;
      for (const c of ids) total += src[k * nCh + c];
      if (total <= 0) return null;
      return ids.map(c => (src[k * nCh + c] / total) * 100);
    });
    // Whole-period share of the medium's spend per channel (same channel order), for the paired-bar view.
    const mineSpendCh = ids.map(c => { let v = 0; for (let k = 0; k < nM; k++) v += chMine[k * nCh + c]; return v; });
    const catSum = ids.reduce((s2, c) => s2 + chTot[c], 0), mineSum = mineSpendCh.reduce((s2, v) => s2 + v, 0);
    const total = {
      category: ids.map(c => (catSum ? (chTot[c] / catSum) * 100 : 0)),
      mine: mineSum ? mineSpendCh.map(v => (v / mineSum) * 100) : null,
    };
    return { channels: ids.map(c => dicts.channelName[c]), keys: ids.map(c => dicts.channel[c]), category: series(chCat), mine: series(chMine), total };
  };

  // Duration mix, share of TV and Radio spots.
  const pct = arr => { const s = arr.reduce((x, y) => x + y, 0); return s ? arr.map(x => (x / s) * 100) : null; };
  const acd = (sum, n) => (durRaw && n ? sum / n : null);
  const durRow = (row, counts, acdVal) => ({ ...row, split: pct(counts), counts, ads: counts.reduce((x, y) => x + y, 0), acd: acdVal });
  // Rows for a set of media: [0] = TV, [1] = Radio, [0, 1] = both.
  const durationRowsFor = ms => {
    const add = f => ms.reduce((s, m) => s + f(durM[m]), 0);
    const sumArr = f => Array.from({ length: NB }, (_, j) => ms.reduce((s, m) => s + f(durM[m])[j], 0));
    return [durRow({ name: mineLabel, mine: true }, sumArr(M => M.mine), acd(add(M => M.mineSum), add(M => M.mineN)))]
      .concat(compSorted.map(a => durRow({ name: dicts.adv[a], mine: false },
        sumArr(M => M.adv.subarray(a * NB, a * NB + NB)), acd(add(M => M.acdSum[a]), add(M => M.acdN[a])))))
      .concat([durRow({ name: 'Category', avg: true }, sumArr(M => M.cat), acd(add(M => M.catSum), add(M => M.catN)))]);
  };
  const durationRows = durationRowsFor([0, 1]);

  // Share of spend table: mine (as one entity), each competitor, everyone else, with SOS by month.
  const entityRank = spend => {
    let above = mineSpend > spend ? 1 : 0;
    for (let a = 0; a < nAdv; a++) if (role[a] !== 1 && advSpend[a] > spend) above++;
    return above + 1;
  };
  const sosRow = (row, spend, spots, byMonth) => ({
    ...row, spend, spots,
    sos: catSpend ? (spend / catSpend) * 100 : 0,
    sov: catSpots ? (spots / catSpots) * 100 : 0,
    avgCost: spots ? spend / spots : 0,
    monthly: byMonth.map((v, k) => (monCat[k] ? (v / monCat[k]) * 100 : null)),
  });
  const sosRows = [];
  if (mineIds.length) sosRows.push(sosRow({ name: mineLabel, mine: true, rank: mineSpend > 0 ? above + 1 : null }, mineSpend, mineSpots, Array.from(monMine)));
  let restSpend = catSpend - mineSpend, restSpots = catSpots - mineSpots;
  const restMonthly = Array.from(monCat).map((v, k) => v - monMine[k]);
  for (const a of compSorted) {
    sosRows.push(sosRow({ name: dicts.adv[a], mine: false, rank: advSpend[a] > 0 ? entityRank(advSpend[a]) : null },
      advSpend[a], advSpots[a], months.map((_, k) => monAdv[k * nAdv + a])));
    restSpend -= advSpend[a]; restSpots -= advSpots[a];
    months.forEach((_, k) => { restMonthly[k] -= monAdv[k * nAdv + a]; });
  }
  const restCount = activeAdv - mineIds.filter(a => advSpend[a] > 0).length - compSorted.filter(a => advSpend[a] > 0).length;
  // Year by year over the whole dataset (the date range is ignored; every other filter applies).
  // Calendar years run Jan-Dec; financial years (f.yearType === 'FY') run Apr-Mar and are named by the year they start in.
  const fyMode = f.yearType === 'FY';
  const yOf = mIdx => Math.floor((mIdx - (fyMode ? 3 : 0)) / 12);
  const dMin = new Date(ds.meta.minDay * 86400000), dMax = new Date(ds.meta.maxDay * 86400000);
  const y0 = yOf(dMin.getUTCFullYear() * 12 + dMin.getUTCMonth());
  const y1 = yOf(dMax.getUTCFullYear() * 12 + dMax.getUTCMonth());
  const nY = y1 - y0 + 1;
  const yCat = new Float64Array(nY), yMine = new Float64Array(nY), yComp = compSorted.map(() => new Float64Array(nY));
  const compIndex = new Int32Array(nAdv).fill(-1);
  compSorted.forEach((a, j) => { compIndex[a] = j; });
  for (let i = 0, n = pg.length; i < n; i++) {
    if (pg[i] !== pgId) continue;
    if (prodMask && !prodMask[prodCol[i]]) continue;
    const c = ch[i];
    if (mediumId >= 0 && chMed[c] !== mediumId) continue;
    if (chId >= 0 && c !== chId) continue;
    if (dpId >= 0 && dp[i] !== dpId) continue;
    if (adType && (excluded[theme[i]] ? 2 : 1) !== adType) continue;
    const y = yOf(mon[i]) - y0, a = adv[i], v = cost[i];
    yCat[y] += v;
    if (role[a] === 1) yMine[y] += v;
    else if (compIndex[a] >= 0) yComp[compIndex[a]][y] += v;
  }
  const yShare = arr => Array.from(arr, (v, k) => (yCat[k] ? (v / yCat[k]) * 100 : null));
  const years = Array.from({ length: nY }, (_, k) => {
    const y = y0 + k, b = yearBounds(y, fyMode);
    const first = Math.max(ds.meta.minDay, toDay(b.from)), last = Math.min(ds.meta.maxDay, toDay(b.to));
    return { year: y, fy: fyMode, label: yearLabel(y, fyMode), from: toIso(first), to: toIso(last), partial: toIso(first) !== b.from || toIso(last) !== b.to };
  });
  if (mineIds.length) sosRows[0].yearly = yShare(yMine);
  compSorted.forEach((a, j) => { sosRows[(mineIds.length ? 1 : 0) + j].yearly = yShare(yComp[j]); });
  const yRest = yCat.map((v, k) => v - yMine[k] - yComp.reduce((s2, arr) => s2 + arr[k], 0));
  const sos = {
    rows: sosRows,
    others: { ...sosRow({ name: `Other advertisers (${restCount})`, others: true, count: restCount }, Math.max(0, restSpend), Math.max(0, restSpots), restMonthly), yearly: yShare(yRest) },
    total: { spend: catSpend, spots: catSpots, advertisers: activeAdv },
    years, yearTotals: Array.from(yCat),
  };

  const hasPrev = f.compare && prevRows > 0;
  return {
    filters: { ...f, from: toIso(from), to: toIso(to), prevFrom: toIso(pFrom), prevTo: toIso(pTo) },
    mineLabel,
    kpi: {
      catSpend, catSpots, advertisers: activeAdv,
      catPrev: hasPrev ? catPrev : null,
      mineSpend, mineSpots, avgCost: mineSpots ? mineSpend / mineSpots : 0,
      minePrev: hasPrev ? minePrev : null,
      sos: catSpend ? (mineSpend / catSpend) * 100 : 0,
      sosPrev: hasPrev && catPrev ? (minePrev / catPrev) * 100 : null,
      rank: mineIds.length && mineSpend > 0 ? above + 1 : null, rankOf: others + (mineIds.length ? 1 : 0),
    },
    medium: {
      names: D.MEDIA,
      category: pct(medCat) || [0, 0, 0], mine: pct(medMine) || [0, 0, 0], categoryTotal: catSpend,
    },
    months, trend, drill,
    tvMix: channelMix(0), radioMix: channelMix(1), pressMix: channelMix(2), sos,
    duration: { buckets: D.DUR_BUCKETS, rows: durationRows, byMedium: { TV: durationRowsFor([0]), Radio: durationRowsFor([1]) }, legacy: !durRaw },
  };
}

// Detail view behind a click: the dashboard filters narrowed by a scope
// (month, medium, channel, advertiser or mine), broken down by advertiser, campaign and channel.
function detail(ds, f, scope = {}) {
  const { dicts, cols } = ds;
  const nAdv = dicts.adv.length, nCh = dicts.channel.length, nTheme = dicts.theme.length;
  const base = resolve(ds, f);
  const { pgId, mediumId, chId, dpId, role, adType, prodMask } = base;
  let { from, to } = base;
  // A year cell of the SOS table covers that whole year of data, whatever the dashboard dates are.
  if (scope.year) {
    const b = yearBounds(scope.year, !!scope.fy);
    from = Math.max(ds.meta.minDay, toDay(b.from));
    to = Math.min(ds.meta.maxDay, toDay(b.to));
    if (!(to >= from)) throw new Error('No data in ' + yearLabel(scope.year, !!scope.fy));
  }
  const excluded = excludedThemes(ds, !!f.tagCommercial);
  let mon = -1;
  if (scope.month) { const [y, m] = scope.month.split('-').map(Number); mon = y * 12 + m - 1; }
  const sMed = scope.medium ? D.MEDIA.indexOf(scope.medium) : -1;
  const sCh = scope.channel ? dicts.channel.indexOf(scope.channel) : -1;
  const sAdv = scope.advertiser ? dicts.adv.indexOf(scope.advertiser) : -1;
  // A clicked campaign, and a clicked duration bubble (TV and Radio ads of one standard length).
  const sTheme = scope.theme != null ? dicts.theme.indexOf(scope.theme) : -1;
  const sDur = scope.dur ? D.DUR_BUCKETS.indexOf(scope.dur) : -1;
  if ((scope.theme != null && sTheme < 0) || (scope.dur && sDur < 0)) throw new Error('Unknown campaign or length');
  const onlyMine = !!scope.mine;
  // "Other" segments leave out the channels shown on their own.
  const skipCh = new Uint8Array(nCh);
  for (const k of scope.exclude || []) { const c = dicts.channel.indexOf(k); if (c >= 0) skipCh[c] = 1; }
  // A sub-range inside the dashboard dates, e.g. a group of quiet months.
  const rFrom = scope.from ? Math.max(from, toDay(scope.from)) : from;
  const rTo = scope.to ? Math.min(to, toDay(scope.to)) : to;

  const advSpend = new Float64Array(nAdv), advSpots = new Float64Array(nAdv);
  const chSpend = new Float64Array(nCh), chSpots = new Float64Array(nCh), chMine = new Float64Array(nCh);
  const themes = new Map();
  let total = 0, spots = 0, mineTotal = 0;
  // Months tab: the scope's spend per month and the category spend that month (for share of category).
  const m0 = (() => { const t = new Date(from * 86400000); return t.getUTCFullYear() * 12 + t.getUTCMonth(); })();
  const m1 = (() => { const t = new Date(to * 86400000); return t.getUTCFullYear() * 12 + t.getUTCMonth(); })();
  const nM = m1 - m0 + 1;
  const monSpend = new Float64Array(nM), monSpots = new Float64Array(nM), monCatSpend = new Float64Array(nM);
  const { pg, adv, ch, theme, day, dp, dur, cost } = cols;
  const durRaw = cols.durRaw || null;
  const chMed = dicts.channelMedium;
  const monCol = cols.mon;

  const wN = cols.n || null, prodCol = cols.product;
  for (let i = 0, n = pg.length; i < n; i++) {
    if (pg[i] !== pgId) continue;
    if (prodMask && !prodMask[prodCol[i]]) continue;
    const d = day[i];
    const c = ch[i], md = chMed[c];
    if (mediumId >= 0 && md !== mediumId) continue;
    if (chId >= 0 && c !== chId) continue;
    if (dpId >= 0 && dp[i] !== dpId) continue;
    if (adType && (excluded[theme[i]] ? 2 : 1) !== adType) continue;
    if (d < rFrom || d > rTo || (mon >= 0 && monCol[i] !== mon)) continue;
    // Category spend over exactly the same days as the selection, for a fair share of category.
    monCatSpend[monCol[i] - m0] += cost[i];
    if (sMed >= 0 && md !== sMed) continue;
    if (sCh >= 0 && c !== sCh) continue;
    if (skipCh[c]) continue;
    const a = adv[i];
    if (sAdv >= 0 && a !== sAdv) continue;
    if (onlyMine && role[a] !== 1) continue;
    if (sTheme >= 0 && theme[i] !== sTheme) continue;
    if (sDur >= 0) {
      if (md > 1) continue;
      const sponsor = excluded[theme[i]] === 1;
      const bucket = durRaw ? D.durBucketOf(durRaw[i], sponsor) : (sponsor ? 0 : legacyDur(dur[i]));
      if (bucket !== sDur) continue;
    }
    const v = cost[i];
    if (d < rFrom || d > rTo || (mon >= 0 && monCol[i] !== mon)) continue;
    const w = wN ? wN[i] : 1;
    total += v; spots += w;
    monSpend[monCol[i] - m0] += v; monSpots[monCol[i] - m0] += w;
    advSpend[a] += v; advSpots[a] += w;
    chSpend[c] += v; chSpots[c] += w;
    if (role[a] === 1) { chMine[c] += v; mineTotal += v; }
    const key = a * nTheme + theme[i];
    const t = themes.get(key);
    if (t) { t[0] += v; t[1] += w; } else themes.set(key, [v, w]);
  }

  const advertisers = [];
  for (let a = 0; a < nAdv; a++) {
    if (advSpend[a] <= 0) continue;
    advertisers.push({
      name: dicts.adv[a], role: role[a] === 1 ? 'mine' : role[a] === 2 ? 'comp' : '',
      spend: advSpend[a], spots: advSpots[a],
    });
  }
  advertisers.sort((x, y) => y.spend - x.spend);
  const allCampaigns = [...themes].map(([key, v]) => {
    const t = key % nTheme, a = (key - t) / nTheme;
    return { name: dicts.theme[t], advertiser: dicts.adv[a], role: role[a] === 1 ? 'mine' : role[a] === 2 ? 'comp' : '', va: excluded[t] === 1, spend: v[0], spots: v[1] };
  }).sort((x, y) => y.spend - x.spend);
  // Top 50 commercials and top 50 value additions, so each tab is complete on its own.
  const campaigns = [...allCampaigns.filter(c => !c.va).slice(0, 50), ...allCampaigns.filter(c => c.va).slice(0, 50)].sort((x, y) => y.spend - x.spend);
  const channels = [];
  for (let c = 0; c < nCh; c++) {
    if (chSpend[c] <= 0) continue;
    channels.push({ name: dicts.channel[c], short: dicts.channelName[c], medium: D.MEDIA[chMed[c]], spend: chSpend[c], spots: chSpots[c], mine: chMine[c] });
  }
  channels.sort((x, y) => y.spend - x.spend);
  const monthsOut = [];
  for (let k = 0; k < nM; k++) {
    monthsOut.push({ key: monthKey(m0 + k), label: D.MONTHS[(m0 + k) % 12], year: Math.floor((m0 + k) / 12),
      spend: monSpend[k], spots: monSpots[k], category: monCatSpend[k] });
  }
  return {
    scope, total, spots, mineTotal,
    advertisers, campaigns, channels, months: monthsOut,
  };
}

module.exports = { overview, groupOptions, dashboard, detail };
