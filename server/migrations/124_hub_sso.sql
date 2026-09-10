-- 124 HUB SSO (S1-4, Lane E). Additive, idempotent, runs on an empty database.
-- order.json: append at the END of "order" (after Lane C's 121_store_code_tagging.sql / 122_store_code_lazy_tables.sql).
-- Feature is dark until HUB_SSO_ENABLED='1' on the service (read at request time, R7).

-- Single-use ledger for exchanged tickets: the nonce is burned under the primary key, so a replay (or a parallel
-- second exchange) loses the INSERT and is refused. Rows older than a day are swept by the route.
CREATE TABLE IF NOT EXISTS hub_sso_used_tickets (
  nonce   TEXT PRIMARY KEY,
  exp     TIMESTAMPTZ NOT NULL,
  used_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_hub_sso_used_tickets_exp ON hub_sso_used_tickets (exp);

-- Hub role -> dashboard role NAME (roles.name). Data, not code: a store may re-map without a deploy.
-- '*' is the fallback for a hub role this table does not know: the least-privileged seeded role.
CREATE TABLE IF NOT EXISTS hub_role_map (
  hub_role       TEXT PRIMARY KEY,
  dashboard_role VARCHAR(50) NOT NULL,
  updated_at     TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
INSERT INTO hub_role_map (hub_role, dashboard_role) VALUES
  ('viewer',   'Viewer'),
  ('editor',   'Manager'),
  ('admin',    'Admin'),
  ('operator', 'Manager'),
  ('owner',    'Admin'),
  ('*',        'Viewer')
ON CONFLICT (hub_role) DO NOTHING;
