// ─────────────────────────────────────────────────────────────────────────────
// statics — 3-prompt architecture (migration 036)
//
// The entire generation pipeline runs on just 3 admin-editable prompts stored
// in system_settings.value->'statics_prompts':
//
//   1. claude_analysis    — Claude sees ref + product, emits JSON brief
//   2. nanobanana_image   — NanoBanana sees ONLY product image + brief
//   3. ai_adjustment      — Optional: Claude turns freeform correction into NB prompt
//
// All builders in this file just interpolate {{VARS}} into the DB-stored
// templates and return the final string. No more 1500-line prompt engineering.
// ─────────────────────────────────────────────────────────────────────────────

/**
 * JSON-escape a value so it can be embedded safely inside a JSON string
 * literal. Without this, a product field containing a `"`, `\`, or newline
 * would break a JSON-shaped prompt and confuse the downstream model.
 */
function jsonEscapeForString(str) {
  return String(str)
    .replace(/\\/g, '\\\\')
    .replace(/"/g, '\\"')
    .replace(/\n/g, '\\n')
    .replace(/\r/g, '\\r')
    .replace(/\t/g, '\\t');
}

/**
 * Replace {{VAR}} tokens in a template with values from `vars`.
 * Missing keys are replaced with empty string (silent — keeps templates flexible).
 *
 * `opts.jsonSafe` (auto-detected by default): when true, every interpolated
 * value is JSON-string-escaped. Required for JSON-shaped prompt templates
 * (e.g. the $100M-tier openai_image default) so embedded `"` / `\` / `\n`
 * in product profile fields don't break the JSON structure.
 *
 * Auto-detect: if the template (trimmed) starts with `{`, it's treated as
 * JSON-shaped and jsonSafe=true is used unless explicitly overridden.
 */
export function interpolate(template, vars = {}, opts = {}) {
  if (typeof template !== 'string') return '';
  const isJsonShaped = template.trimStart().startsWith('{');
  const jsonSafe = opts.jsonSafe !== undefined ? opts.jsonSafe : isJsonShaped;
  return template.replace(/\{\{([A-Z_]+)\}\}/g, (_, key) => {
    const v = vars[key];
    if (v === null || v === undefined) return '';
    let str;
    if (typeof v === 'string') str = v;
    else if (typeof v === 'number' || typeof v === 'boolean') str = String(v);
    else if (Array.isArray(v)) str = v.join(', ');
    else str = JSON.stringify(v);
    return jsonSafe ? jsonEscapeForString(str) : str;
  });
}

/**
 * Build the Step 1 (Claude analysis) prompt.
 * Interpolates product profile fields + angle into the admin-editable template.
 *
 * @param {Object} product   — { name, price, description, profile, ... }
 * @param {string} angle     — Marketing angle name (optional)
 * @param {string} template  — DB-stored prompt template with {{VARS}}
 * @param {Object} extras    — Extra vars (e.g. PRODUCT_IMAGE_NOTE) to inject
 * @returns {string} interpolated prompt text
 */
export function buildClaudeAnalysisPrompt(product = {}, angle = '', template = '', extras = {}) {
  const p = product.profile || {};
  const vars = {
    // Core
    PRODUCT_NAME:         product.name        || p.product_name    || '',
    PRODUCT_PRICE:        product.price       || p.price           || '',
    PRODUCT_DESCRIPTION:  product.description || p.description     || '',
    ANGLE:                angle               || '',
    // Brand
    ONELINER:             p.oneliner          || '',
    TAGLINE:              p.tagline           || '',
    BRAND_VOICE:          p.brand_voice       || '',
    SHORT_NAME:           p.short_name        || '',
    PRODUCT_TYPE:         p.product_type      || '',
    CATEGORY:             p.category          || '',
    UNIT_DETAILS:         p.unit_details      || '',
    PRODUCT_URL:          p.product_url       || '',
    // Audience
    CUSTOMER:             p.customer          || p.target_customer || '',
    CUSTOMER_FRUSTRATION: p.customer_frustration || '',
    CUSTOMER_DREAM:       p.customer_dream    || '',
    TARGET_AUDIENCE:      p.target_audience   || '',
    PAIN_POINTS:          p.pain_points       || '',
    OBJECTIONS:           p.objections        || '',
    // Promise
    BIG_PROMISE:          p.big_promise       || '',
    UNIQUE_MECHANISM:     p.unique_mechanism  || '',
    DIFFERENTIATOR:       p.differentiator    || '',
    COMPETITIVE_EDGE:     p.competitive_edge  || '',
    KEY_BENEFITS:         p.key_benefits      || '',
    INGREDIENTS:          p.ingredients       || '',
    GUARANTEE:            p.guarantee         || '',
    // Angles
    WINNING_ANGLES:       p.winning_angles    || '',
    CUSTOM_ANGLES:        p.custom_angles     || '',
    // Offer / pricing
    OFFER_HOOK:           p.offer_hook        || p.offer          || '',
    PRICING:              p.pricing           || product.price    || '',
    MAX_DISCOUNT:         p.max_discount      || '',
    DISCOUNT_CODES:       p.discount_codes    || '',
    OFFERS:               p.offers            || '',
    // Compliance / misc
    COMPLIANCE:           p.compliance        || '',
    NOTES:                p.notes             || '',
    // Full master brief — the operator's authoritative product document
    // (angle strategy, mechanism, avatar deep-dive, offer, compliance).
    // Mirrors briefPipeline.js buildProductContextForBrief:2521. Rendered
    // inside a labeled block by the template so Claude knows it's the
    // primary source of truth. Empty string → template block collapses
    // to whitespace (harmless).
    MASTER_BRIEF:         renderMasterBriefBlock(p.master_brief),
    PRODUCT_IMAGE_NOTE:   extras.PRODUCT_IMAGE_NOTE || '',
    ...extras,
  };
  // Append the full per-angle context (Product Library angles) so the static
  // generator gets who/how/hooks, not just the angle name. No template edit
  // needed — mirrors the MASTER_BRIEF block approach.
  return interpolate(template, vars) + renderAngleDetailsBlock(p.angles, angle);
}

/**
 * Render the Product Library angle context: the full list of available angles
 * plus the deep detail (hook_strategy, lead_with, tone, copy_directives,
 * required_elements, headline_examples, banned_phrases, avatar) for the
 * selected one. Returns '' when the product has no angles — block collapses.
 */
function renderAngleDetailsBlock(angles, angleName) {
  let arr = angles;
  if (typeof arr === 'string') { try { arr = JSON.parse(arr); } catch { arr = []; } }
  if (!Array.isArray(arr) || arr.length === 0) return '';
  const list = arr
    .map(a => `- ${a.name} [${(a.funnel_stage || 'middle').toUpperCase()}]${a.avatar ? ` — avatar: ${a.avatar}` : ''}`)
    .join('\n');
  let detail = '';
  const name = (angleName && angleName !== 'NA' && angleName !== 'AUTO') ? String(angleName) : '';
  if (name) {
    const m = arr.find(a => (a.name || '').toLowerCase() === name.toLowerCase());
    if (m) {
      const lines = [];
      if (m.avatar)          lines.push(`avatar: ${m.avatar}`);
      if (m.awareness)       lines.push(`awareness: ${m.awareness}`);
      if (m.funnel_stage)    lines.push(`funnel_stage: ${m.funnel_stage}`);
      if (m.messenger)       lines.push(`messenger: ${m.messenger}`);
      if (m.hook_strategy)   lines.push(`hook_strategy: ${m.hook_strategy}`);
      if (m.lead_with)       lines.push(`lead_with: ${m.lead_with}`);
      if (m.tone)            lines.push(`tone: ${m.tone}`);
      if (m.copy_directives) lines.push(`copy_directives:\n${m.copy_directives}`);
      if (Array.isArray(m.required_elements) && m.required_elements.length) lines.push(`required_elements:\n- ${m.required_elements.join('\n- ')}`);
      if (Array.isArray(m.headline_examples) && m.headline_examples.length) lines.push(`headline_examples:\n- ${m.headline_examples.join('\n- ')}`);
      if (Array.isArray(m.banned_phrases) && m.banned_phrases.length) lines.push(`banned_phrases (HARD ban):\n- ${m.banned_phrases.join('\n- ')}`);
      detail = `\n\n----- SELECTED ANGLE: ${m.name} -----\n${lines.join('\n')}`;
    } else {
      detail = `\n\n----- SELECTED ANGLE: ${name} (not in Product Library — reason from the name) -----`;
    }
  }
  return `\n\n===== MARKETING ANGLES — PRODUCT LIBRARY (angle strategy source of truth) =====\n\nAVAILABLE ANGLES:\n${list}${detail}`;
}

/**
 * Pick ONE angle of attack out of an angle's own copy material, so a BATCH of
 * N statics on one angle argues N different points instead of rendering the
 * angle's summary sentence N times.
 *
 * Why this exists: an angle definition carries a single `lead_with` paragraph
 * plus several `headline_examples` and `required_elements`. Feeding `lead_with`
 * to every card in a batch is the same instruction N times, so the copy
 * converges — 15 Comparison cards all said "only one holds up" because that is
 * the last clause of Comparison's lead_with. The variety was already in the
 * library; nothing was reading it.
 *
 * Pairing rule: hook rotates fastest, proof point rotates once per full lap of
 * the hooks. That yields headlines.length * required_elements.length DISTINCT
 * (hook, proof) pairs before anything repeats — 16 for Comparison, 20 for
 * Mechanism, against a typical batch of 15.
 *
 * Returns '' when the angle is unknown or carries no usable material, so the
 * block collapses and the caller's own brief is left untouched.
 */
const LAYOUT_NOUN = /\b(table|chart|graph|grid|diagram|infographic|checklist|matrix|column|row)s?\b/i;

/**
 * Walk the (hook, proof) pair space so BOTH coordinates move card to card.
 *
 * Enumerating pairs in the obvious order — hook fast, proof once per lap —
 * keeps a whole lap on proof 0, and when proof 0 reads "A comparison table"
 * every card in a short batch renders a table whatever format was asked for.
 * Stepping the flat pair index by a stride coprime to H*R is a bijection, so
 * all H*R pairs still come out before anything repeats; among the valid strides
 * we take the one that spreads proof points widest over the first few cards,
 * because short batches are the case that was broken.
 *
 * Pure function of (H, R) — same inputs always give the same walk.
 */
const gcd = (a, b) => (b === 0 ? a : gcd(b, a % b));
const strideCache = new Map();
function pairStride(H, R) {
  const key = `${H}x${R}`;
  if (strideCache.has(key)) return strideCache.get(key);
  const total = H * R;
  const window = Math.min(R, total);
  let best = 1, bestScore = -1;
  for (let s = 1; s < total; s++) {
    if (gcd(s, total) !== 1) continue;
    const seenP = new Set(), seenH = new Set();
    for (let i = 0; i < window; i++) {
      const p = (i * s) % total;
      seenP.add(Math.floor(p / H));
      seenH.add(p % H);
    }
    const score = seenP.size * 1000 + seenH.size;   // proof spread dominates
    if (score > bestScore) { bestScore = score; best = s; }
  }
  strideCache.set(key, best);
  return best;
}

export function renderAngleVariantBlock(angles, angleName, variantIndex = 0) {
  let arr = angles;
  if (typeof arr === 'string') { try { arr = JSON.parse(arr); } catch { arr = []; } }
  if (!Array.isArray(arr) || arr.length === 0) return '';
  const name = String(angleName || '').trim();
  if (!name || name === 'NA' || name === 'AUTO') return '';
  // Names are NOT unique in a real product library: Puure carries two angles
  // called "Promo" — an empty stub AND the full pl_angle_promo. A plain .find()
  // hits the stub and silently yields no variation at all, which looks exactly
  // like "this angle has no material". Prefer the richest match instead.
  const matches = arr.filter(a => (a.name || '').toLowerCase() === name.toLowerCase());
  if (matches.length === 0) return '';
  const material = a =>
    (Array.isArray(a.headline_examples) ? a.headline_examples.length : 0) +
    (Array.isArray(a.required_elements) ? a.required_elements.length : 0);
  const m = matches.reduce((best, a) => (material(a) > material(best) ? a : best), matches[0]);

  const hooks = Array.isArray(m.headline_examples) ? m.headline_examples.filter(Boolean) : [];
  const proofs = Array.isArray(m.required_elements) ? m.required_elements.filter(Boolean) : [];
  const banned = Array.isArray(m.banned_phrases) ? m.banned_phrases.filter(Boolean) : [];
  if (hooks.length === 0 && proofs.length === 0) return '';

  // Non-negative, integer. A garbage variantIndex must not silently collapse
  // every card onto slot 0 — that is the exact failure this function fixes.
  const i = Number.isFinite(Number(variantIndex)) ? Math.abs(Math.trunc(Number(variantIndex))) : 0;
  let hook = '', proof = '';
  if (hooks.length && proofs.length) {
    const p = (i * pairStride(hooks.length, proofs.length)) % (hooks.length * proofs.length);
    hook = hooks[p % hooks.length];
    proof = proofs[Math.floor(p / hooks.length)];
  } else if (hooks.length) {
    hook = hooks[i % hooks.length];
  } else {
    proof = proofs[i % proofs.length];
  }

  const lines = [`ANGLE: ${m.name}`];
  if (m.messenger) lines.push(`MESSENGER (whose voice this is): ${m.messenger}`);
  if (m.tone)      lines.push(`TONE: ${m.tone}`);
  lines.push('');
  lines.push(`THIS AD'S ANGLE OF ATTACK — variant ${i + 1}. Make ONE point, not the whole case:`);
  if (hook) {
    lines.push(`- HEADLINE DIRECTION: write a FRESH headline that argues this — "${hook}"`);
    lines.push('  Do NOT copy that line verbatim, and do NOT fall back on the angle\'s');
    lines.push('  general summary sentence. Other ads in this set use the other directions.');
  }
  if (proof) {
    lines.push(`- THE SINGLE PROOF POINT THIS AD CARRIES: ${proof}`);
    lines.push('  Every other point the angle could make belongs to a DIFFERENT ad. Leave them out.');
    // Proof points are written for advertorials, so several of them name a
    // layout ("A comparison table (Puure vs surgery vs creams)"). Left alone
    // that noun beats the operator's format every time — a "product hero" brief
    // came back as a diagram plus a six-row table. Name the conflict explicitly.
    if (LAYOUT_NOUN.test(proof)) {
      lines.push('  !! That proof point NAMES A LAYOUT. It is describing the ARGUMENT, not the');
      lines.push('     design. Do NOT draw it as a table/chart/diagram unless the operator\'s');
      lines.push('     VISUAL FORMAT above explicitly asked for one. The format wins. If the');
      lines.push('     format is a hero shot or a statement card, make this point in the');
      lines.push('     HEADLINE instead, and draw no grid of any kind.');
    }
  }
  if (banned.length) lines.push(`- NEVER USE THESE PHRASES: ${banned.join(', ')}`);

  return `\n\n${lines.join('\n')}`;
}

/**
 * Wrap the master_brief in a labeled block so Claude recognizes it as
 * primary source-of-truth (not just more flat context). Empty when the
 * product has no brief. Soft-caps at 40,000 chars (~10k tokens) with a
 * loud log line — brief §4 gotcha: "Never silently truncate — if you cap
 * it, log it."
 */
const MASTER_BRIEF_MAX_CHARS = 40000;
function renderMasterBriefBlock(masterBrief) {
  if (!masterBrief || typeof masterBrief !== 'string' || !masterBrief.trim()) return '';
  let body = masterBrief.trim();
  if (body.length > MASTER_BRIEF_MAX_CHARS) {
    console.warn(`[staticsPrompts] MASTER_BRIEF capped: ${body.length} → ${MASTER_BRIEF_MAX_CHARS} chars (${body.length - MASTER_BRIEF_MAX_CHARS} truncated). Consider trimming the source or raising MASTER_BRIEF_MAX_CHARS.`);
    body = body.slice(0, MASTER_BRIEF_MAX_CHARS) + '\n\n[…truncated for token budget]';
  }
  return `\n\n===== MASTER PRODUCT BRIEF — FULL DOCUMENT (primary source of truth) =====\n\n${body}`;
}

/**
 * Map a raw `product_profiles` DB row to the flat snake_case profile shape
 * that buildClaudeAnalysisPrompt expects. Single source of truth for which
 * DB columns surface in the Claude prompt — keep all 3 generation paths
 * (/generate, /iterate, /regenerate-ready) calling this so OpenAI + NB
 * both see identical product context.
 *
 * @param {Object} row — raw row from `product_profiles` (snake_case columns)
 * @returns {Object} flat profile for product.profile
 */
export function mapProductRowToFlatProfile(row = {}) {
  const arrayJoin = (v) => Array.isArray(v) ? v.filter(Boolean).join(', ') : (v || '');
  const offersStr = Array.isArray(row.offers)
    ? row.offers.map(o => typeof o === 'string' ? o : JSON.stringify(o)).join(' | ')
    : '';
  return {
    product_name:         row.name        || '',
    price:                row.price       || '',
    description:          row.description || '',
    oneliner:             row.oneliner    || '',
    tagline:              row.tagline     || '',
    brand_voice:          row.voice       || '',
    customer:             row.customer_avatar || '',
    customer_frustration: row.customer_frustration || '',
    customer_dream:       row.customer_dream || '',
    big_promise:          row.big_promise || '',
    differentiator:       row.differentiator || '',
    unique_mechanism:     row.mechanism   || '',
    competitive_edge:     row.competitive_edge || '',
    key_benefits:         arrayJoin(row.benefits),
    target_audience:      row.target_demographics || row.customer_avatar || '',
    pain_points:          row.pain_points || '',
    ingredients:          row.ingredients || '',
    winning_angles:       row.winning_angles || '',
    custom_angles:        row.custom_angles_text || '',
    angles:               Array.isArray(row.angles)
                            ? row.angles
                            : (typeof row.angles === 'string'
                                ? (() => { try { return JSON.parse(row.angles); } catch { return []; } })()
                                : []),
    objections:           row.common_objections  || '',
    offer_hook:           row.offer_details      || '',
    pricing:              row.bundle_variants    || row.price || '',
    compliance:           row.compliance_restrictions || '',
    guarantee:            row.guarantee   || '',
    max_discount:         row.max_discount || '',
    discount_codes:       row.discount_codes || '',
    offers:               offersStr,
    notes:                row.notes       || '',
    short_name:           row.short_name  || '',
    product_type:         row.product_type || '',
    category:             row.category    || '',
    unit_details:         row.unit_details || '',
    product_url:          row.product_url || '',
    // Full 24k-char product document — passed through raw so
    // buildClaudeAnalysisPrompt can wrap it in the labeled block.
    // Puure's master brief holds every detail statics currently misses.
    master_brief:         row.master_brief || '',
  };
}

/**
 * Build the Step 2 (NanoBanana image) prompt.
 * Computes PRODUCT_INSTRUCTION / PRODUCT_RULE / VISUAL_CHANGES / TEXT_SWAPS
 * from Claude's Step 1 JSON output, then interpolates them into the template.
 *
 * Per friend's tool architecture: NanoBanana receives ONLY the product image
 * (NOT the reference image). The composition is reconstructed from Claude's
 * description, which prevents reference-image bleed-through (BUTCHERBOX text
 * surviving in column headers, food brand logos leaking, etc).
 *
 * @param {Object} claudeResult — JSON returned from Step 1
 * @param {Object} product      — { name, ... }
 * @param {string} template     — DB-stored prompt template with {{VARS}}
 * @returns {string} interpolated prompt text
 */
// ─────────────────────────────────────────────────────────────────────────────
// TEXT-SHAPE ENFORCEMENT
//
// This pipeline is a SWAP tool: read the winning ad's text, substitute ours.
// Nothing enforced that. Observed in prod 2026-08-13 on a real reference whose
// original_text came back with all six fields empty — the reference genuinely
// had no text on it — and the pipeline still authored 661 characters: a 75-char
// headline, a 107-char subheadline, a 213-char body, a CTA, five bullets and
// three badges, then rendered them over a cloned photo of an empty dining room.
//
// The invariant: adapted_text may never exceed the SHAPE of original_text.
//   - a field the reference does not have is dropped, not invented
//   - arrays are truncated to the reference's own count (2 bullets => 2, not 5)
//   - a reference with no text at all produces a text-free ad
//
// Enforced in code rather than asked for in the prompt, because a prompt
// instruction is a request and this needs to be a guarantee. Every clamp is
// logged, and nothing is dropped silently.
//
// SAFETY: "all fields empty" could also mean Claude failed to READ text that is
// present, and stripping copy on that basis would be a regression. So the
// caller is told which case it saw via `report.suspectExtractionFailure` (set
// when the model asserted reference_has_text === true yet returned nothing) so
// it can log loudly instead of quietly producing a blank ad.
// ─────────────────────────────────────────────────────────────────────────────

const TEXT_SCALARS = ['headline', 'subheadline', 'body', 'cta'];
const TEXT_ARRAYS  = ['bullets', 'badges'];

// How much longer an adapted field may be than the one it replaces. A static's
// layout reserves fixed space: swapping a 30-char headline for a 90-char one
// does not "add value", it breaks the composition the reference won with.
const LENGTH_TOLERANCE = 1.5;

const asString = (v) => (typeof v === 'string' ? v.trim() : '');
const asArray  = (v) => (Array.isArray(v) ? v.filter(x => asString(x)) : []);

/**
 * Clamp adapted_text to the shape of original_text.
 *
 * Returns a NEW claudeResult (input is not mutated) plus a report describing
 * every change, so the caller can log exactly what was dropped and why.
 *
 * @param {Object} claudeResult
 * @returns {{result: Object, report: Object}}
 */
export function enforceTextShape(claudeResult = {}) {
  // GUARD: only clamp when the analysis actually carries an original_text
  // object. `original_text: {}` means "Claude looked and found no text" — a
  // real signal. A MISSING original_text means we never had the reading (e.g. a
  // result rebuilt from stored adapted_text), and treating absence as "no text"
  // would strip every field on copy we have no evidence about.
  if (!claudeResult || typeof claudeResult.original_text !== 'object' || claudeResult.original_text === null) {
    return {
      result: claudeResult || {},
      report: { skipped: 'analysis carries no original_text — nothing to compare against', droppedFields: [], truncatedArrays: [], shortenedFields: [], textFreeRender: false, suspectExtractionFailure: false },
    };
  }

  const orig = claudeResult.original_text || {};
  const adapted = claudeResult.adapted_text || {};

  const origScalars = Object.fromEntries(TEXT_SCALARS.map(f => [f, asString(orig[f])]));
  const origArrays  = Object.fromEntries(TEXT_ARRAYS.map(f => [f, asArray(orig[f])]));
  const referenceHasAnyText =
    TEXT_SCALARS.some(f => origScalars[f]) || TEXT_ARRAYS.some(f => origArrays[f].length > 0);

  // An explicit assertion from the model, when the prompt supplies one. Absent
  // on older DB-stored prompts, which is why it is only ever used to DETECT a
  // contradiction, never as the thing that authorises a clamp.
  const asserted = claudeResult.reference_has_text;

  const report = {
    referenceHasAnyText,
    droppedFields: [],
    truncatedArrays: [],
    shortenedFields: [],
    textFreeRender: false,
    suspectExtractionFailure: asserted === true && !referenceHasAnyText,
  };

  const out = { ...claudeResult };
  const next = {};

  if (!referenceHasAnyText) {
    // Nothing to swap ⇒ render text-free. This is the case that produced the
    // dining-room ad with 661 invented characters.
    for (const f of [...TEXT_SCALARS, ...TEXT_ARRAYS]) {
      const had = TEXT_ARRAYS.includes(f) ? asArray(adapted[f]).length > 0 : Boolean(asString(adapted[f]));
      if (had) report.droppedFields.push(f);
    }
    next.headline = ''; next.subheadline = ''; next.body = ''; next.cta = '';
    next.bullets = []; next.badges = [];
    report.textFreeRender = true;
    out.adapted_text = next;
    return { result: out, report };
  }

  // The reference does have text, so per-field shape is a trustworthy signal.
  for (const f of TEXT_SCALARS) {
    const o = origScalars[f];
    const a = asString(adapted[f]);
    if (!o) {
      // Reference has no such field — do not add one.
      if (a) report.droppedFields.push(f);
      next[f] = '';
      continue;
    }
    if (!a) { next[f] = ''; continue; }
    const max = Math.ceil(o.length * LENGTH_TOLERANCE);
    if (a.length > max) {
      // Cut at a word boundary rather than mid-word.
      let cut = a.slice(0, max);
      const sp = cut.lastIndexOf(' ');
      if (sp > max * 0.6) cut = cut.slice(0, sp);
      next[f] = cut.trim();
      report.shortenedFields.push({ field: f, from: a.length, to: next[f].length, referenceLength: o.length });
    } else {
      next[f] = a;
    }
  }

  for (const f of TEXT_ARRAYS) {
    const oCount = origArrays[f].length;
    const a = asArray(adapted[f]);
    if (oCount === 0) {
      if (a.length > 0) report.droppedFields.push(f);
      next[f] = [];
      continue;
    }
    if (a.length > oCount) {
      report.truncatedArrays.push({ field: f, from: a.length, to: oCount });
      next[f] = a.slice(0, oCount);
    } else {
      next[f] = a;
    }
  }

  out.adapted_text = next;
  return { result: out, report };
}

// ─────────────────────────────────────────────────────────────────────────────
// REFERENCE USABILITY
//
// Not every winning ad is a usable reference for THIS tool. Two kinds are not,
// and both are decided from the text Claude reads off the reference image —
// after the ~30s analysis, before the ~150s image generation, so an unusable
// reference costs the cheap step only.
//
//   TOO MUCH TEXT — a long-form/story static (operator threshold: >300 words on
//   the image). That is a different creative strategy: it works by being read,
//   not by being seen. Cloning its composition for a product card produces a
//   wall of copy, not an ad.
//
//   NO TEXT AT ALL — nothing to swap. Either the ad genuinely has no copy, or
//   (as seen in prod) the scrape attached the wrong image to the ad. Either way
//   there is no winning text structure to adapt.
//
// The band between them is where this tool works.
// ─────────────────────────────────────────────────────────────────────────────

// Operator-set, env-overridable. 300 is deliberately generous: a normal static
// carries 20-60 words, so this only catches genuine long-form.
const REF_MAX_WORDS = Math.max(1, parseInt(process.env.STATICS_REF_MAX_WORDS, 10) || 300);
// 1 = "must have at least one word". Set to 0 to allow text-free references.
const REF_MIN_WORDS = (() => {
  const raw = process.env.STATICS_REF_MIN_WORDS;
  if (raw === undefined || raw === '') return 1;
  const n = parseInt(raw, 10);
  return Number.isFinite(n) && n >= 0 ? n : 1;
})();

/** Count whitespace-delimited words across every text field of a block. */
export function countTextWords(textBlock = {}) {
  const parts = [];
  for (const f of TEXT_SCALARS) {
    const v = textBlock?.[f];
    if (typeof v === 'string' && v.trim()) parts.push(v.trim());
  }
  for (const f of TEXT_ARRAYS) {
    const arr = textBlock?.[f];
    if (Array.isArray(arr)) for (const x of arr) if (typeof x === 'string' && x.trim()) parts.push(x.trim());
  }
  if (parts.length === 0) return 0;
  return parts.join(' ').split(/\s+/).filter(Boolean).length;
}

/**
 * Decide whether a reference is usable, from the text Claude read off its image.
 *
 * @returns {{usable: boolean, words: number, reason: string|null, code: string|null}}
 */
export function assessReferenceUsability(claudeResult = {}, opts = {}) {
  const maxWords = Number.isFinite(opts.maxWords) ? opts.maxWords : REF_MAX_WORDS;
  const minWords = Number.isFinite(opts.minWords) ? opts.minWords : REF_MIN_WORDS;

  // Judge the ORIGINAL text — what is actually on the reference — never our
  // adapted copy, which is downstream of this decision.
  const orig = claudeResult?.original_text;
  if (!orig || typeof orig !== 'object') {
    // No reading to judge. Do not block on an absence of evidence.
    return { usable: true, words: 0, reason: null, code: null, skipped: 'no original_text to assess' };
  }

  const words = countTextWords(orig);

  // AD-TYPE requirement, when the caller asked for one ("promo only"). Judged by
  // Claude from the image in the same analysis, so this costs nothing extra.
  // Absent field (older stored prompt) => no opinion => never blocks.
  const wantType = opts.requireAdType ? String(opts.requireAdType).toLowerCase() : null;
  if (wantType) {
    const actual = claudeResult.reference_ad_type
      ? String(claudeResult.reference_ad_type).toLowerCase()
      : null;
    if (actual && actual !== wantType) {
      return {
        usable: false, words, code: 'REFERENCE_WRONG_AD_TYPE', adType: actual,
        reason: `Reference is a "${actual}" ad, not "${wantType}". A discount badge on an educational or problem/solution ad does not make it a promo — what the ad LEADS with is what counts. Skipped before image generation.`,
      };
    }
  }

  if (words > maxWords) {
    return {
      usable: false, words, code: 'REFERENCE_TOO_MUCH_TEXT',
      reason: `Reference carries ${words} words of on-image text (limit ${maxWords}). That is a long-form/story static — a different creative strategy that does not translate to a product card. Skipped before image generation.`,
    };
  }
  if (words < minWords) {
    return {
      usable: false, words, code: 'REFERENCE_NO_TEXT',
      reason: `Reference has no readable on-image text, so there is no winning text structure to adapt. This is also the signature of a mis-scraped image. Skipped before image generation.`,
    };
  }
  return { usable: true, words, reason: null, code: null };
}

// ─────────────────────────────────────────────────────────────────────────────
// OFFER CLAIMS
//
// Observed in prod 2026-08-14: a generated Puure static read "USE CODE:
// PUURE10". No such code exists — the product profile's discount_codes, offers
// and max_discount were all empty. Asked for a "Promo" angle with no offer data
// to work from, the model produced a plausible-looking one.
//
// That is not a cosmetic defect. A customer types a dead code at checkout, the
// sale is lost and support hears about it — and a "LIMITED TIME SALE" on a
// product sold at its normal price is a claim nobody wants to defend.
//
// Discount codes are the one offer claim that can be checked mechanically: a
// code is a literal string that either exists in the operator's profile or does
// not. Enforced here rather than only requested in the prompt, for the same
// reason as the text shape — a prompt is a request, this needs to be a
// guarantee. Everything softer (fake "was" prices, invented urgency) is covered
// by the prompt rule that ships alongside this.
// ─────────────────────────────────────────────────────────────────────────────

// Only treat a token as a code when it FOLLOWS a code-indicating word. A bare
// all-caps token would drag in "FDA", "TRIRED", "FREE" and every headline word.
const CODE_MENTION = /\b(?:use\s+)?(?:code|coupon|promo\s*code)\s*[:\-—]?\s*["“']?([A-Za-z0-9][A-Za-z0-9_-]{2,19})["”']?/gi;

/** Pull the authorised codes out of a free-text discount_codes field. */
export function extractAuthorisedCodes(discountCodesField) {
  if (!discountCodesField || typeof discountCodesField !== 'string') return [];
  // Codes are conventionally upper-case alphanumerics with at least one digit
  // or 4+ letters; take those, ignore prose around them.
  const out = new Set();
  for (const m of discountCodesField.matchAll(/\b([A-Z][A-Z0-9]{3,19})\b/g)) {
    const t = m[1];
    if (['ONLY','NEVER','THIS','CODE','THE','AND','WITH','OFF','FULL','PRICE','TOTAL'].includes(t)) continue;
    out.add(t);
  }
  return [...out];
}

/**
 * Strip or correct discount codes that the operator has not authorised.
 *
 * @returns {{result: Object, report: {removed: string[], substituted: Array, authorised: string[]}}}
 */
export function enforceOfferClaims(claudeResult = {}, product = {}) {
  const report = { removed: [], substituted: [], authorised: [] };
  const adapted = claudeResult?.adapted_text;
  if (!adapted || typeof adapted !== 'object') return { result: claudeResult, report };

  const p = product.profile || {};
  const authorised = extractAuthorisedCodes(p.discountCodes || p.discount_codes || product.discount_codes);
  report.authorised = authorised;
  const canonical = authorised.length === 1 ? authorised[0] : null;

  const fix = (text) => {
    if (typeof text !== 'string' || !text) return text;
    return text.replace(CODE_MENTION, (whole, code) => {
      if (authorised.some(a => a.toUpperCase() === code.toUpperCase())) return whole;
      if (canonical) {
        report.substituted.push({ from: code, to: canonical });
        return whole.replace(code, canonical);
      }
      // Nothing authorised — remove the entire code mention rather than leave a
      // dangling "USE CODE:" with no code after it.
      report.removed.push(code);
      return '';
    });
  };

  const next = { ...adapted };
  for (const f of TEXT_SCALARS) if (typeof next[f] === 'string') next[f] = fix(next[f]).replace(/\s{2,}/g, ' ').trim();
  for (const f of TEXT_ARRAYS) {
    if (Array.isArray(next[f])) {
      next[f] = next[f].map(x => (typeof x === 'string' ? fix(x).replace(/\s{2,}/g, ' ').trim() : x)).filter(x => x !== '');
    }
  }
  return { result: { ...claudeResult, adapted_text: next }, report };
}

/** One-line log summary for an offer report, or null when nothing changed. */
export function describeOfferReport(report) {
  if (!report) return null;
  const bits = [];
  if (report.substituted.length) {
    bits.push('replaced invented code(s) ' + report.substituted.map(s => `${s.from}→${s.to}`).join(', '));
  }
  if (report.removed.length) {
    bits.push(`removed unauthorised code mention(s): ${report.removed.join(', ')} (none authorised on this product)`);
  }
  return bits.length ? bits.join(' · ') : null;
}

/**
 * One-line summary of a shape report, or null when nothing changed.
 * Kept next to the enforcer so the log wording cannot drift from the logic.
 */
export function describeShapeReport(report) {
  if (!report) return null;
  const bits = [];
  if (report.textFreeRender) {
    bits.push(report.droppedFields.length
      ? `reference has NO text — dropped ${report.droppedFields.join(', ')} (text-free render)`
      : 'reference has no text — text-free render');
  }
  if (report.droppedFields.length && !report.textFreeRender) {
    bits.push(`dropped fields absent from the reference: ${report.droppedFields.join(', ')}`);
  }
  for (const t of report.truncatedArrays) bits.push(`${t.field} ${t.from}→${t.to} (reference count)`);
  for (const s of report.shortenedFields) bits.push(`${s.field} ${s.from}→${s.to} chars (reference ${s.referenceLength})`);
  return bits.length ? bits.join(' · ') : null;
}

export function buildNanoBananaImagePrompt(claudeResult = {}, product = {}, template = '', iterationVars = {}) {
  const hasProduct = claudeResult.reference_has_product_visual !== false;
  const productVisual = (claudeResult.product_visual_for_generation || '').trim();
  const peopleCount = claudeResult.people_count ?? 0;
  const characterAdaptation = (claudeResult.character_adaptation || '').trim()
    || (peopleCount === 0 ? 'No people in this ad' : 'Match the same demographics as the reference');

  // PRODUCT_INSTRUCTION — replaces section "1. PRODUCT" of the template
  let productInstruction;
  let productRule;
  if (hasProduct) {
    productInstruction =
`1. PRODUCT: Use the product image (the ONLY image attached) as the SOLE product reference. Render the product visually as follows: ${productVisual || `the ${product.name || 'product'} as shown in the input image`}.`;
    productRule = `- The product must appear prominently in the scene, matching the input product image exactly (shape, color, label, branding)
- NEVER overlay logo or brand marks directly ON TOP OF the physical product itself — any branding should be on the product's surface as designed, not added as floating text/graphics on top
- NEVER render the product in retail packaging (box, wrapper, blister pack) unless the reference image explicitly shows it in such packaging`;
  } else {
    productInstruction =
`1. PRODUCT: This ad is text-only / infographic — do NOT add a product visual. The scene must contain ZERO product objects.`;
    productRule = `- Do NOT add any product image, bottle, device, package, or physical object to the scene`;
  }

  // VISUAL_CHANGES — merged background + composition + visual_adaptations
  const bg = (claudeResult.background  || '').trim();
  const co = (claudeResult.composition || '').trim();
  const adaptations = Array.isArray(claudeResult.visual_adaptations)
    ? claudeResult.visual_adaptations
        .map(v => `- ${(v.original_visual || '').trim()} → ${(v.adapted_visual || '').trim()}${v.position ? ` (${v.position})` : ''}`)
        .join('\n')
    : '';
  const visualChanges = [
    bg ? `Background: ${bg}` : '',
    co ? `Composition: ${co}` : '',
    adaptations ? `Visual adaptations:\n${adaptations}` : '',
  ].filter(Boolean).join('\n');

  // TEXT_SWAPS — original_text → adapted_text by field
  const origText = claudeResult.original_text || {};
  const adaptedText = claudeResult.adapted_text || {};
  const textFields = ['headline', 'subheadline', 'body', 'cta'];
  const swapLines = [];
  for (const f of textFields) {
    const o = (origText[f] || '').trim();
    const a = (adaptedText[f] || '').trim();
    if (a) swapLines.push(`- ${f.toUpperCase()}: "${o}" → "${a}"`);
  }
  // Bullets array
  const oBullets = Array.isArray(origText.bullets) ? origText.bullets : [];
  const aBullets = Array.isArray(adaptedText.bullets) ? adaptedText.bullets : [];
  if (aBullets.length) {
    swapLines.push('- BULLETS:');
    for (let i = 0; i < aBullets.length; i++) {
      swapLines.push(`    "${(oBullets[i] || '').trim()}" → "${(aBullets[i] || '').trim()}"`);
    }
  }
  // Badges array
  const oBadges = Array.isArray(origText.badges) ? origText.badges : [];
  const aBadges = Array.isArray(adaptedText.badges) ? adaptedText.badges : [];
  if (aBadges.length) {
    swapLines.push('- BADGES:');
    for (let i = 0; i < aBadges.length; i++) {
      swapLines.push(`    "${(oBadges[i] || '').trim()}" → "${(aBadges[i] || '').trim()}"`);
    }
  }
  const textSwaps = swapLines.join('\n') || '(no text overlays — leave the ad text-free)';

  // Image-engine prompts also get the full product profile context — same
  // shape as buildClaudeAnalysisPrompt so the openai_image / nanobanana_image
  // templates can pull in Brand Voice, Big Promise, Angle, etc. to inform
  // the visual style (e.g. "render with the brand voice in mind"). Missing
  // values resolve to empty string per interpolate() semantics.
  const p = product.profile || {};
  const vars = {
    // Visual-brief fields (derived from Claude's analysis)
    PRODUCT_NAME:           product.name || '',
    PRODUCT_INSTRUCTION:    productInstruction,
    PRODUCT_RULE:           productRule,
    VISUAL_CHANGES:         visualChanges,
    TEXT_SWAPS:             textSwaps,
    PEOPLE_COUNT:           String(peopleCount),
    CHARACTER_ADAPTATION:   characterAdaptation,
    // Marketing / product-library context (same names as Claude prompt vars)
    SHORT_NAME:             p.short_name        || '',
    ONELINER:               p.oneliner          || '',
    TAGLINE:                p.tagline           || '',
    CATEGORY:               p.category          || '',
    PRODUCT_TYPE:           p.product_type      || '',
    PRODUCT_DESCRIPTION:    product.description || p.description || '',
    ANGLE:                  product._angle      || '',  // optional: caller stamps angle on product._angle
    BRAND_VOICE:            p.brand_voice       || '',
    CUSTOMER:               p.customer          || '',
    CUSTOMER_FRUSTRATION:   p.customer_frustration || '',
    CUSTOMER_DREAM:         p.customer_dream    || '',
    BIG_PROMISE:            p.big_promise       || '',
    DIFFERENTIATOR:         p.differentiator    || '',
    COMPETITIVE_EDGE:       p.competitive_edge  || '',
    UNIQUE_MECHANISM:       p.unique_mechanism  || '',
    KEY_BENEFITS:           p.key_benefits      || '',
    TARGET_AUDIENCE:        p.target_audience   || '',
    PAIN_POINTS:            p.pain_points       || '',
    OBJECTIONS:             p.objections        || '',
    GUARANTEE:              p.guarantee         || '',
    WINNING_ANGLES:         p.winning_angles    || '',
    CUSTOM_ANGLES:          p.custom_angles     || '',
    OFFER_HOOK:             p.offer_hook        || '',
    PRICING:                p.pricing           || product.price || '',
    COMPLIANCE:             p.compliance        || '',
    NOTES:                  p.notes             || '',
    // Iteration-specific vars — populated only when called from /iterate.
    // Resolve to empty string for fresh /generate calls.
    STRATEGY_LABEL:         iterationVars.STRATEGY_LABEL || '',
    VARIED:                 iterationVars.VARIED         || '',
    LOCKED:                 iterationVars.LOCKED         || '',
  };
  return interpolate(template, vars);
}

/**
 * Build the Step 3 (AI adjustment) prompt — turns user's freeform correction
 * into a precise NanoBanana regeneration instruction.
 *
 * @param {Object} claudeResult   — original Claude analysis (for headline/CTA/people_count)
 * @param {Object} product        — { name }
 * @param {string} angle
 * @param {string} userCorrection — freeform text from the user
 * @param {string} template       — DB-stored prompt template with {{VARS}}
 * @returns {string} interpolated prompt text
 */
export function buildAdjustmentPrompt(claudeResult = {}, product = {}, angle = '', userCorrection = '', template = '') {
  const adapted = claudeResult.adapted_text || {};
  const vars = {
    PRODUCT_NAME:      product.name || '',
    ANGLE:             angle || '',
    ADAPTED_HEADLINE:  (adapted.headline || '').trim(),
    ADAPTED_CTA:       (adapted.cta      || '').trim(),
    PEOPLE_COUNT:      String(claudeResult.people_count ?? 0),
    USER_CORRECTION:   (userCorrection   || '').trim(),
  };
  return interpolate(template, vars);
}

// ─────────────────────────────────────────────────────────────────────────────
// Template layout analysis (used by staticsTemplates.js for one-time
// template classification — NOT part of the user-editable prompt UI).
// Kept here because it's a code-internal helper, not a "setting".
// ─────────────────────────────────────────────────────────────────────────────
export function buildLayoutAnalysisPrompt() {
  return `You are a layout-analysis assistant. Inspect this static ad image and produce a strict JSON object describing its visual structure so we can later recreate it with a different product.

Respond ONLY with valid JSON in this exact shape (no prose, no markdown):
{
  "archetype": "lifestyle_product | testimonial | comparison | document | statistics | meme | feature_grid | other",
  "background": {
    "type": "solid | gradient | scene | text | photo",
    "primary_color": "hex or descriptive name",
    "description": "1 short sentence"
  },
  "layout": {
    "grid_structure": "single_column | two_column | three_column | hero_grid | asymmetric",
    "safe_zones": {
      "product_zone": { "position": "center | left | right | top | bottom | top-left | ...", "size_percent": 40 },
      "logo_zone":    { "position": "top-left | top-right | bottom-left | bottom-right | none" }
    }
  },
  "color_palette": {
    "overall_mood": "warm | cool | neutral | high-contrast | muted | vibrant",
    "dominant_colors": ["hex1", "hex2", "hex3"]
  },
  "design_elements": {
    "shadow_effects": "none | soft | hard | drop | inner",
    "borders": "none | thin | thick | rounded | sharp"
  },
  "adaptation_instructions": {
    "product_replacement_difficulty": "easy | medium | hard",
    "common_failure_modes": ["short string describing a likely failure"]
  }
}`;
}
