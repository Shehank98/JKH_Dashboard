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
  // Month by month history: first month in the file to the last selected month; the selected months add up to the card.
  assert.strictEqual(d.monthly.months.length, 57);
  assert.strictEqual(d.monthly.months[0], '2022-01');
  assert.strictEqual(d.monthly.months[d.monthly.selStart], '2026-07');
  assert.strictEqual(d.monthly.months[56], '2026-09');
  assert.ok(Math.abs(sunsilk.monthly.slice(d.monthly.selStart).reduce((a, b) => a + b, 0) - sunsilk.cur) < 1e-6);
  assert.ok(Math.abs(d.monthly.cat.slice(d.monthly.selStart).reduce((a, b) => a + b, 0) - d.total.cur) < 1e-6);
  // History by medium and sub category adds up to the category month by month.
  assert.strictEqual(d.history.tv.length, 57);
  d.monthly.cat.forEach((c, i) => assert.ok(Math.abs(d.history.tv[i] + d.history.radio[i] + d.history.press[i] - c) < 1e-6));
  d.monthly.cat.forEach((c, i) => assert.ok(Math.abs(d.history.subs.reduce((a, x) => a + x.values[i], 0) - c) < 1e-6));
  // Cards add up to the category when every mother brand is shown.
  const all = C.dashboard(ds, { ...F, top: 0 });
  assert.ok(Math.abs(all.cards.reduce((s, c) => s + c.cur, 0) - all.total.cur) < 1e-6);
  assert.ok(Math.abs(all.cards.reduce((s, c) => s + c.share, 0) - 100) < 1e-6);
  // Medium split adds up to the card total.
  for (const c of all.cards) assert.ok(Math.abs(c.medium[0] + c.medium[1] + c.medium[2] - c.cur) < 1e-6);
  // Sub category tables: one per sub category, totals add up to the category, shares add up within a table.
  assert.strictEqual(d.hasSubs, true);
  assert.deepStrictEqual(d.tables.map(t => t.name).sort(), ['Conditioner', 'Hair Oil', 'Hair Colour', 'Shampoo'].sort());
  assert.ok(Math.abs(d.tables.reduce((a, t) => a + t.cur, 0) - d.total.cur) < 1e-6);
  for (const t of d.tables) {
    assert.ok(Math.abs(t.rows.reduce((a, r) => a + r.cur, 0) - t.cur) < 1e-6, 'rows add up to the sub category');
    assert.ok(t.rows.length <= 9 + 4, 'Others folds the long tail');
    assert.ok(Math.abs(t.rows.reduce((a, r) => a + r.share, 0) - 100) < 1e-6);
  }
  assert.ok(d.tables.every((t, i) => i === 0 || d.tables[i - 1].cur >= t.cur), 'biggest first');
  assert.ok(Math.abs(d.mix.cur.reduce((a, b) => a + b, 0) - 100) < 1e-6);
  assert.ok(Math.abs(d.contribution.reduce((a, c) => a + c.part, 0) - 100) < 1e-6, 'contributions add up to 100% of the net change');
  const sh = C.detail(ds, F, { sub: 'Shampoo' });
  assert.ok(Math.abs(sh.cur - d.tables.find(t => t.name === 'Shampoo').cur) < 1e-6);
  assert.ok(sh.mothers.length > 1 && sh.name === 'Shampoo');
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
  // Drill-down scopes: a period, a medium, an advertiser, a brand, a set (the folded Others row) and combinations.
  const lastKey = d.monthly.months[d.monthly.months.length - 1], lastIdx = d.monthly.months.length - 1;
  const whole = C.detail(ds, F, { all: true });
  assert.ok(Math.abs(whole.cur - d.total.cur) < 1e-6 && Math.abs(whole.catCur - d.total.cur) < 1e-6);
  const oneMonth = C.detail(ds, F, { all: true, from: lastKey, to: lastKey });
  assert.ok(Math.abs(oneMonth.cur - d.monthly.cat[lastIdx]) < 1e-6 && oneMonth.months === 1 && oneMonth.from === lastKey);
  const tvOnly = C.detail(ds, F, { all: true, medium: 'TV' });
  assert.ok(Math.abs(tvOnly.cur - d.history.tv.slice(d.monthly.selStart).reduce((a, b) => a + b, 0)) < 1e-6, 'medium scope');
  assert.ok(tvOnly.catCur === tvOnly.cur, 'share of category is within the same medium');
  const adv = C.detail(ds, F, { adv: 'Unilever Sri Lanka' });
  assert.ok(Math.abs(adv.cur - d.cards.filter(c => c.mine).reduce((a, c) => a + c.cur, 0)) < 1e-6, 'advertiser scope');
  const br = C.detail(ds, F, { mb: 'Sunsilk' }).brands[0];
  assert.ok(Math.abs(C.detail(ds, F, { brand: br.name }).cur - br.cur) < 1e-6, 'brand scope');
  const combo = C.detail(ds, F, { mb: 'Sunsilk', sub: 'Shampoo', medium: 'Press', from: '2026-08', to: '2026-09' });
  assert.ok(combo.cur > 0 && combo.months === 2 && combo.monthly.every(m => m.tv === 0 && m.radio === 0));
  const tight = C.dashboard(ds, { ...F, top: 5 });
  const othersRow = d.tables.flatMap(t => t.rows.map(r => ({ t, r }))).find(x => x.r.others);
  if (othersRow) assert.ok(Math.abs(C.detail(ds, F, { mbs: othersRow.r.names, sub: othersRow.t.name }).cur - othersRow.r.cur) < 1e-6, 'Others row drill-down');
  assert.ok(tight.cards.length >= 5);
  // Without sub categories there is one table of mother brands and no mix or contribution.
  const plain = new Blob([buf.toString().split('\n').map(l => l.replace(/^([^,]*,[^,]*,[^,]*,[^,]*,[^,]*,)[^,]*,/, '$1')).join('\n')]);
  plain.name = 'plain.csv';
  const dsPlain = await readCategoryFile(plain, () => {});
  const one = C.dashboard(dsPlain, F);
  assert.ok(!one.hasSubs && one.tables.length === 1 && one.mix === null && one.contribution === null);
  assert.strictEqual(one.tables[0].name, 'Hair Care');
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
