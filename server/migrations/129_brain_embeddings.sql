-- 129_brain_embeddings.sql  (HUB — S4-SB)
--
-- Embeddings live in the SAME database as the documents they index, so a Brain
-- is one physical unit (drop the database, the Brain is gone).
--
-- pgvector is NOT assumed. Render Postgres 16 ships it; the local Postgres 16 the
-- lanes test on does not (`CREATE EXTENSION vector` → 'extension "vector" is not
-- available'). Rather than split the schema by environment, this migration is
-- CONDITIONAL: it creates the extension and a real `vector(1536)` column WHERE THE
-- EXTENSION IS AVAILABLE, and stops after the portable columns where it is not.
-- Both shapes carry embedding_json, so a database that gains pgvector later can be
-- backfilled from rows already written; searchService picks the path at REQUEST
-- time from the column that actually exists (R7), never from an env flag.
--
-- Additive + idempotent (R6). Runs clean on an empty database either way.

CREATE TABLE IF NOT EXISTS kb_embeddings (
  id             BIGSERIAL PRIMARY KEY,
  document_id    BIGINT REFERENCES kb_documents(id) ON DELETE CASCADE,
  insight_id     BIGINT REFERENCES kb_insights(id)  ON DELETE CASCADE,
  chunk_index    INTEGER NOT NULL DEFAULT 0,
  chunk_text     TEXT NOT NULL,
  provider       TEXT NOT NULL,           -- 'openai' | <other>; never a key
  model          TEXT NOT NULL,
  dim            INTEGER NOT NULL,
  embedding_json JSONB,                   -- portable copy: [f, f, …]. Always written.
  created_at     TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CONSTRAINT kb_embeddings_one_owner CHECK (
    (document_id IS NOT NULL AND insight_id IS NULL)
    OR (document_id IS NULL AND insight_id IS NOT NULL)
  )
);
CREATE UNIQUE INDEX IF NOT EXISTS kb_embeddings_doc_chunk_uniq
  ON kb_embeddings (document_id, chunk_index, model) WHERE document_id IS NOT NULL;
CREATE UNIQUE INDEX IF NOT EXISTS kb_embeddings_insight_chunk_uniq
  ON kb_embeddings (insight_id, chunk_index, model) WHERE insight_id IS NOT NULL;

-- ── pgvector, only where it exists ────────────────────────────────────────────
DO $$
DECLARE has_ext BOOLEAN;
BEGIN
  SELECT EXISTS (SELECT 1 FROM pg_available_extensions WHERE name = 'vector') INTO has_ext;
  IF NOT has_ext THEN
    RAISE NOTICE 'kb_embeddings: pgvector NOT available on this server — keeping embedding_json only; search falls back to tsvector';
    RETURN;
  END IF;

  CREATE EXTENSION IF NOT EXISTS vector;
  -- 1536 = text-embedding-3-small. A different model needs its own column/table.
  EXECUTE 'ALTER TABLE kb_embeddings ADD COLUMN IF NOT EXISTS embedding vector(1536)';
  BEGIN
    EXECUTE 'CREATE INDEX IF NOT EXISTS kb_embeddings_vec_idx ON kb_embeddings '
         || 'USING ivfflat (embedding vector_cosine_ops) WITH (lists = 100)';
  EXCEPTION WHEN OTHERS THEN
    -- ivfflat needs rows to train on some builds; the column is what matters.
    RAISE NOTICE 'kb_embeddings: vector index not created (%) — exact scan still works', SQLERRM;
  END;
END $$;
