-- ============================================================================
-- 053 — Consolidate spy_creatives schema migrations out of the cold-start path
--
-- ensureCreativesTable() in staticsGeneration.js was running ~30 ALTER TABLE
-- statements + index creates + two regex-based backfills on every first
-- request after a server restart. First /generate after a redeploy paid 3-8s.
--
-- This migration is the authoritative source for those ALTER/INDEX/UPDATE
-- statements. ensureCreativesTable() now only guarantees the cheap idempotent
-- CREATE TABLE IF NOT EXISTS skeleton.
--
-- Every statement in this file is idempotent and safe to re-run.
-- ============================================================================

-- ── Columns ────────────────────────────────────────────────────────────────
ALTER TABLE spy_creatives ADD COLUMN IF NOT EXISTS product_name TEXT;
ALTER TABLE spy_creatives ADD COLUMN IF NOT EXISTS reference_thumbnail TEXT;
ALTER TABLE spy_creatives ADD COLUMN IF NOT EXISTS reference_name TEXT;
ALTER TABLE spy_creatives ADD COLUMN IF NOT EXISTS copy_set_id UUID;
ALTER TABLE spy_creatives ADD COLUMN IF NOT EXISTS meta_ad_ids JSONB DEFAULT '[]';
ALTER TABLE spy_creatives ADD COLUMN IF NOT EXISTS meta_image_hash TEXT;
ALTER TABLE spy_creatives ADD COLUMN IF NOT EXISTS generated_copy JSONB;
ALTER TABLE spy_creatives ADD COLUMN IF NOT EXISTS parent_creative_id_ref TEXT;
ALTER TABLE spy_creatives ADD COLUMN IF NOT EXISTS parent_im_number INTEGER;
ALTER TABLE spy_creatives ADD COLUMN IF NOT EXISTS im_number INTEGER;
ALTER TABLE spy_creatives ADD COLUMN IF NOT EXISTS iteration_change_description TEXT;
ALTER TABLE spy_creatives ADD COLUMN IF NOT EXISTS quality_warning TEXT;
ALTER TABLE spy_creatives ADD COLUMN IF NOT EXISTS imported_from TEXT;
ALTER TABLE spy_creatives ADD COLUMN IF NOT EXISTS imported_metadata JSONB;
ALTER TABLE spy_creatives ADD COLUMN IF NOT EXISTS is_reference BOOLEAN DEFAULT FALSE;
ALTER TABLE spy_creatives ADD COLUMN IF NOT EXISTS external_ref_key TEXT;
ALTER TABLE spy_creatives ADD COLUMN IF NOT EXISTS group_id UUID;

-- Reference rows have no owning product yet — already dropped in migration 051,
-- but harmless to assert here in case ensureCreativesTable was the first to set it.
ALTER TABLE spy_creatives ALTER COLUMN product_id DROP NOT NULL;

-- creative_analysis is owned by the analytics worktree but statics writes
-- iterated_at when an iteration is spawned.
ALTER TABLE creative_analysis ADD COLUMN IF NOT EXISTS iterated_at TIMESTAMPTZ;

-- ── Indexes ────────────────────────────────────────────────────────────────
CREATE INDEX IF NOT EXISTS idx_spy_creatives_pipeline ON spy_creatives(pipeline);
CREATE INDEX IF NOT EXISTS idx_spy_creatives_status ON spy_creatives(status);
CREATE INDEX IF NOT EXISTS idx_spy_creatives_product_id ON spy_creatives(product_id);
CREATE INDEX IF NOT EXISTS idx_spy_creatives_created ON spy_creatives(created_at DESC);
CREATE INDEX IF NOT EXISTS idx_spy_creatives_parent_id ON spy_creatives(parent_creative_id);
CREATE INDEX IF NOT EXISTS idx_spy_creatives_parent_ref ON spy_creatives(parent_creative_id_ref);
CREATE INDEX IF NOT EXISTS idx_spy_creatives_reference
  ON spy_creatives (is_reference, imported_from, created_at DESC)
  WHERE is_reference;
CREATE INDEX IF NOT EXISTS idx_spy_creatives_external_ref_key
  ON spy_creatives (imported_from, external_ref_key)
  WHERE external_ref_key IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_spy_creatives_group_id ON spy_creatives(group_id);
CREATE UNIQUE INDEX IF NOT EXISTS idx_spy_creatives_im_number
  ON spy_creatives(im_number) WHERE im_number IS NOT NULL;

-- ── Backfills (idempotent: WHERE col IS NULL guard) ────────────────────────
-- These were running on every cold-start. They're cheap once the columns
-- exist but redundant after the first run; the WHERE guards make them no-ops.
UPDATE spy_creatives
   SET external_ref_key = SUBSTRING(imported_metadata::text FROM '"ad_archive_id":\s*"([^"]+)"')
 WHERE imported_from = 'league' AND external_ref_key IS NULL;

UPDATE spy_creatives
   SET external_ref_key = SUBSTRING(imported_metadata::text FROM '"meta_ad_id":\s*"([^"]+)"')
 WHERE imported_from = 'meta' AND external_ref_key IS NULL;
