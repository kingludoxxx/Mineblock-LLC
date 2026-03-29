import { buildClaudePrompt, buildNanoBananaPrompt as _buildNBPrompt, buildSwapPairs as _buildSwapPairs } from '../utils/staticsPrompts.js';
import { uploadBuffer, isR2Configured } from './r2.js';
import crypto from 'crypto';

const ANTHROPIC_API_KEY  = process.env.ANTHROPIC_API_KEY || '';
const NANOBANANA_API_KEY = process.env.NANOBANANA_API_KEY || '';

const NB_BASE        = 'https://api.nanobananaapi.ai/api/v1/nanobanana';
const CLAUDE_API_URL = 'https://api.anthropic.com/v1/messages';
const DEFAULT_MAX_POLLS     = 60;
const DEFAULT_POLL_INTERVAL = 5000;

const sleep = (ms) => new Promise(r => setTimeout(r, ms));

// ── Helpers ────────────────────────────────────────────────────────────

function detectMime(buf) {
  if (buf[0] === 0xFF && buf[1] === 0xD8 && buf[2] === 0xFF) return 'image/jpeg';
  if (buf[0] === 0x89 && buf[1] === 0x50 && buf[2] === 0x4E && buf[3] === 0x47) return 'image/png';
  if (
    buf[0] === 0x52 && buf[1] === 0x49 && buf[2] === 0x46 && buf[3] === 0x46 &&
    buf[8] === 0x57 && buf[9] === 0x45 && buf[10] === 0x42 && buf[11] === 0x50
  ) return 'image/webp';
  return 'image/jpeg';
}

/**
 * Resolve a reference image (URL or data-URI) into { base64, mediaType, isUrl }.
 */
export async function resolveImage(referenceImageUrl) {
  if (referenceImageUrl.startsWith('data:image')) {
    const match = referenceImageUrl.match(/^data:(image\/[^;]+);base64,(.+)$/);
    if (!match) throw new Error('Malformed data-URI for reference image');
    return { base64: match[2], mediaType: match[1], isUrl: false };
  }

  const res = await fetch(referenceImageUrl);
  if (!res.ok) throw new Error(`Failed to fetch reference image: ${res.status} ${res.statusText}`);
  const buf = Buffer.from(await res.arrayBuffer());
  const mediaType = detectMime(buf);
  return { base64: buf.toString('base64'), mediaType, isUrl: true };
}

// ── Exported service functions ─────────────────────────────────────────

/**
 * Call Claude with vision to analyze a reference ad image and generate adapted copy.
 * @param {string} imageBase64 - Base64-encoded image data
 * @param {string} mediaType   - MIME type (image/jpeg, image/png, image/webp)
 * @param {object} product     - Product object with name, description, price, profile, etc.
 * @param {string} angle       - Marketing angle (optional)
 * @param {string} refineFeedback - Additional feedback for refinement (optional, prepended to prompt)
 * @returns {object} Parsed JSON result with original_text, adapted_text, people_count, visual_adaptations, etc.
 */
export async function analyzeWithClaude(imageBase64, mediaType, product, angle, refineFeedback) {
  let promptText = buildClaudePrompt(product, angle);
  if (refineFeedback) {
    promptText = `REFINEMENT FEEDBACK: ${refineFeedback}\n\n${promptText}`;
  }

  const claudeBody = {
    model: 'claude-sonnet-4-20250514',
    max_tokens: 3000,
    messages: [{
      role: 'user',
      content: [
        { type: 'text', text: promptText },
        { type: 'image', source: { type: 'base64', media_type: mediaType, data: imageBase64 } },
      ],
    }],
  };

  const claudeRes = await fetch(CLAUDE_API_URL, {
    method: 'POST',
    headers: {
      'x-api-key': ANTHROPIC_API_KEY,
      'anthropic-version': '2023-06-01',
      'Content-Type': 'application/json',
    },
    body: JSON.stringify(claudeBody),
  });

  if (!claudeRes.ok) {
    const errText = await claudeRes.text();
    throw new Error(`Claude API error ${claudeRes.status}: ${errText}`);
  }

  const claudeData = await claudeRes.json();
  const rawText = claudeData.content?.[0]?.text;
  if (!rawText) throw new Error('Empty response from Claude');

  const jsonMatch = rawText.match(/\{[\s\S]*\}/);
  if (!jsonMatch) throw new Error('Could not parse JSON from Claude response');

  try {
    return JSON.parse(jsonMatch[0]);
  } catch (parseErr) {
    throw new Error(`Failed to parse Claude JSON: ${parseErr.message}`);
  }
}

/**
 * Compare original vs adapted text fields and create swap pairs array.
 * Re-exports the logic from staticsPrompts.js for convenience.
 */
export function buildSwapPairs(originalText, adaptedText) {
  return _buildSwapPairs(originalText, adaptedText);
}

/**
 * Build the NanoBanana generation prompt.
 * Re-exports the logic from staticsPrompts.js for convenience.
 */
export function buildNanoBananaPrompt(claudeResult, swapPairs, product) {
  return _buildNBPrompt(claudeResult, swapPairs, product);
}

/**
 * Submit a generation request to NanoBanana.
 * @param {string} prompt     - The generation prompt
 * @param {string[]} imageUrls - Array of image URLs [product_image, reference_image]
 * @param {string} ratio      - Aspect ratio (default '4:5')
 * @param {string} resolution - Output resolution (default '1K')
 * @returns {string} taskId
 */
export async function submitToNanoBanana(prompt, imageUrls, ratio = '4:5', resolution = '1K') {
  const nbRes = await fetch(`${NB_BASE}/generate-2`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${NANOBANANA_API_KEY}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      prompt,
      model: 'nano-banana-2',
      imageUrls,
      aspectRatio: ratio,
      resolution,
      outputFormat: 'png',
    }),
  });

  if (!nbRes.ok) {
    const errText = await nbRes.text();
    throw new Error(`NanoBanana submit error ${nbRes.status}: ${errText}`);
  }

  const nbData = await nbRes.json();
  const taskId = nbData.taskId || nbData.data?.taskId;
  if (!taskId) throw new Error('No taskId returned from NanoBanana');
  return taskId;
}

/**
 * Poll NanoBanana for task completion.
 * @param {string} taskId       - The task ID to poll
 * @param {number} maxPolls     - Maximum number of polls (default 60)
 * @param {number} pollInterval - Milliseconds between polls (default 5000)
 * @returns {string} resultImageUrl
 */
export async function pollNanoBanana(taskId, maxPolls = DEFAULT_MAX_POLLS, pollInterval = DEFAULT_POLL_INTERVAL) {
  for (let i = 0; i < maxPolls; i++) {
    await sleep(pollInterval);

    const res = await fetch(`${NB_BASE}/record-info?taskId=${taskId}`, {
      headers: { Authorization: `Bearer ${NANOBANANA_API_KEY}` },
    });

    if (!res.ok) throw new Error(`NanoBanana status check failed: ${res.status}`);

    const data = await res.json();
    const flag = Number(data.successFlag ?? data.data?.successFlag);

    if (flag === 1) {
      const imageUrl = data.resultImageUrl || data.data?.resultImageUrl;
      if (!imageUrl) throw new Error('NanoBanana completed but no resultImageUrl found');
      return imageUrl;
    }
    if (flag >= 2) {
      throw new Error(`NanoBanana generation failed (successFlag=${flag})`);
    }
    // flag === 0 -> still pending
  }

  throw new Error('NanoBanana generation timed out after polling');
}

/**
 * Orchestrate the full image generation pipeline:
 *   resolve image -> Claude analysis -> swap pairs -> NanoBanana submit -> poll -> result
 *
 * @param {string} referenceImageUrl - URL or data-URI of the reference ad
 * @param {object} product           - Product object (must include product_image_url)
 * @param {string} angle             - Marketing angle (optional)
 * @param {string} ratio             - Aspect ratio (default '4:5')
 * @returns {object} { generated_image_url, adapted_text, original_text, swap_pairs, people_count, product_count, visual_adaptations, adapted_audience }
 */
export async function generateFullPipeline(referenceImageUrl, product, angle, ratio = '4:5') {
  // Step A: Resolve reference image
  const { base64, mediaType, isUrl } = await resolveImage(referenceImageUrl);

  // Step B: Claude analysis
  const claudeResult = await analyzeWithClaude(base64, mediaType, product, angle);

  // Step C: Build swap pairs
  const swapPairs = buildSwapPairs(claudeResult.original_text, claudeResult.adapted_text);

  // Upload base64 images to R2 (or skip if not configured — caller's route
  // provides a temp-image fallback in that case).
  let finalReferenceUrl = referenceImageUrl;
  if (!isUrl && isR2Configured()) {
    const buf = Buffer.from(base64, 'base64');
    const ext = mediaType.includes('png') ? 'png' : 'jpg';
    const key = `statics-refs/${crypto.randomUUID()}.${ext}`;
    finalReferenceUrl = await uploadBuffer(buf, key, mediaType);
    console.log(`[imageGeneration] Uploaded base64 reference to R2: ${finalReferenceUrl}`);
  } else if (!isUrl) {
    throw new Error('Cannot convert base64 reference to URL — R2 not configured and no fallback available in service layer. Use the route endpoint instead.');
  }

  let finalProductUrl = product.product_image_url;
  if (finalProductUrl?.startsWith('data:image') && isR2Configured()) {
    const pMatch = finalProductUrl.match(/^data:(image\/[^;]+);base64,(.+)$/);
    if (pMatch) {
      const pBuf = Buffer.from(pMatch[2], 'base64');
      const pExt = pMatch[1].includes('png') ? 'png' : 'jpg';
      const pKey = `statics-products/${crypto.randomUUID()}.${pExt}`;
      finalProductUrl = await uploadBuffer(pBuf, pKey, pMatch[1]);
    }
  }

  // Step D: Submit to NanoBanana
  const nbPrompt = buildNanoBananaPrompt(claudeResult, swapPairs, product);
  const imageUrls = [finalProductUrl, finalReferenceUrl];
  const taskId = await submitToNanoBanana(nbPrompt, imageUrls, ratio);

  // Step E: Poll for completion
  const generatedImageUrl = await pollNanoBanana(taskId);

  // Step F: Return result
  return {
    generated_image_url: generatedImageUrl,
    adapted_text: claudeResult.adapted_text,
    original_text: claudeResult.original_text,
    swap_pairs: swapPairs,
    people_count: claudeResult.people_count,
    product_count: claudeResult.product_count,
    visual_adaptations: claudeResult.visual_adaptations,
    adapted_audience: claudeResult.adapted_audience,
  };
}
