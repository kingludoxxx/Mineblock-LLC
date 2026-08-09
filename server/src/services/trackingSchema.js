// Tracking & attribution schema — single owner of all lb_* tracking DDL.
// Port of the funnel-os attribution/tracking spine (DATA-MODEL.md) to
// Postgres, single-tenant like the rest of Puure. Money/attribution
// correctness lives in the CONSTRAINTS, not application checks:
//   - lb_tracking_sent (pixel_id, event_id) UNIQUE   → the idempotency guard
//     that makes webhook + browser pixel + server relay dedupe to ONE send.
//   - lb_clicks (funnel_id, vid, click_id) UNIQUE     → the click-id vault;
//     refresh replays upsert, they never flood.
//   - lb_visitor_firstseen (vid) PK, NO expiry        → "is this visitor new?"
//     cannot be computed from a TTL'd table (DECISIONS #9). Write-once.
//
// TTL: Postgres has no Mongo-style TTL. lb_touches / lb_clicks carry an
// `expires_at` and are pruned by a periodic sweep (trackingPrune.js). The
// registry (lb_visitor_firstseen) deliberately has none.
import { pgQuery } from '../db/pg.js';

// Same single-in-flight-promise guard as checkoutSchema: concurrent first
// requests must not run CREATE TABLE in parallel (pg_type unique violation).
let tablesReadyPromise = null;

export function ensureTrackingTables() {
  if (!tablesReadyPromise) {
    tablesReadyPromise = createTables().catch((err) => {
      tablesReadyPromise = null;
      throw err;
    });
  }
  return tablesReadyPromise;
}

async function createTables() {
  // ── lb_touches — one row per pageview (TTL 90d via expires_at) ──
  // Same-URL replays inside a 45s window collapse into one row (handled in
  // trackingAttribution.recordTouch, not here).
  await pgQuery(`
    CREATE TABLE IF NOT EXISTS lb_touches (
      id BIGSERIAL PRIMARY KEY,
      vid TEXT NOT NULL,
      funnel_id TEXT,
      page_id TEXT,
      url TEXT,
      referrer TEXT,
      utm JSONB NOT NULL DEFAULT '{}',
      click_ids JSONB NOT NULL DEFAULT '{}',
      ts TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      expires_at TIMESTAMPTZ NOT NULL
    )
  `);
  // ── device + country (ANALYTICS LANE 5) — ADDITIVE, NO BACKFILL ──
  // Additive via the same ALTER-after-CREATE pattern the checkout spine uses
  // (checkoutSchema.js:114-119), so an existing lb_touches gains the columns
  // on the next boot without a migration step.
  //
  //   device  — the UA class, one of trackingAttribution.DEVICE_CLASSES
  //             (desktop|mobile|tablet|bot|unknown), computed at write time.
  //             TEXT (not an enum) to match lb_clicks.device above.
  //   country — ISO-3166 alpha-2 ONLY, e.g. 'ES'. Two characters by contract,
  //             TEXT (not CHAR(2)) so it matches lb_clicks.country above and
  //             never silently space-pads a short value; the writer validates
  //             the shape (trackingAttribution.normCountry).
  //
  // PRIVACY — the raw IP is resolved IN MEMORY and discarded. There is NO ip
  // column and NO ip_hash column here: only the resolved country code is ever
  // persisted. This is the same posture as lb_clicks ("Raw IP is NEVER
  // stored") and is asserted by server/tests/tracking/device-geo.mjs.
  //
  // NO BACKFILL, ON PURPOSE. Rows written before these columns existed stay
  // NULL — a UA and an IP that were never captured cannot be invented later.
  // NULL therefore means "not captured", which is NOT the same as the
  // 'unknown' device class ("captured, but the UA said nothing"). Every
  // reading surface must disclose the capture start date and must never read
  // a NULL as a zero.
  await pgQuery(`ALTER TABLE lb_touches ADD COLUMN IF NOT EXISTS device TEXT`);
  await pgQuery(`ALTER TABLE lb_touches ADD COLUMN IF NOT EXISTS country TEXT`);

  await pgQuery(`CREATE INDEX IF NOT EXISTS idx_lb_touches_vid_ts ON lb_touches (vid, ts)`);
  await pgQuery(`CREATE INDEX IF NOT EXISTS idx_lb_touches_funnel ON lb_touches (funnel_id, ts DESC)`);
  await pgQuery(`CREATE INDEX IF NOT EXISTS idx_lb_touches_expires ON lb_touches (expires_at)`);
  // Live View scans all funnels by time alone (no funnel_id filter), which the
  // (funnel_id, ts DESC) index cannot serve — this one can (liveViewQueries.js).
  await pgQuery(`CREATE INDEX IF NOT EXISTS idx_lb_touches_ts ON lb_touches (ts DESC)`);

  // ── lb_clicks — one first-class row per ad click (TTL 90d) ──
  // bot / velocity_flag are written ONLY on insert (DECISIONS #10): a later
  // public touch beacon can never flip a clean click to bot and suppress a
  // real buyer's conversions. Raw IP is NEVER stored — ip_hash only.
  await pgQuery(`
    CREATE TABLE IF NOT EXISTS lb_clicks (
      id TEXT PRIMARY KEY,
      funnel_id TEXT NOT NULL DEFAULT '',
      vid TEXT NOT NULL,
      network TEXT,
      click_id TEXT NOT NULL,
      click_key TEXT,
      struct JSONB NOT NULL DEFAULT '{}',
      subs JSONB NOT NULL DEFAULT '{}',
      utm JSONB NOT NULL DEFAULT '{}',
      cpc NUMERIC(12,4),
      country TEXT,
      device TEXT,
      ip_hash TEXT,
      bot BOOLEAN NOT NULL DEFAULT FALSE,
      velocity_flag BOOLEAN NOT NULL DEFAULT FALSE,
      landing_url TEXT,
      first_seen TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      last_seen TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      ts TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      converted BOOLEAN NOT NULL DEFAULT FALSE,
      session_id TEXT NOT NULL DEFAULT '',
      converted_at TIMESTAMPTZ,
      expires_at TIMESTAMPTZ NOT NULL,
      UNIQUE (funnel_id, vid, click_id)
    )
  `);
  await pgQuery(`CREATE INDEX IF NOT EXISTS idx_lb_clicks_vid ON lb_clicks (vid, ts DESC)`);
  await pgQuery(`CREATE INDEX IF NOT EXISTS idx_lb_clicks_clickid ON lb_clicks (funnel_id, click_id)`);
  await pgQuery(`CREATE INDEX IF NOT EXISTS idx_lb_clicks_converted ON lb_clicks (funnel_id, converted, network)`);
  await pgQuery(`CREATE INDEX IF NOT EXISTS idx_lb_clicks_expires ON lb_clicks (expires_at)`);

  // ── lb_visitor_firstseen — permanent, write-once acquisition registry ──
  // NO expires_at, ON PURPOSE (DECISIONS #9). The vid IS the primary key.
  await pgQuery(`
    CREATE TABLE IF NOT EXISTS lb_visitor_firstseen (
      vid TEXT PRIMARY KEY,
      funnel_id TEXT,
      network TEXT,
      first_ctx JSONB NOT NULL DEFAULT '{}',
      first_seen TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )
  `);

  // ── lb_tracking_sent — the idempotency ledger ──
  // UNIQUE (pixel_id, event_id): every server-side send inserts here FIRST.
  // A webhook retry, a beacon replay, a bfcache re-fire all become no-ops.
  await pgQuery(`
    CREATE TABLE IF NOT EXISTS lb_tracking_sent (
      pixel_id TEXT NOT NULL,
      event_id TEXT NOT NULL,
      ts TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      PRIMARY KEY (pixel_id, event_id)
    )
  `);

  // ── lb_tracking_events — the capped debug feed ──
  // idk = the identity KEYS present (booleans only, never PII) — the whole
  // basis of the match-quality (emq) score.
  await pgQuery(`
    CREATE TABLE IF NOT EXISTS lb_tracking_events (
      id BIGSERIAL PRIMARY KEY,
      funnel_id TEXT,
      platform TEXT,
      pixel_id TEXT,
      event_name TEXT,
      event_id TEXT,
      status TEXT,
      source TEXT,
      idk JSONB NOT NULL DEFAULT '[]',
      emq INT,
      value NUMERIC(12,2),
      error TEXT,
      ts TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )
  `);
  await pgQuery(`CREATE INDEX IF NOT EXISTS idx_lb_tracking_events_funnel ON lb_tracking_events (funnel_id, ts DESC)`);
  await pgQuery(`CREATE INDEX IF NOT EXISTS idx_lb_tracking_events_eid ON lb_tracking_events (event_id)`);

  // ── lb_postback_queue — the server-side delivery queue ──
  // A queued row holds the event ENVELOPE + the pixel row id (dispatch
  // INPUTS, not a rendered request), so fixing a credential mid-outage heals
  // the whole backlog on the next drain (DECISIONS #12).
  await pgQuery(`
    CREATE TABLE IF NOT EXISTS lb_postback_queue (
      id TEXT PRIMARY KEY,
      funnel_id TEXT,
      scope_id TEXT NOT NULL DEFAULT '',
      status TEXT NOT NULL DEFAULT 'queued',
      envelope JSONB NOT NULL DEFAULT '{}',
      pixel_row_id TEXT,
      url TEXT,
      attempts INT NOT NULL DEFAULT 0,
      next_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      claimed_at TIMESTAMPTZ,
      last_error TEXT,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )
  `);
  await pgQuery(`CREATE INDEX IF NOT EXISTS idx_lb_postback_due ON lb_postback_queue (status, next_at)`);

  // ── lb_postback_breakers — one row per endpoint scope ──
  // Five consecutive failures open the circuit for 15 min. Per-event payload
  // rejections do NOT increment it (DECISIONS #11).
  await pgQuery(`
    CREATE TABLE IF NOT EXISTS lb_postback_breakers (
      scope_id TEXT PRIMARY KEY,
      funnel_id TEXT,
      fails INT NOT NULL DEFAULT 0,
      open_until TIMESTAMPTZ,
      updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )
  `);

  // ── lb_pixels — operator pixel config (per-funnel, not env vars) ──
  // config carries capi_token / capi_endpoint / test_event_code — masked on
  // read (never leaves the server except into a relay call). mode: native |
  // s2s | hybrid.
  await pgQuery(`
    CREATE TABLE IF NOT EXISTS lb_pixels (
      id TEXT PRIMARY KEY,
      funnel_id TEXT NOT NULL,
      kind TEXT NOT NULL,
      pixel_id TEXT NOT NULL,
      mode TEXT NOT NULL DEFAULT 'hybrid',
      enabled BOOLEAN NOT NULL DEFAULT TRUE,
      config JSONB NOT NULL DEFAULT '{}',
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )
  `);
  await pgQuery(`CREATE INDEX IF NOT EXISTS idx_lb_pixels_funnel ON lb_pixels (funnel_id, enabled)`);
  // One row per (funnel, kind): the admin network CRUD (trackingAdmin.js)
  // upserts by kind and its ON CONFLICT needs this constraint. The write
  // surface was zero before the index landed, so duplicates can only be
  // hand-inserts — dedupe first (keep the NEWEST row per key, id as the
  // tiebreak) so the CREATE UNIQUE INDEX can never fail a boot. Idempotent:
  // a no-op once the index exists.
  await pgQuery(`
    DELETE FROM lb_pixels a USING lb_pixels b
    WHERE a.funnel_id = b.funnel_id AND a.kind = b.kind AND a.id <> b.id
      AND (a.updated_at < b.updated_at OR (a.updated_at = b.updated_at AND a.id < b.id))
  `);
  await pgQuery(`CREATE UNIQUE INDEX IF NOT EXISTS uq_lb_pixels_funnel_kind ON lb_pixels (funnel_id, kind)`);

  // ── lb_consent — one row per (vid, funnel): the recorded consent signal ──
  // Analytics-only. A consent-denied visitor writes a consent row but NO
  // identity (no touch/click) — that is correct, not a failure (DECISIONS #11).
  await pgQuery(`
    CREATE TABLE IF NOT EXISTS lb_consent (
      vid TEXT NOT NULL DEFAULT '',
      funnel_id TEXT,
      status TEXT NOT NULL,
      region BOOLEAN,
      ua TEXT,
      ip_hash TEXT,
      ts TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )
  `);
  await pgQuery(`CREATE INDEX IF NOT EXISTS idx_lb_consent_funnel ON lb_consent (funnel_id, ts DESC)`);
}

export default { ensureTrackingTables };
