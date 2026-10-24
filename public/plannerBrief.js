(() => {
  'use strict';
  // "Send to Planner": pick the client, the competitors and the dates, preview the plain-English facts, then send the
  // Competitor Brief to the TV Media Planning Tool. The brief is counted in this browser by the data engine
  // (server/plannerBrief.js); the dashboard server only adds the planner's bearer token and passes it on (server/planner-relay.js).
  const O = window.ORBIT;
  const $ = id => document.getElementById(id);
  const root = $('pbOverlay'), btn = $('plannerBtn');
  if (!root || !btn || !O) return;
  const esc = O.esc;
  const nf = (v, d = 0) => O.nf(v, d);

  let st = null;     // { opts, cfg, filters, client ('__mine__' or a name), comps:Set, from, to, brief, error, busy, seq }
  let timer = 0;

  const clientNames = () => (st.client === '__mine__' ? st.opts.mine.slice() : [st.client]);
  const choice = () => ({ client: clientNames(), competitors: [...st.comps].filter(n => !clientNames().includes(n)), from: st.from, to: st.to });

  async function open() {
    const filters = O.filters();
    if (!filters) { O.toast('Load your data file first'); return; }
    root.innerHTML = '<div class="sh-box pb-box" role="dialog" aria-modal="true" aria-label="Send to Planner"><div class="sh-h"><h3>Send to Planner</h3><button class="bmp-x" data-pb="close" aria-label="Close">✕</button></div><div class="sh-body"><p class="pb-load">Getting the advertisers…</p></div></div>';
    root.classList.add('on');
    try {
      const [opts, cfg] = await Promise.all([
        O.engine.call('plannerOptions', { filters }),
        fetch('/api/config').then(r => r.json()).catch(() => ({ plannerConfigured: false })),
      ]);
      st = { opts, cfg, filters, client: opts.mine.length > 1 ? '__mine__' : (opts.mine[0] || (opts.advertisers[0] || {}).name || ''), comps: new Set(opts.competitors), from: opts.from, to: opts.to, brief: null, error: '', busy: false, seq: 0, fail: false };
      st.comps.forEach(n => { if (clientNames().includes(n)) st.comps.delete(n); });
      draw();
      refresh();
    } catch (e) {
      root.querySelector('.sh-body').innerHTML = `<div class="sh-status err">${esc(e.message)}</div>`;
    }
  }
  const close = () => { root.classList.remove('on'); root.innerHTML = ''; st = null; clearTimeout(timer); };

  function compRows(query) {
    const mine = new Set(clientNames()), q = query.trim().toLowerCase();
    const full = st.comps.size >= st.opts.maxCompetitors;
    return st.opts.advertisers.filter(a => !mine.has(a.name) && (!q || a.name.toLowerCase().includes(q))).map(a => {
      const on = st.comps.has(a.name), off = !on && full;
      return `<label class="pb-comp${off ? ' off' : ''}"><input type="checkbox" data-comp="${esc(a.name)}"${on ? ' checked' : ''}${off ? ' disabled' : ''}><b>${esc(a.name)}</b><small>${nf(a.sos, 1)}% · LKR ${nf(a.spend)}</small></label>`;
    }).join('') || '<div class="pb-comp off">No advertisers match</div>';
  }

  function draw() {
    const o = st.opts, minePick = o.mine.length > 1 ? `<option value="__mine__"${st.client === '__mine__' ? ' selected' : ''}>${esc(o.mine.join(' + '))} (combined, as ticked)</option>` : '';
    root.innerHTML = `<div class="sh-box pb-box" role="dialog" aria-modal="true" aria-label="Send to Planner">
      <div class="sh-h"><h3>Send to Planner</h3><button class="bmp-x" data-pb="close" aria-label="Close">✕</button></div>
      <div class="sh-body">
        <p class="sh-note" style="margin-top:8px">Builds a Competitor Brief for <b>${esc(o.productGroup)}</b> from the filters on screen and sends it to the TV Media Planning Tool, where the planning agent uses it to draft media plans. Only totals and top lists are sent, never the raw spot rows.</p>
        <div class="pb-sec"><label for="pbClient">My advertiser</label>
          <select class="pb-in" id="pbClient">${minePick}${o.advertisers.map(a => `<option value="${esc(a.name)}"${st.client === a.name ? ' selected' : ''}>${esc(a.name)}</option>`).join('')}</select></div>
        <div class="pb-sec"><label for="pbQ">Competitors <span class="pb-hint" id="pbCount" style="font-weight:500"></span></label>
          <input class="pb-in" id="pbQ" type="search" placeholder="Search advertisers" autocomplete="off">
          <div class="pb-comps" id="pbComps">${compRows('')}</div></div>
        <div class="pb-sec pb-row">
          <div><label for="pbFrom">From</label><input class="pb-in" id="pbFrom" type="date" value="${esc(st.from)}" min="${esc(o.minDate)}" max="${esc(o.maxDate)}"></div>
          <div><label for="pbTo">To</label><input class="pb-in" id="pbTo" type="date" value="${esc(st.to)}" min="${esc(o.minDate)}" max="${esc(o.maxDate)}"></div>
        </div>
        <div class="pb-sum" id="pbSum" aria-live="polite">Building the brief…</div>
        <div class="pb-sec"><span class="pb-l">What the planner will read first (facts)</span><ul class="pb-facts" id="pbFacts"></ul></div>
      </div>
      <div class="sh-f pb-f"><span class="sh-err" id="pbErr" role="alert"></span><button class="btn ghost pb-dl" id="pbDl" data-pb="download" disabled>Download JSON</button><button class="btn pri" id="pbGo" data-pb="send" disabled>Send</button></div></div>`;
    countText();
    $('pbClient').focus();
  }
  // Ticking a competitor only switches the other rows on or off at the limit; the list is not redrawn, so scroll and focus stay put.
  function syncComps() {
    const full = st.comps.size >= st.opts.maxCompetitors;
    root.querySelectorAll('#pbComps input[data-comp]').forEach(i => { const off = !i.checked && full; i.disabled = off; i.closest('.pb-comp').classList.toggle('off', off); });
  }
  function countText() {
    const c = $('pbCount');
    if (c) c.textContent = `(${st.comps.size} of up to ${st.opts.maxCompetitors} chosen)`;
  }

  // Rebuild the brief for the current choices (the engine counts it in this browser, about a fifth of a second).
  function refresh() {
    clearTimeout(timer);
    timer = setTimeout(async () => {
      if (!st) return;
      const mySeq = ++st.seq;
      st.brief = null; st.fail = false;
      setButtons();
      $('pbSum').className = 'pb-sum'; $('pbSum').textContent = 'Building the brief…';
      try {
        const c = choice();
        if (!c.client.length) throw new Error('Choose my advertiser first.');
        const b = await O.engine.call('plannerBrief', { filters: st.filters, choice: c });
        if (!st || mySeq !== st.seq) return;
        st.brief = b;
        showBrief(b);
      } catch (e) {
        if (!st || mySeq !== st.seq) return;
        $('pbSum').className = 'pb-sum err'; $('pbSum').textContent = e.message;
        $('pbFacts').innerHTML = '';
      }
      setButtons();
    }, 200);
  }
  function showBrief(b) {
    const kb = (b.meta.sizeBytes / 1024).toFixed(1);
    const g = b.comparison.gapsAndOpportunities.length;
    $('pbSum').innerHTML = `<b>${esc(b.context.myAdvertiser)}</b> against ${b.context.competitors.length} competitor${b.context.competitors.length === 1 ? '' : 's'} · ${esc(b.context.dateFrom)} to ${esc(b.context.dateTo)} · LKR ${nf(b.categorySummary.totalSpend)} category spend over ${nf(b.categorySummary.totalSpots)} spots<br>${b.facts.length} facts · ${g} gap${g === 1 ? '' : 's'} and opportunit${g === 1 ? 'y' : 'ies'} · ${kb} KB of 200 KB`
      + b.warnings.map(w => `<div class="pb-warn">${esc(w)}</div>`).join('');
    $('pbFacts').innerHTML = b.facts.map(f => `<li><i>${esc(f.id)}</i><span>${esc(f.text)}</span></li>`).join('');
  }
  function setButtons() {
    const go = $('pbGo'), dl = $('pbDl');
    if (!go) return;
    const ready = !!st.brief && !st.busy;
    go.disabled = !ready || !st.cfg.plannerConfigured;
    go.title = st.cfg.plannerConfigured ? '' : 'Sending is not set up on this dashboard (PLANNER_API_URL and PLANNER_API_TOKEN). Use Download JSON.';
    dl.disabled = !ready;
    dl.classList.toggle('hot', !!st.fail || !st.cfg.plannerConfigured);
    go.textContent = st.busy ? 'Sending…' : 'Send';
    if (!st.cfg.plannerConfigured && !$('pbErr').textContent) $('pbErr').textContent = 'Sending is not set up here. Use Download JSON.';
  }

  function download() {
    if (!st || !st.brief) return;
    const b = st.brief, a = document.createElement('a');
    a.href = URL.createObjectURL(new Blob([JSON.stringify(b)], { type: 'application/json' }));
    a.download = `Ogilvy_Orbit_Chub_Planner_Brief_${String(b.context.productGroup).replace(/[^\w]+/g, '-')}_${b.context.dateFrom}_to_${b.context.dateTo}.json`;
    a.click();
    setTimeout(() => URL.revokeObjectURL(a.href), 1000);
    O.toast('Competitor Brief downloaded');
  }

  async function send() {
    if (!st || !st.brief || st.busy) return;
    // Open the planner tab inside the click, before any await, so pop-up blockers allow it.
    const win = window.open('about:blank', 'ooc-planner');
    st.busy = true; st.fail = false; $('pbErr').textContent = ''; setButtons();
    try {
      const r = await fetch('/api/planner/briefs', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(st.brief) });
      const j = await r.json().catch(() => ({}));
      if (r.status === 401 && j.signIn) { location.replace('/login'); return; }
      if (!r.ok) throw new Error(j.error || r.statusText);
      if (win) win.location.href = j.planUrl; else O.toast('Sent. Your browser blocked the new tab; open the planner and look for the brief.');
      O.toast(`Sent to the planner (brief ${j.briefId})`);
      close();
    } catch (e) {
      if (win) win.close();
      if (st) { st.busy = false; st.fail = true; $('pbErr').textContent = /Download JSON/.test(e.message) ? e.message : e.message + ' You can still use Download JSON.'; setButtons(); }
      O.toast('Send failed: ' + e.message);
    }
  }

  btn.addEventListener('click', open);
  root.addEventListener('click', e => {
    if (e.target === root) return close();
    const a = e.target.closest('[data-pb]');
    if (!a) return;
    if (a.dataset.pb === 'close') close(); else if (a.dataset.pb === 'download') download(); else if (a.dataset.pb === 'send') send();
  });
  root.addEventListener('change', e => {
    if (!st) return;
    const t = e.target;
    if (t.id === 'pbClient') {
      st.client = t.value;
      clientNames().forEach(n => st.comps.delete(n));
      $('pbComps').innerHTML = compRows($('pbQ').value); countText(); refresh();
    } else if (t.dataset && t.dataset.comp != null) {
      if (t.checked) st.comps.add(t.dataset.comp); else st.comps.delete(t.dataset.comp);
      syncComps(); countText(); refresh();
    } else if (t.id === 'pbFrom' || t.id === 'pbTo') {
      const from = $('pbFrom').value, to = $('pbTo').value;
      if (from && to && from <= to) { st.from = from; st.to = to; refresh(); }
      else { $('pbSum').className = 'pb-sum err'; $('pbSum').textContent = 'The start date must be on or before the end date.'; st.brief = null; setButtons(); }
    }
  });
  root.addEventListener('input', e => { if (st && e.target.id === 'pbQ') $('pbComps').innerHTML = compRows(e.target.value); });
  document.addEventListener('keydown', e => { if (e.key === 'Escape' && st) close(); });
})();
