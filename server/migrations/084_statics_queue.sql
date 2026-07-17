-- 084_statics_queue.sql
-- Server-owned queue for statics generation. Replaces client-side React
-- queue state that vanished on tab close, leaving in-flight generations
-- to complete on the server but never persist to spy_creatives.
--
-- One row = one queue ITEM (containing an array of references), not one
-- row per reference. Rationale: the client already models an ITEM as "one
-- queued generation job containing N references" (StaticsGeneration.jsx:1744),
-- worker fans out to N /generate calls inside a single item, progress is
-- reported as "3/5 references done". Row-per-reference would triple write
-- volume and force us to invent a parent_item_id to reconstruct the item
-- for the UI. Row-per-item keeps the schema 1:1 with the current UI model.

CREATE TABLE IF NOT EXISTS statics_queue (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  -- queued  → not yet claimed by a worker
  -- generating → worker picked it up, pipeline running
  -- done    → all references resolved; child spy_creatives rows written
  -- error   → fatal error; details in error column
  -- cancelled → operator hit the trash icon before it started
  status TEXT NOT NULL DEFAULT 'queued'
    CHECK (status IN ('queued','generating','done','error','cancelled')),

  -- Product snapshot — captured at enqueue time so a later product-profile
  -- edit doesn't retroactively change what got queued. product_id lets the
  -- worker DB-refetch fresh profile fields at run time (mirrors /generate
  -- line 2288–2369 behaviour), product_payload is the fallback if the row
  -- was deleted between enqueue and run.
  product_id INTEGER REFERENCES product_profiles(id) ON DELETE SET NULL,
  product_name TEXT,
  product_image_index INTEGER,       -- explicit shot pick, or NULL = auto
  product_payload JSONB,             -- full item.productPayload snapshot

  -- Array of {image_url, id, name, thumbnail, source_label}. One row per
  -- ITEM (not per reference) — the worker iterates this array and calls the
  -- generation pipeline once per element, matching the current client
  -- for-loop at StaticsGeneration.jsx:1943.
  "references" JSONB NOT NULL,

  -- Angle inputs — mirror what /generate accepts.
  angle TEXT,
  angle_data JSONB,
  custom_angle TEXT,

  -- 'nanobanana' | 'openai' — same contract as spy_creatives.image_engine.
  image_engine TEXT DEFAULT 'nanobanana',

  -- Task IDs the worker allocated for progress reporting. Array of gen-*
  -- and nb-* strings, one gen- per reference plus its 3 nb- children.
  -- The GET /queue endpoint uses these to compute % complete without
  -- having to look inside taskResults for every render.
  task_ids JSONB DEFAULT '[]'::jsonb,

  -- Populated on status='done'. Shape:
  --   { creatives: [{ parent_creative_id: <uuid>, child_creative_ids: [<uuid>...] }] }
  -- One entry per reference. Lets the UI navigate directly to the finished
  -- spy_creatives rows without a JOIN.
  result JSONB,

  -- Populated on status='error'. Truncated to 2000 chars at write.
  error TEXT,

  -- Owner + ordering.
  user_id INTEGER REFERENCES users(id) ON DELETE SET NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  started_at TIMESTAMPTZ,            -- worker set NOW() on claim
  finished_at TIMESTAMPTZ,           -- worker set NOW() on done/error

  -- Progress counter — worker bumps this as each reference finishes so
  -- GET /queue returns "3/5" without needing to walk task_ids.
  refs_done INTEGER NOT NULL DEFAULT 0,
  refs_total INTEGER NOT NULL DEFAULT 0
);

-- Queue polling index. Worker's claim query is
--   SELECT ... WHERE status='queued' ORDER BY created_at LIMIT N FOR UPDATE SKIP LOCKED
-- so a partial index on status='queued' keyed by created_at is exactly right.
CREATE INDEX IF NOT EXISTS idx_statics_queue_ready
  ON statics_queue (created_at)
  WHERE status = 'queued';

-- UI list index: "give me the last 50 items for this user, newest first,
-- regardless of status".
CREATE INDEX IF NOT EXISTS idx_statics_queue_user_recent
  ON statics_queue (user_id, created_at DESC);

-- Cleanup index — a nightly cron will DELETE done/cancelled rows older
-- than 7 days so the table doesn't grow unbounded.
CREATE INDEX IF NOT EXISTS idx_statics_queue_terminal_age
  ON statics_queue (status, finished_at)
  WHERE status IN ('done','cancelled','error');
