// Stripe gateway adapter — port of funnel-os lb_stripe_service.py.
// Buyer-facing charge path via PaymentIntents:
//   - createPaymentIntent  — main offer; Customer + setup_future_usage=
//     off_session tokenizes the card for 1-click post-purchase upsells
//   - retrievePaymentIntent — authoritative status/amount/PM/customer read
//     (latest_charge expanded), used by the settle webhook — never trust the
//     webhook payload's own numbers
//   - chargeOffSession     — the upsell charge against the saved method
//   - verifyWebhookSignature — LOCAL HMAC check of Stripe-Signature against
//     the whsec_ signing secret (fail-closed)
// Every call takes the already-decrypted secret key (resolved by the caller)
// and returns {ok, ...} — never throws. Amounts are Stripe MINOR units.
import crypto from 'crypto';

const TIMEOUT_MS = 20_000;
// Stripe webhook replay tolerance (seconds) — matches Stripe's own default.
const WEBHOOK_TOLERANCE_S = 300;

// API base is env-overridable (read at call time) so local verification can
// point at a mock Stripe; unset = real Stripe. Never module-cached.
function apiBase() {
  return process.env.STRIPE_API_BASE || 'https://api.stripe.com/v1';
}

// Zero-decimal currencies charge in whole units (no *100). Bounded list per
// Stripe docs; everything else is treated as 2-decimal.
const ZERO_DECIMAL = new Set([
  'bif', 'clp', 'djf', 'gnf', 'jpy', 'kmf', 'krw', 'mga', 'pyg', 'rwf',
  'ugx', 'vnd', 'vuv', 'xaf', 'xof', 'xpf',
]);

// Only a genuinely reusable credential may be saved for upsells. BNPL methods
// (afterpay_clearpay etc.) return a real but SINGLE-USE payment method —
// storing one would make the upsell path attempt a doomed off-session charge.
export const REUSABLE_PM_TYPES = new Set(['card', 'link']);

export function amountToMinor(amount, currency) {
  const cur = (currency || 'usd').toLowerCase();
  return ZERO_DECIMAL.has(cur) ? Math.round(Number(amount)) : Math.round(Number(amount) * 100);
}

export function minorToAmount(minor, currency) {
  const cur = (currency || 'usd').toLowerCase();
  return ZERO_DECIMAL.has(cur) ? Number(minor) : Math.round(Number(minor)) / 100;
}

export function modeOf(secretKey) {
  return (secretKey || '').startsWith('sk_test_') ? 'test' : 'live';
}

function form(data) {
  const p = new URLSearchParams();
  for (const [k, v] of Object.entries(data)) {
    if (Array.isArray(v)) for (const item of v) p.append(k, String(item));
    else p.append(k, String(v));
  }
  return p;
}

async function stripeFetch(secretKey, method, path, { data, params, idempotencyKey } = {}) {
  const headers = { Authorization: `Bearer ${secretKey}` };
  if (idempotencyKey) headers['Idempotency-Key'] = idempotencyKey;
  let url = `${apiBase()}${path}`;
  if (params) url += `?${form(params)}`;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);
  if (timer.unref) timer.unref();
  try {
    const resp = await fetch(url, {
      method,
      headers,
      body: data ? form(data) : undefined,
      signal: controller.signal,
    });
    let body = {};
    try { body = await resp.json(); } catch { body = {}; }
    return { status: resp.status, body };
  } catch (err) {
    // TRANSPORT failure: the request may or may not have reached Stripe, so a
    // caller must NEVER treat this as a decline (the charge could have
    // succeeded with the response lost). Callers key off `transport: true`,
    // not the error string.
    const kind = err?.name === 'AbortError' ? 'timeout' : `network:${err?.name || 'Error'}`;
    return { status: 0, body: {}, transportError: kind };
  } finally {
    clearTimeout(timer);
  }
}

function errDetail(body) {
  const err = body && typeof body.error === 'object' ? body.error : {};
  return String(err.message || err.code || '').slice(0, 300);
}

export async function createCustomer(secretKey, { email = '', name = '', phone = '', metadata = {} } = {}) {
  if (!secretKey) return { ok: false, error: 'not_configured' };
  const data = {};
  if (email) data.email = email.slice(0, 512);
  if (name) data.name = name.slice(0, 256);
  if (phone) data.phone = phone.slice(0, 40);
  for (const [k, v] of Object.entries(metadata)) data[`metadata[${k}]`] = String(v).slice(0, 500);
  const r = await stripeFetch(secretKey, 'POST', '/customers', { data });
  if (r.transportError) return { ok: false, error: r.transportError, transport: true };
  if ((r.status === 200 || r.status === 201) && r.body?.id) {
    return { ok: true, customer_id: r.body.id };
  }
  return { ok: false, error: `customer_http_${r.status}`, detail: errDetail(r.body) };
}

export async function createPaymentIntent(secretKey, {
  amount, currency, metadata = {}, customerId = '', idempotencyKey = '',
  setupFutureUsage = true, cardOnly = true,
} = {}) {
  if (!secretKey) return { ok: false, error: 'not_configured' };
  const minor = amountToMinor(amount, currency);
  if (!Number.isFinite(minor) || minor < 1) return { ok: false, error: 'amount_below_minimum' };
  const data = {
    amount: String(minor),
    currency: (currency || 'usd').toLowerCase(),
  };
  if (cardOnly) data['payment_method_types[]'] = 'card';
  else {
    data['automatic_payment_methods[enabled]'] = 'true';
    data['automatic_payment_methods[allow_redirects]'] = 'never';
  }
  if (customerId) {
    data.customer = customerId;
    if (setupFutureUsage) data.setup_future_usage = 'off_session';
  }
  for (const [k, v] of Object.entries(metadata)) data[`metadata[${k}]`] = String(v).slice(0, 500);
  const r = await stripeFetch(secretKey, 'POST', '/payment_intents', { data, idempotencyKey });
  if (r.transportError) return { ok: false, error: r.transportError, transport: true };
  if ((r.status === 200 || r.status === 201) && r.body?.id) {
    return {
      ok: true,
      id: r.body.id,
      client_secret: r.body.client_secret,
      status: r.body.status,
      customer_id: r.body.customer || customerId,
    };
  }
  return { ok: false, error: `pi_http_${r.status}`, detail: errDetail(r.body) };
}

export async function retrievePaymentIntent(secretKey, piId) {
  if (!secretKey || !piId) return { ok: false, error: 'not_configured' };
  const r = await stripeFetch(secretKey, 'GET', `/payment_intents/${encodeURIComponent(piId)}`, {
    params: { 'expand[]': 'latest_charge' },
  });
  if (r.transportError) return { ok: false, error: r.transportError, transport: true };
  if (r.status === 200 && r.body?.id) return { ok: true, id: r.body.id, ...parseIntent(r.body) };
  return { ok: false, error: `pi_http_${r.status}`, detail: errDetail(r.body) };
}

// 1-click UPSELL: a new PaymentIntent confirmed immediately against the saved
// customer + payment method, off-session. {ok:false, requires_action:true}
// when the card needs re-authentication (SCA).
export async function chargeOffSession(secretKey, {
  amount, currency, customerId, paymentMethodId, metadata = {}, idempotencyKey = '',
} = {}) {
  if (!secretKey) return { ok: false, error: 'not_configured' };
  if (!customerId || !paymentMethodId) return { ok: false, error: 'no_saved_method' };
  const minor = amountToMinor(amount, currency);
  if (!Number.isFinite(minor) || minor < 1) return { ok: false, error: 'amount_below_minimum' };
  const data = {
    amount: String(minor),
    currency: (currency || 'usd').toLowerCase(),
    customer: customerId,
    payment_method: paymentMethodId,
    off_session: 'true',
    confirm: 'true',
  };
  for (const [k, v] of Object.entries(metadata)) data[`metadata[${k}]`] = String(v).slice(0, 500);
  const r = await stripeFetch(secretKey, 'POST', '/payment_intents', { data, idempotencyKey });
  if (r.transportError) return { ok: false, error: r.transportError, transport: true };
  if ((r.status === 200 || r.status === 201) && r.body?.id) {
    const status = r.body.status;
    if (status === 'succeeded') return { ok: true, id: r.body.id, status, ...parseIntent(r.body) };
    return {
      ok: false, id: r.body.id, status,
      requires_action: status === 'requires_action',
      error: `upsell_${status}`,
    };
  }
  // A declined off-session charge comes back as an error with the PI nested.
  const declinedPi = r.body?.error?.payment_intent;
  return {
    ok: false,
    error: `upsell_http_${r.status}`,
    detail: errDetail(r.body),
    decline_code: r.body?.error?.decline_code || r.body?.error?.code || '',
    id: declinedPi?.id || '',
  };
}

// Verify a Stripe webhook: HMAC-SHA256 over `${t}.${raw_body}` keyed by the
// whsec_ signing secret, constant-time compared to a v1 sig within the replay
// tolerance. Fail-closed on anything missing or malformed.
export function verifyWebhookSignature(payload, sigHeader, signingSecret) {
  if (!signingSecret || !sigHeader || !payload || !payload.length) return false;
  const parts = {};
  const v1sigs = [];
  for (const p of String(sigHeader).split(',')) {
    const idx = p.indexOf('=');
    if (idx < 1) continue;
    const k = p.slice(0, idx).trim();
    const v = p.slice(idx + 1).trim();
    if (k === 'v1') v1sigs.push(v);
    else parts[k] = v;
  }
  const ts = parseInt(parts.t, 10);
  if (!Number.isFinite(ts)) return false;
  if (Math.abs(Date.now() / 1000 - ts) > WEBHOOK_TOLERANCE_S) return false;
  const raw = Buffer.isBuffer(payload) ? payload : Buffer.from(String(payload), 'utf8');
  const expected = crypto
    .createHmac('sha256', signingSecret)
    .update(Buffer.concat([Buffer.from(`${parts.t}.`, 'utf8'), raw]))
    .digest('hex');
  const expectedBuf = Buffer.from(expected, 'utf8');
  // The header may carry several v1 sigs (secret rotation) — accept any match.
  for (const sig of v1sigs) {
    const sigBuf = Buffer.from(sig, 'utf8');
    if (sigBuf.length === expectedBuf.length && crypto.timingSafeEqual(expectedBuf, sigBuf)) {
      return true;
    }
  }
  return false;
}

// Non-secret settle fields from a PaymentIntent (latest_charge expanded).
export function parseIntent(pi) {
  const charge = pi.latest_charge && typeof pi.latest_charge === 'object' ? pi.latest_charge : {};
  const billing = charge.billing_details || {};
  const baddr = billing.address || {};
  const ship = charge.shipping || pi.shipping || {};
  const saddr = ship.address || {};
  const src = saddr.line1 ? saddr : baddr;
  let shipping = null;
  if (src.line1) {
    shipping = {
      name: String(ship.name || billing.name || '').trim(),
      address1: src.line1 || '',
      address2: src.line2 || '',
      city: src.city || '',
      province_code: src.state || '',
      zip: src.postal_code || '',
      country_code: String(src.country || '').toUpperCase(),
      phone: String(ship.phone || billing.phone || '').trim(),
    };
  }
  return {
    status: pi.status,
    amount: minorToAmount(pi.amount_received ?? pi.amount ?? 0, pi.currency || 'usd'),
    currency: String(pi.currency || 'usd').toUpperCase(),
    payment_method_id: typeof pi.payment_method === 'string'
      ? pi.payment_method
      : pi.payment_method?.id || '',
    // The METHOD the charge actually used — the settle path gates PM reuse on
    // this (BNPL leaves no reusable credential).
    payment_method_type: charge.payment_method_details?.type || '',
    customer_id: typeof pi.customer === 'string' ? pi.customer : pi.customer?.id || '',
    co_session_id: pi.metadata?.co_session_id || '',
    payer_email: billing.email || pi.receipt_email || '',
    payer_name: billing.name || '',
    payer_phone: billing.phone || '',
    shipping,
  };
}
