'use strict';
// Category dashboard: a second file (Month, Product Group, Mother Brand, Advertiser, Brand, Tv/Radio/Press 000Rs)
// shown as mother brand cards. Shares the data engine, the drawer look and the sign-in with the spot log dashboard.
(function () {
  const O = window.ORBIT;
  const $ = id => document.getElementById(id);
  const { engine, esc, nf, toast } = O;
  const MON = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
  const COLORS = ['#A0104F', '#D6262B', '#2F6FD3', '#1E8E4E', '#13998F', '#7B4FA0', '#2F5A9E', '#C2410C', '#B84A93', '#0A3EA6', '#5B6B2F', '#8A5A2B', '#1A7F8E', '#9C27B0', '#455A64'];
  const US = '#FF8A3D';
  const CHART_COLORS = ['#F5B400', '#C81D1D', '#1E88E5', '#7B3FA0', '#1FA55A', '#E91E63', '#111111', '#00ACC1'];
  const MED = ['TV', 'Radio', 'Press'], MED_COL = ['#2F5DBF', '#FF8A3D', '#1FA97A'];

  let overview = null, options = { advertisers: [], subs: [] }, data = null, pendingFile = null, started = false, busy = false;
  const state = { from: '', to: '', pg: '', sub: '', mine: [], comps: [], top: 10, yearType: 'CY' };
  const ui = { labels: true, part: 'm', hideInc: false };   // chart: value labels, months / quarters / halves / years, hide incomplete
  const ci = { part: 'y', hideInc: false, subsOn: new Set(), subKey: '' };   // category investment section
  const hiddenBrands = new Set();               // brands switched off in the chart legend

  // ---------- month helpers ----------
  const idx = key => { const [y, m] = key.split('-').map(Number); return y * 12 + m - 1; };
  const keyOf = i => `${Math.floor(i / 12)}-${String((i % 12) + 1).padStart(2, '0')}`;
  const yy = n => String(n).slice(-2);
  const monLabel = key => `${MON[idx(key) % 12]}-${yy(Math.floor(idx(key) / 12))}`;
  // Names a month range the way people say it: Q1'26/27, H2'25, FY 25/26, CY 2025, or Jan'22–Mar'22.
  function periodLabel(a, b, yt) {
    const m0 = idx(a), m1 = idx(b), len = m1 - m0 + 1, fy = yt === 'FY', shift = fy ? 3 : 0;
    const off = (((m0 - shift) % 12) + 12) % 12, yr = Math.floor((m0 - shift) / 12);
    const suffix = fy ? `${yy(yr)}/${yy(yr + 1)}` : yy(yr);
    if (len === 12 && off === 0) return fy ? `FY ${suffix}` : `CY ${yr}`;
    if (len === 6 && off % 6 === 0) return `H${off / 6 + 1}'${suffix}`;
    if (len === 3 && off % 3 === 0) return `Q${off / 3 + 1}'${suffix}`;
    const one = i => `${MON[i % 12]}'${yy(Math.floor(i / 12))}`;
    return len === 1 ? one(m0) : `${one(m0)}–${one(m1)}`;
  }
  // Every whole quarter / half / year the data covers for the chosen year type, newest first.
  function periodsAvailable() {
    const minI = idx(overview.minMonth), maxI = idx(overview.maxMonth), shift = state.yearType === 'FY' ? 3 : 0;
    const out = { q: [], h: [], y: [] };
    for (const [k, len] of [['q', 3], ['h', 6], ['y', 12]]) {
      let start = minI + ((((shift - minI) % len) + len) % len);   // first month that begins a period
      for (; start + len - 1 <= maxI; start += len) out[k].push([keyOf(start), keyOf(start + len - 1)]);
      out[k].reverse();
    }
    return out;
  }
  // The latest whole quarter / half / year (falls back to everything if the data is shorter).
  function latest(len) {
    const list = periodsAvailable()[{ 3: 'q', 6: 'h', 12: 'y' }[len]];
    return list.length ? list[0] : [overview.minMonth, overview.maxMonth];
  }
  function buildQuick() {
    if (!overview) return;
    const P = periodsAvailable(), yt = state.yearType;
    const opt = ([a, b]) => `<option value="${a}|${b}">${esc(periodLabel(a, b, yt))} · ${monLabel(a)} to ${monLabel(b)}</option>`;
    $('cQuick').innerHTML = '<option value="">Custom (use the month boxes)</option>'
      + (P.q.length ? `<optgroup label="Quarters">${P.q.map(opt).join('')}</optgroup>` : '')
      + (P.h.length ? `<optgroup label="Half years">${P.h.map(opt).join('')}</optgroup>` : '')
      + (P.y.length ? `<optgroup label="Full years">${P.y.map(opt).join('')}</optgroup>` : '');
    syncQuick();
  }
  function syncQuick() {
    const want = `${state.from}|${state.to}`;
    const q = $('cQuick');
    q.value = [...q.options].some(o => o.value === want) ? want : '';
  }

  // ---------- formatting (spend is in thousand rupees) ----------
  const mnNum = v => { const x = v / 1000; return nf(x, Math.abs(x) >= 10 ? 0 : 1); };
  const mnTxt = v => `${mnNum(v)} Mn`;
  const initials = name => name.split(/[^A-Za-z0-9]+/).filter(Boolean).slice(0, 2).map(w => w[0].toUpperCase()).join('') || '?';

  // ---------- persistence ----------
  // A client opening a shared link (body.share-mode) keeps filters for this tab only, starting from the agency's view.
  const CLIENT = document.body.classList.contains('share-mode');
  const KEY = CLIENT ? 'share-cat-filters-' + location.pathname.split('/').pop() : 'cas-cat-filters', MODE = 'orbit-mode';
  const store = CLIENT ? sessionStorage : localStorage;
  const save = () => { try { store.setItem(KEY, JSON.stringify(state)); } catch (e) { /* storage unavailable */ } };
  // A shared link (#cat=...) carries the filters and the view, never the data. It opens view-only: the filters
  // cannot be changed, everything else can be clicked. (The person opening it loads the same file in Data file.)
  let shared = null, sharedApplied = false;
  try { if (location.hash.startsWith('#cat=')) shared = JSON.parse(decodeURIComponent(location.hash.slice(5))); } catch (e) { shared = null; }
  const readSaved = () => {
    if (shared && shared.state) return shared.state;
    try { const mine = JSON.parse(store.getItem(KEY) || 'null'); if (mine) return mine; } catch (e) { /* none yet */ }
    return CLIENT ? (O.shareCatState || null) : null;
  };

  // ---------- data file tab ----------
  function renderFile(ds) {
    $('cDfile').innerHTML = ds ? `<div class="dfile"><b title="${esc(ds.fileName)}">${esc(ds.fileName)}</b>
      <div class="row"><span>${nf(ds.rows)} rows</span><span>${ds.size ? nf(ds.size / 1048576, 1) + ' MB' : ''}</span></div>
      <div class="row"><span>${monLabel(ds.minMonth)} to ${monLabel(ds.maxMonth)}</span></div>
      <div class="row"><span>Loaded ${new Date(ds.uploadedAt).toLocaleString()}</span></div>
      <div class="row"><span>${ds.derived ? 'Built from your main file and the Brand Map' : 'Saved in this browser only'}</span></div>
      ${ds.skipped ? `<div class="row"><span>${nf(ds.skipped)} rows skipped (invalid month)</span></div>` : ''}</div>`
      : '<div class="dfile" style="color:#6E7A99">No category data yet. Load your main data file (Spot Log) and it is built from that.</div>';
    $('cDeleteBtn').disabled = !ds;
    $('catDataDot').style.display = ds ? 'none' : '';
  }
  const status = (text, err) => { const s = $('cUstatus'); s.textContent = text; s.className = 'ustatus' + (err ? ' err' : ''); };
  function progress(pct) {
    const p = $('cProg');
    if (pct == null) { p.style.display = 'none'; return; }
    p.style.display = 'block';
    $('cProgBar').style.width = pct + '%';
  }
  function pick(f) {
    if (!f) return;
    if (!/\.(xlsx|xlsm|csv)$/i.test(f.name)) { status('Please choose an .xlsx or .csv file', true); return; }
    pendingFile = f;
    $('cDropText').textContent = `${f.name} (${nf(f.size / 1048576, 1)} MB)`;
    $('cUploadBtn').disabled = false;
    status('Ready. The file is read on this computer and replaces your current category data.');
  }
  $('cFileInput').addEventListener('change', e => pick(e.target.files[0]));
  const drop = $('cDrop');
  ['dragenter', 'dragover'].forEach(ev => drop.addEventListener(ev, e => { e.preventDefault(); drop.classList.add('over'); }));
  ['dragleave', 'drop'].forEach(ev => drop.addEventListener(ev, e => { e.preventDefault(); drop.classList.remove('over'); }));
  drop.addEventListener('drop', e => pick(e.dataTransfer.files[0]));
  $('cUploadBtn').addEventListener('click', async () => {
    if (!pendingFile) return;
    const file = pendingFile;
    $('cUploadBtn').disabled = true; $('cDeleteBtn').disabled = true;
    progress(0); status(`Reading ${file.name} on this computer…`);
    try {
      const r = await engine.call('catIngest', { file }, p => {
        const pct = Math.round(p.pct * 100);
        progress(pct);
        status(p.saving ? `Saving ${nf(p.rows)} rows in this browser…` : `Reading ${file.name}: ${pct}% · ${nf(p.rows)} rows`);
      });
      pendingFile = null; $('cFileInput').value = '';
      $('cDropText').textContent = 'Drop .xlsx or .csv here, or click to choose';
      renderFile(r.dataset);
      status(`Loaded ${nf(r.dataset.rows)} rows.` + (r.saved ? '' : ' It could not be saved in this browser, so it will be gone after you close the tab.'), !r.saved);
      await loadOverview(true);
    } catch (e) {
      status('Could not read the file: ' + e.message, true);
      $('cUploadBtn').disabled = !pendingFile;
    } finally { progress(null); $('cDeleteBtn').disabled = !overview; }
  });
  $('cDeleteBtn').addEventListener('click', async () => {
    if (!confirm('Remove your category file from this browser?')) return;
    try {
      await engine.call('catClear');
      overview = null; data = null;
      renderFile(null); status('Category data removed from this browser.');
      showEmpty();
    } catch (e) { status(e.message, true); }
  });
  document.querySelectorAll('.ctab').forEach(t => t.addEventListener('click', () => showPane(t.dataset.pane)));
  function showPane(id) {
    document.querySelectorAll('.ctab').forEach(t => t.classList.toggle('on', t.dataset.pane === id));
    document.querySelectorAll('.cpane').forEach(p => p.classList.toggle('on', p.id === id));
    $('cDfoot').style.display = id === 'cpFilters' ? '' : 'none';
  }

  // ---------- filters ----------
  function showEmpty() {
    $('catOvTitle').textContent = 'Load your category file';
    const ro = document.body.classList.contains('ro-cat');
    $('catOvText').textContent = ro ? 'This is a shared view. Open Data file and choose the same category file to see it with the shared filters. The file is read on this computer only.' : 'Open the filter drawer, choose Data file and pick your category file (Month, Product Group, Mother Brand, Advertiser, Brand, Tv / Radio / Press in 000Rs). It is read on this computer only.';
    $('catOverlay').querySelector('label').textContent = ro ? '☰ Load data file' : '☰ Open Filters';
    $('catOverlay').classList.add('on');
    $('viewCat').classList.add('nodata');
    for (const id of ['catTitle', 'catSub', 'catTot', 'catTotLabel', 'catTitle2', 'catSub2', 'catTitle3', 'catSub3', 'catTitle0', 'catSub0']) $(id).textContent = '';
    $('ciFront').innerHTML = ''; $('ciBack').innerHTML = ''; $('catCiNotes').innerHTML = ''; $('catMixC').innerHTML = '';
    $('catGrid').innerHTML = ''; $('catLegend').innerHTML = ''; $('catChart').innerHTML = ''; $('catSubs').innerHTML = '';
    $('catCiFlip').hidden = true; $('catBrFlip').hidden = true;
    $('catPeriodText').textContent = 'No data'; $('catPeriodLen').textContent = '0 months'; $('catChips').innerHTML = '';
    showPane('cpData');
  }
  function monthOptions() {
    const byYear = new Map();
    overview.months.forEach(k => { const y = k.slice(0, 4); if (!byYear.has(y)) byYear.set(y, []); byYear.get(y).push(k); });
    const html = [...byYear].map(([y, ks]) => `<optgroup label="${y}">${ks.map(k => `<option value="${k}">${monLabel(k)}</option>`).join('')}</optgroup>`).join('');
    $('cFrom').innerHTML = html; $('cTo').innerHTML = html;
  }
  async function loadOverview(fresh) {
    overview = await engine.call('catOverview');
    const useShared = !!(shared && shared.state && !sharedApplied);
    const saved = (fresh && !useShared) ? null : readSaved();
    monthOptions();
    $('cPg').innerHTML = overview.productGroups.map(g => `<option>${esc(g.name)}</option>`).join('');
    const groups = overview.productGroups.map(g => g.name);
    if (saved && groups.includes(saved.pg)) Object.assign(state, { sub: '', top: 10, yearType: 'CY' }, saved);
    else Object.assign(state, { pg: groups[0], sub: '', mine: [], comps: [], top: 10 });
    // Keep dates inside the data; a new file starts on its latest quarter.
    const inside = k => k && k >= overview.minMonth && k <= overview.maxMonth;
    if (!(inside(state.from) && inside(state.to) && state.from <= state.to) || (fresh && !useShared)) { [state.from, state.to] = latest(3); }
    if (useShared) {
      sharedApplied = true;
      const u = shared.ui || {};
      if (u.part) ui.part = u.part;
      if (u.ciPart) ci.part = u.ciPart;
      ci.hideInc = !!u.hideInc;
      setSlide(!!u.slide, true);
    }
    await loadOptions((fresh && !useShared) || !(saved && saved.mine && saved.mine.length));
    $('cSubWrap').style.display = overview.hasSub ? '' : 'none';
    writeForm();
    await refresh();
  }
  async function loadOptions(reset) {
    options = await engine.call('catOptions', { pg: state.pg, sub: state.sub });
    const names = options.advertisers.map(a => a.name);
    if (reset) { state.mine = names.slice(0, 1); state.comps = []; }
    else { state.mine = state.mine.filter(n => names.includes(n)); state.comps = state.comps.filter(n => names.includes(n) && !state.mine.includes(n)); }
    if (state.sub && !options.subs.some(s => s.name === state.sub)) state.sub = '';
  }
  function renderSubSelect() {
    $('cSub').innerHTML = '<option value="">All sub categories</option>' + options.subs.map(s => `<option value="${esc(s.name)}">${esc(s.name)}</option>`).join('');
    $('cSub').value = state.sub || '';
  }
  function writeForm() {
    $('cFrom').value = state.from; $('cTo').value = state.to; $('cPg').value = state.pg;
    renderSubSelect(); buildQuick();
    [...$('cYearType').children].forEach(b => b.classList.toggle('on', b.dataset.v === state.yearType));
    [...$('cTop').children].forEach(b => b.classList.toggle('on', Number(b.dataset.v) === Number(state.top)));
    renderLists();
  }
  function renderLists() {
    const qm = $('cMineSearch').value.trim().toLowerCase(), qc = $('cCompSearch').value.trim().toLowerCase();
    const row = (a, kind) => {
      const checked = (kind === 'mine' ? state.mine : state.comps).includes(a.name);
      const pill = checked ? (kind === 'mine' ? '<span class="pill">MINE</span>' : '<span class="pillc">SEL</span>') : '';
      return `<label class="opt" title="${esc(a.name)} · Rs ${nf(a.spend / 1000, 1)} Mn"><input type="checkbox" data-kind="${kind}" value="${esc(a.name)}" ${checked ? 'checked' : ''}><span class="nm">${esc(a.name)}</span>${pill}</label>`;
    };
    const order = (list, sel) => list.slice().sort((x, y) => (sel.includes(y.name) - sel.includes(x.name)));
    const mine = order(options.advertisers.filter(a => !state.comps.includes(a.name) && (!qm || a.name.toLowerCase().includes(qm))), state.mine);
    const comps = order(options.advertisers.filter(a => !state.mine.includes(a.name) && (!qc || a.name.toLowerCase().includes(qc))), state.comps);
    $('cMineCnt').textContent = state.mine.length ? `${state.mine.length} selected` : '';
    $('cCompCnt').textContent = state.comps.length ? `${state.comps.length} selected` : '';
    $('cMineList').innerHTML = mine.map(a => row(a, 'mine')).join('') || '<div class="empty-note">No advertisers</div>';
    $('cCompList').innerHTML = comps.map(a => row(a, 'comp')).join('') || '<div class="empty-note">No advertisers</div>';
  }
  const onList = e => {
    const c = e.target.closest('input[type=checkbox]');
    if (!c) return;
    const list = c.dataset.kind === 'mine' ? state.mine : state.comps;
    const i = list.indexOf(c.value);
    if (c.checked && i < 0) list.push(c.value); else if (!c.checked && i >= 0) list.splice(i, 1);
    renderLists();
  };
  $('cMineList').addEventListener('change', onList); $('cCompList').addEventListener('change', onList);
  $('cMineSearch').addEventListener('input', renderLists); $('cCompSearch').addEventListener('input', renderLists);
  $('cFrom').addEventListener('change', e => { state.from = e.target.value; if (state.from > state.to) { state.to = state.from; $('cTo').value = state.to; } syncQuick(); });
  $('cTo').addEventListener('change', e => { state.to = e.target.value; if (state.from > state.to) { state.from = state.to; $('cFrom').value = state.from; } syncQuick(); });
  $('cPg').addEventListener('change', async e => { state.pg = e.target.value; state.sub = ''; await loadOptions(true); writeForm(); });
  $('cSub').addEventListener('change', async e => { state.sub = e.target.value; await loadOptions(false); writeForm(); });
  $('cQuick').addEventListener('change', e => {
    if (!e.target.value) return;
    [state.from, state.to] = e.target.value.split('|');
    $('cFrom').value = state.from; $('cTo').value = state.to;
  });
  $('cYearType').addEventListener('click', e => {
    const b = e.target.closest('.seg');
    if (!b) return;
    state.yearType = b.dataset.v === 'FY' ? 'FY' : 'CY';
    [...$('cYearType').children].forEach(x => x.classList.toggle('on', x === b));
    buildQuick(); save(); if (data) render();   // only the period names change, so no recalculation
  });
  $('cTop').addEventListener('click', e => {
    const b = e.target.closest('.seg');
    if (!b) return;
    state.top = Number(b.dataset.v);
    [...$('cTop').children].forEach(x => x.classList.toggle('on', x === b));
  });
  $('cResetBtn').addEventListener('click', async () => {
    if (!overview) return;
    Object.assign(state, { sub: '', top: 10 });
    [state.from, state.to] = latest(3);
    $('cMineSearch').value = ''; $('cCompSearch').value = '';
    await loadOptions(true); writeForm();
  });
  $('cApplyBtn').addEventListener('click', () => refresh());

  // ---------- dashboard ----------
  async function refresh() {
    if (!overview) return;
    save();
    document.body.classList.add('loading');
    try {
      data = await engine.call('catDashboard', JSON.parse(JSON.stringify(state)));
      $('catOverlay').classList.remove('on');
      $('viewCat').classList.remove('nodata');
      render();
      if (!state.mine.length) toast('Tip: pick your advertiser under Filters to highlight your brands');
    } catch (e) { toast(e.message); } finally { document.body.classList.remove('loading'); }
  }
  // Editable headlines (for writing the insight on a slide): a remembered edit wins over the computed text.
  const SUB_COLORS = ['#F24B4B', '#8ED63D', '#1CC5D6', '#F5B400', '#7B3FA0', '#1E88E5', '#E91E63', '#455A64'];
  const textKey = (id, pg) => `orbit-cat-text:${id}:${pg}`;
  const savedText = (id, pg) => { try { return localStorage.getItem(textKey(id, pg)); } catch (e) { return null; } };
  function heading(el, id, fallback) {
    el.dataset.key = id;
    if (document.activeElement !== el) el.textContent = (data && savedText(id, data.filters.pg)) || fallback;
  }
  document.addEventListener('focusout', e => {
    const el = e.target;
    if (!data || !el.classList || !el.classList.contains('cedit')) return;
    const t = el.textContent.trim();
    try { if (t) localStorage.setItem(textKey(el.dataset.key, data.filters.pg), t); else localStorage.removeItem(textKey(el.dataset.key, data.filters.pg)); } catch (err) { /* storage unavailable */ }
  });
  document.addEventListener('keydown', e => { if (e.key === 'Enter' && e.target.classList && e.target.classList.contains('cedit')) { e.preventDefault(); e.target.blur(); } });
  const labelsOf = d => { const R = d.ranges, yt = state.yearType; return { cur: periodLabel(R.cur[0], R.cur[1], yt), yoy: periodLabel(R.yoy[0], R.yoy[1], yt), prev: periodLabel(R.prev[0], R.prev[1], yt) }; };

  function render() {
    const d = data, yt = state.yearType, R = d.ranges;
    const { cur, yoy, prev } = labelsOf(d);
    const f = d.filters;
    heading($('catTitle'), 's1', `Leading ${f.pg} Brands by Investment`);
    const topN = f.top === 0 ? null : Math.min(f.top, d.brandCount);
    const scope = (f.comps && f.comps.length) ? `${d.shown} mother brands (mine and selected competitors)` : topN == null ? `All ${d.brandCount} mother brands` : `Top ${topN} mother brands`;
    $('catSub').textContent = `${scope} ranked by ${cur} investment${f.sub ? ' · ' + f.sub : ''} | Investment in Rs. Mn`;
    $('catTotLabel').textContent = `${cur} TOTAL`;
    $('catTot').textContent = mnTxt(d.total.cur);
    $('catPeriodText').textContent = `${monLabel(R.cur[0])} → ${monLabel(R.cur[1])}`;
    $('catPeriodLen').textContent = `${R.months} month${R.months === 1 ? '' : 's'}`;
    const chips = [`<span class="chip">${esc(f.pg)}</span>`];
    if (f.sub) chips.push(`<span class="chip">${esc(f.sub)}</span>`);
    if (f.mine && f.mine.length) chips.push(`<span class="chip o">Mine: ${esc(f.mine.length === 1 ? f.mine[0] : f.mine.length + ' advertisers')}</span>`);
    if (f.comps && f.comps.length) chips.push(`<span class="chip">${f.comps.length} competitor${f.comps.length === 1 ? '' : 's'}</span>`);
    chips.push(`<span class="chip">${yt === 'FY' ? 'Financial year (Apr–Mar)' : 'Calendar year'}</span>`);
    if (document.body.classList.contains('ro-cat')) chips.push('<span class="chip o">View only<button type="button" class="unlock" id="catUnlock">Edit</button></span>');
    $('catChips').innerHTML = chips.join('');
    renderCi(d);
    renderChart(d, cur);
    renderSubs(d, { cur, yoy, prev });
    if (!d.cards.length) { $('catGrid').innerHTML = '<div class="nodata2">No spend found for these filters.</div>'; renderLegend(cur, yoy, prev); return; }
    const colors = brandColors(d.cards);
    $('catGrid').innerHTML = d.cards.map((c, i) => {
      const color = colors.get(c.name);
      const g = c.growth;
      const gcls = g == null ? 'flat' : g > 0.5 ? 'up' : g < -0.5 ? 'down' : 'flat';
      const garrow = g == null ? '' : g > 0.5 ? '▲ ' : g < -0.5 ? '▼ ' : '■ ';
      const gtxt = g == null ? '—' : `${garrow}${nf(g, 0)}%`;
      const box = v => (v == null || v <= 0 ? '–' : mnNum(v));
      const medTot = c.medium[0] + c.medium[1] + c.medium[2];
      const tip = `${c.name}${c.mine ? ' (mine)' : ''}\nRank #${c.rank} of ${d.brandCount} · ${cur} ${mnTxt(c.cur)}\nTV ${nf(medTot ? (c.medium[0] / medTot) * 100 : 0, 0)}% · Radio ${nf(medTot ? (c.medium[1] / medTot) * 100 : 0, 0)}% · Press ${nf(medTot ? (c.medium[2] / medTot) * 100 : 0, 0)}%\nClick for details`;
      return `<div class="ccard${c.mine ? ' us' : ''}" style="--c:${color};--i:${i}" data-mb="${esc(c.name)}" data-tip="${esc(tip)}">
        <div class="cc-h"><div class="cc-av">${esc(initials(c.name))}</div><div class="cc-n" title="${esc(c.name)}">${esc(c.name)}</div></div>
        <div class="cc-m"><div><div class="cc-l">${esc(cur)}</div><div class="cc-v">${mnTxt(c.cur)}</div></div>
          <div class="cc-g"><div class="cc-l">Y-o-Y growth</div><div class="cc-gv ${gcls}">${gtxt}</div></div></div>
        <div class="cc-b"><div data-per="yoy" data-label="${esc(yoy)}" data-tip="${esc(`Same period last year: ${yoy}\nClick for details`)}"><i>Last year</i><span>${esc(yoy)}</span><b>${box(c.yoy)}</b></div><div data-per="prev" data-label="${esc(prev)}" data-tip="${esc(`Previous period: ${prev}\nClick for details`)}"><i>Previous</i><span>${esc(prev)}</span><b>${box(c.prev)}</b></div></div>
        <div class="cc-f"><div class="cc-s"><span>${esc(cur)} share</span><b>${nf(c.share, 0)}%</b></div>
        <div class="cc-bar"><i style="width:${Math.max(c.share > 0 ? 2 : 0, Math.min(100, c.share))}%"></i></div>
        <div class="cc-med">${c.medium.map((v, k) => `<i data-med="${k}" data-tip="${esc(`${MED[k]}: ${mnTxt(v)} (${nf(medTot ? (v / medTot) * 100 : 0, 0)}%)\nClick for details`)}" style="width:${medTot ? (v / medTot) * 100 : 0}%;background:${MED_COL[k]}"></i>`).join('')}</div></div>
      </div>`;
    }).join('');
    renderLegend(cur, yoy, prev);
    $('catGrid').scrollLeft = 0;
    requestAnimationFrame(updateStrip);
  }

  // The same colour for a mother brand on its card and in the chart; ours are orange.
  function brandColors(cards) {
    const m = new Map();
    let ci = 0;
    cards.forEach(c => m.set(c.name, c.mine ? US : COLORS[ci++ % COLORS.length]));
    return m;
  }
  // The cards are one row, left to right, whatever the count. There is no scroll bar: arrows, dragging and the
  // wheel / trackpad move it, and a fade shows there are more.
  function updateStrip() {
    const g = $('catGrid'), wrap = g.parentNode, max = g.scrollWidth - g.clientWidth - 2;
    const l = g.scrollLeft > 4, r = g.scrollLeft < max;
    wrap.classList.toggle('more-l', l); wrap.classList.toggle('more-r', r);
    $('csPrev').hidden = !l; $('csNext').hidden = !r;
  }
  const sizeGrid = updateStrip;
  (function wireStrip() {
    const g = $('catGrid');
    let frame = 0, down = false, startX = 0, startLeft = 0, moved = false;
    g.addEventListener('scroll', () => { cancelAnimationFrame(frame); frame = requestAnimationFrame(updateStrip); });
    $('csPrev').addEventListener('click', () => g.scrollBy({ left: -Math.max(240, g.clientWidth * 0.8), behavior: 'smooth' }));
    $('csNext').addEventListener('click', () => g.scrollBy({ left: Math.max(240, g.clientWidth * 0.8), behavior: 'smooth' }));
    g.addEventListener('wheel', e => {
      if (g.scrollWidth <= g.clientWidth + 2) return;
      const d = Math.abs(e.deltaX) > Math.abs(e.deltaY) ? e.deltaX : e.deltaY;
      g.scrollLeft += d; e.preventDefault();
    }, { passive: false });
    g.addEventListener('mousedown', e => { if (e.button) return; down = true; moved = false; startX = e.clientX; startLeft = g.scrollLeft; });
    window.addEventListener('mousemove', e => {
      if (!down) return;
      const dx = e.clientX - startX;
      if (Math.abs(dx) > 5) { moved = true; g.classList.add('drag'); }
      if (moved) g.scrollLeft = startLeft - dx;
    });
    window.addEventListener('mouseup', () => { if (down) { down = false; g.classList.remove('drag'); } });
    g.addEventListener('click', e => { if (moved) { e.stopImmediatePropagation(); e.preventDefault(); moved = false; } }, true);
  })();
  window.addEventListener('resize', () => { if (data && document.body.classList.contains('mode-cat')) { updateStrip(); renderChart(data, null); renderCi(data); } });

  // ---------- Category behaviour, month by month ----------
  // Big green bars: the whole category each month (left axis). Small bars: the mother brands (right axis, own scale).
  const niceMax = v => { if (v <= 0) return 1; const p = Math.pow(10, Math.floor(Math.log10(v))), m = v / p; return (m <= 1 ? 1 : m <= 2 ? 2 : m <= 2.5 ? 2.5 : m <= 5 ? 5 : 10) * p; };
  function chartPool(d) {
    const pool = d.cards.filter(c => c.mine).concat(d.cards.filter(c => !c.mine)).slice(0, 8).sort((a, b) => b.cur - a.cur);
    return { pool, colors: new Map(pool.map((c, i) => [c.name, CHART_COLORS[i % CHART_COLORS.length]])) };
  }

  // Quarters / half years / years of the chosen year type built from a list of month keys.
  function periodize(months, part) {
    const L = { q: 3, h: 6, y: 12 }[part], yt = state.yearType, shift = yt === 'FY' ? 3 : 0;
    const first = idx(months[0]), last = idx(months[months.length - 1]), groups = new Map();
    months.forEach((k, i) => {
      const g = Math.floor((idx(k) - shift) / L) * L + shift;
      if (!groups.has(g)) groups.set(g, { g, idxs: [] });
      groups.get(g).idxs.push(i);
    });
    return [...groups.values()].sort((x, y) => x.g - y.g).map(G => {
      const a = keyOf(G.g), b = keyOf(G.g + L - 1), label = periodLabel(a, b, yt);
      return { ...G, label, from: months[G.idxs[0]], to: months[G.idxs[G.idxs.length - 1]], tipLabel: `${label} (${monLabel(a)} to ${monLabel(b)})`, complete: G.g >= first && G.g + L - 1 <= last };
    });
  }
  const PART_NAME = { m: 'Month-On-Month', q: 'Quarter-On-Quarter', h: 'Half-On-Half', y: 'Year-On-Year' };
  const PART_ADJ = { m: 'Monthly', q: 'Quarterly', h: 'Half-yearly', y: 'Yearly' };
  // The periods the chart shows: months (the selected ones plus earlier months, about 15 in all), or quarters, half
  // years or years of the chosen year type, built from the monthly history. Brands with no spend in any shown
  // period are left out, and so is any zero value.
  function chartData(d) {
    const M = d.monthly, n = M.months.length, part = ui.part, yt = state.yearType;
    const { pool: pool0, colors } = chartPool(d);
    let periods = [];
    if (part === 'm') {
      const len = n - M.selStart, start = Math.max(0, M.selStart - Math.max(0, 15 - len));
      for (let i = start; i < n; i++) periods.push({ label: monLabel(M.months[i]).replace('-', " '"), from: M.months[i], to: M.months[i], tipLabel: monLabel(M.months[i]), complete: true, inSel: i >= M.selStart, cat: M.cat[i], vals: pool0.map(c => c.monthly[i]) });
    } else {
      periods = periodize(M.months, part).map(G => {
        const vals = pool0.map(c => G.idxs.reduce((a, i) => a + c.monthly[i], 0));
        return { label: G.label, from: G.from, to: G.to, tipLabel: G.tipLabel, complete: G.complete, inSel: false, cat: G.idxs.reduce((a, i) => a + M.cat[i], 0), vals };
      });
      if (ui.hideInc) periods = periods.filter(p => p.complete);
    }
    const keep = pool0.map((c, j) => periods.some(p => p.vals[j] > 0));
    const pool = pool0.filter((c, j) => keep[j]);
    periods.forEach(p => { p.vals = p.vals.filter((v, j) => keep[j]); });
    return { part, periods, pool, colors, hiddenCount: pool0.length - pool.length };
  }
  function renderChart(d, curLabel) {
    const host = $('catChart');
    if (!curLabel) curLabel = labelsOf(d).cur;
    const CD = chartData(d), { periods, pool, colors, part } = CD, n = periods.length;
    const M = d.monthly;
    heading($('catTitle2'), 's2', `${PART_ADJ[part]} ${d.filters.pg} Investment by Brand`);
    const incomplete = periods.filter(p => !p.complete).length;
    $('catSub2').textContent = n
      ? `Category total against ${pool.length} mother brand${pool.length === 1 ? '' : 's'} · ${periods[0].label} to ${periods[n - 1].label}${part === 'm' ? `, selected period ${curLabel} shaded` : incomplete ? `, ${incomplete} incomplete period${incomplete === 1 ? '' : 's'} hatched` : ''} | Investment in Rs. Mn`
      : 'No complete periods in this range';
    [...$('catPartTgl').children].forEach(b => b.classList.toggle('on', b.dataset.v === part));
    $('catPartTgl').querySelector('[data-v=y]').textContent = state.yearType === 'FY' ? 'Years (FY)' : 'Years';
    host.innerHTML = `<div class="cch-t">Category Behaviour – ${PART_NAME[part]}</div><div class="cch-box" id="cchBox"></div><div class="cch-lg" id="cchLg"></div>`;
    $('cchLg').innerHTML = pool.map(c => `<span class="lg2${hiddenBrands.has(c.name) ? ' off' : ''}" data-b="${esc(c.name)}" title="Click to show or hide"><i style="background:${colors.get(c.name)}"></i>${c.mine ? '★ ' : ''}${esc(c.name)}</span>`).join('')
      + `<span class="lg2" style="cursor:default"><i style="background:linear-gradient(#8BC34A,#E6F4D4)"></i>Category total</span>`
      + `<label class="opt2"><input type="checkbox" id="cchLabels" ${ui.labels ? 'checked' : ''}>Value labels</label>`
      + (part === 'm' ? '' : `<label class="opt2"><input type="checkbox" id="cchHide" ${ui.hideInc ? 'checked' : ''}>Hide incomplete periods</label>`);
    const box = $('cchBox'), W = Math.max(300, box.clientWidth), H = Math.max(110, box.clientHeight);
    if (!d.cards.length || !n) { box.innerHTML = `<div class="nodata2">${d.cards.length ? 'No complete periods here. Untick “Hide incomplete periods” or widen the dates.' : 'No spend found for these filters.'}</div>`; return; }
    const two = false, L = 58, R = 58, T = 26, B = part !== 'm' && incomplete ? 40 : 28, X0 = L, X1 = W - R, Y0 = H - B;
    const idxOf = new Map(pool.map((c, j) => [c.name, j]));
    const shown = pool.filter(c => !hiddenBrands.has(c.name));
    // One scale for the category and the brands, so a brand can never look bigger than the category it belongs to.
    const maxCat = niceMax(Math.max(0, ...periods.map(p => p.cat), ...periods.flatMap(p => shown.map(c => p.vals[idxOf.get(c.name)]))) / 1000), maxBr = maxCat;
    const yc = v => Y0 - (v / 1000 / maxCat) * (Y0 - T), yb = yc;
    const gw = (X1 - X0) / n, catW = Math.min(gw * 0.86, 130);
    // Only brands with spend get a bar, so a period with fewer brands is not left with gaps.
    const maxCount = Math.max(1, ...periods.map(p => shown.filter(c => p.vals[idxOf.get(c.name)] > 0).length));
    const bw = Math.min(18, (gw * 0.8) / maxCount);
    const grid = [0, 1, 2, 3, 4].map(i => {
      const yy = Y0 - (i * (Y0 - T)) / 4;
      return `<line x1="${X0}" x2="${X1}" y1="${yy}" y2="${yy}" stroke="#EEF1F7"></line>`
        + `<text x="${X0 - 8}" y="${yy + 4}" text-anchor="end" font-size="11" font-weight="700" fill="#1A1F36">${nf((maxCat * i) / 4, maxCat < 4 ? 1 : 0)}</text>`
        + `<text x="${X1 + 8}" y="${yy + 4}" text-anchor="start" font-size="11" font-weight="700" fill="#1A1F36">${nf((maxBr * i) / 4, maxBr < 4 ? 1 : 0)}</text>`;
    }).join('');
    const axisTitle = x => (Y0 - T < 110 ? '' : `<text transform="translate(${x},${(T + Y0) / 2}) rotate(-90)" text-anchor="middle" font-size="11" font-weight="700" fill="#1A1F36">Investments in (Rs. in Mn)</text>`);
    const selFirst = periods.findIndex(p => p.inSel);
    const band = part === 'm' && selFirst >= 0 ? `<rect x="${X0 + gw * selFirst}" y="${T - 8}" width="${gw * (n - selFirst)}" height="${Y0 - T + 8}" fill="#FF8A3D" fill-opacity="0.07"></rect>`
      + (selFirst > 0 ? `<text x="${X0 + gw * selFirst + 6}" y="${T - 12}" font-size="10" font-weight="800" fill="#E4702A">SELECTED PERIOD · ${esc(curLabel)}</text>` : '') : '';
    let cats = '', brands = '', labels = '', hatch = '';
    const showLabels = ui.labels;
    periods.forEach((p, i) => {
      const cx = X0 + gw * (i + 0.5), note = p.complete ? '' : '\nIncomplete period';
      const v = p.cat, top = yc(v);
      if (v > 0) {
        cats += `<rect x="${cx - catW / 2}" y="${top}" width="${catW}" height="${Math.max(0, Y0 - top)}" fill="url(#cchGreen)" data-scope="${esc(JSON.stringify({ all: true, from: p.from, to: p.to, label: p.label }))}" data-tip="${esc(`Category · ${p.tipLabel}\nRs ${nf(v / 1000, 0)} Mn${note}`)}"></rect>`;
        if (!p.complete) hatch += `<rect x="${cx - catW / 2}" y="${top}" width="${catW}" height="${Math.max(0, Y0 - top)}" fill="url(#cchHatch)" pointer-events="none"></rect>`;
        if (showLabels) { const t = nf(v / 1000, 0), w = t.length * 7 + 10; labels += `<rect x="${cx - w / 2}" y="${top - 18}" width="${w}" height="16" rx="3" fill="#8BD051"></rect><text x="${cx}" y="${top - 6}" text-anchor="middle" font-size="11" font-weight="800" fill="#111">${t}</text>`; }
      }
      const here = shown.filter(c => p.vals[idxOf.get(c.name)] > 0), groupW = here.length * bw;
      here.forEach((c, j) => {
        const bv = p.vals[idxOf.get(c.name)], bx = cx - groupW / 2 + j * bw, by = yb(bv), col = colors.get(c.name);
        brands += `<rect x="${bx}" y="${by}" width="${bw - 1}" height="${Math.max(0, Y0 - by)}" fill="${col}" data-scope="${esc(JSON.stringify({ mb: c.name, from: p.from, to: p.to, label: p.label }))}" data-tip="${esc(`${c.name}${c.mine ? ' (mine)' : ''} · ${p.tipLabel}\nRs ${nf(bv / 1000, 0)} Mn${note}`)}"></rect>`;
        if (!p.complete) hatch += `<rect x="${bx}" y="${by}" width="${bw - 1}" height="${Math.max(0, Y0 - by)}" fill="url(#cchHatch)" pointer-events="none"></rect>`;
        if (showLabels && bw >= 8) { const t = nf(bv / 1000, 0), w = t.length * 6 + 8; labels += `<rect x="${bx + (bw - 1) / 2 - w / 2}" y="${by - 15}" width="${w}" height="14" rx="3" fill="${col}"></rect><text x="${bx + (bw - 1) / 2}" y="${by - 4.5}" text-anchor="middle" font-size="9.5" font-weight="800" fill="#fff">${t}</text>`; }
      });
    });
    const every = Math.ceil(n / Math.max(4, Math.floor((X1 - X0) / (part === 'm' ? 62 : 74))));
    const xl = periods.map((p, i) => (i % every === 0 || i === n - 1 ? `<text x="${X0 + gw * (i + 0.5)}" y="${Y0 + 17}" data-scope="${esc(JSON.stringify({ all: true, from: p.from, to: p.to, label: p.label }))}" text-anchor="middle" font-size="11" font-weight="700" fill="#1A1F36">${esc(p.label)}</text>${p.complete ? '' : `<text x="${X0 + gw * (i + 0.5)}" y="${Y0 + 30}" text-anchor="middle" font-size="9" font-weight="800" fill="#E4702A">Incomplete</text>`}` : '')).join('');
    box.innerHTML = `<svg width="${W}" height="${H}" viewBox="0 0 ${W} ${H}"><defs><linearGradient id="cchGreen" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="#8BC34A" stop-opacity=".95"></stop><stop offset="1" stop-color="#E9F5D8" stop-opacity=".35"></stop></linearGradient><pattern id="cchHatch" width="6" height="6" patternUnits="userSpaceOnUse" patternTransform="rotate(45)"><line x1="0" y1="0" x2="0" y2="6" stroke="#fff" stroke-opacity=".6" stroke-width="2"></line></pattern></defs>${grid}${axisTitle(14)}${axisTitle(W - 12)}${band}${cats}${brands}${hatch}${labels}<line x1="${X0}" x2="${X1}" y1="${Y0}" y2="${Y0}" stroke="#C7CEDF"></line>${xl}</svg>`;
    void two; void M;
  }
  $('catPartTgl').addEventListener('click', e => {
    const b = e.target.closest('button[data-v]');
    if (!b || !data) return;
    ui.part = b.dataset.v;
    renderChart(data, null);
  });
  document.addEventListener('click', e => {
    const lg = e.target.closest('#cchLg .lg2[data-b]');
    if (lg && data) { const b = lg.dataset.b; if (hiddenBrands.has(b)) hiddenBrands.delete(b); else hiddenBrands.add(b); renderChart(data, null); return; }
    if (e.target.id === 'cchLabels' && data) { ui.labels = e.target.checked; renderChart(data, null); }
    if (e.target.id === 'cchHide' && data) { ui.hideInc = e.target.checked; renderChart(data, null); }
  });
  function renderLegend(cur, yoy, prev) {
    $('catLegend').innerHTML = `
      <div class="li"><span class="sw" style="background:#2F6FD3"></span><div><b>Investment amount</b><small>${esc(yoy)}, ${esc(prev)} and ${esc(cur)} (Rs. Mn)</small></div></div>
      <div class="li"><span class="sw" style="background:#1E8E4E"></span><div><b>Y-o-Y growth</b><small>${esc(cur)} versus ${esc(yoy)}</small></div></div>
      <div class="li"><span class="sw" style="background:#7B4FA0"></span><div><b>Share of investment</b><small>Share of total ${esc(cur)} investment</small></div></div>
      <div class="mdots">${MED.map((m, k) => `<span><i style="background:${MED_COL[k]}"></i>${m}</span>`).join('')}</div>`;
  }

  // ---------- sub categories: mix, contribution and mother brand tables ----------
  const tabLabel = l => l.replace("'", ' ');                       // Q1'25/26 -> Q1 25/26 in table headers
  const pctCell = g => (g == null ? '' : `<span class="${g > 0.5 ? 'pos' : g < -0.5 ? 'neg' : 'flat'}">${nf(g, 0)}%</span>`);
  const numCell = v => (v == null || v <= 0 ? '–' : mnNum(v));
  function subsHeadline(d, L) {
    const net = d.net;
    if (d.contribution && net) {
      const top = d.contribution.slice().sort((a, b) => b.part - a.part)[0];
      return net < 0 ? `${top.name} Pullback Drives the ${L.cur} ${d.filters.pg} Decline` : `${top.name} Growth Drives the ${L.cur} ${d.filters.pg} Increase`;
    }
    return d.hasSubs ? `${d.filters.pg} Investment by Sub Category in ${L.cur}` : `${d.filters.pg} Investment by Mother Brand in ${L.cur}`;
  }
  function mixTitle(d) {
    const m = d.mix;
    if (!m || !m.yoy) return 'Sub category mix';
    let best = -1, gain = 0;
    d.tables.forEach((t, i) => { const g = m.cur[i] - m.yoy[i]; if (g > gain) { gain = g; best = i; } });
    return best >= 0 && gain >= 1 ? `The mix is shifting toward ${d.tables[best].name}` : 'The sub category mix is broadly stable';
  }
  function contribTitle(d) {
    const top = d.contribution.slice().sort((a, b) => b.part - a.part)[0];
    return `${top.name} contributed ~${nf(Math.max(0, top.part), 0)}% of the net YoY ${d.net < 0 ? 'reduction' : 'increase'}`;
  }
  function tableHtml(t, color, d, L, single) {
    const nm = single ? String(d.filters.pg).toUpperCase() : (t.none ? 'UNASSIGNED' : t.name.toUpperCase());
    const title = `${esc(nm)}${t.growth == null ? '' : ' | ' + nf(t.growth, 0) + '% YoY'}`;
    const scope = single ? { all: true } : { sub: t.name };
    const sa = single ? '' : ` data-sub="${esc(t.name)}"`;
    const cells = (r, tot) => `<td class="c1" data-per="yoy">${numCell(r.yoy)}</td><td class="c2" data-per="prev">${numCell(r.prev)}</td><td class="c3" data-per="cur">${numCell(r.cur)}</td><td>${pctCell(r.growth)}</td><td>${tot ? '' : (r.cur > 0 ? nf(r.share, 0) + '%' : '')}</td>`;
    const rows = t.rows.map(r => {
      const who = r.others ? ` data-others="${esc(JSON.stringify(r.names || []))}" data-title="${esc(r.name)}"` : ` data-mb="${esc(r.name)}"`;
      return `<tr class="${r.mine ? 'mine ' : ''}${r.others ? 'oth ' : ''}link"${sa}${who}><td title="${esc(r.name)}">${esc(r.name)}</td>${cells(r, false)}</tr>`;
    }).join('');
    return `<div class="tblock"><div class="ttl link" data-scope="${esc(JSON.stringify(scope))}" title="Click for details"><i style="background:${color}"></i><span>${title}</span></div>
      <table class="ctab2"><tr><th>Brand</th><th>${esc(tabLabel(L.yoy))}</th><th>${esc(tabLabel(L.prev))}</th><th>${esc(tabLabel(L.cur))}</th><th>YoY</th><th>Shr.</th></tr>${rows}
      <tr class="tot link"${sa}><td>${esc(nm)}</td>${cells(t, true)}</tr></table></div>`;
  }
  // The slice a table row or cell stands for: the row's mother brand (inside its sub category), or the folded Others,
  // or the sub category total; a period column narrows it to that period.
  function tableScope(el) {
    const tr = el.closest('tr');
    if (!tr) return null;
    const sc = {};
    if (tr.dataset.sub) sc.sub = tr.dataset.sub;
    if (tr.dataset.others) { try { sc.mbs = JSON.parse(tr.dataset.others); } catch (err) { sc.mbs = []; } sc.title = tr.dataset.title; }
    else if (tr.dataset.mb) sc.mb = tr.dataset.mb;
    else if (!tr.dataset.sub) sc.all = true;
    const per = el.closest('td[data-per]');
    if (per) { const r = data.ranges[per.dataset.per]; sc.from = r[0]; sc.to = r[1]; sc.label = labelsOf(data)[per.dataset.per]; }
    return sc;
  }
  function renderSubs(d, L) {
    const T = d.tables, f = d.filters;
    heading($('catTitle3'), 's3', subsHeadline(d, L));
    $('catSub3').textContent = d.hasSubs && T.length > 1
      ? `Sub categories of ${f.pg} · ${L.cur} against ${L.yoy} and ${L.prev} | Investment in Rs. Mn`
      : `Mother brands in ${f.sub || f.pg} · ${L.cur} against ${L.yoy} and ${L.prev} | Investment in Rs. Mn`;
    const host = $('catSubs');
    if (!T.length) { host.innerHTML = '<div class="nodata2">No spend found for these filters.</div>'; $('catMixC').innerHTML = ''; $('catBrFlip').hidden = true; if (flips.br) setFlip('br', false, true); return; }
    const colors = T.map((t, i) => SUB_COLORS[i % SUB_COLORS.length]);
    const multi = d.hasSubs && T.length > 1;
    $('catBrFlip').hidden = !multi;
    if (!multi) { host.innerHTML = tableHtml(T[0], T[0] && '#F24B4B', d, L, !d.hasSubs); $('catMixC').innerHTML = ''; if (flips.br) setFlip('br', false, true); return; }
    // Mix of sub categories in each period (100% bars).
    let mix = '';
    if (d.mix && d.mix.yoy) {
      const rows = [[L.yoy, d.mix.yoy, false, 'yoy'], d.mix.prev ? [L.prev, d.mix.prev, false, 'prev'] : null, [L.cur, d.mix.cur, true, 'cur']].filter(Boolean);
      mix = `<div class="mixblock"><div class="cblock-t cedit" id="catMixT" contenteditable="true" spellcheck="false" data-key="mix"></div>
        ${rows.map(([lab, arr, now, key]) => `<div class="mixrow${now ? ' now' : ''}"><span class="lab">${esc(lab)}</span><div class="mixbar">${arr.map((p, i) => (p > 0 ? `<i class="link" data-scope="${esc(JSON.stringify({ sub: T[i].name, from: d.ranges[key][0], to: d.ranges[key][1], label: lab }))}" style="width:${p}%;background:${colors[i]}" title="${esc(T[i].name)} ${nf(p, 1)}%">${p >= 4 ? nf(p, 0) + '%' : ''}</i>` : '')).join('')}</div></div>`).join('')}
        <div class="mixlg">${T.map((t, i) => `<span><i style="background:${colors[i]}"></i>${esc(t.name)}</span>`).join('')}</div></div>`;
    }
    let contrib = '';
    if (d.contribution) {
      contrib = `<div class="contblock"><div class="cblock-t cedit" id="catContT" contenteditable="true" spellcheck="false" data-key="contrib"></div>
        ${d.contribution.map((c, i) => `<div class="controw link" data-scope="${esc(JSON.stringify({ sub: c.name }))}"><i style="background:${colors[i]}"></i><b>${esc(c.name)}</b><span class="mv">${mnNum(c.yoy)} → ${mnNum(c.cur)}</span><span class="gv ${c.growth == null ? 'flat' : c.growth > 0.5 ? 'pos' : c.growth < -0.5 ? 'neg' : 'flat'}">${c.growth == null ? '—' : nf(c.growth, 0) + '%'}</span></div>`).join('')}
        <div class="contfoot"><span></span><span></span><span class="fl"><u>${esc(L.yoy)}</u><u>${esc(L.cur)}</u></span><u>Y-O-Y</u></div></div>`;
    }
    host.innerHTML = T.map((t, i) => tableHtml(t, colors[i], d, L, false)).join('');
    $('catMixC').innerHTML = mix + contrib;
    if (mix) heading($('catMixT'), 'mix', mixTitle(d));
    if (contrib) heading($('catContT'), 'contrib', contribTitle(d));
  }
  $('catSubs').addEventListener('click', e => {
    if (e.target.closest('.cedit')) return;
    const ttl = e.target.closest('.ttl[data-scope]');
    if (ttl) { try { openDetail(JSON.parse(ttl.dataset.scope)); } catch (err) { /* bad scope */ } return; }
    const sc = tableScope(e.target);
    if (sc) openDetail(sc);
  });

  // The small tab on the left card slides between Category investment and Monthly investment by brand.
  let slideM = false;
  function setSlide(m, instant) {
    slideM = m;
    const sl = $('catSlider'), tab = $('catSlide');
    if (instant) sl.style.transition = 'none';
    sl.classList.toggle('m', m);
    if (instant) { void sl.offsetWidth; sl.style.transition = ''; }
    tab.classList.toggle('on', m);
    tab.setAttribute('aria-pressed', String(m));
    tab.querySelector('.st-arrow').textContent = m ? '‹' : '›';
    tab.querySelector('.st-text').textContent = m ? 'Category investment' : 'Monthly by brand';
    tab.setAttribute('aria-label', m ? 'Show the category investment chart' : 'Show the monthly investment by brand chart');
  }
  $('catSlide').addEventListener('click', () => setSlide(!slideM));

  // Card flips: the panel turns edge-on, swaps faces, and turns back (no lasting 3D, so exports capture cleanly).
  const flips = { ci: false, br: false };
  function setFlip(which, back, instant) {
    const box = $(which === 'ci' ? 'catCiBox' : 'catBrBox'), btn = $(which === 'ci' ? 'catCiFlip' : 'catBrFlip');
    flips[which] = back;
    const labels = which === 'ci' ? ['Sub categories', 'Category total'] : ['Mix & contribution', 'Mother brands'];
    btn.querySelector('span').textContent = back ? labels[1] : labels[0];
    const apply = () => box.classList.toggle('back', back);
    if (instant || (window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches)) { apply(); return; }
    box.classList.add('out');
    setTimeout(() => { apply(); box.classList.remove('out'); box.classList.add('in'); setTimeout(() => box.classList.remove('in'), 300); }, 220);
  }
  $('catCiFlip').addEventListener('click', () => setFlip('ci', !flips.ci));
  $('catBrFlip').addEventListener('click', () => setFlip('br', !flips.br));

  // ---------- category investment: stacked by medium, and the sub categories ----------
  const MED_HEX = ['0070C0', 'E8484B', '111111'];
  const SUBC = ['E91E8C', '8ED63D', 'F5A300', '7B3FA0', '1E88E5', '00ACC1', '455A64', 'C2410C'];
  const SUBC_TXT = { E91E8C: 'FFFFFF', '8ED63D': '111111', F5A300: '111111', '7B3FA0': 'FFFFFF', '1E88E5': 'FFFFFF', '00ACC1': 'FFFFFF', '455A64': 'FFFFFF', C2410C: 'FFFFFF' };
  function ciData(d) {
    const H = d.history, M = d.monthly, part = ci.part, lag = { y: 1, h: 2, q: 4 }[part];
    const sumOf = (arr, idxs) => idxs.reduce((a, i) => a + arr[i], 0);
    let all = periodize(M.months, part).map(G => {
      const tv = sumOf(H.tv, G.idxs), radio = sumOf(H.radio, G.idxs), press = sumOf(H.press, G.idxs);
      return { label: G.label, from: G.from, to: G.to, tipLabel: G.tipLabel, complete: G.complete, tv, radio, press, total: tv + radio + press, subs: H.subs.map(x => sumOf(x.values, G.idxs)) };
    });
    // Growth on the same period a year earlier, only between two complete periods.
    all.forEach((p, i) => {
      const q = all[i - lag], g = (cur, prev) => (p.complete && q && q.complete && prev > 0 ? ((cur - prev) / prev) * 100 : null);
      p.growth = g(p.total, q && q.total); p.subGrowth = p.subs.map((v, k) => g(v, q && q.subs[k]));
    });
    const periods = ci.hideInc ? all.filter(p => p.complete) : all;
    const names = H.subs.map(x => x.name);
    const key = d.filters.pg + '|' + d.filters.sub + '|' + names.join(',');
    if (ci.subKey !== key) { ci.subKey = key; ci.subsOn = new Set(d.tables.filter(t => names.includes(t.name)).slice(0, 2).map(t => t.name)); }
    return { part, periods, names };
  }
  const niceMaxV = v => niceMax(Math.max(1, v));
  // Charts are described as simple shapes (rect / text / line / arrow) in a W x H box, so the screen (SVG) and the
  // PowerPoint draw exactly the same picture.
  const pscope = (p, extra) => ({ all: true, from: p.from, to: p.to, label: p.label, ...extra });
  function ciAxes(P, W, H, T, max, left, right, yAxisTitle) {
    const Y0 = H - 34, y = v => Y0 - (v / max) * (Y0 - T);
    const plotH = Y0 - T, steps = plotH >= 170 ? 4 : plotH >= 100 ? 2 : 1;
    for (let i = 0; i <= steps; i++) {
      const v = (max * i) / steps, yy = Y0 - (i * (Y0 - T)) / steps, txt = nf(v / 1000, max / 1000 < 4 ? 1 : 0).replace(/^0$/, '–');
      P.push({ t: 'l', x1: left, y1: yy, x2: W - right, y2: yy, color: 'EEF1F7', lw: 1 });
      P.push({ t: 't', x: left - 6, y: yy + 4, text: txt, size: 11, color: '4A5570', anchor: 'end' });
      if (right > 20) P.push({ t: 't', x: W - right + 6, y: yy + 4, text: txt, size: 11, color: '4A5570', anchor: 'start' });
    }
    if (plotH >= 90) {
      P.push({ t: 't', x: 12, y: (T + Y0) / 2, text: yAxisTitle, size: 11, color: '4A5570', anchor: 'middle', rot: -90 });
      if (right > 20) P.push({ t: 't', x: W - 10, y: (T + Y0) / 2, text: yAxisTitle, size: 11, color: '4A5570', anchor: 'middle', rot: -90 });
    }
    return { Y0, y };
  }
  function ciXLabels(P, periods, X0, gw, Y0) {
    const every = Math.ceil(periods.length / Math.max(3, Math.floor((gw * periods.length) / 70)));
    periods.forEach((p, i) => {
      const cx = X0 + gw * (i + 0.5);
      if (i % every && i !== periods.length - 1) return;
      P.push({ t: 't', x: cx, y: Y0 + 17, text: p.label, size: gw < 60 ? 10 : 12, bold: true, color: '1A1F36', anchor: 'middle', scope: pscope(p) });
      if (!p.complete) P.push({ t: 't', x: cx, y: Y0 + 30, text: 'Incomplete', size: 9, bold: true, color: 'E4702A', anchor: 'middle' });
    });
  }
  function ciLeft(CD, W, H) {
    const P = [], per = CD.periods, n = per.length, L = 74, R = 12, X0 = L, X1 = W - R, gw = (X1 - X0) / n;
    const compact = H < 250, maxT = niceMaxV(Math.max(0, ...per.map(p => p.total))), T = compact ? 66 : 92;
    const { Y0, y } = ciAxes(P, W, H, T, maxT, L, 0, 'Investment (Rs. In Mn)');
    // Totals above the bars: a quiet caption and one pill per period.
    P.push({ t: 't', x: 6, y: 25, text: 'Total, Rs Mn', size: 11, bold: true, color: '6B7590', anchor: 'start' });
    per.forEach((p, i) => {
      const cx = X0 + gw * (i + 0.5), bw = Math.min(74, gw * 0.62), pw = Math.min(gw * 0.74, 104);
      P.push({ t: 'r', x: cx - pw / 2, y: 6, w: pw, h: 28, fill: 'E3F0FB', rx: 14, scope: pscope(p) });
      P.push({ t: 't', x: cx, y: 25, text: nf(p.total / 1000, 0), size: gw < 70 ? 12 : 16, bold: true, color: '14568F', anchor: 'middle', scope: pscope(p) });
      let acc = 0;
      [p.tv, p.radio, p.press].forEach((v, k) => {
        if (v <= 0) return;
        const y1 = y(acc), y2 = y(acc + v); acc += v;
        const pct = p.total ? (v / p.total) * 100 : 0;
        P.push({ t: 'r', x: cx - bw / 2, y: y2, w: bw, h: y1 - y2, fill: MED_HEX[k], scope: pscope(p, { medium: MED[k] }), tip: `${p.tipLabel}\\n${MED[k]}: Rs ${nf(v / 1000, 0)} Mn · ${nf(pct, 1)}%` + (p.complete ? '' : '\\nIncomplete period') });
        if (pct >= 4 && y1 - y2 >= 15) P.push({ t: 't', x: cx, y: y2 + (y1 - y2) / 2 + 4, text: `${nf(pct, 0)}%`, size: gw < 70 ? 10 : 12, bold: true, color: 'FFFFFF', anchor: 'middle' });
        else if (!compact && pct >= 0.5 && k > 0) P.push({ t: 't', x: cx, y: y2 - 3, text: `${nf(pct, 0)}%`, size: 10, bold: true, color: '1A1F36', anchor: 'middle' });
      });
      const top = y(p.total);
      if (!p.complete) P.push({ t: 'r', x: cx - bw / 2, y: top, w: bw, h: Y0 - top, hatch: true });
      if (p.growth != null) {
        const up = p.growth >= 0;
        P.push({ t: 't', x: cx, y: top - (compact ? 22 : 36), text: `${up ? '' : '-'}${nf(Math.abs(p.growth), 0)}%`, size: compact || gw < 70 ? 12 : 15, bold: true, color: up ? '2E7D32' : 'E5242B', anchor: 'middle' });
        P.push({ t: 'a', x: cx, y: top - (compact ? 19 : 31), w: compact ? 14 : 20, h: compact ? 16 : 26, dir: up ? 'up' : 'down', fill: up ? '2E7D32' : 'E5484D' });
      }
    });
    P.push({ t: 'l', x1: X0, y1: Y0, x2: X1, y2: Y0, color: 'C7CEDF', lw: 1 });
    ciXLabels(P, per, X0, gw, Y0);
    return P;
  }
  function ciRight(CD, W, H, names) {
    const P = [], per = CD.periods, n = per.length, L = 66, R = 66, X0 = L, X1 = W - R, gw = (X1 - X0) / n;
    const on = CD.names.map((nm, k) => [nm, k]).filter(([nm]) => ci.subsOn.has(nm));
    const maxT = niceMaxV(Math.max(0, ...per.map(p => p.total))), T = 40;
    const { Y0, y } = ciAxes(P, W, H, T, maxT, L, R, 'Investment (Rs. In Mn)');
    const lastIdx = (() => { for (let i = n - 1; i >= 0; i--) if (per[i].complete) return i; return -1; })();
    per.forEach((p, i) => {
      const cx = X0 + gw * (i + 0.5), cw = Math.min(110, gw * 0.76), top = y(p.total);
      if (p.total > 0) {
        P.push({ t: 'r', x: cx - cw / 2, y: top, w: cw, h: Y0 - top, fill: 'D6E9F8', grad: 'blue', scope: pscope(p), tip: `${p.tipLabel}\\nCategory: Rs ${nf(p.total / 1000, 0)} Mn` + (p.complete ? '' : '\\nIncomplete period') });
        const t = nf(p.total / 1000, 0), w = t.length * 7.5 + 12;
        P.push({ t: 'r', x: cx - w / 2, y: top - 22, w, h: 19, fill: 'CFE8FB', rx: 3, scope: pscope(p) });
        P.push({ t: 't', x: cx, y: top - 8, text: t, size: gw < 70 ? 11 : 13, bold: true, color: '1E6FB5', anchor: 'middle', scope: pscope(p) });
      }
      const k = on.filter(([, j]) => p.subs[j] > 0).length || 1, bw = Math.min(30, (cw * 0.9) / Math.max(1, on.length)), groupW = bw * k;
      let slot = 0;
      on.forEach(([nm, j]) => {
        const v = p.subs[j];
        if (v <= 0) return;
        const hex = SUBC[CD.names.indexOf(nm) % SUBC.length], bx = cx - groupW / 2 + slot * bw, by = y(v); slot++;
        P.push({ t: 'r', x: bx, y: by, w: bw - 1, h: Y0 - by, fill: hex, scope: { sub: nm, from: p.from, to: p.to, label: p.label }, tip: `${nm}\\n${p.tipLabel}\\nRs ${nf(v / 1000, 0)} Mn${p.subGrowth[j] == null ? '' : ' · ' + nf(p.subGrowth[j], 0) + '% YoY'}` });
        if (!p.complete) P.push({ t: 'r', x: bx, y: by, w: bw - 1, h: Y0 - by, hatch: true });
        const t = nf(v / 1000, 0), w = t.length * 7 + 10;
        P.push({ t: 'r', x: bx + (bw - 1) / 2 - w / 2, y: by - 20, w, h: 17, fill: hex, rx: 3, scope: { sub: nm, from: p.from, to: p.to, label: p.label } });
        P.push({ t: 't', x: bx + (bw - 1) / 2, y: by - 7, text: t, size: gw < 70 ? 10 : 12, bold: true, color: SUBC_TXT[hex] || 'FFFFFF', anchor: 'middle', scope: { sub: nm, from: p.from, to: p.to, label: p.label } });
        if (i === lastIdx && p.subGrowth[j] != null && by - y(p.total) >= 56) {
          const g = p.subGrowth[j], up = g >= 0;
          P.push({ t: 't', x: bx + (bw - 1) / 2, y: by - 50, text: `${up ? '▲' : '▼'} ${up ? '' : '-'}${nf(Math.abs(g), 0)}%`, size: 12, bold: true, color: up ? '2E7D32' : 'E5242B', anchor: 'middle' });
        }
      });
    });
    P.push({ t: 'l', x1: X0, y1: Y0, x2: X1, y2: Y0, color: 'C7CEDF', lw: 1 });
    ciXLabels(P, per, X0, gw, Y0);
    return P;
  }
  const esc2 = v => String(v).replace(/\\n/g, '\n');
  function primsToSvg(P, W, H, id) {
    const out = P.map(e => {
      const tip = (e.tip ? ` data-tip="${esc(esc2(e.tip))}"` : '') + (e.scope ? ` data-scope="${esc(JSON.stringify(e.scope))}"` : '');
      if (e.t === 'r') return `<rect x="${e.x}" y="${e.y}" width="${Math.max(0, e.w)}" height="${Math.max(0, e.h)}" rx="${e.rx || 0}" fill="${e.hatch ? `url(#${id}H)` : e.grad ? `url(#${id}G)` : '#' + e.fill}"${e.line ? ` stroke="#${e.line}" stroke-width="${e.lw || 1}"` : ''}${e.hatch ? ' pointer-events="none"' : ''}${tip}></rect>`;
      if (e.t === 'l') return `<line x1="${e.x1}" y1="${e.y1}" x2="${e.x2}" y2="${e.y2}" stroke="#${e.color}" stroke-width="${e.lw || 1}"></line>`;
      if (e.t === 'a') { const hw = e.w / 2, hh = e.h; const pts = e.dir === 'up' ? `${e.x},${e.y} ${e.x + hw},${e.y + hh * 0.5} ${e.x + hw * 0.4},${e.y + hh * 0.5} ${e.x + hw * 0.4},${e.y + hh} ${e.x - hw * 0.4},${e.y + hh} ${e.x - hw * 0.4},${e.y + hh * 0.5} ${e.x - hw},${e.y + hh * 0.5}` : `${e.x},${e.y + hh} ${e.x + hw},${e.y + hh * 0.5} ${e.x + hw * 0.4},${e.y + hh * 0.5} ${e.x + hw * 0.4},${e.y} ${e.x - hw * 0.4},${e.y} ${e.x - hw * 0.4},${e.y + hh * 0.5} ${e.x - hw},${e.y + hh * 0.5}`; return `<polygon points="${pts}" fill="#${e.fill}"></polygon>`; }
      const anchor = { start: 'start', middle: 'middle', end: 'end' }[e.anchor || 'start'];
      return `<text x="${e.x}" y="${e.y}"${e.scope ? ` data-scope="${esc(JSON.stringify(e.scope))}"` : ''} font-size="${e.size}" font-weight="${e.bold ? 800 : 600}" fill="#${e.color}" text-anchor="${anchor}"${e.rot ? ` transform="rotate(${e.rot} ${e.x} ${e.y})"` : ''}>${esc(e.text)}</text>`;
    }).join('');
    return `<svg width="${W}" height="${H}" viewBox="0 0 ${W} ${H}"><defs><linearGradient id="${id}G" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="#BFDDF4"></stop><stop offset="1" stop-color="#F2F8FD"></stop></linearGradient><pattern id="${id}H" width="6" height="6" patternUnits="userSpaceOnUse" patternTransform="rotate(45)"><line x1="0" y1="0" x2="0" y2="6" stroke="#fff" stroke-opacity=".6" stroke-width="2"></line></pattern></defs>${out}</svg>`;
  }
  // Notes under the charts, written from the numbers (editable).
  function ciNotesHtml(d, CD) {
    const f = d.filters, cp = CD.periods.filter(p => p.complete), latest = cp[cp.length - 1];
    if (!latest) return '<ul><li>No complete period in this range.</li></ul>';
    const per = { y: 'YoY', h: 'YoY', q: 'YoY' }[CD.part], pct = g => `${nf(Math.abs(g), 0)}%`;
    const lines = [];
    const li = cp.indexOf(latest);
    let run = 0;
    for (let k = li - 1; k >= 0 && cp[k].growth != null && cp[k].growth > 0; k--) run++;
    const total = `Rs. <b>${nf(latest.total / 1000, 0)} Mn</b>`;
    if (latest.growth == null) lines.push(`${esc(f.pg)} investment was ${total} in ${esc(latest.label)}.`);
    else if (latest.growth < 0) lines.push(`${run ? `After ${run} consecutive ${CD.part === 'y' ? 'years' : 'periods'} of growth, ` : ''}${esc(f.pg)} investment declined by <b>${pct(latest.growth)} ${per}</b> to ${total} in ${esc(latest.label)}.`);
    else lines.push(`${esc(f.pg)} investment grew by <b>${pct(latest.growth)} ${per}</b> to ${total} in ${esc(latest.label)}.`);
    const med = [latest.tv, latest.radio, latest.press], mi = med.indexOf(Math.max(...med)), share = latest.total ? (med[mi] / latest.total) * 100 : 0;
    const medTxt = `${MED[mi]} continued to dominate with a <b>${nf(share, 0)}% investment share</b>.`;
    if (CD.names.length) {
      const shownSubs = CD.names.map((nm, k) => ({ nm, k, v: latest.subs[k], g: latest.subGrowth[k] })).filter(x => ci.subsOn.has(x.nm) && x.v > 0).sort((a, b) => b.v - a.v);
      const hidden = CD.names.map((nm, k) => ({ nm, g: latest.subGrowth[k], v: latest.subs[k] })).filter(x => !ci.subsOn.has(x.nm) && x.v > 0 && x.g != null).sort((a, b) => Math.abs(b.g) - Math.abs(a.g))[0];
      if (shownSubs.length) {
        const top = shownSubs[0];
        let t = `Among the displayed sub-categories, <b>${esc(top.nm)}</b> remained the primary investment ${top.k >= 0 ? 'driver' : ''}${top.g == null ? '' : top.g < 0 ? ` despite declining by <b>${pct(top.g)}</b>` : ` after growing by <b>${pct(top.g)}</b>`}`;
        const rest = shownSubs.slice(1).filter(x => x.g != null).map(x => `${esc(x.nm)} ${x.g < 0 ? 'contracted' : 'expanded'} by <b>${pct(x.g)}</b>`);
        if (rest.length) t += `, while ${rest.join(' and ')}`;
        t += `. ${medTxt}`;
        if (hidden) t += ` (${esc(hidden.nm)} (not shown here) ${hidden.g >= 0 ? `experienced a ${pct(hidden.g)} increase` : `declined by ${pct(hidden.g)}`} in investments)`;
        lines.push(t);
      } else lines.push(medTxt);
    } else lines.push(medTxt);
    return `<ul>${lines.map(l => `<li>${l}</li>`).join('')}</ul>`;
  }
  const cleanHtml = html => {
    const doc = new DOMParser().parseFromString(`<body>${html}</body>`, 'text/html');
    const walk = node => [...node.childNodes].map(n => {
      if (n.nodeType === 3) return esc(n.textContent);
      const tag = n.nodeName.toLowerCase();
      if (['b', 'strong', 'i', 'em', 'ul', 'li', 'br'].includes(tag)) { const t = tag === 'strong' ? 'b' : tag === 'em' ? 'i' : tag; return t === 'br' ? '<br>' : `<${t}>${walk(n)}</${t}>`; }
      return walk(n);
    }).join('');
    return walk(doc.body);
  };
  function ciHeadline(d, CD) {
    const f = d.filters, cp = CD.periods.filter(p => p.complete), latest = cp[cp.length - 1];
    if (!latest || latest.growth == null) return `${f.pg} Investment by Year`;
    if (latest.growth < 0) {
      const peak = cp.reduce((a, p) => (p.total > a.total ? p : a), cp[0]);
      return peak !== latest ? `${f.pg} Investment Moderates After Its ${peak.label} Peak` : `${f.pg} Investment Declines in ${latest.label}`;
    }
    return `${f.pg} Investment Grows ${nf(latest.growth, 0)}% in ${latest.label}`;
  }
  function renderCi(d) {
    const CD = ciData(d), f = d.filters;
    const first = CD.periods[0], last = CD.periods[CD.periods.length - 1];
    heading($('catTitle0'), 's0', ciHeadline(d, CD));
    $('catSub0').textContent = first ? `${f.pg}${f.sub ? ' · ' + f.sub : ''} · ${first.label} to ${last.label}${CD.periods.some(p => !p.complete) ? ', incomplete periods hatched' : ''} | Investment in Rs. Mn` : 'No complete periods in this range';
    [...$('catCiTgl').children].forEach(b => b.classList.toggle('on', b.dataset.v === ci.part));
    $('catCiTgl').querySelector('[data-v=y]').textContent = state.yearType === 'FY' ? 'Years (FY)' : 'Years';
    $('catCiHide').checked = ci.hideInc;
    const hasSubs = CD.names.length > 1, front = $('ciFront'), back = $('ciBack');
    $('catCiFlip').hidden = !hasSubs || !CD.periods.length;
    if ((!hasSubs || !CD.periods.length) && flips.ci) setFlip('ci', false, true);
    if (!CD.periods.length) { front.innerHTML = '<div class="nodata2">No complete periods here. Untick “Hide incomplete” or widen the dates.</div>'; back.innerHTML = ''; $('catCiNotes').innerHTML = ''; return; }
    const medLegend = MED.map((m, k) => `<span><i style="background:#${MED_HEX[k]}"></i>${m}</span>`).join('');
    const subLegend = CD.names.map((nm, k) => `<span data-sub="${esc(nm)}" class="${ci.subsOn.has(nm) ? '' : 'off'}" title="Click to show or hide"><i style="background:#${SUBC[k % SUBC.length]}"></i>${esc(nm)}</span>`).join('') + '<span><i style="background:linear-gradient(#BFDDF4,#F2F8FD);border:1px solid #9CC3E4"></i>Category total</span>';
    front.innerHTML = `<div class="ci-box"><div class="ci-t">${esc(f.pg)} Category Investment</div><div class="ci-svg" id="ciL"></div><div class="ci-lg">${medLegend}</div></div>`;
    back.innerHTML = hasSubs ? `<div class="ci-box"><div class="ci-t">${esc(f.pg)} Sub Category Investments</div><div class="ci-svg" id="ciR"></div><div class="ci-lg">${subLegend}</div></div>` : '';
    const L = $('ciL'), lw = Math.max(300, L.clientWidth), lh = Math.max(110, L.clientHeight);
    L.innerHTML = primsToSvg(ciLeft(CD, lw, lh), lw, lh, 'ciL');
    if (hasSubs) { const R = $('ciR'), rw = Math.max(300, R.clientWidth), rh = Math.max(110, R.clientHeight); R.innerHTML = primsToSvg(ciRight(CD, rw, rh), rw, rh, 'ciR'); }
    const notes = $('catCiNotes');
    if (document.activeElement !== notes) notes.innerHTML = savedText('ci-notes', f.pg) ? cleanHtml(savedText('ci-notes', f.pg)) : ciNotesHtml(d, CD);
  }
  $('catCiNotes').addEventListener('focusout', () => {
    if (!data) return;
    const html = cleanHtml($('catCiNotes').innerHTML);
    try { if ($('catCiNotes').textContent.trim()) localStorage.setItem(textKey('ci-notes', data.filters.pg), html); else localStorage.removeItem(textKey('ci-notes', data.filters.pg)); } catch (e) { /* storage unavailable */ }
  });
  $('catCiTgl').addEventListener('click', e => { const b = e.target.closest('button[data-v]'); if (b && data) { ci.part = b.dataset.v; renderCi(data); } });
  $('catCiHide').addEventListener('change', e => { ci.hideInc = e.target.checked; if (data) renderCi(data); });
  $('catCiBox').addEventListener('click', e => {
    if (!e.target.closest('.ci-lg') && openScope(e)) return;
    const sp = e.target.closest('.ci-lg span[data-sub]');
    if (!sp || !data) return;
    const nm = sp.dataset.sub;
    if (ci.subsOn.has(nm)) ci.subsOn.delete(nm); else ci.subsOn.add(nm);
    try { localStorage.removeItem(textKey('ci-notes', data.filters.pg)); } catch (err) { /* storage unavailable */ }   // the notes follow the displayed sub categories
    renderCi(data);
  });

  // ---------- card detail ----------
  $('catGrid').addEventListener('click', e => {
    const card = e.target.closest('.ccard');
    if (!card) return;
    const base = { mb: card.dataset.mb };
    const per = e.target.closest('[data-per]'), med = e.target.closest('[data-med]');
    if (per) { const r = data.ranges[per.dataset.per]; openDetail({ ...base, from: r[0], to: r[1], label: per.dataset.label }); }
    else if (med) openDetail({ ...base, medium: MED[Number(med.dataset.med)] });
    else openDetail(base);
  });
  // The total at the top right opens the whole selection; chart bars, labels and mix segments open their own slice.
  $('catS1').addEventListener('click', e => { if (e.target.closest('.ctot')) openDetail({ all: true }); });
  const openScope = e => { const el = e.target.closest('[data-scope]'); if (!el) return false; try { openDetail(JSON.parse(el.dataset.scope)); } catch (err) { return false; } return true; };
  $('catChart').addEventListener('click', openScope);
  $('catMixC').addEventListener('click', e => { if (!e.target.closest('.cedit')) openScope(e); });
  const detailStack = [];
  let cmTab = 'ov', lastDetail = null;
  const closeModal = () => { $('catModal').classList.remove('on'); detailStack.length = 0; };
  $('catModal').addEventListener('click', e => { if (e.target.id === 'catModal' || e.target.closest('.x')) closeModal(); });
  document.addEventListener('keydown', e => { if (e.key === 'Escape') closeModal(); });
  // Drill-down. scope can combine: mb, mbs (a set), sub, adv, brand, medium, from + to (a period), or all: true.
  // Every table row, medium chip and month in the popup goes one level deeper (Back returns).
  async function openDetail(scope, push = true) {
    if (push) { detailStack.push(scope); if (detailStack.length === 1) cmTab = 'ov'; }
    $('catModalBox').innerHTML = '<div class="cm-h"><h3>Loading…</h3></div>';
    $('catModal').classList.add('on');
    try {
      const d = await engine.call('catDetail', { filters: data.filters, scope });
      const yt = state.yearType, L0 = labelsOf(data);
      const curLabel = scope.from ? (scope.label || periodLabel(d.from, d.to, yt)) : L0.cur;
      const yoyLabel = scope.from ? periodLabel(keyOf(idx(d.from) - 12), keyOf(idx(d.to) - 12), yt) : L0.yoy;
      const g = d.yoy > 0 ? ((d.cur - d.yoy) / d.yoy) * 100 : null;
      const share = d.catCur ? (d.cur / d.catCur) * 100 : 0;
      const mine = (scope.mb && (data.cards.some(c => c.name === scope.mb && c.mine) || data.tables.some(t => t.rows.some(r => r.name === scope.mb && r.mine)))) || (scope.adv && (data.filters.mine || []).includes(scope.adv));
      const medTot = d.mediumTotals[0] + d.mediumTotals[1] + d.mediumTotals[2];
      const growthCell = (c, p) => (p > 0 ? `<span class="${c >= p ? 'up' : 'down'}">${c >= p ? '▲' : '▼'} ${nf(Math.abs(((c - p) / p) * 100), 0)}%</span>` : '—');
      const pinned = { mb: !!scope.mb, adv: !!scope.adv, brand: !!scope.brand, sub: !!scope.sub };
      const table = (title, rows, dim) => (rows.length && !pinned[dim] && !(rows.length < 2 && dim === 'sub')) ? { key: dim, title, n: rows.length, html: `<div class="cm-sec"><table class="cm-t"><tr><th>Name</th><th>${esc(curLabel)}</th><th>${esc(yoyLabel)}</th><th>Growth</th><th>Share</th></tr>${rows.slice(0, 50).map(r => `<tr class="link" data-dim="${dim}" data-name="${esc(r.name)}" title="Click to go deeper"><td>${esc(r.name)}</td><td>${mnNum(r.cur)}</td><td>${r.yoy > 0 ? mnNum(r.yoy) : '–'}</td><td>${growthCell(r.cur, r.yoy)}</td><td>${nf(r.share, 0)}%</td></tr>`).join('')}</table></div>` } : null;
      const tabs = [table('Mother brands', d.mothers, 'mb'), table('Advertisers', d.advertisers, 'adv'), table('Brands', d.brands, 'brand'), table('Sub categories', d.subs, 'sub')].filter(Boolean);
      const chips = [`<span>${esc(curLabel)}</span>`];
      if (scope.sub && (scope.mb || scope.adv || scope.brand)) chips.push(`<span>${esc(scope.sub)}</span>`);
      if (scope.mb && scope.adv) chips.push(`<span>${esc(scope.adv)}</span>`);
      if (scope.brand && scope.mb) chips.push(`<span>${esc(scope.mb)}</span>`);
      if (scope.medium) chips.push(`<span>${esc(scope.medium)} only</span>`);
      chips.push(`<span>${esc(data.filters.pg)}</span>`);
      const medChips = d.mediumTotals.map((v, k) => (v > 0 ? `<button type="button" class="cm-chip${scope.medium === MED[k] ? ' on' : ''}" data-med="${MED[k]}"><i style="background:${MED_COL[k]}"></i>${MED[k]} ${nf(medTot ? (v / medTot) * 100 : 0, 0)}% · ${mnTxt(v)}</button>` : '')).join('')
        + (scope.medium ? '<button type="button" class="cm-chip" data-med="">All media</button>' : '');
      const ovHtml = `<div class="cm-sec"><h4>${d.months > 1 ? 'Month by month by medium (click a month to go deeper)' : 'By medium'}, Rs. Mn</h4>${monthlyChart(d)}
          <div style="display:flex;gap:14px;font-size:10.5px;color:#4A5570;font-weight:600;margin:2px 0 8px">${MED.map((m, k) => `<span><i style="display:inline-block;width:10px;height:10px;border-radius:3px;background:${MED_COL[k]};margin-right:4px"></i>${m} ${nf(medTot ? (d.mediumTotals[k] / medTot) * 100 : 0, 0)}%</span>`).join('')}<span style="margin-left:auto"><i style="display:inline-block;width:14px;border-top:2px dashed #8A93AD;margin-right:4px;vertical-align:3px"></i>${esc(yoyLabel)} total</span></div></div>`;
      const allTabs = [{ key: 'ov', title: 'Overview' }, ...tabs];
      if (!allTabs.some(t => t.key === cmTab)) cmTab = 'ov';
      $('catModalBox').innerHTML = `
        <div class="cm-h">${detailStack.length > 1 ? '<button type="button" class="cm-back" aria-label="Back">← Back</button>' : ''}<h3>${esc(d.name)}</h3>${mine ? '<span class="cm-tag">US</span>' : ''}<span class="cm-sub">${chips.join('')}</span><button class="x" aria-label="Close">✕</button></div>
        <div class="cm-stats">
          <div class="cm-st"><span>${esc(curLabel)}</span><b>${mnTxt(d.cur)}</b></div>
          <div class="cm-st"><span>${esc(yoyLabel)} (last year)</span><b>${d.yoy > 0 ? mnTxt(d.yoy) : '–'}</b></div>
          <div class="cm-st"><span>Y-o-Y growth</span><b style="color:${g == null ? '#9AA3BC' : g >= 0 ? '#14803F' : '#D12B2B'}">${g == null ? '—' : (g >= 0 ? '▲ ' : '▼ ') + nf(Math.abs(g), 0) + '%'}</b></div>
          <div class="cm-st"><span>Share of category${scope.medium ? ' (' + esc(scope.medium) + ')' : ''}</span><b>${nf(share, 1)}%</b></div>
        </div>
        <div class="cm-meds">${medChips}</div>
        <div class="cm-tabs">${allTabs.map(t => `<button type="button" data-cmtab="${t.key}" class="${t.key === cmTab ? 'on' : ''}">${t.title}${t.n ? ' <em>' + t.n + '</em>' : ''}</button>`).join('')}</div>
        ${cmTab === 'ov' ? ovHtml : tabs.find(t => t.key === cmTab).html}`;
    } catch (err) { $('catModalBox').innerHTML = `<div class="cm-h"><h3>Could not load</h3><button class="x">✕</button></div><div style="padding:20px">${esc(err.message)}</div>`; }
  }
  $('catModalBox').addEventListener('click', e => {
    const cur = detailStack[detailStack.length - 1];
    if (!cur) return;
    if (e.target.closest('.cm-back')) { detailStack.pop(); openDetail(detailStack[detailStack.length - 1], false); return; }
    const tb = e.target.closest('[data-cmtab]');
    if (tb) { cmTab = tb.dataset.cmtab; openDetail(cur, false); return; }
    const row = e.target.closest('tr[data-dim]');
    if (row) { cmTab = 'ov'; const next = { ...cur, [row.dataset.dim]: row.dataset.name }; delete next.title; if (row.dataset.dim === 'mb') delete next.mbs; openDetail(next); return; }
    const chip = e.target.closest('.cm-chip');
    if (chip) { const next = { ...cur }; if (chip.dataset.med) next.medium = chip.dataset.med; else delete next.medium; openDetail(next); return; }
    const mo = e.target.closest('[data-month]');
    if (mo) openDetail({ ...cur, from: mo.dataset.month, to: mo.dataset.month, label: monLabel(mo.dataset.month) });
  });
  function monthlyChart(d) {
    const W = 840, H = 190, X0 = 38, Y0 = H - 24, Y1 = 12, n = d.monthly.length;
    const tot = m => m.tv + m.radio + m.press;
    const maxV = Math.max(1, ...d.monthly.map(m => Math.max(tot(m), m.yoy)));
    const nice = (() => { const x = maxV / 1000, p = Math.pow(10, Math.floor(Math.log10(x))); const m = x / p; return (m <= 1 ? 1 : m <= 2 ? 2 : m <= 5 ? 5 : 10) * p; })();
    const y = v => Y0 - (v / 1000 / nice) * (Y0 - Y1);
    const slot = (W - X0 - 8) / n, bw = Math.min(46, slot * 0.64);
    const grid = [0, 1, 2, 3, 4].map(k => `<line x1="${X0}" x2="${W - 4}" y1="${Y0 - (k * (Y0 - Y1)) / 4}" y2="${Y0 - (k * (Y0 - Y1)) / 4}" stroke="#EEF1F7"></line><text x="${X0 - 6}" y="${Y0 - (k * (Y0 - Y1)) / 4 + 3.5}" text-anchor="end" font-size="9.5" fill="#9AA3BC">${nf((nice * k) / 4, nice < 4 ? 1 : 0)}</text>`).join('');
    const bars = d.monthly.map((m, i) => {
      const cx = X0 + slot * (i + 0.5), vals = [m.tv, m.radio, m.press];
      let acc = 0;
      const segs = vals.map((v, k) => { const y1 = y(acc), y2 = y(acc + v); acc += v; return v > 0 ? `<rect x="${cx - bw / 2}" y="${y2}" width="${bw}" height="${y1 - y2}" fill="${MED_COL[k]}"></rect>` : ''; }).join('');
      const label = n <= 14 ? `<text x="${cx}" y="${y(tot(m)) - 4}" text-anchor="middle" font-size="9.5" font-weight="700" fill="#1A1F36">${mnNum(tot(m))}</text>` : '';
      const every = Math.ceil(n / 14);
      const xl = i % every === 0 ? `<text x="${cx}" y="${H - 7}" text-anchor="middle" font-size="9.5" fill="#6B7590">${monLabel(m.key)}</text>` : '';
      const hit = n > 1 ? `<rect data-month="${m.key}" x="${cx - slot / 2}" y="${Y1}" width="${slot}" height="${Y0 - Y1 + 18}" fill="transparent" style="cursor:pointer"></rect>` : '';
      return `<g><title>${monLabel(m.key)}: ${mnTxt(tot(m))}</title>${segs}${label}${xl}${hit}</g>`;
    }).join('');
    const line = d.monthly.map((m, i) => `${i ? 'L' : 'M'}${(X0 + slot * (i + 0.5)).toFixed(1)},${y(m.yoy).toFixed(1)}`).join('');
    const hasY = d.monthly.some(m => m.yoy > 0);
    return `<svg viewBox="0 0 ${W} ${H}" style="width:100%;height:auto;display:block">${grid}${bars}${hasY ? `<path d="${line}" fill="none" stroke="#8A93AD" stroke-width="1.8" stroke-dasharray="5 4"></path>` : ''}</svg>`;
  }

  // ---------- share ----------
  document.addEventListener('click', e => {
    if (!e.target.closest('#catUnlock')) return;
    document.body.classList.remove('ro-cat');
    try { history.replaceState(null, '', location.pathname + location.search); } catch (err) { /* ignore */ }
    if (shared) shared.ro = false;
    if (data) render();
  });
  $('catShareBtn').addEventListener('click', async () => {
    const payload = { state, ro: 1, ui: { part: ui.part, ciPart: ci.part, hideInc: ci.hideInc, slide: slideM } };
    const url = location.origin + location.pathname + '#cat=' + encodeURIComponent(JSON.stringify(payload));
    try { await navigator.clipboard.writeText(url); toast('View-only link with the current filters copied'); } catch (e) { prompt('Copy this link', url); }
  });

  // ---------- export ----------
  const menu = $('catExportMenu');
  $('catExportBtn').addEventListener('click', e => { e.stopPropagation(); menu.classList.toggle('on'); });
  document.addEventListener('click', e => { if (!menu.contains(e.target)) menu.classList.remove('on'); });
  menu.addEventListener('click', e => {
    const b = e.target.closest('button[data-x]');
    if (!b) return;
    menu.classList.remove('on');
    if (!data) return toast('Nothing to export yet');
    ({ jpg: exportJpg, ppt: exportPpt })[b.dataset.x]();
  });
  const loadScript = src => new Promise((ok, fail) => {
    if (document.querySelector(`script[src="${src}"]`)) return ok();
    const el = document.createElement('script');
    el.src = src; el.onload = ok; el.onerror = () => fail(new Error('Could not load ' + src));
    document.head.appendChild(el);
  });
  const fileBase = () => `Category_${data.filters.pg.replace(/[^\w]+/g, '-')}_${labelsOf(data).cur.replace(/[^\w]+/g, '-')}`;
  const download = (blob, name) => { const a = document.createElement('a'); a.href = URL.createObjectURL(blob); a.download = name; a.click(); setTimeout(() => URL.revokeObjectURL(a.href), 4000); };
  // The whole screen, then each panel as its own JPG (both sides of the flip panels), in a ZIP.
  async function exportJpg() {
    toast('Preparing JPG images');
    const root = $('viewCat'), savedCi = flips.ci, savedBr = flips.br, savedSlide = slideM;
    const grid = $('catGrid'), s3 = $('catS3'), subs = $('catSubs');
    try {
      await Promise.all([loadScript('/vendor/html-to-image/html-to-image.js'), loadScript('/vendor/jszip/jszip.min.js')]);
      $('catDrawerToggle').checked = false;
      root.classList.add('exporting');
      const zip = new window.JSZip(), settle = () => new Promise(r => setTimeout(r, 150));
      const shot = async (name, el) => {
        const url = await window.htmlToImage.toJpeg(el, { quality: 0.95, pixelRatio: 2, backgroundColor: '#F4F6FA', width: el.offsetWidth, height: el.offsetHeight, style: { transform: 'none' } });
        zip.file(`${name}.jpg`, url.split(',')[1], { base64: true });
      };
      setFlip('ci', false, true); setFlip('br', false, true); await settle();
      setSlide(false, true); await settle();
      await shot('00_Full_screen_category_investment', $('catOne'));
      setSlide(true, true); await settle();
      await shot('00_Full_screen_monthly_by_brand', $('catOne'));
      setSlide(false, true); await settle();
      // Every card (the strip wraps into rows for this picture).
      grid.style.cssText += ';flex-wrap:wrap;overflow:visible;height:auto'; await settle();
      await shot('01_Cards', $('catS1'));
      grid.style.flexWrap = ''; grid.style.overflow = ''; grid.style.height = '';
      await shot('02_Category_Investment', $('catS0'));
      if (!$('catCiFlip').hidden) { setFlip('ci', true, true); await settle(); await shot('03_Sub_Category_Investment', $('catS0')); setFlip('ci', false, true); }
      await shot('04_Category_Behaviour', $('catS2'));
      // Tables can be longer than the panel: grow the panel for the picture.
      const grow = async name => {
        const extra = Math.max(0, (flips.br ? $('catMixC') : subs).scrollHeight - (flips.br ? $('catMixC') : subs).clientHeight);
        const h0 = s3.style.height;
        if (extra) { s3.style.height = (s3.offsetHeight + extra) + 'px'; subs.style.overflow = 'visible'; $('catMixC').style.overflow = 'visible'; await settle(); }
        await shot(name, s3);
        s3.style.height = h0; subs.style.overflow = ''; $('catMixC').style.overflow = '';
      };
      await grow('05_Mother_Brands');
      if (!$('catBrFlip').hidden) { setFlip('br', true, true); await settle(); await grow('06_Mix_and_Contribution'); setFlip('br', false, true); }
      download(await zip.generateAsync({ type: 'blob' }), fileBase() + '_JPG.zip');
      toast('JPG images downloaded');
    } catch (e) { toast('Export failed: ' + e.message); } finally {
      root.classList.remove('exporting');
      setFlip('ci', savedCi, true); setFlip('br', savedBr, true); setSlide(savedSlide, true);
      if (data) { updateStrip(); renderChart(data, null); renderCi(data); }
    }
  }
  // Editable PowerPoint: real text, shapes, tables and a real chart, one slide per section (more if a section is long).
  async function exportPpt() {
    toast('Preparing PowerPoint');
    try {
      await Promise.all([loadScript('/vendor/pptxgenjs/pptxgen.bundle.js'), loadScript('/vendor/html-to-image/html-to-image.js')]);
      // A picture of the screen as it is now (current filters), added after the editable slides.
      $('catDrawerToggle').checked = false;
      await new Promise(r => setTimeout(r, 320));
      const one = $('catOne'), viewW = one.offsetWidth, viewH = one.offsetHeight;
      $('viewCat').classList.add('exporting');
      const viewUrl = await window.htmlToImage.toJpeg(one, { quality: 0.92, pixelRatio: 2, backgroundColor: '#F4F6FA', width: viewW, height: viewH, style: { transform: 'none' } })
        .finally(() => $('viewCat').classList.remove('exporting'));
      const d = data, L = labelsOf(d), f = d.filters;
      const pptx = new window.PptxGenJS();
      pptx.layout = 'LAYOUT_WIDE'; // 13.33 x 7.5 in
      pptx.title = `${f.pg} category`; pptx.company = 'Ogilvy'; pptx.author = 'Ogilvy Orbit Chub';
      const W = 13.33, H = 7.5, INK = '1A1F36', GREY = '6B7590';
      const hex = c => c.replace('#', '');
      const txt = id => ($(id).textContent || '').trim();
      const SHAPE = pptx.ShapeType;
      const chrome = (slide, headline, sub, wide = true) => {
        slide.background = { color: 'FFFFFF' };
        slide.addText(headline, { x: 0.55, y: 0.2, w: wide ? 12.2 : 9.3, h: 0.9, fontFace: 'Georgia', fontSize: 26, color: INK, valign: 'top', margin: 0, fit: 'shrink' });
        if (sub) slide.addText(sub, { x: 0.55, y: 1.1, w: wide ? 12.2 : 9.3, h: 0.3, fontFace: 'Calibri', fontSize: 12, color: GREY, margin: 0 });
        slide.addText('OGILVY', { x: -0.42, y: 3.4, w: 1.2, h: 0.3, rotate: 270, fontFace: 'Calibri', fontSize: 9, color: '9AA3BC', charSpacing: 3, align: 'center', margin: 0 });
      };
      const growthStr = g => (g == null ? '—' : `${g > 0.5 ? '▲ ' : g < -0.5 ? '▼ ' : '■ '}${nf(g, 0)}%`);
      const growthCol = g => (g == null ? '9AA3BC' : g > 0.5 ? '14803F' : g < -0.5 ? 'D12B2B' : '8A93AD');

      // ----- slide 1: category investment (stacked by medium, and the sub categories) -----
      {
        const CD = ciData(d), slide = pptx.addSlide(), hasSubs = CD.names.length > 1, f1 = 0.01, tsz = 1.25;
        chrome(slide, txt('catTitle0'), txt('catSub0'));
        const draw = (P, ox, oy) => P.forEach(e => {
          if (e.t === 'r') {
            if (e.hatch) { slide.addShape(SHAPE.rect, { x: ox + e.x * f1, y: oy + e.y * f1, w: e.w * f1, h: e.h * f1, fill: { color: 'FFFFFF', transparency: 100 }, line: { color: 'E4702A', width: 1.25, dashType: 'dash' } }); return; }
            slide.addShape(e.rx ? SHAPE.roundRect : SHAPE.rect, { x: ox + e.x * f1, y: oy + e.y * f1, w: Math.max(0.005, e.w * f1), h: Math.max(0.005, e.h * f1), rectRadius: e.rx ? e.rx * f1 : undefined, fill: { color: e.fill }, line: e.line ? { color: e.line, width: e.lw || 1 } : { color: e.fill, width: 0 } });
          } else if (e.t === 'l') slide.addShape(SHAPE.line, { x: ox + Math.min(e.x1, e.x2) * f1, y: oy + Math.min(e.y1, e.y2) * f1, w: Math.abs(e.x2 - e.x1) * f1, h: Math.abs(e.y2 - e.y1) * f1, line: { color: e.color, width: e.lw || 1 } });
          else if (e.t === 'a') slide.addShape(e.dir === 'up' ? SHAPE.upArrow : SHAPE.downArrow, { x: ox + (e.x - e.w / 2) * f1, y: oy + e.y * f1, w: e.w * f1, h: e.h * f1, fill: { color: e.fill }, line: { color: e.fill, width: 0 } });
          else if (e.t === 't') {
            const w = (e.text.length * e.size * 0.6 + 8) * f1, h = e.size * 1.5 * f1, anchor = e.anchor || 'start';
            const x = anchor === 'middle' ? e.x * f1 - w / 2 : anchor === 'end' ? e.x * f1 - w : e.x * f1;
            const y = e.rot ? e.y * f1 - h / 2 : (e.y - e.size * 0.95) * f1;
            slide.addText(e.text, { x: ox + x, y: oy + y, w, h, align: anchor === 'middle' ? 'center' : anchor === 'end' ? 'right' : 'left', valign: 'middle', fontFace: 'Calibri', fontSize: e.size * f1 * 72 * tsz, bold: !!e.bold, color: e.color, margin: 0, wrap: false, rotate: e.rot ? 270 : undefined });
          }
        });
        const title = (x, w, str) => slide.addText(str, { x, y: 1.5, w, h: 0.35, align: 'center', fontFace: 'Calibri', fontSize: 15, bold: true, color: GREY, underline: { style: 'sng' }, margin: 0 });
        const legend = (x, y, items) => { let lx = x; items.forEach(([hex, name]) => { slide.addShape(SHAPE.rect, { x: lx, y: y + 0.05, w: 0.12, h: 0.12, fill: { color: hex }, line: { color: hex, width: 0 } }); slide.addText(name, { x: lx + 0.17, y, w: 1.6, h: 0.22, fontFace: 'Calibri', fontSize: 10, bold: true, color: INK, margin: 0 }); lx += 0.4 + Math.min(1.7, name.length * 0.085 + 0.2); }); };
        if (CD.periods.length) {
          if (hasSubs) {
            title(0.55, 6.2, `${f.pg} Category Investment`); title(6.85, 5.95, `${f.pg} Sub Category Investments`);
            draw(ciLeft(CD, 620, 370), 0.55, 1.9); draw(ciRight(CD, 595, 370), 6.85, 1.9);
            legend(2.4, 5.68, MED.map((m, k) => [MED_HEX[k], m]));
            legend(6.95, 5.68, CD.names.map((nm, k) => [SUBC[k % SUBC.length], nm]).filter(([, nm]) => ci.subsOn.has(nm)).concat([['BFDDF4', 'Category total']]));
          } else {
            title(0.55, 12.2, `${f.pg} Category Investment`);
            draw(ciLeft(CD, 1220, 370), 0.55, 1.9);
            legend(5.2, 5.68, MED.map((m, k) => [MED_HEX[k], m]));
          }
          // Notes under the charts: keep the bold numbers as bold runs.
          const doc = new DOMParser().parseFromString(`<body>${$('catCiNotes').innerHTML}</body>`, 'text/html'), runs = [];
          doc.querySelectorAll('li').forEach(li => {
            const parts = [...li.childNodes].map(n => ({ text: n.textContent, bold: n.nodeName === 'B' || n.nodeName === 'STRONG' })).filter(x => x.text);
            parts.forEach((pt, i) => runs.push({ text: pt.text, options: { bold: pt.bold, fontSize: 12.5, color: INK, bullet: i === 0 ? { indent: 16 } : undefined, breakLine: i === parts.length - 1, paraSpaceAfter: 4 } }));
          });
          if (runs.length) slide.addText(runs, { x: 0.55, y: 5.98, w: 12.2, h: 1.4, fontFace: 'Calibri', valign: 'top', margin: 0 });
        }
        slide.addNotes(CD.periods.map(p => `${p.tipLabel}${p.complete ? '' : ' (incomplete)'}: total ${nf(p.total / 1000, 0)} (TV ${nf(p.tv / 1000, 0)}, Radio ${nf(p.radio / 1000, 0)}, Press ${nf(p.press / 1000, 0)})` + CD.names.map((nm, k) => `; ${nm} ${nf(p.subs[k] / 1000, 0)}`).join('')).join('\n'));
      }

      // ----- slide(s): cards, ten to a slide -----
      const colors = brandColors(d.cards);
      for (let page = 0; page * 10 < Math.max(1, d.cards.length); page++) {
        const slide = pptx.addSlide();
        const more = d.cards.length > 10;
        chrome(slide, txt('catTitle') + (page ? ' (cont.)' : ''), txt('catSub'), false);
        slide.addText(`${L.cur} TOTAL`, { x: 10.3, y: 0.3, w: 2.5, h: 0.25, align: 'right', fontFace: 'Calibri', fontSize: 9, bold: true, color: '8A93AD', charSpacing: 1, margin: 0 });
        slide.addText(mnTxt(d.total.cur), { x: 10.3, y: 0.55, w: 2.5, h: 0.5, align: 'right', fontFace: 'Calibri', fontSize: 26, bold: true, color: INK, margin: 0 });
        const batch = d.cards.slice(page * 10, page * 10 + 10);
        const gx = 0.55, gy = 1.6, gap = 0.17, cw = (W - 1.1 - 4 * gap) / 5, ch = 2.45;
        batch.forEach((c, i) => {
          const x = gx + (i % 5) * (cw + gap), y = gy + Math.floor(i / 5) * (ch + gap), col = hex(colors.get(c.name));
          const medTot = c.medium[0] + c.medium[1] + c.medium[2];
          slide.addShape(SHAPE.roundRect, { x, y, w: cw, h: ch, rectRadius: 0.12, fill: { color: c.mine ? 'FFF6EE' : 'FFFFFF' }, line: { color: col, width: c.mine ? 3 : 1.75 } });
          slide.addShape(SHAPE.rect, { x: x + 0.12, y, w: cw - 0.24, h: 0.07, fill: { color: col }, line: { color: col, width: 0 } });
          if (c.mine) { slide.addShape(SHAPE.rect, { x: x + cw - 0.62, y: y + 0.04, w: 0.5, h: 0.2, fill: { color: 'FF8A3D' }, line: { color: 'FF8A3D', width: 0 } }); slide.addText('US', { x: x + cw - 0.62, y: y + 0.04, w: 0.5, h: 0.2, align: 'center', valign: 'middle', fontFace: 'Calibri', fontSize: 8, bold: true, color: 'FFFFFF', margin: 0 }); }
          slide.addShape(SHAPE.ellipse, { x: x + 0.14, y: y + 0.22, w: 0.4, h: 0.4, fill: { color: col }, line: { color: col, width: 0 } });
          slide.addText(initials(c.name), { x: x + 0.14, y: y + 0.22, w: 0.4, h: 0.4, align: 'center', valign: 'middle', fontFace: 'Calibri', fontSize: 9, bold: true, color: 'FFFFFF', margin: 0 });
          slide.addText(c.name.toUpperCase(), { x: x + 0.62, y: y + 0.2, w: cw - 0.75, h: 0.44, valign: 'middle', fontFace: 'Calibri', fontSize: 12, bold: true, color: INK, margin: 0, fit: 'shrink' });
          slide.addShape(SHAPE.line, { x: x + 0.14, y: y + 0.7, w: cw - 0.28, h: 0, line: { color: 'E9EDF5', width: 1 } });
          slide.addText(L.cur, { x: x + 0.14, y: y + 0.76, w: 1.3, h: 0.2, fontFace: 'Calibri', fontSize: 8, bold: true, color: GREY, margin: 0 });
          slide.addText(mnTxt(c.cur), { x: x + 0.14, y: y + 0.94, w: cw * 0.58, h: 0.42, fontFace: 'Calibri', fontSize: 20, bold: true, color: INK, margin: 0, valign: 'middle' });
          slide.addText('Y-O-Y GROWTH', { x: x + cw - 1.2, y: y + 0.76, w: 1.06, h: 0.2, align: 'right', fontFace: 'Calibri', fontSize: 7, bold: true, color: GREY, margin: 0 });
          slide.addText(growthStr(c.growth), { x: x + cw - 1.2, y: y + 0.98, w: 1.06, h: 0.32, align: 'right', fontFace: 'Calibri', fontSize: 13, bold: true, color: growthCol(c.growth), margin: 0, valign: 'middle' });
          const bw = (cw - 0.28 - 0.1) / 2;
          [[L.yoy, c.yoy], [L.prev, c.prev]].forEach(([lab, v], k) => {
            const bx = x + 0.14 + k * (bw + 0.1);
            slide.addShape(SHAPE.roundRect, { x: bx, y: y + 1.45, w: bw, h: 0.52, rectRadius: 0.07, fill: { color: 'F3F5F9' }, line: { color: 'E9EDF5', width: 1 } });
            slide.addText(lab, { x: bx, y: y + 1.48, w: bw, h: 0.18, align: 'center', fontFace: 'Calibri', fontSize: 7.5, color: GREY, margin: 0 });
            slide.addText(v == null || v <= 0 ? '–' : mnNum(v), { x: bx, y: y + 1.65, w: bw, h: 0.3, align: 'center', valign: 'middle', fontFace: 'Calibri', fontSize: 13, bold: true, color: INK, margin: 0 });
          });
          slide.addText(`${L.cur} SHARE`, { x: x + 0.14, y: y + 2.03, w: cw - 0.9, h: 0.18, fontFace: 'Calibri', fontSize: 7, bold: true, color: GREY, margin: 0 });
          slide.addText(`${nf(c.share, 0)}%`, { x: x + cw - 0.8, y: y + 1.99, w: 0.66, h: 0.22, align: 'right', fontFace: 'Calibri', fontSize: 11, bold: true, color: col, margin: 0 });
          slide.addShape(SHAPE.roundRect, { x: x + 0.14, y: y + 2.24, w: cw - 0.28, h: 0.07, rectRadius: 0.03, fill: { color: 'E7EBF3' }, line: { color: 'E7EBF3', width: 0 } });
          slide.addShape(SHAPE.roundRect, { x: x + 0.14, y: y + 2.24, w: Math.max(0.05, (cw - 0.28) * Math.min(1, c.share / 100)), h: 0.07, rectRadius: 0.03, fill: { color: col }, line: { color: col, width: 0 } });
          let mx = x + 0.14;
          c.medium.forEach((v, k) => { const w2 = medTot ? (cw - 0.28) * (v / medTot) : 0; if (w2 > 0.01) { slide.addShape(SHAPE.rect, { x: mx, y: y + 2.35, w: w2, h: 0.04, fill: { color: hex(MED_COL[k]) }, line: { color: hex(MED_COL[k]), width: 0 } }); mx += w2; } });
        });
        // Legend strip
        slide.addShape(SHAPE.roundRect, { x: 0.55, y: 6.78, w: W - 1.1, h: 0.5, rectRadius: 0.08, fill: { color: 'FAFBFD' }, line: { color: 'E5E9F2', width: 1 } });
        [['2F6FD3', 'Investment amount', `${L.yoy}, ${L.prev} and ${L.cur} (Rs. Mn)`], ['1E8E4E', 'Y-o-Y growth', `${L.cur} versus ${L.yoy}`], ['7B4FA0', 'Share of investment', `Share of total ${L.cur} investment`]].forEach(([col, a, b], k) => {
          const lx = 0.8 + k * 3.7;
          slide.addShape(SHAPE.roundRect, { x: lx, y: 6.86, w: 0.09, h: 0.34, rectRadius: 0.04, fill: { color: col }, line: { color: col, width: 0 } });
          slide.addText([{ text: a, options: { bold: true, fontSize: 10, color: INK, breakLine: true } }, { text: b, options: { fontSize: 8.5, color: GREY } }], { x: lx + 0.18, y: 6.82, w: 3.3, h: 0.42, fontFace: 'Calibri', margin: 0, valign: 'middle' });
        });
        MED.forEach((m, k) => { slide.addShape(SHAPE.rect, { x: 11.0 + k * 0.7, y: 6.99, w: 0.1, h: 0.1, fill: { color: hex(MED_COL[k]) }, line: { color: hex(MED_COL[k]), width: 0 } }); slide.addText(m, { x: 11.13 + k * 0.7, y: 6.94, w: 0.55, h: 0.2, fontFace: 'Calibri', fontSize: 8.5, bold: true, color: '4A5570', margin: 0 }); });
        void more;
      }

      // ----- slide: Category behaviour, month by month (a real combo chart on two axes) -----
      {
        const slide = pptx.addSlide();
        const CD = chartData(d), { periods, pool, colors: cc, part } = CD;
        const shown = pool.filter(c => !hiddenBrands.has(c.name));
        const pidx = new Map(pool.map((c, j) => [c.name, j]));
        chrome(slide, txt('catTitle2'), txt('catSub2'));
        slide.addText(`Category Behaviour – ${PART_NAME[part]}`, { x: 3.2, y: 1.5, w: 7, h: 0.35, align: 'center', fontFace: 'Calibri', fontSize: 16, bold: true, color: GREY, underline: { style: 'sng' }, margin: 0 });
        const labels = periods.map(p => p.label + (p.complete ? '' : ' *'));
        const maxCat = niceMax(Math.max(0, ...periods.map(p => p.cat), ...periods.flatMap(p => shown.map(c => p.vals[pidx.get(c.name)]))) / 1000), maxBr = maxCat;   // one scale on both axes
        const mnv = v => (v > 0 ? Math.round(v / 1000) : null);       // zero is left empty: no bar, no label
        const catSeries = [{ name: 'Category total', labels, values: periods.map(p => mnv(p.cat)) }];
        const brSeries = shown.map(c => ({ name: (c.mine ? '★ ' : '') + c.name, labels, values: periods.map(p => mnv(p.vals[pidx.get(c.name)])) }));
        const common = { barDir: 'col', barGrouping: 'clustered', showValue: ui.labels, dataLabelFontSize: 8, dataLabelFontBold: true, dataLabelPosition: 'outEnd', dataLabelFormatCode: '#,##0;-#,##0;;', dataLabelColor: '111111' };
        if (periods.some(p => !p.complete)) slide.addText('* incomplete period', { x: W - 3.3, y: 1.55, w: 2.7, h: 0.25, align: 'right', fontFace: 'Calibri', fontSize: 9, italic: true, color: 'E4702A', margin: 0 });
        slide.addChart([
          { type: pptx.charts.BAR, data: catSeries, options: { ...common, chartColors: ['A9D96C'], barGapWidthPct: 8 } },
          { type: pptx.charts.BAR, data: brSeries, options: { ...common, chartColors: shown.map(c => hex(cc.get(c.name))), barGapWidthPct: 70, secondaryValAxis: true, secondaryCatAxis: true } },
        ], {
          x: 0.6, y: 1.9, w: W - 1.2, h: 5.35, showLegend: true, legendPos: 'b', legendFontSize: 11, legendFontBold: true, legendColor: INK,
          valAxes: [
            { showValAxisTitle: true, valAxisTitle: 'Investments in (Rs. in Mn)', valAxisTitleFontSize: 10, valAxisMinVal: 0, valAxisMaxVal: maxCat, valAxisLabelFontSize: 10, valAxisLabelFormatCode: '#,##0', valGridLine: { color: 'EEF1F7', size: 0.5 } },
            { showValAxisTitle: true, valAxisTitle: 'Investments in (Rs. in Mn)', valAxisTitleFontSize: 10, valAxisMinVal: 0, valAxisMaxVal: maxBr, valAxisLabelFontSize: 10, valAxisLabelFormatCode: '#,##0', valGridLine: { style: 'none' } },
          ],
          catAxes: [{ catAxisLabelFontSize: 10, catAxisLabelFontBold: true }, { catAxisHidden: true }],
        });
        slide.addNotes(`${PART_NAME[part]} investment, Rs. Mn. Selected period ${L.cur} (${monLabel(d.ranges.cur[0])} to ${monLabel(d.ranges.cur[1])}). Left axis: category total. Right axis: mother brands.\n` +
          periods.map(p => `${p.tipLabel}${p.complete ? '' : ' (incomplete)'}: category ${nf(p.cat / 1000, 0)}; ` + shown.filter(c => p.vals[pidx.get(c.name)] > 0).map(c => `${c.name} ${nf(p.vals[pidx.get(c.name)] / 1000, 0)}`).join(', ')).join('\n'));
      }

      // ----- slides: sub categories (mix, contribution, tables) -----
      {
        const T = d.tables, multi = d.hasSubs && T.length > 1;
        const headline = txt('catTitle3'), sub = txt('catSub3');
        const subColors = T.map((t, i) => hex(SUB_COLORS[i % SUB_COLORS.length]));
        let slide = pptx.addSlide();
        chrome(slide, headline, sub);
        const COLX = [0.55, 6.85], COLW = [6.0, 5.95], BOTTOM = 7.4;
        let y = [1.6, 1.6];
        const title = (sl, x, yy, w, str, col, color) => {
          sl.addShape(SHAPE.rect, { x, y: yy + 0.03, w: 0.1, h: 0.28, fill: { color: col }, line: { color: col, width: 0 } });
          sl.addText(str, { x: x + 0.2, y: yy, w: w - 0.2, h: 0.34, fontFace: 'Calibri', fontSize: 14, bold: true, color: color || INK, margin: 0, valign: 'middle' });
        };
        if (multi) {
          // Mix of sub categories
          if (d.mix && d.mix.yoy) {
            slide.addText(txt('catMixT'), { x: COLX[0], y: y[0], w: COLW[0], h: 0.34, fontFace: 'Calibri', fontSize: 15, bold: true, color: INK, margin: 0 });
            let yy = y[0] + 0.45;
            const rows = [[L.yoy, d.mix.yoy], d.mix.prev ? [L.prev, d.mix.prev] : null, [L.cur, d.mix.cur, true]].filter(Boolean);
            rows.forEach(([lab, arr, now]) => {
              slide.addText(lab, { x: COLX[0], y: yy, w: 0.95, h: 0.34, fontFace: 'Calibri', fontSize: 10.5, bold: !!now, color: now ? INK : GREY, margin: 0, valign: 'middle' });
              let bx = COLX[0] + 1.0; const bwAll = COLW[0] - 1.0;
              arr.forEach((p, i) => {
                if (p <= 0) return;
                const w2 = bwAll * (p / 100);
                slide.addShape(SHAPE.rect, { x: bx, y: yy, w: w2, h: 0.34, fill: { color: subColors[i] }, line: { color: 'FFFFFF', width: 0.5 } });
                if (p >= 4) slide.addText(`${nf(p, 0)}%`, { x: bx, y: yy, w: w2, h: 0.34, align: 'center', valign: 'middle', fontFace: 'Calibri', fontSize: 10.5, bold: true, color: 'FFFFFF', margin: 0 });
                bx += w2;
              });
              yy += 0.42;
            });
            let lx = COLX[0] + 1.0;
            T.forEach((t, i) => { slide.addShape(SHAPE.rect, { x: lx, y: yy + 0.06, w: 0.12, h: 0.12, fill: { color: subColors[i] }, line: { color: subColors[i], width: 0 } }); slide.addText(t.name, { x: lx + 0.17, y: yy, w: 1.3, h: 0.24, fontFace: 'Calibri', fontSize: 9.5, color: '4A5570', margin: 0 }); lx += 0.35 + Math.min(1.4, t.name.length * 0.085 + 0.2); });
            y[0] = yy + 0.4;
          }
          // Contribution
          if (d.contribution) {
            slide.addText(txt('catContT'), { x: COLX[1], y: y[1], w: COLW[1], h: 0.34, fontFace: 'Calibri', fontSize: 15, bold: true, color: INK, margin: 0 });
            let yy = y[1] + 0.45;
            d.contribution.forEach((c, i) => {
              slide.addShape(SHAPE.rect, { x: COLX[1], y: yy, w: 0.08, h: 0.42, fill: { color: subColors[i] }, line: { color: subColors[i], width: 0 } });
              slide.addText(c.name, { x: COLX[1] + 0.25, y: yy, w: 1.9, h: 0.42, fontFace: 'Calibri', fontSize: 14, bold: true, color: INK, margin: 0, valign: 'middle' });
              slide.addText(`${mnNum(c.yoy)}  →  ${mnNum(c.cur)}`, { x: COLX[1] + 2.2, y: yy, w: 2.3, h: 0.42, align: 'center', fontFace: 'Calibri', fontSize: 13, bold: true, color: INK, margin: 0, valign: 'middle' });
              slide.addText(c.growth == null ? '—' : `${nf(c.growth, 0)}%`, { x: COLX[1] + 4.7, y: yy, w: 1.2, h: 0.42, align: 'right', fontFace: 'Calibri', fontSize: 15, bold: true, color: growthCol(c.growth), margin: 0, valign: 'middle' });
              yy += 0.46;
            });
            [[L.yoy, COLX[1] + 2.2, 1.1, 'left'], [L.cur, COLX[1] + 3.4, 1.1, 'right'], ['Y-O-Y', COLX[1] + 4.7, 1.2, 'right']].forEach(([lab, xx, w2, al]) => slide.addText(lab, { x: xx, y: yy, w: w2, h: 0.22, align: al, fontFace: 'Calibri', fontSize: 9.5, color: GREY, underline: { style: 'sng' }, margin: 0 }));
            y[1] = yy + 0.4;
          }
        }
        // Tables, packed into the two columns; a new slide starts when both are full.
        const rowH = 0.25;
        const place = (t, ti, pref) => {
          const single = !multi;
          const colsOrder = single ? [0] : [pref, 1 - pref];
          const hgt = 0.4 + (t.rows.length + 2) * rowH + 0.2;
          let col = colsOrder.find(c => y[c] + hgt <= BOTTOM);
          if (col === undefined) {
            slide = pptx.addSlide(); chrome(slide, headline + ' (cont.)', sub); y = [1.6, 1.6];
            col = 0;
          }
          const x = COLX[col], w = single ? 9.2 : COLW[col];
          const name = single ? String(f.pg).toUpperCase() : (t.none ? 'UNASSIGNED' : t.name.toUpperCase());
          title(slide, x, y[col], w, `${name}${t.growth == null ? '' : ' | ' + nf(t.growth, 0) + '% YoY'}`, subColors[ti] || 'F24B4B');
          const border = { type: 'solid', color: INK, pt: 0.75 };
          const hdr = txt => ({ text: txt, options: { bold: true, color: 'FFFFFF', fill: { color: '4B5563' }, align: 'center', fontSize: 9.5 } });
          const tint = ['E4F1FB', 'E8F4DE', 'FBE4EE'];
          const num = (v, k, o = {}) => ({ text: v == null || v <= 0 ? '–' : mnNum(v), options: { align: 'center', fill: { color: tint[k] }, ...o } });
          const rows = [[{ text: 'BRAND', options: { bold: true, color: 'FFFFFF', fill: { color: '4B5563' }, fontSize: 9.5 } }, hdr(tabLabel(L.yoy)), hdr(tabLabel(L.prev)), hdr(tabLabel(L.cur)), hdr('YoY'), hdr('SHR.')]];
          t.rows.forEach(r => {
            const o = { bold: !!r.mine, fontSize: r.mine ? 11 : 10, italic: !!r.others, color: r.others ? '6B7590' : INK };
            rows.push([{ text: r.name, options: { ...o, align: 'left' } }, num(r.yoy, 0, o), num(r.prev, 1, o), num(r.cur, 2, o),
              { text: r.growth == null ? '' : `${nf(r.growth, 0)}%`, options: { ...o, align: 'center', color: growthCol(r.growth) } },
              { text: r.cur > 0 ? `${nf(r.share, 0)}%` : '', options: { ...o, align: 'center' } }]);
          });
          const tb = { bold: true, fontSize: 10.5, color: INK };
          rows.push([{ text: name, options: { ...tb, align: 'left' } }, { text: t.yoy > 0 ? mnNum(t.yoy) : '–', options: { ...tb, align: 'center' } }, { text: t.prev > 0 ? mnNum(t.prev) : '–', options: { ...tb, align: 'center' } }, { text: t.cur > 0 ? mnNum(t.cur) : '–', options: { ...tb, align: 'center' } },
            { text: t.growth == null ? '' : `${nf(t.growth, 0)}%`, options: { ...tb, align: 'center', color: growthCol(t.growth) } }, { text: '', options: tb }]);
          const first = single ? 3.0 : w * 0.33;
          const rest = (w - first) / 5;
          slide.addTable(rows, { x, y: y[col] + 0.4, w, colW: [first, rest, rest, rest, rest, rest], rowH, fontFace: 'Calibri', fontSize: 10, border, valign: 'middle', margin: [0, 0.06, 0, 0.06] });
          y[col] += hgt;
        };
        T.forEach((t, i) => place(t, i, (i === 0 || (i >= 3 && i % 2 === 1)) ? 1 : 0));
        if (!T.length) slide.addText('No spend found for these filters.', { x: 0.55, y: 2, w: 8, h: 0.4, fontFace: 'Calibri', fontSize: 14, color: GREY });
      }
      {
        const slide = pptx.addSlide();
        chrome(slide, 'Dashboard view with the current filters', `${f.pg}${f.sub ? ' · ' + f.sub : ''} · ${L.cur} · ${state.yearType === 'FY' ? 'Financial year' : 'Calendar year'} (picture of the screen)`);
        const bw = W - 1.1, bh = H - 1.75, r = Math.min(bw / viewW, bh / viewH), w2 = viewW * r, h2 = viewH * r;
        slide.addImage({ data: viewUrl.replace(/^data:/, ''), x: 0.55 + (bw - w2) / 2, y: 1.55, w: w2, h: h2 });
      }
      const out = await pptx.write({ outputType: 'blob' });
      download(out, fileBase() + '.pptx');
      toast('PowerPoint downloaded');
    } catch (e) { console.error(e); toast('Export failed: ' + e.message); }
  }

  // ---------- switching between the two dashboards ----------
  function applyModeText() { $('modeTxt').textContent = document.body.classList.contains('mode-cat') ? 'Switch to Spot Log' : 'Switch to Category'; }
  async function ensureStarted() {
    if (!started) return;
    if (!overview) showEmpty(); else if (!data) await refresh(); else render();
  }
  $('modeBtn').addEventListener('click', () => {
    if (busy) return;
    busy = true;
    const toCat = !document.body.classList.contains('mode-cat');
    const out = $(toCat ? 'viewSpot' : 'viewCat'), inn = $(toCat ? 'viewCat' : 'viewSpot');
    $('drawerToggle').checked = false; $('catDrawerToggle').checked = false; closeModal();
    out.classList.add(toCat ? 'leave-left' : 'leave-right');
    setTimeout(() => {
      out.classList.remove('leave-left', 'leave-right');
      document.body.classList.toggle('mode-cat', toCat);
      applyModeText();
      inn.classList.add(toCat ? 'enter-right' : 'enter-left');
      window.dispatchEvent(new Event('resize'));        // the spot charts measure themselves again
      if (toCat) ensureStarted();
      setTimeout(() => { inn.classList.remove('enter-right', 'enter-left'); busy = false; }, 520);
    }, 260);
    if (!CLIENT) { try { localStorage.setItem(MODE, toCat ? 'cat' : 'spot'); } catch (e) { /* storage unavailable */ } }
  });

  // ---------- boot (after the data engine knows who is signed in) ----------
  async function boot() {
    try {
      if (shared && shared.ro) document.body.classList.add('ro-cat');
      const s = await engine.call('catInit');
      renderFile(s.dataset);
      started = true;
      if (s.dataset) await loadOverview(false); else { showEmpty(); }
      if (window.BRANDMAP) window.BRANDMAP.sync();
      let mode = shared ? 'cat' : null;
      if (!shared && !CLIENT) { try { mode = localStorage.getItem(MODE); } catch (e) { /* storage unavailable */ } }
      if (mode === 'cat') { document.body.classList.add('mode-cat'); applyModeText(); ensureStarted(); }
    } catch (e) { toast('Category data: ' + e.message); }
  }
  O.catState = () => JSON.parse(JSON.stringify(state));
  // The main file was loaded (or the shared Brand Map changed): the Category data was rebuilt, so show it.
  document.addEventListener('orbit:catrefresh', async e => {
    renderFile(e.detail.dataset);
    if (started) { try { await loadOverview(!!e.detail.fresh); } catch (err) { toast('Category data: ' + err.message); } }
  });
  if (O.ready) boot(); else document.addEventListener('orbit:ready', boot, { once: true });
})();
