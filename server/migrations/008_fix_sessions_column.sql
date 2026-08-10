-- Rename refresh_token_hash -> token_hash.
--
-- Guarded for the same reason as 005: on a forked database the schema arrives
-- by pg_dump already carrying token_hash, while the `_migrations` ledger is
-- empty, so this file re-runs. A bare ALTER ... RENAME then throws
-- "column refresh_token_hash does not exist" and halts the whole migration run.
-- Rename only when there is something to rename and nothing to collide with.
DO $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM information_schema.columns
     WHERE table_schema = 'public' AND table_name = 'sessions' AND column_name = 'refresh_token_hash'
  ) AND NOT EXISTS (
    SELECT 1 FROM information_schema.columns
     WHERE table_schema = 'public' AND table_name = 'sessions' AND column_name = 'token_hash'
  ) THEN
    ALTER TABLE sessions RENAME COLUMN refresh_token_hash TO token_hash;
  END IF;
END $$;
