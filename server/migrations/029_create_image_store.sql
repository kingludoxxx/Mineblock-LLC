-- 029: Persistent image store for generated statics when R2 is not configured
-- Replaces volatile in-memory temp image storage that died on server restarts

CREATE TABLE IF NOT EXISTS image_store (
  id TEXT PRIMARY KEY,
  data BYTEA NOT NULL,
  content_type TEXT NOT NULL DEFAULT 'image/png',
  created_at TIMESTAMPTZ DEFAULT NOW()
);

-- Index for cleanup of old images (images older than 30 days can be pruned)
CREATE INDEX IF NOT EXISTS idx_image_store_created ON image_store(created_at);
