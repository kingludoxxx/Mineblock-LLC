-- ─────────────────────────────────────────────────────────────────────────────
-- 094_league_import_flexibility — import references that are not just BANGERs
--
-- The FROM LEAGUE / TO GENERATE import hardcoded three narrowing rules with no
-- way for the operator to change them:
--
--   a.is_active = TRUE                  -- only ads running RIGHT NOW
--   a.display_format ILIKE 'image%'     -- only plain images
--   ORDER BY tier_score DESC            -- only "best performing" first
--
-- Measured on mydermadream.com, those three cost 91% of the available library:
--   BANGER/CHAMP/A + image% + active ...  9 distinct creatives
--   all tiers      + image% + active ... 28
--   all tiers      + ALL_STATIC + active 100 (query cap)
--
-- display_format was the single biggest exclusion: most of that brand's statics
-- are carousel/dco/dpa, not plain 'image'. And "longest running" — the operator's
-- actual proxy for a proven promo — was unreachable, because a long-running ad
-- that has since ended fails is_active, and ordering by tier_score never surfaces
-- it anyway.
--
-- All three are now per-brand settings. Defaults reproduce the previous
-- behaviour EXACTLY, so no followed brand changes what it imports until the
-- operator opts in.
-- ─────────────────────────────────────────────────────────────────────────────

-- How candidates are ranked before the top_pct / manual-count slice is taken.
--   tier_score      → tier_score DESC, current_rank ASC   (previous behaviour)
--   longest_running → active_days DESC                    (proven staying power)
--   newest          → start_date DESC                     (what they just launched)
ALTER TABLE league_brand_configs
  ADD COLUMN IF NOT EXISTS sort_mode TEXT NOT NULL DEFAULT 'tier_score';

-- Which creative formats count as a static.
--   IMAGE      → display_format ILIKE 'image%'                  (previous behaviour)
--   ALL_STATIC → any non-video format: image, carousel, dco, dpa
--   CAROUSEL   → carousel only
ALTER TABLE league_brand_configs
  ADD COLUMN IF NOT EXISTS format_filter TEXT NOT NULL DEFAULT 'IMAGE';

-- FALSE keeps the old is_active = TRUE gate. TRUE also considers ads that have
-- stopped running — which is where the long-running historical winners live.
ALTER TABLE league_brand_configs
  ADD COLUMN IF NOT EXISTS include_inactive BOOLEAN NOT NULL DEFAULT FALSE;

-- Constraints added defensively: if a value outside the allowed set somehow
-- exists, skip the constraint and say so rather than failing the boot. The route
-- layer validates these too.
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'league_brand_configs_sort_mode_check') THEN
    IF NOT EXISTS (SELECT 1 FROM league_brand_configs
                    WHERE sort_mode NOT IN ('tier_score','longest_running','newest')) THEN
      ALTER TABLE league_brand_configs
        ADD CONSTRAINT league_brand_configs_sort_mode_check
        CHECK (sort_mode IN ('tier_score','longest_running','newest'));
    ELSE
      RAISE NOTICE '094: sort_mode CHECK skipped — unexpected values present';
    END IF;
  END IF;

  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'league_brand_configs_format_filter_check') THEN
    IF NOT EXISTS (SELECT 1 FROM league_brand_configs
                    WHERE format_filter NOT IN ('IMAGE','ALL_STATIC','CAROUSEL')) THEN
      ALTER TABLE league_brand_configs
        ADD CONSTRAINT league_brand_configs_format_filter_check
        CHECK (format_filter IN ('IMAGE','ALL_STATIC','CAROUSEL'));
    ELSE
      RAISE NOTICE '094: format_filter CHECK skipped — unexpected values present';
    END IF;
  END IF;
END $$;

COMMENT ON COLUMN league_brand_configs.sort_mode IS
  'Candidate ranking before the top_pct slice: tier_score (default) | longest_running | newest.';
COMMENT ON COLUMN league_brand_configs.format_filter IS
  'Which formats count as a static: IMAGE (default) | ALL_STATIC (any non-video) | CAROUSEL.';
COMMENT ON COLUMN league_brand_configs.include_inactive IS
  'FALSE (default) imports only currently-running ads. TRUE also considers ended ads, where long-running historical winners live.';

-- Long-running lookups scan by brand + active_days; without this the new sort
-- mode does a seq scan on every sync.
CREATE INDEX IF NOT EXISTS idx_brand_spy_ads_brand_active_days
  ON brand_spy.ads (brand_id, active_days DESC NULLS LAST);

CREATE INDEX IF NOT EXISTS idx_brand_spy_ads_brand_start_date
  ON brand_spy.ads (brand_id, start_date DESC NULLS LAST);
