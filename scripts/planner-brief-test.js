'use strict';
// Checks the Competitor Brief for the planning tool against a small dataset whose numbers can be counted by hand.
// Run: npm run test:brief
const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { ingestFile } = require('../server/ingest');
const compute = require('../server/compute');
const { plannerBrief, plannerOptions, SCHEMA_VERSION, MAX_BYTES } = require('../server/plannerBrief');

const { HEADER, ROWS, F } = require('./planner-brief-fixture');

(async () => {
  const file = path.join(os.tmpdir(), `cas-brief-${process.pid}.csv`);
  fs.writeFileSync(file, [HEADER, ...ROWS].join('\n'));
  const ds = await ingestFile(file, 'brief.csv');
  fs.rmSync(file);

  // ---- options for the modal
  const opt = plannerOptions(ds, F);
  assert.deepStrictEqual(opt.advertisers.map(a => a.name), ['Rival', 'Me', 'Third']);
  assert.deepStrictEqual(opt.mine, ['Me']);
  assert.deepStrictEqual(opt.competitors, ['Rival', 'Third']);
  assert.strictEqual(opt.minDate, '2026-01-05');

  // ---- totals reconcile with the dashboard
  const brief = plannerBrief(ds, F);
  const dash = compute.dashboard(ds, { ...F, compare: false });
  assert.strictEqual(brief.schemaVersion, SCHEMA_VERSION);
  assert.strictEqual(brief.categorySummary.totalSpend, dash.kpi.catSpend);
  assert.strictEqual(brief.categorySummary.totalSpots, dash.kpi.catSpots);
  const [me, rival, third] = brief.advertisers;
  assert.deepStrictEqual([me.name, rival.name, third.name], ['Me', 'Rival', 'Third']);
  assert.strictEqual(me.totals.spend, dash.kpi.mineSpend);
  assert.strictEqual(me.totals.spend, 4500); assert.strictEqual(me.totals.spots, 6);
  assert.strictEqual(me.totals.avgCostPerSpot, 750);
  assert.strictEqual(rival.totals.spend, 20000); assert.strictEqual(rival.totals.rank, 1); assert.strictEqual(me.totals.rank, 2);
  assert.strictEqual(me.totals.shareOfSpendPct, 15.8);
  const share = brief.comparison.shareOfSpend;
  assert.strictEqual(share.reduce((s, r) => s + r.spend, 0), brief.categorySummary.totalSpend);
  assert.strictEqual(share[share.length - 1].advertiser, 'All other advertisers'); assert.strictEqual(share[share.length - 1].spend, 0);

  // ---- value addition and zero cost are separated
  assert.deepStrictEqual([me.valueAddition.spots, me.valueAddition.spend], [2, 500]); // -BB plus the Cost 0 spot
  assert.strictEqual(me.totals.commercialSpend, 4000); assert.strictEqual(me.totals.commercialSpots, 4);
  assert.strictEqual(me.valueAddition.topItems[0].name, 'Summer -BB');

  // ---- medium, channel, programme
  assert.strictEqual(me.byMedium.TV.spots, 5); assert.strictEqual(me.byMedium.Radio.spots, 1); assert.strictEqual(me.byMedium.Press.spots, 0);
  assert.strictEqual(rival.byMedium.Press.spend, 2000);
  assert.strictEqual(rival.byChannel[0].channel, 'Sirasa TV'); assert.strictEqual(rival.byChannel[0].sharePct, 90);
  assert.strictEqual(rival.byProgram[0].programme, 'Drama'); assert.strictEqual(rival.byProgram[0].avgCostPerSpot, 3000);

  // ---- daypart: Prime is 18:00 to 24:00, Press is not timed and stays out of the base
  assert.strictEqual(rival.daypart.timedSpots, 6); assert.strictEqual(rival.daypart.prime.spotsPct, 100);
  assert.strictEqual(me.daypart.timedSpots, 6);
  assert.strictEqual(me.daypart.prime.spotsPct, 83.3); assert.strictEqual(me.daypart.nonPrime.spotsPct, 16.7);
  assert.strictEqual(me.daypart.hourBands.find(b => b.band === '18-21').spotsPct, 66.7);
  assert.strictEqual(me.daypart.hourBands.find(b => b.band === '21-24').spotsPct, 16.7);

  // ---- day of week: 2026-01-05 is a Monday
  assert.strictEqual(me.dayOfWeek.days[0].day, 'Mon'); assert.strictEqual(me.dayOfWeek.days[0].spotsPct, 33.3);
  assert.strictEqual(me.dayOfWeek.weekendPct, 16.7); assert.strictEqual(me.dayOfWeek.weekdayPct, 83.3);

  // ---- duration and ACD (TV and Radio only; the value addition counts as 5s)
  assert.deepStrictEqual(Object.values(me.duration.buckets), [1, 0, 1, 1, 3, 0]);
  assert.strictEqual(me.duration.acdSeconds, 21.7); // (30+30+15+20+5+30) / 6 = 21.67
  assert.strictEqual(rival.duration.spotsCounted, 6); // the Press spot has no duration

  // ---- placement
  assert.strictEqual(me.placement.breakPosition.firstPct, 50);  // PosinBrk 1 in 3 of 6
  assert.strictEqual(me.placement.programmePosition.first3Pct, 66.7); // AdPos 1, 5, 9, 2, 1, 3: four of six are 1 to 3
  assert.strictEqual(me.placement.breakNumber.break1Pct, 66.7);
  assert.strictEqual(me.placement.avgBreakClutter, 4.8);
  assert.strictEqual(rival.placement.breakPosition.firstPct, 83.3);
  assert.strictEqual(rival.placement.programmePosition.last3Pct, 16.7);
  assert.ok(brief.advertisers.every(p => p.placement.spotsCounted <= p.byMedium.TV.spots + p.byMedium.Radio.spots), 'Press is not in placement');
  const pressOnly = plannerBrief(ds, { ...F, medium: 'Press' }, { client: ['Rival'], competitors: ['Me'] });
  assert.strictEqual(pressOnly.advertisers[0].placement, null); assert.strictEqual(pressOnly.advertisers[0].duration, null);
  assert.strictEqual(pressOnly.advertisers[0].daypart, null); // missing is null, never 0

  // ---- flighting
  assert.strictEqual(rival.flighting.activeWeeks, 1);          // every Rival spot is in the week of Mon 5 Jan
  assert.strictEqual(rival.flighting.pattern, 'burst');
  assert.deepStrictEqual([me.flighting.activeWeeks, me.flighting.flightCount, me.flighting.longestRunWeeks], [3, 2, 2]); // weeks of 5 Jan, 12 Jan (one flight) and 2 Feb
  assert.deepStrictEqual(me.flighting.flights.map(z => z.from), ['2026-01-05', '2026-02-02']);
  assert.strictEqual(third.flighting.peakMonth, '2026-03');
  assert.deepStrictEqual(me.flighting.monthly.map(m => m.month), ['2026-01', '2026-02']);
  assert.strictEqual(me.flighting.pattern, 'burst');

  // ---- frequency
  assert.strictEqual(me.frequency.avgSpotsPerActiveDay, 1);
  assert.strictEqual(rival.frequency.avgSpotsPerProgrammeAiring, 1);

  // ---- campaigns (value additions are not campaigns)
  assert.deepStrictEqual(me.campaigns.map(c => c.name), ['Theme A', 'Theme B']);
  assert.strictEqual(me.campaigns[0].mainChannels[0], 'Derana TV'); assert.strictEqual(me.campaigns[0].language, 'Sinhala');
  assert.strictEqual(me.campaigns[0].firstDate, '2026-01-05');

  // ---- language
  assert.deepStrictEqual(me.language[0], { language: 'Sinhala', spotsPct: 83.3 });

  // ---- gaps: Third runs in March and we do not; Rival buys Sirasa/Drama
  const gaps = brief.comparison.gapsAndOpportunities;
  assert.ok(gaps.some(g => g.type === 'month' && g.name === '2026-03'), 'March gap');
  assert.ok(gaps.some(g => g.type === 'channel' && g.name === 'Hiru TV' && g.client.spots === 0), 'Hiru gap');
  assert.ok(gaps.some(g => g.type === 'programme' && g.name === 'Drama' && g.competitors[0].advertiser === 'Rival') === false, 'we do air in Drama, so it is not a gap');
  assert.ok(gaps.some(g => g.type === 'programme' && g.name === 'Morning Show') === false, 'only 2 spots: below the 5 spot floor');

  // ---- facts: plain English, numbered, capped, each with a pointer back to the numbers
  assert.ok(brief.facts.length > 0 && brief.facts.length <= 40);
  assert.strictEqual(brief.facts[0].id, 'F01');
  assert.ok(brief.facts.every(x => x.text.endsWith('.') && x.ref && !/NaN|undefined|null/.test(x.text)), 'clean sentences');
  assert.ok(brief.facts.some(x => /Rival spends 90% of its budget on Sirasa TV, mostly in Prime Time \(100% of spots\)/.test(x.text)));
  assert.ok(brief.facts.some(x => /Me \(us\) has 15.8% share of spend/.test(x.text)));

  // ---- size and shape
  const bytes = Buffer.byteLength(JSON.stringify(brief));
  assert.ok(bytes < MAX_BYTES, 'under 200 KB');
  assert.strictEqual(brief.meta.sizeBytes, bytes);
  assert.deepStrictEqual(Object.keys(brief).slice(0, 8), ['schemaVersion', 'generatedAt', 'dataDictionary', 'context', 'categorySummary', 'advertisers', 'comparison', 'facts']);
  assert.ok(brief.dataDictionary.columns.AdPos && brief.dataDictionary.definitions.primeTime);

  // ---- choices from the modal win over the dashboard's ticks, and the date range can be narrowed
  const picked = plannerBrief(ds, F, { client: ['Third'], competitors: ['Me'], from: '2026-03-01', to: '2026-03-31' });
  assert.strictEqual(picked.context.myAdvertiser, 'Third'); assert.deepStrictEqual(picked.context.competitors, ['Me']);
  assert.strictEqual(picked.context.dateFrom, '2026-03-01');
  assert.strictEqual(picked.advertisers[1].totals.spots, 0); // Me has nothing in March
  assert.strictEqual(picked.advertisers[1].placement, null);
  const combined = plannerBrief(ds, F, { client: ['Me', 'Third'], competitors: ['Rival'] });
  assert.strictEqual(combined.advertisers[0].name, 'Me + Third'); assert.strictEqual(combined.advertisers[0].totals.spend, 8500);
  assert.strictEqual(combined.advertisers[0].totals.rank, 2);
  assert.throws(() => plannerBrief(ds, { ...F, mine: [] }), /Choose my advertiser/);
  assert.throws(() => plannerBrief(ds, { ...F, from: '2030-01-01', to: '2030-02-01' }), /No spots/);

  // ---- a file loaded before language and programme position were kept still works, with nulls and a warning
  const old = { ...ds, cols: { ...ds.cols }, dicts: { ...ds.dicts } };
  delete old.cols.lng; delete old.cols.progPos; delete old.cols.progAds; delete old.dicts.lng;
  const oldBrief = plannerBrief(old, F);
  assert.strictEqual(oldBrief.advertisers[0].language, null); assert.strictEqual(oldBrief.advertisers[0].placement.programmePosition, null);
  assert.ok(oldBrief.warnings.some(w => /loaded before language/.test(w)));

  console.log('Planner brief checks passed:', brief.facts.length, 'facts,', gaps.length, 'gaps,', bytes, 'bytes');
})().catch(e => { console.error(e); process.exit(1); });
