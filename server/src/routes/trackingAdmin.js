// Tracking admin — authenticated read surface over the attribution spine.
// Enough to PROVE attribution works (touches, clicks, conversions, delivery
// events, and the first-touch vs last-click split); a full analytics UI can
// come later. Follows the existing funnels route+permission pattern.
//
// Mount (integrator-owned, routes/index.js):
//   app.use('/api/v1/tracking-admin', trackingAdminRoutes);
import { Router } from 'express';
import { pgQuery } from '../db/pg.js';
import { authenticate } from '../middleware/auth.js';
import { requirePermission } from '../middleware/rbac.js';
import { ensureTrackingTables } from '../services/trackingSchema.js';

const router = Router();
router.use(authenticate, requirePermission('funnels', 'access'));

const clampLimit = (v, def = 100, max = 500) => Math.max(1, Math.min(parseInt(v, 10) || def, max));

// GET /:funnelId/touches — recent pageview touches.
router.get('/:funnelId/touches', async (req, res) => {
  try {
    await ensureTrackingTables();
    const limit = clampLimit(req.query.limit);
    const rows = await pgQuery(
      `SELECT id, vid, page_id, url, referrer, utm, click_ids, ts
       FROM lb_touches WHERE funnel_id = $1 ORDER BY ts DESC LIMIT $2`,
      [String(req.params.funnelId).slice(0, 64), limit]
    );
    return res.json({ success: true, data: { touches: rows } });
  } catch (err) {
    console.error('[trackingAdmin] touches failed:', err.message);
    return res.status(500).json({ success: false, error: { code: 'internal_error' } });
  }
});

// GET /:funnelId/clicks — the click-id vault (optionally ?converted=1).
router.get('/:funnelId/clicks', async (req, res) => {
  try {
    await ensureTrackingTables();
    const limit = clampLimit(req.query.limit);
    const params = [String(req.params.funnelId).slice(0, 64)];
    let filter = '';
    if (req.query.converted === '1') filter = ' AND converted = TRUE';
    else if (req.query.converted === '0') filter = ' AND converted = FALSE';
    params.push(limit);
    const rows = await pgQuery(
      `SELECT id, vid, network, click_id, click_key, struct, utm, cpc, country,
              device, bot, velocity_flag, converted, session_id, converted_at, ts
       FROM lb_clicks WHERE funnel_id = $1${filter} ORDER BY ts DESC LIMIT $2`,
      params
    );
    return res.json({ success: true, data: { clicks: rows } });
  } catch (err) {
    console.error('[trackingAdmin] clicks failed:', err.message);
    return res.status(500).json({ success: false, error: { code: 'internal_error' } });
  }
});

// GET /:funnelId/events — the delivery/debug feed (lb_tracking_events).
router.get('/:funnelId/events', async (req, res) => {
  try {
    await ensureTrackingTables();
    const limit = clampLimit(req.query.limit);
    const rows = await pgQuery(
      `SELECT id, platform, pixel_id, event_name, event_id, status, source, idk,
              emq, value, error, ts
       FROM lb_tracking_events WHERE funnel_id = $1 ORDER BY ts DESC LIMIT $2`,
      [String(req.params.funnelId).slice(0, 64), limit]
    );
    return res.json({ success: true, data: { events: rows } });
  } catch (err) {
    console.error('[trackingAdmin] events failed:', err.message);
    return res.status(500).json({ success: false, error: { code: 'internal_error' } });
  }
});

// GET /:funnelId/attribution — the deliberately-UNRECONCILED split
// (DECISIONS #8): acquisition = FIRST-TOUCH new visitors per network (from the
// permanent registry); revenue = LAST-CLICK converted clicks per network (from
// the click vault). They share network labels but NOT denominators — this
// endpoint returns them as SEPARATE arrays, never divided into one another.
router.get('/:funnelId/attribution', async (req, res) => {
  try {
    await ensureTrackingTables();
    const funnelId = String(req.params.funnelId).slice(0, 64);
    // Acquisition: distinct new visitors by their FIRST-touch network.
    const acquisition = await pgQuery(
      `SELECT COALESCE(network, 'direct') AS network, COUNT(*)::int AS new_visitors
       FROM lb_visitor_firstseen WHERE funnel_id = $1
       GROUP BY 1 ORDER BY 2 DESC`,
      [funnelId]
    );
    // Revenue: converted clicks by their LAST-click network (one row per
    // stamped click). A separate table, a separate denominator.
    const revenue = await pgQuery(
      `SELECT COALESCE(network, 'direct') AS network, COUNT(*)::int AS conversions
       FROM lb_clicks WHERE funnel_id = $1 AND converted = TRUE
       GROUP BY 1 ORDER BY 2 DESC`,
      [funnelId]
    );
    return res.json({
      success: true,
      data: {
        note: 'first-touch acquisition and last-click revenue are NOT reconciled (DECISIONS #8): shared labels, separate denominators — do not divide one by the other.',
        acquisition_first_touch: acquisition,
        revenue_last_click: revenue,
      },
    });
  } catch (err) {
    console.error('[trackingAdmin] attribution failed:', err.message);
    return res.status(500).json({ success: false, error: { code: 'internal_error' } });
  }
});

// GET /:funnelId/queue — postback queue + breaker overview (operator forensics).
router.get('/:funnelId/queue', async (req, res) => {
  try {
    await ensureTrackingTables();
    const funnelId = String(req.params.funnelId).slice(0, 64);
    const counts = await pgQuery(
      `SELECT status, COUNT(*)::int AS n FROM lb_postback_queue WHERE funnel_id = $1 GROUP BY status`,
      [funnelId]
    );
    const breakers = await pgQuery(
      `SELECT scope_id, fails, open_until FROM lb_postback_breakers
       WHERE funnel_id = $1 AND (open_until IS NULL OR open_until > NOW() - INTERVAL '1 day')`,
      [funnelId]
    );
    return res.json({ success: true, data: { queue: counts, breakers } });
  } catch (err) {
    console.error('[trackingAdmin] queue failed:', err.message);
    return res.status(500).json({ success: false, error: { code: 'internal_error' } });
  }
});

export default router;
