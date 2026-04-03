-- Launch Templates: stores reusable ad launch configurations
CREATE TABLE IF NOT EXISTS launch_templates (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  name TEXT NOT NULL,
  ad_account_id TEXT NOT NULL,
  ad_account_name TEXT,
  -- Facebook Pages (round-robin or single)
  page_mode TEXT DEFAULT 'single' CHECK (page_mode IN ('single', 'round_robin')),
  page_ids JSONB DEFAULT '[]',  -- [{id, name, selected}]
  -- Pixel
  pixel_id TEXT,
  pixel_name TEXT,
  -- Campaign / Ad Set
  campaign_id TEXT,
  campaign_name TEXT,
  -- Naming Conventions
  adset_name_pattern TEXT DEFAULT '{date} - {angle} - Batch {batch}',
  ad_name_pattern TEXT DEFAULT '{date} - {angle} {num}',
  -- Conversion
  conversion_location TEXT DEFAULT 'WEBSITE',
  conversion_event TEXT DEFAULT 'PURCHASE',
  -- Budget & Bid
  daily_budget NUMERIC(10,2) DEFAULT 150,
  performance_goal TEXT DEFAULT 'OFFSITE_CONVERSIONS',
  optimization_goal TEXT DEFAULT 'OFFSITE_CONVERSIONS',
  bid_strategy TEXT DEFAULT 'LOWEST_COST_WITHOUT_CAP',
  target_roas NUMERIC(6,2),
  -- Attribution
  attribution_window TEXT DEFAULT '7d_click',
  -- Audience
  include_audiences JSONB DEFAULT '[]',  -- [{id, name}]
  exclude_audiences JSONB DEFAULT '[]',  -- [{id, name}]
  countries JSONB DEFAULT '["US"]',
  age_min INTEGER DEFAULT 18,
  age_max INTEGER DEFAULT 65,
  gender TEXT DEFAULT 'all' CHECK (gender IN ('all', 'male', 'female')),
  -- Ad Format
  ad_format TEXT DEFAULT 'FLEXIBLE',
  -- UTM
  utm_parameters TEXT DEFAULT 'tw_source={{site_source_name}}&tw_adid={{ad.id}}',
  -- Translation Languages
  translation_languages JSONB DEFAULT '[]',  -- ["Spanish", "French", etc.]
  -- Product association
  product_id INTEGER REFERENCES product_profiles(id),
  -- Metadata
  is_default BOOLEAN DEFAULT false,
  created_by UUID REFERENCES users(id),
  created_at TIMESTAMPTZ DEFAULT NOW(),
  updated_at TIMESTAMPTZ DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_launch_templates_product ON launch_templates(product_id);

-- Ad Copy Sets: stores ad copy organized by angle per product
CREATE TABLE IF NOT EXISTS brief_copy_sets (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  product_id INTEGER REFERENCES product_profiles(id) ON DELETE CASCADE,
  angle TEXT NOT NULL,
  -- Copy arrays (flexible ad format supports up to 20 of each)
  primary_texts JSONB DEFAULT '[]',   -- ["text1", "text2", ...]
  headlines JSONB DEFAULT '[]',       -- ["headline1", ...]
  descriptions JSONB DEFAULT '[]',    -- ["desc1", ...]
  -- CTA & URL
  cta_button TEXT DEFAULT 'SHOP_NOW',
  landing_page_url TEXT,
  utm_parameters TEXT DEFAULT 'tw_source={{site_source_name}}&tw_adid={{ad.id}}',
  -- Metadata
  created_by UUID REFERENCES users(id),
  created_at TIMESTAMPTZ DEFAULT NOW(),
  updated_at TIMESTAMPTZ DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_copy_sets_product ON brief_copy_sets(product_id);
CREATE UNIQUE INDEX IF NOT EXISTS idx_copy_sets_product_angle ON brief_copy_sets(product_id, angle);

-- Brief launch tracking: links generated briefs to Meta ad launches
CREATE TABLE IF NOT EXISTS brief_launches (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  brief_id UUID REFERENCES brief_pipeline_generated(id) ON DELETE SET NULL,
  template_id UUID REFERENCES launch_templates(id) ON DELETE SET NULL,
  copy_set_id UUID REFERENCES brief_copy_sets(id) ON DELETE SET NULL,
  -- Meta IDs
  ad_account_id TEXT,
  meta_campaign_id TEXT,
  meta_adset_id TEXT,
  meta_ad_id TEXT,
  meta_creative_id TEXT,
  -- Launch details
  ad_name TEXT,
  adset_name TEXT,
  page_id TEXT,
  page_name TEXT,
  batch_number INTEGER,
  -- Status
  status TEXT DEFAULT 'pending' CHECK (status IN ('pending', 'uploading', 'creating_adset', 'creating_ad', 'launched', 'failed')),
  error_message TEXT,
  launched_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_brief_launches_brief ON brief_launches(brief_id);
CREATE INDEX IF NOT EXISTS idx_brief_launches_template ON brief_launches(template_id);
CREATE INDEX IF NOT EXISTS idx_brief_launches_status ON brief_launches(status);

-- Add launch-related columns to brief_pipeline_generated
ALTER TABLE brief_pipeline_generated ADD COLUMN IF NOT EXISTS launch_template_id UUID REFERENCES launch_templates(id);
ALTER TABLE brief_pipeline_generated ADD COLUMN IF NOT EXISTS copy_set_id UUID REFERENCES brief_copy_sets(id);
ALTER TABLE brief_pipeline_generated ADD COLUMN IF NOT EXISTS launched_at TIMESTAMPTZ;
ALTER TABLE brief_pipeline_generated ADD COLUMN IF NOT EXISTS launch_error TEXT;
ALTER TABLE brief_pipeline_generated ADD COLUMN IF NOT EXISTS meta_ad_ids JSONB DEFAULT '[]';

-- Update status check to include new statuses
-- Note: Postgres doesn't support ALTER CHECK, so we just allow the new statuses at application level
-- Status values: generated, approved, rejected, pushed, ready_to_launch, launching, launched, launch_failed
