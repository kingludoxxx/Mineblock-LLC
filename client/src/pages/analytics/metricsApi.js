// metricsApi — the ONE place the analytics dashboard names a backend route
// and the ONE place it names a payload key (NEW FILE, LANE 3).
//
// ── READ THIS BEFORE CHANGING A KEY NAME ────────────────────────────────────
//
// The shapes below are NOT the work order's sketch: they were read out of
// Lane 1's shipped service (server/src/services/funnelMetrics.js, runDashboard)
// and Lane 2's routes, and every reader here is pinned to what those actually
// emit. The first cut of this file was written against the sketch and drifted —
// it looked for `gross_sales` on breakdown rows that carry `net_sales`, for a
// scalar `total` on a breakdown that nests `totals`, and for string warnings in
// an array of `{source, reason}` objects. All three failed SILENTLY, which is
// the failure mode that matters: a reader that finds nothing renders an em dash,
// and an em dash is indistinguishable from an honest withholding. THE COGS
// LESSON: a client reader must be written against the server's emitted shape,
// not against the document that described it.
//
// Every reader is TOLERANT ON SHAPE and STRICT ON MEANING:
//   · tolerant — a breakdown may arrive as a bare array (older sketch) or as
//     Lane 1's `{rows, totals, basis, basis_label, limit, rows_total,
//     rows_truncated}`. Both are read. A series may be an array or `{points}`.
//   · strict — `null` is WITHHELD, `undefined`/absent is NOT REPORTED BY THIS
//     BUILD, and neither is ever collapsed into the other or into `0`. `?? 0`
//     appears nowhere in this workspace on a measured quantity.
//
// ── LANE 1 · GET /funnel-metrics/dashboard ?start&end&funnel_id ──────────────
//   {
//     band: { live, unique_today,
//             today:     {day, orders, revenue, spend, net},
//             yesterday: {day, orders, revenue, spend, net},
//             in_window }            // is "today" inside the selected window?
//     kpis: {                        // DASHBOARD_KPIS + DASHBOARD_KPIS_COST
//       orders, gross_sales, net_sales, refunds, sessions, conv_pct, aov,
//       new_customers, returning_customers,
//       net_after_cogs, margin_pct, cost_coverage_pct, spend, roas, cpa,
//       net_profit,
//       previous: { …the same key set… },
//       upsell_lines: { aov_post, aov_pre, upsell_revenue, take_rate,
//                       upsell_refunds, orders, abandoned },
//     },
//     series:      [{key, gross_sales, net_sales, orders, sessions, conv_pct}],
//     prev_series: [ …same… ],       // ALIGNED BY INDEX, own calendar keys
//     breakdown_summary: {
//       funnels:   BREAKDOWN,        // metrics: net_sales, orders, aov
//       products:  BREAKDOWN,        // metrics: gross_sales, orders
//       sources:   BREAKDOWN,        // metrics: net_sales, orders
//       campaigns: BREAKDOWN,        // metrics: net_sales, orders
//       countries: BREAKDOWN,        // metrics: net_sales, orders
//     },
//     waterfall, movers,
//     window: {start, end, prev_start, prev_end, days, timezone},
//     meta: { computed_ms, rows_scanned, basis, basis_label, timezone,
//             series_aligned_by:'index', window:{start,end,days,timezone},
//             warnings: [{source, reason}] },
//   }
//   BREAKDOWN = { rows:[{key, label, …metrics}], totals:{…metrics},
//                 basis, basis_label, limit, rows_total, rows_truncated }
//
//   ⚠️ THE MONEY COLUMN IS `net_sales` ON FOUR OF THE FIVE BREAKDOWNS and
//   `gross_sales` on products. It is read through `rowMoney`, which reports
//   WHICH metric it found so the card can caption itself honestly — a bar chart
//   captioned "Sales" over a net column is a different claim from the same
//   chart over a gross one, and refunds are the difference.
//
//   ⚠️ `basis` is NOT the same axis as the money metric. `basis` says whether
//   upsell money is inside the fold (gross / captured_base / line_items);
//   the metric says whether refunds have been taken off. Both are printed.
//
// ── LANE 2 · GET /funnel-attribution/marketing ──────────────────────────────
//   ?start&end&funnel_id&dimension=campaign|source|referrer|landing_page&limit
//   -> { dimension,
//        rows:[{key, label, orders, sales, bar_pct, attribution, is_unattributed}],
//        totals:{orders, sales, rows_total},
//        basis:"captured_base", basis_label,
//        revenue_basis:"order_window", revenue_basis_label,
//        funnel_scoped, attribution_ttl_risk, currency, mixed_currency,
//        warnings:[{source, reason}],
//        window:{start,end,days,timezone}, meta:{computed_ms, rows_scanned} }
//
//   ⚠️ RENDER `label`, FILTER ON `key` (Lane 2's contract, verbatim). The label
//   is already disambiguated server-side — a REAL campaign literally named
//   "direct / none" gets "direct / none (campaign)" so it cannot be confused
//   with the unattributed bucket. Rewriting blank-looking labels on the client
//   would undo that work and merge two different rows on screen.
//
//   ⚠️ `attribution` IS THE AUTHORITY, not the key text, and it distinguishes
//   TWO DIFFERENT FACTS that both look like "no campaign":
//        'none'     — nothing was measured for this order at all
//        'untagged' — the visit WAS seen, the dimension just was not tagged
//   Collapsing them into one "no campaign on the click" bar loses the only
//   information that says whether the fix is tracking or ad setup.
//
// Explicit `.js` extensions on the relative imports so the node harnesses in
// ./dashboard/__checks__ can import this module tree directly; Vite resolves
// them identically.
import api from '../../services/api.js';

export const METRICS_BASE = '/funnel-metrics';
export const ATTRIBUTION_BASE = '/funnel-attribution';

export const METRICS_ROUTES = {
  dashboard: `${METRICS_BASE}/dashboard`,
  // The 15s heartbeat's target (Lane 1 @3e42a8e). ONE cheap query, and
  // runDashboard calls the same `runBand` for its first paint, so the polled
  // value and the painted value cannot drift apart.
  band: `${METRICS_BASE}/band`,
  query: `${METRICS_BASE}/query`,
  queryCsv: `${METRICS_BASE}/query.csv`,
  presets: `${METRICS_BASE}/presets`,
  definitions: `${METRICS_BASE}/definitions`,
  marketing: `${ATTRIBUTION_BASE}/marketing`,
  roas: `${ATTRIBUTION_BASE}/roas`,
  clicks: `${ATTRIBUTION_BASE}/clicks`,
  spendDaily: `${ATTRIBUTION_BASE}/spend-daily`,
};

/**
 * The house envelope unwrap, done ONCE. Some routes in this repo answer
 * `{success:true, data:<payload>}`; Lane 1's answer the payload bare. Peeling
 * exactly one layer covers both and lets no second unwrap assumption exist
 * downstream (costsApi.js precedent).
 */
export const unwrap = (res) => res.data?.data ?? res.data;

/* ── the fetches this page is allowed to make ────────────────────────────── */

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

/**
 * The live band alone — the heartbeat's only request.
 *
 * ⚠️ Its window is ALWAYS [yesterday, today] in REPORT_TZ, whatever range the
 * page is showing, and it carries NO `in_window` (that is runDashboard's
 * statement about the selected window). The caller splices, it does not replace.
 */
export function fetchBand({ funnelId } = {}, { signal } = {}) {
  const params = {};
  if (funnelId) params.funnel_id = funnelId;
  return api.get(METRICS_ROUTES.band, { params, signal }).then(unwrap);
}

/* ── absent vs null vs zero ──────────────────────────────────────────────── */

/**
 * ABSENT vs NULL. `obj?.[k] ?? null` cannot tell "the server never sent this
 * key" from "the server sent it and the answer is unknown", and several
 * surfaces turn on exactly that difference: a key never sent means THIS BUILD
 * DOES NOT REPORT IT (say so, or hide the column), while a key sent as null
 * means WE REFUSED TO CLAIM IT (em dash plus the reason).
 */
export const hasKey = (obj, k) =>
  !!obj && typeof obj === 'object' && Object.prototype.hasOwnProperty.call(obj, k);

/** Was this value actually sent, and is it a claim rather than a refusal? */
export const present = (v) => v !== null && v !== undefined;

const isObj = (v) => !!v && typeof v === 'object' && !Array.isArray(v);
const numOrNull = (v) => {
  if (v === null || v === undefined || v === '') return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
};

/* ── the money column ────────────────────────────────────────────────────── */

/**
 * WHICH MONEY. Lane 1's breakdowns do not all fold the same quantity: funnels,
 * sources, campaigns and countries carry `net_sales` (refunds already taken
 * off), products carries `gross_sales`. Reading one and captioning the other is
 * a silent misstatement worth exactly the refund total, so the reader RETURNS
 * THE NAME of what it found and the cards print it.
 *
 * Preference order is the order of specificity, not of size: an explicit
 * `net_sales` wins over an explicit `gross_sales` wins over a legacy `sales`.
 */
export const MONEY_METRICS = Object.freeze(['net_sales', 'gross_sales', 'sales']);

export const MONEY_METRIC_LABELS = Object.freeze({
  net_sales: 'Net sales',
  gross_sales: 'Gross sales',
  sales: 'Sales',
});

/** `{value, metric}` for one row — `{value:null, metric:null}` when it carries none. */
export function rowMoney(row) {
  if (!isObj(row)) return { value: null, metric: null };
  for (const m of MONEY_METRICS) {
    if (hasKey(row, m)) return { value: numOrNull(row[m]), metric: m };
  }
  return { value: null, metric: null };
}

/** The money metric a whole breakdown is folded on, or null if it carries none. */
export function moneyMetricOf(rows) {
  const list = Array.isArray(rows) ? rows : [];
  for (const m of MONEY_METRICS) {
    if (list.some((r) => hasKey(r, m))) return m;
  }
  return null;
}

/* ── shape readers ───────────────────────────────────────────────────────── */

/**
 * A timeseries out of the composite. Lane 1 emits `[{key, …metrics}]`; the
 * `{points:[…]}` form is accepted too. Points are handed back UNTOUCHED — a
 * null metric on a point is a bucket that was not measured and must reach the
 * chart as a hole.
 */
export function seriesOf(data, key = 'series') {
  const s = isObj(data) ? data[key] : null;
  if (Array.isArray(s)) return s.filter(isObj);
  if (isObj(s) && Array.isArray(s.points)) return s.points.filter(isObj);
  return [];
}

/** The bucket key of a series point — Lane 1 emits `key`. */
export const bucketKeyOf = (p) =>
  (isObj(p) && (p.key ?? p.day ?? p.hour ?? p.bucket ?? p.date)) || '';

/**
 * A metric column out of a series, nulls preserved. TYPE-GUARDED: a point that
 * is not an object, or a series that is not an array, yields holes rather than
 * throwing or — worse — yielding `Number(undefined)` zeros.
 */
export function seriesCol(rows, metric) {
  return (Array.isArray(rows) ? rows : []).map(
    (p) => (isObj(p) && hasKey(p, metric) ? numOrNull(p[metric]) : null),
  );
}

/**
 * A breakdown, normalised.
 *
 * `{rows, basis, basis_label, total, rows_total, limit, truncated, metric,
 *   sent, totals}`
 *
 * THE TOTAL IS THE PRE-TRUNCATION FOLD and it is the only figure that lets a
 * card say "Top 7 of 34 · $261,212.15". Lane 1 nests it as `totals.<metric>`
 * (and is adding a scalar `total` alongside); both are read, scalar first.
 * ABSENT CLAIMS NOTHING: with no total the card prints no period figure rather
 * than a sum of the rows it happens to be holding, which would silently equal
 * "the tail is worth zero".
 *
 * A BREAKDOWN WITHOUT A BASIS IS UNSHIPPABLE (work order, Lane 1 §6): the
 * captured-base caption has to be TRUE, so `basis`/`basis_label` come off the
 * wire or they are empty strings and no claim is printed.
 */
export function breakdownOf(data, name) {
  const src = isObj(data) && isObj(data.breakdown_summary)
    ? data.breakdown_summary[name]
    : undefined;
  const out = {
    rows: [],
    totals: null,
    basis: '',
    basis_label: '',
    total: null,
    total_metric: null,
    rows_total: null,
    limit: null,
    truncated: false,
    metric: null,
    sent: false,
  };
  if (src === null || src === undefined) return out;
  out.sent = true;

  if (Array.isArray(src)) {
    out.rows = src.filter(isObj);
    out.metric = moneyMetricOf(out.rows);
    return out;
  }
  if (!isObj(src)) return out;

  const rows = Array.isArray(src.rows) ? src.rows : Array.isArray(src.items) ? src.items : [];
  out.rows = rows.filter(isObj);
  out.basis = typeof src.basis === 'string' ? src.basis : '';
  out.basis_label = typeof src.basis_label === 'string' ? src.basis_label : '';
  out.totals = isObj(src.totals) ? src.totals : null;

  // WHICH METRIC THE TOTAL IS ON — the server's own declaration wins over any
  // inference from the rows. Lane 1 sends `total_metric` (and `basis_metric`)
  // precisely "so the footer cannot say 'sales' over a column of orders".
  const declared = typeof src.total_metric === 'string' ? src.total_metric
    : typeof src.basis_metric === 'string' ? src.basis_metric : '';
  out.total_metric = declared || null;
  out.metric = MONEY_METRICS.includes(declared) ? declared : moneyMetricOf(out.rows);

  // THE GUARD: a breakdown folded on a NON-money metric still has a `total`,
  // and that total is a count. Printing it behind a `$` on a money card would
  // be a unit error with a currency symbol on it, so the money total is only
  // taken when the declared metric IS money (or when the server declared
  // nothing and the rows themselves are money).
  const moneyTotal = MONEY_METRICS.includes(declared) || (!declared && out.metric);
  if (moneyTotal) {
    if (present(src.total)) out.total = numOrNull(src.total);
    else if (out.totals && out.metric && hasKey(out.totals, out.metric)) {
      out.total = numOrNull(out.totals[out.metric]);
    }
  }

  if (present(src.rows_total)) out.rows_total = numOrNull(src.rows_total);
  if (present(src.limit)) out.limit = numOrNull(src.limit);
  out.truncated = src.rows_truncated === true
    || (out.rows_total !== null && out.rows_total > out.rows.length);
  return out;
}

/**
 * Lane 2's marketing payload, in the same vocabulary as a breakdown, plus the
 * three disclosures the attribution lane owns:
 *
 *   · `warnings` — its own `{source, reason}` list.
 *   · `attribution_ttl_risk` — the click ledger does not reach back far enough
 *     to stitch this window, so the "direct / none" bucket is FAT with traffic
 *     that had a campaign nobody can name any more. Without saying so, an
 *     operator reads a real attribution collapse.
 *   · `mixed_currency` — the money column is a raw sum across currencies and is
 *     not directly comparable. A silent `$` in front of it is a lie about the
 *     unit, not just the value.
 */
export function marketingOf(mk) {
  const out = {
    rows: [],
    basis: '',
    basis_label: '',
    total: null,
    rows_total: null,
    orders: null,
    metric: null,
    warnings: [],
    ttlRisk: false,
    mixedCurrency: false,
    currency: '',
    revenueBasisLabel: '',
    dimension: '',
    unattributed: { none: 0, untagged: 0 },
    sent: false,
  };
  if (!isObj(mk)) return out;
  out.sent = true;
  out.rows = Array.isArray(mk.rows) ? mk.rows.filter(isObj) : [];
  out.metric = moneyMetricOf(out.rows);
  out.basis = typeof mk.basis === 'string' ? mk.basis : '';
  out.basis_label = typeof mk.basis_label === 'string' ? mk.basis_label : '';
  const t = isObj(mk.totals) ? mk.totals : null;
  if (t) {
    const tm = out.metric && hasKey(t, out.metric) ? out.metric : (hasKey(t, 'sales') ? 'sales' : null);
    if (tm) out.total = numOrNull(t[tm]);
    if (present(t.rows_total)) out.rows_total = numOrNull(t.rows_total);
    if (present(t.orders)) out.orders = numOrNull(t.orders);
  }
  if (present(mk.rows_total)) out.rows_total = numOrNull(mk.rows_total);
  out.warnings = normaliseWarnings(mk.warnings);
  out.ttlRisk = mk.attribution_ttl_risk === true;
  out.mixedCurrency = mk.mixed_currency === true;
  out.currency = typeof mk.currency === 'string' ? mk.currency : '';
  out.revenueBasisLabel = typeof mk.revenue_basis_label === 'string' ? mk.revenue_basis_label : '';
  out.dimension = typeof mk.dimension === 'string' ? mk.dimension : '';
  // Counted, not merged: 'none' and 'untagged' are different diagnoses.
  for (const r of out.rows) {
    if (r.attribution === 'none') out.unattributed.none += 1;
    else if (r.attribution === 'untagged') out.unattributed.untagged += 1;
  }
  return out;
}

/** The live band, with `in_window` kept TRI-STATE (absent ≠ false). */
export function bandOf(data) {
  const b = isObj(data) && isObj(data.band) ? data.band : null;
  if (!b) return null;
  return {
    live: numOrNull(b.live),
    unique_today: numOrNull(b.unique_today),
    today: isObj(b.today) ? b.today : null,
    yesterday: isObj(b.yesterday) ? b.yesterday : null,
    // ABSENT stays null: a build that does not report it has not said "today is
    // outside the window", and printing that line off a missing key would be
    // asserting something nobody measured.
    inWindow: hasKey(b, 'in_window') ? b.in_window === true : null,
  };
}

/**
 * The KPI block. Lane 1 nests `previous` and `upsell_lines` INSIDE `kpis`.
 * Nothing is defaulted: with no payload every accessor answers `null`, which
 * renders an em dash and not a zero.
 */
export function kpisOf(data) {
  const block = isObj(data) && isObj(data.kpis) ? data.kpis : null;
  const cur = block ? (isObj(block.kpis) ? block.kpis : isObj(block.current) ? block.current : block) : null;
  const prev = (block && isObj(block.previous) ? block.previous : null)
    || (isObj(data) && isObj(data.previous) ? data.previous : null);
  const upsell = (cur && isObj(cur.upsell_lines) ? cur.upsell_lines : null)
    || (block && isObj(block.upsell_lines) ? block.upsell_lines : null)
    || (isObj(data) && isObj(data.upsell_lines) ? data.upsell_lines : null);
  return { cur, prev, upsell };
}

/**
 * The window block, preferring `meta.window` (the echo every Lane 1 response
 * carries) and filling the compare edges from the top-level `window`, which is
 * the only place they exist. `timezone` is printed verbatim — the zone is the
 * SERVER'S claim, never this file's.
 */
export function windowOf(data) {
  const top = isObj(data) && isObj(data.window) ? data.window : {};
  const echo = isObj(data) && isObj(data.meta) && isObj(data.meta.window) ? data.meta.window : {};
  const pick = (k) => (present(echo[k]) ? echo[k] : top[k]);
  return {
    start: pick('start') || '',
    end: pick('end') || '',
    prev_start: top.prev_start || '',
    prev_end: top.prev_end || '',
    days: numOrNull(pick('days')),
    timezone: pick('timezone') || (isObj(data) && isObj(data.meta) ? data.meta.timezone : '') || '',
  };
}

/**
 * WARNINGS ARE OBJECTS. Lane 1 emits `[{source, reason}]`; the first cut of
 * this reader kept only strings and therefore threw every warning on the floor
 * — including the one that explains why the whole sessions column is dashes.
 * Strings are still accepted (Lane 2 may send them), and anything else is
 * dropped rather than stringified into "[object Object]" on screen.
 */
export function normaliseWarnings(list) {
  if (!Array.isArray(list)) return [];
  const out = [];
  for (const w of list) {
    if (typeof w === 'string' && w.trim()) {
      out.push({ source: '', text: w.trim() });
      continue;
    }
    if (!isObj(w)) continue;
    const reason = typeof w.reason === 'string' ? w.reason.trim()
      : typeof w.message === 'string' ? w.message.trim() : '';
    const source = typeof w.source === 'string' ? w.source.trim() : '';
    if (reason) out.push({ source, text: reason });
    else if (source) out.push({ source, text: `${source}: reported a problem with no reason given` });
  }
  return out;
}

export function warningsOf(data) {
  const meta = isObj(data) && isObj(data.meta) ? data.meta : null;
  return normaliseWarnings(meta ? meta.warnings : null);
}

/**
 * SESSIONS WITHHELD — and the three ways to learn it, in order of authority.
 *
 *   1. `meta.sessions_unknown` — the explicit flag (Lane 1 adding it).
 *   2. A warning from `lb_touches` / `sessions` — what Lane 1 emits TODAY:
 *      `{source:'sessions', reason:'sessions withheld for this window …'}`.
 *      This is the signal that actually fires against the shipped service, and
 *      reading only (1) is why the TTL note never appeared.
 *   3. DOCUMENTED FALLBACK: `sessions === null` while `orders !== null`. Both
 *      null means the whole payload is empty (nothing to explain); sessions
 *      null beside a real order count means the visitor spine specifically is
 *      gone. Never `sessions === 0` — a measured zero is not a withholding.
 *
 * Returns false when nothing says otherwise: claiming "withheld" off silence
 * would put a retention warning on every healthy window.
 */
export function sessionsUnknownOf(data) {
  const meta = isObj(data) && isObj(data.meta) ? data.meta : null;
  if (hasKey(meta, 'sessions_unknown')) return meta.sessions_unknown === true;

  const flagged = warningsOf(data).some(
    (w) => w.source === 'sessions' || w.source === 'lb_touches',
  );
  if (flagged) return true;

  const { cur } = kpisOf(data);
  if (hasKey(cur, 'sessions') && hasKey(cur, 'orders')) {
    return cur.sessions === null && cur.orders !== null;
  }
  return false;
}

/* ── errors ──────────────────────────────────────────────────────────────── */

const API_ERRORS = {
  illegal_metric_dimension: 'That metric cannot be broken down by that dimension.',
  too_many_metrics: 'A report can carry at most eight metrics.',
  bad_granularity: 'Hourly granularity is only available on a single-day window.',
  invalid_window: 'That date window is not valid.',
  bad_window: 'That date window is not valid.',
  window_too_large: 'The window is longer than the 400 days this report supports.',
  window_too_long: 'The window is longer than the 400 days this report supports.',
  bad_day: 'The day must be a real YYYY-MM-DD date.',
  bad_dimension: 'That is not a dimension this report can break down by.',
  unavailable_dimension: 'That dimension is not collected by this build.',
};

/**
 * Error prose. Reads `{success:false, error:{code}}`, then `{error:'…'}` (the
 * shape the existing funnel routes answer with), then falls back. A raw machine
 * code never reaches the operator. Returns `null` for an ABORT, which is not a
 * failure and must not be rendered as one.
 */
export function metricsApiError(err, fallback = 'The analytics API rejected that.') {
  if (err && (err.name === 'CanceledError' || err.code === 'ERR_CANCELED' || err.name === 'AbortError')) {
    return null;
  }
  const data = err && err.response ? err.response.data : null;
  const code = isObj(data) && isObj(data.error) ? data.error.code : null;
  if (typeof code === 'string' && API_ERRORS[code]) return API_ERRORS[code];
  if (isObj(data) && typeof data.error === 'string' && data.error) return data.error;
  if (err && err.response && err.response.status === 403) {
    return 'You need funnels access to read analytics.';
  }
  if (err && err.response) return `${fallback} (HTTP ${err.response.status})`;
  if (err && err.message) return `${fallback} (${err.message})`;
  return fallback;
}
