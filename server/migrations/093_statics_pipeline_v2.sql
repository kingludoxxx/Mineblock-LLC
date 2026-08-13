-- ─────────────────────────────────────────────────────────────────────────────
-- 093_statics_pipeline_v2 — Static Ads pipeline restructure
--
-- New column model:
--   ITERATIONS → COMPOSER → TO GENERATE → TO REVIEW → READY TO LAUNCH → LAUNCHED
--
-- This migration adds only what the new columns need. Everything is additive and
-- idempotent; no existing row changes meaning.
--
--   1. spy_creatives.status gains 'composer'   (the new first-class stage)
--   2. composer provenance columns             (how a card entered Composer)
--   3. statics_composer_imports                (async .zip import jobs)
--   4. statics_iteration_configs               (per-ad-account Iterations filters)
--   5. creative_analysis.account_id            (lets Iterations filter by account)
-- ─────────────────────────────────────────────────────────────────────────────

-- ── 1. status CHECK ──────────────────────────────────────────────────────────
-- Migration 018 declared CHECK (status IN ('generating','review','approved',
-- 'queued','launched','rejected','archived')) — a set that never included
-- 'ready', even though migration 051 started writing 'ready' and the app has
-- written it ever since. That only works because the constraint is not actually
-- enforcing on this database (018 used CREATE TABLE IF NOT EXISTS against an
-- already-existing table). Rather than leave that landmine for whoever adds the
-- next status, make it explicit — but refuse to add a constraint that existing
-- data would violate, and say so instead of failing the boot.
ALTER TABLE spy_creatives DROP CONSTRAINT IF EXISTS spy_creatives_status_check;

DO $$
DECLARE
  offending TEXT;
BEGIN
  SELECT string_agg(DISTINCT status, ', ')
    INTO offending
    FROM spy_creatives
   WHERE status IS NOT NULL
     AND status NOT IN ('generating','composer','review','ready','queued',
                        'launching','launched','rejected','archived');

  IF offending IS NULL THEN
    ALTER TABLE spy_creatives
      ADD CONSTRAINT spy_creatives_status_check
      CHECK (status IS NULL OR status IN (
        'generating','composer','review','ready','queued',
        'launching','launched','rejected','archived'
      ));
    RAISE NOTICE '093: spy_creatives_status_check added (composer included)';
  ELSE
    -- Legacy values exist (most likely 'approved'). Leave them alone — silently
    -- rewriting operator data is worse than an absent constraint — and leave the
    -- constraint off so the boot succeeds. Statuses are still validated in the
    -- route layer (validStatuses in staticsGeneration.js).
    RAISE NOTICE '093: status CHECK NOT added — unexpected status values present: %', offending;
  END IF;
END $$;

-- ── 2. Composer provenance ───────────────────────────────────────────────────
-- A Composer card is a static that already exists as pixels (designed elsewhere,
-- e.g. a batch exported from Claude Design) rather than something this tool
-- generated. Knowing HOW it arrived is what lets the UI badge it correctly and
-- lets a bad import be undone as a unit.
ALTER TABLE spy_creatives ADD COLUMN IF NOT EXISTS composer_source TEXT;
ALTER TABLE spy_creatives ADD COLUMN IF NOT EXISTS composer_import_id UUID;
ALTER TABLE spy_creatives ADD COLUMN IF NOT EXISTS composer_prompt TEXT;

COMMENT ON COLUMN spy_creatives.composer_source IS
  'How this card entered Composer: zip | describe | manual. NULL = not a Composer card.';
COMMENT ON COLUMN spy_creatives.composer_import_id IS
  'Groups every card from one .zip upload so the batch can be reviewed or deleted together.';
COMMENT ON COLUMN spy_creatives.composer_prompt IS
  'The prompt shipped alongside the image (prompts/<name>.txt or manifest.csv prompt column).';

CREATE INDEX IF NOT EXISTS idx_spy_creatives_composer
  ON spy_creatives (status, composer_import_id)
  WHERE status = 'composer';

-- ── 3. Composer .zip import jobs ─────────────────────────────────────────────
-- Uploads are processed asynchronously: a 50-static zip cannot be parsed inside
-- Cloudflare's ~100s edge timeout, so the endpoint returns a job id and the
-- client polls. Same pattern as /admin-pgdump-data-copy.
CREATE TABLE IF NOT EXISTS statics_composer_imports (
  id             UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  status         TEXT NOT NULL DEFAULT 'processing'
                 CHECK (status IN ('processing','done','error')),
  filename       TEXT,
  bytes          BIGINT,
  product_id     INTEGER REFERENCES product_profiles(id) ON DELETE SET NULL,
  user_id        UUID,
  total_files    INTEGER NOT NULL DEFAULT 0,
  imported_count INTEGER NOT NULL DEFAULT 0,
  skipped_count  INTEGER NOT NULL DEFAULT 0,
  -- Per-file outcomes, including WHY each skip happened. An import that drops
  -- 12 of 50 files must be able to say which 12 and why.
  report         JSONB,
  error          TEXT,
  created_at     TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  finished_at    TIMESTAMPTZ
);

CREATE INDEX IF NOT EXISTS idx_composer_imports_recent
  ON statics_composer_imports (created_at DESC);

-- ── 4. Per-ad-account Iterations config ──────────────────────────────────────
-- Mirrors league_brand_configs (per-brand import prefs) so the two config
-- surfaces behave the same way. One row per Meta ad account the operator adds
-- in the Iterations Config modal.
CREATE TABLE IF NOT EXISTS statics_iteration_configs (
  account_id      TEXT PRIMARY KEY,
  -- NULL = no limit. Word count, NOT characters — see the note below.
  max_copy_words  INTEGER,
  min_spend       NUMERIC NOT NULL DEFAULT 500,
  -- NULL = All Time. Otherwise a lookback window in days (30/60/90/180/365).
  date_range_days INTEGER,
  -- Which Meta ad states to surface. Defaults match the reference UI.
  ad_statuses     TEXT[] NOT NULL DEFAULT ARRAY['active','paused']::TEXT[],
  enabled         BOOLEAN NOT NULL DEFAULT TRUE,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at      TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- NOTE ON UNITS: league_brand_configs.max_copy_length is compared against
-- length(headline)+length(body_text)+length(caption) — i.e. CHARACTERS — while
-- every UI label for it reads "words". "200 words" there actually means 200
-- characters (~30 words), filtering far harder than the operator intends. That
-- legacy behaviour is deliberately left untouched here so import volumes do not
-- shift underneath anyone; this new column is words, and is named so it cannot
-- be confused with the old one.
COMMENT ON COLUMN statics_iteration_configs.max_copy_words IS
  'Max ad-copy WORD count (whitespace-delimited). NULL = no limit. Distinct from the legacy character-based league_brand_configs.max_copy_length.';

-- ── 5. Ad-account attribution for Iterations ─────────────────────────────────
-- creative_analysis carries meta_ad_id but no account_id, so Iterations cannot
-- currently filter by ad account. Added nullable and additive: the Meta sync can
-- start populating it whenever the Ads lane wires it up, and until then NULL is
-- treated as "unknown", never as "excluded" — an empty column must not silently
-- hide every row.
ALTER TABLE creative_analysis ADD COLUMN IF NOT EXISTS account_id TEXT;

CREATE INDEX IF NOT EXISTS idx_creative_analysis_account
  ON creative_analysis (account_id, synced_at DESC);

COMMENT ON COLUMN creative_analysis.account_id IS
  'Meta ad account this row belongs to. NULL = not yet attributed; Iterations treats NULL as unknown and does not filter it out.';

-- The Iterations Config modal exposes a MAX COPY WORDS filter, but there was no
-- ad-copy column on this table at all, so the control had nothing to filter.
-- Added on the same terms as account_id: nullable, populated by the Meta sync
-- when the Ads lane wires it up, and NULL means "not measured" — never
-- "violates the limit". A filter that silently drops every unmeasured row would
-- empty the column and read as "no winners".
ALTER TABLE creative_analysis ADD COLUMN IF NOT EXISTS ad_copy TEXT;

COMMENT ON COLUMN creative_analysis.ad_copy IS
  'Primary ad copy as served on Meta. NULL = not captured by the sync yet; the MAX COPY WORDS filter skips (does not exclude) NULL rows and reports how many it could not measure.';
