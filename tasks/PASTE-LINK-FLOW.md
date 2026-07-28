# Scope: make "paste a Facebook Ad Library link → generate" work every time

## Symptom (operator report)
Paste an Ad Library link in the Video URL box → generate. Two failures seen:
1. It errored instantly ("Could not extract ad <page_id>").
2. After that was fixed, the generated card showed the **wrong reference video** (a
   different competitor ad than the one pasted), and the brief was built from ad-copy
   text, not the video.

## Root causes (each confirmed from code + prod logs this session)
1. **[FIXED] Wrong ad id parsed.** Greedy `/.*id=(\d+)/` grabbed the LAST `id=` in the
   URL → `view_all_page_id` (the page), not the ad. Fixed: parse `id` param, canonical URL.
2. **[FIXED] Wrong reference linked.** `ScriptGeneratorPanel` sent `appliedReferenceId`
   (a stale id from a previously-clicked reference card) even in URL mode, so the winner
   linked to the wrong reference → wrong Source Reference video. Fixed: URL mode sends
   `referenceId: null`.
3. **[OPEN] Pasted URL creates no reference row.** With referenceId null, the winner's
   `reference_id` is null, so the Source Reference panel shows NOTHING (or a stale value)
   instead of the correct video of the ad that was pasted.
4. **[OPEN] Video silently downgraded to ad-copy text.** Logs: `L0 brand-spy media hit —
   transcribing stored video` → then `Got ad copy from metadata (756 chars), using as
   script reference`. The video transcription FAILED and it fell back to 756 chars of
   ad text — silently. Operator thinks they cloned the video; they cloned a blurb.

## The fix (once for all)
- **A. [DONE] id parse + canonical URL.**
- **B. [DONE] URL mode never sends a stale referenceId.**
- **C. [DONE + VERIFIED LIVE] Auto-create/link a reference for the pasted ad.** The upsert
  code was there but crashed on THREE separate schema mismatches, each surfaced by a live
  paste and fixed in turn (commits b6fee98, 2f5c25e, 6bd5b07):
    1. `SELECT brand_name FROM brand_spy.ads` — no such column; brand name is
       `brand_spy.brands.display_name`. Now `LEFT JOIN brands`, `COALESCE(display_name, domain)`.
    2. `brief_pipeline_references.brand_name` is NOT NULL but display_name can be null →
       violated the not-null constraint. `importLeagueAdAsReference` now coalesces to 'Unknown'.
    3. `tier` CHECK allows only BANGER/CHAMP/A/OUR/UPLOAD, but brand_spy tiers include
       B/C/MID/TEST → violated the check. Now normalized to 'A' when out of set.
  Verified: run at 19:52Z created `ref c4dfa0f9…` (R2 mirror of the pasted ad's video +
  thumbnail), NO upsert error. The card's ORIGINAL SCRIPT is the pasted ad's transcript.
- **D. [DONE + VERIFIED LIVE] Actually use the video.** Root cause was NOT the video — it was
  a dead Gemini model list: `transcribeWithGemini` tried `gemini-2.0-flash-001` +
  `gemini-1.5-flash`, both 404 on the generativelanguage API, so every paste fell back to
  yt-dlp ad-copy (756 chars). Two defects fixed (commit b6fee98): (1) model list →
  `gemini-2.5-flash` → `2.0-flash` → `flash-latest`; (2) the retry loop did `break` on a 404,
  which abandoned the whole ladder (jumped to next key) — changed to `continue`. Same pair
  fixed in `analyzeWholeVideoWithGemini`. Verified: `Transcription complete with
  gemini-2.5-flash: 1101 chars`, brief built from the transcript, not the blurb.

## Verification bar — MET (2026-07-27, live paste of id=1576753040701353 via operator browser)
Pasting the link → the card is built from the 1101-char VIDEO transcript (not a 756-char
blurb), the reference row for the pasted ad is created (ref c4dfa0f9, video+thumb mirrored
to R2), and the logs show zero errors on the whole path. Confirmed by driving the operator's
authenticated browser + reading prod logs across five successive deploy-and-retest cycles.
