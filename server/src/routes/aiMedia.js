// AI MEDIA — the "AI Media · CLAUDE × HIGGSFIELD" dialog's backend.
//
// Mount (routes/index.js):
//   app.use('/api/v1/ai-media', aiMediaRoutes);
//
// Surface (authenticated + funnels:access, the same gate the builder and the
// media library use):
//   POST /generate      { prompt, aspect, quality, batch } -> 201 { jobs:[{job_id, job_token, ...}] }
//   GET  /jobs/:id      X-Job-Token header                 -> 200 { data:{ id, status, url, media } }
//
// ═══════════════════════════════════════════════════════════════════════════
// WHY THIS ROUTE EXISTS SEPARATELY FROM aiDeveloper.js
// ═══════════════════════════════════════════════════════════════════════════
// aiDeveloper's /jobs/:id is a PROXY: it hands the raw Higgsfield asset URL
// back to the browser and nothing is stored. That is fine for a chat card the
// operator looks at once — it is NOT fine for an image that ends up in a
// published funnel page, because the Higgsfield CDN URL is a third party's
// link with a lifetime we do not control (the same rot brandSpyMediaMirror.js
// and media.js's import-url re-host exist to prevent).
//
// So this route RE-HOSTS: on the first poll that sees `completed`, the asset
// is downloaded server-side (bounded, sniffed, guarded) and pushed through
// mediaService.putImage onto OUR CDN, then indexed as an ordinary lb_media
// row. From that moment the library is the single source of truth: the same
// asset is reachable from the "From files" tab, from the media library modal,
// and from any block that already renders an lb_media url. The Higgsfield URL
// may rot freely.
//
// ═══════════════════════════════════════════════════════════════════════════
// WHAT IS DELIBERATELY REUSED, NOT FORKED
// ═══════════════════════════════════════════════════════════════════════════
//   • services/higgsfield.js       createImageJob / getJob / isAllowedAssetUrl
//   • routes/aiDeveloper.js        jobToken() — the SAME HMAC ownership scheme,
//                                  the SAME secret. Imported, never re-derived:
//                                  two token schemes over one job namespace is
//                                  how one of them silently stops being checked.
//   • services/mediaService.js     importUrlAllowed + fetchExternalImage (the
//                                  hardened, DNS-pinned, streaming-capped
//                                  downloader), sniffMime (inside it),
//                                  imageDimensions, putImage, sanitizeFilename
//   • services/mediaSchema.js      ensureMediaTables — lb_media's only owner
//
// This file owns exactly ONE new table, lb_ai_media_jobs, ensure-on-demand.
//
// ═══════════════════════════════════════════════════════════════════════════
// KNOWN GAP (documented, not hidden)
// ═══════════════════════════════════════════════════════════════════════════
// `quality` is validated, stored and echoed back, but NOT forwarded upstream:
// services/higgsfield.js's createImageJob only forwards {prompt, aspect_ratio}
// and that file is out of scope for this change. Wiring quality through is a
// one-line addition to createImageJob's payload builder when someone owns that
// file next. The dialog therefore shows quality as an operator preference that
// is recorded with the job, not as a promise about the pixels.
import { timingSafeEqual } from 'crypto';
import { Router } from 'express';
import { pgQuery } from '../db/pg.js';
import { authenticate } from '../middleware/auth.js';
import { requirePermission } from '../middleware/rbac.js';
import { checkRateLimit } from '../middleware/rateLimiter.js';
import { jobToken } from './aiDeveloper.js';
import { createImageJob, getJob, isAllowedAssetUrl } from '../services/higgsfield.js';
import { ensureMediaTables } from '../services/mediaSchema.js';
import {
  putImage,
  storageBackend,
  imageDimensions,
  importUrlAllowed,
  fetchExternalImage,
  sanitizeFilename,
  newMediaId,
  StorageUnavailableError,
} from '../services/mediaService.js';

const router = Router();
router.use(authenticate, requirePermission('funnels', 'access'));

// ---------------------------------------------------------------------------
// Limits — the dialog's dropdowns are the allowlists, not decoration.
// ---------------------------------------------------------------------------
export const ASPECTS = ['9:16', '1:1', '16:9', '4:5', '3:4'];
export const QUALITIES = ['1080p', '720p'];
export const BATCHES = [1, 2, 4];
const DEFAULT_ASPECT = '9:16';
const DEFAULT_QUALITY = '1080p';
const MAX_PROMPT_CHARS = 2000;

// 10 generations per user per 5 minutes. A batch of 4 counts as FOUR, because
// the thing being limited is spend at Higgsfield, and spend scales with the
// batch, not with the number of HTTP requests.
const GEN_WINDOW_SEC = 5 * 60;
const DEFAULT_GEN_LIMIT = 10;

// Read at CALL time (media.js:89's reason): an operator raising the ceiling
// mid-session should not need a redeploy, and the harness must be able to
// drive both sides of the limit inside one process.
function generationLimit() {
  const raw = process.env.AI_MEDIA_GEN_LIMIT;
  if (raw === undefined || String(raw).trim() === '') return DEFAULT_GEN_LIMIT;
  const n = Number(raw);
  if (!Number.isFinite(n) || n < 1) return DEFAULT_GEN_LIMIT;
  return Math.trunc(n);
}

// A generated asset is an image the operator will drop on a paid-traffic page.
// 20MB is generous for that and is a hard ceiling on what one poll can pull
// into a 512MB dyno's memory.
const MAX_ASSET_BYTES = 20 * 1024 * 1024;

const isPlainObject = (v) => v != null && typeof v === 'object' && !Array.isArray(v);

// Structured errors — a client reads error.code, never a message regex.
const fail = (res, status, code, message) =>
  res.status(status).json({ success: false, error: { code, ...(message ? { message } : {}) } });

// ---------------------------------------------------------------------------
// lb_ai_media_jobs — the claim table.
//
// It exists for ONE reason: to make "this job's asset has already been
// re-hosted" a fact the database owns, so a second poll (or a second browser
// tab, or a retry after a dropped response) returns the SAME lb_media row
// instead of paying for a second download + CDN write and leaving two rows
// behind. `status` is the claim; `media_id` is the answer.
//
// status: pending | persisting | completed | failed
//   persisting is the in-flight claim taken by an atomic conditional UPDATE —
//   a check-then-write would race two concurrent polls straight past it.
//
// Ensure-on-demand with the single-in-flight-promise guard, identical to
// mediaSchema/checkoutSchema: two concurrent first requests must not run
// CREATE TABLE in parallel.
// ---------------------------------------------------------------------------
let tablesReadyPromise = null;

export function ensureAiMediaTables() {
  if (!tablesReadyPromise) {
    tablesReadyPromise = createTables().catch((err) => {
      // Reset so the NEXT request retries rather than inheriting a poisoned
      // resolved-once promise.
      tablesReadyPromise = null;
      throw err;
    });
  }
  return tablesReadyPromise;
}

async function createTables() {
  await pgQuery(`
    CREATE TABLE IF NOT EXISTS lb_ai_media_jobs (
      job_id TEXT PRIMARY KEY,
      user_id TEXT NOT NULL,
      status TEXT NOT NULL DEFAULT 'pending',
      media_id TEXT,
      prompt TEXT NOT NULL DEFAULT '',
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )
  `);
  await pgQuery(
    `CREATE INDEX IF NOT EXISTS idx_lb_ai_media_jobs_user_created
       ON lb_ai_media_jobs (user_id, created_at DESC)`
  );
}

// ---------------------------------------------------------------------------
// Ownership — the SAME scheme aiDeveloper.js issues and verifies.
//
// jobToken() is IMPORTED (not re-implemented) so there is exactly one HMAC
// derivation over the job namespace. The verifier is local only because
// aiDeveloper does not export it; it is byte-for-byte the same comparison
// (aiDeveloper.js:142) over the imported tag.
// ---------------------------------------------------------------------------
function verifyJobToken(jobId, userId, provided) {
  if (typeof provided !== 'string' || !provided) return false;
  const expected = Buffer.from(jobToken(jobId, userId), 'utf8');
  const given = Buffer.from(provided, 'utf8');
  if (given.length !== expected.length) return false;
  return timingSafeEqual(expected, given);
}

// ---------------------------------------------------------------------------
// Upstream failure classification.
//
// higgsfield.js is fail-closed: it never throws, it returns {ok:false, error}
// with a human string. Credits exhaustion is the one operator-actionable case
// that must NOT read as "something broke" — the dialog turns this code into a
// calm amber note, not an error toast.
// ---------------------------------------------------------------------------
export function classifyUpstream(message) {
  const m = String(message || '');
  if (/not_enough_credits|insufficient[_ ]?credits|not enough credits/i.test(m)) {
    return {
      status: 402,
      code: 'not_enough_credits',
      message: 'Higgsfield credits are empty — top up to generate',
    };
  }
  if (/credentials are not configured/i.test(m)) {
    return {
      status: 503,
      code: 'not_configured',
      message: 'Higgsfield is not configured (HIGGSFIELD_API_KEY / HIGGSFIELD_API_SECRET).',
    };
  }
  return {
    status: 502,
    code: 'upstream_error',
    message: m.slice(0, 300) || 'Higgsfield rejected the request',
  };
}

const upstreamFail = (res, message) => {
  const c = classifyUpstream(message);
  return fail(res, c.status, c.code, c.message);
};

// ---------------------------------------------------------------------------
// Rate limit. checkRateLimit increments by one per call, so a batch of N is
// charged by calling it N times. On refusal the units already charged stay
// charged: over-counting a REFUSED request is the conservative direction — the
// alternative (check first, charge later) is a window an operator can drive a
// 4x batch through every time.
// ---------------------------------------------------------------------------
async function consumeGenerationQuota(who, units) {
  let last = { allowed: true, remaining: 0, retryAfter: 0 };
  const limit = generationLimit();
  for (let i = 0; i < units; i += 1) {
    // eslint-disable-next-line no-await-in-loop
    last = await checkRateLimit(`ai-media:${who}`, limit, GEN_WINDOW_SEC);
    if (!last.allowed) return last;
  }
  return last;
}

// ---------------------------------------------------------------------------
// lb_media views — the SAME field set MediaLibraryModal's onSelect contract
// documents, so a caller cannot tell an AI generation from an upload.
// ---------------------------------------------------------------------------
const MEDIA_COLS = `id, kind, source, url, filename, mime, bytes, width, height,
                    alt, shopify_file_id, created_by, created_at, archived`;

const mediaView = (r) => ({
  id: r.id,
  kind: r.kind,
  source: r.source,
  url: r.url,
  filename: r.filename || '',
  mime: r.mime || '',
  bytes: r.bytes == null ? null : Number(r.bytes),
  width: r.width == null ? null : Number(r.width),
  height: r.height == null ? null : Number(r.height),
  alt: r.alt || '',
  shopify_file_id: r.shopify_file_id || null,
  created_by: r.created_by || null,
  created_at: r.created_at,
  archived: Boolean(r.archived),
});

async function loadMedia(id) {
  if (!id) return null;
  const rows = await pgQuery(`SELECT ${MEDIA_COLS} FROM lb_media WHERE id = $1`, [id]);
  return rows.length ? mediaView(rows[0]) : null;
}

const jobPayload = (id, status, { media = null, error = null } = {}) => ({
  success: true,
  data: {
    id,
    status,
    url: media ? media.url : null,
    media,
    ...(error ? { error } : {}),
  },
});

// ---------------------------------------------------------------------------
// The re-host. Everything about this download is somebody else's bytes, so
// every step is the hardened one that already exists:
//
//   isAllowedAssetUrl  — https + a higgsfield-owned host (checked by the CALLER
//                        before we get here, and it is the reason a compromised
//                        or spoofed job cannot point us at an arbitrary origin)
//   importUrlAllowed   — resolves the host ONCE and refuses private/loopback/
//                        metadata addresses
//   fetchExternalImage — connects to the ADDRESS the guard approved (no
//                        re-resolution → no DNS rebinding), refuses redirects,
//                        enforces the byte cap DURING the stream, and sniffs
//                        the magic bytes (mediaService.sniffMime) instead of
//                        believing Content-Type
//
// Returns {ok:true, buffer, mime, bytes} or {ok:false, code, detail, terminal}.
// `terminal` separates "this job will never produce a usable asset" (mark it
// failed, stop polling) from "this attempt failed" (leave it pollable).
// ---------------------------------------------------------------------------
const TERMINAL_DOWNLOAD_CODES = new Set([
  'too_large', 'unsupported_type', 'redirect_refused', 'upstream_status',
  'empty_body', 'blocked_host', 'invalid_scheme', 'dns_resolution_failed',
]);

async function downloadAsset(url) {
  const verdict = await importUrlAllowed(url);
  if (!verdict.ok) {
    const code = verdict.reason === 'scheme' ? 'invalid_scheme'
      : verdict.reason === 'blocked_host' ? 'blocked_host'
        : 'dns_resolution_failed';
    return { ok: false, code, detail: '', terminal: true };
  }
  try {
    const got = await fetchExternalImage(url, {
      maxBytes: MAX_ASSET_BYTES,
      addresses: verdict.addresses,
      relaxed: verdict.relaxed,
    });
    return { ok: true, ...got };
  } catch (err) {
    const code = err?.code || 'fetch_failed';
    return {
      ok: false,
      code,
      detail: String(err?.detail ?? '').slice(0, 120),
      terminal: TERMINAL_DOWNLOAD_CODES.has(code),
    };
  }
}

const DOWNLOAD_MESSAGES = {
  too_large: `The generated asset is larger than the ${MAX_ASSET_BYTES} byte limit and was not stored.`,
  unsupported_type: 'The generated asset is not a PNG/JPEG/GIF/WebP image and was not stored.',
  redirect_refused: 'The asset URL redirects; redirects are not followed.',
  upstream_status: 'The asset could not be downloaded from Higgsfield.',
  empty_body: 'Higgsfield returned an empty asset.',
  blocked_host: 'The asset URL resolves to a private or loopback address.',
  invalid_scheme: 'The asset URL is not an https URL.',
  dns_resolution_failed: 'The asset host could not be resolved.',
};

// ---------------------------------------------------------------------------
// POST /generate
// ---------------------------------------------------------------------------
router.post('/generate', async (req, res, next) => {
  try {
    const body = isPlainObject(req.body) ? req.body : {};

    const prompt = typeof body.prompt === 'string' ? body.prompt.trim() : '';
    if (!prompt) return fail(res, 400, 'prompt_required', 'Write a prompt first.');
    if (prompt.length > MAX_PROMPT_CHARS) {
      return fail(res, 400, 'prompt_too_long', `The prompt is capped at ${MAX_PROMPT_CHARS} characters.`);
    }

    const aspect = body.aspect === undefined || body.aspect === null || body.aspect === ''
      ? DEFAULT_ASPECT : String(body.aspect);
    if (!ASPECTS.includes(aspect)) {
      return fail(res, 400, 'invalid_aspect', `aspect must be one of: ${ASPECTS.join(', ')}`);
    }

    const quality = body.quality === undefined || body.quality === null || body.quality === ''
      ? DEFAULT_QUALITY : String(body.quality);
    if (!QUALITIES.includes(quality)) {
      return fail(res, 400, 'invalid_quality', `quality must be one of: ${QUALITIES.join(', ')}`);
    }

    // STRICT, no coercion. Number('2'), Number([2]) and Number(true) all land
    // on a value the allowlist would accept, and batch is the multiplier on
    // both the spend and the rate limit — the one field where a forgiving
    // parse buys nothing and costs money.
    const batch = body.batch === undefined ? 1 : body.batch;
    if (typeof batch !== 'number' || !BATCHES.includes(batch)) {
      return fail(res, 400, 'invalid_batch', `batch must be one of: ${BATCHES.join(', ')}`);
    }

    const who = req.user?.id || req.ip || 'unknown';
    const rl = await consumeGenerationQuota(who, batch).catch(() => ({ allowed: true }));
    if (!rl.allowed) {
      const retryAfter = rl.retryAfter || GEN_WINDOW_SEC;
      res.set('Retry-After', String(retryAfter));
      return res.status(429).json({
        success: false,
        error: {
          code: 'rate_limited',
          message: `Too many generations. Try again in ${retryAfter}s.`,
          retryAfter,
        },
      });
    }

    await ensureAiMediaTables();

    const jobs = [];
    let firstError = null;
    for (let i = 0; i < batch; i += 1) {
      // eslint-disable-next-line no-await-in-loop
      const created = await createImageJob({ prompt, aspect_ratio: aspect });
      if (!created.ok) { firstError = created.error; break; }
      // eslint-disable-next-line no-await-in-loop
      await pgQuery(
        `INSERT INTO lb_ai_media_jobs (job_id, user_id, status, prompt)
         VALUES ($1, $2, 'pending', $3)
         ON CONFLICT (job_id) DO NOTHING`,
        [created.id, req.user.id, prompt.slice(0, 500)]
      );
      jobs.push({
        job_id: created.id,
        // The poll credential. Header-only on the way back (never a URL).
        job_token: jobToken(created.id, req.user.id),
        aspect,
        quality,
      });
    }

    // Nothing started → the upstream reason IS the answer (credits, config,
    // upstream error). Something started → 201 with an honest partial note;
    // silently dropping 3 of a 4-batch is how an operator pays for 4 and
    // believes they got 4.
    if (!jobs.length) return upstreamFail(res, firstError);
    return res.status(201).json({
      success: true,
      jobs,
      ...(firstError
        ? { partial: { requested: batch, started: jobs.length, ...classifyUpstream(firstError) } }
        : {}),
    });
  } catch (err) {
    return next(err);
  }
});

// ---------------------------------------------------------------------------
// GET /jobs/:id — status + (on completion) the re-hosted lb_media row.
// ---------------------------------------------------------------------------
router.get('/jobs/:id', async (req, res, next) => {
  try {
    const id = String(req.params.id || '');
    const userId = req.user.id;

    // Ownership first, and the refusal is an indistinguishable 404: a wrong
    // user, a missing tag and a garbage tag must all look identical, or the
    // status code becomes an oracle for "this job id exists".
    if (!verifyJobToken(id, userId, req.get('x-job-token'))) {
      return fail(res, 404, 'not_found');
    }

    await ensureAiMediaTables();
    await ensureMediaTables();

    const claims = await pgQuery(
      `SELECT job_id, user_id, status, media_id, prompt FROM lb_ai_media_jobs WHERE job_id = $1`,
      [id]
    );
    const claim = claims[0];
    // Defence in depth: a valid tag already proves this user minted the job,
    // but the row is the record of it and the two must agree.
    if (!claim || claim.user_id !== userId) return fail(res, 404, 'not_found');

    // ── already re-hosted → answer from OUR row, no upstream call at all ──
    if (claim.status === 'completed' && claim.media_id) {
      const media = await loadMedia(claim.media_id);
      if (media) return res.json(jobPayload(id, 'completed', { media }));
      // The row is gone (there is no DELETE route, so this means a manual
      // cleanup). Fall through and re-host rather than serve a dangling id.
    }

    const job = await getJob(id);
    if (!job.ok) return upstreamFail(res, job.error);

    if (job.status !== 'completed') {
      if (job.status === 'failed') {
        await pgQuery(
          `UPDATE lb_ai_media_jobs SET status = 'failed' WHERE job_id = $1 AND status <> 'completed'`,
          [id]
        );
        return res.json(jobPayload(id, 'failed', { error: `Higgsfield reported "${job.raw_status}"` }));
      }
      return res.json(jobPayload(id, job.status));
    }

    // ── completed upstream: the asset URL is a claim until it is checked ──
    if (!job.url || !isAllowedAssetUrl(job.url)) {
      await pgQuery(
        `UPDATE lb_ai_media_jobs SET status = 'failed' WHERE job_id = $1 AND status <> 'completed'`,
        [id]
      );
      return res.json(jobPayload(id, 'failed', {
        error: 'asset URL rejected: not a higgsfield-owned https host',
      }));
    }

    // ── atomic claim: exactly one poll does the download + CDN write ─────
    const claimed = await pgQuery(
      `UPDATE lb_ai_media_jobs SET status = 'persisting'
        WHERE job_id = $1 AND status IN ('pending', 'failed')
        RETURNING job_id`,
      [id]
    );
    if (!claimed.length) {
      const again = await pgQuery(
        `SELECT status, media_id FROM lb_ai_media_jobs WHERE job_id = $1`, [id]
      );
      const now = again[0];
      if (now?.status === 'completed' && now.media_id) {
        const media = await loadMedia(now.media_id);
        if (media) return res.json(jobPayload(id, 'completed', { media }));
      }
      // Another poll holds the claim. Report in_progress so the caller keeps
      // polling — it will get the row on the next tick.
      return res.json(jobPayload(id, 'in_progress'));
    }

    const release = async (status) => {
      await pgQuery(
        `UPDATE lb_ai_media_jobs SET status = $2 WHERE job_id = $1 AND status = 'persisting'`,
        [id, status]
      );
    };

    let asset;
    try {
      asset = await downloadAsset(job.url);
    } catch (err) {
      await release('pending');
      throw err;
    }
    if (!asset.ok) {
      await release(asset.terminal ? 'failed' : 'pending');
      if (!asset.terminal) {
        return fail(res, 502, 'asset_download_failed',
          'The generated asset could not be downloaded — retrying.');
      }
      return res.json(jobPayload(id, 'failed', {
        error: DOWNLOAD_MESSAGES[asset.code] || 'The generated asset was refused.',
      }));
    }

    if (!storageBackend()) {
      // Nothing was stored, so nothing is claimed. Leave the job pollable: the
      // moment a CDN backend is configured the next poll re-hosts it.
      await release('pending');
      return fail(res, 503, 'storage_unavailable',
        'No CDN backend is configured, so the generated image cannot be stored in the library.');
    }

    const dims = imageDimensions(asset.buffer, asset.mime) || {};
    const alt = String(claim.prompt || '').slice(0, 500);
    const filename = sanitizeFilename(`ai-${id}`, asset.mime);

    let stored;
    try {
      stored = await putImage({ buffer: asset.buffer, filename, mime: asset.mime, alt });
    } catch (err) {
      await release('pending');
      if (err instanceof StorageUnavailableError) {
        return fail(res, 503, err.code || 'storage_unavailable',
          err.detail || 'The generated image could not be stored on the CDN.');
      }
      throw err;
    }

    const mediaId = newMediaId();
    let inserted;
    try {
      const rows = await pgQuery(
        `INSERT INTO lb_media
           (id, kind, source, url, filename, mime, bytes, width, height, alt,
            shopify_file_id, created_by)
         VALUES ($1,'image','url',$2,$3,$4,$5,$6,$7,$8,$9,$10)
         RETURNING ${MEDIA_COLS}`,
        [
          mediaId, stored.url, stored.filename || filename, asset.mime, asset.bytes,
          // OUR header parse only — media.js:250 states the reason: a null from
          // the parser is a REFUSAL, and falling back to a CDN echo of the same
          // rejected header reinstates exactly what the refusal prevents.
          dims.width ?? null, dims.height ?? null, alt,
          stored.shopifyFileId || null, userId,
        ]
      );
      inserted = rows[0];
    } catch (err) {
      await release('pending');
      throw err;
    }

    // The claim is only settled once the row exists. Order matters: a crash
    // between these two writes leaves the job 'persisting' with no media_id,
    // and the next poll's conditional UPDATE will not re-claim it — which is
    // the safe direction (a stuck card, never a duplicate charge + row).
    await pgQuery(
      `UPDATE lb_ai_media_jobs SET status = 'completed', media_id = $2 WHERE job_id = $1`,
      [id, mediaId]
    );

    return res.json(jobPayload(id, 'completed', { media: mediaView(inserted) }));
  } catch (err) {
    return next(err);
  }
});

export default router;
