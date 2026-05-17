# Statics Generation Tool — Full Scope & Fix Plan
**Date:** 2026-05-17  
**Author:** Code analysis (Claude Sonnet 4.6) — for Ludo's approval before any implementation  
**Branch:** main (`2ac45b9`)

---

## Executive Summary

The statics generation tool is failing at its primary job: **replacing the reference template's product with our product and generating a high-converting ad around it.** When the reference shows a supplement bottle, the output shows a supplement bottle with a tiny miner as an inset. This is not a prompt-wording problem. It is a **structural architectural problem** — the pipeline was designed to *edit* a reference image rather than *adapt* it. These are fundamentally different operations.

This document identifies every root cause found through deep code analysis of the full pipeline:
- `staticsGeneration.js` (~3,700 lines)
- `staticsPrompts.js` (~1,100 lines)
- `geminiImageGen.js` (~195 lines)
- `productImageSelector.js`
- `templateAnalysis.js` + `textOverlay.js`
- `StaticsGeneration.jsx` + `PipelineView.jsx`

**15 distinct issues** are documented below, organized into 4 categories:

1. **Architecture** — fundamental structural problems
2. **Prompting** — what we tell the AI is wrong or insufficient
3. **Data** — inputs to the pipeline are incomplete or wrong
4. **UX** — surface-level gaps that create confusion or silent failures

Each issue has a severity rating (P0–P4) and a concrete fix proposal.

---

## What the Tool Is Supposed to Do

Per your definition:

1. **Analyze the reference image** — understand the ad type, layout, product category, text structure, and visual hierarchy
2. **Replace the template's product** — not just swap pixels; actually generate our product inside the template's scene/context
3. **Generate high-converting copy** — from the angle prompt + product library, resonant with the template strategy

The current tool does step 1 reasonably well (Claude analysis). Steps 2 and 3 fail at the model level.

---

## CATEGORY 1: ARCHITECTURE

### Issue A1 — Gemini is an Edit Model, Not a Replace Model (P0 — Critical)

**What's happening:**  
Gemini `gemini-2.5-flash-image` is a multimodal image EDITOR. Its core inductive bias is: *preserve the reference image and apply targeted modifications.* When you send it a supplement bottle ad and say "edit this," it keeps the supplement bottle as the primary subject. It treats our product as a secondary element to incorporate alongside the reference product.

**The prompt says:**  
`"Edit the reference ad (LAST image)."` — This is the very first line. Gemini interprets "edit" as "make changes to" not "replace everything."

The `productRule` says:  
`"Use the product in the FIRST image as a visual reference — study its shape... Then render it photorealistically integrated into the ad scene."`

Gemini interprets "integrated" as "added to the scene alongside the existing product" — not "in place of the existing product."

**Root cause:**  
There is no explicit instruction that says: *The reference image has a [supplement bottle / greens jar / food product] as its main subject. REMOVE that product entirely. The product zone at [position] must contain ONLY our miner — zero trace of the reference product.*

**Fix:**  
1. Claude's output (`claudeResult`) already captures `reference_product_category` and `reference_product_keywords`. Use these to build a **hard REMOVAL rule** at the start of the Gemini prompt:
   ```
   MANDATORY PRODUCT REMOVAL: The reference ad features a "[reference_product_category]" product. 
   This product does NOT exist in the output. ERASE it completely. The product zone must show 
   ONLY our "[product.name]" miner hardware — zero trace of the reference product.
   ```
2. Add `visual_concept` from Claude's `visual_adaptations` to the REMOVAL instruction so Gemini knows conceptually what to erase:
   ```
   The reference shows: "[original_visual]" — REMOVE this entirely.
   Replace with: "[adapted_visual]"
   ```
3. Move product removal instructions to the **first rule** in the Gemini prompt (currently buried under "LAYOUT RULES").

---

### Issue A2 — No Two-Pass Architecture for Complex Template Swaps (P0 — Critical)

**What's happening:**  
The pipeline does everything in one Gemini call. It asks Gemini to simultaneously:
1. Erase the reference product
2. Integrate our product photorealistically
3. Swap all text
4. Place the logo
5. Adjust background atmosphere for the angle

This is too many conflicting operations for one shot. When the reference product occupies 40–60% of the image canvas, Gemini's editing bias means it cannot reliably erase it while also integrating a new product. The two goals conflict — "keep the scene" vs "replace the centerpiece of the scene."

**Root cause:**  
A single `editImage()` call handles all transformations. There is no intermediate step.

**Fix:**  
Implement a **two-pass architecture** for templates where `reference_product_category != 'miner'` (cross-niche adapts):

**Pass 1 — Product Integration:**
- Send: `[reference ad, product image]`
- Prompt: Focus ONLY on removing the reference product + integrating our product
- Output: intermediate image with correct product, original text preserved
- Time: ~15–25s

**Pass 2 — Polish:**
- Send: `[Pass 1 output, logo image]`
- Prompt: Apply text swaps, place logo, adjust background atmosphere for angle
- Output: final image
- Time: ~15–25s

**Trade-off:** This doubles Gemini API cost and adds 15–30s to generation time. Mitigation: only use two-pass when `reference_product_category` != our product category. One-pass for same-niche or product-iteration templates.

**Code location to modify:** `staticsGeneration.js` lines 1003–1095 (the Gemini parallel ratio generation block). Add a flag `const needsTwoPass = refProductCategory && !refProductCategory.includes('miner')`.

---

### Issue A3 — Text Overlay System Exists But Has Never Been Enabled in Production (P1 — High)

**What's happening:**  
`textOverlay.js` is a complete system (using `sharp` + `@resvg/resvg-js`) that:
1. Tells Gemini to generate a **text-free** image
2. Composites the adapted copy text on top with real fonts, deterministic positioning

When enabled, **every text error Gemini makes becomes impossible** — there is no Gemini-rendered text to be wrong.

The flag: `const skipTextRendering = (process.env.STATICS_TEXT_OVERLAY || 'false').toLowerCase() !== 'false';`  
Default: **always false in production** (never enabled).

**Root cause:**  
The Render env var `STATICS_TEXT_OVERLAY` has never been set. The system was built but never activated.

**Current cost of not enabling it:**
- Gemini misspells words in small text slots
- Gemini drops "$" signs reliably in bullets/stats
- Gemini hallucinating prices despite the price anchor rules
- Running up to 3 generation attempts per ratio just for text QC (3x cost, 3x time)
- Still shipping 30–40% of ads with text warnings

**Fix:**  
Set `STATICS_TEXT_OVERLAY=true` on Render. Before doing this, verify the text overlay system produces correct output:
1. Run the system on a known template with all ratios
2. Confirm text positions from layoutMap translate correctly to pixel coordinates
3. Confirm font rendering looks production-quality

**Risk:** The `parsePosition()` function in textOverlay.js parses natural-language position strings ("top third, centered") into pixel coordinates. If Claude's layout map positions are ambiguous, text may land in wrong locations. Run a dry-test on 5 templates before enabling in production.

---

### Issue A4 — Single-Shot Multi-Object Instruction (P1 — High)

**What's happening:**  
When Gemini receives 4+ images `[product, logo, reference]` and is told to:
- Find and remove the supplement from the reference (image 3)
- Find the product (image 1) and integrate it into the reference
- Find the logo (image 2) and place as a corner watermark

...it must perform 3 separate visual operations across 3 different source images simultaneously. The reference image is compositionally dominant (it's a complete, complex ad). The product and logo are isolated cutouts. Gemini's attention collapses to "the reference is the scene, images 1 and 2 are modifiers."

**Fix:**  
This resolves when the two-pass architecture (A2) is implemented. In Pass 1, only 2 images are sent: `[reference, product]`. In Pass 2, only 2 images: `[pass1_result, logo]`. Each pass has one clear job.

---

## CATEGORY 2: PROMPTING

### Issue P1 — Product Removal Not Stated Explicitly (P0 — Critical)

**Current prompt (line ~1003 in staticsPrompts.js):**
```
Edit the reference ad (LAST image).

🔴 STRICT RULES (most important):
1. ELEMENT COUNT: Output must have the EXACT same number of text elements...
2. PRODUCT: Use the product in the FIRST image as a visual reference...
```

The reference product is never mentioned as something to **delete**. Rule 3 says "STRIP ALL THIRD-PARTY BRAND ELEMENTS" but this is about logos and wordmarks, not the product itself.

**What's needed at position #1 in the prompt:**
```
🔴 MANDATORY BEFORE ANYTHING ELSE:
The reference ad features a [category] product (e.g. "supplement bottle", "food item", "clothing"). 
THIS PRODUCT DOES NOT EXIST IN YOUR OUTPUT.
- Identify the reference product in the image
- ERASE IT COMPLETELY from the canvas
- Fill the erased area with the background color/texture that matches the surrounding area
- Then place our product (FIRST image) in that exact zone
```

**Code location:** `buildNanoBananaPrompt()` in `staticsPrompts.js`, starting at line ~1003.

---

### Issue P2 — Visual Adaptations Buried and Soft (P1 — High)

**Current behavior:**  
Claude produces `visual_adaptations` like:
```json
{
  "original_visual": "green supplement bottle in center-left position",
  "adapted_visual": "MinerForge Pro ASIC miner in center-left position, angled-right",
  "position": "center-left, occupying ~50% of canvas height",
  "is_angle_specific": true
}
```

This is useful data. But it's formatted as:
```
Visual changes: center-left: "green supplement bottle" → "MinerForge Pro ASIC miner"
```

And injected under "LAYOUT RULES" at the bottom of the prompt — well past Gemini's attention peak.

**Fix:**  
Inject visual adaptations **immediately after the product removal rule**, before any other rules:
```
VISUAL REPLACEMENTS (EXECUTE IN THIS ORDER):
1. ERASE "green supplement bottle" from center-left (50% of canvas height) — replace with background fill
2. PLACE our miner (FIRST image) at center-left in angled-right orientation, same size zone
3. [next visual change]
```

Ordered execution. Specific positions. Not buried.

---

### Issue P3 — Gemini Prompt Starts with "Edit" (P1 — High)

**Current first word:** `"Edit the reference ad (LAST image)."`

"Edit" semantically implies "change a few things, keep the essence." This primes Gemini to preserve.

**Better framing:**
```
"Use the reference ad (LAST image) as a STRUCTURAL TEMPLATE ONLY. 
The layout, text zones, background style, and visual hierarchy are yours to keep. 
The PRODUCT and BRAND IDENTITY must be completely replaced."
```

"Structural template" vs "ad to edit" changes the model's behavioral frame from "modify" to "rebuild using this structure."

---

### Issue P4 — Logo Instruction Is Insufficiently Specific (P1 — High)

**What's in the prompt:**
```
🔴 BRAND LOGO: Place the brand logo from image 2 as a small watermark (≈12–15% of ad width) in 
the bottom-left or bottom-right corner — whichever has the most empty space.
```

**What Gemini actually does:**  
Gemini renders a TEXT WATERMARK that says "MineBlock" instead of placing the actual logo image. This is because Gemini's understanding of "place image N in corner" is inconsistent — it sometimes regenerates a text version of what the image shows rather than compositing the image literally.

**Fix options:**
1. **Two-pass logo placement** (implemented in A2): In Pass 2, only the logo image is in context alongside the result. Prompt: `"Take image 2 (the brand logo) and composite it literally, pixel-for-pixel, into the bottom-right corner of image 1 at 12% of image width. Do not redraw or interpret it — copy the pixels."`

2. **Post-process logo compositing in Node.js:** Use `sharp` (already a dependency) to composite the logo onto the generated image programmatically instead of asking Gemini. This is 100% reliable and costs zero API calls:
   ```js
   const logoBuffer = await fetchLogoAsBuffer(logoUrl);
   const withLogo = await sharp(generatedImageBuffer)
     .composite([{ input: resizedLogo, gravity: 'southeast', blend: 'over' }])
     .toBuffer();
   ```
   This is the correct long-term solution. Logos should NEVER go through an AI model — they must be composited programmatically.

**Recommendation:** Option 2 (sharp compositing) for logos. No AI involved. 100% reproducible. Zero hallucination.

---

### Issue P5 — Swap Pairs Reference Original Text, Not Position (P2 — Medium)

**Current swap pair format:**
```
1. [headline] "REAL GREENS. REAL RESULTS." → "MINE BITCOIN. KEEP IT ALL."
```

Gemini must:
1. Find the text "REAL GREENS. REAL RESULTS." in the reference image (which it cannot read with perfect OCR)
2. Apply the replacement there

If Gemini's OCR of the reference is slightly off (different rendering, anti-aliasing, different case perception), it can't match the original text and either ignores the swap or applies it to the wrong element.

**Fix:**  
Add position context from the `layoutMap` to each swap pair:
```
1. [headline at TOP-CENTER, ~25 chars] "REAL GREENS. REAL RESULTS." → "MINE BITCOIN. KEEP IT ALL."
```

The layoutMap already has position + char count per element. Cross-referencing swap pairs with layoutMap positions would give Gemini a spatial anchor instead of a text-matching anchor.

This is a medium-complexity change in `buildNanoBananaPrompt()` — join swap pairs with their matching layoutMap entry by `role` field.

---

### Issue P6 — Angle Scene Direction Soft and Inconsistent (P2 — Medium)

**Current ANGLE_SCENE_MAP:**  
Good atmospheric descriptions (e.g., for AI Chip POV: "Circuit board pattern or dark navy/black tech background with subtle PCB trace lines"). But this scene direction only fires if `rawAngleName` is set AND Gemini decides it can modify the background.

**Problem:**  
When the reference is a lifestyle supplement ad (person holding a green drink, bright white background), Gemini cannot change the background to a dark circuit board while simultaneously swapping the product and applying text swaps. There are too many conflicting instructions.

**Fix:**  
In Pass 2 (once product is placed), make background atmosphere a dedicated Pass 2 instruction rather than a secondary note. Separate the "product integration" concern from the "background mood" concern.

---

### Issue P7 — Claude Prompt Character Count vs. Gemini Rendering Reality (P3 — Low)

**What Claude is told:**  
`"Stay within ±20% of the original element's character count (critical — an AI image generator renders the text, longer text gets garbled/misspelled)"`

**Reality:**  
With text overlay enabled (A3), character count constraints become irrelevant — we composite real fonts. The ±20% rule is only needed for Gemini's native text rendering, which is the inferior path.

**Fix:**  
When `skipTextRendering=true`, relax the character count constraint in Claude's prompt. Claude can write better, longer copy when it knows it won't be rendered by Gemini. The `buildSwapPairs()` length enforcement logic (field tolerance rules) should also be relaxed or disabled in text-overlay mode.

---

## CATEGORY 3: DATA

### Issue D1 — Template `deep_analysis` Not Populated for Most Templates (P1 — High)

**What's in the DB:**  
`statics_templates` has a `deep_analysis` column. When populated, it contains rich adaptation instructions:
- `adaptation_instructions.common_failure_modes`: e.g., "supplement bottle is large and centered — explicit removal instruction required"
- `product_replacement_difficulty`: "hard|medium|easy"
- `critical_elements_to_preserve`
- `product_replacement_notes`

**Current state:**  
The `analyzeAndCacheLayout()` function (auto-runs on first use) only generates a `layoutMap` (structural positions). The `deep_analysis` must be set via the `TemplateAnalysisModal` (manual trigger). Most templates have not gone through this analysis.

**Without `deep_analysis`:**  
- Gemini has no warning that a specific template is "high difficulty" for product replacement
- No failure mode guidance per template
- No product-specific positioning notes

**Fix:**  
1. Auto-trigger `deep_analysis` generation when a template is first used (not just `layoutMap`)
2. Add `product_replacement_difficulty` to the prompt logic: if `difficulty === 'hard'`, automatically use two-pass mode (A2)
3. Add `common_failure_modes` as hard NO-DO rules at the top of the Gemini prompt

---

### Issue D2 — Product Library Fields Incomplete for Most Products (P1 — High)

**What Claude uses:**  
Claude's prompt pulls from: `shortName`, `tagline`, `oneliner`, `mechanism`, `benefits`, `differentiator`, `voice`, `painPoints`, `commonObjections`, `winningAngles`, `customAngles`, `competitiveEdge`, `customerAvatar`, `customerFrustration`, `customerDream`, `bigPromise`.

**What happens when these are blank:**  
Claude writes generic copy. It falls back to describing the product's basic name and price without any of the emotional resonance that makes ads convert. The copy sounds like: "Mine Bitcoin from home. $69. 100% yours." — correct but not compelling.

**Current state of the product library:**  
Unknown without a DB query, but most fields are populated only for the primary product (MinerForge Pro). Secondary products and bundles likely lack `customerAvatar`, `painPoints`, `bigPromise`, `winningAngles`.

**Fix:**  
Run a product library audit: query `product_profiles` and check null percentage per field. Build a UI nudge (yellow warning badge on the product card) for any product missing `mechanism`, `bigPromise`, `customerFrustration`, `benefits`.

---

### Issue D3 — Angle Data Often a String Not a Structured Object (P2 — Medium)

**The code:**
```js
const angleStrategySection = (() => {
  if (angleData && typeof angleData === 'object' && angleData.name) {
    // Full structured brief with lead_with, copy_directives, tone, required_elements...
  }
  // Fallback: just the name string
  return angle ? `\n\n🎯 MARKETING ANGLE FOR THIS AD: ${angle}\n` : '';
})();
```

**When the fallback fires:**  
When the user types a free-text angle rather than selecting one from the structured `winning_angles` array. Also when `angleData` is null (not passed from the client).

**Impact:**  
Claude writes copy without any creative brief. It doesn't know to lead with scam-fear, or use first-person chip voice, or emphasize "144 daily chances" specifically. The angle is just a label, not a strategy.

**Fix:**  
1. Verify the client always sends `angle_data` when a structured angle exists (check `StaticsGeneration.jsx` payload construction)
2. If the user picks an angle from the "Ad Angles" section, ensure the full angle object (with all `copy_directives`, `tone`, `required_elements`, `headline_examples`) is sent in `angle_data`
3. If using a free-text angle, do a fuzzy match against `ANGLE_SCENE_MAP` and the `winning_angles` library to hydrate it into a structured object

---

### Issue D4 — Product Image Selection Doesn't Account for Cross-Niche Templates (P2 — Medium)

**Current logic:**  
`selectBestProductImage()` picks the product image that best matches the `product_orientation` detected in the reference (e.g., "angled-right" → picks the product photo with angled-right presentation).

**Problem:**  
For a supplement ad where the product is floating against a white background, `product_orientation` = "front-facing." So we send a front-facing miner photo. But the supplement was small, centered, clean-cut on white. Our miner photo is large, complex, has ports and cables visible. The orientation match doesn't account for the visual style mismatch.

**Better criteria:**  
The image selector should consider:
- Clean cutout vs. lifestyle photo (the template's product zone style)
- Product complexity (supplement is simple cylinder → prefer clean miner render, not photo with cables)
- Background compatibility (white background template → send white-background product photo if available)

This requires a richer `selectBestProductImage()` that uses the `deep_analysis.product_analysis` fields, not just orientation.

---

### Issue D5 — Product Images Not Curated Per Product (P3 — Low)

**Current setup:**  
`product.product_images` is an array of Shopify CDN URLs. These are Shopify's auto-generated variant images — they include lifestyle shots, packaging closeups, bundle shots, angle variations. Not all are suitable as ad product hero images.

**What would help:**  
An explicit `hero_images` curated list per product (the 2–3 best images for ad use: clean front-facing render, angled hero, white-bg cutout). This is a product library UX feature, not a code fix, but it significantly impacts generation quality.

---

## CATEGORY 4: UX & SURFACE

### Issue U1 — No Visual Quality Gate on Product Identity (P1 — High)

**What exists:**  
`validateGenerationText()` — a Claude vision call that checks for misspelled text, wrong prices, fabricated offers in the generated image.

**What's missing:**  
A visual check for PRODUCT CORRECTNESS:
1. Is the reference product (supplement, food, clothing) still visible? → FAIL, regen
2. Is our miner visible as the primary product? → PASS if yes
3. Is the miner occupying at least 20% of the canvas? → FAIL if it's tiny inset

Currently a generation where the supplement is still dominant and the miner is a small inset PASSES text validation (text is correct!) but FAILS the purpose of the tool.

**Fix:**  
Extend `validateGenerationText()` or add a separate `validateProductPresence()` call that checks:
```
Is the "{product.name}" the primary/dominant product in this image? 
Is there any "{reference_product_category}" product (supplement, food item, clothing, etc.) visible?
Answer: { miner_is_dominant: true/false, reference_product_present: true/false, confidence: 0.0–1.0 }
```

If `reference_product_present = true` → regenerate (up to 2 attempts). If `miner_is_dominant = false` after 2 attempts → flag with `quality_warning: 'product not dominant'`.

---

### Issue U2 — No UI Warning When Product Has No Image (P2 — Medium)

**Current behavior:**  
If `product.product_image_url` is null and `product.product_images` is empty, Gemini receives NO product image. The pipeline warns in server logs: `"WARNING: No product image available! Gemini will hallucinate the product."` But the user sees nothing — the generation runs, Gemini invents a random device, and the result looks wrong.

**Fix:**  
In `canGenerate` or the pre-generation validation (where the `!resolvedReferenceUrl` guard was just added), add:
```js
if (!product.product_image_url && (!product.product_images || product.product_images.length === 0)) {
  setError('No product image configured. Add a product image in the Product Library before generating.');
  return;
}
```

---

### Issue U3 — No Template Difficulty Indicator in Template Selector (P2 — Medium)

**Current UX:**  
`TemplateSelectModal` shows templates by category. No indication of which templates are "easy" (same product category, simple layout) vs "hard" (cross-niche, complex layout).

**Fix:**  
Surface `deep_analysis.adaptation_instructions.product_replacement_difficulty` (easy/medium/hard) as a colored badge on each template card. Hard templates = "⚠️ Complex Swap" warning. This helps users choose templates that will succeed before wasting a generation.

---

### Issue U4 — Generation Progress Doesn't Reflect Two-Pass Work (P3 — Low)

**Current progress messages:**  
`'Building image prompt...'` → `'Generating 3 image ratio(s)...'`

With two-pass architecture, the UI needs to show:
- `'Analyzing template (Step 1 of 3)...'`
- `'Integrating your product (Step 2 of 3)...'`
- `'Applying copy & logo (Step 3 of 3)...'`

This is a UX improvement that reduces user anxiety during the longer two-pass wait.

---

### Issue U5 — Failed Generation Doesn't Surface Reason (P2 — Medium)

**Current behavior:**  
When a generation fails text validation after 3 attempts, it ships with `quality_warning`. The UI may show a warning badge, but the user doesn't know what went wrong or what to do.

**Fix:**  
Surface the specific validation failure in the card's warning:
- "Text rendering issue — prices may be wrong. Review before approving."
- "Product integration incomplete — reference product may be visible. Check image."
- "Logo not placed correctly."

Each of these tells the user the specific problem and implies the action (review, regen with different template, check logo config).

---

## Priority Implementation Order

| # | Issue | Priority | Effort | Impact |
|---|-------|----------|--------|--------|
| 1 | A1: Explicit product removal instruction in Gemini prompt | P0 | Small | Eliminates reference product bleed-through |
| 2 | P1: Product removal at top of prompt, not buried | P0 | Small | Gemini reads first rules most reliably |
| 3 | P3: Reframe "Edit" → "Use as structural template" | P0 | Tiny | Changes model's behavioral frame immediately |
| 4 | A3: Enable text overlay (STATICS_TEXT_OVERLAY=true) | P1 | Medium (testing) | Eliminates ALL text rendering errors |
| 5 | P4: Logo compositing with sharp instead of Gemini | P1 | Small | 100% reliable logo placement |
| 6 | U1: Visual quality gate for product presence | P1 | Medium | Auto-catches reference product bleed-through |
| 7 | A2: Two-pass generation for cross-niche templates | P1 | Large | Permanently fixes cross-niche product swap |
| 8 | D1: Auto-run deep_analysis on template first use | P1 | Medium | Template-specific failure mode guidance |
| 9 | P2: Visual adaptations injected with spatial ordering | P2 | Small | Gemini follows removal in order |
| 10 | D2: Product library audit + completeness nudges | P2 | Medium | Better copy quality across all products |
| 11 | D3: Always send structured angle data | P2 | Small | Full creative brief in every generation |
| 12 | U2: UI guard for missing product image | P2 | Tiny | Prevents silent hallucinations |
| 13 | U3: Template difficulty badge | P2 | Small | User self-selects appropriate templates |
| 14 | P5: Position-anchored swap pairs | P3 | Medium | Better text swap accuracy |
| 15 | D4: Richer product image selection criteria | P3 | Medium | Better visual match between template and product |
| 16 | U4: Two-pass progress messaging | P3 | Tiny | UX polish |
| 17 | U5: Specific failure reason in warnings | P3 | Small | Actionable user guidance |
| 18 | P6: Relax char count rules in text-overlay mode | P3 | Small | Better copy when overlay is on |
| 19 | D5: Curated hero_images per product | P4 | UX effort | Better starting image quality |

---

## What Should NOT Be Changed

1. **The two-stage Claude→Gemini architecture** — this is the right design. Claude does analysis + copy, Gemini does image generation. Keep this separation.
2. **The `buildClaudePrompt()` quality guardrails** — the compliance rules (no fabricated prices, no fake discounts, etc.) are correct and well-built. Keep them all.
3. **`validateGenerationText()`** — the text validator is good. Keep it, extend it with product presence checking.
4. **The `ANGLE_SCENE_MAP`** — the scene/atmosphere descriptions are good creative direction. Keep them.
5. **The `adaptedTextSanitizer`** — catches price fabrication at the sanitizer level. Keep it.
6. **The `layoutMap` auto-analysis** — good structural data. Extend it, don't replace it.

---

## Files That Will Be Modified

All changes are in-scope for the `main` / creative branch:

- `server/src/utils/staticsPrompts.js` — Issues A1, P1, P2, P3, P5, P6, P7
- `server/src/routes/staticsGeneration.js` — Issues A2, A3, A4, D1, D3, U2
- `server/src/services/geminiImageGen.js` — Issues A2 (two-pass calls)
- `server/src/utils/generationTextValidator.js` — Issue U1 (extend with product presence check)
- `client/src/pages/production/StaticsGeneration.jsx` — Issues U2, U4, U5
- `client/src/pages/production/statics/TemplateSelectModal.jsx` — Issue U3
- Render env vars — Issue A3 (`STATICS_TEXT_OVERLAY=true`)

---

## Success Criteria

A generation is considered correct when:

1. The reference product (supplement, clothing, food, etc.) is **not visible** in the output
2. The Mineblock miner is the **primary product**, occupying the product zone at the correct scale
3. All text is **correct** (right price, right discount code, right product name, no fabricated claims)
4. The **brand logo** appears as an image watermark in a corner (not a text watermark)
5. The **angle's creative strategy** is evident in the copy (not generic benefit copy)
6. The **visual atmosphere** reflects the angle's scene direction (AI Chip POV = dark circuit board; Anti-Fake = tech lab)

Items 1 and 2 are currently failing on cross-niche templates. Items 3–6 are partially working.

---

*This document is for approval only. No code changes will be made until Ludo confirms the plan.*
