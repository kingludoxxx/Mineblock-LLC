-- SaaS platform: add token_hash to sessions (rename refresh_token_hash -> token_hash)
-- The existing sessions table already has most of what we need. Just add token_hash alias.

ALTER TABLE sessions
  ADD COLUMN IF NOT EXISTS token_hash VARCHAR(255);

-- Backfill token_hash from refresh_token_hash for existing rows
UPDATE sessions SET token_hash = refresh_token_hash WHERE token_hash IS NULL AND refresh_token_hash IS NOT NULL;
