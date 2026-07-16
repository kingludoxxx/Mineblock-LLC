-- Add product_image_index to spy_creatives so the statics tool can persist
-- WHICH product shot was used for each generation and honor that same shot
-- on regeneration + iteration (else iterations silently collapse back to
-- product_images[0] — the bug the multi-product brief calls out at line 264).
--
-- Default 0 = existing behavior (image #1). Safe backfill: every existing
-- row was implicitly index 0 anyway, so 0 is the correct historical value.
--
-- Non-negative INT; nullable=false with default so the app never has to
-- coalesce; callers that omit the field just get 0.

ALTER TABLE spy_creatives
  ADD COLUMN IF NOT EXISTS product_image_index INT NOT NULL DEFAULT 0;
