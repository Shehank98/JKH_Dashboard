'use strict';
// Turns spot-log rows (arrays of cell values, header row first) into the compact columnar dataset.
// Shared by the Node reader (server/ingest.js, used by the test scripts) and the browser readers
// (server/browser-readers.js, run in the dashboard's Web Worker), so both apply exactly the same rules.

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
    this.program = new Dict(); this.adPos = new Dict();
    // prog/adPos: programme and which break of it (Start / Mid / End); brk: break number; pos/ads: slot in the
    // break and ads in that break (0 = not given); hour: hour the ad aired (255 = no time, e.g. Press).
    this.cols = { pg: [], adv: [], ch: [], theme: [], day: [], mon: [], dp: [], dur: [], durRaw: [], bq: [], cost: [],
      prog: [], adPos: [], brk: [], pos: [], ads: [], hour: [] };
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
    const minutes = D.parseTime(r.advtTime);
    c.dp.push(D.daypartOf(minutes));
    c.hour.push(minutes == null || Number.isNaN(minutes) ? 255 : Math.floor(minutes / 60) % 24);
    c.prog.push(this.program.id(r.program));
    c.adPos.push(this.adPos.id(r.adPos));
    const small = v => { const n = D.parseNumber(v); return Number.isFinite(n) && n > 0 ? Math.min(255, Math.round(n)) : 0; };
    c.brk.push(small(r.brkNo)); c.pos.push(small(r.posInBrk)); c.ads.push(small(r.adsInBrk));
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
      prog: Int32Array.from(c.prog), adPos: Int32Array.from(c.adPos),
      brk: Uint8Array.from(c.brk), pos: Uint8Array.from(c.pos), ads: Uint8Array.from(c.ads), hour: Uint8Array.from(c.hour),
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
        program: this.program.list, adPos: this.adPos.list,
        channelMedium: channels.map(D.mediumOf), channelName: channels.map(D.channelNameOf),
      },
      cols,
    };
  }
}

module.exports = { Builder, COLUMN_KEYS };
