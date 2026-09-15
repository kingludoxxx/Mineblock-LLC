// Prices in a bible static must be written as digits (found live 2026-09-15).
// Reevo's saved analysis prompt still carries the June rule "spell out any dollar amounts as words", so a promo
// static came back reading "SAVE UP TO One Hundred Ninety Seven Dollars" instead of "$197". The commercial-structure
// block is appended in code after every store's saved template, so the digits rule lives there and says it overrides.
// Products without markets (Mineblock, Puure) never get this block: their prompts stay byte-identical.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { renderCommercialStructureBlock, digitizeSpelledAmounts, enforcePriceDigits } from '../../src/utils/staticsPrompts.js';

const offer = { price: '$99', discount: '20% OFF', code: 'SLEEP20', savings: 'Save up to $197' };

test('P1: the offer block orders digits for prices, discounts and savings and overrides spelled-out amounts', () => {
  const block = renderCommercialStructureBlock(offer);
  assert.match(block, /PRICES AND NUMBERS/);
  assert.match(block, /digits/i);
  assert.match(block, /"\$197"/, 'shows the digit form as the example');
  assert.match(block, /never spell/i);
  assert.match(block, /overrides any earlier/i);
});

test('P2: the digits rule is there even when the market has no offer', () => {
  assert.match(renderCommercialStructureBlock(null), /PRICES AND NUMBERS/);
});

// The exact strings the analysis model produced in the live before/after run (claude-sonnet-4-6, 2026-09-15).
test('P3: spelled-out amounts from the live runs become digits', () => {
  const cases = [
    ['SAVE UP TO ONE HUNDRED NINETY-SEVEN DOLLARS + USE CODE SLEEP20', 'SAVE UP TO $197 + USE CODE SLEEP20'],
    ['SAVE UP TO One Hundred Ninety Seven Dollars', 'SAVE UP TO $197'],
    ['Free shipping on orders over Fifty Dollars', 'Free shipping on orders over $50'],
    ['Save Twenty Percent today with code SLEEP20', 'Save 20% today with code SLEEP20'],
    ['Get Ninety-Nine Dollars pricing before it\'s gone', 'Get $99 pricing before it\'s gone'],
    ['One Dollar a Year', '$1 a Year'],
    ['Two Thousand Five Hundred Dollars', '$2500'],
    ['One Hundred and Forty-Nine Dollars', '$149'],
  ];
  for (const [from, to] of cases) assert.equal(digitizeSpelledAmounts(from), to);
});

test('P4: words that are not amounts are left alone', () => {
  for (const s of ['Nothing on your face or mouth', 'One device, ninety nights', 'Trains the muscle nightly', 'SAVE UP TO $197', 'Someone saved money', 'Seventy percentile', '']) {
    assert.equal(digitizeSpelledAmounts(s), s);
  }
});

test('P5: only bible products are rewritten, nested copy included; other stores and odd input pass through untouched', () => {
  const claude = { adapted_text: { headline: 'Save Fifty Dollars', bullets: ['Twenty Percent Off', 'No mask'], extra: { offer_line: 'Ninety Nine Dollars' } } };
  const bible = enforcePriceDigits(claude, { _bible: { offer: null } });
  assert.deepEqual(bible.result.adapted_text, { headline: 'Save $50', bullets: ['20% Off', 'No mask'], extra: { offer_line: '$99' } });
  assert.equal(bible.report.changed.length, 3);
  assert.equal(claude.adapted_text.headline, 'Save Fifty Dollars', 'input not mutated');
  const legacy = enforcePriceDigits(claude, { profile: {} });
  assert.equal(legacy.result, claude, 'a product without markets is returned as-is');
  assert.deepEqual(enforcePriceDigits({}, { _bible: {} }).report.changed, []);
  assert.equal(enforcePriceDigits(null, { _bible: {} }).result, null);
});
