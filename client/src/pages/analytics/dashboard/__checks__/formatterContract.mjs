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
  isNil, numOrGap, orDash, plural, present, prettyDay, prettyRange, safeRate,
  shortDay, spanDays, todayIso, tzLabel, fmtDeduction,
} from '../dashFormat.js';
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  MONEY_METRICS, bandOf, breakdownOf, bucketKeyOf, kpisOf, marketingOf,
  moneyMetricOf, normaliseWarnings, rowMoney, seriesCol, seriesOf,
  sessionsUnknownOf, warningsOf, windowOf, hasKey as apiHasKey,
  present as apiPresent, metricsApiError,
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
  fmtPctPlain, fmtX, fmtMoney0, fmtDeduction,
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

/* A DEDUCTION LINE. A measured zero refund is "$0.00", never "−$0.00": a
   negative zero reads as a rounding artefact and invites the question "what was
   subtracted?" over a window where nothing was. */
eq(fmtDeduction(0), '$0.00', 'B fmtDeduction(0) has NO minus sign');
eq(fmtDeduction(3365), '−$3,365.00', 'B fmtDeduction signs a real deduction');
eq(fmtDeduction(-3365), '−$3,365.00', 'B fmtDeduction is sign-agnostic on input');
eq(fmtDeduction(null), EM_DASH, 'B fmtDeduction(null) -> em dash');

/* Counts agree with their noun — "1 orders" is a rendering bug an operator
   reads as sloppiness on a page whose whole claim is precision. */
eq(plural(1, 'order', 'orders'), '1 order', 'B plural(1) is singular');
eq(plural(2, 'order', 'orders'), '2 orders', 'B plural(2) is plural');
eq(plural(0, 'order', 'orders'), '0 orders', 'B plural(0) is plural');
eq(plural(1234, 'order', 'orders'), '1,234 orders', 'B plural groups thousands');
eq(plural(null, 'order', 'orders'), `${EM_DASH} orders`, 'B plural(null) dashes the COUNT, not the noun');

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

/* THE SEED IS THE REPORTING ZONE'S DAY — not the UTC day and not the browser's.
   Three different "today"s are in play: Madrid is UTC+1/+2, so a UTC-derived
   seed opens the page on YESTERDAY for part of every night; a browser-derived
   seed does the same thing for anyone outside Madrid. This assertion is
   TZ-INVARIANT on purpose — it computes the expected day with Intl in the
   report zone, so the suite re-run under Pacific/Auckland (a day AHEAD of
   Madrid) must produce the identical answer. It caught exactly that: the
   browser-day version returned Auckland's tomorrow. */
const madridToday = new Intl.DateTimeFormat('en-CA', {
  timeZone: 'Europe/Madrid', year: 'numeric', month: '2-digit', day: '2-digit',
}).format(new Date());
eq(todayIso(), madridToday, 'F todayIso is the REPORT ZONE calendar day, in any browser zone');
eq(spanDays(daysAgoIso(29), todayIso()), 30, 'F the default 30-day window spans 30 days');
ok(/^\d{4}-\d{2}-\d{2}$/.test(daysAgoIso(29)), 'F daysAgoIso returns a day key');

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

// `kpis.sessions_known` was the REFERENCE frontend's key and is emitted by
// NEITHER lane here; the reader no longer carries a branch for it. A tolerance
// for a key no server produces cannot be exercised, so it cannot be trusted —
// and it hides the day the real signal changes. The three routes that DO exist
// are pinned in section H against captured output.
eq(sessionsUnknownOf({ kpis: {} }), false, 'G a payload with no session signal claims nothing');
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

/* ── H. THE READERS, AGAINST CAPTURED SERVER OUTPUT ──────────────────────────
 *
 * Everything above proves the readers behave correctly on shapes this file
 * describes. THIS section proves they are pointed at the shapes the servers
 * actually emit — which is the failure that shipped last round, and which no
 * hand-written fixture could have caught, because the fixture and the reader
 * shared one wrong belief.
 *
 * The payloads come from ./seed.generated.json (see ./captureSeed.mjs): real
 * runDashboard / runBand / getMarketing output against a real Postgres.
 */
const HERE_DIR = dirname(fileURLToPath(import.meta.url));
const SEED = JSON.parse(readFileSync(resolve(HERE_DIR, 'seed.generated.json'), 'utf8'));
const CAP = SEED.dashboard;
const CAP_TTL = SEED.dashboard_ttl;
const CAP_MKT = SEED.marketing;
const CAP_MKT_UN = SEED.marketing_unattributed;

console.log(`\n-- captured from metrics@${SEED.captured_from.metrics_commit} attribution@${SEED.captured_from.attribution_commit} --\n`);

/* H1 — finding #1: the money column is net_sales, and the reader NAMES it. */
const capFunnels = breakdownOf(CAP, 'funnels');
eq(capFunnels.sent, true, 'H1 the funnels breakdown is read off the real payload');
ok(capFunnels.rows.length > 0, 'H1 …with rows');
eq(capFunnels.metric, 'net_sales', 'H1 the funnel money column is net_sales, per the SERVER (not gross_sales)');
eq(capFunnels.total_metric, 'net_sales', 'H1 …and the server declares it');
const firstFunnel = capFunnels.rows[0];
eq(rowMoney(firstFunnel).metric, 'net_sales', 'H1 rowMoney reports WHICH metric it read');
eq(rowMoney(firstFunnel).value, firstFunnel.net_sales, 'H1 …and returns that metric’s value');
ok(!apiHasKey(firstFunnel, 'gross_sales'),
  'H1 the row carries NO gross_sales — the old reader would have found nothing and dashed');
eq(moneyMetricOf(capFunnels.rows), 'net_sales', 'H1 moneyMetricOf agrees across the fold');
// products is the one folded on gross — the reader must not hardcode either.
const capProducts = breakdownOf(CAP, 'products');
if (capProducts.rows.length) {
  eq(capProducts.metric, 'gross_sales', 'H1 the products fold is gross_sales, and is read as such');
}

/* H2 — finding #6: the scalar total, the declared metric, the wire count. */
ok(capFunnels.total !== null, `H2 the folded period total is read (${capFunnels.total})`);
eq(capFunnels.total, CAP.breakdown_summary.funnels.total, 'H2 …and equals the server’s scalar');
eq(capFunnels.rows_total, CAP.breakdown_summary.funnels.rows_total, 'H2 the wire bucket count is read');
ok(capFunnels.basis_label.length > 0, `H2 the basis label is present (${capFunnels.basis_label})`);
// The nested-totals fallback still works when the scalar is absent.
const noScalar = { breakdown_summary: { x: {
  rows: CAP.breakdown_summary.funnels.rows,
  totals: CAP.breakdown_summary.funnels.totals,
  basis: 'gross', basis_label: 'l', rows_total: 9,
} } };
eq(breakdownOf(noScalar, 'x').total, CAP.breakdown_summary.funnels.totals.net_sales,
  'H2 with no scalar, the nested totals fold on the SAME metric is used');
// …and a NON-money declared metric must not become a money total.
const countFold = { breakdown_summary: { x: {
  rows: [{ key: 'a', orders: 5 }], totals: { orders: 5 }, total: 5, total_metric: 'orders',
  basis: 'gross', basis_label: 'l', rows_total: 1,
} } };
eq(breakdownOf(countFold, 'x').total, null,
  'H2 a fold declared on ORDERS yields no money total — the footer cannot say "$5 sales"');

/* H3 — finding #3: warnings are {source, reason} objects. */
ok(Array.isArray(CAP_TTL.meta.warnings) && CAP_TTL.meta.warnings.length >= 1,
  'H3 (capture) the TTL window really emits warnings');
ok(typeof CAP_TTL.meta.warnings[0] === 'object',
  'H3 …as OBJECTS, which the string-only reader silently discarded');
const capWarn = warningsOf(CAP_TTL);
eq(capWarn.length, CAP_TTL.meta.warnings.length, 'H3 every warning survives the reader');
eq(capWarn[0].text, CAP_TTL.meta.warnings[0].reason, 'H3 the reason is extracted');
eq(capWarn[0].source, CAP_TTL.meta.warnings[0].source, 'H3 …and the source is kept');
// The string floor stays, and junk is dropped rather than stringified.
eq(normaliseWarnings(['plain string'])[0].text, 'plain string', 'H3 a string warning still reads');
eq(normaliseWarnings([null, 7, {}, { source: 's', reason: 'r' }]).length, 1,
  'H3 junk entries — including an EMPTY object — are dropped, not rendered as [object Object]');
eq(normaliseWarnings([{ source: 'only-a-source' }])[0].text,
  'only-a-source: reported a problem with no reason given',
  'H3 …but a source with no reason is still surfaced, named');

/* H4 — finding #4: sessions_unknown, all three routes to it. */
eq(sessionsUnknownOf(CAP), false, 'H4 a healthy window does NOT claim withheld sessions');
eq(CAP_TTL.meta.sessions_unknown, true, 'H4 (capture) the TTL window sets meta.sessions_unknown');
eq(sessionsUnknownOf(CAP_TTL), true, 'H4 …and the reader reads it');
// Route 2: the warning, for a build that predates the flag.
const noFlag = { ...CAP_TTL, meta: { ...CAP_TTL.meta } };
delete noFlag.meta.sessions_unknown;
eq(sessionsUnknownOf(noFlag), true, 'H4 with no flag, an lb_touches/sessions WARNING still fires it');
// Route 3: the documented fallback.
eq(sessionsUnknownOf({ kpis: { sessions: null, orders: 3 } }), true,
  'H4 fallback: sessions null beside a real order count');
eq(sessionsUnknownOf({ kpis: { sessions: null, orders: null } }), false,
  'H4 …but an entirely empty payload claims nothing');
eq(sessionsUnknownOf({ kpis: { sessions: 0, orders: 3 } }), false,
  'H4 …and a MEASURED zero is not a withholding');
eq(CAP_TTL.kpis.sessions, null, 'H4 (capture) the TTL window really withholds sessions');

/* H5 — the series reader on real points (Lane 1 keys them `key`). */
const capSeries = seriesOf(CAP, 'series');
ok(capSeries.length > 0, `H5 the series is read (${capSeries.length} buckets)`);
eq(bucketKeyOf(capSeries[0]), CAP.series[0].key, 'H5 bucketKeyOf reads Lane 1’s `key`');
eq(seriesCol(capSeries, 'net_sales').length, capSeries.length, 'H5 seriesCol returns one point per bucket');
const ttlSessionCol = seriesCol(seriesOf(CAP_TTL, 'series'), 'sessions');
ok(ttlSessionCol.length > 0 && ttlSessionCol.every((v) => v === null),
  'H5 a past-TTL session column is ALL NULL — holes, never a floor of zeros');
eq(seriesCol('not an array', 'x').length, 0, 'H5 seriesCol type-guards a non-array');
eq(seriesCol([null, 7, { key: 'a' }], 'x').length, 3, 'H5 …and a non-object point yields a hole');
eq(seriesCol([{ key: 'a' }], 'missing')[0], null, 'H5 …as does an absent metric');

/* H6 — the band, and in_window as a TRI-STATE. */
const capBand = bandOf(CAP);
ok(capBand !== null, 'H6 the band block is read');
eq(capBand.inWindow, CAP.band.in_window, 'H6 in_window is read off the composite');
eq(bandOf({ band: { live: 1 } }).inWindow, null,
  'H6 a band with NO in_window key claims nothing — absent is not "outside the window"');
eq(bandOf({ band: { live: 1, in_window: false } }).inWindow, false, 'H6 …and false is read as false');
eq(bandOf(SEED.band ? { band: SEED.band } : null) !== null, true, 'H6 the /band payload reads too');

/* H7 — finding #13: Lane 2's two unattributed facts. */
const capMkt = marketingOf(CAP_MKT);
eq(capMkt.metric, 'sales', 'H7 Lane 2 folds on `sales`, and the reader names it');
eq(capMkt.total, CAP_MKT.totals.sales, 'H7 the footer total comes from totals.sales');
eq(capMkt.rows_total, CAP_MKT.totals.rows_total, 'H7 …and the bucket count from totals.rows_total');
ok(capMkt.revenueBasisLabel.length > 0, `H7 the revenue basis label is read (${capMkt.revenueBasisLabel})`);
const capMktUn = marketingOf(CAP_MKT_UN);
ok(capMktUn.unattributed.none >= 1, 'H7 the "nothing measured" bucket is counted');
ok(capMktUn.unattributed.untagged >= 1, 'H7 the "visit seen, not tagged" bucket is counted SEPARATELY');
const unRow = CAP_MKT_UN.rows.find((r) => r.is_unattributed);
ok(capMktUn.rows.some((r) => r.label === unRow.label),
  'H7 the server’s own disambiguated label survives the reader untouched');

/* H8 — the window echo. */
const capWin = windowOf(CAP);
eq(capWin.timezone, CAP.window.timezone, 'H8 the zone is the server’s claim, verbatim');
eq(tzLabel(capWin.timezone), 'Madrid time', 'H8 …and renders as the operator’s words');
eq(capWin.start, CAP.meta.window.start, 'H8 meta.window is preferred for the edges');
eq(capWin.days, CAP.window.days, 'H8 the day span is read');
eq(capWin.prev_start, CAP.window.prev_start, 'H8 the compare edges come off the top-level window');

/* H9 — the KPI block, on real output. */
const capK = kpisOf(CAP);
ok(capK.cur !== null, 'H9 the KPI block is read');
eq(capK.cur.net_sales, CAP.kpis.net_sales, 'H9 …with the server’s figures');
ok(capK.prev !== null, 'H9 the previous block is nested inside kpis and is found');
ok(capK.upsell !== null, 'H9 upsell_lines is found');
ok(apiHasKey(capK.upsell, 'abandoned'),
  'H9 `abandoned` lives on upsell_lines, NOT on the top-level KPI block');
ok(!apiHasKey(capK.cur, 'items_sold'),
  'H9 `items_sold` is absent from this build — the card must render nothing, not an em dash');
ok(MONEY_METRICS.includes('net_sales'), 'H9 net_sales is a recognised money metric');

console.log(`\nRESULT: ${pass} passed, ${fail} failed\n`);
process.exit(fail ? 1 : 0);
