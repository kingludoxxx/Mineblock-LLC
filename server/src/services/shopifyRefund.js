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
      note: `Refunded at gateway${ref ? ` (${ref})` : ''} — money already returned; Shopify books-only.`,
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

// Exposed for the harness (pure helpers).
export const _internals = { pickParentTransaction, refundAmountFor, buildRefundBody };
