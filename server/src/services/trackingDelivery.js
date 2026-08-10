// Server-side conversion delivery — the rails. Port of funnel-os
// lb_postback_delivery_service.py (retry schedule, circuit breaker, hard vs
// soft errors, per-event payload rejection) + the identity hashing from
// lb_tracking_service.py.
//
// Money/serving line (DECISIONS #16): every function here is fire-and-forget
// from the settlement path's point of view. A delivery failure escalates for
// RETRY (queue) or dead-letters — it never blocks settlement and never throws
// up the stack.
import crypto from 'crypto';
import net from 'net';
import dns from 'dns/promises';
import { pgQuery } from '../db/pg.js';
import { ensureTrackingTables } from './trackingSchema.js';
import { emqScore, idkFrom } from './trackingAttribution.js';
import { decryptSecret } from './gatewayConfigs.js';
import { renderPostback, postbackContext, MAX_POSTBACK_VALUE } from './trackingPostbackTemplate.js';
import { customNetworkPixelById } from './trackingCustomNetworks.js';

// Retry schedule AFTER the failed inline attempt: 1m, 5m, 15m, 1h, 3h, 6h,
// 12h, 24h → dead. Nine total attempts (inline + 8 queued).
const RETRY_DELAYS_S = [60, 300, 900, 3600, 10800, 21600, 43200, 86400];
const MAX_ATTEMPTS = 1 + RETRY_DELAYS_S.length;
const BREAKER_FAILS = 5;         // consecutive failures that open the circuit
const BREAKER_COOLDOWN_S = 900;  // 15 min open
const STALE_CLAIM_S = 1800;      // 'sending' older than this = dead worker

// Terminal errors — retrying can never succeed, dead-letter in ONE pass.
// 'kind_not_wired': a pixel row whose kind has NO delivery adapter (today:
// google_ads, registered-but-dormant in the trackingAdmin registry). Retrying
// cannot wire an adapter, so it dead-letters in one pass and says exactly why
// in the event feed rather than pretending a send happened.
// 'no_client_id': GA4 MP requires a client_id and the envelope carried nothing
// stable to derive one from.
const HARD_ERRORS = new Set(['not_configured', 'no_click_id', 'no_order_id',
  'pixel_gone', 'skipped_window', 'no_identity', 'kind_not_wired', 'no_client_id']);
const HARD_PREFIXES = ['unsafe_url'];
// ...except a DNS blip in the SSRF pre-flight — the transient the rails exist
// for. This ONE exception is the difference between surviving a DNS wobble and
// dead-lettering a day of conversions.
const SOFT_PREFIXES = ['unsafe_url:dns_resolution_failed'];

const startsWithAny = (s, arr) => arr.some((p) => s.startsWith(p));

// ── identity hashing (SHA-256, normalised) ──────────────────────────────────
const sha256 = (s) => crypto.createHash('sha256').update(String(s)).digest('hex');
const normEmail = (v) => String(v || '').trim().toLowerCase();
const normPhone = (v) => String(v || '').replace(/[^0-9]/g, '');
const normName = (v) => String(v || '').trim().toLowerCase();
const normZip = (v) => String(v || '').trim().toLowerCase().slice(0, 10);
const normCountry = (v) => String(v || '').trim().toLowerCase().slice(0, 2);

// Build the outbound user_data (hashed) + the PII-free idk key list from a raw
// identity object. The RAW values never appear in the returned idk, and the
// hashed values never appear in the event log (only idk is logged).
export function buildUserData(raw = {}) {
  const ud = {};
  const present = {};
  const put = (key, val, hasher) => {
    const v = val == null ? '' : String(val).trim();
    if (!v) return;
    ud[key] = hasher ? sha256(hasher(v)) : v;
    present[key] = true;
  };
  put('em', raw.email, normEmail);
  put('ph', raw.phone, normPhone);
  put('fn', raw.first_name, normName);
  put('ln', raw.last_name, normName);
  put('ct', raw.city, normName);
  put('st', raw.state, normName);
  put('zp', raw.zip, normZip);
  put('country', raw.country, normCountry);
  put('external_id', raw.external_id, (x) => x.toLowerCase());
  // Un-hashed browser/context signals (CAPI spec).
  put('fbp', raw.fbp);
  put('fbc', raw.fbc);
  put('ip', raw.ip);
  put('ua', raw.ua);
  put('click_id', raw.click_id);
  const idk = idkFrom(present);
  return { user_data: ud, idk };
}

// ── error classification ─────────────────────────────────────────────────────
// Review MINOR #3: an ECHOING endpoint (a legacy capi_endpoint row, a debug
// relay) reflects our request body — which carries the plaintext access_token
// — back at us, and errOf persists a body slice into admin-readable error
// fields (lb_tracking_events.error, lb_postback_queue.last_error). Mask any
// access_token value BEFORE slicing, so a mid-token cut can't leak partial
// token bytes either.
// `api_secret` is masked for the SAME reason plus a sharper one: GA4's
// Measurement Protocol only accepts it as a QUERY parameter (see ga4CollectUrl),
// so any endpoint that echoes the request URI — a debug relay, a 500 page, an
// error body — hands the live secret straight into
// lb_tracking_events.error / lb_postback_queue.last_error, which the admin UI
// renders. Mask BEFORE errOf slices, so a mid-secret cut can't leak partial
// bytes either. Matches both `api_secret=VALUE` (URL) and `"api_secret":"VALUE"`
// (JSON) via the \W{0,3} separator run.
// Review LOW #7: KEY-ANCHORED, and the key list is the single place to extend.
// Every credential name this system can put on the wire goes here — including
// the google_ads ones, which are stored today even though delivery is not
// wired, because a stored credential can still reach an error string through a
// future adapter or an operator paste.
const SECRET_KEYS = [
  'access_token', 'api_secret', 'capi_token',
  'developer_token', 'refresh_token', 'client_secret',
];
// Review M1: the named list above is an ALLOW-LIST of credentials THIS system
// mints, and it was never going to cover an operator-authored postback
// template. A custom S2S URL carries whatever the partner network calls its
// credential — `api_key`, `apikey`, `x-api-key`, `partner_token`, `sig`. So a
// second, GENERIC pass matches credential-shaped parameter names with an
// optional prefix run (`[\w-]*[_-]`), which is what catches `access_key` and
// `x-api-key` where a `\b`-anchored bare `key` cannot (an underscore is a word
// character, so `\bkey` never matches inside `access_key`).
//
// OVER-REDACTION IS THE CORRECT FAILURE MODE HERE. Everything this touches is
// already an error string bound for an admin-readable column; losing a
// diagnostic parameter name costs a little context, leaking a live key costs
// the account.
const GENERIC_SECRET_RE_SRC = '(?:[\\w-]*[_-])?(?:api_?key|key|token|secret|password|passwd|auth|signature|sig)';
const SECRET_KEYS_RE = `${SECRET_KEYS.join('|')}|${GENERIC_SECRET_RE_SRC}`;
// Pass 1 = URL/query form (`key=VALUE`, value runs to a query/JSON delimiter).
// Pass 2 = JSON/quoted form (`"key":"VALUE"`, `key: VALUE`).
// Two passes rather than one union because the two forms terminate on
// DIFFERENT delimiter sets — a single character class either eats past the `&`
// of the next query param or stops short inside a JSON string. Both passes are
// idempotent, so redacting an already-redacted string is a no-op.
const REDACT_URL_RE = new RegExp(`\\b(${SECRET_KEYS_RE})=[^&\\s"'}\\]]*`, 'gi');
// NB the `&` in the pass-2 terminator set is load-bearing: without it, pass 2
// runs over pass 1's own output and swallows the REST OF THE QUERY STRING
// (`refresh_token=[REDACTED]&z=1` → `refresh_token=[REDACTED]`), destroying
// diagnostic context. Caught by the R8 regression case.
const REDACT_JSON_RE = new RegExp(`("?\\b(?:${SECRET_KEYS_RE})"?\\s*[:=]\\s*"?)[^",}\\s&]*`, 'gi');
export function redactTokens(s) {
  return String(s)
    .replace(REDACT_URL_RE, '$1=[REDACTED]')
    .replace(REDACT_JSON_RE, '$1[REDACTED]');
}

// Review M1 (GATING): STRIP ANY URL WHOLESALE before a string is persisted.
//
// Key-anchored redaction is necessary but NOT sufficient for an operator's own
// postback URL, and the counter-example is the MGID preset shape:
//   https://a.mgid.com/postback/<POSTBACK_ID>?c=…
// The credential is a PATH SEGMENT. There is no `key=` to anchor on, so every
// key-based rule in this file walks straight past it. And postback trackers
// routinely ECHO THE REQUEST URL in their error bodies ("bad request: <url>"),
// which is how that path segment reaches lb_tracking_events.error.
//
// The only rule that holds for a URL an operator authored — whose credential
// can be in the path, the query, the fragment or the userinfo — is to persist
// no URL at all. A URL is never the diagnostic anyway: the operator already
// knows what they typed, and the test-fire surface hands it back to them
// verbatim. What they need out of an error is the STATUS and the partner's
// PROSE, both of which survive this.
//
// Applied to the persisted string only — NOT inside redactTokens(), which is
// separately exercised on real URLs by the google-adapter/delivery-patches
// regressions and must keep returning a URL with its secrets masked.
const URL_LIKE_RE = /[a-z][a-z0-9+.-]*:\/\/[^\s"'<>)\]}]*/gi;
export function stripUrls(s) {
  return String(s).replace(URL_LIKE_RE, '[url-redacted]');
}

// The single chokepoint every persisted delivery error passes through
// (lb_tracking_events.error, lb_postback_queue.last_error). Order matters:
// strip URLs FIRST — a credential inside one is gone before any key rule has
// to be clever about it — then key-redact what is left (a JSON body can carry
// `"api_key":"…"` outside a URL), then bound the excerpt at 200 chars.
const ERROR_EXCERPT_MAX = 200;
export function sanitizeForPersist(s) {
  return redactTokens(stripUrls(String(s))).slice(0, ERROR_EXCERPT_MAX);
}

export function errOf(res) {
  const r = res || {};
  // Redact the error STRING too, not just the body: a transport error message
  // is the other path a URL (and therefore a query secret) could ride out on.
  if (r.error) return sanitizeForPersist(r.error);
  const bodyStr = r.body == null ? '' : (typeof r.body === 'string' ? r.body : (() => { try { return JSON.stringify(r.body); } catch { return String(r.body); } })());
  const safeBody = bodyStr ? sanitizeForPersist(bodyStr) : '';
  if (Number.isInteger(r.status)) return `http_${r.status}${safeBody ? `: ${safeBody}` : ''}`;
  return safeBody || 'unknown_error';
}

// True when the platform rejected THIS event's payload (nothing matchable),
// as opposed to the endpoint being unhealthy. These must NOT open the breaker.
export function payloadRejected(res) {
  const r = res || {};
  if (r.error === 'no_identity') return true;
  const body = r.body;
  if (!body || typeof body !== 'object') return false;
  try {
    const err = body.error;
    if (err && typeof err === 'object') {
      const sub = err.error_subcode;
      if (String(sub) === '2804050') return true; // Meta unmatchable
    }
    if (String(body.status || '').toUpperCase() === 'INVALID') {
      const codes = body.errors && body.errors.codes;
      if (Array.isArray(codes) && codes.some((c) => String(c) === '507')) return true; // Snap
    }
    if (String(body.code || '') === '953') return true; // Pinterest
    // GA4 MP debug endpoint (GA4_MP_DEBUG=1): a 200 carrying validationMessages
    // means THIS payload was rejected — the endpoint itself is healthy, so it
    // must not touch the breaker.
    if (Array.isArray(body.validationMessages) && body.validationMessages.length) return true;
  } catch { return false; }
  return false;
}

// Whether a failed send is worth queueing. Network/5xx/429 retry; hard 4xx and
// payload rejections never heal on their own.
export function retryable(res) {
  const err = errOf(res);
  if (startsWithAny(err, SOFT_PREFIXES)) return true;
  if (HARD_ERRORS.has(err) || startsWithAny(err, HARD_PREFIXES)) return false;
  if (payloadRejected(res)) return false;
  const status = (res || {}).status;
  // Review LOW #10: a 3xx is TERMINAL. We send with redirect:'manual' on
  // purpose (a redirect would walk a validated host to an unvalidated one, and
  // for GA4 would hand the query secret to the redirect target), so a 3xx means
  // the configured endpoint is wrong — retrying the same URL cannot fix that.
  if (Number.isInteger(status) && status >= 300 && status < 400) return false;
  if (Number.isInteger(status) && status >= 400 && status < 500 && status !== 408 && status !== 429) {
    return false;
  }
  return true;
}

// ── circuit breaker ──────────────────────────────────────────────────────────
export async function breakerOpen(scopeId) {
  const rows = await pgQuery(
    `SELECT open_until FROM lb_postback_breakers WHERE scope_id = $1 AND open_until > NOW()`,
    [scopeId]
  );
  return rows.length ? rows[0].open_until : null;
}

// Track consecutive failures per endpoint; open at BREAKER_FAILS. A success
// resets. Per-event payload rejections call this with ok=null → no-op.
export async function breakerRecord(funnelId, scopeId, ok) {
  if (ok === null) return; // payload rejection — endpoint says nothing
  if (ok) {
    await pgQuery(
      `INSERT INTO lb_postback_breakers (scope_id, funnel_id, fails, open_until, updated_at)
       VALUES ($1, $2, 0, NULL, NOW())
       ON CONFLICT (scope_id) DO UPDATE SET fails = 0, open_until = NULL, updated_at = NOW()`,
      [scopeId, String(funnelId || '')]
    );
    return;
  }
  const rows = await pgQuery(
    `INSERT INTO lb_postback_breakers (scope_id, funnel_id, fails, updated_at)
     VALUES ($1, $2, 1, NOW())
     ON CONFLICT (scope_id) DO UPDATE SET fails = lb_postback_breakers.fails + 1, updated_at = NOW()
     RETURNING fails`,
    [scopeId, String(funnelId || '')]
  );
  if ((rows[0]?.fails || 0) >= BREAKER_FAILS) {
    await pgQuery(
      `UPDATE lb_postback_breakers
       SET open_until = NOW() + INTERVAL '${BREAKER_COOLDOWN_S} seconds', updated_at = NOW()
       WHERE scope_id = $1`,
      [scopeId]
    );
  }
}

// ── the actual HTTP send ─────────────────────────────────────────────────────
// Resolves the endpoint, POSTs the rendered event, classifies the result.
// SSRF posture: https-only in production; http allowed only for localhost in
// dev/test (mirrors the reference's SSRF guard intent). Test override via
// TRACKING_RELAY_OVERRIDE_URL so verification can point the relay at a 500.
// Meta Graph API version for the default CAPI endpoint. v19.0 (the old
// hardcode) reaches end-of-support in Aug-2026 — the default now tracks a
// supported release, and config.graph_version is a per-pixel override for
// pinning/rollback. Sanitized: this value lands in a URL, so anything that
// isn't a plain vNN.N falls back to the default.
const GRAPH_VERSION_DEFAULT = 'v23.0';
export function graphVersion(cfg) {
  const v = String((cfg || {}).graph_version || '').trim();
  return /^v\d{1,3}\.\d{1,3}$/.test(v) ? v : GRAPH_VERSION_DEFAULT;
}

export function resolveEndpoint(pixel) {  // exported for the delivery-patches harness
  const override = process.env.TRACKING_RELAY_OVERRIDE_URL || '';
  if (override) return override;
  const cfg = pixel.config || {};
  if (cfg.capi_endpoint) return String(cfg.capi_endpoint);
  // Faithful default per kind (Meta CAPI); a real capi_token is required at
  // go-live. With no endpoint AND no token this returns '' → 'not_configured'.
  if (pixel.kind === 'meta_pixel' && cfg.capi_token) {
    return `https://graph.facebook.com/${graphVersion(cfg)}/${encodeURIComponent(pixel.pixel_id)}/events`;
  }
  return '';
}

// A stored secret is EITHER encrypted at rest ('gcm1:' — written by the
// trackingAdmin network CRUD via the gatewayConfigs pattern) OR legacy
// plaintext (rows that predate the write surface). Decrypt only the former;
// pass the latter through unchanged. Throws on a bad ciphertext/key — the
// caller maps that to a retryable result so fixing CHECKOUT_CREDS_KEY heals
// the queued backlog (queue rows re-read the pixel at send time, DECISIONS
// #12). The secret value itself is never logged in any branch.
function resolveSecret(pixel, field) {
  const raw = String((pixel.config || {})[field] || '');
  if (!raw) return '';
  return raw.startsWith('gcm1:') ? decryptSecret(raw) : raw;
}
const resolveToken = (pixel) => resolveSecret(pixel, 'capi_token');

// Hostnames that must never be reachable, whatever they resolve to.
const SSRF_HOST_DENY = new Set([
  'localhost', 'metadata', 'metadata.google.internal',
  'instance-data', 'metadata.goog',
]);

// True when EVERY resolved address is a public unicast address.
function isPublicAddress(addr) {
  if (net.isIPv4(addr)) {
    const [a, b] = addr.split('.').map(Number);
    if (a === 10 || a === 127 || a === 0) return false;             // private / loopback / unspecified
    if (a === 172 && b >= 16 && b <= 31) return false;              // private
    if (a === 192 && b === 168) return false;                       // private
    if (a === 169 && b === 254) return false;                       // link-local (cloud metadata)
    if (a === 100 && b >= 64 && b <= 127) return false;             // CGNAT
    if (a >= 224) return false;                                     // multicast / reserved
    return true;
  }
  if (net.isIPv6(addr)) {
    const x = addr.toLowerCase();
    if (x === '::' || x === '::1') return false;                    // unspecified / loopback
    if (x.startsWith('fe80') || x.startsWith('fc') || x.startsWith('fd')) return false; // link-local / ULA
    if (x.startsWith('ff')) return false;                           // multicast
    // IPv4-mapped must be judged as IPv4. WHATWG URL canonicalizes
    // ::ffff:169.254.169.254 into HEX form (::ffff:a9fe:a9fe), so match both —
    // the dotted form alone is a bypass (caught by the regression test).
    const dotted = x.match(/::ffff:(\d+\.\d+\.\d+\.\d+)$/);
    if (dotted) return isPublicAddress(dotted[1]);
    const hex = x.match(/^::ffff:([0-9a-f]{1,4}):([0-9a-f]{1,4})$/);
    if (hex) {
      const n = (parseInt(hex[1], 16) << 16) | parseInt(hex[2], 16);
      const v4 = [(n >>> 24) & 255, (n >>> 16) & 255, (n >>> 8) & 255, n & 255].join('.');
      return isPublicAddress(v4);
    }
    return true;
  }
  return false;
}

// DECISION #12: the endpoint is operator-supplied config, so it must be
// re-validated AT SEND TIME, not only at write time — and a scheme check alone
// is not validation. `https://169.254.169.254/...` is a valid https URL that
// reads cloud instance credentials. Resolve the host and refuse if ANY answer
// is a private/loopback/link-local address. Fail CLOSED on a resolution error.
export async function endpointAllowed(url) {  // exported for the SSRF regression test
  let u;
  try { u = new URL(url); } catch { return 'scheme'; }
  const host = u.hostname.toLowerCase().replace(/^\[|\]$/g, '');
  if (u.protocol === 'http:') {
    // Only a loopback dev relay may be plaintext, and never in production.
    const devLoopback = process.env.NODE_ENV !== 'production'
      && /^(localhost|127\.0\.0\.1|::1)$/.test(host);
    return devLoopback ? true : 'scheme';
  }
  if (u.protocol !== 'https:') return 'scheme';
  if (SSRF_HOST_DENY.has(host)) return 'blocked_host';
  if (net.isIP(host)) return isPublicAddress(host) ? true : 'blocked_host';
  let answers;
  try {
    answers = await dns.lookup(host, { all: true, verbatim: true });
  } catch {
    // Fail closed, but as a TRANSIENT: a DNS wobble must not dead-letter a
    // day of conversions (SOFT_PREFIXES re-queues this one).
    return 'dns_resolution_failed';
  }
  if (!answers.length) return 'dns_resolution_failed';
  return answers.every((a) => isPublicAddress(a.address)) ? true : 'blocked_host';
}

// The one place an outbound POST happens. Returns a result object, never
// throws, and NEVER puts the request URL into the result: `url` may carry a
// query secret (GA4 MP) and every field of this object can end up in
// lb_tracking_events.error / lb_postback_queue.last_error.
async function postJson(url, { headers = {}, body, timeoutMs = 6000, method = 'POST', rawText = false } = {}) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  if (timer.unref) timer.unref();
  try {
    // `redirect: 'manual'` stops a 302 from walking the validated host to an
    // unvalidated one (the reference's guard has exactly that hole) — which
    // for GA4 would also hand the query secret to the redirect target.
    // A GET carries NO body and NO Content-Type (fetch rejects a GET with a
    // body); the custom-postback adapter is the only caller that uses it.
    const isGet = method === 'GET';
    const resp = await fetch(url, {
      method,
      headers: isGet ? { ...headers } : { 'Content-Type': 'application/json', ...headers },
      ...(isGet ? {} : { body }),
      redirect: 'manual',
      signal: controller.signal,
    });
    // rawText: postback trackers answer `1` / `OK` / `<html>…`, not JSON, so
    // resp.json() throws and the operator sees an empty body on a test fire.
    // The slice is the same 200-char bound errOf applies, taken BEFORE the
    // value can reach any persisted field.
    let parsed = null;
    if (rawText) {
      let text = '';
      try { text = await resp.text(); } catch { text = ''; }
      parsed = { raw: String(text || '').slice(0, 200) };
    } else {
      try { parsed = await resp.json(); } catch { parsed = null; }
    }
    if (resp.ok) return { ok: true, status: resp.status, body: parsed };
    return { ok: false, status: resp.status, body: parsed };
  } catch (err) {
    // Network error / timeout / DNS — a soft, retryable failure. The message
    // is redacted on the way out: an undici cause can quote the request target.
    const msg = redactTokens(String(err && err.message || err));
    if (/getaddrinfo|EAI_AGAIN|dns/i.test(msg)) return { ok: false, error: 'unsafe_url:dns_resolution_failed' };
    return { ok: false, error: `network:${msg.slice(0, 120)}` };
  } finally {
    clearTimeout(timer);
  }
}

async function httpSend(url, token, payload, { timeoutMs = 6000 } = {}) {
  // The CAPI token goes in a HEADER, never the URL: a request line is logged
  // by every proxy it crosses, and if an SSRF ever slipped past the guard the
  // token would be handed to whatever answered. Meta accepts the token in the
  // body for /events, so send it there rather than as a query param.
  return postJson(url, {
    headers: token ? { Authorization: `Bearer ${token}` } : {},
    body: JSON.stringify(token ? { ...payload, access_token: token } : payload),
    timeoutMs,
  });
}

// ── Meta CAPI sender ─────────────────────────────────────────────────────────
async function sendMetaPixel(pixel, envelope) {
  const url = resolveEndpoint(pixel);
  if (!url) return { ok: false, error: 'not_configured' };
  const guard = await endpointAllowed(url);
  if (guard !== true) return { ok: false, error: `unsafe_url:${guard}` };
  let token;
  try {
    token = resolveToken(pixel);
  } catch {
    // Wrong/rotated CHECKOUT_CREDS_KEY or corrupt ciphertext. Deliberately a
    // RETRYABLE error (not in HARD_ERRORS): the operator fixing the key heals
    // the backlog because queued rows re-read the pixel at send time. The
    // ciphertext and the error detail are never logged.
    return { ok: false, error: 'token_decrypt_failed' };
  }
  const payload = {
    data: [{
      event_name: envelope.event_name,
      event_id: envelope.event_id,
      event_time: Math.floor(Date.now() / 1000),
      action_source: 'website',
      event_source_url: envelope.event_source_url || undefined,
      user_data: envelope.user_data || {},
      custom_data: envelope.custom_data || {},
    }],
    ...(( pixel.config || {}).test_event_code ? { test_event_code: pixel.config.test_event_code } : {}),
  };
  return httpSend(url, token, payload, {});
}

// ── GA4 Measurement Protocol sender ─────────────────────────────────────────
// NOTE ON THE ENDPOINT: the MP collection endpoint is
// https://www.google-analytics.com/mp/collect (validation twin:
// /debug/mp/collect). It is NOT /g/collect — that is the gtag BROWSER
// collection path, which takes url-encoded gtag params, not an MP JSON body,
// and would silently accept-and-discard our payload.
const GA4_MP_ENDPOINT = 'https://www.google-analytics.com/mp/collect';
const GA4_MP_DEBUG_ENDPOINT = 'https://www.google-analytics.com/debug/mp/collect';

// Review HIGH #3b + LOW #11: the override is operator config, so it is parsed
// ONCE at module load. A malformed value used to throw inside the sender on
// every send — and a throw in the drain's per-row body killed the whole tick.
// Bad value ⇒ log loudly and IGNORE (fall back to the real endpoint); a value
// set in production is a loud boot log, because it silently redirects live
// conversions away from Google.
const GA4_MP_OVERRIDE = (() => {
  const raw = String(process.env.GA4_MP_OVERRIDE_URL || '').trim();
  if (!raw) return '';
  try {
    const u = new URL(raw);
    if (u.protocol !== 'http:' && u.protocol !== 'https:') throw new Error('bad_scheme');
    if (process.env.NODE_ENV === 'production') {
      console.warn(`[tracking] GA4_MP_OVERRIDE_URL IS SET IN PRODUCTION — every GA4 conversion is being sent to ${u.origin} instead of Google. Unset it unless this is deliberate.`);
    }
    return raw;
  } catch {
    console.error('[tracking] GA4_MP_OVERRIDE_URL is not a valid http(s) URL — IGNORING it and using the real Measurement Protocol endpoint.');
    return '';
  }
})();

// Review HIGH #1b: /debug/mp/collect VALIDATES but does NOT INGEST. Enabling it
// against a live funnel silently destroys conversions, so it is refused outright
// in production. Read at CALL time (same idiom as trackingRuntime.defaultConsent
// — rollback is unsetting the var), with a one-shot loud refusal log.
let ga4DebugRefusalLogged = false;
export function ga4DebugActive() {
  if (String(process.env.GA4_MP_DEBUG || '') !== '1') return false;
  if (process.env.NODE_ENV === 'production') {
    if (!ga4DebugRefusalLogged) {
      ga4DebugRefusalLogged = true;
      console.error('[tracking] GA4_MP_DEBUG=1 is REFUSED in production: the debug endpoint validates payloads but INGESTS NOTHING, so honouring it would silently destroy live conversions. Treating it as OFF.');
    }
    return false;
  }
  return true;
}

// Our event vocabulary is Meta-cased (Purchase, PageView, …); GA4's is
// lower_snake and its recommended-event names differ outright. The mapping
// lives HERE, in the sender, so callers (firePurchaseConversion et al.) keep
// emitting exactly one event name for every network.
const GA4_EVENT_NAMES = {
  Purchase: 'purchase',
  PageView: 'page_view',
  ViewContent: 'view_item',
  AddToCart: 'add_to_cart',
  InitiateCheckout: 'begin_checkout',
  AddPaymentInfo: 'add_payment_info',
  Lead: 'generate_lead',
  CompleteRegistration: 'sign_up',
  UpsellView: 'view_item',
};
export function ga4EventName(name) {
  const n = String(name || '').trim();
  if (GA4_EVENT_NAMES[n]) return GA4_EVENT_NAMES[n];
  // Unknown names degrade to a legal GA4 custom-event name: lower_snake,
  // alphanumeric+underscore, must not start with a digit, max 40 chars.
  const snake = n.replace(/([a-z0-9])([A-Z])/g, '$1_$2').toLowerCase()
    .replace(/[^a-z0-9_]+/g, '_').replace(/^_+|_+$/g, '').slice(0, 40);
  return /^[a-z]/.test(snake) ? snake : `evt_${snake}`.slice(0, 40);
}

// GA4 requires a client_id on every MP hit.
//
// DECISION — WHAT WE SEND, AND WHAT IT IS NOT: the honest source would be the
// browser's _ga cookie client id, but this branch ships NO gtag/GTM loader, so
// that value does not exist server-side. We derive a STABLE, PSEUDONYMOUS id
// and hash it into GA4's `NNNN.NNNN` shape. It is deterministic (a retry or
// redelivery of the same event reuses it, so GA4 sees one user, not many), it
// carries no PII, it is not reversible, and it will NOT join to a browser
// session in GA4 until the GTM phase supplies the real _ga client id.
//
// SEED PRECEDENCE, and why each rung exists:
//   1. envelope.vid — the server-read visitor id. NOT populated today (the
//      envelope contract lives in trackingService, outside this change's
//      fence); read first so that threading it through is a one-line change
//      there with NO further change here. See the handoff note.
//   2. custom_data.order_id with any '_u_<charge>' suffix STRIPPED (review
//      MEDIUM #5): an upsell must land on the SAME GA4 user/session as the
//      parent purchase, and the upsell order_id is `<session>_u_<charge>`.
//      transaction_id still distinguishes the two conversions.
//   3. event_id — the fallback.
//
// SECURITY (review MEDIUM #4): for CLIENT-RELAYED events the whole envelope is
// attacker-supplied, so custom_data.order_id is NOT trusted — a forged beacon
// could otherwise name a real buyer's session and graft itself onto that
// buyer's GA4 user. Relayed events (event_id namespaced 'cl_' by
// trackingService) seed ONLY from the namespaced event_id, whose prefix cannot
// collide with the server-side order-id space.
// `<session>_u_<chargeRowId>`; charge row ids themselves contain underscores
// ('uc_w4'), so strip from the FIRST '_u_' to the end. Session ids are
// 'co_<hex>' and can never contain '_u_', so this cannot over-strip a main
// purchase's order_id.
const UPSELL_SUFFIX_RE = /_u_.*$/;
export function ga4ClientId(envelope) {
  const env = envelope || {};
  const eventId = String(env.event_id || '').trim();
  const vid = String(env.vid || '').trim();
  let seed = '';
  if (vid) {
    seed = `vid:${vid}`;
  } else if (eventId.startsWith('cl_')) {
    seed = eventId;                                   // relayed ⇒ never trust custom_data
  } else {
    const orderId = String((env.custom_data || {}).order_id || '').trim();
    seed = orderId ? orderId.replace(UPSELL_SUFFIX_RE, '') : eventId;
  }
  if (!seed) return '';
  const h = crypto.createHash('sha256').update(`ga4cid:${seed}`).digest();
  return `${h.readUInt32BE(0)}.${h.readUInt32BE(4)}`;
}

// ⚠️⚠️ THE ONE SANCTIONED SECRET-IN-A-URL IN THIS CODEBASE ⚠️⚠️
// House rule: credentials go in headers, never in a URL. GA4's Measurement
// Protocol has NO header form — `api_secret` is only accepted as a query
// parameter, and there is no alternative transport for MP. So the exception is
// isolated to THIS function and these are the compensating controls:
//   • the returned URL is passed to fetch and to endpointAllowed and NOWHERE
//     else — it is never returned to a caller, never logged, never stored;
//   • postJson never copies the URL into its result object;
//   • redactTokens() masks `api_secret` in every string that can reach
//     lb_tracking_events.error / lb_postback_queue.last_error, so an endpoint
//     that ECHOES the request URI still cannot persist the secret;
//   • the SSRF guard runs on the built URL, so the secret can only ever be
//     handed to a public host over https (or a loopback dev relay).
// If you add a log line anywhere near this function, log the measurement_id,
// never the URL.
export function ga4CollectUrl(measurementId, apiSecret) {
  const base = GA4_MP_OVERRIDE || (ga4DebugActive() ? GA4_MP_DEBUG_ENDPOINT : GA4_MP_ENDPOINT);
  const u = new URL(base);
  u.searchParams.set('measurement_id', String(measurementId));
  u.searchParams.set('api_secret', String(apiSecret));
  return u.toString();
}

async function sendGa4(pixel, envelope) {
  const measurementId = String(pixel.pixel_id || '').trim();
  if (!measurementId) return { ok: false, error: 'not_configured' };
  let apiSecret;
  try {
    apiSecret = resolveSecret(pixel, 'api_secret');
  } catch {
    return { ok: false, error: 'token_decrypt_failed' }; // retryable, healable
  }
  if (!apiSecret) return { ok: false, error: 'not_configured' };
  const clientId = ga4ClientId(envelope);
  if (!clientId) return { ok: false, error: 'no_client_id' };

  // Review MEDIUM #4: custom_data can arrive from a CLIENT BEACON, so every
  // field is validated here rather than trusted. GA4 rejects malformed params
  // BEHIND its 204, which means a bad value is invisible to our counters — an
  // omitted param is strictly better than a rejected hit.
  const cd = (envelope.custom_data && typeof envelope.custom_data === 'object') ? envelope.custom_data : {};
  const value = Number(cd.value);
  const currency = String(cd.currency || '').toUpperCase();
  const params = {
    // GA4 dedupes purchases on transaction_id CLIENT-SIDE OF THEIR PIPELINE,
    // with a window we do not control and cannot observe. It is a courtesy,
    // not the guarantee: OUR guarantee stays the lb_tracking_sent
    // (pixel_id, event_id) claim in deliverToPixel, which is per pixel row and
    // fires exactly once whatever GA4 does with the id.
    transaction_id: String(envelope.event_id || ''),
    // NaN / Infinity / null / '' are OMITTED, never sent as null. An explicit
    // 0 is legitimate and survives.
    ...(Number.isFinite(value) ? { value } : {}),
    ...(/^[A-Z]{3}$/.test(currency) ? { currency } : {}),
    // Without engagement_time_msec + session_id an MP hit is accepted but does
    // not surface in realtime/session-scoped reports.
    engagement_time_msec: 1,
    session_id: clientId.split('.')[0],
    // NB: there is deliberately NO `items` passthrough. Nothing in this system
    // produces a GA4-shaped items[] (customData is {value, currency, order_id}),
    // so the only way one could appear is a forged beacon — a raw passthrough
    // would be an unvalidated attacker-controlled array on the wire.
  };

  const payload = {
    client_id: clientId,
    timestamp_micros: String(Date.now() * 1000),
    non_personalized_ads: false,
    events: [{ name: ga4EventName(envelope.event_name), params }],
  };

  const url = ga4CollectUrl(measurementId, apiSecret);
  const guard = await endpointAllowed(url);
  if (guard !== true) return { ok: false, error: `unsafe_url:${guard}` };
  // HONEST COUNTER SEMANTICS: MP answers 204 No Content to everything it
  // accepts — no event id, no per-event validation, no way to tell a recorded
  // conversion from a silently-dropped one. A 2xx here means "the endpoint
  // accepted the hit", which is exactly what status='sent' records; it does NOT
  // mean GA4 reported it. Payload correctness is proven against the debug twin
  // (GA4_MP_DEBUG=1 → /debug/mp/collect, whose validationMessages are read as a
  // per-event payload rejection, not an endpoint fault).
  const res = await postJson(url, { body: JSON.stringify(payload) });
  // The debug twin answers 200 even when it REJECTS the payload — the verdict
  // is in validationMessages, so a bare `resp.ok` would score a rejected event
  // as sent. Demote it to a failure; payloadRejected() then classifies it as a
  // per-event rejection (dead-letters in one pass, breaker untouched).
  if (res.ok && res.body && Array.isArray(res.body.validationMessages) && res.body.validationMessages.length) {
    return { ok: false, status: res.status, body: res.body };
  }
  return res;
}

// ── CUSTOM S2S postback sender (operator-defined template) ───────────────────
// The generic adapter: render the operator's {macro} template against this
// event, re-validate the RESULT through the same SSRF guard every other sender
// uses, and fire it GET or POST.
//
// ⚠️ THE RENDERED URL IS TREATED AS A CREDENTIAL. Operators embed postback
// secrets in these templates (`…/pb?key=SECRET&cid={click_id}` is the shape
// half the tracker industry ships). So:
//   • the url is passed to endpointAllowed and to postJson and NOWHERE else;
//   • postJson never copies a url into its result, so it cannot reach
//     lb_tracking_events.error / lb_postback_queue.last_error;
//   • nothing in this function logs, and the returned result carries only a
//     status code and a 200-char response slice.
// The ONE surface that returns the rendered url is the authed test-fire
// endpoint, which hands the operator back their own text and persists nothing.
//
// The template is validated at SAVE time too (validateTemplateShape refuses a
// macro anywhere in the authority, so the host cannot be steered by an inbound
// click id) — this is the second of the two checks, and it is the one that
// resolves DNS.
// ── B1: WHICH click id does THIS network get? ───────────────────────────────
// The bug the seam audit found: the envelope used to carry ONE click id,
// picked by `Object.values(vault)[0]` upstream — alphabetical order. A funnel
// whose visitor arrived with both an fbclid and a tblci sent Taboola a postback
// labelled `click-id=` … carrying the META fbclid, because 'fbclid' sorts
// before 'ttclid'. The postback is accepted, matches nothing, and the operator
// sees a network that "works" and never converts.
//
// A click id is NETWORK-SCOPED. It is only meaningful to the network that
// issued it, so the ONLY correct source is this network's own configured
// parameter. When the vault has no id under that parameter, the honest answer
// is EMPTY — never another network's token. An empty `{click_id}` produces a
// postback the network ignores; a WRONG one produces a postback it silently
// mis-attributes, which is strictly worse and invisible.
//
// The single-value fallback survives only where there is NO vault at all
// (test-fire, and any caller that has not threaded one): with nothing to
// choose between, there is nothing to choose wrongly.
export function selectClickId(cfg, envelope) {
  const env = envelope || {};
  const vault = (env.click_ids && typeof env.click_ids === 'object' && !Array.isArray(env.click_ids))
    ? env.click_ids : null;
  const param = String((cfg || {}).click_id_param || '').toLowerCase();
  if (vault && Object.keys(vault).length) {
    // A configured parameter selects exactly its own id. No parameter means the
    // operator never told us which token this network speaks, so only the
    // explicitly-generic `click_id` key is eligible — never a platform token.
    const picked = param ? vault[param] : vault.click_id;
    return picked == null ? '' : String(picked);
  }
  const ud = (env.user_data && typeof env.user_data === 'object') ? env.user_data : {};
  const cd = (env.custom_data && typeof env.custom_data === 'object') ? env.custom_data : {};
  return String(ud.click_id || cd.click_id || '');
}

// ── B2: custom_data on a CLIENT-RELAYED event is attacker-supplied ──────────
// sendGa4 validates every custom_data field for exactly this reason and the
// custom sender validated NOTHING — so a forged /track/collect beacon could
// drive an operator's partner postback with a payout of its choosing.
//
// ALLOW-LIST, not deny-list, and every field bounded:
//   value      finite, 0 … MAX_POSTBACK_VALUE (postbackContext.money re-checks)
//   currency   ISO-4217 shape only
//   order_id   bounded — and DROPPED ENTIRELY on a relayed event, because a
//              beacon naming a real buyer's order id would graft a forged
//              conversion onto that buyer's order in the partner's reporting
//              (the same rule sendGa4 applies to its client_id seed)
//   status     bounded, from a fixed vocabulary
//   subs       string values only, sub1…sub10, bounded
// Anything else a caller invents is discarded rather than passed through.
const CUSTOM_STATUS = new Set(['approved', 'pending', 'refund', 'rejected', 'trial']);
export function sanitizeCustomData(raw, { relayed = false } = {}) {
  const cd = (raw && typeof raw === 'object' && !Array.isArray(raw)) ? raw : {};
  const out = {};
  const n = Number(cd.value);
  if (Number.isFinite(n) && n >= 0 && n <= MAX_POSTBACK_VALUE) out.value = n;
  const cur = String(cd.currency || '').toUpperCase();
  if (/^[A-Z]{3}$/.test(cur)) out.currency = cur;
  if (!relayed) out.order_id = String(cd.order_id == null ? '' : cd.order_id).slice(0, 120);
  const st = String(cd.status || '').toLowerCase();
  if (CUSTOM_STATUS.has(st)) out.status = st;
  const subs = (cd.subs && typeof cd.subs === 'object' && !Array.isArray(cd.subs)) ? cd.subs : null;
  if (subs) {
    const clean = {};
    for (let i = 1; i <= 10; i += 1) {
      const k = `sub${i}`;
      const v = subs[k];
      if (v == null || typeof v === 'object' || typeof v === 'function') continue;
      clean[k] = String(v).slice(0, 200);
    }
    if (Object.keys(clean).length) out.subs = clean;
  }
  return out;
}

export function customPostbackContext(pixel, envelope) {
  const cfg = (pixel || {}).config || {};
  const env = envelope || {};
  const eventName = String(env.event_name || '');
  const relayed = env.source === 'relay';
  const cd = sanitizeCustomData(env.custom_data, { relayed });
  return postbackContext({
    eventName,
    eventId: env.event_id,
    // Network-scoped — see selectClickId. buildUserData carries click_id
    // UNHASHED (it is a platform token, not PII), but the VAULT is the
    // authority whenever one is present.
    clickId: selectClickId(cfg, env),
    clickKey: cfg.click_id_param || '',
    network: cfg.label || pixel.pixel_id || '',
    value: cd.value,
    currency: cd.currency,
    orderId: cd.order_id,
    // Refund is the one event whose status is not 'approved'. An upstream may
    // override it, but only from the fixed vocabulary sanitizeCustomData
    // allows.
    status: cd.status || (eventName === 'Refund' ? 'refund' : 'approved'),
    vid: env.vid,
    // MINOR: this rendered the NETWORK's label, which made `{funnel}` and
    // `{network}` the same string on every postback. It is the funnel's name,
    // threaded from the caller; empty when the caller has none rather than
    // silently substituting something else.
    funnel: env.funnel_name || '',
    funnelId: pixel.funnel_id,
    pageUrl: env.event_source_url,
    // MINOR: sub-ids come from the CLICK VAULT (lb_clicks.subs), threaded by
    // the caller. Before this they only ever existed in the test-fire fixture,
    // so {sub1..10} proved something production could not do.
    subs: cd.subs || env.subs,
  });
}

async function sendCustomNetwork(pixel, envelope) {
  const cfg = (pixel || {}).config || {};
  // A template we could not DECRYPT is not a template we do not HAVE. This is
  // deliberately retryable (not in HARD_ERRORS): the operator fixing
  // CHECKOUT_CREDS_KEY heals the whole queued backlog, because queue rows
  // re-read the row at send time.
  if (cfg.template_decrypt_failed) return { ok: false, error: 'template_decrypt_failed' };
  const template = String(cfg.url_template || '');
  if (!template) return { ok: false, error: 'not_configured' };
  const url = renderPostback(template, customPostbackContext(pixel, envelope));
  const guard = await endpointAllowed(url);
  if (guard !== true) return { ok: false, error: `unsafe_url:${guard}` };
  const method = String(cfg.method || 'GET').toUpperCase() === 'POST' ? 'POST' : 'GET';
  // POST carries the SAME macro context as a JSON body, so a partner that
  // wants a body gets one without a second template to maintain. GET is the
  // tracker default and sends nothing but the rendered query string.
  const body = method === 'POST'
    ? JSON.stringify({ ...customPostbackContext(pixel, envelope) })
    : undefined;
  return postJson(url, { method, body, rawText: true, timeoutMs: 8000 });
}

// Render + fire ONE synthetic postback and return the resolved url alongside
// the result. AUTHED CALLERS ONLY (the admin test-fire route) — this is the
// single function in the delivery layer that ever returns a rendered url.
export async function testFireCustomNetwork(pixel, envelope) {
  const cfg = (pixel || {}).config || {};
  if (cfg.template_decrypt_failed) return { ok: false, error: 'template_decrypt_failed', rendered_url: '' };
  const template = String(cfg.url_template || '');
  if (!template) return { ok: false, error: 'not_configured', rendered_url: '' };
  const url = renderPostback(template, customPostbackContext(pixel, envelope));
  const guard = await endpointAllowed(url);
  if (guard !== true) return { ok: false, error: `unsafe_url:${guard}`, rendered_url: url };
  const method = String(cfg.method || 'GET').toUpperCase() === 'POST' ? 'POST' : 'GET';
  const body = method === 'POST'
    ? JSON.stringify({ ...customPostbackContext(pixel, envelope) })
    : undefined;
  const res = await postJson(url, { method, body, rawText: true, timeoutMs: 8000 });
  return { ...res, rendered_url: url, method };
}

// ── per-kind dispatch ────────────────────────────────────────────────────────
// One adapter per pixel kind. A kind with no entry is REGISTERED BUT NOT WIRED
// (google_ads today): it dead-letters as 'kind_not_wired' in one pass rather
// than silently reporting a send that never happened.
const KIND_SENDERS = {
  meta_pixel: sendMetaPixel,
  ga4: sendGa4,
  // Operator-defined outbound postback template. Its "pixel" is a projection
  // of an lb_custom_networks row (trackingCustomNetworks.asPixel), never an
  // lb_pixels row — see that module's header for why.
  custom: sendCustomNetwork,
};

// Review HIGH #1a: a DRY RUN is a send whose result can never mean "delivered".
// Today the only one is GA4 debug mode: /debug/mp/collect validates the payload
// and INGESTS NOTHING, so scoring it as sent would burn the lb_tracking_sent
// claim and dedupe that conversion away FOREVER — the event would never be
// delivered again, even after the flag is turned off. deliverToPixel therefore
// runs these WITHOUT taking a claim and never records status 'sent'.
// Returns a reason string, or '' when the send is a real one.
export function dryRunReason(pixel) {
  if ((pixel || {}).kind === 'ga4' && ga4DebugActive()) return 'debug_mode_no_ingest';
  return '';
}

// Render + send one event to one pixel's server endpoint. Returns a result
// object (never throws). Does NOT touch lb_tracking_sent — the caller owns the
// idempotency claim.
async function sendToPixel(pixel, envelope) {
  const sender = KIND_SENDERS[(pixel || {}).kind];
  if (!sender) return { ok: false, error: 'kind_not_wired' };
  return sender(pixel, envelope);
}

// ── event log ────────────────────────────────────────────────────────────────
async function logEvent({ funnelId, platform, pixelId, eventName, eventId, status, source, idk, value, error }) {
  try {
    await pgQuery(
      `INSERT INTO lb_tracking_events
         (funnel_id, platform, pixel_id, event_name, event_id, status, source, idk, emq, value, error)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)`,
      [String(funnelId || ''), platform || '', pixelId || '', eventName || '', eventId || '',
        status, source || '', idk || [], emqScore(idk), value == null ? null : Number(value),
        error ? String(error).slice(0, 300) : null]
    );
  } catch (err) {
    console.error('[tracking] event log write failed (non-fatal):', err.message);
  }
}

// ── the queue ────────────────────────────────────────────────────────────────
async function enqueue(funnelId, scopeId, envelope, pixelRowId, lastError) {
  const id = `pbq_${crypto.randomBytes(9).toString('hex')}`;
  await pgQuery(
    `INSERT INTO lb_postback_queue
       (id, funnel_id, scope_id, status, envelope, pixel_row_id, attempts, next_at, last_error, created_at)
     VALUES ($1,$2,$3,'queued',$4,$5,1,NOW() + INTERVAL '${RETRY_DELAYS_S[0]} seconds',$6,NOW())`,
    [id, String(funnelId || ''), scopeId, envelope, pixelRowId || null,
      lastError ? String(lastError).slice(0, 300) : null]
  );
  return id;
}

// Deliver ONE event to ONE pixel, with the idempotency claim + breaker + queue
// rules. Fire-and-forget: returns a status string, never throws.
export async function deliverToPixel({ funnelId, pixel, eventName, eventId, userData, idk, customData, source, eventSourceUrl, clickIds, subs, funnelName }) {
  const scopeId = `${funnelId || ''}:${pixel.id}`;
  const platform = (pixel.kind || '').replace(/_pixel$/, '');
  const value = (customData || {}).value;
  try {
    // DECISIONS #11: an event with NO matchable identity is declined BEFORE
    // sending, as a hard error — and it does NOT touch the breaker. This is
    // the exact case a consent-denied EEA visitor produces.
    if (!Array.isArray(idk) || idk.length === 0) {
      await logEvent({ funnelId, platform, pixelId: pixel.pixel_id, eventName, eventId, status: 'skipped', source, idk: [], value, error: 'no_identity' });
      return 'skipped:no_identity';
    }

    const envelope = {
      event_name: eventName, event_id: eventId,
      user_data: userData || {}, custom_data: customData || {},
      event_source_url: eventSourceUrl || '', idk,
      // Seam audit B1 + minors. The envelope now carries the WHOLE click
      // vault, not one alphabetically-chosen id, so each custom network can
      // select its OWN token (selectClickId); the sub-ids from lb_clicks so
      // {sub1..10} render live rather than only in the test-fire fixture; the
      // funnel's NAME so {funnel} is the funnel and not the network's label;
      // and the SOURCE, because a client-relayed envelope is attacker-supplied
      // and the custom sender has to know that (B2).
      //
      // This object is persisted verbatim into lb_postback_queue.envelope, so
      // a queued retry renders exactly what the inline attempt would have.
      click_ids: (clickIds && typeof clickIds === 'object' && !Array.isArray(clickIds)) ? clickIds : {},
      subs: (subs && typeof subs === 'object' && !Array.isArray(subs)) ? subs : {},
      funnel_name: funnelName || '',
      source: source || '',
      // NB deliberately NOT threading `vid`: it is rung 1 of sendGa4's
      // client_id seed precedence, so populating it here would silently change
      // GA4 identities for every relayed event. That is a GA4 decision, not a
      // seam fix, and it is not in this change's remit. {vid} therefore still
      // renders empty for custom postbacks.
    };

    // Review HIGH #2a: THE DISPATCH CHECK MUST PRECEDE THE CLAIM. The claim key
    // is (pixel_id, event_id) — it is NOT scoped by kind — so a row of an
    // UNWIRED kind that happens to carry the same pixel_id as a wired one would
    // consume the claim and silently suppress the real conversion. A kind with
    // no adapter can never deliver, so it must never take a claim either.
    const sender = KIND_SENDERS[pixel.kind];
    if (!sender) {
      await logEvent({ funnelId, platform, pixelId: pixel.pixel_id, eventName, eventId, status: 'skipped', source, idk, value, error: 'kind_not_wired' });
      return 'dead:kind_not_wired';
    }

    // Review HIGH #1a: same rule for a DRY RUN (GA4 debug mode) — it validates
    // but ingests nothing, so it must not burn the claim. It DOES still send,
    // because getting the validation verdict is the entire point; the result is
    // logged as 'skipped', never 'sent', and the breaker is untouched.
    const dry = dryRunReason(pixel);
    if (dry) {
      const dres = await sendToPixel(pixel, envelope);
      const derr = dres.ok ? dry : `${dry}:${errOf(dres)}`;
      await logEvent({ funnelId, platform, pixelId: pixel.pixel_id, eventName, eventId, status: 'skipped', source, idk, value, error: derr });
      return dres.ok ? 'debug_validated' : `debug_invalid:${errOf(dres)}`;
    }

    // Idempotency CLAIM — the whole mechanism. INSERT wins exactly once across
    // webhook + browser + relay + concurrent replicas; a conflict is a correct
    // no-op. (pixel_id, event_id) is UNIQUE.
    const claim = await pgQuery(
      `INSERT INTO lb_tracking_sent (pixel_id, event_id) VALUES ($1, $2)
       ON CONFLICT (pixel_id, event_id) DO NOTHING RETURNING pixel_id`,
      [pixel.pixel_id, eventId]
    );
    if (!claim.length) {
      // Honest counters: a dedup is an EVENT, not silence. Without this row
      // the summary's deduped_24h undercounts and the dual-rail (webhook +
      // browser + relay) looks like it silently dropped events. status
      // 'deduped' — a correct outcome, never an error.
      await logEvent({ funnelId, platform, pixelId: pixel.pixel_id, eventName, eventId, status: 'deduped', source, idk, value, error: null });
      return 'duplicate';
    }

    // Breaker open → skip the doomed inline attempt, queue directly. A
    // platform outage DELAYS conversions instead of eating them.
    if (await breakerOpen(scopeId)) {
      await enqueue(funnelId, scopeId, envelope, pixel.id, 'breaker_open');
      await logEvent({ funnelId, platform, pixelId: pixel.pixel_id, eventName, eventId, status: 'queued', source, idk, value, error: 'breaker_open' });
      return 'queued:breaker_open';
    }

    const res = await sendToPixel(pixel, envelope);
    if (res.ok) {
      await breakerRecord(funnelId, scopeId, true);
      await logEvent({ funnelId, platform, pixelId: pixel.pixel_id, eventName, eventId, status: 'sent', source, idk, value, error: null });
      return 'sent';
    }
    const err = errOf(res);
    const isPayload = payloadRejected(res);
    // Endpoint failures increment the breaker; per-event payload rejections
    // pass ok=null so they never do (DECISIONS #11).
    await breakerRecord(funnelId, scopeId, isPayload ? null : false);
    if (retryable(res)) {
      await enqueue(funnelId, scopeId, envelope, pixel.id, err);
      await logEvent({ funnelId, platform, pixelId: pixel.pixel_id, eventName, eventId, status: 'queued', source, idk, value, error: err });
      return `queued:${err}`;
    }
    // Hard error / payload rejection → dead-letter in one pass (no queue row).
    await logEvent({ funnelId, platform, pixelId: pixel.pixel_id, eventName, eventId, status: 'skipped', source, idk, value, error: err });
    return `dead:${err}`;
  } catch (err) {
    // Delivery must never throw up the stack (fail-open serving).
    console.error('[tracking] deliverToPixel failed (fail-open):', redactTokens(err.message));
    try { await logEvent({ funnelId, platform, pixelId: pixel.pixel_id, eventName, eventId, status: 'error', source, idk: idk || [], value, error: `internal:${redactTokens(err.message)}` }); } catch { /* */ }
    return 'error';
  }
}

// ── the drain (cron tick) ────────────────────────────────────────────────────
// Atomic queued→sending claim; re-read the pixel; re-send; settle to
// sent/queued(+backoff)/dead. A stale-claim sweep returns dead-worker rows.
async function reclaimStale() {
  await pgQuery(
    `UPDATE lb_postback_queue SET status = 'queued', claimed_at = NULL
     WHERE status = 'sending' AND claimed_at < NOW() - INTERVAL '${STALE_CLAIM_S} seconds'`
  );
}

export async function runDelivery({ limit = 200 } = {}) {
  await ensureTrackingTables();
  await reclaimStale();
  const out = { due: 0, sent: 0, requeued: 0, dead: 0 };
  const due = await pgQuery(
    `SELECT id FROM lb_postback_queue WHERE status = 'queued' AND next_at <= NOW()
     ORDER BY next_at ASC LIMIT $1`,
    [limit]
  );
  out.due = due.length;
  out.errored = 0;
  for (const { id } of due) {
    // Review HIGH #3a: THE PER-ROW BODY IS ISOLATED. The row is already claimed
    // 'sending' at this point, so an escaping throw used to abort the entire
    // tick AND strand this row — the stale-claim sweep only frees it 30 minutes
    // later, whereupon it re-poisons the next tick, forever. One poisoned row
    // must never cost the other 199 their delivery. A throw settles THIS row as
    // dead with a redacted internal error and the loop moves on.
    try {
      await drainOne(id, out);
    } catch (err) {
      const msg = `internal:${redactTokens(String(err && err.message || err))}`.slice(0, 300);
      console.error('[tracking] drain row failed (isolated, row settled):', msg);
      out.errored++;
      try {
        // Deliberately does NOT touch `attempts` — the settle must not depend
        // on any value that could itself be what threw.
        await pgQuery(
          `UPDATE lb_postback_queue SET status = 'dead', claimed_at = NULL, last_error = $2 WHERE id = $1`,
          [id, msg]
        );
      } catch (settleErr) {
        console.error('[tracking] drain row settle ALSO failed:', redactTokens(String(settleErr.message)));
      }
    }
  }
  return out;
}

// Resolve a queue row's delivery TARGET back into a pixel-shaped object.
// Returns an array (0 or 1 rows) so the caller's `pixels.length` checks and
// its 'pixel_gone' branch are unchanged.
//
// Two tables, one queue. lb_pixels holds the named-network rows; a custom S2S
// network is an lb_custom_networks row projected by asPixel. The queue stores
// only the row id, so the re-read must know both — and it MUST be a re-read
// rather than a rendered request stored at enqueue time (DECISIONS #12): a
// template fixed mid-outage has to heal the whole backlog on the next drain,
// exactly as a fixed credential does.
async function loadDeliveryTarget(rowId) {
  const id = String(rowId || '');
  if (!id) return [];
  const rows = await pgQuery(`SELECT * FROM lb_pixels WHERE id = $1`, [id]);
  if (rows.length) return rows;
  // Only ids minted by createNetwork can be custom rows; the prefix check
  // keeps the common (named-network) path to a single query.
  if (!id.startsWith('lbcn_')) return [];
  try {
    const px = await customNetworkPixelById(id);
    return px ? [px] : [];
  } catch (err) {
    // A schema/read failure here must not be read as 'pixel_gone' (which
    // dead-letters the row). Re-throw: runDelivery's per-row isolation settles
    // this ONE row and the tick continues.
    throw new Error(`custom_network_read_failed:${err.message}`);
  }
}

// One queue row: re-read the pixel, re-send, settle. Throws are caught by the
// caller, which settles the row — nothing in here may swallow silently.
async function drainOne(id, out) {
  {
    // Atomic claim: queued → sending. Two drains can't both take the row.
    const claimed = await pgQuery(
      `UPDATE lb_postback_queue SET status = 'sending', claimed_at = NOW()
       WHERE id = $1 AND status = 'queued' RETURNING *`,
      [id]
    );
    if (!claimed.length) return;
    const row = claimed[0];
    // Re-read the pixel at send time (credentials may have been fixed).
    const pixels = await loadDeliveryTarget(row.pixel_row_id);
    // Review HIGH #1a, drain side: the queue must obey the dry-run rule too.
    // A queued conversion drained while GA4_MP_DEBUG is on would otherwise be
    // marked 'done' against an endpoint that ingested NOTHING — the row is
    // gone and the conversion is lost. HOLD it instead (requeue with backoff,
    // no send, no ledger 'sent'): the moment the flag is off it delivers.
    if (pixels.length && dryRunReason(pixels[0])) {
      const delay = RETRY_DELAYS_S[Math.min((row.attempts || 1) - 1, RETRY_DELAYS_S.length - 1)];
      await pgQuery(
        `UPDATE lb_postback_queue
         SET status = 'queued', claimed_at = NULL,
             next_at = NOW() + ($2 || ' seconds')::interval, last_error = $3
         WHERE id = $1`,
        [id, String(delay), 'held:debug_mode_no_ingest']
      );
      out.held = (out.held || 0) + 1;
      return;
    }
    let res;
    if (!pixels.length) res = { ok: false, error: 'pixel_gone' };
    else res = await sendToPixel(pixels[0], row.envelope || {});
    const scopeId = row.scope_id;
    // Review MAJOR #1: a drained retry SETTLES the event, so it must write a
    // ledger row like the inline path does — otherwise after any platform
    // outage the summary shows the backlog as forever-queued even though the
    // drain delivered (or dead-lettered) everything. Carry the ORIGINAL event
    // fields from the queued envelope.
    const env = row.envelope || {};
    const px = pixels.length ? pixels[0] : null;
    const logDrain = (status, error) => logEvent({
      funnelId: row.funnel_id,
      platform: px ? (px.kind || '').replace(/_pixel$/, '') : '',
      pixelId: px ? px.pixel_id : '',
      eventName: env.event_name, eventId: env.event_id,
      status, source: 'drain',
      idk: Array.isArray(env.idk) ? env.idk : [],
      value: (env.custom_data || {}).value, error,
    });
    if (res.ok) {
      await breakerRecord(row.funnel_id, scopeId, true);
      await pgQuery(`UPDATE lb_postback_queue SET status = 'done', last_error = NULL WHERE id = $1`, [id]);
      await logDrain('sent', null);
      out.sent++;
      return;
    }
    const err = errOf(res);
    await breakerRecord(row.funnel_id, scopeId, payloadRejected(res) ? null : false);
    const attempts = (row.attempts || 1) + 1;
    if (!retryable(res) || attempts >= MAX_ATTEMPTS) {
      await pgQuery(`UPDATE lb_postback_queue SET status = 'dead', attempts = $2, last_error = $3 WHERE id = $1`,
        [id, attempts, err.slice(0, 300)]);
      await logDrain('error', err);
      out.dead++;
    } else {
      const delay = RETRY_DELAYS_S[Math.min(attempts - 1, RETRY_DELAYS_S.length - 1)];
      await pgQuery(
        `UPDATE lb_postback_queue
         SET status = 'queued', attempts = $2, claimed_at = NULL,
             next_at = NOW() + ($3 || ' seconds')::interval, last_error = $4
         WHERE id = $1`,
        [id, attempts, String(delay), err.slice(0, 300)]
      );
      out.requeued++;
    }
  }
}

export default {
  deliverToPixel, runDelivery, buildUserData, retryable, payloadRejected,
  breakerOpen, breakerRecord, resolveEndpoint, graphVersion,
  ga4EventName, ga4ClientId, ga4CollectUrl, ga4DebugActive, dryRunReason,
  customPostbackContext, testFireCustomNetwork,
};
