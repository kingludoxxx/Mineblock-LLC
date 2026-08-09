// PLATFORM COMPLETENESS — route-level verification for the three gaps this
// lane closes: FUNNEL DUPLICATE, FUNNEL RESTORE, and HEALTH ALERTS v1.
//
// The REAL routers (REAL authenticate + requirePermission + ensureTables) on a
// minimal express host against a fresh embedded-PG database — same shape as
// funnel-transfer.mjs and page-duplicate.mjs.
//
// THE ROLE MATRIX IS THE MIGRATION'S OUTPUT, NOT A HAND-WRITTEN COPY OF IT:
// the harness seeds the three seeded role NAMES with their seed_roles.js
// permissions, then executes server/migrations/091_add_health_alerts_permission.sql
// VERBATIM off disk and drives every auth assertion through the roles that
// migration produced. A migration that stops granting what this file claims
// fails here rather than in production.
//
// Asserts BY EXECUTION:
//   DUPLICATE — confirm required; archived refused; non-string name refused;
//               a 0-page and an over-cap funnel refused BEFORE any export runs;
//               copy is a DRAFT with fresh id/slug and no domain; every page
//               byte-identical (canonical compare); page ids fresh, page slugs
//               preserved; redirects byte-identical; canvas remapped; the
//               credential neither travels nor goes unmentioned; ARCHIVED pages
//               are left behind AND said so; twice → two slugs; source intact.
//   RESTORE   — confirm required; 404s; happy path keeps the slug; a slug taken
//               in the meantime produces a suffix + a note (and the usurper is
//               untouched) where the OLD archive route 409s; idempotent.
//   ALERTS    — the full role matrix (Full Access / Manager / Viewer) across
//               read, ack and sweep; record → list → ack; unacked-first;
//               paging incl. clamps and junk params; severity enum on write and
//               filter; SCOPED cooldown (two subjects = two alerts);
//               CONCURRENT cooldown (4 real processes → exactly 1 row); ack
//               idempotent + original acker preserved; context cap; the sweep
//               against missing tables, real seeded state, and empty tables;
//               the baseline SURVIVING A SIMULATED RESTART; the FLOOR firing
//               with no baseline at all; and dry-vs-anchored sweeps.
//
// Run:  node server/tests/platform/platform.mjs
import postgres from 'postgres';
import { readFile } from 'fs/promises';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';
import { spawn } from 'child_process';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO = join(HERE, '..', '..', '..');
const DB = 'postgres://puure@127.0.0.1:5433/puure_platform';

// ── WORKER MODE (for the concurrency probe) ────────────────────────────────
// This same file, re-invoked as a child process, records ONE alert and prints
// whether it created a row. Four of these run in parallel against one database
// to prove the cooldown is exclusive. It must short-circuit BEFORE the drop/
// create below — a worker that recreated the database would erase the very
// state it was launched to contend for.
if (process.argv[2] === '--record-worker') {
  Object.assign(process.env, {
    DATABASE_URL: DB, NODE_ENV: 'development',
    JWT_ACCESS_SECRET: 'localdev', JWT_REFRESH_SECRET: 'localdev',
    HEALTH_ALERTS_SWEEP_DISABLED: '1',
  });
  const { recordAlert } = await import(join(REPO, 'server/src/services/healthAlerts.js'));
  const r = await recordAlert(process.argv[3], 'critical', 'contended', { w: process.argv[5] }, { scopeId: process.argv[4] });
  console.log(JSON.stringify({ created: r.created }));
  process.exit(0);
}

const PORT = 48931;
let pass = 0, fail = 0;
const ok = (c, m, x = '') => { if (c) { pass++; console.log('PASS ', m); } else { fail++; console.log('FAIL ', m, x); } };

const admin = postgres('postgres://puure@127.0.0.1:5433/postgres', { ssl: false });
await admin`DROP DATABASE IF EXISTS puure_platform`;
await admin`CREATE DATABASE puure_platform`;
await admin.end();

Object.assign(process.env, {
  DATABASE_URL: DB, PORT: String(PORT), NODE_ENV: 'development',
  JWT_ACCESS_SECRET: 'localdev', JWT_REFRESH_SECRET: 'localdev',
  MONEY_SWEEP_DISABLED: '1', TRACKING_SWEEPS_DISABLED: '1', DOMAIN_SWEEP_DISABLED: '1',
  // The sweep is driven EXPLICITLY below. A 5-minute background timer could not
  // race a run this short, but "could not" is not a thing this harness asserts
  // — it removes the possibility instead.
  HEALTH_ALERTS_SWEEP_DISABLED: '1',
});

const { default: express } = await import('express');
const { default: funnelsRoutes } = await import('../../src/routes/funnels.js');
const { default: healthAlertsRoutes } = await import('../../src/routes/healthAlerts.js');
const app = express();
app.use(express.json({ limit: '30mb' }));
app.use('/api/v1/funnels', funnelsRoutes);
app.use('/api/v1/health-alerts', healthAlertsRoutes); // same mount as routes/index.js
const server = app.listen(PORT);
await new Promise((r) => setTimeout(r, 300));

const sql = postgres(DB, { ssl: false });
const { signAccessToken } = await import('../../src/utils/jwt.js');
const { ensureTables } = await import('../../src/routes/funnels.js');
const alerts = await import('../../src/services/healthAlerts.js');
await ensureTables();

await sql`CREATE TABLE IF NOT EXISTS users (
  id TEXT PRIMARY KEY, email TEXT, first_name TEXT, last_name TEXT,
  must_change_password BOOLEAN DEFAULT FALSE, email_verified BOOLEAN DEFAULT TRUE,
  is_active BOOLEAN DEFAULT TRUE
)`;
await sql`CREATE TABLE IF NOT EXISTS roles (id TEXT PRIMARY KEY, name TEXT, permissions JSONB)`;
await sql`CREATE TABLE IF NOT EXISTS user_roles (user_id TEXT, role_id TEXT)`;

// ── Seed the three roles EXACTLY as seeds/seed_roles.js does ───────────────
await sql`INSERT INTO roles (id, name, permissions) VALUES
  ('r_full','Team - Full Access', ${sql.json({ funnels: ['access'], orders: ['access'] })}),
  ('r_mgr','Manager',             ${sql.json({ departments: ['read', 'update'], audit: ['read'] })}),
  ('r_view','Viewer',             ${sql.json({ departments: ['read'], audit: ['read'] })})`;

// ── APPLY MIGRATION 091 VERBATIM, OFF DISK ────────────────────────────────
const MIGRATION_091 = join(REPO, 'server/migrations/091_add_health_alerts_permission.sql');
const migrationSql = await readFile(MIGRATION_091, 'utf8');
await sql.unsafe(migrationSql);

const rolePerms = Object.fromEntries(
  (await sql`SELECT name, permissions FROM roles`).map((r) => [r.name, r.permissions])
);
ok(JSON.stringify(rolePerms['Team - Full Access']?.['health-alerts']) === '["read","ack"]',
  'P1 migration 091 grants Team - Full Access health-alerts:[read,ack]', JSON.stringify(rolePerms['Team - Full Access']));
ok(JSON.stringify(rolePerms['Manager']?.['health-alerts']) === '["read"]',
  'P2 migration 091 grants Manager health-alerts:[read] only', JSON.stringify(rolePerms['Manager']));
ok(rolePerms['Viewer']?.['health-alerts'] === undefined,
  'P3 migration 091 grants Viewer NOTHING (deliberate)', JSON.stringify(rolePerms['Viewer']));
ok(JSON.stringify(rolePerms['Team - Full Access']?.funnels) === '["access"]'
  && JSON.stringify(rolePerms['Manager']?.audit) === '["read"]',
  'P4 the migration did not disturb the permissions already on those roles', JSON.stringify(rolePerms['Manager']));
// `||` REPLACES at an existing key, so a re-run must be a no-op, not a doubling.
await sql.unsafe(migrationSql);
const [{ permissions: reRun }] = await sql`SELECT permissions FROM roles WHERE name = 'Team - Full Access'`;
ok(JSON.stringify(reRun['health-alerts']) === '["read","ack"]',
  'P5 re-running the migration is idempotent (no duplicated actions)', JSON.stringify(reRun['health-alerts']));

await sql`INSERT INTO users (id, email, first_name, last_name) VALUES
  ('u_full','f@t.co','F','A'), ('u_mgr','m@t.co','M','G'), ('u_view','v@t.co','V','W')`;
await sql`INSERT INTO user_roles (user_id, role_id) VALUES
  ('u_full','r_full'), ('u_mgr','r_mgr'), ('u_view','r_view')`;

const TOKEN = signAccessToken({ userId: 'u_full' });
const TOKEN_MGR = signAccessToken({ userId: 'u_mgr' });
const TOKEN_VIEW = signAccessToken({ userId: 'u_view' });

const BASE = `http://127.0.0.1:${PORT}`;
const H = { Authorization: `Bearer ${TOKEN}`, 'Content-Type': 'application/json' };
const asUser = (t) => ({ Authorization: `Bearer ${t}`, 'Content-Type': 'application/json' });
const NO_AUTH = { 'Content-Type': 'application/json' };
const req = async (method, path, body, headers = H) => {
  const r = await fetch(`${BASE}${path}`, {
    method, headers, body: body === undefined ? undefined : JSON.stringify(body),
  });
  let j = null; try { j = await r.json(); } catch { /* an empty body is a legal answer */ }
  return { status: r.status, j };
};
const F = (m, p, b, h) => req(m, `/api/v1/funnels${p}`, b, h);
const A = (m, p, b, h) => req(m, `/api/v1/health-alerts${p}`, b, h);

// JSONB normalises object-key order, so equality must be canonical.
const canon = (v) => {
  if (Array.isArray(v)) return `[${v.map(canon).join(',')}]`;
  if (v && typeof v === 'object') {
    return `{${Object.keys(v).sort().map((k) => `${JSON.stringify(k)}:${canon(v[k])}`).join(',')}}`;
  }
  return JSON.stringify(v);
};
const counts = async () => {
  const [f] = await sql`SELECT COUNT(*)::int AS n FROM funnels`;
  const [p] = await sql`SELECT COUNT(*)::int AS n FROM funnel_pages`;
  const [r] = await sql`SELECT COUNT(*)::int AS n FROM funnel_redirects`;
  return { funnels: f.n, pages: p.n, redirects: r.n };
};

// ═══════════════════════════════════════════════════════════════════════════
// SECTION 0 — the SWEEP against a database that is MISSING the tables it reads
// ═══════════════════════════════════════════════════════════════════════════
{
  let threw = null;
  let sweep = null;
  try { sweep = await alerts.runHealthAlertSweep(); } catch (e) { threw = e; }
  ok(!threw, 'S0.1 sweep does NOT throw when every source table is missing', String(threw?.message));
  const skippedChecks = (sweep?.skipped || []).map((s) => s.check).sort();
  ok(canon(skippedChecks) === canon(['needs_review', 'postback_queue_depth', 'spend_sync_stale']),
    'S0.2 all three checks are reported SKIPPED, not silently absent', JSON.stringify(sweep?.skipped));
  ok((sweep?.skipped || []).every((s) => s.reason === 'table_missing'),
    'S0.3 each skip carries the REASON table_missing', JSON.stringify(sweep?.skipped));
  ok((sweep?.errors || []).length === 0, 'S0.4 no errors recorded', JSON.stringify(sweep?.errors));
  ok((sweep?.alerts || []).length === 0, 'S0.5 no alerts invented from missing data');
}

// ═══════════════════════════════════════════════════════════════════════════
// SECTION 1 — SEED a content-heavy source funnel
// ═══════════════════════════════════════════════════════════════════════════
const MAPS_KEY = 'AIzaSyCANARY_DUPLICATE_MUST_NEVER_TRAVEL';

const src = await F('POST', '/', { name: 'Dup Source', slug: 'dup-source' });
ok(src.status === 201, 'seed: source funnel created', JSON.stringify(src.j));
const SRC = src.j?.data?.id;

const settingsPatch = await F('PATCH', `/${SRC}`, {
  settings: {
    logo_url: 'https://cdn.example.com/logo.png',
    description: 'Source description',
    brand_colors: { primary: '#0f0', secondary: '#00f' },
    fonts: { family: 'inter' },
    checkout: { address_autocomplete: true, intl_phone: true, maps_api_key: MAPS_KEY },
    custom_head_code: '<script>window.__srcPixel = 1;</script>',
  },
  seo: { site_title: 'Src Title', site_description: 'Src desc' },
});
ok(settingsPatch.status === 200, 'seed: settings written (incl. the credential)', JSON.stringify(settingsPatch.j?.error));

const BLOCKS_A = [
  { type: 'hero', props: { headline: 'Alpha headline', nested: { deep: [1, 2, { k: 'v' }] } } },
  { type: 'text', props: { body: 'Copy with "quotes" and \\n escapes' } },
];
const BLOCKS_B = [{ type: 'cta', props: { label: 'Buy now', href: '/checkout' } }];

const pa = await F('POST', `/${SRC}/pages`, { title: 'Alpha Home', slug: '/', type: 'lead' });
const pb = await F('POST', `/${SRC}/pages`, { title: 'Beta LP', slug: '/lp-b', type: 'listicle' });
const pc = await F('POST', `/${SRC}/pages`, { title: 'Gamma', slug: '/gamma', type: 'generic' });
ok(pa.status === 201 && pb.status === 201 && pc.status === 201, 'seed: three pages created');
const PA = pa.j?.data?.id, PB = pb.j?.data?.id, PC = pc.j?.data?.id;

await F('PATCH', `/${SRC}/pages/${PA}`, {
  blocks: BLOCKS_A,
  custom_css: '.alpha { color: #f00; }',
  custom_js: 'window.__alpha = true; /* verbatim */',
  head_html: '<meta name="src" content="alpha">',
  body_end_html: '<!-- alpha end -->',
  custom_html: '<div class="raw">alpha</div>',
  seo: { site_title: 'Alpha SEO', og_image: 'https://x/y.png' },
  status: 'published',
});
await F('PATCH', `/${SRC}/pages/${PB}`, { blocks: BLOCKS_B, custom_css: '.beta{}', status: 'published' });
await F('PATCH', `/${SRC}/pages/${PC}`, { blocks: [] });

const flowPatch = await F('PATCH', `/${SRC}/flow`, {
  nodes: [{ id: PA, x: 10, y: 20 }, { id: PB, x: 300, y: 20 }, { id: PC, x: 600, y: 20 }],
  edges: [{ source: PA, target: PB, kind: 'main' }, { source: PB, target: PC, kind: 'fallback' }],
});
ok(flowPatch.status === 200, 'seed: flow_layout written', JSON.stringify(flowPatch.j?.error));

const r1 = await F('POST', `/${SRC}/redirects`, { from_path: '/old-lp', to_path: '/lp-b', match: 'exact', code: 301 });
const r2 = await F('POST', `/${SRC}/redirects`, { from_path: '/legacy', to_path: '/gamma', match: 'prefix', code: 302, enabled: false });
ok(r1.status === 201 && r2.status === 201, 'seed: two redirects created', JSON.stringify([r1.j, r2.j]));

// ═══════════════════════════════════════════════════════════════════════════
// SECTION 2 — DUPLICATE
// ═══════════════════════════════════════════════════════════════════════════
let COPY = null;
{
  const before = await counts();

  const noConfirm = await F('POST', `/${SRC}/duplicate`, {});
  ok(noConfirm.status === 400, 'D1 duplicate WITHOUT confirm is refused 400', JSON.stringify(noConfirm.j));
  const wrongConfirm = await F('POST', `/${SRC}/duplicate`, { confirm: 'true' });
  ok(wrongConfirm.status === 400, "D2 confirm:'true' (a STRING) is not confirmation", JSON.stringify(wrongConfirm.j));
  const missing = await F('POST', '/fnl_does_not_exist/duplicate', { confirm: true });
  ok(missing.status === 404, 'D3 unknown funnel 404s', JSON.stringify(missing.j));

  // L1 — a non-string name is REFUSED, not coerced. String(42) named a copy
  // "42"; String({}) named one "[object Object]".
  for (const [label, value] of [['a number', 42], ['an object', { a: 1 }], ['an array', ['x']], ['a boolean', true]]) {
    // eslint-disable-next-line no-await-in-loop
    const r = await F('POST', `/${SRC}/duplicate`, { confirm: true, name: value });
    ok(r.status === 400 && /must be a string/i.test(r.j?.error || ''),
      `D4 name as ${label} is refused 400 (never coerced)`, JSON.stringify(r.j));
  }
  const blankName = await F('POST', `/${SRC}/duplicate`, { confirm: true, name: '   ' });
  ok(blankName.status === 400, 'D5 a whitespace-only name is refused', JSON.stringify(blankName.j));

  const afterRefusals = await counts();
  ok(canon(before) === canon(afterRefusals), 'D6 NOTHING was created by any refusal', `${canon(before)} vs ${canon(afterRefusals)}`);

  const noAuth = await F('POST', `/${SRC}/duplicate`, { confirm: true }, NO_AUTH);
  ok(noAuth.status === 401, 'D7 duplicate with NO token is 401', JSON.stringify(noAuth.j));

  const dup = await F('POST', `/${SRC}/duplicate`, { confirm: true });
  ok(dup.status === 201, 'D8 duplicate answers 201', JSON.stringify(dup.j));
  COPY = dup.j?.data?.funnel;

  ok(COPY?.id && COPY.id !== SRC, 'D9 the copy has a FRESH funnel id', String(COPY?.id));
  ok(COPY?.name === 'Dup Source copy', "D10 the copy is named '<name> copy'", String(COPY?.name));
  ok(COPY?.status === 'draft', 'D11 the copy is a DRAFT', String(COPY?.status));
  ok(COPY?.archived === false, 'D12 the copy is not archived', String(COPY?.archived));
  ok(COPY?.custom_domain === null, 'D13 the copy has NO custom domain', String(COPY?.custom_domain));
  ok(COPY?.slug && COPY.slug !== 'dup-source', 'D14 the copy got a FRESH slug', String(COPY?.slug));
  ok(dup.j?.data?.source_funnel_id === SRC, 'D15 the response names the source funnel', String(dup.j?.data?.source_funnel_id));

  // ── BYTE COMPARE, page by page ──────────────────────────────────────────
  const srcRows = await sql`SELECT * FROM funnel_pages WHERE funnel_id = ${SRC} ORDER BY is_home DESC, created_at ASC`;
  const copyRows = await sql`SELECT * FROM funnel_pages WHERE funnel_id = ${COPY.id} ORDER BY is_home DESC, created_at ASC`;
  ok(srcRows.length === 3 && copyRows.length === 3, 'D16 three pages on each side', `${srcRows.length} vs ${copyRows.length}`);

  let identical = true, diff = '';
  for (let i = 0; i < srcRows.length; i++) {
    const a = srcRows[i], b = copyRows[i];
    if (canon(a.blocks) !== canon(b.blocks)) { identical = false; diff = `blocks@${i}`; break; }
    if (canon(a.seo) !== canon(b.seo)) { identical = false; diff = `seo@${i}`; break; }
    for (const f of ['custom_css', 'custom_js', 'head_html', 'body_end_html', 'custom_html', 'title', 'slug', 'type', 'status', 'is_home']) {
      if (a[f] !== b[f]) { identical = false; diff = `${f}@${i} ${JSON.stringify(a[f])} vs ${JSON.stringify(b[f])}`; break; }
    }
    if (!identical) break;
  }
  ok(identical, 'D17 every page byte-matches the source (blocks, seo, all escape hatches, order)', diff);
  ok(copyRows.every((p) => ![PA, PB, PC].includes(p.id)), 'D18 every copied page has a FRESH id');
  ok(canon(srcRows.map((p) => p.slug)) === canon(copyRows.map((p) => p.slug)),
    'D19 page SLUGS are preserved (they are funnel-relative)', canon(copyRows.map((p) => p.slug)));
  ok(copyRows.filter((p) => p.is_home).length === 1, 'D20 exactly one home page on the copy');

  const srcRedirects = await sql`SELECT from_path, to_path, match, code, enabled FROM funnel_redirects WHERE funnel_id = ${SRC} ORDER BY created_at ASC`;
  const copyRedirects = await sql`SELECT from_path, to_path, match, code, enabled FROM funnel_redirects WHERE funnel_id = ${COPY.id} ORDER BY created_at ASC`;
  ok(canon(srcRedirects) === canon(copyRedirects),
    'D21 redirects byte-match the source', `${canon(srcRedirects)} vs ${canon(copyRedirects)}`);
  ok(dup.j?.data?.redirects_count === 2, 'D22 the response counts the redirects it wrote', String(dup.j?.data?.redirects_count));

  const [copyFunnelRow] = await sql`SELECT flow_layout, settings FROM funnels WHERE id = ${COPY.id}`;
  const fl = copyFunnelRow.flow_layout;
  const copyIds = new Set(copyRows.map((p) => p.id));
  ok(fl?.nodes?.length === 3 && fl?.edges?.length === 2, 'D23 the canvas layout carried (3 nodes, 2 edges)', canon(fl));
  ok(fl.nodes.every((n) => copyIds.has(n.id)) && fl.edges.every((e) => copyIds.has(e.source) && copyIds.has(e.target)),
    'D24 every layout id points at a page of the COPY, never the source', canon(fl));
  ok(canon(fl.edges.map((e) => e.kind)) === canon(['main', 'fallback']), 'D25 edge kinds survive', canon(fl.edges));

  const copySettingsText = JSON.stringify(copyFunnelRow.settings);
  ok(!copySettingsText.includes(MAPS_KEY), 'D26 the Maps API key was NOT copied', copySettingsText.slice(0, 200));
  ok(copyFunnelRow.settings?.checkout?.address_autocomplete === true,
    'D27 the checkout TOGGLES beside it did travel', canon(copyFunnelRow.settings?.checkout));
  ok(Array.isArray(dup.j?.data?.stripped) && dup.j.data.stripped.includes('settings.checkout.maps_api_key'),
    'D28 the response REPORTS the key it refused to copy', JSON.stringify(dup.j?.data?.stripped));
  ok(Array.isArray(dup.j?.data?.notes) && dup.j.data.notes.some((n) => n.includes('maps_api_key')),
    'D29 the operator-language notes name it too', JSON.stringify(dup.j?.data?.notes));

  const [srcAfter] = await sql`SELECT * FROM funnels WHERE id = ${SRC}`;
  ok(srcAfter.slug === 'dup-source' && srcAfter.archived === false && srcAfter.name === 'Dup Source',
    'D30 the SOURCE funnel row is unchanged', canon({ slug: srcAfter.slug, name: srcAfter.name }));
  ok(JSON.stringify(srcAfter.settings).includes(MAPS_KEY), 'D31 the source still holds its own credential');

  const dup2 = await F('POST', `/${SRC}/duplicate`, { confirm: true });
  ok(dup2.status === 201, 'D32 a second duplicate also answers 201', JSON.stringify(dup2.j));
  ok(dup2.j?.data?.funnel?.slug !== COPY.slug,
    'D33 the second copy is on a DIFFERENT slug', `${COPY.slug} vs ${dup2.j?.data?.funnel?.slug}`);
  ok(dup2.j?.data?.funnel?.id !== COPY.id, 'D34 the second copy is a different funnel');
}

// ── M4: ARCHIVED PAGES ARE LEFT BEHIND, AND SAID SO ───────────────────────
{
  const f = await F('POST', '/', { name: 'Has Trash', slug: 'has-trash' });
  const FID = f.j?.data?.id;
  const keep = await F('POST', `/${FID}/pages`, { title: 'Live', slug: '/', type: 'lead' });
  const gone = await F('POST', `/${FID}/pages`, { title: 'Trashed', slug: '/old', type: 'generic' });
  const arch = await F('POST', `/${FID}/pages/${gone.j?.data?.id}/archive`, { archived: true });
  ok(keep.status === 201 && arch.status === 200, 'D35 seed: one live page + one trashed page', JSON.stringify(arch.j));

  const dup = await F('POST', `/${FID}/duplicate`, { confirm: true });
  ok(dup.status === 201, 'D36 duplicate succeeds with trashed pages present', JSON.stringify(dup.j));
  ok(dup.j?.data?.pages_count === 1, 'D37 only the LIVE page was copied', String(dup.j?.data?.pages_count));
  ok((dup.j?.data?.notes || []).some((n) => /trashed page/i.test(n)),
    'D38 a NOTE says the trashed page was left behind (it would be invisible otherwise)',
    JSON.stringify(dup.j?.data?.notes));

  // …and no such note when there is nothing to report.
  const noTrash = await F('POST', `/${SRC}/duplicate`, { confirm: true });
  ok(!(noTrash.j?.data?.notes || []).some((n) => /trashed page/i.test(n)),
    'D39 no trashed-page note when the funnel has none', JSON.stringify(noTrash.j?.data?.notes));
}

// ── M4/L2: THE PAGE CAP IS CHECKED BEFORE ANY EXPORT WORK ─────────────────
{
  const f = await F('POST', '/', { name: 'Too Many', slug: 'too-many' });
  const FID = f.j?.data?.id;
  // Rows inserted directly — 101 HTTP creates would test express, not this.
  for (let i = 0; i < 101; i++) {
    // eslint-disable-next-line no-await-in-loop
    await sql`INSERT INTO funnel_pages (id, funnel_id, slug, type, title, is_home)
              VALUES (${`fpg_cap_${i}`}, ${FID}, ${`/p-${i}`}, 'generic', ${`P${i}`}, ${i === 0})`;
  }
  const before = await counts();
  const t0 = Date.now();
  const over = await F('POST', `/${FID}/duplicate`, { confirm: true });
  const elapsed = Date.now() - t0;
  ok(over.status === 413, 'D40 a funnel over the page cap is refused 413', JSON.stringify(over.j));
  ok(/101 pages/.test(over.j?.error || ''), 'D41 the refusal states the ACTUAL count', String(over.j?.error));
  ok(canon(await counts()) === canon(before), 'D42 the over-cap refusal created NOTHING');
  // The point of the pre-count: refuse before serialising ~megabytes.
  ok(elapsed < 1500, `D43 the refusal is fast (pre-count, not post-export): ${elapsed}ms`, String(elapsed));

  // A funnel with NO live pages is refused in this route's own words.
  const empty = await F('POST', '/', { name: 'No Pages', slug: 'no-pages' });
  const noneDup = await F('POST', `/${empty.j?.data?.id}/duplicate`, { confirm: true });
  ok(noneDup.status === 400 && /no pages/i.test(noneDup.j?.error || ''),
    'D44 a funnel with no pages is refused 400 in this route\'s words', JSON.stringify(noneDup.j));
}

// ── Archived source is refused ────────────────────────────────────────────
{
  const arch = await F('POST', `/${SRC}/archive`, { archived: true });
  ok(arch.status === 200, 'D45 source archived for the refusal test', JSON.stringify(arch.j));
  const before = await counts();
  const dupArchived = await F('POST', `/${SRC}/duplicate`, { confirm: true });
  ok(dupArchived.status === 400, 'D46 duplicating an ARCHIVED funnel is refused 400', JSON.stringify(dupArchived.j));
  ok(/archived/i.test(dupArchived.j?.error || ''), 'D47 the refusal says why', String(dupArchived.j?.error));
  ok(canon(await counts()) === canon(before), 'D48 the archived refusal created NOTHING');
}

// ═══════════════════════════════════════════════════════════════════════════
// SECTION 3 — RESTORE  (SRC is archived, left that way by D45)
// ═══════════════════════════════════════════════════════════════════════════
{
  const noConfirm = await F('POST', `/${SRC}/restore`, {});
  ok(noConfirm.status === 400, 'R1 restore WITHOUT confirm is refused 400', JSON.stringify(noConfirm.j));
  const [stillArchived] = await sql`SELECT archived FROM funnels WHERE id = ${SRC}`;
  ok(stillArchived.archived === true, 'R2 the refusal left the funnel archived');

  const missing = await F('POST', '/fnl_nope/restore', { confirm: true });
  ok(missing.status === 404, 'R3 restoring an unknown funnel 404s', JSON.stringify(missing.j));

  const noAuth = await F('POST', `/${SRC}/restore`, { confirm: true }, NO_AUTH);
  ok(noAuth.status === 401, 'R4 restore with NO token is 401', JSON.stringify(noAuth.j));

  const res = await F('POST', `/${SRC}/restore`, { confirm: true });
  ok(res.status === 200, 'R5 restore answers 200', JSON.stringify(res.j));
  ok(res.j?.data?.restored === true, 'R6 the response says it was restored', canon(res.j?.data));
  ok(res.j?.data?.slug_changed === false, 'R7 the slug did NOT change');
  ok(res.j?.data?.funnel?.slug === 'dup-source', 'R8 the ORIGINAL slug came back', String(res.j?.data?.funnel?.slug));
  ok(res.j?.data?.funnel?.archived === false, 'R9 archived is cleared');
  ok(canon(res.j?.data?.notes) === canon([]), 'R10 no notes when nothing was rewritten', canon(res.j?.data?.notes));

  const again = await F('POST', `/${SRC}/restore`, { confirm: true });
  ok(again.status === 200, 'R11 restoring an already-live funnel answers 200', JSON.stringify(again.j));
  ok(again.j?.data?.restored === false, 'R12 …and reports restored:false rather than pretending');
  ok(again.j?.data?.funnel?.slug === 'dup-source', 'R13 …and did NOT re-slug the live funnel', String(again.j?.data?.funnel?.slug));

  const victim = await F('POST', '/', { name: 'Collide Me', slug: 'collide-me' });
  ok(victim.status === 201, 'R14 collision seed funnel created', JSON.stringify(victim.j));
  const VICTIM = victim.j?.data?.id;
  await F('POST', `/${VICTIM}/archive`, { archived: true });

  const usurper = await F('POST', '/', { name: 'Took The Slug', slug: 'collide-me' });
  ok(usurper.status === 201, 'R15 a NEW live funnel took the freed slug', JSON.stringify(usurper.j));
  const USURPER = usurper.j?.data?.id;

  const legacy = await F('POST', `/${VICTIM}/archive`, { archived: false });
  ok(legacy.status === 409, 'R16 (control) the OLD archive route still 409s on this collision', JSON.stringify(legacy.j));

  const restored = await F('POST', `/${VICTIM}/restore`, { confirm: true });
  ok(restored.status === 200, 'R17 restore SUCCEEDS where the archive route refused', JSON.stringify(restored.j));
  ok(restored.j?.data?.restored === true, 'R18 it reports restored:true');
  ok(restored.j?.data?.slug_changed === true, 'R19 it reports the slug CHANGED');
  const newSlug = restored.j?.data?.funnel?.slug;
  ok(typeof newSlug === 'string' && newSlug !== 'collide-me' && newSlug.startsWith('collide-me-'),
    'R20 the restored funnel is on a SUFFIXED slug', String(newSlug));
  ok(Array.isArray(restored.j?.data?.notes) && restored.j.data.notes.some((n) => n.includes(newSlug) && n.includes('collide-me')),
    'R21 a NOTE names both the old and the new slug', JSON.stringify(restored.j?.data?.notes));

  const [usurperRow] = await sql`SELECT slug, archived FROM funnels WHERE id = ${USURPER}`;
  ok(usurperRow.slug === 'collide-me' && usurperRow.archived === false,
    'R22 the funnel that TOOK the slug was not disturbed', canon(usurperRow));
  const [victimRow] = await sql`SELECT slug, archived FROM funnels WHERE id = ${VICTIM}`;
  ok(victimRow.archived === false && victimRow.slug === newSlug, 'R23 the DB agrees with the response', canon(victimRow));

  const del = await F('DELETE', `/${VICTIM}`, undefined);
  ok(del.status === 404, 'R24 there is NO permanent-delete endpoint (DELETE /funnels/:id 404s)', String(del.status));
  const [stillThere] = await sql`SELECT COUNT(*)::int AS n FROM funnels WHERE id = ${VICTIM}`;
  ok(stillThere.n === 1, 'R25 the funnel still exists — nothing in this lane destroys a row');
}

// ═══════════════════════════════════════════════════════════════════════════
// SECTION 4 — HEALTH ALERTS: THE ROLE MATRIX
// ═══════════════════════════════════════════════════════════════════════════
{
  // Seed one alert so ack has a real target.
  const seed = await alerts.recordAlert('matrix_probe', 'info', 'For the role matrix', {}, { cooldownMs: 0 });
  const TARGET = seed.alert.id;

  const anon = await A('GET', '/', undefined, NO_AUTH);
  ok(anon.status === 401, 'A1 GET / with no token is 401', JSON.stringify(anon.j));
  const anonAck = await A('POST', `/${TARGET}/ack`, {}, NO_AUTH);
  ok(anonAck.status === 401, 'A2 POST /:id/ack with no token is 401', JSON.stringify(anonAck.j));
  const anonSweep = await A('POST', '/sweep', {}, NO_AUTH);
  ok(anonSweep.status === 401, 'A3 POST /sweep with no token is 401', JSON.stringify(anonSweep.j));

  // ── Team - Full Access: read AND write ──────────────────────────────────
  const fullList = await A('GET', '/', undefined, asUser(TOKEN));
  ok(fullList.status === 200, 'A4 Full Access can READ the feed', String(fullList.status));
  const fullMeta = await A('GET', '/meta', undefined, asUser(TOKEN));
  ok(fullMeta.status === 200, 'A5 Full Access can read /meta', String(fullMeta.status));
  const fullSweep = await A('POST', '/sweep', {}, asUser(TOKEN));
  ok(fullSweep.status === 200, 'A6 Full Access can run /sweep', String(fullSweep.status));

  // ── Manager: read ONLY ──────────────────────────────────────────────────
  const mgrList = await A('GET', '/', undefined, asUser(TOKEN_MGR));
  ok(mgrList.status === 200, 'A7 Manager CAN read the feed (health-alerts:read)', String(mgrList.status));
  const mgrMeta = await A('GET', '/meta', undefined, asUser(TOKEN_MGR));
  ok(mgrMeta.status === 200, 'A8 Manager can read /meta', String(mgrMeta.status));
  const mgrAck = await A('POST', `/${TARGET}/ack`, {}, asUser(TOKEN_MGR));
  ok(mgrAck.status === 403, 'A9 Manager CANNOT ack (read ≠ ack)', JSON.stringify(mgrAck.j));
  const mgrSweep = await A('POST', '/sweep', {}, asUser(TOKEN_MGR));
  ok(mgrSweep.status === 403, 'A10 Manager CANNOT run /sweep (it WRITES alerts)', JSON.stringify(mgrSweep.j));

  // ── Viewer: NOTHING. This is the documented behaviour change: the feed
  //    moved off audit:read, which Viewer holds, onto health-alerts:read,
  //    which it deliberately does not. ────────────────────────────────────
  const viewList = await A('GET', '/', undefined, asUser(TOKEN_VIEW));
  ok(viewList.status === 403, 'A11 Viewer CANNOT read the feed — DOCUMENTED CHANGE (was audit:read)', JSON.stringify(viewList.j));
  const viewAck = await A('POST', `/${TARGET}/ack`, {}, asUser(TOKEN_VIEW));
  ok(viewAck.status === 403, 'A12 Viewer CANNOT ack', JSON.stringify(viewAck.j));
  const viewSweep = await A('POST', '/sweep', {}, asUser(TOKEN_VIEW));
  ok(viewSweep.status === 403, 'A13 Viewer CANNOT run /sweep', JSON.stringify(viewSweep.j));
  // Viewer still holds audit:read — so the 403 above is the NEW gate biting,
  // not the token being broken.
  const [viewRole] = await sql`SELECT permissions FROM roles WHERE name = 'Viewer'`;
  ok(JSON.stringify(viewRole.permissions.audit) === '["read"]',
    'A14 …and Viewer still holds audit:read, so A11 is the new gate, not a broken token');

  await sql`DELETE FROM lb_health_alerts`;
}

// ═══════════════════════════════════════════════════════════════════════════
// SECTION 5 — HEALTH ALERTS: RECORD / COOLDOWN / LIST / ACK
// ═══════════════════════════════════════════════════════════════════════════
{
  const empty = await A('GET', '/');
  ok(empty.status === 200, 'A15 the list answers 200 on an empty table', JSON.stringify(empty.j));
  ok(canon(empty.j?.data?.items) === canon([]) && empty.j?.data?.total === 0 && empty.j?.data?.unacked === 0,
    'A16 empty means items:[] total:0 unacked:0 — never a null', canon(empty.j?.data));

  let sevThrew = null;
  try { await alerts.recordAlert('bad_sev', 'catastrophic', 'nope'); } catch (e) { sevThrew = e; }
  ok(sevThrew instanceof TypeError, 'A17 recordAlert THROWS on an unknown severity', String(sevThrew));
  let kindThrew = null;
  try { await alerts.recordAlert('   ', 'warn', 'nope'); } catch (e) { kindThrew = e; }
  ok(kindThrew instanceof TypeError, 'A18 recordAlert THROWS on an empty kind', String(kindThrew));
  const [{ n: afterThrows }] = await sql`SELECT COUNT(*)::int AS n FROM lb_health_alerts`;
  ok(afterThrows === 0, 'A19 neither throw wrote a row', String(afterThrows));

  const badFilter = await A('GET', '/?severity=urgent');
  ok(badFilter.status === 400 && badFilter.j?.error?.code === 'invalid_severity',
    'A20 an unknown severity FILTER is 400 invalid_severity', JSON.stringify(badFilter.j));

  const rec1 = await alerts.recordAlert('unit_info', 'info', 'An informational thing happened', { a: 1 });
  ok(rec1.created === true && rec1.alert?.id?.startsWith('hal_'), 'A21 recordAlert creates a row', canon(rec1));
  ok(rec1.alert.acked_at === null && rec1.alert.acked_by === null, 'A22 a new alert is UNACKED');
  ok(canon(rec1.alert.context) === canon({ a: 1 }), 'A23 context round-trips as an OBJECT, not a JSON string', canon(rec1.alert.context));

  const rec1b = await alerts.recordAlert('unit_info', 'info', 'The same thing, again', { a: 2 });
  ok(rec1b.created === false && rec1b.reason === 'cooldown', 'A24 a second alert of the SAME kind is suppressed', canon(rec1b));
  ok(rec1b.suppressed_by === rec1.alert.id, 'A25 the suppression NAMES the row that won', String(rec1b.suppressed_by));
  const rec1c = await alerts.recordAlert('unit_info', 'info', 'Cooldown waived', { a: 3 }, { cooldownMs: 0 });
  ok(rec1c.created === true, 'A26 cooldownMs:0 waives the suppression', canon(rec1c));

  // ── M1: THE COOLDOWN IS SCOPED ──────────────────────────────────────────
  // Two funnels' breakers opening inside one window are TWO faults. Keying the
  // cooldown on `kind` alone swallowed every subject after the first.
  const bA1 = await alerts.recordAlert('breaker_open', 'critical', 'Funnel A breaker opened', { fails: 5 }, { scopeId: 'fnl_aaa' });
  const bB1 = await alerts.recordAlert('breaker_open', 'critical', 'Funnel B breaker opened', { fails: 5 }, { scopeId: 'fnl_bbb' });
  const bA2 = await alerts.recordAlert('breaker_open', 'critical', 'Funnel A again', { fails: 6 }, { scopeId: 'fnl_aaa' });
  ok(bA1.created === true, 'A27 first subject records');
  ok(bB1.created === true, 'A28 a DIFFERENT subject of the SAME kind ALSO records (scoped cooldown)', canon(bB1));
  ok(bA2.created === false && bA2.suppressed_by === bA1.alert.id,
    'A29 the SAME subject inside the window is still suppressed', canon(bA2));
  ok(bA1.alert.context?.scope_id === 'fnl_aaa' && bB1.alert.context?.scope_id === 'fnl_bbb',
    'A30 scope_id is stored on the row, so a reader can see what it was about',
    canon([bA1.alert.context, bB1.alert.context]));
  // The parameter WINS over a scope_id smuggled in the context blob.
  const bC = await alerts.recordAlert('breaker_open', 'critical', 'C', { scope_id: 'LIAR' }, { scopeId: 'fnl_ccc' });
  ok(bC.created === true && bC.alert.context.scope_id === 'fnl_ccc',
    'A31 the scopeId PARAMETER overrides a scope_id in the context blob', canon(bC.alert.context));
  const [{ n: breakerRows }] = await sql`SELECT COUNT(*)::int AS n FROM lb_health_alerts WHERE kind = 'breaker_open'`;
  ok(breakerRows === 3, 'A32 three subjects → three rows, one suppressed repeat', String(breakerRows));

  // ── Context cap ─────────────────────────────────────────────────────────
  const huge = { blob: 'x'.repeat(alerts.MAX_CONTEXT_BYTES + 5000) };
  const recHuge = await alerts.recordAlert('unit_huge', 'warn', 'Oversized context', huge);
  ok(recHuge.created === true, 'A33 an oversized context does not cost the alert');
  ok(recHuge.alert.context?.context_too_large === true && !('blob' in recHuge.alert.context),
    'A34 the context is REPLACED with an honest marker, never half a document', canon(recHuge.alert.context));

  // ── Paging ──────────────────────────────────────────────────────────────
  for (let i = 0; i < 8; i++) {
    // eslint-disable-next-line no-await-in-loop
    await alerts.recordAlert(`unit_page_${i}`, i % 2 ? 'warn' : 'critical', `Paged alert ${i}`, { i });
  }
  const all = await A('GET', '/?limit=200');
  const TOTAL = all.j?.data?.total;
  ok(TOTAL === 14, 'A35 14 alerts recorded in total', String(TOTAL));
  ok(all.j.data.unacked === 14, 'A36 all 14 are unacked', String(all.j.data.unacked));

  const p1 = await A('GET', '/?limit=5&offset=0');
  const p2 = await A('GET', '/?limit=5&offset=5');
  const p3 = await A('GET', '/?limit=5&offset=10');
  ok(p1.j.data.items.length === 5 && p2.j.data.items.length === 5 && p3.j.data.items.length === 4,
    'A37 paging returns 5 / 5 / 4', canon([p1.j.data.items.length, p2.j.data.items.length, p3.j.data.items.length]));
  ok(p1.j.data.has_more === true && p2.j.data.has_more === true && p3.j.data.has_more === false,
    'A38 has_more is true, true, false', canon([p1.j.data.has_more, p2.j.data.has_more, p3.j.data.has_more]));
  const pagedIds = [...p1.j.data.items, ...p2.j.data.items, ...p3.j.data.items].map((a) => a.id);
  ok(new Set(pagedIds).size === 14, 'A39 the three pages are disjoint and cover everything', String(new Set(pagedIds).size));

  const over = await A('GET', '/?limit=99999');
  ok(over.j?.data?.limit === alerts.MAX_PAGE_LIMIT, 'A40 an absurd limit is CLAMPED', String(over.j?.data?.limit));
  const negative = await A('GET', '/?limit=-4&offset=-9');
  ok(negative.status === 200 && negative.j?.data?.limit >= 1 && negative.j?.data?.offset === 0,
    'A41 negative paging params do not produce a SQL error', canon({ l: negative.j?.data?.limit, o: negative.j?.data?.offset }));
  const garbage = await A('GET', '/?limit=abc&offset=xyz');
  ok(garbage.status === 200 && garbage.j?.data?.limit === alerts.DEFAULT_PAGE_LIMIT,
    'A42 non-numeric paging params fall back to the DEFAULT', canon({ l: garbage.j?.data?.limit }));
  const farOffset = await A('GET', `/?offset=${alerts.MAX_PAGE_OFFSET + 5000}`);
  ok(farOffset.status === 200 && farOffset.j?.data?.offset === alerts.MAX_PAGE_OFFSET,
    'A43 a runaway offset is CAPPED, not handed to the planner', String(farOffset.j?.data?.offset));

  // L6 — `limit: null` from a direct caller means "the default", not 1. The old
  // parse turned Number(null)===0 into a clamped 1 and served a single row.
  const nullLimit = await alerts.listAlerts({ limit: null, offset: null });
  ok(nullLimit.limit === alerts.DEFAULT_PAGE_LIMIT && nullLimit.offset === 0,
    'A44 listAlerts({limit:null}) uses the DEFAULT, not 1', canon({ l: nullLimit.limit, o: nullLimit.offset }));

  const crit = await A('GET', '/?severity=critical&limit=200');
  ok(crit.j.data.items.every((a) => a.severity === 'critical'), 'A45 the severity filter filters');
  ok(crit.j.data.unacked === 14,
    'A46 `unacked` is the WHOLE surface and does not shrink with the filter', String(crit.j.data.unacked));

  // ── ACK ─────────────────────────────────────────────────────────────────
  const target = rec1.alert.id;
  const ack1 = await A('POST', `/${target}/ack`, {});
  ok(ack1.status === 200, 'A47 ack answers 200', JSON.stringify(ack1.j));
  ok(ack1.j?.data?.already_acked === false, 'A48 …and reports it was a first ack');
  ok(ack1.j?.data?.alert?.acked_at, 'A49 acked_at is stamped');
  ok(ack1.j?.data?.alert?.acked_by === 'u_full', 'A50 acked_by is the AUTHENTICATED user, not the body', String(ack1.j?.data?.alert?.acked_by));

  const ack2 = await A('POST', `/${target}/ack`, {});
  ok(ack2.status === 200, 'A51 a SECOND ack is 200, not 404 or 409 (idempotent)', JSON.stringify(ack2.j));
  ok(ack2.j?.data?.already_acked === true, 'A52 …and says so');
  ok(ack2.j?.data?.alert?.acked_at === ack1.j?.data?.alert?.acked_at,
    'A53 the ORIGINAL acked_at is preserved', `${ack1.j?.data?.alert?.acked_at} vs ${ack2.j?.data?.alert?.acked_at}`);
  ok(ack2.j?.data?.alert?.acked_by === 'u_full', 'A54 …and so is the original acked_by');

  const ackMissing = await A('POST', '/hal_not_a_real_id/ack', {});
  ok(ackMissing.status === 404 && ackMissing.j?.error?.code === 'alert_not_found',
    'A55 acking an unknown id is 404 — NOT conflated with already-acked', JSON.stringify(ackMissing.j));

  // L6 — an ack with no acking user is refused at the SERVICE, so a future
  // unauthenticated mount cannot start writing anonymous acknowledgements.
  const anonAck = await alerts.ackAlert(rec1c.alert.id, undefined);
  ok(anonAck.ok === false && anonAck.status === 401 && anonAck.error === 'acking_user_required',
    'A56 ackAlert refuses when there is no acking user', canon(anonAck));
  const [stillUnacked] = await sql`SELECT acked_at FROM lb_health_alerts WHERE id = ${rec1c.alert.id}`;
  ok(stillUnacked.acked_at === null, 'A57 …and the refusal wrote nothing');

  const ordered = await A('GET', '/?limit=200');
  const firstAcked = ordered.j.data.items.findIndex((a) => a.acked_at);
  ok(firstAcked === ordered.j.data.items.length - 1,
    'A58 the single acked alert sorts LAST — unacked first, regardless of age', String(firstAcked));
  ok(ordered.j.data.unacked === 13, 'A59 the unacked count dropped by exactly one', String(ordered.j.data.unacked));

  const onlyUnacked = await A('GET', '/?acked=false&limit=200');
  ok(onlyUnacked.j.data.items.every((a) => !a.acked_at) && onlyUnacked.j.data.items.length === 13,
    'A60 ?acked=false returns only unacked', String(onlyUnacked.j.data.items.length));
  const onlyAcked = await A('GET', '/?acked=true&limit=200');
  ok(onlyAcked.j.data.items.length === 1 && onlyAcked.j.data.items[0].id === target,
    'A61 ?acked=true returns only the acked one', String(onlyAcked.j.data.items.length));

  const meta = await A('GET', '/meta');
  ok(canon(meta.j?.data?.severities) === canon(['info', 'warn', 'critical']),
    'A62 /meta serves the severity vocabulary the client badges against', canon(meta.j?.data?.severities));
}

// ═══════════════════════════════════════════════════════════════════════════
// SECTION 6 — M5: THE COOLDOWN UNDER REAL CONCURRENCY
//
// FOUR SEPARATE OS PROCESSES, four separate connections, one kind+scope, all
// launched together. A read-then-insert cooldown writes up to four rows here
// (each transaction's snapshot predates the others' inserts). Exactly one is
// the only acceptable answer.
// ═══════════════════════════════════════════════════════════════════════════
{
  await sql`DELETE FROM lb_health_alerts WHERE kind = 'contended_kind'`;
  const SELF = fileURLToPath(import.meta.url);
  const runWorker = (n) => new Promise((resolve) => {
    const p = spawn(process.execPath, [SELF, '--record-worker', 'contended_kind', 'scope_x', String(n)], {
      cwd: REPO, stdio: ['ignore', 'pipe', 'pipe'],
    });
    let out = '';
    let err = '';
    p.stdout.on('data', (d) => { out += d; });
    p.stderr.on('data', (d) => { err += d; });
    p.on('close', (code) => resolve({ code, out: out.trim(), err: err.trim() }));
  });

  const results = await Promise.all([runWorker(1), runWorker(2), runWorker(3), runWorker(4)]);
  const failed = results.filter((r) => r.code !== 0);
  ok(failed.length === 0, 'C1 all four worker processes exited cleanly', JSON.stringify(failed.map((f) => f.err.slice(-300))));

  const [{ n: rows }] = await sql`SELECT COUNT(*)::int AS n FROM lb_health_alerts WHERE kind = 'contended_kind'`;
  ok(rows === 1, `C2 four concurrent processes produced EXACTLY ONE row (got ${rows})`, String(rows));

  // The worker's stdout also carries dotenv's startup tip, so the JSON is the
  // LAST line, not the whole stream.
  const lastLine = (s) => s.split('\n').map((l) => l.trim()).filter(Boolean).pop() || '';
  const createdCount = results
    .map((r) => { try { return JSON.parse(lastLine(r.out)).created; } catch { return null; } })
    .filter((c) => c === true).length;
  const suppressedCount = results
    .map((r) => { try { return JSON.parse(lastLine(r.out)).created; } catch { return null; } })
    .filter((c) => c === false).length;
  ok(createdCount === 1, `C3 exactly one process REPORTED creating it (got ${createdCount})`,
    JSON.stringify(results.map((r) => r.out)));
  ok(suppressedCount === 3, `C3b the other three REPORTED suppression (got ${suppressedCount})`,
    JSON.stringify(results.map((r) => lastLine(r.out))));

  // A different SCOPE must still get through while that window is open —
  // exclusivity must not have become a global lock.
  const other = await alerts.recordAlert('contended_kind', 'critical', 'different subject', {}, { scopeId: 'scope_y' });
  ok(other.created === true, 'C4 a different scope is NOT blocked by the other scope\'s window', canon(other));

  await sql`DELETE FROM lb_health_alerts`;
}

// ═══════════════════════════════════════════════════════════════════════════
// SECTION 7 — THE SWEEP, against REAL seeded state
// ═══════════════════════════════════════════════════════════════════════════
{
  await sql`CREATE TABLE IF NOT EXISTS lb_spend_sync_state (
    source TEXT PRIMARY KEY, last_sync TIMESTAMPTZ, last_attempt TIMESTAMPTZ,
    last_ok BOOLEAN, error TEXT, fail_streak INT NOT NULL DEFAULT 0,
    state JSONB NOT NULL DEFAULT '{}', updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
  )`;
  await sql`CREATE TABLE IF NOT EXISTS lb_postback_queue (
    id TEXT PRIMARY KEY, funnel_id TEXT, scope_id TEXT NOT NULL DEFAULT '',
    status TEXT NOT NULL DEFAULT 'queued', envelope JSONB NOT NULL DEFAULT '{}',
    pixel_row_id TEXT, url TEXT, attempts INT NOT NULL DEFAULT 0,
    next_at TIMESTAMPTZ NOT NULL DEFAULT NOW(), claimed_at TIMESTAMPTZ,
    last_error TEXT, created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
  )`;
  await sql`CREATE TABLE IF NOT EXISTS co_sessions (
    id TEXT PRIMARY KEY, status TEXT NOT NULL DEFAULT 'processing',
    needs_review_reason TEXT, created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
  )`;

  await sql`INSERT INTO lb_spend_sync_state (source, last_sync, last_attempt, last_ok, fail_streak)
            VALUES ('meta_fresh', NOW() - INTERVAL '1 hour', NOW(), TRUE, 0)`;
  await sql`INSERT INTO lb_spend_sync_state (source, last_sync, last_attempt, last_ok, fail_streak)
            VALUES ('meta_stale', NOW() - INTERVAL '36 hours', NOW(), FALSE, 7)`;

  await alerts._resetSweepState();
  const s1 = await alerts.runHealthAlertSweep();
  ok((s1.errors || []).length === 0, 'S1.1 the sweep ran clean', JSON.stringify(s1.errors));
  ok(s1.anchored === true, 'S1.2 a default sweep ANCHORS', String(s1.anchored));

  const stale = s1.alerts.filter((a) => a.kind.startsWith('spend_sync_stale:'));
  ok(stale.length === 1, 'S1.3 EXACTLY ONE stale-spend alert — the healthy feed did not fire', JSON.stringify(s1.alerts.map((a) => a.kind)));
  ok(stale[0]?.kind === 'spend_sync_stale:meta_stale', 'S1.4 the alert NAMES the failing source', String(stale[0]?.kind));
  ok(stale[0]?.severity === 'warn', 'S1.5 severity is warn', String(stale[0]?.severity));
  ok(stale[0]?.context?.fail_streak === 7 && Number(stale[0]?.context?.hours_stale) >= 35,
    'S1.6 the context carries the measured staleness and streak', canon(stale[0]?.context));
  ok(stale[0]?.context?.scope_id === 'meta_stale', 'S1.7 …and the scope names the feed', canon(stale[0]?.context?.scope_id));

  ok(s1.alerts.every((a) => a.kind !== 'needs_review_rising'),
    'S1.8 the first sweep raises NO needs_review RISE (a count is not a trend)', JSON.stringify(s1.alerts.map((a) => a.kind)));
  ok((s1.skipped || []).some((s) => s.check === 'needs_review_rising' && s.reason === 'baseline_only'),
    'S1.9 …and says WHY: baseline_only', JSON.stringify(s1.skipped));
  ok(s1.observations?.needs_review?.count === 0 && s1.observations?.needs_review?.previous === null,
    'S1.10 the baseline observation is reported', canon(s1.observations?.needs_review));

  ok(s1.observations?.postback_queue_depth === 0, 'S1.11 queue depth observed as 0');
  ok(s1.alerts.every((a) => a.kind !== 'postback_queue_depth'), 'S1.12 an empty queue raises nothing');

  const s2 = await alerts.runHealthAlertSweep();
  ok(s2.alerts.every((a) => !a.kind.startsWith('spend_sync_stale:')),
    'S2.1 the still-stale feed does NOT write a second row', JSON.stringify(s2.alerts.map((a) => a.kind)));
  ok((s2.skipped || []).some((s) => s.check === 'spend_sync_stale:meta_stale' && s.reason === 'cooldown'),
    'S2.2 …and the suppression is reported as a cooldown', JSON.stringify(s2.skipped));
  const [{ n: staleRows }] = await sql`SELECT COUNT(*)::int AS n FROM lb_health_alerts WHERE kind = 'spend_sync_stale:meta_stale'`;
  ok(staleRows === 1, 'S2.3 the table holds exactly ONE row for that source', String(staleRows));

  for (let i = 0; i < 105; i++) {
    // eslint-disable-next-line no-await-in-loop
    await sql`INSERT INTO lb_postback_queue (id, status) VALUES (${`pbq_${i}`}, ${i < 3 ? 'done' : 'queued'})`;
  }
  const s3 = await alerts.runHealthAlertSweep();
  ok(s3.observations?.postback_queue_depth === 102,
    'S3.1 depth counts queued+sending only — the 3 done rows are excluded', String(s3.observations?.postback_queue_depth));
  const depthAlert = s3.alerts.find((a) => a.kind === 'postback_queue_depth');
  ok(depthAlert, 'S3.2 crossing the threshold raises an alert', JSON.stringify(s3.alerts.map((a) => a.kind)));
  ok(depthAlert?.context?.depth === 102 && depthAlert?.context?.threshold === 100,
    'S3.3 the context carries the measurement AND the threshold', canon(depthAlert?.context));
}

// ═══════════════════════════════════════════════════════════════════════════
// SECTION 8 — M2: THE BASELINE IS PERSISTED, AND THE FLOOR NEEDS NO BASELINE
// ═══════════════════════════════════════════════════════════════════════════
{
  await sql`DELETE FROM lb_health_alerts`;
  await sql`DELETE FROM co_sessions`;
  await alerts._resetSweepState();

  // 40 sessions waiting. Below the floor (50), and with no baseline yet.
  for (let i = 0; i < 40; i++) {
    // eslint-disable-next-line no-await-in-loop
    await sql`INSERT INTO co_sessions (id, needs_review_reason) VALUES (${`cos_a_${i}`}, 'settlement')`;
  }
  const b1 = await alerts.runHealthAlertSweep({ anchor: true });
  ok(b1.observations?.needs_review?.count === 40 && b1.observations?.needs_review?.previous === null,
    'M2.1 first anchored sweep observes 40 with no previous', canon(b1.observations?.needs_review));
  ok(b1.alerts.every((a) => a.kind !== 'needs_review_rising'), 'M2.2 no rise alert without a baseline');
  const [stateRow] = await sql`SELECT state FROM lb_health_alert_state WHERE kind = 'needs_review'`;
  ok(Number(stateRow?.state?.count) === 40, 'M2.3 the baseline was PERSISTED to lb_health_alert_state', canon(stateRow?.state));

  // ── SIMULATE A RESTART ──────────────────────────────────────────────────
  // A fresh module instance — every module-level variable reset, exactly as
  // after a deploy. The OLD implementation kept the baseline in a module
  // variable, so this instance would have started from `null`, re-baselined at
  // 200, and NEVER reported the climb. The state table is what survives.
  const fresh = await import(`../../src/services/healthAlerts.js?restart=${Date.now()}`);
  for (let i = 0; i < 160; i++) {
    // eslint-disable-next-line no-await-in-loop
    await sql`INSERT INTO co_sessions (id, needs_review_reason) VALUES (${`cos_b_${i}`}, 'webhook')`;
  }
  const b2 = await fresh.runHealthAlertSweep({ anchor: true });
  ok(b2.observations?.needs_review?.previous === 40,
    'M2.4 a RESTARTED process reads the persisted baseline (40), not null', canon(b2.observations?.needs_review));
  const rise = b2.alerts.find((a) => a.kind === 'needs_review_rising');
  ok(rise, 'M2.5 the 40 → 200 climb IS reported across the restart', JSON.stringify(b2.alerts.map((a) => a.kind)));
  ok(rise?.context?.delta === 160 && rise?.context?.previous === 40 && rise?.context?.count === 200,
    'M2.6 the context carries previous, count and delta', canon(rise?.context));

  // ── THE FLOOR fires with NO baseline at all ─────────────────────────────
  const floorAlert = b2.alerts.find((a) => a.kind === 'needs_review_backlog');
  ok(floorAlert, 'M2.7 the absolute FLOOR also fired (200 > 50)', JSON.stringify(b2.alerts.map((a) => a.kind)));
  ok(floorAlert?.context?.count === 200 && floorAlert?.context?.floor === alerts.NEEDS_REVIEW_FLOOR,
    'M2.8 the floor alert carries the count and the floor it was judged against', canon(floorAlert?.context));

  // The floor is INDEPENDENT of the baseline: wipe the state and it still fires
  // on a brand-new process, which is the whole point — a standing backlog that
  // has stopped growing must not become invisible.
  await sql`DELETE FROM lb_health_alerts`;
  await alerts._resetSweepState();
  const b3 = await alerts.runHealthAlertSweep({ anchor: true });
  ok(b3.alerts.some((a) => a.kind === 'needs_review_backlog'),
    'M2.9 with NO baseline the FLOOR still fires — a standing backlog is never invisible',
    JSON.stringify(b3.alerts.map((a) => a.kind)));
  ok(b3.alerts.every((a) => a.kind !== 'needs_review_rising'), 'M2.10 …while the RISE correctly stays silent');

  // A FALLING count must never alert — the rise check is directional.
  await sql`DELETE FROM co_sessions WHERE id LIKE 'cos_b_%'`;
  await sql`DELETE FROM lb_health_alerts`;
  const b4 = await alerts.runHealthAlertSweep({ anchor: true });
  ok(b4.observations?.needs_review?.count === 40 && b4.observations?.needs_review?.previous === 200,
    'M2.11 a FALL is observed', canon(b4.observations?.needs_review));
  ok(b4.alerts.every((a) => a.kind !== 'needs_review_rising'), 'M2.12 …and raises no rise alert');
  ok(b4.alerts.every((a) => a.kind !== 'needs_review_backlog'), 'M2.13 …and 40 is under the floor, so no backlog alert either');
}

// ═══════════════════════════════════════════════════════════════════════════
// SECTION 9 — M3: DRY (the panel's refresh) DOES NOT RE-ANCHOR
// ═══════════════════════════════════════════════════════════════════════════
{
  await sql`DELETE FROM lb_health_alerts`;
  await sql`DELETE FROM co_sessions`;
  await alerts._resetSweepState();
  for (let i = 0; i < 10; i++) {
    // eslint-disable-next-line no-await-in-loop
    await sql`INSERT INTO co_sessions (id, needs_review_reason) VALUES (${`cos_d_${i}`}, 'settlement')`;
  }
  await alerts.runHealthAlertSweep({ anchor: true }); // baseline = 10
  const [base] = await sql`SELECT state FROM lb_health_alert_state WHERE kind = 'needs_review'`;
  ok(Number(base.state.count) === 10, 'M3.1 baseline anchored at 10', canon(base.state));

  for (let i = 0; i < 12; i++) {
    // eslint-disable-next-line no-await-in-loop
    await sql`INSERT INTO co_sessions (id, needs_review_reason) VALUES (${`cos_e_${i}`}, 'webhook')`;
  }

  // The PANEL's refresh — default dry.
  const dry = await A('POST', '/sweep', {});
  ok(dry.status === 200, 'M3.2 POST /sweep answers 200', JSON.stringify(dry.j).slice(0, 200));
  ok(dry.j?.data?.anchored === false, 'M3.3 …and reports anchored:false by default (dry)', String(dry.j?.data?.anchored));
  ok((dry.j?.data?.alerts || []).some((a) => a.kind === 'needs_review_rising'),
    'M3.4 a DRY sweep still EVALUATES and still WRITES the alert it earned',
    JSON.stringify((dry.j?.data?.alerts || []).map((a) => a.kind)));
  const [afterDry] = await sql`SELECT state FROM lb_health_alert_state WHERE kind = 'needs_review'`;
  ok(Number(afterDry.state.count) === 10,
    'M3.5 …but the baseline is UNMOVED — a refresh cannot consume the comparison point', canon(afterDry.state));

  // Three more refreshes must not walk the baseline forward either.
  await A('POST', '/sweep', {});
  await A('POST', '/sweep', {});
  const [afterThree] = await sql`SELECT state FROM lb_health_alert_state WHERE kind = 'needs_review'`;
  ok(Number(afterThree.state.count) === 10,
    'M3.6 repeated refreshes still do not anchor (the 10→22 rise stays reportable)', canon(afterThree.state));

  // ?dry=0 anchors deliberately.
  const wet = await A('POST', '/sweep?dry=0', {});
  ok(wet.j?.data?.anchored === true, 'M3.7 ?dry=0 reports anchored:true', String(wet.j?.data?.anchored));
  const [afterWet] = await sql`SELECT state FROM lb_health_alert_state WHERE kind = 'needs_review'`;
  ok(Number(afterWet.state.count) === 22, 'M3.8 …and MOVES the baseline to 22', canon(afterWet.state));
}

// ═══════════════════════════════════════════════════════════════════════════
// SECTION 10 — empty-but-present source tables
// ═══════════════════════════════════════════════════════════════════════════
{
  await sql`DELETE FROM lb_spend_sync_state`;
  await sql`DELETE FROM lb_postback_queue`;
  await sql`DELETE FROM co_sessions`;
  await sql`DELETE FROM lb_health_alerts`;
  await alerts._resetSweepState();
  const s = await alerts.runHealthAlertSweep({ anchor: true });
  ok(s.alerts.length === 0 && s.errors.length === 0,
    'E1 empty (but present) source tables produce NO alerts and NO errors', canon({ a: s.alerts.length, e: s.errors.length }));
  const emptyFeed = await A('GET', '/');
  ok(emptyFeed.j?.data?.total === 0, 'E2 the feed is genuinely empty again', String(emptyFeed.j?.data?.total));
}

// ═══ Done ═════════════════════════════════════════════════════════════════
await sql.end();
server.close();
console.log(`\nRESULT: ${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
