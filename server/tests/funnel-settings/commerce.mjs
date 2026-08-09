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
  readCostStatus, throttleDelayMs, pendingZoneCursors,
  SYNC_RATE_MAX, FETCH_TIMEOUT_MS, PRODUCT_MAX_PAGES, PRODUCT_PAGE_SIZE, VARIANT_PAGE_SIZE,
} = route;

const whop = await import('../../src/services/whopProducts.js');
const {
  extractWhopProducts, extractWhopProduct, findWhopByName, planWhopMapping,
  listWhopProducts, createWhopProduct, WhopUnavailableError,
  rawWhopList, WHOP_PAGE_SIZE,
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

// REGRESSION (review #6). ZONE_PAYLOAD's rest-of-world zone has ZERO rate
// options — Shopify holds zones like that happily, and a buyer in one gets no
// shipping option and cannot check out. The first cut treated ANY rest-of-world
// zone as blanket coverage and returned a clean bill of health for a store that
// could not ship to BD at all. The old fixture asserted that wrong behaviour.
eq(uncoveredCountries(shapeZones(ZONE_PAYLOAD), ['US', 'BD']), ['BD'],
  'uncovered: a rest-of-world zone with NO rate options covers NOTHING');
{
  // …and one WITH a rate option really does cover everything.
  const rowShips = JSON.parse(JSON.stringify(ZONE_PAYLOAD));
  rowShips.deliveryProfiles.nodes[0].profileLocationGroups[0].locationGroupZones.nodes[1]
    .methodDefinitions.nodes = [{
      active: true, name: 'Intl', rateProvider: { __typename: 'DeliveryRateDefinition', price: { amount: '12.00', currencyCode: 'USD' } }, methodConditions: [],
    }];
  eq(uncoveredCountries(shapeZones(rowShips), ['US', 'BD']), [],
    'uncovered: a rest-of-world zone WITH a rate option does cover everything');
}
{
  const noRates = { deliveryProfiles: { nodes: [{ name: 'X', profileLocationGroups: [{ locationGroupZones: { nodes: [
    { zone: { name: 'Domestic', countries: [{ name: 'United States', code: { countryCode: 'US' } }] }, methodDefinitions: { nodes: [] } },
  ] } }] }] } };
  eq(uncoveredCountries(shapeZones(noRates), ['US', 'BD', 'GB']), ['US', 'BD', 'GB'],
    'uncovered: a named zone with no rate options does not cover its own countries either');
  const withRates = { deliveryProfiles: { nodes: [{ name: 'X', profileLocationGroups: [{ locationGroupZones: { nodes: [
    { zone: { name: 'Domestic', countries: [{ name: 'United States', code: { countryCode: 'US' } }] },
      methodDefinitions: { nodes: [{ active: true, name: 'Std', rateProvider: { __typename: 'DeliveryRateDefinition', price: { amount: '5', currencyCode: 'USD' } }, methodConditions: [] }] } },
  ] } }] }] } };
  eq(uncoveredCountries(shapeZones(withRates), ['US', 'BD', 'GB']), ['BD', 'GB'],
    'uncovered: names exactly the allowed countries no shipping zone covers');
  eq(uncoveredCountries(shapeZones(withRates), []), [], 'uncovered: no allow-list → nothing to report');
  eq(uncoveredCountries(null, ['US']), ['US'], 'uncovered: null zones → everything uncovered, no throw');
}

// REGRESSION (review #5). Number(null) is 0 and Number('') is 0 — coercing an
// ABSENT amount produced price 0, which the UI rendered as "FREE". An unknown
// shipping charge must never be advertised as no charge.
{
  const mk = (provider) => ({ deliveryProfiles: { nodes: [{ name: 'P', profileLocationGroups: [{ locationGroupZones: { nodes: [
    { zone: { name: 'Z', countries: [] }, methodDefinitions: { nodes: [{ active: true, name: 'R', rateProvider: provider, methodConditions: [] }] } },
  ] } }] }] } });
  eq(shapeZones(mk({ __typename: 'DeliveryRateDefinition', price: { amount: null, currencyCode: 'USD' } }))[0].rates[0].price,
    null, 'zone price: a NULL amount stays null — NOT 0, which renders as FREE');
  eq(shapeZones(mk({ __typename: 'DeliveryRateDefinition', price: { amount: '', currencyCode: 'USD' } }))[0].rates[0].price,
    null, 'zone price: an EMPTY amount stays null');
  eq(shapeZones(mk({ __typename: 'DeliveryRateDefinition', price: {} }))[0].rates[0].price,
    null, 'zone price: a missing amount stays null');
  eq(shapeZones(mk({ __typename: 'DeliveryRateDefinition', price: { amount: '0.00', currencyCode: 'USD' } }))[0].rates[0].price,
    0, 'zone price: a REAL zero is still 0 — genuinely free shipping must stay readable as FREE');
  const unknown = shapeZones(mk({ __typename: 'DeliverySomethingNew' }))[0].rates[0];
  eq([unknown.price, unknown.carrier], [null, ''],
    'zone price: an UNKNOWN rateProvider kind yields null price and no carrier — the client must show "unavailable", never FREE');
}

// ── cost + throttle units (review #8) ──
eq(readCostStatus({ cost: { requestedQueryCost: 702, actualQueryCost: 690, throttleStatus: { maximumAvailable: 2000, currentlyAvailable: 1310, restoreRate: 100 } } }),
  { requested: 702, actual: 690, available: 1310, maximum: 2000, restoreRate: 100 },
  'cost: extensions.cost.throttleStatus is read');
eq(readCostStatus(null), { requested: null, actual: null, available: null, maximum: null, restoreRate: null },
  'cost: absent extensions read as UNKNOWN (nulls), never as zero budget');
eq(throttleDelayMs(readCostStatus(null), 700), 0,
  'throttle: unknown cost never stalls the walk — a proxy that strips extensions must not break sync');
eq(throttleDelayMs({ available: 1500, restoreRate: 100 }, 700), 0,
  'throttle: a healthy bucket does not wait');
ok(throttleDelayMs({ available: 50, restoreRate: 100 }, 700) > 0,
  'throttle: a nearly drained bucket waits');
ok(throttleDelayMs({ available: 0, restoreRate: 1 }, 700) <= 5000,
  'throttle: the wait is capped — a pathological reading cannot park a request for minutes');
eq(throttleDelayMs({ available: 10, restoreRate: 0 }, 700), 0,
  'throttle: a zero restore rate cannot produce an infinite wait');

// ── zone cursor units (review #7) ──
eq(pendingZoneCursors(ZONE_PAYLOAD), [], 'zone cursors: a finished page has none');
eq(pendingZoneCursors({ deliveryProfiles: { nodes: [
  { profileLocationGroups: [{ locationGroupZones: { pageInfo: { hasNextPage: true, endCursor: 'A' }, nodes: [] } }] },
  { profileLocationGroups: [{ locationGroupZones: { pageInfo: { hasNextPage: true, endCursor: 'B' }, nodes: [] } }] },
] } }), ['A', 'B'],
'zone cursors: TWO profiles still paging are BOTH reported — one shared $zonesAfter cannot advance both');
eq(pendingZoneCursors({ deliveryProfiles: { nodes: [{ profileLocationGroups: [{ locationGroupZones: { pageInfo: { hasNextPage: true } } }] }] } }), [],
  'zone cursors: hasNextPage with no cursor is not a usable cursor');
eq(pendingZoneCursors(null), [], 'zone cursors: null → [], no throw');

// ===========================================================================
// PURE — Whop extraction + the mapping PLAN
// ===========================================================================
eq(rawWhopList({ data: [1, 2, 3] }), [1, 2, 3], 'whop raw: {data:[…]} unwrapped');
eq(rawWhopList({ products: [1] }), [1], 'whop raw: {products:[…]} unwrapped');
eq(rawWhopList([1, 2]), [1, 2], 'whop raw: a bare array passes through');
eq(rawWhopList(null), [], 'whop raw: null → []');
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

// The funnels table + rows. Both handlers that spend upstream quota now REFUSE
// an unknown funnel id (review #9 — an unknown id used to fall through to the
// PLATFORM env Whop credentials and mint real company products), so the fixture
// funnels have to exist.
await pgQuery(
  `CREATE TABLE IF NOT EXISTS funnels (
     id TEXT PRIMARY KEY, slug TEXT NOT NULL, name TEXT NOT NULL,
     status TEXT NOT NULL DEFAULT 'draft', archived BOOLEAN NOT NULL DEFAULT FALSE,
     custom_domain TEXT, default_page_id TEXT, seo JSONB DEFAULT '{}',
     flow_layout JSONB DEFAULT '{"nodes":[],"edges":[]}', misc JSONB DEFAULT '{}',
     created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(), updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW())`
);
await pgQuery(`ALTER TABLE funnels ADD COLUMN IF NOT EXISTS settings JSONB DEFAULT '{}'`);
const seedFunnel = async (id, settings = {}) => {
  await pgQuery(
    `INSERT INTO funnels (id, slug, name, settings) VALUES ($1, $2, $3, $4)
     ON CONFLICT (id) DO UPDATE SET settings = EXCLUDED.settings`,
    // Raw object — postgres.js serializes the jsonb param itself.
    [id, `slug-${id}`, `Commerce test ${id}`, settings]
  );
};

const wipe = async () => {
  for (const f of [FUNNEL, FUNNEL_B]) {
    await pgQuery(`DELETE FROM co_funnel_products WHERE funnel_id = $1`, [f]);
    await pgQuery(`DELETE FROM co_whop_product_map WHERE funnel_id = $1`, [f]);
  }
};
await wipe();
await seedFunnel(FUNNEL);
await seedFunnel(FUNNEL_B);

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

const call = async (method, path, body) => {
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

// The limiter now keys on SHOP + FUNNEL, not on the user (review #8 — a
// per-user budget multiplied the allowance by the number of admins hitting one
// shared Shopify bucket). So a block that deliberately exhausts a budget must
// isolate itself by SHOP, or it poisons every later case with 429s. Every mock
// matches on the substring 'myshopify', so changing the subdomain is inert to
// the fixtures and changes only the limiter key.
let shopSeq = 0;
const isolate = () => { shopSeq += 1; process.env.PUURE_SHOPIFY_STORE = `t${shopSeq}.myshopify.com`; };

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
  isolate();
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
  eq(r.body.data.truncated, false, 'sync: a walk that reached the end is NOT truncated');
  eq(r.body.data.truncated_reason, '', 'sync: …and carries no reason');

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

// ===========================================================================
// PRUNE — the destructive path (review #1, BLOCKER)
//
// The prune deletes every row NOT in the set the walk fetched. That is only
// sound if the walk IS the catalog. Three inputs used to return 200 while
// deleting live rows, because every early exit looked exactly like a finished
// walk. Each is reproduced here.
// ===========================================================================
const seedThree = async () => {
  await pgQuery(`DELETE FROM co_funnel_products WHERE funnel_id = $1`, [FUNNEL_B]);
  await pgQuery(`DELETE FROM co_whop_product_map WHERE funnel_id = $1`, [FUNNEL_B]);
  for (const [id, title] of [['1', 'One'], ['2', 'Two'], ['3', 'Three']]) {
    await pgQuery(
      `INSERT INTO co_funnel_products (funnel_id, shopify_product_id, title, variants)
       VALUES ($1, $2, $3, '[]'::jsonb)`,
      [FUNNEL_B, id, title]
    );
  }
};
const countB = async () => {
  const [row] = await pgQuery(`SELECT COUNT(*)::int AS n FROM co_funnel_products WHERE funnel_id = $1`, [FUNNEL_B]);
  return row.n;
};

// ── input A: hasNextPage TRUE with a NULL cursor ──
{
  isolate();
  await seedThree();
  fetchImpl = async () => jsonResponse(catalogPage([productEdge('1', 'One', '1.00')], true, null));
  const r = await post(`/stub/${FUNNEL_B}/products/sync`);
  eq(r.status, 200, 'prune A: hasNextPage:true + endCursor:null still answers 200');
  eq(r.body.data.truncated, true, 'prune A: …but the walk is flagged TRUNCATED');
  eq(r.body.data.truncated_reason, 'cursor_missing', 'prune A: …with the reason that stopped it');
  eq(r.body.data.removed, 0, 'prune A: NOTHING is pruned on an unprovable walk');
  eq(await countB(), 3, 'prune A: all three live rows survive (this used to delete 2 of 3)');
}

// ── input B: a 200 whose body carries no products connection ──
{
  isolate();
  await seedThree();
  for (const [label, payload] of [
    ['no data at all', {}],
    ['data without products', { data: {} }],
    ['products without edges', { data: { products: { pageInfo: {} } } }],
    ['products edges not an array', { data: { products: { edges: 'nope' } } }],
  ]) {
    fetchImpl = async () => jsonResponse(payload);
    const r = await post(`/stub/${FUNNEL_B}/products/sync`);
    eq(r.status, 503, `prune B: a 200 with ${label} is an OUTAGE, not an empty catalog`);
    eq(r.body?.error?.code, 'shopify_unavailable', `prune B: ${label} → shopify_unavailable`);
    eq(await countB(), 3, `prune B: ${label} deletes NOTHING (this used to wipe the whole snapshot)`);
  }
}

// ── input C: a catalog larger than the page cap ──
{
  isolate();
  await seedThree();
  let page = 0;
  fetchImpl = async () => {
    page += 1;
    // Never says "done" — every page reports another one after it.
    return jsonResponse(catalogPage([productEdge(`90${page}`, `Deep ${page}`, '1.00')], true, `CUR${page}`));
  };
  const r = await post(`/stub/${FUNNEL_B}/products/sync`);
  eq(r.status, 200, 'prune C: an over-long catalog answers 200');
  eq(page, PRODUCT_MAX_PAGES, `prune C: the walk stops at the ${PRODUCT_MAX_PAGES}-page cap`);
  eq(r.body.data.truncated, true, 'prune C: …and says so');
  eq(r.body.data.truncated_reason, 'page_cap', 'prune C: …with reason page_cap');
  eq(r.body.data.removed, 0, 'prune C: nothing past the cap is deleted (this used to delete everything after #1000)');
  ok((await countB()) >= 3, 'prune C: the pre-existing rows are still there');
}

// ── the prune DOES run on a provably complete walk ──
{
  isolate();
  await seedThree();
  // Give product '2' a Whop mapping so the orphan cleanup is observable.
  await pgQuery(
    `INSERT INTO co_whop_product_map (id, funnel_id, shopify_product_id, shopify_title, whop_product_id, whop_product_name, source, status)
     VALUES ('wpm_test_orphan', $1, '2', 'Two', 'w2', 'Two', 'linked', 'mapped')`,
    [FUNNEL_B]
  );
  fetchImpl = async () => jsonResponse(catalogPage([productEdge('1', 'One', '1.00')]));
  const r = await post(`/stub/${FUNNEL_B}/products/sync`);
  eq(r.body.data.truncated, false, 'prune D: a walk that reached the end is complete');
  eq(r.body.data.removed, 2, 'prune D: …and the two products Shopify no longer has ARE pruned');
  eq(await countB(), 1, 'prune D: one row left');
  const [{ n }] = await pgQuery(
    `SELECT COUNT(*)::int AS n FROM co_whop_product_map WHERE funnel_id = $1 AND shopify_product_id = '2'`,
    [FUNNEL_B]
  );
  eq(n, 0, 'prune D: the pruned product\'s Whop mapping is cleaned up too — it can no longer inflate mapped_count');
}

// ---- FUNNEL MUST EXIST before any upstream spend (review #9) --------------
{
  isolate();
  fetchImpl = async () => { throw new Error('no upstream call may happen for an unknown funnel'); };
  const s = await post('/stub/test_fc_does_not_exist/products/sync');
  eq(s.status, 404, 'funnel gate: sync on an unknown funnel → 404');
  eq(s.body?.error?.code, 'funnel_not_found', 'funnel gate: …with code funnel_not_found');
  const m = await post('/stub/test_fc_does_not_exist/whop/map');
  eq(m.status, 404, 'funnel gate: whop map on an unknown funnel → 404, BEFORE any Whop write');
  eq(m.body?.error?.code, 'funnel_not_found', 'funnel gate: …with code funnel_not_found');
  const e = await post('/stub/ /products/sync');
  eq(e.status, 400, 'funnel gate: a blank funnel id → 400');
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
  for (const [label, impl, code, retryable] of cases) {
    isolate();
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
  isolate();
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
  isolate();
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
  eq([r.body.data.planned_match, r.body.data.planned_create], [1, 1],
    'whop map: PLAN TOTALS are reported so the client can detect a shortfall');
}

// ---- CONCURRENCY — two simultaneous maps must not double-create (review #3)
{
  isolate();
  await pgQuery(`DELETE FROM co_whop_product_map WHERE funnel_id = $1`, [FUNNEL]);
  whopState.products = [];
  whopState.created = [];
  // Slow the Whop LIST so the two requests' plan phases genuinely overlap —
  // without the lock both would read "Kit and Serum are unmapped" and both
  // would create them.
  fetchImpl = async (url, opts) => {
    if (String(url).includes('myshopify')) {
      return jsonResponse(catalogPage([productEdge('10', 'Kit', '19.00'), productEdge('11', 'Serum', '29.50')]));
    }
    if ((opts?.method || 'GET') === 'GET') {
      await new Promise((r) => { const t = setTimeout(r, 120); if (t.unref) t.unref(); });
    }
    return whopRouter(url, opts);
  };
  await post(`/stub/${FUNNEL}/products/sync`);

  const [a, b] = await Promise.all([
    post(`/stub/${FUNNEL}/whop/map`),
    post(`/stub/${FUNNEL}/whop/map`),
  ]);
  const statuses = [a.status, b.status].sort();
  eq(statuses, [200, 409], 'concurrency: of two simultaneous maps, exactly ONE runs and the other is refused 409');
  const refused = a.status === 409 ? a : b;
  eq(refused.body?.error?.code, 'map_in_progress', 'concurrency: …with code map_in_progress');
  eq(whopState.created.length, 2, 'concurrency: exactly TWO live Whop products were created, not four');
  eq(whopState.created.map((c) => c.name).sort(), ['Kit', 'Serum'], 'concurrency: …one per Shopify product');
  const [{ n }] = await pgQuery(
    `SELECT COUNT(*)::int AS n FROM co_whop_product_map WHERE funnel_id = $1`, [FUNNEL]
  );
  eq(n, 2, 'concurrency: and exactly two mapping rows exist');

  // The lock must be RELEASED — a session lock left on a pooled connection
  // would wedge every later run on this funnel.
  const after = await post(`/stub/${FUNNEL}/whop/map`);
  eq(after.status, 200, 'concurrency: the advisory lock is released, so the next run proceeds');
}

// ---- WHOP PAGING — decided on the RAW page length (review #2) -------------
{
  isolate();
  // A FULL page that contains one id-less row: 50 raw, 49 usable. Deciding
  // paging on the filtered count read "49 < 50 → last page", stopped the walk,
  // and made everything on page 2 look absent — so the mapper created a
  // DUPLICATE of a product that already existed.
  const pageOne = [
    ...Array.from({ length: WHOP_PAGE_SIZE - 1 }, (_, i) => ({ id: `w${i}`, name: `Filler ${i}` })),
    { name: 'no id at all' },
  ];
  const pageTwo = [{ id: 'wLate', name: 'Serum' }];
  let seenPages = 0;
  fetchImpl = async (url) => {
    const page = Number(new URL(String(url)).searchParams.get('page'));
    seenPages = Math.max(seenPages, page);
    return jsonResponse({ data: page === 1 ? pageOne : pageTwo });
  };
  const cat = await listWhopProducts({ api_key: 'k', company_id: 'c' });
  eq(seenPages, 2, 'whop paging: a FULL raw page keeps paging even when a row was dropped');
  eq(cat.dropped, 1, 'whop paging: the dropped row is counted separately, not hidden');
  eq(cat.complete, true, 'whop paging: the walk reached the last page');
  ok(cat.products.some((p) => p.name === 'Serum'),
    'whop paging: the page-2 product IS found — so the mapper matches it instead of creating a duplicate');
  eq(findWhopByName('Serum', cat.products)?.id, 'wLate', 'whop paging: …and it is the right one');
}
{
  isolate();
  // A catalog that never ends: the walk hits its page cap and reports
  // INCOMPLETE. An incomplete catalog cannot prove a name is absent.
  fetchImpl = async () => jsonResponse({
    data: Array.from({ length: WHOP_PAGE_SIZE }, (_, i) => ({ id: `x${i}`, name: `X${i}` })),
  });
  const cat = await listWhopProducts({ api_key: 'k', company_id: 'c' });
  eq(cat.complete, false, 'whop paging: a walk that never sees a short page is INCOMPLETE');

  // …and the route refuses to create against it.
  await pgQuery(`DELETE FROM co_whop_product_map WHERE funnel_id = $1`, [FUNNEL]);
  const createsBefore = whopState.created.length;
  fetchImpl = async (url, opts) => {
    if (String(url).includes('myshopify')) return jsonResponse(catalogPage([productEdge('10', 'Kit', '19.00')]));
    if ((opts?.method || 'GET') === 'GET') {
      return jsonResponse({ data: Array.from({ length: WHOP_PAGE_SIZE }, (_, i) => ({ id: `x${i}`, name: `X${i}` })) });
    }
    return whopRouter(url, opts);
  };
  await post(`/stub/${FUNNEL}/products/sync`);
  const r = await post(`/stub/${FUNNEL}/whop/map`);
  eq(r.status, 503, 'whop paging: mapping against an INCOMPLETE catalog is refused 503');
  eq(r.body?.error?.code, 'whop_catalog_incomplete', 'whop paging: …with code whop_catalog_incomplete');
  eq(whopState.created.length, createsBefore, 'whop paging: …and nothing was created');
}
{
  isolate();
  // A nameless product is skipped, never created blank.
  fetchImpl = async (url, opts) => (String(url).includes('myshopify')
    ? jsonResponse(catalogPage([productEdge('10', 'Kit', '19.00')]))
    : whopRouter(url, opts));
  whopState.products = [{ id: 'wKit2', name: 'Kit' }];
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
  for (const [label, impl, code, retryable] of cases) {
    isolate();
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
  isolate();
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
  eq(r.body.data.failed[0].code, 'whop_create_no_id',
    'whop create: …under a PER-ROW code, not the shop-wide outage code that would abandon the batch');
  eq(r.body.data.mapped_count, 0, 'whop create: no mapping row was written for it');
}

// ---- BATCH OF 5 — one failure must not abandon the other four (review #4) --
{
  isolate();
  await pgQuery(`DELETE FROM co_funnel_products WHERE funnel_id = $1`, [FUNNEL_B]);
  await pgQuery(`DELETE FROM co_whop_product_map WHERE funnel_id = $1`, [FUNNEL_B]);
  const five = ['A', 'B', 'C', 'D', 'E'].map((t, i) => productEdge(`2${i}`, t, '9.00'));
  let creates = 0;
  fetchImpl = async (url, opts) => {
    if (String(url).includes('myshopify')) return jsonResponse(catalogPage(five));
    if ((opts?.method || 'GET') === 'GET') return jsonResponse({ data: [] });
    creates += 1;
    // The SECOND create fails with a per-row, non-fatal error. The other four
    // must still be attempted — the old code `break`-ed and lost them from the
    // report entirely.
    if (creates === 2) return jsonResponse({ ok: true });   // id-less = per-row failure
    const body = JSON.parse(opts.body);
    return jsonResponse({ data: { id: `wp5_${creates}`, name: body.name } });
  };
  await post(`/stub/${FUNNEL_B}/products/sync`);
  const r = await post(`/stub/${FUNNEL_B}/whop/map`);
  eq(r.status, 200, 'batch5: the run completes');
  eq(r.body.data.planned_create, 5, 'batch5: five creates were planned');
  eq(creates, 5, 'batch5: all five were ATTEMPTED — one failure does not abandon the batch');
  eq(r.body.data.created, 4, 'batch5: four succeeded');
  eq(r.body.data.failed.length, 1, 'batch5: exactly one is reported failed');
  eq(r.body.data.created + r.body.data.failed.length, r.body.data.planned_create,
    'batch5: created + failed ACCOUNTS FOR every planned product — no product silently vanishes from the report');
  eq(r.body.data.mapped_count, 4, 'batch5: four mapping rows written');
}
{
  isolate();
  // A FATAL error (dead key) stops further CALLS but still ACCOUNTS for every
  // remaining product. Under-reporting is how a run that mapped 1 of 5 reads
  // as a clean success.
  await pgQuery(`DELETE FROM co_funnel_products WHERE funnel_id = $1`, [FUNNEL_B]);
  await pgQuery(`DELETE FROM co_whop_product_map WHERE funnel_id = $1`, [FUNNEL_B]);
  const five = ['A', 'B', 'C', 'D', 'E'].map((t, i) => productEdge(`3${i}`, t, '9.00'));
  let creates = 0;
  fetchImpl = async (url, opts) => {
    if (String(url).includes('myshopify')) return jsonResponse(catalogPage(five));
    if ((opts?.method || 'GET') === 'GET') return jsonResponse({ data: [] });
    creates += 1;
    if (creates >= 2) return jsonResponse({}, 401);   // dead key from #2 on
    const body = JSON.parse(opts.body);
    return jsonResponse({ data: { id: `wpf_${creates}`, name: body.name } });
  };
  await post(`/stub/${FUNNEL_B}/products/sync`);
  const r = await post(`/stub/${FUNNEL_B}/whop/map`);
  eq(r.body.data.created, 1, 'fatal: only the first create succeeded');
  eq(creates, 2, 'fatal: Whop is NOT hammered once the key is proven dead');
  eq(r.body.data.failed.length, 4, 'fatal: …but all four remaining products are still REPORTED as failed');
  eq(r.body.data.created + r.body.data.failed.length, r.body.data.planned_create,
    'fatal: the report still accounts for every planned product');
  eq(r.body.data.failed.every((f) => f.code === 'whop_auth_error'), true,
    'fatal: …each carrying the cause');
}
{
  isolate();
  // No products at all is a 400 with an actionable code, not a fake success.
  await pgQuery(`DELETE FROM co_funnel_products WHERE funnel_id = $1`, [FUNNEL_B]);
  fetchImpl = async () => { throw new Error('must not call any upstream with no products'); };
  const r = await post(`/stub/${FUNNEL_B}/whop/map`);
  eq(r.status, 400, 'whop map: no synced products → 400');
  eq(r.body?.error?.code, 'no_products', 'whop map: …with code no_products');
}
{
  isolate();
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

  const empty = await listWhopProducts({ api_key: 'k', company_id: 'c' });
  eq(empty, { products: [], complete: true, dropped: 0 },
    'whop service: a genuinely empty first page is COMPLETE — a positive claim, one call');

  threw = null;
  try { await createWhopProduct({ api_key: 'k', company_id: 'c' }, { name: '   ' }); } catch (e) { threw = e; }
  eq(threw?.code, 'whop_invalid_name', 'whop service: creating a blank-named product is refused up front');
}

// ---- MANUAL MAPPING CRUD --------------------------------------------------
{
  isolate();
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
  isolate();
  await seedFunnel(FUNNEL, { commerce: { restrict_countries: true, allowed_countries: ['us', 'bd'] } });

  const zoneWithRate = (nodes) => ({
    data: { deliveryProfiles: { nodes } },
  });
  const usZone = {
    zone: { name: 'Domestic', countries: [{ name: 'United States', code: { countryCode: 'US' } }] },
    methodDefinitions: { nodes: [{ active: true, name: 'Std', rateProvider: { __typename: 'DeliveryRateDefinition', price: { amount: '5.00', currencyCode: 'USD' } }, methodConditions: [] }] },
  };
  fetchImpl = async () => jsonResponse(zoneWithRate([
    { name: 'G', profileLocationGroups: [{ locationGroupZones: { nodes: [usZone] } }] },
  ]));
  const r = await get(`/stub/${FUNNEL}/shipping/zones`);
  eq(r.body.data.allowed_countries, ['US', 'BD'], 'zones: the funnel settings allow-list is read + normalized');
  eq(r.body.data.uncovered_countries, ['BD'], 'zones: an allowed country with no shipping zone is named');
  eq(r.body.data.truncated, false, 'zones: a single-page read is not truncated');

  // Two profiles still paging, one shared $zonesAfter (review #7): the view is
  // necessarily partial, and a partial view cannot prove a country UNCOVERED.
  fetchImpl = async () => jsonResponse(zoneWithRate([
    { name: 'A', profileLocationGroups: [{ locationGroupZones: { pageInfo: { hasNextPage: true, endCursor: 'CA' }, nodes: [usZone] } }] },
    { name: 'B', profileLocationGroups: [{ locationGroupZones: { pageInfo: { hasNextPage: true, endCursor: 'CB' }, nodes: [] } }] },
  ]));
  const t = await get(`/stub/${FUNNEL}/shipping/zones`);
  eq(t.body.data.truncated, true, 'zones: two profiles still paging → the view is flagged TRUNCATED');
  eq(t.body.data.truncated_reason, 'multiple_profile_pages', 'zones: …with the reason');
  eq(t.body.data.uncovered_countries, [],
    'zones: a truncated view SUPPRESSES coverage warnings — an unseen zone could cover the country');

  const mine = await get(`/stub/${FUNNEL}/products`);
  ok(mine.body.data.products.some((p) => p.title === 'Kit'), 'scoping: this funnel has its own product');
  const other = await get(`/stub/${FUNNEL_B}/products`);
  ok(other.body.data.products.every((p) => p.title !== 'Kit'),
    'scoping: one funnel never sees another funnel\'s synced products');
}

// ---- RATE LIMITING --------------------------------------------------------
{
  isolate();
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
{
  // REGRESSION (review #8). The budget is the SHOP's Shopify bucket, so the
  // key must not be the user — a second admin account used to get a whole
  // fresh allowance against the same bucket.
  isolate();
  fetchImpl = async () => jsonResponse(catalogPage([]));
  for (let i = 0; i < SYNC_RATE_MAX + 2; i += 1) await post(`/stub/${FUNNEL_B}/products/sync`);
  const asAnotherUser = await post(`/stub/${FUNNEL_B}/products/sync?as=a_different_admin`);
  eq(asAnotherUser.status, 429,
    'rate limit: a DIFFERENT user on the SAME shop+funnel is still limited — the cap is per shop, not per person');
  // …while a different funnel on the same shop has its own budget.
  const otherFunnel = await post(`/stub/${FUNNEL}/products/sync`);
  ok(otherFunnel.status !== 429, 'rate limit: a different funnel keeps its own budget', `status=${otherFunnel.status}`);
}
// ---- LIMITER STORE DOWN — admin jobs FAIL CLOSED (review #8) --------------
// Driven through the injectable `check` seam. `limited()` is the single gate
// every upstream-spending handler goes through, so exercising it directly is
// exercising the real path — no monkey patching, no guarded assertion.
{
  const fakeRes = () => {
    const r = { statusCode: 0, payload: null };
    r.status = (c) => { r.statusCode = c; return r; };
    r.json = (b) => { r.payload = b; return r; };
    return r;
  };
  const req = { params: { funnelId: FUNNEL }, user: { id: 'u1' }, ip: '127.0.0.1' };
  const down = async () => { throw new Error('limiter store unreachable'); };

  {
    const res = fakeRes();
    const blocked = await route.limited(req, res, 'k-closed', 5, 60, { failClosed: true, check: down });
    eq(blocked, true, 'limiter down: an admin job (failClosed) is REFUSED');
    eq(res.statusCode, 503, 'limiter down: …with 503');
    eq(res.payload?.error?.code, 'rate_limiter_unavailable', 'limiter down: …and code rate_limiter_unavailable');
    eq(res.payload?.error?.retryable, true, 'limiter down: …flagged retryable');
  }
  {
    const res = fakeRes();
    const blocked = await route.limited(req, res, 'k-open', 5, 60, { failClosed: false, check: down });
    eq(blocked, false, 'limiter down: a READ-ONLY handler still fails OPEN — a Redis blip must not blank the panel');
    eq(res.statusCode, 0, 'limiter down: …and nothing was written to the response');
  }
  {
    // A genuine over-cap answer is still a 429, not the store-down 503 — the
    // two must stay distinguishable or an operator cannot tell "slow down"
    // from "infrastructure is broken".
    const res = fakeRes();
    const overCap = async () => ({ allowed: false, retryAfter: 42 });
    await route.limited(req, res, 'k-cap', 5, 60, { failClosed: true, check: overCap });
    eq(res.statusCode, 429, 'limiter: a real over-cap is 429');
    eq(res.payload?.error?.code, 'rate_limited', 'limiter: …with code rate_limited, distinct from the store-down code');
  }
  {
    const res = fakeRes();
    let seenKey = null;
    const spy = async (k) => { seenKey = k; return { allowed: true }; };
    process.env.PUURE_SHOPIFY_STORE = 'keycheck.myshopify.com';
    await route.limited(req, res, 'k-scope', 5, 60, { check: spy });
    ok(seenKey.includes('keycheck.myshopify.com') && seenKey.includes(FUNNEL),
      'limiter: the key is SHOP + FUNNEL', seenKey);
    ok(!seenKey.includes('u1'), 'limiter: …and NOT the user id', seenKey);
  }
}

// ---- the 8s timeout is actually armed -------------------------------------
{
  isolate();
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

// ---- CROSS-SECTION SETTINGS QUEUE (review #11) ----------------------------
// funnels PATCH replaces the WHOLE settings column, so every section's save is
// a read-modify-write. Per-section queues serialized a section against itself
// and nothing else, so General could GET, Shipping could GET+PATCH, and
// General's PATCH would then land built on the pre-Shipping snapshot.
{
  const q1 = await import('../../../client/src/components/funnels/settings/serialQueue.js');
  const q2 = await import('../../../client/src/components/funnels/settings/serialQueue.js');
  ok(q1.enqueueSettingsSave === q2.enqueueSettingsSave,
    'settings queue: every importer gets the SAME module-level instance (a per-component queue reopens the race)');
  ok(typeof q1.makeSerialQueue === 'function',
    'settings queue: makeSerialQueue is still exported (tracking-tab.mjs depends on it)');

  // Two DIFFERENT sections doing read-modify-write on one shared document.
  const { enqueueSettingsSave, makeSerialQueue } = q1;
  const tick = () => new Promise((r) => { const t = setTimeout(r, 15); if (t.unref) t.unref(); });
  const rmw = (enqueue, key) => enqueue(async () => {
    const snapshot = { ...store };      // GET
    await tick();                       // network gap — where the race lives
    store = { ...snapshot, [key]: true }; // PATCH (whole-object replace)
  });

  // CONTROL: separate queues (the old shape) really do lose a write.
  let store = {};
  const qa = makeSerialQueue();
  const qb = makeSerialQueue();
  await Promise.all([rmw(qa, 'general'), rmw(qb, 'shipping')]);
  eq(Object.keys(store).length, 1,
    'settings queue: CONTROL — two SEPARATE queues drop one of the two writes (the reported bug)');

  // FIX: one shared queue keeps both.
  store = {};
  await Promise.all([rmw(enqueueSettingsSave, 'general'), rmw(enqueueSettingsSave, 'shipping')]);
  eq(Object.keys(store).sort(), ['general', 'shipping'],
    'settings queue: the SHARED queue preserves BOTH sections\' writes');

  // A failing job must not wedge the queue for every later section.
  let after = null;
  const boom = enqueueSettingsSave(async () => { throw new Error('save failed'); });
  await boom.then(() => null, () => null);
  await enqueueSettingsSave(async () => { after = 'ran'; });
  eq(after, 'ran', 'settings queue: a failed save rejects its own promise but never wedges the queue');
}

// ---- cleanup --------------------------------------------------------------
await wipe();
await pgQuery(`DELETE FROM funnels WHERE id = $1`, [FUNNEL]);
server.close();
globalThis.fetch = realFetch;
console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
