'use strict';
// Streams an .xlsx or .csv spot log into a compact columnar dataset.

const fs = require('fs');
const path = require('path');
const ExcelJS = require('exceljs');
const { parse: csvParse } = require('csv-parse');
const D = require('./derive');

const COLUMN_KEYS = {
  productgroup: 'pg', advertiser: 'adv', product: 'product', advttheme: 'theme', channel: 'channel',
  program: 'program', dd: 'dd', mn: 'mn', yr: 'yr', day: 'day', progtime: 'progTime', advttime: 'advtTime',
  adpos: 'adPos', totads: 'totAds', brkno: 'brkNo', posinbrk: 'posInBrk', adsinbrk: 'adsInBrk',
  lng: 'lng', dur: 'dur', cost: 'cost',
};
const REQUIRED = ['adv', 'channel', 'dd', 'mn', 'yr', 'cost'];

const norm = s => String(s == null ? '' : s).toLowerCase().replace(/[^a-z0-9]/g, '');

class Dict {
  constructor() { this.map = new Map(); this.list = []; }
  id(value) {
    const key = value == null || value === '' ? '(blank)' : String(value).trim() || '(blank)';
    let i = this.map.get(key);
    if (i === undefined) { i = this.list.length; this.list.push(key); this.map.set(key, i); }
    return i;
  }
}

class Builder {
  constructor() {
    this.pg = new Dict(); this.adv = new Dict(); this.channel = new Dict(); this.theme = new Dict();
    this.cols = { pg: [], adv: [], ch: [], theme: [], day: [], mon: [], dp: [], dur: [], durRaw: [], bq: [], cost: [] };
    this.header = null; // array index -> key
    this.rows = 0; this.skipped = 0; this.scanned = 0;
  }

  // Returns true once a header row has been recognised.
  tryHeader(values) {
    const map = [];
    let hits = 0;
    values.forEach((v, i) => { const k = COLUMN_KEYS[norm(v)]; if (k) { map[i] = k; hits++; } });
    if (hits < 5) return false;
    const found = new Set(map.filter(Boolean));
    const missing = REQUIRED.filter(k => !found.has(k));
    if (missing.length) {
      const names = { adv: 'Advertiser', channel: 'Channel', dd: 'Dd', mn: 'Mn', yr: 'Yr', cost: 'Cost' };
      throw new Error('Missing required column(s): ' + missing.map(k => names[k]).join(', '));
    }
    this.header = map;
    return true;
  }

  addRow(values) {
    this.scanned++;
    if (!this.header) {
      if (this.scanned > 20) throw new Error('Could not find the header row. Expected columns such as Advertiser, Channel, Dd, Mn, Yr, Cost.');
      this.tryHeader(values);
      return;
    }
    const r = {};
    const h = this.header;
    for (let i = 0; i < h.length; i++) if (h[i]) r[h[i]] = values[i];

    const day = D.dayNumber(r.dd, r.mn, r.yr);
    const cost = D.parseNumber(r.cost);
    if (!Number.isFinite(day) || r.adv == null || r.adv === '' || r.channel == null || r.channel === '') {
      this.skipped++;
      return;
    }
    const dt = new Date(day * 86400000);
    const c = this.cols;
    c.pg.push(this.pg.id(r.pg == null ? 'All products' : r.pg));
    c.adv.push(this.adv.id(r.adv));
    c.ch.push(this.channel.id(r.channel));
    c.theme.push(this.theme.id(r.theme));
    c.day.push(day);
    c.mon.push(dt.getUTCFullYear() * 12 + dt.getUTCMonth());
    c.dp.push(D.daypartOf(D.parseTime(r.advtTime)));
    const dur = D.parseNumber(r.dur);
    c.dur.push(D.stdDurIndex(dur));
    c.durRaw.push(Number.isFinite(dur) && dur > 0 ? dur : NaN);
    c.bq.push(D.breakQualityOf(r.posInBrk, r.adsInBrk));
    c.cost.push(Number.isFinite(cost) ? cost : 0);
    this.rows++;
  }

  finish(meta) {
    if (!this.header) throw new Error('The file is empty or has no recognisable header row.');
    if (!this.rows) throw new Error('No valid rows found. Check that Dd, Mn and Yr hold a valid date.');
    const c = this.cols;
    const cols = {
      pg: Int32Array.from(c.pg), adv: Int32Array.from(c.adv), ch: Int32Array.from(c.ch),
      theme: Int32Array.from(c.theme), day: Int32Array.from(c.day), mon: Int32Array.from(c.mon),
      dp: Uint8Array.from(c.dp), dur: Uint8Array.from(c.dur), durRaw: Float32Array.from(c.durRaw), bq: Uint8Array.from(c.bq),
      cost: Float64Array.from(c.cost),
    };
    this.cols = null;
    let minDay = Infinity, maxDay = -Infinity;
    for (let i = 0; i < cols.day.length; i++) {
      const d = cols.day[i];
      if (d < minDay) minDay = d;
      if (d > maxDay) maxDay = d;
    }
    const channels = this.channel.list;
    return {
      meta: { ...meta, rows: this.rows, skipped: this.skipped, minDay, maxDay },
      dicts: {
        pg: this.pg.list, adv: this.adv.list, channel: channels, theme: this.theme.list,
        channelMedium: channels.map(D.mediumOf), channelName: channels.map(D.channelNameOf),
      },
      cols,
    };
  }
}

function cellValue(v) {
  if (v == null) return null;
  if (typeof v !== 'object' || v instanceof Date) return v;
  if (v.richText) return v.richText.map(t => t.text).join('');
  if ('result' in v) return cellValue(v.result);
  if ('text' in v) return v.text;
  if (v.error) return null;
  return null;
}

async function readXlsx(file, builder, onProgress) {
  const reader = new ExcelJS.stream.xlsx.WorkbookReader(file, {
    sharedStrings: 'cache', styles: 'cache', hyperlinks: 'ignore', worksheets: 'emit', entries: 'emit',
  });
  for await (const sheet of reader) {
    for await (const row of sheet) {
      const vals = row.values; // 1-based sparse array
      const out = new Array(vals.length > 0 ? vals.length - 1 : 0);
      for (let i = 1; i < vals.length; i++) out[i - 1] = cellValue(vals[i]);
      builder.addRow(out);
      if ((builder.scanned & 8191) === 0) onProgress(builder.rows);
    }
    break; // first worksheet only
  }
}

function sniffDelimiter(file) {
  const fd = fs.openSync(file, 'r');
  const buf = Buffer.alloc(8192);
  const n = fs.readSync(fd, buf, 0, buf.length, 0);
  fs.closeSync(fd);
  const line = buf.slice(0, n).toString('utf8').split(/\r?\n/)[0] || '';
  const counts = [',', ';', '\t', '|'].map(d => [d, line.split(d).length]);
  counts.sort((a, b) => b[1] - a[1]);
  return counts[0][0];
}

async function readCsv(file, builder, onProgress) {
  const parser = fs.createReadStream(file).pipe(csvParse({
    delimiter: sniffDelimiter(file), bom: true, relax_column_count: true, relax_quotes: true,
    skip_empty_lines: true, trim: true,
  }));
  for await (const rec of parser) {
    builder.addRow(rec);
    if ((builder.scanned & 8191) === 0) onProgress(builder.rows);
  }
}

async function ingestFile(file, originalName, onProgress = () => {}) {
  const ext = path.extname(originalName || file).toLowerCase();
  const builder = new Builder();
  const started = Date.now();
  if (ext === '.xlsx' || ext === '.xlsm') await readXlsx(file, builder, onProgress);
  else if (ext === '.csv' || ext === '.txt' || ext === '.tsv') await readCsv(file, builder, onProgress);
  else throw new Error('Unsupported file type. Please upload .xlsx or .csv');
  onProgress(builder.rows);
  return builder.finish({
    fileName: originalName, uploadedAt: new Date().toISOString(), parseMs: Date.now() - started,
  });
}

module.exports = { ingestFile };
