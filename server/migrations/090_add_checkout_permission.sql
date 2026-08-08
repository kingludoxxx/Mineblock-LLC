-- 090_add_checkout_permission.sql
-- Adds checkout:access for the money-path admin surface (sessions, orders,
-- upsell charges, unmatched payments). SuperAdmin already has wildcard
-- {"*": ["*"]} — no change needed there.

UPDATE roles
SET permissions = permissions || '{"checkout": ["access"]}'::jsonb
WHERE name = 'Team - Full Access';
