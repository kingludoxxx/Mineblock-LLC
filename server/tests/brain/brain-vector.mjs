// test-timeout: 300s
// S4-SB — THE VECTOR PATH, proven end to end.
//
// The local Postgres the lanes share has NO pgvector ("extension \"vector\" is not
// available"), so migration 129 deliberately keeps the portable shape there and
// search falls back to tsvector. That fallback is proven by brain-routes.mjs.
// This script proves the OTHER half on a Postgres that DOES have pgvector — the
// shape Render Postgres 16 gives every store.
//
// It looks for such a server at BRAIN_VECTOR_PGURL (default 127.0.0.1:5434, where
// PROOF-S4-SB.md documents building pgvector 0.8.0 into a PRIVATE copy of the pg16
// distribution rather than touching the shared cluster). No server → every check
// SKIPS with that reason; it never silently passes.
//
// Asserts BY EXECUTION:
//   V1 the SAME migration bytes create `embedding vector(1536)` here, and did NOT
//      on the no-pgvector cluster — one file, both environments
//   V2 the provider/column pair decides the mode at REQUEST time: same query, same
//      database, provider present → 'vector', provider absent → 'keyword'
//   V3 semantic ranking actually works: a query embedding near document A ranks A
//      above B, and the result still carries citations
//   V4 FAILURE PATH: a provider whose upstream fails surfaces the error — it never
//      degrades into an empty result set that reads like "nothing matched"
//   V5 the OpenAI provider builds only when OPENAI_API_KEY is set, sends the key in
//      a HEADER (never the URL), and raises on a non-2xx upstream
//
// Run:  node server/tests/brain/brain-vector.mjs
import postgres from 'postgres';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO = join(HERE, '..', '..', '..');
const VEC_PG = process.env.BRAIN_VECTOR_PGURL || 'postgres://postgres@127.0.0.1:5434';
const DBNAME = 's4_brain_vector';

let pass = 0, fail = 0, skip = 0;
const ok = (c, m, x = '') => { if (c) { pass++; console.log('PASS ', m); } else { fail++; console.log('FAIL ', m, x ? `\n      ${String(x).split('\n').join('\n      ')}` : ''); } };
const skipped = (m, why) => { skip++; console.log('SKIP ', m, `— ${why}`); };

process.env.PRODUCT_CODES_JSON ||= JSON.stringify({ AAA: { default: true } });
process.env.DATABASE_SSL = '0';
delete process.env.OPENAI_API_KEY;

// ── V5 the provider interface itself (no server needed) ────────────────────
{
  const { getEmbeddingProvider } = await import('../../src/services/brain/embeddingProvider.js');
  ok(getEmbeddingProvider() === null, 'V5.1 no OPENAI_API_KEY → no provider (the keyword path is the default, not an error)');
  process.env.OPENAI_API_KEY = 'sk-test-not-a-real-key';
  let seen = null;
  const p = getEmbeddingProvider({ fetchImpl: async (url, init) => { seen = { url, init }; return { ok: true, json: async () => ({ data: [{ embedding: new Array(1536).fill(0.5) }] }) }; } });
  ok(p && p.model === 'text-embedding-3-small' && p.dim === 1536, 'V5.2 …with the key set, the OpenAI provider is built', JSON.stringify(p && { m: p.model, d: p.dim }));
  const [v] = await p.embed(['hello']);
  ok(v.length === 1536, 'V5.3 …and returns a 1536-dim vector', String(v.length));
  ok(!String(seen.url).includes('sk-test'), 'V5.4 the key is NEVER in the URL', seen.url);
  ok(String(seen.init.headers.Authorization || '').startsWith('Bearer sk-test'), 'V5.5 …it travels in a HEADER');
  let threw = null;
  const bad = getEmbeddingProvider({ fetchImpl: async () => ({ ok: false, status: 429, text: async () => 'rate limited' }) });
  try { await bad.embed(['x']); } catch (e) { threw = e; }
  ok(threw && /429/.test(threw.message), 'V5.6 FAILURE PATH: a non-2xx upstream RAISES, never returns an empty vector set', threw && threw.message);
  delete process.env.OPENAI_API_KEY;
}

// ── is a pgvector server reachable? ────────────────────────────────────────
let admin = null;
try {
  admin = postgres(`${VEC_PG}/postgres`, { ssl: false, onnotice: () => {}, connect_timeout: 5 });
  const r = await admin`SELECT default_version FROM pg_available_extensions WHERE name = 'vector'`;
  if (!r.length) throw new Error('no pgvector on that server');
  console.log(`      (pgvector ${r[0].default_version} at ${VEC_PG.replace(/\/\/[^@]*@/, '//')})`);
} catch (e) {
  await admin?.end().catch(() => {});
  const why = `no pgvector Postgres at ${VEC_PG} (${e.message}) — build one per PROOF-S4-SB.md and re-run`;
  for (const m of ['V1 migration 129 creates the vector column', 'V2 mode selection', 'V3 semantic ranking', 'V4 provider failure path']) skipped(m, why);
  console.log(`\n${pass} passed, ${fail} failed, ${skip} skipped`);
  process.exit(fail ? 1 : 0);
}

await admin.unsafe(`DROP DATABASE IF EXISTS ${DBNAME}`);
await admin.unsafe(`CREATE DATABASE ${DBNAME}`);
await admin.end();
const DB = `${VEC_PG}/${DBNAME}`;

const mig = spawnSync(process.execPath, [join(REPO, 'server/migrations/run.js')], {
  env: { ...process.env, DATABASE_URL: DB, MIGRATE_SSL: '0', STORE_CODE: 'SV' },
  encoding: 'utf8', timeout: 180000,
});
ok(mig.status === 0, 'V1.1 the same migration set runs clean on a pgvector Postgres', (mig.stdout || '') + (mig.stderr || ''));

const sql = postgres(DB, { ssl: false, onnotice: () => {} });
{
  const cols = await sql`SELECT format_type(a.atttypid, a.atttypmod) AS t
                         FROM pg_attribute a WHERE a.attrelid = 'kb_embeddings'::regclass AND a.attname = 'embedding'`;
  ok(cols.length === 1 && cols[0].t === 'vector(1536)',
    'V1.2 …and migration 129 created embedding vector(1536) HERE (it created no such column on the no-pgvector cluster)', JSON.stringify(cols));
  const ext = await sql`SELECT extversion FROM pg_extension WHERE extname = 'vector'`;
  ok(ext.length === 1, 'V1.3 the extension itself was created by the migration', JSON.stringify(ext));
}

// A deterministic stand-in for the embedding API: dimension 0 counts one marker
// word, dimension 1 the other. Cosine distance then has an arithmetic meaning the
// assertions can state exactly, with no network and no model drift.
const HOT = ['alphaterm', 'betaterm'];
const fakeProvider = {
  name: 'openai', model: 'text-embedding-3-small', dim: 1536,
  embed: async (texts) => texts.map((t) => {
    const v = new Array(1536).fill(0);
    HOT.forEach((w, i) => { v[i] = (String(t).toLowerCase().match(new RegExp(w, 'g')) || []).length; });
    if (v[0] === 0 && v[1] === 0) v[2] = 1; // never the zero vector
    return v;
  }),
};

const { ingestDocument, embedDocument } = await import('../../src/services/brainStore.js');
const { search } = await import('../../src/services/brainSearch.js');

const a = await ingestDocument(sql, { source: 'forum', title: 'thread one', text: 'alphaterm alphaterm alphaterm and a little context around it' });
const b = await ingestDocument(sql, { source: 'forum', title: 'thread two', text: 'betaterm betaterm betaterm and a little context around it' });
const ea = await embedDocument(sql, a.document.id, { provider: fakeProvider });
await embedDocument(sql, b.document.id, { provider: fakeProvider });
ok(ea.embedded === true && ea.vector_column === true, 'V2.1 embeddings are written into the vector COLUMN here', JSON.stringify(ea));
{
  const rows = await sql`SELECT count(*)::int AS n FROM kb_embeddings WHERE embedding IS NOT NULL`;
  ok(rows[0].n === 2, 'V2.2 …two documents embedded', JSON.stringify(rows));
}

{
  const vecRes = await search(sql, { q: 'alphaterm', provider: fakeProvider });
  ok(vecRes.mode === 'vector', 'V2.3 with a provider AND the column present the mode is VECTOR', vecRes.mode);
  ok(vecRes.results.length === 2, 'V3.1 the semantic search returns both documents (ranked, not filtered)', JSON.stringify(vecRes.results.map((r) => [r.id, r.score])));
  ok(vecRes.results[0].id === a.document.id,
    'V3.2 …with the document nearest the query embedding FIRST', JSON.stringify(vecRes.results.map((r) => [r.id, r.score])));
  ok(vecRes.results[0].score > vecRes.results[1].score + 0.5,
    'V3.3 …by a real margin (cosine similarity 1 vs 0)', JSON.stringify(vecRes.results.map((r) => r.score)));
  ok(Array.isArray(vecRes.results[0].citations) && vecRes.results[0].citations[0].document_id === a.document.id,
    'V3.4 …and the vector path carries citations too', JSON.stringify(vecRes.results[0].citations));

  const kwRes = await search(sql, { q: 'alphaterm', provider: null });
  ok(kwRes.mode === 'keyword', 'V2.4 the SAME query on the SAME database with NO provider falls back to KEYWORD', kwRes.mode);
  ok(kwRes.results.length === 1 && kwRes.results[0].id === a.document.id,
    'V2.5 …and the fallback finds the right document (exact term, not nearest neighbour)', JSON.stringify(kwRes.results.map((r) => r.id)));
}

// ── V6 INSIGHTS IN VECTOR MODE (S4-SB2 / P0-1) ─────────────────────────────
// This suite only ever asserted DOCUMENTS, which is exactly why it stayed green
// while the vector path returned NO insight, ever: nothing wrote
// kb_embeddings.insight_id, so `JOIN kb_insights i ON i.id = e.insight_id` matched
// zero rows. Keyword mode reads search_tsv and worked, so the whole approval layer
// was visible on the no-pgvector cluster and INVISIBLE on the pgvector shape
// production runs — with no error, indistinguishable from "no approved insights".
{
  const { createInsight, setInsightStatus, embedInsight } = await import('../../src/services/brainStore.js');
  const [reviewer] = await sql`INSERT INTO users (id, email, first_name, last_name, is_active)
    VALUES (gen_random_uuid(), 'v@t.co', 'V', 'T', TRUE) RETURNING id`;

  const ins = await createInsight(sql, {
    insight_type: 'pain', body: 'alphaterm is the pain customers name most often',
    source_document_ids: [a.document.id],
  });
  const proposed = await search(sql, { q: 'alphaterm', type: 'insight', provider: fakeProvider });
  ok(proposed.results.length === 0,
    'V6.1 a PROPOSED insight is not in the default (approved) vector result', JSON.stringify(proposed.results.map((r) => r.id)));

  const approved = await setInsightStatus(sql, ins.id, 'approved', {
    actor: `user:${reviewer.id}`, userId: reviewer.id,
  });
  ok(approved.status === 'approved' && approved.approved_by === reviewer.id,
    'V6.2 approving records the reviewing USER id', JSON.stringify({ s: approved.status, by: approved.approved_by }));

  const e = await embedInsight(sql, ins.id, { provider: fakeProvider });
  ok(e.embedded === true && e.vector_column === true, 'V6.3 an insight embeds into the vector COLUMN', JSON.stringify(e));
  const [{ n: insRows }] = await sql`SELECT count(*)::int AS n FROM kb_embeddings WHERE insight_id IS NOT NULL AND embedding IS NOT NULL`;
  ok(insRows === 1, 'V6.4 …kb_embeddings.insight_id is actually written (it never was before)', `rows=${insRows}`);

  const vec = await search(sql, { q: 'alphaterm', provider: fakeProvider });
  const ids = vec.results.map((r) => `${r.kind}:${r.id}`);
  ok(vec.mode === 'vector' && ids.includes(`insight:${ins.id}`),
    'V6.5 the APPROVED insight comes back in VECTOR mode', `${vec.mode} ${JSON.stringify(ids)}`);
  const kw = await search(sql, { q: 'alphaterm', provider: null });
  ok(kw.results.map((r) => `${r.kind}:${r.id}`).includes(`insight:${ins.id}`),
    'V6.6 …and in KEYWORD mode, so the two modes agree about the approval layer', JSON.stringify(kw.results.map((r) => `${r.kind}:${r.id}`)));
  const only = await search(sql, { q: 'alphaterm', type: 'insight', provider: fakeProvider });
  ok(only.mode === 'vector' && only.results.length === 1 && only.results[0].id === ins.id,
    'V6.7 …and an explicit type=insight vector query is NON-EMPTY (it used to be [] with no error)', JSON.stringify(only.results.map((r) => r.id)));
  ok(Array.isArray(only.results[0]?.citations) && only.results[0].citations[0]?.document_id === a.document.id,
    'V6.8 …carrying its citations', JSON.stringify(only.results[0]?.citations));
}

// ── V7 the on-demand BACKFILL — a Brain approved before any of this existed ─
{
  const { createInsight, setInsightStatus, backfillInsightEmbeddings } = await import('../../src/services/brainStore.js');
  const [reviewer] = await sql`SELECT id FROM users WHERE email = 'v@t.co' LIMIT 1`;
  const old = await createInsight(sql, {
    insight_type: 'objection', body: 'betaterm doubts, approved while no provider was configured',
    source_document_ids: [b.document.id],
  });
  await setInsightStatus(sql, old.id, 'approved', { actor: `user:${reviewer.id}`, userId: reviewer.id });
  // Deliberately NOT embedded — this is the pre-existing row the review is about.
  const [{ n: before }] = await sql`SELECT count(*)::int AS n FROM kb_embeddings WHERE insight_id = ${old.id}`;
  ok(before === 0, 'V7.1 an approved insight with NO embedding row exists', `rows=${before}`);

  const found = await search(sql, { q: 'betaterm', type: 'insight', provider: fakeProvider });
  ok(found.mode === 'vector' && found.results.some((r) => r.id === old.id),
    'V7.2 …and a vector search FINDS it: the search path backfills on demand instead of answering []',
    JSON.stringify(found.results.map((r) => r.id)));
  const [{ n: after }] = await sql`SELECT count(*)::int AS n FROM kb_embeddings WHERE insight_id = ${old.id} AND embedding IS NOT NULL`;
  ok(after === 1, 'V7.3 …the backfill actually wrote the vector', `rows=${after}`);
  const again = await backfillInsightEmbeddings(sql, { provider: fakeProvider });
  ok(again.embedded === 0 && again.remaining === 0,
    'V7.4 …and it is idempotent: a second pass embeds nothing and reports 0 remaining', JSON.stringify(again));
}

{
  const boom = { ...fakeProvider, embed: async () => { throw new Error('embedding provider 500: upstream on fire'); } };
  let threw = null;
  try { await search(sql, { q: 'alphaterm', provider: boom }); } catch (e) { threw = e; }
  ok(threw && /500/.test(threw.message),
    'V4.1 FAILURE PATH: when the embedding call fails the search RAISES — it never silently returns "no results"', threw && threw.message);
}

await sql.end();
console.log(`\n${pass} passed, ${fail} failed, ${skip} skipped`);
process.exit(fail ? 1 : 0);
