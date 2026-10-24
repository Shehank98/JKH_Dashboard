'use strict';
// Optional slide notes written by a local Ollama model. The server only relays: it sends the text that is visible on a
// slide and returns a few short bullet points. Nothing is sent anywhere else, and nothing is stored.
const BASE = (process.env.OLLAMA_URL || 'http://127.0.0.1:11434').replace(/\/+$/, '');
const DEFAULT_MODEL = process.env.OLLAMA_MODEL || 'llama3.2:3b';
// CPU threads for the model. Ollama picks every core the host machine has (48 in your log), but a container is usually allowed far fewer, and
// that mismatch makes it crawl. Set OLLAMA_THREADS to the vCPUs your Ollama service really has.
const THREADS = Math.max(1, Number(process.env.OLLAMA_THREADS) || 8);
const timeout = (ms) => AbortSignal.timeout(ms);

async function models() {
  const r = await fetch(BASE + '/api/tags', { signal: timeout(3000) });
  if (!r.ok) throw new Error('Ollama answered ' + r.status);
  const j = await r.json();
  return (j.models || []).map(m => m.name);
}

const SYSTEM = 'You are a senior media planner writing the key insights on a media-spend report slide for the ADVERTISER (the client, marked "mine" or "us" on the slide). ' +
  'Always read the numbers from the advertiser\'s side: how our share of voice (SOV) and share of spend (SOS) compare with competitors, where we lead or trail, what to protect, close or fix. ' +
  'Write exactly 3 bullets. Each starts with "• ", is under 28 words, and holds a number from the slide. ' +
  'Use proper media and planning language where the slide supports it: share of voice and spend, spot weight and spot count, average spot cost, rate card, medium split TV / Radio / Press, channel mix and concentration, prime time (PT) and non prime time (NPT), spot length mix and average commercial duration (ACD), commercials against value additions (VA), flighting, burst and always-on weighting, seasonality and peak month, year-on-year growth, category growth versus ours. ' +
  'Bullet 1: where we stand (share and rank against competitors). Bullet 2: the biggest driver, gap or change in the data. Bullet 3: what it means for us and a clear media action (for example rebalance weight, defend or attack a channel, adjust the spot length mix, shift flighting). ' +
  'Tables list advertisers and brands from highest to lowest, so the first row is the leader; our advertiser is the one marked mine or us, and it is not always the leader. Quote numbers exactly as shown. Never add, subtract or work out new figures, and never call an advertiser the leader unless it is first in the ranking. ' +
  'Use ONLY names and numbers that appear in the text. Never invent figures, reach, frequency, CPM, ratings or results that are not shown. If something is not on the slide, leave it out. No heading, no intro, no closing line.';

function clean(s) {
  const lines = String(s || '').split('\n').map(l => l.trim()).filter(Boolean).map(l => (/^[•\-*]\s*/.test(l) ? '• ' + l.replace(/^[•\-*]\s*/, '') : '• ' + l));
  return lines.slice(0, 3).join('\n');
}

// Streams the answer, so a slow CPU never trips a "no response headers" timeout while the model is still thinking.
async function chat(model, messages, ms = 160000) {
  const resp = await fetch(BASE + '/api/chat', {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, signal: timeout(ms),
    body: JSON.stringify({ model: String(model), stream: true, keep_alive: '30m', options: { temperature: 0.2, num_predict: 150, num_ctx: 2048, num_thread: THREADS }, messages }),
  });
  if (!resp.ok) {
    let why = ''; try { why = (await resp.json()).error || ''; } catch (e) { /* no body */ }
    throw new Error('Ollama answered ' + resp.status + (why ? ': ' + why : ''));
  }
  const dec = new TextDecoder(); let buf = '', out = '';
  for await (const chunk of resp.body) {
    buf += dec.decode(chunk, { stream: true });
    let i;
    while ((i = buf.indexOf('\n')) >= 0) {
      const line = buf.slice(0, i).trim(); buf = buf.slice(i + 1);
      if (!line) continue;
      let j; try { j = JSON.parse(line); } catch (e) { continue; }
      if (j.error) throw new Error('Ollama: ' + j.error);
      if (j.message && j.message.content) out += j.message.content;
    }
  }
  return out;
}

function router(express) {
  const r = express.Router();
  r.get('/status', async (req, res) => {
    try { const list = await models(); res.json({ ok: list.length > 0, error: list.length ? '' : 'The AI service is running but has no models yet (they may still be downloading, check again in a few minutes).', models: list, model: DEFAULT_MODEL && list.includes(DEFAULT_MODEL) ? DEFAULT_MODEL : list[0] || '' }); }
    catch (e) { res.json({ ok: false, models: [], error: 'The dashboard server cannot reach the AI service at ' + BASE + (process.env.OLLAMA_URL ? '' : ' (OLLAMA_URL is not set)') }); }
  });
  // Open /api/ai/test in a browser to see exactly what the model does (and how long it takes) from the dashboard server.
  r.get('/test', async (req, res) => {
    const t0 = Date.now();
    try {
      const list = await models();
      const model = String(req.query.model || (DEFAULT_MODEL && list.includes(DEFAULT_MODEL) ? DEFAULT_MODEL : list[0] || ''));
      const reply = await chat(model, [{ role: 'system', content: SYSTEM }, { role: 'user', content: 'Slide: Share of spend\n\nVisible text:\nOur advertiser Maliban 26.0% 2.41 Bn\nDerana Foods 23.9% 2.21 Bn\nMunchee 18.8% 1.74 Bn' }]);
      res.json({ ok: true, url: BASE, model, seconds: Math.round((Date.now() - t0) / 100) / 10, notes: clean(reply) });
    } catch (e) { console.error('[ai/test]', e.message); res.json({ ok: false, url: BASE, seconds: Math.round((Date.now() - t0) / 100) / 10, error: e.message }); }
  });
  r.post('/notes', async (req, res) => {
    const { model, title, text, context } = req.body || {};
    if (!model || !text) return res.status(400).json({ error: 'model and text are needed' });
    try {
      const reply = await chat(model, [{ role: 'system', content: SYSTEM }, { role: 'user', content: `${context ? 'Report context: ' + String(context).slice(0, 600) + '\n' : ''}Slide: ${String(title || '').slice(0, 200)}\n\nVisible text:\n${String(text).slice(0, 1400)}` }]);
      res.json({ notes: clean(reply) });
    } catch (e) { console.error('[ai/notes]', e.message); res.status(502).json({ error: e.message }); }
  });
  return r;
}
module.exports = { router, clean };
