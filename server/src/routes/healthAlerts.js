// HEALTH ALERT ROUTES — read the operational alert feed, acknowledge an alert.
//
// ── AUTH: A REAL PERMISSION, SPLIT READ FROM WRITE ─────────────────────────
//
// An earlier revision of this file gated everything on the existing
// ('audit','read'), arguing that a new permission key would be held by no
// seeded role and ship the feature unreachable. THAT PREMISE WAS WRONG, and
// migrations 086-090 disprove it: `086_add_orders_permission.sql`,
// `087_add_customers_permission.sql`, `088_add_funnels_permission.sql` and
// `090_add_checkout_permission.sql` each MINT a new permission and grant it in
// the same change. Minting one is the established pattern here, not an
// obstacle. Borrowing `audit:read` also had a consequence worth refusing: it
// let a Viewer ACKNOWLEDGE, i.e. mark a production fault as seen, purely
// because they could read the audit log.
//
// So this lane ships `091_add_health_alerts_permission.sql`:
//   'Team - Full Access' → health-alerts: ["read", "ack"]
//   'Manager'            → health-alerts: ["read"]
//   'Viewer'             → NOTHING. Deliberate.
//   SuperAdmin           → already {"*": ["*"]}, untouched.
//
// ⚠️ THE VIEWER DECISION IS A REAL BEHAVIOUR CHANGE, STATED PLAINLY: because
// the list moved off `audit:read` and onto `health-alerts:read`, a Viewer now
// gets 403 on the alert FEED as well as on ack. That is the conservative
// direction — a role defined as "read-only access to departments and audit
// logs" (seed_roles.js:38) was never scoped to production fault data, and a
// permission is cheap to grant from the Team page if an operator disagrees.
// The alternative (leaving reads on audit:read) would have left the surface's
// audience defined by an unrelated permission's history.
//
// The gates are SPLIT because reading a fault and declaring it handled are
// different authorities:
//   health-alerts:read — GET /            GET /meta
//   health-alerts:ack  — POST /:id/ack    POST /sweep
// /sweep sits on the WRITE gate on purpose: it is not a read. It evaluates
// every rule and WRITES any alert they earn.
//
// Errors are structured ({ success:false, error:{ code, detail? } }), matching
// funnelTransfer.js / splitTests.js.
import { Router } from 'express';
import { authenticate } from '../middleware/auth.js';
import { requirePermission } from '../middleware/rbac.js';
import {
  ensureHealthAlertTables, listAlerts, ackAlert, runHealthAlertSweep,
  startHealthAlertSweep, SEVERITIES,
} from '../services/healthAlerts.js';

const router = Router();
// Authentication is universal; AUTHORISATION is per-route below.
router.use(authenticate);
const canRead = requirePermission('health-alerts', 'read');
const canAck = requirePermission('health-alerts', 'ack');

const fail = (res, status, code, detail) =>
  res.status(status).json({ success: false, error: detail ? { code, detail } : { code } });

// THE SWEEP STARTS ON MODULE LOAD, not on first request: an alert surface that
// only produces alerts once somebody opens it is a surface that tells you
// everything was fine right up until you looked. Same posture as domainHub's
// verify sweep (domainHub.js:30) and the tracking sweeps (trackingPublic.js:28).
// Disabled with HEALTH_ALERTS_SWEEP_DISABLED=1 — no deploy needed, and the test
// harness sets it so no timer races its assertions.
startHealthAlertSweep();

// GET /api/v1/health-alerts?limit&offset&severity&acked
//
// UNACKED FIRST, then newest first. `unacked` in the response is the WHOLE
// surface's count and ignores the filters — it is the badge, and a filter that
// shrank it would read as progress that did not happen.
router.get('/', canRead, async (req, res) => {
  try {
    await ensureHealthAlertTables();
    // 'true' / 'false' as strings; anything else means "no ack filter".
    const ackedRaw = req.query.acked;
    const acked = ackedRaw === 'true' ? true : ackedRaw === 'false' ? false : undefined;

    const result = await listAlerts({
      limit: req.query.limit,
      offset: req.query.offset,
      severity: req.query.severity,
      acked,
    });
    if (!result.ok) return fail(res, result.status, result.error, result.detail);

    const { ok: _ok, ...data } = result;
    return res.json({ success: true, data });
  } catch (err) {
    console.error('[healthAlerts] list failed:', err);
    return fail(res, 500, 'server_error');
  }
});

// GET /api/v1/health-alerts/meta — the severity vocabulary, so the client's
// badges and filters cannot drift from the server's validator.
router.get('/meta', canRead, async (req, res) => {
  res.json({ success: true, data: { severities: SEVERITIES } });
});

// POST /api/v1/health-alerts/:id/ack
//
// IDEMPOTENT. A second ack answers 200 with the row unchanged (original
// acked_at / acked_by preserved) and `already_acked: true`, so a double-click
// is never a 409 the operator has to interpret.
router.post('/:id/ack', canAck, async (req, res) => {
  try {
    await ensureHealthAlertTables();
    const result = await ackAlert(req.params.id, req.user?.id);
    if (!result.ok) return fail(res, result.status, result.error, result.detail);
    return res.json({ success: true, data: { alert: result.alert, already_acked: result.already_acked } });
  } catch (err) {
    console.error('[healthAlerts] ack failed:', err);
    return fail(res, 500, 'server_error');
  }
});

// POST /api/v1/health-alerts/sweep?dry=1 — run the rules once, now.
//
// The timer is the normal producer; this exists so an operator who just fixed
// something does not have to wait up to 5 minutes to see the surface agree, and
// so the sweep is reachable at all on a deployment that disabled the timer.
//
// ── `dry` DEFAULTS TO TRUE, AND `dry` DOES NOT MEAN "CHANGES NOTHING" ───────
// It means DOES NOT RE-ANCHOR THE BASELINES. Checks still run and any alert
// they earn is still written — a refresh that hid a genuine fault would be
// worse than useless. What it must not do is CONSUME the comparison point:
// needs_review's baseline is the previous observation, and the panel's refresh
// button firing three times would otherwise anchor 40 → 41 → 42 and report the
// 40 → 200 climb as three quiet +1 steps. The TIMER owns the series and
// anchors; a person poking the surface does not.
//
// Pass ?dry=0 (or dry=false) to anchor deliberately.
router.post('/sweep', canAck, async (req, res) => {
  try {
    const dryRaw = String(req.query.dry ?? '1').toLowerCase();
    const anchor = dryRaw === '0' || dryRaw === 'false' || dryRaw === 'no';
    const result = await runHealthAlertSweep({ anchor });
    return res.json({ success: true, data: result });
  } catch (err) {
    console.error('[healthAlerts] sweep failed:', err);
    return fail(res, 500, 'server_error');
  }
});

export default router;
