'use strict';
// Quick checks for the derived field rules and the aggregation engine. Run: npm test
const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const D = require('../server/derive');
const { ingestFile } = require('../server/ingest');
const compute = require('../server/compute');

// Medium and channel name
assert.strictEqual(D.MEDIA[D.mediumOf('TV - Derana TV')], 'TV');
assert.strictEqual(D.MEDIA[D.mediumOf('FM Derana')], 'Radio');
assert.strictEqual(D.MEDIA[D.mediumOf('Radio - Neth FM')], 'Radio');
assert.strictEqual(D.MEDIA[D.mediumOf('Lankadeepa')], 'Press');
assert.strictEqual(D.channelNameOf('TV - Derana TV'), 'Derana TV');
assert.strictEqual(D.channelNameOf('FM Derana'), 'FM Derana');

// Std_Dur
const std = d => D.DURATIONS[D.stdDurIndex(d)];
assert.deepStrictEqual([3, 9, 10, 17, 18, 22, 25, 28, 30, 45].map(std), [5, 5, 15, 15, 20, 20, 30, 30, 30, 30]);

// Daypart
const dp = t => D.DAYPARTS[D.daypartOf(D.parseTime(t))];
assert.strictEqual(dp('18:29:59'), 'Daytime');
assert.strictEqual(dp('18:30:00'), 'Prime');
assert.strictEqual(dp('22:29'), 'Prime');
assert.strictEqual(dp('22:30'), 'Late night');
assert.strictEqual(dp('07:15 AM'), 'Morning');
assert.strictEqual(dp(0.8125), 'Prime'); // Excel time fraction for 19:30
assert.strictEqual(dp(''), 'Not timed');

// Break quality and dates
assert.strictEqual(D.BREAK_QUALITY[D.breakQualityOf(1, 6)], 'Premium');
assert.strictEqual(D.BREAK_QUALITY[D.breakQualityOf(6, 6)], 'Premium');
assert.strictEqual(D.BREAK_QUALITY[D.breakQualityOf(3, 6)], 'Mid break');
assert.ok(Number.isNaN(D.dayNumber(31, 2, 2026)));
assert.strictEqual(D.dayNumber(1, 'Jan', 26), D.dayNumber(1, 1, 2026));

// End to end on a tiny CSV
(async () => {
  const file = path.join(os.tmpdir(), `cas-smoke-${process.pid}.csv`);
  fs.writeFileSync(file, [
    'Product_Group,Advertiser,Product,Advt_Theme,Channel,Program,Dd,Mn,Yr,Day,Prog_time,Advt_time,AdPos,TotAds,BrkNo,PosinBrk,AdsinBrk,Lng,Dur,Cost',
    'Biscuits,Me,P,Theme A,TV - Derana TV,News,5,1,2026,Mon,19:00,19:45:00,1,5,1,1,5,Sinhala,30,"1,000,000"',
    'Biscuits,Me,P,Theme A,FM Derana,Show,6,2,2026,Tue,08:00,08:10:00,1,5,1,2,5,Sinhala,15,500000',
    'Biscuits,Rival,P,Theme B,TV - Sirasa TV,News,7,2,2026,Wed,20:00,20:15:00,1,5,1,3,5,Sinhala,20,2000000',
    'Biscuits,Rival,P,Theme B,Lankadeepa,,10,12,2025,Wed,,,,,,,,Sinhala,,700000',
    'Biscuits,Other,P,Theme C,Lankadeepa,,8,2,2026,Thu,,,,,,,,Sinhala,,500000',
    'Biscuits,Bad,P,Theme C,Lankadeepa,,31,2,2026,Thu,,,,,,,,Sinhala,,1',
  ].join('\n'));
  const ds = await ingestFile(file, 'smoke.csv');
  fs.rmSync(file);
  assert.strictEqual(ds.meta.rows, 5);
  assert.strictEqual(ds.meta.skipped, 1);
  const out = compute.dashboard(ds, { from: '2026-01-01', to: '2026-02-28', compare: true, pg: 'Biscuits', mine: ['Me'], comps: ['Rival'], medium: 'All' });
  assert.strictEqual(out.kpi.catSpend, 4000000);
  assert.strictEqual(out.kpi.mineSpend, 1500000);
  assert.strictEqual(Math.round(out.kpi.sos * 10) / 10, 37.5);
  assert.strictEqual(out.kpi.rank, 2);
  assert.strictEqual(out.kpi.catPrev, 700000);
  assert.strictEqual(out.months.length, 2);
  assert.strictEqual(out.drill[1].leader.name, 'Rival');
  assert.strictEqual(out.drill[0].leader.mine, true);
  assert.strictEqual(out.drill[0].campaign.name, 'Theme A');
  const tvOnly = compute.dashboard(ds, { from: '2026-01-01', to: '2026-02-28', pg: 'Biscuits', mine: ['Me'], comps: ['Rival'], medium: 'TV' });
  assert.strictEqual(tvOnly.kpi.catSpend, 3000000);
  console.log('All smoke tests passed');
})().catch(e => { console.error(e); process.exit(1); });
