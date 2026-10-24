(() => {
  'use strict';
  // The full report: one PowerPoint with everything, in a fixed flow.
  //   1. Overall analysis   the Spot Log dashboard (every flip of every card), then the Category dashboard (every flip)
  //   2. Advertiser analysis  the category's advertisers, then each advertiser: Commercials, Value additions, Channels, Months
  //   3. Brand analysis      each top mother brand: Advertisers, Medium split, Channel mix, Duration mix, Brands, Campaigns
  // Every slide is a picture of the real screen, taken after the screen is put into that state by pressing its own buttons.
  const O = window.ORBIT;
  const $ = id => document.getElementById(id);
  const { esc, nf } = O;
  const root = $('rpModal');
  const INK = '1A1F36', GREY = '6B7590';
  const wait = ms => new Promise(r => setTimeout(r, ms));
  const loadScript = src => new Promise((ok, fail) => {
    const s = document.createElement('script');
    s.src = src; s.onload = ok; s.onerror = () => fail(new Error('Could not load ' + src));
    document.head.appendChild(s);
  });
  let ctl = null; // the run in progress

  // ---------- the dialog ----------
  async function open() {
    if (ctl) { root.classList.add('on'); return; }
    const hasSpot = !!(O.spot && O.spot.hasData());
    const hasCat = !!(O.catHelp && O.catHelp.hasData());
    if (!hasSpot) { O.toast('Load your data file first'); return; }
    let brandOk = false;
    try { brandOk = !!(hasCat && window.BRANDVIEW && await window.BRANDVIEW.canOpen()); } catch (e) { brandOk = false; }
    const st = O.spot.getState();
    const advs = [...st.mine, ...st.comps];
    const cards = hasCat ? O.catHelp.cards() : [];
    let ai = { ok: false, models: [] };
    try { ai = await (await fetch('/api/ai/status')).json(); ai.ok = ai.ok && ai.models.length > 0; } catch (e) { ai = { ok: false, models: [], error: e.message }; }
    root.innerHTML = `<div class="sh-box rp-box" role="dialog" aria-label="Full report">
      <div class="sh-h"><h3>Full report (PowerPoint)</h3><button class="bmp-x" id="rpX" aria-label="Close">✕</button></div>
      <div class="sh-body">
        <p class="sh-note" style="margin-top:8px">One deck with the whole story: the overall analysis of both dashboards (every flip), then each advertiser's campaigns and spend, then every top brand. Every slide is a picture of the real screen for your current filters.</p>
        <div class="rp-list">
          <label class="sh-ck"><input type="checkbox" id="rpSpot" checked><span><b>1a · Overall: Spot Log dashboard</b> <small>every view of the trend, share of spend, channel mix and duration cards</small></span></label>
          <label class="sh-ck${hasCat ? '' : ' off'}"><input type="checkbox" id="rpCat" ${hasCat ? 'checked' : 'disabled'}><span><b>1b · Overall: Category dashboard</b> <small>${hasCat ? 'category investment and sub categories, monthly by brand, mother brands and mix, channel preference' : '(open the Category dashboard once first)'}</small></span></label>
          <label class="sh-ck"><input type="checkbox" id="rpAdv" ${advs.length ? 'checked' : 'disabled'}><span><b>2 · Advertiser analysis</b> <small>${advs.length ? `the category's advertisers, then Commercials, Value additions, Channels and Months for each of` : '(pick advertisers in Filters first)'} <select class="rp-sel" id="rpAdvN" ${advs.length ? '' : 'disabled'}>${advs.map((_, i) => `<option value="${i + 1}"${i + 1 === advs.length ? ' selected' : ''}>${i + 1 === advs.length ? `all ${advs.length} selected` : `the first ${i + 1}`}</option>`).join('') || '<option>0</option>'}</select></small></span></label>
          <label class="sh-ck${brandOk ? '' : ' off'}"><input type="checkbox" id="rpBr" ${brandOk ? 'checked' : 'disabled'}><span><b>3 · Brand analysis</b> <small>${brandOk ? 'for each of the top' : '(needs the Category data built from your main file)'} <select class="rp-sel" id="rpBrN" ${brandOk ? '' : 'disabled'}>${[3, 5, 8, 10].filter(n => n <= Math.max(3, cards.length)).map(n => `<option value="${n}"${n === Math.min(5, cards.length || 5) ? ' selected' : ''}>${n}</option>`).join('')}</select> mother brands: Advertisers, Medium split, Channel mix, Duration mix, Brands, Campaigns</small></span></label>
        </div>
        <label class="sh-ck${ai.ok ? '' : ' off'}"><input type="checkbox" id="rpAi" ${ai.ok ? 'checked' : 'disabled'}><span><b>Short note using AI on each slide</b> <small>${ai.ok ? 'writes 2–3 lines about what the slide shows, from the numbers on screen. <select class="rp-sel" id="rpAiScope"><option value="all" selected>Every slide</option><option value="key">Key slides only (faster)</option></select>' : `(not available: ${esc(ai.error || 'the AI service did not answer')}. The report still works without it, but the slides will have no notes.)`}</small></span></label><input type="hidden" id="rpAiModel" value="${esc(ai.model || '')}">
        <div class="sh-status" id="rpInfo"></div>
        <div class="rp-prog" id="rpProg" hidden><div class="rp-bar"><i id="rpBar"></i></div><div class="rp-step" id="rpStep"></div></div>
        <p class="sh-note">While it runs the dashboard will flip and change on its own; keep this tab open and it puts everything back at the end. Bigger reports take longer (about a second per slide).</p>
      </div>
      <div class="sh-f"><span class="sh-err" id="rpErr"></span><button class="btn ghost" id="rpCancel">Close</button><button class="btn pri" id="rpGo">Create PowerPoint</button></div></div>`;
    root.classList.add('on');
    info();
  }
  const optsNow = () => ({
    spot: $('rpSpot').checked, cat: $('rpCat').checked && !$('rpCat').disabled,
    adv: $('rpAdv').checked && !$('rpAdv').disabled, advN: Number($('rpAdvN').value) || 0,
    br: $('rpBr').checked && !$('rpBr').disabled, brN: Number($('rpBrN').value) || 0,
    ai: $('rpAi').checked && !$('rpAi').disabled ? $('rpAiModel').value : '',
    aiAll: !!$('rpAiScope') && $('rpAiScope').value === 'all',
  });
  function estimate(o) { return (o.ai ? 0 : 0) + 3 + (o.spot ? 29 : 0) + (o.cat ? 17 : 0) + (o.adv ? 1 + 4 * o.advN : 0) + (o.br ? 6 * o.brN : 0); }
  function info() {
    const o = optsNow(), n = estimate(o);
    const secs = Math.round(n * 1.1 + (o.ai ? n * (o.aiAll ? 1 : 0.45) * 9 : 0));
    $('rpInfo').innerHTML = `About <b>${n}</b> slides · takes about <b>${secs >= 120 ? Math.round(secs / 60) + ' minutes' : Math.max(10, secs) + ' seconds'}</b>${o.ai ? ' (AI insights make it slower)' : ''}`;
  }
  root.addEventListener('change', info);
  root.addEventListener('click', async e => {
    const t = e.target;
    if (t === root || t.id === 'rpX' || t.id === 'rpCancel') { if (ctl) { ctl.cancel = true; $('rpStep').textContent = 'Stopping…'; } else root.classList.remove('on'); return; }
    if (t.id === 'rpGo' && !ctl) run(optsNow());
  });

  // ---------- helpers that drive the real screens ----------
  const inCat = () => document.body.classList.contains('mode-cat');
  async function showMode(cat) {
    if (inCat() === cat) return;
    $('modeBtn').click();
    await wait(950);
    window.dispatchEvent(new Event('resize'));
    await wait(300);
  }
  // Press a button of a toggle group, if it is there and not already on.
  async function press(group, v, ms = 380) {
    const b = document.querySelector(`${group} [data-v="${v}"]`);
    if (!b || b.hidden || b.offsetParent === null) return false;
    if (!b.classList.contains('on')) { b.click(); await wait(ms); }
    return true;
  }
  const visible = sel => { const el = document.querySelector(sel); return !!(el && !el.hidden && el.offsetParent !== null); };
  const imgOf = url => new Promise(r => { const i = new Image(); i.onload = () => r({ url, w: i.naturalWidth, h: i.naturalHeight }); i.onerror = () => r(null); i.src = url; });
  async function shotEl(el, bg = '#F4F6FA') {
    const url = await window.htmlToImage.toJpeg(el, { quality: 0.9, pixelRatio: 1.5, backgroundColor: bg, width: el.offsetWidth, height: el.offsetHeight, style: { transform: 'none', margin: '0', animation: 'none', boxShadow: 'none' }, filter: n => n.id !== 'rpModal' && !(n.classList && n.classList.contains('bv-noshot')) });
    const im = await imgOf(url); if (im) im.text = textOf(el); return im;
  }
  const textOf = el => (el.innerText || '').replace(/[ \t]+/g, ' ').replace(/\n\s*\n+/g, '\n').trim().slice(0, 4000);
  const spotCard = async id => { const im = await imgOf(await O.spot.cap.card($(id), false)); if (im) im.text = textOf($(id)); return im; };
  const catShot = el => shotEl(el);

  // The toggle groups that the run changes, so they can be put back.
  const GROUPS = ['[data-trflip]', '[data-trpart]', '[data-trside]', '[data-sosview]', '[data-sosflip]', '[data-mixmed]', '[data-mix="mx"]', '[data-durmed]', '#catCiTgl', '#catPartTgl', '#catCpMed'];
  function snapshot() {
    const on = {};
    GROUPS.forEach(g => { const b = document.querySelector(`${g} button.on`); if (b) on[g] = b.dataset.v; });
    return { cat: inCat(), on, ciBack: $('catCiBox').classList.contains('back'), brBack: $('catBrBox').classList.contains('back'), slideM: $('catSlide').classList.contains('on'), slideR: $('catRSlide').classList.contains('on') };
  }
  async function restore(s) {
    try {
      await showMode(false);
      for (const g of GROUPS) if (s.on[g]) { const b = document.querySelector(`${g} [data-v="${s.on[g]}"]`); if (b && !b.classList.contains('on')) { b.click(); await wait(250); } }
      await showMode(true);
      for (const [box, btn, want] of [['catCiBox', 'catCiFlip', s.ciBack], ['catBrBox', 'catBrFlip', s.brBack]]) if ($(box).classList.contains('back') !== want && !$(btn).hidden) { $(btn).click(); await wait(700); }
      for (const [btn, want] of [['catSlide', s.slideM], ['catRSlide', s.slideR]]) if ($(btn).classList.contains('on') !== want && !$(btn).hidden) { $(btn).click(); await wait(600); }
      for (const g of GROUPS) if (s.on[g] && g.startsWith('#')) { const b = document.querySelector(`${g} [data-v="${s.on[g]}"]`); if (b && !b.classList.contains('on')) { b.click(); await wait(250); } }
      await showMode(s.cat);
    } catch (e) { /* leave the screen as it is */ }
  }

  // ---------- the deck, in the Ogilvy PowerPoint format ----------
  // White, black, red and grey; a light serif headline; thin sans copy; "OGILVY" up the left edge and the page number on the right;
  // geometric strips and breaker art. Swap SERIF / SANS below if the Ogilvy fonts are installed on the machines that open the file.
  const RED = 'EE4044', GREYC = 'A5A5A7', BLACK = '000000', SERIF = 'Georgia', SANS = 'Calibri Light';
  const rng = seed => () => (seed = (seed * 16807) % 2147483647) / 2147483647;
  const svgPng = (svg, w, h, scale = 2) => new Promise(res => {
    const img = new Image();
    img.onload = () => { const c = document.createElement('canvas'); c.width = w * scale; c.height = h * scale; c.getContext('2d').drawImage(img, 0, 0, c.width, c.height); res(c.toDataURL('image/png')); };
    img.onerror = () => res(null);
    img.src = 'data:image/svg+xml;charset=utf-8,' + encodeURIComponent(svg);
  });
  const STRIPES = (id, a, b) => `<pattern id="${id}" patternUnits="userSpaceOnUse" width="16" height="16" patternTransform="rotate(45)"><rect width="16" height="16" fill="#${a}"/><rect width="8" height="16" fill="#${b}"/></pattern>`;
  // A row of square tiles (circles, rings, quarter circles, stripes) cut off at the bottom edge of the slide, like the template strip.
  function stripSvg(wIn, hIn, tileIn, seed) {
    const W = wIn * 100, H = hIn * 100, T = tileIn * 100, r = rng(seed);
    let defs = STRIPES('s1', RED, BLACK) + STRIPES('s2', GREYC, BLACK) + STRIPES('s3', 'FFFFFF', RED), body = '';
    const kinds = 8;
    for (let i = 0, x = 0; x < W; i++, x += T) {
      const k = Math.floor(r() * kinds), c = x + T / 2, m = T / 2;
      body += [
        `<rect x="${x}" y="0" width="${T}" height="${T}" fill="#${GREYC}"/><circle cx="${c}" cy="${m}" r="${T * .3}" fill="#${RED}"/>`,
        `<rect x="${x}" y="0" width="${T}" height="${T}" fill="#${BLACK}"/><circle cx="${c}" cy="${m}" r="${T * .3}" fill="none" stroke="#fff" stroke-width="${T * .12}"/>`,
        `<rect x="${x}" y="0" width="${T}" height="${T}" fill="#${RED}"/><circle cx="${c}" cy="${m}" r="${T * .36}" fill="#fff"/>`,
        `<rect x="${x}" y="0" width="${T}" height="${T}" fill="url(#s1)"/>`,
        `<rect x="${x}" y="0" width="${T}" height="${T}" fill="#fff"/><circle cx="${c}" cy="${m}" r="${T * .46}" fill="#${BLACK}"/>`,
        `<rect x="${x}" y="0" width="${T}" height="${T}" fill="#${GREYC}"/><path d="M${x} 0 H${x + T} A${T} ${T} 0 0 1 ${x} ${T} Z" fill="#${BLACK}"/>`,
        `<rect x="${x}" y="0" width="${T}" height="${T}" fill="#fff"/><path d="M${x + T} 0 V${T} H${x} A${T} ${T} 0 0 1 ${x + T} 0 Z" fill="#${RED}"/>`,
        `<rect x="${x}" y="0" width="${T}" height="${T}" fill="url(#s2)"/><circle cx="${c}" cy="${m}" r="${T * .22}" fill="#${RED}"/>`,
      ][k];
    }
    return `<svg xmlns="http://www.w3.org/2000/svg" width="${W}" height="${H}" viewBox="0 0 ${W} ${H}"><defs>${defs}</defs>${body}</svg>`;
  }
  // Overlapping circles for the breaker slides, on a grey, black or red page.
  function clusterSvg(bg) {
    const W = 560, H = 750;
    const pal = { grey: [BLACK, RED, 'S1', 'S2'], black: [RED, GREYC, 'S1', 'S2'], red: [BLACK, 'FFFFFF', GREYC, 'S4'] }[bg];
    const spots = [[250, 20, 90, 0], [150, 100, 82, 2], [300, 260, 82, 1], [420, 190, 80, 3], [180, 440, 82, 1], [290, 420, 80, 3], [440, 520, 80, 2], [120, 650, 80, 0], [330, 730, 80, 1], [500, 60, 70, 0], [500, 640, 80, 0]];
    const defs = STRIPES('S1', RED, BLACK) + STRIPES('S2', GREYC, BLACK) + STRIPES('S4', 'FFFFFF', BLACK);
    const body = spots.map(([x, y, rad, k]) => { const f = pal[k]; const fill = /^S/.test(f) ? `url(#${f})` : `#${f}`; return `<circle cx="${x}" cy="${y}" r="${rad}" fill="${fill}"/>`; }).join('');
    return `<svg xmlns="http://www.w3.org/2000/svg" width="${W}" height="${H}" viewBox="0 0 ${W} ${H}"><defs>${defs}</defs>${body}</svg>`;
  }
  const dataUrl = url => fetch(url).then(r => r.blob()).then(b => new Promise(ok => { const f = new FileReader(); f.onload = () => ok(f.result); f.readAsDataURL(b); })).catch(() => null);
  async function makeArt() {
    const logo = await dataUrl('/ogilvy-orbit-chub.png'), lim = logo ? await imgOf(logo) : null;
    return {
      logo: lim, cover: await svgPng(stripSvg(13.33, 1.1, 1.9, 7), 1333, 110),
      agenda: await svgPng(stripSvg(13.33, 0.9, 1.4, 11), 1333, 90),
      grey: await svgPng(clusterSvg('grey'), 560, 750), black: await svgPng(clusterSvg('black'), 560, 750), red: await svgPng(clusterSvg('red'), 560, 750),
    };
  }
  const MONTHS = new Date().toLocaleDateString('en-US', { month: 'long', year: 'numeric' });
  function deckBuilder(title, sourceText, aiOn, art) {
    const deck = new window.PptxGenJS();
    deck.layout = 'LAYOUT_WIDE'; // 13.33 x 7.5 in
    deck.title = title; deck.company = 'Ogilvy'; deck.author = 'Ogilvy';
    let n = 0;
    const pics = [], seen = new Set();
    const frame = (s, dark) => { // the quiet furniture of the format: OGILVY up the left edge, page number on the right
      s.addText('OGILVY', { x: 0.02, y: 3.1, w: 0.3, h: 1.3, vert: 'vert270', fontFace: SANS, fontSize: 8, charSpacing: 2, color: dark ? 'FFFFFF' : BLACK, align: 'center', margin: 0 });
      s.addText(String(n), { x: 12.9, y: 3.55, w: 0.35, h: 0.3, fontFace: SANS, fontSize: 9, color: dark ? 'FFFFFF' : BLACK, align: 'center', margin: 0 });
    };
    const slide = (bg, dark) => { const s = deck.addSlide(); n++; s.background = { color: bg }; frame(s, dark); return s; };
    const clean = t => String(t || '').replace(/^\d[a-z]? · /, '');
    return {
      deck,
      cover(titleText, sub, chips) {
        const s = slide('FFFFFF', false);
        if (art.logo) { const h = 0.42, w = h * art.logo.w / art.logo.h; s.addImage({ data: art.logo.url, x: 0.5, y: 0.3, w, h }); }
        s.addText(MONTHS, { x: 5.2, y: 0.32, w: 2.9, h: 0.3, fontFace: SANS, fontSize: 12, color: BLACK, align: 'center', margin: 0 });
        s.addText('© all rights reserved', { x: 9.6, y: 0.32, w: 3.25, h: 0.3, fontFace: SANS, fontSize: 12, color: BLACK, align: 'right', margin: 0 });
        s.addText([{ text: titleText, options: { breakLine: true } }, { text: sub }], { x: 0.7, y: 1.35, w: 11.8, h: 3.4, fontFace: SERIF, fontSize: 54, color: BLACK, valign: 'top', margin: 0, fit: 'shrink', lineSpacingMultiple: 0.95 });
        s.addText(chips, { x: 0.75, y: 4.9, w: 11.5, h: 1.2, fontFace: SANS, fontSize: 14, color: '555555', valign: 'top', margin: 0 });
        if (art.cover) s.addImage({ data: art.cover, x: 0, y: 6.4, w: 13.33, h: 1.1 });
      },
      agenda(items) {
        const s = slide('FFFFFF', false);
        s.addText('Agenda', { x: 2.6, y: 0.5, w: 8, h: 1.7, fontFace: SERIF, fontSize: 80, color: BLACK, margin: 0, valign: 'middle' });
        items.forEach(([num, name, desc], i) => {
          const y = 2.45 + i * 1.2;
          s.addText(String(num).padStart(2, '0'), { x: 4.6, y, w: 1.0, h: 0.6, fontFace: SERIF, fontSize: 30, color: RED, margin: 0, valign: 'top' });
          s.addText([{ text: name, options: { fontSize: 20, color: BLACK, breakLine: true } }, { text: desc, options: { fontSize: 12.5, color: '555555' } }], { x: 5.9, y: y + 0.02, w: 6.6, h: 1.0, fontFace: SANS, margin: 0, valign: 'top' });
        });
        if (art.agenda) s.addImage({ data: art.agenda, x: 0, y: 6.6, w: 13.33, h: 0.9 });
      },
      divider(num, headline, lines) { // the breaker slide: grey, black, then red
        const kind = ['grey', 'black', 'red'][(Number(num) - 1) % 3] || 'grey', dark = kind === 'black';
        const s = slide({ grey: GREYC, black: BLACK, red: RED }[kind], dark), ink = dark ? 'FFFFFF' : BLACK;
        s.addText(String(num).padStart(2, '0'), { x: 0.85, y: 2.3, w: 2, h: 0.7, fontFace: SERIF, fontSize: 30, color: dark ? RED : 'FFFFFF', margin: 0 });
        s.addText(headline, { x: 0.85, y: 3.0, w: 6.4, h: 1.9, fontFace: SERIF, fontSize: 50, color: ink, margin: 0, valign: 'top', fit: 'shrink' });
        s.addText(lines, { x: 0.85, y: 5.0, w: 6.2, h: 1.5, fontFace: SANS, fontSize: 14, color: ink, margin: 0, valign: 'top' });
        if (art[kind]) s.addImage({ data: art[kind], x: 7.45, y: 0, w: 5.88, h: 7.5 });
      },
      closing(text) {
        const s = slide(BLACK, true);
        s.addText(text, { x: 0.85, y: 2.9, w: 6.4, h: 1.6, fontFace: SERIF, fontSize: 60, color: 'FFFFFF', margin: 0 });
        s.addText(sourceText, { x: 0.85, y: 4.6, w: 6.2, h: 0.8, fontFace: SANS, fontSize: 13, color: 'FFFFFF', margin: 0, valign: 'top' });
        if (art.black) s.addImage({ data: art.black, x: 7.45, y: 0, w: 5.88, h: 7.5 });
      },
      // A screenshot slide. The picture is placed in finish(), once we know whether it has insights beside it.
      picture(headline, sub, im) {
        if (!im) return;
        let sec = '', head = headline;
        const m = String(headline).match(/^\d[a-z]? · ([^:]+): (.+)$/);
        if (m) { sec = m[1]; head = m[2][0].toUpperCase() + m[2].slice(1); }
        const subs = [sec, clean(sub)].filter(Boolean).join(' · ');
        const s = slide('FFFFFF', false);
        s.addText(head, { x: 0.85, y: 0.3, w: 11.7, h: 0.8, fontFace: SERIF, fontSize: 30, color: BLACK, margin: 0, valign: 'top', fit: 'shrink' });
        s.addText(subs, { x: 0.85, y: 1.1, w: 11.7, h: 0.3, fontFace: SANS, fontSize: 12.5, color: RED, margin: 0 });
        s.addText(`Source: ${sourceText}`, { x: 0.85, y: 7.08, w: 9, h: 0.25, fontFace: SANS, fontSize: 8, color: '777777', margin: 0 });
        const base = head.split(/[:,]/)[0].toLowerCase().trim(), tail = (head.split(': ')[1] || '').toLowerCase();
        const minor = /^(value additions|channels|months)$/.test(tail) || /^(medium split|duration mix|campaigns)$/.test(tail);
        const key = !minor && !seen.has(base); seen.add(base);
        pics.push({ s, im, headline: head, text: im.text, notes: '', key });
      },
      pending: pics, // slides still waiting for their insights
      finish() {
        for (const p of pics) {
          const has = !!p.notes, ax = 0.85, ay = 1.6, aw = has ? 8.75 : 11.65, ah = 5.3, sc = Math.min(aw / p.im.w, ah / p.im.h), w = p.im.w * sc, h = p.im.h * sc;
          p.s.addImage({ data: p.im.url, x: ax + (aw - w) / 2, y: ay + (ah - h) / 2, w, h });
          if (has) {
            const items = p.notes.split('\n').map(l => l.replace(/^[•\-*]\s*/, '').trim()).filter(Boolean).slice(0, 3);
            p.s.addText('Key insights', { x: 9.95, y: 1.6, w: 2.9, h: 0.3, fontFace: SANS, fontSize: 13, color: RED, margin: 0 });
            items.forEach((t, i) => {
              const y = 2.05 + i * 1.6;
              p.s.addText(String(i + 1).padStart(2, '0'), { x: 9.95, y, w: 0.5, h: 0.3, fontFace: SERIF, fontSize: 12, color: RED, margin: 0, valign: 'top' });
              p.s.addShape('line', { x: 10.45, y: y + 0.12, w: 2.4, h: 0, line: { color: BLACK, width: 0.75 } });
              p.s.addText(t, { x: 10.45, y: y + 0.22, w: 2.4, h: 1.25, fontFace: SANS, fontSize: 11.5, color: BLACK, margin: 0, valign: 'top', fit: 'shrink' });
            });
            p.s.addNotes(p.notes);
          }
        }
      },
      count: () => n,
    };
  }

  // ---------- the run ----------
  async function run(o) {
    ctl = { cancel: false };
    $('rpGo').disabled = true; $('rpErr').textContent = '';
    $('rpProg').hidden = false; $('rpCancel').textContent = 'Stop';
    let total = estimate(o);
    let done = 0;
    const step = label => { done++; $('rpBar').style.width = Math.min(100, Math.round((done / total) * 100)) + '%'; $('rpStep').textContent = label; if (ctl.cancel) throw new Error('Stopped'); };
    const before = snapshot();
    let ok = false, aiNote = '';
    try {
      step('Loading the picture and PowerPoint tools');
      await Promise.all([window.htmlToImage ? 0 : loadScript('/vendor/html-to-image/html-to-image.js'), window.PptxGenJS ? 0 : loadScript('/vendor/pptxgenjs/pptxgen.bundle.js')]);
      $('drawerToggle').checked = false; $('catDrawerToggle').checked = false;
      const st = O.spot.getState();
      const spotPeriod = $('periodText').textContent.replace(/\s+/g, ' ').trim();
      const pgName = st.pg;
      const footer = `${pgName} · ${spotPeriod}`;
      const art = await makeArt();
      const B = deckBuilder(`${pgName}: full report`, footer, !!o.ai, art);
      const chips = [...document.querySelectorAll('#chips .chip')].filter(c => c.id !== 'busyChip').map(c => c.textContent.trim()).filter(Boolean);

      // cover and agenda
      B.cover(pgName, 'Media investment review', [{ text: spotPeriod, options: { breakLine: true, bold: true, color: BLACK, fontSize: 18 } }, { text: chips.join('  ·  ') }]);
      const flow = [];
      if (o.spot || o.cat) flow.push([flow.length + 1, 'Overall analysis', [o.spot ? 'Spot Log dashboard: trend, share of spend, channel mix and duration mix' : '', o.cat ? 'Category dashboard: investment, sub categories, brands, mother brands and channel preference' : ''].filter(Boolean).join('. ')]);
      if (o.adv) flow.push([flow.length + 1, 'Advertiser analysis', 'The category\'s advertisers, then campaigns, value additions, channels and months for each selected advertiser']);
      if (o.br) flow.push([flow.length + 1, 'Brand analysis', `The top ${o.brN} mother brands, one by one: advertisers, medium split, channel mix, duration mix, brands and campaigns`]);
      const no = {}; flow.forEach(f => { no[f[1]] = f[0]; });
      step('Cover and agenda');
      B.agenda(flow);

      // ===== 1 · Overall analysis =====
      if (o.spot || o.cat) B.divider(no['Overall analysis'], 'Overall analysis', flow[0][2]);
      if (o.spot) {
        await showMode(false);
        const head = id => ($(id).textContent || '').trim();
        const tag = '1a · Spot Log dashboard';
        let im;
        step('Spot Log: the whole dashboard'); im = await O.spot.cap.dashboard(); B.picture(`${tag}: the whole dashboard`, spotPeriod, await imgOf(im.url).then(r => r && { ...r, w: im.w, h: im.h, text: textOf($('viewSpot')) }));
        document.body.classList.add('exporting');
        try {
          step('Spot Log: medium split'); B.picture(head('h-donut'), `${tag} · category against mine, by medium`, await spotCard('cardMedium'));
          // trend: lines, then the bars for Category and Us in YOY, quarters and halves
          await press('[data-trflip]', 'lines');
          step('Spot Log: monthly trend'); B.picture(head('h-line'), `${tag} · monthly lines`, await spotCard('cardTrend'));
          await press('[data-trflip]', 'bars');
          for (const side of ['cat', 'mine']) for (const [part, pn] of [['yoy', 'year on year'], ['q', 'quarter by quarter'], ['h', 'half by half']]) {
            await press('[data-trside]', side); await press('[data-trpart]', part);
            step(`Spot Log: trend bars (${side === 'cat' ? 'category' : 'us'}, ${pn})`);
            B.picture(head('h-line'), `${tag} · stacked bars, ${side === 'cat' ? 'category' : 'us'}, ${pn}`, await spotCard('cardTrend'));
          }
          await press('[data-trflip]', 'lines');
          step('Spot Log: month drill down'); B.picture(head('h-acc'), `${tag} · top spender and lead campaign by month`, await spotCard('cardDrill'));
          // share of spend: period, by year, by month, each as a table and as a chart where it can flip
          for (const [view, vn] of [['period', 'selected period'], ['year', 'by year'], ['month', 'by month']]) {
            await press('[data-sosview]', view, 500);
            await press('[data-sosflip]', 'table');
            step(`Spot Log: share of spend, ${vn}`); B.picture(head('h-sos'), `${tag} · ${vn}, table`, await spotCard('cardSos'));
            if (visible('#sosFlip') && await press('[data-sosflip]', 'chart', 500)) { step(`Spot Log: share of spend, ${vn}, chart`); B.picture(head('h-sos'), `${tag} · ${vn}, chart`, await spotCard('cardSos')); await press('[data-sosflip]', 'table'); }
          }
          await press('[data-sosview]', 'period', 450);
          // channel mix: top 5 and the full heat map (category and mine) for each medium
          for (const m of ['TV', 'Radio', 'Press']) {
            if (!(await press('[data-mixmed]', m, 450))) continue;
            await press('[data-mix="mx"]', 'bars');
            step(`Spot Log: channel mix, ${m}, top 5`); B.picture(head('h-mix'), `${tag} · ${m}, top 5 channels`, await spotCard('cardMix'));
            await press('[data-mix="mx"]', 'heat', 450);
            for (const side of ['cat', 'mine']) {
              await press('#chMix .tgl[data-heat]', side, 450);
              step(`Spot Log: channel mix, ${m}, all channels (${side === 'cat' ? 'category' : 'mine'})`); B.picture(head('h-mix'), `${tag} · ${m}, every channel month by month, ${side === 'cat' ? 'category' : 'mine'}`, await spotCard('cardMix'));
            }
            await press('[data-mix="mx"]', 'bars');
          }
          await press('[data-mixmed]', 'TV', 400);
          for (const m of ['TV', 'Radio']) { await press('[data-durmed]', m, 420); step(`Spot Log: duration mix, ${m}`); B.picture(head('h-dur'), `${tag} · ${m} ads by length`, await spotCard('cardDur')); }
          await press('[data-durmed]', 'TV', 300);
        } finally { document.body.classList.remove('exporting'); }
      }
      if (o.cat) {
        await showMode(true);
        const root2 = $('viewCat');
        root2.classList.add('exporting');
        try {
          const tag = '1b · Category dashboard';
          const catPeriod = $('catPeriodText').textContent.replace(/\s+/g, ' ').trim();
          const flipOf = (box, btn, back) => ($(box).classList.contains('back') !== back && !$(btn).hidden ? (async () => { $(btn).click(); await wait(750); })() : Promise.resolve());
          const slideTo = async (btn, on) => { if ($(btn).classList.contains('on') !== on && !$(btn).hidden) { $(btn).click(); await wait(750); } };
          await slideTo('catSlide', false); await slideTo('catRSlide', false); await flipOf('catCiBox', 'catCiFlip', false); await flipOf('catBrBox', 'catBrFlip', false);
          step('Category: the whole screen'); B.picture(`${tag}: ${($('catTitle').textContent || '').trim() || 'leading brands by investment'}`, catPeriod, await catShot($('catOne')));
          // category investment (and sub categories) in years, halves and quarters
          for (const [part, pn] of [['y', 'years'], ['h', 'half years'], ['q', 'quarters']]) {
            await press('#catCiTgl', part, 600); await flipOf('catCiBox', 'catCiFlip', false);
            step(`Category: category investment by ${pn}`); B.picture(`${tag}: category investment by ${pn}`, catPeriod, await catShot($('catLeft')));
            if (!$('catCiFlip').hidden) { await flipOf('catCiBox', 'catCiFlip', true); step(`Category: sub category investment by ${pn}`); B.picture(`${tag}: sub category investment by ${pn}`, catPeriod, await catShot($('catLeft'))); await flipOf('catCiBox', 'catCiFlip', false); }
          }
          // monthly investment by brand: months, quarters, halves, years
          await slideTo('catSlide', true);
          for (const [part, pn] of [['m', 'month by month'], ['q', 'quarter by quarter'], ['h', 'half by half'], ['y', 'year by year']]) {
            await press('#catPartTgl', part, 650);
            step(`Category: investment by brand, ${pn}`); B.picture(`${tag}: investment by brand, ${pn}`, catPeriod, await catShot($('catLeft')));
          }
          await slideTo('catSlide', false);
          // investment by mother brand: the tables, then mix and contribution, then channel preference
          step('Category: investment by mother brand'); B.picture(`${tag}: investment by mother brand`, catPeriod, await catShot($('catS3')));
          if (!$('catBrFlip').hidden) { await flipOf('catBrBox', 'catBrFlip', true); step('Category: mix and contribution'); B.picture(`${tag}: mix shifting and contribution`, catPeriod, await catShot($('catS3'))); await flipOf('catBrBox', 'catBrFlip', false); }
          if (!$('catRSlide').hidden) {
            await slideTo('catRSlide', true);
            for (const m of ['TV', 'Radio', 'Press', '']) {
              if (!(await press('#catCpMed', m, 900))) continue;
              step(`Category: channel preference, ${m || 'all media'}`); B.picture(`${tag}: channel preference by brands, ${m || 'all media'}`, catPeriod, await catShot($('catS3')));
            }
            await press('#catCpMed', 'TV', 600);
            await slideTo('catRSlide', false);
          }
        } finally { root2.classList.remove('exporting'); }
      }

      // ===== 2 · Advertiser analysis (the Spot Log click-through, tab by tab) =====
      if (o.adv) {
        await showMode(false);
        B.divider(no['Advertiser analysis'], 'Advertiser analysis', 'The category\'s advertisers, then each selected advertiser: its campaigns in the period with spend, share and spots, then its value additions, channels and months.');
        document.body.classList.add('rpt');
        const grab = async tab => { O.spot.cap.setDetailTab(tab); await wait(350); const box = $('modal').querySelector('.mbox'); return shotEl(box, '#FFFFFF'); };
        try {
          step('Advertisers: the whole category');
          await O.spot.cap.openDetail({ title: 'Category spend', tab: 'adv' }); await wait(500);
          B.picture('2 · Advertisers in the category', `${pgName} · ${spotPeriod} · ranked by spend (top 14)`, await grab('adv'));
          const names = [...st.mine, ...st.comps].slice(0, o.advN);
          for (const name of names) {
            const mine = st.mine.includes(name);
            await O.spot.cap.openDetail({ advertiser: name, title: name, tab: 'camp' }); await wait(500);
            const tabs = [['camp', 'Commercials (campaigns)'], ['va', 'Value additions'], ['ch', 'Channels'], ['mon', 'Months']];
            for (const [tab, tn] of tabs) {
              const btn = $('mTabs').querySelector(`[data-t="${tab}"]`);
              if (!btn || btn.hidden) { step(`${name}: ${tn} (skipped)`); continue; }
              step(`${name}: ${tn}`);
              B.picture(`${name}${mine ? ' (mine)' : ''}: ${tn}`, `2 · Advertiser analysis · ${spotPeriod}`, await grab(tab));
            }
          }
        } finally { O.spot.cap.closeDetail(); document.body.classList.remove('rpt'); }
      }

      // ===== 3 · Brand analysis (the Category brand view, tab by tab) =====
      if (o.br) {
        await showMode(true);
        const cards = O.catHelp.cards().slice(0, o.brN);
        const catPeriod = $('catPeriodText').textContent.replace(/\s+/g, ' ').trim();
        B.divider(no['Brand analysis'], 'Brand analysis', `The top ${cards.length} mother brands one by one: who runs the brand, its medium split, channel mix, duration mix, its brands with Commercials against Value additions, and its campaigns.`);
        try {
          for (const c of cards) {
            step(`${c.name}: opening`);
            await window.BRANDVIEW.open({ mb: c.name }); await wait(450);
            const tabs = [['advertisers', 'Advertisers'], ['medium', 'Medium split'], ['channels', 'Channel mix'], ['duration', 'Duration mix'], ['children', 'Brands · Commercials vs Value additions'], ['campaigns', 'Campaigns']];
            for (const [k, kn] of tabs) {
              window.BRANDVIEW.showTab(k); await wait(450);
              step(`${c.name}: ${kn}`);
              B.picture(`${c.name}${c.mine ? ' (mine)' : ''}: ${kn}`, `3 · Brand analysis · ${catPeriod}`, await shotEl(window.BRANDVIEW.box().querySelector('.bv-wrap') || window.BRANDVIEW.box(), '#F4F6FA'));
            }
          }
        } finally { window.BRANDVIEW.close(); }
      }

      if (o.ai && B.pending.length) {
        const aiContext = `Our advertiser (the client, "mine"): ${st.mine.join(', ') || 'not set'}. Competitors: ${st.comps.join(', ') || 'none selected'}. Category: ${pgName}. Period: ${spotPeriod}. Currency LKR. Write from our advertiser's side.`;
        total += B.pending.filter(p => p.text && (o.aiAll || p.key)).length + 1; let failed = 0, written = 0, firstErr = '';
        const ask = async (title, text) => {
          const ctl2 = new AbortController(), t = setTimeout(() => ctl2.abort(), 170000);
          try {
            const r = await fetch('/api/ai/notes', { method: 'POST', headers: { 'Content-Type': 'application/json' }, signal: ctl2.signal, body: JSON.stringify({ model: o.ai, title, text, context: aiContext }) });
            let j = {}; try { j = await r.json(); } catch (e) { throw new Error(`the server answered ${r.status} (not JSON)`); }
            if (!r.ok) throw new Error(j.error || `the server answered ${r.status}`);
            if (!j.notes) throw new Error('the model returned an empty note');
            return j.notes;
          } catch (e) { throw new Error(e.name === 'AbortError' ? 'the model took longer than 2 minutes for one slide (the AI service is too slow: give it more CPU, set OLLAMA_THREADS to its vCPU count, or use a smaller model)' : e.message); } finally { clearTimeout(t); }
        };
        // the first call loads the model into memory, which can take a minute or two on a small server
        step('Starting the AI model (the first note is the slowest)');
        let warmErr = '';
        try { await ask('warm up', 'Spend 100 Mn. Share 20%.'); } catch (e) { if (e.message === 'Stopped') throw e; firstErr = warmErr = e.message; }
        // if even the warm-up note fails, the service cannot do this job: skip the AI step now instead of waiting on every slide
        for (let i = 0; i < B.pending.length && !(failed >= 2) && !warmErr; i++) {
          const p = B.pending[i];
          step(`Writing insights: slide ${i + 1} of ${B.pending.length}${written ? ` (${written} done)` : ''}`);
          if (!p.text || (!o.aiAll && !p.key)) continue;
          let notes = '';
          for (let tryNo = 0; tryNo < 1 && !notes; tryNo++) {
            try { notes = await ask(p.headline, p.text); } catch (e) { if (e.message === 'Stopped') throw e; firstErr = firstErr || e.message; }
          }
          if (!notes) { failed++; continue; }
          failed = 0; written++; p.notes = notes;
        }
        const wanted = B.pending.filter(p => p.text && (o.aiAll || p.key)).length;
        aiNote = written === wanted ? '' : written ? `AI notes written on ${written} of ${wanted} slides. The rest failed: ${firstErr}` : `No AI notes were written: ${firstErr || 'the model did not answer'}`;
      }
      B.closing('Thank you');
      B.finish();
      step('Writing the PowerPoint file');
      const file = `${pgName.replace(/[^A-Za-z0-9]+/g, '_')}_Full_report_${new Date().toISOString().slice(0, 10)}.pptx`;
      await B.deck.writeFile({ fileName: file });
      O.toast(`Report downloaded: ${B.count()} slides${aiNote ? ', but some AI notes failed' : ''}`);
      ok = true;
    } catch (e) {
      $('rpErr').textContent = e.message === 'Stopped' ? 'Stopped. Nothing was downloaded.' : 'Could not finish the report: ' + e.message;
    } finally {
      $('rpStep').textContent = 'Putting the dashboards back…';
      document.body.classList.remove('exporting', 'rpt');
      await restore(before);
      ctl = null;
      $('rpGo').disabled = false; $('rpCancel').textContent = 'Close';
      if (ok && !aiNote) { $('rpProg').hidden = true; root.classList.remove('on'); } else if (ok) { $('rpProg').hidden = true; $('rpErr').textContent = aiNote; } else $('rpStep').textContent = '';
    }
  }

  window.REPORT = { open };
})();
