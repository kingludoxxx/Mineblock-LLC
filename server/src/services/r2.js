// CLOUDFLARE R2 — object storage.
//
// R7: every value is read from the environment WHEN A REQUEST IS SERVED, never
// captured at import. Before S4-SB2 the five R2 constants were module-level
// `process.env.X || ''` reads, so a pair whose bucket variable arrived after boot
// kept writing to whatever was set at import — and an unset R2_BUCKET_NAME fell
// back to a hard-coded bucket name shared by every store.
//
// The legacy fallback bucket is still honoured for the callers that predate the
// multi-store split (statics, advertorial, brief pipelines). Anything that must
// not share a bucket asks for `requireBucket: true`, which refuses the fallback.

import { S3Client, PutObjectCommand, DeleteObjectCommand, GetObjectCommand } from '@aws-sdk/client-s3';
import { getSignedUrl as s3GetSignedUrl } from '@aws-sdk/s3-request-presigner';
import crypto from 'crypto';

/** The bucket used when R2_BUCKET_NAME is unset. Legacy callers only. */
export const R2_FALLBACK_BUCKET = 'mineblock-creatives';

/** The R2 configuration AS IT IS RIGHT NOW. Never cached. */
export function r2Config() {
  const accountId = process.env.R2_ACCOUNT_ID || '';
  const accessKeyId = process.env.R2_ACCESS_KEY_ID || '';
  const secretAccessKey = process.env.R2_SECRET_ACCESS_KEY || '';
  const bucketFromEnv = (process.env.R2_BUCKET_NAME || '').trim();
  return {
    accountId,
    accessKeyId,
    secretAccessKey,
    bucket: bucketFromEnv || R2_FALLBACK_BUCKET,
    bucketExplicit: bucketFromEnv !== '',
    publicUrl: process.env.R2_PUBLIC_URL || '',
  };
}

/**
 * One client per distinct credential set, rebuilt when the environment changes.
 * Keyed on the values themselves, so a rotation takes effect on the next call.
 */
let cached = { key: null, client: null };
function clientFor(cfg) {
  const key = `${cfg.accountId}|${cfg.accessKeyId}|${cfg.secretAccessKey}`;
  if (cached.key !== key) {
    cached = {
      key,
      client: new S3Client({
        region: 'auto',
        endpoint: `https://${cfg.accountId}.r2.cloudflarestorage.com`,
        credentials: { accessKeyId: cfg.accessKeyId, secretAccessKey: cfg.secretAccessKey },
      }),
    };
  }
  return cached.client;
}

export async function uploadBuffer(buffer, key, contentType = 'image/png') {
  const cfg = r2Config();
  await clientFor(cfg).send(new PutObjectCommand({
    Bucket: cfg.bucket,
    Key: key,
    Body: buffer,
    ContentType: contentType,
  }));
  return cfg.publicUrl ? `${cfg.publicUrl}/${key}` : `r2://${cfg.bucket}/${key}`;
}

export async function uploadFromUrl(imageUrl, keyPrefix = 'creatives') {
  const res = await fetch(imageUrl);
  if (!res.ok) throw new Error(`Failed to fetch image: ${res.status}`);
  const buffer = Buffer.from(await res.arrayBuffer());
  const contentType = res.headers.get('content-type') || 'image/png';
  const ext = contentType.includes('jpeg') || contentType.includes('jpg') ? 'jpg' : 'png';
  const key = `${keyPrefix}/${crypto.randomUUID()}.${ext}`;
  const url = await uploadBuffer(buffer, key, contentType);
  return { url, key, contentType };
}

export async function deleteObject(key) {
  const cfg = r2Config();
  await clientFor(cfg).send(new DeleteObjectCommand({ Bucket: cfg.bucket, Key: key }));
}

export async function getSignedUrl(key, expiresIn = 3600) {
  const cfg = r2Config();
  const command = new GetObjectCommand({ Bucket: cfg.bucket, Key: key });
  return s3GetSignedUrl(clientFor(cfg), command, { expiresIn });
}

/**
 * @param {{requireBucket?: boolean}} [opts] `requireBucket` refuses the shared
 *   fallback bucket: a caller that must not collide with another store's objects
 *   needs R2_BUCKET_NAME set explicitly for THIS pair.
 */
export function isR2Configured({ requireBucket = false } = {}) {
  const cfg = r2Config();
  if (!(cfg.accountId && cfg.accessKeyId && cfg.secretAccessKey)) return false;
  if (requireBucket && !cfg.bucketExplicit) return false;
  return true;
}
