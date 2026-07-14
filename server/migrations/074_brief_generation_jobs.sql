-- Batch Queue: persistent job queue for "select N League ads → auto
-- transcribe → import → generate brief" (see BATCH_QUEUE_SCOPE.md).
-- The queue must survive restarts, so jobs live in Postgres, not memory.
-- Worker: startBriefQueueWorker() in server/src/routes/briefPipeline.js.

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
