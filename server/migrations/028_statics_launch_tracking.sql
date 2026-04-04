-- 028: Add launch tracking columns to spy_creatives + statics_launches audit table

-- New columns on spy_creatives for launch integration
ALTER TABLE spy_creatives ADD COLUMN IF NOT EXISTS copy_set_id UUID REFERENCES brief_copy_sets(id) ON DELETE SET NULL;
ALTER TABLE spy_creatives ADD COLUMN IF NOT EXISTS meta_ad_ids JSONB DEFAULT '[]';
ALTER TABLE spy_creatives ADD COLUMN IF NOT EXISTS meta_image_hash TEXT;
ALTER TABLE spy_creatives ADD COLUMN IF NOT EXISTS generated_copy JSONB;

CREATE INDEX IF NOT EXISTS idx_spy_creatives_copy_set ON spy_creatives(copy_set_id);

-- Audit log for statics launches (mirrors brief_launches pattern)
CREATE TABLE IF NOT EXISTS statics_launches (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  creative_id UUID REFERENCES spy_creatives(id) ON DELETE CASCADE,
  template_id UUID,
  copy_set_id UUID,
  ad_account_id TEXT,
  meta_campaign_id TEXT,
  meta_adset_id TEXT,
  meta_ad_id TEXT,
  meta_creative_id TEXT,
  meta_image_hash TEXT,
  ad_name TEXT,
  adset_name TEXT,
  page_id TEXT,
  page_name TEXT,
  batch_number INTEGER,
  status TEXT DEFAULT 'pending' CHECK (status IN ('pending', 'uploading', 'launched', 'failed')),
  error_message TEXT,
  launched_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_statics_launches_creative ON statics_launches(creative_id);
CREATE INDEX IF NOT EXISTS idx_statics_launches_status ON statics_launches(status);
