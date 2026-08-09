// Abandoned-checkout RECOVERY — the lane behind /api/v1/abandoned.
//
// Two populations feed one list, because Puure sells through two front doors:
//   • 'shopify' — Shopify's own abandoned checkouts (crm_abandoned_checkouts,
//     synced by abandonedCheckouts.js). Shopify mints its own recovery URL.
//   • 'funnel'  — our funnel checkout sessions (co_sessions) that captured an
//     email and never settled. These are OURS, so we mint the recovery link.
//
// Everything here is either PURE (classification, token signing, cart shaping —
// harness-covered in server/tests/abandoned/) or a WRITE to the sidecar table
// crm_recovery_meta. Nothing in this file touches the money path: no session
// status is ever mutated, no order is created, no gateway is called.
//
// IDEMPOTENCY is two-layer, copied from klaviyoEvents.js (the house pattern):
//   1. ours   — lb_integration_sends (kind, ref) atomic claim taken BEFORE the
//               network call; released when the send did NOT land.
//   2. vendor — the same ref rides Klaviyo's unique_id.
//
// FIRE-AND-FORGET: sendRecoveryEvent never throws. A Klaviyo outage drops the
// nudge (a released claim lets a later detector sweep re-attempt).
import crypto from 'crypto';
import { pgQuery } from '../db/pg.js';
import { claimSend, releaseSend } from './integrationsSchema.js';
import { getKlaviyoConfig, upsertProfile, trackEvent } from './klaviyoService.js';

const KIND = 'klaviyo';
export const ABANDONED_METRIC = 'Abandoned Checkout';
export const SOURCES = ['funnel', 'shopify'];
export const RECOVERY_STATUSES = ['Not recovered', 'Sent', 'Recovered'];

// Test seam — the harness swaps these to drive the failure paths without a
// network. Production behavior is identical (same as klaviyoEvents._deps).
export const _deps = { upsertProfile, trackEvent, getKlaviyoConfig, claimSend, releaseSend };

// ── pure: config ────────────────────────────────────────────────────────────

// Grace before an unpaid checkout counts as ABANDONED. ABANDON_MINUTES (or the
// funnel-os spelling LB_ABANDON_MINUTES), default 60, clamped to [5, 1440] so a
// typo can neither nudge live shoppers mid-checkout nor mute the lane for weeks.
export function abandonGraceSeconds(env = process.env) {
  const raw = env.ABANDON_MINUTES ?? env.LB_ABANDON_MINUTES ?? '60';
  const mins = parseInt(String(raw).trim(), 10);
  const safe = Number.isFinite(mins) ? mins : 60;
  return Math.max(5, Math.min(safe, 1440)) * 60;
}

// Lookback for the recovered-attribution sweep and the detector.
export function recoveryWindowDays(env = process.env) {
  const raw = env.RECOVERY_WINDOW_DAYS ?? '7';
  const days = parseInt(String(raw).trim(), 10);
  const safe = Number.isFinite(days) ? days : 7;
  return Math.max(1, Math.min(safe, 90));
}

// Signed-link TTL. Two weeks by default — long enough for a 3-email flow.
export function recoveryLinkTtlSeconds(env = process.env) {
  const raw = env.RECOVERY_LINK_TTL_DAYS ?? '14';
  const days = parseInt(String(raw).trim(), 10);
  const safe = Number.isFinite(days) ? days : 14;
  return Math.max(1, Math.min(safe, 60)) * 24 * 3600;
}

export function publicBaseUrl(env = process.env) {
  const raw =
    env.CHECKOUT_PUBLIC_BASE_URL ||
    env.APP_BASE_URL ||
    env.RENDER_EXTERNAL_URL ||
    env.PUBLIC_APP_URL ||
    '';
  return String(raw).trim().replace(/\/+$/, '');
}

// ── pure: jsonb dual-shape read ─────────────────────────────────────────────
// postgres.js hands back a parsed object for jsonb, but rows that travelled
// through a text column (or a harness fixture) arrive as a string. Read BOTH
// shapes; a malformed string degrades to the fallback, never a throw.
export function parseJsonColumn(value, fallback = null) {
  if (value === null || value === undefined) return fallback;
  if (typeof value === 'object') return value;
  if (typeof value !== 'string') return fallback;
  try {
    const parsed = JSON.parse(value);
    return parsed === null || parsed === undefined ? fallback : parsed;
  } catch {
    return fallback;
  }
}

// ── pure: email ─────────────────────────────────────────────────────────────
// Salvage what is deliverable, or return '' — '' means "cannot be nudged", and
// the caller stamps the row so the detector stops re-scanning it forever.
export function sanitizeEmail(raw) {
  if (typeof raw !== 'string') return '';
  const cleaned = raw.replace(/\s+/g, '').trim().toLowerCase();
  if (!cleaned || cleaned.length > 254) return '';
  const at = cleaned.indexOf('@');
  if (at <= 0 || at !== cleaned.lastIndexOf('@')) return '';
  const domain = cleaned.slice(at + 1);
  if (!domain.includes('.') || domain.startsWith('.') || domain.endsWith('.')) return '';
  if (/[^a-z0-9.@!#$%&'*+/=?^_`{|}~-]/.test(cleaned)) return '';
  return cleaned;
}

// ── pure: cart contents ─────────────────────────────────────────────────────
// One normalized cart shape for both populations, so the detail drawer and the
// Klaviyo event properties read the same fields. Never throws on garbage.
export function cartSummary(lineItems, { max = 50 } = {}) {
  const raw = parseJsonColumn(lineItems, []);
  const list = Array.isArray(raw) ? raw : [];
  const items = [];
  let itemCount = 0;
  let subtotal = 0;
  for (const it of list.slice(0, max)) {
    if (!it || typeof it !== 'object') continue;
    const quantity = Math.max(0, Math.trunc(Number(it.quantity) || 0));
    const price = Number.isFinite(Number(it.price)) ? Number(it.price) : 0;
    items.push({
      title: typeof it.title === 'string' ? it.title.slice(0, 200) : '',
      variant_title: typeof it.variant_title === 'string' ? it.variant_title.slice(0, 200) : '',
      variant_id: it.variant_id === undefined || it.variant_id === null ? '' : String(it.variant_id).slice(0, 64),
      product_id: it.product_id === undefined || it.product_id === null ? '' : String(it.product_id).slice(0, 64),
      image: typeof it.image === 'string' ? it.image.slice(0, 500) : '',
      quantity,
      price: Math.round(price * 100) / 100,
      line_total: Math.round(price * quantity * 100) / 100,
    });
    itemCount += quantity;
    subtotal += price * quantity;
  }
  return {
    items,
    item_count: itemCount,
    distinct_items: items.length,
    subtotal: Math.round(subtotal * 100) / 100,
    truncated: list.length > items.length,
  };
}

// ── pure: classification ────────────────────────────────────────────────────
// The single definition of "abandoned", shared by the list, the detector and
// the KPI strip — so the number on the card can never disagree with the rows.
//
// Order matters: settled beats everything (NEVER nudge a payer — a live
// recovery link in a paid buyer's inbox is a double-charge vector), then a
// credited recovery, then the grace window, then deliverability.
export function classifyCheckout(row, opts = {}) {
  const r = row && typeof row === 'object' ? row : {};
  const now = opts.now instanceof Date ? opts.now : new Date(opts.now ?? Date.now());
  const graceSeconds = Number.isFinite(Number(opts.graceSeconds))
    ? Number(opts.graceSeconds)
    : abandonGraceSeconds();
  const recoveryStatus = RECOVERY_STATUSES.includes(opts.recoveryStatus)
    ? opts.recoveryStatus
    : 'Not recovered';

  const settled =
    String(r.status || '').toLowerCase() === 'paid' ||
    Boolean(r.paid_at) ||
    Boolean(r.completed_at) ||
    Boolean(r.gateway_payment_id);
  if (settled) return { state: 'paid', nudgeable: false, reason: 'settled' };

  if (recoveryStatus === 'Recovered') {
    return { state: 'recovered', nudgeable: false, reason: 'credited_recovery' };
  }

  const createdMs = new Date(r.created_at ?? NaN).getTime();
  if (!Number.isFinite(createdMs)) {
    // No usable clock ⇒ we cannot prove the grace elapsed. Fail SAFE: treat it
    // as still active rather than nudging a shopper who is mid-checkout.
    return { state: 'active', nudgeable: false, reason: 'no_created_at' };
  }
  const ageSeconds = (now.getTime() - createdMs) / 1000;
  if (ageSeconds < graceSeconds) {
    return { state: 'active', nudgeable: false, reason: 'within_grace', age_seconds: ageSeconds };
  }

  const email = sanitizeEmail(r.email ?? r.customer_email ?? '');
  if (!email) {
    return { state: 'unreachable', nudgeable: false, reason: 'no_deliverable_email', age_seconds: ageSeconds };
  }
  if (recoveryStatus === 'Sent') {
    return { state: 'abandoned', nudgeable: false, reason: 'already_nudged', age_seconds: ageSeconds, email };
  }
  return { state: 'abandoned', nudgeable: true, reason: 'past_grace', age_seconds: ageSeconds, email };
}

// ── pure: signed recovery links ─────────────────────────────────────────────
// HMAC-SHA256 over a base64url payload — base64url has no '.', so the
// three-part token can never be split wrong by an id that contains dots.
// The token is the ONLY thing that authorizes a cart revival; it carries no
// secret and no PII beyond the opaque row id.

function linkSecret(env = process.env) {
  const raw = env.CHECKOUT_RESUME_SECRET || env.JWT_ACCESS_SECRET || '';
  return crypto.createHash('sha256').update(`puure-resume:${raw}`).digest();
}

const b64u = (buf) => Buffer.from(buf).toString('base64url');

export function signRecoveryToken(source, refId, opts = {}) {
  if (!SOURCES.includes(source)) throw new Error(`unknown recovery source: ${source}`);
  const ref = String(refId ?? '').slice(0, 128);
  if (!ref) throw new Error('recovery token needs a ref id');
  const nowMs = opts.now instanceof Date ? opts.now.getTime() : Number(opts.now ?? Date.now());
  const ttl = Number.isFinite(Number(opts.ttlSeconds))
    ? Number(opts.ttlSeconds)
    : recoveryLinkTtlSeconds(opts.env);
  const exp = Math.floor(nowMs / 1000) + ttl;
  const payload = b64u(JSON.stringify({ v: 1, s: source, r: ref, e: exp }));
  const sig = crypto
    .createHmac('sha256', linkSecret(opts.env))
    .update(payload)
    .digest('base64url')
    .slice(0, 43);
  return { token: `v1.${payload}.${sig}`, expires_at: new Date(exp * 1000).toISOString(), ref, source };
}

// Returns { source, ref, expires_at } for a valid unexpired token, else null.
// Every failure mode collapses to null — a caller can never tell a forged
// signature from an expired one from a malformed blob.
export function verifyRecoveryToken(token, opts = {}) {
  if (typeof token !== 'string' || token.length > 2048) return null;
  const parts = token.split('.');
  if (parts.length !== 3 || parts[0] !== 'v1') return null;
  const [, payload, sig] = parts;
  if (!payload || !sig) return null;
  const good = crypto
    .createHmac('sha256', linkSecret(opts.env))
    .update(payload)
    .digest('base64url')
    .slice(0, 43);
  const a = Buffer.from(sig);
  const b = Buffer.from(good);
  if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) return null;
  let claims;
  try {
    claims = JSON.parse(Buffer.from(payload, 'base64url').toString('utf8'));
  } catch {
    return null;
  }
  if (!claims || typeof claims !== 'object') return null;
  if (claims.v !== 1 || !SOURCES.includes(claims.s) || !claims.r) return null;
  const exp = Number(claims.e);
  if (!Number.isFinite(exp)) return null;
  const nowS = (opts.now instanceof Date ? opts.now.getTime() : Number(opts.now ?? Date.now())) / 1000;
  if (nowS > exp) return null;
  return { source: claims.s, ref: String(claims.r), expires_at: new Date(exp * 1000).toISOString() };
}

// The URL the buyer clicks. The endpoint itself is the INTEGRATOR's to build
// (it revives a cart = money path) — see the contract in the route file header.
export function recoveryLinkUrl(token, { env = process.env } = {}) {
  const base = publicBaseUrl(env);
  const path = `/api/v1/checkout/public/resume/${encodeURIComponent(token)}`;
  return base ? `${base}${path}` : path;
}

// ── pure: the record shape written to crm_recovery_meta + returned to the UI ─
export function buildRecoveryRecord(input = {}) {
  const source = SOURCES.includes(input.source) ? input.source : null;
  if (!source) throw new Error(`unknown recovery source: ${input.source}`);
  const ref = String(input.refId ?? '').slice(0, 128);
  if (!ref) throw new Error('recovery record needs a ref id');
  const status = RECOVERY_STATUSES.includes(input.status) ? input.status : 'Not recovered';
  const signed = input.token
    ? { token: String(input.token), expires_at: input.expiresAt || null }
    : signRecoveryToken(source, ref, { now: input.now, ttlSeconds: input.ttlSeconds, env: input.env });
  const url = input.externalUrl
    ? String(input.externalUrl).slice(0, 2000)
    : recoveryLinkUrl(signed.token, { env: input.env });
  return {
    source,
    ref_id: ref,
    recovery_status: status,
    link_token: signed.token,
    link_url: url,
    link_is_external: Boolean(input.externalUrl),
    link_expires_at: signed.expires_at || null,
    sent_at: input.sentAt || null,
    recovered_at: input.recoveredAt || null,
    recovered_by: input.recoveredBy ? String(input.recoveredBy).slice(0, 128) : null,
    last_error: input.lastError ? String(input.lastError).slice(0, 300) : null,
  };
}

// The Klaviyo event properties. Kept in one place so the manual "Send
// recovery" button and the detector sweep can never send different shapes.
export function buildEventProperties(row, { recoveryUrl, manual = false, source } = {}) {
  const cart = cartSummary(row?.line_items);
  return {
    source: source || row?.source || '',
    checkout_id: String(row?.ref_id ?? row?.id ?? row?.checkout_id ?? ''),
    RecoveryUrl: recoveryUrl || '',
    AbandonedAt: row?.created_at instanceof Date ? row.created_at.toISOString() : row?.created_at || null,
    Manual: Boolean(manual),
    currency: row?.currency || 'USD',
    item_count: cart.item_count,
    items: cart.items.map((i) => ({ title: i.title, quantity: i.quantity, price: i.price })),
  };
}

// ── schema ──────────────────────────────────────────────────────────────────
// The sidecar. It holds ONLY recovery state — never money, never cart truth —
// so it can be dropped and rebuilt without touching a settled order.
let tablesReadyPromise = null;

export function ensureRecoveryTables() {
  if (!tablesReadyPromise) {
    tablesReadyPromise = createRecoveryTables().catch((err) => {
      tablesReadyPromise = null;
      throw err;
    });
  }
  return tablesReadyPromise;
}

async function createRecoveryTables() {
  await pgQuery(`
    CREATE TABLE IF NOT EXISTS crm_recovery_meta (
      source TEXT NOT NULL,
      ref_id TEXT NOT NULL,
      recovery_status TEXT NOT NULL DEFAULT 'Not recovered',
      link_token TEXT,
      link_url TEXT,
      link_expires_at TIMESTAMPTZ,
      sent_at TIMESTAMPTZ,
      recovered_at TIMESTAMPTZ,
      recovered_by TEXT,
      recovered_value NUMERIC(12,2),
      last_error TEXT,
      undeliverable BOOLEAN NOT NULL DEFAULT FALSE,
      notes JSONB NOT NULL DEFAULT '{}',
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      PRIMARY KEY (source, ref_id)
    )
  `);
  await pgQuery(
    `CREATE INDEX IF NOT EXISTS idx_crm_recovery_status ON crm_recovery_meta (recovery_status, updated_at DESC)`
  );
  await pgQuery(
    `CREATE INDEX IF NOT EXISTS idx_crm_recovery_sent ON crm_recovery_meta (sent_at DESC) WHERE sent_at IS NOT NULL`
  );
}

// ── sidecar writes ──────────────────────────────────────────────────────────

export async function readRecoveryMeta(source, refId) {
  await ensureRecoveryTables();
  const rows = await pgQuery(
    `SELECT * FROM crm_recovery_meta WHERE source = $1 AND ref_id = $2`,
    [String(source).slice(0, 32), String(refId).slice(0, 128)]
  );
  return rows.length ? rows[0] : null;
}

// Upsert the sidecar row. `notes` is handed to postgres.js as a plain object —
// the driver serializes jsonb itself; JSON.stringify here would double-encode.
export async function upsertRecoveryMeta(record, extra = {}) {
  await ensureRecoveryTables();
  const rows = await pgQuery(
    `INSERT INTO crm_recovery_meta (
       source, ref_id, recovery_status, link_token, link_url, link_expires_at,
       sent_at, recovered_at, recovered_by, recovered_value, last_error, undeliverable, notes, updated_at
     ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,NOW())
     ON CONFLICT (source, ref_id) DO UPDATE SET
       recovery_status = EXCLUDED.recovery_status,
       link_token   = COALESCE(EXCLUDED.link_token, crm_recovery_meta.link_token),
       link_url     = COALESCE(EXCLUDED.link_url, crm_recovery_meta.link_url),
       link_expires_at = COALESCE(EXCLUDED.link_expires_at, crm_recovery_meta.link_expires_at),
       sent_at      = COALESCE(EXCLUDED.sent_at, crm_recovery_meta.sent_at),
       recovered_at = COALESCE(EXCLUDED.recovered_at, crm_recovery_meta.recovered_at),
       recovered_by = COALESCE(EXCLUDED.recovered_by, crm_recovery_meta.recovered_by),
       recovered_value = COALESCE(EXCLUDED.recovered_value, crm_recovery_meta.recovered_value),
       last_error   = EXCLUDED.last_error,
       undeliverable = EXCLUDED.undeliverable OR crm_recovery_meta.undeliverable,
       notes        = EXCLUDED.notes,
       updated_at   = NOW()
     RETURNING *`,
    [
      record.source,
      record.ref_id,
      record.recovery_status,
      record.link_is_external ? null : record.link_token,
      record.link_url || null,
      record.link_is_external ? null : record.link_expires_at,
      record.sent_at,
      record.recovered_at,
      record.recovered_by,
      extra.recoveredValue === undefined ? null : extra.recoveredValue,
      record.last_error,
      Boolean(extra.undeliverable),
      extra.notes && typeof extra.notes === 'object' ? extra.notes : {},
    ]
  );
  return rows[0];
}

// Mark a row undeliverable once, so the detector stops re-scanning an address
// with nothing salvageable in it (funnel-os learned this the expensive way:
// unsalvageable emails were retried every sweep, 400ing at the vendor forever).
export async function markUndeliverable(source, refId) {
  await ensureRecoveryTables();
  await pgQuery(
    `INSERT INTO crm_recovery_meta (source, ref_id, undeliverable, last_error)
     VALUES ($1, $2, TRUE, 'no_deliverable_email')
     ON CONFLICT (source, ref_id) DO UPDATE SET
       undeliverable = TRUE, last_error = 'no_deliverable_email', updated_at = NOW()`,
    [String(source).slice(0, 32), String(refId).slice(0, 128)]
  );
}

// ── the outbound nudge ──────────────────────────────────────────────────────
// Mirrors klaviyoEvents.fireCore: read + shape everything BEFORE the claim, so
// the claim-to-send window holds only the network calls; release on any path
// where the event did NOT land. Never throws.
export async function sendRecoveryEvent(row, { manual = false, env = process.env } = {}) {
  const source = SOURCES.includes(row?.source) ? row.source : null;
  if (!source) return { ok: false, error: 'bad_source' };
  const refId = String(row?.ref_id ?? '').slice(0, 128);
  if (!refId) return { ok: false, error: 'bad_ref' };
  const ref = `ab_${source}_${refId}`;

  let claimed = false;
  let delivered = false;
  try {
    const cfg = await _deps.getKlaviyoConfig();
    if (!cfg.enabled || !cfg.apiKey) return { ok: false, skipped: true, error: 'not_configured' };

    const email = sanitizeEmail(row.email);
    if (!email) return { ok: false, error: 'no_deliverable_email' };

    // Shopify mints its own recovery URL and owns that cart; for funnel
    // sessions the link is ours to sign.
    const record = buildRecoveryRecord({
      source,
      refId,
      status: 'Sent',
      externalUrl: source === 'shopify' ? row.recovery_url || null : null,
      env,
    });
    const props = buildEventProperties({ ...row, source }, {
      recoveryUrl: record.link_url,
      manual,
      source,
    });

    claimed = await _deps.claimSend(KIND, ref);
    if (!claimed) return { ok: true, deduped: true, link_url: record.link_url };

    // Lead scope: email-only profile (the buyer has NOT purchased). Matches
    // klaviyoEvents' MED#3 PII posture for the non-paid path.
    const prof = await _deps.upsertProfile({ email }, { apiKey: cfg.apiKey });

    const sent = await _deps.trackEvent(
      {
        metric_name: ABANDONED_METRIC,
        email,
        value: Number(row.total) || 0,
        unique_id: ref,
        properties: props,
      },
      { apiKey: cfg.apiKey }
    );
    delivered = sent.ok;
    if (!sent.ok) {
      await releaseOrReport(ref, 'failed-send');
      return { ok: false, error: sent.error || 'send_failed', profile_ok: prof.ok };
    }
    return { ok: true, profile_ok: prof.ok, link_url: record.link_url, record };
  } catch (err) {
    console.error(`[abandonedRecovery] nudge ${ref} failed:`, err.message);
    if (claimed && !delivered) await releaseOrReport(ref, 'error-path');
    return { ok: false, error: `internal:${err.code || err.name || 'error'}` };
  }
}

async function releaseOrReport(ref, where) {
  try {
    await _deps.releaseSend(KIND, ref);
  } catch (relErr) {
    console.error(
      `[abandonedRecovery] ORPHANED CLAIM ${KIND}/${ref} — ${where} release failed (${relErr.message}); delete the lb_integration_sends row by hand to re-enable this nudge`
    );
  }
}

export default {
  abandonGraceSeconds,
  recoveryWindowDays,
  recoveryLinkTtlSeconds,
  classifyCheckout,
  cartSummary,
  sanitizeEmail,
  parseJsonColumn,
  signRecoveryToken,
  verifyRecoveryToken,
  recoveryLinkUrl,
  buildRecoveryRecord,
  buildEventProperties,
  ensureRecoveryTables,
  readRecoveryMeta,
  upsertRecoveryMeta,
  markUndeliverable,
  sendRecoveryEvent,
};
