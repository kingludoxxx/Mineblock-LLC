-- 088_add_funnels_permission.sql
-- Adds funnels:access for the Funnel Builder page.
-- SuperAdmin already has wildcard {"*": ["*"]} — no change needed there.
-- Other team roles can be granted later from the Team page if needed.

UPDATE roles
SET permissions = permissions || '{"funnels": ["access"]}'::jsonb
WHERE name = 'Team - Full Access';
