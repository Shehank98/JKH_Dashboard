'use strict';
// Hands a Competitor Brief from the dashboard to the TV Media Planning Tool.
// The bearer token lives here, on the server, because anything in browser code can be read by the person using it.
// The brief is passed straight through: it is not logged and not stored.
//
//   PLANNER_URL        where people open the planner (the plan page is PLANNER_URL/plan/new?briefId=...)
//   PLANNER_API_URL    where the planner's API is (defaults to PLANNER_URL); briefs are POSTed to PLANNER_API_URL/api/competitor-briefs
//   PLANNER_API_TOKEN  bearer token the planner expects

const { MAX_BYTES, SCHEMA_VERSION } = require('./plannerBrief');

const DEFAULT_PLANNER_URL = 'https://media-planing-v2-copy-production.up.railway.app';
const trim = s => String(s || '').replace(/\/+$/, '');

function configFrom(env = process.env) {
  const plannerUrl = trim(env.PLANNER_URL || env.PLANNING_TOOL_URL || DEFAULT_PLANNER_URL);
  return { plannerUrl, apiUrl: trim(env.PLANNER_API_URL || plannerUrl), token: env.PLANNER_API_TOKEN || '' };
}

// What the page may know: where the planner is and whether sending is set up. Never the token.
const publicConfig = cfg => ({ plannerUrl: cfg.plannerUrl, plannerConfigured: !!cfg.token });

function router(express, cfg = configFrom(), fetchImpl = globalThis.fetch) {
  const r = express.Router();
  r.post('/briefs', async (req, res) => {
    const fail = (status, error, code) => res.status(status).json({ error, code });
    if (!cfg.token) return fail(503, 'Sending to the planner is not set up. Ask an admin to set PLANNER_API_URL and PLANNER_API_TOKEN, or use Download JSON.', 'not_configured');
    const b = req.body;
    if (!b || typeof b !== 'object' || b.schemaVersion !== SCHEMA_VERSION || !Array.isArray(b.advertisers) || !Array.isArray(b.facts)) return fail(400, 'This is not a Competitor Brief (schema ' + SCHEMA_VERSION + ').', 'bad_brief');
    const text = JSON.stringify(b);
    if (Buffer.byteLength(text) > MAX_BYTES) return fail(413, 'The brief is larger than 200 KB. Choose fewer competitors or a shorter period.', 'too_large');
    let up;
    try {
      up = await fetchImpl(cfg.apiUrl + '/api/competitor-briefs', {
        method: 'POST', body: text, signal: AbortSignal.timeout(20000),
        headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + cfg.token, Accept: 'application/json' },
      });
    } catch (e) {
      return fail(502, 'The planner could not be reached. Try again, or use Download JSON.', 'unreachable');
    }
    if (up.status === 401 || up.status === 403) return fail(502, 'The planner did not accept the dashboard\'s token (PLANNER_API_TOKEN). Ask an admin to check it.', 'rejected');
    if (!up.ok) return fail(502, `The planner answered with an error (${up.status}). Try again, or use Download JSON.`, 'planner_error');
    let j = null;
    try { j = await up.json(); } catch (e) { /* handled below */ }
    const id = j && (j.briefId != null ? String(j.briefId) : '');
    if (!id || !/^[\w.-]{1,128}$/.test(id)) return fail(502, 'The planner did not return a brief id.', 'bad_response');
    res.json({ briefId: id, planUrl: `${cfg.plannerUrl}/plan/new?briefId=${encodeURIComponent(id)}` });
  });
  return r;
}

module.exports = { router, configFrom, publicConfig };
