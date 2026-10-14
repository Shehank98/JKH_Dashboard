'use strict';
// Optional slide notes written by a local Ollama model. The server only relays: it sends the text that is visible on a
// slide and returns a few short bullet points. Nothing is sent anywhere else, and nothing is stored.
const BASE = (process.env.OLLAMA_URL || 'http://127.0.0.1:11434').replace(/\/+$/, '');
const DEFAULT_MODEL = process.env.OLLAMA_MODEL || 'llama3.2:3b';
const timeout = (ms) => AbortSignal.timeout(ms);

async function models() {
  const r = await fetch(BASE + '/api/tags', { signal: timeout(3000) });
  if (!r.ok) throw new Error('Ollama answered ' + r.status);
  const j = await r.json();
  return (j.models || []).map(m => m.name);
}

const SYSTEM = 'You write short speaker notes for a media-spend report slide. You are given the text that is visible on the slide. ' +
  'Write 2 or 3 bullet points (each starting with "• ", each under 25 words) saying what the slide shows: the biggest numbers, who leads, the main gap or change worth noticing. ' +
  'Use only numbers and names that appear in the text. Never guess or invent. Plain English, no heading, no intro.';

function clean(s) {
  const lines = String(s || '').split('\n').map(l => l.trim()).filter(Boolean).map(l => (/^[•\-*]\s*/.test(l) ? '• ' + l.replace(/^[•\-*]\s*/, '') : '• ' + l));
  return lines.slice(0, 3).join('\n');
}

function router(express) {
  const r = express.Router();
  r.get('/status', async (req, res) => {
    try { const list = await models(); res.json({ ok: true, models: list, model: DEFAULT_MODEL && list.includes(DEFAULT_MODEL) ? DEFAULT_MODEL : list[0] || '' }); }
    catch (e) { res.json({ ok: false, models: [], error: 'Ollama is not reachable at ' + BASE }); }
  });
  r.post('/notes', async (req, res) => {
    const { model, title, text } = req.body || {};
    if (!model || !text) return res.status(400).json({ error: 'model and text are needed' });
    try {
      const resp = await fetch(BASE + '/api/chat', {
        method: 'POST', headers: { 'Content-Type': 'application/json' }, signal: timeout(90000),
        body: JSON.stringify({ model: String(model), stream: false, options: { temperature: 0.2, num_predict: 200 },
          messages: [{ role: 'system', content: SYSTEM }, { role: 'user', content: `Slide: ${String(title || '').slice(0, 200)}\n\nVisible text:\n${String(text).slice(0, 4000)}` }] }),
      });
      if (!resp.ok) return res.status(502).json({ error: 'Ollama answered ' + resp.status });
      const j = await resp.json();
      res.json({ notes: clean(j.message && j.message.content) });
    } catch (e) { res.status(502).json({ error: 'Could not reach Ollama: ' + e.message }); }
  });
  return r;
}
module.exports = { router, clean };
