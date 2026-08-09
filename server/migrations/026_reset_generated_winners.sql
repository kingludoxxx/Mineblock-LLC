-- Reset winners with 'generated' status back to 'detected'
-- These were advanced during testing and should start fresh
--
-- Guarded for the same reason as 025: brief_pipeline_winners and
-- brief_pipeline_generated are created lazily by routes/briefPipeline.js
-- (ensureTables on first request), never by a migration. On a FRESH database
-- these statements threw and halted the whole migration run, so every later
-- migration silently never applied. With no table there are no rows to reset.
DO $$
BEGIN
  IF to_regclass('public.brief_pipeline_winners') IS NOT NULL THEN
    UPDATE brief_pipeline_winners SET status = 'detected' WHERE status = 'generated';
  END IF;

  -- Also clean up test-generated briefs so the pipeline is fresh
  IF to_regclass('public.brief_pipeline_generated') IS NOT NULL THEN
    DELETE FROM brief_pipeline_generated WHERE status = 'pushed';
  END IF;
END $$;
