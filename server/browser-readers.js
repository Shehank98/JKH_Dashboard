'use strict';
// Reads an .xlsx or .csv spot log in the browser (inside the dashboard's Web Worker) and feeds the rows
// to the shared Builder. Both readers stream, so a 50 MB file never has to sit in memory as one big string.
// Uses only web platform features (Blob.stream, TextDecoder) plus JSZip, so it also runs in Node for tests.

const JSZip = require('jszip');
const { Builder } = require('./builder');

const yieldNow = () => new Promise(r => setTimeout(r, 0));

// ---------- CSV ----------
// Quoted fields with "" escapes, any of , ; tab | as delimiter (sniffed from the header line), BOM,
// blank lines skipped, values trimmed, a stray quote inside an unquoted value kept as text.
async function readCsv(file, builder, onProgress) {
  const reader = file.stream().getReader();
  const dec = new TextDecoder('utf-8');
  let delim = null, field = '', row = [], inQ = false, quotePending = false, quoted = false, first = true;
  let bytes = 0, lastReport = Date.now();
  const endField = () => { row.push(quoted ? field : field.trim()); field = ''; quoted = false; };
  const endRow = () => {
    endField();
    if (!(row.length === 1 && row[0] === '')) builder.addRow(row);
    row = [];
  };
  const sniff = text => {
    const line = text.slice(0, text.search(/\r?\n|$/));
    const counts = [',', ';', '\t', '|'].map(d => [d, line.split(d).length]);
    counts.sort((a, b) => b[1] - a[1]);
    return counts[0][0];
  };
  for (;;) {
    const { value, done } = await reader.read();
    let text = done ? dec.decode() : dec.decode(value, { stream: true });
    if (value) bytes += value.byteLength;
    if (first && text) {
      if (text.charCodeAt(0) === 0xFEFF) text = text.slice(1);
      delim = sniff(text);
      first = false;
    }
    for (let i = 0, n = text.length; i < n; i++) {
      const ch = text[i];
      if (inQ) {
        if (quotePending) {
          quotePending = false;
          if (ch === '"') { field += '"'; continue; } // "" inside quotes
          inQ = false; // the quote closed the field; fall through to handle ch normally
        } else if (ch === '"') { quotePending = true; continue; } else { field += ch; continue; }
      }
      if (ch === delim) endField();
      else if (ch === '\n') endRow();
      else if (ch === '\r') { /* CRLF */ }
      else if (ch === '"' && field.trim() === '' && !quoted) { inQ = true; quoted = true; field = ''; }
      else field += ch;
    }
    if (done) break;
    if (Date.now() - lastReport > 200) { lastReport = Date.now(); onProgress(bytes / file.size, builder.rows); await yieldNow(); }
  }
  if (quotePending) { quotePending = false; inQ = false; }
  if (field !== '' || row.length) endRow();
}

// ---------- XLSX ----------
const ENT = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'" };
const unescapeXml = s => (s.indexOf('&') < 0 ? s : s.replace(/&(#x[0-9a-fA-F]+|#\d+|amp|lt|gt|quot|apos);/g, (m, e) =>
  e[0] === '#' ? String.fromCodePoint(e[1] === 'x' ? parseInt(e.slice(2), 16) : parseInt(e.slice(1), 10)) : ENT[e]));
// All <t> text inside a shared string or inline string, leaving out phonetic runs (<rPh>).
const textOf = xml => {
  const clean = xml.indexOf('<rPh') < 0 ? xml : xml.replace(/<rPh\b[\s\S]*?<\/rPh>/g, '');
  let out = '';
  const re = /<t\b[^>]*?(?:\/>|>([\s\S]*?)<\/t>)/g;
  let m;
  while ((m = re.exec(clean))) if (m[1]) out += m[1];
  return unescapeXml(out);
};
const colIndex = ref => {
  let n = 0;
  for (let i = 0; i < ref.length; i++) {
    const c = ref.charCodeAt(i);
    if (c < 65 || c > 90) break;
    n = n * 26 + (c - 64);
  }
  return n - 1;
};

// Streams one zip entry as text and calls onElement(xml) for every complete <tag>...</tag> (or <tag/>).
function streamElements(entry, tag, onElement, onPercent) {
  return new Promise((resolve, reject) => {
    const dec = new TextDecoder('utf-8');
    const open = '<' + tag, close = '</' + tag + '>';
    let buf = '';
    const scan = () => {
      let pos = 0;
      for (;;) {
        let s = buf.indexOf(open, pos);
        // Make sure it is the tag itself, not a longer name such as <rowBreaks>.
        while (s >= 0) {
          const c = buf[s + open.length];
          if (c === undefined) break;
          if (c === ' ' || c === '>' || c === '/' || c === '\t' || c === '\n' || c === '\r') break;
          s = buf.indexOf(open, s + 1);
        }
        if (s < 0) { pos = Math.max(pos, buf.length - open.length); break; }
        const gt = buf.indexOf('>', s);
        if (gt < 0) { pos = s; break; }
        if (buf[gt - 1] === '/') { onElement(buf.slice(s, gt + 1)); pos = gt + 1; continue; }
        const e = buf.indexOf(close, gt);
        if (e < 0) { pos = s; break; }
        onElement(buf.slice(s, e + close.length));
        pos = e + close.length;
      }
      buf = buf.slice(pos);
    };
    let failed = false;
    entry.internalStream('uint8array')
      .on('data', (chunk, meta) => {
        if (failed) return;
        try { buf += dec.decode(chunk, { stream: true }); scan(); if (onPercent) onPercent(meta.percent / 100); }
        catch (err) { failed = true; reject(err); }
      })
      .on('error', reject)
      .on('end', () => { if (failed) return; try { buf += dec.decode(); scan(); resolve(); } catch (err) { reject(err); } })
      .resume();
  });
}

async function firstSheetPath(zip) {
  const wb = zip.file('xl/workbook.xml');
  const relsFile = zip.file('xl/_rels/workbook.xml.rels');
  if (wb && relsFile) {
    const [wbXml, relsXml] = await Promise.all([wb.async('string'), relsFile.async('string')]);
    const sheet = /<sheet\b[^>]*\br:id="([^"]+)"/.exec(wbXml) || /<sheet\b[^>]*\bid="([^"]+)"/.exec(wbXml);
    if (sheet) {
      const rel = new RegExp(`<Relationship\\b[^>]*\\bId="${sheet[1]}"[^>]*>`).exec(relsXml);
      const target = rel && /\bTarget="([^"]+)"/.exec(rel[0]);
      if (target) {
        const t = target[1].replace(/^\//, '');
        const p = t.startsWith('xl/') ? t : 'xl/' + t;
        if (zip.file(p)) return p;
      }
    }
  }
  const sheets = Object.keys(zip.files).filter(n => /^xl\/worksheets\/sheet\d+\.xml$/.test(n))
    .sort((a, b) => Number(a.match(/\d+/)[0]) - Number(b.match(/\d+/)[0]));
  if (!sheets.length) throw new Error('This .xlsx file has no worksheet.');
  return sheets[0];
}

async function readXlsx(file, builder, onProgress) {
  let zip;
  try { zip = await JSZip.loadAsync(await file.arrayBuffer()); }
  catch (e) { throw new Error('This does not look like a valid .xlsx file.'); }
  onProgress(0.03, 0);
  const sst = [];
  const sstFile = zip.file('xl/sharedStrings.xml');
  if (sstFile) await streamElements(sstFile, 'si', xml => sst.push(textOf(xml)), p => onProgress(0.03 + p * 0.07, 0));
  const sheet = zip.file(await firstSheetPath(zip));
  const cellRe = /<c\b([^>]*?)(?:\/>|>([\s\S]*?)<\/c>)/g;
  const vRe = /<v>([\s\S]*?)<\/v>/;
  let lastYield = Date.now();
  let pct = 0.1;
  await streamElements(sheet, 'row', xml => {
    const out = [];
    let next = 0, m;
    cellRe.lastIndex = 0;
    while ((m = cellRe.exec(xml))) {
      const attrs = m[1], inner = m[2] || '';
      const r = /\br="([A-Z]+)\d*"/.exec(attrs);
      const col = r ? colIndex(r[1]) : next;
      next = col + 1;
      const t = (/\bt="([^"]+)"/.exec(attrs) || [])[1];
      let val = null;
      if (t === 'inlineStr') val = textOf(inner);
      else {
        const v = vRe.exec(inner);
        if (v) {
          const raw = v[1];
          if (t === 's') val = sst[Number(raw)];
          else if (t === 'str') val = unescapeXml(raw);
          else if (t === 'b') val = raw === '1';
          else if (t === 'e') val = null;
          else { const n = Number(raw); val = raw !== '' && Number.isFinite(n) ? n : unescapeXml(raw); }
        }
      }
      out[col] = val;
    }
    for (let i = 0; i < out.length; i++) if (out[i] === undefined) out[i] = null;
    builder.addRow(out);
  }, p => {
    pct = 0.1 + p * 0.9;
    if (Date.now() - lastYield > 200) { lastYield = Date.now(); onProgress(pct, builder.rows); }
  });
}

// Reads a File (or Blob with a name) and returns the dataset. onProgress(fraction 0..1, rowsSoFar).
async function readSpotFile(file, onProgress = () => {}) {
  const name = file.name || '';
  const ext = (name.match(/\.[^.]+$/) || [''])[0].toLowerCase();
  const builder = new Builder();
  const started = Date.now();
  if (ext === '.xlsx' || ext === '.xlsm') await readXlsx(file, builder, onProgress);
  else if (ext === '.csv' || ext === '.txt' || ext === '.tsv') await readCsv(file, builder, onProgress);
  else throw new Error('Unsupported file type. Please choose an .xlsx or .csv file.');
  onProgress(1, builder.rows);
  return builder.finish({ fileName: name, size: file.size, uploadedAt: new Date().toISOString(), parseMs: Date.now() - started });
}

module.exports = { readSpotFile };
