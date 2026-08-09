// Verification harness for GENERATE-WITH-AI (routes/aiPageGenerate.js).
//
// Boots a MOCK Anthropic endpoint (the SDK honours ANTHROPIC_BASE_URL — set
// BEFORE the route is imported), mounts the exported handler behind a STUB
// req.user (the real router keeps authenticate + requirePermission — nothing
// here weakens it), and drives the NDJSON stream end to end. Also mounts the
// REAL router to prove unauth → 401, and counts funnel_pages rows around a
// full run to prove the route never writes pages. Embedded PG at
// 127.0.0.1:5433 (same as the clone-page harness).
//
// Run:  node server/tests/ai-generate/route-stream.mjs
import http from 'node:http';

process.env.DATABASE_URL = 'postgres://puure@127.0.0.1:5433/puure_shoporder';
process.env.NODE_ENV = 'development';
process.env.MONEY_SWEEP_DISABLED = '1';
process.env.ANTHROPIC_API_KEY = 'test-key-not-real';
process.env.JWT_SECRET = process.env.JWT_SECRET || 'test-secret';
process.env.JWT_REFRESH_SECRET = process.env.JWT_REFRESH_SECRET || 'test-secret-2';

const NM = '/Users/ludo/Mineblock-LLC/node_modules';
const express = (await import(`${NM}/express/index.js`)).default;
const postgres = (await import(`${NM}/postgres/src/index.js`)).default;

let pass = 0;
let fail = 0;
const check = (name, ok, extra = '') => {
  if (ok) { pass += 1; console.log(`PASS  ${name}`); }
  else { fail += 1; console.log(`FAIL  ${name}  ${extra}`); }
};

// ---------------------------------------------------------------------------
// Mock Anthropic endpoint
// ---------------------------------------------------------------------------
const ARCH = {
  page_title: 'SleepReset Landing',
  sections: [
    { name: 'Masthead + Kicker', purpose: 'Hook tired moms', wants_image: true, aspect: '4:5' },
    { name: 'Hero Figure', purpose: 'Show the product', wants_image: false },
    { name: 'FAQ', purpose: 'Answer objections', wants_image: false },
  ],
};

const SECTION_HTML = [
  // fenced on purpose — exercises the unfence path; carries the image contract
  '```html\n<section style="padding:40px"><h1>SleepReset</h1><div class="lb-ai-image" data-ai-image-prompt="A tired mom holding a warm cup, soft morning light, photorealistic" data-aspect="4:5" style="background:#f1f5f9;border:1px dashed #cbd5e1">Click to generate image</div></section>\n```',
  // scripts on purpose — must arrive stripped
  '<section><h2>Why melatonin fails</h2><script>alert("evil")</script><p>Reason one</p><script src="https://evil.example/x.js"></script></section>',
  '<section><h3>FAQ</h3><p>60-day guarantee.</p></section>',
];

const mockCalls = { arch: 0, sections: 0 };

const mockServer = http.createServer((req, res) => {
  let raw = '';
  req.on('data', (c) => { raw += c; });
  req.on('end', () => {
    let body = {};
    try { body = JSON.parse(raw); } catch { /* leave empty */ }
    const respond = (code, obj) => {
      res.writeHead(code, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(obj));
    };
    if (!/\/v1\/messages$/.test(req.url)) return respond(404, { error: 'not found' });

    const userText = body.messages?.[0]?.content || '';

    if (body.tool_choice?.type === 'tool') {
      mockCalls.arch += 1;
      return respond(200, {
        id: 'msg_arch', type: 'message', role: 'assistant', model: body.model,
        content: [{ type: 'tool_use', id: 'toolu_1', name: 'emit_page_architecture', input: ARCH }],
        stop_reason: 'tool_use', stop_sequence: null,
        usage: { input_tokens: 100, output_tokens: 60 },
      });
    }

    const m = String(userText).match(/Write section (\d+):/);
    const idx = m ? Number(m[1]) - 1 : 0;
    mockCalls.sections += 1;
    if (/FAIL_SECTION_2/.test(String(userText)) && idx === 1) {
      // 400 is not retried by the SDK — the route must emit an error event.
      return respond(400, {
        type: 'error',
        error: { type: 'invalid_request_error', message: 'mock section failure' },
      });
    }
    return respond(200, {
      id: `msg_s${idx}`, type: 'message', role: 'assistant', model: body.model,
      content: [{ type: 'text', text: SECTION_HTML[idx] ?? '<section>fallback</section>' }],
      stop_reason: 'end_turn', stop_sequence: null,
      usage: { input_tokens: 200, output_tokens: 300 },
    });
  });
});
await new Promise((r) => mockServer.listen(0, '127.0.0.1', r));
process.env.ANTHROPIC_BASE_URL = `http://127.0.0.1:${mockServer.address().port}`;

// ---------------------------------------------------------------------------
// Import the route AFTER the env is staged
// ---------------------------------------------------------------------------
const routeModule = await import('../../src/routes/aiPageGenerate.js');
const { generateHandler, stripScripts, extractImageSlots, MODEL_ALLOWLIST } = routeModule;
const realRouter = routeModule.default;

// Harness app: stub auth + exported handler (real router keeps authenticate).
const app = express();
app.use(express.json({ limit: '5mb' }));
app.use((req, _res, next) => { req.user = { id: 'u_test', role: 'admin' }; next(); });
app.post('/page', generateHandler);
// Real router (authenticate first) for the unauth probe.
app.use('/api/v1/ai-generate', realRouter);
const server = app.listen(0, '127.0.0.1');
await new Promise((r) => server.once('listening', r));
const BASE = `http://127.0.0.1:${server.address().port}`;

const postPage = (body, path = '/page', headers = {}) =>
  fetch(`${BASE}${path}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', ...headers },
    body: JSON.stringify(body),
  });

const readNdjson = async (res) => {
  const events = [];
  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let buf = '';
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    buf += decoder.decode(value, { stream: true });
    let nl;
    while ((nl = buf.indexOf('\n')) !== -1) {
      const line = buf.slice(0, nl).trim();
      buf = buf.slice(nl + 1);
      if (line) events.push(JSON.parse(line));
    }
  }
  return events;
};

// ---------------------------------------------------------------------------
// Unit: stripScripts + extractImageSlots
// ---------------------------------------------------------------------------
{
  const { html, removed } = stripScripts(
    '<div><script>1</script><script src="x"/><script >tail</div>'
  );
  check('stripScripts removes closed, self-closed and unclosed scripts', removed === 3 && !/<script/i.test(html));
  check('stripScripts keeps surrounding markup', /^<div><\/div>$/.test(html.replace('tail', '').trim()) || html.includes('<div>'));

  const slots = extractImageSlots(
    '<div class="lb-ai-image" data-ai-image-prompt="a cat" data-aspect="1:1">x</div><div class="lb-ai-image" data-ai-image-prompt=\'a dog\'>y</div>'
  );
  check('extractImageSlots finds both slots with prompt + aspect default',
    slots.length === 2 && slots[0].prompt === 'a cat' && slots[0].aspect === '1:1' && slots[1].prompt === 'a dog' && slots[1].aspect === '16:9',
    JSON.stringify(slots));
  check('model allowlist is exactly the three shipped models',
    MODEL_ALLOWLIST.size === 3 && ['claude-sonnet-5', 'claude-fable-5', 'claude-opus-5'].every((m) => MODEL_ALLOWLIST.has(m)));
}

// ---------------------------------------------------------------------------
// funnel_pages count BEFORE the full run
// ---------------------------------------------------------------------------
const sql = postgres(process.env.DATABASE_URL, { onnotice: () => {} });
let pagesBefore = null;
try {
  pagesBefore = Number((await sql`SELECT COUNT(*)::int AS n FROM funnel_pages`)[0].n);
} catch (err) {
  console.log(`NOTE  funnel_pages count unavailable (${err.message}) — count check will be skipped`);
}

// ---------------------------------------------------------------------------
// 1. Full run: architecture + sections stream in order, correct shapes
// ---------------------------------------------------------------------------
{
  const res = await postPage({ brief: 'A listicle landing page for a sleep supplement.', brand: 'warm, cream + terracotta', model: 'claude-sonnet-5' });
  check('full run responds 200', res.status === 200, `got ${res.status}`);
  check('full run is NDJSON', /application\/x-ndjson/.test(res.headers.get('content-type') || ''), res.headers.get('content-type'));
  const events = await readNdjson(res);

  const archEv = events[0];
  check('first event is architecture', archEv?.type === 'architecture', JSON.stringify(archEv)?.slice(0, 120));
  check('architecture carries generated page title', archEv?.page_title === 'SleepReset Landing');
  check('architecture has 3 sections with names', archEv?.sections?.length === 3 && archEv.sections[0].name === 'Masthead + Kicker' && archEv.sections[1].name === 'Hero Figure');

  const sectionEvents = events.filter((e) => e.type === 'section');
  check('three section events streamed', sectionEvents.length === 3, `got ${sectionEvents.length}`);
  check('section events arrive in index order', sectionEvents.map((e) => e.index).join(',') === '0,1,2');
  check('section events carry names + html strings', sectionEvents.every((e) => typeof e.name === 'string' && typeof e.html === 'string' && e.html.length > 0));

  const s0 = sectionEvents[0];
  check('markdown fence is unwrapped', s0.html.startsWith('<section') && !s0.html.includes('```'));
  check('image slot extracted with prompt + aspect', s0.images?.length === 1 && /tired mom/.test(s0.images[0].prompt) && s0.images[0].aspect === '4:5', JSON.stringify(s0.images));
  check('placeholder markup (prompt in markup) survives', /data-ai-image-prompt="A tired mom/.test(s0.html) && /Click to generate image/.test(s0.html));

  const s1 = sectionEvents[1];
  check('mock section containing <script> arrives script-stripped', !/<script/i.test(s1.html), s1.html.slice(0, 200));
  check('script-stripped section keeps its real content', /Reason one/.test(s1.html) && /Why melatonin fails/.test(s1.html));
  check('no images on imageless section', Array.isArray(s1.images) && s1.images.length === 0);

  const last = events[events.length - 1];
  check('stream ends with done event', last?.type === 'done' && last.total === 3, JSON.stringify(last));
  check('mock saw 1 architecture + 3 section calls', mockCalls.arch === 1 && mockCalls.sections === 3, JSON.stringify(mockCalls));
}

// ---------------------------------------------------------------------------
// 2. funnel_pages row count unchanged after the full run
// ---------------------------------------------------------------------------
if (pagesBefore != null) {
  const pagesAfter = Number((await sql`SELECT COUNT(*)::int AS n FROM funnel_pages`)[0].n);
  check('funnel_pages row count unchanged after a full run', pagesAfter === pagesBefore, `${pagesBefore} -> ${pagesAfter}`);
}

// ---------------------------------------------------------------------------
// 3. Mid-run model failure → error event, partial sections remain usable
// ---------------------------------------------------------------------------
{
  const res = await postPage({ brief: 'FAIL_SECTION_2 — a page whose second section dies.' });
  check('mid-run failure still responds 200 (stream already open)', res.status === 200);
  const events = await readNdjson(res);
  const sectionEvents = events.filter((e) => e.type === 'section');
  const errorEvents = events.filter((e) => e.type === 'error');
  check('one section landed before the failure', sectionEvents.length === 1 && sectionEvents[0].index === 0);
  check('failure emits an error event and ends the stream', errorEvents.length === 1 && events[events.length - 1].type === 'error', JSON.stringify(events.map((e) => e.type)));
  check('no done event after mid-run failure', !events.some((e) => e.type === 'done'));
  check('error names the failed section + usable partials', /Section 2/.test(errorEvents[0]?.error || '') && /1 finished section/.test(errorEvents[0]?.error || ''), errorEvents[0]?.error);
}

// ---------------------------------------------------------------------------
// 4. Oversized brief → 413 (before any stream)
// ---------------------------------------------------------------------------
{
  const res = await postPage({ brief: 'x'.repeat(20 * 1024 + 1) });
  const j = await res.json();
  check('oversized brief → 413', res.status === 413 && /20KB/.test(j.error || ''), `got ${res.status} ${JSON.stringify(j)}`);
  const res2 = await postPage({ brief: 'ok', brand: 'y'.repeat(2 * 1024 + 1) });
  check('oversized brand → 413', res2.status === 413);
}

// ---------------------------------------------------------------------------
// 5. Disallowed model → 400; missing brief → 400
// ---------------------------------------------------------------------------
{
  const res = await postPage({ brief: 'ok', model: 'claude-haiku-4-5' });
  const j = await res.json();
  check('disallowed model → 400', res.status === 400 && /model must be one of/.test(j.error || ''), `got ${res.status}`);
  const res2 = await postPage({ model: 'claude-sonnet-5' });
  check('missing brief → 400', res2.status === 400);
}

// ---------------------------------------------------------------------------
// 6. Unauth → 401 through the REAL router (authenticate intact)
// ---------------------------------------------------------------------------
{
  // NOTE: the stub-user middleware above also runs for this path, but the
  // real router's own authenticate rejects on the missing token FIRST.
  const res = await postPage({ brief: 'ok' }, '/api/v1/ai-generate/page');
  const j = await res.json().catch(() => ({}));
  check('unauth via real router → 401', res.status === 401, `got ${res.status} ${JSON.stringify(j)}`);
}

// ---------------------------------------------------------------------------
console.log(`\n${pass} passed, ${fail} failed`);
await sql.end({ timeout: 2 }).catch(() => {});
server.close();
mockServer.close();
process.exit(fail ? 1 : 0);
