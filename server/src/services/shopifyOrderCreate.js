// Shopify order mirror — the last link in the money path. When a BASE checkout
// session settles paid (settleSessionPaid has already claimed/created the
// co_orders row), this pushes a REAL, PAID order into the Puure Shopify store.
// That order then fires the store's already-live orders/create webhook, which
// ingests it into shopify_orders_cache — so a paid funnel checkout appears both
// in Shopify AND in our Orders section, with zero bespoke sync.
//
// Money-correctness stance (the card is ALREADY charged before this runs):
//   - Exactly-once: the created Shopify order id is stored on co_orders and the
//     creation is claimed with an atomic UPDATE (…WHERE shopify_order_id IS NULL
//     …RETURNING). Of N concurrent settlers exactly one wins the row lock and
//     calls Shopify; a redelivery finds the id already set and no-ops.
//   - Fail-CLOSED but NON-FATAL: a Shopify failure (4xx/5xx/timeout/network)
//     never throws into the webhook and never un-charges. It parks the order
//     and session at needs_review (money moved, order owed → a human) and
//     returns cleanly. We NEVER auto-retry a failed create (that risks a
//     duplicate store order for one payment); the sweep/webhook redelivery will
//     see 'needs_review' and leave it alone.
//   - Input validation (empty line_items, missing variant_id, missing email,
//     currency mismatch) parks needs_review rather than crashing.
//
// Credentials + store are read at CALL time (never module-cached, matching the
// rest of the money path) and resolve to the SAME store checkoutPricing.js
// priced against, so the numeric variant ids are valid there.
import { pgQuery } from '../db/pg.js';
import { ensureCheckoutTables } from './checkoutSchema.js';

// Bounded so the webhook ACK stays inside EVERY gateway's budget: this create
// is awaited on the settle path, on top of the authoritative PI re-fetch (20s).
// At 15s a slow Shopify pushed the ACK past Stripe's ~20s window, the gateway
// redelivered, and each redelivery re-entered the same slow path — an
// amplification loop under exactly the condition that caused it. A create that
// outruns this parks needs_review and the sweep drains it (see backfill).
const CREATE_TIMEOUT_MS = 5_000;
// A 'creating' claim older than this is treated as a died-mid-flight attempt
// and may be reclaimed. It MUST exceed CREATE_TIMEOUT_MS so a merely-slow
// in-flight create is never double-fired by a concurrent settler.
const STALE_CLAIM_MS = 3 * 60 * 1000;

function round2(n) { return Math.round(Number(n) * 100) / 100; }

// Same resolution as checkoutPricing.js's shopifyCreds() so the order is
// created on the exact store the cart was priced against. SHOPIFY_API_BASE is
// the test seam (default https://{store}), mirroring STRIPE_API_BASE/
// WHOP_API_BASE — unset = real Shopify.
export function shopifyOrderCreds() {
  const store = process.env.PUURE_SHOPIFY_STORE || process.env.SHOPIFY_STORE_DOMAIN || '';
  return {
    store,
    token: process.env.PUURE_SHOPIFY_TOKEN || process.env.SHOPIFY_ACCESS_TOKEN || '',
    apiVersion: process.env.SHOPIFY_API_VERSION || '2024-01',
    apiBase: process.env.SHOPIFY_API_BASE || (store ? `https://${store}` : ''),
  };
}

// The feature is active only on an EXPLICIT opt-in — SHOPIFY_ORDER_CREATE_
// ENABLED=1 — AND with the store configured AND the kill switch off. The
// explicit opt-in is a hard cross-store guard: a shared-codebase deploy on the
// Mineblock service can never create orders in the Mineblock store by accident
// (it simply won't set the flag). SHOPIFY_ORDER_CREATE_DISABLED=1 still turns it
// off without a deploy even where the flag is set.
export function shopifyOrderCreateEnabled() {
  if (process.env.SHOPIFY_ORDER_CREATE_DISABLED === '1') return false;
  if (process.env.SHOPIFY_ORDER_CREATE_ENABLED !== '1') return false;
  const { store, token } = shopifyOrderCreds();
  return Boolean(store && token);
}

// Shopify numeric ids arrive as numbers or gid strings; orders.json wants the
// bare numeric variant id. Returns '' when it can't be reduced to digits.
function numericVariantId(raw) {
  const v = String(raw == null ? '' : raw).trim();
  if (/^\d+$/.test(v)) return v;
  const m = v.match(/ProductVariant\/(\d+)/);
  return m ? m[1] : '';
}

// Build the Shopify REST orders.json payload from the session snapshot. Returns
// { order } on success or { error } when the snapshot can't make a valid order.
// Address fields are passed as plain JSON values (Shopify escapes them); there
// is no SQL/HTML interpolation here, so hostile address strings are inert data.
function buildOrderPayload(session, order, { idempotencyKey }) {
  const lines = Array.isArray(session.line_items) ? session.line_items : [];
  if (!lines.length) return { error: 'empty_line_items' };

  // Each line carries its SERVER-priced unit price (session.line_items[].price)
  // so Shopify prices the line at the funnel price we charged, NOT the current
  // live variant price. Without this, a funnel price ≠ live variant price makes
  // Shopify compute a different total_price and mark the order partially_paid /
  // over-paid, misstating revenue in shopify_orders_cache. variant_id is the
  // numeric STRING (never Number()) so a 16+-digit id can't lose precision.
  const lineItems = [];
  let lineSubtotal = 0;
  for (const li of lines) {
    const variantId = numericVariantId(li?.variant_id);
    if (!variantId) return { error: 'missing_variant_id' };
    const quantity = Math.max(1, parseInt(li?.quantity, 10) || 0);
    if (!quantity) return { error: 'bad_quantity' };
    // Server-priced unit price only — never a client value. Fall back to
    // line_total/qty when a snapshot predates the price field.
    let unit = Number(li?.price);
    if (!Number.isFinite(unit) || unit < 0) {
      const lt = Number(li?.line_total);
      unit = Number.isFinite(lt) && lt >= 0 ? lt / quantity : NaN;
    }
    if (!Number.isFinite(unit) || unit < 0) return { error: 'missing_line_price' };
    unit = round2(unit);
    lineSubtotal = round2(lineSubtotal + unit * quantity);
    lineItems.push({ variant_id: variantId, quantity, price: unit.toFixed(2) });
  }

  const customer = (session.customer && typeof session.customer === 'object') ? session.customer : {};
  const email = String(customer.email || '').trim();
  if (!email) return { error: 'missing_email' };

  const currency = String(session.currency || order.currency || '').toUpperCase();
  const orderCurrency = String(order.currency || session.currency || '').toUpperCase();
  if (currency && orderCurrency && currency !== orderCurrency) {
    return { error: `currency_mismatch:${currency}!=${orderCurrency}` };
  }
  if (!currency) return { error: 'missing_currency' };

  const total = round2(order.total ?? session.total);
  const shipAmt = round2(session.shipping || 0);
  const taxAmt = round2(session.tax || 0);
  // The line-derived total MUST equal the amount we book as paid, else Shopify
  // resolves the order to partially_paid/over-paid. Reconcile the snapshot's
  // components against the authoritative charged total and fail CLOSED (park
  // needs_review) on any drift rather than post a mispriced order.
  const composedTotal = round2(lineSubtotal + shipAmt + taxAmt);
  if (Math.abs(composedTotal - total) > 0.01) {
    return { error: `total_composition_mismatch:lines+ship+tax=${composedTotal}!=charged=${total}` };
  }
  const gatewayRef = String(session.gateway_session_id || '').slice(0, 120);
  const gatewayName = String(session.gateway || order.gateway || 'puure');

  const sh = (customer.shipping && typeof customer.shipping === 'object') ? customer.shipping : {};
  const shippingAddress = {
    first_name: String(customer.first_name || '').slice(0, 100),
    last_name: String(customer.last_name || '').slice(0, 100),
    address1: String(sh.address1 || '').slice(0, 255),
    address2: String(sh.address2 || '').slice(0, 255),
    city: String(sh.city || '').slice(0, 100),
    province: String(sh.state || '').slice(0, 100),
    zip: String(sh.zip || '').slice(0, 20),
    country: String(sh.country || '').slice(0, 60),
    phone: String(customer.phone || '').slice(0, 40),
  };
  const hasAddress = Boolean(shippingAddress.address1 || shippingAddress.city || shippingAddress.zip);

  const orderPayload = {
    email,
    // financial_status alone is advisory on create; a manual 'sale' transaction
    // is what actually books the order as PAID in Shopify.
    financial_status: 'paid',
    currency,
    line_items: lineItems,
    // Shipping/tax carried as explicit lines so Shopify's computed total_price
    // == the charged transaction amount (fully paid), not partially_paid.
    ...(shipAmt > 0 ? { shipping_lines: [{ title: 'Shipping', price: shipAmt.toFixed(2), code: 'puure-checkout' }] } : {}),
    ...(taxAmt > 0 ? { tax_lines: [{ title: 'Tax', price: taxAmt.toFixed(2), rate: 0 }], total_tax: taxAmt.toFixed(2) } : {}),
    transactions: [{
      kind: 'sale',
      status: 'success',
      amount: total.toFixed(2),
      currency,
      gateway: gatewayName,
    }],
    // Do NOT email the buyer while this is being smoke-tested in production.
    send_receipt: false,
    send_fulfillment_receipt: false,
    inventory_behaviour: 'bypass',
    source_name: 'puure-checkout',
    tags: 'puure-checkout',
    note: `Puure checkout · ${gatewayName}${gatewayRef ? ` ${gatewayRef}` : ''}`,
    note_attributes: [
      { name: 'co_session_id', value: String(session.id).slice(0, 120) },
      { name: 'co_order_idempotency_key', value: String(idempotencyKey).slice(0, 120) },
      { name: 'gateway', value: gatewayName },
      { name: 'gateway_payment_id', value: gatewayRef },
    ],
  };
  if (customer.first_name || customer.last_name) {
    orderPayload.customer = {
      email,
      first_name: shippingAddress.first_name,
      last_name: shippingAddress.last_name,
    };
  }
  if (hasAddress) orderPayload.shipping_address = shippingAddress;

  return { order: orderPayload };
}

// POST the order to Shopify REST. Returns a discriminated result:
//   { ok:true, id, number }                → created (definitive success)
//   { ok:false, kind:'client', detail }    → 4xx (definitively NOT created)
//   { ok:false, kind:'server', detail }    → 5xx (ambiguous — may exist)
//   { ok:false, kind:'transport', detail } → timeout/network (ambiguous)
async function postShopifyOrder(order) {
  const { store, token, apiVersion, apiBase } = shopifyOrderCreds();
  if (!store || !token) return { ok: false, kind: 'config', detail: 'shopify_not_configured' };

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), CREATE_TIMEOUT_MS);
  if (timer.unref) timer.unref();
  let resp;
  try {
    resp = await fetch(`${apiBase}/admin/api/${apiVersion}/orders.json`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-Shopify-Access-Token': token,
      },
      body: JSON.stringify({ order }),
      signal: controller.signal,
    });
  } catch (err) {
    // Transport failure: the request may or may not have reached Shopify, so a
    // caller must treat it as AMBIGUOUS, never a clean "not created".
    const kind = err?.name === 'AbortError' ? 'timeout' : `network:${err?.name || 'Error'}`;
    return { ok: false, kind: 'transport', detail: kind };
  } finally {
    clearTimeout(timer);
  }

  let body = {};
  try { body = await resp.json(); } catch { body = {}; }
  if (resp.ok && body?.order?.id) {
    return { ok: true, id: String(body.order.id), number: String(body.order.order_number ?? body.order.number ?? '') };
  }
  const detail = `http_${resp.status}` + (body?.errors ? ` ${JSON.stringify(body.errors).slice(0, 300)}` : '');
  return { ok: false, kind: resp.status >= 500 ? 'server' : 'client', detail };
}

// Reclaim-only dedup: look for an order this system already created for this
// idempotency key, keyed on the note_attribute we stamp on every order. Closes
// the SIGKILL-between-201-and-id-write window — a stale-claim reclaim must never
// POST a second PAID order for a payment whose order already exists at Shopify.
// Returns { ok, id, number } on a confident find, { ok:false } otherwise. On any
// lookup failure returns notFound WITHOUT error so the caller can decide (a
// reclaim then fails CLOSED to needs_review rather than risk a duplicate).
async function findExistingShopifyOrder(idempotencyKey) {
  const { store, token, apiVersion, apiBase } = shopifyOrderCreds();
  if (!store || !token) return { ok: false, kind: 'config' };
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), CREATE_TIMEOUT_MS);
  if (timer.unref) timer.unref();
  let resp;
  try {
    // status=any so an archived/closed order still matches; recent window is
    // enough (a reclaim is minutes after the lost write). tags filter narrows
    // to our own orders; note_attributes is matched exactly below.
    const url = `${apiBase}/admin/api/${apiVersion}/orders.json`
      + `?status=any&limit=250&order=created_at+desc`
      + `&fields=id,order_number,note_attributes,tags`;
    resp = await fetch(url, {
      method: 'GET',
      headers: { 'X-Shopify-Access-Token': token },
      signal: controller.signal,
    });
  } catch (err) {
    return { ok: false, kind: 'transport', detail: err?.name === 'AbortError' ? 'timeout' : `network:${err?.name || 'Error'}` };
  } finally {
    clearTimeout(timer);
  }
  if (!resp.ok) return { ok: false, kind: resp.status >= 500 ? 'server' : 'client', detail: `http_${resp.status}` };
  let body = {};
  try { body = await resp.json(); } catch { return { ok: false, kind: 'bad_json' }; }
  const want = String(idempotencyKey);
  for (const o of Array.isArray(body?.orders) ? body.orders : []) {
    const attrs = Array.isArray(o?.note_attributes) ? o.note_attributes : [];
    if (attrs.some((a) => a?.name === 'co_order_idempotency_key' && String(a?.value) === want)) {
      return { ok: true, id: String(o.id), number: String(o.order_number ?? '') };
    }
  }
  return { ok: false, kind: 'not_found' };
}

async function parkNeedsReview({ idempotencyKey, sessionId, reason }) {
  const safe = String(reason || 'shopify_create_failed').slice(0, 300);
  try {
    // Only park a row that has NOT been created — never overwrite a success.
    await pgQuery(
      `UPDATE co_orders
         SET shopify_status = 'needs_review', shopify_error = $2, shopify_claimed_at = NULL
       WHERE idempotency_key = $1 AND shopify_order_id IS NULL`,
      [idempotencyKey, safe]
    );
  } catch (err) {
    console.error('[shopify-order] park co_orders failed (non-fatal):', err.message);
  }
  try {
    await pgQuery(
      `UPDATE co_sessions
         SET needs_review_reason = $2, updated_at = NOW()
       WHERE id = $1 AND needs_review_reason IS NULL`,
      [sessionId, `shopify_order_create:${safe}`.slice(0, 300)]
    );
  } catch (err) {
    console.error('[shopify-order] park co_sessions failed (non-fatal):', err.message);
  }
  try {
    await pgQuery(
      `INSERT INTO co_events (session_id, kind, data) VALUES ($1, 'shopify_order_needs_review', $2)`,
      [sessionId, { idempotency_key: idempotencyKey, reason: safe }]
    );
  } catch { /* non-fatal */ }
}

/**
 * Create the Shopify order for a settled BASE session, exactly once.
 *
 * Call AFTER settleSessionPaid has claimed/created the co_orders row. Safe to
 * call on every settle (including redeliveries and the sweep backfill): it
 * no-ops when the order already exists, is in flight, or has been parked for a
 * human. NEVER throws — a failure is recorded and surfaced, never propagated
 * into the (already-charged) webhook.
 *
 * @param {object} p
 * @param {string} p.sessionId       co_sessions.id
 * @param {string} p.idempotencyKey  co_orders.idempotency_key (the settle key)
 * @returns {Promise<{ok:boolean, created?:boolean, adopted?:boolean,
 *   already?:boolean, skipped?:string, needsReview?:boolean,
 *   shopifyOrderId?:string, error?:string}>}
 *   adopted=true → a reclaim found an already-created order and took its id
 *   (no new POST) instead of creating a duplicate.
 */
export async function createShopifyOrderForSession({ sessionId, idempotencyKey }) {
  try {
    if (!sessionId || !idempotencyKey) return { ok: false, error: 'missing_args' };
    if (!shopifyOrderCreateEnabled()) return { ok: true, skipped: 'disabled_or_unconfigured' };
    await ensureCheckoutTables();

    // Atomic claim, split into FRESH (never attempted) and RECLAIM (a prior
    // 'creating' that died before resolving). Of N concurrent callers exactly
    // one flips the row (Postgres row lock serializes; losers re-check the
    // predicate against the freshly-updated row and match zero rows). Splitting
    // lets the reclaim path run a dedup lookup BEFORE re-POSTing — 'needs_review'
    // and an already-set shopify_order_id are NEVER claimed by either.
    let claim = await pgQuery(
      `UPDATE co_orders
         SET shopify_status = 'creating', shopify_claimed_at = NOW()
       WHERE idempotency_key = $1
         AND shopify_order_id IS NULL
         AND shopify_status IS NULL
       RETURNING id, session_id`,
      [idempotencyKey]
    );
    let isReclaim = false;
    if (!claim.length) {
      claim = await pgQuery(
        `UPDATE co_orders
           SET shopify_status = 'creating', shopify_claimed_at = NOW()
         WHERE idempotency_key = $1
           AND shopify_order_id IS NULL
           AND shopify_status = 'creating'
           AND shopify_claimed_at IS NOT NULL
           AND shopify_claimed_at < NOW() - ($2::int * INTERVAL '1 millisecond')
         RETURNING id, session_id`,
        [idempotencyKey, STALE_CLAIM_MS]
      );
      isReclaim = claim.length > 0;
    }

    if (!claim.length) {
      // Either no co_orders row yet (shouldn't happen post-settle), or the
      // order is already created / in flight / parked — all no-ops here.
      const [existing] = await pgQuery(
        `SELECT shopify_order_id, shopify_status FROM co_orders WHERE idempotency_key = $1`,
        [idempotencyKey]
      );
      if (!existing) return { ok: false, error: 'order_row_missing' };
      if (existing.shopify_order_id) {
        return { ok: true, already: true, shopifyOrderId: existing.shopify_order_id };
      }
      return { ok: true, skipped: existing.shopify_status || 'in_flight' };
    }

    const claimedSessionId = claim[0].session_id || sessionId;

    // RECLAIM dedup: a stale 'creating' means a prior attempt died. If it died
    // in the window AFTER Shopify returned 201 but BEFORE our id write, the
    // PAID order already exists at Shopify — re-POSTing would duplicate it. Ask
    // Shopify (by our stamped idempotency-key note_attribute) and ADOPT the id
    // instead of creating. Fail CLOSED: if the lookup can't confirm absence
    // (transport/HTTP error), park needs_review rather than risk a duplicate.
    if (isReclaim) {
      const found = await findExistingShopifyOrder(idempotencyKey);
      if (found.ok) {
        const saved = await pgQuery(
          `UPDATE co_orders
             SET shopify_order_id = $2, shopify_order_number = $3, external_order_id = $2,
                 shopify_status = 'created', shopify_error = NULL, shopify_created_at = NOW()
           WHERE idempotency_key = $1 AND shopify_order_id IS NULL
           RETURNING id`,
          [idempotencyKey, found.id, found.number || null]
        );
        try {
          await pgQuery(
            `INSERT INTO co_events (session_id, kind, data) VALUES ($1, 'shopify_order_adopted', $2)`,
            [claimedSessionId, { idempotency_key: idempotencyKey, shopify_order_id: found.id }]
          );
        } catch { /* non-fatal */ }
        return { ok: true, adopted: true, created: false, already: !saved.length, shopifyOrderId: found.id };
      }
      if (found.kind !== 'not_found') {
        // Ambiguous — could not prove the order is absent. Do NOT create.
        await parkNeedsReview({
          idempotencyKey, sessionId: claimedSessionId,
          reason: `reclaim_lookup_${found.kind}:${found.detail || ''}`,
        });
        return { ok: false, needsReview: true, error: `reclaim_lookup_${found.kind}` };
      }
      // found.kind === 'not_found' → order truly absent, safe to create below.
    }
    const [session] = await pgQuery(`SELECT * FROM co_sessions WHERE id = $1`, [claimedSessionId]);
    const [order] = await pgQuery(
      `SELECT total, currency, gateway FROM co_orders WHERE idempotency_key = $1`,
      [idempotencyKey]
    );
    if (!session) {
      await parkNeedsReview({ idempotencyKey, sessionId: claimedSessionId, reason: 'session_not_found' });
      return { ok: false, needsReview: true, error: 'session_not_found' };
    }

    const built = buildOrderPayload(session, order || {}, { idempotencyKey });
    if (built.error) {
      // Bad snapshot — a human must complete this order by hand. Fail closed.
      await parkNeedsReview({ idempotencyKey, sessionId: claimedSessionId, reason: built.error });
      return { ok: false, needsReview: true, error: built.error };
    }

    const created = await postShopifyOrder(built.order);
    if (created.ok) {
      // Store the id under the SAME IS NULL guard the claim used, so even a
      // freak double-winner can only ever persist ONE id (first write wins).
      const saved = await pgQuery(
        `UPDATE co_orders
           SET shopify_order_id = $2, shopify_order_number = $3, external_order_id = $2,
               shopify_status = 'created', shopify_error = NULL, shopify_created_at = NOW()
         WHERE idempotency_key = $1 AND shopify_order_id IS NULL
         RETURNING id`,
        [idempotencyKey, created.id, created.number || null]
      );
      try {
        await pgQuery(
          `INSERT INTO co_events (session_id, kind, data) VALUES ($1, 'shopify_order_created', $2)`,
          [claimedSessionId, { idempotency_key: idempotencyKey, shopify_order_id: created.id, shopify_order_number: created.number }]
        );
      } catch { /* non-fatal */ }
      return { ok: true, created: Boolean(saved.length), already: !saved.length, shopifyOrderId: created.id };
    }

    // Failure — money already moved. Park for a human, do NOT retry (avoids a
    // duplicate store order), never throw. 5xx/transport are AMBIGUOUS (Shopify
    // may hold a phantom order); the needs_review note records the class so an
    // operator checks the store before recreating.
    await parkNeedsReview({
      idempotencyKey, sessionId: claimedSessionId,
      reason: `${created.kind}:${created.detail}`,
    });
    return { ok: false, needsReview: true, error: `${created.kind}:${created.detail}` };
  } catch (err) {
    // Absolute backstop: nothing in this function may propagate into the
    // already-charged webhook. Park best-effort and swallow.
    console.error('[shopify-order] unexpected error (non-fatal):', err.message);
    try {
      await parkNeedsReview({ idempotencyKey, sessionId, reason: `unexpected:${err.message}` });
    } catch { /* swallow */ }
    return { ok: false, needsReview: true, error: 'unexpected_error' };
  }
}
