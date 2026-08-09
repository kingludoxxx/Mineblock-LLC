// Per-funnel gateway credentials — operator data, encrypted at rest,
// WRITE-ONLY API semantics (port of funnel-os lb_gateways_service).
//
// DUAL LIVE + SANDBOX APP MODEL (the key design):
//   Every gateway keeps TWO independent credential sets per funnel — `live`
//   and `sandbox` — connected at once. Real buyers always charge on `live`;
//   checkout previews and connection tests use `sandbox`. There is no manual
//   switch: `live` takes over the moment its credentials are saved. The
//   selection happens INSIDE resolveCredential (mode option, default 'live')
//   so the money path in checkoutPublic.js benefits automatically without
//   editing it. sandbox creds and env fallbacks NEVER leak into live mode and
//   vice-versa.
//
//   Stored config shape (JSONB, opaque to the DB schema):
//     {
//       enabled: bool,                 // gateway offered on this funnel
//       allow_sandbox_on_live: bool,   // let the sandbox app run on the real
//                                      //   host for staging (default false).
//                                      //   STORED BUT NOT YET CONSULTED — the
//                                      //   future preview-mode wiring (the
//                                      //   caller that passes {mode:'sandbox'}
//                                      //   from the live host) must check this
//                                      //   flag before honoring sandbox there.
//                                      //   The UI labels it "coming soon".
//       live:    { <field>: value|ciphertext, ... },
//       sandbox: { <field>: value|ciphertext, ... },
//     }
//
//   BACKWARD COMPAT: pre-existing single-set configs stored fields at the top
//   level ({ api_key, company_id, enabled }). normalize() read-through maps a
//   legacy top-level set onto `live`, so old configs still resolve, and the
//   canonical dual-app shape is written back on the next patch (migrate-on-
//   write). No migration is required — the column is JSONB.
//
// Write-only PATCH semantics (per set): null/undefined keeps the stored value,
// "" clears it, a value replaces it (secrets encrypted). READS return only
// `<field>_set` booleans for secrets (a secret never leaves the DB decrypted
// except into a gateway adapter call); plain identifiers (company_id,
// publishable_key, …) are surfaced as-is.
//
// Platform-wide fallbacks may come from env (STRIPE_SECRET_KEY, …) — resolved
// at call time (never module-cached) and ONLY in live mode, since those env
// values are the operator's real production keys.
import crypto from 'crypto';
import { pgQuery } from '../db/pg.js';
import { ensureCheckoutTables } from './checkoutSchema.js';

export const GATEWAYS = {
  stripe: {
    secrets: ['secret_key', 'webhook_secret'],
    plain: ['publishable_key'],
    // Fields whose presence means "credentials entered" for a configured check.
    requiredForConfigured: ['secret_key'],
    envFallback: {
      secret_key: 'STRIPE_SECRET_KEY',
      webhook_secret: 'STRIPE_WEBHOOK_SECRET',
      publishable_key: 'STRIPE_PUBLISHABLE_KEY',
    },
  },
  whop: {
    secrets: ['api_key', 'webhook_secret'],
    plain: ['company_id', 'plan_id'],
    requiredForConfigured: ['api_key', 'company_id'],
    envFallback: {
      api_key: 'WHOP_API_KEY',
      webhook_secret: 'WHOP_WEBHOOK_SECRET',
      company_id: 'WHOP_COMPANY_ID',
      plan_id: 'WHOP_PLAN_ID',
    },
  },
  // PayPal + NMI: fields render for storage + a configured-or-not status only.
  // Their CHARGE ADAPTERS are a future task — no money path exists yet.
  paypal: {
    secrets: ['client_secret', 'webhook_id'],
    plain: ['client_id'],
    requiredForConfigured: ['client_id', 'client_secret'],
    envFallback: {},
  },
  nmi: {
    secrets: ['security_key', 'webhook_secret'],
    plain: ['tokenization_key'],
    requiredForConfigured: ['security_key'],
    envFallback: {},
  },
};

// AES-256-GCM. Key: CHECKOUT_CREDS_KEY (base64/hex, 32 bytes) — preferred —
// else derived from JWT_SECRET so existing deploys work without a new var
// (rotating JWT_SECRET then requires re-entering gateway creds; the loud log
// line below is the operator's breadcrumb). Read at call time.
function credsKey() {
  const raw = process.env.CHECKOUT_CREDS_KEY || '';
  if (raw) {
    const buf = /^[0-9a-fA-F]{64}$/.test(raw) ? Buffer.from(raw, 'hex') : Buffer.from(raw, 'base64');
    if (buf.length === 32) return buf;
    throw new Error('CHECKOUT_CREDS_KEY must decode to 32 bytes (hex or base64)');
  }
  const jwt = process.env.JWT_SECRET || '';
  if (!jwt) throw new Error('no CHECKOUT_CREDS_KEY and no JWT_SECRET — cannot encrypt gateway creds');
  return crypto.createHash('sha256').update(`checkout-creds:${jwt}`).digest();
}

export function encryptSecret(plaintext) {
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv('aes-256-gcm', credsKey(), iv);
  const enc = Buffer.concat([cipher.update(String(plaintext), 'utf8'), cipher.final()]);
  const tag = cipher.getAuthTag();
  return `gcm1:${Buffer.concat([iv, tag, enc]).toString('base64')}`;
}

export function decryptSecret(stored) {
  if (!stored) return '';
  if (!stored.startsWith('gcm1:')) throw new Error('unknown_ciphertext_format');
  const buf = Buffer.from(stored.slice(5), 'base64');
  const iv = buf.subarray(0, 12);
  const tag = buf.subarray(12, 28);
  const enc = buf.subarray(28);
  const decipher = crypto.createDecipheriv('aes-256-gcm', credsKey(), iv);
  decipher.setAuthTag(tag);
  return Buffer.concat([decipher.update(enc), decipher.final()]).toString('utf8');
}

async function loadConfig(funnelId, gateway) {
  const rows = await pgQuery(
    `SELECT config FROM co_gateway_configs WHERE funnel_id = $1 AND gateway = $2`,
    [funnelId, gateway]
  );
  return rows.length ? rows[0].config || {} : null;
}

const MODES = ['live', 'sandbox'];
function pickMode(mode) {
  return mode === 'sandbox' ? 'sandbox' : 'live';
}

// Read-through normalizer: returns the canonical dual-app view of any stored
// config — new dual shape OR a legacy single-set config (its top-level fields
// mapped onto `live`). Never mutates the input.
export function normalize(gateway, cfg) {
  const spec = GATEWAYS[gateway];
  if (!spec) return { enabled: false, allow_sandbox_on_live: false, live: {}, sandbox: {} };
  const src = cfg && typeof cfg === 'object' ? cfg : {};
  const fields = [...spec.secrets, ...spec.plain];
  const hasNs = src.live !== undefined || src.sandbox !== undefined;
  const out = {
    enabled: src.enabled === undefined ? true : Boolean(src.enabled),
    allow_sandbox_on_live: Boolean(src.allow_sandbox_on_live),
    live: {},
    sandbox: {},
  };
  if (hasNs) {
    for (const f of fields) {
      if (src.live && src.live[f] !== undefined && src.live[f] !== '') out.live[f] = src.live[f];
      if (src.sandbox && src.sandbox[f] !== undefined && src.sandbox[f] !== '') out.sandbox[f] = src.sandbox[f];
    }
  } else {
    // Legacy single-set config: top-level fields ARE the live app.
    for (const f of fields) {
      if (src[f] !== undefined && src[f] !== '') out.live[f] = src[f];
    }
  }
  return out;
}

function canonical(norm) {
  return {
    enabled: Boolean(norm.enabled),
    allow_sandbox_on_live: Boolean(norm.allow_sandbox_on_live),
    live: norm.live,
    sandbox: norm.sandbox,
  };
}

// The stored (per-funnel) config in canonical dual-app form, or null when no
// row exists. Lets callers (gatewayStatus) distinguish "this funnel has creds
// stored" from "only an env fallback would resolve" — the card pill's job is
// "is THIS funnel set up", so env-only must not read as configured.
export async function getStoredConfig(funnelId, gateway) {
  if (!GATEWAYS[gateway]) return null;
  await ensureCheckoutTables();
  const cfg = funnelId ? await loadConfig(funnelId, gateway) : null;
  return cfg ? normalize(gateway, cfg) : null;
}

// Write-only merge into ONE credential set (mode). `body` fields: null/undefined
// keep, "" clears, value replaces (secrets encrypted). Root toggles (`enabled`,
// `allow_sandbox_on_live`) patch regardless of mode. Upserts the canonical
// dual-app row (migrating a legacy config on the way).
//
// MODE IS EXPLICIT for credential writes: a body carrying any credential field
// must name mode 'live' or 'sandbox' — silently defaulting a credential write
// to LIVE is how a sandbox key ends up charging real buyers. Toggles-only
// patches (enabled / allow_sandbox_on_live, no cred fields) may omit mode.
// Throws Error('mode_required') → the route maps it to a 422.
export async function patchConfig(funnelId, gateway, body) {
  const spec = GATEWAYS[gateway];
  if (!spec) throw new Error(`unknown_gateway:${gateway}`);
  const modeGiven = body.mode !== undefined && body.mode !== null;
  const validMode = body.mode === 'live' || body.mode === 'sandbox';
  const hasCredField = [...spec.secrets, ...spec.plain]
    .some((f) => body[f] !== undefined && body[f] !== null);
  if ((modeGiven && !validMode) || (hasCredField && !validMode)) {
    throw new Error('mode_required');
  }
  await ensureCheckoutTables();
  const norm = normalize(gateway, await loadConfig(funnelId, gateway));
  const mode = pickMode(body.mode);
  const set = norm[mode];

  for (const f of spec.secrets) {
    const v = body[f];
    if (v !== null && v !== undefined) {
      const t = String(v).trim();
      if (t) set[f] = encryptSecret(t);
      else delete set[f];
    }
  }
  for (const f of spec.plain) {
    const v = body[f];
    if (v !== null && v !== undefined) {
      const t = String(v).trim();
      if (t) set[f] = t;
      else delete set[f];
    }
  }
  if (body.enabled !== null && body.enabled !== undefined) norm.enabled = Boolean(body.enabled);
  if (body.allow_sandbox_on_live !== null && body.allow_sandbox_on_live !== undefined) {
    norm.allow_sandbox_on_live = Boolean(body.allow_sandbox_on_live);
  }

  const stored = canonical(norm);
  await pgQuery(
    `INSERT INTO co_gateway_configs (funnel_id, gateway, config, updated_at)
     VALUES ($1, $2, $3, NOW())
     ON CONFLICT (funnel_id, gateway) DO UPDATE SET config = EXCLUDED.config, updated_at = NOW()`,
    [funnelId, gateway, stored]
  );
  return publicView(gateway, stored);
}

// Safe read of ONE set: `<secret>_set` booleans + plain field values.
function viewSet(spec, set) {
  const o = {};
  for (const f of spec.secrets) o[`${f}_set`] = Boolean(set && set[f]);
  for (const f of spec.plain) o[f] = (set && set[f]) || '';
  return o;
}

// Safe public view — an allow-list. NEVER surfaces a decrypted secret.
export function publicView(gateway, cfg) {
  const spec = GATEWAYS[gateway];
  const norm = normalize(gateway, cfg);
  return {
    gateway,
    enabled: norm.enabled,
    allow_sandbox_on_live: norm.allow_sandbox_on_live,
    fields: {
      secrets: spec.secrets,
      plain: spec.plain,
    },
    live: viewSet(spec, norm.live),
    sandbox: viewSet(spec, norm.sandbox),
  };
}

export async function getPublicConfig(funnelId, gateway) {
  await ensureCheckoutTables();
  return publicView(gateway, await loadConfig(funnelId, gateway));
}

/**
 * Resolve ONE decrypted secret (or plain field) for a charge/verify/status
 * call. Set selection:
 *   opts.mode 'live' (default — real buyers) | 'sandbox' (preview/tests).
 * Order: per-funnel stored value for that mode first; env fallback second —
 * but env fallback applies to LIVE ONLY (env holds the operator's real keys,
 * which must never stand in for a sandbox app). Returns '' when unset.
 *
 * DISABLED GATES EVERYTHING: when a config row EXISTS for this funnel and the
 * operator has toggled the gateway OFF, resolution returns '' BEFORE the env
 * fallback — matching the UI promise "Off → checkout won't offer it even with
 * valid credentials". A funnel with NO row at all still falls through to env
 * (today's cross-funnel platform-default behavior, unchanged).
 *
 * Callers that want the preview/test app pass { mode: 'sandbox' }; everyone
 * else (incl. checkoutPublic.js, unchanged) gets live, so the money path is
 * unaffected.
 */
export async function resolveCredential(funnelId, gateway, field, opts = {}) {
  const spec = GATEWAYS[gateway];
  if (!spec) return '';
  await ensureCheckoutTables();
  const mode = pickMode(opts.mode);
  const cfg = funnelId ? await loadConfig(funnelId, gateway) : null;
  if (cfg) {
    const norm = normalize(gateway, cfg);
    // Explicitly disabled: no credential resolves for this funnel — not the
    // stored set, not the env fallback.
    if (norm.enabled === false) return '';
    const set = norm[mode];
    if (set && set[field]) {
      return spec.secrets.includes(field) ? decryptSecret(set[field]) : String(set[field]);
    }
  }
  if (mode === 'live') {
    const envVar = spec.envFallback ? spec.envFallback[field] : null;
    if (envVar) return process.env[envVar] || '';
  }
  return '';
}

/**
 * Resolve the full decrypted credential set for a gateway in one mode — used
 * by the connection-status ping and (future) preview-mode charge callers.
 * Reuses resolveCredential so gating + env-fallback semantics stay identical.
 */
export async function resolveGatewayCreds(funnelId, gateway, opts = {}) {
  const spec = GATEWAYS[gateway];
  if (!spec) return {};
  const out = {};
  for (const f of [...spec.secrets, ...spec.plain]) {
    out[f] = await resolveCredential(funnelId, gateway, f, opts);
  }
  return out;
}
