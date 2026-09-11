// P0-1 probe — REAL pgvector (:5434). One doc + one APPROVED insight; does the
// insight come back in VECTOR mode?
// GUARD: run-all.mjs discovers every .mjs under server/tests and runs it as a
// test. This is a REVIEW PROBE, not a test — it prints findings rather than
// asserting them, and it needs a pgvector server. The suites assert the same
// properties (brain-vector.mjs V6/V7). Set BRAIN_PROBE=1 to run it by hand.
if (process.env.BRAIN_PROBE !== '1') {
  console.log('SKIP  brain/probes: a review probe, not a test — run with BRAIN_PROBE=1 (see probes/README.md)');
  process.exit(0);
}

import { fileURLToPath } from 'node:url';
import postgres from 'postgres';
import { spawnSync } from 'node:child_process';
// The worktree this file lives in — NOT a hard-coded one. (It named
// /Users/ludo/wt-s4-brain, so a copy of this probe in any other worktree
// imported the ORIGINAL lane's code and proved nothing about its own tree.)
const REPO = fileURLToPath(new URL('../../../..', import.meta.url)).replace(/\/$/, '');
const VEC = process.env.BRAIN_VECTOR_PGURL || 'postgres://postgres@127.0.0.1:5434';
const DBNAME = 'sb2_vecprobe';
const admin = postgres(`${VEC}/postgres`, { ssl: false, onnotice: () => {} });
await admin.unsafe(`DROP DATABASE IF EXISTS ${DBNAME}`);
await admin.unsafe(`CREATE DATABASE ${DBNAME}`);
await admin.end();
const DB = `${VEC}/${DBNAME}`;
process.env.PRODUCT_CODES_JSON = JSON.stringify({ AAA: { default: true } });
process.env.DATABASE_SSL = '0';
process.env.STORE_CODE = 'SV';
delete process.env.OPENAI_API_KEY;
const mig = spawnSync(process.execPath, [`${REPO}/server/migrations/run.js`], {
  env: { ...process.env, DATABASE_URL: DB, MIGRATE_SSL: '0', STORE_CODE: 'SV' }, encoding: 'utf8', timeout: 180000,
});
if (mig.status !== 0) { console.error(mig.stdout, mig.stderr); process.exit(2); }

const sql = postgres(DB, { ssl: false, onnotice: () => {} });
const HOT = ['alphaterm', 'betaterm'];
const provider = {
  name: 'openai', model: 'text-embedding-3-small', dim: 1536,
  embed: async (texts) => texts.map((t) => {
    const v = new Array(1536).fill(0);
    HOT.forEach((w, i) => { v[i] = (String(t).toLowerCase().match(new RegExp(w, 'g')) || []).length; });
    if (v[0] === 0 && v[1] === 0) v[2] = 1;
    return v;
  }),
};
const store = await import(`${REPO}/server/src/services/brainStore.js`);
const { search } = await import(`${REPO}/server/src/services/brainSearch.js`);

const d = await store.ingestDocument(sql, { source: 'forum', title: 'thread one', text: 'alphaterm alphaterm and context' });
await store.embedDocument(sql, d.document.id, { provider });
const ins = await store.createInsight(sql, {
  insight_type: 'pain', body: 'alphaterm is the pain customers name most often',
  source_document_ids: [d.document.id],
});
const [rev] = await sql`INSERT INTO users (id,email,first_name,last_name,is_active)
  VALUES (gen_random_uuid(),'rev@t.co','R','V',TRUE) RETURNING id`;
await store.setInsightStatus(sql, ins.id, 'approved', { actor: `user:${rev.id}`, userId: rev.id });
if (store.embedInsight) { try { await store.embedInsight(sql, ins.id, { provider }); } catch (e) { console.log('embedInsight threw:', e.message); } }

const n = await sql`SELECT count(*)::int AS n FROM kb_embeddings WHERE insight_id IS NOT NULL`;
console.log('kb_embeddings rows with insight_id:', n[0].n);
const kw = await search(sql, { q: "alphaterm" }, { mayReadUnapproved: false, provider: null });
const vc = await search(sql, { q: "alphaterm" }, { mayReadUnapproved: false, provider });
const ids = (r) => r.results.map((x) => `${x.kind}:${x.id}`);
console.log(`KEYWORD mode=${kw.mode} results=${JSON.stringify(ids(kw))}`);
console.log(`VECTOR  mode=${vc.mode} results=${JSON.stringify(ids(vc))}`);
console.log('approved insight visible in KEYWORD mode:', ids(kw).includes(`insight:${ins.id}`));
console.log('approved insight visible in VECTOR  mode:', ids(vc).includes(`insight:${ins.id}`));
const only = await search(sql, { q: "alphaterm", type: "insight" }, { mayReadUnapproved: false, provider });
console.log(`explicit type=insight in VECTOR mode: ${JSON.stringify(ids(only))}  (mode=${only.mode})`);
await sql.end();
