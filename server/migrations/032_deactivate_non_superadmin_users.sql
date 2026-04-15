-- One-shot migration: deactivate all non-SuperAdmin users and invalidate their sessions.
-- Requested by Ludo 2026-04-15: "Also remove all members".
-- Uses soft delete (is_active=false) to preserve audit trail.

-- 1. Deactivate every user that does NOT hold the SuperAdmin role.
UPDATE users
SET is_active = false,
    updated_at = NOW()
WHERE id NOT IN (
  SELECT DISTINCT u.id
  FROM users u
  JOIN user_roles ur ON u.id = ur.user_id
  JOIN roles r ON ur.role_id = r.id
  WHERE r.name = 'SuperAdmin'
);

-- 2. Kill active sessions for all deactivated users so they are logged out immediately.
DELETE FROM sessions
WHERE user_id IN (
  SELECT id FROM users WHERE is_active = false
);

-- 3. Audit trail entry so this is discoverable later.
INSERT INTO audit_logs (user_id, action, resource_type, resource_id, new_values, created_at)
SELECT
  (SELECT u.id FROM users u
   JOIN user_roles ur ON u.id = ur.user_id
   JOIN roles r ON ur.role_id = r.id
   WHERE r.name = 'SuperAdmin'
   ORDER BY u.created_at ASC
   LIMIT 1),
  'BULK_DEACTIVATE_NON_SUPERADMIN',
  'user',
  u.id,
  jsonb_build_object('reason', 'migration 032 — operator requested removal of all team members', 'isActive', false),
  NOW()
FROM users u
WHERE u.is_active = false;
