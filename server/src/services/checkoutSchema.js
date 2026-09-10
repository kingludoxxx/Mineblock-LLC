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

// ---------------------------------------------------------------------------
// ensureTable — CREATE TABLE IF NOT EXISTS is CREATE-ONLY.
//
// A table that predates a column never gains it: the column list inside
// `CREATE TABLE IF NOT EXISTS` is silently ignored the moment the table exists,
// so the next `CREATE INDEX ... ON co_sessions (last_failed_payment_id)` throws
// SQLSTATE 42703 and every consumer of the money path 500s. That is R6's mirror
// image — a migration that cannot run on an empty database is a bug, and an
// ensure that cannot run on an EXISTING one is the same bug facing the other way.
//
// So every declared column is also emitted as an additive
// `ALTER TABLE … ADD COLUMN IF NOT EXISTS`, generated FROM THE SAME DDL TEXT that
// creates the table. Generated, not hand-listed: a hand-listed set drifts the
// first time somebody adds a column to the CREATE TABLE and forgets the ALTER,
// which is exactly how this bug was born.
//
// What is and is not carried onto an existing table:
//   columns          yes — type + DEFAULT, so a NOT NULL DEFAULT column is backfilled
//   NOT NULL         yes, but GUARDED: only when the column holds no NULLs. Re-adding a
//                    NOT NULL column with no default to a table that already has rows
//                    cannot be marked NOT NULL (23502); the column still gets added, so
//                    consumers stop throwing 42703, and a later ensure finishes the job
//                    once the offending rows are gone.
//   UNIQUE           yes — as `CREATE UNIQUE INDEX IF NOT EXISTS <table>_<cols>_key`,
//                    which is Postgres's own auto-name for the constraint index, so on a
//                    freshly created table the statement is a no-op. This is what keeps
//                    the money invariants (co_orders.idempotency_key, the upsell TRIPLE)
//                    true on a repaired database, not only a new one.
//   PRIMARY KEY      no. A table that exists already has its primary key, and inventing
//                    one on live rows is not a repair. Left to a migration.
// ---------------------------------------------------------------------------

/** Split a DDL column list on top-level commas (NUMERIC(12,2) must not split). */
function splitTopLevel(body) {
  const out = [];
  let depth = 0;
  let cur = '';
  for (const ch of body) {
    if (ch === '(') depth += 1;
    else if (ch === ')') depth -= 1;
    if (ch === ',' && depth === 0) { out.push(cur); cur = ''; continue; }
    cur += ch;
  }
  out.push(cur);
  return out.map((s) => s.trim().replace(/\s+/g, ' ')).filter(Boolean);
}

const CONSTRAINT_WORD = /^(PRIMARY|UNIQUE|FOREIGN|CHECK|CONSTRAINT|EXCLUDE)$/i;

/** Parse `CREATE TABLE IF NOT EXISTS t ( … )` into { table, columns[], uniques[] }. */
export function parseTableDdl(ddl) {
  const head = ddl.match(/CREATE TABLE IF NOT EXISTS\s+([A-Za-z_][A-Za-z0-9_]*)\s*\(/i);
  if (!head) throw new Error('ensureTable: not a CREATE TABLE IF NOT EXISTS statement');
  const open = ddl.indexOf('(', head.index);
  const close = ddl.lastIndexOf(')');
  if (open < 0 || close < open) throw new Error('ensureTable: unbalanced DDL');
  const table = head[1];
  const columns = [];
  const uniques = [];
  for (const def of splitTopLevel(ddl.slice(open + 1, close))) {
    const name = def.split(' ')[0];
    if (CONSTRAINT_WORD.test(name)) {
      const u = def.match(/^UNIQUE\s*\(([^)]*)\)$/i);
      if (u) uniques.push(u[1].split(',').map((c) => c.trim()));
      continue;
    }
    const rest = def.slice(name.length).trim();
    const notNull = /\bNOT NULL\b/i.test(rest);
    if (/\bUNIQUE\b/i.test(rest)) uniques.push([name]);
    // Type + DEFAULT only. NOT NULL is applied separately (guarded); PRIMARY KEY and
    // UNIQUE are constraints an existing table already owns or gets as an index below.
    const type = rest
      .replace(/\bPRIMARY KEY\b/gi, '')
      .replace(/\bNOT NULL\b/gi, '')
      .replace(/\bUNIQUE\b/gi, '')
      .replace(/\s+/g, ' ')
      .trim();
    columns.push({ name, type, notNull });
  }
  return { table, columns, uniques };
}

/**
 * Run a CREATE TABLE IF NOT EXISTS, then make an already-existing table match the
 * columns that DDL declares. Idempotent: on a table that is already correct every
 * statement below is a no-op.
 */
async function ensureTable(ddl) {
  await pgQuery(ddl);
  const { table, columns, uniques } = parseTableDdl(ddl);

  const existing = await pgQuery(
    `SELECT column_name, is_nullable FROM information_schema.columns
      WHERE table_schema = current_schema() AND table_name = $1`,
    [table],
  );
  const nullability = new Map(existing.map((r) => [r.column_name, r.is_nullable]));

  for (const col of columns) {
    if (!nullability.has(col.name)) {
      await pgQuery(`ALTER TABLE ${table} ADD COLUMN IF NOT EXISTS ${col.name} ${col.type}`);
    }
  }

  // NOT NULL, only where it is missing AND can be taken without a 23502. The IF NOT EXISTS
  // probe is what keeps this off the hot path: on a healthy table nothing here runs at all.
  for (const col of columns) {
    if (!col.notNull) continue;
    if (nullability.get(col.name) === 'NO') continue; // already NOT NULL — no scan, no statement
    await pgQuery(`
      DO $ensure$
      BEGIN
        IF NOT EXISTS (SELECT 1 FROM ${table} WHERE ${col.name} IS NULL) THEN
          ALTER TABLE ${table} ALTER COLUMN ${col.name} SET NOT NULL;
        END IF;
      END
      $ensure$;
    `);
  }

  for (const cols of uniques) {
    const idx = `${table}_${cols.join('_')}_key`; // Postgres's own name for the constraint index
    await pgQuery(`CREATE UNIQUE INDEX IF NOT EXISTS ${idx} ON ${table} (${cols.join(', ')})`);
  }
}

async function createTables() {
  // The spine of the money path. `status`: 'processing' = payment INTENT only;
  // 'paid' = money moved. Every revenue query filters on 'paid'.
  await ensureTable(`
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
  // Money-window reads (funnelCosts P&L, detect sweep) filter on paid_at;
  // partial index keeps it tight — processing rows have no paid_at.
  await pgQuery(`CREATE INDEX IF NOT EXISTS idx_co_sessions_paid_at ON co_sessions (paid_at) WHERE paid_at IS NOT NULL`);

  // Per-session event trail (created, settled, upsell shown, …). Analytics
  // side of the line: writes are non-fatal to the money path.
  await ensureTable(`
    CREATE TABLE IF NOT EXISTS co_events (
      id BIGSERIAL PRIMARY KEY,
      session_id TEXT NOT NULL,
      kind TEXT NOT NULL,
      data JSONB,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )
  `);
  await pgQuery(`CREATE INDEX IF NOT EXISTS idx_co_events_session ON co_events (session_id, created_at)`);
  // Live View reads by (kind, created_at) with no session filter; co_events has
  // no TTL, so without this it degrades to a full seq scan (liveViewQueries.js).
  await pgQuery(`CREATE INDEX IF NOT EXISTS idx_co_events_kind_created ON co_events (kind, created_at DESC)`);

  // Orders written by settlement. idempotency_key UNIQUE is the exactly-once
  // gate: the webhook, the sweep and an operator retry can all race the same
  // write and the database arbitrates — never read-then-write.
  await ensureTable(`
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
  await ensureTable(`
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
  await ensureTable(`
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
  await ensureTable(`
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
  // Whop plan behind the current checkout session — lets a discount UPDATE the
  // charge amount IN PLACE (PATCH /plans/:id) so the payment frame, and the
  // card the buyer already typed into it, are never rebuilt.
  await pgQuery(`ALTER TABLE co_sessions ADD COLUMN IF NOT EXISTS gateway_plan_id TEXT`);
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
  await ensureTable(`
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
  await ensureTable(`
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
  await ensureTable(`
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
