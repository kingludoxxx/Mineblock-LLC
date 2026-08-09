// Custom tracking code — PURE validation + defensive read for
// GET/PUT /api/v1/funnels/:id/tracking/custom.
//
// Zero imports, zero I/O, so the validation can be exercised by `node`
// directly (server/tests/tracking/custom-code.mjs). The SQL lives in
// routes/funnelTrackingExtras.js.
//
// POSTURE: these snippets are OPERATOR-SUPPLIED CODE, stored and later emitted
// VERBATIM — the same trusted-operator escape-hatch posture as page head_html
// and settings.custom_head_code (funnelRender.js). There is deliberately NO
// sanitization: sanitizing a tracking snippet silently breaks it, which is
// worse than not offering the field. The controls are (a) the funnels
// permission, which is already the gate on every other funnel-settings write,
// and (b) a hard byte cap, so a runaway paste cannot bloat every public render.

// 32KB per field. Smaller than the 2MB page/settings escape hatches ON PURPOSE:
// a tracking snippet is a tag loader, not a page. The cap is measured in UTF-8
// BYTES, not JS string length — a snippet full of multi-byte characters must
// not slip past a .length check.
export const CUSTOM_CODE_MAX_BYTES = 32 * 1024;
export const CUSTOM_CODE_FIELDS = ['head_html', 'body_html'];

// postgres.js parses a jsonb column into an object, but a value written by an
// older path — or double-encoded by a JSON.stringify that should never have
// happened — comes back as a STRING. Read BOTH shapes and never throw: a
// malformed blob must degrade to empty snippets, not 500 the settings modal.
export function readCustomCode(raw) {
  let obj = raw;
  if (typeof obj === 'string') {
    try {
      obj = JSON.parse(obj);
    } catch {
      return { head_html: '', body_html: '' };
    }
  }
  if (obj == null || typeof obj !== 'object' || Array.isArray(obj)) {
    return { head_html: '', body_html: '' };
  }
  const pick = (k) => (typeof obj[k] === 'string' ? obj[k] : '');
  return { head_html: pick('head_html'), body_html: pick('body_html') };
}

// Returns { ok: true, patch } or { ok: false, code, field, message }.
// `patch` carries ONLY the fields the request actually sent, so a PUT from a
// client that knows about one field can never blank the other.
export function validateCustomCode(body) {
  if (body == null || typeof body !== 'object' || Array.isArray(body)) {
    return { ok: false, code: 'invalid_body', message: 'Request body must be an object.' };
  }
  const patch = {};
  for (const field of CUSTOM_CODE_FIELDS) {
    const v = body[field];
    if (v === undefined) continue;
    // null is an explicit CLEAR — distinct from "absent", which means no change.
    if (v === null) {
      patch[field] = '';
      continue;
    }
    if (typeof v !== 'string') {
      return {
        ok: false,
        code: `invalid_${field}`,
        field,
        message: `${field} must be a string.`,
      };
    }
    const bytes = Buffer.byteLength(v, 'utf8');
    if (bytes > CUSTOM_CODE_MAX_BYTES) {
      return {
        ok: false,
        code: `${field}_too_large`,
        field,
        message: `${field} is ${bytes} bytes — the limit is ${CUSTOM_CODE_MAX_BYTES} bytes (32KB).`,
      };
    }
    patch[field] = v;
  }
  if (Object.keys(patch).length === 0) {
    return {
      ok: false,
      code: 'empty_update',
      message: 'Send at least one of head_html or body_html.',
    };
  }
  return { ok: true, patch };
}

// Merge a validated patch onto the stored value, normalising both sides.
// Always returns BOTH keys so the stored jsonb has a stable shape.
export function mergeCustomCode(stored, patch) {
  const base = readCustomCode(stored);
  return {
    head_html: patch && typeof patch.head_html === 'string' ? patch.head_html : base.head_html,
    body_html: patch && typeof patch.body_html === 'string' ? patch.body_html : base.body_html,
  };
}

export default { validateCustomCode, readCustomCode, mergeCustomCode, CUSTOM_CODE_MAX_BYTES, CUSTOM_CODE_FIELDS };
