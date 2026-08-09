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
  numericPageId, visibleText, summarize, mapPageRows, composeLiveUrl, nextPageInfo,
  LIST_LIMIT_MAX, LIST_LIMIT_DEFAULT, LIST_HOP_MAX, FETCH_TIMEOUT_MS,
  PAGES_RATE_MAX, PAGES_RATE_WINDOW_SEC, THEME_BUILT_MIN_TEXT,
} = mod;
const { ESCAPE_HATCH_MAX, INPUT_MAX } = await import('../../src/routes/pageClone.js');

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
eq(summarize('<p>' + 'z'.repeat(500) + '</p>').length, 160, 'summarize: capped at 160 chars');

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
const bumpUser = () => { userSeq += 1; USER = `u${userSeq}`; return USER; };
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
  // A dead credential on the DECORATIVE shop.json call still surfaces — a
  // revoked token must not hide behind a best-effort degrade.
  fetchImpl = routeFetch({ shop: () => jsonResponse({}, 401) });
  const r = await call('/stub/list');
  eq(r.body?.error?.code, 'shopify_auth_error', 'degrade: a 401 on shop.json still surfaces as a dead credential');
  // …while a transient blip on it degrades to the configured host.
  fetchImpl = routeFetch({
    shop: () => jsonResponse({}, 503),
    pages: () => jsonResponse({ pages: [{ id: 3, title: 'X', handle: 'x', body_html: `<p>${COPY}</p>` }] }),
  });
  const r2 = await call('/stub/list');
  eq(r2.status, 200, 'degrade: a blip on the decorative shop.json does not fail the list');
  eq(r2.body.data.store_domain, 'test.myshopify.com', 'degrade: it falls back to the configured store host');
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

// ---- IMPORT: THEME-BUILT / EMPTY SOURCE ----------------------------------
{
  bumpUser();
  for (const [label, body] of [
    ['an empty body_html', ''],
    ['a whitespace-only body', '   \n  '],
    ['markup with no visible text', '<div><span></span><img src="/a.jpg"></div>'],
    ['under the visible-text floor', `<p>${'x'.repeat(THEME_BUILT_MIN_TEXT - 1)}</p>`],
    ['text that only lives in a <script>', `<script>${'y'.repeat(400)}</script>`],
  ]) {
    fetchImpl = routeFetch({ page: () => jsonResponse({ page: { id: 5, title: 'Theme', handle: 'theme', body_html: body } }) });
    const r = await call('/stub/import', { page_id: '5' });
    eq(r.status, 422, `theme-built: ${label} → 422, not a blank clone`);
    eq(r.body?.error?.code, 'theme_built', `theme-built: ${label} → code theme_built`);
    eq(r.body?.error?.retryable, false, `theme-built: ${label} is not retryable`);
    eq(r.body?.error?.live_url, 'https://shop.example.com/pages/theme', `theme-built: ${label} hands back the live URL so the operator can paste it`);
  }
  // One character over the floor imports.
  fetchImpl = routeFetch({ page: () => jsonResponse({ page: { id: 5, title: 'T', handle: 't', body_html: `<p>${'x'.repeat(THEME_BUILT_MIN_TEXT)}</p>` } }) });
  const r = await call('/stub/import', { page_id: '5' });
  eq(r.status, 200, `theme-built: exactly ${THEME_BUILT_MIN_TEXT} visible chars imports`);
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
    ['HTTP 404', () => jsonResponse({}, 404), 'shopify_unavailable', true],
    ['HTTP 500', () => jsonResponse({}, 500), 'shopify_unavailable', true],
    ['HTTP 401', () => jsonResponse({}, 401), 'shopify_auth_error', false],
  ];
  for (const [label, impl, code, retryable] of cases) {
    fetchImpl = routeFetch({ page: impl });
    const r = await call('/stub/import', { page_id: '7' });
    eq(r.status, 503, `import-fail: ${label} → 503`);
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
  let calls = 0;
  fetchImpl = routeFetch({ pages: () => { calls += 1; return jsonResponse({ pages: [] }); } });
  let limited = null;
  for (let i = 0; i < PAGES_RATE_MAX + 6; i += 1) {
    const r = await call('/stub/list');
    if (r.status === 429) { limited = r; break; }
  }
  ok(limited !== null, 'rate: hammering the picker eventually returns 429');
  if (limited) {
    eq(limited.body?.error?.code, 'rate_limited', 'rate: with code rate_limited');
    eq(limited.body?.error?.retryable, true, 'rate: a throttle clears on its own, so it IS flagged retryable');
    ok(!Array.isArray(limited.body?.data?.pages), 'rate: a 429 returns no pages array — it is not an empty store');
    ok(calls <= PAGES_RATE_MAX, 'rate: and Shopify was called at most the cap — the shared Admin bucket is protected', `calls=${calls}`);
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
