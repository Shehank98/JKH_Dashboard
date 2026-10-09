'use strict';
const fs = require('fs');
const path = require('path');
const express = require('express');
const compression = require('compression');
const multer = require('multer');
const { ingestFile } = require('./server/ingest');
const store = require('./server/store');
const compute = require('./server/compute');
const { planning } = require('./server/planning');
const { createAuth } = require('./server/auth');

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

// Sign-in is on unless AUTH_DISABLED=1 (local development and automated tests only).
const AUTH_DISABLED = process.env.AUTH_DISABLED === '1';
// Routes are set up once the sign-in store has loaded (Postgres when DATABASE_URL is set).
function start(auth) {
  const app = express();
  app.set('trust proxy', 1); // Railway terminates HTTPS in front of the app; needed for secure cookies
  app.use(compression());
  app.use(express.json({ limit: '1mb' }));
  const PUBLIC_DIR = path.join(__dirname, 'public');
  app.get('/healthz', (req, res) => res.json({ ok: true, accounts: auth ? auth.storage : 'off' })); // Railway health check, open without sign-in
  const sendPage = name => (req, res) => { res.setHeader('Cache-Control', 'no-cache'); res.sendFile(path.join(PUBLIC_DIR, name)); };
  if (auth) {
    app.use('/api/auth', auth.router(express));
    app.use('/api/admin', auth.adminRouter(express));
    app.get('/admin/login', (req, res, next) => (auth.adminOf(req) ? res.redirect('/admin') : next()), sendPage('admin-login.html'));
    app.get(['/admin', '/admin.html'], auth.requireAdminPage, sendPage('admin.html'));
    app.get('/admin-login.html', (req, res) => res.redirect('/admin/login'));
    app.get('/login', (req, res, next) => (auth.userOf(req) ? res.redirect('/') : next()), sendPage('login.html'));
    app.get(['/', '/index.html'], auth.requirePage, sendPage('index.html'));
    app.use('/api', auth.requireApi);
  } else {
    app.get('/api/auth/me', (req, res) => res.json({ user: null, authDisabled: true }));
    app.get('/login', (req, res) => res.redirect('/'));
  }
  // Page, script and styles are revalidated on every load (cheap 304 via ETag), so a redeploy is picked up immediately.
  app.use(express.static(PUBLIC_DIR, {
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
  vendor('/vendor/pptxgenjs', 'pptxgenjs/dist');

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

  // Planning export: every competitor number behind the current filters, as one Markdown file.
  app.post('/api/planning', needData, (req, res) => {
    try {
      const f = req.body || {};
      const md = planning(dataset, f, { user: req.user ? `${req.user.name} (${req.user.email})` : '' });
      const name = `Ogilvy_Orbit_Chub_Planning_${String(f.pg).replace(/[^\w]+/g, '-')}_${f.from}_to_${f.to}.md`;
      res.setHeader('Content-Type', 'text/markdown; charset=utf-8');
      res.setHeader('Content-Disposition', `attachment; filename="${name}"`);
      res.send(md);
    } catch (e) {
      res.status(400).json({ error: e.message });
    }
  });

  app.listen(PORT, () => console.log(`Dashboard running on http://localhost:${PORT} (data dir ${DATA_DIR})`));
}

(async function main() {
  let auth = null;
  if (AUTH_DISABLED) console.warn('WARNING: AUTH_DISABLED=1, the dashboard is open to anyone who can reach it.');
  else {
    try {
      auth = await createAuth(DATA_DIR);
    } catch (e) {
      // Better to stop (Railway restarts the service) than to run with no accounts.
      console.error('Could not open the sign-in database:', e.message);
      process.exit(1);
    }
    console.log(`Sign-in accounts are stored in ${auth.storageLabel}`);
    if (auth.storage === 'file') console.warn('DATABASE_URL is not set: accounts live in a file and are lost on redeploy unless DATA_DIR is on a volume.');
    if (!auth.mailConfigured) console.warn('APPS_SCRIPT_URL is not set: sign-in codes are printed to this log instead of emailed.');
    if (!auth.envAdmins.length) console.warn('ADMIN_EMAILS is not set: nobody can open the admin panel until it is.');
    // Railway sends SIGTERM before replacing the container: finish any pending database write first.
    for (const sig of ['SIGTERM', 'SIGINT']) {
      process.once(sig, async () => {
        try { await auth.flush(); await auth.close(); } catch (e) { console.error('Shutdown save failed:', e.message); }
        process.exit(0);
      });
    }
  }
  start(auth);
})();
