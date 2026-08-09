// Route-level verification for /api/v1/page-library — the PAGE LIBRARY:
// saved reusable page snapshots that clone into ANY funnel.
//
// The REAL routers (REAL authenticate + requirePermission + ensureTables +
// ensurePageLibraryTables) mounted on a minimal express host against a fresh
// embedded-PG database — same shape as builder/page-versions.mjs.
//
// Asserts BY EXECUTION:
//   • 401 without a token on every verb
//   • save-from-page round-trip: blocks / seo / all five escape hatches land
//     in the library BYTE-EQUAL (compared CANONICALLY — JSONB reorders object
//     keys, so key order is not the invariant)
//   • the SAVE select is pinned to (page_id, funnel_id): a page id from
//     ANOTHER funnel copies NOTHING (404, zero rows written)
//   • name falls back to the page title, category falls back to the shared
//     default bucket, an explicit name/category wins
//   • the LIST projection carries block_count + bytes and NEVER `blocks`
//   • list filters (q / type / category), limit clamp, offset, and facets
//     computed over the UNFILTERED live set
//   • PATCH is metadata-only; a cleared category returns to the default bucket
//   • DELETE is a SOFT archive — the row survives, the reads stop seeing it
//   • CLONE lands a DRAFT with a unique slug; blocks/seo/escape hatches come
//     through identical (jsonb round-trip through TWO tables)
//   • CLONE slug ladder: three clones of one entry → /x, /x-2, /x-3
//   • a PINNED slug collision is REFUSED (409 + prose), never rewritten
//   • is_home: a clone into an EMPTY funnel becomes home; a clone into a
//     funnel that already has one does NOT steal the slot
//   • MONEY BLOCKS (whop_checkout / order_bump) survive with props INTACT and
//     the clone still lands as draft
//   • an entry OUTLIVES its source funnel's pages being archived
//   • hostile blocks planted directly in the table are refused on the way OUT
//     (422), not silently instantiated
//   • malformed / mistyped input on every verb (400), unknown ids (404),
//     archived funnel (400), archived entry (404)
//   • a malformed JSON body does not crash the route
//   • the capacity ceiling answers 409, not a truncated write
//
// Run:  node server/tests/page-library/page-library.mjs
import postgres from 'postgres';

const DB = 'postgres://puure@127.0.0.1:5433/puure_pagelib';
let pass = 0, fail = 0;
const ok = (c, m, x = '') => { if (c) { pass++; console.log('PASS ', m); } else { fail++; console.log('FAIL ', m, x); } };

const admin = postgres('postgres://puure@127.0.0.1:5433/postgres', { ssl: false });
await admin`DROP DATABASE IF EXISTS puure_pagelib`;
await admin`CREATE DATABASE puure_pagelib`;
await admin.end();

Object.assign(process.env, {
  DATABASE_URL: DB, NODE_ENV: 'development',
  JWT_ACCESS_SECRET: 'localdev', JWT_REFRESH_SECRET: 'localdev',
  MONEY_SWEEP_DISABLED: '1', TRACKING_SWEEPS_DISABLED: '1', DOMAIN_SWEEP_DISABLED: '1',
});

const { default: express } = await import('express');
const { default: funnelsRoutes, ensureTables } = await import('../../src/routes/funnels.js');
const { default: pageLibraryRoutes } = await import('../../src/routes/pageLibrary.js');
const { LIBRARY_MAX_ENTRIES, DEFAULT_CATEGORY, NAME_MAX, SLUG_BODY_MAX, SLUG_BASE_MAX } =
  await import('../../src/services/pageLibrarySchema.js');

// The route's own slug grammar, restated here so the harness pins the CONTRACT
// rather than importing whatever the route currently believes.
const PAGE_SLUG_RE = /^\/$|^\/[a-z0-9-]+$/;

const app = express();
app.use(express.json({ limit: '10mb' }));
app.use('/api/v1/funnels', funnelsRoutes);        // same mounts as routes/index.js
app.use('/api/v1/page-library', pageLibraryRoutes);
const server = app.listen(0);
await new Promise((r) => server.once('listening', r));
const PORT = server.address().port;

const sql = postgres(DB, { ssl: false });
const { signAccessToken } = await import('../../src/utils/jwt.js');
await ensureTables();

// ---- Seed: user + funnels role (minimal tables the auth query touches) ----
await sql`CREATE TABLE IF NOT EXISTS users (
  id TEXT PRIMARY KEY, email TEXT, first_name TEXT, last_name TEXT,
  must_change_password BOOLEAN DEFAULT FALSE, email_verified BOOLEAN DEFAULT TRUE,
  is_active BOOLEAN DEFAULT TRUE
)`;
await sql`CREATE TABLE IF NOT EXISTS roles (id TEXT PRIMARY KEY, name TEXT, permissions JSONB)`;
await sql`CREATE TABLE IF NOT EXISTS user_roles (user_id TEXT, role_id TEXT)`;
await sql`INSERT INTO users (id, email, first_name, last_name) VALUES ('u_lib','l@t.co','L','T')`;
await sql`INSERT INTO roles (id, name, permissions) VALUES ('r_lib','library-tester', ${sql.json({ funnels: ['access'] })})`;
await sql`INSERT INTO user_roles (user_id, role_id) VALUES ('u_lib','r_lib')`;
const TOKEN = signAccessToken({ userId: 'u_lib' });

const FB_ = `http://127.0.0.1:${PORT}/api/v1/funnels`;
const LB = `http://127.0.0.1:${PORT}/api/v1/page-library`;
const H = { Authorization: `Bearer ${TOKEN}`, 'Content-Type': 'application/json' };
const NOAUTH = { 'Content-Type': 'application/json' };

// JSONB normalizes object-key order, so equality must be canonical.
const canon = (v) => {
  if (Array.isArray(v)) return `[${v.map(canon).join(',')}]`;
  if (v && typeof v === 'object') {
    return `{${Object.keys(v).sort().map((k) => `${JSON.stringify(k)}:${canon(v[k])}`).join(',')}}`;
  }
  return JSON.stringify(v);
};

const call = (base) => async (method, path, body, headers = H) => {
  const r = await fetch(`${base}${path}`, {
    method, headers, body: body === undefined ? undefined : JSON.stringify(body),
  });
  let j = null; try { j = await r.json(); } catch { /* non-JSON body */ }
  return { status: r.status, j };
};
const freq = call(FB_);
const lreq = call(LB);

// ---------------------------------------------------------------------------
// Seed: funnel A with a content-heavy page (every content column non-default),
// funnel B (clone target), funnel C (the cross-funnel decoy source).
// ---------------------------------------------------------------------------
const RICH_BLOCKS = [
  { type: 'hero', props: { headline: 'Glow', sub: 'Serum', img: '/a.png' } },
  { type: 'whop_checkout', props: { plan_id: 'plan_ABC', variant_gid: 'gid://shopify/ProductVariant/42', qty: 1 } },
  { type: 'order_bump', props: { title: 'Add a second bottle', variant_gid: 'gid://shopify/ProductVariant/99', discount_pct: 30 } },
  { type: 'faq', props: { items: [{ q: 'Ships?', a: 'Yes' }, { q: 'Refund?', a: '30 days' }] } },
];
const RICH_SEO = { title: 'SEO title', description: 'SEO desc', og: { image: '/og.png' } };
const RICH_HATCHES = {
  custom_html: '<div id="extra">hatch</div>',
  custom_css: 'body{background:#0b0b0b}\n.hero h1{color:gold}',
  custom_js: 'console.log("page js")',
  head_html: '<meta name="x" content="1">',
  body_end_html: '<!-- end -->',
};

const fa = await freq('POST', '/', { name: 'Lib A', slug: 'lib-harness-a' });
const fb = await freq('POST', '/', { name: 'Lib B', slug: 'lib-harness-b' });
const fc = await freq('POST', '/', { name: 'Lib C', slug: 'lib-harness-c' });
ok(fa.status === 201 && fb.status === 201 && fc.status === 201, 'seed: three funnels created',
  JSON.stringify({ a: fa.status, b: fb.status, c: fc.status }));
const FA = fa.j?.data?.id, FBID = fb.j?.data?.id, FC = fc.j?.data?.id;

const p1 = await freq('POST', `/${FA}/pages`, { title: 'Checkout Master', slug: '/checkout-master', type: 'checkout' });
ok(p1.status === 201, 'seed: source page created', JSON.stringify(p1.j));
const P1 = p1.j?.data?.id;
const patched = await freq('PATCH', `/${FA}/pages/${P1}`, {
  blocks: RICH_BLOCKS, seo: RICH_SEO, ...RICH_HATCHES,
});
ok(patched.status === 200, 'seed: source page filled with rich content', JSON.stringify(patched.status));

const pc = await freq('POST', `/${FC}/pages`, { title: 'Decoy', slug: '/decoy', type: 'generic' });
ok(pc.status === 201, 'seed: decoy page in funnel C', String(pc.status));
const PC = pc.j?.data?.id;

// ---------------------------------------------------------------------------
// T1 — auth: every verb 401s without a token
// ---------------------------------------------------------------------------
{
  const verbs = [
    ['GET', '/'], ['GET', '/fpl_x'], ['POST', '/'],
    ['PATCH', '/fpl_x'], ['DELETE', '/fpl_x'], ['POST', '/fpl_x/clone'],
  ];
  let all401 = true; const got = [];
  for (const [m, p] of verbs) {
    const r = await lreq(m, p, m === 'GET' || m === 'DELETE' ? undefined : {}, NOAUTH);
    got.push(`${m} ${p}=${r.status}`);
    if (r.status !== 401) all401 = false;
  }
  ok(all401, 'T1 every verb 401s without a token', got.join(' '));
}

// ---------------------------------------------------------------------------
// T2 — save from a page: 201 + every content column copied verbatim
// ---------------------------------------------------------------------------
let E1 = null;
{
  const r = await lreq('POST', '/', {
    funnel_id: FA, page_id: P1, name: 'Checkout — master template',
    description: 'The good one', category: 'Checkout',
  });
  ok(r.status === 201, 'T2 save → 201', JSON.stringify(r.j));
  const e = r.j?.data;
  E1 = e?.id;
  ok(typeof E1 === 'string' && E1.startsWith('fpl_'), 'T2 entry id is fpl_-prefixed', String(E1));
  ok(e?.name === 'Checkout — master template' && e?.description === 'The good one' && e?.category === 'Checkout',
    'T2 metadata stored as sent', JSON.stringify({ n: e?.name, d: e?.description, c: e?.category }));
  ok(e?.type === 'checkout', 'T2 type copied from the source page', String(e?.type));
  ok(e?.source_funnel_id === FA && e?.source_page_id === P1 && e?.source_title === 'Checkout Master',
    'T2 provenance recorded', JSON.stringify({ f: e?.source_funnel_id, p: e?.source_page_id, t: e?.source_title }));
  ok(e?.created_by === 'u_lib', 'T2 created_by is the authenticated user', String(e?.created_by));
  ok(canon(e?.blocks) === canon(RICH_BLOCKS), 'T2 blocks copied canonically-equal', canon(e?.blocks));
  ok(canon(e?.seo) === canon(RICH_SEO), 'T2 seo copied canonically-equal', canon(e?.seo));
  const hatchesOk = Object.entries(RICH_HATCHES).every(([k, v]) => e?.[k] === v);
  ok(hatchesOk, 'T2 all five escape hatches copied byte-verbatim',
    JSON.stringify(Object.fromEntries(Object.keys(RICH_HATCHES).map((k) => [k, e?.[k]]))));
  ok(e?.archived === false, 'T2 entry lands live');
}

// ---------------------------------------------------------------------------
// T3 — the SAVE select is pinned to (page_id, funnel_id)
// ---------------------------------------------------------------------------
{
  const before = (await sql`SELECT COUNT(*)::int AS n FROM funnel_page_library`)[0].n;
  const cross = await lreq('POST', '/', { funnel_id: FA, page_id: PC, name: 'Stolen' });
  ok(cross.status === 404 && cross.j?.error?.code === 'page_not_found',
    'T3 page id from ANOTHER funnel → 404', `${cross.status} ${JSON.stringify(cross.j)}`);
  const after = (await sql`SELECT COUNT(*)::int AS n FROM funnel_page_library`)[0].n;
  ok(before === after, 'T3 cross-funnel save wrote NOTHING', `${before} → ${after}`);

  const unknown = await lreq('POST', '/', { funnel_id: FA, page_id: 'fpg_nope', name: 'X' });
  ok(unknown.status === 404, 'T3 unknown page id → 404', String(unknown.status));
}

// ---------------------------------------------------------------------------
// T4 — save input validation + fallbacks
// ---------------------------------------------------------------------------
let E2 = null;
{
  const noFunnel = await lreq('POST', '/', { page_id: P1 });
  ok(noFunnel.status === 400 && noFunnel.j?.error?.code === 'funnel_id_is_required',
    'T4 missing funnel_id → 400', JSON.stringify(noFunnel.j));
  const noPage = await lreq('POST', '/', { funnel_id: FA });
  ok(noPage.status === 400 && noPage.j?.error?.code === 'page_id_is_required',
    'T4 missing page_id → 400', JSON.stringify(noPage.j));
  const badName = await lreq('POST', '/', { funnel_id: FA, page_id: P1, name: 42 });
  ok(badName.status === 400 && badName.j?.error?.code === 'name_must_be_a_string',
    'T4 non-string name → 400', JSON.stringify(badName.j));
  const badDesc = await lreq('POST', '/', { funnel_id: FA, page_id: P1, description: { a: 1 } });
  ok(badDesc.status === 400, 'T4 non-string description → 400', String(badDesc.status));
  const fatName = await lreq('POST', '/', { funnel_id: FA, page_id: P1, name: 'x'.repeat(NAME_MAX + 1) });
  ok(fatName.status === 400 && /exceeds/.test(fatName.j?.error?.code || ''),
    'T4 oversized name → 400', JSON.stringify(fatName.j));

  // No name, no category → page title + default bucket.
  const fallback = await lreq('POST', '/', { funnel_id: FA, page_id: P1 });
  ok(fallback.status === 201, 'T4 save with no metadata → 201', JSON.stringify(fallback.j));
  E2 = fallback.j?.data?.id;
  ok(fallback.j?.data?.name === 'Checkout Master', 'T4 name falls back to the page title',
    String(fallback.j?.data?.name));
  ok(fallback.j?.data?.category === DEFAULT_CATEGORY, 'T4 category falls back to the default bucket',
    String(fallback.j?.data?.category));
  ok(fallback.j?.data?.description === '', 'T4 absent description stores as empty string');
}

// ---------------------------------------------------------------------------
// T5 — LIST: metadata only, never blocks
// ---------------------------------------------------------------------------
{
  const r = await lreq('GET', '/');
  ok(r.status === 200, 'T5 list → 200', String(r.status));
  const d = r.j?.data;
  ok(Array.isArray(d?.entries) && d.entries.length === 2, 'T5 two live entries', String(d?.entries?.length));
  ok(d?.total === 2, 'T5 total matches', String(d?.total));
  const e = d.entries.find((x) => x.id === E1);
  ok(e && !('blocks' in e), 'T5 the list projection NEVER carries blocks', JSON.stringify(Object.keys(e || {})));
  ok(e?.block_count === RICH_BLOCKS.length, 'T5 block_count computed from the JSONB header', String(e?.block_count));
  ok(Number.isFinite(e?.bytes) && e.bytes > 0, 'T5 bytes computed', String(e?.bytes));
  ok(d.entries[0].id === E2, 'T5 newest first (created_at DESC)', d.entries.map((x) => x.id).join(','));
  const cats = (d?.categories || []).map((c) => `${c.name}:${c.count}`).sort().join(' ');
  ok(cats === ['Checkout:1', `${DEFAULT_CATEGORY}:1`].sort().join(' '),
    'T5 category facets over the live set', cats);
  ok((d?.types || []).some((t) => t.name === 'checkout' && t.count === 2), 'T5 type facets',
    JSON.stringify(d?.types));
}

// ---------------------------------------------------------------------------
// T6 — LIST filters + paging
// ---------------------------------------------------------------------------
{
  // 'template' is in E1's name only; 'master' would match E2's fallback name
  // ("Checkout Master") too — a substring search must be probed with a term
  // that actually discriminates, or the assertion proves nothing.
  const q = await lreq('GET', '/?q=template');
  ok(q.status === 200 && q.j?.data?.total === 1 && q.j.data.entries[0].id === E1,
    'T6 ?q= searches name + description', JSON.stringify(q.j?.data?.total));
  const qBoth = await lreq('GET', '/?q=checkout');
  ok(qBoth.j?.data?.total === 2, 'T6 ?q= is a substring match across BOTH entries when it should be',
    String(qBoth.j?.data?.total));
  const qDesc = await lreq('GET', '/?q=good%20one');
  ok(qDesc.j?.data?.total === 1, 'T6 ?q= matches the description too', String(qDesc.j?.data?.total));
  const cat = await lreq('GET', '/?category=Checkout');
  ok(cat.j?.data?.total === 1 && cat.j.data.entries[0].id === E1, 'T6 ?category= filters',
    String(cat.j?.data?.total));
  const type = await lreq('GET', '/?type=checkout');
  ok(type.j?.data?.total === 2, 'T6 ?type= filters', String(type.j?.data?.total));
  const none = await lreq('GET', '/?type=quiz');
  ok(none.status === 200 && none.j?.data?.total === 0 && none.j.data.entries.length === 0,
    'T6 a filter that matches nothing is an empty page, not an error', String(none.status));
  ok((none.j?.data?.categories || []).length === 2,
    'T6 facets stay computed over the UNFILTERED set so the operator can get back',
    JSON.stringify(none.j?.data?.categories));
  const paged = await lreq('GET', '/?limit=1&offset=1');
  ok(paged.j?.data?.entries?.length === 1 && paged.j.data.entries[0].id === E1 && paged.j.data.total === 2,
    'T6 limit + offset page WITHOUT lying about total', JSON.stringify(paged.j?.data?.total));
  const clamped = await lreq('GET', '/?limit=9999');
  ok(clamped.j?.data?.limit === 200, 'T6 limit clamped to the max', String(clamped.j?.data?.limit));
  const junk = await lreq('GET', '/?limit=abc&offset=-5');
  ok(junk.status === 200 && junk.j?.data?.limit === 100 && junk.j.data.offset === 0,
    'T6 junk paging params fall back to defaults, never to 0 rows',
    JSON.stringify({ l: junk.j?.data?.limit, o: junk.j?.data?.offset }));
}

// ---------------------------------------------------------------------------
// T7 — GET one: full entry (blocks included); unknown → 404
// ---------------------------------------------------------------------------
{
  const r = await lreq('GET', `/${E1}`);
  ok(r.status === 200 && canon(r.j?.data?.blocks) === canon(RICH_BLOCKS),
    'T7 GET /:id carries the full blocks', String(r.status));
  const miss = await lreq('GET', '/fpl_doesnotexist');
  ok(miss.status === 404 && miss.j?.error?.code === 'entry_not_found', 'T7 unknown entry → 404',
    JSON.stringify(miss.j));
}

// ---------------------------------------------------------------------------
// T8 — PATCH: metadata only
// ---------------------------------------------------------------------------
{
  const r = await lreq('PATCH', `/${E2}`, { name: 'Renamed', category: 'Upsells' });
  ok(r.status === 200 && r.j?.data?.name === 'Renamed' && r.j?.data?.category === 'Upsells',
    'T8 rename + recategorize', JSON.stringify(r.j?.data));
  ok(canon(r.j?.data?.blocks) === canon(RICH_BLOCKS), 'T8 PATCH does not touch content');

  const cleared = await lreq('PATCH', `/${E2}`, { category: '   ' });
  ok(cleared.j?.data?.category === DEFAULT_CATEGORY,
    'T8 a cleared category returns to the default bucket, not an empty pill',
    String(cleared.j?.data?.category));

  const empty = await lreq('PATCH', `/${E2}`, {});
  ok(empty.status === 400 && empty.j?.error?.code === 'nothing_to_update',
    'T8 empty patch → 400', JSON.stringify(empty.j));
  const blankName = await lreq('PATCH', `/${E2}`, { name: '  ' });
  ok(blankName.status === 400, 'T8 blank name → 400 (a rename to nothing is not a rename)',
    String(blankName.status));
  const badType = await lreq('PATCH', `/${E2}`, { name: 7 });
  ok(badType.status === 400, 'T8 non-string name → 400', String(badType.status));
  const miss = await lreq('PATCH', '/fpl_nope', { name: 'x' });
  ok(miss.status === 404, 'T8 unknown entry → 404', String(miss.status));
  // Content keys in the body are IGNORED, not applied.
  const sneaky = await lreq('PATCH', `/${E2}`, { name: 'Still renamed', blocks: [], custom_js: 'evil()' });
  const after = await lreq('GET', `/${E2}`);
  ok(sneaky.status === 200 && canon(after.j?.data?.blocks) === canon(RICH_BLOCKS)
    && after.j?.data?.custom_js === RICH_HATCHES.custom_js,
    'T8 content keys in a PATCH body are ignored', canon(after.j?.data?.blocks).slice(0, 60));
}

// ---------------------------------------------------------------------------
// T9 — CLONE into an EMPTY funnel: draft, home, content intact
// ---------------------------------------------------------------------------
{
  const r = await lreq('POST', `/${E1}/clone`, { funnel_id: FBID });
  ok(r.status === 201, 'T9 clone → 201', JSON.stringify(r.j));
  const p = r.j?.data;
  ok(typeof p?.id === 'string' && p.id.startsWith('fpg_'), 'T9 a real page id came back', String(p?.id));
  ok(p?.funnel_id === FBID, 'T9 landed in the TARGET funnel', String(p?.funnel_id));
  ok(p?.status === 'draft', 'T9 clone lands as DRAFT', String(p?.status));
  ok(p?.type === 'checkout', 'T9 page type carried from the entry', String(p?.type));
  ok(p?.slug === '/checkout-master-template', 'T9 slug derived from the entry name', String(p?.slug));
  ok(p?.is_home === true, 'T9 first page in an EMPTY funnel becomes home', String(p?.is_home));
  ok(canon(p?.blocks) === canon(RICH_BLOCKS), 'T9 blocks survive TWO jsonb hops unchanged', canon(p?.blocks));
  ok(canon(p?.seo) === canon(RICH_SEO), 'T9 seo survives', canon(p?.seo));
  ok(Object.entries(RICH_HATCHES).every(([k, v]) => p?.[k] === v),
    'T9 all five escape hatches survive');
  ok(r.j?.meta?.library_entry_id === E1 && r.j?.meta?.slug_rewritten === false,
    'T9 meta reports the source entry and that the slug was NOT rewritten', JSON.stringify(r.j?.meta));

  // MONEY BLOCKS, specifically: the props are the same object, not a stripped
  // shell. Pricing is re-resolved server-side at checkout regardless
  // (services/checkoutPricing.js), which is why carrying them is safe.
  const whop = (p?.blocks || []).find((b) => b.type === 'whop_checkout');
  const bump = (p?.blocks || []).find((b) => b.type === 'order_bump');
  ok(canon(whop?.props) === canon(RICH_BLOCKS[1].props), 'T9 whop_checkout props INTACT', canon(whop?.props));
  ok(canon(bump?.props) === canon(RICH_BLOCKS[2].props), 'T9 order_bump props INTACT', canon(bump?.props));
}

// ---------------------------------------------------------------------------
// T10 — CLONE slug ladder + is_home NOT stolen
// ---------------------------------------------------------------------------
{
  const r2 = await lreq('POST', `/${E1}/clone`, { funnel_id: FBID });
  const r3 = await lreq('POST', `/${E1}/clone`, { funnel_id: FBID });
  ok(r2.status === 201 && r2.j?.data?.slug === '/checkout-master-template-2',
    'T10 second clone → -2 suffix', `${r2.status} ${r2.j?.data?.slug}`);
  ok(r3.status === 201 && r3.j?.data?.slug === '/checkout-master-template-3',
    'T10 third clone → -3 suffix', `${r3.status} ${r3.j?.data?.slug}`);
  ok(r2.j?.data?.is_home === false && r3.j?.data?.is_home === false,
    'T10 later clones NEVER steal the home slot',
    JSON.stringify({ a: r2.j?.data?.is_home, b: r3.j?.data?.is_home }));
  const homes = await sql`SELECT COUNT(*)::int AS n FROM funnel_pages
                           WHERE funnel_id = ${FBID} AND is_home = TRUE AND archived = FALSE`;
  ok(homes[0].n === 1, 'T10 exactly ONE home page in the target funnel', String(homes[0].n));
}

// ---------------------------------------------------------------------------
// T11 — a PINNED slug is never silently rewritten
// ---------------------------------------------------------------------------
{
  const okPin = await lreq('POST', `/${E1}/clone`, { funnel_id: FBID, slug: '/pinned-ok' });
  ok(okPin.status === 201 && okPin.j?.data?.slug === '/pinned-ok', 'T11 free pinned slug is honoured',
    `${okPin.status} ${okPin.j?.data?.slug}`);
  const collide = await lreq('POST', `/${E1}/clone`, { funnel_id: FBID, slug: '/pinned-ok' });
  ok(collide.status === 409 && collide.j?.error?.code === 'slug_already_exists'
    && /pinned-ok/.test(collide.j?.error?.detail || ''),
    'T11 pinned collision → 409 WITH prose, never a rewrite', JSON.stringify(collide.j));
  const count = await sql`SELECT COUNT(*)::int AS n FROM funnel_pages
                           WHERE funnel_id = ${FBID} AND slug = '/pinned-ok'`;
  ok(count[0].n === 1, 'T11 the refusal wrote NOTHING', String(count[0].n));

  const badSlug = await lreq('POST', `/${E1}/clone`, { funnel_id: FBID, slug: 'no-leading-slash' });
  ok(badSlug.status === 400 && badSlug.j?.error?.code === 'slug_is_invalid',
    'T11 malformed pinned slug → 400', JSON.stringify(badSlug.j));
  const typedSlug = await lreq('POST', `/${E1}/clone`, { funnel_id: FBID, slug: 12 });
  ok(typedSlug.status === 400 && typedSlug.j?.error?.code === 'slug_must_be_a_string',
    'T11 non-string slug → 400', JSON.stringify(typedSlug.j));
}

// ---------------------------------------------------------------------------
// T12 — CLONE error paths
// ---------------------------------------------------------------------------
{
  const noFunnel = await lreq('POST', `/${E1}/clone`, {});
  ok(noFunnel.status === 400 && noFunnel.j?.error?.code === 'funnel_id_is_required',
    'T12 missing funnel_id → 400', JSON.stringify(noFunnel.j));
  const unknownFunnel = await lreq('POST', `/${E1}/clone`, { funnel_id: 'fnl_nope' });
  ok(unknownFunnel.status === 404 && unknownFunnel.j?.error?.code === 'funnel_not_found',
    'T12 unknown funnel → 404', JSON.stringify(unknownFunnel.j));
  const unknownEntry = await lreq('POST', '/fpl_nope/clone', { funnel_id: FBID });
  ok(unknownEntry.status === 404 && unknownEntry.j?.error?.code === 'entry_not_found',
    'T12 unknown entry → 404', JSON.stringify(unknownEntry.j));
  const badTitle = await lreq('POST', `/${E1}/clone`, { funnel_id: FBID, title: [] });
  ok(badTitle.status === 400, 'T12 non-string title → 400', String(badTitle.status));

  // Archived funnel.
  const arch = await freq('POST', `/${FC}/archive`, { archived: true });
  ok(arch.status === 200, 'T12 seed: funnel C archived', String(arch.status));
  const intoArchived = await lreq('POST', `/${E1}/clone`, { funnel_id: FC });
  ok(intoArchived.status === 400 && intoArchived.j?.error?.code === 'funnel_is_archived',
    'T12 clone into an ARCHIVED funnel → 400 with prose', JSON.stringify(intoArchived.j));
}

// ---------------------------------------------------------------------------
// T13 — a title-derived slug that slugifies to nothing still resolves
// ---------------------------------------------------------------------------
{
  const r = await lreq('POST', `/${E1}/clone`, { funnel_id: FBID, title: '←→ ✦✦✦' });
  ok(r.status === 201 && r.j?.data?.slug === '/checkout',
    'T13 an unslugifiable title falls back to the page TYPE, never to an invalid slug',
    `${r.status} ${r.j?.data?.slug}`);
  ok(r.j?.data?.title === '←→ ✦✦✦', 'T13 the title itself is preserved verbatim', String(r.j?.data?.title));
}

// ---------------------------------------------------------------------------
// T14 — the entry OUTLIVES its source. Archiving (and hard-deleting) the
// source page must not touch the library row or break the clone.
// ---------------------------------------------------------------------------
{
  const archived = await freq('POST', `/${FA}/pages/${P1}/archive`, { archived: true });
  ok(archived.status === 200, 'T14 seed: source page archived', String(archived.status));
  const still = await lreq('GET', `/${E1}`);
  ok(still.status === 200 && canon(still.j?.data?.blocks) === canon(RICH_BLOCKS),
    'T14 the library entry survives its source page being archived', String(still.status));
  const cloned = await lreq('POST', `/${E1}/clone`, { funnel_id: FBID, title: 'From an orphan' });
  ok(cloned.status === 201 && canon(cloned.j?.data?.blocks) === canon(RICH_BLOCKS),
    'T14 an orphaned entry still clones with full content', String(cloned.status));

  // And a re-save from the now-archived page is refused — a snapshot of a
  // trashed page is not something the operator asked for.
  const resave = await lreq('POST', '/', { funnel_id: FA, page_id: P1 });
  ok(resave.status === 404, 'T14 saving an ARCHIVED page → 404', String(resave.status));
}

// ---------------------------------------------------------------------------
// T15 — hostile blocks planted DIRECTLY in the table are refused on the way
// out. (validateBlocks runs on save AND on clone; this proves the clone half,
// which is the one that protects a table written by some future path.)
// ---------------------------------------------------------------------------
{
  const poison = JSON.parse('[{"type":"section","props":{"nest":{"__proto__":{"polluted":1}}}}]');
  await sql`INSERT INTO funnel_page_library (id, name, type, blocks)
            VALUES ('fpl_poison', 'Poison', 'generic', ${sql.json(poison)})`;
  const r = await lreq('POST', '/fpl_poison/clone', { funnel_id: FBID });
  ok(r.status === 422 && r.j?.error?.code === 'entry_blocks_are_invalid'
    && /forbidden key/.test(r.j?.error?.detail || ''),
    'T15 a forbidden key in a stored entry is refused at CLONE time (422)', JSON.stringify(r.j));
  const landed = await sql`SELECT COUNT(*)::int AS n FROM funnel_pages
                            WHERE funnel_id = ${FBID} AND title = 'Poison'`;
  ok(landed[0].n === 0, 'T15 the refusal wrote no page', String(landed[0].n));

  // A blocks column that is not an array at all (a shape no write path
  // produces, but the table cannot forbid) is refused, not 500'd.
  await sql`INSERT INTO funnel_page_library (id, name, type, blocks)
            VALUES ('fpl_shape', 'Shape', 'generic', ${sql.json({ not: 'an array' })})`;
  const r2 = await lreq('POST', '/fpl_shape/clone', { funnel_id: FBID });
  ok(r2.status === 422, 'T15 a non-array blocks column → 422, not 500', `${r2.status} ${JSON.stringify(r2.j)}`);
  await sql`DELETE FROM funnel_page_library WHERE id IN ('fpl_poison','fpl_shape')`;
}

// ---------------------------------------------------------------------------
// T16 — DELETE is a soft archive
// ---------------------------------------------------------------------------
{
  const before = await lreq('GET', '/');
  const r = await lreq('DELETE', `/${E2}`);
  ok(r.status === 200 && r.j?.data?.archived === true, 'T16 delete → 200 archived', JSON.stringify(r.j));
  const row = await sql`SELECT archived FROM funnel_page_library WHERE id = ${E2}`;
  ok(row.length === 1 && row[0].archived === true, 'T16 the ROW survives (soft archive)', JSON.stringify(row));
  const after = await lreq('GET', '/');
  ok(after.j?.data?.total === before.j.data.total - 1, 'T16 the list stops seeing it',
    `${before.j?.data?.total} → ${after.j?.data?.total}`);
  const get = await lreq('GET', `/${E2}`);
  ok(get.status === 404, 'T16 GET on an archived entry → 404', String(get.status));
  const cloneArchived = await lreq('POST', `/${E2}/clone`, { funnel_id: FBID });
  ok(cloneArchived.status === 404, 'T16 cloning an archived entry → 404', String(cloneArchived.status));
  const patchArchived = await lreq('PATCH', `/${E2}`, { name: 'zombie' });
  ok(patchArchived.status === 404, 'T16 patching an archived entry → 404', String(patchArchived.status));
  const again = await lreq('DELETE', `/${E2}`);
  ok(again.status === 404, 'T16 double delete → 404, not a second success', String(again.status));
}

// ---------------------------------------------------------------------------
// T17 — malformed JSON body does not crash the route
// ---------------------------------------------------------------------------
{
  const r = await fetch(`${LB}/`, { method: 'POST', headers: H, body: '{nope' });
  ok(r.status >= 400 && r.status < 500, 'T17 malformed JSON → 4xx', String(r.status));
  const alive = await lreq('GET', '/');
  ok(alive.status === 200, 'T17 the router still answers afterwards', String(alive.status));
}

// ---------------------------------------------------------------------------
// T18 — the capacity ceiling refuses, it does not truncate
// ---------------------------------------------------------------------------
{
  const live = (await sql`SELECT COUNT(*)::int AS n FROM funnel_page_library WHERE archived = FALSE`)[0].n;
  const need = LIBRARY_MAX_ENTRIES - live;
  await sql`INSERT INTO funnel_page_library (id, name, type)
            SELECT 'fpl_bulk_' || g, 'Bulk ' || g, 'generic'
              FROM generate_series(1, ${need}) g`;
  const full = (await sql`SELECT COUNT(*)::int AS n FROM funnel_page_library WHERE archived = FALSE`)[0].n;
  ok(full === LIBRARY_MAX_ENTRIES, 'T18 seeded to the ceiling', String(full));

  // Un-archive the source page so the save would otherwise succeed — the only
  // thing standing between this call and a 201 is the capacity check.
  await sql`UPDATE funnel_pages SET archived = FALSE WHERE id = ${P1}`;
  const r = await lreq('POST', '/', { funnel_id: FA, page_id: P1, name: 'One too many' });
  ok(r.status === 409 && r.j?.error?.code === 'library_is_full',
    'T18 a save past the ceiling → 409', JSON.stringify(r.j));
  ok(/delete one/i.test(r.j?.error?.detail || ''), 'T18 the refusal says what to do about it',
    String(r.j?.error?.detail));
  const after = (await sql`SELECT COUNT(*)::int AS n FROM funnel_page_library WHERE archived = FALSE`)[0].n;
  ok(after === LIBRARY_MAX_ENTRIES, 'T18 the refusal wrote nothing', String(after));

  // Free a slot → the same call now succeeds.
  await sql`UPDATE funnel_page_library SET archived = TRUE WHERE id = 'fpl_bulk_1'`;
  const ok2 = await lreq('POST', '/', { funnel_id: FA, page_id: P1, name: 'Now it fits' });
  ok(ok2.status === 201, 'T18 archiving one entry frees a slot', `${ok2.status} ${JSON.stringify(ok2.j)}`);
}

// ---------------------------------------------------------------------------
// T19 (review M1, GATING) — the derived-slug retry under concurrency with a
// LONG entry name.
//
// The bug: base was capped at 80 and the RETRY capped the JOINED string at 81,
// so `/${base}-${hex}`.slice(0,81) truncated the random suffix straight back
// off. The retry therefore re-submitted the slug that had just raised 23505,
// and that second violation was outside any try → an uncaught 500. Reproduced
// by the reviewer at 3/5 concurrent clones with a realistic long name.
//
// The bar: every concurrent clone answers 201 or 409. NEVER 500, never a
// duplicate slug, never a slug over budget.
// ---------------------------------------------------------------------------
const LONG_NAME =
  'Ultimate Black Friday Checkout Page For The Glow Serum Bundle With Free Shipping And Bump Offer';
let LONG_ENTRY = null;
{
  // T18 deliberately left the library AT its ceiling. Everything below saves
  // new entries, so hand the slots back first — otherwise the whole block
  // 409s and every assertion under it reads as a bug in the code under test
  // rather than in the fixture. (It did exactly that on the first run.)
  await sql`DELETE FROM funnel_page_library WHERE id LIKE 'fpl_bulk_%'`;
  const freed = (await sql`SELECT COUNT(*)::int AS n FROM funnel_page_library WHERE archived = FALSE`)[0].n;
  ok(freed < LIBRARY_MAX_ENTRIES, 'T19 fixture: slots freed after the ceiling test', String(freed));

  ok(LONG_NAME.length >= 90, 'T19 the probe name is 90+ chars', String(LONG_NAME.length));
  const saved = await lreq('POST', '/', { funnel_id: FA, page_id: P1, name: LONG_NAME });
  ok(saved.status === 201, 'T19 seed: long-named entry saved', `${saved.status} ${JSON.stringify(saved.j)}`);
  LONG_ENTRY = saved.j?.data?.id;

  const fd = await freq('POST', '/', { name: 'Lib D', slug: 'lib-harness-d' });
  const FD = fd.j?.data?.id;
  ok(fd.status === 201, 'T19 seed: fresh empty target funnel', String(fd.status));

  const N = 5;
  const results = await Promise.all(
    Array.from({ length: N }, () => lreq('POST', `/${LONG_ENTRY}/clone`, { funnel_id: FD }))
  );
  const codes = results.map((r) => r.status);
  ok(!codes.includes(500), 'T19 NO 500 under 5 concurrent clones of a long name', codes.join(','));
  ok(codes.every((c) => c === 201 || c === 409),
    'T19 every concurrent clone is a 201 or a 409', codes.join(','));

  const created = results.filter((r) => r.status === 201).map((r) => r.j?.data);
  ok(created.length >= 1, 'T19 at least one clone landed', String(created.length));
  const slugs = created.map((p) => p.slug);
  ok(new Set(slugs).size === slugs.length, 'T19 every landed slug is DISTINCT', slugs.join(' '));
  ok(slugs.every((s) => PAGE_SLUG_RE.test(s)), 'T19 every landed slug is legal', slugs.join(' '));
  ok(slugs.every((s) => s.length <= 1 + SLUG_BODY_MAX),
    'T19 every landed slug fits the budget', slugs.map((s) => `${s}=${s.length}`).join(' '));
  ok(slugs.every((s) => !/--$|-$/.test(s)),
    'T19 no slug ends in a dangling dash', slugs.join(' '));

  // The DB is the authority on how many pages actually exist, not the responses.
  const rows = await sql`SELECT slug FROM funnel_pages WHERE funnel_id = ${FD} AND archived = FALSE`;
  ok(rows.length === created.length,
    'T19 the DB holds exactly as many pages as reported 201', `${rows.length} vs ${created.length}`);
  const homes = await sql`SELECT COUNT(*)::int AS n FROM funnel_pages
                           WHERE funnel_id = ${FD} AND is_home = TRUE AND archived = FALSE`;
  ok(homes[0].n === 1,
    'T19 exactly ONE home page survives 5 concurrent clones into an EMPTY funnel', String(homes[0].n));
}

// ---------------------------------------------------------------------------
// T20 (review M1) — the slug budget is a property of the BASE, provable
// without a race. A 200-char title must still leave room for a '-<4 hex>'
// retry suffix; capping the joined string is what silently removed it.
// ---------------------------------------------------------------------------
{
  const fe = await freq('POST', '/', { name: 'Lib E', slug: 'lib-harness-e' });
  const FE = fe.j?.data?.id;
  const title = 'a'.repeat(200);
  const r = await lreq('POST', `/${LONG_ENTRY}/clone`, { funnel_id: FE, title });
  ok(r.status === 201, 'T20 a 200-char title clones', `${r.status} ${JSON.stringify(r.j)}`);
  const slug = r.j?.data?.slug || '';
  ok(slug.length <= 1 + SLUG_BASE_MAX,
    'T20 the derived slug is capped at the BASE budget, leaving suffix room',
    `${slug.length} (base max ${SLUG_BASE_MAX})`);
  ok(slug.length + 5 <= 1 + SLUG_BODY_MAX,
    'T20 a "-abcd" retry suffix still fits inside the full budget', String(slug.length + 5));
  ok(PAGE_SLUG_RE.test(slug), 'T20 the capped slug is still legal', slug);

  // Ladder steps must also stay inside the budget.
  const r2 = await lreq('POST', `/${LONG_ENTRY}/clone`, { funnel_id: FE, title });
  ok(r2.status === 201 && r2.j?.data?.slug === `${slug}-2`,
    'T20 the ladder appends to the capped base', `${r2.status} ${r2.j?.data?.slug}`);
  ok(r2.j?.data?.slug.length <= 1 + SLUG_BODY_MAX,
    'T20 the ladder step is inside the full budget', String(r2.j?.data?.slug.length));
  ok(r2.j?.meta?.slug_rewritten === true,
    'T20 a ladder step reports itself as a rewrite', JSON.stringify(r2.j?.meta));
}

// ---------------------------------------------------------------------------
// T21 (review m3) — archived-funnel TOCTOU. The pre-flight archived check is
// advisory; the guarantee is `AND archived = FALSE` on the LOCKED select. Race
// a clone against the archive itself and assert the invariant that matters: a
// page never lands in a funnel that is archived once the dust settles.
// ---------------------------------------------------------------------------
{
  let violations = 0;
  const codes = [];
  for (let i = 0; i < 6; i += 1) {
    const f = await freq('POST', '/', { name: `Race ${i}`, slug: `lib-race-${i}` });
    const FR = f.j?.data?.id;
    const [cloneRes] = await Promise.all([
      lreq('POST', `/${LONG_ENTRY}/clone`, { funnel_id: FR }),
      freq('POST', `/${FR}/archive`, { archived: true }),
    ]);
    codes.push(cloneRes.status);
    const funnelRow = await sql`SELECT archived FROM funnels WHERE id = ${FR}`;
    const pageRows = await sql`SELECT id FROM funnel_pages WHERE funnel_id = ${FR} AND archived = FALSE`;
    if (funnelRow[0]?.archived === true && pageRows.length > 0 && cloneRes.status === 201) {
      // A 201 that lands in a funnel the archive already committed is the
      // TOCTOU. (A 201 that WON the race is fine — the archive then ran after.)
      violations += 1;
    }
    if (cloneRes.status === 500) violations += 1;
  }
  ok(violations === 0,
    'T21 no clone/archive interleaving produces a 500 or an orphaned page', String(violations));
  ok(codes.every((c) => c === 201 || c === 400),
    'T21 every raced clone is a 201 or the archived-funnel 400', codes.join(','));
}

// ---------------------------------------------------------------------------
// T22 (review m2) — ?q= must not be a wildcard injection. Before escapeLike a
// literal '%' matched EVERY row, which made the search box silently useless
// for names that contain one.
// ---------------------------------------------------------------------------
{
  const f = await freq('POST', '/', { name: 'Like F', slug: 'lib-harness-f' });
  const FF = f.j?.data?.id;
  const p = await freq('POST', `/${FF}/pages`, { title: 'Pct', slug: '/pct', type: 'generic' });
  const PF = p.j?.data?.id;
  const a = await lreq('POST', '/', { funnel_id: FF, page_id: PF, name: 'Save 50% today' });
  const b = await lreq('POST', '/', { funnel_id: FF, page_id: PF, name: 'under_score name' });
  const c = await lreq('POST', '/', { funnel_id: FF, page_id: PF, name: 'plain name' });
  ok(a.status === 201 && b.status === 201 && c.status === 201,
    'T22 seed: three probe entries', `${a.status}/${b.status}/${c.status}`);

  const pct = await lreq('GET', `/?q=${encodeURIComponent('50%')}`);
  ok(pct.status === 200 && pct.j?.data?.total === 1
    && pct.j.data.entries[0].name === 'Save 50% today',
    "T22 a literal '%' matches only the entry containing it, not everything",
    `${pct.status} total=${pct.j?.data?.total}`);

  const bare = await lreq('GET', `/?q=${encodeURIComponent('%')}`);
  ok(bare.j?.data?.total === 1,
    "T22 a bare '%' is a LITERAL, not a match-all wildcard", String(bare.j?.data?.total));

  const under = await lreq('GET', `/?q=${encodeURIComponent('under_score')}`);
  ok(under.j?.data?.total === 1 && under.j.data.entries[0].name === 'under_score name',
    "T22 '_' matches a literal underscore", String(under.j?.data?.total));
  const underWild = await lreq('GET', `/?q=${encodeURIComponent('under_')}`);
  ok(underWild.j?.data?.total === 1,
    "T22 '_' does not act as a single-character wildcard", String(underWild.j?.data?.total));

  const backslash = await lreq('GET', `/?q=${encodeURIComponent('\\')}`);
  ok(backslash.status === 200,
    'T22 a lone backslash is a valid search, not a 500 (the escape char itself)',
    String(backslash.status));
}

// ---------------------------------------------------------------------------
// T23 (review m1) — the capacity gate under concurrency. A count-then-insert
// let three concurrent savers all read N-1 and all insert (measured 501/500).
// The gate now runs inside a transaction behind an advisory lock.
// ---------------------------------------------------------------------------
{
  // Drive the LIVE count to exactly the ceiling minus one, so there is room for
  // exactly ONE of the three concurrent saves.
  const live = (await sql`SELECT COUNT(*)::int AS n FROM funnel_page_library WHERE archived = FALSE`)[0].n;
  const target = LIBRARY_MAX_ENTRIES - 1;
  if (live > target) {
    await sql`UPDATE funnel_page_library SET archived = TRUE
               WHERE id IN (SELECT id FROM funnel_page_library WHERE archived = FALSE
                            ORDER BY id LIMIT ${live - target})`;
  } else if (live < target) {
    await sql`INSERT INTO funnel_page_library (id, name, type)
              SELECT 'fpl_fill_' || g, 'Fill ' || g, 'generic'
                FROM generate_series(1, ${target - live}) g`;
  }
  const atLine = (await sql`SELECT COUNT(*)::int AS n FROM funnel_page_library WHERE archived = FALSE`)[0].n;
  ok(atLine === target, 'T23 seeded to exactly one slot free', `${atLine} of ${LIBRARY_MAX_ENTRIES}`);

  const results = await Promise.all([
    lreq('POST', '/', { funnel_id: FA, page_id: P1, name: 'Concurrent A' }),
    lreq('POST', '/', { funnel_id: FA, page_id: P1, name: 'Concurrent B' }),
    lreq('POST', '/', { funnel_id: FA, page_id: P1, name: 'Concurrent C' }),
  ]);
  const codes = results.map((r) => r.status);
  const created = codes.filter((c) => c === 201).length;
  const refused = codes.filter((c) => c === 409).length;
  ok(created === 1, 'T23 exactly ONE of three concurrent saves takes the last slot', codes.join(','));
  ok(refused === 2, 'T23 the other two are refused with 409, not silently written', codes.join(','));
  ok(!codes.includes(500), 'T23 no 500 under concurrent saves', codes.join(','));

  const after = (await sql`SELECT COUNT(*)::int AS n FROM funnel_page_library WHERE archived = FALSE`)[0].n;
  ok(after === LIBRARY_MAX_ENTRIES,
    'T23 the live count lands ON the ceiling, never over it', `${after} of ${LIBRARY_MAX_ENTRIES}`);
  ok(after <= LIBRARY_MAX_ENTRIES,
    'T23 the ceiling is never breached (the 501/500 the review measured)', String(after));
}

// ---------------------------------------------------------------------------
// T24 — a refused save (capacity) ROLLS BACK rather than committing and
// compensating. The blocks-validation refusal takes the same path.
// ---------------------------------------------------------------------------
{
  const before = (await sql`SELECT COUNT(*)::int AS n FROM funnel_page_library`)[0].n;
  const r = await lreq('POST', '/', { funnel_id: FA, page_id: P1, name: 'Should not exist' });
  ok(r.status === 409, 'T24 the library is still full', String(r.status));
  const after = (await sql`SELECT COUNT(*)::int AS n FROM funnel_page_library`)[0].n;
  ok(before === after, 'T24 the refusal left NO row behind, archived or otherwise',
    `${before} → ${after}`);
  const ghost = await sql`SELECT id FROM funnel_page_library WHERE name = 'Should not exist'`;
  ok(ghost.length === 0, 'T24 not even an archived ghost row', JSON.stringify(ghost));
}

// ---------------------------------------------------------------------------
// Cleanup
// ---------------------------------------------------------------------------
// The database is dropped/recreated at the TOP of the next run, not here —
// dropping it now would terminate the routers' still-open idle pool connections
// and print a FATAL 57P01 after the score line, which reads like a failure.
console.log(`\n${pass} passed, ${fail} failed`);
server.close();
await sql.end();
process.exit(fail ? 1 : 0);
