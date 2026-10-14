(() => {
  'use strict';
  // "Share" for the agency: sums the loaded spot log into a small monthly data cube in this browser, saves it on the
  // server, and gives a link (/share/<token>) a client can open with no sign-in and no access to the raw spots.
  const O = window.ORBIT;
  const $ = id => document.getElementById(id);
  const { esc, nf } = O;
  const root = $('shareModal');
  const MAX_BYTES = 38 * 1024 * 1024;

  const LEVELS = [
    ['standard', 'Standard', 'Month, channel, advertiser, mother brand, sub category, daypart and ad type. The Duration Mix card is left out.'],
    ['compact', 'Compact', 'The same without dayparts. Smallest, fastest to open.'],
    ['full', 'Full', 'Adds ad lengths, so the Duration Mix card works. Largest.'],
  ];
  let s = null;

  const mb = bytes => (bytes >= 1048576 ? nf(bytes / 1048576, 1) + ' MB' : nf(Math.max(1, bytes / 1024), 0) + ' KB');
  const isoDay = d => d.toISOString().slice(0, 10);
  async function api(url, opts) {
    const r = await fetch(url, opts);
    const j = await r.json().catch(() => ({}));
    if (r.status === 401 && j.signIn) { location.replace('/login'); throw new Error('Please sign in'); }
    if (!r.ok) throw new Error(j.error || r.statusText);
    return j;
  }

  function open() {
    if (!O.spot || !O.spot.hasData()) { O.toast('Load a data file first'); return; }
    const st = O.spot.getState();
    s = { level: 'standard', lockPg: true, withFilters: true, title: `${st.pg} · Mine vs competitors`, client: '', expires: '', map: null, cube: null, bytes: 0, records: 0, building: false, seq: 0, result: null, shares: null, err: '', busy: false };
    root.classList.add('on');
    draw();
    loadShares();
    preview();
  }
  function close() { root.classList.remove('on'); root.innerHTML = ''; s = null; }

  // Build the cube for the current choices, so the size shown is the size that will be sent.
  let timer = null;
  function preview(delay = 0) {
    clearTimeout(timer);
    s.building = true; s.cube = null; s.err = ''; paintStatus();
    const my = ++s.seq;
    timer = setTimeout(async () => {
      try {
        if (!s.map) {
          const meta = O.spot.dataMeta();
          s.map = meta && meta.hasProduct ? (await api('/api/brandmap/all')).rows : [];
        }
        const st = O.spot.getState();
        const r = await O.engine.call('buildCube', { map: s.map, pg: s.lockPg ? st.pg : '', level: s.level });
        if (!s || my !== s.seq) return;
        s.cube = r.cube; s.records = r.cube.meta.records; s.bytes = JSON.stringify(r.cube).length;
        s.building = false;
        if (s.bytes > MAX_BYTES) s.err = 'This is too large to share. Pick Standard or Compact, or share only one product group.';
      } catch (e) { if (!s || my !== s.seq) return; s.building = false; s.err = e.message; }
      paintStatus();
    }, delay);
  }

  function draw() {
    const minDate = isoDay(new Date(Date.now() + 86400000));
    const st = O.spot.getState();
    root.innerHTML = `<div class="sh-box" role="dialog" aria-label="Share dashboard with client">
      <div class="sh-h"><h3>Share dashboard with client</h3><button class="bmp-x" id="shX" aria-label="Close">✕</button></div>
      <div class="sh-body">
        <div class="sh-form" ${s.result ? 'hidden' : ''}>
          <label class="sh-l">Title<input class="bm-search" id="shTitle" maxlength="140" value="${esc(s.title)}"></label>
          <label class="sh-l">Client name <small>(optional, shown at the top)</small><input class="bm-search" id="shClient" maxlength="140" value="${esc(s.client)}" placeholder="e.g. Hemas Marketing"></label>
          <label class="sh-l">Link expires on <small>(optional, leave empty for no expiry)</small><input class="bm-search" id="shExp" type="date" min="${minDate}" value="${esc(s.expires)}"></label>
          <div class="sh-l">What the client can see</div>
          <div class="sh-levels">${LEVELS.map(([k, n, d]) => `<label class="sh-lv${s.level === k ? ' on' : ''}"><input type="radio" name="shLv" value="${k}" ${s.level === k ? 'checked' : ''}><b>${n}</b><span>${d}</span></label>`).join('')}</div>
          <label class="sh-ck"><input type="checkbox" id="shLock" ${s.lockPg ? 'checked' : ''}><span>Share only <b>${esc(st.pg)}</b> <small>(other product groups are not included in the link at all)</small></span></label>
          <label class="sh-ck"><input type="checkbox" id="shState" ${s.withFilters ? 'checked' : ''}><span>Open with my current filters <small>(advertisers, dates, medium…; the client can change them)</small></span></label>
          <div class="sh-status" id="shStatus"></div>
          <p class="sh-note">The client sees monthly totals by channel, advertiser, mother brand and sub category, and can filter them, but never the raw spot log: no programmes, campaigns, brand names, times or individual spots. Anyone with the link can open it, so share it only with the client.</p>
        </div>
        <div class="sh-result" ${s.result ? '' : 'hidden'}>${s.result ? `
          <div class="sh-ok">Your link is ready</div>
          <div class="sh-link"><input class="bm-search" id="shLink" readonly value="${esc(s.result.url)}"><button class="btn pri" id="shCopy">Copy link</button></div>
          <p class="sh-note">${s.result.expiresAt ? 'Expires on ' + esc(new Date(s.result.expiresAt).toLocaleDateString([], { dateStyle: 'medium' })) + '.' : 'It stays active until you turn it off.'} You can turn any link off below.</p>
          <a class="sh-open" href="${esc(s.result.url)}" target="_blank" rel="noopener">Open the client view ›</a>` : ''}</div>
        <div class="sh-list" id="shList"></div>
      </div>
      <div class="sh-f"><button class="sh-flink" id="shFilter" title="For colleagues who already have the data file loaded">Copy a filters-only link</button>
        <span class="sh-err" id="shErr"></span>
        ${s.result ? '<button class="btn pri" id="shDone">Done</button>' : '<button class="btn ghost" id="shCancel">Cancel</button><button class="btn pri" id="shGo">Generate link</button>'}</div></div>`;
    paintStatus(); paintList();
  }

  function paintStatus() {
    if (!s) return;
    const el = $('shStatus'), go = $('shGo');
    if (el) {
      el.className = 'sh-status' + (s.err ? ' err' : '');
      el.innerHTML = s.building ? '<span class="sh-spin"></span> Summing up your data…'
        : s.err ? esc(s.err)
        : s.cube ? `<b>${nf(s.records)}</b> summary records from ${nf(s.cube.meta.spots)} spots · about <b>${mb(s.bytes)}</b> (${mb(Math.round(s.bytes / 4))} to download)` : '';
    }
    if (go) go.disabled = s.building || !s.cube || !!s.err || s.busy;
  }

  async function loadShares() {
    try { s.shares = (await api('/api/shared-dashboards')).shares; } catch (e) { s.shares = []; }
    paintList();
  }
  function paintList() {
    const el = $('shList');
    if (!el || !s) return;
    const active = (s.shares || []).filter(x => !x.revokedAt);
    if (!active.length) { el.innerHTML = ''; return; }
    const now = Date.now();
    el.innerHTML = `<div class="sh-lh">Links you have shared</div><table class="bm-t"><tbody>${active.slice(0, 12).map(x => {
      const expired = x.expiresAt && new Date(x.expiresAt).getTime() <= now;
      return `<tr><td class="bm-b" title="${esc(x.title)}">${esc(x.title)}${x.clientName ? ` <small>· ${esc(x.clientName)}</small>` : ''}</td>
        <td class="bm-by">${esc(new Date(x.createdAt).toLocaleDateString([], { dateStyle: 'medium' }))}<br><small>${expired ? 'Expired' : x.expiresAt ? 'Expires ' + esc(new Date(x.expiresAt).toLocaleDateString([], { dateStyle: 'medium' })) : 'No expiry'} · ${nf(x.views)} view${x.views === 1 ? '' : 's'}</small></td>
        <td><button class="btn ghost bm-undo" data-copy="${esc(x.url)}">Copy</button> <button class="btn ghost bm-undo" data-off="${esc(x.token)}">Turn off</button></td></tr>`;
    }).join('')}</tbody></table>`;
  }

  async function generate() {
    const title = $('shTitle').value.trim();
    if (!title) { $('shErr').textContent = 'Please give the dashboard a title'; return; }
    s.title = title; s.client = $('shClient').value.trim(); s.expires = $('shExp').value;
    let expiresAt = null;
    if (s.expires) {
      const t = new Date(s.expires + 'T23:59:59');
      if (t.getTime() <= Date.now()) { $('shErr').textContent = 'The expiry date must be in the future'; return; }
      expiresAt = t.toISOString();
    }
    s.busy = true; paintStatus(); $('shErr').textContent = ''; $('shGo').textContent = 'Saving…';
    try {
      const st = O.spot.getState();
      const body = JSON.stringify({ title, clientName: s.client, expiresAt, lockedFilters: { pg: s.lockPg ? st.pg : '', level: s.level }, state: s.withFilters ? st : null, cube: s.cube });
      let res;
      try {
        // Compressed on the way up (the data cube is highly repetitive), plain if this browser cannot compress.
        if (typeof CompressionStream !== 'undefined') {
          const gz = await new Response(new Blob([body]).stream().pipeThrough(new CompressionStream('gzip'))).blob();
          res = await fetch('/api/shared-dashboards', { method: 'POST', headers: { 'Content-Type': 'application/json', 'Content-Encoding': 'gzip' }, body: gz });
        }
      } catch (e) { res = null; }
      if (!res || res.status === 415) res = await fetch('/api/shared-dashboards', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body });
      const j = await res.json().catch(() => ({}));
      if (res.status === 401 && j.signIn) { location.replace('/login'); return; }
      if (!res.ok) throw new Error(j.error || (res.status === 413 ? 'The data is too large to share. Pick Standard or Compact.' : res.statusText));
      s.result = j;
      draw(); loadShares();
      try { await navigator.clipboard.writeText(j.url); O.toast('Link copied'); } catch (e) { /* copy button is there */ }
    } catch (e) {
      s.busy = false; $('shGo').textContent = 'Generate link'; $('shErr').textContent = 'Could not create the link: ' + e.message; paintStatus();
    }
  }

  root.addEventListener('click', async e => {
    if (!s) return;
    const t = e.target;
    if (t === root || t.id === 'shX' || t.id === 'shCancel' || t.id === 'shDone') { close(); return; }
    if (t.id === 'shGo') { generate(); return; }
    if (t.id === 'shFilter') { O.spot.copyFilterLink(); return; }
    if (t.id === 'shCopy') {
      try { await navigator.clipboard.writeText($('shLink').value); O.toast('Link copied'); } catch (err) { $('shLink').select(); }
      return;
    }
    const cp = t.closest('[data-copy]');
    if (cp) { try { await navigator.clipboard.writeText(cp.dataset.copy); O.toast('Link copied'); } catch (err) { window.prompt('Copy this link', cp.dataset.copy); } return; }
    const off = t.closest('[data-off]');
    if (off) {
      if (!window.confirm('Turn this link off? The client will no longer be able to open it.')) return;
      try { await api('/api/shared-dashboards/' + encodeURIComponent(off.dataset.off), { method: 'DELETE' }); O.toast('Link turned off'); loadShares(); } catch (err) { O.toast('Could not turn it off: ' + err.message); }
    }
  });
  root.addEventListener('change', e => {
    if (!s) return;
    const t = e.target;
    if (t.name === 'shLv') { s.level = t.value; root.querySelectorAll('.sh-lv').forEach(l => l.classList.toggle('on', l.querySelector('input').checked)); preview(); }
    else if (t.id === 'shLock') { s.lockPg = t.checked; preview(); }
    else if (t.id === 'shState') s.withFilters = t.checked;
    else if (t.id === 'shExp') s.expires = t.value;
  });
  document.addEventListener('keydown', e => { if (e.key === 'Escape' && s && root.classList.contains('on')) close(); });

  window.SHAREDASH = { open };
})();
