'use strict';
// The selected period of the Category dashboard: one run of months, or several (for example Q1 and Q3), added up.
// "Last year" is the same months a year earlier. "Previous" is the same number of months straight before the first
// selected month. The month index is year * 12 + month (0 to 11), as in the datasets.

const keyToMon = k => { const [y, m] = String(k).split('-').map(Number); return y * 12 + m - 1; };
const monthKey = i => `${Math.floor(i / 12)}-${String((i % 12) + 1).padStart(2, '0')}`;

// The ranges asked for: scope.periods, else scope.from / scope.to (one range, either end may come from the filters),
// else the filters' periods, else the filters' from / to.
function periodsOf(f, scope) {
  scope = scope || {};
  if (Array.isArray(scope.periods) && scope.periods.length) return scope.periods;
  if (scope.from || scope.to) return [[scope.from || f.from, scope.to || f.to]];
  if (Array.isArray(f.periods) && f.periods.length) return f.periods;
  return [[f.from, f.to]];
}

// windows(periods): bits(m) is 1 for a selected month, 2 for a month of last year's window, 4 for the previous window.
function windows(periods) {
  const raw = periods.map(([a, b]) => [keyToMon(a), keyToMon(b)]);
  if (!raw.length || raw.some(([a, b]) => !(b >= a))) throw new Error('Invalid month range');
  raw.sort((x, y) => x[0] - y[0]);
  const ivs = [];
  for (const [a, b] of raw) {
    const last = ivs[ivs.length - 1];
    if (last && a <= last[1] + 1) last[1] = Math.max(last[1], b); else ivs.push([a, b]);
  }
  const m0 = ivs[0][0], m1 = ivs[ivs.length - 1][1];
  const len = ivs.reduce((n, [a, b]) => n + b - a + 1, 0);
  const yoy = ivs.map(([a, b]) => [a - 12, b - 12]);
  const prev = [m0 - len, m0 - 1];
  const lo = Math.min(prev[0], yoy[0][0]);
  const flags = new Uint8Array(m1 - lo + 1);
  for (const [a, b] of ivs) for (let m = a; m <= b; m++) flags[m - lo] |= 1;
  for (const [a, b] of yoy) for (let m = a; m <= b; m++) flags[m - lo] |= 2;
  for (let m = prev[0]; m <= prev[1]; m++) flags[m - lo] |= 4;
  const months = [];
  for (const [a, b] of ivs) for (let m = a; m <= b; m++) months.push(m);
  const keys = list => list.map(([a, b]) => [monthKey(a), monthKey(b)]);
  return {
    ivs, yoy, prev, m0, m1, len, lo, hi: m1, months,
    bits: m => (m < lo || m > m1 ? 0 : flags[m - lo]),
    ranges: { cur: [monthKey(m0), monthKey(m1)], yoy: [monthKey(m0 - 12), monthKey(m1 - 12)], prev: [monthKey(prev[0]), monthKey(prev[1])], curList: keys(ivs), yoyList: keys(yoy), prevList: keys([prev]), months: len },
  };
}

module.exports = { keyToMon, monthKey, periodsOf, windows };
