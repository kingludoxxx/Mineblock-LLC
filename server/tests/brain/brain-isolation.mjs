// test-timeout: 300s
// S4-SB — ISOLATION PROOF. Two stores, two databases, two dashboard PROCESSES.
//
// The claim under test is STRUCTURAL, not "we remembered a WHERE clause":
//   • there is NO store_id column in the Brain schema and NO store parameter in
//     the API, so a search on store A's API has no expressible way to name B;
//   • each API runs in its own process bound to its own DATABASE_URL;
//   • the service token is per PAIR (its own env in its own process), so A's
//     token is refused by B's API.
//
// Asserts BY EXECUTION:
//   I1 the schema carries no store_id / store_code retrieval column and the router
//      exposes no store parameter (grep — the property that makes leakage impossible)
//   I2 A's search never returns B's documents or insights, on a term that matches
//      BOTH, and B's never returns A's
//   I3 A's document id, requested from B's API, is NOT A's document
//   I4 the service token of pair A is REFUSED (401) by pair B and vice versa
//   I5 a document written through A's API is invisible in B's database at the SQL level
//
// Run:  node server/tests/brain/brain-isolation.mjs
import postgres from 'postgres';
import { spawn, spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO = join(HERE, '..', '..', '..');
const PG = 'postgres://postgres@127.0.0.1:5433';

let pass = 0, fail = 0;
const ok = (c, m, x = '') => { if (c) { pass++; console.log('PASS ', m); } else { fail++; console.log('FAIL ', m, x ? `\n      ${String(x).split('\n').join('\n      ')}` : ''); } };

const STORES = [
  { name: 'A', db: 's4_brain_store_a', code: 'SA', token: 'token-store-a-aaaaaaaaaaaaaaaa', product: 'AAA' },
  { name: 'B', db: 's4_brain_store_b', code: 'SB', token: 'token-store-b-bbbbbbbbbbbbbbbb', product: 'BBB' },
];

const admin = postgres(`${PG}/postgres`, { ssl: false, onnotice: () => {} });
for (const s of STORES) {
  await admin.unsafe(`DROP DATABASE IF EXISTS ${s.db}`);
  await admin.unsafe(`CREATE DATABASE ${s.db}`);
}
await admin.end();

for (const s of STORES) {
  s.url = `${PG}/${s.db}`;
  const r = spawnSync(process.execPath, [join(REPO, 'server/migrations/run.js')], {
    env: { ...process.env, DATABASE_URL: s.url, MIGRATE_SSL: '0', STORE_CODE: s.code },
    encoding: 'utf8', timeout: 180000,
  });
  ok(r.status === 0, `I0.${s.name} store ${s.name} database migrated`, (r.stdout || '') + (r.stderr || ''));
}

// ── I1 the structural property, by grep ───────────────────────────────────
{
  const schema = ['128_brain_kb_core.sql', '129_brain_embeddings.sql', '130_brain_playbook.sql']
    .map((f) => readFileSync(join(REPO, 'server/migrations', f), 'utf8')).join('\n');
  const cols = schema.match(/^\s*store_id\b/gmi) || [];
  ok(cols.length === 0, 'I1.1 the Brain schema declares NO store_id column (isolation is physical)', cols.join(','));
  const router = readFileSync(join(REPO, 'server/src/routes/brain.js'), 'utf8');
  const svc = readFileSync(join(REPO, 'server/src/services/brainSearch.js'), 'utf8');
  const params = (router + svc).match(/\b(store_id|storeId|store_code|storeCode)\b/g) || [];
  ok(params.length === 0, 'I1.2 the Brain API accepts NO store parameter — retrieval is scoped by construction', params.join(','));
}

// ── boot one dashboard process per store ──────────────────────────────────
async function boot(store) {
  const child = spawn(process.execPath, [join(HERE, '_boot.mjs')], {
    env: {
      ...process.env,
      BRAIN_TEST_HOST: '1',
      DATABASE_URL: store.url, DATABASE_SSL: '0', NODE_ENV: 'development',
      JWT_ACCESS_SECRET: 'localdev', JWT_REFRESH_SECRET: 'localdev',
      BRAIN_SERVICE_TOKEN: store.token,
      PRODUCT_CODES_JSON: JSON.stringify({ [store.product]: { default: true } }),
      MONEY_SWEEP_DISABLED: '1', TRACKING_SWEEPS_DISABLED: '1', DOMAIN_SWEEP_DISABLED: '1',
      OPENAI_API_KEY: '',
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let err = '';
  child.stderr.on('data', (d) => { err += d.toString(); });
  const port = await new Promise((resolve, reject) => {
    let buf = '';
    const t = setTimeout(() => reject(new Error(`store ${store.name} did not listen: ${err}`)), 30000);
    child.stdout.on('data', (d) => {
      buf += d.toString();
      const m = buf.match(/LISTENING (\d+)/);
      if (m) { clearTimeout(t); resolve(Number(m[1])); }
    });
    child.on('exit', (c) => { clearTimeout(t); reject(new Error(`store ${store.name} exited ${c}: ${err}`)); });
  });
  return { child, base: `http://127.0.0.1:${port}/api/v1/brain` };
}

for (const s of STORES) Object.assign(s, await boot(s));

const callAs = (base, token) => async (method, path, body) => {
  const r = await fetch(`${base}${path}`, {
    method,
    headers: { 'X-Brain-Service-Token': token, 'Content-Type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  let j = null; try { j = await r.json(); } catch { /* non-JSON */ }
  return { status: r.status, j };
};

const [A, B] = STORES;
const aCall = callAs(A.base, A.token);
const bCall = callAs(B.base, B.token);

// A term that matches in BOTH stores — so a leak would be VISIBLE, not hidden
// behind a query that could never have matched the other store anyway.
const SHARED_TERM = 'squeaky';
const aDoc = await aCall('POST', '/ingest', {
  source: 'reddit', title: 'store A thread', product_code: A.product,
  text: `The squeaky hinge on the STORE-A-ONLY-SECRET unit drove me mad.`,
});
const bDoc = await bCall('POST', '/ingest', {
  source: 'reddit', title: 'store B thread', product_code: B.product,
  text: `A squeaky wheel on the STORE-B-ONLY-SECRET unit drove me mad.`,
});
ok(aDoc.status === 201 && bDoc.status === 201, 'I2.0 one document ingested into each store',
  `${aDoc.status}/${bDoc.status} ${JSON.stringify(aDoc.j || bDoc.j).slice(0, 200)}`);

// ── I2 cross-store search ─────────────────────────────────────────────────
{
  const ra = await aCall('GET', `/search?q=${SHARED_TERM}`);
  const blob = JSON.stringify(ra.j);
  ok(ra.status === 200 && (ra.j.results || []).length === 1, 'I2.1 store A search finds exactly its OWN one document', blob.slice(0, 300));
  ok(!blob.includes('STORE-B-ONLY-SECRET'), 'I2.2 store A search NEVER returns store B content', blob.slice(0, 300));
  const rb = await bCall('GET', `/search?q=${SHARED_TERM}`);
  const blobB = JSON.stringify(rb.j);
  ok(rb.status === 200 && (rb.j.results || []).length === 1, 'I2.3 store B search finds exactly its OWN one document', blobB.slice(0, 300));
  ok(!blobB.includes('STORE-A-ONLY-SECRET'), 'I2.4 store B search NEVER returns store A content', blobB.slice(0, 300));
}

// ── I3 id from the other store ────────────────────────────────────────────
{
  const idA = aDoc.j.document.id;
  const fromB = await bCall('GET', `/documents/${idA}`);
  const body = JSON.stringify(fromB.j || {});
  ok(!body.includes('STORE-A-ONLY-SECRET'),
    'I3.1 store A\'s document id, asked of store B, never yields store A\'s content', body.slice(0, 200));
}

// ── I4 per-pair service tokens ────────────────────────────────────────────
{
  const aTokenAtB = await callAs(B.base, A.token)('GET', `/search?q=${SHARED_TERM}`);
  ok(aTokenAtB.status === 401, 'I4.1 store A\'s service token is REFUSED by store B\'s API (401)', `got ${aTokenAtB.status}`);
  const bTokenAtA = await callAs(A.base, B.token)('GET', `/search?q=${SHARED_TERM}`);
  ok(bTokenAtA.status === 401, 'I4.2 store B\'s service token is REFUSED by store A\'s API (401)', `got ${bTokenAtA.status}`);
}

// ── I5 SQL-level check ────────────────────────────────────────────────────
{
  const sa = postgres(A.url, { ssl: false, onnotice: () => {} });
  const sb = postgres(B.url, { ssl: false, onnotice: () => {} });
  const inA = await sa`SELECT count(*)::int AS n FROM kb_documents WHERE body_text LIKE '%STORE-B-ONLY-SECRET%'`;
  const inB = await sb`SELECT count(*)::int AS n FROM kb_documents WHERE body_text LIKE '%STORE-A-ONLY-SECRET%'`;
  ok(inA[0].n === 0 && inB[0].n === 0, 'I5.1 neither database physically contains the other store\'s row', `${inA[0].n}/${inB[0].n}`);
  const ownA = await sa`SELECT count(*)::int AS n FROM kb_documents`;
  const ownB = await sb`SELECT count(*)::int AS n FROM kb_documents`;
  ok(ownA[0].n === 1 && ownB[0].n === 1, 'I5.2 …each holds exactly its own one document', `${ownA[0].n}/${ownB[0].n}`);
  await sa.end(); await sb.end();
}

for (const s of STORES) s.child.kill('SIGTERM');
console.log(`\n${pass} passed, ${fail} failed, 0 skipped`);
process.exit(fail ? 1 : 0);
