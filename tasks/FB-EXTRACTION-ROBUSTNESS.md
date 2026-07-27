# Serious brief: FB Ad Library → script extraction. Fix once for all.

## Status: my first fix was shipped BLIND and did not verifiably help. Restart with rigor.

## What we KNOW (confirmed from code + logs)
- The failing action = Script Generator "Video URL" paste + Generate → `POST /generate-from-script`
  → `extractScriptFromUrl(url)` (briefPipeline.js:2196) → Strategy 1 (FB Ad Library branch, 2200-2288).
- The exact error the operator sees is thrown at **line 2286** (only place with that wording).
- To reach 2286, execution passes through every step above it, incl. my "Step 3.5" Playwright
  call at 2266. So the wiring IS on the right path.
- Strategy 1's ladder: metadata (yt-dlp) → audio (yt-dlp) → video (yt-dlp) → **Playwright .mp4
  interception** → Meta ads_archive API → throw.

## What we DON'T know (the blockers that made me fix blind)
1. **No repro on the dev box.** The only Chromium here is the Linux build (for Render); it won't
   run on Mac. So I cannot execute the extractor or verify any fix locally.
2. **No DB access from dev box** (prod Postgres IP-locked). Can't inspect brand_spy.ads.
3. **Logs of the actual attempt are inconclusive** — the window is flooded by the `[bs-mirror]`
   cron, and I never saw an `fbExtractor` extraction line for the operator's retry. Either the
   retry was outside the window I pulled, or the frontend showed a stale (pre-deploy) error.

## Why FB extraction is hard "forever"
FB Ad Library is hostile to headless scraping: consent/login walls, bot detection, and video
served via blob/MSE. yt-dlp usually can't resolve `?id=` pages; the Meta API only covers
political/issue ads. No single live method is reliable.

## The real "forever" answer (reliability-first)
- **L0 — Reuse already-scraped media.** brand-spy ALREADY captures these followed brands'
  videos (the `[bs-mirror]` logs prove it is actively pulling sculpiflex/mydermadream/seranova
  video URLs). Look up `brand_spy.ads` by `ad_archive_id` and transcribe the stored
  `video_hd_url`/`video_sd_url`. Bypasses FB's bot fight entirely for any followed-brand ad
  (the common case). ← primary fix.
- **L1 — Playwright interception** (already wired; keep as fallback).
- **L2/L3 — yt-dlp / Meta API** (existing).
- **L4 — manual paste** (existing).

## Do THIS (in order), then stop and get proof
1. [ ] **L0 brand-spy media reuse** as the first step in Strategy 1.
2. [ ] **Per-layer instrumentation**: a `diag[]` breadcrumb logged on failure + folded into the
   thrown error, so the NEXT attempt names the exact failing layer. No more fixing blind.
3. [ ] Deploy. Operator retries ONCE. Read the instrumented log → either it worked (L0/L1) or the
   log states precisely which layer failed and why → one targeted final fix.

## Verification bar (non-negotiable)
NOT "fixed" until a real paste of an Ad Library link returns a transcript in the tool. Because I
can't run Chromium or the DB here, the operator's single retry IS the test — but this time the
system self-reports which layer failed, so the loop closes in one pass instead of guessing.
