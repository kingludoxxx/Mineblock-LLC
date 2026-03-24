CREATE TABLE IF NOT EXISTS advertorial_copies (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  product_id INTEGER NOT NULL REFERENCES product_profiles(id) ON DELETE CASCADE,
  title TEXT,
  concept_name TEXT,
  ad_copy TEXT NOT NULL,
  ad_copy_word_count INTEGER,
  original_copy TEXT,
  source_type TEXT DEFAULT 'competitor',
  source_brand_name TEXT,
  angle TEXT,
  adaptation_type TEXT CHECK (adaptation_type IN ('direct_adapt', 'pain_pivot', 'creative_swing')),
  headlines JSONB DEFAULT '[]',
  descriptions JSONB DEFAULT '[]',
  compliance_score INTEGER,
  compliance_notes TEXT,
  archetype TEXT CHECK (archetype IN ('MIRROR', 'MYTHIC', 'LEGACY', 'HORIZON', NULL)),
  secondary_archetype TEXT,
  image_concepts JSONB DEFAULT '[]',
  images JSONB DEFAULT '[]',
  image_status TEXT DEFAULT 'pending',
  status TEXT DEFAULT 'draft' CHECK (status IN ('draft', 'copy_review', 'copy_approved', 'images_pending', 'images_review', 'ready', 'queued', 'launched', 'archived')),
  group_id UUID,
  group_name TEXT,
  batch_number INTEGER,
  generation INTEGER DEFAULT 1,
  parent_copy_id UUID,
  rewrite_prompt TEXT,
  metadata JSONB DEFAULT '{}',
  created_at TIMESTAMPTZ DEFAULT NOW(),
  updated_at TIMESTAMPTZ DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_adv_copies_product ON advertorial_copies(product_id);
CREATE INDEX IF NOT EXISTS idx_adv_copies_status ON advertorial_copies(status);
CREATE INDEX IF NOT EXISTS idx_adv_copies_angle ON advertorial_copies(angle);

ALTER TABLE spy_creatives ADD CONSTRAINT fk_spy_creatives_adv_copy
  FOREIGN KEY (advertorial_copy_id) REFERENCES advertorial_copies(id) ON DELETE SET NULL;
