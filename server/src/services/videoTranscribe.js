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

/**
 * Transcribe a video buffer via Gemini Flash. Used when the buffer exceeds
 * Whisper's 25 MB hard limit. Returns plain text — no segment timestamps.
 * Throws if every (key × model) combination fails.
 */
async function transcribeBufferWithGemini(buffer, mime) {
  if (GEMINI_API_KEYS.length === 0) {
    throw new Error('No Gemini API keys configured (GEMINI_API_KEY*)');
  }
  const prompt = 'Transcribe ALL spoken words in this video/audio. Return ONLY the transcript as plain text — no timestamps, no speaker labels, no commentary, no formatting. Preserve natural paragraph breaks. If there are multiple speakers, separate their lines with paragraph breaks.';
  const sizeMB = buffer.length / 1024 / 1024;
  const models = ['gemini-2.0-flash-001', 'gemini-2.5-flash', 'gemini-2.0-flash'];

  let lastError = null;
  for (const apiKey of GEMINI_API_KEYS) {
    // Always upload to File API for >15 MB — inline base64 is unreliable above that.
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
          { text: prompt },
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
        if (text.length >= 10) return text;
        lastError = `${model}: empty transcript`;
      } catch (err) {
        lastError = `${model}: ${err.message}`;
      }
    }
  }
  throw new Error(`Gemini transcription failed: ${lastError || 'unknown'}`);
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

  const form = new FormData();
  form.append('file', new Blob([buf], { type: contentType }), filename);
  form.append('model', WHISPER_MODEL);
  // verbose_json gives us segment-level timestamps so the UI can render a
  // timestamped script (00:00 lead-in, 00:05 next line, …) like the Atria
  // reference, rather than a single wall of text.
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
  } catch (err) {
    if (err.name === 'AbortError') {
      throw new Error(`Whisper API timed out after ${WHISPER_TIMEOUT_MS / 1000}s`);
    }
    throw new Error(`Whisper API request failed: ${err.message}`);
  } finally {
    clearTimeout(timer);
  }

  if (!res.ok) {
    const detail = await res.text().catch(() => '');
    throw new Error(`Whisper API HTTP ${res.status}: ${detail.slice(0, 300)}`);
  }

  // verbose_json returns { text, segments: [{ id, start, end, text, ... }] }
  const payload = await res.json();
  const text = (payload?.text ?? '').trim();
  if (!text) {
    throw new Error('Whisper returned an empty transcript');
  }
  // Keep only the fields the UI needs — start/end are seconds (float).
  const segments = Array.isArray(payload.segments)
    ? payload.segments.map((s) => ({
        start: Number(s.start ?? 0),
        end:   Number(s.end   ?? 0),
        text:  String(s.text  ?? '').trim(),
      })).filter((s) => s.text)
    : [];
  return { text, segments };
}
