CREATE TABLE IF NOT EXISTS ad_batches (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  product_id INTEGER NOT NULL REFERENCES product_profiles(id) ON DELETE CASCADE,
  pipeline TEXT NOT NULL DEFAULT 'standard' CHECK (pipeline IN ('standard', 'advertorial')),
  name TEXT,
  angle TEXT,
  batch_size INTEGER DEFAULT 6,
  status TEXT DEFAULT 'assembling' CHECK (status IN ('assembling', 'ready', 'launching', 'launched', 'failed')),
  meta_campaign_id TEXT,
  meta_adset_id TEXT,
  launch_config JSONB DEFAULT '{}',
  launched_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ DEFAULT NOW(),
  updated_at TIMESTAMPTZ DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_ad_batches_product ON ad_batches(product_id);
CREATE INDEX IF NOT EXISTS idx_ad_batches_status ON ad_batches(status);

CREATE TABLE IF NOT EXISTS ad_launches (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  batch_id UUID REFERENCES ad_batches(id) ON DELETE CASCADE,
  creative_id UUID REFERENCES spy_creatives(id) ON DELETE SET NULL,
  copy_id UUID REFERENCES advertorial_copies(id) ON DELETE SET NULL,
  meta_ad_id TEXT,
  meta_creative_id TEXT,
  status TEXT DEFAULT 'pending' CHECK (status IN ('pending', 'uploading', 'launched', 'failed')),
  error_message TEXT,
  launched_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_launches_batch ON ad_launches(batch_id);
CREATE INDEX IF NOT EXISTS idx_launches_creative ON ad_launches(creative_id);
