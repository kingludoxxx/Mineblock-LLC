-- Brief launcher: a brief launches as a VIDEO ad (VSLs up to ~5 min) when the
-- editor's finished video URL is attached; text/link ad otherwise.
ALTER TABLE brief_pipeline_generated ADD COLUMN IF NOT EXISTS video_url TEXT;
