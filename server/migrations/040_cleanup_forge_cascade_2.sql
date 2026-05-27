-- Migration 040: Second cleanup pass for try-forge.com
--
-- Migration 039 reset active_ads_count and total_ads_count but missed
-- domains_count and pages_count.  A subsequent scrape with Phase 1.5 still
-- using the generic "forge" prefix-stripped keyword found 27 wrong pages
-- (Forge of Empires, Forge Men, Dr. Michael Reed, Forgeurban, etc.) and
-- stored 568 irrelevant active ads.
--
-- This migration wipes try-forge.com back to a clean slate again so the
-- fixed Phase 1.5 (full domain name only, normalised match — see 507f0dd)
-- can rebuild correctly.

DO $$
DECLARE
  forge_brand_id UUID := '659b1f41-7de5-40d1-bb02-83c36aa3589d';
BEGIN
  UPDATE brand_spy.scrape_jobs
     SET status = 'ERROR',
         error_message = 'Aborted: cascade data reset by migration 040',
         finished_at   = NOW()
   WHERE brand_id = forge_brand_id AND status = 'RUNNING';

  DELETE FROM brand_spy.ad_rank_snapshots WHERE brand_id = forge_brand_id;
  DELETE FROM brand_spy.ads              WHERE brand_id = forge_brand_id;
  DELETE FROM brand_spy.brand_pages      WHERE brand_id = forge_brand_id;
  DELETE FROM brand_spy.brand_domains    WHERE brand_id = forge_brand_id;

  UPDATE brand_spy.brands
     SET active_ads_count  = 0,
         total_ads_count   = 0,
         pages_count       = 0,
         domains_count     = 0,
         last_scrape_status = 'DONE',
         last_scrape_error  = NULL,
         banger_count  = 0, champ_count = 0,
         tier_a_count  = 0, tier_b_count = 0,
         tier_c_count  = 0, tier_low_count = 0, tier_test_count = 0
   WHERE id = forge_brand_id;

  RAISE NOTICE 'try-forge.com second cleanup complete';
END $$;
