-- 127_store_identity.sql (HUB, lane C3) — the database's OWN store label.
--
-- WHY. STORE_CODE was shape-checked only (^[A-Z0-9]{2,4}$). Nothing tied it to
-- the database it was about to label, so `STORE_CODE=PL npm run migrate` against
-- Mineblock's database (or the far worse `STORE_CODE=MB` against Puure's, one
-- copy-pasted env var away) exited 0 with no complaint and the deploy succeeded
-- (review REVIEW-MERGE-1 P1-3). This table is the database saying which store it
-- is; server/migrations/run.js refuses every later run whose STORE_CODE differs.
--
-- SHAPE. Exactly one row, structurally: id is the primary key and CHECK (id = 1).
-- store_code carries NO regex CHECK on purpose — the runner validates the shape
-- and REFUSES a malformed row rather than the row being unrepresentable, because
-- the runner must survive a database whose identity table arrived from somewhere
-- else (a pg_dump of an older shape, a hand-edit) instead of crashing on it.
--
-- DATA. None. The row is written by run.js on the first run that reaches this
-- table, with the STORE_CODE that run was given, so the label always records the
-- code that actually tagged the rows.
--
-- R6: runs on an empty database (no dependency on any other table).

CREATE TABLE IF NOT EXISTS _store_identity (
  id               SMALLINT     PRIMARY KEY DEFAULT 1 CHECK (id = 1),
  store_code       TEXT         NOT NULL,
  first_run_at     TIMESTAMPTZ  NOT NULL DEFAULT NOW(),
  first_run_commit TEXT         NOT NULL DEFAULT 'unknown',
  runner_version   TEXT         NOT NULL DEFAULT 'unknown'
);

COMMENT ON TABLE _store_identity IS
  'Single row: which store this database belongs to. Written by server/migrations/run.js on the first run; every later run whose STORE_CODE differs is refused (STORE IDENTITY MISMATCH). Deliberate relabel: npm run migrate -- --relabel-identity --i-typed-the-store-name=<display name>.';
