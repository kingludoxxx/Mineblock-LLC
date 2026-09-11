// S4-SB3 probe C — NEW-5 (`provider` off the query string) and NEW-4 (an
// unmetered, effectively unbounded on-demand backfill inside a READ request),
// both of which only show themselves on a database that HAS pgvector.
//
// GUARD: a review probe, not a test. BRAIN_PROBE=1 to run. Needs the pgvector
// server at BRAIN_VECTOR_PGURL (default :5434). Own database (R43): sb3_vecprobe.
if (process.env.BRAIN_PROBE !== '1') {
  console.log('SKIP  brain/probes: a review probe, not a test — run with BRAIN_PROBE=1 (see probes/README.md)');
  process.exit(0);
}

import postgres from 'postgres';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO = join(HERE, '..', '..', '..', '..');
const VEC_PG = process.env.BRAIN_VECTOR_PGURL || 'postgres://postgres@127.0.0.1:5434';
const DBNAME = 'sb3_vecprobe';
const DB = `${VEC_PG}/${DBNAME}`;

const admin = postgres(`${VEC_PG}/postgres`, { ssl: false, onnotice: () => {} });
await admin.unsafe(`DROP DATABASE IF EXISTS ${DBNAME}`);
await admin.unsafe(`CREATE DATABASE ${DBNAME}`);
await admin.end();

const SERVICE_TOKEN = 'svc-token-sb3vec-0123456789';
Object.assign(process.env, {
  DATABASE_URL: DB, DATABASE_SSL: '0', NODE_ENV: 'development',
  JWT_ACCESS_SECRET: 'localdev', JWT_REFRESH_SECRET: 'localdev',
  PRODUCT_CODES_JSON: JSON.stringify({ AAA: { default: true } }),
  BRAIN_SERVICE_TOKEN: SERVICE_TOKEN, STORE_CODE: 'SA',
  MONEY_SWEEP_DISABLED: '1', TRACKING_SWEEPS_DISABLED: '1', DOMAIN_SWEEP_DISABLED: '1',
});
const mig = spawnSync(process.execPath, [join(REPO, 'server/migrations/run.js')], {
  env: { ...process.env, MIGRATE_SSL: '0' }, encoding: 'utf8', timeout: 180000,
});
if (mig.status !== 0) { console.error(mig.stdout, mig.stderr); process.exit(2); }

const sql = postgres(DB, { ssl: false, onnotice: () => {} });
const { vectorColumnAvailable } = await import(join(REPO, 'server/src/services/brain/embeddingProvider.js'));
if (!await vectorColumnAvailable(sql)) {
  console.log(`SKIP  no pgvector column on ${VEC_PG} — migration 129 kept the portable shape`);
  await sql.end(); process.exit(0);
}

const { default: express } = await import('express');
const { default: brainRoutes } = await import(join(REPO, 'server/src/routes/brain.js'));
const { signAccessToken } = await import(join(REPO, 'server/src/utils/jwt.js'));

const [u] = await sql`INSERT INTO users (id,email,first_name,last_name,is_active)
  VALUES (gen_random_uuid(),'v@t.co','V','T',TRUE) RETURNING id`;
const [r] = await sql`INSERT INTO roles (id,name,permissions)
  VALUES (gen_random_uuid(),'sb3-vec', ${sql.json({ brain: ['access', 'read', 'write', 'approve'] })}) RETURNING id`;
await sql`INSERT INTO user_roles (user_id,role_id) VALUES (${u.id},${r.id})`;
const SESSION = { Authorization: `Bearer ${signAccessToken({ userId: u.id })}`, 'Content-Type': 'application/json' };
const SERVICE = { 'X-Brain-Service-Token': SERVICE_TOKEN, 'Content-Type': 'application/json' };

// A REAL provider code path with a stubbed transport, so header auth and the
// shape checks still run — and every upstream call is COUNTED.
let calls = 0; let texts = 0;
process.env.OPENAI_API_KEY = 'sk-probe-not-a-real-key';
const realFetch = globalThis.fetch;
globalThis.fetch = async (url, init) => {
  if (String(url).includes('api.openai.com')) {
    calls += 1;
    const body = JSON.parse(init.body);
    const input = Array.isArray(body.input) ? body.input : [body.input];
    texts += input.length;
    return { ok: true, json: async () => ({ data: input.map(() => ({ embedding: new Array(1536).fill(0.01) })) }) };
  }
  return realFetch(url, init);
};

const app = express();
app.use(express.json({ limit: '10mb' }));
app.use('/api/v1/brain', brainRoutes);
const server = app.listen(0);
await new Promise((res) => server.once('listening', res));
const BASE = `http://127.0.0.1:${server.address().port}/api/v1/brain`;
async function call(method, path, body, headers = SESSION) {
  const res = await fetch(`${BASE}${path}`, {
    method, headers, body: body === undefined ? undefined : JSON.stringify(body),
  });
  let j = null; try { j = await res.json(); } catch { /* */ }
  return { status: res.status, j };
}

const doc = await call('POST', '/ingest', { source: 'forum', title: 'seed', text: 'alphaterm rig bearings squeak' });
const DID = doc.j.document.id;

console.log('\n### NEW-5  `provider` is taken from req.query, on a pgvector database');
for (const p of ['', 'anything', '1']) {
  const r = await call('GET', `/search?q=alphaterm&provider=${p}`, undefined, SESSION);
  console.log(`  ?q=alphaterm&provider=${JSON.stringify(p).padEnd(10)} → HTTP ${r.status} ${r.status === 200 ? `mode=${r.j.mode} n=${(r.j.results || []).length}` : JSON.stringify(r.j).slice(0, 110)}`);
}
{
  const r = await call('GET', '/search?q=alphaterm', undefined, SESSION);
  console.log(`  ?q=alphaterm (no provider param)  → HTTP ${r.status} mode=${r.j?.mode}   ← the store's REAL mode`);
}

console.log('\n### NEW-4  a READ endpoint embeds on demand: how many provider calls can ONE request drive?');
{
  // 30 approved insights with no vector: written straight to the table so the
  // approve-time embed does not pre-empt the backfill.
  await sql`DELETE FROM kb_embeddings WHERE insight_id IS NOT NULL`;
  for (let i = 0; i < 30; i += 1) {
    const [ins] = await sql`INSERT INTO kb_insights (insight_type, body, status, proposed_by)
      VALUES ('pain', ${`alphaterm backlog insight ${i}`}, 'approved', 'seed') RETURNING id`;
    await sql`INSERT INTO kb_insight_sources (insight_id, document_id) VALUES (${ins.id}, ${DID})`;
  }
  const [{ n: pending }] = await sql`SELECT count(*)::int AS n FROM kb_insights i
    WHERE i.status='approved' AND NOT EXISTS (SELECT 1 FROM kb_embeddings e WHERE e.insight_id=i.id)`;
  console.log(`  approved insights with no vector: ${pending}`);
  calls = 0; texts = 0;
  const r = await call('GET', '/search?q=alphaterm', undefined, SERVICE);
  console.log(`  ONE service GET /search → HTTP ${r.status} provider calls=${calls} texts embedded=${texts}`);
  console.log(`  the response reports the spend as: ${JSON.stringify(r.j?.backfill ?? null)}`);
  const [{ n: left }] = await sql`SELECT count(*)::int AS n FROM kb_insights i
    WHERE i.status='approved' AND NOT EXISTS (SELECT 1 FROM kb_embeddings e WHERE e.insight_id=i.id)`;
  console.log(`  still unembedded after that ONE request: ${left}`);
  console.log(`  grep -E for a spend meter in the Brain files (anchored: 'parameter' must not count): ${spawnSync('grep', ['-rEil', '(^|[^a-z])(budget|meter|spend|cost)([^a-z]|$)', join(REPO, 'server/src/services/brainStore.js'), join(REPO, 'server/src/services/brainSearch.js'), join(REPO, 'server/src/routes/brain.js')], { encoding: 'utf8' }).stdout.trim() || '(no hits)'}`);
}

globalThis.fetch = realFetch;
await sql.end();
server.close();
console.log('\n(probe C done)');
