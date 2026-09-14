-- 137_product_bible.sql  (Product Bible: per-market research inside the product library)
--
-- A product can be sold into several MARKETS that are treated as different businesses
-- (e.g. one device sold to a snoring market and to a sleep-apnea market). Each market owns
-- a complete, read-only Product Bible imported from a research document:
--   product_markets          one row per (product, market): label, price, url, import stamp
--   product_bible_sections   the document, split at its headings, pre-rendered for the UI
--   product_bible_entities   typed, addressable knowledge: avatars, angles, beliefs, objections,
--                            hooks, competitors, solutions, proven winners, mechanism, offer...
--   product_bible_quotes     the verbatim customer quotes the bible cites, by quote id
--
-- Every pipeline (briefs, statics, funnel builder, assistants) reads a SLICE of one market's
-- bible through buildBibleContextPack(); nothing is shared between two markets of a product.
--
-- Schema only: no product, store or brand literal (R15). Additive and idempotent (R6).
-- Products with no market keep today's behaviour everywhere.

CREATE TABLE IF NOT EXISTS product_markets (
  id             SERIAL PRIMARY KEY,
  product_id     INTEGER NOT NULL REFERENCES product_profiles(id) ON DELETE CASCADE,
  market_key     TEXT NOT NULL CHECK (market_key ~ '^[a-z0-9][a-z0-9_-]{1,39}$'),
  label          TEXT NOT NULL,
  price          TEXT,
  product_url    TEXT,
  sort_order     INTEGER NOT NULL DEFAULT 0,
  bible_title    TEXT,
  bible_version  TEXT,
  source_sha256  TEXT,
  imported_at    TIMESTAMPTZ,
  imported_by    TEXT,
  stats          JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at     TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at     TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (product_id, market_key)
);

CREATE TABLE IF NOT EXISTS product_bible_sections (
  id             SERIAL PRIMARY KEY,
  market_id      INTEGER NOT NULL REFERENCES product_markets(id) ON DELETE CASCADE,
  ord            INTEGER NOT NULL,
  anchor         TEXT NOT NULL,
  level          SMALLINT NOT NULL CHECK (level BETWEEN 1 AND 4),
  title          TEXT NOT NULL,
  parent_anchor  TEXT,
  markdown       TEXT NOT NULL DEFAULT '',
  html           TEXT NOT NULL DEFAULT '',
  char_count     INTEGER NOT NULL DEFAULT 0,
  UNIQUE (market_id, anchor)
);
CREATE INDEX IF NOT EXISTS product_bible_sections_market_ord ON product_bible_sections (market_id, ord);

CREATE TABLE IF NOT EXISTS product_bible_entities (
  id             SERIAL PRIMARY KEY,
  market_id      INTEGER NOT NULL REFERENCES product_markets(id) ON DELETE CASCADE,
  type           TEXT NOT NULL CHECK (type IN (
                   'launch_map','desire','sophistication','awareness','mechanism','avatar','angle',
                   'belief','objection','hook','competitor','solution','proven_winner','offer',
                   'market_fact','test_queue','banned_phrase','tired_word','flag')),
  key            TEXT NOT NULL,
  title          TEXT NOT NULL DEFAULT '',
  tier           TEXT,
  data           JSONB NOT NULL DEFAULT '{}'::jsonb,
  avatar_keys    TEXT[] NOT NULL DEFAULT '{}',
  angle_keys     TEXT[] NOT NULL DEFAULT '{}',
  quote_ids      TEXT[] NOT NULL DEFAULT '{}',
  search_text    TEXT NOT NULL DEFAULT '',
  ord            INTEGER NOT NULL DEFAULT 0,
  UNIQUE (market_id, type, key)
);
CREATE INDEX IF NOT EXISTS product_bible_entities_market_type ON product_bible_entities (market_id, type, ord);
CREATE INDEX IF NOT EXISTS product_bible_entities_avatar_keys ON product_bible_entities USING GIN (avatar_keys);
CREATE INDEX IF NOT EXISTS product_bible_entities_angle_keys ON product_bible_entities USING GIN (angle_keys);

CREATE TABLE IF NOT EXISTS product_bible_quotes (
  id              SERIAL PRIMARY KEY,
  market_id       INTEGER NOT NULL REFERENCES product_markets(id) ON DELETE CASCADE,
  quote_id        TEXT NOT NULL,
  quote           TEXT NOT NULL,
  source          TEXT,
  url             TEXT,
  speaker         TEXT,
  avatar          TEXT,
  tags            TEXT[] NOT NULL DEFAULT '{}',
  hook_strength   SMALLINT,
  failed_solution TEXT,
  UNIQUE (market_id, quote_id)
);
CREATE INDEX IF NOT EXISTS product_bible_quotes_market_avatar ON product_bible_quotes (market_id, avatar);
