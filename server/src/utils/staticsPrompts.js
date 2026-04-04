// ─────────────────────────────────────────────────────────────────────────────
// Standard Statics Generation Pipeline — Prompt Builders
// Follows the proven pipeline structure exactly
// ─────────────────────────────────────────────────────────────────────────────

// ─────────────────────────────────────────────────────────────────────────────
// STEP 1: Claude Vision — Copy Extraction + Rewriting
// ─────────────────────────────────────────────────────────────────────────────

export function buildClaudePrompt(product, angle, customOverrides = null) {
  const profile = product.profile || {};
  const co = customOverrides?.claudeAnalysis || {};

  // Build product context from all available profile fields
  const contextLines = [
    `Product Name: ${product.name}`,
    `Description: ${product.description || 'N/A'}`,
    `Price: ${product.price || 'N/A'}`,
    profile.oneliner && `One-liner: ${profile.oneliner}`,
    profile.customerAvatar && `Target Customer: ${profile.customerAvatar}`,
    profile.customerFrustration && `Customer Frustration: ${profile.customerFrustration}`,
    profile.customerDream && `Customer Dream Outcome: ${profile.customerDream}`,
    profile.bigPromise && `Big Promise: ${profile.bigPromise}`,
    profile.mechanism && `How It Works: ${profile.mechanism}`,
    Array.isArray(profile.benefits) && profile.benefits.length > 0
      && `Key Benefits: ${profile.benefits.map(b => typeof b === 'object' ? (b.text || b.name || b) : b).join(', ')}`,
    profile.differentiator && `Differentiator: ${profile.differentiator}`,
    profile.voice && `Brand Voice/Tone: ${profile.voice}`,
    profile.guarantee && `Guarantee: ${profile.guarantee}`,
    profile.painPoints && `Pain Points: ${profile.painPoints}`,
    profile.commonObjections && `Common Objections: ${profile.commonObjections}`,
    profile.winningAngles && `Winning Angles: ${profile.winningAngles}`,
    profile.competitiveEdge && `Competitive Edge: ${profile.competitiveEdge}`,
    profile.maxDiscount && `Max Discount: ${profile.maxDiscount}`,
    profile.discountCodes && `Discount Codes: ${profile.discountCodes}`,
    profile.bundleVariants && `Bundle Variants: ${profile.bundleVariants}`,
    profile.offerDetails && `Offer Rules: ${profile.offerDetails}`,
    profile.complianceRestrictions && `COMPLIANCE (never claim): ${profile.complianceRestrictions}`,
    profile.notes && `IMPORTANT NOTES: ${profile.notes}`,
    angle && `MARKETING ANGLE FOR THIS AD: ${angle}`,
  ].filter(Boolean).map(l => `- ${l}`).join('\n');

  // Build brand colors / fonts section if available
  const brandLines = [];
  if (product.brand_colors && Object.keys(product.brand_colors).length > 0) {
    brandLines.push(`Brand Colors: ${JSON.stringify(product.brand_colors)}`);
  }
  if (product.fonts && product.fonts.length > 0) {
    brandLines.push(`Brand Fonts: ${product.fonts.join(', ')}`);
  }
  const brandSection = brandLines.length > 0
    ? `\n\nBRAND IDENTITY:\n${brandLines.map(l => `- ${l}`).join('\n')}`
    : '';

  // Product identity rules (critical for correct product representation)
  const productIdentity = co.productIdentity
    ? `\n\n---\n\nPRODUCT IDENTITY (READ CAREFULLY):\n${co.productIdentity}`
    : '';

  // Pricing rules
  const pricingRules = co.pricingRules
    ? `\n\n---\n\n${co.pricingRules}`
    : '';

  // Headline rules for better ad copy
  const headlineRules = co.headlineRules
    ? `\n\n---\n\nHEADLINE WRITING RULES:\n${co.headlineRules}`
    : '';

  // Headline examples
  const headlineExamples = co.headlineExamples
    ? `\n\n${co.headlineExamples}`
    : '';

  // Banned phrases
  const bannedPhrases = co.bannedPhrases
    ? `\n\nBANNED PHRASES (NEVER use these in any adapted text): ${co.bannedPhrases}`
    : '';

  // Formula preservation (use custom if available, otherwise default)
  const formulaSection = co.formulaPreservation || `FORMULA PRESERVATION (the key concept):
The adapted text must follow the EXACT SAME sentence structure, opening words, and approximate word count as the original. You are copying the PROVEN FORMULA, just swapping the subject matter.

Examples:
- "Bye Bye, Beer Belly" → "Bye Bye, Power Bills" (keeps "Bye Bye,")
- "Kill The Bloated Belly" → "Kill The Middleman" (keeps "Kill The")
- "3 Years of Back Pain Gone in 7 Days" → "3 Years of Missing Gains Gone in 7 Days"
- "Now just £5 a bottle" → "Now just $59.99 a unit" (keeps "Now just ... a [container]")
- Generic labels stay exactly as-is — do NOT adapt them

The adapted text count must EXACTLY MATCH the original count — same number of headlines, bullets, badges, stats. Do not add or remove any elements. Leave fields empty ("") if no corresponding text exists in the reference.`;

  // Cross-niche visual mapping
  const crossNicheSection = co.crossNicheAdaptation
    ? `\n\n---\n\n${co.crossNicheAdaptation}`
    : '';

  // Visual adaptation rules
  const visualAdaptationRules = co.visualAdaptation
    ? `\n\n${co.visualAdaptation}`
    : '';

  return `You are an expert direct-response copywriter analyzing a reference ad image and rewriting its copy for a different product. You write like a human media buyer — punchy, native-sounding, scroll-stopping ad copy that converts. NEVER write generic, safe, or AI-sounding text.

You will:
1. Extract every text element actually visible in the image — be meticulous, miss NOTHING
2. Count how many people and product shots appear
3. Rewrite every text element for the product below, preserving the exact copywriting formula but making it sound HUMAN and AGGRESSIVE (like a real paid ad, not a product description)
4. Identify what visual elements need to change

PRODUCT CONTEXT:
${contextLines}${brandSection}${productIdentity}${pricingRules}

---

TEXT EXTRACTION RULES:
- Only extract text ACTUALLY VISIBLE in the image — do NOT hallucinate text
- Extract ALL text including: brand name, headline, subheadline, body text, CTA buttons, review counts, star ratings, price badges, discount percentages, feature callouts, comparison labels, fine print
- Progress/timeline labels ("Day 0", "Day 45", "Before", "After") are NOT extracted or swapped — they stay as-is
- Prices are extracted exactly and adapted with the real product price
- Multi-line headlines are kept as one string with natural line breaks
- Generic labels like "SPECIAL DEAL", "THIS WEEK ONLY", "FREE SHIPPING" stay exactly as-is

---${headlineRules}${headlineExamples}${bannedPhrases}

---

${formulaSection}

---

COPYWRITING QUALITY RULES:
- The adapted copy must sound like a REAL HUMAN wrote it for a real paid ad — NOT like AI generated it
- Use conversational, punchy language that creates urgency and desire
- The headline is the #1 most important element — it must be scroll-stopping and specific
- Include concrete numbers, dollar amounts, or timeframes whenever the original does
- NEVER use bland, generic phrases — every word must earn its place
- Read the adapted text out loud — if it sounds corporate, robotic, or like a product manual, REWRITE IT
- Match the ENERGY and INTENSITY of the original ad — if the original is aggressive, be equally aggressive

---

VISUAL ANALYSIS:
For each visual element in the ad, note:
- What it shows in the original (e.g. "3 belly transformation photos in grid")
- What it SHOULD show for the new product
- Where it appears in the layout
- Whether it's generic (works for any product — keep as-is) or angle-specific (must change)${crossNicheSection}${visualAdaptationRules}

---

Return ONLY valid JSON (no markdown, no code fences):
{
  "original_text": {
    "headline": "",
    "subheadline": "",
    "body": "",
    "cta": "",
    "badges": [],
    "bullets": [],
    "stats": [],
    "other_text": []
  },
  "adapted_text": {
    "headline": "",
    "subheadline": "",
    "body": "",
    "cta": "",
    "badges": [],
    "bullets": [],
    "stats": [],
    "other_text": []
  },
  "people_count": 0,
  "product_count": 0,
  "adapted_audience": "description of target demographic for people in ad",
  "character_adaptation": "how to adapt people shown (age, gender, style)",
  "visual_adaptations": [
    {
      "original_visual": "what the image shows in the reference",
      "adapted_visual": "what it should show for this product",
      "position": "where in the layout",
      "is_angle_specific": true
    }
  ]
}`;
}

// ─────────────────────────────────────────────────────────────────────────────
// STEP 2: Build swap pairs from Claude's original vs adapted text
// ─────────────────────────────────────────────────────────────────────────────

export function buildSwapPairs(originalText, adaptedText) {
  const pairs = [];

  // Standard text fields
  for (const field of ['headline', 'subheadline', 'body', 'cta', 'disclaimer']) {
    const orig = originalText[field], adapted = adaptedText[field];
    if (orig && adapted && orig.trim() !== adapted.trim())
      pairs.push({ original: orig.trim(), adapted: adapted.trim(), field });
  }

  // Array fields
  for (const field of ['badges', 'bullets', 'stats', 'other_text', 'comparison_labels', 'ingredient_labels', 'timeline_labels']) {
    const origArr = originalText[field] || [], adaptedArr = adaptedText[field] || [];
    for (let i = 0; i < Math.min(origArr.length, adaptedArr.length); i++) {
      if (origArr[i] && adaptedArr[i] && origArr[i].trim() !== adaptedArr[i].trim())
        pairs.push({ original: origArr[i].trim(), adapted: adaptedArr[i].trim(), field: `${field}[${i}]` });
    }
  }

  return pairs;
}

// ─────────────────────────────────────────────────────────────────────────────
// STEP 3: NanoBanana (Gemini) — Image Generation Prompt
// ─────────────────────────────────────────────────────────────────────────────

export function buildNanoBananaPrompt(claudeResult, swapPairs, product, logoCount = 0, customOverrides = null) {
  const {
    people_count, product_count, adapted_audience,
    character_adaptation, visual_adaptations
  } = claudeResult;
  const co = customOverrides?.nanoBanana || {};

  const pCount = people_count ?? 0;
  const pCount2 = product_count ?? 1;

  // Text swap pairs
  const swapSection = swapPairs.map((pair, i) =>
    `  ${i + 1}. "${pair.original}" → "${pair.adapted}"`
  ).join('\n');

  // Character/demographic rules
  let characterRules;
  if (pCount === 0) {
    characterRules = 'There are NO people in the reference ad. Do NOT add any human faces or bodies.';
  } else {
    characterRules = `The reference has EXACTLY ${pCount} person(s). Your output must have EXACTLY ${pCount}. Use DIFFERENT person(s) of same gender/age range. Do NOT add extra faces.`;
    if (adapted_audience) characterRules += ` Target: ${adapted_audience}.`;
    if (character_adaptation) characterRules += ` ${character_adaptation}.`;
  }

  // Visual adaptation instructions
  const visualSection = (visual_adaptations || []).map((v, i) =>
    `  ${i + 1}. ${v.position}: "${v.original_visual}" → "${v.adapted_visual}"${v.is_angle_specific ? ' [MUST CHANGE]' : ' [keep as-is]'}`
  ).join('\n');

  // Use custom product rules if available
  const productRulesSection = co.productRules
    ? `\n${co.productRules}`
    : '';

  // Use custom text rules if available
  const textRulesSection = co.textRules
    ? `\n\n${co.textRules}`
    : '';

  // Brand identity section for color/font matching
  const brandIdentityLines = [];
  if (product.brand_colors && Object.keys(product.brand_colors).length > 0) {
    brandIdentityLines.push(`Brand Colors: ${JSON.stringify(product.brand_colors)} — use these exact colors for any branded elements (backgrounds, accents, text highlights, badges)`);
  }
  if (product.fonts && product.fonts.length > 0) {
    brandIdentityLines.push(`Brand Fonts: ${product.fonts.join(', ')} — use these fonts for the adapted text where possible`);
  }
  const brandIdentitySection = brandIdentityLines.length > 0
    ? `\n6. BRAND IDENTITY:\n${brandIdentityLines.map(l => `  - ${l}`).join('\n')}\n`
    : '';

  // Use custom absolute rules, or the defaults
  const absoluteRulesSection = co.absoluteRules || `ABSOLUTE RULES:
- Product integrity is highest priority — pixel-perfect fidelity to product photos
- Zero extra faces beyond reference count
- Zero extra text elements beyond swap count — do NOT add text that isn't in the swap list
- No duplicate objects
- Layout labels (Day 0, Day 45, Before, After, etc.) stay exactly as-is
- No trace of competitor product or brand remaining
- Exact same background color/gradient/texture
- Hands must have 5 fingers, realistic anatomy
- Do NOT place any text, logo, or overlay on the product itself
- Do NOT invent or generate any logo, icon, emblem, or symbol${logoCount > 0 ? ' beyond the provided logo' : ''}`;

  return `Replicate the reference ad (LAST image) exactly, with only the product and text swapped.

The first image(s) show the replacement product — reproduce it EXACTLY as photographed. Multiple angles may be provided.
${logoCount > 0 ? '\nA brand logo is provided between the product photos and the reference ad. Use this EXACT logo where the competitor logo appears. Copy the logo PIXEL-FOR-PIXEL from the provided logo image — do NOT redraw, stylize, or approximate it. The logo must be an exact reproduction.' : ''}

1. REPLICATE the reference ad's layout, composition, background color/gradient, font styles, text positions, spacing, shadows, borders — match the reference style exactly.

2. REPLACE the competitor's product with ${product.name} from the product photos. Show exactly ${pCount2} product(s) in the same position, matching shape, colors, and label exactly as photographed.${productRulesSection}

3. SWAP TEXT — only these specific pairs, matching original font style, weight, size, and color:
${swapSection || '  (No text changes)'}
CRITICAL TEXT RENDERING: Every letter must be sharp, legible, and CORRECTLY SPELLED. Render text as clean, professional typography — NOT blurry, warped, or distorted. If a word has specific spelling, get EVERY letter right.${textRulesSection}

4. ${characterRules}

5. VISUAL ADAPTATIONS:
${visualSection || '  (Keep all visuals as-is)'}
${brandIdentitySection}
${absoluteRulesSection}`;
}
