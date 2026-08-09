/**
 * reportConfig harness — the legality matrix (against the ENGINE's, not a
 * guess), the server-vocabulary intersection, state repair, validation, the URL
 * round-trip + merge, the query body and the honesty contract.
 *
 * Standalone: `node client/src/pages/analytics/explorer/tests/reportConfig.harness.mjs`
 *
 * THE MATRIX ASSERTIONS ARE TRANSCRIBED FROM THE SHIPPED SERVICE
 * (server/src/services/funnelMetrics.js @3e42a8e DIM_METRICS). An earlier
 * version of this file asserted a matrix I had invented — it passed 62/62 while
 * offering "ROAS by campaign" and "COGS by gateway", neither of which the
 * engine will answer. Assertions that only agree with their own subject prove
 * nothing.
 */
import assert from 'node:assert/strict';
import {
  CHART_KEYS, DEFAULT_BREAKDOWN_LIMIT, DIMENSIONS, DIMENSION_KEYS,
  MAX_BREAKDOWN_LIMIT, MAX_METRICS, MAX_ROAS_DAYS, MAX_WINDOW_DAYS, METRIC_KEYS,
  OWNED_PARAMS, REPORT_TZ_FALLBACK, buildQueryBody, chartBlockReason,
  csvFilename, daysAgoInZone, dimensionBlockReason, dimensionServes, emptyState,
  fmtMultiple, fmtPercent, formatInstant, formatMetric, granularityBlockReason,
  legalCharts, legalDimensions, legalGranularities, legalMetrics,
  maxBreakdownLimit, maxMetrics, mergeIntoSearch, metricBlockReason,
  normalizeState, reportChips, reportTitle, resetServerVocabulary,
  seedFromParams, seedFromQuery, setServerVocabulary, shiftDay, sortRows,
  stateToParams, stateToSearch, toCsv, todayInZone, validateQueryState,
  windowDays, zoneLabel,
} from '../../reportConfig.js';
import { EM_DASH } from '../../format.js';

let pass = 0;
let fail = 0;
const failures = [];

function check(name, fn) {
  try {
    resetServerVocabulary(); // every case starts on the local fallback table
    fn();
    pass += 1;
    console.log(`  PASS  ${name}`);
  } catch (e) {
    fail += 1;
    failures.push(`${name}: ${e.message}`);
    console.log(`  FAIL  ${name}\n        ${e.message}`);
  } finally {
    resetServerVocabulary();
  }
}
function section(t) { console.log(`\n── ${t} ${'─'.repeat(Math.max(0, 58 - t.length))}`); }

const W = { start_day: '2026-07-10', end_day: '2026-08-08' };
const base = (over) => normalizeState({
  mode: 'query', metrics: ['net_sales', 'orders'], dimension: '', granularity: 'day',
  viz: 'line', compare: false, window: W, filters: {}, ...(over || {}),
});

/* The ENGINE's DIM_METRICS, re-derived here from its own building blocks so a
   drift in reportConfig.js shows up as a diff rather than as agreement. */
const E_BASE_MONEY = ['orders', 'gross_sales', 'net_sales', 'refunds', 'aov', 'aov_pre_upsell', 'upsell_revenue'];
const E_CAPTURED = ['orders', 'gross_sales', 'net_sales', 'refunds', 'aov'];
const E_TRAFFIC = ['sessions', 'pageviews', 'conv_pct', 'rev_per_session'];
const E_CUSTOMER = ['new_customers', 'returning_customers'];
const E_ABANDON = ['abandoned', 'abandoned_rate'];
const E_COST = ['cogs', 'ship_cost', 'fees', 'net_after_cogs', 'margin_pct', 'cost_coverage_pct'];
const E_SPEND = ['spend', 'roas', 'cpa', 'net_profit'];
const ENGINE_MATRIX = {
  funnel: [...E_BASE_MONEY, ...E_TRAFFIC, ...E_CUSTOMER, ...E_ABANDON, ...E_COST, ...E_SPEND, 'upsell_take_pct'],
  page: [...E_BASE_MONEY, ...E_TRAFFIC, ...E_CUSTOMER, ...E_ABANDON, ...E_COST],
  country: [...E_BASE_MONEY, ...E_CUSTOMER, ...E_COST],
  gateway: [...E_CAPTURED, ...E_CUSTOMER],
  source: [...E_CAPTURED, ...E_TRAFFIC, ...E_CUSTOMER],
  campaign: [...E_CAPTURED, ...E_TRAFFIC, ...E_CUSTOMER],
  referrer: [...E_CAPTURED, ...E_TRAFFIC, ...E_CUSTOMER],
  landing_page: [...E_CAPTURED, ...E_TRAFFIC, ...E_CUSTOMER],
  product: ['orders', 'gross_sales', 'aov'],
  device: [],
};

/* ══ 1. THE MATRIX IS THE ENGINE'S ═══════════════════════════════════ */
section("1. matrix == funnelMetrics.js@3e42a8e");

check('every dimension matches the engine set exactly', () => {
  Object.keys(ENGINE_MATRIX).forEach((dim) => {
    const want = [...new Set(ENGINE_MATRIX[dim])].sort();
    // device is unavailable, so legalMetrics() empties it by a different route
    const got = dim === 'device' ? [] : legalMetrics(dim).slice().sort();
    assert.deepEqual(got, dim === 'device' ? [] : want, `dimension ${dim}`);
  });
});

check('the timeseries serves every metric', () => {
  assert.deepEqual(legalMetrics('', 'day'), METRIC_KEYS);
});

check('SPEND rides funnel ONLY — not source, not campaign, not gateway', () => {
  E_SPEND.forEach((m) => {
    assert.equal(dimensionServes('funnel', m), true, `funnel/${m}`);
    ['source', 'campaign', 'gateway', 'country', 'page', 'referrer', 'landing_page', 'product']
      .forEach((d) => assert.equal(dimensionServes(d, m), false, `${d}/${m}`));
  });
});

check('COST rides funnel / page / country only', () => {
  E_COST.forEach((m) => {
    ['funnel', 'page', 'country'].forEach((d) => assert.equal(dimensionServes(d, m), true, `${d}/${m}`));
    ['gateway', 'source', 'campaign', 'referrer', 'landing_page', 'product']
      .forEach((d) => assert.equal(dimensionServes(d, m), false, `${d}/${m}`));
  });
});

check('a captured-base dimension refuses the two upsell-derived metrics', () => {
  ['gateway', 'source', 'campaign', 'referrer', 'landing_page'].forEach((d) => {
    assert.equal(dimensionServes(d, 'upsell_revenue'), false, `${d}/upsell_revenue`);
    assert.equal(dimensionServes(d, 'aov_pre_upsell'), false, `${d}/aov_pre_upsell`);
  });
  assert.equal(dimensionServes('funnel', 'upsell_revenue'), true);
});

check('country serves money but NO traffic at all', () => {
  assert.equal(dimensionServes('country', 'gross_sales'), true);
  E_TRAFFIC.forEach((m) => assert.equal(dimensionServes('country', m), false, m));
  assert.match(metricBlockReason('pageviews', { dimension: 'country' }), /not measured by Country/);
});

check('product is line-priced: orders / gross_sales / aov and nothing else', () => {
  assert.deepEqual(legalMetrics('product').slice().sort(), ['aov', 'gross_sales', 'orders']);
  assert.equal(dimensionServes('product', 'net_sales'), false);
  assert.equal(dimensionServes('product', 'sessions'), false);
  assert.match(metricBlockReason('sessions', { dimension: 'product' }), /not measured by Product/);
});

check('device serves NOTHING and is excluded from legalDimensions (Lane 5)', () => {
  assert.deepEqual(legalMetrics('device'), []);
  assert.ok(!legalDimensions([]).includes('device'));
  assert.match(dimensionBlockReason('device', ['orders']), /user-agent class/);
});

check('legalDimensions narrows correctly as metrics are added', () => {
  assert.deepEqual(legalDimensions(['spend']), ['funnel']);
  assert.deepEqual(legalDimensions(['cogs']), ['funnel', 'page', 'country']);
  assert.ok(legalDimensions(['orders']).length > legalDimensions(['orders', 'spend']).length);
});

check('unknown metric / dimension fail CLOSED', () => {
  assert.equal(dimensionServes('funnel', 'made_up'), false);
  assert.equal(dimensionServes('', 'made_up'), false);
  assert.deepEqual(legalMetrics('nope'), []);
  assert.match(metricBlockReason('made_up'), /Unknown metric/);
  assert.match(dimensionBlockReason('nope', ['orders']), /Unknown group-by/);
});

check('every DIM_METRICS key has a DIMENSIONS entry', () => {
  DIMENSION_KEYS.forEach((d) => assert.ok(DIMENSIONS[d], d));
  assert.deepEqual(DIMENSION_KEYS.slice().sort(), Object.keys(ENGINE_MATRIX).slice().sort());
});

/* ══ 2. SERVER VOCABULARY INTERSECTION ══════════════════════════════ */
section('2. server vocabulary (authority) ∩ local table');

/** GET /funnel-metrics/definitions @3e42a8e, field for field. */
const VOCAB = {
  metrics: METRIC_KEYS.map((id) => ({ id, label: id, format: 'int' })),
  dimensions: DIMENSION_KEYS.map((id) => ({
    id,
    label: DIMENSIONS[id].label,
    report_label: DIMENSIONS[id].report_label,
    basis: id === 'product' ? 'line_items' : 'gross',
    basis_label: 'gross sales — captured base plus upsells',
    legal_metrics: ENGINE_MATRIX[id],
    ...(id === 'device' ? { unavailable: true, reason: 'device_not_collected', detail: 'no user-agent class on lb_touches' } : {}),
  })),
  dim_metrics: { __timeseries__: METRIC_KEYS, ...ENGINE_MATRIX },
  hour_only_exclusions: [
    'spend', 'roas', 'cpa', 'net_profit',
    'cogs', 'ship_cost', 'fees', 'net_after_cogs', 'margin_pct', 'cost_coverage_pct',
    'new_customers', 'returning_customers', 'abandoned', 'abandoned_rate',
  ],
  max_window_days: 400,
  granularities: ['day', 'hour', 'week', 'month'],
  unavailable_dimensions: { device: { unavailable: true, reason: 'device_not_collected', detail: 'no user-agent class on lb_touches' } },
  basis_labels: { gross: 'gross sales', captured_base: 'captured base only' },
  timezone: 'Europe/Madrid',
  limits: {
    max_metrics: 8, max_breakdown_limit: 200, max_window_days: 400,
    hour_requires_single_day: true,
  },
};

check('a well-formed vocabulary installs; a malformed one is refused whole', () => {
  assert.equal(setServerVocabulary(VOCAB), true);
  resetServerVocabulary();
  [null, undefined, {}, { metrics: [] }, { metrics: [{ id: 'orders' }] }, 'nope', 7]
    .forEach((bad, i) => assert.equal(setServerVocabulary(bad), false, `bad @${i}`));
});

check('dim_metrics is preferred over dimensions[].legal_metrics', () => {
  // The two disagree on purpose; dim_metrics is what the engine validates on.
  setServerVocabulary({
    ...VOCAB,
    dim_metrics: { ...VOCAB.dim_metrics, gateway: ['orders'] },
  });
  assert.deepEqual(legalMetrics('gateway'), ['orders']);
});

check('the older /vocabulary spelling still installs (no dim_metrics)', () => {
  const { dim_metrics: _drop, hour_only_exclusions: _drop2, ...older } = VOCAB;
  assert.equal(setServerVocabulary({ ...older, timeseries_legal_metrics: METRIC_KEYS }), true);
  assert.deepEqual(legalMetrics('product').slice().sort(), ['aov', 'gross_sales', 'orders']);
});

check('hour_only_exclusions from the server REPLACES the local list', () => {
  setServerVocabulary({ ...VOCAB, hour_only_exclusions: ['orders'] });
  const hourly = legalMetrics('', 'hour');
  assert.ok(!hourly.includes('orders'), 'the server said orders is day-only');
  assert.ok(hourly.includes('spend'), 'and it said spend is fine — the server wins');
});

check('max_window_days from the server drives validation', () => {
  // base() is a 30-day window, so a cap of 10 must refuse it and 400 must not.
  assert.equal(validateQueryState(base()).valid, true);
  setServerVocabulary({ ...VOCAB, max_window_days: 10, limits: { ...VOCAB.limits, max_window_days: 10 } });
  const v = validateQueryState(base());
  assert.equal(v.valid, false, 'a tightened server cap must be enforced');
  assert.ok(v.errors.some((e) => e.field === 'window' && /caps a query at 10/.test(e.message)),
    JSON.stringify(v.errors));
});

check('the server REMOVING a metric removes it here (intersection)', () => {
  setServerVocabulary({
    ...VOCAB,
    dim_metrics: { ...VOCAB.dim_metrics, funnel: ENGINE_MATRIX.funnel.filter((m) => m !== 'spend') },
  });
  assert.equal(dimensionServes('funnel', 'spend'), false, 'server dropped it, so we must too');
  assert.equal(dimensionServes('funnel', 'orders'), true);
});

check('the server ADDING a metric we do not know does NOT re-enable it', () => {
  setServerVocabulary({
    ...VOCAB,
    dim_metrics: { ...VOCAB.dim_metrics, gateway: [...ENGINE_MATRIX.gateway, 'spend'] },
  });
  assert.equal(dimensionServes('gateway', 'spend'), false,
    'intersection: the local table still says no, and that is the safe direction');
});

check('a server-declared unavailable dimension wins over the local table', () => {
  setServerVocabulary({
    ...VOCAB,
    unavailable_dimensions: {
      ...VOCAB.unavailable_dimensions,
      product: { unavailable: true, detail: 'product fold disabled on this deployment' },
    },
  });
  assert.deepEqual(legalMetrics('product'), []);
  assert.match(dimensionBlockReason('product', ['orders']), /disabled on this deployment/);
  assert.ok(!legalDimensions([]).includes('product'));
});

check('server limits replace the local ones', () => {
  assert.equal(maxMetrics(), MAX_METRICS);
  assert.equal(maxBreakdownLimit(), MAX_BREAKDOWN_LIMIT);
  setServerVocabulary({ ...VOCAB, limits: { max_metrics: 3, max_breakdown_limit: 25 } });
  assert.equal(maxMetrics(), 3);
  assert.equal(maxBreakdownLimit(), 25);
  const s = normalizeState({ ...base(), metrics: METRIC_KEYS.slice(0, 6), limit: 500 });
  assert.equal(s.metrics.length, 3);
  assert.equal(s.limit, 25);
});

check('installing the real matrix changes NOTHING (local table is in sync)', () => {
  const before = DIMENSION_KEYS.map((d) => legalMetrics(d).join(','));
  setServerVocabulary(VOCAB);
  const after = DIMENSION_KEYS.map((d) => legalMetrics(d).join(','));
  assert.deepEqual(after, before, 'the fallback cache has drifted from the engine');
});

/* ══ 3. GRANULARITY + CHART ═════════════════════════════════════════ */
section('3. granularity + chart legality');

check('hour is legal only on a single-day window', () => {
  assert.ok(legalGranularities('2026-08-08', '2026-08-08').includes('hour'));
  assert.ok(!legalGranularities('2026-08-07', '2026-08-08').includes('hour'));
  assert.match(granularityBlockReason('hour', '2026-08-01', '2026-08-08'), /single-day/);
  assert.equal(granularityBlockReason('hour', '2026-08-08', '2026-08-08'), '');
});

check('the hour block applies WITH a dimension too (the `!dim &&` hole)', () => {
  // The regression: granularity travels in the body regardless of dimension,
  // so gating it only on the timeseries let {hour, funnel} re-enable spend.
  assert.ok(!legalMetrics('funnel', 'hour').includes('spend'), 'spend must stay blocked under a group-by');
  assert.ok(legalMetrics('funnel', 'day').includes('spend'));
  assert.match(metricBlockReason('spend', { dimension: 'funnel', granularity: 'hour' }), /day-keyed at source/);
  assert.match(metricBlockReason('cogs', { dimension: 'funnel', granularity: 'hour' }), /day-keyed at source/);
});

check('the hour-blocked set is the engine\'s HOUR_ONLY_EXCLUSIONS, exactly', () => {
  // funnelMetrics.js@3e42a8e:392 — day-keyed at source, refused hourly with a
  // 422 regardless of dimension. Blocking MORE would hide working chips;
  // blocking LESS would offer a control the engine rejects.
  const ENGINE_HOUR_EXCLUSIONS = [
    ...E_SPEND, ...E_COST, ...E_CUSTOMER, ...E_ABANDON,
  ];
  const hourly = legalMetrics('', 'hour');
  ENGINE_HOUR_EXCLUSIONS.forEach((m) => assert.ok(!hourly.includes(m), `${m} must be blocked hourly`));
  assert.deepEqual(
    METRIC_KEYS.filter((m) => !hourly.includes(m)).sort(),
    [...new Set(ENGINE_HOUR_EXCLUSIONS)].sort(),
    'the client blocks a different hourly set from the engine',
  );
  // …and everything else IS honestly hourly.
  [...E_TRAFFIC, 'orders', 'gross_sales', 'net_sales', 'refunds', 'aov',
    'aov_pre_upsell', 'upsell_revenue', 'upsell_take_pct']
    .forEach((m) => assert.ok(hourly.includes(m), `${m} must NOT be blocked`));
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

/* ══ 4. TIMEZONE ════════════════════════════════════════════════════ */
section('4. timezone');

check('zoneLabel names Madrid and passes anything else through', () => {
  assert.equal(zoneLabel('Europe/Madrid'), 'Madrid time');
  assert.equal(zoneLabel('UTC'), 'UTC');
  assert.equal(zoneLabel('America/New_York'), 'America/New_York');
  assert.equal(zoneLabel(''), '');
  assert.equal(zoneLabel(null), '');
});

check('todayInZone is a real ISO day and follows the zone', () => {
  const madrid = todayInZone('Europe/Madrid');
  assert.match(madrid, /^\d{4}-\d{2}-\d{2}$/);
  // Auckland is ahead of Madrid, so its day is never EARLIER.
  assert.ok(todayInZone('Pacific/Auckland') >= madrid);
  assert.match(todayInZone('Not/AZone'), /^\d{4}-\d{2}-\d{2}$/, 'a bad zone must not throw');
});

check('shiftDay is calendar maths, DST-proof at the Madrid transitions', () => {
  // 2026-03-29 is a 23h day and 2026-10-25 a 25h day in Europe/Madrid. A
  // local-instant +86400000ms lands on the same date across one of them.
  assert.equal(shiftDay('2026-03-28', 1), '2026-03-29');
  assert.equal(shiftDay('2026-03-29', 1), '2026-03-30');
  assert.equal(shiftDay('2026-10-24', 1), '2026-10-25');
  assert.equal(shiftDay('2026-10-25', 1), '2026-10-26');
  assert.equal(shiftDay('2026-01-01', -1), '2025-12-31');
  assert.equal(shiftDay('nope', 1), '');
});

check('daysAgoInZone spans the right number of days', () => {
  const end = todayInZone(REPORT_TZ_FALLBACK);
  assert.equal(windowDays(daysAgoInZone(29, REPORT_TZ_FALLBACK), end), 30);
  assert.equal(windowDays(daysAgoInZone(0, REPORT_TZ_FALLBACK), end), 1);
});

check('formatInstant renders in the NAMED zone, not UTC', () => {
  const ts = '2026-08-09T23:30:00Z';
  // 23:30Z is 01:30 the NEXT day in Madrid — the exact case Lane 2 proves on.
  assert.equal(formatInstant(ts, 'Europe/Madrid'), '2026-08-10 01:30');
  assert.equal(formatInstant(ts, 'UTC'), '2026-08-09 23:30');
  assert.equal(formatInstant(null, 'UTC'), EM_DASH);
  assert.equal(formatInstant('not-a-date', 'UTC'), EM_DASH);
  assert.match(formatInstant(ts, 'Not/AZone'), /2026-08-09/, 'a bad zone must degrade, not throw');
});

/* ══ 5. STATE REPAIR ════════════════════════════════════════════════ */
section('5. state repair');

check('an illegal metric is dropped when the dimension cannot serve it', () => {
  const s = normalizeState({ ...base(), metrics: ['orders', 'sessions', 'aov'], dimension: 'product' });
  assert.deepEqual(s.metrics, ['orders', 'aov']);
});

check('dropping every metric falls back to a legal one, never to []', () => {
  const s = normalizeState({ ...base(), metrics: ['spend'], dimension: 'gateway' });
  assert.ok(s.metrics.length >= 1);
  s.metrics.forEach((m) => assert.equal(dimensionServes('gateway', m), true, m));
});

check('viz falls back from line to bar once a group-by is set', () => {
  assert.equal(normalizeState({ ...base(), dimension: 'funnel', viz: 'line' }).viz, 'bar');
});

check('more than MAX_METRICS is truncated, duplicates collapsed', () => {
  const many = METRIC_KEYS.slice(0, 12);
  const s = normalizeState({ ...base(), metrics: [...many, ...many] });
  assert.equal(s.metrics.length, MAX_METRICS);
  assert.equal(new Set(s.metrics).size, MAX_METRICS);
});

check('a reversed window is swapped, not rejected', () => {
  assert.deepEqual(
    normalizeState({ ...base(), window: { start_day: '2026-08-08', end_day: '2026-07-10' } }).window, W);
});

check('hour granularity on a multi-day window falls back to day', () => {
  assert.equal(normalizeState({ ...base(), granularity: 'hour' }).granularity, 'day');
});

check('the unavailable device dimension is repaired to over-time', () => {
  assert.equal(normalizeState({ ...base(), dimension: 'device' }).dimension, '');
});

check('a junk country filter is dropped rather than sent', () => {
  assert.equal(normalizeState({ ...base(), filters: { country: 'united states' } }).filters.country, '');
  assert.equal(normalizeState({ ...base(), filters: { country: 'ZZZZ' } }).filters.country, '');
  assert.equal(normalizeState({ ...base(), filters: { country: 'us' } }).filters.country, 'US');
});

check('an unknown gateway filter is dropped (allowlist miss = 422)', () => {
  assert.equal(normalizeState({ ...base(), filters: { gateway: 'bitcoin' } }).filters.gateway, '');
  assert.equal(normalizeState({ ...base(), filters: { gateway: 'whop' } }).filters.gateway, 'whop');
});

check('filter widths match the engine idOf() caps', () => {
  const s = normalizeState({ ...base(), filters: { funnel_id: 'f'.repeat(200), source: 's'.repeat(400) } });
  assert.equal(s.filters.funnel_id.length, 64, 'idOf(funnel_id, 64)');
  assert.equal(s.filters.source.length, 120, 'idOf(source, 120)');
});

check('limit defaults to 50 and clamps into 1..200', () => {
  assert.equal(normalizeState(base()).limit, DEFAULT_BREAKDOWN_LIMIT);
  assert.equal(normalizeState({ ...base(), limit: 0 }).limit, DEFAULT_BREAKDOWN_LIMIT);
  assert.equal(normalizeState({ ...base(), limit: -5 }).limit, DEFAULT_BREAKDOWN_LIMIT);
  assert.equal(normalizeState({ ...base(), limit: 'abc' }).limit, DEFAULT_BREAKDOWN_LIMIT);
  assert.equal(normalizeState({ ...base(), limit: 9999 }).limit, MAX_BREAKDOWN_LIMIT);
  assert.equal(normalizeState({ ...base(), limit: 10 }).limit, 10);
});

/* ══ 6. GARBAGE IN, LEGAL STATE OUT ═════════════════════════════════ */
section('6. garbage in, legal state out (never throws)');

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
    mergeIntoSearch(g, g); seedFromParams(g, g); seedFromQuery(g, g); csvFilename(g);
    reportTitle(g); reportChips(g); sortRows(g, 'x'); toCsv(g); windowDays(g, g);
    formatMetric(g, g); fmtPercent(g); fmtMultiple(g); zoneLabel(g); shiftDay(g, g);
    formatInstant(g, g); setServerVocabulary(g);
  });
});

/* ══ 7. VALIDATION ══════════════════════════════════════════════════ */
section('7. validation');

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
  const v = validateQueryState({ ...base(), metrics: ['spend'], dimension: 'gateway' });
  assert.equal(v.valid, false);
  assert.equal(v.errors.filter((e) => e.field === 'dimension').length, 1);
  assert.equal(v.errors.filter((e) => e.field === 'metrics').length, 0);
});

check(`a ${MAX_WINDOW_DAYS + 1}-day window is refused; ${MAX_WINDOW_DAYS} is fine`, () => {
  assert.equal(windowDays('2025-07-04', '2026-08-08'), MAX_WINDOW_DAYS + 1);
  assert.equal(windowDays('2025-07-05', '2026-08-08'), MAX_WINDOW_DAYS);
  const bad = validateQueryState({ ...base(), window: { start_day: '2025-07-04', end_day: '2026-08-08' } });
  assert.equal(bad.valid, false);
  assert.ok(bad.errors.some((e) => e.field === 'window' && /401 days/.test(e.message)), JSON.stringify(bad.errors));
  const ok = validateQueryState({ ...base(), window: { start_day: '2025-07-05', end_day: '2026-08-08' } });
  assert.equal(ok.valid, true, JSON.stringify(ok.errors));
});

check('a malformed or empty window is refused', () => {
  assert.equal(validateQueryState({ ...base(), window: { start_day: '2026-13-99', end_day: '2026-08-08' } }).valid, false);
  assert.equal(validateQueryState({ ...base(), window: { start_day: '2026-08-08', end_day: '2026-07-10' } }).valid, false);
});

check(`roas mode refuses a window over ${MAX_ROAS_DAYS} days and demands a funnel`, () => {
  const v = validateQueryState({ ...base(), mode: 'roas', window: { start_day: '2025-08-08', end_day: '2026-08-08' } });
  assert.equal(v.valid, false);
  assert.ok(v.errors.some((e) => e.field === 'window' && /180 days/.test(e.message)));
  assert.ok(v.errors.some((e) => e.field === 'funnel_id'));
  assert.equal(validateQueryState({ ...base(), mode: 'roas', filters: { funnel_id: 'f_1' } }).valid, true);
});

check('line + group-by is refused with the chart reason', () => {
  const v = validateQueryState({ ...base(), dimension: 'funnel', viz: 'line' });
  assert.equal(v.valid, false);
  assert.ok(v.errors.some((e) => e.field === 'viz'));
});

check('an out-of-range limit is refused', () => {
  assert.equal(validateQueryState({ ...base(), limit: 201 }).valid, false);
  assert.equal(validateQueryState({ ...base(), limit: 0 }).valid, false);
  assert.equal(validateQueryState({ ...base(), limit: 200 }).valid, true);
});

/* ══ 8. QUERY BODY ══════════════════════════════════════════════════ */
section('8. query body');

check('the body carries exactly the contract keys, omitting empties', () => {
  const body = buildQueryBody(base());
  assert.deepEqual(Object.keys(body).sort(), ['compare', 'granularity', 'limit', 'metrics', 'window']);
  assert.deepEqual(body.window, W);
  assert.equal(body.compare, false);
  assert.equal(body.limit, DEFAULT_BREAKDOWN_LIMIT, 'limit must be explicit so the footer can name the same cut');
});

check('dimension + filters appear only when set', () => {
  const body = buildQueryBody({
    ...base(), dimension: 'funnel', viz: 'bar',
    filters: { funnel_id: 'f_1', gateway: 'whop', country: 'us', source: '' },
  });
  assert.equal(body.dimension, 'funnel');
  assert.deepEqual(body.filters, { funnel_id: 'f_1', country: 'US', gateway: 'whop' });
  assert.ok(!('source' in body.filters), 'empty source must not be sent');
});

check('the body never carries viz / mode / report (server vocabulary only)', () => {
  const body = buildQueryBody({ ...base(), viz: 'table', report: 'preset_1' });
  ['viz', 'mode', 'report', 'roas_dimension', 'clicks_network'].forEach((k) => assert.ok(!(k in body), k));
});

/* ══ 9. URL ═════════════════════════════════════════════════════════ */
section('9. URL round-trip + merge');

const ROUND_TRIP_CASES = [
  base(),
  base({ dimension: 'funnel', viz: 'bar', compare: true, granularity: 'week' }),
  base({ metrics: ['gross_sales', 'refunds', 'aov'], dimension: 'gateway', viz: 'table', limit: 25 }),
  base({ window: { start_day: '2026-08-08', end_day: '2026-08-08' }, granularity: 'hour', metrics: ['orders'] }),
  base({ mode: 'roas', roas_dimension: 'sub7', filters: { funnel_id: 'f_42' } }),
  base({ mode: 'clicks', clicks_network: 'meta', filters: { funnel_id: 'f_42' } }),
  base({ filters: { funnel_id: 'f_9', country: 'DE', gateway: 'stripe', source: 'utm/with,comma' }, report: 'sales_by_funnel' }),
];

check('stateToParams -> seedFromParams round-trips exactly (object form)', () => {
  ROUND_TRIP_CASES.forEach((s, i) => {
    assert.deepEqual(seedFromParams(stateToParams(s), emptyState()), s, `case ${i}`);
  });
});

check('stateToSearch -> seedFromParams round-trips exactly (query-string form)', () => {
  ROUND_TRIP_CASES.forEach((s, i) => {
    assert.deepEqual(seedFromParams(`?${stateToSearch(s)}`, emptyState()), s, `case ${i}`);
  });
});

check('round-trip survives URLSearchParams as the carrier', () => {
  ROUND_TRIP_CASES.forEach((s, i) => {
    assert.deepEqual(seedFromParams(new URLSearchParams(stateToSearch(s)), emptyState()), s, `case ${i}`);
  });
});

check('mergeIntoSearch PRESERVES params we do not own', () => {
  const host = 'tab=reports&utm_source=newsletter&sid=abc123';
  const merged = new URLSearchParams(mergeIntoSearch(base({ dimension: 'funnel', viz: 'bar' }), `?${host}`));
  assert.equal(merged.get('tab'), 'reports', 'a host page param was deleted');
  assert.equal(merged.get('utm_source'), 'newsletter');
  assert.equal(merged.get('sid'), 'abc123');
  assert.equal(merged.get('dimension'), 'funnel');
});

check('mergeIntoSearch REPLACES the params we do own (no stale leftovers)', () => {
  const stale = 'metrics=sessions&dimension=source&compare=1&roas_dimension=sub9&tab=x';
  const merged = new URLSearchParams(mergeIntoSearch(base(), `?${stale}`));
  assert.equal(merged.get('metrics'), 'net_sales,orders');
  assert.equal(merged.has('dimension'), false, 'a stale dimension must not survive');
  assert.equal(merged.has('compare'), false, 'a stale compare must not survive');
  assert.equal(merged.has('roas_dimension'), false, 'mode-irrelevant params must not survive');
  assert.equal(merged.get('tab'), 'x');
});

check('OWNED_PARAMS is exactly what a merge deletes', () => {
  const all = OWNED_PARAMS.map((k) => `${k}=zz`).join('&');
  const merged = new URLSearchParams(mergeIntoSearch(base(), `?${all}&keep=me`));
  assert.equal(merged.get('keep'), 'me');
  OWNED_PARAMS.forEach((k) => {
    if (merged.has(k)) assert.notEqual(merged.get(k), 'zz', `${k} kept a stale value`);
  });
});

check('stateToSearch omits empty and mode-irrelevant params', () => {
  const q = new URLSearchParams(stateToSearch(base()));
  assert.equal(q.has('dimension'), false);
  assert.equal(q.has('compare'), false);
  assert.equal(q.has('roas_dimension'), false);
  assert.equal(q.has('limit'), false, 'the default limit is noise on the URL');
  assert.equal(q.get('metrics'), 'net_sales,orders');
  const r = new URLSearchParams(stateToSearch(base({ mode: 'roas', roas_dimension: 'sub3', filters: { funnel_id: 'f_1' } })));
  assert.equal(r.get('roas_dimension'), 'sub3');
  assert.equal(r.has('metrics'), false);
  assert.equal(r.has('viz'), false);
});

check('dimension="" survives — it is a value, not an absence', () => {
  const seeded = seedFromParams(stateToParams(base({ dimension: '' })), base({ dimension: 'funnel', viz: 'bar' }));
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
    { metrics: 'spend,orders,__proto__', dimension: 'gateway', viz: 'line', granularity: 'hour', gateway: 'bitcoin', country: 'ZZZZ', limit: '99999' },
    emptyState(),
  );
  assert.deepEqual(seeded.metrics, ['orders'], 'spend is illegal on gateway and must be dropped');
  assert.equal(seeded.dimension, 'gateway');
  assert.equal(seeded.viz, 'bar');
  assert.equal(seeded.filters.gateway, '');
  assert.equal(seeded.filters.country, '');
  assert.equal(seeded.limit, MAX_BREAKDOWN_LIMIT);
});

check('seedFromQuery applies a preset blob and keeps the scoped funnel', () => {
  const seeded = seedFromQuery(
    { metrics: ['gross_sales', 'refunds'], dimension: 'source', viz: 'bar', compare: true, id: 'sales_by_source', filters: {} },
    base({ filters: { funnel_id: 'f_1' } }),
  );
  assert.deepEqual(seeded.metrics, ['gross_sales', 'refunds']);
  assert.equal(seeded.dimension, 'source');
  assert.equal(seeded.compare, true);
  assert.equal(seeded.report, 'sales_by_source');
  assert.equal(seeded.filters.funnel_id, 'f_1', 'a preset must not wipe the page scope');
});

check('a REAL engine preset body loads without repair', () => {
  // funnelMetrics.js reportPresets(): sales_by_funnel
  const preset = {
    metrics: ['orders', 'net_sales', 'aov'], dimension: 'funnel', filters: {},
    window: { start_day: '2026-07-10', end_day: '2026-08-08' }, compare: true,
    granularity: 'day', limit: 50, id: 'sales_by_funnel',
  };
  const seeded = seedFromQuery(preset, emptyState());
  assert.deepEqual(seeded.metrics, preset.metrics, 'the engine promises every preset is legal');
  assert.equal(seeded.dimension, 'funnel');
  assert.equal(seeded.limit, 50);
});

/* ══ 10. HONESTY ════════════════════════════════════════════════════ */
section('10. honesty contract');

check('null / undefined / NaN / Infinity render as the em dash', () => {
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

check('roas uses the engine format class `ratio`', () => {
  assert.equal(formatMetric(1.52, 'roas'), '1.52×');
  assert.equal(fmtPercent(27.5), '27.5%');
});

check('sortRows puts nulls last in BOTH directions', () => {
  const rows = [{ v: 3 }, { v: null }, { v: 10 }, { v: undefined }, { v: 1 }];
  assert.deepEqual(sortRows(rows, 'v', 'desc').map((r) => r.v), [10, 3, 1, null, undefined]);
  assert.deepEqual(sortRows(rows, 'v', 'asc').map((r) => r.v), [1, 3, 10, null, undefined]);
});

/* ══ 11. CSV ════════════════════════════════════════════════════════ */
section('11. CSV');

check('formula injection is neutralised AFTER trimming, not before', () => {
  const csv = toCsv({
    columns: [{ key: 'key', label: 'Key' }, { key: 'v', label: 'Value' }],
    rows: [
      { key: '=cmd|calc', v: 1 },
      { key: ' =cmd|calc', v: 2 },      // leading space — the guard used to miss this
      { key: '\t@SUM(A1)', v: 3 },      // leading tab
      { key: '\n\r=cmd|calc', v: 4 },   // leading newlines inside a quoted cell
      { key: '﻿+1+1', v: 5 },      // BOM
      { key: 'a,b', v: null },
      { key: 'say "hi"', v: 6 },
      { key: 'harmless', v: 7 },
    ],
  });
  const lines = csv.split('\r\n');
  assert.equal(lines[0], 'Key,Value');
  assert.equal(lines[1], "'=cmd|calc,1");
  assert.equal(lines[2], "' =cmd|calc,2");
  assert.equal(lines[3], '"\'\t@SUM(A1)",3');
  assert.equal(lines[4], "'=cmd|calc,4", 'leading newlines must be stripped, then guarded');
  assert.equal(lines[5], "'﻿+1+1,5");
  assert.equal(lines[6], '"a,b",');
  assert.equal(lines[7], '"say ""hi""",6');
  assert.equal(lines[8], 'harmless,7', 'an innocent cell must not be mangled');
});

check('the roas / clicks export columns fold real Lane 2 rows', () => {
  const csv = toCsv({
    columns: [
      { key: 'key', label: 'key' }, { key: 'clicks', label: 'clicks' },
      { key: 'cost', label: 'cost' }, { key: 'roas', label: 'roas' },
      { key: 'cost_unknown_reason', label: 'cost_unknown_reason' },
    ],
    rows: [{ key: 'meta', clicks: 120, cost: null, roas: null, cost_unknown_reason: 'api_by_campaign_only' }],
  });
  assert.equal(csv.split('\r\n')[1], 'meta,120,,,api_by_campaign_only',
    'a null cost must export EMPTY, never 0');
});

check('csvFilename is slugged, dated and mode-aware', () => {
  assert.equal(csvFilename(base()), 'explorer-net_sales-orders-by-day-2026-07-10_2026-08-08.csv');
  assert.equal(csvFilename(base({ mode: 'roas', roas_dimension: 'sub3' })), 'roas-sub3-2026-07-10_2026-08-08.csv');
  assert.equal(csvFilename(base({ mode: 'clicks' })), 'click-ledger-2026-07-10_2026-08-08.csv');
});

/* ══ 12. LABELS ═════════════════════════════════════════════════════ */
section('12. labels');

check('labels are the ENGINE\'s, so two surfaces cannot name one metric twice', () => {
  assert.equal(reportTitle(base({ metrics: ['aov'], viz: 'line' })), 'AOV over time');
  assert.equal(reportTitle(base({ metrics: ['aov_pre_upsell'], viz: 'line' })), 'AOV (pre-upsell) over time');
  assert.equal(reportTitle(base({ metrics: ['conv_pct'], viz: 'line' })), 'Conversion rate over time');
});

check('the country report can never be titled as traffic', () => {
  assert.equal(DIMENSIONS.country.report_label, 'Sales by country');
  assert.equal(reportTitle(base({ metrics: ['gross_sales'], dimension: 'country', viz: 'bar' })),
    'Gross sales by Country');
  assert.equal(dimensionServes('country', 'pageviews'), false);
});

check('reportChips describe the view', () => {
  assert.deepEqual(reportChips(base()), ['2 metrics', 'by day', 'Line']);
  assert.deepEqual(reportChips(base({ dimension: 'funnel', viz: 'bar', metrics: ['orders'] })),
    ['1 metric', 'by Funnel', 'Bar']);
});

/* ══ summary ════════════════════════════════════════════════════════ */
console.log(`\n${'═'.repeat(64)}`);
console.log(`PASS ${pass}   FAIL ${fail}`);
if (fail) {
  console.log('\nFAILURES:');
  failures.forEach((f) => console.log(`  • ${f}`));
  globalThis.process?.exit(1);
}
console.log('reportConfig harness green.');
