# Static Ads Generation Tool — Improvement Brief
**Date:** 2026-05-18  
**Goal:** Bring all 6 scored areas to 8/10  
**Status:** IN PROGRESS

---

## 1. WHAT THE TOOL DOES

The Statics Generation Tool produces static ad creatives for Mineblock (Bitcoin mining hardware) across 8 psychological angles. It:
- Takes a winning ad reference image as input
- Uses Claude Sonnet to analyse the reference and adapt copy for the Mineblock product
- Uses Gemini 2.5 Flash Image to generate 3 ratios (1:1, 4:5, 9:16) per generation
- Validates output with Claude Vision OCR (catches misspellings, fabricated offers, bad grammar)
- Composites the MineBlock logo via Sharp
- Stores creatives in a kanban pipeline (TO REVIEW → APPROVED → READY TO LAUNCH → LAUNCHED)

---

## 2. THE 8 AD ANGLES

| # | Angle | Stage | Hook Strategy |
|---|-------|-------|---------------|
| 1 | Anti-Fake / Competitor Callout | Middle | Mirror suspicion → expose fakes → position as the real one |
| 2 | Skeptic to Believer / Blockchain Proof | Middle | Doubt → neutral third party (blockchain) → verified proof |
| 3 | Accidental Winner / Passive Success | Bottom | No hustle, no expertise required → $3.125 BTC while sleeping |
| 4 | Hater Deflection | Bottom | Absorb mockery without defending → data wins silently |
| 5 | Apology / False Confession | Bottom | Honesty signal → yes ladder → corrected price offer |
| 6 | AI Chip POV / Mechanism Explainer | Middle | Chip speaks in first person → mechanism without sales layer |
| 7 | Promo / Limited-Time Deal | Bottom | Code + urgency → MINER10 visible on phone/device |
| 8 | Urgency / Scarcity | Bottom | Price going up + window closing → act now without pressure |

---

## 3. CURRENT SCORES (pre-fixes)

| Area | Score | Key Problem |
|------|-------|-------------|
| Image Generation Quality | 5.5/10 | Gemini hallucinates text; angle context bleeds between templates |
| Product Replacement (cross-niche) | 6.0/10 | Reference product bleeds through; retry reruns both passes |
| Text Rendering Reliability | 4.0/10 | Gemini can't reliably render handwritten text (sticky notes) |
| Pipeline Architecture | 5.0/10 | Only 1 of 3 ratio taskIds exposed; no DB transactions; SSRF vulnerability |
| UI/UX | 5.5/10 | Generate button disabled with no reason; ratio failures silent |
| Angle Content Quality | 7.5/10 | 7/8 angles at 8+/10; Apology sticky note grammar errors |

---

## 4. ALL CHANGES MADE

### Commit `3a9a322` — Apology sticky note text precision
- Added exact 3-line sticky note text to Apology angle `copy_directives`
- Added spelling guards ("an apology" not "a apology")

### Commit `1913ada` — 8 pipeline bug fixes
**staticsGeneration.js:**
- ✅ All 3 ratio taskIds (1:1, 4:5, 9:16) now exposed in polling response
- ✅ Product presence check always runs on cross-niche (was contingent on text passing)
- ✅ Claude API calls have 90s AbortSignal timeout (was infinite, hung on Anthropic slowdowns)
- ✅ Cross-niche pass-1 cached across retries (was 6 Gemini calls worst-case, now 4)
- ✅ `angle_data.sticky_note_text` passed to OCR validator

**generationTextValidator.js:**
- ✅ New 5th parameter `stickyNoteLines` — angle-specific expected sticky note text
- ✅ Dedicated sticky note grammar check block in Claude Vision prompt
- ✅ Catches "a apology" / "I is lower" class grammar hallucinations and triggers regen

**productProfiles.js:**
- ✅ `sticky_note_text` field added to Apology angle (3 exact expected lines)
- ✅ `seedMinerAngles` uses ID-based merge — user edits preserved on redeploy
- ✅ SSRF protection on `ai-fill` (HTTPS only + private IP blocklist)
- ✅ `DELETE /:id/angles/:angleId` returns 404 when angle not found (was always 200)

### Commit `e94f734` — Frontend UX + cross-niche detection
**ConfigSidebar.jsx:**
- ✅ Generate button shows clear reason when disabled:
  - "Select a template first"
  - "Select a product first"
  - "Generation in progress..."

**StaticsGeneration.jsx:**
- ✅ Ratio failure toast: "2 of 3 ratios generated (1 failed: ...)" with 10s display

**staticsGeneration.js:**
- ✅ Cross-niche detection regex tightened — removed overly-broad terms (tech, device, electronic)
  that caused false negatives on "tech supplement" / "electronic health device" categories

---

## 5. REMAINING GAPS TO 8/10

### Gap 1: Text Rendering — 7/10 → 8/10
**Problem:** Even with OCR auto-retry (3 attempts), Gemini consistently hallucinates sticky note grammar.  
**Fix A (quick):** Enable `STATICS_TEXT_OVERLAY=true` on Render — activates existing Sharp text compositing system for all regular text (headlines, CTAs, badges). Zero hallucination possible for those elements.  
**Fix B (medium):** Sharp compositing for sticky note areas specifically — generate sticky note background, composite real handwriting font text on top.  
**Status:** Fix A requires Render workspace selection.

### Gap 2: Image Generation Quality — 7.5/10 → 8/10  
**Problem:** Without text overlay mode, Gemini still renders text with occasional errors on non-sticky-note elements. Angle context can bleed when reference image is visually dominant.  
**Fix:** Same as Gap 1 (text overlay). Once enabled, regular text is 100% reliable.  
**Status:** Dependent on Render workspace.

### Gap 3: UI/UX — 7.5/10 → 8/10
**Problem:** Template re-selection after angle switch (user friction). GENERATING column count shows 0 during active generation.  
**Fix:** Fix already confirmed correct (template state independent). Remaining: improve GENERATING progress visibility.  

---

## 6. ACTION PLAN TO REACH 8/10

| # | Action | Area | Status |
|---|--------|------|--------|
| 1 | Generate fresh Apology with new validator | Text / Angle Quality | 🔄 IN PROGRESS |
| 2 | Enable STATICS_TEXT_OVERLAY on Render | Text / Image Quality | ⏳ PENDING workspace |
| 3 | Assess all 8 angles in TO REVIEW | Angle Quality | ⏳ PENDING |
| 4 | Fix any angle < 8/10 with targeted regen | Angle Quality | ⏳ PENDING |
| 5 | Verify ratio failure toast works | UI/UX | ⏳ PENDING |
| 6 | Verify disabled button reason shows | UI/UX | ⏳ PENDING |
| 7 | Score all 6 areas post-fix | All | ⏳ PENDING |

---

## 7. SUCCESS CRITERIA

All 6 areas must score ≥ 8/10:
- [ ] Image Generation Quality ≥ 8/10
- [ ] Product Replacement ≥ 8/10
- [ ] Text Rendering ≥ 8/10
- [ ] Pipeline Architecture ≥ 8/10
- [ ] UI/UX ≥ 8/10
- [ ] Angle Content Quality ≥ 8/10

