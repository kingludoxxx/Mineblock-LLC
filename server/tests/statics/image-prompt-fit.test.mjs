// The image prompt must fit the engine's limit without losing the ad copy (found live 2026-09-13).
// A new store's product library carried a full knowledge base (winning angles ~20K chars, notes ~14K); the image
// template pastes those fields in, and OpenAI refused the generation: "Invalid 'prompt': string too long ... maximum
// length 32000, but got ... 32208". Every generation for that product failed. The copy is already written by the
// analysis step, so the image prompt shortens the long knowledge fields first and never the copy or visual brief.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildNanoBananaImagePrompt } from '../../src/utils/staticsPrompts.js';

const TEMPLATE = [
  'Adapt the reference ad for {{PRODUCT_NAME}}.',
  '{{PRODUCT_INSTRUCTION}}',
  'TEXT SWAPS:',
  '{{TEXT_SWAPS}}',
  'VISUAL CHANGES:',
  '{{VISUAL_CHANGES}}',
  'Angle: {{ANGLE}}',
  'Winning angles for context:',
  '{{WINNING_ANGLES}}',
  'Notes:',
  '{{NOTES}}',
  'Pain points: {{PAIN_POINTS}}',
  'Final rule: render every text swap exactly.',
].join('\n');

const claude = {
  reference_has_product_visual: true,
  product_visual_for_generation: 'the device in its open black case',
  background: 'soft coral wall',
  original_text: { headline: 'WE TESTED 5 SNORING DEVICES', cta: 'FIND OUT BELOW' },
  adapted_text: { headline: 'NOTHING IN YOUR MOUTH. FINALLY.', cta: 'SEE HOW IT WORKS' },
};

const product = (sizes = {}) => ({
  name: 'Test Device',
  _angle: 'Snoring: Nothing In Your Mouth',
  profile: {
    winning_angles: 'W'.repeat(sizes.w ?? 20_000),
    notes: 'N'.repeat(sizes.n ?? 14_000),
    pain_points: 'P'.repeat(sizes.p ?? 2_000),
  },
});

test('F1: an over-long knowledge base is shortened to fit, and the copy, visual brief and final rule survive intact', () => {
  const full = buildNanoBananaImagePrompt(claude, product(), TEMPLATE);
  assert.ok(full.length > 32_000, `precondition: the unfitted prompt is over the limit (${full.length})`);
  const fitted = buildNanoBananaImagePrompt(claude, product(), TEMPLATE, {}, { maxChars: 32_000 });
  assert.ok(fitted.length <= 32_000, `fits: ${fitted.length}`);
  for (const must of ['NOTHING IN YOUR MOUTH. FINALLY.', 'SEE HOW IT WORKS', 'the device in its open black case', 'soft coral wall',
    'Angle: Snoring: Nothing In Your Mouth', 'Final rule: render every text swap exactly.']) {
    assert.ok(fitted.includes(must), `kept: ${must}`);
  }
  assert.ok(fitted.includes('W'.repeat(1000)) && fitted.includes('N'.repeat(1000)), 'knowledge is shortened, not dropped');
  assert.ok(fitted.includes('P'.repeat(2000)), 'a field that was never the problem is left whole');
});

test('F2: a prompt already under the limit is byte-identical with or without the limit', () => {
  const small = product({ w: 3000, n: 2000, p: 500 });
  assert.equal(buildNanoBananaImagePrompt(claude, small, TEMPLATE, {}, { maxChars: 32_000 }), buildNanoBananaImagePrompt(claude, small, TEMPLATE));
});

test('F3: even when the fixed parts alone exceed the limit, the result fits and the copy lines are still there', () => {
  const huge = TEMPLATE.replace('Final rule', 'X'.repeat(40_000) + '\nFinal rule');
  const fitted = buildNanoBananaImagePrompt(claude, product(), huge, {}, { maxChars: 32_000 });
  assert.ok(fitted.length <= 32_000, `fits: ${fitted.length}`);
  assert.ok(fitted.includes('NOTHING IN YOUR MOUTH. FINALLY.'), 'headline copy survives the hard cut');
});

test('F4: no limit given behaves exactly as before', () => {
  const p = product();
  assert.equal(buildNanoBananaImagePrompt(claude, p, TEMPLATE, {}), buildNanoBananaImagePrompt(claude, p, TEMPLATE));
});

test('F5: the OpenAI submit path itself never sends more than 32,000 prompt characters', async () => {
  process.env.OPENAI_API_KEY = process.env.OPENAI_API_KEY || 'sk-test-not-real';
  const sent = [];
  const realFetch = globalThis.fetch;
  globalThis.fetch = async (url, init) => {
    if (String(url).includes('/images/')) sent.push(JSON.parse(init.body).prompt);
    return new Response(JSON.stringify({ error: { message: 'stubbed' } }), { status: 400, headers: { 'content-type': 'application/json' } });
  };
  try {
    const { submitToOpenAI } = await import('../../src/services/openaiImageGen.js');
    const long = '- HEADLINE: "old" → "KEEP THIS COPY"\n' + ('filler line of context\n'.repeat(2000));
    await submitToOpenAI(long, [], '1:1').catch(() => {});
    assert.equal(sent.length, 1, 'one request made');
    assert.ok(sent[0].length <= 32_000, `sent ${sent[0].length}`);
    assert.ok(sent[0].includes('KEEP THIS COPY'));
  } finally { globalThis.fetch = realFetch; }
});
