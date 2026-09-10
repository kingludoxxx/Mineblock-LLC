-- 131_brain_permissions.sql  (HUB — S4-SB2)
--
-- ONE permission, `brain:access`, used to gate reading raw documents AND
-- approving insights AND rewriting the playbook, so every `Team - Full Access`
-- user was an approver of the layer the approval gate exists to protect.
--
-- Three actions now, and they are not the same act:
--   brain:read     read search / documents / insights / playbook
--   brain:write    ingest, propose insights, run an extraction, write + lock
--                  a playbook
--   brain:approve  approve or reject an insight, unlock a locked playbook, and
--                  read UNAPPROVED insights (approved_only=false)
--
-- `brain:access` is kept as "may reach the Brain at all" so an existing role
-- keeps working, and read + write are added alongside it. **approve is granted
-- to NO role here.** SuperAdmin carries {"*":["*"]} (086) and therefore holds it
-- already; every other approver is named deliberately, one role at a time:
--
--   UPDATE roles SET permissions = jsonb_set(permissions, '{brain}',
--          (COALESCE(permissions->'brain','[]'::jsonb) || '["approve"]'::jsonb))
--   WHERE name = '<the reviewing role>';
--
-- Additive + idempotent (R6): the concatenation is de-duplicated through a
-- SELECT DISTINCT, so re-running changes nothing.

UPDATE roles r
SET permissions = jsonb_set(
      r.permissions,
      '{brain}',
      (SELECT COALESCE(jsonb_agg(DISTINCT a.action), '[]'::jsonb)
         FROM (
           SELECT jsonb_array_elements(COALESCE(r.permissions -> 'brain', '[]'::jsonb)) AS action
           UNION
           SELECT to_jsonb(v) FROM (VALUES ('access'), ('read'), ('write')) AS t(v)
         ) a)
    )
WHERE r.permissions ? 'brain'
  AND jsonb_typeof(r.permissions -> 'brain') = 'array'
  AND NOT (r.permissions -> 'brain' @> '["read"]'::jsonb
           AND r.permissions -> 'brain' @> '["write"]'::jsonb);
