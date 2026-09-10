// P0-2 / P0-3 / P1-4 / P1-5 / P1-6 / P1-7 probes — the REAL router over HTTP on a
// fresh local database. Reproduces the reviewer's five probes verbatim in intent.
// GUARD: run-all.mjs discovers every .mjs under server/tests and runs it as a
// test. This is a REVIEW PROBE, not a test — it prints findings rather than
// asserting them, and it needs a pgvector server. The suites assert the same
// properties (brain-vector.mjs V6/V7). Set BRAIN_PROBE=1 to run it by hand.
if (process.env.BRAIN_PROBE !== '1') {
  console.log('SKIP  brain/probes: a review probe, not a test — run with BRAIN_PROBE=1 (see probes/README.md)');
  process.exit(0);
}

import postgres from 'postgres';
import { spawnSync } from 'node:child_process';

const REPO = '/Users/ludo/wt-s4-brain';
const PG = 'postgres://postgres@127.0.0.1:5433';
const DBNAME = 'sb2_httpprobe';
const DB = `${PG}/${DBNAME}`;

const admin = postgres(`${PG}/postgres`, { ssl: false, onnotice: () => {} });
await admin.unsafe(`DROP DATABASE IF EXISTS ${DBNAME}`);
await admin.unsafe(`CREATE DATABASE ${DBNAME}`);
await admin.end();

const SERVICE_TOKEN = 'svc-token-probe-0123456789';
Object.assign(process.env, {
  DATABASE_URL: DB, DATABASE_SSL: '0', NODE_ENV: 'development',
  JWT_ACCESS_SECRET: 'localdev', JWT_REFRESH_SECRET: 'localdev',
  PRODUCT_CODES_JSON: JSON.stringify({ AAA: { default: true } }),
  BRAIN_SERVICE_TOKEN: SERVICE_TOKEN, STORE_CODE: 'SA',
  MONEY_SWEEP_DISABLED: '1', TRACKING_SWEEPS_DISABLED: '1', DOMAIN_SWEEP_DISABLED: '1',
});
const mig = spawnSync(process.execPath, [`${REPO}/server/migrations/run.js`], {
  env: { ...process.env, MIGRATE_SSL: '0' }, encoding: 'utf8', timeout: 180000,
});
if (mig.status !== 0) { console.error(mig.stdout, mig.stderr); process.exit(2); }

const sql = postgres(DB, { ssl: false, onnotice: () => {} });
const { default: express } = await import(`${REPO}/node_modules/express/index.js`);
const { default: brainRoutes } = await import(`${REPO}/server/src/routes/brain.js`);
const { signAccessToken } = await import(`${REPO}/server/src/utils/jwt.js`);

const [u] = await sql`INSERT INTO users (id,email,first_name,last_name,is_active)
  VALUES (gen_random_uuid(),'p@t.co','P','T',TRUE) RETURNING id`;
const [r] = await sql`INSERT INTO roles (id,name,permissions)
  VALUES (gen_random_uuid(),'brain-probe', ${sql.json({ brain: ['access', 'read', 'write', 'approve'] })}) RETURNING id`;
await sql`INSERT INTO user_roles (user_id,role_id) VALUES (${u.id},${r.id})`;
const TOKEN = signAccessToken({ userId: u.id });

const app = express();
app.use(express.json({ limit: '10mb' }));
app.use('/api/v1/brain', brainRoutes);
const server = app.listen(0);
await new Promise((res) => server.once('listening', res));
const BASE = `http://127.0.0.1:${server.address().port}/api/v1/brain`;
const SESSION = { Authorization: `Bearer ${TOKEN}`, 'Content-Type': 'application/json' };
const SERVICE = { 'X-Brain-Service-Token': SERVICE_TOKEN, 'Content-Type': 'application/json' };

async function call(method, path, body, headers = SESSION) {
  const res = await fetch(`${BASE}${path}`, {
    method, headers, body: body === undefined ? undefined : JSON.stringify(body),
  });
  let j = null; try { j = await res.json(); } catch { /* non-JSON */ }
  return { status: res.status, j };
}

// fixtures: one document, two insights (one will be approved, one stays proposed)
const doc = await call('POST', '/ingest', { source: 'forum', title: 'seed', text: 'squeaky bearings on the alphaterm rig' }, SESSION);
const DID = doc.j.document.id;
const i1 = await call('POST', '/insights', { insight_type: 'pain', body: 'squeaky bearings are the top pain', source_document_ids: [DID] });
const i2 = await call('POST', '/insights', { insight_type: 'pain', body: 'a second, still-proposed squeaky claim', source_document_ids: [DID] });
const I1 = i1.j.insight.id, I2 = i2.j.insight.id;

console.log('### PROBE 1  service token PATCH -> approved');
{
  const p = await call('PATCH', `/insights/${I1}`, { status: 'approved' }, SERVICE);
  console.log(`HTTP ${p.status}  status=${p.j?.insight?.status}  approved_by=${JSON.stringify(p.j?.insight?.approved_by)}  code=${p.j?.code || ''}`);
}
// make sure I1 really is approved for the later probes (session actor)
await call('PATCH', `/insights/${I1}`, { status: 'approved' }, SESSION);

console.log('\n### PROBE 2  service token search approved_only=false');
{
  const s = await call('GET', '/search?q=squeaky&approved_only=false', undefined, SERVICE);
  const st = (s.j?.results || []).filter((x) => x.kind === 'insight').map((x) => `${x.id}:${x.status}`);
  console.log(`HTTP ${s.status} approved_only=${s.j?.approved_only} insight statuses=${JSON.stringify(st)} code=${s.j?.code || ''}`);
  const d = await call('GET', '/search?q=squeaky', undefined, SERVICE);
  console.log(`### PROBE 2b default -> ${JSON.stringify((d.j?.results || []).filter((x) => x.kind === 'insight').map((x) => `${x.id}:${x.status}`))}`);
}

console.log('\n### PROBE 3  service token PUT /playbook citing PROPOSED insight');
{
  const p = await call('PUT', '/playbook/AAA', {
    sections: { angles: [{ key: 'a1', value: { copy: 'written by a pipeline' }, cites: [I2] }] },
  }, SERVICE);
  console.log(`HTTP ${p.status} version=${p.j?.playbook?.version} cites=${JSON.stringify(p.j?.playbook?.sections?.angles?.[0]?.cites)} code=${p.j?.code || ''}`);
  const l = await call('POST', '/playbook/AAA/lock', {}, SERVICE);
  console.log(`### PROBE 3b service token LOCK -> HTTP ${l.status} locked_by=${JSON.stringify(l.j?.playbook?.locked_by)} code=${l.j?.code || ''}`);
}

console.log('\n### PROBE 3c session PUT citing a PROPOSED insight (P1-5)');
{
  const p = await call('PUT', '/playbook/AAA', {
    sections: { angles: [{ key: 'a1', value: { copy: 'cites a proposed insight' }, cites: [I2] }] },
  }, SESSION);
  console.log(`HTTP ${p.status} code=${p.j?.code || ''} cites=${JSON.stringify(p.j?.playbook?.sections?.angles?.[0]?.cites)}`);
}

console.log('\n### PROBE 4  LOCK is real? (P1-4)');
{
  await call('PUT', '/playbook/AAA', { sections: { angles: [{ key: 'a1', value: { copy: 'v1' }, cites: [I1] }] } }, SESSION);
  const l = await call('POST', '/playbook/AAA/lock', {}, SESSION);
  console.log(`locked: version=${l.j?.playbook?.version} locked_at=${l.j?.playbook?.locked_at}`);
  const p = await call('PUT', '/playbook/AAA', { sections: { angles: [{ key: 'a1', value: { copy: 'REWRITTEN AFTER THE LOCK' }, cites: [I1] }] } }, SESSION);
  console.log(`PUT on the LOCKED playbook -> HTTP ${p.status} code=${p.j?.code || ''} version=${p.j?.playbook?.version}`);
  const g = await call('GET', '/playbook/AAA', undefined, SESSION);
  console.log(`entry now: ${JSON.stringify(g.j?.playbook?.sections?.angles?.[0]?.value)} version=${g.j?.playbook?.version} locked_at=${g.j?.playbook?.locked_at}`);
  const un = await call('POST', '/playbook/AAA/unlock', {}, SESSION);
  console.log(`POST /unlock -> HTTP ${un.status} locked_at=${JSON.stringify(un.j?.playbook?.locked_at)} code=${un.j?.code || ''}`);
}

console.log('\n### PROBE 5  attacker-controlled ext / body_object_key (P1-6)');
{
  const a = await call('POST', '/ingest', {
    source: 'operator-research', text: 'payload A for the ext probe',
    ext: 'txt/../../../../brand-spy/videos/owned',
  }, SESSION);
  console.log(`HTTP ${a.status} code=${a.j?.code || ''} body_object_key=${JSON.stringify(a.j?.document?.body_object_key)}`);
  const b = await call('POST', '/ingest', {
    source: 'operator-research', text: 'payload B for the key probe',
    body_object_key: '../../../other-store/secret.txt',
  }, SESSION);
  console.log(`HTTP ${b.status} code=${b.j?.code || ''} body_object_key=${JSON.stringify(b.j?.document?.body_object_key)}`);
  const c = await call('POST', '/ingest', {
    source: 'operator research', text: 'payload C, honest', content_type: 'text/markdown',
  }, SESSION);
  console.log(`clean ingest -> HTTP ${c.status} body_object_key=${JSON.stringify(c.j?.document?.body_object_key)}`);
}

console.log('\n### PROBE 6  service token POST /ingest and POST /extract');
{
  const g = await call('POST', '/ingest', { source: 'forum', text: 'a pipeline writing raw sources' }, SERVICE);
  console.log(`ingest via service -> HTTP ${g.status} code=${g.j?.code || ''}`);
  const e = await call('POST', '/extract', { document_id: DID }, SERVICE);
  console.log(`extract via service -> HTTP ${e.status} code=${e.j?.code || ''}`);
  const s = await call('GET', '/search?q=squeaky', undefined, SERVICE);
  console.log(`search via service  -> HTTP ${s.status} (must stay 200)`);
  const d = await call('GET', `/documents/${DID}`, undefined, SERVICE);
  console.log(`document via service-> HTTP ${d.status} (must stay 200)`);
  const pb = await call('GET', '/playbook/AAA', undefined, SERVICE);
  console.log(`playbook GET service-> HTTP ${pb.status} (must stay 200)`);
}

console.log('\n### PROBE 7  bucket isolation (P1-7)');
{
  const { brainObjectKey } = await import(`${REPO}/server/src/services/brain/brainSchema.js`).catch(() => ({}));
  const r2 = await import(`${REPO}/server/src/services/r2.js`);
  console.log('isR2Configured() with no R2 env:', r2.isR2Configured());
  console.log('r2Config exported (request-time read):', typeof r2.r2Config === 'function');
  console.log('brainObjectKey exported:', typeof brainObjectKey === 'function');
}

await sql.end();
server.close();
process.exit(0);
