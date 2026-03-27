CREATE TABLE IF NOT EXISTS statics_templates (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  name TEXT NOT NULL,
  category TEXT NOT NULL DEFAULT 'Uncategorized',
  image_url TEXT NOT NULL,
  r2_key TEXT,
  thumbnail_url TEXT,
  tags JSONB DEFAULT '[]'::jsonb,
  metadata JSONB DEFAULT '{}'::jsonb,
  is_hidden BOOLEAN DEFAULT false,
  sort_order INTEGER DEFAULT 0,
  created_at TIMESTAMPTZ DEFAULT NOW(),
  updated_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_statics_templates_category ON statics_templates(category);
CREATE INDEX IF NOT EXISTS idx_statics_templates_hidden ON statics_templates(is_hidden);
