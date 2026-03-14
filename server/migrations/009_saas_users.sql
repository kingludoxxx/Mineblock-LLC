-- SaaS platform: extend users table with new columns
-- Adds role enum, avatar, timezone, email verification, and password reset fields.

DO $$
BEGIN
  -- Create role enum type if it doesn't exist
  IF NOT EXISTS (SELECT 1 FROM pg_type WHERE typname = 'user_role') THEN
    CREATE TYPE user_role AS ENUM ('admin', 'member', 'viewer');
  END IF;
END
$$;

ALTER TABLE users
  ADD COLUMN IF NOT EXISTS role user_role NOT NULL DEFAULT 'member',
  ADD COLUMN IF NOT EXISTS avatar_url TEXT,
  ADD COLUMN IF NOT EXISTS timezone VARCHAR(64) DEFAULT 'UTC',
  ADD COLUMN IF NOT EXISTS email_verified BOOLEAN DEFAULT false,
  ADD COLUMN IF NOT EXISTS email_verify_token VARCHAR(255),
  ADD COLUMN IF NOT EXISTS password_reset_token VARCHAR(255),
  ADD COLUMN IF NOT EXISTS password_reset_expires TIMESTAMPTZ;
