// Funnel analytics — authed read-only reporting surface (SELF-CONTAINED, NEW FILE).
//
// Follows the repo's route+permission pattern (funnels.js / splitTests.js):
//   router.use(authenticate, requirePermission('funnels', 'access'))
//
// PERMISSION — DECISION MADE, same reasoning splitTests.js recorded: this
// router reuses the existing 'funnels':'access' permission rather than minting
// an 'analytics' permission via an additive RBAC migration. Reporting on a
// funnel is a sub-capability of the funnel builder, the SuperAdmin wildcard
// already covers it, and a new permission means editing the shared RBAC
// seed/migration that the lane-isolation constraint asks me to leave alone.
// To split it out later, change the requirePermission line here and add a
// migration granting 'analytics':['access'].
//
// ⚠️ INTEGRATION HOOK — this file does NOT edit routes/index.js. The mount is:
//     import funnelAnalyticsRoutes from './funnelAnalytics.js';
//     app.use('/api/v1/funnel-analytics', funnelAnalyticsRoutes);
//
// EVERY handler here is READ-ONLY. There is no POST/PUT/PATCH/DELETE and there
// must never be: this subsystem reports on money, it never touches it.
import { Router } from 'express';
import { pgQuery } from '../db/pg.js';
import { authenticate } from '../middleware/auth.js';
import { requirePermission } from '../middleware/rbac.js';
import { readResults } from '../services/splitCredits.js';
import {
  getFunnelOverview,
  getPageMetrics,
  getSplitResults,
  parseWindow,
  ANALYTICS_METRIC_DEFINITIONS,
} from '../services/funnelAnalytics.js';

const router = Router();
router.use(authenticate, requirePermission('funnels', 'access'));

// Map a service-level refusal onto a status code. A bad window is the caller's
// fault (400); a missing funnel/page/test is 404. Nothing else leaks.
const ERROR_STATUS = {
  invalid_date_format: 400,
  invalid_date: 400,
  to_before_from: 400,
  window_too_large: 400,
  invalid_funnel_id: 400,
  invalid_page_id: 400,
  invalid_test_id: 400,
  page_not_found: 404,
  test_not_found: 404,
};

function send(res, result) {
  if (result?.error) {
    return res.status(ERROR_STATUS[result.error] ?? 400).json({ error: result.error });
  }
  return res.json(result);
}

// Params arrive as strings from the query string and are handed to the service,
// which validates them against a strict YYYY-MM-DD regex and then passes them
// to pgQuery as BOUND PARAMETERS. No date value is ever concatenated into SQL
// anywhere in this subsystem.
const win = (req) => ({ from: req.query.from, to: req.query.to });

/**
 * GET /funnel/:funnelId/overview?from&to
 *
 * ⚠️ INTEGRATION HOOK — THE CANVAS OVERLAY FEED.
 * The canvas lane should read `pages[]` and key each node by `page_id`:
 *     { page_id, visitors, ctr, cvr }
 * Those three fields are the contract; everything else on the row is additive
 * and safe to ignore. `ctr` is a LABELLED PROXY (`ctr_is_proxy: true`,
 * `ctr_basis` names which proxy won) — render it with a marker, not as a
 * measured click-through rate. Any of visitors/ctr/cvr may be `null` when a
 * source degraded (see `warnings[]` / `degraded`); render null as "—", never
 * as 0, because 0 means "no traffic" and null means "we could not measure".
 */
router.get('/funnel/:funnelId/overview', async (req, res, next) => {
  try {
    send(res, await getFunnelOverview({ funnelId: req.params.funnelId, ...win(req) }));
  } catch (err) {
    next(err);
  }
});

/** GET /funnel/:funnelId/pages/:pageId?from&to — full metric set for one page. */
router.get('/funnel/:funnelId/pages/:pageId', async (req, res, next) => {
  try {
    send(
      res,
      await getPageMetrics({
        funnelId: req.params.funnelId,
        pageId: req.params.pageId,
        ...win(req),
      })
    );
  } catch (err) {
    next(err);
  }
});

/**
 * GET /split/:testId/results?from&to
 *
 * Per-arm metric table + verdict + the honest window disclosure. The credits
 * ledger (splitCredits.readResults) is returned VERBATIM under `ledger` for
 * reconciliation — its math is reused, never reimplemented.
 */
router.get('/split/:testId/results', async (req, res, next) => {
  try {
    send(
      res,
      await getSplitResults(
        { testId: req.params.testId, ...win(req) },
        { query: pgQuery, readLedger: readResults }
      )
    );
  } catch (err) {
    next(err);
  }
});

/**
 * GET /funnels — the funnel picker's options. A thin convenience read so the
 * Analytics page does not have to depend on the funnels router's response
 * shape (which another lane owns and may change).
 */
router.get('/funnels', async (_req, res, next) => {
  try {
    const rows = await pgQuery(
      `SELECT id, slug, name, status FROM funnels
       WHERE NOT archived ORDER BY updated_at DESC LIMIT 200`
    );
    res.json({ funnels: rows });
  } catch (err) {
    next(err);
  }
});

/** GET /funnel/:funnelId/split-tests — the split picker's options. */
router.get('/funnel/:funnelId/split-tests', async (req, res, next) => {
  try {
    const rows = await pgQuery(
      `SELECT id, name, scope, enabled, archived, created_at
       FROM lb_split_tests WHERE funnel_id = $1 AND NOT archived
       ORDER BY created_at DESC LIMIT 100`,
      [String(req.params.funnelId).slice(0, 64)]
    );
    res.json({ tests: rows });
  } catch (err) {
    // A funnel with no split subsystem yet must not break the Analytics page.
    res.json({ tests: [], warning: String(err?.message || err).slice(0, 200) });
  }
});

/**
 * GET /definitions — the metric definitions, served from the same constant the
 * service computes against. An operator questioning a number can read exactly
 * what it means without reading the source.
 */
router.get('/definitions', (_req, res) => {
  res.json({ definitions: ANALYTICS_METRIC_DEFINITIONS });
});

// Exported for the harness: lets the window validator be exercised by
// execution without booting the auth stack.
export { parseWindow };
export default router;
