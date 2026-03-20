import { Router } from 'express';
import { buildClaudePrompt, buildNanoBananaPrompt, buildSwapPairs } from '../utils/staticsPrompts.js';

const router = Router();
const sleep = (ms) => new Promise(r => setTimeout(r, ms));

const ANTHROPIC_API_KEY   = process.env.ANTHROPIC_API_KEY || '';
const NANOBANANA_API_KEY  = process.env.NANOBANANA_API_KEY || '';

const NB_BASE        = 'https://api.nanobananaapi.ai/api/v1/nanobanana';
const CLAUDE_API_URL = 'https://api.anthropic.com/v1/messages';
const MAX_POLLS      = 60;
const POLL_INTERVAL  = 5000;

// ── Helpers ────────────────────────────────────────────────────────────

/**
 * Detect MIME type from the first bytes of a buffer.
 */
function detectMime(buf) {
  if (buf[0] === 0xFF && buf[1] === 0xD8 && buf[2] === 0xFF) return 'image/jpeg';
  if (buf[0] === 0x89 && buf[1] === 0x50 && buf[2] === 0x4E && buf[3] === 0x47) return 'image/png';
  if (
    buf[0] === 0x52 && buf[1] === 0x49 && buf[2] === 0x46 && buf[3] === 0x46 &&
    buf[8] === 0x57 && buf[9] === 0x45 && buf[10] === 0x42 && buf[11] === 0x50
  ) return 'image/webp';
  return 'image/jpeg'; // default fallback
}

/**
 * Resolve a reference image (URL or data-URI) into { base64, mediaType, isUrl }.
 * `isUrl` indicates whether the original input was a fetchable URL.
 */
async function resolveImage(referenceImageUrl) {
  if (referenceImageUrl.startsWith('data:image')) {
    // data:image/png;base64,iVBOR...
    const match = referenceImageUrl.match(/^data:(image\/[^;]+);base64,(.+)$/);
    if (!match) throw new Error('Malformed data-URI for reference image');
    return { base64: match[2], mediaType: match[1], isUrl: false };
  }

  // Fetch from URL
  const res = await fetch(referenceImageUrl);
  if (!res.ok) throw new Error(`Failed to fetch reference image: ${res.status} ${res.statusText}`);
  const buf = Buffer.from(await res.arrayBuffer());
  const mediaType = detectMime(buf);
  return { base64: buf.toString('base64'), mediaType, isUrl: true };
}

/**
 * Poll NanoBanana for task completion.
 */
async function pollNanoBanana(taskId) {
  for (let i = 0; i < MAX_POLLS; i++) {
    await sleep(POLL_INTERVAL);

    const res = await fetch(`${NB_BASE}/record-info?taskId=${taskId}`, {
      headers: { Authorization: `Bearer ${NANOBANANA_API_KEY}` },
    });

    if (!res.ok) throw new Error(`NanoBanana status check failed: ${res.status}`);

    const data = await res.json();
    const flag = data.successFlag ?? data.data?.successFlag;

    if (flag === 1) {
      const imageUrl = data.resultImageUrl || data.data?.resultImageUrl;
      if (!imageUrl) throw new Error('NanoBanana completed but no resultImageUrl found');
      return imageUrl;
    }
    if (flag >= 2) {
      throw new Error(`NanoBanana generation failed (successFlag=${flag})`);
    }
    // flag === 0 → still pending, keep polling
  }

  throw new Error('NanoBanana generation timed out after 5 minutes');
}

// ── POST /generate ─────────────────────────────────────────────────────

router.post('/generate', async (req, res) => {
  try {
    const { reference_image_url, product, angle, ratio } = req.body;

    if (!reference_image_url) return res.status(400).json({ success: false, error: 'reference_image_url is required' });
    if (!product)             return res.status(400).json({ success: false, error: 'product is required' });

    // ── Step A: Resolve reference image to base64 ──────────────────────
    const { base64, mediaType, isUrl } = await resolveImage(reference_image_url);

    // ── Step B: Call Claude to analyze the reference ad ─────────────────
    const claudeBody = {
      model: 'claude-sonnet-4-20250514',
      max_tokens: 3000,
      messages: [{
        role: 'user',
        content: [
          { type: 'text', text: buildClaudePrompt(product, angle) },
          { type: 'image', source: { type: 'base64', media_type: mediaType, data: base64 } },
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

    // Extract JSON block (may be wrapped in markdown fences or surrounding text)
    const jsonMatch = rawText.match(/\{[\s\S]*\}/);
    if (!jsonMatch) throw new Error('Could not parse JSON from Claude response');

    let claudeResult;
    try {
      claudeResult = JSON.parse(jsonMatch[0]);
    } catch (parseErr) {
      throw new Error(`Failed to parse Claude JSON: ${parseErr.message}`);
    }

    // ── Step C: Build swap pairs ───────────────────────────────────────
    const swapPairs = buildSwapPairs(claudeResult.original_text, claudeResult.adapted_text);

    // ── Step D: Submit to NanoBanana ───────────────────────────────────
    // NanoBanana requires actual HTTP URLs, not base64
    if (!isUrl) {
      console.warn('[staticsGeneration] Reference image was base64 — skipping NanoBanana (URL required for image generation)');
      return res.json({
        success: true,
        data: {
          generated_image_url: null,
          adapted_text: claudeResult.adapted_text,
          original_text: claudeResult.original_text,
          swap_pairs: swapPairs,
          people_count: claudeResult.people_count,
          product_count: claudeResult.product_count,
          visual_adaptations: claudeResult.visual_adaptations,
          adapted_audience: claudeResult.adapted_audience,
          _note: 'Reference image was provided as base64. An HTTP URL is required for image generation.',
        },
      });
    }

    const nbPrompt = buildNanoBananaPrompt(claudeResult, swapPairs, product);

    const nbRes = await fetch(`${NB_BASE}/generate-2`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${NANOBANANA_API_KEY}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        prompt: nbPrompt,
        model: 'nano-banana-2',
        imageUrls: [product.product_image_url, reference_image_url],
        aspectRatio: ratio || '4:5',
        resolution: '1K',
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

    // ── Step E: Poll for completion ────────────────────────────────────
    const generatedImageUrl = await pollNanoBanana(taskId);

    // ── Step F: Return final response ──────────────────────────────────
    return res.json({
      success: true,
      data: {
        generated_image_url: generatedImageUrl,
        adapted_text: claudeResult.adapted_text,
        original_text: claudeResult.original_text,
        swap_pairs: swapPairs,
        people_count: claudeResult.people_count,
        product_count: claudeResult.product_count,
        visual_adaptations: claudeResult.visual_adaptations,
        adapted_audience: claudeResult.adapted_audience,
      },
    });
  } catch (err) {
    console.error('[staticsGeneration] /generate error:', err);
    const status = err.message.includes('is required') ? 400 : 500;
    return res.status(status).json({ success: false, error: err.message });
  }
});

// ── GET /status/:taskId ────────────────────────────────────────────────

router.get('/status/:taskId', async (req, res) => {
  try {
    const { taskId } = req.params;
    if (!taskId) return res.status(400).json({ success: false, error: 'taskId is required' });

    const nbRes = await fetch(`${NB_BASE}/record-info?taskId=${taskId}`, {
      headers: { Authorization: `Bearer ${NANOBANANA_API_KEY}` },
    });

    if (!nbRes.ok) {
      const errText = await nbRes.text();
      throw new Error(`NanoBanana status error ${nbRes.status}: ${errText}`);
    }

    const data = await nbRes.json();
    const flag = data.successFlag ?? data.data?.successFlag;

    let status;
    if (flag === 0)      status = 'pending';
    else if (flag === 1) status = 'completed';
    else                 status = 'failed';

    return res.json({
      success: true,
      data: {
        taskId,
        status,
        successFlag: flag,
        resultImageUrl: data.resultImageUrl || data.data?.resultImageUrl || null,
      },
    });
  } catch (err) {
    console.error('[staticsGeneration] /status error:', err);
    return res.status(500).json({ success: false, error: err.message });
  }
});

export default router;
