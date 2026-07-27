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
- **C. Auto-create/link a reference for the pasted ad.** When a URL is pasted (no
  referenceId), upsert a `brief_pipeline_references` row for that `ad_archive_id` from the
  brand-spy record (video_hd_url, headline, thumbnail, source_url) and link the winner to
  it — so the Source Reference shows the CORRECT pasted ad's video, every time.
- **D. Actually use the video; make any downgrade VISIBLE.** Investigate why L0's
  `transcribeWithGemini(brandSpyVideoUrl)` failed and fell to metadata. Prefer the video
  transcript; if we must fall back to ad-copy text, stamp the brief (a flag/note) so the
  operator sees "text-only, no video" instead of a silent downgrade.

## Verification bar
Paste the link → the card's Source Reference shows the SAME ad you pasted, and the brief is
built from the video transcript (not a 756-char blurb). I can verify A/B/C logic locally,
but the video-transcription path (D) has no runtime on the dev box — operator paste is the
final test. NOT "fixed" until a real paste shows the right video and a video-based script.
