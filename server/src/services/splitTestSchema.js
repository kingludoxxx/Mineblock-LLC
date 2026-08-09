// Split-testing subsystem — schema (SELF-CONTAINED, NEW FILE).
//
// Ported from funnel-os's split design (docs/DECISIONS.md #6/#7/#16,
// docs/DATA-MODEL.md "Split testing"). Reimplemented for Puure's stack
// (Node/Express + Postgres via postgres.js) as an isolated module: it touches
// NONE of the shared hot files. Integration is by calling the exposed service
// functions — see INTEGRATION HOOKS in the delivery report.
//
// THE ONE INVARIANT THAT MOVES MONEY (DECISIONS #6 "ledgers not counters"):
// measurement lives in an immutable, append-only ledger keyed by a COMPOSITE
// id that INCLUDES the charge id. Counters are DERIVED on read. A refund is a
// new negative row, never a mutation of the original. Nothing here is ever
// UPDATEd after insert.
//
// Three tables:
//   lb_split_tests   — a test = a group with N arms on a funnel/page/offer.
//   lb_split_arms    — the arm definitions (weighted, one flagged control).
//   lb_split_credits — the append-only ledger: exposure (denominator) rows,
//                      credit (numerator) rows, and void (refund) rows.
//
// lb_split_credits carries THREE row kinds, all append-only:
//   • 'exposure' — the DENOMINATOR. One per (session, group). value is ALWAYS
//     0 and credited is ALWAYS false: a denominator row can NEVER raise a
//     credit (enforced by a CHECK). This is funnel-os's lb_split_offers.
//   • 'credit'   — the NUMERATOR. One per (session, group, CHARGE) money leg.
//     The charge id is LOAD-BEARING: a buyer can carry several money legs
//     (base + upsells), and keying on session alone silently drops all but the
//     first. Exactly-once is the partial UNIQUE index below, not a read.
//   • 'void'     — a refund/reversal. A NEW row with a NEGATIVE value, netted
//     against its credit's own (arm, day) cell. The original credit row is
//     never touched, so the ledger can be replayed and audited row by row.
import { pgQuery } from '../db/pg.js';

// Concurrent requests must not run the DDL simultaneously — Postgres throws on
// parallel CREATE TABLE IF NOT EXISTS (pg_type unique violation). A single
// in-flight promise serializes setup; on failure it resets so the next request
// retries. Same pattern funnels.js/checkoutSchema.js use.
let tablesReadyPromise = null;

/**
 * Idempotently create the split-testing tables. Safe to call on every request.
 * @param {(text: string, params?: any[]) => Promise<any[]>} [query] — injected
 *   query fn (defaults to the shared pgQuery); tests pass a scoped client.
 */
export function ensureSplitTables(query = pgQuery) {
  if (!tablesReadyPromise) {
    tablesReadyPromise = createTables(query).catch((err) => {
      tablesReadyPromise = null;
      throw err;
    });
  }
  return tablesReadyPromise;
}

async function createTables(query) {
  // ── A test = a group with N arms on a funnel / page / offer ──────────────
  await query(`
    CREATE TABLE IF NOT EXISTS lb_split_tests (
      id TEXT PRIMARY KEY,
      funnel_id TEXT,
      name TEXT NOT NULL DEFAULT '',
      -- 'page'  = a lander split (arms are pages of the same route)
      -- 'offer' = a post-purchase (upsell/downsell) split (arms are offers)
      scope TEXT NOT NULL DEFAULT 'page',
      target_page_id TEXT,
      target_offer_id TEXT,
      enabled BOOLEAN NOT NULL DEFAULT TRUE,
      archived BOOLEAN NOT NULL DEFAULT FALSE,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      CONSTRAINT ck_split_tests_scope CHECK (scope IN ('page', 'offer'))
    )
  `);
  await query(`CREATE INDEX IF NOT EXISTS idx_split_tests_funnel ON lb_split_tests (funnel_id) WHERE NOT archived`);

  // ── Arm definitions ──────────────────────────────────────────────────────
  // weight >= 0 (a bad weight degrades to equal, it never rejects at serve —
  // DECISIONS: "serve time NEVER rejects"). exactly one arm SHOULD be flagged
  // is_control; the resolver falls back to the lowest arm_key if none is.
  await query(`
    CREATE TABLE IF NOT EXISTS lb_split_arms (
      id TEXT PRIMARY KEY,
      test_id TEXT NOT NULL REFERENCES lb_split_tests(id) ON DELETE CASCADE,
      arm_key TEXT NOT NULL,
      weight NUMERIC(10,4) NOT NULL DEFAULT 1,
      page_id TEXT,
      offer_id TEXT,
      is_control BOOLEAN NOT NULL DEFAULT FALSE,
      archived BOOLEAN NOT NULL DEFAULT FALSE,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      CONSTRAINT ck_split_arms_weight CHECK (weight >= 0)
    )
  `);
  // A given arm_key belongs to at most one live arm of a test.
  await query(
    `CREATE UNIQUE INDEX IF NOT EXISTS uq_split_arms_key ON lb_split_arms (test_id, arm_key) WHERE NOT archived`
  );
  await query(`CREATE INDEX IF NOT EXISTS idx_split_arms_test ON lb_split_arms (test_id)`);

  // ── The append-only ledger ───────────────────────────────────────────────
  await query(`
    CREATE TABLE IF NOT EXISTS lb_split_credits (
      id BIGSERIAL PRIMARY KEY,
      -- Per-row idempotency key. UNIQUE. Its shape is the whole exactly-once
      -- story:
      --   exposure : exp:<session>|<group>
      --   credit   : cr:<session>|<group>|u:<charge>
      --   void     : void:<session>|<group>|u:<charge>|<refund_key>
      entry_id TEXT NOT NULL,
      kind TEXT NOT NULL,
      session_id TEXT NOT NULL,
      group_id TEXT NOT NULL,          -- = lb_split_tests.id
      arm_key TEXT NOT NULL,
      charge_id TEXT NOT NULL,         -- exposure rows use the sentinel '__exposure__'
      value NUMERIC(14,2) NOT NULL DEFAULT 0,
      credited BOOLEAN NOT NULL DEFAULT FALSE,
      currency TEXT,
      day DATE NOT NULL DEFAULT (NOW() AT TIME ZONE 'UTC')::date,
      refund_key TEXT,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      CONSTRAINT ck_split_credits_kind CHECK (kind IN ('exposure', 'credit', 'void')),
      -- A denominator row is default-OFF and carries no money: it can NEVER
      -- raise a credit. A credit is non-negative money. A void is non-positive
      -- money (a reversal). These CHECKs make the invariant structural.
      CONSTRAINT ck_split_credits_exposure CHECK (
        kind <> 'exposure' OR (value = 0 AND credited = FALSE)
      ),
      CONSTRAINT ck_split_credits_credit CHECK (kind <> 'credit' OR value >= 0),
      CONSTRAINT ck_split_credits_void CHECK (kind <> 'void' OR value <= 0)
    )
  `);
  // entry_id is the universal replay guard (every redelivery computes the same
  // id and the insert is a no-op).
  await query(`CREATE UNIQUE INDEX IF NOT EXISTS uq_split_credits_entry ON lb_split_credits (entry_id)`);
  // THE load-bearing invariant, stated literally: at most ONE credit per
  // (session, group, CHARGE). Different charges on the same session are
  // DISTINCT rows (this is what proves charge-id keying); a redelivered
  // settlement of the same charge collides and is dropped.
  await query(
    `CREATE UNIQUE INDEX IF NOT EXISTS uq_split_credits_once
     ON lb_split_credits (session_id, group_id, charge_id) WHERE kind = 'credit'`
  );
  // One exposure (denominator) per (session, group) — first write wins.
  await query(
    `CREATE UNIQUE INDEX IF NOT EXISTS uq_split_exposure_once
     ON lb_split_credits (session_id, group_id) WHERE kind = 'exposure'`
  );
  // Results reads group by (group, arm); the refund netter reads one leg.
  await query(`CREATE INDEX IF NOT EXISTS idx_split_credits_group_arm ON lb_split_credits (group_id, arm_key)`);
  await query(`CREATE INDEX IF NOT EXISTS idx_split_credits_leg ON lb_split_credits (session_id, group_id, charge_id)`);

  // ── Pending credits — the settle-races-exposure parking lot ─────────────
  // A settlement can land BEFORE the exposure row (webhook racing the offer
  // beacon). Refusing outright would lose the numerator permanently (an
  // undercount — fail-safe, but unrecoverable). Instead the refused leg parks
  // here and a retry pass (retrySplitPendingCredits) re-attempts it once the
  // exposure exists. Dedupe: one pending row per (session, charge); the credit
  // ledger's own UNIQUE triple guarantees the replay can never double-credit.
  await query(`
    CREATE TABLE IF NOT EXISTS lb_split_pending_credits (
      id BIGSERIAL PRIMARY KEY,
      session_id TEXT NOT NULL,
      charge_id TEXT NOT NULL,
      value NUMERIC(14,2) NOT NULL DEFAULT 0,
      currency TEXT,
      scope TEXT,
      attempts INT NOT NULL DEFAULT 0,
      resolved_at TIMESTAMPTZ,
      resolution TEXT,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      UNIQUE (session_id, charge_id)
    )
  `);
  await query(
    `CREATE INDEX IF NOT EXISTS idx_split_pending_open
     ON lb_split_pending_credits (created_at) WHERE resolved_at IS NULL`
  );

  await addOperatorColumns(query);
}

// ── Operator-surface columns (ADDITIVE ONLY) ───────────────────────────────
// Everything below was added for the operator UI (setup modal / canvas A/B node
// / results modal). Every statement is ADD COLUMN IF NOT EXISTS or CREATE INDEX
// IF NOT EXISTS: no column is ever dropped, retyped or backfilled, and NO
// existing invariant moves. A database created before this lane picks the new
// columns up on the next boot with its ledger untouched.
//
//   handle      — the route slug the split owns, funnel-os's lb_split_groups.slug
//                 ("the canonical route it owns"). Serving is a SEPARATE wiring
//                 task; this column is the operator's declaration of intent and
//                 the thing the UI renders as /<handle>.
//   domain      — optional host binding for the WHOLE split (blank = the
//                 funnel's default domain). One domain per test, never per arm:
//                 arms that serve on different hosts are not comparable.
//   sort_order  — operator-chosen arm order (A, B, C … left-to-right). Ties
//                 fall back to arm_key so ordering is always total.
//   is_entry    — the arm served at the bare /<handle> route.
//
// DECISION MADE — is_entry is a NEW flag, NOT a reuse of is_control:
//   is_control is the STATISTICAL baseline (the results table's "A ctrl" column
//   and the vs-control comparison read it). is_entry is a SERVING fact (which
//   arm answers the bare route). Overloading one flag would mean that moving
//   the entry arm silently moves the statistical baseline mid-experiment, which
//   invalidates every vs-control number already published. They are allowed to
//   point at the same arm — and do by default — but they are separate columns.
async function addOperatorColumns(query) {
  await query(`ALTER TABLE lb_split_tests ADD COLUMN IF NOT EXISTS handle TEXT`);
  await query(`ALTER TABLE lb_split_tests ADD COLUMN IF NOT EXISTS domain TEXT`);
  await query(`ALTER TABLE lb_split_arms ADD COLUMN IF NOT EXISTS sort_order INTEGER NOT NULL DEFAULT 0`);
  await query(`ALTER TABLE lb_split_arms ADD COLUMN IF NOT EXISTS is_entry BOOLEAN NOT NULL DEFAULT FALSE`);

  // A live handle is unique PER FUNNEL — the database is the arbiter of a
  // create race, exactly as funnel-os makes (website_id, slug) unique with a
  // partial filter on archived:false. NULL handles never collide (Postgres
  // treats NULLs as distinct in a unique index), so a test with no handle yet
  // is always insertable.
  await query(
    `CREATE UNIQUE INDEX IF NOT EXISTS uq_split_tests_handle
     ON lb_split_tests (funnel_id, handle) WHERE NOT archived AND handle IS NOT NULL`
  );
  // At most ONE live entry arm per test — structural, not a read-then-write.
  await query(
    `CREATE UNIQUE INDEX IF NOT EXISTS uq_split_arms_entry
     ON lb_split_arms (test_id) WHERE is_entry AND NOT archived`
  );

  // ── Delivery views — the VISITOR denominator of a page-scope test ─────────
  // One row per (test, visitor), written on the first DELIVERED render of the
  // visitor's assigned arm (funnel-os counts its impression on the delivered
  // render, not the redirect). Kept OUT of lb_split_credits on purpose: that
  // ledger is money (exposure = a checkout session that can convert; credit =
  // a charge), and mixing page views into it would double-count the money
  // denominator — funnel-os likewise keeps impressions in counters/stats, not
  // in the conversions ledger. Append-only, unique per visitor: assignment is
  // a sticky hash, so a visitor's arm can never change and one row is the
  // whole story. "Visitors" per arm = COUNT(*) on this table.
  await query(`
    CREATE TABLE IF NOT EXISTS lb_split_views (
      test_id TEXT NOT NULL,
      visitor_id TEXT NOT NULL,
      arm_key TEXT NOT NULL,
      day DATE NOT NULL DEFAULT (NOW() AT TIME ZONE 'UTC')::date,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      PRIMARY KEY (test_id, visitor_id)
    )
  `);
  await query(`CREATE INDEX IF NOT EXISTS idx_split_views_test_arm ON lb_split_views (test_id, arm_key)`);
}

export const EXPOSURE_CHARGE_SENTINEL = '__exposure__';
