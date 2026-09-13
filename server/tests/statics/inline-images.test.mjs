// Inline images served by link: the pure helpers, with the cases that would leak, crash or mislead.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseDataUri, inlineSafeColumn, resolveInlineFlags, inlineImageUrl, INLINE_KINDS } from '../../src/utils/inlineImages.js';

const PNG_1PX = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8/5+hHgAHggJ/PchI7wAAAABJRU5ErkJggg==';

test('I1: a real base64 raster data URI parses to its exact bytes and type', () => {
  const r = parseDataUri(`data:image/png;base64,${PNG_1PX}`);
  assert.equal(r.mime, 'image/png');
  assert.deepEqual(r.bytes, Buffer.from(PNG_1PX, 'base64'));
  assert.equal(parseDataUri(`data:image/jpg;base64,${PNG_1PX}`).mime, 'image/jpeg', 'image/jpg normalised');
});

test('I2: anything that is not a well-formed raster image is refused, never served', () => {
  for (const v of [
    null, undefined, 42, '', 'https://example.com/a.png', 'data:', 'data:image/png;base64', 'data:image/png;base64,',
    `data:image/svg+xml;base64,${Buffer.from('<svg onload="alert(1)"/>').toString('base64')}`, // script-capable
    `data:text/html;base64,${Buffer.from('<script>x</script>').toString('base64')}`,
    `data:application/octet-stream;base64,${PNG_1PX}`,
  ]) assert.equal(parseDataUri(v), null, JSON.stringify(v)?.slice(0, 60));
});

test('I3: the SELECT fragment returns the column ONLY when it is not inline, and refuses non-identifiers', () => {
  assert.equal(inlineSafeColumn('reference_thumbnail'),
    "CASE WHEN reference_thumbnail LIKE 'data:%' THEN NULL ELSE reference_thumbnail END AS reference_thumbnail, (reference_thumbnail LIKE 'data:%') AS reference_thumbnail__inline");
  for (const bad of ['x; DROP TABLE users', 'a b', 'Image_URL', '1col', "c'"]) assert.throws(() => inlineSafeColumn(bad), bad);
});

test('I4: flags become same-origin links on the row, only where the value was inline, and the flags are removed', () => {
  const row = { id: '11111111-2222-3333-4444-555555555555', image_url: null, image_url__inline: true, thumbnail_url: 'https://cdn/x.png', thumbnail_url__inline: false };
  const out = resolveInlineFlags(row, 'creative');
  assert.equal(out.image_url, inlineImageUrl('creative', row.id, 'image_url'));
  assert.match(out.image_url, /^\/api\/v1\/inline-images\/creative\/11111111-2222-3333-4444-555555555555\?field=image_url$/);
  assert.equal(out.thumbnail_url, 'https://cdn/x.png', 'an ordinary link is untouched');
  assert.ok(!Object.keys(out).some((k) => k.endsWith('__inline')), 'no flag leaks to the client');
});

test('I5: only allowlisted tables and fields exist, and creative images need statics-generation access', () => {
  assert.deepEqual([...INLINE_KINDS.keys()].sort(), ['creative', 'template']);
  assert.deepEqual(INLINE_KINDS.get('template').fields, ['image_url']);
  assert.deepEqual(INLINE_KINDS.get('creative').permission, ['statics-generation', 'access']);
  for (const spec of INLINE_KINDS.values()) for (const f of [spec.table, ...spec.fields]) assert.match(f, /^[a-z_]+$/);
});
