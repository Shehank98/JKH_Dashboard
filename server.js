'use strict';
const fs = require('fs');
const path = require('path');
const express = require('express');
const compression = require('compression');
const { createAuth } = require('./server/auth');
const { createBrandMap } = require('./server/brandmap');
const { createShares } = require('./server/shares');

const PORT = process.env.PORT || 3000;
const DATA_DIR = path.resolve(process.env.DATA_DIR || path.join(__dirname, 'data'));
fs.mkdirSync(DATA_DIR, { recursive: true });

// Spot-log files are read and analysed in each person's browser (public/engine/worker.js), so people never
// see or overwrite each other's data and the server holds no datasets. The server handles sign-in and
// serves the app, including the shared calculation code the browser runs.
const ENGINE_LIB = ['derive', 'brand-derive', 'cube', 'builder', 'compute', 'planning', 'competitor', 'periods', 'category-builder', 'category', 'category-brand', 'browser-readers', 'plannerBrief'];
// Where "Send to planning tool" opens. The planning tool must list this dashboard's address as allowed.
// Send to Planner: the Competitor Brief goes to PLANNER_API_URL/api/competitor-briefs with the bearer token below, sent by
// this server so the token never reaches the browser. PLANNER_URL is where the planner's pages are (the tab opened afterwards).
const PLANNER_API_URL = (process.env.PLANNER_API_URL || '').replace(/\/+$/, '');
const PLANNER_API_TOKEN = process.env.PLANNER_API_TOKEN || '';
const PLANNER_URL = (process.env.PLANNER_URL || PLANNER_API_URL).replace(/\/+$/, '');
const PLANNING_TOOL_URL = (process.env.PLANNING_TOOL_URL || 'https://media-planing-v2-copy-production.up.railway.app').replace(/\/+$/, '');

// Sign-in is on unless AUTH_DISABLED=1 (local development and automated tests only).
const AUTH_DISABLED = process.env.AUTH_DISABLED === '1';
// Routes are set up once the sign-in store has loaded (Postgres when DATABASE_URL is set).
function start(auth, brandmap, shares) {
  const app = express();
  app.set('trust proxy', 1); // Railway terminates HTTPS in front of the app; needed for secure cookies
  app.use(compression());
  const json = express.json({ limit: '8mb' });
  app.use((req, res, next) => (req.path.startsWith('/api/shared-dashboards') ? next() : json(req, res, next)));
  const PUBLIC_DIR = path.join(__dirname, 'public');
  app.get('/healthz', (req, res) => res.json({ ok: true, accounts: auth ? auth.storage : 'off' })); // Railway health check, open without sign-in
  const sendPage = name => (req, res) => { res.setHeader('Cache-Control', 'no-cache'); res.sendFile(path.join(PUBLIC_DIR, name)); };
  // Shared client dashboards: the link itself is the credential (the agency routes check sign-in inside).
  app.use('/api/shared-dashboards', shares.router(express, auth));
  app.get('/share/:token', sendPage('index.html'));
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
    // plannerBrief lives in public/ so it can be loaded and tested on its own.
    res.type('application/javascript').sendFile(path.join(req.params.name === 'plannerBrief' ? PUBLIC_DIR : path.join(__dirname, 'server'), req.params.name + '.js'));
  });

  app.use('/api/brandmap', brandmap.router(express));
  app.use('/api/ai', require('./server/ai').router(express));

  // Signed-in check for the page (data lives in the browser, not here).
  app.get('/api/status', (req, res) => res.json({ ok: true, data: 'browser' }));
  app.get('/api/config', (req, res) => res.json({ planningToolUrl: PLANNING_TOOL_URL, plannerUrl: PLANNER_URL, plannerConfigured: !!(PLANNER_API_URL && PLANNER_API_TOKEN) }));

  // Send to Planner. The brief is passed straight through (nothing is stored here); the planner answers { briefId, url }.
  app.post('/api/planner/briefs', async (req, res) => {
    const brief = req.body;
    if (!PLANNER_API_URL || !PLANNER_API_TOKEN) return res.status(503).json({ error: 'The planner is not set up. Set PLANNER_API_URL and PLANNER_API_TOKEN on this service, or download the JSON.' });
    if (!brief || brief.schemaVersion !== '1.0' || !Array.isArray(brief.advertisers)) return res.status(400).json({ error: 'This is not a Competitor Brief (schemaVersion 1.0).' });
    const body = JSON.stringify(brief);
    if (Buffer.byteLength(body) > 200 * 1024) return res.status(413).json({ error: 'The brief is larger than 200 KB. Choose fewer competitors or a shorter period.' });
    try {
      const r = await fetch(PLANNER_API_URL + '/api/competitor-briefs', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + PLANNER_API_TOKEN },
        body,
        signal: AbortSignal.timeout(20000),
      });
      const j = await r.json().catch(() => ({}));
      if (!r.ok || !j.briefId) return res.status(r.ok ? 502 : r.status === 401 || r.status === 403 ? 502 : r.status).json({ error: j.error || (r.status === 401 || r.status === 403 ? 'The planner refused the token (PLANNER_API_TOKEN).' : `The planner answered ${r.status}.`) });
      res.json({ briefId: String(j.briefId), url: typeof j.url === 'string' ? j.url : null });
    } catch (e) {
      res.status(502).json({ error: 'The planner could not be reached (' + (e.name === 'TimeoutError' ? 'timed out' : e.message) + ').' });
    }
  });

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
  let brandmap;
  try {
    brandmap = await createBrandMap(DATA_DIR);
    console.log(`Brand Map: ${brandmap.size()} brands in ${brandmap.storage}`);
  } catch (e) {
    console.error('Could not open the Brand Map store:', e.message);
    process.exit(1);
  }
  let shares;
  try {
    shares = await createShares(DATA_DIR);
    console.log(`Shared dashboards are stored in ${shares.storage}`);
  } catch (e) {
    console.error('Could not open the shared dashboards store:', e.message);
    process.exit(1);
  }
  start(auth, brandmap, shares);
})();
