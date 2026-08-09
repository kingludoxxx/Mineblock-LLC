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
    // `data` IS the portable file, byte for byte — the client writes exactly
    // this to disk. `meta.stripped` is a list of the KEY NAMES this deployment
    // refused to export (`settings.checkout.maps_api_key`,
    // `settings.tracking`), which is a map of where the credentials live. It
    // goes to the authenticated operator who asked and NEVER into the file
    // that gets handed to someone else — so it sits OUTSIDE `data`.
    return res.json({ success: true, data: result.envelope, meta: { stripped: result.stripped } });
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

    // ── REVIEW MED #3: FILE CONTENT MUST NOT SET REQUEST PARAMETERS ────────
    // Accepting a BARE envelope is a convenience (the downloaded file IS the
    // envelope). But when the body IS the envelope, every key in it is
    // attacker-authored file content — including a `name_override` an exporter
    // could have planted, which then silently renamed the funnel the importing
    // operator thought they were creating. Request semantics may only come from
    // the WRAPPER.
    //
    // So: `name_override` is read ONLY from the explicit
    // { envelope, name_override } form. In the bare form it is not read, and it
    // is stripped from the envelope object so it cannot be mistaken for one
    // later either.
    const wrapped = body.envelope !== undefined;
    let envelope = wrapped ? body.envelope : body;
    let nameOverride = wrapped ? body.name_override : undefined;

    if (!wrapped && envelope && typeof envelope === 'object' && !Array.isArray(envelope)) {
      const { name_override: _ignoredFromFile, ...rest } = envelope;
      envelope = rest;
    }

    if (nameOverride !== undefined && nameOverride !== null && typeof nameOverride !== 'string') {
      return fail(res, 400, 'name_override_must_be_a_string');
    }
    // Review #13: a blank (or whitespace-only) override is NOT an instruction
    // to name the funnel ''. It is an empty field the operator left alone, so
    // it falls back to the envelope's own name.
    if (typeof nameOverride === 'string' && !nameOverride.trim()) nameOverride = undefined;
    const result = await importFunnel({ envelope, nameOverride });
    if (!result.ok) return fail(res, result.status, result.error, result.detail);
    return res.status(201).json({ success: true, data: result.data });
  } catch (err) {
    console.error('[funnelTransfer] import failed:', err);
    return fail(res, 500, 'server_error');
  }
});

export default router;
