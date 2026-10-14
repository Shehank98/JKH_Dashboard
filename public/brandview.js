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
  const SECTIONS = [['children', 'Brands'], ['channels', 'Channels'], ['campaigns', 'Campaigns']];
  // One card with tabs, so these are switched, not scrolled to.
  const TABS = [['adtype', 'Commercials vs Value additions'], ['sos', 'Share of spend'], ['advertisers', 'Advertisers'], ['months', 'Months']];

  let stack = [];        // [{ scope, label }]: the trail
  let d = null;          // the brand view data for the top of the stack
  let ui = { metric: 'spend', cmp: 'yoy', ctab: 'C', allCh: false, sec: 'children', tab: 'adtype' };
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
    ui = { ...ui, ctab: 'C', allCh: false, sec: 'children' };
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
    stack.push({ scope: next, label: label || '' });
    root.querySelector('.bv-scroll') && (root.querySelector('.bv-scroll').scrollTop = 0);
    load();
  }
  function labelFor(add) {
    if (add.theme) return `“${add.theme}”`;
    if (add.ch) { const c = d.channels.find(x => x.key === add.ch); return c ? c.name : add.ch; }
    if (add.brand) return add.brand;
    if (add.adv) return add.adv;
    if (add.mb) return add.mb;
    if (add.vt) return add.vt === 'C' ? 'Commercials' : 'Value additions';
    if (add.medium) return add.medium;
    if (add.from) { const m = d.monthsList.find(x => x.key === add.from); return m ? `${m.label} ${m.year}` : add.from; }
    return '';
  }

  // ---------- drawing ----------
  function draw() {
    const H = O.catHelp, rg = d.ranges, yt = H.yearType();
    const curLabel = H.periodLabel(rg.cur[0], rg.cur[1], yt), baseRange = ui.cmp === 'prev' ? rg.prev : rg.yoy;
    const baseLabel = H.periodLabel(baseRange[0], baseRange[1], yt), baseWord = ui.cmp === 'prev' ? 'previous' : 'last year';
    const h = d.head, scope = stack[stack.length - 1].scope;
    const bCur = h.cur, bBase = ui.cmp === 'prev' ? h.prev : h.yoy;
    const sosBase = ui.cmp === 'prev' ? h.sos.prev : h.sos.yoy;
    const chips = d.parts.filter(p => !['mb', 'brand', 'adv', 'ch', 'theme', 'sub', 'mbs'].includes(p.k) || p.v !== d.name);
    const initial = (d.name.replace(/[^A-Za-z0-9]/g, '')[0] || '?').toUpperCase();
    const trail = stack.map((s, i) => (i === stack.length - 1 ? `<b>${esc(s.label || d.name)}</b>` : `<button class="bv-crumb" data-act="trail" data-i="${i}">${esc(s.label || (i ? '…' : H.pg()))}</button>`));
    const multiMonth = d.months > 1;
    const split = h.split, [cS, vS] = cvOf(split), tS = cS + vS;
    const medTot = h.mediums.reduce((a, b) => a + b, 0);
    const sections = SECTIONS.filter(([k]) => k !== 'children' || d.childKind);
    if (!sections.some(([k]) => k === ui.sec)) ui.sec = sections[0][0];

    root.innerHTML = `<div class="bv-wrap"><div class="bv-scroll" id="bvScroll"><div id="bvBody">
      <div class="bv-sticky">
        <div class="bv-bar">
          <button class="bv-btn" data-act="back">${stack.length > 1 ? '← Back' : '← Back to dashboard'}</button>
          <div class="bv-trail"><button class="bv-crumb" data-act="trail" data-i="0">Category</button><span>›</span>${H.pg() ? `<span>${esc(H.pg())}</span><span>›</span>` : ''}${trail.join('<span>›</span>')}</div>
          <div class="bv-ctl">
            <span class="bv-lbl">PERIOD</span><span class="bv-pill">${esc(curLabel)}${d.months > 1 ? ` · ${esc(H.monLabel(rg.cur[0]))} to ${esc(H.monLabel(rg.cur[1]))}` : ` · ${esc(H.monLabel(rg.cur[0]))}`}</span>
            <span class="bv-seg"><button class="${ui.cmp === 'yoy' ? 'on' : ''}" data-act="cmp" data-v="yoy">vs last year</button><button class="${ui.cmp === 'prev' ? 'on' : ''}" data-act="cmp" data-v="prev">vs previous</button></span>
            <span class="bv-seg"><button class="${scope.medium ? '' : 'on'}"${setA({ medium: null })}>All media</button>${MED.map(m => `<button class="${scope.medium === m ? 'on' : ''}"${setA({ medium: m })}>${m}</button>`).join('')}</span>
            <button class="bv-btn" data-act="jpg" title="Download this view as a picture">Export JPG</button>
          </div>
        </div>
        <div class="bv-nav">${sections.map(([k, n], i) => `<button class="bv-chip${ui.sec === k ? ' on' : ''}" data-act="sec" data-v="${k}">${n}${k === 'children' ? ` <em>${d.children.length}</em>` : k === 'channels' ? ` <em>${d.channels.length}</em>` : ''}</button>`).join('')}</div>
      </div>

      <div class="bv-title"><span class="bv-av">${esc(initial)}</span><div>
        <div class="bv-h1"><span>${esc(d.name)}</span>${usTag(d.us)}</div>
        <div class="bv-sub">${esc(d.kind)} · ${esc(H.pg())}${chips.length ? ' · ' + chips.map(c => esc(c.v)).join(' · ') : ''}${d.siblings && d.siblings.length > 1 ? '' : ''}</div></div>
        ${d.siblings && d.siblings.length > 1 ? `<div class="bv-sib"><span class="bv-lbl">SWITCH BRAND</span>${d.siblings.map(s => `<button class="bv-chip${s.self ? ' on' : ''}"${s.self ? '' : go({ brand: s.name })}>${esc(s.name)}</button>`).join('')}</div>` : ''}
      </div>

      <div class="bv-kpis">
        <div class="bv-card bv-kpi"><div class="bv-kl">INVESTMENT · ${esc(curLabel)}</div><div class="bv-kv">${mnTxt(h.cur)}</div><div class="bv-ks">${growth(bCur, bBase)} vs ${bBase > 0 ? mnTxt(bBase) : '–'} ${baseWord}</div></div>
        <div class="bv-card bv-kpi"><div class="bv-kl">SHARE OF SPEND (SOS)</div><div class="bv-kv">${pctS(h.sos.cur, 1)}</div><div class="bv-ks">${h.rank ? `Rank <b>#${h.rank}</b> of ${h.rankOf} ${h.rankKind === 'mb' ? 'mother brands' : h.rankKind === 'brand' ? 'brands' : 'advertisers'}` : sosBase != null && h.sos.cur != null ? `<span class="${h.sos.cur >= sosBase ? 'up' : 'down'}">${h.sos.cur >= sosBase ? '▲' : '▼'} ${nf(Math.abs(h.sos.cur - sosBase), 1)} pp</span> vs ${baseWord}` : ''}</div></div>
        <div class="bv-card bv-kpi"><div class="bv-kl">COMMERCIALS : VALUE ADDITIONS</div><div class="bv-kv">${ratioTxt(split)}</div>${ratioBar(split)}</div>
        <div class="bv-card bv-kpi"><div class="bv-kl">MEDIUM SPLIT</div><div class="bv-kms">${MED.map((m, k) => (h.mediums[k] > 0 ? `<button class="bv-lk"${go({ medium: m })}>${m} ${nf(medTot ? (h.mediums[k] / medTot) * 100 : 0, 0)}%</button>` : '')).filter(Boolean).join(' · ') || '–'}</div>
          <span class="rbar">${h.mediums.map((v, k) => `<i style="width:${medTot ? (v / medTot) * 100 : 0}%;background:${MED_COL[k]}"></i>`).join('')}</span></div>
        <div class="bv-card bv-kpi"><div class="bv-kl">CHANNELS USED</div><div class="bv-kv">${h.channels}</div><div class="bv-ks">${h.topChannel ? `Top: <b>${esc(h.topChannel.name)}</b> (${pctS(h.topChannel.share)})` : ''}</div></div>
      </div>

      ${d.childKind ? childrenSection(baseWord) : ''}
      <section class="bv-card bv-sec bv-tabcard" id="bv-tabs"><div class="bv-tabs">${TABS.map(([k, n]) => `<button class="${ui.tab === k ? 'on' : ''}" data-act="tab" data-v="${k}">${n}${k === 'advertisers' ? ` <em>${d.advertisers.length}</em>` : ''}</button>`).join('')}</div>
        ${ui.tab === 'sos' ? sosSection(baseWord, sosBase) : ui.tab === 'advertisers' ? advertisersSection() : ui.tab === 'months' ? monthsSection() : adTypeSection(split, tS, cS, vS)}</section>
      ${channelsSection(baseWord, scope)}
      ${campaignsSection()}
      <div class="bv-foot">Spend in Rs Mn. Value additions follow the Spot Log list (-BB, Com Break, DJ, Time Check…); Tag is counted as a <b>${d.tagCommercial ? 'commercial' : 'value addition'}</b>, as ticked in the Spot Log filters. Share of spend compares like with like: a medium, channel or ad type you pick narrows the category too.</div>
    </div></div></div>`;
  }

  const metricToggle = () => `<span class="bv-seg"><button class="${ui.metric === 'spend' ? 'on' : ''}" data-act="metric" data-v="spend">Spend</button><button class="${ui.metric === 'spots' ? 'on' : ''}" data-act="metric" data-v="spots">Spots</button></span>`;

  function childrenSection(baseWord) {
    const rows = d.children;
    const title = d.childKind === 'mb' ? `Mother brands in ${esc(d.name)}` : `Brands in ${esc(d.name)}`;
    return `<section class="bv-card bv-sec" id="bv-children"><div class="bv-sh"><h3>${title}</h3><span class="bv-hint">Click a ${d.childKind === 'mb' ? 'mother brand' : 'brand'} to open its own full view</span></div>
      <div class="bv-t bv-t-ch"><div class="bv-th"><span>${d.childKind === 'mb' ? 'MOTHER BRAND' : 'BRAND'}</span><span class="r">${esc(O.catHelp.short(d.ranges.cur))}</span><span class="r">${ui.cmp === 'prev' ? 'PREVIOUS' : 'LAST YEAR'}</span><span class="r">GROWTH</span><span class="r">SHARE</span><span>COMMERCIALS : VALUE ADDITIONS</span><span>MONTH BY MONTH</span><span>TOP CHANNEL</span><span></span></div>
      ${rows.map(r => `<div class="bv-tr"${go(d.childKind === 'mb' ? { mb: r.name, brand: null, adv: null } : { brand: r.name })}>
        <span class="bv-nm"><b>${esc(r.name)}</b>${usTag(r.us)}${r.sub ? `<br><small>${esc(r.sub)}</small>` : ''}</span>
        <b class="r">${mnNum(r.cur)}</b><span class="r mut">${baseOf(r) > 0 ? mnNum(baseOf(r)) : '–'}</span><b class="r">${growth(r.cur, baseOf(r))}</b><b class="r">${pctS(r.share)}</b>
        <span class="bv-rt">${ratioBar(r, 130)}<b>${ratioTxt(r)}</b></span><span>${spark(r.monthly)}</span>
        <span class="bv-tc">${r.topChannel ? `${esc(r.topChannel.name)} <small>· ${pctS(r.topChannel.share)}</small>` : '–'}</span><span class="bv-go">›</span></div>`).join('') || '<div class="bv-empty">No spend in this selection</div>'}</div>
      <div class="bv-legend"><span><i style="background:${CC}"></i>Commercials</span><span><i style="background:${VC}"></i>Value additions</span><span class="mut">Ratios are by ${ui.metric}. Compared with ${baseWord}.</span></div></section>`;
  }

  function adTypeSection(split, tS, cS, vS) {
    const a = d.adType, mo = a.monthly;
    const val = m => (ui.metric === 'spots' ? [m.Cn, m.Vn] : [m.C, m.V]);
    const mx = Math.max(1, ...mo.map(m => val(m)[0] + val(m)[1]));
    const W = 340, H = 220, base = 190, top = 24, bw = Math.min(64, (W - 40) / Math.max(1, mo.length) - 14);
    const fmt = v => (ui.metric === 'spots' ? nf(v) : mnNum(v));
    const cols = mo.map((m, k) => {
      const [c, v] = val(m), step = (W - 20) / mo.length, x = 10 + step * k + (step - bw) / 2;
      const hc = (c / mx) * (base - top), hv = (v / mx) * (base - top);
      return `<g class="bv-g"${go({ from: m.key, to: m.key })}><rect x="${x}" y="${base - hc}" width="${bw}" height="${hc}" fill="${CC}"/><rect x="${x}" y="${base - hc - hv}" width="${bw}" height="${hv}" fill="${VC}"/>
        <text x="${x + bw / 2}" y="${base - hc - hv - 5}" text-anchor="middle" font-size="11" font-weight="800" fill="#1A1F36">${fmt(c + v)}</text>
        ${hc > 16 ? `<text x="${x + bw / 2}" y="${base - hc / 2 + 4}" text-anchor="middle" font-size="10.5" font-weight="700" fill="#fff">${fmt(c)}</text>` : ''}
        ${hv > 16 ? `<text x="${x + bw / 2}" y="${base - hc - hv / 2 + 4}" text-anchor="middle" font-size="10.5" font-weight="700" fill="#1A1F36">${fmt(v)}</text>` : ''}
        <text x="${x + bw / 2}" y="${base + 16}" text-anchor="middle" font-size="11.5" font-weight="700" fill="#4A5570">${esc(m.label)}${mo.length <= 12 ? '' : ''}</text></g>`;
    }).join('');
    const yc = ui.metric === 'spots' ? [split.Cny, split.Vny] : [split.Cy, split.Vy], ty = yc[0] + yc[1];
    const pc = tS ? (cS / tS) * 100 : 0;
    const children = d.children;
    return `<div class="bv-pane" id="bv-adtype"><div class="bv-sh"><h3>Commercials vs Value additions</h3>${metricToggle()}</div>
      <div class="bv-bigbar"><button class="bv-bp" style="width:${Math.max(pc, 12)}%;background:${CC};color:#fff"${go({ vt: 'C' })}>Commercials · ${ui.metric === 'spots' ? nf(cS) + ' spots' : mnTxt(cS)} · ${nf(pc, 0)}%</button><button class="bv-bp" style="width:${Math.max(100 - pc, 12)}%;background:${VC};color:#1A1F36"${go({ vt: 'V' })}>VA · ${ui.metric === 'spots' ? nf(vS) + ' spots' : mnTxt(vS)} · ${nf(100 - pc, 0)}%</button></div>
      <div class="bv-cmp"><span>Last year: <b>${ty ? `${nf((yc[0] / ty) * 100, 0)} : ${nf((yc[1] / ty) * 100, 0)}` : '–'}</b></span><span>${growth(cS, yc[0])} Commercials</span><span>${growth(vS, yc[1])} Value additions</span><span class="mut" style="margin-left:auto">Click either part to see its campaigns</span></div>
      <div class="bv-two"><div><div class="bv-mini">MONTH BY MONTH · ${ui.metric === 'spots' ? 'SPOTS' : 'RS MN'}</div>
        <svg width="100%" viewBox="0 0 ${W} ${H}" role="img" aria-label="Commercials and value additions by month">${cols}</svg><div class="bv-hint">Click a column to open that month</div></div>
        <div>${children.length ? `<div class="bv-mini">${d.childKind === 'mb' ? 'BY MOTHER BRAND' : 'BY BRAND'}</div>
          <div class="bv-mr bv-mh"><span>${d.childKind === 'mb' ? 'MOTHER BRAND' : 'BRAND'}</span><span class="r">${ui.metric === 'spots' ? 'COMM. SPOTS' : 'COMM.'}</span><span class="r">${ui.metric === 'spots' ? 'VA SPOTS' : 'VA'}</span><span>RATIO</span><span></span></div>
          ${children.slice(0, 8).map(r => `<div class="bv-mr"${go(d.childKind === 'mb' ? { mb: r.name, brand: null, adv: null } : { brand: r.name })}><b>${esc(r.name)}</b><span class="r">${ui.metric === 'spots' ? nf(r.Cn) : mnNum(r.C)}</span><span class="r">${ui.metric === 'spots' ? nf(r.Vn) : mnNum(r.V)}</span>${ratioBar(r)}<span class="bv-go">›</span></div>`).join('')}` : ''}
          <div class="bv-mini" style="margin-top:12px">BY MEDIUM</div>
          ${a.byMedium.map(r => { const k = MED.indexOf(r.medium); return `<div class="bv-mr bv-mr2"${go({ medium: r.medium })}><b>${r.medium}</b>${ratioBar(r)}<b class="r">${ratioTxt(r)}</b></div>`; }).join('') || '<div class="bv-empty">–</div>'}</div></div></div>`;
  }

  function sosSection(baseWord, sosBase) {
    const s = d.sos, h = d.head;
    const months = d.monthsList;
    const lines = [{ name: d.name, vals: s.self, col: '#E4702A', w: 3, self: true }, ...s.competitors.map((c, k) => ({ name: c.name, vals: c.values, col: ['#2F5DBF', '#7B8DB5', '#B4BCD0'][k], w: 2, us: c.us }))];
    const all = lines.flatMap(l => l.vals).filter(v => v != null);
    const mx = Math.max(20, Math.ceil((Math.max(0, ...all) + 2) / 20) * 20);
    const W = 440, H = 180, L = 34, R = 24, T = 12, B = 24, n = months.length;
    const X = k => (n === 1 ? L + (W - L - R) / 2 : L + (k / (n - 1)) * (W - L - R)), Y = v => H - B - (v / mx) * (H - B - T);
    const grid = [0, 0.25, 0.5, 0.75, 1].map(f => `<line x1="${L}" y1="${Y(mx * f)}" x2="${W - R}" y2="${Y(mx * f)}" stroke="#EEF1F7"/><text x="0" y="${Y(mx * f) + 4}" font-size="10.5" fill="#8A93AD" font-weight="600">${nf(mx * f, 0)}%</text>`).join('');
    const paths = n < 2 ? '' : lines.map(l => `<polyline points="${l.vals.map((v, k) => (v == null ? null : `${X(k)},${Y(v)}`)).filter(Boolean).join(' ')}" fill="none" stroke="${l.col}" stroke-width="${l.w}" stroke-linecap="round" stroke-linejoin="round"/>`).join('')
;
    const xl = months.map((m, k) => `<text x="${X(k)}" y="${H - 6}" text-anchor="middle" font-size="10.5" font-weight="700" fill="#4A5570">${esc(m.label)}</text>`).filter((_, k) => n <= 8 || k % Math.ceil(n / 8) === 0).join('');
    const tiles = [['SOS · COMMERCIALS', s.byAdType.C], ['SOS · VALUE ADD.', s.byAdType.V], ...s.byMedium.slice(0, 1).map(m => [`SOS · ${m.medium.toUpperCase()}`, m.share])].filter(t => t[1] != null);
    return `<div class="bv-pane" id="bv-sos"><div class="bv-sh"><h3>Share of spend (SOS)</h3><span class="bv-hint">in ${esc(O.catHelp.pg())}</span></div>
      <div class="bv-sosn"><span class="bv-kv big">${pctS(h.sos.cur, 1)}</span>${sosBase != null && h.sos.cur != null ? `<b class="${h.sos.cur >= sosBase ? 'up' : 'down'}">${h.sos.cur >= sosBase ? '▲' : '▼'} ${nf(Math.abs(h.sos.cur - sosBase), 1)} pp vs ${baseWord}</b>` : ''}${h.rank ? `<span class="mut">Rank #${h.rank}</span>` : ''}</div>
      ${n >= 2 ? `<svg width="100%" viewBox="0 0 ${W} ${H}" role="img" aria-label="Share of spend by month">${grid}${paths}${xl}</svg>
        <div class="bv-lines">${lines.map(l => { const v = l.vals[l.vals.length - 1]; return `<span><i style="background:${l.col}"></i>${esc(l.name)} <b>${v == null ? '–' : nf(v, 1) + '%'}</b></span>`; }).join('')}</div>` : '<div class="bv-hint" style="margin:8px 0">Pick a longer period to see the share of spend month by month.</div>'}
      <div class="bv-tiles">${tiles.map(t => `<div class="bv-tile"><div class="bv-kl">${t[0]}</div><b>${pctS(t[1], 1)}</b></div>`).join('')}</div>
      ${s.ranking.length ? `<div class="bv-mini" style="margin-top:10px">WHO IS NEXT · click one for its own view</div>
      ${s.ranking.map((r, i) => `<div class="bv-mr bv-rk${r.self ? ' me' : ''}"${r.self ? '' : go(d.entKind === 'brand' ? { brand: r.key, mb: null } : d.entKind === 'adv' ? { adv: r.key, mb: null, brand: null } : { mb: r.key, brand: null, adv: null })}><span class="mut">${r.rank || i + 1}</span><b>${esc(r.key)} ${usTag(r.us)}</b><span class="r">${mnNum(r.cur)}</span><b class="r">${pctS(r.share, 1)}</b><span class="bv-go">${r.self ? '' : '›'}</span></div>`).join('')}` : ''}</div>`;
  }

  function channelsSection(baseWord, scope) {
    const rows = d.channels, top = ui.allCh ? rows : rows.slice(0, 8), rest = rows.slice(8);
    const tot = d.head.cur;
    const rowHtml = (r, i) => { const k = MED.indexOf(r.medium); return `<div class="bv-tr bv-tr-c"${go({ ch: r.key })}><span class="mut">${i + 1}</span><span><b>${esc(r.name)}</b> ${medTag(r.medium)}</span><b class="r">${mnNum(r.cur)}</b>
      <span class="bv-bw"><span class="bv-bt"><i style="width:${rows[0].cur ? (r.cur / rows[0].cur) * 100 : 0}%;background:${MED_COL[k]}"></i></span><b>${pctS(r.share)}</b></span>
      <span class="bv-rt">${ratioBar(r)}<b>${ratioTxt(r)}</b></span><b class="r bv-sosl"${go({ ch: r.key, mb: null, brand: null, adv: null, theme: null })} title="Who leads on this channel">${pctS(r.sosHere)}</b><b class="r">${growth(r.cur, baseOf(r))}</b><span class="bv-go">›</span></div>`; };
    const restSum = rest.reduce((a, r) => a + r.cur, 0);
    return `<section class="bv-card bv-sec" id="bv-channels"><div class="bv-sh"><h3>Channels</h3><span class="bv-hint">Click a channel to see ${esc(d.name)} on that channel only. Click its SOS to see who leads there.</span></div>
      <div class="bv-th bv-th-c"><span>#</span><span>CHANNEL</span><span class="r">RS MN</span><span>SHARE OF ${esc(d.name.toUpperCase().slice(0, 18))}</span><span>COMMERCIALS : VA</span><span class="r">SOS HERE</span><span class="r">${ui.cmp === 'prev' ? 'VS PREV' : 'VS LY'}</span><span></span></div>
      ${top.map(rowHtml).join('') || '<div class="bv-empty">No channels in this selection</div>'}
      ${!ui.allCh && rest.length ? `<button class="bv-more" data-act="allch">Other channels (${rest.length}) · ${mnTxt(restSum)} · ${pctS(tot ? (restSum / tot) * 100 : 0)} — show all</button>` : ui.allCh && rest.length ? '<button class="bv-more" data-act="allch">Show fewer</button>' : ''}
      <div class="bv-hint" style="margin-top:8px">SOS here is the brand's share of everything in ${esc(O.catHelp.pg())} on that channel.</div></section>`;
  }

  function advertisersSection() {
    const rows = d.advertisers;
    return `<div class="bv-pane" id="bv-advertisers"><div class="bv-sh"><h3>Advertisers</h3></div>
      <div class="bv-th bv-th-a"><span>ADVERTISER</span><span class="r">RS MN</span><span class="r">SHARE</span><span class="r">C : VA</span><span></span></div>
      ${rows.map(r => `<div class="bv-tr bv-tr-a"${go({ adv: r.name })}><b>${esc(r.name)}${usTag(r.us)}</b><b class="r">${mnNum(r.cur)}</b><span class="r">${pctS(r.share)}</span><b class="r">${ratioTxt(r)}</b><span class="bv-go">›</span></div>`).join('') || '<div class="bv-empty">–</div>'}
      <div class="bv-hint" style="margin-top:6px">If a brand is run by more than one advertiser, each gets its own row.</div></div>`;
  }

  function campaignsSection() {
    const rows = d.campaigns[ui.ctab], n = d.adType.counts;
    return `<section class="bv-card bv-sec" id="bv-campaigns"><div class="bv-sh"><h3>Campaigns</h3>
      <span class="bv-seg"><button class="${ui.ctab === 'C' ? 'on c' : ''}" data-act="ctab" data-v="C">Commercials ${n.C}</button><button class="${ui.ctab === 'V' ? 'on v' : ''}" data-act="ctab" data-v="V">Value additions ${n.V}</button></span></div>
      <div class="bv-th bv-th-k"><span>${ui.ctab === 'C' ? 'COMMERCIAL' : 'VALUE ADDITION'} (ADVT_THEME)</span><span class="r">RS MN</span><span class="r">SHARE</span><span class="r">SPOTS</span><span></span></div>
      ${rows.map(r => `<div class="bv-tr bv-tr-k"${go({ theme: r.name, adv: r.advertiser })}><span><b>${esc(r.name)}</b>${usTag(r.us)}<br><small>${esc(r.advertiser)}</small></span><b class="r">${mnNum(r.cur)}</b><span class="r">${pctS(r.share)}</span><span class="r">${nf(r.spots)}</span><span class="bv-go">›</span></div>`).join('') || `<div class="bv-empty">No ${ui.ctab === 'C' ? 'commercials' : 'value additions'} in this selection</div>`}
      ${n[ui.ctab] > 50 ? `<div class="bv-hint" style="margin-top:6px">Top 50 of ${n[ui.ctab]} shown.</div>` : ''}</section>`;
  }

  function monthsSection() {
    const ms = d.monthsList;
    return `<div class="bv-pane" id="bv-months"><div class="bv-sh"><h3>Months</h3>${ms.length === 1 ? '<span class="bv-hint">Already narrowed to one month</span>' : ''}</div>
      <div class="bv-mtiles">${ms.map(m => { const [c, v] = ui.metric === 'spots' ? [m.Cn, m.Vn] : [m.C, m.V], t = c + v; return `<button class="bv-mt2"${go({ from: m.key, to: m.key })}><span class="mut">${esc(m.label)} ${m.year}</span><b>${mnNum(m.spend)}</b> ${growth(m.spend, m.yoy)}<small>SOS ${pctS(m.sos, 1)} · ${t ? `${nf((c / t) * 100, 0)} : ${nf((v / t) * 100, 0)}` : '–'}</small></button>`; }).join('')}</div></div>`;
  }

  // ---------- clicks ----------
  async function exportJpg() {
    const node = $('bvBody');
    if (!node) return;
    try {
      if (!window.htmlToImage) await new Promise((res, rej) => { const s = document.createElement('script'); s.src = '/vendor/html-to-image/html-to-image.js'; s.onload = res; s.onerror = () => rej(new Error('Could not load the picture tool')); document.head.appendChild(s); });
      O.toast('Preparing picture…');
      const url = await window.htmlToImage.toJpeg(node, { quality: 0.92, backgroundColor: '#F4F6FA', pixelRatio: 1.5, filter: n => !(n.classList && n.classList.contains('bv-sticky')) });
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
      else if (a === 'back') { if (stack.length > 1) { stack.pop(); load(); } else close(); }
      else if (a === 'trail') { stack.length = Number(act.dataset.i) + 1; load(); }
      else if (a === 'cmp') { ui.cmp = v; draw(); }
      else if (a === 'metric') { ui.metric = v; draw(); }
      else if (a === 'ctab') { ui.ctab = v; draw(); }
      else if (a === 'allch') { ui.allCh = !ui.allCh; draw(); }
      else if (a === 'jpg') exportJpg();
      else if (a === 'tab') { ui.tab = v; draw(); }
      else if (a === 'sec') { ui.sec = v; draw(); const el = $('bv-' + v); const sc = $('bvScroll'); if (el && sc) sc.scrollTop = el.offsetTop - 120; }
      return;
    }
    const g = t.closest('[data-go]');
    if (g) {
      const add = JSON.parse(g.dataset.go);
      if (add.vt) ui.ctab = add.vt;
      push(add, labelFor(add));
      return;
    }
    const st = t.closest('[data-set]');
    if (st) {
      const top = stack[stack.length - 1];
      for (const [k, v] of Object.entries(JSON.parse(st.dataset.set))) { if (v == null) delete top.scope[k]; else top.scope[k] = v; }
      load();
    }
  });
  document.addEventListener('keydown', e => { if (e.key === 'Escape' && root.classList.contains('on') && !$('catModal').classList.contains('on')) close(); });

  window.BRANDVIEW = { canOpen, open, close };
})();
