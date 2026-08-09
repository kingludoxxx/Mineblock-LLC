// Unit verification for the custom tracking-code contract
// (server/src/services/trackingCustomCode.js) plus the route file's auth chain
// (server/src/routes/funnelTrackingExtras.js).
//
// The validation module is pure, so node exercises it with no database. The
// permission assertion introspects the mounted express router instead of
// issuing a request — it proves the middleware is ATTACHED to both custom-code
// routes, which is the thing that can silently regress when a route is added.
//
// Run:  node server/tests/tracking/custom-code.mjs
import {
  validateCustomCode,
  readCustomCode,
  mergeCustomCode,
  CUSTOM_CODE_MAX_BYTES,
} from '../../src/services/trackingCustomCode.js';

let pass = 0, fail = 0;
const ok = (c, m, x = '') => { if (c) { pass++; console.log('PASS ', m); } else { fail++; console.log('FAIL ', m, x); } };
const eq = (got, want, m) => ok(got === want, m, `got ${JSON.stringify(got)} want ${JSON.stringify(want)}`);

// ── V1 happy path ───────────────────────────────────────────────────────────
{
  const r = validateCustomCode({ head_html: '<script>a()</script>', body_html: '<noscript>x</noscript>' });
  eq(r.ok, true, 'V1 both fields accepted');
  eq(r.patch.head_html, '<script>a()</script>', 'V1 head stored VERBATIM — no sanitization');
  eq(r.patch.body_html, '<noscript>x</noscript>', 'V1 body stored verbatim');
}
{
  // The whole point of the escape hatch: hostile-looking operator code is NOT
  // rewritten. Sanitizing a tracking tag silently breaks it.
  const raw = '<script>window.x="</scr"+"ipt>";fbq(\'track\',\'Lead\')</script>';
  const r = validateCustomCode({ head_html: raw });
  eq(r.patch.head_html, raw, 'V1b snippet is byte-identical after validation');
}

// ── V2 partial update: absent ≠ cleared ─────────────────────────────────────
{
  const r = validateCustomCode({ head_html: '<b>h</b>' });
  eq(r.ok, true, 'V2 head-only update accepted');
  eq('body_html' in r.patch, false, 'V2 an ABSENT field is not in the patch (no accidental clear)');
}
{
  const r = validateCustomCode({ body_html: null });
  eq(r.ok, true, 'V2b explicit null accepted');
  eq(r.patch.body_html, '', 'V2b null is an explicit CLEAR → empty string');
}
{
  const r = validateCustomCode({ head_html: '' });
  eq(r.ok, true, 'V2c empty string accepted (clearing the field)');
  eq(r.patch.head_html, '', 'V2c empty string round-trips');
}

// ── V3 LENGTH CAP ───────────────────────────────────────────────────────────
eq(CUSTOM_CODE_MAX_BYTES, 32768, 'V3 cap is 32KB');
{
  const atLimit = 'a'.repeat(CUSTOM_CODE_MAX_BYTES);
  const r = validateCustomCode({ head_html: atLimit });
  eq(r.ok, true, 'V3a exactly 32768 bytes is ACCEPTED (boundary, inclusive)');
}
{
  const over = 'a'.repeat(CUSTOM_CODE_MAX_BYTES + 1);
  const r = validateCustomCode({ head_html: over });
  eq(r.ok, false, 'V3b 32769 bytes is REJECTED');
  eq(r.code, 'head_html_too_large', 'V3b error code names the field');
  eq(r.field, 'head_html', 'V3b field carried for the client');
  ok(/32768/.test(r.message), 'V3b message states the limit', r.message);
}
{
  const r = validateCustomCode({ body_html: 'b'.repeat(CUSTOM_CODE_MAX_BYTES + 1) });
  eq(r.code, 'body_html_too_large', 'V3c body cap enforced independently');
}
{
  // The cap is BYTES, not JS string length. A 3-byte character must not slip
  // 3x the payload past a .length check.
  const multi = 'é'.repeat(CUSTOM_CODE_MAX_BYTES - 1); // 2 bytes each
  const r = validateCustomCode({ head_html: multi });
  eq(r.ok, false, 'V3d multi-byte payload measured in UTF-8 BYTES, not characters');
  ok(multi.length < CUSTOM_CODE_MAX_BYTES, 'V3e (the same string is UNDER the limit by .length — the trap)', String(multi.length));
}

// ── V4 type + shape rejection ───────────────────────────────────────────────
eq(validateCustomCode({ head_html: 123 }).code, 'invalid_head_html', 'V4a a number is rejected');
eq(validateCustomCode({ body_html: {} }).code, 'invalid_body_html', 'V4b an object is rejected');
eq(validateCustomCode({ head_html: ['<b>'] }).code, 'invalid_head_html', 'V4c an array is rejected');
eq(validateCustomCode({}).code, 'empty_update', 'V4d an empty body is rejected');
eq(validateCustomCode({ nope: 'x' }).code, 'empty_update', 'V4e unknown keys alone are rejected');
eq(validateCustomCode(null).code, 'invalid_body', 'V4f null body is rejected');
eq(validateCustomCode('string').code, 'invalid_body', 'V4g a string body is rejected');
eq(validateCustomCode([]).code, 'invalid_body', 'V4h an array body is rejected');
{
  let threw = false;
  try { validateCustomCode(undefined); } catch { threw = true; }
  ok(!threw, 'V4i undefined body does not throw');
}

// ── V5 JSONB ROUND-TRIP — BOTH SHAPES ───────────────────────────────────────
// postgres.js normally hands back a parsed OBJECT, but a double-encoded legacy
// value comes back as a STRING. Both must read.
{
  const obj = { head_html: '<h>', body_html: '<b>' };
  const r = readCustomCode(obj);
  eq(r.head_html, '<h>', 'V5a OBJECT shape reads');
  eq(r.body_html, '<b>', 'V5a object shape reads body');
}
{
  const str = JSON.stringify({ head_html: '<h>', body_html: '<b>' });
  const r = readCustomCode(str);
  eq(r.head_html, '<h>', 'V5b STRING (double-encoded) shape reads');
  eq(r.body_html, '<b>', 'V5b string shape reads body');
}
{
  // Round-trip equivalence: the two shapes must produce IDENTICAL output.
  const obj = { head_html: '<script>1</script>', body_html: '' };
  eq(
    JSON.stringify(readCustomCode(obj)),
    JSON.stringify(readCustomCode(JSON.stringify(obj))),
    'V5c object and string shapes yield an identical read'
  );
}
eq(JSON.stringify(readCustomCode(null)), '{"head_html":"","body_html":""}', 'V5d null → empty snippets');
eq(JSON.stringify(readCustomCode(undefined)), '{"head_html":"","body_html":""}', 'V5e undefined → empty snippets');
eq(JSON.stringify(readCustomCode('{not json')), '{"head_html":"","body_html":""}', 'V5f unparseable string degrades, never throws');
eq(JSON.stringify(readCustomCode('"a bare json string"')), '{"head_html":"","body_html":""}', 'V5g a jsonb STRING SCALAR degrades to empty');
eq(JSON.stringify(readCustomCode([1, 2])), '{"head_html":"","body_html":""}', 'V5h an array degrades to empty');
eq(JSON.stringify(readCustomCode({ head_html: 42 })), '{"head_html":"","body_html":""}', 'V5i a non-string field degrades to empty, never leaks a number');
{
  const big = '<script>' + 'x'.repeat(5000) + '</script>';
  eq(readCustomCode(JSON.stringify({ head_html: big, body_html: '' })).head_html, big, 'V5j large snippet survives a string round-trip byte-for-byte');
}

// ── V6 merge: a partial PUT must not blank the other field ──────────────────
{
  const stored = { head_html: '<keep>', body_html: '<also-keep>' };
  const merged = mergeCustomCode(stored, { head_html: '<new>' });
  eq(merged.head_html, '<new>', 'V6a patched field replaced');
  eq(merged.body_html, '<also-keep>', 'V6a UNPATCHED field preserved');
}
{
  const merged = mergeCustomCode(JSON.stringify({ head_html: '<h>', body_html: '<b>' }), { body_html: '' });
  eq(merged.head_html, '<h>', 'V6b merge over the STRING shape preserves the other field');
  eq(merged.body_html, '', 'V6b explicit clear applies');
}
{
  const merged = mergeCustomCode(null, { head_html: '<h>' });
  eq(merged.head_html, '<h>', 'V6c merge onto a missing row works');
  eq(merged.body_html, '', 'V6c missing row yields empty for the other field');
  eq(Object.keys(merged).length, 2, 'V6d merge always returns BOTH keys (stable stored shape)');
}

// ── V7 PERMISSION — the auth chain is attached to both custom-code routes ───
// Imported last so a failure here cannot mask the pure results above.
{
  const mod = await import('../../src/routes/funnelTrackingExtras.js');
  const router = mod.default;
  const layers = router.stack.filter((l) => l.route);
  const routeOf = (path, method) =>
    layers.find((l) => l.route.path === path && l.route.methods[method]);

  const health = routeOf('/:id/tracking/health', 'get');
  const getCustom = routeOf('/:id/tracking/custom', 'get');
  const putCustom = routeOf('/:id/tracking/custom', 'put');
  ok(health, 'V7a GET /:id/tracking/health is registered');
  ok(getCustom, 'V7b GET /:id/tracking/custom is registered');
  ok(putCustom, 'V7c PUT /:id/tracking/custom is registered');

  // Each route must carry: authenticate, requirePermission(...), handler.
  const namesOf = (layer) => layer.route.stack.map((s) => s.name);
  for (const [label, layer] of [['health', health], ['custom GET', getCustom], ['custom PUT', putCustom]]) {
    const names = namesOf(layer);
    ok(names.includes('authenticate'), `V7 ${label}: authenticate middleware attached`, names.join(','));
    ok(names.length >= 3, `V7 ${label}: auth + permission + handler (${names.length} layers)`, names.join(','));
  }
  // The permission middleware is the anonymous closure returned by
  // requirePermission('funnels','access') — assert it sits BEFORE the handler.
  ok(namesOf(putCustom).indexOf('authenticate') === 0, 'V7d authenticate runs FIRST on the write route');

  // A router-level `use` would authenticate every /api/v1/funnels/* request,
  // including the ones meant to fall through to funnels.js. There must be none.
  const bare = router.stack.filter((l) => !l.route && l.name !== 'query' && l.name !== 'expressInit');
  eq(bare.length, 0, 'V7e no router-level middleware — other /funnels/* paths fall through free');
}

console.log(`\nRESULT: ${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
