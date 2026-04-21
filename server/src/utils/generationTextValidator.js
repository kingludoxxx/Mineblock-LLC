// ─────────────────────────────────────────────────────────────────────────────
// Generation Text Validator — strict text-quality QC using Claude Vision.
//
// Purpose: catch image-model failures that the layout/fidelity validator
// misses. Specifically targets the failure modes we keep seeing:
//   - misspellings (blocchain, Verifable)
//   - letter swaps (Pight for Right, Tree for Free)
//   - duplicated words/phrases (per per, stock stock, Every single one
//     Every single one)
//   - fabricated offer structures (Buy X Get Y Free, BOGO, N for M) that
//     don't exist in the product's real offer data
//   - fabricated stats (LIFETIME WARRANTY when product has 2-year,
//     90-DAY MONEY BACK when product has 30-day)
//   - emoji rendered into text
//   - corrupted product labels / screen text
//
// This validator is MEANT to be blocking — wire it into the pipeline and
// regenerate if `passed === false`. The cost is ~$0.01 per check using
// Claude Sonnet, which is worth it to never ship a broken image.
// ─────────────────────────────────────────────────────────────────────────────

const ANTHROPIC_API_KEY = process.env.ANTHROPIC_API_KEY || '';
const CLAUDE_API_URL = 'https://api.anthropic.com/v1/messages';

/**
 * Gather all intended text from the Claude-adapted output into a flat list.
 * @param {object} adaptedText - The adapted_text object from Claude's analysis
 * @returns {Array<string>} - Every string we asked the image model to render
 */
function flattenAdaptedText(adaptedText) {
  const out = [];
  const walk = (v) => {
    if (v == null) return;
    if (typeof v === 'string') {
      if (v.trim()) out.push(v.trim());
      return;
    }
    if (Array.isArray(v)) { v.forEach(walk); return; }
    if (typeof v === 'object') { Object.values(v).forEach(walk); return; }
  };
  walk(adaptedText);
  return out;
}

/**
 * Validate that the generated image contains correctly-spelled, non-duplicated,
 * non-fabricated text that matches the adapted copy and the product's real offers.
 *
 * @param {Buffer} imageBuffer      - The generated image (raw bytes)
 * @param {string} imageMimeType    - MIME type ('image/png' | 'image/jpeg' | 'image/webp')
 * @param {object} adaptedText      - Claude's adapted_text JSON (headline, body, bullets, ...)
 * @param {object} product          - { name, price, profile: { offerDetails, bundleVariants, discountCodes, maxDiscount, guarantee, ... } }
 * @returns {Promise<{passed: boolean, totalErrors: number, errors: object, severity: 'clean'|'soft'|'hard'}>}
 */
export async function validateGenerationText(imageBuffer, imageMimeType, adaptedText, product) {
  if (!ANTHROPIC_API_KEY) {
    return { passed: true, totalErrors: 0, errors: {}, severity: 'clean', skipped: 'no ANTHROPIC_API_KEY' };
  }
  if (!imageBuffer || !Buffer.isBuffer(imageBuffer) || imageBuffer.length === 0) {
    return { passed: true, totalErrors: 0, errors: {}, severity: 'clean', skipped: 'empty image buffer' };
  }

  const intendedLines = flattenAdaptedText(adaptedText);
  const productProfile = product?.profile || {};
  const offerDetails     = productProfile.offerDetails     || '(none)';
  const bundleVariants   = productProfile.bundleVariants   || '(none)';
  const discountCodes    = productProfile.discountCodes    || '(none)';
  const maxDiscount      = productProfile.maxDiscount      || '(none)';
  const guarantee        = productProfile.guarantee        || '(none)';
  const productPrice     = product?.price                  || '(not set)';

  const prompt = `You are a strict text-quality inspector for AI-generated ad images.

INTENDED TEXT (what the image should display, verbatim):
${intendedLines.length > 0 ? intendedLines.map((l, i) => `${i + 1}. "${l}"`).join('\n') : '(none provided)'}

PRODUCT CONTEXT (ground-truth offer facts — anything that contradicts these is fabricated):
- Product name:   "${product?.name || '(unknown)'}"
- Current price:  ${productPrice}
- offerDetails:   ${offerDetails}
- bundleVariants: ${bundleVariants}
- discountCodes:  ${discountCodes}
- maxDiscount:    ${maxDiscount}
- guarantee:      ${guarantee}

READ EVERY RENDERED WORD LETTER-BY-LETTER. Do not approximate — if a word is
short (WORLDWIDE, HONEST, GUARANTEE, FLASH, FREE, YEAR), verify each letter is
present AND in the right order. Dropped letters and swapped letters are the
#1 failure mode and you must not miss them.

BE AGGRESSIVE — if in doubt about a word, FLAG IT. A false positive costs
one regeneration. A false negative ships a broken ad. We have observed the
validator missing errors that a 6-year-old would catch. STOP that.

Specifically, the image model (Gemini 2.5 Flash Image) has these known
failure modes that you MUST catch — treat them as the ground truth of what
to look for:

  • NUMBER → SYMBOL SWAPS: "+Year" where it should be "2-Year", "+-year",
    "30X" where it should be "30W", "24/+" where it should be "24/7".
    Any non-alphanumeric character mid-word (+ - . ; ' ") inside what should
    be a normal word is a RED FLAG — flag it as letter_swap.
  • RANDOM LETTER-PAIR GARBAGE: "OFF FF", "FREE FREe", "$$", dangling "FF"
    or "AA" inside a sentence — flag as misspellings.
  • DUPLICATED SHORT WORDS: "AT AT CHECKOUT", "to to the", "is is", "a a" —
    ANY two-letter or three-letter word rendered twice in a row is a
    duplicated_words hit. Read slowly.
  • FULL PHRASE DUPLICATES: "GET 10% OFF WITH CODE BITCOIN10" appearing
    twice in the same ad → duplicated_words.
  • GIBBERISH BRAND/PRODUCT NAMES: "Aerovc", "V-15 Miner", "MineBlok",
    "Minr Forj" — any product-like token that is NOT the real product name
    above. If it's not in "Product name:" above, it's wrong.
  • TRUNCATED CODES: "code BITCOIN" missing the "10" suffix; "code BTC10"
    that should be "BITCOIN10" — compare verbatim to discountCodes above.
  • STRAY PUNCTUATION: a word beginning with " or ' or other punctuation
    that shouldn't be there (e.g. '"BITCOIN10' as the discount code) —
    flag as misspelling.
  • COMPETITOR / FOREIGN LOGOS: if you see a logo or brand name that is NOT
    "${product?.profile?.shortName || product?.name?.split(' ')[0] || '(unknown)'}" in the image
    (e.g. "earth breeze", "Pendulum", "Coinbase"), flag under
    corrupted_product_text (abuse of the field — there's no dedicated
    category yet but the ad shouldn't carry a competitor brand).

Then check each failure mode below:

1. MISSPELLINGS: Any word where one or more letters are missing/wrong/doubled relative to correct English.
   Examples you MUST catch: "WORLWIDE" (missing D → WORLDWIDE), "blocchain" (extra c → blockchain), "Verifable" (missing i → Verifiable), "recieve" (swap → receive), "GAURANTEE" (missing letter → GUARANTEE), "MMineBlock" (doubled M).
   If a word renders with LESS than 100% letter match to the correctly-spelled version, flag it.

2. DUPLICATED_WORDS: Any word/phrase rendered twice in a row (e.g. "per per", "stock stock", "Every single one Every single one").

3. LETTER_SWAPS: Any word where one letter was visually substituted for a similar-shaped one (e.g. "Pight" for "Right", "Tree" for "Free", "Oure" for "Our", "morig" for "more"). This is distinct from misspellings — it's when the model picked the wrong letter.

4. FABRICATED_OFFERS: Any "Buy X Get Y Free", "BOGO", "N for M", "Free [item] with purchase", "Get N free" — UNLESS that exact structure appears verbatim in offerDetails/bundleVariants above. Bundle SAVINGS ("Save $118 on 3-pack") are NOT equivalent to "Buy X Get Y Free".

5. FABRICATED_STATS: Claims that contradict PRODUCT CONTEXT (e.g. "LIFETIME WARRANTY" when guarantee says 2-year; "90-DAY MONEY BACK" when guarantee says 30-day; fabricated percentages or satisfaction counts; fabricated user counts).

6. FABRICATED_PRICES: Any price shown that is NOT the Current price above AND NOT derivable from it via the maxDiscount. Watch for:
   - Fake "WAS $X, NOW $Y" where X is an inflated anchor that was never the real price (e.g. current price is $249 but ad shows "WAS $277, NOW $249" — the $277 is fabricated).
   - Prices that don't match bundleVariants.
   - Discount percentages that don't match maxDiscount.
   Real math allowed: if Current price is $249 and maxDiscount is 10% off, then $249 → $224 (or $224.10) is VALID. But inventing a higher "WAS" price to make the current price look discounted is FABRICATED.

7. NONSENSICAL_COPY: Any copy that is grammatically or logically nonsense, including:
   - Two unrelated facts joined with "=" or other bad punctuation ("Runs on ~30W = 2-Yr Warranty")
   - Sentences that don't parse ("Other USB miners show numbers moving moving")
   - Claims with no subject/verb or that contradict themselves internally
   Flag the exact phrase.

8. EMOJI_PRESENT: Any emoji characters rendered as part of the text (😭 😊 ⭐ ✅ ❌ etc).

9. CORRUPTED_PRODUCT_TEXT: Garbled text on the physical product itself — screen readouts, LED/LCD labels, button text that doesn't match the real product. If the product has clearly gibberish text on it (e.g. "BIM MINER", "000-01:23:04", random letters), flag it.

10. MISSING_INTENDED_TEXT: Any INTENDED TEXT line above that does NOT appear in the rendered image (approximate/partial match is fine; flag only if it's clearly absent).

Return ONLY valid JSON (no markdown fences, no extra commentary):
{
  "misspellings": [{"found": "WORLWIDE", "expected": "WORLDWIDE"}],
  "duplicated_words": ["per per", "stock stock"],
  "letter_swaps": [{"found": "Pight", "expected": "Right"}],
  "fabricated_offers": ["Buy 3 Get 1 Free"],
  "fabricated_stats": ["LIFETIME WARRANTY"],
  "fabricated_prices": ["WAS $277, NOW $249 — the $277 is invented; product is $249 with optional 10% off"],
  "nonsensical_copy": ["Runs on ~30W = 2-Yr Warranty"],
  "emoji_present": ["😭"],
  "corrupted_product_text": ["BIM MINER"],
  "missing_intended_text": ["expected line that is absent"]
}

If a category has no issues, return an empty array. Do not invent issues — only report what you actually see in the image. When in doubt on a misspelling, ASSUME IT IS MISSPELLED and flag it — false positives cost us one extra regeneration; false negatives ship a broken ad.`;

  const body = {
    model: 'claude-sonnet-4-5',
    max_tokens: 2000,
    system: 'You are a strict text-quality inspector for AI-generated ad images. You read every rendered word letter-by-letter. You aggressively flag any misspelling, letter-swap, duplicated word, nonsensical phrase, fabricated offer or price, and gibberish product name. False positives are acceptable (they cost one regen). False negatives ship broken ads and are unacceptable. Return valid JSON only.',
    messages: [{
      role: 'user',
      content: [
        { type: 'text', text: prompt },
        {
          type: 'image',
          source: {
            type: 'base64',
            media_type: imageMimeType || 'image/png',
            data: imageBuffer.toString('base64'),
          },
        },
      ],
    }],
  };

  const res = await fetch(CLAUDE_API_URL, {
    method: 'POST',
    headers: {
      'x-api-key': ANTHROPIC_API_KEY,
      'anthropic-version': '2023-06-01',
      'Content-Type': 'application/json',
    },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(45000),
  });

  if (!res.ok) {
    const errText = await res.text().catch(() => '');
    throw new Error(`[text-validator] Claude API error ${res.status}: ${errText.slice(0, 300)}`);
  }

  const data = await res.json();
  const rawText = data.content?.[0]?.text;
  if (!rawText) throw new Error('[text-validator] Empty response from Claude Vision');

  const jsonMatch = rawText.match(/\{[\s\S]*\}/);
  if (!jsonMatch) throw new Error(`[text-validator] No JSON in response: ${rawText.slice(0, 200)}`);

  let parsed;
  try {
    parsed = JSON.parse(jsonMatch[0]);
  } catch (parseErr) {
    // Strip trailing commas and retry
    const fixed = jsonMatch[0].replace(/,\s*([}\]])/g, '$1');
    try { parsed = JSON.parse(fixed); }
    catch { throw new Error(`[text-validator] JSON parse failed: ${parseErr.message}. Raw: ${jsonMatch[0].slice(0, 300)}`); }
  }

  const errors = {
    misspellings:            Array.isArray(parsed.misspellings)           ? parsed.misspellings           : [],
    duplicated_words:        Array.isArray(parsed.duplicated_words)       ? parsed.duplicated_words       : [],
    letter_swaps:            Array.isArray(parsed.letter_swaps)           ? parsed.letter_swaps           : [],
    fabricated_offers:       Array.isArray(parsed.fabricated_offers)      ? parsed.fabricated_offers      : [],
    fabricated_stats:        Array.isArray(parsed.fabricated_stats)       ? parsed.fabricated_stats       : [],
    fabricated_prices:       Array.isArray(parsed.fabricated_prices)      ? parsed.fabricated_prices      : [],
    nonsensical_copy:        Array.isArray(parsed.nonsensical_copy)       ? parsed.nonsensical_copy       : [],
    emoji_present:           Array.isArray(parsed.emoji_present)          ? parsed.emoji_present          : [],
    corrupted_product_text:  Array.isArray(parsed.corrupted_product_text) ? parsed.corrupted_product_text : [],
    missing_intended_text:   Array.isArray(parsed.missing_intended_text)  ? parsed.missing_intended_text  : [],
  };

  const totalErrors = Object.values(errors).reduce((sum, arr) => sum + arr.length, 0);

  // Severity classification:
  //   hard = any text-rendering defect that a customer would immediately notice
  //   soft = only missing_intended_text or minor issues
  //   clean = no errors at all
  const hardErrorCount = errors.misspellings.length + errors.duplicated_words.length +
                         errors.letter_swaps.length + errors.fabricated_offers.length +
                         errors.fabricated_stats.length + errors.fabricated_prices.length +
                         errors.nonsensical_copy.length + errors.emoji_present.length +
                         errors.corrupted_product_text.length;
  const softErrorCount = errors.missing_intended_text.length;

  let severity, passed;
  if (totalErrors === 0) {
    severity = 'clean'; passed = true;
  } else if (hardErrorCount === 0) {
    severity = 'soft'; passed = true;   // soft issues are acceptable
  } else {
    severity = 'hard'; passed = false;  // hard issues → regenerate
  }

  return { passed, totalErrors, hardErrorCount, softErrorCount, errors, severity };
}

/**
 * Produce a one-line human-readable summary of a validation result.
 * Useful for logs and Slack alerts.
 */
export function summarizeTextValidation(validation) {
  if (validation?.skipped) return `skipped (${validation.skipped})`;
  if (!validation) return 'no validation';
  if (validation.severity === 'clean') return '✅ clean';
  const parts = [];
  const e = validation.errors || {};
  if (e.misspellings?.length)           parts.push(`${e.misspellings.length} misspelling(s)`);
  if (e.duplicated_words?.length)       parts.push(`${e.duplicated_words.length} dup(s)`);
  if (e.letter_swaps?.length)           parts.push(`${e.letter_swaps.length} letter-swap(s)`);
  if (e.fabricated_offers?.length)      parts.push(`${e.fabricated_offers.length} fake-offer(s)`);
  if (e.fabricated_stats?.length)       parts.push(`${e.fabricated_stats.length} fake-stat(s)`);
  if (e.fabricated_prices?.length)      parts.push(`${e.fabricated_prices.length} fake-price(s)`);
  if (e.nonsensical_copy?.length)       parts.push(`${e.nonsensical_copy.length} nonsense-phrase(s)`);
  if (e.emoji_present?.length)          parts.push(`${e.emoji_present.length} emoji`);
  if (e.corrupted_product_text?.length) parts.push(`${e.corrupted_product_text.length} garbled-product-text`);
  if (e.missing_intended_text?.length)  parts.push(`${e.missing_intended_text.length} missing-line(s)`);
  const tag = validation.severity === 'hard' ? '❌ HARD-FAIL' : '⚠️ soft';
  return `${tag} — ${parts.join(', ') || `${validation.totalErrors} issue(s)`}`;
}
