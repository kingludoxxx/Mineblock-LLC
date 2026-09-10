-- 128_brain_kb_core.sql  (HUB — S4-SB, the Store Brain: RAW SOURCES + INSIGHTS)
--
-- One Brain per store, inside THAT store's own Postgres. Isolation is PHYSICAL:
-- there is no store_id column and no shared knowledge table anywhere, so a query
-- written against this schema can only ever see this database's rows. Migration
-- 123/124 still tag every row with the database's own STORE_CODE for the audit
-- trail; that tag is never a retrieval filter (see docs/BRAIN.md).
--
-- Layer 1 RAW SOURCES  — kb_documents: every scraped/imported document AS CAPTURED,
--   immutable. The BODY lives in the bucket under knowledge/raw/<source>/<date>/;
--   body_text is the extracted text kept for search. Idempotent by content_hash.
-- Layer 2 INSIGHTS     — kb_insights: typed facts with provenance, each linked to the
--   raw documents it came from (kb_insight_sources). Nothing is used by a pipeline
--   until a human sets status='approved' (R16).
--
-- Schema only. No product, store or brand literal (R15): product_code is DATA,
-- validated at the API against PRODUCT_CODES_JSON, never against a list in SQL.
-- Additive and idempotent (R6): every statement is IF NOT EXISTS / guarded.

CREATE TABLE IF NOT EXISTS kb_documents (
  id                BIGSERIAL PRIMARY KEY,
  content_hash      TEXT NOT NULL,            -- sha256 of the captured bytes; idempotency key
  source            TEXT NOT NULL,            -- 'reddit', 'trustpilot', 'operator research', ...
  source_ref        TEXT,                     -- id/permalink inside that source, when it has one
  url               TEXT,
  title             TEXT,
  body_text         TEXT NOT NULL DEFAULT '',
  body_object_key   TEXT,                     -- bucket key: knowledge/raw/<source>/<date>/<hash>
  content_type      TEXT NOT NULL DEFAULT 'text/plain',
  byte_size         INTEGER,
  lang              TEXT,
  product_code      TEXT,                     -- data (R5/R15), validated at the API
  captured_at       TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  scrape_job_id     TEXT,
  ingested_by       TEXT,                     -- user id or service name that wrote the row
  metadata          JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at        TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- Idempotency (POST /brain/ingest is idempotent by content hash). The same text
-- captured for TWO products is two documents; the same text for the same product
-- is one. COALESCE because product_code is nullable and NULL <> NULL in an index.
CREATE UNIQUE INDEX IF NOT EXISTS kb_documents_hash_product_uniq
  ON kb_documents (content_hash, COALESCE(product_code, ''));
CREATE INDEX IF NOT EXISTS kb_documents_source_idx      ON kb_documents (source);
CREATE INDEX IF NOT EXISTS kb_documents_product_idx     ON kb_documents (product_code);
CREATE INDEX IF NOT EXISTS kb_documents_captured_at_idx ON kb_documents (captured_at DESC);

-- Keyword search fallback for deployments with no pgvector and no embedding key.
-- GENERATED ... STORED so it can never drift from the text it indexes.
ALTER TABLE kb_documents
  ADD COLUMN IF NOT EXISTS search_tsv tsvector
  GENERATED ALWAYS AS (
    to_tsvector('english', coalesce(title, '') || ' ' || coalesce(body_text, ''))
  ) STORED;
CREATE INDEX IF NOT EXISTS kb_documents_tsv_idx ON kb_documents USING GIN (search_tsv);

CREATE TABLE IF NOT EXISTS kb_insights (
  id            BIGSERIAL PRIMARY KEY,
  insight_type  TEXT NOT NULL,     -- voice_of_customer | pain | objection | desired_outcome |
                                   -- competitor_claim | price_anchor | demographic_signal
  product_code  TEXT,
  body          TEXT NOT NULL,     -- the fact, in the customer's words where possible
  quote         TEXT,              -- verbatim excerpt, when the fact IS a quote
  confidence    NUMERIC(4,3) NOT NULL DEFAULT 0.5 CHECK (confidence >= 0 AND confidence <= 1),
  status        TEXT NOT NULL DEFAULT 'proposed'
                CHECK (status IN ('proposed', 'approved', 'rejected')),
  approved_by   TEXT,
  approved_at   TIMESTAMPTZ,
  rejected_reason TEXT,
  proposed_by   TEXT,              -- 'llm:<model>' for an extraction job, a user id for a human
  extraction_job_id BIGINT,
  metadata      JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at    TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS kb_insights_status_idx  ON kb_insights (status);
CREATE INDEX IF NOT EXISTS kb_insights_type_idx    ON kb_insights (insight_type);
CREATE INDEX IF NOT EXISTS kb_insights_product_idx ON kb_insights (product_code);

ALTER TABLE kb_insights
  ADD COLUMN IF NOT EXISTS search_tsv tsvector
  GENERATED ALWAYS AS (
    to_tsvector('english', coalesce(body, '') || ' ' || coalesce(quote, ''))
  ) STORED;
CREATE INDEX IF NOT EXISTS kb_insights_tsv_idx ON kb_insights USING GIN (search_tsv);

-- Provenance. An insight with no source row is an assertion, not an insight:
-- the service refuses to create one, and the API always returns these ids.
CREATE TABLE IF NOT EXISTS kb_insight_sources (
  insight_id   BIGINT NOT NULL REFERENCES kb_insights(id)   ON DELETE CASCADE,
  document_id  BIGINT NOT NULL REFERENCES kb_documents(id)  ON DELETE CASCADE,
  quote        TEXT,          -- the excerpt inside THAT document
  char_start   INTEGER,
  char_end     INTEGER,
  created_at   TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  PRIMARY KEY (insight_id, document_id)
);
CREATE INDEX IF NOT EXISTS kb_insight_sources_doc_idx ON kb_insight_sources (document_id);

-- Extraction jobs: an LLM PROPOSES, a reviewer approves. Never auto-approved.
CREATE TABLE IF NOT EXISTS kb_extraction_jobs (
  id            BIGSERIAL PRIMARY KEY,
  document_id   BIGINT NOT NULL REFERENCES kb_documents(id) ON DELETE CASCADE,
  status        TEXT NOT NULL DEFAULT 'pending'
                CHECK (status IN ('pending', 'running', 'done', 'failed')),
  model         TEXT,
  proposed_count INTEGER NOT NULL DEFAULT 0,
  error         TEXT,
  created_by    TEXT,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  finished_at   TIMESTAMPTZ
);
CREATE INDEX IF NOT EXISTS kb_extraction_jobs_doc_idx ON kb_extraction_jobs (document_id);

-- The Brain page permission. SuperAdmin already carries {"*":["*"]} (see 086).
UPDATE roles
SET permissions = permissions || '{"brain": ["access"]}'::jsonb
WHERE name = 'Team - Full Access';
