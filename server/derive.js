'use strict';
// Derived field rules. Computed once at upload time and stored as real columns.

const MEDIA = ['TV', 'Radio', 'Press'];
const DAYPARTS = ['Morning', 'Daytime', 'Prime', 'Late night', 'Not timed'];
const DAYPART_TIMES = ['05:00 to 12:00', '12:00 to 18:30', '18:30 to 22:30', '22:30 to 05:00', 'no Advt_time, e.g. Press'];
const DURATIONS = [5, 10, 15, 20, 30];
const DUR_BUCKETS = ['5s', '10s', '15s', '20s', '30s', '30s+'];
const BREAK_QUALITY = ['Premium', 'Mid break', 'Unknown'];
const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

// Medium: TV / Radio / Press, parsed from the Channel string.
function mediumOf(channel) {
  const s = String(channel || '').trim();
  if (/^TV\s*-/i.test(s) || /\bTV\b/i.test(s)) return 0;
  if (/^FM\b/i.test(s) || /\bFM\b/i.test(s) || /^Radio\s*-/i.test(s)) return 1;
  return 2;
}

// ChannelName: the part after the "TV - " / "FM - " / "Radio - " prefix.
function channelNameOf(channel) {
  const s = String(channel || '').trim();
  const m = s.match(/^(TV|FM|Radio|Press)\s*[-:–]\s*(.+)$/i);
  return m ? m[2].trim() : s;
}

// Daypart from minutes after midnight. Prime is 18:30 to 22:30.
function daypartOf(minutes) {
  if (minutes == null || Number.isNaN(minutes)) return 4;
  if (minutes < 300) return 3;   // 00:00 to 05:00
  if (minutes < 720) return 0;   // 05:00 to 12:00
  if (minutes < 1110) return 1;  // 12:00 to 18:30
  if (minutes < 1350) return 2;  // 18:30 to 22:30
  return 3;                      // 22:30 to 24:00
}

// Std_Dur as an index into DUR_BUCKETS: 1 to 9s -> 5s, 10 to 30s snaps to the nearest of 10/15/20/30
// (ties go to the shorter standard, so 12.5s -> 10s and 25s -> 20s), above 30s -> 30s+.
function stdDurIndex(dur) {
  const d = Number(dur);
  if (!Number.isFinite(d) || d <= 0) return 255; // no duration (typical for Press)
  if (d < 10) return 0;
  if (d > 30) return 5;
  let best = 1, bestDist = Infinity;
  for (let k = 1; k < DURATIONS.length; k++) {
    const dist = Math.abs(d - DURATIONS[k]);
    if (dist < bestDist) { best = k; bestDist = dist; }
  }
  return best;
}

// Break_Quality: first or last in break is Premium (bookend), otherwise Mid break.
function breakQualityOf(posInBrk, adsInBrk) {
  const p = Number(posInBrk), n = Number(adsInBrk);
  if (!Number.isFinite(p) || p <= 0) return 2;
  if (p === 1 || (Number.isFinite(n) && p === n)) return 0;
  return 1;
}

function parseMonth(v) {
  if (v == null || v === '') return NaN;
  const n = Number(v);
  if (Number.isFinite(n)) return n;
  const k = MONTHS.findIndex(m => String(v).trim().toLowerCase().startsWith(m.toLowerCase()));
  return k >= 0 ? k + 1 : NaN;
}

// Days since 1970-01-01 (UTC) from Dd, Mn, Yr. Returns NaN when invalid.
function dayNumber(dd, mn, yr) {
  const d = Number(dd), m = parseMonth(mn);
  let y = Number(yr);
  if (!Number.isFinite(d) || !Number.isFinite(m) || !Number.isFinite(y)) return NaN;
  if (y < 100) y += 2000;
  if (m < 1 || m > 12 || d < 1 || d > 31) return NaN;
  const t = Date.UTC(y, m - 1, d);
  const back = new Date(t);
  if (back.getUTCDate() !== d) return NaN; // e.g. 31 Feb
  return Math.round(t / 86400000);
}

// Minutes after midnight from Advt_time. Accepts "19:45:10", "7:45 PM", Excel fractions, HHMM ints, Date.
function parseTime(v) {
  if (v == null || v === '') return null;
  if (v instanceof Date) return v.getUTCHours() * 60 + v.getUTCMinutes();
  if (typeof v === 'number') {
    if (v >= 0 && v < 1) return Math.floor(v * 1440 + 1e-6);
    if (v >= 1 && v < 2) return Math.floor((v - 1) * 1440 + 1e-6);
    if (v >= 0 && v < 2400 && Number.isInteger(v)) return (Math.floor(v / 100) % 24) * 60 + (v % 100);
    return null;
  }
  const s = String(v).trim();
  const m = s.match(/^(\d{1,2})[:.](\d{2})(?:[:.](\d{2}))?\s*([AaPp][Mm])?/);
  if (m) {
    let h = Number(m[1]) % 24;
    const ap = m[4] && m[4].toUpperCase();
    if (ap === 'PM' && h < 12) h += 12;
    if (ap === 'AM' && h === 12) h = 0;
    return h * 60 + Number(m[2]);
  }
  const n = Number(s);
  return Number.isFinite(n) ? parseTime(n) : null;
}

// Sponsorship and filler items that are not real campaigns. Override with EXCLUDED_THEMES="a;b;c".
const EXCLUDED_THEMES = (process.env.EXCLUDED_THEMES || '-BB;Com Break;DJ;-Extro;-Intro;-LLogo;Next Card;Tag;Time Check;-Tr')
  .split(';').map(t => t.trim().toLowerCase()).filter(Boolean);

// Excluded when the theme equals an item, or ends with a dash marker such as "Summer Promo -BB".
function isExcludedTheme(theme) {
  const t = String(theme || '').trim().toLowerCase();
  if (!t) return false;
  return EXCLUDED_THEMES.some(x => t === x || (x.startsWith('-') && t.endsWith(x)));
}

// Duration bucket and seconds for one ad. Sponsorship items always count as 5s;
// for ACD they use their real Dur, or 5 seconds when Dur is blank.
function durBucketOf(raw, sponsor) {
  if (sponsor) return 0;
  return raw > 0 ? stdDurIndex(raw) : 255;
}
function durSecondsOf(raw, sponsor) {
  if (raw > 0) return raw;
  return sponsor ? DURATIONS[0] : NaN;
}

function parseNumber(v) {
  if (v == null || v === '') return NaN;
  if (typeof v === 'number') return v;
  const n = Number(String(v).replace(/[,\s]|LKR|Rs\.?/gi, ''));
  return Number.isFinite(n) ? n : NaN;
}

module.exports = {
  MEDIA, DAYPARTS, DAYPART_TIMES, DURATIONS, DUR_BUCKETS, BREAK_QUALITY, MONTHS,
  mediumOf, channelNameOf, daypartOf, stdDurIndex, breakQualityOf,
  dayNumber, parseTime, parseNumber, isExcludedTheme, EXCLUDED_THEMES, durBucketOf, durSecondsOf,
};
