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
    // customized dashboard: the layout is cleaned, saved with the link, readable by the client, and can be edited later on the same link
    const lay = { items: [{ k: 'trend', c: 3, r: 1, w: 9, h: 7 }, { k: 'trend', c: 0, r: 1, w: 3, h: 3 }, { k: 'evil', c: 0, r: 1, w: 3, h: 3 }, { k: 'text', c: 0, r: 9, w: 12, h: 2, t: { h: 'Hello', b: 'x'.repeat(5000) } }], filters: { adv: false } };
    assert.strictEqual((await call('/api/shared-dashboards', json({ title: 'T', cube, layout: { items: [{ k: 'evil' }] }, lockedFilters: {} }))).status, 400, 'a layout with no known chart is rejected');
    const cm = await call('/api/shared-dashboards', json({ title: 'Custom', cube, layout: lay, lockedFilters: { level: 'full' } }));
    assert.strictEqual(cm.status, 200);
    const cg = await call('/api/shared-dashboards/' + cm.body.token);
    const L = cg.body.lockedFilters.layout;
    assert.deepStrictEqual(L.items.map(i => i.k), ['trend', 'text'], 'unknown charts and duplicate charts are dropped');
    assert.strictEqual(L.items[0].c, 3); assert.strictEqual(L.items[0].w, 9);
    assert.strictEqual(L.items[1].t.b.length, 1200, 'text is limited');
    assert.strictEqual(L.filters.adv, 0); assert.strictEqual(L.filters.period, 1);
    assert.strictEqual(cg.body.lockedFilters.level, 'full');
    assert.strictEqual((await call('/api/shared-dashboards/' + cm.body.token + '/layout')).body.layout.items.length, 2);
    const put = await call('/api/shared-dashboards/' + cm.body.token + '/layout', { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ layout: { items: [{ k: 'sos', c: 20, r: 1, w: 4, h: 6 }] } }) });
    assert.strictEqual(put.status, 200);
    const after = (await call('/api/shared-dashboards/' + cm.body.token)).body.lockedFilters;
    assert.deepStrictEqual(after.layout.items.map(i => i.k), ['sos'], 'the same link shows the new layout');
    assert.strictEqual(after.layout.items[0].c, 8, 'a chart cannot run off the right edge');
    assert.strictEqual(after.level, 'full', 'the rest of the link is untouched');
    // the Category dashboard can be customized too: only its own charts are accepted there
    const withCat = await call('/api/shared-dashboards/' + cm.body.token + '/layout', { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ layout: { items: [{ k: 'sos', c: 0, r: 1, w: 4, h: 6 }], cat: { items: [{ k: 'cat_invest', c: 0, r: 1, w: 7, h: 10 }, { k: 'trend', c: 0, r: 1, w: 3, h: 3 }, { k: 'cat_pref', c: 9, r: 1, w: 8, h: 10 }, { k: 'cat_left', c: 0, r: 1, w: 3, h: 3 }] } } }) });
    assert.strictEqual(withCat.status, 200);
    const cl = (await call('/api/shared-dashboards/' + cm.body.token)).body.lockedFilters.layout;
    assert.deepStrictEqual(cl.cat.items.map(i => i.k), ['cat_invest', 'cat_pref'], 'a Spot Log chart or the old combined panels cannot sit on the Category canvas');
    assert.strictEqual(cl.cat.items[1].c, 4, 'a Category chart cannot run off the right edge');
    assert.strictEqual((await call('/api/shared-dashboards/' + cm.body.token + '/layout', { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ layout: { items: [] } }) })).status, 400);
    const clist = (await call('/api/shared-dashboards')).body.shares;
    assert.ok(clist.find(x => x.token === cm.body.token).custom, 'the list says which links are customized');
    assert.strictEqual((await call('/api/shared-dashboards/' + 'x'.repeat(30))).status, 404, 'unknown token');
    assert.strictEqual((await call('/api/shared-dashboards/short')).status, 404, 'malformed token');
    // the page itself is served without sign-in
    const page = await fetch(BASE + '/share/' + made.body.token);
    assert.strictEqual(page.status, 200);
    assert.match(await page.text(), /Ogilvy Orbit/);
    // listing shows view counts, never the cube
    const list = await call('/api/shared-dashboards');
    assert.strictEqual(list.body.shares.length, 2); // the Q2 review and the customized one made above
    assert.ok(list.body.shares.find(x => x.title === 'Q2 review').views >= 1);
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
