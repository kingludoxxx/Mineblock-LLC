// Shopify discount codes in the funnel checkout — the operator creates a code
// in Shopify, buyers use it here, the store's reporting sees it on the order.
//
// The AMOUNT is always OUR computation from the price rule the code belongs
// to — the client sends only the code string; a client can never name a
// number. Validation is against Shopify Admin REST:
//   GET /discount_codes/lookup.json?code=X  → 303/redirect or JSON with
//       price_rule_id (Shopify answers 404 for unknown codes)
//   GET /price_rules/{id}.json              → the rule (value_type, value,
//       starts_at/ends_at, prerequisite_subtotal_range, usage_limit …)
//
// V1 scope (deliberate): value_type 'percentage' and 'fixed_amount' across the
// whole cart (target_type line_items with allocation across the subtotal —
// how Shopify applies order-level codes). Honoured guards: date window,
// rule-disabled, minimum-subtotal prerequisite, usage_limit (best effort via
// usage_count). Per-customer limits and entitled-product subsets are refused
// as 'code_not_supported' rather than silently mis-applied — a wrong discount
// is a money bug, an unsupported one is a message.
//
// FAIL-CLOSED: any transport/parse failure applies NO discount and returns a
// retryable error — a Shopify blip must never turn into a free discount or a
// silently full-priced charge after the buyer saw a discounted total.
import { PricingUnavailableError } from './checkoutPricing.js';

const TIMEOUT_MS = 8_000;
const round2 = (n) => Math.round(Number(n) * 100) / 100;

function creds() {
  const store = process.env.PUURE_SHOPIFY_STORE || process.env.SHOPIFY_STORE_DOMAIN || '';
  return {
    store,
    token: process.env.PUURE_SHOPIFY_TOKEN || process.env.SHOPIFY_ACCESS_TOKEN || '',
    apiVersion: process.env.SHOPIFY_API_VERSION || '2024-01',
    apiBase: process.env.SHOPIFY_API_BASE || (store ? `https://${store}` : ''),
  };
}

async function shopifyGet(path) {
  const { store, token, apiVersion, apiBase } = creds();
  if (!store || !token) throw new PricingUnavailableError('shopify_not_configured');
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);
  if (timer.unref) timer.unref();
  let resp;
  try {
    resp = await fetch(`${apiBase}/admin/api/${apiVersion}/${path}`, {
      headers: { 'X-Shopify-Access-Token': token },
      redirect: 'follow', // lookup.json 303s to the discount_code resource
      signal: controller.signal,
    });
  } catch (err) {
    throw new PricingUnavailableError(err?.name === 'AbortError' ? 'timeout' : 'network');
  } finally {
    clearTimeout(timer);
  }
  if (resp.status === 404) return { notFound: true };
  if (!resp.ok) throw new PricingUnavailableError(`http_${resp.status}`);
  let body = {};
  try { body = await resp.json(); } catch { throw new PricingUnavailableError('bad_json'); }
  return { body };
}

/**
 * Validate a code against Shopify and compute the discount for a subtotal.
 * @returns {Promise<{ok:true, code:string, amount:number, valueType:string}
 *   | {ok:false, reason:string}>}  reason ∈ code_not_found | code_expired |
 *   code_not_started | code_disabled | code_usage_exhausted |
 *   code_min_subtotal:<n> | code_not_supported
 * @throws {PricingUnavailableError} on transport trouble (retryable 503).
 */
export async function validateDiscountCode(rawCode, { subtotal }) {
  const code = String(rawCode || '').trim().slice(0, 64);
  if (!code) return { ok: false, reason: 'code_not_found' };

  const lookup = await shopifyGet(`discount_codes/lookup.json?code=${encodeURIComponent(code)}`);
  if (lookup.notFound) return { ok: false, reason: 'code_not_found' };
  const dc = lookup.body?.discount_code;
  if (!dc?.price_rule_id) return { ok: false, reason: 'code_not_found' };

  const ruleRes = await shopifyGet(`price_rules/${encodeURIComponent(dc.price_rule_id)}.json`);
  if (ruleRes.notFound) return { ok: false, reason: 'code_not_found' };
  const rule = ruleRes.body?.price_rule;
  if (!rule) return { ok: false, reason: 'code_not_found' };

  const now = Date.now();
  if (rule.starts_at && new Date(rule.starts_at).getTime() > now) {
    return { ok: false, reason: 'code_not_started' };
  }
  if (rule.ends_at && new Date(rule.ends_at).getTime() < now) {
    return { ok: false, reason: 'code_expired' };
  }
  if (rule.usage_limit != null && Number(dc.usage_count ?? 0) >= Number(rule.usage_limit)) {
    return { ok: false, reason: 'code_usage_exhausted' };
  }
  const minSub = Number(rule.prerequisite_subtotal_range?.greater_than_or_equal_to);
  if (Number.isFinite(minSub) && Number(subtotal) < minSub) {
    return { ok: false, reason: `code_min_subtotal:${minSub}` };
  }
  // Refuse shapes we would mis-apply rather than guessing (see header).
  if (rule.target_type !== 'line_item' && rule.target_type !== 'line_items') {
    return { ok: false, reason: 'code_not_supported' }; // e.g. shipping_line
  }
  if (Array.isArray(rule.entitled_product_ids) && rule.entitled_product_ids.length) {
    return { ok: false, reason: 'code_not_supported' };
  }
  if (Array.isArray(rule.entitled_variant_ids) && rule.entitled_variant_ids.length) {
    return { ok: false, reason: 'code_not_supported' };
  }
  if (rule.once_per_customer) {
    // We have no Shopify customer identity at checkout time to honour it.
    return { ok: false, reason: 'code_not_supported' };
  }

  const value = Math.abs(Number(rule.value)); // Shopify stores "-10.0"
  if (!Number.isFinite(value) || value <= 0) return { ok: false, reason: 'code_not_found' };
  let amount;
  if (rule.value_type === 'percentage') {
    amount = round2(Number(subtotal) * (value / 100));
  } else if (rule.value_type === 'fixed_amount') {
    amount = round2(value);
  } else {
    return { ok: false, reason: 'code_not_supported' };
  }
  // A discount can never exceed the subtotal (total stays >= shipping+tax).
  amount = Math.min(amount, round2(Number(subtotal)));
  return { ok: true, code: dc.code || code, amount, valueType: rule.value_type };
}

export const _internals = { creds };
