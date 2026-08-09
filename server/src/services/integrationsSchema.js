// Integrations schema — single owner of the lb_integrations DDL, ensure-on-
// demand like its siblings (checkoutSchema / trackingSchema). Two tables:
//
//   lb_integrations       — one row per integration kind ('klaviyo', …).
//     config JSONB is opaque to the DB; secrets inside it are AES-256-GCM
//     ciphertexts ('gcm1:' prefix, encryptSecret from gatewayConfigs.js) and
//     NEVER leave the DB decrypted except into an API call.
//
//   lb_integration_sends  — the exactly-once claim ledger for outbound
//     marketing events, (kind, ref) PK. Same money-path claim stance as
//     co_shopify_refunds: the atomic INSERT … ON CONFLICT DO NOTHING is taken
//     BEFORE the network call, so a webhook redelivery / double settle / cron
//     overlap can never double-send. A failed send RELEASES its claim (the
//     event never reached the vendor) — and the vendor-side unique_id dedup
//     backstops the race where release-then-reclaim overlaps a slow success.
import { pgQuery } from '../db/pg.js';

// Concurrent requests must not run the DDL simultaneously — Postgres throws
// on parallel CREATE TABLE IF NOT EXISTS (pg_type unique violation). A single
// in-flight promise serializes setup; on failure it resets so the next
// request retries. (Same pattern as checkoutSchema.js.)
let tablesReadyPromise = null;

export function ensureIntegrationTables() {
  if (!tablesReadyPromise) {
    tablesReadyPromise = createTables().catch((err) => {
      tablesReadyPromise = null;
      throw err;
    });
  }
  return tablesReadyPromise;
}

async function createTables() {
  await pgQuery(`
    CREATE TABLE IF NOT EXISTS lb_integrations (
      kind TEXT PRIMARY KEY,
      config JSONB NOT NULL DEFAULT '{}',
      updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )
  `);

  await pgQuery(`
    CREATE TABLE IF NOT EXISTS lb_integration_sends (
      kind TEXT NOT NULL,
      ref TEXT NOT NULL,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      PRIMARY KEY (kind, ref)
    )
  `);
}

// Atomic claim: TRUE exactly once per (kind, ref) — the DB arbitrates, never
// a read-then-write. FALSE = someone already holds it (dedup, skip the send).
export async function claimSend(kind, ref) {
  await ensureIntegrationTables();
  const rows = await pgQuery(
    `INSERT INTO lb_integration_sends (kind, ref) VALUES ($1, $2)
     ON CONFLICT (kind, ref) DO NOTHING
     RETURNING kind`,
    [String(kind).slice(0, 64), String(ref).slice(0, 128)]
  );
  return rows.length > 0;
}

// Release a claim whose send FAILED (never reached the vendor) so a later
// retry can re-attempt. The vendor-side unique_id dedup is the backstop.
export async function releaseSend(kind, ref) {
  await pgQuery(
    `DELETE FROM lb_integration_sends WHERE kind = $1 AND ref = $2`,
    [String(kind).slice(0, 64), String(ref).slice(0, 128)]
  );
}
