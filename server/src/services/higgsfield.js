// HIGGSFIELD — minimal platform-API client for the AI Developer feature.
//
// Docs (docs.higgsfield.ai → "How to use API"):
//   Base URL  https://platform.higgsfield.ai
//   Auth      Authorization: Key {HIGGSFIELD_API_KEY}:{HIGGSFIELD_API_SECRET}
//   Submit    POST /{model_id}  → JSON body {prompt, aspect_ratio, ...}
//   Status    GET  /requests/{request_id}/status
//             → { status: queued|in_progress|completed|failed|nsfw,
//                 images: [{url}], video: {url} }
//
// FAIL-CLOSED CONTRACT: no function in this module ever throws into a
// caller. Every call returns { ok: true, ... } or { ok: false, error }.
// Credentials are read ONLY from process.env and only ever sent in the
// Authorization HEADER — never in a URL, never logged.

const BASE_URL = process.env.HIGGSFIELD_BASE_URL || 'https://platform.higgsfield.ai';
const TIMEOUT_MS = 20_000;

// Model ids (documented examples). Overridable via env without a deploy.
const IMAGE_MODEL = process.env.HIGGSFIELD_IMAGE_MODEL || 'higgsfield-ai/soul/standard';
const VIDEO_MODEL = process.env.HIGGSFIELD_VIDEO_MODEL || 'higgsfield-ai/dop/standard';

// Hosts an asset URL may live on before we hand it to the client. The
// route refuses anything else (spec: https + higgsfield-owned hosts only).
// Extendable via env (comma-separated) if their CDN host differs.
const DEFAULT_ASSET_HOSTS = ['higgsfield.ai', 'higgsfield.com'];

export function isAllowedAssetUrl(rawUrl) {
  if (typeof rawUrl !== 'string' || !rawUrl) return false;
  let u;
  try {
    u = new URL(rawUrl);
  } catch {
    return false;
  }
  if (u.protocol !== 'https:') return false;
  const extra = (process.env.HIGGSFIELD_ASSET_HOSTS || '')
    .split(',')
    .map((h) => h.trim().toLowerCase())
    .filter(Boolean);
  const allowed = [...DEFAULT_ASSET_HOSTS, ...extra];
  const host = u.hostname.toLowerCase();
  return allowed.some((a) => host === a || host.endsWith(`.${a}`));
}

function credentials() {
  const key = process.env.HIGGSFIELD_API_KEY;
  const secret = process.env.HIGGSFIELD_API_SECRET;
  if (!key || !secret) return null;
  return `Key ${key}:${secret}`;
}

// One guarded fetch. Returns {ok:true, status, body} or {ok:false, error}.
async function call(method, path, jsonBody) {
  const auth = credentials();
  if (!auth) {
    return { ok: false, error: 'Higgsfield credentials are not configured (HIGGSFIELD_API_KEY / HIGGSFIELD_API_SECRET)' };
  }
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);
  try {
    const res = await fetch(`${BASE_URL}${path}`, {
      method,
      headers: {
        Authorization: auth,
        'Content-Type': 'application/json',
        Accept: 'application/json',
      },
      body: jsonBody === undefined ? undefined : JSON.stringify(jsonBody),
      signal: controller.signal,
    });
    let body = null;
    try {
      body = await res.json();
    } catch {
      // Non-JSON body — keep null; the status code still tells the story.
    }
    if (!res.ok) {
      // Never echo the request URL or headers — status + short detail only.
      const detail = body && typeof body === 'object'
        ? String(body.error || body.message || body.detail || '').slice(0, 200)
        : '';
      return { ok: false, error: `Higgsfield API ${res.status}${detail ? `: ${detail}` : ''}` };
    }
    return { ok: true, status: res.status, body };
  } catch (err) {
    const reason = err?.name === 'AbortError' ? 'request timed out' : (err?.message || 'network error');
    return { ok: false, error: `Higgsfield request failed: ${reason}` };
  } finally {
    clearTimeout(timer);
  }
}

// Pull a request id out of whatever shape the submit endpoint returns.
function extractRequestId(body) {
  if (!body || typeof body !== 'object') return null;
  const candidates = [body.request_id, body.requestId, body.id, body.job_id, body.jobId];
  for (const c of candidates) {
    if (typeof c === 'string' && /^[A-Za-z0-9_-]{4,128}$/.test(c)) return c;
  }
  return null;
}

// POST a generation job. Returns {ok:true, id} or {ok:false, error}.
export async function createImageJob({ prompt, aspect_ratio } = {}) {
  const p = typeof prompt === 'string' ? prompt.trim().slice(0, 4000) : '';
  if (!p) return { ok: false, error: 'image prompt is required' };
  const payload = { prompt: p };
  if (typeof aspect_ratio === 'string' && /^\d{1,2}:\d{1,2}$/.test(aspect_ratio)) {
    payload.aspect_ratio = aspect_ratio;
  }
  const res = await call('POST', `/${IMAGE_MODEL}`, payload);
  if (!res.ok) return res;
  const id = extractRequestId(res.body);
  if (!id) return { ok: false, error: 'Higgsfield accepted the job but returned no request id' };
  return { ok: true, id, kind: 'image' };
}

export async function createVideoJob({ prompt, image_url, duration } = {}) {
  const p = typeof prompt === 'string' ? prompt.trim().slice(0, 4000) : '';
  if (!p) return { ok: false, error: 'video prompt is required' };
  const payload = { prompt: p };
  // Image-to-video source must itself be an allowed https asset — never
  // forward an arbitrary URL from model output into their API.
  if (typeof image_url === 'string' && isAllowedAssetUrl(image_url)) {
    payload.image_url = image_url;
  }
  const d = Number(duration);
  if (Number.isInteger(d) && d >= 1 && d <= 15) payload.duration = d;
  const res = await call('POST', `/${VIDEO_MODEL}`, payload);
  if (!res.ok) return res;
  const id = extractRequestId(res.body);
  if (!id) return { ok: false, error: 'Higgsfield accepted the job but returned no request id' };
  return { ok: true, id, kind: 'video' };
}

// Poll a job. Returns {ok:true, id, status, url|null, raw_status} or {ok:false, error}.
// `status` is normalized to: queued | in_progress | completed | failed.
export async function getJob(id) {
  if (typeof id !== 'string' || !/^[A-Za-z0-9_-]{4,128}$/.test(id)) {
    return { ok: false, error: 'invalid job id' };
  }
  const res = await call('GET', `/requests/${id}/status`);
  if (!res.ok) return res;
  const body = res.body || {};
  const raw = typeof body.status === 'string' ? body.status : 'unknown';
  let status;
  if (raw === 'completed') status = 'completed';
  else if (raw === 'queued') status = 'queued';
  else if (raw === 'in_progress') status = 'in_progress';
  else status = 'failed'; // failed | nsfw | unknown → terminal failure
  let url = null;
  if (status === 'completed') {
    const fromImages = Array.isArray(body.images) && body.images[0] && typeof body.images[0].url === 'string'
      ? body.images[0].url : null;
    const fromVideo = body.video && typeof body.video.url === 'string' ? body.video.url : null;
    url = fromImages || fromVideo || (typeof body.url === 'string' ? body.url : null);
  }
  return { ok: true, id, status, raw_status: raw, url };
}

export default { createImageJob, createVideoJob, getJob, isAllowedAssetUrl };
