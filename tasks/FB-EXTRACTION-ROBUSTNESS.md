# Scope: Make FB Ad Library → script extraction reliable "forever"

## Symptom
Pasting a Facebook Ad Library link (`/ads/library/?id=<id>`) into the Brief Pipeline
Script Generator fails with:
> Could not extract ad 101960915447968. This is a video ad that requires transcription…

## Root cause (diagnosed from code — local repro blocked by wrong-arch Chromium)
The transcription flow in `server/src/routes/briefPipeline.js` (~line 2242) tries, in order:
1. **yt-dlp** (`extractVideoUrlWithYtdlp`) → Gemini transcription
2. **Meta ads_archive API** (`extractFromMetaAdId`)
3. …then throws the error above.

Both are weak for a single-ad `?id=` page:
- **yt-dlp** frequently can't resolve `/ads/library/?id=` (it's not a standard video page).
- **Meta ads_archive** only returns ads that are in the public archive queryable by our token
  (largely political/issue ads) and rarely returns a usable media URL.

Meanwhile the codebase ALREADY has a more reliable method that is **not wired into this path**:
- `services/fbAdLibraryExtractor.js` → `extractVideoUrlFromAdLibrary()` opens the page in
  headless Chromium and intercepts the `.mp4` CDN response directly.
- The brand-spy scraper already stores `video_hd_url` for League ads in `brand_spy.ads`.

So no single method is 100% (FB changes constantly) — the fix is a **layered fallback chain,
most-reliable-first**, so when one layer fails another catches it.

## The permanent fix (layers, most reliable → last resort)
- **L0 — Reuse already-scraped media.** If the `ad_archive_id` exists in `brand_spy.ads`,
  use its stored `video_hd_url`/`video_sd_url`. Instant, reliable, FB-change-proof.
- **L1 — Playwright network interception** (`extractVideoUrlFromAdLibrary`, hardened): the
  primary live method. Improvements needed (see below).
- **L2 — yt-dlp** (existing).
- **L3 — Meta ads_archive API** (existing).
- **L4 — Clear manual-paste fallback** (existing): paste the `.mp4` or the script text.
- Diagnostics: the final error must say WHICH layers ran and why each failed.

### Hardening `extractVideoUrlFromAdLibrary` (why it can still return null today)
1. It only **passively** waits for a `.mp4` request — FB Ad Library videos usually fetch the
   `.mp4` only once the player **plays**. Fix: scroll the video into view + `video.play()` /
   click the play control to force the request.
2. It **blocks stylesheets**, which can break player init. Fix: block only images + fonts.
3. Timeouts are short (12s nav / 10s poll). Fix: 20s each.
4. No **cookie/consent wall** handling. Fix: dismiss the consent dialog before polling.
5. Also read `document.querySelector('video').currentSrc` as a DOM fallback.

## Implementation order
1. [x] Harden `extractVideoUrlFromAdLibrary` (playback trigger, keep CSS, consent, timeouts).
2. [x] Insert L1 (Playwright) into the transcription chain BEFORE the final throw.
3. [ ] L0 brand-spy media reuse (needs `brand_spy.ads` lookup by ad_archive_id in the flow).
4. [ ] Layered diagnostics in the final error message.

## Verification
FB extraction can't be verified from the dev box (no Mac Chromium). Verification = operator
retries the SAME link after deploy. If it still fails, the server log now names the failed
layer, which points at the next fix. Not "fixed" until a real paste succeeds.
