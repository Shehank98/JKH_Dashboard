'use strict';
// Generates a realistic dummy spot log for testing.
// Usage: node scripts/generate-sample.js [rows=420000] [csv|xlsx|both]

const fs = require('fs');
const path = require('path');
const ExcelJS = require('exceljs');

const ROWS = Number(process.argv[2] || 420000);
const FORMAT = process.argv[3] || 'both';
const OUT = path.join(__dirname, '..', 'samples');
fs.mkdirSync(OUT, { recursive: true });

let seed = 42;
const rnd = () => ((seed = (seed * 1664525 + 1013904223) >>> 0) / 4294967296);
const pick = (arr, w) => {
  if (!w) return arr[Math.floor(rnd() * arr.length)];
  const t = w.reduce((a, b) => a + b, 0);
  let r = rnd() * t;
  for (let i = 0; i < arr.length; i++) { r -= w[i]; if (r <= 0) return arr[i]; }
  return arr[arr.length - 1];
};

const GROUPS = {
  'Biscuits & Confectionery': {
    w: 5,
    advertisers: ['Maliban Biscuit Mfy', 'Derana Foods PLC', 'Munchee / CBL', 'Lucky Lanka', 'Uswatte Confectionery', 'Tiara Foods', 'Kandos', 'Edna Chocolates', 'Ritzbury', 'Cadbury Lanka', 'Harischandra Mills', 'Prima Ceylon', 'Keells Krest', 'Derana Dairy'],
    aw: [26, 24, 19, 10, 4, 3, 3, 2.5, 2.5, 2, 1.5, 1, 1, 0.5],
    themes: ['Rich Taste Rich Moments', 'Back to School Bundle', 'Crunch Festival', 'Monsoon Tea Time', 'Vesak Family Pack', 'Avurudu Table', 'Christmas Treats', 'Snack Smart'],
    products: ['Cream Crackers', 'Chocolate Puff', 'Marie', 'Lemon Puff', 'Wafers'],
  },
  'Dairy & Beverages': {
    w: 3,
    advertisers: ['Pelwatte Dairy', 'Highland Milk', 'Anchor', 'Nestle Lanka', 'Kotmale', 'Elephant House', 'Dilmah', 'Lipton'],
    aw: [18, 16, 20, 15, 10, 9, 7, 5],
    themes: ['Strong Nation', 'Morning Energy', 'Pure Ceylon', 'Family Goodness', 'Avurudu Cheer'],
    products: ['Full Cream Milk', 'Yoghurt', 'Tea', 'Soft Drink'],
  },
  'Personal Care': {
    w: 2,
    advertisers: ['Hemas Consumer', 'Unilever Sri Lanka', 'Swadeshi Industrial Works', 'Link Natural', 'Nature Secrets', 'Siddhalepa'],
    aw: [25, 30, 12, 13, 10, 10],
    themes: ['Glow Naturally', 'Herbal Heritage', 'Fresh Every Day', 'Festive Glow'],
    products: ['Soap', 'Shampoo', 'Toothpaste', 'Balm'],
  },
};
const CHANNELS = [
  ['TV - Derana TV', 22], ['TV - Sirasa TV', 18], ['TV - Hiru TV', 16], ['TV - Swarnavahini', 6], ['TV - ITN', 4], ['TV - Rupavahini', 3],
  ['FM Derana', 5], ['FM - Hiru FM', 4.5], ['FM - Sirasa FM', 4], ['FM - Shaa FM', 2], ['Radio - Neth FM', 1.5],
  ['Lankadeepa', 5], ['Daily Mirror', 3.5], ['Divaina', 2.5], ['Sunday Times', 2],
];
const PROGRAMS = ['News 7pm', 'Teledrama', 'Morning Show', 'Cricket Live', 'Reality Show', 'Movie', 'Music Hour'];
const SEASON = [0.8, 0.9, 0.9, 1.25, 1.1, 0.9, 1.0, 1.1, 1.15, 0.95, 1.0, 1.3];
const DAYS = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];
const start = Date.UTC(2025, 0, 1), end = Date.UTC(2026, 8, 30);
const nDays = (end - start) / 86400000 + 1;

const header = ['Product_Group', 'Advertiser', 'Product', 'Advt_Theme', 'Channel', 'Program', 'Dd', 'Mn', 'Yr', 'Day', 'Prog_time', 'Advt_time', 'AdPos', 'TotAds', 'BrkNo', 'PosinBrk', 'AdsinBrk', 'Lng', 'Dur', 'Cost'];
const groupNames = Object.keys(GROUPS), groupW = groupNames.map(g => GROUPS[g].w);
const chNames = CHANNELS.map(c => c[0]), chW = CHANNELS.map(c => c[1]);
const pad = n => String(n).padStart(2, '0');

function makeRow() {
  let t;
  do { t = start + Math.floor(rnd() * nDays) * 86400000; } while (rnd() > SEASON[new Date(t).getUTCMonth()] / 1.3);
  const dt = new Date(t);
  const g = pick(groupNames, groupW), G = GROUPS[g];
  const adv = pick(G.advertisers, G.aw);
  const ch = pick(chNames, chW);
  const press = !/TV|FM|Radio/.test(ch);
  const tv = /TV/.test(ch);
  const h = press ? null : pick([6, 7, 8, 9, 10, 12, 13, 15, 17, 19, 20, 21, 22, 23], [3, 4, 4, 3, 2, 2, 2, 2, 3, 8, 9, 8, 4, 2]);
  const time = press ? '' : `${pad(h)}:${pad(Math.floor(rnd() * 60))}:${pad(Math.floor(rnd() * 60))}`;
  const ads = 3 + Math.floor(rnd() * 10), pos = 1 + Math.floor(rnd() * ads);
  const dur = press ? '' : pick([5, 7, 10, 12, 15, 18, 20, 25, 30, 40, 45, 60], [16, 6, 6, 4, 16, 3, 10, 5, 14, 2, 2, 1]);
  const prime = h >= 19 && h < 23;
  const base = press ? 50000 + rnd() * 90000 : (tv ? 95000 : 42000) * (dur / 30 + 0.3) * (prime ? 1.8 : 1);
  let theme = G.themes[(dt.getUTCMonth() + G.advertisers.indexOf(adv)) % G.themes.length];
  // A few sponsorship and filler items, which the dashboard must ignore when picking campaigns.
  if (rnd() < 0.05) theme = pick(['-BB', 'Com Break', 'DJ', '-Extro', '-Intro', '-LLogo', 'Next Card', 'Tag', 'Time Check', '-Tr', theme + ' -BB']);
  return [g, adv, pick(G.products), theme, ch, press ? '' : pick(PROGRAMS), dt.getUTCDate(), dt.getUTCMonth() + 1, dt.getUTCFullYear(),
    DAYS[dt.getUTCDay()], press ? '' : `${pad(h)}:00`, time, press ? '' : pick(['Start', 'Mid', 'End']), press ? '' : ads,
    press ? '' : 1 + Math.floor(rnd() * 6), press ? '' : pos, press ? '' : ads, pick(['Sinhala', 'Tamil', 'English'], [7, 2, 1]), dur,
    Math.round(base * (0.85 + rnd() * 0.3))];
}

async function main() {
  const t0 = Date.now();
  if (FORMAT === 'csv' || FORMAT === 'both') {
    const file = path.join(OUT, `sample_${ROWS}.csv`);
    const ws = fs.createWriteStream(file);
    ws.write(header.join(',') + '\n');
    seed = 42;
    for (let i = 0; i < ROWS; i++) {
      const line = makeRow().map(v => (typeof v === 'string' && /[",]/.test(v) ? `"${v.replace(/"/g, '""')}"` : v)).join(',') + '\n';
      if (!ws.write(line)) await new Promise(r => ws.once('drain', r));
    }
    await new Promise(r => ws.end(r));
    console.log('Wrote', file, (fs.statSync(file).size / 1048576).toFixed(1), 'MB');
  }
  if (FORMAT === 'xlsx' || FORMAT === 'both') {
    const file = path.join(OUT, `sample_${ROWS}.xlsx`);
    const wb = new ExcelJS.stream.xlsx.WorkbookWriter({ filename: file, useSharedStrings: true });
    const sheet = wb.addWorksheet('Data');
    sheet.addRow(header).commit();
    seed = 42;
    for (let i = 0; i < ROWS; i++) sheet.addRow(makeRow()).commit();
    sheet.commit();
    await wb.commit();
    console.log('Wrote', file, (fs.statSync(file).size / 1048576).toFixed(1), 'MB');
  }
  console.log('Done in', ((Date.now() - t0) / 1000).toFixed(1), 's');
}
main();
