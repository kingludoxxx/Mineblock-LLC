/**
 * reportConfig harness — legality matrix, state repair, validation, the URL
 * round-trip, the query body and the honesty contract (null -> em dash).
 *
 * Standalone: `node client/src/pages/analytics/explorer/tests/reportConfig.harness.mjs`
 * No server, no DB — reportConfig.js is pure by construction and this is what
 * proves it stays that way. Exits non-zero on the first FAIL count.
 */
import assert from 'node:assert/strict';
import {
  CHART_KEYS, DIMENSIONS, DIMENSION_KEYS, MAX_METRICS, MAX_ROAS_DAYS,
  MAX_WINDOW_DAYS, METRIC_KEYS, buildQueryBody, chartBlockReason, csvFilename,
  dimensionBlockReason, dimensionServes, emptyState, fmtMultiple, fmtPercent,
  formatMetric, granularityBlockReason, legalCharts, legalDimensions,
  legalGranularities, legalMetrics, metricBlockReason, normalizeState,
  reportChips, reportTitle, seedFromParams, seedFromQuery, sortRows,
  stateToParams, stateToSearch, toCsv, validateQueryState, windowDays,
} from '../../reportConfig.js';
import { EM_DASH } from '../../format.js';

let pass = 0;
let fail = 0;
const failures = [];

function check(name, fn) {
  try {
    fn();
    pass += 1;
    console.log(`  PASS  ${name}`);
  } catch (e) {
    fail += 1;
    failures.push(`${name}: ${e.message}`);
    console.log(`  FAIL  ${name}\n        ${e.message}`);
  }
}
function section(title) { console.log(`\n── ${title} ${'─'.repeat(Math.max(0, 58 - title.length))}`); }

const W = { start_day: '2026-07-10', end_day: '2026-08-08' };
const base = (over) => normalizeState({
  mode: 'query', metrics: ['net_sales', 'orders'], dimension: '', granularity: 'day',
  viz: 'line', compare: false, window: W, filters: {}, ...(over || {}),
});

/* ══ 1. LEGALITY — the combos that must be LEGAL ══════════════════════ */
section('1. legal combinations');

check('over-time (no dimension) serves every metric', () => {
  assert.deepEqual(legalMetrics('', 'day'), METRIC_KEYS);
});

check('product serves exactly orders / gross_sales / aov (line-priced fold)', () => {
  assert.deepEqual(legalMetrics('product'), ['orders', 'gross_sales', 'aov']);
});

check('funnel serves the ad metrics (lb_ad_spend_daily keys on funnel)', () => {
  ['spend', 'roas', 'cpa', 'net_profit'].forEach((m) => {
    assert.equal(dimensionServes('funnel', m), true, m);
  });
});

check('campaign + source also serve the ad metrics', () => {
  ['campaign', 'source'].forEach((d) => {
    assert.equal(dimensionServes(d, 'spend'), true, d);
  });
});

check('country serves money (order shipping country) — and nothing else', () => {
  assert.equal(dimensionServes('country', 'gross_sales'), true);
  assert.equal(dimensionServes('country', 'orders'), true);
});

check('funnel is legal for the default net_sales + orders pair', () => {
  assert.ok(legalDimensions(['net_sales', 'orders']).includes('funnel'));
});

check('every dimension in DIM_METRICS has a DIMENSIONS entry and vice versa', () => {
  assert.deepEqual(DIMENSION_KEYS.slice().sort(), DIMENSION_KEYS.slice().sort());
  DIMENSION_KEYS.forEach((d) => assert.ok(DIMENSIONS[d], d));
});

/* ══ 2. LEGALITY — the combos that must be ILLEGAL ════════════════════ */
section('2. illegal combinations (each with a reason)');

check('sessions by product is illegal — no touch spine on a line item', () => {
  assert.equal(dimensionServes('product', 'sessions'), false);
  assert.match(metricBlockReason('sessions', { dimension: 'product' }), /not measured by Product/);
});

check('conv_pct by country is illegal — country is ORDER shipping, not traffic', () => {
  assert.equal(dimensionServes('country', 'conv_pct'), false);
  assert.equal(dimensionServes('country', 'sessions'), false);
  assert.equal(dimensionServes('country', 'pageviews'), false);
  assert.match(metricBlockReason('pageviews', { dimension: 'country' }), /not measured by Country/);
});

check('spend/roas by gateway is illegal — spend has no gateway key', () => {
  ['spend', 'roas', 'cpa', 'net_profit'].forEach((m) => {
    assert.equal(dimensionServes('gateway', m), false, m);
  });
});

check('sessions by gateway is illegal — a gateway is known only at payment', () => {
  assert.equal(dimensionServes('gateway', 'sessions'), false);
});

check('cost metrics by product are illegal (wrong good, misses upsells)', () => {
  ['cogs', 'fees', 'margin_pct', 'net_after_cogs'].forEach((m) => {
    assert.equal(dimensionServes('product', m), false, m);
  });
});

check('device serves NOTHING and is excluded from legalDimensions (Lane 5)', () => {
  assert.deepEqual(legalMetrics('device'), []);
  assert.ok(!legalDimensions([]).includes('device'));
  assert.match(dimensionBlockReason('device', ['orders']), /not collected yet/);
});

check('an unknown metric is illegal everywhere and fails closed', () => {
  assert.equal(dimensionServes('funnel', 'made_up_metric'), false);
  assert.equal(dimensionServes('', 'made_up_metric'), false);
  assert.match(metricBlockReason('made_up_metric'), /Unknown metric/);
});

check('an unknown dimension serves nothing', () => {
  assert.deepEqual(legalMetrics('nope'), []);
  assert.match(dimensionBlockReason('nope', ['orders']), /Unknown group-by/);
});

check('legalDimensions narrows as metrics are added', () => {
  const wide = legalDimensions(['orders']);
  const narrow = legalDimensions(['orders', 'spend']);
  assert.ok(wide.length > narrow.length);
  assert.deepEqual(narrow, ['funnel', 'source', 'campaign']);
});

/* ══ 3. GRANULARITY + CHART legality ═════════════════════════════════ */
section('3. granularity + chart legality');

check('hour is legal only on a single-day window', () => {
  assert.ok(legalGranularities('2026-08-08', '2026-08-08').includes('hour'));
  assert.ok(!legalGranularities('2026-08-07', '2026-08-08').includes('hour'));
  assert.match(granularityBlockReason('hour', '2026-08-01', '2026-08-08'), /single-day/);
  assert.equal(granularityBlockReason('hour', '2026-08-08', '2026-08-08'), '');
});

check('spend is day-only: illegal at hour granularity, legal at day', () => {
  assert.ok(!legalMetrics('', 'hour').includes('spend'));
  assert.ok(legalMetrics('', 'day').includes('spend'));
  assert.match(metricBlockReason('spend', { dimension: '', granularity: 'hour' }), /day-granularity only/);
});

check('new_customers / abandoned are day-only too', () => {
  ['new_customers', 'returning_customers', 'abandoned', 'abandoned_rate', 'upsell_take_pct']
    .forEach((m) => assert.ok(!legalMetrics('', 'hour').includes(m), m));
});

check('line is legal over time, illegal with a group-by', () => {
  assert.ok(legalCharts('', ['orders']).includes('line'));
  assert.ok(!legalCharts('funnel', ['orders']).includes('line'));
  assert.match(chartBlockReason('line', 'funnel', ['orders']), /over-time/);
  assert.equal(chartBlockReason('line', '', ['orders']), '');
});

check('bar / table / big-number are always legal', () => {
  ['bar', 'table', 'big-number'].forEach((c) => {
    assert.ok(legalCharts('', ['orders']).includes(c), c);
    assert.ok(legalCharts('gateway', ['orders', 'aov']).includes(c), c);
  });
  assert.equal(legalCharts('gateway', []).length, CHART_KEYS.length - 1);
});

/* ══ 4. normalizeState REPAIRS rather than rejects ════════════════════ */
section('4. state repair');

check('an illegal metric is dropped when the dimension cannot serve it', () => {
  const s = normalizeState({ ...base(), metrics: ['orders', 'sessions', 'aov'], dimension: 'product' });
  assert.deepEqual(s.metrics, ['orders', 'aov']);
});

check('dropping every metric falls back to a legal one, never to []', () => {
  const s = normalizeState({ ...base(), metrics: ['sessions'], dimension: 'gateway' });
  assert.equal(s.metrics.length >= 1, true);
  s.metrics.forEach((m) => assert.equal(dimensionServes('gateway', m), true, m));
});

check('viz falls back from line to bar once a group-by is set', () => {
  const s = normalizeState({ ...base(), dimension: 'funnel', viz: 'line' });
  assert.equal(s.viz, 'bar');
});

check('more than MAX_METRICS is truncated, duplicates collapsed', () => {
  const many = METRIC_KEYS.slice(0, 12);
  const s = normalizeState({ ...base(), metrics: [...many, ...many] });
  assert.equal(s.metrics.length, MAX_METRICS);
  assert.equal(new Set(s.metrics).size, MAX_METRICS);
});

check('a reversed window is swapped, not rejected', () => {
  const s = normalizeState({ ...base(), window: { start_day: '2026-08-08', end_day: '2026-07-10' } });
  assert.deepEqual(s.window, W);
});

check('hour granularity on a multi-day window falls back to day', () => {
  const s = normalizeState({ ...base(), granularity: 'hour' });
  assert.equal(s.granularity, 'day');
});

check('the unavailable device dimension is repaired to over-time', () => {
  assert.equal(normalizeState({ ...base(), dimension: 'device' }).dimension, '');
});

check('a junk country filter is dropped rather than sent (would match nothing)', () => {
  assert.equal(normalizeState({ ...base(), filters: { country: 'united states' } }).filters.country, '');
  assert.equal(normalizeState({ ...base(), filters: { country: 'us' } }).filters.country, 'US');
});

check('an unknown gateway filter is dropped (allowlist miss = 422)', () => {
  assert.equal(normalizeState({ ...base(), filters: { gateway: 'bitcoin' } }).filters.gateway, '');
  assert.equal(normalizeState({ ...base(), filters: { gateway: 'whop' } }).filters.gateway, 'whop');
});

/* ══ 5. normalizeState NEVER THROWS on garbage ═══════════════════════ */
section('5. garbage in, legal state out (never throws)');

const GARBAGE = [null, undefined, 0, '', 'nope', [], NaN, true,
  { metrics: 'orders' }, { window: 'yesterday' }, { metrics: [null, 5, {}] },
  { dimension: {}, viz: [], filters: 7, granularity: 99 }];

check('normalizeState survives every garbage input and stays legal', () => {
  GARBAGE.forEach((g, i) => {
    const s = normalizeState(g);
    assert.ok(Array.isArray(s.metrics) && s.metrics.length >= 1, `metrics @${i}`);
    assert.ok(Object.prototype.hasOwnProperty.call(s.window, 'start_day'), `window @${i}`);
    assert.ok(legalCharts(s.dimension, s.metrics).includes(s.viz), `viz @${i}`);
    s.metrics.forEach((m) => assert.equal(dimensionServes(s.dimension, m), true, `metric ${m} @${i}`));
  });
});

check('every other exported predicate survives garbage too', () => {
  GARBAGE.forEach((g) => {
    legalMetrics(g, g); legalDimensions(g); legalCharts(g, g); legalGranularities(g, g);
    metricBlockReason(g, { dimension: g, granularity: g });
    dimensionBlockReason(g, g); chartBlockReason(g, g, g); granularityBlockReason(g, g, g);
    validateQueryState(g); buildQueryBody(g); stateToParams(g); stateToSearch(g);
    seedFromParams(g, g); seedFromQuery(g, g); csvFilename(g); reportTitle(g);
    reportChips(g); sortRows(g, 'x'); toCsv(g); windowDays(g, g);
    formatMetric(g, g); fmtPercent(g); fmtMultiple(g);
  });
});

/* ══ 6. validateQueryState EXPLAINS ══════════════════════════════════ */
section('6. validation');

check('the default state is valid', () => {
  const v = validateQueryState(base());
  assert.equal(v.valid, true, JSON.stringify(v.errors));
});

check('no metrics is an error', () => {
  const v = validateQueryState({ ...base(), metrics: [] });
  assert.equal(v.valid, false);
  assert.ok(v.errors.some((e) => e.field === 'metrics'));
});

check('an illegal metric x dimension is ONE dimension error, not two', () => {
  const v = validateQueryState({ ...base(), metrics: ['sessions'], dimension: 'product' });
  assert.equal(v.valid, false);
  assert.equal(v.errors.filter((e) => e.field === 'dimension').length, 1);
  assert.equal(v.errors.filter((e) => e.field === 'metrics').length, 0);
});

check(`a ${MAX_WINDOW_DAYS + 1}-day window is refused; ${MAX_WINDOW_DAYS} is fine`, () => {
  // 2026-08-08 minus 400 inclusive days = 2025-07-05; 401 = 2025-07-04.
  assert.equal(windowDays('2025-07-04', '2026-08-08'), MAX_WINDOW_DAYS + 1);
  assert.equal(windowDays('2025-07-05', '2026-08-08'), MAX_WINDOW_DAYS);
  const bad = validateQueryState({ ...base(), window: { start_day: '2025-07-04', end_day: '2026-08-08' } });
  assert.equal(bad.valid, false);
  assert.ok(bad.errors.some((e) => e.field === 'window' && /401 days/.test(e.message)),
    JSON.stringify(bad.errors));
  const ok = validateQueryState({ ...base(), window: { start_day: '2025-07-05', end_day: '2026-08-08' } });
  assert.equal(ok.valid, true, JSON.stringify(ok.errors));
});

check('a malformed day is refused', () => {
  const v = validateQueryState({ ...base(), window: { start_day: '2026-13-99', end_day: '2026-08-08' } });
  assert.equal(v.valid, false);
  assert.ok(v.errors.some((e) => e.field === 'window'));
});

check('an empty window (start > end) is refused before it is normalised', () => {
  const v = validateQueryState({ ...base(), window: { start_day: '2026-08-08', end_day: '2026-07-10' } });
  assert.equal(v.valid, false);
});

check(`roas mode refuses a window over ${MAX_ROAS_DAYS} days and demands a funnel`, () => {
  const v = validateQueryState({ ...base(), mode: 'roas', window: { start_day: '2025-08-08', end_day: '2026-08-08' } });
  assert.equal(v.valid, false);
  assert.ok(v.errors.some((e) => e.field === 'window' && /180 days/.test(e.message)));
  assert.ok(v.errors.some((e) => e.field === 'funnel_id'));
});

check('roas mode with a funnel and a short window is valid', () => {
  const v = validateQueryState({ ...base(), mode: 'roas', filters: { funnel_id: 'f_1' } });
  assert.equal(v.valid, true, JSON.stringify(v.errors));
});

check('line + group-by is refused with the chart reason', () => {
  const v = validateQueryState({ ...base(), dimension: 'funnel', viz: 'line' });
  assert.equal(v.valid, false);
  assert.ok(v.errors.some((e) => e.field === 'viz'));
});

/* ══ 7. buildQueryBody = the MetricsQueryBody contract ════════════════ */
section('7. query body');

check('the body carries exactly the contract keys, omitting empties', () => {
  const body = buildQueryBody(base());
  assert.deepEqual(Object.keys(body).sort(), ['compare', 'granularity', 'metrics', 'window']);
  assert.deepEqual(body.window, W);
  assert.equal(body.compare, false);
});

check('dimension + filters appear only when set', () => {
  const body = buildQueryBody({ ...base(), dimension: 'funnel', viz: 'bar', filters: { funnel_id: 'f_1', gateway: 'whop', country: 'us', source: '' } });
  assert.equal(body.dimension, 'funnel');
  assert.deepEqual(body.filters, { funnel_id: 'f_1', country: 'US', gateway: 'whop' });
  assert.ok(!('source' in body.filters), 'empty source must not be sent');
});

check('the body never carries viz / mode / report (server vocabulary only)', () => {
  const body = buildQueryBody({ ...base(), viz: 'table', report: 'preset_1' });
  ['viz', 'mode', 'report', 'roas_dimension', 'clicks_network'].forEach((k) => {
    assert.ok(!(k in body), k);
  });
});

/* ══ 8. URL round-trip ═══════════════════════════════════════════════ */
section('8. URL param round-trip');

const ROUND_TRIP_CASES = [
  base(),
  base({ dimension: 'funnel', viz: 'bar', compare: true, granularity: 'week' }),
  base({ metrics: ['gross_sales', 'refunds', 'aov', 'cogs'], dimension: 'gateway', viz: 'table' }),
  base({ window: { start_day: '2026-08-08', end_day: '2026-08-08' }, granularity: 'hour', metrics: ['orders'] }),
  base({ mode: 'roas', roas_dimension: 'sub7', filters: { funnel_id: 'f_42' } }),
  base({ mode: 'clicks', clicks_network: 'meta', filters: { funnel_id: 'f_42' } }),
  base({ filters: { funnel_id: 'f_9', country: 'DE', gateway: 'stripe', source: 'utm/with,comma' }, report: 'preset_net_by_funnel' }),
];

check('stateToParams -> seedFromParams is an exact round-trip (object form)', () => {
  ROUND_TRIP_CASES.forEach((s, i) => {
    assert.deepEqual(seedFromParams(stateToParams(s), emptyState()), s, `case ${i}`);
  });
});

check('stateToSearch -> seedFromParams is an exact round-trip (query-string form)', () => {
  ROUND_TRIP_CASES.forEach((s, i) => {
    assert.deepEqual(seedFromParams(`?${stateToSearch(s)}`, emptyState()), s, `case ${i}`);
  });
});

check('round-trip survives URLSearchParams as the carrier', () => {
  ROUND_TRIP_CASES.forEach((s, i) => {
    assert.deepEqual(seedFromParams(new URLSearchParams(stateToSearch(s)), emptyState()), s, `case ${i}`);
  });
});

check('dimension="" (over time) survives — it is a value, not an absence', () => {
  const s = base({ dimension: '' });
  const seeded = seedFromParams(stateToParams(s), base({ dimension: 'funnel', viz: 'bar' }));
  assert.equal(seeded.dimension, '');
});

check('a PARTIAL deep link keeps the base for everything it omits', () => {
  const b = base({ dimension: 'funnel', viz: 'bar', filters: { funnel_id: 'f_1' } });
  const seeded = seedFromParams({ metrics: 'gross_sales' }, b);
  assert.deepEqual(seeded.metrics, ['gross_sales']);
  assert.equal(seeded.dimension, 'funnel');
  assert.equal(seeded.filters.funnel_id, 'f_1');
});

check('a HOSTILE deep link is repaired, never trusted', () => {
  const seeded = seedFromParams(
    { metrics: 'sessions,orders,__proto__', dimension: 'product', viz: 'line', granularity: 'hour', gateway: 'bitcoin', country: 'ZZZZ' },
    emptyState(),
  );
  assert.deepEqual(seeded.metrics, ['orders']);
  assert.equal(seeded.dimension, 'product');
  assert.equal(seeded.viz, 'bar');
  assert.equal(seeded.filters.gateway, '');
  assert.equal(seeded.filters.country, '');
});

check('stateToSearch omits empty and mode-irrelevant params', () => {
  const q = new URLSearchParams(stateToSearch(base()));
  assert.equal(q.has('dimension'), false, 'empty dimension must not be emitted');
  assert.equal(q.has('compare'), false, 'compare=off must not be emitted');
  assert.equal(q.has('roas_dimension'), false, 'a ROAS param has no business on an Explore link');
  assert.equal(q.get('metrics'), 'net_sales,orders');

  const r = new URLSearchParams(stateToSearch(base({ mode: 'roas', roas_dimension: 'sub3', filters: { funnel_id: 'f_1' } })));
  assert.equal(r.get('roas_dimension'), 'sub3');
  assert.equal(r.has('metrics'), false, 'query metrics have no business on a ROAS link');
  assert.equal(r.has('viz'), false);
});

check('seedFromQuery applies a preset blob onto the current state', () => {
  const cur = base({ filters: { funnel_id: 'f_1' } });
  const seeded = seedFromQuery(
    { metrics: ['gross_sales', 'refunds'], dimension: 'source', viz: 'bar', compare: true, id: 'p_sales_by_source' },
    cur,
  );
  assert.deepEqual(seeded.metrics, ['gross_sales', 'refunds']);
  assert.equal(seeded.dimension, 'source');
  assert.equal(seeded.compare, true);
  assert.equal(seeded.report, 'p_sales_by_source');
  assert.equal(seeded.filters.funnel_id, 'f_1', 'the scoped funnel must survive a preset load');
});

/* ══ 9. HONESTY — null is an em dash, never 0 ═════════════════════════ */
section('9. honesty contract');

check('null / undefined / NaN / Infinity render as the em dash for every format', () => {
  ['gross_sales', 'orders', 'conv_pct', 'roas'].forEach((m) => {
    [null, undefined, NaN, Infinity, -Infinity].forEach((v) => {
      assert.equal(formatMetric(v, m), EM_DASH, `${m} <- ${String(v)}`);
    });
  });
});

check('a measured zero still renders as zero (0 is a fact)', () => {
  assert.equal(formatMetric(0, 'orders'), '0');
  assert.equal(formatMetric(0, 'conv_pct'), '0%');
  assert.equal(formatMetric(0, 'roas'), '0.00×');
  assert.ok(formatMetric(0, 'gross_sales').includes('0.00'));
});

check('conv_pct is unsigned (27.5 -> "27.5%", not "+27.5%")', () => {
  assert.equal(fmtPercent(27.5), '27.5%');
  assert.equal(fmtPercent(0.5), '0.5%');
});

check('roas prints as a multiple', () => {
  assert.equal(fmtMultiple(1.52), '1.52×');
});

check('sortRows puts nulls last in BOTH directions', () => {
  const rows = [{ v: 3 }, { v: null }, { v: 10 }, { v: undefined }, { v: 1 }];
  assert.deepEqual(sortRows(rows, 'v', 'desc').map((r) => r.v), [10, 3, 1, null, undefined]);
  assert.deepEqual(sortRows(rows, 'v', 'asc').map((r) => r.v), [1, 3, 10, null, undefined]);
});

/* ══ 10. CSV ═════════════════════════════════════════════════════════ */
section('10. CSV');

check('formula injection is neutralised and separators are quoted', () => {
  const csv = toCsv({
    columns: [{ key: 'key', label: 'Key' }, { key: 'v', label: 'Value' }],
    rows: [{ key: '=cmd|calc', v: 1 }, { key: 'a,b', v: null }, { key: 'say "hi"', v: 2 }],
  });
  const lines = csv.split('\r\n');
  assert.equal(lines[0], 'Key,Value');
  assert.equal(lines[1], "'=cmd|calc,1");
  assert.equal(lines[2], '"a,b",');
  assert.equal(lines[3], '"say ""hi""",2');
});

check('csvFilename is slugged, dated and mode-aware', () => {
  assert.equal(csvFilename(base()), 'explorer-net_sales-orders-by-day-2026-07-10_2026-08-08.csv');
  assert.equal(csvFilename(base({ dimension: 'source', viz: 'bar' })),
    'explorer-net_sales-orders-by-source-2026-07-10_2026-08-08.csv');
  assert.equal(csvFilename(base({ mode: 'roas', roas_dimension: 'sub3' })),
    'roas-sub3-2026-07-10_2026-08-08.csv');
});

/* ══ 11. labels ══════════════════════════════════════════════════════ */
section('11. labels');

check('the country dimension label can never read as traffic', () => {
  assert.match(DIMENSIONS.country.label, /order shipping/i);
  assert.equal(reportTitle(base({ metrics: ['gross_sales'], dimension: 'country', viz: 'bar' })),
    'Gross sales by Country (order shipping)');
});

check('both AOV bases are named in their labels', () => {
  assert.equal(reportTitle(base({ metrics: ['aov'], viz: 'line' })), 'AOV post-upsell over time');
  assert.equal(reportTitle(base({ metrics: ['aov_pre_upsell'], viz: 'line' })), 'AOV pre-upsell over time');
});

check('reportChips describe the view', () => {
  assert.deepEqual(reportChips(base()), ['2 metrics', 'by day', 'Line']);
  assert.deepEqual(reportChips(base({ dimension: 'funnel', viz: 'bar', metrics: ['orders'] })),
    ['1 metric', 'by Funnel', 'Bar']);
});

/* ══ summary ═════════════════════════════════════════════════════════ */
console.log(`\n${'═'.repeat(64)}`);
console.log(`PASS ${pass}   FAIL ${fail}`);
if (fail) {
  console.log('\nFAILURES:');
  failures.forEach((f) => console.log(`  • ${f}`));
  process.exit(1);
}
console.log('reportConfig harness green.');
