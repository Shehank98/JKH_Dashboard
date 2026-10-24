'use strict';
// Unit test for public/plannerBrief.js on a small hand-made dataset. Run: npm run test:brief
const assert = require('assert');
const { Builder } = require('../server/builder');
const B = require('../public/plannerBrief');

const HEAD = ['Product_Group', 'Advertiser', 'Product', 'Advt_Theme', 'Ads', 'Channel', 'Program', 'Dd', 'Mn', 'Yr', 'Day', 'Prog_time', 'Advt_time', 'AdPos', 'TotAds', 'BrkNo', 'PosinBrk', 'AdsinBrk', 'Lng', 'Dur', 'Cost'];
// [advertiser, theme, channel, programme, dd, mn, time, adPos, totAds, brkNo, posInBrk, adsInBrk, lng, dur, cost]
const R = (a, th, ch, pr, dd, mn, tm, ap, ta, bn, pb, ab, lg, dur, cost) =>
  ['Biscuits', a, 'P', th, 'ad1', ch, pr, dd, mn, 2026, '', '', tm, ap, ta, bn, pb, ab, lg, dur, cost];
const rows = [HEAD,
  // Me: 3 TV spots in January, 1 Radio in February, 2 value additions
  R('Me', 'Launch', 'TV - Derana TV', 'News 1st', 5, 1, '19:30', 1, 10, 1, 1, 5, 'Sinhala', 30, 100000),
  R('Me', 'Launch', 'TV - Derana TV', 'News 1st', 12, 1, '19:30', 2, 10, 1, 3, 5, 'Sinhala', 30, 100000),
  R('Me', 'Launch', 'TV - Derana TV', 'News 1st', 19, 1, '19:30', 9, 10, 2, 5, 5, 'Tamil', 30, 100000),
  R('Me', 'Launch', 'FM Derana', 'Morning Show', 4, 2, '08:00', 1, 4, 1, 2, 4, 'Sinhala', 15, 20000),
  R('Me', '-BB', 'TV - Derana TV', 'News 1st', 5, 1, '19:30', 1, 10, 1, 1, 5, 'Sinhala', 5, 50000),
  R('Me', 'Launch', 'TV - Derana TV', 'News 1st', 6, 1, '19:30', 3, 10, 1, 2, 5, 'Sinhala', 30, 0),
  // Rival A: two bursts, TV in prime plus one Press ad
  R('Rival A', 'Big Sale', 'TV - Sirasa TV', 'Prime News', 5, 1, '20:00', 1, 8, 1, 1, 4, 'Sinhala', 30, 200000),
  R('Rival A', 'Big Sale', 'TV - Sirasa TV', 'Prime News', 6, 1, '20:00', 2, 8, 1, 1, 4, 'Sinhala', 30, 200000),
  R('Rival A', 'Big Sale', 'TV - Sirasa TV', 'Prime News', 10, 3, '20:00', 1, 8, 1, 2, 4, 'Sinhala', 30, 200000),
  R('Rival A', 'Big Sale', 'TV - Sirasa TV', 'Prime News', 11, 3, '20:00', 1, 8, 1, 4, 4, 'Sinhala', 30, 200000),
  R('Rival A', 'Big Sale', 'Lankadeepa', '', 11, 3, '', '', '', '', '', '', '', '', 300000),
  // Rival B: small, daytime Radio and TV
  R('Rival B', 'Everyday', 'TV - Hiru TV', 'Morning Show', 2, 2, '09:30', 4, 6, 1, 2, 3, 'Sinhala', 20, 50000),
  R('Rival B', 'Everyday', 'TV - Hiru TV', 'Morning Show', 9, 2, '09:30', 5, 6, 2, 1, 3, 'Sinhala', 20, 50000),
  // Not selected
  R('Other', 'Misc', 'TV - Derana TV', 'News 1st', 7, 1, '19:30', 1, 10, 1, 1, 5, 'Sinhala', 30, 80000),
];

const b = new Builder();
rows.forEach(r => b.addRow(r));
const ds = b.finish({});
const f = { pg: 'Biscuits', from: '2026-01-01', to: '2026-04-30', medium: 'All', channel: '', slot: '', adType: 'All', tagCommercial: false, mine: ['Me'], comps: ['Rival A', 'Rival B'] };

const rank = B.rankAdvertisers(ds, f);
assert.deepStrictEqual(rank.advertisers.map(a => a.name), ['Rival A', 'Me', 'Rival B', 'Other']);

const out = B.buildBrief(ds, f, { myAdvertiser: 'Me', competitors: ['Rival A', 'Rival B'] });
assert.strictEqual(out.schemaVersion, '1.0');
assert.ok(out.dataDictionary.columns.AdPos && out.dataDictionary.definitions.primeTime);
assert.strictEqual(out.context.myAdvertiser, 'Me');
assert.deepStrictEqual(out.context.mediums, ['TV', 'Radio', 'Press']);
assert.strictEqual(out.context.currency, 'LKR');

// category: 4 Me + 5 Rival A + 2 Rival B + 1 Other spots, value additions kept apart
assert.strictEqual(out.categorySummary.totalSpend, 1600000);
assert.strictEqual(out.categorySummary.totalSpots, 12);
assert.strictEqual(out.categorySummary.valueAdditionSpots, 2);
assert.strictEqual(out.categorySummary.spendByMedium.Press.spend, 300000);

const me = out.advertisers[0], a = out.advertisers[1], bb = out.advertisers[2];
assert.strictEqual(me.role, 'mine');
assert.strictEqual(me.totals.spend, 320000);
assert.strictEqual(me.totals.spots, 4);              // the -BB item and the Cost 0 item are not spots
assert.strictEqual(me.totals.avgCostPerSpot, 80000);
assert.strictEqual(me.totals.shareOfSpendPct, 20);
assert.strictEqual(me.totals.rank, 2);
assert.strictEqual(me.valueAddition.spots, 2);
assert.strictEqual(me.valueAddition.shareOfAiringsPct, 33.3);
assert.strictEqual(me.byMedium.TV.spendPct, 93.8);
assert.strictEqual(me.byChannel[0].channel, 'TV - Derana TV');
assert.strictEqual(me.byProgram[0].programme, 'News 1st');
assert.strictEqual(me.byProgram[0].spots, 3);

// daypart: 3 prime TV spots (19:30) and 1 radio spot at 08:00 (06-09 band, non-prime)
assert.strictEqual(me.daypart.primePct.spots, 75);
assert.strictEqual(me.daypart.nonPrimePct.spots, 25);
assert.strictEqual(me.daypart.hourBands.find(x => x.band === '18-21').spotsPct, 75);
// 5, 12 and 19 Jan 2026 are Mondays, 4 Feb is a Wednesday
assert.strictEqual(me.dayOfWeek.spotsPct.Mon, 75);
assert.strictEqual(me.dayOfWeek.spotsPct.Wed, 25);
assert.strictEqual(me.dayOfWeek.weekendPct, 0);
assert.strictEqual(me.dayOfWeek.weekdayPct, 100);

// placement and duration (TV and Radio only)
assert.strictEqual(me.placement.programmePosition.firstThreePct, 75);   // AdPos 1, 2 and radio 1
assert.strictEqual(me.placement.programmePosition.lastThreePct, 25);    // AdPos 9 of 10
assert.strictEqual(me.placement.breakPosition.firstPct, 25);
assert.strictEqual(me.placement.breakPosition.lastPct, 25);
assert.strictEqual(me.placement.breakPosition.middlePct, 50);
assert.strictEqual(me.placement.breakNumber.break1Pct, 75);
assert.strictEqual(me.placement.avgBreakClutter, 4.8);
assert.strictEqual(me.duration.spotCount['30s'], 3);
assert.strictEqual(me.duration.spotCount['15s'], 1);
assert.strictEqual(me.duration.acdSeconds, 26.3);
assert.deepStrictEqual(me.language, { Sinhala: 75, Tamil: 25 });

// Press is skipped for placement and duration, but still in spend
assert.strictEqual(a.byMedium.Press.spend, 300000);
assert.strictEqual(a.duration.spotsWithDuration, 4);
assert.strictEqual(a.placement.programmePosition.spotsMeasured, 4);
assert.strictEqual(a.totals.spots, 5);
assert.strictEqual(a.totals.spend, 1100000);

// flighting: two one-week flights (week of 5 Jan and week of 9 Mar), no January-to-March gap filled
assert.strictEqual(a.flighting.activeWeeks, 2);
assert.strictEqual(a.flighting.flightCount, 2);
assert.strictEqual(a.flighting.pattern, 'burst');
assert.strictEqual(a.flighting.peakMonth.month, '2026-03');
assert.deepStrictEqual(a.flighting.inactiveMonths, ['2026-02']);
assert.strictEqual(a.frequency.spotsPerActiveDay, 1.3);   // 5 spots on 4 active days (6 Jan, 5 Jan, 10 Mar, 11 Mar)
assert.strictEqual(a.campaigns[0].campaign, 'Big Sale');
assert.strictEqual(a.campaigns[0].durationDays, 66);
assert.strictEqual(bb.flighting.pattern, 'burst');

// comparison and gaps
assert.strictEqual(out.comparison.shareOfSpend[0].advertiser, 'Rival A');
const absent = out.comparison.gapsAndOpportunities.find(g => g.type === 'channel' && g.name === 'TV - Sirasa TV');
assert.ok(absent && absent.gap === 'absent' && absent.mySpots === 0);
assert.ok(absent.text.startsWith('We have 20% share of spend but 0 spots on TV - Sirasa TV where Rival A has'));
assert.ok(out.comparison.gapsAndOpportunities.some(g => g.type === 'month' && g.name === '2026-03'));

// facts: plain English, capped, numbers inside
assert.ok(out.facts.length > 5 && out.facts.length <= 40);
assert.ok(out.facts.every(t => typeof t === 'string' && /\d/.test(t) && !/NaN|undefined|null/.test(t)));
assert.ok(out.facts.some(t => t.startsWith('Rival A runs in bursts: 2 flights of 1 week each, peak in Mar 2026, no activity in Feb 2026')));
assert.ok(out.facts.some(t => /^Rival A spends \d/.test(t)));

// size, rounding, no NaN, JSON safe
const json = JSON.stringify(out);
assert.ok(out.meta.payloadBytes < 200 * 1024 && Buffer.byteLength(json) < 200 * 1024);
assert.ok(!/NaN|Infinity/.test(json));
assert.deepStrictEqual(JSON.parse(json).advertisers.length, 3);

// value-addition modes and date narrowing
const themeOnly = B.buildBrief(ds, f, { myAdvertiser: 'Me', competitors: ['Rival A'], valueAddition: 'theme' });
assert.strictEqual(themeOnly.advertisers[0].totals.spots, 5);   // the Cost 0 item is a spot when only themes mark value additions
assert.strictEqual(themeOnly.advertisers[0].valueAddition.spots, 1);
const feb = B.buildBrief(ds, f, { myAdvertiser: 'Me', competitors: ['Rival A'], from: '2026-02-01', to: '2026-02-28' });
assert.strictEqual(feb.context.dateFrom, '2026-02-01');
assert.strictEqual(feb.advertisers[0].totals.spots, 1);
assert.strictEqual(feb.advertisers[1].totals.spots, 0);
assert.ok(feb.advertisers[1].note);

// medium filter respects Press
const press = B.buildBrief(ds, { ...f, medium: 'Press' }, { myAdvertiser: 'Me', competitors: ['Rival A'] });
assert.deepStrictEqual(press.context.mediums, ['Press']);
assert.strictEqual(press.advertisers[1].placement, null);
assert.strictEqual(press.advertisers[1].duration, null);

console.log('planner brief: all checks passed (' + out.facts.length + ' facts, ' + out.meta.payloadBytes + ' bytes)');

// WRITE_SAMPLE=1 npm run test:brief writes the sample payload used in the README.
if (process.env.WRITE_SAMPLE) {
  const fs = require('fs'), path = require('path');
  const sample = JSON.parse(json);
  sample.generatedAt = '2026-05-01T09:00:00.000Z';
  fs.writeFileSync(path.join(__dirname, '..', 'docs', 'planner-brief-sample.json'), JSON.stringify(sample, null, 2) + '\n');
  console.log('wrote docs/planner-brief-sample.json');
}
