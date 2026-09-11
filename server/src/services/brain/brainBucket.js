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
/**
 * NEW-7 — the prefix was built by string concatenation from an UNVALIDATED
 * `STORE_CODE`, so `STORE_CODE="../evil"` produced `stores/../EVIL/` and
 * `STORE_CODE="sa/../sb"` produced `stores/SA/../SB/`, both `ok: true`. Ingest
 * survived only because `rawObjectKey` runs the anchored grammar in a DIFFERENT
 * module and throws first — so the containment did not live where the prefix is
 * built, the refusal a misconfigured store actually saw named the wrong variable
 * ("the object key is derived by the server…"), and any future caller of
 * `keyPrefix()` (a listing route, a signed-URL route) inherited the traversal.
 * The grammar is now checked HERE, where the prefix is made.
 */
export const STORE_CODE_RE = /^[A-Z0-9]{2,4}$/;

/** The validated store code for a key prefix, or the reason there is none. */
function prefixCode() {
  const code = storeCode();
  if (!code) {
    return {
      code: null,
      reason: 'STORE_CODE is not set — the Brain will not write an unprefixed object into a bucket another store may share',
    };
  }
  if (!STORE_CODE_RE.test(code)) {
    return {
      code: null,
      reason: `STORE_CODE ${JSON.stringify(code)} is not a store code (${STORE_CODE_RE.source}) — `
            + 'the Brain will not build a bucket key prefix out of it',
    };
  }
  return { code, reason: null };
}

export function bucketTarget() {
  const { code, reason: codeReason } = prefixCode();
  if (!code) {
    return { ok: false, reason: codeReason, bucket: null, prefix: null };
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

/**
 * The mandatory key prefix for this store, or null when STORE_CODE is unset OR
 * is not a store code (NEW-7). Null means "do not write" — never "write without
 * a prefix", which is the collision this module exists to prevent.
 */
export function keyPrefix() {
  const { code } = prefixCode();
  return code ? `stores/${code}/` : null;
}

/** Why there is no prefix, for a caller that wants to log or return the reason. */
export function keyPrefixRefusal() {
  return prefixCode().reason;
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

export default { bucketTarget, keyPrefix, keyPrefixRefusal, mirrorRawBody, STORE_CODE_RE };
