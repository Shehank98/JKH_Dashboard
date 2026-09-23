'use strict';
const fs = require('fs');
const path = require('path');
const express = require('express');
const compression = require('compression');
const multer = require('multer');
const { ingestFile } = require('./server/ingest');
const store = require('./server/store');
const compute = require('./server/compute');

const PORT = process.env.PORT || 3000;
const DATA_DIR = path.resolve(process.env.DATA_DIR || path.join(__dirname, 'data'));
const MAX_UPLOAD_MB = Number(process.env.MAX_UPLOAD_MB || 100);
const UPLOAD_DIR = path.join(DATA_DIR, 'uploads');
fs.mkdirSync(UPLOAD_DIR, { recursive: true });

let dataset = null;
let job = { state: 'idle' }; // idle | processing | error

try {
  dataset = store.load(DATA_DIR);
  if (dataset) console.log(`Loaded saved dataset: ${dataset.meta.fileName}, ${dataset.meta.rows} rows`);
} catch (e) {
  console.error('Could not load saved dataset:', e.message);
}

const app = express();
app.use(compression());
app.use(express.json({ limit: '1mb' }));
// Page, script and styles are revalidated on every load (cheap 304 via ETag), so a redeploy is picked up immediately.
app.use(express.static(path.join(__dirname, 'public'), {
  setHeaders: (res, file) => {
    if (/\.(html|js|css)$/.test(file)) res.setHeader('Cache-Control', 'no-cache');
    else res.setHeader('Cache-Control', 'public, max-age=3600');
  },
}));
// Self-hosted font and export libraries (JPG/PDF), served from node_modules.
const vendor = (route, dir) => app.use(route, express.static(path.join(__dirname, 'node_modules', dir), { maxAge: '7d' }));
vendor('/vendor/inter', '@fontsource/inter');
vendor('/vendor/html-to-image', 'html-to-image/dist');
vendor('/vendor/jspdf', 'jspdf/dist');
vendor('/vendor/jszip', 'jszip/dist');

const upload = multer({
  dest: UPLOAD_DIR,
  limits: { fileSize: MAX_UPLOAD_MB * 1024 * 1024, files: 1 },
  fileFilter: (req, file, cb) => {
    const ok = /\.(xlsx|xlsm|csv|tsv|txt)$/i.test(file.originalname);
    cb(ok ? null : new Error('Only .xlsx and .csv files are supported'), ok);
  },
});

const isoDay = day => new Date(day * 86400000).toISOString().slice(0, 10);

function status() {
  return {
    job,
    dataset: dataset ? { ...dataset.meta, minDate: isoDay(dataset.meta.minDay), maxDate: isoDay(dataset.meta.maxDay) } : null,
  };
}

app.get('/api/status', (req, res) => res.json(status()));

app.post('/api/upload', (req, res) => {
  if (job.state === 'processing') return res.status(409).json({ error: 'Another file is still being processed. Please wait.' });
  upload.single('file')(req, res, err => {
    if (err) {
      const msg = err.code === 'LIMIT_FILE_SIZE' ? `File is larger than ${MAX_UPLOAD_MB} MB` : err.message;
      return res.status(400).json({ error: msg });
    }
    if (!req.file) return res.status(400).json({ error: 'No file received' });
    const { path: tmpPath, originalname, size } = req.file;
    job = { state: 'processing', fileName: originalname, size, rows: 0, startedAt: new Date().toISOString() };
    res.status(202).json(status());

    ingestFile(tmpPath, originalname, rows => { job.rows = rows; })
      .then(ds => {
        ds.meta.size = size;
        store.save(DATA_DIR, ds);
        dataset = ds;
        job = { state: 'idle', lastFile: originalname };
        console.log(`Processed ${originalname}: ${ds.meta.rows} rows in ${ds.meta.parseMs} ms`);
      })
      .catch(e => {
        console.error('Upload failed:', e);
        job = { state: 'error', fileName: originalname, error: e.message };
      })
      .finally(() => fs.rm(tmpPath, { force: true }, () => {}));
  });
});

app.delete('/api/data', (req, res) => {
  if (job.state === 'processing') return res.status(409).json({ error: 'A file is still being processed' });
  store.remove(DATA_DIR);
  dataset = null;
  job = { state: 'idle' };
  res.json(status());
});

const needData = (req, res, next) => (dataset ? next() : res.status(404).json({ error: 'No dataset uploaded yet' }));

app.get('/api/overview', needData, (req, res) => res.json(compute.overview(dataset)));

app.get('/api/options', needData, (req, res) => res.json(compute.groupOptions(dataset, String(req.query.pg || ''))));

app.post('/api/dashboard', needData, (req, res) => {
  try {
    const t = Date.now();
    const out = compute.dashboard(dataset, req.body || {});
    out.computeMs = Date.now() - t;
    res.json(out);
  } catch (e) {
    res.status(400).json({ error: e.message });
  }
});

app.post('/api/detail', needData, (req, res) => {
  try {
    const { filters, scope } = req.body || {};
    res.json(compute.detail(dataset, filters || {}, scope || {}));
  } catch (e) {
    res.status(400).json({ error: e.message });
  }
});

app.listen(PORT, () => console.log(`Dashboard running on http://localhost:${PORT} (data dir ${DATA_DIR})`));
