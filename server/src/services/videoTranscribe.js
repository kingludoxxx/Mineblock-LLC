/**
 * videoTranscribe — download a video URL, send to OpenAI Whisper, return text.
 *
 * Used by the Brand Spy IntelDrawer "Transcribe" button. Result is cached in
 * brand_spy.ads.transcript so each ad is only transcribed once.
 *
 * For files >25 MB (Whisper's hard limit) we transparently fall through to
 * Gemini Flash via its File API (which handles up to ~2 GB). The Gemini path
 * returns plain text only — no segment timestamps — so the caller gets
 * { text, segments: [] } in that case. The UI degrades gracefully.
 *
 * Node 22 globals used: fetch, FormData, Blob. No additional npm dep needed.
 */

import crypto from 'node:crypto';

const WHISPER_URL = 'https://api.openai.com/v1/audio/transcriptions';
const WHISPER_MODEL = 'whisper-1';
const WHISPER_MAX_BYTES = 25 * 1024 * 1024; // OpenAI hard limit
const VIDEO_FETCH_TIMEOUT_MS = 30_000;
const WHISPER_TIMEOUT_MS = 120_000;
const GEMINI_TIMEOUT_MS = 180_000;

const GEMINI_API_KEYS = [
  process.env.GEMINI_API_KEY,
  process.env.GEMINI_API_KEY_2,
  process.env.GEMINI_API_KEY_3,
].filter(Boolean);

// ── Vertex AI auth via service account JSON ──────────────────────────────
// Org policies on AI-Studio-created projects now force keys to be bound to
// service accounts. The legacy generativelanguage.googleapis.com endpoint
// rejects SA-bound keys with "API key expired", so we hit Vertex AI's
// aiplatform.googleapis.com endpoint instead — it's designed for SA auth.
//
// GOOGLE_SA_JSON env var holds the full service-account JSON (from
// Cloud Console → IAM → Service Accounts → Keys → Add Key → JSON).
//
// We mint our own OAuth access tokens from the SA private key using Node's
// built-in crypto, avoiding the google-auth-library dependency. Standard
// JWT-bearer flow per RFC 7523.
let _vertexCreds = null;
function getVertexCreds() {
  if (_vertexCreds !== null) return _vertexCreds;
  const raw = process.env.GOOGLE_SA_JSON;
  if (!raw) { _vertexCreds = false; return _vertexCreds; }
  try {
    const json = JSON.parse(raw);
    if (!json.client_email || !json.private_key || !json.project_id) {
      console.warn('[transcribe] GOOGLE_SA_JSON missing client_email/private_key/project_id');
      _vertexCreds = false;
      return _vertexCreds;
    }
    _vertexCreds = {
      clientEmail: json.client_email,
      privateKey: json.private_key,
      projectId: json.project_id,
      // Cache token in-process; OAuth tokens last 1h, we re-mint when ≤60s remain.
      cachedToken: null,
      cachedExp: 0,
    };
    console.log(`[transcribe] Vertex AI configured (project=${json.project_id}, sa=${json.client_email})`);
    return _vertexCreds;
  } catch (e) {
    console.warn('[transcribe] GOOGLE_SA_JSON failed to parse:', e.message);
    _vertexCreds = false;
    return _vertexCreds;
  }
}

function base64url(input) {
  return Buffer.from(input).toString('base64')
    .replace(/=/g, '').replace(/\+/g, '-').replace(/\//g, '_');
}

/**
 * Mint a Google OAuth access token from the service account JSON using
 * JWT-bearer flow. Cached for ~55 minutes (tokens live 60). Returns null
 * if SA isn't configured or token exchange fails.
 */
async function getVertexAccessToken() {
  const creds = getVertexCreds();
  if (!creds) return null;
  const now = Math.floor(Date.now() / 1000);
  if (creds.cachedToken && creds.cachedExp - 60 > now) return creds.cachedToken;

  const header = base64url(JSON.stringify({ alg: 'RS256', typ: 'JWT' }));
  const claims = base64url(JSON.stringify({
    iss: creds.clientEmail,
    scope: 'https://www.googleapis.com/auth/cloud-platform',
    aud: 'https://oauth2.googleapis.com/token',
    iat: now,
    exp: now + 3600,
  }));
  const unsigned = `${header}.${claims}`;
  const signer = crypto.createSign('RSA-SHA256');
  signer.update(unsigned);
  signer.end();
  const signature = signer.sign(creds.privateKey).toString('base64')
    .replace(/=/g, '').replace(/\+/g, '-').replace(/\//g, '_');
  const jwt = `${unsigned}.${signature}`;

  try {
    const res = await fetch('https://oauth2.googleapis.com/token', {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        grant_type: 'urn:ietf:params:oauth:grant-type:jwt-bearer',
        assertion: jwt,
      }),
      signal: AbortSignal.timeout(15_000),
    });
    if (!res.ok) {
      const t = await res.text();
      console.warn(`[transcribe] Vertex token exchange failed HTTP ${res.status}: ${t.slice(0, 300)}`);
      return null;
    }
    const data = await res.json();
    if (!data.access_token) return null;
    creds.cachedToken = data.access_token;
    creds.cachedExp = now + (data.expires_in || 3600);
    return creds.cachedToken;
  } catch (e) {
    console.warn(`[transcribe] Vertex token exchange threw: ${e.message}`);
    return null;
  }
}

const VERTEX_LOCATION = process.env.VERTEX_AI_LOCATION || 'us-central1';

/**
 * Download a remote video into memory. NEVER throws on size — the caller
 * decides whether Whisper or Gemini handles the buffer.
 */
async function downloadVideo(videoUrl) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), VIDEO_FETCH_TIMEOUT_MS);
  let res;
  try {
    res = await fetch(videoUrl, {
      signal: controller.signal,
      headers: { 'User-Agent': 'Mozilla/5.0 (compatible; MineblockBot/1.0)' },
      redirect: 'follow',
    });
  } catch (err) {
    if (err.name === 'AbortError') {
      throw new Error(`Video download timed out after ${VIDEO_FETCH_TIMEOUT_MS / 1000}s`);
    }
    throw new Error(`Video download failed: ${err.message}`);
  } finally {
    clearTimeout(timer);
  }

  if (!res.ok) {
    throw new Error(`Video download returned HTTP ${res.status} ${res.statusText}`);
  }

  const buf = Buffer.from(await res.arrayBuffer());
  const contentType = res.headers.get('content-type') || 'video/mp4';
  return { buf, contentType };
}

/**
 * Upload a buffer to Gemini's File API and return its file URI.
 * Returns null on any failure (the caller falls through to the next attempt).
 */
async function uploadToGeminiFileApi(buffer, mimeType, apiKey) {
  try {
    const startRes = await fetch(
      `https://generativelanguage.googleapis.com/upload/v1beta/files?key=${apiKey}`,
      {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'X-Goog-Upload-Protocol': 'resumable',
          'X-Goog-Upload-Command': 'start',
          'X-Goog-Upload-Header-Content-Length': buffer.length.toString(),
          'X-Goog-Upload-Header-Content-Type': mimeType,
        },
        body: JSON.stringify({ file: { displayName: 'transcribe-video' } }),
        signal: AbortSignal.timeout(30_000),
      },
    );
    const uploadUrl = startRes.headers.get('x-goog-upload-url');
    if (!uploadUrl) return null;

    const uploadRes = await fetch(uploadUrl, {
      method: 'PUT',
      headers: {
        'Content-Length': buffer.length.toString(),
        'X-Goog-Upload-Offset': '0',
        'X-Goog-Upload-Command': 'upload, finalize',
      },
      body: buffer,
      signal: AbortSignal.timeout(120_000),
    });
    const uploadData = await uploadRes.json();
    const fileUri = uploadData?.file?.uri;
    let state = uploadData?.file?.state;
    if (!fileUri) return null;
    if (state === 'ACTIVE') return fileUri;

    // Poll for ACTIVE for up to ~60s.
    const fileName = uploadData.file.name;
    for (let i = 0; i < 12; i++) {
      await new Promise((r) => setTimeout(r, 5_000));
      const checkRes = await fetch(
        `https://generativelanguage.googleapis.com/v1beta/${fileName}?key=${apiKey}`,
      );
      const checkData = await checkRes.json();
      if (checkData.state === 'ACTIVE') return checkData.uri || fileUri;
      if (checkData.state === 'FAILED') return null;
    }
    return null;
  } catch {
    return null;
  }
}

const GEMINI_PROMPT = 'Transcribe ALL spoken words in this video/audio. Return ONLY the transcript as plain text — no timestamps, no speaker labels, no commentary, no formatting. Preserve natural paragraph breaks. If there are multiple speakers, separate their lines with paragraph breaks.';

/**
 * Vertex AI path — uses the service-account JSON in GOOGLE_SA_JSON.
 * This is the preferred path because AI-Studio-created projects now bind
 * keys to service accounts, breaking the legacy endpoint. Returns
 * { ok: true, text } on success, { ok: false, error } on failure (so the
 * caller can decide whether to fall through to the legacy path).
 *
 * Only the inline path is implemented for Vertex. For files >15 MB we'd
 * need a GCS bucket upload — not worth the complexity until needed.
 */
async function transcribeBufferWithVertex(buffer, mime) {
  const creds = getVertexCreds();
  if (!creds) return { ok: false, error: 'GOOGLE_SA_JSON not configured' };

  const token = await getVertexAccessToken();
  if (!token) return { ok: false, error: 'Vertex OAuth token mint failed' };

  const sizeMB = buffer.length / 1024 / 1024;
  if (sizeMB > 18) {
    return { ok: false, error: `Vertex inline path skipped (${sizeMB.toFixed(1)} MB > 18 MB ceiling); GCS upload not implemented` };
  }

  const requestBody = {
    contents: [{
      role: 'user',
      parts: [
        { inlineData: { mimeType: mime, data: buffer.toString('base64') } },
        { text: GEMINI_PROMPT },
      ],
    }],
    generationConfig: { maxOutputTokens: 4096, temperature: 0.1 },
  };
  const models = ['gemini-2.0-flash-001', 'gemini-2.5-flash', 'gemini-2.0-flash'];
  let lastError = null;
  for (const model of models) {
    try {
      const url = `https://${VERTEX_LOCATION}-aiplatform.googleapis.com/v1/projects/${creds.projectId}/locations/${VERTEX_LOCATION}/publishers/google/models/${model}:generateContent`;
      const res = await fetch(url, {
        method: 'POST',
        headers: {
          'Authorization': `Bearer ${token}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify(requestBody),
        signal: AbortSignal.timeout(GEMINI_TIMEOUT_MS),
      });
      if (res.status === 429) { lastError = `${model}: 429`; continue; }
      if (res.status === 404) { lastError = `${model}: 404 (model unavailable in ${VERTEX_LOCATION})`; continue; }
      if (!res.ok) {
        const t = await res.text();
        lastError = `${model}: HTTP ${res.status} — ${t.slice(0, 200)}`;
        continue;
      }
      const data = await res.json();
      const text = (data.candidates?.[0]?.content?.parts?.[0]?.text || '').trim();
      if (text.length >= 10) {
        console.log(`[transcribe] Vertex ${model} returned ${text.length} chars`);
        return { ok: true, text };
      }
      lastError = `${model}: empty transcript`;
    } catch (err) {
      lastError = `${model}: ${err.message}`;
    }
  }
  return { ok: false, error: lastError || 'unknown Vertex failure' };
}

/**
 * Legacy AI Studio path — uses GEMINI_API_KEY*. Kept as a fallback because
 * it still works for projects where the org policy doesn't enforce SA
 * binding (e.g. our original key that successfully transcribed B0248).
 */
async function transcribeBufferWithLegacyAiStudio(buffer, mime) {
  if (GEMINI_API_KEYS.length === 0) {
    return { ok: false, error: 'No Gemini API keys configured (GEMINI_API_KEY*)' };
  }
  const sizeMB = buffer.length / 1024 / 1024;
  const models = ['gemini-2.0-flash-001', 'gemini-2.5-flash', 'gemini-2.0-flash'];

  let lastError = null;
  for (const apiKey of GEMINI_API_KEYS) {
    let fileUri = null;
    if (sizeMB > 15) {
      fileUri = await uploadToGeminiFileApi(buffer, mime, apiKey);
      if (!fileUri) {
        lastError = 'Gemini File API upload failed';
        continue;
      }
    }
    const requestBody = {
      contents: [{
        parts: [
          fileUri
            ? { fileData: { mimeType: mime, fileUri } }
            : { inlineData: { mimeType: mime, data: buffer.toString('base64') } },
          { text: GEMINI_PROMPT },
        ],
      }],
      generationConfig: { maxOutputTokens: 4096, temperature: 0.1 },
    };
    for (const model of models) {
      try {
        const res = await fetch(
          `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${apiKey}`,
          {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(requestBody),
            signal: AbortSignal.timeout(GEMINI_TIMEOUT_MS),
          },
        );
        if (res.status === 429) { lastError = `${model}: 429`; continue; }
        if (res.status === 404) { lastError = `${model}: 404`; break; }
        if (!res.ok) {
          const t = await res.text();
          lastError = `${model}: HTTP ${res.status} — ${t.slice(0, 200)}`;
          continue;
        }
        const data = await res.json();
        const text = (data.candidates?.[0]?.content?.parts?.[0]?.text || '').trim();
        if (text.length >= 10) return { ok: true, text };
        lastError = `${model}: empty transcript`;
      } catch (err) {
        lastError = `${model}: ${err.message}`;
      }
    }
  }
  return { ok: false, error: lastError || 'unknown legacy failure' };
}

/**
 * Orchestrator — try Vertex first (preferred for SA-bound projects),
 * fall through to legacy AI Studio if Vertex isn't configured or fails.
 * Throws only if BOTH paths fail.
 */
async function transcribeBufferWithGemini(buffer, mime) {
  const vertex = await transcribeBufferWithVertex(buffer, mime);
  if (vertex.ok) return vertex.text;

  const legacy = await transcribeBufferWithLegacyAiStudio(buffer, mime);
  if (legacy.ok) return legacy.text;

  throw new Error(`Gemini transcription failed — Vertex: ${vertex.error}; Legacy: ${legacy.error}`);
}

/**
 * Transcribe a video URL via OpenAI Whisper, falling back to Gemini for any
 * file too big for Whisper's 25 MB limit.
 * @param {string} videoUrl Public CDN URL of the video.
 * @returns {Promise<{text: string, segments: Array}>}
 */
export async function transcribeVideoUrl(videoUrl) {
  if (!videoUrl) {
    throw new Error('transcribeVideoUrl: videoUrl is required');
  }
  const apiKey = process.env.OPENAI_API_KEY;
  if (!apiKey) {
    throw new Error('OPENAI_API_KEY is not configured on this server');
  }

  const { buf, contentType } = await downloadVideo(videoUrl);
  const sizeMB = buf.length / 1024 / 1024;

  // ── Gemini fallback path for >25 MB ───────────────────────────────────
  // Whisper's hard limit is 25 MB. Instead of erroring, route oversized
  // files to Gemini Flash via its File API. Loses segment timestamps but
  // the transcript is still cached and downstream analysis is unaffected.
  if (buf.length > WHISPER_MAX_BYTES) {
    const mime = contentType.split(';')[0] || 'video/mp4';
    try {
      const text = await transcribeBufferWithGemini(buf, mime);
      return { text, segments: [] };
    } catch (geminiErr) {
      throw new Error(
        `Video is ${sizeMB.toFixed(1)} MB (Whisper's limit is 25 MB) and the Gemini fallback failed: ${geminiErr.message}`,
      );
    }
  }

  // Whisper accepts video files (mp4, mov, etc.) — it strips audio itself.
  const filename =
    contentType.includes('mp4')   ? 'ad.mp4'  :
    contentType.includes('quicktime') ? 'ad.mov'  :
    contentType.includes('webm')  ? 'ad.webm' :
                                    'ad.mp4';

  // Try Whisper first. On any failure (HTTP error, empty result, timeout),
  // fall through to Gemini. Many FB ads are silent / GIF-with-no-audio /
  // music-only — Whisper returns empty, but Gemini can read the visuals.
  let whisperResult = null;
  let whisperError = null;
  try {
    const form = new FormData();
    form.append('file', new Blob([buf], { type: contentType }), filename);
    form.append('model', WHISPER_MODEL);
    form.append('response_format', 'verbose_json');

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), WHISPER_TIMEOUT_MS);
    let res;
    try {
      res = await fetch(WHISPER_URL, {
        method: 'POST',
        headers: { Authorization: `Bearer ${apiKey}` },
        body: form,
        signal: controller.signal,
      });
    } finally {
      clearTimeout(timer);
    }

    if (!res.ok) {
      const detail = await res.text().catch(() => '');
      throw new Error(`Whisper HTTP ${res.status}: ${detail.slice(0, 200)}`);
    }
    const payload = await res.json();
    const text = (payload?.text ?? '').trim();
    if (!text) {
      throw new Error('empty transcript');
    }
    const segments = Array.isArray(payload.segments)
      ? payload.segments.map((s) => ({
          start: Number(s.start ?? 0),
          end:   Number(s.end   ?? 0),
          text:  String(s.text  ?? '').trim(),
        })).filter((s) => s.text)
      : [];
    whisperResult = { text, segments };
  } catch (err) {
    whisperError = err.message || String(err);
    console.warn(`[transcribe] Whisper failed (${whisperError}) — falling through to Gemini`);
  }

  if (whisperResult) return whisperResult;

  // Gemini fallback (works for silent videos / music-only / unrecognized audio
  // — Gemini reads the visuals + any OCR'd text + caption track).
  const mime = contentType.split(';')[0] || 'video/mp4';
  try {
    const text = await transcribeBufferWithGemini(buf, mime);
    if (!text || !text.trim()) {
      throw new Error(`Gemini also returned empty (after Whisper: ${whisperError || 'unknown'})`);
    }
    return { text, segments: [] };
  } catch (geminiErr) {
    throw new Error(`Both transcribers failed — Whisper: ${whisperError}; Gemini: ${geminiErr.message}`);
  }
}
