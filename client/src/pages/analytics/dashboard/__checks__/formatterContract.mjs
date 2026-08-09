// FORMATTER CONTRACT verification — drives the REAL ./dashFormat.js and
// ../metricsApi.js readers (NEW FILE, LANE 3).
//
// THE CONTRACT, in one line: `null` and `0` are different facts and must never
// render the same. Everything below is that sentence, made executable.
//
//   A. Every formatter answers EM_DASH for null / undefined / NaN / ±Infinity.
//   B. Every formatter answers a NUMBER for a measured 0 — "$0.00", "0",
//      "0.00%", "0.00x" — because a measured zero is a fact.
//   C. Every rate refuses a missing or zero denominator (null, not 0).
//   D. A delta with no baseline is null — never a fabricated 0% or +100%.
//   E. A chart point that was never measured stays null, so the line gets a
//      HOLE instead of a fake floor.
//   F. Bucket keys are parsed by STRING PARTS. The suite is re-run under a
//      second TZ and both runs must agree, byte for byte.
//   G. The payload readers never invent a key: a withheld payload yields
//      nulls and empty lists, never zeros and never fabricated rows.
//
// Run:  node client/src/pages/analytics/dashboard/__checks__/formatterContract.mjs
//       TZ=Pacific/Auckland node …/formatterContract.mjs   (the F re-run)
import {
  EM_DASH, bucketAxisLabel, bucketTooltipLabel, countryLabel, daysAgoIso,
  deltaPct, fmtCountShort, fmtDate, fmtInt, fmtMoney, fmtMoney0, fmtMoneyShort,
  fmtPct, fmtPctPlain, fmtRate, fmtX, hasKey, hourAxisLabel, hourTooltipLabel,
  isNil, numOrGap, orDash, present, prettyDay, prettyRange, safeRate, shortDay,
  spanDays, todayIso, tzLabel,
} from '../dashFormat.js';
import {
  breakdownOf, bucketKeyOf, kpisOf, marketingOf, seriesOf, sessionsUnknownOf,
  warningsOf, windowOf, hasKey as apiHasKey, present as apiPresent,
  metricsApiError,
} from '../../metricsApi.js';

let pass = 0; let fail = 0;
const ok = (c, m, x = '') => {
  if (c) { pass++; console.log('PASS ', m); } else { fail++; console.log('FAIL ', m, x); }
};
const eq = (got, want, m) => ok(got === want, m, `got=${JSON.stringify(got)} want=${JSON.stringify(want)}`);

console.log(`\n== formatter contract == TZ=${process.env.TZ || '(system)'} ==\n`);

/* ── A. the withheld inputs, every formatter ─────────────────────────────── */

const WITHHELD = [
  ['null', null],
  ['undefined', undefined],
  ['NaN', NaN],
  ['Infinity', Infinity],
  ['-Infinity', -Infinity],
];

const FORMATTERS = {
  fmtMoney, fmtInt, fmtRate, fmtPct, fmtMoneyShort, fmtCountShort,
  fmtPctPlain, fmtX, fmtMoney0,
};

for (const [name, fn] of Object.entries(FORMATTERS)) {
  for (const [label, v] of WITHHELD) {
    eq(fn(v), EM_DASH, `A ${name}(${label}) -> em dash`);
  }
}
eq(fmtDate(null), EM_DASH, 'A fmtDate(null) -> em dash');
eq(fmtDate('not-a-date'), EM_DASH, 'A fmtDate(garbage) -> em dash');

/* ── B. a measured zero is a fact ────────────────────────────────────────── */

eq(fmtMoney(0), '$0.00', 'B fmtMoney(0) prints $0.00');
eq(fmtInt(0), '0', 'B fmtInt(0) prints 0');
eq(fmtPctPlain(0), '0.00%', 'B fmtPctPlain(0) prints 0.00%');
eq(fmtX(0), '0.00x', 'B fmtX(0) prints 0.00x');
eq(fmtMoneyShort(0), '$0', 'B fmtMoneyShort(0) prints $0');
eq(fmtCountShort(0), '0', 'B fmtCountShort(0) prints 0');
eq(fmtMoney0(0), '$0', 'B fmtMoney0(0) prints $0');
eq(fmtRate(0), '0.0%', 'B fmtRate(0) prints 0.0%');

// …and real values still format.
eq(fmtMoney(1234.5), '$1,234.50', 'B fmtMoney(1234.5)');
eq(fmtMoney(-1234.5), '−$1,234.50', 'B fmtMoney negative uses the minus sign');
eq(fmtMoneyShort(1_250_000), '$1.3M', 'B fmtMoneyShort millions');
eq(fmtMoneyShort(52_400), '$52K', 'B fmtMoneyShort ten-thousands');
eq(fmtMoneyShort(-52_400), '−$52K', 'B fmtMoneyShort negative');
eq(fmtCountShort(12_500), '13K', 'B fmtCountShort ten-thousands');
eq(fmtX(1.5234), '1.52x', 'B fmtX rounds to 2dp');
eq(fmtPctPlain(2.4149), '2.41%', 'B fmtPctPlain rounds to 2dp');

// fmtPct is the LIFT formatter and signs positives; fmtPctPlain must NOT —
// a conversion rate of "+2.41%" reads as a change that did not happen.
eq(fmtPct(2.41), '+2.4%', 'B fmtPct (lift) signs the positive');
ok(!fmtPctPlain(2.41).includes('+'), 'B fmtPctPlain does NOT sign the positive');

/* ── C. rates refuse a missing or zero denominator ───────────────────────── */

eq(safeRate(5, 0), null, 'C safeRate over a ZERO denominator is null');
eq(safeRate(5, null), null, 'C safeRate over a WITHHELD denominator is null');
eq(safeRate(5, undefined), null, 'C safeRate over an ABSENT denominator is null');
eq(safeRate(null, 10), null, 'C safeRate of a withheld numerator is null');
eq(safeRate(0, 10), 0, 'C safeRate of a MEASURED zero numerator is 0, not null');
eq(safeRate(3, 12), 0.25, 'C safeRate computes');

/* ── D. a delta needs a baseline ─────────────────────────────────────────── */

eq(deltaPct(5, 0), null, 'D deltaPct against a ZERO baseline is null (no chip)');
eq(deltaPct(5, null), null, 'D deltaPct with no previous value is null');
eq(deltaPct(null, 5), null, 'D deltaPct of a withheld current value is null');
eq(deltaPct(5, 4), 25, 'D deltaPct(5,4) = +25');
eq(deltaPct(0, 4), -100, 'D deltaPct(0,4) = -100 (a measured collapse)');
eq(deltaPct(-2, -4), 50, 'D deltaPct uses |baseline| so a negative baseline keeps direction');

/* ── E. a never-measured point stays a hole ──────────────────────────────── */

eq(numOrGap(null), null, 'E numOrGap(null) stays null — the chart gets a hole');
eq(numOrGap(undefined), null, 'E numOrGap(undefined) stays null');
eq(numOrGap(NaN), null, 'E numOrGap(NaN) stays null');
eq(numOrGap(0), 0, 'E numOrGap(0) is a MEASURED zero and plots');
eq(numOrGap('3.5'), 3.5, 'E numOrGap coerces a numeric string');
eq(numOrGap(''), null, 'E numOrGap("") is not a measurement');

const dashed = orDash(fmtMoney);
eq(dashed(null), EM_DASH, 'E orDash(null) -> em dash');
eq(dashed(0), '$0.00', 'E orDash(0) -> $0.00');

eq(isNil(null), true, 'E isNil(null)');
eq(isNil(0), false, 'E isNil(0) is FALSE — zero is a measurement');
eq(present(0), true, 'E present(0) is TRUE');
eq(present(null), false, 'E present(null) is FALSE');
eq(hasKey({ a: null }, 'a'), true, 'E hasKey sees a key whose value is null (withheld)');
eq(hasKey({}, 'a'), false, 'E hasKey is false for a key never sent (absent)');
eq(apiHasKey({ a: null }, 'a'), true, 'E metricsApi.hasKey agrees with dashFormat.hasKey');
eq(apiPresent(0), true, 'E metricsApi.present(0) agrees');

/* ── F. bucket keys are parsed by string parts ───────────────────────────── */

eq(shortDay('2026-07-14'), 'Jul 14', 'F shortDay');
eq(shortDay('nonsense'), 'nonsense', 'F shortDay passes unparseable input through');
eq(hourAxisLabel('2026-08-07 06:00'), '6 AM', 'F hourAxisLabel 06:00');
eq(hourAxisLabel('2026-08-07 00:00'), '12 AM', 'F hourAxisLabel midnight');
eq(hourAxisLabel('2026-08-07 12:00'), '12 PM', 'F hourAxisLabel noon');
eq(hourAxisLabel('2026-08-07 23:00'), '11 PM', 'F hourAxisLabel 23:00');
eq(hourAxisLabel('2026-08-07'), '', 'F hourAxisLabel is empty for a DAY key');
eq(hourTooltipLabel('2026-08-07 06:00'), 'Aug 7, 2026, 6:00 AM', 'F hourTooltipLabel');
eq(bucketAxisLabel('2026-08-07 06:00'), '6 AM', 'F bucketAxisLabel prefers the hour key');
eq(bucketAxisLabel('2026-08-07'), 'Aug 7', 'F bucketAxisLabel falls back to the day key');
eq(bucketTooltipLabel('2026-08-07'), 'Aug 7', 'F bucketTooltipLabel day');
eq(prettyDay('2026-08-09'), 'Aug 9, 2026', 'F prettyDay');
eq(prettyRange('2026-08-01', '2026-08-09'), 'Aug 1 – Aug 9, 2026', 'F prettyRange');
eq(prettyRange('2026-08-09', '2026-08-09'), 'Aug 9, 2026', 'F prettyRange collapses a single day');
eq(spanDays('2026-08-01', '2026-08-09'), 9, 'F spanDays is inclusive');
eq(spanDays('2026-08-01', null), null, 'F spanDays with a missing edge is null');

/* The zone is the SERVER'S claim. */
eq(tzLabel('Europe/Madrid'), 'Madrid time', 'F tzLabel Europe/Madrid -> "Madrid time"');
eq(tzLabel('UTC'), 'UTC', 'F tzLabel UTC');
eq(tzLabel('America/New_York'), 'America/New_York', 'F tzLabel prints an unknown zone raw');
eq(tzLabel(''), '', 'F tzLabel of an ABSENT zone claims nothing');
eq(tzLabel(null), '', 'F tzLabel(null) claims nothing');

/* Day seeds must be the LOCAL calendar day, never the UTC one — Madrid is
   ahead of UTC, so a UTC-derived "today" is yesterday for part of every night. */
const now = new Date();
const localToday = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}-${String(now.getDate()).padStart(2, '0')}`;
eq(todayIso(), localToday, 'F todayIso is the LOCAL calendar day');
eq(spanDays(daysAgoIso(29), todayIso()), 30, 'F the default 30-day window spans 30 days');

ok(typeof countryLabel('US') === 'string' && countryLabel('US').includes('United States'),
  'F countryLabel resolves a region name');
ok(countryLabel(null) === '' || typeof countryLabel(null) === 'string',
  'F countryLabel never throws on garbage');
eq(countryLabel('ZZZZ'), 'ZZZZ', 'F countryLabel passes an unresolvable code through');

/* ── G. the payload readers invent nothing ───────────────────────────────── */

// A payload where EVERYTHING measurable is withheld. Not one reader may turn a
// null into a number or a missing block into a fabricated row.
const WITHHELD_PAYLOAD = {
  band: { live: null, unique_today: null, today: { orders: null, revenue: null, spend: null, net: null } },
  kpis: {
    gross_sales: null, net_sales: null, orders: null, sessions: null, refunds: null,
    conv_pct: null, aov: null, spend: null, roas: null, net_profit: null,
    net_after_cogs: null, new_customers: null, returning_customers: null,
    previous: { gross_sales: null, orders: null },
    upsell_lines: { aov_post: null, aov_pre: null, upsell_revenue: null, take_rate: null, upsell_refunds: null },
  },
  series: [{ day: '2026-08-08', gross_sales: null, orders: null, sessions: null, conv_pct: null }],
  prev_series: [],
  breakdown_summary: {},
  window: { start: '2026-08-08', end: '2026-08-08', prev_start: '2026-08-07', prev_end: '2026-08-07', timezone: 'Europe/Madrid' },
  meta: { computed_ms: 42, rows_scanned: 0, warnings: ['sessions withheld: window crosses the 90-day touch TTL'], sessions_unknown: true },
};

const wk = kpisOf(WITHHELD_PAYLOAD);
eq(wk.cur.gross_sales, null, 'G a withheld KPI stays null through kpisOf');
eq(wk.prev.gross_sales, null, 'G the previous block is read, not defaulted');
eq(wk.upsell.aov_pre, null, 'G upsell_lines is read off kpis');
eq(windowOf(WITHHELD_PAYLOAD).timezone, 'Europe/Madrid', 'G windowOf carries the server zone verbatim');
eq(tzLabel(windowOf(WITHHELD_PAYLOAD).timezone), 'Madrid time', 'G the header would print "Madrid time"');
eq(sessionsUnknownOf(WITHHELD_PAYLOAD), true, 'G sessions_unknown is read from meta');
eq(warningsOf(WITHHELD_PAYLOAD).length, 1, 'G warnings are surfaced');
eq(seriesOf(WITHHELD_PAYLOAD, 'series').length, 1, 'G seriesOf reads the array form');
eq(seriesOf(WITHHELD_PAYLOAD, 'series')[0].sessions, null, 'G a null series point stays null (a HOLE)');
eq(bucketKeyOf(seriesOf(WITHHELD_PAYLOAD, 'series')[0]), '2026-08-08', 'G bucketKeyOf reads the day key');

const wb = breakdownOf(WITHHELD_PAYLOAD, 'funnels');
eq(wb.sent, false, 'G an ABSENT breakdown reports sent=false (the card hides)');
eq(wb.rows.length, 0, 'G an absent breakdown yields NO fabricated rows');
eq(wb.total, null, 'G an absent breakdown claims NO period total');
eq(wb.basis_label, '', 'G an absent breakdown makes NO basis claim');

// The two breakdown shapes both read.
const SHAPED = {
  breakdown_summary: {
    funnels: { rows: [{ id: 'f1', label: 'Alpha', gross_sales: 100 }], basis: 'gross', basis_label: 'Gross sales', total: 900, rows_total: 12 },
    sources: [{ key: 'fb', label: 'facebook', sales: 50 }],
  },
};
const sf = breakdownOf(SHAPED, 'funnels');
eq(sf.rows.length, 1, 'G object-form breakdown rows');
eq(sf.total, 900, 'G object-form folded total');
eq(sf.rows_total, 12, 'G object-form bucket count');
eq(sf.basis_label, 'Gross sales', 'G object-form basis label');
const ss = breakdownOf(SHAPED, 'sources');
eq(ss.sent, true, 'G array-form breakdown is sent');
eq(ss.rows.length, 1, 'G array-form rows');
eq(ss.total, null, 'G array-form claims no total it was not given');

const mk = marketingOf({
  rows: [{ key: 'c1', label: '', orders: 3, sales: 120 }],
  totals: { orders: 40, sales: 4000, rows_total: 37 },
  basis: 'captured_base',
  basis_label: 'Captured base only — upsell money has no UTM',
});
eq(mk.total, 4000, 'G marketing folded total');
eq(mk.rows_total, 37, 'G marketing bucket count (the "Top N of M" denominator)');
eq(mk.basis_label, 'Captured base only — upsell money has no UTM', 'G marketing basis label');
eq(marketingOf(null).rows.length, 0, 'G a FAILED attribution call yields no rows, not zeros');
eq(marketingOf(null).total, null, 'G a failed attribution call claims no total');

// sessionsUnknown falls back to the reference `sessions_known` inversion, and
// ONLY when that key was actually sent.
eq(sessionsUnknownOf({ kpis: { sessions_known: false } }), true, 'G sessions_known:false -> unknown');
eq(sessionsUnknownOf({ kpis: { sessions_known: true } }), false, 'G sessions_known:true -> known');
eq(sessionsUnknownOf({ kpis: {} }), false, 'G a build that never reports the key does not claim "unknown"');
eq(sessionsUnknownOf(null), false, 'G no payload at all makes no claim');

// Nothing throws on a hostile payload.
let threw = null;
try {
  const junk = { kpis: 7, series: 'nope', breakdown_summary: [], window: 'x', meta: 3 };
  kpisOf(junk); seriesOf(junk); breakdownOf(junk, 'funnels'); windowOf(junk);
  warningsOf(junk); sessionsUnknownOf(junk); marketingOf('nope'); bucketKeyOf(null);
} catch (e) { threw = e; }
ok(threw === null, 'G the readers survive a malformed payload without throwing', String(threw));

// Errors never leak a machine code.
eq(metricsApiError({ response: { data: { error: { code: 'illegal_metric_dimension' } } } }),
  'That metric cannot be broken down by that dimension.', 'G a known error code maps to prose');
ok(!metricsApiError({ response: { data: { error: { code: 'wat_is_this' } } }, message: 'x' } )
  .includes('wat_is_this'), 'G an UNKNOWN error code never reaches the operator');
eq(metricsApiError({ name: 'CanceledError' }), null, 'G an aborted request is not an error');

console.log(`\nRESULT: ${pass} passed, ${fail} failed\n`);
process.exit(fail ? 1 : 0);
