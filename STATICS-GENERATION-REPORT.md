# Statics Generation Pipeline — Gemini 3.1 Upgrade Report

**Date:** April 5, 2026
**Previous report:** April 4 (NanoBanana testing, 35+ images)
**Commits:** 494e395 (Gemini integration), 36ef5cf (retry logic), 89a7a76 (bleed-through fix)
**Total Gemini tests:** 28 image generations across 4 batches
**Model:** `gemini-3.1-flash-image-preview` via Google Generative Language API

---

## Executive Summary

Switched the image generation backend from NanoBanana (`google/nano-banana-edit` via kie.ai) to Gemini 3.1 Flash Image (direct Google API). Average quality jumped from **6.5/10 to 8.9/10**. Text rendering is now near-perfect — zero misspellings across 28 tests. The comparison template (hardest test) went from 4/10 to 8-9/10.

---

## Architecture Change

### Before (NanoBanana)
```
Reference Image → Claude Sonnet (analysis) → buildSwapPairs() → buildNanoBananaPrompt()
→ POST kie.ai/api (async, image URLs) → poll for result → download
```

### After (Gemini 3.1)
```
Reference Image → Claude Sonnet (analysis) → buildSwapPairs() → buildNanoBananaPrompt()
→ fetch all images as base64 → POST generativelanguage.googleapis.com (sync, inline_data)
→ upload to R2 → store result in geminiResults Map → client polls /status
```

Key difference: Gemini accepts multimodal input (base64 images + text) and returns the image synchronously. We bridge to the existing async polling client by storing completed results in an in-memory Map with 15-min TTL.

NanoBanana is kept as automatic fallback if Gemini fails.

---

## Quality Comparison: Gemini 3.1 vs NanoBanana

### Simple Templates (4-5 swaps)

| Template | NanoBanana | Gemini 3.1 | Key Difference |
|----------|-----------|-----------|----------------|
| Stack promo (4545) | 9/10 | 9.5/10 | Both good; Gemini text slightly crisper |
| Stat layout (1598) | 7/10 | 9/10 | NB: "Blockshain" → Gemini: "Blockchain" |

### Medium Templates (6-7 swaps)

| Template | NanoBanana | Gemini 3.1 | Key Difference |
|----------|-----------|-----------|----------------|
| Trustpilot (1983) | 6-7/10 | 9/10 | NB: garbled bullet text → Gemini: all perfect |
| Notes layout (4408) | 6-7/10 | 9.5/10 | NB: "diitcphing" → Gemini: "ditching" |
| Mars hero (4361) | 6/10 | 8.5/10 | NB: added extra text → Gemini: clean layout |
| Urgency (3865) | not tested | 8.5/10 | Problem/solution layout worked well |

### Complex Templates (12-13 swaps)

| Template | NanoBanana | Gemini 3.1 | Key Difference |
|----------|-----------|-----------|----------------|
| Comparison (3732) | 4/10 | 8.5/10 | NB: "hair regrowth", "DHT" bleed → Gemini: 100% mining text |

### Summary
- **NanoBanana average:** 6.5/10
- **Gemini 3.1 average:** 8.9/10
- **Improvement:** +37% quality score

---

## Text Rendering Quality

The #1 problem with NanoBanana was random text corruption:
- "BITTOIN" instead of "BITCOIN"
- "diitcphing" instead of "ditching"
- "Blockshain" instead of "Blockchain"
- "VETALIZED" instead of "VITALIZED"
- "COMPLIDATED" instead of "COMPLICATED"

Gemini 3.1 Flash Image had **zero misspellings** across 28 test generations. This is the single biggest quality improvement.

---

## Aspect Ratio Support

All three tested ratios work correctly:
- **4:5** (Instagram/Facebook feed): Primary format, all tests pass
- **1:1** (Square): Tested with stack and stat templates, both excellent
- **9:16** (Stories/Reels): Tested with Mars hero, beautiful vertical layout

---

## Reference Bleed-Through Fix

The comparison template was leaking reference product text (e.g. "The future of hair Regrowth" from a hair supplement reference appearing in the mining ad). Fixed by adding a self-check rule to Claude's prompt:

> Rule #7: Re-read EVERY adapted_text. Does ANY text mention the REFERENCE product's industry, features, or terminology instead of the NEW product's?

After fix: 3/3 comparison template tests had **zero reference bleed**.

---

## Rate Limiting & Reliability

### Problem
Gemini 3.1 Flash Image has per-minute rate limits. Rapid successive calls triggered 429 errors, causing silent fallback to NanoBanana.

### Fix
Added retry with exponential backoff:
- 429 errors: retry after 10s, 20s, 40s (up to 3 retries)
- 5xx errors: retry after 6s, 12s, 24s
- Timeout increased from 2min to 3min
- MAX_CONCURRENT reduced from 3 to 2

### Result
Final batch: 6/6 via Gemini with no fallbacks.

---

## Speed

Average generation time per image:
- **NanoBanana:** 45-90s (async, variable queue time)
- **Gemini 3.1:** 35-55s (synchronous, no queue)

Gemini is slightly faster on average, but the real win is consistency — no random 5-minute waits.

---

## Brian's Creative Analysis System Comparison

Analyzed Brian's (ForgeMen) complete system from `creative-analysis-system.md`. Our Mineblock implementation has **full feature parity**:

| Feature | Brian's (ForgeMen) | Ours (Mineblock) | Status |
|---------|--------------------|--------------------|--------|
| Data source | Triple Whale SQL API | Triple Whale SQL API | Identical |
| Ad name parser | Right-to-left week anchoring | Right-to-left week anchoring | Identical |
| Auto-sync | Every 5 minutes | Every 5 minutes | Identical |
| History backfill | Past 12 weeks | Past 12 weeks | Identical |
| Meta thumbnail sync | Every 30 minutes | Every 30 minutes | Identical |
| Custom date range | /data-by-date (queries TW directly) | /data-by-date (queries TW directly) | Identical |
| Daily granularity | /creative-daily | /creative-daily | Identical |
| Leaderboard | Top ROAS/Purchases/CPA, min $200 | Top ROAS/Purchases/CPA, min $200 | Identical |
| Lifetime metrics | Per-creative weekly breakdown | Per-creative weekly breakdown | Identical |
| Rising Stars | $50-$500 spend, ROAS >= 1.0 | $50-$500 spend, ROAS >= 1.0 | Identical |
| New Winners | First seen current week, ROAS >= 1.5 | First seen current week, ROAS >= 1.5 | Identical |
| Video modal | Thumbnail + video playback | Thumbnail + video playback | Identical |
| Column reordering | Drag-and-drop, localStorage | Drag-and-drop, localStorage | Identical |
| Detail panel | Daily breakdown with date range | Daily breakdown with date range | Identical |

**Conclusion:** Brian shared his implementation with us — it's the same system we already have. No gaps to fill.

---

## Production Readiness

### What's ready now
- Simple templates (4-5 swaps): 9.5/10 — ship it
- Medium templates (6-7 swaps): 9/10 — ship it
- Comparison templates (12-13 swaps): 8.5/10 — ship with review
- All aspect ratios (4:5, 1:1, 9:16): tested and working
- Retry logic: handles rate limits gracefully
- NanoBanana fallback: automatic if Gemini fails

### Remaining considerations
1. **Gemini rate limits** — If generating many images simultaneously (e.g. batch generation for a campaign), may need to throttle or queue
2. **Cost** — Gemini 3.1 Flash Image is pay-per-use via Google Cloud billing. Monitor costs as usage scales
3. **Country restrictions** — Some Gemini models have geographic restrictions. The 3.1 Flash Image model works from Render's Oregon region
