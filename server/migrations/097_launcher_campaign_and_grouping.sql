-- Launcher: retargeting format + new-campaign-from-template (tasks/LAUNCHER-SCOPE.md)
-- adset_grouping: 'per_angle' keeps today's one-ad-set-per-angle behavior;
-- 'single' puts EVERY ad of the launch into one ad set (retargeting format).
ALTER TABLE launch_templates ADD COLUMN IF NOT EXISTS adset_grouping TEXT DEFAULT 'per_angle';
ALTER TABLE launch_templates ADD COLUMN IF NOT EXISTS campaign_mode TEXT DEFAULT 'existing';
ALTER TABLE launch_templates ADD COLUMN IF NOT EXISTS campaign_objective TEXT DEFAULT 'OUTCOME_SALES';
ALTER TABLE launch_templates ADD COLUMN IF NOT EXISTS campaign_name_pattern TEXT DEFAULT '{date} - {product} - {angle} - {batch}';
ALTER TABLE launch_templates ADD COLUMN IF NOT EXISTS campaign_budget_mode TEXT DEFAULT 'ABO';
ALTER TABLE launch_templates ADD COLUMN IF NOT EXISTS campaign_daily_budget NUMERIC(10,2);
ALTER TABLE launch_templates ADD COLUMN IF NOT EXISTS special_ad_categories JSONB DEFAULT '[]';

-- CHECKs as separate guarded statements so re-runs stay idempotent.
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'launch_templates_adset_grouping_check') THEN
    ALTER TABLE launch_templates ADD CONSTRAINT launch_templates_adset_grouping_check
      CHECK (adset_grouping IN ('per_angle', 'single'));
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'launch_templates_campaign_mode_check') THEN
    ALTER TABLE launch_templates ADD CONSTRAINT launch_templates_campaign_mode_check
      CHECK (campaign_mode IN ('existing', 'create_new'));
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'launch_templates_campaign_budget_mode_check') THEN
    ALTER TABLE launch_templates ADD CONSTRAINT launch_templates_campaign_budget_mode_check
      CHECK (campaign_budget_mode IN ('ABO', 'CBO'));
  END IF;
END $$;
