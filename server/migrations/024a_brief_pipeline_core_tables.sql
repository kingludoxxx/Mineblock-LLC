-- Create the brief_pipeline core tables that the application otherwise
-- creates LAZILY (routes/briefPipeline.js ensureTables, on first request).
--
-- Why this migration exists: migrations 025, 026, 027 and ~14 others do
-- data fixes, ALTERs and even a FOREIGN KEY against these tables. On a
-- FRESH database they did not exist yet, so the migration run died at 25 of
-- 93 — every later migration (including the orders/customers/funnels/
-- checkout permission grants) silently never applied, seeds never ran, and
-- the server still reported healthy with zero roles and zero users.
--
-- DDL is copied verbatim from ensureTables so the two cannot drift; both
-- sides are IF NOT EXISTS, so whichever runs first wins and the other is a
-- no-op. Column additions made later by ensureTables remain its job.

CREATE TABLE IF NOT EXISTS brief_pipeline_winners (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  creative_id TEXT NOT NULL,
  ad_name TEXT,
  product_code TEXT DEFAULT 'MR',
  angle TEXT,
  format TEXT,
  avatar TEXT,
  editor TEXT,
  hook_type TEXT,
  week TEXT,
  spend NUMERIC(12,2) DEFAULT 0,
  revenue NUMERIC(12,2) DEFAULT 0,
  roas NUMERIC(8,2) DEFAULT 0,
  purchases INTEGER DEFAULT 0,
  cpa NUMERIC(10,2) DEFAULT 0,
  ctr NUMERIC(8,2) DEFAULT 0,
  impressions BIGINT DEFAULT 0,
  clicks BIGINT DEFAULT 0,
  cpm NUMERIC(10,2) DEFAULT 0,
  aov NUMERIC(10,2) DEFAULT 0,
  clickup_task_id TEXT,
  existing_iterations INTEGER DEFAULT 0,
  iteration_codes JSONB DEFAULT '[]',
  raw_script TEXT,
  parsed_script JSONB,
  status TEXT DEFAULT 'detected',
  detected_at TIMESTAMPTZ DEFAULT NOW(),
  selected_at TIMESTAMPTZ,
  winner_reason TEXT,
  iteration_readiness TEXT,
  iteration_mode TEXT,
  iteration_config JSONB,
  thumbnail_url TEXT,
  video_url TEXT,
  UNIQUE(creative_id)
);

CREATE TABLE IF NOT EXISTS brief_pipeline_generated (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  winner_id UUID REFERENCES brief_pipeline_winners(id),
  parent_creative_id TEXT NOT NULL,
  iteration_mode TEXT,
  aggressiveness TEXT DEFAULT 'medium',
  win_analysis JSONB,
  hooks JSONB DEFAULT '[]',
  body TEXT,
  iteration_direction TEXT,
  novelty_score NUMERIC(3,1),
  aggression_score NUMERIC(3,1),
  coherence_score NUMERIC(3,1),
  overall_score NUMERIC(3,1),
  verdict TEXT,
  scores_json JSONB,
  rank INTEGER,
  brief_number INTEGER,
  product_code TEXT DEFAULT 'MR',
  angle TEXT,
  format TEXT,
  avatar TEXT,
  editor TEXT,
  strategist TEXT DEFAULT 'Ludovico',
  creator TEXT DEFAULT 'NA',
  naming_convention TEXT,
  status TEXT DEFAULT 'generated',
  clickup_task_id TEXT,
  clickup_task_url TEXT,
  created_at TIMESTAMPTZ DEFAULT NOW(),
  approved_at TIMESTAMPTZ,
  pushed_at TIMESTAMPTZ,
  highlighted_text JSONB DEFAULT '[]'
);
