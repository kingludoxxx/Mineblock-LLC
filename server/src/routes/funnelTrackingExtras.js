// Funnel tracking EXTRAS — the two panels the funnel-settings modal still had
// as scaffolds:
//
//   GET  /api/v1/funnels/:id/tracking/health   → per-pixel fire status
//   GET  /api/v1/funnels/:id/tracking/custom   → { head_html, body_html }
//   PUT  /api/v1/funnels/:id/tracking/custom   → { head_html?, body_html? }
//
// A NEW FILE ON PURPOSE. routes/trackingAdmin.js owns the tracking lane's
// network CRUD + summary and is an active lane; routes/funnels.js is the
// integrator's. This router is mounted on the SAME base path as funnelsRoutes
// (routes/index.js) and, because its auth chain is attached PER ROUTE rather
// than via router.use(), a request for any other /api/v1/funnels/* path falls
// straight through to funnelsRoutes with zero added work.
//
// Auth: the same chain every other funnel-settings surface uses —
// authenticate + requirePermission('funnels', 'access') — matching
// routes/funnels.js:23 and routes/trackingAdmin.js:18.
//
// SCHEMA OWNERSHIP: services/trackingSchema.js is the single owner of the
// shared lb_* tracking DDL and is another lane's file, so this router carries
// its OWN additive, idempotent ensure() for the one table it introduces plus
// one index the health query needs. Nothing here alters an existing table.
import { Router } from 'express';
import { pgQuery } from '../db/pg.js';
import { authenticate } from '../middleware/auth.js';
import { requirePermission } from '../middleware/rbac.js';
import { ensureTrackingTables } from '../services/trackingSchema.js';
import { ensureTables as ensureFunnelTables } from './funnels.js';
import { TRACKING_NETWORKS } from './trackingAdmin.js';
import { shapeTrackingHealth } from '../services/trackingHealth.js';
import {
  validateCustomCode,
  readCustomCode,
  CUSTOM_CODE_MAX_BYTES,
} from '../services/trackingCustomCode.js';

const router = Router();
const authed = [authenticate, requirePermission('funnels', 'access')];

// Funnel id handling. NO TRUNCATION (review n8): the old `.slice(0, 64)`
// silently turned an over-length id into a DIFFERENT id — one that matches no
// row, and, worse, one that can never line up with a breaker scope, since
// trackingDelivery builds those from the FULL id as `${funnelId}:${pixelRowId}`.
// A truncated id would therefore report every breaker as closed forever. Refuse
// loudly instead, with a bound so the parameter still cannot be unbounded.
const MAX_FUNNEL_ID = 128;
const funnelIdOf = (req) => {
  const raw = String(req.params.id ?? '');
  return raw && raw.length <= MAX_FUNNEL_ID ? raw : null;
};

// Resolve + validate + prove the funnel EXISTS. Returns the id, or null after
// having already answered the request.
//
// The existence check (review m7) is what stops orphan-row write amplification:
// without it, PUT .../tracking/custom on a typo'd or deleted funnel id happily
// inserts a row keyed to a funnel that does not exist, and nothing ever collects
// it. 404 is also the honest answer for a GET.
async function resolveFunnel(req, res) {
  const funnelId = funnelIdOf(req);
  if (!funnelId) {
    res.status(400).json({ success: false, error: { code: 'invalid_funnel_id' } });
    return null;
  }
  // funnels.js owns that table's DDL; calling its ensure (an import, never an
  // edit) means this router can be the first request on a fresh database
  // without the existence check throwing on a missing relation.
  await ensureFunnelTables();
  const rows = await pgQuery(`SELECT 1 FROM funnels WHERE id = $1 LIMIT 1`, [funnelId]);
  if (rows.length === 0) {
    res.status(404).json({ success: false, error: { code: 'funnel_not_found' } });
    return null;
  }
  return funnelId;
}

// Operator-facing names, matching the client's own network directory
// (client/src/components/funnels/settings/TrackingSection.jsx AD_NETWORKS).
const KIND_LABELS = {
  meta_pixel: 'Meta (Facebook & Instagram)',
  ga4: 'Google Analytics 4',
  google_ads: 'Google Ads',
};

// The registry knowledge the pure shaper needs, handed over as PLAIN DATA so
// services/trackingHealth.js never has to import a route module.
function specsFromRegistry() {
  const out = {};
  for (const [kind, spec] of Object.entries(TRACKING_NETWORKS)) {
    out[kind] = {
      label: KIND_LABELS[kind] || kind,
      notActive: Boolean(spec.notActive),
      readySecret: spec.readySecret || null,
      idOptional: Boolean(spec.idOptional),
      idField: spec.idField || 'pixel_id',
      deliveryNote: spec.deliveryNote || null,
    };
  }
  return out;
}

// ── additive schema (own ensure, single in-flight promise) ──────────────────
// Same guard as trackingSchema/checkoutSchema: concurrent first requests must
// not run CREATE TABLE in parallel (pg_type unique violation).
let extrasReadyPromise = null;
export function ensureTrackingExtrasTables() {
  if (!extrasReadyPromise) {
    extrasReadyPromise = createTables().catch((err) => {
      extrasReadyPromise = null;
      throw err;
    });
  }
  return extrasReadyPromise;
}

async function createTables() {
  // The index below is on lb_postback_queue, which services/trackingSchema.js
  // owns. On a FRESH database the custom-code endpoints can be the first thing
  // ever hit, and CREATE INDEX against a table that does not exist yet throws —
  // 500ing a settings panel that has nothing to do with the queue. Depending on
  // the owning ensure makes this self-sufficient from EVERY call site, not just
  // the health route that happens to call both.
  await ensureTrackingTables();

  // Custom tracking snippets, one row per funnel.
  //
  // WHY NOT funnels.settings (where the Scripts section stores its
  // custom_head_code / custom_body_end_code)? Because routes/funnels.js
  // validateFunnelSettings budgets EVERYTHING outside its hardcoded
  // SETTINGS_CODE_FIELDS allow-list at 32KB SERIALIZED, combined. Two 32KB
  // snippets under new keys would put ~64KB into that budget and make every
  // later settings PATCH — Scripts, brand colors, fonts, checkout toggles —
  // fail with "settings exceed the 32KB limit". Exempting them means editing
  // SETTINGS_CODE_FIELDS in funnels.js, which is the integrator's file. A
  // dedicated table keeps the operator's 32KB-per-field cap intact and cannot
  // break a neighbouring section. See the injection contract in the handover
  // notes for how funnelRender should read it.
  await pgQuery(`
    CREATE TABLE IF NOT EXISTS lb_tracking_custom_code (
      funnel_id TEXT PRIMARY KEY,
      code JSONB NOT NULL DEFAULT '{}',
      updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      updated_by TEXT
    )
  `);
  // The health query counts the LIVE retry backlog per funnel. lb_postback_queue
  // is indexed (status, next_at) for the drain, which cannot serve a
  // funnel-scoped read; this one can. Additive and idempotent.
  //
  // CONCURRENTLY (review m4): a plain CREATE INDEX takes a SHARE lock, which
  // blocks every INSERT/UPDATE on lb_postback_queue for the duration — and this
  // runs in the REQUEST PATH, so the first settings-modal open after a deploy
  // would stall the delivery drain writing to that same table. CONCURRENTLY
  // does not block writers. It cannot run inside a transaction block; pgQuery
  // issues statements outside any explicit transaction, so that holds here.
  //
  // NON-FATAL: a CONCURRENTLY build can abort (e.g. a competing build on
  // another worker) and leave an INVALID index behind. An index is an
  // optimization, never a correctness requirement — the health query returns
  // the same rows without it — so a failure is logged and swallowed rather than
  // 500ing the panel. The next ensure on a fresh process retries.
  //
  // NOT a numbered migration: server/migrations is applied MANUALLY
  // (`npm run migrate`, package.json:10) and tops out at 090, so an index
  // parked there would simply not exist in any environment nobody remembered to
  // migrate — which is precisely the environment where the slow scan hurts.
  try {
    await pgQuery(
      `CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_lb_postback_queue_funnel ON lb_postback_queue (funnel_id, status)`
    );
  } catch (err) {
    console.warn('[funnelTrackingExtras] idx_lb_postback_queue_funnel build skipped (non-fatal):', err.message);
  }
}

// ── GET /:id/tracking/health ────────────────────────────────────────────────
// Per-pixel fire status computed ENTIRELY from real delivery records
// (lb_tracking_events + lb_postback_queue + lb_postback_breakers). A pixel with
// no rows reads 'no_traffic', never 'failing'; classification lives in
// services/trackingHealth.js. Every scan is windowed and rides an existing
// index: idx_lb_tracking_events_funnel (funnel_id, ts DESC).
router.get('/:id/tracking/health', authed, async (req, res) => {
  try {
    // ensureTrackingExtrasTables() chains ensureTrackingTables() itself.
    await ensureTrackingExtrasTables();
    const funnelId = await resolveFunnel(req, res);
    if (!funnelId) return undefined;

    // TWO batches of three, not one of six (review m5): six concurrent
    // checkouts from the shared pool for a single settings-panel open is real
    // pressure on the money path's connections. Three at a time keeps the
    // parallelism win without approaching the pool ceiling.
    const [pixels, countRows, lastRows] = await Promise.all([
      pgQuery(
        `SELECT id, kind, pixel_id, mode, enabled, config FROM lb_pixels WHERE funnel_id = $1`,
        [funnelId]
      ),
      // Both windows in ONE 7-day scan: 24h is a FILTER subset of it, so the
      // narrower window never costs a second pass over the same index range.
      pgQuery(
        `SELECT platform,
                COUNT(*) FILTER (WHERE status = 'sent'    AND ts >= NOW() - INTERVAL '24 hours')::int AS h24_sent,
                COUNT(*) FILTER (WHERE status = 'error'   AND ts >= NOW() - INTERVAL '24 hours')::int AS h24_failed,
                COUNT(*) FILTER (WHERE status = 'skipped' AND ts >= NOW() - INTERVAL '24 hours')::int AS h24_skipped,
                COUNT(*) FILTER (WHERE status = 'deduped' AND ts >= NOW() - INTERVAL '24 hours')::int AS h24_deduped,
                COUNT(*) FILTER (WHERE status = 'queued'  AND ts >= NOW() - INTERVAL '24 hours')::int AS h24_queued,
                COUNT(*) FILTER (WHERE status = 'sent')::int    AS d7_sent,
                COUNT(*) FILTER (WHERE status = 'error')::int   AS d7_failed,
                COUNT(*) FILTER (WHERE status = 'skipped')::int AS d7_skipped,
                COUNT(*) FILTER (WHERE status = 'deduped')::int AS d7_deduped,
                COUNT(*) FILTER (WHERE status = 'queued')::int  AS d7_queued
         FROM lb_tracking_events
         WHERE funnel_id = $1 AND ts >= NOW() - INTERVAL '7 days'
         GROUP BY platform`,
        [funnelId]
      ),
      // "Last fired" reaches further back than the counters so a pixel that is
      // quiet TODAY can still show when it last delivered — bounded at 30d so
      // this stays a windowed, index-friendly scan and never a full history read.
      pgQuery(
        `SELECT platform,
                MAX(ts) FILTER (WHERE status = 'sent')  AS last_sent_at,
                MAX(ts) FILTER (WHERE status = 'error') AS last_failed_at
         FROM lb_tracking_events
         WHERE funnel_id = $1 AND ts >= NOW() - INTERVAL '30 days'
         GROUP BY platform`,
        [funnelId]
      ),
    ]);

    const [lastMsgRows, breakers, queueRows] = await Promise.all([
      // The newest error row AND the newest skipped row per platform, so the UI
      // can show WHY without conflating the two (a skip is a decline, not a
      // failure). error text was already token-redacted by trackingDelivery.
      pgQuery(
        `SELECT DISTINCT ON (platform, status) platform, status, error, ts
         FROM lb_tracking_events
         WHERE funnel_id = $1 AND status IN ('error', 'skipped')
           AND ts >= NOW() - INTERVAL '7 days'
         ORDER BY platform, status, ts DESC`,
        [funnelId]
      ),
      pgQuery(
        `SELECT scope_id, fails, open_until FROM lb_postback_breakers WHERE funnel_id = $1`,
        [funnelId]
      ),
      // LIVE queue depth, not a ledger count — drained rows must not keep
      // reading as queued forever (same rule as trackingAdmin's queued_now).
      pgQuery(
        `SELECT p.kind, COUNT(*)::int AS n
         FROM lb_postback_queue q JOIN lb_pixels p ON p.id = q.pixel_row_id
         WHERE q.funnel_id = $1 AND q.status IN ('queued', 'sending')
         GROUP BY p.kind`,
        [funnelId]
      ),
    ]);

    // Fan the per-platform row out into the two windows the shaper expects.
    const counts = [];
    for (const r of countRows) {
      counts.push({
        platform: r.platform,
        window: 'h24',
        sent: r.h24_sent,
        failed: r.h24_failed,
        skipped: r.h24_skipped,
        deduped: r.h24_deduped,
        queued: r.h24_queued,
      });
      counts.push({
        platform: r.platform,
        window: 'd7',
        sent: r.d7_sent,
        failed: r.d7_failed,
        skipped: r.d7_skipped,
        deduped: r.d7_deduped,
        queued: r.d7_queued,
      });
    }

    const msgByPlatform = new Map();
    for (const r of lastMsgRows) {
      const slot = msgByPlatform.get(r.platform) || {};
      if (r.status === 'error') slot.last_error = r.error || null;
      else slot.last_skip_reason = r.error || null;
      msgByPlatform.set(r.platform, slot);
    }
    const lasts = lastRows.map((r) => ({
      platform: r.platform,
      last_sent_at: r.last_sent_at,
      last_failed_at: r.last_failed_at,
      ...(msgByPlatform.get(r.platform) || {}),
    }));
    // A platform can have an error/skip message but no sent/failed aggregate row
    // only if it fell outside the 30d window — keep the message anyway.
    for (const [platform, slot] of msgByPlatform) {
      if (!lasts.some((l) => l.platform === platform)) lasts.push({ platform, ...slot });
    }

    const specs = specsFromRegistry();
    const data = shapeTrackingHealth({
      funnelId,
      pixels,
      specs,
      counts,
      lasts,
      breakers,
      queueDepth: queueRows,
      now: Date.now(),
    });

    // Rows can exist for kinds the registry no longer knows (a hand-insert, or
    // a kind retired while its rows survive). Report them as a COUNT only —
    // same posture as trackingAdmin's unknown_kinds: we can honestly say a row
    // exists and that nothing delivers for it, and nothing more.
    const unknownKinds = pixels
      .filter((r) => !TRACKING_NETWORKS[r.kind])
      .reduce((acc, r) => {
        const hit = acc.find((x) => x.kind === r.kind);
        if (hit) hit.rows++; else acc.push({ kind: r.kind, rows: 1 });
        return acc;
      }, []);

    // Honest capability notes (GA4's 204-for-everything, google_ads dormancy)
    // travel with the health payload so a green "Firing" row can never overstate
    // what a 'sent' actually proves.
    const notes = Object.entries(specs)
      .filter(([kind, s]) => s.deliveryNote && pixels.some((p) => p.kind === kind))
      .map(([kind, s]) => ({ kind, note: s.deliveryNote }));

    return res.json({
      success: true,
      data: { ...data, unknown_kinds: unknownKinds, notes },
    });
  } catch (err) {
    console.error('[funnelTrackingExtras] health failed:', err.message);
    return res.status(500).json({ success: false, error: { code: 'internal_error' } });
  }
});

// ── GET /:id/tracking/custom ────────────────────────────────────────────────
router.get('/:id/tracking/custom', authed, async (req, res) => {
  try {
    await ensureTrackingExtrasTables();
    const funnelId = await resolveFunnel(req, res);
    if (!funnelId) return undefined;
    const rows = await pgQuery(
      `SELECT code, updated_at, updated_by FROM lb_tracking_custom_code WHERE funnel_id = $1`,
      [funnelId]
    );
    const row = rows[0] || null;
    // readCustomCode tolerates BOTH jsonb shapes (object and double-encoded
    // string) and degrades a malformed blob to empty snippets rather than 500.
    const code = readCustomCode(row && row.code);
    return res.json({
      success: true,
      data: {
        ...code,
        updated_at: row ? row.updated_at : null,
        // Who last saved these snippets — this is operator-supplied code that
        // runs on every public page, so "who changed it" is part of the record.
        updated_by: row ? row.updated_by : null,
        max_bytes: CUSTOM_CODE_MAX_BYTES,
      },
    });
  } catch (err) {
    console.error('[funnelTrackingExtras] custom get failed:', err.message);
    return res.status(500).json({ success: false, error: { code: 'internal_error' } });
  }
});

// ── PUT /:id/tracking/custom ────────────────────────────────────────────────
// Operator-supplied code, stored VERBATIM — no sanitization, by design (same
// trusted-operator posture as page head_html / settings.custom_head_code). The
// controls are the funnels permission above and the 32KB-per-field cap.
//
// RENDER WIRING (integrator, live): funnelPublic's loader LEFT JOINs
// lb_tracking_custom_code onto the funnel row as `tracking_custom_code`, and
// funnelRender emits both fields via readCustomCode() appended to the
// settings head/body extras — AFTER settings.custom_head_code, so a consent
// manager in Advanced → Scripts initializes before pixel base code saved here.
router.put('/:id/tracking/custom', authed, async (req, res) => {
  try {
    await ensureTrackingExtrasTables();
    const funnelId = await resolveFunnel(req, res);
    if (!funnelId) return undefined;
    const check = validateCustomCode(req.body);
    if (!check.ok) {
      return res.status(400).json({
        success: false,
        error: { code: check.code, field: check.field || null, message: check.message },
      });
    }

    // Merge in SQL, not read-then-write: two operator tabs saving different
    // fields must not clobber each other. The CASE guard is the jsonb-shape
    // defence — `||` throws on a scalar left operand, so a double-encoded
    // legacy value is replaced rather than allowed to 500 the save.
    // NB: `check.patch` is passed as a RAW OBJECT. postgres.js serializes jsonb
    // params itself; pre-stringifying would store a jsonb STRING scalar.
    const rows = await pgQuery(
      `INSERT INTO lb_tracking_custom_code (funnel_id, code, updated_at, updated_by)
       VALUES ($1, $2::jsonb, NOW(), $3)
       ON CONFLICT (funnel_id) DO UPDATE
         SET code = (CASE WHEN jsonb_typeof(lb_tracking_custom_code.code) = 'object'
                          THEN lb_tracking_custom_code.code
                          ELSE '{}'::jsonb END) || EXCLUDED.code,
             updated_at = NOW(),
             updated_by = EXCLUDED.updated_by
       RETURNING code, updated_at, updated_by`,
      [funnelId, check.patch, String((req.user && req.user.id) || '').slice(0, 64) || null]
    );
    const row = rows[0] || null;
    return res.json({
      success: true,
      data: {
        ...readCustomCode(row && row.code),
        updated_at: row ? row.updated_at : null,
        updated_by: row ? row.updated_by : null,
        max_bytes: CUSTOM_CODE_MAX_BYTES,
      },
    });
  } catch (err) {
    console.error('[funnelTrackingExtras] custom put failed:', err.message);
    return res.status(500).json({ success: false, error: { code: 'internal_error' } });
  }
});

export default router;
