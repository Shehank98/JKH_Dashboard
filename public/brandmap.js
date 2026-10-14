(() => {
  'use strict';
  // The shared Brand Map in the browser: the popup that must be completed before a main file loads (every brand
  // needs a mother brand, sub category is optional), the Brand Map page where anyone can edit, and the check that
  // rebuilds the Category data when somebody has changed the map.
  const O = window.ORBIT;
  const $ = id => document.getElementById(id);
  const { esc, nf } = O;
  const KNOWN_FIRST = s => String(s || '').trim().split(/\s+/)[0].toLowerCase();

  async function api(url, opts) {
    const r = await fetch(url, opts && opts.body ? { ...opts, headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(opts.body) } : opts);
    const j = await r.json().catch(() => ({}));
    if (r.status === 401 && j.signIn) { location.replace('/login'); throw new Error('Please sign in'); }
    if (!r.ok) throw new Error(j.error || r.statusText);
    return j;
  }
  const post = (url, body) => api(url, { method: 'POST', body });

  // The guess for a new brand (same rule as the engine): first word, unless it starts with a known mother brand.
  function guess(brand, known) {
    const b = String(brand || '').replace(/\s+/g, ' ').trim();
    if (!b || b === '(blank)') return '(blank)';
    const low = b.toLowerCase();
    let best = '';
    for (const m of known || []) {
      const ml = String(m).trim().toLowerCase();
      if (ml && (low === ml || low.startsWith(ml + ' ')) && ml.length > best.length) best = String(m).trim();
    }
    return best || b.split(' ')[0].replace(/[,;:]+$/, '');
  }

  // ---------- the blocking popup before a main file loads ----------
  const box = $('bmConfirm');
  const CHUNK = 150;
  let st = null;

  // Resolves { rows, version } (the whole map) once every brand in the file is confirmed, or null if cancelled.
  async function confirm(pairs, fileName) {
    const chk = await post('/api/brandmap/check', { pairs });
    const fresh = [];
    chk.results.forEach((r, i) => { if (!r) fresh.push({ pg: pairs[i][0], brand: pairs[i][1] }); });
    if (!fresh.length) return { ...(await api('/api/brandmap/all')) };
    const knownByPg = chk.mothers || {};
    for (const f of fresh) f.mother = guess(f.brand, knownByPg[f.pg]);
    fresh.sort((a, b) => a.pg.localeCompare(b.pg) || a.mother.localeCompare(b.mother) || a.brand.localeCompare(b.brand));
    return new Promise((resolve, reject) => {
      st = { rows: fresh, known: chk.results.length - fresh.length, mothers: knownByPg, subs: chk.subs || {}, fileName, q: '', shown: CHUNK, resolve, reject, busy: false };
      drawConfirm();
      box.classList.add('on');
    });
  }

  const visible = () => {
    const q = st.q.toLowerCase();
    return st.rows.map((r, i) => [r, i]).filter(([r]) => !q || (r.pg + ' ' + r.brand + ' ' + r.mother + ' ' + (r.sub || '')).toLowerCase().includes(q));
  };
  const missing = () => st.rows.filter(r => !String(r.mother || '').trim()).length;

  function drawConfirm() {
    const pgs = [...new Set(st.rows.map(r => r.pg))];
    const dl = pgs.map((pg, k) => {
      const ms = new Set(st.mothers[pg] || []);
      for (const r of st.rows) if (r.pg === pg && r.mother) ms.add(r.mother);
      return `<datalist id="bmM${k}">${[...ms].sort().map(m => `<option value="${esc(m)}">`).join('')}</datalist><datalist id="bmS${k}">${(st.subs[pg] || []).map(m => `<option value="${esc(m)}">`).join('')}</datalist>`;
    }).join('');
    const list = visible();
    const rows = list.slice(0, st.shown).map(([r, i]) => `<tr data-i="${i}">
      <td class="bm-pg">${esc(r.pg)}</td><td class="bm-b" title="${esc(r.brand)}">${esc(r.brand)}</td>
      <td><input class="bm-in m" list="bmM${pgs.indexOf(r.pg)}" value="${esc(r.mother)}" placeholder="Mother brand (required)" maxlength="120"></td>
      <td><input class="bm-in s" list="bmS${pgs.indexOf(r.pg)}" value="${esc(r.sub || '')}" placeholder="Sub category (optional)" maxlength="120"></td>
      <td><button type="button" class="bm-sim" title="Use this mother brand and sub category for every new brand that starts with “${esc(String(r.brand).split(/\s+/)[0])}”">⇉ Same for “${esc(String(r.brand).split(/\s+/)[0])}…”</button></td></tr>`).join('');
    box.innerHTML = `<div class="bm-box">
      <div class="bm-h"><h3>Confirm brands before loading</h3>
        <span class="bm-sub">${esc(st.fileName || 'Your file')} · <b>${nf(st.rows.length)}</b> new brand${st.rows.length === 1 ? '' : 's'} to confirm · ${nf(st.known)} already known</span></div>
      <p class="bm-note">Every brand needs a <b>mother brand</b>. We guessed it from the first word of the brand (or from a mother brand already saved), so please check the guesses. <b>Sub category</b> is optional. These are saved in the shared Brand Map and used for the Category dashboard, for everyone.</p>
      <div class="bm-tools"><input class="bm-search" id="bmQ" placeholder="Search brands" value="${esc(st.q)}"><span class="bm-count" id="bmCount"></span></div>
      <div class="bm-scroll"><table class="bm-t"><thead><tr><th>Product group</th><th>Brand</th><th>Mother brand</th><th>Sub category</th><th></th></tr></thead><tbody>${rows}</tbody></table>
        ${list.length > st.shown ? `<button type="button" class="bm-more" id="bmMore">Show ${nf(Math.min(CHUNK, list.length - st.shown))} more (${nf(list.length - st.shown)} left)</button>` : ''}
        ${!list.length ? '<div class="bm-empty">No brands match your search</div>' : ''}</div>
      ${dl}
      <div class="bm-f"><span class="bm-err" id="bmErr"></span><button type="button" class="btn ghost" id="bmCancel">Cancel (nothing is loaded)</button><button type="button" class="btn pri" id="bmOk">Confirm and load file</button></div></div>`;
    updateConfirmState();
    const q = $('bmQ');
    if (q === document.activeElement || st.refocus) { q.focus(); q.setSelectionRange(q.value.length, q.value.length); st.refocus = false; }
  }
  function updateConfirmState() {
    const miss = missing();
    $('bmOk').disabled = st.busy || miss > 0;
    $('bmCount').textContent = miss ? `${nf(miss)} still need a mother brand` : 'All brands have a mother brand';
    $('bmCount').className = 'bm-count' + (miss ? ' warn' : ' ok');
  }
  function closeConfirm() { box.classList.remove('on'); box.innerHTML = ''; st = null; }

  box.addEventListener('input', e => {
    if (!st) return;
    if (e.target.id === 'bmQ') { st.q = e.target.value; st.shown = CHUNK; st.refocus = true; drawConfirm(); return; }
    const tr = e.target.closest('tr[data-i]');
    if (!tr) return;
    const r = st.rows[Number(tr.dataset.i)];
    if (e.target.classList.contains('m')) r.mother = e.target.value.trim().replace(/\s+/g, ' ');
    else if (e.target.classList.contains('s')) r.sub = e.target.value.trim().replace(/\s+/g, ' ');
    updateConfirmState();
  });
  box.addEventListener('click', async e => {
    if (!st) return;
    if (e.target.id === 'bmMore') { st.shown += CHUNK; drawConfirm(); return; }
    const sim = e.target.closest('.bm-sim');
    if (sim) {
      const src = st.rows[Number(sim.closest('tr').dataset.i)];
      const w = KNOWN_FIRST(src.brand);
      let n = 0;
      for (const r of st.rows) if (r.pg === src.pg && KNOWN_FIRST(r.brand) === w) { r.mother = src.mother; r.sub = src.sub || ''; n++; }
      O.toast(`Applied to ${n} brand${n === 1 ? '' : 's'}`);
      drawConfirm();
      return;
    }
    if (e.target.id === 'bmCancel') { const s = st; closeConfirm(); s.resolve(null); return; }
    if (e.target.id === 'bmOk') {
      if (missing()) return;
      st.busy = true; updateConfirmState(); $('bmOk').textContent = 'Saving…';
      try {
        await post('/api/brandmap/save', { rows: st.rows.map(r => ({ pg: r.pg, brand: r.brand, mother: r.mother, sub: r.sub || '' })), kind: 'upload' });
        const all = await api('/api/brandmap/all');
        const s = st; closeConfirm(); s.resolve(all);
      } catch (err) {
        st.busy = false; $('bmOk').textContent = 'Confirm and load file'; updateConfirmState();
        $('bmErr').textContent = 'Could not save: ' + err.message;
      }
    }
  });

  // ---------- keep the Category data in step with the shared map ----------
  let syncing = false;
  async function sync() {
    if (syncing || !O.ready || document.body.classList.contains('share-mode')) return;
    syncing = true;
    try {
      const s = await O.engine.call('catStatus');
      if (!s.derived || !s.canDerive) return;
      const v = await api('/api/brandmap/version');
      if (v.version === s.mapVersion) return;
      const all = await api('/api/brandmap/all');
      const r = await O.engine.call('rederiveCategory', { map: all.rows, version: all.version });
      if (r.category) { document.dispatchEvent(new CustomEvent('orbit:catrefresh', { detail: { dataset: r.category.dataset, fresh: false } })); O.toast('Brand Map changed: the Category dashboard was updated'); }
    } catch (e) { /* offline or signed out: keep what is shown */ } finally { syncing = false; }
  }
  // Makes sure the browser engine holds the current Brand Map (the brand view needs it) and the Category data is built from it.
  // Resolves true when the full brand view can be used.
  async function ensureMap() {
    if (document.body.classList.contains('share-mode')) return false;
    await sync();
    const s = await O.engine.call('catStatus');
    if (!s.canDerive || !s.derived) return false;
    const v = await api('/api/brandmap/version');
    if (s.mapHeld !== v.version) { const all = await api('/api/brandmap/all'); await O.engine.call('setMap', { map: all.rows, version: all.version }); }
    return true;
  }
  document.addEventListener('visibilitychange', () => { if (!document.hidden) sync(); });

  // ---------- the Brand Map page ----------
  const page = $('bmPage');
  let pg = { q: '', filter: 'all', offset: 0, limit: 100, data: null, tab: 'map', hist: null, busy: false };
  const when = iso => { const d = new Date(iso); return d.toLocaleString([], { dateStyle: 'medium', timeStyle: 'short' }); };

  async function load() {
    try {
      pg.data = await api(`/api/brandmap/list?q=${encodeURIComponent(pg.q)}&filter=${pg.filter}&offset=${pg.offset}&limit=${pg.limit}`);
      if (pg.tab === 'history') pg.hist = await api('/api/brandmap/history?limit=100');
      drawPage();
    } catch (e) { page.querySelector('.bmp-body').innerHTML = `<div class="bm-empty">Could not load the Brand Map: ${esc(e.message)}</div>`; }
  }
  function drawPage() {
    const d = pg.data;
    const pgs = [...new Set([...Object.keys(d.mothers), ...Object.keys(d.subs)])];
    const dl = pgs.map((p, k) => `<datalist id="bpM${k}">${(d.mothers[p] || []).map(m => `<option value="${esc(m)}">`).join('')}</datalist><datalist id="bpS${k}">${(d.subs[p] || []).map(m => `<option value="${esc(m)}">`).join('')}</datalist>`).join('');
    const rows = d.rows.map(r => {
      const k = pgs.indexOf(r.pg);
      return `<tr data-pg="${esc(r.pg)}" data-b="${esc(r.brand)}" data-m0="${esc(r.mother)}" data-s0="${esc(r.sub)}">
        <td class="bm-pg">${esc(r.pg)}</td><td class="bm-b" title="${esc(r.brand)}">${esc(r.brand)}</td>
        <td><input class="bm-in m" list="bpM${k}" value="${esc(r.mother)}" maxlength="120"></td>
        <td><input class="bm-in s" list="bpS${k}" value="${esc(r.sub)}" placeholder="none" maxlength="120"></td>
        <td class="bm-by" title="${esc(when(r.at))}">${esc(r.by || '')}<br><small>${esc(when(r.at))}</small></td></tr>`;
    }).join('');
    const from = d.total ? pg.offset + 1 : 0, to = Math.min(d.total, pg.offset + pg.limit);
    const body = pg.tab === 'history' ? drawHistory() : `
      <div class="bmp-tools"><input class="bm-search" id="bmpQ" placeholder="Search brand, mother brand or sub category" value="${esc(pg.q)}">
        <div class="tgl sm" id="bmpF"><button data-v="all" class="${pg.filter === 'all' ? 'on' : ''}">All</button><button data-v="nosub" class="${pg.filter === 'nosub' ? 'on' : ''}">No sub category</button></div>
        <button class="btn ghost" id="bmpImport" title="Add the brands, mother brands and sub categories found in a Category file">Import from a Category file</button>
        <input type="file" id="bmpFile" accept=".xlsx,.xlsm,.csv" style="display:none"></div>
      <div class="bmp-status" id="bmpStatus"></div>
      <div class="bm-scroll"><table class="bm-t"><thead><tr><th>Product group</th><th>Brand</th><th>Mother brand</th><th>Sub category</th><th>Last edited</th></tr></thead><tbody>${rows}</tbody></table>
        ${!d.rows.length ? '<div class="bm-empty">No brands yet. They are added when a main file is loaded, or import a Category file.</div>' : ''}</div>
      ${dl}
      <div class="bmp-pager"><span>${nf(from)}–${nf(to)} of ${nf(d.total)}</span><button class="btn ghost" id="bmpPrev" ${pg.offset ? '' : 'disabled'}>‹ Prev</button><button class="btn ghost" id="bmpNext" ${to < d.total ? '' : 'disabled'}>Next ›</button></div>`;
    const keep = pg.focusQ;
    page.innerHTML = `<div class="bmp-box"><div class="bmp-h"><h3>Brand Map</h3><span class="bm-sub">${nf(d.count)} brands · shared by everyone · changes update the Category dashboard</span>
      <div class="tgl sm" id="bmpTab"><button data-v="map" class="${pg.tab === 'map' ? 'on' : ''}">Brands</button><button data-v="history" class="${pg.tab === 'history' ? 'on' : ''}">History</button></div>
      <button class="bmp-x" id="bmpClose" aria-label="Close">✕</button></div><div class="bmp-body">${body}</div></div>`;
    if (keep) { const q = $('bmpQ'); if (q) { q.focus(); q.setSelectionRange(q.value.length, q.value.length); } pg.focusQ = false; }
  }
  function drawHistory() {
    const b = pg.hist ? pg.hist.batches : [];
    if (!b.length) return '<div class="bm-empty">No changes yet</div>';
    const kind = { upload: 'Confirmed on upload', edit: 'Edited', import: 'Imported', undo: 'Undo' };
    return `<div class="bm-scroll"><table class="bm-t"><thead><tr><th>When</th><th>Who</th><th>What</th><th>Changes</th><th></th></tr></thead><tbody>${b.map(x => `<tr>
      <td>${esc(when(x.at))}</td><td>${esc(x.by || '')}</td><td>${esc(kind[x.kind] || x.kind)}</td>
      <td>${nf(x.count)} brand${x.count === 1 ? '' : 's'}<br><small>${x.sample.map(esc).join('<br>')}${x.count > 3 ? '<br>…' : ''}</small></td>
      <td>${x.kind === 'undo' ? '' : `<button class="btn ghost bm-undo" data-batch="${esc(x.batch)}">Undo</button>`}</td></tr>`).join('')}</tbody></table></div>`;
  }
  const setStatus = (t, err) => { const el = $('bmpStatus'); if (el) { el.textContent = t; el.className = 'bmp-status' + (err ? ' err' : ''); } };

  page.addEventListener('change', async e => {
    const tr = e.target.closest('tr[data-b]');
    if (tr && e.target.classList.contains('bm-in')) {
      const mother = tr.querySelector('.m').value.trim().replace(/\s+/g, ' '), sub = tr.querySelector('.s').value.trim().replace(/\s+/g, ' ');
      if (!mother) { tr.querySelector('.m').value = tr.dataset.m0; setStatus('A mother brand is required', true); return; }
      if (mother === tr.dataset.m0 && sub === tr.dataset.s0) return;
      try {
        await post('/api/brandmap/save', { rows: [{ pg: tr.dataset.pg, brand: tr.dataset.b, mother, sub }], kind: 'edit' });
        tr.dataset.m0 = mother; tr.dataset.s0 = sub;
        setStatus(`Saved ${tr.dataset.b}`);
      } catch (err) { setStatus('Could not save: ' + err.message, true); }
      return;
    }
    if (e.target.id === 'bmpFile' && e.target.files[0]) importFile(e.target.files[0]);
  });
  let qTimer = null;
  page.addEventListener('input', e => {
    if (e.target.id !== 'bmpQ') return;
    clearTimeout(qTimer);
    qTimer = setTimeout(() => { pg.q = e.target.value; pg.offset = 0; pg.focusQ = true; load(); }, 250);
  });
  page.addEventListener('click', async e => {
    const t = e.target;
    if (t.id === 'bmpClose' || t === page) { close(); return; }
    const f = t.closest('#bmpF button');
    if (f) { pg.filter = f.dataset.v; pg.offset = 0; load(); return; }
    const tab = t.closest('#bmpTab button');
    if (tab) { pg.tab = tab.dataset.v; load(); return; }
    if (t.id === 'bmpPrev') { pg.offset = Math.max(0, pg.offset - pg.limit); load(); return; }
    if (t.id === 'bmpNext') { pg.offset += pg.limit; load(); return; }
    if (t.id === 'bmpImport') { $('bmpFile').click(); return; }
    const u = t.closest('.bm-undo');
    if (u) {
      if (!window.confirm('Undo this change for everyone?')) return;
      try { await post('/api/brandmap/undo', { batch: u.dataset.batch }); O.toast('Change undone'); await load(); } catch (err) { O.toast('Could not undo: ' + err.message); }
    }
  });
  async function importFile(file) {
    setStatus(`Reading ${file.name}…`);
    try {
      const r = await O.engine.call('readMapping', { file }, p => setStatus(`Reading ${file.name}: ${Math.round(p.pct * 100)}%`));
      const rows = r.rows.map(x => ({ pg: x[0], brand: x[1], mother: x[2], sub: x[3] }));
      let added = 0;
      for (let i = 0; i < rows.length; i += 5000) {
        const res = await post('/api/brandmap/save', { rows: rows.slice(i, i + 5000), kind: 'import', onlyNew: true });
        added += res.changed;
      }
      await load();
      setStatus(`Imported ${nf(added)} new brand${added === 1 ? '' : 's'} from ${file.name} (${nf(rows.length - added)} were already in the map).`);
    } catch (err) { setStatus('Could not import: ' + err.message, true); }
  }
  function open() { pg = { ...pg, q: '', filter: 'all', offset: 0, tab: 'map' }; page.classList.add('on'); page.innerHTML = '<div class="bmp-box"><div class="bmp-body"><div class="bm-empty">Loading…</div></div></div>'; load(); }
  function close() { page.classList.remove('on'); page.innerHTML = ''; sync(); }
  document.addEventListener('keydown', e => { if (e.key === 'Escape' && page.classList.contains('on') && !(st)) close(); });
  document.querySelectorAll('[data-open-brandmap]').forEach(b => b.addEventListener('click', open));

  window.BRANDMAP = { confirm, sync, open, ensureMap };
})();
