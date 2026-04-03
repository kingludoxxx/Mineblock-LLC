import { Router } from 'express';
import { buildClaudePrompt, buildNanoBananaPrompt, buildSwapPairs } from '../utils/staticsPrompts.js';
import { pgQuery } from '../db/pg.js';
import { authenticate } from '../middleware/auth.js';
import { uploadBuffer, isR2Configured } from '../services/r2.js';
import crypto from 'crypto';
import {
  isMetaAdsConfigured, createAdSet, createFlexibleAdCreative, createAd,
  uploadAdImageFromUrl
} from '../services/metaAdsApi.js';

const router = Router();
const sleep = (ms) => new Promise(r => setTimeout(r, ms));

// ── Temporary image store (serves base64 as HTTP URLs for NanoBanana) ──
const tempImages = new Map();
const TEMP_IMAGE_TTL = 10 * 60 * 1000; // 10 minutes
const MAX_TEMP_IMAGES = 100;

function storeTempImage(buf, contentType) {
  if (tempImages.size >= MAX_TEMP_IMAGES) {
    const oldest = tempImages.keys().next().value;
    tempImages.delete(oldest);
  }
  const id = crypto.randomUUID();
  tempImages.set(id, { buf, contentType });
  setTimeout(() => tempImages.delete(id), TEMP_IMAGE_TTL);
  return id;
}

router.get('/tmp-img/:id', (req, res) => {
  const entry = tempImages.get(req.params.id);
  if (!entry) return res.status(404).send('Expired or not found');
  res.set('Content-Type', entry.contentType);
  res.set('Cache-Control', 'no-store');
  res.send(entry.buf);
});

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
 * Extract the generated image URL from a NanoBanana response.
 * The API returns the URL in data.data.response — but it can be a plain URL string,
 * a JSON string containing a URL, or an object with a url property.
 */
function extractNanoBananaImageUrl(data) {
  const raw = data.data?.response;
  let url = null;

  if (typeof raw === 'string' && raw.startsWith('http')) {
    url = raw;
  } else if (typeof raw === 'string' && raw.length > 0) {
    try {
      const parsed = JSON.parse(raw);
      url = parsed.imageUrl || parsed.image_url || parsed.url
        || parsed.output?.url || parsed.output?.image_url
        || parsed.data?.url || parsed.data?.image_url || null;
    } catch {
      if (raw.startsWith('data:image')) url = raw;
    }
  } else if (typeof raw === 'object' && raw !== null) {
    url = raw.resultImageUrl || raw.imageUrl || raw.image_url || raw.url
      || raw.output?.url || raw.output?.image_url || null;
  }

  // Fallback to other known fields
  if (!url) {
    url = data.data?.resultImageUrl || data.resultImageUrl
      || data.data?.imageUrl || data.imageUrl
      || data.data?.outputUrl || data.outputUrl || null;
  }

  if (typeof raw === 'object' && raw !== null) {
    console.log(`[staticsGeneration] extractNanoBananaImageUrl: raw is OBJECT, keys=${JSON.stringify(Object.keys(raw))}, full=${JSON.stringify(raw).slice(0, 500)}`);
  } else {
    console.log(`[staticsGeneration] extractNanoBananaImageUrl: raw type=${typeof raw}, len=${String(raw).length}, first500=${String(raw).slice(0, 500)}`);
  }
  console.log(`[staticsGeneration] extractNanoBananaImageUrl: extracted=${String(url).slice(0, 200)}`);
  return url;
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

  // Relative paths (e.g. /static-templates/...) need a base URL for Node fetch
  let fetchUrl = referenceImageUrl;
  if (referenceImageUrl.startsWith('/')) {
    const base = process.env.RENDER_EXTERNAL_URL || `http://localhost:${process.env.PORT || 3000}`;
    fetchUrl = `${base}${referenceImageUrl}`;
  }

  // Fetch from URL
  const res = await fetch(fetchUrl);
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
    const flag = Number(data.successFlag ?? data.data?.successFlag);

    // Log every poll response for debugging
    console.log(`[staticsGeneration] Poll ${i+1}/${MAX_POLLS} — flag=${flag}, keys=${Object.keys(data)}, data.keys=${data.data ? Object.keys(data.data) : 'N/A'}`);

    if (flag === 1) {
      const imageUrl = extractNanoBananaImageUrl(data);
      if (!imageUrl) {
        console.error('[staticsGeneration] NanoBanana success but no image URL extracted.');
        console.error('[staticsGeneration] Full response (3000 chars):', JSON.stringify(data).slice(0, 3000));
        throw new Error('NanoBanana completed but no resultImageUrl found');
      }
      return imageUrl;
    }
    if (flag >= 2) {
      console.error('[staticsGeneration] NanoBanana failed. Full response:', JSON.stringify(data).slice(0, 2000));
      throw new Error(`NanoBanana generation failed (successFlag=${flag})`);
    }
    // flag === 0 or NaN → still pending, keep polling
  }

  throw new Error('NanoBanana generation timed out after 5 minutes');
}

/**
 * Ensure a URL is HTTP-accessible for NanoBanana (converts data-URIs and relative paths).
 */
async function ensureHttpUrlGlobal(url, label = 'img') {
  if (!url) return url;
  if (url.startsWith('/')) return `${SERVER_URL}${url}`;
  if (!url.startsWith('data:image')) return url;
  const m = url.match(/^data:(image\/[^;]+);base64,(.+)$/);
  if (!m) return url;
  const buf = Buffer.from(m[2], 'base64');
  if (isR2Configured()) {
    const ext = m[1].includes('png') ? 'png' : 'jpg';
    const key = `statics-${label}/${crypto.randomUUID()}.${ext}`;
    return await uploadBuffer(buf, key, m[1]);
  }
  const id = storeTempImage(buf, m[1]);
  return `${SERVER_URL}/api/v1/statics-generation/tmp-img/${id}`;
}

// ── POST /generate ─────────────────────────────────────────────────────

router.post('/generate', authenticate, async (req, res) => {
  try {
    const { reference_image_url, product, angle, ratio } = req.body;

    if (!reference_image_url) return res.status(400).json({ success: false, error: 'reference_image_url is required' });
    if (!product)             return res.status(400).json({ success: false, error: 'product is required' });

    // ── Load custom prompt overrides ──────────────────────────────────
    const customPrompts = await getCustomStaticsPrompts();

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

    const RETRY_DELAYS = [0, 8000, 20000, 45000];
    const RETRYABLE_STATUSES = [429, 503, 529];
    let claudeRes;
    for (let attempt = 0; attempt <= RETRY_DELAYS.length; attempt++) {
      claudeRes = await fetch(CLAUDE_API_URL, {
        method: 'POST',
        headers: {
          'x-api-key': ANTHROPIC_API_KEY,
          'anthropic-version': '2023-06-01',
          'Content-Type': 'application/json',
        },
        body: JSON.stringify(claudeBody),
      });

      if (claudeRes.ok) break;

      if (!RETRYABLE_STATUSES.includes(claudeRes.status) || attempt === RETRY_DELAYS.length) {
        const errText = await claudeRes.text();
        throw new Error(`Claude API error ${claudeRes.status}: ${errText}`);
      }

      console.log(`Claude API returned ${claudeRes.status}, retrying (attempt ${attempt + 1}/${RETRY_DELAYS.length}) after ${RETRY_DELAYS[attempt] / 1000}s...`);
      if (RETRY_DELAYS[attempt] > 0) await sleep(RETRY_DELAYS[attempt]);
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
    // NanoBanana requires actual HTTP URLs, not base64.
    // Prefer R2 if configured; otherwise self-host temp images.
    const SERVER_URL = process.env.RENDER_EXTERNAL_URL || `http://localhost:${process.env.PORT || 3000}`;

    async function ensureHttpUrl(dataUri, label) {
      if (!dataUri) return dataUri;
      // Convert relative paths to full URLs (NanoBanana needs absolute HTTP URLs)
      if (dataUri.startsWith('/')) return `${SERVER_URL}${dataUri}`;
      if (!dataUri.startsWith('data:image')) return dataUri;
      const m = dataUri.match(/^data:(image\/[^;]+);base64,(.+)$/);
      if (!m) return dataUri;
      const buf = Buffer.from(m[2], 'base64');
      if (isR2Configured()) {
        const ext = m[1].includes('png') ? 'png' : 'jpg';
        const key = `statics-${label}/${crypto.randomUUID()}.${ext}`;
        const url = await uploadBuffer(buf, key, m[1]);
        console.log(`[staticsGeneration] Uploaded ${label} to R2: ${url}`);
        return url;
      }
      // Fallback: self-host as temp image
      const id = storeTempImage(buf, m[1]);
      const url = `${SERVER_URL}/api/v1/statics-generation/tmp-img/${id}`;
      console.log(`[staticsGeneration] Stored ${label} as temp image: ${url}`);
      return url;
    }

    let finalReferenceUrl = isUrl ? reference_image_url : await ensureHttpUrl(reference_image_url, 'refs');
    let finalProductUrl = await ensureHttpUrl(product.product_image_url, 'products');

    // Only send extra product images if client explicitly selects them
    // By default, send ONLY the main product image for maximum fidelity
    const selectedImages = product.selected_product_images || [];
    const extraProductUrls = [];
    for (let i = 0; i < Math.min(selectedImages.length, 2); i++) {
      const img = selectedImages[i];
      if (img && img !== product.product_image_url) {
        const url = await ensureHttpUrl(img, `products-${i}`);
        if (url) extraProductUrls.push(url);
      }
    }

    // Resolve logo URLs for brand accuracy
    const logoUrls = [];
    const allLogos = product.logos || [];
    if (product.logo_url) allLogos.unshift(product.logo_url);
    for (let i = 0; i < Math.min(allLogos.length, 2); i++) {
      const url = await ensureHttpUrl(allLogos[i], `logos-${i}`);
      if (url) logoUrls.push(url);
    }

    console.log(`[staticsGeneration] Logo data: logo_url=${product.logo_url ? 'yes' : 'no'}, logos=${(product.logos || []).length}, resolved logoUrls=${logoUrls.length}`);
    console.log(`[staticsGeneration] Product images: main=${finalProductUrl ? 'yes' : 'no'}, extra=${extraProductUrls.length}`);
    console.log(`[staticsGeneration] Image URLs sent to NanoBanana:`);
    console.log(`  [0] main product: ${finalProductUrl?.slice(0, 120)}`);
    extraProductUrls.forEach((u, i) => console.log(`  [${i+1}] extra product: ${u?.slice(0, 120)}`));
    logoUrls.forEach((u, i) => console.log(`  [${extraProductUrls.length+1+i}] logo: ${u?.slice(0, 120)}`));
    console.log(`  [LAST] reference: ${finalReferenceUrl?.slice(0, 120)}`);

    const nbPrompt = buildNanoBananaPrompt(claudeResult, swapPairs, product, logoUrls.length);

    // Send: product images, then logos, then reference ad (last)
    const imageUrls = [finalProductUrl, ...extraProductUrls, ...logoUrls, finalReferenceUrl];
    console.log(`[staticsGeneration] NanoBanana prompt:\n${nbPrompt}`);
    console.log(`[staticsGeneration] Total images: ${imageUrls.length} (${extraProductUrls.length} extra product, ${logoUrls.length} logos)`);

    // Determine which ratios to generate — use client-requested ratio, default to both
    const requestedRatio = req.body.ratio;
    const ratiosToGenerate = requestedRatio && requestedRatio !== 'all'
      ? [requestedRatio]
      : ['1:1', '9:16'];

    console.log(`[staticsGeneration] Generating ${ratiosToGenerate.length} ratio(s): ${ratiosToGenerate.join(', ')}`);

    const parseNbResponse = async (res, label) => {
      if (!res.ok) {
        const text = await res.text().catch(() => '');
        console.error(`[staticsGeneration] NanoBanana ${label} failed (${res.status}): ${text.slice(0, 200)}`);
        return null;
      }
      return res.json().catch(err => { console.error(`[staticsGeneration] NanoBanana ${label} JSON parse error:`, err.message); return null; });
    };

    const nbResponses = await Promise.all(
      ratiosToGenerate.map(async (r) => {
        const body = JSON.stringify({
          prompt: nbPrompt,
          model: 'nano-banana-2',
          imageUrls: imageUrls,
          aspectRatio: r,
          resolution: '2K',
          outputFormat: 'png',
        });
        const res = await fetch(`${NB_BASE}/generate-2`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${NANOBANANA_API_KEY}` },
          body,
        });
        const data = await parseNbResponse(res, r);
        const taskId = data?.data?.taskId || data?.taskId;
        return taskId ? { taskId, ratio: r } : null;
      })
    );

    const tasks = nbResponses.filter(Boolean);

    if (tasks.length === 0) {
      return res.status(500).json({ success: false, error: 'NanoBanana failed to return any task IDs' });
    }

    // ── Step E: Return immediately — client polls /status/:taskId ──────
    console.log(`[staticsGeneration] NanoBanana tasks submitted: ${tasks.map(t => `${t.ratio}=${t.taskId}`).join(', ')}`);
    res.json({
      success: true,
      data: {
        taskId: tasks[0]?.taskId,  // backward compat
        tasks,
        claudeAnalysis: claudeResult,
        adaptedText: claudeResult.adapted_text || claudeResult.adaptedText,
        swapPairs,
        originalText: claudeResult.original_text || claudeResult.originalText,
      },
    });
  } catch (err) {
    console.error('[staticsGeneration] /generate error:', err);
    const status = err.message.includes('is required') ? 400 : 500;
    return res.status(status).json({ success: false, error: err.message });
  }
});

// ── GET /status/:taskId ────────────────────────────────────────────────

router.get('/status/:taskId', authenticate, async (req, res) => {
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
    const flag = Number(data.successFlag ?? data.data?.successFlag);

    let status;
    let errorDetail = null;
    if (flag === 0 || isNaN(flag)) status = 'pending';
    else if (flag === 1)           status = 'completed';
    else {
      status = 'failed';
      // Extract actual error detail from NanoBanana response
      errorDetail = data.error || data.data?.error || data.data?.message || data.message
        || `NanoBanana generation failed (code ${flag})`;
      console.error('[staticsGeneration] NanoBanana failed for task', taskId, '— flag:', flag, '— error:', errorDetail);
    }

    const resultImageUrl = status === 'completed' ? extractNanoBananaImageUrl(data) : null;

    // Prevent browser caching so polling always gets fresh data
    res.set('Cache-Control', 'no-store, no-cache, must-revalidate');
    res.set('Pragma', 'no-cache');
    return res.json({
      success: true,
      data: {
        taskId,
        status,
        successFlag: flag,
        resultImageUrl,
        error: errorDetail,
      },
    });
  } catch (err) {
    console.error('[staticsGeneration] /status error:', err);
    return res.status(500).json({ success: false, error: err.message });
  }
});

// ── Creatives CRUD (for standard pipeline review flow) ────────────────

let crTableReady = false;
async function ensureCreativesTable() {
  if (crTableReady) return;
  await pgQuery(`
    CREATE TABLE IF NOT EXISTS spy_creatives (
      id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      product_id INTEGER,
      pipeline TEXT NOT NULL DEFAULT 'standard',
      reference_image_id UUID,
      advertorial_copy_id UUID,
      image_url TEXT,
      r2_key TEXT,
      thumbnail_url TEXT,
      source_label TEXT,
      claude_analysis JSONB,
      adapted_text JSONB,
      swap_pairs JSONB,
      generation_prompt TEXT,
      generation_provider TEXT DEFAULT 'nanobanana',
      generation_model TEXT,
      generation_task_id TEXT,
      angle TEXT,
      archetype TEXT,
      aspect_ratio TEXT DEFAULT '4:5',
      group_id UUID,
      parent_creative_id UUID,
      generation INTEGER DEFAULT 1,
      status TEXT DEFAULT 'review',
      batch_id UUID,
      batch_position INTEGER,
      review_notes TEXT,
      is_organic BOOLEAN DEFAULT false,
      feedback_action TEXT,
      feedback_reason TEXT,
      feedback_tags JSONB,
      created_at TIMESTAMPTZ DEFAULT NOW(),
      updated_at TIMESTAMPTZ DEFAULT NOW()
    )
  `);
  await pgQuery('ALTER TABLE spy_creatives ADD COLUMN IF NOT EXISTS product_name TEXT').catch(() => {});
  await pgQuery('ALTER TABLE spy_creatives ADD COLUMN IF NOT EXISTS reference_thumbnail TEXT').catch(() => {});
  await pgQuery('ALTER TABLE spy_creatives ADD COLUMN IF NOT EXISTS reference_name TEXT').catch(() => {});
  await pgQuery(`CREATE INDEX IF NOT EXISTS idx_spy_creatives_pipeline ON spy_creatives(pipeline)`).catch(() => {});
  await pgQuery(`CREATE INDEX IF NOT EXISTS idx_spy_creatives_status ON spy_creatives(status)`).catch(() => {});
  await pgQuery(`CREATE INDEX IF NOT EXISTS idx_spy_creatives_product_id ON spy_creatives(product_id)`).catch(() => {});
  await pgQuery(`CREATE INDEX IF NOT EXISTS idx_spy_creatives_created ON spy_creatives(created_at DESC)`).catch(() => {});
  await pgQuery(`CREATE INDEX IF NOT EXISTS idx_spy_creatives_parent_id ON spy_creatives(parent_creative_id)`).catch(() => {});

  // Fix existing relative reference_thumbnail paths (one-time migration)
  const baseUrl = process.env.RENDER_EXTERNAL_URL;
  if (baseUrl) {
    await pgQuery(
      `UPDATE spy_creatives SET reference_thumbnail = $1 || reference_thumbnail WHERE reference_thumbnail LIKE '/%'`,
      [baseUrl]
    ).catch(() => {});
  }

  crTableReady = true;
}

// GET /creatives — List creatives with optional filters
router.get('/creatives', authenticate, async (req, res) => {
  try {
    await ensureCreativesTable();
    const { product_id, status, pipeline = 'standard' } = req.query;
    let query = "SELECT id, product_id, product_name, image_url, thumbnail_url, source_label, angle, archetype, aspect_ratio, status, reference_thumbnail, reference_name, parent_creative_id, pipeline, created_at FROM spy_creatives WHERE pipeline = $1";
    const params = [pipeline];
    let idx = 2;

    if (product_id) { query += ` AND product_id = $${idx++}`; params.push(product_id); }
    if (status) { query += ` AND status = $${idx++}`; params.push(status); }

    query += ' ORDER BY created_at DESC';
    const rows = await pgQuery(query, params);
    res.json({ success: true, data: rows });
  } catch (err) {
    console.error('[staticsGeneration] /creatives error:', err);
    res.status(500).json({ success: false, error: { message: err.message } });
  }
});

// ── Auto-generate variant (fire-and-forget) ──────────────────────────

async function generateVariant(parent, newAspectRatio) {
  try {
    console.log(`[staticsGeneration] Resizing ${parent.id} to ${newAspectRatio} variant`);

    // 0. Clean up any previous variants for this aspect ratio
    await pgQuery(
      "DELETE FROM spy_creatives WHERE parent_creative_id = $1 AND aspect_ratio = $2",
      [parent.id, newAspectRatio]
    );

    // 1. Create placeholder child creative
    let child;
    const childRows = await pgQuery(
      `INSERT INTO spy_creatives
        (product_id, product_name, angle, aspect_ratio, status,
         parent_creative_id, reference_name, reference_thumbnail,
         adapted_text, swap_pairs, generation_prompt, source_label, pipeline)
       VALUES ($1,$2,$3,$4,'generating',$5,$6,$7,$8,$9,$10,$11,$12)
       RETURNING *`,
      [
        parent.product_id || null,
        parent.product_name || null,
        parent.angle || null,
        newAspectRatio,
        parent.id,
        parent.reference_name || null,
        parent.reference_thumbnail || null,
        parent.adapted_text ? (typeof parent.adapted_text === 'string' ? parent.adapted_text : JSON.stringify(parent.adapted_text)) : null,
        parent.swap_pairs ? (typeof parent.swap_pairs === 'string' ? parent.swap_pairs : JSON.stringify(parent.swap_pairs)) : null,
        parent.generation_prompt || null,
        parent.source_label || null,
        parent.pipeline || 'standard',
      ]
    );
    if (!childRows || childRows.length === 0) {
      throw new Error('Failed to create variant creative in DB');
    }
    child = childRows[0];

    // 2. Resolve parent image URL to an absolute HTTP URL
    if (!parent.image_url) {
      await pgQuery("UPDATE spy_creatives SET status = 'rejected', review_notes = 'Parent creative has no generated image to resize' WHERE id = $1", [child.id]);
      return;
    }

    const VARIANT_SERVER_URL = process.env.RENDER_EXTERNAL_URL || `http://localhost:${process.env.PORT || 3000}`;
    let parentImageUrl = parent.image_url;
    if (parentImageUrl.startsWith('/')) {
      parentImageUrl = `${VARIANT_SERVER_URL}${parentImageUrl}`;
    } else if (parentImageUrl.startsWith('data:image')) {
      const m = parentImageUrl.match(/^data:(image\/[^;]+);base64,(.+)$/);
      if (m) {
        const buf = Buffer.from(m[2], 'base64');
        if (isR2Configured()) {
          const ext = m[1].includes('png') ? 'png' : 'jpg';
          const key = `statics-variant-resize/${crypto.randomUUID()}.${ext}`;
          parentImageUrl = await uploadBuffer(buf, key, m[1]);
        } else {
          const id = storeTempImage(buf, m[1]);
          parentImageUrl = `${VARIANT_SERVER_URL}/api/v1/statics-generation/tmp-img/${id}`;
        }
      } else {
        await pgQuery("UPDATE spy_creatives SET status = 'rejected', review_notes = 'Could not resolve parent image URL for resize' WHERE id = $1", [child.id]);
        return;
      }
    }

    // 3. Send resize request to NanoBanana
    const resizePrompt = `Seamlessly resize this ad image to ${newAspectRatio} aspect ratio. Keep ALL content identical — same text, same product, same layout, same colors, same style. Extend or adjust the background naturally to fill the new format.`;

    const nbPayload = {
      prompt: resizePrompt,
      model: 'nano-banana-2',
      imageUrls: [parentImageUrl],
      aspectRatio: newAspectRatio,
      resolution: '1K',
      outputFormat: 'png',
    };

    console.log(`[staticsGeneration] Resize ${parent.id} → ${newAspectRatio}: sending parent image to NanoBanana`, String(parentImageUrl).slice(0, 120));

    let taskId = null;
    for (let attempt = 1; attempt <= 3; attempt++) {
      const nbRes = await fetch(`${NB_BASE}/generate-2`, {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${NANOBANANA_API_KEY}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify(nbPayload),
      });

      if (!nbRes.ok) {
        const errText = await nbRes.text();
        console.warn(`[staticsGeneration] Variant resize attempt ${attempt}/3 HTTP error: ${nbRes.status}`);
        if (attempt < 3) { await sleep(10000 * attempt); continue; }
        throw new Error(`NanoBanana resize error ${nbRes.status}: ${errText}`);
      }

      const nbData = await nbRes.json();
      taskId = nbData.taskId || nbData.data?.taskId;
      if (taskId) break;

      console.warn(`[staticsGeneration] Variant resize attempt ${attempt}/3 no taskId:`, JSON.stringify(nbData).slice(0, 300));
      if (nbData.code === 500 && attempt < 3) {
        await sleep(10000 * attempt);
        continue;
      }
      if (!taskId) {
        console.error('[staticsGeneration] Variant resize response:', JSON.stringify(nbData).slice(0, 500));
        throw new Error('No taskId returned from NanoBanana resize after 3 attempts');
      }
    }

    // 4. Poll for completion
    const imageUrl = await pollNanoBanana(taskId);

    // 5. Update child creative with result
    await pgQuery(
      "UPDATE spy_creatives SET image_url = $1, generation_task_id = $2, status = 'review', updated_at = NOW() WHERE id = $3",
      [imageUrl, taskId, child.id]
    );

    console.log(`[staticsGeneration] Variant ${child.id} (${newAspectRatio}) resized successfully`);
  } catch (err) {
    console.error(`[staticsGeneration] Variant resize failed:`, err.message);
    // Try to mark as rejected if we have a child ID
    try {
      await pgQuery(
        "UPDATE spy_creatives SET status = 'rejected', review_notes = $1, updated_at = NOW() WHERE parent_creative_id = $2 AND status = 'generating'",
        [`Variant resize failed: ${err.message}`, parent.id]
      );
    } catch { /* best effort */ }
  }
}

// PATCH /creatives/:id/status — Update creative status
router.patch('/creatives/:id/status', authenticate, async (req, res) => {
  try {
    await ensureCreativesTable();
    const { status } = req.body;
    const validStatuses = ['generating', 'review', 'approved', 'ready', 'queued', 'launching', 'launched', 'rejected', 'archived'];
    if (!validStatuses.includes(status)) {
      return res.status(400).json({ success: false, error: { message: `Invalid status. Must be one of: ${validStatuses.join(', ')}` } });
    }
    const rows = await pgQuery(
      'UPDATE spy_creatives SET status = $1, updated_at = NOW() WHERE id = $2 RETURNING *',
      [status, req.params.id]
    );
    if (rows.length === 0) return res.status(404).json({ success: false, error: { message: 'Creative not found' } });
    const creative = rows[0];

    // Auto-generate 9:16 variant when a non-9:16 creative is approved
    if (status === 'approved' && creative.aspect_ratio !== '9:16' && !creative.parent_creative_id) {
      // Check if a 9:16 variant already exists
      const existingVariant = await pgQuery(
        "SELECT id FROM spy_creatives WHERE parent_creative_id = $1 AND aspect_ratio = '9:16'",
        [creative.id]
      );
      if (existingVariant.length === 0) {
        console.log(`[staticsGeneration] Auto-generating 9:16 variant for approved creative ${creative.id}`);
        generateVariant(creative, '9:16').catch(err =>
          console.error('[staticsGeneration] Auto 9:16 variant error:', err.message)
        );
      }
    }

    res.json({ success: true, data: creative });
  } catch (err) {
    console.error('[staticsGeneration] /creatives/:id/status error:', err);
    res.status(500).json({ success: false, error: { message: err.message } });
  }
});

// GET /creatives/pipeline — Creatives grouped by status for pipeline view
router.get('/creatives/pipeline', authenticate, async (req, res) => {
  try {
    await ensureCreativesTable();
    const { product_id } = req.query;

    let query = 'SELECT id, product_id, product_name, image_url, thumbnail_url, source_label, angle, archetype, aspect_ratio, status, reference_thumbnail, reference_name, parent_creative_id, pipeline, created_at FROM spy_creatives WHERE pipeline = $1';
    const params = ['standard'];
    if (product_id) {
      query += ' AND product_id = $2';
      params.push(product_id);
    }
    query += ' ORDER BY created_at DESC';

    const rows = await pgQuery(query, params);

    const pipeline = { generating: [], review: [], approved: [], ready: [], launched: [] };
    const variants = []; // generating/rejected variants tracked separately
    for (const row of rows) {
      if (row.parent_creative_id && (row.status === 'generating' || row.status === 'rejected')) {
        // Child variants go to variants array (shown as pills on parent)
        variants.push(row);
      } else if (row.status === 'generating' && !row.parent_creative_id) {
        // Standalone generating items go to generating column
        pipeline.generating.push(row);
      } else if (pipeline[row.status]) {
        pipeline[row.status].push(row);
      }
    }

    res.json({
      success: true,
      data: pipeline,
      variants,
      counts: {
        generating: pipeline.generating.length,
        review: pipeline.review.length,
        approved: pipeline.approved.length,
        ready: pipeline.ready.length,
        launched: pipeline.launched.length,
      },
    });
  } catch (err) {
    console.error('[staticsGeneration] /creatives/pipeline error:', err);
    res.status(500).json({ success: false, error: { message: err.message } });
  }
});

// GET /creatives/:id — Get single creative
router.get('/creatives/:id', authenticate, async (req, res) => {
  try {
    await ensureCreativesTable();
    const rows = await pgQuery('SELECT * FROM spy_creatives WHERE id = $1', [req.params.id]);
    if (rows.length === 0) return res.status(404).json({ success: false, error: { message: 'Creative not found' } });
    res.json({ success: true, data: rows[0] });
  } catch (err) {
    res.status(500).json({ success: false, error: { message: err.message } });
  }
});

// DELETE /creatives/:id — Delete creative
router.delete('/creatives/:id', authenticate, async (req, res) => {
  try {
    await ensureCreativesTable();
    const rows = await pgQuery('DELETE FROM spy_creatives WHERE id = $1 RETURNING id', [req.params.id]);
    if (rows.length === 0) return res.status(404).json({ success: false, error: { message: 'Creative not found' } });
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ success: false, error: { message: err.message } });
  }
});

// ── POST /creatives/:id/create-variant — Manually trigger variant generation ──
router.post('/creatives/:id/create-variant', authenticate, async (req, res) => {
  try {
    await ensureCreativesTable();
    const { aspect_ratio = '9:16' } = req.body;
    const rows = await pgQuery('SELECT * FROM spy_creatives WHERE id = $1', [req.params.id]);
    if (rows.length === 0) return res.status(404).json({ success: false, error: { message: 'Creative not found' } });
    const parent = rows[0];

    // Clean up any previous variants (failed, rejected, or old) so a fresh one is created
    await pgQuery(
      "DELETE FROM spy_creatives WHERE parent_creative_id = $1 AND aspect_ratio = $2",
      [parent.id, aspect_ratio]
    );

    res.json({ success: true, message: `${aspect_ratio} variant generation started` });

    // Fire-and-forget
    generateVariant(parent, aspect_ratio).catch(err =>
      console.error('[staticsGeneration] Manual variant generation error:', err.message)
    );
  } catch (err) {
    console.error('[staticsGeneration] /creatives/:id/create-variant error:', err);
    res.status(500).json({ success: false, error: { message: err.message } });
  }
});

// ── POST /creatives — Save a generated creative to the pipeline ────────
router.post('/creatives', authenticate, async (req, res) => {
  try {
    await ensureCreativesTable();
    const {
      product_id, product_name, angle, aspect_ratio, image_url,
      reference_template_id, reference_name, reference_thumbnail, adapted_text,
      claude_analysis, swap_pairs, generation_prompt, generation_task_id,
      source_label, pipeline, status = 'review',
      group_id,
    } = req.body;

    if (!image_url) return res.status(400).json({ success: false, error: { message: 'image_url is required' } });

    // Convert relative reference_thumbnail to absolute URL so variant generation always works
    let resolvedRefThumb = reference_thumbnail || null;
    if (resolvedRefThumb && resolvedRefThumb.startsWith('/')) {
      const base = process.env.RENDER_EXTERNAL_URL || `http://localhost:${process.env.PORT || 3000}`;
      resolvedRefThumb = `${base}${resolvedRefThumb}`;
    }

    const rows = await pgQuery(
      `INSERT INTO spy_creatives
        (product_id, product_name, angle, aspect_ratio, image_url,
         reference_image_id, source_label, reference_name, reference_thumbnail,
         adapted_text, claude_analysis, swap_pairs, generation_prompt,
         generation_task_id, pipeline, status, group_id)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17)
       RETURNING *`,
      [
        product_id || null,
        product_name || null,
        angle || null,
        aspect_ratio || '4:5',
        image_url,
        reference_template_id || null,
        source_label || (reference_template_id ? 'template' : 'upload'),
        reference_name || null,
        resolvedRefThumb,
        adapted_text ? JSON.stringify(adapted_text) : null,
        claude_analysis ? JSON.stringify(claude_analysis) : null,
        swap_pairs ? JSON.stringify(swap_pairs) : null,
        generation_prompt || null,
        generation_task_id || null,
        pipeline || 'standard',
        status,
        group_id || null,
      ]
    );
    res.json({ success: true, data: rows[0] });
  } catch (err) {
    console.error('[staticsGeneration] POST /creatives error:', err);
    res.status(500).json({ success: false, error: { message: err.message } });
  }
});

// ── POST /creatives/:id/ai-adjust — AI adjustment on existing creative (async) ─
// Returns immediately, processes in background, client polls creative for updated image_url
router.post('/creatives/:id/ai-adjust', authenticate, async (req, res) => {
  try {
    await ensureCreativesTable();
    const { instruction } = req.body;
    if (!instruction) return res.status(400).json({ success: false, error: { message: 'instruction is required' } });

    const rows = await pgQuery('SELECT * FROM spy_creatives WHERE id = $1', [req.params.id]);
    if (rows.length === 0) return res.status(404).json({ success: false, error: { message: 'Creative not found' } });
    const creative = rows[0];

    if (!creative.image_url) {
      return res.status(400).json({ success: false, error: { message: 'Creative has no image_url to adjust' } });
    }

    // Store previous image and mark as adjusting
    const previousImageUrl = creative.image_url;
    await pgQuery(
      "UPDATE spy_creatives SET review_notes = 'AI adjusting...', updated_at = NOW() WHERE id = $1",
      [req.params.id]
    );

    // Respond immediately
    res.json({ success: true, data: { status: 'adjusting', message: 'AI adjustment started. The image will update shortly.' } });

    // Fire-and-forget: do the actual work in background
    (async () => {
      try {
        const existingAnalysis = creative.claude_analysis
          ? (typeof creative.claude_analysis === 'string' ? creative.claude_analysis : JSON.stringify(creative.claude_analysis))
          : 'No prior analysis available.';

        // Build Claude message with vision — include the current image so Claude can SEE
        // what needs to change instead of guessing from text descriptions
        const claudeContent = [];

        // Add the current creative image as vision input
        if (creative.image_url) {
          try {
            const { base64, mediaType } = await resolveImage(creative.image_url);
            claudeContent.push({
              type: 'image',
              source: { type: 'base64', media_type: mediaType, data: base64 },
            });
          } catch (imgErr) {
            console.warn('[ai-adjust] Could not resolve image for vision, proceeding without:', imgErr.message);
          }
        }

        claudeContent.push({
          type: 'text',
          text: `You are an AI creative director. A user wants to adjust an existing ad creative. The image above is the CURRENT creative that needs modification.

Original creative analysis:
${existingAnalysis}

Original generation prompt:
${creative.generation_prompt || 'N/A'}

User's adjustment instruction: "${instruction}"

IMPORTANT: Look at the image carefully. The user wants you to recreate this EXACT image but with ONLY the change described above. Everything else must remain identical — same layout, same colors (unless the change involves colors), same text, same product placement, same composition.

Generate an updated image generation prompt that:
1. Describes the current image in full detail (layout, colors, text, product, composition)
2. Applies ONLY the user's requested change
3. Keeps everything else exactly the same

Return ONLY a JSON object with:
{
  "adjusted_prompt": "the full updated generation prompt that recreates the image with only the requested change",
  "changes_summary": "brief description of what changed"
}`,
        });

        const claudeBody = {
          model: 'claude-sonnet-4-20250514',
          max_tokens: 2000,
          messages: [{
            role: 'user',
            content: claudeContent,
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

        if (!claudeRes.ok) throw new Error(`Claude API error ${claudeRes.status}: ${await claudeRes.text()}`);

        const claudeData = await claudeRes.json();
        const rawText = claudeData.content?.[0]?.text;
        if (!rawText) throw new Error('Empty response from Claude');

        const jsonMatch = rawText.match(/\{[\s\S]*\}/);
        if (!jsonMatch) throw new Error('Could not parse JSON from Claude response');
        const adjustResult = JSON.parse(jsonMatch[0]);

        // Ensure image URL is HTTP-accessible for NanoBanana
        const httpImageUrl = await ensureHttpUrlGlobal(creative.image_url, 'adjust-ref');

        // Submit to NanoBanana
        const nbRes = await fetch(`${NB_BASE}/generate-2`, {
          method: 'POST',
          headers: { Authorization: `Bearer ${NANOBANANA_API_KEY}`, 'Content-Type': 'application/json' },
          body: JSON.stringify({
            prompt: adjustResult.adjusted_prompt,
            model: 'nano-banana-2',
            imageUrls: [httpImageUrl],
            aspectRatio: creative.aspect_ratio || '4:5',
            resolution: '1K',
            outputFormat: 'png',
          }),
        });

        if (!nbRes.ok) throw new Error(`NanoBanana error ${nbRes.status}: ${await nbRes.text()}`);
        const nbData = await nbRes.json();
        const taskId = nbData.taskId || nbData.data?.taskId;
        if (!taskId) throw new Error('No taskId from NanoBanana');

        const newImageUrl = await pollNanoBanana(taskId);

        await pgQuery(
          `UPDATE spy_creatives SET image_url = $1, generation_prompt = $2, review_notes = NULL, updated_at = NOW() WHERE id = $3`,
          [newImageUrl, adjustResult.adjusted_prompt, creative.id]
        );
        console.log(`[ai-adjust] Success for ${creative.id}: ${newImageUrl}`);
      } catch (err) {
        console.error(`[ai-adjust] Failed for ${creative.id}:`, err.message);
        await pgQuery(
          "UPDATE spy_creatives SET review_notes = $1, updated_at = NOW() WHERE id = $2",
          [`AI adjustment failed: ${err.message}`, creative.id]
        ).catch(() => {});
      }
    })();
  } catch (err) {
    console.error('[staticsGeneration] /creatives/:id/ai-adjust error:', err);
    res.status(500).json({ success: false, error: { message: err.message } });
  }
});

// ── POST /creatives/:id/download — Proxy download the creative image ───
router.post('/creatives/:id/download', authenticate, async (req, res) => {
  try {
    await ensureCreativesTable();
    const rows = await pgQuery('SELECT * FROM spy_creatives WHERE id = $1', [req.params.id]);
    if (rows.length === 0) return res.status(404).json({ success: false, error: { message: 'Creative not found' } });

    const creative = rows[0];
    if (!creative.image_url) {
      return res.status(400).json({ success: false, error: { message: 'Creative has no image_url' } });
    }

    const imageRes = await fetch(creative.image_url);
    if (!imageRes.ok) throw new Error(`Failed to fetch image: ${imageRes.status}`);

    const buf = Buffer.from(await imageRes.arrayBuffer());
    const mime = detectMime(buf);
    const ext = mime === 'image/png' ? 'png' : mime === 'image/webp' ? 'webp' : 'jpg';
    const filename = `creative-${req.params.id.slice(0, 8)}.${ext}`;

    res.setHeader('Content-Type', mime);
    res.setHeader('Content-Disposition', `attachment; filename="${filename}"`);
    res.setHeader('Content-Length', buf.length);
    res.send(buf);
  } catch (err) {
    console.error('[staticsGeneration] /creatives/:id/download error:', err);
    res.status(500).json({ success: false, error: { message: err.message } });
  }
});

// ── Statics Prompt Settings ──────────────────────────────────────────

const STATICS_PROMPT_TYPES = [
  { key: 'claudeAnalysis', label: 'Claude Analysis Prompt', description: 'Analyzes reference ad image and adapts copy for the target product' },
  { key: 'nanoBanana', label: 'Image Generation Prompt', description: 'Instructions sent to NanoBanana API for image generation' },
];

let staticsPromptsCache = { data: null, timestamp: 0 };
const STATICS_CACHE_TTL = 5 * 60 * 1000;

async function getCustomStaticsPrompts() {
  if (staticsPromptsCache.data && Date.now() - staticsPromptsCache.timestamp < STATICS_CACHE_TTL) {
    return staticsPromptsCache.data;
  }
  try {
    const rows = await pgQuery(`SELECT value FROM system_settings WHERE key = 'statics_prompts'`);
    const data = rows.length ? (typeof rows[0].value === 'string' ? JSON.parse(rows[0].value) : rows[0].value) : null;
    staticsPromptsCache = { data, timestamp: Date.now() };
    return data;
  } catch { return null; }
}

function getDefaultStaticsPrompts() {
  return {
    claudeAnalysis: {
      headlineRules: `The headline is the most important element. Write AGGRESSIVE, high-converting headlines that create urgency and desire. The headline must:
- Make a BOLD, specific money-related claim (e.g. "This $59 Device Mines $127/Month in Bitcoin While You Sleep", "People Are Making $3,800/Month With This Tiny Miner")
- Use concrete dollar amounts, timeframes, or multipliers — vague claims like "works at home" are BANNED
- Create FOMO, urgency, or disbelief (e.g. "Wall Street Doesn't Want You to Know About This", "Banks HATE This $59 Device")
- Sound like a native ad / advertorial headline, NOT like a product description
- Be punchy, provocative, and scroll-stopping — if it sounds like it could be a boring product tagline, REWRITE IT
- NEVER use generic/weak phrases like "works at home", "easy to use", "quick mining", "get started today"
- Match the approximate CHARACTER COUNT of the original headline (not word count — character count matters for layout fit)`,
      headlineExamples: `HEADLINE STYLE EXAMPLES (use these as inspiration, do NOT copy verbatim):
- "I Bought a $59 Bitcoin Miner as a Joke — It's Paid for Itself 4x"
- "Tiny Device Mines $4.20/Day in Bitcoin — No Experience Needed"
- "Crypto Millionaires Started With This Exact Device"
- "Your Electricity Bill Hides a $127/Month Bitcoin Goldmine"
- "This Pocket-Sized Miner Made $847 Last Month on Autopilot"
- "Forget Savings Accounts — This Mines Real Bitcoin 24/7"`,
      pricingRules: `MANDATORY PRICING RULES (VIOLATION = FAILURE):
- The product base price is $59.99 for 1 unit
- Bundle prices: 2 units = $55 each ($109.99), 3+1 free = $45 each ($179.99), 6+2 free = $40 each ($320)
- Maximum discount allowed: 58% — NEVER exceed this
- The ONLY discount code is MINER10 (extra 10% off)
- NEVER write "$35", "$29", "$25" or any price not listed above
- If the reference ad has a price, replace it with the CORRECT price from this list
- When in doubt, use "Up to 40% OFF" or "Starting at $59.99" — do NOT invent prices`,
      productIdentity: `PRODUCT IDENTITY NOTE: The product is a MINI BITCOIN MINER — a small, compact electronic device with a color display screen showing mining hashrate data. NEVER describe it as a "USB stick", "flash drive", "thumb drive", or anything USB-related. It is NOT a USB device. When describing product placement, refer to it as "mini bitcoin miner" or "compact mining device with display screen". IMPORTANT: The product's screen displays mining statistics (hashrate numbers like 995.4 KH/s) — do NOT put logos, brand names, or text overlays on the device screen. The screen content must match exactly what is shown in the product images.`,
      bannedPhrases: `works at home, easy to use, quick mining, get started today`,
      formulaPreservation: `FORMULA PRESERVATION (CRITICAL):
The adapted text must follow the EXACT SAME sentence structure, opening words, and approximate character count as the original. You are copying the PROVEN FORMULA, just swapping the subject matter.

Correct: "Bye Bye, Beer Belly" → "Bye Bye, Power Bills" (keeps "Bye Bye,")
Correct: "Kill The Bloated Belly" → "Kill The Middleman" (keeps "Kill The")
Correct: "3 Years of Back Pain Gone in 7 Days" → "3 Years of Missing Gains Gone in 7 Days"
Wrong: "Bye Bye, Beer Belly" → "Mine Bitcoin From Home" ❌ (completely different structure)
Generic labels like "SPECIAL DEAL", "FREE SHIPPING" → keep EXACTLY as-is`,
      crossNicheAdaptation: `CROSS-NICHE VISUAL MAPPING:
Reference ads may come from any niche. Map visuals to bitcoin mining context:
- Supplement bottles → Miner Forge Pro device(s)
- Skincare before/after → Mining earnings progression or device setup
- Fitness transformations → Passive income growth charts
- Food/ingredient callouts → Device feature callouts (hashrate, low power, silent)
- Body part close-ups → Device screen showing mining stats
- Kitchen/bathroom scenes → Desk/home office/nightstand scenes
- Medical/doctor imagery → Tech expert/crypto analyst imagery`,
      visualAdaptation: `For each visual element, specify what it should become for the bitcoin mining product:
- Supplement bottles → Miner Forge Pro device(s)
- Skincare before/after → Mining earnings screenshots or device setup progression
- Fitness transformations → Passive income growth charts
- Food/ingredient callouts → Device feature callouts (hashrate, low power, silent operation)
- Body part close-ups → Device screen close-ups showing mining stats
- Kitchen/bathroom scenes → Desk/home office/nightstand scenes`,
    },
    nanoBanana: {
      productRules: `PRODUCT REPLACEMENT:
- Remove ALL competitor branding, logos, product imagery
- CRITICAL: The product is a MINI BITCOIN MINER with a display screen — NOT a USB stick. Reproduce it EXACTLY as shown. NEVER render it as a USB stick, flash drive, or thumb drive. Do NOT add logos or brand names onto the device screen — the screen shows mining hashrate data only.
- Realistic lighting, shadows, and perspective matching the reference style`,
      textRules: `TEXT RULES:
- Font style, weight, size, color, and position must EXACTLY match reference for each text element
- Do NOT add extra text blocks. Do NOT remove text that isn't in the swap list.
- Text must be sharp, legible, and correctly spelled — NO blurry, warped, or AI-looking text
- Headlines must be rendered in BOLD, high-contrast, professional typography — as crisp as a real paid ad
- CRITICAL: Every letter must be pixel-perfect and readable. If text looks "AI-generated" or distorted, the output is a failure.`,
      absoluteRules: `ABSOLUTE RULES:
1. EXACT same layout structure as reference — same columns, same sections, same proportions
2. ZERO competitor branding remaining (logos, names, product images)
3. Every text swap must be applied
4. No extra text beyond the specified swaps
5. Comparison labels, timeline labels, ingredient labels ALL get swapped
6. The product is a MINI BITCOIN MINER — NEVER show a USB-looking product. Copy the device from image 1 exactly.
7. Hands: exactly 5 fingers, realistic proportions
8. Match reference style, color palette, mood, and visual quality
9. PRICES MUST MATCH the text swap list EXACTLY — do not invent or modify any price, discount percentage, or dollar amount`,
    }
  };
}

// GET /settings/prompts
router.get('/settings/prompts', authenticate, async (_req, res) => {
  try {
    const custom = await getCustomStaticsPrompts();
    const defaults = getDefaultStaticsPrompts();
    res.json({
      success: true,
      promptTypes: STATICS_PROMPT_TYPES,
      defaults,
      custom: custom || {},
      hasCustom: !!custom,
    });
  } catch (err) {
    res.status(500).json({ success: false, error: { message: err.message } });
  }
});

// PUT /settings/prompts
router.put('/settings/prompts', authenticate, async (req, res) => {
  try {
    const { prompts } = req.body;
    if (!prompts || typeof prompts !== 'object') {
      return res.status(400).json({ success: false, error: { message: 'prompts object is required' } });
    }
    await pgQuery(
      `INSERT INTO system_settings (key, value, description)
       VALUES ('statics_prompts', $1, 'Custom prompts for Static Ads generation')
       ON CONFLICT (key) DO UPDATE SET value = $1, updated_at = NOW()`,
      [JSON.stringify(prompts)]
    );
    staticsPromptsCache = { data: prompts, timestamp: Date.now() };
    res.json({ success: true, message: 'Prompts saved' });
  } catch (err) {
    res.status(500).json({ success: false, error: { message: err.message } });
  }
});

// POST /settings/prompts/reset
router.post('/settings/prompts/reset', authenticate, async (_req, res) => {
  try {
    await pgQuery(`DELETE FROM system_settings WHERE key = 'statics_prompts'`);
    staticsPromptsCache = { data: null, timestamp: 0 };
    res.json({ success: true, message: 'Prompts reset to defaults' });
  } catch (err) {
    res.status(500).json({ success: false, error: { message: err.message } });
  }
});

// ── Launch Statics Creatives to Meta ──────────────────────────────────

function buildLaunchName(pattern, vars) {
  let result = pattern;
  for (const [key, val] of Object.entries(vars)) {
    result = result.replace(new RegExp(`\\{${key.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\}`, 'g'), val || '');
  }
  return result.trim();
}

router.post('/launch', authenticate, async (req, res) => {
  try {
    await ensureCreativesTable();
    if (!isMetaAdsConfigured()) {
      return res.status(400).json({ success: false, error: { message: 'Meta Ads API not configured' } });
    }

    const { creative_ids, template_id, copy_set_id } = req.body;
    if (!creative_ids?.length || !template_id) {
      return res.status(400).json({ success: false, error: { message: 'creative_ids and template_id are required' } });
    }

    // Load template from brief_pipeline launch_templates table
    const templates = await pgQuery('SELECT * FROM launch_templates WHERE id = $1', [template_id]);
    if (!templates.length) return res.status(404).json({ success: false, error: { message: 'Template not found' } });
    const template = templates[0];

    if (!template.campaign_id) {
      return res.status(400).json({ success: false, error: { message: 'Template has no campaign configured. Please edit the template and select a campaign.' } });
    }

    // Load copy set if provided
    let copySet = null;
    if (copy_set_id) {
      const cs = await pgQuery('SELECT * FROM brief_copy_sets WHERE id = $1', [copy_set_id]);
      if (!cs.length) return res.status(404).json({ success: false, error: { message: 'Copy set not found' } });
      copySet = cs[0];
    }

    // Load creatives
    const creatives = await pgQuery(
      `SELECT * FROM spy_creatives WHERE id = ANY($1) AND status IN ('approved', 'ready')`,
      [creative_ids]
    );
    if (!creatives.length) {
      return res.status(400).json({ success: false, error: { message: 'No launchable creatives found (must be approved or ready)' } });
    }

    // Mark as launching
    await pgQuery(
      `UPDATE spy_creatives SET status = 'launching' WHERE id = ANY($1)`,
      [creative_ids]
    );

    const dateStr = new Date().toLocaleDateString('en-US', { month: '2-digit', day: '2-digit' }).replace('/', '');
    const batchNum = Math.floor(Date.now() / 1000) % 10000;
    const results = [];

    // Round-robin page selection
    const selectedPages = (template.page_ids || []).filter(p => p.selected !== false);

    // Create ad set for this batch
    let adsetId = null;
    let adsetName = '';
    adsetName = buildLaunchName(template.adset_name_pattern || '{date} - Batch {batch}', {
      date: dateStr,
      angle: creatives[0]?.angle || 'General',
      batch: batchNum,
      product: creatives[0]?.product_name || '',
    });

    try {
      adsetId = await createAdSet(template.ad_account_id, {
        name: adsetName,
        campaignId: template.campaign_id,
        dailyBudget: template.daily_budget,
        optimizationGoal: template.optimization_goal,
        bidStrategy: template.bid_strategy,
        targetRoas: template.target_roas,
        pixelId: template.pixel_id,
        conversionEvent: template.conversion_event,
        conversionLocation: template.conversion_location,
        targeting: {
          countries: template.countries || ['US'],
          age_min: template.age_min,
          age_max: template.age_max,
          gender: template.gender,
          include_audiences: template.include_audiences || [],
          exclude_audiences: template.exclude_audiences || [],
        },
        attributionWindow: template.attribution_window,
        pageId: selectedPages[0]?.id,
        status: 'PAUSED',
      });
    } catch (err) {
      await pgQuery(
        `UPDATE spy_creatives SET status = 'ready' WHERE id = ANY($1)`,
        [creative_ids]
      );
      return res.status(500).json({ success: false, error: { message: `Ad set creation failed: ${err.message}` } });
    }

    let pageIdx = 0;

    for (let i = 0; i < creatives.length; i++) {
      const creative = creatives[i];
      const page = selectedPages.length ? selectedPages[pageIdx % selectedPages.length] : null;
      pageIdx++;

      const adName = buildLaunchName(template.ad_name_pattern || '{date} - {angle} {num}', {
        date: dateStr,
        angle: creative.angle || 'General',
        num: i + 1,
        batch: batchNum,
        product: creative.product_name || '',
      });

      try {
        // Upload image to Meta
        let imageHashes = [];
        if (creative.image_url) {
          const { hash } = await uploadAdImageFromUrl(template.ad_account_id, creative.image_url);
          imageHashes = [hash];
        }

        // Determine ad copy
        const primaryTexts = copySet?.primary_texts?.length
          ? copySet.primary_texts
          : [creative.source_label || 'Check this out'];
        const headlines = copySet?.headlines?.length
          ? copySet.headlines
          : [creative.angle || 'Shop Now'];
        const descriptions = copySet?.descriptions?.length
          ? copySet.descriptions
          : [''];
        const cta = copySet?.cta_button || 'SHOP_NOW';
        const link = copySet?.landing_page_url || 'https://mineblock.com';

        // Create ad creative
        const creativeId = await createFlexibleAdCreative(template.ad_account_id, {
          name: adName,
          imageHashes,
          primaryTexts,
          headlines,
          descriptions,
          cta,
          link,
          pageId: page?.id || selectedPages[0]?.id,
          utmParameters: template.utm_parameters,
        });

        // Create the ad
        const metaAdId = await createAd(template.ad_account_id, {
          name: adName,
          adsetId,
          creativeId,
          status: 'PAUSED',
        });

        // Update creative status
        await pgQuery(
          `UPDATE spy_creatives SET status = 'launched', updated_at = NOW() WHERE id = $1`,
          [creative.id]
        );

        results.push({ creative_id: creative.id, status: 'launched', meta_ad_id: metaAdId, ad_name: adName });
      } catch (err) {
        await pgQuery(
          `UPDATE spy_creatives SET status = 'ready', review_notes = $1, updated_at = NOW() WHERE id = $2`,
          [`Launch failed: ${err.message}`, creative.id]
        );
        results.push({ creative_id: creative.id, status: 'failed', error: err.message });
      }
    }

    res.json({ success: true, data: { results, adset_id: adsetId, adset_name: adsetName } });
  } catch (err) {
    console.error('[StaticsGeneration] Launch error:', err);
    // Reset any stuck 'launching' creatives back to 'ready'
    if (req.body.creative_ids?.length) {
      await pgQuery(
        `UPDATE spy_creatives SET status = 'ready' WHERE id = ANY($1) AND status = 'launching'`,
        [req.body.creative_ids]
      ).catch(() => {});
    }
    res.status(500).json({ success: false, error: { message: err.message } });
  }
});

export { getCustomStaticsPrompts, getDefaultStaticsPrompts };

export default router;
