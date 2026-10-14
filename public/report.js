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
        <label class="sh-ck${ai.ok ? '' : ' off'}"><input type="checkbox" id="rpAi" ${ai.ok ? 'checked' : 'disabled'}><span><b>Short notes on each slide (Ollama)</b> <small>${ai.ok ? `a local model writes 2–3 lines about what the slide shows, from the numbers on screen. Model <select class="rp-sel" id="rpAiModel">${ai.models.map(m => `<option${m === ai.model ? ' selected' : ''}>${esc(m)}</option>`).join('')}</select>` : `(Ollama was not found: ${esc(ai.error || 'start it and reopen this window')}. Everything else works without it.)`}</small></span></label>
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
  });
  function estimate(o) { return (o.ai ? 0 : 0) + 3 + (o.spot ? 29 : 0) + (o.cat ? 17 : 0) + (o.adv ? 1 + 4 * o.advN : 0) + (o.br ? 6 * o.brN : 0); }
  function info() {
    const o = optsNow(), n = estimate(o);
    const secs = Math.round(n * 1.1 + (o.ai ? n * 6 : 0));
    $('rpInfo').innerHTML = `About <b>${n}</b> slides · takes about <b>${secs >= 120 ? Math.round(secs / 60) + ' minutes' : Math.max(10, secs) + ' seconds'}</b>${o.ai ? ' (notes make it slower)' : ''}`;
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

  // ---------- the deck ----------
  function deckBuilder(title, footerText, aiOn) {
    const deck = new window.PptxGenJS();
    deck.layout = 'LAYOUT_WIDE'; // 13.33 x 7.5 in
    deck.title = title; deck.company = 'Ogilvy'; deck.author = 'Ogilvy Orbit Chub';
    let n = 0;
    const pending = [];
    const base = (headline, sub) => {
      const s = deck.addSlide(); n++;
      s.background = { color: 'FFFFFF' };
      s.addText(headline, { x: 0.45, y: 0.2, w: 12.4, h: 0.55, fontFace: 'Georgia', fontSize: 22, color: INK, margin: 0, fit: 'shrink', valign: 'middle' });
      if (sub) s.addText(sub, { x: 0.45, y: 0.76, w: 12.4, h: 0.3, fontFace: 'Calibri', fontSize: 11.5, color: GREY, margin: 0 });
      s.addText(footerText, { x: 0.45, y: 7.13, w: 9, h: 0.25, fontFace: 'Calibri', fontSize: 9, color: '9AA3BC', margin: 0 });
      s.addText(`Ogilvy Orbit – Chub · ${n}`, { x: 9.4, y: 7.13, w: 3.5, h: 0.25, fontFace: 'Calibri', fontSize: 9, color: '9AA3BC', align: 'right', margin: 0 });
      return s;
    };
    return {
      deck,
      picture(headline, sub, im, note) {
        if (!im) return;
        const s = base(headline, sub), aw = 12.43, ah = aiOn ? 5.0 : 5.8, sc = Math.min(aw / im.w, ah / im.h), w = im.w * sc, h = im.h * sc;
        s.addImage({ data: im.url, x: 0.45 + (aw - w) / 2, y: 1.18 + (ah - h) / 2, w, h });
        if (aiOn && im.text) pending.push({ s, headline, text: im.text });
      },
      pending,
      divider(num, headline, lines) {
        const s = deck.addSlide(); n++;
        s.background = { color: INK };
        s.addText(String(num), { x: 0.8, y: 2.0, w: 2, h: 1.6, fontFace: 'Georgia', fontSize: 96, color: 'FF8A3D', margin: 0 });
        s.addText(headline, { x: 0.8, y: 3.6, w: 11.5, h: 0.9, fontFace: 'Georgia', fontSize: 36, color: 'FFFFFF', margin: 0 });
        s.addText(lines, { x: 0.8, y: 4.6, w: 11.5, h: 1.6, fontFace: 'Calibri', fontSize: 15, color: 'C5CEE3', margin: 0, valign: 'top' });
      },
      text(headline, sub, runs) {
        const s = base(headline, sub);
        s.addText(runs, { x: 0.8, y: 1.4, w: 11.7, h: 5.4, fontFace: 'Calibri', fontSize: 16, color: INK, valign: 'top', margin: 0, paraSpaceAfter: 8 });
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
    let ok = false;
    try {
      step('Loading the picture and PowerPoint tools');
      await Promise.all([window.htmlToImage ? 0 : loadScript('/vendor/html-to-image/html-to-image.js'), window.PptxGenJS ? 0 : loadScript('/vendor/pptxgenjs/pptxgen.bundle.js')]);
      $('drawerToggle').checked = false; $('catDrawerToggle').checked = false;
      const st = O.spot.getState();
      const spotPeriod = $('periodText').textContent.replace(/\s+/g, ' ').trim();
      const pgName = st.pg;
      const footer = `${pgName} · ${spotPeriod}`;
      const B = deckBuilder(`${pgName}: full report`, footer, !!o.ai);
      const chips = [...document.querySelectorAll('#chips .chip')].filter(c => c.id !== 'busyChip').map(c => c.textContent.trim()).filter(Boolean);

      // cover and contents
      const cover = B.deck.addSlide();
      cover.background = { color: INK };
      cover.addText('OGILVY ORBIT – CHUB', { x: 0.8, y: 0.7, w: 8, h: 0.4, fontFace: 'Calibri', fontSize: 12, color: 'FF8A3D', bold: true, charSpacing: 4, margin: 0 });
      cover.addText(`${pgName}`, { x: 0.8, y: 2.0, w: 11.7, h: 1.2, fontFace: 'Georgia', fontSize: 48, color: 'FFFFFF', margin: 0 });
      cover.addText('Media investment review', { x: 0.8, y: 3.2, w: 11.7, h: 0.7, fontFace: 'Georgia', fontSize: 26, color: 'C5CEE3', margin: 0 });
      cover.addText([{ text: spotPeriod, options: { breakLine: true, bold: true } }, { text: chips.join(' · '), options: { fontSize: 12 } }], { x: 0.8, y: 4.4, w: 11.7, h: 1.2, fontFace: 'Calibri', fontSize: 16, color: 'FFFFFF', margin: 0, valign: 'top' });
      cover.addText(`Prepared ${new Date().toLocaleDateString([], { dateStyle: 'long' })}`, { x: 0.8, y: 6.7, w: 8, h: 0.3, fontFace: 'Calibri', fontSize: 11, color: '9AA3BC', margin: 0 });
      const flow = [];
      if (o.spot || o.cat) flow.push(['1', 'Overall analysis', [o.spot ? 'Spot Log dashboard: trend, share of spend, channel mix, duration mix, every view' : '', o.cat ? 'Category dashboard: investment, sub categories, monthly by brand, mother brands, channel preference' : ''].filter(Boolean)]);
      if (o.adv) flow.push(['2', 'Advertiser analysis', ['The category\'s advertisers, then campaigns, value additions, channels and months for each selected advertiser']]);
      if (o.br) flow.push(['3', 'Brand analysis', [`The top ${o.brN} mother brands, one by one: advertisers, medium split, channel mix, duration mix, brands and campaigns`]]);
      step('Cover and contents');
      B.text('Contents', `${pgName} · ${spotPeriod}`, flow.flatMap(([num, name, lines]) => [{ text: `${num}   ${name}`, options: { bold: true, fontSize: 20, breakLine: true } }, ...lines.map(l => ({ text: l, options: { fontSize: 13, color: GREY, breakLine: true, indentLevel: 1 } }))]));

      // ===== 1 · Overall analysis =====
      if (o.spot || o.cat) B.divider(1, 'Overall analysis', flow[0][2].join('\n'));
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
        B.divider(2, 'Advertiser analysis', 'The category\'s advertisers, then each selected advertiser: its campaigns in the period with spend, share and spots, then its value additions, channels and months.');
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
        B.divider(3, 'Brand analysis', `The top ${cards.length} mother brands one by one: who runs the brand, its medium split, channel mix, duration mix, its brands with Commercials against Value additions, and its campaigns.`);
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
        total += B.pending.length; let failed = 0;
        for (let i = 0; i < B.pending.length; i++) {
          const { s, headline, text } = B.pending[i];
          step(`Writing notes: slide ${i + 1} of ${B.pending.length}`);
          try {
            const r = await fetch('/api/ai/notes', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ model: o.ai, title: headline, text }) });
            const j = await r.json();
            if (!r.ok || !j.notes) throw new Error(j.error || 'no notes');
            s.addShape('rect', { x: 0.45, y: 6.2, w: 0.06, h: 0.8, fill: { color: 'FF8A3D' }, line: { color: 'FF8A3D', width: 0 } });
            s.addText(j.notes, { x: 0.62, y: 6.2, w: 12.2, h: 0.8, fontFace: 'Calibri', fontSize: 11.5, color: INK, valign: 'middle', margin: 0, fit: 'shrink', paraSpaceAfter: 2 });
            s.addNotes(j.notes);
            failed = 0;
          } catch (e) { if (e.message === 'Stopped') throw e; if (++failed >= 3) { O.toast('Ollama stopped answering, so the rest has no notes'); break; } }
        }
      }
      step('Writing the PowerPoint file');
      const file = `${pgName.replace(/[^A-Za-z0-9]+/g, '_')}_Full_report_${new Date().toISOString().slice(0, 10)}.pptx`;
      await B.deck.writeFile({ fileName: file });
      O.toast(`Report downloaded: ${B.count()} slides`);
      ok = true;
    } catch (e) {
      $('rpErr').textContent = e.message === 'Stopped' ? 'Stopped. Nothing was downloaded.' : 'Could not finish the report: ' + e.message;
    } finally {
      $('rpStep').textContent = 'Putting the dashboards back…';
      document.body.classList.remove('exporting', 'rpt');
      await restore(before);
      ctl = null;
      $('rpGo').disabled = false; $('rpCancel').textContent = 'Close';
      if (ok) { $('rpProg').hidden = true; root.classList.remove('on'); } else $('rpStep').textContent = '';
    }
  }

  window.REPORT = { open };
})();
