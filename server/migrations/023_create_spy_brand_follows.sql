CREATE TABLE IF NOT EXISTS spy_brand_follows (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  product_id INTEGER REFERENCES product_profiles(id) ON DELETE SET NULL,
  brand_name TEXT NOT NULL,
  meta_page_id TEXT,
  ad_library_url TEXT,
  top_n INTEGER DEFAULT 20,
  pipeline_type TEXT DEFAULT 'standard',
  auto_sync BOOLEAN DEFAULT false,
  last_synced_at TIMESTAMPTZ,
  sync_status TEXT DEFAULT 'idle',
  images_collected INTEGER DEFAULT 0,
  created_at TIMESTAMPTZ DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_brand_follows_product ON spy_brand_follows(product_id);
