// insightsApi — the ONE place the insight layer names a backend route and the
// ONE place it names a payload key (NEW FILE, LANE 5).
//
// The sibling of ./metricsApi.js, written to the same rule and for the same
// reason: a reader written against a work order rather than against the shipped
// service DRIFTS SILENTLY, because a reader that finds nothing renders an em
// dash and an em dash is indistinguishable from an honest withholding. Every
// shape below was read out of server/src/services/funnelInsights.js and
// funnelCohorts.js, and the render harness runs against payloads CAPTURED from
// those services, so a renamed key fails loudly instead of dashing quietly.
//
// ── GET /funnel-insights/insights ?day&funnel_id ─────────────────────────────
//   {
//     day, timezone,
//     insights: [{ kind, severity: 'bad'|'warn'|'good'|'info',
//                  headline, prose,
//                  deep_link: { page: 'explorer'|'funnel_tracking',
//                               params: {metrics, start_day, end_day, funnel_id?} },
//                  evidence: {…} }],
//     detectors: [{ kind, ran, fired }],
//     last_60: { series:[{key, net_sales, orders, sessions, aov, spend, net_profit}],
//                metrics[], window:{start,end,days,timezone},
//                sessions_unknown, currency, mixed_currency },
//     baseline_window: {start, end, days, timezone},
//     thresholds: { <name>: {value, source, note} },
//     window: {start, end, days, timezone},
//     meta: { computed_ms, rows_scanned, timezone, max_cards, baseline_days,
//             window, degraded:[{source,reason}], warnings:[{source,reason}] },
//   }
//
//   ⚠️ `detectors` IS NOT DECORATION. A strip with two cards says nothing about
//   whether the other four detectors were quiet or broken, and those are
//   opposite facts. `ran:false` means the detector could not look; `fired:false`
//   means it looked and had nothing to say. The strip renders the difference.
//
//   ⚠️ `degraded` vs `warnings`. `degraded` is "a read or a detector fell over";
//   `warnings` is "the data cannot support this question". Both are shown and
//   they are NOT merged — one is our problem and one is the window's.
//
// ── GET /funnel-insights/cohorts ?start&end&funnel_id&group_by&horizons ──────
//   { range:{start,end,days,timezone,today}, group_by, horizons:[0,7,30,90],
//     cohorts:[{key, label, size, ltv[], retention[], aged[], revenue_to_date}],
//     average:{ltv[], retention[], aged[]},
//     totals:{buyers, cohorts, revenue_to_date, anonymous_paid_sessions, truncated},
//     basis, identity, meta:{…, warnings:[{source,reason}]} }
//
//   ⚠️ A NULL IN `ltv` / `retention` IS THE AGING GUARD, not a missing read: the
//   cohort has not lived long enough to reach that horizon. It renders an em
//   dash with that reason, and it must NEVER become $0.00 — "$0.00 at D90"
//   reads as "these customers came back with nothing", which is a claim about
//   customers nobody has observed yet.
//
// Explicit `.js` extensions on the relative imports so the node harnesses can
// import this module tree directly; Vite resolves them identically.
import api from '../../services/api.js';

export const INSIGHTS_BASE = '/funnel-insights';

export const INSIGHTS_ROUTES = {
  insights: `${INSIGHTS_BASE}/insights`,
  cohorts: `${INSIGHTS_BASE}/cohorts`,
  cohortsCsv: `${INSIGHTS_BASE}/cohorts.csv`,
  definitions: `${INSIGHTS_BASE}/definitions`,
};

/** The house envelope unwrap, done once (metricsApi precedent). */
const unwrap = (res) => res.data?.data ?? res.data;

const isObj = (v) => !!v && typeof v === 'object' && !Array.isArray(v);
export const hasKey = (obj, k) =>
  !!obj && typeof obj === 'object' && Object.prototype.hasOwnProperty.call(obj, k);
export const present = (v) => v !== null && v !== undefined;
const numOrNull = (v) => {
  if (v === null || v === undefined || v === '') return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
};
const str = (v) => (typeof v === 'string' ? v : '');

/* ── the fetches this layer is allowed to make ───────────────────────────── */

/** ONE insight composite. `signal` lets a superseded window abort. */
export function fetchInsights({ day, funnelId } = {}, { signal } = {}) {
  const params = {};
  if (day) params.day = day;
  if (funnelId) params.funnel_id = funnelId;
  return api.get(INSIGHTS_ROUTES.insights, { params, signal }).then(unwrap);
}

/** ONE cohort table. */
export function fetchCohorts(
  { start, end, funnelId, groupBy = 'day', horizons } = {}, { signal } = {},
) {
  const params = { group_by: groupBy };
  if (start) params.start = start;
  if (end) params.end = end;
  if (funnelId) params.funnel_id = funnelId;
  if (horizons) params.horizons = Array.isArray(horizons) ? horizons.join(',') : String(horizons);
  return api.get(INSIGHTS_ROUTES.cohorts, { params, signal }).then(unwrap);
}

/**
 * The CSV download URL.
 *
 * A URL rather than a fetch: the file is served with `Content-Disposition:
 * attachment`, so the browser's own download machinery is the right tool — and
 * pulling it through axios into a blob would mean holding the whole table in
 * memory and re-implementing the filename the server already chose.
 *
 * ⚠️ RELATIVE TO THE API BASE, built with URLSearchParams so a funnel id or a
 * group_by can never break out of the query string.
 */
export function cohortsCsvUrl({ start, end, funnelId, groupBy = 'day', horizons } = {}) {
  const p = new URLSearchParams({ group_by: groupBy });
  if (start) p.set('start', start);
  if (end) p.set('end', end);
  if (funnelId) p.set('funnel_id', funnelId);
  if (horizons) p.set('horizons', Array.isArray(horizons) ? horizons.join(',') : String(horizons));
  const base = str(api.defaults && api.defaults.baseURL).replace(/\/$/, '');
  return `${base}${INSIGHTS_ROUTES.cohortsCsv}?${p.toString()}`;
}

/* ── readers ─────────────────────────────────────────────────────────────── */

export const SEVERITY_RANK = Object.freeze({ bad: 0, warn: 1, good: 2, info: 3 });
const SEVERITIES = Object.freeze(['bad', 'warn', 'good', 'info']);

/**
 * The insight payload, normalised.
 *
 * TOLERANT ON SHAPE, STRICT ON MEANING. A card missing its prose is dropped
 * rather than rendered as a headline with an empty body; an unknown severity
 * falls back to 'info' rather than to a colour class that does not exist. What
 * is NOT tolerated is inventing a card, a count or a threshold.
 */
export function insightsOf(payload) {
  const out = {
    sent: false,
    day: '',
    timezone: '',
    cards: [],
    detectors: [],
    thresholds: null,
    baselineWindow: null,
    warnings: [],
    degraded: [],
    computedMs: null,
  };
  if (!isObj(payload)) return out;
  out.sent = true;
  out.day = str(payload.day);
  out.timezone = str(payload.timezone);

  const list = Array.isArray(payload.insights) ? payload.insights : [];
  out.cards = list.filter(isObj).map((c) => ({
    kind: str(c.kind) || 'insight',
    severity: SEVERITIES.includes(c.severity) ? c.severity : 'info',
    headline: str(c.headline),
    prose: str(c.prose),
    deepLink: isObj(c.deep_link) && str(c.deep_link.page)
      ? { page: str(c.deep_link.page), params: isObj(c.deep_link.params) ? c.deep_link.params : {} }
      : null,
    evidence: isObj(c.evidence) ? c.evidence : {},
  })).filter((c) => c.headline && c.prose);

  out.detectors = (Array.isArray(payload.detectors) ? payload.detectors : [])
    .filter(isObj)
    .map((d) => ({
      kind: str(d.kind),
      // TRI-STATE, deliberately. `ran` absent is not `ran:false` — a build that
      // does not report it has not told us the detector was blind.
      ran: hasKey(d, 'ran') ? d.ran === true : null,
      fired: hasKey(d, 'fired') ? d.fired === true : null,
    }))
    .filter((d) => d.kind);

  out.thresholds = isObj(payload.thresholds) ? payload.thresholds : null;
  out.baselineWindow = isObj(payload.baseline_window) ? payload.baseline_window : null;
  const meta = isObj(payload.meta) ? payload.meta : null;
  out.warnings = normaliseNotes(meta ? meta.warnings : null);
  out.degraded = normaliseNotes(meta ? meta.degraded : null);
  out.computedMs = meta ? numOrNull(meta.computed_ms) : null;
  return out;
}

/** The 60-day block, or an explicitly EMPTY one. Never a fabricated series. */
export function lastNOf(payload) {
  const src = isObj(payload) && isObj(payload.last_60) ? payload.last_60 : null;
  const out = {
    sent: false, series: [], metrics: [], window: null,
    sessionsUnknown: false, currency: '', mixedCurrency: false,
  };
  if (!src) return out;
  out.sent = true;
  out.series = Array.isArray(src.series) ? src.series.filter(isObj) : [];
  out.metrics = Array.isArray(src.metrics) ? src.metrics.filter((m) => typeof m === 'string') : [];
  out.window = isObj(src.window) ? src.window : null;
  out.sessionsUnknown = src.sessions_unknown === true;
  out.currency = str(src.currency);
  out.mixedCurrency = src.mixed_currency === true;
  return out;
}

/** A metric column out of the 60-day series, nulls preserved as HOLES. */
export function seriesCol(rows, metric) {
  return (Array.isArray(rows) ? rows : []).map(
    (p) => (isObj(p) && hasKey(p, metric) ? numOrNull(p[metric]) : null),
  );
}

/** The bucket keys, for the axis. */
export const bucketKeys = (rows) =>
  (Array.isArray(rows) ? rows : []).map((p) => (isObj(p) ? str(p.key) : ''));

/**
 * The cohort payload, normalised.
 *
 * ⚠️ `ltv[i] === null` SURVIVES AS NULL. It is the aging guard and it is the
 * whole point of the card; coercing it here would push the fabrication one
 * layer down where nobody would look for it.
 */
export function cohortsOf(payload) {
  const out = {
    sent: false,
    range: null,
    groupBy: '',
    horizons: [],
    rows: [],
    average: null,
    totals: null,
    basis: '',
    identity: '',
    warnings: [],
    computedMs: null,
  };
  if (!isObj(payload)) return out;
  out.sent = true;
  out.range = isObj(payload.range) ? payload.range : null;
  out.groupBy = str(payload.group_by);
  out.horizons = Array.isArray(payload.horizons)
    ? payload.horizons.map(numOrNull).filter((h) => h !== null) : [];
  out.rows = (Array.isArray(payload.cohorts) ? payload.cohorts : []).filter(isObj).map((c) => ({
    key: str(c.key),
    label: str(c.label) || str(c.key),
    size: numOrNull(c.size),
    ltv: (Array.isArray(c.ltv) ? c.ltv : []).map(numOrNull),
    retention: (Array.isArray(c.retention) ? c.retention : []).map(numOrNull),
    aged: (Array.isArray(c.aged) ? c.aged : []).map(numOrNull),
    revenueToDate: numOrNull(c.revenue_to_date),
  }));
  const avg = isObj(payload.average) ? payload.average : null;
  out.average = avg ? {
    ltv: (Array.isArray(avg.ltv) ? avg.ltv : []).map(numOrNull),
    retention: (Array.isArray(avg.retention) ? avg.retention : []).map(numOrNull),
    aged: (Array.isArray(avg.aged) ? avg.aged : []).map(numOrNull),
  } : null;
  out.totals = isObj(payload.totals) ? payload.totals : null;
  out.basis = str(payload.basis);
  out.identity = str(payload.identity);
  const meta = isObj(payload.meta) ? payload.meta : null;
  out.warnings = normaliseNotes(meta ? meta.warnings : null);
  out.computedMs = meta ? numOrNull(meta.computed_ms) : null;
  return out;
}

/**
 * `[{source, reason}]` → `[{source, text}]`, the same normalisation
 * metricsApi.normaliseWarnings performs. Strings are accepted; anything else is
 * DROPPED rather than stringified into "[object Object]" on screen.
 */
export function normaliseNotes(list) {
  if (!Array.isArray(list)) return [];
  const out = [];
  for (const w of list) {
    if (typeof w === 'string' && w.trim()) { out.push({ source: '', text: w.trim() }); continue; }
    if (!isObj(w)) continue;
    const reason = typeof w.reason === 'string' ? w.reason.trim()
      : typeof w.message === 'string' ? w.message.trim() : '';
    const source = typeof w.source === 'string' ? w.source.trim() : '';
    if (reason) out.push({ source, text: reason });
    else if (source) out.push({ source, text: `${source}: reported a problem with no reason given` });
  }
  return out;
}

/* ── errors ──────────────────────────────────────────────────────────────── */

// Keyed on the codes the insight + cohort services ACTUALLY emit. A raw machine
// code must never reach the operator (metricsApi's own lesson, reused).
const API_ERRORS = {
  invalid_day: 'That day is not a real calendar date.',
  day_in_future: 'That day has not happened yet, so there is nothing to judge.',
  invalid_date: 'The day must be a real calendar date.',
  invalid_date_format: 'Dates must be YYYY-MM-DD.',
  to_before_from: 'The start day is after the end day.',
  window_too_large: 'That window is longer than the cohort report supports.',
  unknown_group_by: 'Cohorts can be grouped by acquisition day, funnel or campaign.',
  bad_horizon: 'A horizon must be a whole number of days within the supported range.',
  too_many_horizons: 'That is more horizons than the cohort table can carry.',
  bad_body: 'The request was malformed.',
  rate_limited: 'Too many analytics reads in the last minute — give it a moment.',
};

/** Returns `null` for an ABORT, which is not a failure and must not render as one. */
export function insightsApiError(err, fallback = 'The insight API rejected that.') {
  if (err && (err.name === 'CanceledError' || err.code === 'ERR_CANCELED' || err.name === 'AbortError')) {
    return null;
  }
  const data = err && err.response ? err.response.data : null;
  const code = isObj(data) && isObj(data.error) ? data.error.code
    : (isObj(data) && typeof data.error === 'string' ? data.error : null);
  if (typeof code === 'string' && API_ERRORS[code]) return API_ERRORS[code];
  if (isObj(data) && typeof data.message === 'string' && data.message && !API_ERRORS[code]) {
    return data.message;
  }
  if (err && err.response && err.response.status === 403) {
    return 'You need funnels access to read insights.';
  }
  if (err && err.response) return `${fallback} (HTTP ${err.response.status})`;
  if (err && err.message) return `${fallback} (${err.message})`;
  return fallback;
}
