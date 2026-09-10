-- 121_creative_analysis_route_columns.sql  (S0b-3 migration reset, Lane A)
--
-- creative_analysis is created by 016, but the columns below were added ONLY
-- at runtime by server/src/routes/creativeAnalysis.js ensureTable() (inside a
-- DO block whose EXCEPTION handler hides failures). Migration 061 builds a
-- partial index on meta_ad_id, so on an EMPTY database the run halted at 061
-- with `column "meta_ad_id" does not exist`.
--
-- Same column list as the route (CREATE TABLE `week` + its ADD COLUMN set),
-- as plain idempotent DDL: a no-op on a live database where the route already
-- added them. Placed after 016 and before 061 in order.json. Schema only.
-- The route's data-dependent constraint swap (creative_id, hook_id[, week])
-- is deliberately NOT replicated here: it depends on live data and stays the
-- route's runtime concern.
ALTER TABLE creative_analysis ADD COLUMN IF NOT EXISTS week TEXT;
ALTER TABLE creative_analysis ADD COLUMN IF NOT EXISTS thumbnail_url TEXT;
ALTER TABLE creative_analysis ADD COLUMN IF NOT EXISTS video_url TEXT;
ALTER TABLE creative_analysis ADD COLUMN IF NOT EXISTS meta_ad_id TEXT;
ALTER TABLE creative_analysis ADD COLUMN IF NOT EXISTS auto_detected BOOLEAN NOT NULL DEFAULT FALSE;
ALTER TABLE creative_analysis ADD COLUMN IF NOT EXISTS ad_account_id TEXT;
ALTER TABLE creative_analysis ADD COLUMN IF NOT EXISTS ad_account_name TEXT;
