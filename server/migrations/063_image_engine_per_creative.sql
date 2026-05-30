-- Per-creative image-engine tracking.
-- Each spy_creatives row remembers which engine ('nanobanana' | 'openai')
-- generated it so refines / regenerates use the same engine — no cross-
-- engine style drift. Existing rows default to 'nanobanana' (the only
-- engine in production before this migration).
ALTER TABLE spy_creatives
  ADD COLUMN IF NOT EXISTS image_engine TEXT NOT NULL DEFAULT 'nanobanana';

CREATE INDEX IF NOT EXISTS idx_spy_creatives_image_engine
  ON spy_creatives (image_engine);
