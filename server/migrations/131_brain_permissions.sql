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
--
-- S4-SB2 / NEW-8 — THE GUARD IS A MIGRATION, NOT A POLICY. It used to read
-- "anything that is not already read AND write", which is a statement about what
-- a role LACKS, so every role an operator created later with FEWER brain actions
-- was topped up to access+read+write the next time anyone ran this file by hand —
-- and the header above invites exactly that hand-run. Measured on a clone of a
-- live store's role table:
--   {"brain":["access","read"]}  a deliberately READ-ONLY reviewer → gained write
--   {"brain":[]}                 a deliberately empty brain role   → gained all three
--   {"brain":["approve"]}        an approve-only role              → gained read+write
-- The ledger stops the runner re-running it, so that was a foot-gun rather than a
-- live escalation, but a foot-gun that fires on the documented procedure.
--
-- The guard now names the ONE shape migration 128 created — the flat
-- `["access"]` this migration exists to split — so the statement means "expand
-- 128's grant", which is what it is. Any other shape is an operator's decision and
-- is left exactly alone. Still idempotent: after the split the role no longer
-- equals `["access"]`, so a second run matches nothing at all.

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
  AND r.permissions -> 'brain' = '["access"]'::jsonb;
