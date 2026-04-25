-- 033_add_languages_pipeline_permission.sql
-- Adds languages-pipeline:access to relevant team roles.
-- SuperAdmin already has wildcard {"*": ["*"]} — no change needed there.

-- Update "Team - Full Access" to include languages-pipeline
UPDATE roles
SET permissions = permissions || '{"languages-pipeline": ["access"]}'::jsonb
WHERE name = 'Team - Full Access';

-- Update "Team - Production" to include languages-pipeline
UPDATE roles
SET permissions = permissions || '{"languages-pipeline": ["access"]}'::jsonb
WHERE name = 'Team - Production';
