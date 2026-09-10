// THE STORE BRAIN — the BUCKET half of "its own Postgres and bucket" (P1-7).
//
// The Postgres half is physical: one database per store, no store_id, no store
// parameter. The bucket half was NOT, and this module is what makes it so:
//
//   1. R2_BUCKET_NAME must be set EXPLICITLY for this pair. Account + keys with
//      no bucket used to fall back to one shared bucket name, so two stores wrote
//      the same `knowledge/raw/<source>/<date>/<sha256>.<ext>` key — and because
//      identical bytes give an identical key, store B's ingest silently
//      OVERWROTE store A's archived body.
//   2. Every Brain object key is prefixed `stores/<STORE_CODE>/`. Two stores that
//      are nevertheless pointed at one bucket cannot collide.
//   3. STORE_CODE unset ⇒ NO mirror at all. An unprefixed object in a possibly
//      shared bucket is exactly the collision this exists to prevent, so the
//      Brain refuses to write one and says why.
//
// Nothing here decides whether ingest SUCCEEDS: the database is the index and the
// bucket is the archive, so a refused mirror is logged, never fatal.

import { storeCode } from '../../config/storeConfig.js';
import { isR2Configured, uploadBuffer, r2Config } from '../r2.js';

/**
 * May this process mirror a raw body to R2, and if not, why not?
 * Read at CALL time (R7) — both the store code and the R2 config.
 * @returns {{ok: boolean, reason: string|null, bucket: string|null, prefix: string|null}}
 */
export function bucketTarget() {
  const code = storeCode();
  if (!code) {
    return {
      ok: false,
      reason: 'STORE_CODE is not set — the Brain will not write an unprefixed object into a bucket another store may share',
      bucket: null,
      prefix: null,
    };
  }
  if (!isR2Configured({ requireBucket: true })) {
    const cfg = r2Config();
    const reason = cfg.accountId && cfg.accessKeyId && cfg.secretAccessKey
      ? 'R2_BUCKET_NAME is not set for this pair — the Brain refuses the shared fallback bucket'
      : 'R2 is not configured on this store (R2_ACCOUNT_ID / R2_ACCESS_KEY_ID / R2_SECRET_ACCESS_KEY)';
    return { ok: false, reason, bucket: null, prefix: null };
  }
  return { ok: true, reason: null, bucket: r2Config().bucket, prefix: `stores/${code}/` };
}

/** The mandatory key prefix for this store, or null when STORE_CODE is unset. */
export function keyPrefix() {
  const code = storeCode();
  return code ? `stores/${code}/` : null;
}

/**
 * Mirror one document body to the bucket. Returns a RESULT, never throws for a
 * configuration reason — "not mirrored, because X" is an answer, not an error.
 * A genuine upload failure DOES throw: a silent partial archive is the bug.
 * @param {{body_object_key: string, body_text: string, content_type: string}} document
 */
export async function mirrorRawBody(document) {
  const target = bucketTarget();
  if (!target.ok) return { mirrored: false, reason: target.reason };
  const key = String(document.body_object_key || '');
  if (!key.startsWith(target.prefix)) {
    // The key is derived by brainSchema from the SAME storeCode(), so this can
    // only mean the code changed under a running process. Refuse rather than
    // write a foreign prefix into this store's bucket.
    return { mirrored: false, reason: `object key ${JSON.stringify(key)} does not carry this store's prefix ${target.prefix}` };
  }
  const url = await uploadBuffer(Buffer.from(document.body_text, 'utf8'), key, document.content_type);
  return { mirrored: true, bucket: target.bucket, key, url };
}

export default { bucketTarget, keyPrefix, mirrorRawBody };
