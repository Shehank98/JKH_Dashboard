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
  const KEY = 'cas-cat-filters', MODE = 'orbit-mode';
  const save = () => { try { localStorage.setItem(KEY, JSON.stringify(state)); } catch (e) { /* storage unavailable */ } };
  const readSaved = () => { try { return JSON.parse(localStorage.getItem(KEY) || 'null'); } catch (e) { return null; } };

  // ---------- data file tab ----------
  function renderFile(ds) {
    $('cDfile').innerHTML = ds ? `<div class="dfile"><b title="${esc(ds.fileName)}">${esc(ds.fileName)}</b>
      <div class="row"><span>${nf(ds.rows)} rows</span><span>${ds.size ? nf(ds.size / 1048576, 1) + ' MB' : ''}</span></div>
      <div class="row"><span>${monLabel(ds.minMonth)} to ${monLabel(ds.maxMonth)}</span></div>
      <div class="row"><span>Loaded ${new Date(ds.uploadedAt).toLocaleString()}</span></div>
      <div class="row"><span>Saved in this browser only</span></div>
      ${ds.skipped ? `<div class="row"><span>${nf(ds.skipped)} rows skipped (invalid month)</span></div>` : ''}</div>`
      : '<div class="dfile" style="color:#6E7A99">No category file loaded</div>';
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
    $('catOvText').textContent = 'Open the filter drawer, choose Data file and pick your category file (Month, Product Group, Mother Brand, Advertiser, Brand, Tv / Radio / Press in 000Rs). It is read on this computer only.';
    $('catOverlay').classList.add('on');
    $('viewCat').classList.add('nodata');
    for (const id of ['catTitle', 'catSub', 'catTot', 'catTotLabel', 'catTitle2', 'catSub2', 'catTitle3', 'catSub3']) $(id).textContent = '';
    $('catGrid').innerHTML = ''; $('catLegend').innerHTML = ''; $('catChart').innerHTML = ''; $('catSubs').innerHTML = '';
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
    const saved = fresh ? null : readSaved();
    monthOptions();
    $('cPg').innerHTML = overview.productGroups.map(g => `<option>${esc(g.name)}</option>`).join('');
    const groups = overview.productGroups.map(g => g.name);
    if (saved && groups.includes(saved.pg)) Object.assign(state, { sub: '', top: 10, yearType: 'CY' }, saved);
    else Object.assign(state, { pg: groups[0], sub: '', mine: [], comps: [], top: 10 });
    // Keep dates inside the data; a new file starts on its latest quarter.
    const inside = k => k && k >= overview.minMonth && k <= overview.maxMonth;
    if (!(inside(state.from) && inside(state.to) && state.from <= state.to) || fresh) { [state.from, state.to] = latest(3); }
    await loadOptions(fresh || !(saved && saved.mine && saved.mine.length));
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
    $('catChips').innerHTML = chips.join('');
    renderChart(d, cur);
    renderSubs(d, { cur, yoy, prev });
    if (!d.cards.length) { $('catGrid').innerHTML = '<div class="nodata2">No spend found for these filters.</div>'; renderLegend(cur, yoy, prev); return; }
    const colors = brandColors(d.cards);
    sizeGrid();
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
        <div class="cc-b"><div><span>${esc(yoy)}</span><b>${box(c.yoy)}</b></div><div><span>${esc(prev)}</span><b>${box(c.prev)}</b></div></div>
        <div class="cc-f"><div class="cc-s"><span>${esc(cur)} share</span><b>${nf(c.share, 0)}%</b></div>
        <div class="cc-bar"><i style="width:${Math.max(c.share > 0 ? 2 : 0, Math.min(100, c.share))}%"></i></div>
        <div class="cc-med">${c.medium.map((v, k) => `<i style="width:${medTot ? (v / medTot) * 100 : 0}%;background:${MED_COL[k]}"></i>`).join('')}</div></div>
      </div>`;
    }).join('');
    renderLegend(cur, yoy, prev);
  }

  // The same colour for a mother brand on its card and in the chart; ours are orange.
  function brandColors(cards) {
    const m = new Map();
    let ci = 0;
    cards.forEach(c => m.set(c.name, c.mine ? US : COLORS[ci++ % COLORS.length]));
    return m;
  }
  // Every card is the same size whether 5 or 10 are shown: two rows fill the screen, more rows scroll.
  function sizeGrid() {
    const g = $('catGrid');
    if (!g.clientHeight) return;
    g.style.setProperty('--rowh', Math.max(215, Math.floor((g.clientHeight - 9 - 12) / 2)) + 'px');
  }
  window.addEventListener('resize', () => { if (data && document.body.classList.contains('mode-cat')) { sizeGrid(); renderChart(data, null); } });

  // ---------- Category behaviour, month by month ----------
  // Big green bars: the whole category each month (left axis). Small bars: the mother brands (right axis, own scale).
  const niceMax = v => { if (v <= 0) return 1; const p = Math.pow(10, Math.floor(Math.log10(v))), m = v / p; return (m <= 1 ? 1 : m <= 2 ? 2 : m <= 2.5 ? 2.5 : m <= 5 ? 5 : 10) * p; };
  function chartPool(d) {
    const pool = d.cards.filter(c => c.mine).concat(d.cards.filter(c => !c.mine)).slice(0, 8).sort((a, b) => b.cur - a.cur);
    return { pool, colors: new Map(pool.map((c, i) => [c.name, CHART_COLORS[i % CHART_COLORS.length]])) };
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
      for (let i = start; i < n; i++) periods.push({ label: monLabel(M.months[i]).replace('-', " '"), tipLabel: monLabel(M.months[i]), complete: true, inSel: i >= M.selStart, cat: M.cat[i], vals: pool0.map(c => c.monthly[i]) });
    } else {
      const L = { q: 3, h: 6, y: 12 }[part], shift = yt === 'FY' ? 3 : 0;
      const first = idx(M.months[0]), last = idx(M.months[n - 1]), groups = new Map();
      M.months.forEach((k, i) => {
        const g = Math.floor((idx(k) - shift) / L) * L + shift;
        if (!groups.has(g)) groups.set(g, { g, cat: 0, vals: pool0.map(() => 0) });
        const G = groups.get(g);
        G.cat += M.cat[i]; pool0.forEach((c, j) => { G.vals[j] += c.monthly[i]; });
      });
      periods = [...groups.values()].sort((x, y) => x.g - y.g).map(G => {
        const a = keyOf(G.g), b = keyOf(G.g + L - 1), label = periodLabel(a, b, yt);
        return { label, tipLabel: `${label} (${monLabel(a)} to ${monLabel(b)})`, complete: G.g >= first && G.g + L - 1 <= last, inSel: false, cat: G.cat, vals: G.vals };
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
    const box = $('cchBox'), W = Math.max(400, box.clientWidth), H = Math.max(200, box.clientHeight);
    if (!d.cards.length || !n) { box.innerHTML = `<div class="nodata2">${d.cards.length ? 'No complete periods here. Untick “Hide incomplete periods” or widen the dates.' : 'No spend found for these filters.'}</div>`; return; }
    const two = false, L = 58, R = 58, T = 26, B = part !== 'm' && incomplete ? 40 : 28, X0 = L, X1 = W - R, Y0 = H - B;
    const idxOf = new Map(pool.map((c, j) => [c.name, j]));
    const shown = pool.filter(c => !hiddenBrands.has(c.name));
    const maxCat = niceMax(Math.max(0, ...periods.map(p => p.cat)) / 1000);
    const maxBr = niceMax(Math.max(0, ...periods.flatMap(p => shown.map(c => p.vals[idxOf.get(c.name)]))) / 1000);
    const yc = v => Y0 - (v / 1000 / maxCat) * (Y0 - T), yb = v => Y0 - (v / 1000 / maxBr) * (Y0 - T);
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
    const axisTitle = x => `<text transform="translate(${x},${(T + Y0) / 2}) rotate(-90)" text-anchor="middle" font-size="11" font-weight="700" fill="#1A1F36">Investments in (Rs. in Mn)</text>`;
    const selFirst = periods.findIndex(p => p.inSel);
    const band = part === 'm' && selFirst >= 0 ? `<rect x="${X0 + gw * selFirst}" y="${T - 8}" width="${gw * (n - selFirst)}" height="${Y0 - T + 8}" fill="#FF8A3D" fill-opacity="0.07"></rect>`
      + (selFirst > 0 ? `<text x="${X0 + gw * selFirst + 6}" y="${T - 12}" font-size="10" font-weight="800" fill="#E4702A">SELECTED PERIOD · ${esc(curLabel)}</text>` : '') : '';
    let cats = '', brands = '', labels = '', hatch = '';
    const showLabels = ui.labels;
    periods.forEach((p, i) => {
      const cx = X0 + gw * (i + 0.5), note = p.complete ? '' : '\nIncomplete period';
      const v = p.cat, top = yc(v);
      if (v > 0) {
        cats += `<rect x="${cx - catW / 2}" y="${top}" width="${catW}" height="${Math.max(0, Y0 - top)}" fill="url(#cchGreen)" data-tip="${esc(`Category · ${p.tipLabel}\nRs ${nf(v / 1000, 0)} Mn${note}`)}"></rect>`;
        if (!p.complete) hatch += `<rect x="${cx - catW / 2}" y="${top}" width="${catW}" height="${Math.max(0, Y0 - top)}" fill="url(#cchHatch)" pointer-events="none"></rect>`;
        if (showLabels) { const t = nf(v / 1000, 0), w = t.length * 7 + 10; labels += `<rect x="${cx - w / 2}" y="${top - 18}" width="${w}" height="16" rx="3" fill="#8BD051"></rect><text x="${cx}" y="${top - 6}" text-anchor="middle" font-size="11" font-weight="800" fill="#111">${t}</text>`; }
      }
      const here = shown.filter(c => p.vals[idxOf.get(c.name)] > 0), groupW = here.length * bw;
      here.forEach((c, j) => {
        const bv = p.vals[idxOf.get(c.name)], bx = cx - groupW / 2 + j * bw, by = yb(bv), col = colors.get(c.name);
        brands += `<rect x="${bx}" y="${by}" width="${bw - 1}" height="${Math.max(0, Y0 - by)}" fill="${col}" data-tip="${esc(`${c.name}${c.mine ? ' (mine)' : ''} · ${p.tipLabel}\nRs ${nf(bv / 1000, 0)} Mn${note}`)}"></rect>`;
        if (!p.complete) hatch += `<rect x="${bx}" y="${by}" width="${bw - 1}" height="${Math.max(0, Y0 - by)}" fill="url(#cchHatch)" pointer-events="none"></rect>`;
        if (showLabels && bw >= 8) { const t = nf(bv / 1000, 0), w = t.length * 6 + 8; labels += `<rect x="${bx + (bw - 1) / 2 - w / 2}" y="${by - 15}" width="${w}" height="14" rx="3" fill="${col}"></rect><text x="${bx + (bw - 1) / 2}" y="${by - 4.5}" text-anchor="middle" font-size="9.5" font-weight="800" fill="#fff">${t}</text>`; }
      });
    });
    const every = Math.ceil(n / Math.max(4, Math.floor((X1 - X0) / (part === 'm' ? 62 : 74))));
    const xl = periods.map((p, i) => (i % every === 0 || i === n - 1 ? `<text x="${X0 + gw * (i + 0.5)}" y="${Y0 + 17}" text-anchor="middle" font-size="11" font-weight="700" fill="#1A1F36">${esc(p.label)}</text>${p.complete ? '' : `<text x="${X0 + gw * (i + 0.5)}" y="${Y0 + 30}" text-anchor="middle" font-size="9" font-weight="800" fill="#E4702A">Incomplete</text>`}` : '')).join('');
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
    const title = single ? `${esc(String(d.filters.pg).toUpperCase())}${t.growth == null ? '' : ' | ' + nf(t.growth, 0) + '% YoY'}` : `${esc(t.none ? 'UNASSIGNED' : t.name.toUpperCase())}${t.growth == null ? '' : ' | ' + nf(t.growth, 0) + '% YoY'}`;
    const scope = single ? { all: true } : { sub: t.name };
    const rows = t.rows.map(r => `<tr class="${r.mine ? 'mine ' : ''}${r.others ? 'oth ' : ''}${r.others ? '' : 'link'}"${r.others ? '' : ` data-mb="${esc(r.name)}"`}><td title="${esc(r.name)}">${esc(r.name)}</td><td class="c1">${numCell(r.yoy)}</td><td class="c2">${numCell(r.prev)}</td><td class="c3">${numCell(r.cur)}</td><td>${pctCell(r.growth)}</td><td>${r.cur > 0 ? nf(r.share, 0) + '%' : ''}</td></tr>`).join('');
    return `<div class="tblock"><div class="ttl link" data-scope="${esc(JSON.stringify(scope))}" title="Click for details"><i style="background:${color}"></i><span>${title}</span></div>
      <table class="ctab2"><tr><th>Brand</th><th>${esc(tabLabel(L.yoy))}</th><th>${esc(tabLabel(L.prev))}</th><th>${esc(tabLabel(L.cur))}</th><th>YoY</th><th>Shr.</th></tr>${rows}
      <tr class="tot"><td>${esc(single ? String(d.filters.pg).toUpperCase() : (t.none ? 'UNASSIGNED' : t.name.toUpperCase()))}</td><td>${numCell(t.yoy)}</td><td>${numCell(t.prev)}</td><td>${numCell(t.cur)}</td><td>${pctCell(t.growth)}</td><td></td></tr></table></div>`;
  }
  function renderSubs(d, L) {
    const T = d.tables, f = d.filters;
    heading($('catTitle3'), 's3', subsHeadline(d, L));
    $('catSub3').textContent = d.hasSubs && T.length > 1
      ? `Sub categories of ${f.pg} · ${L.cur} against ${L.yoy} and ${L.prev} | Investment in Rs. Mn`
      : `Mother brands in ${f.sub || f.pg} · ${L.cur} against ${L.yoy} and ${L.prev} | Investment in Rs. Mn`;
    const host = $('catSubs');
    if (!T.length) { host.className = 'csubs single'; host.innerHTML = '<div class="nodata2">No spend found for these filters.</div>'; return; }
    const colors = T.map((t, i) => SUB_COLORS[i % SUB_COLORS.length]);
    const multi = d.hasSubs && T.length > 1;
    host.className = 'csubs' + (multi ? '' : ' single');
    if (!multi) { host.innerHTML = tableHtml(T[0], T[0] && '#F24B4B', d, L, !d.hasSubs); return; }
    // Mix of sub categories in each period (100% bars).
    let mix = '';
    if (d.mix && d.mix.yoy) {
      const rows = [[L.yoy, d.mix.yoy], d.mix.prev ? [L.prev, d.mix.prev] : null, [L.cur, d.mix.cur, true]].filter(Boolean);
      mix = `<div class="mixblock"><div class="cblock-t cedit" id="catMixT" contenteditable="true" spellcheck="false" data-key="mix"></div>
        ${rows.map(([lab, arr, now]) => `<div class="mixrow${now ? ' now' : ''}"><span class="lab">${esc(lab)}</span><div class="mixbar">${arr.map((p, i) => (p > 0 ? `<i style="width:${p}%;background:${colors[i]}" title="${esc(T[i].name)} ${nf(p, 1)}%">${p >= 4 ? nf(p, 0) + '%' : ''}</i>` : '')).join('')}</div></div>`).join('')}
        <div class="mixlg">${T.map((t, i) => `<span><i style="background:${colors[i]}"></i>${esc(t.name)}</span>`).join('')}</div></div>`;
    }
    let contrib = '';
    if (d.contribution) {
      contrib = `<div class="contblock"><div class="cblock-t cedit" id="catContT" contenteditable="true" spellcheck="false" data-key="contrib"></div>
        ${d.contribution.map((c, i) => `<div class="controw link" data-scope="${esc(JSON.stringify({ sub: c.name }))}"><i style="background:${colors[i]}"></i><b>${esc(c.name)}</b><span class="mv">${mnNum(c.yoy)} → ${mnNum(c.cur)}</span><span class="gv ${c.growth == null ? 'flat' : c.growth > 0.5 ? 'pos' : c.growth < -0.5 ? 'neg' : 'flat'}">${c.growth == null ? '—' : nf(c.growth, 0) + '%'}</span></div>`).join('')}
        <div class="contfoot"><span></span><span></span><span class="fl"><u>${esc(L.yoy)}</u><u>${esc(L.cur)}</u></span><u>Y-O-Y</u></div></div>`;
    }
    const left = [mix], right = [contrib];
    T.forEach((t, i) => { (i === 0 || (i >= 3 && i % 2 === 1) ? right : left).push(tableHtml(t, colors[i], d, L, false)); });
    host.innerHTML = `<div class="ccol">${left.join('')}</div><div class="ccol">${right.join('')}</div>`;
    if (mix) heading($('catMixT'), 'mix', mixTitle(d));
    if (contrib) heading($('catContT'), 'contrib', contribTitle(d));
  }
  $('catSubs').addEventListener('click', e => {
    if (e.target.closest('.cedit')) return;
    const r = e.target.closest('tr[data-mb]');
    if (r) { openDetail({ mb: r.dataset.mb }); return; }
    const sc = e.target.closest('[data-scope]');
    if (sc) { try { openDetail(JSON.parse(sc.dataset.scope)); } catch (err) { /* bad scope */ } }
  });

  // ---------- section navigation ----------
  $('catNav').addEventListener('click', e => {
    const b = e.target.closest('button[data-s]');
    if (b) $(b.dataset.s).scrollIntoView({ behavior: 'smooth', block: 'start' });
  });
  $('catScroll').addEventListener('scroll', () => {
    const sc = $('catScroll'), mid = sc.scrollTop + sc.clientHeight / 2;
    let on = 'catS1';
    for (const id of ['catS1', 'catS2', 'catS3']) if ($(id).offsetTop <= mid) on = id;
    [...$('catNav').children].forEach(b => b.classList.toggle('on', b.dataset.s === on));
  });

  // ---------- card detail ----------
  $('catGrid').addEventListener('click', e => {
    const card = e.target.closest('.ccard');
    if (card) openDetail({ mb: card.dataset.mb });
  });
  const closeModal = () => $('catModal').classList.remove('on');
  $('catModal').addEventListener('click', e => { if (e.target.id === 'catModal' || e.target.closest('.x')) closeModal(); });
  document.addEventListener('keydown', e => { if (e.key === 'Escape') closeModal(); });
  // scope: { mb } one mother brand, { sub } one sub category, { all: true } the whole selection.
  async function openDetail(scope) {
    $('catModalBox').innerHTML = '<div class="cm-h"><h3>Loading…</h3></div>';
    $('catModal').classList.add('on');
    try {
      const d = await engine.call('catDetail', { filters: data.filters, scope });
      const { cur, yoy } = labelsOf(data);
      const card = scope.mb ? data.cards.find(c => c.name === scope.mb) : null;
      const row = scope.mb ? data.tables.flatMap(t => t.rows).find(r => r.name === scope.mb) : null;
      const mine = !!((card && card.mine) || (row && row.mine));
      const g = d.yoy > 0 ? ((d.cur - d.yoy) / d.yoy) * 100 : null;
      const med = d.monthly.reduce((a, m) => [a[0] + m.tv, a[1] + m.radio, a[2] + m.press], [0, 0, 0]);
      const medTot = med[0] + med[1] + med[2];
      const share = data.total.cur ? (d.cur / data.total.cur) * 100 : 0;
      const growthCell = (c, p) => (p > 0 ? `<span class="${c >= p ? 'up' : 'down'}">${c >= p ? '▲' : '▼'} ${nf(Math.abs(((c - p) / p) * 100), 0)}%</span>` : '—');
      const table = (title, rows, kind) => rows.length ? `<div><h4 style="font-size:11px;letter-spacing:.8px;text-transform:uppercase;color:#6B7590;margin-bottom:6px">${title}</h4><table class="cm-t"><tr><th>Name</th><th>${esc(cur)}</th><th>${esc(yoy)}</th><th>Growth</th><th>Share</th></tr>${rows.slice(0, 12).map(r => `<tr${kind === 'mb' ? ` class="link" data-mb="${esc(r.name)}"` : ''}><td title="${esc(r.name)}">${esc(r.name)}</td><td>${mnNum(r.cur)}</td><td>${r.yoy > 0 ? mnNum(r.yoy) : '–'}</td><td>${growthCell(r.cur, r.yoy)}</td><td>${nf(r.share, 0)}%</td></tr>`).join('')}</table></div>` : '';
      const where = scope.mb ? `${esc(data.filters.pg)} · ${esc(cur)}${card ? ` · rank #${card.rank} of ${data.brandCount}` : ''}` : `${esc(data.filters.pg)} · ${esc(cur)}${scope.sub ? ' · sub category' : ''}`;
      const tables = scope.mb ? table('Advertisers', d.advertisers) + table('Brands', d.brands) + (d.subs.length > 1 ? table('Sub categories', d.subs) : '')
        : table('Mother brands', d.mothers, 'mb') + table('Advertisers', d.advertisers) + table('Brands', d.brands);
      $('catModalBox').innerHTML = `
        <div class="cm-h"><h3>${esc(d.name)}</h3>${mine ? '<span class="cm-tag">US</span>' : ''}<span style="color:#8A93AD;font-size:12px">${where}</span><button class="x">✕</button></div>
        <div class="cm-stats">
          <div class="cm-st"><span>${esc(cur)}</span><b>${mnTxt(d.cur)}</b></div>
          <div class="cm-st"><span>${esc(yoy)}</span><b>${d.yoy > 0 ? mnTxt(d.yoy) : '–'}</b></div>
          <div class="cm-st"><span>Y-o-Y growth</span><b style="color:${g == null ? '#9AA3BC' : g >= 0 ? '#14803F' : '#D12B2B'}">${g == null ? '—' : (g >= 0 ? '▲ ' : '▼ ') + nf(Math.abs(g), 0) + '%'}</b></div>
          <div class="cm-st"><span>Share of category</span><b>${nf(share, 1)}%</b></div>
        </div>
        <div class="cm-sec"><h4>Monthly spend by medium (Rs. Mn)</h4>${monthlyChart(d)}
          <div style="display:flex;gap:14px;font-size:10.5px;color:#4A5570;font-weight:600;margin:2px 0 8px">${MED.map((m, k) => `<span><i style="display:inline-block;width:10px;height:10px;border-radius:3px;background:${MED_COL[k]};margin-right:4px"></i>${m} ${nf(medTot ? (med[k] / medTot) * 100 : 0, 0)}%</span>`).join('')}<span style="margin-left:auto"><i style="display:inline-block;width:14px;border-top:2px dashed #8A93AD;margin-right:4px;vertical-align:3px"></i>${esc(yoy)} total</span></div></div>
        <div class="cm-two">${tables}</div>`;
    } catch (err) { $('catModalBox').innerHTML = `<div class="cm-h"><h3>Could not load</h3><button class="x">✕</button></div><div style="padding:20px">${esc(err.message)}</div>`; }
  }
  $('catModalBox').addEventListener('click', e => { const r = e.target.closest('tr[data-mb]'); if (r) openDetail({ mb: r.dataset.mb }); });
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
      return `<g><title>${monLabel(m.key)}: ${mnTxt(tot(m))}</title>${segs}${label}${xl}</g>`;
    }).join('');
    const line = d.monthly.map((m, i) => `${i ? 'L' : 'M'}${(X0 + slot * (i + 0.5)).toFixed(1)},${y(m.yoy).toFixed(1)}`).join('');
    const hasY = d.monthly.some(m => m.yoy > 0);
    return `<svg viewBox="0 0 ${W} ${H}" style="width:100%;height:auto;display:block">${grid}${bars}${hasY ? `<path d="${line}" fill="none" stroke="#8A93AD" stroke-width="1.8" stroke-dasharray="5 4"></path>` : ''}</svg>`;
  }

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
  const SECTIONS = [['01_Cards', 'catS1'], ['02_Month_by_Month', 'catS2'], ['03_Sub_Categories', 'catS3']];

  // Each section as its own JPG, in a ZIP. Sections are shown in full (all cards, the whole page 3).
  async function exportJpg() {
    toast('Preparing JPG images');
    const root = $('viewCat'), scroll = $('catScroll');
    const saved = scroll.scrollTop;
    try {
      await Promise.all([loadScript('vendor/html-to-image/html-to-image.js'), loadScript('vendor/jszip/jszip.min.js')]);
      $('catDrawerToggle').checked = false;
      scroll.style.scrollBehavior = 'auto';
      root.classList.add('exporting');
      const zip = new window.JSZip();
      for (const [name, id] of SECTIONS) {
        const el = $(id);
        el.scrollIntoView({ block: 'start' });
        await new Promise(r => setTimeout(r, 120));
        const grid = $('catGrid');
        const extra = id === 'catS1' ? Math.max(0, grid.scrollHeight - grid.clientHeight) : 0;
        const prevH = el.style.height;
        if (extra) el.style.height = (el.offsetHeight + extra) + 'px';
        if (extra) { grid.style.overflow = 'visible'; grid.style.flex = 'none'; }
        const w = el.offsetWidth, h = el.offsetHeight;
        const url = await window.htmlToImage.toJpeg(el, { quality: 0.95, pixelRatio: 2, backgroundColor: '#F4F6FA', width: w, height: h, style: { transform: 'none' } });
        el.style.height = prevH; grid.style.overflow = ''; grid.style.flex = '';
        zip.file(`${name}.jpg`, url.split(',')[1], { base64: true });
      }
      download(await zip.generateAsync({ type: 'blob' }), fileBase() + '_JPG.zip');
      toast('JPG images downloaded');
    } catch (e) { toast('Export failed: ' + e.message); } finally {
      root.classList.remove('exporting'); scroll.scrollTop = saved; scroll.style.scrollBehavior = '';
      if (data) { sizeGrid(); renderChart(data, null); }
    }
  }
  // Editable PowerPoint: real text, shapes, tables and a real chart, one slide per section (more if a section is long).
  async function exportPpt() {
    toast('Preparing PowerPoint');
    try {
      await loadScript('vendor/pptxgenjs/pptxgen.bundle.js');
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

      // ----- slide(s) 1: cards, ten to a slide -----
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
        const maxCat = niceMax(Math.max(0, ...periods.map(p => p.cat)) / 1000), maxBr = niceMax(Math.max(0, ...periods.flatMap(p => shown.map(c => p.vals[pidx.get(c.name)]))) / 1000);
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
    try { localStorage.setItem(MODE, toCat ? 'cat' : 'spot'); } catch (e) { /* storage unavailable */ }
  });

  // ---------- boot (after the data engine knows who is signed in) ----------
  async function boot() {
    try {
      const s = await engine.call('catInit');
      renderFile(s.dataset);
      started = true;
      if (s.dataset) await loadOverview(false); else { showEmpty(); }
      let mode = null;
      try { mode = localStorage.getItem(MODE); } catch (e) { /* storage unavailable */ }
      if (mode === 'cat') { document.body.classList.add('mode-cat'); applyModeText(); ensureStarted(); }
    } catch (e) { toast('Category data: ' + e.message); }
  }
  if (O.ready) boot(); else document.addEventListener('orbit:ready', boot, { once: true });
})();
