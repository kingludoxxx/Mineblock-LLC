-- Reset all brief_pipeline_winners back to 'detected' status
-- They were set to 'selected' during testing
UPDATE brief_pipeline_winners SET status = 'detected' WHERE status IN ('selected', 'generating');
