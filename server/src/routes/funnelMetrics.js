// FUNNEL METRICS — the authed read-only query surface (LANE 1, NEW FILE).
//
// Follows the repo's route+permission pattern (funnelAnalytics.js /
// funnelCosts.js): `router.use(authenticate, requirePermission('funnels', 'access'))`.
//
// PERMISSION — DECISION MADE, the same reasoning funnelAnalytics.js records:
// this router reuses the existing 'funnels':'access' permission rather than
// minting an 'analytics' one via an additive RBAC migration. Reporting on a
// funnel is a sub-capability of the funnel builder, the SuperAdmin wildcard
// already covers it, and a new permission means editing the shared RBAC
// seed/migration that this lane's fence asks me to leave alone. To split it
// out later, change the requirePermission line here and add a migration
// granting 'analytics':['access'].
//
// ⚠️ INTEGRATION HOOK — the ONE mount line this lane adds to routes/index.js:
//     import funnelMetricsRoutes from './funnelMetrics.js';
//     app.use('/api/v1/funnel-metrics', funnelMetricsRoutes);
//
// EVERY handler here is READ-ONLY. There is no PUT/PATCH/DELETE, and the one
// POST is a QUERY (a GET with a body, because the body is a nested object that
// does not survive a query string) — it writes nothing and there must never be
// a handler here that does.
//
// TIMEZONE: every response carries `meta.timezone` (REPORT_TZ, default
// Europe/Madrid). The `start`/`end` day-strings a caller sends are LOCAL
// calendar days in that zone, not UTC ones — see funnelMetrics.js's header.
import { Router } from 'express';
import { authenticate } from '../middleware/auth.js';
import { requirePermission } from '../middleware/rbac.js';
import {
  runQuery,
  runDashboard,
  reportPresets,
  validateQuery,
  toCsv,
  MetricsError,
  METRICS,
  METRIC_META,
  DIMENSIONS,
  DIMENSION_META,
  DIM_METRICS,
  BREAKDOWN_BASES,
  BREAKDOWN_BASIS_LABELS,
  UNAVAILABLE_DIMENSIONS,
  UNSERVABLE_PRESETS,
  GRANULARITIES,
  HOUR_ONLY_EXCLUSIONS,
  MAX_METRICS,
  MAX_BREAKDOWN_LIMIT,
  MAX_WINDOW_DAYS,
  REPORT_TZ,
  todayInTz,
} from '../services/funnelMetrics.js';

const router = Router();
router.use(authenticate, requirePermission('funnels', 'access'));

/**
 * Turn a service refusal into a status code.
 *
 * A MetricsError is BY DEFINITION the caller's fault and carries its own
 * status (422 for every validation/legality refusal). Anything else is ours
 * and goes to the app error handler as a 500 — a bug must not be laundered
 * into a 4xx, because a 4xx tells the operator to fix their query.
 */
function fail(res, err, next) {
  if (err instanceof MetricsError) {
    return res.status(err.status).json({
      error: err.code,
      message: err.message,
      detail: err.detail ?? undefined,
    });
  }
  return next(err);
}

const dayParam = (v) => {
  const s = String(v ?? '').trim();
  return s ? s.slice(0, 10) : undefined;
};

/**
 * POST /api/v1/funnel-metrics/query
 *
 * Body = MetricsQueryBody: {metrics[1..8], dimension?, filters{funnel_id,
 * country, gateway, source}, window{start_day,end_day}, compare?, granularity?,
 * limit?} → {series[]|rows[], totals, previous?, meta{computed_ms,
 * rows_scanned, basis, basis_label, timezone, warnings[]}}.
 *
 * An illegal metric × dimension pair is 422 BEFORE any query runs — the whole
 * point of the legality matrix is that the database never sees a question it
 * would have to answer dishonestly.
 */
router.post('/query', async (req, res, next) => {
  try {
    res.json(await runQuery(req.body));
  } catch (err) {
    fail(res, err, next);
  }
});

/**
 * GET /api/v1/funnel-metrics/query.csv?q=<url-encoded JSON body>
 *
 * The exact POST body, as a download. Same engine, same validation, same
 * refusals — a CSV that could answer a query the JSON endpoint rejects would
 * be a second, unaudited door onto the same numbers.
 *
 * INJECTION: every cell goes through `csvCell`, which neutralises the
 * spreadsheet-formula prefixes (= + - @ and leading whitespace). Funnel names,
 * UTM campaigns and referrer hosts all land in this file and all of them are
 * attacker-supplied, so this is a real sink.
 */
router.get('/query.csv', async (req, res, next) => {
  try {
    const raw = String(req.query.q ?? '');
    if (raw.length < 2 || raw.length > 8000) {
      throw new MetricsError('bad_q', 'q must be a URL-encoded JSON object (2..8000 chars)');
    }
    let parsed;
    try {
      parsed = JSON.parse(raw);
    } catch {
      throw new MetricsError('bad_q', 'q must be valid JSON');
    }
    // Validate FIRST so a bad body is a 422 with a JSON error, not a
    // half-written attachment the browser has already started downloading.
    const q = validateQuery(parsed);
    const result = await runQuery(parsed);
    const filename = `funnel_metrics_${q.window.from}_${q.window.to}.csv`;
    res.setHeader('Content-Type', 'text/csv; charset=utf-8');
    res.setHeader('Content-Disposition', `attachment; filename="${filename}"`);
    // Belt-and-braces: the body is a download, so make sure no sniffer decides
    // to render it as HTML in the origin's context.
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.send(toCsv(result, q));
  } catch (err) {
    fail(res, err, next);
  }
});

/**
 * GET /api/v1/funnel-metrics/dashboard?start&end&funnel_id
 *
 * The WHOLE analytics page in ONE composite read: band, kpis (+previous,
 * +upsell_lines), series + prev_series, breakdown_summary (each naming its
 * basis), waterfall, movers, window. Defaults to the last 30 REPORT_TZ days.
 *
 * It is one endpoint on purpose: a page that fetches eleven times can render
 * tiles and a chart that disagree with each other, and an operator who sees
 * two different numbers for the same word stops trusting all of them.
 */
router.get('/dashboard', async (req, res, next) => {
  try {
    res.json(await runDashboard({
      start: dayParam(req.query.start),
      end: dayParam(req.query.end),
      funnel_id: req.query.funnel_id,
    }));
  } catch (err) {
    fail(res, err, next);
  }
});

/**
 * GET /api/v1/funnel-metrics/presets
 *
 * The curated report library. Every `query` is a valid body AND legal against
 * the real DIM_METRICS, so the explorer can POST one verbatim and never 422 —
 * the harness proves that by POSTing all of them.
 *
 * `unservable` names the reference reports that did NOT survive the port, with
 * the reason. A missing report with no explanation reads as an oversight; a
 * named one reads as a decision.
 */
router.get('/presets', (req, res, next) => {
  try {
    const end = dayParam(req.query.end) || todayInTz();
    const start = dayParam(req.query.start)
      || new Date(new Date(`${end}T12:00:00Z`).getTime() - 29 * 86_400_000).toISOString().slice(0, 10);
    const presets = reportPresets(start, end);
    res.json({
      presets,
      count: presets.length,
      categories: [...new Set(presets.map((p) => p.category))],
      unservable: UNSERVABLE_PRESETS,
      window: { start_day: start, end_day: end, timezone: REPORT_TZ },
    });
  } catch (err) {
    fail(res, err, next);
  }
});

/**
 * GET /api/v1/funnel-metrics/definitions
 *
 * THE FROZEN VOCABULARY AND THE LEGALITY MATRIX, served from the SAME
 * constants the engine validates against.
 *
 * WHY IT EXISTS — this endpoint closes a whole class of bug rather than a
 * bug. The explorer has to grey out an illegal metric chip before the operator
 * clicks it, and the only alternative to serving the matrix is a second,
 * hand-maintained copy of it in the client. That copy drifts, and its drift
 * shows up as a 422 on a control the UI just told the operator was enabled —
 * which reads as "the analytics are broken", not "the client is stale".
 *
 * The client is an OPTIMISATION, never the authority: the server refuses the
 * same combinations whether or not the client asked nicely. `dim_metrics` is
 * the matrix keyed by dimension (with `__timeseries__` for the no-dimension
 * case) so a client can intersect directly; `hour_only_exclusions` is the
 * day-only metric list, which is refused hourly regardless of dimension.
 */
router.get('/definitions', (_req, res) => {
  res.json({
    metrics: METRICS.map((m) => ({ id: m, ...METRIC_META[m] })),
    dimensions: DIMENSIONS.map((d) => ({
      id: d,
      ...DIMENSION_META[d],
      basis: BREAKDOWN_BASES[d],
      basis_label: BREAKDOWN_BASIS_LABELS[BREAKDOWN_BASES[d]],
      legal_metrics: [...DIM_METRICS[d]],
      ...(UNAVAILABLE_DIMENSIONS[d] || {}),
    })),
    // The matrix itself, in the shape a client intersects against.
    dim_metrics: Object.fromEntries(
      Object.entries(DIM_METRICS).map(([k, v]) => [k, [...v]])
    ),
    hour_only_exclusions: HOUR_ONLY_EXCLUSIONS,
    max_window_days: MAX_WINDOW_DAYS,
    timezone: REPORT_TZ,
    granularities: GRANULARITIES,
    unavailable_dimensions: UNAVAILABLE_DIMENSIONS,
    basis_labels: BREAKDOWN_BASIS_LABELS,
    limits: {
      max_metrics: MAX_METRICS,
      max_breakdown_limit: MAX_BREAKDOWN_LIMIT,
      max_window_days: MAX_WINDOW_DAYS,
      // Hourly buckets are a single-day-only view: an hour key across a
      // multi-day window is either 24 collapsed points or 720 exploded ones,
      // and both are wrong.
      hour_requires_single_day: true,
    },
  });
});

export default router;
