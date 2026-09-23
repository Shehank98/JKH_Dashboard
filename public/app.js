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
    durMine: ['#FF8A3D', '#FFA766', '#FFC599', '#E4702A'], durComp: ['#2F5DBF', '#5B8DEF', '#8FB2F5', '#1E3F8A'],
  };

  // ---------- state ----------
  let overview = null;      // product groups, date bounds
  let options = { advertisers: [], channels: [] };
  let data = null;          // last dashboard response
  const state = { from: '', to: '', compare: true, pg: '', mine: [], comps: [], medium: 'All', channel: '', daypart: '' };
  let pendingFile = null;
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
  function toast(msg) {
    const t = $('toast');
    t.textContent = msg; t.classList.add('on');
    clearTimeout(toast.t); toast.t = setTimeout(() => t.classList.remove('on'), 2200);
  }
  // Light segments get dark text for contrast.
  const segClass = (color) => (['#BFD3F6', '#8FB2F5', '#A8C2F2'].includes(color) ? 'lt' : ['#FFDCC0', '#FFC599'].includes(color) ? 'lto' : '');

  // ---------- scale to fit small screens ----------
  function fit() {
    const s = Math.min(1, window.innerWidth / 1440, window.innerHeight / 900);
    document.body.style.transform = s < 1 ? `scale(${s})` : '';
  }
  window.addEventListener('resize', fit); fit();

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
      overview.dayparts.map(d => `<option value="${esc(d)}">${esc(d === 'Prime' ? 'Prime (18:30 to 22:30)' : d)}</option>`).join('');
    const { minDate, maxDate } = overview;
    $('fFrom').min = $('fTo').min = minDate; $('fFrom').max = $('fTo').max = maxDate;

    const groups = overview.productGroups.map(g => g.name);
    if (saved && groups.includes(saved.pg)) {
      Object.assign(state, saved);
    } else {
      const jan = maxDate.slice(0, 4) + '-01-01';
      Object.assign(state, { from: jan > minDate ? jan : minDate, to: maxDate, compare: true, pg: groups[0], mine: [], comps: [], medium: 'All', channel: '', daypart: '' });
    }
    await loadOptions(!(saved && saved.pg === state.pg && saved.mine && saved.mine.length));
    writeForm();
    await refresh();
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
    $('fCompare').checked = !!state.compare;
    $('fPg').value = state.pg;
    $('fDaypart').value = state.daypart || '';
    [...$('fMedium').children].forEach(b => b.classList.toggle('on', b.dataset.v === state.medium));
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
  $('fChannel').addEventListener('change', e => { state.channel = e.target.value; });
  $('fDaypart').addEventListener('change', e => { state.daypart = e.target.value; });
  $('fCompare').addEventListener('change', e => { state.compare = e.target.checked; });
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
    ['k1d', 'k2d', 'k3d'].forEach(id => { $(id).innerHTML = '&nbsp;'; });
    ['donut', 'trend', 'drill', 'tvMix', 'radioMix', 'duration'].forEach(id => { $(id).innerHTML = ''; });
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
    if (f.channel) chips.push(`<span class="chip">${esc(f.channel)}</span>`);
    if (f.daypart) chips.push(`<span class="chip">${esc(f.daypart)}</span>`);
    const busy = $('busyChip');
    $('chips').innerHTML = chips.join('');
    if (busy) $('chips').prepend(busy);

    $('k1v').textContent = money(k.catSpend);
    $('k1d').innerHTML = join([delta(k.catSpend, k.catPrev), `${nf(k.advertisers)} advertisers`, `${nf(k.catSpots)} spots`]);
    $('k2v').textContent = money(k.mineSpend);
    $('k2d').innerHTML = join([delta(k.mineSpend, k.minePrev), `${nf(k.mineSpots)} spots`, `avg ${money(k.avgCost, false)} per spot`]);
    $('k3v').textContent = nf(k.sos, 1) + '%';
    $('k3d').innerHTML = join([k.rank ? `Rank <strong>#${k.rank}</strong> of ${k.rankOf}` : `Not ranked`, ppDelta(k.sos, k.sosPrev)]);

    renderDonut(d.medium);
    renderTrend(d);
    renderDrill(d);
    $('tvMix').innerHTML = mixHtml(d.tvMix, d, 'TV', 'tv');
    $('radioMix').innerHTML = mixHtml(d.radioMix, d, 'Radio', 'rd');
    renderDuration(d);
  }

  function renderDonut(m) {
    const circ = 2 * Math.PI * 50;
    let off = 0;
    const segs = m.category.map((p, i) => {
      const len = (p / 100) * circ;
      const s = `<circle r="50" fill="none" stroke="${C.medium[i]}" stroke-width="19" stroke-dasharray="${len.toFixed(2)} ${(circ - len).toFixed(2)}" stroke-dashoffset="${(-off).toFixed(2)}"></circle>`;
      off += len;
      return len > 0 ? s : '';
    }).join('');
    const total = money(m.categoryTotal, false);
    const rows = m.names.map((n, i) => {
      const idx = m.mine[i] - m.category[i];
      const cls = idx > 0.05 ? 'up' : idx < -0.05 ? 'down' : 'flat';
      const arrow = idx > 0.05 ? '▲' : idx < -0.05 ? '▼' : '';
      return `<tr><td><span class="sw" style="background:${C.medium[i]};margin-right:6px"></span>${n}</td>
        <td class="num">${nf(m.category[i], 1)}%</td><td class="num mineval">${nf(m.mine[i], 1)}%</td>
        <td class="num ${cls}">${arrow} ${idx > 0 ? '+' : idx < 0 ? '−' : ''}${nf(Math.abs(idx), 1)}</td></tr>`;
    }).join('');
    $('donut').innerHTML = `<svg viewBox="0 0 200 148" width="100%" height="136">
      <g transform="translate(100,72) rotate(-90)"><circle r="50" fill="none" stroke="#F0F2F8" stroke-width="19"></circle>${segs}</g>
      <text x="100" y="70" text-anchor="middle" font-size="16" font-weight="700" fill="#1A1F36">${esc(total)}</text>
      <text x="100" y="84" text-anchor="middle" font-size="7.5" fill="#8A93AD">CATEGORY TOTAL</text></svg>
      <table><tbody><tr><th>Medium</th><th class="num">Cat.</th><th class="num">Mine</th><th class="num" title="Mine minus category, percentage points">Idx</th></tr>${rows}</tbody></table>`;
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
    const X0 = 42, X1 = 978, Y0 = 204, Y1 = 40;
    const toMn = v => v / 1e6;
    const series = [d.trend.mine, d.trend.categoryAvg].concat(d.trend.competitors.map(c => c.values));
    const max = niceMax(Math.max(0, ...series.flat().map(toMn)));
    const x = i => (n === 1 ? (X0 + X1) / 2 : X0 + (i * (X1 - X0)) / (n - 1));
    const y = v => Y0 - (toMn(v) / max) * (Y0 - Y1);
    const pts = vals => vals.map((v, i) => [x(i), y(v)]);
    const grid = [0, 1, 2, 3, 4].map(k => {
      const yy = Y0 - (k * (Y0 - Y1)) / 4, val = (max * k) / 4;
      return `<line x1="${X0}" y1="${yy}" x2="980" y2="${yy}" stroke="#EEF1F7"></line><text x="34" y="${yy + 4}" text-anchor="end">${nf(val, max < 4 ? 1 : 0)}</text>`;
    }).join('');
    const every = Math.ceil(n / 12);
    const xl = months.map((m, i) => (i % every === 0 || i === n - 1 ? `<text x="${x(i)}" y="226">${esc(monthLabel(m, months))}</text>` : '')).join('');
    const comps = d.trend.competitors.map((c, i) => `<path fill="none" stroke="${C.compLines[i % C.compLines.length]}" stroke-width="${i === 0 ? 2.4 : 2}" stroke-linecap="round" stroke-linejoin="round" d="${smoothPath(pts(c.values))}"></path>`).reverse().join('');
    const avg = `<path fill="none" stroke="#B4BCD0" stroke-width="1.5" stroke-dasharray="2 4" stroke-linecap="round" d="${smoothPath(pts(d.trend.categoryAvg))}"></path>`;
    const mp = pts(d.trend.mine);
    const minePath = smoothPath(mp);
    const area = n > 1 ? `<path fill="url(#mineFill)" d="${minePath} L${mp[n - 1][0]},${Y0} L${mp[0][0]},${Y0} Z"></path>` : '';
    const dots = mp.map((p, i) => i === n - 1
      ? `<circle cx="${p[0]}" cy="${p[1]}" r="5.5" fill="${C.orange}" stroke="#fff" stroke-width="2.5"></circle>`
      : `<circle cx="${p[0]}" cy="${p[1]}" r="4" fill="${C.orange}"></circle>`).join('');
    let callout = '';
    const peakV = Math.max(...d.trend.mine);
    if (peakV > 0) {
      const pi = d.trend.mine.indexOf(peakV), [px, py] = mp[pi];
      const label = `${mn(peakV)} peak`, w = label.length * 7.4 + 18;
      const rx = Math.max(X0, Math.min(980 - w, px - w / 2));
      const ry = py - 34 < 4 ? py + 12 : py - 32;
      callout = `<rect x="${rx}" y="${ry}" width="${w}" height="22" rx="6" fill="#FFF1E6"></rect><text x="${rx + w / 2}" y="${ry + 15.5}" font-size="12.5" font-weight="700" fill="${C.deep}" text-anchor="middle">${label}</text>`;
    }
    const legend = [`<div class="lg"><span class="sw" style="background:${C.orange};height:4px;width:18px"></span><strong>${esc(d.mineLabel)} (mine)</strong></div>`]
      .concat(d.trend.competitors.map((c, i) => `<div class="lg"><span class="sw" style="background:${C.compLines[i % C.compLines.length]};height:3px;width:18px"></span>${esc(c.name)}</div>`))
      .concat(['<div class="lg"><span class="sw" style="background:repeating-linear-gradient(90deg,#B4BCD0 0 3px,transparent 3px 6px);height:2px;width:18px"></span>Category avg.</div>']).join('');
    $('trend').innerHTML = `<svg viewBox="0 0 1000 236" width="100%" height="216" style="margin-top:4px">
      <defs><linearGradient id="mineFill" x1="0" y1="0" x2="0" y2="1"><stop offset="0%" stop-color="${C.orange}" stop-opacity=".22"></stop><stop offset="100%" stop-color="${C.orange}" stop-opacity="0"></stop></linearGradient></defs>
      <g font-size="12" fill="#9AA3BC" stroke-width="1">${grid}</g>
      ${area}${comps}${avg}
      <path fill="none" stroke="${C.orange}" stroke-width="3.6" stroke-linecap="round" stroke-linejoin="round" d="${minePath}"></path>
      ${dots}${callout}
      <g font-size="12.5" fill="#8A93AD" text-anchor="middle">${xl}</g></svg>
      <div class="legend">${legend}</div>`;
  }

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
        const parts = [`<strong>${money(L.spend)}</strong> · ${nf(m.category ? (L.spend / m.category) * 100 : 0, 1)}% SOS`];
        if (m.campaign) parts.push(`<span class="tag">“${esc(m.campaign.name)}”</span> ${mn(m.campaign.spend)} across ${nf(m.campaign.spots)} spots`);
        body = parts.join(' · ') + '.';
        if (!L.mine) body += ` Leader ${esc(L.name)}.`;
        if (m.runnerUp) body += ` Runner up ${esc(m.runnerUp.name)} ${mn(m.runnerUp.spend)}.`;
        if (!L.mine && !(m.runnerUp && m.runnerUp.mine)) body += m.mineSpend > 0 ? ` Mine ${mn(m.mineSpend)}.` : ' No spend from mine.';
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
        <div class="dbody"><p id="p-m-q">${lines.join(' ')} Quieter period, category ${money(total)}, mine ${mn(mineTot)}.</p></div></details>`);
    }
    $('drill').innerHTML = html.join('');
  }

  function mixHtml(mix, d, medium, key) {
    if (!mix.channels.length) return `<div class="nodata" style="height:280px">No ${medium} spend in this selection</div>`;
    const n = d.months.length;
    const k = mix.channels.length;
    const blues = C.blues.slice(0, k - 1).concat([C.blues[3]]), oranges = C.oTints.slice(0, k - 1).concat([C.oTints[3]]);
    const showText = n <= 14;
    const bars = (series, colors) => `<div class="bars" style="grid-template-columns:repeat(${n},1fr)">` + series.map((parts, i) => {
      const segs = parts ? parts.map((p, j) => ({ p, c: colors[j] })).reverse()
        .map(s => `<div class="${segClass(s.c)}" style="height:${s.p}%;background:${s.c}">${showText && s.p >= 9 ? Math.round(s.p) : ''}</div>`).join('') : '';
      return `<div><div class="stack" title="${parts ? mix.channels.map((c, j) => `${c} ${nf(parts[j], 1)}%`).join(', ') : 'No spend'}">${segs}</div><div class="bl">${esc(monthLabel(d.months[i], d.months))}</div></div>`;
    }).join('') + '</div>';
    const legend = mix.channels.map((c, j) => `<div class="lg"><span class="sw" style="background:${blues[j]}"></span>${esc(c)}</div>`).join('');
    return `<p class="secl" id="p-${key}a">CATEGORY</p>${bars(mix.category, blues)}
      <p class="secl" id="p-${key}b" style="color:${C.deep}">${esc(d.mineLabel.toUpperCase())} (MINE)</p>${bars(mix.mine, oranges)}
      <div class="legend">${legend}<div class="lg" style="margin-left:6px"><span class="sw" style="background:${C.orange}"></span>Mine, same order</div></div>`;
  }

  function renderDuration(d) {
    const rows = d.duration.rows;
    const n = rows.length;
    const rowH = Math.min(46, 232 / n), barH = Math.max(14, Math.min(30, rowH - 12));
    const html = rows.map((r, i) => {
      const colors = r.mine ? C.durMine : C.durComp;
      const nameStyle = r.mine ? `color:${C.deep};font-weight:700` : r.avg ? 'color:#8A93AD' : '';
      const bar = r.split
        ? r.split.map((p, j) => `<div class="${segClass(colors[j])}" style="width:${p}%;background:${colors[j]}">${p >= 7 ? Math.round(p) : ''}</div>`).join('')
        : '<div style="width:100%;color:#9AA3BC;font-weight:500">No TV or Radio spots</div>';
      return `<div class="durline" style="margin-bottom:${i === n - 1 ? 0 : rowH - barH}px"><span class="durname" style="${nameStyle}" title="${esc(r.mine ? r.name + ' (mine)' : r.name)}">${esc(r.name)}</span>
        <div class="durrow" style="flex:1;height:${barH}px;${r.avg ? 'opacity:.55' : ''}">${bar}</div></div>`;
    }).join('');
    $('duration').innerHTML = `<p class="secl" id="p-durb" style="margin-top:14px">5s / 15s / 20s / 30s SPLIT · SHARE OF TV AND RADIO SPOTS</p>
      <div style="margin-top:12px">${html}</div>
      <div class="legend" style="margin-top:14px">${d.duration.buckets.map((b, j) => `<div class="lg"><span class="sw" style="background:${C.durComp[j]}"></span>${b}</div>`).join('')}</div>`;
  }

  // ---------- export and share ----------
  $('exportBtn').addEventListener('click', () => {
    if (!data) return toast('Nothing to export yet');
    const d = data, q = v => `"${String(v).replace(/"/g, '""')}"`;
    const lines = [
      ['Competitive Ad Spend Dashboard'], ['Period', `${fmtDate(d.filters.from)} to ${fmtDate(d.filters.to)}`], ['Product group', d.filters.pg],
      ['Medium', d.filters.medium], ['Channel', d.filters.channel || 'All'], ['Daypart', d.filters.daypart || 'All'], ['Spend basis', 'Rate card (LKR)'], [],
      ['KPI', 'Value'], ['Category spend', d.kpi.catSpend], ['My spend', d.kpi.mineSpend], ['Share of spend %', d.kpi.sos.toFixed(2)],
      ['Rank', d.kpi.rank ? `${d.kpi.rank} of ${d.kpi.rankOf}` : ''], ['Category spots', d.kpi.catSpots], ['My spots', d.kpi.mineSpots], [],
      ['Month', d.mineLabel + ' (mine)'].concat(d.trend.competitors.map(c => c.name), ['Category avg per advertiser', 'Category total', 'Top spender', 'Lead campaign']),
    ];
    d.months.forEach((m, i) => {
      const dr = d.drill[i];
      lines.push([m.key, Math.round(d.trend.mine[i])].concat(d.trend.competitors.map(c => Math.round(c.values[i])),
        [Math.round(d.trend.categoryAvg[i]), Math.round(dr.category), dr.leader ? dr.leader.name : '', dr.campaign ? dr.campaign.name : '']));
    });
    const csv = lines.map(r => r.map(v => (typeof v === 'number' ? v : q(v))).join(',')).join('\r\n');
    const a = document.createElement('a');
    a.href = URL.createObjectURL(new Blob(['﻿' + csv], { type: 'text/csv' }));
    a.download = `ad-spend_${d.filters.pg.replace(/[^\w]+/g, '-')}_${d.filters.from}_to_${d.filters.to}.csv`;
    a.click();
    setTimeout(() => URL.revokeObjectURL(a.href), 1000);
  });
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
      else showEmpty();
      if (s.job.state === 'processing') pollStatus();
      else if (s.job.state === 'error') setUploadStatus(`Last upload failed: ${s.job.error}`, true);
    } catch (e) {
      showOverlay('Cannot reach the server', e.message);
    }
  })();
})();
