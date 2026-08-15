/**
 * Transparent product cutouts.
 *
 * WHY: the renderer currently redraws the product from a reference photo every
 * time. It is good at the hero shot and bad everywhere else — a cross-section
 * diagram came back with "a plain smooth white oval/puck with no visible ports,
 * buttons, cord, or the pink silicone pad" standing in for the real device. No
 * amount of prompting fixes redrawing; a designer does not redraw the product,
 * they place the asset.
 *
 * A cutout is the asset. Once we have one, the product on a card is the product,
 * pixel for pixel, and product fidelity stops being something we audit for and
 * becomes something that is true by construction.
 *
 * The cutout is generated once per product image and cached — it is an input to
 * every future card, so it is worth verifying carefully and never regenerating
 * casually.
 */
import sharp from 'sharp';
import { randomUUID } from 'crypto';
import { uploadBuffer } from './r2.js';

const OPENAI_BASE = 'https://api.openai.com/v1';
// NOT OPENAI_IMAGE_MODEL. gpt-image-2 answers background=transparent with a
// 400 ("Transparent background is not supported for this model"), so the
// generative fallback pins gpt-image-1, which does support it.
const CUTOUT_MODEL = process.env.OPENAI_CUTOUT_MODEL || 'gpt-image-1';

const UA = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/140.0 Safari/537.36';

const CUTOUT_PROMPT = `Isolate the product from its background.

- Keep the product EXACTLY as it is: identical shape, colour, parts, proportions,
  materials, logos, buttons, ports and cables. This is a masking job, not a
  redraw. Do not restyle, relight, straighten, recolour or "clean up" anything.
- Include EVERY part shown, including cables and any separate remote or
  controller, in their existing relative positions.
- Remove the entire background and any surface, shadow or reflection cast onto
  that surface. The area around the product must be fully transparent.
- Keep the product's own self-shadowing and highlights that sit ON the product.
- Do not add a new shadow, glow, outline, border, watermark or text.`;

async function fetchBuffer(url, timeoutMs = 60000) {
  if (url.startsWith('data:')) {
    const m = /^data:(image\/[^;]+);base64,(.+)$/is.exec(url);
    if (!m) throw new Error('malformed data: URI');
    return Buffer.from(m[2], 'base64');
  }
  const r = await fetch(url, { headers: { 'User-Agent': UA }, signal: AbortSignal.timeout(timeoutMs) });
  if (!r.ok) throw new Error(`fetch ${r.status}`);
  return Buffer.from(await r.arrayBuffer());
}

/**
 * Measure how much of an image is actually transparent, and how much of the
 * frame the opaque subject occupies.
 *
 * This is the verification that matters: an image can come back as a PNG "with
 * an alpha channel" and be fully opaque, which would silently give us a cutout
 * that is really just the original photo with its background baked in. Asking
 * for transparency is not evidence of transparency.
 */
export async function measureTransparency(buffer) {
  const img = sharp(buffer).ensureAlpha();
  const { width, height } = await img.metadata();
  const { data, info } = await img.raw().toBuffer({ resolveWithObject: true });
  const px = info.width * info.height;
  const ch = info.channels;

  let transparent = 0;
  let minX = info.width, minY = info.height, maxX = -1, maxY = -1;
  for (let i = 0, p = 0; i < data.length; i += ch, p++) {
    const a = data[i + ch - 1];
    if (a < 16) { transparent++; continue; }
    const x = p % info.width, y = (p / info.width) | 0;
    if (x < minX) minX = x;
    if (x > maxX) maxX = x;
    if (y < minY) minY = y;
    if (y > maxY) maxY = y;
  }

  const cornerAlpha = (x, y) => data[((y * info.width) + x) * ch + ch - 1];
  const corners = [
    cornerAlpha(0, 0), cornerAlpha(info.width - 1, 0),
    cornerAlpha(0, info.height - 1), cornerAlpha(info.width - 1, info.height - 1),
  ];

  return {
    width, height,
    transparentRatio: transparent / px,
    subjectRatio: 1 - (transparent / px),
    bbox: maxX < 0 ? null : { x: minX, y: minY, w: maxX - minX + 1, h: maxY - minY + 1 },
    cornersTransparent: corners.every(a => a < 16),
    corners,
  };
}

/**
 * Judge a candidate cutout. Returns { ok, problems[], stats }.
 *
 * Thresholds are deliberately loose on the low end — a product that genuinely
 * fills its frame is legitimate — but the corners MUST be transparent, because
 * an opaque corner means the background survived.
 */
export function assessCutout(stats) {
  const problems = [];
  if (!stats.cornersTransparent) {
    problems.push(`background survived — corner alphas ${stats.corners.join(',')}`);
  }
  if (stats.transparentRatio < 0.05) {
    problems.push(`only ${(stats.transparentRatio * 100).toFixed(1)}% transparent — this is not a cutout`);
  }
  if (stats.subjectRatio < 0.02) {
    problems.push(`subject occupies ${(stats.subjectRatio * 100).toFixed(1)}% — nearly empty`);
  }
  if (!stats.bbox) problems.push('no opaque pixels at all');
  return { ok: problems.length === 0, problems, stats };
}

/**
 * Trim fully-transparent margins so the asset's bounding box IS the product.
 * Compositing maths depends on this: without it, "place the product at 40% of
 * the canvas" silently means "place the product AND its empty padding".
 */
export async function trimToSubject(buffer) {
  return sharp(buffer).ensureAlpha().trim({ threshold: 1 }).png().toBuffer();
}

/**
 * Generate a transparent cutout for one product image.
 *
 * Resolves to { ok, url, stats, problems, error } and never throws — a failed
 * cutout must degrade to "keep redrawing" rather than break generation.
 */
export async function generateCutout(sourceImageUrl, { persist = true, keyPrefix = 'product-cutouts', force = false } = {}) {
  // ── Is the source ALREADY a cutout? ──────────────────────────────────────
  // Both of Puure's product images turned out to be transparent PNGs at 64%
  // and 74% clear. Generating a "cutout" from an existing cutout spends money
  // to hand a generative model the one job it is worst at — reproducing the
  // product — when the asset we want is already the input. Always look first.
  let sourceBuf = null;
  try {
    sourceBuf = await fetchBuffer(sourceImageUrl);
    if (!force) {
      const srcStats = await measureTransparency(sourceBuf);
      const srcVerdict = assessCutout(srcStats);
      if (srcVerdict.ok) {
        const trimmed = await trimToSubject(sourceBuf);
        const stats = { ...srcStats, trimmed: await measureTransparency(trimmed) };
        let url = sourceImageUrl;
        if (persist) {
          try {
            url = await uploadBuffer(trimmed, `${keyPrefix}/${randomUUID()}.png`, 'image/png');
          } catch (err) {
            return { ok: false, url: null, stats, problems: [], error: `upload failed: ${err.message}` };
          }
        }
        console.log(`[cutout] source already transparent (${(srcStats.transparentRatio * 100).toFixed(1)}%) — trimmed, no generation`);
        return { ok: true, url, stats, problems: [], error: null, source: 'existing', buffer: persist ? null : trimmed };
      }
    }
  } catch (err) {
    console.warn(`[cutout] could not inspect source: ${err.message}`);
  }

  if (!process.env.OPENAI_API_KEY) {
    return { ok: false, url: null, stats: null, problems: [], error: 'OPENAI_API_KEY missing', source: null };
  }
  let out;
  try {
    const src = sourceBuf || await fetchBuffer(sourceImageUrl);
    const form = new FormData();
    form.append('model', CUTOUT_MODEL);
    form.append('prompt', CUTOUT_PROMPT);
    form.append('n', '1');
    form.append('quality', 'high');
    // gpt-image-2 REJECTS background=transparent outright:
    //   "Transparent background is not supported for this model." (400)
    // gpt-image-1 does support it, so the fallback path pins that model rather
    // than inheriting OPENAI_IMAGE_MODEL. This path only runs for a source that
    // is not already transparent — Puure's images are, so it is currently cold.
    form.append('background', 'transparent');
    form.append('output_format', 'png');
    form.append('image[]', new Blob([src], { type: 'image/png' }), 'product.png');

    const res = await fetch(`${OPENAI_BASE}/images/edits`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${process.env.OPENAI_API_KEY}` },
      body: form,
      signal: AbortSignal.timeout(300_000),
    });
    if (!res.ok) {
      const t = await res.text();
      throw new Error(`images/edits ${res.status}: ${t.slice(0, 300)}`);
    }
    const data = await res.json();
    const item = data?.data?.[0];
    if (!item?.b64_json) throw new Error('no b64_json in cutout response');
    out = Buffer.from(item.b64_json, 'base64');
  } catch (err) {
    console.error(`[cutout] generation failed: ${err.message}`);
    return { ok: false, url: null, stats: null, problems: [], error: err.message };
  }

  let trimmed, stats, verdict;
  try {
    stats = await measureTransparency(out);
    verdict = assessCutout(stats);
    // Trim only once we know there IS transparency; trimming an opaque image is
    // a no-op that would hide the failure behind a plausible-looking asset.
    trimmed = verdict.ok ? await trimToSubject(out) : out;
    if (verdict.ok) stats = { ...stats, trimmed: await measureTransparency(trimmed) };
  } catch (err) {
    return { ok: false, url: null, stats: null, problems: [], error: `inspection failed: ${err.message}` };
  }

  let url = null;
  if (persist) {
    try {
      url = await uploadBuffer(trimmed, `${keyPrefix}/${randomUUID()}.png`, 'image/png');
    } catch (err) {
      return { ok: false, url: null, stats, problems: verdict.problems, error: `upload failed: ${err.message}` };
    }
  }
  console.log(`[cutout] ${verdict.ok ? 'ok' : 'REJECTED'} transparent=${(stats.transparentRatio * 100).toFixed(1)}% ${verdict.problems.join('; ')}`);
  return { ok: verdict.ok, url, stats, problems: verdict.problems, error: null, buffer: persist ? null : trimmed };
}
