(() => {
  'use strict';
  // Customized dashboard. The agency drags the dashboard's own cards onto a 12-column grid (builder), and the client opens that
  // layout read-only (client view). The cards are the real ones from the Spot Log dashboard: they are moved into the grid, so
  // filters, flips, tooltips and click-through details keep working exactly as on the full dashboard.
  const O = window.ORBIT;
  const $ = id => document.getElementById(id);
  const COLS = 12, ROW = 44, GAP = 10;

  // widget id -> the card it moves (element id), its name, smallest and default size (columns x rows)
  const CAT = {
    kpi1: { el: 'k1', name: 'Total category spend', min: [2, 2], def: [4, 2], hint: 'Number tile' },
    kpi2: { el: 'k2', name: 'My advertiser spend', min: [2, 2], def: [4, 2], hint: 'Number tile' },
    kpi3: { el: 'k3', name: 'Share of spend', min: [2, 2], def: [4, 2], hint: 'Number tile' },
    medium: { el: 'cardMedium', name: 'Medium split', min: [3, 6], def: [3, 7], hint: 'TV, Radio, Press' },
    trend: { el: 'cardTrend', name: 'Monthly spend trend', min: [5, 6], def: [6, 7], hint: 'Lines or bars' },
    drill: { el: 'cardDrill', name: 'Month drill down', min: [3, 6], def: [3, 7], hint: 'Top spender by month' },
    sos: { el: 'cardSos', name: 'Share of spend', min: [4, 6], def: [4, 8], hint: 'Table or chart' },
    mix: { el: 'cardMix', name: 'Channel mix', min: [4, 6], def: [4, 8], hint: 'Top 5 or all channels' },
    dur: { el: 'cardDur', name: 'Duration mix', min: [4, 6], def: [4, 8], hint: 'Needs the Full level' },
    text: { el: null, name: 'Text box', min: [2, 2], def: [6, 2], hint: 'A headline and a message' },
  };
  const ORDER = ['kpi1', 'kpi2', 'kpi3', 'medium', 'trend', 'drill', 'sos', 'mix', 'dur', 'text'];
  const EXAMPLE = [['text', 0, 1, 12, 2], ['kpi1', 0, 3, 4, 2], ['kpi2', 4, 3, 4, 2], ['kpi3', 8, 3, 4, 2], ['medium', 0, 5, 3, 7], ['trend', 3, 5, 6, 7], ['drill', 9, 5, 3, 7], ['sos', 0, 12, 4, 8], ['mix', 4, 12, 4, 8], ['dur', 8, 12, 4, 8]];
  const unavailable = (k, level) => k === 'dur' && level && level !== 'full';

  // ---------- the cards live here while they are on the grid; restoreAll() puts them back where they came from ----------
  const snaps = new Map();
  const parkedEls = new Set();
  function park(el, cell) {
    const p = el.parentNode;
    if (p && !snaps.has(p) && p.id !== 'cuHold' && !p.classList.contains('cu-cell')) snaps.set(p, [...p.children]);
    parkedEls.add(el); cell.appendChild(el);
  }
  function restoreAll() {
    snaps.forEach((kids, parent) => kids.forEach(n => parent.appendChild(n)));
    snaps.clear(); parkedEls.clear();
  }
  const hold = () => { let h = $('cuHold'); if (!h) { h = document.createElement('div'); h.id = 'cuHold'; h.style.display = 'none'; document.body.appendChild(h); } return h; };

  // ---------- the layout ----------
  let st = { items: [], sel: null, hist: [], next: 1, level: 'standard', edit: false };
  const textNodes = new Map(); // item id -> its text card
  const cells = new Map(); // item id -> its cell
  const catOf = it => CAT[it.k];
  const overlap = (a, b) => a.c < b.c + b.w && a.c + a.w > b.c && a.r < b.r + b.h && a.r + a.h > b.r;
  // The item that was just dropped, moved or resized keeps its place; whatever it lands on is pushed down (and so on down the page).
  function settle(it) {
    const queue = [it]; let guard = 0;
    while (queue.length && guard++ < 600) {
      const a = queue.shift();
      st.items.forEach(o => { if (o !== a && overlap(a, o)) { o.r = a.r + a.h; queue.push(o); } });
    }
  }
  const pushHist = () => { st.hist.push(JSON.stringify(st.items.map(i => ({ ...i })))); if (st.hist.length > 40) st.hist.shift(); };
  function load(layout) {
    st.items = []; st.sel = null; st.hist = []; st.next = 1;
    (layout && layout.items || []).forEach(i => { if (CAT[i.k]) st.items.push({ id: st.next++, k: i.k, c: i.c, r: i.r, w: i.w, h: i.h, t: i.t ? { ...i.t } : undefined }); });
  }
  function exportLayout(filters) {
    return { v: 1, items: st.items.map(i => { const o = { k: i.k, c: i.c, r: i.r, w: i.w, h: i.h }; if (i.k === 'text') o.t = readText(i); return o; }), filters: filters || {}, popups: true };
  }
  function readText(it) {
    const n = textNodes.get(it.id);
    if (n) { const h = n.querySelector('[data-th]'), b = n.querySelector('[data-tb]'); if (h && b) it.t = { h: h.innerText.trim(), b: b.innerText.trim() }; }
    return it.t || { h: '', b: '' };
  }

  // ---------- drawing the grid (builder and client share this) ----------
  function textCard(it, edit) {
    const t = it.t || { h: '', b: '' }, d = document.createElement('div');
    d.className = 'card cu-text';
    const ce = edit ? ' contenteditable="true" spellcheck="false"' : '';
    d.innerHTML = `<div class="cu-th"${ce} data-th data-ph="Headline">${O.esc(t.h)}</div><div class="cu-tb"${ce} data-tb data-ph="Write your message here">${O.esc(t.b)}</div>`;
    return d;
  }
  function sync(grid, edit) {
    const ids = new Set(st.items.map(i => i.id));
    cells.forEach((cell, id) => {
      if (ids.has(id) && cell.parentNode === grid) return;
      const node = cell.querySelector(':scope > .card');
      if (node && !textNodes.has(id)) hold().appendChild(node);
      cell.remove(); cells.delete(id); textNodes.delete(id);
    });
    st.items.forEach(it => {
      const def = catOf(it);
      let cell = cells.get(it.id);
      if (!cell) {
        cell = document.createElement('div'); cell.className = 'cu-cell'; cell.dataset.id = it.id;
        let node;
        if (it.k === 'text') { node = textCard(it, edit); textNodes.set(it.id, node); cell.appendChild(node); }
        else { node = $(def.el); if (!node) return; park(node, cell); }
        grid.appendChild(cell); cells.set(it.id, cell);
      }
      cell.style.gridColumn = `${it.c + 1} / span ${it.w}`; cell.style.gridRow = `${it.r} / span ${it.h}`;
      cell.classList.toggle('sel', edit && st.sel === it.id);
      cell.querySelectorAll(':scope > .cu-ov').forEach(o => o.remove());
      if (edit) {
        const ov = document.createElement('div');
        ov.className = 'cu-ov' + (it.k === 'text' ? ' text' : '');
        ov.innerHTML = `<div class="cu-bar2"><span class="cu-grab" data-grab="${it.id}" title="Drag to move">⋮⋮</span><span class="cu-name">${O.esc(def.name)}</span><span class="cu-x" data-x="${it.id}" title="Remove">✕</span></div>` +
          (st.sel === it.id ? `<span class="cu-handle" data-rs="${it.id}" title="Drag to resize"></span><span class="cu-badge">${it.w} × ${it.h}</span>` : `<span class="cu-handle quiet" data-rs="${it.id}" title="Drag to resize"></span>`);
        cell.appendChild(ov);
      }
    });
    const rows = st.items.reduce((m, i) => Math.max(m, i.r + i.h), 0);
    grid.style.minHeight = (edit ? Math.max(14, rows + 3) : rows) * (ROW + GAP) + 'px';
  }

  // ---------- builder ----------
  let page = null, B = null; // B = { onDone, level, grid }
  let ghost = null, op = null, dragKey = null;
  function metrics(grid) { const r = grid.getBoundingClientRect(), colW = (r.width - (COLS - 1) * GAP) / COLS; return { r, colP: colW + GAP, rowP: ROW + GAP }; }
  function cellAt(grid, x, y) { const m = metrics(grid); return { c: Math.floor((x - m.r.left) / m.colP), r: Math.floor((y - m.r.top) / m.rowP) + 1 }; }
  function showGhost(grid, c, r, w, h) { if (!ghost) { ghost = document.createElement('div'); ghost.className = 'cu-ghost'; grid.appendChild(ghost); } ghost.style.gridColumn = `${c + 1} / span ${w}`; ghost.style.gridRow = `${r} / span ${h}`; }
  const hideGhost = () => { if (ghost) { ghost.remove(); ghost = null; } };
  const relayout = () => { try { if (O.spot && O.spot.relayout) O.spot.relayout(); } catch (e) { /* the charts redraw on the next render */ } };

  function addWidget(k, c, r) {
    const def = CAT[k]; if (!def || unavailable(k, B.level)) return;
    if (k !== 'text' && st.items.some(i => i.k === k)) { O.toast(def.name + ' is already on the canvas'); return; }
    pushHist();
    const it = { id: st.next++, k, c: 0, r: 1, w: def.def[0], h: def.def[1] };
    if (k === 'text') it.t = { h: '', b: '' };
    if (c != null) { it.c = Math.max(0, Math.min(COLS - it.w, c)); it.r = Math.max(1, r); settle(it); }
    else { let done = false; for (let rr = 1; rr < 120 && !done; rr++) for (let cc = 0; cc + it.w <= COLS && !done; cc++) { it.c = cc; it.r = rr; if (!st.items.some(o => overlap(it, o))) done = true; } }
    st.items.push(it); st.sel = it.id; paintBuilder(true);
  }
  function paintLib() {
    $('cbLib').innerHTML = '<h4>Charts</h4>' + ORDER.filter(k => k !== 'text').map(k => {
      const d = CAT[k], used = st.items.some(i => i.k === k), off = unavailable(k, B.level);
      return `<button class="cb-li${used ? ' used' : ''}${off ? ' off' : ''}" ${off ? 'disabled' : 'draggable="true"'} data-k="${k}" title="${off ? 'Needs the Full data level' : used ? 'Already on the canvas' : 'Drag onto the canvas, or click to add'}"><b>${d.name}</b><span>${d.hint}</span></button>`;
    }).join('') + '<h4>Blocks</h4>' + `<button class="cb-li" draggable="true" data-k="text"><b>${CAT.text.name}</b><span>${CAT.text.hint}</span></button>` +
      '<p class="cb-note">Drag a chart onto the canvas. Move it by the ⋮⋮ grip, resize from the corner. Charts use your current filters, so what you see is what the client sees.</p>';
  }
  function paintBuilder(relay) {
    sync(B.grid, st.edit);
    $('cbCount').textContent = st.items.filter(i => i.k !== 'text').length + ' charts';
    paintLib();
    if (relay) relayout();
  }
  function buildPage() {
    if (page) return;
    page = document.createElement('div'); page.id = 'cbPage';
    page.innerHTML = `<div class="cb-top"><b>Customized dashboard</b><small id="cbCount"></small><span class="cb-sp"></span>
        <button class="btn ghost" id="cbUndo">Undo</button><button class="btn ghost" id="cbClear">Clear canvas</button><button class="btn ghost" id="cbExample">Load example</button>
        <button class="btn ghost" id="cbPrev">Preview as client</button><button class="btn ghost" id="cbCancel">Cancel</button><button class="btn pri" id="cbSave">Save and go back</button></div>
      <div class="cb-filters" id="cbFilters"></div>
      <div class="cb-body"><aside class="cb-lib" id="cbLib"></aside><div class="cb-canvas" id="cbCanvas"><div class="cu-grid edit" id="cbGrid"></div></div></div>
      <div class="cb-hint" id="cbHint"></div>`;
    document.body.appendChild(page);
    const grid = $('cbGrid');
    $('cbLib').addEventListener('dragstart', e => { const b = e.target.closest('.cb-li'); if (!b) return; dragKey = b.dataset.k; e.dataTransfer.setData('text/plain', dragKey); e.dataTransfer.effectAllowed = 'copy'; });
    $('cbLib').addEventListener('click', e => { const b = e.target.closest('.cb-li'); if (b && !b.disabled) addWidget(b.dataset.k); });
    grid.addEventListener('dragover', e => { if (!dragKey) return; e.preventDefault(); const d = CAT[dragKey], p = cellAt(grid, e.clientX, e.clientY); showGhost(grid, Math.max(0, Math.min(COLS - d.def[0], p.c)), Math.max(1, p.r), d.def[0], d.def[1]); });
    grid.addEventListener('dragleave', e => { if (!grid.contains(e.relatedTarget)) hideGhost(); });
    grid.addEventListener('drop', e => { if (!dragKey) return; e.preventDefault(); hideGhost(); const d = CAT[dragKey], p = cellAt(grid, e.clientX, e.clientY); addWidget(dragKey, Math.max(0, Math.min(COLS - d.def[0], p.c)), Math.max(1, p.r)); dragKey = null; });
    document.addEventListener('dragend', () => { dragKey = null; hideGhost(); });
    grid.addEventListener('pointerdown', e => {
      if (!st.edit) return;
      const gr = e.target.closest('[data-grab]'), rs = e.target.closest('[data-rs]');
      if (!gr && !rs) return;
      const id = +(gr || rs).dataset[gr ? 'grab' : 'rs'], it = st.items.find(i => i.id === id); if (!it) return;
      e.preventDefault(); st.sel = id; pushHist();
      const p = cellAt(grid, e.clientX, e.clientY);
      op = { type: gr ? 'move' : 'size', it, dc: p.c - it.c, dr: p.r - it.r, w0: it.w, h0: it.h, p0: p, nc: it.c, nr: it.r, nw: it.w, nh: it.h };
      const cell = cells.get(id); if (cell) cell.classList.add('drag');
      try { grid.setPointerCapture(e.pointerId); } catch (x) { /* fine */ }
    });
    grid.addEventListener('pointermove', e => {
      if (!op) return;
      const p = cellAt(grid, e.clientX, e.clientY), def = catOf(op.it);
      if (op.type === 'move') { op.nc = Math.max(0, Math.min(COLS - op.it.w, p.c - op.dc)); op.nr = Math.max(1, p.r - op.dr); showGhost(grid, op.nc, op.nr, op.it.w, op.it.h); }
      else { op.nw = Math.max(def.min[0], Math.min(COLS - op.it.c, op.w0 + (p.c - op.p0.c))); op.nh = Math.max(def.min[1], Math.min(40, op.h0 + (p.r - op.p0.r))); showGhost(grid, op.it.c, op.it.r, op.nw, op.nh); }
    });
    const endOp = () => {
      if (!op) return; hideGhost();
      const it = op.it, cell = cells.get(it.id); if (cell) cell.classList.remove('drag');
      if (op.type === 'move') { it.c = op.nc; it.r = op.nr; } else { it.w = op.nw; it.h = op.nh; }
      settle(it); op = null; paintBuilder(true);
    };
    grid.addEventListener('pointerup', endOp); grid.addEventListener('pointercancel', endOp);
    grid.addEventListener('click', e => {
      if (!st.edit) return;
      const x = e.target.closest('[data-x]'), c = e.target.closest('.cu-cell');
      if (x) { pushHist(); const id = +x.dataset.x; readText(st.items.find(i => i.id === id) || {}); st.items = st.items.filter(i => i.id !== id); if (st.sel === id) st.sel = null; paintBuilder(true); return; }
      const id = c ? +c.dataset.id : null;
      if (id !== st.sel) { st.sel = id; paintBuilder(false); }
    });
    $('cbUndo').addEventListener('click', () => { if (!st.hist.length) return; st.items = JSON.parse(st.hist.pop()); st.sel = null; textNodes.clear(); resetCells(); paintBuilder(true); });
    $('cbClear').addEventListener('click', () => { pushHist(); st.items.forEach(readText); st.items = []; st.sel = null; paintBuilder(true); });
    $('cbExample').addEventListener('click', () => { pushHist(); st.items.forEach(readText); st.items = EXAMPLE.filter(e => !unavailable(e[0], B.level)).map(e => ({ id: st.next++, k: e[0], c: e[1], r: e[2], w: e[3], h: e[4], t: e[0] === 'text' ? { h: 'Maliban leads the category', b: 'Add your key message for the client here.' } : undefined })); st.sel = null; resetCells(); paintBuilder(true); });
    $('cbPrev').addEventListener('click', () => { st.edit = !st.edit; st.sel = null; page.classList.toggle('previewing', !st.edit); $('cbPrev').textContent = st.edit ? 'Preview as client' : 'Back to editing'; resetCells(); paintBuilder(true); });
    $('cbSave').addEventListener('click', () => finish(true));
    $('cbCancel').addEventListener('click', () => finish(false));
  }
  function resetCells() { // rebuild the cells (after undo, example or a mode change); the cards go back to the hold first
    cells.forEach((cell, id) => { const node = cell.querySelector(':scope > .card'); if (node && !textNodes.has(id) && !node.classList.contains('cu-text')) hold().appendChild(node); cell.remove(); });
    cells.clear(); textNodes.clear();
  }
  function finish(save) {
    if (!B) return;
    st.items.forEach(readText);
    const layout = save ? exportLayout(B.filters) : null;
    const cb = B.onDone, was = B;
    resetCells(); restoreAll(); relayout();
    document.body.classList.remove('cb-open'); page.classList.remove('on', 'previewing'); B = null; st.edit = false;
    if (cb) cb(save ? layout : null, was);
  }
  // open({ layout, level, filters, onDone(layout|null) })
  function openBuilder(opts) {
    if (!O.spot || !O.spot.hasData()) { O.toast('Load a data file first'); return; }
    buildPage();
    B = { onDone: opts.onDone, level: opts.level || 'standard', filters: opts.filters || {}, grid: $('cbGrid') };
    load(opts.layout && opts.layout.items && opts.layout.items.length ? opts.layout : null);
    if (!st.items.length) st.items = EXAMPLE.filter(e => !unavailable(e[0], B.level)).slice(1).map(e => ({ id: st.next++, k: e[0], c: e[1], r: e[2] - 2, w: e[3], h: e[4] }));
    st.items = st.items.filter(i => !unavailable(i.k, B.level));
    st.edit = true; st.sel = null; resetCells();
    $('cbPrev').textContent = 'Preview as client';
    document.body.classList.add('cb-open'); page.classList.add('on');
    const chips = [...document.querySelectorAll('#chips .chip')].filter(c => c.id !== 'busyChip').map(c => `<span class="fpill">${O.esc(c.textContent.trim())}</span>`).join('');
    $('cbFilters').innerHTML = `<span>Filters used by every chart:</span>${chips}<span class="cb-fn">Change them in the main dashboard before you design.</span>`;
    $('cbHint').textContent = 'Grid: 12 columns. Charts snap to it and keep a smallest size so labels stay readable.';
    paintBuilder(false);
    requestAnimationFrame(() => requestAnimationFrame(relayout));
  }

  // ---------- the client's view ----------
  function hideFilter(el) { if (!el) return; el.classList.add('cu-hide'); const p = el.previousElementSibling; if (p && p.classList.contains('flabel')) p.classList.add('cu-hide'); }
  function lockFilters(f) {
    f = f || {};
    if (f.period === 0) { hideFilter(document.querySelector('.dateRow')); hideFilter($('fYearType')); }
    if (f.adv === 0) { const s = $('mineList') && $('mineList').closest('.sec'); if (s) s.classList.add('cu-hide'); }
    if (f.medium === 0) { hideFilter($('fMedium')); hideFilter($('fChannel')); }
    if (f.slot === 0) hideFilter($('fSlotWrap'));
    if (f.adType === 0) hideFilter($('fAdType'));
    if (f.tag === 0) { const l = $('fTagCommercial') && $('fTagCommercial').closest('label'); if (l) { l.classList.add('cu-hide'); const h = l.nextElementSibling; if (h && h.classList.contains('hint')) h.classList.add('cu-hide'); } }
  }
  function enterClient(layout) {
    if (!layout || !layout.items || !layout.items.length) return;
    load(layout); st.edit = false; st.level = 'client';
    let v = $('viewCustom');
    if (!v) { v = document.createElement('div'); v.className = 'view'; v.id = 'viewCustom'; v.innerHTML = '<div class="cu-scroll"><div class="cu-grid ro" id="cuClientGrid"></div></div>'; $('viewSpot').parentNode.insertBefore(v, $('viewCat')); }
    document.body.classList.add('custom-client');
    B = null;
    sync($('cuClientGrid'), false);
    lockFilters(layout.filters);
    // cards that the data level cannot fill (for example Duration mix below Full) leave no empty hole
    cells.forEach(cell => { const n = cell.querySelector(':scope > .card'); if (n && n.style.display === 'none') cell.style.display = 'none'; });
    requestAnimationFrame(() => requestAnimationFrame(relayout));
    window.addEventListener('resize', () => requestAnimationFrame(relayout));
  }

  window.CUSTOM = { openBuilder, enterClient, WIDGETS: CAT };
})();
