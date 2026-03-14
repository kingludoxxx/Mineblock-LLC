-- SaaS platform: extend audit_logs with workspace_id and details column

ALTER TABLE audit_logs
  ADD COLUMN IF NOT EXISTS workspace_id UUID REFERENCES workspaces(id) ON DELETE SET NULL,
  ADD COLUMN IF NOT EXISTS details JSONB;

-- Rename resource_type -> resource for consistency (keep both for backwards compat)
ALTER TABLE audit_logs
  ADD COLUMN IF NOT EXISTS resource VARCHAR(100);

UPDATE audit_logs SET resource = resource_type WHERE resource IS NULL AND resource_type IS NOT NULL;

CREATE INDEX IF NOT EXISTS idx_audit_logs_workspace ON audit_logs(workspace_id);
