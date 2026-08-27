-- A-series #2: persistent STYLE per scraped ad, so "give me promos" becomes a
-- database filter instead of a per-run triage question, and the League UI can
-- filter by style. Classified once by a batch job; NULL = not yet classified.
ALTER TABLE brand_spy.ads ADD COLUMN IF NOT EXISTS style TEXT;
CREATE INDEX IF NOT EXISTS ads_style_idx ON brand_spy.ads (style) WHERE style IS NOT NULL;

-- A-series #1 (decision-free slice): the operator can mark a launched brief's
-- real-world outcome. This is the seed of the performance loop — whichever
-- source (Meta API or manual marking) is chosen later, the column is the same.
ALTER TABLE brief_pipeline_generated ADD COLUMN IF NOT EXISTS outcome TEXT
  CHECK (outcome IN ('won','lost') OR outcome IS NULL);
