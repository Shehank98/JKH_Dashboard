'use strict';
// Checks the Category file reader and the Category aggregations against the generated sample.
const assert = require('assert');
const fs = require('fs');
const path = require('path');
const { readCategoryFile } = require('../server/browser-readers');
const { monthIndex } = require('../server/category-builder');
const C = require('../server/category');

(async () => {
  assert.strictEqual(monthIndex('Jan-22'), 2022 * 12);
  assert.strictEqual(monthIndex('Dec-2023'), 2023 * 12 + 11);
  assert.strictEqual(monthIndex('2022-03-15'), 2022 * 12 + 2);
  assert.strictEqual(monthIndex('15/04/2022'), 2022 * 12 + 3);
  assert.strictEqual(monthIndex(44562), 2022 * 12); // Excel serial for 1 Jan 2022
  assert.ok(Number.isNaN(monthIndex('hello')));

  const file = path.join(__dirname, '..', 'samples', 'category_sample.csv');
  if (!fs.existsSync(file)) require('./generate-category-sample');
  const buf = fs.readFileSync(file);
  const blob = new Blob([buf]);
  blob.name = 'category_sample.csv';
  const ds = await readCategoryFile(blob, () => {});
  assert.ok(ds.meta.rows > 1000 && ds.meta.hasSub, 'sub category detected');

  const ov = C.overview(ds);
  assert.strictEqual(ov.minMonth, '2022-01');
  assert.strictEqual(ov.maxMonth, '2026-09');
  const F = { from: '2026-07', to: '2026-09', pg: 'Hair Care', sub: '', mine: ['Unilever Sri Lanka'], comps: [], top: 10 };
  const d = C.dashboard(ds, F);
  assert.strictEqual(d.ranges.yoy[0], '2025-07');
  assert.strictEqual(d.ranges.prev[0], '2026-04');
  assert.strictEqual(d.cards.length >= 10, true);
  const sunsilk = d.cards.find(c => c.name === 'Sunsilk');
  assert.ok(sunsilk && sunsilk.mine, 'our mother brands are flagged');
  assert.ok(d.cards.every((c, i) => i === 0 || d.cards[i - 1].cur >= c.cur), 'sorted by spend');
  assert.ok(Math.abs(d.cards.reduce((s, c) => s + c.share, 0) - 100) < 100 && d.total.cur > 0);
  // Cards add up to the category when every mother brand is shown.
  const all = C.dashboard(ds, { ...F, top: 0 });
  assert.ok(Math.abs(all.cards.reduce((s, c) => s + c.cur, 0) - all.total.cur) < 1e-6);
  assert.ok(Math.abs(all.cards.reduce((s, c) => s + c.share, 0) - 100) < 1e-6);
  // Medium split adds up to the card total.
  for (const c of all.cards) assert.ok(Math.abs(c.medium[0] + c.medium[1] + c.medium[2] - c.cur) < 1e-6);
  // Competitor filter keeps only picked advertisers' brands plus ours.
  const comp = C.dashboard(ds, { ...F, comps: ['Marico Lanka'] });
  assert.ok(comp.cards.every(c => c.mine || c.name === 'Parachute'));
  // Sub category filter narrows the total.
  const shampoo = C.dashboard(ds, { ...F, sub: 'Shampoo', top: 0 });
  assert.ok(shampoo.total.cur < all.total.cur && shampoo.total.cur > 0);
  // First months of data have no earlier year to compare with.
  const early = C.dashboard(ds, { ...F, from: '2022-01', to: '2022-03' });
  assert.strictEqual(early.hasYoy, false);
  assert.strictEqual(early.cards[0].growth, null);
  // Detail adds up to the card.
  const det = C.detail(ds, F, { mb: 'Sunsilk' });
  assert.ok(Math.abs(det.cur - sunsilk.cur) < 1e-6);
  assert.ok(Math.abs(det.advertisers.reduce((s, a) => s + a.cur, 0) - det.cur) < 1e-6);
  assert.strictEqual(det.monthly.length, 3);
  // A bad header fails clearly.
  const bad = new Blob(['Foo,Bar\n1,2\n']); bad.name = 'x.csv';
  await assert.rejects(() => readCategoryFile(bad, () => {}), /header row/);
  console.log('Category tests passed');
})().catch(e => { console.error(e); process.exit(1); });
