/**
 * reportConfig — the pure legality brain behind Analytics → Explorer.
 *
 * This is the CLIENT-SIDE mirror of the Lane 1 metrics engine's frozen
 * METRICS / DIMENSIONS / DIM_METRICS matrix. Its ONLY job is UX: a combination
 * the server would 422 must render as a DISABLED control with a reason on it,
 * not as a request that fails after a 250ms debounce with a generic toast.
 *
 * THE SERVER REMAINS THE AUTHORITY. Nothing here is a guarantee — it is a
 * courtesy. If this file and the engine ever disagree, the engine wins and the
 * 422 is surfaced verbatim. That is why every predicate below is written to
 * FAIL CLOSED on unknown input (an unknown metric is illegal everywhere, an
 * unknown dimension serves nothing) rather than to guess.
 *
 * Three concerns, all pure — no React, no network, no Date.now():
 *
 *   1. VOCABULARY + LEGALITY — METRICS/DIMENSIONS/DIM_METRICS and the
 *      legalMetrics / legalDimensions / legalCharts / legalGranularities
 *      predicates, each with a *_BlockReason twin that says WHY in operator
 *      language (the string becomes the disabled control's tooltip).
 *   2. NORMALISATION — normalizeState() takes anything (a URL someone edited,
 *      a saved report written by an older build, null) and returns a complete,
 *      legal state. It never throws: a report saved months ago must still open.
 *      validateQueryState() EXPLAINS rather than repairs, for the run gate.
 *   3. TRANSPORT — buildQueryBody() emits the Lane 1 MetricsQueryBody verbatim;
 *      stateToParams()/seedFromParams() are an exact round-trip over the URL
 *      vocabulary so a deep link reproduces the view.
 *
 * HONESTY (Conventions): null is NOT 0. Every formatter here returns EM_DASH
 * for null/undefined, imported from the existing analytics format.js so the
 * explorer and the dashboard can never print a missing number two ways.
 */
import { EM_DASH, fmtInt, fmtMoney } from './format.js';

/* ── metric vocabulary ─────────────────────────────────────────────────── */

/**
 * `format`   — which formatter renders it (money | int | pct | x).
 * `additive` — do the parts sum to the whole? A ratio does not, which is what
 *              stops a total/donut from printing "the average of averages".
 * `group`    — chip grouping only; carries no legality.
 * `hint`     — the chip tooltip. Where a metric's NAME could be read as a
 *              different quantity, the unit lives in the label, not the hint
 *              (see `aov` / `aov_pre_upsell`).
 */
export const METRICS = {
  /* — Sales — */
  orders: { key: 'orders', label: 'Orders', format: 'int', additive: true, group: 'Sales',
    hint: 'Paid sessions. A combined funnel order counts once; upsell charges never increment it.' },
  gross_sales: { key: 'gross_sales', label: 'Gross sales', format: 'money', additive: true, group: 'Sales' },
  net_sales: { key: 'net_sales', label: 'Net sales', format: 'money', additive: true, group: 'Sales',
    hint: 'Gross minus refunds, on the server’s published identity.' },
  refunds: { key: 'refunds', label: 'Refunds', format: 'money', additive: true, group: 'Sales',
    hint: 'BASE orders only — upsell reversals are netted off Upsell revenue, not counted here.' },
  // THE BASIS IS IN THE LABEL, both ways. Two AOV bases are reachable from one
  // screen and an unlabelled "AOV" that silently means one of them is how a
  // number stops meaning anything.
  aov: { key: 'aov', label: 'AOV post-upsell', format: 'money', additive: false, group: 'Sales' },
  aov_pre_upsell: { key: 'aov_pre_upsell', label: 'AOV pre-upsell', format: 'money', additive: false, group: 'Sales' },
  upsell_revenue: { key: 'upsell_revenue', label: 'Upsell revenue', format: 'money', additive: true, group: 'Sales' },
  upsell_take_pct: { key: 'upsell_take_pct', label: 'Upsell take %', format: 'pct', additive: false, group: 'Sales' },

  /* — Traffic — */
  sessions: { key: 'sessions', label: 'Sessions', format: 'int', additive: true, group: 'Traffic',
    hint: 'Distinct lb_touches visitors. Withheld when the window crosses the 90-day touch TTL.' },
  pageviews: { key: 'pageviews', label: 'Pageviews', format: 'int', additive: true, group: 'Traffic',
    hint: 'Page hits — a different unit from Sessions. Never read the two as one number.' },
  conv_pct: { key: 'conv_pct', label: 'Conversion %', format: 'pct', additive: false, group: 'Traffic' },
  rev_per_session: { key: 'rev_per_session', label: 'Revenue / session', format: 'money', additive: false, group: 'Traffic' },

  /* — Customers — */
  new_customers: { key: 'new_customers', label: 'New customers', format: 'int', additive: true, group: 'Customers',
    hint: 'The e-mail’s first-ever paid session falls inside the window.' },
  returning_customers: { key: 'returning_customers', label: 'Returning customers', format: 'int', additive: true, group: 'Customers' },
  abandoned: { key: 'abandoned', label: 'Abandoned', format: 'int', additive: true, group: 'Customers',
    hint: 'Sessions still in `processing` after the 3600s grace — intent, not money.' },
  abandoned_rate: { key: 'abandoned_rate', label: 'Abandoned rate', format: 'pct', additive: false, group: 'Customers' },

  /* — Costs — */
  cogs: { key: 'cogs', label: 'COGS', format: 'money', additive: true, group: 'Costs' },
  ship_cost: { key: 'ship_cost', label: 'Shipping cost', format: 'money', additive: true, group: 'Costs' },
  fees: { key: 'fees', label: 'Fees', format: 'money', additive: true, group: 'Costs' },
  net_after_cogs: { key: 'net_after_cogs', label: 'Net after costs', format: 'money', additive: true, group: 'Costs',
    hint: 'Withheld (—) at zero cost coverage. A funnel with no costs entered never renders "100% margin".' },
  margin_pct: { key: 'margin_pct', label: 'Margin %', format: 'pct', additive: false, group: 'Costs' },
  cost_coverage_pct: { key: 'cost_coverage_pct', label: 'Cost coverage %', format: 'pct', additive: false, group: 'Costs',
    hint: 'How much of the cost side is actually known rather than guessed.' },

  /* — Ads — */
  spend: { key: 'spend', label: 'Ad spend', format: 'money', additive: true, group: 'Ads' },
  roas: { key: 'roas', label: 'ROAS', format: 'x', additive: false, group: 'Ads' },
  cpa: { key: 'cpa', label: 'CPA', format: 'money', additive: false, group: 'Ads' },
  net_profit: { key: 'net_profit', label: 'Net profit', format: 'money', additive: true, group: 'Ads',
    hint: 'Net after costs minus ad spend.' },
};

export const METRIC_KEYS = Object.keys(METRICS);
export const METRIC_GROUPS = ['Sales', 'Traffic', 'Customers', 'Costs', 'Ads'];

/** The engine caps a query at 8 metrics (MetricsQueryBody: metrics[<=8]). */
export const MAX_METRICS = 8;

/* Legality building blocks — named sets so a change is one edit, not nine. */
const MONEY_METRICS = [
  'orders', 'gross_sales', 'net_sales', 'refunds', 'aov', 'aov_pre_upsell',
  'upsell_revenue', 'cogs', 'ship_cost', 'fees', 'net_after_cogs',
  'margin_pct', 'cost_coverage_pct',
];
// Ad money is keyed by lb_ad_spend_daily / lb_campaign_map, which only carry
// funnel / campaign / source keys. A "ROAS by gateway" would have to invent a
// denominator, so it is not on offer at all.
const AD_METRICS = ['spend', 'roas', 'cpa', 'net_profit'];
const CUSTOMER_METRICS = ['new_customers', 'returning_customers'];

/**
 * Which metrics are DEFINED per dimension. Unknown combos 422 server-side
 * BEFORE any query runs; this map is what greys the chip out first.
 *
 *  • product — line-priced. Keys on the line TITLE and returns before the
 *    upsell fold, so a cost metric here would be attributed to the wrong good
 *    and miss upsells entirely. Deliberately orders / gross_sales / aov only.
 *  • country — ORDER SHIPPING COUNTRY off co_sessions.customer. It is a
 *    property of a PAID ORDER, so it carries money and nothing else. There is
 *    no touch spine keyed by shipping country, which is exactly why this
 *    dimension can never title a card "Pageviews by country".
 *  • gateway — known only at payment time, so no traffic metrics.
 *  • device  — registered so the UI can show it as an explicit, named gap
 *    (Lane 5), never omitted silently. Serves nothing until then.
 */
export const DIM_METRICS = {
  funnel: [...MONEY_METRICS, ...AD_METRICS, ...CUSTOMER_METRICS,
    'sessions', 'pageviews', 'conv_pct', 'rev_per_session', 'upsell_take_pct',
    'abandoned', 'abandoned_rate'],
  page: ['pageviews', 'sessions', 'conv_pct', 'orders', 'gross_sales', 'aov', 'rev_per_session'],
  product: ['orders', 'gross_sales', 'aov'],
  gateway: [...MONEY_METRICS, ...CUSTOMER_METRICS],
  source: [...MONEY_METRICS, ...AD_METRICS, ...CUSTOMER_METRICS,
    'sessions', 'conv_pct', 'rev_per_session'],
  campaign: [...MONEY_METRICS, ...AD_METRICS, ...CUSTOMER_METRICS],
  referrer: [...MONEY_METRICS, ...CUSTOMER_METRICS, 'sessions', 'conv_pct', 'rev_per_session'],
  landing_page: ['pageviews', 'sessions', 'orders', 'gross_sales', 'aov', 'conv_pct', 'rev_per_session'],
  country: [...MONEY_METRICS, ...CUSTOMER_METRICS],
  device: [],
};

/**
 * `basis` is the phrase the engine stamps on this dimension's fold. It is
 * repeated in the UI verbatim so the "captured base only — upsell money has no
 * UTM" copy on screen is TRUE rather than decorative.
 */
export const DIMENSIONS = {
  funnel: { key: 'funnel', label: 'Funnel', basis: 'gross' },
  page: { key: 'page', label: 'Page', basis: 'pageviews' },
  product: { key: 'product', label: 'Product', basis: 'line_items' },
  gateway: { key: 'gateway', label: 'Gateway', basis: 'captured_base' },
  source: { key: 'source', label: 'Source', basis: 'captured_base' },
  campaign: { key: 'campaign', label: 'Campaign', basis: 'captured_base' },
  referrer: { key: 'referrer', label: 'Referrer', basis: 'captured_base' },
  landing_page: { key: 'landing_page', label: 'Landing page', basis: 'captured_base' },
  // The label carries the basis so no chart built on it can be titled
  // "Pageviews by country" — this dimension has no pageviews to give.
  country: { key: 'country', label: 'Country (order shipping)', basis: 'gross' },
  device: {
    key: 'device', label: 'Device', basis: '', unavailable: true,
    unavailable_reason: 'Device is not collected yet — lb_touches has no device column (Lane 5). Shown so the gap is named, never fabricated.',
  },
};

export const DIMENSION_KEYS = Object.keys(DIMENSIONS);

/* ── granularity ───────────────────────────────────────────────────────── */

export const GRANULARITIES = {
  day: { key: 'day', label: 'Day' },
  week: { key: 'week', label: 'Week' },
  month: { key: 'month', label: 'Month' },
  hour: { key: 'hour', label: 'Hour' },
};
export const GRANULARITY_KEYS = Object.keys(GRANULARITIES);

/**
 * Hour buckets are website-level money folds. Per-customer splits, the
 * abandonment grace window and DAILY ad spend (lb_ad_spend_daily has one row
 * per DAY) cannot be cut to an hour honestly, so they are day-granularity only.
 */
const HOUR_METRICS = new Set([
  'orders', 'gross_sales', 'net_sales', 'refunds', 'aov', 'aov_pre_upsell',
  'sessions', 'pageviews', 'conv_pct', 'rev_per_session', 'upsell_revenue',
  'cogs', 'ship_cost', 'fees', 'net_after_cogs', 'margin_pct', 'cost_coverage_pct',
]);

/* ── viz ───────────────────────────────────────────────────────────────── */

export const CHARTS = {
  line: { key: 'line', label: 'Line' },
  bar: { key: 'bar', label: 'Bar' },
  table: { key: 'table', label: 'Table' },
  'big-number': { key: 'big-number', label: 'Big number' },
};
export const CHART_KEYS = Object.keys(CHARTS);

/* ── modes + the two Lane 2 report vocabularies ────────────────────────── */

export const MODES = {
  query: { key: 'query', label: 'Explore' },
  roas: { key: 'roas', label: 'ROAS drilldown' },
  clicks: { key: 'clicks', label: 'Click ledger' },
};
export const MODE_KEYS = Object.keys(MODES);

export const ROAS_DIMENSIONS = [
  'network', 'campaign',
  'sub1', 'sub2', 'sub3', 'sub4', 'sub5', 'sub6', 'sub7', 'sub8', 'sub9', 'sub10',
];
export const GATEWAYS = ['whop', 'paypal', 'stripe', 'nmi'];

/** Lane 2: days <= 180 on /funnel-attribution/roas. */
export const MAX_ROAS_DAYS = 180;
/** Lane 2: limit <= 500 on /funnel-attribution/clicks. */
export const MAX_CLICKS_LIMIT = 500;
/** Lane 1 harness edge: a 401-day window is a 422, so 400 inclusive is the cap. */
export const MAX_WINDOW_DAYS = 400;

/* ── small pure helpers ────────────────────────────────────────────────── */

const str = (v, fallback = '') => (typeof v === 'string' ? v : fallback);
const isDay = (v) => /^\d{4}-\d{2}-\d{2}$/.test(str(v));

/** Inclusive day span, or null when either edge is not an ISO day. */
export function windowDays(startDay, endDay) {
  if (!isDay(startDay) || !isDay(endDay)) return null;
  const a = Date.parse(`${startDay}T00:00:00Z`);
  const b = Date.parse(`${endDay}T00:00:00Z`);
  if (!Number.isFinite(a) || !Number.isFinite(b)) return null;
  return Math.round((b - a) / 86400000) + 1;
}

/* ── legality ──────────────────────────────────────────────────────────── */

/** Does `dimension` define `metric`? '' (no dimension) = the over-time series. */
export function dimensionServes(dimension, metric) {
  if (!METRICS[metric]) return false;
  const dim = str(dimension);
  if (!dim) return true;
  const served = DIM_METRICS[dim];
  return Array.isArray(served) && served.includes(metric);
}

/**
 * The metric menu for a dimension × granularity.
 * Order follows METRIC_KEYS so the chip row never reshuffles under the cursor.
 */
export function legalMetrics(dimension, granularity = 'day') {
  const dim = str(dimension);
  if (dim && !DIMENSIONS[dim]) return [];
  const hourly = !dim && str(granularity) === 'hour';
  return METRIC_KEYS.filter((m) => dimensionServes(dim, m) && (!hourly || HOUR_METRICS.has(m)));
}

/** Dimensions that serve EVERY selected metric — anything less is a 422. */
export function legalDimensions(metrics) {
  const list = Array.isArray(metrics) ? metrics.filter((m) => METRICS[m]) : [];
  return DIMENSION_KEYS.filter((d) => {
    if (DIMENSIONS[d].unavailable) return false;
    return list.every((m) => dimensionServes(d, m));
  });
}

/**
 * Chart legality.
 *   • line — a line implies "over time"; only the ungrouped series is ordered.
 *            A line across gateways draws a slope between two unrelated labels.
 *   • bar / table / big-number — always fine.
 */
export function legalCharts(dimension, metrics) {
  const grouped = !!str(dimension);
  void metrics;
  return CHART_KEYS.filter((c) => (c === 'line' ? !grouped : true));
}

/**
 * Granularities legal for a window. `hour` is single-day only (else 422), and
 * granularity itself is meaningless once a dimension groups the rows.
 */
export function legalGranularities(startDay, endDay) {
  const span = windowDays(startDay, endDay);
  return GRANULARITY_KEYS.filter((g) => (g === 'hour' ? span === 1 : true));
}

/* ── block reasons (the disabled-control tooltips) ─────────────────────── */

/** '' when legal; otherwise the operator-language reason. */
export function metricBlockReason(metric, { dimension = '', granularity = 'day' } = {}) {
  if (!METRICS[metric]) return `Unknown metric "${str(metric) || EM_DASH}".`;
  const dim = str(dimension);
  if (dim && DIMENSIONS[dim] && DIMENSIONS[dim].unavailable) {
    return DIMENSIONS[dim].unavailable_reason;
  }
  if (dim && !dimensionServes(dim, metric)) {
    return `${METRICS[metric].label} is not measured by ${(DIMENSIONS[dim] || {}).label || dim}.`;
  }
  if (!dim && str(granularity) === 'hour' && !HOUR_METRICS.has(metric)) {
    return `${METRICS[metric].label} is day-granularity only — it cannot be cut to an hour honestly.`;
  }
  return '';
}

export function dimensionBlockReason(dimension, metrics) {
  const dim = str(dimension);
  if (!dim) return '';
  if (!DIMENSIONS[dim]) return `Unknown group-by "${dim}".`;
  if (DIMENSIONS[dim].unavailable) return DIMENSIONS[dim].unavailable_reason;
  const list = Array.isArray(metrics) ? metrics.filter((m) => METRICS[m]) : [];
  const missing = list.filter((m) => !dimensionServes(dim, m));
  if (!missing.length) return '';
  return `${DIMENSIONS[dim].label} does not measure ${missing.map((m) => METRICS[m].label).join(', ')}.`;
}

export function chartBlockReason(viz, dimension, metrics) {
  if (!CHARTS[str(viz)]) return `Unknown view "${str(viz) || EM_DASH}".`;
  if (legalCharts(dimension, metrics).includes(str(viz))) return '';
  return 'A line needs the over-time view — a group-by has no order to draw a slope along.';
}

export function granularityBlockReason(granularity, startDay, endDay) {
  const g = str(granularity);
  if (!GRANULARITIES[g]) return `Unknown granularity "${g || EM_DASH}".`;
  if (legalGranularities(startDay, endDay).includes(g)) return '';
  return 'Hourly buckets need a single-day window.';
}

/* ── state schema ──────────────────────────────────────────────────────── */

export const DEFAULT_METRICS = ['net_sales', 'orders'];

/** A brand-new exploration: net sales + orders over time, last 30 days. */
export function emptyState(overrides) {
  return normalizeState({
    mode: 'query',
    report: '',
    metrics: DEFAULT_METRICS,
    dimension: '',
    granularity: 'day',
    viz: 'line',
    compare: false,
    window: { start_day: '', end_day: '' },
    filters: { funnel_id: '', country: '', gateway: '', source: '' },
    roas_dimension: 'network',
    clicks_network: '',
    ...(overrides || {}),
  });
}

/**
 * Coerce anything into a complete, legal state. NEVER throws, never returns
 * null. Illegal choices are REPAIRED (not rejected) so a saved report or a
 * hand-edited URL still opens instead of white-screening the tab.
 *
 * Repair order matters and is deliberate: window → granularity → dimension →
 * metrics → viz. Each step is the input to the next, so repairing metrics
 * before the dimension settled would drop chips the final dimension serves.
 */
export function normalizeState(raw) {
  const c = raw && typeof raw === 'object' ? raw : {};

  const mode = MODES[str(c.mode)] ? str(c.mode) : 'query';

  const rawWindow = c.window && typeof c.window === 'object' ? c.window : {};
  const startDay = isDay(rawWindow.start_day) ? rawWindow.start_day : '';
  const endDay = isDay(rawWindow.end_day) ? rawWindow.end_day : '';
  // A reversed range is a typo, not a query. Swap rather than reject.
  const window_ = startDay && endDay && startDay > endDay
    ? { start_day: endDay, end_day: startDay }
    : { start_day: startDay, end_day: endDay };

  let dimension = DIMENSIONS[str(c.dimension)] ? str(c.dimension) : '';
  if (dimension && DIMENSIONS[dimension].unavailable) dimension = '';

  const grains = legalGranularities(window_.start_day, window_.end_day);
  let granularity = GRANULARITIES[str(c.granularity)] ? str(c.granularity) : 'day';
  if (!grains.includes(granularity)) granularity = 'day';

  const allowed = legalMetrics(dimension, granularity);
  let metrics = Array.isArray(c.metrics) ? c.metrics.filter((m) => allowed.includes(m)) : [];
  metrics = Array.from(new Set(metrics)).slice(0, MAX_METRICS);
  if (!metrics.length) {
    metrics = DEFAULT_METRICS.filter((m) => allowed.includes(m));
    if (!metrics.length) metrics = allowed.slice(0, 1);
  }

  const charts = legalCharts(dimension, metrics);
  let viz = CHARTS[str(c.viz)] ? str(c.viz) : 'line';
  if (!charts.includes(viz)) viz = charts[0] || 'table';

  const rawFilters = c.filters && typeof c.filters === 'object' ? c.filters : {};
  // ISO-3166 alpha-2 or NOTHING. It is deliberately validated WHOLE and never
  // truncated: slicing "united states" to "UN" or "ZZZZ" to "ZZ" would produce
  // a well-formed filter that matches no rows, and an empty result set reads
  // as "no sales there" rather than as "that filter is nonsense".
  const rawCountry = str(rawFilters.country).trim().toUpperCase();
  const filters = {
    funnel_id: str(rawFilters.funnel_id).trim(),
    country: /^[A-Z]{2}$/.test(rawCountry) ? rawCountry : '',
    gateway: GATEWAYS.includes(str(rawFilters.gateway)) ? str(rawFilters.gateway) : '',
    source: str(rawFilters.source).trim().slice(0, 120),
  };

  return {
    mode,
    report: str(c.report).slice(0, 120),
    metrics,
    dimension,
    granularity,
    viz,
    compare: c.compare === true || c.compare === '1' || c.compare === 'true',
    window: window_,
    filters,
    roas_dimension: ROAS_DIMENSIONS.includes(str(c.roas_dimension)) ? str(c.roas_dimension) : 'network',
    clicks_network: str(c.clicks_network).trim().slice(0, 60),
  };
}

/**
 * EXPLAIN what is wrong rather than repair it — this is what gates the run and
 * prints a reason. normalizeState() is what guarantees a stored blob loads.
 *
 * @returns {{valid: boolean, errors: {field: string, message: string}[]}}
 */
export function validateQueryState(raw) {
  const c = raw && typeof raw === 'object' ? raw : {};
  const errors = [];
  const push = (field, message) => errors.push({ field, message });

  const mode = str(c.mode) || 'query';
  if (!MODES[mode]) push('mode', `Unknown mode "${mode}".`);

  const w = c.window && typeof c.window === 'object' ? c.window : {};
  const start = str(w.start_day);
  const end = str(w.end_day);
  if (!isDay(start) || !isDay(end)) {
    push('window', 'Pick a start and an end day (YYYY-MM-DD).');
  } else if (start > end) {
    push('window', 'The start day is after the end day.');
  } else {
    const span = windowDays(start, end);
    if (mode === 'query' && span > MAX_WINDOW_DAYS) {
      push('window', `That window is ${span} days — the engine caps a query at ${MAX_WINDOW_DAYS}.`);
    }
    if (mode === 'roas' && span > MAX_ROAS_DAYS) {
      push('window', `ROAS drilldown reads at most ${MAX_ROAS_DAYS} days; that window is ${span}.`);
    }
  }

  if (mode !== 'query') {
    const filters = c.filters && typeof c.filters === 'object' ? c.filters : {};
    if (!str(filters.funnel_id).trim()) {
      push('funnel_id', 'This is a per-funnel report — pick a funnel first.');
    }
    if (mode === 'roas' && !ROAS_DIMENSIONS.includes(str(c.roas_dimension))) {
      push('roas_dimension', `Unknown ROAS group-by "${str(c.roas_dimension) || EM_DASH}".`);
    }
    return { valid: errors.length === 0, errors };
  }

  const metrics = Array.isArray(c.metrics) ? c.metrics.filter(Boolean) : [];
  if (!metrics.length) push('metrics', 'Pick at least one metric to explore.');
  if (metrics.length > MAX_METRICS) {
    push('metrics', `The engine takes at most ${MAX_METRICS} metrics; ${metrics.length} are selected.`);
  }
  if (new Set(metrics).size !== metrics.length) push('metrics', 'The same metric is selected twice.');

  const dimension = str(c.dimension);
  if (dimension && !DIMENSIONS[dimension]) {
    push('dimension', `Unknown group-by "${dimension}".`);
  } else {
    const reason = dimensionBlockReason(dimension, metrics);
    if (reason) push('dimension', reason);
  }

  metrics.forEach((m) => {
    if (!METRICS[m]) { push('metrics', `Unknown metric "${m}".`); return; }
    const reason = metricBlockReason(m, { dimension, granularity: c.granularity });
    // The dimension error above already says this; don't say it twice.
    if (reason && !(dimension && !dimensionServes(dimension, m))) push('metrics', reason);
  });

  const gReason = granularityBlockReason(c.granularity, start, end);
  if (gReason) push('granularity', gReason);

  const vReason = chartBlockReason(c.viz, dimension, metrics);
  if (vReason) push('viz', vReason);

  return { valid: errors.length === 0, errors };
}

/* ── transport ─────────────────────────────────────────────────────────── */

/**
 * The Lane 1 MetricsQueryBody. ONE source for run + CSV + save + deep link, so
 * the exported file and the chart on screen can never be different queries.
 *
 * Optional keys are OMITTED, not sent empty: `dimension: ""` and
 * `filters: {gateway: ""}` are both allowlist misses server-side.
 */
export function buildQueryBody(state) {
  const s = normalizeState(state);
  const body = {
    metrics: s.metrics,
    window: { start_day: s.window.start_day, end_day: s.window.end_day },
    compare: s.compare,
    granularity: s.granularity,
  };
  if (s.dimension) body.dimension = s.dimension;
  const f = {};
  ['funnel_id', 'country', 'gateway', 'source'].forEach((k) => {
    if (s.filters[k]) f[k] = s.filters[k];
  });
  if (Object.keys(f).length) body.filters = f;
  return body;
}

/**
 * The URL vocabulary. Flat strings only — this is what lands in the address bar
 * and what seedFromParams() must read back to the SAME state.
 */
export function stateToParams(state) {
  const s = normalizeState(state);
  return {
    mode: s.mode,
    report: s.report,
    metrics: s.metrics.join(','),
    dimension: s.dimension,
    start_day: s.window.start_day,
    end_day: s.window.end_day,
    granularity: s.granularity,
    viz: s.viz,
    compare: s.compare ? '1' : '',
    funnel_id: s.filters.funnel_id,
    country: s.filters.country,
    gateway: s.filters.gateway,
    source: s.filters.source,
    roas_dimension: s.roas_dimension,
    network: s.clicks_network,
  };
}

/** Params that belong to a mode. The others are noise in that mode's URL. */
const MODE_PARAMS = {
  query: ['mode', 'report', 'metrics', 'dimension', 'start_day', 'end_day',
    'granularity', 'viz', 'compare', 'funnel_id', 'country', 'gateway', 'source'],
  roas: ['mode', 'report', 'start_day', 'end_day', 'funnel_id', 'roas_dimension'],
  clicks: ['mode', 'report', 'start_day', 'end_day', 'funnel_id', 'network'],
};

/**
 * The address-bar form: only the params that carry a value AND belong to the
 * current mode. A `?roas_dimension=network` riding along on an Explore link is
 * noise the next reader has to decide to ignore.
 *
 * Dropping a param is safe precisely because seedFromParams() falls back to the
 * base state for anything absent, and everything dropped here is at its default
 * for that mode by construction.
 */
export function stateToSearch(state) {
  const s = normalizeState(state);
  const params = stateToParams(s);
  const keep = MODE_PARAMS[s.mode] || MODE_PARAMS.query;
  const usp = new URLSearchParams();
  keep.forEach((k) => { if (params[k]) usp.set(k, params[k]); });
  return usp.toString();
}

/**
 * Read the URL vocabulary back into a legal state. `base` supplies the
 * defaults for anything the URL omits (a partial deep link is normal).
 * Accepts a plain object, a URLSearchParams or a query string.
 */
export function seedFromParams(params, base) {
  let get;
  if (typeof params === 'string') {
    const usp = new URLSearchParams(params.startsWith('?') ? params.slice(1) : params);
    get = (k) => usp.get(k);
  } else if (params && typeof params.get === 'function') {
    get = (k) => params.get(k);
  } else if (params && typeof params === 'object') {
    get = (k) => (Object.prototype.hasOwnProperty.call(params, k) ? params[k] : null);
  } else {
    get = () => null;
  }

  const b = normalizeState(base);
  const pick = (k, fallback) => {
    const v = get(k);
    return v === null || v === undefined || v === '' ? fallback : String(v);
  };

  const rawMetrics = get('metrics');
  const metrics = rawMetrics ? String(rawMetrics).split(',').map((m) => m.trim()).filter(Boolean) : b.metrics;

  return normalizeState({
    mode: pick('mode', b.mode),
    report: pick('report', b.report),
    metrics,
    // '' is a MEANINGFUL dimension value (over time), so it cannot fall back to
    // the base the way the others do — presence of the key is the signal.
    dimension: get('dimension') === null || get('dimension') === undefined
      ? b.dimension : String(get('dimension')),
    granularity: pick('granularity', b.granularity),
    viz: pick('viz', b.viz),
    compare: get('compare') === null || get('compare') === undefined
      ? b.compare : (String(get('compare')) === '1' || String(get('compare')) === 'true'),
    window: { start_day: pick('start_day', b.window.start_day), end_day: pick('end_day', b.window.end_day) },
    filters: {
      funnel_id: pick('funnel_id', b.filters.funnel_id),
      country: pick('country', b.filters.country),
      gateway: pick('gateway', b.filters.gateway),
      source: pick('source', b.filters.source),
    },
    roas_dimension: pick('roas_dimension', b.roas_dimension),
    clicks_network: pick('network', b.clicks_network),
  });
}

/**
 * Apply a preset / saved-report query blob (the POST body shape plus the
 * viz/mode extras) onto a base state. Same normalisation, so a preset written
 * against an older vocabulary opens repaired rather than broken.
 */
export function seedFromQuery(query, base) {
  const q = query && typeof query === 'object' ? query : {};
  const b = normalizeState(base);
  const w = q.window && typeof q.window === 'object' ? q.window : {};
  const f = q.filters && typeof q.filters === 'object' ? q.filters : {};
  return normalizeState({
    ...b,
    mode: MODES[str(q.mode)] ? str(q.mode) : b.mode,
    report: str(q.report) || str(q.id) || b.report,
    metrics: Array.isArray(q.metrics) && q.metrics.length ? q.metrics : b.metrics,
    dimension: 'dimension' in q ? str(q.dimension) : b.dimension,
    granularity: str(q.granularity) || b.granularity,
    viz: str(q.viz) || b.viz,
    compare: typeof q.compare === 'boolean' ? q.compare : b.compare,
    window: {
      start_day: str(w.start_day) || b.window.start_day,
      end_day: str(w.end_day) || b.window.end_day,
    },
    filters: {
      funnel_id: str(f.funnel_id) || b.filters.funnel_id,
      country: str(f.country) || b.filters.country,
      gateway: str(f.gateway) || b.filters.gateway,
      source: str(f.source) || b.filters.source,
    },
    roas_dimension: str(q.roas_dimension) || b.roas_dimension,
  });
}

/* ── formatting ────────────────────────────────────────────────────────── */

const isNil = (v) => v === null || v === undefined
  || (typeof v === 'number' && !Number.isFinite(v));

/** A rate already stored AS a percentage (27.5 -> "27.5%"), never signed. */
export function fmtPercent(v, dp = 2) {
  if (isNil(v)) return EM_DASH;
  const n = Number(v);
  if (!Number.isFinite(n)) return EM_DASH;
  return `${Number(n.toFixed(dp))}%`;
}

/** A multiple (1.52 -> "1.52×"). */
export function fmtMultiple(v, dp = 2) {
  if (isNil(v)) return EM_DASH;
  const n = Number(v);
  if (!Number.isFinite(n)) return EM_DASH;
  return `${n.toFixed(dp)}×`;
}

const FORMATTERS = {
  money: fmtMoney,
  int: fmtInt,
  pct: fmtPercent,
  x: fmtMultiple,
};

export function formatterFor(metricKey) {
  const spec = METRICS[metricKey];
  return FORMATTERS[(spec && spec.format) || 'int'] || fmtInt;
}

export function formatMetric(value, metricKey) {
  return formatterFor(metricKey)(value);
}

export function labelFor(metricKey) {
  return (METRICS[metricKey] || {}).label || String(metricKey ?? EM_DASH);
}

export function dimensionLabel(dimension) {
  const d = str(dimension);
  if (!d) return 'Over time';
  return (DIMENSIONS[d] || {}).label || d;
}

/** "Net sales · Orders by Source" / "… over time" — the card heading. */
export function reportTitle(state) {
  const s = normalizeState(state);
  if (s.mode === 'roas') return `ROAS by ${s.roas_dimension}`;
  if (s.mode === 'clicks') return 'Click ledger';
  const names = s.metrics.map(labelFor).join(' · ');
  return s.dimension ? `${names} by ${dimensionLabel(s.dimension)}` : `${names} over time`;
}

/** Short chips for a saved-report card: "Explore · by Source · Line". */
export function reportChips(state) {
  const s = normalizeState(state);
  if (s.mode !== 'query') return [MODES[s.mode].label, s.mode === 'roas' ? `by ${s.roas_dimension}` : 'ledger'];
  return [
    `${s.metrics.length} metric${s.metrics.length === 1 ? '' : 's'}`,
    s.dimension ? `by ${dimensionLabel(s.dimension)}` : `by ${GRANULARITIES[s.granularity].label.toLowerCase()}`,
    CHARTS[s.viz].label,
  ];
}

/* ── client-side CSV (roas / clicks only — /query has a server .csv twin) ── */

const csvCell = (v) => {
  const s = v === null || v === undefined ? '' : String(v);
  // Guard the classic spreadsheet-formula injection on =,+,-,@ leading cells.
  const safe = /^[=+\-@\t\r]/.test(s) ? `'${s}` : s;
  return /[",\r\n]/.test(safe) ? `"${safe.replace(/"/g, '""')}"` : safe;
};

/** Raw (unformatted) CSV so the numbers stay machine-readable. */
export function toCsv(input) {
  const src = input && typeof input === 'object' ? input : {};
  const cols = Array.isArray(src.columns) ? src.columns : [];
  const list = Array.isArray(src.rows) ? src.rows : [];
  const head = cols.map((c) => csvCell(c.label ?? c.key)).join(',');
  const body = list.map((r) => cols.map((c) => csvCell(r ? r[c.key] : '')).join(','));
  return [head, ...body].join('\r\n');
}

/** "explorer-net_sales-by-source-2026-07-10_2026-08-08.csv" */
export function csvFilename(state) {
  const s = normalizeState(state);
  const parts = s.mode === 'query'
    ? ['explorer', s.metrics.join('-'), s.dimension ? `by-${s.dimension}` : `by-${s.granularity}`]
    : s.mode === 'roas' ? ['roas', s.roas_dimension] : ['click-ledger'];
  const span = s.window.start_day && s.window.end_day
    ? `${s.window.start_day}_${s.window.end_day}` : '';
  const slug = [...parts, span].filter(Boolean).join('-')
    .toLowerCase().replace(/[^a-z0-9_-]+/g, '-').replace(/^-|-$/g, '');
  return `${slug || 'report'}.csv`;
}

/** Sort rows by a column; nulls ALWAYS last, in both directions. */
export function sortRows(rows, key, direction = 'desc') {
  const list = Array.isArray(rows) ? [...rows] : [];
  const sign = direction === 'asc' ? 1 : -1;
  return list.sort((a, b) => {
    const av = a ? a[key] : null;
    const bv = b ? b[key] : null;
    if (isNil(av) && isNil(bv)) return 0;
    if (isNil(av)) return 1;
    if (isNil(bv)) return -1;
    if (typeof av === 'string' || typeof bv === 'string') {
      return sign * String(av).localeCompare(String(bv));
    }
    return sign * (Number(av) - Number(bv));
  });
}
