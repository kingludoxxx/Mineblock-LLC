# BRIEF — Broken Previews Forever-Fix

> Handoff brief. Everything under **Verified findings** was confirmed by reading
> the code and querying the live production API on 2026-07-17. Line numbers were
> accurate at time of writing — trust the code over this doc if they disagree.

---

## 0. TL;DR

The tool re-invents this bug every few weeks because the ROOT is unaddressed:
**the codebase stores raw `fbcdn.net` / `scontent-*.xx.fbcdn.net` URLs
in `spy_creatives`**. Every previous fix (`/repair-thumbnails`,
`/repair-volatile-urls`, `Repair Broken` button, `selfHealCreative`)
is a **rescue after the fact** — none of them stop the ingress side from
producing new broken rows.

Fix at the source: **mirror to R2 at ingest, always. Only R2/durable URLs
ever land in `spy_creatives`.** Then repair endpoints have nothing to do,
because the table can't be poisoned.

Recurring bug ends. Not "we'll deal with it next time." **Ends.**

---

## 1. Verified findings (with file:line)

### 🔴 A. Layer-A allowlist is wrong — the guard that was supposed to stop volatile writes actively LETS fbcdn through

`server/src/routes/staticsGeneration.js:47-51`:
```js
const STABLE_URL_PATTERNS = [
  /\.r2\.dev[\/]/i,
  /\.r2\.cloudflarestorage\.com[\/]/i,
  /\.fbcdn\.net[\/]/i,   // ← LIE
];
```

The header comment at `:43-44` **documents** the false premise: *"fbcdn.net
is treated as stable because Meta's ad-library URLs are pinned by the Graph
API repair path."* The Graph API repair path requires `meta_ad_id` and
`meta_image_hash` — **League/Brand-Spy imports have neither**, so nothing
repairs them.

Every other codebase comment agrees FBCDN is volatile:
- `server/src/db/brandSpyDb.js:413` — "fbcdn expires ~2-4 weeks after scrape"
- `server/src/services/brandSpyMediaMirror.js:8` — "403 ~2-4 weeks after scrape"
- `server/src/routes/briefPipeline.js:6014` — same
- `server/src/routes/briefPipeline.js:6020` — the CORRECT denylist regex:
  `const VOLATILE_MEDIA_RE = /\bfbcdn\.net\b|\bfbsbx\.com\b|\bscontent[^/]*\.xx\b/i;`

Live evidence from today: a reference imported **6 days ago** already 403s.

### 🔴 B. Seven ingress sites store raw fbcdn URLs — ranked by weekly bleed rate

1. **League auto-sync cron** — `staticsGeneration.js:7054-7067`. Runs on `auto_sync_interval_hours`. Every followed brand re-imports FBCDN URLs continuously. Writes to 3 columns (`image_url`, `thumbnail_url`, `reference_thumbnail`).
2. **League manual import** — `staticsGeneration.js:6640-6653`. Same shape, operator-triggered, bulk. Writes 3 columns.
3. **Meta launch overwrite** — `staticsGeneration.js:4936-4939`. Every time a generated creative is launched, the returned Meta preview URL (fbcdn) **overwrites** the previously-stable R2 URL. Silent R2→FBCDN downgrade on every launch.
4. **Meta / Triple Whale import** — `staticsGeneration.js:8260-8272`. Same shape as League. 3 columns.
5. **Iteration `reference_thumbnail`** — `staticsGeneration.js:3027-3042`. Every iteration child row inherits `parent.thumbnail_url` (fbcdn) as its `reference_thumbnail`. 5 rows per iterate call.
6. **`/repair-thumbnails` volatile fallback** — `staticsGeneration.js:5501-5514`. When R2 upload fails, writes raw fbcdn as "better than nothing." Rare but persists.
7. **`/meta-ads/repair-thumbnails`** — `staticsGeneration.js:8134-8151`. Writes fresh fbcdn back to `creative_analysis.thumbnail_url` **without mirroring**. Bug in miniature.

### 🔴 C. Post-facto rescue endpoints IGNORE fbcdn

- `DOOMED_CDN_PATTERNS` at `staticsGeneration.js:1116-1122` — kie.ai / aiquickdraw / tempfile only. No fbcdn.
- `/repair-volatile-urls` at `staticsGeneration.js:5871-5876` — same.
- `backsyncDoomedUrls` at `:1156-1196` filters `is_reference=FALSE` only — misses every League/Meta reference row.

So the periodic sweeper CAN'T see fbcdn URLs, and even if it could, it skips references.

### ✅ D. The correct pattern already exists elsewhere

`briefPipeline.js:6029-6057` — `mirrorMediaUrlToR2(url, keyPrefix, kind)`:
- Streams bytes with a running size cap (15 MB image / 80 MB video — respects Render's 512 MB instance limit)
- `AbortSignal.timeout(120s)` on fetch
- Rejects on suspiciously small responses (`< 1KB`)
- Auto-detects content-type + extension
- Returns permanent R2 URL

Reuse this. `persistAnyUrlToR2` at `staticsGeneration.js:1129-1153` is a
simpler variant already in this file — good enough for image ingress.

### 🟡 E. Frontend shows the mistakes as bare black squares

`PipelineView.jsx:302, 471, 753` — every img `onError` sets `display='none'`.
No "Broken" badge, no retry button, no state update after self-heal
completes. Operator can't distinguish "loading" from "gone forever."

`LibraryView.jsx:113, 329` — no `onError` at all → browser's default
broken-image glyph.

---

## 2. The fix (in ship order)

### Phase 1 — kill the ingress leak (backend)

1. **Flip fbcdn from "stable" to "volatile"** in the Layer-A guard.
   Remove line `:50` from `STABLE_URL_PATTERNS`. Add `fbcdn.net`, `fbsbx.com`,
   `scontent*.xx` to `VOLATILE_URL_PATTERNS`. Add the same 3 patterns to
   `DOOMED_CDN_PATTERNS` (LIKE-syntax).
2. **Mirror at import time — League bulk (`:6640`), League auto-sync (`:7054`), Meta import (`:8260`).**
   Wrap each URL through `persistAnyUrlToR2` **before** the INSERT. If mirroring
   fails, insert the row with `image_url=NULL` and `status='rejected'`. Do NOT
   store the raw fbcdn URL, ever. The Guard from Phase-1.1 now enforces this.
3. **Iteration `reference_thumbnail` mirror** — same treatment at `:3027`.
4. **Meta launch guard** — at `staticsGeneration.js:4936`, if the row already has
   an R2 `image_url`, do NOT overwrite it with the Meta return URL. Store the
   Meta return URL only in a new column (or `meta_image_hash`) — never on top
   of the stable R2 URL.
5. **Fix `/meta-ads/repair-thumbnails` fbcdn fallback** at `:8134-8151` — wrap
   `newThumb` in `persistAnyUrlToR2` before UPDATE.
6. **Expand `backsyncDoomedUrls`** to also scan `is_reference=TRUE` rows, and
   include the new fbcdn patterns. This one-shot heals the historical backlog
   the next time the sweeper fires.

### Phase 2 — frontend UX

7. **Shared `<CreativeImage>` component** with 3 states: `loading` (spinner),
   `loaded` (image), `error` (dark tile + red `AlertCircle` "Broken" badge + a
   small `RefreshCw` retry button). Replace every bare `<img>` in the audited
   files.
8. **Self-heal returns the new URL** — server side, `/regenerate-broken-previews`
   currently returns `{queued: N}`. Add `{healedUrls: {id → freshUrl}}` for
   inline patches. Frontend `selfHealCreative` batches ids, gets back the map,
   applies it via `onHealed(id, freshUrl)` prop → parent state update → no page
   refresh required.
9. **Per-card manual retry** hits `POST /statics-generation/references/:id/refresh`
   (new endpoint) — bypasses batch, gets a fresh URL right now.

### Phase 3 — defense in depth

10. **Render cron** `repair-media-daily` @ `render.yaml` (shared coordination file
    — coordinate before edit): POSTs to `/repair-volatile-urls` and
    `/repair-thumbnails` daily with `X-Cron-Secret`. Even if a future ingress
    bug slips through, the cron catches it within 24h.
11. **Assertion in `POST /creatives`** — when the caller passes an fbcdn URL,
    log the STACK TRACE so the offending code path is obvious. Prevents future
    regressions from silently re-poisoning the table.

---

## 3. Definition of done (multi-brief standard)

- [ ] Layer A guard rejects fbcdn writes on POST /creatives (log-verified)
- [ ] League bulk import stores R2 URLs only (query `SELECT COUNT(*) FROM spy_creatives WHERE is_reference AND image_url LIKE '%fbcdn%'` returns 0 after next import)
- [ ] League auto-sync stores R2 URLs only (same query 24h later)
- [ ] Meta launch never overwrites R2 with fbcdn (query launched creatives — every image_url is r2.dev)
- [ ] Backsync sweeper heals references too (backlog count trends to 0 over 48h)
- [ ] Frontend `<CreativeImage>` shows Broken badge + retry (visual verify)
- [ ] Self-heal patches state in-place (broken card auto-updates without refresh)
- [ ] MinerForge/Puure generations unaffected (regression check)

---

## 4. Gotchas

- **`briefPipeline.js` is in the Creative worktree** but touching it may cross-purpose; treat as read-only reference.
- **`render.yaml` is a shared-coordination file** — Phase 3 cron addition needs operator sign-off before editing.
- **Meta CDN 24-48h claim from the code** is wrong; live evidence shows fresh (6d) imports already 403. Some URLs die within days; treat every fbcdn URL as needing immediate mirror.
- **Size cap enforcement** — `mirrorMediaUrlToR2` in briefPipeline caps at 15MB (image) / 80MB (video). Static-ad images are almost always <2MB but keep the cap; a runaway response would OOM the 512MB Render instance.
- **`is_reference=TRUE` rows** — historical rescue endpoints skipped these. New sweeper MUST include them.
</content>
</invoke>