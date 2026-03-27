export function buildClaudePrompt(product, angle) {
  const profile = product.profile || {};
  return `You are an elite ad creative analyst and copywriter. Your job is to deconstruct a reference ad image with surgical precision, then adapt every element for a new product.

PRODUCT CONTEXT:
- Product Name: ${product.name}
- Description: ${product.description || 'N/A'}
- Price: ${product.price || 'N/A'}
- One-liner: ${profile.oneliner || 'N/A'}
- Target Customer: ${profile.customerAvatar || 'N/A'}
- Customer Frustration: ${profile.customerFrustration || 'N/A'}
- Customer Dream: ${profile.customerDream || 'N/A'}
- Big Promise: ${profile.bigPromise || 'N/A'}
- Mechanism: ${profile.mechanism || 'N/A'}
- Key Ingredients/Features: ${profile.ingredients || profile.features || 'N/A'}
- Differentiator: ${profile.differentiator || 'N/A'}
- Voice/Tone: ${profile.voice || 'N/A'}
- Guarantee: ${profile.guarantee || 'N/A'}
${profile.painPoints ? `- Pain Points & Triggers: ${profile.painPoints}` : ''}
${profile.commonObjections ? `- Common Objections: ${profile.commonObjections}` : ''}
${profile.winningAngles ? `- Winning Angles: ${profile.winningAngles}` : ''}
${profile.competitiveEdge ? `- Competitive Edge: ${profile.competitiveEdge}` : ''}
${profile.maxDiscount ? `- Max Discount: ${profile.maxDiscount}` : ''}
${profile.discountCodes ? `- Discount Codes: ${profile.discountCodes}` : ''}
${profile.bundleVariants ? `- Bundle Variants: ${profile.bundleVariants}` : ''}
${profile.offerDetails ? `- Offer Rules: ${profile.offerDetails}` : ''}
${profile.complianceRestrictions ? `- COMPLIANCE (NEVER claim): ${profile.complianceRestrictions}` : ''}
${angle ? `- Marketing Angle: ${angle}` : ''}

INSTRUCTIONS — Analyze the reference ad image in 5 layers:

━━━ LAYER 1: LAYOUT STRUCTURE ━━━
Describe the exact spatial layout:
- How many columns/sections? (e.g. "2-column split with vertical divider")
- What is in each section? (e.g. "left: product + ingredients, right: before/after timeline")
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
Extract EVERY piece of visible text, including:
- Headline (the largest/most prominent text)
- Subheadline
- Body copy
- CTA button text
- Comparison labels (e.g. "Before", "After", "On GLP-1", "With Product")
- Ingredient/feature labels with arrows or callouts
- Timeline labels (e.g. "3-4 mo.", "6 mo.", "8+ wk.")
- Stats, numbers, percentages
- Badge text, pill text
- Disclaimer/fine print
- ANY other text visible in the image

IMPORTANT: Include comparison labels, timeline labels, and ingredient callouts — these are NOT "layout labels to skip". They ARE part of the ad copy that needs adaptation.

━━━ LAYER 4: VISUAL ELEMENTS ━━━
Identify every visual element:
- Product image(s): what product, how many, position, angle, size
- Illustration/photo subjects: what they depict, their purpose in the ad
- Icons, arrows, callout lines
- Before/after imagery: what is being compared
- People: count, gender, age range, what they're doing
- Background elements, textures, patterns

━━━ LAYER 5: COPY ADAPTATION ━━━
Now adapt EVERY text element for the product above.

CRITICAL RULES:
- Match the EXACT sentence structure and approximate word count of original
- Keep the same emotional tone and persuasion technique
- Comparison labels must adapt to the new product's context (e.g. "On GLP-1" → "With Man Boobs", "GLP-1 + Mars Men" → "Man Boobs + Estro Guard+")
- Ingredient labels must use the new product's actual ingredients
- Timeline labels should match the new product's realistic timeline
- Stats should be realistic for the new product
- CTA should match the new product's offer
- Disclaimer should reference the new brand

Return ONLY valid JSON (no markdown, no code fences):
{
  "layout": {
    "structure": "description of layout (e.g. '2-column split with vertical divider')",
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
  "visual_elements": {
    "people_count": 0,
    "product_count": 0,
    "product_position": "where the product appears in the layout",
    "illustrations": [{"original": "what it shows", "adapted": "what it should show for new product", "position": "where in layout"}],
    "comparison_type": "before-after/with-without/us-vs-them/timeline/none",
    "comparison_stages": [{"label": "original label", "visual": "what the image shows"}]
  },
  "adapted_visual_direction": {
    "product_placement": "exactly where and how the new product should appear",
    "illustration_changes": "what illustrations need to change and to what",
    "comparison_adaptation": "how the before/after or comparison concept adapts",
    "people_direction": "keep same people style, or how to adapt",
    "background_changes": "keep same or what to change"
  }
}`;
}

export function buildNanoBananaPrompt(claudeResult, swapPairs, product) {
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
    ? 'PEOPLE: Do NOT add any human faces or bodies. The reference has zero people.'
    : `PEOPLE: Output must have EXACTLY ${pCount} person(s). Use DIFFERENT person(s) of same gender/age range. ${adapted_audience || ''} ${character_adaptation || ''}`;

  // Layout rules
  const layoutSection = layout ? `
LAYOUT STRUCTURE:
- Structure: ${layout.structure || 'match reference exactly'}
- Background: ${layout.background || 'same as reference'}
- Sections: ${(layout.sections || []).map(s => `${s.position}: ${s.content}`).join(' | ')}
${layout.has_divider ? '- Keep the vertical/horizontal divider line' : ''}
${layout.has_rounded_corners ? '- Keep rounded corners on sections' : ''}
- CRITICAL: Maintain the EXACT same spatial layout, proportions, and section placement` : '';

  // Visual adaptation rules
  const visualDir = adapted_visual_direction || {};
  const illustrationSection = visualDir.illustration_changes
    ? `\nILLUSTRATION CHANGES:\n- ${visualDir.illustration_changes}`
    : '';
  const comparisonSection = visualDir.comparison_adaptation
    ? `\nCOMPARISON ADAPTATION:\n- ${visualDir.comparison_adaptation}`
    : '';

  // Legacy visual_adaptations support
  const legacyVisuals = (visual_adaptations || []).map((v, i) =>
    `  ${i + 1}. ${v.position}: ${v.original_visual} → ${v.adapted_visual}${v.is_angle_specific ? ' [MANDATORY]' : ''}`
  ).join('\n');

  return `Generate a new ad creative based on the reference ad (image 2). Use the product from image 1.
${layoutSection}

PRODUCT REPLACEMENT:
- Remove ALL competitor branding, logos, product imagery
- Replace with product from image 1 (${product.name})
- Show exactly ${pCount2} product(s)
- Product placement: ${visualDir.product_placement || 'same position as reference product'}
- Realistic lighting, shadows, and perspective matching the reference style

TEXT REPLACEMENTS (${swapPairs.length} swaps — apply ALL of them):
${swapSection || '  (No text changes)'}
- Font style, weight, size, color, and position must EXACTLY match reference for each text element
- Do NOT add extra text blocks. Do NOT remove text that isn't in the swap list.
- Text must be sharp, legible, and correctly spelled
${illustrationSection}
${comparisonSection}

${characterRules}

VISUAL ADAPTATIONS:
${legacyVisuals || '  (Match reference style)'}
${visualDir.background_changes ? `- Background: ${visualDir.background_changes}` : '- Keep exact same background color/gradient/texture'}

ABSOLUTE RULES:
1. EXACT same layout structure as reference — same columns, same sections, same proportions
2. ZERO competitor branding remaining (logos, names, product images)
3. Every text swap must be applied — check all ${swapPairs.length} replacements
4. No extra faces beyond ${pCount}
5. No extra text beyond the specified swaps
6. Comparison labels, timeline labels, ingredient labels ALL get swapped
7. Hands: exactly 5 fingers, realistic proportions
8. Match reference style, color palette, mood, and visual quality
9. Brand logo for ${product.name} should replace competitor logo in same position`;
}

export function buildSwapPairs(originalText, adaptedText) {
  const pairs = [];

  // Standard text fields
  for (const field of ['headline', 'subheadline', 'body', 'cta', 'disclaimer']) {
    const orig = originalText[field], adapted = adaptedText[field];
    if (orig && adapted && orig.trim() !== adapted.trim())
      pairs.push({ original: orig.trim(), adapted: adapted.trim(), field });
  }

  // Array fields (badges, bullets, stats, other_text, comparison_labels, ingredient_labels, timeline_labels)
  for (const field of ['badges', 'bullets', 'stats', 'other_text', 'comparison_labels', 'ingredient_labels', 'timeline_labels']) {
    const origArr = originalText[field] || [], adaptedArr = adaptedText[field] || [];
    for (let i = 0; i < Math.min(origArr.length, adaptedArr.length); i++) {
      if (origArr[i] && adaptedArr[i] && origArr[i].trim() !== adaptedArr[i].trim())
        pairs.push({ original: origArr[i].trim(), adapted: adaptedArr[i].trim(), field: `${field}[${i}]` });
    }
  }

  return pairs;
}
