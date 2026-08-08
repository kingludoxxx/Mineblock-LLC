-- 087_add_customers_permission.sql
-- Adds customers:access for the CRM Customers page (same audience as orders).
-- SuperAdmin already has wildcard {"*": ["*"]} — no change needed there.

UPDATE roles
SET permissions = permissions || '{"customers": ["access"]}'::jsonb
WHERE name = 'Team - Full Access';
