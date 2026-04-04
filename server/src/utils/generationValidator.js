// ─────────────────────────────────────────────────────────────────────────────
// Generation Validator — Claude Vision QC for AI-generated ads
// ─────────────────────────────────────────────────────────────────────────────

const ANTHROPIC_API_KEY = process.env.ANTHROPIC_API_KEY || '';
const CLAUDE_API_URL = 'https://api.anthropic.com/v1/messages';

/**
 * Validate a generated ad image against its reference template using Claude Vision.
 *
 * @param {string} generatedImageBase64 - Base64-encoded generated image (no data-URI prefix)
 * @param {string} referenceImageBase64 - Base64-encoded reference template image
 * @param {Array<{original: string, adapted: string}>} swapPairs - Text swaps that were requested
 * @param {object} [options] - Optional configuration
 * @param {string} [options.generatedMediaType] - MIME type of generated image (default: 'image/png')
 * @param {string} [options.referenceMediaType] - MIME type of reference image (default: 'image/png')
 * @returns {Promise<{passed: boolean, score: number, issues: string[], scores: object}>}
 */
export async function validateGeneration(generatedImageBase64, referenceImageBase64, swapPairs, options = {}) {
  if (!ANTHROPIC_API_KEY) {
    console.warn('[validation] ANTHROPIC_API_KEY not set, skipping validation');
    return {
      passed: true,
      score: 0,
      issues: ['Validation skipped: no API key'],
      scores: {},
    };
  }

  if (!generatedImageBase64 || !referenceImageBase64) {
    console.warn('[validation] Missing image data, skipping validation');
    return {
      passed: true,
      score: 0,
      issues: ['Validation skipped: missing image data'],
      scores: {},
    };
  }

  const genMediaType = options.generatedMediaType || 'image/png';
  const refMediaType = options.referenceMediaType || 'image/png';

  const swapList = Array.isArray(swapPairs) && swapPairs.length > 0
    ? swapPairs.map((p, i) => `${i + 1}. "${p.original}" → "${p.adapted}"`).join('\n')
    : '(No text swaps provided)';

  const validationPrompt = `Compare the GENERATED ad (image 1) against the REFERENCE template (image 2).

These text swaps were requested:
${swapList}

Score each criterion 0-100 and list any issues found.
Return ONLY valid JSON (no markdown fences, no extra text):
{
  "layout_match": 85,
  "text_correctness": 70,
  "product_fidelity": 90,
  "background_fidelity": 80,
  "competitor_branding": 100,
  "overall_quality": 75,
  "issues": ["description of each problem found"]
}`;

  const body = {
    model: 'claude-haiku-4-5-20251001',
    max_tokens: 1000,
    system: 'You are a quality control inspector for AI-generated ads. You compare generated outputs against reference templates and score them on fidelity, text accuracy, and overall quality. Always respond with valid JSON only.',
    messages: [
      {
        role: 'user',
        content: [
          { type: 'text', text: validationPrompt },
          {
            type: 'image',
            source: { type: 'base64', media_type: genMediaType, data: generatedImageBase64 },
          },
          {
            type: 'image',
            source: { type: 'base64', media_type: refMediaType, data: referenceImageBase64 },
          },
        ],
      },
    ],
  };

  const res = await fetch(CLAUDE_API_URL, {
    method: 'POST',
    headers: {
      'x-api-key': ANTHROPIC_API_KEY,
      'anthropic-version': '2023-06-01',
      'Content-Type': 'application/json',
    },
    body: JSON.stringify(body),
  });

  if (!res.ok) {
    const errText = await res.text().catch(() => '');
    throw new Error(`[validation] Claude API error ${res.status}: ${errText.slice(0, 300)}`);
  }

  const data = await res.json();
  const rawText = data.content?.[0]?.text;
  if (!rawText) {
    throw new Error('[validation] Empty response from Claude Vision');
  }

  // Parse JSON from response (handle possible markdown fences)
  const jsonMatch = rawText.match(/\{[\s\S]*\}/);
  if (!jsonMatch) {
    throw new Error(`[validation] No JSON found in Claude response: ${rawText.slice(0, 200)}`);
  }

  let result;
  try {
    result = JSON.parse(jsonMatch[0]);
  } catch (parseErr) {
    // Try fixing trailing commas
    const fixable = jsonMatch[0].replace(/,\s*([}\]])/g, '$1');
    try {
      result = JSON.parse(fixable);
    } catch {
      throw new Error(`[validation] Failed to parse JSON: ${parseErr.message}. Raw: ${jsonMatch[0].slice(0, 200)}`);
    }
  }

  // Extract scores with safe defaults
  const scores = {
    layout_match: clampScore(result.layout_match),
    text_correctness: clampScore(result.text_correctness),
    product_fidelity: clampScore(result.product_fidelity),
    background_fidelity: clampScore(result.background_fidelity),
    competitor_branding: clampScore(result.competitor_branding),
    overall_quality: clampScore(result.overall_quality),
  };

  const issues = Array.isArray(result.issues) ? result.issues.filter(i => typeof i === 'string' && i.length > 0) : [];

  // Calculate pass/fail
  const scoreValues = Object.values(scores);
  const average = scoreValues.reduce((sum, v) => sum + v, 0) / scoreValues.length;
  const minScore = Math.min(...scoreValues);
  const passed = average > 60 && minScore >= 30;

  return {
    passed,
    score: Math.round(average),
    issues,
    scores,
  };
}

/**
 * Clamp a score value to 0-100, defaulting to 0 for invalid input.
 */
function clampScore(val) {
  if (typeof val !== 'number' || isNaN(val)) return 0;
  return Math.max(0, Math.min(100, Math.round(val)));
}
