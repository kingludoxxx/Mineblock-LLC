// metricsApi — the ONE place the analytics dashboard names a backend route
// (NEW FILE, LANE 3).
//
// CONTRACT-FIRST. Lanes 1 and 2 are building the server in parallel; the
// response shapes below are the binding ones from the analytics work order and
// nothing in this workspace may invent a key that is not in them. Every reader
// in this file is TOLERANT ON SHAPE and STRICT ON MEANING:
//
//   · tolerant on shape — a breakdown may land as a bare array or as
//     `{rows, basis, basis_label, total, rows_total}`; a series may land as an
//     array of points or as `{points:[…]}`. Both are read, neither is assumed.
//   · strict on meaning — `null` is WITHHELD and `undefined` is NOT SENT, and
//     the two are never collapsed into each other or into `0`. `?? 0` does not
//     appear anywhere in this workspace on a measured quantity: it is the one
//     line of code that turns "the server refused to claim this" into "we
//     measured zero", which on a money screen is a lie with a dollar sign on it.
//
// ── LANE 1 (server/src/routes/funnelMetrics.js) ──────────────────────────
//   GET  /funnel-metrics/dashboard ?start&end&funnel_id
//        -> { band:{live, unique_today,
//                   today:{orders, revenue, spend, net}, yesterday:{…}},
//             kpis:{ …metric keys…, previous:{…},
//                    upsell_lines:{aov_post, aov_pre, upsell_revenue,
//                                  take_rate, upsell_refunds} },
//             series:[POINT], prev_series:[POINT],
//               POINT = {day|hour, gross_sales, net_sales, orders,
//                        sessions, conv_pct}
//             breakdown_summary:{funnels, products, sources, campaigns,
//                                countries},   // each = BREAKDOWN
//             waterfall:{steps:[{key,label,value,…}]},
//             movers:[≤3],
//             window:{start, end, prev_start, prev_end, timezone:"UTC"},
//             meta:{computed_ms, rows_scanned, basis, basis_label,
//                   warnings:[], sessions_unknown?} }
//        BREAKDOWN = [ROW] | {rows:[ROW], basis, basis_label, total, rows_total}
//   POST /funnel-metrics/query           (Lane 4 owns the caller)
//   GET  /funnel-metrics/query.csv       (Lane 4 owns the caller)
//   GET  /funnel-metrics/presets         (Lane 4 owns the caller)
//
// ── LANE 2 (server/src/routes/funnelAttribution.js) ──────────────────────
//   GET  /funnel-attribution/marketing
//        ?start&end&funnel_id&dimension=campaign|source|referrer|landing_page&limit
//        -> { rows:[{key,label,orders,sales,bar_pct}],
//             totals:{orders, sales, rows_total},
//             basis:"captured_base", basis_label }
//
// Explicit `.js` extensions on the relative imports so the node harness in
// ./dashboard/__checks__ can import this module tree directly; Vite resolves
// them identically.
import api from '../../services/api.js';

export const METRICS_BASE = '/funnel-metrics';
export const ATTRIBUTION_BASE = '/funnel-attribution';

export const METRICS_ROUTES = {
  dashboard: `${METRICS_BASE}/dashboard`,
  query: `${METRICS_BASE}/query`,
  queryCsv: `${METRICS_BASE}/query.csv`,
  presets: `${METRICS_BASE}/presets`,
  marketing: `${ATTRIBUTION_BASE}/marketing`,
  roas: `${ATTRIBUTION_BASE}/roas`,
  clicks: `${ATTRIBUTION_BASE}/clicks`,
  spendDaily: `${ATTRIBUTION_BASE}/spend-daily`,
};

/**
 * The house envelope unwrap, done ONCE. Server routes in this repo answer
 * `{success:true, data:<payload>}`; a bare body passes through untouched, so a
 * second unwrap assumption cannot exist downstream (costsApi.js precedent).
 */
export const unwrap = (res) => res.data?.data ?? res.data;

/* ── the two fetches this page is allowed to make ────────────────────────── */

/** ONE composite. `signal` lets a superseded window abort instead of racing. */
export function fetchDashboard({ start, end, funnelId } = {}, { signal } = {}) {
  const params = { start, end };
  if (funnelId) params.funnel_id = funnelId;
  return api.get(METRICS_ROUTES.dashboard, { params, signal }).then(unwrap);
}

/** ONE attribution call. `dimension` defaults to the campaign bars. */
export function fetchMarketing(
  { start, end, funnelId, dimension = 'campaign', limit = 12 } = {},
  { signal } = {},
) {
  const params = { start, end, dimension, limit };
  if (funnelId) params.funnel_id = funnelId;
  return api.get(METRICS_ROUTES.marketing, { params, signal }).then(unwrap);
}

/* ── absent vs null vs zero ──────────────────────────────────────────────── */

/**
 * ABSENT vs NULL. `obj?.[k] ?? null` cannot tell "the server never sent this
 * key" from "the server sent it and the answer is unknown", and several
 * surfaces on this page turn on exactly that difference: a key that was never
 * sent means THIS BUILD DOES NOT REPORT IT (render nothing), while a key sent
 * as null means WE REFUSED TO CLAIM IT (render an em dash plus the reason).
 */
export const hasKey = (obj, k) =>
  !!obj && typeof obj === 'object' && Object.prototype.hasOwnProperty.call(obj, k);

/** True when a value was actually sent AND is not the withheld marker. */
export const present = (v) => v !== null && v !== undefined;

/* ── shape readers ───────────────────────────────────────────────────────── */

/**
 * A timeseries out of the composite. Accepts the array form and the
 * `{points:[…]}` form; anything else is an EMPTY series, never a fabricated
 * one. Points are handed back untouched — a `null` metric on a point is a day
 * that was not measured and must reach the chart as a hole.
 */
export function seriesOf(data, key = 'series') {
  const s = data ? data[key] : null;
  if (Array.isArray(s)) return s.filter(Boolean);
  if (s && Array.isArray(s.points)) return s.points.filter(Boolean);
  return [];
}

/** The bucket key of a series point — "2026-08-09" or "2026-08-09 14:00". */
export const bucketKeyOf = (p) =>
  (p && (p.day ?? p.hour ?? p.bucket ?? p.key ?? p.date)) || '';

/**
 * A breakdown, normalised to `{rows, basis, basis_label, total, rows_total}`.
 *
 * A BREAKDOWN WITHOUT A BASIS IS UNSHIPPABLE (work order, Lane 1 §6): the
 * "captured base only — upsell money has no UTM" caption has to be TRUE, so
 * `basis`/`basis_label` come off the wire or they are empty strings and the
 * caption is omitted entirely. An interpolated `undefined` in a disclaimer is
 * worse than no disclaimer.
 *
 * `total`/`rows_total` stay `null` when absent: they are the folded figure over
 * EVERY bucket (before the server's rank cut), and a card must not claim a
 * period total it cannot prove.
 */
export function breakdownOf(data, name) {
  const src = data && data.breakdown_summary ? data.breakdown_summary[name] : undefined;
  const out = { rows: [], basis: '', basis_label: '', total: null, rows_total: null, sent: false };
  if (src === null || src === undefined) return out;
  out.sent = true;
  if (Array.isArray(src)) {
    out.rows = src.filter(Boolean);
    return out;
  }
  if (typeof src !== 'object') return out;
  const rows = Array.isArray(src.rows) ? src.rows : Array.isArray(src.items) ? src.items : [];
  out.rows = rows.filter(Boolean);
  out.basis = typeof src.basis === 'string' ? src.basis : '';
  out.basis_label = typeof src.basis_label === 'string' ? src.basis_label : '';
  if (present(src.total)) out.total = Number(src.total);
  if (present(src.rows_total)) out.rows_total = Number(src.rows_total);
  return out;
}

/** Lane 2's marketing payload, normalised to the same vocabulary. */
export function marketingOf(mk) {
  const out = { rows: [], basis: '', basis_label: '', total: null, rows_total: null, orders: null };
  if (!mk || typeof mk !== 'object') return out;
  out.rows = Array.isArray(mk.rows) ? mk.rows.filter(Boolean) : [];
  out.basis = typeof mk.basis === 'string' ? mk.basis : '';
  out.basis_label = typeof mk.basis_label === 'string' ? mk.basis_label : '';
  const t = mk.totals && typeof mk.totals === 'object' ? mk.totals : null;
  if (t) {
    if (present(t.sales)) out.total = Number(t.sales);
    if (present(t.rows_total)) out.rows_total = Number(t.rows_total);
    if (present(t.orders)) out.orders = Number(t.orders);
  }
  return out;
}

/**
 * The KPI block. Lane 1 nests `previous` and `upsell_lines` INSIDE `kpis`; a
 * top-level `previous` is accepted too because that is the shape the reference
 * dashboard shipped. Nothing is defaulted: with no payload every accessor
 * answers `null`, which renders an em dash and not a zero.
 */
export function kpisOf(data) {
  const block = data && data.kpis && typeof data.kpis === 'object' ? data.kpis : null;
  const cur = block ? (block.kpis || block.current || block) : null;
  const prev = (block && block.previous) || (data && data.previous) || null;
  const upsell = (cur && cur.upsell_lines) || (block && block.upsell_lines)
    || (data && data.upsell_lines) || null;
  return { cur, prev, upsell };
}

/** The window block. `timezone` is printed verbatim — v1 computes AND prints UTC. */
export function windowOf(data) {
  const w = data && data.window && typeof data.window === 'object' ? data.window : {};
  return {
    start: w.start || '',
    end: w.end || '',
    prev_start: w.prev_start || '',
    prev_end: w.prev_end || '',
    timezone: w.timezone || '',
  };
}

/** `meta.warnings[]` — strings only, so a malformed entry cannot reach JSX. */
export function warningsOf(data) {
  const w = data && data.meta ? data.meta.warnings : null;
  return Array.isArray(w) ? w.filter((x) => typeof x === 'string' && x) : [];
}

/**
 * SESSIONS WITHHELD. Lane 1 §7 sets `sessions_unknown` when any day of the
 * window crosses the 90-day lb_touches TTL; sessions and every rate over them
 * are withheld for that window. Read from meta, with the reference payload's
 * `kpis.sessions_known` inversion as the fallback — and ONLY when that key was
 * actually sent, because an older build that does not report it is not the same
 * as one reporting "known".
 */
export function sessionsUnknownOf(data) {
  const meta = data && data.meta ? data.meta : null;
  if (hasKey(meta, 'sessions_unknown')) return !!meta.sessions_unknown;
  const { cur } = kpisOf(data);
  if (hasKey(cur, 'sessions_known')) return !cur.sessions_known;
  return false;
}

/* ── errors ──────────────────────────────────────────────────────────────── */

const API_ERRORS = {
  illegal_metric_dimension: 'That metric cannot be broken down by that dimension.',
  too_many_metrics: 'A report can carry at most eight metrics.',
  bad_granularity: 'Hourly granularity is only available on a single-day window.',
  bad_window: 'That date window is not valid.',
  window_too_long: 'The window is longer than the 400 days this report supports.',
  bad_day: 'The day must be a real YYYY-MM-DD date.',
  bad_dimension: 'That is not a dimension this report can break down by.',
};

/**
 * Error prose. Reads `{success:false, error:{code}}` first, then a bare
 * `{error:'…'}` (the shape the existing funnel-analytics routes answer with),
 * and falls back to plain prose. A raw machine code never reaches the operator.
 */
export function metricsApiError(err, fallback = 'The analytics API rejected that.') {
  if (err && (err.name === 'CanceledError' || err.code === 'ERR_CANCELED')) return null;
  const data = err && err.response ? err.response.data : null;
  const code = data && data.error && typeof data.error === 'object' ? data.error.code : null;
  if (typeof code === 'string' && API_ERRORS[code]) return API_ERRORS[code];
  if (data && typeof data.error === 'string' && data.error) return data.error;
  if (err && err.response && err.response.status === 403) {
    return 'You need funnels access to read analytics.';
  }
  if (err && err.response) return fallback;
  if (err && err.message) return `${fallback} (${err.message})`;
  return fallback;
}
