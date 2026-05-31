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
 * Replace {{VAR}} tokens in a template with values from `vars`.
 * Missing keys are replaced with empty string (silent — keeps templates flexible).
 */
export function interpolate(template, vars = {}) {
  if (typeof template !== 'string') return '';
  return template.replace(/\{\{([A-Z_]+)\}\}/g, (_, key) => {
    const v = vars[key];
    if (v === null || v === undefined) return '';
    if (typeof v === 'string') return v;
    if (typeof v === 'number' || typeof v === 'boolean') return String(v);
    if (Array.isArray(v)) return v.join(', ');
    return JSON.stringify(v);
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
    PRODUCT_IMAGE_NOTE:   extras.PRODUCT_IMAGE_NOTE || '',
    ...extras,
  };
  return interpolate(template, vars);
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
export function buildNanoBananaImagePrompt(claudeResult = {}, product = {}, template = '') {
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
    productRule = `- The product must appear prominently in the scene, matching the input product image exactly (shape, color, label, branding)`;
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
