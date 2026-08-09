// COGS ASSISTANT schema — the two tables the assistant/quote-scan lane owns.
//
// It owns NOTHING that money is computed from. Every cost the assistant lands
// goes through funnelCosts.appendRate() into lb_cost_rates (append-only,
// effective-dated) — the same door the operator's manual POST /rates uses.
// These two tables are the PAPER TRAIL beside that door, never a second one.
//
//   lb_cogs_assistant_audit — one row per APPLIED batch. Who, when, the
//     verbatim proposal the model emitted, the model id, and the ids of the
//     lb_cost_rates rows the apply produced. batch_id is the join back: every
//     rate written by a batch carries it in lb_cost_rates.batch_id, so
//     "which assistant run produced this cost" is answerable from either end.
//
//   lb_quote_scans — one row per supplier-quote extraction. Persists the
//     EXTRACTED MATRIX and a sha256 of the uploaded bytes. The raw file is
//     NEVER stored: it is decoded in memory, sniffed, handed to the API, and
//     dropped. The hash exists so a re-upload of the same document is
//     recognisable without keeping the document.
//
// Both tables are inert with respect to P&L. Deleting either would lose the
// audit trail and not one cent of computed profit — that asymmetry is the
// design (proposals are inert until applied; applied rates ride the existing
// append-only history).
import { pgQuery } from '../db/pg.js';

// Same serialization pattern as funnelCostsSchema/checkoutSchema: concurrent
// requests must not run CREATE TABLE IF NOT EXISTS in parallel (Postgres
// throws a pg_type unique violation). One in-flight promise; on failure it
// resets so the next request retries.
let tablesReadyPromise = null;

export function ensureCogsAssistantTables() {
  if (!tablesReadyPromise) {
    tablesReadyPromise = createTables().catch((err) => {
      tablesReadyPromise = null;
      throw err;
    });
  }
  return tablesReadyPromise;
}

async function createTables() {
  // ── lb_cogs_assistant_audit ───────────────────────────────────────────────
  // proposal JSONB holds the ops EXACTLY as the operator confirmed them (the
  // model's output after server validation, before the write). applied JSONB
  // holds the per-op outcome incl. the lb_cost_rates id. Neither is ever
  // updated in place — an audit row is a fact about a moment.
  await pgQuery(`
    CREATE TABLE IF NOT EXISTS lb_cogs_assistant_audit (
      id BIGSERIAL PRIMARY KEY,
      batch_id TEXT NOT NULL UNIQUE,
      kind TEXT NOT NULL DEFAULT 'chat' CHECK (kind IN ('chat','quote')),
      model TEXT NOT NULL DEFAULT '',
      source_text TEXT NOT NULL DEFAULT '',
      quote_scan_id TEXT,
      proposal JSONB NOT NULL DEFAULT '[]',
      applied JSONB NOT NULL DEFAULT '[]',
      applied_count INT NOT NULL DEFAULT 0,
      rejected_count INT NOT NULL DEFAULT 0,
      created_by TEXT NOT NULL DEFAULT '',
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )
  `);
  await pgQuery(`
    CREATE INDEX IF NOT EXISTS idx_lb_cogs_audit_created
    ON lb_cogs_assistant_audit (created_at DESC, id DESC)
  `);

  // ── lb_quote_scans ────────────────────────────────────────────────────────
  // content_hash is sha256 of the DECODED upload bytes. It is NOT unique: the
  // same quote may legitimately be re-scanned (a better model, a corrected
  // catalog) and each scan is its own fact. It is indexed so the client can
  // say "you already scanned this file on <date>".
  //
  // matrix/header/verify are jsonb — parameterised as JS values, never
  // pre-stringified (a pre-stringified object lands as a jsonb STRING and
  // every later ->> read returns nothing).
  await pgQuery(`
    CREATE TABLE IF NOT EXISTS lb_quote_scans (
      id TEXT PRIMARY KEY,
      content_hash TEXT NOT NULL,
      content_type TEXT NOT NULL DEFAULT '',
      byte_size INT NOT NULL DEFAULT 0,
      filename TEXT NOT NULL DEFAULT '',
      model TEXT NOT NULL DEFAULT '',
      header JSONB NOT NULL DEFAULT '{}',
      matrix JSONB NOT NULL DEFAULT '[]',
      verify JSONB NOT NULL DEFAULT '{}',
      created_by TEXT NOT NULL DEFAULT '',
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )
  `);
  await pgQuery(`
    CREATE INDEX IF NOT EXISTS idx_lb_quote_scans_hash ON lb_quote_scans (content_hash)
  `);
  await pgQuery(`
    CREATE INDEX IF NOT EXISTS idx_lb_quote_scans_created
    ON lb_quote_scans (created_at DESC)
  `);
}

export default { ensureCogsAssistantTables };
