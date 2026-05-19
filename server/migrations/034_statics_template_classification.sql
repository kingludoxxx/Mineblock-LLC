-- Migration 034: Add template classification columns to statics_templates
-- Supports P1 (document template detection) and P5 (angle-template compatibility)
-- Run: node server/migrations/run.js

-- is_document_template: true = background is primarily text (routes to Playwright)
-- is_image_template: true = background is an image/product (routes to Gemini)
-- archetype: semantic type for copy direction
-- angle_tags: array of compatible angle names for template picker filtering
-- classification_method: how was this classified ('manual', 'claude_vision', 'heuristic')
-- classified_at: when was it last classified

ALTER TABLE statics_templates
  ADD COLUMN IF NOT EXISTS is_document_template  BOOLEAN     DEFAULT NULL,
  ADD COLUMN IF NOT EXISTS archetype             VARCHAR(64) DEFAULT NULL,
  ADD COLUMN IF NOT EXISTS angle_tags            TEXT[]      DEFAULT '{}',
  ADD COLUMN IF NOT EXISTS classification_method VARCHAR(32) DEFAULT NULL,
  ADD COLUMN IF NOT EXISTS classified_at         TIMESTAMPTZ DEFAULT NULL;

-- Seed known confirmed document templates (from hardcoded set in staticsGeneration.js)
UPDATE statics_templates SET
  is_document_template  = TRUE,
  archetype             = 'document',
  classification_method = 'manual',
  classified_at         = NOW()
WHERE id IN (
  '9247a5c9-1445-4ed9-abc5-4bfcdf185c88',
  '4897d3c0-c557-4d42-8c37-cb88c24349aa',
  '52378b84-e04d-4277-916f-32a06f99417b',
  '8cf2cdec-d373-4eea-a87a-12fad9b0ff49'
);

-- Index for fast lookup in generate route
CREATE INDEX IF NOT EXISTS idx_statics_templates_is_document
  ON statics_templates (is_document_template)
  WHERE is_document_template = TRUE;

CREATE INDEX IF NOT EXISTS idx_statics_templates_angle_tags
  ON statics_templates USING gin (angle_tags);

CREATE INDEX IF NOT EXISTS idx_statics_templates_unclassified
  ON statics_templates (id)
  WHERE is_document_template IS NULL;
