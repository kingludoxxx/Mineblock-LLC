-- 120_create_product_profiles.sql  (S0b-3 migration reset, Lane A)
--
-- product_profiles is the product/brand registry that 14 later migrations
-- depend on (FKs in 017/018/019/022/023/027/084/093; DML in 068/069/070/079/
-- 096/099). Until now it was created ONLY at runtime by
-- server/src/routes/productProfiles.js ensureTable(), so an EMPTY database
-- could not migrate past 017 ("relation product_profiles does not exist").
--
-- This file is the same shape as that ensureTable() — its base CREATE TABLE
-- plus every ADD COLUMN it applies — written as plain idempotent DDL. On a
-- live database where the route already created the table, every statement
-- is a no-op. Placed BEFORE 017_create_spy_custom_images.sql in order.json.
-- Schema only: no rows, no brand values (R15).

CREATE TABLE IF NOT EXISTS product_profiles (
  id SERIAL PRIMARY KEY,
  name TEXT NOT NULL,
  description TEXT,
  price TEXT,
  category TEXT DEFAULT 'supplement',
  logo_url TEXT,
  product_code TEXT,
  logos JSONB DEFAULT '[]',
  fonts JSONB DEFAULT '[]',
  product_images JSONB DEFAULT '[]',
  oneliner TEXT,
  tagline TEXT,
  customer_avatar TEXT,
  customer_frustration TEXT,
  customer_dream TEXT,
  big_promise TEXT,
  mechanism TEXT,
  differentiator TEXT,
  voice TEXT,
  guarantee TEXT,
  benefits JSONB DEFAULT '[]',
  angles JSONB DEFAULT '[]',
  scripts JSONB DEFAULT '[]',
  offers JSONB DEFAULT '[]',
  target_demographics TEXT,
  brand_colors JSONB DEFAULT '{}',
  short_name TEXT,
  product_type TEXT,
  product_group TEXT,
  unit_details TEXT,
  product_url TEXT,
  pain_points TEXT,
  common_objections TEXT,
  winning_angles TEXT,
  custom_angles_text TEXT,
  compliance_restrictions TEXT,
  competitive_edge TEXT,
  offer_details TEXT,
  max_discount TEXT,
  discount_codes TEXT,
  bundle_variants TEXT,
  created_at TIMESTAMP DEFAULT NOW(),
  updated_at TIMESTAMP DEFAULT NOW()
);

-- Columns the route adds to pre-existing tables (same list as ensureTable()).
ALTER TABLE product_profiles ADD COLUMN IF NOT EXISTS logos JSONB DEFAULT '[]';
ALTER TABLE product_profiles ADD COLUMN IF NOT EXISTS fonts JSONB DEFAULT '[]';
ALTER TABLE product_profiles ADD COLUMN IF NOT EXISTS product_code TEXT;
ALTER TABLE product_profiles ADD COLUMN IF NOT EXISTS short_name TEXT;
ALTER TABLE product_profiles ADD COLUMN IF NOT EXISTS product_type TEXT;
ALTER TABLE product_profiles ADD COLUMN IF NOT EXISTS product_group TEXT;
ALTER TABLE product_profiles ADD COLUMN IF NOT EXISTS unit_details TEXT;
ALTER TABLE product_profiles ADD COLUMN IF NOT EXISTS product_url TEXT;
ALTER TABLE product_profiles ADD COLUMN IF NOT EXISTS pain_points TEXT;
ALTER TABLE product_profiles ADD COLUMN IF NOT EXISTS common_objections TEXT;
ALTER TABLE product_profiles ADD COLUMN IF NOT EXISTS winning_angles TEXT;
ALTER TABLE product_profiles ADD COLUMN IF NOT EXISTS custom_angles_text TEXT;
ALTER TABLE product_profiles ADD COLUMN IF NOT EXISTS compliance_restrictions TEXT;
ALTER TABLE product_profiles ADD COLUMN IF NOT EXISTS competitive_edge TEXT;
ALTER TABLE product_profiles ADD COLUMN IF NOT EXISTS offer_details TEXT;
ALTER TABLE product_profiles ADD COLUMN IF NOT EXISTS max_discount TEXT;
ALTER TABLE product_profiles ADD COLUMN IF NOT EXISTS discount_codes TEXT;
ALTER TABLE product_profiles ADD COLUMN IF NOT EXISTS bundle_variants TEXT;
ALTER TABLE product_profiles ADD COLUMN IF NOT EXISTS notes TEXT;
ALTER TABLE product_profiles ADD COLUMN IF NOT EXISTS price_from TEXT;
ALTER TABLE product_profiles ADD COLUMN IF NOT EXISTS key_benefits JSONB DEFAULT '[]';
ALTER TABLE product_profiles ADD COLUMN IF NOT EXISTS avatars JSONB DEFAULT '[]';
ALTER TABLE product_profiles ADD COLUMN IF NOT EXISTS formats JSONB DEFAULT '[]';
ALTER TABLE product_profiles ADD COLUMN IF NOT EXISTS master_brief TEXT;
