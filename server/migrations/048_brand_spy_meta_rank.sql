-- Capture each ad's position in Meta's impression-sorted ad library.
-- ScrapeCreators' /search/ads endpoint returns results ordered by
-- total_impressions DESC; the order we receive each ad IS Meta's
-- impression rank for that brand search. Store it so scoreBrand can use
-- it as the primary ranking signal instead of total_active_time (which
-- favors old ads and makes BANGER nearly impossible to achieve).

ALTER TABLE brand_spy.ads
  ADD COLUMN IF NOT EXISTS meta_rank INTEGER;

COMMENT ON COLUMN brand_spy.ads.meta_rank IS
  'Position of this ad in the brand-keyword search results sorted by total_impressions DESC (1 = top impressions). NULL means the ad was never observed inside Phase 1d''s capture window. Used by scoreBrand as the primary tier-ranking signal.';
