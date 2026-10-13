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
  const MED = ['TV', 'Radio', 'Press'], MED_COL = ['#2F5DBF', '#FF8A3D', '#1FA97A'];

  let overview = null, options = { advertisers: [], subs: [] }, data = null, pendingFile = null, started = false, busy = false;
  const state = { from: '', to: '', pg: '', sub: '', mine: [], comps: [], top: 10, yearType: 'CY' };

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
  // The latest whole quarter / half / year that ends on a boundary of the chosen year type.
  function latest(len) {
    const maxI = idx(overview.maxMonth), minI = idx(overview.minMonth), shift = state.yearType === 'FY' ? 3 : 0;
    let end = maxI;
    while (end - len + 1 >= minI && ((end + 1 - shift) % len + len) % len !== 0) end--;
    if (end - len + 1 < minI) return [overview.minMonth, overview.maxMonth];
    return [keyOf(end - len + 1), keyOf(end)];
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
    $('catGrid').innerHTML = ''; $('catLegend').innerHTML = '';
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
    renderSubSelect();
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
  $('cFrom').addEventListener('change', e => { state.from = e.target.value; if (state.from > state.to) { state.to = state.from; $('cTo').value = state.to; } });
  $('cTo').addEventListener('change', e => { state.to = e.target.value; if (state.from > state.to) { state.from = state.to; $('cFrom').value = state.from; } });
  $('cPg').addEventListener('change', async e => { state.pg = e.target.value; state.sub = ''; await loadOptions(true); writeForm(); });
  $('cSub').addEventListener('change', async e => { state.sub = e.target.value; await loadOptions(false); writeForm(); });
  $('cQuick').addEventListener('click', e => {
    const b = e.target.closest('.seg');
    if (!b || !overview) return;
    [state.from, state.to] = latest({ q: 3, h: 6, y: 12 }[b.dataset.v]);
    writeForm();
  });
  $('cYearType').addEventListener('click', e => {
    const b = e.target.closest('.seg');
    if (!b) return;
    state.yearType = b.dataset.v === 'FY' ? 'FY' : 'CY';
    [...$('cYearType').children].forEach(x => x.classList.toggle('on', x === b));
    save(); if (data) render();   // only the period names change, so no recalculation
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
      render();
      if (!state.mine.length) toast('Tip: pick your advertiser under Filters to highlight your brands');
    } catch (e) { toast(e.message); } finally { document.body.classList.remove('loading'); }
  }
  const titleKey = pg => 'orbit-cat-title:' + pg;
  function render() {
    const d = data, yt = state.yearType, R = d.ranges;
    const cur = periodLabel(R.cur[0], R.cur[1], yt), yoy = periodLabel(R.yoy[0], R.yoy[1], yt), prev = periodLabel(R.prev[0], R.prev[1], yt);
    const f = d.filters;
    const title = $('catTitle');
    let saved = null;
    try { saved = localStorage.getItem(titleKey(f.pg)); } catch (e) { /* storage unavailable */ }
    if (document.activeElement !== title) title.textContent = saved || `Leading ${f.pg} Brands by Investment`;
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
    if (!d.cards.length) { $('catGrid').innerHTML = '<div class="nodata2">No spend found for these filters.</div>'; renderLegend(cur, yoy, prev); return; }
    let ci = 0;
    $('catGrid').innerHTML = d.cards.map((c, i) => {
      const color = c.mine ? US : COLORS[ci++ % COLORS.length];
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
        <div class="cc-s"><span>${esc(cur)} share</span><b>${nf(c.share, 0)}%</b></div>
        <div class="cc-bar"><i style="width:${Math.max(c.share > 0 ? 2 : 0, Math.min(100, c.share))}%"></i></div>
        <div class="cc-med">${c.medium.map((v, k) => `<i style="width:${medTot ? (v / medTot) * 100 : 0}%;background:${MED_COL[k]}"></i>`).join('')}</div>
      </div>`;
    }).join('');
    renderLegend(cur, yoy, prev);
  }
  function renderLegend(cur, yoy, prev) {
    $('catLegend').innerHTML = `
      <div class="li"><span class="sw" style="background:#2F6FD3"></span><div><b>Investment amount</b><small>${esc(yoy)}, ${esc(prev)} and ${esc(cur)} (Rs. Mn)</small></div></div>
      <div class="li"><span class="sw" style="background:#1E8E4E"></span><div><b>Y-o-Y growth</b><small>${esc(cur)} versus ${esc(yoy)}</small></div></div>
      <div class="li"><span class="sw" style="background:#7B4FA0"></span><div><b>Share of investment</b><small>Share of total ${esc(cur)} investment</small></div></div>
      <div class="mdots">${MED.map((m, k) => `<span><i style="background:${MED_COL[k]}"></i>${m}</span>`).join('')}</div>`;
  }
  // The headline is editable (e.g. to write the insight for a slide); it is remembered per product group.
  $('catTitle').addEventListener('blur', () => {
    if (!data) return;
    const t = $('catTitle').textContent.trim();
    try { if (t) localStorage.setItem(titleKey(data.filters.pg), t); else localStorage.removeItem(titleKey(data.filters.pg)); } catch (e) { /* storage unavailable */ }
    render();
  });
  $('catTitle').addEventListener('keydown', e => { if (e.key === 'Enter') { e.preventDefault(); e.target.blur(); } });

  // ---------- card detail ----------
  $('catGrid').addEventListener('click', e => {
    const card = e.target.closest('.ccard');
    if (card) openDetail(card.dataset.mb);
  });
  const closeModal = () => $('catModal').classList.remove('on');
  $('catModal').addEventListener('click', e => { if (e.target.id === 'catModal' || e.target.closest('.x')) closeModal(); });
  document.addEventListener('keydown', e => { if (e.key === 'Escape') closeModal(); });
  async function openDetail(name) {
    const card = data.cards.find(c => c.name === name);
    $('catModalBox').innerHTML = '<div class="cm-h"><h3>Loading…</h3></div>';
    $('catModal').classList.add('on');
    try {
      const d = await engine.call('catDetail', { filters: data.filters, scope: { mb: name } });
      const R = data.ranges, yt = state.yearType;
      const cur = periodLabel(R.cur[0], R.cur[1], yt), yoy = periodLabel(R.yoy[0], R.yoy[1], yt);
      const g = d.yoy > 0 ? ((d.cur - d.yoy) / d.yoy) * 100 : null;
      const medTot = card.medium[0] + card.medium[1] + card.medium[2];
      const growthCell = (c, p) => (p > 0 ? `<span class="${c >= p ? 'up' : 'down'}">${c >= p ? '▲' : '▼'} ${nf(Math.abs(((c - p) / p) * 100), 0)}%</span>` : '—');
      const table = (title, rows) => rows.length ? `<div><h4 style="font-size:11px;letter-spacing:.8px;text-transform:uppercase;color:#6B7590;margin-bottom:6px">${title}</h4><table class="cm-t"><tr><th>Name</th><th>${esc(cur)}</th><th>${esc(yoy)}</th><th>Growth</th><th>Share</th></tr>${rows.slice(0, 12).map(r => `<tr><td title="${esc(r.name)}">${esc(r.name)}</td><td>${mnNum(r.cur)}</td><td>${r.yoy > 0 ? mnNum(r.yoy) : '–'}</td><td>${growthCell(r.cur, r.yoy)}</td><td>${nf(r.share, 0)}%</td></tr>`).join('')}</table></div>` : '';
      $('catModalBox').innerHTML = `
        <div class="cm-h"><h3>${esc(d.name)}</h3>${card.mine ? '<span class="cm-tag">US</span>' : ''}<span style="color:#8A93AD;font-size:12px">${esc(data.filters.pg)} · ${esc(cur)} · rank #${card.rank} of ${data.brandCount}</span><button class="x">✕</button></div>
        <div class="cm-stats">
          <div class="cm-st"><span>${esc(cur)}</span><b>${mnTxt(d.cur)}</b></div>
          <div class="cm-st"><span>${esc(yoy)}</span><b>${d.yoy > 0 ? mnTxt(d.yoy) : '–'}</b></div>
          <div class="cm-st"><span>Y-o-Y growth</span><b style="color:${g == null ? '#9AA3BC' : g >= 0 ? '#14803F' : '#D12B2B'}">${g == null ? '—' : (g >= 0 ? '▲ ' : '▼ ') + nf(Math.abs(g), 0) + '%'}</b></div>
          <div class="cm-st"><span>Share of category</span><b>${nf(card.share, 1)}%</b></div>
        </div>
        <div class="cm-sec"><h4>Monthly spend by medium (Rs. Mn)</h4>${monthlyChart(d)}
          <div style="display:flex;gap:14px;font-size:10.5px;color:#4A5570;font-weight:600;margin:2px 0 8px">${MED.map((m, k) => `<span><i style="display:inline-block;width:10px;height:10px;border-radius:3px;background:${MED_COL[k]};margin-right:4px"></i>${m} ${nf(medTot ? (card.medium[k] / medTot) * 100 : 0, 0)}%</span>`).join('')}<span style="margin-left:auto"><i style="display:inline-block;width:14px;border-top:2px dashed #8A93AD;margin-right:4px;vertical-align:3px"></i>${esc(yoy)} total</span></div></div>
        <div class="cm-two">${table('Advertisers', d.advertisers)}${table('Brands', d.brands)}${d.subs.length ? table('Sub categories', d.subs) : ''}</div>`;
    } catch (err) { $('catModalBox').innerHTML = `<div class="cm-h"><h3>Could not load</h3><button class="x">✕</button></div><div style="padding:20px">${esc(err.message)}</div>`; }
  }
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

  // ---------- save image ----------
  $('catSaveBtn').addEventListener('click', async () => {
    if (!data) { toast('Nothing to save yet'); return; }
    try {
      if (!window.htmlToImage) await new Promise((ok, fail) => { const el = document.createElement('script'); el.src = 'vendor/html-to-image/html-to-image.js'; el.onload = ok; el.onerror = () => fail(new Error('Could not load the image tool')); document.head.appendChild(el); });
      const node = $('viewCat');
      node.classList.add('exporting');
      const url = await window.htmlToImage.toPng(node, { pixelRatio: 2, backgroundColor: '#F4F6FA', filter: n => !(n.classList && n.classList.contains('coverlay')) });
      node.classList.remove('exporting');
      const a = document.createElement('a');
      const R = data.ranges;
      a.href = url; a.download = `Category_${data.filters.pg}_${periodLabel(R.cur[0], R.cur[1], state.yearType)}`.replace(/[^A-Za-z0-9_'-]+/g, '_') + '.png';
      a.click();
      toast('Image saved');
    } catch (e) { toast('Could not save the image: ' + e.message); }
  });

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
