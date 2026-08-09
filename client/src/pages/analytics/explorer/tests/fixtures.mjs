/**
 * Fixtures shaped from the SHIPPED response builders, not from the docs.
 *
 *   Lane 1  server/src/services/funnelMetrics.js      @469ce45
 *             runQuery()  → {series|rows, totals, previous?, meta{...}}
 *   Lane 2  server/src/services/funnelAttribution.js  @fd52aac
 *             getRoas()   → {dimension, rows, totals, rows_total, row_cap,
 *                            basis, basis_label, cost_sources, window, meta}
 *             getClicks() → {rows, limit, truncated, timezone, meta}
 *
 * Every field name below appears in those files. Nothing is invented: a fixture
 * that agrees with the client instead of with the server is how a reader that
 * reads `result.clicks` (a key nothing emits) passes its own tests.
 */

/** POST /funnel-metrics/query — timeseries, compare on. */
export const QUERY_SERIES = {
  series: [
    { key: '2026-08-06', gross_sales: 1240.5, orders: 18, sessions: 900, conv_pct: 2 },
    // A withheld bucket: past the touch TTL, so sessions and every rate over
    // them are null — NOT zero. The chart must draw a gap here.
    { key: '2026-08-07', gross_sales: 980, orders: 14, sessions: null, conv_pct: null },
    { key: '2026-08-08', gross_sales: 1502.25, orders: 21, sessions: 1010, conv_pct: 2.08 },
  ],
  totals: { gross_sales: 3722.75, orders: 53, sessions: 1910, conv_pct: 2.04 },
  previous: {
    series: [
      { key: '2026-08-03', gross_sales: 1100, orders: 16, sessions: 870, conv_pct: 1.84 },
      { key: '2026-08-04', gross_sales: 1050, orders: 15, sessions: 880, conv_pct: 1.7 },
      { key: '2026-08-05', gross_sales: 1210, orders: 17, sessions: 905, conv_pct: 1.88 },
    ],
    totals: { gross_sales: 3360, orders: 48, sessions: 2655, conv_pct: 1.81 },
    window: { start_day: '2026-08-03', end_day: '2026-08-05' },
    aligned_by: 'index',
  },
  meta: {
    computed_ms: 214,
    rows_scanned: 5120,
    basis: 'gross',
    basis_label: 'gross sales — captured base plus upsells',
    timezone: 'Europe/Madrid',
    granularity: 'day',
    sessions_basis: 'distinct lb_touches.vid per day, summed (additive)',
    metrics: ['gross_sales', 'orders', 'sessions', 'conv_pct'],
    dimension: null,
    window: { start_day: '2026-08-06', end_day: '2026-08-08', days: 3 },
    warnings: [
      { source: 'lb_touches', reason: 'window reaches past the 90-day touch retention — sessions and every rate over them are withheld for the affected buckets' },
      { source: 'timezone', reason: 'window contains a daylight-saving transition in Europe/Madrid: 2026-10-25 is 25h', days: ['2026-10-25'] },
    ],
  },
};

/** POST /funnel-metrics/query — breakdown by gateway. */
export const QUERY_ROWS = {
  rows: [
    { key: 'stripe', label: 'stripe', orders: 30, net_sales: 2100.4, aov: 70.01 },
    { key: 'paypal', label: 'paypal', orders: 18, net_sales: 1204, aov: 66.89 },
    // A row whose ratio is withheld: no orders means AOV has no denominator.
    { key: '(none)', label: '(none)', orders: 0, net_sales: 0, aov: null },
  ],
  totals: { orders: 48, net_sales: 3304.4, aov: 68.84 },
  meta: {
    computed_ms: 96,
    rows_scanned: 1200,
    basis: 'captured_base',
    basis_label: 'captured base only — upsell money has no gateway, UTM or referrer of its own and is not in here',
    timezone: 'Europe/Madrid',
    granularity: 'day',
    metrics: ['orders', 'net_sales', 'aov'],
    dimension: 'gateway',
    window: { start_day: '2026-08-06', end_day: '2026-08-08', days: 3 },
    warnings: [],
  },
};

/**
 * GET /funnel-attribution/roas — every cost branch represented.
 * Note the WINDOW: `days` is what the caller sends, and the server answers a
 * window ENDING TODAY, which is why the header must print this and not the
 * picker.
 */
export const ROAS = {
  dimension: 'network',
  rows: [
    {
      key: 'meta', label: 'meta', clicks: 4820, bot_clicks: 311, conversions: 96,
      revenue: 8420.5, cost: 3100.25, cost_known: true, cost_source: 'meta_api',
      cost_unknown_reason: null,
      cost_note: 'platform spend plus non-meta ledger cpc in the same group',
      cpa: 32.29, roas: 2.72,
    },
    {
      key: 'tiktok', label: 'tiktok', clicks: 1990, bot_clicks: 40, conversions: 22,
      revenue: 1580, cost: 940, cost_known: true, cost_source: 'pin_manual',
      cost_unknown_reason: null, cost_note: null, cpa: 42.73, roas: 1.68,
    },
    {
      key: 'direct / none', label: 'direct / none', clicks: 0, bot_clicks: 0, conversions: 9,
      revenue: 610.75,
      // THE CASE THAT MATTERS: no cost signal ⇒ cost, cpa and roas are ALL
      // null. The table must render three em dashes, never $0.00 / 0.0×.
      cost: null, cost_known: false, cost_source: 'unknown',
      cost_unknown_reason: 'no_signal', cost_note: null, cpa: null, roas: null,
    },
    {
      key: 'google', label: 'google', clicks: 300, bot_clicks: 5, conversions: 4,
      revenue: 220, cost: null, cost_known: false, cost_source: 'unknown',
      cost_unknown_reason: 'api_by_campaign_only',
      cost_note: 'platform spend is campaign-granular; this group is finer',
      cpa: null, roas: null,
    },
  ],
  totals: {
    clicks: 7110, bot_clicks: 356, conversions: 131, revenue: 10831.25,
    cost: 4040.25, cost_known: true, cost_source: 'meta_api',
    cost_unknown_reason: null, cost_note: null, cpa: 30.84, roas: 2.68,
  },
  rows_total: 9,
  row_cap: true,
  basis: 'captured_base',
  basis_label: 'captured base only — upsell money has no gateway, UTM or referrer of its own and is not in here',
  cost_sources: ['meta_api', 'pin_manual', 'ledger', 'unknown'],
  window: { start: '2026-07-11', end: '2026-08-09', days: 30, timezone: 'Europe/Madrid' },
  meta: { computed_ms: 388, rows_scanned: 9 },
};

/** GET /funnel-attribution/clicks — `time`/`day`, bot + velocity flags. */
export const CLICKS = {
  rows: [
    {
      id: 9001, time: '2026-08-09T21:30:00.000Z', day: '2026-08-09',
      network: 'meta', click_id: 'fbclid_AAA111', click_key: 'fbclid',
      campaign: '120210000000123456', country: 'ES', device: 'mobile',
      cpc: 0.42, converted: true, converted_at: '2026-08-09T21:44:10.000Z',
      session_id: 'sess_1', bot: false, velocity_flag: false,
    },
    {
      // 23:30Z is the NEXT Madrid day — the exact instant Lane 2 proves its
      // day-keying on, and the case a UTC formatter dates one day early.
      id: 9002, time: '2026-08-09T23:30:00.000Z', day: '2026-08-10',
      network: 'tiktok', click_id: 'ttclid_BBB222', click_key: 'ttclid',
      campaign: '', country: 'FR', device: 'desktop',
      cpc: null, converted: false, converted_at: null,
      session_id: '', bot: true, velocity_flag: true,
    },
    {
      id: 9003, time: null, day: '2026-08-08',
      network: '', click_id: '', click_key: '', campaign: '', country: '',
      device: '', cpc: 0, converted: false, converted_at: null,
      session_id: '', bot: false, velocity_flag: false,
    },
  ],
  limit: 200,
  truncated: false,
  timezone: 'Europe/Madrid',
  meta: { computed_ms: 41, rows_scanned: 3 },
};

/** GET /funnel-metrics/vocabulary — the shape setServerVocabulary() reads. */
export function vocabulary(dimMatrix, metricKeys, dimensionMeta) {
  return {
    metrics: metricKeys.map((id) => ({ id, label: id, format: 'int' })),
    dimensions: Object.keys(dimMatrix).map((id) => ({
      id,
      label: (dimensionMeta[id] || {}).label || id,
      report_label: (dimensionMeta[id] || {}).report_label || '',
      legal_metrics: dimMatrix[id],
      ...(id === 'device'
        ? { unavailable: true, reason: 'device_not_collected', detail: 'lb_touches records no user-agent class' }
        : {}),
    })),
    timeseries_legal_metrics: metricKeys,
    granularities: ['day', 'hour', 'week', 'month'],
    limits: { max_metrics: 8, max_breakdown_limit: 200, hour_requires_single_day: true },
    timezone: 'Europe/Madrid',
    basis_labels: {
      gross: 'gross sales — captured base plus upsells',
      captured_base: 'captured base only — upsell money has no gateway, UTM or referrer of its own and is not in here',
    },
  };
}

/** Lane 2 refuses with a bare code and NO prose; Lane 1 sends code + message. */
export const LANE2_REFUSAL = { response: { status: 400, data: { error: 'invalid_days' } } };
export const LANE1_REFUSAL = {
  response: {
    status: 422,
    data: {
      error: 'illegal_metric_for_dimension',
      message: "metric(s) spend are not defined for dimension 'gateway'",
      detail: { dimension: 'gateway', illegal: ['spend'] },
    },
  },
};
