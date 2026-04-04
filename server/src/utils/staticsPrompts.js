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

export function buildClaudePrompt(product, angle, customOverrides = null, layoutMap = null) {
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
` : ''}
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
7. GRAMMAR & SPELLING CHECK: Read every adapted text element. Fix any grammar or spelling errors. "atemps" → "attempts". "Gaurantee" → "Guarantee". Every word must be spelled correctly.
8. BENEFIT CHECK: Re-read every bullet/stat. Does it state a spec or a benefit? "144 attempts daily" is a SPEC → rewrite as "144 daily chances to win $300K+". "1 watt" is a SPEC → rewrite as "$1/month to run". If any text reads like a product spec sheet, you FAILED — rewrite it.
9. CHARACTER COUNT CHECK: Compare each adapted text element's length against its original. If your adapted text is more than 30% longer than the original, SHORTEN IT. The text must fit in the same visual space. A 20-char original should not become a 40-char adaptation.
10. BRAND NAME CHECK: Does any adapted text still contain the COMPETITOR's brand name? If yes, replace it with the product name from PRODUCT CONTEXT. Zero competitor branding in adapted text.

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

LOGO DETECTION (has_competitor_logo) — BE VERY STRICT:
Set has_competitor_logo to TRUE **only** if the reference image contains a clearly visible, distinct company/brand LOGO GRAPHIC (an icon, emblem, wordmark, or symbol that is a designed logo element separate from the ad copy text).
Set has_competitor_logo to FALSE if:
- The brand name only appears as part of the headline/body text (e.g. "RYZE" in "RYZE Mushroom Coffee" headline)
- There is a product label/packaging with a brand name but no separate standalone logo
- There is no distinct logo graphic visible anywhere in the ad
- You are unsure — when in doubt, return FALSE
This field controls whether brand logos are injected into the generated ad. A false positive will cause unwanted logos to appear.

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

  return pairs;
}

// ─────────────────────────────────────────────────────────────────────────────
// STEP 3: NanoBanana (Gemini) — Image Generation Prompt
// ─────────────────────────────────────────────────────────────────────────────

export function buildNanoBananaPrompt(claudeResult, swapPairs, product, logoCount = 0, customOverrides = null, layoutMap = null, logoBackgroundTone = null) {
  const {
    people_count, product_count, adapted_audience,
    character_adaptation, visual_adaptations
  } = claudeResult;
  const co = customOverrides?.nanoBanana || {};

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
- TEXT FIDELITY: Render ONLY the text listed in the swap pairs above. Do NOT add headlines, subheadlines, badges, banners, watermarks, or ANY text not explicitly in the swap list. If the swap list has 5 pairs, the output must have EXACTLY 5 changed text elements — no more, no fewer
- No duplicate objects
- Layout labels (Day 0, Day 45, Before, After, etc.) stay exactly as-is
- No trace of competitor product or brand remaining
- BACKGROUND FIDELITY: The background must be a PIXEL-PERFECT match to the reference — same color, same gradient direction, same texture, same pattern. Do NOT simplify, flatten, or recolor the background
- Hands must have 5 fingers, realistic anatomy
- Do NOT place any text, logo, or overlay on the product itself
- Do NOT invent or generate any logo, icon, emblem, or symbol${logoCount > 0 ? ' beyond the provided logo' : ''}`;

  return `Replicate the reference ad (LAST image) exactly, with only the product and text swapped.

The first image(s) show the replacement product — reproduce it EXACTLY as photographed. Multiple angles may be provided.
${logoCount > 0 ? `\nA brand logo is provided between the product photos and the reference ad. Use this EXACT logo where the competitor logo appears. Copy the logo PIXEL-FOR-PIXEL from the provided logo image — do NOT redraw, stylize, or approximate it. The logo must be an exact reproduction.${logoBackgroundTone === 'dark' ? '\nIMPORTANT: The logo area has a DARK background — use the WHITE/light version of the logo for maximum contrast and visibility.' : logoBackgroundTone === 'light' ? '\nIMPORTANT: The logo area has a LIGHT background — use the BLACK/dark version of the logo for maximum contrast and visibility.' : ''}` : ''}

1. REPLICATE the reference ad's layout, composition, background color/gradient, font styles, text positions, spacing, shadows, borders — match the reference style exactly.

2. REPLACE the competitor's product with ${product.name} from the product photos. Show exactly ${pCount2} product(s) in the same position(s), matching shape, colors, and label exactly as photographed. Show the product in a ${claudeResult.product_orientation || 'front-facing'} orientation to match the reference layout — pick the product photo angle that best matches this orientation.${pCount2 > 1 ? `\n  If the reference shows ${pCount2} products but only 1 product photo is provided, show ${pCount2} copies of the same product at slightly different angles or positions to fill the same layout zones.` : ''}${productRulesSection}

3. SWAP TEXT — only these specific pairs, matching original font style, weight, size, and color:
${swapSection || '  (No text changes)'}
CRITICAL TEXT RENDERING RULES:
- Every letter must be sharp, legible, and CORRECTLY SPELLED — zero tolerance for typos
- Render text as clean, professional typography — NOT blurry, warped, or distorted
- SPELL CHECK: Before rendering each text element, verify the spelling LETTER BY LETTER against the swap pair above. Do NOT approximate or guess — copy the EXACT string character-for-character
- Common AI text rendering mistakes to NEVER make: "ATTEMTS"→"ATTEMPTS", "GAURANTEE"→"GUARANTEE", "RECIEVE"→"RECEIVE", "CHANECS"→"CHANCES", "EVEYR"→"EVERY", "BITCONI"→"BITCOIN"
- Do NOT truncate or shorten numbers: if the text says "144" render "144" not "14". If it says "$300K" render "$300K" not "$300"
- Do NOT merge or split words: "every day" is two words, "forever" is one word
- TEXT ALIGNMENT: Match the EXACT alignment and centering of each text element from the reference. If the reference text is centered, your text MUST be centered. If left-aligned, keep left-aligned. Horizontally center text within its container/zone — do NOT shift text left or right from where it appears in the reference
- TEXT SPACING: Maintain the same vertical spacing between text elements as the reference. Do NOT compress or expand the gaps between lines, headlines, bullets, or stat blocks
- Text must look like it was set by a professional graphic designer, not generated by AI
- If you cannot render a word correctly, use a SHORTER simpler synonym rather than a misspelled version
- UNCHANGED TEXT: All text in the reference that is NOT listed in the swap pairs above must remain EXACTLY as-is — same words, same spelling, same font, same position. Do NOT modify, rephrase, translate, or misspell any text that isn't being swapped${textRulesSection}

4. ${characterRules}

5. VISUAL ADAPTATIONS:
${visualSection || '  (Keep all visuals as-is)'}
${brandIdentitySection}
${layoutMap ? `
7. LAYOUT STRUCTURE (follow this precisely — positions are non-negotiable):
  Archetype: ${layoutMap.archetype || 'standard'}
  Canvas: ${layoutMap.canvas?.orientation || 'unknown'} ${layoutMap.canvas?.aspect_ratio || ''}
  Background: ${layoutMap.background?.type || 'solid'} (${layoutMap.background?.tone || 'dark'})${layoutMap.background?.zones ? ` — ${layoutMap.background.zones}` : ''}
  Product Zone: ${layoutMap.product_zone?.position || 'center'} (~${layoutMap.product_zone?.size_pct || '30%'} of canvas)
${(layoutMap.text_elements || []).map(t => `  ${(t.role || 'unknown').toUpperCase()} (H${t.hierarchy || '?'}): ${t.position || 'unknown'} — ${t.alignment || 'center'}-aligned — ${t.size || 'unknown'} — ~${t.char_count_approx || '?'} chars — ${t.visual_treatment || 'plain'}`).join('\n')}
  Composition: ${layoutMap.composition_notes || 'standard layout'}
  RULE: Every text element must be placed in its EXACT position as described above. Do not move, merge, or reorder any element.
  RULE: Text alignment (centered, left, right) must EXACTLY match the reference. If the reference centers text in a zone, your output must center text in that same zone.
` : ''}
${absoluteRulesSection}`;
}
