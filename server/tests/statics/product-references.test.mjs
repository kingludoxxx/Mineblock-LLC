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
