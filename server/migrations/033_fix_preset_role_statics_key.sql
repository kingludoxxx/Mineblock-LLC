-- 033_fix_preset_role_statics_key.sql
-- Renames the `statics` permission key to `statics-generation` in seeded preset
-- roles so they line up with the backend route name
-- (requirePermission('statics-generation', 'access') in routes/staticsGeneration.js).
-- The 031 seed used the bare `statics` key which never matched the route, so
-- users assigned "Team - Production" or "Team - Full Access" were getting 403
-- on the Statics Generation page.

UPDATE roles
SET permissions = permissions - 'statics' || jsonb_build_object('statics-generation', permissions->'statics')
WHERE permissions ? 'statics';
