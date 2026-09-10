// THE STORE BRAIN — vocabulary, validation and the bucket-key convention.
//
// One Brain per store, in that store's OWN database and bucket. Nothing in this
// file names a store, a product or a brand (R15): product codes are DATA and are
// validated at REQUEST time (R7) against PRODUCT_CODES_JSON through storeConfig,
// which is the single read site for store identity.

import { productCodes } from '../../config/storeConfig.js';
import crypto from 'node:crypto';

/** A Brain request is malformed or refers to something that does not exist. */
export class BrainError extends Error {
  constructor(code, message, status = 400, detail = null) {
    super(message);
    this.name = 'BrainError';
    this.code = code;
    this.status = status;
    this.detail = detail;
  }
}

/** Layer-2 fact types. An extraction may only propose one of these. */
export const INSIGHT_TYPES = Object.freeze([
  'voice_of_customer', 'pain', 'objection', 'desired_outcome',
  'competitor_claim', 'price_anchor', 'demographic_signal',
]);

/** Layer-3 curated sections. Editorial, so it lives here and not in a CHECK. */
export const PLAYBOOK_SECTIONS = Object.freeze([
  'avatars', 'allowed_claims', 'forbidden_claims', 'angles', 'hooks',
  'voice_rules', 'visual_bible', 'proof_assets', 'competitors', 'offers',
]);

export const INSIGHT_STATUSES = Object.freeze(['proposed', 'approved', 'rejected']);

export const SEARCH_LIMIT_MAX = 100;
export const SEARCH_LIMIT_DEFAULT = 20;
export const BODY_MAX_BYTES = 4 * 1024 * 1024;

/**
 * Validate a product code against this deployment's catalogue.
 * Unknown code → BrainError. `null`/absent is allowed (store-wide documents).
 * Read at call time so a catalogue change needs no restart (R7).
 */
export function assertProductCode(code, { required = false } = {}) {
  if (code === undefined || code === null || String(code).trim() === '') {
    if (required) throw new BrainError('product_required', 'a product code is required');
    return null;
  }
  const c = String(code).trim().toUpperCase();
  const catalogue = productCodes(); // throws StoreConfigError when unset — boot already refuses
  if (!catalogue[c]) {
    const known = Object.keys(catalogue).join(', ');
    throw new BrainError('bad_product_code', `unknown product code ${JSON.stringify(c)} — this store's catalogue is: ${known}`);
  }
  return c;
}

export function assertInsightType(t) {
  const v = String(t || '').trim();
  if (!INSIGHT_TYPES.includes(v)) {
    throw new BrainError('bad_insight_type', `insight_type must be one of: ${INSIGHT_TYPES.join(', ')}`);
  }
  return v;
}

export function assertStatus(s) {
  const v = String(s || '').trim();
  if (!INSIGHT_STATUSES.includes(v)) {
    throw new BrainError('bad_status', `status must be one of: ${INSIGHT_STATUSES.join(', ')}`);
  }
  return v;
}

export function assertSection(s) {
  const v = String(s || '').trim();
  if (!PLAYBOOK_SECTIONS.includes(v)) {
    throw new BrainError('bad_section', `unknown playbook section ${JSON.stringify(v)} — sections are: ${PLAYBOOK_SECTIONS.join(', ')}`);
  }
  return v;
}

/** sha256 of the captured bytes — the document's identity and idempotency key. */
export function contentHash(text) {
  return crypto.createHash('sha256').update(Buffer.from(String(text), 'utf8')).digest('hex');
}

/** 'operator research' → 'operator-research'. Safe for a bucket path segment. */
export function sourceSlug(source) {
  const s = String(source || '').trim().toLowerCase()
    .replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '');
  if (!s) throw new BrainError('bad_source', 'source is required');
  return s;
}

/**
 * The ONLY extensions the Brain will ever write, and the ONLY content types it
 * accepts. The extension is DERIVED from the content type — it is never taken
 * from the caller. (S4-SB2 / P1-6: a caller-supplied `ext` reached the key
 * verbatim, so `ext: 'txt/../../../../brand-spy/videos/owned'` produced a key
 * that escaped the documented convention and, once handed to `R2_PUBLIC_URL`,
 * a URL a browser normalises to a DIFFERENT object.)
 */
const EXT_BY_TYPE = Object.freeze({
  'text/plain': 'txt',
  'text/markdown': 'md',
  'application/json': 'json',
  'text/html': 'html',
  'text/csv': 'csv',
});
export const CONTENT_TYPES = Object.freeze(Object.keys(EXT_BY_TYPE));

/** Content type → the one extension allowed for it. Unknown type → 422. */
export function extForContentType(contentType) {
  const ct = String(contentType || '').trim().toLowerCase().split(';')[0].trim();
  const ext = EXT_BY_TYPE[ct];
  if (!ext) {
    throw new BrainError('bad_content_type',
      `content_type ${JSON.stringify(ct)} is not one the Brain can archive — allowed: ${CONTENT_TYPES.join(', ')}`,
      422);
  }
  return ext;
}

/**
 * Every legal Brain object key, anchored end to end. The store prefix is the
 * bucket-isolation half (P1-7): two stores that share a bucket cannot collide,
 * because the prefix is built from STORE_CODE and nothing else.
 *   [stores/<CODE>/]knowledge/raw/<source-slug>/<YYYY-MM-DD>/<sha256>.<ext>
 * There is no `.` or `..` segment anywhere in that grammar, so a key that
 * matches it cannot traverse.
 */
export const OBJECT_KEY_RE =
  /^(?:stores\/[A-Z0-9][A-Z0-9_-]{0,31}\/)?knowledge\/raw\/[a-z0-9]+(?:-[a-z0-9]+)*\/\d{4}-\d{2}-\d{2}\/[0-9a-f]{64}\.[a-z0-9]{1,8}$/;

/** Belt and braces: the regex forbids traversal, this states it as a rule. */
export function assertObjectKey(key) {
  const k = String(key ?? '');
  if (!OBJECT_KEY_RE.test(k) || k.split('/').some((seg) => seg === '.' || seg === '..')) {
    throw new BrainError('bad_object_key',
      'the object key is derived by the server and must match knowledge/raw/<source>/<date>/<sha256>.<ext>', 422);
  }
  return k;
}

/**
 * The bucket key for a raw document body — SERVER-DERIVED, always:
 *   stores/<STORE_CODE>/knowledge/raw/<source-slug>/<YYYY-MM-DD>/<sha256>.<ext>
 * `storeCode` null (a deployment with no STORE_CODE) drops the prefix and the
 * ingest route then refuses to mirror to R2 at all, rather than writing an
 * unprefixed object into a bucket another store may share.
 */
export function rawObjectKey({ source, capturedAt, hash, contentType = 'text/plain', storeCode = null }) {
  const d = capturedAt ? new Date(capturedAt) : new Date();
  if (Number.isNaN(d.getTime())) throw new BrainError('bad_captured_at', 'captured_at is not a date');
  const day = d.toISOString().slice(0, 10);
  const e = extForContentType(contentType);
  const prefix = storeCode ? `stores/${String(storeCode).trim().toUpperCase()}/` : '';
  return assertObjectKey(`${prefix}knowledge/raw/${sourceSlug(source)}/${day}/${hash}.${e}`);
}

export function clampLimit(v, def = SEARCH_LIMIT_DEFAULT) {
  const n = Number.parseInt(v, 10);
  if (!Number.isFinite(n) || n <= 0) return def;
  return Math.min(n, SEARCH_LIMIT_MAX);
}
