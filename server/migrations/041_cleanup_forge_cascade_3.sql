-- Migration 041: Third cleanup pass for try-forge.com
--
-- Migration 040 reset the DB; the fixed worker (e0a608d) ran correctly but
-- returned 0 active / 0 pages (no try-forge.com data in ScrapeCreators DB).
--
-- Then commit 9f40f7b (Phase 1.5 no-name-filter) ran a scrape and added 10 false-
-- positive pages via searchCompanies('try-forge') text search: NightForge,
-- CreativeForge, "Trying to forget you", etc.  CreativeForge's Phase 2 stored
-- 26 total ads (all inactive — Phase 2 rootFragment filter blocked active
-- storage, but they still pollute total_ads_count and brand_pages).
--
-- This migration wipes that round so commit 9f40f7c (restored name-match filter)
-- can rebuild cleanly.

DO $$
DECLARE
  forge_brand_id UUID := '659b1f41-7de5-40d1-bb02-83c36aa3589d';
BEGIN
  UPDATE brand_spy.scrape_jobs
     SET status = 'ERROR',
         error_message = 'Aborted: cascade data reset by migration 041',
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

  RAISE NOTICE 'try-forge.com third cleanup complete';
END $$;
