// Verification harness for FUNNEL COMMERCE (routes/funnelCommerce.js +
// services/whopProducts.js + services/checkoutCountries.js).
//
// Shopify and Whop are MOCKED by replacing globalThis.fetch — both are read at
// call time, so no network is touched and no real credential is used. Two
// mounts, exactly like server/tests/builder/variant-search.mjs:
//   · the REAL router (authenticate + requirePermission intact) to prove an
//     unauthenticated call is refused
//   · the exported handlers behind a stub req.user, to drive body semantics
//     without weakening the real router
//
// The DB is REAL (local Postgres) — the jsonb round-trip cases are the point
// of this file and a fake would prove nothing. Set COMMERCE_TEST_DB to point
// elsewhere. Every table this file touches is scoped to test funnel ids and
// cleaned up at the end.
//
// Run:  node server/tests/funnel-settings/commerce.mjs
process.env.DATABASE_URL = process.env.COMMERCE_TEST_DB
  || 'postgres://puure@127.0.0.1:5433/puure_shoporder';
process.env.NODE_ENV = 'development';
process.env.MONEY_SWEEP_DISABLED = '1';

const NM = '/Users/ludo/Mineblock-LLC/node_modules';
const express = (await import(`${NM}/express/index.js`)).default;

const route = await import('../../src/routes/funnelCommerce.js');
const {
  default: router,
  listProductsHandler, syncProductsHandler, listMappingsHandler,
  mapToWhopHandler, upsertMappingHandler, deleteMappingHandler,
  shippingZonesHandler,
  mapProductNodes, shapeZones, describeCondition, numericId, uncoveredCountries,
  SYNC_RATE_MAX, FETCH_TIMEOUT_MS,
} = route;

const whop = await import('../../src/services/whopProducts.js');
const {
  extractWhopProducts, extractWhopProduct, findWhopByName, planWhopMapping,
  listWhopProducts, createWhopProduct, WhopUnavailableError,
} = whop;

const cc = await import('../../src/services/checkoutCountries.js');
const {
  normalizeCountryCodes, isValidCountryCode, parseJsonColumn, readCommerceSettings,
} = cc;

const { pgQuery } = await import('../../src/db/pg.js');
const { ensureCommerceTables } = await import('../../src/services/funnelCommerceSchema.js');

let pass = 0; let fail = 0;
const ok = (c, m, x = '') => { if (c) { pass += 1; console.log(`PASS  ${m}`); } else { fail += 1; console.log(`FAIL  ${m}  ${x}`); } };
const eq = (got, want, m) => ok(
  JSON.stringify(got) === JSON.stringify(want), m,
  `\n      got  ${JSON.stringify(got)}\n      want ${JSON.stringify(want)}`
);

const FUNNEL = 'test_fc_funnel';
const FUNNEL_B = 'test_fc_funnel_b';

// ===========================================================================
// PURE — country validation
// ===========================================================================
ok(isValidCountryCode('US'), 'country: US is valid');
ok(isValidCountryCode('  bd '), 'country: whitespace + lower case still resolves');
ok(!isValidCountryCode('UK'), 'country: UK is exceptionally reserved, NOT an ISO checkout country');
ok(!isValidCountryCode('EU'), 'country: EU is an aggregate, refused');
ok(!isValidCountryCode('ZZ'), 'country: ZZ (unknown) refused');
ok(!isValidCountryCode(''), 'country: empty refused');
ok(!isValidCountryCode(null), 'country: null refused, no throw');

eq(normalizeCountryCodes(['us', 'GB', 'us', ' ca ']),
  { codes: ['US', 'GB', 'CA'], invalid: [] },
  'normalize: upper-cased, de-duplicated, input order kept');
eq(normalizeCountryCodes(['US', 'XX', 'EU']),
  { codes: ['US'], invalid: ['XX', 'EU'] },
  'normalize: invalid codes are REPORTED, not silently dropped');
eq(normalizeCountryCodes([{ code: 'US' }, ['US'], null, undefined, true]).codes, [],
  'normalize: objects/arrays/null/booleans are never coerced into codes');
eq(normalizeCountryCodes(null), { codes: [], invalid: [] }, 'normalize: null → empty, no throw');
eq(normalizeCountryCodes('US'), { codes: [], invalid: [] }, 'normalize: a bare string is not a list');
ok(normalizeCountryCodes(new Array(600).fill('US')).codes.length === 1,
  'normalize: a 600-entry flood collapses to the 1 distinct code and cannot blow the bound');

// ===========================================================================
// PURE — jsonb BOTH SHAPES (the trap this codebase has hit four times)
// ===========================================================================
eq(parseJsonColumn({ a: 1 }, null), { a: 1 }, 'jsonb: an OBJECT passes through');
eq(parseJsonColumn('{"a":1}', null), { a: 1 }, 'jsonb: a STRING is parsed');
eq(parseJsonColumn('[1,2]', null), [1, 2], 'jsonb: a STRING array is parsed');
eq(parseJsonColumn('not json', 'FB'), 'FB', 'jsonb: unparseable → fallback, never a throw');
eq(parseJsonColumn(null, 'FB'), 'FB', 'jsonb: null → fallback');
eq(parseJsonColumn('null', 'FB'), 'FB', 'jsonb: the literal string "null" → fallback, not null');

// readCommerceSettings must accept the column in BOTH shapes identically.
{
  const blob = { commerce: { shipping_mode: 'manual', restrict_countries: true, allowed_countries: ['us', 'gb'] } };
  const asObject = readCommerceSettings(blob);
  const asString = readCommerceSettings(JSON.stringify(blob));
  eq(asObject, asString, 'settings: the OBJECT and STRING shapes read IDENTICALLY');
  eq(asObject.allowed_countries, ['US', 'GB'], 'settings: countries come back normalized');
  eq(asObject.shipping_mode, 'manual', 'settings: mode round-trips');
}
eq(readCommerceSettings(undefined),
  { shipping_mode: 'shopify', restrict_countries: false, allowed_countries: [], flat_rates: [] },
  'settings: absent blob → safe defaults (shopify, unrestricted)');
eq(readCommerceSettings({ commerce: { shipping_mode: 'wat' } }).shipping_mode, 'shopify',
  'settings: an unknown mode falls back to shopify, never passes through');
eq(readCommerceSettings({ commerce: { restrict_countries: true, allowed_countries: [] } }).restrict_countries,
  false,
  'settings: restrict=true with an EMPTY allow-list degrades to unrestricted — it can never mean "sell to nobody"');
eq(readCommerceSettings({ commerce: { restrict_countries: true, allowed_countries: ['XX'] } }).restrict_countries,
  false,
  'settings: restrict=true whose codes are ALL invalid also degrades');
{
  const r = readCommerceSettings({
    commerce: {
      flat_rates: [
        { id: 'a', label: 'Std', cost: '4.995' },
        { id: 'b', label: 'Free', cost: 0 },
        { id: 'c', label: 'Bad', cost: -3 },
        { id: 'd', label: 'NaN', cost: 'abc' },
        'not an object',
      ],
    },
  }).flat_rates;
  eq(r.length, 4, 'flat rates: the non-object entry is dropped, the rest survive');
  eq(r.map((x) => x.cost), [5, 0, 0, 0],
    'flat rates: rounded to cents; negative and NaN costs become 0 (0 is FREE, a legitimate rate)');
}
eq(readCommerceSettings('][ not json').shipping_mode, 'shopify',
  'settings: a corrupt jsonb string degrades to defaults instead of throwing');

// ===========================================================================
// PURE — Shopify product shaping
// ===========================================================================
eq(numericId('gid://shopify/Product/77', 'Product'), '77', 'numericId: product gid → digits');
eq(numericId('gid://shopify/ProductVariant/77', 'Product'), '', 'numericId: a VARIANT gid is not a product');
eq(numericId(null, 'Product'), '', 'numericId: null → ""');

{
  const edges = [
    { node: {
      id: 'gid://shopify/Product/10', title: 'Kit', handle: 'kit', status: 'ACTIVE', vendor: 'Puure',
      featuredImage: { url: 'p.jpg' },
      variants: { edges: [
        { node: { id: 'gid://shopify/ProductVariant/1', title: 'Small', price: '19.00', sku: 'S1', availableForSale: true } },
        { node: { id: 'gid://shopify/ProductVariant/2', title: 'Large', price: '29.00', sku: 'L1', availableForSale: false } },
      ] } } },
  ];
  const out = mapProductNodes(edges);
  eq(out.length, 1, 'products: one product mapped');
  eq(out[0].shopify_product_id, '10', 'products: numeric product id');
  eq(out[0].variants_count, 2, 'products: variant count');
  eq(out[0].price, 19, 'products: display price is the FIRST variant price');
  eq(out[0].variants[1], { variant_id: '2', title: 'Large', price: '29.00', sku: 'L1', available: false },
    'products: variant wire shape, availableForSale surfaced');
}
{
  // MALFORMED INPUT: dropped, never thrown on. A product with no numeric id is
  // unaddressable and must not be offered at all.
  const out = mapProductNodes([
    null, {}, { node: null }, { node: 'str' },
    { node: { id: 'gid://shopify/Collection/9', title: 'Nope' } },
    { node: { id: 'gid://shopify/Product/9', title: 'NoVariants' } },
    { node: { id: 'gid://shopify/Product/8', title: 'Junk', variants: { edges: [null, { node: 'x' }, { node: { id: 'bad' } }] } } },
  ]);
  eq(out.map((p) => p.shopify_product_id), ['9', '8'], 'products: only addressable products survive');
  eq(out[0].variants, [], 'products: a product with no variants keeps an empty array');
  eq(out[0].price, null, 'products: NO price known is null — NOT 0, which would render as free');
  eq(out[1].variants_count, 0, 'products: every malformed variant node dropped');
}
eq(mapProductNodes(null), [], 'products: null edges → []');
eq(mapProductNodes('nope'), [], 'products: a string → []');

// ===========================================================================
// PURE — shipping zone shaping
// ===========================================================================
eq(describeCondition({ operator: 'GREATER_THAN_OR_EQUAL_TO', conditionCriteria: { __typename: 'MoneyV2', amount: '50' } }),
  'orders $50.00+', 'condition: a money floor');
eq(describeCondition({ operator: 'LESS_THAN_OR_EQUAL_TO', conditionCriteria: { __typename: 'MoneyV2', amount: '50' } }),
  'orders under $50.00', 'condition: a money ceiling');
eq(describeCondition({ operator: 'GREATER_THAN_OR_EQUAL_TO', conditionCriteria: { __typename: 'Weight', value: 2, unit: 'KILOGRAMS' } }),
  '2kilograms+', 'condition: a weight floor');
eq(describeCondition({}), '', 'condition: an unknown criterion is empty, never a throw');
eq(describeCondition(null), '', 'condition: null → "", no throw');

const ZONE_PAYLOAD = {
  deliveryProfiles: { nodes: [{
    name: 'General', default: true,
    profileLocationGroups: [{
      locationGroupZones: {
        pageInfo: { hasNextPage: false, endCursor: null },
        nodes: [
          { zone: { name: 'Domestic', countries: [{ name: 'United States', code: { countryCode: 'US', restOfWorld: false } }] },
            methodDefinitions: { nodes: [
              { active: true, name: 'Standard', rateProvider: { __typename: 'DeliveryRateDefinition', price: { amount: '4.99', currencyCode: 'USD' } }, methodConditions: [] },
              { active: true, name: 'Free over $50', rateProvider: { __typename: 'DeliveryRateDefinition', price: { amount: '0', currencyCode: 'USD' } }, methodConditions: [{ operator: 'GREATER_THAN_OR_EQUAL_TO', conditionCriteria: { __typename: 'MoneyV2', amount: '50' } }] },
              { active: false, name: 'Retired', rateProvider: { __typename: 'DeliveryRateDefinition', price: { amount: '9.99', currencyCode: 'USD' } }, methodConditions: [] },
              { active: true, name: 'Express', rateProvider: { __typename: 'DeliveryParticipant', carrierService: { formattedName: 'UPS' } }, methodConditions: [] },
            ] } },
          { zone: { name: 'International', countries: [{ name: 'Rest of world', code: { restOfWorld: true } }] }, methodDefinitions: { nodes: [] } },
        ],
      },
    }],
  }] },
};
{
  const zones = shapeZones(ZONE_PAYLOAD);
  eq(zones.length, 2, 'zones: both zones shaped');
  eq(zones[0].zone, 'Domestic', 'zones: name');
  eq(zones[0].countries, [{ code: 'US', name: 'United States' }], 'zones: countries');
  eq(zones[0].rates.length, 3, 'zones: the INACTIVE rate option is skipped');
  eq(zones[0].rates[0], { name: 'Standard', price: 4.99, currency: 'USD', carrier: '', conditions: [] }, 'zones: a flat rate');
  eq(zones[0].rates[1].conditions, ['orders $50.00+'], 'zones: rate conditions rendered');
  eq([zones[0].rates[2].carrier, zones[0].rates[2].price], ['UPS', null],
    'zones: a carrier-calculated option has NO fixed price — the address decides it');
  eq([zones[1].rest_of_world, zones[1].countries.length], [true, 0], 'zones: rest-of-world is a flag, not a fake country');
  eq(zones[1].rates, [], 'zones: a zone with no options keeps an empty rates array');
}
eq(shapeZones(null), [], 'zones: null → []');
eq(shapeZones({}), [], 'zones: an empty payload → []');
eq(shapeZones({ deliveryProfiles: { nodes: [null, 'str', { profileLocationGroups: 'nope' }] } }), [],
  'zones: malformed profiles are dropped, never thrown on');
eq(shapeZones([ZONE_PAYLOAD, ZONE_PAYLOAD]).length, 4, 'zones: multiple pages concatenate');

eq(uncoveredCountries(shapeZones(ZONE_PAYLOAD), ['US', 'BD']), [],
  'uncovered: a rest-of-world zone covers everything');
{
  const noRow = { deliveryProfiles: { nodes: [{ name: 'X', profileLocationGroups: [{ locationGroupZones: { nodes: [
    { zone: { name: 'Domestic', countries: [{ name: 'United States', code: { countryCode: 'US' } }] }, methodDefinitions: { nodes: [] } },
  ] } }] }] } };
  eq(uncoveredCountries(shapeZones(noRow), ['US', 'BD', 'GB']), ['BD', 'GB'],
    'uncovered: names exactly the allowed countries no zone covers');
  eq(uncoveredCountries(shapeZones(noRow), []), [], 'uncovered: no allow-list → nothing to report');
  eq(uncoveredCountries(null, ['US']), ['US'], 'uncovered: null zones → everything uncovered, no throw');
}

// ===========================================================================
// PURE — Whop extraction + the mapping PLAN
// ===========================================================================
eq(extractWhopProducts({ data: [{ id: 'p1', name: 'Kit' }] }), [{ id: 'p1', name: 'Kit' }], 'whop: {data:[…]} shape');
eq(extractWhopProducts({ products: [{ id: 'p2', title: 'Serum' }] }), [{ id: 'p2', name: 'Serum' }], 'whop: {products:[…]} + title alias');
eq(extractWhopProducts([{ product_id: 'p3' }]), [{ id: 'p3', name: '' }], 'whop: a bare array + product_id alias');
eq(extractWhopProducts({ data: [{ name: 'no id' }, null, 'str', { id: '  ' }] }), [],
  'whop: entries without an addressable id are dropped');
eq(extractWhopProducts(null), [], 'whop: null → []');
eq(extractWhopProducts('nope'), [], 'whop: a string → []');
eq(extractWhopProduct({ id: 'x', name: 'X' }), { id: 'x', name: 'X' }, 'whop: a bare create response');
eq(extractWhopProduct({ data: { id: 'y', name: 'Y' } }), { id: 'y', name: 'Y' }, 'whop: a {data:{…}} create response');
eq(extractWhopProduct({ data: [{ id: 'z', name: 'Z' }] }), { id: 'z', name: 'Z' }, 'whop: a {data:[{…}]} create response');
eq(extractWhopProduct({ ok: true }), null, 'whop: a create with no id → null (never a fake success)');

eq(findWhopByName('  KIT  ', [{ id: 'a', name: 'kit' }])?.id, 'a', 'match: trimmed, case-folded exact name');
eq(findWhopByName('Kit', [{ id: 'a', name: 'Kit Deluxe' }]), null, 'match: a SUBSTRING is not a match — it would link the wrong product');
eq(findWhopByName('', [{ id: 'a', name: '' }]), null, 'match: a blank name never matches');
eq(findWhopByName('Kit', null), null, 'match: a null catalog → null, no throw');

{
  const products = [
    { shopify_product_id: '1', title: 'Kit' },
    { shopify_product_id: '2', title: 'Serum' },
    { shopify_product_id: '3', title: '   ' },
    { shopify_product_id: '4', title: 'Already' },
  ];
  const existing = [
    { shopify_product_id: '4', status: 'mapped', whop_product_id: 'w9' },
    { shopify_product_id: '2', status: 'unmapped', whop_product_id: '' },
  ];
  const plan = planWhopMapping(products, existing, [{ id: 'wKit', name: 'kit' }]);
  eq(plan.already.map((p) => p.shopify_product_id), ['4'], 'plan: an already-mapped product is skipped');
  eq(plan.match.map((m) => [m.product.shopify_product_id, m.whop.id]), [['1', 'wKit']], 'plan: name match found');
  eq(plan.create.map((p) => p.shopify_product_id), ['2'], 'plan: no match → create');
  eq(plan.skipped.map((p) => p.shopify_product_id), ['3'], 'plan: a nameless product is skipped, not created blank');
  // An UNMAPPED existing row must not block a re-run.
  eq(planWhopMapping(products, [], []).create.length, 3, 'plan: with no mappings at all, every named product is a create');
}
eq(planWhopMapping(null, null, null), { already: [], match: [], create: [], skipped: [] }, 'plan: all-null → empty plan, no throw');

// ===========================================================================
// HTTP — mocked Shopify / Whop
// ===========================================================================
const realFetch = globalThis.fetch;
let fetchImpl = null;
globalThis.fetch = (...args) => fetchImpl(...args);

const jsonResponse = (payload, status = 200) => ({
  ok: status >= 200 && status < 300,
  status,
  json: async () => payload,
});

process.env.PUURE_SHOPIFY_STORE = 'test.myshopify.com';
process.env.PUURE_SHOPIFY_TOKEN = 'shpat_SECRETVALUE';
process.env.WHOP_API_BASE = 'https://whop.test/api/v1';
process.env.WHOP_API_KEY = 'whop_SECRETKEY';
process.env.WHOP_COMPANY_ID = 'biz_test';

await ensureCommerceTables();
const wipe = async () => {
  for (const f of [FUNNEL, FUNNEL_B]) {
    await pgQuery(`DELETE FROM co_funnel_products WHERE funnel_id = $1`, [f]);
    await pgQuery(`DELETE FROM co_whop_product_map WHERE funnel_id = $1`, [f]);
  }
};
await wipe();

const app = express();
app.use(express.json());
app.use('/api/v1/funnel-commerce', router);          // real router — auth intact
app.use('/stub', (req, _res, next) => { req.user = { id: req.query.as || 'u1', role: 'admin' }; next(); });
app.get('/stub/:funnelId/products', listProductsHandler);
app.post('/stub/:funnelId/products/sync', syncProductsHandler);
app.get('/stub/:funnelId/whop/mappings', listMappingsHandler);
app.put('/stub/:funnelId/whop/mappings', upsertMappingHandler);
app.post('/stub/:funnelId/whop/map', mapToWhopHandler);
app.delete('/stub/:funnelId/whop/mappings/:mappingId', deleteMappingHandler);
app.get('/stub/:funnelId/shipping/zones', shippingZonesHandler);

const server = app.listen(0);
await new Promise((r) => server.once('listening', r));
const base = `http://127.0.0.1:${server.address().port}`;

// The limiters key on req.user.id, so a block that deliberately exhausts a
// budget must do it as its OWN user — otherwise it poisons every later case in
// this file with 429s. `AS` is set at the top of each block and appended to
// every stub call automatically.
let AS = 'u_default';
const call = async (method, path, body) => {
  const sep = path.includes('?') ? '&' : '?';
  if (path.startsWith('/stub/')) path = `${path}${sep}as=${AS}`;
  const r = await realFetch(`${base}${path}`, {
    method,
    ...(body ? { headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) } : {}),
  });
  let out = null;
  try { out = await r.json(); } catch { out = null; }
  return { status: r.status, body: out };
};
const get = (p) => call('GET', p);
const post = (p, b) => call('POST', p, b);

// ---- AUTH -----------------------------------------------------------------
{
  fetchImpl = async () => { throw new Error('no upstream call may happen unauthenticated'); };
  for (const [m, p] of [['GET', '/products'], ['POST', '/products/sync'], ['GET', '/whop/mappings'], ['POST', '/whop/map'], ['GET', '/shipping/zones']]) {
    const r = await call(m, `/api/v1/funnel-commerce/${FUNNEL}${p}`);
    eq(r.status, 401, `auth: unauthenticated ${m} ${p} → 401`);
  }
  const r = await get(`/api/v1/funnel-commerce/${FUNNEL}/products`);
  ok(!JSON.stringify(r.body || {}).toLowerCase().includes('shopify'), 'auth: the refusal leaks nothing about Shopify');
}

// ---- SYNC HAPPY PATH ------------------------------------------------------
const catalogPage = (edges, hasNext = false, cursor = null) => ({
  data: { products: { pageInfo: { hasNextPage: hasNext, endCursor: cursor }, edges } },
});
const productEdge = (id, title, price) => ({
  node: {
    id: `gid://shopify/Product/${id}`, title, handle: title.toLowerCase(), status: 'ACTIVE', vendor: 'Puure',
    featuredImage: { url: `${title}.jpg` },
    variants: { edges: [
      { node: { id: `gid://shopify/ProductVariant/${id}01`, title: 'Default', price, sku: `SKU${id}`, availableForSale: true } },
      { node: { id: `gid://shopify/ProductVariant/${id}02`, title: 'Twin', price, sku: `SKU${id}B`, availableForSale: true } },
    ] },
  },
});
{
  AS = 'sync_happy';
  let seenUrl = null; let seenHeaders = null; let calls = 0;
  fetchImpl = async (url, opts) => {
    seenUrl = String(url); seenHeaders = opts.headers; calls += 1;
    // Two pages — the walker must follow the cursor or it silently truncates.
    if (calls === 1) return jsonResponse(catalogPage([productEdge('10', 'Kit', '19.00')], true, 'CUR1'));
    return jsonResponse(catalogPage([productEdge('11', 'Serum', '29.50')]));
  };
  const r = await post(`/stub/${FUNNEL}/products/sync`);
  eq(r.status, 200, 'sync: 200');
  eq(r.body?.data?.synced, 2, 'sync: BOTH pages walked (the cursor is followed)');
  eq(r.body.data.products.map((p) => p.title), ['Kit', 'Serum'], 'sync: products returned, title-ordered');
  eq(r.body.data.products[0].variants_count, 2, 'sync: variant count persisted');

  ok(!seenUrl.includes('shpat_'), 'creds: the Shopify token is NOT in the request URL', seenUrl);
  eq(seenHeaders['X-Shopify-Access-Token'], 'shpat_SECRETVALUE', 'creds: it travels in the header');
  ok(!JSON.stringify(r.body).includes('shpat_'), 'creds: and never appears in the response body');
}

// ---- jsonb ROUND TRIP — the object shape, through a REAL database ---------
{
  const r = await get(`/stub/${FUNNEL}/products`);
  const kit = r.body.data.products.find((p) => p.title === 'Kit');
  ok(Array.isArray(kit.variants), 'jsonb: variants read back as a real ARRAY (postgres.js serialized the raw object)');
  eq(kit.variants[0].variant_id, '1001', 'jsonb: variant content survived the round trip');
  // Prove the column is a jsonb ARRAY in the DB, not a jsonb string scalar —
  // pre-stringifying the param is exactly the trap this asserts against.
  const [row] = await pgQuery(
    `SELECT jsonb_typeof(variants) AS t FROM co_funnel_products WHERE funnel_id = $1 AND shopify_product_id = '10'`,
    [FUNNEL]
  );
  eq(row.t, 'array', 'jsonb: stored as a jsonb ARRAY — never double-encoded into a jsonb STRING scalar');
}

// ---- jsonb ROUND TRIP — the STRING shape, forced into the DB --------------
{
  // A row that WAS double-encoded (hand-insert / legacy writer) must still read
  // correctly through the route rather than surfacing a string to the UI.
  await pgQuery(
    `UPDATE co_funnel_products SET variants = to_jsonb($2::text) WHERE funnel_id = $1 AND shopify_product_id = '11'`,
    [FUNNEL, JSON.stringify([{ variant_id: '9', title: 'Legacy', price: '1.00', sku: '', available: true }])]
  );
  const [row] = await pgQuery(
    `SELECT jsonb_typeof(variants) AS t FROM co_funnel_products WHERE funnel_id = $1 AND shopify_product_id = '11'`,
    [FUNNEL]
  );
  eq(row.t, 'string', 'jsonb: the double-encoded row really is a jsonb STRING scalar');
  const r = await get(`/stub/${FUNNEL}/products`);
  const serum = r.body.data.products.find((p) => p.title === 'Serum');
  ok(Array.isArray(serum.variants), 'jsonb: the STRING shape still reads back as an ARRAY');
  eq(serum.variants[0].title, 'Legacy', 'jsonb: …with its content intact');
}

// ---- SHOPIFY OUTAGE — 503, never an empty catalog -------------------------
{
  const cases = [
    ['timeout (AbortError)', async () => { const e = new Error('aborted'); e.name = 'AbortError'; throw e; }, 'shopify_unavailable', true],
    ['network failure', async () => { throw new Error('ECONNREFUSED'); }, 'shopify_unavailable', true],
    ['HTTP 500', async () => jsonResponse({}, 500), 'shopify_unavailable', true],
    ['HTTP 429 throttle', async () => jsonResponse({}, 429), 'shopify_unavailable', true],
    ['unparseable body', async () => ({ ok: true, status: 200, json: async () => { throw new Error('bad json'); } }), 'shopify_unavailable', true],
    ['GraphQL errors in a 200', async () => jsonResponse({ errors: [{ message: 'throttled' }], data: { products: { edges: [] } } }), 'shopify_unavailable', true],
    ['HTTP 401 dead key', async () => jsonResponse({}, 401), 'shopify_auth_error', false],
    ['HTTP 403 dead key', async () => jsonResponse({}, 403), 'shopify_auth_error', false],
  ];
  let oi = 0;
  for (const [label, impl, code, retryable] of cases) {
    AS = `outage_${oi}`; oi += 1;
    fetchImpl = impl;
    const r = await post(`/stub/${FUNNEL}/products/sync`);
    eq(r.status, 503, `outage: ${label} → 503, never 200`);
    eq(r.body?.error?.code, code, `outage: ${label} → code ${code}`);
    eq(r.body?.error?.retryable, retryable, `outage: ${label} retryable=${retryable}`);
    ok(!Array.isArray(r.body?.data?.products), `outage: ${label} does NOT return an empty products array`);
  }
  // …and the stored snapshot is untouched by the outage.
  fetchImpl = async () => { throw new Error('unused'); };
  const after = await get(`/stub/${FUNNEL}/products`);
  eq(after.body.data.products.length, 2, 'outage: the stored snapshot survives — a blip never wipes the catalog');
}
{
  AS = 'outage_cfg';
  const store = process.env.PUURE_SHOPIFY_STORE;
  delete process.env.PUURE_SHOPIFY_STORE;
  delete process.env.SHOPIFY_STORE_DOMAIN;
  fetchImpl = async () => { throw new Error('must not reach Shopify with no credentials'); };
  const r = await post(`/stub/${FUNNEL}/products/sync`);
  eq(r.body?.error?.code, 'shopify_not_configured', 'outage: missing config has its OWN code');
  eq(r.body?.error?.retryable, false, 'outage: missing config is NOT retryable — it needs a human');
  process.env.PUURE_SHOPIFY_STORE = store;
}

// ---- ZONES ---------------------------------------------------------------
{
  fetchImpl = async () => jsonResponse({ data: ZONE_PAYLOAD });
  const r = await get(`/stub/${FUNNEL}/shipping/zones`);
  eq(r.status, 200, 'zones: 200');
  eq(r.body.data.zones.length, 2, 'zones: shaped through the route');
  eq(r.body.data.allowed_countries, [], 'zones: no funnel row → no allow-list, and no throw');
}
{
  fetchImpl = async () => jsonResponse({ errors: [{ message: 'ACCESS_DENIED: read_shipping' }] });
  const r = await get(`/stub/${FUNNEL}/shipping/zones`);
  eq(r.status, 503, 'zones: an ACCESS_DENIED is 503, not an empty zone list');
  eq(r.body?.error?.hint, 'missing_read_shipping_scope', 'zones: …with the actionable scope hint');
  ok(!Array.isArray(r.body?.data?.zones), 'zones: an outage NEVER returns zones:[] ("you ship nowhere")');
}
{
  fetchImpl = async () => jsonResponse({}, 502);
  const r = await get(`/stub/${FUNNEL}/shipping/zones`);
  eq(r.status, 503, 'zones: a 502 upstream is a 503 outage');
  eq(r.body?.error?.retryable, true, 'zones: …and IS retryable');
}

// ---- WHOP: create-when-missing -------------------------------------------
const whopState = { products: [], created: [], seenAuth: [], seenUrls: [] };
function whopRouter(url, opts) {
  whopState.seenUrls.push(String(url));
  whopState.seenAuth.push(opts?.headers?.Authorization || '');
  if ((opts?.method || 'GET') === 'GET') return jsonResponse({ data: whopState.products });
  const body = JSON.parse(opts.body);
  const made = { id: `wp_${whopState.created.length + 1}`, name: body.name };
  whopState.created.push(body);
  whopState.products.push(made);
  return jsonResponse({ data: made });
}
{
  AS = 'map_main';
  // Restore the two-product snapshot, then map.
  fetchImpl = async (url, opts) => {
    if (String(url).includes('myshopify')) {
      return jsonResponse(catalogPage([productEdge('10', 'Kit', '19.00'), productEdge('11', 'Serum', '29.50')]));
    }
    return whopRouter(url, opts);
  };
  await post(`/stub/${FUNNEL}/products/sync`);

  whopState.products = [{ id: 'wKit', name: 'kit' }]; // one pre-existing, name differs only in case
  const r = await post(`/stub/${FUNNEL}/whop/map`);
  eq(r.status, 200, 'whop map: 200');
  eq(r.body.data.matched, 1, 'whop map: the existing Whop product is MATCHED, not duplicated');
  eq(r.body.data.created, 1, 'whop map: the missing one is CREATED');
  eq(whopState.created.map((c) => c.name), ['Serum'], 'whop map: created with the SHOPIFY name');
  eq(whopState.created[0].company_id, 'biz_test', 'whop map: scoped to the company id');
  ok(!Object.prototype.hasOwnProperty.call(whopState.created[0], 'price'),
    'whop map: no price is sent — Whop prices live on PLANS, not products');
  ok(whopState.seenAuth.every((a) => a === 'Bearer whop_SECRETKEY'), 'creds: the Whop key travels in the Authorization header');
  ok(whopState.seenUrls.every((u) => !u.includes('whop_SECRETKEY')), 'creds: and never in a URL');
  eq(r.body.data.mapped_count, 2, 'whop map: both products end up mapped');

  // Sorted — the row order is `updated_at DESC`, which is not a contract.
  const sources = r.body.data.mappings
    .map((m) => `${m.shopify_title}=${m.source}`).sort();
  eq(sources, ['Kit=matched', 'Serum=created'], 'whop map: each row records HOW it was mapped');

  // IDEMPOTENCE: a second run creates nothing and duplicates nothing.
  const before = whopState.created.length;
  const r2 = await post(`/stub/${FUNNEL}/whop/map`);
  eq(r2.body.data.already, 2, 'whop map: a re-run reports both as already mapped');
  eq(whopState.created.length, before, 'whop map: …and mints NOTHING new');
  eq(r2.body.data.mappings.length, 2, 'whop map: still exactly two mapping rows (the unique key holds)');
}
{
  AS = 'map_nameless';
  // A nameless product is skipped, never created blank.
  await pgQuery(
    `INSERT INTO co_funnel_products (funnel_id, shopify_product_id, title, variants)
     VALUES ($1, '99', '   ', '[]'::jsonb)
     ON CONFLICT (funnel_id, shopify_product_id) DO UPDATE SET title = '   '`,
    [FUNNEL]
  );
  const before = whopState.created.length;
  const r = await post(`/stub/${FUNNEL}/whop/map`);
  eq(r.body.data.skipped, 1, 'whop map: the nameless product is SKIPPED');
  eq(whopState.created.length, before, 'whop map: …and no blank Whop product is minted');
  await pgQuery(`DELETE FROM co_funnel_products WHERE funnel_id = $1 AND shopify_product_id = '99'`, [FUNNEL]);
}

// ---- WHOP OUTAGE — no creates on a blip ----------------------------------
{
  await pgQuery(`DELETE FROM co_whop_product_map WHERE funnel_id = $1`, [FUNNEL]);
  const cases = [
    ['list 500', async () => jsonResponse({}, 500), 'whop_unavailable', true],
    ['list 401', async () => jsonResponse({}, 401), 'whop_auth_error', false],
    ['list transport failure', async () => { throw new Error('ECONNRESET'); }, 'whop_unavailable', true],
  ];
  let wi = 0;
  for (const [label, impl, code, retryable] of cases) {
    AS = `whop_outage_${wi}`; wi += 1;
    const before = whopState.created.length;
    fetchImpl = async (url, opts) => (String(url).includes('myshopify') ? jsonResponse(catalogPage([])) : impl(url, opts));
    const r = await post(`/stub/${FUNNEL}/whop/map`);
    eq(r.status, 503, `whop outage: ${label} → 503`);
    eq(r.body?.error?.code, code, `whop outage: ${label} → ${code}`);
    eq(r.body?.error?.retryable, retryable, `whop outage: ${label} retryable=${retryable}`);
    eq(whopState.created.length, before, `whop outage: ${label} creates NOTHING (a blip must not mint duplicates)`);
  }
  const [{ count }] = await pgQuery(`SELECT COUNT(*)::int AS count FROM co_whop_product_map WHERE funnel_id = $1`, [FUNNEL]);
  eq(count, 0, 'whop outage: and writes no mapping rows at all');
}
{
  AS = 'map_ghost';
  // A create that answers 2xx with no addressable id is NOT a success.
  fetchImpl = async (url, opts) => {
    if (String(url).includes('myshopify')) return jsonResponse(catalogPage([productEdge('12', 'Ghost', '5.00')]));
    if ((opts?.method || 'GET') === 'GET') return jsonResponse({ data: [] });
    return jsonResponse({ ok: true });     // no id
  };
  await post(`/stub/${FUNNEL_B}/products/sync`);
  const r = await post(`/stub/${FUNNEL_B}/whop/map`);
  eq(r.status, 200, 'whop create: a per-product failure does not fail the whole run');
  eq(r.body.data.created, 0, 'whop create: an id-less 2xx counts as 0 created');
  eq(r.body.data.failed.length, 1, 'whop create: …and is REPORTED as failed, never silently swallowed');
  eq(r.body.data.mapped_count, 0, 'whop create: no mapping row was written for it');
}
{
  AS = 'map_none';
  // No products at all is a 400 with an actionable code, not a fake success.
  await pgQuery(`DELETE FROM co_funnel_products WHERE funnel_id = $1`, [FUNNEL_B]);
  fetchImpl = async () => { throw new Error('must not call any upstream with no products'); };
  const r = await post(`/stub/${FUNNEL_B}/whop/map`);
  eq(r.status, 400, 'whop map: no synced products → 400');
  eq(r.body?.error?.code, 'no_products', 'whop map: …with code no_products');
}
{
  AS = 'map_nocreds';
  // Missing Whop credentials read as configuration, not an outage.
  const key = process.env.WHOP_API_KEY;
  delete process.env.WHOP_API_KEY;
  fetchImpl = async (url) => (String(url).includes('myshopify') ? jsonResponse(catalogPage([productEdge('13', 'Solo', '1.00')])) : jsonResponse({ data: [] }));
  await post(`/stub/${FUNNEL_B}/products/sync`);
  const r = await post(`/stub/${FUNNEL_B}/whop/map`);
  eq(r.body?.error?.code, 'whop_not_configured', 'whop map: no API key → whop_not_configured');
  eq(r.body?.error?.retryable, false, 'whop map: …and it is not retryable');
  process.env.WHOP_API_KEY = key;
}

// ---- WHOP service units (direct) ------------------------------------------
{
  fetchImpl = async () => jsonResponse({ data: [] });
  let threw = null;
  try { await listWhopProducts({ api_key: '', company_id: 'x' }); } catch (e) { threw = e; }
  ok(threw instanceof WhopUnavailableError && threw.code === 'whop_not_configured',
    'whop service: a missing key THROWS rather than returning an empty catalog');

  threw = null;
  try { await createWhopProduct({ api_key: 'k', company_id: 'c' }, { name: '   ' }); } catch (e) { threw = e; }
  eq(threw?.code, 'whop_invalid_name', 'whop service: creating a blank-named product is refused up front');
}

// ---- MANUAL MAPPING CRUD --------------------------------------------------
{
  AS = 'crud';
  fetchImpl = async (url, opts) => (String(url).includes('myshopify')
    ? jsonResponse(catalogPage([productEdge('10', 'Kit', '19.00')]))
    : whopRouter(url, opts));
  await post(`/stub/${FUNNEL}/products/sync`);

  const up = await call('PUT', `/stub/${FUNNEL}/whop/mappings`, {
    shopify_product_id: '10', shopify_title: 'Kit', whop_product_id: 'wManual', whop_product_name: 'Manual target',
  });
  eq(up.status, 200, 'mapping PUT: 200');
  eq(up.body.data.mapping.status, 'mapped', 'mapping PUT: a link sets status mapped');
  eq(up.body.data.mapping.source, 'linked', 'mapping PUT: source records the hand link');

  const cleared = await call('PUT', `/stub/${FUNNEL}/whop/mappings`, { shopify_product_id: '10', whop_product_id: '' });
  eq(cleared.body.data.mapping.status, 'unmapped', 'mapping PUT: an empty whop id clears the link');

  const bad = await call('PUT', `/stub/${FUNNEL}/whop/mappings`, { whop_product_id: 'w' });
  eq(bad.status, 400, 'mapping PUT: a missing shopify_product_id → 400');
  eq(bad.body?.error?.code, 'product_required', 'mapping PUT: …with code product_required');

  const id = up.body.data.mapping.id;
  const del = await call('DELETE', `/stub/${FUNNEL}/whop/mappings/${id}`);
  eq(del.status, 200, 'mapping DELETE: 200');
  const del2 = await call('DELETE', `/stub/${FUNNEL}/whop/mappings/${id}`);
  eq(del2.status, 404, 'mapping DELETE: deleting it twice is a 404, not a silent success');
  const other = await call('DELETE', `/stub/${FUNNEL_B}/whop/mappings/${id}`);
  eq(other.status, 404, 'mapping DELETE: a mapping cannot be deleted through ANOTHER funnel id');
}

// ---- FUNNEL-SCOPING + settings-driven allow-list --------------------------
{
  AS = 'zones_cfg';
  await pgQuery(
    `CREATE TABLE IF NOT EXISTS funnels (
       id TEXT PRIMARY KEY, slug TEXT NOT NULL, name TEXT NOT NULL,
       status TEXT NOT NULL DEFAULT 'draft', archived BOOLEAN NOT NULL DEFAULT FALSE,
       custom_domain TEXT, default_page_id TEXT, seo JSONB DEFAULT '{}',
       flow_layout JSONB DEFAULT '{"nodes":[],"edges":[]}', misc JSONB DEFAULT '{}',
       created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(), updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW())`
  );
  await pgQuery(`ALTER TABLE funnels ADD COLUMN IF NOT EXISTS settings JSONB DEFAULT '{}'`);
  await pgQuery(`DELETE FROM funnels WHERE id = $1`, [FUNNEL]);
  await pgQuery(
    `INSERT INTO funnels (id, slug, name, settings) VALUES ($1, $2, $3, $4)`,
    // Raw object — postgres.js serializes the jsonb param itself.
    [FUNNEL, `slug-${FUNNEL}`, 'Commerce test', { commerce: { restrict_countries: true, allowed_countries: ['us', 'bd'] } }]
  );

  fetchImpl = async () => jsonResponse({
    data: { deliveryProfiles: { nodes: [{ name: 'G', profileLocationGroups: [{ locationGroupZones: { nodes: [
      { zone: { name: 'Domestic', countries: [{ name: 'United States', code: { countryCode: 'US' } }] }, methodDefinitions: { nodes: [] } },
    ] } }] }] } },
  });
  const r = await get(`/stub/${FUNNEL}/shipping/zones`);
  eq(r.body.data.allowed_countries, ['US', 'BD'], 'zones: the funnel settings allow-list is read + normalized');
  eq(r.body.data.uncovered_countries, ['BD'], 'zones: an allowed country with no zone is named');

  const other = await get(`/stub/${FUNNEL_B}/products`);
  ok(other.body.data.products.every((p) => p.title !== 'Kit'),
    'scoping: one funnel never sees another funnel\'s synced products');
}

// ---- RATE LIMITING --------------------------------------------------------
{
  AS = 'rl_sync_user';
  let limited = null;
  let calls = 0;
  fetchImpl = async () => { calls += 1; return jsonResponse(catalogPage([])); };
  for (let i = 0; i < SYNC_RATE_MAX + 4; i += 1) {
    const r = await post(`/stub/${FUNNEL_B}/products/sync`);
    if (r.status === 429) { limited = r; break; }
  }
  ok(limited !== null, 'rate limit: hammering sync eventually returns 429');
  if (limited) {
    eq(limited.body?.error?.code, 'rate_limited', 'rate limit: with code rate_limited');
    ok(calls <= SYNC_RATE_MAX, 'rate limit: and Shopify was called at most the cap — live pricing keeps its budget', `calls=${calls}`);
  }
}

// ---- the 8s timeout is actually armed -------------------------------------
{
  AS = 'timeout_user';
  eq(FETCH_TIMEOUT_MS, 8000, 'timeout: the budget is 8s as specified');
  let sawSignal = false; let aborted = false;
  fetchImpl = async (_url, opts) => {
    sawSignal = !!opts.signal;
    return new Promise((_res, rej) => {
      opts.signal.addEventListener('abort', () => {
        aborted = true;
        const e = new Error('aborted'); e.name = 'AbortError'; rej(e);
      });
      setTimeout(() => opts.signal.dispatchEvent(new Event('abort')), 5);
    });
  };
  const r = await get(`/stub/${FUNNEL}/shipping/zones`);
  ok(sawSignal, 'timeout: an AbortSignal is passed to fetch');
  ok(aborted, 'timeout: the abort path fires');
  eq(r.status, 503, 'timeout: an aborted request answers 503, never a hang or a 200');
}

// ---- cleanup --------------------------------------------------------------
await wipe();
await pgQuery(`DELETE FROM funnels WHERE id = $1`, [FUNNEL]);
server.close();
globalThis.fetch = realFetch;
console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
