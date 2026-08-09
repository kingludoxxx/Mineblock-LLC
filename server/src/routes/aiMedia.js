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
  MAX_IMPORT_BYTES,
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

// The lane's existing external-image ceiling, IMPORTED rather than restated.
// media.js's import-url path already answers "how big may an image we pull
// from someone else's host be" with MAX_IMPORT_BYTES (10MB), and two different
// answers to that question in one service is how the smaller one stops being
// the real limit. A generated hero image is nowhere near it.
const MAX_ASSET_BYTES = MAX_IMPORT_BYTES;

const isPlainObject = (v) => v != null && typeof v === 'object' && !Array.isArray(v);

// A jsonb column comes back as a STRING from this repo's pg driver, not as a
// parsed object (verified by execution against the live DB — `typeof stored`
// is 'string'). Assuming either behaviour is how the `stored` receipt silently
// stopped being read; this handles both and refuses anything that is not an
// object, so a corrupt cell degrades to "no receipt" rather than a TypeError
// three lines later.
function parseJsonColumn(value) {
  if (value == null) return null;
  if (isPlainObject(value)) return value;
  if (typeof value !== 'string') return null;
  try {
    const parsed = JSON.parse(value);
    return isPlainObject(parsed) ? parsed : null;
  } catch {
    return null;
  }
}

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
// status: pending | persisting | completed | failed | dead
//   pending     nothing done yet, or a TRANSIENT attempt failed — re-claimable
//   persisting  an in-flight claim, taken by an atomic conditional UPDATE. A
//               check-then-write would race two concurrent polls straight past
//               it. `claimed_at` is what makes the claim RECOVERABLE: a dyno
//               that dies mid-download would otherwise strand the row here
//               forever, with the operator already charged for the generation
//               and every later poll answering "in_progress" until the heat
//               death of the universe. After CLAIM_STALE_SEC the next poll may
//               steal it.
//   completed   media_id names a live lb_media row
//   failed      this attempt will not produce an asset (upstream said so) but
//               a later poll may still learn otherwise — re-claimable
//   dead        TERMINALLY refused by OUR checks (oversize, not an image, a
//               host we will not fetch). NOT re-claimable, and answered
//               without ever calling upstream again.
//
// `stored` is the ORPHAN FIX. putImage() writes bytes to a CDN we are billed
// for; the lb_media INSERT is a separate statement that can fail (circuit
// breaker, timeout, deploy). Recording the CDN result on the claim row the
// instant putImage returns means the retry re-uses those bytes instead of
// paying to upload them a second time, and it means a completed job whose
// lb_media row was manually deleted can be rebuilt without touching Higgsfield
// or the CDN at all. No reaper process required — the next poll reconciles.
//
// Ensure-on-demand with the single-in-flight-promise guard, identical to
// mediaSchema/checkoutSchema: two concurrent first requests must not run
// CREATE TABLE in parallel.
// ---------------------------------------------------------------------------
export const CLAIM_STALE_SEC = 300; // 5 minutes

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
      aspect TEXT,
      quality TEXT,
      claimed_at TIMESTAMPTZ,
      stored JSONB,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )
  `);
  // Additive, for a table an earlier deploy already created. IF NOT EXISTS
  // makes each one a no-op on a fresh table.
  for (const col of [
    'aspect TEXT', 'quality TEXT', 'claimed_at TIMESTAMPTZ', 'stored JSONB',
  ]) {
    // eslint-disable-next-line no-await-in-loop
    await pgQuery(`ALTER TABLE lb_ai_media_jobs ADD COLUMN IF NOT EXISTS ${col}`);
  }
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
//
// The generic branch does NOT forward the upstream string. That string is a
// third party's prose about a request WE built, and it has already carried a
// status line and a body fragment; echoing it into the browser is how internal
// detail leaks out of a vendor error one day. `detail` is returned separately
// and only ever goes to the server log.
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
    message: 'Higgsfield could not be reached right now — try again in a moment.',
    detail: m.slice(0, 300),
  };
}

const upstreamFail = (res, message) => {
  const c = classifyUpstream(message);
  if (c.detail) console.error('[ai-media] upstream failure:', c.detail);
  return fail(res, c.status, c.code, c.message);
};

// ---------------------------------------------------------------------------
// Rate limit. checkRateLimit increments by one per call, so a batch of N is
// charged by calling it N times. On refusal the units already charged stay
// charged: over-counting a REFUSED request is the conservative direction — the
// alternative (check first, charge later) is a window an operator can drive a
// 4x batch through every time.
//
// Returns { allowed, consumed, remaining, retryAfter }. `consumed` is what the
// 429 body reports: an operator who asked for a batch of 4 with 2 units left
// has BURNED those 2, and a refusal that does not say so reads as "nothing
// happened" while their quota quietly drained.
// ---------------------------------------------------------------------------
// Test seam, the same shape mediaService._dnsHooks / _r2Hooks use. The
// fail-closed branch below is the one that decides whether a broken limiter
// costs money, so it has to be reachable from a harness — an unverified
// failure path is a claim about a mechanism, not evidence.
export const _hooks = { checkRateLimit };

async function consumeGenerationQuota(who, units) {
  const limit = generationLimit();
  let consumed = 0;
  let last = { allowed: true, remaining: limit, retryAfter: 0 };
  for (let i = 0; i < units; i += 1) {
    // eslint-disable-next-line no-await-in-loop
    last = await _hooks.checkRateLimit(`ai-media:${who}`, limit, GEN_WINDOW_SEC);
    consumed += 1;
    if (!last.allowed) {
      return { allowed: false, consumed, remaining: 0, retryAfter: last.retryAfter || GEN_WINDOW_SEC };
    }
  }
  return { allowed: true, consumed, remaining: last.remaining ?? 0, retryAfter: 0 };
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

const jobPayload = (id, status, {
  media = null, error = null, permanent = false, aspect = null, quality = null,
} = {}) => ({
  success: true,
  data: {
    id,
    status,
    url: media ? media.url : null,
    media,
    // Echoed back so a card can label itself without the client having to
    // remember what it asked for (and so a reopened dialog can too).
    aspect,
    quality,
    ...(error ? { error } : {}),
    // `permanent` is the client's licence to STOP polling. Without it a failed
    // card and a dead card look identical and Retry arms 100 futile requests.
    ...(permanent ? { permanent: true } : {}),
  },
});

// Higgsfield's own id shape (higgsfield.js:99 mints ids against this exact
// pattern, and getJob refuses anything else) — so a request that cannot be a
// job id is answered here rather than three network calls later.
const JOB_ID_RE = /^[A-Za-z0-9_-]{4,128}$/;

// Terminal refusal BY US. Distinct from 'failed' (upstream's verdict, which a
// later poll may revise): nothing re-claims a dead job, and the reason is kept
// on the row so every later poll can answer without calling anyone.
async function markDead(jobId, reason) {
  await pgQuery(
    `UPDATE lb_ai_media_jobs
        SET status = 'dead',
            stored = COALESCE(stored, '{}'::jsonb) || jsonb_build_object('dead_reason', $2::text)
      WHERE job_id = $1 AND status <> 'completed'`,
    [jobId, String(reason).slice(0, 300)]
  );
}

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
    // FAIL CLOSED, deliberately unlike media.js:97 and aiDeveloper.js:433 which
    // both fail OPEN. Those limiters protect a CPU; this one protects a credit
    // balance. If the limiter itself is broken we do not know how much of the
    // quota is already gone, and "let it through" is the branch that empties
    // the account while nobody is watching.
    let rl;
    try {
      rl = await consumeGenerationQuota(who, batch);
    } catch (err) {
      console.error('[ai-media] rate limiter unavailable — refusing (fail-closed):', err?.message || err);
      res.set('Retry-After', String(GEN_WINDOW_SEC));
      return res.status(429).json({
        success: false,
        error: {
          code: 'rate_limited',
          message: 'The generation quota could not be checked, so the request was refused. Try again shortly.',
          retryAfter: GEN_WINDOW_SEC,
          consumed: 0,
          remaining: 0,
          window_reset: new Date(Date.now() + GEN_WINDOW_SEC * 1000).toISOString(),
        },
      });
    }
    if (!rl.allowed) {
      const retryAfter = rl.retryAfter || GEN_WINDOW_SEC;
      res.set('Retry-After', String(retryAfter));
      return res.status(429).json({
        success: false,
        error: {
          code: 'rate_limited',
          message: `Too many generations. Try again in ${retryAfter}s.`,
          retryAfter,
          // The refusal burned quota. Saying so is the difference between the
          // UI reporting "try again" and reporting the truth.
          consumed: rl.consumed,
          remaining: 0,
          window_reset: new Date(Date.now() + retryAfter * 1000).toISOString(),
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
      const claimRows = await pgQuery(
        `INSERT INTO lb_ai_media_jobs (job_id, user_id, status, prompt, aspect, quality)
         VALUES ($1, $2, 'pending', $3, $4, $5)
         ON CONFLICT (job_id) DO NOTHING
         RETURNING job_id`,
        [created.id, req.user.id, prompt.slice(0, 500), aspect, quality]
      );
      if (!claimRows.length) {
        // Higgsfield handed us a request id we have SEEN BEFORE. Either their
        // ids are not unique or we are looking at a replay — both are things
        // somebody must be able to find in a log, because the pre-existing row
        // may belong to a different user and this poll will 404 for no visible
        // reason.
        console.error('[ai-media] job id collision — Higgsfield returned an id already in lb_ai_media_jobs:', created.id);
      }
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
    let partial;
    if (firstError) {
      const c = classifyUpstream(firstError);
      if (c.detail) console.error('[ai-media] partial batch, upstream failure:', c.detail);
      // `detail` is destructured OFF — it is the raw upstream string and it
      // belongs in the log, not in a browser.
      partial = { requested: batch, started: jobs.length, code: c.code, message: c.message };
    }
    return res.status(201).json({
      success: true,
      jobs,
      ...(partial ? { partial } : {}),
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

    // Shape check FIRST. It is not an existence oracle — it says nothing about
    // whether the id exists, only whether it could — and it keeps a garbage
    // path segment out of getJob() and out of a LIKE-free but still pointless
    // round trip to Postgres.
    if (!JOB_ID_RE.test(id)) {
      return fail(res, 400, 'invalid_job_id', 'That is not a valid job id.');
    }

    // Ownership, and the refusal is an indistinguishable 404: a wrong user, a
    // missing tag and a garbage tag must all look identical, or the status
    // code becomes an oracle for "this job id exists".
    if (!verifyJobToken(id, userId, req.get('x-job-token'))) {
      return fail(res, 404, 'not_found');
    }

    await ensureAiMediaTables();
    await ensureMediaTables();

    const claims = await pgQuery(
      `SELECT job_id, user_id, status, media_id, prompt, aspect, quality, stored
         FROM lb_ai_media_jobs WHERE job_id = $1`,
      [id]
    );
    const claim = claims[0];
    // Defence in depth: a valid tag already proves this user minted the job,
    // but the row is the record of it and the two must agree.
    if (!claim || claim.user_id !== userId) return fail(res, 404, 'not_found');

    const meta = { aspect: claim.aspect || null, quality: claim.quality || null };

    // ── terminally refused by OUR checks → answer without calling upstream ──
    // A 'dead' job cannot become good: we already looked at the bytes (or the
    // host) and refused them. Polling Higgsfield again would cost a round trip
    // per tick to re-learn the same thing.
    const claimStored = parseJsonColumn(claim.stored);

    if (claim.status === 'dead') {
      return res.json(jobPayload(id, 'failed', {
        ...meta,
        permanent: true,
        error: claimStored?.dead_reason || 'The generated asset was permanently refused.',
      }));
    }

    // ── already re-hosted → answer from OUR row, no upstream call at all ──
    if (claim.status === 'completed' && claim.media_id) {
      const media = await loadMedia(claim.media_id);
      if (media) return res.json(jobPayload(id, 'completed', { ...meta, media }));
      // The lb_media row is GONE. There is no DELETE route, so this is a manual
      // cleanup — and the claim below is written to re-take exactly this case
      // and rebuild the row from `stored`, without touching Higgsfield or
      // paying for the CDN write twice.
      console.warn('[ai-media] completed job points at a missing lb_media row — rebuilding:', id, claim.media_id);
    }

    const job = await getJob(id);
    if (!job.ok) return upstreamFail(res, job.error);

    if (job.status !== 'completed') {
      if (job.status === 'failed') {
        await pgQuery(
          `UPDATE lb_ai_media_jobs SET status = 'failed' WHERE job_id = $1 AND status NOT IN ('completed','dead')`,
          [id]
        );
        return res.json(jobPayload(id, 'failed', { ...meta, error: `Higgsfield reported "${job.raw_status}"` }));
      }
      return res.json(jobPayload(id, job.status, meta));
    }

    // ── completed upstream: the asset URL is a claim until it is checked ──
    if (!job.url || !isAllowedAssetUrl(job.url)) {
      await markDead(id, 'asset URL rejected: not a higgsfield-owned https host');
      return res.json(jobPayload(id, 'failed', {
        ...meta,
        permanent: true,
        error: 'asset URL rejected: not a higgsfield-owned https host',
      }));
    }

    // ── storage FIRST (review MED F5) ──────────────────────────────────────
    // Checked BEFORE the claim and before a single byte moves. The old order
    // pulled the asset down, then discovered there was nowhere to put it, and
    // threw it away — a wasted download per poll, every poll, for as long as
    // the backend stayed unconfigured. Nothing is claimed and nothing is
    // fetched; the job stays pending and re-hosts itself the moment a CDN
    // backend exists.
    if (!storageBackend()) {
      return fail(res, 503, 'storage_unavailable',
        'No CDN backend is configured, so the generated image cannot be stored in the library.');
    }

    // ── atomic claim: exactly one poll does the download + CDN write ───────
    // Three ways in, all decided by Postgres in ONE statement so two concurrent
    // polls cannot both win:
    //   1. pending / failed        — nobody holds it
    //   2. persisting but STALE    — the holder died (deploy, OOM, timeout).
    //                                Without this the row is stranded forever
    //                                and the operator has paid for a job they
    //                                can never collect.
    //   3. completed but its lb_media row is GONE — rebuild from `stored`.
    // 'dead' is absent on purpose: it is the one status nothing re-takes.
    const claimed = await pgQuery(
      `UPDATE lb_ai_media_jobs AS j
          SET status = 'persisting', claimed_at = NOW()
        WHERE j.job_id = $1
          AND (
                j.status IN ('pending', 'failed')
             OR (j.status = 'persisting'
                 AND (j.claimed_at IS NULL OR j.claimed_at < NOW() - ($2 || ' seconds')::interval))
             OR (j.status = 'completed'
                 AND NOT EXISTS (SELECT 1 FROM lb_media m WHERE m.id = j.media_id))
              )
        RETURNING j.job_id, j.stored, j.prompt`,
      [id, String(CLAIM_STALE_SEC)]
    );
    if (!claimed.length) {
      const again = await pgQuery(
        `SELECT status, media_id FROM lb_ai_media_jobs WHERE job_id = $1`, [id]
      );
      const now = again[0];
      if (now?.status === 'completed' && now.media_id) {
        const media = await loadMedia(now.media_id);
        if (media) return res.json(jobPayload(id, 'completed', { ...meta, media }));
      }
      // Another poll holds a FRESH claim. Report in_progress so the caller keeps
      // polling — it will get the row on the next tick.
      return res.json(jobPayload(id, 'in_progress', meta));
    }

    const held = claimed[0];
    const release = async (status) => {
      await pgQuery(
        `UPDATE lb_ai_media_jobs SET status = $2 WHERE job_id = $1 AND status = 'persisting'`,
        [id, status]
      );
    };

    const alt = String(held.prompt || claim.prompt || '').slice(0, 500);

    // ── the bytes ─────────────────────────────────────────────────────────
    // `stored` short-circuits everything below it. If a previous attempt got
    // as far as putImage and then lost the lb_media INSERT (circuit breaker,
    // timeout, deploy), those bytes are ALREADY on a CDN we were billed for.
    // Re-downloading and re-uploading them would pay twice and orphan the
    // first copy; this reads the receipt instead.
    // Prefer the receipt the CLAIM statement just returned (it is the freshest
    // read, taken inside the same UPDATE that won the claim) and fall back to
    // the one loaded above.
    const heldStored = parseJsonColumn(held.stored) || claimStored;
    let stored = heldStored && heldStored.url ? heldStored : null;

    if (!stored) {
      let asset;
      try {
        asset = await downloadAsset(job.url);
      } catch (err) {
        await release('pending');
        throw err;
      }
      if (!asset.ok) {
        const message = DOWNLOAD_MESSAGES[asset.code] || 'The generated asset was refused.';
        if (asset.terminal) {
          await markDead(id, message);
          return res.json(jobPayload(id, 'failed', { ...meta, permanent: true, error: message }));
        }
        await release('pending');
        console.error('[ai-media] transient asset download failure:', asset.code, asset.detail);
        return fail(res, 502, 'asset_download_failed',
          'The generated asset could not be downloaded — retrying.');
      }

      const dims = imageDimensions(asset.buffer, asset.mime) || {};
      const filename = sanitizeFilename(`ai-${id}`, asset.mime);

      let put;
      try {
        put = await putImage({ buffer: asset.buffer, filename, mime: asset.mime, alt });
      } catch (err) {
        await release('pending');
        if (err instanceof StorageUnavailableError) {
          return fail(res, 503, err.code || 'storage_unavailable',
            err.detail || 'The generated image could not be stored on the CDN.');
        }
        throw err;
      }

      stored = {
        url: put.url,
        file_id: put.shopifyFileId || null,
        filename: put.filename || filename,
        mime: asset.mime,
        bytes: asset.bytes,
        // OUR header parse only — media.js:250 states the reason: a null from
        // the parser is a REFUSAL, and falling back to a CDN echo of the same
        // rejected header reinstates exactly what the refusal prevents.
        width: dims.width ?? null,
        height: dims.height ?? null,
      };

      // THE RECEIPT, written before the row. This statement is the whole
      // orphan fix: from here on the bytes are findable even if every
      // subsequent statement fails.
      await pgQuery(
        `UPDATE lb_ai_media_jobs SET stored = $2::jsonb WHERE job_id = $1`,
        [id, JSON.stringify(stored)]
      );
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
          mediaId, stored.url, stored.filename, stored.mime, stored.bytes,
          stored.width ?? null, stored.height ?? null, alt,
          stored.file_id || null, userId,
        ]
      );
      inserted = rows[0];
    } catch (err) {
      // The CDN copy survives on the claim row, so the next poll re-uses it.
      await release('pending');
      throw err;
    }

    await pgQuery(
      `UPDATE lb_ai_media_jobs SET status = 'completed', media_id = $2 WHERE job_id = $1`,
      [id, mediaId]
    );

    return res.json(jobPayload(id, 'completed', { ...meta, media: mediaView(inserted) }));
  } catch (err) {
    return next(err);
  }
});

export default router;
