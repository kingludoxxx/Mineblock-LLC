-- ============================================================================
-- 054 — brief_pipeline_references: multi-source support
--
-- The Reference column on the Brief Pipeline now imports from three sources:
--   - 'league' — competitor video ads (Brand Spy → existing flow, unchanged)
--   - 'meta'   — our own active video ads pulled from Triple Whale (NEW)
--   - 'upload' — user-pasted scripts (NEW)
--
-- Source drives the CTA label ("Generate Brief" vs "Generate Iterations"),
-- the generator mode (clone vs iterate), and the badge styling on the card.
-- ============================================================================

ALTER TABLE brief_pipeline_references
  ADD COLUMN IF NOT EXISTS source            TEXT NOT NULL DEFAULT 'league',
  ADD COLUMN IF NOT EXISTS imported_metadata JSONB;

-- Wide CHECK so source rows always validate. Idempotent via DO block.
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'brief_pipeline_references_source_check'
  ) THEN
    ALTER TABLE brief_pipeline_references
      ADD CONSTRAINT brief_pipeline_references_source_check
      CHECK (source IN ('league', 'meta', 'upload'));
  END IF;
END $$;

-- Widen the tier CHECK so META + UPLOAD rows can carry a semantically correct
-- tier label ('OUR') instead of being forced to pretend they're A-tier.
DO $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'brief_pipeline_references_tier_check'
  ) THEN
    ALTER TABLE brief_pipeline_references
      DROP CONSTRAINT brief_pipeline_references_tier_check;
  END IF;
  ALTER TABLE brief_pipeline_references
    ADD CONSTRAINT brief_pipeline_references_tier_check
    CHECK (tier IN ('BANGER', 'CHAMP', 'A', 'OUR', 'UPLOAD'));
END $$;

-- The brand_id + brand_spy_ad_id FKs assume a Brand Spy row. META and UPLOAD
-- references don't have one. Drop NOT NULL so they can be NULL.
ALTER TABLE brief_pipeline_references ALTER COLUMN brand_spy_ad_id DROP NOT NULL;
ALTER TABLE brief_pipeline_references ALTER COLUMN brand_id        DROP NOT NULL;

-- Fast column-card reads by source.
CREATE INDEX IF NOT EXISTS bpr_source_idx
  ON brief_pipeline_references (source, created_at DESC);

COMMENT ON COLUMN brief_pipeline_references.source IS
  'Which import lane created this reference. Drives CTA + generator mode + badge styling.';
COMMENT ON COLUMN brief_pipeline_references.imported_metadata IS
  'Source-specific provenance. For source=meta: { ad_id, account_id, account_name, roas, spend, revenue, cpa, ctr, impressions, days_active, last_synced_at, creative_link }. For source=upload: { sourceUrl }.';
