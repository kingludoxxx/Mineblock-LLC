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

  const prompt = `You are a strict text-quality inspector for AI-generated ad images.

INTENDED TEXT (what the image should display, verbatim):
${intendedLines.length > 0 ? intendedLines.map((l, i) => `${i + 1}. "${l}"`).join('\n') : '(none provided)'}

PRODUCT CONTEXT (ground-truth offer facts — anything that contradicts these is fabricated):
- Product name: "${product?.name || '(unknown)'}"
- offerDetails:   ${offerDetails}
- bundleVariants: ${bundleVariants}
- discountCodes:  ${discountCodes}
- maxDiscount:    ${maxDiscount}
- guarantee:      ${guarantee}

Carefully read ALL text rendered in the generated image. Check for each of these failure modes:

1. MISSPELLINGS: Any misspelled word (e.g. "blocchain" for "blockchain", "Verifable" for "Verifiable")
2. DUPLICATED_WORDS: Any word/phrase rendered twice in a row (e.g. "per per", "stock stock", "Every single one Every single one")
3. LETTER_SWAPS: Any word where the wrong letter was rendered (e.g. "Pight" for "Right", "Tree" for "Free", "MMineBlock" with doubled M)
4. FABRICATED_OFFERS: Any "Buy X Get Y Free", "BOGO", "N for M", "Free [item] with purchase", "Get N free" — UNLESS that exact structure appears verbatim in offerDetails/bundleVariants above. Bundle SAVINGS ("Save $118 on 3-pack") are NOT equivalent to "Buy X Get Y Free".
5. FABRICATED_STATS: Claims that contradict PRODUCT CONTEXT (e.g. "LIFETIME WARRANTY" when guarantee says 2-year; "90-DAY MONEY BACK" when guarantee says 30-day; fabricated percentages or counts)
6. EMOJI_PRESENT: Any emoji characters rendered as part of the text (😭 😊 ⭐ etc)
7. CORRUPTED_PRODUCT_TEXT: Garbled text on the physical product itself — screen readouts, LED/LCD labels, button text that doesn't match the real product. If you can see the product has clearly gibberish text on it (e.g. "BIM MINER", "000-01:23:04", random letters), flag it.
8. MISSING_INTENDED_TEXT: Any INTENDED TEXT line above that does NOT appear in the rendered image (approximate/partial match is fine; flag only if it's clearly absent).

Return ONLY valid JSON (no markdown fences, no extra commentary):
{
  "misspellings": [{"found": "blocchain", "expected": "blockchain"}],
  "duplicated_words": ["per per", "stock stock"],
  "letter_swaps": [{"found": "Pight", "expected": "Right"}],
  "fabricated_offers": ["Buy 3 Get 1 Free"],
  "fabricated_stats": ["LIFETIME WARRANTY"],
  "emoji_present": ["😭"],
  "corrupted_product_text": ["BIM MINER"],
  "missing_intended_text": ["expected line that is absent"]
}

If a category has no issues, return an empty array. Do not invent issues — only report what you actually see in the image.`;

  const body = {
    model: 'claude-sonnet-4-20250514',
    max_tokens: 1500,
    system: 'You are a strict text-quality inspector. You never invent issues. You read the image carefully and only flag what is actually rendered wrong. Always return valid JSON only.',
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
                         errors.fabricated_stats.length + errors.emoji_present.length +
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
  if (e.emoji_present?.length)          parts.push(`${e.emoji_present.length} emoji`);
  if (e.corrupted_product_text?.length) parts.push(`${e.corrupted_product_text.length} garbled-product-text`);
  if (e.missing_intended_text?.length)  parts.push(`${e.missing_intended_text.length} missing-line(s)`);
  const tag = validation.severity === 'hard' ? '❌ HARD-FAIL' : '⚠️ soft';
  return `${tag} — ${parts.join(', ') || `${validation.totalErrors} issue(s)`}`;
}
