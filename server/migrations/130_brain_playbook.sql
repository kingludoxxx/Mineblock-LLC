-- 130_brain_playbook.sql  (HUB — S4-SB, layer 3: the PLAYBOOK)
--
-- The curated, per-product layer a pipeline is allowed to read: avatars, allowed
-- and forbidden claims, angle bank, hook bank, brand voice rules, visual bible,
-- proof assets, competitor set, offers, checkout link. product_profiles (120) stays
-- the product registry; the playbook is its editorial extension, written ONLY
-- through the wizard/API and read by pipelines.
--
-- Shape: one row per (product_code, section, key) rather than a column per field,
-- because the field list is EDITORIAL and grows without a migration — and because
-- R15 forbids naming a product's fields in engine code. Sections are validated at
-- the API from one list in the service, not by a CHECK a migration would freeze.
--
-- Every field can CITE insights: playbook_citations. A pipeline that reads a field
-- can name the approved insights behind it (R16).

CREATE TABLE IF NOT EXISTS playbook_products (
  product_code   TEXT PRIMARY KEY,        -- data (R5), validated against PRODUCT_CODES_JSON
  version        INTEGER NOT NULL DEFAULT 1,
  locked_at      TIMESTAMPTZ,             -- a LOCKED version is what pipelines quote (R16)
  locked_by      TEXT,
  checkout_url   TEXT,
  notes          TEXT,
  created_at     TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at     TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS playbook_entries (
  id            BIGSERIAL PRIMARY KEY,
  product_code  TEXT NOT NULL REFERENCES playbook_products(product_code) ON DELETE CASCADE,
  section       TEXT NOT NULL,   -- avatars | allowed_claims | forbidden_claims | angles |
                                 -- hooks | voice_rules | visual_bible | proof_assets |
                                 -- competitors | offers
  entry_key     TEXT NOT NULL,   -- stable id inside the section
  position      INTEGER NOT NULL DEFAULT 0,
  value         JSONB NOT NULL DEFAULT '{}'::jsonb,
  updated_by    TEXT,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at    TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (product_code, section, entry_key)
);
CREATE INDEX IF NOT EXISTS playbook_entries_product_section_idx
  ON playbook_entries (product_code, section, position);

CREATE TABLE IF NOT EXISTS playbook_citations (
  entry_id    BIGINT NOT NULL REFERENCES playbook_entries(id) ON DELETE CASCADE,
  insight_id  BIGINT NOT NULL REFERENCES kb_insights(id)      ON DELETE CASCADE,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  PRIMARY KEY (entry_id, insight_id)
);
CREATE INDEX IF NOT EXISTS playbook_citations_insight_idx ON playbook_citations (insight_id);

-- Global research (brand-spy) stays GLOBAL. A store does not copy the global row:
-- it saves its own insight and records which global record it came from, so the
-- link is auditable and the global corpus is never forked.
ALTER TABLE kb_insights ADD COLUMN IF NOT EXISTS global_ref_kind TEXT;
ALTER TABLE kb_insights ADD COLUMN IF NOT EXISTS global_ref_id   TEXT;
CREATE INDEX IF NOT EXISTS kb_insights_global_ref_idx
  ON kb_insights (global_ref_kind, global_ref_id)
  WHERE global_ref_kind IS NOT NULL;
