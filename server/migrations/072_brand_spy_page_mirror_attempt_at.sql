-- Follow-up to 071: track when we last attempted to mirror a page's
-- profile pic to R2. Migration 071 shipped without this column and its
-- filename was already recorded in _migrations, so editing 071 in place
-- was a no-op — hence this separate 072.
--
-- Purpose: prevent the mirror worker from hot-looping on the same 8
-- brand_pages every 30s when their fbcdn URLs are permanently 403.

ALTER TABLE brand_spy.brand_pages
  ADD COLUMN IF NOT EXISTS page_profile_pic_r2_attempted_at TIMESTAMPTZ;
