'use strict';
const fs = require('fs');
const path = require('path');
const express = require('express');
const compression = require('compression');
const { createAuth } = require('./server/auth');

const PORT = process.env.PORT || 3000;
const DATA_DIR = path.resolve(process.env.DATA_DIR || path.join(__dirname, 'data'));
fs.mkdirSync(DATA_DIR, { recursive: true });

// Spot-log files are read and analysed in each person's browser (public/engine/worker.js), so people never
// see or overwrite each other's data and the server holds no datasets. The server handles sign-in and
// serves the app, including the shared calculation code the browser runs.
const ENGINE_LIB = ['derive', 'builder', 'compute', 'planning', 'browser-readers'];

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

  // The shared modules the browser's data engine runs (same code the test scripts verify in Node).
  app.get('/engine/lib/:name.js', (req, res) => {
    if (!ENGINE_LIB.includes(req.params.name)) return res.status(404).end();
    res.setHeader('Cache-Control', 'no-cache');
    res.type('application/javascript').sendFile(path.join(__dirname, 'server', req.params.name + '.js'));
  });

  // Signed-in check for the page (data lives in the browser, not here).
  app.get('/api/status', (req, res) => res.json({ ok: true, data: 'browser' }));

  app.listen(PORT, () => console.log(`Dashboard running on http://localhost:${PORT} (data files are processed in each browser)`));
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
