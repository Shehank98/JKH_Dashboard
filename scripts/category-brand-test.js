'use strict';
// The brand view must agree with the Category dashboard's own numbers and add up at every level.
const assert = require('assert');
const fs = require('fs');
const path = require('path');
const { readSpotFile } = require('../server/browser-readers');
const { deriveCategory, keyOf } = require('../server/brand-derive');
const category = require('../server/category');
const { brandView } = require('../server/category-brand');

const file = process.argv[2] || path.join(__dirname, '..', 'samples', 'sample_420000.csv');
const near = (a, b, w) => assert.ok(Math.abs(a - b) <= Math.max(1e-6, Math.abs(b) * 1e-9) + 1e-6, `${w}: ${a} vs ${b}`);
const sum = (a, k) => a.reduce((s, x) => s + x[k], 0);
(async () => {
  const ds = await readSpotFile(new File([await fs.openAsBlob(file)], path.basename(file)), () => {});
  const map = new Map();
  ds.dicts.product.forEach(b => map.set(keyOf('Biscuits & Confectionery', b), { mother: b === 'Marie' || b === 'Lemon Puff' ? 'Maliban Core' : b, sub: b === 'Marie' ? 'Plain' : '' }));
  const lookup = (pg, b) => map.get(keyOf(pg, b)) || null;
  const catDs = deriveCategory(ds, lookup, {});
  const f = { pg: 'Biscuits & Confectionery', from: '2026-04', to: '2026-06', mine: [ds.dicts.adv[0]], comps: [], sub: '', top: 10, yearType: 'CY' };

  // category level: children are mother brands and match the Category dashboard
  const all = brandView(ds, lookup, f, {}, {});
  const cd = category.detail(catDs, f, { all: true });
  near(all.head.cur, cd.cur, 'category total'); near(all.head.yoy, cd.yoy, 'category total yoy');
  assert.strictEqual(all.childKind, 'mb');
  near(sum(all.children, 'cur'), all.head.cur, 'mother brands add up');
  const mbName = all.children[0].name;
  const cdMb = category.detail(catDs, f, { mb: mbName });
  const mbv = brandView(ds, lookup, f, { mb: mbName }, {});
  near(mbv.head.cur, cdMb.cur, 'mother brand'); near(mbv.head.yoy, cdMb.yoy, 'mother brand yoy'); near(mbv.head.cat.cur, cdMb.catCur, 'category cur');
  near(mbv.head.sos.cur, (cdMb.cur / cdMb.catCur) * 100, 'sos');
  assert.strictEqual(mbv.childKind, 'brand');
  // everything inside one mother brand adds up
  for (const [what, rows] of [['brands', mbv.children], ['channels', mbv.channels], ['advertisers', mbv.advertisers]]) near(sum(rows, 'cur'), mbv.head.cur, what + ' add up');
  near(mbv.head.split.C + mbv.head.split.V, mbv.head.cur, 'commercials + value additions');
  near(sum(mbv.campaigns.C, 'cur') + sum(mbv.campaigns.V, 'cur') <= mbv.head.cur + 1e-6 ? mbv.head.cur : -1, mbv.head.cur, 'campaigns fit');
  near(sum(mbv.monthsList, 'spend'), mbv.head.cur, 'months add up'); near(sum(mbv.adType.monthly, 'C') + sum(mbv.adType.monthly, 'V'), mbv.head.cur, 'monthly ad type');
  near(sum(mbv.adType.byMedium, 'C') + sum(mbv.adType.byMedium, 'V'), mbv.head.cur, 'medium ad type');
  assert.strictEqual(mbv.head.spots, sum(mbv.channels, 'spots'));
  // one brand, then one channel, then ad type and medium
  const brand = mbv.children[0].name;
  const bv = brandView(ds, lookup, f, { mb: mbName, brand }, {});
  near(bv.head.cur, mbv.children[0].cur, 'brand matches its row'); assert.strictEqual(bv.childKind, null); assert.strictEqual(bv.level, 'brand');
  const chKey = bv.channels[0].key;
  const cv = brandView(ds, lookup, f, { mb: mbName, brand, ch: chKey }, {});
  near(cv.head.cur, bv.channels[0].cur, 'channel row'); assert.strictEqual(cv.channels.length, 1);
  near(cv.head.sos.cur, bv.channels[0].sosHere, 'share on that channel');
  const med = brandView(ds, lookup, f, { mb: mbName, medium: 'TV' }, {});
  near(med.head.cur, mbv.head.mediums[0], 'medium narrows');
  const va = brandView(ds, lookup, f, { mb: mbName, vt: 'V' }, {}), co = brandView(ds, lookup, f, { mb: mbName, vt: 'C' }, {});
  near(va.head.cur, mbv.head.split.V, 'value additions only'); near(co.head.cur, mbv.head.split.C, 'commercials only');
  assert.ok(va.head.cat.cur < mbv.head.cat.cur, 'share of spend is like for like (category narrows too)');
  // the Tag tick box moves spend between the two
  const tagA = brandView(ds, lookup, f, {}, { tagCommercial: false }), tagB = brandView(ds, lookup, f, {}, { tagCommercial: true });
  near(tagA.head.cur, tagB.head.cur, 'total does not change'); assert.ok(tagB.head.split.C >= tagA.head.split.C);
  // another period (one month) and a sub category filter
  const one = brandView(ds, lookup, f, { mb: mbName, from: '2026-05', to: '2026-05' }, {});
  assert.strictEqual(one.months, 1); near(one.head.cur, mbv.monthsList.find(m => m.key === '2026-05').spend, 'one month');
  const sub = brandView(ds, lookup, { ...f, sub: 'Plain' }, {}, {});
  assert.ok(sub.head.cat.cur < all.head.cat.cur && sub.head.cat.cur > 0, 'sub category filter narrows the category');
  // the name on top stays the brand you drilled into
  const onCh = brandView(ds, lookup, f, { mb: mbName, ch: mbv.channels[0].key, medium: 'TV', theme: mbv.campaigns.C[0].name }, {});
  assert.strictEqual(onCh.name, mbName); assert.strictEqual(onCh.kind, 'Mother brand');
  assert.strictEqual(brandView(ds, lookup, f, { ch: mbv.channels[0].key }, {}).name, f.pg);
  assert.ok(mbv.mothers.length >= 2 && mbv.mothers.some(m => m.self && m.name === mbName), 'every mother brand is offered as a quick jump');
  assert.ok(mbv.campaigns.C.every(c => c.brand && c.brands >= 1), 'each campaign names its brand');
  // medium split, duration mix and channel mix
  near(sum(mbv.mediums, 'cur'), mbv.head.cur, 'mediums add up'); near(sum(mbv.mediums, 'share'), 100, 'medium shares');
  near(mbv.channels.reduce((a, c) => a + (c.catShare || 0), 0), 100, 'category channel mix adds to 100');
  assert.ok(mbv.duration.hasLengths && sum(mbv.duration.brand.counts.map(c => ({ c })), 'c') > 0, 'duration counts');
  assert.ok(mbv.duration.brand.acd > 0 && mbv.duration.cat.acd > 0, 'acd');
  const dur = mbv.duration.buckets.find((b, i) => mbv.duration.brand.counts[i] > 0), di = mbv.duration.buckets.indexOf(dur);
  const dv = brandView(ds, lookup, f, { mb: mbName, dur }, {});
  assert.ok(dv.head.cur > 0 && dv.head.cur < mbv.head.cur, 'one ad length narrows');
  assert.strictEqual(dv.duration.brand.counts[di], mbv.duration.brand.counts[di], 'same spots in that length');
  assert.ok(Array.isArray(mbv.sos.self) && mbv.sos.self.every(v => v == null || Number.isFinite(v)), 'sos series is a plain list of numbers');
  assert.strictEqual(JSON.stringify(mbv).includes('NaN'), false);
  assert.throws(() => brandView(ds, lookup, f, { mb: 'No such' }, {}), /Unknown mother brand/);
  console.log('Brand view tests passed');
})().catch(e => { console.error(e); process.exit(1); });
