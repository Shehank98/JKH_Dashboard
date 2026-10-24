'use strict';
// Competitor Brief for the TV Media Planning Tool (schema 1.0).
// Every number is counted here, in code, from the rows behind the current dashboard filters; nothing is estimated and no
// model is called. The plain-English "facts" are written from templates so the planning agent never has to calculate.
// Runs in the browser engine (Web Worker) and in Node (tests): same code, same answers.

const D = require('./derive');

const SCHEMA_VERSION = '1.0';
const MAX_BYTES = 200 * 1024;
const MAX_COMPETITORS = 8;
const DEFAULT_COMPETITORS = 5;
const MAX_FACTS = 40;
const FACTS_PER_ADVERTISER = 7;
const DAYS = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'];
const MONTH_NAMES = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];
const BANDS = ['00-06', '06-09', '09-12', '12-15', '15-18', '18-21', '21-24']; // 00-06 is the overnight band, outside the six planning bands
const BUCKETS = D.DUR_BUCKETS;
const PRIME_FROM = 18, NON_PRIME_FROM = 6; // hour of day: Prime 18:00 to 24:00, Non-Prime 06:00 to 18:00

const DATA_DICTIONARY = {
  columns: {
    Product_Group: 'Product category the ad belongs to',
    Advertiser: 'Company that paid for the ad',
    Product: 'Product or brand advertised',
    Advt_Theme: 'Campaign or item name. Items such as -BB, Com Break, DJ, Tag, Time Check are value additions',
    Ads: 'Number of ads (spots) counted; one row is one spot',
    Channel: 'TV, Radio or Press channel. Medium is read from the channel name',
    Program: 'Programme the ad aired in (TV and Radio)',
    Dd: 'Day of month', Mn: 'Month', Yr: 'Year', Day: 'Day of week',
    Prog_time: 'Programme start time',
    Advt_time: 'Time the ad aired. Used for Prime and Non-Prime',
    AdPos: 'Position of the ad within the programme (1 = first ad aired in that programme). Some files hold the break label Start, Mid or End instead',
    TotAds: 'Total ads aired in that programme',
    BrkNo: 'Which commercial break of the programme the ad aired in',
    PosinBrk: 'Position of the ad inside that break (1 = first in break)',
    AdsinBrk: 'Total ads in that break',
    Lng: 'Language of the ad',
    Dur: 'Duration in seconds',
    Cost: 'Spend at rate card, in LKR',
  },
  definitions: {
    primeTime: 'Prime Time = 18:00 to 24:00 by Advt_time. Non-Prime = 06:00 to 18:00. Overnight (00:00 to 06:00) is neither and is reported as lateNight.',
    hourBands: 'Spots by hour of day. Bands 06-09 to 21-24 cover the planning day; 00-06 is overnight. Percentages use timed spots only (TV and Radio).',
    shareOfSpend: 'Advertiser spend divided by all advertisers\' spend in the same filters (rate card).',
    rank: 'Rank by spend among all advertisers in the filters. My advertisers are ranked together as one entity.',
    valueAddition: 'A spot is a value addition when its Advt_Theme is on the value-addition list (-BB, Com Break, DJ, -Extro, -Intro, -LLogo, Next Card, Tag, Time Check, -Tr; Tag can be counted as a commercial) or its Cost is 0. Totals include them unless the Ad type filter says otherwise; the valueAddition block shows them separately.',
    acd: 'Average commercial duration: sum of Dur divided by spots, in seconds, TV and Radio only.',
    durationBuckets: '5s = under 10s (value additions always count here), 10s, 15s, 20s, 30s, 30s+ (above 30s). Lengths snap to the nearest standard length.',
    programmePosition: 'first3 = AdPos 1 to 3, last3 = the last three ads of the programme (AdPos above TotAds minus 3), middle = the rest. Needs numeric AdPos and TotAds. TV and Radio only.',
    breakPosition: 'first = PosinBrk 1, last = PosinBrk equal to AdsinBrk, only = the only ad in the break, middle = the rest. TV and Radio only.',
    breakNumber: 'Share of spots in break 1, break 2, break 3 and later (BrkNo).',
    breakClutter: 'Average AdsinBrk, the number of ads in the breaks the advertiser airs into.',
    frequency: 'avgSpotsPerActiveDay = spots divided by days with at least one spot. avgSpotsPerProgrammeAiring = spots divided by distinct channel, programme and day combinations (TV and Radio).',
    flightingPattern: 'Weeks start on Monday. A flight is a run of consecutive active weeks. continuous = active in at least 75% of the weeks of the period; seasonal = a period of 12 months or more where the 3 busiest calendar months hold at least 60% of spend and coverage is below 75%; burst = otherwise, at most 3 flights; pulsing = otherwise, 4 or more flights.',
    nullValues: 'null means not available (no data or the metric does not apply, for example placement and duration for Press). It is never 0.',
    money: 'Whole LKR. Percentages have 1 decimal.',
  },
};

// ---------- small helpers ----------
const p1 = v => Math.round(v * 10) / 10;
const pc = (n, d) => (d > 0 ? p1((n / d) * 100) : null);
const toDay = iso => Math.round(Date.parse(iso + 'T00:00:00Z') / 86400000);
const toIso = day => new Date(day * 86400000).toISOString().slice(0, 10);
const monthKey = mon => `${Math.floor(mon / 12)}-${String((mon % 12) + 1).padStart(2, '0')}`;
const weekOf = d => d - ((d + 3) % 7); // Monday on or before day d (1970-01-01 was a Thursday)
const fmt = n => Math.round(n).toLocaleString('en-US');
const topN = (map, n, by = e => e.spend) => [...map].sort((a, b) => by(b[1]) - by(a[1])).slice(0, n);
const mode = map => { let best = null, n = -1; for (const [k, v] of map) if (v > n) { best = k; n = v; } return best; };
const bump = (m, k, by = 1) => m.set(k, (m.get(k) || 0) + by);
const bandOf = h => (h < 6 ? 0 : 1 + Math.floor((h - 6) / 3));
const bytesOf = s => new TextEncoder().encode(s).length;
const monthLabel = (key, withYear) => { const [y, m] = key.split('-'); return MONTH_NAMES[Number(m) - 1] + (withYear ? ' ' + y : ''); };

function positionBucket(pos, ads) {
  if (!pos) return null;
  if (ads === 1) return 'only';
  if (pos === 1) return 'first';
  if (ads && pos === ads) return 'last';
  return 'middle';
}
function breakLabelOf(label) {
  const s = String(label || '').trim().toLowerCase();
  if (s.startsWith('start') || s === 'opening' || s === 'open') return 'Start';
  if (s.startsWith('mid') || s === 'middle' || s === 'centre' || s === 'center') return 'Mid';
  if (s.startsWith('end') || s === 'closing' || s === 'close') return 'End';
  return null;
}

// ---------- the filter (same rules as the dashboard) ----------
function makeScan(ds, f, range) {
  const { dicts, cols } = ds;
  const pgId = dicts.pg.indexOf(f.pg);
  if (pgId < 0) throw new Error('Unknown product group');
  const from = range.from, to = range.to;
  if (!(to >= from)) throw new Error('Invalid date range');
  const mediumId = D.MEDIA.indexOf(f.medium);
  const chId = f.channel ? dicts.channel.indexOf(f.channel) : -1;
  const dpId = f.daypart ? D.DAYPARTS.indexOf(f.daypart) : -1;
  const slot = D.slotId(f.slot);
  const adType = f.adType === 'Sponsorship' ? 2 : f.adType === 'Commercial' ? 1 : 0;
  const excluded = dicts.theme.map(t => (D.isExcludedTheme(t, { tagCommercial: !!f.tagCommercial }) ? 1 : 0));
  const hourCol = cols.hour || new Uint8Array(cols.pg.length).fill(255);
  const chMed = dicts.channelMedium;
  return function scan(fn) {
    for (let i = 0, n = cols.pg.length; i < n; i++) {
      if (cols.pg[i] !== pgId) continue;
      const d = cols.day[i];
      if (d < from || d > to) continue;
      const c = cols.ch[i], md = chMed[c];
      if (mediumId >= 0 && md !== mediumId) continue;
      if (chId >= 0 && c !== chId) continue;
      if ((dpId >= 0 && cols.dp[i] !== dpId) || (slot && !D.slotOk(slot, hourCol[i]))) continue;
      const themeVA = excluded[cols.theme[i]] === 1;
      if (adType && (themeVA ? 2 : 1) !== adType) continue;
      fn(i, d, c, md, themeVA);
    }
  };
}

const rangeOf = (ds, f, o) => {
  const from = toDay(o.from || f.from), to = toDay(o.to || f.to);
  if (Number.isNaN(from) || Number.isNaN(to)) throw new Error('Invalid date range');
  return { from, to };
};

// ---------- options for the modal: who can be picked, and the defaults ----------
function plannerOptions(ds, f) {
  const { dicts, cols } = ds;
  const range = rangeOf(ds, f, {});
  const scan = makeScan(ds, f, range);
  const A = new Map();
  let total = 0;
  scan((i, d) => { const a = cols.adv[i], v = cols.cost[i]; total += v; const e = A.get(a) || { spend: 0, spots: 0 }; e.spend += v; e.spots++; A.set(a, e); });
  const list = [...A].sort((x, y) => y[1].spend - x[1].spend).slice(0, 400)
    .map(([a, e]) => ({ name: dicts.adv[a], spend: Math.round(e.spend), spots: e.spots, sos: pc(e.spend, total) }));
  const mine = (f.mine || []).filter(n => A.has(dicts.adv.indexOf(n)));
  const inMine = new Set(f.mine || []);
  const rest = list.filter(a => !inMine.has(a.name));
  const wanted = (f.comps || []).filter(n => rest.some(a => a.name === n));
  return {
    productGroup: f.pg, from: toIso(range.from), to: toIso(range.to),
    minDate: toIso(ds.meta.minDay), maxDate: toIso(ds.meta.maxDay),
    advertisers: list, mine,
    competitors: (wanted.length ? wanted : rest.slice(0, DEFAULT_COMPETITORS).map(a => a.name)).slice(0, MAX_COMPETITORS),
    maxCompetitors: MAX_COMPETITORS, totalSpend: Math.round(total),
    hasDetail: !!(cols.prog && cols.hour && cols.brk && cols.pos && cols.ads),
  };
}

// ---------- the brief ----------
function plannerBrief(ds, f, o = {}) {
  const { dicts, cols } = ds;
  const range = rangeOf(ds, f, o);
  const { from, to } = range;
  const scan = makeScan(ds, f, range);
  const nAdv = dicts.adv.length;
  const chMed = dicts.channelMedium, chName = c => dicts.channelName[c];
  const warnings = [];
  const hasDetail = !!(cols.prog && cols.hour && cols.brk && cols.pos && cols.ads && dicts.program);
  const hasLng = !!(cols.lng && dicts.lng);
  const hasProgPos = !!(cols.progPos && cols.progAds);
  const breakIds = dicts.adPos ? dicts.adPos.map(breakLabelOf) : [];
  const hasBreakLabel = breakIds.some(Boolean);
  if (!hasDetail) warnings.push('This data was loaded before programmes, hours and breaks were kept. Load the file again in the dashboard to include them.');
  if (!hasLng || !hasProgPos) warnings.push('This data was loaded before language and programme position were kept. Load the file again in the dashboard to include them.');

  // Pass 1: category totals and who spends what.
  const adSpend = new Float64Array(nAdv), adSpots = new Int32Array(nAdv);
  let catSpend = 0, catSpots = 0;
  const catMed = [{ spend: 0, spots: 0 }, { spend: 0, spots: 0 }, { spend: 0, spots: 0 }];
  const catMon = new Map(), catCh = new Map(), catProg = new Map();
  scan((i, d, c, md) => {
    const v = cols.cost[i], a = cols.adv[i];
    catSpend += v; catSpots++; adSpend[a] += v; adSpots[a]++;
    catMed[md].spend += v; catMed[md].spots++;
    const m = cols.mon[i];
    const me = catMon.get(m) || { spend: 0, spots: 0 }; me.spend += v; me.spots++; catMon.set(m, me);
    const ce = catCh.get(c) || { spend: 0, spots: 0 }; ce.spend += v; ce.spots++; catCh.set(c, ce);
    if (hasDetail && md < 2) {
      const k = c * 1e7 + cols.prog[i];
      const pe = catProg.get(k) || { spend: 0, spots: 0 }; pe.spend += v; pe.spots++; catProg.set(k, pe);
    }
  });
  if (!catSpots) throw new Error('No spots found for these filters.');

  // Who is in the brief. The client may be several advertisers combined; competitors default to the top spenders.
  const idOf = n => dicts.adv.indexOf(n);
  const clientNames = (o.client && o.client.length ? o.client : f.mine || []).filter(n => idOf(n) >= 0);
  if (!clientNames.length) throw new Error('Choose my advertiser first.');
  const clientIds = new Set(clientNames.map(idOf));
  let compNames = (o.competitors || f.comps || []).filter(n => idOf(n) >= 0 && !clientIds.has(idOf(n)));
  if (!compNames.length) {
    compNames = [...Array(nAdv).keys()].filter(a => adSpots[a] && !clientIds.has(a)).sort((x, y) => adSpend[y] - adSpend[x])
      .slice(0, DEFAULT_COMPETITORS).map(a => dicts.adv[a]);
  }
  compNames = [...new Set(compNames)].slice(0, MAX_COMPETITORS);
  const entities = [{ name: clientNames.join(' + '), role: 'mine', members: clientNames }]
    .concat(compNames.map(n => ({ name: n, role: 'competitor', members: [n] })));
  const entityOf = new Int16Array(nAdv).fill(-1);
  entities.forEach((e, k) => e.members.forEach(n => { entityOf[idOf(n)] = k; }));

  // Rank: my advertisers together as one entity, against every other advertiser.
  const units = [{ key: -1, spend: 0 }];
  for (let a = 0; a < nAdv; a++) {
    if (!adSpots[a]) continue;
    if (clientIds.has(a)) units[0].spend += adSpend[a]; else units.push({ key: a, spend: adSpend[a] });
  }
  units.sort((x, y) => y.spend - x.spend);
  const rankOfUnit = new Map(units.map((u, k) => [u.key, k + 1]));
  entities.forEach((e, k) => {
    e.spend = 0; e.spots = 0;
    e.members.forEach(n => { e.spend += adSpend[idOf(n)]; e.spots += adSpots[idOf(n)]; });
    e.rank = k === 0 ? rankOfUnit.get(-1) : rankOfUnit.get(idOf(e.members[0]));
  });

  // Pass 2: everything else, for the chosen advertisers only.
  const mk = () => ({
    spend: 0, spots: 0, va: { spend: 0, spots: 0, items: new Map() }, med: [{ spend: 0, spots: 0 }, { spend: 0, spots: 0 }, { spend: 0, spots: 0 }],
    ch: new Map(), prog: new Map(), hourSpots: new Float64Array(7), hourSpend: new Float64Array(7), timed: 0, timedSpend: 0,
    prime: { spots: 0, spend: 0 }, nonPrime: { spots: 0, spend: 0 }, late: { spots: 0, spend: 0 },
    dow: new Float64Array(7), dowSpend: new Float64Array(7), mon: new Map(), week: new Map(), camp: new Map(),
    dur: new Array(BUCKETS.length).fill(0), durN: 0, acdS: 0, acdN: 0, lng: new Map(), lngN: 0,
    pp: { first3: 0, middle: 0, last3: 0, n: 0 }, bp: { first: 0, middle: 0, last: 0, only: 0, n: 0 }, bn: { b1: 0, b2: 0, b3: 0, n: 0 },
    bl: { Start: 0, Mid: 0, End: 0, n: 0 }, clutS: 0, clutN: 0, days: new Set(), air: new Set(), airSpots: 0,
    first: Infinity, last: -Infinity,
  });
  const E = entities.map(mk);
  scan((i, d, c, md, themeVA) => {
    const k = entityOf[cols.adv[i]];
    if (k < 0) return;
    const x = E[k], v = cols.cost[i], h = cols.hour ? cols.hour[i] : 255;
    const isVA = themeVA || v === 0;
    x.spend += v; x.spots++;
    if (isVA) { x.va.spend += v; x.va.spots++; const it = x.va.items.get(cols.theme[i]) || { spend: 0, spots: 0 }; it.spend += v; it.spots++; x.va.items.set(cols.theme[i], it); }
    x.med[md].spend += v; x.med[md].spots++;
    x.days.add(d);
    if (d < x.first) x.first = d;
    if (d > x.last) x.last = d;
    const ce = x.ch.get(c) || { spend: 0, spots: 0, timed: 0, prime: 0 };
    ce.spend += v; ce.spots++;
    if (h !== 255) { ce.timed++; if (h >= PRIME_FROM) ce.prime++; }
    x.ch.set(c, ce);
    if (h !== 255) {
      x.timed++; x.timedSpend += v;
      const b = bandOf(h); x.hourSpots[b]++; x.hourSpend[b] += v;
      const z = h >= PRIME_FROM ? x.prime : h >= NON_PRIME_FROM ? x.nonPrime : x.late;
      z.spots++; z.spend += v;
    }
    const dow = (d + 3) % 7;
    x.dow[dow]++; x.dowSpend[dow] += v;
    const me = x.mon.get(cols.mon[i]) || { spend: 0, spots: 0 }; me.spend += v; me.spots++; x.mon.set(cols.mon[i], me);
    const wk = weekOf(d), we = x.week.get(wk) || { spend: 0, spots: 0 }; we.spend += v; we.spots++; x.week.set(wk, we);
    let bucket = 255;
    if (md < 2) {
      const raw = cols.durRaw ? cols.durRaw[i] : NaN;
      bucket = D.durBucketOf(raw, themeVA);
      if (bucket < BUCKETS.length) { x.dur[bucket]++; x.durN++; }
      const secs = D.durSecondsOf(raw, themeVA);
      if (secs > 0) { x.acdS += secs; x.acdN++; }
    }
    if (!themeVA) {
      const t = cols.theme[i];
      const cp = x.camp.get(t) || { spend: 0, spots: 0, first: d, last: d, ch: new Map(), dur: new Map(), lng: new Map() };
      cp.spend += v; cp.spots++;
      if (d < cp.first) cp.first = d;
      if (d > cp.last) cp.last = d;
      bump(cp.ch, c);
      if (bucket < BUCKETS.length) bump(cp.dur, bucket);
      if (hasLng) { const l = dicts.lng[cols.lng[i]]; if (l !== '(blank)') bump(cp.lng, l); }
      x.camp.set(t, cp);
    }
    if (hasLng) { const l = dicts.lng[cols.lng[i]]; if (l !== '(blank)') { bump(x.lng, l); x.lngN++; } }
    if (md < 2 && hasDetail) {
      const pk = c * 1e7 + cols.prog[i];
      const pe = x.prog.get(pk) || { spend: 0, spots: 0, d30: 0 };
      pe.spend += v; pe.spots++;
      if (bucket === 4) pe.d30++;
      x.prog.set(pk, pe);
      if (dicts.program[cols.prog[i]] !== '(blank)') { x.air.add((d * 1e4 + c) * 1e6 + cols.prog[i]); x.airSpots++; }
      const pos = cols.pos[i], ads = cols.ads[i];
      const pb = positionBucket(pos, ads);
      if (pb) { x.bp[pb]++; x.bp.n++; }
      const bn = cols.brk[i];
      if (bn) { x.bn[bn >= 3 ? 'b3' : bn === 2 ? 'b2' : 'b1']++; x.bn.n++; }
      if (ads) { x.clutS += ads; x.clutN++; }
      if (hasProgPos) {
        const pp = cols.progPos[i], tot = cols.progAds[i];
        if (pp && tot) { x.pp[pp <= 3 ? 'first3' : pp > tot - 3 ? 'last3' : 'middle']++; x.pp.n++; }
      }
      const bl = breakIds[cols.adPos[i]];
      if (bl) { x.bl[bl]++; x.bl.n++; }
    }
  });

  // ---------- turn the counts into profiles ----------
  const periodMonths = (() => { const a = new Date(from * 86400000), b = new Date(to * 86400000); return (b.getUTCFullYear() - a.getUTCFullYear()) * 12 + b.getUTCMonth() - a.getUTCMonth() + 1; })();
  const periodWeeks = (weekOf(to) - weekOf(from)) / 7 + 1;
  const withYear = periodMonths > 12;
  const mediumNames = f.medium && f.medium !== 'All' ? [f.medium] : D.MEDIA.slice();
  const nameOfTheme = t => dicts.theme[t];

  function flightingOf(x) {
    const weeks = [...x.week.keys()].sort((a, b) => a - b);
    const flights = [];
    for (const w of weeks) {
      const last = flights[flights.length - 1];
      const e = x.week.get(w);
      if (last && w - last.end === 7) { last.end = w; last.weeks++; last.spots += e.spots; last.spend += e.spend; }
      else flights.push({ start: w, end: w, weeks: 1, spots: e.spots, spend: e.spend });
    }
    const coverage = weeks.length / periodWeeks;
    let peak = null;
    for (const [m, e] of x.mon) if (!peak || e.spend > peak.spend) peak = { m, spend: e.spend };
    const byCal = new Array(12).fill(0);
    for (const [m, e] of x.mon) byCal[m % 12] += e.spend;
    const top3 = byCal.slice().sort((a, b) => b - a).slice(0, 3).reduce((s, v) => s + v, 0);
    let pattern = null;
    if (weeks.length) {
      if (periodMonths >= 12 && coverage < 0.75 && x.spend > 0 && top3 / x.spend >= 0.6) pattern = 'seasonal';
      else if (coverage >= 0.75) pattern = 'continuous';
      else if (flights.length <= 3) pattern = 'burst';
      else pattern = 'pulsing';
    }
    const inactive = [];
    if (x.mon.size) {
      const lo = Math.min(...x.mon.keys()), hi = Math.max(...x.mon.keys());
      for (let m = lo; m <= hi; m++) if (!x.mon.has(m)) inactive.push(monthKey(m));
    }
    return {
      monthly: [...x.mon].sort((a, b) => a[0] - b[0]).map(([m, e]) => ({ month: monthKey(m), spots: e.spots, spend: Math.round(e.spend) })),
      weekly: weeks.map(w => [toIso(w), x.week.get(w).spots, Math.round(x.week.get(w).spend)]),
      activeWeeks: weeks.length, periodWeeks, coveragePct: p1(coverage * 100),
      flightCount: flights.length, longestRunWeeks: flights.length ? Math.max(...flights.map(z => z.weeks)) : null,
      flights: flights.slice(0, 12).map(z => ({ from: toIso(z.start), to: toIso(z.end + 6), weeks: z.weeks, spots: z.spots, spend: Math.round(z.spend) })),
      pattern, peakMonth: peak ? monthKey(peak.m) : null, inactiveMonths: inactive.slice(0, 12),
    };
  }

  function profileOf(x, k, ent) {
    const timedBase = x.timed, md = x.med;
    const tvRadio = md[0].spots + md[1].spots;
    const byChannel = topN(x.ch, 10).map(([c, e]) => ({
      channel: chName(c), medium: D.MEDIA[chMed[c]], spend: Math.round(e.spend), spots: e.spots, sharePct: pc(e.spend, x.spend), primeSpotsPct: pc(e.prime, e.timed),
    }));
    const byProgram = topN(x.prog, 10).map(([key, e]) => ({
      channel: chName(Math.floor(key / 1e7)), programme: dicts.program[key % 1e7], spots: e.spots, spend: Math.round(e.spend), avgCostPerSpot: Math.round(e.spend / e.spots),
    }));
    const dayDen = x.dow.reduce((s, v) => s + v, 0);
    const weekend = x.dow[5] + x.dow[6];
    const camps = topN(x.camp, 15).map(([t, e]) => {
      const dur = mode(e.dur);
      return {
        name: nameOfTheme(t), firstDate: toIso(e.first), lastDate: toIso(e.last), durationDays: e.last - e.first + 1, spots: e.spots, spend: Math.round(e.spend),
        mainChannels: topN(e.ch, 3, v => v).map(([c]) => chName(c)).slice(0, 3), mainDuration: dur == null ? null : BUCKETS[dur], language: mode(e.lng),
      };
    });
    const hasBreaks = x.bp.n > 0;
    const pct3 = (o, keys, n) => (n ? Object.fromEntries(keys.map(([key, name]) => [name, pc(o[key], n)])) : null);
    const vaItems = topN(x.va.items, 5).map(([t, e]) => ({ name: nameOfTheme(t), spots: e.spots, spend: Math.round(e.spend) }));
    return {
      name: ent.name, role: ent.role, advertisers: ent.members,
      totals: {
        spend: Math.round(x.spend), spots: x.spots, avgCostPerSpot: x.spots ? Math.round(x.spend / x.spots) : null, shareOfSpendPct: pc(x.spend, catSpend), rank: ent.rank,
        commercialSpend: Math.round(x.spend - x.va.spend), commercialSpots: x.spots - x.va.spots, firstSpot: x.spots ? toIso(x.first) : null, lastSpot: x.spots ? toIso(x.last) : null,
      },
      byMedium: Object.fromEntries(D.MEDIA.map((m, j) => [m, { spend: Math.round(md[j].spend), spendPct: pc(md[j].spend, x.spend), spots: md[j].spots, spotsPct: pc(md[j].spots, x.spots) }])),
      byChannel, byProgram,
      daypart: timedBase ? {
        timedSpots: timedBase,
        prime: { spotsPct: pc(x.prime.spots, timedBase), spendPct: pc(x.prime.spend, x.timedSpend) },
        nonPrime: { spotsPct: pc(x.nonPrime.spots, timedBase), spendPct: pc(x.nonPrime.spend, x.timedSpend) },
        lateNight: { spotsPct: pc(x.late.spots, timedBase), spendPct: pc(x.late.spend, x.timedSpend) },
        hourBands: BANDS.map((b, j) => ({ band: b, spotsPct: pc(x.hourSpots[j], timedBase), spendPct: pc(x.hourSpend[j], x.timedSpend) })),
      } : null,
      dayOfWeek: dayDen ? {
        days: DAYS.map((d, j) => ({ day: d, spotsPct: pc(x.dow[j], dayDen) })),
        weekdayPct: pc(dayDen - weekend, dayDen), weekendPct: pc(weekend, dayDen),
      } : null,
      flighting: flightingOf(x),
      campaigns: camps,
      duration: x.durN ? {
        spotsCounted: x.durN, buckets: Object.fromEntries(BUCKETS.map((b, j) => [b, x.dur[j]])),
        bucketsPct: Object.fromEntries(BUCKETS.map((b, j) => [b, pc(x.dur[j], x.durN)])), acdSeconds: x.acdN ? p1(x.acdS / x.acdN) : null,
      } : null,
      language: x.lngN ? topN(x.lng, 6, v => v).map(([l, n]) => ({ language: l, spotsPct: pc(n, x.lngN) })) : null,
      placement: tvRadio && hasDetail ? {
        spotsCounted: tvRadio,
        programmePosition: x.pp.n ? { spotsCounted: x.pp.n, ...pct3(x.pp, [['first3', 'first3Pct'], ['middle', 'middlePct'], ['last3', 'last3Pct']], x.pp.n) } : null,
        breakPosition: hasBreaks ? { spotsCounted: x.bp.n, ...pct3(x.bp, [['first', 'firstPct'], ['middle', 'middlePct'], ['last', 'lastPct'], ['only', 'onlyPct']], x.bp.n) } : null,
        breakNumber: x.bn.n ? { spotsCounted: x.bn.n, ...pct3(x.bn, [['b1', 'break1Pct'], ['b2', 'break2Pct'], ['b3', 'break3PlusPct']], x.bn.n) } : null,
        breakInProgramme: x.bl.n ? { spotsCounted: x.bl.n, ...pct3(x.bl, [['Start', 'startPct'], ['Mid', 'midPct'], ['End', 'endPct']], x.bl.n) } : null,
        avgBreakClutter: x.clutN ? p1(x.clutS / x.clutN) : null,
      } : null,
      frequency: {
        avgSpotsPerActiveDay: x.days.size ? p1(x.spots / x.days.size) : null,
        avgSpotsPerProgrammeAiring: x.air.size ? p1(x.airSpots / x.air.size) : null,
      },
      valueAddition: {
        spots: x.va.spots, spend: Math.round(x.va.spend), spendPct: pc(x.va.spend, x.spend), spotsPct: pc(x.va.spots, x.spots), topItems: vaItems,
      },
    };
  }
  const profiles = entities.map((ent, k) => profileOf(E[k], k, ent));

  // ---------- category summary ----------
  const catChannels = topN(catCh, 10).map(([c, e]) => ({ channel: chName(c), medium: D.MEDIA[chMed[c]], spend: Math.round(e.spend), spots: e.spots, sharePct: pc(e.spend, catSpend) }));
  const catPrograms = topN(catProg, 10).map(([key, e]) => ({ channel: chName(Math.floor(key / 1e7)), programme: dicts.program[key % 1e7], spend: Math.round(e.spend), spots: e.spots, sharePct: pc(e.spend, catSpend) }));
  const categorySummary = {
    totalSpend: Math.round(catSpend), totalSpots: catSpots, advertisers: units.length,
    spendByMedium: Object.fromEntries(D.MEDIA.map((m, j) => [m, { spend: Math.round(catMed[j].spend), spendPct: pc(catMed[j].spend, catSpend), spots: catMed[j].spots }])),
    monthlySpend: [...catMon].sort((a, b) => a[0] - b[0]).map(([m, e]) => ({ month: monthKey(m), spend: Math.round(e.spend), spots: e.spots })),
    topChannels: catChannels, topPrograms: catPrograms,
  };

  // ---------- comparison and gaps ----------
  const selSpend = profiles.reduce((s, p) => s + p.totals.spend, 0);
  const shareOfSpend = profiles.map(p => ({ advertiser: p.name, role: p.role, spend: p.totals.spend, spots: p.totals.spots, sharePct: p.totals.shareOfSpendPct, rank: p.totals.rank }));
  shareOfSpend.push({ advertiser: 'All other advertisers', role: 'other', spend: Math.round(catSpend - selSpend), spots: catSpots - profiles.reduce((s, p) => s + p.totals.spots, 0), sharePct: pc(catSpend - selSpend, catSpend), rank: null });

  const gaps = [];
  const me = E[0], mp = profiles[0];
  const comps = E.slice(1);
  // Channels where a competitor puts real money and we are absent.
  const chRows = [];
  const allCh = new Set(); comps.forEach(x => x.ch.forEach((_, c) => allCh.add(c)));
  for (const c of allCh) {
    const mine = me.ch.get(c) || { spend: 0, spots: 0 };
    const list = comps.map((x, j) => ({ x, p: profiles[j + 1], e: x.ch.get(c) })).filter(r => r.e && pc(r.e.spend, r.x.spend) >= 10);
    if (!list.length) continue;
    if (mine.spots > 0 && pc(mine.spend, me.spend) >= 2) continue;
    chRows.push({ c, mine, list, weight: list.reduce((s, r) => s + r.e.spend, 0) });
  }
  chRows.sort((a, b) => b.weight - a.weight).slice(0, 8).forEach(r => gaps.push({
    type: 'channel', name: chName(r.c), medium: D.MEDIA[chMed[r.c]],
    client: { spend: Math.round(r.mine.spend), spots: r.mine.spots, sharePct: pc(r.mine.spend, me.spend) },
    competitors: r.list.map(z => ({ advertiser: z.p.name, spend: Math.round(z.e.spend), spots: z.e.spots, sharePct: pc(z.e.spend, z.x.spend) })),
  }));
  // Programmes where a competitor airs regularly and we have no spot.
  if (hasDetail) {
    const progRows = new Map();
    comps.forEach((x, j) => x.prog.forEach((e, key) => {
      if (e.spots < 5 || me.prog.has(key)) return;
      const r = progRows.get(key) || { key, list: [], weight: 0 };
      r.list.push({ advertiser: profiles[j + 1].name, spend: Math.round(e.spend), spots: e.spots, sharePct: pc(e.spend, x.spend) });
      r.weight += e.spend; progRows.set(key, r);
    }));
    [...progRows.values()].sort((a, b) => b.weight - a.weight).slice(0, 10).forEach(r => gaps.push({
      type: 'programme', name: dicts.program[r.key % 1e7], channel: chName(Math.floor(r.key / 1e7)), client: { spend: 0, spots: 0, sharePct: 0 }, competitors: r.list,
    }));
  }
  // Hour bands where competitors are active and we are not.
  if (me.timed) {
    BANDS.forEach((b, j) => {
      const mineShare = pc(me.hourSpots[j], me.timed);
      const list = comps.map((x, n) => ({ x, p: profiles[n + 1] })).filter(r => r.x.timed && pc(r.x.hourSpots[j], r.x.timed) >= 15);
      if (!list.length || mineShare >= 5) return;
      gaps.push({
        type: 'hourBand', name: b, client: { spots: me.hourSpots[j], spotsPct: mineShare },
        competitors: list.map(r => ({ advertiser: r.p.name, spots: r.x.hourSpots[j], spotsPct: pc(r.x.hourSpots[j], r.x.timed) })),
      });
    });
  }
  // Months where competitors run and we do not.
  const monthRows = new Map();
  comps.forEach((x, j) => x.mon.forEach((e, m) => {
    if (me.mon.has(m) || pc(e.spend, x.spend) < 5) return;
    const r = monthRows.get(m) || { m, list: [], weight: 0 };
    r.list.push({ advertiser: profiles[j + 1].name, spend: Math.round(e.spend), spots: e.spots, sharePct: pc(e.spend, x.spend) });
    r.weight += e.spend; monthRows.set(m, r);
  }));
  [...monthRows.values()].sort((a, b) => b.weight - a.weight).slice(0, 6).forEach(r => gaps.push({
    type: 'month', name: monthKey(r.m), client: { spend: 0, spots: 0 }, competitors: r.list,
  }));
  // First position in the break.
  if (mp.placement && mp.placement.breakPosition) {
    const mineFirst = mp.placement.breakPosition.firstPct;
    const list = profiles.slice(1).filter(p => p.placement && p.placement.breakPosition && p.placement.breakPosition.firstPct >= 30 && mineFirst < 15);
    if (list.length) gaps.push({
      type: 'breakPosition', name: 'first in break', client: { spotsPct: mineFirst },
      competitors: list.map(p => ({ advertiser: p.name, spotsPct: p.placement.breakPosition.firstPct })),
    });
  }

  // ---------- facts ----------
  const facts = [];
  const maxShare = Math.max(...profiles.map(p => p.totals.shareOfSpendPct || 0), 1);
  const wt = (p) => (p.role === 'mine' ? 1 : 0.4 + 0.6 * Math.min(1, (p.totals.shareOfSpendPct || 0) / maxShare));
  const subj = p => (p.role === 'mine' ? `${p.name} (us)` : p.name);
  const add = (score, text, p, topic, ref) => facts.push({ score, text, advertiser: p ? p.name : null, topic, ref });
  const mname = key => monthLabel(key, withYear);
  const per = [];
  profiles.forEach((p, k) => {
    const w = wt(p), S = subj(p), t = p.totals, ref = `advertisers[${k}]`;
    const list = [];
    const L = (score, text, topic, r) => list.push({ score: score * w, text, p, topic, ref: `${ref}.${r}` });
    L(70, `${S} has ${t.shareOfSpendPct}% share of spend (rank ${t.rank} of ${units.length}): LKR ${fmt(t.spend)} over ${fmt(t.spots)} spots, an average of LKR ${fmt(t.avgCostPerSpot)} per spot.`, 'share', 'totals');
    const top = p.byChannel[0];
    if (top) {
      const second = p.byChannel[1];
      let tail = '';
      if (top.primeSpotsPct != null) tail = top.primeSpotsPct >= 50 ? `, mostly in Prime Time (${top.primeSpotsPct}% of spots)` : `, mostly in Non-Prime (${p1(100 - top.primeSpotsPct)}% of spots)`;
      L(85, `${S} spends ${top.sharePct}% of its budget on ${top.channel}${tail}${second ? `, then ${second.channel} with ${second.sharePct}%` : ''}.`, 'channel', 'byChannel');
    }
    const m = p.byMedium;
    if (m.TV.spendPct >= 85 || m.Radio.spendPct >= 25 || m.Press.spendPct >= 25) {
      L(55, `${S} splits its budget ${m.TV.spendPct}% TV, ${m.Radio.spendPct}% Radio and ${m.Press.spendPct}% Press.`, 'medium', 'byMedium');
    }
    if (p.daypart) {
      const best = p.daypart.hourBands.filter(b => b.band !== '00-06').sort((a, b) => b.spotsPct - a.spotsPct)[0];
      L(75, `For ${S}, Prime Time (6pm to midnight) carries ${p.daypart.prime.spotsPct}% of spots and ${p.daypart.prime.spendPct}% of spend; the busiest band is ${best.band} (${best.spotsPct}% of spots).`, 'daypart', 'daypart');
    }
    if (p.dayOfWeek && (p.dayOfWeek.weekendPct >= 35 || p.dayOfWeek.weekendPct <= 15)) {
      const bd = p.dayOfWeek.days.slice().sort((a, b) => b.spotsPct - a.spotsPct)[0];
      L(40, `For ${S}, weekends carry ${p.dayOfWeek.weekendPct}% of spots (weekdays ${p.dayOfWeek.weekdayPct}%); the busiest day is ${bd.day} with ${bd.spotsPct}%.`, 'dayOfWeek', 'dayOfWeek');
    }
    const fl = p.flighting;
    if (fl.pattern) {
      const lens = fl.flights.map(z => z.weeks), lo = Math.min(...lens), hi = Math.max(...lens);
      const range = lo === hi ? `${lo} week${lo === 1 ? '' : 's'}` : `${lo} to ${hi} weeks`;
      const gapsTxt = fl.inactiveMonths.length ? `, no activity in ${fl.inactiveMonths.slice(0, 4).map(mname).join(', ')}` : '';
      const peak = fl.peakMonth ? `, peak in ${mname(fl.peakMonth)}` : '';
      let text;
      if (fl.pattern === 'continuous') text = `${S} is always on: active in ${fl.activeWeeks} of ${fl.periodWeeks} weeks (longest run ${fl.longestRunWeeks} weeks)${peak}${gapsTxt}.`;
      else if (fl.pattern === 'burst') text = fl.flightCount === 1 ? `${S} runs a single burst of ${range}${peak}${gapsTxt}.` : `${S} runs in bursts: ${fl.flightCount} flights of ${range} each${peak}${gapsTxt}.`;
      else if (fl.pattern === 'pulsing') text = `${S} pulses: ${fl.flightCount} flights of ${range} with gaps between them, active in ${fl.coveragePct}% of weeks${peak}${gapsTxt}.`;
      else text = `${S} is seasonal: its busiest months carry most of its spend${peak}${gapsTxt}.`;
      L(80, text, 'flighting', 'flighting');
    }
    const pl = p.placement;
    if (pl && pl.breakPosition) {
      const bp = pl.breakPosition;
      let tail = '';
      const dur = p.duration, best = [...E[k].prog].sort((a, b) => b[1].d30 - a[1].d30)[0];
      if (dur && dur.buckets['30s'] > 0 && best && best[1].d30 > 0) {
        tail = `, and ${pc(best[1].d30, dur.buckets['30s'])}% of its 30s spots are in ${dicts.program[best[0] % 1e7]} on ${chName(Math.floor(best[0] / 1e7))}`;
      }
      L(70, `${S} takes the first position in the break in ${bp.firstPct}% of spots and the last in ${bp.lastPct}%${tail}.`, 'placement', 'placement.breakPosition');
    }
    if (pl && pl.programmePosition) {
      const pp = pl.programmePosition;
      L(55, `For ${S}, ${pp.first3Pct}% of ads air in the first 3 positions of a programme and ${pp.last3Pct}% in the last 3.`, 'placement', 'placement.programmePosition');
    } else if (pl && pl.breakInProgramme) {
      const b = pl.breakInProgramme;
      L(55, `${S} airs ${b.startPct}% of spots in the start break of a programme, ${b.midPct}% in the middle and ${b.endPct}% at the end.`, 'placement', 'placement.breakInProgramme');
    }
    if (pl && pl.breakNumber) {
      const b = pl.breakNumber;
      L(45, `${S} airs ${b.break1Pct}% of spots in break 1, ${b.break2Pct}% in break 2 and ${b.break3PlusPct}% in break 3 or later${pl.avgBreakClutter != null ? `, into breaks of ${pl.avgBreakClutter} ads on average` : ''}.`, 'placement', 'placement.breakNumber');
    }
    if (p.duration) {
      const bk = Object.entries(p.duration.bucketsPct).sort((a, b) => b[1] - a[1])[0];
      L(60, `For ${S}, ${bk[1]}% of TV and Radio spots are ${bk[0]} long and the average commercial duration is ${p.duration.acdSeconds} seconds.`, 'duration', 'duration');
    }
    if (p.language && p.language[0].spotsPct >= 60 && p.language.length > 1) {
      L(35, `For ${S}, ${p.language[0].spotsPct}% of spots are in ${p.language[0].language}.`, 'language', 'language');
    }
    if (p.frequency.avgSpotsPerActiveDay != null) {
      L(40, `${S} airs ${p.frequency.avgSpotsPerActiveDay} spots on each active day${p.frequency.avgSpotsPerProgrammeAiring != null ? ` and ${p.frequency.avgSpotsPerProgrammeAiring} spots per programme airing` : ''}.`, 'frequency', 'frequency');
    }
    const cp = p.campaigns[0];
    if (cp) {
      L(50, `The biggest campaign of ${S} is "${cp.name}": ${cp.firstDate} to ${cp.lastDate} (${cp.durationDays} days), ${fmt(cp.spots)} spots, LKR ${fmt(cp.spend)}${cp.mainChannels.length ? `, mainly on ${cp.mainChannels.join(', ')}` : ''}${cp.mainDuration ? `, mostly ${cp.mainDuration} spots` : ''}.`, 'campaign', 'campaigns[0]');
    }
    if (p.valueAddition.spendPct >= 10) {
      const it = p.valueAddition.topItems[0];
      L(45, `For ${S}, ${p.valueAddition.spendPct}% of spend (${fmt(p.valueAddition.spots)} spots) is value addition${it ? `, mainly ${it.name}` : ''}.`, 'valueAddition', 'valueAddition');
    }
    list.sort((a, b) => b.score - a.score).slice(0, FACTS_PER_ADVERTISER).forEach(z => add(z.score, z.text, z.p, z.topic, z.ref));
  });
  // Gaps become facts too.
  const clientP = profiles[0], cs = subj(clientP);
  gaps.forEach((g, j) => {
    const lead = g.competitors[0];
    const rankBoost = 100 - j;
    if (g.type === 'channel') add(rankBoost, `${cs} has ${clientP.totals.shareOfSpendPct}% share of spend but ${g.client.spots} spots on ${g.name}, where ${lead.advertiser} puts ${lead.sharePct}% of its budget (LKR ${fmt(lead.spend)}).`, clientP, 'gap', `comparison.gapsAndOpportunities[${j}]`);
    else if (g.type === 'programme') add(rankBoost - 10, `${lead.advertiser} aired ${lead.spots} spots in ${g.name} on ${g.channel} (LKR ${fmt(lead.spend)}); ${cs} has none there.`, clientP, 'gap', `comparison.gapsAndOpportunities[${j}]`);
    else if (g.type === 'hourBand') add(rankBoost - 15, `${lead.advertiser} airs ${lead.spotsPct}% of its spots between ${g.name.replace('-', ':00 and ')}:00; ${cs} airs ${g.client.spotsPct}% there.`, clientP, 'gap', `comparison.gapsAndOpportunities[${j}]`);
    else if (g.type === 'month') add(rankBoost - 20, `${lead.advertiser} spends LKR ${fmt(lead.spend)} (${lead.sharePct}% of its period spend) in ${mname(g.name)}; ${cs} has no activity that month.`, clientP, 'gap', `comparison.gapsAndOpportunities[${j}]`);
    else if (g.type === 'breakPosition') add(rankBoost - 5, `${lead.advertiser} takes the first position in the break in ${lead.spotsPct}% of spots; ${cs} takes it in ${g.client.spotsPct}%.`, clientP, 'gap', `comparison.gapsAndOpportunities[${j}]`);
  });
  // The category.
  const mediumTxt = D.MEDIA.map((m, j) => `${m} ${categorySummary.spendByMedium[m].spendPct}%`).join(', ');
  add(65, `The category spent LKR ${fmt(catSpend)} over ${fmt(catSpots)} spots across ${units.length} advertisers (${mediumTxt}).`, null, 'category', 'categorySummary');
  if (categorySummary.monthlySpend.length > 1) {
    const pk = categorySummary.monthlySpend.slice().sort((a, b) => b.spend - a.spend)[0];
    add(50, `Category spend peaks in ${mname(pk.month)}: LKR ${fmt(pk.spend)}, ${pc(pk.spend, catSpend)}% of the period.`, null, 'category', 'categorySummary.monthlySpend');
  }
  if (catChannels[0]) add(50, `${catChannels[0].channel} is the biggest channel in the category with ${catChannels[0].sharePct}% of spend.`, null, 'category', 'categorySummary.topChannels');

  facts.sort((a, b) => b.score - a.score);
  const finalFacts = facts.slice(0, MAX_FACTS).map((x, k) => ({ id: 'F' + String(k + 1).padStart(2, '0'), text: x.text, advertiser: x.advertiser, topic: x.topic, ref: x.ref }));
  // Gap facts point at gaps by position in the full list, which we may still shorten below, so keep the list as built.

  // ---------- assemble ----------
  const payload = {
    schemaVersion: SCHEMA_VERSION,
    generatedAt: new Date().toISOString(),
    dataDictionary: DATA_DICTIONARY,
    context: {
      productGroup: f.pg, dateFrom: toIso(from), dateTo: toIso(to), months: periodMonths, mediums: mediumNames, currency: 'LKR', spendBasis: 'rate card',
      myAdvertiser: entities[0].name, myAdvertisers: clientNames, competitors: compNames,
      filters: {
        medium: f.medium || 'All', channel: f.channel || 'All', daypart: f.daypart || 'All', timeOfDay: { PT: 'Prime time', NPT: 'Non prime time' }[f.slot] || 'All',
        adType: { Sponsorship: 'Value Additions', Commercial: 'Commercials' }[f.adType] || 'All', tagCountsAs: f.tagCommercial ? 'Commercial' : 'Value Addition',
      },
      source: ds.meta && ds.meta.fileName ? ds.meta.fileName : '',
    },
    categorySummary,
    advertisers: profiles,
    comparison: { shareOfSpend, gapsAndOpportunities: gaps },
    facts: finalFacts,
    warnings,
  };

  // Keep it under 200 KB: drop the heaviest detail first and say what was dropped.
  const trimmed = [];
  const size = () => bytesOf(JSON.stringify(payload));
  const steps = [
    ['weekly flighting series', () => payload.advertisers.forEach(p => { p.flighting.weekly = null; })],
    ['campaigns cut to 8 per advertiser', () => payload.advertisers.forEach(p => { p.campaigns = p.campaigns.slice(0, 8); })],
    ['channel and programme lists cut to 5', () => payload.advertisers.forEach(p => { p.byChannel = p.byChannel.slice(0, 5); p.byProgram = p.byProgram.slice(0, 5); })],
    ['monthly series and flights dropped', () => payload.advertisers.forEach(p => { p.flighting.monthly = null; p.flighting.flights = p.flighting.flights.slice(0, 4); })],
  ];
  for (const [label, run] of steps) {
    if (size() <= MAX_BYTES) break;
    run(); trimmed.push(label);
  }
  if (trimmed.length) payload.warnings.push('The brief was trimmed to stay under 200 KB: ' + trimmed.join('; ') + '.');
  payload.meta = { sizeBytes: size(), maxBytes: MAX_BYTES, trimmed };
  payload.meta.sizeBytes = size();
  return payload;
}

module.exports = { plannerBrief, plannerOptions, SCHEMA_VERSION, MAX_BYTES, MAX_COMPETITORS };
