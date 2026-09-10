// test-timeout: 300s
// S4-SB — THE STORE BRAIN: route + service acceptance tests (written BEFORE the
// code, R24). The REAL router mounted on a minimal express host against a fresh
// local database migrated by the REAL runner.
//
// Asserts BY EXECUTION:
//   B1  auth: 401 on every verb with no credential; a dashboard session works;
//       a WRONG service token is refused; the right one works; with
//       BRAIN_SERVICE_TOKEN unset a service-token request is 503, never open
//   B2  ingest is idempotent by content hash (second POST → created:false, 0 new rows)
//   B3  product codes are validated against PRODUCT_CODES_JSON (unknown → 400)
//   B4  search returns CITATIONS (document ids + quotes) and defaults to
//       approved_only=true: a proposed insight is invisible until approved
//   B5  keyword (tsvector) path works with no embedding provider; the vector path
//       is exercised where pgvector exists, and SKIPS with a reason where it does not
//   B6  insights: POST requires >=1 source document; PATCH approve/reject records
//       the actor; a bad status is refused
//   B7  playbook: PUT/GET round-trip, unknown section refused, citations survive
//   B8  extract PROPOSES and never auto-approves (LLM mocked via clientFactory)
//   B9  failure paths: unknown document 404, malformed JSON body no crash,
//       empty body refused, limit clamped
//
// Run:  node server/tests/brain/brain-routes.mjs
import postgres from 'postgres';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO = join(HERE, '..', '..', '..');
const PG = 'postgres://postgres@127.0.0.1:5433';
const DBNAME = 's4_brain_routes';
const DB = `${PG}/${DBNAME}`;

let pass = 0, fail = 0, skip = 0;
const ok = (c, m, x = '') => { if (c) { pass++; console.log('PASS ', m); } else { fail++; console.log('FAIL ', m, x ? `\n      ${String(x).split('\n').join('\n      ')}` : ''); } };
const skipped = (m, why) => { skip++; console.log('SKIP ', m, `— ${why}`); };

const admin = postgres(`${PG}/postgres`, { ssl: false, onnotice: () => {} });
await admin.unsafe(`DROP DATABASE IF EXISTS ${DBNAME}`);
await admin.unsafe(`CREATE DATABASE ${DBNAME}`);
await admin.end();

const PRODUCT_CODES_JSON = JSON.stringify({ AAA: { default: true }, BBB: {} });
const SERVICE_TOKEN = 'svc-token-routes-0123456789';

const mig = spawnSync(process.execPath, [join(REPO, 'server/migrations/run.js')], {
  env: { ...process.env, DATABASE_URL: DB, MIGRATE_SSL: '0', STORE_CODE: 'SA' },
  encoding: 'utf8', timeout: 180000,
});
ok(mig.status === 0, 'B0.1 real migration runner brings an EMPTY database to the Brain schema',
  (mig.stdout || '') + (mig.stderr || ''));

Object.assign(process.env, {
  DATABASE_URL: DB, DATABASE_SSL: '0', NODE_ENV: 'development',
  JWT_ACCESS_SECRET: 'localdev', JWT_REFRESH_SECRET: 'localdev',
  PRODUCT_CODES_JSON, BRAIN_SERVICE_TOKEN: SERVICE_TOKEN, STORE_CODE: 'SA',
  MONEY_SWEEP_DISABLED: '1', TRACKING_SWEEPS_DISABLED: '1', DOMAIN_SWEEP_DISABLED: '1',
});
delete process.env.OPENAI_API_KEY;

const sql = postgres(DB, { ssl: false, onnotice: () => {} });
const { default: express } = await import('express');
const { default: brainRoutes } = await import('../../src/routes/brain.js');
const { signAccessToken } = await import('../../src/utils/jwt.js');
const { vectorColumnAvailable } = await import('../../src/services/brain/embeddingProvider.js');

const [u] = await sql`INSERT INTO users (id, email, first_name, last_name, is_active)
          VALUES (gen_random_uuid(),'b@t.co','B','T', TRUE) RETURNING id`;
const [r] = await sql`INSERT INTO roles (id, name, permissions)
          VALUES (gen_random_uuid(),'brain-tester', ${sql.json({ brain: ['access', 'read', 'write', 'approve'] })}) RETURNING id`;
await sql`INSERT INTO user_roles (user_id, role_id) VALUES (${u.id}, ${r.id})`;
const TOKEN = signAccessToken({ userId: u.id });

// A SECOND user who may read and write but may NOT approve — the split the flat
// `brain:access` permission used to hide (S4-SB2).
const [u2] = await sql`INSERT INTO users (id, email, first_name, last_name, is_active)
          VALUES (gen_random_uuid(),'w@t.co','W','T', TRUE) RETURNING id`;
const [r2] = await sql`INSERT INTO roles (id, name, permissions)
          VALUES (gen_random_uuid(),'brain-writer', ${sql.json({ brain: ['access', 'read', 'write'] })}) RETURNING id`;
await sql`INSERT INTO user_roles (user_id, role_id) VALUES (${u2.id}, ${r2.id})`;
const WRITER_TOKEN = signAccessToken({ userId: u2.id });

const app = express();
app.use(express.json({ limit: '10mb' }));
app.use('/api/v1/brain', brainRoutes);
const server = app.listen(0);
await new Promise((r) => server.once('listening', r));
const BASE = `http://127.0.0.1:${server.address().port}/api/v1/brain`;

const SESSION = { Authorization: `Bearer ${TOKEN}`, 'Content-Type': 'application/json' };
const SERVICE = { 'X-Brain-Service-Token': SERVICE_TOKEN, 'Content-Type': 'application/json' };
const NOAUTH = { 'Content-Type': 'application/json' };
const WRITER = { Authorization: `Bearer ${WRITER_TOKEN}`, 'Content-Type': 'application/json' };

async function call(method, path, body, headers = SESSION) {
  const r = await fetch(`${BASE}${path}`, {
    method, headers,
    body: body === undefined ? undefined : (typeof body === 'string' ? body : JSON.stringify(body)),
  });
  let j = null; try { j = await r.json(); } catch { /* non-JSON */ }
  return { status: r.status, j };
}

// ── B1 auth ────────────────────────────────────────────────────────────────
for (const [m, p, b] of [
  ['GET', '/search?q=x'], ['GET', '/documents/1'], ['GET', '/insights'],
  ['POST', '/insights', {}], ['PATCH', '/insights/1', {}],
  ['GET', '/playbook/AAA'], ['PUT', '/playbook/AAA', {}],
  ['POST', '/ingest', {}], ['POST', '/extract', {}],
]) {
  const r = await call(m, p, b, NOAUTH);
  ok(r.status === 401, `B1.1 ${m} ${p.split('?')[0]} with NO credential → 401`, `got ${r.status}`);
}
{
  const r = await call('GET', '/search?q=x', undefined, { 'X-Brain-Service-Token': 'wrong-token-wrong-token' });
  ok(r.status === 401, 'B1.2 a WRONG service token is refused (401)', `got ${r.status}`);
}
{
  const saved = process.env.BRAIN_SERVICE_TOKEN;
  delete process.env.BRAIN_SERVICE_TOKEN;
  const r = await call('GET', '/search?q=x', undefined, SERVICE);
  ok(r.status === 503, 'B1.3 with BRAIN_SERVICE_TOKEN UNSET a service request is 503, never allowed through', `got ${r.status}`);
  process.env.BRAIN_SERVICE_TOKEN = saved;
  const r2 = await call('GET', '/search?q=x', undefined, SERVICE);
  ok(r2.status === 200, 'B1.4 the flag is read at REQUEST time (R7): restoring the env makes the same call 200', `got ${r2.status}`);
}
{
  const r = await call('GET', '/search?q=x', undefined, SESSION);
  ok(r.status === 200, 'B1.5 a dashboard session with brain:access is allowed', `got ${r.status} ${JSON.stringify(r.j)}`);
}

// ── B2 ingest idempotency ──────────────────────────────────────────────────
const DOC_TEXT = 'My knees ache every single morning and the cheap braces slip off after ten minutes.';
const ing1 = await call('POST', '/ingest', {
  source: 'reddit', url: 'https://example.invalid/r/x/1', title: 'knee pain thread',
  text: DOC_TEXT, product_code: 'AAA', captured_at: '2026-09-01T10:00:00Z', scrape_job_id: 'job-1',
});
ok(ing1.status === 201 && ing1.j?.created === true && ing1.j?.document?.id,
  'B2.1 POST /ingest creates a document', JSON.stringify(ing1.j));
const DOC_ID = ing1.j?.document?.id;
ok(typeof DOC_ID === 'number', 'B2.1b ids are NUMBERS across the whole API (not int8 strings from one path and numbers from another)', typeof DOC_ID);
ok(typeof ing1.j?.document?.body_object_key === 'string'
   && /^stores\/SA\/knowledge\/raw\/reddit\/2026-09-01\/[0-9a-f]{64}\.txt$/.test(ing1.j.document.body_object_key),
  'B2.2 the bucket key is stores/<STORE_CODE>/knowledge/raw/<source>/<date>/<sha256>.<ext> — the store prefix is what stops two stores colliding in one bucket',
  ing1.j?.document?.body_object_key);
const ing2 = await call('POST', '/ingest', {
  source: 'reddit', url: 'https://example.invalid/r/x/1', title: 'knee pain thread',
  text: DOC_TEXT, product_code: 'AAA',
});
ok(ing2.status === 200 && ing2.j?.created === false && ing2.j?.document?.id === DOC_ID,
  'B2.3 the SAME content re-ingested is idempotent (created:false, same id)', JSON.stringify(ing2.j));
const [{ n: docCount }] = await sql`SELECT count(*)::int AS n FROM kb_documents`;
ok(docCount === 1, 'B2.4 …and wrote NO second row', `rows=${docCount}`);

// ── B3 product-code validation (R5/R15) ────────────────────────────────────
{
  const r = await call('POST', '/ingest', { source: 'reddit', text: 'x', product_code: 'ZZZ' });
  ok(r.status === 400 && /product/i.test(JSON.stringify(r.j)),
    'B3.1 an unknown product code is refused against PRODUCT_CODES_JSON (400)', JSON.stringify(r.j));
}
{
  const src = await import('node:fs').then((fs) => fs.readFileSync(join(REPO, 'server/src/services/brain/brainSchema.js'), 'utf8')
    + fs.readFileSync(join(REPO, 'server/src/services/brainStore.js'), 'utf8')
    + fs.readFileSync(join(REPO, 'server/src/services/brainSearch.js'), 'utf8')
    + fs.readFileSync(join(REPO, 'server/src/routes/brain.js'), 'utf8'));
  const literals = src.match(/\b(AAA|BBB|puure|trypuure|mineblock|minerforge)\b/gi) || [];
  ok(literals.length === 0, 'B3.2 R15: no store/product literal anywhere in the Brain engine code', literals.join(','));
}

// ── B4/B5 search, citations, approved_only ─────────────────────────────────
const ins1 = await call('POST', '/insights', {
  insight_type: 'pain', product_code: 'AAA',
  body: 'Cheap knee braces slip down during the day',
  quote: 'the cheap braces slip off after ten minutes',
  confidence: 0.8, source_document_ids: [DOC_ID],
});
ok(ins1.status === 201 && ins1.j?.insight?.status === 'proposed',
  'B4.1 a new insight lands PROPOSED (never auto-approved)', JSON.stringify(ins1.j));
const INS_ID = ins1.j?.insight?.id;
ok(typeof INS_ID === 'number', 'B4.1b …insight ids too', typeof INS_ID);

{
  const r = await call('GET', '/search?q=braces&type=insight');
  const ids = (r.j?.results || []).filter((x) => x.kind === 'insight').map((x) => x.id);
  ok(r.status === 200 && !ids.includes(INS_ID),
    'B4.2 approved_only defaults TRUE: the proposed insight is NOT returned', JSON.stringify(r.j));
}
{
  const r = await call('GET', '/search?q=braces&type=insight&approved_only=false');
  const ids = (r.j?.results || []).filter((x) => x.kind === 'insight').map((x) => x.id);
  ok(r.status === 200 && ids.includes(INS_ID),
    'B4.3 approved_only=false makes it visible (visible, but never used by a pipeline)', JSON.stringify(r.j));
}
{
  const r = await call('PATCH', `/insights/${INS_ID}`, { status: 'approved' });
  ok(r.status === 200 && r.j?.insight?.status === 'approved' && r.j?.insight?.approved_by,
    'B6.1 PATCH approves and records approved_by', JSON.stringify(r.j));
}
{
  const r = await call('GET', '/search?q=braces');
  const hit = (r.j?.results || []).find((x) => x.kind === 'insight' && x.id === INS_ID);
  ok(!!hit, 'B4.4 the approved insight is now returned by default', JSON.stringify(r.j));
  ok(!!hit && Array.isArray(hit.citations) && hit.citations.some((c) => c.document_id === DOC_ID && c.quote),
    'B4.5 …carrying CITATIONS (document id + quote)', JSON.stringify(hit));
  ok(r.j?.mode === 'keyword',
    'B5.1 with no OPENAI_API_KEY search runs the tsvector KEYWORD path', String(r.j?.mode));
}
{
  const r = await call('GET', '/search?q=braces&source=reddit&product=AAA&from=2026-08-01&to=2026-12-31');
  ok(r.status === 200 && (r.j?.results || []).length > 0, 'B4.6 filters (source/product/date range) pass through', JSON.stringify(r.j));
  const r2 = await call('GET', '/search?q=braces&source=trustpilot');
  ok(r2.status === 200 && (r2.j?.results || []).length === 0, 'B4.7 a non-matching source filter returns nothing', JSON.stringify(r2.j));
}
{
  const hasVec = await vectorColumnAvailable(sql);
  if (!hasVec) {
    skipped('B5.2 vector path end-to-end', 'pgvector is not available on this Postgres (proved by execution: CREATE EXTENSION vector → "extension \\"vector\\" is not available")');
  } else {
    process.env.OPENAI_API_KEY = 'test-key';
    const { search } = await import('../../src/services/brainSearch.js');
    const fake = { name: 'openai', model: 'text-embedding-3-small', dim: 1536, embed: async (t) => t.map(() => new Array(1536).fill(0.01)) };
    const r = await search(sql, { q: 'braces', provider: fake });
    ok(r.mode === 'vector', 'B5.2 vector path used when pgvector AND a provider are present', r.mode);
    delete process.env.OPENAI_API_KEY;
  }
}

// ── B6 insights failure paths ──────────────────────────────────────────────
{
  const r = await call('POST', '/insights', { insight_type: 'pain', body: 'no provenance', source_document_ids: [] });
  ok(r.status === 400 && /source/i.test(JSON.stringify(r.j)),
    'B6.2 an insight with NO source document is refused (an assertion is not an insight)', JSON.stringify(r.j));
}
{
  const r = await call('POST', '/insights', { insight_type: 'not_a_type', body: 'x', source_document_ids: [DOC_ID] });
  ok(r.status === 400, 'B6.3 an unknown insight_type is refused', JSON.stringify(r.j));
}
{
  const r = await call('PATCH', `/insights/${INS_ID}`, { status: 'blessed' });
  ok(r.status === 400, 'B6.4 an unknown status is refused', JSON.stringify(r.j));
}
{
  const r = await call('POST', '/insights', { insight_type: 'pain', body: 'x', source_document_ids: [999999] });
  ok(r.status === 400 && /document/i.test(JSON.stringify(r.j)),
    'B6.5 a source document that does not exist is refused', JSON.stringify(r.j));
}
{
  const r = await call('GET', '/insights?status=approved');
  ok(r.status === 200 && (r.j?.insights || []).every((i) => i.status === 'approved'),
    'B6.6 GET /insights filters by status', JSON.stringify(r.j).slice(0, 200));
}

// ── B7 playbook ────────────────────────────────────────────────────────────
{
  const r = await call('PUT', '/playbook/AAA', {
    checkout_url: 'https://example.invalid/checkout',
    sections: {
      avatars: [{ key: 'a1', value: { name: 'Weekend runner', age: '35-50' }, cites: [INS_ID] }],
      forbidden_claims: [{ key: 'f1', value: { claim: 'cures arthritis' } }],
      voice_rules: [{ key: 'v1', value: { rule: 'no em dashes' } }],
    },
  });
  ok(r.status === 200, 'B7.1 PUT /playbook/:product writes', JSON.stringify(r.j).slice(0, 300));
  const g = await call('GET', '/playbook/AAA');
  ok(g.status === 200 && g.j?.playbook?.sections?.avatars?.[0]?.value?.name === 'Weekend runner',
    'B7.2 GET round-trips the value', JSON.stringify(g.j).slice(0, 300));
  ok(g.j?.playbook?.sections?.avatars?.[0]?.cites?.includes(INS_ID),
    'B7.3 …and the field CITES its insight', JSON.stringify(g.j?.playbook?.sections?.avatars));
  ok(g.j?.playbook?.checkout_url === 'https://example.invalid/checkout', 'B7.4 checkout link round-trips');
}
{
  const r = await call('PUT', '/playbook/AAA', { sections: { made_up_section: [{ key: 'x', value: {} }] } });
  ok(r.status === 400 && /section/i.test(JSON.stringify(r.j)), 'B7.5 an unknown playbook section is refused', JSON.stringify(r.j));
}
{
  const r = await call('PUT', '/playbook/ZZZ', { sections: {} });
  ok(r.status === 400, 'B7.6 the playbook product code is validated too', JSON.stringify(r.j));
}
{
  const r = await call('GET', '/playbook/BBB');
  ok(r.status === 200 && r.j?.playbook?.product_code === 'BBB' && Object.keys(r.j.playbook.sections || {}).length >= 0,
    'B7.7 a known product with no playbook yet returns an EMPTY playbook, not 404', JSON.stringify(r.j).slice(0, 200));
}

// ── B8 extraction proposes, never approves ─────────────────────────────────
{
  const { runExtraction } = await import('../../src/services/brainExtract.js');
  const clientFactory = () => ({
    messages: {
      create: async () => ({
        stop_reason: 'tool_use',
        content: [{
          type: 'tool_use', name: 'emit_insights',
          input: { insights: [
            { insight_type: 'objection', body: 'Worried it will slip like the cheap ones', quote: 'the cheap braces slip off after ten minutes', confidence: 0.7 },
            { insight_type: 'desired_outcome', body: 'Wants to walk pain-free by morning', confidence: 0.6 },
          ] },
        }],
      }),
    },
  });
  process.env.ANTHROPIC_API_KEY = 'test-key';
  const res = await runExtraction(sql, { documentId: DOC_ID, clientFactory, actor: 'test' });
  ok(res.proposed === 2, 'B8.1 extraction proposes the model\'s insights', JSON.stringify(res));
  const rows = await sql`SELECT status, proposed_by FROM kb_insights WHERE extraction_job_id = ${res.jobId}`;
  ok(rows.length === 2 && rows.every((r) => r.status === 'proposed'),
    'B8.2 every proposal lands PROPOSED — extraction NEVER auto-approves', JSON.stringify(rows));
  ok(rows.every((r) => String(r.proposed_by || '').startsWith('llm:')),
    'B8.3 …and records that a model proposed them', JSON.stringify(rows));
  const srcs = await sql`SELECT count(*)::int AS n FROM kb_insight_sources s
                         JOIN kb_insights i ON i.id = s.insight_id WHERE i.extraction_job_id = ${res.jobId}`;
  ok(srcs[0].n === 2, 'B8.4 …each linked back to the document it was extracted from', JSON.stringify(srcs));
}
{
  // FAILURE PATH: the model is unreachable. The job must FAIL VISIBLY, not
  // silently propose nothing (an empty proposal set is indistinguishable from
  // "this document had no insights").
  const { runExtraction } = await import('../../src/services/brainExtract.js');
  const boom = () => ({ messages: { create: async () => { throw new Error('connect ECONNREFUSED'); } } });
  let threw = null;
  try { await runExtraction(sql, { documentId: DOC_ID, clientFactory: boom, actor: 'test' }); }
  catch (e) { threw = e; }
  ok(threw && /unavailable|ECONNREFUSED/i.test(threw.message + (threw.code || '')),
    'B8.5 FAILURE PATH: an unreachable model throws instead of proposing nothing', threw && threw.message);
  const j = await sql`SELECT status, error FROM kb_extraction_jobs ORDER BY id DESC LIMIT 1`;
  ok(j[0]?.status === 'failed' && j[0]?.error, 'B8.6 …and the job row records status=failed with the error', JSON.stringify(j));
}
{
  delete process.env.ANTHROPIC_API_KEY;
  const r = await call('POST', '/extract', { document_id: DOC_ID });
  ok(r.status === 503 && /configured|ANTHROPIC/i.test(JSON.stringify(r.j)),
    'B8.7 FAILURE PATH: with no ANTHROPIC_API_KEY POST /extract answers 503, never a silent empty result', JSON.stringify(r.j));
  process.env.ANTHROPIC_API_KEY = 'test-key';
}

// ── B9 misc failure paths ──────────────────────────────────────────────────
{
  const r = await call('GET', '/documents/999999');
  ok(r.status === 404, 'B9.1 unknown document → 404', `got ${r.status}`);
  const r2 = await call('GET', `/documents/${DOC_ID}`);
  ok(r2.status === 200 && r2.j?.document?.body_text === DOC_TEXT, 'B9.2 GET /documents/:id returns the captured body', JSON.stringify(r2.j).slice(0, 200));
}
{
  const r = await call('POST', '/ingest', '{not json', SESSION);
  ok(r.status === 400, 'B9.3 a malformed JSON body answers 400 and does not crash the route', `got ${r.status}`);
  const alive = await call('GET', '/search?q=braces');
  ok(alive.status === 200, 'B9.4 …the server is still serving after it');
}
{
  const r = await call('POST', '/ingest', { source: 'reddit', text: '' });
  ok(r.status === 400, 'B9.5 an empty document body is refused', JSON.stringify(r.j));
  const r2 = await call('POST', '/ingest', { text: 'x' });
  ok(r2.status === 400, 'B9.6 a document with no source is refused', JSON.stringify(r2.j));
}
{
  const r = await call('GET', '/search?q=braces&limit=99999');
  ok(r.status === 200 && (r.j?.limit <= 100), 'B9.7 limit is clamped', JSON.stringify(r.j?.limit));
  const r2 = await call('GET', '/search');
  ok(r2.status === 400, 'B9.8 search with no q is refused', JSON.stringify(r2.j));
}

// ── B10 the S4-SB2 review findings, each asserted so it cannot come back ────
// Every one of these reproduced RED on the pinned tree before the fix.

// P0-2 — the service token is READ-ONLY.
{
  const i = await call('POST', '/insights', {
    insight_type: 'pain', body: 'a claim a pipeline must not be able to bless',
    source_document_ids: [DOC_ID],
  });
  const ID = i.j?.insight?.id;
  const p = await call('PATCH', `/insights/${ID}`, { status: 'approved' }, SERVICE);
  ok(p.status === 403 && p.j?.code === 'service_read_only',
    'B10.1 P0-2 the SERVICE token cannot approve an insight (403 service_read_only)', `${p.status} ${JSON.stringify(p.j)}`);
  const row = await sql`SELECT status, approved_by FROM kb_insights WHERE id = ${ID}`;
  ok(row[0].status === 'proposed' && row[0].approved_by === null,
    'B10.2 …and the row did not move — no approved_by="service" anywhere', JSON.stringify(row));

  const pb = await call('PUT', '/playbook/BBB', { sections: { angles: [{ key: 'x', value: { copy: 'by a pipeline' } }] } }, SERVICE);
  ok(pb.status === 403 && pb.j?.code === 'service_read_only',
    'B10.3 …nor write the playbook', `${pb.status} ${JSON.stringify(pb.j)}`);
  const lk = await call('POST', '/playbook/AAA/lock', {}, SERVICE);
  ok(lk.status === 403, 'B10.4 …nor lock it', `${lk.status} ${JSON.stringify(lk.j)}`);
  const ul = await call('POST', '/playbook/AAA/unlock', {}, SERVICE);
  ok(ul.status === 403, 'B10.5 …nor unlock it', `${ul.status} ${JSON.stringify(ul.j)}`);
  const ig = await call('POST', '/ingest', { source: 'reddit', text: 'a pipeline writing raw sources' }, SERVICE);
  ok(ig.status === 403, 'B10.6 …nor ingest', `${ig.status} ${JSON.stringify(ig.j)}`);
  const ex = await call('POST', '/extract', { document_id: DOC_ID }, SERVICE);
  ok(ex.status === 403, 'B10.7 …nor start an extraction', `${ex.status} ${JSON.stringify(ex.j)}`);

  // …and every READ it exists for still works.
  const reads = await Promise.all([
    call('GET', '/search?q=braces', undefined, SERVICE),
    call('GET', `/documents/${DOC_ID}`, undefined, SERVICE),
    call('GET', '/documents', undefined, SERVICE),
    call('GET', '/insights', undefined, SERVICE),
    call('GET', '/playbook/AAA', undefined, SERVICE),
  ]);
  ok(reads.every((x) => x.status === 200),
    'B10.8 …while search / documents / insights / playbook READS all stay 200 for it', JSON.stringify(reads.map((x) => x.status)));
}

// P0-3 — approved_only=false is a reviewer's privilege.
{
  const s1 = await call('GET', '/search?q=braces&approved_only=false', undefined, SERVICE);
  ok(s1.status === 403 && s1.j?.code === 'approval_scope',
    'B10.9 P0-3 the service actor CANNOT ask for approved_only=false (403)', `${s1.status} ${JSON.stringify(s1.j)}`);
  const s2 = await call('GET', '/search?q=braces&approved_only=false', undefined, WRITER);
  ok(s2.status === 403 && s2.j?.code === 'approval_scope',
    'B10.10 …nor may a session with brain:write but not brain:approve', `${s2.status} ${JSON.stringify(s2.j)}`);
  const s3 = await call('GET', '/search?q=braces&approved_only=false', undefined, SESSION);
  ok(s3.status === 200 && s3.j?.approved_only === false,
    'B10.11 …a reviewer (brain:approve) still may', `${s3.status} ${JSON.stringify(s3.j?.approved_only)}`);
  const s4 = await call('GET', '/search?q=braces', undefined, SERVICE);
  ok(s4.status === 200 && s4.j?.approved_only === true
     && (s4.j.results || []).filter((x) => x.kind === 'insight').every((x) => x.status === 'approved'),
    'B10.12 …and the pipeline default is the APPROVED layer', JSON.stringify(s4.j?.approved_only));
}

// P0-2b — approved_by is a real user id, not a label.
{
  const i = await call('POST', '/insights', { insight_type: 'pain', body: 'reviewed by a person', source_document_ids: [DOC_ID] });
  const ID = i.j?.insight?.id;
  const p = await call('PATCH', `/insights/${ID}`, { status: 'approved' }, SESSION);
  ok(p.status === 200 && p.j?.insight?.approved_by === u.id,
    'B10.13 approved_by is the REVIEWING USER’s id (a row in users), not a role name', `${p.status} ${JSON.stringify(p.j?.insight?.approved_by)} want ${u.id}`);
  const w = await call('PATCH', `/insights/${ID}`, { status: 'rejected', reason: 'not supported' }, WRITER);
  ok(w.status === 403 && w.j?.code === 'brain_permission',
    'B10.14 a session with brain:write but not brain:approve cannot review either', `${w.status} ${JSON.stringify(w.j)}`);
}

// P1-5 — the playbook may only cite APPROVED insights.
{
  const prop = await call('POST', '/insights', { insight_type: 'pain', body: 'still proposed, must not be citable', source_document_ids: [DOC_ID] });
  const PID = prop.j?.insight?.id;
  const r = await call('PUT', '/playbook/BBB', {
    sections: { angles: [{ key: 'a1', value: { copy: 'cites a proposal' }, cites: [PID] }] },
  }, SESSION);
  ok(r.status === 422 && r.j?.code === 'citation_not_approved',
    'B10.15 P1-5 an entry citing a PROPOSED insight is refused (422)', `${r.status} ${JSON.stringify(r.j)}`);
  const after = await call('GET', '/playbook/BBB');
  ok(after.j?.playbook?.version === 0,
    'B10.16 …and the refused write did NOT bump the version', JSON.stringify(after.j?.playbook?.version));
}

// P1-4 — the lock is real.
{
  const w1 = await call('PUT', '/playbook/BBB', { sections: { angles: [{ key: 'a1', value: { copy: 'v1' }, cites: [INS_ID] }] } });
  const v1 = w1.j?.playbook?.version;
  const lk = await call('POST', '/playbook/BBB/lock', {});
  ok(lk.status === 200 && lk.j?.playbook?.locked_at, 'B10.17 P1-4 the playbook locks', JSON.stringify(lk.j?.playbook?.locked_at));
  const w2 = await call('PUT', '/playbook/BBB', { sections: { angles: [{ key: 'a1', value: { copy: 'REWRITTEN AFTER THE LOCK' }, cites: [INS_ID] }] } });
  ok(w2.status === 423 && w2.j?.code === 'playbook_locked',
    'B10.18 …a PUT while LOCKED is refused with 423', `${w2.status} ${JSON.stringify(w2.j)}`);
  const g = await call('GET', '/playbook/BBB');
  ok(g.j?.playbook?.sections?.angles?.[0]?.value?.copy === 'v1',
    'B10.19 …the locked CONTENT is unchanged (a run manifest citing it still means something)', JSON.stringify(g.j?.playbook?.sections?.angles));
  ok(g.j?.playbook?.version === v1,
    'B10.20 …and the version did NOT move on the refused write', `${g.j?.playbook?.version} vs ${v1}`);
  const relock = await call('POST', '/playbook/BBB/lock', {});
  ok(relock.status === 423, 'B10.21 …re-locking a locked playbook is refused, never a silent re-stamp', `${relock.status}`);
  const badUnlock = await call('POST', '/playbook/BBB/unlock', {}, WRITER);
  ok(badUnlock.status === 403, 'B10.22 …unlocking needs brain:approve, not brain:write', `${badUnlock.status} ${JSON.stringify(badUnlock.j)}`);
  const un = await call('POST', '/playbook/BBB/unlock', {}, SESSION);
  ok(un.status === 200 && un.j?.playbook?.locked_at === null,
    'B10.23 …a reviewer unlocks it', JSON.stringify(un.j?.playbook?.locked_at));
  const w3 = await call('PUT', '/playbook/BBB', { sections: { angles: [{ key: 'a1', value: { copy: 'v2 after a real unlock' }, cites: [INS_ID] }] } });
  ok(w3.status === 200 && w3.j?.playbook?.version === v1 + 1,
    'B10.24 …and only THEN does the write land, bumping the version exactly once', `${w3.status} ${w3.j?.playbook?.version} vs ${v1}`);
}

// P1-6 — the object key is server-derived.
{
  const a = await call('POST', '/ingest', {
    source: 'operator-research', text: 'payload A for the ext probe',
    ext: 'txt/../../../../brand-spy/videos/owned',
  });
  ok(a.status === 422 && a.j?.code === 'ext_not_yours',
    'B10.25 P1-6 a caller-supplied ext is refused (422) — the traversal payload from the review', `${a.status} ${JSON.stringify(a.j)}`);
  const b = await call('POST', '/ingest', {
    source: 'operator-research', text: 'payload B for the key probe',
    body_object_key: '../../../other-store/secret.txt',
  });
  ok(b.status === 422 && b.j?.code === 'key_not_yours',
    'B10.26 …and a caller-supplied body_object_key is refused (422)', `${b.status} ${JSON.stringify(b.j)}`);
  const [{ n: escaped }] = await sql`SELECT count(*)::int AS n FROM kb_documents WHERE body_object_key NOT LIKE 'stores/SA/knowledge/raw/%'`;
  ok(escaped === 0, 'B10.27 …so NO row in this Brain carries a key outside the convention', `rows=${escaped}`);
  const c = await call('POST', '/ingest', { source: 'operator research', text: 'payload C, honest', content_type: 'text/markdown' });
  ok(c.status === 201 && /^stores\/SA\/knowledge\/raw\/operator-research\/\d{4}-\d{2}-\d{2}\/[0-9a-f]{64}\.md$/.test(c.j?.document?.body_object_key || ''),
    'B10.28 …while an honest ingest gets the derived key, ext taken from content_type', c.j?.document?.body_object_key);
  const d = await call('POST', '/ingest', { source: 'reddit', text: 'an executable body', content_type: 'application/x-sh' });
  ok(d.status === 422 && d.j?.code === 'bad_content_type',
    'B10.29 …and an unarchivable content type is refused rather than defaulted to .txt', `${d.status} ${JSON.stringify(d.j)}`);
}

// P1-7 — the bucket half: config read at request time, per-store prefix, and a
// refusal to mirror rather than a write into a possibly shared bucket.
{
  const { bucketTarget } = await import('../../src/services/brain/brainBucket.js');
  const saved = { ...process.env };
  delete process.env.R2_ACCOUNT_ID; delete process.env.R2_ACCESS_KEY_ID;
  delete process.env.R2_SECRET_ACCESS_KEY; delete process.env.R2_BUCKET_NAME;
  ok(bucketTarget().ok === false && /R2 is not configured/.test(bucketTarget().reason),
    'B10.30 P1-7 no R2 config → the Brain does not mirror, and says why', JSON.stringify(bucketTarget()));

  process.env.R2_ACCOUNT_ID = 'acct'; process.env.R2_ACCESS_KEY_ID = 'akid';
  process.env.R2_SECRET_ACCESS_KEY = 'secret';
  const noBucket = bucketTarget();
  ok(noBucket.ok === false && /R2_BUCKET_NAME/.test(noBucket.reason),
    'B10.31 …account + keys but NO bucket is REFUSED, never the shared fallback bucket', JSON.stringify(noBucket));

  process.env.R2_BUCKET_NAME = 'store-a-bucket';
  const good = bucketTarget();
  ok(good.ok === true && good.bucket === 'store-a-bucket' && good.prefix === 'stores/SA/',
    'B10.32 …with the bucket set it mirrors, under this store’s mandatory prefix', JSON.stringify(good));

  const before = process.env.STORE_CODE;
  delete process.env.STORE_CODE;
  const noCode = bucketTarget();
  ok(noCode.ok === false && /STORE_CODE/.test(noCode.reason),
    'B10.33 …STORE_CODE unset → REFUSES to mirror (an unprefixed object could collide)', JSON.stringify(noCode));
  process.env.STORE_CODE = before;

  // R7, by execution: the same call, a different env, a different answer — the
  // config is read PER CALL, not captured at import.
  process.env.R2_BUCKET_NAME = 'store-a-bucket-rotated';
  ok(bucketTarget().bucket === 'store-a-bucket-rotated',
    'B10.34 …and the R2 config is read at REQUEST time: rotating the var changes the next call', bucketTarget().bucket);
  for (const k of ['R2_ACCOUNT_ID', 'R2_ACCESS_KEY_ID', 'R2_SECRET_ACCESS_KEY', 'R2_BUCKET_NAME']) {
    if (saved[k] === undefined) delete process.env[k]; else process.env[k] = saved[k];
  }
}

await sql.end();
server.close();
console.log(`\n${pass} passed, ${fail} failed, ${skip} skipped`);
process.exit(fail ? 1 : 0);
