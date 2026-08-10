// POST-PURCHASE ORDER EDIT — change a settled order's line items and shipping
// address after the money moved, WITHOUT touching the money.
//
// ─────────────────────────────────────────────────────────────────────────────
// THE ONE RULE THAT SHAPES EVERYTHING HERE
//
// Editing a paid order changes what the buyer OWES. It does not change what
// the buyer PAID. Those two numbers are allowed to disagree, and the whole
// design is about making that disagreement LOUD and ADDRESSABLE instead of
// silently reconciling it:
//
//   - the snapshot (co_sessions.line_items / customer.shipping) is updated so
//     fulfilment ships the right goods to the right address;
//   - co_sessions.total is NEVER moved by an edit. It is the amount the
//     gateway captured and the ceiling every refund path reads. Moving it
//     would rewrite history and silently change the refund cap.
//   - the difference is written as a NEEDS-SETTLEMENT row
//     (co_order_edit_settlements) that a human — or, later, the integrator's
//     charge/refund lane — resolves. See MONEY SEAM below.
//
// WHY co_sessions.total IS NOT TOUCHED (and the reference is different):
// funnel-os lets `total` rise by exactly what its gateway collected in the
// same request, because it charges inline. We do not charge inline, so any
// movement of `total` would be a claim about money that never moved. The
// settlement row carries the delta instead; `total` stays the captured truth.
//
// ─────────────────────────────────────────────────────────────────────────────
// APPEND-ONLY VERSIONING (the friend's snapshot rule, strengthened)
//
// Every edit is a NEW IMMUTABLE ROW in co_order_edits carrying BOTH the delta
// and the full before/after snapshots. Nothing is ever updated in place. The
// current state is `ORDER BY version DESC LIMIT 1`.
//
// The reference resolves "who owns the snapshot" by comparing ISO timestamp
// STRINGS across committed charge rows ("superseded" check). We replace that
// with an integer version and let the DATABASE arbitrate: the caller sends the
// `base_version` it computed against, we insert at `base_version + 1`, and
// UNIQUE (session_id, version) makes two racing operators resolve to exactly
// one winner and one 409 `stale_version`. No read-then-write, no lexical
// timestamp comparison, no lost edit.
//
// UNIQUE (session_id, edit_id) is the second arbiter: the client mints ONE
// edit_id per modal-open and reuses it across retries, so a re-clicked Save
// after a timeout replays the recorded result instead of applying twice.
//
// ─────────────────────────────────────────────────────────────────────────────
// PRICING (read-only reuse of the checkout's authority)
//
// Added lines are re-priced server-side through checkoutPricing.js — the SAME
// module the public checkout uses, imported READ-ONLY. A client-sent price is
// never trusted, exactly as at mint. Its two failure classes are preserved and
// kept distinct: a transport/GraphQL fault is a retryable 503
// (`pricing_unavailable`), an unknown/unpurchasable variant is a 422
// (`invalid_variant`). A Shopify blip must never read as tampering.
//
// EXISTING lines are NOT re-priced: they were server-priced at mint and the
// buyer paid that number. Re-pricing them would silently reprice a settled
// sale at today's catalog price.
//
// NULL vs 0 (a real distinction, not a formatting one):
//   - an existing line whose `price` is null/absent is a DATA FAULT, not a
//     free item. It fails the edit with `unpriced_line` rather than
//     contributing 0 to a subtotal an operator is about to confirm.
//   - a delta of 0 means "computed, no money moves" and writes NO settlement
//     row. `total_delta: null` would mean "not computed" — a state this module
//     never returns, because it always computes.
//   - session shipping/tax/discount_amount are NOT NULL DEFAULT 0 in the
//     schema, so COALESCE-to-zero there is faithful, not lossy.
//
// SHIPPING / TAX / DISCOUNT are held CONSTANT across an edit. Re-quoting
// shipping is the checkout page-config lane and re-running a discount is
// checkoutDiscount's lane; both are read-only to this module. An edit moves
// goods, not the freight or promo arithmetic.
import crypto from 'crypto';
import { pgQuery } from '../db/pg.js';
import { ensureCheckoutTables } from './checkoutSchema.js';
import {
  resolveVariantPrices,
  currencyMismatch,
  toVariantGid,
  PricingUnavailableError,
} from './checkoutPricing.js';

const round2 = (n) => Math.round(Number(n) * 100) / 100;

// Bounds mirror the checkout's own (MAX_LINES / MAX_QTY_PER_LINE) so an edit
// can never produce a cart the mint path would have refused.
export const EDIT_LIMITS = {
  MAX_LINES: 50,
  MAX_QTY: 999,
  MAX_ADD_LINES: 50,
  MAX_LINE_EDITS: 50,
  MAX_EDIT_ID: 64,
  // Below this the delta is arithmetic noise (half-cent rounding), not money.
  // Same threshold the reference uses, for the same reason.
  DELTA_EPSILON: 0.005,
};

// Only a PAID session is editable. This is post-PURCHASE order edit, and every
// invariant the lane rests on requires that money already moved:
//   - a 'processing' session is mid-checkout — the buyer is on the payment page
//     paying against an already-minted gateway plan/amount. Mutating its
//     line_items/subtotal underneath them is a race with checkoutPublic, which
//     owns the live-cart mutation path; that is a different lane, not this one.
//   - the settlement seam is PAID-only (a delta with no captured amount to
//     reconcile against is meaningless). Were 'processing' editable, an edit
//     would change line_items/subtotal but write NO settlement row, and the
//     eventual settle would book at the UNCHANGED session.total — capturing the
//     original amount while the settled order's goods reflect the edit. That
//     silent divergence between money-captured and goods-owed is exactly the
//     failure this feature exists to make LOUD, so we refuse to create it.
//   - 'refunded' is likewise excluded: its money is being unwound, not
//     corrected.
// Consequence, load-bearing: EDITABLE == PAID, so EVERY editable session is
// paid, so EVERY non-trivial delta writes a settlement row — the divergence
// above is now unrepresentable rather than merely flagged.
export const PAID_SESSION_STATUSES = ['paid'];
export const EDITABLE_SESSION_STATUSES = ['paid'];

// Settlement row lifecycle. 'needs_settlement' is the only state this module
// ever writes; the other three are operator/integrator outcomes.
export const SETTLEMENT_STATUSES = ['needs_settlement', 'settled', 'waived', 'failed'];

// Shopify mirror state per edit, deliberately the SAME vocabulary co_orders
// uses for its create-mirror so an operator learns one set of words:
//   'skipped'      — the push lane is off, or there is no mirrored order
//   'claimed'      — a push is in flight (crash here ⇒ a human owns it)
//   'pushed'       — the store agrees with our snapshot
//   'needs_review' — the push failed AFTER the edit was recorded; never
//                    auto-retried, because Shopify's orderEditCommit is
//                    ADDITIVE and a blind retry duplicates lines.
export const PUSH_STATUSES = ['skipped', 'claimed', 'pushed', 'needs_review'];

const EDIT_ID_RE = /^[A-Za-z0-9_-]{1,64}$/;

let tablesReadyPromise = null;

// Concurrent requests must not run the DDL simultaneously — Postgres throws on
// parallel CREATE TABLE IF NOT EXISTS (pg_type unique violation). A single
// in-flight promise serializes setup; on failure it resets so the next request
// retries. (Same pattern as checkoutSchema.js / routes/orders.js.)
export function ensureOrderEditTables() {
  if (!tablesReadyPromise) {
    tablesReadyPromise = createTables().catch((err) => {
      tablesReadyPromise = null;
      throw err;
    });
  }
  return tablesReadyPromise;
}

async function createTables() {
  // co_sessions / co_orders are read by every query below.
  await ensureCheckoutTables();

  // ── APPEND-ONLY version ledger ────────────────────────────────────────────
  // Nothing in this codebase UPDATEs this table. It is written once per edit
  // and read forever. Both snapshots are stored whole so a version is
  // self-contained: reconstructing "what did the order look like at v3" never
  // requires replaying the chain, which is what makes an audit trustworthy
  // when a mid-chain row is the one in dispute.
  await pgQuery(`
    CREATE TABLE IF NOT EXISTS co_order_edits (
      id TEXT PRIMARY KEY,
      session_id TEXT NOT NULL,
      edit_id TEXT NOT NULL,
      version INT NOT NULL,
      base_version INT NOT NULL,
      delta JSONB NOT NULL DEFAULT '{}',
      before_snapshot JSONB NOT NULL DEFAULT '{}',
      after_snapshot JSONB NOT NULL DEFAULT '{}',
      subtotal_before NUMERIC(12,2) NOT NULL DEFAULT 0,
      subtotal_after NUMERIC(12,2) NOT NULL DEFAULT 0,
      subtotal_delta NUMERIC(12,2) NOT NULL DEFAULT 0,
      captured_total NUMERIC(12,2) NOT NULL DEFAULT 0,
      owed_after NUMERIC(12,2) NOT NULL DEFAULT 0,
      total_delta NUMERIC(12,2) NOT NULL DEFAULT 0,
      currency TEXT NOT NULL DEFAULT 'USD',
      address_changed BOOLEAN NOT NULL DEFAULT FALSE,
      session_status TEXT,
      created_by TEXT,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )
  `);
  // The two arbiters. (session_id, version) makes concurrent edits resolve at
  // the database; (session_id, edit_id) makes a client retry a replay.
  await pgQuery(`
    CREATE UNIQUE INDEX IF NOT EXISTS uq_co_order_edits_version
    ON co_order_edits (session_id, version)
  `);
  await pgQuery(`
    CREATE UNIQUE INDEX IF NOT EXISTS uq_co_order_edits_edit_id
    ON co_order_edits (session_id, edit_id)
  `);
  await pgQuery(`
    CREATE INDEX IF NOT EXISTS idx_co_order_edits_created
    ON co_order_edits (created_at DESC)
  `);

  // ── Shopify mirror state (MUTABLE — one row per edit) ─────────────────────
  // Kept OUT of co_order_edits precisely so that table can stay immutable: the
  // push outcome is learned after the version row is already durable.
  await pgQuery(`
    CREATE TABLE IF NOT EXISTS co_order_edit_pushes (
      edit_row_id TEXT PRIMARY KEY,
      session_id TEXT NOT NULL,
      shopify_order_id TEXT,
      status TEXT NOT NULL DEFAULT 'skipped',
      reason TEXT,
      detail JSONB NOT NULL DEFAULT '{}',
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )
  `);
  await pgQuery(`
    CREATE INDEX IF NOT EXISTS idx_co_order_edit_pushes_status
    ON co_order_edit_pushes (status) WHERE status <> 'pushed'
  `);

  // ── THE MONEY SEAM (MUTABLE — resolved by a human or the integrator) ──────
  // One row per edit whose delta exceeds the epsilon. `direction` is derived,
  // never inferred from a sign at read time: 'charge' = the buyer owes us more,
  // 'refund' = we owe the buyer. `amount` is always a POSITIVE magnitude, so a
  // reader can never accidentally add a refund to revenue.
  await pgQuery(`
    CREATE TABLE IF NOT EXISTS co_order_edit_settlements (
      edit_row_id TEXT PRIMARY KEY,
      session_id TEXT NOT NULL,
      version INT NOT NULL,
      direction TEXT NOT NULL,
      amount NUMERIC(12,2) NOT NULL,
      currency TEXT NOT NULL DEFAULT 'USD',
      status TEXT NOT NULL DEFAULT 'needs_settlement',
      gateway_payment_id TEXT,
      settled_amount NUMERIC(12,2),
      note TEXT,
      resolved_by TEXT,
      resolved_at TIMESTAMPTZ,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )
  `);
  // A settled row whose recorded settled_amount does not match what the seam
  // said was owed carries a variance flag. The operator attestation still
  // stands — an operator may legitimately settle at a different number (a
  // partial, a fee, a goodwill adjustment) — but a $100 charge marked settled
  // at $1 must not READ as clean. The flag makes the discrepancy queryable
  // rather than buried in a free-text note. Added after the initial DDL (safe
  // on fresh and existing DBs, same pattern as the co_* schema).
  await pgQuery(`ALTER TABLE co_order_edit_settlements ADD COLUMN IF NOT EXISTS variance BOOLEAN NOT NULL DEFAULT FALSE`);
  await pgQuery(`
    CREATE INDEX IF NOT EXISTS idx_co_order_edit_settlements_open
    ON co_order_edit_settlements (created_at DESC)
    WHERE status = 'needs_settlement'
  `);
  await pgQuery(`
    CREATE INDEX IF NOT EXISTS idx_co_order_edit_settlements_session
    ON co_order_edit_settlements (session_id)
  `);
  // Every settled row that landed off-amount, for the reconciliation review.
  await pgQuery(`
    CREATE INDEX IF NOT EXISTS idx_co_order_edit_settlements_variance
    ON co_order_edit_settlements (resolved_at DESC) WHERE variance = TRUE
  `);
}

// The half-cent that separates rounding noise from a real discrepancy. Below
// this, a settled_amount and the owed amount are "the same number".
const SETTLEMENT_VARIANCE_TOLERANCE = 0.005;

// ════════════════════════════════════════════════════════════════════════════
// PURE HELPERS (no I/O — exercised directly by the harness)
// ════════════════════════════════════════════════════════════════════════════

const asArray = (v) => (Array.isArray(v) ? v : []);
const vidOf = (v) => (v == null ? '' : String(v).trim());

/**
 * Apply an edit to a line-item array. PURE — never mutates the input.
 *
 * Order of operations is load-bearing and matches the reference:
 *   1. every ADD first  (existing variant → quantity accumulates, capped)
 *   2. then every QUANTITY EDIT (absolute set; 0 removes the line)
 * so an add and a line_edit naming the same variant in one request resolve to
 * the line_edit's ABSOLUTE quantity — it does not stack. Any other order makes
 * "set this line to 2" mean different things depending on the rest of the body.
 *
 * A line_edit naming a variant that is not on the order is IGNORED, not an
 * error: it is the natural outcome of two operators editing the same order,
 * and failing the whole edit for it would punish the slower one twice.
 */
export function applyEdits(lineItems, addLines, lineEdits) {
  const out = asArray(lineItems).map((li) => ({ ...li }));
  const indexOf = (vid) => out.findIndex((li) => vidOf(li.variant_id) === vid);

  for (const add of asArray(addLines)) {
    const vid = vidOf(add?.variant_id);
    if (!vid) continue;
    const qty = Math.max(1, Math.min(parseInt(add.quantity, 10) || 1, EDIT_LIMITS.MAX_QTY));
    const at = indexOf(vid);
    if (at >= 0) {
      const next = Math.min(EDIT_LIMITS.MAX_QTY, (parseInt(out[at].quantity, 10) || 0) + qty);
      out[at] = { ...out[at], quantity: next };
    } else {
      const line = { variant_id: vid, quantity: qty };
      if (add.price != null) line.price = round2(Number(add.price));
      if (typeof add.title === 'string' && add.title) line.title = add.title.slice(0, 250);
      if (typeof add.product_title === 'string' && add.product_title) {
        line.product_title = add.product_title.slice(0, 250);
      }
      if (add.currency) line.currency = String(add.currency).slice(0, 8);
      if (add.image) line.image = String(add.image).slice(0, 1000);
      out.push(line);
    }
  }

  for (const edit of asArray(lineEdits)) {
    const vid = vidOf(edit?.variant_id);
    if (!vid) continue;
    const at = indexOf(vid);
    if (at < 0) continue; // silently ignored — see the docblock
    const raw = parseInt(edit.quantity, 10);
    const qty = Number.isFinite(raw) ? raw : null;
    if (qty === null) continue;
    if (qty <= 0) {
      out.splice(at, 1);
    } else {
      out[at] = { ...out[at], quantity: Math.min(EDIT_LIMITS.MAX_QTY, qty) };
    }
  }

  // Recompute the denormalized line_total the mint path writes, so the two
  // producers of a line item never disagree about it.
  return out.slice(0, EDIT_LIMITS.MAX_LINES).map((li) => {
    const price = li.price == null ? null : round2(Number(li.price));
    const qty = parseInt(li.quantity, 10) || 0;
    return {
      ...li,
      quantity: qty,
      ...(price == null ? {} : { price, line_total: round2(price * qty) }),
    };
  });
}

/**
 * Subtotal of a line array. Returns { ok, subtotal } or { ok:false,
 * unpriced:[variant_id] } — a null/NaN price is REPORTED, never coerced to 0.
 * A silently-zeroed line is the difference between "this item is free" and
 * "we do not know what this item costs", and only one of those is safe to show
 * an operator next to a Confirm button.
 */
export function subtotalOf(lineItems) {
  const unpriced = [];
  let sum = 0;
  for (const li of asArray(lineItems)) {
    const qty = parseInt(li?.quantity, 10);
    const price = li?.price;
    if (price == null || price === '' || !Number.isFinite(Number(price))) {
      unpriced.push(vidOf(li?.variant_id));
      continue;
    }
    if (!Number.isFinite(qty) || qty < 0) {
      unpriced.push(vidOf(li?.variant_id));
      continue;
    }
    sum += Number(price) * qty;
  }
  if (unpriced.length) return { ok: false, unpriced };
  return { ok: true, subtotal: round2(sum) };
}

/**
 * Recompute the order's money from the post-edit lines. PURE.
 *
 * Our co_sessions models shipping / tax / discount_amount as real columns
 * (the reference bakes them opaquely into `total`), so we recompute honestly
 * from the components rather than applying a subtotal delta and hoping the
 * baked-in parts survive. Those three components are held CONSTANT: an edit
 * moves goods, not freight or promo arithmetic.
 *
 * `captured_total` is what the gateway actually took and is returned untouched
 * — the caller must never confuse it with `owed_after`.
 */
export function recomputeTotals(session, newItems) {
  const before = subtotalOf(session?.line_items);
  const after = subtotalOf(newItems);
  if (!before.ok) return { ok: false, error: 'unpriced_line', unpriced: before.unpriced, where: 'before' };
  if (!after.ok) return { ok: false, error: 'unpriced_line', unpriced: after.unpriced, where: 'after' };

  const shipping = round2(Number(session?.shipping) || 0);
  const tax = round2(Number(session?.tax) || 0);
  const discount = round2(Number(session?.discount_amount) || 0);
  const capturedTotal = round2(Number(session?.total) || 0);

  const owedBefore = Math.max(0, round2(before.subtotal + shipping + tax - discount));
  const owedAfter = Math.max(0, round2(after.subtotal + shipping + tax - discount));

  return {
    ok: true,
    subtotal_before: before.subtotal,
    subtotal_after: after.subtotal,
    subtotal_delta: round2(after.subtotal - before.subtotal),
    shipping,
    tax,
    discount_amount: discount,
    // What the gateway captured for the ORIGINAL sale. NEVER moved by an edit.
    captured_total: capturedTotal,
    // What the order was worth immediately before this edit, and after it.
    owed_before: owedBefore,
    owed_after: owedAfter,
    // THIS EDIT'S OWN money impact — owed_after − owed_before.
    //
    // Measuring against captured_total instead would be wrong on the SECOND
    // edit and every one after it: the first edit's divergence is already
    // parked in its own open settlement row, so a second edit measured against
    // `captured` would re-book that same divergence a second time. Measured
    // per-edit, the open settlement rows SUM to the cumulative divergence,
    // which is the invariant a reader can actually check.
    //
    // Positive = the buyer owes us more. Negative = we owe the buyer. Exactly
    // 0 means computed-and-neutral, NOT "unknown" — this function always
    // computes or returns ok:false.
    total_delta: round2(owedAfter - owedBefore),
    // owed_after − captured_total: the WHOLE divergence between what was taken
    // and what the corrected order is worth. Display only — never the basis of
    // a settlement row, for the reason above.
    cumulative_delta: round2(owedAfter - capturedTotal),
  };
}

/**
 * Normalize an inbound shipping address into OUR stored shape.
 *
 * Deliberately OUR field names (address1/address2/city/state/zip/country) —
 * the shape checkoutPublic's cleanCustomer writes into co_sessions.customer
 * .shipping. Porting the reference's province_code/country_code names would
 * have produced an address the rest of this system cannot read.
 *
 * Returns { ok:false, error:'invalid_address' } when address1 is blank: an
 * address object without a street line is not a partial address, it is a
 * no-op that would otherwise blank the buyer's real one.
 */
export function normalizeShippingAddress(raw) {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
    return { ok: false, error: 'invalid_address' };
  }
  const s = (v, max) => (typeof v === 'string' ? v.trim().slice(0, max) : '');
  const address1 = s(raw.address1, 200);
  if (!address1) return { ok: false, error: 'invalid_address' };
  return {
    ok: true,
    address: {
      address1,
      address2: s(raw.address2, 200),
      city: s(raw.city, 100),
      state: s(raw.state ?? raw.province ?? raw.province_code, 100),
      zip: s(raw.zip ?? raw.postal_code, 20),
      country: s(raw.country ?? raw.country_code, 60),
    },
  };
}

// Field-by-field comparison over the six stored keys only. Comparing whole
// objects with JSON.stringify would report a change whenever key ORDER
// differed, which is how a no-op edit acquires a fake audit row.
export function addressChanged(before, after) {
  const keys = ['address1', 'address2', 'city', 'state', 'zip', 'country'];
  const b = before && typeof before === 'object' ? before : {};
  return keys.some((k) => String(b[k] ?? '').trim() !== String(after?.[k] ?? '').trim());
}

// Which side of the seam a delta falls on. Below the epsilon there is no seam.
export function settlementDirection(totalDelta) {
  const d = Number(totalDelta) || 0;
  if (d > EDIT_LIMITS.DELTA_EPSILON) return 'charge';
  if (d < -EDIT_LIMITS.DELTA_EPSILON) return 'refund';
  return null;
}

// ════════════════════════════════════════════════════════════════════════════
// PRICING (READ-ONLY use of checkoutPricing)
// ════════════════════════════════════════════════════════════════════════════

/**
 * Server-price the ADDED lines. Never trusts a client price.
 *
 * @returns {{ok:true, lines:Array}}
 *        | {{ok:false, error:'invalid_variant', variant_id}}
 *        | {{ok:false, error:'currency_mismatch', shop_currency}}
 * @throws {PricingUnavailableError} transport-class — the caller maps it to a
 *         RETRYABLE 503. Conflating it with invalid_variant is how a Shopify
 *         outage gets reported to an operator as "that product doesn't exist".
 */
export async function priceAddedLines(addLines, sessionCurrency) {
  const wanted = [];
  const seen = new Set();
  for (const a of asArray(addLines).slice(0, EDIT_LIMITS.MAX_ADD_LINES)) {
    const vid = vidOf(a?.variant_id);
    if (!vid || seen.has(vid)) continue;
    seen.add(vid);
    wanted.push({
      variant_id: vid,
      quantity: Math.max(1, Math.min(parseInt(a.quantity, 10) || 1, EDIT_LIMITS.MAX_QTY)),
      client_title: typeof a.title === 'string' ? a.title.slice(0, 250) : '',
    });
  }
  if (!wanted.length) return { ok: true, lines: [] };

  const priced = await resolveVariantPrices(wanted.map((w) => w.variant_id));

  // Fail closed when the shop's currency disagrees with the session's — the
  // whole store is mispriced relative to this order and no per-line fixup can
  // make the arithmetic honest.
  const mismatch = currencyMismatch(priced, sessionCurrency);
  if (mismatch) return { ok: false, error: 'currency_mismatch', shop_currency: mismatch };

  const lines = [];
  for (const w of wanted) {
    const info = priced[toVariantGid(w.variant_id)];
    // Omitted by resolveVariantPrices = unknown / draft / archived / not
    // available for sale. Reject the whole edit rather than silently dropping
    // the line the operator thinks they just added.
    if (!info) return { ok: false, error: 'invalid_variant', variant_id: w.variant_id };
    const price = round2(Number(info.price));
    lines.push({
      variant_id: w.variant_id,
      quantity: w.quantity,
      price,
      currency: info.currency || sessionCurrency || 'USD',
      title: w.client_title || info.title || '',
      product_title: info.product_title || '',
      image: info.image || null,
      line_total: round2(price * w.quantity),
    });
  }
  return { ok: true, lines };
}

// ════════════════════════════════════════════════════════════════════════════
// READS
// ════════════════════════════════════════════════════════════════════════════

const SESSION_COLUMNS = `
  id, funnel_id, status, line_items, subtotal, shipping, tax, total,
  discount_amount, currency, customer, gateway, gateway_session_id,
  payment_method_id, needs_review_reason, paid_at, created_at, updated_at
`;

export async function loadSession(sessionId) {
  const rows = await pgQuery(
    `SELECT ${SESSION_COLUMNS} FROM co_sessions WHERE id = $1`,
    [String(sessionId || '').slice(0, 80)]
  );
  return rows.length ? rows[0] : null;
}

// The highest recorded version for a session, or 0 when never edited.
export async function currentVersion(sessionId) {
  const rows = await pgQuery(
    `SELECT COALESCE(MAX(version), 0)::int AS v FROM co_order_edits WHERE session_id = $1`,
    [sessionId]
  );
  return rows[0]?.v ?? 0;
}

/**
 * Is this order already fulfilled? Two independent sources, and BOTH are
 * consulted because they can disagree honestly:
 *   co_orders.shopify_order_id → crm_orders.fulfillment_status  (the store)
 * A fulfilled order is refused: the goods left the building, so changing the
 * line items would describe a shipment that did not happen.
 * A missing crm_orders row is NOT fulfilment — it is an un-mirrored order, and
 * treating "unknown" as "fulfilled" would make every draft order uneditable.
 */
export async function fulfillmentState(sessionId) {
  const rows = await pgQuery(
    `SELECT o.shopify_order_id, c.fulfillment_status, c.order_id
       FROM co_orders o
       LEFT JOIN crm_orders c ON c.shopify_order_id = o.shopify_order_id::bigint
      WHERE o.session_id = $1 AND o.shopify_order_id IS NOT NULL
      ORDER BY o.created_at ASC
      LIMIT 1`,
    [sessionId]
  );
  const row = rows[0] || null;
  const status = String(row?.fulfillment_status || '').toLowerCase();
  return {
    shopify_order_id: row?.shopify_order_id || null,
    crm_order_id: row?.order_id ?? null,
    fulfillment_status: row?.fulfillment_status || null,
    fulfilled: ['fulfilled', 'shipped', 'delivered'].includes(status),
  };
}

/**
 * Everything the order-detail surface needs: the live snapshot, the full
 * append-only version history, the push state and the open money seam.
 * Windowed — an order with a pathological edit count must not return an
 * unbounded array into a page render.
 */
export async function readEditState(sessionId, { historyLimit = 50 } = {}) {
  await ensureOrderEditTables();
  const session = await loadSession(sessionId);
  if (!session) return { ok: false, error: 'session_not_found' };

  const limit = Math.max(1, Math.min(parseInt(historyLimit, 10) || 50, 200));
  const [history, settlements, pushes, counted, fulfil] = await Promise.all([
    pgQuery(
      `SELECT id, edit_id, version, base_version, delta, subtotal_before, subtotal_after,
              subtotal_delta, captured_total, owed_after, total_delta, currency,
              address_changed, session_status, created_by, created_at
         FROM co_order_edits
        WHERE session_id = $1
        ORDER BY version DESC
        LIMIT $2`,
      [sessionId, limit]
    ),
    pgQuery(
      `SELECT edit_row_id, version, direction, amount, currency, status,
              gateway_payment_id, settled_amount, note, resolved_by, resolved_at, created_at
         FROM co_order_edit_settlements
        WHERE session_id = $1
        ORDER BY version DESC
        LIMIT $2`,
      [sessionId, limit]
    ),
    pgQuery(
      `SELECT edit_row_id, status, reason, shopify_order_id, detail, updated_at
         FROM co_order_edit_pushes
        WHERE session_id = $1
        ORDER BY updated_at DESC
        LIMIT $2`,
      [sessionId, limit]
    ),
    pgQuery(
      `SELECT COUNT(*)::int AS n, COALESCE(MAX(version), 0)::int AS v
         FROM co_order_edits WHERE session_id = $1`,
      [sessionId]
    ),
    fulfillmentState(sessionId),
  ]);

  const totalEdits = counted[0]?.n ?? 0;
  const openSeam = settlements.filter((s) => s.status === 'needs_settlement');
  // What the order is worth RIGHT NOW, from the same components an edit uses.
  // Derived rather than stored, so it cannot drift from the line items.
  const owedNow = Math.max(0, round2(
    (Number(session.subtotal) || 0) + (Number(session.shipping) || 0)
    + (Number(session.tax) || 0) - (Number(session.discount_amount) || 0)
  ));
  return {
    ok: true,
    session: {
      id: session.id,
      status: session.status,
      currency: session.currency,
      line_items: asArray(session.line_items),
      shipping_address: session.customer?.shipping || null,
      subtotal: Number(session.subtotal),
      shipping: Number(session.shipping),
      tax: Number(session.tax),
      discount_amount: Number(session.discount_amount),
      captured_total: Number(session.total),
      owed_now: owedNow,
      // The whole divergence between money taken and goods owed.
      //
      // IDENTITY (the cheapest possible audit of the seam): while every edit's
      // settlement is still OPEN, cumulative_delta equals open_settlement_net.
      // The identity has ONE PRECONDITION worth stating for whoever asserts it:
      // captured_total must equal what the order was owed at PURCHASE time —
      // i.e. the capture matched the original cart. That holds for a normally
      // -settled session (co_sessions.total IS that owed amount) and is what
      // the harness exercises. It does NOT hold for an order captured at a
      // hand-adjusted amount or one partly refunded outside the edit flow, and
      // any settlement that has since been resolved (settled/waived/failed)
      // drops out of open_settlement_net while remaining in the history — so
      // the equality is an invariant of the OPEN set under that precondition,
      // not a universal one. We deliberately do NOT publish a boolean for it:
      // after an edit, session.subtotal is the POST-edit value, so the original
      // owed amount cannot be reconstructed here to test the precondition
      // honestly, and a flag that guessed would be worse than this note.
      cumulative_delta: round2(owedNow - (Number(session.total) || 0)),
      paid_at: session.paid_at,
      needs_review_reason: session.needs_review_reason,
    },
    editable: EDITABLE_SESSION_STATUSES.includes(session.status) && !fulfil.fulfilled,
    not_editable_reason: !EDITABLE_SESSION_STATUSES.includes(session.status)
      ? `status:${session.status}`
      : fulfil.fulfilled
        ? 'already_fulfilled'
        : null,
    fulfillment: fulfil,
    version: counted[0]?.v ?? 0,
    history,
    history_capped: totalEdits > history.length,
    history_total: totalEdits,
    settlements,
    pushes,
    open_settlement_count: openSeam.length,
    // Signed net of the OPEN seam only. Sums directions so an order with an
    // unresolved charge AND an unresolved refund reads as its true exposure.
    open_settlement_net: round2(
      openSeam.reduce((s, r) => s + (r.direction === 'refund' ? -Number(r.amount) : Number(r.amount)), 0)
    ),
  };
}

// ════════════════════════════════════════════════════════════════════════════
// PREVIEW — pure computation over a live session. Writes NOTHING.
// ════════════════════════════════════════════════════════════════════════════

/**
 * @returns {Promise<{ok:true, preview:object} | {ok:false, error:string, ...}>}
 * Never throws for a caller-fixable fault. PricingUnavailableError is the one
 * exception and is deliberately allowed to propagate so the route maps it to a
 * retryable 503 rather than a permanent 4xx.
 */
export async function buildPreview(session, body = {}) {
  const addLinesRaw = asArray(body.add_lines).slice(0, EDIT_LIMITS.MAX_ADD_LINES);
  const lineEditsRaw = asArray(body.line_edits).slice(0, EDIT_LIMITS.MAX_LINE_EDITS);

  let address = null;
  let addrChanged = false;
  if (body.shipping_address !== undefined && body.shipping_address !== null) {
    const norm = normalizeShippingAddress(body.shipping_address);
    if (!norm.ok) return { ok: false, error: norm.error };
    address = norm.address;
    addrChanged = addressChanged(session.customer?.shipping, address);
  }

  // Price the adds BEFORE applying them: an add that cannot be priced must
  // fail the whole edit, never enter the cart at the client's number.
  const pricedAdds = await priceAddedLines(addLinesRaw, session.currency);
  if (!pricedAdds.ok) return pricedAdds;

  const beforeItems = asArray(session.line_items);
  const afterItems = applyEdits(beforeItems, pricedAdds.lines, lineEditsRaw);

  if (afterItems.length > EDIT_LIMITS.MAX_LINES) {
    return { ok: false, error: 'too_many_lines' };
  }

  const totals = recomputeTotals(session, afterItems);
  if (!totals.ok) return totals;

  // What actually changed, computed from the RESULT rather than the request —
  // a request asking for qty 2 on a line already at 2 is not a change, and
  // recording it as one produces an audit row that lies.
  const beforeByVid = new Map(beforeItems.map((li) => [vidOf(li.variant_id), li]));
  const afterByVid = new Map(afterItems.map((li) => [vidOf(li.variant_id), li]));
  const changes = [];
  for (const [vid, after] of afterByVid) {
    const before = beforeByVid.get(vid);
    if (!before) {
      changes.push({ kind: 'added', variant_id: vid, quantity: after.quantity, price: after.price ?? null, title: after.title || after.product_title || '' });
    } else if ((parseInt(before.quantity, 10) || 0) !== (parseInt(after.quantity, 10) || 0)) {
      changes.push({ kind: 'quantity', variant_id: vid, from: parseInt(before.quantity, 10) || 0, to: after.quantity, price: after.price ?? null, title: after.title || after.product_title || '' });
    }
  }
  for (const [vid, before] of beforeByVid) {
    if (!afterByVid.has(vid)) {
      changes.push({ kind: 'removed', variant_id: vid, from: parseInt(before.quantity, 10) || 0, price: before.price ?? null, title: before.title || before.product_title || '' });
    }
  }

  const direction = settlementDirection(totals.total_delta);
  const dirty = changes.length > 0 || addrChanged;

  return {
    ok: true,
    preview: {
      dirty,
      line_items_before: beforeItems,
      line_items_after: afterItems,
      changes,
      address_changed: addrChanged,
      shipping_address_before: session.customer?.shipping || null,
      shipping_address_after: address,
      ...totals,
      settlement: direction
        ? { direction, amount: round2(Math.abs(totals.total_delta)), currency: session.currency || 'USD' }
        : null,
      // A price increase on a session that never captured anything is not a
      // "needs settlement" — it is just a bigger cart. Surfaced so the UI can
      // say the right sentence.
      session_paid: PAID_SESSION_STATUSES.includes(session.status),
    },
    _internal: { afterItems, address, addrChanged, changes, totals, direction, addLinesRaw, lineEditsRaw },
  };
}

// ════════════════════════════════════════════════════════════════════════════
// COMMIT
// ════════════════════════════════════════════════════════════════════════════

const editRowId = (sessionId, editId) =>
  `oe_${crypto.createHash('sha256').update(`${sessionId}:${editId}`).digest('hex').slice(0, 40)}`;

/**
 * Return the recorded outcome of an edit that already happened. A client
 * retrying with the same edit_id gets the ORIGINAL result — never a second
 * application, never a fabricated success.
 */
async function replayResult(sessionId, editId) {
  const rows = await pgQuery(
    `SELECT e.*, p.status AS push_status, p.reason AS push_reason,
            s.status AS settlement_status, s.direction, s.amount AS settlement_amount
       FROM co_order_edits e
       LEFT JOIN co_order_edit_pushes p ON p.edit_row_id = e.id
       LEFT JOIN co_order_edit_settlements s ON s.edit_row_id = e.id
      WHERE e.session_id = $1 AND e.edit_id = $2`,
    [sessionId, editId]
  );
  if (!rows.length) return null;
  const r = rows[0];
  return {
    ok: true,
    replayed: true,
    edit_row_id: r.id,
    version: r.version,
    total_delta: Number(r.total_delta),
    captured_total: Number(r.captured_total),
    owed_after: Number(r.owed_after),
    address_changed: r.address_changed,
    push_status: r.push_status || 'skipped',
    push_reason: r.push_reason || null,
    settlement: r.settlement_status
      ? { status: r.settlement_status, direction: r.direction, amount: Number(r.settlement_amount) }
      : null,
    after_snapshot: r.after_snapshot,
  };
}

/**
 * Apply an edit. Sequence, and why it is this sequence:
 *
 *  1. GUARD    — session exists, status editable, not fulfilled, body sane.
 *  2. PREVIEW  — the same pure computation the preview endpoint returns, so
 *                the number the operator confirmed is the number we record.
 *  3. CLAIM    — INSERT the immutable version row. This is the concurrency
 *                gate: UNIQUE(session_id, version) rejects a stale base, and
 *                UNIQUE(session_id, edit_id) turns a retry into a replay. The
 *                claim is taken BEFORE any external call, so a crash mid-push
 *                leaves a durable record of what we intended.
 *  4. SEAM     — write the needs-settlement row (money is NOT moved).
 *  5. MIRROR   — update co_sessions' snapshot (goods + address). Never `total`.
 *  6. PUSH     — optional, gated, non-fatal Shopify mirror. Failure marks the
 *                push row 'needs_review'; it never un-does the edit and is
 *                never auto-retried (Shopify's orderEditCommit is additive).
 *  7. AUDIT    — co_events row, non-fatal.
 *
 * Steps 5–7 are all AFTER the durable claim, so every one of them can fail
 * without producing a phantom edit or a double application.
 */
export async function commitEdit({ sessionId, body = {}, actor = '', pushFn = null }) {
  await ensureOrderEditTables();

  const editId = String(body.edit_id || '').trim();
  if (!editId) return { ok: false, error: 'edit_id_required', status: 400 };
  if (!EDIT_ID_RE.test(editId)) return { ok: false, error: 'bad_edit_id', status: 400 };

  const session = await loadSession(sessionId);
  if (!session) return { ok: false, error: 'session_not_found', status: 404 };

  // A retry of an edit we already applied replays, and does so BEFORE the
  // editability guards: an order that became fulfilled between the first call
  // and its retry must still return the original result, not 'already_fulfilled'.
  const prior = await replayResult(session.id, editId);
  if (prior) return prior;

  if (!EDITABLE_SESSION_STATUSES.includes(session.status)) {
    return { ok: false, error: 'not_editable', status: 409, detail: `status:${session.status}` };
  }
  const fulfil = await fulfillmentState(session.id);
  if (fulfil.fulfilled) return { ok: false, error: 'already_fulfilled', status: 409 };

  let preview;
  try {
    preview = await buildPreview(session, body);
  } catch (err) {
    if (err instanceof PricingUnavailableError) {
      return { ok: false, error: 'pricing_unavailable', status: 503 };
    }
    throw err;
  }
  if (!preview.ok) {
    const map = {
      invalid_variant: 422, currency_mismatch: 422, unpriced_line: 422,
      too_many_lines: 422, invalid_address: 422,
    };
    return { ...preview, status: map[preview.error] || 422 };
  }
  const p = preview.preview;
  if (!p.dirty) return { ok: false, error: 'no_changes', status: 422 };

  // PRICE-DRIFT GUARD. The commit re-prices added lines against Shopify
  // independently of the preview, so a catalog price that moved between the
  // operator seeing the delta and clicking Save would be recorded silently at
  // the new number. When the client sends the delta it displayed
  // (`expected_total_delta`), we refuse a commit whose freshly-computed delta
  // differs beyond the epsilon and hand back the new figures, so the modal can
  // re-preview and ask the operator to confirm the changed amount. Omitting the
  // field opts out (a scripted caller that does not show a human a number).
  if (body.expected_total_delta !== undefined && body.expected_total_delta !== null) {
    const expected = Number(body.expected_total_delta);
    if (Number.isFinite(expected)
        && Math.abs(expected - p.total_delta) > EDIT_LIMITS.DELTA_EPSILON) {
      return {
        ok: false,
        error: 'price_changed',
        status: 409,
        expected_total_delta: round2(expected),
        current_total_delta: p.total_delta,
        subtotal_after: p.subtotal_after,
        owed_after: p.owed_after,
        settlement: p.settlement,
      };
    }
  }

  // Optimistic concurrency. An absent base_version means "I did not look" —
  // we then compute it, which is safe for a single operator and still races
  // correctly because the unique index, not this read, is the arbiter.
  const observed = await currentVersion(session.id);
  const baseVersion = body.base_version === undefined || body.base_version === null
    ? observed
    : parseInt(body.base_version, 10);
  if (!Number.isFinite(baseVersion) || baseVersion < 0) {
    return { ok: false, error: 'bad_base_version', status: 400 };
  }
  if (baseVersion !== observed) {
    return { ok: false, error: 'stale_version', status: 409, current_version: observed, sent: baseVersion };
  }
  const version = baseVersion + 1;
  const rowId = editRowId(session.id, editId);
  const currency = session.currency || 'USD';

  const beforeSnapshot = {
    line_items: p.line_items_before,
    shipping_address: p.shipping_address_before,
    subtotal: p.subtotal_before,
    shipping: p.shipping,
    tax: p.tax,
    discount_amount: p.discount_amount,
    total: p.captured_total,
  };
  const afterSnapshot = {
    line_items: p.line_items_after,
    shipping_address: p.address_changed ? p.shipping_address_after : p.shipping_address_before,
    subtotal: p.subtotal_after,
    shipping: p.shipping,
    tax: p.tax,
    discount_amount: p.discount_amount,
    // The captured total, unchanged. Recorded on the snapshot so a reader of
    // v3 alone can see that owed and captured diverged, without a join.
    total: p.captured_total,
    owed: p.owed_after,
  };

  // ── 3. CLAIM (the durable, immutable, arbitrating write) ──────────────────
  let claimed;
  try {
    claimed = await pgQuery(
      `INSERT INTO co_order_edits (
         id, session_id, edit_id, version, base_version, delta,
         before_snapshot, after_snapshot,
         subtotal_before, subtotal_after, subtotal_delta,
         captured_total, owed_after, total_delta, currency,
         address_changed, session_status, created_by
       ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18)
       ON CONFLICT DO NOTHING
       RETURNING id, version, created_at`,
      [
        rowId, session.id, editId, version, baseVersion,
        { changes: p.changes, address_changed: p.address_changed },
        beforeSnapshot, afterSnapshot,
        p.subtotal_before, p.subtotal_after, p.subtotal_delta,
        p.captured_total, p.owed_after, p.total_delta, currency,
        p.address_changed, session.status, String(actor || '').slice(0, 200),
      ]
    );
  } catch (err) {
    console.error('[orderEdit] version claim failed:', err.message);
    return { ok: false, error: 'edit_write_failed', status: 500 };
  }
  if (!claimed.length) {
    // Someone else took this version (or this edit_id) between our read and
    // our insert. Re-resolve: a replay is a success, a version race is a 409.
    const again = await replayResult(session.id, editId);
    if (again) return again;
    return { ok: false, error: 'stale_version', status: 409, current_version: await currentVersion(session.id) };
  }

  // ── 4. THE MONEY SEAM ─────────────────────────────────────────────────────
  // Written for a PAID session only. On an unpaid ('processing') session the
  // cart simply changed and there is nothing to settle — the eventual capture
  // will use the corrected snapshot.
  let settlement = null;
  if (p.settlement && PAID_SESSION_STATUSES.includes(session.status)) {
    try {
      const ins = await pgQuery(
        `INSERT INTO co_order_edit_settlements
           (edit_row_id, session_id, version, direction, amount, currency, status)
         VALUES ($1,$2,$3,$4,$5,$6,'needs_settlement')
         ON CONFLICT (edit_row_id) DO NOTHING
         RETURNING edit_row_id, direction, amount, currency, status`,
        [rowId, session.id, version, p.settlement.direction, p.settlement.amount, currency]
      );
      settlement = ins[0] || null;
    } catch (err) {
      // The edit is already durable. A failed seam write is loud, not fatal —
      // but it MUST be visible, so we park the session for a human using the
      // money path's own channel rather than swallowing it.
      console.error('[orderEdit] settlement write failed:', err.message);
      await pgQuery(
        `UPDATE co_sessions SET needs_review_reason = $2, updated_at = NOW()
          WHERE id = $1 AND needs_review_reason IS NULL`,
        [session.id, `order_edit_settlement_write_failed:${rowId}`.slice(0, 300)]
      ).catch(() => {});
    }
  }

  // ── 5. MIRROR the snapshot. `total` is deliberately absent from this SET.
  const nextCustomer = p.address_changed
    ? { ...(session.customer || {}), shipping: p.shipping_address_after }
    : null;
  try {
    if (nextCustomer) {
      await pgQuery(
        `UPDATE co_sessions
            SET line_items = $2, subtotal = $3, customer = $4, updated_at = NOW()
          WHERE id = $1`,
        [session.id, p.line_items_after, p.subtotal_after, nextCustomer]
      );
    } else {
      await pgQuery(
        `UPDATE co_sessions
            SET line_items = $2, subtotal = $3, updated_at = NOW()
          WHERE id = $1`,
        [session.id, p.line_items_after, p.subtotal_after]
      );
    }
  } catch (err) {
    // The version row is durable and truthful; the live snapshot is stale.
    // That is a reconcilable state and a human must own it.
    console.error('[orderEdit] snapshot mirror failed:', err.message);
    await pgQuery(
      `UPDATE co_sessions SET needs_review_reason = $2, updated_at = NOW()
        WHERE id = $1 AND needs_review_reason IS NULL`,
      [session.id, `order_edit_mirror_failed:${rowId}`.slice(0, 300)]
    ).catch(() => {});
  }

  // ── 6. SHOPIFY MIRROR (gated, non-fatal, never auto-retried) ──────────────
  let push = { status: 'skipped', reason: 'push_disabled' };
  try {
    const doPush = pushFn || (await import('./shopifyOrderEdit.js')).pushOrderEdit;
    push = await doPush({
      sessionId: session.id,
      editRowId: rowId,
      shopifyOrderId: fulfil.shopify_order_id,
      changes: p.changes,
      shippingAddress: p.address_changed ? p.shipping_address_after : null,
    });
  } catch (err) {
    console.error('[orderEdit] shopify push threw (non-fatal):', err.message);
    push = { status: 'needs_review', reason: `exception:${err.message}`.slice(0, 300) };
  }
  await pgQuery(
    `INSERT INTO co_order_edit_pushes (edit_row_id, session_id, shopify_order_id, status, reason, detail)
     VALUES ($1,$2,$3,$4,$5,$6)
     ON CONFLICT (edit_row_id) DO UPDATE
       SET status = EXCLUDED.status, reason = EXCLUDED.reason,
           detail = EXCLUDED.detail, updated_at = NOW()`,
    [
      rowId, session.id, fulfil.shopify_order_id || null,
      PUSH_STATUSES.includes(push.status) ? push.status : 'needs_review',
      String(push.reason || '').slice(0, 300),
      push.detail || {},
    ]
  ).catch((err) => console.error('[orderEdit] push-state write failed:', err.message));

  // ── 7. AUDIT (analytics side of the line — never fatal) ───────────────────
  try {
    await pgQuery(
      `INSERT INTO co_events (session_id, kind, data) VALUES ($1, 'order_edited', $2)`,
      [session.id, {
        edit_row_id: rowId, edit_id: editId, version,
        changes: p.changes, address_changed: p.address_changed,
        subtotal_delta: p.subtotal_delta, total_delta: p.total_delta,
        captured_total: p.captured_total, owed_after: p.owed_after,
        settlement: settlement ? { direction: settlement.direction, amount: Number(settlement.amount) } : null,
        push_status: push.status, by: String(actor || '').slice(0, 200),
      }]
    );
  } catch (err) {
    console.error('[orderEdit] co_events write failed (non-fatal):', err.message);
  }

  return {
    ok: true,
    replayed: false,
    edit_row_id: rowId,
    version,
    base_version: baseVersion,
    changes: p.changes,
    address_changed: p.address_changed,
    line_items: p.line_items_after,
    subtotal_before: p.subtotal_before,
    subtotal_after: p.subtotal_after,
    subtotal_delta: p.subtotal_delta,
    captured_total: p.captured_total,
    owed_after: p.owed_after,
    total_delta: p.total_delta,
    currency,
    settlement: settlement
      ? { direction: settlement.direction, amount: Number(settlement.amount), currency: settlement.currency, status: settlement.status }
      : null,
    push_status: push.status,
    push_reason: push.reason || null,
  };
}

// ════════════════════════════════════════════════════════════════════════════
// SETTLEMENT QUEUE (operator surface — records outcomes, moves no money)
// ════════════════════════════════════════════════════════════════════════════

export async function listSettlements({ status = 'needs_settlement', days = 90, limit = 50, offset = 0 } = {}) {
  await ensureOrderEditTables();
  const lim = Math.max(1, Math.min(parseInt(limit, 10) || 50, 200));
  const off = Math.max(0, parseInt(offset, 10) || 0);
  const win = Math.max(1, Math.min(parseInt(days, 10) || 90, 365));
  const wantAll = status === 'all';
  const st = SETTLEMENT_STATUSES.includes(status) ? status : 'needs_settlement';

  const where = wantAll
    ? `s.created_at >= NOW() - ($1 || ' days')::interval`
    : `s.status = $2 AND s.created_at >= NOW() - ($1 || ' days')::interval`;
  const params = wantAll ? [String(win)] : [String(win), st];

  const rows = await pgQuery(
    `SELECT s.edit_row_id, s.session_id, s.version, s.direction, s.amount, s.currency,
            s.status, s.gateway_payment_id, s.settled_amount, s.variance, s.note,
            s.resolved_by, s.resolved_at, s.created_at,
            e.edit_id, e.delta, e.captured_total, e.owed_after, e.created_by,
            ses.status AS session_status, ses.customer ->> 'email' AS customer_email,
            o.shopify_order_id
       FROM co_order_edit_settlements s
       JOIN co_order_edits e ON e.id = s.edit_row_id
       LEFT JOIN co_sessions ses ON ses.id = s.session_id
       LEFT JOIN LATERAL (
         SELECT shopify_order_id FROM co_orders
          WHERE session_id = s.session_id AND shopify_order_id IS NOT NULL
          ORDER BY created_at ASC LIMIT 1
       ) o ON TRUE
      WHERE ${where}
      ORDER BY s.created_at DESC
      LIMIT ${lim} OFFSET ${off}`,
    params
  );
  const [{ n }] = await pgQuery(
    `SELECT COUNT(*)::int AS n FROM co_order_edit_settlements s WHERE ${where}`,
    params
  );
  // Exposure is reported PER DIRECTION. A single net number would let a
  // $500 refund owed and a $500 charge owed cancel to "nothing to do".
  const [totals] = await pgQuery(
    `SELECT
       COALESCE(SUM(amount) FILTER (WHERE direction = 'charge'), 0)::numeric AS charge_total,
       COALESCE(SUM(amount) FILTER (WHERE direction = 'refund'), 0)::numeric AS refund_total,
       COUNT(*) FILTER (WHERE direction = 'charge')::int AS charge_count,
       COUNT(*) FILTER (WHERE direction = 'refund')::int AS refund_count
     FROM co_order_edit_settlements s WHERE ${where}`,
    params
  );
  return {
    rows,
    total: n,
    limit: lim,
    offset: off,
    days: win,
    status: wantAll ? 'all' : st,
    totals: {
      charge_total: Number(totals.charge_total),
      refund_total: Number(totals.refund_total),
      charge_count: totals.charge_count,
      refund_count: totals.refund_count,
    },
  };
}

/**
 * Record the OUTCOME of a settlement. This function moves no money and calls
 * no gateway — see the MONEY SEAM contract in the module header and the route
 * file. It is an atomic claim on a still-open row, so two operators clicking
 * "mark settled" produce one transition and one `not_open` refusal.
 *
 * HONESTY CHECK: when a settled_amount is recorded on a `settled` outcome, the
 * UPDATE compares it against what the seam said was owed (the row's own
 * `amount`) and sets `variance = TRUE` when they differ beyond a half-cent. The
 * attestation is NOT refused — an operator may settle at a different number for
 * legitimate reasons — but the discrepancy is flagged so a $100 charge marked
 * settled at $1 is queryable, not clean-looking. The comparison is done in SQL
 * against the row's column so it is atomic with the claim and cannot be raced.
 * A `waived`/`failed` outcome, or a settle with no amount, carries no variance.
 */
export async function resolveSettlement({ editRowId, action, actor = '', note = '', gatewayPaymentId = '', settledAmount = null }) {
  await ensureOrderEditTables();
  const target = { settled: 'settled', waived: 'waived', failed: 'failed' }[String(action || '')];
  if (!target) return { ok: false, error: 'bad_action', status: 400 };

  let amount = null;
  if (settledAmount !== null && settledAmount !== undefined && settledAmount !== '') {
    const n = Number(settledAmount);
    if (!Number.isFinite(n) || n < 0) return { ok: false, error: 'bad_amount', status: 400 };
    amount = round2(n);
  }

  // Variance is meaningful ONLY for a `settled` outcome that names an amount:
  // a waive settles nothing, a failure records a non-payment, and a settle with
  // no amount is an attestation without a number to check.
  const checkVariance = target === 'settled' && amount !== null;

  const rows = await pgQuery(
    `UPDATE co_order_edit_settlements
        SET status = $2, resolved_by = $3, resolved_at = NOW(), note = $4,
            gateway_payment_id = NULLIF($5, ''), settled_amount = $6,
            variance = ($7 AND ABS(COALESCE($6, amount) - amount) > $8),
            updated_at = NOW()
      WHERE edit_row_id = $1 AND status = 'needs_settlement'
      RETURNING edit_row_id, session_id, version, direction, amount, currency, status, variance`,
    [editRowId, target, String(actor || '').slice(0, 200), String(note || '').slice(0, 1000),
      String(gatewayPaymentId || '').slice(0, 128), amount,
      checkVariance, SETTLEMENT_VARIANCE_TOLERANCE]
  );
  if (!rows.length) {
    const [existing] = await pgQuery(
      `SELECT status FROM co_order_edit_settlements WHERE edit_row_id = $1`, [editRowId]
    );
    if (!existing) return { ok: false, error: 'not_found', status: 404 };
    return { ok: false, error: 'not_open', status: 409, current_status: existing.status };
  }
  const row = rows[0];
  try {
    await pgQuery(
      `INSERT INTO co_events (session_id, kind, data) VALUES ($1, 'order_edit_settlement', $2)`,
      [row.session_id, {
        edit_row_id: row.edit_row_id, version: row.version, direction: row.direction,
        amount: Number(row.amount), status: row.status, variance: row.variance,
        settled_amount: amount, gateway_payment_id: gatewayPaymentId || null,
        by: String(actor || '').slice(0, 200),
      }]
    );
  } catch (err) {
    console.error('[orderEdit] settlement event write failed (non-fatal):', err.message);
  }
  return { ok: true, settlement: { ...row, amount: Number(row.amount), settled_amount: amount, variance: row.variance } };
}

export default {
  ensureOrderEditTables,
  applyEdits,
  subtotalOf,
  recomputeTotals,
  normalizeShippingAddress,
  addressChanged,
  settlementDirection,
  priceAddedLines,
  loadSession,
  currentVersion,
  fulfillmentState,
  readEditState,
  buildPreview,
  commitEdit,
  listSettlements,
  resolveSettlement,
  EDIT_LIMITS,
  EDITABLE_SESSION_STATUSES,
  SETTLEMENT_STATUSES,
  PUSH_STATUSES,
};
