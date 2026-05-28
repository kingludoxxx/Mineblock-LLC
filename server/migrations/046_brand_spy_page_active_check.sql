-- Track when each FB page was last checked for active ads.
-- Used by the brand-spy worker to skip Phase 2 ACTIVE on pages that have
-- consistently returned 0 active ads — re-checking once a week instead of
-- every scrape saves ~1 credit per dead page per scrape.

ALTER TABLE brand_spy.brand_pages
  ADD COLUMN IF NOT EXISTS last_active_check_at TIMESTAMPTZ;

-- Index unnecessary — the column is only ever read per single page id at
-- start of Phase 2, which already uses the primary-key lookup.

COMMENT ON COLUMN brand_spy.brand_pages.last_active_check_at IS
  'When the brand-spy worker last actually ran a Phase 2 ACTIVE pass on this page. NULL means never; a value <6d old combined with active_ads_count=0 triggers the dead-page skip optimisation.';
