// Checkout (money path) schema — single owner of all co_* DDL so the three
// checkout route files (public, admin, gateway webhooks) can never drift.
// Money-correctness lives in the constraints, not in application checks:
//   - co_orders.idempotency_key UNIQUE            → exactly-once order writes
//   - co_upsell_charges (session, offer, charge)  → the TRIPLE key; accept AND
//     decline both write rows, a $0 decline marker can never be settled twice
//   - co_webhook_events (gateway, id) PK          → replay-safe webhook intake
//   - co_unmatched_payments.webhook_id PK         → idempotent operator queue
import { pgQuery } from '../db/pg.js';

// Concurrent requests must not run the DDL simultaneously — Postgres throws
// on parallel CREATE TABLE IF NOT EXISTS (pg_type unique violation). A single
// in-flight promise serializes setup; on failure it resets so the next
// request retries. (Same pattern as routes/orders.js.)
let tablesReadyPromise = null;

export function ensureCheckoutTables() {
  if (!tablesReadyPromise) {
    tablesReadyPromise = createTables().catch((err) => {
      tablesReadyPromise = null;
      throw err;
    });
  }
  return tablesReadyPromise;
}

async function createTables() {
  // The spine of the money path. `status`: 'processing' = payment INTENT only;
  // 'paid' = money moved. Every revenue query filters on 'paid'.
  await pgQuery(`
    CREATE TABLE IF NOT EXISTS co_sessions (
      id TEXT PRIMARY KEY,
      funnel_id TEXT,
      page_id TEXT,
      status TEXT NOT NULL DEFAULT 'processing',
      line_items JSONB NOT NULL DEFAULT '[]',
      subtotal NUMERIC(12,2) NOT NULL DEFAULT 0,
      shipping NUMERIC(12,2) NOT NULL DEFAULT 0,
      tax NUMERIC(12,2) NOT NULL DEFAULT 0,
      total NUMERIC(12,2) NOT NULL DEFAULT 0,
      currency TEXT NOT NULL DEFAULT 'USD',
      customer JSONB NOT NULL DEFAULT '{}',
      gateway TEXT,
      gateway_session_id TEXT,
      payment_method_id TEXT,
      tracking_net JSONB,
      vid TEXT,
      click_vault JSONB,
      import_status TEXT,
      import_due_at TIMESTAMPTZ,
      needs_review_reason TEXT,
      last_failed_payment_id TEXT,
      refunds JSONB NOT NULL DEFAULT '[]',
      paid_at TIMESTAMPTZ,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )
  `);
  await pgQuery(`CREATE INDEX IF NOT EXISTS idx_co_sessions_status ON co_sessions (status)`);
  await pgQuery(`CREATE INDEX IF NOT EXISTS idx_co_sessions_created ON co_sessions (created_at DESC)`);
  await pgQuery(`CREATE INDEX IF NOT EXISTS idx_co_sessions_gateway_session ON co_sessions (gateway_session_id)`);
  await pgQuery(`
    CREATE INDEX IF NOT EXISTS idx_co_sessions_last_failed_payment
    ON co_sessions (last_failed_payment_id) WHERE last_failed_payment_id IS NOT NULL
  `);

  // Per-session event trail (created, settled, upsell shown, …). Analytics
  // side of the line: writes are non-fatal to the money path.
  await pgQuery(`
    CREATE TABLE IF NOT EXISTS co_events (
      id BIGSERIAL PRIMARY KEY,
      session_id TEXT NOT NULL,
      kind TEXT NOT NULL,
      data JSONB,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )
  `);
  await pgQuery(`CREATE INDEX IF NOT EXISTS idx_co_events_session ON co_events (session_id, created_at)`);

  // Orders written by settlement. idempotency_key UNIQUE is the exactly-once
  // gate: the webhook, the sweep and an operator retry can all race the same
  // write and the database arbitrates — never read-then-write.
  await pgQuery(`
    CREATE TABLE IF NOT EXISTS co_orders (
      id TEXT PRIMARY KEY,
      session_id TEXT NOT NULL,
      idempotency_key TEXT NOT NULL UNIQUE,
      gateway TEXT,
      external_order_id TEXT,
      line_items JSONB NOT NULL DEFAULT '[]',
      total NUMERIC(12,2) NOT NULL DEFAULT 0,
      currency TEXT NOT NULL DEFAULT 'USD',
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )
  `);
  await pgQuery(`CREATE INDEX IF NOT EXISTS idx_co_orders_session ON co_orders (session_id)`);

  // Upsell offer definitions. variant_id '' = "charge whatever the on-page
  // selection control resolves to" (reference semantics).
  await pgQuery(`
    CREATE TABLE IF NOT EXISTS co_upsells (
      id TEXT PRIMARY KEY,
      funnel_id TEXT,
      page_id TEXT,
      variant_id TEXT NOT NULL DEFAULT '',
      price NUMERIC(12,2),
      title TEXT,
      enabled BOOLEAN NOT NULL DEFAULT TRUE,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )
  `);

  // One row per upsell charge ATTEMPT — accept AND decline. Uniqueness on the
  // TRIPLE (session, offer, charge), never the pair: a $0 decline marker
  // written pair-unique would get settled/dunned/refund-routed as real money.
  await pgQuery(`
    CREATE TABLE IF NOT EXISTS co_upsell_charges (
      id TEXT PRIMARY KEY,
      session_id TEXT NOT NULL,
      offer_id TEXT NOT NULL,
      charge_id TEXT NOT NULL,
      amount NUMERIC(12,2) NOT NULL DEFAULT 0,
      currency TEXT,
      status TEXT NOT NULL,
      declined_by_user BOOLEAN NOT NULL DEFAULT FALSE,
      line_items JSONB NOT NULL DEFAULT '[]',
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      UNIQUE (session_id, offer_id, charge_id)
    )
  `);

  // Raw inbound gateway webhooks, for replay and forensics. (gateway, id) PK
  // makes intake idempotent: a replayed event upserts, never duplicates.
  await pgQuery(`
    CREATE TABLE IF NOT EXISTS co_webhook_events (
      gateway TEXT NOT NULL,
      id TEXT NOT NULL,
      event_type TEXT,
      payload JSONB,
      received_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      processed_at TIMESTAMPTZ,
      outcome TEXT,
      PRIMARY KEY (gateway, id)
    )
  `);

  // Real money the system could not attribute to a session — an operator
  // queue, never a silent drop. PK on the webhook id keeps it idempotent.
  await pgQuery(`
    CREATE TABLE IF NOT EXISTS co_unmatched_payments (
      webhook_id TEXT PRIMARY KEY,
      gateway TEXT,
      amount NUMERIC(12,2),
      currency TEXT,
      payload JSONB,
      reason TEXT,
      resolved BOOLEAN NOT NULL DEFAULT FALSE,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )
  `);
}
