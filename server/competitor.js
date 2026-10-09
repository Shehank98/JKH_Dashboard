'use strict';
// Competitor intelligence package for the media planning tool: what each advertiser bought for the current
// dashboard filters, by channel, programme, break (Start / Mid / End and position in the break), break number,
// length, hour and day, daypart, month, week and campaign. Plain JSON rows, ready for Chart.js.
// Runs in the browser engine (and in Node for tests); same filters and rules as the dashboard.

const D = require('./derive');

const FORMAT = 'ogilvy-orbit-chub/competitor-intel';
const VERSION = 1;
const MAX_PROGRAMMES_PER_ADVERTISER = 200;
const POSITIONS = ['First', 'Second', 'Middle', 'Second last', 'Last', 'Only ad', 'Unknown'];
const BREAKS = ['Start', 'Mid', 'End', 'Unknown'];
const DAYS = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'];

const toDay = iso => Math.round(Date.parse(iso + 'T00:00:00Z') / 86400000);
const toIso = day => new Date(day * 86400000).toISOString().slice(0, 10);
const monthKey = mon => `${Math.floor(mon / 12)}-${String((mon % 12) + 1).padStart(2, '0')}`;
const r1 = v => Math.round(v * 10) / 10;
const r2 = v => Math.round(v * 100) / 100;
const pct = (v, t) => (t > 0 ? r2((v / t) * 100) : 0);

function positionOf(pos, ads) {
  if (!pos) return 'Unknown';
  if (ads === 1) return 'Only ad';
  if (pos === 1) return 'First';
  if (ads && pos === ads) return 'Last';
  if (pos === 2) return 'Second';
  if (ads && pos === ads - 1) return 'Second last';
  return 'Middle';
}
function breakOf(label) {
  const s = String(label || '').trim().toLowerCase();
  if (s.startsWith('start') || s === 'opening' || s === 'open') return 'Start';
  if (s.startsWith('mid') || s === 'middle' || s === 'centre' || s === 'center') return 'Mid';
  if (s.startsWith('end') || s === 'closing' || s === 'close') return 'End';
  return 'Unknown';
}

function competitorIntel(ds, f, meta = {}) {
  const { dicts, cols } = ds;
  const nAdv = dicts.adv.length;
  const pgId = dicts.pg.indexOf(f.pg);
  if (pgId < 0) throw new Error('Unknown product group');
  const from = toDay(f.from), to = toDay(f.to);
  if (!(to >= from)) throw new Error('Invalid date range');
  const mediumId = D.MEDIA.indexOf(f.medium);
  const chId = f.channel ? dicts.channel.indexOf(f.channel) : -1;
  const dpId = f.daypart ? D.DAYPARTS.indexOf(f.daypart) : -1;
  const adType = f.adType === 'Sponsorship' ? 2 : f.adType === 'Commercial' ? 1 : 0;
  const role = new Uint8Array(nAdv);
  for (const n of f.comps || []) { const i = dicts.adv.indexOf(n); if (i >= 0) role[i] = 2; }
  for (const n of f.mine || []) { const i = dicts.adv.indexOf(n); if (i >= 0) role[i] = 1; }
  const excluded = dicts.theme.map(t => (D.isExcludedTheme(t) ? 1 : 0));
  // Datasets loaded before programmes and breaks were kept do not have these columns.
  const hasDetail = !!(cols.prog && cols.adPos && cols.brk && cols.pos && cols.ads && cols.hour && dicts.program);
  const breakIds = hasDetail ? dicts.adPos.map(breakOf) : [];

  const { pg, adv, ch, theme, day, mon, dp, cost } = cols;
  const durRaw = cols.durRaw || null;
  const chMed = dicts.channelMedium;
  const A = new Map(); // advertiser id -> aggregates
  const get = a => {
    let x = A.get(a);
    if (!x) {
      x = { spend: 0, spots: 0, va: 0, med: [0, 0, 0], acdS: 0, acdN: 0, first: Infinity, last: -Infinity,
        ch: new Map(), prog: new Map(), brk: new Map(), brkNo: new Map(), dur: new Map(), hour: new Map(), dp: new Map(),
        mon: new Map(), week: new Map(), camp: new Map() };
      A.set(a, x);
    }
    return x;
  };
  const add = (m, k, v, extra) => { let e = m.get(k); if (!e) { e = { spend: 0, spots: 0, ...(extra || {}) }; m.set(k, e); } e.spend += v; e.spots++; return e; };
  let catSpend = 0, catSpots = 0;
  const chTotal = new Map(), monTotal = new Map();

  for (let i = 0, n = pg.length; i < n; i++) {
    if (pg[i] !== pgId) continue;
    const d = day[i];
    if (d < from || d > to) continue;
    const c = ch[i], md = chMed[c];
    if (mediumId >= 0 && md !== mediumId) continue;
    if (chId >= 0 && c !== chId) continue;
    if (dpId >= 0 && dp[i] !== dpId) continue;
    const sponsor = excluded[theme[i]] === 1;
    if (adType && (sponsor ? 2 : 1) !== adType) continue;
    const a = adv[i], v = cost[i], x = get(a);
    catSpend += v; catSpots++;
    chTotal.set(c, (chTotal.get(c) || 0) + v);
    monTotal.set(mon[i], (monTotal.get(mon[i]) || 0) + v);
    x.spend += v; x.spots++;
    if (sponsor) x.va += v;
    x.med[md] += v;
    if (d < x.first) x.first = d;
    if (d > x.last) x.last = d;
    add(x.ch, c, v);
    add(x.dp, dp[i], v);
    add(x.mon, mon[i], v);
    const dow = (d + 3) % 7; // 1970-01-01 was a Thursday; 0 = Monday
    add(x.week, d - dow, v);
    const cp = add(x.camp, theme[i], v, { first: d, last: d, chs: new Map() });
    if (d < cp.first) cp.first = d;
    if (d > cp.last) cp.last = d;
    cp.chs.set(c, (cp.chs.get(c) || 0) + v);
    let secs = NaN;
    if (md < 2) {
      const raw = durRaw ? durRaw[i] : NaN;
      const b = D.durBucketOf(raw, sponsor);
      if (b < D.DUR_BUCKETS.length) add(x.dur, md * 16 + b, v);
      secs = D.durSecondsOf(raw, sponsor);
      if (secs > 0) { x.acdS += secs; x.acdN++; }
    }
    if (hasDetail) {
      const h = cols.hour[i];
      if (h !== 255) add(x.hour, dow * 24 + h, v);
      const pos = positionOf(cols.pos[i], cols.ads[i]), brk = breakIds[cols.adPos[i]];
      add(x.brk, brk + '|' + pos, v);
      if (cols.brk[i]) add(x.brkNo, Math.min(cols.brk[i], 10), v);
      if (md < 2) {
        const pr = add(x.prog, c * 1e7 + cols.prog[i], v, { secS: 0, secN: 0, first: d, last: d, days: new Set(), hours: new Map(), months: new Set(), brk: {}, pos: {} });
        if (secs > 0) { pr.secS += secs; pr.secN++; }
        if (d < pr.first) pr.first = d;
        if (d > pr.last) pr.last = d;
        pr.days.add(dow); pr.months.add(mon[i]);
        if (h !== 255) pr.hours.set(h, (pr.hours.get(h) || 0) + 1);
        pr.brk[brk] = (pr.brk[brk] || 0) + 1;
        pr.pos[pos] = (pr.pos[pos] || 0) + 1;
      }
    }
  }

  const ids = [...A.keys()].sort((x, y) => A.get(y).spend - A.get(x).spend);
  const name = a => dicts.adv[a];
  const roleOf = a => (role[a] === 1 ? 'mine' : role[a] === 2 ? 'competitor' : 'other');
  const chName = c => dicts.channelName[c];
  const rows = (fn) => { const out = []; for (const a of ids) fn(a, A.get(a), out); return out; };
  const byMonth = (m) => [...m.keys()].sort((x, y) => x - y);

  const advertisers = ids.map((a, k) => ({ rank: k + 1, name: name(a), role: roleOf(a) }));
  const summary = rows((a, x, out) => {
    const progs = new Set([...x.prog.keys()]);
    out.push({
      advertiser: name(a), role: roleOf(a), spend: Math.round(x.spend), sos: pct(x.spend, catSpend), spots: x.spots, sov: pct(x.spots, catSpots),
      avgCostPerSpot: Math.round(x.spend / x.spots), acd: x.acdN ? r1(x.acdS / x.acdN) : null,
      activeMonths: x.mon.size, activeWeeks: x.week.size, channels: x.ch.size, programmes: progs.size, campaigns: x.camp.size,
      tvShare: pct(x.med[0], x.spend), radioShare: pct(x.med[1], x.spend), pressShare: pct(x.med[2], x.spend),
      valueAdditionsShare: pct(x.va, x.spend), firstSpot: toIso(x.first), lastSpot: toIso(x.last),
    });
  });
  const channels = rows((a, x, out) => {
    for (const [c, e] of [...x.ch].sort((p, q) => q[1].spend - p[1].spend)) {
      out.push({ advertiser: name(a), medium: D.MEDIA[chMed[c]], channel: chName(c), spend: Math.round(e.spend), spots: e.spots,
        shareOfAdvertiser: pct(e.spend, x.spend), shareOfChannel: pct(e.spend, chTotal.get(c)) });
    }
  });
  let programmesOmitted = 0;
  const programmes = rows((a, x, out) => {
    const list = [...x.prog].sort((p, q) => q[1].spend - p[1].spend);
    programmesOmitted += Math.max(0, list.length - MAX_PROGRAMMES_PER_ADVERTISER);
    for (const [key, e] of list.slice(0, MAX_PROGRAMMES_PER_ADVERTISER)) {
      const c = Math.floor(key / 1e7), p = key % 1e7;
      const topHour = [...e.hours].sort((s, t) => t[1] - s[1])[0];
      out.push({
        advertiser: name(a), medium: D.MEDIA[chMed[c]], channel: chName(c), programme: dicts.program[p],
        spend: Math.round(e.spend), spots: e.spots, shareOfAdvertiser: pct(e.spend, x.spend),
        avgDuration: e.secN ? r1(e.secS / e.secN) : null, usualHour: topHour ? topHour[0] : null,
        airDays: [...e.days].sort().map(k => DAYS[k]), months: e.months.size, firstSpot: toIso(e.first), lastSpot: toIso(e.last),
        breaks: Object.fromEntries(BREAKS.map(b => [b, e.brk[b] || 0])), positions: Object.fromEntries(POSITIONS.map(b => [b, e.pos[b] || 0])),
      });
    }
  });
  const breakPositions = rows((a, x, out) => {
    for (const b of BREAKS) for (const p of POSITIONS) {
      const e = x.brk.get(b + '|' + p);
      if (e) out.push({ advertiser: name(a), breakInProgramme: b, positionInBreak: p, spots: e.spots, spend: Math.round(e.spend), shareOfSpots: pct(e.spots, x.spots) });
    }
  });
  const breakNumbers = rows((a, x, out) => {
    for (const k of [...x.brkNo.keys()].sort((p, q) => p - q)) {
      const e = x.brkNo.get(k);
      out.push({ advertiser: name(a), breakNo: k === 10 ? '10+' : String(k), spots: e.spots, spend: Math.round(e.spend) });
    }
  });
  const durations = rows((a, x, out) => {
    for (const [k, e] of [...x.dur].sort((p, q) => p[0] - q[0])) {
      out.push({ advertiser: name(a), medium: D.MEDIA[Math.floor(k / 16)], length: D.DUR_BUCKETS[k % 16], spots: e.spots, spend: Math.round(e.spend) });
    }
  });
  const hours = rows((a, x, out) => {
    for (const [k, e] of [...x.hour].sort((p, q) => p[0] - q[0])) {
      out.push({ advertiser: name(a), day: DAYS[Math.floor(k / 24)], dayIndex: Math.floor(k / 24), hour: k % 24, spots: e.spots, spend: Math.round(e.spend) });
    }
  });
  const dayparts = rows((a, x, out) => {
    for (const [k, e] of [...x.dp].sort((p, q) => p[0] - q[0])) {
      out.push({ advertiser: name(a), daypart: D.DAYPARTS[k], time: D.DAYPART_TIMES[k], spots: e.spots, spend: Math.round(e.spend), shareOfAdvertiser: pct(e.spend, x.spend) });
    }
  });
  const months = rows((a, x, out) => {
    for (const k of byMonth(x.mon)) {
      const e = x.mon.get(k);
      out.push({ advertiser: name(a), month: monthKey(k), spend: Math.round(e.spend), spots: e.spots, sos: pct(e.spend, monTotal.get(k)) });
    }
  });
  const weeks = rows((a, x, out) => {
    for (const k of byMonth(x.week)) { const e = x.week.get(k); out.push({ advertiser: name(a), weekStart: toIso(k), spend: Math.round(e.spend), spots: e.spots }); }
  });
  const campaigns = rows((a, x, out) => {
    for (const [t, e] of [...x.camp].sort((p, q) => q[1].spend - p[1].spend).slice(0, 25)) {
      out.push({ advertiser: name(a), campaign: dicts.theme[t], type: excluded[t] ? 'Value Addition' : 'Commercial',
        spend: Math.round(e.spend), spots: e.spots, shareOfAdvertiser: pct(e.spend, x.spend), firstSpot: toIso(e.first), lastSpot: toIso(e.last),
        channels: [...e.chs].sort((p, q) => q[1] - p[1]).map(([c]) => chName(c)) });
    }
  });

  const warnings = [];
  if (!hasDetail) warnings.push('This data was loaded before programmes and breaks were kept. Load the file again in the dashboard to include programmes, breaks, positions and hours.');
  if (programmesOmitted) warnings.push(`${programmesOmitted} smaller programme rows left out (top ${MAX_PROGRAMMES_PER_ADVERTISER} per advertiser kept).`);
  const nMonths = (() => { const a = new Date(from * 86400000), b = new Date(to * 86400000); return (b.getUTCFullYear() - a.getUTCFullYear()) * 12 + b.getUTCMonth() - a.getUTCMonth() + 1; })();
  return {
    format: FORMAT, version: VERSION,
    generatedAt: new Date().toISOString(), generatedBy: meta.user || '', source: { app: 'Ogilvy Orbit Chub Live Dashboard', file: ds.meta.fileName || '' },
    currency: 'LKR', spendBasis: 'rate card',
    filters: { category: f.pg, from: toIso(from), to: toIso(to), months: nMonths, medium: f.medium || 'All', channel: f.channel || 'All',
      daypart: f.daypart || 'All', adType: { Sponsorship: 'Value Additions', Commercial: 'Commercials' }[f.adType] || 'All',
      mine: f.mine || [], competitors: f.comps || [] },
    totals: { spend: Math.round(catSpend), spots: catSpots, advertisers: ids.length },
    lists: { positionsInBreak: POSITIONS, breaksInProgramme: BREAKS, lengths: D.DUR_BUCKETS, dayparts: D.DAYPARTS, days: DAYS },
    advertisers, summary, channels, programmes, breakPositions, breakNumbers, durations, hours, dayparts, months, weeks, campaigns,
    warnings,
  };
}

module.exports = { competitorIntel, FORMAT, VERSION };
