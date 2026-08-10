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
// `plain` fields round-trip as values.
//
// Per-entry knobs (all optional, meta-compatible defaults):
//   idField      the BODY/VIEW name of the lb_pixels.pixel_id column. GA4's
//                identity is its measurement_id and Meta's is its pixel id —
//                same column, same (funnel_id, kind) uniqueness, same
//                lb_tracking_sent claim key. One column, one alias.
//   idRe         validation for that id (garbage-in insurance, review MINOR #5)
//   idOptional   the row may exist with NO id (dormant kinds only)
//   modes        the modes this kind accepts — anything else is invalid_mode
//   defaultMode  the mode a NEW row lands on
//   defaultEnabled  the enabled flag a NEW row lands on
//   readySecret  the config key that must be present for server_channel_ready
//   notActive    REGISTERED BUT NOT WIRED: config is accepted and stored, but
//                nothing delivers. Surfaced as not_active in every read so the
//                UI can never imply conversions are flowing.
export const TRACKING_NETWORKS = {
  meta_pixel: {
    network: 'meta',
    secrets: ['capi_token'],
    plain: ['test_event_code', 'graph_version'],
    idField: 'pixel_id',
    // Garbage-in insurance (review MINOR #5): Meta pixel ids are numeric.
    idRe: /^\d{5,20}$/,
    modes: ['native', 's2s', 'hybrid'],
    defaultMode: 'hybrid',
    readySecret: 'capi_token',
  },
  // GA4 Measurement Protocol. SERVER-SIDE ONLY in this branch: MP is a
  // server transport and the browser half (gtag/GTM) is a later phase, so
  // 'native' and 'hybrid' are REFUSED — accepting them would advertise a
  // browser channel that emits nothing.
  ga4: {
    network: 'google',
    secrets: ['api_secret'],
    plain: [],
    idField: 'measurement_id',
    idRe: /^G-[A-Z0-9]{4,16}$/,
    modes: ['s2s'],
    defaultMode: 's2s',
    readySecret: 'api_secret',
    // Honest capability note, surfaced on every read. Two limitations the
    // operator cannot see from the counters alone (review HIGH #1c + MEDIUM #6):
    //   1. MP answers 204 to everything it accepts, so 'sent' means ACCEPTED,
    //      not RECORDED; and the debug endpoint that would validate a payload
    //      INGESTS NOTHING, so it must never be pointed at a live funnel.
    //   2. The client_id is derived server-side (no gtag in this phase), so
    //      GA4's user/session counts from this adapter do not join real browser
    //      sessions — conversions are right, audience metrics are not.
    deliveryNote: 'GA4 Measurement Protocol returns 204 for every accepted hit and gives NO per-event validation: sent_24h proves the endpoint ACCEPTED the hit, not that GA4 recorded the conversion. The MP debug endpoint (GA4_MP_DEBUG=1) only validates payload SHAPE — it records nothing and must never be enabled for a live funnel; it is refused outright in production. Also: this adapter derives its own client_id server-side, so GA4 user/session counts from it are NOT joinable to real browser sessions until the tag-manager phase ships gtag — transaction totals are accurate, audience/session metrics are not.',
  },
  // Google Ads — REGISTERED BUT DORMANT. The write surface accepts and stores
  // the credentials (encrypted) so an operator can stage them, but there is NO
  // delivery adapter: trackingDelivery has no google_ads sender and a fire
  // dead-letters as 'kind_not_wired' in ONE pass. New rows therefore land
  // DISABLED and every read carries not_active: true.
  google_ads: {
    network: 'google',
    secrets: ['developer_token', 'refresh_token'],
    plain: ['conversion_action_id'],
    // Review HIGH #2b: the customer id IS this row's identity, so it lives in
    // the pixel_id column and is VALIDATED — it must never be a free-text
    // field. Google Ads customer ids are exactly 10 digits, conventionally
    // written 123-456-7890; dashes are stripped before validation and storage,
    // so the stored form is canonical. idOptional means the id MAY BE ABSENT
    // (credentials can be staged before the account id is known) — it does NOT
    // mean 'anything goes': when present it must match idRe.
    idField: 'customer_id',
    idRe: /^\d{10}$/,
    idNormalize: (v) => v.replace(/[-\s]/g, ''),
    idOptional: true,
    modes: ['s2s'],
    defaultMode: 's2s',
    defaultEnabled: false,
    notActive: true,
    deliveryNote: 'Registered but NOT wired: credentials are stored, nothing is delivered. Enabling this row does not send conversions — a fire dead-letters as kind_not_wired without taking a delivery claim.',
  },
};
const DEFAULT_MODES = ['native', 's2s', 'hybrid'];
const modesOf = (spec) => spec.modes || DEFAULT_MODES;
const idFieldOf = (spec) => spec.idField || 'pixel_id';
// Error codes stay keyed to the kind's OWN id name, so a GA4 form never gets
// told its "pixel_id" is invalid.
const invalidIdCode = (spec) => `invalid_${idFieldOf(spec)}`;
const requiredIdCode = (spec) => `${idFieldOf(spec)}_required`;
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
    mode: row ? String(row.mode || spec.defaultMode || 'hybrid') : (spec.defaultMode || 'hybrid'),
    modes: modesOf(spec),
    enabled: row ? Boolean(row.enabled) : false,
    updated_at: row ? row.updated_at : null,
  };
  // The kind's own id alias (measurement_id for ga4) rides ALONGSIDE pixel_id
  // so a generic client keeps working and a GA4 form can read its own name.
  const idField = idFieldOf(spec);
  if (idField !== 'pixel_id') out[idField] = out.pixel_id;
  for (const f of spec.secrets) out[`${f}_set`] = Boolean(cfg[f]);
  for (const f of spec.plain) out[f] = cfg[f] == null ? '' : String(cfg[f]);
  // Registered-but-dormant kinds say so on EVERY read — never let a stored
  // credential imply a live delivery channel.
  if (spec.notActive) out.not_active = true;
  if (spec.deliveryNote) out.delivery_note = spec.deliveryNote;
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
    // Per-kind mode allow-list: GA4 MP is a SERVER transport, so ga4 refuses
    // native/hybrid rather than advertising a browser channel that emits
    // nothing (the gtag/GTM phase lands that separately).
    if (b.mode !== undefined && !modesOf(spec).includes(b.mode)) {
      return res.status(400).json({ success: false, error: { code: 'invalid_mode' } });
    }
    // Review NIT #6: Boolean("false") === true — accept ONLY JSON booleans.
    if (b.enabled !== undefined && b.enabled !== true && b.enabled !== false) {
      return res.status(400).json({ success: false, error: { code: 'invalid_enabled' } });
    }
    // The id arrives under the kind's own name (measurement_id for ga4) or the
    // generic pixel_id; both write the SAME column.
    const idField = idFieldOf(spec);
    const rawId = b[idField] !== undefined ? b[idField] : b.pixel_id;
    let pixelId = rawId === undefined ? undefined : String(rawId || '').trim().slice(0, 64);
    // Normalize BEFORE validating and storing, so the stored id is canonical
    // (google_ads: '123-456-7890' → '1234567890').
    if (pixelId !== undefined && pixelId !== '' && spec.idNormalize) pixelId = spec.idNormalize(pixelId);
    if (pixelId !== undefined && pixelId !== '' && spec.idRe && !spec.idRe.test(pixelId)) {
      return res.status(400).json({ success: false, error: { code: invalidIdCode(spec) } });
    }
    await ensureTrackingTables();
    const funnelId = funnelParam(req);
    const existing = await loadPixelRow(funnelId, kind);
    // The id is required for a NEW row (unless the kind is idOptional — a
    // dormant kind whose identity lives entirely in config); an existing row
    // may omit it to keep the stored value (same keep-on-undefined rule as the
    // other fields).
    if (!(pixelId !== undefined && pixelId !== '') && !existing && !spec.idOptional) {
      return res.status(400).json({ success: false, error: { code: requiredIdCode(spec) } });
    }
    if (spec.plain.includes('graph_version')
        && b.graph_version !== undefined && b.graph_version !== null && String(b.graph_version).trim() !== ''
        && !GRAPH_VERSION_RE.test(String(b.graph_version).trim())) {
      return res.status(400).json({ success: false, error: { code: 'invalid_graph_version' } });
    }

    // Review MINOR #4: the merge happens SQL-SIDE, not read-merge-write. The
    // request compiles into a PARTIAL patch (only the keys it sets) plus a
    // list of keys it clears; the upsert applies
    //   config = (stored - cleared) || patch
    // atomically, so two concurrent PUTs writing DIFFERENT fields both
    // survive — the patch content never depends on the read above (the read
    // only backs validation), so a stale read cannot drop the other writer's
    // keys. Same COALESCE rule for the scalar columns: null = keep stored.
    const patch = {};
    const cleared = [];
    for (const f of spec.secrets) {
      const v = b[f];
      if (v === undefined) continue;               // absent → keep
      if (v === null) { cleared.push(f); continue; } // explicit null → clear
      const t = String(v).trim();
      if (t === '') continue;                      // '' → keep (masked re-submit)
      patch[f] = encryptSecret(t);
    }
    for (const f of spec.plain) {
      const v = b[f];
      if (v === undefined) continue;               // absent → keep
      const t = v === null ? '' : String(v).trim();
      if (t === '') { cleared.push(f); continue; } // null/'' → clear
      patch[f] = t.slice(0, 128);
    }

    const pixelParam = pixelId !== undefined && pixelId !== '' ? pixelId : null;
    // null = keep stored (COALESCE). On a NEW row the kind's own default lands
    // instead of the table-wide one: ga4/google_ads default to 's2s' (never a
    // browser mode), and a dormant kind lands DISABLED so staged credentials
    // can never look like a live channel.
    const modeParam = b.mode !== undefined ? b.mode : (existing ? null : (spec.defaultMode || null));
    const enabledParam = b.enabled !== undefined
      ? b.enabled
      : (existing || spec.defaultEnabled === undefined ? null : spec.defaultEnabled);
    const rows = await pgQuery(
      `INSERT INTO lb_pixels (id, funnel_id, kind, pixel_id, mode, enabled, config, created_at, updated_at)
       VALUES ($1, $2, $3, COALESCE($4, ''), COALESCE($5, 'hybrid'), COALESCE($6, TRUE), $7::jsonb, NOW(), NOW())
       ON CONFLICT (funnel_id, kind) DO UPDATE SET
         pixel_id = COALESCE($4, lb_pixels.pixel_id),
         mode = COALESCE($5, lb_pixels.mode),
         enabled = COALESCE($6, lb_pixels.enabled),
         config = (COALESCE(lb_pixels.config, '{}'::jsonb) - $8::text[]) || $7::jsonb,
         updated_at = NOW()
       RETURNING id, funnel_id, kind, pixel_id, mode, enabled, config, updated_at`,
      // NB: pass `patch` as the raw object — pgQuery (postgres.js) serializes
      // jsonb params itself; pre-stringifying double-encodes into a jsonb
      // STRING scalar and '- text[]' then throws 'cannot delete from scalar'.
      [`px_${crypto.randomBytes(9).toString('hex')}`, funnelId, kind,
        pixelParam, modeParam, enabledParam, patch, cleared]
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
// network's clicks. failed_24h counts terminal outcomes (skipped/error).
// queued_now is the LIVE queue depth (review MAJOR #1): rows currently
// pending/retrying in lb_postback_queue — NOT a ledger count, which would
// keep showing drained events as queued forever. The drain writes its own
// sent/error ledger rows, so the 24h counters stay honest across an outage.
router.get('/:funnelId/tracking/summary', async (req, res) => {
  try {
    await ensureTrackingTables();
    const funnelId = funnelParam(req);
    const [pixelRows, countRows, breakerRows, queueRows] = await Promise.all([
      pgQuery(
        `SELECT id, kind, pixel_id, mode, enabled, config FROM lb_pixels WHERE funnel_id = $1`,
        [funnelId]
      ),
      pgQuery(
        `SELECT platform,
                COUNT(*) FILTER (WHERE status = 'sent')::int AS sent_24h,
                COUNT(*) FILTER (WHERE status IN ('skipped', 'error'))::int AS failed_24h,
                COUNT(*) FILTER (WHERE status = 'deduped')::int AS deduped_24h
         FROM lb_tracking_events
         WHERE funnel_id = $1 AND ts > NOW() - INTERVAL '24 hours'
         GROUP BY platform`,
        [funnelId]
      ),
      pgQuery(
        `SELECT scope_id, fails, open_until FROM lb_postback_breakers WHERE funnel_id = $1`,
        [funnelId]
      ),
      pgQuery(
        // Seam audit M6: LEFT JOIN, and COALESCE the kind. The inner join
        // dropped every queue row whose pixel_row_id is a CUSTOM network —
        // those rows live in lb_custom_networks, not lb_pixels — so a funnel
        // with a deep partner backlog reported only the named networks' share
        // of it. Custom rows now land under the synthetic kind 'custom', which
        // is what the per-network custom health surface reports in detail.
        `SELECT COALESCE(p.kind, 'custom') AS kind, COUNT(*)::int AS n
         FROM lb_postback_queue q LEFT JOIN lb_pixels p ON p.id = q.pixel_row_id
         WHERE q.funnel_id = $1 AND q.status IN ('queued', 'sending')
         GROUP BY 1`,
        [funnelId]
      ),
    ]);
    const pixelByKind = new Map(pixelRows.map((r) => [r.kind, r]));
    const countByPlatform = new Map(countRows.map((r) => [r.platform, r]));
    const queuedByKind = new Map(queueRows.map((r) => [r.kind, r.n]));
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
        queued_now: queuedByKind.get(kind) || 0,
        breaker: { state: open ? 'open' : 'closed', fails: breaker ? breaker.fails : 0, open_until: breaker ? breaker.open_until : null },
        // Ready = the server channel can actually fire: enabled, an id, the
        // kind's stored secret (capi_token for meta, api_secret for ga4), AND
        // a mode that relays server events (native fires browser-only, so it
        // is NOT a ready server channel). A registered-but-dormant kind is
        // NEVER ready, however complete its config looks — nothing delivers.
        server_channel_ready: Boolean(!spec.notActive && row && row.enabled
          && (row.pixel_id || spec.idOptional)
          && (!spec.readySecret || cfg[spec.readySecret])
          && (row.mode === 's2s' || row.mode === 'hybrid')),
        ...(spec.notActive ? { not_active: true } : {}),
        click_id_params: paramsByNetwork[spec.network] || [],
      };
    });
    // Review LOW #9: rows can exist for kinds the registry does not know — a
    // hand-inserted row, or a kind removed from the registry while its rows
    // survive. They are invisible in `networks` (which iterates the REGISTRY),
    // so the summary would silently under-report what is actually in the table.
    // Report them as a COUNT ONLY: we can honestly say a row exists and that
    // nothing delivers for it, and nothing more.
    const unknownKinds = pixelRows
      .filter((r) => !TRACKING_NETWORKS[r.kind])
      .reduce((acc, r) => {
        const hit = acc.find((x) => x.kind === r.kind);
        if (hit) hit.rows++; else acc.push({ kind: r.kind, rows: 1 });
        return acc;
      }, []);
    return res.json({
      success: true,
      data: {
        networks,
        // Empty in every healthy funnel. Non-empty = rows exist that NO adapter
        // serves; a fire against one dead-letters as kind_not_wired.
        unknown_kinds: unknownKinds,
      },
    });
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
