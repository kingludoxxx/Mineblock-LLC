// FUNNEL TRANSFER ROUTES — export one funnel as a portable JSON envelope,
// import an envelope as a NEW draft funnel.
//
// Auth is the sibling posture exactly (funnels.js:23, splitTests.js:28):
// authenticate + requirePermission('funnels', 'access'). Both endpoints are
// operator surfaces; nothing here is public.
//
// ⚠️ EXPORT IS A READ OF EVERYTHING AN OPERATOR CAN SEE, IN ONE FILE. That is
// precisely why the settings allowlist lives in the service and not here: the
// route must not be able to widen it by accident. funnel-os's equivalent
// endpoint (GET /websites/{wid}/export) returns unredacted gateway ciphertext
// and full store credential documents to any editor — this port does not.
//
// Errors are structured ({ success:false, error:{ code, detail? } }), matching
// splitTests.js. The status codes are load-bearing:
//   400 — the envelope is not an envelope (bad/missing tag, wrong shape)
//   413 — a cap was exceeded (page count, per-page blocks, total bytes)
//   422 — the shape is fine but the CONTENT is unprocessable (invalid blocks)
import { Router } from 'express';
import { authenticate } from '../middleware/auth.js';
import { requirePermission } from '../middleware/rbac.js';
import { ensureTables } from './funnels.js';
import { exportFunnel, importFunnel } from '../services/funnelTransfer.js';

const router = Router();
router.use(authenticate, requirePermission('funnels', 'access'));

const fail = (res, status, code, detail) =>
  res.status(status).json({ success: false, error: detail ? { code, detail } : { code } });

// GET /api/v1/funnel-transfer/:funnelId/export
//
// Answers the envelope itself under the usual { success, data } wrapper. The
// client writes `data` to a .json file — that file is what import consumes, so
// the two shapes must never drift apart.
router.get('/:funnelId/export', async (req, res) => {
  try {
    await ensureTables();
    const result = await exportFunnel(req.params.funnelId);
    if (!result.ok) return fail(res, result.status, result.error, result.detail);
    return res.json({ success: true, data: result.envelope });
  } catch (err) {
    console.error('[funnelTransfer] export failed:', err);
    return fail(res, 500, 'server_error');
  }
});

// POST /api/v1/funnel-transfer/import  { envelope, name_override? }
//
// Creates a NEW funnel (always status='draft', never a domain) plus every page
// in ONE transaction. On any refusal NOTHING is written — the harness proves
// that by counting funnels and pages either side of a deliberately-invalid
// import.
router.post('/import', async (req, res) => {
  try {
    await ensureTables();
    const body = req.body || {};
    // Accept a bare envelope too: the operator's downloaded file IS the
    // envelope, and a client that posts it directly should not get a shape
    // error for guessing the friendlier of two reasonable calls.
    const envelope = body.envelope !== undefined ? body.envelope : body;
    const nameOverride = body.name_override !== undefined ? body.name_override : undefined;
    if (nameOverride !== undefined && nameOverride !== null && typeof nameOverride !== 'string') {
      return fail(res, 400, 'name_override_must_be_a_string');
    }
    const result = await importFunnel({ envelope, nameOverride });
    if (!result.ok) return fail(res, result.status, result.error, result.detail);
    return res.status(201).json({ success: true, data: result.data });
  } catch (err) {
    console.error('[funnelTransfer] import failed:', err);
    return fail(res, 500, 'server_error');
  }
});

export default router;
