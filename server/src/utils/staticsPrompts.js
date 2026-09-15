import { fitNanoBananaPrompt } from '../services/imageGeneration.js';
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
  if (hasBible(product)) return buildBibleAnalysisPrompt(product, angle, template, extras);
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

// ── PRODUCT BIBLE ────────────────────────────────────────────────────────────
// A product sold into MARKETS carries `product._bible` = resolveStaticsBible(): { copy, image, angleDef, selection }.
// Then the market's bible is the product context INSTEAD of the legacy profile fields and the master brief (never
// both), and the chosen bible angle replaces the Product Library angle. Products without markets never carry
// `_bible`, so every builder below returns exactly what it returned before.
function hasBible(product) {
  const b = product && product._bible;
  return !!(b && b.copy && typeof b.copy.text === 'string' && b.angleDef && b.angleDef.name);
}

function renderBibleBlock(text) {
  return `\n\n===== PRODUCT BIBLE — THIS MARKET'S RESEARCH (primary source of truth: avatar, angle, customer language, claims) =====\n\n${text}`;
}

// Vars that stay from the product row when a bible applies: identity, physical facts and the operator's guardrails
// (discount codes are what enforceOfferClaims validates against; compliance is a hard rule). Price and URL come from
// the MARKET. Every other marketing field is the bible's job.
function bibleAnalysisVars(product, angleName, extras) {
  const p = product.profile || {};
  const b = product._bible;
  return {
    PRODUCT_NAME:   product.name || p.product_name || '',
    PRODUCT_PRICE:  b.copy.market?.price || product.price || p.price || '',
    PRICING:        b.copy.market?.price || product.price || p.price || '',
    PRODUCT_URL:    b.copy.market?.product_url || p.product_url || '',
    ANGLE:          angleName,
    SHORT_NAME:     p.short_name || '',
    PRODUCT_TYPE:   p.product_type || '',
    UNIT_DETAILS:   p.unit_details || '',
    // The market's own offer wins: a code for one market must never reach another market's ad.
    MAX_DISCOUNT:   b.offer ? (b.offer.discount || '') : (p.max_discount || ''),
    DISCOUNT_CODES: b.offer ? (b.offer.code || '') : (p.discount_codes || ''),
    OFFERS:         b.offer ? offerLines(b.offer).join(' | ') : '',
    OFFER_HOOK:     b.offer ? offerLines(b.offer).join(' | ') : '',
    COMPLIANCE:     p.compliance || '',
    MASTER_BRIEF:   '',
    PRODUCT_IMAGE_NOTE: extras.PRODUCT_IMAGE_NOTE || '',
    ...extras,
  };
}

function buildBibleAnalysisPrompt(product, angle, template, extras) {
  const def = product._bible.angleDef;
  // A caller may decorate the angle (an iteration appends its strategy); the base is always the bible angle.
  const angleName = typeof extras.ANGLE === 'string' && extras.ANGLE ? extras.ANGLE : def.name;
  return interpolate(template, bibleAnalysisVars(product, angleName, extras))
    + renderBibleBlock(product._bible.copy.text)
    + renderAngleDetailsBlock([def], def.name)
    + renderCommercialStructureBlock(product._bible.offer);
}

function offerLines(offer) {
  if (!offer) return [];
  return [
    offer.price && `Price: ${offer.price}`,
    offer.discount && `Discount: ${offer.discount}`,
    offer.code && `Discount code: ${offer.code}`,
    offer.savings && `Savings option (use instead of an original-vs-sale price): ${offer.savings}`,
    offer.notes && `Notes: ${offer.notes}`,
  ].filter(Boolean);
}

// Appended in code, after the store's (possibly older, customised) analysis template, so every bible static reads
// the reference's commercial structure and rebuilds it with this market's real offer.
export function renderCommercialStructureBlock(offer) {
  const terms = offerLines(offer);
  return `

===== COMMERCIAL STRUCTURE OF THE REFERENCE (this section overrides any earlier line about offers) =====

1. Decide what the reference LEADS WITH and add "reference_ad_type" to your JSON, one of:
   promo | urgency | problem_solution | testimonial | ugc | comparison | educational | other
   promo    the OFFER is the message: a discount, % off, sale price, savings amount or discount code is the
            headline or the main visual hook.
   urgency  the PRESSURE is the message: limited time, ends soon, last chance, countdown, selling fast,
            low stock, few left, high demand, back in stock.
   A discount with a deadline is "promo" and keeps its urgency element too. A small discount sticker on an
   ad that argues a problem or teaches something does not make it a promo.
   Also add "reference_offer_elements": the offer/urgency pieces you saw, e.g. ["20% OFF badge", "code in CTA"].

2. Rebuild the SAME commercial structure for our product in adapted_text:
   - promo: keep it a promo. Put our offer exactly where the reference puts its offer (headline, badge,
     sticker, price line, CTA) with the same weight. If the reference shows a code, show our code. If it shows
     an original price struck through next to a sale price and we have a savings option, use the savings
     option instead. The angle's pain or benefit becomes the supporting line.
   - urgency: keep the urgency or scarcity mechanic the reference uses, in the same place and with the same
     weight ("Selling fast", "Last chance", "Limited stock"). Add our offer too when the reference pairs its
     urgency with one. Never invent a specific date, clock time or stock number.
   - anything else: follow the angle; do not add an offer the reference does not have.

3. Our offer for this market. These are the ONLY commercial terms you may use:
${terms.length ? terms.map((t) => `   ${t}`).join('\n') : '   No discount or code exists for this market. A promo reference keeps its layout with our price only: no code, no percentage, no savings figure.'}
   Never write any other code, percentage or savings figure.

4. PRICES AND NUMBERS (overrides any earlier rule about writing amounts): write every price, discount, saving,
   percentage and count in digits with its symbol, exactly as a shopper reads it on a price tag: "$197",
   "$99", "20% OFF", "90 nights". Never spell an amount out in words ("One Hundred Ninety Seven Dollars",
   "Twenty Percent").`;
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
  // With a bible, only the selected market's code is authorised (a product can carry one code per market).
  const bibleOffer = product._bible && Object.prototype.hasOwnProperty.call(product._bible, 'offer') ? product._bible.offer : undefined;
  const authorised = bibleOffer !== undefined
    ? (bibleOffer?.code ? [String(bibleOffer.code).toUpperCase()] : extractAuthorisedCodes(p.discountCodes || p.discount_codes || product.discount_codes))
    : extractAuthorisedCodes(p.discountCodes || p.discount_codes || product.discount_codes);
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

// PRICES AS DIGITS — found live 2026-09-15: a store's saved analysis prompt still said "spell out any dollar
// amounts as words", and a promo static printed "SAVE UP TO One Hundred Ninety Seven Dollars". The prompt rule in
// renderCommercialStructureBlock fixed the offer line but a bullet still slipped through 1 run in 3, so the copy is
// also rewritten in code. Bible products only: legacy stores keep whatever their own prompt asks for.
const NUM_UNITS = { zero: 0, one: 1, two: 2, three: 3, four: 4, five: 5, six: 6, seven: 7, eight: 8, nine: 9, ten: 10,
  eleven: 11, twelve: 12, thirteen: 13, fourteen: 14, fifteen: 15, sixteen: 16, seventeen: 17, eighteen: 18, nineteen: 19 };
const NUM_TENS = { twenty: 20, thirty: 30, forty: 40, fifty: 50, sixty: 60, seventy: 70, eighty: 80, ninety: 90 };
const NUM_WORD = `(?:${[...Object.keys(NUM_UNITS), ...Object.keys(NUM_TENS), 'hundred', 'thousand'].join('|')})`;
const SPELLED_AMOUNT = new RegExp(`\\b(${NUM_WORD}(?:[\\s-]+(?:and[\\s-]+)?${NUM_WORD})*)[\\s-]+(dollars?|bucks|percent|per\\s+cent)\\b`, 'gi');

function wordsToNumber(phrase) {
  let total = 0; let current = 0;
  for (const w of phrase.toLowerCase().split(/[\s-]+/)) {
    if (w === 'and') continue;
    if (w in NUM_UNITS) current += NUM_UNITS[w];
    else if (w in NUM_TENS) current += NUM_TENS[w];
    else if (w === 'hundred') current = (current || 1) * 100;
    else if (w === 'thousand') { total += (current || 1) * 1000; current = 0; }
    else return null;
  }
  return total + current;
}

export function digitizeSpelledAmounts(text) {
  if (typeof text !== 'string' || !text) return text;
  return text.replace(SPELLED_AMOUNT, (whole, words, unit) => {
    const n = wordsToNumber(words);
    if (n === null) return whole;
    return /^per/i.test(unit) ? `${n}%` : `$${n}`;
  });
}

export function enforcePriceDigits(claudeResult = {}, product = {}) {
  const report = { changed: [] };
  const adapted = claudeResult?.adapted_text;
  if (!product?._bible || !adapted || typeof adapted !== 'object') return { result: claudeResult, report };
  const walk = (v) => {
    if (typeof v === 'string') {
      const out = digitizeSpelledAmounts(v);
      if (out !== v) report.changed.push({ from: v, to: out });
      return out;
    }
    if (Array.isArray(v)) return v.map(walk);
    if (v && typeof v === 'object') return Object.fromEntries(Object.entries(v).map(([k, x]) => [k, walk(x)]));
    return v;
  };
  return { result: { ...claudeResult, adapted_text: walk(adapted) }, report };
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

export function buildNanoBananaImagePrompt(claudeResult = {}, product = {}, template = '', iterationVars = {}, { maxChars = null, referenceCount = null } = {}) {
  if (hasBible(product) && product._bible.image && typeof product._bible.image.text === 'string') {
    return buildBibleImagePrompt(claudeResult, product, template, iterationVars, maxChars, referenceCount);
  }
  return buildLegacyImagePrompt(claudeResult, product, template, iterationVars, maxChars, referenceCount);
}

// ── PRODUCT REFERENCE PHOTOS ─────────────────────────────────────────────────
// Found live 2026-09-15: Reevo's product has 4 correct photos (box, open case with device, device on its patch, worn
// under the chin) but every image call sent ONE of them. 14 of 19 cards got only the box and the model drew a device
// and a charging case it had never seen. So every call sends up to MAX_PRODUCT_REFERENCES photos, the chosen shot
// first, and both prompts say to show only product objects that appear in the photos.
export const MAX_PRODUCT_REFERENCES = 5; // OpenAI edits take 16 inputs, Kie nano-banana edit 10

export function selectProductReferences(images, primaryIndex = 0, max = MAX_PRODUCT_REFERENCES) {
  let list = images;
  if (typeof list === 'string') { try { list = JSON.parse(list); } catch { return []; } }
  if (!Array.isArray(list)) return [];
  const urlOf = (e) => (typeof e === 'string' && e.length > 10 ? e : (e && typeof e === 'object' && typeof e.url === 'string' && e.url.length > 10 ? e.url : null));
  const order = Number.isInteger(primaryIndex) && primaryIndex >= 0 && primaryIndex < list.length
    ? [primaryIndex, ...list.map((_, i) => i).filter((i) => i !== primaryIndex)]
    : list.map((_, i) => i);
  const out = [];
  for (const i of order) {
    const u = urlOf(list[i]);
    if (u && !out.includes(u)) out.push(u);
    if (out.length >= max) break;
  }
  return out;
}

// Analysis-step note: the product photos follow the reference ad in the message, so they start at image 2.
export function productReferencesNote(count, { firstImageNumber = 2 } = {}) {
  if (!Number.isInteger(count) || count < 1) return '';
  const rule = 'Only describe product objects (device, case, box, packaging, patch, accessory) that you can see in these photos, with the shape, colour and branding they show. Never describe a product part, accessory or packaging that none of the photos shows, even if the product notes mention it.';
  if (count === 1) {
    return `\n\nIMAGE ${firstImageNumber} is a photo of OUR product. Use it as the visual source of truth for product_visual_for_generation. ${rule}`;
  }
  const last = firstImageNumber + count - 1;
  const labels = Array.from({ length: count }, (_, i) => `product photo ${i + 1} = image ${firstImageNumber + i}`).join(', ');
  return `\n\nIMAGES ${firstImageNumber} TO ${last} are ${count} photos of OUR product from different views (${labels}; photo 1 is the main shot). Use them together as the visual source of truth for product_visual_for_generation, and say which photo each product object comes from. ${rule}`;
}

// Image-step rule, placed first (with the brand rule) so no shortening can cut it.
function productReferencesRule(count) {
  const n = Number(count);
  const photos = n === 1 ? '1 PRODUCT PHOTO ATTACHED' : `${n} PRODUCT PHOTOS ATTACHED`;
  const which = n === 1 ? 'The attached image shows' : `Images 1 to ${n} all show {{PRODUCT_NAME}} from different views; image 1 is the main shot. Together they show`;
  return `${photos} (product reference rule, overrides the reference ad): ${which} exactly how every part of {{PRODUCT_NAME}} looks. Every product object in the scene (device, case, box, packaging, patch, accessory) must appear in at least one attached photo and match it exactly: shape, colour, material, proportions, label and branding. If the brief asks for a product object that no attached photo shows, leave it out. Never invent a product part, accessory, attachment, case or packaging.

`;
}

function buildLegacyImagePrompt(claudeResult, product, template, iterationVars, maxChars, referenceCount = null) {
  const refCount = Number.isInteger(referenceCount) && referenceCount >= 1 ? referenceCount : null;
  const hasProduct = claudeResult.reference_has_product_visual !== false;
  const productVisual = (claudeResult.product_visual_for_generation || '').trim();
  const peopleCount = claudeResult.people_count ?? 0;
  const characterAdaptation = (claudeResult.character_adaptation || '').trim()
    || (peopleCount === 0 ? 'No people in this ad' : 'Match the same demographics as the reference');

  // PRODUCT_INSTRUCTION — replaces section "1. PRODUCT" of the template
  let productInstruction;
  let productRule;
  if (hasProduct && refCount) {
    productInstruction = refCount === 1
      ? `1. PRODUCT: The attached photo is the product reference. Render the product visually as follows: ${productVisual || `the ${product.name || 'product'} as shown in the photo`}.`
      : `1. PRODUCT: ${refCount} product photos are attached (images 1 to ${refCount}, image 1 is the main shot). Use them together as the product reference. Render the product visually as follows: ${productVisual || `the ${product.name || 'product'} as shown in the photos`}.`;
    productRule = `- The product must appear prominently in the scene, matching the attached product photos exactly (shape, color, label, branding)
- Only show product objects that appear in the attached photos; never invent a part, accessory, case or packaging
- NEVER overlay logo or brand marks directly ON TOP OF the physical product itself — any branding should be on the product's surface as designed, not added as floating text/graphics on top
- NEVER render the product in retail packaging (box, wrapper, blister pack) unless the reference image or a product photo shows it`;
  } else if (hasProduct) {
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
  // The rule is prepended, so JSON-escaping is decided by the operator's template as it was, not by the rule's text.
  const jsonSafe = typeof template === 'string' && template.trimStart().startsWith('{');
  const lead = refCount && hasProduct ? productReferencesRule(refCount) + OTHER_BRANDS_RULE : OTHER_BRANDS_RULE;
  return fitImagePrompt(lead + (template || ''), vars, maxChars, jsonSafe);
}

// Marketing vars an image template may reference. With a bible they are emptied: the static_image pack carries the
// market's avatar, angle and customer language instead (the analysis step already wrote the copy from static_copy).
const BIBLE_BLANKED_IMAGE_VARS = ['ONELINER', 'TAGLINE', 'CATEGORY', 'PRODUCT_DESCRIPTION', 'BRAND_VOICE', 'CUSTOMER',
  'CUSTOMER_FRUSTRATION', 'CUSTOMER_DREAM', 'BIG_PROMISE', 'DIFFERENTIATOR', 'COMPETITIVE_EDGE', 'UNIQUE_MECHANISM',
  'KEY_BENEFITS', 'TARGET_AUDIENCE', 'PAIN_POINTS', 'OBJECTIONS', 'GUARANTEE', 'WINNING_ANGLES', 'CUSTOM_ANGLES',
  'OFFER_HOOK', 'NOTES'];
// The pack never takes the prompt below this many characters of its own, and never pushes the copy out: when the
// budget is tight the operator's template (with its copy lines) is fitted first and the pack gets what is left.
const MIN_BIBLE_IMAGE_CHARS = 300;

function trimBlockTo(text, limit) {
  if (text.length <= limit) return text;
  if (limit <= 0) return '';
  const cut = text.slice(0, Math.max(0, limit - 13));
  const at = cut.lastIndexOf('\n');
  return `${at > limit * 0.5 ? cut.slice(0, at) : cut}\n[...trimmed]`;
}

function buildBibleImagePrompt(claudeResult, product, template, iterationVars, maxChars, referenceCount = null) {
  const def = product._bible.angleDef;
  const profile = { ...(product.profile || {}) };
  const legacyKeys = { ONELINER: 'oneliner', TAGLINE: 'tagline', CATEGORY: 'category', BRAND_VOICE: 'brand_voice', CUSTOMER: 'customer',
    CUSTOMER_FRUSTRATION: 'customer_frustration', CUSTOMER_DREAM: 'customer_dream', BIG_PROMISE: 'big_promise', DIFFERENTIATOR: 'differentiator',
    COMPETITIVE_EDGE: 'competitive_edge', UNIQUE_MECHANISM: 'unique_mechanism', KEY_BENEFITS: 'key_benefits', TARGET_AUDIENCE: 'target_audience',
    PAIN_POINTS: 'pain_points', OBJECTIONS: 'objections', GUARANTEE: 'guarantee', WINNING_ANGLES: 'winning_angles', CUSTOM_ANGLES: 'custom_angles',
    OFFER_HOOK: 'offer_hook', NOTES: 'notes', PRODUCT_DESCRIPTION: 'description' };
  for (const k of BIBLE_BLANKED_IMAGE_VARS) profile[legacyKeys[k]] = '';
  profile.pricing = product._bible.copy.market?.price || profile.pricing || '';
  const stripped = { ...product, description: '', price: product._bible.copy.market?.price || product.price, profile, _angle: String(product._angle || '').startsWith(def.name) ? product._angle : def.name };
  const block = renderBibleBlock(product._bible.image.text);
  if (!maxChars) return buildLegacyImagePrompt(claudeResult, stripped, template, iterationVars, null, referenceCount) + block;
  let base = buildLegacyImagePrompt(claudeResult, stripped, template, iterationVars, maxChars, referenceCount);
  if (maxChars - base.length < MIN_BIBLE_IMAGE_CHARS) {
    base = buildLegacyImagePrompt(claudeResult, stripped, template, iterationVars, Math.max(1, maxChars - MIN_BIBLE_IMAGE_CHARS), referenceCount);
  }
  const room = maxChars - base.length;
  const fitted = trimBlockTo(block, room);
  return fitted ? base + fitted : base;
}

// Other companies' brands (legal). Found live 2026-09-13: a reference with competitor packs blurred came back with
// their names printed legibly, because no prompt said otherwise. First in the prompt so no shortening can cut it.
const OTHER_BRANDS_RULE = `OTHER BRANDS (legal rule, overrides the reference): only {{PRODUCT_NAME}} may show a readable brand name or logo. Any other product, package or logo (anything that is not {{PRODUCT_NAME}}) must be generic: if the reference shows it blurred or obscured, keep it blurred or obscured; if the reference shows it readable, render it unbranded with no legible name or logo. Never write a real competitor's brand name anywhere in the image.

`;

// Product-knowledge fields an image prompt may carry for context. When the prompt is over the engine's limit these
// are shortened, longest first; the copy (TEXT_SWAPS), the visual brief, the angle and COMPLIANCE never are.
// Found live 2026-09-13: a full knowledge base pushed an OpenAI prompt to 32,208 chars (limit 32,000) and every
// generation for that product failed. The copy was already written by the analysis step from the full record.
const SHORTENABLE_IMAGE_VARS = ['WINNING_ANGLES', 'NOTES', 'CUSTOM_ANGLES', 'COMPETITIVE_EDGE', 'PAIN_POINTS', 'OBJECTIONS',
  'CUSTOMER', 'CUSTOMER_FRUSTRATION', 'CUSTOMER_DREAM', 'KEY_BENEFITS', 'TARGET_AUDIENCE', 'PRODUCT_DESCRIPTION',
  'DIFFERENTIATOR', 'UNIQUE_MECHANISM', 'BRAND_VOICE', 'GUARANTEE', 'OFFER_HOOK'];
const SHORTENED_MARK = ' [shortened]';
const MIN_SHORTENED = 400;

function fitImagePrompt(template, vars, maxChars, jsonSafe = false) {
  let out = interpolate(template, vars, { jsonSafe });
  if (!maxChars || out.length <= maxChars) return out;
  const v = { ...vars };
  for (let guard = 0; guard < 50 && out.length > maxChars; guard++) {
    const candidates = SHORTENABLE_IMAGE_VARS
      .filter((k) => typeof v[k] === 'string' && v[k].length > MIN_SHORTENED + SHORTENED_MARK.length && template.includes(`{{${k}}}`))
      .sort((a, b) => v[b].length - v[a].length);
    if (!candidates.length) break;
    const k = candidates[0];
    const uses = template.split(`{{${k}}}`).length - 1;
    const over = out.length - maxChars;
    const keep = Math.max(MIN_SHORTENED, v[k].length - Math.ceil(over / uses) - SHORTENED_MARK.length);
    v[k] = v[k].slice(0, keep) + SHORTENED_MARK;
    out = interpolate(template, v, { jsonSafe });
  }
  // The fixed parts alone are over the limit: cut at a line boundary, keeping the copy lines (same rule as the
  // NanoBanana submit path).
  return out.length > maxChars ? fitNanoBananaPrompt(out, maxChars).prompt : out;
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
