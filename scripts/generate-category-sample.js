'use strict';
// Writes samples/category_sample.csv in the Category file layout (Month, Product Group, Mother Brand, Advertiser,
// Brand, Sub Category, Tv/Radio/Press spend in 000Rs plus frequency columns that the dashboard ignores).
const fs = require('fs');
const path = require('path');

const MON = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
let seed = 7;
const rnd = () => { seed = (seed * 1664525 + 1013904223) % 4294967296; return seed / 4294967296; };

// [product group, mother brand, advertiser, sub category, base monthly spend (000Rs), brands]
const BRANDS = [
  ['Hair Care', 'Sunsilk', 'Unilever Sri Lanka', 'Shampoo', 150000, ['Sunsilk Black Shine', 'Sunsilk Hairfall', 'Sunsilk Sachet']],
  ['Hair Care', 'Lifebuoy', 'Unilever Sri Lanka', 'Shampoo', 70000, ['Lifebuoy Care', 'Lifebuoy Clear']],
  ['Hair Care', 'Dove', 'Unilever Sri Lanka', 'Conditioner', 65000, ['Dove Intense Repair', 'Dove Daily Shine']],
  ['Hair Care', 'Kumarika', 'Kumarika Hair Care', 'Hair Oil', 60000, ['Kumarika Hair Oil', 'Kumarika Shampoo']],
  ['Hair Care', 'Swabha Ceylon', 'Swabha Ceylon', 'Hair Oil', 38000, ['Swabha Oil']],
  ['Hair Care', 'Herbline', 'Herbline Ceylon', 'Shampoo', 15000, ['Herbline Herbal']],
  ['Hair Care', 'Head & Shoulders', 'P&G Sri Lanka', 'Shampoo', 12000, ['H&S Classic', 'H&S Menthol']],
  ['Hair Care', 'Parachute', 'Marico Lanka', 'Hair Oil', 30000, ['Parachute Coconut', 'Parachute Advanced']],
  ['Hair Care', 'Dreamron', 'Dreamron Lanka', 'Hair Colour', 18000, ['Dreamron Colour']],
  ['Hair Care', 'Dandex', 'Dandex Pvt', 'Shampoo', 14000, ['Dandex Anti-dandruff']],
  ['Hair Care', 'Clinic Plus', 'Unilever Sri Lanka', 'Shampoo', 9000, ['Clinic Plus Strong']],
  ['Hair Care', 'Pantene', 'P&G Sri Lanka', 'Conditioner', 7000, ['Pantene Pro-V']],
  ['Skin Care', 'Pond\'s', 'Unilever Sri Lanka', 'Face Cream', 55000, ['Pond\'s White Beauty']],
  ['Skin Care', 'Fair & Lovely', 'Unilever Sri Lanka', 'Face Cream', 48000, ['Glow & Lovely']],
  ['Skin Care', 'Nivea', 'Beiersdorf', 'Body Lotion', 40000, ['Nivea Soft', 'Nivea Body']],
  ['Skin Care', 'Vaseline', 'Unilever Sri Lanka', 'Body Lotion', 26000, ['Vaseline Cocoa']],
];

const rows = [['Month', 'Product Group', 'Mother Brand', 'Advertiser', 'Brand', 'Sub Category', 'Tv (000Rs)', 'Tv Frq', 'Tv Dur(secs)', 'Radio (000Rs)', 'Radio Frq', 'Radio Dur(secs)', 'Press (000Rs)', 'Press Ins', 'Total (000Rs)']];
for (let y = 2022; y <= 2026; y++) {
  for (let m = 0; m < 12; m++) {
    if (y === 2026 && m > 8) break;
    for (const [pg, mb, adv, sub, base, brands] of BRANDS) {
      const season = 1 + 0.25 * Math.sin((m / 12) * Math.PI * 2 + base % 7);
      const trend = 1 + (y - 2022) * 0.06;
      for (const brand of brands) {
        const total = base * season * trend * (0.7 + rnd() * 0.6) / brands.length;
        const tv = Math.round(total * 0.78), radio = Math.round(total * 0.09), press = Math.round(total * 0.13);
        rows.push([`${MON[m]}-${String(y).slice(2)}`, pg, mb, adv, brand, sub, tv, Math.round(tv / 40), 30, radio, Math.round(radio / 12), 30, press, Math.round(press / 90), tv + radio + press]);
      }
    }
  }
}
const out = path.join(__dirname, '..', 'samples', 'category_sample.csv');
fs.mkdirSync(path.dirname(out), { recursive: true });
fs.writeFileSync(out, rows.map(r => r.map(v => (/[",]/.test(String(v)) ? `"${String(v).replace(/"/g, '""')}"` : v)).join(',')).join('\n'));
console.log('Wrote', out, rows.length - 1, 'rows');
