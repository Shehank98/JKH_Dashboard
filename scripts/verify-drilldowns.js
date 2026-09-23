'use strict';
// Independent check of every click-through in the dashboard.
// It re-reads the raw CSV into plain rows, re-implements the filtering rules on its own,
// builds exactly the scopes the page sends when you click (plus clicks inside the pop-up),
// and compares every row of every pop-up table with what the server returns.
// Usage: node scripts/verify-drilldowns.js samples/sample_420000.csv
const fs = require('fs');
const { parse } = require('csv-parse');
const { ingestFile } = require('../server/ingest');
const compute = require('../server/compute');

// ---------- independent rules (deliberately not imported from the app) ----------
const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
const mediumOf = ch => (/\bTV\b/i.test(ch) ? 'TV' : /\bFM\b/i.test(ch) || /^Radio\s*-/i.test(ch) ? 'Radio' : 'Press');
function daypartOf(t) {
  const m = String(t || '').match(/^(\d{1,2}):(\d{2})/);
  if (!m) return 'Not timed';
  const x = (Number(m[1]) % 24) * 60 + Number(m[2]);
  return x < 300 ? 'Late night' : x < 720 ? 'Morning' : x < 1110 ? 'Daytime' : x < 1350 ? 'Prime' : 'Late night';
}
function bucketOf(d) {
  if (!(d > 0)) return null;
  if (d < 10) return '5s';
  if (d > 30) return '30s+';
  if (d <= 17.5) return '15s';   // 15 vs 20: a tie goes to the shorter standard
  if (d <= 25) return '20s';     // 25 is a tie between 20 and 30, goes to 20
  return '30s';
}
const SPONSOR = ['-bb', 'com break', 'dj', '-extro', '-intro', '-llogo', 'next card', 'tag', 'time check', '-tr'];
const isSponsor = t => { const x = String(t || '').trim().toLowerCase(); return SPONSOR.some(s => x === s || (s[0] === '-' && x.endsWith(s))); };
const iso = (y, m, d) => `${y}-${String(m).padStart(2, '0')}-${String(d).padStart(2, '0')}`;

async function readRows(file) {
  const rows = [];
  let head = null;
  for await (const r of fs.createReadStream(file).pipe(parse({ bom: true, relax_column_count: true }))) {
    if (!head) { head = r; continue; }
    const o = {}; head.forEach((h, i) => { o[h] = r[i]; });
    const y = +o.Yr, m = +o.Mn, d = +o.Dd;
    const dt = new Date(Date.UTC(y, m - 1, d));
    if (!(dt.getUTCDate() === d && dt.getUTCMonth() === m - 1)) continue; // invalid date, skipped by the app too
    const ch = String(o.Channel).trim();
    rows.push({
      pg: String(o.Product_Group).trim(), adv: String(o.Advertiser).trim(), theme: String(o.Advt_Theme || '').trim() || '(blank)',
      channel: ch, medium: mediumOf(ch), date: iso(y, m, d), month: iso(y, m, 1).slice(0, 7),
      daypart: daypartOf(o.Advt_time), bucket: bucketOf(Number(o.Dur)), cost: Number(String(o.Cost).replace(/,/g, '')) || 0,
    });
  }
  return rows;
}

// Reference pop-up: filter the plain rows by the dashboard filters and the click scope.
function reference(rows, f, sc) {
  const mine = new Set(f.mine), comps = new Set(f.comps), excl = new Set(sc.exclude || []);
  const from = sc.from && sc.from > f.from ? sc.from : f.from, to = sc.to && sc.to < f.to ? sc.to : f.to;
  const out = { total: 0, spots: 0, mineTotal: 0, adv: new Map(), ch: new Map(), camp: new Map() };
  for (const r of rows) {
    if (r.pg !== f.pg || r.date < from || r.date > to) continue;
    if (f.medium !== 'All' && r.medium !== f.medium) continue;
    if (f.channel && r.channel !== f.channel) continue;
    if (f.daypart && r.daypart !== f.daypart) continue;
    if (f.adType === 'Sponsorship' && !isSponsor(r.theme)) continue;
    if (f.adType === 'Commercial' && isSponsor(r.theme)) continue;
    if (sc.month && r.month !== sc.month) continue;
    if (sc.medium && r.medium !== sc.medium) continue;
    if (sc.channel && r.channel !== sc.channel) continue;
    if (excl.has(r.channel)) continue;
    if (sc.advertiser && r.adv !== sc.advertiser) continue;
    if (sc.mine && !mine.has(r.adv)) continue;
    if (sc.theme != null && r.theme !== sc.theme) continue;
    if (sc.dur && (r.medium === 'Press' || r.bucket !== sc.dur)) continue;
    out.total += r.cost; out.spots++;
    const isMine = mine.has(r.adv);
    if (isMine) out.mineTotal += r.cost;
    const a = out.adv.get(r.adv) || { spend: 0, spots: 0, role: isMine ? 'mine' : comps.has(r.adv) ? 'comp' : '' };
    a.spend += r.cost; a.spots++; out.adv.set(r.adv, a);
    const c = out.ch.get(r.channel) || { spend: 0, spots: 0, mine: 0 };
    c.spend += r.cost; c.spots++; if (isMine) c.mine += r.cost; out.ch.set(r.channel, c);
    if (f.adType === 'Sponsorship' || !isSponsor(r.theme)) {
      const k = r.adv + '\u0001' + r.theme;
      const t = out.camp.get(k) || { spend: 0, spots: 0 };
      t.spend += r.cost; t.spots++; out.camp.set(k, t);
    }
  }
  return out;
}

let checks = 0, failures = 0;
const fail = msg => { failures++; if (failures <= 25) console.log('  FAIL', msg); };
const near = (a, b) => Math.abs(a - b) <= Math.max(0.01, Math.abs(b) * 1e-9);
function compare(label, app, ref, sponsorMode) {
  checks++;
  if (!near(app.total, ref.total)) return fail(`${label}: total ${app.total} vs ${ref.total}`);
  if (app.spots !== ref.spots) return fail(`${label}: spots ${app.spots} vs ${ref.spots}`);
  if (!near(app.mineTotal, ref.mineTotal)) return fail(`${label}: mine ${app.mineTotal} vs ${ref.mineTotal}`);
  if (app.advertisers.length !== ref.adv.size) return fail(`${label}: ${app.advertisers.length} advertiser rows vs ${ref.adv.size}`);
  for (const a of app.advertisers) {
    const r = ref.adv.get(a.name);
    if (!r || !near(a.spend, r.spend) || a.spots !== r.spots || a.role !== r.role) return fail(`${label}: advertiser row ${a.name}`);
  }
  if (app.channels.length !== ref.ch.size) return fail(`${label}: ${app.channels.length} channel rows vs ${ref.ch.size}`);
  for (const c of app.channels) {
    const r = ref.ch.get(c.name);
    if (!r || !near(c.spend, r.spend) || c.spots !== r.spots || !near(c.mine, r.mine)) return fail(`${label}: channel row ${c.name}`);
  }
  const refCamps = [...ref.camp].sort((x, y) => y[1].spend - x[1].spend);
  if (app.campaigns.length !== Math.min(50, refCamps.length)) return fail(`${label}: ${app.campaigns.length} campaign rows vs ${Math.min(50, refCamps.length)}`);
  for (const c of app.campaigns) {
    if (!sponsorMode && isSponsor(c.name)) return fail(`${label}: sponsorship item "${c.name}" listed as a campaign`);
    const r = ref.camp.get(c.advertiser + '\u0001' + c.name);
    if (!r || !near(c.spend, r.spend) || c.spots !== r.spots) return fail(`${label}: campaign row ${c.name}`);
  }
  // Sorted by spend, biggest first, in every table.
  const sorted = list => list.every((x, i) => i === 0 || list[i - 1].spend >= x.spend);
  if (!sorted(app.advertisers) || !sorted(app.channels) || !sorted(app.campaigns)) return fail(`${label}: table not sorted by spend`);
}

// Scopes exactly as the page builds them (see public/app.js), for one dashboard response.
function pageScopes(d) {
  const S = [];
  const add = (label, scope, expect) => S.push({ label, scope, expect });
  add('KPI category', {}, { total: d.kpi.catSpend, spots: d.kpi.catSpots });
  add('KPI mine', { mine: true }, { total: d.kpi.mineSpend, spots: d.kpi.mineSpots });
  d.medium.names.forEach((m, i) => add(`Donut ${m}`, { medium: m }, { share: [d.medium.category[i], d.kpi.catSpend] }));
  d.months.forEach((m, k) => {
    add(`Trend ${m.key}`, { month: m.key }, { total: d.drill[k].category });
    d.trend.competitors.forEach(c => add(`Trend ${m.key} ${c.name}`, { month: m.key, advertiser: c.name }, { total: c.values[k] }));
    const camp = d.drill[k].campaign;
    if (camp) add(`Drill campaign ${m.key}`, { month: m.key, advertiser: camp.advertiser, theme: camp.name }, { total: camp.spend, spots: camp.spots });
  });
  for (const [mix, medium] of [[d.tvMix, 'TV'], [d.radioMix, 'Radio']]) {
    const top = Math.min(5, mix.keys.length);
    d.months.forEach((m, k) => {
      mix.keys.forEach((key, j) => {
        add(`${medium} ${m.key} ${key}`, { month: m.key, channel: key }, { pct: mix.category[k] && mix.category[k][j], of: { month: m.key, medium } });
        add(`${medium} mine ${m.key} ${key}`, { month: m.key, channel: key, mine: true }, { pct: mix.mine[k] && mix.mine[k][j], of: { month: m.key, medium, mine: true } });
      });
      if (mix.keys.length > 5 && mix.category[k]) {
        add(`${medium} Other ${m.key}`, { month: m.key, medium, exclude: mix.keys.slice(0, top) }, { pct: mix.category[k].slice(5).reduce((s, x) => s + x, 0), of: { month: m.key, medium } });
      }
    });
    mix.keys.forEach(key => add(`Heat row ${key}`, { channel: key }, {}));
  }
  d.duration.rows.forEach(r => {
    const who = r.mine ? { mine: true } : r.avg ? {} : { advertiser: r.name };
    add(`Duration row ${r.name}`, who, {});
    d.duration.buckets.forEach((b, j) => { if (r.counts[j] > 0) add(`Bubble ${r.name} ${b}`, { ...who, dur: b }, { spots: r.counts[j] }); });
  });
  return S;
}

(async () => {
  const file = process.argv[2];
  if (!file) { console.error('Usage: node scripts/verify-drilldowns.js <file.csv>'); process.exit(1); }
  const t0 = Date.now();
  const [ds, rows] = await Promise.all([ingestFile(file, file), readRows(file)]);
  console.log(`Loaded ${rows.length} rows in ${((Date.now() - t0) / 1000).toFixed(1)}s\n`);
  const groups = compute.overview(ds).productGroups.map(g => g.name);
  const opts = compute.groupOptions(ds, groups[0]);
  const advs = opts.advertisers.map(a => a.name);
  const tv = opts.channels.find(c => c.medium === 'TV').name;
  const base = { from: '2026-01-01', to: '2026-09-30', pg: groups[0], mine: [advs[0]], comps: advs.slice(1, 4), medium: 'All', channel: '', daypart: '' };
  const g2 = compute.groupOptions(ds, groups[1]).advertisers.map(a => a.name);
  const scenarios = [
    ['All media', base],
    ['TV only', { ...base, medium: 'TV' }],
    ['Prime daypart', { ...base, daypart: 'Prime' }],
    ['One channel', { ...base, channel: tv }],
    ['Two of mine', { ...base, mine: advs.slice(0, 2), comps: advs.slice(2, 6) }],
    ['Mid-month dates', { ...base, from: '2026-02-15', to: '2026-05-10' }],
    ['Press only', { ...base, medium: 'Press' }],
    ['Commercials', { ...base, adType: 'Commercial' }],
    ['Sponsorships', { ...base, adType: 'Sponsorship' }],
    ['Sponsor + TV', { ...base, adType: 'Sponsorship', medium: 'TV', daypart: 'Prime' }],
    ['Other group', { ...base, pg: groups[1], mine: [g2[2]], comps: [g2[0], g2[1], g2[3]] }],
  ];

  for (const [name, f] of scenarios.filter(([n]) => !process.env.ONLY || n === process.env.ONLY)) {
    const before = checks, beforeFail = failures;
    const SP = f.adType === 'Sponsorship';
    const d = compute.dashboard(ds, f);
    const subset = rows.filter(r => r.pg === f.pg && r.date >= f.from && r.date <= f.to);
    const cache = new Map();
    const app = sc => compute.detail(ds, f, sc);
    const ref = sc => { const k = JSON.stringify(sc); if (!cache.has(k)) cache.set(k, reference(subset, f, sc)); return cache.get(k); };

    for (const { label, scope, expect } of pageScopes(d)) {
      const a = app(scope);
      compare(`${name} · ${label}`, a, ref(scope), SP);
      // The number you clicked equals the pop-up.
      if (expect.total != null) { checks++; if (!near(a.total, expect.total)) fail(`${name} · ${label}: clicked ${expect.total}, pop-up ${a.total}`); }
      if (expect.spots != null) { checks++; if (a.spots !== expect.spots) fail(`${name} · ${label}: clicked ${expect.spots} ads, pop-up ${a.spots}`); }
      if (expect.share) { checks++; const [pct, of] = expect.share; if (!near(of ? (a.total / of) * 100 : 0, pct)) fail(`${name} · ${label}: share`); }
      if (expect.pct != null) { checks++; const whole = app(expect.of).total; if (!near((a.total / whole) * 100, expect.pct)) fail(`${name} · ${label}: segment % ${expect.pct}`); }

      // Clicks inside the pop-up, one and two levels deep (same merge rule as the page).
      if (/^(Trend 20\d\d-0[1-3]$|KPI|Donut TV|Bubble .* 5s|Drill campaign 2026-0[12])/.test(label)) {
        const lvl2 = [
          ...a.advertisers.slice(0, 3).map(x => ({ ...scope, advertiser: x.name, mine: undefined })),
          ...a.campaigns.slice(0, 3).map(x => ({ ...scope, advertiser: x.advertiser, theme: x.name, mine: undefined })),
          ...a.channels.slice(0, 3).map(x => ({ ...scope, channel: x.name })),
        ];
        for (const s2 of lvl2) {
          const clean = JSON.parse(JSON.stringify(s2));
          const a2 = app(clean);
          compare(`${name} · ${label} > ${clean.theme || clean.advertiser || clean.channel}`, a2, ref(clean), SP);
          const s3 = a2.channels[0] ? JSON.parse(JSON.stringify({ ...clean, channel: a2.channels[0].name })) : null;
          if (s3) compare(`${name} · ${label} > ... > ${s3.channel}`, app(s3), ref(s3), SP);
        }
      }
    }
    // Grouped quiet months (a date range inside the period).
    const sub = { from: d.months[0].key + '-01' < f.from ? f.from : d.months[0].key + '-01', to: d.months[Math.min(2, d.months.length - 1)].key + '-28' };
    compare(`${name} · quiet months range`, app(sub), ref(sub), SP);
    console.log(`${failures === beforeFail ? 'ok  ' : 'FAIL'} ${name.padEnd(16)} ${checks - before} checks`);
  }
  // All = Commercials + Sponsorships, for the KPIs and every month.
  const [dAll, dCom, dSp] = ['All', 'Commercial', 'Sponsorship'].map(t => compute.dashboard(ds, { ...base, adType: t }));
  checks++; if (!near(dCom.kpi.catSpend + dSp.kpi.catSpend, dAll.kpi.catSpend)) fail('Commercials + Sponsorships != All (spend)');
  checks++; if (dCom.kpi.catSpots + dSp.kpi.catSpots !== dAll.kpi.catSpots) fail('Commercials + Sponsorships != All (spots)');
  dAll.drill.forEach((m, k) => { checks++; if (!near(dCom.drill[k].category + dSp.drill[k].category, m.category)) fail('month split ' + m.key); });
  checks++; if (dSp.drill.some(m => m.campaign && !isSponsor(m.campaign.name))) fail('Sponsorships mode shows a non-sponsorship lead campaign');
  checks++; if (dCom.drill.some(m => m.campaign && isSponsor(m.campaign.name)) || dAll.drill.some(m => m.campaign && isSponsor(m.campaign.name))) fail('sponsorship item leads in All/Commercials');
  console.log(`\n${checks} checks, ${failures} failures (${((Date.now() - t0) / 1000).toFixed(0)}s)`);
  process.exit(failures ? 1 : 0);
})().catch(e => { console.error(e); process.exit(1); });
