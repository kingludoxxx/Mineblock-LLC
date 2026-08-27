-- Static ad naming convention: PL - IM001 - Promo - CLAUDE
--
-- Launched ads currently carry names like "Promo - 1", which cannot be traced
-- back to the card that produced them. That blocks the whole iterations idea:
-- a winner in Meta has to resolve to a specific creative before the system can
-- generate variations of it. `ad_name` is also the join key for the Triple Whale
-- revenue queries, so the name IS the analytics primary key.
--
-- Three pieces:
--   1. ad_code      — the product's prefix in ad names ("PL" for Puure).
--                     NOT short_name: that is 'PU' and is used elsewhere in the
--                     UI, and the operator's ad convention is PL.
--   2. creator      — who made the static ("CLAUDE" for tool-generated, an
--                     editor's name for imports).
--   3. im_number    — the stable per-card number, IM001 upward.

ALTER TABLE product_profiles ADD COLUMN IF NOT EXISTS ad_code TEXT;
COMMENT ON COLUMN product_profiles.ad_code IS
  'Short prefix used in launched ad names, e.g. PL. Falls back to short_name.';

ALTER TABLE spy_creatives ADD COLUMN IF NOT EXISTS creator TEXT;
COMMENT ON COLUMN spy_creatives.creator IS
  'Who produced this static — CLAUDE for tool-generated, otherwise the editor.';

-- im_number was UNIQUE GLOBALLY (053), which would make Puure and Mineblock
-- collide at IM001. The product code already disambiguates in the name
-- (PL - IM001 vs MB - IM001), so uniqueness belongs per product. Every
-- im_number is currently NULL, so there is nothing to reconcile.
DROP INDEX IF EXISTS idx_spy_creatives_im_number;
CREATE UNIQUE INDEX IF NOT EXISTS idx_spy_creatives_product_im
  ON spy_creatives(product_id, im_number) WHERE im_number IS NOT NULL;

-- Atomic per-product counter.
--
-- Deliberately NOT `SELECT MAX(im_number)+1`: generation runs three cards
-- concurrently, so two of them would read the same max and race for the same
-- number. The unique index would then reject one card AFTER its image was
-- generated and paid for. An UPSERT that increments and returns in a single
-- statement cannot race.
CREATE TABLE IF NOT EXISTS product_im_counters (
  product_id INTEGER PRIMARY KEY,
  next_im    INTEGER NOT NULL DEFAULT 1,
  updated_at TIMESTAMPTZ DEFAULT NOW()
);

-- Puure's ad prefix.
UPDATE product_profiles SET ad_code = 'PL' WHERE id = 37 AND (ad_code IS NULL OR ad_code = '');
