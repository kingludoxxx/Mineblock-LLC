// Per-funnel gateway credentials — operator data, encrypted at rest,
// WRITE-ONLY API semantics (port of funnel-os lb_gateways_service):
//   - PATCH: null/undefined keeps the stored value, "" clears it, a value
//     replaces it (encrypted)
//   - READS return only `<field>_set` booleans — a secret never leaves the DB
//     decrypted except into a gateway adapter call
// Platform-wide fallbacks may come from env (STRIPE_SECRET_KEY, …) — resolved
// at call time, never module-cached, so rotation is an env change + restart,
// not a code change.
import crypto from 'crypto';
import { pgQuery } from '../db/pg.js';
import { ensureCheckoutTables } from './checkoutSchema.js';

export const GATEWAYS = {
  stripe: {
    secrets: ['secret_key', 'webhook_secret'],
    plain: ['publishable_key'],
    envFallback: {
      secret_key: 'STRIPE_SECRET_KEY',
      webhook_secret: 'STRIPE_WEBHOOK_SECRET',
      publishable_key: 'STRIPE_PUBLISHABLE_KEY',
    },
  },
  whop: {
    secrets: ['api_key', 'webhook_secret'],
    plain: ['company_id', 'plan_id'],
    envFallback: {
      api_key: 'WHOP_API_KEY',
      webhook_secret: 'WHOP_WEBHOOK_SECRET',
      company_id: 'WHOP_COMPANY_ID',
      plan_id: 'WHOP_PLAN_ID',
    },
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

// Write-only merge. `body` fields: null/undefined keep, "" clears, value
// replaces (secrets encrypted). Upserts the row.
export async function patchConfig(funnelId, gateway, body) {
  const spec = GATEWAYS[gateway];
  if (!spec) throw new Error(`unknown_gateway:${gateway}`);
  await ensureCheckoutTables();
  const cfg = (await loadConfig(funnelId, gateway)) || {};
  for (const f of spec.secrets) {
    const v = body[f];
    if (v !== null && v !== undefined) {
      const t = String(v).trim();
      cfg[f] = t ? encryptSecret(t) : '';
    }
  }
  for (const f of spec.plain) {
    const v = body[f];
    if (v !== null && v !== undefined) cfg[f] = String(v).trim();
  }
  if (body.enabled !== null && body.enabled !== undefined) cfg.enabled = Boolean(body.enabled);
  if (cfg.enabled === undefined) cfg.enabled = true;
  await pgQuery(
    `INSERT INTO co_gateway_configs (funnel_id, gateway, config, updated_at)
     VALUES ($1, $2, $3, NOW())
     ON CONFLICT (funnel_id, gateway) DO UPDATE SET config = EXCLUDED.config, updated_at = NOW()`,
    [funnelId, gateway, cfg]
  );
  return publicView(gateway, cfg);
}

// Safe read: `<secret>_set` booleans + plain fields only. An allow-list.
export function publicView(gateway, cfg) {
  const spec = GATEWAYS[gateway];
  const out = { gateway, enabled: cfg ? Boolean(cfg.enabled) : false };
  for (const f of spec.secrets) out[`${f}_set`] = Boolean(cfg && cfg[f]);
  for (const f of spec.plain) out[f] = (cfg && cfg[f]) || '';
  return out;
}

export async function getPublicConfig(funnelId, gateway) {
  await ensureCheckoutTables();
  return publicView(gateway, await loadConfig(funnelId, gateway));
}

// Resolve ONE decrypted secret (or plain field) for a charge/verify call:
// per-funnel stored value first, env fallback second. Returns ''.
export async function resolveCredential(funnelId, gateway, field) {
  const spec = GATEWAYS[gateway];
  if (!spec) return '';
  await ensureCheckoutTables();
  const cfg = funnelId ? await loadConfig(funnelId, gateway) : null;
  if (cfg && cfg.enabled !== false && cfg[field]) {
    return spec.secrets.includes(field) ? decryptSecret(cfg[field]) : String(cfg[field]);
  }
  const envVar = spec.envFallback[field];
  return envVar ? process.env[envVar] || '' : '';
}
