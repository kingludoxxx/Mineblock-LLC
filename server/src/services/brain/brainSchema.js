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

const EXT_BY_TYPE = { 'text/markdown': 'md', 'application/json': 'json', 'text/html': 'html', 'text/plain': 'txt' };

/**
 * The bucket key for a raw document body:
 *   knowledge/raw/<source-slug>/<YYYY-MM-DD>/<sha256>.<ext>
 * Same convention as the existing R2 mirrors (`brand-spy/videos/<id>.mp4`):
 * a flat namespace prefix, no leading slash, the content id as the filename.
 */
export function rawObjectKey({ source, capturedAt, hash, contentType = 'text/plain', ext = null }) {
  const d = capturedAt ? new Date(capturedAt) : new Date();
  if (Number.isNaN(d.getTime())) throw new BrainError('bad_captured_at', 'captured_at is not a date');
  const day = d.toISOString().slice(0, 10);
  const e = (ext || EXT_BY_TYPE[contentType] || 'txt').replace(/^\./, '');
  return `knowledge/raw/${sourceSlug(source)}/${day}/${hash}.${e}`;
}

export function clampLimit(v, def = SEARCH_LIMIT_DEFAULT) {
  const n = Number.parseInt(v, 10);
  if (!Number.isFinite(n) || n <= 0) return def;
  return Math.min(n, SEARCH_LIMIT_MAX);
}
