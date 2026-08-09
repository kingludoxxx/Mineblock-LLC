-- Reset all brief_pipeline_winners back to 'detected' status
-- They were set to 'selected' during testing
-- Guarded: brief_pipeline_winners is created lazily by routes/briefPipeline.js
-- (ensureTables on first request), never by a migration. On a FRESH database
-- this statement threw, and because server.js swallowed the failure the whole
-- migration run stopped at 25/93 — every later migration (incl. the orders /
-- customers / funnels / checkout permission grants) silently never applied, and
-- seeds never ran, leaving a dashboard with zero roles and zero users while the
-- health check still reported healthy. A no-op here is correct: with no table
-- there are no rows to reset.
DO $$
BEGIN
  IF to_regclass('public.brief_pipeline_winners') IS NOT NULL THEN
    UPDATE brief_pipeline_winners SET status = 'detected' WHERE status IN ('selected', 'generating');
  END IF;
END $$;
