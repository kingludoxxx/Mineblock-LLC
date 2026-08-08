// Settlement — the ONLY code path that moves a session to paid and writes a
// co_orders row. The gateway webhooks are the PRIMARY settlers; the
// reconciliation sweep MUST call these same functions (never re-implemented
// arithmetic) so a sweep-settled session is byte-identical to a
// webhook-settled one.
//
// Money is idempotent BY CONSTRUCTION (DECISIONS rule 3):
//   - the session flip is an atomic status claim (WHERE status = 'processing')
//   - the order write rides co_orders.idempotency_key UNIQUE
//     (ON CONFLICT DO NOTHING)
// Webhook, sweep and operator retry can all race; the database arbitrates.
// A replayed settle is a no-op on both writes.
import crypto from 'crypto';
import { pgQuery } from '../db/pg.js';
import { ensureCheckoutTables } from './checkoutSchema.js';
import { REUSABLE_PM_TYPES } from './gateways/stripe.js';

const round2 = (n) => Math.round(Number(n) * 100) / 100;

/**
 * Settle a session as paid and write its order, exactly once.
 *
 * @param {object} p
 * @param {string} p.sessionId       co_sessions.id
 * @param {string} p.gateway         'stripe' | 'whop'
 * @param {string} p.gatewayId       gateway charge/intent id (pi_… / ch_…)
 * @param {string} p.idempotencyKey  deterministic order key, e.g. `st_<pi_id>`
 * @param {number} p.amount          amount the gateway reports as CAPTURED
 * @param {string} p.currency
 * @param {string} [p.paymentMethodId]  saved PM for 1-click upsells
 * @param {string} [p.paymentMethodType] actual method used ('card', 'link',
 *   'afterpay_clearpay', …) — non-reusable types are NOT saved (reuse gate)
 * @param {string} [p.customerId]    gateway customer id
 * @param {string} [p.payerEmail]    backfills a missing session email
 * @returns {{ok: boolean, error?: string, settled?: boolean, already?: boolean,
 *            orderId?: string}}
 *   settled=true  → this call performed the flip
 *   already=true  → session was already paid (replay/duplicate) — no-op
 */
export async function settleSessionPaid({
  sessionId, gateway, gatewayId, idempotencyKey, amount, currency,
  paymentMethodId = '', paymentMethodType = '', customerId = '', payerEmail = '',
}) {
  await ensureCheckoutTables();
  const rows = await pgQuery(`SELECT * FROM co_sessions WHERE id = $1`, [sessionId]);
  if (!rows.length) return { ok: false, error: 'session_not_found' };
  const session = rows[0];

  // Amount authority: what the gateway captured must equal the session
  // snapshot. A mismatch parks the session for a human (fail-closed) — never
  // book money at a number the cart didn't say.
  const expected = round2(session.total);
  if (Math.abs(round2(amount) - expected) > 0.01) {
    await pgQuery(
      `UPDATE co_sessions
       SET needs_review_reason = $2, updated_at = NOW()
       WHERE id = $1 AND needs_review_reason IS NULL`,
      [sessionId, `amount_mismatch: gateway=${round2(amount)} expected=${expected}`]
    );
    return { ok: false, error: 'amount_mismatch' };
  }

  // REUSE GATE: only a genuinely reusable credential is saved for upsells.
  // An empty type (legacy/unexpanded charge) fails open to saving, matching
  // the reference behavior for plain card funnels.
  const reusablePm =
    !paymentMethodType || REUSABLE_PM_TYPES.has(paymentMethodType.toLowerCase())
      ? paymentMethodId || null
      : null;

  // Atomic status claim — the flip happens at most once, ever.
  const flipped = await pgQuery(
    `UPDATE co_sessions SET
       status = 'paid',
       gateway = $2,
       gateway_session_id = $3,
       payment_method_id = $4,
       payment_method_type = $5,
       gateway_customer_id = COALESCE($6, gateway_customer_id),
       customer = CASE
         WHEN COALESCE(customer->>'email', '') = '' AND $7 <> ''
         THEN customer || jsonb_build_object('email', $7::text)
         ELSE customer
       END,
       paid_at = NOW(),
       updated_at = NOW()
     WHERE id = $1 AND status = 'processing'
     RETURNING id`,
    [sessionId, gateway, gatewayId, reusablePm, paymentMethodType || null,
      customerId || null, payerEmail || '']
  );

  if (!flipped.length && session.status === 'paid') {
    // Redelivery: already settled. The order write below still runs (it is
    // idempotent) so a crash between flip and order write self-heals on the
    // gateway's retry.
  } else if (!flipped.length) {
    // Session in a state we must not silently settle (failed/refunded/…).
    return { ok: false, error: `unsettleable_status:${session.status}` };
  }

  // Exactly-once order write: the unique index arbitrates, not a read.
  const orderId = `ord_${crypto.randomBytes(12).toString('hex')}`;
  const inserted = await pgQuery(
    `INSERT INTO co_orders (id, session_id, idempotency_key, gateway, line_items, total, currency)
     VALUES ($1, $2, $3, $4, $5, $6, $7)
     ON CONFLICT (idempotency_key) DO NOTHING
     RETURNING id`,
    [orderId, sessionId, idempotencyKey, gateway,
      Array.isArray(session.line_items) ? session.line_items : [],
      expected, currency || session.currency]
  );

  // Event trail — analytics side, non-fatal, duplicates fine.
  if (flipped.length) {
    try {
      await pgQuery(
        `INSERT INTO co_events (session_id, kind, data) VALUES ($1, 'paid', $2)`,
        [sessionId, { gateway, gateway_id: gatewayId, amount: expected, currency }]
      );
    } catch (err) {
      console.error('[settle] co_events write failed (non-fatal):', err.message);
    }
  }

  return {
    ok: true,
    settled: Boolean(flipped.length),
    already: !flipped.length,
    orderId: inserted.length ? orderId : null,
  };
}

/**
 * Settle an upsell charge that a gateway accepted asynchronously
 * (pending_settlement) or synchronously (charging). Atomic claim: only a
 * non-terminal row flips to settled, so a replayed payment.succeeded is a
 * no-op and a decline marker (status 'declined', declined_by_user) can never
 * be settled. Amount authority: the gateway-reported amount must match the
 * claimed row within a cent, else the row parks at needs_review.
 */
export async function settleUpsellCharge({ chargeRowId, gatewayPaymentId, amount = null }) {
  await ensureCheckoutTables();
  const rows = await pgQuery(`SELECT * FROM co_upsell_charges WHERE id = $1`, [chargeRowId]);
  if (!rows.length) return { ok: false, error: 'charge_not_found' };
  const row = rows[0];
  if (row.status === 'settled') return { ok: true, already: true };
  if (amount !== null && Math.abs(round2(amount) - round2(row.amount)) > 0.01) {
    await pgQuery(
      `UPDATE co_upsell_charges SET status = 'needs_review', error = $2, updated_at = NOW()
       WHERE id = $1 AND status IN ('charging', 'pending_settlement')`,
      [chargeRowId, `amount_mismatch: gateway=${round2(amount)} expected=${round2(row.amount)}`]
    );
    return { ok: false, error: 'amount_mismatch' };
  }
  const flipped = await pgQuery(
    `UPDATE co_upsell_charges
     SET status = 'settled',
         gateway_payment_id = COALESCE($2, gateway_payment_id),
         error = NULL, updated_at = NOW()
     WHERE id = $1 AND status IN ('charging', 'pending_settlement')
     RETURNING id, session_id, offer_id, amount, currency`,
    [chargeRowId, gatewayPaymentId || null]
  );
  if (!flipped.length) return { ok: false, error: `unsettleable_status:${row.status}` };
  try {
    await pgQuery(
      `INSERT INTO co_events (session_id, kind, data) VALUES ($1, 'upsell_settled', $2)`,
      [row.session_id, {
        offer_id: row.offer_id, charge_row: chargeRowId,
        gateway_payment_id: gatewayPaymentId || row.gateway_payment_id,
        amount: Number(row.amount), currency: row.currency,
      }]
    );
  } catch (err) {
    console.error('[settle] upsell event write failed (non-fatal):', err.message);
  }
  return { ok: true, settled: true };
}

// Terminal failure for a non-terminal upsell charge (async decline via
// payment.failed, or sweep-discovered). Never touches settled rows.
export async function failUpsellCharge({ chargeRowId, reason }) {
  await ensureCheckoutTables();
  const flipped = await pgQuery(
    `UPDATE co_upsell_charges
     SET status = 'declined', error = $2, updated_at = NOW()
     WHERE id = $1 AND status IN ('charging', 'pending_settlement')
     RETURNING id, session_id, offer_id`,
    [chargeRowId, String(reason || 'declined').slice(0, 200)]
  );
  if (!flipped.length) return { ok: false, error: 'not_failable' };
  try {
    await pgQuery(
      `INSERT INTO co_events (session_id, kind, data) VALUES ($1, 'upsell_declined', $2)`,
      [flipped[0].session_id, { offer_id: flipped[0].offer_id, charge_row: chargeRowId, reason }]
    );
  } catch { /* non-fatal */ }
  return { ok: true };
}
