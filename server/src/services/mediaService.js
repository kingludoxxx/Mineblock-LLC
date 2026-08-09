// Media library service — CDN storage pipeline, image header parsing, and the
// SSRF guard for external-URL import.
//
// ── STORAGE DECISION (v1) ───────────────────────────────────────────────────
// Two backends, resolved at call time, PRIMARY FIRST:
//
//   1. SHOPIFY FILES (primary). Admin GraphQL stagedUploadsCreate → PUT/POST
//      the bytes at the staged target → fileCreate → poll until READY → read
//      the cdn.shopify.com url. Uses the SAME credentials the money path
//      already relies on (checkoutPricing.js:83-87 — PUURE_SHOPIFY_STORE /
//      PUURE_SHOPIFY_TOKEN, falling back to SHOPIFY_STORE_DOMAIN /
//      SHOPIFY_ACCESS_TOKEN), so there is no new secret to provision.
//      REQUIRES the `write_files` Admin API access scope. A token without it
//      fails stagedUploadsCreate with an ACCESS_DENIED userError — surfaced
//      verbatim as `shopify_scope_missing` rather than swallowed, because the
//      operator's fix is a one-line scope grant and a silent fallback would
//      hide it forever.
//
//   2. CLOUDFLARE R2 (fallback). services/r2.js already exists in this repo
//      and is already in production use by advertorialPipeline.js:15,
//      briefPipeline.js:20 and staticsGeneration.js:36. @aws-sdk/client-s3 is
//      already a dependency. One PutObject, no polling, no scope risk. It is
//      the fallback rather than the primary only because the task pinned
//      Shopify Files as the v1 CDN; on the evidence R2 is the cheaper path and
//      MEDIA_STORAGE_BACKEND=r2 selects it with no code change.
//
// REJECTED, on purpose:
//   - base64/bytea in Postgres — the money path shares that pool.
//   - local disk — Render's filesystem is ephemeral; assets would die at the
//     next deploy and 404 in front of paid traffic.
//
// If NEITHER backend is configured, putImage throws StorageUnavailableError
// and the routes degrade HONESTLY: /import-url still indexes the external URL
// (source='url', shopify_file_id NULL, rehosted:false in the response) and
// /upload refuses with 503. It never pretends to have stored bytes it did not.
//
// ── TEST SEAM ───────────────────────────────────────────────────────────────
// MEDIA_SHOPIFY_API_BASE overrides the GraphQL ORIGIN only; the path is built
// exactly as checkoutPricing.js:101 builds it. Same shape as the money path's
// own override seam (trackingDelivery.js:187 TRACKING_RELAY_OVERRIDE_URL), so
// the harness can drive the real pipeline against a mock Shopify.

import crypto from 'crypto';
import dns from 'dns/promises';
import net from 'net';
import { uploadBuffer, isR2Configured } from './r2.js';

// ---------------------------------------------------------------------------
// Errors — every failure the routes need to distinguish has its own class or
// code. A caller must never have to regex an error message.
// ---------------------------------------------------------------------------
export class StorageUnavailableError extends Error {
  constructor(code = 'storage_unavailable', detail = '') {
    super(detail ? `${code}: ${detail}` : code);
    this.name = 'StorageUnavailableError';
    this.code = code;
    this.detail = detail;
  }
}

export const MAX_UPLOAD_BYTES = 5 * 1024 * 1024;   // base64 JSON upload cap
export const MAX_IMPORT_BYTES = 10 * 1024 * 1024;  // external-URL import cap

// Allow-list, not a deny-list. SVG is deliberately absent: it is an active
// document (script/foreignObject) and re-hosting one onto a CDN the funnel
// pages trust turns the library into a stored-XSS vector.
export const ALLOWED_MIME = new Set(['image/png', 'image/jpeg', 'image/gif', 'image/webp']);

const EXT_BY_MIME = {
  'image/png': 'png',
  'image/jpeg': 'jpg',
  'image/gif': 'gif',
  'image/webp': 'webp',
};

const FETCH_TIMEOUT_MS = 15_000;
const POLL_TIMEOUT_MS = Number(process.env.MEDIA_SHOPIFY_POLL_TIMEOUT_MS || 20_000);
const POLL_INTERVAL_MS = Number(process.env.MEDIA_SHOPIFY_POLL_INTERVAL_MS || 500);

export const newMediaId = () => `med_${crypto.randomBytes(9).toString('hex')}`;

// ===========================================================================
// 1. Image header parsing — width/height + a magic-byte MIME sniff.
//
// Pure JS, zero new dependencies. `sharp` IS already a dependency (used by
// routes/staticsGeneration.js:206) and would handle more formats, but loading
// a native module on the 512 MB dyno to read four integers out of a header we
// already have in memory is the wrong trade. Unknown/corrupt formats return
// null — dimensions are metadata, never a reason to refuse an upload.
// ===========================================================================

const PNG_SIG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

/** Magic-byte MIME sniff. Returns null when the bytes are not a known image. */
export function sniffMime(buf) {
  if (!Buffer.isBuffer(buf) || buf.length < 12) return null;
  if (buf.subarray(0, 8).equals(PNG_SIG)) return 'image/png';
  if (buf[0] === 0xff && buf[1] === 0xd8 && buf[2] === 0xff) return 'image/jpeg';
  if (buf.subarray(0, 4).toString('latin1') === 'GIF8') return 'image/gif';
  if (buf.subarray(0, 4).toString('latin1') === 'RIFF'
    && buf.subarray(8, 12).toString('latin1') === 'WEBP') return 'image/webp';
  return null;
}

function pngSize(buf) {
  // IHDR is mandated to be the first chunk: length(4) type(4) then W,H.
  if (buf.length < 24) return null;
  if (buf.subarray(12, 16).toString('latin1') !== 'IHDR') return null;
  return { width: buf.readUInt32BE(16), height: buf.readUInt32BE(20) };
}

function gifSize(buf) {
  if (buf.length < 10) return null;
  return { width: buf.readUInt16LE(6), height: buf.readUInt16LE(8) };
}

function webpSize(buf) {
  if (buf.length < 30) return null;
  const fourcc = buf.subarray(12, 16).toString('latin1');
  if (fourcc === 'VP8 ') {
    // Lossy: 3-byte frame tag, 3-byte sync code 9d 01 2a, then 14-bit W/H.
    if (buf[23] !== 0x9d || buf[24] !== 0x01 || buf[25] !== 0x2a) return null;
    return { width: buf.readUInt16LE(26) & 0x3fff, height: buf.readUInt16LE(28) & 0x3fff };
  }
  if (fourcc === 'VP8L') {
    // Lossless: 0x2f signature byte then 14+14 bits of (dimension - 1).
    if (buf[20] !== 0x2f) return null;
    const bits = buf.readUInt32LE(21);
    return { width: (bits & 0x3fff) + 1, height: ((bits >> 14) & 0x3fff) + 1 };
  }
  if (fourcc === 'VP8X') {
    // Extended: 24-bit little-endian (canvas dimension - 1).
    const w = buf[24] | (buf[25] << 8) | (buf[26] << 16);
    const h = buf[27] | (buf[28] << 8) | (buf[29] << 16);
    return { width: w + 1, height: h + 1 };
  }
  return null;
}

function jpegSize(buf) {
  let off = 2; // past SOI
  while (off + 9 < buf.length) {
    if (buf[off] !== 0xff) { off += 1; continue; } // resync on padding garbage
    let marker = buf[off + 1];
    // 0xFF fill bytes may precede the real marker.
    while (marker === 0xff && off + 2 < buf.length) { off += 1; marker = buf[off + 1]; }
    if (marker === 0xd8 || marker === 0x01 || (marker >= 0xd0 && marker <= 0xd7)) {
      off += 2; // standalone markers carry no length
      continue;
    }
    if (marker === 0xd9 || marker === 0xda) return null; // EOI / start of scan
    const len = buf.readUInt16BE(off + 2);
    if (len < 2) return null;
    // SOF0..SOF15 carry the frame dimensions; C4 (DHT), C8 (JPG), CC (DAC) do not.
    const isSof = marker >= 0xc0 && marker <= 0xcf
      && marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc;
    if (isSof) {
      if (off + 9 > buf.length) return null;
      return { height: buf.readUInt16BE(off + 5), width: buf.readUInt16BE(off + 7) };
    }
    off += 2 + len;
  }
  return null;
}

/**
 * Width/height from the image header alone. Never throws — a malformed or
 * unsupported image yields null and the row simply stores NULL dimensions.
 */
export function imageDimensions(buf, mimeHint = '') {
  if (!Buffer.isBuffer(buf) || buf.length < 12) return null;
  const mime = sniffMime(buf) || String(mimeHint || '');
  try {
    if (mime === 'image/png') return pngSize(buf);
    if (mime === 'image/gif') return gifSize(buf);
    if (mime === 'image/webp') return webpSize(buf);
    if (mime === 'image/jpeg') return jpegSize(buf);
  } catch {
    return null; // truncated buffer — metadata, not a failure
  }
  return null;
}

// ===========================================================================
// 2. SSRF guard for external-URL import.
//
// Ported from the money path's own guard (trackingDelivery.js:214-283) rather
// than re-derived: a scheme check is NOT validation — `https://169.254.169.254/`
// is a perfectly valid https URL that reads cloud instance credentials. The
// host is RESOLVED and refused if ANY answer is private/loopback/link-local.
// Fails CLOSED on a resolution error.
//
// Difference from the money path, on purpose: there, loopback http is allowed
// outside production (a dev relay). Here it is NEVER allowed by NODE_ENV
// alone — an operator running the dashboard in `development` on a laptop still
// must not be able to point /import-url at 127.0.0.1. The only escape hatch is
// the explicit MEDIA_IMPORT_ALLOW_HOST allow-list, which is hard-disabled when
// NODE_ENV === 'production'.
// ===========================================================================

const SSRF_HOST_DENY = new Set([
  'localhost', 'metadata', 'metadata.google.internal',
  'instance-data', 'metadata.goog',
]);

export function isPublicAddress(addr) {
  if (net.isIPv4(addr)) {
    const [a, b] = addr.split('.').map(Number);
    if (a === 10 || a === 127 || a === 0) return false;        // private / loopback / unspecified
    if (a === 172 && b >= 16 && b <= 31) return false;         // private
    if (a === 192 && b === 168) return false;                  // private
    if (a === 169 && b === 254) return false;                  // link-local / cloud metadata
    if (a === 100 && b >= 64 && b <= 127) return false;        // CGNAT
    if (a >= 224) return false;                                // multicast / reserved
    return true;
  }
  if (net.isIPv6(addr)) {
    const x = addr.toLowerCase();
    if (x === '::' || x === '::1') return false;
    if (x.startsWith('fe80') || x.startsWith('fc') || x.startsWith('fd')) return false;
    if (x.startsWith('ff')) return false;
    // IPv4-mapped must be judged as IPv4. WHATWG URL canonicalizes
    // ::ffff:169.254.169.254 into HEX form, so match BOTH — the dotted form
    // alone is a bypass.
    const dotted = x.match(/::ffff:(\d+\.\d+\.\d+\.\d+)$/);
    if (dotted) return isPublicAddress(dotted[1]);
    const hex = x.match(/^::ffff:([0-9a-f]{1,4}):([0-9a-f]{1,4})$/);
    if (hex) {
      const n = ((parseInt(hex[1], 16) << 16) | parseInt(hex[2], 16)) >>> 0;
      const v4 = [(n >>> 24) & 255, (n >>> 16) & 255, (n >>> 8) & 255, n & 255].join('.');
      return isPublicAddress(v4);
    }
    return true;
  }
  return false;
}

// Test/dev-only host allow-list, e.g. MEDIA_IMPORT_ALLOW_HOST=127.0.0.1:51234
// Hard-off in production regardless of the env var's value.
function allowListed(u) {
  if (process.env.NODE_ENV === 'production') return false;
  const raw = String(process.env.MEDIA_IMPORT_ALLOW_HOST || '').trim();
  if (!raw) return false;
  const hostport = u.host.toLowerCase();
  return raw.split(',').map((s) => s.trim().toLowerCase()).filter(Boolean).includes(hostport);
}

/**
 * @returns {Promise<true|'scheme'|'blocked_host'|'dns_resolution_failed'>}
 */
export async function importUrlAllowed(rawUrl) {
  let u;
  try { u = new URL(String(rawUrl)); } catch { return 'scheme'; }
  if (allowListed(u)) return true;
  if (u.protocol !== 'https:') return 'scheme';
  const host = u.hostname.toLowerCase().replace(/^\[|\]$/g, '');
  if (!host) return 'scheme';
  if (SSRF_HOST_DENY.has(host) || host.endsWith('.localhost')) return 'blocked_host';
  if (net.isIP(host)) return isPublicAddress(host) ? true : 'blocked_host';
  let answers;
  try {
    answers = await dns.lookup(host, { all: true, verbatim: true });
  } catch {
    return 'dns_resolution_failed';
  }
  if (!answers.length) return 'dns_resolution_failed';
  return answers.every((a) => isPublicAddress(a.address)) ? true : 'blocked_host';
}

/**
 * Download an external image with a hard byte cap enforced DURING the stream,
 * not after. brandSpyMediaMirror.js learned this the expensive way: an
 * arrayBuffer()-then-check buffers the whole body (twice, with the Buffer
 * copy) before the cap can fire — on a 512 MB dyno that IS the OOM.
 *
 * @throws {Error} with .code in
 *   'fetch_failed' | 'upstream_status' | 'too_large' | 'unsupported_type' | 'empty_body'
 */
export async function fetchExternalImage(url, { maxBytes = MAX_IMPORT_BYTES } = {}) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);
  if (timer.unref) timer.unref();
  let resp;
  try {
    resp = await fetch(url, {
      // A 302 can walk a validated public host to an unvalidated private one —
      // the reference guard has exactly that hole. Refuse to follow.
      redirect: 'manual',
      signal: controller.signal,
      headers: { Accept: 'image/*' },
    });
  } catch (err) {
    clearTimeout(timer);
    const e = new Error('fetch_failed');
    e.code = 'fetch_failed';
    e.detail = String((err && err.message) || err);
    throw e;
  }
  try {
    if (!resp.ok) {
      const e = new Error('upstream_status');
      e.code = 'upstream_status';
      e.status = resp.status;
      throw e;
    }
    const declared = String(resp.headers.get('content-type') || '').split(';')[0].trim().toLowerCase();
    if (declared && !declared.startsWith('image/')) {
      const e = new Error('unsupported_type');
      e.code = 'unsupported_type';
      e.detail = declared;
      throw e;
    }
    // Trust the advertised length as an EARLY refusal only; it is a hint, so
    // the streaming cap below still runs.
    const advertised = Number(resp.headers.get('content-length') || 0);
    if (advertised && advertised > maxBytes) {
      const e = new Error('too_large');
      e.code = 'too_large';
      e.detail = String(advertised);
      throw e;
    }
    const chunks = [];
    let total = 0;
    for await (const chunk of resp.body) {
      const b = Buffer.from(chunk);
      total += b.length;
      if (total > maxBytes) {
        try { await resp.body.cancel?.(); } catch { /* already torn down */ }
        const e = new Error('too_large');
        e.code = 'too_large';
        e.detail = `>${maxBytes}`;
        throw e;
      }
      chunks.push(b);
    }
    const buf = Buffer.concat(chunks, total);
    if (!buf.length) {
      const e = new Error('empty_body');
      e.code = 'empty_body';
      throw e;
    }
    // The DECLARED type is a claim; the bytes are the fact. An `image/png`
    // header over a zip is still a zip.
    const sniffed = sniffMime(buf);
    if (!sniffed || !ALLOWED_MIME.has(sniffed)) {
      const e = new Error('unsupported_type');
      e.code = 'unsupported_type';
      e.detail = sniffed || declared || 'unknown';
      throw e;
    }
    return { buffer: buf, mime: sniffed, bytes: buf.length };
  } finally {
    clearTimeout(timer);
  }
}

// ===========================================================================
// 3. Storage backends.
// ===========================================================================

export function shopifyCreds() {
  // Byte-identical resolution order to checkoutPricing.js:83-87 — the media
  // library must never end up talking to a DIFFERENT store than the money path.
  return {
    store: process.env.PUURE_SHOPIFY_STORE || process.env.SHOPIFY_STORE_DOMAIN || '',
    token: process.env.PUURE_SHOPIFY_TOKEN || process.env.SHOPIFY_ACCESS_TOKEN || '',
    apiVersion: process.env.SHOPIFY_API_VERSION || '2024-01',
  };
}

function shopifyGraphqlUrl() {
  const { store, apiVersion } = shopifyCreds();
  const base = String(process.env.MEDIA_SHOPIFY_API_BASE || '').replace(/\/+$/, '');
  const origin = base || `https://${store}`;
  return `${origin}/admin/api/${apiVersion}/graphql.json`;
}

export function isShopifyConfigured() {
  const { store, token } = shopifyCreds();
  return Boolean((store || process.env.MEDIA_SHOPIFY_API_BASE) && token);
}

/**
 * Which backend a putImage() call would use right now.
 * @returns {'shopify'|'r2'|null}
 */
export function storageBackend() {
  const forced = String(process.env.MEDIA_STORAGE_BACKEND || '').trim().toLowerCase();
  if (forced === 'shopify') return isShopifyConfigured() ? 'shopify' : null;
  if (forced === 'r2') return isR2Configured() ? 'r2' : null;
  if (forced === 'none') return null;
  if (isShopifyConfigured()) return 'shopify';
  if (isR2Configured()) return 'r2';
  return null;
}

async function shopifyGraphql(query, variables) {
  const { token } = shopifyCreds();
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);
  if (timer.unref) timer.unref();
  let resp;
  try {
    resp = await fetch(shopifyGraphqlUrl(), {
      method: 'POST',
      // The Admin token goes in a HEADER, never the URL: a request line is
      // logged by every proxy it crosses.
      headers: { 'Content-Type': 'application/json', 'X-Shopify-Access-Token': token },
      body: JSON.stringify({ query, variables }),
      signal: controller.signal,
    });
  } catch (err) {
    throw new StorageUnavailableError('shopify_fetch_failed', String((err && err.message) || err));
  } finally {
    clearTimeout(timer);
  }
  if (resp.status === 401 || resp.status === 403) {
    // 401/403 on the Admin API is the SCOPE/credential signal, and it is the
    // one the operator can actually act on. Never collapse it into a generic
    // transport error.
    throw new StorageUnavailableError('shopify_scope_missing', `http_${resp.status}`);
  }
  if (!resp.ok) throw new StorageUnavailableError('shopify_http', `http_${resp.status}`);
  let payload;
  try { payload = await resp.json(); } catch {
    throw new StorageUnavailableError('shopify_bad_json');
  }
  if (payload?.errors) {
    const msg = JSON.stringify(payload.errors).slice(0, 300);
    // Shopify reports a missing access scope as a top-level error whose
    // message contains "access scope" / ACCESS_DENIED.
    if (/access scope|ACCESS_DENIED|not approved to access/i.test(msg)) {
      throw new StorageUnavailableError('shopify_scope_missing', msg);
    }
    throw new StorageUnavailableError('shopify_graphql_errors', msg);
  }
  return payload?.data || {};
}

function firstUserError(node) {
  const errs = (node && node.userErrors) || [];
  return errs.length ? errs[0] : null;
}

function raiseUserError(err, where) {
  const msg = `${where}: ${err.code || ''} ${err.message || ''}`.trim();
  if (/ACCESS_DENIED|access scope|write_files/i.test(msg)) {
    throw new StorageUnavailableError('shopify_scope_missing', msg);
  }
  throw new StorageUnavailableError('shopify_user_error', msg);
}

const Q_STAGED = `
mutation stagedUploadsCreate($input: [StagedUploadInput!]!) {
  stagedUploadsCreate(input: $input) {
    stagedTargets { url resourceUrl parameters { name value } }
    userErrors { field message }
  }
}`.trim();

const Q_FILE_CREATE = `
mutation fileCreate($files: [FileCreateInput!]!) {
  fileCreate(files: $files) {
    files {
      id
      fileStatus
      alt
      ... on MediaImage { image { url width height } }
    }
    userErrors { field message code }
  }
}`.trim();

const Q_FILE_POLL = `
query fileStatus($id: ID!) {
  node(id: $id) {
    ... on MediaImage {
      id
      fileStatus
      fileErrors { code details message }
      image { url width height }
    }
  }
}`.trim();

/**
 * Build a multipart/form-data body by hand.
 *
 * There is NO multer (or any multipart parser) in package.json and adding one
 * for a single outbound request would be a dependency for nothing. Shopify's
 * staged target requires the pre-signed `parameters` to appear BEFORE the file
 * part, in order — GCS rejects the POST otherwise.
 */
function buildMultipart(parameters, { filename, mime, buffer }) {
  const boundary = `----puureMedia${crypto.randomBytes(12).toString('hex')}`;
  const parts = [];
  for (const p of parameters || []) {
    parts.push(Buffer.from(
      `--${boundary}\r\nContent-Disposition: form-data; name="${p.name}"\r\n\r\n${p.value}\r\n`,
      'utf8'
    ));
  }
  parts.push(Buffer.from(
    `--${boundary}\r\nContent-Disposition: form-data; name="file"; filename="${filename}"\r\n`
    + `Content-Type: ${mime}\r\n\r\n`,
    'utf8'
  ));
  parts.push(buffer);
  parts.push(Buffer.from(`\r\n--${boundary}--\r\n`, 'utf8'));
  return { body: Buffer.concat(parts), contentType: `multipart/form-data; boundary=${boundary}` };
}

async function putViaShopify({ buffer, filename, mime, alt = '' }) {
  // ── 1. stagedUploadsCreate ────────────────────────────────────────────────
  const staged = await shopifyGraphql(Q_STAGED, {
    input: [{
      filename,
      mimeType: mime,
      httpMethod: 'POST',
      resource: 'FILE',
      fileSize: String(buffer.length),
    }],
  });
  const sNode = staged.stagedUploadsCreate;
  const sErr = firstUserError(sNode);
  if (sErr) raiseUserError(sErr, 'stagedUploadsCreate');
  const target = (sNode && sNode.stagedTargets && sNode.stagedTargets[0]) || null;
  if (!target || !target.url || !target.resourceUrl) {
    throw new StorageUnavailableError('shopify_no_staged_target');
  }
  // The staged target comes from Shopify, but it still lands in a fetch() —
  // refuse a plaintext one unless the test seam is deliberately active.
  if (!/^https:/i.test(target.url) && !process.env.MEDIA_SHOPIFY_API_BASE) {
    throw new StorageUnavailableError('shopify_insecure_target');
  }

  // ── 2. POST the bytes at the staged target ───────────────────────────────
  const { body, contentType } = buildMultipart(target.parameters, { filename, mime, buffer });
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);
  if (timer.unref) timer.unref();
  let up;
  try {
    up = await fetch(target.url, {
      method: 'POST',
      headers: { 'Content-Type': contentType },
      body,
      signal: controller.signal,
    });
  } catch (err) {
    throw new StorageUnavailableError('staged_upload_failed', String((err && err.message) || err));
  } finally {
    clearTimeout(timer);
  }
  if (!(up.status >= 200 && up.status < 400)) {
    throw new StorageUnavailableError('staged_upload_failed', `http_${up.status}`);
  }

  // ── 3. fileCreate ────────────────────────────────────────────────────────
  const created = await shopifyGraphql(Q_FILE_CREATE, {
    files: [{ alt: String(alt || ''), contentType: 'IMAGE', originalSource: target.resourceUrl }],
  });
  const cNode = created.fileCreate;
  const cErr = firstUserError(cNode);
  if (cErr) raiseUserError(cErr, 'fileCreate');
  const file = (cNode && cNode.files && cNode.files[0]) || null;
  if (!file || !file.id) throw new StorageUnavailableError('shopify_no_file');

  if (file.fileStatus === 'READY' && file.image?.url) {
    return {
      url: file.image.url,
      shopifyFileId: file.id,
      width: file.image.width || null,
      height: file.image.height || null,
    };
  }

  // ── 4. poll until READY (fileCreate returns UPLOADED, not READY) ─────────
  const deadline = Date.now() + POLL_TIMEOUT_MS;
  let lastStatus = file.fileStatus || 'UNKNOWN';
  while (Date.now() < deadline) {
    await new Promise((r) => { const t = setTimeout(r, POLL_INTERVAL_MS); if (t.unref) t.unref(); });
    const polled = await shopifyGraphql(Q_FILE_POLL, { id: file.id });
    const node = polled.node;
    if (!node) continue;
    lastStatus = node.fileStatus || lastStatus;
    if (lastStatus === 'FAILED') {
      const detail = JSON.stringify(node.fileErrors || []).slice(0, 200);
      throw new StorageUnavailableError('shopify_file_failed', detail);
    }
    if (lastStatus === 'READY' && node.image?.url) {
      return {
        url: node.image.url,
        shopifyFileId: node.id || file.id,
        width: node.image.width || null,
        height: node.image.height || null,
      };
    }
  }
  // A timeout here is NOT a stored asset. Refusing beats writing a row whose
  // url is null and whose CDN object may or may not arrive later.
  throw new StorageUnavailableError('shopify_poll_timeout', lastStatus);
}

async function putViaR2({ buffer, filename, mime }) {
  const ext = EXT_BY_MIME[mime] || 'bin';
  const key = `media-library/${crypto.randomUUID()}.${ext}`;
  let url;
  try {
    url = await uploadBuffer(buffer, key, mime);
  } catch (err) {
    throw new StorageUnavailableError('r2_upload_failed', String((err && err.message) || err));
  }
  if (!url || url.startsWith('r2://')) {
    // r2.js returns an r2:// pseudo-url when R2_PUBLIC_URL is unset. That is
    // NOT a browser-reachable url, so it must never reach a funnel page.
    throw new StorageUnavailableError('r2_public_url_missing', String(filename || ''));
  }
  return { url, shopifyFileId: null, width: null, height: null };
}

/**
 * Store image bytes on the configured CDN backend.
 *
 * @param {{buffer: Buffer, filename: string, mime: string, alt?: string}} input
 * `filename` comes back SANITIZED — the caller must persist THAT, not the
 * client's original. Storing the raw name and sending the safe one would put a
 * `../../etc/passwd`-shaped string in the library grid and make the row's
 * filename disagree with the object actually on the CDN.
 *
 * @returns {Promise<{url: string, filename: string, shopifyFileId: string|null,
 *                    width: number|null, height: number|null,
 *                    backend: 'shopify'|'r2'}>}
 * @throws {StorageUnavailableError} — .code is the operator-actionable reason.
 */
export async function putImage({ buffer, filename, mime, alt = '' }) {
  const backend = storageBackend();
  if (!backend) throw new StorageUnavailableError('storage_not_configured');
  const safeName = sanitizeFilename(filename, mime);
  const out = backend === 'shopify'
    ? await putViaShopify({ buffer, filename: safeName, mime, alt })
    : await putViaR2({ buffer, filename: safeName, mime });
  return { ...out, filename: safeName, backend };
}

/**
 * Filenames land in a multipart Content-Disposition header and in Shopify's
 * file list. Strip path separators, quotes, CR/LF (header injection) and any
 * control character, then force an extension that matches the SNIFFED mime.
 */
export function sanitizeFilename(name, mime) {
  const ext = EXT_BY_MIME[mime] || 'bin';
  let base = String(name || '')
    .replace(/[\r\n]/g, '')
    .split(/[\\/]/).pop() || '';
  // eslint-disable-next-line no-control-regex
  base = base.replace(/[\x00-\x1f"'`]/g, '').replace(/\.[A-Za-z0-9]{1,8}$/, '').trim();
  base = base.replace(/[^A-Za-z0-9._-]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 80);
  if (!base) base = `image-${Date.now()}`;
  return `${base}.${ext}`;
}

export default {
  ensureLoaded: true,
  putImage,
  storageBackend,
  imageDimensions,
  sniffMime,
  importUrlAllowed,
  fetchExternalImage,
  sanitizeFilename,
  newMediaId,
  StorageUnavailableError,
};
