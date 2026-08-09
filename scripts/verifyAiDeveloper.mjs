// Verification harness for the AI DEVELOPER feature (routes/aiDeveloper.js +
// services/higgsfield.js). Runs the REAL route (real authenticate middleware,
// real embedded Postgres) against a MOCK Anthropic endpoint (via the SDK's
// baseURL override) and a MOCK Higgsfield server.
//
//   node scripts/verifyAiDeveloper.mjs
//
// Proves BY EXECUTION:
//   (a) the tool loop applies a scripted propose_block_edits round-trip and
//       the route returns validated ops
//   (b) invalid ops are REJECTED (unknown block_id, oversized block, proto
//       keys) and a disallowed model 400s
//   (c) generate_image → mock job → GET /jobs flows to done with the asset
//       URL host-validated (non-higgsfield host rejected)
//   (d) the route NEVER writes funnel_pages (row byte-identical after chats)
//   (e) auth: no/bad token → 401
import http from 'http';
import crypto from 'crypto';

// ---------------------------------------------------------------------------
// Environment MUST be pinned before any repo module is imported (they read
// env at module load). All repo imports below are dynamic for that reason.
// ---------------------------------------------------------------------------
process.env.DATABASE_URL ||= 'postgresql://puure@127.0.0.1:5433/puure_analytics';
process.env.ANTHROPIC_API_KEY = 'test-key-not-real';
process.env.HIGGSFIELD_API_KEY = 'hf-test-key';
process.env.HIGGSFIELD_API_SECRET = 'hf-test-secret';

let passed = 0;
let failed = 0;
const failures = [];
function assert(cond, msg) {
  if (cond) { passed += 1; console.log(`  PASS  ${msg}`); }
  else { failed += 1; failures.push(msg); console.log(`  FAIL  ${msg}`); }
}
const eq = (a, e, msg) => assert(a === e, `${msg} (expected ${JSON.stringify(e)}, got ${JSON.stringify(a)})`);

// ---------------------------------------------------------------------------
// MOCK ANTHROPIC — speaks the Messages API SSE wire format. Each POST
// /v1/messages shifts the next scripted responder; requests are captured.
// ---------------------------------------------------------------------------
const anthropicRequests = [];
let anthropicScript = [];

function sseWrite(res, event, data) {
  res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
}

// Stream a full assistant message as Anthropic SSE events.
function streamMessage(res, { blocks, stop_reason }) {
  res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache' });
  sseWrite(res, 'message_start', {
    type: 'message_start',
    message: {
      id: `msg_${crypto.randomBytes(6).toString('hex')}`, type: 'message', role: 'assistant',
      model: 'claude-fable-5', content: [], stop_reason: null, stop_sequence: null,
      usage: { input_tokens: 10, output_tokens: 1 },
    },
  });
  blocks.forEach((b, index) => {
    if (b.type === 'text') {
      sseWrite(res, 'content_block_start', { type: 'content_block_start', index, content_block: { type: 'text', text: '' } });
      sseWrite(res, 'content_block_delta', { type: 'content_block_delta', index, delta: { type: 'text_delta', text: b.text } });
    } else {
      sseWrite(res, 'content_block_start', { type: 'content_block_start', index, content_block: { type: 'tool_use', id: b.id, name: b.name, input: {} } });
      sseWrite(res, 'content_block_delta', { type: 'content_block_delta', index, delta: { type: 'input_json_delta', partial_json: JSON.stringify(b.input) } });
    }
    sseWrite(res, 'content_block_stop', { type: 'content_block_stop', index });
  });
  sseWrite(res, 'message_delta', { type: 'message_delta', delta: { stop_reason, stop_sequence: null }, usage: { output_tokens: 20 } });
  sseWrite(res, 'message_stop', { type: 'message_stop' });
  res.end();
}

const anthropicServer = http.createServer((req, res) => {
  let body = '';
  req.on('data', (c) => { body += c; });
  req.on('end', () => {
    if (req.method === 'POST' && req.url.startsWith('/v1/messages')) {
      const parsed = JSON.parse(body);
      anthropicRequests.push(parsed);
      const responder = anthropicScript.shift();
      if (!responder) {
        res.writeHead(500, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ type: 'error', error: { type: 'api_error', message: 'mock script exhausted' } }));
        return;
      }
      responder(res, parsed);
    } else {
      res.writeHead(404).end();
    }
  });
});

// ---------------------------------------------------------------------------
// MOCK HIGGSFIELD
// ---------------------------------------------------------------------------
const higgsfieldRequests = [];
const jobPollCounts = {};
const higgsfieldServer = http.createServer((req, res) => {
  let body = '';
  req.on('data', (c) => { body += c; });
  req.on('end', () => {
    higgsfieldRequests.push({ method: req.method, url: req.url, auth: req.headers.authorization, body });
    const json = (code, obj) => { res.writeHead(code, { 'Content-Type': 'application/json' }); res.end(JSON.stringify(obj)); };

    if (req.method === 'POST' && req.url === '/higgsfield-ai/soul/standard') {
      return json(200, { request_id: 'req_good_1' });
    }
    if (req.method === 'GET' && req.url.startsWith('/requests/')) {
      const id = req.url.split('/')[2];
      jobPollCounts[id] = (jobPollCounts[id] || 0) + 1;
      if (id === 'req_good_1') {
        // first poll: queued → second poll: completed on a higgsfield host
        if (jobPollCounts[id] === 1) return json(200, { status: 'queued' });
        return json(200, { status: 'completed', images: [{ url: 'https://assets.higgsfield.ai/gen/img-1.png' }] });
      }
      if (id === 'req_evil_1') {
        return json(200, { status: 'completed', images: [{ url: 'https://evil.example.com/steal.png' }] });
      }
      if (id === 'req_http_1') {
        return json(200, { status: 'completed', images: [{ url: 'http://higgsfield.ai/not-https.png' }] });
      }
      if (id === 'req_nsfw_1') {
        return json(200, { status: 'nsfw' });
      }
      return json(404, { error: 'unknown request' });
    }
    return json(404, { error: 'unknown route' });
  });
});

// ---------------------------------------------------------------------------
// Boot mocks, pin their URLs, THEN import repo modules
// ---------------------------------------------------------------------------
await new Promise((r) => anthropicServer.listen(0, '127.0.0.1', r));
await new Promise((r) => higgsfieldServer.listen(0, '127.0.0.1', r));
process.env.ANTHROPIC_BASE_URL = `http://127.0.0.1:${anthropicServer.address().port}`;
process.env.HIGGSFIELD_BASE_URL = `http://127.0.0.1:${higgsfieldServer.address().port}`;

const { default: postgres } = await import('postgres');
const { default: express } = await import('express');
const { default: jwt } = await import('jsonwebtoken');
const { ensureTables } = await import('../server/src/routes/funnels.js');
const { default: aiRouter, applyOps } = await import('../server/src/routes/aiDeveloper.js');
const { isAllowedAssetUrl } = await import('../server/src/services/higgsfield.js');

const sql = postgres(process.env.DATABASE_URL, { max: 5, idle_timeout: 5 });
const q = (text, params = []) => sql.unsafe(text, params);

// ---------------------------------------------------------------------------
// DB fixture: minimal auth tables + a funnel + a page
// ---------------------------------------------------------------------------
await ensureTables();
// The embedded harness DB already carries the platform's users/roles schema
// (uuid ids) — reuse it with throwaway uuid fixtures.
const USER_ID = crypto.randomUUID();
const ROLE_ID = crypto.randomUUID();
const FUNNEL_ID = 'fnl_aidev_test';
const PAGE_ID = 'fpg_aidev_test';

await q(`DELETE FROM user_roles WHERE user_id IN (SELECT id FROM users WHERE email = 'aidev@test.local')`);
await q(`DELETE FROM users WHERE email = 'aidev@test.local'`);
await q(`DELETE FROM roles WHERE name = 'aidev-tester'`);
await q(
  `INSERT INTO users (id, email, password_hash, first_name, last_name, is_active, must_change_password, email_verified)
   VALUES ($1, 'aidev@test.local', 'not-a-real-hash', 'AI', 'Dev', TRUE, FALSE, TRUE)`,
  [USER_ID]
);
await q(`INSERT INTO roles (id, name, permissions) VALUES ($1, 'aidev-tester', '{"funnels": ["access"]}'::jsonb)`, [ROLE_ID]);
await q(`INSERT INTO user_roles (user_id, role_id) VALUES ($1, $2)`, [USER_ID, ROLE_ID]);

await q(`DELETE FROM funnel_pages WHERE funnel_id = $1`, [FUNNEL_ID]);
await q(`DELETE FROM funnels WHERE id = $1`, [FUNNEL_ID]);
await q(`INSERT INTO funnels (id, slug, name, settings) VALUES ($1, 'aidev-test', 'AI Dev Test', '{"brand_color": "#16a34a"}'::jsonb)`, [FUNNEL_ID]);

const PAGE_BLOCKS = [
  { id: 'b1', type: 'hero', props: { headline: 'Old headline', cta_text: 'Buy', cta_href: '#' } },
  { id: 'b2', type: 'text', props: { text: 'Some body copy' } },
];
await q(
  `INSERT INTO funnel_pages (id, funnel_id, slug, type, title, is_home, blocks)
   VALUES ($1, $2, '/', 'lead', 'AI Dev Page', TRUE, $3)`,
  [PAGE_ID, FUNNEL_ID, JSON.stringify(PAGE_BLOCKS)]
);

// Snapshot for (d): the row must be BYTE-IDENTICAL after every chat.
const snapshotRow = async () => {
  const rows = await q(`SELECT md5(t.*::text) AS h, updated_at FROM funnel_pages t WHERE id = $1`, [PAGE_ID]);
  return rows[0];
};
const before = await snapshotRow();

// ---------------------------------------------------------------------------
// App under test: the REAL router with the REAL auth middleware
// ---------------------------------------------------------------------------
const app = express();
app.use(express.json({ limit: '50mb' }));
app.use('/api/v1/ai-developer', aiRouter);
const appServer = await new Promise((resolve) => {
  const s = app.listen(0, '127.0.0.1', () => resolve(s));
});
const BASE = `http://127.0.0.1:${appServer.address().port}`;

const token = jwt.sign({ userId: USER_ID }, 'dev-access-secret-change-me', { expiresIn: '15m' });
const authHeaders = { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' };

// SSE reader: returns {status, events:[{event,data}], json} for a fetch.
async function postChat(body, headers = authHeaders) {
  const res = await fetch(`${BASE}/api/v1/ai-developer/chat`, {
    method: 'POST', headers, body: JSON.stringify(body),
  });
  const ct = res.headers.get('content-type') || '';
  if (!ct.includes('text/event-stream')) {
    let json = null;
    try { json = await res.json(); } catch { /* ignore */ }
    return { status: res.status, events: [], json };
  }
  const text = await res.text();
  const events = [];
  for (const chunk of text.split('\n\n')) {
    if (!chunk.trim()) continue;
    let event = 'message'; let data = '';
    for (const line of chunk.split('\n')) {
      if (line.startsWith('event: ')) event = line.slice(7).trim();
      else if (line.startsWith('data: ')) data += line.slice(6);
    }
    if (data) events.push({ event, data: JSON.parse(data) });
  }
  return { status: res.status, events, json: null };
}
const doneOf = (r) => r.events.find((e) => e.event === 'done')?.data;

const chatBody = (overrides = {}) => ({
  page_id: PAGE_ID,
  funnel_id: FUNNEL_ID,
  model: 'claude-fable-5',
  messages: [{ role: 'user', content: 'Make the hero headline bigger' }],
  blocks: PAGE_BLOCKS,
  ...overrides,
});

// ===========================================================================
console.log('\n== (e) auth ==');
{
  const r1 = await postChat(chatBody(), { 'Content-Type': 'application/json' });
  eq(r1.status, 401, 'no token → 401');
  const r2 = await postChat(chatBody(), { 'Content-Type': 'application/json', Authorization: 'Bearer not-a-jwt' });
  eq(r2.status, 401, 'garbage token → 401');
  const r3 = await fetch(`${BASE}/api/v1/ai-developer/jobs/req_good_1`);
  eq(r3.status, 401, 'jobs endpoint without token → 401');
}

console.log('\n== (b) request-level rejections ==');
{
  const r = await postChat(chatBody({ model: 'claude-haiku-4-5' }));
  eq(r.status, 400, 'disallowed model → 400');
  assert(/model must be one of/.test(r.json?.error || ''), 'disallowed model error names the allowlist');

  const r2 = await postChat(chatBody({ attachment: { block_id: 'nope', kind: 'hero' } }));
  eq(r2.status, 400, 'attachment with unknown block_id → 400');

  const r3 = await postChat(chatBody({ messages: Array.from({ length: 45 }, (_, i) => ({ role: i % 2 ? 'assistant' : 'user', content: 'x' })) }));
  eq(r3.status, 400, 'over-long conversation → 400');

  const r4 = await postChat(chatBody({ images: Array.from({ length: 6 }, () => 'aGVsbG8=') }));
  eq(r4.status, 400, 'more than 5 images → 400');

  const r5 = await postChat(chatBody({ page_id: 'fpg_does_not_exist' }));
  eq(r5.status, 404, 'unknown page → 404');
}

console.log('\n== (b) applyOps unit: invalid ops are REJECTED ==');
{
  const cur = PAGE_BLOCKS;
  const r1 = applyOps(cur, [{ op: 'replace_props', block_id: 'zzz', props: {} }]);
  assert(/unknown block_id/.test(r1.error || ''), 'unknown block_id rejected');

  const big = 'x'.repeat(2 * 1024 * 1024 + 100);
  const r2 = applyOps(cur, [{ op: 'insert_block', block: { type: 'text', props: { text: big } } }]);
  assert(/2MB/.test(r2.error || ''), 'oversized block rejected (2MB cap)');

  const proto = JSON.parse('{"op":"replace_props","block_id":"b1","props":{"__proto__":{"polluted":true}}}');
  const r3 = applyOps(cur, [proto]);
  assert(/forbidden key/.test(r3.error || ''), 'proto-key props rejected');

  const r4 = applyOps(cur, [{ op: 'move_block', block_id: 'b1', index: 99 }]);
  assert(/index must be/.test(r4.error || ''), 'out-of-range move index rejected');

  const r5 = applyOps(cur, [{ op: 'yeet', block_id: 'b1' }]);
  assert(/op must be one of/.test(r5.error || ''), 'unknown op type rejected');

  const ok = applyOps(cur, [
    { op: 'replace_props', block_id: 'b1', props: { headline: 'New', cta_text: 'Buy', cta_href: '#' } },
    { op: 'insert_block', index: 1, block: { type: 'text', props: { text: 'inserted' } } },
    { op: 'move_block', block_id: 'b2', index: 0 },
    { op: 'remove_block', block_id: 'b2' },
  ]);
  assert(!ok.error, `valid op batch applies (${ok.error || 'no error'})`);
  eq(ok?.ops?.length, 4, 'valid batch normalizes 4 ops');
  assert(cur[0].props.headline === 'Old headline', 'applyOps never mutates its input');
}

console.log('\n== (a) tool loop round-trip ==');
{
  anthropicScript = [
    (res) => streamMessage(res, {
      blocks: [
        { type: 'text', text: 'You want a bigger headline. LOCATE: block b1 ("Old headline"). PLAN: replace the headline and add a subline. ' },
        {
          type: 'tool_use', id: 'toolu_01', name: 'propose_block_edits',
          input: {
            ops: [
              { op: 'replace_props', block_id: 'b1', props: { headline: 'HUGE new headline', cta_text: 'Buy', cta_href: '#' } },
              { op: 'insert_block', index: 2, block: { type: 'text', props: { text: 'Fresh supporting copy' } } },
            ],
          },
        },
      ],
      stop_reason: 'tool_use',
    }),
    (res) => streamMessage(res, {
      blocks: [{ type: 'text', text: 'Done — headline replaced and a copy block added. Review the draft on the canvas.' }],
      stop_reason: 'end_turn',
    }),
  ];
  const reqCountBefore = anthropicRequests.length;
  const r = await postChat(chatBody());
  eq(r.status, 200, 'chat streams 200');
  const done = doneOf(r);
  assert(!!done, 'done event arrives');
  eq(done?.ops?.length, 2, 'validated ops returned');
  eq(done?.ops?.[0]?.op, 'replace_props', 'first op is replace_props');
  eq(done?.ops?.[0]?.props?.headline, 'HUGE new headline', 'replace_props carries the new props');
  eq(done?.ops?.[1]?.op, 'insert_block', 'second op is insert_block');
  assert(typeof done?.ops?.[1]?.block?.id === 'string' && done.ops[1].block.id.length > 0, 'inserted block got a server-assigned id');
  assert(/Done — headline replaced/.test(done?.reply || ''), 'reply text is the final assistant text');
  assert(r.events.some((e) => e.event === 'text'), 'text deltas were streamed');

  eq(anthropicRequests.length - reqCountBefore, 2, 'tool loop made exactly 2 model calls');
  const second = anthropicRequests[anthropicRequests.length - 1];
  const toolResult = second.messages[second.messages.length - 1];
  eq(toolResult.role, 'user', 'tool_result goes back as a user turn');
  assert(/Applied 2 op\(s\)/.test(toolResult.content?.[0]?.content || ''), 'tool_result reports the applied ops');
  assert(second.messages.some((m) => m.role === 'assistant' && Array.isArray(m.content) && m.content.some((b) => b.type === 'tool_use')), 'assistant tool_use echoed back');
  const sys = String(second.system || '');
  assert(sys.includes('RESTATE') && sys.includes('LOCATE') && sys.includes('PLAN') && sys.includes('EDIT'), 'system prompt encodes the 4-step methodology');
  assert(sys.includes('"b1"') || sys.includes('"id":"b1"'), 'system prompt contains the block JSON with ids');
}

console.log('\n== (b) invalid ops from the model are REJECTED in-loop ==');
{
  anthropicScript = [
    (res) => streamMessage(res, {
      blocks: [{ type: 'tool_use', id: 'toolu_02', name: 'propose_block_edits', input: { ops: [{ op: 'replace_props', block_id: 'does_not_exist', props: { a: 1 } }] } }],
      stop_reason: 'tool_use',
    }),
    (res) => streamMessage(res, {
      blocks: [{ type: 'text', text: 'I could not find that block.' }],
      stop_reason: 'end_turn',
    }),
  ];
  const r = await postChat(chatBody());
  const done = doneOf(r);
  eq(done?.ops?.length, 0, 'no ops returned when the model targets an unknown id');
  const second = anthropicRequests[anthropicRequests.length - 1];
  const tr = second.messages[second.messages.length - 1].content[0];
  eq(tr.is_error, true, 'rejected ops produce an is_error tool_result');
  assert(/REJECTED: .*unknown block_id/.test(tr.content), 'rejection message names the bad id');
}

console.log('\n== (c) generate_image → async job → host-validated status ==');
{
  anthropicScript = [
    (res) => streamMessage(res, {
      blocks: [
        { type: 'text', text: 'Starting the image generation — it runs async, a job card will appear.' },
        { type: 'tool_use', id: 'toolu_03', name: 'generate_image', input: { prompt: 'product on a mountain ledge', aspect_ratio: '16:9' } },
      ],
      stop_reason: 'tool_use',
    }),
    (res) => streamMessage(res, {
      blocks: [{ type: 'text', text: 'The image is generating. When the card finishes, click "Use it" and I will swap it in.' }],
      stop_reason: 'end_turn',
    }),
  ];
  const r = await postChat(chatBody({ messages: [{ role: 'user', content: 'Generate a hero image of the product on a mountain ledge' }] }));
  const done = doneOf(r);
  eq(done?.jobs?.length, 1, 'job returned in done payload');
  eq(done?.jobs?.[0]?.id, 'req_good_1', 'job id comes from Higgsfield');
  eq(done?.jobs?.[0]?.kind, 'image', 'job kind is image');
  assert(r.events.some((e) => e.event === 'job' && e.data.id === 'req_good_1'), 'job SSE event emitted');
  const submit = higgsfieldRequests.find((h) => h.url === '/higgsfield-ai/soul/standard');
  assert(!!submit, 'Higgsfield submit endpoint was called');
  eq(submit?.auth, 'Key hf-test-key:hf-test-secret', 'credentials sent in the Authorization header (never in the URL)');
  assert(JSON.parse(submit.body).aspect_ratio === '16:9', 'aspect_ratio forwarded');

  // Poll flow: queued → completed with allowed host
  const p1 = await (await fetch(`${BASE}/api/v1/ai-developer/jobs/req_good_1`, { headers: authHeaders })).json();
  eq(p1.data.status, 'queued', 'first poll: queued');
  const p2 = await (await fetch(`${BASE}/api/v1/ai-developer/jobs/req_good_1`, { headers: authHeaders })).json();
  eq(p2.data.status, 'completed', 'second poll: completed');
  eq(p2.data.url, 'https://assets.higgsfield.ai/gen/img-1.png', 'allowed https higgsfield URL returned');

  const evil = await (await fetch(`${BASE}/api/v1/ai-developer/jobs/req_evil_1`, { headers: authHeaders })).json();
  eq(evil.data.status, 'failed', 'non-higgsfield host → failed');
  eq(evil.data.url, null, 'non-higgsfield URL never returned');
  assert(/rejected/.test(evil.data.error || ''), 'rejection reason present');

  const httpUrl = await (await fetch(`${BASE}/api/v1/ai-developer/jobs/req_http_1`, { headers: authHeaders })).json();
  eq(httpUrl.data.status, 'failed', 'plain-http higgsfield URL → failed');
  eq(httpUrl.data.url, null, 'http URL never returned');

  const nsfw = await (await fetch(`${BASE}/api/v1/ai-developer/jobs/req_nsfw_1`, { headers: authHeaders })).json();
  eq(nsfw.data.status, 'failed', 'nsfw status normalizes to failed');

  // isAllowedAssetUrl unit edges
  eq(isAllowedAssetUrl('https://higgsfield.ai/x.png'), true, 'apex higgsfield.ai allowed');
  eq(isAllowedAssetUrl('https://cdn.higgsfield.com/x.png'), true, 'higgsfield.com subdomain allowed');
  eq(isAllowedAssetUrl('https://nothiggsfield.ai/x.png'), false, 'suffix-spoof host rejected');
  eq(isAllowedAssetUrl('https://higgsfield.ai.evil.com/x.png'), false, 'prefix-spoof host rejected');
  eq(isAllowedAssetUrl('not a url'), false, 'garbage rejected');
}

console.log('\n== edge: Anthropic API failure does not crash the route ==');
{
  anthropicScript = [
    (res) => { res.writeHead(529, { 'Content-Type': 'application/json' }); res.end(JSON.stringify({ type: 'error', error: { type: 'overloaded_error', message: 'overloaded' } })); },
  ];
  const r = await postChat(chatBody());
  // SDK retries 529s twice with the same mock answer? script has 1 entry;
  // exhausted script returns 500 which the SDK also retries → both paths end
  // in a handled failure, never a crash. Accept 500 json or SSE error event.
  const gotHandledFailure = (r.status >= 500 && r.json) || r.events.some((e) => e.event === 'error');
  assert(gotHandledFailure, `model API failure is handled cleanly (status ${r.status})`);
}

console.log('\n== (d) route NEVER writes funnel_pages ==');
{
  const after = await snapshotRow();
  eq(after.h, before.h, 'funnel_pages row md5 unchanged after all chats');
  eq(String(after.updated_at), String(before.updated_at), 'updated_at unchanged');
}

// ---------------------------------------------------------------------------
// Cleanup
// ---------------------------------------------------------------------------
await q(`DELETE FROM funnel_pages WHERE funnel_id = $1`, [FUNNEL_ID]);
await q(`DELETE FROM funnels WHERE id = $1`, [FUNNEL_ID]);
await q(`DELETE FROM user_roles WHERE user_id = $1`, [USER_ID]);
await q(`DELETE FROM users WHERE id = $1`, [USER_ID]);
await q(`DELETE FROM roles WHERE id = $1`, [ROLE_ID]);
await sql.end();
anthropicServer.close();
higgsfieldServer.close();
appServer.close();

console.log(`\n${passed} passed, ${failed} failed`);
if (failures.length) {
  console.log('FAILURES:');
  failures.forEach((f) => console.log(`  - ${f}`));
}
process.exit(failed ? 1 : 0);
