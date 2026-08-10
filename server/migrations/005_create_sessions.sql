CREATE TABLE IF NOT EXISTS sessions (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  refresh_token_hash VARCHAR(255) NOT NULL,
  ip_address INET,
  user_agent TEXT,
  expires_at TIMESTAMPTZ NOT NULL,
  created_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_sessions_user_id ON sessions(user_id);
CREATE INDEX IF NOT EXISTS idx_sessions_expires_at ON sessions(expires_at);

-- The column this indexes is renamed to token_hash by 008. On a database whose
-- schema arrived by pg_dump rather than by running these migrations (a forked
-- instance), `sessions` already exists in its POST-008 shape while the
-- `_migrations` ledger is empty — so this file re-runs and the index statement
-- referenced a column that is no longer there. That threw 42703, and because
-- 005 legitimately creates schema the runner refused to skip it, halting every
-- later migration ("SCHEMA IS INCOMPLETE").
-- Guard on the column actually being present so the file is correct on a fresh
-- database AND a no-op on one that is already past 008.
DO $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM information_schema.columns
     WHERE table_schema = 'public'
       AND table_name = 'sessions'
       AND column_name = 'refresh_token_hash'
  ) THEN
    CREATE INDEX IF NOT EXISTS idx_sessions_refresh_token_hash ON sessions(refresh_token_hash);
  END IF;
END $$;
