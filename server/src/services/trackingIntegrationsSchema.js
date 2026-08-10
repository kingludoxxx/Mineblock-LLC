// Integrations-layer schema — the three tables the ad-network integrations
// lane introduces. A NEW FILE ON PURPOSE: services/trackingSchema.js is the
// single owner of the SHARED lb_* tracking DDL and belongs to another lane,
// so nothing here alters an existing table. Everything is additive and
// idempotent, and the ensure chains ensureTrackingTables() first so this
// module is self-sufficient from EVERY call site (a fresh database can hit
// the inbound postback endpoint as its very first request).
//
//   lb_custom_networks  — operator-defined OUTBOUND postback templates
//   lb_inbound_endpoints— tokenized INBOUND postback endpoints (/pb/:token)
//   lb_inbound_events   — the inbound conversion ledger
//
// ATTRIBUTION IS NOT TOUCHED. lb_inbound_events is a ledger with a dedupe
// key; nothing in this lane writes lb_clicks / lb_touches / lb_visitor_firstseen
// or re-stamps a conversion. A later attribution pass consumes this table.
import { pgQuery } from '../db/pg.js';
import { ensureTrackingTables } from './trackingSchema.js';

// Same single-in-flight-promise guard as trackingSchema/checkoutSchema:
// concurrent first requests must not run CREATE TABLE in parallel
// (pg_type unique violation).
let readyPromise = null;

export function ensureIntegrationsTables() {
  if (!readyPromise) {
    readyPromise = createTables().catch((err) => {
      readyPromise = null;
      throw err;
    });
  }
  return readyPromise;
}

async function createTables() {
  // lb_pixels / lb_postback_queue / lb_tracking_events are this lane's
  // dependencies (the custom adapter rides the SAME delivery rails), so the
  // owning ensure runs first.
  await ensureTrackingTables();

  // ── lb_custom_networks — operator-defined outbound postback templates ─────
  // url_template carries {macro} placeholders rendered at delivery time
  // (services/trackingPostbackTemplate.js). It is stored VERBATIM and shown
  // back to the operator — it is their own text, including any postback
  // secret they embedded in it. It therefore must NEVER reach a log line, an
  // error column, or the event feed; only the authed admin read surface and
  // the test-fire response return it.
  //
  // event_names is a jsonb ARRAY of the event names this network is toggled
  // on for (the per-event toggles). An EMPTY array means "no events" — the
  // network is configured but fires nothing, which is different from
  // disabled and is reported as such.
  await pgQuery(`
    CREATE TABLE IF NOT EXISTS lb_custom_networks (
      id TEXT PRIMARY KEY,
      funnel_id TEXT NOT NULL,
      key TEXT NOT NULL,
      label TEXT NOT NULL DEFAULT '',
      click_id_param TEXT NOT NULL DEFAULT '',
      url_template TEXT NOT NULL DEFAULT '',
      method TEXT NOT NULL DEFAULT 'GET',
      event_names JSONB NOT NULL DEFAULT '[]',
      enabled BOOLEAN NOT NULL DEFAULT TRUE,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )
  `);
  // preset_key — WHICH directory card created this row (seam audit MINOR).
  // The client used to match a preset card to its network by re-deriving
  // slugOf(preset.label) in JSX, which broke the moment a label changed and put
  // the slug rule in two places. This column is the binding, stamped once at
  // create time and never recomputed. NULL = hand-made, not from a preset.
  // Additive via the same ALTER-after-CREATE pattern the checkout spine uses.
  await pgQuery(`ALTER TABLE lb_custom_networks ADD COLUMN IF NOT EXISTS preset_key TEXT`);
  await pgQuery(`CREATE INDEX IF NOT EXISTS idx_lb_custom_networks_funnel ON lb_custom_networks (funnel_id, enabled)`);
  // One row per (funnel, key). The key is the label slug — two networks named
  // the same on one funnel would render two identical cards and two
  // indistinguishable rows in the event feed (platform = the key).
  await pgQuery(`CREATE UNIQUE INDEX IF NOT EXISTS uq_lb_custom_networks_funnel_key ON lb_custom_networks (funnel_id, key)`);

  // ── lb_inbound_endpoints — tokenized inbound postback endpoints ───────────
  // token: 32 hex chars (128 bits), the ONLY credential on the public
  // endpoint. token_prefix is the first 8 chars and is what the public route
  // SELECTs on, so the full-token comparison can be done in constant time in
  // Node (crypto.timingSafeEqual) rather than by the database's short-circuit
  // byte compare. The prefix is indexed; it is not a secret on its own.
  await pgQuery(`
    CREATE TABLE IF NOT EXISTS lb_inbound_endpoints (
      id TEXT PRIMARY KEY,
      funnel_id TEXT NOT NULL,
      purpose TEXT NOT NULL DEFAULT '',
      label TEXT NOT NULL DEFAULT '',
      token TEXT NOT NULL,
      token_prefix TEXT NOT NULL,
      enabled BOOLEAN NOT NULL DEFAULT TRUE,
      hits BIGINT NOT NULL DEFAULT 0,
      last_hit_at TIMESTAMPTZ,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )
  `);
  await pgQuery(`CREATE INDEX IF NOT EXISTS idx_lb_inbound_endpoints_funnel ON lb_inbound_endpoints (funnel_id)`);
  await pgQuery(`CREATE INDEX IF NOT EXISTS idx_lb_inbound_endpoints_prefix ON lb_inbound_endpoints (token_prefix)`);
  await pgQuery(`CREATE UNIQUE INDEX IF NOT EXISTS uq_lb_inbound_endpoints_token ON lb_inbound_endpoints (token)`);

  // ── lb_inbound_events — the inbound conversion ledger ─────────────────────
  // ONE row per ingested conversion. UNIQUE (endpoint_id, event_id) is the
  // dedupe guarantee: an honest partner retry (or a network that fires the
  // same postback twice) collapses to one row rather than double-counting.
  //
  // `raw` is the bounded, string-coerced parameter map exactly as received —
  // the forensic record. It is operator-readable through the authed surface
  // only.
  //
  // consumed_at is written by NOTHING in this lane. It exists so the later
  // attribution pass can claim rows without a schema change; today it is
  // always NULL and every reader must treat it as "not yet consumed".
  await pgQuery(`
    CREATE TABLE IF NOT EXISTS lb_inbound_events (
      id TEXT PRIMARY KEY,
      endpoint_id TEXT NOT NULL,
      funnel_id TEXT NOT NULL DEFAULT '',
      event TEXT NOT NULL DEFAULT '',
      event_id TEXT NOT NULL,
      click_id TEXT NOT NULL DEFAULT '',
      click_key TEXT NOT NULL DEFAULT '',
      network TEXT NOT NULL DEFAULT '',
      order_id TEXT NOT NULL DEFAULT '',
      payout NUMERIC(14,4),
      currency TEXT NOT NULL DEFAULT '',
      raw JSONB NOT NULL DEFAULT '{}',
      ip_hash TEXT NOT NULL DEFAULT '',
      consumed_at TIMESTAMPTZ,
      ts TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )
  `);
  await pgQuery(`CREATE INDEX IF NOT EXISTS idx_lb_inbound_events_funnel ON lb_inbound_events (funnel_id, ts DESC)`);
  await pgQuery(`CREATE INDEX IF NOT EXISTS idx_lb_inbound_events_endpoint ON lb_inbound_events (endpoint_id, ts DESC)`);
  await pgQuery(`CREATE UNIQUE INDEX IF NOT EXISTS uq_lb_inbound_events_dedupe ON lb_inbound_events (endpoint_id, event_id)`);
}

export default { ensureIntegrationsTables };
