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
  let ui = { metric: 'spend', cmp: 'yoy', ctab: 'C', allCh: false, tab: 'advertisers' };
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
    ui = { ...ui, ctab: 'C', allCh: false, tab: 'advertisers' };
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
    if (add.dur) return add.dur + ' ads';
    if (add.medium) return add.medium;
    if (add.from) { const m = d.monthsList.find(x => x.key === add.from); return m ? `${m.label} ${m.year}` : add.from; }
    return '';
  }

  // ---------- drawing ----------
  // One tab at a time, like the Spot Log click-through: the tabs stay under the top bar, so there is nothing to scroll to.
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

  function draw() {
    const H = O.catHelp, rg = d.ranges, yt = H.yearType();
    const curLabel = H.periodLabel(rg.cur[0], rg.cur[1], yt), baseRange = ui.cmp === 'prev' ? rg.prev : rg.yoy;
    const baseWord = ui.cmp === 'prev' ? 'previous' : 'last year';
    const h = d.head, scope = stack[stack.length - 1].scope;
    const bBase = ui.cmp === 'prev' ? h.prev : h.yoy;
    const sosBase = ui.cmp === 'prev' ? h.sos.prev : h.sos.yoy;
    const chips = d.parts.filter(p => !['mb', 'brand', 'adv', 'ch', 'theme', 'sub', 'mbs'].includes(p.k) || p.v !== d.name);
    const initial = (d.name.replace(/[^A-Za-z0-9]/g, '')[0] || '?').toUpperCase();
    const trail = stack.map((s, i) => (i === stack.length - 1 ? `<b>${esc(s.label || d.name)}</b>` : `<button class="bv-crumb" data-act="trail" data-i="${i}">${esc(s.label || (i ? '…' : H.pg()))}</button>`));
    const tabs = tabList();
    if (!tabs.some(t => t[0] === ui.tab)) ui.tab = tabs[0][0];
    const split = h.split;
    const pane = { advertisers: advertisersPane, medium: mediumPane, channels: channelsPane, duration: durationPane, children: childrenPane, campaigns: campaignsPane, months: monthsPane }[ui.tab];
    const rivals = d.sos.ranking.filter(r => !r.self).slice(0, 5);

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
        <div class="bv-tabs bv-main-tabs" role="tablist">${tabs.map(([k, n, c], i) => `${i === 5 ? '<span class="bv-tsep"></span>' : ''}<button role="tab" aria-selected="${ui.tab === k}" class="${ui.tab === k ? 'on' : ''}" data-act="tab" data-v="${k}">${n}${c != null ? ` <em>${c}</em>` : ''}</button>`).join('')}</div>
      </div>

      <div class="bv-title"><span class="bv-av">${esc(initial)}</span><div>
        <div class="bv-h1"><span>${esc(d.name)}</span>${usTag(d.us)}</div>
        <div class="bv-sub">${esc(d.kind)} · ${esc(H.pg())}${chips.length ? ' · ' + chips.map(c => esc(c.v)).join(' · ') : ''}</div></div>
        ${d.siblings && d.siblings.length > 1 ? `<div class="bv-sib"><span class="bv-lbl">SWITCH BRAND</span>${d.siblings.map(s => `<button class="bv-chip${s.self ? ' on' : ''}"${s.self ? '' : go({ brand: s.name })}>${esc(s.name)}</button>`).join('')}</div>` : ''}
      </div>

      <div class="bv-kpis">
        <div class="bv-card bv-kpi"><div class="bv-kl">INVESTMENT · ${esc(curLabel)}</div><div class="bv-kv">${mnTxt(h.cur)}</div><div class="bv-ks">${growth(h.cur, bBase)} vs ${bBase > 0 ? mnTxt(bBase) : '–'} ${baseWord}</div></div>
        <div class="bv-card bv-kpi"><div class="bv-kl">SHARE OF SPEND (SOS)</div><div class="bv-kv">${pctS(h.sos.cur, 1)}</div><div class="bv-ks">${h.rank ? `Rank <b>#${h.rank}</b> of ${h.rankOf} ${h.rankKind === 'mb' ? 'mother brands' : h.rankKind === 'brand' ? 'brands' : 'advertisers'}` : sosBase != null && h.sos.cur != null ? `<span class="${h.sos.cur >= sosBase ? 'up' : 'down'}">${h.sos.cur >= sosBase ? '▲' : '▼'} ${nf(Math.abs(h.sos.cur - sosBase), 1)} pp</span> vs ${baseWord}` : ''}</div></div>
        <div class="bv-card bv-kpi"><div class="bv-kl">COMMERCIALS : VALUE ADDITIONS</div><div class="bv-kv">${ratioTxt(split)}</div>${ratioBar(split)}</div>
        <div class="bv-card bv-kpi"><div class="bv-kl">REACH OF THE BRAND</div><div class="bv-kv">${h.channels}<small> channels</small></div><div class="bv-ks">${d.advertisers.length} advertiser${d.advertisers.length === 1 ? '' : 's'}${h.topChannel ? ` · top <b>${esc(h.topChannel.name)}</b> (${pctS(h.topChannel.share)})` : ''}</div></div>
      </div>
      ${rivals.length ? `<div class="bv-rivals"><span class="bv-lbl">COMPARE WITH</span>${rivals.map(r => `<button class="bv-chip"${go(d.entKind === 'brand' ? { brand: r.key, mb: null } : d.entKind === 'adv' ? { adv: r.key, mb: null, brand: null } : { mb: r.key, brand: null, adv: null })}>${esc(r.key)} <em>${pctS(r.share, 1)}</em></button>`).join('')}</div>` : ''}

      <section class="bv-card bv-sec bv-tabcard" id="bv-tab-${ui.tab}">${pane(baseWord)}</section>
      <div class="bv-foot">Spend in Rs Mn. Value additions follow the Spot Log list (-BB, Com Break, DJ, Time Check…); Tag is counted as a <b>${d.tagCommercial ? 'commercial' : 'value addition'}</b>, as ticked in the Spot Log filters. Share of spend compares like with like: a medium, channel, ad length or ad type you pick narrows the category too.</div>
    </div></div></div>`;
  }

  const metricToggle = () => `<span class="bv-seg"><button class="${ui.metric === 'spend' ? 'on' : ''}" data-act="metric" data-v="spend">Spend</button><button class="${ui.metric === 'spots' ? 'on' : ''}" data-act="metric" data-v="spots">Spots</button></span>`;
  const paneHead = (title, hint, right) => `<div class="bv-sh"><h3>${title}</h3><span class="bv-hint">${hint}</span>${right || ''}</div>`;

  // 1. Who runs the brand.
  function advertisersPane() {
    const rows = d.advertisers;
    return `${paneHead('Advertisers', 'Click an advertiser to see only what it runs', metricToggle())}
      <div class="bv-th bv-th-a"><span>ADVERTISER</span><span class="r">RS MN</span><span class="r">SHARE</span><span class="r">${ui.cmp === 'prev' ? 'VS PREV' : 'VS LY'}</span><span>COMMERCIALS : VA</span><span></span></div>
      ${rows.map(r => `<div class="bv-tr bv-tr-a"${go({ adv: r.name })}><b>${esc(r.name)}${usTag(r.us)}</b><b class="r">${mnNum(r.cur)}</b><span class="r">${pctS(r.share)}</span><b class="r">${growth(r.cur, baseOf(r))}</b><span class="bv-rt">${ratioBar(r)}<b>${ratioTxt(r)}</b></span><span class="bv-go">›</span></div>`).join('') || '<div class="bv-empty">No advertisers in this selection</div>'}
      <div class="bv-hint" style="margin-top:8px">If a brand is run by more than one advertiser, each gets its own row.</div>`;
  }

  // 2. Medium split: TV, Radio, Press as three big cards.
  function mediumPane() {
    const rows = d.mediums, tot = d.head.cur;
    return `${paneHead('Medium split', 'Click a medium to narrow the whole view to it', metricToggle())}
      <div class="bv-stack">${rows.map((m, k) => (m.cur > 0 ? `<i style="width:${tot ? (m.cur / tot) * 100 : 0}%;background:${MED_COL[k]}">${tot && m.cur / tot > 0.08 ? `${m.medium} ${nf((m.cur / tot) * 100, 0)}%` : ''}</i>` : '')).join('')}</div>
      <div class="bv-mcards">${rows.map((m, k) => `<button class="bv-mcard${m.cur > 0 ? '' : ' off'}"${m.cur > 0 ? go({ medium: m.medium }) : ' disabled'}>
        <div class="bv-mh2"><i style="background:${MED_COL[k]}"></i><b>${m.medium}</b><span class="bv-go">›</span></div>
        <div class="bv-mv">${m.cur > 0 ? mnTxt(m.cur) : '–'}</div>
        <div class="bv-ms">${m.cur > 0 ? `${pctS(m.share)} of the brand · ${growth(m.cur, baseOf(m))} ${ui.cmp === 'prev' ? 'vs prev' : 'vs LY'}` : 'No spend'}</div>
        ${m.cur > 0 ? `<div class="bv-mrow"><span>Category mix</span><b>${pctS(m.catShare)}</b></div>
        <div class="bv-mrow"><span>SOS in ${m.medium}</span><b>${pctS(m.sos, 1)}</b></div>
        <div class="bv-mrow"><span>Spots</span><b>${nf(m.spots)}</b></div>
        <div class="bv-mrow"><span>Commercials : VA</span><b>${ratioTxt(m)}</b></div>${ratioBar(m)}` : ''}</button>`).join('')}</div>
      <div class="bv-hint" style="margin-top:10px">Category mix is how the whole category splits across media; compare it with the brand's own split above.</div>`;
  }

  // 3. Channel mix, with how it compares with the category's own mix.
  function channelsPane() {
    const rows = d.channels, top = ui.allCh ? rows : rows.slice(0, 10), rest = rows.slice(10);
    const tot = d.head.cur, restSum = rest.reduce((a, r) => a + r.cur, 0);
    const rowHtml = (r, i) => { const k = MED.indexOf(r.medium), idx = r.catShare > 0 && r.share != null ? (r.share / r.catShare) * 100 : null;
      return `<div class="bv-tr bv-tr-c"${go({ ch: r.key })}><span class="mut">${i + 1}</span><span><b>${esc(r.name)}</b> ${medTag(r.medium)}</span><b class="r">${mnNum(r.cur)}</b>
      <span class="bv-bw"><span class="bv-bt"><i style="width:${rows[0].cur ? (r.cur / rows[0].cur) * 100 : 0}%;background:${MED_COL[k]}"></i></span><b>${pctS(r.share)}</b></span>
      <span class="r mut">${pctS(r.catShare)}</span><span class="r">${idx == null ? '–' : `<b class="${idx >= 110 ? 'up' : idx <= 90 ? 'down' : 'flat'}">${nf(idx, 0)}</b>`}</span>
      <span class="bv-rt">${ratioBar(r)}<b>${ratioTxt(r)}</b></span><b class="r bv-sosl"${go({ ch: r.key, mb: null, brand: null, adv: null, theme: null })} title="Who leads on this channel">${pctS(r.sosHere)}</b><b class="r">${growth(r.cur, baseOf(r))}</b><span class="bv-go">›</span></div>`; };
    return `${paneHead('Channel mix', `Click a channel to see ${esc(d.name)} on it. Click its SOS to see who leads there.`, metricToggle())}
      <div class="bv-th bv-th-c"><span>#</span><span>CHANNEL</span><span class="r">RS MN</span><span>SHARE OF ${esc(d.name.toUpperCase().slice(0, 16))}</span><span class="r">CATEGORY MIX</span><span class="r" title="Brand share divided by category share, x100">INDEX</span><span>COMMERCIALS : VA</span><span class="r">SOS HERE</span><span class="r">${ui.cmp === 'prev' ? 'VS PREV' : 'VS LY'}</span><span></span></div>
      ${top.map(rowHtml).join('') || '<div class="bv-empty">No channels in this selection</div>'}
      ${!ui.allCh && rest.length ? `<button class="bv-more" data-act="allch">Other channels (${rest.length}) · ${mnTxt(restSum)} · ${pctS(tot ? (restSum / tot) * 100 : 0)} — show all</button>` : ui.allCh && rest.length ? '<button class="bv-more" data-act="allch">Show fewer</button>' : ''}
      <div class="bv-hint" style="margin-top:8px">Index above 100 means the brand leans on that channel more than the category does. SOS here is the brand's share of everything on that channel.</div>`;
  }

  // 4. Duration mix, the same way the Spot Log shows it (TV and Radio ads by length), next to the category.
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
      <div class="bv-mini" style="margin-top:16px">SHARE OF ADS BY LENGTH</div>
      <div class="bv-dbars">${bs.map((b, i) => { const a = tb ? u.brand.counts[i] / tb : 0, c = tc ? u.cat.counts[i] / tc : 0; return `<div class="bv-db"><div class="bv-dbb"><i style="height:${(a / mx) * 100}%;background:#E4702A" title="${esc(d.name)} ${nf(a * 100, 0)}%"></i><i style="height:${(c / mx) * 100}%;background:#9AA6C4" title="Category ${nf(c * 100, 0)}%"></i></div><span>${b}</span></div>`; }).join('')}</div>
      <div class="bv-legend"><span><i style="background:#E4702A"></i>${esc(d.name)}</span><span><i style="background:#9AA6C4"></i>Category</span><span class="mut">ACD = average commercial duration (value additions count as 5s when no length is given)</span></div>`;
  }

  // 5. The brands (or mother brands) inside, with Commercials and Value additions and the ratio.
  function childrenPane() {
    const rows = d.children, kids = d.childKind === 'mb' ? 'mother brand' : 'brand';
    const sp = d.head.split, [cS, vS] = cvOf(sp), tS = cS + vS, pc = tS ? (cS / tS) * 100 : 0;
    const fmt = v => (ui.metric === 'spots' ? `${nf(v)} spots` : mnTxt(v));
    return `${paneHead(`${d.childKind === 'mb' ? 'Mother brands' : 'Brands'} in ${esc(d.name)}`, `Click a ${kids} to open its own full view`, metricToggle())}
      <div class="bv-bigbar"><button class="bv-bp" style="width:${Math.max(pc, 14)}%;background:${CC};color:#fff"${go({ vt: 'C' })}>Commercials · ${fmt(cS)} · ${nf(pc, 0)}%</button><button class="bv-bp" style="width:${Math.max(100 - pc, 14)}%;background:${VC};color:#1A1F36"${go({ vt: 'V' })}>Value additions · ${fmt(vS)} · ${nf(100 - pc, 0)}%</button></div>
      <div class="bv-hint" style="margin:6px 0 12px">Click either part of the bar to see only those ads and their campaigns.</div>
      <div class="bv-t bv-t-ch"><div class="bv-th"><span>${kids.toUpperCase()}</span><span class="r">${esc(O.catHelp.short(d.ranges.cur))}</span><span class="r">${ui.cmp === 'prev' ? 'PREVIOUS' : 'LAST YEAR'}</span><span class="r">GROWTH</span><span class="r">SHARE</span><span class="r">${ui.metric === 'spots' ? 'COMM. SPOTS' : 'COMMERCIALS'}</span><span class="r">${ui.metric === 'spots' ? 'VA SPOTS' : 'VALUE ADD.'}</span><span>RATIO</span><span>MONTH BY MONTH</span><span></span></div>
      ${rows.map(r => `<div class="bv-tr"${go(d.childKind === 'mb' ? { mb: r.name, brand: null, adv: null } : { brand: r.name })}>
        <span class="bv-nm"><b>${esc(r.name)}</b>${usTag(r.us)}${r.sub ? `<br><small>${esc(r.sub)}</small>` : ''}</span>
        <b class="r">${mnNum(r.cur)}</b><span class="r mut">${baseOf(r) > 0 ? mnNum(baseOf(r)) : '–'}</span><b class="r">${growth(r.cur, baseOf(r))}</b><b class="r">${pctS(r.share)}</b>
        <span class="r">${ui.metric === 'spots' ? nf(r.Cn) : mnNum(r.C)}</span><span class="r">${ui.metric === 'spots' ? nf(r.Vn) : mnNum(r.V)}</span>
        <span class="bv-rt">${ratioBar(r, 110)}<b>${ratioTxt(r)}</b></span><span>${spark(r.monthly, 110, 30)}</span><span class="bv-go">›</span></div>`).join('') || '<div class="bv-empty">No spend in this selection</div>'}</div>
      <div class="bv-legend"><span><i style="background:${CC}"></i>Commercials</span><span><i style="background:${VC}"></i>Value additions</span><span class="mut">Ratio by ${ui.metric}. Compared with ${ui.cmp === 'prev' ? 'the previous period' : 'last year'}.</span></div>`;
  }

  function campaignsPane() {
    const rows = d.campaigns[ui.ctab], n = d.adType.counts;
    return `${paneHead('Campaigns', 'Click a campaign to see where and when it ran', `<span class="bv-seg"><button class="${ui.ctab === 'C' ? 'on c' : ''}" data-act="ctab" data-v="C">Commercials ${n.C}</button><button class="${ui.ctab === 'V' ? 'on v' : ''}" data-act="ctab" data-v="V">Value additions ${n.V}</button></span>`)}
      <div class="bv-th bv-th-k"><span>${ui.ctab === 'C' ? 'COMMERCIAL' : 'VALUE ADDITION'} (ADVT_THEME)</span><span class="r">RS MN</span><span class="r">SHARE</span><span class="r">SPOTS</span><span></span></div>
      ${rows.map(r => `<div class="bv-tr bv-tr-k"${go({ theme: r.name, adv: r.advertiser })}><span><b>${esc(r.name)}</b>${usTag(r.us)}<br><small>${esc(r.advertiser)}</small></span><b class="r">${mnNum(r.cur)}</b><span class="r">${pctS(r.share)}</span><span class="r">${nf(r.spots)}</span><span class="bv-go">›</span></div>`).join('') || `<div class="bv-empty">No ${ui.ctab === 'C' ? 'commercials' : 'value additions'} in this selection</div>`}
      ${n[ui.ctab] > 50 ? `<div class="bv-hint" style="margin-top:6px">Top 50 of ${n[ui.ctab]} shown.</div>` : ''}`;
  }

  function monthsPane() {
    const ms = d.monthsList;
    return `${paneHead('Months', ms.length === 1 ? 'Already narrowed to one month' : 'Click a month to narrow the whole view to it', metricToggle())}
      <div class="bv-mtiles">${ms.map(m => { const [c, v] = ui.metric === 'spots' ? [m.Cn, m.Vn] : [m.C, m.V], t = c + v; return `<button class="bv-mt2"${go({ from: m.key, to: m.key })}><span class="mut">${esc(m.label)} ${m.year}</span><b>${mnNum(m.spend)}</b> ${growth(m.spend, m.yoy)}<small>SOS ${pctS(m.sos, 1)} · ${t ? `${nf((c / t) * 100, 0)} : ${nf((v / t) * 100, 0)}` : '–'}</small></button>`; }).join('')}</div>`;
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
      return;
    }
    const g = t.closest('[data-go]');
    if (g) {
      const add = JSON.parse(g.dataset.go);
      if (add.vt) { ui.ctab = add.vt; ui.tab = 'campaigns'; }
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
