'use strict';
// Brand Map: matching, mother-brand guess, save / history / undo, and deriving the Category dataset.
const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { createBrandMap } = require('../server/brandmap');
const { keyOf, guessMother, deriveCategory } = require('../server/brand-derive');

(async () => {
  assert.strictEqual(keyOf('Hair Care', ' Signal  Herbal '), keyOf('hair care', 'signal herbal'));
  assert.strictEqual(guessMother('Signal Herbal', []), 'Signal');
  assert.strictEqual(guessMother('Close Up Triple Fresh', ['Close Up', 'Close']), 'Close Up');
  assert.strictEqual(guessMother('Closeup Gel', ['Close Up']), 'Closeup');
  assert.strictEqual(guessMother('', []), '(blank)');

  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'bm-'));
  delete process.env.DATABASE_URL; delete process.env.DATABASE_PRIVATE_URL;
  let bm = await createBrandMap(dir);
  assert.strictEqual(bm.size(), 0);
  const r1 = await bm.apply([{ pg: 'Toothpaste', brand: 'Signal Herbal', mother: 'Signal', sub: 'Herbal' }, { pg: 'Toothpaste', brand: 'Clogard Fresh', mother: 'Clogard', sub: '' }], 'Ann', 'upload');
  assert.strictEqual(r1.changed, 2);
  assert.strictEqual(bm.get('toothpaste', 'SIGNAL HERBAL').mother, 'Signal');
  const r2 = await bm.apply([{ pg: 'Toothpaste', brand: 'signal herbal', mother: 'Signal', sub: 'Herbal' }], 'Bob', 'edit');
  assert.strictEqual(r2.changed, 0, 'same values change nothing');
  const r3 = await bm.apply([{ pg: 'Toothpaste', brand: 'Signal Herbal', mother: 'Signal 2', sub: '' }], 'Bob', 'edit');
  assert.strictEqual(bm.get('Toothpaste', 'Signal Herbal').mother, 'Signal 2');
  assert.strictEqual(bm.get('Toothpaste', 'Signal Herbal').by, 'Bob');
  await assert.rejects(bm.apply([{ pg: 'Toothpaste', brand: 'X', mother: '', sub: '' }], 'Bob', 'edit'), /Mother brand is required/);
  await bm.undo(r3.batch, 'Ann');
  assert.strictEqual(bm.get('Toothpaste', 'Signal Herbal').mother, 'Signal');
  assert.strictEqual(bm.get('Toothpaste', 'Signal Herbal').sub, 'Herbal');
  await bm.undo(r1.batch, 'Ann');
  assert.strictEqual(bm.size(), 0, 'undoing the first save removes its brands');
  await bm.apply([{ pg: 'Toothpaste', brand: 'Signal Herbal', mother: 'Signal', sub: 'Herbal' }], 'Ann', 'edit');
  // survives a restart
  bm = await createBrandMap(dir);
  assert.strictEqual(bm.size(), 1);
  assert.ok(bm.version() > 0);

  // derive: spot dataset -> category dataset
  const ds = {
    dicts: { pg: ['Toothpaste'], adv: ['Unilever', 'Hemas'], product: ['Signal Herbal', 'Clogard Fresh'], channelMedium: [0, 1, 2] },
    cols: {
      mon: Int32Array.from([24000, 24000, 24000, 24001]), pg: Int32Array.from([0, 0, 0, 0]), adv: Int32Array.from([0, 0, 1, 1]),
      product: Int32Array.from([0, 0, 1, 1]), ch: Int32Array.from([0, 2, 1, 0]), cost: Float64Array.from([1000, 500, 2000, 4000]),
    },
  };
  const look = (pg, b) => bm.get(pg, b);
  const cat = deriveCategory(ds, look, { fileName: 't.csv' });
  assert.strictEqual(cat.meta.rows, 3, 'same month, advertiser and brand are one row');
  assert.deepStrictEqual(cat.dicts.mb, ['Signal', 'Clogard'], 'unmapped brand falls back to the first word');
  assert.strictEqual(cat.meta.hasSub, true);
  const total = a => a.reduce((s, v) => s + v, 0);
  assert.strictEqual(total(cat.cols.tv) + total(cat.cols.radio) + total(cat.cols.press), 7.5, 'spend is in thousand rupees');
  assert.strictEqual(total(cat.cols.press), 0.5);
  assert.strictEqual(total(cat.cols.radio), 2);
  console.log('Brand Map tests passed');
})().catch(e => { console.error(e); process.exit(1); });
