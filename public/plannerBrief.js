'use strict';
// Competitor Brief for the TV Media Planning Tool (schema version "1.0").
//
// Reads the dashboard's columnar dataset (the same one server/builder.js produces) for the current filters and
// returns ONE plain JSON object of aggregates and plain-English facts. Everything is computed here, in code:
// no LLM, no raw rows, no network. The planner's agent only has to read it.
//
// Runs in the dashboard's Web Worker (loaded as /engine/lib/plannerBrief.js) and in Node (scripts/planner-brief-test.js).

let D;
try { D = require('./derive'); } catch (e) { D = require('../server/derive'); }

const SCHEMA_VERSION = '1.0';
const MAX_BYTES = 200 * 1024;
const MEDIA = ['TV', 'Radio', 'Press'];
const DAYS = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'];
const BANDS = ['06-09', '09-12', '12-15', '15-18', '18-21', '21-24'];
const BUCKETS = D.DUR_BUCKETS; // 5s 10s 15s 20s 30s 30s+
const MAX_FACTS = 40;

const toDay = iso => Math.round(Date.parse(iso + 'T00:00:00Z') / 86400000);
const toIso = day => new Date(day * 86400000).toISOString().slice(0, 10);
const dowOf = day => (day + 3) % 7;                  // 0 = Monday (1970-01-01 was a Thursday)
const weekStartOf = day => day - dowOf(day);
const monthKeyOf = mon => `${Math.floor(mon / 12)}-${String((mon % 12) + 1).padStart(2, '0')}`;
const monthName = key => { const [y, m] = key.split('-'); return `${D.MONTHS[Number(m) - 1]} ${y}`; };
const r0 = v => Math.round(v);
const r1 = v => Math.round(v * 10) / 10;
const pct = (v, t) => (t > 0 ? r1((v / t) * 100) : null);
const money = v => 'LKR ' + r0(v).toLocaleString('en-US');
const fmtPct = v => (v == null ? 'n/a' : r1(v) + '%');
const topN = (map, n, key) => [...map.entries()].sort((a, b) => key(b[1]) - key(a[1]) || (a[0] < b[0] ? -1 : 1)).slice(0, n);
const bump = (map, k, spend, spots = 1) => { const e = map.get(k); if (e) { e[0] += spend; e[1] += spots; } else map.set(k, [spend, spots]); };
const bandOf = hour => (hour >= 6 && hour < 24 ? Math.floor((hour - 6) / 3) : 6); // 6 = overnight 00-06

const DATA_DICTIONARY = {
  columns: {
    Product_Group: 'Product category of the ad',
    Advertiser: 'Company that paid for the ad',
    Product: 'Product or brand advertised',
    Advt_Theme: 'Campaign / ad theme name',
    Ads: 'Ad identifier',
    Channel: 'TV, Radio or Press channel (prefix TV - / FM / Radio - tells the medium)',
    Program: 'Programme the ad aired in',
    Dd: 'Day of month', Mn: 'Month', Yr: 'Year', Day: 'Day of week',
    Prog_time: 'Programme start time',
    Advt_time: 'Time the ad aired (used for Prime / Non-Prime and hour bands)',
    AdPos: 'Position of the ad within the programme (1 = first ad aired in that programme)',
    TotAds: 'Total ads aired in that programme',
    BrkNo: 'Which commercial break of the programme the ad aired in',
    PosinBrk: 'Position of the ad inside that break (1 = first in break)',
    AdsinBrk: 'Total ads in that break',
    Lng: 'Language of the ad',
    Dur: 'Duration in seconds',
    Cost: 'Spend at rate card (LKR)',
  },
  definitions: {
    primeTime: 'Prime Time = Advt_time from 18:00 to 24:00. Non-Prime = 06:00 to 18:00. 00:00 to 06:00 is reported as overnight.',
    hourBands: BANDS.join(', ') + ' (24-hour clock, start inclusive).',
    spot: 'One airing or insertion with a rate-card cost above 0 that is not a value-addition item.',
    valueAddition: 'Free or bonus items: Advt_Theme on the value-addition list (-BB, Com Break, DJ, -Extro, -Intro, -LLogo, Next Card, Tag, Time Check, -Tr) or Cost = 0. They are NOT counted in spots or spend; see each advertiser\'s valueAddition block.',
    shareOfSpend: 'Advertiser spend / total spend of all advertisers in the filtered category, in %.',
    rank: 'Rank by spend among all advertisers in the filtered category (1 = biggest).',
    avgCostPerSpot: 'Spend / spots, whole LKR.',
    placement: 'Only TV and Radio. Programme position: first 3 = AdPos <= 3, last 3 = AdPos > TotAds - 3, otherwise middle. Break position: first = PosinBrk 1, last = PosinBrk = AdsinBrk (a single-ad break counts as first), otherwise middle. Press has no break data, so it is skipped.',
    duration: 'Only TV and Radio. Buckets 5s, 10s, 15s, 20s, 30s, 30s+ (nearest standard length). ACD = average of raw Dur in seconds.',
    flighting: 'A week (Monday start) is active when the advertiser has at least one spot. A flight is a run of consecutive active weeks. Pattern: continuous = active in 80%+ of the weeks in the period; burst = one flight, or several that fit no other label; pulsing = repeated short flights (3 weeks or less) with short gaps; seasonal = 60%+ of spend in 2 months and active in at most half the months.',
    frequency: 'spotsPerActiveDay = spots / days with at least one spot. spotsPerProgrammeAiring = TV and Radio spots / distinct programme airings (channel, programme, date) the advertiser appeared in.',
    nulls: 'null means the value could not be worked out from the data (missing or not applicable), it is never a zero.',
    rounding: 'Money in whole LKR, percentages to 1 decimal place.',
  },
};

// ---- filters shared with the dashboard ----
function resolve(ds, f) {
  const { dicts } = ds;
  const pgId = dicts.pg.indexOf(f.pg);
  if (pgId < 0) throw new Error('Unknown product group');
  const from = toDay(f.from), to = toDay(f.to);
  if (!(to >= from)) throw new Error('Invalid date range');
  return {
    pgId, from, to,
    mediumId: MEDIA.indexOf(f.medium),
    chId: f.channel ? dicts.channel.indexOf(f.channel) : -1,
    dpId: f.daypart ? D.DAYPARTS.indexOf(f.daypart) : -1,
    slot: D.slotId(f.slot),
    adType: f.adType === 'Sponsorship' ? 2 : f.adType === 'Commercial' ? 1 : 0,
    excluded: dicts.theme.map(t => (D.isExcludedTheme(t, { tagCommercial: !!f.tagCommercial }) ? 1 : 0)),
  };
}

// Rows that pass the filters, calling visit(i) for each. Keeps both builders on the same rules.
function eachRow(ds, f, r, visit) {
  const { cols, dicts } = ds;
  const { pg, ch, theme, day, dp } = cols;
  const hour = cols.hour || null;
  const chMed = dicts.channelMedium;
  for (let i = 0, n = pg.length; i < n; i++) {
    if (pg[i] !== r.pgId) continue;
    const d = day[i];
    if (d < r.from || d > r.to) continue;
    const c = ch[i];
    if (r.mediumId >= 0 && chMed[c] !== r.mediumId) continue;
    if (r.chId >= 0 && c !== r.chId) continue;
    if (r.dpId >= 0 && dp[i] !== r.dpId) continue;
    if (r.slot && !D.slotOk(r.slot, hour ? hour[i] : 255)) continue;
    const sponsor = r.excluded[theme[i]] === 1;
    if (r.adType && (sponsor ? 2 : 1) !== r.adType) continue;
    visit(i, sponsor);
  }
}

// Advertisers ranked by spend for the current filters (used by the modal to pick the default competitors).
function rankAdvertisers(ds, f) {
  const r = resolve(ds, f);
  const { adv, cost } = ds.cols;
  const spend = new Float64Array(ds.dicts.adv.length), spots = new Float64Array(ds.dicts.adv.length);
  eachRow(ds, f, r, (i, sponsor) => {
    if (sponsor || !(cost[i] > 0)) return;
    spend[adv[i]] += cost[i]; spots[adv[i]]++;
  });
  const out = [];
  let total = 0;
  for (let a = 0; a < spend.length; a++) { total += spend[a]; if (spots[a] > 0) out.push({ name: ds.dicts.adv[a], spend: r0(spend[a]), spots: spots[a] }); }
  out.sort((x, y) => y.spend - x.spend);
  out.forEach((o, k) => { o.rank = k + 1; o.sharePct = pct(o.spend, total); });
  return { advertisers: out, totalSpend: r0(total), from: toIso(r.from), to: toIso(r.to) };
}

function newAcc() {
  return {
    spend: 0, spots: 0, first: Infinity, last: -Infinity,
    medSpend: [0, 0, 0], medSpots: [0, 0, 0],
    ch: new Map(), prog: new Map(), mon: new Map(), wk: new Map(), days: new Set(), themes: new Map(),
    hbSpots: new Float64Array(7), hbSpend: new Float64Array(7), timed: 0, timedSpend: 0,
    primeSpots: 0, primeSpend: 0, nonPrimeSpots: 0, nonPrimeSpend: 0,
    dow: new Float64Array(7),
    dur: new Float64Array(6), durN: 0, durSum: 0, lng: new Map(), lngN: 0,
    nonPress: 0, airings: new Set(), d30: new Map(), d30Total: 0,
    apN: 0, ap3: 0, apLast3: 0, apMid: 0, lblN: 0, lbl: { Start: 0, Mid: 0, End: 0 },
    bpN: 0, bpFirst: 0, bpLast: 0, bpMid: 0, bkN: 0, bk1: 0, bk2: 0, bk3: 0, clutterSum: 0, clutterN: 0,
    va: { spots: 0, spend: 0, ch: new Map(), themes: new Map() },
  };
}

function buildBrief(ds, f, opts = {}) {
  const { dicts, cols } = ds;
  const r = resolve(ds, f);
  const warnings = [];
  const nAdv = dicts.adv.length, nProg = (dicts.program || []).length || 1;
  const from = opts.from ? toDay(opts.from) : r.from, to = opts.to ? toDay(opts.to) : r.to;
  if (!(to >= from)) throw new Error('Invalid date range');
  r.from = Math.max(from, r.from); r.to = Math.min(to, r.to);
  if (!(r.to >= r.from)) throw new Error('The chosen dates are outside the filtered period');
  const vaMode = opts.valueAddition || 'both';          // 'theme' | 'zeroCost' | 'both'
  const prime = { from: opts.primeFrom == null ? 18 : opts.primeFrom, to: opts.primeTo == null ? 24 : opts.primeTo };
  const nonPrimeFrom = opts.nonPrimeFrom == null ? 6 : opts.nonPrimeFrom;

  const mineNames = (opts.myAdvertisers || (opts.myAdvertiser ? [opts.myAdvertiser] : f.mine || [])).filter(n => dicts.adv.includes(n));
  const compNames = (opts.competitors || f.comps || []).filter(n => dicts.adv.includes(n) && !mineNames.includes(n));
  const myLabel = mineNames.join(' + ');
  const role = new Int16Array(nAdv).fill(-1);          // index into accs
  const names = [];
  if (mineNames.length) { mineNames.forEach(n => { role[dicts.adv.indexOf(n)] = 0; }); names.push(myLabel); }
  compNames.forEach(n => { role[dicts.adv.indexOf(n)] = names.length; names.push(n); });
  const accs = names.map(newAcc);
  const hasMine = mineNames.length > 0;

  const hasPos = !!(cols.adPosN && cols.totAds);
  const hasDetail = !!(cols.prog && cols.hour && dicts.program);
  if (!hasDetail) warnings.push('This data was loaded before programme and time were kept. Load the file again in the dashboard to get programme, daypart and break metrics.');
  else if (!hasPos) warnings.push('This data was loaded before AdPos, TotAds and Lng were kept. Load the file again to get programme-position and language metrics.');
  const breakLabels = dicts.adPos ? dicts.adPos.map(l => {
    const s = String(l || '').trim().toLowerCase();
    return s.startsWith('start') ? 'Start' : s.startsWith('mid') ? 'Mid' : s.startsWith('end') ? 'End' : null;
  }) : [];

  // category-level
  const spendAll = new Float64Array(nAdv), spotsAll = new Float64Array(nAdv);
  const catMed = [0, 0, 0], catMedSpots = [0, 0, 0];
  const catCh = new Map(), catProg = new Map(), catMon = new Map();
  let catSpend = 0, catSpots = 0, catVaSpots = 0, matched = 0;

  const { adv, ch, theme, day, mon, cost } = cols;
  const hourCol = cols.hour, progCol = cols.prog, durRaw = cols.durRaw, durIdx = cols.dur;
  const chMed = dicts.channelMedium;
  const vaByTheme = vaMode !== 'zeroCost', vaByCost = vaMode !== 'theme';

  eachRow(ds, f, r, (i, sponsor) => {
    matched++;
    const a = adv[i], c = ch[i], md = chMed[c], v = cost[i] > 0 ? cost[i] : 0, d = day[i];
    const isVa = (vaByTheme && sponsor) || (vaByCost && !(cost[i] > 0));
    const k = role[a];
    if (isVa) {
      catVaSpots++;
      if (k >= 0) {
        const va = accs[k].va;
        va.spots++; va.spend += v;
        bump(va.ch, c, v); bump(va.themes, theme[i], v);
      }
      return;
    }
    spendAll[a] += v; spotsAll[a]++;
    catSpend += v; catSpots++; catMed[md] += v; catMedSpots[md]++;
    bump(catCh, c, v); bump(catMon, mon[i], v);
    const pk = progCol && md !== 2 ? c * nProg + progCol[i] : -1;
    if (pk >= 0 && dicts.program[progCol[i]] !== '(blank)') bump(catProg, pk, v);
    if (k < 0) return;

    const A = accs[k];
    A.spend += v; A.spots++;
    if (d < A.first) A.first = d;
    if (d > A.last) A.last = d;
    A.medSpend[md] += v; A.medSpots[md]++;
    bump(A.ch, c, v); bump(A.mon, mon[i], v); bump(A.wk, weekStartOf(d), v); A.days.add(d);
    A.dow[dowOf(d)]++;
    let th = A.themes.get(theme[i]);
    if (!th) { th = { first: d, last: d, spend: 0, spots: 0, ch: new Map(), dur: new Map(), lng: new Map() }; A.themes.set(theme[i], th); }
    th.spend += v; th.spots++; if (d < th.first) th.first = d; if (d > th.last) th.last = d;
    bump(th.ch, c, v);
    const lg = cols.lng ? cols.lng[i] : -1;
    if (lg >= 0) { A.lngN++; A.lng.set(lg, (A.lng.get(lg) || 0) + 1); th.lng.set(lg, (th.lng.get(lg) || 0) + 1); }

    if (md === 2) return; // Press: no time of day in the brief, no break data, no duration.
    A.nonPress++;
    if (pk >= 0) { bump(A.prog, pk, v); A.airings.add(pk * 100000 + (d % 100000)); }
    const h = hourCol ? hourCol[i] : 255;
    if (h !== 255) {
      const b = bandOf(h);
      A.hbSpots[b]++; A.hbSpend[b] += v; A.timed++; A.timedSpend += v;
      if (h >= prime.from && h < prime.to) { A.primeSpots++; A.primeSpend += v; }
      else if (h >= nonPrimeFrom && h < prime.from) { A.nonPrimeSpots++; A.nonPrimeSpend += v; }
    }
    // duration
    const raw = durRaw ? durRaw[i] : NaN;
    if (raw > 0) {
      A.durSum += raw; A.durN++;
      const bi = durIdx[i];
      if (bi < 6) { A.dur[bi]++; if (bi === 4 && pk >= 0) { A.d30Total++; A.d30.set(pk, (A.d30.get(pk) || 0) + 1); } }
      const key = Math.round(raw);
      th.dur.set(key, (th.dur.get(key) || 0) + 1);
    }
    // placement
    const apn = hasPos ? cols.adPosN[i] : 0, tot = hasPos ? cols.totAds[i] : 0;
    if (apn > 0 && tot > 0) {
      A.apN++;
      if (apn <= 3) A.ap3++; else if (apn > tot - 3) A.apLast3++; else A.apMid++;
    } else if (cols.adPos) {
      const lb = breakLabels[cols.adPos[i]];
      if (lb) { A.lblN++; A.lbl[lb]++; }
    }
    const ps = cols.pos ? cols.pos[i] : 0, ak = cols.ads ? cols.ads[i] : 0;
    if (ps > 0 && ak > 0) {
      A.bpN++;
      if (ps === 1) A.bpFirst++; else if (ps === ak) A.bpLast++; else A.bpMid++;
      A.clutterSum += ak; A.clutterN++;
    }
    const bk = cols.brk ? cols.brk[i] : 0;
    if (bk > 0) { A.bkN++; if (bk === 1) A.bk1++; else if (bk === 2) A.bk2++; else A.bk3++; }
  });

  if (!matched) warnings.push('No rows match the current filters.');
  const rankOfAll = (spendOf, excludeIdx) => {
    let better = 0, n = 0;
    for (let a = 0; a < nAdv; a++) { if (excludeIdx.has(a) || !(spotsAll[a] > 0)) continue; n++; if (spendAll[a] > spendOf) better++; }
    return { rank: spendOf > 0 ? better + 1 : null, of: n + 1 };
  };

  const periodWeeks = (weekStartOf(r.to) - weekStartOf(r.from)) / 7 + 1;
  const periodMonthKeys = [];
  { const m0 = new Date(r.from * 86400000), m1 = new Date(r.to * 86400000);
    for (let m = m0.getUTCFullYear() * 12 + m0.getUTCMonth(); m <= m1.getUTCFullYear() * 12 + m1.getUTCMonth(); m++) periodMonthKeys.push(m); }

  const chName = i => dicts.channel[i];
  const progOf = pk => ({ channel: chName(Math.floor(pk / nProg)), programme: dicts.program[pk % nProg] });

  function flighting(A) {
    const weeks = [...A.wk.keys()].sort((x, y) => x - y);
    const flights = [];
    for (const w of weeks) {
      const last = flights[flights.length - 1];
      if (last && w - last.toDay === 7) { last.toDay = w; last.weeks++; } else flights.push({ fromDay: w, toDay: w, weeks: 1 });
    }
    const monthly = [...A.mon.entries()].sort((x, y) => x[0] - y[0]).map(([m, [s, n]]) => ({ month: monthKeyOf(m), spots: n, spend: r0(s) }));
    const weekly = weeks.map(w => ({ weekStart: toIso(w), spots: A.wk.get(w)[1], spend: r0(A.wk.get(w)[0]) }));
    const aw = weeks.length;
    let pattern = null;
    if (aw) {
      const coverage = aw / periodWeeks;
      const sortedSpend = monthly.map(m => m.spend).sort((x, y) => y - x);
      const top2 = (sortedSpend[0] || 0) + (sortedSpend[1] || 0);
      const avgRun = aw / flights.length;
      const gaps = flights.slice(1).map((fl, k) => (fl.fromDay - flights[k].toDay) / 7 - 1);
      if (coverage >= 0.8) pattern = 'continuous';
      else if (flights.length === 1) pattern = 'burst';
      else if (periodMonthKeys.length >= 6 && A.spend > 0 && top2 / A.spend >= 0.6 && monthly.length <= periodMonthKeys.length / 2) pattern = 'seasonal';
      else if (avgRun <= 3 && gaps.every(g => g <= 3)) pattern = 'pulsing';
      else pattern = 'burst';
    }
    const peak = monthly.length ? monthly.reduce((b, m) => (m.spend > b.spend ? m : b)) : null;
    // quiet months between the first and last active month
    const inactive = [];
    if (monthly.length) {
      const act = new Set(monthly.map(m => m.month));
      const lo = [...A.mon.keys()].reduce((x, y) => Math.min(x, y)), hi = [...A.mon.keys()].reduce((x, y) => Math.max(x, y));
      for (let m = lo; m <= hi; m++) if (!act.has(monthKeyOf(m))) inactive.push(monthKeyOf(m));
    }
    return {
      monthly, weekly, activeWeeks: aw, periodWeeks, longestRunWeeks: flights.reduce((b, fl) => Math.max(b, fl.weeks), 0) || null,
      flightCount: flights.length, flights: flights.map(fl => ({ from: toIso(fl.fromDay), to: toIso(fl.toDay + 6), weeks: fl.weeks })),
      pattern, peakMonth: peak ? { month: peak.month, spend: peak.spend, spots: peak.spots } : null, inactiveMonths: inactive,
    };
  }

  function profile(name, k) {
    const A = accs[k];
    const members = k === 0 && hasMine ? new Set(mineNames.map(n => dicts.adv.indexOf(n))) : new Set([dicts.adv.indexOf(name)]);
    const { rank, of } = rankOfAll(A.spend, members);
    const np = A.nonPress;
    const base = {
      name, role: k === 0 && hasMine ? 'mine' : 'competitor',
      totals: {
        spend: r0(A.spend), spots: A.spots, avgCostPerSpot: A.spots ? r0(A.spend / A.spots) : null,
        shareOfSpendPct: pct(A.spend, catSpend), rank: A.spots ? rank : null, rankOf: of,
        firstSpot: A.spots ? toIso(A.first) : null, lastSpot: A.spots ? toIso(A.last) : null,
      },
      byMedium: Object.fromEntries(MEDIA.map((m, i) => [m, { spend: r0(A.medSpend[i]), spendPct: pct(A.medSpend[i], A.spend), spots: A.medSpots[i], spotsPct: pct(A.medSpots[i], A.spots) }])),
      byChannel: topN(A.ch, 10, e => e[0]).map(([c, [s, n]]) => ({ channel: chName(c), medium: MEDIA[chMed[c]], spend: r0(s), spots: n, shareOfAdvertiserSpendPct: pct(s, A.spend) })),
      byProgram: topN(A.prog, 10, e => e[0]).map(([pk, [s, n]]) => ({ ...progOf(pk), spots: n, spend: r0(s), avgCostPerSpot: n ? r0(s / n) : null })),
    };
    if (!A.spots) return { ...base, note: 'No spots for this advertiser in the filtered data.', valueAddition: vaBlock(A) };
    base.daypart = A.timed ? {
      basis: 'TV and Radio spots with an Advt_time',
      primePct: { spots: pct(A.primeSpots, A.timed), spend: pct(A.primeSpend, A.timedSpend) },
      nonPrimePct: { spots: pct(A.nonPrimeSpots, A.timed), spend: pct(A.nonPrimeSpend, A.timedSpend) },
      overnightPct: { spots: pct(A.hbSpots[6], A.timed), spend: pct(A.hbSpend[6], A.timedSpend) },
      hourBands: BANDS.map((b, i) => ({ band: b, spotsPct: pct(A.hbSpots[i], A.timed), spendPct: pct(A.hbSpend[i], A.timedSpend) })),
    } : null;
    const wkd = A.dow[0] + A.dow[1] + A.dow[2] + A.dow[3] + A.dow[4], wke = A.dow[5] + A.dow[6];
    base.dayOfWeek = { spotsPct: Object.fromEntries(DAYS.map((dn, i) => [dn, pct(A.dow[i], A.spots)])), weekdayPct: pct(wkd, A.spots), weekendPct: pct(wke, A.spots) };
    base.flighting = flighting(A);
    base.campaigns = topN(A.themes, 15, e => e.spend).map(([t, e]) => {
      const mainDur = topN(e.dur, 1, x => x)[0];
      const lg = topN(e.lng, 1, x => x)[0];
      return {
        campaign: dicts.theme[t], firstDate: toIso(e.first), lastDate: toIso(e.last), durationDays: e.last - e.first + 1,
        spots: e.spots, spend: r0(e.spend), mainChannels: topN(e.ch, 3, x => x[0]).map(([c]) => chName(c)),
        mainDurationSec: mainDur ? mainDur[0] : null, language: lg ? dicts.lng[lg[0]] : null,
      };
    });
    if (np > 0) {
      base.duration = A.durN ? {
        spotsWithDuration: A.durN,
        spotCount: Object.fromEntries(BUCKETS.map((b, i) => [b, A.dur[i]])),
        spotPct: Object.fromEntries(BUCKETS.map((b, i) => [b, pct(A.dur[i], A.durN)])),
        acdSeconds: r1(A.durSum / A.durN),
      } : null;
      base.placement = {
        basis: 'TV and Radio spots only (Press has no break data)',
        programmePosition: A.apN ? {
          firstThreePct: pct(A.ap3, A.apN), lastThreePct: pct(A.apLast3, A.apN), middlePct: pct(A.apMid, A.apN), spotsMeasured: A.apN,
        } : (A.lblN ? { note: 'AdPos holds Start / Mid / End labels in this file', startPct: pct(A.lbl.Start, A.lblN), midPct: pct(A.lbl.Mid, A.lblN), endPct: pct(A.lbl.End, A.lblN), spotsMeasured: A.lblN } : null),
        breakPosition: A.bpN ? { firstPct: pct(A.bpFirst, A.bpN), lastPct: pct(A.bpLast, A.bpN), middlePct: pct(A.bpMid, A.bpN), spotsMeasured: A.bpN } : null,
        breakNumber: A.bkN ? { break1Pct: pct(A.bk1, A.bkN), break2Pct: pct(A.bk2, A.bkN), break3PlusPct: pct(A.bk3, A.bkN) } : null,
        avgBreakClutter: A.clutterN ? r1(A.clutterSum / A.clutterN) : null,
      };
    } else { base.duration = null; base.placement = null; }
    base.language = A.lngN ? Object.fromEntries(topN(A.lng, 6, x => x).map(([l, n]) => [dicts.lng[l], pct(n, A.lngN)])) : null;
    base.frequency = {
      spotsPerActiveDay: A.days.size ? r1(A.spots / A.days.size) : null,
      spotsPerProgrammeAiring: A.airings.size ? r1(np / A.airings.size) : null,
      activeDays: A.days.size,
    };
    base.valueAddition = vaBlock(A);
    base._d30 = A.d30Total ? topN(A.d30, 1, x => x).map(([pk, n]) => ({ ...progOf(pk), pct: pct(n, A.d30Total) }))[0] : null;
    return base;
  }
  function vaBlock(A) {
    const all = A.spots + A.va.spots;
    return {
      spots: A.va.spots, spendAtRate: r0(A.va.spend), shareOfAiringsPct: pct(A.va.spots, all),
      topChannels: topN(A.va.ch, 5, e => e[1]).map(([c, [, n]]) => ({ channel: chName(c), spots: n })),
      topItems: topN(A.va.themes, 5, e => e[1]).map(([t, [, n]]) => ({ item: dicts.theme[t], spots: n })),
    };
  }

  const profiles = names.map((n, k) => profile(n, k));
  const mine = hasMine ? profiles[0] : null;
  const comps = profiles.filter(p => p.role === 'competitor');

  // ---- category summary ----
  const categorySummary = {
    totalSpend: r0(catSpend), totalSpots: catSpots, valueAdditionSpots: catVaSpots,
    spendByMedium: Object.fromEntries(MEDIA.map((m, i) => [m, { spend: r0(catMed[i]), spots: catMedSpots[i], spendPct: pct(catMed[i], catSpend) }])),
    monthlySpend: periodMonthKeys.map(m => { const e = catMon.get(m); return { month: monthKeyOf(m), spend: e ? r0(e[0]) : 0, spots: e ? e[1] : 0 }; }),
    topChannels: topN(catCh, 10, e => e[0]).map(([c, [s, n]]) => ({ channel: chName(c), medium: MEDIA[chMed[c]], spend: r0(s), spots: n, sharePct: pct(s, catSpend) })),
    topPrograms: topN(catProg, 10, e => e[0]).map(([pk, [s, n]]) => ({ ...progOf(pk), spend: r0(s), spots: n, sharePct: pct(s, catSpend) })),
  };

  // ---- comparison ----
  const shareOfSpend = profiles.map(p => ({ advertiser: p.name, role: p.role, spend: p.totals.spend, sharePct: p.totals.shareOfSpendPct, rank: p.totals.rank }));
  const selSpend = profiles.reduce((s, p) => s + p.totals.spend, 0);
  shareOfSpend.push({ advertiser: 'All other advertisers', role: 'other', spend: r0(catSpend - selSpend), sharePct: pct(catSpend - selSpend, catSpend), rank: null });
  shareOfSpend.sort((x, y) => y.spend - x.spend);

  const gaps = hasMine && comps.length ? findGaps() : [];
  function findGaps() {
    const out = [];
    const M = accs[0];
    const cAccs = accs.slice(1);
    const cNames = names.slice(1);
    const share = (A, s) => (A.spend > 0 ? (s / A.spend) * 100 : 0);
    const leaders = (get) => cAccs.map((A, j) => ({ advertiser: cNames[j], ...get(A) })).filter(x => x.spend > 0).sort((a, b) => b.spend - a.spend);
    // channels
    const chRows = [];
    const chIds = new Set(); cAccs.forEach(A => A.ch.forEach((_, c) => chIds.add(c)));
    for (const c of chIds) {
      const mineE = M.ch.get(c) || [0, 0];
      const ls = leaders(A => { const e = A.ch.get(c) || [0, 0]; return { spend: r0(e[0]), spots: e[1], shareOfTheirSpendPct: pct(e[0], A.spend) }; });
      const best = ls[0]; if (!best) continue;
      const myShare = share(M, mineE[0]);
      const type = mineE[1] === 0 && best.shareOfTheirSpendPct >= 2 ? 'absent' : mineE[1] > 0 && myShare < best.shareOfTheirSpendPct - 10 && myShare < 0.5 * best.shareOfTheirSpendPct ? 'underweight' : null;
      if (type) chRows.push({ type: 'channel', gap: type, name: chName(c), medium: MEDIA[chMed[c]], mySpots: mineE[1], mySpend: r0(mineE[0]), myShareOfMySpendPct: pct(mineE[0], M.spend), competitors: ls.slice(0, 3), _w: ls.reduce((s, x) => s + x.spend, 0) });
    }
    chRows.sort((a, b) => b._w - a._w);
    out.push(...chRows.filter(x => x.gap === 'absent').slice(0, 8), ...chRows.filter(x => x.gap === 'underweight').slice(0, 4));
    // programmes
    const pIds = new Set(); cAccs.forEach(A => A.prog.forEach((_, pk) => pIds.add(pk)));
    const pRows = [];
    for (const pk of pIds) {
      if (M.prog.get(pk)) continue;
      const ls = leaders(A => { const e = A.prog.get(pk) || [0, 0]; return { spend: r0(e[0]), spots: e[1], shareOfTheirSpendPct: pct(e[0], A.spend) }; });
      if (ls[0]) pRows.push({ type: 'programme', gap: 'absent', name: progOf(pk).programme, channel: progOf(pk).channel, mySpots: 0, mySpend: 0, competitors: ls.slice(0, 3), _w: ls.reduce((s, x) => s + x.spend, 0) });
    }
    pRows.sort((a, b) => b._w - a._w);
    out.push(...pRows.slice(0, 8));
    // dayparts and hour bands (percentage points against the average competitor)
    const withTime = cAccs.filter(A => A.timed > 0);
    if (M.timed > 0 && withTime.length) {
      const avg = fn => withTime.reduce((s, A) => s + fn(A), 0) / withTime.length;
      const rows = [
        ['Prime Time', M.primeSpots / M.timed * 100, avg(A => A.primeSpots / A.timed * 100)],
        ['Non-Prime', M.nonPrimeSpots / M.timed * 100, avg(A => A.nonPrimeSpots / A.timed * 100)],
        ...BANDS.map((b, i) => ['Hour band ' + b, M.hbSpots[i] / M.timed * 100, avg(A => A.hbSpots[i] / A.timed * 100)]),
      ];
      for (const [nm, mp, cp] of rows) if (cp - mp >= 10) out.push({ type: 'daypart', gap: 'underweight', name: nm, myPctOfSpots: r1(mp), competitorAvgPctOfSpots: r1(cp), differencePts: r1(cp - mp) });
    }
    // months where competitors are on air and we are not
    const mRows = [];
    for (const m of periodMonthKeys) {
      const mineE = M.mon.get(m);
      const ls = leaders(A => { const e = A.mon.get(m) || [0, 0]; return { spend: r0(e[0]), spots: e[1] }; });
      if (!mineE && ls.length) mRows.push({ type: 'month', gap: 'absent', name: monthKeyOf(m), mySpots: 0, mySpend: 0, competitors: ls.slice(0, 3), _w: ls.reduce((s, x) => s + x.spend, 0) });
    }
    mRows.sort((a, b) => b._w - a._w);
    out.push(...mRows.slice(0, 6));
    // plain-English line for each gap
    const mySos = mine.totals.shareOfSpendPct;
    for (const g of out) {
      const c0 = g.competitors && g.competitors[0];
      if (g.type === 'channel') g.text = g.gap === 'absent'
        ? `We have ${fmtPct(mySos)} share of spend but 0 spots on ${g.name} where ${c0.advertiser} has ${fmtPct(c0.shareOfTheirSpendPct)} of its spend (${money(c0.spend)}).`
        : `On ${g.name} we put ${fmtPct(g.myShareOfMySpendPct)} of our spend but ${c0.advertiser} puts ${fmtPct(c0.shareOfTheirSpendPct)} of its spend.`;
      else if (g.type === 'programme') g.text = `We have 0 spots on ${g.name} (${g.channel}) where ${c0.advertiser} has ${c0.spots} spots worth ${money(c0.spend)}.`;
      else if (g.type === 'daypart') g.text = `${g.name} carries ${fmtPct(g.myPctOfSpots)} of our spots but ${fmtPct(g.competitorAvgPctOfSpots)} of the average competitor's spots (${g.differencePts} points more).`;
      else if (g.type === 'month') g.text = `We have no spots in ${monthName(g.name)} while ${c0.advertiser} spends ${money(c0.spend)} (${c0.spots} spots).`;
      delete g._w;
    }
    return out;
  }

  // ---- facts ----
  const facts = [];
  const add = (score, text) => facts.push({ score, text });
  const sosOf = p => p.totals.shareOfSpendPct || 0;
  const nm = p => (p.role === 'mine' ? 'We' : p.name);
  const poss = p => (p.role === 'mine' ? 'our' : 'its');
  profiles.forEach(p => {
    if (!p.totals.spots) { add(40, `${nm(p)} ${p.role === 'mine' ? 'have' : 'has'} no spots in this period.`); return; }
    const w = sosOf(p) * 0.3, N = nm(p), have = p.role === 'mine' ? 'have' : 'has';
    add(85 + w, `${N} ${have} ${fmtPct(p.totals.shareOfSpendPct)} share of spend (rank ${p.totals.rank} of ${p.totals.rankOf}): ${money(p.totals.spend)} over ${p.totals.spots.toLocaleString('en-US')} spots, ${money(p.totals.avgCostPerSpot)} per spot.`);
    const c0 = p.byChannel[0];
    if (c0 && c0.shareOfAdvertiserSpendPct >= 20) {
      const pr = p.daypart && p.daypart.primePct.spots;
      const np_ = p.daypart && p.daypart.nonPrimePct.spots;
      const tail = p.daypart && pr != null ? (pr >= 50 ? `, mostly in Prime Time (${fmtPct(pr)} of ${poss(p)} timed spots)` : np_ >= 50 ? `, mostly in Non-Prime time (${fmtPct(np_)} of ${poss(p)} timed spots)` : `, with ${fmtPct(pr)} of ${poss(p)} timed spots in Prime Time`) : '';
      add(70 + w + c0.shareOfAdvertiserSpendPct / 10, `${N} ${p.role === 'mine' ? 'spend' : 'spends'} ${fmtPct(c0.shareOfAdvertiserSpendPct)} of ${poss(p) === 'our' ? 'our' : 'its'} budget on ${c0.channel}${tail}.`);
    }
    const fl = p.flighting;
    if (fl && fl.pattern) {
      const lens = fl.flights.map(x => x.weeks), lo = Math.min(...lens), hi = Math.max(...lens);
      const span = lo === hi ? `${lo} week${lo === 1 ? '' : 's'}` : `${lo} to ${hi} weeks`;
      const quiet = fl.inactiveMonths.length ? `, no activity in ${fl.inactiveMonths.slice(0, 3).map(monthName).join(', ')}` : '';
      const peak = fl.peakMonth ? `, peak in ${monthName(fl.peakMonth.month)}` : '';
      const run = p.role === 'mine' ? 'run' : 'runs';
      const flights = fl.flightCount === 1 ? `1 flight of ${span}` : `${fl.flightCount} flights of ${span} each`;
      const text = fl.pattern === 'continuous' ? `${N} ${run} continuously: active in ${fl.activeWeeks} of ${fl.periodWeeks} weeks${peak}${quiet}.`
        : fl.pattern === 'pulsing' ? `${N} ${run} in pulses: ${flights}${peak}${quiet}.`
        : fl.pattern === 'seasonal' ? `${N} ${run} seasonally: ${flights}${peak}${quiet}.`
        : `${N} ${run} in bursts: ${flights}${peak}${quiet}.`;
      add(68 + w, text);
    }
    const pl = p.placement;
    if (pl && pl.breakPosition) {
      const d30 = p._d30 && p._d30.pct >= 30 ? `, and ${fmtPct(p._d30.pct)} of ${poss(p)} 30s spots are in programme ${p._d30.programme}` : '';
      add(66 + w, `${N} ${p.role === 'mine' ? 'take' : 'takes'} the first position in the break in ${fmtPct(pl.breakPosition.firstPct)} of spots (last position: ${fmtPct(pl.breakPosition.lastPct)})${d30}.`);
    }
    if (pl && pl.programmePosition && pl.programmePosition.firstThreePct != null)
      add(52 + w, `${N}: ${fmtPct(pl.programmePosition.firstThreePct)} of ${poss(p)} TV and Radio ads sit in the first 3 positions of the programme and ${fmtPct(pl.programmePosition.lastThreePct)} in the last 3.`);
    if (pl && pl.avgBreakClutter != null) add(46 + w, `${N} ${p.role === 'mine' ? 'air' : 'airs'} into breaks with an average of ${pl.avgBreakClutter} ads${pl.breakNumber ? `, ${fmtPct(pl.breakNumber.break1Pct)} of spots in the first break` : ''}.`);
    if (p.duration) {
      const best = Object.entries(p.duration.spotPct).sort((a, b) => (b[1] || 0) - (a[1] || 0))[0];
      add(55 + w, `${N} ${p.role === 'mine' ? 'use' : 'uses'} ${best[0]} spots most (${fmtPct(best[1])} of TV and Radio spots), average duration ${p.duration.acdSeconds}s.`);
    }
    if (p.daypart) {
      const hb = [...p.daypart.hourBands].sort((a, b) => (b.spotsPct || 0) - (a.spotsPct || 0))[0];
      if (hb && hb.spotsPct >= 30) add(50 + w, `${N}: ${fmtPct(hb.spotsPct)} of ${poss(p)} timed spots air between ${hb.band.slice(0, 2)}:00 and ${hb.band.slice(3)}:00.`);
    }
    const dw = p.dayOfWeek;
    if (dw.weekendPct != null && (dw.weekendPct >= 38 || dw.weekendPct <= 18)) add(44 + w, `${N} ${p.role === 'mine' ? 'put' : 'puts'} ${fmtPct(dw.weekendPct)} of spots on weekends (${fmtPct(dw.weekdayPct)} on weekdays).`);
    if (p.language) { const [l, v] = Object.entries(p.language)[0]; if (v >= 50) add(40 + w, `${N}: ${fmtPct(v)} of ${poss(p)} spots are in ${l}.`); }
    if (p.frequency.spotsPerActiveDay != null) add(42 + w, `${N} ${p.role === 'mine' ? 'air' : 'airs'} ${p.frequency.spotsPerActiveDay} spots on an average active day${p.frequency.spotsPerProgrammeAiring != null ? ` and ${p.frequency.spotsPerProgrammeAiring} per programme airing` : ''}.`);
    if (p.valueAddition.shareOfAiringsPct >= 5) add(38 + w, `${N}: ${fmtPct(p.valueAddition.shareOfAiringsPct)} of ${poss(p)} airings are value additions (${p.valueAddition.spots} items), kept out of the spot and spend totals.`);
  });
  gaps.forEach(g => add(g.type === 'channel' || g.type === 'programme' ? 95 : 80, g.text));
  facts.sort((a, b) => b.score - a.score);
  const factList = facts.slice(0, MAX_FACTS).map(x => x.text);

  profiles.forEach(p => { delete p._d30; });

  const payload = {
    schemaVersion: SCHEMA_VERSION,
    generatedAt: new Date().toISOString(),
    dataDictionary: DATA_DICTIONARY,
    context: {
      productGroup: f.pg, dateFrom: toIso(r.from), dateTo: toIso(r.to),
      mediums: r.mediumId >= 0 ? [MEDIA[r.mediumId]] : MEDIA.slice(), currency: 'LKR',
      myAdvertiser: hasMine ? myLabel : null, competitors: compNames,
      filters: { productGroup: f.pg, dateFrom: f.from, dateTo: f.to, medium: r.mediumId >= 0 ? MEDIA[r.mediumId] : 'All', channel: f.channel || null, timeOfDay: f.slot || null, adType: f.adType || 'All', tagCountedAsCommercial: !!f.tagCommercial },
      valueAdditionRule: vaMode === 'theme' ? 'value-addition themes only' : vaMode === 'zeroCost' ? 'Cost = 0 only' : 'value-addition themes or Cost = 0',
    },
    categorySummary,
    advertisers: profiles,
    comparison: { shareOfSpend, gapsAndOpportunities: gaps },
    facts: factList,
    meta: { rowsMatched: matched, warnings, payloadBytes: 0, trimmed: [] },
  };
  return fitSize(payload);
}

// Keep the payload under 200 KB by trimming the detailed lists first, and say what was trimmed.
function fitSize(p) {
  const size = () => Buffer_byteLength(JSON.stringify(p));
  const steps = [
    ['weekly detail to 26 weeks', () => p.advertisers.forEach(a => { if (a.flighting) a.flighting.weekly = a.flighting.weekly.slice(-26); })],
    ['programmes and channels to top 5', () => p.advertisers.forEach(a => { a.byProgram = a.byProgram.slice(0, 5); a.byChannel = a.byChannel.slice(0, 5); })],
    ['campaigns to top 8', () => p.advertisers.forEach(a => { if (a.campaigns) a.campaigns = a.campaigns.slice(0, 8); })],
    ['weekly detail removed', () => p.advertisers.forEach(a => { if (a.flighting) a.flighting.weekly = []; })],
    ['gaps to 10', () => { p.comparison.gapsAndOpportunities = p.comparison.gapsAndOpportunities.slice(0, 10); }],
  ];
  let bytes = size();
  for (const [label, fn] of steps) {
    if (bytes <= MAX_BYTES) break;
    fn(); p.meta.trimmed.push(label); bytes = size();
  }
  p.meta.payloadBytes = bytes;
  if (bytes > MAX_BYTES) p.meta.warnings.push('The brief is still larger than 200 KB; pick fewer competitors or a shorter period.');
  return p;
}
function Buffer_byteLength(s) { return typeof Buffer !== 'undefined' ? Buffer.byteLength(s) : new TextEncoder().encode(s).length; }

module.exports = { buildBrief, rankAdvertisers, SCHEMA_VERSION, MAX_BYTES, DATA_DICTIONARY };
