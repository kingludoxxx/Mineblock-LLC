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

// GET /klaviyo — masked config + last test result. `account` rides along
// only when a test has already succeeded (no live API call on a plain read).
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
router.post('/klaviyo/test', async (req, res) => {
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
