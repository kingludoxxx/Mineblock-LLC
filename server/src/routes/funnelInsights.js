// FUNNEL INSIGHTS — the authed read-only insight + cohort surface (LANE 5,
// NEW FILE).
//
// Follows the metrics lane's route pattern verbatim (routes/funnelMetrics.js):
// `router.use(authenticate, requirePermission('funnels', 'access'))`, the same
// per-user read limiter, the same MetricsError → status mapping.
//
// PERMISSION — the SAME decision funnelMetrics.js records, for the same reason:
// this router reuses 'funnels':'access' rather than minting an 'analytics' one
// via a shared RBAC migration. Insight cards and cohort tables are a view onto
// the funnels an operator can already read; they expose no figure the metrics
// surface does not already serve. To split it out later, change the
// requirePermission line here (and in funnelMetrics.js) and add a migration.
//
// EVERY handler is READ-ONLY. There is no POST, PUT, PATCH or DELETE, and there
// must never be one: the insight layer derives from the money ledgers and never
// writes to them or to a cache of them (see funnelInsights.js DECISION 1).
//
// ⚠️ INTEGRATION HOOK — the ONE mount line this lane adds to routes/index.js:
//     import funnelInsightsRoutes from './funnelInsights.js';
//     app.use('/api/v1/funnel-insights', funnelInsightsRoutes);
import { Router } from 'express';
import { authenticate } from '../middleware/auth.js';
import { requirePermission } from '../middleware/rbac.js';
import { checkRateLimit } from '../middleware/rateLimiter.js';
import { MetricsError, REPORT_TZ, todayInTz } from '../services/funnelMetrics.js';
import {
  runInsights, RULES, DROPPED, POLICIES, THRESHOLDS, MAX_CARDS, BASELINE_DAYS,
  LAST_N_DAYS, SERIES_METRICS, STEP_ORDER, STEP_LABELS, SEVERITIES,
} from '../services/funnelInsights.js';
import {
  computeCohorts, cohortsCsv, validateCohortQuery,
  HORIZONS, GROUP_BYS, MAX_BUYERS, MAX_WINDOW_DAYS,
} from '../services/funnelCohorts.js';

const router = Router();
router.use(authenticate, requirePermission('funnels', 'access'));

// ── RATE LIMIT ─────────────────────────────────────────────────────────────
// The same budget and the same reasoning as the metrics router: these reads run
// on the isolated two-connection analytics pool, so a runaway client cannot
// touch the money path but CAN make every other operator's Analytics page hang.
//
// SHARED KEY PREFIX ON PURPOSE — `funnel-metrics:<user>`. The insight surface
// runs the metrics engine; giving it its own bucket would let one operator
// spend 60 engine reads a minute through two doors while each door believed it
// was allowing 30. One engine, one budget.
//
// FAILS OPEN (checkRateLimit already falls back to memory, and a reporting page
// should degrade to "unlimited" rather than to "broken"): this bounds runaway
// clients, it is not a security control.
const READ_LIMIT = () => {
  const n = Number(process.env.METRICS_READ_LIMIT);
  return Number.isFinite(n) && n > 0 ? Math.floor(n) : 30;
};
const READ_WINDOW_SEC = 60;

async function limit(req, res) {
  const max = READ_LIMIT();
  const key = `funnel-metrics:${req.user?.id || req.ip}`;
  const { allowed, remaining, retryAfter } = await checkRateLimit(key, max, READ_WINDOW_SEC)
    .catch(() => ({ allowed: true, remaining: max, retryAfter: 0 }));
  res.set('X-RateLimit-Remaining', String(remaining ?? 0));
  if (!allowed) {
    res.set('Retry-After', String(retryAfter));
    res.status(429).json({
      error: 'rate_limited',
      message: `too many analytics reads — ${max} per ${READ_WINDOW_SEC}s`,
      retry_after: retryAfter,
    });
    return false;
  }
  return true;
}

/**
 * A service refusal → a status code.
 *
 * A MetricsError is BY DEFINITION the caller's fault and carries its own status.
 * Anything else is ours and goes to the app error handler as a 500 — a bug must
 * not be laundered into a 4xx, because a 4xx tells the operator to fix their
 * query when the thing that needs fixing is the server.
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
 * GET /api/v1/funnel-insights/insights?day&funnel_id
 *
 * The whole insight layer in ONE composite read: the ranked cards, which
 * detectors ran (whether or not they fired), the 60-day series the last-60 card
 * draws, the baseline window every card was judged against, and the threshold
 * table itself.
 *
 * `day` defaults to today in REPORT_TZ. A day in the future is a 422, not an
 * empty strip: judging an unstarted day against a full baseline would fire
 * every downward detector at once.
 */
router.get('/insights', async (req, res, next) => {
  try {
    if (!(await limit(req, res))) return;
    res.json(await runInsights({
      day: dayParam(req.query.day),
      funnel_id: req.query.funnel_id,
    }));
  } catch (err) {
    fail(res, err, next);
  }
});

/**
 * GET /api/v1/funnel-insights/cohorts?start&end&funnel_id&group_by&horizons
 *
 * New-acquisition cohorts with their LTV and repeat-retention curves. Defaults
 * to the last 90 REPORT_TZ days, grouped by acquisition day, at D0/D7/D30/D90.
 *
 * A horizon a cohort has not lived long enough to reach comes back `null` — see
 * funnelCohorts.js's aging guard. The client renders an em dash; nothing here
 * may turn that into a zero.
 */
router.get('/cohorts', async (req, res, next) => {
  try {
    if (!(await limit(req, res))) return;
    res.json(await computeCohorts({
      start: dayParam(req.query.start),
      end: dayParam(req.query.end),
      funnel_id: req.query.funnel_id,
      group_by: req.query.group_by,
      horizons: req.query.horizons,
    }));
  } catch (err) {
    fail(res, err, next);
  }
});

/**
 * GET /api/v1/funnel-insights/cohorts.csv?…same params…
 *
 * The same table as a download, through the SAME validator and the SAME engine
 * — a CSV that could answer a query the JSON endpoint rejects would be a
 * second, unaudited door onto the same numbers.
 *
 * ⚠️ VALIDATE FIRST, THEN COMPUTE, THEN SET HEADERS. Setting the attachment
 * headers before the work means a refusal arrives as a half-written download
 * the browser has already committed to saving, instead of as a 422 the client
 * can render.
 */
router.get('/cohorts.csv', async (req, res, next) => {
  try {
    if (!(await limit(req, res))) return;
    const q = validateCohortQuery({
      start: dayParam(req.query.start),
      end: dayParam(req.query.end),
      funnel_id: req.query.funnel_id,
      group_by: req.query.group_by,
      horizons: req.query.horizons,
    });
    const result = await computeCohorts(q);
    const body = cohortsCsv(result);
    res.setHeader('Content-Type', 'text/csv; charset=utf-8');
    res.setHeader('Content-Disposition', `attachment; filename="cohorts_${q.group_by}_${q.start}_${q.end}.csv"`);
    // The body is a download; make sure no sniffer decides to render it as
    // HTML in the origin's context.
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.send(body);
  } catch (err) {
    fail(res, err, next);
  }
});

/**
 * GET /api/v1/funnel-insights/definitions
 *
 * THE RULE TABLE, served from the SAME constants the detectors run on.
 *
 * WHY IT EXISTS — the same reason /funnel-metrics/definitions does. An operator
 * looking at a card that did NOT fire needs to know what would have made it
 * fire, and a client-side copy of the thresholds drifts from the server's the
 * first time one is tuned. This is the authority; the strip's "why is this
 * quiet?" panel reads it rather than restating it.
 *
 * `dropped` names what did NOT survive the port from the reference, with the
 * reason. A missing detector with no explanation reads as an oversight; a named
 * one reads as a decision.
 */
router.get('/definitions', async (req, res, next) => {
  try {
    if (!(await limit(req, res))) return;
    res.json({
      rules: RULES,
      policies: POLICIES,
      dropped: DROPPED,
      thresholds: THRESHOLDS,
      severities: SEVERITIES,
      max_cards: MAX_CARDS,
      baseline_days: BASELINE_DAYS,
      series_days: LAST_N_DAYS,
      series_metrics: SERIES_METRICS,
      steps: STEP_ORDER.map((s) => ({ id: s, label: STEP_LABELS[s] })),
      cohorts: {
        horizons: HORIZONS,
        group_bys: GROUP_BYS,
        max_buyers: MAX_BUYERS,
        max_window_days: MAX_WINDOW_DAYS,
        identity: "LOWER(TRIM(customer->>'email'))",
        aging_guard: 'a horizon a cohort has not lived long enough to reach is null, never 0',
      },
      timezone: REPORT_TZ,
      today: todayInTz(),
    });
  } catch (err) {
    fail(res, err, next);
  }
});

export default router;
