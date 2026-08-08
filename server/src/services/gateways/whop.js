// Whop gateway adapter — port of funnel-os whop_client.py. Three operations:
//   1. createCheckoutSession — POST /checkout_configurations with an inline
//      one-time plan whose initial_price is the dynamic server-priced cart
//      total; metadata flows through to payment.succeeded. Response id
//      (ch_…) is the embed sessionId.
//   2. verifyWebhookSignature — Standard-Webhooks HMAC-SHA256 over
//      "{webhook-id}.{webhook-timestamp}.{raw_body}". FAIL-CLOSED.
//   3. chargeSavedPaymentMethod — POST /payments against the saved
//      off-session method (1-click upsell). A 2xx does NOT mean money moved:
//      only a settled status does; anything else returns pending=true and is
//      reconciled by the payment.succeeded/failed webhook.
// Credentials are passed in decrypted by the caller (gatewayConfigs resolve);
// env is read at call time, never module-cached. Calls return {ok, ...} and
// never throw.
import crypto from 'crypto';

const TIMEOUT_MS = 30_000;
const WEBHOOK_MAX_AGE_S = 300;

// Off-session /payments settles ASYNC — only these statuses mean money moved.
export const SETTLED_PAYMENT_STATUSES = new Set(['succeeded', 'paid', 'completed', 'complete']);

// Base URL: WHOP_API_BASE (test seam) > sandbox flag > prod. Read per call.
function apiBase(sandbox) {
  if (process.env.WHOP_API_BASE) return process.env.WHOP_API_BASE;
  const envSandbox = (process.env.WHOP_ENVIRONMENT || '').trim().toLowerCase() === 'sandbox';
  return sandbox || envSandbox
    ? 'https://sandbox-api.whop.com/api/v1'
    : 'https://api.whop.com/api/v1';
}

async function whopFetch(apiKey, method, path, { body, sandbox, idempotencyKey, timeout = TIMEOUT_MS } = {}) {
  const headers = {
    Authorization: `Bearer ${apiKey}`,
    'Content-Type': 'application/json',
    Accept: 'application/json',
  };
  if (idempotencyKey) headers['Idempotency-Key'] = idempotencyKey;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeout);
  if (timer.unref) timer.unref();
  try {
    const resp = await fetch(`${apiBase(sandbox)}${path}`, {
      method,
      headers,
      body: body ? JSON.stringify(body) : undefined,
      signal: controller.signal,
    });
    let json = null;
    let text = null;
    try { json = await resp.json(); } catch { try { text = await resp.text(); } catch {} }
    return { ok: resp.ok, status: resp.status, json, text: resp.ok ? null : text };
  } catch (err) {
    return { ok: false, status: null, json: null, error: 'network', text: String(err?.message || err) };
  } finally {
    clearTimeout(timer);
  }
}

// Decline-detail keys probed on a non-2xx /payments body, so a synchronous
// decline surfaces the same reason the async payment.failed webhook would.
const DECLINE_REASON_KEYS = [
  'failure_message', 'failure_reason', 'failure_code', 'error', 'message', 'decline_code',
];

export function extractDecline(payload) {
  if (!payload || typeof payload !== 'object') return { reason: '', declineCode: '' };
  const scopes = [payload];
  for (const k of ['error', 'data']) {
    if (payload[k] && typeof payload[k] === 'object' && !Array.isArray(payload[k])) {
      scopes.push(payload[k]);
    }
  }
  let reason = '';
  let declineCode = '';
  for (const scope of scopes) {
    for (const key of DECLINE_REASON_KEYS) {
      const val = scope[key];
      if (val && typeof val !== 'object' && !reason) reason = String(val).trim().slice(0, 200);
    }
    const dc = scope.decline_code;
    if (dc && typeof dc !== 'object' && !declineCode) declineCode = String(dc).trim().slice(0, 80);
  }
  return { reason, declineCode };
}

/**
 * Create a Whop checkout configuration for a DYNAMIC one-time amount.
 * `creds` = { api_key, company_id, sandbox? }. Returns
 * {ok, session_id (ch_…), plan_id, purchase_url} or {ok:false, error}.
 */
export async function createCheckoutSession(creds, {
  amount, currency = 'usd', metadata = {}, redirectUrl = '',
} = {}) {
  if (amount == null || Number(amount) < 1.0) {
    return { ok: false, error: 'amount_below_minimum' };
  }
  if (!creds?.api_key || !creds?.company_id) {
    return { ok: false, error: 'not_configured' };
  }
  // company_id goes INSIDE the inline plan (a top-level company_id is
  // rejected). setup_future_usage is an embed prop, not an API field.
  const body = {
    plan: {
      company_id: creds.company_id,
      initial_price: Number(amount),
      currency: (currency || 'usd').toLowerCase(),
      plan_type: 'one_time',
      release_method: 'buy_now',
      visibility: 'hidden',
    },
    mode: 'payment',
    metadata,
  };
  if (redirectUrl) body.redirect_url = redirectUrl;
  const res = await whopFetch(creds.api_key, 'POST', '/checkout_configurations', {
    body, sandbox: creds.sandbox,
  });
  if (res.ok) {
    const data = res.json || {};
    return {
      ok: true,
      session_id: data.id,
      plan_id: data.plan?.id || null,
      purchase_url: data.purchase_url || null,
      currency: data.currency || body.plan.currency,
    };
  }
  return { ok: false, error: res.error || `http_${res.status}`, detail: (res.text || '').slice(0, 300) };
}

/**
 * Verify a Whop webhook per the Standard-Webhooks spec. Headers (lowercase):
 * webhook-id, webhook-timestamp, webhook-signature ("v1,<b64>" space-parts).
 * HMAC-SHA256 over "{id}.{ts}.{raw}"; two key derivations are tried because
 * Whop (`ws_…` = raw secret bytes) and Standard-Webhooks (`whsec_<b64>` =
 * decoded) disagree — both derive from the same configured secret, so trying
 * both never weakens the check. FAIL-CLOSED on anything missing/stale.
 */
export function verifyWebhookSignature(rawBody, headers, secret) {
  if (!secret || !rawBody || !rawBody.length) return false;
  const low = {};
  for (const [k, v] of Object.entries(headers || {})) low[String(k).toLowerCase()] = v;
  const wid = low['webhook-id'];
  const wts = low['webhook-timestamp'];
  const sigHeader = low['webhook-signature'];
  if (!wid || !wts || !sigHeader) return false;
  const ts = parseInt(wts, 10);
  if (!Number.isFinite(ts)) return false;
  if (Math.abs(Date.now() / 1000 - ts) > WEBHOOK_MAX_AGE_S) return false;

  const keyCandidates = [Buffer.from(secret, 'utf8')];
  const b64Body = secret.startsWith('whsec_') ? secret.slice(6) : secret;
  try {
    const decoded = Buffer.from(b64Body, 'base64');
    if (decoded.length) keyCandidates.push(decoded);
  } catch { /* non-base64 secret just isn't this variant */ }

  const raw = Buffer.isBuffer(rawBody) ? rawBody : Buffer.from(String(rawBody), 'utf8');
  const signed = Buffer.concat([Buffer.from(`${wid}.${wts}.`, 'utf8'), raw]);
  const provided = String(sigHeader)
    .split(' ')
    .map((part) => part.split(',')[1])
    .filter(Boolean);
  for (const key of keyCandidates) {
    const expected = crypto.createHmac('sha256', key).update(signed).digest('base64');
    const expBuf = Buffer.from(expected, 'utf8');
    for (const sig of provided) {
      const sigBuf = Buffer.from(sig, 'utf8');
      if (sigBuf.length === expBuf.length && crypto.timingSafeEqual(expBuf, sigBuf)) return true;
    }
  }
  return false;
}

/**
 * Charge a saved off-session payment method (1-click upsell). Idempotency-Key
 * header means a retried charge can NEVER double-bill — Whop returns the same
 * payment for a repeated key.
 * Returns {ok:true, payment_id, status} ONLY when the returned status is a
 * settled value; {ok:false, pending:true, payment_id, status} when accepted
 * but not settled (await the webhook); {ok:false, error, decline_code} on a
 * decline/failure.
 */
export async function chargeSavedPaymentMethod(creds, {
  amount, memberId, paymentMethodId, currency = 'usd', metadata = {}, idempotencyKey = '',
} = {}) {
  if (!creds?.api_key || !creds?.company_id) return { ok: false, error: 'not_configured' };
  if (!memberId || !paymentMethodId) return { ok: false, error: 'missing_payment_reference' };
  if (amount == null || Number(amount) < 1.0) return { ok: false, error: 'amount_below_minimum' };
  const body = {
    company_id: creds.company_id,
    member_id: memberId,
    payment_method_id: paymentMethodId,
    plan: {
      initial_price: Number(amount),
      currency: (currency || 'usd').toLowerCase(),
      plan_type: 'one_time',
    },
    metadata,
  };
  const res = await whopFetch(creds.api_key, 'POST', '/payments', {
    body, sandbox: creds.sandbox, idempotencyKey,
  });
  if (res.ok) {
    const data = res.json || {};
    const status = String(data.status || '').trim().toLowerCase();
    if (SETTLED_PAYMENT_STATUSES.has(status)) {
      return { ok: true, payment_id: data.id, status: data.status };
    }
    // Accepted ≠ settled: hold at a non-terminal state; the webhook decides.
    return {
      ok: false,
      pending: true,
      error: status === 'requires_action' ? 'requires_action' : 'pending',
      payment_id: data.id,
      status: data.status,
    };
  }
  if (res.error === 'network') return { ok: false, error: 'network', detail: res.text };
  const { reason, declineCode } = extractDecline(res.json);
  return {
    ok: false,
    error: reason || (res.text || '').trim().slice(0, 200) || 'charge_failed',
    decline_code: declineCode,
    http_status: res.status,
  };
}

// GET /payments/{id} — read-only reconciliation for a charge whose webhook
// was lost. Never moves money.
export async function getPayment(creds, paymentId) {
  if (!creds?.api_key || !creds?.company_id) return { ok: false, status: '', error: 'not_configured' };
  const pid = String(paymentId || '').trim();
  if (!pid) return { ok: false, status: '', error: 'missing_payment_id' };
  const res = await whopFetch(creds.api_key, 'GET', `/payments/${encodeURIComponent(pid)}`, {
    sandbox: creds.sandbox, timeout: 6_000,
  });
  const status = String(res.json?.status || '').trim().toLowerCase();
  return {
    ok: res.ok,
    status,
    json: res.json,
    error: res.ok ? null : res.error || (res.status ? `http_${res.status}` : 'network'),
  };
}

// Best-effort payload extractors (payment.succeeded shapes vary).
export function extractPaymentMethodId(data) {
  if (data?.payment_method && typeof data.payment_method === 'object' && data.payment_method.id) {
    return String(data.payment_method.id);
  }
  if (data?.payment_method_id) return String(data.payment_method_id);
  const si = data?.setup_intent || data?.setupIntent;
  if (si && typeof si === 'object' && si.payment_method?.id) return String(si.payment_method.id);
  return '';
}

export function extractMemberId(data) {
  if (data?.member && typeof data.member === 'object' && data.member.id) {
    return String(data.member.id);
  }
  return String(data?.member_id || '');
}

function coerceAmount(v) {
  if (typeof v === 'boolean') return null;
  if (typeof v === 'number') return v;
  if (typeof v === 'string') {
    const n = Number(v.trim());
    return Number.isFinite(n) ? n : null;
  }
  return null;
}

// GROSS amount Whop charged the buyer. amount_after_fees is the merchant NET
// (fees-reduced) — last resort only, and the caller must treat it as net.
export function extractGrossAmount(data) {
  for (const key of ['amount', 'final_amount', 'total', 'subtotal', 'initial_price', 'amount_total']) {
    const amt = coerceAmount(data?.[key]);
    if (amt !== null) return amt;
  }
  return null;
}

export function extractAmountAfterFees(data) {
  return coerceAmount(data?.amount_after_fees);
}

// Maximum plausible processor+platform fee fraction: when only the merchant
// net is reported, a legitimate net sits within (1 - MAX_FEE_PCT) of the
// gross; anything lower is a real underpayment and must fail closed.
export const MAX_FEE_PCT = 0.15;

/**
 * Reconcile what Whop charged against the session snapshot total.
 * Returns {ok, reason}. The Whop-reported amount is the source of truth.
 */
export function reconcileAmount({ expectedTotal, grossCharged, amountAfterFees }) {
  const expected = Math.round(Number(expectedTotal) * 100) / 100;
  if (grossCharged !== null && grossCharged !== undefined) {
    const gross = Math.round(Number(grossCharged) * 100) / 100;
    if (Math.abs(gross - expected) <= 0.01) return { ok: true, reason: '' };
    return { ok: false, reason: `gross_mismatch: charged=${gross} expected=${expected}` };
  }
  if (amountAfterFees !== null && amountAfterFees !== undefined) {
    const net = Math.round(Number(amountAfterFees) * 100) / 100;
    if (net > expected + 0.01) return { ok: false, reason: `net_above_expected: net=${net} expected=${expected}` };
    if (net >= expected * (1 - MAX_FEE_PCT) - 0.01) return { ok: true, reason: '' };
    return { ok: false, reason: `net_below_fee_band: net=${net} expected=${expected}` };
  }
  return { ok: false, reason: 'no_amount_reported' };
}
