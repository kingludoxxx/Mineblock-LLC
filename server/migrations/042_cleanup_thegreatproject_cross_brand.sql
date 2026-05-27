-- Migration 042: Purge cross-brand contamination from thegreatproject.com
--
-- Root cause: Phase 2's filterBatch was `(batch) => batch` for non-Meta pages.
-- Pages like "USA Ready Families" run ads for multiple brands simultaneously
-- (thegreatproject.com, tonicgympro.com, dailynationalnews.com, try-melina.com, etc.).
-- Without a link_url filter, ALL their ads were stored under thegreatproject's brand_id,
-- inflating active counts (363 vs ~320 actual) and adding unrelated brand_domains
-- (tonicgympro.com, kevin-lennon.com, mentoday.co, etc.) to thegreatproject's profile.
--
-- Fix (commit after this migration): filterBatch now applies rootFragment filter to ALL
-- Phase 2 pages. This migration cleans up the data already written by the broken runs.

DO $$
DECLARE
  tgp_brand_id UUID := '07aff126-e2bc-4e8b-8a8c-fc37a670e818';
  deleted_ads  INT;
  deleted_pages INT;
  deleted_domains INT;
BEGIN

  -- Step 1: Delete ads whose link_url is set but does NOT point to thegreatproject
  -- (ads with NULL link_url are kept — they may be legitimately brand-related)
  DELETE FROM brand_spy.ad_rank_snapshots
   WHERE ad_id IN (
     SELECT id FROM brand_spy.ads
      WHERE brand_id = tgp_brand_id
        AND link_url IS NOT NULL
        AND LOWER(link_url) NOT LIKE '%thegreatproject%'
   );

  DELETE FROM brand_spy.ads
   WHERE brand_id = tgp_brand_id
     AND link_url IS NOT NULL
     AND LOWER(link_url) NOT LIKE '%thegreatproject%';

  GET DIAGNOSTICS deleted_ads = ROW_COUNT;
  RAISE NOTICE 'Deleted % cross-brand ads from thegreatproject', deleted_ads;

  -- Step 2: Delete brand_pages that now have zero ads under thegreatproject
  DELETE FROM brand_spy.brand_pages bp
   WHERE bp.brand_id = tgp_brand_id
     AND NOT EXISTS (
       SELECT 1 FROM brand_spy.ads WHERE brand_page_id = bp.id
     );

  GET DIAGNOSTICS deleted_pages = ROW_COUNT;
  RAISE NOTICE 'Deleted % orphaned brand_pages from thegreatproject', deleted_pages;

  -- Step 3: Delete brand_domains that don't belong to thegreatproject
  -- Keep: thegreatproject.com (primary), try.thegreatproject.com (subdomain),
  --        thegreatprojects.com (contains 'thegreatproject' — likely related brand)
  DELETE FROM brand_spy.brand_domains
   WHERE brand_id = tgp_brand_id
     AND LOWER(domain) NOT LIKE '%thegreatproject%';

  GET DIAGNOSTICS deleted_domains = ROW_COUNT;
  RAISE NOTICE 'Deleted % unrelated brand_domains from thegreatproject', deleted_domains;

  -- Step 4: Recompute page rollup counts
  UPDATE brand_spy.brand_pages bp SET
    active_ads_count = COALESCE((
      SELECT COUNT(*) FROM brand_spy.ads WHERE brand_page_id = bp.id AND is_active = TRUE
    ), 0),
    total_ads_count = COALESCE((
      SELECT COUNT(*) FROM brand_spy.ads WHERE brand_page_id = bp.id
    ), 0)
  WHERE bp.brand_id = tgp_brand_id;

  -- Step 5: Recompute brand-level counters from surviving ads
  UPDATE brand_spy.brands SET
    active_ads_count = (SELECT COUNT(*) FROM brand_spy.ads WHERE brand_id = tgp_brand_id AND is_active = TRUE),
    total_ads_count  = (SELECT COUNT(*) FROM brand_spy.ads WHERE brand_id = tgp_brand_id),
    pages_count      = (SELECT COUNT(*) FROM brand_spy.brand_pages WHERE brand_id = tgp_brand_id),
    domains_count    = (SELECT COUNT(*) FROM brand_spy.brand_domains WHERE brand_id = tgp_brand_id),
    last_scrape_status = 'DONE',
    last_scrape_error  = NULL
  WHERE id = tgp_brand_id;

  RAISE NOTICE 'thegreatproject.com cross-brand cleanup complete';
END $$;
