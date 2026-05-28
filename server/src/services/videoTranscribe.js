/**
 * videoTranscribe — download a video URL, send to OpenAI Whisper, return text.
 *
 * Used by the Brand Spy IntelDrawer "Transcribe" button. Result is cached in
 * brand_spy.ads.transcript so each ad is only transcribed once.
 *
 * Node 22 globals used: fetch, FormData, Blob. No additional npm dep needed.
 */

const WHISPER_URL = 'https://api.openai.com/v1/audio/transcriptions';
const WHISPER_MODEL = 'whisper-1';
const WHISPER_MAX_BYTES = 25 * 1024 * 1024; // OpenAI hard limit
const VIDEO_FETCH_TIMEOUT_MS = 30_000;
const WHISPER_TIMEOUT_MS = 120_000;

/**
 * Download a remote video into memory.
 * Throws if response is not OK, exceeds Whisper's 25 MB limit, or times out.
 */
async function downloadVideo(videoUrl) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), VIDEO_FETCH_TIMEOUT_MS);
  let res;
  try {
    res = await fetch(videoUrl, { signal: controller.signal });
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

  // Content-length is a hint, not a guarantee — re-check after read.
  const lenHeader = Number(res.headers.get('content-length') ?? 0);
  if (lenHeader > WHISPER_MAX_BYTES) {
    throw new Error(
      `Video is ${(lenHeader / 1024 / 1024).toFixed(1)} MB which exceeds Whisper's 25 MB limit`,
    );
  }

  const buf = Buffer.from(await res.arrayBuffer());
  if (buf.length > WHISPER_MAX_BYTES) {
    throw new Error(
      `Video is ${(buf.length / 1024 / 1024).toFixed(1)} MB which exceeds Whisper's 25 MB limit`,
    );
  }

  // Best-effort content type — Whisper inspects file content too.
  const contentType = res.headers.get('content-type') || 'video/mp4';
  return { buf, contentType };
}

/**
 * Transcribe a video URL via OpenAI Whisper.
 * @param {string} videoUrl Public CDN URL of the video.
 * @returns {Promise<string>} Plain-text transcript.
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
