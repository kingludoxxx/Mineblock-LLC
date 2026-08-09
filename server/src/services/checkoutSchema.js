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

  // Shopify order mirror (shopifyOrderCreate.js). A settled base order is
  // pushed into the store as a real, paid Shopify order so the already-live
  // orders/create webhook ingests it into shopify_orders_cache. Exactly-once
  // is arbitrated on THIS row, not a read:
  //   - shopify_order_id set          → an order was created; never create again
  //   - shopify_status 'creating'     → an attempt is in flight (claim marker)
  //   - shopify_status 'needs_review' → an attempt failed; a human owns it
  //     (money already moved) — never auto-retried, so no duplicate store order
  // The claim UPDATE (…WHERE shopify_order_id IS NULL AND …) is the concurrency
  // guard: of N racing settlers exactly one wins the row lock and creates.
  await pgQuery(`ALTER TABLE co_orders ADD COLUMN IF NOT EXISTS shopify_order_id TEXT`);
  await pgQuery(`ALTER TABLE co_orders ADD COLUMN IF NOT EXISTS shopify_order_number TEXT`);
  await pgQuery(`ALTER TABLE co_orders ADD COLUMN IF NOT EXISTS shopify_status TEXT`);
  await pgQuery(`ALTER TABLE co_orders ADD COLUMN IF NOT EXISTS shopify_error TEXT`);
  await pgQuery(`ALTER TABLE co_orders ADD COLUMN IF NOT EXISTS shopify_claimed_at TIMESTAMPTZ`);
  await pgQuery(`ALTER TABLE co_orders ADD COLUMN IF NOT EXISTS shopify_created_at TIMESTAMPTZ`);
  await pgQuery(`
    CREATE INDEX IF NOT EXISTS idx_co_orders_shopify_status
    ON co_orders (shopify_status) WHERE shopify_status IS NOT NULL
  `);

  // Bookkeeping refunds reflected INTO Shopify (shopifyRefund.js). When a Whop
  // refund settles, the money is already back on the buyer's card, but the
  // mirrored Shopify order still reads 'paid' — so the Orders view (backed by
  // Shopify) misstates it. We create a MANUAL Shopify refund (no gateway money
  // movement) so Shopify flips the order to refunded and its orders/updated
  // webhook carries that into crm_orders. Exactly-once is arbitrated on THIS
  // row: UNIQUE(session_id, ref) + an atomic INSERT…ON CONFLICT DO NOTHING claim
  // taken BEFORE the Shopify call, so a redelivered refund webhook can never
  // create a second Shopify refund for the same gateway refund ref. status:
  // 'reflected' (done) | 'needs_reconcile' (Shopify call failed — a human owns
  // it; never auto-retried, matching the order-create stance).
  await pgQuery(`
    CREATE TABLE IF NOT EXISTS co_shopify_refunds (
      session_id TEXT NOT NULL,
      ref TEXT NOT NULL,
      shopify_order_id TEXT,
      shopify_refund_id TEXT,
      amount NUMERIC(12,2),
      status TEXT NOT NULL DEFAULT 'claimed',
      error TEXT,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      PRIMARY KEY (session_id, ref)
    )
  `);

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
  // charge_id is the CLAIM SLOT of the triple: `v:<variant>` for an accept,
  // 'decline' for the decline marker — deterministic, so the unique index is
  // the concurrency guard for double-clicks and replays. The gateway's own
  // payment id lives here:
  // Charge-authorization secret for the 1-click upsell. The session id travels
  // in `?s=` (address bar, beacons, access logs, the ad platform's CAPI payload)
  // and therefore CANNOT authorize a charge on its own — a leaked id let anyone
  // force-charge the buyer's saved card once per offer. This token is minted at
  // create-session, returned ONLY as an HttpOnly cookie, and never appears in a
  // URL, a beacon or a log. Only its SHA-256 is stored.
  await pgQuery(`ALTER TABLE co_sessions ADD COLUMN IF NOT EXISTS confirm_token_hash TEXT`);
  // Shopify discount code applied to this session (server-validated against
  // the store's price rules; the amount is OUR computation, never the client's).
  await pgQuery(`ALTER TABLE co_sessions ADD COLUMN IF NOT EXISTS discount_code TEXT`);
  await pgQuery(`ALTER TABLE co_sessions ADD COLUMN IF NOT EXISTS discount_amount NUMERIC(12,2) NOT NULL DEFAULT 0`);
  await pgQuery(`ALTER TABLE co_upsell_charges ADD COLUMN IF NOT EXISTS gateway_payment_id TEXT`);
  await pgQuery(`ALTER TABLE co_upsell_charges ADD COLUMN IF NOT EXISTS error TEXT`);
  await pgQuery(`
    CREATE INDEX IF NOT EXISTS idx_co_upsell_charges_gateway_payment
    ON co_upsell_charges (gateway_payment_id) WHERE gateway_payment_id IS NOT NULL
  `);
  await pgQuery(`CREATE INDEX IF NOT EXISTS idx_co_upsell_charges_status ON co_upsell_charges (status)`);

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

  // Columns added after the initial co_sessions DDL — safe on fresh and
  // existing DBs (same pattern as orders.js). Settle provenance for upsells:
  // gateway_customer_id + the charge's actual method type gate PM reuse.
  await pgQuery(`ALTER TABLE co_sessions ADD COLUMN IF NOT EXISTS gateway_customer_id TEXT`);
  await pgQuery(`ALTER TABLE co_sessions ADD COLUMN IF NOT EXISTS payment_method_type TEXT`);

  // Per-funnel gateway credentials (operator data). Secret values inside
  // `config` are AES-256-GCM ciphertext (gatewayConfigs.js); reads only ever
  // surface `*_set` booleans.
  await pgQuery(`
    CREATE TABLE IF NOT EXISTS co_gateway_configs (
      funnel_id TEXT NOT NULL,
      gateway TEXT NOT NULL,
      config JSONB NOT NULL DEFAULT '{}',
      updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      PRIMARY KEY (funnel_id, gateway)
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
