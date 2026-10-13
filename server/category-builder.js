'use strict';
// Turns category rows (arrays of cell values, header row first) into a compact columnar dataset.
// One row = one month, product group, mother brand, advertiser and brand, with spend per medium in thousand rupees.
// Only Month, Product Group, Mother Brand, Advertiser, Brand, Sub Category and the TV / Radio / Press (000Rs) columns
// are used; frequency, duration, insertion and Total columns are ignored (Total is recomputed).

const norm = s => String(s == null ? '' : s).toLowerCase().replace(/[^a-z0-9]/g, '');

const COLUMN_KEYS = {
  month: 'month', mn: 'month', period: 'month', date: 'month',
  productgroup: 'pg', category: 'pg',
  motherbrand: 'mb', advertiser: 'adv', brand: 'brand',
  subcategory: 'sub', subcat: 'sub', segment: 'sub',
  tv000rs: 'tv', tvrs000: 'tv', tvspend: 'tv', tvrs: 'tv',
  radio000rs: 'radio', radiors000: 'radio', radiospend: 'radio', radiors: 'radio',
  press000rs: 'press', pressrs000: 'press', pressspend: 'press', pressrs: 'press',
};
const MON3 = { jan: 0, feb: 1, mar: 2, apr: 3, may: 4, jun: 5, jul: 6, aug: 7, sep: 8, oct: 9, nov: 10, dec: 11 };
const monthOfName = s => MON3[String(s).slice(0, 3).toLowerCase()];
const fullYear = y => { const n = Number(y); return y.length <= 2 ? 2000 + n : n; };

// Month as year * 12 + month (0 to 11), or NaN. Accepts Jan-22, Jan-2022, January 2022, 2022-01(-15), 01/2022,
// 15/01/2022, 15-Jan-2022, a JS Date, or an Excel date number.
function monthIndex(v) {
  if (v == null || v === '') return NaN;
  const fromDate = d => d.getUTCFullYear() * 12 + d.getUTCMonth();
  if (v instanceof Date) return Number.isNaN(v.getTime()) ? NaN : fromDate(v);
  const serial = n => (n > 20000 && n < 80000 ? fromDate(new Date(Math.round((n - 25569) * 86400000))) : NaN);
  if (typeof v === 'number') return serial(v);
  const s = String(v).trim();
  let m;
  if (/^\d{5}(\.\d+)?$/.test(s)) return serial(Number(s));
  if ((m = s.match(/^([A-Za-z]{3,9})\.?[\s\-/'.,]*(\d{4}|\d{2})$/)) && monthOfName(m[1]) !== undefined) return fullYear(m[2]) * 12 + monthOfName(m[1]);
  if ((m = s.match(/^(\d{4})[-/.](\d{1,2})(?:[-/.]\d{1,2})?$/)) && +m[2] >= 1 && +m[2] <= 12) return +m[1] * 12 + (+m[2] - 1);
  if ((m = s.match(/^\d{1,2}[-/. ]([A-Za-z]{3,9})[-/. ,]*(\d{4}|\d{2})$/)) && monthOfName(m[1]) !== undefined) return fullYear(m[2]) * 12 + monthOfName(m[1]);
  if ((m = s.match(/^(\d{1,2})[-/.](\d{4})$/)) && +m[1] >= 1 && +m[1] <= 12) return +m[2] * 12 + (+m[1] - 1);
  if ((m = s.match(/^(\d{1,2})[-/.](\d{1,2})[-/.](\d{4}|\d{2})$/)) && +m[2] >= 1 && +m[2] <= 12) return fullYear(m[3]) * 12 + (+m[2] - 1);
  const t = Date.parse(s);
  return Number.isNaN(t) ? NaN : fromDate(new Date(t));
}
const monthKey = mon => `${Math.floor(mon / 12)}-${String((mon % 12) + 1).padStart(2, '0')}`;

const num = v => {
  if (v == null || v === '') return 0;
  if (typeof v === 'number') return Number.isFinite(v) ? v : 0;
  const n = Number(String(v).replace(/[,\s]|LKR|Rs\.?/gi, ''));
  return Number.isFinite(n) ? n : 0;
};

class Dict {
  constructor() { this.map = new Map(); this.list = []; }
  id(value, blank = '(blank)') {
    const key = value == null || value === '' ? blank : String(value).trim() || blank;
    let i = this.map.get(key);
    if (i === undefined) { i = this.list.length; this.list.push(key); this.map.set(key, i); }
    return i;
  }
}

class CategoryBuilder {
  constructor() {
    this.pg = new Dict(); this.mb = new Dict(); this.adv = new Dict(); this.brand = new Dict(); this.sub = new Dict();
    this.cols = { mon: [], pg: [], mb: [], adv: [], brand: [], sub: [], tv: [], radio: [], press: [] };
    this.header = null; this.hasSubCol = false; this.sawSub = false;
    this.rows = 0; this.skipped = 0; this.scanned = 0;
  }

  tryHeader(values) {
    const map = [];
    let hits = 0;
    values.forEach((v, i) => { const k = COLUMN_KEYS[norm(v)]; if (k && !map.includes(k)) { map[i] = k; hits++; } });
    const found = new Set(map.filter(Boolean));
    if (hits < 4 || !found.has('month') || !found.has('mb')) return false;
    const missing = ['month', 'mb', 'adv'].filter(k => !found.has(k));
    if (missing.length) throw new Error('Missing required column(s): ' + missing.map(k => ({ month: 'Month', mb: 'Mother Brand', adv: 'Advertiser' }[k])).join(', '));
    if (!['tv', 'radio', 'press'].some(k => found.has(k))) throw new Error('Missing spend columns: add Tv (000Rs), Radio (000Rs) and/or Press (000Rs).');
    this.header = map;
    this.hasSubCol = found.has('sub');
    return true;
  }

  addRow(values) {
    this.scanned++;
    if (!this.header) {
      if (this.scanned > 20) throw new Error('Could not find the header row. Expected columns such as Month, Product Group, Mother Brand, Advertiser, Brand, Tv (000Rs), Radio (000Rs), Press (000Rs).');
      this.tryHeader(values);
      return;
    }
    const r = {};
    const h = this.header;
    for (let i = 0; i < h.length; i++) if (h[i]) r[h[i]] = values[i];
    const mon = monthIndex(r.month);
    if (!Number.isFinite(mon) || r.mb == null || r.mb === '' || r.adv == null || r.adv === '') { this.skipped++; return; }
    const tv = num(r.tv), radio = num(r.radio), press = num(r.press);
    const c = this.cols;
    if (r.sub != null && String(r.sub).trim() !== '') this.sawSub = true;
    c.mon.push(mon);
    c.pg.push(this.pg.id(r.pg, 'All products'));
    c.mb.push(this.mb.id(r.mb)); c.adv.push(this.adv.id(r.adv));
    c.brand.push(this.brand.id(r.brand)); c.sub.push(this.sub.id(r.sub, '(none)'));
    c.tv.push(tv); c.radio.push(radio); c.press.push(press);
    this.rows++;
  }

  finish(meta) {
    if (!this.header) throw new Error('The file is empty or has no recognisable header row.');
    if (!this.rows) throw new Error('No valid rows found. Check that Month holds a month such as Jan-22 and that Mother Brand and Advertiser are filled.');
    const c = this.cols;
    const cols = {
      mon: Int32Array.from(c.mon), pg: Int32Array.from(c.pg), mb: Int32Array.from(c.mb), adv: Int32Array.from(c.adv),
      brand: Int32Array.from(c.brand), sub: Int32Array.from(c.sub),
      tv: Float64Array.from(c.tv), radio: Float64Array.from(c.radio), press: Float64Array.from(c.press),
    };
    this.cols = null;
    let minMon = Infinity, maxMon = -Infinity;
    for (let i = 0; i < cols.mon.length; i++) { if (cols.mon[i] < minMon) minMon = cols.mon[i]; if (cols.mon[i] > maxMon) maxMon = cols.mon[i]; }
    return {
      meta: { ...meta, kind: 'category', rows: this.rows, skipped: this.skipped, minMon, maxMon, hasSub: this.hasSubCol && this.sawSub },
      dicts: { pg: this.pg.list, mb: this.mb.list, adv: this.adv.list, brand: this.brand.list, sub: this.sub.list },
      cols,
    };
  }
}

module.exports = { CategoryBuilder, monthIndex, monthKey };
