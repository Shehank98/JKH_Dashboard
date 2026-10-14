(() => {
  'use strict';
  // The full brand view: what opens when a card, row or bar in the Category dashboard is clicked.
  // Brands (or mother brands) first, then Commercials vs Value additions, share of spend, channels, advertisers,
  // campaigns and months. Every row, bar and tile drills one level down; the trail at the top goes back.
  const O = window.ORBIT;
  const $ = id => document.getElementById(id);
  const { esc, nf } = O;
  const root = $('bvPage');
  const MED = ['TV', 'Radio', 'Press'], MED_COL = ['#2F5DBF', '#FF8A3D', '#1FA97A'], MED_BG = ['#E3EBFB', '#FFE9D8', '#DDF3EA'], MED_FG = ['#2F5DBF', '#B4540C', '#14805A'];
  const CC = '#7B3FA0', VC = '#E0A100';
  
  let stack = [];        // [{ scope, label }]: the trail
  let d = null;          // the brand view data for the top of the stack
  let ui = { metric: 'spend', cmp: 'yoy', ctab: 'C', tab: 'advertisers', page: 0, pageSize: 8 };
  let seq = 0;

  // ---------- number formats (spend arrives in thousand rupees) ----------
  const mnNum = v => { const x = v / 1000; return nf(x, Math.abs(x) >= 10 ? 0 : 1); };
  const mnTxt = v => `${mnNum(v)} Mn`;
  const pctS = (v, dp = 0) => (v == null ? '–' : nf(v, dp) + '%');
  function growth(cur, base, big) {
    if (!(base > 0)) return cur > 0 ? `<span class="flat">${big ? 'new' : 'new'}</span>` : '<span class="flat">–</span>';
    const g = ((cur - base) / base) * 100;
    return `<span class="${g >= 0.5 ? 'up' : g <= -0.5 ? 'down' : 'flat'}">${g >= 0.5 ? '▲' : g <= -0.5 ? '▼' : '■'} ${nf(Math.abs(g), 0)}%</span>`;
  }
  const baseOf = o => (ui.cmp === 'prev' ? o.prev : o.yoy);
  const go = add => ` data-go="${esc(JSON.stringify(add))}"`;
  const setA = add => ` data-set="${esc(JSON.stringify(add))}"`;

  // The share of commercials in a split, by spend or by spots.
  const cvOf = o => (ui.metric === 'spots' ? [o.Cn, o.Vn] : [o.C, o.V]);
  function ratioBar(o, w) {
    const [c, v] = cvOf(o), t = c + v, pc = t ? (c / t) * 100 : 0;
    return `<span class="rbar" style="${w ? `width:${w}px` : ''}"><i style="width:${pc}%;background:${CC}"></i><i style="width:${100 - pc}%;background:${VC}"></i></span>`;
  }
  function ratioTxt(o) { const [c, v] = cvOf(o), t = c + v; return t ? `${nf((c / t) * 100, 0)} : ${nf((v / t) * 100, 0)}` : '–'; }
  function spark(vals, w = 130, h = 34) {
    const n = vals.length;
    if (n < 2) return '';
    const mx = Math.max(...vals), mn = Math.min(...vals), rng = mx - mn || 1;
    const pts = vals.map((v, k) => `${4 + (k / (n - 1)) * (w - 8)},${h - 5 - ((v - mn) / rng) * (h - 12)}`);
    const last = pts[n - 1].split(',');
    return `<svg width="${w}" height="${h}" viewBox="0 0 ${w} ${h}" aria-hidden="true"><polyline points="${pts.join(' ')}" fill="none" stroke="#E4702A" stroke-width="2.3" stroke-linecap="round" stroke-linejoin="round"/><circle cx="${last[0]}" cy="${last[1]}" r="3.2" fill="#E4702A"/></svg>`;
  }
  const usTag = us => (us ? '<span class="bv-us">US</span>' : '');
  const medTag = m => `<span class="bv-mt" style="background:${MED_BG[MED.indexOf(m)]};color:${MED_FG[MED.indexOf(m)]}">${m.toUpperCase()}</span>`;

  // ---------- opening, loading, going deeper ----------
  async function canOpen() {
    try { return !!(window.BRANDMAP && await window.BRANDMAP.ensureMap()); } catch (e) { return false; }
  }
  function open(scope) {
    stack = [{ scope: { ...scope }, label: '' }];
    ui = { ...ui, ctab: 'C', tab: 'advertisers', page: 0 };
    root.classList.add('on'); document.body.classList.add('bv-open');
    root.innerHTML = '<div class="bv-wrap"><div class="bv-loading">Loading…</div></div>';
    load();
  }
  function close() { root.classList.remove('on'); document.body.classList.remove('bv-open'); root.innerHTML = ''; stack = []; d = null; }
  async function load() {
    const my = ++seq, top = stack[stack.length - 1];
    try {
      const filters = O.catHelp.filters();
      const tag = !!(O.spot && O.spot.getState && O.spot.getState().tagCommercial);
      const r = await O.engine.call('catBrand', { filters, scope: top.scope, tagCommercial: tag });
      if (my !== seq) return;
      d = r;
      if (!top.label) top.label = r.name;
      draw();
    } catch (e) {
      if (my !== seq) return;
      root.innerHTML = `<div class="bv-wrap"><div class="bv-loading">Could not load this view: ${esc(e.message)}<br><button class="bv-btn" data-act="close">Close</button></div></div>`;
    }
  }
  function push(add, label) {
    const base = stack[stack.length - 1].scope, next = { ...base };
    for (const [k, v] of Object.entries(add)) { if (v == null) delete next[k]; else next[k] = v; }
    const [tab, note] = landing(add, label);
    stack.push({ scope: next, label: label || '', note });
    ui.tab = tab; ui.page = 0;
    if (add.vt) ui.ctab = add.vt;
    load();
  }
  function labelFor(add) {
    if (add.theme) return `“${add.theme}”`;
    if (add.ch) { const c = d.channels.find(x => x.key === add.ch); return c ? c.name : add.ch; }
    if (add.brand) return add.brand;
    if (add.adv) return add.adv;
    if (add.mb) return add.mb;
    if (add.vt) return add.vt === 'C' ? 'Commercials' : 'Value additions';
    if (add.dur) return add.dur + ' ads';
    if (add.medium) return add.medium;
    if (add.from) { const m = d.monthsList.find(x => x.key === add.from); return m ? `${m.label} ${m.year}` : add.from; }
    return '';
  }

  // ---------- drawing ----------
  // The whole view fits the window: nothing scrolls. Long lists are paged, and the page size follows the window height.
  const ROWH = { advertisers: 44, channels: 44, campaigns: 50, children: 52, months: 44 };
  function tabList() {
    const kids = d.childKind === 'mb' ? 'Mother brands' : 'Brands';
    return [
      ['advertisers', 'Advertisers', d.advertisers.length],
      ['medium', 'Medium split', d.mediums.filter(m => m.cur > 0).length],
      ['channels', 'Channel mix', d.channels.length],
      ['duration', 'Duration mix', null],
      ...(d.childKind ? [['children', `${kids} · Commercials vs VA`, d.children.length]] : []),
      ['campaigns', 'Campaigns', d.adType.counts.C + d.adType.counts.V],
      ['months', 'Months', d.monthsList.length],
    ];
  }
  // Rows for the current page and the pager under them.
  function paged(rows) {
    const size = Math.max(3, ui.pageSize), pages = Math.max(1, Math.ceil(rows.length / size));
    ui.page = Math.min(ui.page, pages - 1);
    const from = ui.page * size, slice = rows.slice(from, from + size);
    const pager = `<div class="bv-pager"><span>${rows.length ? `${from + 1}–${from + slice.length} of ${rows.length}` : ''}</span>${pages > 1 ? `<button class="bv-btn" data-act="page" data-v="-1" ${ui.page ? '' : 'disabled'}>‹ Prev</button><b>${ui.page + 1} / ${pages}</b><button class="bv-btn" data-act="page" data-v="1" ${ui.page < pages - 1 ? '' : 'disabled'}>Next ›</button>` : ''}</div>`;
    return { slice, pager };
  }
  const rowsBox = (tab, html) => `<div class="bv-rows" id="bvRows" data-rh="${ROWH[tab]}">${html}</div>`;

  // Where a click lands, and what the person is told, so the next screen is never a surprise.
  function landing(add, label) {
    if (add.vt) return ['campaigns', `Showing the <b>${esc(label)}</b> campaigns.`];
    if (add.theme) return ['channels', `Showing the channels <b>${esc(label)}</b> ran on.`];
    if (add.ch) return ['campaigns', `Showing the campaigns that ran on <b>${esc(label)}</b>.`];
    if (add.medium) return ['channels', `Showing the channels that carried <b>${esc(label)}</b>.`];
    if (add.dur) return ['channels', `Showing the channels that carried <b>${esc(label)}</b>.`];
    if (add.from) return ['medium', `Showing the medium split for <b>${esc(label)}</b>.`];
    return ['advertisers', `Showing who runs <b>${esc(label)}</b>.`];
  }

  function draw() {
    const H = O.catHelp, rg = d.ranges, yt = H.yearType();
    const curLabel = H.periodLabel(rg.cur[0], rg.cur[1], yt);
    const baseWord = ui.cmp === 'prev' ? 'previous' : 'last year';
    const h = d.head, scope = stack[stack.length - 1].scope, top = stack[stack.length - 1];
    const bBase = ui.cmp === 'prev' ? h.prev : h.yoy;
    const sosBase = ui.cmp === 'prev' ? h.sos.prev : h.sos.yoy;
    const chips = d.parts.filter(p => !['mb', 'brand', 'adv', 'ch', 'theme', 'sub', 'mbs'].includes(p.k) || p.v !== d.name);
    const initial = (d.name.replace(/[^A-Za-z0-9]/g, '')[0] || '?').toUpperCase();
    const trail = stack.map((s, i) => (i === stack.length - 1 ? `<b>${esc(s.label || d.name)}</b>` : `<button class="bv-crumb" data-act="trail" data-i="${i}">${esc(s.label || (i ? '…' : H.pg()))}</button>`));
    const tabs = tabList();
    if (!tabs.some(t => t[0] === ui.tab)) ui.tab = tabs[0][0];
    const split = h.split;
    const pane = { advertisers: advertisersPane, medium: mediumPane, channels: channelsPane, duration: durationPane, children: childrenPane, campaigns: campaignsPane, months: monthsPane }[ui.tab];
    const rivals = d.sos.ranking.filter(r => !r.self).slice(0, 4);
    const tabName = (tabs.find(t => t[0] === ui.tab) || [])[1];

    root.innerHTML = `<div class="bv-wrap" id="bvBody">
      <div class="bv-bar">
        <button class="bv-btn" data-act="back">${stack.length > 1 ? '← Back' : '← Back to dashboard'}</button>
        <div class="bv-trail"><button class="bv-crumb" data-act="trail" data-i="0">Category</button><span>›</span>${H.pg() ? `<span>${esc(H.pg())}</span><span>›</span>` : ''}${trail.join('<span>›</span>')}</div>
        <div class="bv-ctl">
          <span class="bv-pill">${esc(curLabel)}${d.months > 1 ? ` · ${esc(H.monLabel(rg.cur[0]))} to ${esc(H.monLabel(rg.cur[1]))}` : ` · ${esc(H.monLabel(rg.cur[0]))}`}</span>
          <span class="bv-seg"><button class="${ui.cmp === 'yoy' ? 'on' : ''}" data-act="cmp" data-v="yoy">vs last year</button><button class="${ui.cmp === 'prev' ? 'on' : ''}" data-act="cmp" data-v="prev">vs previous</button></span>
          <span class="bv-seg"><button class="${scope.medium ? '' : 'on'}"${setA({ medium: null })}>All media</button>${MED.map(m => `<button class="${scope.medium === m ? 'on' : ''}"${setA({ medium: m })}>${m}</button>`).join('')}</span>
          <button class="bv-btn" data-act="jpg" title="Download this view as a picture">Export JPG</button>
        </div>
      </div>
      <div class="bv-tabs bv-main-tabs" role="tablist">${tabs.map(([k, n, c], i) => `${i === 5 ? '<span class="bv-tsep"></span>' : ''}<button role="tab" aria-selected="${ui.tab === k}" class="${ui.tab === k ? 'on' : ''}" data-act="tab" data-v="${k}">${n}${c != null ? ` <em>${c}</em>` : ''}</button>`).join('')}</div>

      <div class="bv-head">
        <div class="bv-title"><span class="bv-av">${esc(initial)}</span><div>
          <div class="bv-h1"><span>${esc(d.name)}</span>${usTag(d.us)}</div>
          <div class="bv-sub">${esc(d.kind)} · ${esc(H.pg())}${chips.length ? ' · ' + chips.map(c => esc(c.v)).join(' · ') : ''}</div></div></div>
        <div class="bv-kpis">
          <div class="bv-card bv-kpi"><div class="bv-kl">INVESTMENT · ${esc(curLabel)}</div><div class="bv-kv">${mnTxt(h.cur)}</div><div class="bv-ks">${growth(h.cur, bBase)} vs ${bBase > 0 ? mnTxt(bBase) : '–'} ${baseWord}</div></div>
          <div class="bv-card bv-kpi"><div class="bv-kl">SHARE OF SPEND</div><div class="bv-kv">${pctS(h.sos.cur, 1)}</div><div class="bv-ks">${h.rank ? `Rank <b>#${h.rank}</b> of ${h.rankOf}` : sosBase != null && h.sos.cur != null ? `<span class="${h.sos.cur >= sosBase ? 'up' : 'down'}">${h.sos.cur >= sosBase ? '▲' : '▼'} ${nf(Math.abs(h.sos.cur - sosBase), 1)} pp</span> vs ${baseWord}` : '&nbsp;'}</div></div>
          <div class="bv-card bv-kpi"><div class="bv-kl">COMMERCIALS : VALUE ADD.</div><div class="bv-kv">${ratioTxt(split)}</div>${ratioBar(split)}</div>
          <div class="bv-card bv-kpi"><div class="bv-kl">CHANNELS · ADVERTISERS</div><div class="bv-kv">${h.channels} · ${d.advertisers.length}</div><div class="bv-ks">${h.topChannel ? `Top: <b>${esc(h.topChannel.name)}</b> ${pctS(h.topChannel.share)}` : '&nbsp;'}</div></div>
        </div>
      </div>
      ${rivals.length || (d.siblings && d.siblings.length > 1) ? `<div class="bv-rivals">${d.siblings && d.siblings.length > 1 ? `<span class="bv-lbl">SWITCH BRAND</span>${d.siblings.map(s => `<button class="bv-chip${s.self ? ' on' : ''}"${s.self ? '' : go({ brand: s.name })}>${esc(s.name)}</button>`).join('')}` : ''}${rivals.length ? `<span class="bv-lbl" style="margin-left:${d.siblings && d.siblings.length > 1 ? 14 : 0}px">COMPARE WITH</span>${rivals.map(r => `<button class="bv-chip"${go(d.entKind === 'brand' ? { brand: r.key, mb: null } : d.entKind === 'adv' ? { adv: r.key, mb: null, brand: null } : { mb: r.key, brand: null, adv: null })}>${esc(r.key)} <em>${pctS(r.share, 1)}</em></button>`).join('')}` : ''}</div>` : ''}
      ${top.note ? `<div class="bv-note"><span>▸ You opened <b>${esc(top.label || d.name)}</b>. ${top.note}</span><button data-act="dismiss" aria-label="Dismiss">✕</button></div>` : ''}

      <section class="bv-card bv-tabcard" id="bv-tab-${ui.tab}" data-tab="${ui.tab}" aria-label="${esc(tabName || '')}">${pane(baseWord)}</section>
      <div class="bv-foot">Rs Mn · Value additions follow the Spot Log list; Tag counts as a <b>${d.tagCommercial ? 'commercial' : 'value addition'}</b> (Spot Log tick box) · A medium, channel, ad length or ad type you pick narrows the category too.</div>
    </div>`;
    requestAnimationFrame(fit);
  }

  // Page size from the room the list really has, so the page never needs a scroll bar.
  function fit() {
    const box = $('bvRows');
    if (!box) return;
    const size = Math.max(3, Math.floor(box.clientHeight / Number(box.dataset.rh || 44)));
    if (size !== ui.pageSize) { ui.pageSize = size; draw(); }
  }
  window.addEventListener('resize', () => { if (root.classList.contains('on')) { clearTimeout(fit.t); fit.t = setTimeout(fit, 120); } });

  const metricToggle = () => `<span class="bv-seg"><button class="${ui.metric === 'spend' ? 'on' : ''}" data-act="metric" data-v="spend">Spend</button><button class="${ui.metric === 'spots' ? 'on' : ''}" data-act="metric" data-v="spots">Spots</button></span>`;
  const paneHead = (title, hint, right) => `<div class="bv-sh"><h3>${title}</h3><span class="bv-hint">${hint}</span>${right || ''}</div>`;

  // 1. Who runs the brand.
  function advertisersPane() {
    const { slice, pager } = paged(d.advertisers);
    return `${paneHead('Advertisers', 'Click an advertiser to see only what it runs', metricToggle())}
      <div class="bv-th bv-th-a"><span>ADVERTISER</span><span class="r">RS MN</span><span class="r">SHARE</span><span class="r">${ui.cmp === 'prev' ? 'VS PREV' : 'VS LY'}</span><span>COMMERCIALS : VA</span><span></span></div>
      ${rowsBox('advertisers', slice.map(r => `<div class="bv-tr bv-tr-a"${go({ adv: r.name })}><b>${esc(r.name)}${usTag(r.us)}</b><b class="r">${mnNum(r.cur)}</b><span class="r">${pctS(r.share)}</span><b class="r">${growth(r.cur, baseOf(r))}</b><span class="bv-rt">${ratioBar(r)}<b>${ratioTxt(r)}</b></span><span class="bv-go">›</span></div>`).join('') || '<div class="bv-empty">No advertisers in this selection</div>')}
      ${pager}`;
  }

  // 2. Medium split: TV, Radio, Press.
  function mediumPane() {
    const rows = d.mediums, tot = d.head.cur;
    return `${paneHead('Medium split', 'Click a medium to narrow the whole view to it', metricToggle())}
      <div class="bv-stack">${rows.map((m, k) => (m.cur > 0 ? `<i style="width:${tot ? (m.cur / tot) * 100 : 0}%;background:${MED_COL[k]}">${tot && m.cur / tot > 0.08 ? `${m.medium} ${nf((m.cur / tot) * 100, 0)}%` : ''}</i>` : '')).join('')}</div>
      <div class="bv-mcards">${rows.map((m, k) => `<button class="bv-mcard${m.cur > 0 ? '' : ' off'}"${m.cur > 0 ? go({ medium: m.medium }) : ' disabled'}>
        <div class="bv-mh2"><i style="background:${MED_COL[k]}"></i><b>${m.medium}</b><span class="bv-go">›</span></div>
        <div class="bv-mv">${m.cur > 0 ? mnTxt(m.cur) : '–'}</div>
        <div class="bv-ms">${m.cur > 0 ? `${growth(m.cur, baseOf(m))} ${ui.cmp === 'prev' ? 'vs previous' : 'vs last year'}` : 'No spend'}</div>
        ${m.cur > 0 ? `<div class="bv-mrow"><span>Medium split</span><b>${pctS(m.share)}</b></div>
        <div class="bv-mrow"><span>SOS in ${m.medium}</span><b>${pctS(m.sos, 1)}</b></div>
        <div class="bv-mrow"><span>Spots</span><b>${nf(m.spots)}</b></div>
        <div class="bv-mrow"><span>Commercials : VA</span><b>${ratioTxt(m)}</b></div>${ratioBar(m)}` : ''}</button>`).join('')}</div>`;
  }

  // 3. Channel mix, next to how the category itself splits.
  function channelsPane() {
    const { slice, pager } = paged(d.channels), top = d.channels[0];
    return `${paneHead('Channel mix', `Click a channel to see ${esc(d.name)} on it`, metricToggle())}
      <div class="bv-th bv-th-c"><span>#</span><span>CHANNEL</span><span class="r">RS MN</span><span>SHARE OF ${esc(d.name.toUpperCase().slice(0, 16))}</span><span class="r">CATEGORY MIX</span><span>COMMERCIALS : VA</span><span class="r">${ui.cmp === 'prev' ? 'VS PREV' : 'VS LY'}</span><span></span></div>
      ${rowsBox('channels', slice.map((r, i) => { const k = MED.indexOf(r.medium), n = ui.page * Math.max(3, ui.pageSize) + i + 1;
        return `<div class="bv-tr bv-tr-c"${go({ ch: r.key })}><span class="mut">${n}</span><span><b>${esc(r.name)}</b> ${medTag(r.medium)}</span><b class="r">${mnNum(r.cur)}</b>
        <span class="bv-bw"><span class="bv-bt"><i style="width:${top && top.cur ? (r.cur / top.cur) * 100 : 0}%;background:${MED_COL[k]}"></i></span><b>${pctS(r.share)}</b></span>
        <span class="r mut">${pctS(r.catShare)}</span><span class="bv-rt">${ratioBar(r)}<b>${ratioTxt(r)}</b></span><b class="r">${growth(r.cur, baseOf(r))}</b><span class="bv-go">›</span></div>`; }).join('') || '<div class="bv-empty">No channels in this selection</div>')}
      ${pager}`;
  }

  // 4. Duration mix, the way the Spot Log shows it, next to the category.
  function durationPane() {
    const u = d.duration, bs = u.buckets;
    const tb = u.brand.counts.reduce((a, b) => a + b, 0), tc = u.cat.counts.reduce((a, b) => a + b, 0);
    if (!u.hasLengths) return `${paneHead('Duration mix', '')}<div class="bv-empty">This data file was loaded before ad lengths were read. Please load it again.</div>`;
    if (!tb && !tc) return `${paneHead('Duration mix', 'TV and Radio ads by length')}<div class="bv-empty">No TV or Radio ads in this selection</div>`;
    const mx = Math.max(0.01, ...u.brand.counts.map(c => (tb ? c / tb : 0)), ...u.cat.counts.map(c => (tc ? c / tc : 0)));
    return `${paneHead('Duration mix', 'TV and Radio ads by length. Click a length to see only those ads.')}
      <div class="bv-dgrid" style="grid-template-columns:140px repeat(${bs.length},minmax(60px,1fr)) 70px">
        <span></span>${bs.map(b => `<span class="bv-dh">${b}</span>`).join('')}<span class="bv-dh">ACD</span>
        <span class="bv-dn"><b>${esc(d.name)}</b><small>${nf(tb)} ads</small></span>${u.brand.counts.map((c, i) => `<button class="bv-dc me"${go({ dur: bs[i] })}><b>${nf(c)}</b><small>${tb ? nf((c / tb) * 100, 0) : 0}%</small></button>`).join('')}<span class="bv-acd me">${u.brand.acd == null ? 'n/a' : Math.round(u.brand.acd) + 's'}</span>
        <span class="bv-dn"><b>Category</b><small>${nf(tc)} ads</small></span>${u.cat.counts.map((c, i) => `<button class="bv-dc"${go({ dur: bs[i], mb: null, brand: null, adv: null })}><b>${nf(c)}</b><small>${tc ? nf((c / tc) * 100, 0) : 0}%</small></button>`).join('')}<span class="bv-acd">${u.cat.acd == null ? 'n/a' : Math.round(u.cat.acd) + 's'}</span>
      </div>
      <div class="bv-mini" style="margin-top:12px">SHARE OF ADS BY LENGTH</div>
      <div class="bv-dbars">${bs.map((b, i) => { const a = tb ? u.brand.counts[i] / tb : 0, c = tc ? u.cat.counts[i] / tc : 0; return `<div class="bv-db"><div class="bv-dbb"><i style="height:${(a / mx) * 100}%;background:#E4702A" title="${esc(d.name)} ${nf(a * 100, 0)}%"></i><i style="height:${(c / mx) * 100}%;background:#9AA6C4" title="Category ${nf(c * 100, 0)}%"></i></div><span>${b}</span></div>`; }).join('')}</div>
      <div class="bv-legend"><span><i style="background:#E4702A"></i>${esc(d.name)}</span><span><i style="background:#9AA6C4"></i>Category</span><span class="mut">ACD = average commercial duration (value additions count as 5s when no length is given)</span></div>`;
  }

  // 5. The brands (or mother brands) inside, with Commercials and Value additions and the ratio.
  function childrenPane() {
    const kids = d.childKind === 'mb' ? 'mother brand' : 'brand';
    const sp = d.head.split, [cS, vS] = cvOf(sp), tS = cS + vS, pc = tS ? (cS / tS) * 100 : 0;
    const fmt = v => (ui.metric === 'spots' ? `${nf(v)} spots` : mnTxt(v));
    const { slice, pager } = paged(d.children);
    return `${paneHead(`${d.childKind === 'mb' ? 'Mother brands' : 'Brands'} in ${esc(d.name)}`, `Click a ${kids} to open its own full view. Click the bar to see only those ads.`, metricToggle())}
      <div class="bv-bigbar"><button class="bv-bp" style="width:${Math.max(pc, 14)}%;background:${CC};color:#fff"${go({ vt: 'C' })}>Commercials · ${fmt(cS)} · ${nf(pc, 0)}%</button><button class="bv-bp" style="width:${Math.max(100 - pc, 14)}%;background:${VC};color:#1A1F36"${go({ vt: 'V' })}>Value additions · ${fmt(vS)} · ${nf(100 - pc, 0)}%</button></div>
      <div class="bv-th bv-t-chh" style="margin-top:8px"><span>${kids.toUpperCase()}</span><span class="r">${esc(O.catHelp.short(d.ranges.cur))}</span><span class="r">${ui.cmp === 'prev' ? 'PREVIOUS' : 'LAST YEAR'}</span><span class="r">GROWTH</span><span class="r">SHARE</span><span class="r">${ui.metric === 'spots' ? 'COMM. SPOTS' : 'COMMERCIALS'}</span><span class="r">${ui.metric === 'spots' ? 'VA SPOTS' : 'VALUE ADD.'}</span><span>RATIO</span><span>MONTH BY MONTH</span><span></span></div>
      ${rowsBox('children', slice.map(r => `<div class="bv-tr bv-t-chh"${go(d.childKind === 'mb' ? { mb: r.name, brand: null, adv: null } : { brand: r.name })}>
        <span class="bv-nm"><b>${esc(r.name)}</b>${usTag(r.us)}${r.sub ? `<br><small>${esc(r.sub)}</small>` : ''}</span>
        <b class="r">${mnNum(r.cur)}</b><span class="r mut">${baseOf(r) > 0 ? mnNum(baseOf(r)) : '–'}</span><b class="r">${growth(r.cur, baseOf(r))}</b><b class="r">${pctS(r.share)}</b>
        <span class="r">${ui.metric === 'spots' ? nf(r.Cn) : mnNum(r.C)}</span><span class="r">${ui.metric === 'spots' ? nf(r.Vn) : mnNum(r.V)}</span>
        <span class="bv-rt">${ratioBar(r, 100)}<b>${ratioTxt(r)}</b></span><span>${spark(r.monthly, 100, 28)}</span><span class="bv-go">›</span></div>`).join('') || '<div class="bv-empty">No spend in this selection</div>')}
      ${pager}`;
  }

  function campaignsPane() {
    const all = d.campaigns[ui.ctab], n = d.adType.counts;
    const { slice, pager } = paged(all);
    return `${paneHead('Campaigns', 'Click a campaign to see where it ran', `<span class="bv-seg"><button class="${ui.ctab === 'C' ? 'on c' : ''}" data-act="ctab" data-v="C">Commercials ${n.C}</button><button class="${ui.ctab === 'V' ? 'on v' : ''}" data-act="ctab" data-v="V">Value additions ${n.V}</button></span>`)}
      <div class="bv-th bv-th-k"><span>${ui.ctab === 'C' ? 'COMMERCIAL' : 'VALUE ADDITION'} (ADVT_THEME)</span><span class="r">RS MN</span><span class="r">SHARE</span><span class="r">SPOTS</span><span></span></div>
      ${rowsBox('campaigns', slice.map(r => `<div class="bv-tr bv-tr-k"${go({ theme: r.name, adv: r.advertiser })}><span><b>${esc(r.name)}</b>${usTag(r.us)}<br><small>${esc(r.advertiser)}</small></span><b class="r">${mnNum(r.cur)}</b><span class="r">${pctS(r.share)}</span><span class="r">${nf(r.spots)}</span><span class="bv-go">›</span></div>`).join('') || `<div class="bv-empty">No ${ui.ctab === 'C' ? 'commercials' : 'value additions'} in this selection</div>`)}
      ${pager}`;
  }

  function monthsPane() {
    const { slice, pager } = paged(d.monthsList);
    return `${paneHead('Months', d.monthsList.length === 1 ? 'Already narrowed to one month' : 'Click a month to narrow the whole view to it', metricToggle())}
      <div class="bv-th bv-th-m"><span>MONTH</span><span class="r">RS MN</span><span class="r">${ui.cmp === 'prev' ? 'SAME MONTH LY' : 'SAME MONTH LY'}</span><span class="r">GROWTH</span><span class="r">SOS</span><span>COMMERCIALS : VA</span><span></span></div>
      ${rowsBox('months', slice.map(m => { const [c, v] = ui.metric === 'spots' ? [m.Cn, m.Vn] : [m.C, m.V], t = c + v; return `<div class="bv-tr bv-th-m"${go({ from: m.key, to: m.key })}><b>${esc(m.label)} ${m.year}</b><b class="r">${mnNum(m.spend)}</b><span class="r mut">${m.yoy > 0 ? mnNum(m.yoy) : '–'}</span><b class="r">${growth(m.spend, m.yoy)}</b><span class="r">${pctS(m.sos, 1)}</span><span class="bv-rt">${ratioBar({ C: m.C, V: m.V, Cn: m.Cn, Vn: m.Vn })}<b>${t ? `${nf((c / t) * 100, 0)} : ${nf((v / t) * 100, 0)}` : '–'}</b></span><span class="bv-go">›</span></div>`; }).join('') || '<div class="bv-empty">No months</div>')}
      ${pager}`;
  }

  // ---------- clicks ----------
  async function exportJpg() {
    const node = $('bvBody');
    if (!node) return;
    try {
      if (!window.htmlToImage) await new Promise((res, rej) => { const s = document.createElement('script'); s.src = '/vendor/html-to-image/html-to-image.js'; s.onload = res; s.onerror = () => rej(new Error('Could not load the picture tool')); document.head.appendChild(s); });
      O.toast('Preparing picture…');
      const url = await window.htmlToImage.toJpeg(node, { quality: 0.92, backgroundColor: '#F4F6FA', pixelRatio: 1.5, filter: n => !(n.classList && n.classList.contains('bv-bar')) });
      const a = document.createElement('a');
      a.href = url; a.download = `Brand_view_${(d.name || 'view').replace(/[^A-Za-z0-9]+/g, '_')}.jpg`; a.click();
    } catch (e) { O.toast('Export failed: ' + e.message); }
  }
  root.addEventListener('click', e => {
    const t = e.target;
    const act = t.closest('[data-act]');
    if (act) {
      const a = act.dataset.act, v = act.dataset.v;
      if (a === 'close') close();
      else if (a === 'back') { if (stack.length > 1) { stack.pop(); ui.page = 0; load(); } else close(); }
      else if (a === 'trail') { stack.length = Number(act.dataset.i) + 1; ui.page = 0; load(); }
      else if (a === 'cmp') { ui.cmp = v; draw(); }
      else if (a === 'page') { ui.page = Math.max(0, ui.page + Number(v)); draw(); }
      else if (a === 'dismiss') { stack[stack.length - 1].note = ''; draw(); }
      else if (a === 'metric') { ui.metric = v; draw(); }
      else if (a === 'ctab') { ui.ctab = v; ui.page = 0; draw(); }
      else if (a === 'jpg') exportJpg();
      else if (a === 'tab') { ui.tab = v; ui.page = 0; stack[stack.length - 1].note = ''; draw(); }
      return;
    }
    const g = t.closest('[data-go]');
    if (g) {
      const add = JSON.parse(g.dataset.go);
      push(add, labelFor(add));
      return;
    }
    const st = t.closest('[data-set]');
    if (st) {
      const top = stack[stack.length - 1];
      const set = JSON.parse(st.dataset.set);
      for (const [k, v] of Object.entries(set)) { if (v == null) delete top.scope[k]; else top.scope[k] = v; }
      top.note = set.medium ? `Narrowed to <b>${esc(set.medium)}</b>: every tab now shows ${esc(set.medium)} only.` : 'Showing all media again.';
      ui.page = 0;
      load();
    }
  });
  document.addEventListener('keydown', e => { if (e.key === 'Escape' && root.classList.contains('on') && !$('catModal').classList.contains('on')) close(); });

  window.BRANDVIEW = { canOpen, open, close };
})();
