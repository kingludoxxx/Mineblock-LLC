// AI DEVELOPER EXTRAS — unit verification for the PURE parts of the four
// parity features (server/src/routes/aiDeveloper.js +
// server/src/services/aiDeveloperSchema.js).
//
// What this file is defending, feature by feature:
//
// 1. MODEL PICKER. The allowlist is the SERVER's. The picker is a convenience;
//    the gate is validateChatBody. A model id the dropdown never offered — or
//    one smuggled as a non-string, or as an object with a toString — must be a
//    400, and the DEFAULT must apply when the field is absent.
//
// 2. SCREENSHOT PASTE/DROP. The media_type that reaches Anthropic is a CLIENT
//    CLAIM. It is checked against the magic number, so a blob labelled
//    image/png is refused unless its bytes are a PNG. Plus the caps: 4MB
//    decoded per image, 2 per message.
//
// 3. ATTACHED-CONTEXT CHIP. resolveAttachment derives the chip's type and
//    excerpt from the PAGE'S REAL BLOCKS — a stale or spoofed `kind` cannot
//    make the chip describe a block that is not the one in scope, and an id
//    that is not on the page resolves to null (→ 400 at the route).
//
// 4. PERSISTED THREAD. The bound is 50 messages, the jsonb read tolerates BOTH
//    SHAPES (parsed object AND json text), and nothing in the store path can
//    carry image bytes.
//
// Run:  node server/tests/ai-developer/validation.mjs
process.env.DATABASE_URL ||= 'postgres://puure@127.0.0.1:5433/postgres';
process.env.JWT_ACCESS_SECRET ||= 'localdev';
process.env.JWT_REFRESH_SECRET ||= 'localdev';

const {
  validateChatBody, sniffImageType, sniffBase64Image, resolveAttachment,
  MODEL_ALLOWLIST, MODELS, DEFAULT_MODEL, MAX_IMAGES, MAX_IMAGE_BYTES,
  ALLOWED_MEDIA_TYPES,
} = await import('../../src/routes/aiDeveloper.js');
const {
  THREAD_LIMIT, THREAD_TEXT_MAX, boundThread, readJsonbObject, readStoredMessage,
  normalizeForStore,
} = await import('../../src/services/aiDeveloperSchema.js');

let pass = 0, fail = 0;
const ok = (c, m, x = '') => { if (c) { pass++; console.log('PASS ', m); } else { fail++; console.log('FAIL ', m, x); } };
const eq = (got, want, m) => ok(
  JSON.stringify(got) === JSON.stringify(want), m,
  `\n      got  ${JSON.stringify(got)}\n      want ${JSON.stringify(want)}`
);

// Minimal valid body scaffolding.
const base = (extra = {}) => ({
  page_id: 'pg_1', funnel_id: 'fn_1',
  messages: [{ role: 'user', content: 'make the headline bigger' }],
  ...extra,
});

// Real magic numbers, padded to a length the sniffer can read.
const pad = (bytes, n = 24) => {
  const b = Buffer.alloc(n);
  Buffer.from(bytes).copy(b, 0);
  return b;
};
const PNG = pad([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
const JPEG = pad([0xff, 0xd8, 0xff, 0xe0]);
const GIF = pad([...Buffer.from('GIF89a', 'latin1')]);
const WEBP = (() => {
  const b = Buffer.alloc(24);
  b.write('RIFF', 0, 'latin1');
  b.writeUInt32LE(16, 4);
  b.write('WEBP', 8, 'latin1');
  return b;
})();
const dataUrl = (mt, buf) => `data:${mt};base64,${buf.toString('base64')}`;

console.log('\n=== 1. MODEL PICKER — the allowlist is server-side ===');
{
  eq([...MODEL_ALLOWLIST], ['claude-fable-5', 'claude-opus-5', 'claude-sonnet-5'],
    'the allowlist is exactly the three Claude models the brief names');
  ok(MODEL_ALLOWLIST.includes(DEFAULT_MODEL), 'the default is itself allowlisted');
  eq(DEFAULT_MODEL, 'claude-fable-5', 'the default is claude-fable-5');
  ok(Object.isFrozen(MODEL_ALLOWLIST), 'the allowlist is frozen — no caller can widen it at runtime');
  ok(Object.isFrozen(MODELS) && MODELS.every((m) => Object.isFrozen(m)),
    'the exposed MODELS list and every entry are frozen (GET /models cannot be mutated by a handler)');
  eq(MODELS.map((m) => m.id), [...MODEL_ALLOWLIST],
    'what GET /models EXPOSES is exactly what validateChatBody ENFORCES — the picker cannot offer an id the gate refuses');
  ok(MODELS.every((m) => typeof m.label === 'string' && m.label.length > 0),
    'every exposed model carries a label — the panel invents nothing');
}
{
  const r = validateChatBody(base());
  ok(!r.error, 'an absent model is accepted', r.error);
  eq(r.model, DEFAULT_MODEL, 'an absent model falls back to the server default');
}
for (const id of MODEL_ALLOWLIST) {
  const r = validateChatBody(base({ model: id }));
  ok(!r.error && r.model === id, `an allowlisted model is accepted: ${id}`, r.error);
}
{
  const r = validateChatBody(base({ model: 'claude-3-opus-20240229' }));
  ok(!!r.error, 'a REAL but non-allowlisted Anthropic model is refused');
  ok(/must be one of/.test(r.error || ''), 'the refusal names the allowed set', r.error);
}
{
  ok(!!validateChatBody(base({ model: 'gpt-4o' })).error, 'another vendor\'s model is refused');
  ok(!!validateChatBody(base({ model: '' })).error, 'an EMPTY model string is refused — it is not the same as absent');
  ok(!!validateChatBody(base({ model: null })).error, 'a null model is refused (String(null) is "null", not the default)');
  ok(!!validateChatBody(base({ model: 42 })).error, 'a numeric model is refused');
  ok(!!validateChatBody(base({ model: ['claude-fable-5'] })).error,
    'an ARRAY whose String() is an allowlisted id is refused — coercion is not membership');
  ok(!!validateChatBody(base({ model: { toString: () => 'claude-fable-5' } })).error,
    'an object with a lying toString is refused');
}

console.log('\n=== 2. SCREENSHOT VALIDATION — caps + content-type sniff ===');
{
  eq(MAX_IMAGES, 2, 'the per-message image count cap is 2');
  eq(MAX_IMAGE_BYTES, 4 * 1024 * 1024, 'the per-image decoded byte cap is 4MB');
  eq([...ALLOWED_MEDIA_TYPES], ['image/png', 'image/jpeg', 'image/webp', 'image/gif'],
    'four media types are accepted');
}
{
  // The sniffer itself.
  eq(sniffImageType(PNG), 'image/png', 'sniff: PNG magic');
  eq(sniffImageType(JPEG), 'image/jpeg', 'sniff: JPEG magic');
  eq(sniffImageType(GIF), 'image/gif', 'sniff: GIF magic');
  eq(sniffImageType(WEBP), 'image/webp', 'sniff: WEBP (RIFF….WEBP)');
  eq(sniffImageType(pad([...Buffer.from('RIFF', 'latin1'), 0, 0, 0, 0, ...Buffer.from('WAVE', 'latin1')])), null,
    'sniff: a RIFF/WAVE audio file is NOT an image — the RIFF marker alone must not pass');
  eq(sniffImageType(Buffer.from('%PDF-1.7 hello world padding', 'latin1')), null, 'sniff: a PDF is not an image');
  eq(sniffImageType(Buffer.from('<svg xmlns="http://www.w3.org/2000/svg"/>', 'latin1')), null,
    'sniff: SVG is NOT accepted — it is a script-bearing document, not a raster image');
  eq(sniffImageType(Buffer.from([0x4d, 0x5a, 0x90, 0x00])), null, 'sniff: a Windows executable is not an image');
  eq(sniffImageType(null), null, 'sniff: null → null, never a throw');
  eq(sniffImageType(Buffer.alloc(0)), null, 'sniff: an empty buffer → null');
  eq(sniffImageType(Buffer.from([0x89, 0x50])), null, 'sniff: a TRUNCATED magic number → null');
  eq(sniffBase64Image('!!!not base64!!!'), null, 'sniff: non-base64 → null, never a throw');
  eq(sniffBase64Image(''), null, 'sniff: empty string → null');
}
{
  const r = validateChatBody(base({ images: [dataUrl('image/png', PNG)] }));
  ok(!r.error, 'a real PNG data URL is accepted', r.error);
  eq(r.images.length, 1, 'one image survives validation');
  eq(r.images[0].media_type, 'image/png', 'the SNIFFED type is what is forwarded');
  ok(!r.images[0].data.startsWith('data:'), 'the data: prefix is stripped — Anthropic gets bare base64');
}
{
  const r = validateChatBody(base({ images: [dataUrl('image/webp', WEBP), dataUrl('image/jpeg', JPEG)] }));
  ok(!r.error, 'two images at the cap are accepted', r.error);
  eq(r.images.map((i) => i.media_type), ['image/webp', 'image/jpeg'], 'both types are sniffed independently, in order');
}
{
  const r = validateChatBody(base({ images: [dataUrl('image/png', PNG), dataUrl('image/png', PNG), dataUrl('image/png', PNG)] }));
  ok(!!r.error, 'THREE images are refused — the count cap is 2');
  ok(/at most 2 images/.test(r.error || ''), 'the refusal names the cap', r.error);
}
{
  // THE DEFECT THE SNIFF EXISTS TO STOP.
  const r = validateChatBody(base({ images: [dataUrl('image/png', Buffer.from('%PDF-1.7 not an image at all', 'latin1'))] }));
  ok(!!r.error, 'a non-image blob LABELLED image/png is refused');
  ok(/not a recognized image/.test(r.error || ''), 'the refusal says the bytes are not an image', r.error);
}
{
  const r = validateChatBody(base({ images: [dataUrl('image/png', JPEG)] }));
  ok(!!r.error, 'a JPEG declared as image/png is refused — the declared type is not trusted');
  ok(/declared image\/png but its bytes are image\/jpeg/.test(r.error || ''),
    'the refusal names BOTH the claim and the truth', r.error);
}
{
  const r = validateChatBody(base({ images: [{ data: PNG.toString('base64'), media_type: 'image/png' }] }));
  ok(!r.error, 'the {data, media_type} object form is accepted too', r.error);
  eq(r.images[0].media_type, 'image/png', 'and is sniffed the same way');
}
{
  const r = validateChatBody(base({ images: [{ data: PNG.toString('base64'), media_type: 'image/svg+xml' }] }));
  ok(!!r.error, 'an unsupported DECLARED media type is refused before the sniff even runs');
}
{
  // Over the 4MB decoded cap. 4MB+1 decoded ≈ 5.6MB of base64 — build it from
  // a real PNG header so the ONLY thing wrong is the size.
  const big = Buffer.concat([PNG, Buffer.alloc(4 * 1024 * 1024)]);
  const r = validateChatBody(base({ images: [dataUrl('image/png', big)] }));
  ok(!!r.error, 'an image over 4MB decoded is refused');
  ok(/exceeds 4MB/.test(r.error || ''), 'the refusal names 4MB', r.error);
}
{
  // Just UNDER the cap must pass — a cap that refuses everything is not a cap.
  const nearly = Buffer.concat([PNG, Buffer.alloc(4 * 1024 * 1024 - 1024)]);
  const r = validateChatBody(base({ images: [dataUrl('image/png', nearly)] }));
  ok(!r.error, 'an image just UNDER 4MB is accepted — the cap is a ceiling, not a wall', r.error);
}
{
  ok(!!validateChatBody(base({ images: 'not-an-array' })).error, 'a non-array images field is refused');
  ok(!!validateChatBody(base({ images: [''] })).error, 'an empty image entry is refused');
  ok(!!validateChatBody(base({ images: [null] })).error, 'a null image entry is refused, never throws');
  ok(!!validateChatBody(base({ images: ['@@@@@@@@@@@@'] })).error, 'a non-base64 payload is refused');
  const r = validateChatBody(base());
  eq(r.images, [], 'an ABSENT images field yields an empty list, not a throw');
}

console.log('\n=== 3. ATTACHED-CONTEXT CHIP — resolved from the real blocks ===');
const pageBlocks = [
  { id: 'blk_hero', type: 'hero', props: { headline: '  Lift   in   30 days  ', style: { color: 'red' } } },
  { id: 'blk_bump', type: 'order_bump', props: { variant_id: '9', block_name: 'bump_warranty' } },
  { id: 'blk_bare', type: 'divider' },
];
{
  const a = resolveAttachment({ block_id: 'blk_hero', block_type: 'THIS IS A LIE', block_path: 'blocks[0]' }, pageBlocks);
  eq(a.block_id, 'blk_hero', 'the chip resolves the attached block');
  eq(a.block_type, 'hero', 'the BLOCK\'s type wins over the client\'s claim — the chip cannot be made to lie');
  eq(a.block_path, 'blocks[0]', 'the client\'s path (display only) is carried through');
  eq(a.excerpt, 'Lift in 30 days', 'the excerpt is whitespace-collapsed and trimmed');
}
{
  const a = resolveAttachment({ block_id: 'blk_bump' }, pageBlocks);
  eq(a.excerpt, 'bump_warranty', 'a block with no headline falls through to the next excerpt prop');
  eq(a.block_path, '', 'an absent path is an empty string, never undefined');
}
{
  const a = resolveAttachment({ block_id: 'blk_bare' }, pageBlocks);
  ok(a !== null, 'a block with NO props still resolves — a divider is attachable');
  eq(a.excerpt, '', 'and its excerpt is empty rather than a throw');
}
{
  eq(resolveAttachment({ block_id: 'blk_nope' }, pageBlocks), null,
    'an id that is NOT on this page resolves to null — the route turns that into a 400');
  eq(resolveAttachment(null, pageBlocks), null, 'a null attachment → null');
  eq(resolveAttachment({}, pageBlocks), null, 'an attachment with no block_id → null');
  eq(resolveAttachment({ block_id: 'blk_hero' }, null), null, 'null blocks → null, never a throw');
  eq(resolveAttachment({ block_id: 'blk_hero' }, []), null, 'an EMPTY page attaches nothing');
}
{
  const long = 'x'.repeat(500);
  const a = resolveAttachment({ block_id: 'b' }, [{ id: 'b', type: 't', props: { headline: long } }]);
  ok(a.excerpt.length === 60, 'a long excerpt is capped at 60 chars — the chip cannot become a paragraph');
}
{
  // The body validator's own attachment handling (shape + caps).
  const r = validateChatBody(base({ attachment: { block_id: 'blk_hero', kind: 'hero' } }));
  ok(!r.error && r.attachment?.block_id === 'blk_hero', 'a well-formed attachment survives body validation', r.error);
  ok(!!validateChatBody(base({ attachment: 'hero' })).error, 'a non-object attachment is refused');
  eq(validateChatBody(base({ attachment: null })).attachment, null, 'an explicit null attachment is whole-page scope');
  const longId = validateChatBody(base({ attachment: { block_id: 'b'.repeat(500) } }));
  ok(longId.attachment.block_id.length === 128, 'an oversized block_id is TRUNCATED to 128, not rejected');
}

console.log('\n=== 4. PERSISTED THREAD — bounding, both-shapes, no image bytes ===');
{
  eq(THREAD_LIMIT, 50, 'the thread bound is 50 messages');
  eq(THREAD_TEXT_MAX, 20_000, 'a stored message body is capped at the same 20k the request validator enforces');
}
{
  const mk = (n) => Array.from({ length: n }, (_, i) => ({ role: 'user', content: `m${i}` }));
  eq(boundThread(mk(3)).length, 3, 'a short thread is returned whole');
  eq(boundThread(mk(50)).length, 50, 'a thread exactly AT the bound is returned whole');
  const b = boundThread(mk(120));
  eq(b.length, 50, 'a 120-message thread is bounded to 50');
  eq(b[0].content, 'm70', 'the bound keeps the NEWEST 50 — m70, not m0');
  eq(b[49].content, 'm119', 'and the last entry is the newest message');
  eq(boundThread(mk(5)).map((m) => m.content), ['m0', 'm1', 'm2', 'm3', 'm4'],
    'order is preserved (oldest first) — the panel renders top-to-bottom');
  eq(boundThread([]), [], 'an empty thread bounds to empty');
  eq(boundThread(null), [], 'a null thread bounds to [], never a throw');
  eq(boundThread('nope'), [], 'a non-array bounds to []');
  eq(boundThread(mk(10), 3).map((m) => m.content), ['m7', 'm8', 'm9'], 'an explicit smaller limit is honored');
  eq(boundThread(mk(10), 0).length, 10, 'a zero limit falls back to the default rather than erasing the thread');
  eq(boundThread(mk(10), -5).length, 10, 'a negative limit falls back too');
  const src = mk(3);
  ok(boundThread(src) !== src, 'the bound returns a COPY — a caller cannot mutate the stored list through it');
}
{
  // BOTH SHAPES. postgres.js parses jsonb; a ::text cast / another driver / a
  // view hands the SAME column back as a string. Reading one shape only means
  // the chip vanishes on half the deployments.
  eq(readJsonbObject({ block_id: 'b' }), { block_id: 'b' }, 'both-shapes: a PARSED jsonb object reads through');
  eq(readJsonbObject('{"block_id":"b"}'), { block_id: 'b' }, 'both-shapes: the SAME value as json TEXT reads through');
  eq(readJsonbObject('  {"block_id":"b"}  '), { block_id: 'b' }, 'both-shapes: surrounding whitespace is tolerated');
  eq(readJsonbObject(null), null, 'both-shapes: NULL → null');
  eq(readJsonbObject(''), null, 'both-shapes: an empty string → null');
  eq(readJsonbObject('not json'), null, 'both-shapes: corrupt text → null, never a throw');
  eq(readJsonbObject('[1,2]'), null, 'both-shapes: a json ARRAY is not an attachment object → null');
  eq(readJsonbObject('"a string"'), null, 'both-shapes: a json STRING is not an attachment object → null');
  eq(readJsonbObject('null'), null, 'both-shapes: the json literal null → null');
  eq(readJsonbObject(7), null, 'both-shapes: a number → null');
  eq(readJsonbObject([1, 2]), null, 'both-shapes: a parsed ARRAY → null');
}
{
  const at = new Date('2026-08-09T10:00:00.000Z');
  const m = readStoredMessage({
    id: 12n, role: 'assistant', content: 'done', ops_count: '3', image_count: 0,
    attachment: '{"block_id":"blk_hero","block_type":"hero"}', model: 'claude-opus-5', created_at: at,
  });
  eq(m.id, '12', 'a BIGSERIAL id crosses the wire as a STRING — a bigint must never be JSON-coerced to a float');
  eq(m.ops_count, 3, 'a numeric-string ops_count is read as a number');
  eq(m.attachment.block_type, 'hero', 'the attachment is parsed out of the text shape');
  eq(m.created_at, '2026-08-09T10:00:00.000Z', 'created_at is serialized as ISO');
  ok(!('images' in m) && !('data' in m), 'a stored message carries NO image field — bytes are never persisted');
}
{
  eq(readStoredMessage({ role: 'user', content: 'hi' }).ops_count, 0, 'a legacy NULL ops_count reads as 0');
  eq(readStoredMessage({ role: 'user' }).content, '', 'a NULL content reads as an empty string');
  eq(readStoredMessage({ role: 'user' }).attachment, null, 'a NULL attachment reads as null');
  eq(readStoredMessage({ role: 'user' }).model, null, 'an empty model reads as null');
  eq(readStoredMessage({ role: 'system', content: 'x' }).role, 'assistant',
    'an UNKNOWN role is normalized to assistant — the panel must never receive a role it cannot render');
  eq(readStoredMessage({ role: 'user', ops_count: -4 }).ops_count, 0, 'a negative ops_count reads as 0');
  eq(readStoredMessage({ role: 'user', ops_count: 'abc' }).ops_count, 0, 'a non-numeric ops_count reads as 0');
  eq(readStoredMessage(null).role, 'assistant', 'a null row does not throw');
  eq(readStoredMessage(null).id, null, 'a null row has a null id');
}
{
  const n = normalizeForStore({ role: 'user', content: 'hi', image_count: 2, attachment: { block_id: 'b' }, model: 'claude-fable-5' });
  eq(n.image_count, 2, 'the store path keeps the image COUNT');
  eq(n.attachment, { block_id: 'b' }, 'and the attachment');
  ok(!('images' in n) && !('data' in n),
    'THE INVARIANT: nothing in the store path can carry image bytes — only the count');
  eq(normalizeForStore({ role: 'assistant', content: 'x'.repeat(30_000) }).content.length, THREAD_TEXT_MAX,
    'an over-long reply is TRUNCATED, not dropped — losing the whole turn over its length would lose the operator\'s message too');
  eq(normalizeForStore({ role: 'error', content: 'boom' }), null,
    'an ERROR pseudo-message is not storable — a failed turn is not part of the conversation');
  eq(normalizeForStore({ role: 'system', content: 'x' }), null, 'a system role is not storable');
  eq(normalizeForStore(null), null, 'null is not storable, never throws');
  eq(normalizeForStore('hi'), null, 'a bare string is not storable');
  eq(normalizeForStore({ role: 'user', content: 42 }).content, '', 'a non-string content stores as empty, never as "42"');
  eq(normalizeForStore({ role: 'user', attachment: 'blk_hero' }).attachment, null,
    'a non-object attachment is dropped rather than written into a jsonb column');
  eq(normalizeForStore({ role: 'user', attachment: [1] }).attachment, null, 'an ARRAY attachment is dropped');
  eq(normalizeForStore({ role: 'user', model: 'z'.repeat(200) }).model.length, 64, 'a hostile model string is capped at 64');
  eq(normalizeForStore({ role: 'user', ops_count: 1e9 }).ops_count, 10_000, 'an absurd ops_count is clamped');
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
