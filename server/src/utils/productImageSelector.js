// ─────────────────────────────────────────────────────────────────────────────
// Product Image Selector — picks the best product image for a given orientation
// Uses Claude Haiku vision to analyze product photos and match orientations.
// ─────────────────────────────────────────────────────────────────────────────

import { resolveImage } from './imageHelpers.js';

const CLAUDE_API_URL = 'https://api.anthropic.com/v1/messages';
const ANTHROPIC_API_KEY = process.env.ANTHROPIC_API_KEY || '';

// In-memory cache: orientation:imageUrls → selection result
const selectionCache = new Map();
const CACHE_TTL = 60 * 60 * 1000; // 1 hour

function getCacheKey(orientation, imageUrls) {
  return `${orientation}:${imageUrls.join(',')}`;
}

function getCached(key) {
  const entry = selectionCache.get(key);
  if (!entry) return null;
  if (Date.now() - entry.timestamp > CACHE_TTL) {
    selectionCache.delete(key);
    return null;
  }
  return entry;
}

/**
 * Select the best product image matching the reference template's orientation.
 *
 * @param {string[]} productImages — array of product image URLs
 * @param {string}   referenceOrientation — e.g. "front-facing", "angled-left", etc.
 * @returns {{ selectedUrl: string, index: number, reason: string }}
 */
export async function selectBestProductImage(productImages, referenceOrientation) {
  // Guard: no images at all
  if (!productImages || productImages.length === 0) {
    console.log('[imageSelector] No product images provided, returning null');
    return { selectedUrl: null, index: 0, reason: 'no images available' };
  }

  // Guard: only one image — nothing to choose from
  if (productImages.length <= 1) {
    console.log('[imageSelector] Only one product image, using index 0');
    return { selectedUrl: productImages[0], index: 0, reason: 'only one image available' };
  }

  // Guard: no orientation to match against
  if (!referenceOrientation) {
    console.log('[imageSelector] No reference orientation provided, using index 0');
    return { selectedUrl: productImages[0], index: 0, reason: 'no orientation specified' };
  }

  // Check cache
  const cacheKey = getCacheKey(referenceOrientation, productImages);
  const cached = getCached(cacheKey);
  if (cached) {
    console.log(`[imageSelector] Cache hit for ${referenceOrientation} — index ${cached.index}`);
    return { selectedUrl: cached.selectedUrl, index: cached.index, reason: cached.reason };
  }

  // Limit to max 5 images to keep API costs low
  const imagesToAnalyze = productImages.slice(0, 5);
  const count = imagesToAnalyze.length;

  // Download all images to base64
  const imageBlocks = [];
  for (let i = 0; i < count; i++) {
    try {
      const { base64, mediaType } = await resolveImage(imagesToAnalyze[i]);
      imageBlocks.push({
        type: 'image',
        source: { type: 'base64', media_type: mediaType, data: base64 },
      });
      imageBlocks.push({
        type: 'text',
        text: `Image ${i + 1} of ${count}`,
      });
    } catch (err) {
      console.warn(`[imageSelector] Failed to resolve image ${i}: ${err.message}`);
      // Push a text placeholder so numbering stays consistent
      imageBlocks.push({
        type: 'text',
        text: `Image ${i + 1} of ${count} — FAILED TO LOAD`,
      });
    }
  }

  // If no images were successfully loaded, fall back
  const loadedCount = imageBlocks.filter(b => b.type === 'image').length;
  if (loadedCount === 0) {
    console.warn('[imageSelector] All image downloads failed, using index 0');
    return { selectedUrl: productImages[0], index: 0, reason: 'all image downloads failed' };
  }

  const prompt = `You are selecting the best product photo for an ad. The ad template shows the product in a "${referenceOrientation}" orientation.

Orientation guide:
- "front-facing" = straight-on, symmetrical
- "angled-left" = rotated showing left side
- "angled-right" = rotated showing right side
- "top-down" = viewed from above
- "tilted" = dramatic angle

The images below show the same product from different angles. Select the ONE that best matches "${referenceOrientation}".

Return ONLY JSON: { "selected": 1, "reason": "matches front-facing orientation" }
where "selected" is the image number (1 to ${count}).`;

  try {
    if (!ANTHROPIC_API_KEY) {
      throw new Error('ANTHROPIC_API_KEY not set');
    }

    const res = await fetch(CLAUDE_API_URL, {
      method: 'POST',
      headers: {
        'x-api-key': ANTHROPIC_API_KEY,
        'anthropic-version': '2023-06-01',
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        model: 'claude-haiku-4-5-20251001',
        max_tokens: 200,
        messages: [
          {
            role: 'user',
            content: [
              { type: 'text', text: prompt },
              ...imageBlocks,
            ],
          },
        ],
      }),
    });

    if (!res.ok) {
      const body = await res.text();
      throw new Error(`Claude API ${res.status}: ${body.slice(0, 200)}`);
    }

    const data = await res.json();
    const responseText = data?.content?.[0]?.text || '';

    // Parse JSON from response (handle markdown code fences)
    const jsonMatch = responseText.match(/\{[\s\S]*?\}/);
    if (!jsonMatch) {
      throw new Error(`No JSON in Claude response: ${responseText.slice(0, 150)}`);
    }

    const parsed = JSON.parse(jsonMatch[0]);
    const selectedNum = parseInt(parsed.selected, 10);

    if (isNaN(selectedNum) || selectedNum < 1 || selectedNum > count) {
      throw new Error(`Invalid selection number: ${parsed.selected}`);
    }

    const index = selectedNum - 1;
    const reason = parsed.reason || 'selected by vision analysis';

    const result = {
      selectedUrl: imagesToAnalyze[index],
      index,
      reason,
      timestamp: Date.now(),
    };

    // Cache the result
    selectionCache.set(cacheKey, result);

    console.log(`[imageSelector] Selected image ${selectedNum}/${count} for "${referenceOrientation}" — ${reason}`);
    return { selectedUrl: result.selectedUrl, index: result.index, reason: result.reason };

  } catch (err) {
    console.warn(`[imageSelector] Claude vision call failed: ${err.message}`);
    return { selectedUrl: productImages[0], index: 0, reason: `fallback due to error: ${err.message}` };
  }
}
