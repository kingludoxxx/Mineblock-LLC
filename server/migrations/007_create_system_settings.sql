CREATE TABLE IF NOT EXISTS system_settings (
  key VARCHAR(100) PRIMARY KEY,
  value JSONB NOT NULL DEFAULT '{}',
  description TEXT,
  updated_by UUID REFERENCES users(id),
  updated_at TIMESTAMPTZ DEFAULT NOW()
);

INSERT INTO system_settings (key, value, description) VALUES
  ('app_name', '"Mineblock Admin Dashboard"', 'Application display name'),
  ('maintenance_mode', 'false', 'Whether the application is in maintenance mode'),
  ('max_login_attempts', '5', 'Maximum failed login attempts before lockout'),
  ('lockout_duration_minutes', '30', 'Duration of account lockout in minutes'),
  ('session_max_age_days', '7', 'Maximum session age in days'),
  ('audit_retention_days', '90', 'Number of days to retain audit logs')
ON CONFLICT (key) DO NOTHING;
