-- 031_seed_page_permissions.sql
-- Seeds page-level permission roles for dashboard access control.
-- SuperAdmin already has wildcard {"*": ["*"]} via runSeeds() in server.js,
-- so we only need to add the explicit page-access roles for team members.

-- "Team - Full Access" — all dashboard pages except admin settings
INSERT INTO roles (id, name, description, permissions, is_system) VALUES (
  gen_random_uuid(),
  'Team - Full Access',
  'Access to all dashboard pages',
  '{"dashboard":["access"],"creative-analysis":["access"],"brief-pipeline":["access"],"meta-ads":["access"],"google-ads":["access"],"youtube-ads":["access"],"tiktok-ads":["access"],"avatars":["access"],"mechanisms":["access"],"hooks":["access"],"brief-agent":["access"],"magic-ads":["access"],"statics":["access"],"attribution":["access"],"live-metrics":["access"],"ltv":["access"],"team-hub":["access"],"assets":["access"],"todo":["access"],"support":["access"]}',
  false
) ON CONFLICT (name) DO UPDATE SET permissions = EXCLUDED.permissions;

-- "Team - Brief Pipeline" — dashboard + brief pipeline only
INSERT INTO roles (id, name, description, permissions, is_system) VALUES (
  gen_random_uuid(),
  'Team - Brief Pipeline',
  'Access to Brief Pipeline only',
  '{"dashboard":["access"],"brief-pipeline":["access"]}',
  false
) ON CONFLICT (name) DO UPDATE SET permissions = EXCLUDED.permissions;

-- "Team - Creative Analysis" — dashboard + creative analysis only
INSERT INTO roles (id, name, description, permissions, is_system) VALUES (
  gen_random_uuid(),
  'Team - Creative Analysis',
  'Access to Creative Analysis only',
  '{"dashboard":["access"],"creative-analysis":["access"]}',
  false
) ON CONFLICT (name) DO UPDATE SET permissions = EXCLUDED.permissions;

-- "Team - Production" — brief pipeline + brief agent + magic ads + statics
INSERT INTO roles (id, name, description, permissions, is_system) VALUES (
  gen_random_uuid(),
  'Team - Production',
  'Access to all Production tools',
  '{"dashboard":["access"],"brief-pipeline":["access"],"brief-agent":["access"],"magic-ads":["access"],"statics":["access"]}',
  false
) ON CONFLICT (name) DO UPDATE SET permissions = EXCLUDED.permissions;

-- "Team - Intelligence" — meta, google, youtube, tiktok ad platforms
INSERT INTO roles (id, name, description, permissions, is_system) VALUES (
  gen_random_uuid(),
  'Team - Intelligence',
  'Access to all Intelligence/Ad platforms',
  '{"dashboard":["access"],"meta-ads":["access"],"google-ads":["access"],"youtube-ads":["access"],"tiktok-ads":["access"]}',
  false
) ON CONFLICT (name) DO UPDATE SET permissions = EXCLUDED.permissions;
