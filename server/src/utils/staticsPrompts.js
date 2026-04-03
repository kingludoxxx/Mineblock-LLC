// ─────────────────────────────────────────────────────────────────────────────
// Standard Statics Generation Pipeline — Prompt Builders
// Follows the proven pipeline structure exactly
// ─────────────────────────────────────────────────────────────────────────────

// ─────────────────────────────────────────────────────────────────────────────
// STEP 1: Claude Vision — Copy Extraction + Rewriting
// ─────────────────────────────────────────────────────────────────────────────

export function buildClaudePrompt(product, angle, customOverrides = null) {
  const profile = product.profile || {};

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

  return `You are analyzing a reference ad image and rewriting its copy for a different product.

You will:
1. Extract every text element actually visible in the image
2. Count how many people and product shots appear
3. Rewrite every text element for the product below, preserving the exact copywriting formula
4. Identify what visual elements need to change

PRODUCT CONTEXT:
${contextLines}

---

TEXT EXTRACTION RULES:
- Only extract text ACTUALLY VISIBLE in the image — do NOT hallucinate text
- Progress/timeline labels ("Day 0", "Day 45", "Before", "After") are NOT extracted or swapped — they stay as-is
- Prices are extracted exactly and adapted with the real product price
- Multi-line headlines are kept as one string with natural line breaks
- Generic labels like "SPECIAL DEAL", "THIS WEEK ONLY", "FREE SHIPPING" stay exactly as-is

---

FORMULA PRESERVATION (the key concept):
The adapted text must follow the EXACT SAME sentence structure, opening words, and approximate word count as the original. You are copying the PROVEN FORMULA, just swapping the subject matter.

Examples:
- "Bye Bye, Beer Belly" → "Bye Bye, Gut Bloat" (keeps "Bye Bye,")
- "Kill The Bloated Belly" → "Kill The Aging Skin" (keeps "Kill The")
- "3 Years of Back Pain Gone in 7 Days" → "10 Years of Wrinkles Gone in 14 Days" (keeps the "[X] of [problem] Gone in [Y]" structure)
- "Now just £5 a bottle" → "Now just $24.95 a pouch" (keeps "Now just ... a [container]")
- Generic labels stay exactly as-is — do NOT adapt them

The adapted text count must EXACTLY MATCH the original count — same number of headlines, bullets, badges, stats. Do not add or remove any elements. Leave fields empty ("") if no corresponding text exists in the reference.

---

VISUAL ANALYSIS:
For each visual element in the ad, note:
- What it shows in the original (e.g. "3 belly transformation photos in grid")
- What it SHOULD show for the new product (e.g. "3 skin transformation photos showing improvement")
- Where it appears in the layout
- Whether it's generic (works for any product — keep as-is) or angle-specific (must change)

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

export function buildNanoBananaPrompt(claudeResult, swapPairs, product, logoCount = 0) {
  const {
    people_count, product_count, adapted_audience,
    character_adaptation, visual_adaptations
  } = claudeResult;

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

  return `Replicate the reference ad (LAST image) exactly, with only the product and text swapped.

The first image(s) show the replacement product — reproduce it EXACTLY as photographed. Multiple angles may be provided.
${logoCount > 0 ? '\nA brand logo is provided between the product photos and the reference ad. Use this EXACT logo where the competitor logo appears.' : ''}

1. REPLICATE the reference ad's layout, composition, background color/gradient, font styles, text positions, spacing, shadows, borders — pixel-perfect style match.

2. REPLACE the competitor's product with ${product.name} from the product photos. Show exactly ${pCount2} product(s) in the same position, matching shape, colors, and label exactly as photographed.

3. SWAP TEXT — only these specific pairs, matching original font style, weight, size, and color:
${swapSection || '  (No text changes)'}

4. ${characterRules}

5. VISUAL ADAPTATIONS:
${visualSection || '  (Keep all visuals as-is)'}

ABSOLUTE RULES:
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
}
