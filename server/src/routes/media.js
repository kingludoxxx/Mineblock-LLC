// MEDIA LIBRARY — the funnel builder's image store (the reference tool's
// "image studio", v1).
//
// Mount (integrator-owned, routes/index.js):
//   app.use('/api/v1/media', mediaRoutes);
//
// Surface (all authenticated + funnels:access, same gate as the builder):
//   POST   /upload      { filename, mime, data }  base64 image  -> 201 { item }
//   POST   /import-url  { url, alt? }             external image-> 201 { item, rehosted }
//   GET    /            ?q=&limit=&offset=&archived=            -> 200 { items, total, ... }
//   PATCH  /:id         { alt?, archived? }                     -> 200 { item }
//   GET    /storage                                             -> 200 { backend, ... }
//
// There is NO DELETE, by design. An archived asset may still be referenced by
// a LIVE funnel page — v1 has no usage index, so a hard delete is a silent
// 404 in front of paid traffic. Archive hides it from the picker and nothing
// more. (funnel-os reached the same conclusion: listicle_builders.py:6402 is
// a soft delete too.)
//
// UPLOAD TRANSPORT — base64 JSON, not multipart. TRADEOFF, stated plainly:
// package.json carries NO multipart parser (no multer, no busboy, no formidable)
// and adding one for a v1 image picker is a new dependency on the money-path
// service. The existing clone-a-page importer already takes this exact route
// (routes/pageClone.js:314 `file_base64`), so the client helper is shared
// idiom rather than a one-off. The costs:
//   - ~33% wire overhead vs multipart, and the whole body is buffered in the
//     express json parser before the handler sees it. Mitigated by a 5 MB
//     DECODED cap that is checked against the base64 LENGTH first, so an
//     oversize payload is refused without ever being decoded.
//   - no streaming, so a genuinely large asset (video) must not use this
//     route. v1 is images only (kind='image'); video is the follow-up that
//     should bring multer with it.

import { Router } from 'express';
import { pgQuery } from '../db/pg.js';
import { authenticate } from '../middleware/auth.js';
import { requirePermission } from '../middleware/rbac.js';
import { ensureMediaTables } from '../services/mediaSchema.js';
import {
  putImage,
  storageBackend,
  imageDimensions,
  sniffMime,
  importUrlAllowed,
  fetchExternalImage,
  sanitizeFilename,
  newMediaId,
  StorageUnavailableError,
  MAX_UPLOAD_BYTES,
  MAX_IMPORT_BYTES,
  ALLOWED_MIME,
} from '../services/mediaService.js';

const router = Router();
router.use(authenticate, requirePermission('funnels', 'access'));

// ── structured errors — a caller never regexes a message ───────────────────
const fail = (res, status, code, message) =>
  res.status(status).json({ success: false, error: { code, ...(message ? { message } : {}) } });

const clamp = (v, def, min, max) => {
  const n = parseInt(v, 10);
  if (!Number.isFinite(n)) return def;
  return Math.max(min, Math.min(n, max));
};

const rowView = (r) => ({
  id: r.id,
  kind: r.kind,
  source: r.source,
  url: r.url,
  filename: r.filename || '',
  mime: r.mime || '',
  bytes: r.bytes == null ? null : Number(r.bytes),
  width: r.width == null ? null : Number(r.width),
  height: r.height == null ? null : Number(r.height),
  alt: r.alt || '',
  shopify_file_id: r.shopify_file_id || null,
  created_by: r.created_by || null,
  created_at: r.created_at,
  archived: Boolean(r.archived),
});

const SELECT_COLS = `id, kind, source, url, filename, mime, bytes, width, height,
                     alt, shopify_file_id, created_by, created_at, archived`;

async function insertRow(row) {
  const rows = await pgQuery(
    `INSERT INTO lb_media
       (id, kind, source, url, filename, mime, bytes, width, height, alt,
        shopify_file_id, created_by)
     VALUES ($1,'image',$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)
     RETURNING ${SELECT_COLS}`,
    [
      row.id, row.source, row.url, row.filename, row.mime, row.bytes,
      row.width, row.height, row.alt, row.shopifyFileId, row.createdBy,
    ]
  );
  return rows[0];
}

// Map a StorageUnavailableError onto an HTTP answer the operator can act on.
// 'shopify_scope_missing' is called out separately because its fix is a
// one-line Admin-API scope grant, and collapsing it into a generic 503 is
// exactly how that stays broken for a month.
function storageFail(res, err) {
  const code = err.code || 'storage_unavailable';
  const message = code === 'shopify_scope_missing'
    ? 'The Shopify Admin token is missing the write_files access scope. Grant write_files (and read_files) to the custom app, reinstall it, then retry.'
    : (err.detail || undefined);
  return fail(res, 503, code, message);
}

// ---------------------------------------------------------------------------
// GET /storage — what the library would do right now. The picker uses it to
// tell the operator "uploads are off" BEFORE they drag a 4 MB file in.
// ---------------------------------------------------------------------------
router.get('/storage', (req, res) => {
  const backend = storageBackend();
  res.json({
    success: true,
    backend,                                   // 'shopify' | 'r2' | null
    uploads_enabled: Boolean(backend),
    rehost_enabled: Boolean(backend),
    max_upload_bytes: MAX_UPLOAD_BYTES,
    max_import_bytes: MAX_IMPORT_BYTES,
    accepted_mime: [...ALLOWED_MIME],
  });
});

// ---------------------------------------------------------------------------
// POST /upload  { filename, mime, data }   data = base64 (raw or data: URL)
// ---------------------------------------------------------------------------
router.post('/upload', async (req, res, next) => {
  try {
    await ensureMediaTables();
    const body = req.body || {};
    const filename = String(body.filename || '').slice(0, 200);
    const declared = String(body.mime || '').split(';')[0].trim().toLowerCase();
    let data = body.data;

    if (typeof data !== 'string' || !data.length) {
      return fail(res, 400, 'data_required', 'Provide the image as base64 in `data`.');
    }
    // Accept a whole data: URL too — that is exactly what FileReader gives the
    // browser, and making the client strip it is a bug waiting to happen.
    const dataUrl = data.match(/^data:([^;,]+)[^,]*,(.*)$/s);
    let dataUrlMime = '';
    if (dataUrl) { dataUrlMime = dataUrl[1].toLowerCase(); data = dataUrl[2]; }

    // Refuse on the ENCODED length, before decoding: 4 base64 chars == 3 bytes,
    // so this bounds the allocation instead of measuring it after the fact.
    if (Math.floor(data.length * 3 / 4) > MAX_UPLOAD_BYTES) {
      return fail(res, 413, 'too_large', `Maximum upload is ${MAX_UPLOAD_BYTES} bytes.`);
    }

    const buffer = Buffer.from(data, 'base64');
    if (!buffer.length) return fail(res, 400, 'invalid_base64', '`data` is not valid base64.');
    if (buffer.length > MAX_UPLOAD_BYTES) {
      return fail(res, 413, 'too_large', `Maximum upload is ${MAX_UPLOAD_BYTES} bytes.`);
    }

    // The bytes are the fact; `mime` is a claim. A png header over a zip is a
    // zip, and a client that lies must not be able to seed the CDN with it.
    const mime = sniffMime(buffer);
    if (!mime || !ALLOWED_MIME.has(mime)) {
      return fail(res, 415, 'unsupported_type',
        `Only ${[...ALLOWED_MIME].join(', ')} are accepted (detected: ${mime || declared || dataUrlMime || 'unknown'}).`);
    }

    const dims = imageDimensions(buffer, mime) || {};
    const alt = String(body.alt || '').slice(0, 500);

    let stored;
    try {
      stored = await putImage({ buffer, filename, mime, alt });
    } catch (err) {
      if (err instanceof StorageUnavailableError) return storageFail(res, err);
      throw err;
    }

    const row = await insertRow({
      id: newMediaId(),
      source: 'upload',
      url: stored.url,
      // The SANITIZED name, always — the row must name the object that is
      // actually on the CDN, and the grid must never render a client-supplied
      // path string.
      filename: stored.filename || null,
      mime,
      bytes: buffer.length,
      // Prefer OUR header parse over the CDN's echo: it is measured from the
      // exact bytes we stored, and Shopify omits it while the file is pending.
      width: dims.width ?? stored.width ?? null,
      height: dims.height ?? stored.height ?? null,
      alt,
      shopifyFileId: stored.shopifyFileId,
      createdBy: req.user?.id || null,
    });
    return res.status(201).json({ success: true, item: rowView(row), backend: stored.backend });
  } catch (err) {
    return next(err);
  }
});

// ---------------------------------------------------------------------------
// POST /import-url  { url, alt? }
//
// Re-hosts by default so an external link cannot rot underneath a live page
// (fbcdn `oe=` expiry is the same failure brandSpyMediaMirror.js exists to fix).
// When no CDN backend is configured the import still succeeds but is INDEXED
// ONLY — `rehosted:false` in the response and shopify_file_id NULL on the row.
// It never claims to have stored bytes it did not store.
// ---------------------------------------------------------------------------
router.post('/import-url', async (req, res, next) => {
  try {
    await ensureMediaTables();
    const raw = String((req.body || {}).url || '').trim();
    if (!raw) return fail(res, 400, 'url_required', 'Provide an https image URL.');
    if (raw.length > 2048) return fail(res, 400, 'url_too_long');

    const verdict = await importUrlAllowed(raw);
    if (verdict === 'scheme') {
      return fail(res, 400, 'invalid_scheme', 'Only https:// image URLs can be imported.');
    }
    if (verdict === 'blocked_host') {
      return fail(res, 400, 'blocked_host', 'That host resolves to a private or loopback address.');
    }
    if (verdict === 'dns_resolution_failed') {
      return fail(res, 400, 'dns_resolution_failed', 'That host could not be resolved.');
    }

    let fetched;
    try {
      fetched = await fetchExternalImage(raw, { maxBytes: MAX_IMPORT_BYTES });
    } catch (err) {
      if (err.code === 'too_large') {
        return fail(res, 413, 'too_large', `Maximum import is ${MAX_IMPORT_BYTES} bytes.`);
      }
      if (err.code === 'unsupported_type') {
        return fail(res, 415, 'unsupported_type',
          `That URL is not a supported image (${err.detail || 'unknown type'}).`);
      }
      if (err.code === 'upstream_status') {
        return fail(res, 400, 'upstream_status', `The source returned HTTP ${err.status}.`);
      }
      if (err.code === 'empty_body') return fail(res, 400, 'empty_body');
      return fail(res, 400, 'fetch_failed', 'The image could not be downloaded.');
    }

    const alt = String((req.body || {}).alt || '').slice(0, 500);
    const dims = imageDimensions(fetched.buffer, fetched.mime) || {};
    let filename = '';
    try {
      filename = decodeURIComponent(new URL(raw).pathname.split('/').pop() || '').slice(0, 200);
    } catch { filename = ''; }
    // Sanitize BEFORE the storage call so the index-only path (no CDN backend)
    // stores the same safe name the re-hosted path would.
    filename = sanitizeFilename(filename, fetched.mime);

    let url = raw;
    let shopifyFileId = null;
    let rehosted = false;
    let rehostError = null;
    let backend = null;
    if (storageBackend()) {
      try {
        const stored = await putImage({ buffer: fetched.buffer, filename, mime: fetched.mime, alt });
        url = stored.url;
        shopifyFileId = stored.shopifyFileId;
        backend = stored.backend;
        rehosted = true;
      } catch (err) {
        if (!(err instanceof StorageUnavailableError)) throw err;
        // A re-host failure is NOT a lost import — index the original and say
        // so. Hiding it would leave the operator believing the link is safe.
        rehostError = err.code;
      }
    } else {
      rehostError = 'storage_not_configured';
    }

    const row = await insertRow({
      id: newMediaId(),
      source: 'url',
      url,
      filename: filename || null,
      mime: fetched.mime,
      bytes: fetched.bytes,
      width: dims.width ?? null,
      height: dims.height ?? null,
      alt,
      shopifyFileId,
      createdBy: req.user?.id || null,
    });
    return res.status(201).json({
      success: true,
      item: rowView(row),
      rehosted,
      backend,
      ...(rehostError ? { rehost_error: rehostError } : {}),
    });
  } catch (err) {
    return next(err);
  }
});

// ---------------------------------------------------------------------------
// GET /  — the library grid. Newest first, keyset-free offset paging (the
// library is operator-sized, not feed-sized).
// ---------------------------------------------------------------------------
router.get('/', async (req, res, next) => {
  try {
    await ensureMediaTables();
    const limit = clamp(req.query.limit, 60, 1, 200);
    const offset = clamp(req.query.offset, 0, 0, 1_000_000);
    const archived = String(req.query.archived || 'false') === 'true';
    const q = String(req.query.q || '').trim().slice(0, 120);

    const params = [archived];
    let where = 'archived = $1';
    if (q) {
      params.push(`%${q.replace(/[%_\\]/g, (c) => `\\${c}`)}%`);
      where += ` AND (filename ILIKE $${params.length} ESCAPE '\\' OR alt ILIKE $${params.length} ESCAPE '\\')`;
    }
    const countRows = await pgQuery(`SELECT COUNT(*)::int AS n FROM lb_media WHERE ${where}`, params);
    const rows = await pgQuery(
      `SELECT ${SELECT_COLS} FROM lb_media WHERE ${where}
       ORDER BY created_at DESC, id DESC
       LIMIT $${params.length + 1} OFFSET $${params.length + 2}`,
      [...params, limit, offset]
    );
    const total = countRows[0]?.n ?? 0;
    return res.json({
      success: true,
      items: rows.map(rowView),
      total,
      limit,
      offset,
      has_more: offset + rows.length < total,
    });
  } catch (err) {
    return next(err);
  }
});

// ---------------------------------------------------------------------------
// PATCH /:id  { alt?, archived? }
// ---------------------------------------------------------------------------
router.patch('/:id', async (req, res, next) => {
  try {
    await ensureMediaTables();
    const id = String(req.params.id || '').slice(0, 64);
    const body = req.body || {};
    const sets = [];
    const params = [];

    if (Object.prototype.hasOwnProperty.call(body, 'alt')) {
      if (typeof body.alt !== 'string') return fail(res, 400, 'invalid_alt', '`alt` must be a string.');
      params.push(body.alt.slice(0, 500));
      sets.push(`alt = $${params.length}`);
    }
    if (Object.prototype.hasOwnProperty.call(body, 'archived')) {
      if (typeof body.archived !== 'boolean') {
        return fail(res, 400, 'invalid_archived', '`archived` must be a boolean.');
      }
      params.push(body.archived);
      sets.push(`archived = $${params.length}`);
    }
    if (!sets.length) return fail(res, 400, 'nothing_to_update', 'Provide `alt` and/or `archived`.');

    params.push(id);
    const rows = await pgQuery(
      `UPDATE lb_media SET ${sets.join(', ')} WHERE id = $${params.length}
       RETURNING ${SELECT_COLS}`,
      params
    );
    if (!rows.length) return fail(res, 404, 'not_found');
    return res.json({ success: true, item: rowView(rows[0]) });
  } catch (err) {
    return next(err);
  }
});

export default router;
