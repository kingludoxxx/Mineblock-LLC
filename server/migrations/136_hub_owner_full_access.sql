-- 136 — THE HUB OWNER IS THE OWNER. Full access, the same `*` the store's own SuperAdmin holds.
--
-- WHY THIS REVERSES 134's DESIGN. 134 built "Hub Owner" as a COPY of the TEAM role "Team - Full Access"
-- plus `kpi-system:access`. That implemented Ludo's decision ("the owner sees the store") as an
-- enumeration of pages, and an enumeration is only as complete as the day it was written.
--
-- MEASURED 2026-09-13 in a real Chrome session, signed in through the hub exactly as Ludo is, against the
-- live Mineblock and Puure dashboards: Products and Statics Generation both answered `403` from the
-- dashboard's own API, and the pages rendered "No products yet" over a table that holds a product. The
-- routes require `products:access` and `statics-templates:access`; Hub Owner holds neither. The full list
-- of permission keys the server's routes demand that Hub Owner did NOT carry:
--
--   products · statics-templates · ads-launcher · ads-reporting · ads-control-center · ad-rejection-monitor
--   video-ads-launcher · advertorial · iteration-king · creative-intelligence · audit:read
--   users:read/create/update · departments:read/create/update
--
-- The account Ludo used BEFORE the hub (the store's own admin) is SuperAdmin, `{"*":["*"]}`. So the hub
-- did not just add a login - it silently demoted the owner of each store to a team member.
--
-- Adding the missing keys one by one would break again the next time a page ships with a new key, which is
-- the exact failure being fixed. The owner's permission set is therefore the WILDCARD, which
-- server/src/middleware/rbac.js evaluates on the permission set itself (not on a role name), so it covers
-- every page that exists and every page that will.
--
-- SCOPE: only the role named "Hub Owner". Hub `owner` is the only map row pointing at it (134), and hub
-- `admin`, `operator`, `editor` and `viewer` are untouched, so no team member gains anything. Existing
-- local SuperAdmin accounts are untouched.
--
-- Idempotent: a re-run finds the wildcard already there and changes nothing. A store with no "Hub Owner"
-- role (134 not applied, which cannot happen under order.json) changes nothing and says so.

DO $$
DECLARE
  n int;
BEGIN
  UPDATE roles
     SET permissions = '{"*":["*"]}'::jsonb,
         description = 'Hub owner of this store: full access, the same wildcard the store''s SuperAdmin holds (migration 136)',
         updated_at  = now()
   WHERE name = 'Hub Owner'
     AND permissions IS DISTINCT FROM '{"*":["*"]}'::jsonb;
  GET DIAGNOSTICS n = ROW_COUNT;
  IF n = 0 THEN
    RAISE NOTICE '136: "Hub Owner" already holds the wildcard, or does not exist - nothing changed.';
  ELSE
    RAISE NOTICE '136: "Hub Owner" now holds {"*":["*"]}.';
  END IF;
END $$;
