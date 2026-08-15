/**
 * Vision QC for finished statics.
 *
 * Everything this checks was, until now, caught only by a human opening the
 * image: a headline with broken grammar, a checklist that prints the same row
 * label three times, an angle's own banned phrase used verbatim, a diagram that
 * invents a device that is not the product, a 50-word wall on a 20-word budget.
 * All of it landed in COMPOSER flagged exactly like a good card, because
 * `quality_warning` was hardcoded null (migration 035 named the column "non-null
 * if vision audit flagged an issue" — the audit was never built).
 *
 * The copy on a static exists only as pixels, so no regex can reach it. The only
 * instrument that can is a vision model reading the rendered image back.
 *
 * ADVISORY, NOT A GATE: a failed audit annotates the card, it never destroys the
 * image or fails the generation. An audit that cannot run records WHY on the
 * card rather than reporting a silent pass.
 */
import Anthropic from '@anthropic-ai/sdk';

const anthropic = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });

const AUDIT_MODEL = 'claude-sonnet-5';
export const DEFAULT_WORD_CAP = 20;

// Browser UA: Cloudflare (error 1010) blocks default Node/undici fetch agents on
// some of the origins these images are mirrored from.
const UA = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/140.0 Safari/537.36';

async function fetchAsBase64(url, timeoutMs = 60000) {
  if (typeof url === 'string' && url.startsWith('data:')) {
    const m = /^data:(image\/[^;]+);base64,(.+)$/is.exec(url);
    if (!m) throw new Error('malformed data: URI');
    return { base64: m[2], mediaType: m[1] };
  }
  const ctl = new AbortController();
  const t = setTimeout(() => ctl.abort(), timeoutMs);
  try {
    const r = await fetch(url, { headers: { 'User-Agent': UA }, signal: ctl.signal });
    if (!r.ok) throw new Error(`HTTP ${r.status}`);
    const buf = Buffer.from(await r.arrayBuffer());
    if (buf.length < 1000) throw new Error(`suspiciously small image (${buf.length} B)`);
    // Trust magic bytes over Content-Type — R2 has served octet-stream before.
    const mediaType =
      buf.slice(0, 8).toString('hex').startsWith('89504e47') ? 'image/png'
      : buf.slice(0, 3).toString('hex') === 'ffd8ff' ? 'image/jpeg'
      : buf.slice(0, 4).toString('ascii') === 'RIFF' ? 'image/webp'
      : (r.headers.get('content-type') || 'image/png').split(';')[0];
    return { base64: buf.toString('base64'), mediaType };
  } finally {
    clearTimeout(t);
  }
}

function buildPrompt({ bannedPhrases, wordCap, angleName, requestedFormat }) {
  const banned = bannedPhrases.length
    ? bannedPhrases.map(p => `  - "${p}"`).join('\n')
    : '  (none for this angle)';
  return `You are auditing a finished static advertisement before it goes in front of a buyer.

TWO images are attached:
  IMAGE 1 = the REFERENCE product photo. This is what the product actually looks like.
  IMAGE 2 = the FINISHED AD to audit.

Audit IMAGE 2. Be strict and literal. Report what is actually rendered, not what
was probably intended.

${angleName ? `The ad was written for the "${angleName}" angle.` : ''}
${requestedFormat ? `The requested visual format was: ${requestedFormat}` : ''}

BANNED PHRASES for this angle — flag any that appear, including close paraphrases
that carry the same meaning:
${banned}

Return ONLY raw JSON, no markdown fence, in EXACTLY this shape:

{
  "transcript": "every word of visible text in IMAGE 2, in reading order, separated by | between distinct blocks",
  "word_count": 0,
  "banned_phrases_found": ["the exact rendered text that matches a banned phrase"],
  "spelling_or_grammar_errors": ["the exact broken text, e.g. 'A SURGERY RESULTS.'"],
  "duplicated_text": ["text that appears more than once and should not, e.g. a row label repeated"],
  "product_fidelity": {
    "matches_reference": true,
    "problem": "null, or what differs — e.g. 'the device drawn inside the diagram is a plain white slab, not the pink pad + white cup in IMAGE 1'"
  },
  "text_illegible_or_garbled": false,
  "verdict_notes": "one short sentence on the single worst problem, or 'clean'"
}

RULES FOR COUNTING:
- word_count counts EVERY visible word: headline, sub-line, table cells, row
  labels, badge text, price, brand wordmark, attribution — all of it. A number
  like "$20,000" is one word. "8mm" is one word.
- A product appearing more than once in the ad (e.g. hero shot AND inside a
  diagram) must match the reference EVERY time. If any depiction is invented,
  matches_reference is false.
- Only report spelling_or_grammar_errors you can point at in the transcript.
  Do not report stylistic choices — sentence fragments and one-word sentences
  are deliberate in advertising and are NOT errors.
- duplicated_text is for genuine redundancy (the same label on three rows, a
  claim printed twice). A word recurring naturally in a sentence is not that.`;
}

/**
 * Audit one finished static.
 *
 * Resolves to { ok, warning, report, skipped }.
 *   ok      — true when nothing was flagged
 *   warning — a compact human string for quality_warning, or null when clean
 *   report  — the parsed model JSON (null when the audit could not run)
 * Never throws: the caller is a post-generation step and must not lose an image
 * because QC was unavailable.
 */
export async function auditStaticImage({
  imageUrl,
  referenceProductImage,
  angle = null,
  wordCap = DEFAULT_WORD_CAP,
  requestedFormat = '',
} = {}) {
  if (!process.env.ANTHROPIC_API_KEY) {
    return { ok: null, skipped: true, report: null, warning: 'QC not run: ANTHROPIC_API_KEY missing' };
  }
  if (!imageUrl) {
    return { ok: null, skipped: true, report: null, warning: 'QC not run: no image URL' };
  }

  const bannedPhrases = Array.isArray(angle?.banned_phrases) ? angle.banned_phrases.filter(Boolean) : [];

  let content;
  try {
    const ad = await fetchAsBase64(imageUrl);
    const blocks = [];
    if (referenceProductImage) {
      const ref = await fetchAsBase64(referenceProductImage);
      blocks.push({ type: 'image', source: { type: 'base64', media_type: ref.mediaType, data: ref.base64 } });
    }
    blocks.push({ type: 'image', source: { type: 'base64', media_type: ad.mediaType, data: ad.base64 } });
    blocks.push({
      type: 'text',
      text: buildPrompt({ bannedPhrases, wordCap, angleName: angle?.name, requestedFormat }),
    });
    // With no reference the prompt's "IMAGE 1 / IMAGE 2" numbering would be off
    // by one and every fidelity verdict would be about the ad itself.
    if (!referenceProductImage) {
      blocks[blocks.length - 1].text = blocks[blocks.length - 1].text
        .replace('TWO images are attached:\n  IMAGE 1 = the REFERENCE product photo. This is what the product actually looks like.\n  IMAGE 2 = the FINISHED AD to audit.',
                 'ONE image is attached: the FINISHED AD to audit. No reference product photo is available.')
        .replace(/IMAGE 2/g, 'the ad')
        .replace(/IMAGE 1/g, 'the reference');
    }
    content = blocks;
  } catch (err) {
    console.error(`[staticsQC] could not prepare images: ${err.message}`);
    return { ok: null, skipped: true, report: null, warning: `QC not run: ${err.message}`.slice(0, 200) };
  }

  let report;
  try {
    const res = await anthropic.messages.create({
      model: AUDIT_MODEL,
      max_tokens: 1500,
      messages: [{ role: 'user', content }],
    });
    const raw = (res.content || []).filter(b => b.type === 'text').map(b => b.text).join('').trim();
    const jsonText = raw.replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/, '');
    report = JSON.parse(jsonText);
  } catch (err) {
    console.error(`[staticsQC] audit call failed: ${err.message}`);
    return { ok: null, skipped: true, report: null, warning: `QC not run: ${err.message}`.slice(0, 200) };
  }

  return { ...summarise(report, wordCap), report, skipped: false };
}

/**
 * Turn a raw report into { ok, warning }. Split out from the network call so it
 * is testable against fixtures without spending an API call.
 */
export function summarise(report = {}, wordCap = DEFAULT_WORD_CAP) {
  const problems = [];

  const wc = Number(report.word_count);
  if (Number.isFinite(wc) && wc > wordCap) problems.push(`${wc} words (cap ${wordCap})`);

  const banned = Array.isArray(report.banned_phrases_found) ? report.banned_phrases_found.filter(Boolean) : [];
  if (banned.length) problems.push(`banned phrase: "${String(banned[0]).slice(0, 60)}"${banned.length > 1 ? ` +${banned.length - 1}` : ''}`);

  const errs = Array.isArray(report.spelling_or_grammar_errors) ? report.spelling_or_grammar_errors.filter(Boolean) : [];
  if (errs.length) problems.push(`text error: "${String(errs[0]).slice(0, 60)}"${errs.length > 1 ? ` +${errs.length - 1}` : ''}`);

  const dups = Array.isArray(report.duplicated_text) ? report.duplicated_text.filter(Boolean) : [];
  if (dups.length) problems.push(`repeated: "${String(dups[0]).slice(0, 40)}"${dups.length > 1 ? ` +${dups.length - 1}` : ''}`);

  // Explicit false only. A missing product_fidelity block means "not assessed",
  // which must not read as a failure.
  if (report.product_fidelity && report.product_fidelity.matches_reference === false) {
    const p = report.product_fidelity.problem;
    problems.push(`product mismatch${p && p !== 'null' ? `: ${String(p).slice(0, 80)}` : ''}`);
  }

  if (report.text_illegible_or_garbled === true) problems.push('garbled text');

  return { ok: problems.length === 0, warning: problems.length ? problems.join(' · ').slice(0, 500) : null };
}
