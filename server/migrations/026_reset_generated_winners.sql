-- Reset winners with 'generated' status back to 'detected'
-- These were advanced during testing and should start fresh
UPDATE brief_pipeline_winners SET status = 'detected' WHERE status = 'generated';

-- Also clean up test-generated briefs so the pipeline is fresh
DELETE FROM brief_pipeline_generated WHERE status = 'pushed';
