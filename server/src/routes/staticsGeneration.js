import { Router } from 'express';
import { buildClaudePrompt, buildNanoBananaPrompt, buildSwapPairs } from '../utils/staticsPrompts.js';
import { pgQuery } from '../db/pg.js';
import { authenticate } from '../middleware/auth.js';
import { uploadBuffer, isR2Configured } from '../services/r2.js';
import crypto from 'crypto';

const router = Router();
const sleep = (ms) => new Promise(r => setTimeout(r, ms));

// ── Temporary image store (serves base64 as HTTP URLs for NanoBanana) ──
const tempImages = new Map();
const TEMP_IMAGE_TTL = 10 * 60 * 1000; // 10 minutes

function storeTempImage(buf, contentType) {
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
    url = raw.imageUrl || raw.image_url || raw.url
      || raw.output?.url || raw.output?.image_url || null;
  }

  // Fallback to other known fields
  if (!url) {
    url = data.data?.resultImageUrl || data.resultImageUrl
      || data.data?.imageUrl || data.imageUrl
      || data.data?.outputUrl || data.outputUrl || null;
  }

  console.log(`[staticsGeneration] extractNanoBananaImageUrl: raw type=${typeof raw}, len=${String(raw).length}, first200=${String(raw).slice(0, 200)}, extracted=${String(url).slice(0, 120)}`);
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

// ── POST /generate ─────────────────────────────────────────────────────

router.post('/generate', authenticate, async (req, res) => {
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
    // NanoBanana requires actual HTTP URLs, not base64.
    // Prefer R2 if configured; otherwise self-host temp images.
    const SERVER_URL = process.env.RENDER_EXTERNAL_URL || `http://localhost:${process.env.PORT || 3000}`;

    async function ensureHttpUrl(dataUri, label) {
      if (!dataUri || !dataUri.startsWith('data:image')) return dataUri;
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
        imageUrls: [finalProductUrl, finalReferenceUrl],
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
    if (!taskId) {
      console.error('[staticsGeneration] Unexpected NanoBanana response:', JSON.stringify(nbData).slice(0, 500));
      throw new Error('No taskId returned from NanoBanana');
    }

    // ── Step E: Return immediately — client polls /status/:taskId ──────
    console.log(`[staticsGeneration] NanoBanana task submitted: ${taskId}`);
    return res.json({
      success: true,
      data: {
        taskId,
        reference_url: finalReferenceUrl,
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
    if (flag === 0 || isNaN(flag)) status = 'pending';
    else if (flag === 1)           status = 'completed';
    else                           status = 'failed';

    const resultImageUrl = status === 'completed' ? extractNanoBananaImageUrl(data) : null;

    return res.json({
      success: true,
      data: {
        taskId,
        status,
        successFlag: flag,
        resultImageUrl,
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
  crTableReady = true;
}

// GET /creatives — List creatives with optional filters
router.get('/creatives', authenticate, async (req, res) => {
  try {
    await ensureCreativesTable();
    const { product_id, status, pipeline = 'standard' } = req.query;
    let query = "SELECT id, product_id, product_name, image_url, thumbnail_url, source_label, angle, archetype, aspect_ratio, status, reference_thumbnail, reference_name, pipeline, created_at FROM spy_creatives WHERE pipeline = $1";
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

// PATCH /creatives/:id/status — Update creative status
router.patch('/creatives/:id/status', authenticate, async (req, res) => {
  try {
    await ensureCreativesTable();
    const { status } = req.body;
    const validStatuses = ['generating', 'review', 'approved', 'ready', 'queued', 'launched', 'rejected', 'archived'];
    if (!validStatuses.includes(status)) {
      return res.status(400).json({ success: false, error: { message: `Invalid status. Must be one of: ${validStatuses.join(', ')}` } });
    }
    const rows = await pgQuery(
      'UPDATE spy_creatives SET status = $1, updated_at = NOW() WHERE id = $2 RETURNING *',
      [status, req.params.id]
    );
    if (rows.length === 0) return res.status(404).json({ success: false, error: { message: 'Creative not found' } });
    res.json({ success: true, data: rows[0] });
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

    let query = 'SELECT id, product_id, product_name, image_url, thumbnail_url, source_label, angle, archetype, aspect_ratio, status, reference_thumbnail, reference_name, pipeline, created_at FROM spy_creatives';
    const params = [];
    if (product_id) {
      query += ' WHERE product_id = $1';
      params.push(product_id);
    }
    query += ' ORDER BY created_at DESC';

    const rows = await pgQuery(query, params);

    const pipeline = { review: [], approved: [], ready: [], launched: [] };
    for (const row of rows) {
      if (pipeline[row.status]) {
        pipeline[row.status].push(row);
      }
    }

    res.json({
      success: true,
      data: pipeline,
      counts: {
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

// ── POST /creatives — Save a generated creative to the pipeline ────────
router.post('/creatives', authenticate, async (req, res) => {
  try {
    await ensureCreativesTable();
    const {
      product_id, product_name, angle, aspect_ratio, image_url,
      reference_template_id, reference_name, reference_thumbnail, adapted_text,
      claude_analysis, swap_pairs, generation_prompt, status = 'review',
    } = req.body;

    if (!image_url) return res.status(400).json({ success: false, error: { message: 'image_url is required' } });

    const rows = await pgQuery(
      `INSERT INTO spy_creatives
        (product_id, product_name, angle, aspect_ratio, image_url,
         reference_image_id, source_label, reference_name, reference_thumbnail,
         adapted_text, claude_analysis, swap_pairs, generation_prompt, status)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14)
       RETURNING *`,
      [
        product_id || null,
        product_name || null,
        angle || null,
        aspect_ratio || '4:5',
        image_url,
        reference_template_id || null,
        reference_template_id ? 'template' : 'upload',
        reference_name || null,
        reference_thumbnail || null,
        adapted_text ? JSON.stringify(adapted_text) : null,
        claude_analysis ? JSON.stringify(claude_analysis) : null,
        swap_pairs ? JSON.stringify(swap_pairs) : null,
        generation_prompt || null,
        status,
      ]
    );
    res.json({ success: true, data: rows[0] });
  } catch (err) {
    console.error('[staticsGeneration] POST /creatives error:', err);
    res.status(500).json({ success: false, error: { message: err.message } });
  }
});

// ── POST /creatives/:id/ai-adjust — AI adjustment on existing creative ─
router.post('/creatives/:id/ai-adjust', authenticate, async (req, res) => {
  try {
    await ensureCreativesTable();
    const { instruction } = req.body;
    if (!instruction) return res.status(400).json({ success: false, error: { message: 'instruction is required' } });

    // Fetch the creative
    const rows = await pgQuery('SELECT * FROM spy_creatives WHERE id = $1', [req.params.id]);
    if (rows.length === 0) return res.status(404).json({ success: false, error: { message: 'Creative not found' } });
    const creative = rows[0];

    if (!creative.image_url) {
      return res.status(400).json({ success: false, error: { message: 'Creative has no image_url to adjust' } });
    }

    // Call Claude with the adjustment instruction + original analysis
    const existingAnalysis = creative.claude_analysis
      ? (typeof creative.claude_analysis === 'string' ? creative.claude_analysis : JSON.stringify(creative.claude_analysis))
      : 'No prior analysis available.';

    const claudeBody = {
      model: 'claude-sonnet-4-20250514',
      max_tokens: 2000,
      messages: [{
        role: 'user',
        content: [
          {
            type: 'text',
            text: `You are an AI creative director. A user wants to adjust an existing ad creative.

Original creative analysis:
${existingAnalysis}

Original generation prompt:
${creative.generation_prompt || 'N/A'}

User's adjustment instruction: "${instruction}"

Generate an updated image generation prompt that applies the user's requested change while keeping everything else about the creative the same. Return ONLY a JSON object with:
{
  "adjusted_prompt": "the full updated generation prompt",
  "changes_summary": "brief description of what changed"
}`,
          },
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

    let adjustResult;
    try {
      adjustResult = JSON.parse(jsonMatch[0]);
    } catch (parseErr) {
      throw new Error(`Failed to parse Claude JSON: ${parseErr.message}`);
    }

    // Submit to NanoBanana with adjusted prompt
    const nbRes = await fetch(`${NB_BASE}/generate-2`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${NANOBANANA_API_KEY}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        prompt: adjustResult.adjusted_prompt,
        model: 'nano-banana-2',
        imageUrls: [creative.image_url],
        aspectRatio: creative.aspect_ratio || '4:5',
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
    if (!taskId) {
      console.error('[staticsGeneration] Unexpected NanoBanana response:', JSON.stringify(nbData).slice(0, 500));
      throw new Error('No taskId returned from NanoBanana');
    }

    // Poll for completion
    const newImageUrl = await pollNanoBanana(taskId);

    // Update the creative with new image
    const updated = await pgQuery(
      `UPDATE spy_creatives
       SET image_url = $1, generation_prompt = $2, updated_at = NOW()
       WHERE id = $3 RETURNING *`,
      [newImageUrl, adjustResult.adjusted_prompt, req.params.id]
    );

    res.json({
      success: true,
      data: {
        ...updated[0],
        changes_summary: adjustResult.changes_summary,
        previous_image_url: creative.image_url,
      },
    });
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

// ── ClickUp / Frame.io constants for publish-clickup ────────────────────

const CLICKUP_TOKEN = process.env.CLICKUP_API_TOKEN || process.env.CLICKUP_TOKEN || '';
const CLICKUP_API = 'https://api.clickup.com/api/v2';
const STATIC_ADS_LIST = '901518769479';

const FRAMEIO_TOKEN = process.env.FRAMEIO_TOKEN || '';
const FRAMEIO_PROJECT_ID = '19c0ce1f-f357-4da8-ba1f-bd7eb201e660';
const FRAMEIO_API = 'https://api.frame.io/v2';

const FIELD_IDS = {
  briefNumber: '62b61cc4-2d35-4dfc-86f4-a3913e2bbca3',
  briefType: '98d04d2d-9575-4363-8eee-9bf150b1c319',
  angle: '7e740c52-a05b-4b3b-9798-0801acd84b8a',
  namingConvention: 'c97d93bc-ad82-4b90-98e0-092df383d9b8',
  creationWeek: 'a609d8d0-661e-400f-87cb-2557bd48857b',
  adsFrameLink: 'd90f9f25-d7a0-4eb4-9ded-aca0b4519a3b',
};

const ANGLE_OPTIONS = {
  NA: '2933a618-a7aa-4b42-9e61-c5ee9e0903e5',
  Lottery: '4a493db2-441e-46db-9c58-7b7c3fd0a163',
  Againstcompetition: '0efc2411-1a1a-4d1d-96c6-760e6cff503e',
  'BTC Made easy': '4a1ef4f4-d3e1-4dd3-90a5-b2bd9303d423',
  GTRS: 'c1c56755-f2e4-410d-9f5f-9b3e048c1b36',
  livestream: 'c5e44df4-d814-41dc-acf2-58ab90a2726c',
  Hiddenopportunity: '068ce448-b78e-4b4e-b531-180c422daaa4',
  Rebranding: '1c4f33a4-1034-4101-93ca-93842ca7dc92',
  Missedopportunity: '74f4e8a6-d831-454f-9b39-f15026765a6e',
  BTCFARM: '666601ea-21c1-4685-b1c0-7a951f84dc5f',
  Sale: 'f6cca7fe-4626-4592-90a5-f30efb7a62ba',
  Scarcity: 'e15fc1b9-d90b-4e1b-a4d8-04553e3b8d15',
  Breakingnews: 'e5cd049f-13a5-45e4-a8d7-6b78f0acc9a3',
  Offer: 'e0c1d0fd-b376-4146-8887-ad7c0c209489',
  Reaction: 'bbe5f0c0-8bbf-45a2-bc04-fbcebb11e242',
};

const BRIEF_TYPE_OPTIONS = {
  NN: '1e274045-a4b3-4b0d-85c2-d7ec1a347d3c',
  IT: 'e0999d3c-faab-4d4e-8336-a6272dab8393',
};

// ── ClickUp helpers ─────────────────────────────────────────────────────

async function clickupFetch(url, options = {}) {
  const res = await fetch(`${CLICKUP_API}${url}`, {
    ...options,
    headers: {
      Authorization: CLICKUP_TOKEN,
      'Content-Type': 'application/json',
      ...options.headers,
    },
  });
  if (!res.ok) {
    const text = await res.text();
    throw new Error(`ClickUp API error ${res.status}: ${text}`);
  }
  return res.json();
}

async function setCustomField(taskId, fieldId, value) {
  return clickupFetch(`/task/${taskId}/field/${fieldId}`, {
    method: 'POST',
    body: JSON.stringify({ value }),
  });
}

// ── Frame.io helpers ────────────────────────────────────────────────────

async function frameioFetch(url, options = {}) {
  if (!FRAMEIO_TOKEN) throw new Error('FRAMEIO_TOKEN not configured');
  const res = await fetch(`${FRAMEIO_API}${url}`, {
    ...options,
    headers: {
      Authorization: `Bearer ${FRAMEIO_TOKEN}`,
      'Content-Type': 'application/json',
      ...options.headers,
    },
  });
  if (!res.ok) {
    const text = await res.text();
    throw new Error(`Frame.io API error ${res.status}: ${text.slice(0, 200)}`);
  }
  return res.json();
}

// ── POST /creatives/:id/publish-clickup ─────────────────────────────────

router.post('/creatives/:id/publish-clickup', authenticate, async (req, res) => {
  if (!CLICKUP_TOKEN) {
    return res.status(500).json({ success: false, error: { message: 'ClickUp integration is not configured (missing CLICKUP_API_TOKEN)' } });
  }
  try {
    await ensureCreativesTable();

    // 1. Fetch the creative
    const rows = await pgQuery('SELECT * FROM spy_creatives WHERE id = $1', [req.params.id]);
    if (rows.length === 0) return res.status(404).json({ success: false, error: { message: 'Creative not found' } });
    const creative = rows[0];

    if (!creative.image_url) {
      return res.status(400).json({ success: false, error: { message: 'Creative has no image_url' } });
    }

    // 2. Scan Static Ads list for highest B#### number
    let maxBrief = 0;
    let page = 0;
    let hasMore = true;

    while (hasMore) {
      const data = await clickupFetch(
        `/list/${STATIC_ADS_LIST}/task?page=${page}&limit=100&include_closed=true&subtasks=true`,
      );
      const tasks = data.tasks || [];

      for (const task of tasks) {
        const briefField = task.custom_fields?.find((f) => f.id === FIELD_IDS.briefNumber);
        if (briefField?.value != null) {
          const num = parseInt(briefField.value, 10);
          if (!isNaN(num) && num > maxBrief) maxBrief = num;
        }
        const match = task.name?.match(/B(\d{2,5})/);
        if (match) {
          const num = parseInt(match[1], 10);
          if (!isNaN(num) && num > maxBrief) maxBrief = num;
        }
      }

      hasMore = tasks.length === 100;
      page++;
    }

    const nextNumber = maxBrief + 1;
    const briefId = `B${String(nextNumber).padStart(4, '0')}`;

    // 3. Build naming convention
    const rawAngle = creative.angle || 'NA';
    const angleForName = rawAngle.charAt(0).toUpperCase() + rawAngle.slice(1).replace(/\s+/g, '');

    const now = new Date();
    const d = new Date(Date.UTC(now.getFullYear(), now.getMonth(), now.getDate()));
    const dayNum = d.getUTCDay() || 7;
    d.setUTCDate(d.getUTCDate() + 4 - dayNum);
    const yearStart = new Date(Date.UTC(d.getUTCFullYear(), 0, 1));
    const weekNum = Math.ceil((((d - yearStart) / 86400000) + 1) / 7);
    const weekLabel = `WK${String(weekNum).padStart(2, '0')}_${d.getUTCFullYear()}`;

    const namingConvention = `MR - ${briefId} - IM - NN - NA - ${angleForName} - ${weekLabel}`;

    // 4. Resolve angle dropdown UUID
    const angleKey = Object.keys(ANGLE_OPTIONS).find(
      (k) => k.toLowerCase() === rawAngle.toLowerCase(),
    ) || 'NA';
    const angleUuid = ANGLE_OPTIONS[angleKey] || ANGLE_OPTIONS.NA;

    // 4. Create the ClickUp task
    const taskPayload = {
      name: namingConvention,
      status: 'ready to launch',
      custom_fields: [
        { id: FIELD_IDS.briefNumber, value: nextNumber },
        { id: FIELD_IDS.briefType, value: BRIEF_TYPE_OPTIONS.NN },
        { id: FIELD_IDS.angle, value: angleUuid },
        { id: FIELD_IDS.namingConvention, value: namingConvention },
        { id: FIELD_IDS.creationWeek, value: weekLabel },
      ],
    };

    const createdTask = await clickupFetch(`/list/${STATIC_ADS_LIST}/task`, {
      method: 'POST',
      body: JSON.stringify(taskPayload),
    });

    const clickupTaskId = createdTask.id;
    const clickupTaskUrl = createdTask.url || `https://app.clickup.com/t/${clickupTaskId}`;

    // 5. Upload to Frame.io
    let frameLink = null;
    try {
      // Get root folder
      const project = await frameioFetch(`/projects/${FRAMEIO_PROJECT_ID}`);
      const rootFolderId = project?.root_asset_id;
      if (!rootFolderId) throw new Error('Could not get Frame.io project root folder');

      // Create subfolder with brief ID
      const folder = await frameioFetch(`/assets/${rootFolderId}/children`, {
        method: 'POST',
        body: JSON.stringify({ name: briefId, type: 'folder' }),
      });
      if (!folder?.id) throw new Error('Failed to create Frame.io folder');

      const folderUrl = `https://next.frame.io/project/${FRAMEIO_PROJECT_ID}/${folder.id}`;

      // Upload the image: create asset then PUT bytes
      const imageRes = await fetch(creative.image_url);
      if (!imageRes.ok) throw new Error(`Failed to fetch creative image: ${imageRes.status}`);
      const imageBuf = Buffer.from(await imageRes.arrayBuffer());
      const ext = creative.image_url.match(/\.(png|jpg|jpeg|webp)/i)?.[1] || 'png';
      const fileName = `${briefId}.${ext}`;

      const asset = await frameioFetch(`/assets/${folder.id}/children`, {
        method: 'POST',
        body: JSON.stringify({
          name: fileName,
          type: 'file',
          filetype: `image/${ext === 'jpg' ? 'jpeg' : ext}`,
          filesize: imageBuf.length,
        }),
      });

      // Upload to the presigned URL
      const mimeType = `image/${ext === 'jpg' ? 'jpeg' : ext}`;
      if (asset?.upload_url) {
        const uploadRes = await fetch(asset.upload_url, {
          method: 'PUT',
          headers: { 'Content-Type': mimeType },
          body: imageBuf,
        });
        if (!uploadRes.ok) {
          console.error(`[publish-clickup] Frame.io upload PUT failed: ${uploadRes.status}`);
        }
      } else if (asset?.upload_urls?.length) {
        // Multi-part upload: upload chunk then complete
        const uploadRes = await fetch(asset.upload_urls[0], {
          method: 'PUT',
          headers: { 'Content-Type': mimeType },
          body: imageBuf,
        });
        if (!uploadRes.ok) {
          console.error(`[publish-clickup] Frame.io upload PUT failed: ${uploadRes.status}`);
        }
        // Complete the multi-part upload
        try {
          await frameioFetch(`/assets/${asset.id}/complete`, { method: 'POST', body: JSON.stringify({}) });
        } catch (completeErr) {
          console.error(`[publish-clickup] Frame.io complete failed: ${completeErr.message}`);
        }
      } else {
        console.warn(`[publish-clickup] Frame.io asset has no upload URL — image not uploaded`);
      }

      frameLink = folderUrl;

      // Set the Frame link on the ClickUp task
      await setCustomField(clickupTaskId, FIELD_IDS.adsFrameLink, folderUrl);
    } catch (frameErr) {
      console.error(`[publish-clickup] Frame.io error: ${frameErr.message}`);
      // Don't fail the whole request if Frame.io fails
    }

    // 6. Update the spy_creatives record
    await pgQuery(
      `UPDATE spy_creatives
       SET status = 'launched',
           generation_task_id = $1,
           updated_at = NOW()
       WHERE id = $2`,
      [clickupTaskId, req.params.id],
    );

    // 7. Return result
    return res.json({
      success: true,
      data: {
        clickup_task_id: clickupTaskId,
        clickup_task_url: clickupTaskUrl,
        frame_link: frameLink,
        naming_convention: namingConvention,
        brief_number: nextNumber,
      },
    });
  } catch (err) {
    console.error('[staticsGeneration] /creatives/:id/publish-clickup error:', err);
    return res.status(500).json({ success: false, error: { message: err.message } });
  }
});

export default router;
