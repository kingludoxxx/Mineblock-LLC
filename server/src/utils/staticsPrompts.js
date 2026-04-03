function stripUsb(text) {
  if (!text) return text;
  return text
    .replace(/\bUSB[-\s]?C?\b/gi, '')
    .replace(/\bflash\s*drive\b/gi, '')
    .replace(/\bthumb\s*drive\b/gi, '')
    .replace(/\s{2,}/g, ' ')
    .trim();
}

export function buildClaudePrompt(product, angle) {
  const profile = product.profile || {};
  return `You are an elite ad creative analyst and direct-response copywriter. Your job is to deconstruct a reference ad image and adapt it for a completely different product — potentially from a different niche entirely.

THE CORE CONCEPT: You are copying the PROVEN COPYWRITING FORMULA and GRAPHIC STYLE of the reference ad, NOT the niche. The reference might be a supplement ad, a skincare ad, a fitness ad — it doesn't matter. You extract the visual style, layout structure, and copywriting formula, then rewrite everything for the target product below.

═══════════════════════════════════════════════════════════════
PRODUCT CONTEXT (this is what the ad must sell)
═══════════════════════════════════════════════════════════════
- Product Name: ${product.name}
- Description: ${stripUsb(product.description) || 'N/A'}
- Price: ${product.price || 'N/A'}
- One-liner: ${stripUsb(profile.oneliner) || 'N/A'}
- Target Customer: ${profile.customerAvatar || 'N/A'}
- Customer Frustration: ${profile.customerFrustration || 'N/A'}
- Customer Dream Outcome: ${profile.customerDream || 'N/A'}
- Big Promise: ${stripUsb(profile.bigPromise) || 'N/A'}
- Unique Mechanism: ${stripUsb(profile.mechanism) || 'N/A'}
- Key Benefits: ${Array.isArray(profile.benefits) ? profile.benefits.map(b => typeof b === 'object' ? (b.text || b.name || b) : b).join(', ') : (profile.benefits || 'N/A')}
- Differentiator: ${stripUsb(profile.differentiator) || 'N/A'}
- Voice/Tone: ${profile.voice || 'N/A'}
- Guarantee: ${profile.guarantee || 'N/A'}
${profile.painPoints ? `- Pain Points & Triggers: ${profile.painPoints}` : ''}
${profile.commonObjections ? `- Common Objections: ${profile.commonObjections}` : ''}
${profile.winningAngles ? `- Winning Angles: ${profile.winningAngles}` : ''}
${profile.customAngles ? '- Custom Angles to Test: ' + profile.customAngles : ''}
${profile.competitiveEdge ? `- Competitive Edge: ${profile.competitiveEdge}` : ''}
${profile.maxDiscount ? `- Max Discount: ${profile.maxDiscount}` : ''}
${profile.discountCodes ? `- Discount Codes: ${profile.discountCodes}` : ''}
${profile.bundleVariants ? `- Bundle Variants: ${profile.bundleVariants}` : ''}
${profile.offerDetails ? `- Offer Rules: ${profile.offerDetails}` : ''}
${profile.complianceRestrictions ? `- COMPLIANCE (NEVER claim): ${profile.complianceRestrictions}` : ''}
${angle ? `\n- MARKETING ANGLE FOR THIS AD: ${angle}` : ''}

PRODUCT IDENTITY: The product is a MINI BITCOIN MINER — a small, compact electronic device with a color display screen showing mining hashrate data. It is NOT a USB stick, flash drive, or thumb drive. The screen displays mining statistics (hashrate numbers like 995.4 KH/s) — do NOT put logos, brand names, or text overlays on the device screen.

═══════════════════════════════════════════════════════════════
INSTRUCTIONS — Analyze the reference ad image in 5 layers
═══════════════════════════════════════════════════════════════

━━━ LAYER 1: LAYOUT STRUCTURE ━━━
Describe the exact spatial layout:
- How many columns/sections? (e.g. "2-column split with vertical divider")
- What is in each section? (e.g. "left: product + features, right: before/after timeline")
- Where is the header? Footer? CTA?
- Background color/gradient/texture
- Any visual dividers, borders, rounded corners, shadows?

━━━ LAYER 2: BRAND ELEMENTS ━━━
Identify ALL brand-specific elements:
- Logo: position, size, color
- Brand name text occurrences (header, footer, product label, etc.)
- Brand colors used
- Disclaimer/legal text at bottom
- Any trust badges, review stars, certification marks

━━━ LAYER 3: TEXT EXTRACTION ━━━
Extract EVERY piece of visible text ACTUALLY VISIBLE in the image:
- Headline (the largest/most prominent text)
- Subheadline
- Body copy
- CTA button text
- Comparison labels (e.g. "Before", "After", "With Product")
- Feature labels, ingredient labels with arrows or callouts
- Timeline labels (e.g. "3-4 mo.", "6 mo.")
- Stats, numbers, percentages
- Badge text, pill text
- Disclaimer/fine print
- ANY other text visible in the image

IMPORTANT: Only extract text that is ACTUALLY VISIBLE. Do NOT hallucinate text.
IMPORTANT: Progress/timeline labels ("Day 0", "Before", "After") are ALSO extracted.
IMPORTANT: Include comparison labels, ingredient callouts — they ARE part of the copy.

━━━ LAYER 4: VISUAL ELEMENTS ━━━
Identify every visual element:
- Product image(s): what product, how many, position, angle, size
- People: count, gender, age range, what they're doing
- Illustrations/photos: what they depict, their purpose
- Icons, arrows, callout lines
- Before/after imagery: what is being compared
- Background elements, textures, patterns

━━━ LAYER 5: COPY ADAPTATION — FORMULA PRESERVATION ━━━

THIS IS THE MOST IMPORTANT STEP. You must adapt every text element for the product above while PRESERVING THE EXACT COPYWRITING FORMULA.

⚠️ FORMULA PRESERVATION RULES (CRITICAL):
The adapted text must follow the EXACT SAME sentence structure, opening words, and approximate character count as the original. You are copying the PROVEN FORMULA, just swapping the subject matter.

Examples of correct formula preservation:
- "Bye Bye, Beer Belly" → "Bye Bye, Power Bills" (keeps "Bye Bye,")
- "Kill The Bloated Belly" → "Kill The Middleman" (keeps "Kill The")
- "3 Years of Back Pain Gone in 7 Days" → "3 Years of Missing Gains Gone in 7 Days" (keeps "[X] of [problem] Gone in [Y]")
- "Now just £5 a bottle" → "Now just $59.99 a unit" (keeps "Now just ... a [container]")
- "Doctor's #1 Recommendation" → "Tech Expert's #1 Pick" (keeps "[Authority]'s #1 [endorsement]")
- Generic labels like "SPECIAL DEAL", "THIS WEEK ONLY", "FREE SHIPPING" → keep EXACTLY as-is

Examples of WRONG adaptation (breaks the formula):
- "Bye Bye, Beer Belly" → "Mine Bitcoin From Home" ❌ (completely different structure)
- "Kill The Bloated Belly" → "Start Mining Bitcoin Today" ❌ (different sentence pattern)

⚠️ CROSS-NICHE ADAPTATION:
The reference ad may be from ANY niche (supplements, skincare, fitness, finance, etc.). Your job is to:
1. Understand the EMOTIONAL TRIGGER the original copy uses (fear, greed, curiosity, social proof, urgency)
2. Apply the SAME emotional trigger to the bitcoin mining product
3. Keep the SAME sentence structure but swap the subject/benefit/problem
4. Make every claim specific to bitcoin mining, passive income, or the product's actual benefits

⚠️ HEADLINE RULES:
- Make BOLD, specific claims with concrete numbers (e.g. "$59 Device", "$127/Month", "24/7")
- Use the SAME emotional trigger as the original headline
- Match the approximate CHARACTER COUNT of the original (critical for layout fit)
- Sound like a native ad / advertorial — scroll-stopping, provocative
- NEVER use generic phrases like "works at home", "easy to use", "get started today"

⚠️ PRICING RULES:
- Base price: $59.99 for 1 unit
- Bundle: 2 units = $55 each ($109.99), 3+1 free = $45 each ($179.99), 6+2 free = $40 each ($320)
- Max discount: 58% — NEVER exceed this
- Only discount code: MINER10 (extra 10% off)
- NEVER invent prices. When in doubt: "Starting at $59.99" or "Up to 40% OFF"

⚠️ VISUAL ADAPTATION DIRECTION:
For each visual element, specify what it should become for the bitcoin mining product:
- Supplement bottles → Miner Forge Pro device(s)
- Skincare before/after → Mining earnings screenshots or device setup progression
- Fitness transformations → Passive income growth charts
- Food/ingredient callouts → Device feature callouts (hashrate, low power, silent operation)
- Body part close-ups → Device screen close-ups showing mining stats
- Kitchen/bathroom scenes → Desk/home office/nightstand scenes

Mark each visual adaptation as:
- "generic" = works for any product (backgrounds, abstract elements) → keep as-is
- "angle_specific" = must change for this product → provide specific direction

Return ONLY valid JSON (no markdown, no code fences):
{
  "layout": {
    "structure": "description of layout",
    "sections": [{"position": "left/right/top/bottom/center", "content": "what this section contains"}],
    "background": "color or description",
    "has_divider": true/false,
    "has_rounded_corners": true/false
  },
  "brand_elements": {
    "logo_position": "top-center/bottom-center/etc",
    "brand_colors": ["#hex1", "#hex2"],
    "has_disclaimer": true/false,
    "has_trust_badges": true/false
  },
  "original_text": {
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
  "adapted_audience": "description of target demographic for people in ad",
  "character_adaptation": "how to adapt people shown (age, gender, style)",
  "visual_adaptations": [
    {
      "original_visual": "what the image shows in the reference",
      "adapted_visual": "what it should show for the bitcoin miner product",
      "position": "where in the layout",
      "is_angle_specific": true
    }
  ],
  "visual_elements": {
    "people_count": 0,
    "product_count": 0,
    "product_position": "where the product appears",
    "illustrations": [{"original": "what it shows", "adapted": "what it should show", "position": "where"}],
    "comparison_type": "before-after/with-without/us-vs-them/timeline/none",
    "comparison_stages": [{"label": "original label", "visual": "what the image shows"}]
  },
  "adapted_visual_direction": {
    "product_placement": "exactly where and how the miner device should appear",
    "illustration_changes": "what illustrations need to change and to what",
    "comparison_adaptation": "how the before/after or comparison concept adapts to mining/income",
    "people_direction": "keep same people style, or how to adapt for crypto/tech audience",
    "background_changes": "keep same or what to change"
  }
}`;
}

export function buildNanoBananaPrompt(claudeResult, swapPairs, product, logoCount = 0) {
  const {
    layout, brand_elements, visual_elements, adapted_visual_direction,
    people_count, product_count, adapted_audience, character_adaptation, visual_adaptations
  } = claudeResult;

  const swapSection = swapPairs.map((pair, i) =>
    `  ${i + 1}. "${pair.original}" → "${pair.adapted}" [${pair.field}]`
  ).join('\n');

  // People rules
  const pCount = visual_elements?.people_count ?? people_count ?? 0;
  const pCount2 = visual_elements?.product_count ?? product_count ?? 1;
  let characterRules = pCount === 0
    ? 'PEOPLE: There are NO people in the reference ad. Do NOT add any human faces or bodies.'
    : `PEOPLE: The reference has EXACTLY ${pCount} person(s). Your output must have EXACTLY ${pCount} person(s). Use DIFFERENT person(s) of same gender/age range. ${adapted_audience || ''} ${character_adaptation || ''}`;

  // Layout rules
  const layoutSection = layout ? `
LAYOUT STRUCTURE (REPLICATE EXACTLY):
- Structure: ${layout.structure || 'match reference exactly'}
- Background: ${layout.background || 'same as reference'}
- Sections: ${(layout.sections || []).map(s => `${s.position}: ${s.content}`).join(' | ')}
${layout.has_divider ? '- Keep the vertical/horizontal divider line' : ''}
${layout.has_rounded_corners ? '- Keep rounded corners on sections' : ''}
- CRITICAL: Maintain the EXACT same spatial layout, proportions, and section placement as the reference` : '';

  // Visual adaptation rules
  const visualDir = adapted_visual_direction || {};
  const illustrationSection = visualDir.illustration_changes
    ? `\nILLUSTRATION CHANGES:\n- ${visualDir.illustration_changes}`
    : '';
  const comparisonSection = visualDir.comparison_adaptation
    ? `\nCOMPARISON ADAPTATION:\n- ${visualDir.comparison_adaptation}`
    : '';

  // Angle-specific visual adaptations from Claude analysis
  const legacyVisuals = (visual_adaptations || []).map((v, i) =>
    `  ${i + 1}. ${v.position}: "${v.original_visual}" → "${v.adapted_visual}"${v.is_angle_specific ? ' [MUST CHANGE]' : ' [optional]'}`
  ).join('\n');

  const logoNote = logoCount > 0
    ? `\nBRAND LOGO: The brand logo is provided in the images (before the reference ad). Use this EXACT logo where the reference ad has the competitor's logo. Do NOT create or invent any logo — use the provided one pixel-for-pixel.`
    : '';

  return `Generate a new ad creative based on the reference ad (LAST image). The first image(s) show the product from multiple angles — reproduce the product EXACTLY as shown in those photos.${logoNote}
${layoutSection}

PRODUCT REPLACEMENT:
- Remove ALL competitor branding, logos, product imagery — zero trace remaining
- Replace with the product shown in the first images (${product.name}). Multiple angles may be provided — use them to reproduce the product with perfect accuracy.
- Show exactly ${pCount2} product(s) in the output
- Product placement: ${visualDir.product_placement || 'same position as reference product'}
- CRITICAL: The product is a MINI BITCOIN MINER — a compact electronic device with a color display screen showing mining hashrate data. It is NOT a USB stick, flash drive, or thumb drive. Reproduce it EXACTLY as shown in the product photos. Do NOT add logos or brand names onto the device screen — the screen shows mining statistics only.
- Match realistic lighting, shadows, and perspective to the reference style

TEXT REPLACEMENTS (${swapPairs.length} swaps — apply ALL):
${swapSection || '  (No text changes)'}

TEXT RENDERING RULES:
- Font style, weight, size, color, and position must EXACTLY match reference for each text element
- Do NOT add extra text blocks. Do NOT remove text that isn't in the swap list.
- Text must be sharp, legible, and correctly spelled — NO blurry, warped, or AI-looking text
- Headlines must be rendered in BOLD, high-contrast, professional typography — as crisp as a real paid ad
- CRITICAL: Every letter must be pixel-perfect and readable. Distorted text = failure.
${illustrationSection}
${comparisonSection}

${characterRules}

VISUAL ADAPTATIONS:
${legacyVisuals || '  (Match reference style — keep backgrounds, icons, decorative elements as-is)'}
${visualDir.background_changes ? `- Background: ${visualDir.background_changes}` : '- Keep exact same background color/gradient/texture'}

ABSOLUTE RULES:
1. EXACT same layout structure as reference — same columns, same sections, same proportions
2. ZERO competitor branding remaining (logos, names, product images)
3. Every text swap must be applied — check all ${swapPairs.length} replacements
4. No extra faces beyond ${pCount} — do NOT add people if reference has none
5. No extra text elements beyond the specified swaps — do NOT invent copy
6. Comparison labels, timeline labels, feature labels ALL get swapped per the list above
7. The product is a MINI BITCOIN MINER — NEVER render it as a USB stick. Copy the device from the product photos exactly.
8. Hands: exactly 5 fingers, realistic proportions
9. Match reference style, color palette, mood, and visual quality exactly
10. Brand logo: ${logoCount > 0 ? 'Use the PROVIDED logo image (not invented text). Place it where the competitor logo was.' : `Use "${product.name}" text as logo in same position as competitor logo.`}
11. PRICES MUST MATCH the text swap list EXACTLY — do not invent or modify any price, discount percentage, or dollar amount
12. Product photos take highest priority — reproduce the device with pixel-perfect fidelity`;
}

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
