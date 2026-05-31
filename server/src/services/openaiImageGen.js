// ─────────────────────────────────────────────────────────────────────────────
// openaiImageGen — thin OpenAI gpt-image-2 client
//
// Sibling of imageGeneration.js (NanoBanana). Exports the same submit/poll
// interface so callers in routes/staticsGeneration.js can stay engine-agnostic
// via the imageEngines.js abstraction.
//
// gpt-image-2 (released April 2026):
//   - flexible sizes (WxH divisible by 16, ratio 1:3..3:1)
//   - (gpt-image-1 had input_fidelity:'high'; gpt-image-2 does not — removed)
//   - token-based pricing, 50% Batch API discount
//
// Synchronous API: /v1/images/{generations,edits} returns the result inline
// (no polling). To keep the submit/poll interface symmetric with NanoBanana,
// submitToOpenAI() does the actual work and stores the result keyed by a
// synthetic taskId; pollOpenAI() just looks it up. This way the orchestration
// code in staticsGeneration.js doesn't need to branch.
// ─────────────────────────────────────────────────────────────────────────────

import { randomUUID } from 'node:crypto';

const OPENAI_API_KEY = process.env.OPENAI_API_KEY || '';
const OPENAI_IMAGE_MODEL = process.env.OPENAI_IMAGE_MODEL || 'gpt-image-2';
const OPENAI_BASE = 'https://api.openai.com/v1';

// In-process result cache keyed by synthetic taskId. Submit writes, Poll reads.
// 10-min TTL bounded by the existing 8-min outer polling cap.
const _resultStore = new Map();
const _RESULT_TTL_MS = 10 * 60 * 1000;

function _storeResult(taskId, value) {
  _resultStore.set(taskId, { value, expiresAt: Date.now() + _RESULT_TTL_MS });
  // Soft cap to prevent unbounded growth.
  if (_resultStore.size > 500) {
    const oldest = _resultStore.keys().next().value;
    _resultStore.delete(oldest);
  }
}

function _getResult(taskId) {
  const entry = _resultStore.get(taskId);
  if (!entry) return null;
  if (entry.expiresAt < Date.now()) {
    _resultStore.delete(taskId);
    return null;
  }
  return entry.value;
}

// ── Aspect ratio → pixel size (gpt-image-2 requires WxH divisible by 16) ─
// Operator's standard ratios. 720x1280 for 9:16 = exact 9:16 with both
// dimensions divisible by 16. 1024x1280 for 4:5 = exact 4:5. 1024x1024 for 1:1.
const RATIO_TO_SIZE = {
  '1:1':  '1024x1024',
  '4:5':  '1024x1280',
  '9:16': '720x1280',
  '16:9': '1280x720',
  '3:2':  '1296x864',
  '2:3':  '864x1296',
};

function ratioToSize(ratio) {
  return RATIO_TO_SIZE[ratio] || '1024x1024';
}

// ── Public API ────────────────────────────────────────────────────────────

/**
 * Submit an image generation request to OpenAI gpt-image-2.
 * Mirrors the NanoBanana submitToNanoBanana signature so it can be swapped
 * via the engines abstraction.
 *
 * @param {string}   prompt     - final prompt text
 * @param {string[]} imageUrls  - 0 → text-to-image generate; 1+ → edit mode
 * @param {string}   ratio      - '1:1' | '4:5' | '9:16' etc
 * @returns {string} taskId for polling (synthetic — OpenAI is synchronous,
 *                   the actual result is already stored by the time this returns)
 */
export async function submitToOpenAI(prompt, imageUrls = [], ratio = '1:1') {
  if (!OPENAI_API_KEY) throw new Error('OPENAI_API_KEY is not configured');

  const size = ratioToSize(ratio);
  const taskId = `oai-${randomUUID()}`;

  // Branch: generate (no input image) vs edit (one or more input images).
  // For edit mode, we need to fetch the source image bytes and send via
  // multipart/form-data. For generate, we send JSON.
  if (imageUrls.length === 0) {
    // ─── Generate (text → image) ─────────────────────────────────────────
    // NOTE: input_fidelity is a gpt-image-1 parameter and was rejected by
    // gpt-image-2 with `invalid_input_fidelity_model`. Removed for gpt-image-2.
    const body = {
      model: OPENAI_IMAGE_MODEL,
      prompt,
      size,
      n: 1,
      quality: 'high',
    };

    const res = await fetch(`${OPENAI_BASE}/images/generations`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${OPENAI_API_KEY}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(body),
      // 5 min — gpt-image-2 quality='high' fresh-generation can be slow.
      // Callers run this in background (setImmediate), so we're not HTTP-bound.
      signal: AbortSignal.timeout(300_000),
    });

    if (!res.ok) {
      const errText = await res.text();
      throw new Error(`OpenAI image generate ${res.status}: ${errText.slice(0, 400)}`);
    }

    const data = await res.json();
    const item = data?.data?.[0];
    if (!item) throw new Error(`OpenAI returned no image: ${JSON.stringify(data).slice(0, 200)}`);

    // gpt-image-2 returns b64_json by default; older models may return url.
    let resultUrl;
    if (item.b64_json) {
      // Inline data URI — caller's persist step will upload to R2.
      resultUrl = `data:image/png;base64,${item.b64_json}`;
    } else if (item.url) {
      resultUrl = item.url;
    } else {
      throw new Error('OpenAI response has neither b64_json nor url');
    }

    _storeResult(taskId, resultUrl);
    return taskId;
  }

  // ─── Edit (image + prompt → new image) ────────────────────────────────
  // gpt-image-2 supports multi-image input via repeated image[] fields.
  const form = new FormData();
  form.append('model', OPENAI_IMAGE_MODEL);
  form.append('prompt', prompt);
  form.append('size', size);
  form.append('n', '1');
  form.append('quality', 'high');
  // NOTE: input_fidelity is gpt-image-1 only; gpt-image-2 rejects it. Removed.

  // Edits run via the same endpoint with multipart/form-data + an
  // image[] field per input. They're the slowest path in the API —
  // bump the timeout to 5 min since edits run in background jobs
  // (setImmediate) and aren't HTTP-bound to the original request.

  // Fetch each input image and append as a Blob.
  for (let i = 0; i < imageUrls.length; i++) {
    const url = imageUrls[i];
    let buf;
    if (url.startsWith('data:')) {
      const match = url.match(/^data:(image\/[^;]+);base64,(.+)$/);
      if (!match) throw new Error('Malformed data-URI for input image');
      buf = Buffer.from(match[2], 'base64');
    } else {
      const r = await fetch(url, { signal: AbortSignal.timeout(30_000) });
      if (!r.ok) throw new Error(`Failed to fetch input image ${url}: ${r.status}`);
      buf = Buffer.from(await r.arrayBuffer());
    }
    const blob = new Blob([buf], { type: 'image/png' });
    // Multiple-image edit uses the `image[]` field per OpenAI docs.
    form.append('image[]', blob, `input-${i}.png`);
  }

  const res = await fetch(`${OPENAI_BASE}/images/edits`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${OPENAI_API_KEY}` },
    body: form,
    // 5 min — edits are the slowest path. Background job (setImmediate),
    // so we're not HTTP-bound to the original /edit request. The frontend
    // polls for completion.
    signal: AbortSignal.timeout(300_000),
  });

  if (!res.ok) {
    const errText = await res.text();
    throw new Error(`OpenAI image edit ${res.status}: ${errText.slice(0, 400)}`);
  }

  const data = await res.json();
  const item = data?.data?.[0];
  if (!item) throw new Error(`OpenAI edit returned no image: ${JSON.stringify(data).slice(0, 200)}`);

  let resultUrl;
  if (item.b64_json) {
    resultUrl = `data:image/png;base64,${item.b64_json}`;
  } else if (item.url) {
    resultUrl = item.url;
  } else {
    throw new Error('OpenAI edit response has neither b64_json nor url');
  }

  _storeResult(taskId, resultUrl);
  return taskId;
}

/**
 * Poll for completion. OpenAI is synchronous so this just reads from the
 * in-process store populated by submitToOpenAI. Kept as a separate function
 * so the orchestration code in staticsGeneration.js doesn't need to branch.
 *
 * @returns {string} resultImageUrl (may be a data URI for b64 responses)
 */
export async function pollOpenAI(taskId) {
  const result = _getResult(taskId);
  if (!result) {
    throw new Error(`OpenAI taskId ${taskId} not found in result store (expired or invalid)`);
  }
  // One-shot consume — free the memory.
  _resultStore.delete(taskId);
  return result;
}

export function isOpenAIConfigured() {
  return Boolean(OPENAI_API_KEY);
}

export function getOpenAIModel() {
  return OPENAI_IMAGE_MODEL;
}
