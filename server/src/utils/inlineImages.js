// Images stored INSIDE a database column as `data:` URIs, served by link instead of inside list responses.
//
// WHY THIS EXISTS (measured 2026-09-13, live Mineblock, restored copy for the numbers):
//   statics_templates.image_url         224 of 1,839 rows are data: URIs, 14.6 MB, up to 495 KB each
//   spy_creatives.reference_thumbnail   253 of 648 pipeline rows are data: URIs
// The Statics Generation page loads both lists at once. The database answers in 1.4 ms and 5.5 ms; the
// responses are 21.2 MB and 23.3 MB. Streaming that through pgQuery's 8 s limit failed with
// "pgQuery timed out after 8000ms", and the third request on the page (league brand-configs, 0.15 ms on
// its own) timed out waiting behind them. The page showed 500s and no templates.
//
// The fix does not touch the data. A list query asks Postgres for the column only when it is NOT inline;
// an inline value comes back as a short link to /api/v1/inline-images/:kind/:id?field=..., which the
// browser fetches when it actually renders that image. The dashboard's session cookie (accessToken) rides
// along on a same-origin <img>, so the link is authenticated like everything else - no public endpoint.

/** Which table/column pairs may be served, and who may see them. Anything else is refused. */
export const INLINE_KINDS = new Map([
  ['template', { table: 'statics_templates', fields: ['image_url'], permission: null }],
  ['creative', { table: 'spy_creatives', fields: ['reference_thumbnail', 'image_url', 'thumbnail_url'], permission: ['statics-generation', 'access'] }],
]);

const IDENT = /^[a-z_][a-z0-9_]*$/;

/**
 * A SELECT fragment that returns `col` only when it is not inline, plus a boolean flag. The heavy value
 * never leaves the database for a list.
 */
export function inlineSafeColumn(col, tableAlias = '') {
  if (!IDENT.test(col) || (tableAlias && !IDENT.test(tableAlias))) throw new Error(`inlineSafeColumn: bad identifier ${col}`);
  const ref = tableAlias ? `${tableAlias}.${col}` : col;
  return `CASE WHEN ${ref} LIKE 'data:%' THEN NULL ELSE ${ref} END AS ${col}, (${ref} LIKE 'data:%') AS ${col}__inline`;
}

/** The link a list row carries instead of the image bytes. Relative, so it stays same-origin. */
export function inlineImageUrl(kind, id, field) {
  return `/api/v1/inline-images/${encodeURIComponent(kind)}/${encodeURIComponent(id)}?field=${encodeURIComponent(field)}`;
}

/** Replace every `<field>__inline === true` flag on a row with the field's link, and drop the flags. */
export function resolveInlineFlags(row, kind) {
  if (!row || typeof row !== 'object') return row;
  for (const key of Object.keys(row)) {
    if (!key.endsWith('__inline')) continue;
    const field = key.slice(0, -'__inline'.length);
    if (row[key] === true) row[field] = inlineImageUrl(kind, row.id, field);
    delete row[key];
  }
  return row;
}

const ALLOWED_MIME = /^image\/(png|jpe?g|webp|gif|avif)$/i;

/** Parse a data: URI into bytes. Returns null for anything that is not a well-formed raster image. */
export function parseDataUri(value) {
  if (typeof value !== 'string' || !value.startsWith('data:')) return null;
  const comma = value.indexOf(',');
  if (comma < 0) return null;
  const meta = value.slice(5, comma);
  const parts = meta.split(';');
  const mime = (parts[0] || '').trim().toLowerCase();
  // SVG is refused on purpose: it can carry script, and nothing in this product needs it inline.
  if (!ALLOWED_MIME.test(mime)) return null;
  const payload = value.slice(comma + 1);
  try {
    const bytes = parts.includes('base64') ? Buffer.from(payload, 'base64') : Buffer.from(decodeURIComponent(payload), 'binary');
    return bytes.length ? { mime: mime === 'image/jpg' ? 'image/jpeg' : mime, bytes } : null;
  } catch {
    return null;
  }
}
