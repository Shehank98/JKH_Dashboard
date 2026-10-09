'use strict';
// The browser readers must build exactly the same dataset as the Node reader the drill-down checks verify.
// Run: npm run test:readers   (uses samples/sample_420000.csv and .xlsx when present; npm run sample makes them)
const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { ingestFile } = require('../server/ingest');
const { readSpotFile } = require('../server/browser-readers');

const asFile = file => fs.openAsBlob(file).then(b => new File([b], path.basename(file)));
function same(a, b, label) {
  assert.deepStrictEqual(a.dicts, b.dicts, label + ': dictionaries');
  for (const k of Object.keys(a.cols)) {
    const x = a.cols[k], y = b.cols[k];
    assert.ok(y, `${label}: column ${k} missing`);
    assert.strictEqual(y.constructor.name, x.constructor.name, `${label}: ${k} type`);
    assert.strictEqual(y.length, x.length, `${label}: ${k} length`);
    for (let i = 0; i < x.length; i++) {
      if (x[i] !== y[i] && !(Number.isNaN(x[i]) && Number.isNaN(y[i]))) assert.fail(`${label}: ${k}[${i}] node=${x[i]} browser=${y[i]}`);
    }
  }
  for (const k of ['rows', 'skipped', 'minDay', 'maxDay']) assert.strictEqual(b.meta[k], a.meta[k], `${label}: meta.${k}`);
}

(async () => {
  // Small files with the awkward cases: quotes, "" escapes, delimiter inside quotes, semicolons, BOM, CRLF, blank lines.
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ooc-readers-'));
  const header = 'Product_Group,Advertiser,Product,Advt_Theme,Channel,Program,Dd,Mn,Yr,Day,Prog_time,Advt_time,AdPos,TotAds,BrkNo,PosinBrk,AdsinBrk,Lng,Dur,Cost';
  const cases = {
    'quotes.csv': [header,
      'Biscuits,"Me, Ltd",P,"Say ""Hi""",TV - Derana TV,News,5,1,2026,Mon,19:00,19:45:00,1,5,1,1,5,Sinhala,30,"1,000,000"',
      '',
      'Biscuits,Rival,P,Theme B ,  FM Derana ,Show,6,Feb,26,Tue,08:00,7:15 PM,1,5,1,2,5,Sinhala,15,500000',
      'Biscuits,Bad,P,X,Lankadeepa,,31,2,2026,Thu,,,,,,,,Sinhala,,1',
      'Biscuits,Odd,P,5" spot,Lankadeepa,,8,2,2026,Thu,,,,,,,,Sinhala,,700000'].join('\r\n') + '\r\n',
    'semicolon.csv': '﻿' + [header.replace(/,/g, ';'), 'Biscuits;Me;P;Theme A;TV - Derana TV;News;5;1;2026;Mon;19:00;19:45:00;1;5;1;1;5;Sinhala;30;1000000',
      'Biscuits;Rival;P;"A;B";TV - Sirasa TV;News;7;2;2026;Wed;20:00;20:15:00;1;5;1;3;5;Sinhala;20;2000000'].join('\n'),
    'noeol.csv': [header, 'Biscuits,Me,P,Theme A,TV - Derana TV,News,5,1,2026,Mon,19:00,19:45:00,1,5,1,1,5,Sinhala,30,"1,000"'].join('\n'),
  };
  for (const [name, text] of Object.entries(cases)) {
    const f = path.join(dir, name);
    fs.writeFileSync(f, text);
    same(await ingestFile(f, name), await readSpotFile(await asFile(f)), name);
  }
  fs.rmSync(dir, { recursive: true, force: true });
  console.log('Edge-case CSVs match');

  for (const name of ['sample_420000.csv', 'sample_420000.xlsx']) {
    const f = path.join(__dirname, '..', 'samples', name);
    if (!fs.existsSync(f)) { console.log(`Skipped ${name} (run npm run sample)`); continue; }
    let t = Date.now();
    const node = await ingestFile(f, name);
    const nodeMs = Date.now() - t; t = Date.now();
    let calls = 0, lastPct = 0;
    const browser = await readSpotFile(await asFile(f), p => { calls++; assert.ok(p >= lastPct - 1e-9 && p <= 1); lastPct = p; });
    const browserMs = Date.now() - t;
    same(node, browser, name);
    assert.ok(calls > 1, 'progress is reported');
    console.log(`${name}: ${browser.meta.rows.toLocaleString()} rows identical (node ${(nodeMs / 1000).toFixed(1)}s, browser reader ${(browserMs / 1000).toFixed(1)}s)`);
  }
  console.log('Browser readers match the Node reader');
})().catch(e => { console.error(e); process.exit(1); });
