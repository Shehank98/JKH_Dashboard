'use strict';
// The shared data cube must give the same dashboard numbers as the full spot log (for month-aligned dates),
// while being far smaller and holding no brand names, programmes, campaigns or individual spots.
const assert = require('assert');
const fs = require('fs');
const path = require('path');
const { readSpotFile } = require('../server/browser-readers');
const compute = require('../server/compute');
const { buildCube, unpackCube, packCategory, unpackCategory } = require('../server/cube');
const { deriveCategory } = require('../server/brand-derive');
const category = require('../server/category');

const file = process.argv[2] || path.join(__dirname, '..', 'samples', 'sample_420000.csv');
(async () => {
  const ds = await readSpotFile(new File([await fs.openAsBlob(file)], path.basename(file)), () => {});
  const pgName = 'Biscuits & Confectionery';
  assert.ok(ds.dicts.pg.includes(pgName));
  const map = new Map([['biscuits & confectionery|marie', { mother: 'Marie Co', sub: 'Plain' }]]);
  const lookup = (pg, b) => map.get(pg.toLowerCase() + '|' + b.toLowerCase()) || null;
  const t0 = Date.now();
  const cube = buildCube(ds, lookup, {});
  const json = JSON.stringify(cube);
  console.log(`cube: ${cube.meta.records} records from ${ds.meta.rows} rows, ${(json.length / 1024).toFixed(0)} KB json, ${(require('zlib').gzipSync(json).length / 1024).toFixed(0)} KB gzip, ${Date.now() - t0} ms`);
  assert.ok(json.includes('Morning Energy'), 'the full level keeps campaign names');
  assert.ok(!json.includes('Full Cream Milk'), 'no brand names');
  const cds = unpackCube(JSON.parse(json));
  const base = { pg: pgName, from: '2026-01-01', to: '2026-06-30', mine: [ds.dicts.adv[0]], comps: ds.dicts.adv.slice(1, 4), tagCommercial: false, yearType: 'CY' };
  const near = (a, b, what) => assert.ok(Math.abs(a - b) <= Math.max(2, Math.abs(b) * 1e-6), `${what}: ${a} vs ${b}`);
  for (const extra of [{}, { adType: 'Commercial' }, { medium: 'TV' }, { slot: 'PT' }, { slot: 'NPT' }]) {
    const f = { ...base, ...extra };
    const a = compute.dashboard(ds, f), b = compute.dashboard(cds, f);
    near(b.kpis ? b.kpis.category : b.sos.total.spend, a.kpis ? a.kpis.category : a.sos.total.spend, 'category');
    assert.strictEqual(b.sos.total.spots, a.sos.total.spots, 'spots ' + JSON.stringify(extra));
    near(b.sos.rows[0].spend, a.sos.rows[0].spend, 'mine spend');
    a.trend.categoryTotal.forEach((v, k) => near(b.trend.categoryTotal[k], v, 'month ' + k));
    assert.deepStrictEqual(b.duration.rows.map(r => r.counts), a.duration.rows.map(r => r.counts), 'duration counts ' + JSON.stringify(extra));
    a.duration.rows.forEach((r, k) => { if (r.acd != null) near(b.duration.rows[k].acd, r.acd, 'acd'); });
    assert.strictEqual(JSON.stringify(b.sos.rows.map(r => Math.round(r.sos * 1000))), JSON.stringify(a.sos.rows.map(r => Math.round(r.sos * 1000))), 'sos');
    // campaigns as the agency sees them: lead campaign per month
    assert.deepStrictEqual(b.drill.map(m => m.campaign && [m.campaign.name, m.campaign.advertiser, Math.round(m.campaign.spend), m.campaign.spots]),
      a.drill.map(m => m.campaign && [m.campaign.name, m.campaign.advertiser, Math.round(m.campaign.spend), m.campaign.spots]), 'lead campaigns ' + JSON.stringify(extra));
  }
  // Tag counts as a commercial: the client's tick box works on the full level
  for (const tag of [false, true]) {
    const f = { ...base, tagCommercial: tag };
    const a = compute.detail(ds, f, {}), b = compute.detail(cds, f, {});
    assert.deepStrictEqual(b.campaigns.map(c => [c.name, c.va, Math.round(c.spend), c.spots]), a.campaigns.map(c => [c.name, c.va, Math.round(c.spend), c.spots]), 'campaign list, tag ' + tag);
    for (const adType of ['Commercial', 'Sponsorship']) {
      const x = compute.dashboard(ds, { ...f, adType }), y = compute.dashboard(cds, { ...f, adType });
      near(y.sos.total.spend, x.sos.total.spend, 'adType ' + adType + ' tag ' + tag);
      assert.deepStrictEqual(y.duration.rows.map(r => r.counts), x.duration.rows.map(r => r.counts), 'duration ' + adType + tag);
      x.duration.rows.forEach((r, k) => { if (r.acd != null) near(y.duration.rows[k].acd, r.acd, 'acd ' + adType + tag); });
    }
  }
  // detail view and the mother brand filter
  const dA = compute.detail(ds, base, { advertiser: base.comps[0] }), dB = compute.detail(cds, base, { advertiser: base.comps[0] });
  near(dB.total, dA.total, 'detail total'); assert.strictEqual(dB.spots, dA.spots);
  const withMb = compute.dashboard(cds, { ...base, mb: 'Marie Co' });
  const all = compute.dashboard(cds, base);
  assert.ok(withMb.sos.total.spend < all.sos.total.spend && withMb.sos.total.spend > 0, 'mother brand filter narrows');
  // a month-ending date range snaps to whole months
  const mid = compute.dashboard(cds, { ...base, from: '2026-01-15', to: '2026-06-10' });
  near(mid.sos.total.spend, all.sos.total.spend, 'snaps to whole months');
  assert.ok(!JSON.stringify(buildCube(ds, lookup, { level: 'standard' })).includes('Morning Energy'), 'lighter levels hold no campaign names');
  // lighter cubes are smaller and keep the same totals
  const std = buildCube(ds, lookup, { level: 'standard' }), cmp = buildCube(ds, lookup, { level: 'compact' });
  assert.ok(cmp.meta.records < std.meta.records && std.meta.records < cube.meta.records);
  console.log(`records: full ${cube.meta.records}, standard ${std.meta.records}, compact ${cmp.meta.records}`);
  for (const c2 of [std, cmp]) {
    const sd = unpackCube(JSON.parse(JSON.stringify(c2)));
    const x = compute.dashboard(sd, base);
    near(x.sos.total.spend, all.sos.total.spend, 'level total'); assert.strictEqual(x.sos.total.spots, all.sos.total.spots);
    x.trend.categoryTotal.forEach((v, k) => near(v, all.trend.categoryTotal[k], 'level month'));
  }
  // "Tag counts as a commercial" is decided when the cube is built
  const tagDs = { ...ds, dicts: { ...ds.dicts, theme: ['Tag', 'Other'] }, cols: { ...ds.cols, theme: ds.cols.theme.map(() => 0) } };
  const asVa = unpackCube(JSON.parse(JSON.stringify(buildCube(tagDs, lookup, { level: 'standard' }))));
  const asCom = unpackCube(JSON.parse(JSON.stringify(buildCube(tagDs, lookup, { level: 'standard', tagCommercial: true }))));
  const vaOnly = compute.dashboard(asVa, { ...base, adType: 'Sponsorship' }), comOnly = compute.dashboard(asCom, { ...base, adType: 'Commercial' });
  assert.ok(vaOnly.sos.total.spend > 0 && comOnly.sos.total.spend > 0, 'Tag is a value addition by default and a commercial when ticked');
  near(vaOnly.sos.total.spend, compute.dashboard(tagDs, { ...base, adType: 'Sponsorship', tagCommercial: false }).sos.total.spend, 'Tag as VA matches full data');
  near(comOnly.sos.total.spend, compute.dashboard(tagDs, { ...base, adType: 'Commercial', tagCommercial: true }).sos.total.spend, 'Tag as commercial matches full data');
  // Category data in a share: same numbers, and a product-group lock leaves other groups' names out
  const catDs = deriveCategory(ds, lookup, {});
  const catAll = unpackCategory(JSON.parse(JSON.stringify(packCategory(catDs, ''))));
  const catLocked = packCategory(catDs, pgName);
  assert.deepStrictEqual(catLocked.dicts.pg, [pgName]);
  assert.ok(!JSON.stringify(catLocked.dicts).includes('Personal Care') && !JSON.stringify(catLocked.dicts.brand).includes('Shampoo'), 'no other product group names');
  const cf = { pg: pgName, from: '2026-01', to: '2026-06', mine: [catAll.dicts.adv[0]], comps: [], sub: '', top: 10, yearType: 'CY' };
  const c1 = category.overview(catDs), c2 = category.overview(catAll);
  assert.deepStrictEqual(c2.productGroups.map(g => g.name).sort(), c1.productGroups.map(g => g.name).sort());
  // locked to one product group
  const locked = buildCube(ds, lookup, { pg: pgName });
  assert.deepStrictEqual(locked.dicts.pg, [pgName]);
  console.log('Cube tests passed');
})().catch(e => { console.error(e); process.exit(1); });
