'use strict';
// Planning export: one Markdown file with every number a planning tool needs to read how each
// competitor behaves (spend, share, months, media, channels, dayparts, lengths, campaigns),
// plus a flat advertiser x month x channel table for pivoting. Follows the dashboard filters.

const D = require('./derive');

const toDay = iso => Math.round(Date.parse(iso + 'T00:00:00Z') / 86400000);
const toIso = day => new Date(day * 86400000).toISOString().slice(0, 10);
const monthKey = mon => `${Math.floor(mon / 12)}-${String((mon % 12) + 1).padStart(2, '0')}`;
const LEGACY_DUR = [0, 2, 3, 4, 5];

// Markdown helpers.
const cell = v => String(v == null ? '' : v).replace(/\|/g, '\\|').replace(/\r?\n/g, ' ');
const table = (head, rows, align) => {
  const a = align || head.map((_, i) => (i === 0 ? 'l' : 'r'));
  return [
    '| ' + head.map(cell).join(' | ') + ' |',
    '| ' + a.map(x => (x === 'r' ? '---:' : '---')).join(' | ') + ' |',
    ...rows.map(r => '| ' + r.map(cell).join(' | ') + ' |'),
  ].join('\n');
};
const int = v => Math.round(v || 0).toLocaleString('en-US');
const mn = v => ((v || 0) / 1e6).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
const pc = (v, t) => (t > 0 ? ((v / t) * 100).toFixed(1) : '0.0');
const pcOrDash = (v, t) => (t > 0 && v > 0 ? ((v / t) * 100).toFixed(1) : '-');
const fmtDate = iso => { const [y, m, d] = iso.split('-'); return `${d} ${D.MONTHS[m - 1]} ${y}`; };

function planning(ds, f, meta = {}) {
  const { dicts, cols } = ds;
  const nAdv = dicts.adv.length, nCh = dicts.channel.length, nTheme = dicts.theme.length;
  const pgId = dicts.pg.indexOf(f.pg);
  if (pgId < 0) throw new Error('Unknown product group');
  const from = toDay(f.from), to = toDay(f.to);
  if (!(to >= from)) throw new Error('Invalid date range');
  const mediumId = D.MEDIA.indexOf(f.medium);
  const chId = f.channel ? dicts.channel.indexOf(f.channel) : -1;
  const dpId = f.daypart ? D.DAYPARTS.indexOf(f.daypart) : -1;
  const adType = f.adType === 'Sponsorship' ? 2 : f.adType === 'Commercial' ? 1 : 0;
  const role = new Uint8Array(nAdv); // 1 = mine, 2 = competitor
  for (const n of f.comps || []) { const i = dicts.adv.indexOf(n); if (i >= 0) role[i] = 2; }
  for (const n of f.mine || []) { const i = dicts.adv.indexOf(n); if (i >= 0) role[i] = 1; }
  const excluded = new Uint8Array(nTheme);
  dicts.theme.forEach((t, i) => { if (D.isExcludedTheme(t)) excluded[i] = 1; });

  const t0 = new Date(from * 86400000), t1 = new Date(to * 86400000);
  const m0 = t0.getUTCFullYear() * 12 + t0.getUTCMonth();
  const nM = t1.getUTCFullYear() * 12 + t1.getUTCMonth() - m0 + 1;
  const NB = D.DUR_BUCKETS.length, ND = D.DAYPARTS.length;

  const spend = new Float64Array(nAdv), spots = new Float64Array(nAdv);
  const vaSpend = new Float64Array(nAdv), vaSpots = new Float64Array(nAdv);
  const med = new Float64Array(nAdv * 3), medSpots = new Float64Array(nAdv * 3);
  const dps = new Float64Array(nAdv * ND), dpSpots = new Float64Array(nAdv * ND);
  const durC = [new Float64Array(nAdv * NB), new Float64Array(nAdv * NB)]; // TV, Radio spot counts
  const acdS = [new Float64Array(nAdv), new Float64Array(nAdv)], acdN = [new Float64Array(nAdv), new Float64Array(nAdv)];
  const monA = new Float64Array(nM * nAdv), monCat = new Float64Array(nM), monSpotsA = new Float64Array(nM * nAdv);
  const chA = new Float64Array(nCh * nAdv), chSpotsA = new Float64Array(nCh * nAdv), chCat = new Float64Array(nCh);
  const first = new Float64Array(nAdv).fill(Infinity), last = new Float64Array(nAdv).fill(-Infinity);
  const flat = new Map();   // (advertiser, month, channel) -> [spend, spots, durSum, durN]
  const themes = new Map(); // (advertiser, theme) -> { spend, spots, first, last, months:Set, channels:Set }
  let catSpend = 0, catSpots = 0;

  const { pg, adv, ch, theme, day, mon, dp, dur, cost } = cols;
  const durRaw = cols.durRaw || null;
  const chMed = dicts.channelMedium;

  for (let i = 0, n = pg.length; i < n; i++) {
    if (pg[i] !== pgId) continue;
    const d = day[i];
    if (d < from || d > to) continue;
    const c = ch[i], md = chMed[c];
    if (mediumId >= 0 && md !== mediumId) continue;
    if (chId >= 0 && c !== chId) continue;
    if (dpId >= 0 && dp[i] !== dpId) continue;
    const th = theme[i], sponsor = excluded[th] === 1;
    if (adType && (sponsor ? 2 : 1) !== adType) continue;
    const a = adv[i], v = cost[i], k = mon[i] - m0;
    catSpend += v; catSpots++;
    spend[a] += v; spots[a]++;
    if (sponsor) { vaSpend[a] += v; vaSpots[a]++; }
    med[a * 3 + md] += v; medSpots[a * 3 + md]++;
    dps[a * ND + dp[i]] += v; dpSpots[a * ND + dp[i]]++;
    monA[k * nAdv + a] += v; monSpotsA[k * nAdv + a]++; monCat[k] += v;
    chA[c * nAdv + a] += v; chSpotsA[c * nAdv + a]++; chCat[c] += v;
    if (d < first[a]) first[a] = d;
    if (d > last[a]) last[a] = d;
    const raw = durRaw ? D.durSecondsOf(durRaw[i], sponsor) : NaN;
    if (md < 2) {
      const b = durRaw ? D.durBucketOf(durRaw[i], sponsor) : (sponsor ? 0 : (dur[i] < LEGACY_DUR.length ? LEGACY_DUR[dur[i]] : 255));
      if (b < NB) durC[md][a * NB + b]++;
      if (raw > 0) { acdS[md][a] += raw; acdN[md][a]++; }
    }
    const fk = (a * nM + k) * nCh + c;
    const fl = flat.get(fk);
    if (fl) { fl[0] += v; fl[1]++; if (md < 2 && raw > 0) { fl[2] += raw; fl[3]++; } }
    else flat.set(fk, [v, 1, md < 2 && raw > 0 ? raw : 0, md < 2 && raw > 0 ? 1 : 0]);
    const tk = a * nTheme + th;
    let t = themes.get(tk);
    if (!t) { t = { spend: 0, spots: 0, first: d, last: d, months: new Set(), channels: new Set() }; themes.set(tk, t); }
    t.spend += v; t.spots++;
    if (d < t.first) t.first = d;
    if (d > t.last) t.last = d;
    t.months.add(k); t.channels.add(c);
  }

  // Everyone with spend, by spend. Wide tables use the focus set (mine, competitors) plus the rest grouped.
  const active = [];
  for (let a = 0; a < nAdv; a++) if (spend[a] > 0) active.push(a);
  active.sort((x, y) => spend[y] - spend[x]);
  const rank = new Map(active.map((a, i) => [a, i + 1]));
  const roleName = a => (role[a] === 1 ? 'Mine' : role[a] === 2 ? 'Competitor' : 'Other');
  const focus = active.filter(a => role[a]);
  const focusIds = (f.mine || []).concat(f.comps || []).map(n => dicts.adv.indexOf(n)).filter(a => a >= 0);
  const missing = focusIds.filter(a => spend[a] <= 0).map(a => dicts.adv[a]);
  const restIds = active.filter(a => !role[a]);
  const months = Array.from({ length: nM }, (_, k) => monthKey(m0 + k));
  const monLabel = k => `${D.MONTHS[(m0 + k) % 12]} ${Math.floor((m0 + k) / 12)}`;
  const name = a => dicts.adv[a];
  const sum = (ids, fn) => ids.reduce((s, a) => s + fn(a), 0);
  // Columns for wide tables: each focus advertiser, then "Other advertisers", then the category.
  const groups = focus.map(a => ({ label: name(a) + (role[a] === 1 ? ' (mine)' : ''), ids: [a] }));
  if (restIds.length) groups.push({ label: `Other advertisers (${restIds.length})`, ids: restIds });
  groups.push({ label: 'Category', ids: active });

  const out = [];
  const p = (...s) => out.push(...s);
  const adTypeLabel = { 2: 'Value Additions only', 1: 'Commercials only', 0: 'All (Commercials + Value Additions)' }[adType];

  // ---- header ----
  p('# Competitive Media Planning Brief',
    '',
    `**${f.pg}** · ${fmtDate(toIso(from))} to ${fmtDate(toIso(to))} · Ogilvy Orbit Chub · JKH Group Dashboard`,
    '',
    table(['Setting', 'Value'], [
      ['Product group (category)', f.pg],
      ['Period', `${toIso(from)} to ${toIso(to)} (${nM} month${nM === 1 ? '' : 's'})`],
      ['Medium', f.medium === 'All' || mediumId < 0 ? 'All media (TV, Radio, Press)' : f.medium + ' only'],
      ['Channel', f.channel || 'All channels'],
      ['Daypart', f.daypart || 'All dayparts'],
      ['Ad type', adTypeLabel],
      ['My advertiser(s)', (f.mine || []).join(', ') || 'None selected'],
      ['Competitors', (f.comps || []).join(', ') || 'None selected'],
      ['Spend basis', 'Rate card, LKR (not net of discounts)'],
      ['Source file', ds.meta.fileName || ''],
      ['Generated', `${new Date().toISOString().replace('T', ' ').slice(0, 16)} UTC${meta.user ? ' by ' + meta.user : ''}`],
    ], ['l', 'l']),
    '');
  if (!catSpend) {
    p('No spots match these filters, so there is nothing to report.', '');
    return out.join('\n');
  }

  // ---- definitions ----
  p('## How to read this file', '',
    '- **SOS** (share of spend): advertiser spend / category spend in the same period and filters.',
    '- **SOV** (share of voice): advertiser spots / category spots.',
    '- **ACD** (average commercial duration): total seconds / ads with a duration, TV and Radio only.',
    `- **Duration buckets:** ${D.DUR_BUCKETS.join(', ')}. 1 to 9s counts as 5s; 10 to 30s snaps to the nearest standard (ties go to the shorter); over 30s is 30s+. Value Additions always count as 5s.`,
    '- **Value Additions:** sponsorship and filler items (-BB, Com Break, DJ, -Extro, -Intro, -LLogo, Next Card, Tag, Time Check, -Tr). Everything else is a Commercial.',
    `- **Dayparts:** ${D.DAYPARTS.map((d, i) => `${d} ${D.DAYPART_TIMES[i]}`).join('; ')}.`,
    '- Spend in summary tables is in **LKR millions** (Mn). The flat data table at the end uses whole LKR.',
    '- "Other advertisers" groups every advertiser in the category that is not mine or a selected competitor.',
    '');
  if (missing.length) p(`> Selected but with no spend under these filters: ${missing.join(', ')}.`, '');

  // ---- key facts ----
  const topCh = a => { let b = -1; for (let c = 0; c < nCh; c++) if (chA[c * nAdv + a] > 0 && (b < 0 || chA[c * nAdv + a] > chA[b * nAdv + a])) b = c; return b; };
  const topMed = a => [0, 1, 2].reduce((b, m) => (med[a * 3 + m] > med[a * 3 + b] ? m : b), 0);
  const topDp = a => { let b = 0; for (let j = 1; j < ND; j++) if (dps[a * ND + j] > dps[a * ND + b]) b = j; return b; };
  const topDur = a => { let b = -1, bv = 0; for (let j = 0; j < NB; j++) { const v = durC[0][a * NB + j] + durC[1][a * NB + j]; if (v > bv) { b = j; bv = v; } } return b; };
  const peakMon = a => { let b = 0; for (let k = 1; k < nM; k++) if (monA[k * nAdv + a] > monA[b * nAdv + a]) b = k; return b; };
  const activeMonths = a => { let n = 0; for (let k = 0; k < nM; k++) if (monA[k * nAdv + a] > 0) n++; return n; };
  const acdAll = a => (acdN[0][a] + acdN[1][a] ? (acdS[0][a] + acdS[1][a]) / (acdN[0][a] + acdN[1][a]) : null);
  const mineIds = active.filter(a => role[a] === 1);
  const mineSpend = sum(mineIds, a => spend[a]);
  const leader = active[0];
  const facts = [
    `Category spend **LKR ${mn(catSpend)} Mn** across **${int(catSpots)} spots** from **${active.length} advertisers**.`,
    `Category leader: **${name(leader)}** with ${pc(spend[leader], catSpend)}% SOS (LKR ${mn(spend[leader])} Mn).`,
  ];
  if (mineIds.length) {
    const above = active.filter(a => role[a] !== 1 && spend[a] > mineSpend).length;
    facts.push(`My advertiser${mineIds.length > 1 ? 's' : ''} (${mineIds.map(name).join(', ')}): ${pc(mineSpend, catSpend)}% SOS, rank ${above + 1} of ${active.length - mineIds.length + 1}.`);
  }
  for (const a of focus) {
    const c = topCh(a), du = topDur(a), ac = acdAll(a), pk = peakMon(a);
    facts.push(`**${name(a)}**${role[a] === 1 ? ' (mine)' : ''}: ${pc(spend[a], catSpend)}% SOS, active ${activeMonths(a)} of ${nM} months, peak ${monLabel(pk)}; ` +
      `${pc(med[a * 3 + topMed(a)], spend[a])}% in ${D.MEDIA[topMed(a)]}, top channel ${c >= 0 ? dicts.channelName[c] : '-'} (${c >= 0 ? pc(chA[c * nAdv + a], spend[a]) : 0}%), ` +
      `mostly ${D.DAYPARTS[topDp(a)]}${du >= 0 ? `, mostly ${D.DUR_BUCKETS[du]} spots` : ''}${ac ? `, ACD ${Math.round(ac)}s` : ''}; ` +
      `Value Additions ${pc(vaSpend[a], spend[a])}% of spend.`);
  }
  p('## Key facts', '', ...facts.map(s => '- ' + s), '');

  // ---- 1. competitor summary (every advertiser) ----
  p('## 1. Competitor summary (every advertiser in the category)', '',
    table(['#', 'Advertiser', 'Role', 'Spend (LKR Mn)', 'SOS %', 'Spots', 'SOV %', 'Avg cost / spot (LKR)', 'ACD (s)', 'Active months', 'Channels used', 'Campaigns', 'TV %', 'Radio %', 'Press %', 'Commercials %', 'Value Additions %', 'First spot', 'Last spot'],
      active.map(a => {
        let nc = 0; for (let c = 0; c < nCh; c++) if (chA[c * nAdv + a] > 0) nc++;
        let nt = 0; for (const k of themes.keys()) if (Math.floor(k / nTheme) === a) nt++;
        const ac = acdAll(a);
        return [rank.get(a), name(a), roleName(a), mn(spend[a]), pc(spend[a], catSpend), int(spots[a]), pc(spots[a], catSpots), int(spend[a] / spots[a]),
          ac ? Math.round(ac) : '-', activeMonths(a), nc, nt, pc(med[a * 3], spend[a]), pc(med[a * 3 + 1], spend[a]), pc(med[a * 3 + 2], spend[a]),
          pc(spend[a] - vaSpend[a], spend[a]), pc(vaSpend[a], spend[a]), toIso(first[a]), toIso(last[a])];
      }).concat([['', '**Category**', '', mn(catSpend), '100.0', int(catSpots), '100.0', int(catSpend / catSpots),
        (() => { const s = sum(active, a => acdS[0][a] + acdS[1][a]), n = sum(active, a => acdN[0][a] + acdN[1][a]); return n ? Math.round(s / n) : '-'; })(),
        nM, chCat.filter(v => v > 0).length, themes.size,
        pc(sum(active, a => med[a * 3]), catSpend), pc(sum(active, a => med[a * 3 + 1]), catSpend), pc(sum(active, a => med[a * 3 + 2]), catSpend),
        pc(catSpend - sum(active, a => vaSpend[a]), catSpend), pc(sum(active, a => vaSpend[a]), catSpend), toIso(Math.min(...active.map(a => first[a]))), toIso(Math.max(...active.map(a => last[a])))]]),
      ['r', 'l', 'l'].concat(Array(14).fill('r'), ['l', 'l'])),
    '');

  // ---- 2. monthly spend and SOS ----
  const gSpendMon = (g, k) => sum(g.ids, a => monA[k * nAdv + a]);
  p('## 2. Monthly spend (LKR Mn)', '',
    table(['Month'].concat(groups.map(g => g.label)), months.map((m, k) => [monLabel(k)].concat(groups.map(g => mn(gSpendMon(g, k)))))
      .concat([['**Total**'].concat(groups.map(g => mn(sum(g.ids, a => spend[a]))))])),
    '',
    '## 3. Monthly share of spend (SOS %)', '',
    table(['Month'].concat(groups.slice(0, -1).map(g => g.label)), months.map((m, k) => [monLabel(k)].concat(groups.slice(0, -1).map(g => pcOrDash(gSpendMon(g, k), monCat[k]))))
      .concat([['**Period**'].concat(groups.slice(0, -1).map(g => pc(sum(g.ids, a => spend[a]), catSpend)))])),
    '',
    '## 4. Monthly spots', '',
    table(['Month'].concat(groups.map(g => g.label)), months.map((m, k) => [monLabel(k)].concat(groups.map(g => int(sum(g.ids, a => monSpotsA[k * nAdv + a])))))),
    '');

  // ---- 5. medium mix ----
  p('## 5. Medium mix', '',
    table(['Advertiser', 'TV (LKR Mn)', 'TV %', 'TV spots', 'Radio (LKR Mn)', 'Radio %', 'Radio spots', 'Press (LKR Mn)', 'Press %', 'Press insertions'],
      groups.map(g => {
        const s = m => sum(g.ids, a => med[a * 3 + m]), n = m => sum(g.ids, a => medSpots[a * 3 + m]), t = sum(g.ids, a => spend[a]);
        return [g.label, mn(s(0)), pc(s(0), t), int(n(0)), mn(s(1)), pc(s(1), t), int(n(1)), mn(s(2)), pc(s(2), t), int(n(2))];
      })),
    '');

  // ---- 6. channel mix ----
  const chIds = [];
  for (let c = 0; c < nCh; c++) if (chCat[c] > 0) chIds.push(c);
  chIds.sort((x, y) => chMed[x] - chMed[y] || chCat[y] - chCat[x]);
  p('## 6. Channel mix (% of each advertiser\'s spend)', '',
    'Each column adds up to 100% of that advertiser\'s spend. Channels are grouped by medium and ordered by category spend.', '',
    table(['Medium', 'Channel'].concat(groups.map(g => g.label)),
      chIds.map(c => [D.MEDIA[chMed[c]], dicts.channelName[c]].concat(groups.map(g => pcOrDash(sum(g.ids, a => chA[c * nAdv + a]), sum(g.ids, a => spend[a]))))),
      ['l', 'l'].concat(groups.map(() => 'r'))),
    '',
    '## 7. Channel spend and spots (LKR Mn / spots)', '',
    table(['Medium', 'Channel', 'Category (LKR Mn)', 'Category share %'].concat(groups.slice(0, -1).map(g => g.label + ' (LKR Mn / spots)')),
      chIds.map(c => [D.MEDIA[chMed[c]], dicts.channelName[c], mn(chCat[c]), pc(chCat[c], catSpend)].concat(groups.slice(0, -1).map(g => {
        const s = sum(g.ids, a => chA[c * nAdv + a]);
        return s > 0 ? `${mn(s)} / ${int(sum(g.ids, a => chSpotsA[c * nAdv + a]))}` : '-';
      }))),
      ['l', 'l'].concat(Array(2 + groups.length - 1).fill('r'))),
    '');

  // ---- 8. daypart ----
  p('## 8. Daypart mix (% of spend, spots in brackets)', '',
    table(['Advertiser'].concat(D.DAYPARTS.map((d, i) => `${d} (${D.DAYPART_TIMES[i]})`)),
      groups.map(g => [g.label].concat(D.DAYPARTS.map((_, j) => {
        const s = sum(g.ids, a => dps[a * ND + j]);
        return s > 0 ? `${pc(s, sum(g.ids, a => spend[a]))}% (${int(sum(g.ids, a => dpSpots[a * ND + j]))})` : '-';
      })))),
    '');

  // ---- 9. duration ----
  const durTable = ms => table(['Advertiser'].concat(D.DUR_BUCKETS.map(b => b + ' spots'), D.DUR_BUCKETS.map(b => b + ' %'), ['ACD (s)']),
    groups.map(g => {
      const counts = D.DUR_BUCKETS.map((_, j) => sum(g.ids, a => ms.reduce((s, m) => s + durC[m][a * NB + j], 0)));
      const tot = counts.reduce((x, y) => x + y, 0);
      const s = sum(g.ids, a => ms.reduce((t, m) => t + acdS[m][a], 0)), n = sum(g.ids, a => ms.reduce((t, m) => t + acdN[m][a], 0));
      return [g.label].concat(counts.map(int), counts.map(v => pc(v, tot)), [n ? Math.round(s / n) : '-']);
    }));
  p('## 9. Duration mix', '', '### TV + Radio', '', durTable([0, 1]), '', '### TV', '', durTable([0]), '', '### Radio', '', durTable([1]), '');

  // ---- 10. campaigns ----
  p('## 10. Campaigns (Advt_Theme) per advertiser', '',
    'Top 10 campaigns by spend for each focus advertiser (all campaigns for my advertiser). VA = Value Addition item.', '');
  for (const a of focus) {
    const list = [];
    for (const [k, t] of themes) if (Math.floor(k / nTheme) === a) list.push({ th: k % nTheme, ...t });
    list.sort((x, y) => y.spend - x.spend);
    const shown = role[a] === 1 ? list : list.slice(0, 10);
    p(`### ${name(a)}${role[a] === 1 ? ' (mine)' : ''}`, '',
      table(['Campaign', 'Type', 'Spend (LKR Mn)', '% of advertiser', 'Spots', 'Months active', 'First spot', 'Last spot', 'Channels'],
        shown.map(t => [dicts.theme[t.th] || '(blank)', excluded[t.th] ? 'VA' : 'Commercial', mn(t.spend), pc(t.spend, spend[a]), int(t.spots), t.months.size,
          toIso(t.first), toIso(t.last), [...t.channels].sort((x, y) => chA[y * nAdv + a] - chA[x * nAdv + a]).map(c => dicts.channelName[c]).join(', ')]),
        ['l', 'l', 'r', 'r', 'r', 'r', 'l', 'l', 'l']),
      list.length > shown.length ? `\n${list.length - shown.length} smaller campaigns not listed.` : '', '');
  }

  // ---- 11. monthly lead per month ----
  p('## 11. Month by month leader', '',
    table(['Month', 'Category (LKR Mn)', 'Leader', 'Leader SOS %', 'Runner up', 'Runner up SOS %', 'My SOS %'],
      months.map((m, k) => {
        const ord = active.filter(a => monA[k * nAdv + a] > 0).sort((x, y) => monA[k * nAdv + y] - monA[k * nAdv + x]);
        const L = ord[0], R = ord[1];
        return [monLabel(k), mn(monCat[k]), L != null ? name(L) : '-', L != null ? pc(monA[k * nAdv + L], monCat[k]) : '-',
          R != null ? name(R) : '-', R != null ? pc(monA[k * nAdv + R], monCat[k]) : '-', mineIds.length ? pcOrDash(sum(mineIds, a => monA[k * nAdv + a]), monCat[k]) : '-'];
      }), ['l', 'r', 'l', 'r', 'l', 'r', 'r']),
    '');

  // ---- 12. flat data ----
  const rows = [], chMonTot = new Float64Array(nM * nCh);
  for (const [k, v] of flat) {
    const c = k % nCh, rest = (k - c) / nCh, mi = rest % nM, a = (rest - mi) / nM;
    rows.push([a, mi, c, v]);
    chMonTot[mi * nCh + c] += v[0];
  }
  rows.sort((x, y) => (rank.get(x[0]) - rank.get(y[0])) || x[1] - y[1] || chMed[x[2]] - chMed[y[2]] || y[3][0] - x[3][0]);
  p('## 12. Data: advertiser x month x channel', '',
    `One row per advertiser, month and channel with spend (${rows.length.toLocaleString('en-US')} rows, every advertiser in the category). Spend is whole LKR with no separators so planning tools can import it directly.`, '',
    table(['Advertiser', 'Role', 'Month', 'Medium', 'Channel', 'Spend_LKR', 'Spots', 'ACD_s', 'Share_of_advertiser_month_pct', 'Share_of_channel_month_pct'],
      rows.map(([a, mi, c, v]) => {
        const advMon = monA[mi * nAdv + a];
        const chMon = chMonTot[mi * nCh + c];
        return [name(a), roleName(a), months[mi], D.MEDIA[chMed[c]], dicts.channelName[c], Math.round(v[0]), v[1], v[3] ? Math.round(v[2] / v[3]) : '',
          pc(v[0], advMon), pc(v[0], chMon)];
      }), ['l', 'l', 'l', 'l', 'l', 'r', 'r', 'r', 'r', 'r']),
    '');
  return out.join('\n');
}

module.exports = { planning };
