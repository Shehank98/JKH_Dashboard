'use strict';
(function () {
  const $ = id => document.getElementById(id);
  const esc = s => String(s == null ? '' : s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const MON = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

  const C = {
    orange: '#FF8A3D', deep: '#E4702A', oTints: ['#FF8A3D', '#FFA766', '#FFC599', '#FFDCC0'],
    blues: ['#2F5DBF', '#5B8DEF', '#8FB2F5', '#BFD3F6'],
    medium: ['#2F5DBF', '#5B8DEF', '#A8C2F2'],
    compLines: ['#5B8DEF', '#9AA6C4', '#C7CEDF', '#2F5DBF', '#8FB2F5', '#B4BCD0', '#1E3F8A', '#A8C2F2', '#BFD3F6'],
    // Light to dark as the ads get longer: 5s, 15s, 20s, 30s, 30s+
    durMine: ['#FFD2AE', '#FFAA6E', '#FF8A3D', '#D9661F', '#9E4510'], durComp: ['#BFD3F6', '#7FA5EE', '#4474D6', '#1E3F8A', '#0D2257'],
  };

  // ---------- state ----------
  let overview = null;      // product groups, date bounds
  let options = { advertisers: [], channels: [] };
  let data = null;          // last dashboard response
  const state = { from: '', to: '', pg: '', mine: [], comps: [], medium: 'All', channel: '', daypart: '', adType: 'All' };
  let pendingFile = null;
  const hiddenSeries = new Set();                // trend lines switched off from the legend
  const mixView = { mx: 'bars' };                // channel mix: Top 5 bars or heatmap
  const heatSide = { mx: 'cat' };                // heatmap: category or mine
  let mixMedium = 'TV';                          // channel mix: TV, Radio or Press
  let durMedium = 'All';
  let sosView = 'period';                        // SOS table: whole period or by month                         // duration mix: All (TV + Radio), TV or Radio
  let pollTimer = null;

  // ---------- helpers ----------
  const api = async (url, opts) => {
    const r = await fetch(url, opts);
    const j = await r.json().catch(() => ({}));
    if (!r.ok) throw new Error(j.error || r.statusText);
    return j;
  };
  const nf = (v, d = 0) => Number(v || 0).toLocaleString('en-US', { minimumFractionDigits: d, maximumFractionDigits: d });
  function money(v, withLkr = true) {
    const a = Math.abs(v || 0);
    const s = a >= 1e9 ? nf(v / 1e9, 2) + ' Bn' : a >= 1e6 ? nf(v / 1e6, 1) + ' Mn' : a >= 1e3 ? nf(v / 1e3, 0) + 'K' : nf(v, 0);
    return withLkr ? 'LKR ' + s : s;
  }
  const mn = v => nf(v / 1e6, 1) + ' Mn';
  const fmtDate = iso => { if (!iso) return ''; const [y, m, d] = iso.split('-'); return `${d} ${MON[+m - 1]} ${y}`; };
  function monthsBetween(a, b) {
    const [y1, m1] = a.split('-').map(Number), [y2, m2] = b.split('-').map(Number);
    return (y2 - y1) * 12 + (m2 - m1) + 1;
  }
  function delta(cur, prev, suffix = 'vs prev. period') {
    if (prev == null) return '';
    if (!prev) return `<span class="flat">new</span> ${suffix}`;
    const p = ((cur - prev) / prev) * 100;
    const cls = p > 0.05 ? 'up' : p < -0.05 ? 'down' : 'flat';
    const arrow = p > 0.05 ? '▲' : p < -0.05 ? '▼' : '■';
    return `<span class="${cls}">${arrow} ${nf(Math.abs(p), 1)}%</span> ${suffix}`;
  }
  function ppDelta(cur, prev) {
    if (prev == null) return '';
    const d = cur - prev;
    const cls = d > 0.05 ? 'up' : d < -0.05 ? 'down' : 'flat';
    const arrow = d > 0.05 ? '▲' : d < -0.05 ? '▼' : '■';
    return `<span class="${cls}">${arrow} ${nf(Math.abs(d), 1)} pp</span> vs prev. period`;
  }
  const join = parts => parts.filter(Boolean).join(' · ');
  // Attribute helpers: a hover tooltip (lines split by \n) and a click-through detail scope.
  const tipA = text => ` data-tip="${esc(text)}"`;
  const detA = scope => ` data-detail="${esc(JSON.stringify(scope))}"`;
  const pctS = v => nf(v, 1) + '%';
  function toast(msg) {
    const t = $('toast');
    t.textContent = msg; t.classList.add('on');
    clearTimeout(toast.t); toast.t = setTimeout(() => t.classList.remove('on'), 2200);
  }
  // Light segments get dark text for contrast.
  const segClass = (color) => (['#BFD3F6', '#8FB2F5', '#A8C2F2'].includes(color) ? 'lt' : ['#FFDCC0', '#FFC599'].includes(color) ? 'lto' : '');

  // ---------- full screen: fill the window, scale down only below 1280 x 720 ----------
  function fit() {
    const W = window.innerWidth, H = window.innerHeight;
    // Size comes from CSS (100vw / --s), so the page always fills the window even if this runs late.
    document.body.style.setProperty('--s', Math.min(1, W / 1280, H / 720).toFixed(4));
    if (data) renderTrend(data);
  }
  let fitFrame = 0;
  const refit = () => { cancelAnimationFrame(fitFrame); fitFrame = requestAnimationFrame(fit); };
  window.addEventListener('resize', refit);
  document.addEventListener('visibilitychange', refit);
  fit();

  // ---------- drawer tabs ----------
  function showPane(id) {
    document.querySelectorAll('.tab').forEach(t => t.classList.toggle('on', t.dataset.pane === id));
    document.querySelectorAll('.pane').forEach(p => p.classList.toggle('on', p.id === id));
    $('dfoot').style.display = id === 'paneFilters' ? '' : 'none';
  }
  document.querySelectorAll('.tab').forEach(t => t.addEventListener('click', () => showPane(t.dataset.pane)));
  $('ovBtn').addEventListener('click', () => { if (!overview) showPane('paneData'); });

  // ---------- persistence of the viewer's last filters ----------
  function saveState() { try { localStorage.setItem('cas-filters', JSON.stringify(state)); } catch (e) { /* storage unavailable */ } }
  function readSaved() {
    try {
      if (location.hash.length > 1) return JSON.parse(decodeURIComponent(location.hash.slice(1)));
    } catch (e) { /* bad share link */ }
    try { return JSON.parse(localStorage.getItem('cas-filters') || 'null'); } catch (e) { return null; }
  }

  // ---------- upload ----------
  function renderDataFile(ds) {
    $('dfile').innerHTML = ds ? `<div class="dfile"><b title="${esc(ds.fileName)}">${esc(ds.fileName)}</b>
      <div class="row"><span>${nf(ds.rows)} rows</span><span>${ds.size ? nf(ds.size / 1048576, 1) + ' MB' : ''}</span></div>
      <div class="row"><span>${fmtDate(ds.minDate)} to ${fmtDate(ds.maxDate)}</span></div>
      <div class="row"><span>Uploaded ${new Date(ds.uploadedAt).toLocaleString()}</span></div>
      ${ds.skipped ? `<div class="row"><span>${nf(ds.skipped)} rows skipped (invalid date)</span></div>` : ''}</div>`
      : '<div class="dfile" style="color:#6E7A99">No data file loaded</div>';
    $('deleteBtn').disabled = !ds;
    $('dataDot').style.display = ds ? 'none' : '';
  }
  function setUploadStatus(text, err) { const s = $('ustatus'); s.textContent = text; s.className = 'ustatus' + (err ? ' err' : ''); }
  function setProgress(pct) {
    const p = $('prog');
    if (pct == null) { p.style.display = 'none'; return; }
    p.style.display = 'block';
    p.classList.toggle('indet', pct < 0);
    $('progBar').style.width = pct < 0 ? '' : pct + '%';
  }
  function pickFile(f) {
    if (!f) return;
    if (!/\.(xlsx|xlsm|csv)$/i.test(f.name)) { setUploadStatus('Please choose an .xlsx or .csv file', true); return; }
    pendingFile = f;
    $('dropText').textContent = `${f.name} (${nf(f.size / 1048576, 1)} MB)`;
    $('uploadBtn').disabled = false;
    setUploadStatus('Ready to upload. This replaces the current data.');
  }
  $('fileInput').addEventListener('change', e => pickFile(e.target.files[0]));
  const drop = $('drop');
  ['dragenter', 'dragover'].forEach(ev => drop.addEventListener(ev, e => { e.preventDefault(); drop.classList.add('over'); }));
  ['dragleave', 'drop'].forEach(ev => drop.addEventListener(ev, e => { e.preventDefault(); drop.classList.remove('over'); }));
  drop.addEventListener('drop', e => pickFile(e.dataTransfer.files[0]));

  $('uploadBtn').addEventListener('click', () => {
    if (!pendingFile) return;
    const fd = new FormData();
    fd.append('file', pendingFile);
    const xhr = new XMLHttpRequest();
    xhr.open('POST', '/api/upload');
    $('uploadBtn').disabled = true; $('deleteBtn').disabled = true;
    xhr.upload.onprogress = e => {
      if (!e.lengthComputable) return;
      const p = Math.round((e.loaded / e.total) * 100);
      setProgress(p); setUploadStatus(`Uploading ${p}%`);
    };
    xhr.onload = () => {
      let j = {};
      try { j = JSON.parse(xhr.responseText); } catch (e) { /* ignore */ }
      if (xhr.status >= 400) { setProgress(null); setUploadStatus(j.error || 'Upload failed', true); $('uploadBtn').disabled = false; renderDataFile(j.dataset); return; }
      pendingFile = null; $('fileInput').value = '';
      $('dropText').textContent = 'Drop .xlsx or .csv here, or click to choose';
      pollStatus();
    };
    xhr.onerror = () => { setProgress(null); setUploadStatus('Network error during upload', true); $('uploadBtn').disabled = false; };
    xhr.send(fd);
  });

  $('deleteBtn').addEventListener('click', async () => {
    if (!confirm('Delete the uploaded data? The dashboard will be empty until a new file is uploaded.')) return;
    try {
      await api('/api/data', { method: 'DELETE' });
      overview = null; data = null;
      renderDataFile(null); setUploadStatus('Data deleted.');
      showEmpty();
    } catch (e) { setUploadStatus(e.message, true); }
  });

  async function pollStatus() {
    clearTimeout(pollTimer);
    let s;
    try { s = await api('/api/status'); } catch (e) { pollTimer = setTimeout(pollStatus, 2000); return; }
    renderDataFile(s.dataset);
    const job = s.job;
    if (job.state === 'processing') {
      setProgress(-1);
      setUploadStatus(`Processing ${job.fileName}: ${nf(job.rows)} rows read`);
      $('uploadBtn').disabled = true; $('deleteBtn').disabled = true;
      busyChip(`Processing upload · ${nf(job.rows)} rows`);
      pollTimer = setTimeout(pollStatus, 1000);
      return;
    }
    busyChip(null);
    setProgress(null);
    $('uploadBtn').disabled = !pendingFile;
    if (job.state === 'error') setUploadStatus(`Could not process ${job.fileName}: ${job.error}`, true);
    else if (job.lastFile && s.dataset && (!overview || overview.meta.uploadedAt !== s.dataset.uploadedAt)) {
      setUploadStatus(`Loaded ${nf(s.dataset.rows)} rows in ${nf(s.dataset.parseMs / 1000, 1)}s.`);
      await loadOverview(true);
    }
  }
  function busyChip(text) {
    let el = $('busyChip');
    if (!text) { if (el) el.remove(); return; }
    if (!el) { el = document.createElement('span'); el.id = 'busyChip'; el.className = 'chip busy'; $('chips').prepend(el); }
    el.textContent = text;
  }

  // ---------- filters ----------
  async function loadOverview(fresh) {
    overview = await api('/api/overview');
    const saved = fresh ? null : readSaved();
    $('fPg').innerHTML = overview.productGroups.map(g => `<option>${esc(g.name)}</option>`).join('');
    $('fDaypart').innerHTML = '<option value="">All dayparts</option>' +
      overview.dayparts.map(d => `<option value="${esc(d.name)}">${esc(dpLabel(d.name))}</option>`).join('');
    const { minDate, maxDate } = overview;
    $('fFrom').min = $('fTo').min = minDate; $('fFrom').max = $('fTo').max = maxDate;

    const groups = overview.productGroups.map(g => g.name);
    if (saved && groups.includes(saved.pg)) {
      Object.assign(state, { adType: 'All' }, saved);
    } else {
      Object.assign(state, defaultDates(), { pg: groups[0], mine: [], comps: [], medium: 'All', channel: '', daypart: '', adType: 'All' });
    }
    await loadOptions(!(saved && saved.pg === state.pg && saved.mine && saved.mine.length));
    writeForm();
    await refresh();
  }

  const dpInfo = name => (overview && overview.dayparts.find(d => d.name === name)) || null;
  const dpLabel = name => { const d = dpInfo(name); return d && /^\d/.test(d.time) ? `${d.name} (${d.time})` : name; };
  function defaultDates() {
    const { minDate, maxDate } = overview, jan = maxDate.slice(0, 4) + '-01-01';
    return { from: jan > minDate ? jan : minDate, to: maxDate };
  }

  async function loadOptions(resetSelection) {
    options = await api('/api/options?pg=' + encodeURIComponent(state.pg));
    const names = options.advertisers.map(a => a.name);
    if (resetSelection) {
      state.mine = names.slice(0, 1);
      state.comps = names.slice(1, 4);
      state.channel = '';
    } else {
      state.mine = state.mine.filter(n => names.includes(n));
      state.comps = state.comps.filter(n => names.includes(n) && !state.mine.includes(n));
      if (state.channel && !options.channels.some(c => c.name === state.channel)) state.channel = '';
    }
  }

  function writeForm() {
    $('fFrom').value = state.from; $('fTo').value = state.to;
    $('fPg').value = state.pg;
    $('fDaypart').value = state.daypart || '';
    [...$('fMedium').children].forEach(b => b.classList.toggle('on', b.dataset.v === state.medium));
    [...$('fAdType').children].forEach(b => b.classList.toggle('on', b.dataset.v === (state.adType || 'All')));
    renderAdvLists();
    renderChannelSelect();
  }

  function renderAdvLists() {
    const qm = $('mineSearch').value.trim().toLowerCase(), qc = $('compSearch').value.trim().toLowerCase();
    const row = (a, kind) => {
      const checked = kind === 'mine' ? state.mine.includes(a.name) : state.comps.includes(a.name);
      const pill = kind === 'mine' ? (checked ? '<span class="pill">MINE</span>' : '') : (checked ? '<span class="pillc">SEL</span>' : '');
      return `<label class="opt" title="${esc(a.name)} · ${money(a.spend)}"><input type="checkbox" data-kind="${kind}" value="${esc(a.name)}" ${checked ? 'checked' : ''}><span class="nm">${esc(a.name)}</span>${pill}</label>`;
    };
    // Selected names float to the top; each list hides names already picked in the other list.
    const order = (list, sel) => list.slice().sort((x, y) => (sel.includes(y.name) - sel.includes(x.name)));
    const mine = order(options.advertisers.filter(a => !state.comps.includes(a.name) && (!qm || a.name.toLowerCase().includes(qm))), state.mine);
    const comps = order(options.advertisers.filter(a => !state.mine.includes(a.name) && (!qc || a.name.toLowerCase().includes(qc))), state.comps);
    $('mineCnt').textContent = state.mine.length ? `${state.mine.length} selected` : '';
    $('compCnt').textContent = state.comps.length ? `${state.comps.length} selected` : '';
    $('mineList').innerHTML = mine.map(a => row(a, 'mine')).join('') || '<div class="empty-note">No advertisers</div>';
    $('compList').innerHTML = comps.map(a => row(a, 'comp')).join('') || '<div class="empty-note">No advertisers</div>';
  }

  function renderChannelSelect() {
    const list = options.channels.filter(c => state.medium === 'All' || c.medium === state.medium);
    if (state.channel && !list.some(c => c.name === state.channel)) state.channel = '';
    $('fChannel').innerHTML = `<option value="">All channels (${list.length})</option>` +
      list.map(c => `<option value="${esc(c.name)}">${esc(c.name)}</option>`).join('');
    $('fChannel').value = state.channel;
  }

  document.addEventListener('change', e => {
    const t = e.target;
    if (t.dataset && t.dataset.kind) {
      const arr = t.dataset.kind === 'mine' ? state.mine : state.comps;
      const i = arr.indexOf(t.value);
      if (t.checked && i < 0) arr.push(t.value);
      if (!t.checked && i >= 0) arr.splice(i, 1);
      renderAdvLists();
    }
  });
  $('mineSearch').addEventListener('input', renderAdvLists);
  $('compSearch').addEventListener('input', renderAdvLists);
  $('fPg').addEventListener('change', async e => {
    state.pg = e.target.value;
    await loadOptions(true);
    renderAdvLists(); renderChannelSelect();
  });
  $('fMedium').addEventListener('click', e => {
    const b = e.target.closest('.seg');
    if (!b) return;
    state.medium = b.dataset.v;
    [...$('fMedium').children].forEach(x => x.classList.toggle('on', x === b));
    renderChannelSelect();
  });
  $('fAdType').addEventListener('click', e => {
    const b = e.target.closest('.seg');
    if (!b) return;
    state.adType = b.dataset.v;
    [...$('fAdType').children].forEach(x => x.classList.toggle('on', x === b));
  });
  $('fChannel').addEventListener('change', e => { state.channel = e.target.value; });
  $('fDaypart').addEventListener('change', e => { state.daypart = e.target.value; });
  $('resetBtn').addEventListener('click', async () => {
    if (!overview) return;
    const keepPg = state.pg;
    Object.assign(state, defaultDates(), { medium: 'All', channel: '', daypart: '', adType: 'All' });
    state.pg = keepPg;
    $('mineSearch').value = ''; $('compSearch').value = '';
    await loadOptions(true);
    writeForm();
  });
  $('fFrom').addEventListener('change', e => { state.from = e.target.value; });
  $('fTo').addEventListener('change', e => { state.to = e.target.value; });
  $('applyBtn').addEventListener('click', () => { refresh(); });

  async function refresh() {
    if (!overview) return;
    if (state.from > state.to) { const t = state.from; state.from = state.to; state.to = t; writeForm(); }
    saveState();
    document.body.classList.add('loading');
    try {
      data = await api('/api/dashboard', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(state) });
      render();
      hideOverlay();
      if (!state.mine.length) showOverlay('Pick your advertiser', 'Open Filters and tick at least one advertiser under My Advertiser.');
    } catch (e) {
      toast(e.message);
    } finally {
      document.body.classList.remove('loading');
    }
  }

  // ---------- overlays ----------
  function showOverlay(title, text) { $('ovTitle').textContent = title; $('ovText').textContent = text; $('overlay').classList.add('on'); }
  function hideOverlay() { $('overlay').classList.remove('on'); }
  function showEmpty() {
    showOverlay('No data uploaded yet', 'Open the filter drawer and upload your spot log as .xlsx or .csv. Large files (400k+ rows) take up to a minute to process.');
    $('periodText').textContent = 'No data'; $('periodLen').textContent = '0 months';
    $('chips').innerHTML = '';
    ['k1v', 'k2v'].forEach(id => { $(id).textContent = 'LKR 0'; }); $('k3v').textContent = '0%';
    ['k1', 'k2', 'k3'].forEach(id => $(id).removeAttribute('data-detail'));
    ['donut', 'trend', 'drill', 'sosTable', 'chMix', 'duration'].forEach(id => { $(id).innerHTML = ''; });
    $('fPg').innerHTML = ''; $('mineList').innerHTML = ''; $('compList').innerHTML = ''; $('fChannel').innerHTML = ''; $('fDaypart').innerHTML = '';
  }

  // ---------- render ----------
  function render() {
    const d = data, k = d.kpi, f = d.filters;
    $('periodText').innerHTML = `${fmtDate(f.from)} &nbsp;to&nbsp; ${fmtDate(f.to)}`;
    const nMonths = monthsBetween(f.from, f.to);
    $('periodLen').textContent = `${nMonths} month${nMonths === 1 ? '' : 's'}`;
    const chips = [`<span class="chip">${esc(f.pg)}</span>`];
    if (f.mine.length) chips.push(`<span class="chip o" title="${esc(f.mine.join(', '))}">${esc(d.mineLabel)}</span>`);
    chips.push(`<span class="chip">+${f.comps.length} competitor${f.comps.length === 1 ? '' : 's'}</span>`);
    chips.push(`<span class="chip">${f.medium === 'All' ? 'All media' : esc(f.medium) + ' only'}</span>`);
    if (f.adType === 'Commercial') chips.push('<span class="chip">Commercials only</span>');
    if (f.adType === 'Sponsorship') chips.push('<span class="chip s">Value Additions only</span>');
    if (f.channel) chips.push(`<span class="chip">${esc(f.channel)}</span>`);
    if (f.daypart) chips.push(`<span class="chip">${esc(dpLabel(f.daypart))}</span>`);
    const busy = $('busyChip');
    $('chips').innerHTML = chips.join('');
    if (busy) $('chips').prepend(busy);

    $('k1v').textContent = money(k.catSpend);
    $('k2v').textContent = money(k.mineSpend);
    $('k3v').textContent = nf(k.sos, 1) + '%';
    $('k1').setAttribute('data-detail', JSON.stringify({ title: 'Category spend', tab: 'adv' }));
    $('k2').setAttribute('data-detail', JSON.stringify({ title: d.mineLabel + ' (mine)', mine: true, tab: 'ch' }));
    $('k3').setAttribute('data-detail', JSON.stringify({ title: 'Share of spend ranking', tab: 'adv' }));
    $('k3').setAttribute('data-tip', k.rank ? `Rank #${k.rank} of ${k.rankOf} in the category\nClick to see the ranking` : 'Click to see the ranking');

    renderDonut(d.medium);
    renderTrend(d);
    renderDrill(d);
    renderSos(d);
    renderMix();
    renderDuration(d);
  }

  // Share of spend comparison: mine, each competitor and everyone else.
  // Period view: one line each for the selected dates. By month view: the SOS % of each month as shaded numbers.
  function renderSos(d) {
    const S = d.sos;
    const rows = S.rows.slice().sort((a, b) => b.sos - a.sos).concat(S.others.spend > 0 ? [S.others] : []);
    if (!rows.length) { $('sosTable').innerHTML = '<div class="nodata">Pick your advertiser and competitors in Filters</div>'; return; }
    const scopeOf = (r, extra) => (r.mine ? { title: r.name + ' (mine)', mine: true, ...extra } : r.others ? { title: 'All advertisers', ...extra } : { title: r.name, advertiser: r.name, ...extra });
    const cls = r => (r.mine ? 'row me' : r.others ? 'row oth' : 'row');
    if (sosView === 'year') {
      const Y = S.years;
      const max = Math.max(1, ...rows.filter(r => !r.others).flatMap(r => r.yearly.filter(v => v != null)));
      const shade = (r, v) => {
        if (v == null) return 'background:#F6F8FC;color:#B4BCD0';
        const t = Math.min(1, v / max) * 0.85 + 0.08;
        const rgb = r.mine ? '255,138,61' : r.others ? '154,166,196' : '68,116,214';
        return `background:rgba(${rgb},${t.toFixed(2)});color:${t > 0.55 ? '#fff' : '#1A1F36'}`;
      };
      const span = y => (y.partial ? `${fmtDate(y.from).slice(3)} to ${fmtDate(y.to).slice(3)}` : 'Full year');
      const head = `<tr><th class="an">Advertiser</th>${Y.map(y => `<th title="${esc(span(y))}">${y.year}${y.partial ? '*' : ''}</th>`).join('')}</tr>`;
      const body = rows.map(r => `<tr class="${cls(r)}">
        <td class="an" title="${esc(r.name)}"${detA(scopeOf(r, { tab: r.others ? 'adv' : 'mon' }))}>${esc(r.name)}</td>
        ${r.yearly.map((v, k) => {
          const y = Y[k];
          return `<td class="c" style="${shade(r, v)}"${tipA(`${r.name} · ${y.year}\nSOS ${v == null ? 'n/a' : pctS(v)} · ${span(y)}\nClick for details`)}${detA(scopeOf(r, { title: `${r.others ? 'All advertisers' : r.name} · ${y.year}`, year: y.year, tab: r.others ? 'adv' : 'mon' }))}>${v == null ? 'n/a' : pctS(v)}</td>`;
        }).join('')}</tr>`).join('');
      const partial = Y.filter(y => y.partial);
      $('sosTable').innerHTML = `<div class="sost sosm"><table><tbody>${head}${body}</tbody></table></div>
        ${partial.length ? `<div class="hint" style="color:#8A93AD;margin:6px 2px 0">* ${partial.map(y => `${y.year}: ${span(y)}`).join(' · ')} (data available)</div>` : ''}`;
      $('p-sos').textContent = 'SOS % of each year in the full data · ignores the date range · click a cell for details';
      return;
    }
    if (sosView === 'month') {
      const n = d.months.length, dec = n <= 7 ? 1 : 0;
      const max = Math.max(1, ...rows.filter(r => !r.others).flatMap(r => r.monthly.filter(v => v != null)));
      const shade = (r, v) => {
        if (v == null) return 'background:#F6F8FC;color:#B4BCD0';
        const t = Math.min(1, v / max) * 0.85 + 0.08;
        const rgb = r.mine ? '255,138,61' : r.others ? '154,166,196' : '68,116,214';
        return `background:rgba(${rgb},${t.toFixed(2)});color:${t > 0.55 ? '#fff' : '#1A1F36'}`;
      };
      const head = `<tr><th class="an">Advertiser</th>${d.months.map(m => `<th>${esc(monthLabel(m, d.months))}</th>`).join('')}<th class="per">Period</th></tr>`;
      const body = rows.map(r => `<tr class="${cls(r)}">
        <td class="an" title="${esc(r.name)}"${detA(scopeOf(r, { tab: r.others ? 'adv' : 'mon' }))}>${esc(r.name)}</td>
        ${r.monthly.map((v, k) => {
          const m = d.months[k];
          return `<td class="c" style="${shade(r, v)}"${tipA(`${r.name} · ${m.label} ${m.year}\nSOS ${v == null ? 'n/a' : pctS(v)}\nClick for details`)}${detA(scopeOf(r, { title: `${r.others ? 'All advertisers' : r.name} · ${m.label} ${m.year}`, month: m.key, tab: r.others ? 'adv' : 'ch' }))}>${v == null ? 'n/a' : nf(v, dec)}</td>`;
        }).join('')}
        <td class="per">${pctS(r.sos)}</td></tr>`).join('');
      $('sosTable').innerHTML = `<div class="sost sosm"><table><tbody>${head}${body}</tbody></table></div>`;
      $('p-sos').textContent = 'SOS % of each month · darker = bigger share · click a cell for details';
      return;
    }
    const maxSos = Math.max(1, ...rows.map(r => r.sos));
    const body = rows.map(r => `<tr class="${cls(r)}"${detA(scopeOf(r, { tab: r.others ? 'adv' : 'mon' }))}${tipA(`${r.name}\nSOS ${pctS(r.sos)} · ${money(r.spend)} · ${nf(r.spots)} spots\nClick for details`)}>
        <td class="rk">${r.rank ? '#' + r.rank : ''}</td>
        <td class="an" title="${esc(r.name)}">${esc(r.name)}</td>
        <td><div class="sosbar"><div class="trk"><span style="width:${(r.sos / maxSos) * 100}%"></span></div><b>${pctS(r.sos)}</b></div></td>
        <td class="num">${money(r.spend, false)}</td>
        <td class="num">${nf(r.spots)}</td><td class="go">›</td></tr>`).join('');
    $('sosTable').innerHTML = `<div class="sost"><table><tbody>
      <tr><th>#</th><th>Advertiser</th><th>SOS</th><th class="num">Spend (LKR)</th><th class="num">Spots</th><th></th></tr>
      ${body}
      <tr class="tot"><td></td><td>Category · ${nf(S.total.advertisers)} advertisers</td><td><div class="sosbar"><div class="trk"><span style="width:0"></span></div><b>100%</b></div></td>
        <td class="num">${money(S.total.spend, false)}</td><td class="num">${nf(S.total.spots)}</td><td></td></tr>
      </tbody></table></div>`;
    $('p-sos').textContent = 'Selected period · my advertiser vs competitors · click a row for details';
  }
  document.querySelector('.tgl[data-sosview]').addEventListener('click', e => {
    const b = e.target.closest('button');
    if (!b || !data) return;
    sosView = b.dataset.v;
    [...b.parentNode.children].forEach(x => x.classList.toggle('on', x === b));
    renderSos(data);
  });

  function renderDonut(m) {
    const circ = 2 * Math.PI * 50;
    let off = 0;
    const segs = m.category.map((p, i) => {
      const len = (p / 100) * circ;
      const s = `<circle class="donutseg" r="50" fill="none" stroke="${C.medium[i]}" stroke-width="19" stroke-dasharray="${len.toFixed(2)} ${(circ - len).toFixed(2)}" stroke-dashoffset="${(-off).toFixed(2)}"${tipA(`${m.names[i]}\nCategory ${pctS(p)} · ${money((p / 100) * m.categoryTotal)}\nMine ${pctS(m.mine[i])}`)}${detA({ title: m.names[i] + ' spend', medium: m.names[i], tab: 'ch' })}></circle>`;
      off += len;
      return len > 0 ? s : '';
    }).join('');
    const total = money(m.categoryTotal, false);
    const rows = m.names.map((n, i) => `<tr${detA({ title: n + ' spend', medium: n, tab: 'ch' })}${tipA(`Click to see ${n} channels and advertisers`)}><td><span class="sw" style="background:${C.medium[i]};margin-right:6px"></span>${n}</td>
        <td class="num">${nf(m.category[i], 1)}%</td><td class="num mineval">${nf(m.mine[i], 1)}%</td></tr>`).join('');
    $('donut').innerHTML = `<svg class="donutsvg" viewBox="0 6 200 136" preserveAspectRatio="xMidYMid meet">
      <g transform="translate(100,72) rotate(-90)"><circle r="50" fill="none" stroke="#F0F2F8" stroke-width="19"></circle>${segs}</g>
      <text x="100" y="70" text-anchor="middle" font-size="16" font-weight="700" fill="#1A1F36">${esc(total)}</text>
      <text x="100" y="84" text-anchor="middle" font-size="7.5" fill="#8A93AD">CATEGORY TOTAL</text></svg>
      <table><tbody><tr><th>Medium</th><th class="num">Cat.</th><th class="num">Mine</th></tr>${rows}</tbody></table>`;
  }

  // Smooth path through every point: Catmull-Rom tangents, limited (Fritsch-Carlson) so the curve never overshoots.
  function smoothPath(pts) {
    const n = pts.length;
    if (n === 0) return '';
    if (n === 1) return `M${pts[0][0]},${pts[0][1]}`;
    const dx = [], sl = [], m = new Array(n);
    for (let i = 0; i < n - 1; i++) { dx[i] = pts[i + 1][0] - pts[i][0]; sl[i] = (pts[i + 1][1] - pts[i][1]) / dx[i]; }
    m[0] = sl[0]; m[n - 1] = sl[n - 2];
    for (let i = 1; i < n - 1; i++) m[i] = (pts[i + 1][1] - pts[i - 1][1]) / (pts[i + 1][0] - pts[i - 1][0]);
    for (let i = 0; i < n - 1; i++) {
      if (sl[i] === 0) { m[i] = 0; m[i + 1] = 0; continue; }
      const a = m[i] / sl[i], b = m[i + 1] / sl[i];
      if (a < 0) m[i] = 0;
      if (b < 0) m[i + 1] = 0;
      const h = a * a + b * b;
      if (h > 9) { const t = 3 / Math.sqrt(h); m[i] = t * a * sl[i]; m[i + 1] = t * b * sl[i]; }
    }
    // Direction changes (local peaks and dips) get a flat tangent so the curve cannot bulge past the data point.
    for (let i = 1; i < n - 1; i++) if (sl[i - 1] * sl[i] <= 0) m[i] = 0;
    let d = `M${pts[0][0].toFixed(1)},${pts[0][1].toFixed(1)}`;
    for (let i = 0; i < n - 1; i++) {
      const [x0, y0] = pts[i], [x1, y1] = pts[i + 1], h = dx[i] / 3;
      d += ` C${(x0 + h).toFixed(1)},${(y0 + m[i] * h).toFixed(1)} ${(x1 - h).toFixed(1)},${(y1 - m[i + 1] * h).toFixed(1)} ${x1.toFixed(1)},${y1.toFixed(1)}`;
    }
    return d;
  }
  function niceMax(v) {
    if (v <= 0) return 4;
    const raw = v / 4, p = Math.pow(10, Math.floor(Math.log10(raw))), r = raw / p;
    const step = (r <= 1 ? 1 : r <= 2 ? 2 : r <= 2.5 ? 2.5 : r <= 5 ? 5 : 10) * p;
    return step * 4;
  }
  function monthLabel(m, all) {
    const multiYear = all.length && all[0].year !== all[all.length - 1].year;
    return multiYear ? `${m.label} ’${String(m.year).slice(2)}` : m.label;
  }

  function renderTrend(d) {
    const months = d.months, n = months.length;
    const legendHtml = trendLegend(d);
    $('trend').innerHTML = `<div class="trendbox" id="trendBox"></div><div class="legend">${legendHtml}</div>`;
    const box = $('trendBox'), W = Math.max(300, box.clientWidth), H = Math.max(120, box.clientHeight);
    const X0 = 40, X1 = W - 18, Y0 = H - 24, Y1 = 30, XR = W - 8;
    const toMn = v => v / 1e6;
    const shown = name => !hiddenSeries.has(name);
    const series = [shown('__mine') ? d.trend.mine : [], shown('__avg') ? d.trend.categoryAvg : []]
      .concat(d.trend.competitors.filter(c => shown(c.name)).map(c => c.values));
    const max = niceMax(Math.max(0, ...series.flat().map(toMn)));
    const x = i => (n === 1 ? (X0 + X1) / 2 : X0 + (i * (X1 - X0)) / (n - 1));
    const y = v => Y0 - (toMn(v) / max) * (Y0 - Y1);
    const pts = vals => vals.map((v, i) => [x(i), y(v)]);
    const grid = [0, 1, 2, 3, 4].map(k => {
      const yy = Y0 - (k * (Y0 - Y1)) / 4, val = (max * k) / 4;
      return `<line x1="${X0}" y1="${yy}" x2="${XR}" y2="${yy}" stroke="#EEF1F7"></line><text x="${X0 - 8}" y="${yy + 3.5}" text-anchor="end">${nf(val, max < 4 ? 1 : 0)}</text>`;
    }).join('');
    const every = Math.ceil(n / Math.max(4, Math.floor((X1 - X0) / 56)));
    const xl = months.map((m, i) => (i % every === 0 || i === n - 1 ? `<text x="${x(i)}" y="${H - 6}">${esc(monthLabel(m, months))}</text>` : '')).join('');
    const comps = d.trend.competitors.map((c, i) => !shown(c.name) ? '' : `<path fill="none" stroke="${C.compLines[i % C.compLines.length]}" stroke-width="${i === 0 ? 2.4 : 2}" stroke-linecap="round" stroke-linejoin="round" d="${smoothPath(pts(c.values))}"></path>`).reverse().join('');
    const avg = !shown('__avg') ? '' : `<path fill="none" stroke="#B4BCD0" stroke-width="1.5" stroke-dasharray="2 4" stroke-linecap="round" d="${smoothPath(pts(d.trend.categoryAvg))}"></path>`;
    const mp = pts(d.trend.mine);
    const minePath = smoothPath(mp);
    const mineOn = shown('__mine');
    const area = mineOn && n > 1 ? `<path fill="${C.orange}" fill-opacity="0.12" d="${minePath} L${mp[n - 1][0]},${Y0} L${mp[0][0]},${Y0} Z"></path>` : '';
    const dots = !mineOn ? '' : mp.map((p, i) => i === n - 1
      ? `<circle cx="${p[0]}" cy="${p[1]}" r="5.5" fill="${C.orange}" stroke="#fff" stroke-width="2.5"></circle>`
      : `<circle cx="${p[0]}" cy="${p[1]}" r="4" fill="${C.orange}"></circle>`).join('');
    let callout = '';
    const peakV = Math.max(...d.trend.mine);
    if (mineOn && peakV > 0) {
      const pi = d.trend.mine.indexOf(peakV), [px, py] = mp[pi];
      const label = `${mn(peakV)} peak`, w = label.length * 6.1 + 16;
      const rx = Math.max(X0, Math.min(XR - w, px - w / 2));
      const ry = py - 30 < 2 ? py + 10 : py - 28;
      callout = `<rect x="${rx}" y="${ry}" width="${w}" height="19" rx="5" fill="#FFF1E6"></rect><text x="${rx + w / 2}" y="${ry + 13}" font-size="10.5" font-weight="700" fill="${C.deep}" text-anchor="middle">${label}</text>`;
    }
    // One invisible column per month: hover shows every series, click opens the month.
    const colW = n === 1 ? X1 - X0 : (X1 - X0) / (n - 1);
    const hits = months.map((m, i) => {
      const lines = [`${m.label} ${m.year}`];
      if (mineOn) lines.push(`${d.mineLabel} (mine): ${mn(d.trend.mine[i])}`);
      d.trend.competitors.forEach(c => { if (shown(c.name)) lines.push(`${c.name}: ${mn(c.values[i])}`); });
      if (shown('__avg')) lines.push(`Category avg.: ${mn(d.trend.categoryAvg[i])}`);
      lines.push('Click for month details');
      return `<rect class="hit" fill="#2F5DBF" fill-opacity="0" x="${x(i) - colW / 2}" y="${Y1 - 10}" width="${colW}" height="${Y0 - Y1 + 10}"${tipA(lines.join('\n'))}${detA({ title: `${m.label} ${m.year}`, month: m.key, tab: 'adv' })}></rect>`;
    }).join('');
    box.innerHTML = `<svg width="${W}" height="${H}" viewBox="0 0 ${W} ${H}">
      <g font-size="10" fill="#9AA3BC" stroke-width="1">${grid}</g>
      ${area}${comps}${avg}
      ${mineOn ? `<path fill="none" stroke="${C.orange}" stroke-width="3.6" stroke-linecap="round" stroke-linejoin="round" d="${minePath}"></path>` : ''}
      ${dots}${callout}${hits}
      <g font-size="10.5" fill="#8A93AD" text-anchor="middle">${xl}</g></svg>`;
  }
  function trendLegend(d) {
    const off = k => (hiddenSeries.has(k) ? ' off' : '');
    const lgA = k => ` data-series="${esc(k)}" title="Click to show or hide"`;
    return [`<div class="lg${off('__mine')}"${lgA('__mine')}><span class="sw" style="background:${C.orange};height:4px;width:18px"></span><strong>${esc(d.mineLabel)} (mine)</strong></div>`]
      .concat(d.trend.competitors.map((c, i) => `<div class="lg${off(c.name)}"${lgA(c.name)}><span class="sw" style="background:${C.compLines[i % C.compLines.length]};height:3px;width:18px"></span>${esc(c.name)}</div>`))
      .concat([`<div class="lg${off('__avg')}"${lgA('__avg')}><span class="sw" style="background:repeating-linear-gradient(90deg,#B4BCD0 0 3px,transparent 3px 6px);height:2px;width:18px"></span>Category avg.</div>`]).join('');
  }

  const monthEnd = key => { const [y, m] = key.split('-').map(Number); return new Date(Date.UTC(y, m, 0)).toISOString().slice(0, 10); };
  const maxIso = (a, b) => (a > b ? a : b), minIso = (a, b) => (a < b ? a : b);

  function renderDrill(d) {
    const months = d.drill;
    if (!months.length) { $('drill').innerHTML = '<div class="nodata">No months in range</div>'; return; }
    // Earliest run of quiet months (category spend below 80% of the monthly average) is combined into one row.
    const avg = months.reduce((s, m) => s + m.category, 0) / months.length;
    let q = 0;
    while (q < months.length - 1 && months[q].category < avg * 0.8) q++;
    const grouped = q >= 2 ? months.slice(0, q) : [];
    const singles = months.slice(grouped.length).reverse();
    const tagFor = L => !L ? '<span class="tag tagr">NO SPEND</span>'
      : L.mine ? '<span class="tagme">MINE LEADS</span>'
      : `<span class="tag tagr" title="${esc(L.name)}">${esc(L.name.toUpperCase())}</span>`;
    const html = singles.map((m, i) => {
      const L = m.leader;
      let body = 'No spend recorded this month.';
      if (L) {
        body = `Leader <b style="color:${L.mine ? C.deep : '#1A1F36'}">${esc(L.name)}</b> <strong>${money(L.spend)}</strong> · ${nf(m.category ? (L.spend / m.category) * 100 : 0, 1)}% SOS`;
        if (m.campaign) {
          const me = d.filters.mine.includes(m.campaign.advertiser);
          body += `<span class="camp${me ? ' me' : ''}"${detA({ title: `“${m.campaign.name}” · ${m.label} ${m.year}`, month: m.key, advertiser: m.campaign.advertiser, theme: m.campaign.name, tab: 'ch' })}${tipA('Click to see where this campaign ran in ' + m.label)}><span class="cn">“${esc(m.campaign.name)}”</span><br>
            <span class="by">by <b>${esc(m.campaign.advertiser)}</b>${me ? ' (mine)' : ''} · ${mn(m.campaign.spend)} · ${nf(m.campaign.spots)} spots</span></span>`;
        }
        const tail = [];
        if (m.runnerUp) tail.push(`Runner up ${esc(m.runnerUp.name)} ${mn(m.runnerUp.spend)}.`);
        if (!L.mine && !(m.runnerUp && m.runnerUp.mine)) tail.push(m.mineSpend > 0 ? `Mine ${mn(m.mineSpend)}.` : 'No spend from mine.');
        body += tail.join(' ');
        body += `<br><span class="mlink"${detA({ title: `${m.label} ${m.year}`, month: m.key, tab: 'adv' })}>View ${m.label} details ›</span>`;
      }
      return `<details${i === 0 ? ' open' : ''}><summary><span class="chev">▶</span> ${m.label} ${m.year} ${tagFor(L)}</summary>
        <div class="dbody"><p id="p-m-${m.key}">${body}</p></div></details>`;
    });
    if (grouped.length) {
      const first = grouped[0], last = grouped[grouped.length - 1];
      const byLeader = new Map();
      grouped.forEach(m => { if (m.leader) { const k = m.leader.name; if (!byLeader.has(k)) byLeader.set(k, { mine: m.leader.mine, months: [] }); byLeader.get(k).months.push(m.label); } });
      const listJoin = a => (a.length > 1 ? a.slice(0, -1).join(', ') + ' and ' + a[a.length - 1] : a[0]);
      const lines = [...byLeader].map(([name, v]) => `${v.mine ? 'We' : esc(name)} led ${listJoin(v.months)}.`);
      const total = grouped.reduce((s, m) => s + m.category, 0), mineTot = grouped.reduce((s, m) => s + m.mineSpend, 0);
      const single = byLeader.size === 1 ? [...byLeader][0] : null;
      const tag = single ? (single[1].mine ? '<span class="tagme">MINE LEADS</span>' : `<span class="tag tagr">${esc(single[0].toUpperCase())}</span>`) : '<span class="tag tagr">MIXED</span>';
      html.push(`<details${singles.length ? '' : ' open'}><summary><span class="chev">▶</span> ${first.label}${first.year !== last.year ? ' ' + first.year : ''} to ${last.label} ${last.year} ${tag}</summary>
        <div class="dbody"><p id="p-m-q">${lines.join(' ')} Quieter period, category ${money(total)}, mine ${mn(mineTot)}.<br>
        <span class="mlink"${detA({ title: `${first.label} to ${last.label} ${last.year}`, from: maxIso(first.key + '-01', d.filters.from), to: minIso(monthEnd(last.key), d.filters.to), tab: 'adv' })}>View ${first.label} to ${last.label} details ›</span></p></div></details>`);
    }
    $('drill').innerHTML = html.join('');
  }

  // n colours from dark to light, so the biggest channel is always the darkest segment.
  function scale(n, dark, light) {
    const hex = h => [1, 3, 5].map(i => parseInt(h.slice(i, i + 2), 16));
    const a = hex(dark), b = hex(light);
    return Array.from({ length: n }, (_, i) => {
      const t = n === 1 ? 0 : i / (n - 1);
      return '#' + a.map((v, j) => Math.round(v + (b[j] - v) * t).toString(16).padStart(2, '0')).join('');
    });
  }
  const textOn = hex => {
    const [r, g, b] = [1, 3, 5].map(i => parseInt(hex.slice(i, i + 2), 16));
    return 0.299 * r + 0.587 * g + 0.114 * b > 165 ? '#1A1F36' : '#fff';
  };

  // Channel mix: Top 5 stacked bars (rest grouped as Other) or an all-channel heatmap, per card toggle.
  function mixHtml(mix, d, medium, key) {
    if (!mix.channels.length) return `<div class="nodata">No ${medium} spend in this selection</div>`;
    return mixView[key] === 'heat' ? heatHtml(mix, d, medium, key) : top5Html(mix, d, medium, key);
  }

  function top5Html(mix, d, medium, key) {
    const n = d.months.length, TOP = 5;
    const k = mix.channels.length, top = Math.min(TOP, k), hasOther = k > TOP;
    const otherName = { TV: 'Other TV', Radio: 'Other FM', Press: 'Other Press' }[medium];
    const names = mix.channels.slice(0, top).concat(hasOther ? [`${otherName} (${k - TOP})`] : []);
    const fold = parts => parts && parts.slice(0, top).concat(hasOther ? [parts.slice(TOP).reduce((a, b) => a + b, 0)] : []);
    const blues = scale(top, '#1E3F8A', '#BFD3F6').concat(hasOther ? ['#DDE2EC'] : []);
    const oranges = scale(top, '#C4560F', '#FFD2AE').concat(hasOther ? ['#F2E6DC'] : []);
    const showText = n <= 16;
    const scopeFor = (j, m, mine) => (j < top
      ? { title: `${mix.channels[j]} · ${m.label} ${m.year}`, month: m.key, channel: mix.keys[j], mine: mine || undefined, tab: 'adv' }
      : { title: `${otherName} · ${m.label} ${m.year}`, month: m.key, medium, exclude: mix.keys.slice(0, top), mine: mine || undefined, tab: 'ch' });
    const bars = (series, colors, mine) => `<div class="bars" style="grid-template-columns:repeat(${n},minmax(0,1fr))">` + series.map((raw, i) => {
      const parts = fold(raw), m = d.months[i];
      const segs = parts ? parts.map((p, j) => ({ p, c: colors[j], j })).reverse()
        .map(s => `<div style="height:${s.p}%;background:${s.c};color:${textOn(s.c)}"${tipA(`${names[s.j]} · ${m.label} ${m.year}\n${pctS(s.p)} of ${mine ? 'my' : 'category'} ${medium} spend\nClick for details`)}${detA(scopeFor(s.j, m, mine))}>${showText && s.p >= 7 ? Math.round(s.p) + '%' : ''}</div>`).join('') : '';
      return `<div class="bcol"><div class="stack">${segs}</div><div class="bl">${esc(monthLabel(m, d.months))}</div></div>`;
    }).join('') + '</div>';
    const legend = names.map((c, j) => `<div class="lg"><span class="sw" style="background:${blues[j]}"></span>${esc(c)}</div>`).join('');
    return `<p class="secl" id="p-${key}a">CATEGORY</p>${bars(mix.category, blues, false)}
      <p class="secl" id="p-${key}b" style="color:${C.deep}">${esc(d.mineLabel.toUpperCase())} (MINE)</p>${bars(mix.mine, oranges, true)}
      <div class="legend">${legend}<div class="lg" style="margin-left:6px"><span class="sw" style="background:${C.orange}"></span>Mine, same order</div></div>`;
  }

  function heatHtml(mix, d, medium, key) {
    const side = heatSide[key] || 'cat', mine = side === 'mine';
    const src = mine ? mix.mine : mix.category;
    const n = d.months.length, k = mix.channels.length;
    let max = 0;
    src.forEach(parts => parts && parts.forEach(v => { if (v > max) max = v; }));
    const hi = mine ? [196, 86, 15] : [30, 63, 138];
    const cellColor = v => {
      const t = max ? Math.sqrt(v / max) : 0; // sqrt keeps small shares visible
      const c = hi.map(h => Math.round(255 + (h - 255) * t));
      return '#' + c.map(x => x.toString(16).padStart(2, '0')).join('');
    };
    const head = `<div></div>` + d.months.map(m => `<div class="hh">${esc(monthLabel(m, d.months))}</div>`).join('');
    const rows = mix.channels.map((name, j) => {
      const cells = src.map((parts, i) => {
        const m = d.months[i], v = parts ? parts[j] : 0, bg = v > 0 ? cellColor(v) : '#F6F8FC';
        const txt = n <= 16 && v >= 0.5 ? Math.round(v) + '%' : '';
        return `<div class="hc" style="background:${bg};color:${textOn(bg)}"${tipA(`${name} · ${m.label} ${m.year}\n${pctS(v)} of ${mine ? 'my' : 'category'} ${medium} spend\nClick for details`)}${detA({ title: `${name} · ${m.label} ${m.year}`, month: m.key, channel: mix.keys[j], mine: mine || undefined, tab: 'adv' })}>${txt}</div>`;
      }).join('');
      return `<div class="hn" title="${esc(name)}"${detA({ title: name, channel: mix.keys[j], tab: 'adv' })}>${esc(name)}</div>${cells}`;
    }).join('');
    return `<div class="heatbar">
        <div class="tgl sm" data-heat="${key}"><button data-v="cat" class="${mine ? '' : 'on'}">Category</button><button data-v="mine" class="o ${mine ? 'on' : ''}">Mine</button></div>
        <span class="gl">0%</span><span class="grad" style="background:linear-gradient(90deg,#fff,${cellColor(max)})"></span><span class="gl">${nf(max, 0)}%</span>
        <span class="gl" style="margin-left:auto">${k} channels</span></div>
      <div class="heat" style="grid-template-columns:minmax(70px,110px) repeat(${n},minmax(0,1fr));grid-template-rows:16px">${head}${rows}</div>`;
  }

  // Duration mix as a grid of ad counts: rows are advertisers, columns are standard lengths.
  // Only my advertiser's row is highlighted.
  function renderDuration(d) {
    const { buckets, legacy } = d.duration;
    const rows = durMedium === 'All' ? d.duration.rows : d.duration.byMedium[durMedium];
    const med = durMedium === 'All' ? undefined : durMedium;
    const cell = r => (v, j) => {
      const share = r.ads ? pctS((v / r.ads) * 100) : '0%';
      const what = `${buckets[j]} ${med ? med + ' ' : ''}ads`;
      const scope = r.mine ? { title: `${r.name} (mine) · ${what}`, mine: true, dur: buckets[j], medium: med, tab: 'ch' }
        : r.avg ? { title: `Category · ${what}`, dur: buckets[j], medium: med, tab: 'adv' }
        : { title: `${r.name} · ${what}`, advertiser: r.name, dur: buckets[j], medium: med, tab: 'ch' };
      const label = v >= 100000 ? nf(v / 1000, 0) + 'K' : nf(v);
      return `<div class="bc"${tipA(`${r.name} · ${buckets[j]}\n${nf(v)} ads (${share} of their ${nf(r.ads)} ads)\nClick for details`)}${detA(scope)}>
        <span class="bn ${v ? '' : 'zero'}">${v ? label : '0'}</span></div>`;
    };
    const body = rows.map(r => {
      const acd = r.acd == null ? '<span class="acdp na">n/a</span>' : `<span class="acdp${r.mine ? ' me' : r.avg ? ' cat' : ''}">${Math.round(r.acd)}s</span>`;
      const scope = r.mine ? { title: r.name + ' (mine)', mine: true, medium: med, tab: 'camp' } : r.avg ? { title: 'Category spend', medium: med, tab: 'adv' } : { title: r.name, advertiser: r.name, medium: med, tab: 'camp' };
      const cells = r.ads ? r.counts.map(cell(r)).join('') : `<div class="bc none" style="grid-column:span ${buckets.length}">No TV or Radio ads</div>`;
      return `<div class="brow${r.mine ? ' me' : ''}${r.avg ? ' catrow' : ''}">
        <span class="durname" title="${esc(r.name)} · ${nf(r.ads)} ads"${detA(scope)}><span class="nm2">${esc(r.name)}</span></span>
        ${cells}${acd}</div>`;
    }).join('');
    const cols = `grid-template-columns:minmax(70px,1.1fr) repeat(${buckets.length},minmax(32px,1fr)) 34px`;
    $('duration').innerHTML = `${legacy ? '<div class="durnote">Re-upload your file to apply the new length buckets and ACD</div>' : ''}
      <div class="bgrid" style="${cols}">
        <span class="bh"></span>${buckets.map(b => `<span class="bh">${b}</span>`).join('')}<span class="bh">ACD</span>
      </div>
      <div class="bbody" style="--cols:${cols.replace('grid-template-columns:', '')}">${body}</div>
      <div class="legend" style="margin-top:6px"><div class="lg" style="margin-left:auto;color:#8A93AD">ACD = total seconds / ads</div></div>`;
  }




  // ---------- interactivity: toggles, legend, tooltip, click-through ----------
  document.querySelectorAll('.tgl[data-mix]').forEach(t => t.addEventListener('click', e => {
    const b = e.target.closest('button');
    if (!b || !data) return;
    mixView[t.dataset.mix] = b.dataset.v;
    [...t.children].forEach(x => x.classList.toggle('on', x === b));
    renderMix();
  }));
  document.addEventListener('click', e => {
    const hb = e.target.closest('.tgl[data-heat] button');
    if (hb) { heatSide[hb.parentNode.dataset.heat] = hb.dataset.v; renderMix(); return; }
    const lg = e.target.closest('.lg[data-series]');
    if (lg) {
      const k = lg.dataset.series;
      if (hiddenSeries.has(k)) hiddenSeries.delete(k); else hiddenSeries.add(k);
      renderTrend(data);
      return;
    }
    const el = e.target.closest('[data-detail]');
    if (el && !e.target.closest('.modal') && !e.target.closest('.drawer')) {
      hideTip();
      try { openDetail(JSON.parse(el.getAttribute('data-detail')), true); } catch (err) { /* ignore bad scope */ }
    }
  });
  function renderMix() {
    const mix = { TV: data.tvMix, Radio: data.radioMix, Press: data.pressMix }[mixMedium];
    $('chMix').innerHTML = mixHtml(mix, data, mixMedium, 'mx');
    $('p-mix').textContent = `% of ${mixMedium} spend per month`;
  }
  document.querySelector('.tgl[data-mixmed]').addEventListener('click', e => {
    const b = e.target.closest('button');
    if (!b || !data) return;
    mixMedium = b.dataset.v;
    [...b.parentNode.children].forEach(x => x.classList.toggle('on', x === b));
    renderMix();
  });
  document.querySelector('.tgl[data-durmed]').addEventListener('click', e => {
    const b = e.target.closest('button');
    if (!b || !data) return;
    durMedium = b.dataset.v;
    [...b.parentNode.children].forEach(x => x.classList.toggle('on', x === b));
    renderDuration(data);
  });

  const tip = $('tip');
  let tipEl = null;
  function hideTip() { tip.classList.remove('on'); tipEl = null; }
  document.addEventListener('mousemove', e => {
    const el = e.target.closest && e.target.closest('[data-tip]');
    if (!el || el.closest('.drawer') || el.closest('.modal')) { if (tipEl) hideTip(); return; }
    if (el !== tipEl) {
      tipEl = el;
      const lines = el.getAttribute('data-tip').split('\n').map(esc);
      const last = lines.length > 1 && /^Click/.test(lines[lines.length - 1]) ? `<span class="k">${lines.pop()}</span>` : '';
      tip.innerHTML = (lines.length > 1 ? `<span class="h">${lines.shift()}</span>` : '') + lines.join('<br>') + last;
      tip.classList.add('on');
    }
    // Position in viewport pixels, kept inside the window.
    const r = tip.getBoundingClientRect(), pad = 14;
    let x = e.clientX + pad, y = e.clientY + pad;
    if (x + r.width > window.innerWidth - 6) x = e.clientX - r.width - pad;
    if (y + r.height > window.innerHeight - 6) y = e.clientY - r.height - pad;
    const sc = parseFloat(document.body.style.getPropertyValue('--s')) || 1;
    tip.style.left = x / sc + 'px'; tip.style.top = y / sc + 'px';
  });
  document.addEventListener('mouseleave', hideTip);

  // ---------- detail pop-up ----------
  const modal = $('modal');
  let detailStack = [], detailData = null, detailTab = 'adv';
  function closeDetail() { modal.classList.remove('on'); detailStack = []; }
  $('mClose').addEventListener('click', closeDetail);
  modal.addEventListener('click', e => { if (e.target === modal) closeDetail(); });
  document.addEventListener('keydown', e => { if (e.key === 'Escape' && modal.classList.contains('on')) closeDetail(); });
  $('mBack').addEventListener('click', () => { detailStack.pop(); const prev = detailStack.pop(); if (prev) openDetail(prev, false); });
  $('mTabs').addEventListener('click', e => {
    const b = e.target.closest('button');
    if (!b) return;
    detailTab = b.dataset.t;
    renderDetailBody();
  });
  // Rows inside the pop-up drill one level deeper.
  $('mBody').addEventListener('click', e => {
    const row = e.target.closest('[data-sub]');
    if (!row) return;
    const cur = detailStack[detailStack.length - 1];
    const add = JSON.parse(row.getAttribute('data-sub'));
    openDetail({ ...cur, ...add, mine: add.advertiser ? undefined : cur.mine, tab: add.tab || cur.tab }, false);
  });

  const scopeText = sc => {
    const parts = [];
    if (sc.month) { const [y, m] = sc.month.split('-'); parts.push(`${MON[+m - 1]} ${y}`); }
    else if (sc.year) parts.push(`${sc.year} (full year of data)`);
    else if (sc.from) parts.push(`${fmtDate(sc.from)} to ${fmtDate(sc.to)}`);
    else parts.push(`${fmtDate(data.filters.from)} to ${fmtDate(data.filters.to)}`);
    parts.push(data.filters.pg);
    if (sc.medium) parts.push(sc.exclude ? `Other ${sc.medium} channels` : sc.medium);
    if (sc.channel) parts.push(sc.channel);
    if (sc.advertiser) parts.push(sc.advertiser);
    if (sc.theme) parts.push(`“${sc.theme}”`);
    if (sc.dur) parts.push(`${sc.dur} TV and Radio ads`);
    if (sc.mine) parts.push('mine only');
    if (data.filters.medium !== 'All' && !sc.medium) parts.push(data.filters.medium + ' only');
    if (data.filters.daypart) parts.push(dpLabel(data.filters.daypart));
    if (data.filters.adType === 'Commercial') parts.push('commercials only');
    if (data.filters.adType === 'Sponsorship') parts.push('value additions only');
    return parts.join(' · ');
  };

  // The filters behind what is on screen (the drawer may hold unapplied edits).
  function appliedFilters() {
    const { from, to, pg, mine, comps, medium, channel, daypart, adType } = data.filters;
    return { from, to, pg, mine: mine.slice(), comps: comps.slice(), medium, channel, daypart, adType: adType || 'All' };
  }

  async function openDetail(scope, fresh) {
    if (fresh) detailStack = [];
    detailStack.push(scope);
    detailTab = scope.tab || 'adv';
    $('mTitle').textContent = scope.title || 'Details';
    $('mSub').textContent = scopeText(scope);
    $('mBack').style.display = detailStack.length > 1 ? '' : 'none';
    $('mStats').innerHTML = '';
    $('mBody').innerHTML = '<div class="mload">Loading</div>';
    $('mFoot').innerHTML = '';
    modal.classList.add('on');
    try {
      const { title, tab, ...s2 } = scope;
      detailData = await api('/api/detail', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ filters: appliedFilters(), scope: s2 }) });
      renderDetail(scope);
    } catch (e) {
      $('mBody').innerHTML = `<div class="mload">${esc(e.message)}</div>`;
    }
  }

  function renderDetail(scope) {
    const x = detailData;
    const stat = (l, v, style) => `<div class="ms"><div class="l">${l}</div><div class="v" style="${style || ''}">${v}</div></div>`;
    $('mStats').innerHTML = stat('Spend', money(x.total)) + stat('Spots', nf(x.spots)) +
      stat('Mine', x.total ? `${money(x.mineTotal)} <span style="font-size:11px;color:#8A93AD">${pctS((x.mineTotal / x.total) * 100)}</span>` : 'LKR 0', `color:${C.deep}`) +
      stat('Avg per spot', money(x.spots ? x.total / x.spots : 0));
    // Actions that push what you found back into the dashboard.
    const acts = [];
    if (scope.month || scope.from || scope.year) acts.push(`<button class="abtn pri" data-act="month">Zoom dashboard to ${esc($('mSub').textContent.split(' · ')[0])}</button>`);
    if (scope.channel) acts.push(`<button class="abtn" data-act="channel">Filter dashboard to ${esc(scope.channel)}</button>`);
    if (scope.medium && !scope.channel) acts.push(`<button class="abtn" data-act="medium">Show ${esc(scope.medium)} only</button>`);
    if (scope.advertiser && !state.mine.includes(scope.advertiser) && !state.comps.includes(scope.advertiser)) acts.push(`<button class="abtn" data-act="comp">Add ${esc(scope.advertiser)} as competitor</button>`);
    $('mFoot').innerHTML = acts.join('');
    renderDetailBody();
  }

  $('mFoot').addEventListener('click', e => {
    const b = e.target.closest('[data-act]');
    if (!b) return;
    const sc = detailStack[detailStack.length - 1];
    Object.assign(state, appliedFilters());
    if (b.dataset.act === 'month' && sc.year) {
      const fy = `${sc.year}-01-01`, ly = `${sc.year}-12-31`;
      state.from = fy < overview.minDate ? overview.minDate : fy;
      state.to = ly > overview.maxDate ? overview.maxDate : ly;
    } else if (b.dataset.act === 'month' && sc.from) {
      state.from = sc.from; state.to = sc.to;
    } else if (b.dataset.act === 'month') {
      const [y, m] = sc.month.split('-').map(Number);
      const last = new Date(Date.UTC(y, m, 0)).toISOString().slice(0, 10);
      state.from = sc.month + '-01' < overview.minDate ? overview.minDate : sc.month + '-01';
      state.to = last > overview.maxDate ? overview.maxDate : last;
    } else if (b.dataset.act === 'channel') {
      const c = options.channels.find(o => o.name === sc.channel);
      state.channel = sc.channel;
      if (c) state.medium = c.medium;
    } else if (b.dataset.act === 'medium') {
      state.medium = sc.medium; state.channel = '';
    } else if (b.dataset.act === 'comp') {
      state.comps.push(sc.advertiser);
    }
    closeDetail(); writeForm(); refresh();
    toast('Dashboard updated');
  });

  function renderDetailBody() {
    const x = detailData;
    if (!x) return;
    [...$('mTabs').children].forEach(b => b.classList.toggle('on', b.dataset.t === detailTab));
    const sub = o => ` data-sub="${esc(JSON.stringify(o))}"`;
    const bar = (v, max) => `<span class="sharebar" style="width:${max ? Math.max(2, (v / max) * 60) : 0}px"></span>`;
    const tag = r => (r === 'mine' ? '<span class="rtag mine">MINE</span>' : r === 'comp' ? '<span class="rtag comp">COMPETITOR</span>' : '');
    let html = '';
    if (detailTab === 'adv') {
      const rows = x.advertisers.filter(a => a.spend > 0);
      const max = rows.length ? rows[0].spend : 0;
      html = `<table><tbody><tr><th>#</th><th>Advertiser</th><th class="num">Spend</th><th class="num">SOS</th><th class="num">Spots</th><th class="num">Avg per spot</th></tr>` +
        rows.map((a, i) => `<tr class="${a.role === 'mine' ? 'me' : ''}"${sub({ advertiser: a.name, title: a.name, tab: 'camp' })} style="cursor:pointer" title="Click to see ${esc(a.name)} in detail">
            <td class="rk">${i + 1}</td><td class="nm">${esc(a.name)}${tag(a.role)}</td>
            <td class="num">${bar(a.spend, max)}${money(a.spend, false)}</td><td class="num">${x.total ? pctS((a.spend / x.total) * 100) : ''}</td>
            <td class="num">${nf(a.spots)}</td><td class="num">${money(a.spots ? a.spend / a.spots : 0, false)}</td></tr>`).join('') + '</tbody></table>';
      if (!rows.length) html = '<div class="mload">No spend in this selection</div>';
    } else if (detailTab === 'camp') {
      const max = x.campaigns.length ? x.campaigns[0].spend : 0;
      html = `<table><tbody><tr><th>#</th><th>Campaign (Advt_Theme)</th><th>Advertiser</th><th class="num">Spend</th><th class="num">Share</th><th class="num">Spots</th></tr>` +
        x.campaigns.map((c, i) => `<tr class="${c.role === 'mine' ? 'me' : ''}"${sub({ advertiser: c.advertiser, theme: c.name, title: `“${c.name}”`, tab: 'ch' })} style="cursor:pointer" title="Click to see where this campaign ran">
          <td class="rk">${i + 1}</td><td class="nm">“${esc(c.name)}”</td><td class="nm">${esc(c.advertiser)}${tag(c.role)}</td>
          <td class="num">${bar(c.spend, max)}${money(c.spend, false)}</td><td class="num">${x.total ? pctS((c.spend / x.total) * 100) : ''}</td><td class="num">${nf(c.spots)}</td></tr>`).join('') + '</tbody></table>';
      if (!x.campaigns.length) html = '<div class="mload">No campaigns in this selection</div>';
    } else if (detailTab === 'mon') {
      const rows = x.months;
      const max = Math.max(0, ...rows.map(m => m.spend));
      html = `<table><tbody><tr><th>Month</th><th class="num">Spend</th><th class="num">Spots</th><th class="num">Share of category</th><th class="num">Category spend</th></tr>` +
        rows.map(m => `<tr${sub({ month: m.key, title: `${(detailStack[detailStack.length - 1].title || '').split(' · ')[0]} · ${m.label} ${m.year}`, tab: 'adv' })} style="cursor:pointer" title="Click to open ${m.label} ${m.year}">
          <td class="nm">${m.label} ${m.year}</td><td class="num">${bar(m.spend, max)}${money(m.spend, false)}</td><td class="num">${nf(m.spots)}</td>
          <td class="num" style="font-weight:700">${m.category ? pctS((m.spend / m.category) * 100) : 'n/a'}</td><td class="num" style="color:#8A93AD">${money(m.category, false)}</td></tr>`).join('') + '</tbody></table>';
      if (!rows.length) html = '<div class="mload">No months in this selection</div>';
    } else {
      const max = x.channels.length ? x.channels[0].spend : 0;
      html = `<table><tbody><tr><th>#</th><th>Channel</th><th>Medium</th><th class="num">Spend</th><th class="num">Share</th><th class="num">Spots</th><th class="num">Mine</th><th class="num">My share</th></tr>` +
        x.channels.map((c, i) => `<tr${sub({ channel: c.name, title: c.short, tab: 'adv' })} style="cursor:pointer">
          <td class="rk">${i + 1}</td><td class="nm">${esc(c.short)}</td><td>${c.medium}</td>
          <td class="num">${bar(c.spend, max)}${money(c.spend, false)}</td><td class="num">${x.total ? pctS((c.spend / x.total) * 100) : ''}</td>
          <td class="num">${nf(c.spots)}</td><td class="num mineval">${money(c.mine, false)}</td><td class="num mineval">${pctS(c.spend ? (c.mine / c.spend) * 100 : 0)}</td></tr>`).join('') + '</tbody></table>';
      if (!x.channels.length) html = '<div class="mload">No spend in this selection</div>';
    }
    $('mBody').innerHTML = html;
    $('mBody').scrollTop = 0;
  }

  // ---------- export and share ----------
  const menu = $('exportMenu');
  $('exportBtn').addEventListener('click', e => { e.stopPropagation(); menu.classList.toggle('on'); });
  document.addEventListener('click', e => { if (!menu.contains(e.target)) menu.classList.remove('on'); });
  menu.addEventListener('click', e => {
    const b = e.target.closest('button[data-x]');
    if (!b) return;
    menu.classList.remove('on');
    if (!data) return toast('Nothing to export yet');
    ({ jpg: exportImage, pdf: exportPdf, csv: exportCsv })[b.dataset.x]();
  });
  const fileBase = () => `Ogilvy_Orbit_Chub_${data.filters.pg.replace(/[^\w]+/g, '-')}_${data.filters.from}_to_${data.filters.to}`;
  const loadScript = src => new Promise((ok, fail) => {
    if (document.querySelector(`script[src="${src}"]`)) return ok();
    const el = document.createElement('script');
    el.src = src; el.onload = ok; el.onerror = () => fail(new Error('Could not load ' + src));
    document.head.appendChild(el);
  });
  // Renders the whole dashboard (every card) to one JPEG, leaving out the drawer, menus and buttons.
  async function captureDashboard() {
    await loadScript('vendor/html-to-image/html-to-image.js');
    $('drawerToggle').checked = false;
    await new Promise(r => setTimeout(r, 320));
    const b = document.body, w = b.offsetWidth, h = b.offsetHeight;
    b.classList.add('exporting');
    const skip = new Set(['drawer', 'drawerToggle', 'toast', 'overlay', 'filterBtn', 'tright', 'modal', 'tip', 'exportStage']);
    const url = await window.htmlToImage.toJpeg(b, {
      quality: 0.95, pixelRatio: 2, backgroundColor: '#F4F6FA', width: w, height: h,
      style: { transform: 'none' },
      filter: node => !(node.id && skip.has(node.id)) && !(node.classList && node.classList.contains('scrim')),
    }).finally(() => b.classList.remove('exporting'));
    return { url, w, h };
  }
  // One chart as its own image: a copy of the card under a branded header (logo, name, period, filters).
  async function captureCard(el) {
    const stage = $('exportStage');
    const w = Math.round(el.getBoundingClientRect().width / (parseFloat(document.body.style.getPropertyValue('--s')) || 1));
    const h = el.offsetHeight;
    const chips = [...document.querySelectorAll('#chips .chip')].filter(c => c.id !== 'busyChip').map(c => c.textContent).join(' · ');
    stage.innerHTML = `<div class="xframe" style="width:${w + 40}px">
      <div class="xhead"><img src="ogilvy-orbit-chub.png" alt="Ogilvy Orbit – Chub"><div><span>${esc($('periodText').textContent.replace(/\s+/g, ' '))} · ${esc(chips)}</span></div></div>
      <div class="xbody"></div></div>`;
    const copy = el.cloneNode(true);
    copy.style.width = w + 'px'; copy.style.height = h + 'px'; copy.style.flex = 'none';
    copy.querySelectorAll('.acc, .sost, .heat').forEach(a => { a.style.overflow = 'hidden'; });
    stage.querySelector('.xbody').appendChild(copy);
    await stage.querySelector('.xhead img').decode().catch(() => {});
    const frame = stage.firstElementChild;
    try {
      return await window.htmlToImage.toJpeg(frame, { quality: 0.95, pixelRatio: 2, backgroundColor: '#F4F6FA' });
    } finally { stage.innerHTML = ''; }
  }
  const EXPORT_PARTS = [
    ['01_KPIs', 'kpis'], ['02_Medium_Split', 'cardMedium'], ['03_Monthly_Spend_Trend', 'cardTrend'], ['04_Month_Drill_Down', 'cardDrill'],
    ['05_Share_of_Spend', 'cardSos'], ['06_Channel_Mix', 'cardMix'], ['07_Duration_Mix', 'cardDur'],
  ];
  async function exportImage() {
    toast('Preparing JPG images');
    try {
      const [{ url }] = await Promise.all([captureDashboard(), loadScript('vendor/jszip/jszip.min.js')]);
      const zip = new window.JSZip();
      const b64 = u => u.split(',')[1];
      zip.file('00_Full_Dashboard.jpg', b64(url), { base64: true });
      document.body.classList.add('exporting');
      try {
        for (const [name, id] of EXPORT_PARTS) zip.file(`${name}.jpg`, b64(await captureCard($(id))), { base64: true });
      } finally { document.body.classList.remove('exporting'); }
      const blob = await zip.generateAsync({ type: 'blob' });
      const a = document.createElement('a');
      a.href = URL.createObjectURL(blob); a.download = fileBase() + '_JPG.zip'; a.click();
      setTimeout(() => URL.revokeObjectURL(a.href), 2000);
      toast('ZIP downloaded: full dashboard + 7 charts');
    } catch (e) { toast('Export failed: ' + e.message); }
  }
  async function exportPdf() {
    toast('Preparing PDF');
    try {
      const [{ url, w, h }] = await Promise.all([captureDashboard(), loadScript('vendor/jspdf/jspdf.umd.min.js')]);
      const { jsPDF } = window.jspdf;
      const pdf = new jsPDF({ orientation: w >= h ? 'landscape' : 'portrait', unit: 'pt', format: [w, h] });
      pdf.setProperties({ title: 'Ogilvy Orbit – Chub', author: 'Ogilvy' });
      pdf.addImage(url, 'JPEG', 0, 0, w, h);
      pdf.save(fileBase() + '.pdf');
      toast('PDF downloaded');
    } catch (e) { toast('Export failed: ' + e.message); }
  }
  function exportCsv() {
    const d = data, q = v => `"${String(v).replace(/"/g, '""')}"`;
    const lines = [
      ['Ogilvy Orbit – Chub'], ['Period', `${fmtDate(d.filters.from)} to ${fmtDate(d.filters.to)}`], ['Product group', d.filters.pg],
      ['Medium', d.filters.medium], ['Ad type', { Sponsorship: 'Value Additions', Commercial: 'Commercials' }[d.filters.adType] || 'All'], ['Channel', d.filters.channel || 'All'], ['Daypart', d.filters.daypart || 'All'], ['Spend basis', 'Rate card (LKR)'], [],
      ['KPI', 'Value'], ['Category spend', d.kpi.catSpend], ['My spend', d.kpi.mineSpend], ['Share of spend %', d.kpi.sos.toFixed(2)],
      ['Rank', d.kpi.rank ? `${d.kpi.rank} of ${d.kpi.rankOf}` : ''], ['Category spots', d.kpi.catSpots], ['My spots', d.kpi.mineSpots], [],
      ['Month', d.mineLabel + ' (mine)'].concat(d.trend.competitors.map(c => c.name), ['Category avg per advertiser', 'Category total', 'Top spender', 'Lead campaign', 'Campaign advertiser']),
    ];
    d.months.forEach((m, i) => {
      const dr = d.drill[i];
      lines.push([m.key, Math.round(d.trend.mine[i])].concat(d.trend.competitors.map(c => Math.round(c.values[i])),
        [Math.round(d.trend.categoryAvg[i]), Math.round(dr.category), dr.leader ? dr.leader.name : '', dr.campaign ? dr.campaign.name : '', dr.campaign ? dr.campaign.advertiser : '']));
    });
    const csv = lines.map(r => r.map(v => (typeof v === 'number' ? v : q(v))).join(',')).join('\r\n');
    const a = document.createElement('a');
    a.href = URL.createObjectURL(new Blob(['﻿' + csv], { type: 'text/csv' }));
    a.download = fileBase() + '.csv';
    a.click();
    setTimeout(() => URL.revokeObjectURL(a.href), 1000);
  }
  $('shareBtn').addEventListener('click', async () => {
    const url = location.origin + location.pathname + '#' + encodeURIComponent(JSON.stringify(state));
    try { await navigator.clipboard.writeText(url); toast('Link with current filters copied'); } catch (e) { prompt('Copy this link', url); }
  });

  // ---------- boot ----------
  (async function boot() {
    try {
      const s = await api('/api/status');
      renderDataFile(s.dataset);
      if (s.dataset) await loadOverview(false);
      else { showEmpty(); showPane('paneData'); }
      if (s.job.state === 'processing') pollStatus();
      else if (s.job.state === 'error') setUploadStatus(`Last upload failed: ${s.job.error}`, true);
    } catch (e) {
      showOverlay('Cannot reach the server', e.message);
    }
  })();
})();
