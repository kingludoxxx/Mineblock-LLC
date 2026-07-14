# Batch Queue — Build Scope (v1)

Goal: select multiple League videos at once, configure product/angle/model ONCE,
queue them, walk away. Each job auto-transcribes, imports, and generates a brief.
Queue survives restarts. Failures never block the queue.

## Workflow after this ships

1. Open "Import from League" modal → CHECK multiple ads (checkbox per card, select-all-on-page)
2. The moment an ad is checked, its transcription starts in the background (prefetch —
   the transcribe endpoint has a DB cache + in-flight mutex, so double-pay is impossible)
3. Footer bar: Target Product + Ad Angle (default AUTO) + Model (default Claude) + "Queue N Briefs"
   — selections persist in localStorage
4. Queue strip above the GENERATED column shows per-job progress
   (queued → transcribing → generating → ✓ / failed+Retry); briefs land newest-first

## API contract (fixed — all workstreams build against this)

POST /api/v1/brief-pipeline/queue
  body: { items: [{ brandSpyAdId, adArchiveId, brandId, brandName, tier, headline }],
          productId, productCode, angle (string|null → null = AUTO), model ('claude'|'openai') }
  resp: { success, queued: N, skipped: [{ adArchiveId, reason }], jobs: [{ id, headline, status }] }
  Dedup: an ad with an existing queued/transcribing/generating job is skipped.

GET /api/v1/brief-pipeline/queue?include_done=true
  resp: { success, jobs: [{ id, headline, brand_name, tier, status, error, brief_id,
          reference_id, created_at, started_at, finished_at }],
          summary: { queued, running, complete, failed } }
  Default (no include_done): jobs from the last 24h OR not complete.

POST /api/v1/brief-pipeline/queue/:id/retry   → failed → queued (resp { success })
DELETE /api/v1/brief-pipeline/queue/:id       → cancel; only status='queued' cancelable
POST /api/v1/brief-pipeline/queue/clear-done  → deletes complete jobs (resp { success, cleared })

All endpoints: authenticate middleware, same error shape as the rest of briefPipeline.js.

## DB (migration 074_brief_generation_jobs.sql)

CREATE TABLE IF NOT EXISTS brief_generation_jobs (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  brand_spy_ad_id  TEXT NOT NULL,
  ad_archive_id    TEXT,
  brand_id         TEXT,
  brand_name       TEXT,
  tier             TEXT,
  headline         TEXT,
  product_id       INTEGER,
  product_code     TEXT,
  angle            TEXT,
  model            TEXT DEFAULT 'claude',
  status           TEXT NOT NULL DEFAULT 'queued', -- queued|transcribing|generating|complete|failed|canceled
  error            TEXT,
  reference_id     UUID,
  brief_id         UUID,
  attempts         INTEGER NOT NULL DEFAULT 0,
  created_at       TIMESTAMPTZ DEFAULT NOW(),
  started_at       TIMESTAMPTZ,
  finished_at      TIMESTAMPTZ
);
CREATE INDEX IF NOT EXISTS idx_bgj_status ON brief_generation_jobs (status, created_at);

## Worker (in briefPipeline.js, pattern-matched to startMediaMirrorWorker)

- startBriefQueueWorker(): setInterval every 8s; in-process `runningJobs` set; concurrency 2.
- Boot recovery: on startup, UPDATE jobs stuck in transcribing/generating → queued,
  attempts = attempts + 1. attempts > 2 → failed ('max retries after restarts').
- Per job pipeline:
  1. status='transcribing', started_at=NOW():
     ad = getAdDetail(brand_spy_ad_id) (import from ../db/brandSpyDb.js).
     If ad.transcript exists → skip to 2 (prefetch already did the work).
     Else transcribe: transcribeVideoUrl(ad.videoUrl); on failure
     extractFreshVideoUrl(adLibraryUrl(ad_archive_id)) then retry once;
     persist transcript to brand_spy.ads (same UPDATE as brandSpy.js /ads/:id/transcribe).
  2. Import reference: reuse the POST /references upsert (extract its body into
     importLeagueAdAsReference(payload) so route + worker share it; keeps the
     R2 media mirror fire-and-forget).
  3. status='generating': create MANUAL- winner row + run the SAME generation flow
     as POST /generate-from-script. Extract the route's background IIFE into
     `async function executeGenerationJob(params)` (module scope, parameterized on
     everything it closes over; route keeps calling it fire-and-forget — behavior
     identical). Worker awaits it. It must return { briefIds: [...] } and throw on
     total failure.
  4. status='complete', brief_id = first brief id, finished_at=NOW().
  Any stage failure → status='failed', error = '<stage>: <message>' (never blocks others).

## Frontend A — LeagueImportModal.jsx

- Checkbox per ad card (top-right, stopPropagation from card click); "Select all on page";
  selected count badge. Single-click preview flow unchanged.
- Prefetch: on check → api.post(`/brand-spy/ads/${ad.id}/transcribe`).catch(()=>{})
  fire-and-forget (no spinner needed; the endpoint mutex/cache make repeats safe).
- Footer bar (visible when selection > 0): ProductSelector (same component the
  ScriptGeneratorPanel uses), angle select (— AUTO — default + product angles),
  model toggle CLAUDE/OPENAI, button "Queue N Briefs".
- Queue click → POST /brief-pipeline/queue with the items array → on success close
  modal + call a new onQueued() prop so the parent shows the strip immediately.
- Persist product/angle/model in localStorage key 'briefQueueDefaults'.

## Frontend B — Queue strip (new component QueueStrip.jsx) + BriefPipeline.jsx

- Renders above the GENERATED column when there are jobs (GET /queue).
- Summary row: "N queued · N running · N done · N failed" + expand/collapse.
- Per-job row: headline (truncated), brand, status chip (color-coded), error tooltip,
  Retry button (failed), remove (queued). "Clear done" button.
- Poll GET /queue every 5s while any job is queued/transcribing/generating; stop when idle.
- When a job flips to complete → trigger the existing fetchGenerated() so the brief
  card appears without manual refresh.

## Out of scope (v2, do NOT build)

- Nightly auto-transcribe of new CHAMP/BANGER ads (spend decision — ships later behind env flag)
- Per-video angle overrides in batch
- Cross-brand auto-queue

## Acceptance criteria (must ALL pass for 10/10)

1. Select 3 untranscribed videos in the modal → transcribe calls fire on check (network tab)
2. Queue 3 with Puure/AUTO/Claude → modal closes → strip shows 3 jobs progressing
3. All 3 briefs land at the top of GENERATED with unique numbers, correct per-video source
   content, ±5% length, inside ~10 min total, zero clicks after Queue
4. A job for a dead/unavailable video fails with a readable error, the others complete,
   Retry re-runs it
5. Server restart mid-queue: stuck job re-queues on boot and completes (no zombie, no dupe)
6. Single-video flow (existing GENERATE BRIEF on a card) still works unchanged
