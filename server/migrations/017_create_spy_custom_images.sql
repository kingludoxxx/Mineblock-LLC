CREATE TABLE IF NOT EXISTS spy_custom_images (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  product_id INTEGER NOT NULL REFERENCES product_profiles(id) ON DELETE CASCADE,
  image_url TEXT NOT NULL,
  r2_key TEXT,
  source TEXT DEFAULT 'upload',
  source_url TEXT,
  label TEXT,
  tags JSONB DEFAULT '[]',
  status TEXT DEFAULT 'active',
  archived_at TIMESTAMPTZ,
  meta_ad_id TEXT,
  brand_follow_id UUID,
  created_at TIMESTAMPTZ DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_spy_custom_images_product ON spy_custom_images(product_id);
CREATE INDEX IF NOT EXISTS idx_spy_custom_images_status ON spy_custom_images(status);
