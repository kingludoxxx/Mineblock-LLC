-- Transparent product cutouts, one per product image.
--
-- The renderer redraws the product from a reference photo on every card. It is
-- reliable on a hero shot and unreliable everywhere else: a cross-section
-- diagram came back with a featureless white puck standing in for the real
-- multi-part device. Prompting cannot fix redrawing — a designer places the
-- asset rather than redrawing it. This column holds that asset.
--
-- Shape: [{ "source": "<product_images url>", "url": "<r2 cutout url>",
--           "created_at": "<iso>", "transparent_ratio": 0.61 }]
--
-- Keyed by source URL so a product image that changes invalidates only its own
-- cutout, and so regenerating is an explicit act rather than a side effect.
--
-- Numbered 096: 094 is already duplicated in this repo (094_brief_job_fit and
-- 094_league_import_flexibility) and 095 is taken on main, so 096 is the first
-- unambiguously free slot. The runner sorts by filename and tracks applied
-- migrations by unique filename, so duplicates do not collide — but they do
-- make ordering ambiguous, which is worth not adding to.

ALTER TABLE product_profiles
  ADD COLUMN IF NOT EXISTS product_cutouts JSONB DEFAULT '[]'::jsonb;

COMMENT ON COLUMN product_profiles.product_cutouts IS
  'Transparent PNG cutouts derived from product_images, for compositing onto generated statics.';
