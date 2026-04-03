function stripUsb(text) {
  if (!text) return text;
  return text
    .replace(/\bUSB[-\s]?C?\b/gi, '')
    .replace(/\bflash\s*drive\b/gi, '')
    .replace(/\bthumb\s*drive\b/gi, '')
    .replace(/\s{2,}/g, ' ')
    .trim();
}

export function buildClaudePrompt(product, angle, customOverrides = null) {
  const profile = product.profile || {};
  const co = customOverrides?.claudeAnalysis || {};
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

${co.productIdentity || `PRODUCT IDENTITY: The product is a MINI BITCOIN MINER — a small, compact electronic device with a color display screen showing mining hashrate data. It is NOT a USB stick, flash drive, or thumb drive. The screen displays mining statistics (hashrate numbers like 995.4 KH/s) — do NOT put logos, brand names, or text overlays on the device screen. NEVER place any logo or brand graphic ON TOP OF the product — the product must appear exactly as photographed, clean and untouched.`}

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
- Brand name (the competitor's brand name — e.g. "stepprs.", "Hims", "Oura", etc.)
- Product descriptor (the competitor's product tagline or descriptor — e.g. "Comfort Insoles", "Hair Regrowth Solution", etc.)
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
IMPORTANT: The brand_name and product_descriptor are CRITICAL — they MUST be extracted into original_text AND adapted in adapted_text. These are the #1 source of leftover competitor text if missed.

━━━ LAYER 4: VISUAL ELEMENTS ━━━
Identify every visual element:
- Product image(s): what product, how many, position, angle, size
- People: count, gender, age range, what they're doing
- Illustrations/photos: what they depict, their purpose
- Icons, arrows, callout lines
- Before/after imagery: what is being compared
- Background elements, textures, patterns

━━━ LAYER 5: COPY ADAPTATION — FORMULA PRESERVATION ━━━

THIS IS THE MOST IMPORTANT STEP. You must adapt EVERY SINGLE text element for the product above while PRESERVING THE EXACT COPYWRITING FORMULA.

⚠️⚠️⚠️ #1 RULE — STRICT 1:1 TEXT MAPPING (THIS OVERRIDES EVERYTHING ELSE):
Count the EXACT number of text elements in the reference image. Your adapted version must have the EXACT SAME COUNT — not one more, not one less.
- If the reference has 1 headline → adapted has 1 headline
- If the reference has 3 bullet points → adapted has 3 bullet points
- If the reference has 0 body paragraphs → adapted has 0 body paragraphs
- If the reference has 1 CTA button → adapted has 1 CTA button
- Do NOT add explanatory text, product descriptions, feature lists, stats, badges, or ANY content that doesn't have a direct 1:1 counterpart in the reference
- Do NOT expand short labels into long sentences. If the original is 3 words, the adapted should be ~3 words.
- Leave fields EMPTY ("") if no corresponding text exists in the reference. NEVER fill empty fields with invented copy.

⚠️ ZERO LEFTOVER TEXT: After adaptation, ZERO words from the original competitor's product/brand/niche must remain. Every single piece of text must be fully adapted to the bitcoin mining product. If the reference says "Comfort Insoles", "Hair Regrowth", "Weight Loss Serum", etc. — those words must be 100% replaced. Finding ANY competitor niche word in the output = FAILURE. Double-check every text field for leftover words from the reference product's niche.

${co.formulaPreservation || `⚠️ FORMULA PRESERVATION RULES (CRITICAL):
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
- "Hair Regrowth Solution" → "Solo Mining Solution" ❌ (generic, boring, not a benefit)
- "Hair Regrowth Solution" → "Passive Income Machine" ✅ (same slot, compelling benefit)
- "Customized Hair Care Serum" → "Bitcoin Mining Device" ❌ (generic category, not compelling)
- "Customized Hair Care Serum" → "$127/Month Profit Engine" ✅ (specific, benefit-driven)

GOLDEN RULE: Every adapted text element must be something a Facebook scroller would STOP for. If it sounds like a Wikipedia description ("Solo Mining Solution", "Bitcoin Mining Device"), rewrite it as a BENEFIT ("Passive Income Machine", "$127/Month on Autopilot", "24/7 Profit Generator").`}

⚠️ CROSS-NICHE ADAPTATION:
${co.crossNicheAdaptation || `The reference ad may be from ANY niche (supplements, skincare, fitness, finance, etc.). Your job is to:
1. Understand the EMOTIONAL TRIGGER the original copy uses (fear, greed, curiosity, social proof, urgency)
2. Apply the SAME emotional trigger to the bitcoin mining product
3. Keep the SAME sentence structure but swap the subject/benefit/problem
4. Make every claim specific to bitcoin mining, passive income, or the product's actual benefits`}

⚠️ HEADLINE RULES:
${co.headlineRules || `- Make BOLD, specific claims with concrete numbers (e.g. "$59 Device", "$127/Month", "24/7")
- Use the SAME emotional trigger as the original headline
- Match the approximate CHARACTER COUNT of the original (critical for layout fit)
- Sound like a native ad / advertorial — scroll-stopping, provocative
- NEVER use generic phrases like "works at home", "easy to use", "get started today", "mining solution", "solo mining", "start mining"
- When the reference has a product tagline/description (e.g. "Hair Regrowth Solution"), adapt it to a COMPELLING benefit statement, NOT a generic category descriptor. Example: "Hair Regrowth Solution" → "Passive Income Machine" or "$127/Month Device" — NEVER "Solo Mining Solution" or "Bitcoin Mining Device"
- Product labels ON the device should be the product name ONLY ("Miner Forge Pro") — do NOT add taglines onto the product itself`}

${co.headlineExamples || ''}

⚠️ PRICING RULES:
${co.pricingRules || `- Base price: $59.99 for 1 unit
- Bundle: 2 units = $55 each ($109.99), 3+1 free = $45 each ($179.99), 6+2 free = $40 each ($320)
- Max discount: 58% — NEVER exceed this
- Only discount code: MINER10 (extra 10% off)
- NEVER invent prices. When in doubt: "Starting at $59.99"
- CRITICAL: Only adapt text that ACTUALLY EXISTS in the reference image. Do NOT add discount badges, guarantee text, price callouts, or promotional elements that are not visible in the reference. If the reference has no "X% OFF" badge, your adapted version must also have NO "X% OFF" badge.`}
${co.bannedPhrases ? `\n⚠️ BANNED PHRASES — NEVER use these in adapted text:\n${co.bannedPhrases}` : ''}

⚠️ VISUAL ADAPTATION DIRECTION:
${co.visualAdaptation || `For each visual element, specify what it should become for the bitcoin mining product:
- Supplement bottles → Miner Forge Pro device(s)
- Skincare before/after → Mining earnings screenshots or device setup progression
- Fitness transformations → Passive income growth charts
- Food/ingredient callouts → Device feature callouts (hashrate, low power, silent operation)
- Body part close-ups → Device screen close-ups showing mining stats
- Kitchen/bathroom scenes → Desk/home office/nightstand scenes`}

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
    "brand_name": "the competitor brand name visible in the ad",
    "logo_position": "top-center/bottom-center/etc",
    "brand_colors": ["#hex1", "#hex2"],
    "has_disclaimer": true/false,
    "has_trust_badges": true/false
  },
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

export function buildNanoBananaPrompt(claudeResult, swapPairs, product, logoCount = 0, customOverrides = null) {
  const nb = customOverrides?.nanoBanana || {};
  const {
    layout, brand_elements, visual_elements, adapted_visual_direction,
    adapted_text, people_count, product_count, adapted_audience, character_adaptation, visual_adaptations
  } = claudeResult;

  const pCount = visual_elements?.people_count ?? people_count ?? 0;
  const pCount2 = visual_elements?.product_count ?? product_count ?? 1;
  const visualDir = adapted_visual_direction || {};

  // Build the FINAL TEXT description — tell the AI what to write, not what to find/replace
  const finalTextLines = [];
  if (adapted_text.brand_name) finalTextLines.push(`Brand name: "${adapted_text.brand_name}"`);
  if (adapted_text.product_descriptor) finalTextLines.push(`Product descriptor: "${adapted_text.product_descriptor}"`);
  if (adapted_text.headline) finalTextLines.push(`Headline: "${adapted_text.headline}"`);
  if (adapted_text.subheadline) finalTextLines.push(`Subheadline: "${adapted_text.subheadline}"`);
  if (adapted_text.body) finalTextLines.push(`Body: "${adapted_text.body}"`);
  if (adapted_text.cta) finalTextLines.push(`CTA: "${adapted_text.cta}"`);
  for (const field of ['badges', 'bullets', 'stats', 'comparison_labels', 'ingredient_labels', 'timeline_labels', 'other_text']) {
    const arr = adapted_text[field] || [];
    if (arr.length > 0) finalTextLines.push(`${field}: ${arr.map(t => `"${t}"`).join(', ')}`);
  }
  if (adapted_text.disclaimer) finalTextLines.push(`Disclaimer: "${adapted_text.disclaimer}"`);

  // Competitor brand info for elimination
  const origBrand = claudeResult.original_text?.brand_name || brand_elements?.brand_name || '';
  const origDescriptor = claudeResult.original_text?.product_descriptor || '';

  return `Recreate the reference ad (LAST image) with these changes. The first image(s) show the replacement product — copy the product EXACTLY from those photos.

STYLE: Pixel-perfect copy of the reference ad's design. Same layout, columns, background, fonts, colors, spacing, shadows, borders. It should look like the same designer made both.
${layout ? `\nLAYOUT: ${layout.structure || 'match reference'}. Background: ${layout.background || 'same'}. ${(layout.sections || []).map(s => `${s.position}: ${s.content}`).join('. ')}.${layout.has_divider ? ' Keep divider line.' : ''}` : ''}

PRODUCT: Replace all competitor product imagery with the ${product.name} shown in the first photos. Show ${pCount2} product(s) in ${visualDir.product_placement || 'same position as reference'}. The product is a mini bitcoin miner (compact device with color screen showing hashrate). Reproduce it exactly from the photos — do NOT add any text, logo, or overlay on the product or its screen.
${logoCount > 0 ? `\nBRAND LOGO: A brand logo image is provided (the image(s) between the product photos and the reference ad). Where the reference ad shows the competitor's logo or brand name text, place this PROVIDED logo image instead. Do NOT write the brand name as plain text — use the actual logo image. The logo must appear exactly as provided, not recreated or redrawn. Do NOT generate, invent, or add ANY other logo, icon, emblem, mascot, or symbol anywhere in the image.` : `\nBRAND: Where the reference has a competitor logo or icon, replace it with PLAIN TEXT "${product.name}" only — no icon, no symbol, no emblem, no mascot, no graphic of any kind next to it. NEVER generate, invent, or create ANY logo, icon, or brand graphic. The brand appears as TEXT ONLY.`}`

FINAL TEXT — render ONLY these text elements, nothing more. Each line maps 1:1 to a text element in the reference. If a field is not listed, it does NOT exist — do NOT invent it:
${finalTextLines.join('\n')}
(Total: ${finalTextLines.length} text elements. Your output must have EXACTLY ${finalTextLines.length} text elements — no extra text, labels, stats, or descriptions.)

${origBrand ? `IMPORTANT: The competitor brand "${origBrand}" must NOT appear anywhere.` : ''}${origDescriptor ? ` "${origDescriptor}" must NOT appear anywhere.` : ''} Zero leftover competitor text.

${pCount === 0 ? 'No people in reference — do not add any.' : `Keep exactly ${pCount} person(s), same gender/age range.${adapted_audience ? ' ' + adapted_audience : ''}`}
${visualDir.illustration_changes ? `Illustrations: ${visualDir.illustration_changes}` : ''}
${visualDir.comparison_adaptation ? `Comparison: ${visualDir.comparison_adaptation}` : ''}
${visualDir.background_changes ? `Background: ${visualDir.background_changes}` : ''}

RULES:
1. EXACT same number of text blocks as reference — adding ANY extra text = failure
2. Text must be sharp, legible, correctly spelled. Product name: "${product.name}"
3. No text/logo/badge ON the product device or screen
4. NEVER add elements not in the reference (no extra badges, stats, feature lists, descriptions, price tags)
5. Prices must match the text above exactly — do not invent amounts
6. Match the reference's visual density — if the reference is clean/minimal, the output must be equally clean/minimal
7. NEVER invent or generate ANY logo, icon, emblem, mascot, seal, or brand graphic${logoCount > 0 ? ' — use ONLY the provided logo image' : ''}. No shield icons, no animal icons, no abstract symbols. Brand identity is TEXT ONLY${logoCount > 0 ? ' plus the provided logo' : ''}.`;
}

export function buildSwapPairs(originalText, adaptedText, claudeResult = null) {
  const pairs = [];

  // Brand name and product descriptor — these are the #1 cause of leftover competitor text
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

  // Fallback: extract brand name from brand_elements if Claude didn't put it in original_text
  if (claudeResult?.brand_elements) {
    const be = claudeResult.brand_elements;
    // Check if we already have a brand_name swap
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
