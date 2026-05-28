-- ============================================================================
-- 052 — brief_pipeline_references
--
-- Holds competitor video ads imported from The League (brand_spy) as
-- pre-generation reference material for the Brief Pipeline. These are NOT
-- generated briefs — they are the source material a user selects before
-- triggering a Clone or Variants generation.
-- ============================================================================

CREATE TABLE IF NOT EXISTS brief_pipeline_references (
  id                   UUID         PRIMARY KEY DEFAULT gen_random_uuid(),
  brand_spy_ad_id      UUID         NOT NULL REFERENCES brand_spy.ads(id) ON DELETE CASCADE,
  ad_archive_id        TEXT         NOT NULL,
  brand_id             UUID         NOT NULL REFERENCES brand_spy.brands(id) ON DELETE CASCADE,
  brand_name           TEXT         NOT NULL,
  tier                 TEXT         NOT NULL,
  video_url            TEXT,
  thumbnail_url        TEXT,
  headline             TEXT,
  body_text            TEXT,
  transcript           TEXT,
  transcript_at        TIMESTAMPTZ,
  status               TEXT         NOT NULL DEFAULT 'pending',
  generated_brief_id   UUID         REFERENCES brief_pipeline_generated(id) ON DELETE SET NULL,
  created_at           TIMESTAMPTZ  NOT NULL DEFAULT NOW(),
  updated_at           TIMESTAMPTZ  NOT NULL DEFAULT NOW()
);

-- CHECK constraints via DO blocks so the migration is idempotent across re-runs
-- (ALTER TABLE...ADD CONSTRAINT doesn't support IF NOT EXISTS).
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'brief_pipeline_references_tier_check'
  ) THEN
    ALTER TABLE brief_pipeline_references
      ADD CONSTRAINT brief_pipeline_references_tier_check
      CHECK (tier IN ('BANGER', 'CHAMP', 'A'));
  END IF;
END $$;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'brief_pipeline_references_status_check'
  ) THEN
    ALTER TABLE brief_pipeline_references
      ADD CONSTRAINT brief_pipeline_references_status_check
      CHECK (status IN ('pending', 'transcribed', 'used'));
  END IF;
END $$;

-- Dedup: one reference per Meta ad_archive_id (re-importing the same ad
-- updates the existing row rather than creating a duplicate).
CREATE UNIQUE INDEX IF NOT EXISTS brief_pipeline_references_ad_archive_id_uidx
  ON brief_pipeline_references (ad_archive_id);

-- Column list reads for the Reference column.
CREATE INDEX IF NOT EXISTS brief_pipeline_references_status_idx
  ON brief_pipeline_references (status, created_at DESC);

-- Per-brand / per-tier lookups inside the League import modal.
CREATE INDEX IF NOT EXISTS brief_pipeline_references_brand_idx
  ON brief_pipeline_references (brand_id, tier, created_at DESC);

-- updated_at trigger — keeps the column fresh on any row mutation.
CREATE OR REPLACE FUNCTION brief_pipeline_references_set_updated_at()
RETURNS TRIGGER AS $$
BEGIN
  NEW.updated_at = NOW();
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS brief_pipeline_references_set_updated_at ON brief_pipeline_references;
CREATE TRIGGER brief_pipeline_references_set_updated_at
  BEFORE UPDATE ON brief_pipeline_references
  FOR EACH ROW
  EXECUTE FUNCTION brief_pipeline_references_set_updated_at();
