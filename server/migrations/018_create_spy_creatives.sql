CREATE TABLE IF NOT EXISTS spy_creatives (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  product_id INTEGER NOT NULL REFERENCES product_profiles(id) ON DELETE CASCADE,
  pipeline TEXT NOT NULL DEFAULT 'standard' CHECK (pipeline IN ('standard', 'advertorial')),
  reference_image_id UUID REFERENCES spy_custom_images(id) ON DELETE SET NULL,
  advertorial_copy_id UUID,
  image_url TEXT,
  r2_key TEXT,
  thumbnail_url TEXT,
  source_label TEXT,
  claude_analysis JSONB,
  adapted_text JSONB,
  swap_pairs JSONB,
  generation_prompt TEXT,
  generation_provider TEXT DEFAULT 'nanobanana',
  generation_model TEXT,
  generation_task_id TEXT,
  angle TEXT,
  archetype TEXT CHECK (archetype IN ('MIRROR', 'MYTHIC', 'LEGACY', 'HORIZON', NULL)),
  aspect_ratio TEXT DEFAULT '4:5',
  group_id UUID,
  parent_creative_id UUID,
  generation INTEGER DEFAULT 1,
  status TEXT DEFAULT 'review' CHECK (status IN ('generating', 'review', 'approved', 'queued', 'launched', 'rejected', 'archived')),
  batch_id UUID,
  batch_position INTEGER,
  review_notes TEXT,
  is_organic BOOLEAN DEFAULT false,
  feedback_action TEXT,
  feedback_reason TEXT,
  feedback_tags JSONB,
  created_at TIMESTAMPTZ DEFAULT NOW(),
  updated_at TIMESTAMPTZ DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_spy_creatives_product ON spy_creatives(product_id);
CREATE INDEX IF NOT EXISTS idx_spy_creatives_status ON spy_creatives(status);
CREATE INDEX IF NOT EXISTS idx_spy_creatives_pipeline ON spy_creatives(pipeline);
CREATE INDEX IF NOT EXISTS idx_spy_creatives_batch ON spy_creatives(batch_id);
CREATE INDEX IF NOT EXISTS idx_spy_creatives_angle ON spy_creatives(angle);
