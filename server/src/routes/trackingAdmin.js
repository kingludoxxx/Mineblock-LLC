// Tracking admin — authenticated read surface over the attribution spine.
// Enough to PROVE attribution works (touches, clicks, conversions, delivery
// events, and the first-touch vs last-click split); a full analytics UI can
// come later. Follows the existing funnels route+permission pattern.
//
// Mount (integrator-owned, routes/index.js):
//   app.use('/api/v1/tracking-admin', trackingAdminRoutes);
import { Router } from 'express';
import crypto from 'crypto';
import { pgQuery } from '../db/pg.js';
import { authenticate } from '../middleware/auth.js';
import { requirePermission } from '../middleware/rbac.js';
import { ensureTrackingTables } from '../services/trackingSchema.js';
import { encryptSecret } from '../services/gatewayConfigs.js';
import { CLICK_ID_NETWORK } from '../services/trackingClicks.js';

const router = Router();
router.use(authenticate, requirePermission('funnels', 'access'));

const clampLimit = (v, def = 100, max = 500) => Math.max(1, Math.min(parseInt(v, 10) || def, max));

// ── network registry — the kinds the write surface accepts ──────────────────
// One entry per supported ad network. `network` is the CLICK_ID_NETWORK label
// (drives click_id_params in the summary); `secrets` are encrypted at rest via
// the gatewayConfigs pattern and surfaced ONLY as <field>_set booleans;
// `plain` fields round-trip as values. Structure is open for ga4 / google_ads
// / gtm later — add an entry, no route changes needed.
export const TRACKING_NETWORKS = {
  meta_pixel: {
    network: 'meta',
    secrets: ['capi_token'],
    plain: ['test_event_code', 'graph_version'],
  },
};
const PIXEL_MODES = new Set(['native', 's2s', 'hybrid']);
// Same shape trackingDelivery.graphVersion accepts — reject bad input at
// WRITE time too, so the stored config never silently falls back.
const GRAPH_VERSION_RE = /^v\d{1,3}\.\d{1,3}$/;

const funnelParam = (req) => String(req.params.funnelId).slice(0, 64);

// Masked read view of one lb_pixels row (or an unconfigured registry kind).
// An allow-list, like gatewayConfigs.publicView — a secret NEVER leaves the
// server, not even encrypted.
function networkView(kind, row) {
  const spec = TRACKING_NETWORKS[kind];
  const cfg = (row && row.config && typeof row.config === 'object') ? row.config : {};
  const out = {
    kind,
    network: spec.network,
    configured: Boolean(row),
    pixel_id: row ? String(row.pixel_id || '') : '',
    mode: row ? String(row.mode || 'hybrid') : 'hybrid',
    enabled: row ? Boolean(row.enabled) : false,
    updated_at: row ? row.updated_at : null,
  };
  for (const f of spec.secrets) out[`${f}_set`] = Boolean(cfg[f]);
  for (const f of spec.plain) out[f] = cfg[f] == null ? '' : String(cfg[f]);
  return out;
}

async function loadPixelRow(funnelId, kind) {
  const rows = await pgQuery(
    `SELECT id, funnel_id, kind, pixel_id, mode, enabled, config, updated_at
     FROM lb_pixels WHERE funnel_id = $1 AND kind = $2`,
    [funnelId, kind]
  );
  return rows.length ? rows[0] : null;
}

// GET /:funnelId/networks — every registry kind, configured or not, masked.
router.get('/:funnelId/networks', async (req, res) => {
  try {
    await ensureTrackingTables();
    const funnelId = funnelParam(req);
    const rows = await pgQuery(
      `SELECT id, kind, pixel_id, mode, enabled, config, updated_at
       FROM lb_pixels WHERE funnel_id = $1`,
      [funnelId]
    );
    const byKind = new Map(rows.map((r) => [r.kind, r]));
    const networks = Object.keys(TRACKING_NETWORKS)
      .map((kind) => networkView(kind, byKind.get(kind) || null));
    return res.json({ success: true, data: { networks } });
  } catch (err) {
    console.error('[trackingAdmin] networks list failed:', err.message);
    return res.status(500).json({ success: false, error: { code: 'internal_error' } });
  }
});

// GET /:funnelId/networks/:kind — one kind, masked.
router.get('/:funnelId/networks/:kind', async (req, res) => {
  try {
    const kind = String(req.params.kind || '');
    if (!TRACKING_NETWORKS[kind]) {
      return res.status(400).json({ success: false, error: { code: 'unknown_kind' } });
    }
    await ensureTrackingTables();
    const row = await loadPixelRow(funnelParam(req), kind);
    return res.json({ success: true, data: { network: networkView(kind, row) } });
  } catch (err) {
    console.error('[trackingAdmin] network read failed:', err.message);
    return res.status(500).json({ success: false, error: { code: 'internal_error' } });
  }
});

// PUT /:funnelId/networks/:kind — upsert the per-funnel network config.
// Write semantics for capi_token (write-only, like gateway creds):
//   ''            → leave the stored token unchanged (a masked form re-submit
//                   must never wipe or re-encrypt the credential)
//   null          → clear the stored token
//   'EAAB…'       → encrypt (AES-256-GCM, 'gcm1:' prefix) and store
// Plain fields (test_event_code, graph_version): undefined keeps, null/''
// clears, a value replaces. The response is the masked view — the token is
// NEVER echoed, in any state, on any path.
router.put('/:funnelId/networks/:kind', async (req, res) => {
  try {
    const kind = String(req.params.kind || '');
    const spec = TRACKING_NETWORKS[kind];
    if (!spec) {
      return res.status(400).json({ success: false, error: { code: 'unknown_kind' } });
    }
    const b = (req.body && typeof req.body === 'object') ? req.body : {};
    if (b.mode !== undefined && !PIXEL_MODES.has(b.mode)) {
      return res.status(400).json({ success: false, error: { code: 'invalid_mode' } });
    }
    const pixelId = b.pixel_id === undefined ? undefined : String(b.pixel_id || '').trim().slice(0, 64);
    await ensureTrackingTables();
    const funnelId = funnelParam(req);
    const existing = await loadPixelRow(funnelId, kind);
    // pixel_id is required for a NEW row; an existing row may omit it to keep
    // the stored value (same keep-on-undefined rule as the other fields).
    const finalPixelId = pixelId !== undefined && pixelId !== '' ? pixelId
      : (existing ? existing.pixel_id : '');
    if (!finalPixelId) {
      return res.status(400).json({ success: false, error: { code: 'pixel_id_required' } });
    }
    if (b.graph_version !== undefined && b.graph_version !== null && String(b.graph_version).trim() !== ''
        && !GRAPH_VERSION_RE.test(String(b.graph_version).trim())) {
      return res.status(400).json({ success: false, error: { code: 'invalid_graph_version' } });
    }

    const config = { ...((existing && existing.config && typeof existing.config === 'object') ? existing.config : {}) };
    for (const f of spec.secrets) {
      const v = b[f];
      if (v === undefined) continue;              // absent → keep
      if (v === null) { delete config[f]; continue; } // explicit null → clear
      const t = String(v).trim();
      if (t === '') continue;                     // '' → keep (masked re-submit)
      config[f] = encryptSecret(t);
    }
    for (const f of spec.plain) {
      const v = b[f];
      if (v === undefined) continue;              // absent → keep
      const t = v === null ? '' : String(v).trim();
      if (t === '') { delete config[f]; continue; } // null/'' → clear
      config[f] = t.slice(0, 128);
    }

    const mode = b.mode !== undefined ? b.mode : (existing ? existing.mode : 'hybrid');
    const enabled = b.enabled !== undefined ? Boolean(b.enabled) : (existing ? Boolean(existing.enabled) : true);
    const rows = await pgQuery(
      `INSERT INTO lb_pixels (id, funnel_id, kind, pixel_id, mode, enabled, config, created_at, updated_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7, NOW(), NOW())
       ON CONFLICT (funnel_id, kind) DO UPDATE SET
         pixel_id = EXCLUDED.pixel_id,
         mode = EXCLUDED.mode,
         enabled = EXCLUDED.enabled,
         config = EXCLUDED.config,
         updated_at = NOW()
       RETURNING id, funnel_id, kind, pixel_id, mode, enabled, config, updated_at`,
      [`px_${crypto.randomBytes(9).toString('hex')}`, funnelId, kind, finalPixelId, mode, enabled, config]
    );
    return res.json({ success: true, data: { network: networkView(kind, rows[0]) } });
  } catch (err) {
    // err.message can never contain the token: encryptSecret throws only on
    // key-config problems, before any secret reaches the message.
    console.error('[trackingAdmin] network upsert failed:', err.message);
    return res.status(500).json({ success: false, error: { code: 'internal_error' } });
  }
});

// GET /:funnelId/tracking/summary — per-kind delivery health for the settings
// UI: 24h counters from lb_tracking_events, breaker state, whether the SERVER
// channel is actually ready to fire, and which URL params identify this
// network's clicks. failed_24h counts terminal outcomes (skipped/error);
// queued_24h is surfaced separately because a queued event is pending retry,
// not failed.
router.get('/:funnelId/tracking/summary', async (req, res) => {
  try {
    await ensureTrackingTables();
    const funnelId = funnelParam(req);
    const [pixelRows, countRows, breakerRows] = await Promise.all([
      pgQuery(
        `SELECT id, kind, pixel_id, mode, enabled, config FROM lb_pixels WHERE funnel_id = $1`,
        [funnelId]
      ),
      pgQuery(
        `SELECT platform,
                COUNT(*) FILTER (WHERE status = 'sent')::int AS sent_24h,
                COUNT(*) FILTER (WHERE status IN ('skipped', 'error'))::int AS failed_24h,
                COUNT(*) FILTER (WHERE status = 'deduped')::int AS deduped_24h,
                COUNT(*) FILTER (WHERE status = 'queued')::int AS queued_24h
         FROM lb_tracking_events
         WHERE funnel_id = $1 AND ts > NOW() - INTERVAL '24 hours'
         GROUP BY platform`,
        [funnelId]
      ),
      pgQuery(
        `SELECT scope_id, fails, open_until FROM lb_postback_breakers WHERE funnel_id = $1`,
        [funnelId]
      ),
    ]);
    const pixelByKind = new Map(pixelRows.map((r) => [r.kind, r]));
    const countByPlatform = new Map(countRows.map((r) => [r.platform, r]));
    const paramsByNetwork = {};
    for (const [param, network] of CLICK_ID_NETWORK) {
      (paramsByNetwork[network] = paramsByNetwork[network] || []).push(param);
    }
    const now = Date.now();
    const networks = Object.entries(TRACKING_NETWORKS).map(([kind, spec]) => {
      // lb_tracking_events.platform is the kind minus '_pixel' (trackingDelivery).
      const platform = kind.replace(/_pixel$/, '');
      const row = pixelByKind.get(kind) || null;
      const cfg = (row && row.config && typeof row.config === 'object') ? row.config : {};
      const c = countByPlatform.get(platform) || {};
      // Breaker scope is `${funnelId}:${pixelRowId}` (trackingDelivery).
      const breaker = row ? breakerRows.find((x) => x.scope_id === `${funnelId}:${row.id}`) : null;
      const open = Boolean(breaker && breaker.open_until && new Date(breaker.open_until).getTime() > now);
      return {
        kind,
        network: spec.network,
        sent_24h: c.sent_24h || 0,
        failed_24h: c.failed_24h || 0,
        deduped_24h: c.deduped_24h || 0,
        queued_24h: c.queued_24h || 0,
        breaker: { state: open ? 'open' : 'closed', fails: breaker ? breaker.fails : 0, open_until: breaker ? breaker.open_until : null },
        // Ready = the server channel can actually fire: enabled, a pixel id,
        // a stored token, AND a mode that relays server events (native fires
        // browser-only, so it is NOT a ready server channel).
        server_channel_ready: Boolean(row && row.enabled && row.pixel_id && cfg.capi_token
          && (row.mode === 's2s' || row.mode === 'hybrid')),
        click_id_params: paramsByNetwork[spec.network] || [],
      };
    });
    return res.json({ success: true, data: { networks } });
  } catch (err) {
    console.error('[trackingAdmin] summary failed:', err.message);
    return res.status(500).json({ success: false, error: { code: 'internal_error' } });
  }
});

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
