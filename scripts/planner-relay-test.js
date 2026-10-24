'use strict';
// "Send to Planner" relay: the token stays on the server, the brief is passed through, and every failure has a clear answer.
// A stand-in planner (a small HTTP server) plays the other end. Run: npm run test:relay
const assert = require('assert');
const http = require('http');
const express = require('express');
const relay = require('../server/planner-relay');

const brief = { schemaVersion: '1.0', advertisers: [{ name: 'Me' }], facts: [{ id: 'F01', text: 'x.' }] };
const listen = app => new Promise(r => { const s = http.createServer(app).listen(0, '127.0.0.1', () => r(s)); });
const post = (port, body) => fetch(`http://127.0.0.1:${port}/api/planner/briefs`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: typeof body === 'string' ? body : JSON.stringify(body) })
  .then(async r => ({ status: r.status, json: await r.json() }));

(async () => {
  // the stand-in planner
  const seen = [];
  let mode = 'ok';
  const planner = express();
  planner.use(express.json({ limit: '1mb' }));
  planner.post('/api/competitor-briefs', (req, res) => {
    seen.push({ auth: req.headers.authorization, body: req.body });
    if (mode === 'deny') return res.status(401).json({ error: 'no' });
    if (mode === 'boom') return res.status(500).json({ error: 'oops' });
    if (mode === 'noid') return res.json({});
    res.json({ briefId: 'b_123', url: 'https://evil.example/steal' });
  });
  const ps = await listen(planner);
  const planUrl = `http://127.0.0.1:${ps.address().port}`;

  const mount = cfg => { const a = express(); a.use(express.json({ limit: '8mb' })); a.use('/api/planner', relay.router(express, cfg)); return listen(a); };

  // configured: forwards the brief with the bearer token and builds the plan address itself
  let s = await mount(relay.configFrom({ PLANNER_URL: planUrl + '/', PLANNER_API_URL: planUrl, PLANNER_API_TOKEN: 'secret-token' }));
  let r = await post(s.address().port, brief);
  assert.strictEqual(r.status, 200);
  assert.deepStrictEqual(r.json, { briefId: 'b_123', planUrl: `${planUrl}/plan/new?briefId=b_123` }, 'the page opens PLANNER_URL, never an address the planner sends back');
  assert.strictEqual(seen[0].auth, 'Bearer secret-token'); assert.deepStrictEqual(seen[0].body, brief);
  assert.ok(!JSON.stringify(r.json).includes('secret-token'));

  // bad input
  r = await post(s.address().port, { schemaVersion: '2.0' }); assert.strictEqual(r.status, 400); assert.strictEqual(r.json.code, 'bad_brief');
  r = await post(s.address().port, { ...brief, filler: 'x'.repeat(210 * 1024) }); assert.strictEqual(r.status, 413); assert.strictEqual(r.json.code, 'too_large');
  assert.strictEqual(seen.length, 1, 'nothing bad reaches the planner');

  // the planner says no / fails / answers oddly
  mode = 'deny'; r = await post(s.address().port, brief); assert.strictEqual(r.status, 502); assert.strictEqual(r.json.code, 'rejected');
  mode = 'boom'; r = await post(s.address().port, brief); assert.strictEqual(r.status, 502); assert.strictEqual(r.json.code, 'planner_error');
  mode = 'noid'; r = await post(s.address().port, brief); assert.strictEqual(r.status, 502); assert.strictEqual(r.json.code, 'bad_response');
  s.close();

  // planner unreachable
  s = await mount(relay.configFrom({ PLANNER_API_URL: 'http://127.0.0.1:9', PLANNER_API_TOKEN: 't' }));
  r = await post(s.address().port, brief); assert.strictEqual(r.status, 502); assert.strictEqual(r.json.code, 'unreachable');
  s.close();

  // no token: sending is off, and the page can tell
  const none = relay.configFrom({});
  assert.deepStrictEqual(relay.publicConfig(none), { plannerUrl: none.plannerUrl, plannerConfigured: false });
  s = await mount(none);
  r = await post(s.address().port, brief); assert.strictEqual(r.status, 503); assert.strictEqual(r.json.code, 'not_configured');
  s.close();
  assert.strictEqual(relay.configFrom({ PLANNING_TOOL_URL: 'https://old.example/' }).plannerUrl, 'https://old.example', 'the old variable still sets the planner address');
  assert.strictEqual(relay.configFrom({ PLANNER_URL: 'https://a.example', PLANNER_API_TOKEN: 't' }).apiUrl, 'https://a.example', 'API address defaults to the planner address');
  assert.deepStrictEqual(relay.publicConfig(relay.configFrom({ PLANNER_API_TOKEN: 'secret' })), { plannerUrl: none.plannerUrl, plannerConfigured: true });

  ps.close();
  console.log('Planner relay checks passed');
})().catch(e => { console.error(e); process.exit(1); });
