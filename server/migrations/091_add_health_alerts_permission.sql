-- 091_add_health_alerts_permission.sql
-- Adds health-alerts:read / health-alerts:ack for the operational alert feed
-- (GET /api/v1/health-alerts, POST /:id/ack, POST /sweep).
-- SuperAdmin already has wildcard {"*": ["*"]} — no change needed there.
--
-- READ and ACK are SEPARATE actions on purpose: seeing that a production fault
-- happened and declaring it handled are different authorities. Manager can
-- read the feed; only Team - Full Access can acknowledge (and run the sweep,
-- which WRITES the alerts it earns and is therefore gated as a write).
--
-- Viewer is deliberately granted NOTHING here. Its seeded description is
-- "read-only access to departments and audit logs" (seeds/seed_roles.js:38) —
-- production fault data was never in that scope. Grant it from the Team page
-- if an operator decides otherwise; that is a decision, not a default.
--
-- `||` on jsonb REPLACES the value at a key it already holds, so re-running
-- this migration is safe and it cannot accumulate duplicate actions.

UPDATE roles
SET permissions = permissions || '{"health-alerts": ["read", "ack"]}'::jsonb
WHERE name = 'Team - Full Access';

UPDATE roles
SET permissions = permissions || '{"health-alerts": ["read"]}'::jsonb
WHERE name = 'Manager';
