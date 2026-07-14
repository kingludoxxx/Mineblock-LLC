-- Brand Spy: store R2-mirrored versions of ad videos, thumbnails, and page
-- profile pics so the UI never depends on Meta's fbcdn URLs (which carry an
-- `oe=` expiry and 403 ~2-4 weeks after scrape).
--
-- Flow:
--   1. Worker upserts ad with fbcdn URLs as before
--   2. A background mirror job downloads each asset once and uploads to R2
--   3. Writes the R2 URL back into these columns and stamps assets_mirrored_at
--   4. SELECTs prefer the R2 column via COALESCE; fbcdn is a fallback for
--      new-but-not-yet-mirrored ads
--
-- Storage estimate at fleet scale: ~5k active ads × ~2 MB video + ~200 KB
-- thumb + ~100 profile pics × 20 KB ≈ 12 GB total (~$0.20/mo on R2).

ALTER TABLE brand_spy.ads
  ADD COLUMN IF NOT EXISTS video_url_r2       TEXT,
  ADD COLUMN IF NOT EXISTS thumbnail_url_r2   TEXT,
  ADD COLUMN IF NOT EXISTS assets_mirrored_at TIMESTAMPTZ;

ALTER TABLE brand_spy.brand_pages
  ADD COLUMN IF NOT EXISTS page_profile_pic_r2       TEXT,
  ADD COLUMN IF NOT EXISTS page_profile_pic_r2_attempted_at TIMESTAMPTZ;

-- Index the mirror-pending set. The background worker queries
-- WHERE video_url IS NOT NULL AND video_url_r2 IS NULL AND is_active = TRUE
-- every ~30s; without an index it does a seq scan on a 30k-row table.
CREATE INDEX IF NOT EXISTS ads_mirror_pending_idx
  ON brand_spy.ads (is_active, assets_mirrored_at)
  WHERE video_url_r2 IS NULL OR thumbnail_url_r2 IS NULL;
