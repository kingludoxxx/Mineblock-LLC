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
import { pgQuery } from '../db/pg.js';
import { ensureTrackingTables } from './trackingSchema.js';
import { emqScore, idkFrom } from './trackingAttribution.js';

// Retry schedule AFTER the failed inline attempt: 1m, 5m, 15m, 1h, 3h, 6h,
// 12h, 24h → dead. Nine total attempts (inline + 8 queued).
const RETRY_DELAYS_S = [60, 300, 900, 3600, 10800, 21600, 43200, 86400];
const MAX_ATTEMPTS = 1 + RETRY_DELAYS_S.length;
const BREAKER_FAILS = 5;         // consecutive failures that open the circuit
const BREAKER_COOLDOWN_S = 900;  // 15 min open
const STALE_CLAIM_S = 1800;      // 'sending' older than this = dead worker

// Terminal errors — retrying can never succeed, dead-letter in ONE pass.
const HARD_ERRORS = new Set(['not_configured', 'no_click_id', 'no_order_id',
  'pixel_gone', 'skipped_window', 'no_identity']);
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
export function errOf(res) {
  const r = res || {};
  if (r.error) return String(r.error);
  const bodyStr = r.body == null ? '' : (typeof r.body === 'string' ? r.body : (() => { try { return JSON.stringify(r.body); } catch { return String(r.body); } })());
  if (Number.isInteger(r.status)) return `http_${r.status}${bodyStr ? `: ${bodyStr.slice(0, 200)}` : ''}`;
  return bodyStr || 'unknown_error';
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
function resolveEndpoint(pixel) {
  const override = process.env.TRACKING_RELAY_OVERRIDE_URL || '';
  if (override) return override;
  const cfg = pixel.config || {};
  if (cfg.capi_endpoint) return String(cfg.capi_endpoint);
  // Faithful default per kind (Meta CAPI); a real capi_token is required at
  // go-live. With no endpoint AND no token this returns '' → 'not_configured'.
  if (pixel.kind === 'meta_pixel' && cfg.capi_token) {
    return `https://graph.facebook.com/v19.0/${encodeURIComponent(pixel.pixel_id)}/events`;
  }
  return '';
}

function endpointAllowed(url) {
  try {
    const u = new URL(url);
    if (u.protocol === 'https:') return true;
    if (u.protocol === 'http:' && /^(localhost|127\.0\.0\.1|\[::1\])$/.test(u.hostname)) {
      return process.env.NODE_ENV !== 'production';
    }
    return false;
  } catch { return false; }
}

async function httpSend(url, token, payload, { timeoutMs = 6000 } = {}) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  if (timer.unref) timer.unref();
  try {
    const target = token ? `${url}${url.includes('?') ? '&' : '?'}access_token=${encodeURIComponent(token)}` : url;
    const resp = await fetch(target, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
      signal: controller.signal,
    });
    let body = null;
    try { body = await resp.json(); } catch { body = null; }
    if (resp.ok) return { ok: true, status: resp.status, body };
    return { ok: false, status: resp.status, body };
  } catch (err) {
    // Network error / timeout / DNS — a soft, retryable failure.
    const msg = String(err && err.message || err);
    if (/getaddrinfo|EAI_AGAIN|dns/i.test(msg)) return { ok: false, error: 'unsafe_url:dns_resolution_failed' };
    return { ok: false, error: `network:${msg.slice(0, 120)}` };
  }
}

// Render + send one event to one pixel's server endpoint. Returns a result
// object (never throws). Does NOT touch lb_tracking_sent — the caller owns the
// idempotency claim.
async function sendToPixel(pixel, envelope) {
  const url = resolveEndpoint(pixel);
  if (!url) return { ok: false, error: 'not_configured' };
  if (!endpointAllowed(url)) return { ok: false, error: 'unsafe_url:scheme_or_host' };
  const token = (pixel.config || {}).capi_token || '';
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
export async function deliverToPixel({ funnelId, pixel, eventName, eventId, userData, idk, customData, source, eventSourceUrl }) {
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

    // Idempotency CLAIM — the whole mechanism. INSERT wins exactly once across
    // webhook + browser + relay + concurrent replicas; a conflict is a correct
    // no-op. (pixel_id, event_id) is UNIQUE.
    const claim = await pgQuery(
      `INSERT INTO lb_tracking_sent (pixel_id, event_id) VALUES ($1, $2)
       ON CONFLICT (pixel_id, event_id) DO NOTHING RETURNING pixel_id`,
      [pixel.pixel_id, eventId]
    );
    if (!claim.length) return 'duplicate';

    const envelope = {
      event_name: eventName, event_id: eventId,
      user_data: userData || {}, custom_data: customData || {},
      event_source_url: eventSourceUrl || '', idk,
    };

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
    console.error('[tracking] deliverToPixel failed (fail-open):', err.message);
    try { await logEvent({ funnelId, platform, pixelId: pixel.pixel_id, eventName, eventId, status: 'error', source, idk: idk || [], value, error: `internal:${err.message}` }); } catch { /* */ }
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
  for (const { id } of due) {
    // Atomic claim: queued → sending. Two drains can't both take the row.
    const claimed = await pgQuery(
      `UPDATE lb_postback_queue SET status = 'sending', claimed_at = NOW()
       WHERE id = $1 AND status = 'queued' RETURNING *`,
      [id]
    );
    if (!claimed.length) continue;
    const row = claimed[0];
    // Re-read the pixel at send time (credentials may have been fixed).
    const pixels = await pgQuery(`SELECT * FROM lb_pixels WHERE id = $1`, [row.pixel_row_id]);
    let res;
    if (!pixels.length) res = { ok: false, error: 'pixel_gone' };
    else res = await sendToPixel(pixels[0], row.envelope || {});
    const scopeId = row.scope_id;
    if (res.ok) {
      await breakerRecord(row.funnel_id, scopeId, true);
      await pgQuery(`UPDATE lb_postback_queue SET status = 'done', last_error = NULL WHERE id = $1`, [id]);
      out.sent++;
      continue;
    }
    const err = errOf(res);
    await breakerRecord(row.funnel_id, scopeId, payloadRejected(res) ? null : false);
    const attempts = (row.attempts || 1) + 1;
    if (!retryable(res) || attempts >= MAX_ATTEMPTS) {
      await pgQuery(`UPDATE lb_postback_queue SET status = 'dead', attempts = $2, last_error = $3 WHERE id = $1`,
        [id, attempts, err.slice(0, 300)]);
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
  return out;
}

export default { deliverToPixel, runDelivery, buildUserData, retryable, payloadRejected, breakerOpen, breakerRecord };
