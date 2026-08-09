// HEALTH ALERT ROUTES — read the operational alert feed, acknowledge an alert.
//
// AUTH — DECISION MADE. The house pattern is one router-level gate
// (funnelTransfer.js:26, splitTests.js:28) naming an EXISTING permission
// rather than minting a new one: splitTests.js says so explicitly ("rather
// than minting a new 'split' permission"). A brand-new 'health-alerts' key
// would be held by NO seeded role except SuperAdmin's wildcard
// (seeds/seed_roles.js:14) — i.e. the feature would ship unreachable for
// Admin, Manager and Viewer, which is a 403 wearing a feature's clothes.
//
// So the gate is ('audit', 'read'): the closest existing analogue — an
// append-only operational record — and one every seeded role already carries
// (seed_roles.js:23, 33, 43). ⚠️ THE CONSEQUENCE IS DELIBERATE AND WORTH
// STATING: a Viewer can ACK. Acking annotates an operational log; it deletes
// nothing, publishes nothing and changes no business state. If that ever stops
// being acceptable, the fix is a real 'health-alerts' permission added to the
// role seed FIRST and only then referenced here — not a stricter check against
// a permission nobody holds.
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
router.use(authenticate, requirePermission('audit', 'read'));

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
router.get('/', async (req, res) => {
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

// POST /api/v1/health-alerts/:id/ack
//
// IDEMPOTENT. A second ack answers 200 with the row unchanged (original
// acked_at / acked_by preserved) and `already_acked: true`, so a double-click
// is never a 409 the operator has to interpret.
router.post('/:id/ack', async (req, res) => {
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

// POST /api/v1/health-alerts/sweep — run the rules once, now.
//
// The timer is the normal producer; this exists so an operator who just fixed
// something does not have to wait up to 5 minutes to see the surface agree,
// and so the sweep is reachable at all on a deployment that disabled the timer.
// It writes nothing the timer would not have written, and the per-kind cooldown
// means hammering it cannot manufacture rows.
router.post('/sweep', async (req, res) => {
  try {
    const result = await runHealthAlertSweep();
    return res.json({ success: true, data: result });
  } catch (err) {
    console.error('[healthAlerts] sweep failed:', err);
    return fail(res, 500, 'server_error');
  }
});

// GET /api/v1/health-alerts/meta — the severity vocabulary, so the client's
// badges and filters cannot drift from the server's validator.
router.get('/meta', async (req, res) => {
  res.json({ success: true, data: { severities: SEVERITIES } });
});

export default router;
