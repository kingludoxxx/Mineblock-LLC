CREATE TABLE IF NOT EXISTS organic_images (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  image_url TEXT NOT NULL,
  r2_key TEXT,
  source TEXT NOT NULL DEFAULT 'reddit' CHECK (source IN ('reddit', 'pinterest', 'upload')),
  source_url TEXT UNIQUE,
  title TEXT,
  description TEXT,
  subreddit TEXT,
  board TEXT,
  author TEXT,
  upvotes INTEGER DEFAULT 0,
  tags JSONB DEFAULT '[]',
  tag_source TEXT DEFAULT 'auto',
  organic_score NUMERIC,
  usage_count INTEGER DEFAULT 0,
  last_used_at TIMESTAMPTZ,
  status TEXT DEFAULT 'active',
  product_id INTEGER,
  match_score NUMERIC,
  keyword_weight NUMERIC,
  scrape_keyword TEXT,
  scrape_job_id UUID,
  is_rejected BOOLEAN DEFAULT false,
  rejection_reason TEXT,
  rejected_by TEXT,
  vision_data JSONB,
  highlighted BOOLEAN DEFAULT false,
  highlight_reason TEXT,
  created_at TIMESTAMPTZ DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_organic_source ON organic_images(source);
CREATE INDEX IF NOT EXISTS idx_organic_status ON organic_images(status);
CREATE INDEX IF NOT EXISTS idx_organic_rejected ON organic_images(is_rejected);
CREATE INDEX IF NOT EXISTS idx_organic_tags ON organic_images USING GIN(tags);
