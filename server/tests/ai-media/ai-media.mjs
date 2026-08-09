// AI MEDIA verification — drives the REAL /api/v1/ai-media router (real
// authenticate + requirePermission + rate limiter + services/higgsfield.js +
// services/mediaService.js + services/mediaSchema.js) against embedded PG,
// with a MOCK Higgsfield platform API, a MOCK Higgsfield asset CDN and a MOCK
// Shopify Admin GraphQL (the CDN backend putImage writes to).
//
// NOTHING IS STUBBED IN THE PATH UNDER TEST. Every mock is reached through an
// override seam production already has:
//   HIGGSFIELD_BASE_URL      — higgsfield.js:16
//   MEDIA_SHOPIFY_API_BASE   — mediaService.js shopifyGraphqlUrl()
//   MEDIA_IMPORT_ALLOW_HOST  — mediaService.js allowListed() (relaxes exactly
//                              two things for ONE host: https-only and the
//                              is-this-address-public verdict)
//   mediaService._dnsHooks   — the resolver the SSRF guard calls
//
// The asset CDN is a real TLS server presenting a self-signed cert for
// cdn.higgsfield.ai, because isAllowedAssetUrl() (higgsfield.js:36) hard-
// requires https and that check is the whole point of the host test — running
// the mock over http would have meant weakening the assertion to fit the test.
// NODE_TLS_REJECT_UNAUTHORIZED=0 is set for THIS PROCESS ONLY, below.
//
// Proves BY EXECUTION:
//   T1  auth: no token / bad token / no funnels:access on BOTH routes
//   T2  generate validation: prompt required, >2000 chars, aspect/quality/batch
//       allowlists, batch=3 refused
//   T3  generate happy: batch=2 -> two jobs, two distinct tokens, two claim
//       rows; the prompt and aspect_ratio actually reach Higgsfield
//   T4  ownership: another user's token, a missing token and a garbage token
//       are all an INDISTINGUISHABLE 404
//   T5  poll pending -> completed: the asset is downloaded from the CDN and
//       re-hosted through putImage into lb_media; the returned url is OURS
//   T6  idempotency: a second poll returns the SAME lb_media row, makes NO new
//       CDN download and leaves exactly ONE row
//   T7  disallowed asset host -> failed, nothing persisted
//   T8  not_enough_credits -> clean structured 402, no jobs, no rows
//   T9  rate limit: 10/5min per user, and a batch of 4 costs FOUR
//   T10 oversized asset: declared-oversize AND streamed-oversize -> failed,
//       nothing persisted
//   T11 upstream job failure (failed / nsfw) -> failed, nothing persisted
//   T12 non-image bytes behind an image/png content-type -> failed
//   T13 no CDN backend -> 503 storage_unavailable and the job stays POLLABLE
//       (it is re-hosted on the next poll once storage exists)
//
// Run:  node server/tests/ai-media/ai-media.mjs      (idempotent — run twice)

// ── TLS: the asset CDN below is self-signed. This is the only place in the
//    run where certificate verification is relaxed, and it is relaxed for the
//    harness process, never for the code under test's logic.
process.env.NODE_TLS_REJECT_UNAUTHORIZED = '0';

process.env.DATABASE_URL = process.env.DATABASE_URL || 'postgres://puure@127.0.0.1:5433/puure_shoporder';
process.env.NODE_ENV = 'development';
process.env.JWT_ACCESS_SECRET = process.env.JWT_ACCESS_SECRET || 'dev-access-secret-change-me';
process.env.HIGGSFIELD_API_KEY = 'mock-key';
process.env.HIGGSFIELD_API_SECRET = 'mock-secret';
// Shopify is the CDN backend putImage will pick. Poll fast — the mock answers
// UPLOADED once before READY, so the real polling loop runs without adding
// seconds to the suite.
process.env.PUURE_SHOPIFY_TOKEN = 'shpat_mock_token';
process.env.PUURE_SHOPIFY_STORE = 'mock-store.myshopify.com';
process.env.MEDIA_SHOPIFY_POLL_INTERVAL_MS = '20';
process.env.MEDIA_SHOPIFY_POLL_TIMEOUT_MS = '2000';
delete process.env.MEDIA_STORAGE_BACKEND;
delete process.env.R2_PUBLIC_URL;
// The generation limit is real (10/user/5min) but this file makes far more
// than 10 calls. Raise the ceiling for the bulk of the run; T9 drives the
// limit itself with its OWN user and its own low ceiling.
process.env.AI_MEDIA_GEN_LIMIT = '100000';

import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import https from 'node:https';
import zlib from 'node:zlib';
import express from 'express';
import jwt from 'jsonwebtoken';
import postgres from 'postgres';

const sql = postgres(process.env.DATABASE_URL, { onnotice: () => {} });

let pass = 0; let fail = 0;
const check = (name, ok, extra = '') => {
  if (ok) { pass += 1; console.log(`PASS  ${name}`); }
  else { fail += 1; console.log(`FAIL  ${name}  ${extra}`); }
};

// Tee console.error so the tests can assert that a condition which MUST be
// findable in a log (a job-id collision, a raw upstream string that is kept
// out of the HTTP body) actually reached one.
const errorLog = [];
const realError = console.error;
console.error = (...args) => { errorLog.push(args.map(String).join(' ')); realError(...args); };
const loggedSince = (n) => errorLog.slice(n).join('\n');

// ═══════════════════════════════════════════════════════════════════════════
// FIXTURES — real image bytes. Dimensions are asserted, so a broken parser
// cannot pass by returning null.
// ═══════════════════════════════════════════════════════════════════════════
function crc32(buf) {
  let c; const table = crc32.t || (crc32.t = (() => {
    const t = new Int32Array(256);
    for (let n = 0; n < 256; n += 1) {
      c = n;
      for (let k = 0; k < 8; k += 1) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
      t[n] = c;
    }
    return t;
  })());
  let crc = -1;
  for (let i = 0; i < buf.length; i += 1) crc = table[(crc ^ buf[i]) & 0xff] ^ (crc >>> 8);
  return (crc ^ -1) >>> 0;
}

// A genuine, decodable 6x4 PNG.
const PNG_6x4 = (() => {
  const chunk = (type, data) => {
    const len = Buffer.alloc(4); len.writeUInt32BE(data.length);
    const body = Buffer.concat([Buffer.from(type, 'latin1'), data]);
    const crc = Buffer.alloc(4); crc.writeUInt32BE(crc32(body) >>> 0);
    return Buffer.concat([len, body, crc]);
  };
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(6, 0); ihdr.writeUInt32BE(4, 4);
  ihdr[8] = 8; ihdr[9] = 2; // 8-bit RGB
  const raw = Buffer.concat(Array.from({ length: 4 }, () => Buffer.concat([
    Buffer.from([0]), Buffer.alloc(18, 0x7f),
  ])));
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr),
    chunk('IDAT', zlib.deflateSync(raw)),
    chunk('IEND', Buffer.alloc(0)),
  ]);
})();

// ═══════════════════════════════════════════════════════════════════════════
// MOCK 1 — Higgsfield platform API + Shopify Admin GraphQL + staged target.
// ═══════════════════════════════════════════════════════════════════════════
const mockState = {
  createStatus: 200,            // POST /{model} response status
  createBody: null,             // override body (e.g. {error:'not_enough_credits'})
  createCalls: [],              // every submit payload Higgsfield actually saw
  jobs: {},                     // id -> { statuses:[...], url }
  nextJob: null,                // template applied to the NEXT created job
  jobSeq: 0,
  forceId: null,                // make the NEXT submit return this exact id
  statusCalls: [],              // every job-status poll Higgsfield actually saw
  cdnHits: [],                  // every asset path the CDN actually served
  fileCreateCalls: 0,
  pollCalls: 0,
};

const api = express();
api.use('/staged', express.raw({ type: () => true, limit: '40mb' }));
api.use(express.json({ limit: '10mb' }));

let API_ORIGIN = '';

// ── Shopify Admin GraphQL (the CDN backend) ────────────────────────────────
api.post('/admin/api/:v/graphql.json', (req, res) => {
  const q = String(req.body?.query || '');
  if (q.includes('stagedUploadsCreate')) {
    return res.json({
      data: {
        stagedUploadsCreate: {
          stagedTargets: [{
            url: `${API_ORIGIN}/staged`,
            resourceUrl: 'https://shopify-staged-uploads.example/mock-resource',
            parameters: [{ name: 'key', value: 'tmp/mock' }],
          }],
          userErrors: [],
        },
      },
    });
  }
  if (q.includes('fileCreate')) {
    mockState.fileCreateCalls += 1;
    // Faithful: Shopify returns UPLOADED here, never READY — the caller polls.
    return res.json({
      data: {
        fileCreate: {
          files: [{ id: 'gid://shopify/MediaImage/7001', fileStatus: 'UPLOADED', alt: '' }],
          userErrors: [],
        },
      },
    });
  }
  if (q.includes('fileStatus')) {
    mockState.pollCalls += 1;
    if (mockState.pollCalls % 2 === 1) {
      return res.json({ data: { node: { id: 'gid://shopify/MediaImage/7001', fileStatus: 'UPLOADED' } } });
    }
    return res.json({
      data: {
        node: {
          id: 'gid://shopify/MediaImage/7001',
          fileStatus: 'READY',
          // Deliberately WRONG numbers, so the test proves OUR header parse
          // wins over the CDN's echo.
          image: { url: 'https://cdn.shopify.com/s/files/1/mock/ai.png?v=1', width: 999, height: 999 },
        },
      },
    });
  }
  return res.status(400).json({ errors: [{ message: `unhandled query: ${q.slice(0, 60)}` }] });
});

api.post('/staged', (req, res) => { res.status(204).end(); });

// ── Higgsfield: submit ─────────────────────────────────────────────────────
// The path is the DEFAULT model id (higgsfield.js:20), not a test-only one, so
// the request the service actually builds is the request the mock answers.
api.post('/higgsfield-ai/soul/standard', (req, res) => {
  mockState.createCalls.push({
    body: req.body,
    hasAuthHeader: Boolean(req.get('authorization')),
    authIsKey: String(req.get('authorization') || '').startsWith('Key '),
  });
  if (mockState.createStatus !== 200) {
    return res.status(mockState.createStatus).json(mockState.createBody || { error: 'boom' });
  }
  mockState.jobSeq += 1;
  const id = mockState.forceId || `job_${mockState.jobSeq}_${Math.random().toString(36).slice(2, 8)}`;
  mockState.jobs[id] = mockState.nextJob
    ? JSON.parse(JSON.stringify(mockState.nextJob))
    : { statuses: ['completed'], url: `${CDN_ORIGIN}/asset/ok.png` };
  return res.json({ request_id: id });
});

// ── Higgsfield: status ─────────────────────────────────────────────────────
api.get('/requests/:id/status', (req, res) => {
  mockState.statusCalls.push(req.params.id);
  const job = mockState.jobs[req.params.id];
  if (!job) return res.status(404).json({ error: 'unknown request' });
  const status = job.statuses.length > 1 ? job.statuses.shift() : job.statuses[0];
  if (status !== 'completed') return res.json({ status });
  return res.json({ status: 'completed', images: [{ url: job.url }] });
});

const apiServer = api.listen(0);
await new Promise((r) => apiServer.once('listening', r));
API_ORIGIN = `http://127.0.0.1:${apiServer.address().port}`;

// ═══════════════════════════════════════════════════════════════════════════
// MOCK 2 — the Higgsfield asset CDN, over real TLS as cdn.higgsfield.ai.
// ═══════════════════════════════════════════════════════════════════════════
const certDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ai-media-tls-'));
const KEY_PEM = path.join(certDir, 'key.pem');
const CERT_PEM = path.join(certDir, 'cert.pem');
try {
  execFileSync('openssl', [
    'req', '-x509', '-newkey', 'rsa:2048', '-nodes',
    '-keyout', KEY_PEM, '-out', CERT_PEM, '-days', '2',
    '-subj', '/CN=cdn.higgsfield.ai',
    '-addext', 'subjectAltName=DNS:cdn.higgsfield.ai',
  ], { stdio: 'pipe' });
} catch (err) {
  console.error('BLOCKED: could not mint a self-signed cert with openssl —', err?.message || err);
  process.exit(2);
}

const cdnServer = https.createServer(
  { key: fs.readFileSync(KEY_PEM), cert: fs.readFileSync(CERT_PEM) },
  async (req, res) => {
    const url = new URL(req.url, 'https://cdn.higgsfield.ai');
    mockState.cdnHits.push(url.pathname);
    if (url.pathname === '/asset/ok.png' || url.pathname === '/asset/second.png') {
      res.setHeader('Content-Type', 'image/png');
      res.end(PNG_6x4);
      return;
    }
    if (url.pathname === '/asset/not-an-image.png') {
      // An image/png header over bytes that are plainly not a PNG.
      res.setHeader('Content-Type', 'image/png');
      res.end(Buffer.from('this is not a png, it is a sentence'));
      return;
    }
    // 11MB — deliberately BETWEEN the lane's 10MB import ceiling and the 20MB
    // this route used to carry. It is only refused if the cap really is
    // MAX_IMPORT_BYTES; a 21MB fixture would have passed under either number
    // and proved nothing about which one is in force.
    if (url.pathname === '/asset/big-declared.png') {
      res.setHeader('Content-Type', 'image/png');
      res.setHeader('Content-Length', String(11 * 1024 * 1024));
      res.end(PNG_6x4);
      return;
    }
    if (url.pathname === '/asset/big-stream.png') {
      // NO content-length (chunked) → only the STREAMING cap can catch this.
      res.setHeader('Content-Type', 'image/png');
      res.write(PNG_6x4);
      const mb = Buffer.alloc(1024 * 1024, 0x41);
      for (let i = 0; i < 12; i += 1) {
        if (res.writableEnded || res.destroyed) break;
        // eslint-disable-next-line no-await-in-loop
        if (!res.write(mb)) await new Promise((r) => res.once('drain', r));
      }
      try { res.end(); } catch { /* the client aborting IS the pass */ }
      return;
    }
    res.statusCode = 404;
    res.end('nope');
  }
);
cdnServer.on('clientError', () => {});
cdnServer.listen(0);
await new Promise((r) => cdnServer.once('listening', r));
const CDN_PORT = cdnServer.address().port;
const CDN_HOST = `cdn.higgsfield.ai:${CDN_PORT}`;
const CDN_ORIGIN = `https://${CDN_HOST}`;

// ── the seams, set BEFORE the code under test is imported ──────────────────
// higgsfield.js snapshots BASE_URL into a module-level const at import time,
// so this assignment must happen first or it does nothing.
process.env.HIGGSFIELD_BASE_URL = API_ORIGIN;
process.env.MEDIA_SHOPIFY_API_BASE = API_ORIGIN;
process.env.MEDIA_IMPORT_ALLOW_HOST = CDN_HOST;

const mediaService = await import('../../src/services/mediaService.js');
// The asset host is addressed BY NAME so the whole guard runs: parse →
// deny-list → resolution → address verdict → PINNED connect → redirect
// refusal → byte cap → magic-byte sniff. Only the resolver is ours.
mediaService._dnsHooks.lookup = async (hostname) => {
  if (hostname === 'cdn.higgsfield.ai') return [{ address: '127.0.0.1', family: 4 }];
  throw new Error(`unexpected DNS lookup in test: ${hostname}`);
};

// ═══════════════════════════════════════════════════════════════════════════
// SEED
// ═══════════════════════════════════════════════════════════════════════════
await sql`CREATE TABLE IF NOT EXISTS users (
  id TEXT PRIMARY KEY, email TEXT, first_name TEXT, last_name TEXT,
  must_change_password BOOLEAN DEFAULT FALSE, email_verified BOOLEAN DEFAULT TRUE,
  is_active BOOLEAN DEFAULT TRUE
)`;
await sql`CREATE TABLE IF NOT EXISTS roles (id TEXT PRIMARY KEY, name TEXT, permissions JSONB)`;
await sql`CREATE TABLE IF NOT EXISTS user_roles (user_id TEXT, role_id TEXT)`;

// Idempotency: drop every artefact a previous run of THIS file left behind,
// including the per-run rate-limit users (T9 mints a fresh one each time so a
// live Redis cannot carry a half-consumed window across runs).
await sql`DROP TABLE IF EXISTS lb_ai_media_jobs`;
await sql`DELETE FROM user_roles WHERE user_id LIKE 'u_aim_%'`;
await sql`DELETE FROM users WHERE id LIKE 'u_aim_rl_%'`;

const runTag = `${process.pid}_${Date.now().toString(36)}`;
const RL_USER = `u_aim_rl_a_${runTag}`;
const RL_USER2 = `u_aim_rl_b_${runTag}`;

await sql`INSERT INTO users (id, email, first_name, last_name) VALUES
  ('u_aim_owner', 'aim-owner@local.test', 'AI', 'Owner'),
  ('u_aim_other', 'aim-other@local.test', 'AI', 'Other'),
  ('u_aim_noperm', 'aim-noperm@local.test', 'AI', 'NoPerm'),
  (${RL_USER}, ${`${RL_USER}@local.test`}, 'AI', 'RateLimit'),
  (${RL_USER2}, ${`${RL_USER2}@local.test`}, 'AI', 'RateLimit2')
  ON CONFLICT (id) DO NOTHING`;
await sql`INSERT INTO roles (id, name, permissions) VALUES
  ('r_aim', 'ai-media-tester', '{"funnels": ["access"]}'),
  ('r_aim_noperm', 'ai-media-noperm', '{"orders": ["access"]}')
  ON CONFLICT (id) DO UPDATE SET permissions = EXCLUDED.permissions`;
await sql`INSERT INTO user_roles (user_id, role_id) VALUES
  ('u_aim_owner','r_aim'), ('u_aim_other','r_aim'),
  (${RL_USER},'r_aim'), (${RL_USER2},'r_aim'), ('u_aim_noperm','r_aim_noperm')`;

const { ensureMediaTables } = await import('../../src/services/mediaSchema.js');
await ensureMediaTables();
// This harness owns every lb_media row whose creator is one of its users.
await sql`DELETE FROM lb_media WHERE created_by LIKE 'u_aim_%'`;

const aiMediaRouter = (await import('../../src/routes/aiMedia.js')).default;
const { ensureAiMediaTables } = await import('../../src/routes/aiMedia.js');
await ensureAiMediaTables();

const app = express();
app.use(express.json({ limit: '2mb' }));
app.use('/api/v1/ai-media', aiMediaRouter);
// eslint-disable-next-line no-unused-vars
app.use((err, req, res, next) => {
  console.error('[harness] unhandled route error:', err?.message || err);
  res.status(500).json({ success: false, error: { code: 'internal' } });
});
const server = app.listen(0);
await new Promise((r) => server.once('listening', r));
const B = `http://127.0.0.1:${server.address().port}/api/v1/ai-media`;

const tokenFor = (id) => jwt.sign({ userId: id }, process.env.JWT_ACCESS_SECRET, { expiresIn: '10m' });
const OWNER = tokenFor('u_aim_owner');
const OTHER = tokenFor('u_aim_other');
const NOPERM = tokenFor('u_aim_noperm');
const RL_TOKEN = tokenFor(RL_USER);
const RL_TOKEN2 = tokenFor(RL_USER2);
const H = (t) => ({ Authorization: `Bearer ${t}`, 'Content-Type': 'application/json' });

const req = async (method, p, body, headers = H(OWNER)) => {
  const r = await fetch(`${B}${p}`, {
    method,
    headers,
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  let j = null; let text = '';
  try { text = await r.text(); j = JSON.parse(text); } catch { /* non-JSON */ }
  return { status: r.status, j, text };
};
const code = (r) => r.j?.error?.code || `<${r.status}:${(r.text || '').slice(0, 80)}>`;

// Create ONE job with a given upstream plan and return {job_id, job_token}.
const startJob = async (plan, { prompt = 'a tactical water filter on a mountain ledge', token = OWNER } = {}) => {
  mockState.nextJob = plan;
  const r = await req('POST', '/generate', { prompt, aspect: '9:16', quality: '1080p', batch: 1 }, H(token));
  mockState.nextJob = null;
  return { r, job: r.j?.jobs?.[0] };
};
const pollJob = (job, token = OWNER) => req('GET', `/jobs/${job.job_id}`, undefined, {
  Authorization: `Bearer ${token}`,
  'Content-Type': 'application/json',
  'X-Job-Token': job.job_token,
});

const mediaCount = async () => (await sql`SELECT COUNT(*)::int AS n FROM lb_media WHERE created_by LIKE 'u_aim_%'`)[0].n;

// ═══════════════════════════════════════════════════════════════════════════
// T1 — auth
// ═══════════════════════════════════════════════════════════════════════════
{
  const noTok = await req('POST', '/generate', { prompt: 'x' }, { 'Content-Type': 'application/json' });
  check('T1 POST /generate without a token is 401', noTok.status === 401, String(noTok.status));
  const badTok = await req('POST', '/generate', { prompt: 'x' }, { Authorization: 'Bearer not-a-jwt', 'Content-Type': 'application/json' });
  check('T1 POST /generate with a bad token is 401', badTok.status === 401, String(badTok.status));
  const jobNoTok = await req('GET', '/jobs/whatever', undefined, { 'Content-Type': 'application/json' });
  check('T1 GET /jobs/:id without a token is 401', jobNoTok.status === 401, String(jobNoTok.status));
  const noPerm = await req('POST', '/generate', { prompt: 'x' }, H(NOPERM));
  check('T1 a user without funnels:access is 403', noPerm.status === 403, String(noPerm.status));
  const jobNoPerm = await req('GET', '/jobs/whatever', undefined, H(NOPERM));
  check('T1 GET /jobs/:id without funnels:access is 403', jobNoPerm.status === 403, String(jobNoPerm.status));
}

// ═══════════════════════════════════════════════════════════════════════════
// T2 — generate validation
// ═══════════════════════════════════════════════════════════════════════════
{
  const before = mockState.createCalls.length;
  const cases = [
    ['empty prompt', { prompt: '   ' }, 'prompt_required'],
    ['missing prompt', {}, 'prompt_required'],
    ['prompt over 2000', { prompt: 'x'.repeat(2001) }, 'prompt_too_long'],
    ['bad aspect', { prompt: 'x', aspect: '21:9' }, 'invalid_aspect'],
    ['bad quality', { prompt: 'x', quality: '4k' }, 'invalid_quality'],
    ['batch 3', { prompt: 'x', batch: 3 }, 'invalid_batch'],
    ['batch 0', { prompt: 'x', batch: 0 }, 'invalid_batch'],
    ['batch "2" as a string is refused', { prompt: 'x', batch: '2' }, 'invalid_batch'],
    ['batch 100', { prompt: 'x', batch: 100 }, 'invalid_batch'],
  ];
  for (const [name, body, want] of cases) {
    const r = await req('POST', '/generate', body);
    check(`T2 ${name} -> 400 ${want}`, r.status === 400 && code(r) === want, `${r.status} ${code(r)}`);
  }
  check('T2 no rejected request reached Higgsfield', mockState.createCalls.length === before,
    `${mockState.createCalls.length - before} submits leaked`);
  const exact = await req('POST', '/generate', { prompt: 'x'.repeat(2000) });
  check('T2 a prompt of exactly 2000 chars is accepted', exact.status === 201, code(exact));
}

// ═══════════════════════════════════════════════════════════════════════════
// T3 — generate happy path, batch of 2
// ═══════════════════════════════════════════════════════════════════════════
let batchJobs = [];
{
  const before = mockState.createCalls.length;
  const r = await req('POST', '/generate', {
    prompt: 'Hero shot of a tactical water filter on a mountain ledge, golden hour',
    aspect: '16:9', quality: '720p', batch: 2,
  });
  check('T3 batch=2 returns 201', r.status === 201, code(r));
  batchJobs = r.j?.jobs || [];
  check('T3 two jobs are returned', batchJobs.length === 2, String(batchJobs.length));
  check('T3 each job carries a job_id and a job_token',
    batchJobs.every((j) => typeof j.job_id === 'string' && j.job_id.length > 3
      && typeof j.job_token === 'string' && j.job_token.length === 64),
    JSON.stringify(batchJobs));
  check('T3 the two job ids are distinct', batchJobs[0]?.job_id !== batchJobs[1]?.job_id, '');
  check('T3 the two job tokens are distinct', batchJobs[0]?.job_token !== batchJobs[1]?.job_token, '');
  check('T3 aspect/quality are echoed back',
    batchJobs[0]?.aspect === '16:9' && batchJobs[0]?.quality === '720p', JSON.stringify(batchJobs[0]));

  const submits = mockState.createCalls.slice(before);
  check('T3 exactly 2 submits reached Higgsfield', submits.length === 2, String(submits.length));
  check('T3 the prompt reached Higgsfield verbatim',
    submits[0]?.body?.prompt === 'Hero shot of a tactical water filter on a mountain ledge, golden hour',
    JSON.stringify(submits[0]?.body));
  check('T3 aspect_ratio reached Higgsfield', submits[0]?.body?.aspect_ratio === '16:9', JSON.stringify(submits[0]?.body));
  check('T3 the credential travelled in the Authorization HEADER',
    submits[0]?.hasAuthHeader === true && submits[0]?.authIsKey === true, JSON.stringify(submits[0]));

  const rows = await sql`SELECT job_id, user_id, status, media_id FROM lb_ai_media_jobs
                          WHERE job_id IN ${sql(batchJobs.map((j) => j.job_id))}`;
  check('T3 two claim rows exist, pending, owned by the caller',
    rows.length === 2 && rows.every((x) => x.status === 'pending' && x.user_id === 'u_aim_owner' && x.media_id === null),
    JSON.stringify(rows));
}

// ═══════════════════════════════════════════════════════════════════════════
// T4 — ownership
// ═══════════════════════════════════════════════════════════════════════════
{
  const j = batchJobs[0];
  const asOther = await req('GET', `/jobs/${j.job_id}`, undefined, {
    Authorization: `Bearer ${OTHER}`, 'Content-Type': 'application/json', 'X-Job-Token': j.job_token,
  });
  check('T4 another user presenting the owner\'s token gets 404',
    asOther.status === 404 && code(asOther) === 'not_found', `${asOther.status} ${code(asOther)}`);

  const noToken = await req('GET', `/jobs/${j.job_id}`, undefined, H(OWNER));
  check('T4 the owner with NO X-Job-Token gets 404',
    noToken.status === 404 && code(noToken) === 'not_found', `${noToken.status} ${code(noToken)}`);

  const garbage = await req('GET', `/jobs/${j.job_id}`, undefined, {
    Authorization: `Bearer ${OWNER}`, 'Content-Type': 'application/json', 'X-Job-Token': 'f'.repeat(64),
  });
  check('T4 a garbage token of the right LENGTH gets 404',
    garbage.status === 404 && code(garbage) === 'not_found', `${garbage.status} ${code(garbage)}`);

  const short = await req('GET', `/jobs/${j.job_id}`, undefined, {
    Authorization: `Bearer ${OWNER}`, 'Content-Type': 'application/json', 'X-Job-Token': 'abc',
  });
  check('T4 a short token gets 404 (no length-based throw)',
    short.status === 404 && code(short) === 'not_found', `${short.status} ${code(short)}`);

  const unknown = await req('GET', '/jobs/job_does_not_exist', undefined, {
    Authorization: `Bearer ${OWNER}`, 'Content-Type': 'application/json', 'X-Job-Token': 'f'.repeat(64),
  });
  check('T4 an unknown job id is the SAME 404 (no existence oracle)',
    unknown.status === 404 && code(unknown) === 'not_found', `${unknown.status} ${code(unknown)}`);
}

// ═══════════════════════════════════════════════════════════════════════════
// T5 — pending → completed → re-hosted into lb_media
// ═══════════════════════════════════════════════════════════════════════════
let persistedJob = null;
let persistedMediaId = '';
{
  const { r, job } = await startJob({ statuses: ['queued', 'in_progress', 'completed'], url: `${CDN_ORIGIN}/asset/ok.png` });
  check('T5 generate returns 201', r.status === 201, code(r));
  persistedJob = job;

  const p1 = await pollJob(job);
  check('T5 first poll reports queued', p1.status === 200 && p1.j?.data?.status === 'queued', JSON.stringify(p1.j));
  const p2 = await pollJob(job);
  check('T5 second poll reports in_progress', p2.j?.data?.status === 'in_progress', JSON.stringify(p2.j));

  const hitsBefore = mockState.cdnHits.length;
  const before = await mediaCount();
  const p3 = await pollJob(job);
  check('T5 third poll reports completed', p3.status === 200 && p3.j?.data?.status === 'completed', JSON.stringify(p3.j));

  const media = p3.j?.data?.media;
  persistedMediaId = media?.id || '';
  check('T5 the response carries an lb_media row with an id', Boolean(media?.id), JSON.stringify(media));
  check('T5 the returned url is OURS (the CDN copy), not the Higgsfield url',
    typeof media?.url === 'string' && media.url.startsWith('https://cdn.shopify.com/') && !media.url.includes('higgsfield'),
    String(media?.url));
  check('T5 data.url mirrors the lb_media url', p3.j?.data?.url === media?.url, String(p3.j?.data?.url));
  check('T5 OUR header parse won over the CDN echo (6x4, not 999x999)',
    media?.width === 6 && media?.height === 4, `${media?.width}x${media?.height}`);
  check('T5 mime is the SNIFFED image/png', media?.mime === 'image/png', String(media?.mime));
  check('T5 alt is the generation prompt',
    media?.alt === 'a tactical water filter on a mountain ledge', String(media?.alt));
  check('T5 the asset was actually downloaded from the CDN',
    mockState.cdnHits.slice(hitsBefore).includes('/asset/ok.png'),
    JSON.stringify(mockState.cdnHits.slice(hitsBefore)));
  check('T5 exactly one lb_media row was added', (await mediaCount()) === before + 1, '');

  const row = (await sql`SELECT status, media_id FROM lb_ai_media_jobs WHERE job_id = ${job.job_id}`)[0];
  check('T5 the claim row is completed and points at the media row',
    row?.status === 'completed' && row?.media_id === media?.id, JSON.stringify(row));

  const inLibrary = (await sql`SELECT id, url, archived FROM lb_media WHERE id = ${media.id}`)[0];
  check('T5 the generation is a NORMAL library row (single source of truth)',
    inLibrary?.url === media.url && inLibrary?.archived === false, JSON.stringify(inLibrary));
}

// ═══════════════════════════════════════════════════════════════════════════
// T6 — idempotency: a re-poll returns the same row, downloads nothing
// ═══════════════════════════════════════════════════════════════════════════
{
  const hitsBefore = mockState.cdnHits.length;
  const before = await mediaCount();
  const again = await pollJob(persistedJob);
  check('T6 a second poll is still completed', again.j?.data?.status === 'completed', JSON.stringify(again.j));
  check('T6 it returns the SAME lb_media id', again.j?.data?.media?.id === persistedMediaId,
    `${again.j?.data?.media?.id} vs ${persistedMediaId}`);
  check('T6 no second CDN download happened',
    mockState.cdnHits.length === hitsBefore, JSON.stringify(mockState.cdnHits.slice(hitsBefore)));
  check('T6 no second lb_media row was written', (await mediaCount()) === before, '');

  // Two SIMULTANEOUS polls of a fresh completed job must also settle on one row.
  const { job } = await startJob({ statuses: ['completed'], url: `${CDN_ORIGIN}/asset/second.png` });
  const beforeConcurrent = await mediaCount();
  const [a, b] = await Promise.all([pollJob(job), pollJob(job)]);
  const ids = [a.j?.data?.media?.id, b.j?.data?.media?.id].filter(Boolean);
  check('T6 concurrent polls write exactly ONE row',
    (await mediaCount()) === beforeConcurrent + 1, '');
  check('T6 concurrent polls never disagree about the row id',
    ids.length === 0 || new Set(ids).size === 1, JSON.stringify([a.j?.data, b.j?.data]));
  // Whichever one lost the claim reports in_progress; a follow-up poll settles it.
  const settle = await pollJob(job);
  check('T6 the follow-up poll returns the persisted row',
    settle.j?.data?.status === 'completed' && Boolean(settle.j?.data?.media?.id), JSON.stringify(settle.j));
}

// ═══════════════════════════════════════════════════════════════════════════
// T7 — disallowed asset host
// ═══════════════════════════════════════════════════════════════════════════
{
  const before = await mediaCount();
  const hitsBefore = mockState.cdnHits.length;
  const { job } = await startJob({ statuses: ['completed'], url: 'https://evil.example.com/asset/ok.png' });
  const p = await pollJob(job);
  check('T7 a non-higgsfield asset host is a FAILED job',
    p.status === 200 && p.j?.data?.status === 'failed', JSON.stringify(p.j));
  check('T7 the refusal says why', /higgsfield-owned https host/.test(String(p.j?.data?.error || '')), String(p.j?.data?.error));
  check('T7 no url is ever handed to the client', p.j?.data?.url === null && p.j?.data?.media === null, JSON.stringify(p.j?.data));
  check('T7 nothing was persisted', (await mediaCount()) === before, '');
  check('T7 nothing was downloaded', mockState.cdnHits.length === hitsBefore, '');
  check('T7 the refusal is marked PERMANENT so the client stops polling', p.j?.data?.permanent === true, JSON.stringify(p.j?.data));
  const row = (await sql`SELECT status, media_id FROM lb_ai_media_jobs WHERE job_id = ${job.job_id}`)[0];
  check('T7 the claim row is DEAD (not re-claimable) with no media_id',
    row?.status === 'dead' && row?.media_id === null, JSON.stringify(row));

  // A dead job must be answered from OUR row — asking Higgsfield again per
  // poll tick costs a round trip to re-learn a verdict we already reached.
  const statusBefore = mockState.statusCalls.length;
  const rePoll = await pollJob(job);
  check('T7 a re-poll of a dead job is still failed+permanent',
    rePoll.j?.data?.status === 'failed' && rePoll.j?.data?.permanent === true, JSON.stringify(rePoll.j?.data));
  check('T7 a re-poll of a dead job makes NO upstream call',
    mockState.statusCalls.length === statusBefore, `${mockState.statusCalls.length - statusBefore} calls`);

  // An http (non-TLS) higgsfield host is refused for the same reason.
  const { job: j2 } = await startJob({ statuses: ['completed'], url: `http://cdn.higgsfield.ai:${CDN_PORT}/asset/ok.png` });
  const p2 = await pollJob(j2);
  check('T7 an http:// higgsfield url is refused too', p2.j?.data?.status === 'failed', JSON.stringify(p2.j));
}

// ═══════════════════════════════════════════════════════════════════════════
// T8 — not_enough_credits
// ═══════════════════════════════════════════════════════════════════════════
{
  const before = await mediaCount();
  const jobsBefore = (await sql`SELECT COUNT(*)::int AS n FROM lb_ai_media_jobs`)[0].n;
  mockState.createStatus = 402;
  mockState.createBody = { error: 'not_enough_credits' };
  const r = await req('POST', '/generate', { prompt: 'a hero shot', batch: 2 });
  mockState.createStatus = 200;
  mockState.createBody = null;

  check('T8 credits exhaustion is a 402, not a 500', r.status === 402, `${r.status} ${r.text?.slice(0, 80)}`);
  check('T8 the code is not_enough_credits', code(r) === 'not_enough_credits', code(r));
  check('T8 the message is the operator-facing one',
    r.j?.error?.message === 'Higgsfield credits are empty — top up to generate', String(r.j?.error?.message));
  check('T8 no jobs were returned', r.j?.jobs === undefined, JSON.stringify(r.j));
  check('T8 no claim row was written', (await sql`SELECT COUNT(*)::int AS n FROM lb_ai_media_jobs`)[0].n === jobsBefore, '');
  check('T8 no media row was written', (await mediaCount()) === before, '');

  // A generic upstream failure is NOT dressed up as a credit problem.
  mockState.createStatus = 500;
  mockState.createBody = { error: 'internal explosion' };
  const boom = await req('POST', '/generate', { prompt: 'a hero shot' });
  mockState.createStatus = 200;
  mockState.createBody = null;
  check('T8 a generic upstream failure is 502 upstream_error',
    boom.status === 502 && code(boom) === 'upstream_error', `${boom.status} ${code(boom)}`);
}

// ═══════════════════════════════════════════════════════════════════════════
// T9 — rate limit (10/5min per user; a batch of 4 costs FOUR)
// ═══════════════════════════════════════════════════════════════════════════
{
  process.env.AI_MEDIA_GEN_LIMIT = '10';
  mockState.nextJob = { statuses: ['queued'], url: `${CDN_ORIGIN}/asset/ok.png` };

  // 4 + 4 = 8 consumed.
  const b1 = await req('POST', '/generate', { prompt: 'a', batch: 4 }, H(RL_TOKEN));
  const b2 = await req('POST', '/generate', { prompt: 'b', batch: 4 }, H(RL_TOKEN));
  check('T9 the first 4-batch is accepted', b1.status === 201 && b1.j?.jobs?.length === 4, code(b1));
  check('T9 the second 4-batch is accepted (8 of 10 consumed)', b2.status === 201, code(b2));

  const s1 = await req('POST', '/generate', { prompt: 'c', batch: 1 }, H(RL_TOKEN));
  const s2 = await req('POST', '/generate', { prompt: 'd', batch: 1 }, H(RL_TOKEN));
  check('T9 the 9th unit is accepted', s1.status === 201, code(s1));
  check('T9 the 10th unit is accepted', s2.status === 201, code(s2));

  const over = await req('POST', '/generate', { prompt: 'e', batch: 1 }, H(RL_TOKEN));
  check('T9 the 11th unit is refused with 429', over.status === 429, `${over.status} ${code(over)}`);
  check('T9 the refusal is structured rate_limited', code(over) === 'rate_limited', code(over));
  check('T9 a Retry-After is present', Number(over.j?.error?.retryAfter) > 0, JSON.stringify(over.j?.error));
  // The refusal BURNED quota. A body that hides that reads as "nothing
  // happened" while the window quietly drained.
  check('T9 the 429 says how much quota the refusal consumed',
    over.j?.error?.consumed === 1, JSON.stringify(over.j?.error));
  check('T9 the 429 says remaining:0', over.j?.error?.remaining === 0, JSON.stringify(over.j?.error));
  check('T9 the 429 carries a parseable window_reset in the future',
    Number.isFinite(Date.parse(over.j?.error?.window_reset || '')) && Date.parse(over.j.error.window_reset) > Date.now(),
    String(over.j?.error?.window_reset));

  // A batch that only PARTLY fits still charges what it consumed, and says so.
  const partialBurn = await req('POST', '/generate', { prompt: 'g', batch: 4 }, H(RL_TOKEN));
  check('T9 an over-quota BATCH is refused', partialBurn.status === 429, `${partialBurn.status} ${code(partialBurn)}`);
  check('T9 the over-quota batch reports the units it burned',
    partialBurn.j?.error?.consumed === 1, JSON.stringify(partialBurn.j?.error));

  // A DIFFERENT user, under the SAME low ceiling, with its own fresh bucket.
  const otherUser = await req('POST', '/generate', { prompt: 'f', batch: 1 }, H(RL_TOKEN2));
  check('T9 the limit is PER USER — another user is unaffected', otherUser.status === 201, code(otherUser));

  mockState.nextJob = null;
  process.env.AI_MEDIA_GEN_LIMIT = '100000';
}

// ═══════════════════════════════════════════════════════════════════════════
// T10 — oversized asset
// ═══════════════════════════════════════════════════════════════════════════
{
  const before = await mediaCount();
  const { job: dj } = await startJob({ statuses: ['completed'], url: `${CDN_ORIGIN}/asset/big-declared.png` });
  const dp = await pollJob(dj);
  check('T10 an 11MB DECLARED asset fails the job (cap is the lane\'s 10MB, not 20MB)',
    dp.j?.data?.status === 'failed', JSON.stringify(dp.j));
  check('T10 the declared-oversize refusal names the size limit',
    /larger than the \d+ byte limit/.test(String(dp.j?.data?.error || '')), String(dp.j?.data?.error));
  check('T10 the limit quoted to the operator IS 10MB',
    String(dp.j?.data?.error || '').includes(String(10 * 1024 * 1024)), String(dp.j?.data?.error));

  const { job: sj } = await startJob({ statuses: ['completed'], url: `${CDN_ORIGIN}/asset/big-stream.png` });
  const sp = await pollJob(sj);
  check('T10 a STREAMED-oversize asset (no content-length) fails the job',
    sp.j?.data?.status === 'failed', JSON.stringify(sp.j));
  check('T10 nothing oversize was persisted', (await mediaCount()) === before, '');
  const rows = await sql`SELECT status FROM lb_ai_media_jobs WHERE job_id IN (${dj.job_id}, ${sj.job_id})`;
  check('T10 both claim rows are DEAD, not merely failed',
    rows.length === 2 && rows.every((x) => x.status === 'dead'), JSON.stringify(rows));
  check('T10 both refusals are marked permanent',
    dp.j?.data?.permanent === true && sp.j?.data?.permanent === true, '');
}

// ═══════════════════════════════════════════════════════════════════════════
// T11 — upstream job failure
// ═══════════════════════════════════════════════════════════════════════════
{
  const before = await mediaCount();
  for (const raw of ['failed', 'nsfw']) {
    const { job } = await startJob({ statuses: [raw], url: `${CDN_ORIGIN}/asset/ok.png` });
    const p = await pollJob(job);
    check(`T11 upstream "${raw}" is a failed job`, p.j?.data?.status === 'failed', JSON.stringify(p.j));
    check(`T11 the "${raw}" reason is surfaced`, String(p.j?.data?.error || '').includes(raw), String(p.j?.data?.error));
    const row = (await sql`SELECT status FROM lb_ai_media_jobs WHERE job_id = ${job.job_id}`)[0];
    check(`T11 the "${raw}" claim row is failed`, row?.status === 'failed', JSON.stringify(row));
  }
  check('T11 nothing was persisted for failed jobs', (await mediaCount()) === before, '');
}

// ═══════════════════════════════════════════════════════════════════════════
// T12 — an image/png content-type over non-image bytes
// ═══════════════════════════════════════════════════════════════════════════
{
  const before = await mediaCount();
  const { job } = await startJob({ statuses: ['completed'], url: `${CDN_ORIGIN}/asset/not-an-image.png` });
  const p = await pollJob(job);
  check('T12 a lying content-type is caught by the magic-byte sniff',
    p.j?.data?.status === 'failed', JSON.stringify(p.j));
  check('T12 the refusal names the accepted formats',
    /PNG\/JPEG\/GIF\/WebP/.test(String(p.j?.data?.error || '')), String(p.j?.data?.error));
  check('T12 nothing was persisted', (await mediaCount()) === before, '');
}

// ═══════════════════════════════════════════════════════════════════════════
// T13 — no CDN backend: 503, and the job stays POLLABLE
// ═══════════════════════════════════════════════════════════════════════════
{
  const before = await mediaCount();
  const { job } = await startJob({ statuses: ['completed'], url: `${CDN_ORIGIN}/asset/ok.png` });

  process.env.MEDIA_STORAGE_BACKEND = 'none';
  const blocked = await pollJob(job);
  delete process.env.MEDIA_STORAGE_BACKEND;

  check('T13 with no CDN backend the poll is a 503', blocked.status === 503, `${blocked.status} ${code(blocked)}`);
  check('T13 the code is storage_unavailable', code(blocked) === 'storage_unavailable', code(blocked));
  check('T13 nothing was persisted', (await mediaCount()) === before, '');
  const row = (await sql`SELECT status FROM lb_ai_media_jobs WHERE job_id = ${job.job_id}`)[0];
  check('T13 the job is left PENDING, not failed — it is retryable', row?.status === 'pending', JSON.stringify(row));

  // The retry, once storage exists, must succeed and persist exactly once.
  const retry = await pollJob(job);
  check('T13 the retry re-hosts the asset', retry.j?.data?.status === 'completed' && Boolean(retry.j?.data?.media?.id), JSON.stringify(retry.j));
  check('T13 the retry added exactly one row', (await mediaCount()) === before + 1, '');
}

// ═══════════════════════════════════════════════════════════════════════════
// T14 — the claim is RECOVERABLE (review MAJOR F3)
// A dyno that dies mid-download used to strand the row in 'persisting'
// forever: the operator had paid for the generation and every later poll
// answered in_progress until someone noticed. `claimed_at` bounds it.
// ═══════════════════════════════════════════════════════════════════════════
{
  const { job } = await startJob({ statuses: ['completed'], url: `${CDN_ORIGIN}/asset/ok.png` });

  // A FRESH claim belongs to a poll that is still alive — nobody may steal it.
  await sql`UPDATE lb_ai_media_jobs SET status='persisting', claimed_at=NOW() WHERE job_id=${job.job_id}`;
  const beforeFresh = await mediaCount();
  const fresh = await pollJob(job);
  check('T14 a FRESH persisting claim is not stolen', fresh.j?.data?.status === 'in_progress', JSON.stringify(fresh.j));
  check('T14 nothing was persisted behind the live holder', (await mediaCount()) === beforeFresh, '');

  // A STALE claim's holder is gone. The next poll takes it over.
  await sql`UPDATE lb_ai_media_jobs
               SET status='persisting', claimed_at = NOW() - INTERVAL '6 minutes'
             WHERE job_id=${job.job_id}`;
  const stale = await pollJob(job);
  check('T14 a STALE persisting claim is re-taken and completes',
    stale.j?.data?.status === 'completed' && Boolean(stale.j?.data?.media?.id), JSON.stringify(stale.j));
  check('T14 the re-take produced exactly one row', (await mediaCount()) === beforeFresh + 1, '');

  // A claim with a NULL claimed_at (a row written by the pre-fix deploy) is
  // stale by definition — otherwise the fix would not reach the very rows it
  // exists to rescue.
  const { job: j2 } = await startJob({ statuses: ['completed'], url: `${CDN_ORIGIN}/asset/ok.png` });
  await sql`UPDATE lb_ai_media_jobs SET status='persisting', claimed_at=NULL WHERE job_id=${j2.job_id}`;
  const legacy = await pollJob(j2);
  check('T14 a legacy persisting row with NULL claimed_at is recoverable',
    legacy.j?.data?.status === 'completed', JSON.stringify(legacy.j));
}

// ═══════════════════════════════════════════════════════════════════════════
// T15 — storage is checked BEFORE anything is downloaded (review MED F5)
// ═══════════════════════════════════════════════════════════════════════════
{
  const { job } = await startJob({ statuses: ['completed'], url: `${CDN_ORIGIN}/asset/ok.png` });
  const hitsBefore = mockState.cdnHits.length;

  process.env.MEDIA_STORAGE_BACKEND = 'none';
  const blocked = await pollJob(job);
  const blocked2 = await pollJob(job);
  delete process.env.MEDIA_STORAGE_BACKEND;

  check('T15 no CDN backend is a 503', blocked.status === 503 && blocked2.status === 503,
    `${blocked.status}/${blocked2.status}`);
  check('T15 ZERO bytes were downloaded and discarded',
    mockState.cdnHits.length === hitsBefore, JSON.stringify(mockState.cdnHits.slice(hitsBefore)));
  const row = (await sql`SELECT status, stored FROM lb_ai_media_jobs WHERE job_id=${job.job_id}`)[0];
  check('T15 the job was never even claimed', row?.status === 'pending' && row?.stored === null, JSON.stringify(row));
}

// ═══════════════════════════════════════════════════════════════════════════
// T16 — the CDN receipt closes the orphan window (review MED F6)
// putImage bills us for bytes; the lb_media INSERT is a separate statement
// that can fail. `stored` records the CDN result the instant putImage returns,
// so the retry re-uses those bytes instead of paying for them twice.
// ═══════════════════════════════════════════════════════════════════════════
{
  const { job } = await startJob({ statuses: ['completed'], url: `${CDN_ORIGIN}/asset/ok.png` });
  const done = await pollJob(job);
  check('T16 the job completed', done.j?.data?.status === 'completed', JSON.stringify(done.j));

  const row = (await sql`SELECT stored, media_id FROM lb_ai_media_jobs WHERE job_id=${job.job_id}`)[0];
  // This driver hands a jsonb column back as a STRING — the route parses
  // defensively for exactly this reason, and so does the assertion.
  const st = typeof row?.stored === 'string' ? JSON.parse(row.stored) : row?.stored;
  check('T16 the CDN receipt is on the claim row',
    Boolean(st?.url) && st?.mime === 'image/png' && st?.width === 6 && st?.height === 4 && Number(st?.bytes) > 0,
    JSON.stringify(st));

  // Reproduce the orphan: putImage succeeded, the INSERT did not.
  await sql`DELETE FROM lb_media WHERE id = ${row.media_id}`;
  await sql`UPDATE lb_ai_media_jobs SET status='pending', media_id=NULL WHERE job_id=${job.job_id}`;
  const hitsBefore = mockState.cdnHits.length;
  const fileCreateBefore = mockState.fileCreateCalls;

  const recovered = await pollJob(job);
  check('T16 the retry completes', recovered.j?.data?.status === 'completed', JSON.stringify(recovered.j));
  check('T16 the retry re-used the SAME CDN url', recovered.j?.data?.media?.url === st.url,
    `${recovered.j?.data?.media?.url} vs ${st.url}`);
  check('T16 the retry did NOT download the asset again',
    mockState.cdnHits.length === hitsBefore, JSON.stringify(mockState.cdnHits.slice(hitsBefore)));
  check('T16 the retry did NOT pay for a second CDN upload',
    mockState.fileCreateCalls === fileCreateBefore, `${mockState.fileCreateCalls - fileCreateBefore} uploads`);
  check('T16 the dimensions survived the round trip through the receipt',
    recovered.j?.data?.media?.width === 6 && recovered.j?.data?.media?.height === 4,
    `${recovered.j?.data?.media?.width}x${recovered.j?.data?.media?.height}`);
}

// ═══════════════════════════════════════════════════════════════════════════
// T17 — completed job whose lb_media row vanished (review MED F7)
// The old comment claimed this "falls through and re-hosts"; the claim
// predicate did not match 'completed', so it answered in_progress forever.
// ═══════════════════════════════════════════════════════════════════════════
{
  const { job } = await startJob({ statuses: ['completed'], url: `${CDN_ORIGIN}/asset/ok.png` });
  const first = await pollJob(job);
  const firstId = first.j?.data?.media?.id;
  check('T17 the job completed', Boolean(firstId), JSON.stringify(first.j));

  // The claim row still says completed and still names the (now absent) row.
  await sql`DELETE FROM lb_media WHERE id = ${firstId}`;
  const hitsBefore = mockState.cdnHits.length;
  const fileCreateBefore = mockState.fileCreateCalls;

  const rebuilt = await pollJob(job);
  check('T17 the dangling completed job is REBUILT, not stuck in_progress',
    rebuilt.j?.data?.status === 'completed' && Boolean(rebuilt.j?.data?.media?.id), JSON.stringify(rebuilt.j));
  check('T17 the rebuild is a NEW lb_media row', rebuilt.j?.data?.media?.id !== firstId,
    `${rebuilt.j?.data?.media?.id} vs ${firstId}`);
  check('T17 the rebuild cost no download and no upload',
    mockState.cdnHits.length === hitsBefore && mockState.fileCreateCalls === fileCreateBefore, '');
  const row = (await sql`SELECT status, media_id FROM lb_ai_media_jobs WHERE job_id=${job.job_id}`)[0];
  check('T17 the claim row now points at the rebuilt row',
    row?.status === 'completed' && row?.media_id === rebuilt.j?.data?.media?.id, JSON.stringify(row));
}

// ═══════════════════════════════════════════════════════════════════════════
// T18 — job id shape (review MINOR F11)
// ═══════════════════════════════════════════════════════════════════════════
{
  const statusBefore = mockState.statusCalls.length;
  for (const bad of ['ab', '../../etc/passwd', 'has spaces', 'x'.repeat(129)]) {
    const r = await req('GET', `/jobs/${encodeURIComponent(bad)}`, undefined, {
      Authorization: `Bearer ${OWNER}`, 'Content-Type': 'application/json', 'X-Job-Token': 'f'.repeat(64),
    });
    check(`T18 a malformed job id (${bad.slice(0, 16)}) is 400 invalid_job_id`,
      r.status === 400 && code(r) === 'invalid_job_id', `${r.status} ${code(r)}`);
  }
  check('T18 no malformed id reached Higgsfield',
    mockState.statusCalls.length === statusBefore, `${mockState.statusCalls.length - statusBefore}`);
  // A WELL-FORMED unknown id is still the ownership 404 — the shape check must
  // not become a second, chattier existence oracle.
  const wellFormed = await req('GET', '/jobs/job_well_formed_but_unknown', undefined, {
    Authorization: `Bearer ${OWNER}`, 'Content-Type': 'application/json', 'X-Job-Token': 'f'.repeat(64),
  });
  check('T18 a well-formed unknown id is still 404', wellFormed.status === 404, String(wellFormed.status));
}

// ═══════════════════════════════════════════════════════════════════════════
// T19 — the raw upstream string never reaches the browser (review MINOR F10)
// ═══════════════════════════════════════════════════════════════════════════
{
  const marker = 'INTERNAL-TRACE-9f2a-do-not-leak';
  const logBefore = errorLog.length;
  mockState.createStatus = 500;
  mockState.createBody = { error: marker };
  const r = await req('POST', '/generate', { prompt: 'leak test' });
  mockState.createStatus = 200;
  mockState.createBody = null;

  check('T19 the upstream failure is a 502 upstream_error',
    r.status === 502 && code(r) === 'upstream_error', `${r.status} ${code(r)}`);
  check('T19 the raw upstream string is NOT in the HTTP body',
    !(r.text || '').includes(marker), (r.text || '').slice(0, 160));
  check('T19 the operator-facing message is generic prose',
    /try again in a moment/i.test(String(r.j?.error?.message || '')), String(r.j?.error?.message));
  check('T19 the raw upstream string IS in the server log',
    loggedSince(logBefore).includes(marker), loggedSince(logBefore).slice(0, 160));
}

// ═══════════════════════════════════════════════════════════════════════════
// T20 — aspect + quality are recorded and echoed (review MED F8)
// ═══════════════════════════════════════════════════════════════════════════
{
  mockState.nextJob = { statuses: ['queued'], url: `${CDN_ORIGIN}/asset/ok.png` };
  const r = await req('POST', '/generate', { prompt: 'echo test', aspect: '4:5', quality: '720p', batch: 1 });
  mockState.nextJob = null;
  const job = r.j?.jobs?.[0];
  check('T20 generate accepted', r.status === 201 && Boolean(job), code(r));

  const row = (await sql`SELECT aspect, quality FROM lb_ai_media_jobs WHERE job_id=${job.job_id}`)[0];
  check('T20 aspect + quality are stored on the claim row',
    row?.aspect === '4:5' && row?.quality === '720p', JSON.stringify(row));

  const p = await pollJob(job);
  check('T20 the status response echoes aspect + quality',
    p.j?.data?.aspect === '4:5' && p.j?.data?.quality === '720p', JSON.stringify(p.j?.data));
}

// ═══════════════════════════════════════════════════════════════════════════
// T21 — a duplicate Higgsfield request id is LOUD (review MINOR F15)
// ═══════════════════════════════════════════════════════════════════════════
{
  const dupId = `job_dup_${Date.now().toString(36)}`;
  mockState.forceId = dupId;
  mockState.nextJob = { statuses: ['queued'], url: `${CDN_ORIGIN}/asset/ok.png` };
  const first = await req('POST', '/generate', { prompt: 'dup one' });
  const logBefore = errorLog.length;
  const second = await req('POST', '/generate', { prompt: 'dup two' });
  mockState.forceId = null;
  mockState.nextJob = null;

  check('T21 both requests are accepted', first.status === 201 && second.status === 201,
    `${first.status}/${second.status}`);
  check('T21 the collision is logged with the offending id',
    loggedSince(logBefore).includes('collision') && loggedSince(logBefore).includes(dupId),
    loggedSince(logBefore).slice(0, 200));
  const n = (await sql`SELECT COUNT(*)::int AS n FROM lb_ai_media_jobs WHERE job_id=${dupId}`)[0].n;
  check('T21 the table still holds exactly one row for that id', n === 1, String(n));
}

// ═══════════════════════════════════════════════════════════════════════════
// T22 — the rate limiter FAILS CLOSED (review MINOR F13)
// media.js and aiDeveloper.js both fail OPEN. This route protects a credit
// balance, not a CPU, so a limiter it cannot consult is a refusal.
// ═══════════════════════════════════════════════════════════════════════════
{
  const aiMediaModule = await import('../../src/routes/aiMedia.js');
  const realCheck = aiMediaModule._hooks.checkRateLimit;
  const submitsBefore = mockState.createCalls.length;
  aiMediaModule._hooks.checkRateLimit = async () => { throw new Error('redis exploded'); };

  const r = await req('POST', '/generate', { prompt: 'fail closed please', batch: 4 });
  aiMediaModule._hooks.checkRateLimit = realCheck;

  check('T22 a broken limiter REFUSES rather than letting spend through',
    r.status === 429 && code(r) === 'rate_limited', `${r.status} ${code(r)}`);
  check('T22 nothing was submitted to Higgsfield',
    mockState.createCalls.length === submitsBefore, `${mockState.createCalls.length - submitsBefore} submits`);
  check('T22 the refusal reports consumed:0 (nothing was counted)',
    r.j?.error?.consumed === 0, JSON.stringify(r.j?.error));

  // …and the limiter recovering restores service, so the fail-closed branch is
  // not a one-way door.
  const after = await req('POST', '/generate', { prompt: 'back to normal' });
  check('T22 service resumes once the limiter recovers', after.status === 201, code(after));
}

// ═══════════════════════════════════════════════════════════════════════════
console.log(`\n${pass} passed, ${fail} failed`);
server.close();
apiServer.close();
cdnServer.close();
try { fs.rmSync(certDir, { recursive: true, force: true }); } catch { /* best effort */ }
await sql.end({ timeout: 5 });
process.exit(fail === 0 ? 0 : 1);
