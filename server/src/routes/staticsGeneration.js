// statics — 3-prompt architecture (migration 036)
//
// Pipeline:
//   1. Claude analysis (claude-sonnet-4-6) — sees ref + product, emits JSON brief
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
} from '../utils/staticsPrompts.js';
import { pgQuery } from '../db/pg.js';
import { authenticate } from '../middleware/auth.js';
import { requirePermission } from '../middleware/rbac.js';
import { uploadBuffer, uploadFromUrl, isR2Configured } from '../services/r2.js';

/**
 * NanoBanana returns a tempfile.aiquickdraw.com URL that expires after a few
 * hours. We persist the result so it survives forever:
 *
 *   Tier 1 — R2 with public domain (best, true permanent URL)
 *            Only works if R2_PUBLIC_URL env is set. We try it first.
 *   Tier 2 — Our own DB-backed /tmp-img/ proxy
 *            Downloads the bytes, INSERTs into image_store (Postgres),
 *            returns ${SERVER}/api/v1/statics-generation/tmp-img/{id}.
 *            That endpoint always serves from the DB (image_store survives
 *            server restarts AND tempfile expiry). This is the path used
 *            today since R2_PUBLIC_URL is unset.
 *   Tier 3 — Last-ditch: return the temp URL unchanged. UI cards will go
 *            black in ~3h. Logged loudly.
 */
// Returns null when persistence fails — caller MUST treat null as "do not
// write image_url to spy_creatives; mark the row rejected." This prevents
// the historical leak where a dying kie.ai CDN URL was returned as a
// "best effort" and then expired in ~3h, leaving a black placeholder forever.
async function persistNanoBananaImage(tempUrl, prefix = 'statics-nb') {
  if (!tempUrl) return null;

  const RETRIES = 2; // → 3 attempts total

  // OpenAI's image API returns b64-encoded images as data: URIs. Node fetch()
  // doesn't handle those, so decode + upload directly before falling through
  // to the URL-based path.
  if (typeof tempUrl === 'string' && tempUrl.startsWith('data:image')) {
    if (isR2Configured() && process.env.R2_PUBLIC_URL) {
      try {
        const match = tempUrl.match(/^data:(image\/[^;]+);base64,(.+)$/);
        if (!match) throw new Error('Malformed data-URI');
        const contentType = match[1];
        const buffer = Buffer.from(match[2], 'base64');
        const ext = contentType.includes('jpeg') || contentType.includes('jpg') ? 'jpg' : 'png';
        const { randomUUID } = await import('node:crypto');
        const key = `${prefix}/${randomUUID()}.${ext}`;
        const { uploadBuffer } = await import('../services/r2.js');
        const url = await uploadBuffer(buffer, key, contentType);
        if (!url || !url.startsWith('http')) throw new Error('uploadBuffer returned non-http');
        if (!(await urlIsHealthy(url))) throw new Error('R2 url failed HEAD check');
        return url;
      } catch (err) {
        console.error(`[persistNbImage] data-URI R2 upload failed: ${err.message}`);
        return null;
      }
    }
    // dev fallback: store in DB via the same /tmp-img path
    try {
      const match = tempUrl.match(/^data:(image\/[^;]+);base64,(.+)$/);
      if (!match) return null;
      const buf = Buffer.from(match[2], 'base64');
      const id = await storeTempImage(buf, match[1]);
      const srv = process.env.RENDER_EXTERNAL_URL || `http://localhost:${process.env.PORT || 3000}`;
      return `${srv}/api/v1/statics-generation/tmp-img/${id}`;
    } catch (err) {
      console.error(`[persistNbImage] data-URI DB-proxy persist failed: ${err.message}`);
      return null;
    }
  }

  // Tier 1: R2 with retries + HEAD-verify. Skipped only in dev (no R2 creds).
  if (isR2Configured() && process.env.R2_PUBLIC_URL) {
    for (let attempt = 0; attempt <= RETRIES; attempt++) {
      try {
        const { url } = await uploadFromUrl(tempUrl, prefix);
        if (!url || !url.startsWith('http')) throw new Error('uploadFromUrl returned non-http');
        if (!(await urlIsHealthy(url))) throw new Error('R2 url failed HEAD check');
        return url;
      } catch (err) {
        const backoff = 500 * Math.pow(2, attempt);
        if (attempt < RETRIES) {
          console.warn(`[persistNbImage] R2 attempt ${attempt + 1}/${RETRIES + 1} failed: ${err.message} — retrying in ${backoff}ms`);
          await new Promise(r => setTimeout(r, backoff));
        } else {
          console.error(`[persistNbImage] R2 unavailable after ${RETRIES + 1} attempts: ${err.message}`);
        }
      }
    }
    // R2 was supposed to work but all retries failed.
    // Returning NULL is deliberate — DO NOT fall back to /tmp-img (DB-truncate
    // killed every previous /tmp-img URL) or the raw CDN URL (expires in ~3h).
    return null;
  }

  // Tier 2 (dev only, R2 not configured): DB-backed /tmp-img store.
  try {
    const r = await fetch(tempUrl, { signal: AbortSignal.timeout(30000) });
    if (!r.ok) throw new Error(`download failed: ${r.status}`);
    const buf = Buffer.from(await r.arrayBuffer());
    const mime = r.headers.get('content-type') || detectMime(buf) || 'image/png';
    const id = await storeTempImage(buf, mime);
    const srv = process.env.RENDER_EXTERNAL_URL || `http://localhost:${process.env.PORT || 3000}`;
    return `${srv}/api/v1/statics-generation/tmp-img/${id}`;
  } catch (err) {
    console.error(`[persistNbImage] DB-proxy persist failed: ${err.message}`);
    return null;
  }
}

// HEAD-fetch a URL with a short timeout, return true only if 2xx.
async function urlIsHealthy(url, timeoutMs = 8000) {
  if (!url || typeof url !== 'string' || !url.startsWith('http')) return false;
  try {
    const r = await fetch(url, { method: 'HEAD', signal: AbortSignal.timeout(timeoutMs) });
    return r.ok;
  } catch { return false; }
}

// Retry an async fn with exponential backoff. Used to wrap NanoBanana
// submit + poll so transient errors don't kill a whole generation.
async function withRetry(fn, label, maxAttempts = 3) {
  let lastErr;
  for (let i = 0; i < maxAttempts; i++) {
    try { return await fn(); }
    catch (err) {
      lastErr = err;
      if (i < maxAttempts - 1) {
        const backoff = 1500 * Math.pow(2, i); // 1.5s, 3s, 6s
        console.warn(`[${label}] attempt ${i + 1}/${maxAttempts} failed: ${err.message} — retrying in ${backoff}ms`);
        await new Promise(r => setTimeout(r, backoff));
      }
    }
  }
  throw lastErr;
}
import { submitToNanoBanana, pollNanoBanana } from '../services/imageGeneration.js';
import { getEngine, DEFAULT_ENGINE, listEngines } from '../services/imageEngines.js';
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

// GET /r2-canary — unauthenticated probe that uploads a tiny test blob to R2
// and returns the resulting public URL (or the error). Lets an external
// operator verify R2 end-to-end without needing CRON_SECRET. Idempotent —
// overwrites the same key on every call.
//
// On success body is { ok: true, url: "https://pub-xxx.r2.dev/r2-canary.txt",
// configured: { account, accessKey, secret, publicUrl }, fetchable: true|false }.
// fetchable is the result of HEADing the returned URL from the server (proves
// the bucket is publicly accessible end-to-end).
router.get('/r2-canary', async (_req, res) => {
  const configured = {
    account: !!process.env.R2_ACCOUNT_ID,
    accessKey: !!process.env.R2_ACCESS_KEY_ID,
    secret: !!process.env.R2_SECRET_ACCESS_KEY,
    publicUrl: !!process.env.R2_PUBLIC_URL,
  };
  if (!process.env.R2_PUBLIC_URL || !isR2Configured()) {
    return res.json({ ok: false, configured, error: 'R2 not fully configured' });
  }
  try {
    const buf = Buffer.from('r2-canary ok @ ' + new Date().toISOString());
    const url = await uploadBuffer(buf, 'r2-canary.txt', 'text/plain');
    if (!url || !url.startsWith('http')) {
      return res.json({ ok: false, configured, error: `uploadBuffer returned non-http: ${(url||'').slice(0,40)}` });
    }
    // Verify the URL is publicly fetchable
    let fetchable = false, fetchStatus = null;
    try {
      const r = await fetch(url, { method: 'GET', signal: AbortSignal.timeout(10000) });
      fetchStatus = r.status;
      fetchable = r.ok;
    } catch (e) {
      fetchStatus = `fetch_error: ${e.message}`;
    }
    res.json({ ok: true, url, fetchable, fetchStatus, configured });
  } catch (err) {
    res.json({ ok: false, configured, error: err.message, errorCode: err.code, errorName: err.name });
  }
});

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
  // Telemetry: log every miss with the id so we can correlate which
  // spy_creatives rows just lost their preview. Sampled to 1/10 to keep
  // logs sane under bot traffic.
  if (Math.random() < 0.1) {
    console.warn(`[tmp-img:404] id=${req.params.id} ua="${(req.headers['user-agent']||'').slice(0,60)}"`);
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
    res.status(500).json({ success: false, error: { message: err.message } });
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
    res.status(500).json({ success: false, error: { message: err.message } });
  }
}

// ─────────────────────────────────────────────────────────────────────────
// POST /repair-all-previews — ONE BUTTON to fix every broken preview.
//
// Runs the full triage in-process, synchronously, and returns per-mode counts:
//   1. backsync   — Mode B: expired CDN URLs → R2 (or /tmp-img/ fallback)
//   2. repair-thumbnails  — Mode D: launched ads via Meta Graph → R2 mirror
//   3. regenerate-broken  — Mode A: dead /tmp-img/ refs → Claude+NB → R2
//   4. heal-zombies       — Mode C: archive previews with no image AND no reference
//
// Auth: JWT or CRON_SECRET. Self-fetches sub-routes so each runs with the
// caller's credentials. Bypasses the 30-min auto-trigger rate limit.
//
// MUST be defined BEFORE `router.use(authenticate)` below — the global auth
// middleware would otherwise 401 every call before the per-route secret
// check could run.
// ─────────────────────────────────────────────────────────────────────────
router.post('/repair-all-previews', async (req, res) => {
  const cronSecret = process.env.CRON_SECRET;
  const provided   = req.headers['x-cron-secret'];
  const secretAuth = !!(cronSecret && provided === cronSecret);
  if (secretAuth) return _doRepairAllPreviews(req, res, cronSecret);
  return authenticate(req, res, () => _doRepairAllPreviews(req, res, null));
});

// GET /repair-thumbnails — sub-route called by /repair-all-previews; also
// safe to call directly with CRON_SECRET. Body defined later in this file.
router.get('/repair-thumbnails', async (req, res) => {
  const cs = process.env.CRON_SECRET;
  if (cs && req.headers['x-cron-secret'] === cs) return _doRepairThumbnails(req, res);
  return authenticate(req, res, () => _doRepairThumbnails(req, res));
});

// POST /regenerate-broken-previews — sub-route of /repair-all-previews and
// also called directly by /creatives/pipeline auto-fix triggers + crons.
router.post('/regenerate-broken-previews', async (req, res) => {
  const cs = process.env.CRON_SECRET;
  if (cs && req.headers['x-cron-secret'] === cs) return _doRegenerateBrokenPreviews(req, res);
  return authenticate(req, res, () => _doRegenerateBrokenPreviews(req, res));
});

async function _doRepairAllPreviews(req, res, cronSecretForSubFetch) {
  const base = process.env.RENDER_EXTERNAL_URL || `http://localhost:${process.env.PORT || 3000}`;
  const t0 = Date.now();

  // Forward the caller's auth on sub-route HTTP calls so existing
  // route-level guards keep working without changes.
  const authHeaders = {};
  if (req.headers.authorization) authHeaders.authorization = req.headers.authorization;
  if (cronSecretForSubFetch) authHeaders['x-cron-secret'] = cronSecretForSubFetch;

  const result = { backsync: null, repair_thumbnails: null, regenerate_broken: null, heal_zombies: null };
  const errors = [];

  // 1. Backsync (in-process — no HTTP self-fetch needed)
  try {
    result.backsync = await backsyncDoomedUrls();
  } catch (err) { errors.push(`backsync: ${err.message}`); }

  // 2. Repair launched thumbnails via Meta Graph (HTTP self-fetch)
  try {
    const r = await fetch(`${base}/api/v1/statics-generation/repair-thumbnails`, {
      method: 'GET', headers: authHeaders, signal: AbortSignal.timeout(180_000),
    });
    const body = await r.json().catch(() => ({}));
    result.repair_thumbnails = body?.data || { error: `status ${r.status}` };
  } catch (err) { errors.push(`repair-thumbnails: ${err.message}`); }

  // 3. Regenerate truly-broken previews (Claude + NB → R2)
  try {
    const r = await fetch(`${base}/api/v1/statics-generation/regenerate-broken-previews`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', ...authHeaders },
      body: JSON.stringify({}),
      signal: AbortSignal.timeout(15_000),
    });
    const body = await r.json().catch(() => ({}));
    result.regenerate_broken = body?.data || { error: `status ${r.status}` };
  } catch (err) { errors.push(`regenerate-broken: ${err.message}`); }

  // 4. Heal zombies (archive previews with no image AND no reference)
  try {
    const r = await fetch(`${base}/api/v1/statics-generation/heal-zombies`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', ...authHeaders },
      body: JSON.stringify({}),
      signal: AbortSignal.timeout(30_000),
    });
    const body = await r.json().catch(() => ({}));
    result.heal_zombies = { archived: body?.archived ?? 0 };
  } catch (err) { errors.push(`heal-zombies: ${err.message}`); }

  const elapsed_ms = Date.now() - t0;
  console.log(`[repair-all-previews] done in ${elapsed_ms}ms — backsync=${JSON.stringify(result.backsync)} repair=${JSON.stringify(result.repair_thumbnails)} regen=${JSON.stringify(result.regenerate_broken)} zombies=${JSON.stringify(result.heal_zombies)}`);
  res.json({
    success: errors.length === 0,
    data: { ...result, elapsed_ms, errors: errors.length > 0 ? errors : undefined },
  });
}

// POST /meta-ads/repair-thumbnails — must be ABOVE the global authenticate
// so the CRON_SECRET fast-path actually fires (same hoist pattern as
// /repair-all-previews above). Body lives near the rest of the meta-ads
// endpoints below.
router.post('/meta-ads/repair-thumbnails', async (req, res) => {
  const cs = process.env.CRON_SECRET;
  if (cs && req.headers['x-cron-secret'] === cs) return _doMetaAdsRepairThumbnails(req, res);
  return authenticate(req, res, () => _doMetaAdsRepairThumbnails(req, res));
});

// ── League maintenance endpoints (CRON_SECRET) ──
// Two surgical admin actions exposed for the operator without round-tripping
// through the UI (they're one-shot operations). Both are CRON_SECRET-gated
// and BELOW the global auth so the fast path fires.

// POST /league/clear-imports — wipe all 'imported_from=league' rows.
// Used after the operator decides the auto-sync (or manual imports) pulled
// too many references and they want a clean slate. PROTECTS:
//   • status='launched'        (live ads — never touch)
//   • parent_creative_id IS NOT NULL (children of approved/launched roots)
// EVERYTHING ELSE under imported_from='league' (including is_reference=TRUE
// rows with status='ready' from the league sync flow) IS wiped — these are
// pure references, not generated work, so wiping them is safe.
router.post('/league/clear-imports', async (req, res) => {
  const cs = process.env.CRON_SECRET;
  if (!cs || req.headers['x-cron-secret'] !== cs) return res.status(401).json({ error: 'unauthorized' });
  try {
    const result = await pgQuery(
      `DELETE FROM spy_creatives
        WHERE imported_from = 'league'
          AND status <> 'launched'
          AND parent_creative_id IS NULL
        RETURNING id`,
      []
    );
    return res.json({ success: true, deleted: result.length });
  } catch (e) {
    console.error('[league/clear-imports] error:', e);
    return res.status(500).json({ success: false, error: { message: e.message } });
  }
});

// POST /league/disable-all-auto-sync — flip auto_sync_enabled=false on every
// existing league_brand_configs row.
router.post('/league/disable-all-auto-sync', async (req, res) => {
  const cs = process.env.CRON_SECRET;
  if (!cs || req.headers['x-cron-secret'] !== cs) return res.status(401).json({ error: 'unauthorized' });
  try {
    const result = await pgQuery(
      `UPDATE league_brand_configs
          SET auto_sync_enabled = FALSE, updated_at = NOW()
        WHERE auto_sync_enabled = TRUE
        RETURNING brand_id`,
      []
    );
    return res.json({ success: true, disabled: result.length });
  } catch (e) {
    console.error('[league/disable-all-auto-sync] error:', e);
    return res.status(500).json({ success: false, error: { message: e.message } });
  }
});

router.use(authenticate, requirePermission('statics-generation', 'access'));
const sleep = (ms) => new Promise(r => setTimeout(r, ms));

// ─────────────────────────────────────────────────────────────────────────
// Task result store (in-memory) — keyed by taskId for /status/:taskId polling
// ─────────────────────────────────────────────────────────────────────────

const taskResults = new Map();
const TASK_RESULT_TTL = 15 * 60 * 1000;
const MAX_TASK_RESULTS = 200;
// Watchdog timeout for in-flight /generate pipelines. If the pipeline hasn't
// reported a result this long after the request, mark the task as error
// instead of letting the UI spinner block forever.
const WATCHDOG_MS = 8 * 60 * 1000;

function storeTaskResult(taskId, result) {
  if (taskResults.size >= MAX_TASK_RESULTS) {
    const oldest = taskResults.keys().next().value;
    taskResults.delete(oldest);
  }
  taskResults.set(taskId, result);
  setTimeout(() => taskResults.delete(taskId), TASK_RESULT_TTL);
}

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

// Pre-warm the Meta Graph account-name cache so the first operator who
// opens the Meta Import modal after Render restart doesn't pay the cold-
// cache penalty (up to 8s × N accounts). Fire-and-forget — the handler
// itself still works without the cache and just falls back to IDs.
// Delayed 5s so it doesn't compete with the migration runs above for
// the initial Postgres connection pool.
setTimeout(() => {
  const ids = (process.env.META_AD_ACCOUNT_IDS || '').split(',').map(s => s.trim()).filter(Boolean);
  if (ids.length === 0) return;
  // resolveMetaAccountNames is defined later in this module (hoisted via
  // function declaration). Wrap in try/catch so an early-boot Meta Graph
  // outage doesn't crash the server.
  Promise.resolve()
    .then(() => resolveMetaAccountNames(ids))
    .then(map => console.log(`[boot] Meta account name cache prewarmed: ${map.size}/${ids.length} resolved`))
    .catch(err => console.warn('[boot] Meta account name prewarm failed:', err.message));
}, 5000);

// Reference-safe image_store GC.
// Old behaviour was a flat 7-day DELETE, which orphaned every spy_creatives row
// whose image_url pointed at /tmp-img/<id> once the id aged out — that's the
// recurring "preview missing on ready-to-launch batch" bug.
//
// New behaviour:
//   (a) Bump the safety TTL from 7 → 90 days so even references stay alive
//       through long pipelines.
//   (b) Exclude any image_store row still referenced by a live row in
//       spy_creatives (image_url + reference_thumbnail). statics_launches
//       points at the spy_creatives row via creative_id FK — the preview
//       URL itself lives on spy_creatives.image_url, which the first guard
//       already covers, so no separate check is needed.
//   (c) Keep the cadence at 6h — table is tiny once the dead rows are gone.
async function gcImageStoreOnce() {
  try {
    const result = await pgQuery(
      `DELETE FROM image_store s
       WHERE s.created_at < NOW() - INTERVAL '90 days'
         AND NOT EXISTS (
           SELECT 1 FROM spy_creatives c
            WHERE c.image_url           LIKE '%/tmp-img/' || s.id
               OR c.reference_thumbnail LIKE '%/tmp-img/' || s.id
         )
       RETURNING id`,
      [], { timeout: 30000 }
    );
    if (result.length > 0) {
      console.log(`[imageStore] GC: removed ${result.length} unreferenced rows older than 90d`);
    }
  } catch (err) {
    console.warn('[imageStore] GC failed:', err.message);
  }
}
setInterval(gcImageStoreOnce, 6 * 60 * 60 * 1000);
// One pass at boot so old broken state heals immediately after the fix deploys.
setTimeout(() => { gcImageStoreOnce().catch(() => {}); }, 30_000);

// ─────────────────────────────────────────────────────────────────────────
// Doomed-CDN-URL backsync sweeper. The structural "never again" guarantee.
//
// persistNanoBananaImage and the variant-spawn store have fallback paths
// that write a raw 3-hour-expiring CDN URL to spy_creatives.image_url when
// Tier 2 fails. This sweeper runs every 10 min, scans for those patterns,
// fetches the URL while still alive, persists to image_store, and rewrites
// the row to /tmp-img/<id>. Catches any leaked CDN URL automatically — even
// from code paths we haven't audited.
//
// Patterns matched (covers every NB provider we've used):
//   - tempfile.aiquickdraw.com (current kie.ai backing host)
//   - cdn.kie.ai / kie.ai (legacy)
//   - aiquickdraw.com (any subdomain)
//   - file.kieai.app (alt CDN)
//
// Idempotent — only touches rows whose URL still 200s. Failed fetches are
// left for /regenerate-broken-previews (Claude+NB regen path).
const DOOMED_CDN_PATTERNS = [
  '%tempfile.aiquickdraw.com%',
  '%cdn.kie.ai%',
  '%kie.ai/%',
  '%aiquickdraw.com%',
  '%file.kieai.app%',
];
// ─────────────────────────────────────────────────────────────────────────
// Persist any doomed URL to a permanent home.
// Tier 1: R2 (when configured) — permanent forever
// Tier 2: /tmp-img/ DB-backed proxy — falls back if R2 fails
// Returns: { url } on success or null if the source URL is already dead
// ─────────────────────────────────────────────────────────────────────────
async function persistAnyUrlToR2(srcUrl, r2Prefix = 'backsync') {
  if (!srcUrl) return null;
  const useR2 = isR2Configured() && process.env.R2_PUBLIC_URL;
  // Tier 1: R2 — uploadFromUrl fetches+uploads atomically
  if (useR2) {
    try {
      const { url } = await uploadFromUrl(srcUrl, r2Prefix);
      if (url && url.startsWith('http')) return { url };
    } catch (_err) {
      // Fall through to Tier 2
    }
  }
  // Tier 2: /tmp-img/ DB-backed (used when R2 not configured OR R2 upload failed)
  try {
    const r = await fetch(srcUrl, { signal: AbortSignal.timeout(20000) });
    if (!r.ok) return null;
    const buf = Buffer.from(await r.arrayBuffer());
    const mime = r.headers.get('content-type') || detectMime(buf) || 'image/png';
    const newId = await storeTempImage(buf, mime);
    const srv = process.env.RENDER_EXTERNAL_URL || `http://localhost:${process.env.PORT || 3000}`;
    return { url: `${srv}/api/v1/statics-generation/tmp-img/${newId}` };
  } catch {
    return null;
  }
}

let _backsyncInFlight = false;
async function backsyncDoomedUrls() {
  if (_backsyncInFlight) return { backed: 0, dead: 0, scanned: 0, skipped: 'in-flight' };
  _backsyncInFlight = true;
  try {
    const sql = `
      SELECT id, image_url
      FROM spy_creatives
      WHERE image_url IS NOT NULL
        AND COALESCE(is_reference, FALSE) = FALSE
        AND (${DOOMED_CDN_PATTERNS.map((_, i) => `image_url LIKE $${i + 1}`).join(' OR ')})
      ORDER BY updated_at DESC NULLS LAST, created_at DESC
      LIMIT 200
    `;
    const rows = await pgQuery(sql, DOOMED_CDN_PATTERNS, { timeout: 15000 });
    if (rows.length === 0) return { backed: 0, dead: 0, scanned: 0 };

    let backed = 0, dead = 0;
    const useR2 = isR2Configured() && process.env.R2_PUBLIC_URL;
    for (const row of rows) {
      const persisted = await persistAnyUrlToR2(row.image_url, 'backsync-r2');
      if (!persisted) { dead++; continue; }
      try {
        await pgQuery(
          'UPDATE spy_creatives SET image_url = $1, updated_at = NOW() WHERE id = $2',
          [persisted.url, row.id]
        );
        backed++;
      } catch { dead++; }
    }
    const target = useR2 ? 'R2' : 'tmp-img';
    if (backed > 0 || dead > 0) {
      console.log(`[backsync] CDN-URL → ${target}: backed=${backed} dead=${dead} (of ${rows.length} scanned)`);
    }
    return { backed, dead, scanned: rows.length, target };
  } catch (err) {
    console.warn('[backsync] sweep failed:', err.message);
    return { backed: 0, dead: 0, scanned: 0, error: err.message };
  } finally {
    _backsyncInFlight = false;
  }
}
// Tightened from 10 min → 5 min: with R2 target, this is now durable + low-cost.
setInterval(() => { backsyncDoomedUrls().catch(() => {}); }, 5 * 60 * 1000);
// First pass 60s after boot so any URL that's about to expire is captured.
setTimeout(() => { backsyncDoomedUrls().catch(() => {}); }, 60_000);

// ─────────────────────────────────────────────────────────────────────────
// Boot-time image_store → R2 auto-migrator. Once R2_PUBLIC_URL is live and
// the canary upload passes, this drains the entire image_store table in
// 200-row chunks with 15s pauses between chunks. Idempotent + resumable
// (uses image_store_migration tracking table). Stops cleanly when:
//   - R2 is not configured (one-time log line, then no-op)
//   - The canary upload fails (logs the error, then waits a full chunk
//     interval before retrying — handles transient credential issues)
//   - The image_store has nothing left to migrate
// On each successful round we log a one-liner so an operator can tail logs.
// ─────────────────────────────────────────────────────────────────────────
let _bootMigratorStarted = false;
async function bootR2Canary() {
  if (!process.env.R2_PUBLIC_URL || !isR2Configured()) return { ok: false, why: 'not_configured' };
  try {
    const buf = Buffer.from('r2-canary boot @ ' + new Date().toISOString());
    const url = await uploadBuffer(buf, 'r2-canary-boot.txt', 'text/plain');
    if (!url || !url.startsWith('http')) return { ok: false, why: `non_http: ${(url||'').slice(0,40)}` };
    return { ok: true, url };
  } catch (err) {
    return { ok: false, why: err.message };
  }
}

async function bootMigratorChunk() {
  if (!process.env.R2_PUBLIC_URL || !isR2Configured()) return { done: true, processed: 0 };

  // Ensure tracking table
  await pgQuery(`
    CREATE TABLE IF NOT EXISTS image_store_migration (
      id TEXT PRIMARY KEY,
      r2_url TEXT NOT NULL,
      migrated_at TIMESTAMPTZ DEFAULT NOW(),
      spy_creatives_updated INT DEFAULT 0
    )
  `).catch(() => {});

  const todo = await pgQuery(`
    SELECT s.id, s.data, s.content_type
    FROM image_store s
    LEFT JOIN image_store_migration m ON m.id = s.id
    WHERE m.id IS NULL
    ORDER BY s.created_at ASC
    LIMIT 50
  `, [], { timeout: 120000 });

  if (todo.length === 0) return { done: true, processed: 0 };

  const srv = process.env.RENDER_EXTERNAL_URL || `http://localhost:${process.env.PORT || 3000}`;
  const tmpImgPrefix = `${srv}/api/v1/statics-generation/tmp-img/`;
  let ok = 0, fail = 0, rewriteTotal = 0;
  const CONCURRENCY = 6;
  let cursor = 0;

  async function processOne(row) {
    try {
      const buf = Buffer.isBuffer(row.data) ? row.data : Buffer.from(row.data);
      const ext = (row.content_type || '').includes('jpeg') || (row.content_type || '').includes('jpg') ? 'jpg' : 'png';
      const key = `image-store-backfill/${row.id}.${ext}`;
      const r2Url = await uploadBuffer(buf, key, row.content_type || 'image/png');
      if (!r2Url || !r2Url.startsWith('http')) throw new Error('non-http url returned');
      const oldUrl = `${tmpImgPrefix}${row.id}`;
      const upd1 = await pgQuery('UPDATE spy_creatives SET image_url = $1 WHERE image_url = $2 RETURNING id', [r2Url, oldUrl]);
      const upd2 = await pgQuery('UPDATE spy_creatives SET reference_thumbnail = $1 WHERE reference_thumbnail = $2 RETURNING id', [r2Url, oldUrl]);
      const updates = upd1.length + upd2.length;
      rewriteTotal += updates;
      await pgQuery(
        `INSERT INTO image_store_migration (id, r2_url, spy_creatives_updated)
         VALUES ($1, $2, $3)
         ON CONFLICT (id) DO UPDATE SET r2_url = EXCLUDED.r2_url, migrated_at = NOW()`,
        [row.id, r2Url, updates]
      );
      ok++;
    } catch (err) {
      fail++;
      if (fail <= 3) console.error(`[migrate-r2-boot ${row.id.slice(0,8)}] ❌ ${err.message}`);
    }
  }

  async function worker() {
    while (true) {
      const i = cursor++;
      if (i >= todo.length) return;
      await processOne(todo[i]);
    }
  }
  await Promise.all(Array.from({ length: CONCURRENCY }, () => worker()));
  console.log(`[migrate-r2-boot] chunk: ok=${ok} fail=${fail} rewrites=${rewriteTotal} (chunk size ${todo.length})`);
  return { done: false, processed: todo.length, ok, fail, rewrites: rewriteTotal };
}

async function bootMigratorLoop() {
  if (_bootMigratorStarted) return;
  _bootMigratorStarted = true;
  // Canary first
  const c = await bootR2Canary();
  if (!c.ok) {
    console.warn(`[migrate-r2-boot] canary failed: ${c.why} — will retry in 5 min`);
    setTimeout(() => { _bootMigratorStarted = false; bootMigratorLoop().catch(() => {}); }, 5 * 60 * 1000);
    return;
  }
  console.log(`[migrate-r2-boot] canary OK → ${c.url}`);
  // Drain in chunks
  while (true) {
    let r;
    try { r = await bootMigratorChunk(); }
    catch (err) {
      console.error('[migrate-r2-boot] chunk error:', err.message);
      await new Promise(rs => setTimeout(rs, 30_000));
      continue;
    }
    if (r.done) {
      console.log('[migrate-r2-boot] DONE — image_store fully migrated to R2');
      return;
    }
    // 15s pause between chunks so we don't saturate R2/DB/the event loop
    await new Promise(rs => setTimeout(rs, 15_000));
  }
}
// Start 90s after boot so the deploy is fully warm before we start uploading.
setTimeout(() => { bootMigratorLoop().catch(() => {}); }, 90_000);

// ─────────────────────────────────────────────────────────────────────────
// PREVIEW WATCHDOG — Part 2 of "fix broken previews once and for all"
//
// Every 10 min: scan recent (last 24h) creatives that look broken or
// stuck, and self-heal them.
//
//   - Rows with no image_url + a reference_thumbnail + a product_id
//       → kick /regenerate-broken-previews (regen via Claude+NB → R2)
//   - Rows with no image_url + no reference (orphan)
//       → archive with a clear note (operator can re-queue if intentional)
//   - Rows stuck in 'generating' for > 15 min (NB call hung / lost)
//       → kick regen if they have a reference, else archive
//
// Idempotent: regen helper queries fresh each run, already-fixed rows
// fall out of the scan naturally. _watchdogInFlight stops overlapping runs.
// ─────────────────────────────────────────────────────────────────────────
let _watchdogInFlight = false;

async function watchdogScan() {
  if (_watchdogInFlight) {
    console.log('[watchdog] previous run still in flight, skipping');
    return;
  }
  _watchdogInFlight = true;
  try {
    const broken = await pgQuery(`
      SELECT id, product_id, reference_thumbnail, aspect_ratio, status, created_at
      FROM spy_creatives
      WHERE status IN ('generating', 'review', 'approved', 'ready', 'launched')
        AND COALESCE(is_reference, FALSE) = FALSE
        AND created_at > NOW() - INTERVAL '24 hours'
        AND (
          image_url IS NULL OR image_url = ''
          OR (status = 'generating' AND created_at < NOW() - INTERVAL '15 minutes')
        )
      ORDER BY created_at DESC
      LIMIT 100
    `);

    if (broken.length === 0) return; // quiet — nothing to do

    let regenerable = 0;
    let archived = 0;

    for (const row of broken) {
      if (row.reference_thumbnail && row.product_id) {
        regenerable++;
      } else {
        try {
          await pgQuery(
            `UPDATE spy_creatives
             SET status = 'archived',
                 review_notes = COALESCE(NULLIF(review_notes, ''), 'watchdog: no reference_thumbnail or product_id — cannot auto-regen'),
                 updated_at = NOW()
             WHERE id = $1 AND status != 'archived'`,
            [row.id]
          );
          archived++;
        } catch (err) {
          console.warn(`[watchdog] archive failed for ${row.id}: ${err.message}`);
        }
      }
    }

    if (regenerable > 0) {
      // Kick regen — it self-queries the broken set + processes with
      // concurrency=4 via setImmediate. Fire and don't wait — the next
      // watchdog tick will see the results.
      const fakeReq = { body: {} };
      const fakeRes = {
        json: () => {},
        status: () => ({ json: () => {} }),
      };
      _doRegenerateBrokenPreviews(fakeReq, fakeRes).catch(err =>
        console.error(`[watchdog] regen kick failed: ${err.message}`)
      );
    }

    console.log(`[watchdog] scanned=${broken.length} regenerable=${regenerable} archived=${archived}`);
  } catch (err) {
    console.error('[watchdog] scan failed:', err.message);
  } finally {
    _watchdogInFlight = false;
  }
}

// First run 2 min after boot (lets bootMigratorLoop warm up first), then
// every 10 min. Both timers survive process lifetime; no clearInterval needed.
setTimeout(() => { watchdogScan().catch(() => {}); }, 120_000);
setInterval(() => { watchdogScan().catch(() => {}); }, 10 * 60 * 1000);

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
    res.status(500).json({ success: false, error: { message: err.message } });
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
    res.status(500).json({ success: false, error: { message: err.message } });
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

// ── Meta App Diagnostic & Live Mode Toggle ──
router.get('/meta-app-diagnose', authenticate, async (req, res) => {
  try {
    const info = await diagnoseMetaApp();
    res.json({ success: true, data: info });
  } catch (err) {
    res.status(500).json({ success: false, error: { message: err.message } });
  }
});

router.post('/meta-app-go-live', authenticate, async (req, res) => {
  try {
    const result = await switchAppToLiveMode();
    res.json({ success: true, data: result });
  } catch (err) {
    res.status(500).json({ success: false, error: { message: err.message } });
  }
});

// ─────────────────────────────────────────────────────────────────────────
// API / pipeline constants and helpers
// ─────────────────────────────────────────────────────────────────────────

const ANTHROPIC_API_KEY  = process.env.ANTHROPIC_API_KEY || '';
const NANOBANANA_API_KEY = process.env.NANOBANANA_API_KEY || '';
const CLAUDE_API_URL     = 'https://api.anthropic.com/v1/messages';
// Sonnet 4.6 is ~3-4× faster than Opus 4.5 and quality is more than sufficient
// for vision + JSON copy adaptation. Total /generate wall time dropped ~25s → ~8s.
// (Opus only wins on hard reasoning tasks, not for "describe image + adapt copy".)
const CLAUDE_MODEL       = 'claude-sonnet-4-6';

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

/**
 * Pull the first product image (data URI) from a product_profiles row.
 * Handles both: (a) JSONB column auto-parsed to JS array by `pg`, and
 * (b) TEXT column that comes back as a JSON-encoded string.
 * Returns null if no image is found.
 */
function firstProductImageFromRow(p) {
  let pi = p?.product_images;
  if (!pi) return null;
  if (typeof pi === 'string') {
    // TEXT column with JSON content — must parse
    try { pi = JSON.parse(pi); } catch { return null; }
  }
  if (Array.isArray(pi) && pi.length > 0) {
    const first = pi[0];
    if (typeof first === 'string' && first.length > 10) return first;
    if (first && typeof first === 'object' && first.url) return first.url;
  }
  return null;
}

async function ensureHttpUrlGlobal(url, label = 'img') {
  const GLOBAL_SERVER_URL = process.env.RENDER_EXTERNAL_URL || `http://localhost:${process.env.PORT || 3000}`;
  if (!url) return url;
  if (url.startsWith('/')) return `${GLOBAL_SERVER_URL}${url}`;
  if (!url.startsWith('data:image')) return url;
  const m = url.match(/^data:(image\/[^;]+);base64,(.+)$/);
  if (!m) return url;
  const buf = Buffer.from(m[2], 'base64');

  // Try R2 first if configured AND we have a public URL set up.
  // If R2_PUBLIC_URL is missing, uploadBuffer returns `r2://bucket/key` which
  // is NOT fetchable by external services (Kie.ai rejects with
  // "image_urls file type not supported"). Fall back to tmp-img in that case.
  if (isR2Configured() && process.env.R2_PUBLIC_URL) {
    const ext = m[1].includes('png') ? 'png' : 'jpg';
    const key = `statics-${label}/${crypto.randomUUID()}.${ext}`;
    const r2Url = await uploadBuffer(buf, key, m[1]);
    if (r2Url.startsWith('http')) return r2Url;
    console.warn(`[ensureHttpUrlGlobal] R2 returned non-HTTP url "${r2Url.slice(0,30)}..." — falling back to tmp-img`);
  }
  const id = await storeTempImage(buf, m[1]);
  return `${GLOBAL_SERVER_URL}/api/v1/statics-generation/tmp-img/${id}`;
}

// ─────────────────────────────────────────────────────────────────────────
// Statics prompt settings (3-prompt architecture)
// ─────────────────────────────────────────────────────────────────────────

// PROMPT KEYS — Claude analysis is shared across engines (same JSON brief).
// Each image engine has its own renderer prompt template; ai_adjustment is
// shared because both engines accept the same correction instruction.
const STATICS_PROMPT_KEYS = ['claude_analysis', 'nanobanana_image', 'openai_image', 'ai_adjustment'];

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

    openai_image:
`Generate a high-quality static ad image for {{PRODUCT_NAME}}.

PRODUCT (the ONLY visual element that should come from the attached image):
{{PRODUCT_INSTRUCTION}}

SCENE & LAYOUT:
{{VISUAL_CHANGES}}

TEXT OVERLAYS (render as styled typography matching the reference ad's typography style):
{{TEXT_SWAPS}}

CHARACTERS:
- Exactly {{PEOPLE_COUNT}} people visible. If the reference had none, render none.
- {{CHARACTER_ADAPTATION}}

ABSOLUTE RULES:
{{PRODUCT_RULE}}
- No additional people, faces, or text beyond what is listed above.
- Hands must have exactly 5 fingers with natural anatomy.
- Photorealistic rendering — match the reference ad's medium (real photo vs designed graphic).
- High input fidelity to the attached product image — preserve exact shape, color, branding.

OUTPUT: a single completed ad creative ready for Meta delivery.`,

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

// (analyzeAndCacheLayout removed — dead code per 2026-05-28 audit. The
//  layout-map caching path is no longer used by the 3-prompt pipeline; the
//  exported buildLayoutAnalysisPrompt is still available for any future
//  template-classification helper.)

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
  if (!reqRefImage) return res.status(400).json({ success: false, error: { message: 'reference_image_url is required' } });
  if (!reqProduct)  return res.status(400).json({ success: false, error: { message: 'product is required' } });

  // Pre-allocate parent + one child task per ratio, respond IMMEDIATELY.
  // Pre-creating per-ratio child taskIds is critical: the frontend polls each
  // child individually — the parent task's status payload doesn't contain a
  // top-level resultImageUrl (each ratio's URL lives on its own child task).
  // If we only returned [earlyTask] the frontend would poll the parent
  // forever and never see the image URLs — the save step never fires.
  const earlyTaskId = `gen-${crypto.randomUUID()}`;
  // Each generation = one card per reference with three dimensions:
  // 1:1 (parent), 4:5 (child), 9:16 (child). Frontend save logic saves 1:1
  // first then children with parent_creative_id so the pipeline shows ONE
  // card per ref and the detail modal can open all three ratios.
  const ratiosForResponse = (!req.body.ratio || req.body.ratio === 'all') ? ['1:1', '4:5', '9:16'] : [req.body.ratio];
  const preChildTasks = ratiosForResponse.map(r => ({ taskId: `nb-${crypto.randomUUID()}`, ratio: r }));
  for (const ct of preChildTasks) {
    storeTaskResult(ct.taskId, { status: 'processing', progress: `Generating ${ct.ratio}...` });
  }
  storeTaskResult(earlyTaskId, { status: 'processing', progress: 'Analyzing reference image...', tasks: preChildTasks });
  // Echo back the chosen image engine so the frontend's save flow can stamp
  // image_engine on each spy_creatives row that gets persisted.
  const _echoEngine = String(req.body.image_engine || DEFAULT_ENGINE).toLowerCase();
  res.json({ success: true, data: { taskId: earlyTaskId, tasks: preChildTasks, provider: _echoEngine, image_engine: _echoEngine, status: 'processing' } });

  // Watchdog: if the pipeline hangs, mark task as error after 8 minutes.
  const watchdog = setTimeout(() => {
    const cur = taskResults.get(earlyTaskId);
    if (cur && cur.status === 'processing') {
      console.error(`[staticsGeneration] Watchdog fired for ${earlyTaskId} — still processing after ${WATCHDOG_MS / 60000}m, marking as error`);
      storeTaskResult(earlyTaskId, { status: 'error', error: `Generation exceeded ${WATCHDOG_MS / 60000}-minute limit (pipeline hang)` });
    }
  }, WATCHDOG_MS);

  setImmediate(async () => {
    const pipelineStart = Date.now();
    try {
      const { reference_image_url, angle, angle_data, ratio, template_id } = req.body;
      // Image engine selector — defaults to NanoBanana for backwards compat.
      // Resolved once per /generate call; every ratio (parent + children) uses
      // the same engine so the creative is consistent.
      const imageEngineName = String(req.body.image_engine || DEFAULT_ENGINE).toLowerCase();
      const engine = getEngine(imageEngineName);
      if (!engine.isConfigured()) {
        return res.status(400).json({
          success: false,
          error: { message: `Image engine '${engine.name}' is not configured (missing API key)` },
        });
      }
      console.log(`[staticsGeneration] /generate using image engine: ${engine.label} (${engine.describe()})`);
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
      // System message — independently of the operator-editable user template,
      // REQUIRE three extra fields in Claude's JSON so the renderer downstream
      // knows the MEDIUM + authenticity vibe of the reference. This fixes the
      // "looks fake / studio-polished" drift when the reference is a real
      // phone photo, a UGC piece, a screenshot, etc. The renderer's default
      // bias is "polished commercial creative"; these fields override it.
      const claudeSystemPrompt = [
        'When you return the JSON analysis, you MUST also include these three fields, regardless of what the user template asks for:',
        '',
        '- "medium": one of "phone_photo" | "studio_photo" | "mockup" | "illustration" | "screenshot" | "ugc_collage" | "graphic_design". Pick the SINGLE best label for the reference image.',
        '- "authenticity_cues": array of 3-7 short strings describing the FELT QUALITIES that make this reference look the way it does. Examples: "natural shadows from overhead window light", "paper grain visible", "slight motion blur, handheld phone", "fingertip in frame", "marker ink bleed into paper fibers", "imperfect alignment (real human placement)", "uneven exposure typical of phone camera", "no retouching — pores visible". Be specific to THIS reference, not generic.',
        '- "style_directive": ONE sentence that tells the image renderer how to render to match this medium. Examples: "Render as a candid handheld phone photo with natural overhead lighting, slight imperfection, and real paper texture — NOT as a designed commercial graphic." / "Render as a clean studio product shot with controlled three-point lighting and crisp focus." / "Render as a phone screenshot of a chat app, sans-serif system fonts, no graphic-design polish."',
        '',
        'These fields are CRITICAL. The renderer cannot see the reference image — it only sees your description. If you omit these fields the output will look like a generic ad, not the real-world feel of the reference.',
      ].join('\n');

      const claudeRes = await fetch(CLAUDE_API_URL, {
        method: 'POST',
        headers: {
          'x-api-key': ANTHROPIC_API_KEY,
          'anthropic-version': '2023-06-01',
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          model: CLAUDE_MODEL,
          max_tokens: 2500,  // bumped slightly to accommodate the 3 new fields
          system: claudeSystemPrompt,
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

      // Per-engine prompt template. NanoBanana uses customPrompts.nanobanana_image;
      // OpenAI uses customPrompts.openai_image (falls back to NB template if the
      // operator hasn't filled in the OAI one yet — DB defaults seed both).
      const engineTemplate = engine.name === 'openai'
        ? (customPrompts.openai_image || customPrompts.nanobanana_image)
        : customPrompts.nanobanana_image;
      let nbPrompt = buildNanoBananaImagePrompt(claudeResult, product, engineTemplate);

      // STYLE DIRECTIVE prepend — injects the medium + authenticity cues +
      // style_directive Claude returned, so NanoBanana doesn't default to its
      // "polished commercial creative" bias when the reference is a real
      // phone photo / UGC / screenshot. Without this, the output looks like
      // a designed ad mimicking the reference rather than the reference
      // itself.
      const medium = (claudeResult.medium || '').toLowerCase();
      const cues = Array.isArray(claudeResult.authenticity_cues) ? claudeResult.authenticity_cues : [];
      const directive = (claudeResult.style_directive || '').trim();
      if (medium || cues.length || directive) {
        const cueBlock = cues.length ? cues.map(c => `  - ${c}`).join('\n') : '';
        const styleBlock = [
          '═══════════════════════════════════════════════════════════════════',
          'STYLE / MEDIUM DIRECTIVE — OVERRIDES YOUR DEFAULT POLISH BIAS',
          '═══════════════════════════════════════════════════════════════════',
          medium ? `Reference MEDIUM: ${medium} — render the output to match this medium exactly. Do NOT convert a phone photo into a designed ad, do NOT convert a screenshot into a graphic, do NOT convert UGC into a studio shot.` : '',
          directive ? `\nRender directive: ${directive}` : '',
          cues.length ? `\nAuthenticity cues observed in the reference — reproduce these qualities:\n${cueBlock}` : '',
          '\nIf the reference looks imperfect, real, candid, or human, the output must look imperfect, real, candid, or human. The output must FEEL like the same medium as the reference, not a polished version of it.',
          '═══════════════════════════════════════════════════════════════════\n',
        ].filter(Boolean).join('\n');
        nbPrompt = styleBlock + '\n' + nbPrompt;
      }

      console.log(`[staticsGeneration] NanoBanana prompt (${nbPrompt.length} chars):\n${nbPrompt.slice(0, 800)}${nbPrompt.length > 800 ? '...[truncated]' : ''}`);

      // 'all' (the UI default for "generate every aspect ratio") expands to the
      // canonical 3. Falsy or 'all' → 3 ratios. Any specific ratio → just that one.
      // ratiosToGenerate MUST match ratiosForResponse so the pre-allocated
      // child taskIds (returned in the initial /generate response) line up
      // with what the pipeline actually generates.
      const ALL_RATIOS = ['1:1', '4:5', '9:16']; // one card, three dimensions (parent + 2 children)
      const ratiosToGenerate = (!ratio || ratio === 'all') ? ALL_RATIOS : [ratio];
      // Map ratio → pre-allocated child taskId from the initial response.
      const preTaskIdByRatio = Object.fromEntries(preChildTasks.map(t => [t.ratio, t.taskId]));
      storeTaskResult(earlyTaskId, { status: 'processing', progress: `Generating ${ratiosToGenerate.length} ratio(s)...`, tasks: preChildTasks });

      // ── runFromScratch: full text-to-image generation. Used for the 1:1
      // parent (or any single-ratio request other than 'all'). Engine
      // (NanoBanana or OpenAI gpt-image-2) is whichever the operator picked
      // via the top-bar pill — resolved into `engine` at the top of the
      // handler and used uniformly below.
      async function runFromScratch(r) {
        const ratioStart = Date.now();
        const childTaskId = preTaskIdByRatio[r] || `nb-${crypto.randomUUID()}`;
        try {
          const taskHandle = await withRetry(
            () => engine.submit(nbPrompt, [productHttpUrl], r),
            `${engine.name}-submit ${r}`
          );
          console.log(`[staticsGeneration] ${engine.label} ${r} (scratch) submitted: ${taskHandle} (child=${childTaskId.slice(0, 12)}…)`);
          const tempUrl = await withRetry(() => engine.poll(taskHandle), `${engine.name}-poll ${r}`);
          const resultImageUrl = await persistNanoBananaImage(tempUrl, `statics-generated/${r}`);
          if (!resultImageUrl) throw new Error(`persist failed for ${r} — refusing to write dying URL`);
          console.log(`[staticsGeneration] ⏱ ${engine.label} ${r} (scratch) done in ${Date.now() - ratioStart}ms`);
          storeTaskResult(childTaskId, {
            status: 'completed',
            resultImageUrl,
            provider: engine.name,
            model: engine.describe(),
            claudeAnalysis: claudeResult,
            quality_warning: null,
          });
          return { taskId: childTaskId, ratio: r, resultImageUrl };
        } catch (err) {
          storeTaskResult(childTaskId, { status: 'error', error: err.message });
          throw err;
        }
      }

      // ── runResizeFromParent: takes a 1:1 result and resizes it to the
      // target ratio. Reuses NanoBanana's edit-mode with the same prompt
      // pattern as /create-variant — keep ALL content identical, just
      // extend background to fill the new format. This guarantees style
      // consistency across ratios (no more 9:16 abandoning the comp).
      async function runResizeFromParent(parentImageUrl, r) {
        const ratioStart = Date.now();
        const childTaskId = preTaskIdByRatio[r] || `nb-${crypto.randomUUID()}`;
        const resizePrompt = `Seamlessly resize this ad image to ${r} aspect ratio. Keep ALL content identical — same text, same product, same layout, same colors, same style. Extend or adjust the background naturally to fill the new format. Do NOT redesign, do NOT re-imagine, do NOT change the medium or vibe. Only reframe.`;
        try {
          const parentHttpUrl = await ensureHttpUrlGlobal(parentImageUrl, 'statics-generated');
          const taskHandle = await withRetry(
            () => engine.submit(resizePrompt, [parentHttpUrl], r),
            `${engine.name}-resize-submit ${r}`
          );
          console.log(`[staticsGeneration] ${engine.label} ${r} (resize) submitted: ${taskHandle} (child=${childTaskId.slice(0, 12)}…)`);
          const tempUrl = await withRetry(() => engine.poll(taskHandle), `${engine.name}-resize-poll ${r}`);
          const resultImageUrl = await persistNanoBananaImage(tempUrl, `statics-generated/${r}`);
          if (!resultImageUrl) throw new Error(`persist failed for ${r} (resize) — refusing to write dying URL`);
          console.log(`[staticsGeneration] ⏱ ${engine.label} ${r} (resize) done in ${Date.now() - ratioStart}ms`);
          storeTaskResult(childTaskId, {
            status: 'completed',
            resultImageUrl,
            provider: engine.name,
            model: engine.describe(),
            claudeAnalysis: claudeResult,
            quality_warning: null,
          });
          return { taskId: childTaskId, ratio: r, resultImageUrl };
        } catch (err) {
          storeTaskResult(childTaskId, { status: 'error', error: err.message });
          throw err;
        }
      }

      // Orchestration:
      //   ratio === 'all' (default): 1:1 from scratch, then 4:5 & 9:16 in
      //     parallel as resizes of the 1:1 result. Ensures style lock.
      //   ratio === '<specific>': single-shot from scratch (preserves
      //     single-ratio call semantics for /iterate etc.)
      const tasks = [];
      const failedRatios = [];

      if (ratiosToGenerate.length === 1) {
        // Single-ratio call — generate from scratch, no parent dependency.
        try {
          tasks.push(await runFromScratch(ratiosToGenerate[0]));
        } catch (err) {
          failedRatios.push({ ratio: ratiosToGenerate[0], message: err.message });
        }
      } else {
        // Multi-ratio (always 'all' under current call sites). Generate
        // 1:1 first, then resize children in parallel.
        let parentResult = null;
        try {
          parentResult = await runFromScratch('1:1');
          tasks.push(parentResult);
        } catch (err) {
          failedRatios.push({ ratio: '1:1', message: err.message });
        }

        // Child resizes — depend on parent. If parent failed, skip them
        // (the create-variant button in the modal lets the operator retry
        // missing ratios after the fact).
        if (parentResult?.resultImageUrl) {
          const childRatios = ratiosToGenerate.filter(r => r !== '1:1');
          const childResults = await Promise.allSettled(
            childRatios.map(r => runResizeFromParent(parentResult.resultImageUrl, r))
          );
          childResults.forEach((res, i) => {
            if (res.status === 'fulfilled') tasks.push(res.value);
            else failedRatios.push({ ratio: childRatios[i], message: res.reason?.message || 'unknown' });
          });
        }
      }

      failedRatios.forEach(({ ratio: fr, message }) =>
        console.error(`[staticsGeneration] NanoBanana ${fr} failed: ${message}`)
      );

      if (tasks.length === 0) {
        // ratioResults was a stale reference from a previous orchestration
        // shape — failedRatios is the actual array populated above.
        const firstErr = failedRatios[0]?.message || 'All ratios failed';
        throw new Error(`All image-engine ratios failed: ${firstErr}`);
      }

      storeTaskResult(earlyTaskId, {
        status: 'completed',
        tasks,
        provider: engine.name,
        model: engine.describe(),
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
    if (!taskId) return res.status(400).json({ success: false, error: { message: 'taskId is required' } });

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
    return res.status(500).json({ success: false, error: { message: err.message } });
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
    res.status(500).json({ success: false, error: { message: err.message } });
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
      return res.status(404).json({ success: false, error: { message: `No image creative found for ${parentCreativeId}` } });
    }
    const parent = parentRows[0];
    const parentImMatch = String(parent.creative_id).match(/^IM(\d+)$/);
    const parentImNumber = parentImMatch ? parseInt(parentImMatch[1]) : null;

    // productId is now required — silent default to "Miner Forge Pro" was a bug
    // (would generate wrong-brand ads if caller forgot the param).
    if (!productId) {
      return res.status(400).json({ success: false, error: { message: 'productId is required' } });
    }
    let product = { id: productId, name: '', profile: {} };
    {
      const prodRows = await pgQuery('SELECT * FROM product_profiles WHERE id = $1', [productId]);
      if (prodRows.length === 0) {
        return res.status(404).json({ success: false, error: { message: `product ${productId} not found` } });
      }
      {
        const p = prodRows[0];
        product = {
          id: p.id, name: p.name, price: p.price, description: p.description,
          product_image_url: firstProductImageFromRow(p),
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
            body: JSON.stringify({ model: CLAUDE_MODEL, max_tokens: 2000, messages: [{ role: 'user', content: userContent }] }),
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
    res.status(500).json({ success: false, error: { message: err.message } });
  }
});

router.get('/iterate/:batchId/status', authenticate, async (req, res) => {
  try {
    const { batchId } = req.params;
    if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(batchId)) {
      return res.status(404).json({ success: false, error: { message: 'Invalid batchId format' } });
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
    res.status(500).json({ success: false, error: { message: err.message } });
  }
});

// ─────────────────────────────────────────────────────────────────────────
// spy_creatives table bootstrap + variant generator
// ─────────────────────────────────────────────────────────────────────────

let crTableReady = false;
async function ensureCreativesTable() {
  if (crTableReady) return;
  // Only the cheap, idempotent CREATE TABLE IF NOT EXISTS skeletons run here.
  // All ALTER COLUMN / ADD COLUMN / CREATE INDEX / backfill statements live
  // in migration 053_consolidate_statics_columns.sql so the first request
  // after a redeploy doesn't pay a 3-8s schema-migration tax.
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

    // Use the SAME engine the parent was generated with — no cross-engine
    // style drift on resize. Falls back to NanoBanana for legacy rows
    // whose image_engine column is null (back-compat with pre-migration data).
    const variantEngine = getEngine(parent.image_engine || 'nanobanana');
    const nbTaskId = await withRetry(
      () => variantEngine.submit(resizePrompt, [parentHttpUrl], newAspectRatio),
      `variant-submit ${child.id.slice(0,8)} via ${variantEngine.name}`
    );
    await pgQuery(
      "UPDATE spy_creatives SET generation_task_id = $1, image_engine = $2, updated_at = NOW() WHERE id = $3",
      [nbTaskId, variantEngine.name, child.id]
    );

    const nbImageUrl = await withRetry(
      () => variantEngine.poll(nbTaskId),
      `variant-poll ${child.id.slice(0,8)} via ${variantEngine.name}`
    );

    // Strict persist — returns null if R2 (or /tmp-img in dev) failed.
    // We REFUSE to write a kie.ai/tempfile URL into spy_creatives because
    // those expire in ~3h and become black placeholders the user can't
    // recover from. Better to mark the row rejected so the watchdog (or
    // the operator) can re-queue it cleanly.
    const finalImageUrl = await persistNanoBananaImage(nbImageUrl, 'statics-variants');
    if (!finalImageUrl) {
      console.error(`[staticsGeneration] Variant ${child.id} (${newAspectRatio}) persist failed — marking rejected`);
      await pgQuery(
        "UPDATE spy_creatives SET status = 'rejected', review_notes = $1, updated_at = NOW() WHERE id = $2",
        [`Variant persist failed: storage unavailable. Re-queue from the UI.`, child.id]
      );
      return;
    }

    await pgQuery(
      "UPDATE spy_creatives SET image_url = $1, generation_task_id = $2, status = 'review', updated_at = NOW() WHERE id = $3",
      [finalImageUrl, nbTaskId, child.id]
    );

    console.log(`[staticsGeneration] Variant ${child.id} (${newAspectRatio}) resized + persisted`);
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

/**
 * Auto-spawn a 9:16 variant for a parent creative being promoted to ready.
 * Single source of truth — previously inlined in three places
 * (PATCH /creatives/:id/status, PATCH /creatives/bulk-status, /regenerate-ready).
 *
 * Accepts either a row object (with id/aspect_ratio/parent_creative_id) or a
 * UUID string (which is loaded from spy_creatives). No-ops when:
 *   - the row is itself 9:16 (no resize needed)
 *   - the row already has a parent (variants don't spawn variants)
 *   - a 9:16 variant for this parent already exists
 * Runs generateVariant in the background; caller does not await.
 */
async function autoSpawn916Variant(creativeOrId) {
  try {
    let creative = creativeOrId;
    if (typeof creativeOrId === 'string') {
      const rows = await pgQuery('SELECT * FROM spy_creatives WHERE id = $1', [creativeOrId]);
      if (rows.length === 0) return;
      creative = rows[0];
    }
    if (!creative) return;
    if (creative.aspect_ratio === '9:16') return;
    if (creative.parent_creative_id) return;
    const existing = await pgQuery(
      "SELECT 1 FROM spy_creatives WHERE parent_creative_id = $1 AND aspect_ratio = '9:16' LIMIT 1",
      [creative.id]
    );
    if (existing.length > 0) return;
    generateVariant(creative, '9:16').catch(err =>
      console.error(`[autoSpawn916Variant] variant error for ${creative.id}:`, err.message)
    );
  } catch (err) {
    console.warn(`[autoSpawn916Variant] failed for ${creativeOrId?.id || creativeOrId}:`, err.message);
  }
}

// ─────────────────────────────────────────────────────────────────────────
// Creatives CRUD
// ─────────────────────────────────────────────────────────────────────────

// GET /image-engines — list available image engines + availability for the
// frontend's engine-picker pill. Each entry { name, label, available, describe }.
router.get('/image-engines', authenticate, async (_req, res) => {
  try {
    res.json({ success: true, data: listEngines(), default: DEFAULT_ENGINE });
  } catch (err) {
    res.status(500).json({ success: false, error: { message: err.message } });
  }
});

router.get('/creatives', authenticate, async (req, res) => {
  try {
    await ensureCreativesTable();
    const { product_id, status, pipeline = 'standard', parent_creative_id } = req.query;
    let query = "SELECT id, product_id, product_name, image_url, thumbnail_url, source_label, angle, archetype, aspect_ratio, status, reference_thumbnail, reference_name, review_notes, parent_creative_id, pipeline, copy_set_id, meta_ad_ids, meta_image_hash, generated_copy, parent_creative_id_ref, parent_im_number, im_number, iteration_change_description, quality_warning, image_engine, created_at FROM spy_creatives WHERE pipeline = $1";
    const params = [pipeline];
    let idx = 2;

    if (product_id) { query += ` AND product_id = $${idx++}`; params.push(product_id); }
    if (status) { query += ` AND status = $${idx++}`; params.push(status); }
    // Filter to children of a specific parent — used by the per-ratio
    // 'Generate this missing variant' polling in CreativeDetailModalV2.
    if (parent_creative_id) { query += ` AND parent_creative_id = $${idx++}`; params.push(parent_creative_id); }

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
    // 'approved' is deprecated — the pipeline now jumps Review → Ready.
    if (status === 'approved') {
      return res.status(400).json({
        success: false,
        error: { message: 'approved is deprecated; use ready' },
      });
    }
    const validStatuses = ['generating', 'review', 'ready', 'queued', 'launching', 'launched', 'rejected', 'archived'];
    if (!validStatuses.includes(status)) {
      return res.status(400).json({ success: false, error: { message: `Invalid status. Must be one of: ${validStatuses.join(', ')}` } });
    }
    const rows = await pgQuery(
      'UPDATE spy_creatives SET status = $1, updated_at = NOW() WHERE id = $2 RETURNING *',
      [status, req.params.id]
    );
    if (rows.length === 0) return res.status(404).json({ success: false, error: { message: 'Creative not found' } });
    const creative = rows[0];

    // Auto-generate 9:16 variant when a 4:5 creative is promoted to Ready
    // (helper: autoSpawn916Variant handles all early-return guards).
    if (status === 'ready') {
      autoSpawn916Variant(creative);
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

    let query = "SELECT id, product_id, product_name, image_url, thumbnail_url, source_label, angle, archetype, aspect_ratio, status, reference_thumbnail, reference_name, parent_creative_id, pipeline, copy_set_id, meta_ad_ids, meta_image_hash, generated_copy, parent_creative_id_ref, parent_im_number, im_number, iteration_change_description, created_at FROM spy_creatives WHERE pipeline IN ('standard', 'iteration') AND COALESCE(is_reference, false) = false";
    const params = [];
    if (product_id) {
      query += ' AND product_id = $1';
      params.push(product_id);
    }
    query += ' ORDER BY created_at DESC';

    const rows = await pgQuery(query, params);

    // 'approved' bucket is deprecated — rows that still have it (older data
    // that escaped migration 051, e.g. inserted during the deploy window)
    // are folded into 'ready'.
    const pipeline = { generating: [], review: [], ready: [], launched: [] };
    const variants = [];
    for (const row of rows) {
      if (row.parent_creative_id && (row.status === 'generating' || row.status === 'rejected')) {
        variants.push(row);
      } else if (row.status === 'generating' && !row.parent_creative_id) {
        pipeline.generating.push(row);
      } else if (row.status === 'approved') {
        pipeline.ready.push(row);
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

    // Ship the response FIRST. Auto-repair detection used to run before the
    // response which added 200-800ms to every /creatives/pipeline call.
    // Deferred to setImmediate so it doesn't block the wire.
    res.json({
      success: true,
      data: pipeline,
      variants,
      counts: {
        generating: pipeline.generating.length,
        review: pipeline.review.length,
        ready: pipeline.ready.length,
        launched: pipeline.launched.length,
      },
    });

    // Auto-repair pass (deferred — runs AFTER response is on the wire):
    //   Mode A — /tmp-img/<id> with no image_store row →  /regenerate-broken-previews
    //   Mode B — kie.ai/tempfile CDN URL still on the row → backsync sweeper
    //            handles this within 5 min, but kick it now if we see any.
    //   Mode D — launched row whose image_url is unfetchable → /repair-thumbnails
    //            (cheaper Meta-Graph re-fetch).
    // Everything is fire-and-forget + rate-limited.
    setImmediate(async () => {
      try {
        const tmpImgRefs = [];
        let cdnLeakCount = 0;
        let launchedSuspect = 0;
        const CDN_PATTERNS = ['tempfile.aiquickdraw.com', 'cdn.kie.ai', 'aiquickdraw.com', 'file.kieai.app'];
        for (const bucket of ['ready', 'review', 'launched']) {
          for (const c of pipeline[bucket]) {
            const u = c.image_url || '';
            if (!u) continue;
            const m = u.match(/\/tmp-img\/([a-f0-9-]+)/i);
            if (m) { tmpImgRefs.push({ rowId: c.id, storeId: m[1] }); continue; }
            if (CDN_PATTERNS.some(p => u.includes(p))) cdnLeakCount++;
            if (bucket === 'launched' && !u.startsWith('https://scontent') && !u.startsWith('https://platform-lookaside')) {
              launchedSuspect++;
            }
          }
        }
        // Mode A check
        if (tmpImgRefs.length > 0) {
          const storeIds = tmpImgRefs.map(b => b.storeId);
          const alive = await pgQuery(
            'SELECT id FROM image_store WHERE id = ANY($1::text[])',
            [storeIds]
          );
          const aliveSet = new Set(alive.map(r => r.id));
          const dead = tmpImgRefs.filter(b => !aliveSet.has(b.storeId));
          if (dead.length > 0) {
            triggerBrokenPreviewRepair(dead.length).catch(() => {});
          }
        }
        // Mode B trigger: kick the backsync sweeper if any leaked CDN URLs are
        // visible (don't wait for the 5-min interval).
        if (cdnLeakCount > 0) {
          backsyncDoomedUrls().catch(() => {});
        }
        // Mode D trigger: launched rows that don't look like Meta-CDN URLs.
        if (launchedSuspect > 0) {
          triggerLaunchedRepair(launchedSuspect).catch(() => {});
        }
      } catch (e) {
        console.warn('[creatives/pipeline] deferred auto-repair detection failed:', e.message);
      }
    });
  } catch (err) {
    console.error('[staticsGeneration] /creatives/pipeline error:', err);
    res.status(500).json({ success: false, error: { message: err.message } });
  }
});

// Module-level rate-limit: one auto-repair request per process per 30 min.
let _autoRepairLastAt = 0;
let _autoRepairInFlight = false;
let _launchedRepairLastAt = 0;
let _launchedRepairInFlight = false;
const AUTO_REPAIR_MIN_INTERVAL_MS = 30 * 60 * 1000;

// Mode D: launched rows whose Meta CDN URL has aged out. /repair-thumbnails
// re-fetches via the Meta Graph API — much cheaper than NB regen.
async function triggerLaunchedRepair(deadCount) {
  if (_launchedRepairInFlight) return;
  if (Date.now() - _launchedRepairLastAt < AUTO_REPAIR_MIN_INTERVAL_MS) return;
  const secret = process.env.CRON_SECRET;
  if (!secret) { console.warn('[auto-repair-launched] CRON_SECRET not set — skipping'); return; }
  _launchedRepairInFlight = true;
  console.log(`[auto-repair-launched] ${deadCount} suspect launched URLs detected — calling /repair-thumbnails`);
  try {
    const base = process.env.RENDER_EXTERNAL_URL || `http://localhost:${process.env.PORT || 3000}`;
    const r = await fetch(`${base}/api/v1/statics-generation/repair-thumbnails`, {
      method: 'GET',
      headers: { 'x-cron-secret': secret },
      signal: AbortSignal.timeout(60_000),
    });
    const body = await r.json().catch(() => ({}));
    console.log(`[auto-repair-launched] ${r.status}: repaired=${body?.data?.repaired ?? '?'} skipped=${body?.data?.skipped ?? '?'} unrepairable=${body?.data?.unrepairable ?? '?'}`);
  } catch (err) {
    console.warn('[auto-repair-launched] kickoff failed:', err.message);
  } finally {
    _launchedRepairLastAt = Date.now();
    _launchedRepairInFlight = false;
  }
}

async function triggerBrokenPreviewRepair(deadCount) {
  if (_autoRepairInFlight) return;
  if (Date.now() - _autoRepairLastAt < AUTO_REPAIR_MIN_INTERVAL_MS) return;
  const secret = process.env.CRON_SECRET;
  if (!secret) {
    console.warn('[auto-repair] CRON_SECRET not set — skipping');
    return;
  }
  _autoRepairInFlight = true;
  console.log(`[auto-repair] ${deadCount} dead /tmp-img refs detected — triggering background regen`);
  try {
    const base = process.env.RENDER_EXTERNAL_URL || `http://localhost:${process.env.PORT || 3000}`;
    const r = await fetch(`${base}/api/v1/statics-generation/regenerate-broken-previews`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'x-cron-secret': secret },
      body: JSON.stringify({}),
      signal: AbortSignal.timeout(15_000),
    });
    const body = await r.json().catch(() => ({}));
    console.log(`[auto-repair] regen ${r.status}: queued=${body?.data?.queued} eta=${body?.data?.eta_min}min`);
  } catch (err) {
    console.warn('[auto-repair] regen kickoff failed:', err.message);
  } finally {
    _autoRepairLastAt = Date.now();
    _autoRepairInFlight = false;
  }
}

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
      parent_creative_id,
      image_engine, // 'nanobanana' | 'openai' (default 'nanobanana' via DB)
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
         quality_warning, parent_creative_id, image_engine)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20,$21,$22)
       RETURNING *`,
      [
        product_id || null,
        product_name || null,
        angle || null,
        aspect_ratio || '1:1',
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
        parent_creative_id || null,
        image_engine || 'nanobanana',
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

        // Build the new prompt — use the engine-specific template so the
        // refine matches the original generation's style.
        const adjustTemplate = (creative.image_engine === 'openai')
          ? (customPrompts.openai_image || customPrompts.nanobanana_image)
          : customPrompts.nanobanana_image;
        const baseNbPrompt = buildNanoBananaImagePrompt(claudeResult, product, adjustTemplate);
        const newNbPrompt = `${baseNbPrompt}\n\nADJUSTMENT REQUESTED BY USER:\n${adjustmentInstruction}\n\nPreserve everything else exactly as it appears in the input image.`;

        storeTaskResult(adjustTaskId, { status: 'processing', progress: 'Regenerating with NanoBanana...' });

        // Per friend's architecture: NanoBanana edits the CURRENT image (not the product) on adjustment.
        // Use the SAME engine the creative was originally generated with so refines don't drift style.
        const adjustEngine = getEngine(creative.image_engine || 'nanobanana');
        const currentImageHttpUrl = await ensureHttpUrlGlobal(creative.image_url, 'adjust-src');
        const ratio = creative.aspect_ratio || '4:5';
        const nbTaskId = await withRetry(
          () => adjustEngine.submit(newNbPrompt, [currentImageHttpUrl], ratio),
          `ai-adjust-submit ${creative.id.slice(0, 8)} via ${adjustEngine.name}`
        );
        const tempUrl = await withRetry(
          () => adjustEngine.poll(nbTaskId),
          `ai-adjust-poll ${creative.id.slice(0, 8)} via ${adjustEngine.name}`
        );

        // Strict persist (R2 with retries + HEAD-verify; NULL on hard fail).
        // Mirrors the atomic-variant flow so refines can't leak dying CDN URLs.
        const finalImageUrl = await persistNanoBananaImage(tempUrl, `statics-adjust/${ratio}`);
        if (!finalImageUrl) {
          throw new Error('persist failed — refusing to write dying URL on adjust');
        }

        // Push the OLD image into iteration_history BEFORE we overwrite it.
        // Phase-B-2 carousel reads this list (last 6). Capped at 6 entries
        // by trimming oldest off when pushing.
        const prevHistory = Array.isArray(creative.iteration_history)
          ? creative.iteration_history
          : (typeof creative.iteration_history === 'string'
            ? (() => { try { return JSON.parse(creative.iteration_history); } catch { return []; } })()
            : []);
        const trimmedHistory = [
          ...prevHistory,
          {
            image_url: creative.image_url,
            refine_instruction: correction,
            created_at: new Date().toISOString(),
          },
        ].slice(-6);

        await pgQuery(
          `UPDATE spy_creatives
           SET image_url = $1,
               generation_prompt = $2,
               iteration_history = $3::jsonb,
               review_notes = NULL,
               updated_at = NOW()
           WHERE id = $4`,
          [finalImageUrl, adjustmentInstruction, JSON.stringify(trimmedHistory), creative.id]
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

// ─────────────────────────────────────────────────────────────────────────
// POST /creatives/:id/approve — Phase B detail modal's "Approve" button.
//
// Moves the creative AND all its variants (parent_creative_id = :id) to
// status='ready' so they show up in Ready to Launch. Idempotent — already-
// ready rows pass through unchanged.
//
// If the id passed is a child (parent_creative_id IS NOT NULL), we resolve
// up to the parent first so the operator can hit Approve from any ratio.
// ─────────────────────────────────────────────────────────────────────────
router.post('/creatives/:id/approve', authenticate, async (req, res) => {
  try {
    await ensureCreativesTable();
    const rows = await pgQuery(
      'SELECT id, parent_creative_id, status FROM spy_creatives WHERE id = $1',
      [req.params.id]
    );
    if (rows.length === 0) return res.status(404).json({ success: false, error: { message: 'Creative not found' } });

    // Resolve to the parent — children share the same approval state.
    const parentId = rows[0].parent_creative_id || rows[0].id;

    // Move parent + all children to 'ready'. Skip rows already terminal.
    await pgQuery(
      `UPDATE spy_creatives
         SET status = 'ready', updated_at = NOW()
       WHERE (id = $1 OR parent_creative_id = $1)
         AND status NOT IN ('launched', 'launching', 'archived')`,
      [parentId]
    );

    const updated = await pgQuery(
      'SELECT id, aspect_ratio, status FROM spy_creatives WHERE id = $1 OR parent_creative_id = $1 ORDER BY (aspect_ratio = \'1:1\') DESC, aspect_ratio',
      [parentId]
    );

    res.json({ success: true, data: { parentId, rows: updated } });
  } catch (err) {
    console.error('[staticsGeneration] POST /creatives/:id/approve error:', err);
    res.status(500).json({ success: false, error: { message: err.message } });
  }
});

// ─────────────────────────────────────────────────────────────────────────
// GET /creatives/:id/iterations — return the per-ratio refinement carousel.
//
// Reads spy_creatives.iteration_history JSONB (migration 058). Returns the
// stored array as-is (latest at end) so the frontend modal can render the
// "previous versions" strip under each ratio column.
// ─────────────────────────────────────────────────────────────────────────
router.get('/creatives/:id/iterations', authenticate, async (req, res) => {
  try {
    await ensureCreativesTable();
    const rows = await pgQuery(
      'SELECT id, iteration_history FROM spy_creatives WHERE id = $1',
      [req.params.id]
    );
    if (rows.length === 0) return res.status(404).json({ success: false, error: { message: 'Creative not found' } });

    const raw = rows[0].iteration_history;
    let history = [];
    if (Array.isArray(raw)) history = raw;
    else if (typeof raw === 'string') { try { history = JSON.parse(raw); } catch { history = []; } }

    res.json({ success: true, data: { creativeId: rows[0].id, iterations: history } });
  } catch (err) {
    console.error('[staticsGeneration] GET /creatives/:id/iterations error:', err);
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

    // Pre-fetch all legacy variants in one query (audit N+1 fix). Build a Map
    // keyed by parent_creative_id so the per-creative loop is a cheap lookup
    // instead of 1 SELECT per row.
    const legacyVariantsByParent = new Map();
    try {
      const allVariants = await pgQuery(
        `SELECT id, parent_creative_id, aspect_ratio, image_url, meta_image_hash
           FROM spy_creatives
          WHERE parent_creative_id = ANY($1::uuid[])
            AND status IN ('approved', 'ready')
            AND image_url IS NOT NULL`,
        [creative_ids]
      );
      for (const v of allVariants) {
        const arr = legacyVariantsByParent.get(v.parent_creative_id) || [];
        arr.push(v);
        legacyVariantsByParent.set(v.parent_creative_id, arr);
      }
    } catch (e) {
      console.warn('[launch] pre-fetch of legacy variants failed (continuing without):', e.message);
    }

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

        const legacyVariants = legacyVariantsByParent.get(creative.id) || [];
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
    // 'approved' was deprecated in migration 051 — reject explicitly to match the
    // single-creative PATCH endpoint's behavior. Use 'ready' instead.
    if (status === 'approved') {
      return res.status(400).json({ success: false, error: { message: "'approved' is deprecated; use 'ready'" } });
    }
    const validStatuses = ['review', 'ready', 'rejected', 'archived'];
    if (!validStatuses.includes(status)) {
      return res.status(400).json({ success: false, error: { message: `Invalid status: ${status}` } });
    }

    const placeholders = ids.map((_, i) => `$${i + 2}`).join(', ');
    await pgQuery(
      `UPDATE spy_creatives SET status = $1, updated_at = NOW() WHERE id IN (${placeholders})`,
      [status, ...ids]
    );

    // Auto-spawn 9:16 variant on 'ready' (was 'approved' — moved per migration 051).
    // Batched into a single SELECT (N+1 fix per audit perf finding).
    if (status === 'ready') {
      const rows = await pgQuery(
        `SELECT id, aspect_ratio, parent_creative_id FROM spy_creatives WHERE id = ANY($1::uuid[])`,
        [ids]
      );
      const parentsNeedingVariants = rows.filter(c =>
        c.aspect_ratio !== '9:16' && !c.parent_creative_id
      );
      if (parentsNeedingVariants.length > 0) {
        const parentIds = parentsNeedingVariants.map(c => c.id);
        const existingVariants = await pgQuery(
          `SELECT parent_creative_id FROM spy_creatives WHERE parent_creative_id = ANY($1::uuid[]) AND aspect_ratio = '9:16'`,
          [parentIds]
        );
        const alreadyHasVariant = new Set(existingVariants.map(v => v.parent_creative_id));
        for (const creative of parentsNeedingVariants) {
          if (!alreadyHasVariant.has(creative.id)) {
            generateVariant(creative, '9:16').catch(err =>
              console.error(`[bulkStatus] Auto 9:16 variant error for ${creative.id}:`, err.message)
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

// Body of /repair-thumbnails — route is REGISTERED above line 271 so its
// CRON_SECRET check fires before the global authenticate middleware.
async function _doRepairThumbnails(req, res) {
  try {
    const META_ACCESS_TOKEN = process.env.META_ACCESS_TOKEN || '';
    const META_GRAPH_URL = 'https://graph.facebook.com/v21.0';

    // Match every URL type that can go stale:
    //   - tempfile.aiquickdraw.com         → Kie.ai temp URLs that expire after a few hours
    //   - /tmp-img/                        → our own in-memory store (wiped on every server restart)
    //   - NULL / empty                     → never had one
    // For each row we look up the Meta CDN URL by meta_image_hash.
    const stale = await pgQuery(
      `SELECT c.id, c.image_url, c.meta_image_hash, l.ad_account_id
       FROM spy_creatives c
       LEFT JOIN statics_launches l ON l.creative_id = c.id
       WHERE c.status = 'launched'
         AND (
           c.image_url LIKE '%tempfile%'
           OR c.image_url LIKE '%/tmp-img/%'
           OR c.image_url LIKE '%aiquickdraw%'
           OR c.image_url IS NULL
           OR c.image_url = ''
         )
         AND c.meta_image_hash IS NOT NULL
         AND c.meta_image_hash != ''
       ORDER BY c.id`
    );

    // Count creatives that cannot be repaired (no meta_image_hash) — visibility only.
    const unrepairableRows = await pgQuery(
      `SELECT COUNT(*)::int AS n FROM spy_creatives
       WHERE status = 'launched'
         AND (
           image_url LIKE '%tempfile%' OR image_url LIKE '%/tmp-img/%' OR
           image_url LIKE '%aiquickdraw%' OR image_url IS NULL OR image_url = ''
         )
         AND (meta_image_hash IS NULL OR meta_image_hash = '')`
    );
    const unrepairable = unrepairableRows[0]?.n || 0;

    if (stale.length === 0) {
      return res.json({ success: true, data: { repaired: 0, skipped: 0, unrepairable, message: `No repairable thumbnails. ${unrepairable} launched creative(s) have stale URLs but no meta_image_hash — those cannot be recovered.` } });
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
          // Mirror Meta CDN bytes to R2 so we don't re-break when Meta purges
          // the CDN URL again. Fall back to storing the raw CDN URL if R2 fails
          // (better than nothing for the next 24-72h).
          let finalUrl = cdnUrl;
          if (isR2Configured() && process.env.R2_PUBLIC_URL) {
            try {
              const { url: r2Url } = await uploadFromUrl(cdnUrl, 'meta-repair-r2');
              if (r2Url && r2Url.startsWith('http')) finalUrl = r2Url;
            } catch (mirrorErr) {
              console.warn(`[repair-thumbnails] R2 mirror failed for ${row.id}: ${mirrorErr.message} — storing raw Meta CDN URL as fallback`);
            }
          }
          try {
            await pgQuery(
              `UPDATE spy_creatives SET image_url = $1, thumbnail_url = $1, updated_at = NOW() WHERE id = $2`,
              [finalUrl, row.id]
            );
            const tag = finalUrl === cdnUrl ? 'Meta-CDN' : 'R2-mirror';
            console.log(`[repair-thumbnails] ✅ Repaired creative ${row.id} → ${tag} ${finalUrl.slice(0, 80)}`);
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

    console.log(`[repair-thumbnails] Done — repaired: ${repaired}, skipped: ${skipped}, unrepairable: ${unrepairable}`);
    res.json({
      success: true,
      data: { found: stale.length, repaired, skipped, unrepairable, errors: errors.length > 0 ? errors : undefined },
    });
  } catch (err) {
    console.error('[staticsGeneration] /repair-thumbnails error:', err);
    res.status(500).json({ success: false, error: { message: err.message } });
  }
}

// ─────────────────────────────────────────────────────────────────────────
// Regenerate-broken-previews
//
// Last-resort fallback for creatives whose image_url is dead and Meta CDN
// can't recover them (image hash purged on Meta side, or never had a hash).
// We have `reference_thumbnail + angle + product_id` → enough to re-run the
// 3-step pipeline and produce a fresh preview. The Meta ad itself is not
// touched — we only refresh the local preview thumbnail.
// ─────────────────────────────────────────────────────────────────────────
// GET /diagnose-previews — per-bucket / per-failure-mode count of broken cards.
// Helps prove "zero broken previews" after the heal pass. Auth: JWT or CRON_SECRET.
router.get('/diagnose-previews', async (req, res, next) => {
  const cronSecret = process.env.CRON_SECRET;
  const provided   = req.headers['x-cron-secret'];
  if (cronSecret && provided === cronSecret) return next();
  return authenticate(req, res, next);
}, async (_req, res) => {
  try {
    const rows = await pgQuery(`
      SELECT
        CASE WHEN status = 'approved' THEN 'ready' ELSE status END AS bucket,
        COUNT(*) FILTER (WHERE image_url IS NULL OR image_url = '')                       AS mode_c_empty,
        COUNT(*) FILTER (WHERE image_url LIKE '%/tmp-img/%')                              AS tmp_img_total,
        COUNT(*) FILTER (WHERE image_url LIKE '%tempfile.aiquickdraw.com%'
                            OR image_url LIKE '%cdn.kie.ai%'
                            OR image_url LIKE '%aiquickdraw.com%'
                            OR image_url LIKE '%file.kieai.app%')                          AS mode_b_cdn,
        COUNT(*) FILTER (WHERE image_url LIKE 'https://%' AND image_url NOT LIKE '%/tmp-img/%'
                            AND image_url NOT LIKE '%tempfile.aiquickdraw.com%'
                            AND image_url NOT LIKE '%cdn.kie.ai%'
                            AND image_url NOT LIKE '%aiquickdraw.com%'
                            AND image_url NOT LIKE '%file.kieai.app%')                      AS r2_or_meta,
        COUNT(*)                                                                            AS total
      FROM spy_creatives
      WHERE status IN ('launched','ready','approved','review')
        AND COALESCE(is_reference, FALSE) = FALSE
      GROUP BY bucket
      ORDER BY bucket
    `);

    // Mode A = /tmp-img/ pointing at image_store rows that are gone
    const tmpImgIds = await pgQuery(`
      SELECT regexp_replace(image_url, '.*/tmp-img/', '') AS sid
      FROM spy_creatives
      WHERE image_url LIKE '%/tmp-img/%'
        AND status IN ('launched','ready','approved','review')
        AND COALESCE(is_reference, FALSE) = FALSE
    `);
    let mode_a_dead = 0;
    if (tmpImgIds.length > 0) {
      const ids = tmpImgIds.map(r => r.sid);
      const alive = await pgQuery('SELECT id FROM image_store WHERE id = ANY($1::text[])', [ids]);
      const aliveSet = new Set(alive.map(r => r.id));
      mode_a_dead = ids.filter(i => !aliveSet.has(i)).length;
    }

    res.json({
      success: true,
      data: {
        per_bucket: rows,
        mode_a_dead_tmp_img: mode_a_dead,
        backsync_in_flight: _backsyncInFlight,
        auto_repair_last_at: _autoRepairLastAt || null,
      },
    });
  } catch (err) {
    console.error('[diagnose-previews] error:', err);
    res.status(500).json({ success: false, error: { message: err.message } });
  }
});

// POST /heal-zombies — Mode C: cards with NULL/empty image_url AND no reference
// to regenerate from get archived (status='error') so they don't pollute counts
// or block the "Need N more" math. Auth: JWT or CRON_SECRET.
router.post('/heal-zombies', async (req, res, next) => {
  const cronSecret = process.env.CRON_SECRET;
  const provided   = req.headers['x-cron-secret'];
  if (cronSecret && provided === cronSecret) return next();
  return authenticate(req, res, next);
}, async (_req, res) => {
  try {
    const result = await pgQuery(`
      UPDATE spy_creatives
      SET status = 'error',
          review_notes = COALESCE(review_notes, '') ||
            CASE WHEN review_notes IS NULL OR review_notes = '' THEN '' ELSE ' | ' END ||
            'auto-archived: no image and no reference to regenerate from',
          updated_at = NOW()
      WHERE (image_url IS NULL OR image_url = '')
        AND (reference_thumbnail IS NULL OR reference_thumbnail = '')
        AND status IN ('ready','approved','review','generating')
        AND COALESCE(is_reference, FALSE) = FALSE
      RETURNING id, angle, aspect_ratio
    `);
    console.log(`[heal-zombies] archived ${result.length} zombie creatives`);
    res.json({ success: true, archived: result.length, rows: result });
  } catch (err) {
    console.error('[heal-zombies] error:', err);
    res.status(500).json({ success: false, error: { message: err.message } });
  }
});

// NOTE: /repair-all-previews moved to the public-routes section above
// (before `router.use(authenticate, ...)`) so the per-route CRON_SECRET
// check actually runs. Previously this route lived here and the global
// authenticate middleware always 401'd before the secret check fired.

// ─────────────────────────────────────────────────────────────────────────
// POST /migrate-image-store-to-r2
//
// One-shot backfill: upload every row in image_store to R2, rewrite every
// spy_creatives.image_url / reference_thumbnail that points at the
// corresponding /tmp-img/<id> to the new R2 URL. After 100% rewrite the
// caller can TRUNCATE image_store safely.
//
// Idempotent + resumable: progress lives in image_store_migration. A
// restart picks up where we left off; re-runs skip already-migrated rows.
// CRON_SECRET-gated so it can be triggered from a terminal once R2 is hot.
// Refuses to run unless R2_PUBLIC_URL is set (no point uploading if the
// returned URL would be `r2://bucket/key` and unfetchable by browsers).
//
// Query: ?limit=N (default 500) — caps how many rows we process per run.
//        ?dry=1 — preview counts without writing anything.
// ─────────────────────────────────────────────────────────────────────────
router.post('/migrate-image-store-to-r2', async (req, res, next) => {
  const cronSecret = process.env.CRON_SECRET;
  const provided   = req.headers['x-cron-secret'];
  if (cronSecret && provided === cronSecret) return next();
  return authenticate(req, res, next);
}, async (req, res) => {
  try {
    if (!process.env.R2_PUBLIC_URL || !isR2Configured()) {
      return res.status(412).json({
        success: false,
        error: { message: 'R2_PUBLIC_URL or R2 credentials not set — refusing to run; set the env vars then retry' },
      });
    }
    const limit = Math.min(parseInt(req.query.limit, 10) || 500, 5000);
    const dryRun = req.query.dry === '1' || req.body?.dry === true;

    // Tracking table — tiny, just (image_store_id, r2_url, migrated_at)
    await pgQuery(`
      CREATE TABLE IF NOT EXISTS image_store_migration (
        id TEXT PRIMARY KEY,
        r2_url TEXT NOT NULL,
        migrated_at TIMESTAMPTZ DEFAULT NOW(),
        spy_creatives_updated INT DEFAULT 0
      )
    `).catch(() => {});

    // Pick rows that still exist in image_store AND haven't been migrated yet
    const todo = await pgQuery(`
      SELECT s.id, s.data, s.content_type
      FROM image_store s
      LEFT JOIN image_store_migration m ON m.id = s.id
      WHERE m.id IS NULL
      ORDER BY s.created_at ASC
      LIMIT $1
    `, [limit], { timeout: 30000 });

    if (todo.length === 0) {
      // Final summary: how many spy_creatives rows still point at /tmp-img/
      const remaining = await pgQuery(`
        SELECT COUNT(*) AS n
        FROM spy_creatives
        WHERE image_url LIKE '%/tmp-img/%'
          AND COALESCE(is_reference, FALSE) = FALSE
      `);
      const migrated = await pgQuery(`SELECT COUNT(*) AS n FROM image_store_migration`);
      return res.json({
        success: true,
        data: {
          message: 'Nothing left to migrate',
          totalMigrated: Number(migrated[0]?.n || 0),
          spyCreativesStillUsingTmpImg: Number(remaining[0]?.n || 0),
        },
      });
    }

    if (dryRun) {
      return res.json({
        success: true,
        data: { dry_run: true, would_migrate: todo.length, sample_ids: todo.slice(0, 5).map(r => r.id) },
      });
    }

    // Process now in background, respond immediately
    const totalToProcess = todo.length;
    const eta_min = Math.ceil(totalToProcess / 8 / 60);
    res.json({
      success: true,
      data: {
        started: true,
        rowsScheduled: totalToProcess,
        eta_min,
        message: `Migrating ${totalToProcess} image_store rows → R2 in background (concurrency=8). ETA ~${eta_min} min.`,
      },
    });

    setImmediate(async () => {
      const srv = process.env.RENDER_EXTERNAL_URL || `http://localhost:${process.env.PORT || 3000}`;
      const tmpImgPrefix = `${srv}/api/v1/statics-generation/tmp-img/`;
      const CONCURRENCY = 8;
      let cursor = 0, ok = 0, fail = 0, rewriteTotal = 0;

      async function processOne(row) {
        try {
          const buf = Buffer.isBuffer(row.data) ? row.data : Buffer.from(row.data);
          const ext = (row.content_type || '').includes('jpeg') || (row.content_type || '').includes('jpg') ? 'jpg' : 'png';
          const key = `image-store-backfill/${row.id}.${ext}`;
          const r2Url = await uploadBuffer(buf, key, row.content_type || 'image/png');
          if (!r2Url || !r2Url.startsWith('http')) throw new Error(`uploadBuffer returned non-http: ${(r2Url||'').slice(0, 40)}`);

          // Rewrite every spy_creatives reference to this image_store id
          const oldUrl = `${tmpImgPrefix}${row.id}`;
          const upd1 = await pgQuery(
            'UPDATE spy_creatives SET image_url = $1 WHERE image_url = $2 RETURNING id',
            [r2Url, oldUrl]
          );
          const upd2 = await pgQuery(
            'UPDATE spy_creatives SET reference_thumbnail = $1 WHERE reference_thumbnail = $2 RETURNING id',
            [r2Url, oldUrl]
          );
          const updates = upd1.length + upd2.length;
          rewriteTotal += updates;

          // Mark migrated
          await pgQuery(
            `INSERT INTO image_store_migration (id, r2_url, spy_creatives_updated)
             VALUES ($1, $2, $3)
             ON CONFLICT (id) DO UPDATE SET r2_url = EXCLUDED.r2_url, migrated_at = NOW()`,
            [row.id, r2Url, updates]
          );
          ok++;
        } catch (err) {
          fail++;
          console.error(`[migrate-r2 ${row.id.slice(0,8)}] ❌ ${err.message}`);
        }
      }

      async function worker() {
        while (true) {
          const i = cursor++;
          if (i >= todo.length) return;
          await processOne(todo[i]);
          if ((ok + fail) % 25 === 0) {
            console.log(`[migrate-r2] progress: ok=${ok} fail=${fail} rewrites=${rewriteTotal} of ${todo.length}`);
          }
        }
      }
      await Promise.all(Array.from({ length: CONCURRENCY }, () => worker()));
      console.log(`[migrate-r2] DONE batch: ok=${ok} fail=${fail} spy_creatives_rewrites=${rewriteTotal} (of ${todo.length})`);
    });
  } catch (err) {
    console.error('[migrate-image-store-to-r2] error:', err);
    res.status(500).json({ success: false, error: { message: err.message } });
  }
});

// GET /migrate-image-store-to-r2/status — read-only progress check
router.get('/migrate-image-store-to-r2/status', async (req, res, next) => {
  const cronSecret = process.env.CRON_SECRET;
  const provided   = req.headers['x-cron-secret'];
  if (cronSecret && provided === cronSecret) return next();
  return authenticate(req, res, next);
}, async (_req, res) => {
  try {
    const tableCheck = await pgQuery(`SELECT EXISTS (SELECT FROM information_schema.tables WHERE table_name = 'image_store_migration') AS exists`).catch(() => [{ exists: false }]);
    if (!tableCheck[0]?.exists) {
      return res.json({ success: true, data: { migrated: 0, image_store_remaining: 0, spy_creatives_still_tmp_img: 0 } });
    }
    const [migrated] = await pgQuery(`SELECT COUNT(*) AS n FROM image_store_migration`);
    const [imageStoreCount] = await pgQuery(`SELECT COUNT(*) AS n FROM image_store`);
    const [stillTmpImg] = await pgQuery(`
      SELECT COUNT(*) AS n FROM spy_creatives
      WHERE image_url LIKE '%/tmp-img/%' AND COALESCE(is_reference, FALSE) = FALSE
    `);
    res.json({
      success: true,
      data: {
        migrated: Number(migrated.n || 0),
        image_store_total: Number(imageStoreCount.n || 0),
        image_store_remaining: Math.max(0, Number(imageStoreCount.n || 0) - Number(migrated.n || 0)),
        spy_creatives_still_tmp_img: Number(stillTmpImg.n || 0),
        r2_url_configured: !!process.env.R2_PUBLIC_URL,
        r2_configured: isR2Configured(),
      },
    });
  } catch (err) {
    console.error('[migrate-image-store-to-r2/status] error:', err);
    res.status(500).json({ success: false, error: { message: err.message } });
  }
});

// Body of /regenerate-broken-previews — route REGISTERED above line 271.
async function _doRegenerateBrokenPreviews(req, res) {
  try {
    await ensureCreativesTable();
    // Default scope: visible pipeline statuses only (matches the Kanban columns).
    // Caller can override by passing { statuses: [...] } to include rejected/generating etc.
    const DEFAULT_STATUSES = ['launched', 'ready', 'approved', 'review'];
    const statuses = (Array.isArray(req.body?.statuses) && req.body.statuses.length > 0)
      ? req.body.statuses
      : DEFAULT_STATUSES;

    const broken = await pgQuery(`
      SELECT id, product_id, angle, reference_thumbnail, aspect_ratio, status
      FROM spy_creatives
      WHERE status = ANY($1::text[])
      AND COALESCE(is_reference, FALSE) = FALSE  -- NEVER overwrite League/Meta/Upload reference rows
      AND (
        image_url LIKE '%tempfile%' OR image_url LIKE '%/tmp-img/%' OR
        image_url LIKE '%aiquickdraw%' OR image_url IS NULL OR image_url = ''
      )
      AND reference_thumbnail IS NOT NULL
      AND reference_thumbnail != ''
      AND product_id IS NOT NULL
      ORDER BY status, updated_at DESC
    `, [statuses]);

    // Respond immediately — pipeline runs in background
    const eta = Math.ceil((broken.length * 25) / 4 / 60); // ~25s each, 4 workers, in minutes
    res.json({
      success: true,
      data: {
        queued: broken.length,
        scopedStatuses: statuses,
        eta_min: eta,
        message: `Regenerating ${broken.length} broken preview(s) in background (statuses=[${statuses.join(',')}]). ETA ~${eta} min at concurrency=4.`,
      },
    });
    if (broken.length === 0) return;

    setImmediate(async () => {
      const customPrompts = (await getCustomStaticsPrompts().catch(() => null)) || getDefaultStaticsPrompts();

      // Concurrency limiter — 4 at a time to avoid API rate limits
      const CONCURRENCY = 4;
      let cursor = 0;
      let succeeded = 0, failed = 0;

      async function processOne(row) {
        const tag = `[rgn ${row.id.slice(0,8)}]`;
        try {
          // 1. Load product
          const prodRows = await pgQuery('SELECT * FROM product_profiles WHERE id = $1', [row.product_id]);
          if (prodRows.length === 0) throw new Error(`product_id ${row.product_id} not found`);
          const p = prodRows[0];
          const product = {
            id: p.id, name: p.name, price: p.price, description: p.description,
            product_image_url: firstProductImageFromRow(p),
            profile: {
              oneliner: p.oneliner, tagline: p.tagline, big_promise: p.big_promise,
              differentiator: p.differentiator, unique_mechanism: p.mechanism, voice: p.voice,
              key_benefits: p.benefits, pain_points: p.pain_points,
              target_demographics: p.target_demographics, target_audience: p.customer_avatar,
              customer: p.customer_avatar, winning_angles: p.winning_angles,
              objections: p.common_objections, offer_hook: p.offer_details,
              pricing: p.price, compliance: p.compliance_restrictions,
            },
          };
          if (!product.product_image_url) throw new Error('no product_image_url');

          // 2. Resolve product to HTTP URL (R2-uploaded data URI or tmp-img fallback)
          const productHttpUrl = await ensureHttpUrlGlobal(product.product_image_url, 'rgn-product');
          if (!productHttpUrl || !productHttpUrl.startsWith('http')) {
            throw new Error(`productHttpUrl is not fetchable: "${(productHttpUrl||'').slice(0,40)}..."`);
          }
          console.log(`${tag} productHttpUrl=${productHttpUrl.slice(0,80)}`);

          // 3. Step 1: Claude analysis
          const { base64: refB64, mediaType: refMt } = await resolveImage(row.reference_thumbnail);
          const promptText = buildClaudeAnalysisPrompt(
            product, row.angle || '', customPrompts.claude_analysis,
            { PRODUCT_IMAGE_NOTE: '\n\nA second image is attached: this is OUR product. Render it precisely as shown.' }
          );
          const content = [
            { type: 'text', text: promptText },
            { type: 'image', source: { type: 'base64', media_type: refMt, data: refB64 } },
          ];
          try {
            const { base64: pB64, mediaType: pMt } = await resolveImage(productHttpUrl);
            content.push({ type: 'image', source: { type: 'base64', media_type: pMt, data: pB64 } });
          } catch {}

          const cr = await fetch(CLAUDE_API_URL, {
            method: 'POST',
            headers: { 'x-api-key': ANTHROPIC_API_KEY, 'anthropic-version': '2023-06-01', 'content-type': 'application/json' },
            body: JSON.stringify({ model: CLAUDE_MODEL, max_tokens: 2000, messages: [{ role: 'user', content }] }),
          });
          if (!cr.ok) throw new Error(`Claude ${cr.status}: ${(await cr.text()).slice(0,200)}`);
          const cd = await cr.json();
          const raw = cd.content?.[0]?.text || '';
          const m = raw.match(/\{[\s\S]*\}/);
          if (!m) throw new Error('Claude returned no JSON');
          let claudeResult;
          try { claudeResult = JSON.parse(m[0]); }
          catch { claudeResult = JSON.parse(m[0].replace(/,\s*([}\]])/g, '$1')); }

          // 4. Step 2: NanoBanana with ONLY product image
          const nbPrompt = buildNanoBananaImagePrompt(claudeResult, product, customPrompts.nanobanana_image);
          const ratio = row.aspect_ratio || '4:5';
          const nbTaskId = await submitToNanoBanana(nbPrompt, [productHttpUrl], ratio);
          const tempUrl = await pollNanoBanana(nbTaskId);
          const persisted = await persistNanoBananaImage(tempUrl, 'statics-recovered');

          // 5. Write back to spy_creatives
          await pgQuery(
            `UPDATE spy_creatives
             SET image_url = $1, thumbnail_url = $1,
                 claude_analysis = $2::jsonb, adapted_text = $3::jsonb,
                 updated_at = NOW()
             WHERE id = $4`,
            [persisted, JSON.stringify(claudeResult), JSON.stringify(claudeResult.adapted_text || {}), row.id]
          );
          succeeded++;
          console.log(`${tag} ✅ → ${persisted.slice(0,80)}`);
        } catch (err) {
          failed++;
          console.error(`${tag} ❌ ${err.message}`);
        }
      }

      // Concurrency-limited loop
      async function worker() {
        while (true) {
          const i = cursor++;
          if (i >= broken.length) return;
          await processOne(broken[i]);
        }
      }
      await Promise.all(Array.from({ length: CONCURRENCY }, () => worker()));
      console.log(`[regenerate-broken-previews] DONE — ${succeeded} succeeded, ${failed} failed of ${broken.length}`);
    });
  } catch (err) {
    console.error('[staticsGeneration] /regenerate-broken-previews error:', err);
    res.status(500).json({ success: false, error: { message: err.message } });
  }
}

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

// ─────────────────────────────────────────────────────────────────────────
// REFERENCE PIPELINE — League (Brand Spy) + Meta (Triple Whale) imports
//
// All routes below READ from brand_spy.ads / brand_spy.brands /
// spy_brand_follows / creative_analysis and WRITE reference rows into
// spy_creatives (is_reference=true, status='ready').
// ─────────────────────────────────────────────────────────────────────────

// ── helpers ───────────────────────────────────────────────────────────────

// brand_spy.ads stores the creative under raw_snapshot JSONB.
// IMPORTANT: prefer original_image_url over resized_image_url here — the
// League Import modal renders thumbs at ~400px width on retina, and Meta's
// pre-shrunk resized_image_url (~320px) upscales blurry. The Brand Spy UI
// helper (brandSpyDb.js) keeps resized-first for its narrower grids; this
// SQL is statics-import-specific.
const BRAND_SPY_THUMB_SQL = `
  COALESCE(
    a.raw_snapshot->'videos'->0->>'video_preview_image_url',
    a.raw_snapshot->'images'->0->>'original_image_url',
    a.raw_snapshot->'images'->0->>'resized_image_url',
    a.raw_snapshot->'cards'->0->>'original_image_url',
    a.raw_snapshot->'cards'->0->>'resized_image_url',
    a.raw_snapshot->>'page_profile_picture_url'
  )
`;

function pickAspectRatio(displayFormat) {
  const d = String(displayFormat || '').toUpperCase();
  if (d.includes('SQUARE') || d === 'IMAGE_SQUARE' || d === '1:1') return '1:1';
  return '4:5';
}

// 1. GET /league/brands — followed brands only, with their static-ad count.
router.get('/league/brands', authenticate, async (_req, res) => {
  try {
    await ensureCreativesTable();
    // Prefer followed brands (spy_brand_follows joined through brand_pages
    // by meta_page_id). If the user hasn't followed anyone yet, fall back
    // to every active Brand Spy brand so the import modal still works.
    const followedSql = `
      SELECT
        b.id,
        b.display_name AS name,
        b.domain,
        COALESCE((
          SELECT COUNT(*) FROM brand_spy.ads a
          WHERE a.brand_id = b.id
            AND a.is_active = TRUE
            AND a.display_format ILIKE 'image%'
        ), 0)::INTEGER AS static_count
      FROM brand_spy.brands b
      WHERE EXISTS (
        SELECT 1
        FROM spy_brand_follows sbf
        JOIN brand_spy.brand_pages bp ON bp.meta_page_id = sbf.meta_page_id
        WHERE bp.brand_id = b.id
      )
      ORDER BY b.display_name ASC NULLS LAST, b.domain ASC
    `;
    let rows = await pgQuery(followedSql);
    let followed = true;
    if (rows.length === 0) {
      followed = false;
      rows = await pgQuery(`
        SELECT
          b.id,
          b.display_name AS name,
          b.domain,
          COALESCE((
            SELECT COUNT(*) FROM brand_spy.ads a
            WHERE a.brand_id = b.id
              AND a.is_active = TRUE
              AND a.display_format ILIKE 'image%'
          ), 0)::INTEGER AS static_count
        FROM brand_spy.brands b
        WHERE b.status = 'ACTIVE'
        ORDER BY static_count DESC, b.display_name ASC NULLS LAST, b.domain ASC
        LIMIT 100
      `);
    }
    res.json({ success: true, data: rows, followed });
  } catch (err) {
    console.error('[league/brands] error:', err);
    res.status(500).json({ success: false, error: { message: err.message } });
  }
});

// 2a. GET /league/imported-refs — list spy_creatives rows that the operator
// has explicitly imported from the league (via Brand Follow Config or
// per-card flows). This is the canonical data source for the FROM LEAGUE
// column under the new "explicit-imports-only" model — no live brand_spy.ads
// discovery, no auto-population, only what the operator chose.
//
// Response shape mirrors the old /league/ads card schema so the frontend
// LeagueAdCard component can render either source without forking.
router.get('/league/imported-refs', authenticate, async (_req, res) => {
  try {
    await ensureCreativesTable();
    const rows = await pgQuery(`
      SELECT
        id,
        image_url,
        thumbnail_url,
        source_label,
        reference_name,
        imported_metadata,
        external_ref_key AS ad_archive_id,
        aspect_ratio,
        created_at
      FROM spy_creatives
      WHERE imported_from = 'league'
        AND is_reference = TRUE
        AND status <> 'launched'
        AND parent_creative_id IS NULL
      ORDER BY created_at DESC
      LIMIT 500
    `);

    // Reshape rows into LeagueAdCard's expected schema, pulling fields from
    // imported_metadata JSONB so brand_name / tier / display_format etc. show.
    const data = rows.map(r => {
      const m = r.imported_metadata || {};
      return {
        id: r.id,                       // spy_creatives.id (used as React key)
        ad_archive_id: r.ad_archive_id,
        brand_id: m.brand_id || null,
        brand_name: m.brand_name || r.source_label || 'Unknown brand',
        headline: m.headline || null,
        body_text: m.body_text || null,
        display_format: m.display_format || 'IMAGE',
        tier: m.tier || null,
        tier_score: m.tier_score ?? null,
        current_rank: m.current_rank ?? null,
        active_days: m.active_days ?? null,
        start_date: m.start_date || null,
        end_date: m.end_date || null,
        image_url: r.image_url,
        thumbnail_url: r.thumbnail_url || r.image_url,
        // Always true here — every row in this endpoint IS an import.
        already_imported: true,
        // Carry the spy_creatives PK so the X button can DELETE the right row.
        creative_id: r.id,
        imported_at: r.created_at,
      };
    });

    res.json({ success: true, data, count: data.length });
  } catch (err) {
    console.error('[league/imported-refs] error:', err);
    res.status(500).json({ success: false, error: { message: err.message } });
  }
});

// 2. GET /league/ads — list ads for a brand with tier / format / active filters.
router.get('/league/ads', authenticate, async (req, res) => {
  try {
    await ensureCreativesTable();
    const brandId = req.query.brand_id;
    if (!brandId) {
      return res.status(400).json({ success: false, error: { message: 'brand_id is required' } });
    }
    const tiersCsv = String(req.query.tiers || 'BANGER,CHAMP,A');
    const tiers = tiersCsv.split(',').map(t => t.trim().toUpperCase()).filter(Boolean);
    const format = String(req.query.format || 'IMAGE').toUpperCase();
    const activeOnly = req.query.active_only === undefined ? true : String(req.query.active_only) !== 'false';
    const search = req.query.search ? String(req.query.search).trim() : null;

    const where = ['a.brand_id = $1'];
    const params = [brandId];
    if (tiers.length > 0) {
      params.push(tiers);
      where.push(`a.tier = ANY($${params.length}::text[])`);
    }
    if (format === 'IMAGE') {
      where.push(`a.display_format ILIKE 'image%'`);
    } else if (format === 'CAROUSEL') {
      where.push(`a.display_format ILIKE 'carousel%'`);
    } else {
      // ALL_STATIC — every non-video format (image, carousel, dco, dpa, …).
      // Bug fix: previously had NO display_format filter, so videos slipped
      // through. Defense in depth: require display_format to be NOT NULL
      // AND not start with 'video' (case-insensitive).
      where.push(`a.display_format IS NOT NULL`);
      where.push(`a.display_format NOT ILIKE 'video%'`);
    }
    if (activeOnly) {
      where.push(`a.is_active = TRUE`);
    }
    if (search) {
      params.push(`%${search}%`);
      const i = params.length;
      where.push(`(a.headline ILIKE $${i} OR a.body_text ILIKE $${i} OR a.caption ILIKE $${i})`);
    }

    // Dismissed-ad join — persistent X-button state from league_dismissed_ads.
    // We LEFT JOIN and exclude in the WHERE so dismissed cards never come back
    // until the operator explicitly undoes (DELETE /league/dismiss/...).
    where.push(`NOT EXISTS (
      SELECT 1 FROM league_dismissed_ads d
      WHERE d.brand_id = a.brand_id
        AND d.ad_archive_id = a.ad_archive_id
    )`);

    const sql = `
      SELECT
        a.id, a.ad_archive_id, a.headline, a.body_text, a.display_format,
        a.tier, a.tier_score, a.current_rank, a.is_active,
        a.start_date, a.end_date, a.active_days,
        ${BRAND_SPY_THUMB_SQL} AS image_url,
        EXISTS (
          SELECT 1 FROM spy_creatives sc
          WHERE sc.imported_from = 'league'
            AND sc.external_ref_key = a.ad_archive_id
        ) AS already_imported
      FROM brand_spy.ads a
      WHERE ${where.join(' AND ')}
      ORDER BY a.tier_score DESC NULLS LAST, a.current_rank ASC NULLS LAST
      LIMIT 500
    `;
    const rows = await pgQuery(sql, params);
    res.json({ success: true, data: rows, count: rows.length });
  } catch (err) {
    console.error('[league/ads] error:', err);
    res.status(500).json({ success: false, error: { message: err.message } });
  }
});

// 2b. POST /league/dismiss — persistent X-button. Hides a card from FROM
// LEAGUE forever (until DELETE'd). Body: { brand_id, ad_archive_id }
router.post('/league/dismiss', authenticate, async (req, res) => {
  try {
    const { brand_id, ad_archive_id } = req.body || {};
    if (!brand_id || !ad_archive_id) {
      return res.status(400).json({ success: false, error: { message: 'brand_id and ad_archive_id required' } });
    }
    await pgQuery(
      `INSERT INTO league_dismissed_ads (brand_id, ad_archive_id)
       VALUES ($1, $2)
       ON CONFLICT (brand_id, ad_archive_id) DO NOTHING`,
      [brand_id, ad_archive_id]
    );
    res.json({ success: true });
  } catch (err) {
    console.error('[league/dismiss POST] error:', err);
    res.status(500).json({ success: false, error: { message: err.message } });
  }
});

// 2c. DELETE /league/dismiss/:brand_id/:ad_archive_id — undo a dismissal.
router.delete('/league/dismiss/:brand_id/:ad_archive_id', authenticate, async (req, res) => {
  try {
    const { brand_id, ad_archive_id } = req.params;
    const r = await pgQuery(
      `DELETE FROM league_dismissed_ads
        WHERE brand_id = $1 AND ad_archive_id = $2
        RETURNING brand_id`,
      [brand_id, ad_archive_id]
    );
    res.json({ success: true, restored: r.length });
  } catch (err) {
    console.error('[league/dismiss DELETE] error:', err);
    res.status(500).json({ success: false, error: { message: err.message } });
  }
});

// 3. POST /league/import — push selected Brand Spy ads into the Reference column.
router.post('/league/import', authenticate, async (req, res) => {
  try {
    await ensureCreativesTable();
    const { brand_id, ad_ids } = req.body || {};
    if (!brand_id || !Array.isArray(ad_ids) || ad_ids.length === 0) {
      return res.status(400).json({ success: false, error: { message: 'brand_id and ad_ids[] are required' } });
    }

    // Pull brand display name + each ad's full payload in one query.
    const adRows = await pgQuery(`
      SELECT
        a.id, a.ad_archive_id, a.brand_id, a.headline, a.body_text, a.display_format,
        a.tier, a.active_days, a.start_date, a.end_date,
        ${BRAND_SPY_THUMB_SQL} AS image_url,
        b.display_name AS brand_name,
        b.domain AS brand_domain
      FROM brand_spy.ads a
      JOIN brand_spy.brands b ON b.id = a.brand_id
      WHERE a.id = ANY($1::uuid[]) AND a.brand_id = $2
    `, [ad_ids, brand_id]);

    // Batch dedup lookup (audit N+1 fix): one SELECT for all existing keys
    // instead of one per ad.
    const adKeys = adRows.map(ad => String(ad.ad_archive_id));
    const existingRows = adKeys.length > 0
      ? await pgQuery(
          `SELECT external_ref_key FROM spy_creatives
            WHERE imported_from = 'league' AND external_ref_key = ANY($1::text[])`,
          [adKeys]
        )
      : [];
    const alreadyImported = new Set(existingRows.map(r => r.external_ref_key));

    // Build bulk INSERT payload, then ship in one round-trip via unnest().
    // ON CONFLICT skips any race-condition dup that lands between SELECT and INSERT.
    const insertImageUrls = [];
    const insertSourceLabels = [];
    const insertMetadataJson = [];
    const insertAspectRatios = [];
    const insertExternalKeys = [];
    let skipped = 0;
    for (const ad of adRows) {
      if (alreadyImported.has(String(ad.ad_archive_id))) {
        skipped++;
        continue;
      }
      const brandName = ad.brand_name || ad.brand_domain || 'Unknown brand';
      const meta = {
        tier: ad.tier,
        ad_archive_id: ad.ad_archive_id,
        brand_id: ad.brand_id,
        brand_name: brandName,
        headline: ad.headline,
        body_text: ad.body_text,
        display_format: ad.display_format,
        active_days: ad.active_days,
        start_date: ad.start_date,
        end_date: ad.end_date,
      };
      insertImageUrls.push(ad.image_url);
      insertSourceLabels.push(brandName);
      insertMetadataJson.push(JSON.stringify(meta));
      insertAspectRatios.push(pickAspectRatio(ad.display_format));
      insertExternalKeys.push(String(ad.ad_archive_id));
    }

    let imported = 0;
    if (insertImageUrls.length > 0) {
      const insertedRows = await pgQuery(`
        INSERT INTO spy_creatives
          (pipeline, status, is_reference, imported_from, external_ref_key,
           image_url, thumbnail_url, source_label, reference_name,
           reference_thumbnail, imported_metadata, aspect_ratio)
        SELECT 'standard', 'ready', TRUE, 'league',
               t.external_ref_key,
               t.image_url, t.image_url, t.source_label, t.source_label,
               t.image_url, t.meta_json::jsonb, t.aspect_ratio
          FROM unnest(
            $1::text[], $2::text[], $3::text[], $4::text[], $5::text[]
          ) AS t(image_url, source_label, meta_json, aspect_ratio, external_ref_key)
        RETURNING id
      `, [insertImageUrls, insertSourceLabels, insertMetadataJson, insertAspectRatios, insertExternalKeys]);
      imported = insertedRows.length;
    }

    res.json({
      success: true,
      data: { imported, skipped, skipped_reason: skipped ? 'already_imported' : null },
    });
  } catch (err) {
    console.error('[league/import] error:', err);
    res.status(500).json({ success: false, error: { message: err.message } });
  }
});

// ═════════════════════════════════════════════════════════════════════════
// LEAGUE BRAND-CONFIG — per-brand import preferences for FROM LEAGUE column
// (migration 059: league_brand_configs table)
// ═════════════════════════════════════════════════════════════════════════

// Defaults applied when a brand has no row in league_brand_configs yet.
const LEAGUE_CONFIG_DEFAULTS = Object.freeze({
  top_pct: 10,
  tier_filter: null,
  max_copy_length: null,
  auto_sync_enabled: false,
  auto_sync_interval_hours: 4,
  last_synced_at: null,
});

function mergeBrandConfig(row) {
  if (!row) return { ...LEAGUE_CONFIG_DEFAULTS };
  return {
    top_pct: row.top_pct ?? LEAGUE_CONFIG_DEFAULTS.top_pct,
    tier_filter: row.tier_filter ?? null,
    max_copy_length: row.max_copy_length ?? null,
    auto_sync_enabled: !!row.auto_sync_enabled,
    auto_sync_interval_hours: row.auto_sync_interval_hours ?? LEAGUE_CONFIG_DEFAULTS.auto_sync_interval_hours,
    last_synced_at: row.last_synced_at ?? null,
  };
}

// GET /league/brand-configs — followed brands + their import configs +
// projected import counts (so the UI can show "will import ~30" labels).
//
// Mirrors /league/brands' fallback so the modal can NEVER show fewer brands
// than the FROM LEAGUE column. Order of preference:
//   1. spy_brand_follows JOIN brand_pages  (formally followed)
//   2. brand_spy.brands WHERE status='ACTIVE' LIMIT 100  (fallback)
// The `followed` flag in the response tells the UI which source was used.
router.get('/league/brand-configs', authenticate, async (_req, res) => {
  try {
    const followedSql = `
      SELECT
        b.id, b.display_name AS name, b.domain,
        COALESCE((
          SELECT COUNT(*) FROM brand_spy.ads a
          WHERE a.brand_id = b.id
            AND a.is_active = TRUE
            AND a.display_format ILIKE 'image%'
        ), 0)::INTEGER AS active_image_count,
        COALESCE((
          SELECT COUNT(*) FROM brand_spy.ads a
          WHERE a.brand_id = b.id
        ), 0)::INTEGER AS total_ads,
        c.top_pct, c.tier_filter, c.max_copy_length,
        c.auto_sync_enabled, c.auto_sync_interval_hours, c.last_synced_at
      FROM brand_spy.brands b
      LEFT JOIN league_brand_configs c ON c.brand_id = b.id
      WHERE EXISTS (
        SELECT 1
        FROM spy_brand_follows sbf
        JOIN brand_spy.brand_pages bp ON bp.meta_page_id = sbf.meta_page_id
        WHERE bp.brand_id = b.id
      )
      ORDER BY b.display_name ASC NULLS LAST, b.domain ASC
    `;
    let rows = await pgQuery(followedSql);
    let followed = true;
    if (rows.length === 0) {
      followed = false;
      rows = await pgQuery(`
        SELECT
          b.id, b.display_name AS name, b.domain,
          COALESCE((
            SELECT COUNT(*) FROM brand_spy.ads a
            WHERE a.brand_id = b.id
              AND a.is_active = TRUE
              AND a.display_format ILIKE 'image%'
          ), 0)::INTEGER AS active_image_count,
          COALESCE((
            SELECT COUNT(*) FROM brand_spy.ads a
            WHERE a.brand_id = b.id
          ), 0)::INTEGER AS total_ads,
          c.top_pct, c.tier_filter, c.max_copy_length,
          c.auto_sync_enabled, c.auto_sync_interval_hours, c.last_synced_at
        FROM brand_spy.brands b
        LEFT JOIN league_brand_configs c ON c.brand_id = b.id
        WHERE b.status = 'ACTIVE'
        ORDER BY active_image_count DESC, b.display_name ASC NULLS LAST, b.domain ASC
        LIMIT 100
      `);
    }

    const data = rows.map(r => {
      const config = mergeBrandConfig(r);
      const projected = Math.max(1, Math.ceil(r.active_image_count * (config.top_pct / 100)));
      return {
        id: r.id,
        name: r.name,
        domain: r.domain,
        active_image_count: r.active_image_count,
        total_ads: r.total_ads,
        projected_import_count: r.active_image_count > 0 ? projected : 0,
        config,
      };
    });

    res.json({ success: true, data, followed });
  } catch (err) {
    console.error('[league/brand-configs GET] error:', err);
    res.status(500).json({ success: false, error: { message: err.message } });
  }
});

// POST /league/brand-configs/auto-sync-all — bulk-flip every config's
// auto_sync_enabled in one call. Body: { enabled: boolean }. Used by the
// Control Center master toggle so the operator can pause/resume all
// auto-syncs without expanding each brand. Returns the count touched.
router.post('/league/brand-configs/auto-sync-all', authenticate, async (req, res) => {
  try {
    const enabled = !!req.body?.enabled;
    const result = await pgQuery(
      `UPDATE league_brand_configs
          SET auto_sync_enabled = $1, updated_at = NOW()
        WHERE auto_sync_enabled <> $1
        RETURNING brand_id`,
      [enabled]
    );
    res.json({ success: true, data: { enabled, touched: result.length } });
  } catch (err) {
    console.error('[league/brand-configs auto-sync-all] error:', err);
    res.status(500).json({ success: false, error: { message: err.message } });
  }
});

// POST /league/brand-configs/sync-all — sequential per-brand sync for every
// brand with auto_sync_enabled OR a tier_filter/top_pct override (i.e.
// anything the operator has touched). Returns aggregated counts so the UI
// can show "X imported, Y skipped, Z scanned" without N round-trips.
router.post('/league/brand-configs/sync-all', authenticate, async (req, res) => {
  try {
    // Eligible = same query as GET but only rows the operator has explicitly
    // engaged with. Falls back to ALL followed brands when no configs exist
    // (first-run convenience).
    const eligible = await pgQuery(`
      SELECT b.id
      FROM brand_spy.brands b
      LEFT JOIN league_brand_configs c ON c.brand_id = b.id
      WHERE EXISTS (
        SELECT 1 FROM spy_brand_follows sbf
        JOIN brand_spy.brand_pages bp ON bp.meta_page_id = sbf.meta_page_id
        WHERE bp.brand_id = b.id
      )
      ORDER BY b.display_name ASC NULLS LAST
    `);

    let totalScanned = 0, totalImported = 0, totalSkipped = 0;
    const errors = [];
    // Loopback base — same pattern as _doRepairAllPreviews (prefers
    // RENDER_EXTERNAL_URL so we hit the real listener, falls back to
    // localhost:${PORT || 3000} for local dev).
    const base = process.env.RENDER_EXTERNAL_URL || `http://localhost:${process.env.PORT || 3000}`;
    const authHeaders = {};
    if (req.headers.authorization) authHeaders.authorization = req.headers.authorization;

    // Sequential to avoid stampeding the brand_spy.ads index + spy_creatives
    // upsert path. Tens of brands × ~tens of picks = well under a minute.
    for (const row of eligible) {
      try {
        const r = await fetch(
          `${base}/api/v1/statics-generation/league/brand-configs/${row.id}/sync`,
          {
            method: 'POST',
            headers: { 'Content-Type': 'application/json', ...authHeaders },
            signal: AbortSignal.timeout(60_000),
          }
        );
        const j = await r.json().catch(() => ({}));
        if (j?.success && j.data) {
          totalScanned  += Number(j.data.scanned  || 0);
          totalImported += Number(j.data.imported || 0);
          totalSkipped  += Number(j.data.skipped  || 0);
        } else {
          errors.push({ brandId: row.id, status: r.status, error: j?.error?.message || `status ${r.status}` });
        }
      } catch (e) {
        errors.push({ brandId: row.id, error: e.message });
      }
    }

    res.json({
      success: true,
      data: {
        brands: eligible.length,
        scanned: totalScanned,
        imported: totalImported,
        skipped: totalSkipped,
        errors,
      },
    });
  } catch (err) {
    console.error('[league/brand-configs sync-all] error:', err);
    res.status(500).json({ success: false, error: { message: err.message } });
  }
});

// PATCH /league/brand-configs/:brandId — upsert per-brand config.
router.patch('/league/brand-configs/:brandId', authenticate, async (req, res) => {
  try {
    const { brandId } = req.params;
    if (!brandId) return res.status(400).json({ success: false, error: { message: 'brandId required' } });

    const body = req.body || {};
    const ALLOWED_TIERS = ['BANGER', 'CHAMP', 'A', 'B', 'C', 'MID', 'TEST'];

    // Validate + normalize each optional field. Unspecified fields are
    // preserved (UPSERT only writes provided columns).
    const top_pct = body.top_pct != null
      ? Math.max(1, Math.min(100, parseInt(body.top_pct, 10) || LEAGUE_CONFIG_DEFAULTS.top_pct))
      : null;
    const tier_filter = Array.isArray(body.tier_filter)
      ? body.tier_filter.map(t => String(t).toUpperCase()).filter(t => ALLOWED_TIERS.includes(t))
      : (body.tier_filter === null ? null : undefined);
    const max_copy_length = body.max_copy_length === null
      ? null
      : (body.max_copy_length != null
          ? Math.max(1, parseInt(body.max_copy_length, 10) || 0) || null
          : undefined);
    const auto_sync_enabled = body.auto_sync_enabled != null ? !!body.auto_sync_enabled : null;
    const auto_sync_interval_hours = body.auto_sync_interval_hours != null
      ? Math.max(1, Math.min(168, parseInt(body.auto_sync_interval_hours, 10) || 4))
      : null;

    // INSERT … ON CONFLICT DO UPDATE — coalesce against incoming so we only
    // overwrite the columns the caller actually passed.
    const rows = await pgQuery(
      `INSERT INTO league_brand_configs
         (brand_id, top_pct, tier_filter, max_copy_length, auto_sync_enabled, auto_sync_interval_hours)
       VALUES ($1,
               COALESCE($2, ${LEAGUE_CONFIG_DEFAULTS.top_pct}),
               $3::text[],
               $4,
               COALESCE($5, FALSE),
               COALESCE($6, ${LEAGUE_CONFIG_DEFAULTS.auto_sync_interval_hours}))
       ON CONFLICT (brand_id) DO UPDATE SET
         top_pct                  = COALESCE($2, league_brand_configs.top_pct),
         tier_filter              = CASE WHEN $7::boolean THEN $3::text[]
                                         ELSE league_brand_configs.tier_filter END,
         max_copy_length          = CASE WHEN $8::boolean THEN $4
                                         ELSE league_brand_configs.max_copy_length END,
         auto_sync_enabled        = COALESCE($5, league_brand_configs.auto_sync_enabled),
         auto_sync_interval_hours = COALESCE($6, league_brand_configs.auto_sync_interval_hours),
         updated_at               = NOW()
       RETURNING *`,
      [
        brandId,
        top_pct,
        tier_filter === undefined ? null : tier_filter,
        max_copy_length === undefined ? null : max_copy_length,
        auto_sync_enabled,
        auto_sync_interval_hours,
        tier_filter !== undefined,
        max_copy_length !== undefined,
      ]
    );

    res.json({ success: true, data: mergeBrandConfig(rows[0]) });
  } catch (err) {
    console.error('[league/brand-configs PATCH] error:', err);
    res.status(500).json({ success: false, error: { message: err.message } });
  }
});

// POST /league/brand-configs/:brandId/sync — manual one-shot sync.
// Reads config (or defaults), pulls top top_pct% of active image ads from
// brand_spy.ads filtered by tier_filter, INSERTs into spy_creatives as
// imported_from='league' (ON CONFLICT skips already-imported). Updates
// last_synced_at on success.
router.post('/league/brand-configs/:brandId/sync', authenticate, async (req, res) => {
  try {
    const { brandId } = req.params;
    if (!brandId) return res.status(400).json({ success: false, error: { message: 'brandId required' } });

    // Manual count override — when the operator picks an exact number in
    // the Import button's count picker, we use that instead of the
    // configured top_pct math. Range-clamped 1..500. Body { count: N }.
    const manualCountRaw = req.body?.count;
    const manualCount = (manualCountRaw != null && Number.isFinite(Number(manualCountRaw)))
      ? Math.max(1, Math.min(500, Math.floor(Number(manualCountRaw))))
      : null;

    // Resolve current config (or defaults if no row yet).
    const cfgRows = await pgQuery('SELECT * FROM league_brand_configs WHERE brand_id = $1', [brandId]);
    const config = mergeBrandConfig(cfgRows[0]);

    // Build the candidate query — active image ads, optionally tier-filtered,
    // sorted best-first.
    const where = [
      'a.brand_id = $1',
      'a.is_active = TRUE',
      `a.display_format ILIKE 'image%'`,
    ];
    const params = [brandId];
    if (Array.isArray(config.tier_filter) && config.tier_filter.length > 0) {
      params.push(config.tier_filter);
      where.push(`a.tier = ANY($${params.length}::text[])`);
    }

    // Max copy length filter (applied via length(headline || body_text || caption))
    if (config.max_copy_length) {
      params.push(config.max_copy_length);
      where.push(`COALESCE(length(a.headline), 0)
                + COALESCE(length(a.body_text), 0)
                + COALESCE(length(a.caption), 0) <= $${params.length}`);
    }

    const candidates = await pgQuery(`
      SELECT
        a.id, a.ad_archive_id, a.brand_id, a.headline, a.body_text, a.display_format,
        a.tier, a.tier_score, a.current_rank, a.active_days, a.start_date, a.end_date,
        ${BRAND_SPY_THUMB_SQL} AS image_url,
        b.display_name AS brand_name,
        b.domain AS brand_domain
      FROM brand_spy.ads a
      JOIN brand_spy.brands b ON b.id = a.brand_id
      WHERE ${where.join(' AND ')}
      ORDER BY a.tier_score DESC NULLS LAST, a.current_rank ASC NULLS LAST, a.id
    `, params);

    const totalCandidates = candidates.length;
    // Pick count: manual override wins if provided; otherwise top_pct math.
    const takeN = totalCandidates === 0
      ? 0
      : (manualCount != null
          ? Math.min(manualCount, totalCandidates)
          : Math.max(1, Math.ceil(totalCandidates * (config.top_pct / 100))));
    const picks = candidates.slice(0, takeN);

    if (picks.length === 0) {
      // Update last_synced_at even on empty result so the UI shows recent activity.
      await pgQuery(
        `INSERT INTO league_brand_configs (brand_id, last_synced_at)
         VALUES ($1, NOW())
         ON CONFLICT (brand_id) DO UPDATE SET last_synced_at = NOW(), updated_at = NOW()`,
        [brandId]
      );
      return res.json({ success: true, data: { scanned: totalCandidates, imported: 0, skipped: 0 } });
    }

    // Dedup existing imports (same pattern as /league/import).
    const adKeys = picks.map(p => String(p.ad_archive_id));
    const existing = await pgQuery(
      `SELECT external_ref_key FROM spy_creatives
        WHERE imported_from = 'league' AND external_ref_key = ANY($1::text[])`,
      [adKeys]
    );
    const alreadyImported = new Set(existing.map(r => r.external_ref_key));

    const insertImageUrls = [];
    const insertSourceLabels = [];
    const insertMetadataJson = [];
    const insertAspectRatios = [];
    const insertExternalKeys = [];
    let skipped = 0;
    for (const ad of picks) {
      if (alreadyImported.has(String(ad.ad_archive_id))) { skipped++; continue; }
      const brandName = ad.brand_name || ad.brand_domain || 'Unknown brand';
      const meta = {
        tier: ad.tier,
        tier_score: ad.tier_score,
        current_rank: ad.current_rank,
        ad_archive_id: ad.ad_archive_id,
        brand_id: ad.brand_id,
        brand_name: brandName,
        headline: ad.headline,
        body_text: ad.body_text,
        display_format: ad.display_format,
        active_days: ad.active_days,
        start_date: ad.start_date,
        end_date: ad.end_date,
      };
      insertImageUrls.push(ad.image_url);
      insertSourceLabels.push(brandName);
      insertMetadataJson.push(JSON.stringify(meta));
      insertAspectRatios.push(pickAspectRatio(ad.display_format));
      insertExternalKeys.push(String(ad.ad_archive_id));
    }

    let imported = 0;
    if (insertImageUrls.length > 0) {
      const insertedRows = await pgQuery(`
        INSERT INTO spy_creatives
          (pipeline, status, is_reference, imported_from, external_ref_key,
           image_url, thumbnail_url, source_label, reference_name,
           reference_thumbnail, imported_metadata, aspect_ratio)
        SELECT 'standard', 'ready', TRUE, 'league',
               t.external_ref_key,
               t.image_url, t.image_url, t.source_label, t.source_label,
               t.image_url, t.meta_json::jsonb, t.aspect_ratio
          FROM unnest(
            $1::text[], $2::text[], $3::text[], $4::text[], $5::text[]
          ) AS t(image_url, source_label, meta_json, aspect_ratio, external_ref_key)
        ON CONFLICT DO NOTHING
        RETURNING id
      `, [insertImageUrls, insertSourceLabels, insertMetadataJson, insertAspectRatios, insertExternalKeys]);
      imported = insertedRows.length;
    }

    // Stamp last_synced_at on the config row (upsert if missing).
    await pgQuery(
      `INSERT INTO league_brand_configs (brand_id, last_synced_at)
       VALUES ($1, NOW())
       ON CONFLICT (brand_id) DO UPDATE SET last_synced_at = NOW(), updated_at = NOW()`,
      [brandId]
    );

    console.log(`[league/brand-configs sync ${brandId.slice(0, 8)}…] scanned=${totalCandidates} picks=${picks.length} imported=${imported} skipped=${skipped}`);
    res.json({
      success: true,
      data: { scanned: totalCandidates, picked: picks.length, imported, skipped },
    });
  } catch (err) {
    console.error('[league/brand-configs sync] error:', err);
    res.status(500).json({ success: false, error: { message: err.message } });
  }
});

// ── TW sync trigger (internal) ────────────────────────────────────────────
// Calls the analytics worktree's /sync-weekly endpoint with CRON_SECRET so the
// Meta-import modal can force a fresh pull (or auto-trigger one when the table
// has stale / pre-account-column rows). Fire-and-forget by default so the
// caller doesn't block on TW's 10-30s round-trip.
let _twSyncInFlight = false;
let _twSyncLastFinishedAt = 0;
const TW_SYNC_MIN_INTERVAL_MS = 60 * 1000; // never trigger more than once a minute
async function triggerTWSync({ awaitResult = false } = {}) {
  if (_twSyncInFlight) return { triggered: false, reason: 'already_in_flight' };
  if (Date.now() - _twSyncLastFinishedAt < TW_SYNC_MIN_INTERVAL_MS) {
    return { triggered: false, reason: 'rate_limited' };
  }
  const secret = process.env.CRON_SECRET;
  if (!secret) {
    console.warn('[meta-ads/refresh] CRON_SECRET not set — cannot trigger /sync-weekly');
    return { triggered: false, reason: 'no_cron_secret' };
  }
  const base = process.env.RENDER_EXTERNAL_URL || `http://localhost:${process.env.PORT || 3000}`;
  const url = `${base}/api/v1/creative-analysis/sync-weekly`;
  _twSyncInFlight = true;
  const work = (async () => {
    try {
      const res = await fetch(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'x-cron-secret': secret },
        signal: AbortSignal.timeout(60_000),
      });
      const body = await res.json().catch(() => ({}));
      if (!res.ok) {
        console.warn(`[meta-ads/refresh] TW sync ${res.status}: ${JSON.stringify(body).slice(0, 200)}`);
        return { ok: false, status: res.status, body };
      }
      // Bust the column cache so freshly-added columns surface on next request
      _caColsCache = null;
      console.log(`[meta-ads/refresh] TW sync OK: ${JSON.stringify(body?.data || body).slice(0, 200)}`);
      return { ok: true, body };
    } catch (err) {
      console.error('[meta-ads/refresh] TW sync error:', err.message);
      return { ok: false, error: err.message };
    } finally {
      _twSyncLastFinishedAt = Date.now();
      _twSyncInFlight = false;
    }
  })();
  if (awaitResult) {
    const result = await work;
    return { triggered: true, ...result };
  }
  // fire-and-forget
  work.catch(() => {}); // swallow — already logged
  return { triggered: true, async: true };
}

// ═════════════════════════════════════════════════════════════════════════
// TW DIRECT QUERY — bypass creative_analysis cache, hit Triple Whale's SQL
// API. Used by /meta-ads/ads when ?source=tw (default) so the numbers
// match TW's UI exactly. Same shop + attribution config as the Analytics
// sync worker.
// ═════════════════════════════════════════════════════════════════════════
const _TW_API_KEY = process.env.TRIPLEWHALE_API_KEY || '';
const _TW_SHOP_ID = process.env.TRIPLEWHALE_SHOP_ID || '17cca0-2.myshopify.com';
const _TW_SQL_URL = 'https://api.triplewhale.com/api/v2/orcabase/api/sql';
const _TW_ATTRIBUTION_DEFAULT = process.env.TW_ATTRIBUTION_MODEL || 'lastPlatformClick';
// Defaults aligned to TW UI's Triple Attribution + Meta view (the operator's
// reference). adsReporting.js (the dashboard's existing Ads Report page that
// already matches TW) uses `order_revenue` + `website_purchases` with the
// `channel='facebook-ads'` filter — replicate that exact combo here.
const _TW_REVENUE_COL  = process.env.TW_REVENUE_COL  || 'order_revenue';
const _TW_PURCHASE_COL = process.env.TW_PURCHASE_COL || 'website_purchases';
// Channel filter — operator's TW screenshot was Meta-only filtered, and
// adsReporting.js proves the pixel_joined_tvf schema uses `channel='facebook-ads'`
// for Meta rows. Hardcoded here so the spend column drops from $9.7k (all
// channels) to ~$4.1k (Meta only), matching the TW UI.
const _TW_META_CHANNEL_FILTER = `channel = 'facebook-ads'`;

// Per-process column-discovery cache so we don't re-probe TW on every
// /meta-ads/ads call. Mirrors the Analytics worker's cache (separate
// instance — each process learns once).
let _twKnownAccountCols = null; // { idCol, nameCol, idOnly? } | false | null

async function _twQuery(sql, startDate, endDate, attributionModel) {
  if (!_TW_API_KEY) throw new Error('TRIPLEWHALE_API_KEY not configured');
  const res = await fetch(_TW_SQL_URL, {
    method: 'POST',
    headers: { 'x-api-key': _TW_API_KEY, 'Content-Type': 'application/json' },
    body: JSON.stringify({
      shopId: _TW_SHOP_ID,
      query: sql.trim(),
      period: { startDate, endDate },
      attributionModel,
    }),
    signal: AbortSignal.timeout(30000),
  });
  if (res.status === 401 || res.status === 403) {
    const txt = await res.text();
    throw new Error(`TW auth ${res.status}: ${txt.slice(0, 120)}`);
  }
  if (!res.ok) {
    const txt = await res.text();
    throw new Error(`TW ${res.status}: ${txt.slice(0, 120)}`);
  }
  const data = await res.json();
  return Array.isArray(data) ? data : (data?.data || data?.rows || []);
}

// Returns the SELECT clause for the account columns, or '' if not yet known
// or proven unsupported. Discovery runs once per process.
async function _twDiscoverAccountCols(startDate, endDate, attributionModel) {
  if (_twKnownAccountCols === false) return null;
  if (_twKnownAccountCols && _twKnownAccountCols.idCol) return _twKnownAccountCols;
  const variants = [
    { idCol: 'ad_account_id', nameCol: 'ad_account_name' },
    { idCol: 'account_id',    nameCol: 'account_name' },
    { idCol: 'source_id',     nameCol: 'source_name' },
    { idCol: 'account_id',    nameCol: 'account_id', idOnly: true },
  ];
  const revRef = _TW_REVENUE_COL;
  for (const v of variants) {
    const selectAcct = v.idOnly
      ? `${v.idCol} as ad_account_id, ${v.idCol} as ad_account_name,`
      : `${v.idCol} as ad_account_id, ${v.nameCol} as ad_account_name,`;
    const groupAcct = v.idOnly ? `, ${v.idCol}` : `, ${v.idCol}, ${v.nameCol}`;
    const probeSql = `
      SELECT ${selectAcct} ad_name, SUM(spend) as total_spend
      FROM pixel_joined_tvf
      WHERE event_date BETWEEN @startDate AND @endDate
        AND ${_TW_META_CHANNEL_FILTER}
      GROUP BY ad_name${groupAcct}
      LIMIT 1
    `;
    try {
      await _twQuery(probeSql, startDate, endDate, attributionModel);
      _twKnownAccountCols = v;
      console.log(`[meta-ads/tw-direct] account-col discovery: id="${v.idCol}", name="${v.nameCol}"${v.idOnly ? ' (id-only)' : ''}`);
      return v;
    } catch {
      // try next
    }
  }
  _twKnownAccountCols = false;
  return null;
}

/**
 * Fetch the top ads by spend from Triple Whale's SQL warehouse directly.
 * @param {number} windowDays   7 | 30 | 90
 * @param {string} attributionModel  TW attribution mode (default from env)
 * @param {string[]} accountIds      optional filter; empty = all accounts
 * @param {number}  minSpend         server-side prefilter
 */
async function fetchTopAdsFromTW({ windowDays, attributionModel, accountIds = [], minSpend = 0, activeOnly = false }) {
  if (!_TW_API_KEY) throw new Error('TRIPLEWHALE_API_KEY not configured');
  // TW UI's "Last 7 Days" = the 7 days ENDING YESTERDAY (not including today).
  // Verified empirically: /meta-ads/_twverify?window=last7excl returned an
  // exact $11,922.73 revenue match against the operator's TW UI screenshot
  // for the same period; including today drifted by ~9%.
  const todayMs = Date.now();
  const endMs   = todayMs - 86400 * 1000;                                  // yesterday
  const startMs = endMs   - ((windowDays - 1) * 86400 * 1000);             // N-1 days before yesterday
  const endDate   = new Date(endMs).toISOString().slice(0, 10);
  const startDate = new Date(startMs).toISOString().slice(0, 10);
  const attr = attributionModel || _TW_ATTRIBUTION_DEFAULT;

  const acct = await _twDiscoverAccountCols(startDate, endDate, attr);
  const acctSelect = acct
    ? (acct.idOnly
        ? `${acct.idCol} as ad_account_id, ${acct.idCol} as ad_account_name,`
        : `${acct.idCol} as ad_account_id, ${acct.nameCol} as ad_account_name,`)
    : `'unknown' as ad_account_id, 'Unknown' as ad_account_name,`;
  const acctGroup = acct
    ? (acct.idOnly ? `, ${acct.idCol}` : `, ${acct.idCol}, ${acct.nameCol}`)
    : '';

  // Build the main aggregation query. Spend/revenue/purchases come from TW
  // with the operator's chosen attribution model — these are the numbers
  // that should match the TW UI exactly. Filter to Meta-only via the
  // pixel_joined_tvf `channel` column (confirmed in adsReporting.js).
  // STATIC-ONLY filter — mirrors briefPipeline.staticAdExclusionClause but
  // INVERTED (that one EXCLUDES statics from a video query; we INCLUDE only
  // statics). TW's `type` column is unreliable (tags statics as 'video'
  // sometimes — see brief-pipeline b14fa78 commit). Mineblock naming is
  // the strong signal:
  //   • ad_name contains " IMG " token (format-slot convention)
  //   • ad_name contains "1080x1080" or "1080×1080" (square dims)
  // PHASE 1 of the "fix Meta Import once for all" scope (operator-confirmed):
  // we DROPPED the ad_name regex (\\bIMG\\d*\\b OR 1080x1080) here. It was
  // unreliable in both directions — IM/IT/MR/VX/B-codes all appear in BOTH
  // static AND video creatives in Mineblock's convention. After 3 attempts
  // we accepted that ad_name is not a usable signal. Static-vs-video
  // classification now lives entirely in Layer 2 (creative_analysis.type
  // join post-fetch) with a three-bucket model: 'image' / 'video' /
  // 'unverified'. Unverified ads are SURFACED with a badge, not silently
  // hidden, so the operator sees their winning ads and can verify per-card.

  // LAYER 1 ACTIVE GUARD — when the operator picks the ACTIVE chip we add
  // a 48h-spend HAVING clause. Reasoning: an ad that hasn't spent in 48h
  // is almost certainly paused / archived / out of budget. Cheap proxy
  // for Meta's effective_status, no extra round-trip. Window-scoped end
  // date (yesterday) so we check the freshest 2 days of data.
  // Layer 2 (creative_analysis.ad_status post-fetch) catches the
  // remaining cases where the ad spent within 48h but is now paused.
  const activeHaving = activeOnly
    ? `AND SUM(if(event_date >= addDays(toDate(@endDate), -1), spend, 0)) > 0`
    : '';

  const sql = `
    SELECT ${acctSelect}
           ad_name,
           SUM(spend)               as total_spend,
           SUM(if(event_date >= addDays(toDate(@endDate), -1), spend, 0)) as spend_48h,
           SUM(${_TW_REVENUE_COL})  as total_revenue,
           SUM(${_TW_PURCHASE_COL}) as total_purchases,
           SUM(impressions)         as total_impressions,
           SUM(clicks)              as total_clicks
      FROM pixel_joined_tvf
     WHERE event_date BETWEEN @startDate AND @endDate
       AND ${_TW_META_CHANNEL_FILTER}
     GROUP BY ad_name${acctGroup}
    HAVING SUM(spend) > ${Number(minSpend) || 0.01}
           ${activeHaving}
     ORDER BY SUM(spend) DESC
     LIMIT 500
  `;
  const rows = await _twQuery(sql, startDate, endDate, attr);

  // Optional client-side account filter (the SQL already returns the column
  // but we want a strict whitelist when the operator picked specific chips).
  const filtered = (accountIds && accountIds.length > 0)
    ? rows.filter(r => accountIds.includes(String(r.ad_account_id || '')))
    : rows;

  return filtered.map(r => ({
    ad_name: r.ad_name,
    ad_account_id: String(r.ad_account_id || 'unknown'),
    account_name: String(r.ad_account_name || r.ad_account_id || 'Unknown'),
    spend: Number(r.total_spend) || 0,
    spend_48h: Number(r.spend_48h) || 0,
    revenue: Number(r.total_revenue) || 0,
    purchases: Number(r.total_purchases) || 0,
    impressions: Number(r.total_impressions) || 0,
    clicks: Number(r.total_clicks) || 0,
  }));
}

// GET /meta-ads/probe-attribution — one-shot probe to find which TW
// attribution-model value matches the operator's TW UI screenshot.
// Hits TW with each candidate, returns the total spend + a sample row
// per mode. Operator picks the row that matches their TW UI, then we
// set TW_ATTRIBUTION_MODEL=<that value>.
//
// Usage: GET /meta-ads/probe-attribution?ad_name=<exact_ad_name>
// Pick an ad_name from your TW screenshot and compare each row's
// spend/revenue against TW's number. The matching row IS the correct
// attribution mode.
router.get('/meta-ads/probe-attribution', authenticate, async (req, res) => {
  try {
    if (!_TW_API_KEY) return res.status(500).json({ success: false, error: { message: 'TRIPLEWHALE_API_KEY not set' } });
    const adName = req.query.ad_name ? String(req.query.ad_name) : null;
    const windowDays = [7, 30, 90].includes(parseInt(req.query.window, 10)) ? parseInt(req.query.window, 10) : 7;
    const endDate = new Date().toISOString().slice(0, 10);
    const startDate = new Date(Date.now() - ((windowDays - 1) * 86400 * 1000)).toISOString().slice(0, 10);

    // TW's documented attribution model values, plus a few common variants
    // we've seen the API accept. We probe each and report which return data.
    const candidates = [
      'lastPlatformClick',
      'lastClick',
      'tw',
      'triple',
      'totalImpact',
      'firstClick',
      'linear',
    ];
    const out = [];
    for (const mode of candidates) {
      try {
        const sql = adName
          ? `SELECT ad_name, SUM(spend) as total_spend, SUM(${_TW_REVENUE_COL}) as total_revenue, SUM(${_TW_PURCHASE_COL}) as total_purchases FROM pixel_joined_tvf WHERE event_date BETWEEN @startDate AND @endDate AND ad_name = '${adName.replace(/'/g, "''")}' GROUP BY ad_name`
          : `SELECT 'aggregate' as ad_name, SUM(spend) as total_spend, SUM(${_TW_REVENUE_COL}) as total_revenue, SUM(${_TW_PURCHASE_COL}) as total_purchases FROM pixel_joined_tvf WHERE event_date BETWEEN @startDate AND @endDate`;
        const rows = await _twQuery(sql, startDate, endDate, mode);
        const r = rows[0] || {};
        out.push({
          attribution_mode: mode,
          ok: true,
          spend: Number(r.total_spend) || 0,
          revenue: Number(r.total_revenue) || 0,
          purchases: Number(r.total_purchases) || 0,
          roas: r.total_spend > 0 ? Number(r.total_revenue) / Number(r.total_spend) : 0,
        });
      } catch (err) {
        out.push({ attribution_mode: mode, ok: false, error: err.message.slice(0, 100) });
      }
    }
    // Also probe DIFFERENT revenue/purchase column candidates with the
    // default attribution mode. attributionModel only affects attributed
    // columns; if the column we're SUM'ing is raw `order_revenue` we'll
    // always get the same number. Find the column that responds.
    const REV_CANDIDATES = [
      'order_revenue',
      'channel_reported_conversion_value',
      'pixel_revenue',
      'tw_revenue',
      'attributed_revenue',
      'tw_attributed_revenue',
      'triple_attributed_revenue',
      'revenue',
      'tw_total_revenue',
    ];
    const PUR_CANDIDATES = [
      'website_purchases',
      'channel_reported_conversions',
      'pixel_purchases',
      'attributed_purchases',
      'tw_attributed_purchases',
      'purchases',
    ];

    const revOut = [];
    for (const col of REV_CANDIDATES) {
      try {
        const sql = adName
          ? `SELECT SUM(${col}) as v FROM pixel_joined_tvf WHERE event_date BETWEEN @startDate AND @endDate AND ad_name = '${adName.replace(/'/g, "''")}'`
          : `SELECT SUM(${col}) as v FROM pixel_joined_tvf WHERE event_date BETWEEN @startDate AND @endDate`;
        // Try with 'tw' attribution mode (operator's UI uses Triple Attribution).
        const rows = await _twQuery(sql, startDate, endDate, 'tw');
        revOut.push({ column: col, value: Number(rows[0]?.v) || 0, ok: true });
      } catch (err) {
        revOut.push({ column: col, ok: false, error: err.message.slice(0, 80) });
      }
    }
    const purOut = [];
    for (const col of PUR_CANDIDATES) {
      try {
        const sql = adName
          ? `SELECT SUM(${col}) as v FROM pixel_joined_tvf WHERE event_date BETWEEN @startDate AND @endDate AND ad_name = '${adName.replace(/'/g, "''")}'`
          : `SELECT SUM(${col}) as v FROM pixel_joined_tvf WHERE event_date BETWEEN @startDate AND @endDate`;
        const rows = await _twQuery(sql, startDate, endDate, 'tw');
        purOut.push({ column: col, value: Number(rows[0]?.v) || 0, ok: true });
      } catch (err) {
        purOut.push({ column: col, ok: false, error: err.message.slice(0, 80) });
      }
    }

    // Channel-filter probe — operator's TW UI is Meta-only ($4,128 spend
    // vs our $9,770 unfiltered ≈ 2.37× ratio). Find the column + value
    // pair that knocks spend down to the Meta-only value.
    const CHANNEL_COLS = ['channel', 'source', 'platform', 'ad_channel'];
    const CHANNEL_VALS = ['meta', 'facebook', 'fb', 'facebook_ads', 'meta_ads', 'instagram'];
    const channelOut = [];
    for (const col of CHANNEL_COLS) {
      for (const val of CHANNEL_VALS) {
        try {
          const sql = `SELECT SUM(spend) as s, SUM(channel_reported_conversion_value) as r, SUM(channel_reported_conversions) as p FROM pixel_joined_tvf WHERE event_date BETWEEN @startDate AND @endDate AND ${col} = '${val}'`;
          const rows = await _twQuery(sql, startDate, endDate, 'tw');
          const r = rows[0] || {};
          if (Number(r.s) > 0) {
            channelOut.push({
              column: col, value: val, ok: true,
              spend: Number(r.s) || 0,
              revenue: Number(r.r) || 0,
              purchases: Number(r.p) || 0,
            });
          }
        } catch {
          // try next
        }
      }
    }

    res.json({
      success: true,
      data: {
        ad_name: adName,
        window_days: windowDays,
        date_range: { startDate, endDate },
        current_default: _TW_ATTRIBUTION_DEFAULT,
        modes: out,
        revenue_columns: revOut,
        purchase_columns: purOut,
        channel_filters: channelOut,
      },
    });
  } catch (err) {
    console.error('[meta-ads/probe-attribution] error:', err);
    res.status(500).json({ success: false, error: { message: err.message } });
  }
});

// POST /meta-ads/refresh — frontend "Refresh" button. Awaits sync so the
// caller gets fresh data, but rate-limited to once per minute.
router.post('/meta-ads/refresh', authenticate, async (_req, res) => {
  try {
    const result = await triggerTWSync({ awaitResult: true });
    res.json({ success: true, data: result });
  } catch (err) {
    console.error('[meta-ads/refresh] error:', err);
    res.status(500).json({ success: false, error: { message: err.message } });
  }
});

// 4. GET /meta-ads/accounts — distinct accounts that have spent on STATIC ads
// in the last 30 days. The creative_analysis schema uses `type` ('image') and
// may or may not carry account fields (depends on the TW sync the analytics
// worktree ships). We fall back to literals so the endpoint never breaks.

// Cache the creative_analysis column set in module scope (5-min TTL). The schema
// is owned by another worktree but barely changes; the previous code hit
// information_schema 3-4× per modal page-load.
const CA_COLS_TTL_MS = 5 * 60 * 1000;
let _caColsCache = null; // { at: number, set: Set<string> }
async function getCreativeAnalysisColumns() {
  if (_caColsCache && (Date.now() - _caColsCache.at) < CA_COLS_TTL_MS) {
    return _caColsCache.set;
  }
  const rows = await pgQuery(
    `SELECT column_name FROM information_schema.columns WHERE table_name = 'creative_analysis'`
  );
  const set = new Set(rows.map(r => r.column_name));
  _caColsCache = { at: Date.now(), set };
  return set;
}

// In-process cache of Meta Graph account name resolutions.
//   key: bare account id (no act_ prefix), value: { name, fetchedAt }
// TTL = 24h; on Render redeploys (which clear the cache), the next
// /meta-ads/accounts call repopulates lazily.
const _metaAccountNameCache = new Map();
const _META_ACCOUNT_NAME_TTL_MS = 24 * 3600 * 1000;

async function resolveMetaAccountNames(rawIds) {
  const token = process.env.META_ACCESS_TOKEN;
  if (!token) return new Map();
  const out = new Map();
  const toFetch = [];
  const now = Date.now();
  for (const raw of rawIds) {
    if (!raw) continue;
    const bare = String(raw).replace(/^act_/, '');
    if (!/^\d+$/.test(bare)) continue;
    const cached = _metaAccountNameCache.get(bare);
    if (cached && (now - cached.fetchedAt) < _META_ACCOUNT_NAME_TTL_MS) {
      out.set(bare, cached.name);
    } else {
      toFetch.push(bare);
    }
  }
  // Parallel fetch with mild concurrency (Meta Graph rate limit is generous
  // for read calls; we expect <10 accounts so a flat Promise.all is fine).
  await Promise.all(toFetch.map(async (bare) => {
    try {
      const url = `https://graph.facebook.com/v22.0/act_${bare}?fields=name&access_token=${encodeURIComponent(token)}`;
      const r = await fetch(url, { signal: AbortSignal.timeout(8000) });
      if (!r.ok) return;
      const j = await r.json();
      const name = j?.name && String(j.name).trim();
      if (name) {
        _metaAccountNameCache.set(bare, { name, fetchedAt: now });
        out.set(bare, name);
      }
    } catch { /* swallow — fallback to ID display */ }
  }));
  return out;
}

router.get('/meta-ads/accounts', authenticate, async (_req, res) => {
  try {
    const cols = await getCreativeAnalysisColumns();
    const idCol  = cols.has('ad_account_id') ? 'ad_account_id' : null;
    const nameCol = cols.has('ad_account_name') ? 'ad_account_name'
                  : cols.has('account_name') ? 'account_name'
                  : null;
    if (!idCol || !nameCol) {
      // Schema doesn't carry account info yet — fire the TW sync (it will run
      // the table-migration step in ensureTable and add the columns), then
      // return one synthetic bucket so the UI still renders a pill.
      triggerTWSync({ awaitResult: false }).catch(() => {});
      const fallback = await pgQuery(`
        SELECT COALESCE(SUM(spend), 0)::FLOAT AS spend_30d
        FROM creative_analysis
        WHERE synced_at >= NOW() - INTERVAL '30 days' AND type = 'image'
      `);
      return res.json({
        success: true,
        data: [{ ad_account_id: 'all', ad_account_name: 'All accounts', spend_30d: fallback[0]?.spend_30d || 0 }],
        note: 'creative_analysis has no account columns — sync triggered',
        synced: 'pending',
      });
    }

    const rows = await pgQuery(`
      SELECT
        ${idCol}   AS ad_account_id,
        ${nameCol} AS ad_account_name,
        SUM(spend)::FLOAT AS spend_30d
      FROM creative_analysis
      WHERE synced_at >= NOW() - INTERVAL '30 days'
        AND type = 'image'
        AND ${idCol} IS NOT NULL
      GROUP BY ${idCol}, ${nameCol}
      ORDER BY spend_30d DESC NULLS LAST
    `);

    // Backfill / freshness auto-trigger:
    // (a) if rows exist but none are tagged with an account, the schema is new
    //     and prior syncs predate the account columns — kick a sync to backfill;
    // (b) otherwise, if the most-recent synced_at is older than 30 min, refresh
    //     in the background so the modal feels live.
    const meta = await pgQuery(`
      SELECT
        COUNT(*) FILTER (WHERE synced_at >= NOW() - INTERVAL '30 days' AND type = 'image') AS image_rows,
        COUNT(${idCol}) FILTER (WHERE synced_at >= NOW() - INTERVAL '30 days' AND type = 'image') AS account_rows,
        MAX(synced_at) AS last_sync
      FROM creative_analysis
    `);
    const m = meta[0] || {};
    const needsBackfill = Number(m.image_rows || 0) > 0 && Number(m.account_rows || 0) === 0;
    const lastSyncMs = m.last_sync ? new Date(m.last_sync).getTime() : 0;
    const isStale = lastSyncMs > 0 && (Date.now() - lastSyncMs) > 30 * 60 * 1000;
    let syncStatus = 'fresh';
    if (needsBackfill || isStale) {
      const t = await triggerTWSync({ awaitResult: false });
      syncStatus = t.triggered ? 'pending' : t.reason || 'skipped';
    }

    // Enrich each row with the friendly Meta BM name. Falls back to the
    // existing ad_account_name (or the raw ID) when Meta Graph is unreachable
    // or the row has no resolvable account_id.
    const rawIds = rows.map(r => r.ad_account_id).filter(Boolean);
    const nameMap = await resolveMetaAccountNames(rawIds);
    for (const r of rows) {
      const bare = String(r.ad_account_id || '').replace(/^act_/, '');
      const resolved = nameMap.get(bare);
      if (resolved) r.ad_account_name = resolved;
    }

    res.json({
      success: true,
      data: rows,
      synced: syncStatus,
      last_sync: m.last_sync || null,
    });
  } catch (err) {
    console.error('[meta-ads/accounts] error:', err);
    res.status(500).json({ success: false, error: { message: err.message } });
  }
});

// 5. GET /meta-ads/ads — aggregated TW image creatives, scoped/sorted/filtered.
// In-process response cache for /meta-ads/ads. The endpoint chains 4-7
// network calls (TW SQL + Postgres + Meta Graph names + Postgres again),
// totaling 1.5-4s warm / 5-50s cold. The operator opens this modal
// repeatedly (every chip toggle re-fires). Cache the assembled response
// for 5 minutes keyed by all the inputs that affect output.
//   value: { body, expiresAt }
// 5-minute TTL matches TW's freshness expectations — anything fresher
// and the operator would just hit Refresh.
const _metaAdsResponseCache = new Map();
const _META_ADS_CACHE_TTL_MS = 5 * 60 * 1000;
function _metaAdsCacheKey(req) {
  const p = req.query;
  // Deterministic key — sort accounts so '?accounts=a,b' and '?accounts=b,a' hit the same entry.
  const acctsSorted = String(p.accounts || '').split(',').map(s => s.trim()).filter(Boolean).sort().join(',');
  return [
    acctsSorted,
    String(p.status || 'active'),
    String(p.window || '30'),
    String(p.sort || 'spend'),
    String(p.min_roas || '0'),
    String(p.min_spend || '0'),
    String(p.type || 'image'),
    String(p.search || ''),
    String(p.hide_unverified || 'false'),
    String(p.source || 'tw'),
    String(p.attribution || ''),
  ].join('|');
}

router.get('/meta-ads/ads', authenticate, async (req, res) => {
  // Cache fast-path — serve from memory if still warm. Operator-driven
  // workflows (chip toggles, modal re-opens) hit this repeatedly within
  // the 5-minute window.
  const cacheKey = _metaAdsCacheKey(req);
  const cached = _metaAdsResponseCache.get(cacheKey);
  if (cached && cached.expiresAt > Date.now()) {
    res.set('X-Cache', 'HIT');
    return res.json(cached.body);
  }
  // Wrap res.json to capture the body for caching before sending.
  const _originalJson = res.json.bind(res);
  res.json = (body) => {
    if (body?.success && Array.isArray(body?.data)) {
      _metaAdsResponseCache.set(cacheKey, {
        body,
        expiresAt: Date.now() + _META_ADS_CACHE_TTL_MS,
      });
      // Cap cache size to prevent unbounded growth.
      if (_metaAdsResponseCache.size > 100) {
        const oldest = _metaAdsResponseCache.keys().next().value;
        _metaAdsResponseCache.delete(oldest);
      }
    }
    res.set('X-Cache', 'MISS');
    return _originalJson(body);
  };
  return _metaAdsHandler(req, res);
});

async function _metaAdsHandler(req, res) {
  try {
    const accountsCsv = req.query.accounts ? String(req.query.accounts) : '';
    const accounts = accountsCsv.split(',').map(a => a.trim()).filter(Boolean);
    const status = String(req.query.status || 'active').toLowerCase();
    const windowRaw = parseInt(req.query.window, 10);
    const window = [7, 30, 90].includes(windowRaw) ? windowRaw : 30;
    const sortKey = ['spend', 'revenue', 'roas', 'cpa'].includes(req.query.sort) ? req.query.sort : 'spend';
    const minRoas = parseFloat(req.query.min_roas) || 0;
    const minSpend = parseFloat(req.query.min_spend) || 0;
    const search = req.query.search ? String(req.query.search).trim() : null;
    // Type filter (was hardcoded to 'image' — operator can now ask for video
    // or carousel winners too). 'all' lifts the filter entirely.
    const typeParam = String(req.query.type || 'image').toLowerCase();
    const ALLOWED_TYPES = ['image', 'video', 'carousel', 'all'];
    const type = ALLOWED_TYPES.includes(typeParam) ? typeParam : 'image';
    // Data source: 'tw' (direct TW query — matches TW UI exactly) | 'cached'
    // (the local creative_analysis aggregate — fast but drifts). Default to
    // 'tw' so numbers match. Falls back to cached on TW failure.
    const source = String(req.query.source || 'tw').toLowerCase();
    const attribution = req.query.attribution ? String(req.query.attribution) : null;

    // ───────────────────────────────────────────────────────────────────
    // TW DIRECT PATH — query TW SQL warehouse, enrich with local metadata.
    // ───────────────────────────────────────────────────────────────────
    if (source === 'tw' && _TW_API_KEY) {
      try {
        // ACTIVE chip → tell TW SQL to drop ads with 0 spend in last 48h
        // (Layer 1 of the status fix — cheap proxy for "currently delivering").
        const twRows = await fetchTopAdsFromTW({
          windowDays: window,
          attributionModel: attribution,
          accountIds: accounts,
          minSpend,
          activeOnly: status === 'active',
        });

        // Enrich each TW row with our local metadata (creative_id, meta_ad_id,
        // thumbnail_url, type, hook_id, angle, week, auto_detected) by joining
        // on ad_name. Most recent synced row per ad_name wins.
        const adNames = twRows.map(r => r.ad_name).filter(Boolean);
        const metaByName = new Map();
        if (adNames.length > 0) {
          const cols = await getCreativeAnalysisColumns();
          const metaRows = await pgQuery(`
            SELECT DISTINCT ON (ad_name)
              ad_name, creative_id, meta_ad_id, thumbnail_url, type,
              ${cols.has('hook_id') ? 'hook_id' : `'' as hook_id`},
              ${cols.has('angle') ? 'angle' : `'' as angle`},
              ${cols.has('week') ? 'week' : `null as week`},
              ${cols.has('auto_detected') ? 'auto_detected' : 'FALSE as auto_detected'},
              ${cols.has('ctr') ? 'ctr' : '0 as ctr'},
              ${cols.has('ad_status') ? 'ad_status' : `null as ad_status`},
              ${cols.has('is_active') ? 'is_active' : `null as is_active`}
            FROM creative_analysis
            WHERE ad_name = ANY($1::text[])
            ORDER BY ad_name, synced_at DESC
          `, [adNames]);
          for (const m of metaRows) metaByName.set(m.ad_name, m);
        }

        // LAYER 2 (fail-closed) — defense-in-depth against the SQL clause's
        // false positives. Mineblock ad-name tokens (IT\\d+, IM\\d+, MR, VX)
        // appear in both static AND video creatives, so the upstream SQL
        // filter alone CANNOT guarantee zero-video-leak. Require an explicit
        // creative_analysis.type='image%' classification.
        //
        // PHASE 1 — three-bucket model (operator-approved scope):
        //   'image'      = creative_analysis.type starts with 'image' → trusted
        //   'video'      = creative_analysis.type starts with 'video' → REJECT
        //   'unverified' = no row OR unknown type → SURFACE WITH BADGE
        //
        // Previous fail-closed model silently hid every unverified ad, which
        // dropped real statics (B0139 IT5/IT3/VX) the operator could see in
        // their own TW UI. New model trusts the operator to verify per-card
        // rather than hiding by default.
        //
        // Only EXPLICIT 'video%' tags get rejected. Everything else flows
        // through, tagged with verification_status so the UI can badge it.
        const hideUnverified = String(req.query.hide_unverified || 'false') === 'true';
        const classified = twRows.map(r => {
          const m = metaByName.get(r.ad_name);
          const t = m?.type ? String(m.type).toLowerCase() : null;
          let verification_status;
          if (t && t.startsWith('image')) verification_status = 'image';
          else if (t && t.startsWith('video')) verification_status = 'video';
          else verification_status = 'unverified';
          return { row: r, verification_status };
        });
        // LAYER 2 STATUS FILTER — when chip = ACTIVE, reject ads whose
        // creative_analysis.ad_status is explicitly 'paused' / 'archived'.
        // Layer 1 (TW SQL 48h-spend HAVING) already dropped most paused
        // ads, but some paused ads still have residual spend in the last
        // 48h (delayed attribution). This catches them.
        //
        // ad_status / is_active classification matches the Phase 1 type
        // pattern: known-good → trust, known-bad → reject, unknown →
        // surface with badge so the operator isn't blind to it.
        function classifyDelivery(m) {
          if (!m) return 'unknown';
          const s = m.ad_status ? String(m.ad_status).toLowerCase() : null;
          const a = m.is_active;
          if (s === 'paused' || s === 'archived' || s === 'inactive') return 'paused';
          if (s === 'active' || a === true) return 'active';
          if (a === false) return 'paused';
          return 'unknown';
        }

        // Hard reject videos always; respect operator's hide_unverified opt-in;
        // for ACTIVE chip, reject anything classified as paused.
        const typed = classified.filter(c => {
          if (c.verification_status === 'video') return false;
          if (c.verification_status === 'unverified' && hideUnverified) return false;
          if (status === 'active') {
            const delivery = classifyDelivery(metaByName.get(c.row.ad_name));
            if (delivery === 'paused') return false;
          }
          return true;
        }).map(c => ({
          ...c.row,
          verification_status: c.verification_status,
          delivery_status: classifyDelivery(metaByName.get(c.row.ad_name)),
        }));
        const rejectedAsVideoCount = classified.filter(c => c.verification_status === 'video').length;
        const unverifiedCount = classified.filter(c => c.verification_status === 'unverified').length;
        const rejectedAsPausedCount = status === 'active'
          ? classified.filter(c => classifyDelivery(metaByName.get(c.row.ad_name)) === 'paused').length
          : 0;

        // Friendly-name enrichment from Meta Graph — same cache the
        // /meta-ads/accounts endpoint feeds, so chips + card subtitles
        // stay consistent. Parallel-fetched once per request.
        const accountNameMap = await resolveMetaAccountNames(
          [...new Set(typed.map(r => r.ad_account_id).filter(Boolean))]
        );

        const data = typed.map(r => {
          const m = metaByName.get(r.ad_name) || {};
          const spend = r.spend, revenue = r.revenue, purchases = r.purchases;
          const roas = spend > 0 ? revenue / spend : 0;
          const cpa = purchases > 0 ? spend / purchases : 0;
          let thumb = m.thumbnail_url || null;
          const looksDead = !thumb || /\.fbcdn\.net|cdninstagram\.com/i.test(thumb);
          if (looksDead && m.creative_id) {
            thumb = `/api/v1/brief-pipeline/meta-thumb/${encodeURIComponent(m.creative_id)}`;
          }
          const bareAcct = String(r.ad_account_id || '').replace(/^act_/, '');
          const friendlyName = accountNameMap.get(bareAcct) || r.account_name || r.ad_account_id || 'Unknown';
          return {
            creative_id: m.creative_id || r.ad_name, // fallback to ad_name as key
            ad_account_id: r.ad_account_id,
            account_name: friendlyName,
            ad_name: r.ad_name,
            thumbnail_url: thumb,
            meta_ad_id: m.meta_ad_id || null,
            angle: m.angle || null,
            hook_id: m.hook_id || null,
            week: m.week || null,
            auto_detected: !!m.auto_detected,
            ctr: spend > 0 ? (r.clicks / Math.max(1, r.impressions)) : 0,
            spend, revenue, purchases,
            impressions: r.impressions,
            clicks: r.clicks,
            roas, cpa,
            days_active: window,
            verification_status: r.verification_status, // 'image' | 'unverified'
            delivery_status: r.delivery_status,         // 'active' | 'paused' | 'unknown'
            spend_48h: r.spend_48h || 0,                // last 48h spend (proxy for delivery)
            already_imported: false, // back-filled below in a single batch
          };
        });

        // Batch-fill already_imported in one query so the map above stays sync.
        const metaAdIds = data.map(d => d.meta_ad_id).filter(Boolean);
        const existing = metaAdIds.length > 0
          ? new Set((await pgQuery(
              `SELECT external_ref_key FROM spy_creatives
                WHERE imported_from='meta' AND external_ref_key = ANY($1::text[])`,
              [metaAdIds]
            )).map(r => r.external_ref_key))
          : new Set();
        for (const d of data) d.already_imported = d.meta_ad_id ? existing.has(d.meta_ad_id) : false;

        // Apply sort + min_roas filter (TW already filtered min_spend via SQL).
        const sorted = data
          .filter(d => d.roas >= minRoas)
          .sort((a, b) => {
            switch (sortKey) {
              case 'revenue': return b.revenue - a.revenue;
              case 'roas':    return b.roas - a.roas;
              case 'cpa':     return (a.cpa || 9e9) - (b.cpa || 9e9);
              default:        return b.spend - a.spend;
            }
          });

        // Search filter on ad_name (post-fetch — TW doesn't need it).
        const searched = search
          ? sorted.filter(d => (d.ad_name || '').toLowerCase().includes(search.toLowerCase()))
          : sorted;

        return res.json({
          success: true,
          data: searched,
          count: searched.length,
          source: 'tw',
          attribution: attribution || _TW_ATTRIBUTION_DEFAULT,
          // Telemetry so the modal can show "X candidates filtered out as
          // video / unclassified — flip the toggle to include them".
          filter_stats: {
            tw_returned: twRows.length,
            rejected_as_video: rejectedAsVideoCount,
            rejected_as_paused: rejectedAsPausedCount,
            unverified_count: unverifiedCount,
            hide_unverified: hideUnverified,
            status_filter: status,
          },
        });
      } catch (err) {
        console.warn(`[meta-ads/ads] TW direct failed (${err.message}) — falling back to cached query`);
        // fall through to cached path
      }
    }

    // ───────────────────────────────────────────────────────────────────
    // CACHED PATH — aggregate from creative_analysis. Used when source=cached
    // or TW direct fails. Numbers can drift from TW.
    // ───────────────────────────────────────────────────────────────────
    const cols = await getCreativeAnalysisColumns();
    const idCol  = cols.has('ad_account_id') ? 'ad_account_id' : null;
    const nameCol = cols.has('ad_account_name') ? 'ad_account_name'
                  : cols.has('account_name') ? 'account_name'
                  : null;
    const hasStatus = cols.has('is_active') || cols.has('ad_status');

    const where = [`ca.synced_at >= NOW() - ($1 || ' days')::INTERVAL`];
    const params = [String(window)];
    if (type !== 'all') where.push(`ca.type = '${type}'`); // already whitelisted

    if (accounts.length > 0 && idCol) {
      params.push(accounts);
      where.push(`ca.${idCol} = ANY($${params.length}::text[])`);
    }
    // Active-only PROXY: ad_status column was never populated by the TW
    // sync (Analytics-lane bug), so "active" used to be a no-op. Require
    // the row to also have been synced in the last 24h — high-confidence
    // proxy that the ad is still pumping.
    if (status === 'active') {
      where.push(`ca.synced_at >= NOW() - INTERVAL '24 hours'`);
      if (hasStatus) {
        if (cols.has('is_active')) where.push(`ca.is_active = TRUE`);
        else where.push(`ca.ad_status = 'active'`);
      }
    } else if (status === 'active+paused' && hasStatus) {
      if (cols.has('is_active')) where.push(`(ca.is_active = TRUE OR ca.ad_status = 'paused')`);
      else where.push(`ca.ad_status IN ('active', 'paused')`);
    } // 'all' → no status filter

    if (search) {
      params.push(`%${search}%`);
      const i = params.length;
      where.push(`(ca.ad_name ILIKE $${i} OR ca.creative_id ILIKE $${i})`);
    }

    const accountIdSelect   = idCol   ? `ca.${idCol}`   : `'unknown'::text`;
    const accountNameSelect = nameCol ? `ca.${nameCol}` : `'Unknown'::text`;

    // Aggregate per creative_id; the latest synced row supplies the metadata.
    const sql = `
      WITH agg AS (
        SELECT
          ca.creative_id,
          SUM(ca.spend)::FLOAT       AS spend,
          SUM(ca.revenue)::FLOAT     AS revenue,
          SUM(ca.purchases)::FLOAT   AS purchases,
          SUM(ca.impressions)::BIGINT AS impressions,
          SUM(ca.clicks)::BIGINT      AS clicks,
          MAX(ca.synced_at)          AS latest_synced_at,
          MIN(ca.synced_at)          AS first_synced_at
        FROM creative_analysis ca
        WHERE ${where.join(' AND ')}
        GROUP BY ca.creative_id
      ),
      latest AS (
        SELECT DISTINCT ON (ca.creative_id)
          ca.creative_id, ca.ad_name, ca.thumbnail_url, ca.meta_ad_id, ca.angle, ca.hook_id, ca.week, ca.ctr,
          ${cols.has('auto_detected') ? 'ca.auto_detected' : 'FALSE'} AS auto_detected,
          ${accountIdSelect}   AS ad_account_id,
          ${accountNameSelect} AS account_name
        FROM creative_analysis ca
        WHERE ${where.join(' AND ')}
        ORDER BY ca.creative_id, ca.spend DESC NULLS LAST, ca.synced_at DESC
      )
      SELECT
        agg.creative_id,
        latest.ad_account_id,
        latest.account_name,
        latest.ad_name,
        latest.thumbnail_url,
        latest.meta_ad_id,
        latest.angle,
        latest.hook_id,
        latest.week,
        latest.auto_detected,
        latest.ctr::FLOAT AS ctr,
        agg.spend, agg.revenue, agg.purchases, agg.impressions, agg.clicks,
        agg.latest_synced_at,
        agg.first_synced_at,
        (CASE WHEN agg.spend > 0 THEN agg.revenue / agg.spend ELSE 0 END)::FLOAT AS roas,
        (CASE WHEN agg.purchases > 0 THEN agg.spend / agg.purchases ELSE 0 END)::FLOAT AS cpa,
        GREATEST(0, EXTRACT(DAY FROM (NOW() - agg.first_synced_at))::INTEGER) AS days_active,
        EXISTS (
          SELECT 1 FROM spy_creatives sc
          WHERE sc.imported_from = 'meta'
            AND sc.external_ref_key = latest.meta_ad_id
        ) AS already_imported
      FROM agg
      JOIN latest USING (creative_id)
      WHERE agg.spend >= $${params.length + 1}
        AND (CASE WHEN agg.spend > 0 THEN agg.revenue / agg.spend ELSE 0 END) >= $${params.length + 2}
      ORDER BY
        CASE $${params.length + 3}
          WHEN 'spend'   THEN agg.spend
          WHEN 'revenue' THEN agg.revenue
          WHEN 'roas'    THEN (CASE WHEN agg.spend > 0 THEN agg.revenue / agg.spend ELSE 0 END)
          WHEN 'cpa'     THEN -1.0 * (CASE WHEN agg.purchases > 0 THEN agg.spend / agg.purchases ELSE 999999 END)
        END DESC NULLS LAST
      LIMIT 500
    `;
    params.push(minSpend, minRoas, sortKey);
    const rawRows = await pgQuery(sql, params);

    // Post-process: replace NULL or expiring-fbcdn thumbnail URLs with our
    // permanent /meta-thumb/<creative_id> proxy (R2-cached, no expiry).
    // The proxy handles both image + video creative types after today's
    // briefPipeline.js fix lifted its type='video' restriction.
    const rows = rawRows.map(r => {
      const t = r.thumbnail_url;
      const looksDead = !t || (typeof t === 'string' && /\.fbcdn\.net|cdninstagram\.com/i.test(t));
      if (looksDead && r.creative_id) {
        r.thumbnail_url = `/api/v1/brief-pipeline/meta-thumb/${encodeURIComponent(r.creative_id)}`;
      }
      return r;
    });

    res.json({ success: true, data: rows, count: rows.length });
  } catch (err) {
    console.error('[meta-ads/ads] error:', err);
    res.status(500).json({ success: false, error: { message: err.message } });
  }
}

// GET /meta-ads/last-sync — honest freshness indicator (MAX synced_at).
// Drives the "Last sync: 2h ago" badge in the import modal. Red threshold
// at 6h tells the operator the TW data may be stale.
router.get('/meta-ads/last-sync', authenticate, async (req, res) => {
  try {
    const accountsCsv = req.query.accounts ? String(req.query.accounts) : '';
    const accounts = accountsCsv.split(',').map(a => a.trim()).filter(Boolean);
    const cols = await getCreativeAnalysisColumns();
    const idCol = cols.has('ad_account_id') ? 'ad_account_id' : null;

    const where = [];
    const params = [];
    if (accounts.length > 0 && idCol) {
      params.push(accounts);
      where.push(`${idCol} = ANY($${params.length}::text[])`);
    }
    const sql = `
      SELECT MAX(synced_at) AS last_sync_at,
             COUNT(*)::INTEGER AS row_count
        FROM creative_analysis
        ${where.length > 0 ? 'WHERE ' + where.join(' AND ') : ''}
    `;
    const rows = await pgQuery(sql, params);
    const lastSync = rows[0]?.last_sync_at || null;
    const ageMinutes = lastSync ? Math.floor((Date.now() - new Date(lastSync).getTime()) / 60000) : null;
    res.json({
      success: true,
      data: {
        last_sync_at: lastSync,
        age_minutes: ageMinutes,
        row_count: rows[0]?.row_count ?? 0,
        is_stale: ageMinutes !== null && ageMinutes > 360, // > 6h
      },
    });
  } catch (err) {
    console.error('[meta-ads/last-sync] error:', err);
    res.status(500).json({ success: false, error: { message: err.message } });
  }
});

// POST /meta-ads/repair-thumbnails — bulk backfill for null/expired thumbnails.
// Pattern mirrors the spy_creatives /repair-thumbnails: scan rows where
// thumbnail_url IS NULL OR matches *.fbcdn.net, batch-call Meta Graph by
// meta_ad_id, mirror to R2, write back the permanent URL.
//
// Auth: JWT or CRON_SECRET. The route is registered at the public-routes
// section near the top of this file (hoisted above the global authenticate).
async function _doMetaAdsRepairThumbnails(req, res) {
  try {
    const META_ACCESS_TOKEN = process.env.META_ACCESS_TOKEN || '';
    const META_GRAPH_URL = 'https://graph.facebook.com/v21.0';
    if (!META_ACCESS_TOKEN) {
      return res.status(503).json({ success: false, error: { message: 'META_ACCESS_TOKEN not set' } });
    }

    // Pull candidates: rows with no usable thumbnail OR an fbcdn URL that's
    // about to expire. Restrict to rows with a meta_ad_id (required to call
    // Meta Graph). Limit per call to keep within Graph quota.
    const limit = Math.max(1, Math.min(500, parseInt(req.body?.limit, 10) || 200));
    const candidates = await pgQuery(`
      SELECT DISTINCT ON (creative_id) creative_id, meta_ad_id, ad_account_id
        FROM creative_analysis
       WHERE meta_ad_id IS NOT NULL AND meta_ad_id <> ''
         AND (thumbnail_url IS NULL
              OR thumbnail_url = ''
              OR thumbnail_url ILIKE '%fbcdn.net%'
              OR thumbnail_url ILIKE '%cdninstagram.com%')
       ORDER BY creative_id, synced_at DESC
       LIMIT $1
    `, [limit]);

    if (candidates.length === 0) {
      return res.json({ success: true, data: { scanned: 0, repaired: 0, skipped: 0, errors: [] } });
    }

    let repaired = 0, skipped = 0;
    const errors = [];

    // Batch Meta Graph calls by ad_account_id to use the /adimages bulk endpoint.
    // For now: per-ad fetch via /<ad_id>?fields=creative{thumbnail_url,image_url}
    // (sequential with small concurrency to stay polite).
    const CONCURRENCY = 4;
    let cursor = 0;
    async function processOne(row) {
      try {
        const url = `${META_GRAPH_URL}/${row.meta_ad_id}?fields=creative{thumbnail_url,image_url}&access_token=${META_ACCESS_TOKEN}`;
        const r = await fetch(url, { signal: AbortSignal.timeout(15000) });
        if (!r.ok) {
          skipped++;
          if (errors.length < 5) errors.push(`Meta ${r.status} for ${row.meta_ad_id}`);
          return;
        }
        const data = await r.json();
        const newThumb = data?.creative?.thumbnail_url || data?.creative?.image_url || null;
        if (!newThumb) { skipped++; return; }

        await pgQuery(
          `UPDATE creative_analysis
             SET thumbnail_url = $1
           WHERE creative_id = $2`,
          [newThumb, row.creative_id]
        );
        repaired++;
      } catch (err) {
        skipped++;
        if (errors.length < 5) errors.push(`${row.meta_ad_id}: ${err.message}`);
      }
    }
    async function worker() {
      while (true) {
        const i = cursor++;
        if (i >= candidates.length) return;
        await processOne(candidates[i]);
      }
    }
    await Promise.all(Array.from({ length: CONCURRENCY }, () => worker()));

    console.log(`[meta-ads/repair-thumbnails] scanned=${candidates.length} repaired=${repaired} skipped=${skipped}`);
    res.json({
      success: true,
      data: { scanned: candidates.length, repaired, skipped, errors: errors.length > 0 ? errors : undefined },
    });
  } catch (err) {
    console.error('[meta-ads/repair-thumbnails] error:', err);
    res.status(500).json({ success: false, error: { message: err.message } });
  }
}

// 6. POST /meta-ads/import — push selected TW creatives into the Reference column.
router.post('/meta-ads/import', authenticate, async (req, res) => {
  try {
    await ensureCreativesTable();
    const { creative_ids } = req.body || {};
    if (!Array.isArray(creative_ids) || creative_ids.length === 0) {
      return res.status(400).json({ success: false, error: { message: 'creative_ids[] is required' } });
    }

    const cols = await getCreativeAnalysisColumns();
    const idCol  = cols.has('ad_account_id') ? 'ad_account_id' : null;
    const nameCol = cols.has('ad_account_name') ? 'ad_account_name'
                  : cols.has('account_name') ? 'account_name'
                  : null;
    const accountIdSelect   = idCol   ? `ca.${idCol}`   : `'unknown'::text`;
    const accountNameSelect = nameCol ? `ca.${nameCol}` : `'Unknown'::text`;

    // Batched lookup (audit N+1 fix): one SELECT picks the highest-spend row
    // per creative_id via DISTINCT ON instead of N round-trips.
    const allRows = await pgQuery(`
      SELECT DISTINCT ON (ca.creative_id)
        ca.creative_id, ca.ad_name, ca.thumbnail_url, ca.meta_ad_id,
        ca.angle, ca.hook_id, ca.week,
        ca.spend::FLOAT AS spend, ca.revenue::FLOAT AS revenue,
        ca.roas::FLOAT AS roas, ca.cpa::FLOAT AS cpa, ca.ctr::FLOAT AS ctr,
        ca.impressions::BIGINT AS impressions, ca.synced_at,
        ${accountIdSelect}   AS ad_account_id,
        ${accountNameSelect} AS account_name
      FROM creative_analysis ca
      WHERE ca.creative_id = ANY($1::text[])
        AND ca.type = 'image'
        AND ca.thumbnail_url IS NOT NULL
      ORDER BY ca.creative_id, ca.spend DESC NULLS LAST
    `, [creative_ids.map(String)]);

    // Batched dedup lookup against spy_creatives (relies on the
    // (imported_from, external_ref_key) index from migration 051).
    const candidateKeys = allRows
      .map(r => String(r.meta_ad_id || r.creative_id))
      .filter(Boolean);
    const existingRows = candidateKeys.length > 0
      ? await pgQuery(
          `SELECT external_ref_key FROM spy_creatives
            WHERE imported_from = 'meta' AND external_ref_key = ANY($1::text[])`,
          [candidateKeys]
        )
      : [];
    const alreadyImported = new Set(existingRows.map(x => x.external_ref_key));

    // Build bulk-INSERT arrays.
    const ins = {
      imageUrl: [], sourceLabel: [], referenceName: [],
      angle: [], metaJson: [], externalRefKey: [],
    };
    let skipped = 0;
    const seenInBatch = new Set();
    for (const cid of creative_ids) {
      const r = allRows.find(x => x.creative_id === cid);
      if (!r) { skipped++; continue; }
      const extKey = String(r.meta_ad_id || r.creative_id);
      if (alreadyImported.has(extKey) || seenInBatch.has(extKey)) {
        skipped++;
        continue;
      }
      seenInBatch.add(extKey);
      const sourceLabel = `${r.account_name || 'TW'} / ${r.ad_name || r.creative_id}`;
      const meta = {
        ad_account_id: r.ad_account_id, account_name: r.account_name,
        meta_ad_id: r.meta_ad_id, spend: r.spend, revenue: r.revenue,
        roas: r.roas, cpa: r.cpa, ctr: r.ctr, impressions: r.impressions,
        week: r.week, angle: r.angle, hook_id: r.hook_id, synced_at: r.synced_at,
      };
      ins.imageUrl.push(r.thumbnail_url);
      ins.sourceLabel.push(sourceLabel);
      ins.referenceName.push(r.creative_id);
      ins.angle.push(r.angle || null);
      ins.metaJson.push(JSON.stringify(meta));
      ins.externalRefKey.push(extKey);
    }

    let imported = 0;
    if (ins.imageUrl.length > 0) {
      const insertedRows = await pgQuery(`
        INSERT INTO spy_creatives
          (pipeline, status, is_reference, imported_from, external_ref_key,
           image_url, thumbnail_url, source_label, reference_name,
           reference_thumbnail, angle, imported_metadata, aspect_ratio)
        SELECT 'standard', 'ready', TRUE, 'meta',
               t.external_ref_key,
               t.image_url, t.image_url, t.source_label, t.reference_name,
               t.image_url, t.angle, t.meta_json::jsonb, '4:5'
          FROM unnest(
            $1::text[], $2::text[], $3::text[], $4::text[], $5::text[], $6::text[]
          ) AS t(image_url, source_label, reference_name, angle, meta_json, external_ref_key)
        RETURNING id
      `, [ins.imageUrl, ins.sourceLabel, ins.referenceName, ins.angle, ins.metaJson, ins.externalRefKey]);
      imported = insertedRows.length;
    }

    res.json({
      success: true,
      data: { imported, skipped, skipped_reason: skipped ? 'already_imported' : null },
    });
  } catch (err) {
    console.error('[meta-ads/import] error:', err);
    res.status(500).json({ success: false, error: { message: err.message } });
  }
});

// 7. GET /reference-ads — list reference creatives (optionally per product).
// Cursor-paginated (audit found silent LIMIT 500 cap).
//   ?product_id=X    optional product scope
//   ?cursor=ISO8601  optional created_at cursor for next page (descending)
// Returns: { data, has_more, next_cursor }
const REFERENCE_PAGE_SIZE = 100;
router.get('/reference-ads', authenticate, async (req, res) => {
  try {
    await ensureCreativesTable();
    // PIPELINE-V2 RULE (re-affirmed): Reference column is for OUR OWN
    // winning ads only — Meta-imported, manual uploads, legacy/null
    // sources. League-imported ads live in the dedicated FROM LEAGUE
    // column and must NOT cross over here.
    const productId = req.query.product_id || null;
    const cursor = req.query.cursor || null;
    const where = [
      'is_reference = TRUE',
      `(imported_from IS NULL OR imported_from <> 'league')`,
    ];
    const params = [];
    if (productId) {
      params.push(productId);
      where.push(`(product_id = $${params.length} OR product_id IS NULL)`);
    }
    if (cursor) {
      params.push(cursor);
      where.push(`created_at < $${params.length}`);
    }
    // Fetch one extra row so we can set has_more without a COUNT.
    const rows = await pgQuery(`
      SELECT id, product_id, image_url, thumbnail_url, source_label, reference_name,
             reference_thumbnail, angle, aspect_ratio, status, pipeline,
             imported_from, imported_metadata, created_at
      FROM spy_creatives
      WHERE ${where.join(' AND ')}
      ORDER BY created_at DESC
      LIMIT ${REFERENCE_PAGE_SIZE + 1}
    `, params);
    const hasMore = rows.length > REFERENCE_PAGE_SIZE;
    const page = hasMore ? rows.slice(0, REFERENCE_PAGE_SIZE) : rows;
    const nextCursor = hasMore ? page[page.length - 1].created_at : null;
    res.json({
      success: true,
      data: page,
      count: page.length,
      has_more: hasMore,
      next_cursor: nextCursor,
    });
  } catch (err) {
    console.error('[reference-ads] GET error:', err);
    res.status(500).json({ success: false, error: { message: err.message } });
  }
});

// 8. DELETE /reference-ads/:id — remove a single reference row.
router.delete('/reference-ads/:id', authenticate, async (req, res) => {
  try {
    await ensureCreativesTable();
    // UUID validation guard — silently 404 instead of throwing a 500 on bad input.
    if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(req.params.id)) {
      return res.status(404).json({ success: false, error: { message: 'Reference not found' } });
    }
    const rows = await pgQuery(
      `DELETE FROM spy_creatives WHERE id = $1 AND is_reference = TRUE RETURNING id`,
      [req.params.id]
    );
    if (rows.length === 0) {
      return res.status(404).json({ success: false, error: { message: 'Reference not found' } });
    }
    res.json({ success: true, data: { id: rows[0].id } });
  } catch (err) {
    console.error('[reference-ads] DELETE error:', err);
    res.status(500).json({ success: false, error: { message: err.message } });
  }
});

// 9. POST /reference-ads/upload — upload an image file from disk as a reference.
// Body: { image_data_uri: 'data:image/...;base64,...', label?: string, angle?: string }
router.post('/reference-ads/upload', authenticate, async (req, res) => {
  try {
    await ensureCreativesTable();
    const { image_data_uri: dataUri, label, angle } = req.body || {};
    if (!dataUri || typeof dataUri !== 'string' || !dataUri.startsWith('data:image/')) {
      return res.status(400).json({ success: false, error: { message: 'image_data_uri (data:image/...;base64,...) is required' } });
    }
    // Use the same helper /generate uses to convert data URIs into fetchable HTTPS URLs.
    const httpUrl = await ensureHttpUrlGlobal(dataUri, 'reference-upload');
    if (!httpUrl || !httpUrl.startsWith('http')) {
      throw new Error(`Upload produced non-fetchable URL: ${(httpUrl || '').slice(0,40)}`);
    }
    const finalLabel = (label || 'Custom upload').slice(0, 200);
    const rows = await pgQuery(
      `INSERT INTO spy_creatives
         (pipeline, status, is_reference, imported_from, imported_metadata, image_url,
          thumbnail_url, source_label, reference_name, reference_thumbnail, angle, aspect_ratio)
       VALUES ('standard', 'ready', TRUE, 'upload', $1::jsonb, $2, $2, $3, $3, $2, $4, '4:5')
       RETURNING id, image_url, source_label, imported_from, created_at`,
      [
        JSON.stringify({ label: finalLabel, uploaded_at: new Date().toISOString() }),
        httpUrl,
        finalLabel,
        angle || null,
      ]
    );
    res.json({ success: true, data: rows[0] });
  } catch (err) {
    console.error('[reference-ads] UPLOAD error:', err);
    res.status(500).json({ success: false, error: { message: err.message } });
  }
});

export { getCustomStaticsPrompts, getDefaultStaticsPrompts };

export default router;
