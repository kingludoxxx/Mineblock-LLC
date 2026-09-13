// GET /api/v1/inline-images/:kind/:id?field=<column>
// Serves ONE image that is stored inline in a database column, so list responses can carry a link instead
// of the bytes. See server/src/utils/inlineImages.js for the measurements that motivated it.
//
// Authenticated like every other route (the session cookie rides on a same-origin <img>). Kinds and fields
// come from an allowlist - never from the request - so no other table or column is reachable.
import crypto from 'node:crypto';
import { Router } from 'express';
import { authenticate } from '../middleware/auth.js';
import { requirePermission } from '../middleware/rbac.js';
import { pgQuery } from '../db/pg.js';
import { INLINE_KINDS, parseDataUri } from '../utils/inlineImages.js';

const router = Router();
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

router.get('/:kind/:id', authenticate, (req, res, next) => {
  const spec = INLINE_KINDS.get(req.params.kind);
  if (!spec) return res.status(404).json({ error: 'unknown_kind' });
  req.inlineSpec = spec;
  return spec.permission ? requirePermission(...spec.permission)(req, res, next) : next();
}, async (req, res) => {
  const spec = req.inlineSpec;
  const field = String(req.query.field || spec.fields[0]);
  if (!spec.fields.includes(field)) return res.status(400).json({ error: 'field_not_allowed' });
  if (!UUID.test(req.params.id)) return res.status(404).json({ error: 'not_found' });
  try {
    // table and field are allowlist constants, never user text; the id is a bound parameter
    const rows = await pgQuery(`SELECT ${field} AS v FROM ${spec.table} WHERE id = $1`, [req.params.id]);
    const img = parseDataUri(rows[0]?.v);
    if (!img) return res.status(404).json({ error: 'no_inline_image' });
    const etag = `"${crypto.createHash('sha1').update(img.bytes).digest('base64url')}"`;
    res.setHeader('ETag', etag);
    res.setHeader('Cache-Control', 'private, max-age=86400');
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('Content-Security-Policy', "default-src 'none'; sandbox");
    if (req.headers['if-none-match'] === etag) return res.status(304).end();
    res.setHeader('Content-Type', img.mime);
    return res.status(200).end(img.bytes);
  } catch (err) {
    console.error('[inlineImages] error:', err.message);
    return res.status(500).json({ error: 'server_error' });
  }
});

export default router;
