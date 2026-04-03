// ─────────────────────────────────────────────────────────────────────────────
// Static Ad Generation — Prompt Builders
// Based on the proven Standard Statics Generation Pipeline structure
// ─────────────────────────────────────────────────────────────────────────────

function stripUsb(text) {
  if (!text) return text;
  return text
    .replace(/\bUSB[-\s]?C?\b/gi, '')
    .replace(/\bflash\s*drive\b/gi, '')
    .replace(/\bthumb\s*drive\b/gi, '')
    .replace(/\s{2,}/g, ' ')
    .trim();
}

// ─────────────────────────────────────────────────────────────────────────────
// STEP 1: Claude Vision — Copy Extraction + Rewriting
// ─────────────────────────────────────────────────────────────────────────────

export function buildClaudePrompt(product, angle, customOverrides = null) {
  const profile = product.profile || {};
  const co = customOverrides?.claudeAnalysis || {};

  // Build product context from profile fields
  const productContext = [
    `Product Name: ${product.name}`,
    `Description: ${stripUsb(product.description) || 'N/A'}`,
    `Price: ${product.price || 'N/A'}`,
    profile.oneliner ? `One-liner: ${stripUsb(profile.oneliner)}` : null,
    profile.customerAvatar ? `Target Customer: ${profile.customerAvatar}` : null,
    profile.customerFrustration ? `Customer Frustration: ${profile.customerFrustration}` : null,
    profile.customerDream ? `Customer Dream Outcome: ${profile.customerDream}` : null,
    profile.bigPromise ? `Big Promise: ${stripUsb(profile.bigPromise)}` : null,
    profile.mechanism ? `Unique Mechanism: ${stripUsb(profile.mechanism)}` : null,
    Array.isArray(profile.benefits) && profile.benefits.length > 0
      ? `Key Benefits: ${profile.benefits.map(b => typeof b === 'object' ? (b.text || b.name || b) : b).join(', ')}`
      : profile.benefits ? `Key Benefits: ${profile.benefits}` : null,
    profile.differentiator ? `Differentiator: ${stripUsb(profile.differentiator)}` : null,
    profile.voice ? `Voice/Tone: ${profile.voice}` : null,
    profile.guarantee ? `Guarantee: ${profile.guarantee}` : null,
    profile.painPoints ? `Pain Points: ${profile.painPoints}` : null,
    profile.commonObjections ? `Common Objections: ${profile.commonObjections}` : null,
    profile.winningAngles ? `Winning Angles: ${profile.winningAngles}` : null,
    profile.competitiveEdge ? `Competitive Edge: ${profile.competitiveEdge}` : null,
    profile.maxDiscount ? `Max Discount: ${profile.maxDiscount}` : null,
    profile.discountCodes ? `Discount Codes: ${profile.discountCodes}` : null,
    profile.bundleVariants ? `Bundle Variants: ${profile.bundleVariants}` : null,
    profile.offerDetails ? `Offer Rules: ${profile.offerDetails}` : null,
    profile.complianceRestrictions ? `COMPLIANCE (NEVER claim): ${profile.complianceRestrictions}` : null,
    profile.notes ? `IMPORTANT NOTES: ${profile.notes}` : null,
    angle ? `MARKETING ANGLE FOR THIS AD: ${angle}` : null,
  ].filter(Boolean).map(line => `- ${line}`).join('\n');

  return `You are analyzing a reference ad image and rewriting its copy for a different product. You will:
1. Extract every text element visible in the image
2. Count people and product shots
3. Rewrite every text element for the product below, preserving the exact copywriting formula
4. Identify what visual elements need to change

PRODUCT CONTEXT:
${productContext}

${co.productIdentity || `PRODUCT IDENTITY: The product is a MINI BITCOIN MINER — a small, compact electronic device with a color display screen showing mining hashrate data. It is NOT a USB stick, flash drive, or thumb drive.`}

---

TEXT EXTRACTION RULES:
- Only extract text ACTUALLY VISIBLE in the image — do NOT hallucinate text
- Extract the competitor brand name and product descriptor as separate fields
- Progress/timeline labels ("Day 0", "Day 45", "Before", "After") are NOT extracted or swapped — they stay as-is
- Prices are extracted exactly and adapted with the real product price
- Multi-line headlines are kept as one string
- Generic labels ("SPECIAL DEAL", "FREE SHIPPING", "THIS WEEK ONLY") stay exactly as-is

---

FORMULA PRESERVATION (the key concept):
The adapted text must follow the EXACT SAME sentence structure, opening words, and approximate word count as the original. You are copying the PROVEN FORMULA, not inventing new copy.

Examples:
- "Bye Bye, Beer Belly" → "Bye Bye, Gut Bloat" (keeps "Bye Bye,")
- "Kill The Bloated Belly" → "Kill The Aging Skin" (keeps "Kill The")
- "3 Years of Back Pain Gone in 7 Days" → "10 Years of Wrinkles Gone in 14 Days" (keeps the structure)
- "Now just £5 a bottle" → "Now just $59.99 a unit" (keeps "Now just ... a [container]")
- "Doctor's #1 Recommendation" → keeps same structure with adapted authority

The adapted text count must EXACTLY MATCH the original — same number of headlines, bullets, badges, labels. Do not add or remove any text elements. Leave fields empty ("") if no corresponding text exists.

---

COPY QUALITY:
Your adapted copy must sound like a REAL direct-response copywriter wrote it — specific, concrete, benefit-driven. Use real product facts from the product context above.

Write like this:
- "Mines Bitcoin 24/7 — even while you sleep"
- "144 block attempts every single day"
- "Uses less power than a phone charger"
- "$300K+ block reward potential"
- "Plug in, connect WiFi, mine in 60 seconds"

NEVER write generic AI copy like:
- "Like printing money daily" (cliché)
- "Unleash your mining potential" (generic)
- "Revolutionary passive income" (meaningless hype)
- "Your 24/7 profit machine" (scammy)
- "Game-changing technology" (empty)

If it sounds like ChatGPT wrote it, rewrite it with SPECIFIC details from the product context.

---

VISUAL ANALYSIS:
For each visual element, note:
- What it shows in the original
- What it SHOULD show for this product
- Whether it's generic (keep as-is) or angle-specific (must change)

---

Return ONLY valid JSON (no markdown, no code fences):
{
  "original_text": {
    "brand_name": "",
    "product_descriptor": "",
    "headline": "",
    "subheadline": "",
    "body": "",
    "cta": "",
    "comparison_labels": [],
    "ingredient_labels": [],
    "timeline_labels": [],
    "badges": [],
    "bullets": [],
    "stats": [],
    "disclaimer": "",
    "other_text": []
  },
  "adapted_text": {
    "brand_name": "",
    "product_descriptor": "",
    "headline": "",
    "subheadline": "",
    "body": "",
    "cta": "",
    "comparison_labels": [],
    "ingredient_labels": [],
    "timeline_labels": [],
    "badges": [],
    "bullets": [],
    "stats": [],
    "disclaimer": "",
    "other_text": []
  },
  "people_count": 0,
  "product_count": 0,
  "adapted_audience": "",
  "character_adaptation": "",
  "visual_adaptations": [
    {
      "original_visual": "what the image shows",
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

export function buildSwapPairs(originalText, adaptedText, claudeResult = null) {
  const pairs = [];

  // Brand name and product descriptor first — #1 cause of leftover competitor text
  for (const field of ['brand_name', 'product_descriptor']) {
    const orig = originalText[field], adapted = adaptedText[field];
    if (orig && adapted && orig.trim() !== adapted.trim())
      pairs.push({ original: orig.trim(), adapted: adapted.trim(), field });
  }

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

  // Fallback: extract brand name from brand_elements if not in original_text
  if (claudeResult?.brand_elements) {
    const be = claudeResult.brand_elements;
    const hasBrandSwap = pairs.some(p => p.field === 'brand_name');
    if (!hasBrandSwap && be.brand_name) {
      const brandName = typeof be.brand_name === 'string' ? be.brand_name.trim() : '';
      if (brandName && brandName.toLowerCase() !== (adaptedText.brand_name || '').toLowerCase()) {
        pairs.unshift({
          original: brandName,
          adapted: adaptedText.brand_name || claudeResult.adapted_text?.brand_name || '',
          field: 'brand_name (from brand_elements)'
        });
      }
    }
  }

  return pairs;
}

// ─────────────────────────────────────────────────────────────────────────────
// STEP 3: NanoBanana (Gemini) — Image Generation Prompt
// ─────────────────────────────────────────────────────────────────────────────

export function buildNanoBananaPrompt(claudeResult, swapPairs, product, logoCount = 0, customOverrides = null) {
  const {
    adapted_text, people_count, product_count, adapted_audience,
    character_adaptation, visual_adaptations
  } = claudeResult;

  const pCount = people_count ?? 0;
  const pCount2 = product_count ?? 1;

  // Build swap section — "original" → "new" pairs
  const swapSection = swapPairs.map((pair, i) =>
    `  ${i + 1}. "${pair.original}" → "${pair.adapted}"`
  ).join('\n');

  // Character rules
  const characterRules = pCount === 0
    ? 'There are NO people in the reference ad. Do NOT add any human faces or bodies.'
    : `The reference has EXACTLY ${pCount} person(s). Your output must have EXACTLY ${pCount}. Use DIFFERENT person(s) of same gender/age range. Do NOT add extra faces.${adapted_audience ? ' ' + adapted_audience : ''}${character_adaptation ? ' ' + character_adaptation : ''}`;

  // Visual adaptation rules
  const visualAdaptSection = (visual_adaptations || []).map((v, i) =>
    `  ${i + 1}. ${v.position}: "${v.original_visual}" → "${v.adapted_visual}"${v.is_angle_specific ? ' [MUST CHANGE]' : ' [keep as-is]'}`
  ).join('\n');

  // Logo rules
  const logoRules = logoCount > 0
    ? `A brand logo image is provided between the product photos and the reference ad. Use this EXACT logo where the competitor's logo appears. Do NOT invent any additional logos, icons, or symbols.`
    : `Where the competitor has a logo, write "${product.name}" as PLAIN TEXT in matching style. Do NOT generate, invent, or create ANY logo, icon, emblem, mascot, or graphic. TEXT ONLY.`;

  return `Replicate the reference ad (LAST image) exactly, swapping only the product and text.

The first image(s) show the replacement product — reproduce it EXACTLY as photographed.

REPLICATION: Same layout, composition, background, fonts, colors, spacing, shadows, borders. It should look like the same designer made both ads.

PRODUCT: Replace competitor product with ${product.name} from the product photos. Show exactly ${pCount2} product(s) in the same position. The product is a mini bitcoin miner with a color display screen. Reproduce it exactly from the photos — no text, logos, or overlays on the product or its screen.

LOGO: ${logoRules}

TEXT SWAPS (${swapPairs.length} — apply all, matching original font style/weight/size/color/position):
${swapSection || '  (No text changes)'}

${characterRules}

${visualAdaptSection ? `VISUAL CHANGES:\n${visualAdaptSection}` : ''}

RULES:
1. Exact same number of text blocks as reference — no additions, no removals
2. Text must be sharp, legible, correctly spelled
3. No text/logo/overlay on the product device or screen
4. No invented elements (badges, seals, icons, logos, price tags not in reference)
5. No trace of competitor brand remaining
6. Layout labels (Day 0, Before, After, etc.) stay exactly as-is
7. Hands: 5 fingers, realistic anatomy
8. Product photos take highest priority — pixel-perfect fidelity`;
}
