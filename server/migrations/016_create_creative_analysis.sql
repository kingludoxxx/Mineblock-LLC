-- Creative Analysis: stores per-creative performance data synced from ad platforms
-- Uniquely identified by creative_id + hook_id combination

CREATE TABLE IF NOT EXISTS creative_analysis (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  ad_name TEXT NOT NULL,
  creative_id VARCHAR(20) NOT NULL,
  hook_id VARCHAR(20),
  creative_type VARCHAR(10) NOT NULL CHECK (creative_type IN ('video', 'image')),
  avatar VARCHAR(100),
  angle VARCHAR(100),
  format VARCHAR(50),
  editor VARCHAR(100),
  week_code VARCHAR(20),
  spend NUMERIC DEFAULT 0,
  revenue NUMERIC DEFAULT 0,
  roas NUMERIC DEFAULT 0,
  purchases NUMERIC DEFAULT 0,
  cpa NUMERIC DEFAULT 0,
  cpm NUMERIC DEFAULT 0,
  aov NUMERIC DEFAULT 0,
  conv_value NUMERIC DEFAULT 0,
  cpc NUMERIC DEFAULT 0,
  ctr NUMERIC DEFAULT 0,
  impressions BIGINT DEFAULT 0,
  clicks BIGINT DEFAULT 0,
  ad_status VARCHAR(20) DEFAULT 'active',
  creative_link TEXT,
  launch_date DATE,
  synced_at TIMESTAMPTZ DEFAULT NOW(),
  created_at TIMESTAMPTZ DEFAULT NOW(),
  updated_at TIMESTAMPTZ DEFAULT NOW(),
  UNIQUE(creative_id, hook_id)
);

CREATE INDEX IF NOT EXISTS idx_creative_analysis_creative_id ON creative_analysis(creative_id);
CREATE INDEX IF NOT EXISTS idx_creative_analysis_week_code ON creative_analysis(week_code);
CREATE INDEX IF NOT EXISTS idx_creative_analysis_editor ON creative_analysis(editor);
CREATE INDEX IF NOT EXISTS idx_creative_analysis_avatar ON creative_analysis(avatar);
CREATE INDEX IF NOT EXISTS idx_creative_analysis_angle ON creative_analysis(angle);
CREATE INDEX IF NOT EXISTS idx_creative_analysis_format ON creative_analysis(format);
CREATE INDEX IF NOT EXISTS idx_creative_analysis_creative_type ON creative_analysis(creative_type);
CREATE INDEX IF NOT EXISTS idx_creative_analysis_spend ON creative_analysis(spend);
CREATE INDEX IF NOT EXISTS idx_creative_analysis_ad_status ON creative_analysis(ad_status);
