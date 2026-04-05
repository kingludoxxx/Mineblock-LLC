// ─────────────────────────────────────────────────────────────────────────────
// Standard Statics Generation Pipeline — Prompt Builders
// Follows the proven pipeline structure exactly
// ─────────────────────────────────────────────────────────────────────────────

// ─────────────────────────────────────────────────────────────────────────────
// STEP 0: Layout Analysis — Structural Map (cached per template)
// ─────────────────────────────────────────────────────────────────────────────

export function buildLayoutAnalysisPrompt() {
  return {
    system: `You are an expert visual layout analyst specializing in direct-response static ad templates. Your only job is to produce a precise, neutral, and complete structural map of any ad template image. You describe only structure, position, hierarchy, and element relationships. You never describe copy content, brand colors, logos, or product type. You never make creative suggestions. You never interpret intent. You observe and document only. Your output will be used as a structural blueprint by a separate creative agent.`,

    user: `Analyze the reference template image and produce a complete structural layout map as JSON.

For each element, use precise positional language (top third, bottom quarter, left edge, centered, overlaid, flush right), size language (largest element, approximately one third of canvas width, small), and relational language (sits directly below, aligned with left edge of product visual).

Never use color names from the reference image. Never describe what the copy says. Never describe the product shown. Describe only WHERE things are and HOW they relate to each other.

Return ONLY valid JSON (no markdown, no code fences):
{
  "archetype": "short_snake_case_layout_name",
  "canvas": {
    "orientation": "portrait|landscape|square",
    "aspect_ratio": "1:1|9:16|4:5|16:9"
  },
  "background": {
    "type": "solid|gradient|textured|photographic|split",
    "tone": "dark|light|mixed",
    "zones": "description of any secondary background panels and their positions"
  },
  "text_elements": [
    {
      "role": "headline|subheadline|body|cta|badge|stat_label|stat_value|guarantee|disclaimer|other",
      "hierarchy": 1,
      "position": "where on canvas",
      "alignment": "center|left|right",
      "size": "relative size description",
      "lines": 1,
      "char_count_approx": 25,
      "visual_treatment": "plain|filled_shape|highlighted|outlined|stacked",
      "container": "description of any containing shape"
    }
  ],
  "product_zone": {
    "position": "where on canvas",
    "size_pct": "approximate percentage of canvas",
    "presentation": "angle, overlap with other elements",
    "count": 1
  },
  "visual_elements": [
    {
      "type": "person|arrow|line|border|icon|badge_shape|decorative",
      "position": "where on canvas",
      "size": "relative size",
      "connects": "what it connects to, if applicable"
    }
  ],
  "composition_notes": "one sentence describing the overall spatial rhythm and reading flow",
  "hierarchy_summary": ["H1: headline position", "H2: subheadline position", "STAT: stat positions", "BADGE: badge position", "CTA: cta position"]
}`
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// STEP 1: Claude Vision — Copy Extraction + Rewriting
// ─────────────────────────────────────────────────────────────────────────────

export function buildClaudePrompt(product, angle, customOverrides = null, layoutMap = null, templateData = null) {
  const profile = product.profile || {};
  const co = customOverrides?.claudeAnalysis || {};

  // Build product context from all available profile fields
  // NOTE: These are raw product data points. The prompt instructs Claude to translate them into customer-facing benefits.
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
  const formulaSection = co.formulaPreservation || `FORMULA PRESERVATION:
Follow the SAME sentence rhythm, approximate length, and rhetorical pattern as the original. You are copying the PROVEN FORMULA structure — but filling it with THIS product's real data.

STRUCTURE EXAMPLES (keep the pattern, swap the content):
- "Bye Bye, Beer Belly" → "Bye Bye, Power Bills" (keeps "Bye Bye,")
- "Kill The Bloated Belly" → "Kill The Middleman" (keeps "Kill The")
- "3 Years of Back Pain Gone in 7 Days" → "3 Years of Missing Gains Gone in 7 Days"
- "Now just £5 a bottle" → "Now just $59.99 a unit" (keeps "Now just ... a [container]")

CRITICAL — PRODUCT DATA OVERRIDES GENERIC TEXT:
If the reference ad contains GENERIC claims or filler statements (e.g. "Real Mining for 12+ Hours Daily", "Authentic Performance", "True Results"), you MUST replace them with SPECIFIC claims from the PRODUCT CONTEXT above. Use the mechanism, benefits, big promise, and notes fields — they contain the real product data.
- If mechanism says "attempts a block 144 times daily" → rewrite as a CUSTOMER BENEFIT: "144 daily chances to win $300K+"
- If benefits list technical features → rewrite as benefits: "1 watt power draw" becomes "Only $1/month to run"
- NEVER keep a generic reference phrase when the product context has a specific replacement
- The product context fields are GROUND TRUTH — but always REWRITE them as customer-facing benefits, never paste technical specs raw

ELEMENT COUNT: The adapted text count must EXACTLY MATCH the original count — same number of headlines, bullets, badges, stats. Do not add or remove elements. Leave fields empty ("") if no corresponding text exists.
- Generic labels like "SPECIAL DEAL", "FREE SHIPPING" stay exactly as-is — BUT discount codes (e.g. "Use code XYZ") MUST be replaced with the product's actual code`;

  // Cross-niche visual mapping
  const crossNicheSection = co.crossNicheAdaptation
    ? `\n\n---\n\n${co.crossNicheAdaptation}`
    : '';

  // Visual adaptation rules
  const visualAdaptationRules = co.visualAdaptation
    ? `\n\n${co.visualAdaptation}`
    : '';

  // If template has deep analysis, include it
  const deepAnalysisSection = templateData?.deep_analysis ? `

---

PRE-ANALYZED TEMPLATE INTELLIGENCE:
This template has been pre-analyzed. Use this intelligence to produce better results:

Layout: ${JSON.stringify(templateData.deep_analysis.layout, null, 2)}
Typography: ${JSON.stringify(templateData.deep_analysis.typography, null, 2)}
Product Analysis: ${JSON.stringify(templateData.deep_analysis.product_analysis, null, 2)}
Color Palette: ${JSON.stringify(templateData.deep_analysis.color_palette, null, 2)}
Design Elements: ${JSON.stringify(templateData.deep_analysis.design_elements, null, 2)}
Adaptation Instructions: ${JSON.stringify(templateData.deep_analysis.adaptation_instructions, null, 2)}

IMPORTANT: Follow the adaptation_instructions closely. Pay special attention to:
- critical_elements_to_preserve: These MUST remain unchanged
- common_failure_modes: Actively AVOID these issues
- product_replacement_notes: Follow these for product placement
- text_replacement_strategy: Use "${templateData.deep_analysis.adaptation_instructions?.text_replacement_strategy || 'direct-swap'}" approach
` : '';

  return `You are a $50K/month media buyer who writes ad copy that actually converts cold traffic. You've spent millions on Facebook ads. You know exactly what makes someone stop scrolling and click.

You are analyzing a reference ad image and rewriting its copy for a different product.

YOUR JOB:
1. Extract every text element visible in the image — miss NOTHING
2. Count people and product shots
3. Rewrite every text element for the product below
4. Identify visual elements that need to change

CRITICAL RULES FOR ADAPTED COPY:

STEP ZERO — ANALYZE THE REFERENCE'S COMMUNICATION STYLE BEFORE WRITING ANYTHING:
Look at the reference ad and identify its tone: aggressive/clickbait, calm/promotional, testimonial/story, curiosity-driven, urgency/scarcity, educational, or comparison. Your adapted copy MUST match this exact tone. Do NOT change the emotional register — a calm sale ad stays calm, an aggressive ad stays aggressive.

THEN apply these rules:
- Write like you're texting your friend about a product you genuinely love — NOT like a marketing department
- Use the SAME copywriting formula/structure as the original (same sentence patterns, same rhythm, same number of elements)
- But make it SPECIFIC to this product — use real product details, real benefits, real numbers
- ⚠️ CRITICAL LENGTH RULE: Each adapted text MUST be the SAME length (±20%) as the original. An AI image generator will render your text — if you write longer text, it WILL be misspelled and garbled. SHORT = PERFECT RENDERING. LONG = GARBLED MESS. If original is "Adaptogenic mushroom blend" (26 chars), adapted must be ~26 chars like "144 daily Bitcoin attempts" (25 chars), NOT "144 real shots at a $300K Bitcoin block. Every single day." (59 chars — WAY too long, will be garbled).
- ⚠️ COMPLETE THOUGHTS ONLY: Every adapted text MUST be a COMPLETE sentence or phrase. NEVER write a fragment that trails off. If the original is short (e.g. "Bloating" = 8 chars), write a complete short phrase (e.g. "Pool fees" = 9 chars), NOT an unfinished sentence like "Splitting fees with" (trails off mid-thought). Short originals need short, punchy, COMPLETE adapted text.
- ⚠️ ZERO REFERENCE PRODUCT TEXT: Your adapted text must contain ZERO words from the reference product's category. If the reference is about hair growth, words like "shedding", "hair", "regrowth", "follicle" must NEVER appear in adapted_text. If the reference is about supplements, words like "mushroom", "adaptogenic", "blend" must NEVER appear. Replace ALL of them with ${product.name}-relevant terms.
- If the original says "3 Years of Back Pain Gone in 7 Days" → yours should be equally specific and bold with THIS product's claims
- NEVER write vague platitudes like "Transform Your Experience" or "Unlock Your Potential" or "The Future of [X]"
- NEVER use these AI-sounding phrases: "game-changer", "revolutionary", "cutting-edge", "seamless", "elevate", "unlock", "transform your", "discover the", "experience the"
- Match the original's energy level EXACTLY — if it's screaming, scream. If it's whispering, whisper.

BENEFIT-FOCUSED WRITING (CRITICAL — READ THIS):
Every bullet, feature callout, and body text must be written as a CUSTOMER BENEFIT, not a technical spec.
The customer does not care about specs. They care about what the product DOES FOR THEM.
- WRONG: "1 watt power draw" (this is a spec sheet, not an ad)
- RIGHT: "Only $1/month to run" (this is a benefit the customer cares about)
- WRONG: "144 attempts daily" (technical jargon)
- RIGHT: "144 chances to win $300K every single day" (exciting outcome)
- WRONG: "Solo mining technology" (feature)
- RIGHT: "Keep 100% of your rewards — no pool fees" (benefit)
- WRONG: "SHA-256 algorithm" (nobody cares)
- RIGHT: "Real Bitcoin, not some shitcoin" (speaks to desire)

RULE: For EVERY adapted text element, ask yourself: "Would a normal person scrolling Facebook at 11pm care about this?" If the answer is no, rewrite it as a benefit they WOULD care about. Use the product context to find the real benefits — price savings, outcome, emotional payoff, social proof.

PRODUCT CONTEXT:
${contextLines}${brandSection}${productIdentity}${pricingRules}
${layoutMap ? `
---

PRE-ANALYZED LAYOUT MAP (use this to guide text length and placement):
  Archetype: ${layoutMap.archetype || 'standard'}
  Canvas: ${layoutMap.canvas?.orientation || 'unknown'} ${layoutMap.canvas?.aspect_ratio || ''}
  Background: ${layoutMap.background?.type || 'solid'} (${layoutMap.background?.tone || 'dark'})
  Product Zone: ${layoutMap.product_zone?.position || 'center'} (~${layoutMap.product_zone?.size_pct || '30%'} of canvas, ${layoutMap.product_zone?.presentation || 'standard'})
  Text Elements:
${(layoutMap.text_elements || []).map(t => `    ${(t.role || 'text').toUpperCase()} (H${t.hierarchy || '?'}): ${t.position || 'unknown'} — ${t.alignment || 'center'}-aligned — ~${t.char_count_approx || '?'} chars — ${t.visual_treatment || 'plain'}${t.container ? ` [${t.container}]` : ''}`).join('\n')}

USE THIS LAYOUT MAP TO:
- Match your adapted text LENGTH to each element's char_count_approx — if a headline position fits ~25 chars, write ~25 chars
- Understand the spatial hierarchy — H1 gets the most impactful copy, badges get short punchy text
- If the layout has stat positions, write stat-worthy numbers/claims for those positions
- Respect the template's rhythm: if it has 2 short badges, write 2 short badges — not 5
` : ''}${deepAnalysisSection}
---

TEXT EXTRACTION RULES:
- Only extract text ACTUALLY VISIBLE in the image — do NOT hallucinate text
- Extract ALL text: brand name, headline, subheadline, body, CTA buttons, review counts, star ratings, price badges, discount %, feature callouts, comparison labels, fine print
- Progress/timeline labels ("Day 0", "Day 45", "Before", "After") stay as-is — do NOT extract or swap them
- Prices extracted exactly and adapted with real product price
- Multi-line headlines kept as one string with natural line breaks
- Generic labels like "SPECIAL DEAL", "THIS WEEK ONLY", "FREE SHIPPING" stay exactly as-is — BUT discount codes (e.g. "Use code XYZ") are NOT generic labels and MUST be replaced with the product's actual discount code

BRAND NAME REPLACEMENT:
- If the reference ad contains a competitor brand name in ANY text element (headline, body, badges, etc.), you MUST replace it with the Product Name from PRODUCT CONTEXT
- This includes brand names in headlines like "RYZE Mushroom Coffee" → "${product.name}", badges like "Powered by XYZ" → "Powered by ${product.name}", etc.
- The competitor brand name must appear ZERO times in adapted_text

SEASONAL & DATE-SPECIFIC TEXT:
- If the reference contains month names ("March Sale", "Summer Deal"), replace with a generic urgency phrase ("Flash Sale", "Limited Time") or the current season — do NOT keep a stale month reference
- If the reference contains specific dates or year references ("2024 Edition", "Dec 25th"), update or generalize them
- Holiday-specific text ("Christmas Special", "Black Friday") should be replaced with generic urgency unless the product context specifies a current promotion

DISCOUNT CODE & OFFER REPLACEMENT:
- If the reference ad contains a discount code (e.g. "Use code SPRING10", "Code: ABC", "Enter PROMO20 at checkout"), extract it AND replace it in adapted_text with the Discount Codes from PRODUCT CONTEXT above
- If the reference ad has discount percentages (e.g. "Save 40%"), replace with the Max Discount from PRODUCT CONTEXT if available
- If product has NO discount codes listed in PRODUCT CONTEXT, keep the original discount code text as-is (do not remove it)
- Discount codes are NEVER "generic labels" — they are product-specific and MUST always be swapped

---${headlineRules}${headlineExamples}${bannedPhrases}

---

${formulaSection}

---

COPY QUALITY SELF-CHECK (run this mentally before returning):
1. Read each adapted headline out loud. Does it sound like something a REAL person would say? If it sounds like a corporate tagline → REWRITE IT
2. Is every claim SPECIFIC? "Save money" is garbage. "Save $47/month" is good. "Cut your power bill in half" is great.
3. Would this make someone STOP SCROLLING on Facebook at 11pm? If not → more emotional, more specific, more urgent
4. Does it use any word a normal person wouldn't say in conversation? ("Elevate", "Transform", "Revolutionize", "Seamless") → REMOVE IT
5. Is the energy level matching the original? If the original is screaming, yours should be screaming too.
6. Count check: same number of headlines, bullets, badges, stats as original. Don't add or remove elements. Leave fields empty ("") if no corresponding text exists.
7. ⚠️ REFERENCE BLEED CHECK (CRITICAL): Re-read EVERY adapted_text. Does ANY text mention the REFERENCE product's industry, features, or terminology instead of the NEW product's? If the reference is a hair supplement and you see "hair regrowth", "DHT", "shedding", "follicle" in your adapted text, you FAILED — that is reference bleed-through. EVERY single text element must be about the NEW product, not the reference. Replace ALL reference-specific language with equivalent claims from PRODUCT CONTEXT.
8. GRAMMAR & SPELLING CHECK: Read every adapted text element. Fix any grammar or spelling errors. "atemps" → "attempts". "Gaurantee" → "Guarantee". Every word must be spelled correctly.
9. BENEFIT CHECK: Re-read every bullet/stat. Does it state a spec or a benefit? "144 attempts daily" is a SPEC → rewrite as "144 daily chances to win $300K+". "1 watt" is a SPEC → rewrite as "$1/month to run". If any text reads like a product spec sheet, you FAILED — rewrite it.
10. ⚠️ CHARACTER COUNT CHECK (CRITICAL FOR IMAGE GENERATION — THIS IS THE #1 CAUSE OF BAD OUTPUT):
   For EVERY adapted text element, count the characters and compare to the original:
   - If original is 25 chars, adapted MUST be 20-30 chars (NOT 50+ chars)
   - If original is 40 chars, adapted MUST be 35-45 chars (NOT 70+ chars)
   - NEVER exceed the original length by more than 20%. The image generator CANNOT render long text — it will truncate, misspell, or garble text that is too long.
   - SHORT text renders PERFECTLY. Long text renders BADLY. When in doubt, make it SHORTER.
   - A 3-word bullet like "No more bloating" should become "144 daily Bitcoin shots" (3-4 words) — NOT "144 real shots at a $300K Bitcoin block. Every single day." (too long!)
   - REWRITE any adapted text that exceeds the original character count by more than 20%
10. BRAND NAME CHECK: Does any adapted text still contain the COMPETITOR's brand name? If yes, replace it with the product name from PRODUCT CONTEXT. Zero competitor branding in adapted text.
11. COMPLETE THOUGHT CHECK: Read each adapted text. Does it end mid-sentence? "Crypto feels too" is INCOMPLETE. "Crypto is complex" is COMPLETE. "Splitting fees with" is INCOMPLETE. "No pool fees" is COMPLETE. EVERY adapted text must be a complete thought that makes sense on its own.
12. REFERENCE CATEGORY CHECK: Does any adapted text contain words from the REFERENCE product's category (e.g. "hair", "gut", "mushroom", "belly", "shedding")? If yes, replace with words about YOUR product. Zero reference category terms in adapted text.

---

VISUAL ANALYSIS:
For each visual element, note:
- What it shows in original (e.g. "3 belly transformation photos in grid")
- What it SHOULD show for new product
- Where in layout
- Generic (keep) or angle-specific (must change)

PRODUCT ORIENTATION: Look at how the product is shown in the reference image. Describe its angle/orientation in the "product_orientation" field:
- "front-facing" = product shown straight-on, symmetrical
- "angled-left" = product rotated showing left side
- "angled-right" = product rotated showing right side
- "top-down" = product shown from above
- "tilted" = product at a dramatic angle
This tells the image generator which product photo angle to use.${crossNicheSection}${visualAdaptationRules}

---

LOGO DETECTION (has_competitor_logo):
Set has_competitor_logo to TRUE if the reference image contains ANY of these:
- A company/brand LOGO GRAPHIC (icon, emblem, wordmark, or symbol)
- A brand name displayed as a standalone design element (not part of body text) — e.g. "RYZE" in a styled header, a brand watermark, a branded badge
- A product label/packaging that prominently shows a competitor brand name or logo
- ANY visual branding element that should be replaced with our brand

Set has_competitor_logo to FALSE ONLY if:
- There is genuinely no brand identity visible anywhere in the ad
- The only brand reference is within the headline/body copy text (which will be swapped via text pairs)

When in doubt, set to TRUE — it is better to send our logo and let the image generator decide whether to use it, than to miss a competitor logo that stays in the final ad.

IMPORTANT: If you detect a logo, you MUST also include it in visual_adaptations with position describing where the logo sits and adapted_visual set to "replace with provided brand logo".

LOGO BACKGROUND TONE (logo_background_tone):
Look at the area of the ad where the competitor logo sits (or where a logo would naturally go — typically top corner or bottom).
- Set to "dark" if that area has a dark/black background (our WHITE logo should be used)
- Set to "light" if that area has a light/white background (our BLACK logo should be used)
- Set to "mixed" if unclear or gradient (default to our dark logo)

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
  "reference_product_category": "the category/niche of the REFERENCE ad product (e.g. 'hearing aids', 'hair supplements', 'skincare', 'coffee')",
  "reference_product_keywords": ["list", "of", "category-specific", "words", "from", "reference", "that", "must", "NOT", "appear", "in", "output"],
  "people_count": 0,
  "product_count": 0,
  "product_orientation": "front-facing|angled-left|angled-right|top-down|tilted",
  "has_competitor_logo": false,
  "logo_background_tone": "dark|light|mixed",
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

  // ── Strip emojis from swap pairs — NanoBanana can't render them ──
  const emojiRegex = /[\u{1F600}-\u{1F64F}\u{1F300}-\u{1F5FF}\u{1F680}-\u{1F6FF}\u{1F1E0}-\u{1F1FF}\u{2600}-\u{26FF}\u{2700}-\u{27BF}\u{FE00}-\u{FE0F}\u{1F900}-\u{1F9FF}\u{1FA00}-\u{1FA6F}\u{1FA70}-\u{1FAFF}\u{200D}\u{20E3}\u{E0020}-\u{E007F}]|[🚫✅❌⚠️✓✗☐☑☒⬆⬇⬅➡🔥💪🎉🏆💰💎🚀⭐🌟❤️💯🎯🔒🔓📱💡🎁🛒🛡️📊📈🏅🥇🥈🥉]/gu;
  for (const pair of pairs) {
    const origClean = pair.original.replace(emojiRegex, '').trim();
    const adaptedClean = pair.adapted.replace(emojiRegex, '').trim();
    if (origClean !== pair.original || adaptedClean !== pair.adapted) {
      pair.original = origClean;
      pair.adapted = adaptedClean;
    }
  }

  // ── Length enforcement: truncate adapted text that's too long ──
  // NanoBanana garbles/misspells text that exceeds the original length significantly
  for (const pair of pairs) {
    const origLen = pair.original.length;
    const adaptedLen = pair.adapted.length;
    const maxLen = Math.max(origLen * 1.3, 20); // allow 30% overshoot or minimum 20 chars

    if (adaptedLen > maxLen && origLen > 5) {
      let trimmed = pair.adapted.slice(0, Math.round(maxLen));
      // Don't cut mid-word — find last natural break point
      const breakPoints = ['. ', '! ', '? ', ', ', ' — ', ' - ', ' '];
      let bestBreak = -1;
      for (const bp of breakPoints) {
        const idx = trimmed.lastIndexOf(bp);
        if (idx > trimmed.length * 0.4) { bestBreak = idx + (bp === ' ' ? 0 : bp.length - 1); break; }
      }
      if (bestBreak > 0) {
        trimmed = trimmed.slice(0, bestBreak).trim();
      } else {
        const lastSpace = trimmed.lastIndexOf(' ');
        if (lastSpace > trimmed.length * 0.5) trimmed = trimmed.slice(0, lastSpace);
      }
      // Remove trailing punctuation that looks weird
      trimmed = trimmed.replace(/[,;:\-—]+$/, '').trim();
      pair.adapted = trimmed;
      console.log(`[buildSwapPairs] ⚠️ Truncated [${pair.field}]: ${adaptedLen}→${pair.adapted.length} chars (orig was ${origLen}): "${pair.adapted}"`);
    }
  }

  return pairs;
}

// ─────────────────────────────────────────────────────────────────────────────
// STEP 3: NanoBanana (Gemini) — Image Generation Prompt
// ─────────────────────────────────────────────────────────────────────────────

export function buildNanoBananaPrompt(claudeResult, swapPairs, product, logoCount = 0, customOverrides = null, layoutMap = null, logoBackgroundTone = null, skipTextRendering = false, templateData = null) {
  const {
    people_count, product_count, adapted_audience,
    character_adaptation, visual_adaptations
  } = claudeResult;
  const co = customOverrides?.nanoBanana || {};

  // Template visual intelligence from deep analysis
  const templateIntelligence = templateData?.deep_analysis ? `

TEMPLATE VISUAL INTELLIGENCE (from pre-analysis):
- Background: ${templateData.deep_analysis.background?.type || 'unknown'} (${templateData.deep_analysis.background?.primary_color || 'unknown'})
- Layout: ${templateData.deep_analysis.layout?.grid_structure || 'unknown'}
- Product Zone: ${templateData.deep_analysis.layout?.safe_zones?.product_zone?.position || 'center'} (${templateData.deep_analysis.layout?.safe_zones?.product_zone?.size_percent || 40}% of image)
- Logo Zone: ${templateData.deep_analysis.layout?.safe_zones?.logo_zone?.position || 'top-left'}
- Color Mood: ${templateData.deep_analysis.color_palette?.overall_mood || 'neutral'}
- Shadow Effects: ${templateData.deep_analysis.design_elements?.shadow_effects || 'none'}
- Product Replacement Difficulty: ${templateData.deep_analysis.adaptation_instructions?.product_replacement_difficulty || 'medium'}
${templateData.deep_analysis.adaptation_instructions?.common_failure_modes?.length > 0
  ? `\nKNOWN FAILURE MODES TO AVOID:\n${templateData.deep_analysis.adaptation_instructions.common_failure_modes.map(f => `- ${f}`).join('\n')}`
  : ''}
` : '';

  const pCount = people_count ?? 0;
  const pCount2 = product_count ?? 1;

  // Text swap pairs — include field name so NanoBanana knows which element to target
  const swapSection = swapPairs.map((pair, i) =>
    `  ${i + 1}. [${pair.field || 'text'}] "${pair.original}" → "${pair.adapted}"`
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

  // (Custom text rules and brand identity now folded into the condensed prompt below)

  // ── Build a SHORT, focused prompt — image gen models need brevity ──
  // Text swaps go FIRST because they're the most critical instruction.
  // Everything else is secondary. Long prompts cause the model to ignore key instructions.

  const logoImageRef = logoCount > 1 ? `images 2-${1 + logoCount}` : 'image 2';
  const logoInstruction = logoCount > 0
    ? `\n🔴 LOGO RULE: Replace any competitor logo with the EXACT logo provided (${logoImageRef}). COPY the logo EXACTLY as it appears in ${logoImageRef} — same shape, same proportions, same text styling. Do NOT redesign, redraw, or generate your own version of the logo. PASTE the provided logo image directly. If your output logo looks different from ${logoImageRef} in ANY way, you have FAILED.${logoBackgroundTone === 'dark' ? ' Use the WHITE logo version (dark background).' : logoBackgroundTone === 'light' ? ' Use the BLACK logo version (light background).' : ''}`
    : '';

  // Only include the MUST CHANGE visual adaptations (skip keep-as-is ones)
  const mustChangeVisuals = (visual_adaptations || []).filter(v => v.is_angle_specific);
  const visualLine = mustChangeVisuals.length > 0
    ? `\nVisual changes: ${mustChangeVisuals.map(v => `${v.position}: replace "${v.original_visual}" with "${v.adapted_visual}"`).join('; ')}`
    : '';

  // Prioritize swap pairs — NanoBanana handles fewer swaps more accurately
  // Priority: headline > subheadline > brand/other_text > badges > bullets > stats > body > disclaimer
  const FIELD_PRIORITY = { headline: 1, subheadline: 2, cta: 3 };
  const getFieldPriority = (field) => {
    if (FIELD_PRIORITY[field]) return FIELD_PRIORITY[field];
    if (field?.startsWith('other_text')) return 4; // brand names etc
    if (field?.startsWith('badges')) return 5;
    if (field?.startsWith('bullets')) return 6;
    if (field?.startsWith('stats')) return 7;
    if (field === 'body') return 8;
    return 9;
  };

  // Filter out near-identical swaps — if original ≈ adapted, let NanoBanana keep the original
  // This reduces noise and lets the model focus on real changes
  const meaningfulPairs = swapPairs.filter(pair => {
    const o = (pair.original || '').toLowerCase().replace(/[^a-z0-9]/g, '');
    const a = (pair.adapted || '').toLowerCase().replace(/[^a-z0-9]/g, '');
    if (o === a) return false; // identical after normalizing
    // Skip if only minor punctuation/casing difference
    if (o.length > 5 && a.length > 5) {
      let matches = 0;
      const shorter = Math.min(o.length, a.length);
      for (let i = 0; i < shorter; i++) { if (o[i] === a[i]) matches++; }
      if (matches / shorter > 0.85) {
        console.log(`[buildNanoBananaPrompt] Skipping near-identical swap [${pair.field}]: "${pair.original}" ≈ "${pair.adapted}"`);
        return false;
      }
    }
    return true;
  });

  // Dynamic swap limit based on complexity:
  // - Simple layouts (≤7 meaningful swaps): use all swaps, best quality
  // - Complex layouts (8+ swaps): keep ALL swaps to prevent reference text bleed-through
  //   Dropping swaps from complex layouts causes the reference product's text to remain visible
  const isComplexLayout = meaningfulPairs.length > 7;
  const MAX_SWAP_PAIRS = isComplexLayout ? 12 : 7; // complex = keep more, simple = keep tight
  const sortedPairs = [...meaningfulPairs].sort((a, b) => getFieldPriority(a.field) - getFieldPriority(b.field));
  const limitedPairs = sortedPairs.slice(0, MAX_SWAP_PAIRS);
  if (sortedPairs.length > MAX_SWAP_PAIRS) {
    console.log(`[buildNanoBananaPrompt] ⚠️ Limited swap pairs from ${sortedPairs.length} to ${MAX_SWAP_PAIRS} (dropped low-priority pairs)`);
  }
  if (isComplexLayout) {
    console.log(`[buildNanoBananaPrompt] Complex layout detected (${meaningfulPairs.length} swaps) — using extended limit of ${MAX_SWAP_PAIRS}`);
  }

  // Truncate swap pairs that are too long — NanoBanana garbles long text
  const truncatedPairs = limitedPairs.map(pair => {
    const origLen = (pair.original || '').length;
    let adapted = pair.adapted || '';
    // If adapted is much longer than original, truncate with warning
    if (adapted.length > origLen * 1.3 && origLen > 0 && origLen < 80) {
      adapted = adapted.slice(0, Math.max(origLen + 5, 20));
      // Clean up truncation — don't end mid-word
      const lastSpace = adapted.lastIndexOf(' ');
      if (lastSpace > adapted.length * 0.6) adapted = adapted.slice(0, lastSpace);
    }
    return { ...pair, adapted };
  });

  const swapSectionFinal = truncatedPairs.map((pair, i) =>
    `  ${i + 1}. "${pair.original}" → "${pair.adapted}"`
  ).join('\n');

  // For complex layouts, add a strong warning about reference product text
  const complexWarning = isComplexLayout
    ? `\n⚠️ CRITICAL: The reference ad is for a COMPLETELY DIFFERENT product. ALL text in your output must be about "${product.name}". If you see text about the reference product's category (hair, supplements, skincare, etc.), you MUST replace it with the swap text above. ZERO words from the original product should remain.`
    : '';

  // Build banned text section from Claude's reference analysis
  const refCategory = claudeResult.reference_product_category || '';
  const refKeywords = claudeResult.reference_product_keywords || [];
  const bannedTextSection = refCategory || refKeywords.length > 0
    ? `\n\n⛔ BANNED TEXT — the reference ad is about "${refCategory}". These words must NEVER appear in your output: ${refKeywords.length > 0 ? refKeywords.map(w => `"${w}"`).join(', ') : refCategory}. If you see ANY of these words in the reference image, replace them with the swap text above or remove them. ZERO reference product text in the output.`
    : '';

  // Determine if the reference ad contains a product image or is text-only
  const hasProductInReference = (product_count ?? 1) > 0;

  const productImageRule = hasProductInReference
    ? `Replace the product with "${product.name}" (FIRST image).

🔴 PRODUCT IMAGE RULE (MOST IMPORTANT):
The FIRST image is a PHOTO of the real product. You MUST copy this EXACT product into the output — same shape, same colors, same screen, same details. Do NOT generate, imagine, or interpret what the product looks like. Do NOT create your own version. PASTE the product from the FIRST image into the ad layout. The product in your output must look IDENTICAL to the FIRST image — as if you cut it out and placed it in. If your output product looks different from the FIRST image in ANY way (wrong shape, wrong screen, wrong details), you have FAILED.`
    : `The reference ad has NO product image — it is a text-only or letter-style ad. Do NOT add any product photo, device image, or product graphic. Keep the layout TEXT-ONLY, exactly like the reference. The FIRST image is provided for context only — do NOT insert it into the output.`;

  return `Edit the reference ad (LAST image). ${hasProductInReference ? productImageRule : productImageRule}

TEXT SWAPS — replace ALL text in the reference with these EXACT words:
${swapSectionFinal || '(No text changes)'}

⚠️ TEXT RULE: You MUST replace EVERY piece of text in the reference image. The reference ad is for a COMPLETELY DIFFERENT product${refCategory ? ` ("${refCategory}")` : ''}. Your output must contain ZERO words from the reference product. If ANY text in your output still mentions the reference product, you have FAILED.${bannedTextSection}

RULES:
- Spell "${product.name}" exactly: ${product.name.split('').join('-')}. NOT "MineBlock" or "MinerBlorge".
- Keep EXACT same layout, background, colors, fonts, positions.${hasProductInReference ? `\n- Product orientation: ${claudeResult.product_orientation || 'front-facing'}, matching the FIRST image.${productRulesSection}` : ''}${logoInstruction}${visualLine}
- ${characterRules}
- Do NOT add extra elements (coins, sparkles, badges, product images) not in the reference.
- Background must match reference exactly.
- ANY text not listed in the swap list that refers to the reference product MUST be removed or replaced with "${product.name}" text.${hasProductInReference ? '' : '\n- This is a TEXT-ONLY ad. Do NOT insert any product image, device photo, or visual element that is not in the reference.'}${complexWarning}${co.absoluteRules ? `\n${co.absoluteRules}` : ''}${templateIntelligence}`;
}
