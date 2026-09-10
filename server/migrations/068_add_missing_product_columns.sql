-- Add missing columns to product_profiles before the product insertion in 069.
--
-- S0b-3 (Lane A): the former DO $$ … EXCEPTION WHEN OTHERS THEN NULL wrapper
-- swallowed EVERY failure, including "relation product_profiles does not exist"
-- on a fresh database. product_profiles is now created by
-- 120_create_product_profiles.sql (ordered before this file in order.json), so
-- these are plain statements: idempotent via IF NOT EXISTS, and any other
-- failure is VISIBLE and halts the run.
ALTER TABLE product_profiles ADD COLUMN IF NOT EXISTS price_from TEXT;
ALTER TABLE product_profiles ADD COLUMN IF NOT EXISTS key_benefits JSONB DEFAULT '[]';
ALTER TABLE product_profiles ADD COLUMN IF NOT EXISTS avatars JSONB DEFAULT '[]';
ALTER TABLE product_profiles ADD COLUMN IF NOT EXISTS formats JSONB DEFAULT '[]';
