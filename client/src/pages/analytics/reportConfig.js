/**
 * reportConfig — the legality brain behind Analytics → Explore.
 *
 * TWO LAYERS, AND THE ORDER MATTERS.
 *
 *   1. THE SERVER'S MATRIX (authority). GET /funnel-metrics/definitions serves
 *      METRICS / DIMENSIONS / DIM_METRICS / HOUR_ONLY_EXCLUSIONS from the SAME
 *      frozen constants the engine validates against. setServerVocabulary()
 *      installs it and every predicate below then INTERSECTS with it.
 *   2. THE LOCAL TABLE (fallback cache). Transcribed from
 *      server/src/services/funnelMetrics.js @3e42a8e so the first paint — and
 *      any paint where /definitions is unreachable — greys the right chips.
 *
 * INTERSECTION, never union: a metric must be legal in BOTH to be offered. A
 * server that drops something removes it here; a local table that is stale can
 * only ever be too CONSERVATIVE, never too permissive. That asymmetry is the
 * whole design — the failure mode of a drifted client must be "a chip you have
 * to un-grey", not "a 422 on a control the UI said was enabled".
 *
 * The client is an optimisation. The engine refuses the same combinations
 * whether or not the client asked nicely.
 *
 * PURITY: every function here is pure EXCEPT for the one documented module
 * cache (`serverVocabulary`), which setServerVocabulary() writes and
 * resetServerVocabulary() clears so a harness can drive both states.
 *
 * TIMEZONE: there is NO hardcoded zone in this file's output. REPORT_TZ_FALLBACK
 * is what we assume until a response tells us otherwise; zoneLabel() and
 * formatInstant() take the zone as an argument, and the caller is expected to
 * pass the one the SERVER named (meta.timezone / window.timezone).
 *
 * HONESTY: null is not 0. Every formatter returns EM_DASH from format.js.
 */
import { EM_DASH, fmtInt, fmtMoney } from './format.js';

/* ── timezone ──────────────────────────────────────────────────────────── */

/**
 * What we assume BEFORE a response names the zone. It is a fallback, not a
 * fact: both engines resolve REPORT_TZ from env and echo it on every payload
 * (meta.timezone on /query, window.timezone on the attribution reads), and the
 * UI must print the echoed value once it has one.
 */
export const REPORT_TZ_FALLBACK = 'Europe/Madrid';

/** "Europe/Madrid" → "Madrid time"; anything else keeps its IANA name. */
export function zoneLabel(tz) {
  const z = String(tz || '').trim();
  if (!z) return '';
  if (z === 'Europe/Madrid') return 'Madrid time';
  if (z === 'UTC' || z === 'Etc/UTC') return 'UTC';
  return z;
}

/** Today's calendar day IN `tz`. Falls back to the host day if Intl refuses. */
export function todayInZone(tz = REPORT_TZ_FALLBACK) {
  try {
    return new Intl.DateTimeFormat('en-CA', {
      timeZone: tz, year: 'numeric', month: '2-digit', day: '2-digit',
    }).format(new Date());
  } catch {
    return new Date().toISOString().slice(0, 10);
  }
}

/**
 * Calendar day arithmetic on a YYYY-MM-DD string.
 * Done at UTC midnight ON PURPOSE: UTC has no DST, so "+1 day" is exactly one
 * calendar step. Adding 86_400_000 ms to a LOCAL instant lands on the same
 * date twice across a 25-hour day — the bug this shape exists to avoid.
 */
export function shiftDay(day, delta) {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(String(day || ''));
  if (!m) return '';
  const t = Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3])) + Number(delta || 0) * 86400000;
  const d = new Date(t);
  return Number.isNaN(d.getTime()) ? '' : d.toISOString().slice(0, 10);
}

export function daysAgoInZone(n, tz = REPORT_TZ_FALLBACK) {
  return shiftDay(todayInZone(tz), -Math.abs(Number(n) || 0));
}

/** "2026-08-09 14:05" in `tz`. Never a bare toISOString — that would be UTC. */
export function formatInstant(ts, tz = REPORT_TZ_FALLBACK) {
  if (!ts) return EM_DASH;
  const d = new Date(ts);
  if (Number.isNaN(d.getTime())) return EM_DASH;
  try {
    const parts = new Intl.DateTimeFormat('en-CA', {
      timeZone: tz, year: 'numeric', month: '2-digit', day: '2-digit',
      hour: '2-digit', minute: '2-digit', hourCycle: 'h23',
    }).formatToParts(d);
    const g = (t) => (parts.find((p) => p.type === t) || {}).value || '';
    const day = `${g('year')}-${g('month')}-${g('day')}`;
    return day.includes('undefined') ? d.toISOString().slice(0, 16).replace('T', ' ')
      : `${day} ${g('hour')}:${g('minute')}`;
  } catch {
    return d.toISOString().slice(0, 16).replace('T', ' ');
  }
}

/* ── metric vocabulary (labels + formats verbatim from METRIC_META) ─────── */

/**
 * `label`/`format` are the SERVER's, character for character. Two surfaces
 * printing different names for one metric is how a number stops meaning
 * anything, so the basis disambiguation that used to live in these labels
 * ("AOV post-upsell") now lives in `hint` — visible on hover, and unable to
 * disagree with the dashboard.
 *
 * `additive` and `group` are local presentation only; neither carries legality.
 */
export const METRICS = {
  /* — Sales — */
  orders: { key: 'orders', label: 'Orders', format: 'int', additive: true, group: 'Sales',
    hint: 'Paid sessions. A combined funnel order counts once; upsell charges never increment it.' },
  gross_sales: { key: 'gross_sales', label: 'Gross sales', format: 'money', additive: true, group: 'Sales' },
  net_sales: { key: 'net_sales', label: 'Net sales', format: 'money', additive: true, group: 'Sales',
    hint: 'Gross minus refunds, on the engine’s published identity.' },
  refunds: { key: 'refunds', label: 'Refunds', format: 'money', additive: true, group: 'Sales',
    hint: 'BASE orders only — upsell reversals are netted off Upsell revenue, not counted here.' },
  aov: { key: 'aov', label: 'AOV', format: 'money', additive: false, group: 'Sales',
    hint: 'POST-upsell: net sales ÷ orders, so upsell and rebill money is inside it.' },
  aov_pre_upsell: { key: 'aov_pre_upsell', label: 'AOV (pre-upsell)', format: 'money', additive: false, group: 'Sales',
    hint: 'The captured base only — what the front end took before any upsell leg.' },
  upsell_revenue: { key: 'upsell_revenue', label: 'Upsell revenue', format: 'money', additive: true, group: 'Sales',
    hint: 'Net of reversals. Not offered on a captured-base group-by: an upsell leg has no UTM of its own.' },
  upsell_take_pct: { key: 'upsell_take_pct', label: 'Upsell take rate', format: 'pct', additive: false, group: 'Sales' },

  /* — Traffic — */
  sessions: { key: 'sessions', label: 'Sessions', format: 'int', additive: true, group: 'Traffic',
    hint: 'Distinct lb_touches visitors per bucket. Withheld when the window crosses the touch retention.' },
  pageviews: { key: 'pageviews', label: 'Pageviews', format: 'int', additive: true, group: 'Traffic',
    hint: 'Page hits — a different unit from Sessions. Never read the two as one number.' },
  conv_pct: { key: 'conv_pct', label: 'Conversion rate', format: 'pct', additive: false, group: 'Traffic' },
  rev_per_session: { key: 'rev_per_session', label: '$/session', format: 'money', additive: false, group: 'Traffic' },

  /* — Customers — */
  new_customers: { key: 'new_customers', label: 'New customers', format: 'int', additive: true, group: 'Customers',
    hint: 'The e-mail’s first-ever paid session falls inside the window.' },
  returning_customers: { key: 'returning_customers', label: 'Returning customers', format: 'int', additive: true, group: 'Customers' },
  abandoned: { key: 'abandoned', label: 'Abandoned checkouts', format: 'int', additive: true, group: 'Customers',
    hint: 'Still `processing` after the 3600s grace — intent, not money.' },
  abandoned_rate: { key: 'abandoned_rate', label: 'Abandoned rate', format: 'pct', additive: false, group: 'Customers' },

  /* — Costs — */
  cogs: { key: 'cogs', label: 'COGS', format: 'money', additive: true, group: 'Costs' },
  ship_cost: { key: 'ship_cost', label: 'Shipping cost', format: 'money', additive: true, group: 'Costs' },
  fees: { key: 'fees', label: 'Processing fees', format: 'money', additive: true, group: 'Costs' },
  net_after_cogs: { key: 'net_after_cogs', label: 'Net after costs', format: 'money', additive: true, group: 'Costs',
    hint: 'Withheld (—) at zero cost coverage. A funnel with no costs entered never renders "100% margin".' },
  margin_pct: { key: 'margin_pct', label: 'Margin', format: 'pct', additive: false, group: 'Costs' },
  cost_coverage_pct: { key: 'cost_coverage_pct', label: 'Cost coverage', format: 'pct', additive: false, group: 'Costs',
    hint: 'How much of the cost side is actually known rather than guessed.' },

  /* — Ads — */
  spend: { key: 'spend', label: 'Ad spend', format: 'money', additive: true, group: 'Ads',
    hint: 'Funnel-bound through lb_campaign_map. There is no honest per-gateway or per-country split of a budget.' },
  roas: { key: 'roas', label: 'ROAS', format: 'ratio', additive: false, group: 'Ads' },
  cpa: { key: 'cpa', label: 'CPA', format: 'money', additive: false, group: 'Ads' },
  net_profit: { key: 'net_profit', label: 'Net profit', format: 'money', additive: false, group: 'Ads',
    hint: 'Net after costs minus ad spend.' },
};

export const METRIC_KEYS = Object.keys(METRICS);
export const METRIC_GROUPS = ['Sales', 'Traffic', 'Customers', 'Costs', 'Ads'];

/* Engine limits, verbatim. */
export const MAX_METRICS = 8;
export const MAX_BREAKDOWN_LIMIT = 200;
export const DEFAULT_BREAKDOWN_LIMIT = 50;
/** funnelAnalytics.parseWindow's contract, reused by both engines. */
export const MAX_WINDOW_DAYS = 400;
/** Lane 2: days <= 180 on /funnel-attribution/roas. */
export const MAX_ROAS_DAYS = 180;
/** Lane 2: limit <= 500 on /funnel-attribution/clicks. */
export const MAX_CLICKS_LIMIT = 500;

/* ── the legality matrix, transcribed from the engine ──────────────────── */

const BASE_MONEY = ['orders', 'gross_sales', 'net_sales', 'refunds', 'aov', 'aov_pre_upsell', 'upsell_revenue'];
// On a captured_base dimension the upsell legs are not attributable, so the
// two upsell-derived metrics are not offered there at all.
const CAPTURED_BASE_MONEY = ['orders', 'gross_sales', 'net_sales', 'refunds', 'aov'];
const TRAFFIC = ['sessions', 'pageviews', 'conv_pct', 'rev_per_session'];
const CUSTOMER = ['new_customers', 'returning_customers'];
const ABANDON = ['abandoned', 'abandoned_rate'];
const COST = ['cogs', 'ship_cost', 'fees', 'net_after_cogs', 'margin_pct', 'cost_coverage_pct'];
const SPEND = ['spend', 'roas', 'cpa', 'net_profit'];

/**
 * DIM_METRICS @3e42a8e. The three rules worth restating, because getting any
 * of them wrong is a wrong number rather than a missing one:
 *
 *  • SPEND rides `funnel` ONLY (and the timeseries). lb_ad_spend_daily binds
 *    to funnels through lb_campaign_map; a per-gateway or per-country ROAS
 *    would have to pro-rate a budget, which is a fabricated figure on the tile
 *    spend decisions are made from.
 *  • COST rides SESSION ATTRIBUTES only — funnel / page / country. A cost fold
 *    includes the upsell legs, so pairing it with a captured_base money figure
 *    divides one population by another.
 *  • `country` serves NO traffic at all: the key is the ORDER's shipping
 *    country, so no card built on it can be titled "Pageviews by country".
 */
export const DIM_METRICS = {
  __timeseries__: [...METRIC_KEYS],
  funnel: [...BASE_MONEY, ...TRAFFIC, ...CUSTOMER, ...ABANDON, ...COST, ...SPEND, 'upsell_take_pct'],
  page: [...BASE_MONEY, ...TRAFFIC, ...CUSTOMER, ...ABANDON, ...COST],
  country: [...BASE_MONEY, ...CUSTOMER, ...COST],
  gateway: [...CAPTURED_BASE_MONEY, ...CUSTOMER],
  source: [...CAPTURED_BASE_MONEY, ...TRAFFIC, ...CUSTOMER],
  campaign: [...CAPTURED_BASE_MONEY, ...TRAFFIC, ...CUSTOMER],
  referrer: [...CAPTURED_BASE_MONEY, ...TRAFFIC, ...CUSTOMER],
  landing_page: [...CAPTURED_BASE_MONEY, ...TRAFFIC, ...CUSTOMER],
  product: ['orders', 'gross_sales', 'aov'],
  device: [],
};

/**
 * `label` / `report_label` from DIMENSION_META @3e42a8e.
 *
 * ⚠️ ON A FUNNEL BREAKDOWN, `key` IS THE FUNNEL ID AND `label` IS ITS NAME.
 * The engine upgrades `label` to the resolved name (attachFunnelNames) and
 * leaves `key` as the id, so nothing downstream may treat the two as the same
 * string — a row is IDENTIFIED by key and READ by label.
 *
 * ⚠️ THERE IS DELIBERATELY NO `basis` HERE. The client used to carry its own
 * basis table and print it on the card; it disagreed with the engine on two
 * dimensions (it invented page→pageviews and country→gross), which is the
 * precise failure a basis label exists to prevent. The basis is now rendered
 * ONLY from meta.basis_label as it arrives on the response.
 */
export const DIMENSIONS = {
  funnel: { key: 'funnel', label: 'Funnel', report_label: 'Sales by funnel' },
  page: { key: 'page', label: 'Page', report_label: 'Sales by page' },
  product: { key: 'product', label: 'Product', report_label: 'Sales by product' },
  gateway: { key: 'gateway', label: 'Gateway', report_label: 'Sales by gateway' },
  source: { key: 'source', label: 'Source', report_label: 'Sales by UTM source' },
  campaign: { key: 'campaign', label: 'Campaign', report_label: 'Sales by campaign' },
  referrer: { key: 'referrer', label: 'Referrer', report_label: 'Sales by referrer' },
  landing_page: { key: 'landing_page', label: 'Landing page', report_label: 'Sales by landing page' },
  // NEVER "Pageviews by country" — this key is the ORDER's shipping country.
  country: { key: 'country', label: 'Country', report_label: 'Sales by country' },
  device: {
    key: 'device', label: 'Device', report_label: 'Sessions by device', unavailable: true,
    unavailable_reason:
      'lb_touches records no user-agent class, so mobile/tablet/desktop cannot be split '
      + 'without inventing it. Gated behind Lane 5 (operator decision).',
  },
};

export const DIMENSION_KEYS = Object.keys(DIMENSIONS);

export const GRANULARITIES = {
  day: { key: 'day', label: 'Day' },
  hour: { key: 'hour', label: 'Hour' },
  week: { key: 'week', label: 'Week' },
  month: { key: 'month', label: 'Month' },
};
export const GRANULARITY_KEYS = Object.keys(GRANULARITIES);

/**
 * HOUR_ONLY_EXCLUSIONS, verbatim from funnelMetrics.js@3e42a8e:392.
 *
 * These are DAY-KEYED at source and the engine now refuses them at
 * granularity=hour BEFORE any query runs, so this list is a mirror of a real
 * 422 rather than a client opinion:
 *   • spend / roas / cpa / net_profit — lb_ad_spend_daily has one row per DAY,
 *     and the fold drops it whole into the 00:00 bucket. An hourly line would
 *     draw the entire budget as a midnight spike.
 *   • the six COST metrics — an effective-dated cost rate is keyed to a day.
 *   • the customer split and the abandonment pair — both are computed against
 *     a day-scoped population.
 *
 * This list is REPLACED by the server's `hour_only_exclusions` as soon as
 * /definitions answers. It is written out here so the first paint is right,
 * not so it can disagree later.
 */
const LOCAL_HOUR_EXCLUSIONS = [
  'spend', 'roas', 'cpa', 'net_profit',
  'cogs', 'ship_cost', 'fees', 'net_after_cogs', 'margin_pct', 'cost_coverage_pct',
  'new_customers', 'returning_customers',
  'abandoned', 'abandoned_rate',
];

/* ── viz ───────────────────────────────────────────────────────────────── */

export const CHARTS = {
  line: { key: 'line', label: 'Line' },
  bar: { key: 'bar', label: 'Bar' },
  table: { key: 'table', label: 'Table' },
  'big-number': { key: 'big-number', label: 'Big number' },
};
export const CHART_KEYS = Object.keys(CHARTS);

/* ── modes + the Lane 2 vocabularies ───────────────────────────────────── */

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

/* ── the server vocabulary cache ───────────────────────────────────────── */

/**
 * The ONLY mutable state in this module. Written by setServerVocabulary() when
 * GET /funnel-metrics/vocabulary answers; every predicate reads it through
 * serverLegalSet() and intersects.
 */
let serverVocabulary = null;

/**
 * Install the engine's matrix. Shape (GET /funnel-metrics/definitions
 * @3e42a8e):
 *   {metrics:[{id,label,format,rate}],
 *    dimensions:[{id,label,report_label,basis,basis_label,legal_metrics[],
 *                 unavailable?,reason?,detail?}],
 *    dim_metrics:{__timeseries__:[], <dim>:[]},   ← the matrix, keyed
 *    hour_only_exclusions:[], max_window_days, timezone, granularities[],
 *    unavailable_dimensions:{}, basis_labels:{},
 *    limits{max_metrics,max_breakdown_limit,max_window_days,
 *           hour_requires_single_day}}
 *
 * `dim_metrics` is preferred because it is the matrix the engine validates
 * against directly; `dimensions[].legal_metrics` is read as a fallback for the
 * earlier /vocabulary spelling of the same payload.
 *
 * Returns true when a usable matrix was installed. A malformed payload is
 * REFUSED WHOLE rather than half-applied: a partially installed matrix greys
 * out chips for reasons nobody can reconstruct.
 */
export function setServerVocabulary(vocab) {
  const v = vocab && typeof vocab === 'object' && !Array.isArray(vocab) ? vocab : null;
  if (!v || !Array.isArray(v.metrics)) return false;

  const metrics = v.metrics
    .map((m) => (typeof m === 'string' ? m : String((m || {}).id || '')))
    .filter(Boolean);
  if (!metrics.length) return false;

  const dims = {};
  const unavailable = {};
  const labels = {};

  const keyed = v.dim_metrics && typeof v.dim_metrics === 'object' ? v.dim_metrics : null;
  if (keyed) {
    Object.keys(keyed).forEach((id) => {
      if (Array.isArray(keyed[id])) dims[id] = keyed[id].map(String);
    });
  }

  const dimList = Array.isArray(v.dimensions) ? v.dimensions : [];
  dimList.forEach((d) => {
    const spec = typeof d === 'string' ? { id: d } : (d || {});
    const id = String(spec.id || '');
    if (!id) return;
    if (!Array.isArray(dims[id]) && Array.isArray(spec.legal_metrics)) {
      dims[id] = spec.legal_metrics.map(String);
    }
    if (spec.unavailable) unavailable[id] = String(spec.detail || spec.reason || 'not collected');
    if (spec.label) labels[id] = { label: String(spec.label), report_label: String(spec.report_label || '') };
  });

  const ud = v.unavailable_dimensions && typeof v.unavailable_dimensions === 'object'
    ? v.unavailable_dimensions : {};
  Object.keys(ud).forEach((id) => {
    const spec = ud[id] || {};
    unavailable[id] = String(spec.detail || spec.reason || 'not collected');
  });

  if (!Object.keys(dims).length && !dimList.length) return false;

  const lim = v.limits && typeof v.limits === 'object' ? v.limits : {};
  const maxWindow = Number(v.max_window_days) > 0 ? Number(v.max_window_days)
    : (Number(lim.max_window_days) > 0 ? Number(lim.max_window_days) : MAX_WINDOW_DAYS);

  serverVocabulary = {
    metrics: new Set(metrics),
    dims,
    unavailable,
    labels,
    timeseries: Array.isArray(dims.__timeseries__) ? new Set(dims.__timeseries__)
      : (Array.isArray(v.timeseries_legal_metrics)
        ? new Set(v.timeseries_legal_metrics.map(String)) : new Set(metrics)),
    // The engine refuses these hourly regardless of dimension.
    hourExclusions: Array.isArray(v.hour_only_exclusions)
      ? new Set(v.hour_only_exclusions.map(String)) : new Set(LOCAL_HOUR_EXCLUSIONS),
    granularities: Array.isArray(v.granularities) ? v.granularities.map(String) : GRANULARITY_KEYS,
    maxMetrics: Number(lim.max_metrics) > 0 ? Number(lim.max_metrics) : MAX_METRICS,
    maxLimit: Number(lim.max_breakdown_limit) > 0 ? Number(lim.max_breakdown_limit) : MAX_BREAKDOWN_LIMIT,
    maxWindowDays: maxWindow,
    hourRequiresSingleDay: lim.hour_requires_single_day !== false,
    timezone: typeof v.timezone === 'string' && v.timezone ? v.timezone : '',
  };
  return true;
}

/** Drop back to the local table (used by the harness and on a failed fetch). */
export function resetServerVocabulary() { serverVocabulary = null; }

/** What the server said, or null. Read-only view for the UI (timezone, etc.). */
export function getServerVocabulary() { return serverVocabulary; }

export function maxMetrics() {
  return serverVocabulary ? serverVocabulary.maxMetrics : MAX_METRICS;
}
export function maxBreakdownLimit() {
  return serverVocabulary ? serverVocabulary.maxLimit : MAX_BREAKDOWN_LIMIT;
}

/** The engine's window cap, once it has named one. */
export function maxWindowDays() {
  return serverVocabulary ? serverVocabulary.maxWindowDays : MAX_WINDOW_DAYS;
}

/** The day-only metric set the engine refuses at granularity=hour. */
function hourExclusions() {
  return serverVocabulary ? serverVocabulary.hourExclusions : new Set(LOCAL_HOUR_EXCLUSIONS);
}

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

/** The engine's legal set for a dimension, or null when it hasn't spoken. */
function serverLegalSet(dimension) {
  if (!serverVocabulary) return null;
  if (!dimension) return serverVocabulary.timeseries;
  const list = serverVocabulary.dims[dimension];
  return Array.isArray(list) ? new Set(list) : new Set();
}

/** Is a dimension registered-but-unservable, per whoever is authoritative? */
export function dimensionUnavailable(dimension) {
  const d = str(dimension);
  if (!d) return '';
  if (serverVocabulary) {
    return serverVocabulary.unavailable[d] || '';
  }
  return (DIMENSIONS[d] || {}).unavailable ? DIMENSIONS[d].unavailable_reason : '';
}

/**
 * Does `dimension` define `metric`? '' (no dimension) = the timeseries.
 * INTERSECTION: legal locally AND legal server-side (when the server has
 * spoken). Fails closed on anything unknown.
 */
export function dimensionServes(dimension, metric) {
  if (!METRICS[metric]) return false;
  const dim = str(dimension);
  if (dim && !DIMENSIONS[dim]) return false;
  if (dim && dimensionUnavailable(dim)) return false;

  const local = DIM_METRICS[dim || '__timeseries__'];
  if (!Array.isArray(local) || !local.includes(metric)) return false;

  const remote = serverLegalSet(dim);
  if (remote && !remote.has(metric)) return false;
  if (serverVocabulary && !serverVocabulary.metrics.has(metric)) return false;
  return true;
}

/**
 * Metrics blocked by the granularity, INDEPENDENT of the dimension.
 *
 * The `!dimension &&` guard this used to carry was a hole: `granularity` stays
 * in the query body when a group-by is set, so a state of
 * {granularity: 'hour', dimension: 'funnel'} re-enabled every chip the hour
 * rule exists to block, and switching the group-by back to "over time" left
 * them selected.
 */
function granularityBlocks(metric, granularity) {
  return str(granularity) === 'hour' && hourExclusions().has(metric);
}

/** The metric menu for a dimension × granularity. */
export function legalMetrics(dimension, granularity = 'day') {
  const dim = str(dimension);
  if (dim && !DIMENSIONS[dim]) return [];
  return METRIC_KEYS.filter((m) => dimensionServes(dim, m) && !granularityBlocks(m, granularity));
}

/** Dimensions that serve EVERY selected metric — anything less is a 422. */
export function legalDimensions(metrics) {
  const list = Array.isArray(metrics) ? metrics.filter((m) => METRICS[m]) : [];
  return DIMENSION_KEYS.filter((d) => {
    if (dimensionUnavailable(d)) return false;
    return list.every((m) => dimensionServes(d, m));
  });
}

/**
 * Chart legality. `line` implies "over time"; only the ungrouped series is
 * ordered, and a line across gateways draws a slope between two unrelated
 * labels.
 */
export function legalCharts(dimension, metrics) {
  const grouped = !!str(dimension);
  void metrics;
  return CHART_KEYS.filter((c) => (c === 'line' ? !grouped : true));
}

/** `hour` is single-day only (else 422). */
export function legalGranularities(startDay, endDay) {
  const span = windowDays(startDay, endDay);
  const allowed = serverVocabulary ? serverVocabulary.granularities : GRANULARITY_KEYS;
  const singleDayOnly = serverVocabulary ? serverVocabulary.hourRequiresSingleDay : true;
  return GRANULARITY_KEYS.filter((g) => {
    if (!allowed.includes(g)) return false;
    return g === 'hour' && singleDayOnly ? span === 1 : true;
  });
}

/* ── block reasons (the disabled-control tooltips) ─────────────────────── */

export function metricBlockReason(metric, { dimension = '', granularity = 'day' } = {}) {
  if (!METRICS[metric]) return `Unknown metric "${str(metric) || EM_DASH}".`;
  const dim = str(dimension);
  const gone = dim && dimensionUnavailable(dim);
  if (gone) return gone;
  if (dim && !dimensionServes(dim, metric)) {
    return `${METRICS[metric].label} is not measured by ${(DIMENSIONS[dim] || {}).label || dim}.`;
  }
  if (!dim && serverVocabulary && !dimensionServes('', metric)) {
    return `${METRICS[metric].label} is not served by this deployment.`;
  }
  if (granularityBlocks(metric, granularity)) {
    return `${METRICS[metric].label} is day-keyed at source, so the engine refuses it hourly — a day of ad spend lands whole in the 00:00 bucket and would draw as a midnight spike.`;
  }
  return '';
}

export function dimensionBlockReason(dimension, metrics) {
  const dim = str(dimension);
  if (!dim) return '';
  if (!DIMENSIONS[dim]) return `Unknown group-by "${dim}".`;
  const gone = dimensionUnavailable(dim);
  if (gone) return gone;
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

/** A brand-new exploration: net sales + orders over time. */
export function emptyState(overrides) {
  return normalizeState({
    mode: 'query',
    report: '',
    metrics: DEFAULT_METRICS,
    dimension: '',
    granularity: 'day',
    viz: 'line',
    compare: false,
    limit: DEFAULT_BREAKDOWN_LIMIT,
    window: { start_day: '', end_day: '' },
    filters: { funnel_id: '', country: '', gateway: '', source: '' },
    roas_dimension: 'network',
    clicks_network: '',
    ...(overrides || {}),
  });
}

/**
 * Coerce anything into a complete, legal state. NEVER throws, never returns
 * null. Illegal choices are REPAIRED so a saved report or hand-edited URL still
 * opens instead of white-screening the tab.
 *
 * Repair ORDER is deliberate — window → granularity → dimension → metrics →
 * viz. Each step is the input to the next.
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
  if (dimension && dimensionUnavailable(dimension)) dimension = '';

  const grains = legalGranularities(window_.start_day, window_.end_day);
  let granularity = GRANULARITIES[str(c.granularity)] ? str(c.granularity) : 'day';
  if (!grains.includes(granularity)) granularity = 'day';

  const cap = maxMetrics();
  const allowed = legalMetrics(dimension, granularity);
  let metrics = Array.isArray(c.metrics) ? c.metrics.filter((m) => allowed.includes(m)) : [];
  metrics = Array.from(new Set(metrics)).slice(0, cap);
  if (!metrics.length) {
    metrics = DEFAULT_METRICS.filter((m) => allowed.includes(m));
    if (!metrics.length) metrics = allowed.slice(0, 1);
  }

  const charts = legalCharts(dimension, metrics);
  let viz = CHARTS[str(c.viz)] ? str(c.viz) : 'line';
  if (!charts.includes(viz)) viz = charts[0] || 'table';

  const rawFilters = c.filters && typeof c.filters === 'object' ? c.filters : {};
  // ISO-3166 alpha-2 or NOTHING, validated WHOLE and never truncated: slicing
  // "united states" to "UN" produces a well-formed filter that matches no rows,
  // and an empty result reads as "no sales there".
  const rawCountry = str(rawFilters.country).trim().toUpperCase();
  const filters = {
    // The engine caps these at idOf(...,N); over-long values are a 422, so they
    // are cut here to the SAME widths rather than sent to be refused.
    funnel_id: str(rawFilters.funnel_id).trim().slice(0, 64),
    country: /^[A-Z]{2}$/.test(rawCountry) ? rawCountry : '',
    gateway: GATEWAYS.includes(str(rawFilters.gateway)) ? str(rawFilters.gateway) : '',
    source: str(rawFilters.source).trim().slice(0, 120),
  };

  const limitCap = maxBreakdownLimit();
  let limit = Math.floor(Number(c.limit));
  if (!Number.isFinite(limit) || limit < 1) limit = DEFAULT_BREAKDOWN_LIMIT;
  if (limit > limitCap) limit = limitCap;

  return {
    mode,
    report: str(c.report).slice(0, 120),
    metrics,
    dimension,
    granularity,
    viz,
    compare: c.compare === true || c.compare === '1' || c.compare === 'true',
    limit,
    window: window_,
    filters,
    roas_dimension: ROAS_DIMENSIONS.includes(str(c.roas_dimension)) ? str(c.roas_dimension) : 'network',
    clicks_network: str(c.clicks_network).trim().slice(0, 60),
  };
}

/**
 * EXPLAIN what is wrong rather than repair it. This is the gate the fetch is
 * actually held behind — an invalid state must not reach the network.
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
    if (mode === 'query' && span > maxWindowDays()) {
      push('window', `That window is ${span} days — the engine caps a query at ${maxWindowDays()}.`);
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
  const cap = maxMetrics();
  if (!metrics.length) push('metrics', 'Pick at least one metric to explore.');
  if (metrics.length > cap) {
    push('metrics', `The engine takes at most ${cap} metrics; ${metrics.length} are selected.`);
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

  const limit = Number(c.limit);
  if (c.limit !== undefined && (!Number.isFinite(limit) || limit < 1 || limit > maxBreakdownLimit())) {
    push('limit', `Row limit must be 1..${maxBreakdownLimit()}.`);
  }

  return { valid: errors.length === 0, errors };
}

/* ── transport ─────────────────────────────────────────────────────────── */

/**
 * The Lane 1 MetricsQueryBody. ONE source for run + CSV + save + deep link.
 * Optional keys are OMITTED, not sent empty — `dimension: ""` and
 * `filters: {gateway: ""}` are allowlist misses server-side.
 */
export function buildQueryBody(state) {
  const s = normalizeState(state);
  const body = {
    metrics: s.metrics,
    window: { start_day: s.window.start_day, end_day: s.window.end_day },
    compare: s.compare,
    granularity: s.granularity,
    // Sent explicitly so the "Top N" footer on screen names the SAME cut the
    // engine applied, rather than a default the client is guessing at.
    limit: s.limit,
  };
  if (s.dimension) body.dimension = s.dimension;
  const f = {};
  ['funnel_id', 'country', 'gateway', 'source'].forEach((k) => {
    if (s.filters[k]) f[k] = s.filters[k];
  });
  if (Object.keys(f).length) body.filters = f;
  return body;
}

/** The URL vocabulary. Flat strings only. */
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
    limit: s.limit === DEFAULT_BREAKDOWN_LIMIT ? '' : String(s.limit),
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
    'granularity', 'viz', 'compare', 'limit', 'funnel_id', 'country', 'gateway', 'source'],
  roas: ['mode', 'report', 'start_day', 'end_day', 'funnel_id', 'roas_dimension'],
  clicks: ['mode', 'report', 'start_day', 'end_day', 'funnel_id', 'network'],
};

/** Every param this module owns — what a merge is allowed to delete. */
export const OWNED_PARAMS = Object.freeze(
  [...new Set(Object.values(MODE_PARAMS).flat())],
);

/**
 * Merge this state's params INTO an existing query string, preserving every
 * param we do not own.
 *
 * The previous version rebuilt the query string from scratch, which silently
 * deleted whatever else was on the URL — a host page's `tab=`, an inbound
 * `utm_source=`, a session marker. Owning a namespace is not owning the URL.
 */
export function mergeIntoSearch(state, existingSearch = '') {
  const s = normalizeState(state);
  const params = stateToParams(s);
  const keep = new Set(MODE_PARAMS[s.mode] || MODE_PARAMS.query);
  const raw = String(existingSearch || '');
  const usp = new URLSearchParams(raw.startsWith('?') ? raw.slice(1) : raw);
  OWNED_PARAMS.forEach((k) => usp.delete(k));
  keep.forEach((k) => { if (params[k]) usp.set(k, params[k]); });
  return usp.toString();
}

/** Just this state's params, with nothing else merged in. */
export function stateToSearch(state) {
  return mergeIntoSearch(state, '');
}

/**
 * Read the URL vocabulary back into a legal state. `base` supplies defaults for
 * anything the URL omits (a partial deep link is normal). Accepts a plain
 * object, a URLSearchParams or a query string.
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
  const metrics = rawMetrics
    ? String(rawMetrics).split(',').map((m) => m.trim()).filter(Boolean)
    : b.metrics;

  return normalizeState({
    mode: pick('mode', b.mode),
    report: pick('report', b.report),
    metrics,
    // '' is a MEANINGFUL dimension value (over time), so presence of the key is
    // the signal — it cannot fall back to the base the way the others do.
    dimension: get('dimension') === null || get('dimension') === undefined
      ? b.dimension : String(get('dimension')),
    granularity: pick('granularity', b.granularity),
    viz: pick('viz', b.viz),
    compare: get('compare') === null || get('compare') === undefined
      ? b.compare : (String(get('compare')) === '1' || String(get('compare')) === 'true'),
    limit: pick('limit', b.limit),
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
 * Apply a preset / saved-report query blob (the POST body plus the viz/mode
 * extras) onto a base state.
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
    limit: Number.isFinite(Number(q.limit)) && Number(q.limit) > 0 ? Number(q.limit) : b.limit,
    window: {
      start_day: str(w.start_day) || b.window.start_day,
      end_day: str(w.end_day) || b.window.end_day,
    },
    filters: {
      // A preset carries an EMPTY filters bag; it must not wipe the funnel the
      // page is scoped to.
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
  ratio: fmtMultiple,
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
  if (serverVocabulary && serverVocabulary.labels[d]) return serverVocabulary.labels[d].label;
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

/** Short chips for a saved-report card. */
export function reportChips(state) {
  const s = normalizeState(state);
  if (s.mode !== 'query') return [MODES[s.mode].label, s.mode === 'roas' ? `by ${s.roas_dimension}` : 'ledger'];
  return [
    `${s.metrics.length} metric${s.metrics.length === 1 ? '' : 's'}`,
    s.dimension ? `by ${dimensionLabel(s.dimension)}` : `by ${GRANULARITIES[s.granularity].label.toLowerCase()}`,
    CHARTS[s.viz].label,
  ];
}

/* ── CSV ───────────────────────────────────────────────────────────────── */

/**
 * Neutralise the spreadsheet-formula prefixes.
 *
 * TRIM, THEN TEST. Excel and Sheets skip leading whitespace, tabs, newlines and
 * a BOM before deciding a cell is a formula, so testing the RAW string lets
 * " =cmd|calc" and "\n=cmd|calc" through the guard untouched. The leading
 * newlines are also stripped outright: inside a quoted cell they are legal CSV
 * and survive the round trip into the very position the guard is checking.
 */
const csvCell = (v) => {
  const raw = v === null || v === undefined ? '' : String(v);
  const cleaned = raw.replace(/^[\r\n]+/, '');
  // \p{Cc} rather than a \u0000-\u001F range: the same set, written as a
  // Unicode property so no control-character escape sits in this source line.
  // \s already covers the tab/newline/NBSP/BOM cases.
  const probe = cleaned.replace(/^[\s\p{Cc}]+/u, '');
  const safe = /^[=+\-@]/.test(probe) ? `'${cleaned}` : cleaned;
  // A tab is quoted too: unquoted it survives the file but several importers
  // strip leading whitespace from a bare field, which would silently undo the
  // apostrophe guard above by moving the '=' back to column 1.
  return /[",\r\n\t]/.test(safe) ? `"${safe.replace(/"/g, '""')}"` : safe;
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

/** Trigger a browser download of `text`. No-op outside a browser. */
export function downloadCsv(filename, text) {
  if (typeof document === 'undefined' || typeof URL === 'undefined' || !URL.createObjectURL) return false;
  const url = URL.createObjectURL(new Blob([text], { type: 'text/csv;charset=utf-8' }));
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  a.click();
  URL.revokeObjectURL(url);
  return true;
}

/** "explorer-net_sales-orders-by-day-2026-07-10_2026-08-08.csv" */
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
