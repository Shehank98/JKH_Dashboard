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
const std = d => D.DUR_BUCKETS[D.stdDurIndex(d)];
assert.deepStrictEqual([1, 3, 9, 9.9, 10, 12, 12.5, 13, 17, 17.5, 18, 22, 25, 26, 28, 30, 31, 34, 45].map(std),
  ['5s', '5s', '5s', '5s', '10s', '10s', '10s', '15s', '15s', '15s', '20s', '20s', '20s', '30s', '30s', '30s', '30s+', '30s+', '30s+']);

// Sponsorship items always count as 5s; ACD uses real Dur, or 5s when blank.
assert.strictEqual(D.durBucketOf(15, true), 0);
assert.strictEqual(D.durBucketOf(NaN, true), 0);
assert.strictEqual(D.durBucketOf(15, false), 2);
assert.strictEqual(D.durBucketOf(11, false), 1);
assert.strictEqual(D.durBucketOf(NaN, false), 255);
assert.strictEqual(D.durSecondsOf(NaN, true), 5);
assert.strictEqual(D.durSecondsOf(12, true), 12);
assert.ok(Number.isNaN(D.durSecondsOf(NaN, false)));

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
    'Biscuits,Me,P,-BB,TV - Derana TV,News,9,1,2026,Fri,19:00,19:50:00,1,5,1,1,5,Sinhala,5,5000000',
    'Biscuits,Me,P,Summer -BB,TV - Derana TV,News,9,1,2026,Fri,19:00,19:51:00,1,5,1,1,5,Sinhala,5,1',
    'Biscuits,Me,P,Time Check,FM Derana,Show,9,1,2026,Fri,08:00,08:10:00,1,5,1,1,5,Sinhala,5,1',
  ].join('\n'));
  const ds = await ingestFile(file, 'smoke.csv');
  fs.rmSync(file);
  assert.strictEqual(ds.meta.rows, 8);
  assert.strictEqual(ds.meta.skipped, 1);
  const out = compute.dashboard(ds, { from: '2026-01-01', to: '2026-02-28', compare: true, pg: 'Biscuits', mine: ['Me'], comps: ['Rival'], medium: 'All' });
  assert.strictEqual(out.kpi.catSpend, 9000002);
  assert.strictEqual(out.kpi.mineSpend, 6500002);
  assert.strictEqual(Math.round(out.kpi.sos * 10) / 10, 72.2);
  assert.strictEqual(out.kpi.rank, 1);
  assert.strictEqual(out.kpi.catPrev, 700000);
  assert.strictEqual(out.months.length, 2);
  assert.strictEqual(out.drill[1].leader.name, 'Rival');
  assert.strictEqual(out.drill[0].leader.mine, true);
  assert.strictEqual(out.drill[0].campaign.name, 'Theme A'); // -BB spent more but is excluded
  const tvOnly = compute.dashboard(ds, { from: '2026-01-01', to: '2026-02-28', pg: 'Biscuits', mine: ['Me'], comps: ['Rival'], medium: 'TV' });
  assert.strictEqual(tvOnly.kpi.catSpend, 8000001);
  // Sponsorship themes never become the lead campaign or appear in the campaign list.
  assert.ok(D.isExcludedTheme('-BB') && D.isExcludedTheme('Summer -BB') && D.isExcludedTheme('time check') && !D.isExcludedTheme('Rich Taste'));
  const det = compute.detail(ds, { from: '2026-01-01', to: '2026-02-28', compare: true, pg: 'Biscuits', mine: ['Me'], comps: ['Rival'], medium: 'All' }, { month: '2026-01' });
  assert.strictEqual(det.total, 6000002);
  // Pop-up campaign lists include sponsorship items; only the Month Drill Down lead skips them.
  assert.deepStrictEqual(det.campaigns.map(c => c.name).sort(), ['-BB', 'Summer -BB', 'Theme A', 'Time Check']);
  assert.strictEqual(det.advertisers[0].role, 'mine');
  // Duration mix: % of ads per bucket and ACD = sum of raw Dur / ads (TV and Radio).
  const durMe = out.duration.rows[0], durRival = out.duration.rows[1], durCat = out.duration.rows[2];
  assert.deepStrictEqual(durMe.counts, [3, 0, 1, 0, 1, 0]); // 5s x3, 15s, 30s
  assert.strictEqual(durMe.acd, 12);                     // (30 + 15 + 5 + 5 + 5) / 5
  assert.strictEqual(durRival.acd, 20);
  assert.strictEqual(Math.round(durCat.acd * 100) / 100, 13.33); // 80 / 6
  assert.strictEqual(durMe.split[0], 60);
  const detCh = compute.detail(ds, { from: '2026-01-01', to: '2026-02-28', pg: 'Biscuits', mine: ['Me'], comps: ['Rival'], medium: 'All' }, { channel: 'TV - Sirasa TV' });
  assert.deepStrictEqual(detCh.advertisers.map(a => a.name), ['Rival']);
  // Ad type filter: sponsorship items (-BB, Summer -BB, Time Check) vs commercials.
  const F = { from: '2026-01-01', to: '2026-02-28', pg: 'Biscuits', mine: ['Me'], comps: ['Rival'], medium: 'All' };
  const sp = compute.dashboard(ds, { ...F, adType: 'Sponsorship' });
  const cm = compute.dashboard(ds, { ...F, adType: 'Commercial' });
  assert.strictEqual(sp.kpi.catSpend, 5000002);
  assert.strictEqual(sp.kpi.catSpots, 3);
  assert.strictEqual(cm.kpi.catSpend, 4000000);
  assert.strictEqual(sp.kpi.catSpend + cm.kpi.catSpend, out.kpi.catSpend);
  assert.strictEqual(sp.drill[0].campaign.name, '-BB');          // sponsorship items can lead in Sponsorships mode
  assert.strictEqual(cm.drill[0].campaign.name, 'Theme A');
  const spDet = compute.detail(ds, { ...F, adType: 'Sponsorship' }, {});
  assert.deepStrictEqual(spDet.campaigns.map(c => c.name).sort(), ['-BB', 'Summer -BB', 'Time Check']);
  assert.strictEqual(compute.detail(ds, { ...F, adType: 'Commercial' }, {}).total, 4000000);
  console.log('All smoke tests passed');
})().catch(e => { console.error(e); process.exit(1); });
