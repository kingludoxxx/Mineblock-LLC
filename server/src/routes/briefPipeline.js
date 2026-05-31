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

router.use(authenticate, requirePermission('brief-pipeline', 'access'));

// ── Config ────────────────────────────────────────────────────────────
const CLICKUP_TOKEN = process.env.CLICKUP_API_TOKEN || '';
const VIDEO_ADS_LIST = '901518716584';
const MEDIA_BUYING_LIST = '901518769621';
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
};

const AVATAR_TASK_IDS = {
  Cryptoaddict: '86c7hf58v',
  MoneySeeker: '86c7m5417',
  'Test Avatar': '86c75fyjh',
  Aware: '86c8jhvfk',
  NA: null,
};

const CREATOR_NA_TASK_ID = '86c7n9cvr';

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
async function callClaude(systemPrompt, userPrompt, maxTokens = 3000, { fast = false, rawText = false } = {}) {
  const messages = [
    { role: 'user', content: userPrompt },
  ];

  const body = {
    model: fast ? 'claude-haiku-4-5-20251001' : CLAUDE_MODEL,
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
  });

  if (!res.ok) {
    const errText = await res.text();
    throw new Error(`Claude API error ${res.status}: ${errText}`);
  }

  const data = await res.json();
  const text = data.content?.[0]?.text || '';

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
async function getNextBriefNumber() {
  let maxBrief = 0;
  let page = 0;
  let hasMore = true;

  while (hasMore) {
    const data = await clickupFetch(
      `/list/${VIDEO_ADS_LIST}/task?page=${page}&limit=100&include_closed=true&subtasks=true`
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

  return maxBrief + 1;
}

/**
 * Build the naming convention string.
 */
// Map angle names to short codes for naming conventions
const ANGLE_ABBREV = {
  'pain point': 'PP', 'social proof': 'SP', 'before/after': 'BA',
  'curiosity hook': 'CH', 'direct offer': 'DO', 'authority': 'AU',
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
  // Brief type — NN (Net New) for clones of competitor ads, IT (Iteration)
  // for refreshes of our own proven winners. Default IT for back-compat
  // with callers that don't pass it explicitly. Anything else (operator
  // override, junk) → IT.
  const briefType = brief_type === 'NN' ? 'NN' : 'IT';
  // The parent slot exists so iterations of a real winner carry the parent's
  // B-code (e.g. "B0223") in the task name. For briefs generated from a
  // raw script paste or a reference card the parent_creative_id is a
  // synthetic "MANUAL-XXXXXXXX" — noise in the task name. Drop the slot
  // entirely in that case rather than emitting MANUAL-XXXX strings.
  // Also drop the slot entirely for NN briefs — net-new clones have no
  // meaningful parent, the slot should not appear at all.
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
    editor || 'Uly',
    week || getCurrentWeekLabel(),
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
  return lines.join('\n');
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
- If hooks aren't explicitly labeled, the first 1-3 sentences before the body are hooks
- The body is everything after the hooks until the CTA
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
const DEFAULT_CLONE_PROMPT_SYSTEM = `You are a senior performance copywriter who clones winning ad scripts surgically. Your job is to preserve the persuasion architecture of a proven competitor script while swapping their product for ours. You think in terms of ARCHITECTURE (sequence, pacing, rhetorical devices, emotional beats) — not surface words. Every paragraph in the original maps to an equivalent paragraph in your clone. You write like a real media buyer who has spent millions: raw, direct, no marketing-speak, no AI tells, no filler. Contractions, fragments, real talk. If the original sounds like someone ranting on TikTok, your clone rants on TikTok. If it sounds like a calm authority, your clone is a calm authority. You NEVER soften, hedge, or add disclaimers the original didn't have. You NEVER invent claims unsupported by the product profile. You NEVER break the angle once it is selected — every sentence reinforces it.`;

const DEFAULT_CLONE_PROMPT_USER = `# MISSION
Clone the competitor script below for OUR product, preserving its narrative architecture exactly.

# OUR PRODUCT (Product Library — use this as the single source of truth)
{{PRODUCT_CONTEXT}}

# AVAILABLE ANGLES FOR OUR PRODUCT
{{ANGLES_LIST}}

# SELECTED ANGLE
angle_name: {{ANGLE_NAME}}
angle_details:
{{ANGLE_DETAILS}}

# IF angle_name = "AUTO"
Pick the single angle from the AVAILABLE ANGLES list that best fits the original script's emotional register and proof structure. State your pick + one-sentence reason in angle_used. Then write the clone using that angle's tone, lead_with concept, copy_directives, and required_elements as guidance.

# IF angle_name is a specific angle
Lock to it. Every hook must voice the angle. The body must weave it through every paragraph. Use the angle's tone, lead_with concept, and copy_directives. Avoid every banned_phrase. Steal headline_examples for inspiration only — never copy verbatim.

# ORIGINAL COMPETITOR SCRIPT (clone this)
hooks: {{ORIGINAL_HOOKS}}
body: {{ORIGINAL_BODY}}
cta: {{ORIGINAL_CTA}}

# ORIGINAL ON-SCREEN TEXT  (burned-in overlays from the source video — if any)
{{ORIGINAL_ON_SCREEN_TEXT}}

# DEEP ANALYSIS OF THE ORIGINAL
{{ANALYSIS_CONTEXT}}

# CLONE RULES (non-negotiable)

## 1. ARCHITECTURE PRESERVATION
- Same number of body paragraphs / sections as original
- Same rhetorical device at each structural position (apology, confession, contrarian claim, stat-drop, callout, etc.)
- Same emotional escalation curve (e.g., calm → tension → reveal → relief → CTA)
- Same pacing — short punchy sentences where original is punchy, flowing where original flows
- Body word count must EQUAL the original OR be up to 10% SHORTER. NEVER longer than the original.

## 2. PRODUCT SWAP (use Product Library only)
- Every competitor product mention → swap to our product name from {{PRODUCT_CONTEXT}}
- Every competitor benefit → find the equivalent in our benefits / big_promise / mechanism
- Every competitor proof → swap to our proof points / differentiator / customer testimonials
- Every competitor offer / price → swap to our offer_details / discount_codes / guarantee
- If no equivalent exists in our library, use the closest field that serves the same persuasive purpose
- NEVER leave any competitor name, feature, or claim in the final script
- NEVER invent claims not supported by our Product Library
- Respect compliance_restrictions from the Product Library — flag any borderline claims in compliance_notes

## 3. ANGLE INFUSION
- The selected angle is the lens through which the entire script reads
- Open with the angle's lead_with concept (rephrased to match the original's opening rhythm)
- The 5 hooks must each be a variation of the angle's hook_strategy applied to our product
- Tone must match the angle's tone field
- Treat the angle's required_elements as GUIDANCE, not a mandatory checklist. Hit as many as fit naturally in the original's structure. If a required element doesn't fit a short clone, skip it — don't shoehorn. Track what fit vs what didn't in the output.
- Use the angle's copy_directives as a checklist — every directive must be visible in the output
- NEVER use any phrase in the angle's banned_phrases list (this is a HARD ban)
- If headline_examples exist, use them as energy reference only — paraphrase, do not copy

## 4. VOICE LOCK (anti-AI)
- Contractions: don't, can't, won't, it's, that's, here's — always
- Sentence fragments where the original uses them
- Speak to ONE person, never "audiences"
- BANNED openers: "Imagine", "Picture this", "In a world where", "What if I told you", "Did you know"
- BANNED transitions: "But here's the thing", "Now here's where it gets interesting", "And that's not all", "Let me explain"
- BANNED softeners: "may", "might", "could potentially", "helps you to" (unless original used them)
- Use natural verbal tics that match the original's register: "Look," / "Listen," / "Honestly," / "The truth is," / "Here's the deal"

## 5. HOOK CLONING
- Generate exactly 5 hooks
- All 5 must share the original's hook framework AND the selected angle's hook_strategy
- H1 = closest energy match to the original's strongest hook + angle infusion
- H2 = same framework, different entry angle
- H3 = same framework, different emotional texture
- H4 = same framework, contrarian / inverted version (test against H1)
- H5 = same framework, shortest punch version (under 8 words)
- Each hook must read seamlessly into the body's first paragraph
- A hook is a FULL FIRST-PERSON SENTENCE the speaker would actually say. ALL-CAPS sticker fragments (≤6 words with emoji) are NEVER hooks — they're highlighted_text. See rule §7.

## 6. CTA CLONING
- Match the original's CTA structure (urgency / curiosity / direct / soft)
- Insert our offer_details, discount_codes, or guarantee — whichever the original used
- If original CTA had a deadline, ours has a deadline (use any active promo from offer_details)
- If original was "verify yourself" style and we have the blockchain mechanism, lean into verification

## 7. ON-SCREEN TEXT / HIGHLIGHTED LABELS  (CONDITIONAL — driven by ORIGINAL ON-SCREEN TEXT block above)
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

# OUTPUT — return ONLY valid JSON, no markdown fences, no preamble:

{
  "hooks": [
    { "id": "H1", "text": "...", "framework_used": "matches original", "angle_signal": "how this hook voices the selected angle", "maps_to_original": "which original hook this clones" },
    { "id": "H2", "text": "...", "framework_used": "...", "angle_signal": "...", "maps_to_original": "..." },
    { "id": "H3", "text": "...", "framework_used": "...", "angle_signal": "...", "maps_to_original": "..." },
    { "id": "H4", "text": "...", "framework_used": "...", "angle_signal": "...", "maps_to_original": "..." },
    { "id": "H5", "text": "...", "framework_used": "...", "angle_signal": "...", "maps_to_original": "..." }
  ],
  "body": "the full cloned body with natural paragraph breaks — same paragraph count as original, equal or up to 10% shorter",
  "cta": "the cloned CTA",
  "highlighted_text": [
    "ON-SCREEN LABEL 1 + emoji",
    "ON-SCREEN LABEL 2 + emoji"
  ],
  "highlighted_text_notes": "1 sentence — what evidence in the source signalled overlays, OR explicitly 'No on-screen overlays detected in source — emitting empty array'.",
  "angle_used": { "name": "the angle name actually used", "reason": "one sentence — why this angle (only if AUTO was selected)", "required_elements_used": ["list of required_elements that fit naturally"], "required_elements_skipped": ["list of skipped + one-line reason for each"], "copy_directives_followed": ["list of directives visible in output"] },
  "clone_fidelity": { "original_word_count": 0, "clone_word_count": 0, "original_sections": 0, "clone_sections": 0, "framework_match": "what structural elements were preserved", "product_swaps_made": "summary of competitor → our product replacements" },
  "key_changes_from_original": "2-3 sentence summary of what's different and why",
  "emotional_arc": "hook_emotion → middle_emotion → close_emotion (must match original's arc)",
  "compliance_notes": "any claims that brush against compliance_restrictions, or 'clean' if none"
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
  const bodyFirstLine = body.split('\n').find(l => l.trim().length > 10) || body.slice(0, 200);

  let system = `You are a continuity editor for direct response ad scripts. Your ONLY job is to check if hooks flow naturally into the body.`;

  let user = `Read each hook below, then immediately read the body's opening. Judge if they sound like one continuous script written by the same person.

${hooks.map((h, i) => `HOOK ${i + 1}: "${h}"
→ BODY STARTS: "${bodyFirstLine}"`).join('\n\n')}

For each hook, return:
- blend_score (1-10): 1 = jarring disconnect, 10 = perfectly seamless
- issue: null if score >= 7, otherwise describe the disconnect in one sentence
- fix_suggestion: null if score >= 7, otherwise suggest a one-sentence fix

Return ONLY valid JSON:
{
  "hooks": [
    { "id": 1, "blend_score": 8, "issue": null, "fix_suggestion": null },
    { "id": 2, "blend_score": 5, "issue": "Hook uses casual UGC tone but body opens with authoritative data", "fix_suggestion": "Soften the body's opening to match the casual hook tone" },
    { "id": 3, "blend_score": 9, "issue": null, "fix_suggestion": null }
  ],
  "overall_blend": 7.3,
  "pass": true
}

A brief PASSES if overall_blend >= 6.5.`;


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
  // highlighted_text = on-screen overlay labels. Reference-driven only —
  // empty array when source had no overlays. We never fabricate. The
  // operator can override from the modal once that section ships.
  const highlightedTextRaw = overrides.highlighted_text ?? generatedBrief.highlighted_text;
  const iteration_direction = overrides.idea ?? generatedBrief.iteration_direction;
  // Naming convention: prefer operator-provided override (live-preview from
  // modal). Else use stored naming_convention. Else build fresh from parts.
  const namingOverride   = overrides.naming_convention;
  const referenceLinkOverride = overrides.reference_link;

  const weekLabel = getCurrentWeekLabel();
  const namingConvention = namingOverride
    || generatedBrief.naming_convention
    || buildNamingConvention({
      product_code, brief_number, parent_creative_id, avatar, angle, format,
      strategist, creator, editor, week: weekLabel, brief_type,
    });

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
  if (!referenceLink && generatedBrief.winner_id) {
    try {
      const refRows = await pgQuery(
        `SELECT bpr.source_url
           FROM brief_pipeline_winners bpw
           JOIN brief_pipeline_references bpr ON bpr.id = bpw.reference_id
          WHERE bpw.id = $1
          LIMIT 1`,
        [generatedBrief.winner_id],
      );
      const candidate = refRows[0]?.source_url;
      if (candidate) referenceLink = candidate;
    } catch (err) {
      console.warn('[BriefPipeline] Could not resolve reference.source_url for push:', err.message);
    }
  }

  // Build description in the operator's ClickUp template:
  //
  //   Reference link: <url>
  //
  //   Highlighted text:
  //
  //   LABEL 1 emoji
  //   LABEL 2 emoji
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
  // The "Highlighted text:" section is skipped entirely when the brief has
  // no on-screen overlays — we never emit an empty header (see operator
  // requirement: overlays are reference-driven, not fabricated).
  const parsedHooks = (() => {
    if (Array.isArray(hooks)) return hooks;
    if (typeof hooks === 'string') { try { return JSON.parse(hooks); } catch { return []; } }
    return [];
  })();
  const hooksFormatted = parsedHooks
    .map((h) => (h.text || '').trim())
    .filter(Boolean)
    .join('\n\n');

  const parsedHighlights = (() => {
    if (Array.isArray(highlightedTextRaw)) return highlightedTextRaw;
    if (typeof highlightedTextRaw === 'string') {
      try { const arr = JSON.parse(highlightedTextRaw); return Array.isArray(arr) ? arr : []; }
      catch { return []; }
    }
    return [];
  })().map((s) => String(s || '').trim()).filter(Boolean);

  const sections = [];
  if (referenceLink) sections.push(`Reference link: ${referenceLink}`);
  if (parsedHighlights.length) {
    sections.push(`Highlighted text:\n\n${parsedHighlights.join('\n')}`);
  }
  sections.push(`HOOKS:\n\n${hooksFormatted || '(no hooks)'}`);
  sections.push(`BODY:\n\n${body || ''}`);
  sections.push('[brief-pipeline]');
  const description = sections.join('\n\n');

  // Resolve dropdown option IDs. Angle is normalized through the alias map so
  // analyzer-emitted display strings (e.g. "Anti-Fake / Competitor Callout")
  // resolve to the canonical key ("Againstcompetition") and then to the UUID.
  const angleKey = normalizeAngleKey(angle);
  const angleUuid = ANGLE_OPTIONS[angleKey] || ANGLE_OPTIONS.NA;
  // ClickUp dropdown UUID for brief type. Derives from the resolved
  // brief_type above (NN for clones, IT for iterations).
  const briefTypeUuid = BRIEF_TYPE_OPTIONS[brief_type] || BRIEF_TYPE_OPTIONS.IT;
  const creativeTypeUuid = CREATIVE_TYPE_OPTIONS[format] || CREATIVE_TYPE_OPTIONS.Mashup;

  const editorMap = await getEditors();
  const editorUserId = editorMap[editor] || OWNER_ID;

  const customFields = [
    { id: FIELD_IDS.briefNumber, value: brief_number },
    { id: FIELD_IDS.briefType, value: briefTypeUuid },
    { id: FIELD_IDS.parentBriefId, value: parent_creative_id },
    { id: FIELD_IDS.idea, value: iteration_direction || '-' },
    { id: FIELD_IDS.angle, value: angleUuid },
    { id: FIELD_IDS.creativeType, value: creativeTypeUuid },
    { id: FIELD_IDS.namingConvention, value: namingConvention },
    { id: FIELD_IDS.creationWeek, value: weekLabel },
    { id: FIELD_IDS.creativeStrategist, value: { add: [OWNER_ID], rem: [] } },
    { id: FIELD_IDS.copywriter, value: { add: [OWNER_ID], rem: [] } },
    { id: FIELD_IDS.editor, value: { add: [editorUserId], rem: [] } },
  ].filter(f => f.value != null);

  const taskPayload = {
    name: namingConvention,
    description,
    status: 'edit queue',
    assignees: [editorUserId],
    custom_fields: customFields,
  };

  let createdTask;
  try {
    createdTask = await clickupFetch(
      `/list/${VIDEO_ADS_LIST}/task`,
      { method: 'POST', body: JSON.stringify(taskPayload) }
    );
  } catch (err) {
    // If editor user doesn't have workspace access, retry without user fields
    if (err.message.includes('FIELD_129') || err.message.includes('must have access')) {
      console.warn(`[BriefPipeline] Editor ${editor} (${editorUserId}) not accessible, falling back to Ludovico`);
      const fallbackFields = customFields.map(f => {
        if (f.id === FIELD_IDS.editor) return { ...f, value: { add: [OWNER_ID], rem: [] } };
        return f;
      });
      const fallbackPayload = { ...taskPayload, assignees: [OWNER_ID], custom_fields: fallbackFields };
      createdTask = await clickupFetch(
        `/list/${VIDEO_ADS_LIST}/task`,
        { method: 'POST', body: JSON.stringify(fallbackPayload) }
      );
    } else {
      throw err;
    }
  }

  const taskId = createdTask.id;

  // Set relationship fields (Product, Avatar, Creator)
  const relationshipPromises = [];

  const productTaskId = PRODUCT_TASK_IDS[product_code] || PRODUCT_TASK_IDS.MR;
  if (productTaskId) {
    relationshipPromises.push(
      clickupFetch(`/task/${taskId}/field/${FIELD_IDS.product}`, {
        method: 'POST',
        body: JSON.stringify({ value: { add: [{ id: productTaskId }], rem: [] } }),
      }).catch(err => console.error('[BriefPipeline] Product relationship error:', err.message))
    );
  }

  const avatarTaskId = AVATAR_TASK_IDS[avatar];
  if (avatarTaskId) {
    relationshipPromises.push(
      clickupFetch(`/task/${taskId}/field/${FIELD_IDS.avatar}`, {
        method: 'POST',
        body: JSON.stringify({ value: { add: [{ id: avatarTaskId }], rem: [] } }),
      }).catch(err => console.error('[BriefPipeline] Avatar relationship error:', err.message))
    );
  }

  relationshipPromises.push(
    clickupFetch(`/task/${taskId}/field/${FIELD_IDS.creator}`, {
      method: 'POST',
      body: JSON.stringify({ value: { add: [{ id: CREATOR_NA_TASK_ID }], rem: [] } }),
    }).catch(err => console.error('[BriefPipeline] Creator relationship error:', err.message))
  );

  await Promise.all(relationshipPromises);

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
    const { script, url, productId, productCode, angle, mode, numVariations = 3, referenceId, vectorsSelected, acknowledgeBrandMismatch, acknowledgeAdCopyOnly } = req.body;

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

    // Continue generation in background (non-blocking)
    (async () => {
    try {
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
    const { system: parseSystem, user: parseUser } = await buildScriptParserPrompt(rawScript, creativeId);
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
      parsedScript = { hooks: [], body: rawScript, cta: '', format_notes: '' };
    }
    pgQuery(`UPDATE brief_pipeline_winners SET parsed_script = $1 WHERE id = $2`, [JSON.stringify(parsedScript), winner.id]).catch(() => {});

    if (!productProfile) {
      console.warn(`[BriefPipeline] WARNING: No product profile found for ${productCode || 'MR'} — generation will proceed with limited context`);
    }
    const productContext = buildProductContextForBrief(productProfile);
    console.log(`[BriefPipeline] Product context: ${productContext === 'No product profile available.' ? 'EMPTY (no profile)' : `${productContext.split('\n').length} fields loaded`}`);

    let nextBriefNum = await getNextBriefNumber();
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
      const iterResult = await callClaude(iterSystem, iterUser, 6000);
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
        generated: {
          hooks: Array.isArray(v.hooks) ? v.hooks : [],
          body:  v.body || '',
          cta:   v.cta || '',
          // On-screen overlay labels (empty if the winning script has none —
          // we never fabricate overlays. See iteration prompt rule §9.)
          highlighted_text: Array.isArray(v.highlighted_text) ? v.highlighted_text.filter(Boolean).map(String) : [],
          preservation_notes: v.preservation_notes || '',
        },
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

      generationResults = [await (async () => {
        try {
          const generated = await callClaude(cloneSystem, enhancedCloneUser, 4096);
          if (!generated || (!generated.hooks && !generated.body)) throw new Error('Invalid clone response');
          if (!Array.isArray(generated.hooks)) generated.hooks = [];
          if (!generated.body) generated.body = '';
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
          const scores = {
            novelty: { score: 7, rationale: 'Clone mode — structural fidelity over originality; product/angle swap adds freshness' },
            aggression: { score: 8, rationale: 'Preserved from proven original' },
            coherence: { score: 9, rationale: 'Structural clone maintains original flow and logic' },
            hook_body_blend: { score: 8, rationale: 'Hook-body relationship preserved from winning structure' },
            conversion_potential: { score: 9, rationale: 'Proven structure with validated conversion path' },
            verdict: 'YES',
            _clone_fast_path: true,
          };
          const overall = (7 * 0.15) + (8 * 0.15) + (9 * 0.25) + (8 * 0.15) + (9 * 0.30); // 8.4

          return {
            generated,
            scores,
            overall,
            direction: { id: 1, name: '1:1 Clone', description: 'Structural clone with product swap' },
            success: true,
          };
        } catch (err) {
          console.error(`[BriefPipeline] clone generation failed:`, err.message);
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
      const briefNumber = nextBriefNum++;
      const weekLabel = getCurrentWeekLabel();
      // Brief type derives from generation mode: clones of competitor ads
      // are Net New (NN); iterations of our own winners are IT. The mode
      // is set from the request body (clone | iterate) so this stays in
      // sync without re-querying the reference row.
      const briefType = isCloneMode ? 'NN' : 'IT';
      const namingConvention = buildNamingConvention({
        product_code: productCode || 'MR', brief_number: briefNumber,
        parent_creative_id: creativeId, avatar: 'NA', angle: angle || 'NA',
        format: 'Mashup', strategist: 'Ludovico', creator: 'NA', editor: 'Uly', week: weekLabel,
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
          JSON.stringify(winAnalysis), JSON.stringify(generated.hooks), generated.body,
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
          isIterateMode ? (direction.name || 'Iteration') : (angle || 'NA'),
          isIterateMode ? 'Iteration' : 'Mashup',
          'NA', 'Uly', 'Ludovico', 'NA', namingConvention,
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
      return;
    }

    // Rank (parallel updates)
    generatedBriefs.sort((a, b) => (b.overall_score || 0) - (a.overall_score || 0));
    await Promise.all(generatedBriefs.map((brief, i) => {
      brief.rank = i + 1;
      return pgQuery(`UPDATE brief_pipeline_generated SET rank = $1 WHERE id = $2`, [i + 1, brief.id]);
    }));

    // Mark virtual winner as detected (keeps it in the winning ads column)
    await pgQuery(`UPDATE brief_pipeline_winners SET status = 'detected' WHERE id = $1`, [winner.id]);

    console.log(`[BriefPipeline] generate-from-script complete: ${generatedBriefs.length} briefs`);
    } catch (bgErr) {
      console.error('[BriefPipeline] generate-from-script background error:', bgErr.message);
      // Reset winner status so user can retry
      await pgQuery(`UPDATE brief_pipeline_winners SET status = 'detected' WHERE id = $1`, [winner.id]).catch(() => {});
    }
    })(); // end background IIFE

  } catch (err) {
    console.error('[BriefPipeline] generate-from-script error:', err.message);
    if (!res.headersSent) {
      res.status(500).json({ success: false, error: { message: err.message } });
    }
  }
});

// GET /generation-status/:winnerId — poll for background generation completion
router.get('/generation-status/:winnerId', authenticate, async (req, res) => {
  try {
    const winnerId = req.params.winnerId;
    // Check winner status
    const winnerRows = await pgQuery(
      `SELECT id, status, creative_id FROM brief_pipeline_winners WHERE id = $1`,
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
        ORDER BY g.overall_score DESC NULLS LAST, g.created_at DESC`
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

${productContextStr ? `PRODUCT CONTEXT:\n${productContextStr}\n\n` : ''}EXISTING COPY:
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
      const editorMap = await getEditors();
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

    // Check if it already exists (so we can report alreadyExists: true)
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
    // v3 — adds the spoken-script inference fallback to §7 (Forge-class
    // sources that came through Whisper without overlay markers now still
    // get inferred banner labels when the script has 2+ overlay signals).
    const CLONE_V2_SIGNATURE = 'OVERLAY-SIGNAL CHECK';
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

export default router;
