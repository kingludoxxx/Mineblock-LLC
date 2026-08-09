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
import http from 'node:http';
import https from 'node:https';
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

// Every numeric env read goes through this. `Number(undefined)` is NaN and
// NaN silently disables a timeout (`setTimeout(fn, NaN)` fires immediately,
// `Date.now() < NaN` is false forever), so a typo'd env var must fall back to
// the default rather than reshape the control flow.
function envInt(name, fallback, { min = 1, max = Number.MAX_SAFE_INTEGER } = {}) {
  const raw = process.env[name];
  if (raw === undefined || raw === null || String(raw).trim() === '') return fallback;
  const n = Number(raw);
  if (!Number.isFinite(n)) return fallback;
  const i = Math.trunc(n);
  if (i < min || i > max) return fallback;
  return i;
}

const FETCH_TIMEOUT_MS = 15_000;
const POLL_TIMEOUT_MS = envInt('MEDIA_SHOPIFY_POLL_TIMEOUT_MS', 20_000, { max: 300_000 });
const POLL_INTERVAL_MS = envInt('MEDIA_SHOPIFY_POLL_INTERVAL_MS', 500, { max: 60_000 });
// ONE budget across every Shopify leg (staged create + staged POST + fileCreate
// + the whole poll loop). Per-leg timeouts alone bound nothing: four legs at
// 15s plus a 20s poll is a 75s worst case, well past any sane request budget,
// and the caller is a browser holding an upload open.
const SHOPIFY_BUDGET_MS = envInt('MEDIA_SHOPIFY_BUDGET_MS', 45_000, { max: 300_000 });

// PostgreSQL int4 range — width/height are INTEGER columns.
const INT4_MAX = 2147483647;

export const newMediaId = () => `med_${crypto.randomBytes(9).toString('hex')}`;

// Test seam for the SSRF/rebinding harness. The guard must resolve the host
// ONCE and the connection must reuse that exact answer, which is only
// observable if the test can control what each resolution returns.
export const _dnsHooks = {
  lookup: (hostname) => dns.lookup(hostname, { all: true, verbatim: true }),
};
// Observability for the harness: every address actually handed to a socket.
export const _probe = { pinnedAddresses: [], dnsCalls: 0 };

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
 * A header is ATTACKER-CONTROLLED DATA, not a measurement. PNG stores width and
 * height as unsigned 32-bit ints, so a 13-byte IHDR can legally claim
 * 4294967295 x 4294967295 — a number that is not a picture, it is a lie. Left
 * unclamped it reaches an INTEGER column and the INSERT raises
 * `value out of range for type integer` AFTER the bytes are already on the CDN:
 * the caller gets an unstructured 500 and the object is orphaned with no row
 * pointing at it.
 *
 * Anything <= 0 or beyond int4 is therefore treated as ABSENT, not as an error.
 * Dimensions are metadata; a bad header must never cost an upload.
 */
function sane(dims) {
  if (!dims) return null;
  const { width, height } = dims;
  if (!Number.isInteger(width) || !Number.isInteger(height)) return null;
  if (width <= 0 || height <= 0) return null;
  if (width > INT4_MAX || height > INT4_MAX) return null;
  return { width, height };
}

/**
 * Width/height from the image header alone. Never throws — a malformed,
 * unsupported, or LYING header yields null and the row stores NULL dimensions.
 */
export function imageDimensions(buf, mimeHint = '') {
  if (!Buffer.isBuffer(buf) || buf.length < 12) return null;
  const mime = sniffMime(buf) || String(mimeHint || '');
  try {
    if (mime === 'image/png') return sane(pngSize(buf));
    if (mime === 'image/gif') return sane(gifSize(buf));
    if (mime === 'image/webp') return sane(webpSize(buf));
    if (mime === 'image/jpeg') return sane(jpegSize(buf));
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
    const [a, b, c] = addr.split('.').map(Number);
    if (a === 10 || a === 127 || a === 0) return false;        // private / loopback / unspecified
    if (a === 172 && b >= 16 && b <= 31) return false;         // private
    if (a === 192 && b === 168) return false;                  // private
    // 192.0.0.0/24 — IETF protocol assignments (incl. the NAT64 well-known
    // prefix). /24, so the THIRD octet matters: 192.0.1.1 is ordinary public
    // space and must still resolve.
    if (a === 192 && b === 0 && c === 0) return false;
    if (a === 169 && b === 254) return false;                  // link-local / cloud metadata
    if (a === 100 && b >= 64 && b <= 127) return false;        // CGNAT
    if (a === 198 && (b === 18 || b === 19)) return false;      // 198.18/15 benchmarking (RFC 2544)
    if (a >= 224) return false;                                // multicast / reserved
    return true;
  }
  if (net.isIPv6(addr)) {
    const x = addr.toLowerCase();
    if (x === '::' || x === '::1') return false;
    // Link-local is fe80::/10 — that is fe80 THROUGH febf, not just the fe80
    // prefix string. `fe9a::1` is link-local and a prefix match misses it.
    const head = parseInt(x.split(':')[0] || '0', 16);
    if (Number.isFinite(head) && head >= 0xfe80 && head <= 0xfebf) return false;
    if (x.startsWith('fc') || x.startsWith('fd')) return false;   // ULA fc00::/7
    if (x.startsWith('ff')) return false;                         // multicast
    // 6to4 (2002::/16) and NAT64 (64:ff9b::/96) both EMBED an IPv4 address and
    // are routed to it — refusing the wrapper is the only way to refuse the
    // target. We cannot cheaply extract every embedded form, so refuse the
    // whole prefix; neither belongs in an image URL.
    if (x.startsWith('2002:')) return false;
    if (/^64:ff9b:/.test(x)) return false;
    // IPv4-mapped/compatible must be judged as IPv4. WHATWG URL canonicalizes
    // ::ffff:169.254.169.254 into HEX form, so match BOTH — the dotted form
    // alone is a bypass.
    const dotted = x.match(/::(?:ffff:)?(\d+\.\d+\.\d+\.\d+)$/);
    if (dotted) return isPublicAddress(dotted[1]);
    const hex = x.match(/^::(?:ffff:)?([0-9a-f]{1,4}):([0-9a-f]{1,4})$/);
    if (hex) {
      const n = ((parseInt(hex[1], 16) << 16) | parseInt(hex[2], 16)) >>> 0;
      const v4 = [(n >>> 24) & 255, (n >>> 16) & 255, (n >>> 8) & 255, n & 255].join('.');
      return isPublicAddress(v4);
    }
    return true;
  }
  return false;
}

// Test/dev-only host allow-list, e.g. MEDIA_IMPORT_ALLOW_HOST=media-mock.test:51234
//
// DELIBERATELY NARROW: it relaxes exactly two things — the https-only rule and
// the is-this-address-public verdict — and nothing else. URL parsing, the host
// deny-list, DNS resolution, address PINNING, redirect refusal, the byte cap
// and the magic-byte sniff all still run for an allow-listed host, so the test
// suite's happy path exercises the real pipeline rather than stepping around
// it. Hard-off in production regardless of the env var's value.
function allowListed(u) {
  if (process.env.NODE_ENV === 'production') return false;
  const raw = String(process.env.MEDIA_IMPORT_ALLOW_HOST || '').trim();
  if (!raw) return false;
  const hostport = String(u.host || '').toLowerCase();
  return raw.split(',').map((s) => s.trim().toLowerCase()).filter(Boolean).includes(hostport);
}

/**
 * Resolve and vet an import URL.
 *
 * Returns the RESOLVED ADDRESSES on success because the caller must connect to
 * one of THOSE, not re-resolve the name. See fetchExternalImage.
 *
 * @returns {Promise<{ok: true, addresses: string[], relaxed: boolean}
 *                  | {ok: false, reason: 'scheme'|'blocked_host'|'dns_resolution_failed'}>}
 */
export async function importUrlAllowed(rawUrl) {
  const no = (reason) => ({ ok: false, reason });
  let u;
  try { u = new URL(String(rawUrl)); } catch { return no('scheme'); }
  const relaxed = allowListed(u);
  if (u.protocol !== 'https:' && !(relaxed && u.protocol === 'http:')) return no('scheme');
  const host = u.hostname.toLowerCase().replace(/^\[|\]$/g, '');
  if (!host) return no('scheme');
  if (SSRF_HOST_DENY.has(host) || host.endsWith('.localhost')) return no('blocked_host');
  if (net.isIP(host)) {
    if (!relaxed && !isPublicAddress(host)) return no('blocked_host');
    return { ok: true, addresses: [host], relaxed };
  }
  let answers;
  try {
    _probe.dnsCalls += 1;
    answers = await _dnsHooks.lookup(host);
  } catch {
    return no('dns_resolution_failed');
  }
  if (!Array.isArray(answers) || !answers.length) return no('dns_resolution_failed');
  const addresses = answers.map((a) => (typeof a === 'string' ? a : a.address)).filter(Boolean);
  if (!addresses.length) return no('dns_resolution_failed');
  // EVERY answer must be public. A name that resolves to one public and one
  // private address is a rebinding attempt, not a multi-homed host.
  if (!relaxed && !addresses.every((a) => isPublicAddress(a))) return no('blocked_host');
  return { ok: true, addresses, relaxed };
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
export async function fetchExternalImage(url, {
  maxBytes = MAX_IMPORT_BYTES,
  addresses = null,
  relaxed = false,
} = {}) {
  const fail = (code, detail, extra = {}) => {
    const e = new Error(code);
    e.code = code;
    if (detail !== undefined) e.detail = detail;
    return Object.assign(e, extra);
  };

  const u = new URL(String(url));
  const isHttps = u.protocol === 'https:';
  const mod = isHttps ? https : http;

  // ── DNS PINNING (the rebinding fix) ──────────────────────────────────────
  // The guard resolved this host and judged the answers. If the connection is
  // allowed to resolve the name AGAIN, an attacker controlling the zone can
  // answer 93.184.216.34 for the check and 169.254.169.254 microseconds later
  // for the socket — the classic TOCTOU. So we hand the agent a `lookup` that
  // can only ever return an address the guard already approved, and re-runs
  // isPublicAddress on it as a second line of defence.
  //
  // This is done with node:https rather than fetch() because pinning needs a
  // custom `lookup`, which fetch only exposes through an undici Agent — and
  // undici is NOT a dependency of this repo (checked: not in package.json, not
  // resolvable). node:https keeps SNI and certificate validation pointed at
  // the real hostname, which is what makes the pin safe for TLS.
  const pinned = Array.isArray(addresses) && addresses.length ? addresses : null;
  const lookup = pinned
    ? (hostname, opts, cb) => {
      const addr = pinned.find((a) => relaxed || isPublicAddress(a));
      if (!addr) { cb(fail('blocked_host', hostname)); return; }
      _probe.pinnedAddresses.push(addr);
      const family = net.isIPv6(addr) ? 6 : 4;
      // `all: true` changes the callback's contract to an array.
      if (opts && opts.all) cb(null, [{ address: addr, family }]);
      else cb(null, addr, family);
    }
    : undefined;

  // A FRESH agent with keep-alive OFF. The global agent pools sockets, and a
  // pooled socket skips `lookup` entirely — which would silently un-pin a
  // later request to the same host:port and made the pinning assertion in the
  // harness pass for the wrong reason. Import is a rare, security-sensitive
  // call; a connection per request is the correct trade.
  const agent = new mod.Agent({ keepAlive: false, maxSockets: 1 });

  const res = await new Promise((resolve, reject) => {
    const req = mod.request(
      {
        protocol: u.protocol,
        hostname: u.hostname.replace(/^\[|\]$/g, ''),
        port: u.port || (isHttps ? 443 : 80),
        path: `${u.pathname}${u.search}`,
        method: 'GET',
        headers: { Accept: 'image/*', Host: u.host },
        agent,
        lookup,
        // node:https honours `servername` from hostname by default; leaving it
        // implicit keeps cert validation against the NAME, not the pinned IP.
      },
      resolve
    );
    req.setTimeout(FETCH_TIMEOUT_MS, () => {
      req.destroy(fail('fetch_failed', 'timeout'));
    });
    req.on('error', (err) => reject(err.code ? err : fail('fetch_failed', String(err && err.message))));
    req.end();
  }).catch((err) => { throw (err.code && typeof err.code === 'string' && !err.errno ? err : fail('fetch_failed', String(err && err.message))); });

  try {
    const status = res.statusCode || 0;
    // A 3xx can walk a validated public host to an unvalidated private one —
    // the reference guard has exactly that hole. We do not follow, and we do
    // not silently treat it as an error either: it gets its own code.
    if (status >= 300 && status < 400) {
      throw fail('redirect_refused', String(status), { status });
    }
    if (status < 200 || status >= 300) {
      throw fail('upstream_status', String(status), { status });
    }
    const declared = String(res.headers['content-type'] || '').split(';')[0].trim().toLowerCase();
    if (declared && !declared.startsWith('image/')) {
      throw fail('unsupported_type', declared);
    }
    // The advertised length is an EARLY refusal only; it is a hint from the
    // same party we are defending against, so the streaming cap still runs.
    const advertised = Number(res.headers['content-length'] || 0);
    if (Number.isFinite(advertised) && advertised > maxBytes) {
      throw fail('too_large', String(advertised));
    }

    const buf = await new Promise((resolve, reject) => {
      const chunks = [];
      let total = 0;
      // `settled` matters: destroying the socket to stop an oversize download
      // makes the stream emit 'aborted'/'error' a tick later, and without this
      // guard that generic failure would overwrite the specific `too_large`
      // verdict the caller needs to turn into a 413.
      let settled = false;
      const done = (fn, v) => { if (settled) return; settled = true; fn(v); };
      res.on('data', (chunk) => {
        total += chunk.length;
        if (total > maxBytes) {
          done(reject, fail('too_large', `>${maxBytes}`));
          // Destroy AFTER settling — draining a hostile 10GB body to be polite
          // is how a 512MB dyno dies, but the verdict is recorded first.
          res.destroy();
          return;
        }
        chunks.push(chunk);
      });
      res.on('error', (err) => done(reject, fail('fetch_failed', String(err && err.message))));
      res.on('end', () => done(resolve, Buffer.concat(chunks, total)));
      res.on('aborted', () => done(reject, fail('fetch_failed', 'aborted')));
    });

    if (!buf.length) throw fail('empty_body');
    // The DECLARED type is a claim; the bytes are the fact. An `image/png`
    // header over a zip is still a zip.
    const sniffed = sniffMime(buf);
    if (!sniffed || !ALLOWED_MIME.has(sniffed)) {
      throw fail('unsupported_type', sniffed || declared || 'unknown');
    }
    return { buffer: buf, mime: sniffed, bytes: buf.length };
  } finally {
    if (!res.destroyed) res.resume(); // release the socket on every path
    agent.destroy();
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
 * R2 is only USABLE here if it can also produce a browser-reachable URL.
 *
 * r2.js's own isR2Configured() checks the three credential vars and nothing
 * else; without R2_PUBLIC_URL its uploadBuffer() still performs (and bills) a
 * PutObject and then returns an `r2://bucket/key` pseudo-URL that no browser
 * can load. Advertising that as a working backend means every upload costs a
 * write and ends in a 503. Requiring the public base makes the backend
 * honestly unavailable BEFORE the bytes move. (r2.js is another lane's file —
 * the extra condition lives here, not there.)
 */
function isR2Usable() {
  return isR2Configured() && Boolean(String(process.env.R2_PUBLIC_URL || '').trim());
}

/**
 * Which backend a putImage() call would use right now.
 * @returns {'shopify'|'r2'|null}
 */
export function storageBackend() {
  const forced = String(process.env.MEDIA_STORAGE_BACKEND || '').trim().toLowerCase();
  if (forced === 'shopify') return isShopifyConfigured() ? 'shopify' : null;
  if (forced === 'r2') return isR2Usable() ? 'r2' : null;
  if (forced === 'none') return null;
  if (isShopifyConfigured()) return 'shopify';
  if (isR2Usable()) return 'r2';
  return null;
}

// ── one budget for the whole Shopify conversation (MED #5) ─────────────────
// Per-leg timeouts bound a LEG, not the request. Four legs plus a poll loop is
// a 75s worst case with 15s legs, and the caller is a browser holding an upload
// open. Every leg gets min(leg timeout, what is left of the budget).
function newBudget(ms = SHOPIFY_BUDGET_MS) {
  return { deadline: Date.now() + ms, total: ms };
}
function budgetLeft(budget) {
  if (!budget) return FETCH_TIMEOUT_MS;
  return budget.deadline - Date.now();
}
function assertBudget(budget, where) {
  if (!budget) return;
  if (budgetLeft(budget) <= 0) {
    throw new StorageUnavailableError('shopify_budget_exceeded', `${where} after ${budget.total}ms`);
  }
}

async function shopifyGraphql(query, variables, budget = null) {
  const { token } = shopifyCreds();
  assertBudget(budget, 'graphql');
  const timeoutMs = Math.max(1, Math.min(FETCH_TIMEOUT_MS, budgetLeft(budget) || FETCH_TIMEOUT_MS));
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
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
// A multipart part header is CRLF-delimited, so a CR or LF inside a name or
// value forges new headers/parts. These values come from Shopify rather than
// from a user, but "the upstream is trustworthy" is exactly the assumption that
// makes an upstream compromise catastrophic — and stripping them costs nothing.
// Quotes are stripped for the same reason: `name="a" x="b` breaks out of the
// quoted string.
const headerSafe = (v) => String(v ?? '').replace(/[\r\n"\\]/g, '');

function buildMultipart(parameters, { filename, mime, buffer }) {
  const boundary = `----puureMedia${crypto.randomBytes(12).toString('hex')}`;
  const parts = [];
  for (const p of parameters || []) {
    parts.push(Buffer.from(
      `--${boundary}\r\nContent-Disposition: form-data; name="${headerSafe(p.name)}"\r\n\r\n${headerSafe(p.value)}\r\n`,
      'utf8'
    ));
  }
  parts.push(Buffer.from(
    `--${boundary}\r\nContent-Disposition: form-data; name="file"; filename="${headerSafe(filename)}"\r\n`
    + `Content-Type: ${headerSafe(mime)}\r\n\r\n`,
    'utf8'
  ));
  parts.push(buffer);
  parts.push(Buffer.from(`\r\n--${boundary}--\r\n`, 'utf8'));
  return { body: Buffer.concat(parts), contentType: `multipart/form-data; boundary=${boundary}` };
}

// Hosts Shopify legitimately hands back as staged-upload targets. The target
// is where the IMAGE BYTES go, so a compromised or spoofed Admin response
// could otherwise redirect an upload to an attacker's collector — and we would
// POST it there ourselves, from inside the dyno. Suffix match on the
// registrable host, never a substring (`evil-shopify.com` must not pass).
const STAGED_TARGET_HOSTS = [
  'shopify.com',
  'myshopify.com',
  'storage.googleapis.com',   // shopify-staged-uploads.storage.googleapis.com
  'amazonaws.com',            // legacy/regional staged targets
];

function stagedTargetAllowed(rawUrl) {
  // The test seam deliberately points the whole conversation at a local mock.
  if (process.env.MEDIA_SHOPIFY_API_BASE) return true;
  let u;
  try { u = new URL(String(rawUrl)); } catch { return false; }
  if (u.protocol !== 'https:') return false;
  const host = u.hostname.toLowerCase();
  return STAGED_TARGET_HOSTS.some((d) => host === d || host.endsWith(`.${d}`));
}

async function putViaShopify({ buffer, filename, mime, alt = '' }, budget) {
  // ── 1. stagedUploadsCreate ────────────────────────────────────────────────
  const staged = await shopifyGraphql(Q_STAGED, {
    input: [{
      filename,
      mimeType: mime,
      httpMethod: 'POST',
      resource: 'FILE',
      fileSize: String(buffer.length),
    }],
  }, budget);
  const sNode = staged.stagedUploadsCreate;
  const sErr = firstUserError(sNode);
  if (sErr) raiseUserError(sErr, 'stagedUploadsCreate');
  const target = (sNode && sNode.stagedTargets && sNode.stagedTargets[0]) || null;
  if (!target || !target.url || !target.resourceUrl) {
    throw new StorageUnavailableError('shopify_no_staged_target');
  }
  if (!stagedTargetAllowed(target.url)) {
    throw new StorageUnavailableError('shopify_untrusted_target', String(target.url).slice(0, 120));
  }

  // ── 2. POST the bytes at the staged target ───────────────────────────────
  assertBudget(budget, 'staged_upload');
  const { body, contentType } = buildMultipart(target.parameters, { filename, mime, buffer });
  const controller = new AbortController();
  const stagedTimeout = Math.max(1, Math.min(FETCH_TIMEOUT_MS, budgetLeft(budget) || FETCH_TIMEOUT_MS));
  const timer = setTimeout(() => controller.abort(), stagedTimeout);
  if (timer.unref) timer.unref();
  let up;
  try {
    up = await fetch(target.url, {
      method: 'POST',
      headers: { 'Content-Type': contentType },
      body,
      // A 3xx here would move the bytes to an unvalidated host.
      redirect: 'manual',
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
  }, budget);
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
  // The poll window is whichever runs out first: its own timeout, or what is
  // left of the request-wide budget.
  const deadline = Math.min(
    Date.now() + POLL_TIMEOUT_MS,
    budget ? budget.deadline : Number.MAX_SAFE_INTEGER
  );
  let lastStatus = file.fileStatus || 'UNKNOWN';
  while (Date.now() < deadline) {
    await new Promise((r) => { const t = setTimeout(r, POLL_INTERVAL_MS); if (t.unref) t.unref(); });
    if (Date.now() >= deadline) break;
    const polled = await shopifyGraphql(Q_FILE_POLL, { id: file.id }, budget);
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

// Same seam idea as _dnsHooks: r2.js belongs to another lane, so the harness
// swaps the transport here rather than reaching into it.
export const _r2Hooks = { uploadBuffer };

async function putViaR2({ buffer, filename, mime }) {
  const ext = EXT_BY_MIME[mime] || 'bin';
  const key = `media-library/${crypto.randomUUID()}.${ext}`;
  let url;
  try {
    url = await _r2Hooks.uploadBuffer(buffer, key, mime);
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
    ? await putViaShopify({ buffer, filename: safeName, mime, alt }, newBudget())
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
  isPublicAddress,
  sanitizeFilename,
  newMediaId,
  StorageUnavailableError,
  _dnsHooks,
  _r2Hooks,
  _probe,
};
