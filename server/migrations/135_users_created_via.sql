-- 135 W8f — MARK THE USERS THE HUB CREATED, SO THE ONE-TIME ROLE REPAIR CAN SEE THEM.
--
-- THE DEFECT (measured live 2026-09-11 14:41Z, on the MB and SB databases):
-- migration 126 seeded hub_role_map with `owner -> 'Admin'`. 'Admin' is the platform's USER-TABLE
-- administrator (users / departments / audit / settings) and carries NOT ONE of the page keys
-- migration 031 seeds, so the operator the hub calls the OWNER of a store landed on an empty sidebar
-- and a locked KPI card. Migrations 133/134 re-pointed the map (`owner -> 'Hub Owner'`), but by
-- deliberate design (docs/lanes/w8.md, "AN EXISTING USER IS NEVER RE-ROLED") they did not touch a
-- user that already existed. Every store that had a hop BEFORE 2026-09-11 — MB, SB, TW — therefore
-- still carries a hub user stranded on 'Admin'.
--
-- W8f repairs exactly those users, ONCE, in the SSO exchange path (server/src/routes/hubSso.js).
-- The repair is fail-closed and needs three independent facts about the user. This file provides the
-- FIRST of them, which is the only one the schema could not already answer:
--
--   (a) WAS THIS ROW CREATED BY THE HUB, AND HAS IT NOT BEEN REPAIRED YET?
--       `users.created_via = 'hub_sso'`.
--
-- WHAT MAKES "ONCE" TRUE (W8g, REVIEW-W8F P0-1). THE COLUMN IS THE LATCH, NOT JUST THE MARK. The repair
-- writes `created_via = 'hub_sso_repaired'` onto the row it repairs, in the same transaction, one
-- statement before it moves the role. Nothing else in the codebase writes that value, and the
-- predicate matches only 'hub_sso', so a repaired user can never be a candidate again.
-- WHY IT HAS TO BE ON THE ROW: as W8f first shipped, nothing recorded that the repair had run.
-- `created_via` stayed 'hub_sso' and the product's own role endpoints
-- (controllers/teamController.js changeTeamMemberRole, controllers/userController.js assignRole)
-- write user_roles and NEVER name users.updated_at, so the `updated_at <= created_at` test below
-- stayed true forever. Measured over four rounds: a store administrator who set the hub user back to
-- exactly 'Admin' had that decision silently reversed on the very next hop, four times, four
-- HUB_SSO_ROLE_UPGRADED rows, always toward MORE privilege. With the latch: one upgrade row, and
-- rounds 2-4 leave the store's choice alone.
-- THE DELIBERATE CONSEQUENCE: the repair does NOT survive a restore from a pre-repair dump — a
-- restored row carries 'hub_sso' again and gets its one repair again. That is the same answer this
-- file gives everywhere else (the state on the row is the truth), and it is the one an operator can
-- predict.
--
-- WHY A COLUMN AND NOT THE AUDIT ROW. The JIT branch already writes an `HUB_SSO_JIT_CREATE` audit row
-- (resource_type 'user', resource_id = the new user's id), and that row is what the BACKFILL below
-- reads. But audit_logs is a log: it is swept, exported and truncated by operators, and its user_id is
-- `ON DELETE SET NULL`. A privilege decision must not depend on a row somebody is entitled to delete,
-- so provenance moves onto the user row, where it is as durable as the user itself.
--
-- WHY `HUB_SSO_JIT_CREATE` AND NOT `LIKE 'HUB\_SSO\_%'` FOR THE BACKFILL. `HUB_SSO_LOGIN` proves a HOP,
-- not a CREATION: a user the store made itself, who later hopped in through the hub, has those rows
-- too, and marking them 'hub_sso' would be a lie that the repair then acts on. `HUB_SSO_JIT_CREATE` is
-- written in exactly one place, in the same transaction as the INSERT, and means exactly "this row was
-- born here".
--
-- WHY THE BACKFILL ALSO DEMANDS "NO LOCAL LOGIN". A row that the hub created and a human has since
-- turned into a real local account (forgot-password -> reset-password is the only route: accept-invite
-- refuses a row whose password_hash is not NULL, and change-password needs the 32 random bytes the JIT
-- branch hashed, which nobody has) is no longer a pure hub shell, and the repair must not treat it as
-- one. The four tests below are the same ones server/src/routes/hubSso.js applies at hop time; each is
-- a fact the schema can actually answer:
--
--   * invited_at IS NULL AND invited_by IS NULL
--       the row never went through the team-invite flow (server/src/controllers/teamController.js),
--       which is how this dashboard gives a human an account they set their own password for.
--   * must_change_password = false
--       a store's OWN first administrator is created with must_change_password = true, in BOTH places
--       that create one (server/src/server.js:77 and server/seeds/seed_superadmin.js). The JIT branch
--       takes the column default, false. This is the guard that keeps a SuperAdmin out even if every
--       other test somehow passed.
--   * password_reset_token IS NULL AND password_reset_expires IS NULL
--       nobody is in the middle of claiming this account locally.
--   * updated_at <= created_at
--       THE DECISIVE ONE. `users` has no updated_at trigger on this schema (checked: the only two
--       set_updated_at triggers in server/migrations are 037's and 052's, on other tables), so
--       updated_at moves only when a statement names it. Every local password path names it —
--       forgotPassword (authController.js:435) and authService.updatePassword (authService.js:85,
--       `SET password_hash = $1, must_change_password = false, updated_at = NOW()`), which BOTH
--       reset-password and change-password call, plus User.update / updateLoginAttempts. The hub's own hop
--       deliberately does NOT (`UPDATE users SET failed_login_attempts = 0, locked_until = NULL,
--       last_login = NOW()`), and neither does the JIT INSERT, which takes both defaults from the same
--       transaction timestamp. So a row still satisfying updated_at <= created_at has not been written
--       since the instant the hub created it.
--   * last_login IS NULL OR last_login <= the newest HUB_SSO_LOGIN row
--       every login of every kind bumps last_login (authController.js:209 for the local one,
--       hubSso.js for the hop), and the hop writes its HUB_SSO_LOGIN audit row with the SAME
--       transaction timestamp. So a last_login later than the newest hub hop is a login this store
--       served itself. A user with NO HUB_SSO_LOGIN row at all fails this test (max() is NULL and the
--       comparison is NULL, not true) — fail closed, on purpose.
--
-- SAFETY (R6): additive, idempotent, runs on an empty database (users, audit_logs and the invite
-- columns all exist by 076, far earlier in order.json). The column defaults to NULL, which is the
-- honest answer for every row that predates this file and does not match the backfill. The UPDATE
-- touches only rows whose created_via IS NULL, so a second run matches nothing and an operator's own
-- value is never overwritten. NOTHING here changes a role, a permission or a user's access: this file
-- only records where a row came from.
--
-- NOT EXPOSED TO THE CLIENT. No response shape carries created_via: server/src/services/hubSession.js
-- builds `userData` from named fields, and User.js / userController.js name their columns too.

ALTER TABLE users
  ADD COLUMN IF NOT EXISTS created_via TEXT;

COMMENT ON COLUMN users.created_via IS
  'How this row was born, and whether W8f''s one-time role repair has already run on it. NULL = unknown / created locally before W8f. ''hub_sso'' = created by the hub SSO exchange (server/src/routes/hubSso.js), repair still available. ''hub_sso_repaired'' = same, and the one-time repair has been spent (W8g): the exchange will never re-role this user again. Provenance only: never a permission, never sent to a client.';

UPDATE users u
   SET created_via = 'hub_sso'
 WHERE u.created_via IS NULL
   AND EXISTS (
         SELECT 1 FROM audit_logs a
          WHERE a.resource_id = u.id
            AND a.resource_type = 'user'
            AND a.action = 'HUB_SSO_JIT_CREATE')
   AND u.invited_at IS NULL
   AND u.invited_by IS NULL
   AND u.must_change_password = false
   AND u.password_reset_token IS NULL
   AND u.password_reset_expires IS NULL
   AND u.updated_at <= u.created_at
   AND (u.last_login IS NULL
        OR u.last_login <= (SELECT max(a.created_at) FROM audit_logs a
                             WHERE a.resource_id = u.id
                               AND a.resource_type = 'user'
                               AND a.action = 'HUB_SSO_LOGIN'));

-- Only the repair reads this column, and only for rows that carry the one value it knows.
CREATE INDEX IF NOT EXISTS idx_users_created_via_hub_sso
  ON users (created_via) WHERE created_via = 'hub_sso';
