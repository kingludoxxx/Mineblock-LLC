-- Migration 039: Clean up cascade-polluted data for try-forge.com
--
-- Root cause: deploy 8fd071a introduced Phase 1d (root-fragment keyword search)
-- and unconstrained Phase 1c/3 cross-domain expansion. This caused a runaway
-- cascade: Phase 2 on "Instagram for Business" (a Meta generic page that advertises
-- hundreds of brands) stored thousands of unrelated ads under try-forge.com, whose
-- link_urls then drove Phase 1c/3 into discovering 3030 completely irrelevant pages
-- (Jungle Marble Blast 2, blinkit, UKF, etc.).
--
-- This migration wipes all try-forge.com pages, ads, and domains so the next
-- scrape (with the fixed 2a84805 worker code) starts from a clean slate.
-- Deploy 2a84805 fixes the root cause; this migration cleans the symptom.

DO $$
DECLARE
  forge_brand_id UUID := '659b1f41-7de5-40d1-bb02-83c36aa3589d';
  del_snapshots  INT;
  del_ads        INT;
  del_pages      INT;
  del_domains    INT;
BEGIN
  -- Abort any stuck RUNNING scrape job so the next POST /scrape starts fresh
  UPDATE brand_spy.scrape_jobs
     SET status = 'ERROR',
         error_message = 'Aborted: cascade data reset by migration 039',
         finished_at   = NOW()
   WHERE brand_id = forge_brand_id AND status = 'RUNNING';

  -- Delete tier snapshots first (FK: ad_id → ads)
  DELETE FROM brand_spy.ad_rank_snapshots WHERE brand_id = forge_brand_id;
  GET DIAGNOSTICS del_snapshots = ROW_COUNT;

  -- Delete all ads (FK: brand_page_id → brand_pages)
  DELETE FROM brand_spy.ads WHERE brand_id = forge_brand_id;
  GET DIAGNOSTICS del_ads = ROW_COUNT;

  -- Delete all pages
  DELETE FROM brand_spy.brand_pages WHERE brand_id = forge_brand_id;
  GET DIAGNOSTICS del_pages = ROW_COUNT;

  -- Delete all domain entries (will rebuild from next scrape)
  DELETE FROM brand_spy.brand_domains WHERE brand_id = forge_brand_id;
  GET DIAGNOSTICS del_domains = ROW_COUNT;

  -- Reset brand counters and status so UI shows clean state
  UPDATE brand_spy.brands
     SET active_ads_count  = 0,
         total_ads_count   = 0,
         last_scrape_status = 'DONE',
         last_scrape_error  = NULL,
         banger_count  = 0, champ_count = 0,
         tier_a_count  = 0, tier_b_count = 0,
         tier_c_count  = 0, tier_low_count = 0, tier_test_count = 0
   WHERE id = forge_brand_id;

  RAISE NOTICE 'try-forge.com cleanup: % snapshots, % ads, % pages, % domains deleted',
    del_snapshots, del_ads, del_pages, del_domains;
END $$;
