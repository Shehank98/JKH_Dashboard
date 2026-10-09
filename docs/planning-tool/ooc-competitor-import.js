// Competitor data import for the media planning tool, from the Ogilvy Orbit Chub Live Dashboard.
//
// Add this file to the planning tool (for example public/js/competitor-import.js) and call
// initCompetitorImport() once when the app starts. See docs/planning-tool/README.md in the dashboard repo.
//
// How it works: "Send to planning tool" in the dashboard opens this app in a tab (…/#competitors). This file
// tells the dashboard it is ready; the dashboard sends the data with postMessage; this file checks where it
// came from and its format, hands it to onData (save it, then draw the charts) and confirms. Browser to
// browser only: neither server sees the data. importCompetitorFile() reads the same data from a .json file.

export const OOC_FORMAT = 'ogilvy-orbit-chub/competitor-intel';
export const OOC_VERSION = 1;

// The dashboard address(es) allowed to send data. Put your dashboard's Railway URL here (no trailing slash).
export const OOC_ALLOWED_ORIGINS = [
  'https://YOUR-DASHBOARD.up.railway.app',
];

export function validateCompetitorData(p) {
  if (!p || typeof p !== 'object') throw new Error('No data received.');
  if (p.format !== OOC_FORMAT) throw new Error('This is not Ogilvy Orbit Chub competitor data.');
  if (p.version !== OOC_VERSION) throw new Error(`Unsupported data version ${p.version}; this planning tool reads version ${OOC_VERSION}.`);
  for (const k of ['advertisers', 'summary', 'channels', 'programmes', 'breakPositions', 'durations', 'hours', 'weeks']) {
    if (!Array.isArray(p[k])) throw new Error(`The data is missing "${k}".`);
  }
  return p;
}

// onData(payload) may return a promise (for example while saving to IndexedDB).
export function initCompetitorImport({ onData, allowedOrigins = OOC_ALLOWED_ORIGINS } = {}) {
  if (typeof onData !== 'function') throw new Error('initCompetitorImport needs onData');
  window.addEventListener('message', async e => {
    if (!allowedOrigins.includes(e.origin)) return;            // only the dashboard may send
    const m = e.data;
    if (!m || m.type !== 'ooc:competitor-intel') return;
    const reply = msg => e.source && e.source.postMessage({ type: 'ooc:received', ...msg }, e.origin);
    try {
      await onData(validateCompetitorData(m.payload));
      reply({ ok: true });
    } catch (err) {
      reply({ ok: false, error: String((err && err.message) || err) });
    }
  });
  // Opened by the dashboard: say we are ready. This message carries no data, so any origin may read it.
  if (window.opener) window.opener.postMessage({ type: 'ooc:ready', version: OOC_VERSION }, '*');
}

// For a "Load competitor data (.json)" button.
export async function importCompetitorFile(file, onData) {
  let p;
  try { p = JSON.parse(await file.text()); } catch (e) { throw new Error('This file is not valid JSON.'); }
  await onData(validateCompetitorData(p));
  return p;
}
