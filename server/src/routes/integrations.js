// Integrations admin — the authed config surface for third-party marketing
// integrations (Klaviyo first). Follows the trackingAdmin route+permission
// pattern; every response is MASKED (api_key_set boolean, never a key byte).
//
// Mount (integrator-owned, routes/index.js):
//   app.use('/api/v1/integrations', integrationsRoutes);
import { Router } from 'express';
import { authenticate } from '../middleware/auth.js';
import { requirePermission } from '../middleware/rbac.js';
import {
  getKlaviyoPublicView, patchKlaviyoConfig, getAccount, getLists, writeLastTest,
} from '../services/klaviyoService.js';

const router = Router();
router.use(authenticate, requirePermission('funnels', 'access'));

// GET /klaviyo — masked config + the PERSISTED last test result (the account
// name lives in last_test.account_name). A plain read NEVER calls Klaviyo —
// live account info comes only from POST /klaviyo/test.
router.get('/klaviyo', async (req, res) => {
  try {
    const view = await getKlaviyoPublicView();
    return res.json({ success: true, data: { klaviyo: view } });
  } catch (err) {
    console.error('[integrations] klaviyo read failed:', err.message);
    return res.status(500).json({ success: false, error: { code: 'internal_error' } });
  }
});

// PUT /klaviyo — write-only upsert. api_key: ''=keep, null=clear, value=set
// (encrypted at rest). Returns the masked view, never the key.
router.put('/klaviyo', async (req, res) => {
  try {
    const body = req.body && typeof req.body === 'object' && !Array.isArray(req.body) ? req.body : {};
    if (body.api_key !== undefined && body.api_key !== null && typeof body.api_key !== 'string') {
      return res.status(422).json({ success: false, error: { code: 'invalid_api_key_type' } });
    }
    // Review #10: strict input shapes — enabled is true/false/undefined only;
    // list_id_default is a string ≤64 chars, null (clear) or undefined (keep).
    if (body.enabled !== undefined && typeof body.enabled !== 'boolean') {
      return res.status(400).json({ success: false, error: { code: 'invalid_enabled_type' } });
    }
    if (body.list_id_default !== undefined && body.list_id_default !== null
      && (typeof body.list_id_default !== 'string' || body.list_id_default.length > 64)) {
      return res.status(400).json({ success: false, error: { code: 'invalid_list_id' } });
    }
    const view = await patchKlaviyoConfig({
      api_key: body.api_key,
      enabled: body.enabled,
      list_id_default: body.list_id_default,
    });
    return res.json({ success: true, data: { klaviyo: view } });
  } catch (err) {
    console.error('[integrations] klaviyo write failed:', err.message);
    return res.status(500).json({ success: false, error: { code: 'internal_error' } });
  }
});

// POST /klaviyo/test — live round-trip with the STORED key (GET /accounts/).
// Persists the outcome so the card's status chip survives reloads.
//
// Review #10: in-memory guard — ONE test in flight at a time (the vendor
// endpoint burst-throttles at ~1/s and a stuck button must not stack calls);
// concurrent attempts get 429. The 60s stale-clear only matters if a test
// somehow escapes its finally — belt and suspenders, not a rate limit.
let testInFlightSince = 0;
router.post('/klaviyo/test', async (req, res) => {
  if (testInFlightSince && Date.now() - testInFlightSince < 60_000) {
    return res.status(429).json({ success: false, error: { code: 'test_in_progress' } });
  }
  testInFlightSince = Date.now();
  try {
    const result = await getAccount();
    if (!result.ok) {
      await writeLastTest({ ok: false, error: result.error || 'unknown' });
      // Fail-closed but 200: the test RAN, its outcome is the payload.
      return res.json({ success: true, data: { ok: false, error: result.error || 'unknown' } });
    }
    await writeLastTest({ ok: true, account_name: result.account.name });
    return res.json({ success: true, data: { ok: true, account: result.account } });
  } catch (err) {
    console.error('[integrations] klaviyo test failed:', err.message);
    return res.status(500).json({ success: false, error: { code: 'internal_error' } });
  } finally {
    testInFlightSince = 0;
  }
});

// GET /klaviyo/lists — proxy for the default-list picker.
router.get('/klaviyo/lists', async (req, res) => {
  try {
    const result = await getLists();
    if (!result.ok) {
      return res.json({ success: true, data: { ok: false, error: result.error || 'unknown', lists: [] } });
    }
    return res.json({ success: true, data: { ok: true, lists: result.lists } });
  } catch (err) {
    console.error('[integrations] klaviyo lists failed:', err.message);
    return res.status(500).json({ success: false, error: { code: 'internal_error' } });
  }
});

export default router;
