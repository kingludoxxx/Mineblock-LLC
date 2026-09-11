-- 134 W8c — THE HUB'S OWNER SEES THE KPIs OF THE STORE IT ENTERS, WITHOUT WIDENING ANY EXISTING ROLE.
--
-- LUDO'S DECISION (2026-09-11): "the hub OWNER must see the KPIs of the store they enter" — per store;
-- there is no cross-store view. The KPIs in question are the CEO Office page AND the home page's KPI
-- cards (total sales, ad spend, ROAS, purchases, AOV, profit). Both sit behind ONE permission,
-- `kpi-system:access` (server/src/routes/kpiSystem.js:259 gates the whole router; client App.jsx and
-- Sidebar.jsx gate the pages on the same key).
--
-- Migration 133 maps hub `owner` and hub `admin` onto `Team - Full Access`, which is the only seeded
-- role that opens the dashboard's pages — and it does NOT carry `kpi-system:access`. W8b left it that
-- way deliberately: `kpi-system` is granted to no role but SuperAdmin anywhere in this repo's migrations
-- (`grep -rn "kpi-system" server/migrations` finds only 133's own comment), so granting it to
-- `Team - Full Access` would have silently handed the revenue figures to every EXISTING holder of that
-- role on the two live dashboards. That is the W8 review's concern, and it still stands.
--
-- So this file does not widen a role. It mints a NEW one:
--
--   Hub Owner  =  `Team - Full Access`'s permission set, COPIED AT MIGRATION TIME,  +  kpi-system:access
--
-- and re-points ONE map row, `owner -> Hub Owner`. Nobody holds `Hub Owner` until the hub JIT-creates a
-- user through it, so no existing user's permissions change and no existing role's permissions change.
--
-- The map after this file:
--   owner    -> Hub Owner            full access + the store's KPIs (Ludo's decision)
--   admin    -> Team - Full Access   UNCHANGED
--   operator -> Team - Production    UNCHANGED
--   editor   -> Team - Production    UNCHANGED
--   viewer   -> Viewer               UNCHANGED
--   *        -> Viewer               UNCHANGED (fail closed)
--
-- DECISION MADE — `admin` is NOT moved. Ludo's decision names the OWNER. `docs/lanes/w8.md` argues that a
-- hub admin "administers the STORE", which is why 133 gave it the full-access role; it does not argue that
-- a hub admin is the store's financial principal, and the revenue figures are the one thing this codebase
-- has always kept behind its own key. A store that wants it is one row:
--   UPDATE hub_role_map SET dashboard_role = 'Hub Owner', updated_at = NOW() WHERE hub_role = 'admin';
--
-- DECISION MADE — a COPY, not an inheritance. `Hub Owner`'s permissions are the bytes `Team - Full Access`
-- held when this migration ran. A later grant to `Team - Full Access` does NOT flow into `Hub Owner`
-- (roles are flat rows; this schema has no role hierarchy to inherit through). That is the conservative
-- reading: a permission added to one role later is a decision about THAT role's holders.
--
-- SAFETY (R6, additive + idempotent, runs on an empty database — 031 and 086 both run before this file
-- in order.json, so the copy sees the full seeded set including orders:access):
--   * `Hub Owner` is created only if no row of that name exists. If one does — a re-run, or a store that
--     built or edited its own — it is left EXACTLY as it is and a NOTICE says so. This file never
--     rewrites an existing role's permissions, its own included.
--   * the map UPDATE matches only the row still holding migration 133's exact value ('Team - Full Access'),
--     so a store that re-pointed `owner` by hand keeps its choice (131's / 133's guard shape), and a
--     second run matches nothing because the row now reads 'Hub Owner'.
--   * the UPDATE requires the `Hub Owner` NAME to exist, because hubSso.js refuses the hop with a 403 when
--     a mapped name has no row in `roles` — a dangling name would lock every owner out of the store.
--   * NO row of `roles`, `user_roles` or `users` that already existed is written by this file.
--
-- FAILURE PATH (run down in server/tests/hub-sso/w8-jit-role.mjs section L, not merely reasoned about):
-- on a database with no `Team - Full Access` row at all, `Hub Owner` is built from migration 031's page
-- keys + kpi-system:access and the migration RAISES A NOTICE naming the missing role. `orders:access` is
-- NOT included there — that is 086's grant to a role which does not exist on such a database. The map row
-- is NOT re-pointed in that case either: 133 could not re-point it, so `owner` still holds 126's seed and
-- this file does not run ahead of the migration that owns that transition.

DO $$
DECLARE
  v_src   jsonb;
  v_perms jsonb;
  v_from  text;
BEGIN
  IF EXISTS (SELECT 1 FROM roles WHERE name = 'Hub Owner') THEN
    RAISE NOTICE '134: role "Hub Owner" already exists — left exactly as it is (a re-run, or this store''s own edit).';
    RETURN;
  END IF;

  SELECT r.permissions INTO v_src FROM roles r WHERE r.name = 'Team - Full Access';

  IF v_src IS NULL THEN
    -- migration 031's "Team - Full Access" page keys, verbatim, minus orders (086 grants that to the row
    -- that does not exist here). Kept as a literal on purpose: the point of this branch is that there is
    -- nothing on this database to copy from.
    v_src := '{"dashboard":["access"],"creative-analysis":["access"],"brief-pipeline":["access"],"meta-ads":["access"],"google-ads":["access"],"youtube-ads":["access"],"tiktok-ads":["access"],"avatars":["access"],"mechanisms":["access"],"hooks":["access"],"brief-agent":["access"],"magic-ads":["access"],"statics":["access"],"attribution":["access"],"live-metrics":["access"],"ltv":["access"],"team-hub":["access"],"assets":["access"],"todo":["access"],"support":["access"]}'::jsonb;
    v_from := 'migration 031''s page keys (this database has no "Team - Full Access" role to copy)';
    RAISE NOTICE '134: NOTICE — this database has no "Team - Full Access" role, so "Hub Owner" was built from migration 031''s page keys + kpi-system:access instead of from a copy. hub_role_map is NOT re-pointed (migration 133 could not re-point it either).';
  ELSE
    v_from := 'a copy of "Team - Full Access" taken at migration time';
  END IF;

  -- Add kpi-system:access without disturbing any action the copied set already carries (de-duplicated,
  -- so a source that somehow already holds it produces the same row — 131's shape).
  v_perms := jsonb_set(v_src, '{kpi-system}', (
    SELECT COALESCE(jsonb_agg(DISTINCT a.action), '[]'::jsonb)
      FROM (
        SELECT jsonb_array_elements(
                 CASE WHEN jsonb_typeof(v_src -> 'kpi-system') = 'array'
                      THEN v_src -> 'kpi-system' ELSE '[]'::jsonb END) AS action
        UNION
        SELECT to_jsonb('access'::text)
      ) a), true);

  INSERT INTO roles (id, name, description, permissions, is_system)
  VALUES (gen_random_uuid(), 'Hub Owner',
          'Hub owner of this store — ' || v_from || ', plus kpi-system:access (W8c, migration 134)',
          v_perms, false)
  ON CONFLICT (name) DO NOTHING;

  RAISE NOTICE '134: created role "Hub Owner" from %.', v_from;
END $$;

UPDATE hub_role_map m
   SET dashboard_role = 'Hub Owner', updated_at = NOW()
 WHERE m.hub_role = 'owner'
   AND m.dashboard_role = 'Team - Full Access'
   AND EXISTS (SELECT 1 FROM roles r WHERE r.name = 'Hub Owner');
