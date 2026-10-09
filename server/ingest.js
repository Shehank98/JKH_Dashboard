'use strict';
// Streams an .xlsx or .csv spot log into a compact columnar dataset.

const fs = require('fs');
const path = require('path');
const ExcelJS = require('exceljs');
const { parse: csvParse } = require('csv-parse');
const { Builder } = require('./builder');

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
