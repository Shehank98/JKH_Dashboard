'use strict';
// Shared client dashboards: create, open without sign-in, expiry, revoke, validation. Starts its own server.
const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawn } = require('child_process');
const { buildCube } = require('../server/cube');

const PORT = 3500 + Math.floor(Math.random() * 300);
const BASE = `http://127.0.0.1:${PORT}`;
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'shares-'));
const ds = {
  dicts: { pg: ['P'], adv: ['A', 'B'], theme: ['x', '-BB'], product: ['Alpha One'], channel: ['TV - T1', 'FM X'], channelMedium: [0, 1], channelName: ['T1', 'X'] },
  cols: { mon: Int32Array.from([24300, 24301]), pg: Int32Array.from([0, 0]), adv: Int32Array.from([0, 1]), theme: Int32Array.from([0, 1]), product: Int32Array.from([0, 0]), ch: Int32Array.from([0, 1]), dp: Uint8Array.from([2, 1]), cost: Float64Array.from([100, 50]), durRaw: Float32Array.from([30, NaN]) },
};
const cube = buildCube(ds, () => ({ mother: 'Alpha', sub: 'S1' }), { level: 'full' });
const call = async (p, opts) => { const r = await fetch(BASE + p, opts); return { status: r.status, body: await r.json().catch(() => ({})) }; };
const json = body => ({ method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });

(async () => {
  const srv = spawn(process.execPath, ['server.js'], { cwd: path.join(__dirname, '..'), env: { ...process.env, PORT, DATA_DIR: dir, AUTH_DISABLED: '1', DATABASE_URL: '' }, stdio: 'ignore' });
  try {
    for (let i = 0; i < 50; i++) { try { if ((await fetch(BASE + '/healthz')).ok) break; } catch (e) { /* starting */ } await new Promise(r => setTimeout(r, 100)); }
    assert.strictEqual((await call('/api/shared-dashboards', json({ cube }))).status, 400, 'title is required');
    assert.strictEqual((await call('/api/shared-dashboards', json({ title: 'T', cube: { cols: { mon: [1], x: [] }, dicts: {}, meta: {} } }))).status, 400, 'ragged cube rejected');
    assert.strictEqual((await call('/api/shared-dashboards', json({ title: 'T', cube, expiresAt: '2001-01-01' }))).status, 400, 'past expiry rejected');
    const made = await call('/api/shared-dashboards', json({ title: ' Q2  review ', clientName: 'Acme', cube, state: { pg: 'P' } }));
    assert.strictEqual(made.status, 200);
    assert.match(made.body.token, /^[A-Za-z0-9_-]{30,}$/);
    assert.ok(made.body.url.endsWith('/share/' + made.body.token));
    const got = await call('/api/shared-dashboards/' + made.body.token);
    assert.strictEqual(got.status, 200);
    assert.strictEqual(got.body.title, 'Q2 review');
    assert.strictEqual(got.body.clientName, 'Acme');
    assert.deepStrictEqual(got.body.cube.cols.mon, cube.cols.mon);
    assert.deepStrictEqual(got.body.state, { pg: 'P' });
    assert.strictEqual((await call('/api/shared-dashboards/' + 'x'.repeat(30))).status, 404, 'unknown token');
    assert.strictEqual((await call('/api/shared-dashboards/short')).status, 404, 'malformed token');
    // the page itself is served without sign-in
    const page = await fetch(BASE + '/share/' + made.body.token);
    assert.strictEqual(page.status, 200);
    assert.match(await page.text(), /Ogilvy Orbit/);
    // listing shows view counts, never the cube
    const list = await call('/api/shared-dashboards');
    assert.strictEqual(list.body.shares.length, 1);
    assert.ok(list.body.shares[0].views >= 1);
    assert.ok(!('cube' in list.body.shares[0]));
    // expiry: edit the stored meta file to a past date
    const metaFile = path.join(dir, 'shared', made.body.token + '.meta.json');
    const meta = JSON.parse(fs.readFileSync(metaFile, 'utf8')); meta.expiresAt = '2001-01-01T00:00:00.000Z'; fs.writeFileSync(metaFile, JSON.stringify(meta));
    assert.strictEqual((await call('/api/shared-dashboards/' + made.body.token)).status, 410, 'expired');
    // revoke
    const m2 = await call('/api/shared-dashboards', json({ title: 'Two', cube }));
    assert.strictEqual((await call('/api/shared-dashboards/' + m2.body.token)).status, 200);
    assert.strictEqual((await call('/api/shared-dashboards/' + m2.body.token, { method: 'DELETE' })).status, 200);
    assert.strictEqual((await call('/api/shared-dashboards/' + m2.body.token)).status, 410, 'revoked');
    // gzip upload
    const gz = require('zlib').gzipSync(JSON.stringify({ title: 'Zipped', cube }));
    const z = await fetch(BASE + '/api/shared-dashboards', { method: 'POST', headers: { 'Content-Type': 'application/json', 'Content-Encoding': 'gzip' }, body: gz });
    assert.strictEqual(z.status, 200);
    console.log('Shared dashboard tests passed');
  } finally { srv.kill(); fs.rmSync(dir, { recursive: true, force: true }); }
})().catch(e => { console.error(e); process.exit(1); });
