import { Router } from 'express';
import { buildClaudePrompt, buildNanoBananaPrompt, buildSwapPairs, buildLayoutAnalysisPrompt } from '../utils/staticsPrompts.js';
import { overlayText } from '../utils/textOverlay.js';
import { pgQuery } from '../db/pg.js';
import { authenticate } from '../middleware/auth.js';
import { requirePermission } from '../middleware/rbac.js';
import { uploadBuffer, isR2Configured } from '../services/r2.js';
import { editImage, isGeminiConfigured, GEMINI_EDIT_MODEL } from '../services/geminiImageGen.js';
import crypto from 'crypto';
import { analyzeTemplate, analyzeTemplateFast } from '../utils/templateAnalysis.js';
import {
  isMetaAdsConfigured, createAdSet, createFlexibleAdCreative, createAd,
  uploadAdImageFromUrl, diagnoseMetaApp, switchAppToLiveMode
} from '../services/metaAdsApi.js';

const router = Router();

// ── Public (no auth) — must be defined BEFORE router.use(authenticate) ──
router.get('/tmp-img/:id', async (req, res) => {
  // 1. Check in-memory cache first (fast path)
  const entry = tempImages.get(req.params.id);
  if (entry) {
    res.set('Content-Type', entry.contentType);
    res.set('Cache-Control', 'public, max-age=86400');
    return res.send(entry.buf);
  }
  // 2. Fall back to persistent DB store
  try {
    const rows = await pgQuery(
      'SELECT data, content_type FROM image_store WHERE id = $1',
      [req.params.id],
      { timeout: 10000 }
    );
    if (rows.length > 0) {
      const { data, content_type } = rows[0];
      const buf = Buffer.isBuffer(data) ? data : Buffer.from(data);
      // Re-populate memory cache
      tempImages.set(req.params.id, { buf, contentType: content_type });
      setTimeout(() => tempImages.delete(req.params.id), TEMP_IMAGE_TTL);
      res.set('Content-Type', content_type);
      res.set('Cache-Control', 'public, max-age=86400');
      return res.send(buf);
    }
  } catch (err) {
    console.warn('[tmp-img] DB lookup failed:', err.message);
  }
  return res.status(404).send('Expired or not found');
});

// Reset auto-reconciled / errored creatives — CRON_SECRET or JWT auth
router.post('/reset-failed', async (req, res) => {
  const cronSecret = process.env.CRON_SECRET;
  const provided = req.headers['x-cron-secret'];
  const authed = cronSecret && provided === cronSecret;
  if (!authed) {
    return authenticate(req, res, async () => {
      await _doResetFailed(res);
    });
  }
  await _doResetFailed(res);
});

async function _doResetFailed(res) {
  try {
    const result = await pgQuery(
      `UPDATE spy_creatives
       SET status = 'ready', review_notes = NULL, updated_at = NOW()
       WHERE status IN ('rejected', 'error')
         AND (
           review_notes LIKE '%auto-reconciled%'
           OR review_notes LIKE '%generation failed%'
           OR review_notes LIKE '%NanaBanana%'
           OR review_notes LIKE '%NanoBanana%'
           OR review_notes LIKE '%Image generation failed%'
         )
       RETURNING id, angle, aspect_ratio, product_name`,
      []
    );
    console.log(`[staticsGeneration] reset-failed: reset ${result.length} creatives to ready`);
    res.json({ success: true, reset_count: result.length, creatives: result.map(r => ({ id: r.id, angle: r.angle, ratio: r.aspect_ratio, product: r.product_name })) });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
}

// Trigger regeneration for all ready variant creatives — CRON_SECRET auth
router.post('/regenerate-ready', async (req, res) => {
  const cronSecret = process.env.CRON_SECRET;
  const provided = req.headers['x-cron-secret'];
  if (!cronSecret || provided !== cronSecret) {
    return authenticate(req, res, () => _doRegenerateReady(res));
  }
  _doRegenerateReady(res);
});

async function _doRegenerateReady(res) {
  try {
    // Find ready creatives that are variants (have a parent with an image)
    const rows = await pgQuery(
      `SELECT c.*, p.image_url AS parent_image_url
       FROM spy_creatives c
       LEFT JOIN spy_creatives p ON c.parent_creative_id = p.id
       WHERE c.status = 'ready'
       ORDER BY c.updated_at DESC
       LIMIT 20`,
      []
    );
    const triggered = [];
    const skipped = [];
    for (const row of rows) {
      if (row.parent_creative_id && row.parent_image_url) {
        // It's a variant — reset to generating and kick off resize
        await pgQuery("UPDATE spy_creatives SET status = 'generating', review_notes = NULL, updated_at = NOW() WHERE id = $1", [row.id]);
        const parent = await pgQuery('SELECT * FROM spy_creatives WHERE id = $1', [row.parent_creative_id]);
        if (parent.length > 0) {
          generateVariant(parent[0], row.aspect_ratio).catch(err =>
            console.error(`[regenerate-ready] variant error for ${row.id}:`, err.message)
          );
          triggered.push({ id: row.id, angle: row.angle, ratio: row.aspect_ratio, type: 'variant' });
        }
      } else if (!row.parent_creative_id) {
        skipped.push({ id: row.id, angle: row.angle, ratio: row.aspect_ratio, reason: 'standalone — needs UI to regenerate' });
      } else {
        skipped.push({ id: row.id, angle: row.angle, ratio: row.aspect_ratio, reason: 'parent has no image yet' });
      }
    }
    console.log(`[regenerate-ready] triggered=${triggered.length}, skipped=${skipped.length}`);
    res.json({ success: true, triggered, skipped });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
}

router.use(authenticate, requirePermission('statics-generation', 'access'));
const sleep = (ms) => new Promise(r => setTimeout(r, ms));

// ── Text overlay context store (per taskId, for post-generation text compositing) ──
const textOverlayContexts = new Map();
const TEXT_OVERLAY_CTX_TTL = 15 * 60 * 1000; // 15 minutes
const MAX_TEXT_OVERLAY_CTXS = 200;

function storeTextOverlayContext(taskId, context) {
  if (textOverlayContexts.size >= MAX_TEXT_OVERLAY_CTXS) {
    const oldest = textOverlayContexts.keys().next().value;
    textOverlayContexts.delete(oldest);
  }
  textOverlayContexts.set(taskId, context);
  setTimeout(() => textOverlayContexts.delete(taskId), TEXT_OVERLAY_CTX_TTL);
}

// ── Gemini completed results store (sync generation, client still polls /status) ──
const geminiResults = new Map();
const GEMINI_RESULT_TTL = 15 * 60 * 1000; // 15 minutes
const MAX_GEMINI_RESULTS = 200;

function storeGeminiResult(taskId, result) {
  if (geminiResults.size >= MAX_GEMINI_RESULTS) {
    const oldest = geminiResults.keys().next().value;
    geminiResults.delete(oldest);
  }
  geminiResults.set(taskId, result);
  setTimeout(() => geminiResults.delete(taskId), GEMINI_RESULT_TTL);
}

// ── Persistent image store (DB-backed, in-memory cache for speed) ──
const tempImages = new Map();
const TEMP_IMAGE_TTL = 30 * 60 * 1000; // 30 minutes in-memory cache
const MAX_TEMP_IMAGES = 200;

// Auto-create image_store table on first load (idempotent)
(async () => {
  try {
    await pgQuery(`
      CREATE TABLE IF NOT EXISTS image_store (
        id TEXT PRIMARY KEY,
        data BYTEA NOT NULL,
        content_type TEXT NOT NULL DEFAULT 'image/png',
        created_at TIMESTAMPTZ DEFAULT NOW()
      )
    `, [], { timeout: 15000 });
    await pgQuery(
      'CREATE INDEX IF NOT EXISTS idx_image_store_created ON image_store(created_at)',
      [], { timeout: 10000 }
    );
    console.log('[imageStore] image_store table ready');
  } catch (err) {
    console.warn('[imageStore] Could not ensure image_store table:', err.message);
  }
})();

// Auto-add deep_analysis columns to statics_templates on boot (idempotent)
(async () => {
  try {
    await pgQuery(`ALTER TABLE statics_templates ADD COLUMN IF NOT EXISTS deep_analysis JSONB`, []);
    await pgQuery(`ALTER TABLE statics_templates ADD COLUMN IF NOT EXISTS analyzed_at TIMESTAMPTZ`, []);
    console.log('[boot] statics_templates deep_analysis columns ensured');
  } catch (err) {
    console.warn('[boot] Could not add deep_analysis columns:', err.message);
  }
})();

// Periodic cleanup: delete image_store entries older than 7 days (runs every 6 hours)
setInterval(async () => {
  try {
    const result = await pgQuery(
      "DELETE FROM image_store WHERE created_at < NOW() - INTERVAL '7 days' RETURNING id",
      [], { timeout: 30000 }
    );
    if (result.length > 0) {
      console.log(`[imageStore] Cleaned up ${result.length} expired images (>7 days old)`);
    }
  } catch (err) {
    console.warn('[imageStore] Cleanup failed:', err.message);
  }
}, 6 * 60 * 60 * 1000); // Every 6 hours

/**
 * Store image persistently in PostgreSQL + in-memory cache.
 * Returns the UUID used as the image key.
 */
async function storeTempImage(buf, contentType) {
  if (tempImages.size >= MAX_TEMP_IMAGES) {
    const oldest = tempImages.keys().next().value;
    tempImages.delete(oldest);
  }
  const id = crypto.randomUUID();
  // Cache in memory for fast serving
  tempImages.set(id, { buf, contentType });
  setTimeout(() => tempImages.delete(id), TEMP_IMAGE_TTL);
  // Persist to DB so images survive server restarts
  try {
    await pgQuery(
      'INSERT INTO image_store (id, data, content_type) VALUES ($1, $2, $3) ON CONFLICT (id) DO NOTHING',
      [id, buf, contentType],
      { timeout: 15000 }
    );
  } catch (err) {
    console.warn('[storeTempImage] DB persist failed, image is memory-only:', err.message);
  }
  return id;
}

// ── Reset launched creatives back to ready ──
router.post('/reset-launched', authenticate, async (req, res) => {
  try {
    const limit = parseInt(req.query.limit) || 2;
    const result = await pgQuery(
      `UPDATE spy_creatives SET status = 'ready', review_notes = 'Reset to re-launch', updated_at = NOW()
       WHERE id IN (
         SELECT id FROM spy_creatives WHERE status = 'launched' ORDER BY updated_at DESC LIMIT $1
       )
       RETURNING id, angle`,
      [limit]
    );
    res.json({ success: true, reset_count: result.length, creatives: result.map(r => ({ id: r.id, angle: r.angle })) });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

// ── Reset stuck 'generating' creatives back to 'ready' ──
router.post('/reset-generating', authenticate, async (req, res) => {
  try {
    const result = await pgQuery(
      `UPDATE spy_creatives SET status = 'ready', review_notes = 'Reset: stuck in generating after server restart', updated_at = NOW()
       WHERE status = 'generating'
       RETURNING id, angle, aspect_ratio, product_name`,
      []
    );
    console.log(`[staticsGeneration] Reset ${result.length} stuck generating creatives to ready`);
    res.json({ success: true, reset_count: result.length, creatives: result.map(r => ({ id: r.id, angle: r.angle, ratio: r.aspect_ratio, product: r.product_name })) });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});


// ── Background reconciliation: mark long-stuck generating rows as rejected ──
// Runs every 3 minutes. Any DB row still in 'generating' for >10 minutes is
// almost certainly orphaned (server restarted mid-poll or Gemini/NB failed
// silently) — mark it rejected with a clear note so the UI stops showing a
// permanent spinner. Tracked separately from the API reset endpoint so ops
// doesn't have to remember to run it.
const STALE_GENERATING_TIMEOUT_MS = 10 * 60 * 1000;
const RECONCILE_INTERVAL_MS = 3 * 60 * 1000;
setInterval(async () => {
  try {
    const cutoff = new Date(Date.now() - STALE_GENERATING_TIMEOUT_MS).toISOString();
    const result = await pgQuery(
      `UPDATE spy_creatives
         SET status = 'rejected',
             review_notes = COALESCE(review_notes, '') || ' [auto-reconciled: stuck generating >10m]',
             updated_at = NOW()
       WHERE status = 'generating' AND created_at < $1
       RETURNING id`,
      [cutoff]
    );
    if (result.length > 0) {
      console.log(`[staticsGeneration] Reconciliation: marked ${result.length} stale 'generating' rows as rejected`);
    }
  } catch (err) {
    console.warn(`[staticsGeneration] Reconciliation error: ${err.message}`);
  }
}, RECONCILE_INTERVAL_MS).unref?.();

// ── Meta App Diagnostic & Live Mode Toggle ──
router.get('/meta-app-diagnose', authenticate, async (req, res) => {
  try {
    const info = await diagnoseMetaApp();
    res.json({ success: true, data: info });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

router.post('/meta-app-go-live', authenticate, async (req, res) => {
  try {
    const result = await switchAppToLiveMode();
    res.json({ success: true, data: result });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
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
    const record = data.data || data;
    // NanoBanana uses successFlag: 1=processing, 2=success, 3=error
    const flag = record.successFlag;

    console.log(`[staticsGeneration] Poll ${i+1}/${MAX_POLLS} — successFlag=${flag}, taskId=${taskId}`);

    if (flag === 2) {
      const imageUrl = extractNanoBananaImageUrl(data);
      if (!imageUrl) {
        console.error('[staticsGeneration] NanoBanana success but no image URL extracted.');
        console.error('[staticsGeneration] Full response (3000 chars):', JSON.stringify(data).slice(0, 3000));
        throw new Error('NanoBanana completed but no resultImageUrl found');
      }
      return imageUrl;
    }
    if (flag === 3) {
      console.error('[staticsGeneration] NanoBanana failed. Full response:', JSON.stringify(data).slice(0, 2000));
      throw new Error(`NanoBanana generation failed: ${record.errorMessage || 'Unknown error'}`);
    }
    // flag === 1 (or undefined/pending) → still processing, keep polling
  }

  throw new Error('NanoBanana generation timed out after 5 minutes');
}

/**
 * Ensure a URL is HTTP-accessible for NanoBanana (converts data-URIs and relative paths).
 */
async function ensureHttpUrlGlobal(url, label = 'img') {
  const GLOBAL_SERVER_URL = process.env.RENDER_EXTERNAL_URL || `http://localhost:${process.env.PORT || 3000}`;
  if (!url) return url;
  if (url.startsWith('/')) return `${GLOBAL_SERVER_URL}${url}`;
  if (!url.startsWith('data:image')) return url;
  const m = url.match(/^data:(image\/[^;]+);base64,(.+)$/);
  if (!m) return url;
  const buf = Buffer.from(m[2], 'base64');
  if (isR2Configured()) {
    const ext = m[1].includes('png') ? 'png' : 'jpg';
    const key = `statics-${label}/${crypto.randomUUID()}.${ext}`;
    return await uploadBuffer(buf, key, m[1]);
  }
  const id = await storeTempImage(buf, m[1]);
  return `${GLOBAL_SERVER_URL}/api/v1/statics-generation/tmp-img/${id}`;
}

// ── Layout Analysis — runs once per template, cached in DB ────────────

async function analyzeAndCacheLayout(templateId, imageUrl) {
  try {
    const { base64, mediaType } = await resolveImage(imageUrl);
    const { system, user } = buildLayoutAnalysisPrompt();

    const res = await fetch(CLAUDE_API_URL, {
      method: 'POST',
      headers: {
        'x-api-key': ANTHROPIC_API_KEY,
        'anthropic-version': '2023-06-01',
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        model: 'claude-sonnet-4-6',
        max_tokens: 3000,
        system,
        messages: [
          {
            role: 'user',
            content: [
              { type: 'text', text: user },
              { type: 'image', source: { type: 'base64', media_type: mediaType, data: base64 } },
            ],
          },
        ],
      }),
    });

    if (!res.ok) {
      const errText = await res.text();
      throw new Error(`Claude layout analysis error ${res.status}: ${errText.slice(0, 300)}`);
    }

    const data = await res.json();
    const rawText = data.content?.[0]?.text;
    if (!rawText) throw new Error('Empty response from Claude layout analysis');

    const jsonMatch = rawText.match(/\{[\s\S]*\}/);
    if (!jsonMatch) throw new Error('No JSON in layout analysis response');

    let layoutMap;
    try {
      layoutMap = JSON.parse(jsonMatch[0]);
    } catch (e) {
      // Try fixing trailing commas
      let fixable = jsonMatch[0].replace(/,\s*([}\]])/g, '$1');
      layoutMap = JSON.parse(fixable);
    }

    // Cache in DB
    await pgQuery(
      `UPDATE statics_templates
       SET metadata = jsonb_set(
               CASE WHEN metadata IS NULL OR jsonb_typeof(metadata) != 'object' THEN '{}'::jsonb ELSE metadata END,
               '{layout_map}', $1::jsonb),
           updated_at = NOW()
       WHERE id = $2`,
      [JSON.stringify(layoutMap), templateId]
    );

    console.log(`[staticsGeneration] ✅ Layout map analyzed and cached for template ${templateId} (archetype: ${layoutMap.archetype})`);
    return layoutMap;
  } catch (err) {
    console.error(`[staticsGeneration] Layout analysis failed for template ${templateId}:`, err.message);
    return null;
  }
}

// ── POST /generate ─────────────────────────────────────────────────────
// Returns a taskId IMMEDIATELY and runs generation in the background.
// Client polls GET /status/:taskId for progress/result.

router.post('/generate', authenticate, async (req, res) => {
  const { reference_image_url, product, angle, ratio, template_id } = req.body;

  if (!reference_image_url) return res.status(400).json({ success: false, error: 'reference_image_url is required' });
  if (!product)             return res.status(400).json({ success: false, error: 'product is required' });

  // Pre-allocate a taskId and respond IMMEDIATELY — no more 502s from proxy timeout
  const earlyTaskId = `gen-${crypto.randomUUID()}`;
  const earlyTask = { taskId: earlyTaskId, ratio: ratio || '4:5' };
  storeGeminiResult(earlyTaskId, { status: 'processing', progress: 'Analyzing reference image...' });
  res.json({ success: true, data: { taskId: earlyTaskId, tasks: [earlyTask], provider: 'gemini', status: 'processing' } });

  // ── Watchdog: if the pipeline hangs (unhandled promise, proxy cutoff, etc.)
  // flip earlyTaskId to error after 8 minutes so the client doesn't poll forever.
  const watchdog = setTimeout(() => {
    const cur = geminiResults.get(earlyTaskId);
    if (cur && cur.status === 'processing') {
      console.error(`[staticsGeneration] Watchdog fired for ${earlyTaskId} — still processing after 8m, marking as error`);
      storeGeminiResult(earlyTaskId, { status: 'error', error: 'Generation exceeded 8-minute limit (pipeline hang)' });
    }
  }, 8 * 60 * 1000);

  // ── Run the full pipeline in the background ──────────────────────────
  setImmediate(async () => {
  try {
    const { reference_image_url, product, angle, ratio, template_id } = req.body;

    // Log product context for debugging copy quality
    const profileFields = product.profile ? Object.keys(product.profile).filter(k => product.profile[k]) : [];
    console.log(`[staticsGeneration] Product: "${product.name}" | Price: ${product.price || 'N/A'} | Profile fields: [${profileFields.join(', ')}] (${profileFields.length} fields)`);
    if (profileFields.length === 0) {
      console.warn(`[staticsGeneration] ⚠️ No product profile fields sent! Copy will lack product context.`);
    }

    // ── Load custom prompt overrides (fall back to defaults if none saved) ──
    const customPrompts = await getCustomStaticsPrompts() || getDefaultStaticsPrompts();
    const hasCustomOverrides = !!(customPrompts?.claudeAnalysis?.headlineRules || customPrompts?.claudeAnalysis?.productIdentity || customPrompts?.claudeAnalysis?.bannedPhrases);
    console.log(`[staticsGeneration] Custom prompt overrides: ${hasCustomOverrides ? 'YES (custom prompts from DB)' : 'NO (using defaults)'}`);

    // ── Load cached layout map + deep analysis if template-based ──────
    let layoutMap = null;
    let templateData = null;
    if (template_id) {
      try {
        const rows = await pgQuery(
          `SELECT metadata, deep_analysis FROM statics_templates WHERE id = $1`,
          [template_id]
        );
        const meta = rows[0]?.metadata;
        layoutMap = (typeof meta === 'string' ? JSON.parse(meta) : meta)?.layout_map || null;
        const rawDeep = rows[0]?.deep_analysis;
        const deepAnalysis = typeof rawDeep === 'string' ? JSON.parse(rawDeep) : rawDeep;
        if (deepAnalysis) {
          templateData = { deep_analysis: deepAnalysis };
          console.log(`[staticsGeneration] ✅ Template ${template_id} has deep_analysis — injecting into prompts`);
        }
        if (layoutMap) {
          console.log(`[staticsGeneration] ✅ Using cached layout map for template ${template_id} (archetype: ${layoutMap.archetype})`);
        } else {
          console.log(`[staticsGeneration] Template ${template_id} has no layout map — running layout analysis first`);
          // Auto-analyze the template on first use
          layoutMap = await analyzeAndCacheLayout(template_id, reference_image_url);
        }
      } catch (err) {
        console.warn(`[staticsGeneration] Layout map fetch/analysis failed for ${template_id}:`, err.message);
      }
    }

    // ── Step A: Resolve reference image to base64 ──────────────────────
    const { base64, mediaType, isUrl } = await resolveImage(reference_image_url);

    // ── Step B: Call Claude to analyze the reference ad ─────────────────
    const t0 = Date.now();
    const claudeBody = {
      model: 'claude-sonnet-4-6',
      max_tokens: 4000,
      temperature: 0.4,
      messages: [
        {
          role: 'user',
          content: [
            { type: 'text', text: buildClaudePrompt(product, angle, customPrompts, layoutMap, templateData) },
            { type: 'image', source: { type: 'base64', media_type: mediaType, data: base64 } },
          ],
        },
      ],
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
    console.log(`[staticsGeneration] ⏱ Claude finished in ${Date.now() - t0}ms`);
    storeGeminiResult(earlyTaskId, { status: 'processing', progress: 'Building image prompt...' });
    const rawText = claudeData.content?.[0]?.text;
    if (!rawText) throw new Error('Empty response from Claude');

    // Extract JSON block from full response (no assistant prefill)
    const jsonMatch = rawText.match(/\{[\s\S]*\}/);
    if (!jsonMatch) throw new Error('Could not parse JSON from Claude response');

    let claudeResult;
    try {
      claudeResult = JSON.parse(jsonMatch[0]);
    } catch (parseErr) {
      // Try to fix common issues: trailing commas, truncated responses
      let fixable = jsonMatch[0]
        .replace(/,\s*([}\]])/g, '$1')  // remove trailing commas
        .replace(/\n/g, '\\n');         // escape raw newlines
      const opens = (fixable.match(/\{/g) || []).length;
      const closes = (fixable.match(/\}/g) || []).length;
      for (let i = 0; i < opens - closes; i++) fixable += '}';
      try { claudeResult = JSON.parse(fixable); } catch {}
      if (!claudeResult) throw new Error(`Failed to parse Claude JSON: ${parseErr.message}`);
    }

    // ── Step B.5 (P0.4.6): Deterministic sanitizer on adapted_text ─────
    // Last chance to catch Claude's fabrications (fake %-OFF, fake
    // WARRANTY periods, fake WAS-$ anchors, invented prices). Rewrites
    // the adapted_text in-place so the overlay / image model only ever
    // sees ground-truth numbers.
    try {
      const { sanitizeAdaptedText } = await import('../utils/adaptedTextSanitizer.js');
      const { sanitizedText, changes } = sanitizeAdaptedText(claudeResult.adapted_text, product);
      if (changes.length > 0) {
        claudeResult.adapted_text = sanitizedText;
        console.log(`[staticsGeneration] Sanitizer rewrote ${changes.length} claim(s) in adapted_text`);
      }
    } catch (sanErr) {
      console.warn(`[staticsGeneration] Sanitizer threw — passing adapted_text through unchanged: ${sanErr.message}`);
    }

    // ── Step C: Build swap pairs ───────────────────────────────────────
    const swapPairs = buildSwapPairs(claudeResult.original_text, claudeResult.adapted_text, product.name);

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
      // Fallback: self-host as persistent DB image
      const id = await storeTempImage(buf, m[1]);
      const url = `${SERVER_URL}/api/v1/statics-generation/tmp-img/${id}`;
      console.log(`[staticsGeneration] Stored ${label} as temp image: ${url}`);
      return url;
    }

    let finalReferenceUrl = isUrl ? reference_image_url : await ensureHttpUrl(reference_image_url, 'refs');
    let finalProductUrl = await ensureHttpUrl(product.product_image_url, 'products');

    // Fallback: if no main product image, try product_images array
    const allProductImages = product.product_images || [];
    if (!finalProductUrl && allProductImages.length > 0) {
      console.log(`[staticsGeneration] ⚠️ No product_image_url — falling back to product_images[0]`);
      finalProductUrl = await ensureHttpUrl(allProductImages[0], 'products-fallback');
    }

    // Smart product image selection based on reference orientation
    const userSelectedImages = product.selected_product_images || [];
    if (allProductImages.length > 1 && userSelectedImages.length === 0 && claudeResult.product_orientation) {
      try {
        const { selectBestProductImage } = await import('../utils/productImageSelector.js');
        const selection = await selectBestProductImage(allProductImages, claudeResult.product_orientation);
        if (selection.index > 0 && selection.selectedUrl !== product.product_image_url) {
          console.log(`[imageSelector] Auto-selected image ${selection.index + 1}/${allProductImages.length} for ${claudeResult.product_orientation} orientation — ${selection.reason}`);
          finalProductUrl = await ensureHttpUrl(selection.selectedUrl, 'products-autoselect');
        } else {
          console.log(`[imageSelector] Kept default image (index 0) — ${selection.reason || 'best match'}`);
        }
      } catch (selErr) {
        console.warn(`[imageSelector] Auto-selection failed, using default: ${selErr.message}`);
      }
    }

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

    // ── LOGO INJECTION ──
    // When Claude detects a competitor logo in the reference, send our brand logo(s)
    // so Gemini can swap them. Validated against visual_adaptations to prevent false positives.
    const logoUrls = [];
    let hasCompetitorLogo = claudeResult.has_competitor_logo === true;

    // Strict validation: only inject logo if Claude also listed it in visual_adaptations
    if (hasCompetitorLogo) {
      const visualAdapts = claudeResult.visual_adaptations || [];
      const hasLogoInVisuals = visualAdapts.some(v =>
        /\blogo\b/i.test(v.original_visual || '') || /\blogo\b/i.test(v.adapted_visual || '') || /\blogo\b/i.test(v.position || '')
      );
      if (!hasLogoInVisuals) {
        console.warn(`[staticsGeneration] ⚠️ Claude detected has_competitor_logo=true but no logo in visual_adaptations — OVERRIDING to false`);
        hasCompetitorLogo = false;
      }
    }

    if (hasCompetitorLogo) {
      const allLogos = [...(product.logos || [])];
      if (product.logo_url) allLogos.unshift(product.logo_url);
      for (let i = 0; i < Math.min(allLogos.length, 2); i++) {
        const url = await ensureHttpUrl(allLogos[i], `logos-${i}`);
        if (url) logoUrls.push(url);
      }
      console.log(`[staticsGeneration] ✅ Competitor logo detected — sending ${logoUrls.length} brand logo(s)`);
    } else {
      console.log(`[staticsGeneration] No competitor logo in reference — skipping logo injection`);
    }

    console.log(`[staticsGeneration] Logo data: logo_url=${product.logo_url ? 'yes' : 'no'}, logos=${(product.logos || []).length}, resolved logoUrls=${logoUrls.length}`);
    if (!finalProductUrl) {
      console.warn(`[staticsGeneration] ⚠️ WARNING: No product image available! Gemini will hallucinate the product. Check product_image_url and product_images for "${product.name}".`);
    }
    console.log(`[staticsGeneration] Product images: main=${finalProductUrl ? 'yes' : 'no'}, extra=${extraProductUrls.length}`);
    console.log(`[staticsGeneration] Image URLs sent to NanoBanana:`);
    console.log(`  [0] main product: ${finalProductUrl?.slice(0, 120)}`);
    extraProductUrls.forEach((u, i) => console.log(`  [${i+1}] extra product: ${u?.slice(0, 120)}`));
    logoUrls.forEach((u, i) => console.log(`  [${extraProductUrls.length+1+i}] logo: ${u?.slice(0, 120)}`));
    console.log(`  [LAST] reference: ${finalReferenceUrl?.slice(0, 120)}`);

    // If reference has NO product (product_count === 0), don't send product images
    // Otherwise Gemini/NanoBanana will inject a product where none should exist
    const refHasProduct = (claudeResult.product_count ?? 1) > 0;
    if (!refHasProduct) {
      console.log(`[staticsGeneration] Reference has product_count=0 — NOT sending product images (text-only/testimonial template)`);
    }

    const logoBackgroundTone = claudeResult.logo_background_tone || null;
    // ── P1.1: Text-overlay compositing is the real fix for Gemini's text-
    // rendering defects (misspellings, dupes, letter-swaps, fabricated
    // prices). When enabled, Gemini produces a text-FREE image and our
    // overlayText() step paints the exact adapted_text on top using real
    // fonts via satori/resvg + Sharp. Result: zero text errors by
    // construction. Controlled via env STATICS_TEXT_OVERLAY (default on).
    const skipTextRendering = (process.env.STATICS_TEXT_OVERLAY || 'false').toLowerCase() !== 'false';
    // Pass extra product count so prompt builder can calculate correct logo image indices
    claudeResult._extraProductCount = refHasProduct ? extraProductUrls.length : 0;
    claudeResult._refHasProduct = refHasProduct;
    const nbPrompt = buildNanoBananaPrompt(claudeResult, swapPairs, product, logoUrls.length, customPrompts, layoutMap, logoBackgroundTone, skipTextRendering, templateData);

    // Send: product images (only if ref has product), then logos, then reference ad (last)
    // Filter out null/undefined entries — NanoBanana requires all URLs to be valid strings
    const productImages = refHasProduct ? [finalProductUrl, ...extraProductUrls] : [];
    const imageUrls = [...productImages, ...logoUrls, finalReferenceUrl].filter(Boolean);
    console.log(`[staticsGeneration] Prompt:\n${nbPrompt}`);
    console.log(`[staticsGeneration] Total images: ${imageUrls.length} (${extraProductUrls.length} extra product, ${logoUrls.length} logos)`);

    // Determine which ratios to generate
    const requestedRatio = req.body.ratio;
    const ratiosToGenerate = requestedRatio && requestedRatio !== 'all'
      ? [requestedRatio]
      : ['1:1', '9:16'];

    // Determine provider: default to gemini, fallback to nanobanana
    const provider = req.body.provider || 'nanobanana';
    console.log(`[staticsGeneration] Provider: ${provider}, Generating ${ratiosToGenerate.length} ratio(s): ${ratiosToGenerate.join(', ')}`);

    // ── GEMINI PATH: Direct image editing via Gemini 3.1 Flash ──
    if (provider === 'gemini' && isGeminiConfigured()) {
      // Fetch all input images as base64 for Gemini inline_data
      async function fetchImageAsBase64(url) {
        if (!url) return null;
        if (url.startsWith('data:image')) {
          const m = url.match(/^data:(image\/[^;]+);base64,(.+)$/);
          return m ? { base64: m[2], mimeType: m[1] } : null;
        }
        // Handle self-hosted temp images
        let fetchUrl = url;
        if (url.startsWith('/')) {
          const base = process.env.RENDER_EXTERNAL_URL || `http://localhost:${process.env.PORT || 3000}`;
          fetchUrl = `${base}${url}`;
        }
        const r = await fetch(fetchUrl);
        if (!r.ok) throw new Error(`Failed to fetch image: ${r.status} ${fetchUrl.slice(0, 100)}`);
        const buf = Buffer.from(await r.arrayBuffer());
        const mime = detectMime(buf);
        return { base64: buf.toString('base64'), mimeType: mime };
      }

      try {
        // Build input images array in parallel — fetch all images simultaneously
        const tFetch = Date.now();
        const fetchResults = await Promise.allSettled(
          imageUrls.filter(Boolean).map(url => fetchImageAsBase64(url).catch(e => {
            console.warn(`[staticsGeneration] ⚠️ Failed to fetch image (skipping): ${url.slice(0, 100)} — ${e.message}`);
            return null;
          }))
        );
        const inputImages = fetchResults
          .map(r => r.status === 'fulfilled' ? r.value : null)
          .filter(Boolean);
        console.log(`[staticsGeneration] Gemini: ${inputImages.length} images loaded in ${Date.now() - tFetch}ms`);
        if (inputImages.length === 0) {
          throw new Error('No input images could be fetched for Gemini (reference image + product images all failed to load)');
        }
        storeGeminiResult(earlyTaskId, { status: 'processing', progress: `Generating ${ratiosToGenerate.length} image ratio(s)...` });

        // Generate all ratios in parallel. Each ratio gets up to MAX_GEN_ATTEMPTS
        // attempts — after each attempt we run a strict text-quality check
        // (validateGenerationText) and regenerate on HARD-fail (misspellings,
        // duplicated words, fabricated offers, letter-swaps, etc). Best-of-N
        // is kept if all attempts fail so we still ship SOMETHING — but with a
        // quality_warning flag so the UI / frontend can show a review banner.
        //
        // P1.1: When skipTextRendering is on, we're producing text-FREE images
        // and compositing real-font text on top — so the text-quality validator
        // becomes irrelevant (no text to validate on the raw Gemini buffer;
        // overlay-rendered text is deterministically correct). Skip it in that
        // mode; 1 attempt is enough.
        const { validateGenerationText, summarizeTextValidation } = await import('../utils/generationTextValidator.js');
        const MAX_GEN_ATTEMPTS = skipTextRendering ? 1 : 3;

        const tAll = Date.now();
        const ratioResults = await Promise.allSettled(
          ratiosToGenerate.map(async (r) => {
            const tGemini = Date.now();
            const attempts = [];

            for (let attempt = 1; attempt <= MAX_GEN_ATTEMPTS; attempt++) {
              console.log(`[staticsGeneration] Gemini ${r}: generating (attempt ${attempt}/${MAX_GEN_ATTEMPTS})...`);
              const tAttempt = Date.now();
              const result = await editImage(nbPrompt, inputImages, r);
              console.log(`[staticsGeneration] ⏱ Gemini ${r} attempt ${attempt} finished in ${Date.now() - tAttempt}ms`);

              // Text-quality check (blocking). ~5-10s added per attempt, worth it
              // to not ship broken text. Hard-fails trigger regeneration.
              // Skip in P1.1 overlay mode (no text on raw buffer to validate).
              let validation = null;
              if (skipTextRendering) {
                validation = { passed: true, severity: 'clean', totalErrors: 0, errors: {}, skipped: 'text-overlay mode' };
                console.log(`[text-validator] ${r} attempt ${attempt}: skipped (overlay mode active)`);
              } else {
                try {
                  validation = await validateGenerationText(
                    result.buffer,
                    result.mimeType,
                    claudeResult?.adapted_text || {},
                    product,
                  );
                  console.log(`[text-validator] ${r} attempt ${attempt}: ${summarizeTextValidation(validation)}`);
                } catch (valErr) {
                  console.warn(`[text-validator] ${r} attempt ${attempt} threw — allowing the attempt to proceed: ${valErr.message}`);
                  validation = { passed: true, severity: 'clean', totalErrors: 0, errors: {}, skipped: `validator error: ${valErr.message}` };
                }
              }

              attempts.push({ attempt, result, validation });

              if (validation.passed) {
                console.log(`[staticsGeneration] ${r}: passed text QC on attempt ${attempt} — accepting`);
                break;
              }
              if (attempt < MAX_GEN_ATTEMPTS) {
                console.warn(`[staticsGeneration] ${r}: failed text QC on attempt ${attempt} — regenerating`);
              } else {
                console.error(`[staticsGeneration] ${r}: failed text QC on ALL ${MAX_GEN_ATTEMPTS} attempts — shipping best-of-N with quality_warning`);
              }
            }

            // Pick the best attempt: first passing one, otherwise the one with
            // the fewest hard errors (tiebreaker: fewest total errors).
            const passing = attempts.find(a => a.validation?.passed);
            const chosen = passing || attempts.reduce((best, cur) => {
              const bh = best?.validation?.hardErrorCount ?? Infinity;
              const ch = cur?.validation?.hardErrorCount ?? Infinity;
              if (ch < bh) return cur;
              if (ch === bh && (cur?.validation?.totalErrors ?? Infinity) < (best?.validation?.totalErrors ?? Infinity)) return cur;
              return best;
            }, attempts[0]);

            const { result, validation, attempt: chosenAttempt } = chosen;
            console.log(`[staticsGeneration] ⏱ Gemini ${r} total (incl. QC + retries) ${Date.now() - tGemini}ms — chose attempt ${chosenAttempt}`);

            // ── P1.1: Text-overlay compositing. When skipTextRendering is on,
            // Gemini returned a text-FREE image; now paint real-font text onto
            // it using swap pairs + Claude's layout map. If overlay throws, we
            // fall back to the raw Gemini buffer (which will be text-free and
            // obviously incomplete — but at least it's something visible).
            let finalBuffer = result.buffer;
            let finalMimeType = result.mimeType;
            let overlayApplied = false;
            if (skipTextRendering) {
              try {
                const { overlayText } = await import('../utils/textOverlay.js');
                const composited = await overlayText(
                  result.buffer,
                  swapPairs,
                  layoutMap,
                  {
                    fonts: product.fonts || [],
                    backgroundTone: layoutMap?.background?.tone || logoBackgroundTone || 'dark',
                  }
                );
                if (Buffer.isBuffer(composited) && composited.length > 0) {
                  finalBuffer = composited;
                  finalMimeType = 'image/png';
                  overlayApplied = true;
                  console.log(`[staticsGeneration] ✅ Gemini ${r}: text overlay composited (${composited.length} bytes)`);
                } else {
                  console.warn(`[staticsGeneration] Gemini ${r}: overlayText returned empty — using raw text-free buffer`);
                }
              } catch (overlayErr) {
                console.error(`[staticsGeneration] Gemini ${r}: overlay failed — ${overlayErr.message}. Falling back to raw text-free buffer.`);
              }
            }

            // Upload to R2 or store as temp
            let resultImageUrl;
            if (isR2Configured()) {
              const r2Key = `statics-gemini/${crypto.randomUUID()}.png`;
              resultImageUrl = await uploadBuffer(finalBuffer, r2Key, finalMimeType);
              console.log(`[staticsGeneration] Gemini result uploaded to R2: ${resultImageUrl}`);
            } else {
              const tmpId = await storeTempImage(finalBuffer, finalMimeType);
              const srvUrl = process.env.RENDER_EXTERNAL_URL || `http://localhost:${process.env.PORT || 3000}`;
              resultImageUrl = `${srvUrl}/api/v1/statics-generation/tmp-img/${tmpId}`;
            }

            const taskId = `gemini-${crypto.randomUUID()}`;
            storeGeminiResult(taskId, {
              status: 'completed',
              resultImageUrl,
              provider: 'gemini',
              model: GEMINI_EDIT_MODEL,
              textValidation: validation ? {
                passed: validation.passed,
                severity: validation.severity,
                totalErrors: validation.totalErrors,
                hardErrorCount: validation.hardErrorCount,
                errors: validation.errors,
                attempts: attempts.length,
              } : null,
              quality_warning: validation && !validation.passed ? summarizeTextValidation(validation) : null,
            });
            console.log(`[staticsGeneration] Gemini ${r} complete: ${taskId} ${validation?.passed ? '' : `(${summarizeTextValidation(validation)})`}`);
            return { taskId, ratio: r };
          })
        );

        if (ratiosToGenerate.length > 1) {
          console.log(`[staticsGeneration] ⏱ All ${ratiosToGenerate.length} ratios finished in ${Date.now() - tAll}ms (parallel)`);
        }

        const tasks = ratioResults
          .filter(r => r.status === 'fulfilled')
          .map(r => r.value);

        ratioResults
          .filter(r => r.status === 'rejected')
          .forEach((r, i) => console.error(`[staticsGeneration] Gemini ${ratiosToGenerate[i]} failed: ${r.reason?.message}`));

        if (tasks.length > 0) {
          console.log(`[staticsGeneration] Gemini tasks completed: ${tasks.map(t => `${t.ratio}=${t.taskId}`).join(', ')}`);
          // Update earlyTaskId so the polling client gets the completed result
          const primaryResult = geminiResults.get(tasks[0].taskId);
          if (primaryResult) {
            storeGeminiResult(earlyTaskId, primaryResult);
            console.log(`[staticsGeneration] earlyTaskId ${earlyTaskId} updated → completed (${tasks[0].taskId})`);
          } else {
            // Fallback: mark earlyTaskId completed with redirect to real taskId
            storeGeminiResult(earlyTaskId, {
              status: 'redirect',
              realTaskId: tasks[0].taskId,
              tasks,
              claudeAnalysis: claudeResult,
              swapPairs,
            });
            console.log(`[staticsGeneration] earlyTaskId ${earlyTaskId} updated → redirect to ${tasks[0].taskId}`);
          }
          return; // Exit background task — don't fall through to NanoBanana
        }

        // If Gemini failed for all ratios, fall through to NanoBanana
        console.warn(`[staticsGeneration] Gemini failed for all ratios, falling back to NanoBanana`);
      } catch (geminiErr) {
        console.error(`[staticsGeneration] Gemini path failed, falling back to NanoBanana: ${geminiErr.message}`);
      }
    }

    // ── NANOBANANA PATH: Async task submission ──
    console.log(`[staticsGeneration] Using NanoBanana provider`);

    const parseNbResponse = async (res, label) => {
      const rawBody = await res.text().catch(() => '');
      if (!res.ok) {
        console.error(`[staticsGeneration] NanoBanana ${label} failed (HTTP ${res.status}). Full response body:\n${rawBody.slice(0, 3000)}`);
        return null;
      }
      try {
        return JSON.parse(rawBody);
      } catch (err) {
        console.error(`[staticsGeneration] NanoBanana ${label} JSON parse error: ${err.message}. Full response body:\n${rawBody.slice(0, 3000)}`);
        return null;
      }
    };

    const NB_RETRY_ATTEMPTS = 3;
    const NB_RETRY_DELAY = 2000;

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

        let data = null;
        for (let attempt = 1; attempt <= NB_RETRY_ATTEMPTS; attempt++) {
          const res = await fetch(`${NB_BASE}/generate-2`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${NANOBANANA_API_KEY}` },
            body,
          });
          data = await parseNbResponse(res, `${r} attempt ${attempt}/${NB_RETRY_ATTEMPTS}`);
          const taskId = data?.data?.taskId || data?.taskId;

          if (taskId) {
            return { taskId, ratio: r };
          }

          console.warn(`[staticsGeneration] NanoBanana ${r} attempt ${attempt}/${NB_RETRY_ATTEMPTS} returned no taskId. Parsed data: ${JSON.stringify(data).slice(0, 1000)}`);

          if (attempt < NB_RETRY_ATTEMPTS) {
            const delay = NB_RETRY_DELAY * attempt;
            console.log(`[staticsGeneration] Retrying NanoBanana ${r} in ${delay / 1000}s...`);
            await sleep(delay);
          }
        }

        console.error(`[staticsGeneration] NanoBanana ${r} failed after ${NB_RETRY_ATTEMPTS} attempts. Last response: ${JSON.stringify(data).slice(0, 2000)}`);
        return null;
      })
    );

    const tasks = nbResponses.filter(Boolean);

    if (tasks.length === 0) {
      console.error(`[staticsGeneration] All NanoBanana calls failed. nbResponses: ${JSON.stringify(nbResponses)}`);
      // setImmediate: res already consumed. Update earlyTaskId so the client
      // sees a clean failure state instead of polling until client-side timeout.
      storeGeminiResult(earlyTaskId, { status: 'error', error: 'Image generation failed after retries (all providers failed)' });
      return;
    }

    // ── Store text overlay context per task for the /status endpoint ──
    if (skipTextRendering) {
      const overlayCtx = {
        swapPairs,
        layoutMap,
        fonts: product.fonts || [],
        backgroundTone: layoutMap?.background?.tone || 'dark',
        applied: false,
      };
      for (const task of tasks) {
        storeTextOverlayContext(task.taskId, { ...overlayCtx });
        console.log(`[staticsGeneration] Stored text overlay context for task ${task.taskId} (${swapPairs.length} swap pairs)`);
      }
    }

    // ── Step E: Store final result under the pre-allocated earlyTaskId ──
    console.log(`[staticsGeneration] Generation complete, updating task ${earlyTaskId}`);
    // If Gemini path: update the earlyTaskId result with the real completed data
    const primaryTask = tasks[0];
    if (primaryTask) {
      const primaryResult = geminiResults.get(primaryTask.taskId);
      if (primaryResult && primaryTask.taskId !== earlyTaskId) {
        // Copy completed result into earlyTaskId so the client's poll resolves
        storeGeminiResult(earlyTaskId, primaryResult);
      }
    }
    // For NanoBanana: store a redirect pointer so /status knows the real taskId
    if (tasks[0]?.taskId && tasks[0].taskId !== earlyTaskId) {
      storeGeminiResult(earlyTaskId, {
        status: 'redirect',
        realTaskId: tasks[0].taskId,
        tasks,
        claudeAnalysis: claudeResult,
        swapPairs,
      });
    }
    console.log(`[staticsGeneration] Tasks ready: ${tasks.map(t => `${t.ratio}=${t.taskId}`).join(', ')}`);
  } catch (err) {
    console.error('[staticsGeneration] /generate background error:', err);
    storeGeminiResult(earlyTaskId, { status: 'error', error: err.message });
  } finally {
    clearTimeout(watchdog);
  }
  }); // end setImmediate
});

// ── GET /status/:taskId ────────────────────────────────────────────────

router.get('/status/:taskId', authenticate, async (req, res) => {
  try {
    const { taskId } = req.params;
    if (!taskId) return res.status(400).json({ success: false, error: 'taskId is required' });

    // ── Background-generated tasks: check in-memory store ──
    const geminiResult = geminiResults.get(taskId);
    if (geminiResult) {
      res.set('Cache-Control', 'no-store, no-cache, must-revalidate');
      res.set('Pragma', 'no-cache');

      // Still processing — tell client to keep polling
      if (geminiResult.status === 'processing') {
        return res.json({ success: true, data: { taskId, status: 'processing', progress: geminiResult.progress || 'Generating...' } });
      }

      // Redirect: NanoBanana path — forward to the real taskId
      if (geminiResult.status === 'redirect') {
        const realResult = await fetch(`${NB_BASE}/record-info?taskId=${geminiResult.realTaskId}`, {
          headers: { Authorization: `Bearer ${NANOBANANA_API_KEY}` },
        }).then(r => r.json()).catch(() => null);
        const state = realResult?.data?.state || realResult?.state;
        if (state === 'success') {
          const imgUrl = realResult?.data?.resultImageUrl || realResult?.resultImageUrl;
          return res.json({ success: true, data: { taskId, status: 'completed', successFlag: true, resultImageUrl: imgUrl, provider: 'nanobanana' } });
        }
        if (state === 'fail') {
          return res.json({ success: true, data: { taskId, status: 'failed', error: 'Generation failed' } });
        }
        return res.json({ success: true, data: { taskId, status: 'processing', progress: 'Generating image...' } });
      }

      // Error state
      if (geminiResult.status === 'error') {
        return res.json({ success: true, data: { taskId, status: 'failed', error: geminiResult.error } });
      }

      // Completed Gemini result
      return res.json({
        success: true,
        data: {
          taskId,
          status: geminiResult.status,
          successFlag: geminiResult.status === 'completed',
          resultImageUrl: geminiResult.resultImageUrl,
          provider: geminiResult.provider,
          model: geminiResult.model,
          error: geminiResult.error || null,
          // Pass text-QC payload through so the frontend can surface retries + issues
          textValidation: geminiResult.textValidation || null,
          quality_warning: geminiResult.quality_warning || null,
        },
      });
    }

    // ── gen-xxx taskId not in memory → server restarted, task expired ──
    if (taskId.startsWith('gen-')) {
      return res.json({ success: true, data: { taskId, status: 'failed', error: 'Generation expired (server restarted). Please retry.' } });
    }

    // ── NanoBanana results: poll kie.ai ──
    const nbRes = await fetch(`${NB_BASE}/record-info?taskId=${taskId}`, {
      headers: { Authorization: `Bearer ${NANOBANANA_API_KEY}` },
    });

    if (!nbRes.ok) {
      const errText = await nbRes.text();
      throw new Error(`NanoBanana status error ${nbRes.status}: ${errText}`);
    }

    const data = await nbRes.json();
    const record = data.data || data;
    // NanoBanana uses successFlag: 1=processing, 2=success, 3=error
    const flag = record.successFlag;

    let status;
    let errorDetail = null;
    if (flag === 2) {
      status = 'completed';
    } else if (flag === 3) {
      status = 'failed';
      errorDetail = record.errorMessage || data.error || data.data?.error || 'NanoBanana generation failed';
      console.error('[staticsGeneration] NanoBanana failed for task', taskId, '— flag:', flag, '— error:', errorDetail);
    } else {
      // flag === 1 or undefined → still processing
      status = 'pending';
    }

    let resultImageUrl = null;
    if (status === 'completed') {
      resultImageUrl = extractNanoBananaImageUrl(data);

      // ── Text Overlay: composite programmatic text onto the text-free image ──
      const overlayCtx = textOverlayContexts.get(taskId);
      if (overlayCtx && !overlayCtx.applied && resultImageUrl) {
        try {
          console.log(`[textOverlay] Downloading generated image for text overlay: ${resultImageUrl.slice(0, 120)}`);
          const imgRes = await fetch(resultImageUrl);
          if (!imgRes.ok) throw new Error(`Failed to download image: HTTP ${imgRes.status}`);
          const imageBuffer = Buffer.from(await imgRes.arrayBuffer());
          console.log(`[textOverlay] Downloaded ${imageBuffer.length} bytes, applying text overlay...`);

          const compositedBuffer = await overlayText(
            imageBuffer,
            overlayCtx.swapPairs,
            overlayCtx.layoutMap,
            { fonts: overlayCtx.fonts, backgroundTone: overlayCtx.backgroundTone }
          );

          // Store composited image and replace URL
          const STATUS_SERVER_URL = process.env.RENDER_EXTERNAL_URL || `http://localhost:${process.env.PORT || 3000}`;
          if (isR2Configured()) {
            const r2Key = `statics-composited/${crypto.randomUUID()}.png`;
            const r2Url = await uploadBuffer(compositedBuffer, r2Key, 'image/png');
            resultImageUrl = r2Url;
            console.log(`[textOverlay] Composited image uploaded to R2: ${r2Url}`);
          } else {
            const tmpId = await storeTempImage(compositedBuffer, 'image/png');
            resultImageUrl = `${STATUS_SERVER_URL}/api/v1/statics-generation/tmp-img/${tmpId}`;
            console.log(`[textOverlay] Composited image stored as temp: ${resultImageUrl}`);
          }

          overlayCtx.applied = true;
          overlayCtx.compositedUrl = resultImageUrl;
          console.log(`[textOverlay] Text overlay applied successfully for task ${taskId}`);
        } catch (overlayErr) {
          console.error(`[textOverlay] Text overlay failed for task ${taskId}:`, overlayErr.message);
          console.warn(`[textOverlay] Falling back to raw NanoBanana image (text may be AI-rendered or missing)`);
          // resultImageUrl stays as the raw NanoBanana URL — fallback behavior
        }
      } else if (overlayCtx?.applied && overlayCtx?.compositedUrl) {
        // Already applied on a previous poll — return the cached composited URL
        resultImageUrl = overlayCtx.compositedUrl;
      }
    }

    // Prevent browser caching so polling always gets fresh data
    res.set('Cache-Control', 'no-store, no-cache, must-revalidate');
    res.set('Pragma', 'no-cache');
    return res.json({
      success: true,
      data: {
        taskId,
        status,
        successFlag: state === 'success',
        resultImageUrl,
        error: errorDetail,
      },
    });
  } catch (err) {
    // Transient network errors (ECONNRESET, timeout, etc.) — return pending so client keeps polling
    const isTransient = err.cause?.code === 'ECONNRESET' || err.message === 'terminated' || err.message?.includes('fetch failed');
    if (isTransient) {
      console.warn('[staticsGeneration] /status transient error (returning pending):', err.message);
      res.set('Cache-Control', 'no-store, no-cache, must-revalidate');
      return res.json({ success: true, data: { taskId: req.params.taskId, status: 'pending', successFlag: false, resultImageUrl: null, error: null } });
    }
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
  await pgQuery('ALTER TABLE spy_creatives ADD COLUMN IF NOT EXISTS copy_set_id UUID').catch(() => {});
  await pgQuery('ALTER TABLE spy_creatives ADD COLUMN IF NOT EXISTS meta_ad_ids JSONB DEFAULT \'[]\'').catch(() => {});
  await pgQuery('ALTER TABLE spy_creatives ADD COLUMN IF NOT EXISTS meta_image_hash TEXT').catch(() => {});
  await pgQuery('ALTER TABLE spy_creatives ADD COLUMN IF NOT EXISTS generated_copy JSONB').catch(() => {});
  await pgQuery(`CREATE TABLE IF NOT EXISTS statics_launches (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    creative_id UUID REFERENCES spy_creatives(id) ON DELETE CASCADE,
    template_id UUID, copy_set_id UUID, ad_account_id TEXT,
    meta_campaign_id TEXT, meta_adset_id TEXT, meta_ad_id TEXT, meta_creative_id TEXT, meta_image_hash TEXT,
    ad_name TEXT, adset_name TEXT, page_id TEXT, page_name TEXT, batch_number INTEGER,
    status TEXT DEFAULT 'pending', error_message TEXT, launched_at TIMESTAMPTZ, created_at TIMESTAMPTZ DEFAULT NOW()
  )`).catch(() => {});

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
    let query = "SELECT id, product_id, product_name, image_url, thumbnail_url, source_label, angle, archetype, aspect_ratio, status, reference_thumbnail, reference_name, parent_creative_id, pipeline, copy_set_id, meta_ad_ids, meta_image_hash, generated_copy, created_at FROM spy_creatives WHERE pipeline = $1";
    const params = [pipeline];
    let idx = 2;

    if (product_id) { query += ` AND product_id = $${idx++}`; params.push(product_id); }
    if (status) { query += ` AND status = $${idx++}`; params.push(status); }

    query += ' ORDER BY created_at DESC';
    const rows = await pgQuery(query, params);

    // Enrich launched creatives with batch info from statics_launches
    const launchedIds = rows.filter(r => r.status === 'launched').map(r => r.id);
    if (launchedIds.length > 0) {
      try {
        const launchRows = await pgQuery(
          `SELECT DISTINCT ON (creative_id) creative_id, batch_number, adset_name, meta_adset_id
           FROM statics_launches
           WHERE creative_id = ANY($1)
           ORDER BY creative_id, created_at DESC`,
          [launchedIds]
        );
        const launchMap = {};
        for (const lr of launchRows) {
          launchMap[lr.creative_id] = { batch_number: lr.batch_number, adset_name: lr.adset_name, meta_adset_id: lr.meta_adset_id };
        }
        for (const row of rows) {
          if (row.status === 'launched' && launchMap[row.id]) {
            row.launch_batch = launchMap[row.id];
          }
        }
      } catch (e) {
        console.warn('[staticsGeneration] Could not enrich launch batch info:', e.message);
      }
    }

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
          const id = await storeTempImage(buf, m[1]);
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

    // 3b. Persist taskId BEFORE polling so a crash/restart mid-poll leaves a
    // recoverable reference in DB instead of an orphan 'generating' row.
    await pgQuery(
      "UPDATE spy_creatives SET generation_task_id = $1, updated_at = NOW() WHERE id = $2",
      [taskId, child.id]
    );

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

// PATCH /creatives/:id/angle — Update creative angle (for drag-and-drop between angle groups)
router.patch('/creatives/:id/angle', authenticate, async (req, res) => {
  try {
    await ensureCreativesTable();
    const { angle } = req.body;
    if (angle === undefined) {
      return res.status(400).json({ success: false, error: { message: 'angle is required' } });
    }
    const newAngle = angle || null; // empty string → null (will show as "Uncategorized")
    const rows = await pgQuery(
      'UPDATE spy_creatives SET angle = $1, updated_at = NOW() WHERE id = $2 RETURNING *',
      [newAngle, req.params.id]
    );
    if (rows.length === 0) return res.status(404).json({ success: false, error: { message: 'Creative not found' } });
    res.json({ success: true, data: rows[0] });
  } catch (err) {
    console.error('[staticsGeneration] /creatives/:id/angle error:', err);
    res.status(500).json({ success: false, error: { message: err.message } });
  }
});

// GET /creatives/pipeline — Creatives grouped by status for pipeline view
router.get('/creatives/pipeline', authenticate, async (req, res) => {
  try {
    await ensureCreativesTable();
    const { product_id } = req.query;

    let query = 'SELECT id, product_id, product_name, image_url, thumbnail_url, source_label, angle, archetype, aspect_ratio, status, reference_thumbnail, reference_name, parent_creative_id, pipeline, copy_set_id, meta_ad_ids, meta_image_hash, generated_copy, created_at FROM spy_creatives WHERE pipeline = $1';
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

    // Enrich launched creatives with batch info
    const launchedIds = pipeline.launched.map(r => r.id);
    if (launchedIds.length > 0) {
      try {
        const launchRows = await pgQuery(
          `SELECT DISTINCT ON (creative_id) creative_id, batch_number, adset_name, meta_adset_id
           FROM statics_launches
           WHERE creative_id = ANY($1)
           ORDER BY creative_id, created_at DESC`,
          [launchedIds]
        );
        const launchMap = {};
        for (const lr of launchRows) {
          launchMap[lr.creative_id] = { batch_number: lr.batch_number, adset_name: lr.adset_name, meta_adset_id: lr.meta_adset_id };
        }
        for (const row of pipeline.launched) {
          if (launchMap[row.id]) row.launch_batch = launchMap[row.id];
        }
      } catch (e) {
        console.warn('[staticsGeneration] Could not enrich launch batch info:', e.message);
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

// DELETE /creatives/:id — Delete creative (cascades to child variants)
router.delete('/creatives/:id', authenticate, async (req, res) => {
  try {
    await ensureCreativesTable();
    // Delete child variants first to avoid orphans
    await pgQuery('DELETE FROM spy_creatives WHERE parent_creative_id = $1', [req.params.id]);
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

    // Extract launch-friendly copy from Claude's adapted_text
    let generatedCopy = null;
    if (adapted_text) {
      const at = typeof adapted_text === 'string' ? JSON.parse(adapted_text) : adapted_text;
      generatedCopy = {
        primary_texts: [at.body || at.headline || ''].filter(Boolean),
        headlines: [at.headline || at.subheadline || ''].filter(Boolean),
        descriptions: [at.subheadline || at.cta || ''].filter(Boolean),
        cta: at.cta || '',
      };
    }

    // Auto-match copy set by product_id + angle
    let matchedCopySetId = null;
    if (product_id && angle) {
      const csRows = await pgQuery(
        'SELECT id FROM brief_copy_sets WHERE product_id = $1 AND LOWER(angle) = LOWER($2) LIMIT 1',
        [product_id, angle]
      ).catch(() => []);
      if (csRows.length) matchedCopySetId = csRows[0].id;
    }

    const rows = await pgQuery(
      `INSERT INTO spy_creatives
        (product_id, product_name, angle, aspect_ratio, image_url,
         reference_image_id, source_label, reference_name, reference_thumbnail,
         adapted_text, claude_analysis, swap_pairs, generation_prompt,
         generation_task_id, pipeline, status, group_id, generated_copy, copy_set_id)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19)
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
        generatedCopy ? JSON.stringify(generatedCopy) : null,
        matchedCopySetId,
      ]
    );
    const savedCreative = rows[0];

    // ── Post-save validation (non-blocking) ──────────────────────────
    const validationEnabled = true;
    const finalReferenceUrl = resolvedRefThumb || reference_thumbnail;
    const parsedSwapPairs = swap_pairs
      ? (typeof swap_pairs === 'string' ? JSON.parse(swap_pairs) : swap_pairs)
      : [];

    if (validationEnabled && image_url && finalReferenceUrl && Array.isArray(parsedSwapPairs)) {
      // Fire-and-forget: validate in background so response is not delayed
      (async () => {
        try {
          const { resolveImage: resolveImg } = await import('../utils/imageHelpers.js');
          const { validateGeneration } = await import('../utils/generationValidator.js');

          const genImage = await resolveImg(image_url);
          const refImage = await resolveImg(finalReferenceUrl);

          const validation = await validateGeneration(
            genImage.base64, refImage.base64, parsedSwapPairs,
            { generatedMediaType: genImage.mediaType, referenceMediaType: refImage.mediaType }
          );

          console.log(`[validation] Creative ${savedCreative.id} — Score: layout=${validation.scores.layout_match} text=${validation.scores.text_correctness} product=${validation.scores.product_fidelity} bg=${validation.scores.background_fidelity} brand=${validation.scores.competitor_branding} overall=${validation.scores.overall_quality} → ${validation.passed ? 'PASS' : 'FAIL'}`);

          if (validation.issues.length > 0) {
            console.log(`[validation] Issues: ${JSON.stringify(validation.issues)}`);
          }

          // Store validation results in claude_analysis JSONB
          // Use CASE to handle scalar/null claude_analysis values safely
          await pgQuery(
            `UPDATE spy_creatives
             SET claude_analysis = jsonb_set(
               CASE
                 WHEN claude_analysis IS NULL OR jsonb_typeof(claude_analysis) != 'object'
                 THEN '{}'::jsonb
                 ELSE claude_analysis
               END,
               '{validation}',
               $1::jsonb
             ),
             updated_at = NOW()
             WHERE id = $2`,
            [JSON.stringify({
              passed: validation.passed,
              score: validation.score,
              scores: validation.scores,
              issues: validation.issues,
              validated_at: new Date().toISOString(),
            }), savedCreative.id]
          );
        } catch (valErr) {
          console.warn(`[validation] Validation failed for creative ${savedCreative.id}, skipping: ${valErr.message}`);
        }
      })();
    }

    res.json({ success: true, data: savedCreative });
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
          text: `You are an AI creative director. Look at this ad image and apply the user's edit instruction.

User's edit instruction: "${instruction}"

Your job is to write a SHORT, DIRECT image editing prompt for Gemini (an image generation AI). The prompt should tell Gemini to edit this specific image.

RULES:
- Write the prompt as a DIRECT EDIT COMMAND, not a description
- Be SPECIFIC about what to change and what to keep
- Keep the prompt SHORT (under 200 words) — Gemini works better with concise prompts
- Reference the EXISTING image: "In this image, change X to Y" or "Edit this image: remove X" or "Modify this ad: replace the text 'OLD' with 'NEW'"
- For TEXT changes: list the exact old text → new text swaps
- For VISUAL changes: describe exactly what should change
- Everything NOT mentioned stays the same

EXAMPLES of good adjusted prompts:
- "Edit this ad image: change the headline text from 'FREE GIFTS' to remove it entirely. Keep everything else identical."
- "Modify this image: change the names 'James & Sara' to 'James & Sarah'. Keep all other text, layout, colors, product exactly the same."
- "Edit this ad: make the headline text 30% larger. Keep the same font color, background, product, and all other elements identical."

Return ONLY a JSON object:
{
  "adjusted_prompt": "the direct edit command for Gemini",
  "changes_summary": "brief 1-line description of what changed"
}`,
        });

        const claudeBody = {
          model: 'claude-sonnet-4-6',
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

        // Use Gemini for adjustment (same provider as main generation)
        let newImageUrl;
        if (isGeminiConfigured()) {
          // Fetch current image as base64 for Gemini
          const { base64, mediaType } = await resolveImage(creative.image_url);
          const inputImages = [{ base64, mimeType: mediaType }];
          const ratio = creative.aspect_ratio || '4:5';
          console.log(`[ai-adjust] Using Gemini for adjustment, ratio: ${ratio}`);
          const result = await editImage(adjustResult.adjusted_prompt, inputImages, ratio);
          // Store result
          if (isR2Configured()) {
            const r2Key = `statics-adjust/${crypto.randomUUID()}.png`;
            newImageUrl = await uploadBuffer(result.buffer, r2Key, result.mimeType);
          } else {
            const id = await storeTempImage(result.buffer, result.mimeType);
            const srvUrl = process.env.RENDER_EXTERNAL_URL || `http://localhost:${process.env.PORT || 3000}`;
            newImageUrl = `${srvUrl}/api/v1/statics-generation/tmp-img/${id}`;
          }
        } else {
          // Fallback to NanoBanana
          const httpImageUrl = await ensureHttpUrlGlobal(creative.image_url, 'adjust-ref');
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
          newImageUrl = await pollNanoBanana(taskId);
        }

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
      headlineRules: `HEADLINE ADAPTATION — TONE-MATCHING IS PRIORITY #1:
Before writing ANY headline, ANALYZE the reference ad's communication style:
- Is it aggressive/clickbait? ("Banks HATE this", "Doctors don't want you to know") → match that aggressive energy
- Is it a calm sale/promo? ("Spring Sale Ends Today", "Save 40%") → keep it calm and promotional, just swap the product details
- Is it testimonial/story? ("I lost 30 lbs in 2 months") → keep the personal story format
- Is it curiosity-driven? ("The secret to...") → keep the curiosity hook structure
- Is it urgency/scarcity? ("Only 50 left", "Ends tonight") → keep the urgency format

YOUR HEADLINE MUST MATCH THE REFERENCE'S TONE AND STRUCTURE. Do NOT turn a calm promo headline into aggressive clickbait. Do NOT turn an aggressive headline into a boring sale.

After matching tone, apply these product-specific rules:
- Use concrete numbers and specifics from product context — never vague platitudes
- NEVER use generic/weak phrases like "works at home", "easy to use", "get started today"
- NEVER use AI-sounding phrases: "game-changer", "revolutionary", "cutting-edge", "seamless"
- Match the approximate CHARACTER COUNT of the original headline (character count matters for layout fit)
- When the tone calls for bold claims, use real product data from PRODUCT CONTEXT (price, daily output, running cost, etc.)`,
      headlineExamples: `HEADLINE STYLE EXAMPLES (use these as inspiration, adapt to YOUR product — do NOT copy verbatim):
- "I Bought a [product price] [product] as a Joke — It's Paid for Itself 4x"
- "Tiny Device [key benefit] — No Experience Needed"
- "[Success story demographic] Started With This Exact [product type]"
- "Your [common expense] Hides a [realistic monthly return] Goldmine"
- "This [product form factor] [key result metric] Last Month on Autopilot"
- "Forget [traditional alternative] — This [key product action] 24/7"
NOTE: Fill in brackets using ONLY real data from PRODUCT CONTEXT above. Never invent numbers.`,
      pricingRules: `MANDATORY PRICING RULES (VIOLATION = FAILURE):
- Use the EXACT base price from PRODUCT CONTEXT above — do NOT invent or round prices
- Use the EXACT bundle/tier pricing from PRODUCT CONTEXT above (if bundles exist)
- Use the EXACT maximum discount percentage from PRODUCT CONTEXT above — NEVER exceed it
- Use the EXACT discount code from PRODUCT CONTEXT above. If the reference ad shows ANY other discount code, you MUST replace it with the code from PRODUCT CONTEXT
- NEVER write any price that is not explicitly listed in PRODUCT CONTEXT
- If the reference ad has a price, replace it with the CORRECT price from PRODUCT CONTEXT
- When in doubt, use the starting price or primary discount percentage from PRODUCT CONTEXT — do NOT invent prices`,
      productIdentity: `PRODUCT IDENTITY NOTE: Use the product name and description from PRODUCT CONTEXT above. NEVER describe the product using terms that contradict the product photos or PRODUCT CONTEXT. When describing product placement, use the product name exactly as given in PRODUCT CONTEXT. CRITICAL FOR IMAGE GENERATION: The image generator must COPY the product EXACTLY from the provided product photo — same physical shape, same screen content, same proportions. It must NOT generate its own interpretation of what the product looks like. The product photo is the ONLY source of truth for the product's appearance.`,
      bannedPhrases: `works at home, easy to use, get started today`,
      formulaPreservation: `FORMULA PRESERVATION:
Follow the SAME sentence rhythm, approximate character count, and rhetorical pattern as the original — but fill it with THIS product's real data.

STRUCTURE EXAMPLES (keep the pattern, swap the content):
Correct: "Bye Bye, Beer Belly" → "Bye Bye, [your product's pain point it solves]" (keeps "Bye Bye,")
Correct: "Kill The Bloated Belly" → "Kill The [obstacle your product removes]" (keeps "Kill The")
Correct: "3 Years of Back Pain Gone in 7 Days" → "3 Years of [customer problem] Gone in [timeframe]"
Wrong: "Bye Bye, Beer Belly" → "[Generic product pitch]" (completely different structure)

CRITICAL — PRODUCT DATA OVERRIDES GENERIC TEXT:
If the reference uses generic filler — DO NOT keep it. Replace with the product's ACTUAL claims from PRODUCT CONTEXT rewritten as CUSTOMER BENEFITS. NEVER paste raw technical specs — always frame data as benefits the customer cares about.
Generic labels like "SPECIAL DEAL", "FREE SHIPPING" → keep EXACTLY as-is — BUT discount codes MUST be replaced with the discount code from PRODUCT CONTEXT
- NEVER fabricate quantity claims like "4 FREE GIFTS" or "3 FREE BONUSES" by counting individual offer items from product context. If product context lists free shipping, warranty, etc., they are separate features — NOT "gifts" to count. Only use "X FREE GIFTS" if that exact claim exists in the product data.`,
      crossNicheAdaptation: `CROSS-NICHE VISUAL MAPPING:
Reference ads may come from any niche. Map visuals to YOUR product's context using PRODUCT CONTEXT above:
- Competitor product shots → Your product from the provided product photo
- Before/after comparisons → Product results progression or setup sequence
- Transformation imagery → Key metric improvement charts (use real data from PRODUCT CONTEXT)
- Ingredient/feature callouts → Your product's key feature callouts (from PRODUCT CONTEXT)
- Detail close-ups → Product detail close-ups showing key differentiating features
- Lifestyle/setting scenes → Scenes appropriate to where/how your product is used
- Authority/expert imagery → Relevant industry expert or authority imagery`,
      visualAdaptation: `For each visual element, specify what it should become for YOUR product (using PRODUCT CONTEXT above):
- Competitor product shots → Your product from the provided product photo
- Before/after comparisons → Product results or setup progression relevant to your product
- Transformation imagery → Key metric improvement charts using real product data
- Feature/ingredient callouts → Your product's actual feature callouts from PRODUCT CONTEXT
- Detail close-ups → Your product's distinguishing physical features
- Lifestyle/setting scenes → Scenes matching where/how your product is typically used`,
    },
    nanoBanana: {
      productRules: `PRODUCT REPLACEMENT:
- Remove ALL competitor branding, logos, product imagery
- COPY the product from the FIRST image EXACTLY — same physical shape, same screen content, same proportions, same colors. Do NOT redesign, reimagine, or generate your own version of the product. Treat the FIRST image as a cutout photo to paste in.
- Do NOT add logos or brand names onto the device screen — the screen must match what is shown in the FIRST image
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
3. Every text swap must be applied — copy the adapted text EXACTLY, letter by letter
4. TEXT FIDELITY: Render ONLY the text listed in the swap pairs. Do NOT add headlines, subheadlines, badges, banners, watermarks, or ANY text not in the swap list. If the swap list has 5 pairs, output must have EXACTLY 5 changed text elements — no more, no fewer
5. ALL TEXT NOT IN THE SWAP LIST must remain EXACTLY as it appears in the reference — letter-for-letter, same font, same position. Do NOT modify, rephrase, or misspell any unchanged text
6. Comparison labels, timeline labels, ingredient labels ALL get swapped
7. PRODUCT FIDELITY: The product in your output must be IDENTICAL to the FIRST image. Copy its exact shape, screen, colors, and proportions. Do NOT generate your own version — PASTE the product from the FIRST image.
8. Hands: exactly 5 fingers, realistic proportions
9. Match reference style, color palette, mood, and visual quality
10. PRICES MUST MATCH the text swap list EXACTLY — do not invent or modify any price, discount percentage, or dollar amount
11. BACKGROUND FIDELITY: The background must be a PIXEL-PERFECT match to the reference — same color, same gradient direction, same texture, same pattern. Do NOT simplify, flatten, or recolor the background. If the reference has a textured/patterned background, reproduce that exact texture/pattern
12. Do NOT add decorative elements (coins, sparkles, stars, glow effects) that are not in the reference
13. STAR RATINGS: If the reference shows star icons (★), reproduce the EXACT same number of stars. 5 stars stays 5 stars.`,
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
    // Escape $ in replacement value to prevent regex substitution codes
    const safeVal = String(val ?? '').replace(/\$/g, '$$$$');
    result = result.replace(new RegExp(`\\{${key.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\}`, 'g'), safeVal);
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

    // Date format: DD/MM (e.g., "08/04" for April 8)
    const now = new Date();
    const dateStr = `${String(now.getDate()).padStart(2, '0')}/${String(now.getMonth() + 1).padStart(2, '0')}`;
    const batchNum = Math.floor(Date.now() / 1000) % 10000;
    const results = [];

    // Helpers to safely parse JSONB that may come back as strings
    const safeArr = (v) => { if (Array.isArray(v)) return v; if (typeof v === 'string') { try { let p = JSON.parse(v); if (typeof p === 'string') p = JSON.parse(p); return Array.isArray(p) ? p : []; } catch { return []; } } return []; };
    const safeObj = (v) => { if (v && typeof v === 'object' && !Array.isArray(v)) return v; if (typeof v === 'string') { try { const p = JSON.parse(v); return (p && typeof p === 'object') ? p : {}; } catch { return {}; } } return {}; };

    // Round-robin page selection — at least one page required
    const selectedPages = safeArr(template.page_ids).filter(p => p.selected !== false);
    if (!selectedPages.length || !selectedPages[0]?.id) {
      await pgQuery(`UPDATE spy_creatives SET status = 'ready' WHERE id = ANY($1)`, [creative_ids]);
      return res.status(400).json({ success: false, error: { message: 'No Facebook pages configured in launch template. Edit the template and select at least one page.' } });
    }

    // Create a single adset for the batch — standard (non-dynamic) creative allows multiple ads per adset
    let adsetId = null;
    let adsetName = '';
    adsetName = buildLaunchName(template.adset_name_pattern || '{date} - Batch {batch}', {
      date: dateStr,
      angle: creatives[0]?.angle || 'General',
      batch: batchNum,
      product: creatives[0]?.product_name || '',
    });

    try {
      const normalizedCountries = (() => {
        const raw = safeArr(template.countries);
        const codes = raw.map(c => {
          if (typeof c === 'string') return c.trim().toUpperCase();
          if (c && typeof c === 'object') return (c.code || c.id || c.value || '').toString().trim().toUpperCase();
          return '';
        }).filter(c => /^[A-Z]{2}$/.test(c));
        console.log('[launch] raw countries from template:', JSON.stringify(template.countries), '→ parsed:', JSON.stringify(raw), '→ normalized:', JSON.stringify(codes));
        return codes.length ? codes : ['US'];
      })();

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
          countries: normalizedCountries,
          age_min: template.age_min,
          age_max: template.age_max,
          gender: template.gender,
          include_audiences: safeArr(template.include_audiences),
          exclude_audiences: safeArr(template.exclude_audiences),
        },
        attributionWindow: template.attribution_window,
        pageId: selectedPages[0]?.id,
        status: 'ACTIVE',
        startTime: template.schedule_enabled && template.schedule_date
          ? `${template.schedule_date}T${template.schedule_time || '00:00'}:00`
          : undefined,
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
        // Validate creative has an image
        if (!creative.image_url && !creative.meta_image_hash) {
          throw new Error(`Creative ${creative.id} has no image — cannot launch without an image`);
        }

        // Upload 4:5 image to Meta (reuse cached hash if available)
        let imageHashes = [];
        let imageHash = creative.meta_image_hash || null;
        if (creative.image_url) {
          if (imageHash) {
            imageHashes = [imageHash];
          } else {
            const uploadResult = await uploadAdImageFromUrl(template.ad_account_id, creative.image_url);
            if (!uploadResult?.hash) throw new Error('Image upload returned no hash');
            imageHash = uploadResult.hash;
            imageHashes = [imageHash];
          }
        }

        // Find and upload the 9:16 variant for stories/reels placements
        let verticalImageHash = null;
        const variants = await pgQuery(
          "SELECT id, image_url, meta_image_hash FROM spy_creatives WHERE parent_creative_id = $1 AND aspect_ratio = '9:16' AND status IN ('approved', 'ready') ORDER BY created_at DESC LIMIT 1",
          [creative.id]
        );
        if (variants.length && variants[0].image_url) {
          if (variants[0].meta_image_hash) {
            verticalImageHash = variants[0].meta_image_hash;
          } else {
            try {
              const vUpload = await uploadAdImageFromUrl(template.ad_account_id, variants[0].image_url);
              verticalImageHash = vUpload.hash;
              // Cache the hash for future launches
              await pgQuery('UPDATE spy_creatives SET meta_image_hash = $1, updated_at = NOW() WHERE id = $2', [vUpload.hash, variants[0].id]).catch(() => {});
            } catch (vErr) {
              console.warn(`[staticsGeneration] ⚠️ Failed to upload 9:16 variant (continuing with 4:5 only): ${vErr.message}`);
            }
          }
          console.log(`[staticsGeneration] 9:16 variant found for creative ${creative.id} — hash: ${verticalImageHash ? 'yes' : 'no'}`);
        } else {
          console.log(`[staticsGeneration] No 9:16 variant for creative ${creative.id} — using 4:5 for all placements`);
        }

        // Determine ad copy: copy set > generated_copy > fallbacks
        const genCopy = safeObj(creative.generated_copy);
        const csPrimaryTexts = safeArr(copySet?.primary_texts);
        const csHeadlines = safeArr(copySet?.headlines);
        const csDescriptions = safeArr(copySet?.descriptions);
        const primaryTexts = csPrimaryTexts.length
          ? csPrimaryTexts
          : safeArr(genCopy.primary_texts).length ? safeArr(genCopy.primary_texts)
          : [creative.source_label || 'Check this out'];
        const headlines = csHeadlines.length
          ? csHeadlines
          : safeArr(genCopy.headlines).length ? safeArr(genCopy.headlines)
          : [creative.angle || 'Shop Now'];
        const descriptions = csDescriptions.length
          ? csDescriptions
          : safeArr(genCopy.descriptions).length ? safeArr(genCopy.descriptions)
          : [''];
        const cta = copySet?.cta_button || genCopy.cta || 'SHOP_NOW';
        const link = copySet?.landing_page_url || template.landing_page_url || 'https://mineblock.com';

        // Create standard ad creative (non-dynamic, multiple ads per adset)
        const metaCreativeId = await createFlexibleAdCreative(template.ad_account_id, {
          name: adName,
          imageHashes,
          primaryTexts,
          headlines,
          descriptions,
          cta,
          link,
          pageId: page?.id || selectedPages[0]?.id,
          utmParameters: template.utm_parameters,
          verticalImageHash, // 9:16 for stories/reels, null if no variant exists
        });

        // Create the ad
        const metaAdId = await createAd(template.ad_account_id, {
          name: adName,
          adsetId,
          creativeId: metaCreativeId,
          status: 'ACTIVE',
        });

        // Build meta_ad_ids entry
        const metaEntry = {
          ad_id: metaAdId,
          creative_id: metaCreativeId,
          adset_id: adsetId,
          campaign_id: template.campaign_id,
          page_id: page?.id || selectedPages[0]?.id,
          ad_name: adName,
          launched_at: new Date().toISOString(),
        };
        const existingMeta = safeArr(creative.meta_ad_ids);
        existingMeta.push(metaEntry);

        // Update creative with launch tracking
        await pgQuery(
          `UPDATE spy_creatives SET status = 'launched', meta_ad_ids = $1, meta_image_hash = $2, updated_at = NOW() WHERE id = $3`,
          [JSON.stringify(existingMeta), imageHash, creative.id]
        );

        // Create audit log entry
        await pgQuery(
          `INSERT INTO statics_launches (creative_id, template_id, copy_set_id, ad_account_id, meta_campaign_id, meta_adset_id, meta_ad_id, meta_creative_id, meta_image_hash, ad_name, adset_name, page_id, page_name, batch_number, status, launched_at)
           VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,'launched',NOW())`,
          [creative.id, template_id, copy_set_id || null, template.ad_account_id, template.campaign_id, adsetId, metaAdId, metaCreativeId, imageHash, adName, adsetName, page?.id || null, page?.name || null, batchNum]
        ).catch(err => console.warn('[staticsGeneration] Failed to log launch:', err.message));

        // Also mark the 9:16 variant as launched if it was included
        if (variants.length && verticalImageHash) {
          await pgQuery(
            "UPDATE spy_creatives SET status = 'launched', updated_at = NOW() WHERE id = $1",
            [variants[0].id]
          ).catch(() => {});
        }

        results.push({ creative_id: creative.id, status: 'launched', meta_ad_id: metaAdId, ad_name: adName });
      } catch (err) {
        // Log failed launch attempt
        await pgQuery(
          `INSERT INTO statics_launches (creative_id, template_id, copy_set_id, ad_account_id, batch_number, status, error_message)
           VALUES ($1,$2,$3,$4,$5,'failed',$6)`,
          [creative.id, template_id, copy_set_id || null, template.ad_account_id, batchNum, err.message]
        ).catch(() => {});

        await pgQuery(
          `UPDATE spy_creatives SET status = 'ready', review_notes = $1, updated_at = NOW() WHERE id = $2`,
          [`Launch failed: ${err.message}`, creative.id]
        );
        results.push({ creative_id: creative.id, status: 'failed', error: err.message });
      }
    }

    // Reset any creatives still stuck in 'launching' (not reached by loop or skipped)
    await pgQuery(
      `UPDATE spy_creatives SET status = 'ready', review_notes = 'Launch interrupted — retryable' WHERE id = ANY($1) AND status = 'launching'`,
      [creative_ids]
    ).catch(() => {});

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

// ── GET /creatives/:id/launch-history — Launch audit log for a creative ──
router.get('/creatives/:id/launch-history', authenticate, async (req, res) => {
  try {
    const rows = await pgQuery(
      `SELECT * FROM statics_launches WHERE creative_id = $1 ORDER BY created_at DESC`,
      [req.params.id]
    ).catch(() => []);
    res.json({ success: true, data: rows });
  } catch (err) {
    res.status(500).json({ success: false, error: { message: err.message } });
  }
});

// ── POST /creatives/:id/link-copy-set — Link a copy set to a creative ──
router.post('/creatives/:id/link-copy-set', authenticate, async (req, res) => {
  try {
    const { copy_set_id } = req.body;
    await pgQuery(
      'UPDATE spy_creatives SET copy_set_id = $1, updated_at = NOW() WHERE id = $2',
      [copy_set_id || null, req.params.id]
    );
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ success: false, error: { message: err.message } });
  }
});

// ── Template Intelligence — deep analysis endpoints ──────────────────

// POST /statics/templates/:id/analyze — Analyze a single template
router.post('/templates/:id/analyze', authenticate, async (req, res) => {
  try {
    const rows = await pgQuery('SELECT * FROM statics_templates WHERE id = $1', [req.params.id]);
    if (rows.length === 0) return res.status(404).json({ success: false, error: { message: 'Template not found' } });
    const template = rows[0];
    const result = await analyzeTemplate(template);
    await pgQuery(
      'UPDATE statics_templates SET deep_analysis = $1, analyzed_at = NOW() WHERE id = $2',
      [JSON.stringify(result), req.params.id]
    );
    res.json({ success: true, analysis: result });
  } catch (err) {
    res.status(500).json({ success: false, error: { message: err.message } });
  }
});

// POST /statics/templates/analyze-all — Queue analysis for all stale/unanalyzed templates
// Track bulk analysis progress
let analyzeAllProgress = { running: false, total: 0, completed: 0, failed: 0, startedAt: null };

router.post('/templates/analyze-all', authenticate, async (req, res) => {
  try {
    if (analyzeAllProgress.running) {
      return res.json({ success: true, queued: 0, message: `Already running: ${analyzeAllProgress.completed}/${analyzeAllProgress.total} complete`, progress: analyzeAllProgress });
    }

    const rows = await pgQuery(
      `SELECT * FROM statics_templates WHERE is_hidden = false AND (deep_analysis IS NULL OR analyzed_at < NOW() - INTERVAL '30 days') ORDER BY created_at DESC`,
      []
    );
    if (rows.length === 0) return res.json({ success: true, queued: 0, message: 'All templates are up to date' });
    const count = rows.length;

    analyzeAllProgress = { running: true, total: count, completed: 0, failed: 0, startedAt: new Date().toISOString() };

    // Process in background — batches of 5 concurrently, using fast Haiku model
    (async () => {
      console.log(`[analyze-all] Starting bulk analysis: ${count} templates with Haiku vision`);
      for (let i = 0; i < rows.length; i += 5) {
        const batch = rows.slice(i, i + 5);
        await Promise.allSettled(
          batch.map(async (template) => {
            try {
              const analysis = await analyzeTemplateFast(template);
              await pgQuery(
                'UPDATE statics_templates SET deep_analysis = $1, analyzed_at = NOW() WHERE id = $2',
                [JSON.stringify(analysis), template.id]
              );
              analyzeAllProgress.completed++;
            } catch (err) {
              analyzeAllProgress.failed++;
              console.error(`[analyze-all] Failed ${template.id}: ${err.message}`);
            }
          })
        );
        // Progress log every 25 templates
        if ((i + 5) % 25 < 5) {
          console.log(`[analyze-all] Progress: ${analyzeAllProgress.completed + analyzeAllProgress.failed}/${count} (${analyzeAllProgress.completed} ok, ${analyzeAllProgress.failed} failed)`);
        }
      }
      console.log(`[analyze-all] Complete: ${analyzeAllProgress.completed}/${count} analyzed, ${analyzeAllProgress.failed} failed`);
      analyzeAllProgress.running = false;
    })();

    res.json({ success: true, queued: count, message: `Analysis started for ${count} templates (Haiku vision, batches of 5)` });
  } catch (err) {
    analyzeAllProgress.running = false;
    res.status(500).json({ success: false, error: { message: err.message } });
  }
});

// GET /templates/analyze-all/status — Check bulk analysis progress
router.get('/templates/analyze-all/status', authenticate, async (_req, res) => {
  res.json({ success: true, progress: analyzeAllProgress });
});

// GET /statics/templates/:id/analysis — Get analysis for a template
router.get('/templates/:id/analysis', authenticate, async (req, res) => {
  try {
    const rows = await pgQuery(
      'SELECT deep_analysis, analyzed_at FROM statics_templates WHERE id = $1',
      [req.params.id]
    );
    if (rows.length === 0) return res.status(404).json({ success: false, error: { message: 'Template not found' } });
    res.json({ success: true, deep_analysis: rows[0].deep_analysis, analyzed_at: rows[0].analyzed_at });
  } catch (err) {
    res.status(500).json({ success: false, error: { message: err.message } });
  }
});

// DELETE /statics/templates/:id — Delete a template and its associated images
router.delete('/templates/:id', authenticate, async (req, res) => {
  try {
    const rows = await pgQuery('SELECT * FROM statics_templates WHERE id = $1', [req.params.id]);
    if (rows.length === 0) return res.status(404).json({ success: false, error: { message: 'Template not found' } });
    const template = rows[0];
    // Clean up associated images from image_store if applicable
    if (template.image_url && template.image_url.includes('tmp-img')) {
      const match = template.image_url.match(/tmp-img\/([a-f0-9-]+)/i);
      if (match) {
        try {
          await pgQuery('DELETE FROM image_store WHERE id = $1', [match[1]]);
        } catch (imgErr) {
          console.warn(`[templates/:id delete] Could not clean up image ${match[1]}:`, imgErr.message);
        }
      }
    }
    await pgQuery('DELETE FROM statics_templates WHERE id = $1', [req.params.id]);
    res.json({ success: true, message: 'Template deleted' });
  } catch (err) {
    res.status(500).json({ success: false, error: { message: err.message } });
  }
});

export { getCustomStaticsPrompts, getDefaultStaticsPrompts };

export default router;
