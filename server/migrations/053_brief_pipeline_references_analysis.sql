-- ============================================================================
-- 053 — brief_pipeline_references: add analysis cache
--
-- When the user clicks "Use as Reference" on a Reference card, the analysis
-- page sends the whole video to Gemini for a comprehensive structural,
-- visual, and persuasion-engine breakdown. The result is cached on the row
-- so navigating back to the page is instant; a "Re-analyze" button lets the
-- user force a fresh run.
-- ============================================================================

ALTER TABLE brief_pipeline_references
  ADD COLUMN IF NOT EXISTS analysis        JSONB,
  ADD COLUMN IF NOT EXISTS analyzed_at     TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS analysis_model  TEXT,
  ADD COLUMN IF NOT EXISTS analysis_error  TEXT;

COMMENT ON COLUMN brief_pipeline_references.analysis IS
  'Gemini whole-video analysis output (see brief-pipeline analyzer for schema).';
COMMENT ON COLUMN brief_pipeline_references.analyzed_at IS
  'UTC timestamp of the latest successful analysis. NULL = never analyzed.';
COMMENT ON COLUMN brief_pipeline_references.analysis_model IS
  'Gemini model that produced the analysis (e.g. gemini-2.0-flash-001).';
COMMENT ON COLUMN brief_pipeline_references.analysis_error IS
  'Last error message if the latest attempt failed. NULL on success.';
