// ─────────────────────────────────────────────────────────────────────────────
// imageGeneration — thin NanoBanana (Kie.ai) client
//
// After migration 036 the full pipeline orchestration lives in
// routes/staticsGeneration.js. This file now exports ONLY the NanoBanana
// submit/poll helpers (used by both staticsGeneration.js and any future
// callers). Old wrappers (analyzeWithClaude, buildSwapPairs,
// buildNanoBananaPrompt, generateFullPipeline) were removed because they
// depended on prompt builders that no longer exist.
// ─────────────────────────────────────────────────────────────────────────────

const NANOBANANA_API_KEY = process.env.NANOBANANA_API_KEY || '';
const NB_BASE            = 'https://api.kie.ai/api/v1/jobs';

// NB image gen typically takes 15-30s. Polling at 5s wastes up to 5s of wall
// time per ratio. Drop to 2s for snappier completion. Total max wait stays
// generous: 90 polls × 2s = 3 min ceiling.
const DEFAULT_MAX_POLLS     = 90;
const DEFAULT_POLL_INTERVAL = 2000;

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
 * Kept for backwards-compat with callers that import from here. New code
 * should prefer the shared helper in utils/imageHelpers.js.
 */
export async function resolveImage(referenceImageUrl) {
  if (referenceImageUrl.startsWith('data:image')) {
    const match = referenceImageUrl.match(/^data:(image\/[^;]+);base64,(.+)$/);
    if (!match) throw new Error('Malformed data-URI for reference image');
    return { base64: match[2], mediaType: match[1], isUrl: false };
  }

  let fetchUrl = referenceImageUrl;
  if (referenceImageUrl.startsWith('/')) {
    const base = process.env.RENDER_EXTERNAL_URL || `http://localhost:${process.env.PORT || 3000}`;
    fetchUrl = `${base}${referenceImageUrl}`;
  }

  const res = await fetch(fetchUrl);
  if (!res.ok) throw new Error(`Failed to fetch reference image: ${res.status} ${res.statusText}`);
  const buf = Buffer.from(await res.arrayBuffer());
  const mediaType = detectMime(buf);
  return { base64: buf.toString('base64'), mediaType, isUrl: true };
}

// ── NanoBanana (Kie.ai) ────────────────────────────────────────────────

/**
 * Submit a generation request to NanoBanana.
 * @param {string}   prompt     — final prompt text
 * @param {string[]} imageUrls  — input image URLs (per friend's tool architecture,
 *                                this should be ONLY the product image for /generate,
 *                                or ONLY the current generated image for /ai-adjust;
 *                                never include the reference template)
 * @param {string}   ratio      — '1:1' | '4:5' | '9:16' etc
 * @param {string}   resolution — '1K' | '2K' (default '1K')
 * @returns {string} taskId for polling
 */
// Kie.ai accepts these aspect-ratio strings for google/nano-banana-edit.
// Any unrecognized value (e.g. 'all', '1080x1080', undefined) is normalized to '1:1'
// to prevent 500 "image_size is not within the range of allowed options" errors.
const NB_VALID_RATIOS = new Set(['1:1', '4:5', '9:16', '16:9', '3:2', '2:3', 'auto']);

export async function submitToNanoBanana(prompt, imageUrls, ratio = '4:5', resolution = '1K') {
  if (!NANOBANANA_API_KEY) {
    throw new Error('NANOBANANA_API_KEY is not configured');
  }

  const imageSize = NB_VALID_RATIOS.has(ratio) ? ratio : '1:1';
  if (imageSize !== ratio) {
    console.warn(`[NanoBanana] Unsupported image_size "${ratio}" — falling back to "1:1"`);
  }

  const nbRes = await fetch(`${NB_BASE}/createTask`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${NANOBANANA_API_KEY}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      model: 'google/nano-banana-edit',
      input: {
        prompt,
        image_urls: imageUrls,
        image_size: imageSize,
        output_format: 'png',
      },
    }),
  });

  if (!nbRes.ok) {
    const errText = await nbRes.text();
    throw new Error(`NanoBanana submit error ${nbRes.status}: ${errText.slice(0, 400)}`);
  }

  const nbData = await nbRes.json();
  const taskId = nbData.data?.taskId || nbData.taskId;
  if (!taskId) throw new Error(`No taskId returned from NanoBanana: ${JSON.stringify(nbData).slice(0, 300)}`);
  return taskId;
}

/**
 * Poll NanoBanana for task completion.
 * @returns {string} resultImageUrl
 */
export async function pollNanoBanana(taskId, maxPolls = DEFAULT_MAX_POLLS, pollInterval = DEFAULT_POLL_INTERVAL) {
  for (let i = 0; i < maxPolls; i++) {
    await sleep(pollInterval);

    const res = await fetch(`${NB_BASE}/recordInfo?taskId=${taskId}`, {
      headers: { Authorization: `Bearer ${NANOBANANA_API_KEY}` },
    });

    if (!res.ok) throw new Error(`NanoBanana status check failed: ${res.status}`);

    const data = await res.json();
    const record = data.data || data;
    const state = record.state;

    if (state === 'success') {
      // Kie.ai returns resultJson as a JSON string with resultUrls array
      let imageUrl;
      try {
        const resultObj = typeof record.resultJson === 'string' ? JSON.parse(record.resultJson) : record.resultJson;
        imageUrl = resultObj?.resultUrls?.[0];
      } catch {}
      if (!imageUrl) imageUrl = record.resultImageUrl || data.resultImageUrl;
      if (!imageUrl) throw new Error('NanoBanana completed but no result image URL found');
      return imageUrl;
    }
    if (state === 'fail') {
      throw new Error(`NanoBanana generation failed: ${record.failMsg || 'Unknown error'}`);
    }
    // state === 'waiting' | 'queuing' | 'generating' -> still pending
  }

  throw new Error(`NanoBanana generation timed out after ${maxPolls} polls × ${pollInterval}ms`);
}

/**
 * Configuration check used by callers to decide whether NanoBanana is available.
 */
export function isNanoBananaConfigured() {
  return Boolean(NANOBANANA_API_KEY);
}
