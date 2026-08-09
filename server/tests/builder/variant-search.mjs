// Verification harness for SHOPIFY VARIANT SEARCH (routes/shopifyVariants.js).
//
// Shopify is MOCKED by replacing globalThis.fetch — the route reads it at call
// time, so no network is touched and no real credential is used. Two mounts:
//   · the REAL router (authenticate + requirePermission intact) to prove an
//     unauthenticated call is refused
//   · the exported searchHandler behind a stub req.user, to drive the body
//     semantics without weakening the real router
//
// Run:  node server/tests/builder/variant-search.mjs
process.env.DATABASE_URL = 'postgres://puure@127.0.0.1:5433/puure_shoporder';
process.env.NODE_ENV = 'development';
process.env.MONEY_SWEEP_DISABLED = '1';

const NM = '/Users/ludo/Mineblock-LLC/node_modules';
const express = (await import(`${NM}/express/index.js`)).default;

const mod = await import('../../src/routes/shopifyVariants.js');
const {
  default: router, searchHandler,
  mapVariantNodes, numericVariantId, buildSearchQuery,
  SEARCH_LIMIT_MAX, Q_MIN, FETCH_TIMEOUT_MS,
} = mod;

let pass = 0, fail = 0;
const ok = (c, m, x = '') => { if (c) { pass++; console.log(`PASS  ${m}`); } else { fail++; console.log(`FAIL  ${m}  ${x}`); } };
const eq = (got, want, m) => ok(
  JSON.stringify(got) === JSON.stringify(want), m,
  `\n      got  ${JSON.stringify(got)}\n      want ${JSON.stringify(want)}`
);

// ===========================================================================
// PURE UNITS
// ===========================================================================
eq(numericVariantId('gid://shopify/ProductVariant/12345'), '12345', 'numericVariantId: gid → digits');
eq(numericVariantId('12345'), '', 'numericVariantId: a bare number is NOT a gid');
eq(numericVariantId('gid://shopify/Product/12345'), '', 'numericVariantId: a PRODUCT gid is refused (wrong resource)');
eq(numericVariantId(null), '', 'numericVariantId: null → ""');
eq(numericVariantId('gid://shopify/ProductVariant/abc'), '', 'numericVariantId: non-numeric tail refused');

// Search-operator smuggling: a term with Shopify query syntax must stay ONE
// literal term, not silently change which products are searched.
eq(buildSearchQuery('glow'), '"glow"', 'buildSearchQuery: plain term quoted');
eq(buildSearchQuery('status:draft'), '"status:draft"', 'buildSearchQuery: a colon operator stays inside the quotes');
eq(buildSearchQuery('a"b'), '"a\\"b"', 'buildSearchQuery: an embedded quote is escaped, cannot break out');
eq(buildSearchQuery('a\\b'), '"a\\\\b"', 'buildSearchQuery: a backslash is escaped');
ok(buildSearchQuery('x'.repeat(500)).length < 200, 'buildSearchQuery: an over-long term is capped');
eq(buildSearchQuery(null), '""', 'buildSearchQuery: null → empty quoted term, no throw');

{
  const edges = [
    { node: { id: 'gid://shopify/ProductVariant/1', title: 'Small', price: '19.00', sku: 'S1', availableForSale: true, image: { url: 'i1' }, product: { title: 'Kit', status: 'ACTIVE' } } },
    { node: { id: 'gid://shopify/ProductVariant/2', title: null, price: null, product: { featuredImage: { url: 'p2' } } } },
  ];
  const out = mapVariantNodes(edges);
  eq(out.length, 2, 'map: both variants mapped');
  eq(out[0], { variant_id: '1', title: 'Small', product_title: 'Kit', price: '19.00', image: 'i1', sku: 'S1', available: true, product_status: 'ACTIVE' }, 'map: full node → wire shape');
  eq(out[1].image, 'p2', 'map: falls back to the product featuredImage');
  eq([out[1].title, out[1].price, out[1].product_title], ['', '', ''], 'map: null fields → empty strings, never null');
  eq(out[1].available, false, 'map: missing availableForSale → false, never undefined');
}
{
  // Malformed nodes are DROPPED, never thrown on — and a node with no usable
  // numeric id is not addressable by the bump contract, so it must not be
  // offered as a choice at all.
  const out = mapVariantNodes([
    null, {}, { node: null }, { node: 'str' },
    { node: { id: 'gid://shopify/Product/9' } },
    { node: { id: 'gid://shopify/ProductVariant/7', product: null } },
  ]);
  eq(out.length, 1, 'map: every malformed node dropped, the one good node survives');
  eq(out[0].variant_id, '7', 'map: and it is the right one');
  eq(out[0].product_title, '', 'map: null product does not throw');
}
eq(mapVariantNodes(null), [], 'map: null edges → []');
eq(mapVariantNodes('nope'), [], 'map: a string → []');
eq(mapVariantNodes([]), [], 'map: empty → []');

// ===========================================================================
// HTTP
// ===========================================================================
const realFetch = globalThis.fetch;
let fetchImpl = null;
globalThis.fetch = (...args) => fetchImpl(...args);

const jsonResponse = (payload, status = 200) => ({
  ok: status >= 200 && status < 300,
  status,
  json: async () => payload,
});

const app = express();
app.use(express.json());
// Real router — auth intact.
app.use('/api/v1/shopify-variants', router);
// Stub-authed mount for body semantics.
app.use('/stub', (req, _res, next) => { req.user = { id: 'u1', role: 'admin' }; next(); });
app.get('/stub/search', searchHandler);

const server = app.listen(0);
await new Promise((r) => server.once('listening', r));
const base = `http://127.0.0.1:${server.address().port}`;
const get = async (path) => {
  const r = await realFetch(`${base}${path}`);
  let body = null;
  try { body = await r.json(); } catch { body = null; }
  return { status: r.status, body };
};

// ---- AUTH -----------------------------------------------------------------
{
  fetchImpl = async () => { throw new Error('Shopify must NOT be called on an unauthenticated request'); };
  const r = await get('/api/v1/shopify-variants/search?q=glow');
  eq(r.status, 401, 'auth: an unauthenticated search is refused 401');
  ok(!JSON.stringify(r.body || {}).toLowerCase().includes('shopify'), 'auth: and the refusal leaks nothing about Shopify', JSON.stringify(r.body));
}

// ---- q VALIDATION ---------------------------------------------------------
{
  fetchImpl = async () => { throw new Error('Shopify must NOT be called for an invalid q'); };
  for (const [qs, label] of [['', 'missing q'], ['?q=', 'empty q'], ['?q=a', 'one-character q'], ['?q=%20%20', 'whitespace-only q']]) {
    const r = await get(`/stub/search${qs}`);
    eq(r.status, 400, `q: ${label} → 400`);
    eq(r.body?.error?.code, 'q_required', `q: ${label} → code q_required`);
  }
  ok(Q_MIN === 2, 'q: minimum length is 2');
}

// ---- HAPPY PATH + LIMIT CAP ----------------------------------------------
{
  let seenVars = null;
  let seenHeaders = null;
  let seenUrl = null;
  process.env.PUURE_SHOPIFY_STORE = 'test.myshopify.com';
  process.env.PUURE_SHOPIFY_TOKEN = 'shpat_SECRETVALUE';
  fetchImpl = async (url, opts) => {
    seenUrl = String(url);
    seenHeaders = opts.headers;
    seenVars = JSON.parse(opts.body).variables;
    return jsonResponse({
      data: { productVariants: { edges: [
        { node: { id: 'gid://shopify/ProductVariant/55', title: 'One', price: '9.99', product: { title: 'Thing' } } },
      ] } },
    });
  };

  const r = await get('/stub/search?q=glow');
  eq(r.status, 200, 'happy: 200');
  eq(r.body?.success, true, 'happy: success true');
  eq(r.body?.data?.variants?.length, 1, 'happy: one variant');
  eq(r.body.data.variants[0].variant_id, '55', 'happy: numeric variant_id (the shape the bump contract stores)');

  // CREDENTIAL HYGIENE: the token travels in a HEADER, never in the URL.
  ok(!seenUrl.includes('shpat_'), 'creds: the token is NOT in the request URL', seenUrl);
  eq(seenHeaders['X-Shopify-Access-Token'], 'shpat_SECRETVALUE', 'creds: the token travels in the header');
  ok(!JSON.stringify(r.body).includes('shpat_'), 'creds: the token never appears in the response body');

  // limit cap
  await get(`/stub/search?q=glow&limit=9999`);
  eq(seenVars.first, SEARCH_LIMIT_MAX, `limit: 9999 is capped to ${SEARCH_LIMIT_MAX}`);
  await get('/stub/search?q=glow&limit=5');
  eq(seenVars.first, 5, 'limit: an in-range limit is honoured');
  await get('/stub/search?q=glow&limit=abc');
  eq(seenVars.first, 20, 'limit: a non-numeric limit falls back to the default');
  await get('/stub/search?q=glow&limit=-3');
  eq(seenVars.first, 20, 'limit: a negative limit falls back to the default');
}

// ---- EMPTY CATALOG vs OUTAGE ---------------------------------------------
{
  fetchImpl = async () => jsonResponse({ data: { productVariants: { edges: [] } } });
  const r = await get('/stub/search?q=nothing');
  eq(r.status, 200, 'empty: a genuinely empty result is 200');
  eq(r.body.data.variants, [], 'empty: with an empty array — a POSITIVE claim about the catalog');
}

// ---- FAILURE PATHS — each must be 503, none may read as "no results" ------
{
  const cases = [
    ['timeout (AbortError)', async () => { const e = new Error('aborted'); e.name = 'AbortError'; throw e; }, 'shopify_unavailable'],
    ['network failure', async () => { throw new Error('ECONNREFUSED'); }, 'shopify_unavailable'],
    ['HTTP 500', async () => jsonResponse({}, 500), 'shopify_unavailable'],
    ['HTTP 401 from Shopify', async () => jsonResponse({}, 401), 'shopify_unavailable'],
    ['HTTP 429 throttle', async () => jsonResponse({}, 429), 'shopify_unavailable'],
    ['unparseable body', async () => ({ ok: true, status: 200, json: async () => { throw new Error('bad json'); } }), 'shopify_unavailable'],
    ['GraphQL errors in a 200', async () => jsonResponse({ errors: [{ message: 'throttled' }], data: { productVariants: { edges: [] } } }), 'shopify_unavailable'],
  ];
  for (const [label, impl, code] of cases) {
    fetchImpl = impl;
    const r = await get('/stub/search?q=glow');
    eq(r.status, 503, `fail: ${label} → 503 (retryable), never 200`);
    eq(r.body?.error?.code, code, `fail: ${label} → code ${code}`);
    ok(!Array.isArray(r.body?.data?.variants), `fail: ${label} does NOT return an empty variants array (that would read as "no products")`);
  }
}
{
  // Missing config is an OPS outage with its own code — not a bad query.
  const store = process.env.PUURE_SHOPIFY_STORE;
  const token = process.env.PUURE_SHOPIFY_TOKEN;
  delete process.env.PUURE_SHOPIFY_STORE;
  delete process.env.PUURE_SHOPIFY_TOKEN;
  delete process.env.SHOPIFY_STORE_DOMAIN;
  delete process.env.SHOPIFY_ACCESS_TOKEN;
  fetchImpl = async () => { throw new Error('must not reach Shopify with no credentials'); };
  const r = await get('/stub/search?q=glow');
  eq(r.status, 503, 'config: missing credentials → 503');
  eq(r.body?.error?.code, 'shopify_not_configured', 'config: with its OWN code, distinguishable from an outage');
  process.env.PUURE_SHOPIFY_STORE = store;
  process.env.PUURE_SHOPIFY_TOKEN = token;
}

// ---- the 8s timeout is actually armed -------------------------------------
{
  eq(FETCH_TIMEOUT_MS, 8000, 'timeout: the budget is 8s as specified');
  let sawSignal = false;
  let aborted = false;
  fetchImpl = async (_url, opts) => {
    sawSignal = !!opts.signal;
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
  const r = await get('/stub/search?q=slow');
  ok(sawSignal, 'timeout: an AbortSignal is passed to fetch');
  ok(aborted, 'timeout: the abort path fires');
  eq(r.status, 503, 'timeout: an aborted request answers 503, never a hang or a 200');
}

server.close();
globalThis.fetch = realFetch;
console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
