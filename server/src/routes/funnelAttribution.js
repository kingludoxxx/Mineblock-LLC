// Ad performance & attribution — authed read-only surface (NEW FILE, LANE 2).
//
// Follows the repo's route+permission pattern (funnelAnalytics.js /
// splitTests.js): router.use(authenticate, requirePermission('funnels','access')).
//
// PERMISSION — DECISION MADE, identical reasoning to funnelAnalytics.js:22:
// this router reuses 'funnels':'access' rather than minting an 'analytics'
// permission via an additive RBAC migration. Reporting on a funnel's ad
// performance is a sub-capability of the funnel builder, the SuperAdmin
// wildcard already covers it, and a new permission means editing the shared
// RBAC seed the lane-isolation constraint asks me to leave alone. To split it
// out later, change the requirePermission line here and add a migration.
//
// ⚠️ INTEGRATION HOOK — the mount in routes/index.js is:
//     import funnelAttributionRoutes from './funnelAttribution.js';
//     app.use('/api/v1/funnel-attribution', funnelAttributionRoutes);
//
// EVERY handler here is READ-ONLY. There is no POST/PUT/PATCH/DELETE and there
// must never be.
//
// TIMEZONE: every `start`/`end` parameter and every day key in every response
// is a REPORT_TZ (Europe/Madrid) calendar day — see the service header for why
// the ad-spend join requires it. Responses carry `window.timezone` so no client
// has to assume.
import { Router } from 'express';
import { authenticate } from '../middleware/auth.js';
import { requirePermission } from '../middleware/rbac.js';
import {
  getMarketing,
  getRoas,
  getClicks,
  getSpendDaily,
  MARKETING_DIMENSIONS,
  ROAS_DIMENSIONS,
  COST_SOURCES,
  ATTRIBUTION_DEFINITIONS,
  REPORT_TZ,
} from '../services/funnelAttribution.js';

const router = Router();
router.use(authenticate, requirePermission('funnels', 'access'));

// A refusal from the service is the caller's fault (400). Nothing else leaks.
const ERROR_STATUS = {
  invalid_date_format: 400,
  invalid_date: 400,
  to_before_from: 400,
  window_too_large: 400,
  invalid_dimension: 400,
  invalid_limit: 400,
  invalid_days: 400,
};

function send(res, result) {
  if (result?.error) {
    return res.status(ERROR_STATUS[result.error] ?? 400).json({ error: result.error });
  }
  return res.json(result);
}

/**
 * GET /marketing?start&end&funnel_id&dimension&limit
 *
 * "Sales attributed to marketing" / "Sales by UTM source" — the same read at
 * four dimensions (campaign | source | referrer | landing_page).
 *
 * ⚠️ CONTRACT FOR THE CARD: `totals` folds EVERY bucket, `rows_total` is how
 * many exist, `rows` is the page. The footer "Top N of M · $total" must be
 * built from totals.rows_total and totals.sales — NOT from the rows on screen,
 * which are a subset. `basis_label` must be rendered somewhere on the card: the
 * money in here is the captured base only. Rows with `is_unattributed` are
 * 'direct / none' (nothing measured) or '(not set)' (visit seen, dimension not
 * tagged) — two different facts, label them differently, never as a blank bar.
 * `attribution` (resolved|untagged|none) is the AUTHORITY on that, not the key
 * text: a real campaign named "direct / none" gets its own row and a
 * disambiguated `label`. Render `label`, filter on `key`.
 *
 * ⚠️ `revenue_basis` is 'order_window' here and 'click_cohort' on /roas. A page
 * drawing both MUST print them — the two will not tie out for the same dates,
 * by definition (see the service header).
 */
router.get('/marketing', async (req, res, next) => {
  try {
    send(res, await getMarketing({
      start: req.query.start,
      end: req.query.end,
      funnelId: req.query.funnel_id,
      dimension: req.query.dimension,
      limit: req.query.limit,
    }));
  } catch (err) {
    next(err);
  }
});

/**
 * GET /roas?funnel_id&days&dimension&limit
 *
 * ⚠️ CONTRACT: `cost` may be null and then `roas`/`cpa` are null too. Render
 * null as an em dash — NEVER as $0.00 or 0.0x. `cost_source` says where the
 * number came from and `cost_unknown_reason` says why there isn't one; both
 * are for the operator, put them in the row or its tooltip.
 * `bot_clicks` is included in `clicks` and excluded from `conversions`; their
 * cpc IS counted as cost and `cost_note` says so.
 *
 * ⚠️ `totals` IS NOT THE SUM OF `rows` — it folds the window's platform spend
 * once, including `untracked_campaigns` (spent money, zero clicks, no row).
 * Never recompute the footer client-side from the rows.
 * ⚠️ `revenue_basis` is 'click_cohort' here — see /marketing above.
 */
router.get('/roas', async (req, res, next) => {
  try {
    send(res, await getRoas({
      funnelId: req.query.funnel_id,
      days: req.query.days,
      dimension: req.query.dimension,
      limit: req.query.limit,
    }));
  } catch (err) {
    next(err);
  }
});

/**
 * GET /clicks?funnel_id&limit&network&start&end — the raw click ledger.
 * Bot rows are present and flagged (`bot`, `velocity_flag`): this is where an
 * operator checks what a ROAS row excluded. `start`/`end` are optional and
 * bound `first_seen` on Madrid days, so a ROAS row can link straight to the
 * clicks behind it; omit both for "most recent, unbounded".
 */
router.get('/clicks', async (req, res, next) => {
  try {
    send(res, await getClicks({
      funnelId: req.query.funnel_id,
      limit: req.query.limit,
      network: req.query.network,
      start: req.query.start,
      end: req.query.end,
    }));
  } catch (err) {
    next(err);
  }
});

/**
 * GET /spend-daily?start&end&funnel_id — daily spend, with the same day keys
 * Lane 1's series uses, plus the day's captured-base orders/sales so the daily
 * ROAS is a like-for-like division.
 * `spend` is null (not 0) on every day when spend is not KNOWN.
 */
router.get('/spend-daily', async (req, res, next) => {
  try {
    send(res, await getSpendDaily({
      start: req.query.start,
      end: req.query.end,
      funnelId: req.query.funnel_id,
    }));
  } catch (err) {
    next(err);
  }
});

/**
 * GET /definitions — served from the same constants the service computes
 * against, so an operator questioning a number can read exactly what it means
 * (and which timezone it was bucketed in) without reading the source.
 */
router.get('/definitions', (_req, res) => {
  res.json({
    definitions: ATTRIBUTION_DEFINITIONS,
    marketing_dimensions: MARKETING_DIMENSIONS,
    roas_dimensions: ROAS_DIMENSIONS,
    cost_sources: COST_SOURCES,
    timezone: REPORT_TZ,
  });
});

export default router;
