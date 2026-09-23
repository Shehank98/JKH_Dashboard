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
  for (let i = 0; i < pg.length; i++) {
    if (pg[i] !== pgId) continue;
    advSpend[adv[i]] += cost[i]; advSeen[adv[i]] = 1;
    chSpend[ch[i]] += cost[i]; chSeen[ch[i]] = 1;
  }
  const advertisers = [];
  advSeen.forEach((s, i) => { if (s) advertisers.push({ name: ds.dicts.adv[i], spend: advSpend[i] }); });
  advertisers.sort((a, b) => b.spend - a.spend);
  const channels = [];
  chSeen.forEach((s, i) => {
    if (s) channels.push({ name: ds.dicts.channel[i], medium: D.MEDIA[ds.dicts.channelMedium[i]], spend: chSpend[i] });
  });
  channels.sort((a, b) => a.medium.localeCompare(b.medium) || b.spend - a.spend);
  return { advertisers, channels };
}

function dashboard(ds, f) {
  const { dicts, cols } = ds;
  const nAdv = dicts.adv.length, nCh = dicts.channel.length, nTheme = dicts.theme.length;
  const pgId = dicts.pg.indexOf(f.pg);
  if (pgId < 0) throw new Error('Unknown product group');

  const from = toDay(f.from), to = toDay(f.to);
  if (!(to >= from)) throw new Error('Invalid date range');
  const len = to - from + 1, pFrom = from - len, pTo = from - 1;
  const mediumId = D.MEDIA.indexOf(f.medium);
  const chId = f.channel ? dicts.channel.indexOf(f.channel) : -1;
  const dpId = f.daypart ? D.DAYPARTS.indexOf(f.daypart) : -1;

  // role: 1 = mine, 2 = competitor. Mine wins if a name is in both lists.
  const role = new Uint8Array(nAdv);
  const compIds = [];
  for (const n of f.comps || []) { const i = dicts.adv.indexOf(n); if (i >= 0) { role[i] = 2; compIds.push(i); } }
  const mineIds = [];
  for (const n of f.mine || []) { const i = dicts.adv.indexOf(n); if (i >= 0) { role[i] = 1; mineIds.push(i); } }
  const comps = compIds.filter(i => role[i] === 2);

  const mon0 = new Date(from * 86400000), mon1 = new Date(to * 86400000);
  const m0 = mon0.getUTCFullYear() * 12 + mon0.getUTCMonth();
  const nM = mon1.getUTCFullYear() * 12 + mon1.getUTCMonth() - m0 + 1;

  const advSpend = new Float64Array(nAdv), advSpots = new Float64Array(nAdv);
  const monAdv = new Float64Array(nM * nAdv);
  const monCat = new Float64Array(nM), monMine = new Float64Array(nM);
  const medCat = [0, 0, 0], medMine = [0, 0, 0];
  const chCat = new Float64Array(nM * nCh), chMine = new Float64Array(nM * nCh), chTot = new Float64Array(nCh);
  const durAdv = new Float64Array(nAdv * 4), durMine = [0, 0, 0, 0], durCat = [0, 0, 0, 0];
  const themeAgg = new Map(); // key (month, advertiser, theme) -> [spend, spots]
  let catSpend = 0, catSpots = 0, mineSpend = 0, mineSpots = 0, catPrev = 0, minePrev = 0;
  let prevRows = 0;

  const { pg, adv, ch, theme, day, mon, dp, dur, cost } = cols;
  const chMed = dicts.channelMedium;

  for (let i = 0, n = pg.length; i < n; i++) {
    if (pg[i] !== pgId) continue;
    const d = day[i];
    if (d < pFrom || d > to) continue;
    const c = ch[i], md = chMed[c];
    if (mediumId >= 0 && md !== mediumId) continue;
    if (chId >= 0 && c !== chId) continue;
    if (dpId >= 0 && dp[i] !== dpId) continue;
    const a = adv[i], v = cost[i], isMine = role[a] === 1;

    if (d < from) {
      prevRows++;
      catPrev += v;
      if (isMine) minePrev += v;
      continue;
    }

    const mi = mon[i] - m0;
    catSpend += v; catSpots++;
    advSpend[a] += v; advSpots[a]++;
    monAdv[mi * nAdv + a] += v;
    monCat[mi] += v;
    medCat[md] += v;
    if (md < 2) { chCat[mi * nCh + c] += v; chTot[c] += v; }
    const du = dur[i];
    if (md < 2 && du < 4) { durAdv[a * 4 + du]++; durCat[du]++; }
    if (isMine) {
      mineSpend += v; mineSpots++;
      monMine[mi] += v;
      medMine[md] += v;
      if (md < 2) chMine[mi * nCh + c] += v;
      if (md < 2 && du < 4) durMine[du]++;
    }
    const key = (mi * nAdv + a) * nTheme + theme[i];
    const t = themeAgg.get(key);
    if (t) { t[0] += v; t[1]++; } else themeAgg.set(key, [v, 1]);
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
    return { channels: ids.map(c => dicts.channelName[c]), category: series(chCat), mine: series(chMine) };
  };

  // Duration mix, share of TV and Radio spots.
  const pct = arr => { const s = arr.reduce((x, y) => x + y, 0); return s ? arr.map(x => (x / s) * 100) : null; };
  const durationRows = [{ name: mineLabel, mine: true, split: pct(durMine) }]
    .concat(compSorted.map(a => ({ name: dicts.adv[a], mine: false, split: pct(Array.from(durAdv.subarray(a * 4, a * 4 + 4))) })))
    .concat([{ name: 'Category avg.', avg: true, split: pct(durCat) }]);

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
    tvMix: channelMix(0), radioMix: channelMix(1),
    duration: { buckets: D.DURATIONS.map(s => s + 's'), rows: durationRows },
  };
}

module.exports = { overview, groupOptions, dashboard };
