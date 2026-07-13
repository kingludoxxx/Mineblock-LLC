-- Add missing columns to product_profiles before Puure insertion
DO $$ BEGIN
  ALTER TABLE product_profiles ADD COLUMN IF NOT EXISTS price_from TEXT;
  ALTER TABLE product_profiles ADD COLUMN IF NOT EXISTS key_benefits JSONB DEFAULT '[]';
  ALTER TABLE product_profiles ADD COLUMN IF NOT EXISTS avatars JSONB DEFAULT '[]';
  ALTER TABLE product_profiles ADD COLUMN IF NOT EXISTS formats JSONB DEFAULT '[]';
EXCEPTION WHEN OTHERS THEN NULL;
END $$;
