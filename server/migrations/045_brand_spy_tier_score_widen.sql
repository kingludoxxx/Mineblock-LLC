-- Migration 045: widen tier_score from NUMERIC(6,3) to INTEGER
-- NUMERIC(6,3) overflows for brands with ≥ 1000 active ads:
-- tierScore = poolSize - rank + 1; top ad on a 1289-pool brand = 1289 > 999.999
-- Column is always a whole positive number so INTEGER is the correct type.

ALTER TABLE brand_spy.ads
  ALTER COLUMN tier_score TYPE INTEGER USING tier_score::INTEGER;
