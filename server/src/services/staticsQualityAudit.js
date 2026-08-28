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

// ── Offer verification ──────────────────────────────────────────────────────
//
// Every other guard in this pipeline runs on TEXT, before anything is drawn:
// enforceTextShape, enforceOfferClaims, enforceCopySet. They guarantee the
// INSTRUCTION is clean. None of them can see the OUTPUT.
//
// On a controlled A/B — one reference, one approved copy set, two engines —
// NanoBanana rendered "90% OFF" and "HOLIDAY20" while the approved copy said
// 60% and WELCOME10. Both numbers came from the COMPETITOR's reference ad. The
// copy check passed; the renderer ignored it. A card like that promises a
// discount that does not exist and a code that does not work.
//
// So the offer has to be re-read off the finished pixels and compared with what
// was approved. This is the only check in the system that can catch it.

const PCT_RE   = /(\d{1,3})\s*%/g;
const CODE_RE  = /\b(?:use\s+)?(?:code|coupon|promo\s*code)\s*[:\-—]?\s*["“']?([A-Za-z0-9][A-Za-z0-9_-]{2,19})["”']?/gi;
const PRICE_RE = /\$\s?(\d[\d,]*(?:\.\d{2})?)/g;

/**
 * Pull every offer term out of a blob of approved copy.
 *
 * Flattens an object to its STRING VALUES rather than JSON.stringify-ing it.
 * Stringify escapes the quotes in `USE CODE "WELCOME10"` to `\"WELCOME10\"`,
 * and the backslash breaks the code regex — so the approved code was found
 * NOWHERE and every rendered code got reported as unauthorised. A check that
 * fires on correct output is worse than no check: it trains you to ignore it.
 */
function flattenStrings(v, out = []) {
  if (typeof v === 'string') out.push(v);
  else if (Array.isArray(v)) v.forEach(x => flattenStrings(x, out));
  else if (v && typeof v === 'object') Object.values(v).forEach(x => flattenStrings(x, out));
  else if (typeof v === 'number') out.push(String(v));
  return out;
}

export function extractOfferTerms(input) {
  const text = typeof input === 'string' ? input : flattenStrings(input).join(' | ');
  const grab = (re, idx = 1) => {
    const out = new Set();
    let m; re.lastIndex = 0;
    while ((m = re.exec(text)) !== null) out.add(String(m[idx]).toUpperCase().replace(/,/g, ''));
    return out;
  };
  return { percents: grab(PCT_RE), codes: grab(CODE_RE), prices: grab(PRICE_RE) };
}

/**
 * Compare what the image RENDERED against what was APPROVED.
 *
 * Returns a list of problems, each naming BOTH values — "image says X, approved
 * says Y" — because a mismatch is only actionable if you can see the gap.
 *
 * Deliberately silent when the audit could not read an offer term: absence of a
 * reading is not evidence of a mismatch, and a false accusation here would send
 * someone hunting a compliance problem that does not exist.
 */
export function compareOffer(approvedCopy, rendered = {}, extra = {}) {
  const problems = [];
  if (!approvedCopy) return problems;             // nothing to compare against
  const approved = extractOfferTerms(approvedCopy);
  const allowedPrices = new Set(approved.prices);
  for (const p of extractOfferTerms(extra.productPrice || '').prices) allowedPrices.add(p);

  const rPct = String(rendered.discount_percent ?? '').match(/(\d{1,3})\s*%/);
  if (rPct) {
    const got = rPct[1];
    if (approved.percents.size > 0 && !approved.percents.has(got)) {
      problems.push(`offer mismatch: image says ${got}% off, approved copy says ${[...approved.percents].join('/')}%`);
    } else if (approved.percents.size === 0) {
      problems.push(`image shows ${got}% off but the approved copy claims no discount`);
    }
  }

  const rCode = String(rendered.promo_code ?? '').trim().toUpperCase().replace(/^["'“]|["'”]$/g, '');
  if (rCode && rCode !== 'NONE' && rCode !== 'NULL') {
    if (!approved.codes.has(rCode)) {
      const known = approved.codes.size ? [...approved.codes].join(', ') : 'none';
      problems.push(`unauthorised code rendered: "${rCode}" (approved: ${known})`);
    }
  }

  const rPrice = String(rendered.price ?? '').match(/\$\s?(\d[\d,]*(?:\.\d{2})?)/);
  if (rPrice) {
    const got = rPrice[1].replace(/,/g, '').toUpperCase();
    if (allowedPrices.size > 0 && !allowedPrices.has(got)) {
      problems.push(`price mismatch: image says $${got}, approved ${[...allowedPrices].map(x => '$' + x).join('/')}`);
    }
  }
  return problems;
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

BANNED PHRASES for this angle:
${banned}

HOW TO APPLY THE BAN — read this carefully, it is easy to get wrong:
- These ban specific WORDINGS, not ideas. Flag only text that renders the banned
  phrase itself, near-verbatim (the same words in the same order, allowing for
  case, punctuation and trivial inflection).
- An entry annotated "(as clickbait)" bans that exact stock formulation ONLY.
- The angle's own argument is NEVER a violation. This ad is SUPPOSED to make the
  angle's case. If the copy argues the same idea in original words, that is the
  ad working correctly — do NOT flag it.
- Worked example: with "they do not want you to know" banned —
    "THE LIGHT THEY DON'T WANT YOU TO KNOW ABOUT"        -> FLAG (verbatim)
    "They hid this from you."                            -> do NOT flag (different wording)
    "Clinics keep this quiet because it costs them."     -> do NOT flag (original phrasing of the same argument)
- When in doubt, do NOT flag. A false alarm on good copy is worse than a miss.

Return ONLY raw JSON, no markdown fence, in EXACTLY this shape:

{
  "transcript": "every word of visible text in IMAGE 2, in reading order, separated by | between distinct blocks (this is the only long field — keep every other string under 25 words)",
  "word_count": 0,
  "product_label_words": 0,
  "banned_phrases_found": ["the exact rendered text that matches a banned phrase"],
  "spelling_or_grammar_errors": ["the exact broken text, e.g. 'A SURGERY RESULTS.'"],
  "duplicated_text": ["text that appears more than once and should not, e.g. a row label repeated"],
  "product_depictions": [
    {"where": "where in the ad this depiction sits, e.g. 'hero shot, lower half' or 'the device drawn on the skin inside the cross-section diagram'",
     "matches_reference": true,
     "problem": "null, or exactly what differs from IMAGE 1"}
  ],
  "product_fidelity": {
    "matches_reference": true,
    "problem": "null, or the worst mismatch across product_depictions"
  },
  "offer_rendered": {
    "discount_percent": "the discount as rendered, e.g. \"60% OFF\", or null if the ad shows none",
    "promo_code": "the code as rendered, e.g. \"WELCOME10\", or null",
    "price": "the headline price as rendered, e.g. \"$99\", or null",
    "urgency_claim": "any deadline/scarcity claim as rendered, e.g. \"FINAL HOURS\", or null"
  },
  "text_illegible_or_garbled": false,
  "verdict_notes": "one short sentence on the single worst problem, or 'clean'"
}

RULES FOR THE OFFER:
- Read discount_percent, promo_code, price and urgency_claim off the PIXELS.
  Report exactly what is drawn, character for character. Do NOT normalise, do
  NOT correct an odd-looking number, and do NOT infer what it "should" say.
  These are compared against the approved copy, so a helpful correction here
  destroys the only signal that can catch a false advertised discount.
- If a term is not shown at all, use null. null means "absent"; it must never
  mean "probably the usual value".

RULES FOR COUNTING — this distinction is the whole point:
- word_count counts only the AD COPY: text laid OVER the image as part of the
  advertisement. Headline, sub-line, table cells, row labels, badges, price,
  CTA, attribution, brand wordmark placed as a logo. A number like "$20,000"
  is one word. "8mm" is one word.
- product_label_words counts text that is PHYSICALLY PRINTED ON THE PRODUCT or
  its packaging inside the photograph — the box, the label, the device itself.
  That text is part of the product, not something the designer wrote, and a
  copy budget must not charge the ad for it.
- If a product box in the scene reads "BREAST LIFT DEVICE / CLINICALLY PROVEN /
  10 MINUTES DAILY", every one of those words is product_label_words, NOT
  word_count. Counting them made correct ads look 2x over budget and produced
  a warning on output that was fine.
- When you genuinely cannot tell whether a word is overlay or packaging, count
  it as product_label_words. A missed overlay word costs little; a false
  over-budget warning trains the operator to ignore the audit.
RULES FOR PRODUCT FIDELITY — do this as a deliberate sweep, not an impression:
- FIRST scan the whole ad and list EVERY place the product is drawn, into
  product_depictions. Ads often show it twice: a clean hero shot AND a second
  depiction inside a diagram, a table cell, a split-screen panel or an icon.
  The second one is where inventions hide.
- For EACH depiction, compare against IMAGE 1 on shape, colour, parts and count.
  The reference here is typically a MULTI-PART device — check that every part is
  present and correct in each depiction, not just that "a device" is there.
- A depiction that is a generic featureless shape (a plain slab, a bare oval, a
  smooth puck) where IMAGE 1 shows a specific multi-part product is a MISMATCH,
  even when it is small, stylised or diagrammatic. Say so.
- product_fidelity.matches_reference is false if ANY entry in product_depictions
  is false. A correct hero shot does not excuse an invented second depiction.
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
  approvedCopy = null,
  productPrice = '',
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
      // Headroom for product_depictions on a busy card. At 1500 the response
      // truncated mid-string and every audit failed to parse — a budget set
      // before the schema grew.
      max_tokens: 3000,
      messages: [{ role: 'user', content }],
    });
    const raw = (res.content || []).filter(b => b.type === 'text').map(b => b.text).join('').trim();
    // Name truncation for what it is. "Unterminated string in JSON" sends you
    // hunting a malformed response when the real cause is the token ceiling.
    if (res.stop_reason === 'max_tokens') {
      throw new Error(`audit response hit the ${3000}-token ceiling (${raw.length} chars) — raise max_tokens`);
    }
    const jsonText = raw.replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/, '');
    report = JSON.parse(jsonText);
  } catch (err) {
    console.error(`[staticsQC] audit call failed: ${err.message}`);
    return { ok: null, skipped: true, report: null, warning: `QC not run: ${err.message}`.slice(0, 200) };
  }

  return { ...summarise(report, wordCap, { approvedCopy, productPrice }), report, skipped: false };
}

/**
 * Turn a raw report into { ok, warning }. Split out from the network call so it
 * is testable against fixtures without spending an API call.
 */
export function summarise(report = {}, wordCap = DEFAULT_WORD_CAP, offerCtx = null) {
  const problems = [];

  const wc = Number(report.word_count);
  if (Number.isFinite(wc) && wc > wordCap) problems.push(`${wc} words (cap ${wordCap})`);

  const banned = Array.isArray(report.banned_phrases_found) ? report.banned_phrases_found.filter(Boolean) : [];
  if (banned.length) problems.push(`banned phrase: "${String(banned[0]).slice(0, 60)}"${banned.length > 1 ? ` +${banned.length - 1}` : ''}`);

  const errs = Array.isArray(report.spelling_or_grammar_errors) ? report.spelling_or_grammar_errors.filter(Boolean) : [];
  if (errs.length) problems.push(`text error: "${String(errs[0]).slice(0, 60)}"${errs.length > 1 ? ` +${errs.length - 1}` : ''}`);

  const dups = Array.isArray(report.duplicated_text) ? report.duplicated_text.filter(Boolean) : [];
  if (dups.length) problems.push(`repeated: "${String(dups[0]).slice(0, 40)}"${dups.length > 1 ? ` +${dups.length - 1}` : ''}`);

  // Explicit false only — a missing block means "not assessed", not a failure.
  // Trust the per-depiction list over the roll-up: the roll-up read "true" on a
  // card whose diagram drew an invented device, so a summary that only consults
  // it inherits that blind spot.
  const deps = Array.isArray(report.product_depictions) ? report.product_depictions : [];
  const badDep = deps.find(d => d && d.matches_reference === false);
  if (badDep || (report.product_fidelity && report.product_fidelity.matches_reference === false)) {
    const p = (badDep && (badDep.problem || badDep.where))
           || (report.product_fidelity && report.product_fidelity.problem);
    problems.push(`product mismatch${p && p !== 'null' ? `: ${String(p).slice(0, 80)}` : ''}`);
  }

  if (report.text_illegible_or_garbled === true) problems.push('garbled text');

  // Offer verification. Runs only when the caller supplied the approved copy —
  // without it there is nothing to compare against, and inventing a baseline
  // would produce confident nonsense.
  if (offerCtx && offerCtx.approvedCopy) {
    problems.push(...compareOffer(offerCtx.approvedCopy, report.offer_rendered || {}, offerCtx));
  }

  return { ok: problems.length === 0, warning: problems.length ? problems.join(' · ').slice(0, 500) : null };
}
