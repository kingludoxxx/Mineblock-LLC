-- Migration 044: add INTERRUPTED to brand_spy.scrape_jobs status constraint
-- Required for graceful-shutdown handling: when a deploy kills an in-flight scrape,
-- the job is marked INTERRUPTED (not ERROR) so boot recovery knows to re-queue it.

ALTER TABLE brand_spy.scrape_jobs
  DROP CONSTRAINT IF EXISTS scrape_jobs_status_check;

ALTER TABLE brand_spy.scrape_jobs
  ADD CONSTRAINT scrape_jobs_status_check
  CHECK (status IN ('QUEUED', 'RUNNING', 'DONE', 'ERROR', 'INTERRUPTED'));
