// statics — 3-prompt architecture (migration 036)
//
// Pipeline:
//   1. Claude analysis (claude-opus-4-5) — sees ref + product, emits JSON brief
//   2. NanoBanana image (google/nano-banana-edit via Kie.ai) — sees ONLY product, generates ad
//   3. AI adjustment (optional) — Claude turns user correction into NB regen prompt
//
// All 3 prompts are admin-editable via /settings/prompts (stored in
// system_settings.value->'statics_prompts'). See migration 036 for defaults.
//
// DECISIONS made during rewrite (#5):
//   - Iteration routes (/iterations, /iterate/:creativeId, /iterate/:batchId/status)
//     re-implemented on the new 3-prompt pipeline:
//       /iterations  → winners SQL (no AI)
//       /iterate     → spawns N background variations (Claude + NanoBanana per variation),
//                       writes results back to spy_creatives rows keyed by batch_id
//       /iterate/:id/status → polls those rows
//   - Provider is hardcoded to 'nanobanana'. Gemini path deleted entirely.
//   - quality_warning column kept in INSERT shape but always written as null
//     from the new flow (column still exists in DB).
//   - compositeLogoWithSharp removed (only used in this file).
//   - Variant resize (generateVariant) preserved: just uses NanoBanana resize
//     prompt against the parent image.

import { Router } from 'express';
import {
  buildClaudeAnalysisPrompt,
  buildNanoBananaImagePrompt,
  buildAdjustmentPrompt,
  buildLayoutAnalysisPrompt,
  interpolate,
} from '../utils/staticsPrompts.js';
import { pgQuery } from '../db/pg.js';
import { authenticate } from '../middleware/auth.js';
import { requirePermission } from '../middleware/rbac.js';
import { uploadBuffer, uploadFromUrl, isR2Configured } from '../services/r2.js';

/**
 * NanoBanana returns a tempfile.aiquickdraw.com URL that expires after a few
 * hours. We must persist every result to R2 immediately, otherwise launched
 * creatives go black in the UI once Kie.ai purges the file.
 */
async function persistNanoBananaImage(tempUrl, prefix = 'statics-nb') {
  if (!tempUrl) return tempUrl;
  if (!isR2Configured()) {
    console.warn('[persistNbImage] R2 not configured — keeping temp URL (will expire!)');
    return tempUrl;
  }
  try {
    const { url } = await uploadFromUrl(tempUrl, prefix);
    return url;
  } catch (err) {
    console.warn(`[persistNbImage] R2 upload failed (${err.message}) — falling back to temp URL`);
    return tempUrl;
  }
}
import { submitToNanoBanana, pollNanoBanana } from '../services/imageGeneration.js';
import crypto from 'crypto';
import { analyzeTemplate, analyzeTemplateFast } from '../utils/templateAnalysis.js';
import sharp from 'sharp';
import {
  isMetaAdsConfigured, createAdSet, createFlexibleAdCreative, createAd,
  uploadAdImageFromUrl, diagnoseMetaApp, switchAppToLiveMode,
} from '../services/metaAdsApi.js';
import { sendSlackAlert } from '../utils/slackAlert.js';

const router = Router();

// ─────────────────────────────────────────────────────────────────────────
// Public (no auth) — must be defined BEFORE router.use(authenticate)
// ─────────────────────────────────────────────────────────────────────────

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

// ── Reset auto-reconciled / errored creatives — CRON_SECRET or JWT auth ──
router.post('/reset-failed', async (req, res) => {
  const cronSecret = process.env.CRON_SECRET;
  const provided = req.headers['x-cron-secret'];
  const authed = cronSecret && provided === cronSecret;
  if (!authed) {
    return authenticate(req, res, async () => { await _doResetFailed(res); });
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
           OR review_notes LIKE '%Variant resize failed%'
           OR review_notes IS NULL
         )
         AND parent_creative_id IS NOT NULL
       RETURNING id, angle, aspect_ratio, product_name`,
      []
    );
    const staleResult = await pgQuery(
      `UPDATE spy_creatives
       SET status = 'ready', review_notes = NULL, updated_at = NOW()
       WHERE status = 'generating'
         AND created_at < NOW() - INTERVAL '10 minutes'
         AND parent_creative_id IS NOT NULL
       RETURNING id, angle, aspect_ratio, product_name`,
      []
    );
    const all = [...result, ...staleResult];
    const diagnostic = await pgQuery(
      `SELECT id, status, angle, aspect_ratio, product_name, review_notes, created_at
       FROM spy_creatives WHERE parent_creative_id IS NOT NULL ORDER BY created_at DESC LIMIT 20`,
      []
    );
    console.log(`[staticsGeneration] reset-failed: reset ${all.length} creatives to ready (${result.length} rejected/error, ${staleResult.length} stale generating)`);
    res.json({ success: true, reset_count: all.length, creatives: all.map(r => ({ id: r.id, angle: r.angle, ratio: r.aspect_ratio, product: r.product_name })), diagnostic });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
}

// ── Trigger regeneration for all ready variant creatives — CRON_SECRET ──
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

// ─────────────────────────────────────────────────────────────────────────
// Task result store (in-memory) — keyed by taskId for /status/:taskId polling
// ─────────────────────────────────────────────────────────────────────────

const taskResults = new Map();
const TASK_RESULT_TTL = 15 * 60 * 1000;
const MAX_TASK_RESULTS = 200;

function storeTaskResult(taskId, result) {
  if (taskResults.size >= MAX_TASK_RESULTS) {
    const oldest = taskResults.keys().next().value;
    taskResults.delete(oldest);
  }
  taskResults.set(taskId, result);
  setTimeout(() => taskResults.delete(taskId), TASK_RESULT_TTL);
}

// Backwards-compat alias (some older code referenced storeGeminiResult / geminiResults)
const geminiResults = taskResults;
const storeGeminiResult = storeTaskResult;

// ─────────────────────────────────────────────────────────────────────────
// Generation monitoring (logGenerationEvent → statics_generation_events)
// ─────────────────────────────────────────────────────────────────────────

let lastQualityAlertAt = 0;
const QUALITY_ALERT_COOLDOWN_MS = 30 * 60 * 1000;

async function logGenerationEvent(event) {
  const {
    template_id, product_id, product_name, angle, provider,
    ratios, duration_ms, claude_ms, status, error_message, quality_warning, retry_count,
  } = event;

  pgQuery(
    `INSERT INTO statics_generation_events
       (template_id, product_id, product_name, angle, provider,
        ratios, duration_ms, claude_ms, status, error_message, quality_warning, retry_count)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12)`,
    [
      template_id || null, product_id || null, product_name || null, angle || null,
      provider || null,
      ratios ? ratios : null,
      duration_ms || null, claude_ms || null,
      status, error_message || null, quality_warning || null,
      retry_count || 0,
    ]
  ).catch(err => console.warn('[gen-monitor] DB log failed (non-blocking):', err.message));

  if (status === 'error' && error_message) {
    sendSlackAlert(`Generation failed: ${error_message}`, {
      level: 'error',
      source: 'statics-generation',
      fields: {
        Product: product_name || '—',
        Angle: angle || '—',
        Provider: provider || '—',
        Duration: duration_ms ? `${(duration_ms / 1000).toFixed(1)}s` : '—',
      },
    }).catch(() => {});
  }

  if (quality_warning && status !== 'error') {
    const now = Date.now();
    if (now - lastQualityAlertAt > QUALITY_ALERT_COOLDOWN_MS) {
      lastQualityAlertAt = now;
      sendSlackAlert(`Quality warning on generated ad`, {
        level: 'warn',
        source: 'statics-generation',
        fields: {
          Product: product_name || '—',
          Angle: angle || '—',
          Warning: quality_warning.slice(0, 200),
        },
      }).catch(() => {});
    }
  }
}

// ─────────────────────────────────────────────────────────────────────────
// Persistent image store (DB-backed, in-memory cache for speed)
// ─────────────────────────────────────────────────────────────────────────

const tempImages = new Map();
const TEMP_IMAGE_TTL = 30 * 60 * 1000;
const MAX_TEMP_IMAGES = 200;

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

(async () => {
  try {
    await pgQuery(`ALTER TABLE statics_templates ADD COLUMN IF NOT EXISTS deep_analysis JSONB`, []);
    await pgQuery(`ALTER TABLE statics_templates ADD COLUMN IF NOT EXISTS analyzed_at TIMESTAMPTZ`, []);
    console.log('[boot] statics_templates deep_analysis columns ensured');
  } catch (err) {
    console.warn('[boot] Could not add deep_analysis columns:', err.message);
  }
})();

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
}, 6 * 60 * 60 * 1000);

async function storeTempImage(buf, contentType) {
  if (tempImages.size >= MAX_TEMP_IMAGES) {
    const oldest = tempImages.keys().next().value;
    tempImages.delete(oldest);
  }
  const id = crypto.randomUUID();
  tempImages.set(id, { buf, contentType });
  setTimeout(() => tempImages.delete(id), TEMP_IMAGE_TTL);
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

// ── Playwright Diagnostic (legacy, kept for ops) ──
router.get('/playwright-test', authenticate, async (req, res) => {
  // Playwright path was removed in the 3-prompt rewrite. Endpoint preserved
  // so existing monitoring/curl checks don't 404.
  res.json({ success: true, message: 'Playwright path removed in 3-prompt rewrite — endpoint is a no-op stub' });
});

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

// ─────────────────────────────────────────────────────────────────────────
// API / pipeline constants and helpers
// ─────────────────────────────────────────────────────────────────────────

const ANTHROPIC_API_KEY  = process.env.ANTHROPIC_API_KEY || '';
const NANOBANANA_API_KEY = process.env.NANOBANANA_API_KEY || '';
const CLAUDE_API_URL     = 'https://api.anthropic.com/v1/messages';
const CLAUDE_MODEL       = 'claude-opus-4-5';

function detectMime(buf) {
  if (buf[0] === 0xFF && buf[1] === 0xD8 && buf[2] === 0xFF) return 'image/jpeg';
  if (buf[0] === 0x89 && buf[1] === 0x50 && buf[2] === 0x4E && buf[3] === 0x47) return 'image/png';
  if (
    buf[0] === 0x52 && buf[1] === 0x49 && buf[2] === 0x46 && buf[3] === 0x46 &&
    buf[8] === 0x57 && buf[9] === 0x45 && buf[10] === 0x42 && buf[11] === 0x50
  ) return 'image/webp';
  return 'image/jpeg';
}

async function resolveImage(referenceImageUrl) {
  if (!referenceImageUrl) throw new Error('resolveImage: empty URL');
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

const CLAUDE_IMAGE_LIMIT_BYTES = 4 * 1024 * 1024;

async function shrinkForClaude(base64, mediaType) {
  const rawBytes = Math.ceil(base64.length * 0.75);
  if (rawBytes <= CLAUDE_IMAGE_LIMIT_BYTES) return { base64, mediaType };

  let quality = 80;
  const buf = Buffer.from(base64, 'base64');
  while (quality >= 30) {
    const compressed = await sharp(buf).jpeg({ quality }).toBuffer();
    const b64 = compressed.toString('base64');
    if (b64.length * 0.75 <= CLAUDE_IMAGE_LIMIT_BYTES) {
      console.log(`[shrinkForClaude] Compressed image to JPEG q${quality}: ${(compressed.length / 1024).toFixed(0)} KB`);
      return { base64: b64, mediaType: 'image/jpeg' };
    }
    quality -= 15;
  }
  const scaled = await sharp(buf).resize({ width: 1024 }).jpeg({ quality: 60 }).toBuffer();
  console.log(`[shrinkForClaude] Scaled down to 1024px: ${(scaled.length / 1024).toFixed(0)} KB`);
  return { base64: scaled.toString('base64'), mediaType: 'image/jpeg' };
}

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

// ─────────────────────────────────────────────────────────────────────────
// Statics prompt settings (3-prompt architecture)
// ─────────────────────────────────────────────────────────────────────────

const STATICS_PROMPT_KEYS = ['claude_analysis', 'nanobanana_image', 'ai_adjustment'];

const STATICS_PROMPT_TYPES = [
  { key: 'claude_analysis',   label: 'Step 1 — Claude Analysis',  description: 'Claude sees ref + product, emits JSON brief' },
  { key: 'nanobanana_image',  label: 'Step 2 — NanoBanana Image', description: 'NanoBanana sees only product image, generates ad' },
  { key: 'ai_adjustment',     label: 'Step 3 — AI Adjustment',    description: 'Claude turns freeform correction into NB regen prompt' },
];

let staticsPromptsCache = { data: null, timestamp: 0 };
const STATICS_CACHE_TTL = 5 * 60 * 1000;

function getDefaultStaticsPrompts() {
  return {
    claude_analysis:
`You are an expert ad creative analyst. Analyze this reference ad image and adapt it for our product.

FORMULA PRESERVATION: Keep exact sentence structure, opening words, word counts per text element.
TEXT EXTRACTION: Only extract ACTUALLY VISIBLE text from the image. Do NOT extract text from product labels — only text that is overlaid on the scene as ad copy.
LAYOUT CAPTURE: Describe the full scene in detail — background color/texture, product position, props, lighting, composition. This description will be used to recreate the layout.
CHARACTER RULES: Count people in original — new image must match exactly.
PRODUCT DETECTION: Set reference_has_product_visual to true if the reference ad features ANY physical product as a main visual element — including: bottle, jar, box, package, pill, container, supplement, wearable device, neck brace, knee wrap, foot pad, LED device, gadget, appliance, tool, or any physical object being held or displayed. Set false ONLY if the ad is purely text/infographic/checklist/screenshot/social-post style with absolutely no physical product or object visible.
PRODUCT SWAP: Describe where the competitor product sits in the scene (position, size, angle, quantity). Our product will be placed there.

Product: {{PRODUCT_NAME}}
Price: {{PRODUCT_PRICE}}
Description: {{PRODUCT_DESCRIPTION}}
Angle: {{ANGLE}}
Brand Voice: {{BRAND_VOICE}}
Customer: {{CUSTOMER}}
Big Promise: {{BIG_PROMISE}}
Differentiator: {{DIFFERENTIATOR}}
Unique Mechanism: {{UNIQUE_MECHANISM}}
Key Benefits: {{KEY_BENEFITS}}
Target Audience: {{TARGET_AUDIENCE}}
Pain Points: {{PAIN_POINTS}}
Ingredients: {{INGREDIENTS}}
Winning Angles: {{WINNING_ANGLES}}
Objections to handle: {{OBJECTIONS}}
Offer: {{OFFER_HOOK}}
Pricing: {{PRICING}}
Compliance — never claim: {{COMPLIANCE}}{{PRODUCT_IMAGE_NOTE}}

Analyze the reference image and respond in valid JSON only:
{
  "original_text": { "headline": "...", "subheadline": "...", "body": "...", "cta": "...", "badges": [], "bullets": [] },
  "adapted_text": { "headline": "...", "subheadline": "...", "body": "...", "cta": "...", "badges": [], "bullets": [] },
  "people_count": 0,
  "character_adaptation": "...",
  "reference_has_product_visual": true,
  "background": "Describe the background in detail: color, texture, gradient, props, lighting, atmosphere",
  "composition": "Describe the full layout: where is the product, where is text, where are people, spatial arrangement",
  "visual_adaptations": [
    { "original_visual": "describe the scene element to change", "adapted_visual": "describe the adapted version for our product/angle", "position": "center" }
  ],
  "product_visual_for_generation": "Write a precise 2-3 sentence image-generation prompt describing EXACTLY how to render our product visually. Focus on the PRODUCT OBJECT ITSELF — its shape, size, primary colors, key text/logo, and any distinctive design features. Ignore any people, lifestyle settings, or scenes. If IMAGE 2 shows the product being used (e.g. worn on body), describe only the device/product portion. Example for a device: 'Red flexible silicone foot wrap with embedded LED lights. Bold black text LumaFoot Pro on top surface, red and white color scheme. Approximately 10cm x 15cm flat pad shape.' Example for a bottle: 'Black cylindrical 250ml bottle. White label with red logo top-center, flame icon, three benefit icons in a row. Glossy finish with gold cap.' This text is fed directly to an image generator — make it self-contained and precise."
}`,

    nanobanana_image:
`Generate an ad image for {{PRODUCT_NAME}}.

{{PRODUCT_INSTRUCTION}}

2. SCENE & LAYOUT (recreate this exact composition):
   {{VISUAL_CHANGES}}

3. TEXT ELEMENTS (render as styled overlays matching the reference ad style):
   {{TEXT_SWAPS}}

4. CHARACTERS:
   - EXACTLY {{PEOPLE_COUNT}} people visible (if original had none, keep none)
   - {{CHARACTER_ADAPTATION}}

ABSOLUTE RULES:
{{PRODUCT_RULE}}
- Zero extra faces or people beyond {{PEOPLE_COUNT}}
- Zero extra text elements beyond what is listed above
- Hands must have 5 fingers with realistic anatomy
- Same overall image dimensions and safe zones`,

    ai_adjustment:
`You are an expert ad creative director. You generated an ad image and the user wants a specific adjustment.

CURRENT AD DETAILS:
Product: {{PRODUCT_NAME}}
Angle: {{ANGLE}}
Adapted headline: "{{ADAPTED_HEADLINE}}"
Adapted CTA: "{{ADAPTED_CTA}}"
People in ad: {{PEOPLE_COUNT}}

USER CORRECTION: "{{USER_CORRECTION}}"

Your task: Write a concise, precise NanoBanana image generation prompt CORRECTION that incorporates the user's adjustment while preserving everything else about the ad.

The correction should:
- Address ONLY what the user asked to change
- Keep the same layout, composition, fonts, colors, and brand identity
- Keep the same text content unless user specifically asked to change text
- Keep the same number of people ({{PEOPLE_COUNT}})
- Be specific and actionable for an image generation AI

Respond with a JSON object:
{
  "adjustment_instruction": "A precise 2-4 sentence instruction describing the specific change to make",
  "preserve_note": "What must stay exactly the same"
}`,
  };
}

function isValidPromptsShape(obj) {
  if (!obj || typeof obj !== 'object') return false;
  for (const k of STATICS_PROMPT_KEYS) {
    if (typeof obj[k] !== 'string' || !obj[k].trim()) return false;
  }
  return true;
}

async function getCustomStaticsPrompts() {
  if (staticsPromptsCache.data && Date.now() - staticsPromptsCache.timestamp < STATICS_CACHE_TTL) {
    return staticsPromptsCache.data;
  }
  try {
    const rows = await pgQuery(`SELECT value FROM system_settings WHERE key = 'statics_prompts'`);
    let data = rows.length ? (typeof rows[0].value === 'string' ? JSON.parse(rows[0].value) : rows[0].value) : null;
    if (!isValidPromptsShape(data)) {
      // Legacy shape (e.g. old { claudeAnalysis: {...}, nanoBanana: {...} }) → fall back to defaults
      if (data) console.warn('[staticsPrompts] DB row exists but does not match 3-prompt shape — falling back to defaults');
      data = getDefaultStaticsPrompts();
    }
    staticsPromptsCache = { data, timestamp: Date.now() };
    return data;
  } catch (err) {
    console.warn('[staticsPrompts] DB read failed, returning defaults:', err.message);
    return getDefaultStaticsPrompts();
  }
}

// ─────────────────────────────────────────────────────────────────────────
// Layout analysis (one-time per template, cached in DB) — kept for templates UI
// ─────────────────────────────────────────────────────────────────────────

async function analyzeAndCacheLayout(templateId, imageUrl) {
  try {
    const { base64, mediaType } = await resolveImage(imageUrl);
    const promptText = buildLayoutAnalysisPrompt();

    const res = await fetch(CLAUDE_API_URL, {
      method: 'POST',
      headers: {
        'x-api-key': ANTHROPIC_API_KEY,
        'anthropic-version': '2023-06-01',
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        model: CLAUDE_MODEL,
        max_tokens: 1500,
        messages: [{
          role: 'user',
          content: [
            { type: 'text', text: promptText },
            { type: 'image', source: { type: 'base64', media_type: mediaType, data: base64 } },
          ],
        }],
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
    try { layoutMap = JSON.parse(jsonMatch[0]); }
    catch { layoutMap = JSON.parse(jsonMatch[0].replace(/,\s*([}\]])/g, '$1')); }

    await pgQuery(
      `UPDATE statics_templates
       SET metadata = jsonb_set(
               CASE WHEN metadata IS NULL OR jsonb_typeof(metadata) != 'object' THEN '{}'::jsonb ELSE metadata END,
               '{layout_map}', $1::jsonb),
           updated_at = NOW()
       WHERE id = $2`,
      [JSON.stringify(layoutMap), templateId]
    );

    console.log(`[staticsGeneration] ✅ Layout map cached for template ${templateId} (archetype: ${layoutMap.archetype})`);
    return layoutMap;
  } catch (err) {
    console.error(`[staticsGeneration] Layout analysis failed for template ${templateId}:`, err.message);
    return null;
  }
}

// ─────────────────────────────────────────────────────────────────────────
// POST /generate — 3-step pipeline
//
//   Step 1: Claude analysis (sees ref + product → JSON brief)
//   Step 2: NanoBanana image (sees ONLY product → generates ad)
//   Step 3: (separate route) AI adjustment
//
// Returns IMMEDIATELY with a taskId and runs the pipeline in setImmediate.
// Client polls GET /status/:taskId.
// ─────────────────────────────────────────────────────────────────────────

router.post('/generate', authenticate, async (req, res) => {
  const reqRefImage = req.body.reference_image_url;
  const reqProduct  = req.body.product;
  if (!reqRefImage) return res.status(400).json({ success: false, error: 'reference_image_url is required' });
  if (!reqProduct)  return res.status(400).json({ success: false, error: 'product is required' });

  // Pre-allocate a taskId and respond IMMEDIATELY — avoids proxy-timeout 502s.
  const earlyTaskId = `gen-${crypto.randomUUID()}`;
  const earlyTask = { taskId: earlyTaskId, ratio: req.body.ratio || '4:5' };
  storeTaskResult(earlyTaskId, { status: 'processing', progress: 'Analyzing reference image...' });
  res.json({ success: true, data: { taskId: earlyTaskId, tasks: [earlyTask], provider: 'nanobanana', status: 'processing' } });

  // Watchdog: if the pipeline hangs, mark task as error after 8 minutes.
  const watchdog = setTimeout(() => {
    const cur = taskResults.get(earlyTaskId);
    if (cur && cur.status === 'processing') {
      console.error(`[staticsGeneration] Watchdog fired for ${earlyTaskId} — still processing after 8m, marking as error`);
      storeTaskResult(earlyTaskId, { status: 'error', error: 'Generation exceeded 8-minute limit (pipeline hang)' });
    }
  }, 8 * 60 * 1000);

  setImmediate(async () => {
    const pipelineStart = Date.now();
    try {
      const { reference_image_url, angle, angle_data, ratio, template_id } = req.body;
      let product = req.body.product;

      // ── DB re-fetch of product profile (authoritative source) ──
      const productDbId = req.body.product_id || product?.id;
      if (productDbId) {
        try {
          const prodRows = await pgQuery('SELECT * FROM product_profiles WHERE id = $1', [productDbId]);
          if (prodRows.length > 0) {
            const p = prodRows[0];
            const freshProfile = {
              oneliner: p.oneliner || undefined,
              tagline: p.tagline || undefined,
              customerAvatar: p.customer_avatar || undefined,
              customerFrustration: p.customer_frustration || undefined,
              customerDream: p.customer_dream || undefined,
              bigPromise: p.big_promise || undefined,
              mechanism: p.mechanism || undefined,
              differentiator: p.differentiator || undefined,
              voice: p.voice || undefined,
              guarantee: p.guarantee || undefined,
              benefits: p.benefits || undefined,
              painPoints: p.pain_points || undefined,
              commonObjections: p.common_objections || undefined,
              winningAngles: p.winning_angles || undefined,
              customAngles: p.custom_angles_text || undefined,
              competitiveEdge: p.competitive_edge || undefined,
              offerDetails: p.offer_details || undefined,
              maxDiscount: p.max_discount || undefined,
              discountCodes: p.discount_codes || undefined,
              bundleVariants: p.bundle_variants || undefined,
              complianceRestrictions: p.compliance_restrictions || undefined,
              notes: p.notes || undefined,
              targetDemographics: p.target_demographics || undefined,
              category: p.category || undefined,
              productType: p.product_type || undefined,
              productUrl: p.product_url || undefined,
              unitDetails: p.unit_details || undefined,
              shortName: p.short_name || undefined,
              offers: p.offers?.length > 0 ? p.offers : undefined,
            };
            Object.keys(freshProfile).forEach(k => freshProfile[k] === undefined && delete freshProfile[k]);

            product = {
              ...product,
              name: p.name || product.name,
              description: p.description || product.description,
              price: p.price || product.price,
              profile: freshProfile,
            };
            console.log(`[staticsGeneration] ✅ DB re-fetch: "${p.name}" — ${Object.keys(freshProfile).length} profile fields`);
          }
        } catch (dbErr) {
          console.warn(`[staticsGeneration] ⚠️ DB re-fetch failed (using client data):`, dbErr.message);
        }
      }

      // Map profile to the flat fields the prompt builder expects
      const profileForPrompt = {
        product_name:      product.name,
        price:             product.price,
        description:       product.description,
        brand_voice:       product.profile?.voice || '',
        customer:          product.profile?.customerAvatar || '',
        big_promise:       product.profile?.bigPromise || '',
        differentiator:    product.profile?.differentiator || '',
        unique_mechanism:  product.profile?.mechanism || '',
        key_benefits:      product.profile?.benefits || '',
        target_audience:   product.profile?.targetDemographics || product.profile?.customerAvatar || '',
        pain_points:       product.profile?.painPoints || '',
        ingredients:       product.profile?.ingredients || '',
        winning_angles:    product.profile?.winningAngles || '',
        objections:        product.profile?.commonObjections || '',
        offer_hook:        product.profile?.offerDetails || '',
        pricing:           product.profile?.bundleVariants || product.price || '',
        compliance:        product.profile?.complianceRestrictions || '',
      };
      const productForPrompt = { ...product, profile: profileForPrompt };

      // ── Pre-fetch: prompts + reference image (parallel) ──
      storeTaskResult(earlyTaskId, { status: 'processing', progress: 'Reading reference image...' });
      const [customPrompts, { base64, mediaType }] = await Promise.all([
        getCustomStaticsPrompts(),
        (async () => {
          const { base64: rawB64, mediaType: rawMt } = await resolveImage(reference_image_url);
          return shrinkForClaude(rawB64, rawMt);
        })(),
      ]);

      // Optionally include product image in Claude vision (helps with product_visual_for_generation)
      let productImageMsg = null;
      let productImageNote = '';
      if (product.product_image_url) {
        try {
          const { base64: pb64, mediaType: pmt } = await resolveImage(product.product_image_url);
          const shrunk = await shrinkForClaude(pb64, pmt);
          productImageMsg = { type: 'image', source: { type: 'base64', media_type: shrunk.mediaType, data: shrunk.base64 } };
          productImageNote = '\n\nIMAGE 2 (second image) is the PRODUCT we are advertising. Use it as the visual source of truth for product_visual_for_generation.';
        } catch (e) {
          console.warn(`[staticsGeneration] Could not resolve product image for Claude vision: ${e.message}`);
        }
      }

      // ── STEP 1: Claude analysis ──
      storeTaskResult(earlyTaskId, { status: 'processing', progress: 'Analyzing reference with Claude...' });
      const claudePromptText = buildClaudeAnalysisPrompt(
        productForPrompt,
        angle_data?.name || angle || '',
        customPrompts.claude_analysis,
        { PRODUCT_IMAGE_NOTE: productImageNote },
      );

      const claudeContent = [
        { type: 'text', text: claudePromptText },
        { type: 'image', source: { type: 'base64', media_type: mediaType, data: base64 } },
      ];
      if (productImageMsg) claudeContent.push(productImageMsg);

      const tClaude = Date.now();
      const claudeRes = await fetch(CLAUDE_API_URL, {
        method: 'POST',
        headers: {
          'x-api-key': ANTHROPIC_API_KEY,
          'anthropic-version': '2023-06-01',
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          model: CLAUDE_MODEL,
          max_tokens: 3000,
          messages: [{ role: 'user', content: claudeContent }],
        }),
      });

      if (!claudeRes.ok) {
        const errText = await claudeRes.text();
        throw new Error(`Claude API error ${claudeRes.status}: ${errText.slice(0, 500)}`);
      }
      const claudeData = await claudeRes.json();
      const claudeMs = Date.now() - tClaude;
      const rawText = claudeData.content?.[0]?.text;
      if (!rawText) throw new Error('Empty response from Claude');

      const jsonMatch = rawText.match(/\{[\s\S]*\}/);
      if (!jsonMatch) throw new Error('Could not parse JSON from Claude response');

      let claudeResult;
      try {
        claudeResult = JSON.parse(jsonMatch[0]);
      } catch (parseErr) {
        // Repair common issues: trailing commas, unbalanced braces
        let fixable = jsonMatch[0].replace(/,\s*([}\]])/g, '$1');
        const opens  = (fixable.match(/\{/g) || []).length;
        const closes = (fixable.match(/\}/g) || []).length;
        for (let i = 0; i < opens - closes; i++) fixable += '}';
        try { claudeResult = JSON.parse(fixable); }
        catch { throw new Error(`Failed to parse Claude JSON: ${parseErr.message}`); }
      }
      console.log(`[staticsGeneration] ⏱ Claude finished in ${claudeMs}ms`);

      // ── STEP 2: NanoBanana image (parallel across ratios) ──
      // Per friend's architecture: NanoBanana receives ONLY the product image.
      // The composition is reconstructed from Claude's description.
      const productHttpUrl = product.product_image_url
        ? await ensureHttpUrlGlobal(product.product_image_url, 'products')
        : null;

      if (!productHttpUrl) {
        throw new Error('No product_image_url available — NanoBanana requires a product image as the sole input');
      }

      const nbPrompt = buildNanoBananaImagePrompt(claudeResult, product, customPrompts.nanobanana_image);
      console.log(`[staticsGeneration] NanoBanana prompt (${nbPrompt.length} chars):\n${nbPrompt.slice(0, 800)}${nbPrompt.length > 800 ? '...[truncated]' : ''}`);

      // 'all' (the UI default for "generate every aspect ratio") expands to the
      // canonical 3. Falsy or 'all' → 3 ratios. Any specific ratio → just that one.
      const ALL_RATIOS = ['1:1', '4:5', '9:16'];
      const ratiosToGenerate = (!ratio || ratio === 'all') ? ALL_RATIOS : [ratio];
      storeTaskResult(earlyTaskId, { status: 'processing', progress: `Generating ${ratiosToGenerate.length} ratio(s)...` });

      async function runOneRatio(r) {
        const ratioStart = Date.now();
        const nbTaskId = await submitToNanoBanana(nbPrompt, [productHttpUrl], r);
        console.log(`[staticsGeneration] NanoBanana ${r} submitted: ${nbTaskId}`);
        const tempUrl = await pollNanoBanana(nbTaskId);
        const resultImageUrl = await persistNanoBananaImage(tempUrl, `statics-generated/${r}`);
        console.log(`[staticsGeneration] ⏱ NanoBanana ${r} done in ${Date.now() - ratioStart}ms (persisted: ${resultImageUrl !== tempUrl ? 'R2' : 'temp'})`);

        const childTaskId = `nb-${crypto.randomUUID()}`;
        storeTaskResult(childTaskId, {
          status: 'completed',
          resultImageUrl,
          provider: 'nanobanana',
          model: 'google/nano-banana-edit',
          claudeAnalysis: claudeResult,
          quality_warning: null,
        });
        return { taskId: childTaskId, ratio: r, resultImageUrl };
      }

      const ratioResults = await Promise.allSettled(ratiosToGenerate.map(runOneRatio));
      const tasks = ratioResults
        .filter(r => r.status === 'fulfilled')
        .map(r => r.value);
      ratioResults.filter(r => r.status === 'rejected').forEach((r, i) =>
        console.error(`[staticsGeneration] NanoBanana ${ratiosToGenerate[i]} failed: ${r.reason?.message}`)
      );

      if (tasks.length === 0) {
        const firstErr = ratioResults.find(r => r.status === 'rejected')?.reason?.message || 'All ratios failed';
        throw new Error(`All NanoBanana ratios failed: ${firstErr}`);
      }

      storeTaskResult(earlyTaskId, {
        status: 'completed',
        tasks,
        provider: 'nanobanana',
        claudeAnalysis: claudeResult,
        swapPairs: [],
      });

      logGenerationEvent({
        template_id: template_id || null,
        product_id: product?.id || null,
        product_name: product?.name || null,
        angle: angle_data?.name || angle || null,
        provider: 'nanobanana',
        ratios: tasks.map(t => t.ratio),
        duration_ms: Date.now() - pipelineStart,
        claude_ms: claudeMs,
        status: 'success',
        quality_warning: null,
      });

      console.log(`[staticsGeneration] ✅ Generation complete for ${earlyTaskId} — ${tasks.length} ratio(s) in ${Date.now() - pipelineStart}ms`);
    } catch (err) {
      console.error(`[staticsGeneration] Pipeline failed for ${earlyTaskId}:`, err);
      storeTaskResult(earlyTaskId, { status: 'error', error: err.message });
      logGenerationEvent({
        template_id: req.body.template_id || null,
        product_id: req.body.product?.id || null,
        product_name: req.body.product?.name || null,
        angle: req.body.angle_data?.name || req.body.angle || null,
        provider: 'nanobanana',
        ratios: [req.body.ratio || '4:5'],
        duration_ms: Date.now() - pipelineStart,
        claude_ms: null,
        status: 'error',
        error_message: err.message,
        quality_warning: null,
      });
    } finally {
      clearTimeout(watchdog);
    }
  });
});

// ─────────────────────────────────────────────────────────────────────────
// GET /status/:taskId — Poll for generation result
// ─────────────────────────────────────────────────────────────────────────

router.get('/status/:taskId', authenticate, async (req, res) => {
  try {
    const { taskId } = req.params;
    if (!taskId) return res.status(400).json({ success: false, error: 'taskId is required' });

    res.set('Cache-Control', 'no-store, no-cache, must-revalidate');
    res.set('Pragma', 'no-cache');

    const result = taskResults.get(taskId);
    if (result) {
      if (result.status === 'processing') {
        return res.json({ success: true, data: { taskId, status: 'processing', progress: result.progress || 'Generating...' } });
      }
      if (result.status === 'error') {
        return res.json({ success: true, data: { taskId, status: 'failed', error: result.error } });
      }
      return res.json({
        success: true,
        data: {
          taskId,
          status: result.status,
          successFlag: result.status === 'completed',
          resultImageUrl: result.resultImageUrl,
          tasks: result.tasks || null,
          provider: result.provider,
          model: result.model,
          claudeAnalysis: result.claudeAnalysis || null,
          error: result.error || null,
          quality_warning: result.quality_warning || null,
        },
      });
    }

    // Task expired (server restart or TTL)
    if (taskId.startsWith('gen-') || taskId.startsWith('nb-')) {
      return res.json({ success: true, data: { taskId, status: 'failed', error: 'Generation expired (server restarted or TTL). Please retry.' } });
    }

    return res.json({ success: true, data: { taskId, status: 'failed', error: 'Unknown taskId' } });
  } catch (err) {
    console.error('[staticsGeneration] /status error:', err);
    return res.status(500).json({ success: false, error: err.message });
  }
});

// ─────────────────────────────────────────────────────────────────────────
// ITERATIONS — re-implemented on the 3-prompt pipeline.
//   GET  /iterations                  → winners from creative_analysis
//   POST /iterate/:creativeId         → spawn N background NanoBanana variations
//   GET  /iterate/:batchId/status     → poll the spawned batch
// ─────────────────────────────────────────────────────────────────────────

const WINNER_MIN_SPEND = 50;
const WINNER_MIN_ROAS  = 1.5;

// Variation tweaks — injected into each iteration's Claude analysis to bias
// the AI toward a different emotional/structural angle while keeping the
// proven hook and product intact.
const VARIATION_TWEAKS = [
  'Test a sharper, more direct emotional hook in the headline (same angle, stronger language).',
  'Test a punchier subheadline + tighter bullets (same story, fewer words).',
  'Test a more curiosity-driven headline (lead with a question or contrarian claim).',
  'Test a stronger urgency / scarcity framing in the copy.',
  'Test a more specific number / proof point in the headline (replace abstract claims with concrete data).',
];

/**
 * Allocate the next IM sequence number (atomic, single-row-locked).
 */
async function assignNextImNumber() {
  const rows = await pgQuery(`
    UPDATE statics_im_counter
    SET next_number = next_number + 1
    WHERE id = 1
    RETURNING next_number - 1 AS assigned
  `);
  if (!rows || rows.length === 0) {
    throw new Error('statics_im_counter row missing — bootstrap failed');
  }
  return rows[0].assigned;
}

router.get('/iterations', authenticate, async (req, res) => {
  try {
    await ensureCreativesTable();
    const minSpend   = parseFloat(req.query.minSpend)  || WINNER_MIN_SPEND;
    const minRoas    = parseFloat(req.query.minRoas)   || WINNER_MIN_ROAS;
    const windowDays = parseInt(req.query.windowDays)  || 30;

    const rows = await pgQuery(`
      WITH agg AS (
        SELECT
          ca.creative_id,
          SUM(ca.spend) AS spend,
          SUM(ca.revenue) AS revenue,
          SUM(ca.purchases) AS purchases,
          SUM(ca.impressions) AS impressions,
          SUM(ca.clicks) AS clicks,
          MAX(ca.synced_at) AS latest_synced_at,
          MAX(ca.iterated_at) AS iterated_at
        FROM creative_analysis ca
        WHERE ca.type = 'image'
          AND ca.synced_at >= NOW() - ($1 || ' days')::INTERVAL
        GROUP BY ca.creative_id
      ),
      best_hook AS (
        SELECT DISTINCT ON (ca.creative_id)
          ca.creative_id, ca.ad_name, ca.hook_id, ca.avatar, ca.angle, ca.editor,
          ca.week, ca.thumbnail_url, ca.meta_ad_id, ca.roas AS hook_roas,
          ca.cpa AS hook_cpa, ca.ctr AS hook_ctr, ca.spend AS hook_spend
        FROM creative_analysis ca
        WHERE ca.type = 'image' AND ca.thumbnail_url IS NOT NULL
        ORDER BY ca.creative_id, ca.spend DESC
      )
      SELECT
        agg.creative_id,
        agg.spend::FLOAT AS spend,
        agg.revenue::FLOAT AS revenue,
        (CASE WHEN agg.spend > 0 THEN (agg.revenue / agg.spend)::FLOAT ELSE 0 END) AS roas,
        (CASE WHEN agg.purchases > 0 THEN (agg.spend / agg.purchases)::FLOAT ELSE 0 END) AS cpa,
        agg.purchases, agg.impressions::BIGINT AS impressions, agg.clicks::BIGINT AS clicks,
        agg.latest_synced_at, agg.iterated_at,
        bh.ad_name, bh.hook_id, bh.avatar, bh.angle, bh.editor, bh.week,
        bh.thumbnail_url, bh.meta_ad_id, bh.hook_roas::FLOAT AS best_hook_roas,
        bh.hook_cpa::FLOAT AS best_hook_cpa, bh.hook_ctr::FLOAT AS best_hook_ctr,
        (SELECT COUNT(*) FROM spy_creatives WHERE parent_creative_id_ref = agg.creative_id) AS iteration_count
      FROM agg
      JOIN best_hook bh ON bh.creative_id = agg.creative_id
      WHERE agg.spend >= $2
        AND (CASE WHEN agg.spend > 0 THEN agg.revenue / agg.spend ELSE 0 END) >= $3
      ORDER BY (CASE WHEN agg.spend > 0 THEN agg.revenue / agg.spend ELSE 0 END) DESC, agg.spend DESC
    `, [String(windowDays), minSpend, minRoas]);

    res.json({
      success: true,
      data: {
        winners: rows,
        filters: { minSpend, minRoas, windowDays },
        count: rows.length,
      },
    });
  } catch (err) {
    console.error('[iterations] GET /iterations error:', err);
    res.status(500).json({ success: false, error: err.message });
  }
});

router.post('/iterate/:creativeId', authenticate, async (req, res) => {
  try {
    await ensureCreativesTable();
    const parentCreativeId = req.params.creativeId;
    const variations = Math.max(1, Math.min(5, parseInt(req.body.variations) || 3));
    const productId = req.body.productId || null;

    // Load parent creative
    const parentRows = await pgQuery(`
      SELECT DISTINCT ON (creative_id)
        creative_id, ad_name, avatar, angle, editor, week, thumbnail_url, meta_ad_id,
        spend, roas, cpa, ctr
      FROM creative_analysis
      WHERE creative_id = $1 AND type = 'image' AND thumbnail_url IS NOT NULL
      ORDER BY creative_id, spend DESC
      LIMIT 1
    `, [parentCreativeId]);
    if (parentRows.length === 0) {
      return res.status(404).json({ success: false, error: `No image creative found for ${parentCreativeId}` });
    }
    const parent = parentRows[0];
    const parentImMatch = String(parent.creative_id).match(/^IM(\d+)$/);
    const parentImNumber = parentImMatch ? parseInt(parentImMatch[1]) : null;

    // Load product (or use Miner Forge Pro defaults)
    let product = { id: productId, name: 'Miner Forge Pro', profile: {} };
    if (productId) {
      const prodRows = await pgQuery('SELECT * FROM product_profiles WHERE id = $1', [productId]);
      if (prodRows.length > 0) {
        const p = prodRows[0];
        product = {
          id: p.id, name: p.name, price: p.price, description: p.description,
          product_image_url: (p.product_images && p.product_images[0]) || null,
          profile: {
            oneliner: p.oneliner, tagline: p.tagline, big_promise: p.big_promise,
            differentiator: p.differentiator, unique_mechanism: p.mechanism, voice: p.voice,
            key_benefits: p.benefits, pain_points: p.pain_points, target_demographics: p.target_demographics,
            target_audience: p.customer_avatar, customer: p.customer_avatar,
            winning_angles: p.winning_angles, objections: p.common_objections,
            offer_hook: p.offer_details, pricing: p.price, compliance: p.compliance_restrictions,
          },
        };
      }
    }

    // Pre-allocate spy_creatives rows + assign IM numbers
    const batchId = crypto.randomUUID();
    const createdRows = [];
    for (let i = 0; i < variations; i++) {
      const imNum = await assignNextImNumber();
      const sourceLabel = `IM${imNum} - IT - ${parent.creative_id}`;
      const row = await pgQuery(`
        INSERT INTO spy_creatives
          (pipeline, product_id, product_name, status, aspect_ratio,
           source_label, reference_name, reference_thumbnail, angle,
           parent_creative_id_ref, parent_im_number, im_number, batch_id, batch_position)
        VALUES ('iteration', $1, $2, 'generating', '4:5',
                $3, $4, $5, $6, $7, $8, $9, $10, $11)
        RETURNING id, im_number, source_label
      `, [
        productId, product.name, sourceLabel, parent.ad_name, parent.thumbnail_url,
        parent.angle, parent.creative_id, parentImNumber, imNum, batchId, i + 1,
      ]);
      createdRows.push(row[0]);
    }

    // Mark parent as iterated (UI "last iterated" timestamp)
    await pgQuery(
      `UPDATE creative_analysis SET iterated_at = NOW() WHERE creative_id = $1`,
      [parent.creative_id]
    );

    // Respond immediately — pipeline runs in background
    res.json({
      success: true,
      data: {
        batchId, parentCreativeId: parent.creative_id, parentImNumber, variations,
        creatives: createdRows.map(r => ({
          id: r.id, im_number: r.im_number, source_label: r.source_label, status: 'generating',
        })),
      },
    });

    // ── Background pipeline: refresh Meta URL → upload parent → N parallel variations ──
    setImmediate(async () => {
      console.log(`[iterations] batch ${batchId} | parent=${parent.creative_id} | variations=${variations}`);

      // Step A: get a stable HTTP URL for the parent image (Meta URLs expire after ~24h)
      let refImgUrl = parent.thumbnail_url;
      try {
        const probe = await fetch(refImgUrl, { method: 'HEAD' }).catch(() => null);
        if ((!probe || !probe.ok) && parent.meta_ad_id && process.env.META_ACCESS_TOKEN) {
          console.log(`[iterations] batch ${batchId} | Meta URL stale, refreshing ad ${parent.meta_ad_id}`);
          const refreshRes = await fetch(
            `https://graph.facebook.com/v23.0/${parent.meta_ad_id}?fields=creative{image_url,thumbnail_url}&access_token=${process.env.META_ACCESS_TOKEN}`
          );
          if (refreshRes.ok) {
            const rData = await refreshRes.json();
            const newUrl = rData.creative?.image_url || rData.creative?.thumbnail_url;
            if (newUrl) {
              refImgUrl = newUrl;
              await pgQuery(`UPDATE creative_analysis SET thumbnail_url = $1 WHERE creative_id = $2`, [newUrl, parent.creative_id]).catch(() => {});
            }
          }
        }
      } catch (e) {
        console.warn(`[iterations] batch ${batchId} | Meta URL refresh probe failed (continuing with stored URL): ${e.message}`);
      }

      const customPrompts = (await getCustomStaticsPrompts().catch(() => null)) || getDefaultStaticsPrompts();
      const productHttpUrl = product.product_image_url
        ? await ensureHttpUrlGlobal(product.product_image_url, 'iter-product').catch(() => null)
        : null;

      // Step B: process each variation in parallel
      await Promise.allSettled(createdRows.map(async (childRow, idx) => {
        const variationLabel = VARIATION_TWEAKS[idx % VARIATION_TWEAKS.length];
        const variationAngle = `${parent.angle || 'Winner iteration'} — ${variationLabel}`;
        const tagPrefix = `[iter ${batchId.slice(0,8)} ${idx+1}/${variations}]`;
        try {
          // Step B1: Claude analysis on the parent ad image
          const { base64: refBase64, mediaType: refMediaType } = await resolveImage(refImgUrl);
          const promptText = buildClaudeAnalysisPrompt(
            product, variationAngle, customPrompts.claude_analysis,
            { PRODUCT_IMAGE_NOTE: productHttpUrl ? '\n\nA second image is attached: this is OUR product. Render it precisely as shown.' : '' }
          );

          const userContent = [{ type: 'text', text: promptText }, { type: 'image', source: { type: 'base64', media_type: refMediaType, data: refBase64 } }];
          if (productHttpUrl && productHttpUrl.startsWith('http')) {
            try {
              const { base64: pBase64, mediaType: pMediaType } = await resolveImage(productHttpUrl);
              userContent.push({ type: 'image', source: { type: 'base64', media_type: pMediaType, data: pBase64 } });
            } catch (e) { console.warn(`${tagPrefix} product image attach failed: ${e.message}`); }
          }

          const claudeRes = await fetch('https://api.anthropic.com/v1/messages', {
            method: 'POST',
            headers: { 'x-api-key': process.env.ANTHROPIC_API_KEY, 'anthropic-version': '2023-06-01', 'content-type': 'application/json' },
            body: JSON.stringify({ model: 'claude-opus-4-5', max_tokens: 3000, messages: [{ role: 'user', content: userContent }] }),
          });
          if (!claudeRes.ok) {
            const errText = await claudeRes.text();
            throw new Error(`Claude ${claudeRes.status}: ${errText.slice(0,250)}`);
          }
          const claudeData = await claudeRes.json();
          const rawText = claudeData.content?.[0]?.text || '';
          const jsonMatch = rawText.match(/\{[\s\S]*\}/);
          if (!jsonMatch) throw new Error('Claude returned no JSON object');
          let claudeResult;
          try { claudeResult = JSON.parse(jsonMatch[0]); }
          catch {
            const fixable = jsonMatch[0].replace(/,\s*([}\]])/g, '$1');
            claudeResult = JSON.parse(fixable);
          }

          // Step B2: NanoBanana with ONLY the product image (per architecture)
          if (!productHttpUrl) throw new Error('Iteration requires product.product_image_url — none available');
          const nbPrompt = buildNanoBananaImagePrompt(claudeResult, product, customPrompts.nanobanana_image);
          const nbTaskId = await submitToNanoBanana(nbPrompt, [productHttpUrl], '4:5');
          const tempUrl = await pollNanoBanana(nbTaskId);
          const generatedUrl = await persistNanoBananaImage(tempUrl, 'statics-iterations');

          // Step B3: write result back to spy_creatives row
          await pgQuery(`
            UPDATE spy_creatives
            SET status = 'review',
                image_url = $1,
                thumbnail_url = $1,
                claude_analysis = $2::jsonb,
                adapted_text = $3::jsonb,
                iteration_change_description = $4,
                updated_at = NOW()
            WHERE id = $5
          `, [generatedUrl, JSON.stringify(claudeResult), JSON.stringify(claudeResult.adapted_text || {}), variationLabel, childRow.id]);
          console.log(`${tagPrefix} ✅ done → ${generatedUrl.slice(0,80)}`);
        } catch (err) {
          console.error(`${tagPrefix} failed: ${err.message}`);
          await pgQuery(
            `UPDATE spy_creatives SET status = 'rejected', review_notes = $1, updated_at = NOW() WHERE id = $2`,
            [`Iteration failed: ${err.message}`.slice(0, 500), childRow.id]
          ).catch(() => {});
        }
      }));
      console.log(`[iterations] batch ${batchId} ✅ complete`);
    });
  } catch (err) {
    console.error('[iterations] POST /iterate error:', err);
    res.status(500).json({ success: false, error: err.message });
  }
});

router.get('/iterate/:batchId/status', authenticate, async (req, res) => {
  try {
    const { batchId } = req.params;
    if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(batchId)) {
      return res.status(404).json({ success: false, error: 'Invalid batchId format' });
    }
    const rows = await pgQuery(
      `SELECT id, im_number, parent_creative_id_ref, status, image_url, thumbnail_url,
              source_label, iteration_change_description, review_notes, updated_at
       FROM spy_creatives
       WHERE batch_id = $1
       ORDER BY batch_position ASC`,
      [batchId]
    );
    res.json({
      success: true,
      data: {
        batchId,
        count: rows.length,
        complete: rows.filter(r => r.status === 'review').length,
        failed:   rows.filter(r => r.status === 'rejected').length,
        pending:  rows.filter(r => r.status === 'generating').length,
        creatives: rows,
      },
    });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

// ─────────────────────────────────────────────────────────────────────────
// spy_creatives table bootstrap + variant generator
// ─────────────────────────────────────────────────────────────────────────

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
  await pgQuery('ALTER TABLE spy_creatives ADD COLUMN IF NOT EXISTS parent_creative_id_ref TEXT').catch(() => {});
  await pgQuery('ALTER TABLE spy_creatives ADD COLUMN IF NOT EXISTS parent_im_number INTEGER').catch(() => {});
  await pgQuery('ALTER TABLE spy_creatives ADD COLUMN IF NOT EXISTS im_number INTEGER').catch(() => {});
  await pgQuery('ALTER TABLE spy_creatives ADD COLUMN IF NOT EXISTS iteration_change_description TEXT').catch(() => {});
  await pgQuery(`CREATE INDEX IF NOT EXISTS idx_spy_creatives_parent_ref ON spy_creatives(parent_creative_id_ref)`).catch(() => {});
  await pgQuery('ALTER TABLE spy_creatives ADD COLUMN IF NOT EXISTS quality_warning TEXT').catch(() => {});
  await pgQuery('ALTER TABLE spy_creatives ADD COLUMN IF NOT EXISTS group_id UUID').catch(() => {});
  await pgQuery(`CREATE INDEX IF NOT EXISTS idx_spy_creatives_group_id ON spy_creatives(group_id)`).catch(() => {});
  await pgQuery(`CREATE UNIQUE INDEX IF NOT EXISTS idx_spy_creatives_im_number ON spy_creatives(im_number) WHERE im_number IS NOT NULL`).catch(() => {});
  await pgQuery('ALTER TABLE creative_analysis ADD COLUMN IF NOT EXISTS iterated_at TIMESTAMPTZ').catch(() => {});

  await pgQuery(`CREATE TABLE IF NOT EXISTS statics_im_counter (
    id INTEGER PRIMARY KEY DEFAULT 1 CHECK (id = 1),
    next_number INTEGER NOT NULL DEFAULT 1
  )`).catch(() => {});
  await pgQuery(`
    INSERT INTO statics_im_counter (id, next_number)
    SELECT 1, COALESCE((
      SELECT MAX(CAST(SUBSTRING(creative_id FROM 3) AS INTEGER))
      FROM creative_analysis
      WHERE creative_id ~ '^IM[0-9]+$'
    ), 0) + 1
    ON CONFLICT (id) DO NOTHING
  `).catch((err) => {
    console.warn('[iterations] IM counter seed failed:', err.message);
  });
  await pgQuery(`CREATE TABLE IF NOT EXISTS statics_launches (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    creative_id UUID REFERENCES spy_creatives(id) ON DELETE CASCADE,
    template_id UUID, copy_set_id UUID, ad_account_id TEXT,
    meta_campaign_id TEXT, meta_adset_id TEXT, meta_ad_id TEXT, meta_creative_id TEXT, meta_image_hash TEXT,
    ad_name TEXT, adset_name TEXT, page_id TEXT, page_name TEXT, batch_number INTEGER,
    status TEXT DEFAULT 'pending', error_message TEXT, launched_at TIMESTAMPTZ, created_at TIMESTAMPTZ DEFAULT NOW()
  )`).catch(() => {});

  const baseUrl = process.env.RENDER_EXTERNAL_URL;
  if (baseUrl) {
    await pgQuery(
      `UPDATE spy_creatives SET reference_thumbnail = $1 || reference_thumbnail WHERE reference_thumbnail LIKE '/%'`,
      [baseUrl]
    ).catch(() => {});
  }

  crTableReady = true;
}

// ─────────────────────────────────────────────────────────────────────────
// Variant generator (NanoBanana resize)
// ─────────────────────────────────────────────────────────────────────────

async function generateVariant(parent, newAspectRatio) {
  try {
    console.log(`[staticsGeneration] Resizing ${parent.id} to ${newAspectRatio} variant`);

    await pgQuery(
      "DELETE FROM spy_creatives WHERE parent_creative_id = $1 AND aspect_ratio = $2",
      [parent.id, newAspectRatio]
    );

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
    const child = childRows[0];

    if (!parent.image_url) {
      await pgQuery("UPDATE spy_creatives SET status = 'rejected', review_notes = 'Parent creative has no generated image to resize' WHERE id = $1", [child.id]);
      return;
    }

    const parentHttpUrl = await ensureHttpUrlGlobal(parent.image_url, 'variant-source');

    // Pre-flight: confirm parent is fetchable
    if (parentHttpUrl.startsWith('http')) {
      try {
        const checkRes = await fetch(parentHttpUrl, { method: 'HEAD', signal: AbortSignal.timeout(8000) });
        if (!checkRes.ok) {
          const note = `Parent image expired or inaccessible (HTTP ${checkRes.status}) — regenerate the parent from the UI`;
          await pgQuery("UPDATE spy_creatives SET status = 'rejected', review_notes = $1, updated_at = NOW() WHERE id = $2", [note, child.id]);
          return;
        }
      } catch (checkErr) {
        console.warn(`[staticsGeneration] Variant resize ${parent.id}: pre-flight check failed (${checkErr.message}), proceeding anyway`);
      }
    }

    const resizePrompt = `Seamlessly resize this ad image to ${newAspectRatio} aspect ratio. Keep ALL content identical — same text, same product, same layout, same colors, same style. Extend or adjust the background naturally to fill the new format.`;

    const nbTaskId = await submitToNanoBanana(resizePrompt, [parentHttpUrl], newAspectRatio);
    await pgQuery(
      "UPDATE spy_creatives SET generation_task_id = $1, updated_at = NOW() WHERE id = $2",
      [nbTaskId, child.id]
    );

    const nbImageUrl = await pollNanoBanana(nbTaskId);

    // Permanently store the result (kie.ai URLs are short-lived)
    let finalImageUrl = nbImageUrl;
    try {
      const imgFetch = await fetch(nbImageUrl, { signal: AbortSignal.timeout(30000) });
      if (imgFetch.ok) {
        const buf = Buffer.from(await imgFetch.arrayBuffer());
        const mime = detectMime(buf);
        if (isR2Configured()) {
          const ext = mime.includes('png') ? 'png' : 'jpg';
          finalImageUrl = await uploadBuffer(buf, `statics-variants/${crypto.randomUUID()}.${ext}`, mime);
        } else {
          const imgId = await storeTempImage(buf, mime);
          const srvUrl = process.env.RENDER_EXTERNAL_URL || `http://localhost:${process.env.PORT || 3000}`;
          finalImageUrl = `${srvUrl}/api/v1/statics-generation/tmp-img/${imgId}`;
        }
        console.log(`[staticsGeneration] Variant ${child.id} image stored permanently`);
      }
    } catch (storeErr) {
      console.warn(`[staticsGeneration] Variant image store failed, using CDN URL: ${storeErr.message}`);
    }

    await pgQuery(
      "UPDATE spy_creatives SET image_url = $1, generation_task_id = $2, status = 'review', updated_at = NOW() WHERE id = $3",
      [finalImageUrl, nbTaskId, child.id]
    );

    console.log(`[staticsGeneration] Variant ${child.id} (${newAspectRatio}) resized successfully`);
  } catch (err) {
    console.error(`[staticsGeneration] Variant resize failed:`, err.message);
    try {
      await pgQuery(
        "UPDATE spy_creatives SET status = 'rejected', review_notes = $1, updated_at = NOW() WHERE parent_creative_id = $2 AND status = 'generating'",
        [`Variant resize failed: ${err.message}`, parent.id]
      );
    } catch { /* best effort */ }
  }
}

// ─────────────────────────────────────────────────────────────────────────
// Creatives CRUD
// ─────────────────────────────────────────────────────────────────────────

router.get('/creatives', authenticate, async (req, res) => {
  try {
    await ensureCreativesTable();
    const { product_id, status, pipeline = 'standard' } = req.query;
    let query = "SELECT id, product_id, product_name, image_url, thumbnail_url, source_label, angle, archetype, aspect_ratio, status, reference_thumbnail, reference_name, parent_creative_id, pipeline, copy_set_id, meta_ad_ids, meta_image_hash, generated_copy, parent_creative_id_ref, parent_im_number, im_number, iteration_change_description, quality_warning, created_at FROM spy_creatives WHERE pipeline = $1";
    const params = [pipeline];
    let idx = 2;

    if (product_id) { query += ` AND product_id = $${idx++}`; params.push(product_id); }
    if (status) { query += ` AND status = $${idx++}`; params.push(status); }

    query += ' ORDER BY created_at DESC';
    const rows = await pgQuery(query, params);

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

    if (status === 'approved' && creative.aspect_ratio !== '9:16' && !creative.parent_creative_id) {
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

router.patch('/creatives/:id/angle', authenticate, async (req, res) => {
  try {
    await ensureCreativesTable();
    const { angle } = req.body;
    if (angle === undefined) {
      return res.status(400).json({ success: false, error: { message: 'angle is required' } });
    }
    const newAngle = angle || null;
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

router.patch('/creatives/:id/copy', authenticate, async (req, res) => {
  try {
    const { adapted_text } = req.body;
    if (!adapted_text || typeof adapted_text !== 'object' || Array.isArray(adapted_text)) {
      return res.status(400).json({ success: false, error: { message: 'adapted_text must be a plain object' } });
    }
    const rows = await pgQuery(
      "UPDATE spy_creatives SET adapted_text = $1, updated_at = NOW() WHERE id = $2 RETURNING id, adapted_text",
      [JSON.stringify(adapted_text), req.params.id]
    );
    if (rows.length === 0) return res.status(404).json({ success: false, error: { message: 'Creative not found' } });
    res.json({ success: true, data: rows[0] });
  } catch (err) {
    console.error('[staticsGeneration] /creatives/:id/copy error:', err);
    res.status(500).json({ success: false, error: { message: err.message } });
  }
});

router.get('/creatives/pipeline', authenticate, async (req, res) => {
  try {
    await ensureCreativesTable();
    const { product_id } = req.query;

    let query = "SELECT id, product_id, product_name, image_url, thumbnail_url, source_label, angle, archetype, aspect_ratio, status, reference_thumbnail, reference_name, parent_creative_id, pipeline, copy_set_id, meta_ad_ids, meta_image_hash, generated_copy, parent_creative_id_ref, parent_im_number, im_number, iteration_change_description, created_at FROM spy_creatives WHERE pipeline IN ('standard', 'iteration')";
    const params = [];
    if (product_id) {
      query += ' AND product_id = $1';
      params.push(product_id);
    }
    query += ' ORDER BY created_at DESC';

    const rows = await pgQuery(query, params);

    const pipeline = { generating: [], review: [], approved: [], ready: [], launched: [] };
    const variants = [];
    for (const row of rows) {
      if (row.parent_creative_id && (row.status === 'generating' || row.status === 'rejected')) {
        variants.push(row);
      } else if (row.status === 'generating' && !row.parent_creative_id) {
        pipeline.generating.push(row);
      } else if (pipeline[row.status]) {
        pipeline[row.status].push(row);
      }
    }

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

router.delete('/creatives/:id', authenticate, async (req, res) => {
  try {
    await ensureCreativesTable();
    await pgQuery('DELETE FROM spy_creatives WHERE parent_creative_id = $1', [req.params.id]);
    const rows = await pgQuery('DELETE FROM spy_creatives WHERE id = $1 RETURNING id', [req.params.id]);
    if (rows.length === 0) return res.status(404).json({ success: false, error: { message: 'Creative not found' } });
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ success: false, error: { message: err.message } });
  }
});

router.post('/creatives/:id/create-variant', authenticate, async (req, res) => {
  try {
    await ensureCreativesTable();
    const { aspect_ratio = '9:16' } = req.body;
    const rows = await pgQuery('SELECT * FROM spy_creatives WHERE id = $1', [req.params.id]);
    if (rows.length === 0) return res.status(404).json({ success: false, error: { message: 'Creative not found' } });
    const parent = rows[0];

    await pgQuery(
      "DELETE FROM spy_creatives WHERE parent_creative_id = $1 AND aspect_ratio = $2",
      [parent.id, aspect_ratio]
    );

    res.json({ success: true, message: `${aspect_ratio} variant generation started` });

    generateVariant(parent, aspect_ratio).catch(err =>
      console.error('[staticsGeneration] Manual variant generation error:', err.message)
    );
  } catch (err) {
    console.error('[staticsGeneration] /creatives/:id/create-variant error:', err);
    res.status(500).json({ success: false, error: { message: err.message } });
  }
});

router.post('/creatives', authenticate, async (req, res) => {
  try {
    await ensureCreativesTable();
    const {
      product_id, product_name, angle, aspect_ratio, image_url,
      reference_template_id, reference_name, reference_thumbnail, adapted_text,
      claude_analysis, swap_pairs, generation_prompt, generation_task_id,
      source_label, pipeline, status = 'review',
      group_id, quality_warning,
    } = req.body;

    if (!image_url) return res.status(400).json({ success: false, error: { message: 'image_url is required' } });

    let resolvedRefThumb = reference_thumbnail || null;
    if (resolvedRefThumb && resolvedRefThumb.startsWith('/')) {
      const base = process.env.RENDER_EXTERNAL_URL || `http://localhost:${process.env.PORT || 3000}`;
      resolvedRefThumb = `${base}${resolvedRefThumb}`;
    }

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
         generation_task_id, pipeline, status, group_id, generated_copy, copy_set_id,
         quality_warning)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20)
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
        quality_warning || null,
      ]
    );

    res.json({ success: true, data: rows[0] });
  } catch (err) {
    console.error('[staticsGeneration] POST /creatives error:', err);
    res.status(500).json({ success: false, error: { message: err.message } });
  }
});

// ─────────────────────────────────────────────────────────────────────────
// POST /creatives/:id/ai-adjust — Step 3 of the 3-prompt pipeline
//
//   Claude turns user correction into NanoBanana regen prompt, then NB edits
//   the CURRENT generated image (not the product) — friend's tool architecture.
// ─────────────────────────────────────────────────────────────────────────

router.post('/creatives/:id/ai-adjust', authenticate, async (req, res) => {
  try {
    await ensureCreativesTable();
    // Accept either { correction } (new) or { instruction } (legacy frontend)
    const correction = req.body.correction || req.body.instruction;
    if (!correction) {
      return res.status(400).json({ success: false, error: { message: 'correction (or instruction) is required' } });
    }

    const rows = await pgQuery('SELECT * FROM spy_creatives WHERE id = $1', [req.params.id]);
    if (rows.length === 0) return res.status(404).json({ success: false, error: { message: 'Creative not found' } });
    const creative = rows[0];

    if (!creative.image_url) {
      return res.status(400).json({ success: false, error: { message: 'Creative has no image_url to adjust' } });
    }

    const adjustTaskId = `adj-${crypto.randomUUID()}`;
    storeTaskResult(adjustTaskId, { status: 'processing', progress: 'Asking Claude how to adjust...' });

    await pgQuery(
      "UPDATE spy_creatives SET review_notes = 'AI adjusting...', updated_at = NOW() WHERE id = $1",
      [req.params.id]
    );

    res.json({ success: true, data: { taskId: adjustTaskId, status: 'processing' } });

    // Fire-and-forget background work
    (async () => {
      try {
        const customPrompts = await getCustomStaticsPrompts();

        // Reconstruct a claudeResult shape from stored creative.
        // We prefer the original claude_analysis if present; otherwise build a minimal stub.
        const storedAnalysis = creative.claude_analysis
          ? (typeof creative.claude_analysis === 'string' ? JSON.parse(creative.claude_analysis) : creative.claude_analysis)
          : null;
        const storedAdapted = creative.adapted_text
          ? (typeof creative.adapted_text === 'string' ? JSON.parse(creative.adapted_text) : creative.adapted_text)
          : null;

        const claudeResult = storedAnalysis && storedAnalysis.adapted_text
          ? storedAnalysis
          : {
              adapted_text: storedAdapted || {},
              people_count: storedAnalysis?.people_count ?? 0,
            };

        const product = {
          name: creative.product_name || '',
          price: '',
          profile: {},
          product_image_url: null,
        };

        const adjustPromptText = buildAdjustmentPrompt(
          claudeResult,
          product,
          creative.angle || '',
          correction,
          customPrompts.ai_adjustment,
        );

        const claudeRes = await fetch(CLAUDE_API_URL, {
          method: 'POST',
          headers: {
            'x-api-key': ANTHROPIC_API_KEY,
            'anthropic-version': '2023-06-01',
            'Content-Type': 'application/json',
          },
          body: JSON.stringify({
            model: CLAUDE_MODEL,
            max_tokens: 1000,
            messages: [{ role: 'user', content: [{ type: 'text', text: adjustPromptText }] }],
          }),
        });

        if (!claudeRes.ok) throw new Error(`Claude API error ${claudeRes.status}: ${await claudeRes.text()}`);
        const claudeData = await claudeRes.json();
        const rawText = claudeData.content?.[0]?.text;
        if (!rawText) throw new Error('Empty response from Claude');
        const jsonMatch = rawText.match(/\{[\s\S]*\}/);
        if (!jsonMatch) throw new Error('Could not parse JSON from Claude adjustment response');
        const adjust = JSON.parse(jsonMatch[0]);
        const adjustmentInstruction = (adjust.adjustment_instruction || '').trim();
        if (!adjustmentInstruction) throw new Error('Claude returned empty adjustment_instruction');

        // Build the new NB prompt: original NB prompt + adjustment instruction.
        const baseNbPrompt = buildNanoBananaImagePrompt(claudeResult, product, customPrompts.nanobanana_image);
        const newNbPrompt = `${baseNbPrompt}\n\nADJUSTMENT REQUESTED BY USER:\n${adjustmentInstruction}\n\nPreserve everything else exactly as it appears in the input image.`;

        storeTaskResult(adjustTaskId, { status: 'processing', progress: 'Regenerating with NanoBanana...' });

        // Per friend's architecture: NanoBanana edits the CURRENT image (not the product) on adjustment.
        const currentImageHttpUrl = await ensureHttpUrlGlobal(creative.image_url, 'adjust-src');
        const ratio = creative.aspect_ratio || '4:5';
        const nbTaskId = await submitToNanoBanana(newNbPrompt, [currentImageHttpUrl], ratio);
        const newImageUrl = await pollNanoBanana(nbTaskId);

        // Persist the new image permanently (kie.ai URLs are short-lived)
        let finalImageUrl = newImageUrl;
        try {
          const imgFetch = await fetch(newImageUrl, { signal: AbortSignal.timeout(30000) });
          if (imgFetch.ok) {
            const buf = Buffer.from(await imgFetch.arrayBuffer());
            const mime = detectMime(buf);
            if (isR2Configured()) {
              const ext = mime.includes('png') ? 'png' : 'jpg';
              finalImageUrl = await uploadBuffer(buf, `statics-adjust/${crypto.randomUUID()}.${ext}`, mime);
            } else {
              const imgId = await storeTempImage(buf, mime);
              const srvUrl = process.env.RENDER_EXTERNAL_URL || `http://localhost:${process.env.PORT || 3000}`;
              finalImageUrl = `${srvUrl}/api/v1/statics-generation/tmp-img/${imgId}`;
            }
          }
        } catch (storeErr) {
          console.warn(`[ai-adjust] Permanent store failed, using kie.ai URL: ${storeErr.message}`);
        }

        await pgQuery(
          `UPDATE spy_creatives
           SET image_url = $1, generation_prompt = $2, review_notes = NULL, updated_at = NOW()
           WHERE id = $3`,
          [finalImageUrl, adjustmentInstruction, creative.id]
        );

        storeTaskResult(adjustTaskId, {
          status: 'completed',
          resultImageUrl: finalImageUrl,
          provider: 'nanobanana',
          model: 'google/nano-banana-edit',
        });
        console.log(`[ai-adjust] Success for ${creative.id}: ${finalImageUrl}`);
      } catch (err) {
        console.error(`[ai-adjust] Failed for ${creative.id}:`, err.message);
        storeTaskResult(adjustTaskId, { status: 'error', error: err.message });
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

// ─────────────────────────────────────────────────────────────────────────
// Settings / prompts (3-prompt JSON)
// ─────────────────────────────────────────────────────────────────────────

router.get('/settings/prompts', authenticate, async (_req, res) => {
  try {
    const defaults = getDefaultStaticsPrompts();
    const current  = await getCustomStaticsPrompts();
    res.json({
      success: true,
      promptTypes: STATICS_PROMPT_TYPES,
      defaults,
      current,
      // Backwards-compat fields for older frontend builds
      custom: current,
      hasCustom: true,
    });
  } catch (err) {
    res.status(500).json({ success: false, error: { message: err.message } });
  }
});

router.put('/settings/prompts', authenticate, async (req, res) => {
  try {
    const incoming = req.body?.prompts || req.body;
    if (!incoming || typeof incoming !== 'object') {
      return res.status(400).json({ success: false, error: { message: 'prompts object is required' } });
    }
    for (const k of STATICS_PROMPT_KEYS) {
      if (typeof incoming[k] !== 'string' || !incoming[k].trim()) {
        return res.status(400).json({ success: false, error: { message: `Missing or empty prompt: ${k}` } });
      }
    }
    const toSave = {
      claude_analysis:  incoming.claude_analysis,
      nanobanana_image: incoming.nanobanana_image,
      ai_adjustment:    incoming.ai_adjustment,
    };
    await pgQuery(
      `INSERT INTO system_settings (key, value, description)
       VALUES ('statics_prompts', $1, 'Pipeline prompts for statics generation — 3-prompt architecture')
       ON CONFLICT (key) DO UPDATE SET value = $1, updated_at = NOW()`,
      [JSON.stringify(toSave)]
    );
    staticsPromptsCache = { data: toSave, timestamp: Date.now() };
    res.json({ success: true, message: 'Prompts saved', current: toSave });
  } catch (err) {
    res.status(500).json({ success: false, error: { message: err.message } });
  }
});

router.post('/settings/prompts/reset', authenticate, async (_req, res) => {
  try {
    await pgQuery(`DELETE FROM system_settings WHERE key = 'statics_prompts'`);
    staticsPromptsCache = { data: null, timestamp: 0 };
    res.json({ success: true, message: 'Prompts reset to defaults', current: getDefaultStaticsPrompts() });
  } catch (err) {
    res.status(500).json({ success: false, error: { message: err.message } });
  }
});

// ─────────────────────────────────────────────────────────────────────────
// Launch (Meta) — preserved as-is
// ─────────────────────────────────────────────────────────────────────────

function buildLaunchName(pattern, vars) {
  let result = pattern;
  for (const [key, val] of Object.entries(vars)) {
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

    const templates = await pgQuery('SELECT * FROM launch_templates WHERE id = $1', [template_id]);
    if (!templates.length) return res.status(404).json({ success: false, error: { message: 'Template not found' } });
    const template = templates[0];

    if (!template.campaign_id) {
      return res.status(400).json({ success: false, error: { message: 'Template has no campaign configured. Please edit the template and select a campaign.' } });
    }

    let copySet = null;
    if (copy_set_id) {
      const cs = await pgQuery('SELECT * FROM brief_copy_sets WHERE id = $1', [copy_set_id]);
      if (!cs.length) return res.status(404).json({ success: false, error: { message: 'Copy set not found' } });
      copySet = cs[0];
    }

    const creatives = await pgQuery(
      `SELECT * FROM spy_creatives WHERE id = ANY($1) AND status IN ('approved', 'ready')`,
      [creative_ids]
    );
    if (!creatives.length) {
      return res.status(400).json({ success: false, error: { message: 'No launchable creatives found (must be approved or ready)' } });
    }

    await pgQuery(
      `UPDATE spy_creatives SET status = 'launching' WHERE id = ANY($1)`,
      [creative_ids]
    );

    const now = new Date();
    const dateStr = `${String(now.getDate()).padStart(2, '0')}/${String(now.getMonth() + 1).padStart(2, '0')}`;
    const batchNum = Math.floor(Date.now() / 1000) % 10000;
    const results = [];

    const safeArr = (v) => { if (Array.isArray(v)) return v; if (typeof v === 'string') { try { let p = JSON.parse(v); if (typeof p === 'string') p = JSON.parse(p); return Array.isArray(p) ? p : []; } catch { return []; } } return []; };
    const safeObj = (v) => { if (v && typeof v === 'object' && !Array.isArray(v)) return v; if (typeof v === 'string') { try { const p = JSON.parse(v); return (p && typeof p === 'object') ? p : {}; } catch { return {}; } } return {}; };

    const selectedPages = safeArr(template.page_ids).filter(p => p.selected !== false);
    if (!selectedPages.length || !selectedPages[0]?.id) {
      await pgQuery(`UPDATE spy_creatives SET status = 'ready' WHERE id = ANY($1)`, [creative_ids]);
      return res.status(400).json({ success: false, error: { message: 'No Facebook pages configured in launch template. Edit the template and select at least one page.' } });
    }

    let adsetId = null;
    let adsetName = buildLaunchName(template.adset_name_pattern || '{date} - Batch {batch}', {
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
      await pgQuery(`UPDATE spy_creatives SET status = 'ready' WHERE id = ANY($1)`, [creative_ids]);
      return res.status(500).json({ success: false, error: { message: `Ad set creation failed: ${err.message}` } });
    }

    let pageIdx = 0;
    const processedGroupIds = new Set();

    for (let i = 0; i < creatives.length; i++) {
      const creative = creatives[i];

      if (creative.group_id && processedGroupIds.has(creative.group_id)) {
        results.push({ creative_id: creative.id, status: 'skipped', reason: 'Handled as part of group launch' });
        continue;
      }
      if (creative.group_id) processedGroupIds.add(creative.group_id);

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
        if (!creative.image_url && !creative.meta_image_hash) {
          throw new Error(`Creative ${creative.id} has no image — cannot launch without an image`);
        }

        const selfRatio = creative.aspect_ratio || '4:5';
        const ratioImages = {};
        ratioImages[selfRatio] = {
          id: creative.id,
          image_url: creative.image_url,
          meta_image_hash: creative.meta_image_hash || null,
        };

        if (creative.group_id) {
          const siblings = await pgQuery(
            "SELECT id, aspect_ratio, image_url, meta_image_hash FROM spy_creatives WHERE group_id = $1 AND id != $2 AND status IN ('approved', 'ready') AND image_url IS NOT NULL",
            [creative.group_id, creative.id]
          ).catch(() => []);
          for (const s of siblings) {
            if (!ratioImages[s.aspect_ratio]) {
              ratioImages[s.aspect_ratio] = { id: s.id, image_url: s.image_url, meta_image_hash: s.meta_image_hash };
            }
          }
        }

        const legacyVariants = await pgQuery(
          "SELECT id, aspect_ratio, image_url, meta_image_hash FROM spy_creatives WHERE parent_creative_id = $1 AND status IN ('approved', 'ready') AND image_url IS NOT NULL",
          [creative.id]
        ).catch(() => []);
        for (const v of legacyVariants) {
          if (!ratioImages[v.aspect_ratio]) {
            ratioImages[v.aspect_ratio] = { id: v.id, image_url: v.image_url, meta_image_hash: v.meta_image_hash };
          }
        }

        const uploadedRatios = [];
        for (const [ratio, data] of Object.entries(ratioImages)) {
          let hash = data.meta_image_hash;
          if (!hash && data.image_url) {
            try {
              const uRes = await uploadAdImageFromUrl(template.ad_account_id, data.image_url);
              if (!uRes?.hash) throw new Error(`Upload returned no hash for ratio ${ratio}`);
              hash = uRes.hash;
              const metaCdnUrl = uRes.url || null;
              await pgQuery(
                `UPDATE spy_creatives SET meta_image_hash = $1${metaCdnUrl ? ', image_url = $3, thumbnail_url = $3' : ''}, updated_at = NOW() WHERE id = $2`,
                metaCdnUrl ? [hash, data.id, metaCdnUrl] : [hash, data.id]
              ).catch(() => {});
            } catch (uErr) {
              console.warn(`[staticsGeneration] ⚠️ Skipping ${ratio} (${data.id}) — upload failed: ${uErr.message}`);
              continue;
            }
          }
          if (hash) uploadedRatios.push({ ratio, id: data.id, imageHash: hash });
        }

        if (uploadedRatios.length === 0) {
          throw new Error('No images could be uploaded to Meta for any ratio');
        }

        const genCopy = safeObj(creative.generated_copy);
        const csPrimaryTexts = safeArr(copySet?.primary_texts);
        const csHeadlines    = safeArr(copySet?.headlines);
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
        const cta  = copySet?.cta_button || genCopy.cta || 'SHOP_NOW';
        const link = copySet?.landing_page_url || template.landing_page_url || 'https://mineblock.com';

        const existingMeta = safeArr(creative.meta_ad_ids);
        let primaryMetaAdId = null;
        let primaryImageHash = creative.meta_image_hash;

        for (const ratioItem of uploadedRatios) {
          const ratioSuffix = uploadedRatios.length > 1 ? ` [${ratioItem.ratio}]` : '';
          const ratioAdName = `${adName}${ratioSuffix}`;

          const metaCreativeId = await createFlexibleAdCreative(template.ad_account_id, {
            name: ratioAdName,
            imageHashes: [ratioItem.imageHash],
            primaryTexts, headlines, descriptions, cta, link,
            pageId: page?.id || selectedPages[0]?.id,
            utmParameters: template.utm_parameters,
          });

          const metaAdId = await createAd(template.ad_account_id, {
            name: ratioAdName, adsetId, creativeId: metaCreativeId, status: 'ACTIVE',
          });

          existingMeta.push({
            ad_id: metaAdId, creative_id: metaCreativeId, adset_id: adsetId,
            campaign_id: template.campaign_id, page_id: page?.id || selectedPages[0]?.id,
            ad_name: ratioAdName, aspect_ratio: ratioItem.ratio,
            launched_at: new Date().toISOString(),
          });

          await pgQuery(
            `INSERT INTO statics_launches (creative_id, template_id, copy_set_id, ad_account_id, meta_campaign_id, meta_adset_id, meta_ad_id, meta_creative_id, meta_image_hash, ad_name, adset_name, page_id, page_name, batch_number, status, launched_at)
             VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,'launched',NOW())`,
            [ratioItem.id, template_id, copy_set_id || null, template.ad_account_id, template.campaign_id, adsetId, metaAdId, metaCreativeId, ratioItem.imageHash, ratioAdName, adsetName, page?.id || null, page?.name || null, batchNum]
          ).catch(err => console.warn('[staticsGeneration] Failed to log launch:', err.message));

          if (ratioItem.id === creative.id) {
            primaryMetaAdId = metaAdId;
            primaryImageHash = ratioItem.imageHash;
          }
        }

        await pgQuery(
          `UPDATE spy_creatives SET status = 'launched', meta_ad_ids = $1, meta_image_hash = $2, updated_at = NOW() WHERE id = $3`,
          [JSON.stringify(existingMeta), primaryImageHash || uploadedRatios[0]?.imageHash, creative.id]
        );

        for (const ratioItem of uploadedRatios) {
          if (ratioItem.id !== creative.id) {
            await pgQuery(
              "UPDATE spy_creatives SET status = 'launched', meta_image_hash = $1, updated_at = NOW() WHERE id = $2",
              [ratioItem.imageHash, ratioItem.id]
            ).catch(() => {});
          }
        }

        results.push({
          creative_id: creative.id,
          status: 'launched',
          meta_ad_id: primaryMetaAdId || uploadedRatios[0]?.imageHash,
          ad_name: adName,
          ratios_launched: uploadedRatios.map(r => r.ratio),
        });
      } catch (err) {
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

    await pgQuery(
      `UPDATE spy_creatives SET status = 'ready', review_notes = 'Launch interrupted — retryable' WHERE id = ANY($1) AND status = 'launching'`,
      [creative_ids]
    ).catch(() => {});

    res.json({ success: true, data: { results, adset_id: adsetId, adset_name: adsetName } });
  } catch (err) {
    console.error('[StaticsGeneration] Launch error:', err);
    if (req.body.creative_ids?.length) {
      await pgQuery(
        `UPDATE spy_creatives SET status = 'ready' WHERE id = ANY($1) AND status = 'launching'`,
        [req.body.creative_ids]
      ).catch(() => {});
    }
    res.status(500).json({ success: false, error: { message: err.message } });
  }
});

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

// ─────────────────────────────────────────────────────────────────────────
// Template intelligence / analysis
// ─────────────────────────────────────────────────────────────────────────

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

router.get('/templates/analyze-all/status', authenticate, async (_req, res) => {
  res.json({ success: true, progress: analyzeAllProgress });
});

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

router.delete('/templates/:id', authenticate, async (req, res) => {
  try {
    const rows = await pgQuery('SELECT * FROM statics_templates WHERE id = $1', [req.params.id]);
    if (rows.length === 0) return res.status(404).json({ success: false, error: { message: 'Template not found' } });
    const template = rows[0];
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

// ─────────────────────────────────────────────────────────────────────────
// Analytics: per-angle breakdown
// ─────────────────────────────────────────────────────────────────────────

router.get('/analytics/by-angle', authenticate, async (_req, res) => {
  try {
    const rows = await pgQuery(`
      SELECT
        COALESCE(angle, 'No angle') AS angle,
        COUNT(*)::int                AS total,
        COUNT(*) FILTER (WHERE status = 'approved')::int  AS approved,
        COUNT(*) FILTER (WHERE status = 'rejected')::int  AS rejected,
        COUNT(*) FILTER (WHERE status = 'review')::int    AS in_review,
        COUNT(*) FILTER (WHERE status = 'launched')::int  AS launched,
        MIN(created_at)              AS first_generated,
        MAX(created_at)              AS last_generated
      FROM spy_creatives
      WHERE created_at >= NOW() - INTERVAL '90 days'
        AND parent_creative_id IS NULL
      GROUP BY COALESCE(angle, 'No angle')
      ORDER BY total DESC
    `);

    const data = rows.map(r => ({
      angle: r.angle,
      total: r.total,
      approved: r.approved,
      rejected: r.rejected,
      in_review: r.in_review,
      launched: r.launched,
      approval_rate: r.total > 0 ? Math.round(((r.approved + r.launched) / r.total) * 100) : 0,
      first_generated: r.first_generated,
      last_generated: r.last_generated,
    }));

    res.json({ success: true, data, period_days: 90 });
  } catch (err) {
    res.status(500).json({ success: false, error: { message: err.message } });
  }
});

// ─────────────────────────────────────────────────────────────────────────
// Generation health dashboard
// ─────────────────────────────────────────────────────────────────────────

router.get('/monitoring/health', authenticate, async (_req, res) => {
  try {
    const tableCheck = await pgQuery(
      `SELECT EXISTS (
         SELECT FROM information_schema.tables
         WHERE table_name = 'statics_generation_events'
       ) AS exists`
    ).catch(() => [{ exists: false }]);
    if (!tableCheck[0]?.exists) {
      return res.json({ success: true, data: { status: 'pending_migration', message: 'Migration 035 not yet applied' } });
    }

    const [summary, byProvider, recentErrors, recentWarnings] = await Promise.all([
      pgQuery(`
        SELECT
          COUNT(*)::int                                             AS total,
          COUNT(*) FILTER (WHERE status = 'error')::int           AS errors,
          COUNT(*) FILTER (WHERE quality_warning IS NOT NULL)::int AS warnings,
          COUNT(*) FILTER (WHERE status = 'success')::int         AS successes,
          ROUND(AVG(duration_ms))::int                            AS avg_duration_ms,
          ROUND(AVG(claude_ms))::int                              AS avg_claude_ms,
          ROUND(AVG(retry_count), 2)                              AS avg_retries
        FROM statics_generation_events
        WHERE created_at >= NOW() - INTERVAL '24 hours'
      `),
      pgQuery(`
        SELECT provider, COUNT(*)::int AS count,
          ROUND(AVG(duration_ms))::int AS avg_ms
        FROM statics_generation_events
        WHERE created_at >= NOW() - INTERVAL '24 hours'
        GROUP BY provider ORDER BY count DESC
      `),
      pgQuery(`
        SELECT created_at, error_message, product_name, angle, provider
        FROM statics_generation_events
        WHERE status = 'error' AND created_at >= NOW() - INTERVAL '24 hours'
        ORDER BY created_at DESC LIMIT 5
      `),
      pgQuery(`
        SELECT created_at, quality_warning, product_name, angle
        FROM statics_generation_events
        WHERE quality_warning IS NOT NULL AND created_at >= NOW() - INTERVAL '24 hours'
        ORDER BY created_at DESC LIMIT 5
      `),
    ]);

    const s = summary[0] || {};
    const errorRate = s.total > 0 ? Math.round((s.errors / s.total) * 100) : 0;
    const warnRate  = s.total > 0 ? Math.round((s.warnings / s.total) * 100) : 0;

    res.json({
      success: true,
      data: {
        period: '24h',
        total_generations: s.total || 0,
        successes: s.successes || 0,
        errors: s.errors || 0,
        quality_warnings: s.warnings || 0,
        error_rate_pct: errorRate,
        warning_rate_pct: warnRate,
        avg_duration_ms: s.avg_duration_ms || null,
        avg_claude_ms: s.avg_claude_ms || null,
        avg_retries: parseFloat(s.avg_retries) || 0,
        by_provider: byProvider,
        recent_errors: recentErrors,
        recent_warnings: recentWarnings,
      },
    });
  } catch (err) {
    res.status(500).json({ success: false, error: { message: err.message } });
  }
});

// ─────────────────────────────────────────────────────────────────────────
// Bulk status update
// ─────────────────────────────────────────────────────────────────────────

router.patch('/creatives/bulk-status', authenticate, async (req, res) => {
  try {
    const { ids, status } = req.body;
    if (!Array.isArray(ids) || ids.length === 0) {
      return res.status(400).json({ success: false, error: { message: 'ids must be a non-empty array' } });
    }
    const validStatuses = ['review', 'approved', 'ready', 'rejected', 'archived'];
    if (!validStatuses.includes(status)) {
      return res.status(400).json({ success: false, error: { message: `Invalid status: ${status}` } });
    }

    const placeholders = ids.map((_, i) => `$${i + 2}`).join(', ');
    await pgQuery(
      `UPDATE spy_creatives SET status = $1, updated_at = NOW() WHERE id IN (${placeholders})`,
      [status, ...ids]
    );

    if (status === 'approved') {
      for (const id of ids) {
        const rows = await pgQuery(`SELECT * FROM spy_creatives WHERE id = $1`, [id]);
        const creative = rows[0];
        if (creative && creative.aspect_ratio !== '9:16' && !creative.parent_creative_id) {
          const existing = await pgQuery(
            "SELECT id FROM spy_creatives WHERE parent_creative_id = $1 AND aspect_ratio = '9:16'",
            [id]
          );
          if (existing.length === 0) {
            generateVariant(creative, '9:16').catch(err =>
              console.error(`[bulkStatus] Auto 9:16 variant error for ${id}:`, err.message)
            );
          }
        }
      }
    }

    res.json({ success: true, data: { updated: ids.length, status } });
  } catch (err) {
    console.error('[staticsGeneration] /creatives/bulk-status error:', err);
    res.status(500).json({ success: false, error: { message: err.message } });
  }
});

// ─────────────────────────────────────────────────────────────────────────
// Backfill launched thumbnails (Meta CDN repair)
// ─────────────────────────────────────────────────────────────────────────

router.get('/repair-thumbnails', authenticate, async (req, res) => {
  try {
    const META_ACCESS_TOKEN = process.env.META_ACCESS_TOKEN || '';
    const META_GRAPH_URL = 'https://graph.facebook.com/v21.0';

    const stale = await pgQuery(
      `SELECT c.id, c.image_url, c.meta_image_hash, l.ad_account_id
       FROM spy_creatives c
       LEFT JOIN statics_launches l ON l.creative_id = c.id
       WHERE c.status = 'launched'
         AND (c.image_url LIKE '%tempfile%' OR c.image_url IS NULL OR c.image_url = '')
         AND c.meta_image_hash IS NOT NULL
         AND c.meta_image_hash != ''
       ORDER BY c.id`
    );

    if (stale.length === 0) {
      return res.json({ success: true, data: { repaired: 0, skipped: 0, message: 'No stale thumbnails found' } });
    }

    console.log(`[repair-thumbnails] Found ${stale.length} stale launched thumbnails to repair`);

    const byAccount = {};
    for (const row of stale) {
      const acct = row.ad_account_id || (process.env.META_AD_ACCOUNT_IDS || '').split(',')[0];
      if (!acct) { continue; }
      if (!byAccount[acct]) byAccount[acct] = [];
      byAccount[acct].push(row);
    }

    let repaired = 0;
    let skipped = 0;
    const errors = [];

    for (const [adAccountId, rows] of Object.entries(byAccount)) {
      const BATCH = 50;
      for (let i = 0; i < rows.length; i += BATCH) {
        const batch = rows.slice(i, i + BATCH);
        const hashes = batch.map(r => r.meta_image_hash);
        const hashParams = hashes.map(h => `hashes[]=${encodeURIComponent(h)}`).join('&');
        const metaUrl = `${META_GRAPH_URL}/${adAccountId}/adimages?${hashParams}&fields=hash,url,url_128&access_token=${META_ACCESS_TOKEN}`;
        let imageMap = {};
        try {
          const mRes = await fetch(metaUrl, { signal: AbortSignal.timeout(15000) });
          if (!mRes.ok) {
            const errText = await mRes.text();
            console.warn(`[repair-thumbnails] Meta API error for ${adAccountId}: ${mRes.status} ${errText.slice(0, 200)}`);
            skipped += batch.length;
            errors.push(`Meta ${mRes.status} for account ${adAccountId}`);
            continue;
          }
          const mData = await mRes.json();
          const imageList = mData.data || [];
          for (const img of imageList) {
            if (img.hash && (img.url || img.url_128)) {
              imageMap[img.hash] = img.url || img.url_128;
            }
          }
        } catch (fetchErr) {
          console.warn(`[repair-thumbnails] Fetch error for ${adAccountId}: ${fetchErr.message}`);
          skipped += batch.length;
          errors.push(fetchErr.message);
          continue;
        }

        for (const row of batch) {
          const cdnUrl = imageMap[row.meta_image_hash];
          if (!cdnUrl) {
            skipped++;
            continue;
          }
          try {
            await pgQuery(
              `UPDATE spy_creatives SET image_url = $1, thumbnail_url = $1, updated_at = NOW() WHERE id = $2`,
              [cdnUrl, row.id]
            );
            console.log(`[repair-thumbnails] ✅ Repaired creative ${row.id} → ${cdnUrl.slice(0, 80)}`);
            repaired++;
          } catch (dbErr) {
            console.error(`[repair-thumbnails] DB update error for creative ${row.id}: ${dbErr.message}`);
            skipped++;
            errors.push(`DB error for ${row.id}: ${dbErr.message}`);
          }
        }
      }
    }

    const noAccount = stale.filter(r => !r.ad_account_id && !(process.env.META_AD_ACCOUNT_IDS || '').split(',')[0]);
    skipped += noAccount.length;

    console.log(`[repair-thumbnails] Done — repaired: ${repaired}, skipped: ${skipped}`);
    res.json({
      success: true,
      data: { found: stale.length, repaired, skipped, errors: errors.length > 0 ? errors : undefined },
    });
  } catch (err) {
    console.error('[staticsGeneration] /repair-thumbnails error:', err);
    res.status(500).json({ success: false, error: { message: err.message } });
  }
});

// ─────────────────────────────────────────────────────────────────────────
// Template classification (Haiku vision)
// ─────────────────────────────────────────────────────────────────────────

let classifyAllProgress = { running: false, total: 0, completed: 0, failed: 0, doc: 0, img: 0, startedAt: null };

const CLASSIFY_PROMPT = `You are classifying advertisement templates to determine their rendering strategy.

Look at this ad template image and answer in JSON:

1. is_document_template: Is the background primarily TEXT (letter, apology, correction notice, editorial, document with paragraphs)? TRUE. Or primarily an IMAGE/product-photo/graphical-design? FALSE.

2. archetype: Best single category from: document | comparison | testimonial | problem_solution | bold_claim | before_after | urgency | us_vs_them | social_proof | native | meme | google_search | apple_notes | statistics | feature_benefit | headline | other

3. angle_tags: 2-4 compatible ad angles from: apology | anti_fake | skeptic | accidental_winner | hater_deflection | ai_chip_pov | promo | urgency | social_proof | blockchain_proof | bold_claim

Respond ONLY with valid JSON:
{"is_document_template":true/false,"archetype":"...","angle_tags":["..."],"confidence":"high|medium|low","reasoning":"one sentence"}`;

async function classifyOneTemplate(template) {
  const { id, name, category, image_url } = template;
  function heuristic() {
    const n = (name || '').toLowerCase();
    const c = (category || '').toLowerCase();
    const isDoc = c.includes('apolog') || n.includes('apolog') || c.includes('correction') ||
      n.includes('statement') || n.includes('letter') || n.includes('official') || n.includes('editorial');
    const isComparison = n.includes('konvert') || n.includes(' vs ') || n.includes('versus') ||
      n.includes('compare') || n.includes('comparison') || n.includes('cancel') ||
      c.includes('comparison') || c.includes('konvert');
    const archetype = isComparison ? 'comparison' :
      c.includes('testimonial') ? 'testimonial' : c.includes('social proof') ? 'social_proof' :
      c.includes('problem') ? 'problem_solution' : c.includes('bold') ? 'bold_claim' :
      c.includes('urgency') ? 'urgency' : c.includes('vs') || c.includes('them') ? 'us_vs_them' :
      c.includes('before') ? 'before_after' : c.includes('native') ? 'native' :
      c.includes('meme') ? 'meme' : c.includes('google') ? 'google_search' :
      c.includes('apple') ? 'apple_notes' : c.includes('statistic') ? 'statistics' :
      c.includes('feature') ? 'feature_benefit' : isDoc ? 'document' : 'other';
    const tagMap = {
      document:['apology','anti_fake','skeptic','hater_deflection'], testimonial:['social_proof','skeptic','accidental_winner'],
      problem_solution:['skeptic','anti_fake','urgency'], bold_claim:['anti_fake','ai_chip_pov','skeptic'],
      before_after:['skeptic','accidental_winner'], urgency:['urgency','promo'], us_vs_them:['anti_fake','hater_deflection'],
      social_proof:['social_proof','accidental_winner'], native:['skeptic','apology','ai_chip_pov'],
      meme:['hater_deflection','accidental_winner'], google_search:['skeptic','anti_fake'],
      apple_notes:['apology','skeptic','accidental_winner'], statistics:['ai_chip_pov','skeptic','blockchain_proof'],
      feature_benefit:['ai_chip_pov','promo','urgency'], headline:['bold_claim','urgency','promo'],
    };
    return { id, is_document_template: isDoc, archetype, angle_tags: tagMap[archetype] || [], classification_method: 'heuristic' };
  }

  if (!image_url || !image_url.startsWith('http')) return heuristic();

  try {
    const payload = {
      model: 'claude-haiku-4-5', max_tokens: 300,
      messages: [{ role: 'user', content: [
        { type: 'image', source: { type: 'url', url: image_url } },
        { type: 'text', text: CLASSIFY_PROMPT },
      ]}],
    };
    const r = await fetch(CLAUDE_API_URL, {
      method: 'POST',
      headers: { 'x-api-key': ANTHROPIC_API_KEY, 'anthropic-version': '2023-06-01', 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
      signal: AbortSignal.timeout(20000),
    });
    if (!r.ok) throw new Error(`Claude ${r.status}`);
    const data = await r.json();
    const text = data.content?.[0]?.text?.trim() || '';
    const m = text.match(/\{[\s\S]*\}/);
    if (!m) throw new Error('No JSON');
    const p = JSON.parse(m[0]);
    return {
      id,
      is_document_template: p.is_document_template === true,
      archetype: p.archetype || 'other',
      angle_tags: Array.isArray(p.angle_tags) ? p.angle_tags : [],
      classification_method: 'claude_vision',
    };
  } catch (err) {
    console.warn(`[classify-all] Vision failed ${id.slice(0,8)} (${(name||'').slice(0,25)}): ${err.message}`);
    return heuristic();
  }
}

router.post('/templates/classify-all', authenticate, async (req, res) => {
  try {
    if (classifyAllProgress.running) {
      return res.json({ success: true, message: `Already running: ${classifyAllProgress.completed}/${classifyAllProgress.total}`, progress: classifyAllProgress });
    }

    const rows = await pgQuery(
      `SELECT id, name, category, image_url FROM statics_templates
       WHERE is_hidden = false AND is_document_template IS NULL ORDER BY id`,
      []
    );
    if (rows.length === 0) {
      return res.json({ success: true, queued: 0, message: 'All templates already classified' });
    }

    classifyAllProgress = { running: true, total: rows.length, completed: 0, failed: 0, doc: 0, img: 0, startedAt: new Date().toISOString() };
    res.json({ success: true, queued: rows.length, message: `Classification started for ${rows.length} unclassified templates` });

    (async () => {
      console.log(`[classify-all] Starting: ${rows.length} templates, batches of 10`);
      for (let i = 0; i < rows.length; i += 10) {
        const batch = rows.slice(i, i + 10);
        const results = await Promise.allSettled(batch.map(classifyOneTemplate));
        for (const r of results) {
          if (r.status === 'fulfilled') {
            const v = r.value;
            try {
              await pgQuery(
                `UPDATE statics_templates SET
                   is_document_template = $1, archetype = $2, angle_tags = $3,
                   classification_method = $4, classified_at = NOW()
                 WHERE id = $5`,
                [v.is_document_template, v.archetype, v.angle_tags, v.classification_method, v.id]
              );
              classifyAllProgress.completed++;
              if (v.is_document_template) classifyAllProgress.doc++; else classifyAllProgress.img++;
            } catch (dbErr) {
              classifyAllProgress.failed++;
              console.error(`[classify-all] DB write failed ${r.value?.id}: ${dbErr.message}`);
            }
          } else {
            classifyAllProgress.failed++;
          }
        }
        if (i + 10 < rows.length) await sleep(500);
      }
      console.log(`[classify-all] Done: ${classifyAllProgress.completed}/${rows.length}`);
      classifyAllProgress.running = false;
    })();
  } catch (err) {
    classifyAllProgress.running = false;
    res.status(500).json({ success: false, error: { message: err.message } });
  }
});

router.get('/templates/classify-all/status', authenticate, async (_req, res) => {
  res.json({ success: true, progress: classifyAllProgress });
});

// Suppress unused-import warnings for helpers kept for future use
void interpolate;
void analyzeAndCacheLayout;

export { getCustomStaticsPrompts, getDefaultStaticsPrompts };

export default router;
