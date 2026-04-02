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
  return `You are an elite ad creative analyst and copywriter. Your job is to deconstruct a reference ad image with surgical precision, then adapt every element for a new product.

PRODUCT CONTEXT:
- Product Name: ${product.name}
- Description: ${stripUsb(product.description) || 'N/A'}
- Price: ${product.price || 'N/A'}
- One-liner: ${stripUsb(profile.oneliner) || 'N/A'}
- Target Customer: ${profile.customerAvatar || 'N/A'}
- Customer Frustration: ${profile.customerFrustration || 'N/A'}
- Customer Dream: ${profile.customerDream || 'N/A'}
- Big Promise: ${stripUsb(profile.bigPromise) || 'N/A'}
- Mechanism: ${stripUsb(profile.mechanism) || 'N/A'}
- Key Benefits: ${Array.isArray(profile.benefits) ? profile.benefits.join(', ') : (profile.benefits || 'N/A')}
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
${angle ? `- Marketing Angle: ${angle}` : ''}
- PRODUCT IDENTITY NOTE: The product is a MINI BITCOIN MINER — a small, compact electronic device with a color display screen showing mining hashrate data. NEVER describe it as a "USB stick", "flash drive", "thumb drive", or anything USB-related. It is NOT a USB device. When describing product placement, refer to it as "mini bitcoin miner" or "compact mining device with display screen". IMPORTANT: The product's screen displays mining statistics (hashrate numbers like 995.4 KH/s) — do NOT put logos, brand names, or text overlays on the device screen. The screen content must match exactly what is shown in the product images.

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

⚠️ HEADLINE RULES (HIGHEST PRIORITY):
The headline is the most important element. Write AGGRESSIVE, high-converting headlines that create urgency and desire. The headline must:
- Make a BOLD, specific money-related claim (e.g. "This $59 Device Mines $127/Month in Bitcoin While You Sleep", "People Are Making $3,800/Month With This Tiny Miner")
- Use concrete dollar amounts, timeframes, or multipliers — vague claims like "works at home" are BANNED
- Create FOMO, urgency, or disbelief (e.g. "Wall Street Doesn't Want You to Know About This", "Banks HATE This $59 Device")
- Sound like a native ad / advertorial headline, NOT like a product description
- Be punchy, provocative, and scroll-stopping — if it sounds like it could be a boring product tagline, REWRITE IT
- NEVER use generic/weak phrases like "works at home", "easy to use", "quick mining", "get started today"
- Match the approximate CHARACTER COUNT of the original headline (not word count — character count matters for layout fit)

HEADLINE STYLE EXAMPLES (use these as inspiration, do NOT copy verbatim):
- "I Bought a $59 Bitcoin Miner as a Joke — It's Paid for Itself 4x"
- "Tiny Device Mines $4.20/Day in Bitcoin — No Experience Needed"
- "Crypto Millionaires Started With This Exact Device"
- "Your Electricity Bill Hides a $127/Month Bitcoin Goldmine"
- "This Pocket-Sized Miner Made $847 Last Month on Autopilot"
- "Forget Savings Accounts — This Mines Real Bitcoin 24/7"

⚠️ MANDATORY PRICING RULES (VIOLATION = FAILURE):
- The product base price is $59.99 for 1 unit
- Bundle prices: 2 units = $55 each ($109.99), 3+1 free = $45 each ($179.99), 6+2 free = $40 each ($320)
- Maximum discount allowed: 58% — NEVER exceed this
- The ONLY discount code is MINER10 (extra 10% off)
- NEVER write "$35", "$29", "$25" or any price not listed above
- If the reference ad has a price, replace it with the CORRECT price from this list
- When in doubt, use "Up to 40% OFF" or "Starting at $59.99" — do NOT invent prices

CRITICAL RULES:
- Headlines must be AGGRESSIVE money-making claims (see rules above) — never generic product descriptions
- Keep the same emotional tone but AMPLIFY the persuasion — make it more compelling than the original
- Subheadlines should reinforce the headline's bold claim with a supporting proof point or benefit
- Comparison labels must adapt to the new product's context
- Ingredient labels must use the new product's actual ingredients
- Timeline labels should match the new product's realistic timeline
- CTA should use discount code MINER10 if the reference has a promo code
- Disclaimer should reference the new brand
- ALL copy should sound like it belongs in a high-converting paid ad, not a product manual

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

  const logoNote = logoCount > 0
    ? `\nBRAND LOGO: The brand logo is provided in the images (before the reference ad). Use this EXACT logo where the reference ad has the competitor's logo. Do NOT create or invent any logo — use the provided one pixel-for-pixel.`
    : '';

  return `Generate a new ad creative based on the reference ad (LAST image). The first images show the product from multiple angles — reproduce it EXACTLY.${logoNote}
${layoutSection}

PRODUCT REPLACEMENT:
- Remove ALL competitor branding, logos, product imagery
- Replace with the product shown in the first images (${product.name}). Multiple angles of the same product are provided — use them to reproduce it with perfect accuracy.
- Show exactly ${pCount2} product(s)
- Product placement: ${visualDir.product_placement || 'same position as reference product'}
- CRITICAL: The product is a MINI BITCOIN MINER with a display screen — NOT a USB stick. Reproduce it EXACTLY as shown. NEVER render it as a USB stick, flash drive, or thumb drive. Do NOT add logos or brand names onto the device screen — the screen shows mining hashrate data only.
- Realistic lighting, shadows, and perspective matching the reference style

TEXT REPLACEMENTS (${swapPairs.length} swaps — apply ALL of them):
${swapSection || '  (No text changes)'}
- Font style, weight, size, color, and position must EXACTLY match reference for each text element
- Do NOT add extra text blocks. Do NOT remove text that isn't in the swap list.
- Text must be sharp, legible, and correctly spelled — NO blurry, warped, or AI-looking text
- Headlines must be rendered in BOLD, high-contrast, professional typography — as crisp as a real paid ad
- CRITICAL: Every letter must be pixel-perfect and readable. If text looks "AI-generated" or distorted, the output is a failure.
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
7. The product is a MINI BITCOIN MINER — NEVER show a USB-looking product. Copy the device from image 1 exactly.
8. Hands: exactly 5 fingers, realistic proportions
9. Match reference style, color palette, mood, and visual quality
10. Brand logo: ${logoCount > 0 ? 'Use the PROVIDED logo image (not invented text). Place it where the competitor logo was.' : `Use "${product.name}" text as logo in same position as competitor logo.`}
11. PRICES MUST MATCH the text swap list EXACTLY — do not invent or modify any price, discount percentage, or dollar amount`;
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
