-- Team invitations: real invite flow (email→link→accept→activate).
--
-- A "Pending" invitee has a row in `users` with:
--   password_hash IS NULL          — no login until they accept
--   is_active = false              — not yet counted as a real user
--   email_verified = false         — implicit; verified on accept
--   password_reset_token IS NOT NULL AND password_reset_expires > NOW()
--
-- We reuse the existing password_reset_token / password_reset_expires
-- columns for the invite token — same crypto pattern as forgot-password
-- (32-byte random hex, sha256-stored, 7-day expiry).

-- password_hash was NOT NULL. Now nullable so a Pending user can exist
-- before they've set a password.
ALTER TABLE users
  ALTER COLUMN password_hash DROP NOT NULL;

-- Audit trail — who invited them, when.
ALTER TABLE users
  ADD COLUMN IF NOT EXISTS invited_at TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS invited_by UUID REFERENCES users(id);

-- Speed up the accept-invite lookup (`WHERE password_reset_token = $1`).
-- The old reset-password path did a seq scan; low-volume so it didn't
-- matter, but invites will use the same column and this is cheap.
CREATE INDEX IF NOT EXISTS idx_users_password_reset_token
  ON users (password_reset_token)
  WHERE password_reset_token IS NOT NULL;
