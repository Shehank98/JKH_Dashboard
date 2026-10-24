(() => {
  'use strict';
  // "Send to Planner": a small modal that builds a Competitor Brief (public/plannerBrief.js, run in the data engine)
  // from the current filters and POSTs it through this server to the TV Media Planning Tool. Nothing is stored here.
  const O = window.ORBIT;
  const $ = id => document.getElementById(id);
  const { esc, nf, toast } = O;
  const MAX_COMPETITORS = 8;
  const root = $('plModal');
  let cfg = null, cand = null, filters = null, token = 0, timer = 0, brief = null;
  let picked = new Set();

  const close = () => root.classList.remove('on');
  $('plClose').addEventListener('click', close);
  root.addEventListener('mousedown', e => { if (e.target === root) close(); });
  document.addEventListener('keydown', e => { if (e.key === 'Escape' && root.classList.contains('on')) close(); });

  const note = (msg, err) => { const n = $('plNote'); n.textContent = msg || ''; n.className = 'pl-note' + (err ? ' err' : ''); };
  const options = () => {
    const mineVal = $('plMine').value;
    return {
      myAdvertisers: mineVal === '__mine__' ? filters.mine.slice() : [mineVal],
      competitors: [...picked],
      from: $('plFrom').value || filters.from,
      to: $('plTo').value || filters.to,
    };
  };

  function renderComps() {
    const q = $('plSearch').value.trim().toLowerCase();
    const mine = new Set(options().myAdvertisers);
    $('plComps').innerHTML = cand.advertisers.filter(a => !mine.has(a.name) && (!q || a.name.toLowerCase().includes(q)))
      .map(a => `<label><input type="checkbox" value="${esc(a.name)}"${picked.has(a.name) ? ' checked' : ''}>${esc(a.name)}<span class="n">${a.sharePct == null ? '' : nf(a.sharePct, 1) + '%'} · LKR ${nf(a.spend / 1e6, 1)}M</span></label>`).join('')
      || '<label>No advertisers match</label>';
    $('plCompCount').textContent = `(${picked.size} of up to ${MAX_COMPETITORS} chosen)`;
  }

  // Rebuild the preview shortly after any change; a newer request wins.
  function refresh() {
    clearTimeout(timer);
    timer = setTimeout(async () => {
      const my = ++token;
      $('plSend').disabled = $('plDownload').disabled = true;
      note('Building the brief…');
      try {
        const b = await O.engine.call('plannerBrief', { filters, options: options() });
        if (my !== token) return;
        brief = b;
        $('plFacts').innerHTML = b.facts.map(t => `<li>${esc(t)}</li>`).join('') || '<li>No facts: nothing matches these choices.</li>';
        $('plFactCount').textContent = `(${b.facts.length})`;
        const w = b.meta.warnings.length ? ' · ' + b.meta.warnings.join(' ') : '';
        const t = b.meta.trimmed.length ? ' · trimmed: ' + b.meta.trimmed.join(', ') : '';
        note(`${b.advertisers.length} advertisers · ${b.categorySummary.totalSpots.toLocaleString('en-US')} category spots · ${Math.max(1, Math.round(b.meta.payloadBytes / 1024))} KB${t}${w}`, b.meta.payloadBytes > 200 * 1024);
        $('plSend').disabled = !b.advertisers.length || b.meta.payloadBytes > 200 * 1024;
        $('plDownload').disabled = false;
      } catch (e) {
        if (my !== token) return;
        brief = null; note(e.message, true);
      }
    }, 250);
  }

  async function open() {
    filters = O.getFilters();
    if (!filters) return toast('Load a file first');
    root.classList.add('on');
    note('Loading advertisers…');
    $('plDownload').classList.add('light');
    $('plFacts').innerHTML = '';
    try {
      if (!cfg) { try { cfg = await fetch('/api/config').then(r => r.json()); } catch (e) { cfg = {}; } }
      cand = await O.engine.call('plannerCandidates', { filters });
    } catch (e) { note(e.message, true); return; }
    const names = cand.advertisers.map(a => a.name);
    const mineAll = filters.mine.filter(n => names.includes(n));
    const opts = [];
    if (mineAll.length > 1) opts.push(`<option value="__mine__">${esc(mineAll.join(' + '))} (combined)</option>`);
    for (const a of cand.advertisers) opts.push(`<option value="${esc(a.name)}">${esc(a.name)}</option>`);
    $('plMine').innerHTML = opts.join('');
    $('plMine').value = mineAll.length > 1 ? '__mine__' : (mineAll[0] || names[0] || '');
    $('plFrom').min = $('plTo').min = filters.from; $('plFrom').max = $('plTo').max = filters.to;
    $('plFrom').value = filters.from; $('plTo').value = filters.to;
    $('plSearch').value = '';
    const mine = new Set(options().myAdvertisers);
    picked = new Set(cand.advertisers.filter(a => !mine.has(a.name)).slice(0, 5).map(a => a.name));
    $('plSub').textContent = `${filters.pg} · ${filters.medium === 'All' ? 'TV, Radio, Press' : filters.medium} · filters applied. Totals and facts only, no raw rows.`;
    renderComps(); refresh();
  }

  $('plMine').addEventListener('change', () => { const mine = new Set(options().myAdvertisers); mine.forEach(n => picked.delete(n)); renderComps(); refresh(); });
  $('plFrom').addEventListener('change', refresh);
  $('plTo').addEventListener('change', refresh);
  $('plSearch').addEventListener('input', renderComps);
  $('plComps').addEventListener('change', e => {
    const cb = e.target;
    if (cb.checked && picked.size >= MAX_COMPETITORS) { cb.checked = false; return toast(`Choose up to ${MAX_COMPETITORS} competitors to keep the brief small`); }
    cb.checked ? picked.add(cb.value) : picked.delete(cb.value);
    $('plCompCount').textContent = `(${picked.size} of up to ${MAX_COMPETITORS} chosen)`;
    refresh();
  });

  function download() {
    if (!brief) return;
    const a = document.createElement('a');
    a.href = URL.createObjectURL(new Blob([JSON.stringify(brief, null, 2)], { type: 'application/json' }));
    a.download = `Competitor_Brief_${String(brief.context.productGroup).replace(/[^\w]+/g, '-')}_${brief.context.dateFrom}_to_${brief.context.dateTo}.json`;
    a.click();
    setTimeout(() => URL.revokeObjectURL(a.href), 1000);
    toast('Competitor Brief downloaded');
  }
  $('plDownload').addEventListener('click', download);

  $('plSend').addEventListener('click', async () => {
    if (!brief) return;
    // Open the tab inside the click so pop-up blockers allow it; it is pointed at the planner once the brief is accepted.
    const win = window.open('about:blank', 'orbit-planner');
    const btn = $('plSend');
    btn.disabled = true; note('Sending to the planner…');
    try {
      const r = await fetch('/api/planner/briefs', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(brief) });
      const j = await r.json().catch(() => ({}));
      if (r.status === 401 && j.signIn) { location.replace('/login'); return; }
      if (!r.ok) throw new Error(j.error || `The planner answered ${r.status}.`);
      const base = (cfg && cfg.plannerUrl) || '';
      const dest = base ? `${base}/plan/new?briefId=${encodeURIComponent(j.briefId)}` : j.url;
      if (!dest) throw new Error('The planner accepted the brief but no PLANNER_URL is set to open it.');
      if (win) win.location.href = dest; else window.open(dest, '_blank');
      toast(`Sent to the planner (brief ${j.briefId})`);
      close();
    } catch (e) {
      if (win) win.close();
      note(e.message + ' You can still download the JSON and load it in the planner.', true);
      toast('Send failed: ' + e.message);
      $('plDownload').classList.remove('light');
    } finally { btn.disabled = false; }
  });

  $('plannerBtn').addEventListener('click', open);
})();
