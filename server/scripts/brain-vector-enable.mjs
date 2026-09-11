#!/usr/bin/env node
// brain:vector-enable — turn on the pgvector half of the Brain for a database
// that did NOT have pgvector when migration 129 ran.
//
// Why this exists (review P2-11): the migration runner keys on the ledger, so 129
// never re-runs. A store that gains pgvector later — a Postgres upgrade, a plan
// change, a privilege grant — would keep the portable shape for ever, silently,
// because both shapes are legitimate and nothing complains. This script is the
// supported way to catch it up, and it is IDEMPOTENT: run it as often as you like.
//
// It does three things, in order, and prints what each one actually did:
//   1. CREATE EXTENSION vector + ADD COLUMN embedding vector(1536) + the ivfflat
//      index — the same statements migration 129 runs where the extension exists
//   2. BACKFILL `embedding` from `embedding_json`, which 129 always writes, so no
//      row already in the Brain has to be re-embedded through the provider
//   3. report the counts it ends with
//
// It NEVER re-runs a migration and never touches the ledger. It refuses clearly
// when pgvector is not available on the server, when DATABASE_URL is unset, or
// when the database is unreachable — exit code 1, with the reason.
//
//   npm run brain:vector-enable
//   DATABASE_URL=postgres://… npm run brain:vector-enable

import postgres from 'postgres';
import { dbSslEnabled } from '../src/config/dbSsl.js';

const DIM = 1536;

function die(msg, code = 1) {
  console.error(`brain:vector-enable — ${msg}`);
  process.exit(code);
}

const url = process.env.DATABASE_URL;
if (!url || !url.trim()) die('DATABASE_URL is not set — name the Brain database to enable vectors on');

let sql;
try {
  sql = postgres(url, { ssl: dbSslEnabled() ? 'require' : false, onnotice: () => {}, connect_timeout: 10, max: 1 });
  await sql`SELECT 1`;
} catch (err) {
  die(`the database is unreachable: ${err.message}`);
}

try {
  const avail = await sql`SELECT default_version FROM pg_available_extensions WHERE name = 'vector'`;
  if (!avail.length) {
    die('pgvector is NOT available on this Postgres server — nothing to enable. '
      + 'The Brain keeps working on the portable (tsvector + embedding_json) shape.');
  }
  console.log(`pgvector available: ${avail[0].default_version}`);

  const tbl = await sql`SELECT to_regclass('public.kb_embeddings') AS t`;
  if (!tbl[0].t) die('this database has no kb_embeddings table — run the migrations first (npm run migrate)');

  const hadColumn = (await sql`
    SELECT 1 FROM information_schema.columns
    WHERE table_schema='public' AND table_name='kb_embeddings' AND column_name='embedding' LIMIT 1`).length > 0;

  await sql.unsafe('CREATE EXTENSION IF NOT EXISTS vector');
  await sql.unsafe(`ALTER TABLE kb_embeddings ADD COLUMN IF NOT EXISTS embedding vector(${DIM})`);
  console.log(hadColumn
    ? 'embedding column: already present (nothing to add)'
    : `embedding column: CREATED vector(${DIM})`);

  try {
    await sql.unsafe('CREATE INDEX IF NOT EXISTS kb_embeddings_vec_idx ON kb_embeddings '
      + 'USING ivfflat (embedding vector_cosine_ops) WITH (lists = 100)');
    console.log('ivfflat index: present');
  } catch (err) {
    // Not fatal — an exact scan is correct, just slower. Say so; never swallow.
    console.log(`ivfflat index: NOT created (${err.message}) — exact scan still works`);
  }

  // Backfill from the portable copy every row already carries. A row whose JSON
  // is not DIM long belongs to another model and is left alone rather than
  // coerced into a column whose dimension is part of its type.
  const [{ n: candidates }] = await sql.unsafe(
    `SELECT count(*)::int AS n FROM kb_embeddings
     WHERE embedding IS NULL AND embedding_json IS NOT NULL
       AND jsonb_array_length(embedding_json) = ${DIM}`);
  let filled = 0;
  if (candidates > 0) {
    const rows = await sql.unsafe(
      `UPDATE kb_embeddings SET embedding = (embedding_json #>> '{}')::vector(${DIM})
       WHERE embedding IS NULL AND embedding_json IS NOT NULL
         AND jsonb_array_length(embedding_json) = ${DIM}
       RETURNING id`);
    filled = rows.length;
  }
  const [{ n: wrongDim }] = await sql.unsafe(
    `SELECT count(*)::int AS n FROM kb_embeddings
     WHERE embedding IS NULL AND embedding_json IS NOT NULL
       AND jsonb_array_length(embedding_json) <> ${DIM}`);

  const [{ n: docVecs }] = await sql`SELECT count(*)::int AS n FROM kb_embeddings WHERE embedding IS NOT NULL AND document_id IS NOT NULL`;
  const [{ n: insVecs }] = await sql`SELECT count(*)::int AS n FROM kb_embeddings WHERE embedding IS NOT NULL AND insight_id IS NOT NULL`;

  console.log(`backfilled from embedding_json: ${filled} of ${candidates} candidate row(s)`);
  if (wrongDim > 0) console.log(`skipped (a different model's dimension, needs its own column): ${wrongDim}`);
  console.log(`vectors now present — documents: ${docVecs} | insights: ${insVecs}`);
  console.log('done. Search runs the VECTOR path on the next request that has an embedding provider.');
} catch (err) {
  console.error(`brain:vector-enable — FAILED: ${err.message}`);
  await sql.end({ timeout: 5 }).catch(() => {});
  process.exit(1);
}

await sql.end({ timeout: 5 });
process.exit(0);
