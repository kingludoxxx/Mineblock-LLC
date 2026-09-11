-- 133 W8b — POINT hub_role_map AT THE ROLES THAT ACTUALLY OPEN PAGES.
--
-- Migration 126 seeded the hub -> dashboard role map against seeds/seed_roles.js:
--   owner -> 'Admin', admin -> 'Admin', operator/editor -> 'Manager', viewer/* -> 'Viewer'.
-- Those four are the platform's ACCOUNT-administration roles. Their permissions are
--   Admin   {"users":[...],"departments":["*"],"audit":["read"],"settings":["read"]}
--   Manager {"departments":["read","update"],"audit":["read"]}
-- and the dashboard's own pages are gated on PAGE keys seeded by migration 031
-- ("dashboard", "brief-pipeline", "meta-ads", ... ). Neither 'Admin' nor 'Manager'
-- carries a single page key, so the operator the hub calls the OWNER of a store
-- arrived in that store with an empty sidebar and a 403 on the home page's data.
-- (Measured, W8b RED: briefs/out/PROOF-W8.md.)
--
-- The map after this file:
--   owner    -> Team - Full Access   the store's full-access role (031, + orders from 086)
--   admin    -> Team - Full Access   a hub admin administers the STORE, not the user table
--   operator -> Team - Production    the next one down: the production tools, no revenue pages
--   editor   -> Team - Production
--   viewer   -> Viewer               read-only
--   *        -> Viewer               FAIL CLOSED: an unknown hub role gets viewer level
--
-- DELIBERATELY NOT CHANGED: no role's PERMISSIONS are touched by this file. In particular
-- `kpi-system:access` (the home page's KPI block, the "CEO Office") is granted to no role
-- but SuperAdmin anywhere in this repo's migrations, which is a deliberate restriction, not
-- an oversight — so a hub owner sees the home page with its KPI block replaced by the quiet
-- "not available for your role" card (W8b, client/src/pages/Dashboard.jsx), never a red 403.
-- If a store wants its owners to see it, that is one line a store runs on its own database:
--   UPDATE roles SET permissions = permissions || '{"kpi-system":["access"]}'::jsonb
--    WHERE name = 'Team - Full Access';
--
-- SAFETY (R6, additive + idempotent, runs on an empty database):
--   * each UPDATE matches only the row that still holds migration 126's EXACT seeded value,
--     so a store that has already re-pointed a row by hand is left alone (the guard shape
--     migration 131 established);
--   * each UPDATE requires the target role NAME to exist, because hubSso.js refuses the hop
--     with a 403 when a mapped name has no row in `roles` — a dangling name would lock every
--     operator out of the store;
--   * a second run matches nothing (the rows no longer hold the 126 values).

UPDATE hub_role_map m
   SET dashboard_role = 'Team - Full Access', updated_at = NOW()
 WHERE m.hub_role IN ('owner', 'admin')
   AND m.dashboard_role = 'Admin'
   AND EXISTS (SELECT 1 FROM roles r WHERE r.name = 'Team - Full Access');

UPDATE hub_role_map m
   SET dashboard_role = 'Team - Production', updated_at = NOW()
 WHERE m.hub_role IN ('operator', 'editor')
   AND m.dashboard_role = 'Manager'
   AND EXISTS (SELECT 1 FROM roles r WHERE r.name = 'Team - Production');
