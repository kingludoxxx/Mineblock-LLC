-- Migration 043: Remove thegreatprojects.com contamination from thegreatproject.com
--
-- Root cause: Phase 1d + Phase 2 filters used url.includes('thegreatproject') — a
-- string-contains check. This matched 'thegreatprojects.com' (note the 's') which is
-- a different company ("The Great Projects"). 316 of the 358 active ads correctly
-- link to try.thegreatproject.com; the other 42 link to thegreatprojects.com and
-- should not be attributed to this brand.
--
-- Fix (commit after this migration): linkBelongsToBrand() uses hostname boundary check
-- (hostname === domain OR hostname.endsWith('.'+domain)) which enforces a hard domain
-- boundary — thegreatprojects.com fails this test, try.thegreatproject.com passes.

DO $$
DECLARE
  tgp_brand_id UUID := '07aff126-e2bc-4e8b-8a8c-fc37a670e818';
  deleted_ads   INT;
  deleted_pages INT;
  deleted_doms  INT;
BEGIN

  -- Step 1: Delete ads whose link_url hostname is NOT thegreatproject.com or *.thegreatproject.com
  -- Keeps: link_url IS NULL (unlabelled brand ads), thegreatproject.com, try.thegreatproject.com, etc.
  -- Removes: thegreatprojects.com (different company)
  DELETE FROM brand_spy.ad_rank_snapshots
   WHERE ad_id IN (
     SELECT id FROM brand_spy.ads
      WHERE brand_id = tgp_brand_id
        AND link_url IS NOT NULL
        AND lower(split_part(regexp_replace(link_url, '^https?://(www\.)?', '', 'i'), '/', 1))
              NOT IN ('thegreatproject.com')
        AND lower(split_part(regexp_replace(link_url, '^https?://(www\.)?', '', 'i'), '/', 1))
              NOT LIKE '%.thegreatproject.com'
   );

  DELETE FROM brand_spy.ads
   WHERE brand_id = tgp_brand_id
     AND link_url IS NOT NULL
     AND lower(split_part(regexp_replace(link_url, '^https?://(www\.)?', '', 'i'), '/', 1))
           NOT IN ('thegreatproject.com')
     AND lower(split_part(regexp_replace(link_url, '^https?://(www\.)?', '', 'i'), '/', 1))
           NOT LIKE '%.thegreatproject.com';

  GET DIAGNOSTICS deleted_ads = ROW_COUNT;
  RAISE NOTICE 'Deleted % sibling-domain ads from thegreatproject', deleted_ads;

  -- Step 2: Delete brand_pages that now have zero ads
  DELETE FROM brand_spy.brand_pages bp
   WHERE bp.brand_id = tgp_brand_id
     AND NOT EXISTS (
       SELECT 1 FROM brand_spy.ads WHERE brand_page_id = bp.id
     );

  GET DIAGNOSTICS deleted_pages = ROW_COUNT;
  RAISE NOTICE 'Deleted % orphaned pages', deleted_pages;

  -- Step 3: Delete brand_domains that are not thegreatproject.com or *.thegreatproject.com
  DELETE FROM brand_spy.brand_domains
   WHERE brand_id = tgp_brand_id
     AND domain NOT IN ('thegreatproject.com')
     AND domain NOT LIKE '%.thegreatproject.com';

  GET DIAGNOSTICS deleted_doms = ROW_COUNT;
  RAISE NOTICE 'Deleted % unrelated brand_domains', deleted_doms;

  -- Step 4: Recompute page rollup counts
  UPDATE brand_spy.brand_pages bp SET
    active_ads_count = COALESCE((
      SELECT COUNT(*) FROM brand_spy.ads WHERE brand_page_id = bp.id AND is_active = TRUE
    ), 0),
    total_ads_count = COALESCE((
      SELECT COUNT(*) FROM brand_spy.ads WHERE brand_page_id = bp.id
    ), 0)
  WHERE bp.brand_id = tgp_brand_id;

  -- Step 5: Recompute brand-level counters
  UPDATE brand_spy.brands SET
    active_ads_count = (SELECT COUNT(*) FROM brand_spy.ads WHERE brand_id = tgp_brand_id AND is_active = TRUE),
    total_ads_count  = (SELECT COUNT(*) FROM brand_spy.ads WHERE brand_id = tgp_brand_id),
    pages_count      = (SELECT COUNT(*) FROM brand_spy.brand_pages WHERE brand_id = tgp_brand_id),
    domains_count    = (SELECT COUNT(*) FROM brand_spy.brand_domains WHERE brand_id = tgp_brand_id),
    last_scrape_status = 'DONE',
    last_scrape_error  = NULL
  WHERE id = tgp_brand_id;

  RAISE NOTICE 'thegreatproject.com sibling-domain cleanup complete';
END $$;
