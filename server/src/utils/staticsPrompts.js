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
  // Split into MANDATORY RULES (pricing/offers) and CONTEXT (background info)
  // This ensures Claude uses real product data instead of inventing prices/offers

  // ── MANDATORY PRODUCT RULES (these override EVERYTHING in the reference) ──
  const mandatoryRules = [
    product.price && `PRICE: The ONLY valid price is ${product.price}. If the reference shows ANY price, replace it with ${product.price}.`,
    profile.discountCodes && `DISCOUNT CODE: The ONLY valid discount code is ${profile.discountCodes}. If the reference shows ANY discount code (e.g. "SPRING10", "PROMO20", "CODE: XYZ"), you MUST replace it with this code. NEVER invent a discount code.`,
    profile.maxDiscount && `MAX DISCOUNT: ${profile.maxDiscount}. If the reference shows a discount percentage, use this value. NEVER invent a discount percentage.`,
    profile.bundleVariants && `BUNDLE PRICING (use these EXACT numbers):\n${profile.bundleVariants}`,
    profile.offerDetails && `OFFER RULES: ${profile.offerDetails}`,
    profile.guarantee && `GUARANTEE: ${profile.guarantee}`,
    profile.complianceRestrictions && `🚫 COMPLIANCE (NEVER claim these): ${profile.complianceRestrictions}`,
    `NO FABRICATED QUANTITY CLAIMS: NEVER count individual offer items and create claims like "4 FREE GIFTS", "3 FREE BONUSES", "5 FREE ITEMS". If the product context lists free shipping, warranty, etc. as separate features, they are INDIVIDUAL OFFER COMPONENTS — not "gifts" to be counted. Only use quantity claims (e.g. "X FREE gifts/bonuses") if that EXACT phrase appears verbatim in the product context. When in doubt, list benefits individually ("FREE Shipping + Lifetime Warranty") instead of fabricating a count.`,
    `🚫 NO FABRICATED SOCIAL PROOF: NEVER invent review counts, user counts, customer counts, rating counts, testimonial counts, star ratings, "verified" counts, or any numeric social-proof claim (e.g. "2,400+ Verified Users", "10,000 Happy Customers", "4.9★ from 5,000 reviews", "Join 50k+"). Only use such numbers if that EXACT figure appears verbatim in PRODUCT CONTEXT. If no real number exists, REMOVE the numeric claim entirely and either omit the element or replace it with a non-numeric benefit ("Trusted by our community", "Loved by customers"). Synthesizing fake numbers is a critical failure — when in doubt, remove it.`,
    `🚫 NO FABRICATED STATISTICS / STUDY CLAIMS / RETENTION DATA: NEVER invent percentages, ratios, sample sizes, study results, clinical claims, efficacy figures, satisfaction scores, retention rates, or any "N%/N in N/N out of N" claim (e.g. "9 in 10 customers...", "72% improved fatigue", "87% saw results in 30 days", "93% satisfied"). Equally critical: NEVER fabricate a supporting footnote / asterisk disclaimer to back up a number (e.g. "*Based on a 2-month study of 50 adults", "*Based on customer retention data"). If the reference template has a big stat + footer disclaimer and the product has no real study/data, DROP BOTH elements (emit empty adapted_text so they are removed) OR replace with a non-numeric credibility claim ("Built for home miners who want 100% of their rewards"). Inventing studies is outright fraud — when in doubt, remove it.`,
    `🚫 NO FABRICATED SCARCITY / INVENTORY NUMBERS: NEVER invent stock counts, units-remaining, viewer counts, or countdown numbers (e.g. "Only 47 Units Left", "Last 12 in stock", "3 people viewing now", "7 sold in the last hour", "Ends in 02:14:33"). These are outright fabricated unless PRODUCT CONTEXT contains the exact figure. Use non-numeric scarcity instead ("Limited Stock", "Almost Gone", "While Supplies Last", "Selling Fast") — never a fake specific integer. Fabricated scarcity is both dishonest and a Meta/FTC compliance risk.`,
    `🚫 NO FABRICATED OFFER STRUCTURES — STRICTLY FOLLOW THE PRODUCT LIBRARY: The ONLY valid promotional offers are the ones listed verbatim in bundleVariants, offerDetails, discountCodes, or maxDiscount above. You may NOT invent or "adapt" any other offer construction. Specifically BANNED unless the EXACT structure appears in PRODUCT CONTEXT:\n  — "Buy X Get Y Free" (e.g. "Buy 3 Get 2 Free", "Buy 1 Get 1 Free")\n  — "BOGO" / "Buy One Get One"\n  — "N-for-M" (e.g. "3 for 2", "2 for 1", "5 for 4")\n  — "Free [item] with purchase/order/any"\n  — "Get N free when you order M"\n  — "Extra N free" / "N + N free"\n  — "Free gift with every order"\n  — Any other promotional construction not in PRODUCT CONTEXT.\n\nCRITICAL: Bundle SAVINGS are NOT the same as "Get Free" offers. A "3-pack saves $118" is NOT "Buy 3 Get 2 Free". A "2-pack for $449" is NOT "2 for 1". Do not translate bundle pricing into giveaway language.\n\nIF the reference ad shows a "Buy X Get Y Free" / "BOGO" / "N-for-M" structure, you MUST replace it with ONE OF:\n  (a) The real bundle from PRODUCT CONTEXT using bundleVariants numbers verbatim (e.g. "3-PACK — SAVE $118", "BUY 3, PAY $629")\n  (b) The real offer from offerDetails (e.g. "FREE SHIPPING + 2-YEAR WARRANTY")\n  (c) The real discount code/percentage from PRODUCT CONTEXT (e.g. "10% OFF WITH CODE BITCOIN10")\n  (d) A non-offer benefit claim if no real offer fits the slot size (e.g. "PLUG IN. WALK AWAY. MINE 24/7.")\n\nEXAMPLES:\n  ❌ "BUY 3 GET 2 FREE"              — not in product context → FABRICATED, FALSE ADVERTISING\n  ❌ "BUY 1 GET 1 FREE"              — not in product context → FABRICATED\n  ❌ "3 FOR 2"                       — not in product context → FABRICATED\n  ❌ "FREE UNIT WITH 2-PACK"         — not in product context → FABRICATED\n  ❌ "BOGO — MINE 2X AS MUCH"        — not in product context → FABRICATED\n  ✅ "3-PACK — SAVE $118"            — matches bundleVariants\n  ✅ "BUY 3, PAY $629"               — matches bundleVariants\n  ✅ "FREE SHIPPING + 2-YR WARRANTY" — matches offerDetails\n  ✅ "CODE BITCOIN10 FOR 10% OFF"    — matches discountCodes + maxDiscount\n\nFabricating an offer that the product does not actually have is outright false advertising. It violates Meta Ads policy, FTC advertising rules, and exposes the business to refund-fraud liability. When in doubt, omit the offer slot entirely (emit "") rather than invent one.`,
    `🚫 NO DECORATIVE GLYPHS IN ADAPTED_TEXT: Do NOT prefix bullets, badges, stats, or any copy with ✓ ✗ ★ ☆ → • ● ◆ ▶ » or similar symbol/checkmark glyphs. The image renderer will either mangle them into garbled shapes or strip them and leave an awkward leading space. Write plain text — the visual layout already communicates bullet structure.`,
    `🚫 NO MONTH NAMES OR SEASONAL SALE TEXT: If the reference contains ANY month name (January, February, March, April, May, June, July, August, September, October, November, December) or seasonal text ("Spring Sale", "Summer Deal", "March Promo", etc.), you MUST replace it with generic urgency copy ("Limited Time", "Flash Sale", "Today Only", "Ends Soon"). NEVER carry over a month name or season-specific sale text into adapted_text. This is non-negotiable.`,
    `🚫 NO AI-TELL CRUTCH WORDS: Every piece of adapted copy must sound like a human media buyer wrote it — not ChatGPT. BANNED WORDS AND PHRASES (do NOT use any of these, even once): "effortlessly", "seamlessly", "revolutionize", "revolutionary", "game-changer", "game-changing", "game changing", "elevate your", "unleash", "unlock your potential", "transform your", "transformative", "leverage", "empower", "empowering", "harness the power", "journey", "your journey", "cutting-edge", "state-of-the-art", "next-level", "next level", "take your [X] to the next", "delve into", "embark on", "navigate the", "at your fingertips", "meticulously", "intricate", "tapestry", "ecosystem" (unless literal), "paradigm", "holistic", "bespoke", "curated" (unless literal), "immerse", "effortless", "in today's fast-paced world", "in the ever-evolving", "in the realm of", "whether you're a [X] or [Y]", "look no further", "dive in", "dive into", "say goodbye to", "hello to", "power of", "world of", "realm of", "experience the [X]", "discover the [X]", "embrace". These are the DNA of AI-written copy — a human media buyer never writes them. Use concrete, specific, punchy language instead ("runs for $1 a month", "keep every block reward you mine", "plug it in, walk away, come back to Bitcoin").`,
    `✅ PREFER CONCRETE SPECIFICS OVER ABSTRACT HYPE: Your copy should pass the "would a skeptical Reddit user believe this?" test. Default to:\n  — Specific numbers from PRODUCT CONTEXT (price, wattage, warranty length)\n  — Concrete mechanics ("~30W from a standard wall outlet", "plug in via USB", "runs from any home office")\n  — Specific pain points ("pools take a 2% fee on every payout", "a used S19 still runs $3,000")\n  — Sharp contrasts ("no pool, no middleman, no fees")\nAVOID vague benefit-speak: "amazing results", "best-in-class", "premium experience", "top-tier", "industry-leading", "revolutionary approach", "proven to work", "unparalleled", "unmatched", "unrivaled", "second to none". If you can't point to a specific mechanism in PRODUCT CONTEXT that makes a claim true, cut the claim.`,
    !product.price && `🚫 NO INVENTED PRICES: The product price is not set. Do NOT copy, adapt, or carry over ANY price from the reference. Replace all price text with a non-price benefit claim (e.g. "Free Shipping" or the product name).`,
    product.price && `🚫 NO FABRICATED ANCHOR PRICES / FAKE "WAS $" INFLATION: When the reference template has a "WAS $X, NOW $Y" or "ORIGINALLY $X" pattern, you MUST NOT invent a higher fake anchor price. The ONLY valid numbers in any price field are:\n  — The actual product.price (${product.price})${product.profile?.maxDiscount ? `\n  — The actual discounted price derived from maxDiscount (${product.profile.maxDiscount})` : ''}${product.profile?.bundleVariants ? `\n  — Actual bundle prices from bundleVariants` : ''}\n\n❌ BANNED EXAMPLES (fabricated — DO NOT output):\n  "WAS $277, NOW $249"     — $277 is invented; product is $249\n  "WAS $499, NOW $249"     — $499 is invented\n  "ORIGINALLY $350, TODAY $249" — $350 is invented\n  "SAVE $78"               — based on an inflated comparison; the real saving from maxDiscount is different\n  "50% OFF — was $498"     — both halves are invented\n\n✅ VALID PATTERNS when reference uses discount framing:\n  "$249 — 10% off with BITCOIN10"         — uses real price + real discount code\n  "$224 with code BITCOIN10"              — real post-discount price (product.price − maxDiscount)\n  "CODE BITCOIN10 SAVES 10%"              — no fake anchor\n  "BUY 3 — SAVE $118"                     — matches bundleVariants exactly\n  "FREE SHIPPING + 2-YR WARRANTY"         — real offer, no fake price\n\nIF the reference ad shows "WAS $X, NOW $Y" and no valid anchor exists in PRODUCT CONTEXT, you MUST rewrite the price section WITHOUT a "was" anchor. Use one of the VALID PATTERNS above, or drop the price element entirely (emit "") and use a benefit claim instead. Fake anchor prices are deceptive pricing under FTC 16 CFR Part 233 and Meta Commerce policy — this is a hard compliance line.`,
    `🚫 NO FABRICATED DISCOUNT PERCENTAGES: The ONLY discount percentage you are allowed to write is the one from maxDiscount (${product.profile?.maxDiscount || 'NOT SET'}). Any other "% OFF" number is fabricated, even if the reference template shouts a big number.\n\n❌ BANNED (all fabricated unless the EXACT number matches maxDiscount):\n  "UP TO 58% OFF"       — not in product context\n  "46% OFF"             — not in product context\n  "75% OFF EVERYTHING"  — not in product context\n  "40% OFF SITEWIDE"    — not in product context\n  "HUGE 80% OFF SALE"   — not in product context\n\n✅ VALID (only if it matches maxDiscount verbatim):\n  "10% OFF"             — matches maxDiscount\n  "10% OFF WITH CODE ${product.profile?.discountCodes || 'XXX'}"\n  "SAVE 10% TODAY"\n\nIF the reference ad screams "50% OFF" or similar, you MUST replace it with the real percentage ("${product.profile?.maxDiscount || '10% OFF'}"), OR drop the percentage entirely and use an alternative framing: "FLASH SALE" / "LIMITED TIME OFFER" / "ACT NOW" / the real bundle savings from bundleVariants. Inventing a bigger discount is deceptive advertising — an easy FTC and Meta Ads policy violation.`,
    `🚫 NO FABRICATED GUARANTEE / WARRANTY PERIODS: The ONLY guarantee period allowed is what's in PRODUCT CONTEXT (${product.profile?.guarantee || 'not specified'}). Any other "N-day / N-year / LIFETIME" claim is fabricated.\n\n❌ BANNED (unless the EXACT period matches guarantee above):\n  "LIFETIME WARRANTY"      — fabricated (lifetime ≠ 2-year)\n  "90-DAY MONEY BACK"      — fabricated if real is 30-day\n  "1-YEAR WARRANTY"        — fabricated if real is 2-year\n  "5-YEAR COVERAGE"        — fabricated\n  "UNLIMITED GUARANTEE"    — fabricated\n\n✅ VALID (must match guarantee string verbatim):\n  "30-DAY MONEY BACK"      — matches guarantee\n  "2-YEAR WARRANTY"        — matches offerDetails (if 2-year)\n  "30-DAY RETURNS"         — equivalent rewording of the real 30-day guarantee\n\nIF the reference ad shows "LIFETIME WARRANTY" or any non-matching period, you MUST replace it with the real guarantee ("${product.profile?.guarantee || product.profile?.offerDetails || 'the real guarantee'}") verbatim. "LIFETIME" is an especially common fabrication — it is NEVER valid unless the product literally has a lifetime warranty. Mis-stating warranty length is deceptive advertising.`,
  ].filter(Boolean).map(l => `⚠️ ${l}`).join('\n');

  // ── PRODUCT CONTEXT (background intelligence for writing better copy) ──
  const contextLines = [
    `Product Name: ${product.name}`,
    profile.shortName && `Short Name: ${profile.shortName}`,
    `Description: ${product.description || 'N/A'}`,
    `Price: ${product.price || 'N/A'}`,
    profile.tagline && `Tagline: ${profile.tagline}`,
    profile.oneliner && `One-liner: ${profile.oneliner}`,
    profile.category && `Product Category: ${profile.category}`,
    profile.productType && `Product Type: ${profile.productType}`,
    profile.unitDetails && `Unit Details: ${profile.unitDetails}`,
    profile.targetDemographics && `Target Demographics: ${profile.targetDemographics}`,
    profile.customerAvatar && `Target Customer Avatar: ${profile.customerAvatar}`,
    profile.customerFrustration && `Customer Frustration: ${profile.customerFrustration}`,
    profile.customerDream && `Customer Dream Outcome: ${profile.customerDream}`,
    profile.bigPromise && `Big Promise: ${profile.bigPromise}`,
    profile.mechanism && `How It Works: ${profile.mechanism}`,
    Array.isArray(profile.benefits) && profile.benefits.length > 0
      && `Key Benefits: ${profile.benefits.map(b => typeof b === 'object' ? (b.text || b.name || b) : b).join(', ')}`,
    profile.differentiator && `Differentiator: ${profile.differentiator}`,
    profile.voice && `Brand Voice/Tone: ${profile.voice}`,
    profile.painPoints && `Pain Points: ${profile.painPoints}`,
    profile.commonObjections && `Common Objections & How to Handle: ${profile.commonObjections}`,
    profile.winningAngles && `Winning Ad Angles: ${profile.winningAngles}`,
    profile.customAngles && `Custom Angles to Test: ${profile.customAngles}`,
    profile.competitiveEdge && `Competitive Edge: ${profile.competitiveEdge}`,
    profile.productUrl && `Product URL: ${profile.productUrl}`,
    Array.isArray(profile.offers) && profile.offers.length > 0
      && `Structured Offers: ${JSON.stringify(profile.offers)}`,
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
  const formulaSection = co.formulaPreservation || `COPY GENERATION RULES:
You are writing FRESH copy from the PRODUCT CONTEXT. The reference ad is ONLY a visual template — ignore its words entirely.

USE PRODUCT DATA AS YOUR SOURCE:
- Read every field in PRODUCT CONTEXT carefully — mechanism, benefits, big promise, customer frustration, dream outcome, pain points, competitive edge
- These are your GROUND TRUTH. Write copy from this data only.
- ALWAYS rewrite technical specs as customer-facing benefits: "attempts a block 144 times daily" → "144 daily chances to win $300K+"
- NEVER invent claims that aren't in the product context
- NEVER synthesize quantity claims by counting offer items (e.g. seeing "free shipping" + "warranty" + "odds boost" does NOT mean "3 FREE GIFTS" — list them individually instead)

🔴🔴 ELEMENT COUNT — ARRAY LENGTH IS CRITICAL 🔴🔴
Your adapted_text must have EXACTLY the same number of entries as original_text at every key AND every array index. Missing entries leak the reference text into the final image — this is a CRITICAL BUG.

RULES:
- adapted_text.badges.length MUST equal original_text.badges.length
- adapted_text.bullets.length MUST equal original_text.bullets.length
- adapted_text.stats.length MUST equal original_text.stats.length
- adapted_text.other_text.length MUST equal original_text.other_text.length
- Same for comparison_labels, ingredient_labels, timeline_labels

If you want to REMOVE an element entirely (e.g. a competitor coin name, a stray price, a useless UI label), supply an EMPTY STRING "" at that index — NEVER omit the entry or shorten the array.

EXAMPLE — DO THIS:
  original_text.other_text: ["Bitcoin", "Ethereum", "Tether", "€39,740.00", "€1,448.00"]
  adapted_text.other_text:  ["Selling Fast", "While Supplies Last", "", "", ""]  ✅ 5 entries matching

EXAMPLE — NEVER DO THIS:
  original_text.other_text: ["Bitcoin", "Ethereum", "Tether", "€39,740.00", "€1,448.00"]
  adapted_text.other_text:  ["Selling Fast", "While Supplies Last"]  ❌ WRONG — 3 reference strings will leak

Generic labels like "SPECIAL DEAL", "FREE SHIPPING" can stay as-is.
Discount codes MUST use the product's actual code from PRODUCT CONTEXT.`;

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
${templateData.deep_analysis.summary ? `\nTemplate Summary: ${templateData.deep_analysis.summary}\n` : ''}
Template Type: ${templateData.deep_analysis.template_type || 'unknown'}
Emotional Tone: ${templateData.deep_analysis.emotional_tone || 'unknown'}
Layout: ${JSON.stringify(templateData.deep_analysis.layout || {}, null, 2)}
Typography: ${JSON.stringify(templateData.deep_analysis.typography || {}, null, 2)}
Product Analysis: ${JSON.stringify(templateData.deep_analysis.product_analysis || {}, null, 2)}
Color Palette: ${JSON.stringify(templateData.deep_analysis.color_palette || {}, null, 2)}
Design Elements: ${JSON.stringify(templateData.deep_analysis.design_elements || {}, null, 2)}
Adaptation Instructions: ${JSON.stringify(templateData.deep_analysis.adaptation_instructions || {}, null, 2)}

IMPORTANT: Follow the adaptation_instructions closely. Pay special attention to:
- critical_elements_to_preserve: These MUST remain unchanged
- common_failure_modes: Actively AVOID these issues
- product_replacement_notes: Follow these for product placement
- text_replacement_strategy: Use "${templateData.deep_analysis.adaptation_instructions?.text_replacement_strategy || 'direct-swap'}" approach
` : '';

  return `You are a $50K/month media buyer who writes ad copy that actually converts cold traffic. You've spent millions on Facebook ads. You know exactly what makes someone stop scrolling and click.

You are analyzing a reference ad image. You will extract its text layout, then write COMPLETELY NEW copy for a different product that fits the same visual slots.

YOUR JOB:
1. Extract every text element visible in the image — miss NOTHING. Note each element's ROLE (headline, subheadline, bullet, badge, stat, CTA, etc.) and CHARACTER COUNT.
2. Count people and product shots
3. Write BRAND NEW copy for the product below that fits the same SLOTS (same number of elements, similar character counts)
4. Identify visual elements that need to change

⚠️ CRITICAL — DO NOT REPHRASE THE REFERENCE TEXT. WRITE ORIGINAL COPY.
The reference ad is for a DIFFERENT product. Its specific words and phrases are irrelevant. But its STRATEGY and STRUCTURE are valuable. Your job is to deeply understand WHAT the template is doing strategically, then write the best possible copy for YOUR product using that same strategy.

STEP 1 — UNDERSTAND THE TEMPLATE'S STRATEGY:
Before extracting any text, analyze the reference ad and determine:

A) TEMPLATE TYPE — what kind of ad is this?
- BENEFIT SHOWCASE: Lists product benefits/features with icons or bullets (e.g. "✓ No bloating ✓ More energy ✓ Better sleep")
- OFFER/PROMO: Focuses on a deal — discount %, price, coupon code, urgency timer (e.g. "40% OFF — Code: SPRING40 — Ends Tonight")
- CURIOSITY/HOOK: Leads with an intriguing statement or question that makes you want to learn more (e.g. "What your doctor won't tell you about...")
- TESTIMONIAL/QUOTE: Features a customer quote or story as the main element (e.g. "\"I lost 30 lbs in 2 months\" — Sarah M.")
- COMPARISON: Shows this product vs competitor or before/after (e.g. "Brand X: $200/mo. Us: $1/mo.")
- LISTICLE: Numbered list of reasons/facts/steps (e.g. "5 Reasons You Need This")
- SOCIAL PROOF: Centers on reviews, star ratings, press logos, "As Seen In" (e.g. "★★★★★ 2,400+ Reviews")
- URGENCY/SCARCITY: Creates time pressure or limited availability (e.g. "Only 47 left — Sale ends midnight")
- PROBLEM/SOLUTION: States a pain point then presents the product as the fix (e.g. "Tired of X? Meet Y.")
- EDUCATIONAL: Teaches something, breaks down how it works (e.g. "How solo mining actually works")

B) EMOTIONAL TONE — how does it feel?
- Aggressive/Hype, Calm/Professional, Conversational/Friendly, Urgent/Scarce, Curious/Mysterious, Authoritative/Expert, Playful/Fun

C) PERSUASION STRUCTURE — how is the argument built?
- What's the HOOK (first thing that grabs attention)?
- What's the PROOF (why should I believe this)?
- What's the CTA (what should I do next)?

Your new copy must use the SAME template type, emotional tone, and persuasion structure — but with completely original words written for YOUR product.

STEP 2 — EXTRACT TEXT SLOTS:
For each text element visible in the image, note:
- Its ROLE (headline, subheadline, body, CTA, bullet, badge, stat)
- Its approximate CHARACTER COUNT
- Its PURPOSE in the template's strategy (e.g. "this badge creates urgency", "this bullet proves a benefit", "this headline is the curiosity hook")

STEP 3 — WRITE ORIGINAL COPY:
For each text slot, write the best possible copy for YOUR product. You have FULL creative freedom — write whatever will convert best. The only constraints are:
- Stay within ±20% of the original element's character count (critical — an AI image generator renders the text, longer text gets garbled/misspelled)
- SHORT = PERFECT RENDERING. LONG = GARBLED MESS.
- Use the SAME template strategy (if it's a benefit showcase, write benefits; if it's a curiosity hook, write a hook)
- Use the SAME emotional tone
- Use the product name "${product.name}" exactly as written — never abbreviate or rename it
- Every element must be a COMPLETE thought — never a fragment that trails off
- NEVER use AI-sounding phrases: "game-changer", "revolutionary", "cutting-edge", "seamless", "elevate", "unlock", "transform your"

BENEFIT-FOCUSED WRITING:
When the template calls for benefits/features, write CUSTOMER BENEFITS, not specs:
- WRONG: "1 watt power draw" → RIGHT: "Only $1/month to run"
- WRONG: "144 attempts daily" → RIGHT: "144 daily chances at $300K"
- WRONG: "Solo mining technology" → RIGHT: "Keep 100% — no pool fees"
RULE: For EVERY text element, ask: "Would someone scrolling Facebook at 11pm care?" If no, rewrite as a benefit.

SPECIFICITY RULE:
- "Save money" is garbage. "$1/month to run" is good.
- Every claim needs a number, a timeframe, or a concrete outcome.

CREATIVE FREEDOM:
You are a $50K/month media buyer. You know what converts. If you think a different hook, angle, or phrasing would perform better for this product — USE IT. The template tells you the STRUCTURE and STRATEGY. The actual words are 100% yours. Write copy that would make YOU click.

PRODUCT CONTEXT:
${contextLines}${brandSection}${productIdentity}${pricingRules}
${mandatoryRules ? `
---

🔴 MANDATORY PRODUCT RULES (THESE OVERRIDE THE REFERENCE — NEVER INVENT YOUR OWN):
${mandatoryRules}

ANY price, discount code, discount percentage, bundle pricing, or offer in your adapted text MUST come from the rules above. If the reference ad shows "$29.99" but our price is "$59.99", you write "$59.99". If the reference says "Use code SPRING10" but our code is "MINER10", you write "MINER10". NEVER invent prices or codes. If the reference has pricing/offers but no matching data exists above, keep the reference structure but use the EXACT numbers from above.
` : ''}
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
- Multi-line headlines kept as one string with natural line breaks
- Note the CHARACTER COUNT of each extracted element — your new copy must match these lengths

WRITING NEW COPY (adapted_text):
- Write 100% fresh copy from PRODUCT CONTEXT for every text slot
- ALL text MUST be in ENGLISH regardless of the reference language
- Replace competitor brand names with "${product.name}" — never abbreviate it
- Generic labels ("SPECIAL DEAL", "FREE SHIPPING") can stay as-is
- Discount codes MUST use the actual code from PRODUCT CONTEXT
- Prices MUST use the real product price from PRODUCT CONTEXT
- Seasonal/date text ("March Sale", "April Promo", ANY month name, ANY season) → ALWAYS replace with generic urgency ("Flash Sale", "Limited Time", "Today Only"). NEVER carry a month name into adapted_text — not even the current month.
- Timeline labels → use realistic timeframes for THIS product

---${headlineRules}${headlineExamples}${bannedPhrases}

---

${formulaSection}

---

COPY QUALITY SELF-CHECK (run this mentally before returning):
1. MAKES SENSE CHECK: Read each adapted text out loud. Does it make logical sense for THIS PRODUCT? "Real Bitcoin shots w/o the crash" = NONSENSE for a mining device. "Mine Bitcoin from home for $1/day" = MAKES SENSE. If any text sounds weird or forced, you wrote it by adapting the reference instead of writing fresh — DELETE IT and write new copy from product context.
2. SPECIFICITY CHECK: Is every claim SPECIFIC? "Save money" is garbage. "$1/month to run" is good. Every claim needs a number, timeframe, or concrete outcome.
3. SCROLL-STOP CHECK: Would this make someone STOP SCROLLING on Facebook at 11pm? If not → more emotional, more specific, more urgent.
4. AI LANGUAGE CHECK: Does it use any corporate/AI words? ("Elevate", "Transform", "Revolutionize", "Seamless", "Game-changer") → REMOVE and rewrite in plain language.
5. ENERGY CHECK: Does the energy match the reference? Aggressive original = aggressive new copy. Calm original = calm new copy.
6. ELEMENT COUNT CHECK: Same number of headlines, bullets, badges, stats as original. Don't add or remove.
7. ⚠️ REFERENCE CONTAMINATION CHECK (MOST CRITICAL): Re-read EVERY adapted text. Does ANY word, phrase, or sentence STRUCTURE come from the reference ad? You should have written 100% fresh copy. If you see anything that looks like a modified version of the reference text, you FAILED. Delete it and write new copy from PRODUCT CONTEXT. Common failure: keeping the reference's sentence structure and just swapping nouns. "Real [X] shots w/o the [Y]" is a COPIED STRUCTURE even if the nouns changed.
8. SPELLING & GRAMMAR CHECK: Every word must be spelled correctly. ALL text MUST be in ENGLISH.
9. BENEFIT CHECK: Does every bullet/stat state a benefit, not a spec? "144 attempts daily" = SPEC → "144 daily chances at $300K" = BENEFIT.
10. ⚠️ CHARACTER COUNT CHECK: For EVERY element, count chars and compare to original slot size. Stay within ±20%. Short text renders perfectly; long text gets garbled. When in doubt, SHORTER.
11. COMPLETE THOUGHT CHECK: Does every text end as a complete thought? "Crypto feels too" = INCOMPLETE → "No middleman fees" = COMPLETE.
12. PRODUCT NAME CHECK: Does "${product.name}" appear correctly? Zero competitor names in output.
13. ⚠️ FABRICATED CLAIMS CHECK: Did you invent ANY quantity claim like "X FREE GIFTS", "X FREE BONUSES", "X ITEMS FREE"? If so, DELETE IT. You may only use such claims if the EXACT phrase appears in the product context. Individual offer features (shipping, warranty, etc.) are NOT "gifts" to be counted up.
14. ⚠️⚠️ OFFER STRUCTURE CHECK (MOST CRITICAL FOR COMPLIANCE): Scan every adapted string for offer constructions: "Buy X Get Y Free", "BOGO", "N-for-M" (e.g. "3 for 2"), "Free [item] with purchase", "Get N free". If ANY of these appear, verify the EXACT structure is listed verbatim in bundleVariants / offerDetails / discountCodes. If it is NOT, you MUST replace it with the real bundle/offer from PRODUCT CONTEXT (bundle pricing, real discount code, real free-shipping/warranty claim) OR blank the slot with "". Bundle SAVINGS never translate to "get free" language — "3-pack saves $118" is NEVER "Buy 3 Get 2 Free". Fabricating offers is false advertising and a hard Meta/FTC violation.

---

BRAND VOICE ENFORCEMENT:
${profile.voice ? `Your adapted copy MUST be written in this exact voice and tone: "${profile.voice}". This overrides the reference ad's tone. If the reference is formal but the brand voice says "conversational like a text message", write conversationally. The brand voice is LAW — match it exactly.` : 'Match the reference ad\'s tone and communication style.'}

TARGET AUDIENCE ENFORCEMENT:
${profile.customerAvatar ? `Every headline, bullet, and body text must speak DIRECTLY to this person: "${profile.customerAvatar}". Use language, references, and emotional triggers that resonate with THIS specific audience. If the reference targets "young women" but your target is "${profile.customerAvatar}", adapt the messaging style accordingly.` : ''}
${profile.targetDemographics ? `Demographics: ${profile.targetDemographics}` : ''}
${profile.customerFrustration ? `Their #1 frustration: "${profile.customerFrustration}" — your copy should address this pain.` : ''}
${profile.customerDream ? `Their dream outcome: "${profile.customerDream}" — your copy should paint this picture.` : ''}

---

VISUAL ANALYSIS:
For each visual element, note:
- What it shows in original (e.g. "3 belly transformation photos in grid")
- The CONCEPT/NARRATIVE behind it (e.g. "progressive improvement over time", "side-by-side comparison showing superiority", "ingredient callouts with arrows")
- What it SHOULD show for new product — adapt the CONCEPT, not just the literal image. Example: eggplants getting bigger = "progressive body improvement" → for an estrogen blocker, show chest fat reducing over time. The visual metaphor must match the NEW product's story.
- Where in layout
- Generic (keep) or angle-specific (must change)

SPECIAL AD PATTERNS — detect and handle these:
1. COMPARISON ADS (multi-column): If the reference shows 2-3 products side by side with stats/specs in columns, extract ALL comparison data. In adapted_text, replace with product-relevant comparison categories (e.g. protein stats → ingredient quality comparisons). Use "stats" and "comparison_labels" arrays.
2. PROGRESSION/TIMELINE ADS: If the reference shows before/after progression with timeline markers, adapt BOTH the visual metaphor AND the timeline units to match the new product. Put timeline labels in "stats" array.
3. INGREDIENT CALLOUT ADS: If the reference shows ingredient names with arrows pointing to a product, extract ALL ingredient names. Replace with the new product's REAL ingredients from PRODUCT CONTEXT. Put them in "bullets" array.
4. FEATURE BUBBLE ADS: If the reference has feature callout bubbles/icons around a product, extract the feature text AND describe each icon. Adapt both text and icon descriptions for the new product. Put them in "badges" array.

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

When in doubt, set to FALSE. Only set TRUE if you see an ACTUAL VISUAL LOGO GRAPHIC (icon, emblem, wordmark with custom styling). Brand names that appear as regular text in headlines/body do NOT count as logos — those are handled by text swaps. Setting TRUE incorrectly causes our logo to be injected where it shouldn't be.

IMPORTANT: If you detect a logo, you MUST also include it in visual_adaptations with position describing where the logo sits and adapted_visual set to "replace with provided brand logo".

LOGO BACKGROUND TONE (logo_background_tone):
Look at the area of the ad where the competitor logo sits (or where a logo would naturally go — typically top corner or bottom).
- Set to "dark" if that area has a dark/black background (our WHITE logo should be used)
- Set to "light" if that area has a light/white background (our BLACK logo should be used)
- Set to "mixed" if unclear or gradient (default to our dark logo)

---

Return ONLY valid JSON (no markdown, no code fences):
{
  "template_strategy": {
    "type": "benefit_showcase|offer_promo|curiosity_hook|testimonial|comparison|listicle|social_proof|urgency_scarcity|problem_solution|educational",
    "tone": "aggressive|calm|conversational|urgent|curious|authoritative|playful",
    "hook": "one sentence describing what grabs attention first",
    "proof": "one sentence describing how the ad builds credibility",
    "cta_approach": "one sentence describing the call to action style"
  },
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
      "visual_concept": "the narrative purpose (e.g. 'progressive improvement', 'ingredient breakdown', 'before/after comparison')",
      "adapted_visual": "what it should show for this product — adapt the CONCEPT to match the new product's story",
      "position": "where in the layout",
      "is_angle_specific": true
    }
  ]
}`;
}

// ─────────────────────────────────────────────────────────────────────────────
// STEP 2: Build swap pairs from Claude's original vs adapted text
// ─────────────────────────────────────────────────────────────────────────────

export function buildSwapPairs(originalText, adaptedText, productName = '') {
  const pairs = [];

  // Coerce Claude output to a string. Haiku sometimes returns objects like
  // { text: "..." } or numbers — .trim() on those crashes. Accept strings,
  // { text }, { value }, numbers, and booleans; skip anything else.
  const toStr = (v) => {
    if (v == null) return '';
    if (typeof v === 'string') return v;
    if (typeof v === 'number' || typeof v === 'boolean') return String(v);
    if (typeof v === 'object') {
      if (typeof v.text === 'string') return v.text;
      if (typeof v.value === 'string') return v.value;
      if (typeof v.label === 'string') return v.label;
    }
    return '';
  };

  // Track leakage telemetry: when the reference has text but Claude's
  // adapted_text is empty or identical to the original, we emit NO swap pair
  // — which means Gemini silently carries the REFERENCE text (e.g. competitor
  // brand names, reference offers) into the generated image. That's the
  // "Hyro"-in-MineBlock-ad class of bug.
  const leakedFields = [];

  // Standard text fields. Scalar-field empty-adapted is also a remove signal.
  for (const field of ['headline', 'subheadline', 'body', 'cta', 'disclaimer']) {
    const orig = toStr(originalText[field]).trim();
    const adapted = toStr(adaptedText[field]).trim();
    if (orig && adapted && orig !== adapted) {
      pairs.push({ original: orig, adapted, field });
    } else if (orig && !adapted) {
      pairs.push({ original: orig, adapted: '', field, remove: true });
      leakedFields.push({ field, original: orig, reason: 'adapted_empty' });
    } else if (orig && adapted && orig.toLowerCase() === adapted.toLowerCase()) {
      leakedFields.push({ field, original: orig, reason: 'adapted_equals_original' });
    }
  }

  // Array fields. When Claude supplies a SHORTER adapted array than original,
  // the trailing entries are implicit removals — we emit explicit REMOVE swaps
  // (adapted: '') so the Gemini prompt can tell the image model to delete them.
  // Without this, trailing reference text (competitor coin names, euro prices,
  // etc.) leaks straight through to the final image — the "Hyro" bug class.
  for (const field of ['badges', 'bullets', 'stats', 'other_text', 'comparison_labels', 'ingredient_labels', 'timeline_labels']) {
    const rawOrig = Array.isArray(originalText[field]) ? originalText[field] : [];
    const rawAdapted = Array.isArray(adaptedText[field]) ? adaptedText[field] : [];
    const origArr = rawOrig.map(toStr);
    const adaptedArr = rawAdapted.map(toStr);
    for (let i = 0; i < origArr.length; i++) {
      const o = (origArr[i] || '').trim();
      const a = (adaptedArr[i] || '').trim();
      if (o && a && o !== a) {
        pairs.push({ original: o, adapted: a, field: `${field}[${i}]` });
      } else if (o && !a) {
        // Claude either returned "" at this index (explicit remove) OR the
        // array was shorter than original (implicit remove). Either way, emit
        // a REMOVE swap so the downstream prompt instructs Gemini to delete it.
        pairs.push({ original: o, adapted: '', field: `${field}[${i}]`, remove: true });
        leakedFields.push({ field: `${field}[${i}]`, original: o, reason: i >= adaptedArr.length ? 'array_shorter_than_original' : 'adapted_empty' });
      } else if (o && a && o.toLowerCase() === a.toLowerCase()) {
        leakedFields.push({ field: `${field}[${i}]`, original: o, reason: 'adapted_equals_original' });
      }
    }
  }

  if (leakedFields.length > 0) {
    console.warn(`[buildSwapPairs] ⚠️ REFERENCE LEAKAGE RISK: ${leakedFields.length} field(s) have no valid adapted_text — Gemini will carry the reference text through to the final image:`);
    for (const lf of leakedFields) {
      console.warn(`[buildSwapPairs]   • [${lf.field}] reason=${lf.reason} original="${lf.original.slice(0, 80)}"`);
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
  // NanoBanana drops leading words and $-signs on small slots when text
  // overflows the original visual space. Keep adapted text close to reference
  // length so the model never feels squeezed into truncating. Tolerance is
  // field-aware:
  //   badges / cta                : 1.3x, floor 18 — labels are dense, short matters most
  //   headline / subheadline      : 1.5x, floor 38 — hooks need some room
  //   bullets / stats / short lbls: 1.5x, floor 28 — bullet labels render small,
  //                                   NanoBanana drops leading words/"$" when
  //                                   significantly longer than the reference
  //   body / other_text / discl.  : 2.2x, floor 55 — longer text areas are
  //                                   more forgiving in NanoBanana's rendering
  // EXCEPTION: swaps containing the product name are sacred (brand replacement)
  const fieldToleranceRule = (fieldName) => {
    // fieldName can be e.g. 'bullets[3]', 'headline', 'badges[0]'
    const base = (fieldName || '').split('[')[0];
    if (base === 'badges' || base === 'cta' || base === 'comparison_labels' || base === 'timeline_labels' || base === 'ingredient_labels') {
      return { tol: 1.3, floor: 18 };
    }
    if (base === 'headline' || base === 'subheadline') {
      return { tol: 1.5, floor: 38 };
    }
    if (base === 'bullets' || base === 'stats') {
      return { tol: 1.5, floor: 28 };
    }
    // body, other_text, disclaimer, and any unknown field
    return { tol: 2.2, floor: 55 };
  };
  for (const pair of pairs) {
    const origLen = pair.original.length;
    const adaptedLen = pair.adapted.length;
    const rule = fieldToleranceRule(pair.field);
    const maxLen = Math.max(origLen * rule.tol, rule.floor);

    // Skip truncation if the adapted text contains the product name — brand replacement is sacred
    const containsProductName = productName && pair.adapted.toLowerCase().includes(productName.toLowerCase());
    if (containsProductName && adaptedLen > maxLen) {
      console.log(`[buildSwapPairs] ℹ️ Skipping truncation for brand swap [${pair.field}]: "${pair.adapted}" (contains product name "${productName}")`);
      continue;
    }

    if (adaptedLen > maxLen && origLen > 2) {
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

  // Calculate correct logo image indices based on how many extra product images precede them
  // Image order: [0] main product, [1..N] extra products, [N+1..M] logos, [LAST] reference
  const extraProductCount = (claudeResult._extraProductCount || 0);
  const logoStartIdx = 1 + extraProductCount; // 0-indexed: main product is 0
  const logoImageRef = logoCount > 1
    ? `images ${logoStartIdx + 1}-${logoStartIdx + logoCount}` // +1 for human-readable 1-indexed
    : `image ${logoStartIdx + 1}`;
  // Logo instruction now built inline in the final prompt below

  // Only include the MUST CHANGE visual adaptations (skip keep-as-is ones)
  // Truncate descriptions to keep prompt under 3000 chars total
  const mustChangeVisuals = (visual_adaptations || []).filter(v => v.is_angle_specific);
  const visualLine = mustChangeVisuals.length > 0
    ? `\nVisual changes: ${mustChangeVisuals.slice(0, 3).map(v => {
        const orig = (v.original_visual || '').slice(0, 40);
        const adapted = (v.adapted_visual || '').slice(0, 50);
        return `${v.position}: "${orig}" → "${adapted}"`;
      }).join('; ')}`
    : '';

  // Prioritize swap pairs — NanoBanana handles fewer swaps more accurately
  // Priority: headline > subheadline > brand/other_text > badges > bullets > stats > body > disclaimer
  const FIELD_PRIORITY = { headline: 1, subheadline: 2, cta: 3, stats: 3 };
  const getFieldPriority = (field) => {
    if (FIELD_PRIORITY[field]) return FIELD_PRIORITY[field];
    if (field?.startsWith('other_text')) return 4; // brand names etc
    if (field?.startsWith('badges')) return 5;
    if (field?.startsWith('bullets')) return 6;
    if (field?.startsWith('stats')) return 3; // price/stat corrections are critical
    if (field === 'body') return 7;
    return 8;
  };

  // Filter out near-identical swaps — if original ≈ adapted, let NanoBanana keep the original
  // This reduces noise and lets the model focus on real changes
  const MONTH_NAMES = /\b(january|february|march|april|may|june|july|august|september|october|november|december)\b/i;
  const meaningfulPairs = swapPairs.filter(pair => {
    const o = (pair.original || '').toLowerCase().replace(/[^a-z0-9]/g, '');
    const a = (pair.adapted || '').toLowerCase().replace(/[^a-z0-9]/g, '');
    if (o === a) return false; // identical after normalizing
    // Never filter swaps containing numbers/currency — these are critical price/stat corrections
    const hasNumbers = /[\d$€£%]/.test(pair.original) || /[\d$€£%]/.test(pair.adapted);
    if (hasNumbers) return true; // always keep price/stat swaps
    // Never filter swaps where original contains a month name — seasonal text MUST be replaced
    if (MONTH_NAMES.test(pair.original)) return true;
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

  // Split REMOVE pairs from REPLACEMENT pairs. REMOVEs are cheap (one-line
  // delete instructions) — they shouldn't compete with replacements for the
  // swap-slot budget. We cap replacements at MAX_SWAP_PAIRS and render every
  // REMOVE separately as a compact delete list, so even 15+ reference-text
  // carryovers get cleaned up.
  const removePairs     = meaningfulPairs.filter(p => p.remove || (p.adapted === '' && p.original));
  const replacementPairs = meaningfulPairs.filter(p => !(p.remove || (p.adapted === '' && p.original)));

  const isComplexLayout = replacementPairs.length > 7;
  const MAX_SWAP_PAIRS = isComplexLayout ? 12 : 7; // complex = keep more, simple = keep tight
  const sortedPairs = [...replacementPairs].sort((a, b) => getFieldPriority(a.field) - getFieldPriority(b.field));
  const limitedReplacements = sortedPairs.slice(0, MAX_SWAP_PAIRS);
  // Always keep ALL removes, capped generously to avoid prompt blowup
  const limitedPairs = [...limitedReplacements, ...removePairs.slice(0, 25)];
  if (removePairs.length > 0) {
    console.log(`[buildNanoBananaPrompt] ${removePairs.length} REMOVE pair(s) — reference text to delete: ${removePairs.slice(0, 10).map(p => `"${p.original}"`).join(', ')}${removePairs.length > 10 ? '…' : ''}`);
  }
  if (sortedPairs.length > MAX_SWAP_PAIRS) {
    console.log(`[buildNanoBananaPrompt] ⚠️ Limited swap pairs from ${sortedPairs.length} to ${MAX_SWAP_PAIRS} (dropped low-priority pairs)`);
  }
  if (isComplexLayout) {
    console.log(`[buildNanoBananaPrompt] Complex layout detected (${meaningfulPairs.length} swaps) — using extended limit of ${MAX_SWAP_PAIRS}`);
  }

  // Length enforcement happens ONCE in buildSwapPairs (source of truth).
  // We intentionally do NOT re-truncate here — double truncation with a tighter
  // (origLen+5) cap was causing mid-word cuts ("younaking" instead of "making"
  // real mining") that Gemini then rendered as merged/misspelled glyphs.
  // REMOVE pairs (adapted is empty / pair.remove flagged) render as explicit
  // delete instructions so Gemini erases the element entirely instead of
  // carrying the reference text through to the final image.
  const swapSectionFinal = limitedPairs.map((pair, i) => {
    if (pair.remove || (pair.adapted === '' && pair.original)) {
      return `  ${i + 1}. "${pair.original}" → [REMOVE — delete this text element entirely, leave the space blank]`;
    }
    return `  ${i + 1}. "${pair.original}" → "${pair.adapted}"`;
  }).join('\n');

  // Banned text — reference product category and keywords
  const refCategory = claudeResult.reference_product_category || '';
  const refKeywords = claudeResult.reference_product_keywords || [];

  // Determine if the reference ad contains a product image or is text-only
  const hasProductInReference = (product_count ?? 1) > 0;
  // Check if product images were actually sent (staticsGeneration sets this)
  const productImagesSent = claudeResult._refHasProduct !== false;

  // ── Build concise prompt — under 500 words for best Gemini compliance ──
  // Order: most-violated rules FIRST, data second, minor rules last

  const productRule = (hasProductInReference && productImagesSent)
    ? `Copy the EXACT product from FIRST image — same shape, colors, screen, details. Do NOT generate your own version.`
    : `This is a TEXT-ONLY ad. Do NOT add any product photo, device image, or physical object. The output must contain ONLY text and profile elements — ZERO product images.`;

  const logoRule = logoCount > 0
    ? `\n🔴 LOGO: Copy the EXACT logo from ${logoImageRef} pixel-perfectly — same text, shapes, proportions. Do NOT redesign it.${logoBackgroundTone === 'dark' ? ' Use WHITE version (dark bg).' : logoBackgroundTone === 'light' ? ' Use BLACK version (light bg).' : ''}`
    : '';

  // Banned words — keep very short
  const bannedWords = refKeywords.length > 0
    ? `\nBANNED WORDS (from reference product): ${refKeywords.map(w => `"${w}"`).join(', ')}. NEVER use these.`
    : (refCategory ? `\nBANNED: Any text about "${refCategory}" from the reference.` : '');

  // ── FULL PRODUCT CONTEXT for image generator ──
  // All product library data so Gemini knows the product, offers, audience, and voice
  const profile = product.profile || {};
  const productContextLines = [
    // Identity
    product.name && `Product: ${product.name}`,
    product.description && `What it is: ${product.description.slice(0, 150)}`,
    profile.oneliner && `One-liner: ${profile.oneliner.slice(0, 100)}`,
    profile.productType && `Type: ${profile.productType}`,
    // Pricing & Offers
    product.price && `Base price: ${product.price}`,
    profile.bundleVariants && `Bundle deals:\n${profile.bundleVariants}`,
    profile.discountCodes && `Discount code: ${profile.discountCodes}`,
    profile.maxDiscount && `Max discount: ${profile.maxDiscount}`,
    profile.offerDetails && `Offer rules: ${profile.offerDetails.slice(0, 150)}`,
    profile.guarantee && `Guarantee: ${profile.guarantee.slice(0, 100)}`,
    // Audience & Voice
    profile.customerAvatar && `Target customer: ${profile.customerAvatar.slice(0, 120)}`,
    profile.targetDemographics && `Demographics: ${profile.targetDemographics.slice(0, 100)}`,
    profile.voice && `Brand voice: ${profile.voice.slice(0, 120)}`,
    // Product Intelligence
    profile.bigPromise && `Big promise: ${profile.bigPromise.slice(0, 120)}`,
    profile.mechanism && `How it works: ${profile.mechanism.slice(0, 120)}`,
    profile.differentiator && `Differentiator: ${profile.differentiator.slice(0, 100)}`,
    profile.competitiveEdge && `Competitive edge: ${profile.competitiveEdge.slice(0, 100)}`,
    Array.isArray(profile.benefits) && profile.benefits.length > 0
      && `Key benefits: ${profile.benefits.map(b => typeof b === 'object' ? (b.text || b.name || b) : b).slice(0, 5).join(', ')}`,
    // Pain Points & Objections
    profile.painPoints && `Customer pain: ${profile.painPoints.slice(0, 100)}`,
    profile.customerFrustration && `Frustration: ${profile.customerFrustration.slice(0, 100)}`,
    profile.customerDream && `Dream outcome: ${profile.customerDream.slice(0, 100)}`,
    profile.commonObjections && `Objections: ${profile.commonObjections.slice(0, 120)}`,
    // Compliance
    profile.complianceRestrictions && `🚫 NEVER claim: ${profile.complianceRestrictions.slice(0, 100)}`,
    profile.notes && `Notes: ${profile.notes.slice(0, 120)}`,
  ].filter(Boolean);
  const productContext = productContextLines.length > 0
    ? `\n\nPRODUCT INTELLIGENCE (use this data for ANY text you generate — NEVER invent facts):\n${productContextLines.map(l => `- ${l}`).join('\n')}`
    : '';

  // Brand colors for visual consistency
  const brandColorHint = (product.brand_colors && Object.keys(product.brand_colors).length > 0)
    ? `\n- Brand colors: ${Object.values(product.brand_colors).filter(Boolean).slice(0, 3).join(', ')} — use these for accent elements.`
    : '';

  // ── P1.1: If skipTextRendering=true, instruct the model to produce a
  // TEXT-FREE image (no headlines, body copy, badges, CTAs, prices). The
  // overlayText() function in server/src/utils/textOverlay.js will composite
  // real fonts + exact copy on top, eliminating all Gemini text-rendering
  // defects (misspellings, dupes, fabricated prices, letter swaps).
  // We still tell the model WHERE the text regions should go so layout and
  // visual hierarchy are preserved — it just fills those regions with solid
  // color blocks / placeholders instead of rendered glyphs.
  if (skipTextRendering) {
    return `Edit the reference ad (LAST image) into a TEXT-FREE version.${templateIntelligence}

🔴 STRICT RULES (most important):
1. NO TEXT AT ALL. The output image must contain ZERO rendered text — no headlines, no subheadlines, no body copy, no prices, no codes, no CTAs, no badges, no fine print, no logos-with-text. The text will be composited afterwards by our system. Preserve the layout structure but leave text regions as either:
   - Empty solid-color blocks matching the ad's background tone, OR
   - Gently blurred/desaturated space where text would go
2. LOGO: If the reference has a brand logo mark (pictogram, shield, icon), replace it with the ${product.profile?.shortName || product.name || 'brand'} logo pictogram. If the "logo" is purely wordmark text, leave that region blank — we'll overlay it.
3. PRODUCT: ${productRule}${hasProductInReference ? ` Orientation: ${claudeResult.product_orientation || 'front-facing'}.${productRulesSection}` : ''}
4. ${characterRules}
5. Keep EXACT same layout, background, colors, overall composition, and visual elements as the reference. ONLY change: (a) the product to ours, (b) remove all rendered text.
6. PRODUCT LABEL: The product image (FIRST image) already has its real label/packaging. Copy it EXACTLY as provided — do NOT modify, redesign, or add text to the product packaging.${brandColorHint}${productContext}${co.absoluteRules ? `\n${co.absoluteRules}` : ''}

THIS IS CRITICAL: zero rendered text. If in doubt whether something is text, DON'T render it. Our overlay system will add every piece of copy afterwards with pixel-perfect typography.`;
  }

  return `Edit the reference ad (LAST image).${templateIntelligence}

🔴 STRICT RULES (most important):
1. ELEMENT COUNT: Output must have the EXACT same number of text elements, logos, badges, and images as the reference. Do NOT add or remove any.${logoRule}
2. PRODUCT: ${productRule}${hasProductInReference ? ` Orientation: ${claudeResult.product_orientation || 'front-facing'}.${productRulesSection}` : ''}
3. ALL text must be in ENGLISH. Replace every piece of reference text with the swaps below.
4. ${characterRules}
5. 🚫 NO MONTH NAMES OR SEASONAL TEXT: NEVER write any month name (January through December) or seasonal sale phrase ("March Sale", "Spring Deal", etc.) anywhere in the output. If a TEXT SWAP below replaces a month-name phrase, use the adapted text EXACTLY. If the reference image shows seasonal text with no swap provided, replace it with "Limited Time Offer".
6. 🚫 NO INVENTED PRICES OR DISCOUNTS: NEVER write a price, percentage off, or discount amount that is not explicitly listed in PRODUCT INTELLIGENCE below. If no price is provided, omit price text entirely.
7. 🔴 CHARACTER-LEVEL FIDELITY (CRITICAL — READ TWICE):
   - Render EVERY character in each swap value. Do NOT drop, skip, or omit any character — including the FIRST word, the LAST word, punctuation, and especially the dollar sign "$".
   - Prices and monetary claims MUST be rendered as the full string. "$300K" must appear as "$", "3", "0", "0", "K" — never as "300K" or "K" alone. "$1" must appear as "$", "1" — never as "1" or dropped. "$59.99" must appear complete.
   - Percentages must include the "%" symbol. "58% OFF" must not become "58 OFF" or "OFF".
   - Leading words matter: if a bullet says "Plug In. Mine in 60 Sec.", the output must START with "Plug". Do NOT drop the first word to fit the space.
   - Trailing words matter: if a bullet ends with "to Run", the output must END with "Run". Do NOT cut off the last word.
   - If a swap's text feels too long for its visual slot, you MUST shrink the font size to fit. NEVER truncate, abbreviate, drop words, drop characters, or substitute "..." for real text.
   - If shrinking makes text unreadable, compress letter-spacing slightly, but every character must be visible and legible.

TEXT SWAPS — replace ALL text with these EXACT words (character-for-character):
${swapSectionFinal || '(No text changes)'}${bannedWords}

LAYOUT RULES:
- Keep EXACT same layout, background, colors, fonts, positions.${visualLine}
- Spell every word correctly with proper spacing between words.
- PRODUCT LABEL: The product image (FIRST image) already has its real label/packaging. Copy it EXACTLY as provided — do NOT modify, redesign, or add text to the product packaging.${brandColorHint}${productContext}${co.absoluteRules ? `\n${co.absoluteRules}` : ''}`;
}

// ─────────────────────────────────────────────────────────────────────────────
// ITERATIONS PIPELINE — prompt builders for iterating on our OWN winning ads
// Different from the adapt flow: input is a proven winner, output is a surgical
// variation that preserves the working elements and tests ONE isolated change.
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Builds the Claude prompt for analyzing a winning ad and producing N surgical
 * variations. Claude must identify load-bearing elements (never touch) vs
 * safe-to-vary elements, then propose N variations that each test exactly ONE
 * change. All other elements are preserved character-identical.
 *
 * @param {object} winner       — the parent ad's metadata: { creative_id, ad_name, spend, roas, cpa, angle, avatar, week }
 * @param {object} product      — full product profile (same shape as adapt flow)
 * @param {number} variations   — how many variations to produce (1..5, default 3)
 */
export function buildIterationPrompt(winner, product, variations = 3) {
  const N = Math.max(1, Math.min(5, Math.floor(variations)));
  const profile = product.profile || {};
  const p = product || {};
  const w = winner || {};

  const productContextLines = [
    p.name && `- Name: ${p.name}`,
    p.price && `- Price: ${p.price}`,
    profile.discountCodes && `- Discount codes: ${profile.discountCodes}`,
    profile.maxDiscount && `- Max discount allowed: ${profile.maxDiscount}`,
    profile.bundleVariants && `- Bundle pricing (exact): ${profile.bundleVariants}`,
    profile.guarantee && `- Guarantee: ${profile.guarantee}`,
    profile.mechanism && `- Mechanism (how it works): ${profile.mechanism}`,
    profile.bigPromise && `- Big promise: ${profile.bigPromise}`,
    profile.differentiator && `- Differentiator: ${profile.differentiator}`,
    profile.winningAngles && `- Winning angles (already validated — safe to echo): ${profile.winningAngles}`,
    profile.customAngles && `- Custom angles to test: ${profile.customAngles}`,
    profile.painPoints && `- Pain points: ${profile.painPoints}`,
    profile.commonObjections && `- Objections + handling: ${profile.commonObjections}`,
    profile.voice && `- Brand voice/tone: ${profile.voice}`,
    profile.complianceRestrictions && `- 🚫 Compliance (NEVER claim): ${profile.complianceRestrictions}`,
  ].filter(Boolean).join('\n');

  const winnerContext = [
    w.creative_id && `- Parent creative_id: ${w.creative_id}`,
    w.ad_name && `- Parent ad name: ${w.ad_name}`,
    (w.spend != null) && `- Spend: $${Number(w.spend).toFixed(2)}`,
    (w.roas != null) && `- ROAS: ${Number(w.roas).toFixed(2)}x`,
    (w.cpa != null) && `- CPA: $${Number(w.cpa).toFixed(2)}`,
    (w.ctr != null) && `- CTR: ${Number(w.ctr).toFixed(2)}%`,
    w.angle && `- Angle: ${w.angle}`,
    w.avatar && `- Avatar: ${w.avatar}`,
    w.week && `- Launch week: ${w.week}`,
  ].filter(Boolean).join('\n');

  return `You are a $50K/month Facebook media buyer iterating on a WINNING static ad.

This ad is working — don't rewrite it. Your job is to identify what makes it convert, then propose ${N} surgical variations that each test EXACTLY ONE change. A 2x+ ROAS ad is sacred — every working element earned its place.

═══════════════════════════════════════════════════════════════
WINNER METADATA
═══════════════════════════════════════════════════════════════
${winnerContext}

═══════════════════════════════════════════════════════════════
PRODUCT CONTEXT (compliance only — do NOT invent new claims)
═══════════════════════════════════════════════════════════════
${productContextLines}

═══════════════════════════════════════════════════════════════
HARD CONSTRAINTS
═══════════════════════════════════════════════════════════════
1. EXACTLY ONE change per variation. No compound changes.
2. Preserved text is CHARACTER-IDENTICAL. Do not rephrase, do not "polish", do not fix typos in the reference (the typos may be part of what converts).
3. NEVER touch product identity, brand name, logo, or core pricing unless the variation category is explicitly "badge-restyle" and the change is price-styling only.
4. The ${N} variations must each test a DIFFERENT element — do NOT produce near-duplicates.
5. Respect PRODUCT CONTEXT compliance rules. No fabricated claims beyond what winningAngles + mechanism support.
6. Every element you list as "load-bearing" in analysis must appear verbatim in the "preserved" list of EVERY variation.
7. Allowed change_category values: "visual-refresh" | "hook-swap" | "angle-variant" | "product-orientation" | "badge-restyle". Pick the BEST ${N} distinct categories.

═══════════════════════════════════════════════════════════════
OUTPUT — return ONE JSON object (no markdown, no code fences)
═══════════════════════════════════════════════════════════════
{
  "analysis": {
    "works_because": "<1 sentence — what makes this ad convert>",
    "load_bearing_elements": [<array — elements that MUST NOT change across variations: the hook, the primary claim, the proof point, the visual anchor. Be specific: "headline text: 'X'", not just "headline">],
    "safe_to_vary": [<array — elements where A/B testing is reasonable: background palette, badge style, product angle, etc.>],
    "extracted_text": {
      "headline": "<exact text or null>",
      "subheadline": "<exact text or null>",
      "badges": [<exact text array>],
      "cta": "<exact text or null>",
      "price": "<exact text or null>",
      "bullets": [<exact text array>]
    },
    "visual_summary": "<1 sentence: scene composition, color palette, overall mood>"
  },
  "variations": [
    {
      "variation_id": 1,
      "change_category": "<one of the 5 allowed values>",
      "change": "<ONE-sentence description of the SINGLE change>",
      "preserved": [<explicit array — every load-bearing element from analysis + anything else kept character-identical; be specific>],
      "modified": {
        "<element_name>": "<exact new content — text or concrete visual instruction>"
      },
      "rationale": "<1 sentence — WHY this change could lift performance>"
    },
    ... (${N} total)
  ]
}

Analyze the LAST image (the reference winning ad). Produce the JSON. Nothing else.`;
}

/**
 * Build the NanoBanana prompt for ONE iteration variation. Output is strictly
 * surgical — Change only what Claude specified, preserve everything else.
 *
 * @param {object} variation  — { change_category, change, preserved, modified, rationale }
 * @param {object} product    — product profile (for brand color hints)
 */
export function buildIterationNanoBananaPrompt(variation, product = {}) {
  const v = variation || {};
  const preservedList = Array.isArray(v.preserved) && v.preserved.length > 0
    ? v.preserved.map(p => `- ${p}`).join('\n')
    : '- all unchanged elements from the reference';
  const modifiedObj = v.modified && typeof v.modified === 'object' ? v.modified : {};
  const modifiedList = Object.keys(modifiedObj).length > 0
    ? Object.entries(modifiedObj).map(([k, val]) => `- Change ${k} to: ${val}`).join('\n')
    : `- ${v.change || '(no specific modifications)'}`;

  // product-orientation is a special case — product can rotate, but identity/packaging stays
  const productRule = v.change_category === 'product-orientation'
    ? 'Product orientation may change per the modified list above — but product identity, packaging, brand mark, and label text remain identical.'
    : 'Product identity, orientation, packaging, brand mark, and label text remain identical to the reference.';

  return `Edit the reference ad (LAST image).

🔴 SURGICAL IMAGE EDIT — CHANGE EXACTLY ONE THING.

CHANGE ONLY THIS (single isolated change):
${v.change || '(see modified list below)'}

Specific modifications:
${modifiedList}

PRESERVE EXACTLY (character-identical for text, pixel-identical for visuals):
${preservedList}

DO NOT ALTER:
- Overall layout, composition, grid structure
- ${productRule}
- Fonts, font sizes, letter-spacing, text color of unchanged elements
- Position of every element that is NOT in the modified list above
- Color palette of regions that are NOT in the modified list above
- Typography, alignment, or weight of any preserved text

🔴 CHARACTER-LEVEL FIDELITY (CRITICAL — READ TWICE):
- Render EVERY character in every preserved + modified text value.
- Never drop "$", "%", leading words, or trailing words.
- If new text feels too long for its slot, shrink font to fit. NEVER truncate.
- Spell every preserved word exactly as shown in the reference.

Output: same aspect ratio and composition as the reference, same or higher resolution. Result should look like a small A/B variant of the reference — not a new ad.`;
}

