-- ============================================================================
-- 051 — Reference pipeline: remove 'approved' bucket + add reference imports
--
-- The Statics pipeline now jumps Review → Ready directly. The "approved"
-- bucket is being deprecated. Any existing rows in that bucket are promoted
-- to 'ready' so they don't disappear from the UI.
--
-- Three new columns track imported reference creatives from the League
-- (Brand Spy) and Meta (Triple Whale / creative_analysis) sources.
-- ============================================================================

-- 1. Promote any existing 'approved' rows to 'ready'.
UPDATE spy_creatives SET status = 'ready' WHERE status = 'approved';

-- 2. Add imported_from with a CHECK constraint. ALTER TABLE...ADD CONSTRAINT
-- doesn't support IF NOT EXISTS, so we add the column with the CHECK in a
-- DO block that's safe to re-run.
ALTER TABLE spy_creatives ADD COLUMN IF NOT EXISTS imported_from TEXT;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'spy_creatives_imported_from_check'
  ) THEN
    ALTER TABLE spy_creatives
      ADD CONSTRAINT spy_creatives_imported_from_check
      CHECK (imported_from IS NULL OR imported_from IN ('league', 'meta', 'upload'));
  END IF;
END $$;

-- 3. Per-import provenance JSON (ad_archive_id, brand_id, tier, etc).
ALTER TABLE spy_creatives ADD COLUMN IF NOT EXISTS imported_metadata JSONB;

-- 4. Reference creatives are picked from the Reference column when
-- generating new ads — they are NOT regular pipeline cards.
ALTER TABLE spy_creatives ADD COLUMN IF NOT EXISTS is_reference BOOLEAN DEFAULT FALSE;

-- 5. Partial index for fast Reference column reads.
CREATE INDEX IF NOT EXISTS idx_spy_creatives_reference
  ON spy_creatives (is_reference, imported_from, created_at DESC)
  WHERE is_reference;

-- 6. Reference rows have no owning product yet (the user assigns one when
-- generating from a reference) — drop the NOT NULL on product_id so the
-- League/Meta INSERTs don't crash.
ALTER TABLE spy_creatives ALTER COLUMN product_id DROP NOT NULL;

-- 7. Dedicated dedup column. postgres.js returns JSONB via `unsafe()` as a
-- string scalar, so `imported_metadata->>'ad_archive_id'` returns NULL — a
-- top-level text column dodges the whole quoting/escaping problem.
ALTER TABLE spy_creatives ADD COLUMN IF NOT EXISTS external_ref_key TEXT;
CREATE INDEX IF NOT EXISTS idx_spy_creatives_external_ref_key
  ON spy_creatives (imported_from, external_ref_key)
  WHERE external_ref_key IS NOT NULL;

-- Backfill external_ref_key from imported_metadata for any rows imported
-- before this column existed. Substring extraction works whether the JSONB
-- is stored as an object or a string scalar (postgres.js quirk).
UPDATE spy_creatives
SET external_ref_key = SUBSTRING(imported_metadata::text FROM '"ad_archive_id":\s*"([^"]+)"')
WHERE imported_from = 'league' AND external_ref_key IS NULL;

UPDATE spy_creatives
SET external_ref_key = SUBSTRING(imported_metadata::text FROM '"meta_ad_id":\s*"([^"]+)"')
WHERE imported_from = 'meta' AND external_ref_key IS NULL;
