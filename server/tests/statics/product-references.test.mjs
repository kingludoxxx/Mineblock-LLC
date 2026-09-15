// Several labelled product photos per image call (found live 2026-09-15).
// Reevo's product has 4 correct photos (box, open case with device, device on its patch, worn under the chin), but
// every generation sent ONE: 14 of 19 cards got only the box, and the model then drew a device and a case it had
// never seen (a clip on a rectangle, an earbud case). A card that happened to get the case photo drew the case right.
// So every image call now sends up to 5 photos, the chosen shot first, and the prompts say to show only product
// objects the photos show.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { selectProductReferences, productReferencesNote, buildNanoBananaImagePrompt, MAX_PRODUCT_REFERENCES } from '../../src/utils/staticsPrompts.js';

const IMG = (n) => `data:image/jpeg;base64,${'A'.repeat(20)}${n}`;

test('R1: the chosen shot comes first, the rest follow in library order, capped at 5', () => {
  const imgs = [IMG(0), IMG(1), IMG(2), IMG(3), IMG(4), IMG(5)];
  assert.equal(MAX_PRODUCT_REFERENCES, 5);
  assert.deepEqual(selectProductReferences(imgs, 2), [IMG(2), IMG(0), IMG(1), IMG(3), IMG(4)]);
  assert.deepEqual(selectProductReferences(imgs, 0), [IMG(0), IMG(1), IMG(2), IMG(3), IMG(4)]);
  assert.deepEqual(selectProductReferences(imgs, 1, 2), [IMG(1), IMG(0)]);
});

test('R2: stored shapes are all accepted: JSON string, {url} objects; junk, duplicates and bad indexes are skipped', () => {
  const stored = JSON.stringify([{ url: 'https://cdn.x/a.png' }, 'x', null, 'https://cdn.x/b.png', 'https://cdn.x/a.png']);
  assert.deepEqual(selectProductReferences(stored, 9), ['https://cdn.x/a.png', 'https://cdn.x/b.png']);
  assert.deepEqual(selectProductReferences('not json', 0), []);
  assert.deepEqual(selectProductReferences(null, 0), []);
  assert.deepEqual(selectProductReferences([], 0), []);
});

test('R3: the analysis note numbers the photos and forbids describing product parts none of them shows', () => {
  const note = productReferencesNote(3, { firstImageNumber: 2 });
  assert.match(note, /IMAGES 2 TO 4/);
  assert.match(note, /product photo 1 = image 2/i);
  assert.match(note, /only describe product objects/i);
  assert.equal(productReferencesNote(0), '');
  assert.match(productReferencesNote(1, { firstImageNumber: 2 }), /IMAGE 2 is a photo of OUR product/);
});

const claude = { reference_has_product_visual: true, product_visual_for_generation: 'the box with the open case beside it', adapted_text: { headline: 'HELLO' }, original_text: { headline: 'HI' } };
const TEMPLATE = 'Make an ad for {{PRODUCT_NAME}}.\n{{PRODUCT_INSTRUCTION}}\n{{PRODUCT_RULE}}\n{{TEXT_SWAPS}}';

test('R4: with a reference count the image prompt labels every photo, drops "the ONLY image attached", and carries the show-only-what-you-see rule', () => {
  const out = buildNanoBananaImagePrompt(claude, { name: 'Reevo Pulse Pro' }, TEMPLATE, {}, { referenceCount: 3 });
  assert.match(out, /3 PRODUCT PHOTOS ATTACHED/);
  assert.match(out, /image 1 is the main shot/i);
  assert.match(out, /never invent/i);
  assert.match(out, /leave it out/i);
  assert.doesNotMatch(out, /the ONLY image attached/);
  assert.match(out, /HELLO/);
});

test('R5: the reference rule is never shortened away on a tight budget', () => {
  const big = { name: 'P', profile: { winning_angles: 'W'.repeat(9000) } };
  const out = buildNanoBananaImagePrompt(claude, big, TEMPLATE + '\n{{WINNING_ANGLES}}', {}, { maxChars: 5000, referenceCount: 4 });
  assert.ok(out.length <= 5000, String(out.length));
  assert.match(out, /4 PRODUCT PHOTOS ATTACHED/);
});

test('R6: without a reference count the prompt is exactly what it was', () => {
  const before = buildNanoBananaImagePrompt(claude, { name: 'P' }, TEMPLATE, {});
  assert.match(before, /the ONLY image attached/);
  assert.doesNotMatch(before, /PRODUCT PHOTOS ATTACHED/);
});

test('R7: a Product Bible product (Reevo) gets the same reference rule and labels', () => {
  const bible = { angleDef: { name: 'Angle A' }, copy: { text: 'BIBLE COPY PACK', market: { price: '$99' } }, image: { text: 'BIBLE IMAGE PACK' } };
  const out = buildNanoBananaImagePrompt(claude, { name: 'Reevo Pulse Pro', _bible: bible }, TEMPLATE, {}, { maxChars: 32000, referenceCount: 4 });
  assert.match(out, /4 PRODUCT PHOTOS ATTACHED/);
  assert.match(out, /images 1 to 4, image 1 is the main shot/);
  assert.doesNotMatch(out, /the ONLY image attached/);
  assert.match(out, /BIBLE IMAGE PACK/);
});

// Per-photo rules (Ludo 2026-09-15): with all 5 photos attached the model still drew a closed, different charging
// case next to the box. Each photo can carry an operator note (product_profiles.image_notes, keyed by the photo's
// fingerprint so reordering or adding photos never moves a note to the wrong image). Notes reach both prompts.
import { imageNoteKey, notesForReferences } from '../../src/utils/staticsPrompts.js';

test('N1: the note key is stable for the same photo and different for different photos', () => {
  assert.equal(imageNoteKey(IMG(1)), imageNoteKey(IMG(1)));
  assert.notEqual(imageNoteKey(IMG(1)), imageNoteKey(IMG(2)));
  assert.match(imageNoteKey(IMG(1)), /^[0-9a-f]{8}-\d+$/);
  assert.equal(imageNoteKey(''), null);
});

test('N2: notes follow their photo whatever the order; stored as object or JSON string; blanks ignored', () => {
  const notes = { [imageNoteKey(IMG(2))]: 'Box + open case: copy this photo', [imageNoteKey(IMG(0))]: '   ' };
  assert.deepEqual(notesForReferences([IMG(2), IMG(0), IMG(1)], notes), ['Box + open case: copy this photo', '', '']);
  assert.deepEqual(notesForReferences([IMG(1), IMG(2)], JSON.stringify(notes)), ['', 'Box + open case: copy this photo']);
  assert.deepEqual(notesForReferences([IMG(1)], 'bad json'), ['']);
  assert.deepEqual(notesForReferences([IMG(1)], null), ['']);
});

test('N3: the analysis note and the image rule both carry each photo note next to its number', () => {
  const notes = ['Packaging + product: copy this photo exactly, case open, device inside', '', 'Worn under the chin'];
  const analysis = productReferencesNote(3, { firstImageNumber: 2, notes });
  assert.match(analysis, /image 2 \(product photo 1\): Packaging \+ product: copy this photo exactly/);
  assert.match(analysis, /image 4 \(product photo 3\): Worn under the chin/);
  assert.match(analysis, /PHOTO RULES/);
  const img = buildNanoBananaImagePrompt(claude, { name: 'Reevo Pulse Pro' }, TEMPLATE, {}, { referenceCount: 3, referenceNotes: notes });
  assert.match(img, /PHOTO RULES/);
  assert.match(img, /Image 1: Packaging \+ product: copy this photo exactly, case open, device inside/);
  assert.match(img, /Image 3: Worn under the chin/);
  assert.doesNotMatch(img, /Image 2:/, 'a photo without a note gets no line');
});

test('N4: no notes means no PHOTO RULES block and the earlier reference prompt is unchanged', () => {
  const a = buildNanoBananaImagePrompt(claude, { name: 'P' }, TEMPLATE, {}, { referenceCount: 2 });
  const b = buildNanoBananaImagePrompt(claude, { name: 'P' }, TEMPLATE, {}, { referenceCount: 2, referenceNotes: ['', ''] });
  assert.equal(a, b);
  assert.doesNotMatch(a, /PHOTO RULES/);
  assert.equal(productReferencesNote(2, { firstImageNumber: 2 }), productReferencesNote(2, { firstImageNumber: 2, notes: [] }));
});

test('N5: photo rules survive a tight NanoBanana budget', () => {
  const big = { name: 'P', profile: { winning_angles: 'W'.repeat(9000) } };
  const out = buildNanoBananaImagePrompt(claude, big, TEMPLATE + '\n{{WINNING_ANGLES}}', {}, { maxChars: 5000, referenceCount: 2, referenceNotes: ['Copy this photo for packaging shots', ''] });
  assert.ok(out.length <= 5000);
  assert.match(out, /Image 1: Copy this photo for packaging shots/);
});

test('N6: the Product Library UI computes the same photo key as the server', async () => {
  const { imageNoteKey: uiKey } = await import('../../../client/src/lib/imageNoteKey.js');
  for (const s of [IMG(1), 'https://cdn.x/a.png', 'data:image/png;base64,' + 'Zé€'.repeat(5000), 'x'.repeat(11)]) assert.equal(uiKey(s), imageNoteKey(s));
});
