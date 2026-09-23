'use strict';
// Cross-checks every drill-down against the chart it opens from, over several filter setups.
// Usage: node scripts/check-drilldowns.js samples/sample_420000.csv
const assert = require('assert');
const { ingestFile } = require('../server/ingest');
const compute = require('../server/compute');

const close = (a, b, msg) => {
  const tol = Math.max(1e-6, Math.abs(b) * 1e-9);
  assert.ok(Math.abs(a - b) <= tol, `${msg}: got ${a}, expected ${b}`);
};

(async () => {
  const file = process.argv[2];
  if (!file) { console.error('Usage: node scripts/check-drilldowns.js <file.csv|xlsx>'); process.exit(1); }
  const ds = await ingestFile(file, file);
  const ov = compute.overview(ds);
  const pg = ov.productGroups[0].name;
  const advs = compute.groupOptions(ds, pg).advertisers.map(a => a.name);
  const tvCh = compute.groupOptions(ds, pg).channels.find(c => c.medium === 'TV').name;
  const base = { from: '2026-01-01', to: '2026-09-30', pg, mine: [advs[0]], comps: advs.slice(1, 4), medium: 'All', channel: '', daypart: '' };
  const scenarios = [
    ['All media', base],
    ['TV only', { ...base, medium: 'TV' }],
    ['Radio only', { ...base, medium: 'Radio' }],
    ['Prime daypart', { ...base, daypart: 'Prime' }],
    ['One channel', { ...base, channel: tvCh }],
    ['Two of mine', { ...base, mine: advs.slice(0, 2), comps: advs.slice(2, 5) }],
    ['Mid-month range', { ...base, from: '2026-02-15', to: '2026-05-10' }],
    ['Single month', { ...base, from: '2026-03-01', to: '2026-03-31' }],
    ['No competitors', { ...base, comps: [] }],
  ];
  let checks = 0;
  for (const [label, f] of scenarios) {
    const d = compute.dashboard(ds, f);
    const det = scope => compute.detail(ds, f, scope);

    // KPI cards
    const all = det({});
    close(all.total, d.kpi.catSpend, `${label} category spend`); checks++;
    assert.strictEqual(all.spots, d.kpi.catSpots, `${label} category spots`); checks++;
    close(det({ mine: true }).total, d.kpi.mineSpend, `${label} mine spend`); checks++;
    close(all.mineTotal, d.kpi.mineSpend, `${label} mine share in category detail`); checks++;
    close(all.advertisers.reduce((s, a) => s + a.spend, 0), all.total, `${label} advertisers add up`); checks++;
    close(all.channels.reduce((s, c) => s + c.spend, 0), all.total, `${label} channels add up`); checks++;

    // Medium split
    d.medium.names.forEach((m, i) => {
      const t = det({ medium: m }).total;
      close(d.kpi.catSpend ? (t / d.kpi.catSpend) * 100 : 0, d.medium.category[i], `${label} medium ${m} share`); checks++;
    });

    // Trend, drill down and campaigns, month by month
    d.months.forEach((m, k) => {
      const md = det({ month: m.key });
      close(md.total, d.drill[k].category, `${label} ${m.key} category`); checks++;
      close(md.mineTotal, d.trend.mine[k], `${label} ${m.key} mine`); checks++;
      d.trend.competitors.forEach(c => {
        close(det({ month: m.key, advertiser: c.name }).total, c.values[k], `${label} ${m.key} ${c.name}`); checks++;
      });
      const L = d.drill[k].leader;
      if (L && !L.mine) { close(md.advertisers[0].spend, L.spend, `${label} ${m.key} leader`); checks++; }
      const camp = d.drill[k].campaign;
      if (camp) {
        const cd = det({ month: m.key, advertiser: camp.advertiser });
        const row = cd.campaigns.find(c => c.name === camp.name);
        assert.ok(row, `${label} ${m.key} campaign "${camp.name}" missing from its advertiser's detail`);
        close(row.spend, camp.spend, `${label} ${m.key} campaign spend`); checks++;
        assert.strictEqual(row.spots, camp.spots, `${label} ${m.key} campaign spots`); checks++;
      }
    });

    // Channel mix: each segment, heatmap cell and the Top 5 "Other" group
    for (const [mix, medium] of [[d.tvMix, 'TV'], [d.radioMix, 'Radio']]) {
      d.months.forEach((m, k) => {
        const parts = mix.category[k];
        if (!parts) return;
        const medTotal = det({ month: m.key, medium }).total;
        mix.keys.forEach((key, j) => {
          close((det({ month: m.key, channel: key }).total / medTotal) * 100, parts[j], `${label} ${medium} ${m.key} ${key}`); checks++;
        });
        const mineParts = mix.mine[k];
        if (mineParts) {
          const mineTotal = det({ month: m.key, medium, mine: true }).total;
          close((det({ month: m.key, channel: mix.keys[0], mine: true }).total / mineTotal) * 100, mineParts[0], `${label} ${medium} ${m.key} mine`); checks++;
        }
        if (mix.keys.length > 5) {
          const other = det({ month: m.key, medium, exclude: mix.keys.slice(0, 5) }).total;
          close((other / medTotal) * 100, parts.slice(5).reduce((s, x) => s + x, 0), `${label} ${medium} ${m.key} Other`); checks++;
        }
      });
    }

    // Duration: % adds to 100 and counts match
    d.duration.rows.forEach(r => {
      if (!r.split) return;
      close(r.split.reduce((s, x) => s + x, 0), 100, `${label} duration ${r.name} adds to 100`); checks++;
      assert.strictEqual(r.counts.reduce((s, x) => s + x, 0), r.ads, `${label} duration ${r.name} counts`); checks++;
      assert.ok(r.acd == null || (r.acd > 0 && r.acd < 600), `${label} duration ${r.name} ACD in range`); checks++;
    });

    // Sub-range (grouped quiet months) sits inside the dashboard dates
    const sub = det({ from: d.months[0].key + '-01', to: d.filters.to });
    close(sub.total, d.kpi.catSpend, `${label} full sub-range equals category`); checks++;
    console.log(`ok  ${label.padEnd(16)} ${d.months.length} months`);
  }
  console.log(`\nAll ${checks} drill-down checks passed`);
})().catch(e => { console.error('FAILED:', e.message); process.exit(1); });
