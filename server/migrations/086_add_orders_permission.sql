-- 086_add_orders_permission.sql
-- Adds orders:access for the CRM Orders page (revenue data — Full Access only).
-- SuperAdmin already has wildcard {"*": ["*"]} — no change needed there.
-- Other team roles can be granted later from the Team page if needed.

UPDATE roles
SET permissions = permissions || '{"orders": ["access"]}'::jsonb
WHERE name = 'Team - Full Access';
