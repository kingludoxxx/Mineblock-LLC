import { Router } from 'express';
import { authenticate } from '../middleware/auth.js';
import { requirePermission } from '../middleware/rbac.js';
import { pgQuery } from '../db/pg.js';
import { transcribeVideoUrl } from '../services/videoTranscribe.js';
// Temp imports for PestLab E2E test endpoints — removed after verification
import { getEditors, OWNER_ID } from '../utils/clickupEditors.js';
import crypto from 'crypto';
import { execFile } from 'child_process';
import { promisify } from 'util';
const execFileAsync = promisify(execFile);
import { existsSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';
import {
  resolveAdAccountNames, getPages, getPixels, getCampaigns, getAdSets,
  getCustomAudiences, createAdSet, createFlexibleAdCreative, createAd,
  uploadAdImage, uploadAdVideo, uploadAdImageFromUrl, isMetaAdsConfigured, getAllAdAccountIds
} from '../services/metaAdsApi.js';
import { uploadBuffer, isR2Configured } from '../services/r2.js';
import { extractFreshVideoUrl, adLibraryUrl } from '../services/freshVideoUrl.js';
import { getAdDetail } from '../db/brandSpyDb.js';
import { extractVideoUrlFromAdLibrary, warmupBrowser as warmupFbExtractor } from '../services/fbAdLibraryExtractor.js';

// Warm up the Chromium browser pool at boot so the first import doesn't
// pay the ~5s cold-start cost. Fires once, never throws — the extractor
// retries on each call if warmup fails.
setTimeout(() => warmupFbExtractor(), 10000);

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const YTDLP_PATH = join(__dirname, '..', '..', '..', 'bin', 'yt-dlp');

const router = Router();

// ── Static-ad reference detection (runtime guardrail) ───────────────────
// Mirrors staticAdExclusionClause() but at the brief_pipeline_references
// row level. Used as a hard runtime check in iterate/clone routes so even
// if a static-creative reference somehow slips into the references table
// ── Bulk-import transcribe semaphore (C3) ─────────────────────────────
// Caps concurrent background transcribe IIFEs across ALL /references/import-meta
// calls. Without this, selecting 50 ads in the modal fires 50 simultaneous
// resolveOwnedVideoFromMeta calls (each 2-12 Meta fetches) plus 50 Playwright
// tabs — guaranteed Meta IP rate-limit + Chromium OOM on the Render dyno.
// 3 is empirically a good balance: Meta tolerates parallel reads from
// different ad_ids, Vertex transcribe is the actual bottleneck downstream.
const TRANSCRIBE_CONCURRENCY = Number(process.env.TRANSCRIBE_CONCURRENCY || '3');
let _transcribeInflight = 0;
const _transcribeWaiters = [];
async function acquireTranscribeSlot() {
  if (_transcribeInflight < TRANSCRIBE_CONCURRENCY) {
    _transcribeInflight += 1;
    return;
  }
  await new Promise((resolve) => _transcribeWaiters.push(resolve));
  _transcribeInflight += 1;
}
function releaseTranscribeSlot() {
  _transcribeInflight = Math.max(0, _transcribeInflight - 1);
  const next = _transcribeWaiters.shift();
  if (next) next();
}

// ── Error-message sanitizer (H3) ──────────────────────────────────────
// Strips Meta access_token + bearer tokens before persisting error text
// to `brief_pipeline_references.analysis_error` or returning to clients.
// Meta error messages occasionally echo URL params; fetch failure messages
// can include the full request URL on DNS errors.
function sanitizeMetaError(msg) {
  if (!msg) return msg;
  let s = String(msg);
  s = s.replace(/access_token=[^&\s"'#]+/gi, 'access_token=REDACTED');
  s = s.replace(/Bearer\s+[A-Za-z0-9_-]+/g, 'Bearer REDACTED');
  s = s.replace(/EAA[A-Za-z0-9_-]{30,}/g, 'EAA_REDACTED');
  return s;
}

// (legacy data, race condition, manual UPLOAD), it can't be iterated.
function isStaticAdReference(ref) {
  if (!ref) return false;
  const name = String(ref.headline || ref.brand_name || '').toUpperCase();
  if (!name) return false;
  // Mineblock format-slot convention: " IMG ", "-IMG-", "- IMG -"
  if (/(^|\s|-)IMG(\s|-|$)/.test(name)) return true;
  if (name.includes('1080X1080') || name.includes('1080×1080')) return true;
  return false;
}

// ── Brand mismatch guardrail ─────────────────────────────────────────────
// When Vertex multimodal returns brand_or_product_identified that doesn't
// match the brand implied by the reference's headline / product code, we
// write a warning to imported_metadata.brand_mismatch_warning. Iterate /
// clone routes then refuse to process the reference until the operator
// acknowledges the warning by passing acknowledgeBrandMismatch:true.
//
// This stops the entire class of bug where TripleWhale maps a Mineblock
// internal ID (B0248) to a Meta ad_id that actually resolves to someone
// else's video (JD Sports / LILCR Italian rap, etc.) — Vertex catches
// the brand, we block the bad iteration before it produces useless output.
const MINEBLOCK_BRAND_TOKENS = /(mineblock|minerforge|miner forge|bitcoin miner|btc miner)/i;
const MINEBLOCK_HEADLINE_TOKENS = /^MR\s*-|mineblock|minerforge|miner\s*forge/i;

function detectBrandMismatch(headline, multimodalAnalysis) {
  if (!multimodalAnalysis || typeof multimodalAnalysis !== 'object') return null;
  const brand = String(multimodalAnalysis.brand_or_product_identified || '').trim();
  if (!brand || brand.toLowerCase() === 'unclear') return null;

  const looksMineblock = MINEBLOCK_HEADLINE_TOKENS.test(String(headline || ''));
  if (!looksMineblock) return null; // only check OUR ads

  if (MINEBLOCK_BRAND_TOKENS.test(brand)) return null; // match

  // Mismatch: headline says Mineblock, but Vertex identified a different brand.
  return {
    warning: 'BRAND_MISMATCH',
    expected: 'Mineblock / MinerForge Pro',
    actual: brand,
    selling_message: String(multimodalAnalysis.selling_message || '').slice(0, 200),
    message: `Video appears to be from "${brand}" but headline claims Mineblock. The video file at this Meta ad_archive_id likely belongs to a different brand. Re-import or delete this reference before iterating.`,
  };
}

// ── Meta thumbnail proxy with R2 caching ──────────────────────────────
// Placed BEFORE the global authenticate middleware because <img src> tags
// can't carry JWTs. Safe to expose: thumbnails are non-sensitive, R2
// public URLs are already world-readable, creative_ids are opaque enough
// to discourage scraping.
//
// Flow:
//   1. Compute deterministic R2 key: meta-thumbs/<creative_id>.jpg
//   2. HEAD the R2 URL — if 200, 302 redirect, done.
//   3. Cache miss: look up the freshest thumbnail_url from creative_analysis
//      for this creative_id, fetch the bytes, upload to R2 with the
//      deterministic key, then 302 redirect to the new R2 URL.
//   4. Source fetch fails (URL expired): respond 410 Gone so the frontend
//      ThumbCell can swap to its "Preview expired" placeholder.
//
// Net: every video thumbnail gets a PERMANENT URL after first view.
// Browser caches the redirect, R2 caches the bytes. "Preview expired"
// only renders if the source was already dead before we ever cached it.
// In-memory rate limiter for the public proxy — keyed by remote IP. Prevents
// drive-by R2-cost amplification. 60 unique creative_ids per IP per minute
// (more than enough for a real user opening the modal + scrolling).
const _thumbRateLimit = new Map(); // ip → { count, resetAt }
const THUMB_LIMIT_PER_MIN = 60;
function checkThumbRate(ip) {
  const now = Date.now();
  const rec = _thumbRateLimit.get(ip);
  if (!rec || rec.resetAt < now) {
    _thumbRateLimit.set(ip, { count: 1, resetAt: now + 60_000 });
    return true;
  }
  rec.count += 1;
  return rec.count <= THUMB_LIMIT_PER_MIN;
}

router.get('/meta-thumb/:creativeId', async (req, res) => {
  try {
    const ip = req.headers['x-forwarded-for']?.split(',')[0]?.trim() || req.ip || 'unknown';
    if (!checkThumbRate(ip)) {
      res.setHeader('Cache-Control', 'public, max-age=60');
      return res.status(429).send('Too many thumbnail requests');
    }
    const creativeId = String(req.params.creativeId || '').replace(/[^a-zA-Z0-9_-]/g, '');
    if (!creativeId) {
      res.setHeader('Cache-Control', 'public, max-age=86400, immutable');
      return res.status(400).send('Invalid creative_id');
    }
    if (!isR2Configured() || !process.env.R2_PUBLIC_URL) {
      res.setHeader('Cache-Control', 'public, max-age=300');
      return res.status(503).send('R2 not configured');
    }
    const key = `meta-thumbs/${creativeId}.jpg`;
    const r2Url = `${process.env.R2_PUBLIC_URL}/${key}`;

    // Cache hit: serve directly from R2
    try {
      const head = await fetch(r2Url, { method: 'HEAD', signal: AbortSignal.timeout(4000) });
      if (head.ok) {
        res.setHeader('Cache-Control', 'public, max-age=86400');
        return res.redirect(302, r2Url);
      }
    } catch { /* fall through to cache miss path */ }

    // Cache miss: fetch source URL from creative_analysis and upload to R2.
    // Type filter intentionally NOT applied — the proxy now serves both video
    // first-frame thumbs AND image-creative thumbnails (the Meta Import modal
    // for statics calls it for image rows whose stored URL has expired).
    const rows = await pgQuery(
      `SELECT thumbnail_url FROM creative_analysis
        WHERE creative_id = $1 AND thumbnail_url IS NOT NULL
        ORDER BY synced_at DESC LIMIT 1`,
      [creativeId]
    );
    const sourceUrl = rows[0]?.thumbnail_url;
    if (!sourceUrl) {
      res.setHeader('Cache-Control', 'public, max-age=3600');
      return res.status(404).send('No thumbnail in database');
    }

    try {
      const src = await fetch(sourceUrl, { signal: AbortSignal.timeout(10000) });
      if (!src.ok) {
        console.warn(`[meta-thumb] source fetch ${src.status} for ${creativeId}`);
        res.setHeader('Cache-Control', 'public, max-age=3600');
        return res.status(410).send('Source thumbnail expired');
      }
      const buffer = Buffer.from(await src.arrayBuffer());
      const contentType = src.headers.get('content-type') || 'image/jpeg';
      await uploadBuffer(buffer, key, contentType);
      res.setHeader('Cache-Control', 'public, max-age=86400');
      return res.redirect(302, r2Url);
    } catch (e) {
      console.warn(`[meta-thumb] source fetch error for ${creativeId}:`, e.message);
      res.setHeader('Cache-Control', 'public, max-age=3600');
      return res.status(410).send('Source thumbnail expired');
    }
  } catch (err) {
    console.error('[meta-thumb] handler error:', err.message);
    res.status(500).send('Internal error');
  }
});

// ── Public diagnostic (BEFORE the router-wide authenticate guard) ────
// Length + first 8 chars of sha256 only — real secret never crosses the wire.
router.get('/generated/_env-check', (_req, res) => {
  const val = process.env.DEDUPE_SECRET || '';
  const hash = val
    ? require('crypto').createHash('sha256').update(val).digest('hex').slice(0, 8)
    : null;
  res.json({
    dedupeSecretLen: val.length,
    dedupeSecretHashPrefix: hash,
    nodeEnv: process.env.NODE_ENV || null,
    pid: process.pid,
    uptimeSec: Math.round(process.uptime()),
  });
});

// ── POST /generated/dedupe-recent (BEFORE the authenticate guard) ────
// Bypasses login when a matching DEDUPE_SECRET is presented; otherwise
// still falls through to authenticate() for a normal admin session. See
// full docstring on the handler below.
const DEDUPE_SECRET = process.env.DEDUPE_SECRET || '';
console.log(`[BriefPipeline] boot: DEDUPE_SECRET ${DEDUPE_SECRET ? `SET (${DEDUPE_SECRET.length} chars)` : 'NOT SET'}`);
function dedupeAuthOrAuthenticate(req, res, next) {
  const supplied = req.get('x-dedupe-secret') || req.query.secret || '';
  const suppliedLen = supplied ? String(supplied).length : 0;
  const secretLen   = DEDUPE_SECRET ? DEDUPE_SECRET.length : 0;
  const matched     = !!(DEDUPE_SECRET && supplied && supplied === DEDUPE_SECRET);
  console.log(`[BriefPipeline] dedupe auth: secretLen=${secretLen} suppliedLen=${suppliedLen} matched=${matched}`);
  if (matched) {
    req.user = req.user || { id: null, email: 'dedupe-bot', roles: [] };
    return next();
  }
  return authenticate(req, res, next);
}
router.post('/generated/dedupe-recent', dedupeAuthOrAuthenticate, async (req, res) => {
  try {
    await ensureTables();
    const dryRun = String(req.query.dryRun ?? 'true').toLowerCase() !== 'false';
    const hours  = Math.min(240, Math.max(1, parseInt(String(req.query.hours ?? '48'), 10) || 48));
    const status = String(req.query.status ?? 'generated');

    // Group recent generated briefs by reference_id (their shared source ad
    // — importLeagueAdAsReference upserts on ad_archive_id, so even
    // duplicate runs point at the same reference row). Keep the oldest per
    // group; the rest are duplicates.
    const rows = await pgQuery(
      `SELECT bg.id                AS brief_id,
              bg.brief_number,
              bg.status,
              bg.naming_convention,
              bg.created_at,
              bw.id                AS winner_id,
              bw.reference_id
         FROM brief_pipeline_generated bg
         JOIN brief_pipeline_winners  bw ON bw.id = bg.winner_id
        WHERE bw.reference_id IS NOT NULL
          AND bg.created_at > NOW() - ($1::int || ' hours')::interval
          AND ($2::text = 'ANY' OR bg.status = $2)
        ORDER BY bw.reference_id, bg.created_at ASC`,
      [hours, status],
    );

    const groups = new Map(); // reference_id → { keep, duplicates: [] }
    for (const r of rows) {
      const g = groups.get(r.reference_id);
      if (!g) groups.set(r.reference_id, { keep: r, duplicates: [] });
      else    g.duplicates.push(r);
    }

    const plan = [];
    let totalToDelete = 0;
    for (const [referenceId, g] of groups.entries()) {
      if (g.duplicates.length === 0) continue;
      plan.push({
        referenceId,
        keep: {
          briefId: g.keep.brief_id, briefNumber: g.keep.brief_number,
          namingConvention: g.keep.naming_convention, createdAt: g.keep.created_at,
        },
        delete: g.duplicates.map((d) => ({
          briefId: d.brief_id, briefNumber: d.brief_number,
          namingConvention: d.naming_convention, createdAt: d.created_at,
        })),
      });
      totalToDelete += g.duplicates.length;
    }

    if (dryRun || totalToDelete === 0) {
      return res.json({
        success: true, executed: false, window: { hours, status },
        duplicateGroups: plan.length, totalToDelete, plan,
      });
    }

    const idsToDelete = plan.flatMap((g) => g.delete.map((d) => d.briefId));
    const deleted = await pgQuery(
      `DELETE FROM brief_pipeline_generated
        WHERE id = ANY($1::uuid[])
        RETURNING id`,
      [idsToDelete],
    );
    console.log(`[BriefPipeline] dedupe-recent: deleted ${deleted.length} duplicate brief(s) across ${plan.length} group(s)`);

    return res.json({
      success: true, executed: true, window: { hours, status },
      duplicateGroups: plan.length, totalDeleted: deleted.length, plan,
    });
  } catch (err) {
    console.error('[BriefPipeline] POST /generated/dedupe-recent error:', err.message);
    res.status(500).json({ success: false, error: { message: err.message } });
  }
});

// ── POST /generated/restore-signature-hooks (maintenance) ────────────
// One-shot batch: for every CLONED, not-yet-pushed generated brief, rewrite
// H1 into the competitor source's signature hook, readapted to our product,
// in place — same brief number, same body, H2-H5 untouched. Fixes briefs
// generated BEFORE the signature-hook rule shipped. Shares the DEDUPE_SECRET
// bypass (x-dedupe-secret header or ?secret=) so it can run headless, and
// defaults to dryRun=true: it returns the proposed old->new H1 for every
// brief WITHOUT saving. Re-run with ?dryRun=false to persist.
//
// Scope guards (deliberate): winner_id required (manual briefs have no source
// to mirror → skipped); clickup_task_id must be null by default (a pushed
// brief's live copy is its ClickUp card, so a DB-only hook change would never
// reach the editor → skipped unless ?includePushed=true).
router.post('/generated/restore-signature-hooks', dedupeAuthOrAuthenticate, async (req, res) => {
  try {
    await ensureTables();
    const dryRun = String(req.query.dryRun ?? 'true').toLowerCase() !== 'false';
    const statusFilter = String(req.query.status ?? 'generated'); // 'ANY' = all non-rejected
    const limit = Math.min(200, Math.max(1, parseInt(String(req.query.limit ?? '100'), 10) || 100));
    const includePushed = String(req.query.includePushed ?? 'false').toLowerCase() === 'true';

    const rows = await pgQuery(
      `SELECT g.id, g.brief_number, g.naming_convention, g.status, g.product_code,
              g.body, g.hooks, g.clickup_task_id, g.winner_id,
              w.parsed_script, w.raw_script
         FROM brief_pipeline_generated g
         JOIN brief_pipeline_winners w ON w.id = g.winner_id
        WHERE g.status != 'rejected'
          AND ($1::text = 'ANY' OR g.status = $1)
          AND ($2::boolean OR g.clickup_task_id IS NULL)
        ORDER BY g.created_at ASC
        LIMIT $3`,
      [statusFilter, includePushed, limit],
    );

    const changed = [];
    const skipped = [];

    for (const b of rows) {
      const currentHooks = parseJsonb(b.hooks);
      if (!Array.isArray(currentHooks) || currentHooks.length === 0) {
        skipped.push({ briefNumber: b.brief_number, reason: 'no hooks on brief' });
        continue;
      }
      const parsed = parseJsonb(b.parsed_script) || {};
      const srcHooks = Array.isArray(parsed.hooks)
        ? parsed.hooks.map((h, i) => `${(h && h.id) || 'H' + (i + 1)}: ${(h && h.text) || h}`).join('\n')
        : '';
      const srcBodyOpen = typeof parsed.body === 'string' ? parsed.body.slice(0, 320) : '';
      const srcOverlays = extractOnScreenText(b.raw_script) || '';
      if (!srcHooks && !srcBodyOpen && !srcOverlays) {
        skipped.push({ briefNumber: b.brief_number, reason: 'source has no parseable hook/body/overlay' });
        continue;
      }

      let productContextStr = '';
      try {
        const profile = await fetchProductProfile(b.product_code || 'MR');
        if (profile) productContextStr = buildProductContextForBrief(profile);
      } catch { /* best-effort — proceed without product context */ }

      const oldH1 = currentHooks[0]?.text || '';
      const sys = `You are a direct-response copywriter. You rewrite ONE hook (H1) so it mirrors a proven competitor ad's signature hook, readapted to our product. You never use dashes or hyphens. Return only JSON.`;
      const usr = `ORIGINAL COMPETITOR AD (the proven winner this brief was cloned from):
--- Source hooks ---
${srcHooks || '(none parsed)'}
--- Source body opening ---
${srcBodyOpen || '(none)'}
--- Source on-screen overlays ---
${srcOverlays || '(none detected)'}

${productContextStr ? `OUR PRODUCT CONTEXT:\n${productContextStr}\n\n` : ''}OUR BRIEF BODY (do NOT change it — the new H1 must blend into its first line):
${b.body || '(no body)'}

OUR CURRENT H1: ${oldH1}

TASK: Find the competitor source's single strongest scroll stopper (from the source hooks, the source body opening, or an ALL CAPS overlay). Rewrite THAT hook for OUR product in spoken sentence case form: product noun and category swapped, its contrarian / curiosity / myth bust shape kept otherwise. This becomes our new H1. It must blend seamlessly into our body's first line with no bridge line. Under 20 words. No dashes or hyphens.

Return ONLY JSON: { "new_h1": "the readapted hook", "mechanism": "short label", "source_basis": "which source line you readapted" }`;

      let result;
      try {
        result = await callClaude(sys, usr, 800);
      } catch (e) {
        skipped.push({ briefNumber: b.brief_number, reason: `AI error: ${e.message}` });
        continue;
      }
      const newH1 = result && typeof result.new_h1 === 'string' ? removeDashes(result.new_h1.trim()) : '';
      if (!newH1) {
        skipped.push({ briefNumber: b.brief_number, reason: 'AI returned no hook' });
        continue;
      }

      const newHooks = currentHooks.map((h, i) =>
        i === 0 ? { ...h, text: newH1, mechanism: result.mechanism || h.mechanism } : h);

      if (!dryRun) {
        await pgQuery(
          `UPDATE brief_pipeline_generated SET hooks = $1 WHERE id = $2`,
          [JSON.stringify(newHooks), b.id],
        );
      }
      changed.push({
        briefNumber: b.brief_number,
        naming: b.naming_convention,
        oldH1,
        newH1,
        sourceBasis: result.source_basis || null,
      });
    }

    console.log(`[BriefPipeline] restore-signature-hooks: dryRun=${dryRun} scanned=${rows.length} changed=${changed.length} skipped=${skipped.length}`);
    return res.json({
      success: true,
      dryRun,
      scope: { status: statusFilter, includePushed, limit },
      scanned: rows.length,
      changedCount: changed.length,
      skippedCount: skipped.length,
      changed,
      skipped,
    });
  } catch (err) {
    console.error('[BriefPipeline] POST /generated/restore-signature-hooks error:', err.message);
    res.status(500).json({ success: false, error: { message: err.message } });
  }
});

router.use(authenticate, requirePermission('brief-pipeline', 'access'));

// ── Config ────────────────────────────────────────────────────────────
const CLICKUP_TOKEN = process.env.CLICKUP_API_TOKEN || '';
const VIDEO_ADS_LIST = '901518716584';           // MB | Video Ads (MinerForge etc.)
const PUURE_VIDEO_LIST = '901524484514';          // PL | Video Creatives (Puure)
const MEDIA_BUYING_LIST = '901518769621';

// ── ClickUp pipeline routing ──────────────────────────────────────────
// Each product-family pushes to its own ClickUp list. Fields differ PER
// LIST (ClickUp custom fields are list-scoped), so pushBriefToClickUp
// resolves field + dropdown-option ids dynamically by NAME via
// resolveListConfig(listId) instead of a single hardcoded FIELD_IDS map.
const CLICKUP_PIPELINES = {
  MB: { listId: VIDEO_ADS_LIST,   initialStatus: 'edit queue', namingCode: null },   // default
  PL: { listId: PUURE_VIDEO_LIST, initialStatus: 'copy queue', namingCode: 'PL', fbPage: 'Puure' }, // Puure
};

// Product → pipeline. Puure (code PUURE / naming PL) routes to PL | Video
// Creatives; everything else stays on MB | Video Ads.
function pipelineForProduct(productCode) {
  const c = String(productCode || '').toUpperCase();
  if (c === 'PUURE' || c === 'PL') return CLICKUP_PIPELINES.PL;
  return CLICKUP_PIPELINES.MB;
}

// The code that leads the naming convention. Puure briefs read PUURE as the
// DB product_code (master-brief context lookups depend on it) but must be
// NAMED with the brand's short code 'PL'.
function namingProductCode(productCode) {
  const pl = pipelineForProduct(productCode);
  return pl.namingCode || productCode || 'MR';
}
const CLICKUP_API = 'https://api.clickup.com/api/v2';
const META_ACCESS_TOKEN = process.env.META_ACCESS_TOKEN || '';
const META_AD_ACCOUNT_IDS = (process.env.META_AD_ACCOUNT_IDS || '').split(',').filter(Boolean);


// ── Trusted-account allowlist for the Brief Pipeline import flow ────────
// META_AD_ACCOUNT_IDS env var lists Mineblock's own Meta ad accounts. We
// MUST refuse to surface or import ads from any other account, because
// TripleWhale's creative_analysis table can contain cross-account rows
// (different brands sharing the same internal creative_id, NULL account
// metadata, etc.) — letting those through is how an Italian rap / ALDI /
// train-trip video gets imported as "MR - B0xxx - Mineblock".
//
// Normalize: accept both bare numeric ids and the "act_<digits>" form
// because TW sometimes stores one, Meta's Graph API the other.
const TRUSTED_ACCOUNT_IDS_NORM = new Set(
  META_AD_ACCOUNT_IDS.flatMap((raw) => {
    const bare = String(raw || '').trim().replace(/^act_/i, '');
    return bare ? [bare, `act_${bare}`] : [];
  })
);
function isTrustedAccount(accountId) {
  // Prefer the boot-audit-verified set. Strips accounts owned by businesses
  // other than META_BUSINESS_ID (VIP BM partner accounts whose content is
  // unverified Mineblock). Falls back to env-based set during cold-start
  // or when no Meta token is configured for audit.
  const effective = _verifiedTrustedSet.size > 0
    ? _verifiedTrustedSet
    : TRUSTED_ACCOUNT_IDS_NORM;
  if (effective.size === 0) return true; // unset = allow all (legacy)
  const id = String(accountId || '').trim();
  if (!id) return false;
  const bare = id.replace(/^act_/i, '');
  return effective.has(id) || effective.has(bare) || effective.has(`act_${bare}`);
}
function trustedAccountSqlClause(colExpr, paramIndexStart, params) {
  // Prefer the boot-audit-verified set when populated. Falls back to the
  // env-based set (TRUSTED_ACCOUNT_IDS_NORM) only when the boot audit hasn't
  // populated anything yet (cold start) or was skipped (no META_ACCESS_TOKEN).
  // The verified set strips accounts owned by businesses other than
  // META_BUSINESS_ID — e.g. VIP BM partner accounts whose content is foreign.
  const effective = _verifiedTrustedSet.size > 0
    ? _verifiedTrustedSet
    : TRUSTED_ACCOUNT_IDS_NORM;
  if (effective.size === 0) return null;
  const list = Array.from(effective);
  params.push(list);
  return `${colExpr} = ANY($${paramIndexStart}::text[])`;
}

// ── Boot-time Meta env audit ───────────────────────────────────────────
// Confirms every account_id in META_AD_ACCOUNT_IDS actually belongs to
// Mineblock's Business Manager. Runs once at boot, persists result to
// meta_account_audit. Subsequent runtime checks consult that table; any
// account that failed audit is STRIPPED from TRUSTED_ACCOUNT_IDS_NORM
// at runtime (env stays untouched — we just refuse to trust it).
//
// Required env: META_BUSINESS_IDS (comma-separated list of trusted Mineblock
// Business Manager IDs). Accepts the legacy single META_BUSINESS_ID env too.
// An account passes audit if its business.id matches ANY id in this list.
// Example: META_BUSINESS_IDS=1757150421916101,863338510147306,1037077445556729
const MINEBLOCK_BUSINESS_IDS = new Set(
  (process.env.META_BUSINESS_IDS || process.env.META_BUSINESS_ID || '')
    .split(',')
    .map(s => s.trim())
    .filter(Boolean)
);
// Backwards-compat: keep MINEBLOCK_BUSINESS_ID as the first id (for telemetry).
const MINEBLOCK_BUSINESS_ID = MINEBLOCK_BUSINESS_IDS.size > 0
  ? Array.from(MINEBLOCK_BUSINESS_IDS)[0]
  : '';
const _verifiedTrustedSet = new Set(); // populated after boot audit completes
let _bootAuditComplete = false;

async function performBootMetaAudit() {
  if (META_AD_ACCOUNT_IDS.length === 0) {
    console.warn('[BriefPipeline] Boot audit skipped: META_AD_ACCOUNT_IDS empty');
    _bootAuditComplete = true;
    return;
  }
  if (!META_ACCESS_TOKEN) {
    console.warn('[BriefPipeline] Boot audit skipped: META_ACCESS_TOKEN unset — trusting env values unverified');
    for (const id of TRUSTED_ACCOUNT_IDS_NORM) _verifiedTrustedSet.add(id);
    _bootAuditComplete = true;
    return;
  }
  let okCount = 0;
  let rejectedCount = 0;
  for (const rawId of META_AD_ACCOUNT_IDS) {
    const bare = String(rawId).trim().replace(/^act_/i, '');
    const accountIdAct = `act_${bare}`;
    try {
      const url = `${META_GRAPH_URL}/${accountIdAct}?fields=name,business,account_status&access_token=${META_ACCESS_TOKEN}`;
      const resp = await fetch(url, { signal: AbortSignal.timeout(10000) });
      const data = await resp.json();
      if (!resp.ok || data.error) {
        const errMsg = `Meta /${accountIdAct} returned ${resp.status}: ${(data.error?.message || resp.statusText || '').slice(0, 200)}`;
        await pgQuery(
          `INSERT INTO meta_account_audit (account_id, is_trusted, verification_error, verified_at)
           VALUES ($1, FALSE, $2, NOW())
           ON CONFLICT (account_id) DO UPDATE
             SET is_trusted = FALSE, verification_error = EXCLUDED.verification_error, verified_at = NOW()`,
          [accountIdAct, errMsg]
        ).catch(() => {});
        console.warn(`[BriefPipeline] Boot audit FAILED for ${accountIdAct}: ${errMsg}`);
        rejectedCount++;
        continue;
      }
      const businessId = data.business?.id ? String(data.business.id) : null;
      const businessName = data.business?.name || null;
      const ownedByMineblock = MINEBLOCK_BUSINESS_IDS.size > 0
        ? (businessId && MINEBLOCK_BUSINESS_IDS.has(String(businessId)))
        : true; // no expected BMs set — accept reachability as sufficient
      await pgQuery(
        `INSERT INTO meta_account_audit (account_id, business_id, business_name, account_name, account_status, is_trusted, verified_at, verification_error)
         VALUES ($1, $2, $3, $4, $5, $6, NOW(), $7)
         ON CONFLICT (account_id) DO UPDATE
           SET business_id = EXCLUDED.business_id,
               business_name = EXCLUDED.business_name,
               account_name = EXCLUDED.account_name,
               account_status = EXCLUDED.account_status,
               is_trusted = EXCLUDED.is_trusted,
               verified_at = NOW(),
               verification_error = EXCLUDED.verification_error`,
        [
          accountIdAct, businessId, businessName, data.name || null,
          Number.isFinite(Number(data.account_status)) ? Number(data.account_status) : null,
          ownedByMineblock,
          ownedByMineblock ? null : `Business id mismatch: got "${businessId}" (${businessName}), expected one of [${Array.from(MINEBLOCK_BUSINESS_IDS).join(', ')}]`,
        ]
      ).catch((e) => console.warn('[BriefPipeline] meta_account_audit upsert failed:', e.message));
      if (ownedByMineblock) {
        _verifiedTrustedSet.add(accountIdAct);
        _verifiedTrustedSet.add(bare);
        okCount++;
        console.log(`[BriefPipeline] Boot audit OK: ${accountIdAct} (${data.name || 'unnamed'}, business=${businessName || 'none'})`);
      } else {
        rejectedCount++;
        console.warn(`[BriefPipeline] Boot audit REJECTED ${accountIdAct}: business "${businessName}" (${businessId}) is not in trusted BMs [${Array.from(MINEBLOCK_BUSINESS_IDS).join(', ')}]`);
      }
    } catch (e) {
      rejectedCount++;
      console.warn(`[BriefPipeline] Boot audit error for ${accountIdAct}:`, e.message);
    }
  }
  console.log(`[BriefPipeline] Boot audit done: ${okCount}/${META_AD_ACCOUNT_IDS.length} accounts trusted, ${rejectedCount} rejected`);
  _bootAuditComplete = true;
}

// Synchronous "is this account verified-trusted" — returns false if the
// boot audit hasn't finished yet (caller must handle), or if audit rejected
// the account. Use isTrustedAccount() (env-based, optimistic) for SQL
// pre-filters, and this stricter check for write-time verification.
function isVerifiedTrustedAccount(accountId) {
  if (!_bootAuditComplete) return null; // boot in progress — caller must defer
  if (!accountId) return false;
  const id = String(accountId).trim();
  const bare = id.replace(/^act_/i, '');
  return _verifiedTrustedSet.has(id) || _verifiedTrustedSet.has(bare) || _verifiedTrustedSet.has(`act_${bare}`);
}

// Fire boot audit a few seconds after server start. Non-blocking — server
// can serve requests while audit runs. The transcribe paths use the env
// allowlist (TRUSTED_ACCOUNT_IDS_NORM) up front and the per-ad Meta API
// resolveOwnedVideoFromMeta as the authoritative ownership check, so
// audit-pending state never lets bad content through.
setTimeout(() => {
  performBootMetaAudit().catch((e) => {
    console.error('[BriefPipeline] Boot audit unhandled error:', e.message);
    _bootAuditComplete = true; // unblock isVerifiedTrustedAccount waiters
  });
}, 5000);

// ── Static-ad exclusion ──────────────────────────────────────────────────
// TripleWhale's `type='video'` classification is unreliable — static image
// creatives (jpg/png banners with on-screen text) sometimes get tagged as
// 'video'. We exclude them here with two layered checks:
//   1. Mineblock naming convention: format slot "IMG" means static. Excludes
//      "MR-Bxxxx-…-IMG-…", "MR - Bxxxx - … - IMG - …", and the
//      "1080x1080"/"1080×1080" square-dimensions tail commonly attached to
//      image creatives.
//   2. Creative link points at an image file (jpg/jpeg/png/gif/webp/svg).
//
// Returns a SQL fragment that can be concatenated into a WHERE list.
// `tablePrefix` is the alias used for creative_analysis (e.g. 'ca' or '').
function staticAdExclusionClause(tablePrefix = 'ca') {
  const p = tablePrefix ? `${tablePrefix}.` : '';
  return `
    (${p}ad_name IS NULL OR (
      ${p}ad_name !~* '(^|\\s|-)IMG(\\s|-|$)'
      AND ${p}ad_name NOT ILIKE '%1080x1080%'
      AND ${p}ad_name NOT ILIKE '%1080×1080%'
    ))
    AND (${p}creative_link IS NULL OR ${p}creative_link !~* '\\.(jpg|jpeg|png|gif|webp|svg)([?#]|$)')
  `.trim();
}
const META_GRAPH_URL = 'https://graph.facebook.com/v21.0';

// ── Direct video resolver from Mineblock-owned Meta ad ──────────────────
// Given a Meta ad_id that we believe belongs to one of OUR ad accounts,
// pull the actual video file straight from Meta Marketing API. This is the
// canonical, authoritative path:
//
//   1. GET /{ad_id}?fields=name,account_id,creative{video_id,thumbnail_url}
//      → confirms which account owns this ad and which video_id is attached
//   2. Verify account_id ∈ META_AD_ACCOUNT_IDS (else: REFUSE — this ad does
//      not belong to Mineblock, regardless of what our DB row claimed)
//   3. GET /{video_id}?fields=source — direct CDN URL to the video file
//   4. Fallback: /{account_id}/advideos?filtering=[{id EQUAL video_id}]
//      &fields=source — needed because some Marketing API tokens reject
//      direct /{video_id} access.
//
// Returns one of:
//   { videoUrl: <url>, accountId, videoId, adName, thumbnailUrl }
//   { foreignAccount: true, accountId, adName }  — ad belongs to a non-Mineblock account
//   { error: <reason> }                          — Meta API failure, no answer
//   null                                         — input invalid / no token / etc.
//
// This bypasses Playwright/FB Ad Library entirely: when the ad is ours,
// Meta hands us the canonical video. No DOM scraping, no risk of grabbing
// a "related ads" video off the FB Ad Library page.
async function resolveOwnedVideoFromMeta(metaAdId) {
  if (!metaAdId || !META_ACCESS_TOKEN) return null;
  const adId = String(metaAdId).trim();
  if (!adId) return null;

  // Step 1 — confirm ownership + get video_id
  let adMeta;
  try {
    // Pull BOTH possible video_id locations:
    //  - creative.video_id            ← the outer ad-level video id
    //  - creative.object_story_spec.video_data.video_id  ← the REAL underlying
    //    video file (when the ad was created from a page post). Confirmed via
    //    live probe: for B0112 the outer id is 1486111699652922 but the actual
    //    file lives at 814979381492094 inside object_story_spec.video_data.
    const fieldsExpr = 'name,account_id,effective_status,creative{video_id,thumbnail_url,object_story_spec{video_data{video_id,title,message}}}';
    const url = `${META_GRAPH_URL}/${adId}?fields=${encodeURIComponent(fieldsExpr)}&access_token=${META_ACCESS_TOKEN}`;
    const resp = await fetch(url, { signal: AbortSignal.timeout(10000) });
    const data = await resp.json();
    if (!resp.ok || data.error) {
      return { error: sanitizeMetaError(`Meta /${adId} returned ${resp.status}: ${(data.error?.message || resp.statusText || '').slice(0, 160)}`) };
    }
    adMeta = data;
  } catch (e) {
    return { error: sanitizeMetaError(`Meta /${adId} fetch failed: ${e.message?.slice(0, 160)}`) };
  }

  // Step 2 — account ownership verification
  const accountId = adMeta.account_id ? String(adMeta.account_id) : null;
  const accountIdAct = accountId ? (accountId.startsWith('act_') ? accountId : `act_${accountId}`) : null;
  if (!accountId || !isTrustedAccount(accountIdAct)) {
    return {
      foreignAccount: true,
      accountId: accountIdAct,
      adName: adMeta.name || null,
      thumbnailUrl: adMeta.creative?.thumbnail_url || null,
    };
  }

  // Collect ALL candidate video_ids — try the underlying object_story_spec
  // one first (it's the actual file), then the outer creative.video_id.
  const candidateVideoIds = [];
  const innerVid = adMeta.creative?.object_story_spec?.video_data?.video_id;
  if (innerVid) candidateVideoIds.push(String(innerVid));
  const outerVid = adMeta.creative?.video_id;
  if (outerVid && !candidateVideoIds.includes(String(outerVid))) candidateVideoIds.push(String(outerVid));

  if (candidateVideoIds.length === 0) {
    return {
      error: `Ad ${adId} has no video_id in creative OR object_story_spec.video_data (likely an image/carousel ad).`,
      accountId: accountIdAct,
      adName: adMeta.name || null,
      thumbnailUrl: adMeta.creative?.thumbnail_url || null,
    };
  }

  // Step 3 — resolve video CDN URL. Try each candidate via direct /{video_id}
  // FIRST, then fall through to the paginated /{account}/advideos search.
  for (const vid of candidateVideoIds) {
    try {
      const vurl = `${META_GRAPH_URL}/${vid}?fields=source,permalink_url&access_token=${META_ACCESS_TOKEN}`;
      const vresp = await fetch(vurl, { signal: AbortSignal.timeout(10000) });
      const vdata = await vresp.json();
      if (vresp.ok && !vdata.error && vdata.source) {
        return {
          videoUrl: vdata.source,
          accountId: accountIdAct,
          videoId: vid,
          adName: adMeta.name || null,
          thumbnailUrl: adMeta.creative?.thumbnail_url || null,
          _via: vid === innerVid ? 'video_direct_inner' : 'video_direct_outer',
        };
      }
    } catch (_) { /* try next candidate */ }
  }

  // Keep `videoId` referring to the inner one for the legacy advideos search
  // below (it's the one that's most likely to be in the ad account's video
  // library — outer ids are sometimes shared across multiple ads).
  const videoId = candidateVideoIds[0];

  // Step 4 — fallback: /{account_id}/advideos. Some Marketing API tokens
  // reject direct /{video_id} but accept the account-scoped advideos endpoint.
  //
  // IMPORTANT — Meta does NOT support filtering=[{field:'id',operator:'EQUAL'}]
  // on the advideos endpoint (returns "(#100) Filtering field 'id' with
  // operation 'equal' is not supported"). We previously had that filter and
  // silently failed on every owned ad. Instead we paginate through the
  // account's advideos (newest first) and match locally by id.
  //
  // Most ads are recent — finding the video usually takes 1 page. We cap at
  // 10 pages × 100 = 1000 videos before giving up.
  try {
    const targetIds = new Set(candidateVideoIds.map(String));
    let cursor = null;
    const MAX_PAGES = 10;
    for (let page = 0; page < MAX_PAGES; page++) {
      const params = new URLSearchParams({
        fields: 'id,source',
        limit: '100',
        access_token: META_ACCESS_TOKEN,
      });
      if (cursor) params.set('after', cursor);
      const aurl = `${META_GRAPH_URL}/${accountIdAct}/advideos?${params.toString()}`;
      const aresp = await fetch(aurl, { signal: AbortSignal.timeout(15000) });
      const adata = await aresp.json();
      if (!aresp.ok || adata.error) break;
      const list = Array.isArray(adata.data) ? adata.data : [];
      const match = list.find((v) => targetIds.has(String(v.id)));
      if (match?.source) {
        return {
          videoUrl: match.source,
          accountId: accountIdAct,
          videoId: match.id,
          adName: adMeta.name || null,
          thumbnailUrl: adMeta.creative?.thumbnail_url || null,
          _via: `advideos_paginated_page${page + 1}`,
        };
      }
      cursor = adata.paging?.cursors?.after || null;
      if (!cursor || list.length < 100) break;
    }
    return { error: sanitizeMetaError(`Meta video_ids=[${candidateVideoIds.join(',')}] not found via direct OR ${accountIdAct} advideos (searched up to ${MAX_PAGES} pages).`), accountId: accountIdAct, adName: adMeta.name || null };
  } catch (e) {
    return { error: sanitizeMetaError(`Meta advideos fetch failed for video_ids=[${candidateVideoIds.join(',')}]: ${e.message?.slice(0, 160)}`), accountId: accountIdAct };
  }
}

const ANTHROPIC_API_KEY = process.env.ANTHROPIC_API_KEY || '';
const CLAUDE_API_URL = 'https://api.anthropic.com/v1/messages';
const CLAUDE_MODEL = 'claude-sonnet-4-6';

// Helper to safely parse JSONB values that may be double-encoded as strings
function parseJsonb(val) {
  if (typeof val === 'string') { try { return JSON.parse(val); } catch { return val; } }
  return val;
}

// Validate a generated brief has the required structure
function validateGeneratedBrief(generated) {
  const errors = [];
  if (!generated || typeof generated !== 'object') {
    return { valid: false, errors: ['Generated brief is null or not an object'] };
  }
  if (!generated.body || typeof generated.body !== 'string' || !generated.body.trim()) {
    errors.push('body must be a non-empty string');
  }
  if (!Array.isArray(generated.hooks)) {
    errors.push('hooks must be an array');
  } else {
    for (let i = 0; i < generated.hooks.length; i++) {
      const h = generated.hooks[i];
      if (!h || typeof h.text !== 'string') {
        errors.push(`hooks[${i}] missing required "text" string property`);
      }
    }
  }
  return { valid: errors.length === 0, errors };
}

// Validate score values are numbers 0-10
function validateScores(scores) {
  if (!scores || typeof scores !== 'object') return false;
  const keys = ['novelty', 'aggression', 'coherence', 'hook_body_blend', 'conversion_potential'];
  for (const key of keys) {
    const val = scores[key]?.score;
    if (val !== undefined && (typeof val !== 'number' || val < 0 || val > 10)) {
      return false;
    }
  }
  return true;
}

const headers = {
  Authorization: CLICKUP_TOKEN,
  'Content-Type': 'application/json',
};

// ── ClickUp Field IDs ─────────────────────────────────────────────────
const FIELD_IDS = {
  briefNumber: '62b61cc4-2d35-4dfc-86f4-a3913e2bbca3',
  briefType: '98d04d2d-9575-4363-8eee-9bf150b1c319',
  parentBriefId: '4f72235e-0a41-4824-9e67-d27e38ba16d9',
  idea: '0c5460ee-2645-4892-815d-7913fb5d241d',
  angle: '7e740c52-a05b-4b3b-9798-0801acd84b8a',
  creativeType: 'b7f50dff-c752-47a7-830d-c3780021a27f',
  editor: 'a9613cd9-715a-4a2a-bbbb-fbb7f664980a',
  creationWeek: 'a609d8d0-661e-400f-87cb-2557bd48857b',
  creativeStrategist: '372d59af-e573-4eb4-be9f-31cb02f3ad5b',
  copywriter: '3a55a5ef-6ed7-4cd3-b8ad-10ad2eeec472',
  product: '7bc3b414-363e-421e-9445-473b4b8ccf18',
  avatar: '4ad59f88-89cc-45e5-bc56-0027a4ab8624',
  creator: 'be5a2a58-f355-4fac-8263-2824725eaa64',
  namingConvention: 'c97d93bc-ad82-4b90-98e0-092df383d9b8',
  adsFrameLink: 'd90f9f25-d7a0-4eb4-9ded-aca0b4519a3b',
};

// ── Dropdown Option IDs ───────────────────────────────────────────────
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
  Miningwhilesleep: '8bfcbdeb-c21b-4d78-b2f4-fa45f7856b18',
  Apology: '3c59aca9-f26b-4d8d-95b9-652fd4d30044',
};

// Map free-text angle labels (as stored on brief rows or returned by the
// analyzer) to ClickUp ANGLE_OPTIONS dropdown keys. The brief pipeline
// analyzer emits display-friendly strings like "Anti-Fake / Competitor
// Callout" that must be collapsed onto the canonical dropdown key
// ("Againstcompetition") before we can resolve the UUID. Comparison is
// case-insensitive and ignores non-alphanumerics so minor punctuation drift
// doesn't break the match.
const ANGLE_ALIAS_MAP = {
  'promo': 'Promo',
  'antifakecompetitorcallout': 'Againstcompetition',
  'antifake': 'Againstcompetition',
  'competitorcallout': 'Againstcompetition',
  'againstcompetition': 'Againstcompetition',
  'competition': 'Againstcompetition',
  'lottery': 'Lottery',
  'btcmadeeasy': 'BTC Made easy',
  'bitcoinmadeeasy': 'BTC Made easy',
  'gtrs': 'GTRS',
  'livestream': 'livestream',
  'hiddenopportunity': 'Hiddenopportunity',
  'rebranding': 'Rebranding',
  'missedopportunity': 'Missedopportunity',
  'btcfarm': 'BTCFARM',
  'bitcoinfarm': 'BTCFARM',
  'sale': 'Sale',
  'scarcity': 'Scarcity',
  'breakingnews': 'Breakingnews',
  'offer': 'Offer',
  'reaction': 'Reaction',
  'miningwhilesleep': 'Miningwhilesleep',
  'miningwhileyousleep': 'Miningwhilesleep',
  'apology': 'Apology',
  'na': 'NA',
};

function normalizeAngleKey(angle) {
  if (!angle) return 'NA';
  // Exact match wins first (cheap and avoids over-collapsing)
  if (ANGLE_OPTIONS[angle]) return angle;
  const slug = String(angle).toLowerCase().replace(/[^a-z0-9]/g, '');
  if (ANGLE_ALIAS_MAP[slug]) return ANGLE_ALIAS_MAP[slug];
  // Last resort: try matching against the canonical keys themselves
  // collapsed the same way.
  for (const key of Object.keys(ANGLE_OPTIONS)) {
    const keySlug = key.toLowerCase().replace(/[^a-z0-9]/g, '');
    if (keySlug === slug) return key;
  }
  return 'NA';
}

const BRIEF_TYPE_OPTIONS = {
  NN: '1e274045-a4b3-4b0d-85c2-d7ec1a347d3c',
  IT: 'e0999d3c-faab-4d4e-8336-a6272dab8393',
};

const CREATIVE_TYPE_OPTIONS = {
  Mashup: 'a72f1eeb-b245-4a4a-8982-271b52f2650f',
  ShortVid: '02526d2e-ff4f-43db-a586-daf937f6ba86',
  UGC: '95b8cafc-8b15-4a22-be53-7e7398d49d6f',
  VSL: 'ba975681-cebb-416c-8b1f-0880a9cd9e56',
  'Mini VSL': 'e5efc26b-a8bc-4306-9ede-cec47d37ce32',
  'Long VSL': '3cdf6abf-a162-4e81-b32c-e30ae3c7d4ba',
  Cartoon: '3edf3ba9-2518-4699-808d-364ed6831383',
};

const CREATIVE_TYPE_CODES = {
  Mashup: 'HX',
  ShortVid: 'VX',
  UGC: 'UX',
  VSL: 'VL',
  'Mini VSL': 'MV',
  'Long VSL': 'LV',
  Cartoon: 'CT',
};

// ── Relationship Task IDs ─────────────────────────────────────────────
const PRODUCT_TASK_IDS = {
  MR: '86c75fure',
  TX: '86c7jxxtj',
  PL: '86car5ggu',
  PUURE: '86car9c09',
};

const AVATAR_TASK_IDS = {
  Cryptoaddict: '86c7hf58v',
  MoneySeeker: '86c7m5417',
  'Test Avatar': '86c75fyjh',
  Aware: '86c8jhvfk',
  Menopause: '86car9c0r',
  'Menopause Margaret': '86car9c0r',   // legacy alias — old briefs still resolve to the renamed task
  'Post-Baby Paige': '86car9c1f',
  'Pre-Op Interceptor': '86car9c1x',
  'Product Aware': '86carcn0z',        // bottom-of-funnel offer/promo ads
  NA: null,
};

const CREATOR_NA_TASK_ID = '86c7n9cvr';

// Dynamic relationship resolution — the static maps above are a fast path,
// but every new product/avatar used to require a code change (Puure briefs
// silently landed with Product=MR because 'PUURE' wasn't in the map). When
// a name isn't in the static map we search the ClickUp relationship list by
// normalized name and, for products/avatars, create the task if missing.
const REL_LISTS = {
  product: '901518716744',  // Products
  avatar:  '901518784383',  // Avatars
  creator: '901518769701',  // Creators Database
};
const relTaskCache = { data: {}, ts: 0 };
const relSlug = (s) => String(s || '').toLowerCase().replace(/[^a-z0-9]/g, '');

async function resolveRelationshipTask(kind, name, { createIfMissing = false } = {}) {
  if (!name || name === 'NA') return null;
  const listId = REL_LISTS[kind];
  if (!listId) return null;
  const slug = relSlug(name);
  if (!slug) return null;

  const now = Date.now();
  if (now - relTaskCache.ts > 10 * 60 * 1000) { relTaskCache.data = {}; relTaskCache.ts = now; }
  if (!relTaskCache.data[kind]) {
    const resp = await clickupFetch(`/list/${listId}/task?include_closed=true`);
    relTaskCache.data[kind] = (resp.tasks || []).map(t => ({ id: t.id, slug: relSlug(t.name), name: t.name }));
  }
  const hit = relTaskCache.data[kind].find(t => t.slug === slug);
  if (hit) return hit.id;

  if (createIfMissing) {
    const created = await clickupFetch(`/list/${listId}/task`, {
      method: 'POST',
      body: JSON.stringify({ name: String(name) }),
    });
    relTaskCache.data[kind].push({ id: created.id, slug, name: String(name) });
    console.log(`[BriefPipeline] created ClickUp ${kind} task "${name}" (${created.id})`);
    return created.id;
  }
  return null;
}

// Angle dropdown resolution: static map first (MinerForge-era options), then
// the LIVE dropdown options from ClickUp by normalized name — so when the
// operator adds product-specific angle options (e.g. Puure's "The Surgeon's
// Secret") in the ClickUp UI they resolve automatically. The ClickUp API
// cannot create dropdown options, so an unmatched angle falls back to NA.
const angleOptionsCache = { map: null, ts: 0 };
async function resolveAngleOptionId(angle) {
  const key = normalizeAngleKey(angle);
  if (key !== 'NA' && ANGLE_OPTIONS[key]) return ANGLE_OPTIONS[key];
  if (angle && relSlug(angle) && relSlug(angle) !== 'na') {
    try {
      const now = Date.now();
      if (!angleOptionsCache.map || now - angleOptionsCache.ts > 10 * 60 * 1000) {
        const resp = await clickupFetch(`/list/${VIDEO_ADS_LIST}/field`);
        const f = (resp.fields || []).find(x => x.id === FIELD_IDS.angle);
        angleOptionsCache.map = {};
        for (const o of (f?.type_config?.options || [])) angleOptionsCache.map[relSlug(o.name)] = o.id;
        angleOptionsCache.ts = now;
      }
      const hit = angleOptionsCache.map[relSlug(angle)];
      if (hit) return hit;
      console.warn(`[BriefPipeline] angle "${angle}" has no ClickUp dropdown option — falling back to NA. Add the option in ClickUp to have it picked up automatically.`);
    } catch (e) {
      console.warn('[BriefPipeline] dynamic angle option lookup failed:', e.message);
    }
  }
  return ANGLE_OPTIONS.NA;
}

// ── Per-list ClickUp field resolver ───────────────────────────────────
// ClickUp custom fields are LIST-scoped: the same logical field (Product,
// Angle, Creative Type, ...) has a different id in each list, and dropdown
// options carry per-list UUIDs. This resolver fetches a list's fields once
// (10-min cache) and exposes lookups by NAME, so pushBriefToClickUp works
// against any pipeline without hardcoded id maps.
const listConfigCache = {}; // listId -> { ts, byName }
async function resolveListConfig(listId) {
  const now = Date.now();
  const cached = listConfigCache[listId];
  if (cached && now - cached.ts < 10 * 60 * 1000) return cached.cfg;

  const resp = await clickupFetch(`/list/${listId}/field`);
  const byName = {};
  for (const f of (resp.fields || [])) byName[f.name] = f;

  const cfg = {
    fieldId: (name) => byName[name]?.id || null,
    // Resolve a dropdown option UUID by option name (normalized).
    optionId: (fieldName, optionName) => {
      const f = byName[fieldName];
      if (!f || optionName == null) return null;
      const slug = relSlug(optionName);
      const opt = (f.type_config?.options || []).find(o => relSlug(o.name) === slug);
      return opt?.id || null;
    },
  };
  listConfigCache[listId] = { ts: now, cfg };
  return cfg;
}

// Resolve the Angle dropdown option for a SPECIFIC list. Tries the
// normalized canonical key first ("Anti-Fake / Competitor Callout" ->
// "Againstcompetition"), then the raw display name, then NA. Works for any
// list's Angle field and auto-picks up options the operator adds later.
function resolveListAngleOptionId(cfg, angle) {
  const key = normalizeAngleKey(angle);
  return cfg.optionId('Angle', key)
      || (angle ? cfg.optionId('Angle', angle) : null)
      || cfg.optionId('Angle', 'NA');
}

// Editors are now fetched dynamically from ClickUp list members (see utils/clickupEditors.js).

// ── Table Initialization ──────────────────────────────────────────────
let tablesReady = false;

async function ensureTables() {
  if (tablesReady) return;
  try {
    await pgQuery(`
      CREATE TABLE IF NOT EXISTS brief_pipeline_winners (
        id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        creative_id TEXT NOT NULL,
        ad_name TEXT,
        product_code TEXT DEFAULT 'MR',
        angle TEXT,
        format TEXT,
        avatar TEXT,
        editor TEXT,
        hook_type TEXT,
        week TEXT,
        spend NUMERIC(12,2) DEFAULT 0,
        revenue NUMERIC(12,2) DEFAULT 0,
        roas NUMERIC(8,2) DEFAULT 0,
        purchases INTEGER DEFAULT 0,
        cpa NUMERIC(10,2) DEFAULT 0,
        ctr NUMERIC(8,2) DEFAULT 0,
        impressions BIGINT DEFAULT 0,
        clicks BIGINT DEFAULT 0,
        cpm NUMERIC(10,2) DEFAULT 0,
        aov NUMERIC(10,2) DEFAULT 0,
        clickup_task_id TEXT,
        existing_iterations INTEGER DEFAULT 0,
        iteration_codes JSONB DEFAULT '[]',
        raw_script TEXT,
        parsed_script JSONB,
        status TEXT DEFAULT 'detected',
        detected_at TIMESTAMPTZ DEFAULT NOW(),
        selected_at TIMESTAMPTZ,
        winner_reason TEXT,
        iteration_readiness TEXT,
        iteration_mode TEXT,
        iteration_config JSONB,
        thumbnail_url TEXT,
        video_url TEXT,
        UNIQUE(creative_id)
      )
    `, [], { timeout: 15000 });

    // Add columns that may not exist on older tables
    await pgQuery(`ALTER TABLE brief_pipeline_winners ADD COLUMN IF NOT EXISTS thumbnail_url TEXT`).catch(() => {});
    await pgQuery(`ALTER TABLE brief_pipeline_winners ADD COLUMN IF NOT EXISTS video_url TEXT`).catch(() => {});
    await pgQuery(`ALTER TABLE brief_pipeline_winners ADD COLUMN IF NOT EXISTS iteration_mode TEXT`).catch(() => {});
    await pgQuery(`ALTER TABLE brief_pipeline_winners ADD COLUMN IF NOT EXISTS iteration_config JSONB`).catch(() => {});
    await pgQuery(`ALTER TABLE brief_pipeline_winners ADD COLUMN IF NOT EXISTS updated_at TIMESTAMPTZ DEFAULT NOW()`).catch(() => {});
    // Diagnostics — record the last clone/iterate failure so the UI can
    // surface it instead of leaving the operator staring at a silent
    // 'failed' status. Idempotent ADD COLUMN IF NOT EXISTS, safe to re-run
    // on every boot. Also records which model the successful generation
    // used (Opus vs Sonnet fallback).
    await pgQuery(`ALTER TABLE brief_pipeline_winners ADD COLUMN IF NOT EXISTS generation_error TEXT`).catch(() => {});
    await pgQuery(`ALTER TABLE brief_pipeline_winners ADD COLUMN IF NOT EXISTS generation_model TEXT`).catch(() => {});

    await pgQuery(`
      CREATE TABLE IF NOT EXISTS brief_pipeline_generated (
        id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        winner_id UUID REFERENCES brief_pipeline_winners(id),
        parent_creative_id TEXT NOT NULL,
        iteration_mode TEXT,
        aggressiveness TEXT DEFAULT 'medium',
        win_analysis JSONB,
        hooks JSONB DEFAULT '[]',
        body TEXT,
        iteration_direction TEXT,
        novelty_score NUMERIC(3,1),
        aggression_score NUMERIC(3,1),
        coherence_score NUMERIC(3,1),
        overall_score NUMERIC(3,1),
        verdict TEXT,
        scores_json JSONB,
        rank INTEGER,
        brief_number INTEGER,
        product_code TEXT DEFAULT 'MR',
        angle TEXT,
        format TEXT,
        avatar TEXT,
        editor TEXT,
        strategist TEXT DEFAULT 'Ludovico',
        creator TEXT DEFAULT 'NA',
        naming_convention TEXT,
        status TEXT DEFAULT 'generated',
        clickup_task_id TEXT,
        clickup_task_url TEXT,
        created_at TIMESTAMPTZ DEFAULT NOW(),
        approved_at TIMESTAMPTZ,
        pushed_at TIMESTAMPTZ,
        highlighted_text JSONB DEFAULT '[]'
      )
    `, [], { timeout: 15000 });

    // Idempotent ALTER for older deployments — operator's earlier briefs
    // (B0390, B0391) were created before highlighted_text existed.
    await pgQuery(`ALTER TABLE brief_pipeline_generated ADD COLUMN IF NOT EXISTS highlighted_text JSONB DEFAULT '[]'`).catch(() => {});
    // ─── REGRET ─────────────────────────────────────────────────────
    // A previous build of this file ran an `ALTER COLUMN ... TYPE JSONB
    // USING (CASE ...)` on every boot to coerce any rows that landed as
    // TEXT. The USING expression's regex misclassified valid JSONB
    // payloads and reset them to '[]', wiping the data on every deploy.
    // The ADD COLUMN above creates the column as JSONB on fresh tables,
    // and the INSERT path now uses an explicit ::jsonb cast, so the
    // coercion is no longer needed. Do NOT add it back without a typeof
    // guard against information_schema.columns first.
    // ────────────────────────────────────────────────────────────────

    await pgQuery(`
      CREATE TABLE IF NOT EXISTS brief_pipeline_analysis_cache (
        creative_id TEXT PRIMARY KEY,
        script_hash TEXT,
        win_analysis JSONB,
        analyzed_at TIMESTAMPTZ DEFAULT NOW()
      )
    `, [], { timeout: 15000 });

    // Add indexes for common queries
    await pgQuery(`
      CREATE INDEX IF NOT EXISTS idx_bpw_status ON brief_pipeline_winners (status);
      CREATE INDEX IF NOT EXISTS idx_bpw_creative_id ON brief_pipeline_winners (creative_id);
    `).catch(() => {});
    await pgQuery(`
      CREATE INDEX IF NOT EXISTS idx_bpg_winner_id ON brief_pipeline_generated (winner_id);
      CREATE INDEX IF NOT EXISTS idx_bpg_status ON brief_pipeline_generated (status);
      CREATE INDEX IF NOT EXISTS idx_bpg_overall_score ON brief_pipeline_generated (overall_score DESC);
    `).catch(() => {});
    await pgQuery(`
      CREATE INDEX IF NOT EXISTS idx_bpac_script_hash ON brief_pipeline_analysis_cache (script_hash);
    `).catch(() => {});

    // source_url: the public URL of the source ad so editors get a
    // Reference link auto-filled on every ClickUp push, regardless of
    // whether the parent ever lived in our own ClickUp Frame.io flow.
    // - LEAGUE: https://www.facebook.com/ads/library/?id=<ad_archive_id>
    // - META:   ad_library_url from imported_metadata
    // - UPLOAD: operator-provided URL (already accepted as `sourceUrl`)
    await pgQuery(`ALTER TABLE brief_pipeline_references ADD COLUMN IF NOT EXISTS source_url TEXT`).catch(() => {});
    // Backfill source_url for legacy League/Meta references that were
    // imported before this column existed. Idempotent — only fills NULL
    // values, so re-runs on every boot are cheap and don't overwrite
    // operator-edited URLs. League rows compute from ad_archive_id; Meta
    // rows pull ad_library_url from imported_metadata if present.
    await pgQuery(`
      UPDATE brief_pipeline_references
         SET source_url = 'https://www.facebook.com/ads/library/?id=' || ad_archive_id
       WHERE source = 'league'
         AND source_url IS NULL
         AND ad_archive_id IS NOT NULL
    `).catch((e) => {
      console.warn('[BriefPipeline] source_url league backfill skipped:', e.message);
    });
    await pgQuery(`
      UPDATE brief_pipeline_references
         SET source_url = imported_metadata->>'ad_library_url'
       WHERE source = 'meta'
         AND source_url IS NULL
         AND imported_metadata ? 'ad_library_url'
    `).catch((e) => {
      console.warn('[BriefPipeline] source_url meta backfill skipped:', e.message);
    });
    // reference_id: pointer from the virtual winner row back to the
    // brief_pipeline_references row it was generated from. Needed so the
    // push-to-ClickUp resolver can read reference.source_url without
    // guessing — the virtual winner's creative_id is MANUAL-XXXX, NOT the
    // reference's ad_archive_id, so a JOIN on creative_id/ad_archive_id
    // fails for all manual references. Populated at generate-from-script
    // time when referenceId is provided; NULL otherwise.
    await pgQuery(`ALTER TABLE brief_pipeline_winners ADD COLUMN IF NOT EXISTS reference_id UUID REFERENCES brief_pipeline_references(id) ON DELETE SET NULL`).catch(() => {});

    // One-shot naming convention cleanup. Older briefs were built with a
    // synthetic "MANUAL-XXXXXXXX" parent slot in the task name; operator
    // asked us to strip that everywhere. The slug looks like " - MANUAL-XXXXXX -"
    // or " - MANUAL_XXXXXX -". Idempotent — UPDATE only fires on rows that
    // still contain the pattern. Safe to re-run on every boot.
    await pgQuery(`
      UPDATE brief_pipeline_generated
         SET naming_convention = regexp_replace(naming_convention, ' - MANUAL[-_][A-Z0-9]+', '', 'g')
       WHERE naming_convention ~ ' - MANUAL[-_][A-Z0-9]+'
    `).catch((e) => {
      console.warn('[BriefPipeline] MANUAL- slug strip on naming_convention skipped:', e.message);
    });
    // Brief type backfill — clones of competitor ads were previously
    // stamped as IT in the naming convention. Convert " - IT -" to " - NN -"
    // for every brief whose iteration_mode is 'clone'. Idempotent (only
    // affects rows still on the wrong type). Iteration-mode briefs are
    // untouched.
    await pgQuery(`
      UPDATE brief_pipeline_generated
         SET naming_convention = regexp_replace(naming_convention, '^(\\S+ - B\\d{4}) - IT - ', '\\1 - NN - ')
       WHERE iteration_mode = 'clone'
         AND naming_convention ~ '^\\S+ - B\\d{4} - IT - '
    `).catch((e) => {
      console.warn('[BriefPipeline] IT→NN backfill on naming_convention skipped:', e.message);
    });

    // Recover any winners stuck in 'generating' from a previous crash
    const stuck = await pgQuery(
      `UPDATE brief_pipeline_winners SET status = 'detected' WHERE status = 'generating' RETURNING creative_id`
    ).catch(() => []);
    if (stuck.length) {
      console.log(`[BriefPipeline] Recovered ${stuck.length} stuck winners: ${stuck.map(r => r.creative_id).join(', ')}`);
    }

    tablesReady = true;
    console.log('[BriefPipeline] Tables ready');
  } catch (err) {
    console.error('[BriefPipeline] Table creation error:', err.message);
    throw err;
  }
}

// Periodic recovery: reset stuck 'generating' winners every 5 minutes
setInterval(async () => {
  try {
    const stuck = await pgQuery(
      `UPDATE brief_pipeline_winners SET status = 'detected'
       WHERE status = 'generating' AND updated_at < NOW() - INTERVAL '3 minutes'
       RETURNING creative_id`
    ).catch(() => []);
    if (stuck.length) {
      console.log(`[BriefPipeline] Periodic recovery: reset ${stuck.length} stuck winners: ${stuck.map(r => r.creative_id).join(', ')}`);
    }
  } catch (err) {
    console.error(`[BriefPipeline] Periodic recovery error: ${err.message}`);
  }
}, 5 * 60 * 1000);

// ── Helpers ───────────────────────────────────────────────────────────

async function clickupFetch(url, options = {}) {
  const fullUrl = url.startsWith('http') ? url : `${CLICKUP_API}${url}`;
  const res = await fetch(fullUrl, { ...options, headers });
  if (!res.ok) {
    const text = await res.text();
    throw new Error(`ClickUp API error ${res.status}: ${text}`);
  }
  return res.json();
}


function getISOWeekNumber() {
  const now = new Date();
  const d = new Date(Date.UTC(now.getFullYear(), now.getMonth(), now.getDate()));
  const dayNum = d.getUTCDay() || 7;
  d.setUTCDate(d.getUTCDate() + 4 - dayNum);
  const yearStart = new Date(Date.UTC(d.getUTCFullYear(), 0, 1));
  const weekNum = Math.ceil((((d - yearStart) / 86400000) + 1) / 7);
  return { weekNum, year: d.getUTCFullYear() };
}

function getCurrentWeekLabel() {
  const { weekNum, year } = getISOWeekNumber();
  return `WK${String(weekNum).padStart(2, '0')}_${year}`;
}

/**
 * Call Claude API and return parsed JSON from the response.
 */
async function callClaude(systemPrompt, userPrompt, maxTokens = 3000, { fast = false, rawText = false, opus = false, timeoutMs = 0 } = {}) {
  // userPrompt may be a plain string OR a pre-built content-block array
  // (used by the clone path to set a prompt-cache breakpoint after the
  // static prefix — product context + template — so repeat generations
  // within the cache TTL skip reprocessing ~11K input tokens).
  const messages = [
    { role: 'user', content: userPrompt },
  ];

  // Model routing:
  //   opus → highest-quality mode. Operator directive: ALL script generation
  //   (clone body+hooks, hook rewrite) runs on Opus, never Sonnet. Slower
  //   (~120s) so generation callers pass a generous timeoutMs.
  //   fast → quick parses (script parser, hook extractor) where Haiku is fine.
  //   default → Sonnet for non-generation work (judges, enhance, win-analysis).
  // Aliases used throughout this codebase — matches the CLAUDE_MODEL pattern.
  const model = opus
    ? 'claude-opus-4-8'
    : (fast ? 'claude-haiku-4-5-20251001' : CLAUDE_MODEL);
  const body = {
    model,
    max_tokens: maxTokens,
    messages,
    system: systemPrompt,
  };

  const res = await fetch(CLAUDE_API_URL, {
    method: 'POST',
    headers: {
      'x-api-key': ANTHROPIC_API_KEY,
      'anthropic-version': '2023-06-01',
      'Content-Type': 'application/json',
    },
    body: JSON.stringify(body),
    // Cap the tail: a hung attempt must fail fast so the fallback model can
    // run instead of stacking a full failed wait on top of a full retry.
    ...(timeoutMs > 0 ? { signal: AbortSignal.timeout(timeoutMs) } : {}),
  });

  if (!res.ok) {
    const errText = await res.text();
    console.error(`[callClaude] HTTP ${res.status} from model=${model} maxTokens=${maxTokens}: ${errText.slice(0, 500)}`);
    throw new Error(`Claude API error ${res.status} (model=${model}): ${errText.slice(0, 300)}`);
  }

  const data = await res.json();
  const text = data.content?.[0]?.text || '';
  if (data.stop_reason === 'max_tokens') {
    console.warn(`[callClaude] stop_reason=max_tokens — response was clipped at ${maxTokens} tokens. Consider bumping the budget. model=${model}`);
  }

  // Raw text mode — return plain text without JSON parsing
  if (rawText) return text.trim();

  // Strip markdown fences if present, then extract JSON
  let cleaned = text.trim();

  // Try to match fenced JSON block (with or without closing fence for truncated responses)
  const fenceMatch = cleaned.match(/```(?:json)?\s*\n?([\s\S]*?)\n?\s*```/) ||
                     cleaned.match(/```(?:json)?\s*\n?([\s\S]+)$/);
  if (fenceMatch) cleaned = fenceMatch[1].trim();

  // Extract JSON object — first try with closing brace, then without (truncated)
  let jsonMatch = cleaned.match(/\{[\s\S]*\}/);
  let wasTruncated = false;
  if (!jsonMatch) {
    // Response may be truncated — grab from first { to end of string
    jsonMatch = cleaned.match(/\{[\s\S]+$/);
    wasTruncated = !!jsonMatch;
  }
  if (!jsonMatch) {
    throw new Error(`Claude returned no JSON block. Response: ${cleaned.slice(0, 500)}`);
  }

  let raw = jsonMatch[0];

  // If truncated, close open brackets/braces before parsing
  if (wasTruncated) {
    // Close any dangling string (odd number of unescaped quotes = mid-string cut)
    const quotes = raw.match(/(?<!\\)"/g) || [];
    if (quotes.length % 2 !== 0) raw += '"';
    // Remove trailing incomplete key (key with no colon/value) or dangling comma
    raw = raw.replace(/,\s*"[^"]*"\s*$/, '');   // trailing orphan key like , "sugge"
    raw = raw.replace(/,\s*$/, '');
    // Close open brackets and braces
    const openBrackets = (raw.match(/\[/g) || []).length;
    const closeBrackets = (raw.match(/\]/g) || []).length;
    for (let i = 0; i < openBrackets - closeBrackets; i++) raw += ']';
    const opens = (raw.match(/\{/g) || []).length;
    const closes = (raw.match(/\}/g) || []).length;
    for (let i = 0; i < opens - closes; i++) raw += '}';
  }

  try {
    return JSON.parse(raw);
  } catch (parseErr) {
    // Aggressive repair: the response may be truncated mid-value even though
    // regex found matching braces (inner `}` matched as outer)
    let fixable = raw;

    // Step 1: Remove trailing commas
    fixable = fixable.replace(/,\s*([}\]])/g, '$1');

    // Step 2: If parse fails at a specific position, try truncating there and repairing
    const posMatch = parseErr.message.match(/position (\d+)/);
    if (posMatch) {
      const cutPos = parseInt(posMatch[1]);
      let truncated = fixable.slice(0, cutPos);
      // Close dangling string
      const quotes = truncated.match(/(?<!\\)"/g) || [];
      if (quotes.length % 2 !== 0) truncated += '"';
      // Remove trailing incomplete key or value
      truncated = truncated.replace(/,\s*"[^"]*"\s*$/, '');
      truncated = truncated.replace(/,\s*"[^"]*"\s*:\s*$/, '');
      truncated = truncated.replace(/,\s*$/, '');
      // Close open brackets and braces
      const ob = (truncated.match(/\[/g) || []).length - (truncated.match(/\]/g) || []).length;
      for (let i = 0; i < ob; i++) truncated += ']';
      const oc = (truncated.match(/\{/g) || []).length - (truncated.match(/\}/g) || []).length;
      for (let i = 0; i < oc; i++) truncated += '}';
      try { return JSON.parse(truncated); } catch {}
    }

    // Step 3: Standard repair — close open braces/brackets
    const opens = (fixable.match(/\{/g) || []).length;
    const closes = (fixable.match(/\}/g) || []).length;
    for (let i = 0; i < opens - closes; i++) fixable += '}';
    const openBrackets = (fixable.match(/\[/g) || []).length;
    const closeBrackets = (fixable.match(/\]/g) || []).length;
    for (let i = 0; i < openBrackets - closeBrackets; i++) fixable += ']';
    try { return JSON.parse(fixable); } catch {}
    throw new Error(`Failed to parse Claude JSON: ${parseErr.message}\nRaw: ${raw.slice(0, 300)}`);
  }
}

/**
 * Call OpenAI API for brief generation. Same interface as callClaude
 * for seamless model swapping. Returns parsed JSON response.
 */
async function callOpenAI(systemPrompt, userPrompt, maxTokens = 3000, { temperature = 0.3, jsonMode = true } = {}) {
  const OPENAI_API_KEY = process.env.OPENAI_API_KEY || '';
  if (!OPENAI_API_KEY) {
    throw new Error('OPENAI_API_KEY not configured');
  }

  const OPENAI_API_URL = 'https://api.openai.com/v1/chat/completions';
  const messages = [
    { role: 'system', content: systemPrompt },
    { role: 'user', content: userPrompt },
  ];

  const body = {
    model: 'gpt-4o',
    max_tokens: maxTokens,
    // GPT-4o at the default temperature (1.0) paraphrases and genericizes
    // instead of cloning surgically — it turned a "Black Friday launched 4
    // months early by mistake" ad into a bland "our sale went live early".
    // Low temperature keeps it faithful to the source. json_object mode makes
    // the structured output reliable (all our prompts already say "return
    // ONLY valid JSON", which satisfies the API's json-in-prompt requirement).
    temperature,
    ...(jsonMode ? { response_format: { type: 'json_object' } } : {}),
    messages,
  };

  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), 60000); // 60 second timeout

  try {
    const res = await fetch(OPENAI_API_URL, {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${OPENAI_API_KEY}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(body),
      signal: controller.signal,
    });

    if (!res.ok) {
      const errText = await res.text();
      console.error(`[callOpenAI] HTTP ${res.status} from OpenAI: ${errText.slice(0, 500)}`);
      throw new Error(`OpenAI API error ${res.status}: ${errText.slice(0, 300)}`);
    }

    const data = await res.json();
    const text = data.choices?.[0]?.message?.content || '';
    if (data.choices?.[0]?.finish_reason === 'length') {
      console.warn(`[callOpenAI] Response clipped at ${maxTokens} tokens. Consider bumping the budget.`);
    }

    // Parse JSON response (same as callClaude)
    let cleaned = text.trim();
    const fenceMatch = cleaned.match(/```(?:json)?\s*\n?([\s\S]*?)\n?\s*```/) ||
                       cleaned.match(/```(?:json)?\s*\n?([\s\S]+)$/);
    if (fenceMatch) cleaned = fenceMatch[1].trim();

    let jsonMatch = cleaned.match(/\{[\s\S]*\}/);
    let wasTruncated = false;
    if (!jsonMatch) {
      jsonMatch = cleaned.match(/\{[\s\S]+$/);
      wasTruncated = !!jsonMatch;
    }
    if (!jsonMatch) {
      throw new Error(`OpenAI returned no JSON block. Response: ${cleaned.slice(0, 500)}`);
    }

    let raw = jsonMatch[0];

    if (wasTruncated) {
      const quotes = raw.match(/(?<!\\)"/g) || [];
      if (quotes.length % 2 !== 0) raw += '"';
      raw = raw.replace(/,\s*"[^"]*"\s*$/, '');
      raw = raw.replace(/,\s*$/, '');
      const openBrackets = (raw.match(/\[/g) || []).length;
      const closeBrackets = (raw.match(/\]/g) || []).length;
      for (let i = 0; i < openBrackets - closeBrackets; i++) raw += ']';
      const opens = (raw.match(/\{/g) || []).length;
      const closes = (raw.match(/\}/g) || []).length;
      for (let i = 0; i < opens - closes; i++) raw += '}';
    }

    try {
      return JSON.parse(raw);
    } catch (parseErr) {
      throw new Error(`Failed to parse OpenAI JSON: ${parseErr.message}\nRaw: ${raw.slice(0, 300)}`);
    }
  } finally {
    clearTimeout(timeoutId);
  }
}

/**
 * Classify why a winner is winning.
 */
function classifyWinner(winner) {
  if (winner.roas >= 3.0 && winner.total_spend >= 500) return 'volume_winner';
  if (winner.roas >= 2.0) return 'high_roas';
  if (winner.total_spend >= 50 && winner.total_spend <= 500 && winner.roas >= 1.5) return 'rising_star';
  if (winner.cpa <= 20) return 'efficiency_winner';
  return 'high_roas';
}

/**
 * Classify iteration readiness.
 */
function classifyReadiness(winner, existingIterations) {
  if (winner.total_spend < 100) return 'not_enough_data';
  if (existingIterations >= 8) return 'over_iterated';
  return 'ready';
}

/**
 * Count existing iterations for a creative in ClickUp.
 */
async function countIterations(creativeId) {
  let page = 0;
  let hasMore = true;
  const iterations = [];

  while (hasMore) {
    const data = await clickupFetch(
      `/list/${VIDEO_ADS_LIST}/task?page=${page}&limit=100&include_closed=true&subtasks=true`
    );
    const tasks = data.tasks || [];

    for (const task of tasks) {
      const parentField = task.custom_fields?.find(f => f.id === FIELD_IDS.parentBriefId);
      const briefTypeField = task.custom_fields?.find(f => f.id === FIELD_IDS.briefType);

      const briefType = briefTypeField?.type_config?.options?.find(
        o => o.orderindex === briefTypeField?.value
      )?.name;

      if (briefType === 'IT') {
        const parentValue = parentField?.value;
        if (parentValue && parentValue.includes(creativeId)) {
          const briefMatch = task.name?.match(/B(\d{2,5})/);
          if (briefMatch) {
            iterations.push({
              code: `B${briefMatch[1].padStart(4, '0')}`,
              taskId: task.id,
              name: task.name,
              status: task.status?.status,
            });
          }
        }
      }
    }

    hasMore = tasks.length === 100;
    page++;
  }

  return iterations;
}

/**
 * Extract script from a ClickUp task (description + comments).
 */
async function extractScript(clickupTaskId) {
  const task = await clickupFetch(`/task/${clickupTaskId}`);
  const description = task.description || task.text_content || '';

  const comments = await clickupFetch(`/task/${clickupTaskId}/comment`);
  const commentText = (comments.comments || [])
    .map(c => c.comment_text || '')
    .join('\n\n');

  return {
    raw: description + '\n\n' + commentText,
    taskName: task.name,
    status: task.status?.status,
  };
}

/**
 * Find the ClickUp task ID for a creative by its brief code (e.g. B0003).
 */
async function findClickUpTaskByBriefCode(briefCode) {
  const briefNum = parseInt(briefCode.replace(/^B0*/, ''), 10);
  if (isNaN(briefNum)) return null;

  let page = 0;
  let hasMore = true;

  while (hasMore) {
    const data = await clickupFetch(
      `/list/${VIDEO_ADS_LIST}/task?page=${page}&limit=100&include_closed=true&subtasks=true`
    );
    const tasks = data.tasks || [];

    for (const task of tasks) {
      const briefField = task.custom_fields?.find(f => f.id === FIELD_IDS.briefNumber);
      const taskBriefNum = briefField?.value != null ? parseInt(briefField.value, 10) : null;
      const nameMatch = task.name?.match(/B0*(\d+)/);
      const nameBriefNum = nameMatch ? parseInt(nameMatch[1], 10) : null;

      if (taskBriefNum === briefNum || nameBriefNum === briefNum) {
        return task.id;
      }
    }

    hasMore = tasks.length === 100;
    page++;
  }

  return null;
}

/**
 * Get the next available brief number from ClickUp.
 */
async function getNextBriefNumber(productCode = null) {
  // The next number is MAX(ClickUp tasks, DB briefs) + 1. Considering only
  // ClickUp pinned the number at 350 for days: briefs that were never pushed
  // to ClickUp didn't count, so every generation shared the same number and
  // identical naming — indistinguishable cards in the UI.
  //
  // Puure (PUURE/PL) has its OWN sequence starting at B0010 — it scans the
  // PL | Video Creatives list and only PUURE rows in the DB. Everything else
  // shares the original global sequence.
  const isPl = productCode === 'PUURE' || productCode === 'PL';
  const scanListId = isPl ? PUURE_VIDEO_LIST : VIDEO_ADS_LIST;
  let maxBrief = isPl ? 9 : 0; // PL floor: first brief is B0010

  try {
    let page = 0;
    let hasMore = true;
    while (hasMore) {
      const data = await clickupFetch(
        `/list/${scanListId}/task?page=${page}&limit=100&include_closed=true&subtasks=true`
      );
      const tasks = data.tasks || [];

      for (const task of tasks) {
        const briefField = task.custom_fields?.find(f => f.id === FIELD_IDS.briefNumber);
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
  } catch (e) {
    // A ClickUp outage must not abort generation — the DB max below still
    // guarantees a unique, monotonically increasing number.
    console.warn(`[BriefPipeline] getNextBriefNumber: ClickUp fetch failed (${e.message}) — using DB max only`);
  }

  try {
    const rows = isPl
      ? await pgQuery(`SELECT COALESCE(MAX(brief_number), 0) AS max FROM brief_pipeline_generated WHERE product_code IN ('PUURE','PL')`)
      : await pgQuery(`SELECT COALESCE(MAX(brief_number), 0) AS max FROM brief_pipeline_generated WHERE product_code IS NULL OR product_code NOT IN ('PUURE','PL')`);
    const dbMax = Number(rows[0]?.max || 0);
    if (dbMax > maxBrief) maxBrief = dbMax;
  } catch (e) {
    console.warn(`[BriefPipeline] getNextBriefNumber: DB max query failed (${e.message})`);
  }

  return maxBrief + 1;
}

// Race-free brief-number allocation. read-MAX-then-insert-later let two
// concurrent queue jobs (worker concurrency 2) mint the same number — the
// single-row counter's atomic UPDATE ... RETURNING cannot collide. `floor`
// carries the ClickUp-side max so numbers always stay above pushed tasks.
async function allocateBriefNumber(floor = 0, counterId = 1) {
  try {
    await pgQuery(`
      INSERT INTO brief_number_counter (id, value)
      SELECT $1, COALESCE((SELECT MAX(brief_number) FROM brief_pipeline_generated), 0)
      ON CONFLICT (id) DO NOTHING
    `, [counterId]);
    const rows = await pgQuery(
      `UPDATE brief_number_counter SET value = GREATEST(value, $1) + 1 WHERE id = $2 RETURNING value`,
      [Number(floor) || 0, counterId]
    );
    if (rows[0]?.value) return Number(rows[0].value);
  } catch (e) {
    console.warn(`[BriefPipeline] allocateBriefNumber failed (${e.message}) — falling back to MAX+1`);
  }
  // Last resort (counter table unavailable): the old racy path, still better
  // than failing the generation outright.
  const rows = await pgQuery(`SELECT COALESCE(MAX(brief_number), 0) AS max FROM brief_pipeline_generated`);
  return Number(rows[0]?.max || 0) + Math.floor(1 + Math.random() * 3);
}

/**
 * Build the naming convention string.
 */
// Map angle names to short codes for naming conventions
const ANGLE_ABBREV = {
  'pain point': 'PP', 'social proof': 'SP', 'before/after': 'BA',
  'curiosity hook': 'CH', 'direct offer': 'DO', 'authority': 'AU',
  'promo': 'Promo',
};
function abbreviateAngle(angle) {
  if (!angle || angle === 'NA') return 'NA';
  const key = angle.toLowerCase().trim();
  if (ANGLE_ABBREV[key]) return ANGLE_ABBREV[key];
  // Custom angle — take first 2 words, capitalize initials
  return angle.split(/\s+/).slice(0, 3).map(w => w[0]?.toUpperCase()).join('') || angle.slice(0, 6);
}

function buildNamingConvention({ product_code, brief_number, parent_creative_id, avatar, angle, format, strategist, creator, editor, week, brief_type }) {
  const briefId = `B${String(brief_number).padStart(4, '0')}`;
  const briefType = brief_type === 'NN' ? 'NN' : 'IT';
  const weekLabel = week || getCurrentWeekLabel();

  // Puure (PL) has its own canonical shape — and it is NOT this function's
  // shape, it is the one the ClickUp webhook rebuilds every PL card with
  // (reconcilePlName):
  //   PL - B#### - BriefType - Avatar - Angle - CreativeType - Strategist - Editor - WK##_####
  // Nine slots: no parent-brief slot and, crucially, NO creator slot.
  // Emitting a creator here would shove the editor into a 10th slot
  // ("... - Ludovico - NA - Uly - WK29_2026"), so every pushed PL card would
  // disagree with the board. Today that only stays hidden because the editor
  // is usually null and the creator's 'NA' lands in the editor's position by
  // coincidence — the drift appears the moment a real editor is assigned.
  if (product_code === 'PL') {
    return [
      'PL',
      briefId,
      briefType,
      avatar || 'NA',
      abbreviateAngle(angle),
      format || 'Mashup',
      strategist || 'Ludovico',
      editor || 'NA',
      weekLabel,
    ].map((s) => String(s).trim() || 'NA').join(' - ');
  }

  // MB / everything else keeps the original shape (parent + creator + editor).
  const isSyntheticParent = !parent_creative_id || /^MANUAL[-_]/i.test(String(parent_creative_id));
  const dropParent = briefType === 'NN' || isSyntheticParent;
  const slots = [
    product_code || 'MR',
    briefId,
    briefType,
    dropParent ? null : parent_creative_id,
    avatar || 'NA',
    abbreviateAngle(angle),
    format || 'Mashup',
    strategist || 'Ludovico',
    creator || 'NA',
    editor || null,
    weekLabel,
  ];
  return slots.filter((s) => s !== null && s !== undefined && s !== '').join(' - ');
}

// ── Transcribe video/audio with Gemini ───────────────────────────────
// Support multiple Gemini API keys for rate limit rotation
const GEMINI_API_KEYS = [
  process.env.GEMINI_API_KEY,
  process.env.GEMINI_API_KEY_2,
  process.env.GEMINI_API_KEY_3,
].filter(Boolean);
const GEMINI_API_KEY = GEMINI_API_KEYS[0] || '';
let geminiKeyIndex = 0;
function getNextGeminiKey() {
  if (!GEMINI_API_KEYS.length) return '';
  geminiKeyIndex = (geminiKeyIndex + 1) % GEMINI_API_KEYS.length;
  return GEMINI_API_KEYS[geminiKeyIndex];
}

async function transcribeWithGemini(mediaUrl) {
  if (!GEMINI_API_KEY) throw new Error('GEMINI_API_KEY not configured — cannot transcribe video');

  console.log(`[BriefPipeline] Downloading media for transcription: ${mediaUrl.slice(0, 80)}...`);

  // Download the media file
  const mediaRes = await fetch(mediaUrl, {
    headers: { 'User-Agent': 'Mozilla/5.0 (compatible; MineblockBot/1.0)' },
    redirect: 'follow',
    signal: AbortSignal.timeout(60000),
  });

  if (!mediaRes.ok) throw new Error(`Failed to download media: HTTP ${mediaRes.status}`);

  const buffer = Buffer.from(await mediaRes.arrayBuffer());
  const contentType = mediaRes.headers.get('content-type') || 'video/mp4';
  const sizeMB = buffer.length / 1024 / 1024;

  console.log(`[BriefPipeline] Media downloaded: ${sizeMB.toFixed(1)}MB (${contentType})`);

  const transcriptionPrompt = `Transcribe ALL spoken words in this video/audio. Return ONLY the transcript as plain text — no timestamps, no speaker labels, no commentary, no formatting. Just the exact words spoken, preserving the natural flow and paragraph breaks. If there are multiple speakers, separate their lines with paragraph breaks.`;
  // Use current Gemini models — 1.5 models are deprecated (404)
  // Use stable Gemini model names (bare 'gemini-2.0-flash' returns 404)
  const models = ['gemini-2.0-flash-001', 'gemini-1.5-flash'];
  const mime = contentType.split(';')[0];

  // For files > 15MB, use Gemini File API (upload first, then reference)
  if (sizeMB > 15) {
    console.log(`[BriefPipeline] Large file (${sizeMB.toFixed(1)}MB) — using Gemini File API upload`);
    const fileUri = await uploadToGeminiFileApi(buffer, mime);
    if (fileUri) {
      const requestBody = {
        contents: [{ parts: [
          { fileData: { mimeType: mime, fileUri } },
          { text: transcriptionPrompt },
        ]}],
        generationConfig: { maxOutputTokens: 4096, temperature: 0.1 },
      };
      // Try all key/model combos — no blocking waits
      const result = await callGeminiWithRetry(models, requestBody);
      if (result) return result;
    }
  }

  // Inline base64 approach (works well for files < 15MB)
  const base64Data = buffer.toString('base64');
  const requestBody = {
    contents: [{ parts: [
      { inlineData: { mimeType: mime, data: base64Data } },
      { text: transcriptionPrompt },
    ]}],
    generationConfig: { maxOutputTokens: 4096, temperature: 0.1 },
  };

  // Try all key/model combos — no blocking waits
  const result = await callGeminiWithRetry(models, requestBody);
  if (result) return result;

  throw new Error('Video transcription failed — all Gemini API keys rate-limited. Please paste the script text manually or try again in 1 minute.');
}

// Upload file to Gemini File API for large media
async function uploadToGeminiFileApi(buffer, mimeType) {
  try {
    // Step 1: Start resumable upload (use next key in rotation for large files)
    const uploadKey = GEMINI_API_KEYS.length > 1 ? getNextGeminiKey() : GEMINI_API_KEY;
    const startRes = await fetch(
      `https://generativelanguage.googleapis.com/upload/v1beta/files?key=${uploadKey}`,
      {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'X-Goog-Upload-Protocol': 'resumable',
          'X-Goog-Upload-Command': 'start',
          'X-Goog-Upload-Header-Content-Length': buffer.length.toString(),
          'X-Goog-Upload-Header-Content-Type': mimeType,
        },
        body: JSON.stringify({ file: { displayName: 'ad-video-transcription' } }),
        signal: AbortSignal.timeout(30000),
      }
    );

    const uploadUrl = startRes.headers.get('x-goog-upload-url');
    if (!uploadUrl) {
      console.warn('[BriefPipeline] Gemini File API: no upload URL returned');
      return null;
    }

    // Step 2: Upload the file bytes
    console.log(`[BriefPipeline] Uploading ${(buffer.length / 1024 / 1024).toFixed(1)}MB to Gemini File API...`);
    const uploadRes = await fetch(uploadUrl, {
      method: 'PUT',
      headers: {
        'Content-Length': buffer.length.toString(),
        'X-Goog-Upload-Offset': '0',
        'X-Goog-Upload-Command': 'upload, finalize',
      },
      body: buffer,
      signal: AbortSignal.timeout(120000),
    });

    const uploadData = await uploadRes.json();
    const fileUri = uploadData?.file?.uri;
    const state = uploadData?.file?.state;

    if (!fileUri) {
      console.warn('[BriefPipeline] Gemini File API: no file URI in response', JSON.stringify(uploadData).slice(0, 200));
      return null;
    }

    // Step 3: Wait for file processing (poll until ACTIVE)
    if (state !== 'ACTIVE') {
      console.log(`[BriefPipeline] File uploaded, waiting for processing (state: ${state})...`);
      const fileName = uploadData.file.name;
      for (let i = 0; i < 12; i++) {
        await new Promise(r => setTimeout(r, 5000));
        const checkRes = await fetch(`https://generativelanguage.googleapis.com/v1beta/${fileName}?key=${uploadKey}`);
        const checkData = await checkRes.json();
        if (checkData.state === 'ACTIVE') {
          console.log('[BriefPipeline] File processing complete');
          return checkData.uri;
        }
        if (checkData.state === 'FAILED') {
          console.warn('[BriefPipeline] File processing failed');
          return null;
        }
      }
      console.warn('[BriefPipeline] File processing timed out');
      return null;
    }

    console.log(`[BriefPipeline] File uploaded and ready: ${fileUri.slice(0, 80)}`);
    return fileUri;
  } catch (err) {
    console.warn('[BriefPipeline] Gemini File API upload error:', err.message);
    return null;
  }
}

// Call Gemini with retry across multiple models AND multiple API keys (no blocking waits)
async function callGeminiWithRetry(models, requestBody) {
  let lastError = null;
  // Try every key × every model combination — fail fast, no 30-60s waits
  for (const apiKey of (GEMINI_API_KEYS.length ? GEMINI_API_KEYS : [GEMINI_API_KEY])) {
    if (!apiKey) continue;
    for (const model of models) {
      try {
        const keyLabel = `key:${apiKey.slice(-4)}`;
        console.log(`[BriefPipeline] Trying Gemini ${model} (${keyLabel})`);
        const geminiUrl = `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${apiKey}`;
        const geminiRes = await fetch(geminiUrl, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(requestBody),
          signal: AbortSignal.timeout(120000),
        });

        if (geminiRes.status === 429) {
          console.warn(`[BriefPipeline] ${model} (${keyLabel}) rate limited (429), trying next key/model...`);
          lastError = `${model}: Rate limited`;
          continue;
        }

        if (geminiRes.status === 404) {
          console.warn(`[BriefPipeline] ${model} not found (404), skipping model...`);
          lastError = `${model}: Model not found`;
          break; // Skip this model entirely, try next
        }

        if (!geminiRes.ok) {
          const errText = await geminiRes.text();
          lastError = `${model}: HTTP ${geminiRes.status}`;
          console.warn(`[BriefPipeline] ${model} (${keyLabel}) failed: HTTP ${geminiRes.status} — ${errText.slice(0, 150)}`);
          continue;
        }

        const geminiData = await geminiRes.json();
        const transcript = geminiData.candidates?.[0]?.content?.parts?.[0]?.text || '';
        if (transcript && transcript.length >= 20) {
          console.log(`[BriefPipeline] Transcription complete with ${model} (${keyLabel}): ${transcript.length} chars`);
          return transcript.trim();
        }
        lastError = `${model}: Empty transcript`;
      } catch (err) {
        lastError = `${model}: ${err.message}`;
        console.warn(`[BriefPipeline] ${model} error:`, err.message);
      }
    }
  }
  return null;
}


// Sanitize URL for safe shell usage — reject anything with shell metacharacters
function sanitizeUrlForShell(url) {
  if (!url || typeof url !== 'string') return null;
  // Only allow http/https URLs with safe characters
  if (!/^https?:\/\/[^\s"'`$;|&()<>\\]+$/.test(url)) return null;
  return url;
}

// ── Smart URL extraction: handles FB Ad Library, Atria, direct video, HTML pages ──
// ── Extract video URL from any page using yt-dlp ────────────────────
// Extract video metadata (title, description, ad copy) using yt-dlp — no API needed
async function extractMetadataWithYtdlp(pageUrl) {
  if (!existsSync(YTDLP_PATH)) return null;
  const safeUrl = sanitizeUrlForShell(pageUrl);
  if (!safeUrl) { console.warn('[BriefPipeline] Rejected unsafe URL for yt-dlp'); return null; }
  try {
    console.log(`[BriefPipeline] Extracting metadata with yt-dlp: ${safeUrl.slice(0, 100)}`);
    const { stdout } = await execFileAsync(
      YTDLP_PATH,
      ['-j', '--no-warnings', '--skip-download', safeUrl],
      { timeout: 45000, maxBuffer: 10 * 1024 * 1024 }
    );
    const data = JSON.parse(stdout.trim());
    return {
      title: data.title || '',
      description: data.description || '',
      uploader: data.uploader || '',
      duration: data.duration || 0,
    };
  } catch (err) {
    console.warn('[BriefPipeline] yt-dlp metadata extraction failed:', err.message?.slice(0, 150));
    return null;
  }
}

async function extractVideoUrlWithYtdlp(pageUrl, { audioOnly = false } = {}) {
  if (!existsSync(YTDLP_PATH)) {
    console.warn('[BriefPipeline] yt-dlp not available at', YTDLP_PATH);
    return null;
  }
  const safeUrl = sanitizeUrlForShell(pageUrl);
  if (!safeUrl) { console.warn('[BriefPipeline] Rejected unsafe URL for yt-dlp'); return null; }

  // For transcription: prefer smallest audio to avoid huge uploads to Gemini
  // For other uses: get best video
  const strategies = audioOnly ? [
    // Audio-only strategies (small files, fast transcription)
    ['--get-url', '--no-warnings', '-f', 'worstaudio[ext=m4a]/worstaudio/worst', safeUrl],
    ['--get-url', '--no-warnings', '-f', 'bestaudio[ext=m4a]/bestaudio', safeUrl],
    ['--get-url', '--no-warnings', '-f', 'worst', safeUrl],
  ] : [
    ['--get-url', '--no-warnings', '-f', 'best[ext=mp4]/best', safeUrl],
    ['--get-url', '--no-warnings', '-f', 'best', safeUrl],
    ['--get-url', '--no-warnings', '--force-generic-extractor', safeUrl],
  ];

  for (let i = 0; i < strategies.length; i++) {
    try {
      console.log(`[BriefPipeline] yt-dlp strategy ${i + 1}${audioOnly ? ' (audio)' : ''} for: ${pageUrl.slice(0, 100)}`);
      const { stdout } = await execFileAsync(YTDLP_PATH, strategies[i], {
        timeout: 45000,
        maxBuffer: 10 * 1024 * 1024,
      });
      const result = stdout.trim();

      const firstUrl = result.split('\n').find(line => line.startsWith('http'));
      if (firstUrl) {
        console.log(`[BriefPipeline] yt-dlp extracted URL (strategy ${i + 1}): ${firstUrl.slice(0, 120)}...`);
        return firstUrl;
      }
    } catch (err) {
      console.warn(`[BriefPipeline] yt-dlp strategy ${i + 1} failed:`, err.message?.slice(0, 200));
    }
  }

  return null;
}

async function extractScriptFromUrl(url) {
  // Strategy 1: Facebook Ad Library URL → yt-dlp extract video → Gemini transcribe
  const fbAdMatch = url.match(/facebook\.com\/ads\/library\/?\?.*id=(\d+)/i)
    || url.match(/fb\.com\/ads\/library\/?\?.*id=(\d+)/i);
  if (fbAdMatch) {
    const adId = fbAdMatch[1];
    console.log(`[BriefPipeline] Facebook Ad Library detected, ad ID: ${adId}`);

    // Step 1: Extract metadata (title, description, ad copy) — instant, no API calls
    const metadata = await extractMetadataWithYtdlp(url);
    if (metadata) {
      const adCopy = [metadata.title, metadata.description].filter(Boolean).join('\n\n').trim();
      if (adCopy.length > 50) {
        console.log(`[BriefPipeline] Got ad copy from metadata (${adCopy.length} chars), using as script reference`);
        // For short ad copy + long video, append note that there's likely more spoken content
        if (metadata.duration > 30 && adCopy.length < 300) {
          console.log(`[BriefPipeline] Ad copy is short (${adCopy.length} chars) for ${metadata.duration}s video — will also try audio transcription`);
        } else {
          return adCopy;
        }
      }
    }

    // Step 2: Try audio transcription with yt-dlp + Gemini (audio-only = small file)
    const audioUrl = await extractVideoUrlWithYtdlp(url, { audioOnly: true });
    if (audioUrl) {
      try {
        const transcript = await transcribeWithGemini(audioUrl);
        // If we also have metadata, combine them for richer context
        if (metadata?.description && metadata.description.length > 30) {
          return `[AD COPY]\n${metadata.title || ''}\n${metadata.description}\n\n[VOICEOVER TRANSCRIPT]\n${transcript}`;
        }
        return transcript;
      } catch (audioErr) {
        console.warn(`[BriefPipeline] Audio transcription failed:`, audioErr.message);
        // If we have metadata ad copy, use that as fallback
        if (metadata) {
          const adCopy = [metadata.title, metadata.description].filter(Boolean).join('\n\n').trim();
          if (adCopy.length > 50) {
            console.log(`[BriefPipeline] Using metadata ad copy as fallback (${adCopy.length} chars)`);
            return `[AD COPY FROM METADATA — audio transcription was not available]\n${adCopy}`;
          }
        }
      }
    }

    // Step 3: Try full video transcription
    const videoUrl = await extractVideoUrlWithYtdlp(url);
    if (videoUrl) {
      try {
        return await transcribeWithGemini(videoUrl);
      } catch (videoErr) {
        console.warn(`[BriefPipeline] Video transcription failed:`, videoErr.message);
        // If we have ANY metadata, use it rather than failing completely
        if (metadata) {
          const adCopy = [metadata.title, metadata.description].filter(Boolean).join('\n\n').trim();
          if (adCopy.length > 20) {
            console.log(`[BriefPipeline] Using metadata as last resort (${adCopy.length} chars)`);
            return `[AD COPY FROM METADATA — video transcription failed]\n${adCopy}`;
          }
        }
      }
    }

    // Step 4: Fallback to Meta API
    try {
      return await extractFromMetaAdId(adId);
    } catch (apiErr) {
      // If we have metadata from step 1, use it rather than completely failing
      if (metadata) {
        const adCopy = [metadata.title, metadata.description].filter(Boolean).join('\n\n').trim();
        if (adCopy.length > 20) return `[AD COPY FROM METADATA — all extraction methods failed]\n${adCopy}`;
      }
      console.error(`[BriefPipeline] All extraction failed for FB ad ${adId}. yt-dlp: ${existsSync(YTDLP_PATH) ? 'installed' : 'NOT INSTALLED'}, META_ACCESS_TOKEN: ${META_ACCESS_TOKEN ? 'set' : 'NOT SET'}`);
      throw new Error(`Could not extract ad ${adId}. This is a video ad that requires transcription. Try: (1) Right-click the video → "Copy video address" and paste the direct .mp4 link, or (2) Use "Paste Text" to paste the script manually.`);
    }
  }

  // Strategy 1b: Any Facebook video URL → yt-dlp (audio first, then video)
  const isFacebookUrl = /facebook\.com|fb\.com|fb\.watch/i.test(url);
  if (isFacebookUrl) {
    const audioUrl = await extractVideoUrlWithYtdlp(url, { audioOnly: true });
    if (audioUrl) {
      try { return await transcribeWithGemini(audioUrl); } catch {}
    }
    const videoUrl = await extractVideoUrlWithYtdlp(url);
    if (videoUrl) {
      return await transcribeWithGemini(videoUrl);
    }
  }

  // Strategy 2: Atria URL → fetch Atria page (has server-rendered content) → fallback to Meta API
  const atriaMatch = url.match(/tryatria\.com\/ad\//i);
  if (atriaMatch) {
    console.log(`[BriefPipeline] Atria ad detected: ${url}`);
    try {
      // Atria pages often have ad text in the HTML — try fetching directly first
      const atriaRes = await fetch(url, {
        headers: {
          'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
          'Accept': 'text/html,application/xhtml+xml',
        },
        redirect: 'follow',
        signal: AbortSignal.timeout(15000),
      });
      const atriaHtml = await atriaRes.text();
      console.log(`[BriefPipeline] Atria page HTML: ${atriaHtml.length} chars`);

      // Try extracting ad text from Atria page HTML
      if (atriaHtml.length > 500) {
        // Look for video URLs first (Atria often embeds the ad video)
        const videoPatterns = [
          /(?:src|data-src|poster|content|url)\s*[=:]\s*["']?(https?:\/\/[^"'\s>]+\.(?:mp4|webm|mov)(?:\?[^"'\s>]*)?)/gi,
          /"(?:video_url|videoUrl|video_src|source|src|url|mp4)"\s*:\s*"(https?:\/\/[^"]+\.(?:mp4|webm|mov)[^"]*)"/gi,
          /"(https?:\\\/\\\/[^"]*?\.mp4[^"]*)"/gi,
        ];
        let videoUrl = null;
        for (const pattern of videoPatterns) {
          const match = pattern.exec(atriaHtml);
          if (match?.[1]) {
            videoUrl = match[1].replace(/\\\//g, '/').replace(/&amp;/g, '&');
            break;
          }
        }
        if (videoUrl) {
          console.log(`[BriefPipeline] Found video in Atria page, transcribing: ${videoUrl.slice(0, 100)}`);
          return await transcribeWithGemini(videoUrl);
        }

        // Try extracting text content via Claude
        const extracted = await callClaude(
          'You are a text extraction tool for ad pages. Extract any ad copy, ad script, voiceover text, or sales copy from this HTML.',
          `Extract the main ad copy or script text from this Atria ad page. Return ONLY the ad text as plain text, no commentary. If you find a video transcript or ad copy, return it. If there is no readable ad text, respond with exactly "NO_CONTENT_FOUND".\n\nHTML (first 20000 chars):\n${atriaHtml.slice(0, 20000)}`,
          2000,
          { rawText: true },
        );
        if (extracted && extracted !== 'NO_CONTENT_FOUND' && extracted.length >= 50) {
          console.log(`[BriefPipeline] Extracted ${extracted.length} chars from Atria page`);
          return extracted;
        }
      }

      // Fallback: try Meta API with extracted ad ID
      const metaIdMatch = url.match(/\/m(\d+)/i) || url.match(/(\d{10,})/);
      if (metaIdMatch) {
        console.log(`[BriefPipeline] Atria page had no content, trying Meta API with ID: ${metaIdMatch[1]}`);
        return await extractFromMetaAdId(metaIdMatch[1]);
      }
    } catch (err) {
      console.warn(`[BriefPipeline] Atria extraction failed:`, err.message);
      // Try Meta API as last resort
      const metaIdMatch = url.match(/\/m(\d+)/i) || url.match(/(\d{10,})/);
      if (metaIdMatch) {
        return await extractFromMetaAdId(metaIdMatch[1]);
      }
    }
    throw new Error('Atria pages require a browser to load. Right-click the video on the Atria page → "Copy video address" and paste the direct video URL, or paste the ad script text manually.');
  }

  // Strategy 3: Direct media URL
  const isDirectMedia = /\.(mp4|mp3|wav|webm|m4a|ogg|mov)(\?|$)/i.test(url);
  if (isDirectMedia) {
    console.log(`[BriefPipeline] Direct media URL detected`);
    return await transcribeWithGemini(url);
  }

  // Strategy 4: Fetch HTML page
  const fetchRes = await fetch(url, {
    headers: { 'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36' },
    redirect: 'follow',
    signal: AbortSignal.timeout(15000),
  });
  const contentType = fetchRes.headers.get('content-type') || '';

  // If response is media, transcribe directly
  if (contentType.startsWith('audio/') || contentType.startsWith('video/')) {
    return await transcribeWithGemini(url);
  }

  const html = await fetchRes.text();

  // Strategy 5: Try to extract ad text from HTML
  if (html.length > 200) {
    const extracted = await callClaude(
      'You are a text extraction tool for ad pages.',
      `Extract the main ad copy, sales text, or video script from this HTML. If there is readable ad copy or sales text, return it as plain text. If the page is mostly JavaScript with no readable content, respond with exactly "NO_CONTENT_FOUND".\n\nHTML (first 15000 chars):\n${html.slice(0, 15000)}`,
      2000,
      { rawText: true },
    );
    if (extracted && extracted !== 'NO_CONTENT_FOUND' && extracted.length >= 50) {
      return extracted;
    }
  }

  // Strategy 6: Search HTML for video URLs → transcribe
  console.log(`[BriefPipeline] No text found, searching for video URLs in HTML`);
  const videoUrlPatterns = [
    /(?:src|href|data-src|data-video|content|url)\s*[=:]\s*["']?(https?:\/\/[^"'\s>]+\.(?:mp4|webm|m4v|mov)(?:\?[^"'\s>]*)?)/gi,
    /property=["']og:video["'][^>]*content=["'](https?:\/\/[^"']+)/gi,
    /content=["'](https?:\/\/[^"']+)["'][^>]*property=["']og:video/gi,
    /"(?:video_url|videoUrl|video_src|video_sd_url|video_hd_url|source|src|url)"\s*:\s*"(https?:\/\/[^"]+\.(?:mp4|webm|m4v)[^"]*)"/gi,
  ];

  let videoUrl = null;
  for (const pattern of videoUrlPatterns) {
    const match = pattern.exec(html);
    if (match?.[1]) { videoUrl = match[1]; break; }
  }

  if (videoUrl) {
    console.log(`[BriefPipeline] Found video URL in HTML: ${videoUrl.slice(0, 80)}...`);
    return await transcribeWithGemini(videoUrl);
  }

  // Strategy 7: Last resort — try yt-dlp on the original URL (works for many video platforms)
  console.log(`[BriefPipeline] Trying yt-dlp as last resort for: ${url.slice(0, 80)}`);
  const ytdlpVideoUrl = await extractVideoUrlWithYtdlp(url);
  if (ytdlpVideoUrl) {
    return await transcribeWithGemini(ytdlpVideoUrl);
  }

  throw new Error('Could not extract ad content from this URL. For video ads: right-click the video → "Copy video address" and paste the direct .mp4 link. Or use "Paste Text" to paste the script manually.');
}

// ── Extract video/text from Meta ad ID → transcribe if needed ────────
async function extractFromMetaAdId(adId) {
  if (!META_ACCESS_TOKEN) {
    throw new Error('META_ACCESS_TOKEN not configured. Try pasting the ad text manually.');
  }

  const errors = [];

  // Strategy A: Ad Library API (works for ANY public ad, not just yours)
  try {
    console.log(`[BriefPipeline] Trying Ad Library API for ad ${adId}`);
    const libUrl = `${META_GRAPH_URL}/ads_archive?ad_reached_countries=US&search_terms=*&ad_archive_id=${adId}&fields=ad_snapshot_url,ad_creative_bodies,ad_creative_link_titles,ad_creative_link_descriptions&limit=1&access_token=${META_ACCESS_TOKEN}`;
    const libRes = await fetch(libUrl, { signal: AbortSignal.timeout(15000) });
    const libData = await libRes.json();
    console.log(`[BriefPipeline] Ad Library response:`, JSON.stringify(libData).slice(0, 300));

    if (libData.data?.length) {
      const ad = libData.data[0];

      // Try text bodies first
      const bodies = ad.ad_creative_bodies || [];
      if (bodies.length && bodies[0].length > 20) {
        const titles = ad.ad_creative_link_titles || [];
        const descs = ad.ad_creative_link_descriptions || [];
        let fullText = bodies.join('\n\n');
        if (titles.length) fullText = `${titles[0]}\n\n${fullText}`;
        if (descs.length) fullText += `\n\n${descs[0]}`;
        console.log(`[BriefPipeline] Got ad text from Ad Library: ${fullText.length} chars`);
        return fullText;
      }

      // Try snapshot URL for video extraction
      if (ad.ad_snapshot_url) {
        console.log(`[BriefPipeline] Fetching ad snapshot: ${ad.ad_snapshot_url}`);
        const snapRes = await fetch(ad.ad_snapshot_url, {
          headers: { 'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36' },
          redirect: 'follow',
          signal: AbortSignal.timeout(15000),
        });
        const snapHtml = await snapRes.text();
        console.log(`[BriefPipeline] Snapshot HTML length: ${snapHtml.length}`);

        // Look for video URLs in snapshot (multiple patterns)
        const videoPatterns = [
          /"(?:sd_src_no_ratelimit|sd_src|hd_src|hd_src_no_ratelimit|video_url)"\s*:\s*"(https?:[^"]+)"/gi,
          /src=["'](https?:\/\/[^"']*?video[^"']*?\.mp4[^"']*)/gi,
          /src=["'](https?:\/\/[^"']*?\.mp4[^"']*)/gi,
          /"(https?:\\\/\\\/[^"]*?\.mp4[^"]*)"/gi,
        ];

        let videoSrc = null;
        for (const pattern of videoPatterns) {
          const match = pattern.exec(snapHtml);
          if (match?.[1]) {
            videoSrc = match[1].replace(/\\\//g, '/').replace(/&amp;/g, '&');
            break;
          }
        }

        if (videoSrc) {
          console.log(`[BriefPipeline] Found video in snapshot, transcribing: ${videoSrc.slice(0, 80)}...`);
          return await transcribeWithGemini(videoSrc);
        }

        // If no video found, try to extract any text content from snapshot
        const snapText = await callClaude(
          'You are a text extraction tool.',
          `Extract any ad copy, script text, or spoken dialogue from this HTML page. Return only the text, no commentary. If no ad text is found, respond "NO_CONTENT_FOUND".\n\nHTML:\n${snapHtml.slice(0, 15000)}`,
          2000,
          { rawText: true },
        );
        if (snapText && snapText !== 'NO_CONTENT_FOUND' && snapText.length > 30) {
          return snapText;
        }
      }
    } else {
      errors.push(`Ad Library: ${libData.error?.message || 'No results found'}`);
    }
  } catch (err) {
    errors.push(`Ad Library: ${err.message}`);
    console.warn(`[BriefPipeline] Ad Library API failed:`, err.message);
  }

  // Strategy B: Try your own ad accounts (works for your own ads)
  for (const accountId of META_AD_ACCOUNT_IDS) {
    try {
      const searchUrl = `${META_GRAPH_URL}/${accountId}/ads?fields=name,creative.fields(thumbnail_url,video_id,body,title,link_description)&filtering=[{"field":"ad.id","operator":"EQUAL","value":"${adId}"}]&limit=5&access_token=${META_ACCESS_TOKEN}`;
      const searchRes = await fetch(searchUrl, { signal: AbortSignal.timeout(10000) });
      const searchData = await searchRes.json();

      if (searchData.data?.length) {
        const creative = searchData.data[0].creative || {};
        if (creative.body && creative.body.length > 20) {
          let fullText = creative.body;
          if (creative.title) fullText = `${creative.title}\n\n${fullText}`;
          return fullText;
        }
        if (creative.video_id) {
          // Use advideos endpoint (ad account scope) — /{video_id}?fields=source fails with Marketing API tokens
          const vidRes = await fetch(
            `${META_GRAPH_URL}/${accountId}/advideos?filtering=[{"field":"id","operator":"EQUAL","value":"${creative.video_id}"}]&fields=source&limit=1&access_token=${META_ACCESS_TOKEN}`,
            { signal: AbortSignal.timeout(10000) }
          );
          const vidData = await vidRes.json();
          const videoSource = vidData.data?.[0]?.source;
          if (videoSource) return await transcribeWithGemini(videoSource);
        }
      }
    } catch (err) {
      errors.push(`Account ${accountId}: ${err.message}`);
    }
  }

  // Strategy C: Try fetching the FB Ad Library page directly and scraping
  try {
    console.log(`[BriefPipeline] Trying direct FB Ad Library page fetch`);
    const fbPageUrl = `https://www.facebook.com/ads/library/?id=${adId}`;
    const fbRes = await fetch(fbPageUrl, {
      headers: {
        'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
        'Accept': 'text/html,application/xhtml+xml',
        'Accept-Language': 'en-US,en;q=0.9',
      },
      redirect: 'follow',
      signal: AbortSignal.timeout(15000),
    });
    const fbHtml = await fbRes.text();

    // Try to find video in the page
    const vidMatch = fbHtml.match(/"(?:sd_src_no_ratelimit|sd_src|hd_src)"\s*:\s*"(https?:[^"]+)"/i);
    if (vidMatch?.[1]) {
      const videoSrc = vidMatch[1].replace(/\\\//g, '/').replace(/&amp;/g, '&');
      console.log(`[BriefPipeline] Found video in FB page, transcribing`);
      return await transcribeWithGemini(videoSrc);
    }

    // Try to extract text from the page
    const fbText = await callClaude(
      'You are a text extraction tool.',
      `Extract any ad copy or text content from this Facebook Ad Library page HTML. Return only the ad text, no commentary. If no text found, respond "NO_CONTENT_FOUND".\n\nHTML:\n${fbHtml.slice(0, 20000)}`,
      2000,
      { rawText: true },
    );
    if (fbText && fbText !== 'NO_CONTENT_FOUND' && fbText.length > 30) {
      return fbText;
    }
  } catch (err) {
    errors.push(`Direct FB page: ${err.message}`);
  }

  throw new Error(`Could not extract ad ${adId}. Right-click the video → "Copy video address" and paste the direct .mp4 link, or paste the script text manually.`);
}

// ── Fetch product profile from DB ────────────────────────────────────
async function fetchProductProfile(productCode) {
  try {
    const rows = await pgQuery(
      `SELECT * FROM product_profiles WHERE LOWER(short_name) = LOWER($1) OR LOWER(product_code) = LOWER($1) OR LOWER(name) ILIKE '%' || LOWER($1) || '%' ORDER BY updated_at DESC LIMIT 1`,
      [productCode || 'MR']
    );
    if (!rows.length) {
      console.warn(`[BriefPipeline] No product profile found for code: ${productCode || 'MR'}`);
      return null;
    }
    const p = rows[0];
    // Parse JSONB fields
    for (const f of ['product_images', 'logos', 'fonts', 'brand_colors', 'benefits', 'angles', 'scripts', 'offers']) {
      if (p[f] && typeof p[f] === 'string') try { p[f] = JSON.parse(p[f]); } catch {}
    }
    return p;
  } catch (err) {
    console.error(`[BriefPipeline] fetchProductProfile error for ${productCode}:`, err.message);
    return null;
  }
}

function buildProductContextForBrief(p) {
  if (!p) return 'No product profile available.';
  const lines = [
    // ── Core Identity ──
    p.name             && `Product: ${p.name}`,
    p.product_code     && `Product Code: ${p.product_code}`,
    p.short_name       && `Short Name: ${p.short_name}`,
    p.description      && `Description: ${p.description}`,
    p.oneliner         && `One-Liner: ${p.oneliner}`,
    p.tagline          && `Tagline: ${p.tagline}`,
    p.product_type     && `Product Type: ${p.product_type}`,
    p.product_group    && `Product Group: ${p.product_group}`,
    p.category         && `Category: ${p.category}`,
    // ── Pricing & Offer ──
    p.price            && `Price: ${p.price}`,
    p.product_url      && `Product URL: ${p.product_url}`,
    p.unit_details     && `Unit Details: ${p.unit_details}`,
    p.offer_details    && `Offer Details: ${p.offer_details}`,
    p.max_discount     && `Max Discount: ${p.max_discount}`,
    p.discount_codes   && `Discount Codes: ${p.discount_codes}`,
    p.bundle_variants  && `Bundle Variants: ${p.bundle_variants}`,
    p.offers?.length   && `Active Offers: ${Array.isArray(p.offers) ? p.offers.map(o => o.name || o.title || o.text || JSON.stringify(o)).join('; ') : p.offers}`,
    p.guarantee        && `Guarantee: ${p.guarantee}`,
    // ── Persuasion Engine ──
    p.big_promise      && `Big Promise: ${p.big_promise}`,
    p.mechanism        && `Unique Mechanism: ${p.mechanism}`,
    p.differentiator   && `Differentiator: ${p.differentiator}`,
    p.competitive_edge && `Competitive Edge: ${p.competitive_edge}`,
    p.benefits?.length && `Key Benefits: ${Array.isArray(p.benefits) ? p.benefits.map(b => b.text || b.name || b).join(', ') : p.benefits}`,
    // ── Audience ──
    p.customer_avatar  && `Target Customer: ${p.customer_avatar}`,
    p.customer_frustration && `Customer Frustration: ${p.customer_frustration}`,
    p.customer_dream   && `Customer Dream Outcome: ${p.customer_dream}`,
    p.target_demographics && `Target Demographics: ${p.target_demographics}`,
    p.pain_points      && `Pain Points: ${p.pain_points}`,
    p.common_objections && `Common Objections: ${p.common_objections}`,
    // ── Brand & Voice ──
    p.voice            && `Brand Voice/Tone: ${p.voice}`,
    // ── Angles & Strategy ──
    p.winning_angles   && `Winning Angles: ${p.winning_angles}`,
    p.custom_angles_text && `Custom Angles: ${p.custom_angles_text}`,
    p.angles?.length   && `Proven Angles: ${Array.isArray(p.angles) ? p.angles.map(a => a.name || a).join(', ') : p.angles}`,
    // ── Proven Scripts (for style reference) ──
    p.scripts?.length  && `Proven Scripts: ${Array.isArray(p.scripts) ? p.scripts.slice(0, 3).map((s, i) => `[${i + 1}] ${(typeof s === 'string' ? s : (s.text || s.body || JSON.stringify(s))).slice(0, 200)}`).join('\n') : p.scripts}`,
    // ── Compliance ──
    p.compliance_restrictions && `COMPLIANCE — Never claim: ${p.compliance_restrictions}`,
    p.notes            && `Notes: ${p.notes}`,
  ].filter(Boolean);
  const base = lines.join('\n');

  // Full master brief — the operator's complete product document (angles with
  // full strategy, mechanism, avatar deep-dive, offer structure). The distilled
  // fields above are a summary; generation quality depends on the model seeing
  // 100% of this. Appended last so the structured fields stay scannable.
  if (p.master_brief && String(p.master_brief).trim()) {
    return `${base}\n\n===== MASTER PRODUCT BRIEF — FULL DOCUMENT (primary source of truth) =====\n\n${String(p.master_brief).trim()}`;
  }
  return base;
}

// ── Claude Prompts ────────────────────────────────────────────────────

async function buildScriptParserPrompt(rawScript, taskName) {
  // If the raw input is very short or looks like metadata (product name, price), skip hook extraction
  const isMetadataLike = rawScript.length < 150 || /^[A-Z][\w\s]+[-–]\s*(Only\s*)?\$[\d.]+/i.test(rawScript.trim());

  let system = `You are a script parser for video ad briefs. Extract the structured components from the raw script text below.${isMetadataLike ? ' NOTE: The input appears to be brief ad copy or metadata, NOT a full script. Put the entire text in the body field. Do NOT invent or fabricate hooks that are not explicitly present.' : ''}`;
  let user = `RAW SCRIPT:
${rawScript}

TASK NAME: ${taskName}

Extract and return ONLY valid JSON:
{
  "hooks": [
    {
      "id": "H1",
      "text": "the full hook text",
      "mechanism": "fear" | "curiosity" | "social_proof" | "authority" | "controversy" | "shock" | "question" | "statistic" | "story" | "challenge",
      "length": "short" | "medium" | "long"
    }
  ],
  "body": "the full body script text, preserving paragraphs",
  "cta": "the call-to-action text if present",
  "format_notes": "any production notes, visual directions, or format instructions",
  "estimated_length_seconds": number,
  "villains": ["list of enemies/villains mentioned"],
  "proof_elements": ["list of proof mechanisms used"],
  "offer_mentioned": true/false,
  "discount_code_used": "MINER10" or null
}

RULES:
- Hooks are usually labeled H1, H2, H3 or Hook 1, Hook 2, Hook 3 or numbered
- If hooks aren't explicitly labeled: AT MOST the first sentence qualifies as a hook, and ONLY if it is a true pattern-interrupt ("Why you have flabby arms after 40."). If the script opens directly with narrative or story ("I was shopping for a dress for my daughter's graduation…"), there are NO unlabeled hooks — return an empty hooks array and start the body at sentence one.
- BODY COMPLETENESS (hard rule): the body must be the COMPLETE playable script — from the first narrative/story/argument sentence through the last line before the CTA. Extracting a hook must NEVER remove story content from the body. If in doubt whether a sentence is hook or body, it is body. Never drop sentences between the hook and the body.
- The CTA is ONLY the final click-instruction lines (e.g. "Click below to get X at 60% off") — scarcity/urgency passages before it ("check if it's still in stock…") belong in the body.
- Preserve the exact wording — do NOT paraphrase or rewrite
- If the script has multiple sections (e.g. "Body:", "CTA:"), respect those boundaries

HOOK vs BODY TEXT — CRITICAL DISTINCTION:
A HOOK is the first thing a viewer sees/hears that makes them STOP SCROLLING. It must be:
- A pattern interrupt: surprising, jarring, curiosity-inducing, or emotionally charged
- Short and punchy: typically 1-2 sentences MAX (under 25 words ideal, never more than 40)
- Self-contained: makes sense on its own without needing the body for context
- A scroll-stopper: the FIRST FEW WORDS must create an immediate reason to keep watching

A HOOK is NOT:
- An explanation, comparison, or data point (that's body text)
- A sentence that builds on a previous hook (that's continuation/body)
- Multiple sentences that form a logical argument (that's a body paragraph)
- Social proof setup text — ANY sentence following the pattern "[Number] people did X" or "Over X people have Y" is social proof, NOT a hook, even if it is short. Examples: "47,000 Americans started mining from home" = body. "Over 100,000 units sold" = body. "Last month 12,000 people joined" = body. Social proof establishes credibility — it does not interrupt scrolling.
- A comparison like "X gives you Y, but this gives you Z" (that's a body contrast point)

If the script has text labeled as "hooks" but some are actually body-length paragraphs or explanatory text, classify them correctly:
- TRUE hooks → hooks array
- Mislabeled hooks (actually body/comparison/explanation text) → prepend to body text
- If only 1-2 of 4 labeled "hooks" are real hooks, put only the real ones in hooks array

WORD COUNT ENFORCEMENT:
- Count the words in each candidate hook. If it is 20 words or more, it is almost certainly body text. Move it to the body. The ideal hook is under 15 words.
- A hook with multiple sentences joined by periods that together reach 20+ words is body text, not a hook.
- Even if the mechanism appears to be "statistic" or "data point", if it is a multi-sentence comparison or explanation of 20+ words, it goes in the body.
- Maximum hooks in the array: 3. If the script has more than 3 labeled hooks, keep only the top 1-3 strongest scroll-stoppers (shortest, punchiest, most surprising). Move the rest to body.

TONE CHECK (applies even if word count passes):
- If the text reads like a factual statement, explanation, or narrative setup rather than a pattern interrupt, it is body text regardless of word count.
- Example body text that FAILS tone check: "The average American family spends $37 per month on lottery tickets" — this is an explanatory fact, not a scroll-stopper.
- Example hook that PASSES tone check: "Your bank is robbing you blind." — this is a provocative pattern interrupt.

STATISTIC / DATA POINT RULE:
- A statistic or data comparison spanning 2 or more sentences is ALWAYS body text, never a hook — even if it is labeled as a hook.
- A single shocking stat CAN be a hook ONLY if it is one short sentence under 15 words (e.g. "Bitcoin just hit $100K." or "97% of mining rigs are scams.").
- If a "statistic" hook contains verifiable numbers PLUS an explanation or comparison, it is body text. Move it.
- The "mechanism" field value "statistic" does NOT override the word count or sentence count rules above.`;

  return { system, user };
}

// ---------------------------------------------------------------------------
// 1:1 SCRIPT CLONE — Dedicated prompt for cloning competitor scripts
// ---------------------------------------------------------------------------

// scriptIteration v1 — designed with operator 2026-05-29.
// Pulls one or more controlled levers on a proven winner. Concept (angle),
// product, mechanism, and CTA structure are LOCKED. Only the vectors the
// user selects move. Every card = 1 body + 5 hooks + 1 CTA. Card output
// carries a single what_changed string — no other metadata.
const DEFAULT_ITERATION_PROMPT_SYSTEM = `You are a senior performance copywriter who iterates on PROVEN winning ad scripts. Your job is NOT to write new ads — it's to preserve the persuasion engine that's already converting and pull specific controlled levers so the user can read performance and know which lever lifted. You think in LEVERS, not REWRITES. Every iteration changes ONLY what the user explicitly selected — never more, never less. The angle stays. The product stays. The CTA structure stays. Everything else can move within the bounds of what the user requested. You write like a real performance media buyer: raw, direct, no marketing-speak, no AI tells, no filler. Contractions, fragments, real talk. You match the original script's voice exactly. You NEVER soften, hedge, add disclaimers, or invent claims not supported by the product profile.`;

const DEFAULT_ITERATION_PROMPT_USER = `# MISSION
Generate {{NUM_VARIATIONS}} iteration cards of the winning script below. Each card pulls exactly the levers the user selected — nothing more.

# OUR PRODUCT (Product Library — single source of truth)
{{PRODUCT_CONTEXT}}

# AVAILABLE FORMATS
{{FORMATS_LIST}}

# AVAILABLE AVATARS / POVs
{{AVATARS_LIST}}

# SELECTED ITERATION VECTORS (what the user wants to change)
{{VECTORS_SELECTED}}

# THE ORIGINAL WINNING SCRIPT
{{REFERENCE_TRANSCRIPT}}

# ORIGINAL ON-SCREEN TEXT  (burned-in overlays from the winning video — if any)
{{ORIGINAL_ON_SCREEN_TEXT}}

# PERFORMANCE CONTEXT (why this is winning)
{{PERFORMANCE_CONTEXT}}

# LOCKED IDENTITY (NEVER change these in any iteration card)
- Angle: {{ANGLE_LOCKED}} (preserved exactly — this is the proven concept)
- Product, mechanism, big_promise: as defined in the Product Library
- CTA structure: same urgency type / soft type / direct type as original

If {{ANGLE_LOCKED}} is unknown, infer the angle from the original script and state your inference in the first card's what_changed field.

# ITERATION RULES (non-negotiable)

## 1. ONE CARD = 1 body + 5 hooks + 1 CTA
This is the production unit. Every iteration card is a complete ad package.

## 2. CHANGE ONLY WHAT WAS REQUESTED
- If only Hooks is selected: body must be IDENTICAL to original. CTA identical. Only the 5 hooks change.
- If Hooks + Avatar (POV X) is selected: change the hooks AND rewrite the body in POV X's voice. Don't touch length, format, proof, or anything else.
- If Avatar alone is selected: rewrite body in the target POV. Hooks change only as needed to match new pronoun / voice. Length, proof, CTA structure stay.
- If Format alone is selected: adapt body to the target format's pacing rules. Same beats, same proof, same CTA — just delivered in the new format's vehicle.
- If Length Compression is selected: cut to the target ratio. Preserve every beat in the same order — just shorter.
- If Proof Lead is selected: rotate which proof element leads. Body sequence stays. Only the proof opener changes.
- If Opening 3s is selected: rewrite ONLY the first sentence of the body and adjust H1 to match. Everything from second 2 onwards is identical.
- Multi-vector selection: stack the changes. NEVER touch a vector the user did not select.

## 3. ANGLE LOCK (HARDEST CONSTRAINT)
The angle is what makes this script win. It CANNOT change in any iteration. Every card must read the same angle as the original. If the original is Anti-Fake / Competitor Callout, every iteration is still Anti-Fake / Competitor Callout — just delivered differently.

## 4. CARD DIFFERENTIATION (when N > 1)
Every card must be MEANINGFULLY different from the others. Within the selected vectors:
- Hooks-only: each card uses a different hook MECHANISM family (Card 1 = pain / fear hooks, Card 2 = contrarian hooks, Card 3 = curiosity hooks, Card 4 = social-proof hooks, Card 5 = authority hooks)
- Format Swap (no secondary target specified): rotate through the available formats — one card per format
- Format Swap (with secondary target locked): all cards stay in the locked format but vary body phrasing + hooks
- Avatar Pivot (no secondary target): rotate through available avatars
- Avatar Pivot (with secondary target locked): all cards stay in the locked avatar but vary phrasing
- Length Compression: vary the compression ratio per card (e.g., Card 1 = 85%, Card 2 = 75%, Card 3 = 65%)
- Proof Lead Swap: vary which proof leads per card
Never produce two cards that read as the same iteration with synonym swaps.

## 5. PRESERVATION DURING ITERATION
When iterating on hooks only: body must be LITERALLY identical to original.
When iterating on avatar / format / length / proof: body adapts BUT preserves the original beat sequence, the proof claims, the mechanism explanation, the CTA logic.
Never introduce new claims or remove proof points unless the selected vector requires it.

## 6. PERFORMANCE-AWARE ITERATION
Use the PERFORMANCE CONTEXT block above to inform iteration choices:
- High CTR but low conversion → don't iterate on hooks. Iterate on body / proof.
- Low CTR but high conversion when watched → iterate on hooks aggressively.
- Long watch time but low CTR → iterate on opening 3 seconds or hooks.
- Short watch time → iterate on length compression or opening.

## 7. VOICE LOCK (anti-AI)
Match the original's voice exactly:
- Contractions where original uses them
- Sentence fragments where original uses them
- BANNED openers: "Imagine", "Picture this", "In a world where", "What if I told you", "Did you know"
- BANNED transitions: "But here's the thing", "Now here's where it gets interesting", "And that's not all", "Let me explain"
- BANNED softeners: "may", "might", "could potentially", "helps you to" (unless original uses them)
- Use real-person verbal tics where original uses them: "Look," / "Listen," / "Honestly," / "The truth is,"

## 8. PRODUCT INTEGRITY
Never introduce claims not supported by the Product Library. Never remove the mechanism or big_promise. Respect compliance_restrictions from the library — never make claims the product can't legally make.

## 9. ON-SCREEN TEXT / HIGHLIGHTED LABELS  (CONDITIONAL — driven by ORIGINAL ON-SCREEN TEXT block above)
The winning script may have **burned-in on-screen text overlays** — short, bold labels framing the video (top discount banners, framed comment-reply quotes, ALL-CAPS sticker text, urgency banners). These are graphics, NOT spoken.

### What qualifies as a highlighted label vs a hook
A LABEL is short (≤6 words), attention-grabbing, sticker-style, often ALL CAPS with a trailing emoji, frequently a fragment with no verb. A HOOK is a full first-person sentence the speaker delivers (8–25 words, sentence case, complete grammar). They live in different output fields.

### Rule (3-way decision)
- **Source of truth #1: the ORIGINAL ON-SCREEN TEXT block above.** Inspect every line.
- **The block contains ANY text other than the "no on-screen text detected" sentinel** → every card MUST return between 2 and 4 labels. Pick the lines that read most like banners/stickers/framing. If none look perfectly banner-style, take the shortest, punchiest, most attention-grabbing lines — those are the designer-targeted overlays.
- **The block contains the "no on-screen text detected" sentinel** → consult the winning script as a fallback signal. Apply the OVERLAY-SIGNAL CHECK: count time-bound promo wording, offer constructions ("buy N get N", "% off"), urgency triggers, framing devices (apology, comment-reply, "as seen on"), price callouts, imperative CTAs.
  - **≥ 2 signals → infer 2-4 overlay candidates** per card from the strongest signals. Mark highlighted_text_notes accordingly.
  - **0-1 signals → emit highlighted_text: []** (clean talking-head testimonial probably has no overlays).
- Each output label: ≤ 5 words, ALL CAPS where source uses caps, 1 emoji at end. Preserve role (banner stays banner, comment-reply stays comment-reply, apology stays apology).
- Vary the wording across iteration cards only if the selected vector calls for it. Otherwise keep labels consistent.
- A hook is NEVER an overlay label. ALL-CAPS sticker fragments belong in highlighted_text, not in hooks.

# OUTPUT — return ONLY valid JSON, no markdown fences, no preamble:

{
  "iterations": [
    {
      "what_changed": "one sentence — what's different vs the original (e.g. 'Founder POV with 5 fresh fear-trigger hooks; body adapted to first-person founder voice')",
      "hooks": [
        { "id": "H1", "text": "..." },
        { "id": "H2", "text": "..." },
        { "id": "H3", "text": "..." },
        { "id": "H4", "text": "..." },
        { "id": "H5", "text": "..." }
      ],
      "body": "the full body of this iteration card",
      "cta": "the CTA — same structure as original, only wording adapts if needed",
      "highlighted_text": [
        "ON-SCREEN LABEL 1 + emoji",
        "ON-SCREEN LABEL 2 + emoji"
      ]
    }
  ]
}`;

// Default formats + avatars used when the Product Library doesn't define them.
// User can override per-product by adding formats[] + avatars[] arrays to
// product_profiles, same pattern as angles[].
const DEFAULT_FORMATS = [
  { name: 'Mashup',             description: 'Edited cutdown of multiple clips' },
  { name: 'Short Video',        description: 'Single-shot vertical ≤30s' },
  { name: 'UGC Selfie',         description: 'Phone-camera testimonial style' },
  { name: 'Studio Testimonial', description: 'Lit, framed, scripted testimonial' },
  { name: 'Voiceover',          description: 'B-roll + scripted voiceover' },
  { name: 'GIF',                description: 'Animated / GIF-style edit with overlays' },
  { name: 'Cartoon',            description: '2D illustrated explainer style' },
];
const DEFAULT_AVATARS = [
  { name: 'Founder POV',          description: 'First-person from the founder / CEO' },
  { name: 'Customer Testimonial', description: 'Verified customer telling their story' },
  { name: 'Skeptic-Converted',    description: 'Former doubter explaining what changed their mind' },
  { name: 'Expert / Authority',   description: 'Industry expert or domain authority' },
  { name: 'Creator (UGC)',        description: 'Paid creator delivering script in their voice' },
];

// ── Avatar + Angle auto-detection ────────────────────────────────────
// Classifies an ad transcript against the product's own avatar/angle
// catalog so the naming convention gets ` - Menopause - Fear ` instead
// of ` - NA - NA `. Uses Haiku (~1s, ~$0.0005/call) — cheap enough to
// run on every batch job without adding cost.
//
// Returns { avatar, angle } — either may be null if we couldn't resolve
// to a valid catalog entry. Callers fall back to 'NA' in that case.
async function detectAvatarAndAngle({ transcript, headline, productProfile }) {
  const resolveArr = (raw, fallback) => {
    let a = raw;
    if (typeof a === 'string') { try { a = JSON.parse(a); } catch { a = null; } }
    return Array.isArray(a) && a.length > 0 ? a : fallback;
  };
  const avatars = resolveArr(productProfile?.avatars, DEFAULT_AVATARS);
  const angles  = resolveArr(productProfile?.angles, []);
  if (!avatars.length && !angles.length) return { avatar: null, angle: null };

  const clean = String(transcript || '').slice(0, 4000);
  if (!clean.trim()) return { avatar: null, angle: null };

  const sys = 'You classify a video-ad transcript. First decide the FUNNEL STAGE: is the ad primarily a BOTTOM-of-funnel OFFER ad — its main job is selling a discount, sale, limited-time deal, price drop, coupon, or scarcity to someone who already knows the product (little or no problem-education / mechanism / story) — or is it TOP/MIDDLE (educates on the problem, explains the mechanism, tells a founder/customer story, builds authority)? Then pick the single best-matching avatar and angle from the catalogs. Names MUST match a catalog entry exactly, character-for-character. Respond with strict JSON only: {"funnel":"bottom"|"top_or_middle","avatar":"<name>","angle":"<name>"}. Use null for avatar/angle if nothing fits.';

  const avatarsBlock = avatars.map(a => `- ${a.name}${a.description ? `: ${a.description}` : ''}`).join('\n');
  const anglesBlock  = angles.length
    ? angles.map(a => `- ${a.name}${a.description ? `: ${a.description}` : ''}`).join('\n')
    : '(no product angles defined — return null for angle)';

  const user = `AVATAR CATALOG:\n${avatarsBlock}\n\nANGLE CATALOG:\n${anglesBlock}\n\nAD HEADLINE: ${headline || '(none)'}\n\nAD TRANSCRIPT:\n${clean}\n\nReturn strict JSON — no prose.`;

  let result;
  try {
    result = await callClaude(sys, user, 200, { fast: true });
  } catch (err) {
    console.warn('[BriefPipeline] avatar/angle detection failed:', err.message);
    return { avatar: null, angle: null };
  }

  // Bottom-of-funnel offer/promo ads get a fixed pairing per operator rule:
  // avatar "Product Aware", angle "Promo" (when those exist in the catalog).
  // This overrides the best-match so discount-led ads are always tagged
  // consistently instead of mis-detecting as a price/problem angle.
  if (String(result?.funnel || '').toLowerCase() === 'bottom') {
    const promoAvatar = avatars.find(a => a.name === 'Product Aware')?.name || null;
    const promoAngle  = angles.find(a  => a.name === 'Promo')?.name || null;
    if (promoAvatar || promoAngle) {
      return { avatar: promoAvatar, angle: promoAngle };
    }
  }

  // Model may return { avatar: 'name' } or wrap it in another object. Be
  // strict about matching against the catalog — hallucinated names get
  // rejected so the naming convention never contains garbage.
  const proposedAvatar = String(result?.avatar || '').trim();
  const proposedAngle  = String(result?.angle  || '').trim();
  const avatar = avatars.find(a => a.name === proposedAvatar)?.name || null;
  const angle  = angles.find(a  => a.name === proposedAngle)?.name  || null;
  return { avatar, angle };
}

async function buildIterationPrompt(parsedScript, productContext, performanceContext, numVariations, productProfile = null, vectorsSelected = null, angleLocked = null, rawTranscript = null) {
  // Load saved prompt or fall back to baked v1 defaults.
  let systemPrompt = DEFAULT_ITERATION_PROMPT_SYSTEM;
  let userTemplate = DEFAULT_ITERATION_PROMPT_USER;
  try {
    const saved = await getLeaguePrompts();
    const customRaw = saved?.scriptIteration?.json;
    if (customRaw && customRaw.trim()) {
      const obj = JSON.parse(customRaw);
      if (typeof obj?.user === 'string' && obj.user.trim())   userTemplate = obj.user;
      if (typeof obj?.system === 'string' && obj.system.trim()) systemPrompt = obj.system;
    }
  } catch (e) {
    console.warn('[BriefPipeline] scriptIteration league prompt load error — using v1 default:', e.message);
  }

  // Build the transcript view of the source script
  const transcript = parsedScript?.body
    ? `${(parsedScript.hooks || []).map((h, i) => `[H${i+1}] ${h.text || h}`).join('\n')}\n\n${parsedScript.body}\n\n${parsedScript.cta || ''}`.trim()
    : (parsedScript?.rawScript || '');

  // Resolve formats + avatars from Product Library, fall back to defaults.
  const resolveArr = (raw, fallback) => {
    let a = raw;
    if (typeof a === 'string') { try { a = JSON.parse(a); } catch { a = null; } }
    return Array.isArray(a) && a.length > 0 ? a : fallback;
  };
  const formats = resolveArr(productProfile?.formats, DEFAULT_FORMATS);
  const avatars = resolveArr(productProfile?.avatars, DEFAULT_AVATARS);
  const formatsList = formats.map(f => `- ${f.name}${f.description ? ` — ${f.description}` : ''}`).join('\n');
  const avatarsList = avatars.map(a => `- ${a.name}${a.description ? ` — ${a.description}` : ''}`).join('\n');

  // Build the SELECTED ITERATION VECTORS block. If nothing was passed, default
  // to "Hooks Only" (the safest most common iteration) so the prompt always
  // has a concrete instruction.
  let vectorsBlock;
  if (vectorsSelected && Array.isArray(vectorsSelected) && vectorsSelected.length > 0) {
    vectorsBlock = vectorsSelected.map(v => {
      if (typeof v === 'string') return `- ${v}`;
      const lines = [`- ${v.vector || v.name || 'Unknown vector'}`];
      if (v.target) lines.push(`  target: ${v.target}`);
      if (v.notes)  lines.push(`  notes: ${v.notes}`);
      return lines.join('\n');
    }).join('\n');
  } else {
    vectorsBlock = '- Hooks (refresh the 5 hooks with different mechanism families; body identical)';
  }

  const angleLockedStr = angleLocked && angleLocked !== 'NA' ? angleLocked : '(unknown — infer from original script and state your inference)';
  // On-screen overlays from the raw multimodal transcript. Empty string when
  // source has no overlays. See extractOnScreenText() above.
  const originalOnScreenText = extractOnScreenText(rawTranscript) || '(no on-screen text detected in source — emit empty highlighted_text)';

  const user = userTemplate
    .replace(/\{\{\s*REFERENCE_TRANSCRIPT\s*\}\}/g, transcript)
    .replace(/\{\{\s*ORIGINAL_ON_SCREEN_TEXT\s*\}\}/g, originalOnScreenText)
    .replace(/\{\{\s*PERFORMANCE_CONTEXT\s*\}\}/g, performanceContext || '(no live performance data attached)')
    .replace(/\{\{\s*PRODUCT_CONTEXT\s*\}\}/g, productContext || 'No product profile available.')
    .replace(/\{\{\s*NUM_VARIATIONS\s*\}\}/g, String(numVariations || 3))
    .replace(/\{\{\s*FORMATS_LIST\s*\}\}/g, formatsList)
    .replace(/\{\{\s*AVATARS_LIST\s*\}\}/g, avatarsList)
    .replace(/\{\{\s*VECTORS_SELECTED\s*\}\}/g, vectorsBlock)
    .replace(/\{\{\s*ANGLE_LOCKED\s*\}\}/g, angleLockedStr);

  return { system: systemPrompt, user };
}

// ───────────────────────────────────────────────────────────────────────────
// scriptClone — the editable default lives in the league_prompts store so
// the user can edit it via Settings → League Prompts. If empty, this baked
// inline default runs. Template variables (ALL_CAPS in {{}}) are substituted
// at call time. See buildScriptClonePrompt below for the substitution logic.
// ───────────────────────────────────────────────────────────────────────────
const DEFAULT_CLONE_PROMPT_SYSTEM = `You are a senior performance copywriter who clones winning ad scripts surgically. Your job is to preserve the persuasion architecture of a proven competitor script while swapping their product for ours. You think in terms of ARCHITECTURE (sequence, pacing, rhetorical devices, emotional beats) — not surface words. Every paragraph in the original maps to an equivalent paragraph in your clone, at the same length — length parity is part of the architecture, and a clone that comes back meaningfully shorter than its source has failed. You write like a real media buyer who has spent millions: raw, direct, no marketing-speak, no AI tells, no filler. Contractions, fragments, real talk. If the original sounds like someone ranting on TikTok, your clone rants on TikTok. If it sounds like a calm authority, your clone is a calm authority. You NEVER soften, hedge, or add disclaimers the original didn't have. You match the source's proof strength one-for-one — if the source cites a stat, a study, or an imaging result, your clone carries an equivalent at the same specificity, adapted to our product (the operator owns responsibility for all claims). You NEVER break the angle once it is selected — every sentence reinforces it.`;

const DEFAULT_CLONE_PROMPT_USER = `# MISSION
Study the competitor script below like a senior creative strategist, then rebuild it for OUR product: same narrative architecture, same emotional arc, same structure, same length, SAME SPECIFIC FRAMING — adapted intelligently to our product's world using the full product brief.

You are not following a swap table. You are doing what a top media buyer does when they clone a proven winner: first understand WHY it works, then rebuild every beat so it works just as hard for our product.

# THE ONE RULE ABOVE ALL (read twice)
DO NOT PARAPHRASE. This is surgical cloning, not "capture the gist / retell in your own words". Go sentence by sentence: keep each sentence's exact shape, wording, and specific hooks, changing ONLY the product noun, the product-category details, and our real numbers. The source's SPECIFIC framing — its sale event ("Black Friday"), its gimmick ("launched four months early by mistake"), its jokes ("the intern"), its exact offer structure ("normally $X, now Y% off, 24 hours") — is the creative and MUST survive word-for-word. If your output reads like a looser, blander retelling of the source rather than the same sentences with the product swapped, you have FAILED. A stranger reading your clone next to the source should see two ads that are line-for-line twins, differing only in product.

# OUR PRODUCT — MASTER BRIEF (your complete product knowledge; single source of truth for every fact)
{{PRODUCT_CONTEXT}}

# AVAILABLE ANGLES FOR OUR PRODUCT
{{ANGLES_LIST}}

# SELECTED ANGLE
angle_name: {{ANGLE_NAME}}
angle_details:
{{ANGLE_DETAILS}}

If angle_name = "AUTO": pick the angle that best fits the source's emotional register and proof structure; state the pick + one-line reason in angle_used. If a specific angle is given: lock to it — it colors tone, word choice, and emphasis, but it NEVER overrides the source's structure.

# ORIGINAL COMPETITOR SCRIPT (the proven winner you are cloning)
hooks: {{ORIGINAL_HOOKS}}
body: {{ORIGINAL_BODY}}
cta: {{ORIGINAL_CTA}}

# ORIGINAL ON-SCREEN TEXT  (burned-in overlays from the source video — if any)
{{ORIGINAL_ON_SCREEN_TEXT}}

# DEEP ANALYSIS OF THE ORIGINAL
{{ANALYSIS_CONTEXT}}

# HOW TO WORK — analyze first, then strategize, then write

## STEP 1 — ANALYZE THE SOURCE (emit as "source_read" — 2-3 sentences MAX, distilled)
Before writing a word, understand the machine you are cloning (think through ALL of this; emit only the distilled conclusion):
- What TYPE of ad is this? (third-person founder story / first-person testimonial / UGC rant / expert explainer / offer blast / apology / competitor callout / ...)
- POV and narrator: who is speaking, and why does the viewer believe them?
- Protagonist: what ROLE do they play (underdog inventor, burned customer, insider expert) and what makes them credible?
- Emotional arc: the beats in order, and where the pivot moment sits (rejection, confession, reveal, near-miss).
- Persuasion devices: named villains, proof points, credibility moments (Shark Tank, press, studies), scarcity, guarantee.
- SIGNATURE DEVICE: the one specific gimmick or framing that makes THIS ad memorable and IS the creative — the exact conceit the whole ad hangs on. Examples: "our Black Friday sale launched four months early by mistake and we can't take it back", "public apology / we lied", "reply to a hater's comment", "the intern leaked our price". Name it exactly. This is the #1 thing that must survive the clone intact — an ad that loses its signature device is a different, weaker ad.
- Why does this ad win? One or two sentences.

## STEP 2 — ADAPTATION STRATEGY (emit as "adaptation_plan" — 2-3 sentences MAX, distilled)
Decide how the machine rebuilds around OUR product (think through ALL of this; emit only the distilled plan):
- Protagonist recast: keep the ROLE and the full arc; choose the identity that is MOST CREDIBLE for our product's world and our avatar. Two college boys who built a pest device can become a menopausal plastic surgeon who built a breast-lift device — the role (rejected inventor) and every beat survive; the identity serves our product. Never carry over names, genders, or professions that make no sense in our category — and never invent an identity our master brief contradicts.
- Fact mapping: which master-brief facts power which beats (mechanism → the discovery beat, guarantee → the promise beat, our real offer → the CTA beat).
- KEEP THE SIGNATURE DEVICE VERBATIM: whatever you named as the signature device in STEP 1 is carried over word-for-word, only the product noun + our real numbers changed. If the source says "our Black Friday sale launched four months early by mistake and we can't take it back", the clone says "our Black Friday sale launched four months early by mistake and we can't take it back" (swap the product, keep everything else). Do NOT soften or genericize it: "Black Friday" stays "Black Friday" (NOT "anniversary sale" or "our sale"), "four months early" stays, "the intern" stays "the intern". These named events, seasonal promos (Black Friday, Cyber Monday, Memorial Day), specific jokes, and offer framings ARE the ad — treating them as competitor-specific and swapping them for generic wording is the single most common way to ruin a clone.
- Keep-verbatim list: culturally recognizable moments (Shark Tank, Forbes, "went viral") are structural gold — keep them literally unless truly impossible. Same for the source's transitions, rhetorical devices, and the exact OFFER STRUCTURE (if the source frames it as "normally $X, now Y% off for 24 hours", your clone uses the same "normally $OUR_PRICE, now OUR% off for 24 hours" frame — carry the discount-percentage framing, not just a bare price).
- PROOF PARITY: mirror the source's proof devices at FULL strength — one for one. If the source cites "60% firmness loss in two years", your clone carries an equally specific stat adapted to our product. If the source uses ultrasound imaging as a proof device, yours uses an equivalent clinical device. Use master-brief numbers where they exist; where they don't, craft proof of the SAME specificity and type as the source's (the operator takes full responsibility for claims). A proof beat that comes back vaguer or softer than the source's has failed — "significant improvement" is not a clone of "60% loss".

## STEP 3 — WRITE THE CLONE
- Enumerate the source beats first (emit "source_beats" with per-beat word counts), then write beat by beat against that list.
- LENGTH CONTRACT: the source body is {{ORIGINAL_WORD_COUNT}} words (roughly {{EXPECTED_BEATS}} beats). Your body MUST land between {{MIN_WORDS}} and {{MAX_WORDS}} words — the SAME length as the source, within 5% either way. Under the floor means you compressed beats (a clone at half length is a summary); over the ceiling means you padded or editorialized. Every beat gets exactly its source airtime — if the source spends 70 words on a scene, your equivalent scene gets ~70 words, not 90.
- Where a source sentence works for our product with only nouns swapped, carry it near-verbatim — that is good cloning, not lazy cloning. Where it cannot, rebuild the sentence to do the same job at the same length.
- CTA: a true CLONE of the source's close, adapted — carry over EVERY pressure device the source uses (scarcity, sell-out warnings, deadlines, "before inventory runs out", price anchors) adapted to our product, and layer our real offer facts (discount, price, guarantee, counterfeit/official-site warning) ON TOP. Never trade one of the source's urgency devices away for an offer fact — stack them. A close that drops the source's scarcity is not a clone of that close.

## HOOKS — written AFTER the body (emitted after it in the JSON)
A hook is the first line of the finished video, spoken by the SAME narrator as the body. THE BLEND TEST (this is the whole game): read the hook aloud, then the body's FIRST SENTENCE. They must read as two consecutive lines of ONE script — same narrator AND same thread. The body's first sentence must be the natural next thing this exact hook's speaker would say. If the hook opens a topic the body's first sentence does not continue (hook names a clinical mechanism but the body opens on an offer; hook promises a week-by-week result but the body opens on a mistake), that is a SEAM and the hook has FAILED, even when the voice matches. Blend is about the THREAD, not only the voice.
- Exactly 5 hooks. Full sentences, sentence case, no emoji, no ALL-CAPS. Each ≤ 20 words; H5 is the shortest punch, under 12.
- ALL FIVE must be speakable by the body's narrator. Third-person founder story → every hook is third-person founder framing. First-person testimonial → every hook is that person speaking. NEVER mix POVs across hooks or between hooks and body.
- THE 5 HOOKS ARE 5 WAYS THROUGH THE SAME DOOR, NOT 5 DIFFERENT DOORS. FIRST read the body's actual FIRST SENTENCE. Then write 5 hooks that each hand off straight into that exact sentence with no bridge line — every hook's final beat sets up precisely what that first sentence delivers. Vary them by EMOTIONAL ANGLE and PHRASING on the SAME setup, NEVER by topic: the blunt version, the contrarian version, the pain/callout version, the curiosity version, and the short punch. Do NOT open a hook on a subject the body's first sentence does not immediately continue (a clinical stat, a deep-mechanism fact, a week-by-week results timeline) — that is the single most common cause of a seam. Concrete test: if the body opens on "these two mistakes", ALL five hooks funnel into "these two mistakes" and the body's first sentence reads as the natural next line after each; they simply say it five different ways. A hook that is technically true and on-brand but leaves the body's first sentence sounding like a topic change has failed, no matter how punchy it is.
- H1 IS THE SOURCE'S SIGNATURE HOOK, READAPTED — never a brand-new invention. Before writing the other four, find the source's single strongest scroll-stopper: the ONE line that made this ad worth cloning. It may live in the spoken hooks, in the body's opening line, OR in a burned-in ALL-CAPS overlay (e.g. "EVERYTHING YOU'VE BEEN TOLD ABOUT FIRMING ARM SKIN"). Rewrite THAT hook for our product in spoken, sentence-case form and make it H1 — product noun and category swapped, its exact contrarian/curiosity/myth-bust shape kept otherwise. Example: "Everything you've been told about firming arm skin..." → "Everything you've been told about lifting sagging breasts...". When the source hands you a proven hook, cloning it as H1 is the whole point; do NOT discard it in favor of a fresh angle. An ALL-CAPS overlay that is a full contrarian clause (not a sticker fragment) is a HOOK for this purpose — readapt it into H1 as a spoken sentence, even though its label copy may also appear in highlighted_text. H2 through H5 are then the fresh alternative doors described below.
- Do not pre-spend the body's reveal, and do not reuse body sentences verbatim.
- NO HOOK MAY RESTATE THE BODY'S OPENING LINE — with ONE deliberate exception: H1 when it carries the readapted signature hook per the rule above. If the body would otherwise open on that same signature line, the BODY instead resumes on the NEXT beat, so H1 then the body's first sentence read as two consecutive, NON-repeating lines. For H2 through H5 the ban is absolute. The hooks are 5 different ways IN that all lead to the body's first sentence — never a verbatim copy of that sentence. This overrides the keep-signature-device-verbatim rule for the HOOKS only: even when the body opens ON the signature device (e.g. body starts "We spent a year planning our Black Friday sale. Our intern launched it this morning by accident."), NONE of the 5 hooks may be that opening line reworded, re-punctuated, or sentence-joined. The BODY keeps the signature opening word-for-word; the HOOKS are 5 alternative ways IN that lead to it (the intern's panic, the deadline, the price reveal, a customer's reaction, a blunt one-liner) — so that hook-then-body reads as two consecutive lines, never the same line twice. If H1 is your body's first sentence with the period swapped for "and", you have failed this rule.

# NON-NEGOTIABLE PRINCIPLES
- POV coherence is absolute: hooks, body, CTA — one narrator, start to finish.
- Product facts (name, mechanism, price, offer, guarantee) come from the MASTER BRIEF. Proof devices, stats, story elements, and testimonial characters are crafted to mirror the source's structure and specificity one-for-one (PROOF PARITY above — the operator owns responsibility for claims).
- Respect compliance_restrictions from the brief — flag anything borderline in compliance_notes.
- Never leave a competitor brand name, price, or offer in the output.
- VOICE (anti-AI): contractions always (don't, can't, it's, here's); sentence fragments where the source uses them; speak to one person, never "audiences". BANNED: "Imagine", "Picture this", "In a world where", "What if I told you", "Did you know", "But here's the thing", "Now here's where it gets interesting", "And that's not all", "Let me explain". No softeners ("may", "might", "could potentially") unless the source used them.
- NO DASHES OR HYPHENS. Never use the "-" character, em-dashes (—), or en-dashes (–) anywhere in hooks, body, or cta. Use periods, commas, or rewrite the sentence. Write compounds as separate words ("90 day guarantee" not "90-day", "board certified" not "board-certified").
- Never use any phrase in the selected angle's banned_phrases list.

# ON-SCREEN TEXT / HIGHLIGHTED LABELS  (CONDITIONAL — driven by ORIGINAL ON-SCREEN TEXT block above)
The competitor's ad may have **burned-in on-screen text overlays** — short, bold labels that frame the video (e.g. "BIGGEST Memorial Day SALE 🇺🇸 / Buy 3, Get 3 FREE", "PUBLIC APOLOGY 👁️ / WE LIED 🤥", "Reply to Drew_Posts's comment"). These are NOT spoken — they're displayed as graphics, banners, sticker text, or framed quote panels.

### What qualifies as a highlighted label vs a hook
A LABEL is short, attention-grabbing, sticker-style. A HOOK is a full first-person sentence the speaker delivers.

| Trait | Label (goes in highlighted_text) | Hook (goes in hooks) |
|---|---|---|
| Length | ≤ 6 words | Full sentence, 8–25 words |
| Tone | Banner / sticker / framing device | Spoken voice |
| Grammar | Fragment, often no verb | Subject + verb, complete |
| Caps | Frequently ALL CAPS | Sentence case |
| Emoji | 1 trailing emoji is normal | Rare |
| Examples | "PUBLIC APOLOGY 👁️", "WE LIED 🤥", "BIGGEST SALE 🇺🇸", "PROJECT REJECTED" | "I'm the founder of X, and what I'm about to announce could ruin our company." |

### Rule (3-way decision — read carefully)
- **Source of truth #1: the ORIGINAL ON-SCREEN TEXT block above.** Inspect every line.
- **The block contains ANY text other than the literal "no on-screen text detected" sentinel** → you MUST return between 2 and 4 labels. Empty is forbidden here. Pick the lines that read most like banners / stickers / framing devices and rewrite them. If you cannot find perfect banner-style lines, take the shortest, punchiest, most attention-grabbing lines and treat them as labels — these are the ones a designer would burn into the cut.
- **The block contains the literal "(no on-screen text detected in source — emit empty highlighted_text)" sentinel** → consult the spoken script below as a fallback signal. The transcription pipeline missed overlays for plenty of source ads but the spoken script still reveals whether the source has visual graphics. Apply the OVERLAY-SIGNAL CHECK:
  - SIGNALS (count them in ORIGINAL_BODY + ORIGINAL_HOOKS): explicit time-bound promo wording ("Memorial Day", "Today only", "Ends tonight", "Last chance"); offer constructions ("Buy N get N", "free with purchase", "% off", "save $X"); urgency triggers ("won't last", "going fast", "while stock lasts"); call-out / framing devices ("public apology", "we lied", "I owe you an apology", "reply to comment", "as seen on", "as featured in"); price callouts ($XX or code XXXX); imperative CTAs ("click below", "tap below", "link in bio").
  - **≥ 2 signals → infer 2-4 overlay candidates** from the strongest signals and emit them. These are the banners/stickers the source ad almost certainly burned in. Mark highlighted_text_notes = "Inferred from spoken script (no [ON-SCREEN TEXT] block in source)".
  - **0-1 signals → emit highlighted_text: []**. A clean talking-head testimonial with no offer/framing devices probably has no overlays. Don't fabricate.

### How to pick labels
- Examples of source → output:
  - "COLLEGE BOYS PROVES SHARK TANK WRONG ☠️" → "BITCOIN MINERS PROVE EXPERTS WRONG ☠️"
  - "BIGGEST Memorial Day SALE 🇺🇸" → "BIGGEST RESTOCK SALE 🇺🇸"
  - "Buy 3, Get 3 FREE" → "Buy 3, Get 1 FREE 🎁"
  - "PROJECT REJECTED" → "INDUSTRY REJECTED" (preserves the "told it couldn't be done" energy)
  - "PUBLIC APOLOGY 👁️" → "PUBLIC APOLOGY 👁️" (apology angle — keep the emoji, change brand context in adjacent labels)
  - "Reply to Drew_Posts's comment" → "Reply to @bitcoin_skeptic's comment" (preserves the framing device)
- Each output label: ≤ 5 words, ALL CAPS when the source uses caps, exactly 1 emoji at the end (carry the source's emoji if present, otherwise pick one matching the label's emotion). Preserve the ROLE (banner → banner, comment-reply → comment-reply, apology sticker → apology sticker).
- Swap competitor brand / product / offer to ours from {{PRODUCT_CONTEXT}}. Never copy competitor brand names, prices, or claims verbatim.
- **Hooks are NEVER overlay labels.** If you find yourself writing an ALL-CAPS fragment with an emoji as Hook 1, move it to highlighted_text and write a real sentence-form hook in its place.

# ORDER OF OPERATIONS (the JSON field order below is deliberate — write the fields in this order)
# 1. source_read — distilled source understanding (STEP 1, 2-3 sentences).
# 2. adaptation_plan — distilled rebuild decision (STEP 2, 2-3 sentences).
# 3. source_beats — enumerate the source with word counts.
# 4. body — write beat-by-beat, hitting each target_words. After writing, count
#    your words: below {{MIN_WORDS}} or above {{MAX_WORDS}}? Fix the beats BEFORE emitting.
# 5. cta — clone the source's close with ALL its pressure devices + our offer stacked on top.
# 6. hooks — LAST, so each one blends into the body you just wrote.
# Keep every meta field SHORT — the body and hooks are the product; everything
# else is scaffolding and costs generation time.

# OUTPUT — return ONLY valid JSON, no markdown fences, no preamble, no trailing commentary.
{
  "source_pov": "third-person-founder-narrative | first-person-testimonial | first-person-founder-confession | expert-explainer | speaker-direct-address | other",
  "source_read": "2-3 sentences: ad type, narrator + why the viewer believes them, the pivot moment, why this ad wins",
  "signature_device": "the ONE specific gimmick/framing this ad hangs on, stated exactly (e.g. 'Black Friday sale launched 4 months early by mistake, can't take it back'). You will carry this over word-for-word in the body, product swapped.",
  "adaptation_plan": "2-3 sentences: who the protagonist becomes and why that identity is most credible for our product; confirm the signature_device is kept verbatim; which source proof devices are mirrored and how",
  "source_beats": [
    { "n": 1, "beat": "one-sentence compression of this source beat (max 20 words)", "source_words": 74, "target_words": 74 }
  ],
  "body": "the full cloned body. One passage per entry in source_beats, in the same order, each at its target_words length. Double newlines between paragraphs. TOTAL between {{MIN_WORDS}} and {{MAX_WORDS}} words — count before emitting.",
  "cta": "the cloned close: every source pressure device adapted + our real offer stacked on top",
  "hooks": [
    { "id": "H1", "text": "..." },
    { "id": "H2", "text": "..." },
    { "id": "H3", "text": "..." },
    { "id": "H4", "text": "..." },
    { "id": "H5", "text": "... (shortest punch, under 12 words)" }
  ],
  "highlighted_text": [
    "ON-SCREEN LABEL 1 + emoji",
    "ON-SCREEN LABEL 2 + emoji"
  ],
  "highlighted_text_notes": "1 short sentence — evidence for overlays, or 'none detected'",
  "angle_used": { "name": "the angle name actually used", "reason": "one short sentence (only if AUTO was selected)" },
  "clone_fidelity_notes": "1 sentence, MUST include: 'source {{ORIGINAL_WORD_COUNT}} words -> clone N words' using your actual count",
  "compliance_notes": "borderline claims, or 'clean'"
}`;

// Extract the [ON-SCREEN TEXT] block from a raw multimodal transcript so we
// can pass it into the clone/iteration prompts as a dedicated variable.
// The script parser collapses transcripts down to hooks + body and discards
// the labeled section markers — by the time the clone prompt fires, all
// signal of on-screen overlays is gone. We grab it BEFORE parsing.
//
// Supports both shapes:
//   1) "[ON-SCREEN TEXT]\n... \n\n[AUDIO]..." — multimodal vertex transcript
//   2) Loose raw text — returns '' (no overlays detected).
function extractOnScreenText(rawTranscript) {
  if (!rawTranscript || typeof rawTranscript !== 'string') return '';
  // Match [ON-SCREEN TEXT] ... up to next [SECTION_TAG] or end-of-string
  const m = rawTranscript.match(/\[ON[- ]?SCREEN\s*TEXT\]\s*([\s\S]*?)(?:\n\n\[|\n\[|$)/i);
  if (!m) return '';
  return m[1]
    .split('\n')
    .map((s) => s.trim())
    .filter(Boolean)
    .join('\n')
    .slice(0, 2000); // hard cap so we don't blow the token budget
}

// Remove the [ON-SCREEN TEXT] block from a transcript, leaving only the
// spoken script. The on-screen overlay text (auto-caption word-soup:
// "exercise / moisturizers / that actually fix the problem / Doctor / ...")
// pollutes the reference "original script" and confuses the clone parser —
// the overlays are captured separately via extractOnScreenText() for the
// highlighted_text labels, so stripping them here loses nothing. Also drops
// the [AUDIO / VOICEOVER] / [AD COPY] section markers so the parser sees
// clean prose.
function stripOnScreenText(transcript) {
  if (!transcript || typeof transcript !== 'string') return transcript || '';
  let out = transcript;
  // Drop the whole [ON-SCREEN TEXT] block up to the next [SECTION] marker.
  out = out.replace(/\[ON[- ]?SCREEN\s*TEXT\]\s*[\s\S]*?(?=\n\s*\[[A-Z][^\]]*\]|$)/i, '');
  // Remove remaining section markers so the parser reads plain script.
  out = out.replace(/^\s*\[(AUDIO(?:\s*\/\s*VOICEOVER)?|VOICEOVER(?:\s+TRANSCRIPT)?|AD COPY)\]\s*/gim, '');
  return out.replace(/\n{3,}/g, '\n\n').trim();
}

// Strip hyphens and em/en dashes from generated ad copy. Operator rule: the
// copy must never contain the "-" sign (nor — / –). em/en dashes become
// commas (they act as sentence breaks); intra-word hyphens ("90-day",
// "board-certified") become spaces. Deterministic belt to the prompt rule —
// LLMs slip em-dashes in constantly, so we guarantee it post-generation.
function removeDashes(text) {
  if (!text || typeof text !== 'string') return text;
  let out = text
    .replace(/\s*[—–―]\s*/g, ', ')                 // em/en/horizontal-bar → comma
    .replace(/(\p{L}|\d)[-‐‑‒](\p{L}|\d)/gu, '$1 $2') // intra-word hyphen → space
    .replace(/[-‐‑‒]/g, ' ');                       // any remaining hyphen → space
  out = out
    .replace(/,\s*([.!?,;:])/g, '$1')  // ", ." → "."
    .replace(/\s+([.!?,;:])/g, '$1')   // stray space before punctuation
    .replace(/[ \t]{2,}/g, ' ');       // collapse runs of spaces
  return out.trim();
}

// Apply removeDashes across a generated brief's copy fields in place.
function stripDashesFromBrief(generated) {
  if (!generated || typeof generated !== 'object') return generated;
  if (typeof generated.body === 'string') generated.body = removeDashes(generated.body);
  if (typeof generated.cta === 'string') generated.cta = removeDashes(generated.cta);
  if (Array.isArray(generated.hooks)) {
    generated.hooks = generated.hooks.map((h) =>
      (h && typeof h.text === 'string') ? { ...h, text: removeDashes(h.text) } : h);
  }
  return generated;
}

async function buildScriptClonePrompt(parsedScript, deepAnalysis, productContext, productProfile = null, angle = null, rawTranscript = null) {
  const originalHooks = (parsedScript.hooks || [])
    .map(h => `${h.id}: ${h.text}`)
    .join('\n');
  // Pull on-screen text out of the raw source so the §7 rule has real
  // overlay evidence to work from. Empty string = no overlays.
  const originalOnScreenText = extractOnScreenText(rawTranscript);

  const { scriptDna, psychology, iterationRules } = deepAnalysis || {};

  // Build the section-by-section breakdown from DNA
  let sectionFlow = '';
  if (scriptDna?.structural_skeleton?.section_by_section?.length) {
    sectionFlow = scriptDna.structural_skeleton.section_by_section
      .map((s, i) => `  ${i + 1}. ${s}`)
      .join('\n');
  }

  let rhetoricalDevices = '';
  if (scriptDna?.structural_skeleton?.rhetorical_devices?.length) {
    rhetoricalDevices = scriptDna.structural_skeleton.rhetorical_devices.join(', ');
  }

  let hookFramework = scriptDna?.structural_skeleton?.hook_framework || '';
  let pacingRhythm = scriptDna?.structural_skeleton?.pacing_rhythm || '';
  let signaturePhrases = '';
  if (scriptDna?.structural_skeleton?.signature_phrases?.length) {
    signaturePhrases = scriptDna.structural_skeleton.signature_phrases.join(' | ');
  }

  // Emotional arc
  let emotionalArc = '';
  if (psychology?.emotional_arc) {
    const ea = psychology.emotional_arc;
    emotionalArc = `${ea.at_hook || '?'} → ${ea.after_problem || '?'} → ${ea.during_explanation || '?'} → ${ea.at_proof || '?'} → ${ea.before_cta || '?'} → ${ea.final_state || '?'}`;
  }

  // Audience info
  let audienceContext = '';
  if (psychology?.audience) {
    const aud = psychology.audience;
    audienceContext = [
      aud.who_is_this_for ? `Who: ${aud.who_is_this_for}` : '',
      aud.existing_beliefs ? `Beliefs: ${aud.existing_beliefs}` : '',
      aud.awareness_stage ? `Awareness: ${aud.awareness_stage}` : '',
      aud.skepticism_level ? `Skepticism: ${aud.skepticism_level}` : '',
    ].filter(Boolean).join('\n');
  }

  // Build the analysis context block from the deep-analysis fields (if present)
  const analysisContextLines = [];
  if (sectionFlow)       analysisContextLines.push(`SECTION-BY-SECTION FLOW:\n${sectionFlow}`);
  if (rhetoricalDevices) analysisContextLines.push(`RHETORICAL DEVICES: ${rhetoricalDevices}`);
  if (hookFramework)     analysisContextLines.push(`HOOK FRAMEWORK: ${hookFramework}`);
  if (pacingRhythm)      analysisContextLines.push(`PACING / RHYTHM: ${pacingRhythm}`);
  if (signaturePhrases)  analysisContextLines.push(`SIGNATURE PHRASES: ${signaturePhrases}`);
  if (emotionalArc)      analysisContextLines.push(`EMOTIONAL ARC: ${emotionalArc}`);
  if (audienceContext)   analysisContextLines.push(`AUDIENCE:\n${audienceContext}`);
  if (iterationRules?.must_keep?.length) analysisContextLines.push(`MUST KEEP: ${iterationRules.must_keep.join(' | ')}`);
  if (iterationRules?.can_swap?.length)  analysisContextLines.push(`CAN SWAP: ${iterationRules.can_swap.join(' | ')}`);
  if (iterationRules?.never_do?.length || iterationRules?.never_do)  analysisContextLines.push(`NEVER DO: ${Array.isArray(iterationRules.never_do) ? iterationRules.never_do.join(' | ') : iterationRules.never_do}`);
  const analysisContext = analysisContextLines.join('\n\n') || '(no deep analysis available — use the original script and product context to reason about structure)';

  // Resolve angle data from the product profile. The selected angle string
  // (e.g. "Anti-Fake / Competitor Callout") is matched against profile.angles
  // by name to pull the full hook_strategy / tone / copy_directives / etc.
  let anglesArr = [];
  if (productProfile?.angles) {
    let a = productProfile.angles;
    if (typeof a === 'string') { try { a = JSON.parse(a); } catch { a = []; } }
    if (Array.isArray(a)) anglesArr = a;
  }
  const anglesList = anglesArr.length > 0
    ? anglesArr.map(a => `- ${a.name} [${(a.funnel_stage || 'middle').toUpperCase()}]${a.tone ? ` — ${(a.tone || '').split('.')[0]}` : ''}`).join('\n')
    : '(no angles defined in the Product Library — fall back to neutral tone)';

  const angleName = angle && angle !== 'NA' ? angle : 'AUTO';
  let angleDetails = '(none — angle is AUTO; pick from the list above)';
  if (angleName !== 'AUTO') {
    const match = anglesArr.find(a => (a.name || '').toLowerCase() === angleName.toLowerCase());
    if (match) {
      const lines = [];
      if (match.funnel_stage)     lines.push(`funnel_stage: ${match.funnel_stage}`);
      if (match.hook_strategy)    lines.push(`hook_strategy: ${match.hook_strategy}`);
      if (match.lead_with)        lines.push(`lead_with: ${match.lead_with}`);
      if (match.tone)             lines.push(`tone: ${match.tone}`);
      if (match.copy_directives)  lines.push(`copy_directives:\n${match.copy_directives}`);
      if (Array.isArray(match.required_elements) && match.required_elements.length) lines.push(`required_elements:\n- ${match.required_elements.join('\n- ')}`);
      if (Array.isArray(match.headline_examples) && match.headline_examples.length) lines.push(`headline_examples:\n- ${match.headline_examples.join('\n- ')}`);
      if (Array.isArray(match.banned_phrases) && match.banned_phrases.length) lines.push(`banned_phrases (HARD ban):\n- ${match.banned_phrases.join('\n- ')}`);
      angleDetails = lines.join('\n');
    } else {
      angleDetails = `(angle name "${angleName}" not found in the Product Library — treat as a custom angle and reason from the name alone)`;
    }
  }

  // Load the editable scriptClone prompt from the league_prompts settings store.
  // Falls back to the baked DEFAULT_CLONE_PROMPT_SYSTEM / DEFAULT_CLONE_PROMPT_USER.
  let systemTemplate = DEFAULT_CLONE_PROMPT_SYSTEM;
  let userTemplate   = DEFAULT_CLONE_PROMPT_USER;
  try {
    const saved = await getLeaguePrompts();
    const raw = saved?.scriptClone?.json;
    if (raw && raw.trim()) {
      const obj = JSON.parse(raw);
      if (typeof obj?.system === 'string' && obj.system.trim()) systemTemplate = obj.system;
      if (typeof obj?.user   === 'string' && obj.user.trim())   userTemplate   = obj.user;
    }
  } catch (e) {
    console.warn('[BriefPipeline] scriptClone league prompt load error — using default:', e.message);
  }

  // Length contract numbers — the prompt enforces word-count parity with the
  // source, and LLMs only hit length targets when given explicit numbers.
  const sourceBodyText  = parsedScript?.body || '';
  const originalWordCount = sourceBodyText.trim() ? sourceBodyText.trim().split(/\s+/).length : 0;
  // Tight ±5% band — the operator wants clones at the SAME length as the
  // reference, not "up to 10% longer" (v6.1 allowed drift).
  const minWords      = Math.round(originalWordCount * 0.95);
  const maxWords      = Math.round(originalWordCount * 1.05);
  const expectedBeats = Math.max(4, Math.round(originalWordCount / 60));

  const vars = {
    PRODUCT_CONTEXT:  productContext || 'No product profile available.',
    ORIGINAL_HOOKS:   originalHooks || '(no hooks parsed)',
    ORIGINAL_BODY:    parsedScript?.body || '(empty body)',
    ORIGINAL_CTA:     parsedScript?.cta || '(no CTA)',
    ORIGINAL_ON_SCREEN_TEXT: originalOnScreenText || '(no on-screen text detected in source — emit empty highlighted_text)',
    ANALYSIS_CONTEXT: analysisContext,
    ANGLE_NAME:       angleName,
    ANGLE_DETAILS:    angleDetails,
    ANGLES_LIST:      anglesList,
    ORIGINAL_WORD_COUNT: originalWordCount,
    MIN_WORDS:        minWords,
    MAX_WORDS:        maxWords,
    EXPECTED_BEATS:   expectedBeats,
  };
  const substitute = (tpl) => Object.entries(vars).reduce(
    (acc, [k, v]) => acc.replace(new RegExp(`\\{\\{\\s*${k}\\s*\\}\\}`, 'g'), String(v ?? '')),
    tpl,
  );

  return { system: substitute(systemTemplate), user: substitute(userTemplate) };
}

// ── Hook-Body Blend Validation Agent ─────────────────────────────────
async function buildBlendValidationPrompt(generatedBrief) {
  const hooks = (generatedBrief.hooks || []).map(h => h.text).filter(Boolean);
  const body = generatedBrief.body || '';
  // The hook must hand off to the body's FIRST SENTENCE, so judge against that
  // (not the whole first paragraph). Split on the first sentence end; fall back.
  const flatBody = body.replace(/\s+/g, ' ').trim();
  const bodyFirstLine = (flatBody.match(/^.*?[.!?](\s|$)/)?.[0] || flatBody.slice(0, 160)).trim();

  let system = `You are a continuity editor for direct response ad scripts. You judge ONE thing: does the body's FIRST SENTENCE read as the natural next line right after each hook — same narrator AND same thread. A matching voice is NOT enough. If the hook opens a topic the first sentence does not continue, that is a seam and scores low.`;

  let user = `For each hook, read the hook, then immediately read the body's first sentence. Would one person say these two lines back to back, on the same thread, with no bridge line needed?

${hooks.map((h, i) => `HOOK ${i + 1}: "${h}"
→ BODY FIRST SENTENCE: "${bodyFirstLine}"`).join('\n\n')}

Score each hook on THREAD CONTINUITY, not voice:
- blend_score (1-10): 10 = the first sentence is obviously the next thing this speaker says (same setup, same subject). 5 = same voice but the subject JUMPS (e.g. the hook is about a deep clinical mechanism or a week-by-week results timeline, but the first sentence is about "two mistakes" or an offer). 1 = jarring disconnect.
- A hook that is punchy and on-brand but leaves the first sentence sounding like a topic change is a 4-5, NOT a 7.
- issue: null if score >= 8, else name the THREAD break in one sentence (what the hook set up vs what the body actually continues).
- fix_suggestion: null if score >= 8, else how to re-aim the HOOK so it funnels into the body's first sentence. NEVER suggest changing the body.

Return ONLY valid JSON:
{
  "hooks": [
    { "id": 1, "blend_score": 9, "issue": null, "fix_suggestion": null },
    { "id": 2, "blend_score": 5, "issue": "Hook opens on an 8mm collagen-depth mechanism, but the body's first sentence starts listing the two mistakes — different subject, so it reads as a topic change.", "fix_suggestion": "Re-aim the hook to tee up the two mistakes instead of the mechanism." }
  ],
  "overall_blend": 7.0,
  "pass": false
}

A brief PASSES only if overall_blend >= 7.5 AND no single hook scores below 7.`;


  return { system, user };
}

// ── Push to ClickUp ───────────────────────────────────────────────────

async function pushBriefToClickUp(generatedBrief, parentClickupTaskId, overrides = {}) {
  // Operator-provided overrides (from PushToClickupModal) take precedence
  // over the brief's stored values. Lets the operator pick a different
  // editor / avatar / angle / etc. at push time without mutating the brief row.
  const brief_number     = overrides.brief_number     ?? generatedBrief.brief_number;
  const product_code     = overrides.product_code     ?? generatedBrief.product_code;
  const angle            = overrides.angle            ?? generatedBrief.angle;
  const format           = overrides.format           ?? generatedBrief.format;
  const avatar           = overrides.avatar           ?? generatedBrief.avatar;
  const editor           = overrides.editor           ?? generatedBrief.editor;
  const strategist       = overrides.strategist       ?? generatedBrief.strategist;
  const creator          = overrides.creator          ?? generatedBrief.creator;
  const parent_creative_id = overrides.parent_creative_id ?? generatedBrief.parent_creative_id;
  // Brief type — NN for clones of competitor ads, IT for iterations of our
  // own winners. Operator override (from the now-unlocked modal field)
  // takes precedence; otherwise derive from the brief's stored
  // iteration_mode. Old rows without iteration_mode default to IT for
  // back-compat (they predate the clone/iterate split).
  const brief_type = (overrides.brief_type ?? overrides.briefType)
    || (generatedBrief.iteration_mode === 'clone' ? 'NN' : 'IT');
  const hooks            = overrides.hooks            ?? generatedBrief.hooks;
  const body             = overrides.body             ?? generatedBrief.body;
  const iteration_direction = overrides.idea ?? generatedBrief.iteration_direction;
  // Naming convention: prefer operator-provided override (live-preview from
  // modal). Else use stored naming_convention. Else build fresh from parts.
  const namingOverride   = overrides.naming_convention;
  const referenceLinkOverride = overrides.reference_link;

  // Route to the product's ClickUp pipeline (Puure -> PL | Video Creatives;
  // everything else -> MB | Video Ads) and load that list's field config.
  const pipeline = pipelineForProduct(product_code);
  const targetListId = pipeline.listId;
  const listCfg = await resolveListConfig(targetListId);

  const weekLabel = getCurrentWeekLabel();
  // PL cards have a strict 9-slot canonical shape that reconcilePlName rebuilds
  // from ClickUp fields. The push modal used to send a legacy 6-slot preview
  // string as naming_convention, which produced malformed cards like
  // "PL - B0029 - VL - NN - NA - WK30_2026". For PL, ALWAYS rebuild the name
  // canonically from the resolved fields (avatar/angle/format/editor already
  // fall back to the brief's stored values, so operator edits are reflected)
  // and IGNORE any client-supplied naming string. MB keeps its prior precedence.
  const namingConvention = (namingProductCode(product_code) === 'PL')
    ? buildNamingConvention({
        product_code: 'PL', brief_number, parent_creative_id,
        avatar, angle, format, strategist, creator, editor, week: weekLabel, brief_type,
      })
    : (namingOverride
        || generatedBrief.naming_convention
        || buildNamingConvention({
          product_code: namingProductCode(product_code), brief_number, parent_creative_id,
          avatar, angle, format, strategist, creator, editor, week: weekLabel, brief_type,
        }));

  // Resolve the Reference link via a four-step fallback chain. Every brief
  // gets one regardless of how the source was imported — this matches the
  // operator's ClickUp template rule that the link is always populated.
  //   1. Operator-provided override from the PushToClickupModal.
  //   2. Parent ad's Frame.io link from the parent ClickUp task (only set
  //      when the parent went through our own ClickUp pipeline).
  //   3. The reference's source_url column (FB Ad Library URL for League /
  //      Meta imports, operator-provided URL for Upload imports).
  //   4. Empty — the description builder will skip the section entirely.
  let referenceLink = referenceLinkOverride || '';
  if (!referenceLink && parentClickupTaskId) {
    try {
      const parentTask = await clickupFetch(`/task/${parentClickupTaskId}`);
      const frameField = parentTask.custom_fields?.find(f => f.id === FIELD_IDS.adsFrameLink);
      if (frameField?.value) {
        referenceLink = frameField.value;
      }
    } catch (err) {
      console.warn(`[BriefPipeline] Could not fetch parent Frame link from ${parentClickupTaskId}:`, err.message);
    }
  }
  // Fallback to the reference row's source_url via winner.reference_id —
  // the explicit pointer we set at generate-from-script time. JOINs on
  // creative_id/ad_archive_id won't work because virtual winners use
  // MANUAL-XXXX creative_ids that don't match the reference's archive id.
  // Also grab video_url here (regardless of whether referenceLink is already
  // set): we attach the actual video FILE to the card so editors never lose
  // the reference when the competitor turns the ad off / the fbcdn URL expires.
  let referenceVideoUrl = '';
  if (generatedBrief.winner_id) {
    try {
      const refRows = await pgQuery(
        `SELECT bpr.source_url, bpr.video_url
           FROM brief_pipeline_winners bpw
           JOIN brief_pipeline_references bpr ON bpr.id = bpw.reference_id
          WHERE bpw.id = $1
          LIMIT 1`,
        [generatedBrief.winner_id],
      );
      if (!referenceLink && refRows[0]?.source_url) referenceLink = refRows[0].source_url;
      if (refRows[0]?.video_url) referenceVideoUrl = refRows[0].video_url;
    } catch (err) {
      console.warn('[BriefPipeline] Could not resolve reference row for push:', err.message);
    }
  }

  // Build description in the operator's ClickUp template:
  //
  //   Reference: <competitor video / ad link>
  //
  //   HOOKS:
  //
  //   hook 1
  //   hook 2
  //   ...
  //
  //   BODY:
  //
  //   body text
  //
  // (The old "Highlighted text:" on-screen-overlay section was removed per
  // operator request — briefs no longer carry auto-extracted overlay labels.)
  const parsedHooks = (() => {
    if (Array.isArray(hooks)) return hooks;
    if (typeof hooks === 'string') { try { return JSON.parse(hooks); } catch { return []; } }
    return [];
  })();
  const hooksFormatted = parsedHooks
    .map((h) => (h.text || '').trim())
    .filter(Boolean)
    .join('\n\n');

  const sections = [];
  // Reference link ALWAYS leads the description. Operator rule: the competitor
  // link slot must be visible on every card — even for manual / pasted-script
  // briefs that carry no source URL — so the editor immediately sees where the
  // competitor video link belongs and can paste it in if the resolver had none.
  sections.push(referenceLink
    ? `Reference: ${referenceLink}`
    : 'Reference: (paste competitor video link here)');
  // Durable playable link to OUR stored copy of the reference video (R2 URLs
  // never expire, so editors keep the source even after the competitor turns
  // the ad off). We LINK it rather than attach the file: a file attachment
  // makes ClickUp render a video-frame thumbnail as the card cover, which the
  // operator does not want on the board.
  if (referenceVideoUrl) sections.push(`Reference video: ${referenceVideoUrl}`);
  sections.push(`HOOKS:\n\n${hooksFormatted || '(no hooks)'}`);
  // The push modal sends its combined "Brief Text" field (the hooks, then a
  // "--- Body ---" marker, then the body) as `body`. HOOKS is already rendered
  // above from the hooks array, so emitting that blob verbatim duplicated every
  // hook inside BODY and leaked the "--- Body ---" marker onto the card. Keep
  // only the body: take everything after the marker the prefill inserts; if
  // there is no marker (a clean stored body, or a batch push), drop any leading
  // "Hook N:" lines that may have leaked in, else pass through untouched.
  let bodyText = String(body || '');
  const bodyMarker = bodyText.lastIndexOf('--- Body ---');
  if (bodyMarker !== -1) {
    bodyText = bodyText.slice(bodyMarker + '--- Body ---'.length);
  } else {
    bodyText = bodyText.replace(/^(?:[ \t]*Hook \d+:.*(?:\r?\n|$))+/i, '');
  }
  bodyText = bodyText.trim();
  sections.push(`BODY:\n\n${bodyText}`);
  const description = sections.join('\n\n');

  // Resolve dropdown option IDs against the TARGET list (ids differ per list).
  // Angle is normalized through the alias map so analyzer display strings
  // ("Anti-Fake / Competitor Callout") resolve to the canonical option name.
  const angleUuid       = resolveListAngleOptionId(listCfg, angle);
  const briefTypeUuid   = listCfg.optionId('Brief Type', brief_type) || listCfg.optionId('Brief Type', 'IT');
  const creativeTypeUuid = listCfg.optionId('Creative Type', format) || listCfg.optionId('Creative Type', 'Mashup');
  const fbPageUuid      = pipeline.fbPage ? listCfg.optionId('FB Page', pipeline.fbPage) : null;

  const editorMap = await getEditors(pipeline.listId);
  // Only treat it as a real editor when the brief actually names one AND that
  // name resolves to a ClickUp user. 'NA' / unknown means NO editor yet — we
  // must NOT stamp the owner into the Editor field, because reconcilePlName
  // rebuilds the card name from that field and would write "Ludovico" into the
  // editor slot, drifting from the brief's stored "... - NA - ..." naming.
  const resolvedEditorId = (editor && editor !== 'NA') ? editorMap[editor] : null;
  // Assignee still falls back to the owner so a pushed card is never ownerless.
  const assigneeUserId = resolvedEditorId || OWNER_ID;

  const editorFieldId = listCfg.fieldId('Editor');
  const customFields = [
    { id: listCfg.fieldId('Brief Number'),      value: brief_number },
    { id: listCfg.fieldId('Brief Type'),        value: briefTypeUuid },
    { id: listCfg.fieldId('Parent Brief ID'),   value: parent_creative_id },
    { id: listCfg.fieldId('Idea'),              value: iteration_direction || '-' },
    { id: listCfg.fieldId('Angle'),             value: angleUuid },
    { id: listCfg.fieldId('Creative Type'),     value: creativeTypeUuid },
    { id: listCfg.fieldId('FB Page'),           value: fbPageUuid },
    { id: listCfg.fieldId('Naming Convention'), value: namingConvention },
    { id: listCfg.fieldId('Creation Week'),     value: weekLabel },
    { id: listCfg.fieldId('Creative Strategist'), value: { add: [OWNER_ID], rem: [] } },
    { id: listCfg.fieldId('Copywriter'),        value: { add: [OWNER_ID], rem: [] } },
    // Editor field is set ONLY when a real editor is assigned (see above).
    ...(resolvedEditorId ? [{ id: editorFieldId, value: { add: [resolvedEditorId], rem: [] } }] : []),
  ].filter(f => f.id && f.value != null);

  const taskPayload = {
    name: namingConvention,
    description,
    status: pipeline.initialStatus,
    assignees: [assigneeUserId],
    custom_fields: customFields,
    // No '[brief-pipeline]' marker in the description anymore (operator asked to
    // remove that text). The ClickUp webhook instead recognizes pipeline pushes
    // by their already-complete naming convention, so it won't re-name them.
  };

  let createdTask;
  try {
    createdTask = await clickupFetch(
      `/list/${targetListId}/task`,
      { method: 'POST', body: JSON.stringify(taskPayload) }
    );
  } catch (err) {
    // If editor user doesn't have workspace access, retry without user fields
    if (err.message.includes('FIELD_129') || err.message.includes('must have access')) {
      console.warn(`[BriefPipeline] Editor ${editor} (${resolvedEditorId}) not accessible, falling back to Ludovico`);
      const fallbackFields = customFields.map(f => {
        if (editorFieldId && f.id === editorFieldId) return { ...f, value: { add: [OWNER_ID], rem: [] } };
        return f;
      });
      const fallbackPayload = { ...taskPayload, assignees: [OWNER_ID], custom_fields: fallbackFields };
      createdTask = await clickupFetch(
        `/list/${targetListId}/task`,
        { method: 'POST', body: JSON.stringify(fallbackPayload) }
      );
    } else {
      throw err;
    }
  }

  const taskId = createdTask.id;

  // Set relationship fields (Product, Avatar, Creator). Static maps are the
  // fast path; unknown names resolve dynamically against the relationship
  // lists (and products/avatars are created there when genuinely new), so a
  // new product never again silently defaults to MR.
  const relationshipPromises = [];

  // Relationship field ids come from the TARGET list's config; the linked
  // relationship LISTS (Products / Avatars / Creators) are shared across
  // pipelines, so the resolved task ids are valid in either.
  const productFieldId = listCfg.fieldId('Product');
  const avatarFieldId  = listCfg.fieldId('Avatar');
  const creatorFieldId = listCfg.fieldId('Creator');

  let productTaskId = PRODUCT_TASK_IDS[product_code];
  if (!productTaskId) {
    productTaskId = await resolveRelationshipTask('product', product_code, { createIfMissing: true })
      .catch(err => { console.error('[BriefPipeline] Product resolve error:', err.message); return null; });
  }
  if (!productTaskId) productTaskId = PRODUCT_TASK_IDS.MR;
  if (productTaskId && productFieldId) {
    relationshipPromises.push(
      clickupFetch(`/task/${taskId}/field/${productFieldId}`, {
        method: 'POST',
        body: JSON.stringify({ value: { add: [productTaskId], rem: [] } }),
      }).catch(err => console.error('[BriefPipeline] Product relationship error:', err.message))
    );
  }

  let avatarTaskId = AVATAR_TASK_IDS[avatar];
  if (avatarTaskId === undefined && avatar && avatar !== 'NA') {
    avatarTaskId = await resolveRelationshipTask('avatar', avatar, { createIfMissing: true })
      .catch(err => { console.error('[BriefPipeline] Avatar resolve error:', err.message); return null; });
  }
  if (avatarTaskId && avatarFieldId) {
    relationshipPromises.push(
      clickupFetch(`/task/${taskId}/field/${avatarFieldId}`, {
        method: 'POST',
        body: JSON.stringify({ value: { add: [avatarTaskId], rem: [] } }),
      }).catch(err => console.error('[BriefPipeline] Avatar relationship error:', err.message))
    );
  }

  // Creator: resolve real creators by name from the Creators Database; 'NA'
  // (or no match) falls back to the standing NA task so the required field
  // is never left empty.
  let creatorTaskId = null;
  if (creator && creator !== 'NA') {
    creatorTaskId = await resolveRelationshipTask('creator', creator, { createIfMissing: false })
      .catch(err => { console.error('[BriefPipeline] Creator resolve error:', err.message); return null; });
  }
  if (creatorFieldId) {
    relationshipPromises.push(
      clickupFetch(`/task/${taskId}/field/${creatorFieldId}`, {
        method: 'POST',
        body: JSON.stringify({ value: { add: [creatorTaskId || CREATOR_NA_TASK_ID], rem: [] } }),
      }).catch(err => console.error('[BriefPipeline] Creator relationship error:', err.message))
    );
  }

  await Promise.all(relationshipPromises);

  // NOTE: we deliberately do NOT attach the reference video as a task file —
  // ClickUp renders a video-frame thumbnail as the card cover for file
  // attachments, which clutters the board. Instead the durable R2 video URL is
  // linked in the description ("Reference video:" above), so editors keep the
  // source without a preview image on the card.

  return {
    taskId,
    taskUrl: createdTask.url || `https://app.clickup.com/t/${taskId}`,
    namingConvention,
  };
}

// ── On-demand Meta thumbnail refresh ──────────────────────────────────
/**
 * Fetch a fresh thumbnail_url from Meta API for a given creative_id (e.g. "B0071").
 * Returns { thumbnail_url, video_url } or null if not found.
 */
async function refreshMetaThumbnail(creativeId) {
  if (!META_ACCESS_TOKEN || META_AD_ACCOUNT_IDS.length === 0) return null;

  for (const accountId of META_AD_ACCOUNT_IDS) {
    try {
      const searchUrl = `${META_GRAPH_URL}/${accountId}/ads?fields=name,creative.fields(thumbnail_url,image_url,video_id).thumbnail_width(720).thumbnail_height(720)&filtering=[{"field":"name","operator":"CONTAIN","value":"${creativeId}"}]&limit=10&access_token=${META_ACCESS_TOKEN}`;
      const resp = await fetch(searchUrl);
      const data = await resp.json();
      if (data.error || !data.data?.length) continue;

      for (const ad of data.data) {
        const thumbUrl = ad.creative?.image_url || ad.creative?.thumbnail_url || null;
        if (!thumbUrl) continue;

        // Also fetch permanent video source if there's a video_id
        let videoUrl = null;
        const videoId = ad.creative?.video_id;
        if (videoId) {
          try {
            // Use advideos endpoint (ad account scope) — /{video_id}?fields=source fails with Marketing API tokens
            const vidResp = await fetch(
              `${META_GRAPH_URL}/${accountId}/advideos?filtering=[{"field":"id","operator":"EQUAL","value":"${videoId}"}]&fields=source&limit=1&access_token=${META_ACCESS_TOKEN}`,
              { signal: AbortSignal.timeout(10000) }
            );
            const vidData = await vidResp.json();
            if (vidData.data?.[0]?.source) videoUrl = vidData.data[0].source;
          } catch (_) { /* ignore */ }
        }

        // Update creative_analysis so other endpoints benefit
        await pgQuery(
          `UPDATE creative_analysis SET thumbnail_url = $1, video_url = COALESCE($2, video_url)
           WHERE creative_id = $3`,
          [thumbUrl, videoUrl, creativeId]
        ).catch(() => {});

        return { thumbnail_url: thumbUrl, video_url: videoUrl };
      }
    } catch (err) {
      console.warn(`[BriefPipeline] Meta thumbnail refresh error for ${accountId}:`, err.message);
    }
  }
  return null;
}

// ══════════════════════════════════════════════════════════════════════
// ROUTES
// ══════════════════════════════════════════════════════════════════════

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
function validateUuid(req, res) {
  if (!UUID_RE.test(req.params.id)) {
    res.status(400).json({ success: false, error: { message: 'Invalid ID format' } });
    return false;
  }
  return true;
}

// POST /generate-from-script — Generate briefs from manually pasted/URL script
// Responds immediately after URL extraction + winner creation, generates in background
router.post('/generate-from-script', authenticate, async (req, res) => {
  try {
    await ensureTables();
    const { script, url, productId, productCode, angle, mode, numVariations = 3, referenceId, vectorsSelected, acknowledgeBrandMismatch, acknowledgeAdCopyOnly, model = 'claude' } = req.body;

    // C2 — refuse iterate/clone when the reference's transcript came from
    // Meta ad-copy metadata (Path 5 last resort) instead of a real video
    // transcription. The ad-copy text IS the marketer's own description, so
    // cloning it makes the model hallucinate a "video" from a static blurb.
    // Operator must explicitly acknowledge with acknowledgeAdCopyOnly:true.
    if (referenceId && !acknowledgeAdCopyOnly) {
      try {
        const adCopyRows = await pgQuery(
          `SELECT imported_metadata->>'transcribe_source' AS src, headline
             FROM brief_pipeline_references WHERE id = $1 LIMIT 1`,
          [referenceId]
        );
        if (adCopyRows[0]?.src === 'ad_copy_metadata') {
          return res.status(409).json({
            success: false,
            error: {
              code: 'AD_COPY_METADATA_ONLY',
              message: 'This reference has no real video transcript — only Meta ad-copy text (the marketing description). Iterating from this will produce hallucinated content.',
              ref_headline: adCopyRows[0].headline,
              hint: 'Click "Retry Transcribe" to attempt video extraction again, OR paste the actual script via the Upload button, OR resubmit with acknowledgeAdCopyOnly:true to proceed anyway.',
            },
          });
        }
      } catch (e) {
        console.warn(`[BriefPipeline] ad-copy guard check failed for ref ${referenceId}:`, e.message);
      }
    }

    // STATIC AD GUARDRAIL: brief pipeline is for video ads ONLY. Refuse any
    // reference whose headline shows it's a static creative ("- IMG -" in
    // Mineblock's naming, or square 1080×1080 dimensions). No override —
    // user must delete this reference and pick a video ad.
    if (referenceId) {
      try {
        const refRows = await pgQuery(
          `SELECT headline, brand_name FROM brief_pipeline_references WHERE id = $1 LIMIT 1`,
          [referenceId]
        );
        if (refRows[0] && isStaticAdReference(refRows[0])) {
          return res.status(409).json({
            success: false,
            error: {
              code: 'STATIC_AD_REFUSED',
              message: 'This reference is a static image creative (study card / banner). The Brief Pipeline is for video ads only. Delete this reference and import a video creative instead.',
              ref_headline: refRows[0].headline,
              hint: 'Mineblock format-slot convention: "IMG" or "1080×1080" in the ad name = static creative. Use a "Mashup", "UGC", "GIF", or other video format ad.',
            },
          });
        }
      } catch (e) {
        console.warn(`[BriefPipeline] static-ad guard check failed for ref ${referenceId}:`, e.message);
      }
    }

    // Brand-mismatch guardrail. Four-tier check:
    //   0. Quarantine + synchronous Meta-direct ownership re-check at iterate
    //      time. Belt+braces: even if downstream tiers fail, this catches
    //      foreign-account ads on every iterate call (no DB-staleness window).
    //   1. Explicit imported_metadata.brand_mismatch_warning persisted by transcribe path
    //   2. Recompute from imported_metadata.multimodal_analysis if warning never persisted
    //      (covers refs transcribed before the warning code shipped, or persistence gaps)
    //   3. Heuristic transcript scan for known non-Mineblock brand callouts
    //      (covers Whisper-only path that has no multimodal_analysis)
    // Refuse to iterate / clone unless operator passes acknowledgeBrandMismatch:true.
    if (referenceId && !acknowledgeBrandMismatch) {
      try {
        const refRows = await pgQuery(
          `SELECT imported_metadata->'brand_mismatch_warning' AS warning,
                  imported_metadata->'multimodal_analysis' AS analysis,
                  imported_metadata->>'ad_id' AS meta_ad_id,
                  is_quarantined, quarantine_reason,
                  headline, transcript
           FROM brief_pipeline_references WHERE id = $1 LIMIT 1`,
          [referenceId]
        );
        const row = refRows[0];
        let mismatch = null;

        // Tier 0 — hard refuse if the ref is already quarantined.
        if (row?.is_quarantined === true) {
          return res.status(409).json({
            success: false,
            error: {
              code: 'REFERENCE_QUARANTINED',
              message: row.quarantine_reason || 'This reference is quarantined (wrong-brand linkage). Delete and re-import a real Mineblock ad.',
              ref_headline: row.headline,
              hint: 'Quarantined references cannot be iterated. acknowledgeBrandMismatch does NOT override quarantine — the linkage is structurally wrong.',
            },
          });
        }

        // Tier 0b — synchronous Meta-direct ownership re-check (when ad_id present).
        // This re-asks Meta right now whether the ad still belongs to us, catching
        // links that flipped foreign since the last transcribe.
        if (row?.meta_ad_id) {
          try {
            const owned = await resolveOwnedVideoFromMeta(row.meta_ad_id);
            if (owned?.foreignAccount) {
              // Quarantine on the spot so the next call doesn't re-pay this round-trip
              await pgQuery(
                `UPDATE brief_pipeline_references
                    SET is_quarantined = TRUE, quarantine_reason = $1, quarantined_at = NOW(), updated_at = NOW()
                  WHERE id = $2`,
                [`Iterate-time Meta check: ad ${row.meta_ad_id} lives in account ${owned.accountId}, not Mineblock's.`, referenceId]
              ).catch(() => {});
              return res.status(409).json({
                success: false,
                error: {
                  code: 'BRAND_MISMATCH',
                  message: `Refusing iterate: Meta reports this ad lives in account ${owned.accountId}, not one of Mineblock's. Reference has been quarantined.`,
                  detected_brand: `Meta account ${owned.accountId}`,
                  expected_brand: 'Mineblock / MinerForge Pro',
                  ref_headline: row.headline,
                  hint: 'Linkage is structurally wrong. Delete this reference and re-import a real Mineblock ad.',
                },
              });
            }
          } catch (e) {
            console.warn(`[BriefPipeline] iterate-time Meta-direct check failed for ref ${referenceId}:`, e.message);
          }
        }

        // Tier 1 — explicit persisted warning
        const w = row?.warning;
        if (w && typeof w === 'object' && w.warning === 'BRAND_MISMATCH') {
          mismatch = w;
        }

        // Tier 2 — recompute from multimodal_analysis on the fly
        if (!mismatch && row?.analysis && typeof row.analysis === 'object') {
          mismatch = detectBrandMismatch(row.headline, row.analysis);
        }

        // Tier 3 — heuristic transcript scan. Catches Whisper-only path where
        // there is no multimodal_analysis but the transcript clearly mentions
        // a non-Mineblock brand (e.g. "ALDI, it's an ALDI thing").
        if (!mismatch && row?.headline && row?.transcript) {
          const looksMineblock = MINEBLOCK_HEADLINE_TOKENS.test(String(row.headline));
          const t = String(row.transcript || '');
          if (looksMineblock && !MINEBLOCK_BRAND_TOKENS.test(t)) {
            // Known foreign-brand tells we've seen in TripleWhale cross-contamination
            const foreignHit = /\b(ALDI|LIDL|WALMART|TESCO|COSTCO|CARREFOUR|KROGER|TARGET CORP|JD\s*SPORTS|MARBLE BLAST|TRENITALIA|FRECCIA|NORSE ORGANIC)\b/i.exec(t);
            if (foreignHit) {
              mismatch = {
                warning: 'BRAND_MISMATCH',
                expected: 'Mineblock / MinerForge Pro',
                actual: foreignHit[0],
                selling_message: t.slice(0, 200),
                message: `Transcript mentions "${foreignHit[0]}" but headline claims Mineblock. The video at this Meta ad_archive_id likely belongs to a different brand. Re-import or delete this reference before iterating.`,
              };
            }
          }
        }

        if (mismatch) {
          return res.status(409).json({
            success: false,
            error: {
              code: 'BRAND_MISMATCH',
              message: mismatch.message,
              detected_brand: mismatch.actual,
              expected_brand: mismatch.expected,
              selling_message: mismatch.selling_message,
              ref_headline: row?.headline,
              hint: 'To override, resubmit with acknowledgeBrandMismatch: true. Recommended: delete this reference and re-import the correct ad.',
            },
          });
        }
      } catch (e) {
        console.warn(`[BriefPipeline] brand mismatch guard check failed for ref ${referenceId}:`, e.message);
      }
    }

    let rawScript = script || '';

    // URL mode: smart multi-strategy extraction
    if (url && !rawScript) {
      try {
        rawScript = await extractScriptFromUrl(url);
      } catch (urlErr) {
        return res.status(400).json({ success: false, error: { message: urlErr.message || 'Failed to process URL' } });
      }
    }

    if (!rawScript || rawScript.length < 20) {
      return res.status(400).json({ success: false, error: { message: 'Script text is required (minimum 20 characters).' } });
    }

    console.log(`[BriefPipeline] generate-from-script: ${rawScript.length} chars, ${numVariations} variants`);

    // Create a virtual winner record. We stash the originating reference
    // UUID so the push-to-ClickUp resolver can read the reference's
    // source_url back later — the operator's "Reference link must always
    // be filled" rule depends on this. NULL is fine when the operator
    // pasted a script with no reference (raw-text flow).
    const creativeId = `MANUAL-${Date.now().toString(36).toUpperCase()}`;
    const referenceIdForWinner = (referenceId && /^[0-9a-f-]{36}$/i.test(String(referenceId))) ? referenceId : null;
    const insertedWinner = await pgQuery(`
      INSERT INTO brief_pipeline_winners (
        creative_id, ad_name, product_code, angle, format, raw_script,
        status, spend, roas, cpa, ctr, purchases, winner_reason, reference_id
      ) VALUES ($1, $2, $3, $4, $5, $6, 'generating', 0, 0, 0, 0, 0, 'manual', $7)
      RETURNING *
    `, [
      creativeId,
      `Manual script — ${rawScript.slice(0, 50)}...`,
      productCode || 'MR',
      angle || 'NA',
      'Mashup',
      rawScript,
      referenceIdForWinner,
    ]);
    const winner = insertedWinner[0];

    // Respond immediately so client doesn't timeout on Render's 30s limit
    res.json({ success: true, message: 'Generation started in background', creative_id: creativeId, winner_id: winner.id });

    // Continue generation in background (non-blocking). The engine lives in
    // executeGenerationJob() (module scope) so the batch-queue worker can
    // await the identical flow; this route keeps the original
    // fire-and-forget behavior.
    executeGenerationJob({
      rawScript, referenceId, productId, productCode, angle, mode,
      numVariations, vectorsSelected, model, winner, creativeId,
    }).catch(async (bgErr) => {
      console.error('[BriefPipeline] generate-from-script background error:', bgErr.message);
      // Reset winner status so user can retry
      await pgQuery(`UPDATE brief_pipeline_winners SET status = 'detected' WHERE id = $1`, [winner.id]).catch(() => {});
    });

  } catch (err) {
    console.error('[BriefPipeline] generate-from-script error:', err.message);
    if (!res.headersSent) {
      res.status(500).json({ success: false, error: { message: err.message } });
    }
  }
});

// ── Core generation engine ─────────────────────────────────────────────
// Extracted 1:1 from the POST /generate-from-script background IIFE so the
// batch-queue worker can await the exact same flow. Parameterized on
// everything the IIFE used to close over. Returns { briefIds } on success;
// THROWS when every generation/insert failed (after resetting the winner
// row to 'detected'). Callers own further error handling — the route logs
// + resets the winner; the queue worker marks the job failed.
async function executeGenerationJob({
  rawScript, referenceId, productId, productCode, angle, mode,
  numVariations = 3, vectorsSelected, model = 'claude', winner, creativeId,
}) {
    // Step 4: Parse script + fetch product in parallel
    const isCloneMode   = mode === 'clone';
    const isIterateMode = mode === 'iterate';
    console.log(`[BriefPipeline] ${isCloneMode ? 'FAST clone' : isIterateMode ? 'ITERATE' : 'Variant'} mode — parsing script`);

    // If referenceId is provided, pull its performance metadata so the
    // iterator can reason about WHAT is winning, not just the script.
    let performanceContextStr = '';
    if (isIterateMode && referenceId) {
      try {
        const refRows = await pgQuery(
          `SELECT imported_metadata FROM brief_pipeline_references WHERE id = $1 LIMIT 1`,
          [referenceId]
        );
        if (refRows.length && refRows[0].imported_metadata) {
          let md = refRows[0].imported_metadata;
          if (typeof md === 'string') { try { md = JSON.parse(md); } catch {} }
          if (md && typeof md === 'object') {
            const lines = [];
            if (md.roas != null)         lines.push(`ROAS:        ${Number(md.roas).toFixed(2)}×`);
            if (md.spend != null)        lines.push(`Spend:       $${Number(md.spend).toLocaleString()}`);
            if (md.revenue != null)      lines.push(`Revenue:     $${Number(md.revenue).toLocaleString()}`);
            if (md.cpa != null)          lines.push(`CPA:         $${Number(md.cpa).toFixed(2)}`);
            if (md.ctr != null)          lines.push(`CTR:         ${Number(md.ctr).toFixed(2)}%`);
            if (md.impressions != null)  lines.push(`Impressions: ${Number(md.impressions).toLocaleString()}`);
            if (md.angle)                lines.push(`Original angle: ${md.angle}`);
            performanceContextStr = lines.join('\n');
          }
        }
      } catch (e) { console.warn('[BriefPipeline] iterate: could not load reference performance:', e.message); }
    }
    // Parse only the SPOKEN script — strip the [ON-SCREEN TEXT] word-soup so
    // it never pollutes the cloned body. rawScript stays intact for the clone
    // prompt's separate on-screen overlay extraction (highlighted_text).
    const spokenScript = stripOnScreenText(rawScript);
    const { system: parseSystem, user: parseUser } = await buildScriptParserPrompt(spokenScript, creativeId);
    // Prefer fetching by explicit productId (set when the user picked a product
    // in the ProductSelector). Falls back to product_code lookup for callers
    // that don't have an id (e.g. detected-winner ClickUp flow).
    const profilePromise = (async () => {
      if (productId && /^\d+$/.test(String(productId))) {
        const rows = await pgQuery(`SELECT * FROM product_profiles WHERE id = $1 LIMIT 1`, [Number(productId)]);
        if (rows.length) {
          const p = rows[0];
          for (const f of ['product_images','logos','fonts','brand_colors','benefits','angles','scripts','offers']) {
            if (p[f] && typeof p[f] === 'string') try { p[f] = JSON.parse(p[f]); } catch {}
          }
          return p;
        }
      }
      return fetchProductProfile(productCode || 'MR');
    })();
    const [parsedScriptRaw, productProfile] = await Promise.all([
      callClaude(parseSystem, parseUser, 2000, { fast: true }),
      profilePromise,
    ]);
    let parsedScript = parsedScriptRaw;
    if (!parsedScript || (!parsedScript.hooks?.length && !parsedScript.body?.trim())) {
      // Fallback body is the spoken script (on-screen text already stripped).
      parsedScript = { hooks: [], body: spokenScript, cta: '', format_notes: '' };
    }
    pgQuery(`UPDATE brief_pipeline_winners SET parsed_script = $1 WHERE id = $2`, [JSON.stringify(parsedScript), winner.id]).catch(() => {});

    if (!productProfile) {
      console.warn(`[BriefPipeline] WARNING: No product profile found for ${productCode || 'MR'} — generation will proceed with limited context`);
    }
    const productContext = buildProductContextForBrief(productProfile);
    console.log(`[BriefPipeline] Product context: ${productContext === 'No product profile available.' ? 'EMPTY (no profile)' : `${productContext.split('\n').length} fields loaded`}`);

    // Auto-detect avatar + angle from the transcript. Only fills in what the
    // caller hasn't already specified: an explicit `angle` param from the
    // League Import modal always wins, and if the product has no
    // avatars/angles catalog we simply keep 'NA'. Runs on Haiku (~1s) so
    // the extra latency is invisible next to the ~30s clone generation.
    let detectedAvatar = null;
    let effectiveAngle = angle && String(angle).trim() && String(angle).trim().toUpperCase() !== 'NA' ? angle : null;
    if (isCloneMode && productProfile) {
      const needAvatar = true; // we NEVER receive avatar today; always try
      const needAngle  = !effectiveAngle;
      if (needAvatar || needAngle) {
        const detection = await detectAvatarAndAngle({
          transcript: rawScript,
          headline:   winner?.ad_name || null,
          productProfile,
        });
        if (needAvatar) detectedAvatar = detection.avatar;
        if (needAngle && detection.angle) effectiveAngle = detection.angle;
        if (detectedAvatar || (needAngle && effectiveAngle)) {
          console.log(`[BriefPipeline] auto-detected avatar=${detectedAvatar || 'null'} angle=${effectiveAngle || 'null'}`);
        }
      }
    }

    // Floor for atomic allocation: getNextBriefNumber() scans ClickUp + DB.
    // The actual per-brief number is minted race-free at INSERT time by
    // allocateBriefNumber() — two concurrent queue jobs can never collide.
    const briefNumberFloor = (await getNextBriefNumber(productCode)) - 1;
    const briefCounterId = (productCode === 'PUURE' || productCode === 'PL') ? 2 : 1;
    let generationResults;
    let winAnalysis = {};
    const config = {
      mode: isCloneMode ? 'clone' : isIterateMode ? 'iterate' : 'hook_body',
      aggressiveness: 'medium',
      num_variations: numVariations,
      fixed_elements: [],
    };

    if (isIterateMode) {
      // ═══════════════════════════════════════════════════
      // ITERATE MODE — single Claude call, returns N variants of OUR
      // winning script. Skips deep analysis (the winning script is already
      // our proof of what works). Performance context tells the model
      // WHY this version won so it can preserve the right elements.
      // ═══════════════════════════════════════════════════
      console.log(`[BriefPipeline] Iterate mode — single-call generation of ${numVariations} cards (vectors=${JSON.stringify(vectorsSelected || ['Hooks'])})`);
      // Resolve the locked angle from the reference's imported_metadata if
      // available — META references carry the angle the source ad was
      // tagged with at sync time.
      let resolvedAngleLocked = angle && angle !== 'NA' ? angle : null;
      if (!resolvedAngleLocked && referenceId) {
        try {
          const refRows = await pgQuery(
            `SELECT imported_metadata FROM brief_pipeline_references WHERE id = $1 LIMIT 1`,
            [referenceId]
          );
          if (refRows.length && refRows[0].imported_metadata) {
            let md = refRows[0].imported_metadata;
            if (typeof md === 'string') { try { md = JSON.parse(md); } catch {} }
            if (md?.angle) resolvedAngleLocked = md.angle;
          }
        } catch { /* fall through with null */ }
      }
      const { system: iterSystem, user: iterUser } = await buildIterationPrompt(
        parsedScript,
        productContext,
        performanceContextStr,
        numVariations,
        productProfile,
        vectorsSelected,
        resolvedAngleLocked,
        rawScript,   // pass raw transcript so the prompt can see [ON-SCREEN TEXT] markers
      );

      // Route to correct model (Claude vs OpenAI) based on request parameter
      let iterResult;
      let iterModelUsed = null;
      let iterLastErr = null;

      if (model === 'openai') {
        try {
          iterModelUsed = 'openai';
          iterResult = await callOpenAI(iterSystem, iterUser, 6000);
        } catch (openaiErr) {
          iterLastErr = `openai: ${openaiErr.message}`;
          console.warn(`[BriefPipeline] OpenAI iteration attempt failed (${openaiErr.message}) — falling back to Claude (Opus first).`);
          try {
            iterModelUsed = 'opus';
            iterResult = await callClaude(iterSystem, iterUser, 6000, { opus: true });
          } catch (opusErr) {
            iterLastErr = `${iterLastErr}; opus: ${opusErr.message}`;
            console.warn(`[BriefPipeline] Opus fallback failed (${opusErr.message}) — trying Sonnet.`);
            try {
              iterModelUsed = 'sonnet';
              iterResult = await callClaude(iterSystem, iterUser, 6000);
            } catch (sonnetErr) {
              iterLastErr = `${iterLastErr}; sonnet: ${sonnetErr.message}`;
              console.error(`[BriefPipeline] iteration — OpenAI and both Claude models failed: ${iterLastErr}`);
              throw new Error(`Iteration failed on all models: ${iterLastErr}`);
            }
          }
        }
      } else {
        // Default: Claude only (backward compatible)
        iterModelUsed = 'claude';
        iterResult = await callClaude(iterSystem, iterUser, 6000);
      }

      const variants = Array.isArray(iterResult?.iterations) ? iterResult.iterations : [];
      if (variants.length === 0) {
        throw new Error('Iteration prompt returned no variants. Check the scriptIteration JSON prompt slot if you customised it.');
      }
      // Iterations are derivatives of an already-proven winning script.
      // Scoring them against each other on novelty/aggression/coherence is
      // measuring noise — they all share the same conversion engine. Persist
      // null scores so the column sorts iterations after scored briefs
      // (variants/clones get real scores; iterations get the iteration_label
      // + what_changed as their identifying metadata).
      generationResults = variants.map((v, idx) => ({
        success: true,
        direction: { id: `iter-${idx + 1}`, name: v.iteration_label || `Iteration ${idx + 1}`, description: v.what_changed || '' },
        // Operator rule: no "-" / em-dashes in generated copy.
        generated: stripDashesFromBrief({
          hooks: Array.isArray(v.hooks) ? v.hooks : [],
          body:  v.body || '',
          cta:   v.cta || '',
          // On-screen overlay labels (empty if the winning script has none —
          // we never fabricate overlays. See iteration prompt rule §9.)
          highlighted_text: Array.isArray(v.highlighted_text) ? v.highlighted_text.filter(Boolean).map(String) : [],
          preservation_notes: v.preservation_notes || '',
        }),
        scores: { novelty: null, aggression: null, coherence: null, verdict: null },
        overall: null,
      }));
    } else if (isCloneMode) {
      // ═══════════════════════════════════════════════════
      // FAST CLONE MODE — Skip deep analysis + scoring (2 API calls total)
      // The clone prompt is self-contained — Claude analyzes structure inline
      // ═══════════════════════════════════════════════════
      console.log(`[BriefPipeline] Fast clone — skipping deep analysis, direct generation`);
      // Angle now flows through the prompt template's {{ANGLE_NAME}} +
      // {{ANGLE_DETAILS}} + {{ANGLES_LIST}} placeholders, sourced from
      // productProfile.angles. No more hardcoded post-prompt appendix.
      const { system: cloneSystem, user: cloneUser } = await buildScriptClonePrompt(
        parsedScript, {}, productContext, productProfile, angle, rawScript
      );
      const enhancedCloneUser = cloneUser;

      // Prompt-cache breakpoint: everything before the ORIGINAL SCRIPT block
      // (mission + full master brief + angles + template rules) is identical
      // across generations for the same product. Splitting the user prompt
      // there lets the API cache ~11K input tokens for 5 minutes — repeat
      // generations skip reprocessing the entire static prefix.
      const CACHE_SPLIT_MARKER = '# ORIGINAL COMPETITOR SCRIPT';
      const splitIdx = enhancedCloneUser.indexOf(CACHE_SPLIT_MARKER);
      const cloneUserContent = splitIdx > 0
        ? [
            { type: 'text', text: enhancedCloneUser.slice(0, splitIdx), cache_control: { type: 'ephemeral' } },
            { type: 'text', text: enhancedCloneUser.slice(splitIdx) },
          ]
        : enhancedCloneUser;

      generationResults = [await (async () => {
        // Sonnet-first, Opus-fallback. Latency profiling showed the clone
        // call is ~86% of wall-clock and Opus takes ~120s vs Sonnet ~30s —
        // Sonnet with the length-contract prompt + blend validator is the
        // default; Opus remains the quality fallback if Sonnet errors.
        // A 90s timeout on the primary attempt kills the 5-minute tail where
        // a hung attempt used to stack a full failed wait on top of a full
        // fallback call. Errors are captured to
        // brief_pipeline_winners.generation_error so they surface on
        // /generation-status without needing Render logs.
        let lastErr = null;
        let modelUsed = null;
        let generated = null;

        // Route to correct model (Claude vs OpenAI) based on request parameter
        if (model === 'openai') {
          try {
            modelUsed = 'openai';
            generated = await callOpenAI(cloneSystem, enhancedCloneUser, 12000);
          } catch (openaiErr) {
            lastErr = `openai: ${openaiErr.message}`;
            console.warn(`[BriefPipeline] OpenAI clone attempt failed (${openaiErr.message}) — falling back to Claude (Opus).`);
            try {
              modelUsed = 'opus';
              generated = await callClaude(cloneSystem, cloneUserContent, 12000, { opus: true, timeoutMs: 180000 });
            } catch (opusErr) {
              lastErr = `${lastErr}; opus: ${opusErr.message}`;
              console.warn(`[BriefPipeline] Opus fallback failed (${opusErr.message}) — last-resort Sonnet.`);
              try {
                modelUsed = 'sonnet-fallback';
                generated = await callClaude(cloneSystem, cloneUserContent, 12000, { timeoutMs: 90000 });
              } catch (sonnetErr) {
                lastErr = `${lastErr}; sonnet: ${sonnetErr.message}`;
                await pgQuery(
                  `UPDATE brief_pipeline_winners SET generation_error = $1, generation_model = $2 WHERE id = $3`,
                  [lastErr, 'openai-fallback-both-failed', winner.id]
                ).catch(() => {});
                console.error(`[BriefPipeline] clone — OpenAI and both Claude models failed: ${lastErr}`);
                return { direction: { id: 1, name: '1:1 Clone' }, success: false };
              }
            }
          }
        } else {
          // Operator directive: script generation runs on OPUS (highest
          // quality), not Sonnet. Opus takes ~120s, so the primary attempt gets
          // a 180s timeout. Sonnet stays ONLY as a last-resort error fallback so
          // a transient Opus failure still yields a brief instead of hard-failing.
          try {
            modelUsed = 'opus';
            generated = await callClaude(cloneSystem, cloneUserContent, 12000, { opus: true, timeoutMs: 180000 });
          } catch (opusErr) {
            lastErr = `opus: ${opusErr.message}`;
            console.warn(`[BriefPipeline] Opus clone attempt failed (${opusErr.message}) — last-resort Sonnet fallback.`);
            try {
              modelUsed = 'sonnet-fallback';
              generated = await callClaude(cloneSystem, cloneUserContent, 12000, { timeoutMs: 90000 });
            } catch (sonnetErr) {
              lastErr = `${lastErr}; sonnet: ${sonnetErr.message}`;
              await pgQuery(
                `UPDATE brief_pipeline_winners SET generation_error = $1, generation_model = $2 WHERE id = $3`,
                [lastErr, 'both-failed', winner.id]
              ).catch(() => {});
              console.error(`[BriefPipeline] clone — both Opus and Sonnet failed: ${lastErr}`);
              return { direction: { id: 1, name: '1:1 Clone' }, success: false };
            }
          }
        }
        try {
          if (!generated || (!generated.hooks && !generated.body)) throw new Error('Invalid clone response');
          if (!Array.isArray(generated.hooks)) generated.hooks = [];
          if (!generated.body) generated.body = '';
          // Operator rule: generated copy must never contain "-" / em-dashes.
          stripDashesFromBrief(generated);
          // Normalize on-screen labels. Reference-driven only — if the
          // source has no overlays the prompt returns [] and we persist [].
          if (!Array.isArray(generated.highlighted_text)) {
            generated.highlighted_text = [];
          } else {
            generated.highlighted_text = generated.highlighted_text
              .filter(Boolean)
              .map((s) => String(s).trim())
              .filter(Boolean)
              .slice(0, 4);   // hard cap — see rule §7
          }

          // Deep validation: hooks must have text, body must be non-empty
          const cloneValidation = validateGeneratedBrief(generated);
          if (!cloneValidation.valid) {
            console.error(`[BriefPipeline] Clone validation failed:`, cloneValidation.errors.join('; '));
            throw new Error(`Clone validation failed: ${cloneValidation.errors.join('; ')}`);
          }

          if (generated.clone_fidelity) {
            generated.key_changes_from_original = generated.key_adaptations || generated.key_changes_from_original || '';
          }

          // Clone scoring: measure fidelity, not novelty. Clones replicate proven winners
          // so high scores reflect successful structural replication, not creative originality.
          // Hook-body blend is validated AFTER the brief row is inserted (off the
          // critical path — saves 8-20s of blocking) and the row is patched if
          // the hooks need a POV rewrite. See the post-insert block below.
          const scores = {
            novelty: { score: 7, rationale: 'Clone mode — structural fidelity over originality; product/angle swap adds freshness' },
            aggression: { score: 8, rationale: 'Preserved from proven original' },
            coherence: { score: 9, rationale: 'Structural clone maintains original flow and logic' },
            hook_body_blend: { score: 8, rationale: 'Validated post-insert by the blend agent (score patched if rewrite fires)' },
            conversion_potential: { score: 9, rationale: 'Proven structure with validated conversion path' },
            verdict: 'YES',
            _clone_fast_path: true,
          };
          const overall = (7 * 0.15) + (8 * 0.15) + (9 * 0.25) + (8 * 0.15) + (9 * 0.30); // 8.4

          // Record which model produced the clone so the operator can see
          // whether Opus landed or we fell back to Sonnet. Clears any prior
          // generation_error on success.
          await pgQuery(
            `UPDATE brief_pipeline_winners SET generation_error = NULL, generation_model = $1 WHERE id = $2`,
            [modelUsed, winner.id]
          ).catch(() => {});

          return {
            generated,
            scores,
            overall,
            direction: { id: 1, name: '1:1 Clone', description: 'Structural clone with product swap' },
            success: true,
          };
        } catch (err) {
          const fullErr = lastErr ? `${lastErr}; post-call: ${err.message}` : `${modelUsed}: ${err.message}`;
          await pgQuery(
            `UPDATE brief_pipeline_winners SET generation_error = $1, generation_model = $2 WHERE id = $3`,
            [fullErr, modelUsed || 'unknown', winner.id]
          ).catch(() => {});
          console.error(`[BriefPipeline] clone generation failed (${modelUsed}):`, err.message);
          return { direction: { id: 1, name: '1:1 Clone' }, success: false };
        }
      })()];

    } else {
      // VARIANTS MODE was removed per operator decision. Brief Pipeline
      // supports only mode='clone' and mode='iterate' now. Any other mode
      // (including 'variants') is rejected explicitly.
      throw new Error(`Unsupported generation mode "${mode}". Allowed: 'clone' or 'iterate'.`);
    }

    // Save results
    const generatedBriefs = [];
    for (const result of generationResults) {
      if (!result.success) continue;
      const { generated, scores, overall, direction } = result;
      const briefNumber = await allocateBriefNumber(briefNumberFloor, briefCounterId);
      const weekLabel = getCurrentWeekLabel();
      // Brief type derives from generation mode: clones of competitor ads
      // are Net New (NN); iterations of our own winners are IT. The mode
      // is set from the request body (clone | iterate) so this stays in
      // sync without re-querying the reference row.
      const briefType = isCloneMode ? 'NN' : 'IT';
      const nameAvatar = detectedAvatar || 'NA';
      const nameAngle  = effectiveAngle  || 'NA';
      const namingConvention = buildNamingConvention({
        // Naming uses the brand short code (Puure -> 'PL'); the DB
        // product_code column below stays PUURE for context lookups.
        product_code: namingProductCode(productCode || 'MR'), brief_number: briefNumber,
        parent_creative_id: creativeId, avatar: nameAvatar, angle: nameAngle,
        // Editor is deliberately omitted — buildNamingConvention filters null
        // slots, and the editor is assigned inside ClickUp after the brief is
        // pushed. Baking a name in here forces admins to rename in ClickUp.
        format: 'Mashup', strategist: 'Ludovico', creator: 'NA', editor: null, week: weekLabel,
        brief_type: briefType,
      });

      try {
        const inserted = await pgQuery(`
          INSERT INTO brief_pipeline_generated (
            winner_id, parent_creative_id, iteration_mode, aggressiveness,
            win_analysis, hooks, body, iteration_direction,
            novelty_score, aggression_score, coherence_score, overall_score,
            verdict, scores_json,
            brief_number, product_code, angle, format, avatar, editor,
            strategist, creator, naming_convention, status, highlighted_text
          ) VALUES (
            $1, $2, $3, $4, $5, $6, $7, $8,
            $9, $10, $11, $12, $13, $14,
            $15, $16, $17, $18, $19, $20,
            $21, $22, $23, 'generated', $24::jsonb
          ) RETURNING *
        `, [
          winner.id, creativeId, config.mode, 'medium',
          JSON.stringify(winAnalysis), JSON.stringify(generated.hooks),
          // The generated table has no cta column, so without this append the
          // cloned CTA never reaches the editor — the script arrives endless.
          (generated.cta && generated.cta.trim() && !generated.body.includes(generated.cta.trim()))
            ? `${generated.body}\n\n${generated.cta.trim()}`
            : generated.body,
          `${direction.name}: ${direction.description}`,
          // Iterate-mode briefs persist null scores intentionally (see
          // iterate-mode dispatch above). Variants/clones get real numbers.
          scores.novelty?.score    ?? null,
          scores.aggression?.score ?? null,
          scores.coherence?.score  ?? null,
          overall ?? null,
          scores.verdict || null,
          JSON.stringify(scores),
          briefNumber, productCode || 'MR',
          // For iterate mode, the angle column carries the iteration_label
          // so the column-card pill is meaningful (e.g. "Iteration 1 — pain-pivot").
          // For clone mode we persist the auto-detected angle (falls back to
          // 'NA' when detection had nothing to work with).
          isIterateMode ? (direction.name || 'Iteration') : nameAngle,
          isIterateMode ? 'Iteration' : 'Mashup',
          // avatar, editor, strategist, creator — editor stays NULL here
          // (assigned in ClickUp), same reason as the naming-convention slot.
          nameAvatar, null, 'Ludovico', 'NA', namingConvention,
          // On-screen labels — empty array when source has no overlays. We
          // never invent overlays (see clone rule §7 / iteration rule §9).
          JSON.stringify(Array.isArray(generated.highlighted_text) ? generated.highlighted_text : []),
        ], { timeout: 10000 });
        generatedBriefs.push({ ...inserted[0], scores, direction });
      } catch (dbErr) {
        console.error(`[BriefPipeline] DB insert error for direction #${direction.id}:`, dbErr.message);
      }
    }

    if (!generatedBriefs.length) {
      // All DB inserts failed or all generations failed
      await pgQuery(`UPDATE brief_pipeline_winners SET status = 'detected' WHERE id = $1`, [winner.id]);
      console.error('[BriefPipeline] generate-from-script: All brief generations failed');
      throw new Error('All brief generations failed');
    }

    // Rank (parallel updates)
    generatedBriefs.sort((a, b) => (b.overall_score || 0) - (a.overall_score || 0));
    await Promise.all(generatedBriefs.map((brief, i) => {
      brief.rank = i + 1;
      return pgQuery(`UPDATE brief_pipeline_generated SET rank = $1 WHERE id = $2`, [i + 1, brief.id]);
    }));

    // Mark virtual winner as detected (keeps it in the winning ads column)
    await pgQuery(`UPDATE brief_pipeline_winners SET status = 'detected' WHERE id = $1`, [winner.id]);

    // Link the originating reference to its newest brief so the UI (and the
    // operator) can always trace which brief came from which reference.
    if (referenceId && generatedBriefs[0]?.id) {
      await pgQuery(
        `UPDATE brief_pipeline_references SET generated_brief_id = $1, updated_at = NOW() WHERE id = $2`,
        [generatedBriefs[0].id, referenceId]
      ).catch(e => console.warn(`[BriefPipeline] could not link ref ${referenceId} to brief: ${e.message}`));
    }

    // Post-insert hook-body blend validation (clone mode) — off the critical
    // path so the brief is visible immediately. Two independent triggers rewrite
    // the hooks once and patch the row:
    //   (a) blend failure — hooks don't share the body's narrator/POV, or
    //   (b) a hook RESTATES the body's opening line (the signature-device opener
    //       shows up both as the body's first sentence and as H1). The hooks are
    //       5 alternative doors into the body, never a copy of the door the body
    //       already uses — see the clone prompt's no-restate rule.
    if (isCloneMode) {
      // Deterministic near-duplicate check between a hook and the body's opening.
      // Normalizes away punctuation and the "and" that joins two opener sentences
      // into one hook, then flags containment or high token overlap.
      const normDup = (s) => String(s || '').toLowerCase().replace(/[^a-z0-9 ]+/g, ' ').replace(/\band\b/g, ' ').replace(/\s+/g, ' ').trim();
      const hookDupesOpening = (hookText, body) => {
        const h = normDup(hookText);
        const b = normDup(String(body || '').split(/\n\n+/)[0]);
        if (h.length < 8 || b.length < 8) return false;
        if (b.includes(h) || h.includes(b)) return true;
        const ht = new Set(h.split(' ').filter(w => w.length > 2));
        const bt = new Set(b.split(' ').filter(w => w.length > 2));
        if (!ht.size) return false;
        let inter = 0; ht.forEach(w => { if (bt.has(w)) inter++; });
        return inter / (ht.size + bt.size - inter) >= 0.8;
      };
      for (const brief of generatedBriefs) {
        const gen = generationResults.find(r => r.success && r.generated)?.generated;
        if (!gen?.body || !Array.isArray(gen.hooks) || !gen.hooks.length) continue;
        (async () => {
          try {
            const { system: bvSys, user: bvUser } = await buildBlendValidationPrompt(gen);
            // Judge on Sonnet (default), not Haiku — thread-continuity is subtle.
            const blend = await callClaude(bvSys, bvUser, 1500);
            const blendScore = typeof blend?.overall_blend === 'number' ? blend.overall_blend : null;
            const perHook = Array.isArray(blend?.hooks) ? blend.hooks : [];
            const lowHook = perHook.some(h => typeof h?.blend_score === 'number' && h.blend_score < 7);
            const dupIdx = gen.hooks
              .map((h, i) => (hookDupesOpening(h.text || h, gen.body) ? i + 1 : null))
              .filter(Boolean);
            // Pass bar: overall >= 7.5 AND every hook >= 7. Anything less rewrites.
            const blendFail = (blendScore !== null && blendScore < 7.5) || lowHook;
            if (blendScore === null && !lowHook && !dupIdx.length) return;
            let hooks = gen.hooks;
            if (blendFail || dupIdx.length) {
              const reasons = [];
              if (blendFail) reasons.push(`blend below bar (overall ${blendScore ?? '?'}${lowHook ? ', a hook scored < 7' : ''}) — thread/topic seam vs the body`);
              if (dupIdx.length) reasons.push(`hook(s) ${dupIdx.map(i => 'H' + i).join(', ')} restate the body's opening line verbatim`);
              console.warn(`[BriefPipeline] brief ${brief.id}: rewriting hooks — ${reasons.join('; ')}`);
              const rewriteSys = 'You are a direct response copywriter. You fix hooks so they blend seamlessly into an existing ad script body. You never change the body.';
              const rewriteUser = `The 5 hooks below need fixing. Rewrite all 5 so each is speakable by the body's narrator, in the body's voice, and reads seamlessly into the body's first sentence. Keep them <= 20 words (H5 under 12), sentence case, no emoji, no dashes. The 5 hooks are 5 WAYS THROUGH THE SAME DOOR: every hook's final beat must set up the body's FIRST SENTENCE so it reads as the natural next line, no bridge. Vary them by EMOTIONAL ANGLE and PHRASING on that SAME setup (blunt, contrarian, pain callout, curiosity, short punch), NEVER by topic. Do not open a hook on a subject the body's first sentence does not continue (a clinical mechanism, a stat, a results timeline) — that is exactly the seam you are fixing.\n\nCRITICAL: NONE of the 5 hooks may restate the body's OPENING LINE. The hooks are 5 ways IN that all lead to the body's first sentence, never a verbatim copy of it. Even if the body opens on a signature gimmick, the hooks are alternative ways IN that lead to it — never the same sentence reworded, re-punctuated, or joined with "and".\n\nBODY:\n${gen.body}\n\nCURRENT HOOKS:\n${gen.hooks.map(h => `${h.id}: ${h.text || h}`).join('\n')}\n\nIssues:\n${blendFail ? `Blend issues: ${JSON.stringify(blend?.hooks || [])}\n` : ''}${dupIdx.length ? `Duplicate-of-opening: ${dupIdx.map(i => 'H' + i).join(', ')}\n` : ''}\nReturn ONLY valid JSON: { "hooks": [ { "id": "H1", "text": "..." }, ... 5 items ] }`;
              // Rewriting hooks is script generation → Opus, per operator directive.
              const fixed = await callClaude(rewriteSys, rewriteUser, 2000, { opus: true, timeoutMs: 180000 });
              if (Array.isArray(fixed?.hooks) && fixed.hooks.length === 5 && fixed.hooks.every(h => h?.text)) {
                hooks = gen.hooks.map((h, i) => ({ ...h, text: removeDashes(fixed.hooks[i].text) }));
              }
            }
            const recordScore = Math.round(blendScore !== null ? (blendFail ? 7 : blendScore) : 7);
            await pgQuery(
              `UPDATE brief_pipeline_generated
                  SET hooks = $1,
                      scores_json = jsonb_set(COALESCE(scores_json, '{}'::jsonb), '{hook_body_blend}',
                        jsonb_build_object('score', $2::int, 'rationale', 'Measured by blend validation agent post-insert'))
                WHERE id = $3`,
              [JSON.stringify(hooks), recordScore, brief.id]
            );
          } catch (e) {
            console.warn(`[BriefPipeline] post-insert blend validation skipped for brief ${brief.id}: ${e.message}`);
          }
        })();
      }
    }

    console.log(`[BriefPipeline] generate-from-script complete: ${generatedBriefs.length} briefs`);
    return { briefIds: generatedBriefs.map((b) => b.id) };
}

// GET /generation-status/:winnerId — poll for background generation completion
router.get('/generation-status/:winnerId', authenticate, async (req, res) => {
  try {
    const winnerId = req.params.winnerId;
    // Check winner status — pull generation_error + model so the UI can
    // surface the actual failure reason instead of a silent "failed".
    const winnerRows = await pgQuery(
      `SELECT id, status, creative_id, generation_error, generation_model
         FROM brief_pipeline_winners WHERE id = $1`,
      [winnerId]
    );
    if (!winnerRows.length) {
      return res.status(404).json({ success: false, error: { message: 'Winner not found' } });
    }
    const winner = winnerRows[0];

    // If still generating, return in-progress
    if (winner.status === 'generating') {
      return res.json({ success: true, status: 'generating', briefs: [] });
    }

    // Generation done (status reverted to 'detected') — check for generated briefs
    const briefs = await pgQuery(
      `SELECT * FROM brief_pipeline_generated WHERE winner_id = $1 ORDER BY rank ASC NULLS LAST, overall_score DESC NULLS LAST`,
      [winnerId]
    );

    // Fix double-encoded JSONB fields
    for (const b of briefs) {
      b.win_analysis = parseJsonb(b.win_analysis);
      b.hooks = parseJsonb(b.hooks);
      b.scores_json = parseJsonb(b.scores_json);
    }

    res.json({
      success: true,
      status: briefs.length > 0 ? 'complete' : 'failed',
      creative_id: winner.creative_id,
      briefs_generated: briefs.length,
      briefs,
      // Diagnostic — null on success, populated when the clone failed.
      generation_error: winner.generation_error || null,
      generation_model: winner.generation_model || null,
    });
  } catch (err) {
    console.error('[BriefPipeline] GET /generation-status error:', err.message);
    res.status(500).json({ success: false, error: { message: err.message } });
  }
});

// GET /generated — list all generated briefs
router.get('/generated', authenticate, async (_req, res) => {
  try {
    await ensureTables();
    // Includes the originating reference (when known) inline on every row
    // so the kanban-served brief object carries enough data for the detail
    // modal to render the Source Reference panel without a second fetch.
    const rows = await pgQuery(
      `SELECT g.*,
              w.parsed_script AS original_script,
              w.raw_script    AS original_raw_script,
              r.id            AS reference_id,
              r.source        AS reference_source,
              r.brand_name    AS reference_brand_name,
              r.headline      AS reference_headline,
              r.video_url     AS reference_video_url,
              r.thumbnail_url AS reference_thumbnail_url,
              r.source_url    AS reference_source_url
         FROM brief_pipeline_generated g
         LEFT JOIN brief_pipeline_winners    w ON g.winner_id = w.id
         LEFT JOIN brief_pipeline_references r ON w.reference_id = r.id
        WHERE g.status != 'rejected'
        ORDER BY g.created_at DESC`
    );
    // Fix double-encoded JSONB fields
    for (const b of rows) {
      b.win_analysis = parseJsonb(b.win_analysis);
      b.hooks = parseJsonb(b.hooks);
      b.scores_json = parseJsonb(b.scores_json);
      b.original_script = parseJsonb(b.original_script);
      // highlighted_text was stored as TEXT '"[]"' on early B0391 row before
      // the JSONB coercion ran. Defensive parse so UI consumers always see
      // a real array.
      b.highlighted_text = (() => {
        const raw = b.highlighted_text;
        if (Array.isArray(raw)) return raw;
        if (typeof raw === 'string') {
          try { const arr = JSON.parse(raw); return Array.isArray(arr) ? arr : []; }
          catch { return []; }
        }
        return [];
      })();
      // Mirror /generated/:id — surface the originating reference inline so
      // the modal (which opens with the list-item, not a refetch) has it.
      if (b.reference_id) {
        b.reference = {
          id: b.reference_id,
          source: b.reference_source,
          brandName: b.reference_brand_name,
          headline: b.reference_headline,
          videoUrl: b.reference_video_url,
          thumbnailUrl: b.reference_thumbnail_url,
          sourceUrl: b.reference_source_url,
        };
      } else {
        b.reference = null;
      }
    }
    res.json({ success: true, briefs: rows });
  } catch (err) {
    console.error('[BriefPipeline] GET /generated error:', err.message);
    res.status(500).json({ success: false, error: { message: err.message } });
  }
});

// GET /generated/:id — get generated brief detail
router.get('/generated/:id', authenticate, async (req, res) => {
  if (!validateUuid(req, res)) return;
  try {
    await ensureTables();
    const rows = await pgQuery(
      `SELECT g.*,
              w.parsed_script AS original_script,
              w.raw_script    AS original_raw_script,
              w.reference_id  AS winner_reference_id,
              r.id            AS reference_id,
              r.source        AS reference_source,
              r.brand_name    AS reference_brand_name,
              r.headline      AS reference_headline,
              r.video_url     AS reference_video_url,
              r.thumbnail_url AS reference_thumbnail_url,
              r.source_url    AS reference_source_url
         FROM brief_pipeline_generated g
         LEFT JOIN brief_pipeline_winners    w ON g.winner_id = w.id
         LEFT JOIN brief_pipeline_references r ON w.reference_id = r.id
        WHERE g.id = $1`,
      [req.params.id]
    );
    if (!rows.length) {
      return res.status(404).json({ success: false, error: { message: 'Brief not found' } });
    }
    // Fix double-encoded JSONB fields
    const brief = rows[0];
    brief.win_analysis = parseJsonb(brief.win_analysis);
    brief.hooks = parseJsonb(brief.hooks);
    brief.scores_json = parseJsonb(brief.scores_json);
    brief.original_script = parseJsonb(brief.original_script);
    brief.highlighted_text = (() => {
      const raw = brief.highlighted_text;
      if (Array.isArray(raw)) return raw;
      if (typeof raw === 'string') {
        try { const arr = JSON.parse(raw); return Array.isArray(arr) ? arr : []; }
        catch { return []; }
      }
      return [];
    })();
    // Surface the originating reference (when known) so the modal can
    // render a video player + "watch source" link without a second
    // round-trip. NULL when the brief was generated from a raw script
    // paste with no upstream reference attached.
    if (brief.reference_id) {
      brief.reference = {
        id: brief.reference_id,
        source: brief.reference_source,
        brandName: brief.reference_brand_name,
        headline: brief.reference_headline,
        videoUrl: brief.reference_video_url,
        thumbnailUrl: brief.reference_thumbnail_url,
        sourceUrl: brief.reference_source_url,
      };
    } else {
      brief.reference = null;
    }
    res.json({ success: true, brief });
  } catch (err) {
    console.error('[BriefPipeline] GET /generated/:id error:', err.message);
    res.status(500).json({ success: false, error: { message: err.message } });
  }
});

// PATCH /generated/:id — update status (approve/reject)
router.patch('/generated/:id', authenticate, async (req, res) => {
  if (!validateUuid(req, res)) return;
  try {
    await ensureTables();
    const reqBody = req.body || {};
    const { status: newStatus, hooks, body: briefBody, highlighted_text: ht } = reqBody;

    let contentUpdated = false;
    let contentResult = null;

    // If content edit (hooks/body/highlighted_text) - handle this BEFORE status change
    if (hooks !== undefined || briefBody !== undefined || ht !== undefined) {
      const setClauses = [];
      const params = [];
      let idx = 1;
      if (hooks !== undefined) { setClauses.push(`hooks = $${idx++}`); params.push(JSON.stringify(hooks)); }
      if (briefBody !== undefined) { setClauses.push(`body = $${idx++}`); params.push(briefBody); }
      if (ht !== undefined) {
        // Accept array or stringified array; normalize to JSON. Cast to jsonb
        // so older TEXT-shaped rows still accept the value cleanly.
        const arr = Array.isArray(ht)
          ? ht.filter(Boolean).map(String).slice(0, 4)
          : (typeof ht === 'string' ? (() => { try { const a = JSON.parse(ht); return Array.isArray(a) ? a.filter(Boolean).map(String).slice(0, 4) : []; } catch { return []; } })() : []);
        setClauses.push(`highlighted_text = $${idx++}::jsonb`);
        params.push(JSON.stringify(arr));
      }
      params.push(req.params.id);
      const rows = await pgQuery(
        `UPDATE brief_pipeline_generated SET ${setClauses.join(', ')} WHERE id = $${idx} RETURNING *`,
        params
      );
      if (!rows.length) return res.status(404).json({ success: false, error: { message: 'Brief not found' } });
      contentUpdated = true;
      contentResult = rows[0];
      if (!newStatus) {
        // Fix double-encoded JSONB fields before returning
        const retBrief = rows[0];
        retBrief.hooks = parseJsonb(retBrief.hooks);
        retBrief.win_analysis = parseJsonb(retBrief.win_analysis);
        retBrief.scores_json = parseJsonb(retBrief.scores_json);
        retBrief.highlighted_text = (() => {
          const raw = retBrief.highlighted_text;
          if (Array.isArray(raw)) return raw;
          if (typeof raw === 'string') { try { const a = JSON.parse(raw); return Array.isArray(a) ? a : []; } catch { return []; } }
          return [];
        })();
        return res.json({ success: true, brief: retBrief });
      }
    }

    const validStatuses = ['approved', 'rejected', 'ready_to_launch', 'launched', 'launch_failed', 'generated', 'pushed'];
    if (!validStatuses.includes(newStatus)) {
      return res.status(400).json({ success: false, error: { message: `Status must be one of: ${validStatuses.join(', ')}` } });
    }

    // Allow specific transitions
    const allowedFrom = {
      approved: ['generated'],
      rejected: ['generated'],
      ready_to_launch: ['approved'],
      launched: ['ready_to_launch', 'launching'],
      launch_failed: ['ready_to_launch', 'launching'],
      pushed: ['approved'],
      generated: ['approved', 'rejected'], // allow un-approve
    };
    const fromStatuses = allowedFrom[newStatus] || [];
    const extra = newStatus === 'approved' ? ', approved_at = NOW()' : newStatus === 'launched' ? ', launched_at = NOW()' : '';
    const placeholders = fromStatuses.map((_, i) => `$${i + 3}`).join(',');
    const rows = await pgQuery(
      `UPDATE brief_pipeline_generated SET status = $1${extra} WHERE id = $2 AND status IN (${placeholders}) RETURNING *`,
      [newStatus, req.params.id, ...fromStatuses]
    );

    if (!rows.length) {
      // Check if brief exists but is in wrong status
      const existing = await pgQuery(`SELECT id, status FROM brief_pipeline_generated WHERE id = $1`, [req.params.id]);
      if (existing.length) {
        // If content was already saved, return 200 with a warning instead of 409
        if (contentUpdated) {
          return res.json({
            success: true,
            brief: contentResult,
            warning: `Content was saved, but status could not be changed — brief is already "${existing[0].status}".`
          });
        }
        return res.status(409).json({ success: false, error: { message: `Brief is already "${existing[0].status}" and cannot be changed.` } });
      }
    }

    if (!rows.length) {
      return res.status(404).json({ success: false, error: { message: 'Brief not found' } });
    }

    // Fix double-encoded JSONB fields before returning
    const patchedBrief = rows[0];
    patchedBrief.hooks = parseJsonb(patchedBrief.hooks);
    patchedBrief.win_analysis = parseJsonb(patchedBrief.win_analysis);
    patchedBrief.scores_json = parseJsonb(patchedBrief.scores_json);
    res.json({ success: true, brief: patchedBrief });
  } catch (err) {
    console.error('[BriefPipeline] PATCH /generated/:id error:', err.message);
    res.status(500).json({ success: false, error: { message: err.message } });
  }
});

// DELETE /generated/:id — permanently delete a generated brief
router.delete('/generated/:id', authenticate, async (req, res) => {
  if (!validateUuid(req, res)) return;
  try {
    await ensureTables();
    const rows = await pgQuery(
      `DELETE FROM brief_pipeline_generated WHERE id = $1 RETURNING id`,
      [req.params.id]
    );
    if (!rows.length) {
      return res.status(404).json({ success: false, error: { message: 'Brief not found' } });
    }
    res.json({ success: true });
  } catch (err) {
    console.error('[BriefPipeline] DELETE /generated/:id error:', err.message);
    res.status(500).json({ success: false, error: { message: err.message } });
  }
});

// (dedupe-recent moved above the router-wide authenticate guard, near line 224)

// POST /generated/:id/enhance — AI enhancement endpoint
router.post('/generated/:id/enhance', authenticate, async (req, res) => {
  if (!validateUuid(req, res)) return;
  try {
    const { instruction, currentHooks, currentBody, currentHighlightedText } = req.body || {};

    if (!instruction?.trim()) {
      return res.status(400).json({ success: false, error: { message: 'Instruction is required' } });
    }

    // Verify brief exists and get product context
    const rows = await pgQuery(`SELECT * FROM brief_pipeline_generated WHERE id = $1`, [req.params.id]);
    if (!rows.length) return res.status(404).json({ success: false, error: { message: 'Brief not found' } });

    const brief = rows[0];

    // Load the competitor source this brief was cloned from, so the editor can
    // restore/readapt the source's signature hook on request. Without this the
    // enhance prompt only sees our own current hooks and can never recover the
    // competitor's proven scroll stopper. Manual briefs have no winner_id and
    // simply get no source block (best-effort — never blocks the edit).
    let sourceBlock = '';
    if (brief.winner_id) {
      try {
        const srcRows = await pgQuery(
          `SELECT w.parsed_script, w.raw_script, r.headline AS ref_headline
             FROM brief_pipeline_winners w
             LEFT JOIN brief_pipeline_references r ON w.reference_id = r.id
            WHERE w.id = $1 LIMIT 1`,
          [brief.winner_id]
        );
        if (srcRows.length) {
          const parsed = parseJsonb(srcRows[0].parsed_script) || {};
          const srcHooks = Array.isArray(parsed.hooks)
            ? parsed.hooks.map((h, i) => `${(h && h.id) || 'H' + (i + 1)}: ${(h && h.text) || h}`).join('\n')
            : '';
          const srcBodyOpen = typeof parsed.body === 'string' ? parsed.body.slice(0, 320) : '';
          const srcOverlays = extractOnScreenText(srcRows[0].raw_script) || '';
          sourceBlock = `ORIGINAL COMPETITOR AD (the proven winner this brief was cloned from. Use ONLY if the edit instruction asks to restore/fix/readapt the source's hook):
--- Source hooks ---
${srcHooks || '(none parsed)'}
--- Source body opening ---
${srcBodyOpen || '(none)'}
--- Source on-screen overlays ---
${srcOverlays || '(none detected)'}

`;
        }
      } catch (srcErr) {
        console.warn('[BriefPipeline] enhance: could not load source reference:', srcErr.message);
      }
    }

    // Fetch product profile for context
    let productContextStr = '';
    try {
      const productProfile = await fetchProductProfile(brief.product_code || 'MR');
      if (productProfile) {
        productContextStr = buildProductContextForBrief(productProfile);
      }
    } catch (profileErr) {
      console.warn('[BriefPipeline] Could not fetch product profile for enhance:', profileErr.message);
    }

    const hooksFormatted = (currentHooks || []).map((h, i) => `Hook ${i+1}: ${h.text}${h.mechanism ? ` [${h.mechanism}]` : ''}`).join('\n');
    const highlightedArr = Array.isArray(currentHighlightedText)
      ? currentHighlightedText
      : (typeof currentHighlightedText === 'string'
          ? (() => { try { const a = JSON.parse(currentHighlightedText); return Array.isArray(a) ? a : []; } catch { return []; } })()
          : []);
    const highlightedFormatted = highlightedArr.length
      ? highlightedArr.map((s, i) => `Label ${i+1}: ${s}`).join('\n')
      : '(no on-screen labels)';

    const enhanceSystem = `You are an expert direct-response copywriter and creative strategist specializing in Facebook UGC-style video ad scripts. You make precise, surgical edits to existing scripts and hooks without touching anything outside the scope of the edit request. You never use em dashes or hyphens inside any copy. You use periods, line breaks, or rewrite sentence structure instead.${productContextStr ? ' You have access to the product brief and compliance rules. Never invent claims not present in the product profile.' : ''}`;

    const enhanceUser = `You are enhancing an existing piece of ad copy. Your job is to make only the change requested. Do not rewrite, improve, or touch anything outside the scope of the edit instruction.

Read the full existing copy first. Understand its structure, tone, perspective, avatar, and emotional flow before making any change. Then apply only the edit requested.

${productContextStr ? `PRODUCT CONTEXT:\n${productContextStr}\n\n` : ''}${sourceBlock}EXISTING COPY:
--- Highlighted Text (on-screen overlays) ---
${highlightedFormatted}

--- Hooks ---
${hooksFormatted}

--- Body ---
${currentBody || '(no body)'}

---

EDIT INSTRUCTION: ${instruction}

---

EDIT RULES:

1. SCOPE LOCK: Only change what the edit instruction targets. If the instruction says change hook 1, only hook 1 changes. If it says change a specific phrase, only that phrase changes. Everything else must remain word for word identical.

2. CONTINUITY: The edited element must match the tone, register, perspective, pronouns, and emotional flow of the surrounding copy. Read the line before and the line after the edit target. The new version must feel like it was always there.

3. PERSPECTIVE LOCK: Maintain the exact same speaker frame and pronoun structure as the existing copy. If the existing copy speaks to a gift buyer about a third person, the edit must do the same. Never shift perspective during an edit.

4. COMPLIANCE: Never directly promise the viewer will win or earn money. Never use em dashes or hyphens. All pricing in USD. Never invent product claims not present in the product profile.

5. HOOK SPECIFIC RULES: If the edit target is a hook, the new version must still pass: perspective matches the body opener, tension created by the hook is resolved by the first line of the body, no bridge line is needed between hook and body. If any check fails, rewrite before outputting.

5B. SIGNATURE HOOK RESTORE: If the instruction asks to restore, fix, bring back, or use the competitor's main / original / signature hook, read the ORIGINAL COMPETITOR AD block above and find its single strongest scroll stopper. It may be one of the source hooks, the source body's opening line, or an ALL CAPS overlay (e.g. "EVERYTHING YOU'VE BEEN TOLD ABOUT FIRMING ARM SKIN"). Rewrite THAT hook for OUR product in spoken sentence case form, product noun and category swapped, its contrarian / curiosity / myth bust shape kept otherwise, and make it H1. Keep all other hooks unchanged unless the instruction says otherwise, and return the full hook list. If no ORIGINAL COMPETITOR AD block is present, make no change and say so in edit_summary.

6. HIGHLIGHTED TEXT RULES: If the instruction targets the on-screen labels (e.g. "make the discount label more aggressive", "add an apology overlay", "shorten the comment-reply"), edit only highlighted_text. Each label: ≤ 5 words, ALL CAPS where appropriate, exactly 1 emoji at the end. Operator may explicitly request adding overlays even if none currently exist — that is allowed. If the instruction does not touch highlighted_text, return it unchanged.

7. VARIANT LOGIC: If the edit instruction asks for a new variant or alternative rather than a replacement, include both the original and the new variant in the output.

8. SELF CHECK: Before outputting, read the full copy with the edit applied from start to finish. Confirm it reads as one seamless piece. Confirm no rules were broken.

Return ONLY valid JSON, no markdown fences:
{
  "highlighted_text": ["LABEL 1 + emoji", "LABEL 2 + emoji"],
  "hooks": [
    { "id": "H1", "text": "...", "mechanism": "..." },
    { "id": "H2", "text": "...", "mechanism": "..." },
    { "id": "H3", "text": "...", "mechanism": "..." }
  ],
  "body": "the complete body text with edit applied",
  "edit_summary": "one sentence describing what was changed and why it fits"
}`;

    const enhanced = await callClaude(enhanceSystem, enhanceUser, 3000);

    if (!enhanced || (!enhanced.hooks && !enhanced.body && !enhanced.highlighted_text)) {
      return res.status(500).json({ success: false, error: { message: 'AI returned invalid response structure' } });
    }

    // Normalize highlighted_text — if missing/null, fall back to current
    let outHighlighted;
    if (Array.isArray(enhanced.highlighted_text)) {
      outHighlighted = enhanced.highlighted_text.filter(Boolean).map(String).slice(0, 4);
    } else {
      outHighlighted = highlightedArr;
    }

    res.json({
      success: true,
      hooks: enhanced.hooks || currentHooks,
      body: enhanced.body || currentBody,
      highlighted_text: outHighlighted,
      edit_summary: enhanced.edit_summary || null,
    });
  } catch (err) {
    console.error('[BriefPipeline] POST /generated/:id/enhance error:', err.message);
    res.status(500).json({ success: false, error: { message: err.message } });
  }
});

// POST /generated/:id/push — push approved brief to ClickUp
router.post('/generated/:id/push', authenticate, async (req, res) => {
  if (!validateUuid(req, res)) return;
  try {
    await ensureTables();
    const rows = await pgQuery(
      `SELECT * FROM brief_pipeline_generated WHERE id = $1`,
      [req.params.id]
    );
    if (!rows.length) {
      return res.status(404).json({ success: false, error: { message: 'Brief not found' } });
    }

    const brief = rows[0];
    // Fix double-encoded JSONB fields before use
    brief.hooks = parseJsonb(brief.hooks);
    brief.win_analysis = parseJsonb(brief.win_analysis);
    brief.scores_json = parseJsonb(brief.scores_json);

    if (brief.status !== 'approved') {
      return res.status(400).json({ success: false, error: { message: 'Brief must be approved before pushing to ClickUp' } });
    }

    if (brief.clickup_task_id) {
      return res.status(400).json({ success: false, error: { message: 'Brief already pushed to ClickUp' } });
    }

    // Look up parent winner's ClickUp task ID for the Frame.io reference link
    let parentClickupTaskId = null;
    if (brief.winner_id) {
      const winnerRows = await pgQuery(`SELECT clickup_task_id FROM brief_pipeline_winners WHERE id = $1`, [brief.winner_id]);
      parentClickupTaskId = winnerRows[0]?.clickup_task_id || null;
    }

    const result = await pushBriefToClickUp(brief, parentClickupTaskId);

    await pgQuery(
      `UPDATE brief_pipeline_generated
       SET status = 'pushed', clickup_task_id = $1, clickup_task_url = $2, pushed_at = NOW()
       WHERE id = $3`,
      [result.taskId, result.taskUrl, brief.id]
    );

    res.json({
      success: true,
      brief_id: brief.id,
      clickup_task_id: result.taskId,
      clickup_task_url: result.taskUrl,
      naming_convention: result.namingConvention,
    });
  } catch (err) {
    console.error('[BriefPipeline] POST /generated/:id/push error:', err.message);
    res.status(500).json({ success: false, error: { message: err.message } });
  }
});

// GET /generated/:id/clickup-prefill — returns brief field defaults + dropdown
// options in one call, ready for the PushToClickupModal to display.
//
// Auto-fill mapping:
//   Product       ← brief.product_code (default MR)
//   Angle         ← brief.angle (default NA)
//   Creative Type ← brief.format (default Mashup)
//   Brief Type    ← IT (locked — every Brief Pipeline brief is an iteration)
//   Editor        ← brief.editor (if set, else empty)
//   Avatar        ← brief.avatar
//   Idea / Hook   ← first hook from brief.hooks[] or iteration_direction
//   Brief Text    ← formatted hooks + body
//   Reference Link ← parent winner's ClickUp Frame.io link (auto-resolved)
//   Parent Brief  ← parent_creative_id (e.g. "B0223" — used in task naming)
router.get('/generated/:id/clickup-prefill', authenticate, async (req, res) => {
  if (!validateUuid(req, res)) return;
  try {
    await ensureTables();
    const rows = await pgQuery(
      `SELECT * FROM brief_pipeline_generated WHERE id = $1`,
      [req.params.id]
    );
    if (!rows.length) {
      return res.status(404).json({ success: false, error: { message: 'Brief not found' } });
    }
    const brief = rows[0];
    brief.hooks = parseJsonb(brief.hooks);

    // Resolve Reference link via the same fallback chain as the actual push:
    // operator override (set in the modal) → parent ClickUp Frame.io link →
    // reference.source_url via winner.reference_id. Editors get a link in
    // every task regardless of how the source was imported.
    let referenceLink = '';
    if (brief.winner_id) {
      try {
        const winnerRows = await pgQuery(
          `SELECT clickup_task_id, reference_id FROM brief_pipeline_winners WHERE id = $1`,
          [brief.winner_id],
        );
        const parentTaskId = winnerRows[0]?.clickup_task_id;
        const refId = winnerRows[0]?.reference_id;
        if (parentTaskId) {
          try {
            const parentTask = await clickupFetch(`/task/${parentTaskId}`);
            const frameField = parentTask.custom_fields?.find(f => f.id === FIELD_IDS.adsFrameLink);
            if (frameField?.value) referenceLink = frameField.value;
          } catch (e) {
            console.warn('[BriefPipeline] prefill: parent frame lookup failed:', e.message);
          }
        }
        if (!referenceLink && refId) {
          const refRows = await pgQuery(`SELECT source_url FROM brief_pipeline_references WHERE id = $1`, [refId]);
          if (refRows[0]?.source_url) referenceLink = refRows[0].source_url;
        }
      } catch (e) {
        console.warn('[BriefPipeline] prefill: reference resolve failed:', e.message);
      }
    }

    // Build a "brief text" preview from hooks + body
    const parsedHooks = Array.isArray(brief.hooks) ? brief.hooks : [];
    const hooksFormatted = parsedHooks
      .map((h, i) => `Hook ${i + 1}: ${h.text || ''}`.trim())
      .join('\n');
    const briefText = [
      hooksFormatted,
      brief.body ? `\n--- Body ---\n${brief.body}` : '',
    ].filter(Boolean).join('\n').trim();

    // Editor list — use cached/dynamic editor map
    let editors = [];
    try {
      const editorMap = await getEditors(pipelineForProduct(brief.product_code).listId);
      editors = Object.keys(editorMap).sort();
    } catch (e) {
      console.warn('[BriefPipeline] prefill: editor list fetch failed:', e.message);
    }

    // highlighted_text is stored as JSONB[]. Default to empty array so the
    // modal can render its (forthcoming) ON-SCREEN ELEMENTS section
    // conditionally — render only when length > 0.
    const highlightedText = (() => {
      const raw = brief.highlighted_text;
      if (Array.isArray(raw)) return raw;
      if (typeof raw === 'string') {
        try { const arr = JSON.parse(raw); return Array.isArray(arr) ? arr : []; }
        catch { return []; }
      }
      return [];
    })().map((s) => String(s || '').trim()).filter(Boolean);

    // Derive brief type from the brief's stored generation mode: clones of
    // competitor ads default to NN (Net New), iterations of our winners to
    // IT. Modal field is no longer locked — operator can override before
    // pushing. Parent Brief ID is meaningful only for IT.
    const defaultBriefType = brief.iteration_mode === 'clone' ? 'NN' : 'IT';
    res.json({
      success: true,
      defaults: {
        product:        brief.product_code || 'MR',
        angle:          normalizeAngleKey(brief.angle),
        angleDisplay:   brief.angle || null,
        creativeType:   brief.format || 'Mashup',
        briefType:      defaultBriefType,
        editor:         brief.editor || '',
        avatar:         brief.avatar || 'NA',
        idea:           brief.iteration_direction || (parsedHooks[0]?.text?.slice(0, 80)) || '',
        briefText,
        highlightedText,
        referenceLink,
        parentBriefId:  defaultBriefType === 'IT' ? (brief.parent_creative_id || '') : '',
        briefNumber:    brief.brief_number,
        namingConvention: brief.naming_convention || '',
      },
      options: {
        angles:        Object.keys(ANGLE_OPTIONS),
        creativeTypes: Object.keys(CREATIVE_TYPE_OPTIONS),
        briefTypes:    Object.keys(BRIEF_TYPE_OPTIONS),
        editors,
        avatars:       Object.keys(AVATAR_TASK_IDS),
        products:      Object.keys(PRODUCT_TASK_IDS),
        creativeTypeCodes: CREATIVE_TYPE_CODES,
      },
    });
  } catch (err) {
    console.error('[BriefPipeline] GET /generated/:id/clickup-prefill error:', err.message);
    res.status(500).json({ success: false, error: { message: err.message } });
  }
});

// POST /generated/:id/push-to-clickup — operator-driven push with modal overrides.
//
// Differs from POST /generated/:id/push (which uses brief defaults silently):
//   * Accepts an `overrides` payload from the PushToClickupModal
//   * Allows editor / avatar / angle / Frame link / brief text override
//   * Sets brief status to 'ready_to_launch' (displays as "Ready ClickUp")
//     instead of 'pushed' — so the brief lands in the renamed column.
router.post('/generated/:id/push-to-clickup', authenticate, async (req, res) => {
  if (!validateUuid(req, res)) return;
  try {
    await ensureTables();
    const rows = await pgQuery(
      `SELECT * FROM brief_pipeline_generated WHERE id = $1`,
      [req.params.id]
    );
    if (!rows.length) {
      return res.status(404).json({ success: false, error: { message: 'Brief not found' } });
    }
    const brief = rows[0];
    brief.hooks = parseJsonb(brief.hooks);
    brief.win_analysis = parseJsonb(brief.win_analysis);
    brief.scores_json = parseJsonb(brief.scores_json);

    // ALREADY_PUSHED takes precedence over NOT_APPROVED because the more
    // specific failure ("you already sent this to ClickUp") is more
    // actionable than the generic status check. A brief that already has a
    // clickup_task_id has by definition transitioned out of 'approved'
    // (status='ready_to_launch'), so without this ordering operators would
    // always see NOT_APPROVED on a re-push attempt and miss the link to the
    // existing task.
    if (brief.clickup_task_id) {
      return res.status(409).json({
        success: false,
        error: {
          code: 'ALREADY_PUSHED',
          message: 'Brief already has a ClickUp task — cannot push twice.',
          clickup_task_url: brief.clickup_task_url,
        },
      });
    }
    if (brief.status !== 'approved') {
      return res.status(409).json({
        success: false,
        error: {
          code: 'NOT_APPROVED',
          message: `Brief must be in 'approved' status before pushing to ClickUp. Current status: '${brief.status}'.`,
        },
      });
    }

    // Operator overrides from modal. All optional — anything not provided
    // falls back to the brief's stored value inside pushBriefToClickUp.
    const overrides = req.body || {};

    // Look up parent winner's ClickUp task for Frame.io auto-resolution
    let parentClickupTaskId = null;
    if (brief.winner_id) {
      const winnerRows = await pgQuery(`SELECT clickup_task_id FROM brief_pipeline_winners WHERE id = $1`, [brief.winner_id]);
      parentClickupTaskId = winnerRows[0]?.clickup_task_id || null;
    }

    const result = await pushBriefToClickUp(brief, parentClickupTaskId, overrides);

    // Move to 'ready_to_launch' (column relabelled "Ready ClickUp")
    await pgQuery(
      `UPDATE brief_pipeline_generated
         SET status = 'ready_to_launch',
             clickup_task_id = $1,
             clickup_task_url = $2,
             naming_convention = $3,
             pushed_at = NOW()
       WHERE id = $4`,
      [result.taskId, result.taskUrl, result.namingConvention, brief.id]
    );

    res.json({
      success: true,
      brief_id: brief.id,
      clickup_task_id: result.taskId,
      clickup_task_url: result.taskUrl,
      naming_convention: result.namingConvention,
    });
  } catch (err) {
    console.error('[BriefPipeline] POST /generated/:id/push-to-clickup error:', err.message);
    res.status(500).json({ success: false, error: { message: err.message } });
  }
});

// POST /batch-push — push all approved briefs to ClickUp
router.post('/batch-push', authenticate, async (_req, res) => {
  try {
    await ensureTables();
    const approvedRows = await pgQuery(
      `SELECT g.*, w.clickup_task_id AS parent_clickup_task_id
       FROM brief_pipeline_generated g
       LEFT JOIN brief_pipeline_winners w ON g.winner_id = w.id
       WHERE g.status = 'approved' AND g.clickup_task_id IS NULL
       ORDER BY g.rank ASC`
    );

    if (!approvedRows.length) {
      return res.json({ success: true, pushed: 0, message: 'No approved briefs to push' });
    }

    const results = [];
    const errors = [];

    for (const brief of approvedRows) {
      try {
        const result = await pushBriefToClickUp(brief, brief.parent_clickup_task_id);

        await pgQuery(
          `UPDATE brief_pipeline_generated
           SET status = 'pushed', clickup_task_id = $1, clickup_task_url = $2, pushed_at = NOW()
           WHERE id = $3`,
          [result.taskId, result.taskUrl, brief.id]
        );

        results.push({
          brief_id: brief.id,
          clickup_task_id: result.taskId,
          clickup_task_url: result.taskUrl,
          naming_convention: result.namingConvention,
        });
      } catch (pushErr) {
        console.error(`[BriefPipeline] Batch push error for ${brief.id}:`, pushErr.message);
        errors.push({ brief_id: brief.id, error: pushErr.message });
      }
    }

    res.json({
      success: true,
      pushed: results.length,
      failed: errors.length,
      results,
      errors: errors.length ? errors : undefined,
    });
  } catch (err) {
    console.error('[BriefPipeline] POST /batch-push error:', err.message);
    res.status(500).json({ success: false, error: { message: err.message } });
  }
});

// GET /stats — pipeline stats (counts per column)
router.get('/stats', authenticate, async (_req, res) => {
  try {
    await ensureTables();

    const winnerStats = await pgQuery(`
      SELECT status, COUNT(*)::int as count
      FROM brief_pipeline_winners
      GROUP BY status
    `);

    const briefStats = await pgQuery(`
      SELECT status, COUNT(*)::int as count
      FROM brief_pipeline_generated
      GROUP BY status
    `);

    const stats = {
      detected: 0,
      selected: 0,
      generating: 0,
      generated: 0,
      approved: 0,
      rejected: 0,
      pushed: 0,
    };

    for (const row of winnerStats) {
      if (row.status in stats) stats[row.status] = row.count;
    }
    for (const row of briefStats) {
      if (row.status in stats) stats[row.status] += row.count;
      else stats[row.status] = row.count;
    }

    res.json({ success: true, stats });
  } catch (err) {
    console.error('[BriefPipeline] GET /stats error:', err.message);
    res.status(500).json({ success: false, error: { message: err.message } });
  }
});

// ── Settings: Prompt management ──────────────────────────────────────

// Default prompt descriptions for the UI

// Cache for custom prompts from DB

// ═══════════════════════════════════════════════════════════════════════
// LAUNCH TEMPLATES & COPY SETS
// ═══════════════════════════════════════════════════════════════════════

let launchTablesPromise = null;
async function ensureLaunchTables() {
  if (launchTablesPromise) return launchTablesPromise;
  launchTablesPromise = _initLaunchTables().catch(err => {
    launchTablesPromise = null;
    throw err;
  });
  return launchTablesPromise;
}
async function _initLaunchTables() {
  await pgQuery(`
    CREATE TABLE IF NOT EXISTS launch_templates (
      id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      name TEXT NOT NULL,
      ad_account_id TEXT NOT NULL,
      ad_account_name TEXT,
      page_mode TEXT DEFAULT 'single',
      page_ids JSONB DEFAULT '[]',
      pixel_id TEXT,
      pixel_name TEXT,
      campaign_id TEXT,
      campaign_name TEXT,
      adset_name_pattern TEXT DEFAULT '{date} - {angle} - Batch {batch}',
      ad_name_pattern TEXT DEFAULT '{date} - {angle} {num}',
      conversion_location TEXT DEFAULT 'WEBSITE',
      conversion_event TEXT DEFAULT 'PURCHASE',
      daily_budget NUMERIC(10,2) DEFAULT 150,
      performance_goal TEXT DEFAULT 'OFFSITE_CONVERSIONS',
      optimization_goal TEXT DEFAULT 'OFFSITE_CONVERSIONS',
      bid_strategy TEXT DEFAULT 'LOWEST_COST_WITHOUT_CAP',
      target_roas NUMERIC(6,2),
      attribution_window TEXT DEFAULT '7d_click',
      include_audiences JSONB DEFAULT '[]',
      exclude_audiences JSONB DEFAULT '[]',
      countries JSONB DEFAULT '["US"]',
      age_min INTEGER DEFAULT 18,
      age_max INTEGER DEFAULT 65,
      gender TEXT DEFAULT 'all',
      ad_format TEXT DEFAULT 'FLEXIBLE',
      utm_parameters TEXT DEFAULT 'tw_source={{site_source_name}}&tw_adid={{ad.id}}',
      landing_page_url TEXT,
      translation_languages JSONB DEFAULT '[]',
      product_id INTEGER,
      is_default BOOLEAN DEFAULT false,
      created_by UUID,
      created_at TIMESTAMPTZ DEFAULT NOW(),
      updated_at TIMESTAMPTZ DEFAULT NOW()
    )
  `);
  // Migrations for existing tables
  await pgQuery(`ALTER TABLE launch_templates ADD COLUMN IF NOT EXISTS landing_page_url TEXT`).catch(() => {});
  await pgQuery(`ALTER TABLE launch_templates ADD COLUMN IF NOT EXISTS schedule_enabled BOOLEAN DEFAULT false`).catch(() => {});
  await pgQuery(`ALTER TABLE launch_templates ADD COLUMN IF NOT EXISTS schedule_date TEXT`).catch(() => {});
  await pgQuery(`ALTER TABLE launch_templates ADD COLUMN IF NOT EXISTS schedule_time TEXT DEFAULT '00:00'`).catch(() => {});
  // Fix invalid optimization_goal values (PURCHASE is a conversion event, not an optimization goal)
  await pgQuery(`UPDATE launch_templates SET optimization_goal = 'OFFSITE_CONVERSIONS' WHERE optimization_goal = 'PURCHASE'`).catch(() => {});
  await pgQuery(`
    CREATE TABLE IF NOT EXISTS brief_copy_sets (
      id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      product_id INTEGER,
      angle TEXT NOT NULL,
      primary_texts JSONB DEFAULT '[]',
      headlines JSONB DEFAULT '[]',
      descriptions JSONB DEFAULT '[]',
      cta_button TEXT DEFAULT 'SHOP_NOW',
      landing_page_url TEXT,
      utm_parameters TEXT DEFAULT 'tw_source={{site_source_name}}&tw_adid={{ad.id}}',
      created_by UUID,
      created_at TIMESTAMPTZ DEFAULT NOW(),
      updated_at TIMESTAMPTZ DEFAULT NOW()
    )
  `);
  await pgQuery(`
    CREATE TABLE IF NOT EXISTS brief_launches (
      id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      brief_id UUID,
      template_id UUID,
      copy_set_id UUID,
      ad_account_id TEXT,
      meta_campaign_id TEXT,
      meta_adset_id TEXT,
      meta_ad_id TEXT,
      meta_creative_id TEXT,
      ad_name TEXT,
      adset_name TEXT,
      page_id TEXT,
      page_name TEXT,
      batch_number INTEGER,
      status TEXT DEFAULT 'pending',
      error_message TEXT,
      launched_at TIMESTAMPTZ,
      created_at TIMESTAMPTZ DEFAULT NOW()
    )
  `);
  await pgQuery(`CREATE UNIQUE INDEX IF NOT EXISTS idx_copy_sets_product_angle ON brief_copy_sets(product_id, angle)`).catch(() => {});
  // Add launch columns to generated table
  await pgQuery(`ALTER TABLE brief_pipeline_generated ADD COLUMN IF NOT EXISTS launched_at TIMESTAMPTZ`).catch(() => {});
  await pgQuery(`ALTER TABLE brief_pipeline_generated ADD COLUMN IF NOT EXISTS launch_error TEXT`).catch(() => {});
  await pgQuery(`ALTER TABLE brief_pipeline_generated ADD COLUMN IF NOT EXISTS meta_ad_ids JSONB DEFAULT '[]'`).catch(() => {});
}

// ── Meta API Proxy Endpoints ───────────────────────────────────────────

router.get('/meta/accounts', authenticate, async (_req, res) => {
  try {
    if (!isMetaAdsConfigured()) return res.json({ success: true, data: [] });
    const accounts = await getAdAccounts();
    res.json({ success: true, data: accounts });
  } catch (err) {
    res.status(500).json({ success: false, error: { message: err.message } });
  }
});

router.get('/meta/pages/:accountId', authenticate, async (req, res) => {
  try {
    const pages = await getPages(req.params.accountId);
    res.json({ success: true, data: pages });
  } catch (err) {
    res.status(500).json({ success: false, error: { message: err.message } });
  }
});

router.get('/meta/pixels/:accountId', authenticate, async (req, res) => {
  try {
    const pixels = await getPixels(req.params.accountId);
    res.json({ success: true, data: pixels });
  } catch (err) {
    res.status(500).json({ success: false, error: { message: err.message } });
  }
});

router.get('/meta/campaigns/:accountId', authenticate, async (req, res) => {
  try {
    const campaigns = await getCampaigns(req.params.accountId);
    res.json({ success: true, data: campaigns });
  } catch (err) {
    res.status(500).json({ success: false, error: { message: err.message } });
  }
});

router.get('/meta/adsets/:campaignId', authenticate, async (req, res) => {
  try {
    const adsets = await getAdSets(req.params.campaignId);
    res.json({ success: true, data: adsets });
  } catch (err) {
    res.status(500).json({ success: false, error: { message: err.message } });
  }
});

router.get('/meta/audiences/:accountId', authenticate, async (req, res) => {
  try {
    const audiences = await getCustomAudiences(req.params.accountId);
    res.json({ success: true, data: audiences });
  } catch (err) {
    res.status(500).json({ success: false, error: { message: err.message } });
  }
});

// Sync all Meta data for an ad account at once (used by template editor)
router.get('/meta/sync/:accountId', authenticate, async (req, res) => {
  try {
    const accountId = req.params.accountId;
    const [pages, pixels, campaigns, audiences] = await Promise.all([
      getPages(accountId).catch(e => { console.error('Sync pages error:', e.message); return []; }),
      getPixels(accountId).catch(e => { console.error('Sync pixels error:', e.message); return []; }),
      getCampaigns(accountId).catch(e => { console.error('Sync campaigns error:', e.message); return []; }),
      getCustomAudiences(accountId).catch(e => { console.error('Sync audiences error:', e.message); return []; }),
    ]);
    console.log(`Sync ${accountId}: ${pages.length} pages, ${pixels.length} pixels, ${campaigns.length} campaigns, ${audiences.length} audiences`);
    res.json({ success: true, data: { pages, pixels, campaigns, audiences } });
  } catch (err) {
    res.status(500).json({ success: false, error: { message: err.message } });
  }
});

// ── Launch Template CRUD ───────────────────────────────────────────────

router.get('/launch-templates', authenticate, async (req, res) => {
  try {
    await ensureLaunchTables();
    const { product_id } = req.query;
    let query = 'SELECT * FROM launch_templates';
    const params = [];
    if (product_id) {
      query += ' WHERE product_id = $1';
      params.push(product_id);
    }
    query += ' ORDER BY is_default DESC, updated_at DESC';
    const rows = await pgQuery(query, params);
    res.json({ success: true, data: rows });
  } catch (err) {
    res.status(500).json({ success: false, error: { message: err.message } });
  }
});

router.get('/launch-templates/:id', authenticate, async (req, res) => {
  try {
    await ensureLaunchTables();
    const rows = await pgQuery('SELECT * FROM launch_templates WHERE id = $1', [req.params.id]);
    if (!rows.length) return res.status(404).json({ success: false, error: { message: 'Template not found' } });
    res.json({ success: true, data: rows[0] });
  } catch (err) {
    res.status(500).json({ success: false, error: { message: err.message } });
  }
});

router.post('/launch-templates', authenticate, async (req, res) => {
  try {
    await ensureLaunchTables();
    const t = req.body;
    // Helper: ensure value is a proper JS array (not a string) for JSONB columns
    const ensureArr = (v, fallback = []) => {
      if (Array.isArray(v)) return v;
      if (typeof v === 'string') { try { let p = JSON.parse(v); if (typeof p === 'string') p = JSON.parse(p); return Array.isArray(p) ? p : fallback; } catch { return fallback; } }
      return fallback;
    };
    const rows = await pgQuery(
      `INSERT INTO launch_templates (
        name, ad_account_id, ad_account_name, page_mode, page_ids,
        pixel_id, pixel_name, campaign_id, campaign_name,
        adset_name_pattern, ad_name_pattern,
        conversion_location, conversion_event,
        daily_budget, performance_goal, optimization_goal, bid_strategy, target_roas,
        attribution_window, include_audiences, exclude_audiences,
        countries, age_min, age_max, gender, ad_format, utm_parameters,
        landing_page_url, translation_languages, product_id, is_default, created_by,
        schedule_enabled, schedule_date, schedule_time
      ) VALUES (
        $1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20,$21,$22,$23,$24,$25,$26,$27,$28,$29,$30,$31,$32,$33,$34,$35
      ) RETURNING *`,
      [
        t.name, t.ad_account_id, t.ad_account_name, t.page_mode || 'single',
        JSON.stringify(ensureArr(t.page_ids)),
        t.pixel_id, t.pixel_name, t.campaign_id, t.campaign_name,
        t.adset_name_pattern || '{date} - {angle} - Batch {batch}',
        t.ad_name_pattern || '{date} - {angle} {num}',
        t.conversion_location || 'WEBSITE', t.conversion_event || 'PURCHASE',
        t.daily_budget || 150, t.performance_goal || 'OFFSITE_CONVERSIONS',
        t.optimization_goal || 'OFFSITE_CONVERSIONS',
        t.bid_strategy || 'LOWEST_COST_WITHOUT_CAP', t.target_roas || null,
        t.attribution_window || '7d_click',
        JSON.stringify(ensureArr(t.include_audiences)), JSON.stringify(ensureArr(t.exclude_audiences)),
        JSON.stringify(ensureArr(t.countries, ['US'])), t.age_min || 18, t.age_max || 65,
        t.gender || 'all', t.ad_format || 'FLEXIBLE', t.utm_parameters || '',
        t.landing_page_url || null,
        JSON.stringify(ensureArr(t.translation_languages)),
        t.product_id || null, t.is_default || false, req.user?.id || null,
        t.schedule_enabled || false, t.schedule_date || null, t.schedule_time || '00:00'
      ]
    );
    res.json({ success: true, data: rows[0] });
  } catch (err) {
    res.status(500).json({ success: false, error: { message: err.message } });
  }
});

router.put('/launch-templates/:id', authenticate, async (req, res) => {
  try {
    await ensureLaunchTables();
    const t = req.body;
    const ensureArr = (v, fallback = []) => {
      if (Array.isArray(v)) return v;
      if (typeof v === 'string') { try { let p = JSON.parse(v); if (typeof p === 'string') p = JSON.parse(p); return Array.isArray(p) ? p : fallback; } catch { return fallback; } }
      return fallback;
    };
    const rows = await pgQuery(
      `UPDATE launch_templates SET
        name=$1, ad_account_id=$2, ad_account_name=$3, page_mode=$4, page_ids=$5,
        pixel_id=$6, pixel_name=$7, campaign_id=$8, campaign_name=$9,
        adset_name_pattern=$10, ad_name_pattern=$11,
        conversion_location=$12, conversion_event=$13,
        daily_budget=$14, performance_goal=$15, optimization_goal=$16, bid_strategy=$17, target_roas=$18,
        attribution_window=$19, include_audiences=$20, exclude_audiences=$21,
        countries=$22, age_min=$23, age_max=$24, gender=$25, ad_format=$26, utm_parameters=$27,
        landing_page_url=$28, translation_languages=$29, product_id=$30, is_default=$31,
        schedule_enabled=$32, schedule_date=$33, schedule_time=$34, updated_at=NOW()
      WHERE id=$35 RETURNING *`,
      [
        t.name, t.ad_account_id, t.ad_account_name, t.page_mode || 'single',
        JSON.stringify(ensureArr(t.page_ids)),
        t.pixel_id, t.pixel_name, t.campaign_id, t.campaign_name,
        t.adset_name_pattern, t.ad_name_pattern,
        t.conversion_location, t.conversion_event,
        t.daily_budget, t.performance_goal, t.optimization_goal,
        t.bid_strategy, t.target_roas || null,
        t.attribution_window,
        JSON.stringify(ensureArr(t.include_audiences)), JSON.stringify(ensureArr(t.exclude_audiences)),
        JSON.stringify(ensureArr(t.countries, ['US'])), t.age_min, t.age_max,
        t.gender, t.ad_format, t.utm_parameters,
        t.landing_page_url || null,
        JSON.stringify(ensureArr(t.translation_languages)),
        t.product_id || null, t.is_default || false,
        t.schedule_enabled || false, t.schedule_date || null, t.schedule_time || '00:00',
        req.params.id
      ]
    );
    if (!rows.length) return res.status(404).json({ success: false, error: { message: 'Template not found' } });
    res.json({ success: true, data: rows[0] });
  } catch (err) {
    res.status(500).json({ success: false, error: { message: err.message } });
  }
});

router.delete('/launch-templates/:id', authenticate, async (req, res) => {
  try {
    await ensureLaunchTables();
    const rows = await pgQuery('DELETE FROM launch_templates WHERE id = $1 RETURNING id', [req.params.id]);
    if (!rows.length) return res.status(404).json({ success: false, error: { message: 'Template not found' } });
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ success: false, error: { message: err.message } });
  }
});

// ── Copy Sets CRUD ─────────────────────────────────────────────────────

router.get('/copy-sets', authenticate, async (req, res) => {
  try {
    await ensureLaunchTables();
    const { product_id } = req.query;
    let query = 'SELECT * FROM brief_copy_sets';
    const params = [];
    if (product_id) {
      query += ' WHERE product_id = $1';
      params.push(product_id);
    }
    query += ' ORDER BY angle ASC';
    const rows = await pgQuery(query, params);
    res.json({ success: true, data: rows });
  } catch (err) {
    res.status(500).json({ success: false, error: { message: err.message } });
  }
});

router.post('/copy-sets', authenticate, async (req, res) => {
  try {
    await ensureLaunchTables();
    const c = req.body;
    const rows = await pgQuery(
      `INSERT INTO brief_copy_sets (product_id, angle, primary_texts, headlines, descriptions, cta_button, landing_page_url, utm_parameters, created_by)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9) RETURNING *`,
      [
        c.product_id, c.angle,
        JSON.stringify(c.primary_texts || []),
        JSON.stringify(c.headlines || []),
        JSON.stringify(c.descriptions || []),
        c.cta_button || 'SHOP_NOW',
        c.landing_page_url || '',
        c.utm_parameters || 'tw_source={{site_source_name}}&tw_adid={{ad.id}}',
        req.user?.id || null
      ]
    );
    res.json({ success: true, data: rows[0] });
  } catch (err) {
    if (err.message.includes('idx_copy_sets_product_angle')) {
      return res.status(409).json({ success: false, error: { message: `A copy set for angle "${req.body.angle}" already exists` } });
    }
    res.status(500).json({ success: false, error: { message: err.message } });
  }
});

router.put('/copy-sets/:id', authenticate, async (req, res) => {
  try {
    await ensureLaunchTables();
    const c = req.body;
    const rows = await pgQuery(
      `UPDATE brief_copy_sets SET angle=$1, primary_texts=$2, headlines=$3, descriptions=$4, cta_button=$5, landing_page_url=$6, utm_parameters=$7, updated_at=NOW()
       WHERE id=$8 RETURNING *`,
      [
        c.angle,
        JSON.stringify(c.primary_texts || []),
        JSON.stringify(c.headlines || []),
        JSON.stringify(c.descriptions || []),
        c.cta_button || 'SHOP_NOW',
        c.landing_page_url || '',
        c.utm_parameters || '',
        req.params.id
      ]
    );
    if (!rows.length) return res.status(404).json({ success: false, error: { message: 'Copy set not found' } });
    res.json({ success: true, data: rows[0] });
  } catch (err) {
    res.status(500).json({ success: false, error: { message: err.message } });
  }
});

router.delete('/copy-sets/:id', authenticate, async (req, res) => {
  try {
    await ensureLaunchTables();
    const rows = await pgQuery('DELETE FROM brief_copy_sets WHERE id = $1 RETURNING id', [req.params.id]);
    if (!rows.length) return res.status(404).json({ success: false, error: { message: 'Copy set not found' } });
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ success: false, error: { message: err.message } });
  }
});

// ── Launch Briefs to Meta ──────────────────────────────────────────────

function buildLaunchName(pattern, vars) {
  let result = pattern;
  for (const [key, val] of Object.entries(vars)) {
    result = result.replace(new RegExp(`\\{${key}\\}`, 'g'), val || '');
  }
  return result.trim();
}

router.post('/launch', authenticate, async (req, res) => {
  try {
    await ensureLaunchTables();
    if (!isMetaAdsConfigured()) {
      return res.status(400).json({ success: false, error: { message: 'Meta Ads API not configured' } });
    }

    const { brief_ids, template_id, copy_set_id } = req.body;
    if (!brief_ids?.length || !template_id) {
      return res.status(400).json({ success: false, error: { message: 'brief_ids and template_id are required' } });
    }

    // Load template
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

    // Load briefs
    const briefs = await pgQuery(
      `SELECT * FROM brief_pipeline_generated WHERE id = ANY($1) AND status IN ('approved', 'ready_to_launch')`,
      [brief_ids]
    );
    if (!briefs.length) {
      return res.status(400).json({ success: false, error: { message: 'No launchable briefs found' } });
    }
    // Fix double-encoded JSONB fields before use
    for (const b of briefs) {
      b.hooks = parseJsonb(b.hooks);
      b.win_analysis = parseJsonb(b.win_analysis);
      b.scores_json = parseJsonb(b.scores_json);
    }

    // Mark briefs as launching
    await pgQuery(
      `UPDATE brief_pipeline_generated SET status = 'launching' WHERE id = ANY($1)`,
      [brief_ids]
    );

    // Date format: DD-MM (e.g., "08-04" for April 8)
    const now = new Date();
    const dateStr = `${String(now.getDate()).padStart(2, '0')}-${String(now.getMonth() + 1).padStart(2, '0')}`;
    const batchNum = Math.floor(Date.now() / 1000) % 10000;
    const results = [];

    // Round-robin page selection
    const selectedPages = (template.page_ids || []).filter(p => p.selected !== false);
    let pageIdx = 0;

    // Create ad set for this batch
    let adsetId = null;
    let adsetName = '';
    {
      adsetName = buildLaunchName(template.adset_name_pattern, {
        date: dateStr,
        angle: briefs[0]?.angle || 'General',
        batch: batchNum,
        product: briefs[0]?.product_code || '',
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
          status: 'ACTIVE',
          startTime: template.schedule_enabled && template.schedule_date
            ? `${template.schedule_date}T${template.schedule_time || '00:00'}:00`
            : undefined,
        });
      } catch (err) {
        await pgQuery(
          `UPDATE brief_pipeline_generated SET status = 'launch_failed', launch_error = $1 WHERE id = ANY($2)`,
          [`Ad set creation failed: ${err.message}`, brief_ids]
        );
        return res.status(500).json({ success: false, error: { message: `Ad set creation failed: ${err.message}` } });
      }
    }

    // Launch each brief as an ad
    for (let i = 0; i < briefs.length; i++) {
      const brief = briefs[i];
      const launchId = crypto.randomUUID();

      // Pick page (round-robin)
      const page = selectedPages.length ? selectedPages[pageIdx % selectedPages.length] : null;
      pageIdx++;

      const adName = buildLaunchName(template.ad_name_pattern, {
        date: dateStr,
        angle: brief.angle || 'General',
        num: i + 1,
        batch: batchNum,
        product: brief.product_code || '',
      });

      try {
        await pgQuery(
          `INSERT INTO brief_launches (id, brief_id, template_id, copy_set_id, ad_account_id, meta_campaign_id, meta_adset_id, ad_name, adset_name, page_id, page_name, batch_number, status)
           VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,'uploading')`,
          [launchId, brief.id, template_id, copy_set_id || null, template.ad_account_id, template.campaign_id, adsetId, adName, adsetName, page?.id, page?.name, batchNum]
        );

        // Determine ad copy
        const primaryTexts = copySet?.primary_texts?.length
          ? copySet.primary_texts
          : [brief.body || brief.hooks?.[0]?.text || 'Check this out'];
        const headlines = copySet?.headlines?.length
          ? copySet.headlines
          : (brief.hooks || []).map(h => h.text).slice(0, 3);
        const descriptions = copySet?.descriptions?.length
          ? copySet.descriptions
          : [''];
        const cta = copySet?.cta_button || 'SHOP_NOW';
        const link = copySet?.landing_page_url || template.utm_parameters || '';

        // Create ad creative
        const creativeId = await createFlexibleAdCreative(template.ad_account_id, {
          name: adName,
          primaryTexts,
          headlines: headlines.length ? headlines : ['Shop Now'],
          descriptions,
          cta,
          link: link || 'https://mineblock.com',
          pageId: page?.id || selectedPages[0]?.id,
          utmParameters: template.utm_parameters,
        });

        // Create the ad
        const metaAdId = await createAd(template.ad_account_id, {
          name: adName,
          adsetId,
          creativeId,
          status: 'ACTIVE',
        });

        // Update records
        await pgQuery(
          `UPDATE brief_launches SET status='launched', meta_ad_id=$1, meta_creative_id=$2, launched_at=NOW() WHERE id=$3`,
          [metaAdId, creativeId, launchId]
        );
        await pgQuery(
          `UPDATE brief_pipeline_generated SET status='launched', launched_at=NOW(),
           meta_ad_ids = COALESCE(meta_ad_ids, '[]'::jsonb) || $1::jsonb
           WHERE id=$2`,
          [JSON.stringify([metaAdId]), brief.id]
        );

        results.push({ brief_id: brief.id, status: 'launched', meta_ad_id: metaAdId, ad_name: adName });
      } catch (err) {
        await pgQuery(`UPDATE brief_launches SET status='failed', error_message=$1 WHERE id=$2`, [err.message, launchId]);
        await pgQuery(`UPDATE brief_pipeline_generated SET status='launch_failed', launch_error=$1 WHERE id=$2`, [err.message, brief.id]);
        results.push({ brief_id: brief.id, status: 'failed', error: err.message });
      }
    }

    res.json({ success: true, data: { results, adset_id: adsetId } });
  } catch (err) {
    console.error('[BriefPipeline] Launch error:', err);
    res.status(500).json({ success: false, error: { message: err.message } });
  }
});

// GET /launch-history — launch history for briefs
router.get('/launch-history', authenticate, async (req, res) => {
  try {
    await ensureLaunchTables();
    const { brief_id } = req.query;
    let query = `SELECT bl.*, bg.angle, bg.body, bg.hooks, lt.name as template_name
                 FROM brief_launches bl
                 LEFT JOIN brief_pipeline_generated bg ON bg.id = bl.brief_id
                 LEFT JOIN launch_templates lt ON lt.id = bl.template_id`;
    const params = [];
    if (brief_id) {
      query += ' WHERE bl.brief_id = $1';
      params.push(brief_id);
    }
    query += ' ORDER BY bl.created_at DESC LIMIT 100';
    const rows = await pgQuery(query, params);
    res.json({ success: true, data: rows });
  } catch (err) {
    res.status(500).json({ success: false, error: { message: err.message } });
  }
});

// PATCH /generated/:id — update status (extended for launch statuses)
// Already exists above, but we add ready_to_launch support

// ============================================================================
// ── League Import (Brand Spy → Brief Pipeline) ──────────────────────────────
//
// Pulls competitor video ads from brand_spy.ads (tier-filtered: BANGER, CHAMP,
// A-tier only) so they can be transcribed and imported into the Reference
// column as pre-generation material. Transcription itself reuses the existing
// /api/v1/brand-spy/ads/:id/transcribe endpoint — these routes only handle
// listing brands/ads and persisting the user's selections.
// ============================================================================

// GET /league/brands — followed brands with per-tier VIDEO ad counts.
//
// "Followed" in the new Brand Spy workflow == any brand the user added
// to brand_spy.brands (status='ACTIVE'). The older spy_brand_follows
// table is unused here — entries in brand_spy.brands ARE the follow set.
router.get('/league/brands', authenticate, async (_req, res) => {
  try {
    const rows = await pgQuery(`
      WITH tier_counts AS (
        SELECT
          a.brand_id,
          COUNT(*)                                          AS total_video_count,
          COUNT(*) FILTER (WHERE a.tier = 'BANGER')         AS banger_count,
          COUNT(*) FILTER (WHERE a.tier = 'CHAMP')          AS champ_count,
          COUNT(*) FILTER (WHERE a.tier = 'A')              AS a_count
        FROM brand_spy.ads a
        WHERE a.is_active = TRUE
          AND a.tier IN ('BANGER','CHAMP','A')
          AND (a.display_format ILIKE 'video%'
               OR (a.raw_snapshot->'videos'->0->>'video_hd_url') IS NOT NULL
               OR (a.raw_snapshot->'videos'->0->>'video_sd_url') IS NOT NULL)
        GROUP BY a.brand_id
      )
      SELECT
        b.id,
        b.display_name AS name,
        b.domain,
        COALESCE(tc.total_video_count, 0)::INTEGER AS total_video_count,
        COALESCE(tc.banger_count, 0)::INTEGER      AS banger_count,
        COALESCE(tc.champ_count, 0)::INTEGER       AS champ_count,
        COALESCE(tc.a_count, 0)::INTEGER           AS a_count
      FROM brand_spy.brands b
      LEFT JOIN tier_counts tc ON tc.brand_id = b.id
      WHERE b.status = 'ACTIVE'
      ORDER BY total_video_count DESC, b.display_name ASC NULLS LAST, b.domain ASC
    `);
    const brands = rows.map(r => ({
      id: r.id,
      name: r.name,
      domain: r.domain,
      totalVideoCount: Number(r.total_video_count) || 0,
      tierCounts: {
        BANGER: Number(r.banger_count) || 0,
        CHAMP:  Number(r.champ_count)  || 0,
        A:      Number(r.a_count)      || 0,
      },
    }));
    res.json({ success: true, brands });
  } catch (err) {
    console.error('[BriefPipeline] GET /league/brands error:', err.message);
    res.status(500).json({ success: false, error: { message: err.message } });
  }
});

// GET /league/ads — list VIDEO ads for a brand, tier-filtered.
// Query params: brand_id (required), tiers (CSV, default BANGER,CHAMP,A),
// page (default 1), limit (default 20).
router.get('/league/ads', authenticate, async (req, res) => {
  try {
    const brandId = req.query.brand_id;
    if (!brandId) {
      return res.status(400).json({ success: false, error: { message: 'brand_id is required' } });
    }
    const tiersCsv = String(req.query.tiers || 'BANGER,CHAMP,A');
    const tiers = tiersCsv
      .split(',')
      .map(t => t.trim().toUpperCase())
      .filter(t => ['BANGER','CHAMP','A'].includes(t));
    if (tiers.length === 0) {
      return res.json({ success: true, ads: [], total: 0, page: 1, limit: 20 });
    }
    const page  = Math.max(1, parseInt(req.query.page, 10) || 1);
    const limit = Math.min(100, Math.max(1, parseInt(req.query.limit, 10) || 20));
    const offset = (page - 1) * limit;

    const params = [brandId, tiers, limit, offset];

    const sql = `
      SELECT
        a.id,
        a.ad_archive_id,
        a.brand_id,
        a.tier,
        a.tier_score,
        a.current_rank,
        a.headline,
        a.body_text,
        a.display_format,
        a.active_days,
        a.is_active,
        a.transcript,
        a.transcript_at,
        a.raw_snapshot->'videos'->0->>'video_hd_url' AS video_hd_url,
        a.raw_snapshot->'videos'->0->>'video_sd_url' AS video_sd_url,
        a.raw_snapshot->'videos'->0->>'video_preview_image_url' AS thumbnail_url,
        EXISTS (
          SELECT 1 FROM brief_pipeline_references bpr
          WHERE bpr.ad_archive_id = a.ad_archive_id::text
        ) AS already_imported,
        COUNT(*) OVER () AS total_count
      FROM brand_spy.ads a
      WHERE a.brand_id = $1
        AND a.is_active = TRUE
        AND a.tier = ANY($2::text[])
        AND (a.display_format ILIKE 'video%'
             OR (a.raw_snapshot->'videos'->0->>'video_hd_url') IS NOT NULL
             OR (a.raw_snapshot->'videos'->0->>'video_sd_url') IS NOT NULL)
      ORDER BY a.tier_score DESC NULLS LAST, a.active_days DESC NULLS LAST
      LIMIT $3 OFFSET $4
    `;
    const rows = await pgQuery(sql, params);
    const total = rows.length > 0 ? Number(rows[0].total_count) : 0;
    const ads = rows.map(r => ({
      id: r.id,
      adArchiveId: r.ad_archive_id,
      brandId: r.brand_id,
      tier: r.tier,
      tierScore: r.tier_score,
      currentRank: r.current_rank,
      headline: r.headline,
      bodyText: r.body_text,
      displayFormat: r.display_format,
      activeDays: r.active_days,
      isActive: r.is_active,
      transcript: r.transcript || null,
      transcriptAt: r.transcript_at ? new Date(r.transcript_at).toISOString() : null,
      videoUrl: r.video_hd_url || r.video_sd_url || null,
      thumbnailUrl: r.thumbnail_url || null,
      alreadyImported: r.already_imported === true,
    }));
    res.json({ success: true, ads, total, page, limit });
  } catch (err) {
    console.error('[BriefPipeline] GET /league/ads error:', err.message);
    res.status(500).json({ success: false, error: { message: err.message } });
  }
});

// ── Reference media mirroring ────────────────────────────────────────
// Facebook CDN URLs (fbcdn.net) carry an `oe=` expiry and die ~2-4 weeks
// after scrape — after that the reference card thumbnail and the preview
// modal video 403 forever. Same disease as the statics image_url arc:
// the fix is the same stable-URL contract — mirror the bytes to R2 at
// import time and store OUR url, not theirs.

const VOLATILE_MEDIA_RE = /\bfbcdn\.net\b|\bfbsbx\.com\b|\bscontent[^/]*\.xx\b/i;

async function probeMediaUrl(url) {
  try {
    const r = await fetch(url, { method: 'HEAD', signal: AbortSignal.timeout(8000) });
    return r.ok;
  } catch { return false; }
}

async function mirrorMediaUrlToR2(url, keyPrefix, kind) {
  // OOM caution (512MB instance — see the July 2026 brand-spy crash loop):
  // reject on Content-Length BEFORE reading, then stream with a running byte
  // cap. A size check after arrayBuffer() is no cap at all.
  const MAX = kind === 'video' ? 80 * 1024 * 1024 : 15 * 1024 * 1024;
  const res = await fetch(url, { signal: AbortSignal.timeout(120000) });
  if (!res.ok) throw new Error(`fetch ${res.status}`);
  const declared = parseInt(res.headers.get('content-length') || '0', 10);
  if (declared > MAX) {
    try { await res.body?.cancel(); } catch { /* already closed */ }
    throw new Error(`file too large (content-length ${declared} bytes)`);
  }
  const chunks = [];
  let total = 0;
  for await (const chunk of res.body) {
    total += chunk.length;
    if (total > MAX) {
      try { await res.body?.cancel(); } catch { /* already closed */ }
      throw new Error(`file too large (streamed past ${MAX} bytes)`);
    }
    chunks.push(Buffer.from(chunk));
  }
  const buf = Buffer.concat(chunks);
  if (buf.length < 1024) throw new Error(`file suspiciously small: ${buf.length} bytes`);
  const ct = res.headers.get('content-type') || (kind === 'video' ? 'video/mp4' : 'image/jpeg');
  const ext = kind === 'video' ? 'mp4' : (ct.includes('png') ? 'png' : 'jpg');
  const key = `${keyPrefix}/${crypto.randomUUID()}.${ext}`;
  return uploadBuffer(buf, key, ct);
}

// Repair one reference's video to a permanent R2 URL. Candidate order:
//   1. the stored URL (if still alive — beat the expiry clock)
//   2. fresh video_hd/sd URLs from brand_spy.ads (daily scraper)
//   3. yt-dlp re-extraction from the FB Ad Library page (works whenever the
//      ad is still live, even when every stored URL is long dead)
// Whichever candidate wins gets mirrored to R2 and persisted — repairs are
// terminal; we never write another expiring fbcdn URL as the "fix".
async function repairReferenceVideo(ref) {
  if (!ref?.video_url && !ref?.ad_archive_id) return { status: 'skipped' };
  const direct = [ref.video_url, ref.fresh_hd, ref.fresh_sd].filter(Boolean);
  for (const c of direct) {
    if (!(await probeMediaUrl(c))) continue;
    try {
      const r2Url = await mirrorMediaUrlToR2(c, 'brief-refs/video', 'video');
      await pgQuery(`UPDATE brief_pipeline_references SET video_url = $1, updated_at = NOW() WHERE id = $2`, [r2Url, ref.id]);
      return { status: 'repaired', videoUrl: r2Url, via: 'stored-or-brandspy' };
    } catch (e) { console.warn(`[BriefPipeline] ref ${ref.id} mirror of live candidate failed: ${e.message}`); }
  }
  if (ref.ad_archive_id) {
    const fresh = await extractFreshVideoUrl(adLibraryUrl(ref.ad_archive_id));
    if (fresh) {
      try {
        const r2Url = await mirrorMediaUrlToR2(fresh, 'brief-refs/video', 'video');
        await pgQuery(`UPDATE brief_pipeline_references SET video_url = $1, updated_at = NOW() WHERE id = $2`, [r2Url, ref.id]);
        return { status: 'repaired', videoUrl: r2Url, via: 'yt-dlp' };
      } catch (e) { return { status: `mirror failed: ${e.message}` }; }
    }
  }
  return { status: 'unrecoverable' };
}

// Mirror a reference's volatile video/thumbnail to R2 and persist the stable
// URLs. Never throws — designed to run fire-and-forget after import.
async function mirrorReferenceMediaToR2(refId, videoUrl, thumbnailUrl) {
  if (!isR2Configured()) return { mirrored: [], reason: 'R2 not configured' };
  const mirrored = [];
  if (videoUrl && VOLATILE_MEDIA_RE.test(videoUrl)) {
    try {
      const r2Url = await mirrorMediaUrlToR2(videoUrl, 'brief-refs/video', 'video');
      await pgQuery(`UPDATE brief_pipeline_references SET video_url = $1, updated_at = NOW() WHERE id = $2`, [r2Url, refId]);
      mirrored.push('video');
    } catch (e) { console.warn(`[BriefPipeline] ref ${refId} video mirror failed: ${e.message}`); }
  }
  if (thumbnailUrl && VOLATILE_MEDIA_RE.test(thumbnailUrl)) {
    try {
      const r2Url = await mirrorMediaUrlToR2(thumbnailUrl, 'brief-refs/thumb', 'image');
      await pgQuery(`UPDATE brief_pipeline_references SET thumbnail_url = $1, updated_at = NOW() WHERE id = $2`, [r2Url, refId]);
      mirrored.push('thumbnail');
    } catch (e) { console.warn(`[BriefPipeline] ref ${refId} thumb mirror failed: ${e.message}`); }
  }
  if (mirrored.length) console.log(`[BriefPipeline] ref ${refId} media mirrored to R2: ${mirrored.join(', ')}`);
  return { mirrored };
}

// POST /references/repair-media — fix existing references whose fbcdn URLs
// have expired. For each reference with volatile or missing media:
//   1. stored URL still alive → mirror it to R2 now (beat the expiry)
//   2. dead → pull the freshest video_hd_url/video_sd_url/thumbnail_url from
//      brand_spy.ads (the daily scraper refreshes them) → probe → mirror
//   3. nothing alive anywhere → unrecoverable; transcript-only fallback UI stands
// ═══════════════════════════════════════════════════════════════════════
// BATCH QUEUE — brief_generation_jobs (see BATCH_QUEUE_SCOPE.md)
// Select N League ads → queue → worker auto-transcribes, imports the
// reference, and generates a brief per ad. Queue survives restarts.
// ═══════════════════════════════════════════════════════════════════════

// Lazy belt-and-braces guard (same pattern as ensureTables /
// ensureLaunchTables): migration 074 owns the canonical DDL, but the
// endpoints + worker must not 500 on an environment where migrations
// haven't run yet.
let jobsTableReady = false;
async function ensureJobsTable() {
  if (jobsTableReady) return;
  await pgQuery(`
    CREATE TABLE IF NOT EXISTS brief_generation_jobs (
      id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      brand_spy_ad_id  TEXT NOT NULL,
      ad_archive_id    TEXT,
      brand_id         TEXT,
      brand_name       TEXT,
      tier             TEXT,
      headline         TEXT,
      product_id       INTEGER,
      product_code     TEXT,
      angle            TEXT,
      model            TEXT DEFAULT 'claude',
      status           TEXT NOT NULL DEFAULT 'queued',
      error            TEXT,
      reference_id     UUID,
      brief_id         UUID,
      attempts         INTEGER NOT NULL DEFAULT 0,
      created_at       TIMESTAMPTZ DEFAULT NOW(),
      started_at       TIMESTAMPTZ,
      finished_at      TIMESTAMPTZ
    )
  `, [], { timeout: 15000 });
  await pgQuery(`
    CREATE INDEX IF NOT EXISTS idx_bgj_status ON brief_generation_jobs (status, created_at)
  `).catch(() => {});
  jobsTableReady = true;
}

// POST /queue — enqueue N League ads for auto transcribe → import → generate.
// Dedup: an ad with an existing queued/transcribing/generating job for the
// same ad_archive_id is skipped (double-click / re-open safety).
router.post('/queue', authenticate, async (req, res) => {
  try {
    await ensureJobsTable();
    const { items, productId, productCode, angle, model } = req.body || {};
    if (!Array.isArray(items) || items.length === 0) {
      return res.status(400).json({ success: false, error: { message: 'items array is required (at least one ad)' } });
    }
    const modelVal = model === 'openai' ? 'openai' : 'claude';
    // angle: string | null — null/''/'AUTO' all mean AUTO (resolve at generate time)
    const angleVal = (angle && String(angle).trim() && String(angle).trim().toUpperCase() !== 'AUTO')
      ? String(angle).trim()
      : null;
    const productIdVal = (productId != null && /^\d+$/.test(String(productId))) ? Number(productId) : null;

    const skipped = [];
    const jobs = [];
    for (const item of items) {
      const { brandSpyAdId, adArchiveId, brandId, brandName, tier, headline } = item || {};
      if (!brandSpyAdId) {
        skipped.push({ adArchiveId: adArchiveId ? String(adArchiveId) : null, reason: 'brandSpyAdId is required' });
        continue;
      }
      if (adArchiveId) {
        const dupe = await pgQuery(
          `SELECT id FROM brief_generation_jobs
            WHERE ad_archive_id = $1 AND status IN ('queued','transcribing','generating')
            LIMIT 1`,
          [String(adArchiveId)]
        );
        if (dupe.length) {
          skipped.push({ adArchiveId: String(adArchiveId), reason: 'already queued or running' });
          continue;
        }
      }
      const inserted = await pgQuery(
        `INSERT INTO brief_generation_jobs (
           brand_spy_ad_id, ad_archive_id, brand_id, brand_name, tier, headline,
           product_id, product_code, angle, model
         ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)
         RETURNING id, headline, status`,
        [
          String(brandSpyAdId),
          adArchiveId ? String(adArchiveId) : null,
          brandId ? String(brandId) : null,
          brandName || null,
          tier || null,
          headline || null,
          productIdVal,
          productCode || null,
          angleVal,
          modelVal,
        ]
      );
      jobs.push(inserted[0]);
    }
    res.json({ success: true, queued: jobs.length, skipped, jobs });
  } catch (err) {
    console.error('[BriefPipeline] POST /queue error:', err.message);
    res.status(500).json({ success: false, error: { message: err.message } });
  }
});

// GET /queue — list jobs for the queue strip. Default: last 24h OR not
// done yet; ?include_done=true returns everything.
router.get('/queue', authenticate, async (req, res) => {
  try {
    await ensureJobsTable();
    const includeDone = String(req.query.include_done || '').toLowerCase() === 'true';
    const where = includeDone
      ? ''
      : `WHERE (created_at > NOW() - INTERVAL '24 hours' OR status NOT IN ('complete', 'canceled'))`;
    const jobs = await pgQuery(`
      SELECT id, headline, brand_name, tier, status, error, brief_id,
             reference_id, created_at, started_at, finished_at
        FROM brief_generation_jobs
        ${where}
       ORDER BY created_at DESC
    `);
    const summary = { queued: 0, running: 0, complete: 0, failed: 0 };
    for (const j of jobs) {
      if (j.status === 'queued') summary.queued += 1;
      else if (j.status === 'transcribing' || j.status === 'generating') summary.running += 1;
      else if (j.status === 'complete') summary.complete += 1;
      else if (j.status === 'failed') summary.failed += 1;
    }
    res.json({ success: true, jobs, summary });
  } catch (err) {
    console.error('[BriefPipeline] GET /queue error:', err.message);
    res.status(500).json({ success: false, error: { message: err.message } });
  }
});

// POST /queue/clear-done — remove completed jobs from the strip.
router.post('/queue/clear-done', authenticate, async (_req, res) => {
  try {
    await ensureJobsTable();
    const rows = await pgQuery(
      `DELETE FROM brief_generation_jobs WHERE status = 'complete' RETURNING id`
    );
    res.json({ success: true, cleared: rows.length });
  } catch (err) {
    console.error('[BriefPipeline] POST /queue/clear-done error:', err.message);
    res.status(500).json({ success: false, error: { message: err.message } });
  }
});

// POST /queue/:id/retry — failed → queued (fresh attempt counter).
router.post('/queue/:id/retry', authenticate, async (req, res) => {
  if (!validateUuid(req, res)) return;
  try {
    await ensureJobsTable();
    const rows = await pgQuery(
      `UPDATE brief_generation_jobs
          SET status = 'queued', error = NULL, attempts = 0,
              started_at = NULL, finished_at = NULL, brief_id = NULL
        WHERE id = $1 AND status = 'failed'
        RETURNING id`,
      [req.params.id]
    );
    if (!rows.length) {
      const exists = await pgQuery(`SELECT status FROM brief_generation_jobs WHERE id = $1`, [req.params.id]);
      if (!exists.length) return res.status(404).json({ success: false, error: { message: 'Job not found' } });
      return res.status(409).json({ success: false, error: { message: `Only failed jobs can be retried (job is '${exists[0].status}')` } });
    }
    res.json({ success: true });
  } catch (err) {
    console.error('[BriefPipeline] POST /queue/:id/retry error:', err.message);
    res.status(500).json({ success: false, error: { message: err.message } });
  }
});

// DELETE /queue/:id — cancel; only status='queued' is cancelable (running
// jobs can't be aborted mid-transcribe/generate without orphaning work).
router.delete('/queue/:id', authenticate, async (req, res) => {
  if (!validateUuid(req, res)) return;
  try {
    await ensureJobsTable();
    // queued → canceled (soft, keeps the row); failed/canceled → hard delete
    // (removes dead test/junk rows from the strip). Running jobs can't be
    // touched — the executor owns them.
    const canceled = await pgQuery(
      `UPDATE brief_generation_jobs
          SET status = 'canceled', finished_at = NOW()
        WHERE id = $1 AND status = 'queued'
        RETURNING id`,
      [req.params.id]
    );
    if (canceled.length) return res.json({ success: true, action: 'canceled' });

    const deleted = await pgQuery(
      `DELETE FROM brief_generation_jobs
        WHERE id = $1 AND status IN ('failed', 'canceled')
        RETURNING id`,
      [req.params.id]
    );
    if (deleted.length) return res.json({ success: true, action: 'deleted' });

    const exists = await pgQuery(`SELECT status FROM brief_generation_jobs WHERE id = $1`, [req.params.id]);
    if (!exists.length) return res.status(404).json({ success: false, error: { message: 'Job not found' } });
    return res.status(409).json({ success: false, error: { message: `Running jobs can't be removed (job is '${exists[0].status}')` } });
  } catch (err) {
    console.error('[BriefPipeline] DELETE /queue/:id error:', err.message);
    res.status(500).json({ success: false, error: { message: err.message } });
  }
});

router.post('/references/repair-media', authenticate, async (req, res) => {
  try {
    if (!isR2Configured()) {
      return res.status(503).json({ success: false, error: { message: 'R2 not configured on this environment' } });
    }
    const refs = await pgQuery(`
      SELECT r.id, r.video_url, r.thumbnail_url, r.brand_spy_ad_id, r.source_url, r.ad_archive_id,
             a.raw_snapshot->'videos'->0->>'video_hd_url'            AS fresh_hd,
             a.raw_snapshot->'videos'->0->>'video_sd_url'            AS fresh_sd,
             a.raw_snapshot->'videos'->0->>'video_preview_image_url' AS fresh_thumb
      FROM brief_pipeline_references r
      LEFT JOIN brand_spy.ads a ON a.id::text = r.brand_spy_ad_id::text
      WHERE (r.video_url ~* 'fbcdn|fbsbx' OR r.thumbnail_url ~* 'fbcdn|fbsbx')
    `);

    // yt-dlp re-extraction can take 45s+ per ref — way past Render's 30s
    // response limit. Respond immediately, repair in the background; the
    // operator sees results as R2 URLs appearing on GET /references.
    res.json({ success: true, started: true, checked: refs.length });

    (async () => {
      const results = [];
      for (const ref of refs) {
        const out = { id: ref.id, video: 'skipped', thumbnail: 'skipped' };
        // ── video: stored URL → brand_spy snapshot → yt-dlp re-extract from Ad Library ──
        if (ref.video_url && VOLATILE_MEDIA_RE.test(ref.video_url)) {
          out.video = 'unrecoverable';
          const candidates = [ref.video_url, ref.fresh_hd, ref.fresh_sd].filter(Boolean);
          let fresh = null;
          for (const c of candidates) {
            if (await probeMediaUrl(c)) { fresh = c; break; }
          }
          if (!fresh) {
            // Last resort: the ad may still be live in the FB Ad Library —
            // yt-dlp pulls a brand-new (unexpired) fbcdn URL from the page.
            const pageUrl = ref.source_url || (ref.ad_archive_id ? `https://www.facebook.com/ads/library/?id=${ref.ad_archive_id}` : null);
            if (pageUrl) fresh = await extractVideoUrlWithYtdlp(pageUrl).catch(() => null);
          }
          if (fresh) {
            try {
              const r2Url = await mirrorMediaUrlToR2(fresh, 'brief-refs/video', 'video');
              await pgQuery(`UPDATE brief_pipeline_references SET video_url = $1, updated_at = NOW() WHERE id = $2`, [r2Url, ref.id]);
              out.video = 'repaired';
            } catch (e) { out.video = `mirror failed: ${e.message}`; }
          }
        }
        // ── thumbnail: stored URL → brand_spy snapshot ──
        if (ref.thumbnail_url && VOLATILE_MEDIA_RE.test(ref.thumbnail_url)) {
          out.thumbnail = 'unrecoverable';
          for (const c of [ref.thumbnail_url, ref.fresh_thumb].filter(Boolean)) {
            if (!(await probeMediaUrl(c))) continue;
            try {
              const r2Url = await mirrorMediaUrlToR2(c, 'brief-refs/thumb', 'image');
              await pgQuery(`UPDATE brief_pipeline_references SET thumbnail_url = $1, updated_at = NOW() WHERE id = $2`, [r2Url, ref.id]);
              out.thumbnail = 'repaired';
              break;
            } catch (e) { out.thumbnail = `mirror failed: ${e.message}`; }
          }
        }
        results.push(out);
        console.log(`[BriefPipeline] repair-media ref ${ref.id}: video=${out.video} thumbnail=${out.thumbnail}`);
      }
      const count = (k, field) => results.filter(r => r[field] === k).length;
      console.log(`[BriefPipeline] repair-media DONE — ${results.length} refs; video repaired=${count('repaired','video')} unrecoverable=${count('unrecoverable','video')}; thumb repaired=${count('repaired','thumbnail')} unrecoverable=${count('unrecoverable','thumbnail')}`);
    })().catch(e => console.error('[BriefPipeline] repair-media background error:', e.message));
  } catch (err) {
    console.error('[BriefPipeline] POST /references/repair-media error:', err.message);
    res.status(500).json({ success: false, error: { message: err.message } });
  }
});

// POST /references/:id/repair-video — on-demand repair for ONE reference,
// called by the preview modal when playback fails. Same candidate chain as
// the batch repair (stored URL → brand-spy snapshot → yt-dlp from the Ad
// Library), ends in a permanent R2 URL. Synchronous: yt-dlp can take ~45s,
// the modal shows a recovering state meanwhile.
router.post('/references/:id/repair-video', authenticate, async (req, res) => {
  if (!validateUuid(req, res)) return;
  try {
    if (!isR2Configured()) {
      return res.status(503).json({ success: false, error: { message: 'R2 not configured on this environment' } });
    }
    const rows = await pgQuery(`
      SELECT r.id, r.video_url, r.ad_archive_id,
             a.raw_snapshot->'videos'->0->>'video_hd_url' AS fresh_hd,
             a.raw_snapshot->'videos'->0->>'video_sd_url' AS fresh_sd
      FROM brief_pipeline_references r
      LEFT JOIN brand_spy.ads a ON a.id::text = r.brand_spy_ad_id::text
      WHERE r.id = $1
    `, [req.params.id]);
    if (!rows.length) return res.status(404).json({ success: false, error: { message: 'Reference not found' } });

    const result = await repairReferenceVideo(rows[0]);
    if (result.status === 'repaired') {
      return res.json({ success: true, videoUrl: result.videoUrl, via: result.via });
    }
    return res.status(404).json({
      success: false,
      error: { message: result.status === 'unrecoverable'
        ? 'Video is unrecoverable — the ad is no longer live in the FB Ad Library and no stored copy exists.'
        : `Repair failed: ${result.status}` },
    });
  } catch (err) {
    console.error('[BriefPipeline] POST /references/:id/repair-video error:', err.message);
    res.status(500).json({ success: false, error: { message: err.message } });
  }
});

// ── League-ad import core ───────────────────────────────────────────────
// Extracted from POST /references so the batch-queue worker can import a
// reference through the exact same upsert (including the fire-and-forget
// R2 media mirror). Validation-light: callers own request validation.
// Returns { reference, alreadyExists }.
async function importLeagueAdAsReference({
  brandSpyAdId, adArchiveId, brandId, brandName, tier,
  videoUrl, thumbnailUrl, headline, bodyText, transcript, transcriptAt,
}) {
  // Check if it already exists (so callers can report alreadyExists: true)
  const existing = await pgQuery(
    `SELECT id FROM brief_pipeline_references WHERE ad_archive_id = $1`,
    [String(adArchiveId)]
  );
  const alreadyExists = existing.length > 0;

  const status = transcript ? 'transcribed' : 'pending';
  const transcriptAtVal = transcript
    ? (transcriptAt ? new Date(transcriptAt) : new Date())
    : null;

  // FB Ad Library URL — every League import gets one for free since
  // ad_archive_id is the deeplink slug. Editors land on the source ad
  // with one click from the ClickUp task.
  const sourceUrl = `https://www.facebook.com/ads/library/?id=${String(adArchiveId)}`;

  const rows = await pgQuery(
    `INSERT INTO brief_pipeline_references (
       brand_spy_ad_id, ad_archive_id, brand_id, brand_name, tier,
       video_url, thumbnail_url, headline, body_text,
       transcript, transcript_at, status, source_url
     )
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13)
     ON CONFLICT (ad_archive_id, source) DO UPDATE SET
       brand_spy_ad_id = EXCLUDED.brand_spy_ad_id,
       brand_id        = EXCLUDED.brand_id,
       brand_name      = EXCLUDED.brand_name,
       tier            = EXCLUDED.tier,
       video_url       = COALESCE(EXCLUDED.video_url, brief_pipeline_references.video_url),
       thumbnail_url   = COALESCE(EXCLUDED.thumbnail_url, brief_pipeline_references.thumbnail_url),
       headline        = COALESCE(EXCLUDED.headline, brief_pipeline_references.headline),
       body_text       = COALESCE(EXCLUDED.body_text, brief_pipeline_references.body_text),
       transcript      = COALESCE(EXCLUDED.transcript, brief_pipeline_references.transcript),
       transcript_at   = COALESCE(EXCLUDED.transcript_at, brief_pipeline_references.transcript_at),
       source_url      = COALESCE(EXCLUDED.source_url, brief_pipeline_references.source_url),
       status          = CASE
                           WHEN EXCLUDED.transcript IS NOT NULL THEN 'transcribed'
                           WHEN brief_pipeline_references.transcript IS NOT NULL THEN brief_pipeline_references.status
                           ELSE 'pending'
                         END,
       updated_at      = NOW()
     RETURNING *`,
    [
      brandSpyAdId,
      String(adArchiveId),
      brandId,
      brandName,
      tier,
      videoUrl || null,
      thumbnailUrl || null,
      headline || null,
      bodyText || null,
      transcript || null,
      transcriptAtVal,
      status,
      sourceUrl,
    ]
  );
  const reference = mapReferenceRow(rows[0]);

  // Fire-and-forget: mirror the fbcdn video/thumbnail to R2 so the card
  // and preview modal survive Facebook's ~2-4 week URL expiry.
  mirrorReferenceMediaToR2(rows[0].id, rows[0].video_url, rows[0].thumbnail_url)
    .catch(e => console.warn(`[BriefPipeline] post-import media mirror failed for ref ${rows[0].id}: ${e.message}`));

  return { reference, alreadyExists };
}

// POST /references — import a League ad into the Reference column.
// Upserts on ad_archive_id (unique). Returns { reference, alreadyExists }.
router.post('/references', authenticate, async (req, res) => {
  try {
    const {
      brandSpyAdId,
      adArchiveId,
      brandId,
      brandName,
      tier,
      videoUrl,
      thumbnailUrl,
      headline,
      bodyText,
      transcript,
      transcriptAt,
    } = req.body || {};

    if (!brandSpyAdId || !adArchiveId || !brandId || !brandName || !tier) {
      return res.status(400).json({
        success: false,
        error: { message: 'brandSpyAdId, adArchiveId, brandId, brandName, tier are required' },
      });
    }
    if (!['BANGER', 'CHAMP', 'A'].includes(tier)) {
      return res.status(400).json({
        success: false,
        error: { message: `Invalid tier "${tier}" — must be BANGER, CHAMP, or A` },
      });
    }

    const { reference, alreadyExists } = await importLeagueAdAsReference({
      brandSpyAdId, adArchiveId, brandId, brandName, tier,
      videoUrl, thumbnailUrl, headline, bodyText, transcript, transcriptAt,
    });
    res.json({ success: true, reference, alreadyExists });
  } catch (err) {
    console.error('[BriefPipeline] POST /references error:', err.message);
    res.status(500).json({ success: false, error: { message: err.message } });
  }
});

// GET /references — list all Reference column items, newest first.
// Quarantined refs (foreign-account Meta links etc.) are HIDDEN by default —
// pass ?include_quarantined=true to surface them (admin / audit views).
router.get('/references', authenticate, async (req, res) => {
  try {
    const includeQuarantined = String(req.query.include_quarantined || '').toLowerCase() === 'true';
    const sql = includeQuarantined
      ? `SELECT * FROM brief_pipeline_references ORDER BY created_at DESC`
      : `SELECT * FROM brief_pipeline_references WHERE is_quarantined IS NOT TRUE ORDER BY created_at DESC`;
    const rows = await pgQuery(sql);
    res.json({ success: true, references: rows.map(mapReferenceRow) });
  } catch (err) {
    console.error('[BriefPipeline] GET /references error:', err.message);
    res.status(500).json({ success: false, error: { message: err.message } });
  }
});

// POST /references/:id/retry-transcribe — re-run the background transcribe
// job for a stuck reference (typically one where the original yt-dlp call
// failed). Uses the latest source URLs from creative_analysis and the
// robust extractScriptFromUrl fallback. Resets status to 'pending' first.
router.post('/references/:id/retry-transcribe', authenticate, async (req, res) => {
  if (!validateUuid(req, res)) return;
  try {
    const refRows = await pgQuery(
      `SELECT id, status, imported_metadata, source FROM brief_pipeline_references WHERE id = $1`,
      [req.params.id]
    );
    if (!refRows.length) return res.status(404).json({ success: false, error: { message: 'Reference not found' } });
    const ref = refRows[0];
    if (ref.source !== 'meta') {
      return res.status(400).json({ success: false, error: { message: 'Retry-transcribe only applies to META references' } });
    }
    let md = ref.imported_metadata;
    if (typeof md === 'string') { try { md = JSON.parse(md); } catch { md = {}; } }
    const adLibraryUrl = md?.ad_library_url || (md?.ad_id ? `https://www.facebook.com/ads/library/?id=${md.ad_id}` : null);
    if (!adLibraryUrl) {
      return res.status(400).json({ success: false, error: { message: 'No ad library URL available for this reference — cannot retry. Use Upload to paste the script manually.' } });
    }

    // C1 — concurrency guard. Atomic flip to 'extracting' that only succeeds
    // when the ref isn't already mid-transcribe. Prevents double-click /
    // double-tab from spawning two concurrent IIFEs racing on the same row
    // (last-writer-wins corruption + doubled Meta + Vertex quota burn).
    const claimed = await pgQuery(
      `UPDATE brief_pipeline_references
          SET status = 'extracting', transcript = NULL, transcript_at = NULL,
              analysis_error = NULL, video_url = NULL, updated_at = NOW()
        WHERE id = $1
          AND status NOT IN ('extracting', 'transcribing')
        RETURNING id`,
      [ref.id]
    );
    if (claimed.length === 0) {
      return res.status(409).json({
        success: false,
        error: {
          code: 'TRANSCRIBE_IN_FLIGHT',
          message: 'A transcribe job is already running for this reference. Wait ~30s and refresh.',
        },
      });
    }

    // Kick off background retry — same Meta-direct first pipeline as fresh
    // import. Path 0 (Meta-direct) takes precedence; only when meta_ad_id is
    // missing do we fall back to Playwright/yt-dlp on FB Ad Library.
    (async () => {
      // C3 — acquire concurrency slot (shared cap across import-meta + retry).
      await acquireTranscribeSlot();
      try {
        let videoUrl = null;
        let ownershipVerified = false;
        // ad_id stored in imported_metadata is Meta's ad_id (used to build
        // the ad_library_url). Treat it as our meta_ad_id for ownership resolution.
        const metaAdId = md?.ad_id || null;
        const canResolveOwned = !!metaAdId && !!META_ACCESS_TOKEN;

        // Path 0 — Meta-direct ownership resolution (CANONICAL PATH).
        if (canResolveOwned) {
          console.log(`[BriefPipeline] retry-transcribe ref ${ref.id}: Meta-direct resolve (ad_id=${metaAdId})`);
          const owned = await resolveOwnedVideoFromMeta(metaAdId);
          if (owned?.foreignAccount) {
            const warning = {
              warning: 'BRAND_MISMATCH',
              expected: 'Mineblock / MinerForge Pro',
              actual: `Meta account ${owned.accountId}`,
              selling_message: `Meta ad ${metaAdId} (${owned.adName || 'unnamed'}) belongs to account ${owned.accountId}, which is NOT in META_AD_ACCOUNT_IDS.`,
              message: `Refusing to transcribe: Meta reports this ad lives in account ${owned.accountId}, not one of Mineblock's. The linkage is wrong. Delete and re-import a real Mineblock ad.`,
            };
            await pgQuery(
              `UPDATE brief_pipeline_references
                  SET analysis_error = $1, status = 'error',
                      is_quarantined = TRUE, quarantine_reason = $1, quarantined_at = NOW(),
                      updated_at = NOW(),
                      imported_metadata = CASE
                        WHEN imported_metadata IS NULL THEN jsonb_build_object('brand_mismatch_warning', $2::jsonb, 'transcribe_source', 'refused_foreign_account'::text)
                        WHEN jsonb_typeof(imported_metadata) = 'object' THEN
                          jsonb_set(
                            jsonb_set(imported_metadata, '{brand_mismatch_warning}', $2::jsonb, true),
                            '{transcribe_source}', to_jsonb('refused_foreign_account'::text), true
                          )
                        ELSE jsonb_build_object('original', imported_metadata::text, 'brand_mismatch_warning', $2::jsonb, 'transcribe_source', 'refused_foreign_account'::text)
                      END
                WHERE id = $3`,
              [warning.message, JSON.stringify(warning), ref.id]
            );
            console.warn(`[BriefPipeline] retry-transcribe REFUSED foreign-account ad ${ref.id}: ${warning.message}`);
            return;
          }
          if (owned?.videoUrl) {
            videoUrl = owned.videoUrl;
            ownershipVerified = true;
            console.log(`[BriefPipeline] retry-transcribe ref ${ref.id}: Meta-direct OK (account=${owned.accountId}, video_id=${owned.videoId}, via=${owned._via})`);
          } else if (owned?.error) {
            // REFUSE: Meta confirmed account is ours but couldn't return the
            // video file. Playwright fallback REMOVED (see import-meta path
            // for the JD Sports Italian rap contamination evidence).
            const reason = `Meta cannot return video source URL for this owned ad (token scope insufficient). Original error: ${owned.error}. Use the Upload button to paste the script manually, or have the META_ACCESS_TOKEN regenerated as a System User token with ads_management scope.`;
            await pgQuery(
              `UPDATE brief_pipeline_references
                  SET analysis_error = $1, status = 'error', updated_at = NOW(),
                      imported_metadata = CASE
                        WHEN imported_metadata IS NULL THEN jsonb_build_object('transcribe_source', 'refused_no_video_source'::text)
                        WHEN jsonb_typeof(imported_metadata) = 'object' THEN
                          jsonb_set(imported_metadata, '{transcribe_source}', to_jsonb('refused_no_video_source'::text), true)
                        ELSE jsonb_build_object('original', imported_metadata::text, 'transcribe_source', 'refused_no_video_source'::text)
                      END
                WHERE id = $2`,
              [reason, ref.id]
            );
            console.warn(`[BriefPipeline] retry-transcribe ref ${ref.id}: Meta verified ownership but no video URL. REFUSING (no safe fallback for owned ads).`);
            return;
          }
        }

        // Playwright + yt-dlp gated on NO meta_ad_id (legacy refs). The
        // ownershipVerified path was REMOVED — Playwright on FB Ad Library
        // structurally cannot tell whether a network .mp4 is from the
        // requested ad or a related-ads carousel below it.
        const playwrightAllowed = !canResolveOwned;

        // Path 1: Playwright
        if (!videoUrl && playwrightAllowed) {
          await pgQuery(
            `UPDATE brief_pipeline_references SET status = 'extracting' WHERE id = $1`,
            [ref.id]
          ).catch(() => {});
          console.log(`[BriefPipeline] retry-transcribe ref ${ref.id}: Playwright (ownershipVerified=${ownershipVerified})`);
          videoUrl = await extractVideoUrlFromAdLibrary(adLibraryUrl);
        }

        // Path 2: yt-dlp fallback
        if (!videoUrl && playwrightAllowed) {
          console.log(`[BriefPipeline] retry-transcribe ref ${ref.id}: yt-dlp fallback (ownershipVerified=${ownershipVerified})`);
          videoUrl = await extractVideoUrlWithYtdlp(adLibraryUrl);
        }

        if (videoUrl) {
          await pgQuery(
            `UPDATE brief_pipeline_references SET video_url = $1, status = 'transcribing' WHERE id = $2`,
            [videoUrl, ref.id]
          );
          // The freshly-extracted URL is another expiring fbcdn link — mirror
          // it to R2 in the background so the row ends up with a permanent URL
          // instead of dying again in 2-4 weeks (that loop is how repaired
          // refs kept reverting to dead fbcdn URLs).
          mirrorReferenceMediaToR2(ref.id, videoUrl, null)
            .catch(e => console.warn(`[BriefPipeline] retry-transcribe post-mirror failed for ref ${ref.id}: ${e.message}`));
          const result = await transcribeVideoUrl(videoUrl);
          const { text, segments } = result;
          const mismatch = detectBrandMismatch(ref.headline, result._analysis);
          await pgQuery(
            `UPDATE brief_pipeline_references
                SET transcript = $1, transcript_at = NOW(), status = 'transcribed',
                    analysis_error = NULL,
                    imported_metadata = CASE
                          WHEN imported_metadata IS NULL THEN jsonb_build_object('transcript_segments', $2::jsonb, 'transcribe_source', $4::text, 'multimodal_analysis', $5::jsonb, 'brand_mismatch_warning', $6::jsonb)
                          WHEN jsonb_typeof(imported_metadata) = 'object' THEN
                            jsonb_set(
                              jsonb_set(
                                jsonb_set(
                                  jsonb_set(imported_metadata, '{transcript_segments}', $2::jsonb, true),
                                  '{transcribe_source}', to_jsonb($4::text), true
                                ),
                                '{multimodal_analysis}', $5::jsonb, true
                              ),
                              '{brand_mismatch_warning}', $6::jsonb, true
                            )
                          ELSE jsonb_build_object('original', imported_metadata::text, 'transcript_segments', $2::jsonb, 'transcribe_source', $4::text, 'multimodal_analysis', $5::jsonb, 'brand_mismatch_warning', $6::jsonb)
                        END,
                    updated_at = NOW()
              WHERE id = $3`,
            [text, JSON.stringify(segments || []), ref.id, result._source || 'unknown', JSON.stringify(result._analysis || null), JSON.stringify(mismatch)]
          );
          if (mismatch) console.warn(`[BriefPipeline] BRAND MISMATCH on ref ${ref.id}: ${mismatch.message}`);
          return;
        }

        // Path 3: ad-copy metadata last resort.
        // C2 — Tagged as 'ad_copy_metadata' transcribe_source so iterate-mode
        // can refuse to clone-from-marketing-copy without explicit ack. The
        // status stays 'transcribed' (the operator can see + read the text)
        // but the source field flags it for the iterate guard.
        const text = await extractScriptFromUrl(adLibraryUrl);
        if (text && text.trim().length > 30) {
          await pgQuery(
            `UPDATE brief_pipeline_references
                SET transcript = $1, transcript_at = NOW(), status = 'transcribed',
                    analysis_error = NULL,
                    imported_metadata = CASE
                      WHEN imported_metadata IS NULL THEN jsonb_build_object('transcribe_source', 'ad_copy_metadata'::text)
                      WHEN jsonb_typeof(imported_metadata) = 'object' THEN
                        jsonb_set(imported_metadata, '{transcribe_source}', to_jsonb('ad_copy_metadata'::text), true)
                      ELSE jsonb_build_object('original', imported_metadata::text, 'transcribe_source', 'ad_copy_metadata'::text)
                    END,
                    updated_at = NOW()
              WHERE id = $2`,
            [text.trim(), ref.id]
          );
        } else {
          await pgQuery(
            `UPDATE brief_pipeline_references
                SET analysis_error = $1, status = 'error', updated_at = NOW()
              WHERE id = $2`,
            ['No video found on this ad — likely image/carousel only. Use Upload to paste the script manually.', ref.id]
          );
        }
      } catch (e) {
        const safe = sanitizeMetaError(e.message);
        console.error(`[BriefPipeline] retry-transcribe ${ref.id} error:`, safe);
        await pgQuery(
          `UPDATE brief_pipeline_references SET analysis_error = $1, status = 'error', updated_at = NOW() WHERE id = $2`,
          [sanitizeMetaError(`Retry failed: ${e.message?.slice(0, 600)}`), ref.id]
        ).catch(() => {});
      } finally {
        releaseTranscribeSlot();
      }
    })();

    res.json({ success: true, message: 'Retry kicked off in the background — refresh the Reference column in ~30s.' });
  } catch (err) {
    console.error('[BriefPipeline] retry-transcribe error:', err.message);
    res.status(500).json({ success: false, error: { message: err.message } });
  }
});

// DELETE /references/:id
router.delete('/references/:id', authenticate, async (req, res) => {
  if (!validateUuid(req, res)) return;
  try {
    const rows = await pgQuery(
      `DELETE FROM brief_pipeline_references WHERE id = $1 RETURNING id`,
      [req.params.id]
    );
    if (rows.length === 0) {
      return res.status(404).json({ success: false, error: { message: 'Reference not found' } });
    }
    res.json({ success: true });
  } catch (err) {
    console.error('[BriefPipeline] DELETE /references/:id error:', err.message);
    res.status(500).json({ success: false, error: { message: err.message } });
  }
});

// ============================================================================
// ── Meta video imports (Triple Whale → Reference column) ────────────────────
//
// Mirrors staticsGeneration's /meta-ads/* but scoped to ca.type='video'
// (the live data uses `type`, not the `creative_type` migration alias)
// and writes into brief_pipeline_references with source='meta'. Transcription
// is async — we kick it off in the background using the same yt-dlp +
// Whisper/Gemini pipeline already proven by /generate-from-script.
// ============================================================================

// Cached columns lookup — creative_analysis schema evolves over time.
let _bpCaCols = null;
let _bpCaColsAt = 0;
async function getCreativeAnalysisCols() {
  if (_bpCaCols && Date.now() - _bpCaColsAt < 5 * 60_000) return _bpCaCols;
  const rows = await pgQuery(
    `SELECT column_name FROM information_schema.columns WHERE table_name = 'creative_analysis'`
  );
  _bpCaCols = new Set(rows.map(r => r.column_name));
  _bpCaColsAt = Date.now();
  return _bpCaCols;
}

// GET /meta-video-ads/accounts — list ad accounts that have at least one
// active video creative in the chosen window. Lightweight; no joins.
router.get('/meta-video-ads/accounts', authenticate, async (req, res) => {
  try {
    const cols = await getCreativeAnalysisCols();
    const windowDays = [7, 30, 90].includes(parseInt(req.query.window, 10)) ? parseInt(req.query.window, 10) : 30;
    const idCol   = cols.has('ad_account_id')   ? 'ad_account_id'   : null;
    const nameCol = cols.has('ad_account_name') ? 'ad_account_name'
                  : cols.has('account_name')   ? 'account_name'
                  : null;
    if (!idCol) {
      return res.json({ success: true, accounts: [], synced: 'no_account_column', last_sync: null });
    }
    // HARD GUARDRAIL: only return accounts in the trusted Mineblock allowlist
    // (META_AD_ACCOUNT_IDS env var). Without this, TripleWhale's broken
    // creative_id → meta_ad_id mapping can surface other brands' accounts
    // here, which is how Italian rap / ALDI ads were imported as ours.
    const sqlParams = [String(windowDays)];
    const trustedClause = trustedAccountSqlClause(idCol, sqlParams.length + 1, sqlParams);
    const trustedWhere = trustedClause ? ` AND ${trustedClause}` : '';

    const sql = `
      SELECT
        ${idCol}                                                  AS id,
        COALESCE(${nameCol ? `MAX(${nameCol})` : 'NULL'}, MAX(${idCol}))::text AS name,
        SUM(spend)::FLOAT                                         AS spend,
        MAX(synced_at)                                            AS last_sync
      FROM creative_analysis ca
      WHERE ca.type = 'video'
        AND ca.${idCol} IS NOT NULL
        AND ca.synced_at >= NOW() - ($1 || ' days')::INTERVAL${trustedWhere}
        AND (${staticAdExclusionClause('ca')})
      GROUP BY ca.${idCol}
      ORDER BY spend DESC NULLS LAST
    `;
    const rows = await pgQuery(sql, sqlParams);

    // Enrich with friendly names from Meta Graph API. Resolve EVERY account
    // ID that TW reports — not just the ones in META_AD_ACCOUNT_IDS env.
    // resolveAdAccountNames() handles bare numeric IDs (tries both raw and
    // act_-prefixed forms) and caches results 1h to avoid hammering Graph
    // on every modal open.
    const allAcctIds = rows.map(r => String(r.id)).filter(Boolean);
    let nameMap = new Map();
    try {
      nameMap = await resolveAdAccountNames(allAcctIds);
    } catch (e) {
      console.warn('[BriefPipeline] resolveAdAccountNames() failed (falling back to IDs):', e.message);
    }
    const friendly = (id, fallback) => {
      const raw = String(id || '');
      const bare = raw.replace(/^act_/i, '');
      // Try raw, bare, act_-prefixed. Then fall through to TW name, then ID label.
      return nameMap.get(raw)
          || nameMap.get(bare)
          || nameMap.get(`act_${bare}`)
          || (fallback && !/^(act_)?\d+$/i.test(fallback) ? fallback : null)
          || `Account ${bare.slice(-6)}`;
    };

    const lastSync = rows[0]?.last_sync ? new Date(rows[0].last_sync).toISOString() : null;
    res.json({
      success: true,
      accounts: rows.map(r => ({
        id:       String(r.id),
        name:     friendly(r.id, r.name),
        spend:    Number(r.spend) || 0,
        last_sync: r.last_sync ? new Date(r.last_sync).toISOString() : null,
      })),
      last_sync: lastSync,
    });
  } catch (err) {
    console.error('[BriefPipeline] /meta-video-ads/accounts error:', err.message);
    res.status(500).json({ success: false, error: { message: err.message } });
  }
});

// GET /meta-video-ads — list active video ads with filters.
router.get('/meta-video-ads', authenticate, async (req, res) => {
  try {
    const cols = await getCreativeAnalysisCols();
    const idCol   = cols.has('ad_account_id')   ? 'ad_account_id'   : null;
    const nameCol = cols.has('ad_account_name') ? 'ad_account_name'
                  : cols.has('account_name')   ? 'account_name'
                  : null;
    const hasStatus = cols.has('ad_status');

    const accountsCsv = req.query.accounts ? String(req.query.accounts) : '';
    const accounts = accountsCsv.split(',').map(a => a.trim()).filter(Boolean);
    const status = String(req.query.status || 'active').toLowerCase();
    const windowDays = [7, 30, 90].includes(parseInt(req.query.window, 10)) ? parseInt(req.query.window, 10) : 30;
    const sortKey = ['spend','revenue','roas','cpa','ctr','impressions'].includes(req.query.sort) ? req.query.sort : 'spend';
    const minRoas = parseFloat(req.query.min_roas) || 0;
    const minSpend = parseFloat(req.query.min_spend) || 0;
    const search = req.query.search ? String(req.query.search).trim() : null;
    const page  = Math.max(1, parseInt(req.query.page, 10) || 1);
    const limit = Math.min(100, Math.max(1, parseInt(req.query.limit, 10) || 20));
    const offset = (page - 1) * limit;

    // Filter to ads WITH a thumbnail — Meta CDN URLs expire but having one
    // means there's at least a chance of preview. NULL thumbnails always
    // render as blank Play icons which is confusing in the import grid.
    // STRICT_LINKAGE_VERIFIED env (opt-in until daily cron backfills the stamp):
    // when set to '1', the import grid hides any creative whose
    // meta_account_verified_at is NULL or older than 7 days. Default OFF
    // so the grid isn't empty on the very first deploy. Quarantine flag is
    // ALWAYS enforced — that flip only happens via explicit audit.
    const strictVerified = process.env.STRICT_LINKAGE_VERIFIED === '1';
    const where = [
      `ca.type = 'video'`,
      `ca.thumbnail_url IS NOT NULL`,
      `ca.thumbnail_url <> ''`,
      `ca.synced_at >= NOW() - ($1 || ' days')::INTERVAL`,
      // P1.3 — quarantined linkages NEVER appear in the grid (hard rule)
      `(ca.is_linkage_quarantined IS NULL OR ca.is_linkage_quarantined = FALSE)`,
    ];
    if (strictVerified) {
      where.push(`(ca.meta_account_verified_at IS NOT NULL AND ca.meta_account_verified_at >= NOW() - INTERVAL '7 days')`);
    }
    const params = [String(windowDays)];

    // HARD GUARDRAIL: always restrict to the trusted Mineblock account
    // allowlist. Applied IN ADDITION to whatever the user picks. Without
    // this, the import grid surfaces ads from any account TW happens to
    // sync — including cross-account contamination that has historically
    // imported other brands' videos as Mineblock's.
    if (idCol) {
      const trustedClause = trustedAccountSqlClause(`ca.${idCol}`, params.length + 1, params);
      if (trustedClause) where.push(trustedClause);
      // Always reject NULL account rows — they're not actionable and have
      // historically been the rows with the most broken video URLs.
      where.push(`ca.${idCol} IS NOT NULL`);
    }

    if (accounts.length > 0 && idCol) {
      // User-picked accounts further narrow within the trusted set
      params.push(accounts);
      where.push(`ca.${idCol} = ANY($${params.length}::text[])`);
    }

    // HARD GUARDRAIL: exclude static image creatives ("study cards", banners,
    // 1080×1080 squares) even if TripleWhale tagged them as type='video'.
    // This is the dedicated VIDEO import — image ads belong elsewhere.
    where.push(staticAdExclusionClause('ca'));
    if (status === 'active' && hasStatus) {
      where.push(`ca.ad_status = 'active'`);
    } else if (status === 'active+paused' && hasStatus) {
      where.push(`ca.ad_status IN ('active', 'paused')`);
    }
    if (search) {
      params.push(`%${search}%`);
      const i = params.length;
      where.push(`(ca.ad_name ILIKE $${i} OR ca.creative_id ILIKE $${i})`);
    }

    const accountIdSelect   = idCol   ? `ca.${idCol}`   : `'unknown'::text`;
    const accountNameSelect = nameCol ? `ca.${nameCol}` : `'Unknown'::text`;
    const autoDetectedSelect = cols.has('auto_detected') ? 'ca.auto_detected' : 'FALSE';

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
          ca.creative_id, ca.ad_name, ca.thumbnail_url, ca.meta_ad_id,
          ca.angle, ca.hook_id, ca.creative_link, ca.ad_status,
          ${autoDetectedSelect} AS auto_detected,
          ${accountIdSelect}    AS ad_account_id,
          ${accountNameSelect}  AS account_name
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
        latest.ad_status,
        latest.auto_detected,
        latest.creative_link,
        latest.angle,
        agg.spend, agg.revenue, agg.purchases, agg.impressions, agg.clicks,
        agg.latest_synced_at, agg.first_synced_at,
        (CASE WHEN agg.spend > 0 THEN agg.revenue / agg.spend ELSE 0 END)::FLOAT AS roas,
        (CASE WHEN agg.purchases > 0 THEN agg.spend / agg.purchases ELSE 0 END)::FLOAT AS cpa,
        (CASE WHEN agg.impressions > 0 THEN agg.clicks::FLOAT / agg.impressions * 100 ELSE 0 END)::FLOAT AS ctr,
        GREATEST(0, EXTRACT(DAY FROM (NOW() - agg.first_synced_at))::INTEGER) AS days_active,
        EXISTS (
          SELECT 1 FROM brief_pipeline_references bpr
          WHERE bpr.source = 'meta'
            AND (
              bpr.ad_archive_id = agg.creative_id::text
              OR (latest.meta_ad_id IS NOT NULL AND bpr.ad_archive_id = latest.meta_ad_id::text)
            )
        ) AS already_imported,
        COUNT(*) OVER () AS total_count
      FROM agg
      JOIN latest USING (creative_id)
      WHERE agg.spend >= $${params.length + 1}
        AND (CASE WHEN agg.spend > 0 THEN agg.revenue / agg.spend ELSE 0 END) >= $${params.length + 2}
      ORDER BY
        CASE $${params.length + 3}
          WHEN 'spend'       THEN agg.spend
          WHEN 'revenue'     THEN agg.revenue
          WHEN 'roas'        THEN (CASE WHEN agg.spend > 0 THEN agg.revenue / agg.spend ELSE 0 END)
          WHEN 'cpa'         THEN -1.0 * (CASE WHEN agg.purchases > 0 THEN agg.spend / agg.purchases ELSE 999999 END)
          WHEN 'ctr'         THEN (CASE WHEN agg.impressions > 0 THEN agg.clicks::FLOAT / agg.impressions ELSE 0 END)
          WHEN 'impressions' THEN agg.impressions::FLOAT
        END DESC NULLS LAST
      LIMIT $${params.length + 4} OFFSET $${params.length + 5}
    `;
    params.push(minSpend, minRoas, sortKey, limit, offset);
    const rows = await pgQuery(sql, params);
    const total = rows.length > 0 ? Number(rows[0].total_count) : 0;

    // Rewrite thumbnail_url to point at our R2-cached proxy. Browser hits
    // /api/v1/brief-pipeline/meta-thumb/<creative_id> → 302 to permanent
    // R2 URL on cache hit, lazy-uploads on miss. Falls back to the raw
    // CDN URL when R2 isn't configured (dev / local mode).
    const proxyEnabled = isR2Configured() && !!process.env.R2_PUBLIC_URL;
    const PROXY_PREFIX = '/api/v1/brief-pipeline/meta-thumb/';
    const proxyThumb = (creativeId, rawUrl) => proxyEnabled
      ? `${PROXY_PREFIX}${encodeURIComponent(creativeId)}`
      : rawUrl;

    const ads = rows.map(r => ({
      creative_id:    r.creative_id,
      ad_id:          r.meta_ad_id || r.creative_id,
      ad_name:        r.ad_name,
      account_id:     r.ad_account_id,
      account_name:   r.account_name,
      status:         (r.ad_status || 'active').toUpperCase(),
      auto_detected:  r.auto_detected === true,
      thumbnail_url:  proxyThumb(r.creative_id, r.thumbnail_url),
      creative_link:  r.creative_link,
      roas:           Number(r.roas) || 0,
      spend:          Number(r.spend) || 0,
      revenue:        Number(r.revenue) || 0,
      cpa:            Number(r.cpa) || 0,
      ctr:            Number(r.ctr) || 0,
      impressions:    Number(r.impressions) || 0,
      days_active:    Number(r.days_active) || 0,
      already_imported: r.already_imported === true,
    }));

    res.json({ success: true, ads, total, page, limit });
  } catch (err) {
    console.error('[BriefPipeline] /meta-video-ads error:', err.message);
    res.status(500).json({ success: false, error: { message: err.message } });
  }
});

// POST /references/import-meta — bulk-create META-sourced references.
// Transcription is fire-and-forget — the row lands immediately with
// status='pending', and a background task fills transcript when extracted.
router.post('/references/import-meta', authenticate, async (req, res) => {
  try {
    const { creativeIds, window } = req.body || {};
    if (!Array.isArray(creativeIds) || creativeIds.length === 0) {
      return res.status(400).json({ success: false, error: { message: 'creativeIds[] is required' } });
    }
    const windowDays = [7, 30, 90].includes(parseInt(window, 10)) ? parseInt(window, 10) : 30;
    const cols = await getCreativeAnalysisCols();
    const idCol   = cols.has('ad_account_id')   ? 'ad_account_id'   : null;
    const nameCol = cols.has('ad_account_name') ? 'ad_account_name'
                  : cols.has('account_name')   ? 'account_name'
                  : null;
    const accountIdSelect   = idCol   ? `ca.${idCol}`   : `'unknown'::text`;
    const accountNameSelect = nameCol ? `ca.${nameCol}` : `'Unknown'::text`;

    // Pull the highest-spend row per creative_id — that's the canonical record.
    // HARD GUARDRAIL: restrict to trusted Mineblock accounts. If META_AD_ACCOUNT_IDS
    // is set, any creative_id whose canonical row is not in the trusted set is
    // dropped here. The audit endpoint reports skipped IDs so the operator
    // knows what was refused (instead of silently importing the wrong brand).
    const importParams = [creativeIds.map(String)];
    const importTrustedClause = idCol
      ? trustedAccountSqlClause(`ca.${idCol}`, importParams.length + 1, importParams)
      : null;
    const importTrustedWhere = importTrustedClause
      ? ` AND ${importTrustedClause} AND ca.${idCol} IS NOT NULL`
      : '';

    const rows = await pgQuery(
      `SELECT DISTINCT ON (ca.creative_id)
         ca.creative_id, ca.ad_name, ca.thumbnail_url, ca.meta_ad_id,
         ca.creative_link, ca.video_url, ca.angle, ca.synced_at,
         ca.spend::FLOAT AS spend, ca.revenue::FLOAT AS revenue,
         ca.roas::FLOAT AS roas, ca.cpa::FLOAT AS cpa, ca.ctr::FLOAT AS ctr,
         ca.impressions::BIGINT AS impressions,
         ${accountIdSelect}   AS ad_account_id,
         ${accountNameSelect} AS account_name
       FROM creative_analysis ca
       WHERE ca.creative_id = ANY($1::text[])
         AND ca.type = 'video'${importTrustedWhere}
         AND (ca.is_linkage_quarantined IS NULL OR ca.is_linkage_quarantined = FALSE)
         AND (${staticAdExclusionClause('ca')})
       ORDER BY ca.creative_id, ca.spend DESC NULLS LAST`,
      importParams
    );

    // Report refused creative_ids back so the UI can show why they weren't imported.
    const importedCreativeIds = new Set(rows.map((r) => String(r.creative_id)));
    const refused = creativeIds
      .map(String)
      .filter((cid) => !importedCreativeIds.has(cid));
    if (refused.length > 0) {
      console.warn(`[BriefPipeline] /import-meta refused ${refused.length} creative_ids not in trusted accounts:`, refused.slice(0, 10));
    }

    const imported = [];
    for (const r of rows) {
      const extKey = String(r.meta_ad_id || r.creative_id);
      const adLibraryUrl = r.meta_ad_id
        ? `https://www.facebook.com/ads/library/?id=${r.meta_ad_id}`
        : (r.creative_link || null);

      const metaJson = {
        ad_id:           r.meta_ad_id || r.creative_id,
        creative_id:     r.creative_id,
        account_id:      r.ad_account_id,
        account_name:    r.account_name,
        roas:            Number(r.roas) || 0,
        spend:           Number(r.spend) || 0,
        revenue:         Number(r.revenue) || 0,
        cpa:             Number(r.cpa) || 0,
        ctr:             Number(r.ctr) || 0,
        impressions:     Number(r.impressions) || 0,
        angle:           r.angle,
        creative_link:   r.creative_link,
        ad_library_url:  adLibraryUrl,
        last_synced_at:  r.synced_at,
        // The user-chosen time window (in days) when they picked this ad
        // from the modal. Drives the "(Nd)" suffix on the ReferenceCard
        // performance strip so the operator knows whose ROAS this is.
        window_days:     windowDays,
      };

      // C4 — Re-import preserves existing transcripts. Previously this
      // unconditionally nuked transcript/status, so re-clicking Import on
      // an already-transcribed ref destroyed hours of analyzer output.
      // Now the UPDATE branch only refreshes metadata; transcript is
      // preserved. The query param `?force=1` reverts to the old destructive
      // behavior for cases where the operator KNOWS they need a re-extract.
      const forceRefresh = String(req.query.force || '').toLowerCase() === '1';
      const conflictClause = forceRefresh
        ? `DO UPDATE SET
           brand_name        = EXCLUDED.brand_name,
           thumbnail_url     = COALESCE(EXCLUDED.thumbnail_url, brief_pipeline_references.thumbnail_url),
           headline          = COALESCE(EXCLUDED.headline,      brief_pipeline_references.headline),
           imported_metadata = EXCLUDED.imported_metadata,
           source_url        = COALESCE(EXCLUDED.source_url, brief_pipeline_references.source_url),
           video_url         = NULL,
           transcript        = NULL,
           transcript_at     = NULL,
           analysis_error    = NULL,
           status            = 'pending',
           updated_at        = NOW()`
        : `DO UPDATE SET
           brand_name        = EXCLUDED.brand_name,
           thumbnail_url     = COALESCE(EXCLUDED.thumbnail_url, brief_pipeline_references.thumbnail_url),
           headline          = COALESCE(EXCLUDED.headline,      brief_pipeline_references.headline),
           imported_metadata = EXCLUDED.imported_metadata,
           source_url        = COALESCE(EXCLUDED.source_url, brief_pipeline_references.source_url),
           updated_at        = NOW()`;
      const inserted = await pgQuery(
        `INSERT INTO brief_pipeline_references (
           brand_spy_ad_id, ad_archive_id, brand_id, brand_name, tier,
           video_url, thumbnail_url, headline, body_text, transcript, status,
           source, imported_metadata, source_url
         )
         VALUES (NULL, $1, NULL, $2, 'OUR', NULL, $3, $4, NULL, NULL, 'pending', 'meta', $5, $6)
         ON CONFLICT (ad_archive_id, source) ${conflictClause}
         RETURNING id, status, (xmax = 0) AS was_inserted`,
        // Store the proxy URL so the saved Reference card never breaks. The
        // proxy is keyed on creative_id which is stable across re-syncs.
        [
          extKey,
          r.account_name || 'Triple Whale',
          (isR2Configured() && process.env.R2_PUBLIC_URL && r.thumbnail_url)
            ? `/api/v1/brief-pipeline/meta-thumb/${encodeURIComponent(r.creative_id)}`
            : (r.thumbnail_url || null),
          r.ad_name || null,
          JSON.stringify(metaJson),
          adLibraryUrl || null,
        ]
      );
      const ref = inserted[0];
      imported.push({ id: ref.id, ad_id: extKey, creative_id: r.creative_id, meta_ad_id: r.meta_ad_id, ad_name: r.ad_name, status: ref.status, was_inserted: ref.was_inserted });

      // Fire-and-forget: warm the R2 cache for this thumbnail now so the
      // very first time someone views the Reference card, R2 already has
      // the bytes (no slow first-load + redirect). Cheap upload, ~50KB.
      if (isR2Configured() && process.env.R2_PUBLIC_URL && r.thumbnail_url) {
        (async () => {
          try {
            const key = `meta-thumbs/${r.creative_id}.jpg`;
            const src = await fetch(r.thumbnail_url, { signal: AbortSignal.timeout(8000) });
            if (src.ok) {
              const buf = Buffer.from(await src.arrayBuffer());
              await uploadBuffer(buf, key, src.headers.get('content-type') || 'image/jpeg');
            }
          } catch (e) {
            // Swallow — proxy endpoint will re-try on first view
            console.warn(`[import-meta] R2 thumb pre-cache failed for ${r.creative_id}:`, e.message);
          }
        })();
      }

      // Background transcription. Strategy (fastest first):
      //   1. ca.video_url (direct CDN URL from TW — instant if populated)
      //   2. ca.creative_link if it ends in .mp4 / .webm / .mov / .m4v
      //   3. Playwright on the FB Ad Library page — renders JS, intercepts
      //      .mp4 network requests, returns CDN URL. ~1-2s warm. THE PATH
      //      that makes this work for ads without TW URLs (most of them).
      //   4. yt-dlp fallback (static HTML parser — rarely succeeds for FB
      //      Ad Library but cheap to try).
      //   5. extractScriptFromUrl — last resort, ad-copy metadata only.
      const directVideoCandidate = r.video_url
        || (r.creative_link && /\.(mp4|webm|mov|m4v)(\?|$)/i.test(r.creative_link) ? r.creative_link : null);
      // We now ALWAYS try Meta-direct first if we have a meta_ad_id, even
      // when a TW direct URL exists. This guarantees the transcribed video
      // is the one currently owned by one of our trusted Meta ad accounts.
      const canResolveOwned = !!r.meta_ad_id && !!META_ACCESS_TOKEN;
      if (canResolveOwned || directVideoCandidate || adLibraryUrl) {
        // C1 — atomic claim. Only spawn a background IIFE if the row isn't
        // already mid-extract. Without this, a second import-meta call on the
        // same creative_id (or a re-import via force=1 fired twice) would
        // launch parallel pipelines racing on the same row.
        const claimed = await pgQuery(
          `UPDATE brief_pipeline_references
              SET status = 'extracting', updated_at = NOW()
            WHERE id = $1
              AND status NOT IN ('extracting', 'transcribing')
              AND (transcript IS NULL OR $2::boolean = TRUE)
            RETURNING id`,
          [ref.id, forceRefresh]
        ).catch(() => []);
        if (claimed.length === 0) {
          // Either already transcribing OR transcript exists and not force-mode.
          // Don't double-fire. The frontend can poll /references to see state.
          continue;
        }
        (async () => {
          // C3 — Cap parallel transcribe jobs across all import-meta calls
          // to prevent Meta rate-limit + Playwright OOM on bulk imports.
          await acquireTranscribeSlot();
          try {
            let videoUrl = null;
            let resolvedSource = null;
            // ownershipVerified: Meta confirmed the ad_id lives in one of OUR
            // trusted accounts. When TRUE, fallbacks to Playwright/yt-dlp are
            // SAFE — the ad_archive_id we'd open in FB Ad Library is
            // structurally guaranteed to be ours. The original concern that
            // Playwright might scrape a foreign brand's video doesn't apply.
            let ownershipVerified = false;

            // Path 0 — Meta-direct ownership resolution (CANONICAL PATH).
            // Confirm the ad belongs to a Mineblock account, then ask Meta
            // for the video file straight from Marketing API. If Meta says
            // foreign, we REFUSE. If Meta confirms ours but can't return the
            // video file, we mark ownershipVerified and let Playwright try.
            if (canResolveOwned) {
              console.log(`[BriefPipeline] transcribe ref ${ref.id}: Meta-direct resolve (ad_id=${r.meta_ad_id})`);
              const owned = await resolveOwnedVideoFromMeta(r.meta_ad_id);
              if (owned?.foreignAccount) {
                const warning = {
                  warning: 'BRAND_MISMATCH',
                  expected: 'Mineblock / MinerForge Pro',
                  actual: `Meta account ${owned.accountId}`,
                  selling_message: `Meta ad ${r.meta_ad_id} (${owned.adName || 'unnamed'}) belongs to account ${owned.accountId}, which is NOT in META_AD_ACCOUNT_IDS.`,
                  message: `Refusing to transcribe: Meta reports this ad lives in account ${owned.accountId}, not one of Mineblock's. The linkage in creative_analysis.meta_ad_id is wrong. Re-import a real Mineblock ad.`,
                };
                await pgQuery(
                  `UPDATE brief_pipeline_references
                      SET analysis_error = $1, status = 'error', updated_at = NOW(),
                          imported_metadata = CASE
                            WHEN imported_metadata IS NULL THEN jsonb_build_object('brand_mismatch_warning', $2::jsonb, 'transcribe_source', 'refused_foreign_account'::text)
                            WHEN jsonb_typeof(imported_metadata) = 'object' THEN
                              jsonb_set(
                                jsonb_set(imported_metadata, '{brand_mismatch_warning}', $2::jsonb, true),
                                '{transcribe_source}', to_jsonb('refused_foreign_account'::text), true
                              )
                            ELSE jsonb_build_object('original', imported_metadata::text, 'brand_mismatch_warning', $2::jsonb, 'transcribe_source', 'refused_foreign_account'::text)
                          END
                    WHERE id = $3`,
                  [warning.message, JSON.stringify(warning), ref.id]
                );
                console.warn(`[BriefPipeline] REFUSED foreign-account ad on ref ${ref.id}: ${warning.message}`);
                return;
              }
              if (owned?.videoUrl) {
                videoUrl = owned.videoUrl;
                ownershipVerified = true;
                resolvedSource = `meta_graph:${owned._via || 'unknown'}`;
                console.log(`[BriefPipeline] ref ${ref.id}: Meta-direct OK (account=${owned.accountId}, video_id=${owned.videoId}, via=${owned._via})`);
              } else if (owned?.error) {
                // Meta confirmed account is trusted (no foreignAccount flag) but
                // couldn't return the video file URL. Verified through live
                // browser test: Playwright fallback on FB Ad Library grabs
                // the WRONG video here (related-ads carousel videos, e.g. JD
                // Sports "Forever Forward" Italian rap leaking into a B0223
                // Mineblock ad). Refusing instead of guessing is the only
                // safe option. Fix: regenerate META_ACCESS_TOKEN as a System
                // User token with ads_management scope so /{video_id}?fields=source
                // actually returns the canonical URL.
                const reason = `Meta cannot return video source URL for this owned ad (token scope insufficient). Original error: ${owned.error}. Use the Upload button to paste the script manually, or have the META_ACCESS_TOKEN regenerated as a System User token with ads_management scope.`;
                await pgQuery(
                  `UPDATE brief_pipeline_references
                      SET analysis_error = $1, status = 'error', updated_at = NOW(),
                          imported_metadata = CASE
                            WHEN imported_metadata IS NULL THEN jsonb_build_object('transcribe_source', 'refused_no_video_source'::text)
                            WHEN jsonb_typeof(imported_metadata) = 'object' THEN
                              jsonb_set(imported_metadata, '{transcribe_source}', to_jsonb('refused_no_video_source'::text), true)
                            ELSE jsonb_build_object('original', imported_metadata::text, 'transcribe_source', 'refused_no_video_source'::text)
                          END
                    WHERE id = $2`,
                  [reason, ref.id]
                );
                console.warn(`[BriefPipeline] ref ${ref.id}: Meta verified ownership but no video URL. REFUSING (Playwright fallback removed — it grabbed wrong videos from FB Ad Library "related ads" panel).`);
                return;
              }
            }

            // Path 1/2 — direct TW URL fallback (instant if populated).
            if (!videoUrl && directVideoCandidate) {
              videoUrl = directVideoCandidate;
              resolvedSource = r.video_url ? 'ca_video_url' : 'ca_creative_link';
              console.log(`[BriefPipeline] transcribe ref ${ref.id}: direct TW URL (${resolvedSource})`);
            }

            // Path 3 — Playwright headless browser. Gated on NO meta_ad_id
            // (legacy refs / League imports of competitor studies). When
            // meta_ad_id exists, we never reach this path — either Meta
            // gave us video_url, or we refused above. The ownershipVerified
            // path was REMOVED because Playwright on FB Ad Library
            // structurally cannot tell whether a network .mp4 is from the
            // requested ad or a related-ads carousel below it.
            const playwrightAllowed = !canResolveOwned;
            if (!videoUrl && adLibraryUrl && playwrightAllowed) {
              await pgQuery(
                `UPDATE brief_pipeline_references SET status = 'extracting', updated_at = NOW() WHERE id = $1 AND status IN ('pending', 'extracting')`,
                [ref.id]
              ).catch(() => {});
              console.log(`[BriefPipeline] transcribe ref ${ref.id}: Playwright extraction (ownershipVerified=${ownershipVerified})`);
              videoUrl = await extractVideoUrlFromAdLibrary(adLibraryUrl);
              if (videoUrl) resolvedSource = 'playwright_fb_ad_library';
            }

            // Path 4 — yt-dlp fallback. Same ownership gate as Playwright.
            if (!videoUrl && adLibraryUrl && playwrightAllowed) {
              console.log(`[BriefPipeline] transcribe ref ${ref.id}: yt-dlp fallback (ownershipVerified=${ownershipVerified})`);
              videoUrl = await extractVideoUrlWithYtdlp(adLibraryUrl);
              if (videoUrl) resolvedSource = 'ytdlp_fb_ad_library';
            }

            if (videoUrl) {
              await pgQuery(
                `UPDATE brief_pipeline_references
                    SET video_url = $1, status = 'transcribing', updated_at = NOW()
                  WHERE id = $2`,
                [videoUrl, ref.id]
              );
              // Mirror the fresh (expiring) URL to R2 in the background — see
              // retry-transcribe: never leave an fbcdn URL as the stored value.
              mirrorReferenceMediaToR2(ref.id, videoUrl, null)
                .catch(e => console.warn(`[BriefPipeline] transcribe post-mirror failed for ref ${ref.id}: ${e.message}`));
              const result = await transcribeVideoUrl(videoUrl);
              const { text, segments } = result;
              const mismatch = detectBrandMismatch(ref.headline, result._analysis);
              await pgQuery(
                `UPDATE brief_pipeline_references
                    SET transcript      = $1,
                        transcript_at   = NOW(),
                        status          = 'transcribed',
                        analysis_error  = NULL,
                        imported_metadata = CASE
                          WHEN imported_metadata IS NULL THEN jsonb_build_object('transcript_segments', $2::jsonb, 'transcribe_source', $4::text, 'multimodal_analysis', $5::jsonb, 'brand_mismatch_warning', $6::jsonb)
                          WHEN jsonb_typeof(imported_metadata) = 'object' THEN
                            jsonb_set(
                              jsonb_set(
                                jsonb_set(
                                  jsonb_set(imported_metadata, '{transcript_segments}', $2::jsonb, true),
                                  '{transcribe_source}', to_jsonb($4::text), true
                                ),
                                '{multimodal_analysis}', $5::jsonb, true
                              ),
                              '{brand_mismatch_warning}', $6::jsonb, true
                            )
                          ELSE jsonb_build_object('original', imported_metadata::text, 'transcript_segments', $2::jsonb, 'transcribe_source', $4::text, 'multimodal_analysis', $5::jsonb, 'brand_mismatch_warning', $6::jsonb)
                        END,
                        updated_at      = NOW()
                  WHERE id = $3`,
                [text, JSON.stringify(segments || []), ref.id, result._source || 'unknown', JSON.stringify(result._analysis || null), JSON.stringify(mismatch)]
              );
              if (mismatch) console.warn(`[BriefPipeline] BRAND MISMATCH on ref ${ref.id}: ${mismatch.message}`);
              return;
            }

            // Path 5 — extractScriptFromUrl last resort. Hits Meta Graph
            // ads_archive for ad-copy metadata. NOT a real transcription —
            // just whatever text Meta exposes about the ad. Tagged with
            // transcribe_source='ad_copy_metadata' (C2) so iterate-mode
            // can refuse to clone from marketing copy without explicit ack.
            if (adLibraryUrl) {
              console.log(`[BriefPipeline] transcribe ref ${ref.id}: extractScriptFromUrl last resort`);
              try {
                const text = await extractScriptFromUrl(adLibraryUrl);
                if (text && text.trim().length > 30) {
                  await pgQuery(
                    `UPDATE brief_pipeline_references
                        SET transcript      = $1,
                            transcript_at   = NOW(),
                            status          = 'transcribed',
                            analysis_error  = NULL,
                            imported_metadata = CASE
                              WHEN imported_metadata IS NULL THEN jsonb_build_object('transcribe_source', 'ad_copy_metadata'::text)
                              WHEN jsonb_typeof(imported_metadata) = 'object' THEN
                                jsonb_set(imported_metadata, '{transcribe_source}', to_jsonb('ad_copy_metadata'::text), true)
                              ELSE jsonb_build_object('original', imported_metadata::text, 'transcribe_source', 'ad_copy_metadata'::text)
                            END,
                            updated_at      = NOW()
                      WHERE id = $2`,
                    [text.trim(), ref.id]
                  );
                  return;
                }
              } catch (fallbackErr) {
                console.warn(`[BriefPipeline] extractScriptFromUrl failed for ref ${ref.id}:`, sanitizeMetaError(fallbackErr.message));
              }
            }

            // All paths exhausted — this ad has no extractable video content
            await pgQuery(
              `UPDATE brief_pipeline_references
                  SET analysis_error = $1, status = 'error', updated_at = NOW()
                WHERE id = $2 AND transcript IS NULL`,
              ['No video found on this ad — likely an image / carousel ad, or the FB Ad Library page didn\'t load video content. Use the Upload button below to paste the script manually.', ref.id]
            );
          } catch (err) {
            console.error(`[BriefPipeline] async transcribe failed for ref ${ref.id}:`, sanitizeMetaError(err.message));
            await pgQuery(
              `UPDATE brief_pipeline_references
                  SET analysis_error = $1, status = 'error', updated_at = NOW()
                WHERE id = $2`,
              [sanitizeMetaError(`Transcription failed: ${err.message?.slice(0, 600)}`), ref.id]
            ).catch(() => {});
          } finally {
            releaseTranscribeSlot();
          }
        })();
      }
    }

    res.json({
      success: true,
      imported,
      refused_count: refused.length,
      refused, // creative_ids dropped because they're not in trusted Mineblock accounts
      trusted_account_filter_active: TRUSTED_ACCOUNT_IDS_NORM.size > 0,
    });
  } catch (err) {
    console.error('[BriefPipeline] /references/import-meta error:', err.message);
    res.status(500).json({ success: false, error: { message: err.message } });
  }
});

// POST /enhance-script — clean up raw pasted text for the Script Generator.
// Replaces the never-implemented /magic-writer/enhance endpoint. Takes any
// raw text (transcript dumps, hand-typed scripts, OCR output) and returns
// the same content with grammar fixed, punctuation normalized, line breaks
// preserved — voice / structure / claims kept verbatim.
router.post('/enhance-script', authenticate, async (req, res) => {
  try {
    const { text } = req.body || {};
    if (!text || typeof text !== 'string' || text.trim().length < 20) {
      return res.status(400).json({
        success: false,
        error: { message: 'text is required and must be at least 20 characters' },
      });
    }
    const system = 'You are a careful copy editor. You receive raw ad-script text — typo-ridden, missing punctuation, transcribed speech — and return the same script with: spelling fixed, punctuation normalized, sentence boundaries cleaned, run-ons broken, paragraph breaks preserved. You MUST NOT change the voice, the claims, the structure, or the meaning. You MUST NOT add new sentences. You MUST NOT remove specific numbers, brand names, or product mentions. If a phrase is intentional (slang, emphasis, deliberate fragmentation), keep it. Output ONLY the cleaned-up text — no preamble, no explanation, no quotes.';
    const user = `# RAW SCRIPT\n${text}\n\n# OUTPUT\nReturn the cleaned-up version of the above, nothing else.`;
    const enhanced = await callClaude(system, user, 4000, { fast: true, rawText: true });
    if (!enhanced || typeof enhanced !== 'string' || enhanced.trim().length < 10) {
      return res.status(502).json({
        success: false,
        error: { message: 'Enhancer returned an empty response — try again' },
      });
    }
    res.json({ success: true, enhanced: enhanced.trim() });
  } catch (err) {
    console.error('[BriefPipeline] /enhance-script error:', err.message);
    res.status(500).json({ success: false, error: { message: err.message } });
  }
});

// POST /references/upload — manual paste (UPLOAD source).
router.post('/references/upload', authenticate, async (req, res) => {
  try {
    const { rawScript, sourceUrl, brandName, headline, bodyText, thumbnailUrl } = req.body || {};
    if (!rawScript || typeof rawScript !== 'string' || rawScript.trim().length < 20) {
      return res.status(400).json({
        success: false,
        error: { message: 'rawScript is required and must be at least 20 characters' },
      });
    }
    const extKey = `upload_${crypto.randomBytes(8).toString('hex')}`;
    const meta = { sourceUrl: sourceUrl || null };

    // Note: source_url goes into its own column now (was incorrectly stuffed
    // into video_url before — that column is reserved for direct CDN video
    // file URLs the transcriber can pull bytes from). Old uploads with the
    // URL in video_url stay there; new ones populate both columns where the
    // operator gave us a URL, so the push-to-ClickUp fallback chain can see
    // it. Editors get a Reference link in every ClickUp task.
    const inserted = await pgQuery(
      `INSERT INTO brief_pipeline_references (
         brand_spy_ad_id, ad_archive_id, brand_id, brand_name, tier,
         video_url, thumbnail_url, headline, body_text, transcript, transcript_at,
         status, source, imported_metadata, source_url
       )
       VALUES (NULL, $1, NULL, $2, 'UPLOAD', $3, $4, $5, $6, $7, NOW(), 'transcribed', 'upload', $8, $9)
       RETURNING *`,
      [
        extKey,
        brandName || 'Pasted script',
        sourceUrl || null,
        thumbnailUrl || null,
        headline || null,
        bodyText || null,
        rawScript.trim(),
        JSON.stringify(meta),
        sourceUrl || null,
      ]
    );
    res.json({ success: true, reference: mapReferenceRowWithAnalysis(inserted[0]) });
  } catch (err) {
    console.error('[BriefPipeline] /references/upload error:', err.message);
    res.status(500).json({ success: false, error: { message: err.message } });
  }
});

// ============================================================================
// ── League Prompts (3 user-editable JSON prompt slots) ──────────────────────
//
// Separate namespace from the existing 8-prompt `brief_pipeline_prompts`. The
// three slots here are the prompts the user is iterating on for the
// League-driven flow:
//   1. videoAnalysis     — full analysis of a chosen video reference
//                          (League or a winning-script iteration).
//   2. scriptAdaptation  — adapt a competitor script to OUR product.
//   3. scriptIteration   — generate iterations of a winning script.
//
// Each slot holds a free-form JSON payload (the user owns the schema). The
// UI ships an empty default and the user pastes their JSON; we store and
// return it verbatim.
// ============================================================================

const LEAGUE_PROMPT_TYPES = [
  {
    key: 'scriptAnalysis',
    label: 'Script Analysis',
    description: 'Full structural + emotional analysis of a chosen video reference. Output powers the Reference Analysis page.',
  },
  {
    key: 'scriptClone',
    label: '1:1 Script Clone',
    description: 'Clone a competitor script for OUR product — preserve narrative architecture, swap product + mechanism, infuse the selected angle.',
  },
  {
    key: 'scriptIteration',
    label: 'Script Iteration',
    description: 'Generate fresh iterations of one of OUR winning scripts (new hooks / body variants / angle pivots) — no product swap.',
  },
];

const DEFAULT_LEAGUE_PROMPTS = {
  scriptAnalysis:  { json: '', notes: '' },
  scriptClone:     { json: '', notes: '' },
  scriptIteration: { json: '', notes: '' },
};

let leaguePromptsCache = { data: null, timestamp: 0 };
const LEAGUE_PROMPT_CACHE_TTL = 5 * 60 * 1000;

async function getLeaguePrompts() {
  if (leaguePromptsCache.data && Date.now() - leaguePromptsCache.timestamp < LEAGUE_PROMPT_CACHE_TTL) {
    return leaguePromptsCache.data;
  }
  try {
    const rows = await pgQuery(
      `SELECT value FROM system_settings WHERE key = 'brief_pipeline_league_prompts'`
    );
    const v = rows.length
      ? (typeof rows[0].value === 'string' ? JSON.parse(rows[0].value) : rows[0].value)
      : null;
    leaguePromptsCache = { data: v, timestamp: Date.now() };
    return v;
  } catch {
    return null;
  }
}

// Boot-time prompt cleanup + seeder.
//
// State the operator asked for:
//   - KEEP: scriptAnalysis (the new analysis JSON prompt — uses the inline
//           DEFAULT_REFERENCE_ANALYZER_PROMPT until overridden via Settings)
//   - KEEP: scriptClone   (the new v1 clone prompt designed above; seeded
//           into the DB so it appears in the Settings UI as editable)
//   - DELETE: every other old prompt — the legacy `brief_pipeline_prompts`
//             system_setting row (8-prompt store, never used by League flow),
//             and any stale entries in the league_prompts row outside the
//             3 supported slot keys.
//
// Idempotent + safe to re-run. Runs 5s post-boot so it doesn't race the
// migration runner.
async function seedDefaultLeaguePrompts() {
  try {
    // 1) Wipe the legacy 8-prompt store entirely.
    await pgQuery(`DELETE FROM system_settings WHERE key = 'brief_pipeline_prompts'`).catch(() => {});

    // 2) Read league_prompts, migrate legacy slot keys, prune unsupported keys.
    const existing = (await getLeaguePrompts()) || {};
    const allowed = new Set(['scriptAnalysis', 'scriptClone', 'scriptIteration']);

    // Legacy slot rename: videoAnalysis → scriptAnalysis, scriptAdaptation → scriptClone.
    if (existing.videoAnalysis && !existing.scriptAnalysis) {
      existing.scriptAnalysis = existing.videoAnalysis;
    }
    if (existing.scriptAdaptation && !existing.scriptClone) {
      existing.scriptClone = existing.scriptAdaptation;
    }
    for (const k of Object.keys(existing)) {
      if (!allowed.has(k)) delete existing[k];
    }

    // 3) Seed (or force-refresh) scriptClone. The slot stores a snapshot of
    //    DEFAULT_CLONE_PROMPT_*, so once seeded, subsequent edits to the
    //    baked default never reach production (they get masked by the saved
    //    DB row). Use a signature string from the latest prompt revision —
    //    if it's missing, overwrite with the current baked default. This is
    //    one-shot per signature bump and leaves operator edits alone once
    //    they include the marker.
    // v5 — LENGTH CONTRACT revision: numeric word-count targets
    // ({{ORIGINAL_WORD_COUNT}}/{{MIN_WORDS}}), source_beats back in the JSON
    // schema with per-beat word budgets, hooks emitted AFTER the body with a
    // blend test, testimonial-persona swap + proof-substitution rules.
    // Bumping the signature force-refreshes any pre-v5 snapshot once.
    // v6.5 signature: 'DOORS into the body' exists only in the revision that
    // adds the no-hook-may-restate-the-body's-opening-line rule (the hooks are
    // alternative doors, never a copy of the body's opening — fixes H1
    // duplicating the signature-device opener). Sits on top of v6.4's
    // anti-paraphrase + signature-device-verbatim rules and v6.3's no-dash rule.
    // One-shot snapshot refresh, then operator edits stick.
    const CLONE_V2_SIGNATURE = 'DOORS into the body';
    const currentClone = existing.scriptClone?.json || '';
    if (!currentClone.trim() || !currentClone.includes(CLONE_V2_SIGNATURE)) {
      existing.scriptClone = {
        json: JSON.stringify(
          { system: DEFAULT_CLONE_PROMPT_SYSTEM, user: DEFAULT_CLONE_PROMPT_USER },
          null,
          2,
        ),
        notes: 'scriptClone v2 — clones competitor narrative architecture into our product, including on-screen overlay labels via highlighted_text[]. Uses {{PRODUCT_CONTEXT}}, {{ANGLES_LIST}}, {{ANGLE_NAME}}, {{ANGLE_DETAILS}}, {{ORIGINAL_HOOKS}}, {{ORIGINAL_BODY}}, {{ORIGINAL_CTA}}, {{ORIGINAL_ON_SCREEN_TEXT}}, {{ANALYSIS_CONTEXT}} placeholders.',
      };
    }

    // 4) Force-overwrite scriptIteration with v1 if it doesn't already
    //    contain the v1 signature. This kills any old / bad iteration prompt
    //    one time, then leaves the slot alone on subsequent boots so user
    //    edits stick.
    const ITERATION_V1_SIGNATURE = 'ONE CARD = 1 body + 5 hooks';
    const currentIter = existing.scriptIteration?.json || '';
    if (!currentIter.includes(ITERATION_V1_SIGNATURE)) {
      existing.scriptIteration = {
        json: JSON.stringify(
          { system: DEFAULT_ITERATION_PROMPT_SYSTEM, user: DEFAULT_ITERATION_PROMPT_USER },
          null,
          2,
        ),
        notes: 'scriptIteration v1 — iterates a proven winning script on selected vectors only (hooks / format / avatar / length / proof lead / opening 3s). Angle, product, mechanism, CTA structure are LOCKED. Every card = 1 body + 5 hooks + 1 CTA. Uses {{PRODUCT_CONTEXT}}, {{FORMATS_LIST}}, {{AVATARS_LIST}}, {{VECTORS_SELECTED}}, {{REFERENCE_TRANSCRIPT}}, {{PERFORMANCE_CONTEXT}}, {{ANGLE_LOCKED}}, {{NUM_VARIATIONS}} placeholders. Output carries only what_changed (one sentence per card) — no other metadata.',
      };
    }

    // 5) Ensure scriptAnalysis slot exists (empty = use inline default).
    if (!existing.scriptAnalysis) existing.scriptAnalysis = { json: '', notes: 'scriptAnalysis — uses the inline DEFAULT_REFERENCE_ANALYZER_PROMPT until you paste a custom JSON here.' };

    await pgQuery(
      `INSERT INTO system_settings (key, value, description)
       VALUES ('brief_pipeline_league_prompts', $1, 'Brief Pipeline prompts (scriptAnalysis / scriptClone / scriptIteration)')
       ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value, updated_at = NOW()`,
      [JSON.stringify(existing)]
    );
    leaguePromptsCache = { data: existing, timestamp: Date.now() };
    console.log('[BriefPipeline] Prompt cleanup + seed complete (scriptClone seeded; scriptAnalysis + scriptIteration slots ensured).');
  } catch (err) {
    console.warn('[BriefPipeline] seedDefaultLeaguePrompts failed:', err.message);
  }
}
// Fire 5s post-boot so it doesn't race the migration runner.
setTimeout(() => { seedDefaultLeaguePrompts(); }, 5000);

// GET /settings/league-prompts — return saved + defaults
router.get('/settings/league-prompts', authenticate, async (_req, res) => {
  try {
    const saved = await getLeaguePrompts();
    res.json({
      success: true,
      promptTypes: LEAGUE_PROMPT_TYPES,
      defaults: DEFAULT_LEAGUE_PROMPTS,
      prompts: saved || {},
      hasCustom: !!saved,
    });
  } catch (err) {
    res.status(500).json({ success: false, error: { message: err.message } });
  }
});

// PUT /settings/league-prompts — save full or partial { prompts: { key: {json,notes}, ... } }
router.put('/settings/league-prompts', authenticate, async (req, res) => {
  try {
    const { prompts } = req.body || {};
    if (!prompts || typeof prompts !== 'object') {
      return res.status(400).json({ success: false, error: { message: 'prompts object is required' } });
    }
    // Validate each provided slot — its `json` field must parse if non-empty
    const validKeys = new Set(LEAGUE_PROMPT_TYPES.map(p => p.key));
    const clean = {};
    for (const [key, val] of Object.entries(prompts)) {
      if (!validKeys.has(key)) continue;
      const json = typeof val?.json === 'string' ? val.json : '';
      const notes = typeof val?.notes === 'string' ? val.notes : '';
      if (json.trim()) {
        try { JSON.parse(json); } catch (e) {
          return res.status(400).json({
            success: false,
            error: { message: `Prompt "${key}" has invalid JSON: ${e.message}` },
          });
        }
      }
      clean[key] = { json, notes };
    }
    // Merge with existing so callers can PUT partial updates
    const existing = (await getLeaguePrompts()) || {};
    const merged = { ...existing, ...clean };

    await pgQuery(
      `INSERT INTO system_settings (key, value, description)
       VALUES ('brief_pipeline_league_prompts', $1, 'League-driven Brief Pipeline prompts (videoAnalysis / scriptAdaptation / scriptIteration)')
       ON CONFLICT (key) DO UPDATE SET value = $1, updated_at = NOW()`,
      [JSON.stringify(merged)]
    );
    leaguePromptsCache = { data: merged, timestamp: Date.now() };
    res.json({ success: true, prompts: merged });
  } catch (err) {
    res.status(500).json({ success: false, error: { message: err.message } });
  }
});

// POST /settings/league-prompts/reset — clear all 3 slots
router.post('/settings/league-prompts/reset', authenticate, async (_req, res) => {
  try {
    await pgQuery(`DELETE FROM system_settings WHERE key = 'brief_pipeline_league_prompts'`);
    leaguePromptsCache = { data: null, timestamp: 0 };
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ success: false, error: { message: err.message } });
  }
});

// ============================================================================
// ── Product Library bridge ──────────────────────────────────────────────────
//
// GET /product-context/:id — return everything the Brief Pipeline knows about
// a given product (raw profile + the formatted context string the generators
// inject as {{productContext}}). The frontend uses this to (a) confirm the
// selected product is wired up, (b) show a field count, and (c) optionally
// surface what fields will be available to the prompts at generation time.
// ============================================================================

router.get('/product-context/:id', authenticate, async (req, res) => {
  try {
    const idParam = req.params.id;
    let profile = null;

    // Allow numeric id OR product_code / short_name
    if (/^\d+$/.test(idParam)) {
      const rows = await pgQuery(`SELECT * FROM product_profiles WHERE id = $1 LIMIT 1`, [Number(idParam)]);
      profile = rows[0] || null;
      // Parse JSONB fields — postgres.js may return them as strings depending
      // on how they were written (JSON.stringify'd via param vs jsonb cast).
      if (profile) {
        for (const f of ['product_images', 'logos', 'fonts', 'brand_colors', 'benefits', 'angles', 'scripts', 'offers', 'formats', 'avatars']) {
          if (profile[f] && typeof profile[f] === 'string') try { profile[f] = JSON.parse(profile[f]); } catch {}
        }
      }
    } else {
      profile = await fetchProductProfile(idParam);
    }

    if (!profile) {
      return res.status(404).json({ success: false, error: { message: 'Product not found' } });
    }

    // Reuse the canonical context builder so what we show here is byte-for-byte
    // what the generators will receive.
    const context = buildProductContextForBrief(profile);
    const lineCount = context && context !== 'No product profile available.'
      ? context.split('\n').filter(Boolean).length
      : 0;

    // Trim/normalize the raw profile for the UI — drop heavy JSONB blobs that
    // would balloon the response and aren't useful for the panel display.
    const summary = {
      id: profile.id,
      name: profile.name,
      product_code: profile.product_code,
      short_name: profile.short_name,
      product_url: profile.product_url,
      price: profile.price,
      oneliner: profile.oneliner,
      tagline: profile.tagline,
      big_promise: profile.big_promise,
      mechanism: profile.mechanism,
      differentiator: profile.differentiator,
      customer_avatar: profile.customer_avatar,
      target_demographics: profile.target_demographics,
      pain_points: profile.pain_points,
      winning_angles: profile.winning_angles,
      discount_codes: profile.discount_codes,
      offer_details: profile.offer_details,
      guarantee: profile.guarantee,
      compliance_restrictions: profile.compliance_restrictions,
      // Full angles array — used by the Ad_Angle dropdown in Script Generator.
      // Each angle is { id, name, funnel_stage, hook_strategy, lead_with, ... }.
      angles: Array.isArray(profile.angles) ? profile.angles : [],
      anglesCount: Array.isArray(profile.angles) ? profile.angles.length : 0,
      scriptsCount: Array.isArray(profile.scripts) ? profile.scripts.length : 0,
      benefitsCount: Array.isArray(profile.benefits) ? profile.benefits.length : 0,
      updated_at: profile.updated_at,
    };

    res.json({
      success: true,
      product: summary,
      context,
      lineCount,
    });
  } catch (err) {
    console.error('[BriefPipeline] GET /product-context/:id error:', err.message);
    res.status(500).json({ success: false, error: { message: err.message } });
  }
});

// ============================================================================
// ── Reference Analysis (whole-video Gemini pass) ───────────────────────────
//
// One call to Gemini Flash with the full video bytes → a structured JSON
// breakdown matching the analysis page UI: visual setup, transcript-rooted
// narrative beats (Hook / Problem / Agitation / Solution Intro / Proof Points
// / CTA), why_it_works, psychological_triggers[], weaknesses[], how_to_beat_it.
//
// The product profile is injected so the analysis can comment on alignment
// + flag compliance risks for the downstream Brief Generation step.
// ============================================================================

const DEFAULT_REFERENCE_ANALYZER_PROMPT = `You are a senior direct-response strategist and ad analyst. You will watch a competitor video ad in full (visuals + audio + transcript) and return a single, valid JSON object that breaks down WHY the ad works, what it does badly, and how to beat it.

ANALYSIS DEPTH:
- Watch the entire video. Use both the visual frame-by-frame composition AND the spoken script.
- Be specific to THIS ad — never generic. Quote exact phrases from the transcript when relevant.
- The output JSON powers a UI; matching the schema exactly is required.

OUR PRODUCT — use this context to comment on alignment & compliance:
{{PRODUCT_CONTEXT}}

REFERENCE METADATA:
Source: {{REFERENCE_SOURCE}}
Brand: {{REFERENCE_BRAND}}
Tier: {{REFERENCE_TIER}}
Headline (if any): {{REFERENCE_HEADLINE}}

KNOWN TRANSCRIPT (Whisper, may have artifacts):
{{REFERENCE_TRANSCRIPT}}

Return ONLY a JSON object with this exact shape (no markdown, no backticks, no commentary):
{
  "visual": {
    "setting": "one-line description of the scene/backdrop (e.g. 'studio with plain white backdrop and wooden pedestals')",
    "speaker_count": 1,
    "speakers": [{ "role": "founder|spokesperson|customer|voiceover|actor", "voice": "male|female|mixed|other" }],
    "cuts_count": 9,
    "scene_type": "static talking head | UGC handheld | mashup | cartoon | screen recording | mixed",
    "captions": ["3-7 of the most prominent on-screen text overlays as they appear"],
    "color_palette": ["#hex", "#hex", "#hex", "#hex"],
    "production_notes": "1-2 sentences on production quality, lighting, pacing of cuts"
  },
  "narrative_breakdown": {
    "hook": {
      "quote": "exact opening line from the transcript",
      "analysis": "1-3 sentences: what the hook does, whether it creates curiosity/tension, scroll-stop mechanism"
    },
    "problem": {
      "framed": true,
      "analysis": "how the ad frames the problem — or explicitly say 'The ad does NOT frame a problem' and explain what it does instead"
    },
    "agitation": {
      "used": true,
      "analysis": "how the ad twists the knife / amplifies pain — or explicitly say 'Zero agitation' and explain"
    },
    "solution_intro": {
      "analysis": "how the product is introduced as the answer, with the quoted positioning line"
    },
    "proof_points": [
      { "quote": "exact phrase from transcript", "claim": "what is being claimed", "evidence_type": "demo|stat|testimonial|authority|comparison|blockchain|before-after|feature-list|other", "strength": "weak|medium|strong" }
    ],
    "cta": {
      "quote": "exact CTA text — or 'No verbal CTA in the transcript' if absent",
      "strength": "weak|medium|strong",
      "analysis": "what the CTA does and what it lacks (urgency, scarcity, risk reversal, offer specifics)"
    }
  },
  "why_it_works": "2-4 sentences on the core persuasion mechanism — authority transfer, identity reinforcement, origin halo, etc. Be specific to this ad. State whether this is cold-traffic or mid-funnel retention.",
  "psychological_triggers": [
    { "trigger": "Authority bias | Identity reinforcement | Social proof | Scarcity | Pattern interrupt | Origin halo | Loss aversion | Curiosity gap | etc.", "evidence": "exact transcript or visual evidence in 1-2 sentences", "strength": "weak|medium|strong" }
  ],
  "weaknesses": [
    { "label": "Zero hook tension | No external proof | Features without emotional payoff | Missed objection handling | Weak CTA | etc.", "explanation": "1-2 sentences explaining why this is a weakness for direct-response performance" }
  ],
  "how_to_beat_it": "A single paragraph (4-7 sentences) describing concretely how to rewrite this ad to outperform it. Use the imperative voice (START with..., THEN..., INJECT..., CONNECT..., CLOSE with...). Reference our product's mechanism / offer / guarantee when relevant. This becomes the brief for the downstream adapter.",
  "audience_alignment": {
    "this_ad_targets": "specific audience description inferred from the ad",
    "matches_our_audience": "yes | partial | no",
    "reason": "one sentence — does this resonate with our customer avatar"
  },
  "compliance_risks": [
    { "quote": "exact phrase from transcript that would violate our restrictions if cloned verbatim", "violates": "which compliance rule from the product profile", "rewrite_direction": "how the adapter should handle this" }
  ],
  "adaptation_confidence": "high | medium | low",
  "adaptation_confidence_reason": "one sentence on why this reference is or isn't a strong fit to clone for our product"
}

RULES:
- Output MUST be valid JSON only — no markdown, no backticks, no prose outside the JSON.
- Quote the transcript verbatim where the schema says "exact".
- Hex codes in color_palette MUST be 6-digit with leading #.
- If the transcript field is empty or unavailable, infer from the audio you hear in the video.
- Mark transcript artifacts ([unclear], [crosstalk]) verbatim — do not "clean up" the source.`;

// Strip code fences / leading prose around a JSON object so brittle model
// outputs still parse.
function extractJsonObject(text) {
  if (!text || typeof text !== 'string') return null;
  let s = text.trim();
  // Strip Markdown fences if present
  s = s.replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/i, '');
  // Find the first '{' and the matching final '}'
  const start = s.indexOf('{');
  const end = s.lastIndexOf('}');
  if (start === -1 || end === -1 || end <= start) return null;
  const slice = s.slice(start, end + 1);
  try { return JSON.parse(slice); } catch { return null; }
}

function renderTemplate(tpl, vars) {
  return tpl.replace(/\{\{\s*([A-Z_]+)\s*\}\}/g, (_, k) => {
    const v = vars[k];
    return v == null ? '' : String(v);
  });
}

// Fallback analyzer using OpenAI GPT-4o multimodal. Used when Gemini is
// unavailable (revoked key, quota-zero project, model deprecated, etc.).
//
// Limitation: GPT-4o doesn't accept raw video — we pass the thumbnail +
// the Whisper transcript. Script-based analysis (hooks, persuasion engine,
// triggers, weaknesses, how-to-beat) is equally good; the visual section
// is limited to what one frame reveals (palette, scene_type, on-screen
// captions, single-frame composition). The UI surfaces the provider so
// the operator knows what visual depth they got.
async function analyzeWithOpenAIVision(thumbnailUrl, transcript, promptText) {
  const OPENAI_KEY = process.env.OPENAI_API_KEY;
  if (!OPENAI_KEY) throw new Error('OPENAI_API_KEY not configured');

  // Adapt the prompt: tell the model it has 1 frame + transcript (not whole video).
  const adaptedPrompt = `${promptText}

NOTE FOR THIS RUN: You do NOT have access to the full video. You have:
  - ONE thumbnail frame (attached)
  - The full Whisper transcript (already embedded above)

Fill the visual.* fields based on what one frame reveals (scene_type,
captions visible in this frame, palette, setting). Set visual.cuts_count
to null since you cannot count cuts from a single frame. Speaker count
should be the number of distinct on-screen speakers in this frame, with
the caveat that voiceover speakers may not appear. Fill every other field
fully from the transcript as if it were a full-video analysis.`;

  const content = [
    { type: 'text', text: adaptedPrompt },
  ];

  // Meta's fbcdn URLs reject OpenAI's image fetcher (they expire / require
  // request-specific auth tokens). Download the thumbnail server-side and
  // pass it as a base64 data URL so OpenAI never has to hit the CDN.
  let thumbnailMode = 'none';
  if (thumbnailUrl) {
    try {
      const imgRes = await fetch(thumbnailUrl, {
        headers: { 'User-Agent': 'Mozilla/5.0 (compatible; MineblockBot/1.0)' },
        redirect: 'follow',
        signal: AbortSignal.timeout(20_000),
      });
      if (imgRes.ok) {
        const buf = Buffer.from(await imgRes.arrayBuffer());
        const ct = (imgRes.headers.get('content-type') || 'image/jpeg').split(';')[0];
        const dataUrl = `data:${ct};base64,${buf.toString('base64')}`;
        content.push({ type: 'image_url', image_url: { url: dataUrl, detail: 'high' } });
        thumbnailMode = 'inline-base64';
      } else {
        thumbnailMode = `download-failed-${imgRes.status}`;
      }
    } catch (e) {
      thumbnailMode = `download-error: ${e.message?.slice(0, 80)}`;
    }
  }

  console.log(`[BriefPipeline:analyze] OpenAI fallback — thumbnail=${thumbnailMode}, transcript=${transcript?.length || 0} chars`);

  const res = await fetch('https://api.openai.com/v1/chat/completions', {
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${OPENAI_KEY}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      model: 'gpt-4o',
      messages: [{ role: 'user', content }],
      max_tokens: 4096,
      temperature: 0.3,
      response_format: { type: 'json_object' },
    }),
    signal: AbortSignal.timeout(180_000),
  });

  if (!res.ok) {
    const txt = await res.text();
    throw new Error(`OpenAI fallback failed: HTTP ${res.status} — ${txt.slice(0, 300)}`);
  }
  const data = await res.json();
  const text = data.choices?.[0]?.message?.content || '';
  if (!text) throw new Error('OpenAI fallback returned empty response');
  const json = extractJsonObject(text);
  if (!json) throw new Error('OpenAI fallback response not JSON-parseable');
  return { json, model: data.model || 'gpt-4o' };
}

// Run Gemini against the whole video with a JSON-output prompt.
// Returns { json, model } on success — throws on hard failure.
async function analyzeWholeVideoWithGemini(mediaUrl, promptText) {
  if (!GEMINI_API_KEY) throw new Error('GEMINI_API_KEY not configured');

  console.log(`[BriefPipeline:analyze] downloading video: ${mediaUrl.slice(0, 80)}...`);
  const mediaRes = await fetch(mediaUrl, {
    headers: { 'User-Agent': 'Mozilla/5.0 (compatible; MineblockBot/1.0)' },
    redirect: 'follow',
    signal: AbortSignal.timeout(60_000),
  });
  if (!mediaRes.ok) throw new Error(`Failed to download video: HTTP ${mediaRes.status}`);

  const buffer = Buffer.from(await mediaRes.arrayBuffer());
  const contentType = mediaRes.headers.get('content-type') || 'video/mp4';
  const sizeMB = buffer.length / 1024 / 1024;
  console.log(`[BriefPipeline:analyze] downloaded ${sizeMB.toFixed(1)}MB (${contentType})`);

  const mime = contentType.split(';')[0];
  // 2.0-flash supports video; 1.5-flash is deprecated and returns 404 on most
  // keys now (see transcription path) so we skip it here.
  const models = ['gemini-2.0-flash-001', 'gemini-2.5-flash', 'gemini-2.0-flash'];

  let requestBody;
  if (sizeMB > 15) {
    const fileUri = await uploadToGeminiFileApi(buffer, mime);
    if (!fileUri) throw new Error('Gemini File API upload failed');
    requestBody = {
      contents: [{ parts: [
        { fileData: { mimeType: mime, fileUri } },
        { text: promptText },
      ]}],
      generationConfig: {
        maxOutputTokens: 8192,
        temperature: 0.3,
      },
    };
  } else {
    requestBody = {
      contents: [{ parts: [
        { inlineData: { mimeType: mime, data: buffer.toString('base64') } },
        { text: promptText },
      ]}],
      generationConfig: {
        maxOutputTokens: 8192,
        temperature: 0.3,
      },
    };
  }

  // Same retry pattern as transcription — try every key/model.
  let lastError = null;
  for (const apiKey of (GEMINI_API_KEYS.length ? GEMINI_API_KEYS : [GEMINI_API_KEY])) {
    if (!apiKey) continue;
    for (const model of models) {
      try {
        const keyLabel = `key:${apiKey.slice(-4)}`;
        console.log(`[BriefPipeline:analyze] trying Gemini ${model} (${keyLabel})`);
        const res = await fetch(
          `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${apiKey}`,
          {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(requestBody),
            signal: AbortSignal.timeout(180_000),
          }
        );
        if (res.status === 429) { lastError = `${model}: 429`; continue; }
        if (res.status === 404) { lastError = `${model}: 404`; break; }
        if (!res.ok) {
          const txt = await res.text();
          lastError = `${model}: HTTP ${res.status} — ${txt.slice(0, 400)}`;
          console.warn(`[BriefPipeline:analyze] ${model} failed: ${lastError}`);
          continue;
        }
        const data = await res.json();
        const text = data.candidates?.[0]?.content?.parts?.[0]?.text || '';
        if (!text) { lastError = `${model}: empty response`; continue; }
        const json = extractJsonObject(text);
        if (!json) { lastError = `${model}: response not JSON-parseable`; continue; }
        console.log(`[BriefPipeline:analyze] success via ${model} (${keyLabel})`);
        return { json, model };
      } catch (err) {
        lastError = `${model}: ${err.message}`;
        console.warn(`[BriefPipeline:analyze] ${model} error:`, err.message);
      }
    }
  }
  throw new Error(`Gemini analysis failed: ${lastError || 'unknown'}`);
}

// Build the prompt for a specific reference + product profile.
// `productCode` should be the product the brief context is targeting —
// defaults to 'MR' (MinerForge Pro) when callers don't pass one, but
// callers SHOULD pass it so non-MR products don't get analyzed through
// the MinerForge compliance lens.
async function buildReferenceAnalyzerPrompt(reference, productCode = 'MR') {
  // Allow operator override via League Prompts (key=scriptAnalysis).
  const saved = await getLeaguePrompts();
  let template = DEFAULT_REFERENCE_ANALYZER_PROMPT;
  try {
    const customRaw = saved?.scriptAnalysis?.json;
    if (customRaw && customRaw.trim()) {
      const obj = JSON.parse(customRaw);
      // Accept either { user } string (preferred), or { system, user } shape
      if (typeof obj?.user === 'string' && obj.user.trim()) template = obj.user;
      else if (typeof obj?.prompt === 'string' && obj.prompt.trim()) template = obj.prompt;
    }
  } catch { /* keep default */ }

  // Resolve product profile via the reference's brand (if matched in our
  // product library) — for Brief Pipeline + League the user picks the product
  // explicitly at generation time, so we pass an empty-ish profile here and
  // let the analyzer comment on alignment generically.
  const profile = await fetchProductProfile(productCode || 'MR');
  const productContext = buildProductContextForBrief(profile);

  const vars = {
    PRODUCT_CONTEXT:      productContext,
    REFERENCE_SOURCE:     'league',
    REFERENCE_BRAND:      reference.brandName || reference.brand_name || '',
    REFERENCE_TIER:       reference.tier || '',
    REFERENCE_HEADLINE:   reference.headline || '',
    REFERENCE_TRANSCRIPT: reference.transcript || '(no transcript on file — infer from the audio in the video)',
  };
  return renderTemplate(template, vars);
}

// GET /references/:id — full reference row + cached analysis
router.get('/references/:id', authenticate, async (req, res) => {
  if (!validateUuid(req, res)) return;
  try {
    const rows = await pgQuery(
      `SELECT * FROM brief_pipeline_references WHERE id = $1`,
      [req.params.id]
    );
    if (!rows.length) {
      return res.status(404).json({ success: false, error: { message: 'Reference not found' } });
    }
    res.json({ success: true, reference: mapReferenceRowWithAnalysis(rows[0]) });
  } catch (err) {
    console.error('[BriefPipeline] GET /references/:id error:', err.message);
    res.status(500).json({ success: false, error: { message: err.message } });
  }
});

// POST /references/:id/analyze — run / re-run the Gemini whole-video analyzer.
// Cached after first run; pass ?force=1 to bypass the cache. Optionally accepts
// ?productCode=XX or ?productId=N so the analyzer's compliance commentary is
// scoped to the right product instead of defaulting to MinerForge.
router.post('/references/:id/analyze', authenticate, async (req, res) => {
  if (!validateUuid(req, res)) return;
  try {
    const force = String(req.query.force || '') === '1';
    // Resolve product code from query (?productCode=XX or ?productId=N) for
    // the analyzer's product-aware compliance pass. Falls back to 'MR'.
    let analyzerProductCode = req.query.productCode ? String(req.query.productCode) : null;
    if (!analyzerProductCode && req.query.productId && /^\d+$/.test(String(req.query.productId))) {
      const pp = await pgQuery(`SELECT product_code, short_name FROM product_profiles WHERE id = $1 LIMIT 1`, [Number(req.query.productId)]).catch(() => []);
      analyzerProductCode = pp[0]?.product_code || pp[0]?.short_name || null;
    }
    const rows = await pgQuery(
      `SELECT * FROM brief_pipeline_references WHERE id = $1`,
      [req.params.id]
    );
    if (!rows.length) {
      return res.status(404).json({ success: false, error: { message: 'Reference not found' } });
    }
    const ref = rows[0];

    // Cache hit
    if (!force && ref.analysis) {
      return res.json({
        success: true,
        cached: true,
        analysis: ref.analysis,
        analyzedAt: ref.analyzed_at ? new Date(ref.analyzed_at).toISOString() : null,
        analysisModel: ref.analysis_model || null,
      });
    }

    if (!ref.video_url) {
      return res.status(400).json({
        success: false,
        error: { message: 'This reference has no video URL — cannot analyze.' },
      });
    }

    const refForPrompt = mapReferenceRow(ref);
    const promptText = await buildReferenceAnalyzerPrompt(refForPrompt, analyzerProductCode);

    // Primary: Gemini whole-video. Fallback: OpenAI thumbnail+transcript.
    let result = null;
    let provider = null;
    let geminiError = null;
    try {
      result = await analyzeWholeVideoWithGemini(ref.video_url, promptText);
      provider = 'gemini';
    } catch (err) {
      geminiError = err.message;
      console.warn(`[BriefPipeline:analyze] Gemini failed, trying OpenAI fallback: ${err.message}`);
      try {
        result = await analyzeWithOpenAIVision(
          ref.thumbnail_url || null,
          ref.transcript || '',
          promptText,
        );
        provider = 'openai-fallback';
      } catch (fallbackErr) {
        const combined = `Gemini: ${geminiError} || OpenAI fallback: ${fallbackErr.message}`;
        await pgQuery(
          `UPDATE brief_pipeline_references SET analysis_error = $1, updated_at = NOW() WHERE id = $2`,
          [combined.slice(0, 1000), req.params.id]
        );
        throw new Error(combined);
      }
    }

    // Annotate which provider produced this analysis so the UI can show the
    // depth/limitation accurately. Stored inline in the JSONB so it survives
    // GETs without a schema migration.
    const annotated = { ...result.json, _provider: provider, _model: result.model };

    await pgQuery(
      `UPDATE brief_pipeline_references
          SET analysis = $1,
              analyzed_at = NOW(),
              analysis_model = $2,
              analysis_error = NULL,
              updated_at = NOW()
        WHERE id = $3`,
      [JSON.stringify(annotated), result.model, req.params.id]
    );

    res.json({
      success: true,
      cached: false,
      analysis: annotated,
      analyzedAt: new Date().toISOString(),
      analysisModel: result.model,
      provider,
    });
  } catch (err) {
    console.error('[BriefPipeline] POST /references/:id/analyze error:', err.message);
    res.status(500).json({ success: false, error: { message: err.message } });
  }
});

function mapReferenceRowWithAnalysis(r) {
  const base = mapReferenceRow(r);
  // postgres.js returns JSONB as a string scalar when the column was written
  // via INSERT ... VALUES($1) with a JSON.stringify'd argument. Parse here so
  // the frontend gets a real object.
  let analysis = r.analysis;
  if (typeof analysis === 'string') {
    try { analysis = JSON.parse(analysis); } catch { /* leave as-is */ }
  }
  return {
    ...base,
    analysis:      analysis || null,
    analyzedAt:    r.analyzed_at ? new Date(r.analyzed_at).toISOString() : null,
    analysisModel: r.analysis_model || null,
    analysisError: r.analysis_error || null,
  };
}

function mapReferenceRow(r) {
  if (!r) return null;
  // postgres.js returns JSONB as a string when written via JSON.stringify'd
  // params (see also mapReferenceRowWithAnalysis for the analysis field).
  let importedMetadata = r.imported_metadata;
  if (typeof importedMetadata === 'string') {
    try { importedMetadata = JSON.parse(importedMetadata); } catch { importedMetadata = null; }
  }
  return {
    id: r.id,
    brandSpyAdId: r.brand_spy_ad_id,
    adArchiveId: r.ad_archive_id,
    brandId: r.brand_id,
    brandName: r.brand_name,
    tier: r.tier,
    source: r.source || 'league',
    importedMetadata: importedMetadata || null,
    videoUrl: r.video_url || null,
    thumbnailUrl: r.thumbnail_url || null,
    headline: r.headline || null,
    bodyText: r.body_text || null,
    transcript: r.transcript || null,
    transcriptAt: r.transcript_at ? new Date(r.transcript_at).toISOString() : null,
    status: r.status,
    generatedBriefId: r.generated_brief_id || null,
    analysisError: r.analysis_error || null,
    isQuarantined: r.is_quarantined === true,
    quarantineReason: r.quarantine_reason || null,
    quarantinedAt: r.quarantined_at ? new Date(r.quarantined_at).toISOString() : null,
    createdAt: r.created_at ? new Date(r.created_at).toISOString() : null,
    updatedAt: r.updated_at ? new Date(r.updated_at).toISOString() : null,
    // Source URL of the original ad. Powers the auto-filled Reference link
    // on every ClickUp push.
    sourceUrl: r.source_url || null,
  };
}

// ═══════════════════════════════════════════════════════════════════════
// BATCH QUEUE WORKER — pattern-matched to startMediaMirrorWorker
// (services/brandSpyMediaMirror.js): setInterval + in-process guard, every
// tick and every job is wrapped so a failure never kills the process or
// stops the queue.
// ═══════════════════════════════════════════════════════════════════════

const BRIEF_QUEUE_TICK_MS = 8_000;
const BRIEF_QUEUE_CONCURRENCY = 2;
const runningQueueJobs = new Set(); // in-process guard: job ids currently executing
let briefQueueWorkerStarted = false;

// Stuck-job recovery. A dead process leaves rows in transcribing/generating
// with no executor — but "no executor on THIS instance" is not proof of
// death: Render drains the previous instance for a grace period after a
// deploy, and its in-flight jobs usually FINISH during the drain. Recovering
// them immediately produced a duplicate brief (2026-07-14: old instance
// completed brief 0d7f2a42 while the new one re-ran the same job into
// 2e7cd272). So recovery only touches jobs whose started_at is older than
// STUCK_AFTER_MIN — long past any generation (~3 min) or drain window —
// and runs every tick, so truly dead jobs recover without waiting for the
// next boot. In-process jobs are protected by the runningQueueJobs guard.
const STUCK_AFTER_MIN = 12;
async function recoverStuckQueueJobs() {
  await ensureJobsTable();
  const running = [...runningQueueJobs];
  const requeued = await pgQuery(`
    UPDATE brief_generation_jobs
       SET status = 'queued', attempts = attempts + 1
     WHERE status IN ('transcribing', 'generating')
       AND started_at < NOW() - INTERVAL '${STUCK_AFTER_MIN} minutes'
       AND NOT (id = ANY($1::uuid[]))
     RETURNING id
  `, [running]);
  if (requeued.length) {
    console.log(`[BriefQueue] recovery: re-queued ${requeued.length} stuck job(s) (stale > ${STUCK_AFTER_MIN}m)`);
  }
  const failed = await pgQuery(`
    UPDATE brief_generation_jobs
       SET status = 'failed', error = 'max retries after restarts', finished_at = NOW()
     WHERE status = 'queued' AND attempts > 2
     RETURNING id
  `);
  if (failed.length) {
    console.log(`[BriefQueue] recovery: failed ${failed.length} job(s) past max restart retries`);
  }
}

// One job, all four stages. Errors are stage-prefixed ('transcribe: …',
// 'import: …', 'generate: …') and land on the job row — never thrown past
// the caller's guard, never allowed to block other jobs.
async function processBriefQueueJob(job) {
  try {
    // ── Stage 1: transcribe (job row is already status='transcribing') ──
    let ad;
    let transcript;
    try {
      ad = await getAdDetail(job.brand_spy_ad_id);
      if (!ad) throw new Error(`brand_spy ad ${job.brand_spy_ad_id} not found`);
      transcript = ad.transcript || null;
      if (!transcript) {
        // Prefetch (modal checkbox) usually got here first — this path only
        // pays Whisper when the cache is cold.
        if (!ad.videoUrl) throw new Error('ad has no video URL to transcribe');
        let transcription;
        try {
          transcription = await transcribeVideoUrl(ad.videoUrl);
        } catch (err) {
          // Stored fbcdn URL expired — pull a fresh one from the FB Ad
          // Library via yt-dlp and retry once (same chain as brandSpy.js
          // POST /ads/:id/transcribe).
          const archiveId = job.ad_archive_id || ad.adArchiveId;
          const fresh = archiveId
            ? await extractFreshVideoUrl(adLibraryUrl(archiveId)).catch(() => null)
            : null;
          if (!fresh) throw err;
          console.log(`[BriefQueue] job ${job.id}: stored URL dead (${err.message}) — retrying with fresh yt-dlp URL`);
          transcription = await transcribeVideoUrl(fresh);
        }
        // Persist to brand_spy.ads so the next consumer (and the prefetch
        // cache) sees it — same UPDATE shape as brandSpy.js /transcribe.
        await pgQuery(
          `UPDATE brand_spy.ads
              SET transcript = $1, transcript_segments = $2, transcript_at = NOW()
            WHERE id = $3`,
          [transcription.text, JSON.stringify(transcription.segments || []), job.brand_spy_ad_id]
        );
        transcript = transcription.text;
      }
      if (!transcript || transcript.trim().length < 20) {
        throw new Error('transcript too short (<20 chars) — nothing to generate from');
      }
    } catch (e) {
      throw new Error(`transcribe: ${e.message}`);
    }

    // ── Stage 2: import reference (shared upsert with POST /references) ──
    let reference;
    try {
      ({ reference } = await importLeagueAdAsReference({
        brandSpyAdId: job.brand_spy_ad_id,
        adArchiveId: job.ad_archive_id || ad.adArchiveId,
        brandId: job.brand_id || ad.brandId,
        brandName: job.brand_name || ad.pageName || 'Unknown',
        tier: job.tier || ad.tier || 'A',
        videoUrl: ad.videoUrl || null,
        thumbnailUrl: ad.thumbnailUrl || null,
        headline: job.headline || ad.headline || null,
        bodyText: ad.bodyText || null,
        transcript,
        transcriptAt: ad.transcriptAt || new Date().toISOString(),
      }));
      await pgQuery(
        `UPDATE brief_generation_jobs SET reference_id = $1 WHERE id = $2`,
        [reference.id, job.id]
      );
    } catch (e) {
      throw new Error(`import: ${e.message}`);
    }

    // ── Stage 3: generate (same flow as POST /generate-from-script) ──
    let briefIds;
    try {
      await pgQuery(
        `UPDATE brief_generation_jobs SET status = 'generating' WHERE id = $1`,
        [job.id]
      );
      const creativeId = `MANUAL-${Date.now().toString(36).toUpperCase()}`;
      const insertedWinner = await pgQuery(`
        INSERT INTO brief_pipeline_winners (
          creative_id, ad_name, product_code, angle, format, raw_script,
          status, spend, roas, cpa, ctr, purchases, winner_reason, reference_id
        ) VALUES ($1, $2, $3, $4, $5, $6, 'generating', 0, 0, 0, 0, 0, 'manual', $7)
        RETURNING *
      `, [
        creativeId,
        `Manual script — ${transcript.slice(0, 50)}...`,
        job.product_code || 'MR',
        job.angle || 'NA',
        'Mashup',
        transcript,
        reference.id,
      ]);
      const winner = insertedWinner[0];
      try {
        ({ briefIds } = await executeGenerationJob({
          rawScript: transcript,
          referenceId: reference.id,
          productId: job.product_id,
          productCode: job.product_code,
          angle: job.angle, // null = AUTO (clone prompt resolves from product angles)
          mode: 'clone',
          numVariations: 1,
          vectorsSelected: undefined,
          model: job.model || 'claude',
          winner,
          creativeId,
        }));
      } catch (genErr) {
        // Same reset the route's fire-and-forget catch performs, so the
        // virtual winner row never wedges in 'generating'.
        await pgQuery(
          `UPDATE brief_pipeline_winners SET status = 'detected' WHERE id = $1`,
          [winner.id]
        ).catch(() => {});
        throw genErr;
      }
    } catch (e) {
      throw new Error(`generate: ${e.message}`);
    }

    // ── Stage 4: complete ──
    await pgQuery(
      `UPDATE brief_generation_jobs
          SET status = 'complete', brief_id = $1, error = NULL, finished_at = NOW()
        WHERE id = $2`,
      [briefIds?.[0] || null, job.id]
    );
    console.log(`[BriefQueue] job ${job.id} complete — brief ${briefIds?.[0] || 'n/a'}`);
  } catch (err) {
    console.error(`[BriefQueue] job ${job.id} failed:`, err.message);
    await pgQuery(
      `UPDATE brief_generation_jobs
          SET status = 'failed', error = $1, finished_at = NOW()
        WHERE id = $2`,
      [String(err.message || err).slice(0, 2000), job.id]
    ).catch((e2) => console.error(`[BriefQueue] could not mark job ${job.id} failed:`, e2.message));
  }
}

async function briefQueueTick() {
  if (runningQueueJobs.size >= BRIEF_QUEUE_CONCURRENCY) return;
  await ensureJobsTable();
  const slots = BRIEF_QUEUE_CONCURRENCY - runningQueueJobs.size;
  const candidates = await pgQuery(
    `SELECT id FROM brief_generation_jobs
      WHERE status = 'queued'
      ORDER BY created_at ASC
      LIMIT $1`,
    [slots]
  );
  for (const row of candidates) {
    if (runningQueueJobs.has(row.id)) continue;
    // Atomic claim — the status guard means a concurrent cancel (or a second
    // instance) can never double-run a job.
    const claimed = await pgQuery(
      `UPDATE brief_generation_jobs
          SET status = 'transcribing', started_at = NOW(), error = NULL
        WHERE id = $1 AND status = 'queued'
        RETURNING *`,
      [row.id]
    );
    if (!claimed.length) continue;
    const job = claimed[0];
    runningQueueJobs.add(job.id);
    console.log(`[BriefQueue] job ${job.id} started (${job.headline || job.ad_archive_id || job.brand_spy_ad_id})`);
    processBriefQueueJob(job)
      .catch((e) => console.error(`[BriefQueue] job ${job.id} unexpected error:`, e.message))
      .finally(() => runningQueueJobs.delete(job.id));
  }
}

function startBriefQueueWorker() {
  if (briefQueueWorkerStarted) return;
  briefQueueWorkerStarted = true;
  console.log(`[BriefQueue] queue worker scheduled (tick ${BRIEF_QUEUE_TICK_MS / 1000}s, concurrency ${BRIEF_QUEUE_CONCURRENCY})`);
  // Boot recovery first, then steady ticks. Short settle delay so the DB
  // pool is up; every layer is guarded so a crash never kills the process.
  setTimeout(() => {
    recoverStuckQueueJobs()
      .catch((e) => console.error('[BriefQueue] boot recovery error:', e.message))
      .finally(() => {
        let lastRecovery = 0;
        setInterval(() => {
          briefQueueTick().catch((e) => console.error('[BriefQueue] tick error:', e.message));
          // Steady-state recovery sweep (~60s cadence): truly dead jobs
          // (crash without a clean boot afterwards) recover here instead of
          // waiting for the next restart. The 12-min staleness guard inside
          // recoverStuckQueueJobs keeps draining-instance jobs untouched.
          const now = Date.now();
          if (now - lastRecovery > 60_000) {
            lastRecovery = now;
            recoverStuckQueueJobs().catch((e) => console.error('[BriefQueue] recovery sweep error:', e.message));
          }
        }, BRIEF_QUEUE_TICK_MS);
      });
  }, 10_000);
}

// Start at module load (same placement as brandSpy.js's worker start),
// wrapped so a worker startup crash can never take the server down.
try {
  startBriefQueueWorker();
} catch (err) {
  console.error('[BriefQueue] worker failed to start:', err.message);
}

export default router;
