// Connection-status checks per gateway per credential mode. Drives the
// Payments-card pills and the Advanced → Health panel.
//
//   whop / stripe  — a lightweight AUTHENTICATED ping (GET, no side effects)
//                    against the mode's decrypted key.
//   paypal / nmi   — no charge adapter exists yet, so report configured-or-not
//                    from the stored creds only (never claims "connected").
//
// Statuses returned: 'connected' | 'configured' | 'not_configured' | 'error'
// | 'unknown'. Credentials are read via resolveGatewayCreds (mode-scoped) and
// are NEVER echoed back to the caller — only the status + a coarse detail code.
import { GATEWAYS, resolveGatewayCreds } from './gatewayConfigs.js';

const PING_TIMEOUT_MS = 6_000;

async function timedFetch(url, opts = {}) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), PING_TIMEOUT_MS);
  if (timer.unref) timer.unref();
  try {
    return await fetch(url, { ...opts, signal: controller.signal });
  } finally {
    clearTimeout(timer);
  }
}

// Base URLs are env-overridable (read per call, never cached) so a local mock
// can stand in for the real processor during verification.
function whopBase(mode) {
  if (process.env.WHOP_API_BASE) return process.env.WHOP_API_BASE;
  return mode === 'sandbox'
    ? 'https://sandbox-api.whop.com/api/v1'
    : 'https://api.whop.com/api/v1';
}
function stripeBase() {
  return process.env.STRIPE_API_BASE || 'https://api.stripe.com/v1';
}

const NOT_CONFIGURED = { status: 'not_configured' };

function classify(res) {
  if (res.ok) return { status: 'connected' };
  if (res.status === 401 || res.status === 403) return { status: 'error', detail: 'auth_failed' };
  return { status: 'error', detail: `http_${res.status}` };
}

async function pingWhop(creds, mode) {
  if (!creds.api_key || !creds.company_id) return NOT_CONFIGURED;
  try {
    // GET /me — cheapest authenticated read; verifies the key without moving
    // money or mutating anything.
    const res = await timedFetch(`${whopBase(mode)}/me`, {
      headers: { Authorization: `Bearer ${creds.api_key}`, Accept: 'application/json' },
    });
    return classify(res);
  } catch {
    return { status: 'error', detail: 'network' };
  }
}

async function pingStripe(creds) {
  if (!creds.secret_key) return NOT_CONFIGURED;
  try {
    // GET /balance — a read-only authenticated call; 2xx proves the key works.
    const res = await timedFetch(`${stripeBase()}/balance`, {
      headers: { Authorization: `Bearer ${creds.secret_key}` },
    });
    return classify(res);
  } catch {
    return { status: 'error', detail: 'network' };
  }
}

function configuredOrNot(gateway, creds) {
  const required = GATEWAYS[gateway]?.requiredForConfigured || [];
  const ok = required.length > 0 && required.every((f) => creds[f]);
  return ok ? { status: 'configured' } : NOT_CONFIGURED;
}

// Status for ONE gateway in ONE mode.
export async function checkGatewayMode(funnelId, gateway, mode) {
  if (!GATEWAYS[gateway]) return { status: 'unknown' };
  const m = mode === 'sandbox' ? 'sandbox' : 'live';
  let creds;
  try {
    creds = await resolveGatewayCreds(funnelId, gateway, { mode: m });
  } catch (err) {
    return { status: 'error', detail: 'resolve_failed' };
  }
  switch (gateway) {
    case 'whop':
      return pingWhop(creds, m);
    case 'stripe':
      return pingStripe(creds);
    case 'paypal':
    case 'nmi':
      return configuredOrNot(gateway, creds);
    default:
      return { status: 'unknown' };
  }
}

function aggregate(live, sandbox) {
  if (live.status === 'connected' || sandbox.status === 'connected') return 'connected';
  if (live.status === 'configured' || sandbox.status === 'configured') return 'configured';
  if (live.status === 'error' || sandbox.status === 'error') return 'error';
  return 'not_configured';
}

// Status for ONE gateway across BOTH modes (+ an aggregate for the card pill).
export async function checkGateway(funnelId, gateway) {
  if (!GATEWAYS[gateway]) return { gateway, aggregate: 'unknown', live: { status: 'unknown' }, sandbox: { status: 'unknown' } };
  const [live, sandbox] = await Promise.all([
    checkGatewayMode(funnelId, gateway, 'live'),
    checkGatewayMode(funnelId, gateway, 'sandbox'),
  ]);
  return { gateway, aggregate: aggregate(live, sandbox), live, sandbox };
}

// Status for EVERY configured gateway on a funnel.
export async function checkAll(funnelId) {
  const out = {};
  for (const gw of Object.keys(GATEWAYS)) {
    // eslint-disable-next-line no-await-in-loop
    out[gw] = await checkGateway(funnelId, gw);
  }
  return out;
}
