-- Add deep_analysis JSONB column to statics_templates
ALTER TABLE statics_templates ADD COLUMN IF NOT EXISTS deep_analysis JSONB;
ALTER TABLE statics_templates ADD COLUMN IF NOT EXISTS analyzed_at TIMESTAMPTZ;
CREATE INDEX IF NOT EXISTS idx_statics_templates_analyzed ON statics_templates(analyzed_at) WHERE analyzed_at IS NOT NULL;
