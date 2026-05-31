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

// Vertex AI model IDs we'll try in order. Verified live 2026-05-30:
// - gemini-2.0-flash-001 → 404 (deprecated suffix)
// - gemini-2.5-flash       → ✅ accepted
// - gemini-2.0-flash       → ✅ accepted
// - gemini-1.5-flash       → ✅ accepted (stable older fallback)
const VERTEX_MODELS = ['gemini-2.5-flash', 'gemini-2.0-flash', 'gemini-1.5-flash'];

// Inline base64 ceiling for Vertex generateContent (~20 MB request limit).
// We stay at 18 MB to leave headroom for prompt + multipart overhead.
const VERTEX_INLINE_CEILING_MB = 18;

/**
 * Upload a video buffer to a project-owned GCS bucket and return its gs:// URI
 * for use as `fileData.fileUri` in Vertex generateContent. Auto-creates the
 * bucket on first run with a 1-day lifecycle rule so old uploads don't
 * accumulate cost.
 *
 * Required IAM on the SA: roles/storage.admin (so it can create the bucket
 * AND upload to it). If only roles/storage.objectAdmin is granted, pre-create
 * the bucket manually and set VERTEX_TRANSCRIBE_BUCKET to its name.
 *
 * Returns null on any failure (caller surfaces a descriptive error).
 */
async function uploadBufferToGCS(buffer, mimeType, accessToken, projectId) {
  const bucket = process.env.VERTEX_TRANSCRIBE_BUCKET || `${projectId}-vertex-transcribe`;
  const ext = mimeType.includes('quicktime') ? 'mov' : mimeType.includes('webm') ? 'webm' : 'mp4';
  const objectName = `transcribe-${Date.now()}-${crypto.randomBytes(4).toString('hex')}.${ext}`;
  const uploadUrl = `https://storage.googleapis.com/upload/storage/v1/b/${bucket}/o?uploadType=media&name=${encodeURIComponent(objectName)}`;

  async function doUpload() {
    return fetch(uploadUrl, {
      method: 'POST',
      headers: { Authorization: `Bearer ${accessToken}`, 'Content-Type': mimeType },
      body: buffer,
      signal: AbortSignal.timeout(180_000),
    });
  }

  let res = await doUpload();
  if (res.status === 404) {
    // Bucket doesn't exist — create it then retry.
    console.log(`[transcribe] GCS bucket ${bucket} not found, creating...`);
    const createRes = await fetch(`https://storage.googleapis.com/storage/v1/b?project=${projectId}`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${accessToken}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        name: bucket,
        location: 'US',
        storageClass: 'STANDARD',
        lifecycle: { rule: [{ action: { type: 'Delete' }, condition: { age: 1 } }] },
        iamConfiguration: { uniformBucketLevelAccess: { enabled: true } },
      }),
      signal: AbortSignal.timeout(30_000),
    });
    if (!createRes.ok) {
      const t = await createRes.text();
      throw new Error(`GCS bucket create failed HTTP ${createRes.status} (grant SA roles/storage.admin on the project): ${t.slice(0, 200)}`);
    }
    console.log(`[transcribe] GCS bucket ${bucket} created`);
    res = await doUpload();
  }
  if (!res.ok) {
    const t = await res.text();
    throw new Error(`GCS upload failed HTTP ${res.status}: ${t.slice(0, 200)}`);
  }
  console.log(`[transcribe] GCS upload OK: gs://${bucket}/${objectName} (${(buffer.length / 1024 / 1024).toFixed(1)} MB)`);
  return `gs://${bucket}/${objectName}`;
}

/**
 * Diagnostic: send a video buffer to Vertex AI with a multimodal-aware prompt
 * that asks for separate audio / on-screen-text / visual-narrative breakdowns.
 * Used by the brief-pipeline /_vertextest endpoint to compare against Whisper.
 * Returns the full text response (whatever Vertex returns).
 */
export async function probeVertexMultimodal(buffer, mime) {
  const creds = getVertexCreds();
  if (!creds) throw new Error('GOOGLE_SA_JSON not configured');
  const token = await getVertexAccessToken();
  if (!token) throw new Error('Vertex OAuth token mint failed');

  const sizeMB = buffer.length / 1024 / 1024;
  let fileUri = null;
  if (sizeMB > VERTEX_INLINE_CEILING_MB) {
    fileUri = await uploadBufferToGCS(buffer, mime, token, creds.projectId);
  }

  const prompt = `You are analyzing a video advertisement to extract its ACTUAL SELLING MESSAGE, not its surface content.

This is a META video ad. Some ads have a spoken voiceover (English usually), some have only background music + on-screen text, some have both. Your job is to extract what the ad is SELLING and HOW.

Return your analysis as a JSON object with these fields:

{
  "audio_content": "Describe what's in the audio track. If it's music/song, name the genre and say 'no spoken script'. If it's a voiceover, transcribe it verbatim. If both, separate them.",
  "on_screen_text": "Graphic-design overlays only — items the editor placed on top of the footage as stand-alone graphics. KEEP: top banners ('BIGGEST Memorial Day SALE!'), sale tags ('Buy 3 Get 3 FREE — SAVE $120'), brand logos / wordmarks ('FORGESKIN'), end-card CTAs ('CLICK BELOW'), watermarks, framing panels with quoted text (a 'Reply to @user' comment-reply box, social-proof callouts, before/after labels). DROP: burned-in subtitle captions that transcribe the voiceover. Concrete pattern: if the visual stream contains short ALL-CAPS phrases broken word-by-word like a teleprompter ('EVERY' / 'SINGLE PERSON' / 'AROUND ME' / 'TOLD ME THIS WAS' / 'INSANE'), those are auto-captions — DROP THEM. Also drop any line whose words appear inside the spoken voiceover (audio_content) — even one or two such lines means subtitles, not overlays. The only exception is a complete sentence inside a clearly-framed graphic panel (e.g. a quoted comment-reply box reproducing the speaker's opening line once) — keep that single panel and drop the rest. Each retained overlay on its own line. If unsure, leave it out.",
  "visual_narrative": "Describe the visual story across the 15s. What does the viewer SEE? Product shots, people, locations, brand logos? This is the visual selling angle.",
  "brand_or_product_identified": "What product or brand is this ad selling? Look at on-screen text, logos, watermarks, end-card. If unclear, say 'unclear'.",
  "selling_message": "In one sentence: what is this ad trying to make the viewer do or feel? This is the actual ad COPY equivalent.",
  "is_music_only_ad": true/false
}

Return ONLY the JSON, no preamble, no markdown fences.`;

  const requestBody = {
    contents: [{
      role: 'user',
      parts: [
        fileUri
          ? { fileData: { mimeType: mime, fileUri } }
          : { inlineData: { mimeType: mime, data: buffer.toString('base64') } },
        { text: prompt },
      ],
    }],
    generationConfig: { maxOutputTokens: 4096, temperature: 0.1, responseMimeType: 'application/json' },
  };
  const model = VERTEX_MODELS[0];
  const url = `https://${VERTEX_LOCATION}-aiplatform.googleapis.com/v1/projects/${creds.projectId}/locations/${VERTEX_LOCATION}/publishers/google/models/${model}:generateContent`;
  const res = await fetch(url, {
    method: 'POST',
    headers: { 'Authorization': `Bearer ${token}`, 'Content-Type': 'application/json' },
    body: JSON.stringify(requestBody),
    signal: AbortSignal.timeout(GEMINI_TIMEOUT_MS),
  });
  if (!res.ok) {
    const t = await res.text();
    throw new Error(`Vertex multimodal probe HTTP ${res.status}: ${t.slice(0, 400)}`);
  }
  const data = await res.json();
  return data.candidates?.[0]?.content?.parts?.[0]?.text || '';
}

/**
 * Diagnostic: download a video URL and return the buffer + mime. Exposed so the
 * brief-pipeline /_vertextest endpoint can fetch B0248 and probe it.
 */
export async function downloadVideoForDiag(videoUrl) {
  return downloadVideo(videoUrl);
}

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

  // For files >18 MB, upload to GCS and pass gs:// URI to Vertex.
  // Vertex AI in the same project as the bucket can read it automatically.
  let fileUri = null;
  if (sizeMB > VERTEX_INLINE_CEILING_MB) {
    try {
      fileUri = await uploadBufferToGCS(buffer, mime, token, creds.projectId);
    } catch (e) {
      return { ok: false, error: `Vertex GCS path failed: ${e.message}` };
    }
  }

  const requestBody = {
    contents: [{
      role: 'user',
      parts: [
        fileUri
          ? { fileData: { mimeType: mime, fileUri } }
          : { inlineData: { mimeType: mime, data: buffer.toString('base64') } },
        { text: GEMINI_PROMPT },
      ],
    }],
    generationConfig: { maxOutputTokens: 4096, temperature: 0.1 },
  };

  let lastError = null;
  for (const model of VERTEX_MODELS) {
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
        console.log(`[transcribe] Vertex ${model} returned ${text.length} chars (via ${fileUri ? 'GCS' : 'inline'})`);
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
  const models = VERTEX_MODELS;

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
/**
 * Combine the multimodal JSON fields into a single human-readable transcript.
 * Order matters for iterate-mode: on_screen_text first (it IS the ad copy),
 * then audio_content (often supplements the visual message), then
 * selling_message (one-line summary) for context. visual_narrative is omitted
 * — it describes the scene, not the ad's copy.
 */
// Exposed for /_diag-vertex so the briefPipeline route can verify the
// dedup output without going through the full transcribe pipeline.
// To strip once the diag endpoint is removed.
export function combineMultimodalToTranscriptForDiag(analysis) {
  return combineMultimodalToTranscript(analysis);
}

function combineMultimodalToTranscript(analysis) {
  const lines = [];
  const onScreen = String(analysis?.on_screen_text || '').trim();
  const audio    = String(analysis?.audio_content || '').trim();
  const selling  = String(analysis?.selling_message || '').trim();
  const brand    = String(analysis?.brand_or_product_identified || '').trim();

  // Post-process dedup: even when the prompt instructs Vertex to exclude
  // burned-in subtitle captions, ads like Forge slip them through because
  // the designer deliberately placed them as graphics. Belt-and-suspenders
  // — for each on-screen line, drop it if its words appear inside the
  // spoken voiceover. Heuristic, not exact: normalize both sides
  // (lowercase, strip punctuation, collapse whitespace), then a line is
  // considered a "mirror caption" if its normalized form is a substring
  // of the normalized audio. Keeps banners ('BIGGEST SALE!' is not spoken
  // anywhere → kept) but drops subtitle fragments ('MY ACCOUNTANT
  // THREATENED TO QUIT' → contained in audio → dropped).
  // Multi-sentence framing panels (full comment-reply quoting the hook)
  // are preserved because they exceed the 12-word ceiling we use below to
  // distinguish a banner from a paragraph; long panels remain even if
  // they mirror the voiceover, since they're framing devices.
  const filteredOnScreen = (() => {
    if (!onScreen || !audio) return onScreen;
    const norm = (s) => String(s || '')
      .toLowerCase()
      .replace(/[^\p{L}\p{N}\s]/gu, ' ')
      .replace(/\s+/g, ' ')
      .trim();
    const normalisedAudio = norm(audio);
    const audioWordSet = new Set(normalisedAudio.split(' ').filter((w) => w.length > 2));
    // A framing panel is distinguished from a sentence subtitle by being
    // BOTH long (≥20 words) AND multi-sentence. Single long sentences
    // (typical caption line) get dropped if they mirror audio. True quote
    // panels (comment-reply boxes) survive even when their content is in
    // audio because they're a framing device, not a transcript.
    const isFramingPanel = (line) => {
      const wc = line.split(/\s+/).filter(Boolean).length;
      const sentenceCount = (line.match(/[.!?](\s|$)/g) || []).length;
      return wc >= 20 && sentenceCount >= 2;
    };
    const survivors = [];
    let droppedSubtitleCount = 0;
    for (const rawLine of onScreen.split('\n')) {
      const line = rawLine.trim();
      if (!line) continue;
      const n = norm(line);
      if (!n) continue;
      if (isFramingPanel(line)) {
        survivors.push(line);
        continue;
      }
      // Subtitle catcher #1 — single ALL-CAPS word/phrase whose words all
      // appear in the audio (teleprompter-style 'EVERY' / 'INSANE').
      if (/^[A-Z0-9\s\W]+$/.test(line) && line === line.toUpperCase()) {
        const tokens = n.split(' ').filter((w) => w.length > 2);
        if (tokens.length > 0 && tokens.every((w) => audioWordSet.has(w))) {
          droppedSubtitleCount += 1;
          continue;
        }
      }
      // Subtitle catcher #2 — normalised line appears verbatim in audio.
      if (n.split(' ').length >= 2 && normalisedAudio.includes(n)) {
        droppedSubtitleCount += 1;
        continue;
      }
      survivors.push(line);
    }
    if (droppedSubtitleCount > 0) {
      console.log(`[transcribe] dedup: dropped ${droppedSubtitleCount} subtitle line(s) from on_screen_text that mirrored audio_content`);
    }
    return survivors.join('\n').trim();
  })();

  if (filteredOnScreen) lines.push(`[ON-SCREEN TEXT]\n${filteredOnScreen}`);
  if (audio && !/no spoken|background music|music only|no audio/i.test(audio)) {
    lines.push(`[AUDIO / VOICEOVER]\n${audio}`);
  } else if (audio) {
    lines.push(`[AUDIO]\n${audio}`);
  }
  if (selling) lines.push(`[SELLING MESSAGE]\n${selling}`);
  if (brand && brand.toLowerCase() !== 'unclear') lines.push(`[BRAND]\n${brand}`);

  return lines.join('\n\n').trim();
}

/**
 * Transcribe a video URL — multimodal-first strategy.
 *
 * Strategy (in priority order):
 *   1. If Vertex AI is configured AND video fits Vertex constraints, run the
 *      multimodal probe → returns a RICH transcript with on-screen text +
 *      audio + selling message + brand identification. Best signal for
 *      iterate-mode.
 *   2. Fall through to Whisper (audio-only, ≤25 MB) — fast, cheap, covers
 *      the common "voiced ad" case if Vertex multimodal failed.
 *   3. Fall through to legacy AI Studio Gemini for any remaining case.
 *
 * Size-aware routing:
 *   - 0-18 MB: Vertex multimodal inline → Whisper → Legacy
 *   - 18-25 MB: Vertex multimodal via GCS (requires roles/storage.admin) →
 *               Whisper → Legacy
 *   - >25 MB: Vertex multimodal via GCS only (Whisper hard limit hit)
 *
 * @param {string} videoUrl Public CDN URL of the video.
 * @returns {Promise<{text: string, segments: Array}>}
 */
export async function transcribeVideoUrl(videoUrl) {
  if (!videoUrl) {
    throw new Error('transcribeVideoUrl: videoUrl is required');
  }

  const { buf, contentType } = await downloadVideo(videoUrl);
  const sizeMB = buf.length / 1024 / 1024;
  const mime = contentType.split(';')[0] || 'video/mp4';

  const errors = [];

  // ── 1. Vertex AI multimodal (PRIMARY) ──────────────────────────────────
  // Returns audio + on-screen text + selling message + brand in one call.
  // Inline for ≤18 MB; GCS upload for larger (needs roles/storage.admin).
  if (getVertexCreds()) {
    try {
      const rawJson = await probeVertexMultimodal(buf, mime);
      let analysis;
      try { analysis = JSON.parse(rawJson); } catch { analysis = null; }
      if (analysis && (analysis.on_screen_text || analysis.audio_content)) {
        const text = combineMultimodalToTranscript(analysis);
        if (text && text.length >= 10) {
          console.log(`[transcribe] Vertex multimodal: ${text.length} chars (${sizeMB.toFixed(1)} MB)`);
          return { text, segments: [], _source: 'vertex_multimodal', _analysis: analysis };
        }
        errors.push(`vertex_multimodal: combined transcript too short`);
      } else {
        errors.push(`vertex_multimodal: missing on_screen_text and audio_content fields`);
      }
    } catch (e) {
      errors.push(`vertex_multimodal: ${e.message?.slice(0, 200)}`);
      console.warn(`[transcribe] Vertex multimodal failed (${e.message?.slice(0, 100)}) — falling through`);
    }
  } else {
    errors.push('vertex_multimodal: GOOGLE_SA_JSON not configured');
  }

  // ── 2. Whisper audio-only (≤25 MB) ─────────────────────────────────────
  const openaiKey = process.env.OPENAI_API_KEY;
  if (openaiKey && buf.length <= WHISPER_MAX_BYTES) {
    const filename =
      mime.includes('mp4')       ? 'ad.mp4'  :
      mime.includes('quicktime') ? 'ad.mov'  :
      mime.includes('webm')      ? 'ad.webm' :
                                   'ad.mp4';
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
          headers: { Authorization: `Bearer ${openaiKey}` },
          body: form,
          signal: controller.signal,
        });
      } finally { clearTimeout(timer); }

      if (!res.ok) {
        const detail = await res.text().catch(() => '');
        throw new Error(`Whisper HTTP ${res.status}: ${detail.slice(0, 200)}`);
      }
      const payload = await res.json();
      const text = (payload?.text ?? '').trim();
      if (!text) throw new Error('empty transcript');
      const segments = Array.isArray(payload.segments)
        ? payload.segments.map((s) => ({
            start: Number(s.start ?? 0),
            end:   Number(s.end   ?? 0),
            text:  String(s.text  ?? '').trim(),
          })).filter((s) => s.text)
        : [];
      console.log(`[transcribe] Whisper: ${text.length} chars (${sizeMB.toFixed(1)} MB)`);
      return { text, segments, _source: 'whisper' };
    } catch (err) {
      errors.push(`whisper: ${err.message?.slice(0, 200)}`);
      console.warn(`[transcribe] Whisper failed (${err.message}) — falling through`);
    }
  } else if (!openaiKey) {
    errors.push('whisper: OPENAI_API_KEY not configured');
  } else {
    errors.push(`whisper: skipped (${sizeMB.toFixed(1)} MB > 25 MB limit)`);
  }

  // ── 3. Legacy AI Studio (last resort) ──────────────────────────────────
  try {
    const text = await transcribeBufferWithGemini(buf, mime);
    if (text && text.trim()) {
      console.log(`[transcribe] Legacy Gemini: ${text.length} chars`);
      return { text, segments: [], _source: 'legacy_gemini' };
    }
    errors.push('legacy_gemini: empty result');
  } catch (err) {
    errors.push(`legacy_gemini: ${err.message?.slice(0, 200)}`);
  }

  throw new Error(`All transcription paths failed (${sizeMB.toFixed(1)} MB video) — ${errors.join(' | ')}`);
}
