// Funnel health — live connection status for a funnel's payment gateways.
// Feeds the Funnel Settings modal's Payments-card pills and the
// Advanced → Health panel. Read-only, authenticated; never returns secrets.
//
// INTEGRATION HOOK (mount is in a shared file this lane must not edit — add
// the two lines to server/src/routes/index.js):
//   import funnelHealthRoutes from './funnelHealth.js';
//   app.use('/api/v1/funnel-health', funnelHealthRoutes);
//
// Until that mount lands, the identical status data is ALSO served by the
// lane-owned checkoutAdmin router, which is already mounted:
//   GET /api/v1/checkout/gateways/:funnelId/status
//   GET /api/v1/checkout/gateways/:funnelId/status/:gateway
// The client uses the checkoutAdmin path so the feature works today.
import { Router } from 'express';
import { authenticate } from '../middleware/auth.js';
import { requirePermission } from '../middleware/rbac.js';
import { GATEWAYS } from '../services/gatewayConfigs.js';
import { checkAll, checkGateway } from '../services/gatewayStatus.js';

const router = Router();

router.use(authenticate, requirePermission('checkout', 'access'));

// GET /gateways/:funnelId — status for every gateway (both modes + aggregate).
// TTL-cached server-side; ?force=1 bypasses (the Re-check button).
router.get('/gateways/:funnelId', async (req, res) => {
  try {
    const funnelId = String(req.params.funnelId || '').slice(0, 64);
    const force = req.query.force === '1';
    return res.json({ success: true, data: await checkAll(funnelId, { force }) });
  } catch (err) {
    console.error('[funnelHealth] gateways status failed:', err.message);
    return res.status(500).json({ success: false, error: { code: 'internal_error' } });
  }
});

// GET /gateways/:funnelId/:gateway — status for one gateway (?force=1 bypasses
// the TTL cache).
router.get('/gateways/:funnelId/:gateway', async (req, res) => {
  try {
    const gateway = String(req.params.gateway || '');
    if (!GATEWAYS[gateway]) {
      return res.status(404).json({ success: false, error: { code: 'unknown_gateway' } });
    }
    const funnelId = String(req.params.funnelId || '').slice(0, 64);
    const force = req.query.force === '1';
    return res.json({ success: true, data: await checkGateway(funnelId, gateway, { force }) });
  } catch (err) {
    console.error('[funnelHealth] gateway status failed:', err.message);
    return res.status(500).json({ success: false, error: { code: 'internal_error' } });
  }
});

export default router;
