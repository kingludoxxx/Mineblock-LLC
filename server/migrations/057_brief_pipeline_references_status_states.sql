-- ============================================================================
-- 057 — Widen brief_pipeline_references.status to allow new pipeline states
--
-- The Playwright-first transcription pipeline introduces granular state
-- transitions:
--   pending      → queued, not yet processing
--   extracting   → Playwright opening FB Ad Library page, looking for video
--   transcribing → video URL found, Whisper/Gemini running
--   transcribed  → done, transcript available
--   error        → exhausted all strategies (image/carousel ad or geo-block)
--
-- The original CHECK constraint only allowed (pending, transcribed). Without
-- this migration, the new pipeline throws "violates check constraint" when
-- it tries to advance status to 'extracting'.
-- ============================================================================

DO $$
DECLARE
  c_name TEXT;
BEGIN
  -- Find any existing CHECK constraint on the status column and drop it
  SELECT conname INTO c_name
    FROM pg_constraint
   WHERE conrelid = 'brief_pipeline_references'::regclass
     AND contype = 'c'
     AND pg_get_constraintdef(oid) ILIKE '%status%';
  IF c_name IS NOT NULL THEN
    EXECUTE format('ALTER TABLE brief_pipeline_references DROP CONSTRAINT %I', c_name);
  END IF;
END $$;

ALTER TABLE brief_pipeline_references
  ADD CONSTRAINT brief_pipeline_references_status_check
  CHECK (status IN ('pending', 'extracting', 'transcribing', 'transcribed', 'error'));
