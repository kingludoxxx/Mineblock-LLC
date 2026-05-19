// ─────────────────────────────────────────────────────────────────────────────
// Standard Statics Generation Pipeline — Prompt Builders
// Follows the proven pipeline structure exactly
// ─────────────────────────────────────────────────────────────────────────────

// ─────────────────────────────────────────────────────────────────────────────
// Helpers
// ─────────────────────────────────────────────────────────────────────────────

const MONTH_RE = /\b(january|february|march|april|may|june|july|august|september|october|november|december)\b/i;
const SEASON_RE = /\b(spring|summer|fall|autumn|winter)\b/i;

/**
 * Fix B: Strip seasonal/month context from maxDiscount before passing to Claude.
 * "58% — never exceed. Current March Sale runs 58% off sitewide." → "58%"
 * Logs a warning so Ludo knows the product library needs updating.
 */
function sanitizeMaxDiscount(raw) {
  if (!raw) return raw;
  if (MONTH_RE.test(raw) || SEASON_RE.test(raw)) {
    const match = raw.match(/(\d+(?:\.\d+)?)\s*%/);
    const clean = match ? `${match[1]}%` : raw;
    console.warn(`[staticsPrompts] ⚠️ max_discount contains stale seasonal text — stripped to "${clean}". Update the Product Library field to remove the seasonal language.`);
    return clean;
  }
  return raw;
}

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

export function buildClaudePrompt(product, angle, customOverrides = null, layoutMap = null, templateData = null, angleData = null) {
  const profile = product.profile || {};
  const co = customOverrides?.claudeAnalysis || {};

  // Fix B: sanitize maxDiscount before it reaches any prompt rule
  if (profile.maxDiscount) profile.maxDiscount = sanitizeMaxDiscount(profile.maxDiscount);

  // Build product context from all available profile fields
  // Split into MANDATORY RULES (pricing/offers) and CONTEXT (background info)
  // This ensures Claude uses real product data instead of inventing prices/offers

  // ── MANDATORY PRODUCT RULES (these override EVERYTHING in the reference) ──
  const mandatoryRules = [
    product.price && `PRICE: The ONLY valid price is ${product.price}. If the reference shows ANY price, replace it with ${product.price}.`,
    profile.discountCodes && `DISCOUNT CODE: The ONLY valid discount code is ${profile.discountCodes}. If the reference shows ANY discount code (e.g. "SPRING10", "PROMO20", "CODE: XYZ"), you MUST replace it with this code. NEVER invent a discount code.`,
    profile.maxDiscount && `MAX DISCOUNT: ${profile.maxDiscount}. This number is STRICTLY a cap on sale-discount percentages (the "% OFF" on the sticker price). It is NOT a reward share, a performance metric, a power rating, a hash rate, a warranty percent, a retention figure, a satisfaction score, or anything else. USE IT ONLY inside price/discount badges framed as "N% OFF" / "SAVE N%" / "N% OFF WITH CODE X". NEVER use this number in bullets, headlines, stats, or body copy about block rewards, mining output, earnings, efficiency, ownership, or any non-discount concept. For example: "Keep 58% of the Reward" is BANNED — the product keeps 100% of the block reward (solo mining); 58% is a discount cap only. If the reference template has a big number in a non-discount slot, write the real value from PRODUCT CONTEXT for that specific concept (e.g. "100% of the block reward", "144 daily attempts") — never reuse maxDiscount's number.`,
    `🚫 REWARD PERCENTAGE IS ALWAYS 100%: If the reference ad has ANY percentage in a slot about "what you keep", "your earnings", "your reward share", "your cut", "returns for you", or anything framed as a portion of the mining reward — ALWAYS replace it with "100%" or "the full block reward". This is non-negotiable for solo-mining products. The user keeps every satoshi; no pool takes a cut. It doesn't matter what number is in the reference or what maxDiscount says — reward-share percentages are always 100%.\n  ❌ BANNED: "keeps 58% for you" / "you get 70%" / "earn 80% of rewards" / "keeps X% of the block"\n  ✅ CORRECT: "keeps 100% for you" / "you keep the full block reward" / "100% yours — no pool cut"`,
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
    `🚫 NO BARE "$" IN BULLETS OR STATS: NanoBanana reliably drops the "$" character during small-label text rendering, producing broken output like "Costs a Year to Run" (should be "$1 a Year") or "at K block reward" (should be "$300K"). For the "bullets" and "stats" fields SPECIFICALLY, you MUST write monetary amounts without the "$" sign. Use spelled-out or abbreviated forms instead. Headlines, badges, CTAs, and price slots CAN still use "$" (they render in larger slots and survive).\n\n❌ BANNED in bullets/stats:\n  "$1 a Year to Run"\n  "$300K Block Reward"\n  "$59.99 One-Time"\n  "$300,000 Potential"\n\n✅ VALID alternatives in bullets/stats:\n  "One Dollar a Year to Run"  or  "1 Dollar a Year to Run"\n  "300K Block Reward"  or  "300 Thousand in Every Block"\n  "59.99 One-Time"  or  "Sixty Bucks One-Time"\n  "300,000 Potential"  or  "300K Potential"\n\nThis ONLY applies to the "bullets" and "stats" arrays. Keep "$" in "headline", "subheadline", "badges", "cta", and "price" fields — those slots render large enough that NanoBanana handles the "$" character reliably.`,
    `🚫 NO MONTH NAMES OR SEASONAL SALE TEXT: If the reference contains ANY month name (January, February, March, April, May, June, July, August, September, October, November, December) or seasonal text ("Spring Sale", "Summer Deal", "March Promo", etc.), you MUST replace it with generic urgency copy ("Limited Time", "Flash Sale", "Today Only", "Ends Soon"). NEVER carry over a month name or season-specific sale text into adapted_text. This is non-negotiable.`,
    `🚫 NO AI-TELL CRUTCH WORDS: Every piece of adapted copy must sound like a human media buyer wrote it — not ChatGPT. BANNED WORDS AND PHRASES (do NOT use any of these, even once): "effortlessly", "seamlessly", "revolutionize", "revolutionary", "game-changer", "game-changing", "game changing", "elevate your", "unleash", "unlock your potential", "transform your", "transformative", "leverage", "empower", "empowering", "harness the power", "journey", "your journey", "cutting-edge", "state-of-the-art", "next-level", "next level", "take your [X] to the next", "delve into", "embark on", "navigate the", "at your fingertips", "meticulously", "intricate", "tapestry", "ecosystem" (unless literal), "paradigm", "holistic", "bespoke", "curated" (unless literal), "immerse", "effortless", "in today's fast-paced world", "in the ever-evolving", "in the realm of", "whether you're a [X] or [Y]", "look no further", "dive in", "dive into", "say goodbye to", "hello to", "power of", "world of", "realm of", "experience the [X]", "discover the [X]", "embrace". These are the DNA of AI-written copy — a human media buyer never writes them. Use concrete, specific, punchy language instead ("runs for $1 a month", "keep every block reward you mine", "plug it in, walk away, come back to Bitcoin").`,
    `✅ PREFER CONCRETE SPECIFICS OVER ABSTRACT HYPE: Your copy should pass the "would a skeptical Reddit user believe this?" test. Default to:\n  — Specific numbers from PRODUCT CONTEXT (price, wattage, warranty length)\n  — Concrete mechanics ("~30W from a standard wall outlet", "plug in via USB", "runs from any home office")\n  — Specific pain points ("pools take a 2% fee on every payout", "a used S19 still runs $3,000")\n  — Sharp contrasts ("no pool, no middleman, no fees")\nAVOID vague benefit-speak: "amazing results", "best-in-class", "premium experience", "top-tier", "industry-leading", "revolutionary approach", "proven to work", "unparalleled", "unmatched", "unrivaled", "second to none". If you can't point to a specific mechanism in PRODUCT CONTEXT that makes a claim true, cut the claim.`,
    !product.price && `🚫 NO INVENTED PRICES: The product price is not set. Do NOT copy, adapt, or carry over ANY price from the reference. Replace all price text with a non-price benefit claim (e.g. "Free Shipping" or the product name).`,
    product.price && `🚫 NO FABRICATED ANCHOR PRICES / FAKE "WAS $" INFLATION: When the reference template has a "WAS $X, NOW $Y" or "ORIGINALLY $X" pattern, you MUST NOT invent a higher fake anchor price. The ONLY valid numbers in any price field are:\n  — The actual product.price (${product.price})${product.profile?.maxDiscount ? `\n  — The actual discounted price derived from maxDiscount (${product.profile.maxDiscount})` : ''}${product.profile?.bundleVariants ? `\n  — Actual bundle prices from bundleVariants` : ''}\n\n❌ BANNED EXAMPLES (fabricated — DO NOT output):\n  "WAS $277, NOW $249"     — $277 is invented; product is $249\n  "WAS $499, NOW $249"     — $499 is invented\n  "ORIGINALLY $350, TODAY $249" — $350 is invented\n  "SAVE $78"               — based on an inflated comparison; the real saving from maxDiscount is different\n  "50% OFF — was $498"     — both halves are invented\n\n✅ VALID PATTERNS when reference uses discount framing:\n  "$249 — 10% off with BITCOIN10"         — uses real price + real discount code\n  "$224 with code BITCOIN10"              — real post-discount price (product.price − maxDiscount)\n  "CODE BITCOIN10 SAVES 10%"              — no fake anchor\n  "BUY 3 — SAVE $118"                     — matches bundleVariants exactly\n  "FREE SHIPPING + 2-YR WARRANTY"         — real offer, no fake price\n\nIF the reference ad shows "WAS $X, NOW $Y" and no valid anchor exists in PRODUCT CONTEXT, you MUST rewrite the price section WITHOUT a "was" anchor. Use one of the VALID PATTERNS above, or drop the price element entirely (emit "") and use a benefit claim instead. Fake anchor prices are deceptive pricing under FTC 16 CFR Part 233 and Meta Commerce policy — this is a hard compliance line.`,
    `🚫 NO FABRICATED DISCOUNT PERCENTAGES: The ONLY discount percentage you are allowed to write is the one from maxDiscount (${product.profile?.maxDiscount || 'NOT SET'}). Any other "% OFF" number is fabricated, even if the reference template shouts a big number.\n\n❌ BANNED (all fabricated unless the EXACT number matches maxDiscount):\n  "UP TO 58% OFF"       — not in product context\n  "46% OFF"             — not in product context\n  "75% OFF EVERYTHING"  — not in product context\n  "40% OFF SITEWIDE"    — not in product context\n  "HUGE 80% OFF SALE"   — not in product context\n\n✅ VALID (only if it matches maxDiscount verbatim):\n  "10% OFF"             — matches maxDiscount\n  "10% OFF WITH CODE ${product.profile?.discountCodes || 'XXX'}"\n  "SAVE 10% TODAY"\n\nIF the reference ad screams "50% OFF" or similar, you MUST replace it with the real percentage ("${product.profile?.maxDiscount || '10% OFF'}"), OR drop the percentage entirely and use an alternative framing: "FLASH SALE" / "LIMITED TIME OFFER" / "ACT NOW" / the real bundle savings from bundleVariants. Inventing a bigger discount is deceptive advertising — an easy FTC and Meta Ads policy violation.`,
    `🚫 NO FABRICATED GUARANTEE / WARRANTY PERIODS: The ONLY guarantee period allowed is what's in PRODUCT CONTEXT (${product.profile?.guarantee || 'not specified'}). Any other "N-day / N-year / LIFETIME" claim is fabricated.\n\n❌ BANNED (unless the EXACT period matches guarantee above):\n  "LIFETIME WARRANTY"      — fabricated (lifetime ≠ 2-year)\n  "90-DAY MONEY BACK"      — fabricated if real is 30-day\n  "1-YEAR WARRANTY"        — fabricated if real is 2-year\n  "5-YEAR COVERAGE"        — fabricated\n  "UNLIMITED GUARANTEE"    — fabricated\n\n✅ VALID (must match guarantee string verbatim):\n  "30-DAY MONEY BACK"      — matches guarantee\n  "2-YEAR WARRANTY"        — matches offerDetails (if 2-year)\n  "30-DAY RETURNS"         — equivalent rewording of the real 30-day guarantee\n\nIF the reference ad shows "LIFETIME WARRANTY" or any non-matching period, you MUST replace it with the real guarantee ("${product.profile?.guarantee || product.profile?.offerDetails || 'the real guarantee'}") verbatim. "LIFETIME" is an especially common fabrication — it is NEVER valid unless the product literally has a lifetime warranty. Mis-stating warranty length is deceptive advertising.`,
  ].filter(Boolean).map(l => `⚠️ ${l}`).join('\n');

  // ── AI CHIP POV: first-person chip voice override ──────────────────────────
  // Fires whenever the angle is "AI Chip POV" (or the angle data carries that name).
  // Injected as a mandatory rule so it overrides the default brand-voice guidance.
  const isAiChipPov =
    (angleData?.name || '').toLowerCase().includes('ai chip') ||
    (angle || '').toLowerCase().includes('ai chip');

  const aiChipVoiceBlock = isAiChipPov
    ? `\n\n🔴 VOICE OVERRIDE — AI CHIP POV (ABSOLUTE, overrides all other guidance):\nThis ad is narrated BY THE AI CHIP ITSELF — the chip speaks in first person. Every bullet, headline, and copy element must use first-person chip voice.\n\n✅ CORRECT (chip speaks as "I"):\n  "I sit inside your machine, working 24/7."\n  "I attempt a block 144 times every day."\n  "I don't share. Every satoshi I mine goes to you."\n  "I run for 1 dollar a month. I never sleep."\n  "I am the hardware. I am the miner. I do the work."\n\n❌ BANNED (company/narrator voice):\n  "MinerForge Pro mines Bitcoin for you"\n  "Our chip works 24/7"\n  "We deliver results"\n  "The device attempts 144 blocks daily"\n  "Designed to run 24/7"\n\nEVERY bullet and headline MUST use "I" (chip) as subject. If the reference uses "you" framing, translate to chip first-person ("I do X for you"). Never use "we", "our", or the product name as the agent — the chip speaks for itself.`
    : '';

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

  // ── Angle Strategy Section ─────────────────────────────────────────
  // When a full angleData object is provided (from product library), inject a
  // rich creative brief that overrides the template's default strategy.
  // Falls back to a simple one-liner when only the angle name string is available.
  const angleStrategySection = (() => {
    if (angleData && typeof angleData === 'object' && angleData.name) {
      const parts = [
        `\n\n${'═'.repeat(67)}`,
        `🎯 ANGLE STRATEGY — YOUR CREATIVE BRIEF (read this before analyzing the template)`,
        `This ad must execute the "${angleData.name}" angle.${angleData.funnel_stage ? ` Funnel stage: ${angleData.funnel_stage}.` : ''}`,
        `The reference template provides VISUAL STRUCTURE only. The creative direction below OVERRIDES the template's original messaging strategy.`,
        `${'═'.repeat(67)}`,
      ];
      if (angleData.lead_with) parts.push(`\nLEAD WITH:\n${angleData.lead_with}`);
      if (angleData.copy_directives || angleData.hook_strategy) {
        parts.push(`\nCOPYWRITING DIRECTIVES:\n${angleData.copy_directives || angleData.hook_strategy}`);
      }
      if (angleData.tone) parts.push(`\nTONE & VOICE:\n${angleData.tone}`);
      if (Array.isArray(angleData.required_elements) && angleData.required_elements.length > 0) {
        parts.push(`\nREQUIRED ELEMENTS (at least one must appear in the copy):\n${angleData.required_elements.map(e => `- ${e}`).join('\n')}`);
      }
      if (Array.isArray(angleData.headline_examples) && angleData.headline_examples.length > 0) {
        parts.push(`\nHEADLINE EXAMPLES (inspiration only — do NOT copy verbatim):\n${angleData.headline_examples.map(e => `- "${e}"`).join('\n')}`);
      }
      if (Array.isArray(angleData.banned_phrases) && angleData.banned_phrases.length > 0) {
        parts.push(`\nBANNED FOR THIS ANGLE: ${angleData.banned_phrases.join(', ')}`);
      }
      // Fix 2: inject sticky_note_text into Claude so body copy reinforces (not contradicts) the handwritten note
      if (Array.isArray(angleData.sticky_note_text) && angleData.sticky_note_text.length > 0) {
        parts.push(`\nSTICKY NOTE TEXT — these EXACT lines appear as handwritten text on the final image (composited by our typography system). Your body copy, bullets, and supporting elements MUST reinforce these lines — never contradict them:\n${angleData.sticky_note_text.map(l => `  "${l}"`).join('\n')}\nWrite copy that builds up to and supports these handwritten lines as the emotional close.`);
      }
      parts.push(`\nCRITICAL: Every headline, bullet, and hook you write must execute this angle. Do NOT default to what the reference template was saying — use the brief above as your primary creative direction.`);
      parts.push(`${'═'.repeat(67)}\n`);
      return parts.join('\n');
    }
    // Fallback: just the name string
    return angle ? `\n\n🎯 MARKETING ANGLE FOR THIS AD: ${angle}\n` : '';
  })();

  return `You are a $50K/month media buyer who writes ad copy that actually converts cold traffic. You've spent millions on Facebook ads. You know exactly what makes someone stop scrolling and click.

You are analyzing a reference ad image. You will extract its text layout, then write COMPLETELY NEW copy for a different product that fits the same visual slots.${angleStrategySection}
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
${angleData?.name ? `⚡ BEFORE WRITING A SINGLE WORD: Your copy must execute the "${angleData.name}" angle. Re-read the ANGLE STRATEGY brief at the top of this prompt. Your first headline MUST be a direct execution of that angle's hook — not a product-feature headline. If you can't immediately articulate how your headline executes "${angleData.name}", stop and re-read the brief.\n\n` : ''}For each text slot, write the best possible copy for YOUR product. You have FULL creative freedom — write whatever will convert best. The only constraints are:
- Stay within ±20% of the original element's character count (critical — an AI image generator renders the text, longer text gets garbled/misspelled)
- SHORT = PERFECT RENDERING. LONG = GARBLED MESS.
- Use the SAME template STRUCTURE (layout type, number of elements, visual hierarchy) — NOT the same words or emotional angle${angleData?.name ? `\n- 🔴 The ANGLE drives the emotional angle and hook — override the template's original emotion if needed to execute "${angleData.name}"` : ''}
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
` : ''}${aiChipVoiceBlock}
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
8. SPELLING & GRAMMAR CHECK: Read every single word in your output character-by-character before finalizing. These EXACT misspellings have appeared in previous generations and MUST NOT appear: "blockchalain" (→blockchain), "fincle" (→single), "simualed" (→simulated), "guarentee" (→guarantee), "experiance" (→experience), "minnig" (→mining), "reawrd" (→reward), "yoru" (→your), "teh" (→the), "recieve" (→receive). If you spot ANY misspelling, fix it immediately. ALL text MUST be in ENGLISH.
9. BENEFIT CHECK: Does every bullet/stat state a benefit, not a spec? "144 attempts daily" = SPEC → "144 daily chances at $300K" = BENEFIT.
10. ⚠️ CHARACTER COUNT CHECK: For EVERY element, count chars and compare to original slot size. Stay within ±20%. Short text renders perfectly; long text gets garbled. When in doubt, SHORTER.
11. COMPLETE THOUGHT CHECK: Does every text end as a complete thought? "Crypto feels too" = INCOMPLETE → "No middleman fees" = COMPLETE.
12. PRODUCT NAME CHECK: Does "${product.name}" appear correctly? Zero competitor names in output.
13. ⚠️ FABRICATED CLAIMS CHECK: Did you invent ANY quantity claim like "X FREE GIFTS", "X FREE BONUSES", "X ITEMS FREE"? If so, DELETE IT. You may only use such claims if the EXACT phrase appears in the product context. Individual offer features (shipping, warranty, etc.) are NOT "gifts" to be counted up.
14. ⚠️⚠️ OFFER STRUCTURE CHECK (MOST CRITICAL FOR COMPLIANCE): Scan every adapted string for offer constructions: "Buy X Get Y Free", "BOGO", "N-for-M" (e.g. "3 for 2"), "Free [item] with purchase", "Get N free". If ANY of these appear, verify the EXACT structure is listed verbatim in bundleVariants / offerDetails / discountCodes. If it is NOT, you MUST replace it with the real bundle/offer from PRODUCT CONTEXT (bundle pricing, real discount code, real free-shipping/warranty claim) OR blank the slot with "". Bundle SAVINGS never translate to "get free" language — "3-pack saves $118" is NEVER "Buy 3 Get 2 Free". Fabricating offers is false advertising and a hard Meta/FTC violation.
${angleData?.name ? `15. 🔴 ANGLE EXECUTION CHECK — "${angleData.name}" (NON-NEGOTIABLE FINAL GATE): Would a stranger reading ONLY your adapted copy — without seeing the product or the brief — immediately identify this as a "${angleData.name}" ad? If YES → pass. If NO → you failed the angle and must rewrite the failing elements from scratch using the ANGLE STRATEGY section at the top of this prompt. Warning signs of angle failure: (a) headlines/bullets that read like a generic feature list instead of executing the angle's hook, (b) copy that the reference template's original angle could have said, (c) no emotional or rhetorical tie to what makes "${angleData.name}" distinct. The angle is NOT optional framing — it IS the ad strategy. Every headline, stat, bullet, and badge must execute it.` : ''}

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
      // Slightly relaxed from 1.5x/28 — tighter caused NanoBanana to merge
      // bullet rows + drop entire badges. 1.8x/38 gives room without
      // triggering leading-word truncation.
      return { tol: 1.8, floor: 38 };
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

// ── Angle → Scene direction map ─────────────────────────────────────────────
// Tells Gemini how to adjust the background ATMOSPHERE to match the angle.
// The layout (positions, zones) stays fixed — only the env/mood shifts.
const ANGLE_SCENE_MAP = [
  {
    match: /anti.?fake|competitor.?callout/i,
    scene: 'Dark tech-lab atmosphere with precision lighting. A curved monitor or display in the background shows a blockchain transaction ledger — rows of alphanumeric hashes, block heights, timestamps (no specific coin names). Scientific, evidence-forward composition. Deep navy-to-black gradient background with subtle blue-green data glow reflecting off surfaces. The product is sharply lit with a single overhead key light creating clean shadows. Cool, analytical, factual — the visual equivalent of showing receipts. If space allows, a blurred-out generic competitor device silhouette fades into the background at 30% opacity to contrast with the crisp product.',
  },
  {
    match: /skeptic.?to.?believer|blockchain.?proof/i,
    scene: 'A wooden desk workspace — warm oak surface, natural side-light from an unseen window. A laptop or monitor in the background shows a block explorer interface: readable block height numbers (e.g. "Block #891,612"), transaction hash rows, timestamp column, reward column showing "3.125 BTC" — specific and legible, not blurred. A smartphone nearby shows a wallet notification. The scene feels like a private discovery moment: someone alone at their desk, doing their own research, finding the proof they needed. Cool daylight tones, analytical calm. The product sits center-left, connected via USB to the laptop.',
  },
  {
    match: /accidental.?winner|passive.?success/i,
    scene: 'Cozy living room or home-office shelf — soft warm ambient lamp light, slightly warm color temperature. Bookshelves, a plant, a framed photo out of focus in the background. The product is casually placed on a shelf or side table, NOT the hero — it is one object among normal home life. The scene communicates "set it and forget it": this device has been quietly running while life happens around it. No lab equipment, no tech-dramatic lighting. Relaxed, domestic, real.',
  },
  {
    match: /hater.?deflection/i,
    scene: 'Bold, high-contrast dark background — deep charcoal or near-black with a single warm spotlight effect illuminating the product from above. The product is the sole, undeniable protagonist of the frame. Background suggestion: abstract upward-trending data line or tally-mark graphic at low opacity (20%), like a silent scoreboard. High contrast between bright product surface and dark surround. The composition feels unapologetic — "the results are already in." No clutter. No soft elements. Stark and definitive.',
  },
  {
    match: /apology|false.?confession/i,
    scene: 'Clean, minimal, pure white or very light warm grey background. No gradients, no tech elements, no clutter. The product sits directly on a flat white surface with a soft natural shadow beneath it. Overhead or slight-angle softbox lighting — the same light used for product shots in honest editorial photography. The scene communicates full transparency: nothing hidden, nothing to hide. Like a product photo for a business that respects its customers enough to show them exactly what they are buying.',
  },
  {
    match: /ai.?chip|mechanism.?explainer|pov/i,
    scene: 'Extreme close-up PCB and circuit-board atmosphere. Deep navy or black background with faint PCB trace lines, solder points, and copper pathway patterns as a subtle texture. The device is lit with a cool blue-white rim light that highlights its circuit-board visible areas. Background may include a faint hexagonal chip-die grid pattern or neural-network node illustration at very low opacity. The scene communicates engineering precision and internal mechanical intelligence — this is what the hardware looks like from the inside out.',
  },
  {
    match: /promo|deal|discount|limited.?time/i,
    scene: 'Clean product-hero setup with a hint of celebration — warm amber or gold gradient background, subtly brightening behind the product. The product is on a pristine white or light-grey surface with a soft shadow. Background atmosphere suggests value without screaming "sale rack" — think premium retail display, not clearance bin. Clean negative space around the product for text zones. Lighting: two-point product photography setup with slightly warm fill light.',
  },
  {
    match: /urgency|scarcity|last.?chance|almost.?gone/i,
    scene: 'Dark, dramatic background — deep charcoal or navy with a tight spotlight beam hitting the product from directly above. The light falloff is sharp: bright product, immediately dark surround. The atmosphere is tense and decisive — this window closes. A very subtle warm amber rim light on one side of the product creates a sense of heat or urgency without being garish. Composition is stark and uncluttered. The single product under the spotlight communicates scarcity without needing to say it.',
  },
];

function getAngleSceneDirection(angleName) {
  if (!angleName) return null;
  for (const entry of ANGLE_SCENE_MAP) {
    if (entry.match.test(angleName)) return entry.scene;
  }
  return null;
}

export function buildNanoBananaPrompt(claudeResult, swapPairs, product, logoCount = 0, customOverrides = null, layoutMap = null, logoBackgroundTone = null, skipTextRendering = false, templateData = null, angleData = null, isGemini = false, hasCompetitorLogo = false) {
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
    ? (isGemini
        ? `Use the product in the FIRST image as a visual reference — study its shape, color, screen, and key physical details. Then render it photorealistically integrated into the ad scene: natural lighting, correct perspective, seamlessly placed. Do NOT paste the product photo directly. Generate a fresh, realistic depiction of the product that fits the ad's atmosphere. 🚫 NEVER show the product inside retail packaging, boxes, or containers — show the standalone device only.`
        : `Copy the EXACT product from FIRST image — same shape, colors, screen, details. Do NOT generate your own version. 🚫 Show the standalone device ONLY — never inside a box or retail packaging.`)
    : `This is a TEXT-ONLY ad. Do NOT add any product photo, device image, or physical object. The output must contain ONLY text and profile elements — ZERO product images.`;

  const logoToneNote = logoBackgroundTone === 'dark' ? ' Use WHITE version (dark bg).' : logoBackgroundTone === 'light' ? ' Use BLACK version (light bg).' : '';
  // Logo rule: only ask Gemini to handle COMPETITOR LOGO REPLACEMENT (pixel-perfect swap).
  // Brand watermark placement is done programmatically via sharp after generation —
  // Gemini renders text instead of the actual logo image when asked to place a watermark.
  const logoRule = logoCount > 0 && hasCompetitorLogo
    ? `\n🔴 LOGO REPLACEMENT: Copy the EXACT logo from ${logoImageRef} pixel-perfectly into the competitor logo slot — same shapes, proportions, text. Do NOT redesign or reposition it.${logoToneNote}`
    : '';  // watermark case: composited by sharp after generation, Gemini does NOT handle it

  // Banned words — keep very short
  const bannedWords = refKeywords.length > 0
    ? `\nBANNED WORDS (from reference product): ${refKeywords.map(w => `"${w}"`).join(', ')}. NEVER use these.`
    : (refCategory ? `\nBANNED: Any text about "${refCategory}" from the reference.` : '');

  // ── MINIMAL PRODUCT FACTS for image generator ──
  // Claude already used the full profile to write the swap pairs above.
  // NanoBanana/Gemini only needs price anchors (to avoid inventing numbers)
  // and compliance rules. Everything else invites Gemini to freestyle copy.
  const profile = product.profile || {};
  const productContextLines = [
    product.name && `Product name: ${product.name}`,
    product.price && `Exact price: ${product.price} — ONLY valid price; never write any other price`,
    profile.bundleVariants && `Bundle prices (only valid bundle amounts):\n${profile.bundleVariants}`,
    profile.discountCodes && `Discount code: ${profile.discountCodes}`,
    profile.maxDiscount && `Max discount %: ${profile.maxDiscount} — ONLY valid discount; never write a higher %`,
    profile.complianceRestrictions && `🚫 NEVER claim: ${profile.complianceRestrictions.slice(0, 120)}`,
    // Fix 4: expanded product context so Gemini makes visually relevant background/atmosphere choices
    profile.customerAvatar && `Target customer: ${profile.customerAvatar.slice(0, 150)}`,
    profile.mechanism && `How it works: ${profile.mechanism.slice(0, 150)}`,
    profile.bigPromise && `Core promise: ${profile.bigPromise.slice(0, 150)}`,
    Array.isArray(profile.benefits) && profile.benefits.length > 0
      && `Key benefits (use for background atmosphere only — do NOT write new copy from these): ${profile.benefits.slice(0, 4).map(b => typeof b === 'object' ? (b.text || b.name || String(b)) : b).join(' | ')}`,
    profile.differentiator && `What makes it different: ${profile.differentiator.slice(0, 150)}`,
  ].filter(Boolean);
  const productContext = productContextLines.length > 0
    ? `\n\nPRODUCT CONTEXT (do NOT use to write new copy — TEXT SWAPS above are the only copy; use price/discount lines to avoid inventing wrong numbers, and avatar/mechanism/benefits lines to inform background atmosphere and visual choices only):\n${productContextLines.map(l => `- ${l}`).join('\n')}`
    : '';

  // Brand colors for visual consistency
  const brandColorHint = (product.brand_colors && Object.keys(product.brand_colors).length > 0)
    ? `\n- Brand colors: ${Object.values(product.brand_colors).filter(Boolean).slice(0, 3).join(', ')} — use these for accent elements.`
    : '';

  // Angle-specific scene/atmosphere direction (keeps layout fixed, shifts background mood)
  const rawAngleName = angleData?.name || null;
  const angleSceneDirection = getAngleSceneDirection(rawAngleName);
  const angleSceneSection = angleSceneDirection && rawAngleName
    ? `\n\n🎨 ANGLE SCENE DIRECTION — "${rawAngleName}":\nThe TEXT SWAPS above already carry the angle's copy. Your visual job: adjust the BACKGROUND ATMOSPHERE of the ad to match the angle's emotional world. Keep the EXACT same layout, zones, and product position — only shift the background mood/environment.\n${angleSceneDirection}\nDo NOT change: text positions, product size/position, badge/CTA zones, overall layout structure. Only the background scene and atmosphere should reflect this angle.`
    : '';

  // Sticky note / handwritten element text enforcement
  // When an angle has exact handwritten lines (e.g. Apology sticky note), inject them
  // directly into the Gemini prompt so they are rendered character-perfect.
  const _stickyLines = Array.isArray(angleData?.sticky_note_text) ? angleData.sticky_note_text : [];
  const stickyNoteSection = _stickyLines.length > 0
    ? `\n\n🔴 HANDWRITTEN STICKY NOTE TEXT (MANDATORY — character-perfect):
The sticky note / handwritten paper element MUST contain EXACTLY these lines — nothing more, nothing less:
${_stickyLines.map((l, i) => `  Line ${i + 1}: "${l}"`).join('\n')}

Render each word spelled exactly as above. Word-by-word:
${_stickyLines.map(l => `  ${l.split(' ').map(w => `[${w}]`).join(' ')}`).join('\n')}

🚫 FORBIDDEN spelling errors (these exact mistakes have been seen before — do NOT repeat them):
  • "a apology" — WRONG. Must be "an apology".
  • "I is lower" — WRONG. Must be "It is lower".
  • Any truncated or abbreviated version of the lines above.
Every character in every line must exactly match what is listed. Check each word individually before rendering.`
    : '';

  // ── P1.1: If skipTextRendering=true, instruct the model to produce a
  // TEXT-FREE image (no headlines, body copy, badges, CTAs, prices). The
  // overlayText() function in server/src/utils/textOverlay.js will composite
  // real fonts + exact copy on top, eliminating all Gemini text-rendering
  // defects (misspellings, dupes, fabricated prices, letter swaps).
  // We still tell the model WHERE the text regions should go so layout and
  // visual hierarchy are preserved — it just fills those regions with solid
  // color blocks / placeholders instead of rendered glyphs.
  // Cross-niche detection: fire mandatory swap block when reference product clearly isn't ours.
  // "Our" category = mining / tech / hardware / crypto. Anything else is cross-niche.
  const isCrossNicheProduct = hasProductInReference && refCategory &&
    !/(miner|mining|crypto|bitcoin|hardware|tech|device|chip|asic|electronic|computer|gpu|blockchain)/i.test(refCategory);

  const crossNicheBlock = isCrossNicheProduct
    ? `\n\n🚨 MANDATORY FIRST STEP — PRODUCT SWAP (do this before anything else):\nThe reference contains a "${refCategory}" product. THIS PRODUCT MUST NOT APPEAR in your output.\nExecute in this exact order:\n1. LOCATE the "${refCategory}" in the reference image\n2. COMPLETELY ERASE it — paint over it with background fill matching the surrounding area (seamless, no visible ghost or outline)\n3. PLACE the "${product.name}" hardware (from FIRST input image) in that zone:\n   — Match the same position and approximate scale as what was erased\n   — Study the shape, screen/display, ports, and physical details from FIRST image\n   — Render photorealistically: correct perspective, natural lighting matching the scene\n   — Generate a fresh realistic depiction — do NOT paste the photo directly\nCRITICAL: Zero trace of "${refCategory}" product anywhere in the final output.`
    : '';

  if (skipTextRendering) {
    const hasAngleScene = !!angleSceneDirection;
    // Atmosphere mission block — placed BEFORE the rules so Gemini reads it first.
    // This is the primary creative differentiation between angles; must not be buried.
    const atmosphereMission = hasAngleScene
      ? `\n\n🔴 PRIMARY VISUAL MISSION — "${rawAngleName}" ATMOSPHERE:\nDo NOT replicate the reference image's background. You MUST create a FRESH scene that matches this angle's emotional world. This is your most important creative task — every angle must produce a visually distinct image:\n${angleSceneDirection}\nLayout constraint: text-region positions, product zone, and badge zones stay identical to reference. ONLY the background scene and atmosphere changes.`
      : '';
    return `The LAST image is a structural reference — use its LAYOUT only. Produce a text-free version with our product.${crossNicheBlock}${templateIntelligence}${atmosphereMission}

🔴 STRICT RULES:
1. 🔴 PRODUCT: ${productRule}${hasProductInReference ? ` Orientation: ${claudeResult.product_orientation || 'front-facing'}.${productRulesSection}` : ''} 🚫 LOGO-ON-PRODUCT: NEVER place anything ON the product device surface.
2. 🔴 ZERO TEXT — ERASE EVERYTHING: Output must contain ZERO rendered text — no headlines, subheadlines, body, prices, sale banners ("MARCH SALE", "40% OFF", "SPRING DEAL"), date text, promo codes, CTAs, badges, fine print, logo-with-text, decorative labels, UI strings, or ANY character visible in the reference. This includes text printed on backgrounds, promotional overlays, and sticker-style text elements. Leave every text region as a flat solid-color block matching the surrounding background tone. Our typography system composites the correct copy on top. When in doubt whether something is text — DON'T render it.
3. 🚫 STRIP ALL THIRD-PARTY BRAND ELEMENTS: Remove every logo, wordmark, emblem, or brand mark from a different company. Replace with clean solid-color fill matching background.${logoRule}
4. ${characterRules}
5. Layout: Keep EXACT same text-region positions, badge zones, and product placement.${!hasAngleScene ? ` Keep the same background colors and overall composition.` : ''} ONLY change: (a) product → ours, (b) erase all text, (c) strip third-party brands, (d) apply the angle atmosphere defined above.
6. PRODUCT LABEL: Copy the product image (FIRST image) EXACTLY — do NOT modify packaging.${brandColorHint}${productContext}${co.absoluteRules ? `\n${co.absoluteRules}` : ''}

CRITICAL: zero rendered text. When in doubt whether something is text — DON'T render it. Our overlay system adds all copy with pixel-perfect typography.`;
  }

  return `The LAST image is a structural reference — use its layout for our product.${crossNicheBlock}${templateIntelligence}

🔴 RULES IN PRIORITY ORDER:
1. 🔴 PRODUCT: ${productRule}${hasProductInReference ? ` Orientation: ${claudeResult.product_orientation || 'front-facing'}.${productRulesSection}` : ''} 🚫 LOGO-ON-PRODUCT: NEVER place any logo, text, badge, or watermark ON TOP OF the physical product device. Device surface must be completely clean.${logoRule}
2. 🚫 ERASE ALL REFERENCE BRAND & PRODUCT ELEMENTS: Strip every logo, wordmark, brand name, tagline, competitor product, and visual identity mark from the reference that belongs to a DIFFERENT brand. Replace each with a clean solid-color fill matching the background tone. Examples that MUST be removed: supplement brand wordmarks, food brand logos, clothing brand graphics, any brand that is NOT our product. If uncertain → strip it.
3. TEXT SWAPS — apply ALL of these EXACTLY (character-for-character):
${swapSectionFinal || '(no text changes)'}${bannedWords}
4. ELEMENT COUNT: Output must have the EXACT same number of text elements, logos, badges as the reference. Zero new elements added. 🚫 If a slot has no swap listed, carry the original text through unchanged.
5. PEOPLE: ${characterRules}
6. ALL text in ENGLISH. 🚫 No month names (January–December) or seasonal phrases. If reference shows seasonal text with no swap provided, replace with "Limited Time Offer". 🚫 No invented prices or discounts not in PRICE ANCHORS below.
7. 🔴 CHARACTER FIDELITY: Render EVERY character in each swap — first word, last word, punctuation, "$", "%". Shrink font size before dropping any character. "$300K" = "$" + "3" + "0" + "0" + "K", never "300K". "58% OFF" never "58 OFF". If text is long → shrink font, never truncate.

LAYOUT — preserve exactly:
- Keep all text positions, badge zones, CTA zones, product zone, and colors as in reference${visualLine}
- Spell every word correctly with proper spacing
- PRODUCT LABEL: Copy the product image (FIRST image) label EXACTLY — do NOT redesign or add text to packaging${angleSceneSection}${stickyNoteSection}${brandColorHint}${productContext}${co.absoluteRules ? `\n${co.absoluteRules}` : ''}`;
}

// ─────────────────────────────────────────────────────────────────────────────
// TWO-PASS PIPELINE — for cross-niche template adaptation
// Pass 1: product swap only (reference + product → intermediate with our product)
// Pass 2: text + atmosphere (intermediate → final polished ad)
// Logo compositing happens programmatically via sharp after Pass 2.
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Pass 1 prompt — replaces the reference product with ours, nothing else.
 * Images sent: [productImage, referenceImage] — product FIRST, reference LAST.
 */
export function buildProductSwapPrompt(claudeResult, product) {
  const {
    reference_product_category: refCategory,
    product_orientation,
    product_count,
    _refHasProduct,
    people_count,
  } = claudeResult;

  const hasProductInReference = (product_count ?? 1) > 0 && _refHasProduct !== false;
  const orientation = product_orientation || 'front-facing';
  const categoryName = refCategory || 'the existing product';
  const pCount = people_count ?? 0;
  const peopleRule = pCount === 0
    ? 'There are NO people in the reference. Do NOT add any human faces or bodies.'
    : `The reference has EXACTLY ${pCount} person(s). Keep the same number of people — do NOT add or remove faces.`;

  if (!hasProductInReference) {
    // Text-only or testimonial template — no product to swap
    return `The LAST image is a text-only reference ad. Your ONLY task: remove any third-party brand marks.

🔴 RULES:
1. 🚫 STRIP ALL THIRD-PARTY BRAND ELEMENTS: Remove every logo, wordmark, and brand graphic that belongs to a different company. Replace with clean background fill.
2. Do NOT change any text, layout, colors, or composition.
3. ${peopleRule}

Output: identical to reference except third-party brand marks are removed.`;
  }

  return `The LAST image is a reference ad. Your ONLY task: replace the product shown with ours.

🔴 PRODUCT REPLACEMENT — execute in this exact order:
1. FIND the "${categoryName}" in the reference image
2. COMPLETELY ERASE it — paint over it with background fill matching the surrounding area (blend seamlessly, no ghost outline)
3. PLACE the "${product.name}" hardware (from FIRST image) in that exact zone:
   — Match the original product's position and approximate scale
   — Study the shape, screen/display, ports, and physical details from FIRST image carefully
   — Render photorealistically: correct perspective for ${orientation}, natural lighting matching the scene environment
   — Generate a fresh realistic depiction — do NOT paste the product photo directly
   — 🚫 LOGO-ON-PRODUCT: NEVER place logos, text, badges, or watermarks ON the product device surface

🚫 DO NOT change anything else:
- All text stays exactly as in the reference (same words, same positions)
- Background, colors, badges, layout, and overall composition stay identical
- Do NOT add logos, watermarks, or any new elements whatsoever
- Do NOT move or modify any text elements
- ${peopleRule}

Your output is an INTERMEDIATE image: identical to the reference in every way except the product zone, which now shows the ${product.name}.`;
}

/**
 * Pass 2 prompt — applies text swaps and atmosphere to the Pass 1 result.
 * Images sent: [pass1ResultImage] — just the intermediate (no reference, no product).
 * The product is already correctly placed; do NOT touch it.
 */
export function buildTextPolishPrompt(claudeResult, swapPairs, product, layoutMap = null, angleData = null, customOverrides = null) {
  const {
    people_count, adapted_audience, character_adaptation, visual_adaptations,
    reference_product_keywords: refKeywords,
  } = claudeResult;
  const co = customOverrides?.nanoBanana || {};

  const pCount = people_count ?? 0;
  let characterRules;
  if (pCount === 0) {
    characterRules = 'There are NO people in the image. Do NOT add any human faces or bodies.';
  } else {
    characterRules = `The image has EXACTLY ${pCount} person(s). Keep EXACTLY ${pCount} — do NOT add or remove faces.`;
    if (adapted_audience) characterRules += ` Target: ${adapted_audience}.`;
    if (character_adaptation) characterRules += ` ${character_adaptation}.`;
  }

  // Build swap section (same logic as buildNanoBananaPrompt, simplified)
  const MONTH_NAMES_RE = /\b(january|february|march|april|may|june|july|august|september|october|november|december)\b/i;
  const removePairs = swapPairs.filter(p => p.remove || (p.adapted === '' && p.original));
  const replacePairs = swapPairs.filter(p => !(p.remove || (p.adapted === '' && p.original)));
  const FIELD_PRIO = { headline: 1, subheadline: 2, cta: 3 };
  const getPrio = f => FIELD_PRIO[(f || '').split('[')[0]] || 5;
  const sortedReplace = [...replacePairs].sort((a, b) => getPrio(a.field) - getPrio(b.field));
  const limitedPairs = [...sortedReplace.slice(0, 12), ...removePairs.slice(0, 20)];

  const swapSectionFinal = limitedPairs.map((pair, i) => {
    if (pair.remove || (pair.adapted === '' && pair.original)) {
      return `  ${i + 1}. "${pair.original}" → [REMOVE — delete this text, leave the space blank]`;
    }
    return `  ${i + 1}. "${pair.original}" → "${pair.adapted}"`;
  }).join('\n');

  const bannedWords = (refKeywords || []).length > 0
    ? `\nBANNED WORDS (from reference product): ${refKeywords.map(w => `"${w}"`).join(', ')}. NEVER use these.`
    : '';

  const mustChangeVisuals = (visual_adaptations || []).filter(v => v.is_angle_specific);
  const visualLine = mustChangeVisuals.length > 0
    ? `\nVisual changes: ${mustChangeVisuals.slice(0, 3).map(v => {
        const orig = (v.original_visual || '').slice(0, 40);
        const adapted = (v.adapted_visual || '').slice(0, 50);
        return `${v.position}: "${orig}" → "${adapted}"`;
      }).join('; ')}`
    : '';

  const profile = product.profile || {};
  const productContextLines = [
    product.name && `Product name: ${product.name}`,
    product.price && `Exact price: ${product.price} — ONLY valid price; never write any other price`,
    profile.bundleVariants && `Bundle prices:\n${profile.bundleVariants}`,
    profile.discountCodes && `Discount code: ${profile.discountCodes}`,
    profile.maxDiscount && `Max discount %: ${profile.maxDiscount} — ONLY valid discount`,
    profile.complianceRestrictions && `🚫 NEVER claim: ${profile.complianceRestrictions.slice(0, 120)}`,
  ].filter(Boolean);
  const productContext = productContextLines.length > 0
    ? `\n\nPRICE ANCHORS (for accuracy only — do NOT use to add new copy):\n${productContextLines.map(l => `- ${l}`).join('\n')}`
    : '';

  const brandColorHint = (product.brand_colors && Object.keys(product.brand_colors).length > 0)
    ? `\n- Brand colors: ${Object.values(product.brand_colors).filter(Boolean).slice(0, 3).join(', ')} — use for accents`
    : '';

  const rawAngleName = angleData?.name || null;
  const angleSceneDirection = getAngleSceneDirection(rawAngleName);
  const angleSceneSection = angleSceneDirection && rawAngleName
    ? `\n\n🎨 BACKGROUND ATMOSPHERE — "${rawAngleName}":\nShift the BACKGROUND only to match this angle's emotional world. Keep ALL text positions, product position, and layout structure IDENTICAL.\n${angleSceneDirection}`
    : '';

  // Sticky note / handwritten element text enforcement (same as Pass 1)
  const _stickyLinesP2 = Array.isArray(angleData?.sticky_note_text) ? angleData.sticky_note_text : [];
  const stickyNoteSectionP2 = _stickyLinesP2.length > 0
    ? `\n\n🔴 HANDWRITTEN STICKY NOTE TEXT (MANDATORY — character-perfect):
The sticky note / handwritten paper element MUST contain EXACTLY these lines — nothing more, nothing less:
${_stickyLinesP2.map((l, i) => `  Line ${i + 1}: "${l}"`).join('\n')}

Render each word spelled exactly as above. Word-by-word:
${_stickyLinesP2.map(l => `  ${l.split(' ').map(w => `[${w}]`).join(' ')}`).join('\n')}

🚫 FORBIDDEN spelling errors (must NOT appear):
  • "a apology" — WRONG. Must be "an apology".
  • "I is lower" — WRONG. Must be "It is lower".
  • Any truncated or abbreviated version of the lines above.`
    : '';

  return `Apply text replacements and atmosphere to this image. The product is already correctly placed — do NOT touch it.

🔴 RULES:
1. PRODUCT: Already correct — do NOT move, resize, modify, or reprocess it. 🚫 NEVER place anything ON the product device surface.
2. 🚫 STRIP REMAINING THIRD-PARTY BRAND ELEMENTS: Remove any logo, wordmark, or brand mark belonging to a different company. Fill with background color.
3. TEXT SWAPS — replace ALL reference text with these EXACT words (character-for-character):
${swapSectionFinal || '(no text changes)'}${bannedWords}
4. ELEMENT COUNT: Same number of text elements, badges, logos as input. Zero new elements.
5. PEOPLE: ${characterRules}
6. ALL text in ENGLISH. 🚫 No month names. 🚫 No seasonal phrases. 🚫 No invented prices.
7. 🔴 CHARACTER FIDELITY: Render EVERY character in each swap. Shrink font before dropping any character. "$" always renders. "%" always renders.

LAYOUT — preserve exactly:
- All text positions, badge zones, CTA zones, colors, overall composition${visualLine}
- Spell every word correctly with proper spacing${angleSceneSection}${stickyNoteSectionP2}${brandColorHint}${productContext}${co.absoluteRules ? `\n${co.absoluteRules}` : ''}`;
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
7. Allowed change_category values: "visual-refresh" | "hook-swap" | "angle-variant" | "product-orientation" | "badge-restyle" | "background-redesign" | "color-scheme-swap". Pick the BEST ${N} distinct categories.
   - "background-redesign": completely replace the background with a different environment, scene, or mood (e.g. dark tech lab → outdoor mining site, red gradient → deep space). Product and all text stay identical.
   - "color-scheme-swap": shift the entire color palette to a contrasting scheme (e.g. red/warm → dark navy/cool, or gold/black → green/black). Keep layout and text identical.
   These two bolder categories should be used for at least 1 variation when ${N} >= 2 — they produce the most visually distinct tests.

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

  const isBoldCategory = v.change_category === 'background-redesign' || v.change_category === 'color-scheme-swap';

  if (isBoldCategory) {
    return `Edit the reference ad (LAST image).

🎨 BOLD VISUAL VARIANT — same offer, substantially different look.

WHAT TO CHANGE:
${v.change || '(see modified list below)'}

Specific modifications:
${modifiedList}

WHAT MUST STAY IDENTICAL (text content — character-perfect):
${preservedList}

RULES:
- All TEXT content (headlines, badges, prices, CTAs, body copy) must be reproduced character-perfectly — same words, same spelling, same punctuation.
- ${productRule}
- Text layout positions (top/middle/bottom zones) should remain recognisable, but visual treatment of the background, colors, lighting, and atmosphere should be substantially different.
- Fonts and font sizes of text elements stay the same.

🔴 CHARACTER-LEVEL FIDELITY (CRITICAL):
- Render EVERY character in every text element.
- Never drop "$", "%", leading words, or trailing words.
- If text feels too long for its slot, shrink font to fit. NEVER truncate.

Output: same aspect ratio as the reference, same or higher resolution. This variant should look visually distinct from the reference at a glance — different enough that a viewer immediately notices the difference — while communicating the exact same offer.`;
  }

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

Output: same aspect ratio and composition as the reference, same or higher resolution. Result should look like a clean A/B variant of the reference — same structure, one isolated change.`;
}

// ─────────────────────────────────────────────────────────────────────────────
// DOCUMENT ARCHETYPE: Dedicated Claude prompt for long-form document-style ads
// Used when isDocumentTemplate === true. No image analysis needed — generates
// structured copy for Playwright HTML renderer from scratch.
// ─────────────────────────────────────────────────────────────────────────────

export function buildDocumentClaudePrompt(product, angle, customOverrides = null, layoutMap = null, templateData = null, angleData = null) {
  const profile = product.profile || {};

  if (profile.maxDiscount) profile.maxDiscount = sanitizeMaxDiscount(profile.maxDiscount);

  const price = product.price;

  const contextLines = [
    `Product Name: ${product.name}`,
    price && `Price: ${price}`,
    product.description && `Description: ${product.description}`,
    profile.tagline && `Tagline: ${profile.tagline}`,
    profile.oneliner && `One-liner: ${profile.oneliner}`,
    profile.bigPromise && `Core Promise: ${profile.bigPromise}`,
    profile.mechanism && `How It Works: ${profile.mechanism}`,
    profile.differentiator && `Why It's Different: ${profile.differentiator}`,
    Array.isArray(profile.benefits) && profile.benefits.length > 0
      && `Key Benefits: ${profile.benefits.map(b => typeof b === 'object' ? (b.text || b.name || String(b)) : b).join(', ')}`,
    profile.painPoints && `Customer Pain Points: ${profile.painPoints}`,
    profile.customerAvatar && `Target Customer: ${profile.customerAvatar}`,
    profile.customerFrustration && `Customer Frustration: ${profile.customerFrustration}`,
    profile.customerDream && `Dream Outcome: ${profile.customerDream}`,
    profile.voice && `Brand Voice/Tone: ${profile.voice}`,
    profile.guarantee && `Guarantee: ${profile.guarantee}`,
    profile.offerDetails && `Offer Details: ${profile.offerDetails}`,
    profile.discountCodes && `Discount Code: ${profile.discountCodes}`,
    profile.maxDiscount && `Max Discount %: ${profile.maxDiscount}`,
    profile.complianceRestrictions && `NEVER CLAIM: ${profile.complianceRestrictions}`,
  ].filter(Boolean).map(l => `- ${l}`).join('\n');

  const mandatoryRules = [
    price && `PRICE: The ONLY valid price is ${price}. Never invent, change, or omit it.`,
    profile.discountCodes && `DISCOUNT CODE: Use ONLY "${profile.discountCodes}". Never invent codes.`,
    profile.maxDiscount && `MAX DISCOUNT: ${profile.maxDiscount} — use ONLY for price/discount context. NEVER as reward share or earnings percentage.`,
    `REWARD % IS ALWAYS 100%: Solo mining means the user keeps 100% of every block reward. Never write any reward-share % other than 100%. Always "100%" or "full block reward".`,
    `NO FABRICATED SOCIAL PROOF: Never invent review counts, user counts, star ratings, or any numeric social-proof claim.`,
    `NO FABRICATED STATISTICS: Never invent study results, efficacy percentages, retention figures, or clinical claims.`,
    `NO FABRICATED SCARCITY: Never invent stock counts, units remaining, or countdown timers.`,
    profile.complianceRestrictions && `COMPLIANCE — NEVER CLAIM: ${profile.complianceRestrictions}`,
    `NO AI CLICHÉS: Never use "game-changer", "revolutionary", "cutting-edge", "seamlessly", "elevate", "unlock your potential", "transform your", "leverage", "empower", "delve into", "journey".`,
    `PERFECT SPELLING — READ EVERY WORD: After writing, go back and read each word character-by-character. These exact errors MUST NOT appear: "blockchalain"→"blockchain", "fincle"→"single", "simualed"→"simulated", "guarentee"→"guarantee", "experiance"→"experience", "minnig"→"mining", "reawrd"→"reward". Fix any spelling error before returning JSON.`,
    `GRAMMATICAL ENGLISH ONLY: Every sentence must be grammatically complete and logical. Read each sentence aloud mentally before finalizing.`,
  ].filter(Boolean).map(l => `⚠️ ${l}`).join('\n');

  const angleSection = (() => {
    if (angleData && typeof angleData === 'object' && angleData.name) {
      const parts = [
        `\n\n${'━'.repeat(60)}`,
        `🎯 DOCUMENT ANGLE: "${angleData.name}"${angleData.funnel_stage ? ` [${angleData.funnel_stage} funnel]` : ''}`,
        `${'━'.repeat(60)}`,
      ];
      if (angleData.lead_with) parts.push(`LEAD WITH:\n${angleData.lead_with}`);
      if (angleData.copy_directives || angleData.hook_strategy) {
        parts.push(`COPYWRITING APPROACH:\n${angleData.copy_directives || angleData.hook_strategy}`);
      }
      if (angleData.tone) parts.push(`TONE: ${angleData.tone}`);
      if (Array.isArray(angleData.required_elements) && angleData.required_elements.length > 0) {
        parts.push(`REQUIRED ELEMENTS:\n${angleData.required_elements.map(e => `- ${e}`).join('\n')}`);
      }
      if (Array.isArray(angleData.sticky_note_text) && angleData.sticky_note_text.length > 0) {
        parts.push(`HANDWRITTEN NOTE TEXT (your body copy must build toward and support these lines):\n${angleData.sticky_note_text.map(l => `  "${l}"`).join('\n')}`);
      }
      parts.push(`${'━'.repeat(60)}\n`);
      return parts.join('\n');
    }
    return angle ? `\n\n🎯 DOCUMENT ANGLE: "${angle}"\n` : '';
  })();

  return `You are writing copy for a DOCUMENT-STYLE static ad for ${product.name}. This ad renders as a clean white typographic document — like a formal letter, official statement, or direct-response print ad. No product images. Only text, rendered by a professional HTML/CSS layout engine.${angleSection}
YOUR JOB:
Write compelling, perfectly spelled, grammatically correct document copy. Every word matters — this is the complete text of a full-page ad.

PRODUCT CONTEXT:
${contextLines}

━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
🔴 MANDATORY RULES — VIOLATION = FAILURE (read before writing anything):
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
${mandatoryRules}

COPY STRUCTURE:

HEADLINE (5-10 words, uppercase):
The core proposition or angle hook. Punchy, specific, immediately interesting.
Good examples:
- "THE SOLO BITCOIN MINER THAT COSTS $1/MONTH TO RUN"
- "WE NEED TO COME CLEAN ABOUT BITCOIN MINING FEES"
- "EVERY MINING POOL IS TAKING MONEY THAT IS YOURS"
- "ONE DEVICE. ONE WALLET. 100% OF THE REWARD."

SUBHEADLINE (10-25 words, one complete sentence):
Amplifies the headline with context or the "why this matters" bridge.

BODY COPY (2-4 short paragraphs, 100-250 words TOTAL):
- Each paragraph: 2-4 sentences. Short sentences. Clear language.
- USE CONCRETE SPECIFICS: actual price, wattage, block reward, mining frequency, guarantee period from the product context above.
- Address the customer's real frustration, then offer the honest solution.
- Write like a confident founder speaking directly to a skeptical customer.
- Each paragraph advances an argument: Opening claim → Problem → Solution → Proof → Invitation.
- ZERO vague benefit-speak. "Better results" = WRONG. "$1/month in electricity" = RIGHT.
- NO paragraph breaks represented as literal "\\n\\n" in the string — write actual paragraph text separated by real newlines in the JSON string value.

BULLETS (2-4 items, under 15 words each):
Specific, concrete proof points or key benefits.
BAD: "Innovative technology for better mining results"
GOOD: "Attempts a block 144 times daily — 144 chances at the full reward"

BADGES (1-3 items, under 8 words each):
Short credibility or offer badges matching ACTUAL product offer.
Examples: "30-Day Money-Back Guarantee", "Free Shipping Included", "2-Year Warranty".
Leave as empty array [] if no valid badges exist in product context.

CTA (5-12 words):
Simple, direct action.
Examples: "Try it risk-free — 30-day money-back guarantee." or "Order at ${price ? `${price} — free shipping included.` : 'mineblock.co'}"

━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
QUALITY GATE — verify each item before returning JSON:
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
1. SPELLING: Read every word character-by-character. Is every word spelled correctly in English?
2. GRAMMAR: Does every sentence form a complete, logical thought?
3. SPECIFICITY: Is every claim backed by a specific number from the product context?
4. ANGLE: Does the headline immediately execute the "${angleData?.name || angle || 'document'}" angle?
5. NO AI LANGUAGE: Scan for banned words (game-changer, revolutionary, cutting-edge, seamlessly). Remove any found.
6. NO FABRICATION: Any invented social proof, statistics, or offer structures not in product context? Remove.
7. PRICE: Is the price exactly ${price || 'as specified in product context'}? No other price appears anywhere?
8. LENGTH: Is body copy between 100-250 words? Is each bullet under 15 words?

Return ONLY valid JSON (no markdown, no code fences):
{
  "headline": "SHORT BOLD HEADLINE IN CAPS — 5-10 words",
  "subheadline": "One sentence subheadline that amplifies the headline — 10-25 words",
  "body": "Full body copy here. Write 2-4 short paragraphs. Separate paragraphs with a blank line (\\n\\n in JSON). Total 100-250 words. Perfectly spelled. Grammatically correct.",
  "bullets": ["First specific proof point under 15 words", "Second specific proof point"],
  "badges": ["Badge matching real product offer"],
  "cta": "Direct call to action 5-12 words"
}`;
}

