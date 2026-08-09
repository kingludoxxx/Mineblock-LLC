// AI DEVELOPER EXTRAS — end-to-end verification of ONE CHAT TURN, against a
// MOCK Anthropic endpoint (ANTHROPIC_BASE_URL), proving the parts that only
// exist once the SSE turn actually runs:
//
//   • the operator's message AND Claude's reply are PERSISTED to the thread
//   • the persisted user turn carries the image COUNT and the RESOLVED
//     attachment — and NOT the image bytes
//   • the `done` frame carries the server-RESOLVED attachment back, so the chip
//     shows the block's real type rather than the client's claim
//   • the model the client picked is the model that reaches Anthropic, and a
//     non-allowlisted model never gets that far (400 before any network call)
//   • an image whose bytes contradict its declared media_type is refused
//     BEFORE the Anthropic request is made (the mock counts calls)
//   • THE FAILURE PATH: when the thread write throws, the turn still answers —
//     a database blip must not cost the operator a turn they already paid for
//
// Run:  node server/tests/ai-developer/chat-turn.mjs
import http from 'http';
import postgres from 'postgres';

const DB = 'postgres://puure@127.0.0.1:5433/puure_aidev_turn';
let pass = 0, fail = 0;
const ok = (c, m, x = '') => { if (c) { pass++; console.log('PASS ', m); } else { fail++; console.log('FAIL ', m, x); } };
const eq = (got, want, m) => ok(
  JSON.stringify(got) === JSON.stringify(want), m,
  `\n      got  ${JSON.stringify(got)}\n      want ${JSON.stringify(want)}`
);

const admin = postgres('postgres://puure@127.0.0.1:5433/postgres', { ssl: false });
await admin`DROP DATABASE IF EXISTS puure_aidev_turn`;
await admin`CREATE DATABASE puure_aidev_turn`;
await admin.end();

// ---------------------------------------------------------------------------
// Mock Anthropic: /v1/messages, SSE, one text block, no tool use.
// ---------------------------------------------------------------------------
const seen = []; // every request body the mock received
// When set, the mock holds the stream open after the first text delta until this
// promise resolves — the window in which the F3 case fires its DELETE.
let stall = null;
let onRequestSeen = null; // resolved as soon as a request reaches the mock

const write = (res, event, data) => res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);

const anthropic = http.createServer((req, res) => {
  let body = '';
  req.on('data', (c) => { body += c; });
  req.on('end', async () => {
    let parsed = null;
    try { parsed = JSON.parse(body); } catch { /* record the raw miss */ }
    seen.push(parsed);
    if (onRequestSeen) { onRequestSeen(); onRequestSeen = null; }
    const msg = {
      id: 'msg_mock', type: 'message', role: 'assistant', model: parsed?.model || '?',
      content: [], stop_reason: null, stop_sequence: null,
      usage: { input_tokens: 10, output_tokens: 5 },
    };
    res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache' });
    write(res, 'message_start', { type: 'message_start', message: msg });
    write(res, 'content_block_start', { type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } });
    write(res, 'content_block_delta', { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: 'Looks good. ' } });
    // ---- the stall window ----
    if (stall) await stall;
    write(res, 'content_block_delta', { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: 'Nothing to change.' } });
    write(res, 'content_block_stop', { type: 'content_block_stop', index: 0 });
    write(res, 'message_delta', { type: 'message_delta', delta: { stop_reason: 'end_turn', stop_sequence: null }, usage: { output_tokens: 5 } });
    write(res, 'message_stop', { type: 'message_stop' });
    res.end();
  });
});
anthropic.listen(0);
await new Promise((r) => anthropic.once('listening', r));
const MOCK = `http://127.0.0.1:${anthropic.address().port}`;

Object.assign(process.env, {
  DATABASE_URL: DB, NODE_ENV: 'development',
  JWT_ACCESS_SECRET: 'localdev', JWT_REFRESH_SECRET: 'localdev',
  MONEY_SWEEP_DISABLED: '1', TRACKING_SWEEPS_DISABLED: '1', DOMAIN_SWEEP_DISABLED: '1',
  ANTHROPIC_API_KEY: 'sk-ant-mock-key-for-the-harness',
  ANTHROPIC_BASE_URL: MOCK,
});

const { default: express } = await import('express');
const { default: funnelsRoutes, ensureTables } = await import('../../src/routes/funnels.js');
const { default: aiDevRoutes } = await import('../../src/routes/aiDeveloper.js');
const schema = await import('../../src/services/aiDeveloperSchema.js');

const app = express();
app.use(express.json({ limit: '20mb' }));
app.use('/api/v1/funnels', funnelsRoutes);
app.use('/api/v1/ai-developer', aiDevRoutes);
const server = app.listen(0);
await new Promise((r) => server.once('listening', r));
const PORT = server.address().port;

const sql = postgres(DB, { ssl: false });
const { signAccessToken } = await import('../../src/utils/jwt.js');
await ensureTables();
await schema.ensureAiDevChatTables();

await sql`CREATE TABLE IF NOT EXISTS users (
  id TEXT PRIMARY KEY, email TEXT, first_name TEXT, last_name TEXT,
  must_change_password BOOLEAN DEFAULT FALSE, email_verified BOOLEAN DEFAULT TRUE,
  is_active BOOLEAN DEFAULT TRUE
)`;
await sql`CREATE TABLE IF NOT EXISTS roles (id TEXT PRIMARY KEY, name TEXT, permissions JSONB)`;
await sql`CREATE TABLE IF NOT EXISTS user_roles (user_id TEXT, role_id TEXT)`;
await sql`INSERT INTO users (id, email, first_name, last_name) VALUES ('u_turn','t@t.co','T','T')`;
await sql`INSERT INTO roles (id, name, permissions) VALUES ('r_turn','turn-tester', ${sql.json({ funnels: ['access'] })})`;
await sql`INSERT INTO user_roles (user_id, role_id) VALUES ('u_turn','r_turn')`;
const TOKEN = signAccessToken({ userId: 'u_turn' });
const H = { Authorization: `Bearer ${TOKEN}`, 'Content-Type': 'application/json' };
const BASE = `http://127.0.0.1:${PORT}/api/v1`;

const f = await fetch(`${BASE}/funnels`, { method: 'POST', headers: H, body: JSON.stringify({ name: 'Turn', slug: 'turn-harness' }) });
const FA = (await f.json())?.data?.id;
const p = await fetch(`${BASE}/funnels/${FA}/pages`, { method: 'POST', headers: H, body: JSON.stringify({ title: 'Turn page', slug: '/', type: 'generic' }) });
const P1 = (await p.json())?.data?.id;
ok(!!FA && !!P1, 'seed: funnel + page created');

const BLOCKS = [
  { id: 'blk_hero', type: 'hero', props: { headline: 'Original headline' } },
  { id: 'blk_cta', type: 'button', props: { label: 'Buy now', variant_id: '77' } },
];

const PNG = (() => { const b = Buffer.alloc(24); Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]).copy(b, 0); return b; })();
const JPEG = (() => { const b = Buffer.alloc(24); Buffer.from([0xff, 0xd8, 0xff, 0xe0]).copy(b, 0); return b; })();
const dataUrl = (mt, buf) => `data:${mt};base64,${buf.toString('base64')}`;

// Drive the SSE endpoint and collect its frames.
async function chat(body) {
  const r = await fetch(`${BASE}/ai-developer/chat`, { method: 'POST', headers: H, body: JSON.stringify(body) });
  const ct = r.headers.get('content-type') || '';
  if (!ct.includes('text/event-stream')) {
    let j = null; try { j = await r.json(); } catch { /* non-JSON */ }
    return { status: r.status, stream: false, j };
  }
  const text = await r.text();
  const frames = [];
  for (const chunk of text.split('\n\n')) {
    if (!chunk.trim()) continue;
    let event = 'message'; let data = '';
    for (const line of chunk.split('\n')) {
      if (line.startsWith('event: ')) event = line.slice(7).trim();
      else if (line.startsWith('data: ')) data += line.slice(6);
    }
    if (data) { try { frames.push({ event, data: JSON.parse(data) }); } catch { /* skip */ } }
  }
  return { status: r.status, stream: true, frames };
}

const turn = (extra = {}) => ({
  page_id: P1, funnel_id: FA, blocks: BLOCKS,
  messages: [{ role: 'user', content: 'does the hero read well?' }],
  ...extra,
});

// ===========================================================================
console.log('\n=== a plain turn ===');
{
  const r = await chat(turn());
  ok(r.stream, 'the endpoint answers with an SSE stream', JSON.stringify(r.j));
  const done = r.frames.find((x) => x.event === 'done');
  ok(!!done, 'a done frame arrives');
  eq(done.data.reply, 'Looks good. Nothing to change.', 'the reply is the joined text deltas');
  eq(done.data.ops, [], 'no ops were proposed');
  const texts = r.frames.filter((x) => x.event === 'text').map((x) => x.data.text);
  eq(texts, ['Looks good. ', 'Nothing to change.'], 'the text deltas streamed through in order');
  eq(seen.at(-1).model, 'claude-fable-5', 'the DEFAULT model reached Anthropic');
}
{
  const msgs = await schema.readThread(P1, FA);
  eq(msgs.length, 2, 'THE TURN WAS PERSISTED — user + assistant');
  eq(msgs[0].role, 'user', 'the operator message is stored first');
  eq(msgs[0].content, 'does the hero read well?', 'with its text');
  eq(msgs[1].content, 'Looks good. Nothing to change.', 'and the reply is stored');
  eq(msgs[1].ops_count, 0, 'the reply records 0 ops');
  eq(msgs[0].model, 'claude-fable-5', 'the model is recorded on the stored turn');
  eq(msgs[0].image_count, 0, 'no screenshots on this turn');
  eq(msgs[0].attachment, null, 'and no attachment');
}

console.log('\n=== the model picker reaches the API ===');
{
  await chat(turn({ model: 'claude-opus-5' }));
  eq(seen.at(-1).model, 'claude-opus-5', 'the operator\'s pick is the model sent to Anthropic');
}
{
  const before = seen.length;
  const r = await chat(turn({ model: 'claude-3-5-haiku-latest' }));
  eq(r.status, 400, 'a non-allowlisted model is a 400');
  ok(!r.stream, 'and never opens a stream');
  eq(seen.length, before, 'NO ANTHROPIC CALL WAS MADE — the allowlist gates before the network, not after');
}

console.log('\n=== screenshots ===');
{
  const before = seen.length;
  const r = await chat(turn({ images: [dataUrl('image/png', JPEG)] }));
  eq(r.status, 400, 'an image whose bytes contradict its declared type is a 400');
  eq(seen.length, before, 'and it is refused BEFORE the Anthropic call');
}
{
  const r = await chat(turn({ images: [dataUrl('image/png', PNG), dataUrl('image/jpeg', JPEG)] }));
  ok(r.stream, 'two valid screenshots ride along', JSON.stringify(r.j));
  const sent = seen.at(-1);
  const last = sent.messages.at(-1);
  ok(Array.isArray(last.content), 'the LAST user message became a content-block array');
  const imgs = last.content.filter((b) => b.type === 'image');
  eq(imgs.length, 2, 'both images are image content blocks');
  eq(imgs.map((b) => b.source.media_type), ['image/png', 'image/jpeg'], 'each carries its SNIFFED media type');
  eq(imgs[0].source.type, 'base64', 'as base64 sources');
  eq(last.content.filter((b) => b.type === 'text').length, 1, 'and the operator text is still there');

  const msgs = await schema.readThread(P1, FA);
  const stored = msgs.at(-2);
  eq(stored.image_count, 2, 'the stored user turn records HOW MANY screenshots');
  const raw = await sql`SELECT * FROM lb_ai_dev_chats ORDER BY id DESC LIMIT 2`;
  const blob = JSON.stringify(raw);
  ok(!blob.includes(PNG.toString('base64').slice(0, 12)),
    'THE INVARIANT: the image BYTES appear NOWHERE in the stored rows — pass-through only');
}

console.log('\n=== the attached-context chip ===');
{
  const r = await chat(turn({ attachment: { block_id: 'blk_cta', kind: 'THIS IS A LIE', block_path: 'blocks[1]' } }));
  ok(r.stream, 'a turn with an attachment streams', JSON.stringify(r.j));
  const done = r.frames.find((x) => x.event === 'done');
  eq(done.data.attachment.block_type, 'button',
    'the done frame returns the RESOLVED type — the chip shows the block\'s truth, not the client\'s claim');
  eq(done.data.attachment.excerpt, 'Buy now', 'and an excerpt read off the live block');

  const sys = seen.at(-1).system;
  ok(sys.includes('blk_cta') && sys.includes('"Buy now"'),
    'the system prompt names the attached block AND quotes it');

  const msgs = await schema.readThread(P1, FA);
  eq(msgs.at(-2).attachment.block_type, 'button', 'the RESOLVED attachment is what gets persisted');
}
{
  const before = seen.length;
  const r = await chat(turn({ attachment: { block_id: 'blk_not_on_this_page' } }));
  eq(r.status, 400, 'an attachment naming a block that is not on the page is a 400');
  eq(seen.length, before, 'and costs no Anthropic call');
}

console.log('\n=== FAILURE PATH: the thread write throws ===');
{
  // Rename the table out from under the route. The turn must still answer —
  // the transcript is a convenience, not the product.
  await sql`ALTER TABLE lb_ai_dev_chats RENAME TO lb_ai_dev_chats_hidden`;
  const r = await chat(turn({ messages: [{ role: 'user', content: 'persist will fail' }] }));
  ok(r.stream, 'the turn STILL streams when the thread write is impossible', JSON.stringify(r.j));
  const done = r.frames.find((x) => x.event === 'done');
  eq(done?.data?.reply, 'Looks good. Nothing to change.',
    'AND STILL DELIVERS THE REPLY — a database blip must not cost a turn the operator already paid for');
  await sql`ALTER TABLE lb_ai_dev_chats_hidden RENAME TO lb_ai_dev_chats`;
}
{
  // And the GET path surfaces a clean 500 rather than crashing the process.
  await sql`ALTER TABLE lb_ai_dev_chats RENAME TO lb_ai_dev_chats_hidden`;
  const r = await fetch(`${BASE}/ai-developer/chat?page_id=${P1}&funnel_id=${FA}`, { headers: H });
  const j = await r.json().catch(() => null);
  eq(r.status, 500, 'an unreadable thread is a 500, not an unhandled rejection');
  ok(typeof j?.error === 'string' && !/relation|lb_ai_dev_chats|postgres/i.test(j.error),
    'and the error body does NOT leak the SQL/relation name', JSON.stringify(j));
  await sql`ALTER TABLE lb_ai_dev_chats_hidden RENAME TO lb_ai_dev_chats`;
}
{
  // The process survived both. Prove the endpoint still works.
  const r = await chat(turn({ messages: [{ role: 'user', content: 'still alive?' }] }));
  ok(r.stream, 'the endpoint recovers once the table is back — no wedged state');
  const msgs = await schema.readThread(P1, FA);
  eq(msgs.at(-2).content, 'still alive?', 'and persistence resumes');
}

console.log('\n=== F3: DELETE issued MID-STREAM ===');
{
  // The exact defect sequence: a turn is streaming, the operator clears the
  // conversation, the turn then reaches its persist block. Before the epoch
  // guard, that persist repopulated the thread the operator had just emptied.
  await schema.appendThread(P1, FA, [{ role: 'user', content: 'seed before the clear' }]);
  const seededBefore = (await schema.readThread(P1, FA)).length;
  ok(seededBefore > 0, 'the thread has content before the mid-stream clear');

  let release;
  stall = new Promise((r) => { release = r; });
  const requestReached = new Promise((r) => { onRequestSeen = r; });

  // Fire the turn WITHOUT awaiting it.
  const inFlight = chat(turn({ messages: [{ role: 'user', content: 'clear me mid-stream' }] }));

  // Wait until Anthropic has actually been called — which proves the route has
  // already opened its epoch (openThreadEpoch runs before the model call).
  await requestReached;

  // …now clear, while the stream is still open.
  const del = await fetch(`${BASE}/ai-developer/chat?page_id=${P1}&funnel_id=${FA}`, { method: 'DELETE', headers: H });
  const delJson = await del.json();
  eq(del.status, 200, 'the mid-stream DELETE succeeds');
  ok(delJson?.data?.cleared >= 1, 'and reports the rows it removed', JSON.stringify(delJson));

  const [{ c: rightAfter }] = await sql`SELECT COUNT(*)::int AS c FROM lb_ai_dev_chats WHERE page_id = ${P1}`;
  eq(rightAfter, 0, 'the thread is empty immediately after the clear');

  // Let the turn finish and settle.
  release();
  const r = await inFlight;
  stall = null;
  ok(r.stream, 'the in-flight turn still completes normally for the operator', JSON.stringify(r.j));
  eq(r.frames.find((x) => x.event === 'done')?.data?.reply, 'Looks good. Nothing to change.',
    'and still delivers its reply — the clear does not cost the operator their answer');

  const [{ c: afterSettle }] = await sql`SELECT COUNT(*)::int AS c FROM lb_ai_dev_chats WHERE page_id = ${P1}`;
  eq(afterSettle, 0,
    'F3: AFTER THE TURN SETTLES THE THREAD IS STILL EMPTY — the clear was not silently undone');
  eq((await schema.readThread(P1, FA)).length, 0, 'and the endpoint agrees the thread is empty');
}
{
  // And the very next turn persists normally — the guard stands down exactly
  // one turn, it does not wedge the thread.
  const r = await chat(turn({ messages: [{ role: 'user', content: 'after the clear' }] }));
  ok(r.stream, 'the next turn streams');
  const msgs = await schema.readThread(P1, FA);
  eq(msgs.map((m) => m.content), ['after the clear', 'Looks good. Nothing to change.'],
    'and it is persisted — only the post-clear turn is in the thread');
}

console.log('\n=== F7: an empty user turn ===');
{
  const before = seen.length;
  const r = await chat(turn({ messages: [{ role: 'user', content: '   ' }] }));
  eq(r.status, 400, 'a whitespace-only user turn is a 400');
  eq(seen.length, before, 'and costs no Anthropic call');
}

console.log('\n=== F1: the size bypass, end to end ===');
{
  const before = seen.length;
  const wall = `data:image/png;base64,${PNG.toString('base64')}${'='.repeat(6 * 1024 * 1024)}`;
  const r = await chat(turn({ images: [wall] }));
  eq(r.status, 400, 'F1 e2e: the padding-wall image is refused at the route');
  eq(seen.length, before, 'F1 e2e: and NOTHING was relayed to Anthropic');
}
{
  // Whatever does get through must be inside the cap. Measure what the mock
  // actually received rather than trusting the validator's own arithmetic.
  const big = Buffer.concat([PNG, Buffer.alloc(3 * 1024 * 1024)]); // ~3MB, under the cap
  const r = await chat(turn({ images: [dataUrl('image/png', big)] }));
  ok(r.stream, 'a large-but-legal image is accepted', JSON.stringify(r.j));
  const img = seen.at(-1).messages.at(-1).content.find((b) => b.type === 'image');
  const relayed = Buffer.byteLength(img.source.data, 'base64');
  ok(relayed <= 4 * 1024 * 1024,
    `F1 e2e: the mock received ${relayed} decoded bytes — at or under the 4MB cap`);
}

console.log('\n=== F2: bare base64 end to end ===');
{
  const r = await chat(turn({ images: [JPEG.toString('base64')] }));
  ok(r.stream, 'F2 e2e: a bare-base64 JPEG with nothing declared is accepted', JSON.stringify(r.j));
  const img = seen.at(-1).messages.at(-1).content.find((b) => b.type === 'image');
  eq(img.source.media_type, 'image/jpeg', 'F2 e2e: and Anthropic is told image/jpeg, the SNIFFED truth');
}

console.log('\n=== missing API key ===');
{
  const key = process.env.ANTHROPIC_API_KEY;
  delete process.env.ANTHROPIC_API_KEY;
  const r = await chat(turn());
  eq(r.status, 503, 'an unconfigured ANTHROPIC_API_KEY is a clean 503');
  ok(!r.stream, 'and does not open a stream');
  process.env.ANTHROPIC_API_KEY = key;
}

await sql.end();
server.close();
anthropic.close();
console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
