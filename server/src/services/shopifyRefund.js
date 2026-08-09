// Reflect a gateway (Whop) refund INTO the mirrored Shopify order — the missing
// last link that keeps the Orders view honest after a refund.
//
// Why this exists: refunding a checkout returns money at the GATEWAY (Whop
// /payments/{id}/refund). Our Orders section is backed by Shopify (crm_orders is
// fed by the store's orders/* webhooks). A gateway refund never touches Shopify,
// so the mirrored order stays 'paid' and returns_today stays 0 — the money is
// back on the card but the CRM still reads it as a live sale. We close that by
// creating a MANUAL Shopify refund: a refund transaction against the order's
// existing sale transaction, on that transaction's own (manual) gateway, so
// Shopify books the refund for reporting WITHOUT moving money a second time.
// Shopify then flips the order to refunded/partially_refunded and its
// orders/updated webhook carries the state into crm_orders — zero bespoke sync,
// same as order-create.
//
// Money-correctness stance (money already returned before this runs):
//   - Exactly-once: an atomic INSERT…ON CONFLICT DO NOTHING on
//     co_shopify_refunds(session_id, ref) is CLAIMED before the Shopify call, so
//     a redelivered refund webhook can never create a second Shopify refund for
//     the same gateway refund ref.
//   - Fail-CLOSED but NON-FATAL: any Shopify failure (4xx/5xx/timeout/network)
//     never throws into the webhook and never un-refunds. It marks the claim
//     'needs_reconcile' (a human owns the Shopify-side bookkeeping) and returns.
//     We never auto-retry (that risks a double Shopify refund); the row is the
//     audit trail.
//   - Cross-store guard: gated on shopifyOrderCreateEnabled() exactly like
//     create, so a shared-codebase Mineblock deploy can't refund in its store.
import { pgQuery } from '../db/pg.js';
import { ensureCheckoutTables } from './checkoutSchema.js';
import { shopifyOrderCreds, shopifyOrderCreateEnabled } from './shopifyOrderCreate.js';

const REFUND_TIMEOUT_MS = 5_000;
const round2 = (n) => Math.round(Number(n) * 100) / 100;

// Pick the transaction a refund must be booked against: a successful sale or
// capture. Refunding against its parent_id + gateway keeps the refund on the
// SAME (manual) rail the sale used, so Shopify records bookkeeping only.
function pickParentTransaction(transactions) {
  const list = Array.isArray(transactions) ? transactions : [];
  return (
    list.find((t) => ['sale', 'capture'].includes(t?.kind) && t?.status === 'success') || null
  );
}

// Amount to book: the gateway refund amount when known and in-range, else the
// parent transaction's full amount (a full refund). Never more than the parent.
function refundAmountFor(parent, amount) {
  const parentAmt = round2(Number(parent?.amount) || 0);
  const a = amount == null || amount === '' ? null : Number(amount);
  if (a != null && Number.isFinite(a) && a > 0) return Math.min(round2(a), parentAmt);
  return parentAmt;
}

function buildRefundBody(parent, useAmount, ref) {
  return {
    refund: {
      // The money is already back on the card via the gateway; this is a books
      // entry, so no customer email and no inventory restock.
      notify: false,
      // 'puure-reflected' is the LOOP-BREAKER marker: the refunds/create
      // webhook skips refunds carrying it, so a reflection can never trigger
      // an inbound gateway refund of its own.
      note: `Refunded at gateway${ref ? ` (${ref})` : ''} — money already returned; Shopify books-only. [puure-reflected]`,
      transactions: [
        {
          parent_id: parent.id,
          amount: useAmount.toFixed(2),
          kind: 'refund',
          gateway: parent.gateway,
        },
      ],
    },
  };
}

async function shopifyReq(method, path, body) {
  const { store, token, apiVersion, apiBase } = shopifyOrderCreds();
  if (!store || !token) return { ok: false, kind: 'config', detail: 'shopify_not_configured' };
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), REFUND_TIMEOUT_MS);
  if (timer.unref) timer.unref();
  let resp;
  try {
    resp = await fetch(`${apiBase}/admin/api/${apiVersion}/${path}`, {
      method,
      headers: {
        'X-Shopify-Access-Token': token,
        ...(body ? { 'Content-Type': 'application/json' } : {}),
      },
      ...(body ? { body: JSON.stringify(body) } : {}),
      signal: controller.signal,
    });
  } catch (err) {
    const kind = err?.name === 'AbortError' ? 'timeout' : `network:${err?.name || 'Error'}`;
    return { ok: false, kind: 'transport', detail: kind };
  } finally {
    clearTimeout(timer);
  }
  let json = {};
  try { json = await resp.json(); } catch { json = {}; }
  if (!resp.ok) {
    const detail = `http_${resp.status}` + (json?.errors ? ` ${JSON.stringify(json.errors).slice(0, 300)}` : '');
    return { ok: false, kind: resp.status >= 500 ? 'server' : 'client', detail };
  }
  return { ok: true, body: json };
}

async function markClaim(sessionId, ref, patch) {
  const sets = [];
  const params = [sessionId, String(ref)];
  let i = 3;
  for (const [k, v] of Object.entries(patch)) { sets.push(`${k} = $${i}`); params.push(v); i += 1; }
  sets.push('updated_at = NOW()');
  await pgQuery(
    `UPDATE co_shopify_refunds SET ${sets.join(', ')} WHERE session_id = $1 AND ref = $2`,
    params
  );
}

// Reflect one gateway refund into Shopify. Idempotent per (sessionId, ref).
// Returns { ok, skipped?, kind?, refundId?, amount? } and NEVER throws — callers
// on the webhook path treat a failure as best-effort bookkeeping, not money.
export async function reflectRefundToShopify({ sessionId, ref, amount }) {
  try {
    if (!sessionId || !ref) return { ok: false, skipped: 'bad_args' };
    // Cross-store + opt-in guard: same gate the order-create side uses.
    if (!shopifyOrderCreateEnabled()) return { ok: false, skipped: 'disabled' };
    await ensureCheckoutTables();

    // Only orders we actually mirrored into Shopify can be refunded there.
    const [ord] = await pgQuery(
      `SELECT shopify_order_id FROM co_orders
        WHERE session_id = $1 AND shopify_order_id IS NOT NULL
        ORDER BY created_at ASC LIMIT 1`,
      [sessionId]
    );
    if (!ord?.shopify_order_id) return { ok: false, skipped: 'no_shopify_order' };
    const shopifyOrderId = String(ord.shopify_order_id);

    // Atomic exactly-once CLAIM taken before the Shopify call. If the row
    // already exists (redelivery), we do not create a second refund.
    const claim = await pgQuery(
      `INSERT INTO co_shopify_refunds (session_id, ref, shopify_order_id, amount, status)
       VALUES ($1, $2, $3, $4, 'claimed')
       ON CONFLICT (session_id, ref) DO NOTHING
       RETURNING session_id`,
      [sessionId, String(ref), shopifyOrderId, amount == null ? null : round2(Number(amount))]
    );
    if (!claim.length) return { ok: true, skipped: 'already' };

    // Find the sale/capture transaction to refund against.
    const tx = await shopifyReq('GET', `orders/${encodeURIComponent(shopifyOrderId)}/transactions.json`);
    if (!tx.ok) {
      await markClaim(sessionId, ref, { status: 'needs_reconcile', error: `transactions:${tx.kind}:${tx.detail || ''}`.slice(0, 300) });
      return { ok: false, kind: tx.kind };
    }
    const parent = pickParentTransaction(tx.body?.transactions);
    if (!parent) {
      await markClaim(sessionId, ref, { status: 'needs_reconcile', error: 'no_parent_transaction' });
      return { ok: false, kind: 'no_parent_txn' };
    }

    const useAmount = refundAmountFor(parent, amount);
    // LOOP-BREAKER, inbound direction: if Shopify's books already carry refund
    // transactions covering this amount (an operator refunded in the Shopify
    // admin, which is what triggered the gateway refund we are now
    // reflecting), there is nothing to reflect — POSTing again would double
    // the books or be refused. Mark reflected and stop.
    const alreadyRefunded = (tx.body?.transactions || [])
      .filter((t) => t?.kind === 'refund' && t?.status === 'success')
      .reduce((s2, t) => s2 + (Number(t.amount) || 0), 0);
    if (alreadyRefunded + 0.01 >= useAmount) {
      await markClaim(sessionId, ref, { status: 'reflected', error: 'already_refunded_in_shopify' });
      return { ok: true, external: true };
    }
    const r = await shopifyReq('POST', `orders/${encodeURIComponent(shopifyOrderId)}/refunds.json`, buildRefundBody(parent, useAmount, ref));
    if (!r.ok) {
      await markClaim(sessionId, ref, { status: 'needs_reconcile', error: `refund:${r.kind}:${r.detail || ''}`.slice(0, 300) });
      return { ok: false, kind: r.kind, detail: r.detail };
    }

    const refundId = String(r.body?.refund?.id || '');
    await markClaim(sessionId, ref, { status: 'reflected', shopify_refund_id: refundId, amount: useAmount, error: null });
    return { ok: true, refundId, amount: useAmount };
  } catch (err) {
    // NEVER throw into the webhook path. Best-effort bookkeeping only.
    try { await markClaim(sessionId, ref, { status: 'needs_reconcile', error: `exception:${err.message}`.slice(0, 300) }); } catch { /* noop */ }
    return { ok: false, kind: 'exception', detail: err.message };
  }
}

/**
 * INBOUND direction — a refund created IN SHOPIFY (admin UI / app) triggers
 * the REAL gateway refund, so staff can refund from either surface.
 * Wired from the refunds/create webhook. Exactly-once via the same
 * co_shopify_refunds claim table (ref = 'shp:<refund_id>'); refunds carrying
 * the reflection marker are OUR OWN books-entries and are skipped (loop
 * breaker); Whop-side idempotency (deterministic Idempotency-Key in
 * refundPayment) is the final double-money backstop. NEVER throws.
 *
 * @param {object} refund — the refunds/create webhook payload.
 * @param {object} [deps] — { query, refundFn, resolveCred } injectable.
 * @returns {Promise<{ok:boolean, skipped?:string, kind?:string}>}
 */
export async function handleInboundShopifyRefund(refund, deps = {}) {
  const query = deps.query || pgQuery;
  try {
    const refundId = String(refund?.id || '');
    const orderId = String(refund?.order_id || '');
    if (!refundId || !orderId) return { ok: false, skipped: 'bad_payload' };
    if (String(refund?.note || '').includes('[puure-reflected]')) {
      return { ok: true, skipped: 'own_reflection' };
    }
    await ensureCheckoutTables();

    // Only orders WE mirrored have a session behind them.
    const [ord] = await query(
      `SELECT session_id FROM co_orders WHERE shopify_order_id = $1 LIMIT 1`,
      [orderId]
    );
    if (!ord?.session_id) return { ok: true, skipped: 'not_a_checkout_order' };
    const [session] = await query(
      `SELECT id, funnel_id, status, gateway, gateway_session_id, total, refunds
       FROM co_sessions WHERE id = $1`,
      [ord.session_id]
    );
    if (!session) return { ok: false, skipped: 'session_missing' };
    if (String(session.gateway || '').toLowerCase() !== 'whop' || !session.gateway_session_id) {
      return { ok: true, skipped: 'not_whop' };
    }

    // Amount = the refund's own money transactions (partials supported);
    // refund_line_items subtotal is the fallback for zero-transaction edits.
    let amount = (Array.isArray(refund.transactions) ? refund.transactions : [])
      .filter((t) => t?.kind === 'refund')
      .reduce((s2, t) => s2 + (Number(t.amount) || 0), 0);
    if (!(amount > 0)) {
      amount = (Array.isArray(refund.refund_line_items) ? refund.refund_line_items : [])
        .reduce((s2, li) => s2 + (Number(li.subtotal) || 0), 0);
    }
    amount = round2(amount);
    if (!(amount > 0)) return { ok: true, skipped: 'no_money_in_refund' };

    // Exactly-once claim BEFORE any gateway call.
    const claim = await query(
      `INSERT INTO co_shopify_refunds (session_id, ref, shopify_order_id, amount, status)
       VALUES ($1, $2, $3, $4, 'inbound_claimed')
       ON CONFLICT (session_id, ref) DO NOTHING
       RETURNING session_id`,
      [session.id, `shp:${refundId}`, orderId, amount]
    );
    if (!claim.length) return { ok: true, skipped: 'already_handled' };

    // Skip when the gateway side is already covered (session ledger).
    const priorRefunded = (Array.isArray(session.refunds) ? session.refunds : [])
      .reduce((s2, r) => s2 + (Number(r?.amount) || 0), 0);
    if (session.status === 'refunded' || priorRefunded + 0.01 >= Number(session.total)) {
      await query(
        `UPDATE co_shopify_refunds SET status = 'inbound_already_refunded', updated_at = NOW()
         WHERE session_id = $1 AND ref = $2`, [session.id, `shp:${refundId}`]
      );
      return { ok: true, skipped: 'gateway_already_refunded' };
    }

    const resolveCred = deps.resolveCred
      || (await import('./gatewayConfigs.js')).resolveCredential;
    const refundFn = deps.refundFn
      || (await import('./gateways/whop.js')).refundPayment;
    const apiKey = await resolveCred(session.funnel_id || '', 'whop', 'api_key');
    const isFull = Math.abs(amount - Number(session.total)) <= 0.01;
    const r = await refundFn({ api_key: apiKey }, {
      paymentId: session.gateway_session_id,
      amount: isFull ? null : amount,
    });
    if (!r.ok) {
      await query(
        `UPDATE co_shopify_refunds SET status = $3, updated_at = NOW()
         WHERE session_id = $1 AND ref = $2`,
        [session.id, `shp:${refundId}`, `inbound_failed:${String(r.error || '').slice(0, 80)}`]
      );
      await query(
        `UPDATE co_sessions SET needs_review_reason = $2, updated_at = NOW()
         WHERE id = $1 AND needs_review_reason IS NULL`,
        [session.id, `shopify_refund_gateway_failed:${refundId}`.slice(0, 300)]
      );
      return { ok: false, kind: 'gateway_refund_failed' };
    }
    await query(
      `UPDATE co_shopify_refunds SET status = 'inbound_gateway_refunded', updated_at = NOW()
       WHERE session_id = $1 AND ref = $2`, [session.id, `shp:${refundId}`]
    );
    // The Whop refund webhook now does the ledger work (applyRefund flips the
    // session; the reflection sees Shopify already refunded and no-ops).
    return { ok: true, refunded: amount };
  } catch (err) {
    console.error('[shopifyRefund] inbound handler failed (non-fatal):', err.message);
    return { ok: false, kind: 'exception' };
  }
}

// Exposed for the harness (pure helpers).
export const _internals = { pickParentTransaction, refundAmountFor, buildRefundBody };
