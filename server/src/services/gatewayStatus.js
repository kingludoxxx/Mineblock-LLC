// Connection-status checks per gateway per credential mode. Drives the
// Payments-card pills and the Advanced → Health panel.
//
//   whop / stripe  — a lightweight AUTHENTICATED ping (GET, no side effects)
//                    against the mode's decrypted key.
//   paypal / nmi   — no charge adapter exists yet, so report configured-or-not
//                    from the stored creds only (never claims "connected").
//
// PING DISCIPLINE:
//   - A gateway with NO stored credentials for the funnel+mode reports
//     'not_configured' WITHOUT any outbound call — the pill's job is "is THIS
//     funnel set up", not "does a platform env key exist". (Pass
//     { envInclusive: true } to opt into env-resolved status explicitly.)
//   - Results are cached in-memory for STATUS_TTL_MS keyed
//     (funnelId, gateway, mode) so reopening the modal doesn't hammer the
//     processors. { force: true } bypasses the cache (the Re-check button).
//
// Statuses returned: 'connected' | 'configured' | 'not_configured' | 'error'
// | 'unknown'. Credentials are read via resolveGatewayCreds (mode-scoped) and
// are NEVER echoed back to the caller — only the status + a coarse detail code.
import { GATEWAYS, resolveGatewayCreds, getStoredConfig } from './gatewayConfigs.js';

const PING_TIMEOUT_MS = 6_000;
export const STATUS_TTL_MS = 45_000;

// (funnelId|gateway|mode) -> { at, result }. Small by construction (funnels ×
// 4 gateways × 2 modes); staleness is checked on read.
const statusCache = new Map();

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
    // GET /companies/{company_id} — verified against a REAL live key: it
    // returns 200 with the company record. The two obvious alternatives do
    // NOT work and would show "error" on a perfectly valid key:
    //   /me            → 404 (no such route)
    //   /payments?per=1→ 400 "not authorized ... access to this resource"
    // This call also proves the company_id is right, not just the key —
    // which is the pair the charge path actually needs. Read-only.
    const res = await timedFetch(
      `${whopBase(mode)}/companies/${encodeURIComponent(creds.company_id)}`,
      { headers: { Authorization: `Bearer ${creds.api_key}`, Accept: 'application/json' } }
    );
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

async function computeGatewayMode(funnelId, gateway, mode, opts) {
  // No stored credentials for this funnel+mode → not_configured with ZERO
  // outbound calls. This keeps an unconfigured funnel from pinging the
  // processors with the platform's env production key on every modal open.
  if (!opts.envInclusive) {
    let stored;
    try {
      stored = await getStoredConfig(funnelId, gateway);
    } catch {
      return { status: 'error', detail: 'resolve_failed' };
    }
    const set = stored ? stored[mode] : null;
    if (!set || Object.keys(set).length === 0) return NOT_CONFIGURED;
  }
  let creds;
  try {
    creds = await resolveGatewayCreds(funnelId, gateway, { mode });
  } catch {
    return { status: 'error', detail: 'resolve_failed' };
  }
  switch (gateway) {
    case 'whop':
      return pingWhop(creds, mode);
    case 'stripe':
      return pingStripe(creds);
    case 'paypal':
    case 'nmi':
      return configuredOrNot(gateway, creds);
    default:
      return { status: 'unknown' };
  }
}

// Status for ONE gateway in ONE mode. Cached (TTL) unless opts.force.
export async function checkGatewayMode(funnelId, gateway, mode, opts = {}) {
  if (!GATEWAYS[gateway]) return { status: 'unknown' };
  const m = mode === 'sandbox' ? 'sandbox' : 'live';
  const key = `${funnelId}|${gateway}|${m}`;
  const hit = statusCache.get(key);
  if (!opts.force && hit && Date.now() - hit.at < STATUS_TTL_MS) return hit.result;
  const result = await computeGatewayMode(funnelId, gateway, m, opts);
  statusCache.set(key, { at: Date.now(), result });
  return result;
}

// Test seam: drop all cached statuses.
export function clearStatusCache() {
  statusCache.clear();
}

function aggregate(live, sandbox) {
  if (live.status === 'connected' || sandbox.status === 'connected') return 'connected';
  if (live.status === 'configured' || sandbox.status === 'configured') return 'configured';
  if (live.status === 'error' || sandbox.status === 'error') return 'error';
  return 'not_configured';
}

// Status for ONE gateway across BOTH modes (+ an aggregate for the card pill).
export async function checkGateway(funnelId, gateway, opts = {}) {
  if (!GATEWAYS[gateway]) return { gateway, aggregate: 'unknown', live: { status: 'unknown' }, sandbox: { status: 'unknown' } };
  const [live, sandbox] = await Promise.all([
    checkGatewayMode(funnelId, gateway, 'live', opts),
    checkGatewayMode(funnelId, gateway, 'sandbox', opts),
  ]);
  return { gateway, aggregate: aggregate(live, sandbox), live, sandbox };
}

// Status for EVERY gateway on a funnel.
export async function checkAll(funnelId, opts = {}) {
  const out = {};
  for (const gw of Object.keys(GATEWAYS)) {
    // eslint-disable-next-line no-await-in-loop
    out[gw] = await checkGateway(funnelId, gw, opts);
  }
  return out;
}
