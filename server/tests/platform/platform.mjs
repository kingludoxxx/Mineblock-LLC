// PLATFORM COMPLETENESS — route-level verification for the three gaps this
// lane closes: FUNNEL DUPLICATE, FUNNEL RESTORE, and HEALTH ALERTS v1.
//
// The REAL routers (REAL authenticate + requirePermission + ensureTables) on a
// minimal express host against a fresh embedded-PG database — same shape as
// funnel-transfer.mjs and page-duplicate.mjs.
//
// Asserts BY EXECUTION:
//   DUPLICATE — confirm is required; an archived funnel is refused; the copy is
//               a DRAFT with a FRESH id and a FRESH slug and NO domain; every
//               page's blocks / escape-hatch fields / seo are BYTE-IDENTICAL to
//               the source (canonical compare, since JSONB reorders keys); page
//               ids are fresh while page SLUGS are preserved (they are
//               funnel-relative); redirects travel; the canvas layout is
//               remapped onto the new page ids; the credential in
//               settings.checkout.maps_api_key does NOT travel and IS reported;
//               duplicating twice yields two funnels on DIFFERENT slugs; and
//               the SOURCE is byte-unchanged afterwards.
//   RESTORE   — confirm is required; 404s; the happy path clears `archived` and
//               KEEPS the slug; a slug taken by a live funnel in the meantime
//               produces a SUFFIXED slug plus a note (and does not disturb the
//               funnel that took it); restoring a live funnel is idempotent.
//   ALERTS    — 401 with no token and 403 with a token lacking the permission;
//               record → list → ack; unacked-first ordering; paging
//               (limit/offset/total/has_more); severity ENUM validation on both
//               the write and the filter; the per-kind COOLDOWN suppresses a
//               duplicate and SAYS SO; ack is IDEMPOTENT and preserves the
//               original acked_by; an unknown id 404s; the context cap replaces
//               rather than truncates; the SWEEP raises an alert from a seeded
//               STALE spend-sync row; the needs_review check emits a BASELINE
//               and nothing else on its first run, then alerts on a real rise;
//               and a sweep against a database MISSING those tables SKIPS the
//               checks instead of throwing.
//
// Run:  node server/tests/platform/platform.mjs
import postgres from 'postgres';

const DB = 'postgres://puure@127.0.0.1:5433/puure_platform';
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
// The full operator: funnels access (duplicate/restore) + audit read (alerts).
await sql`INSERT INTO users (id, email, first_name, last_name) VALUES ('u_pf','p@t.co','P','F')`;
await sql`INSERT INTO roles (id, name, permissions) VALUES ('r_pf','platform-tester', ${sql.json({ funnels: ['access'], audit: ['read'] })})`;
await sql`INSERT INTO user_roles (user_id, role_id) VALUES ('u_pf','r_pf')`;
// A second operator with funnels access but NO audit permission — proves the
// alert surface is gated by something, not merely by being logged in.
await sql`INSERT INTO users (id, email, first_name, last_name) VALUES ('u_nf','n@t.co','N','F')`;
await sql`INSERT INTO roles (id, name, permissions) VALUES ('r_nf','funnels-only', ${sql.json({ funnels: ['access'] })})`;
await sql`INSERT INTO user_roles (user_id, role_id) VALUES ('u_nf','r_nf')`;

const TOKEN = signAccessToken({ userId: 'u_pf' });
const TOKEN_NOAUDIT = signAccessToken({ userId: 'u_nf' });

const BASE = `http://127.0.0.1:${PORT}`;
const H = { Authorization: `Bearer ${TOKEN}`, 'Content-Type': 'application/json' };
const req = async (method, path, body, headers = H) => {
  const r = await fetch(`${BASE}${path}`, {
    method, headers, body: body === undefined ? undefined : JSON.stringify(body),
  });
  let j = null; try { j = await r.json(); } catch { /* empty body is a legal answer */ }
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
//
// This runs FIRST, deliberately: lb_postback_queue / lb_spend_sync_state /
// co_sessions belong to lanes that may never have run on a given deployment.
// A monitor that throws when a table is absent takes itself out on exactly the
// deployments that most need it.
// ═══════════════════════════════════════════════════════════════════════════
{
  let threw = null;
  let sweep = null;
  try { sweep = await alerts.runHealthAlertSweep(); } catch (e) { threw = e; }
  ok(!threw, 'S0.1 sweep does NOT throw when every source table is missing', String(threw?.message));
  const skippedChecks = (sweep?.skipped || []).map((s) => s.check).sort();
  ok(canon(skippedChecks) === canon(['needs_review_rising', 'postback_queue_depth', 'spend_sync_stale']),
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
{
  const before = await counts();

  const noConfirm = await F('POST', `/${SRC}/duplicate`, {});
  ok(noConfirm.status === 400, 'D1 duplicate WITHOUT confirm is refused 400', JSON.stringify(noConfirm.j));
  const wrongConfirm = await F('POST', `/${SRC}/duplicate`, { confirm: 'true' });
  ok(wrongConfirm.status === 400, "D2 confirm:'true' (a STRING) is not confirmation", JSON.stringify(wrongConfirm.j));
  const missing = await F('POST', '/fnl_does_not_exist/duplicate', { confirm: true });
  ok(missing.status === 404, 'D3 unknown funnel 404s', JSON.stringify(missing.j));

  const afterRefusals = await counts();
  ok(canon(before) === canon(afterRefusals), 'D4 NOTHING was created by any refusal', `${canon(before)} vs ${canon(afterRefusals)}`);

  const noAuth = await F('POST', `/${SRC}/duplicate`, { confirm: true }, { 'Content-Type': 'application/json' });
  ok(noAuth.status === 401, 'D5 duplicate with NO token is 401', JSON.stringify(noAuth.j));

  const dup = await F('POST', `/${SRC}/duplicate`, { confirm: true });
  ok(dup.status === 201, 'D6 duplicate answers 201', JSON.stringify(dup.j));
  const COPY = dup.j?.data?.funnel;

  ok(COPY?.id && COPY.id !== SRC, 'D7 the copy has a FRESH funnel id', String(COPY?.id));
  ok(COPY?.name === 'Dup Source copy', "D8 the copy is named '<name> copy'", String(COPY?.name));
  ok(COPY?.status === 'draft', 'D9 the copy is a DRAFT', String(COPY?.status));
  ok(COPY?.archived === false, 'D10 the copy is not archived', String(COPY?.archived));
  ok(COPY?.custom_domain === null, 'D11 the copy has NO custom domain', String(COPY?.custom_domain));
  ok(COPY?.slug && COPY.slug !== 'dup-source', 'D12 the copy got a FRESH slug', String(COPY?.slug));
  ok(dup.j?.data?.source_funnel_id === SRC, 'D13 the response names the source funnel', String(dup.j?.data?.source_funnel_id));

  // ── BYTE COMPARE, page by page ──────────────────────────────────────────
  const srcRows = await sql`SELECT * FROM funnel_pages WHERE funnel_id = ${SRC} ORDER BY is_home DESC, created_at ASC`;
  const copyRows = await sql`SELECT * FROM funnel_pages WHERE funnel_id = ${COPY.id} ORDER BY is_home DESC, created_at ASC`;
  ok(srcRows.length === 3 && copyRows.length === 3, 'D14 three pages on each side', `${srcRows.length} vs ${copyRows.length}`);

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
  ok(identical, 'D15 every page byte-matches the source (blocks, seo, all escape hatches, order)', diff);
  ok(copyRows.every((p) => ![PA, PB, PC].includes(p.id)), 'D16 every copied page has a FRESH id');
  // Page slugs are FUNNEL-RELATIVE, so preserving them is correct — the unique
  // index is (funnel_id, slug) and the copy is a different funnel.
  ok(canon(srcRows.map((p) => p.slug)) === canon(copyRows.map((p) => p.slug)),
    'D17 page SLUGS are preserved (they are funnel-relative)', canon(copyRows.map((p) => p.slug)));
  ok(copyRows.filter((p) => p.is_home).length === 1, 'D18 exactly one home page on the copy');

  const srcRedirects = await sql`SELECT from_path, to_path, match, code, enabled FROM funnel_redirects WHERE funnel_id = ${SRC} ORDER BY created_at ASC`;
  const copyRedirects = await sql`SELECT from_path, to_path, match, code, enabled FROM funnel_redirects WHERE funnel_id = ${COPY.id} ORDER BY created_at ASC`;
  ok(canon(srcRedirects) === canon(copyRedirects),
    'D19 redirects byte-match the source (paths, match, code, enabled)', `${canon(srcRedirects)} vs ${canon(copyRedirects)}`);
  ok(dup.j?.data?.redirects_count === 2, 'D20 the response counts the redirects it wrote', String(dup.j?.data?.redirects_count));

  // ── Canvas layout remapped onto the NEW page ids ────────────────────────
  const [copyFunnelRow] = await sql`SELECT flow_layout, settings FROM funnels WHERE id = ${COPY.id}`;
  const fl = copyFunnelRow.flow_layout;
  const copyIds = new Set(copyRows.map((p) => p.id));
  ok(fl?.nodes?.length === 3 && fl?.edges?.length === 2, 'D21 the canvas layout carried (3 nodes, 2 edges)', canon(fl));
  ok(fl.nodes.every((n) => copyIds.has(n.id)) && fl.edges.every((e) => copyIds.has(e.source) && copyIds.has(e.target)),
    'D22 every layout id points at a page of the COPY, never the source', canon(fl));
  ok(canon(fl.edges.map((e) => e.kind)) === canon(['main', 'fallback']), 'D23 edge kinds survive', canon(fl.edges));

  // ── The credential does NOT travel, and that is REPORTED ────────────────
  const copySettingsText = JSON.stringify(copyFunnelRow.settings);
  ok(!copySettingsText.includes(MAPS_KEY), 'D24 the Maps API key was NOT copied into the new funnel', copySettingsText.slice(0, 200));
  ok(copyFunnelRow.settings?.checkout?.address_autocomplete === true,
    'D25 the checkout TOGGLES beside it did travel', canon(copyFunnelRow.settings?.checkout));
  ok(Array.isArray(dup.j?.data?.stripped) && dup.j.data.stripped.includes('settings.checkout.maps_api_key'),
    'D26 the response REPORTS the key it refused to copy', JSON.stringify(dup.j?.data?.stripped));
  ok(Array.isArray(dup.j?.data?.notes) && dup.j.data.notes.some((n) => n.includes('maps_api_key')),
    'D27 the operator-language notes name it too', JSON.stringify(dup.j?.data?.notes));

  // ── The SOURCE is untouched ─────────────────────────────────────────────
  const [srcAfter] = await sql`SELECT * FROM funnels WHERE id = ${SRC}`;
  ok(srcAfter.slug === 'dup-source' && srcAfter.archived === false && srcAfter.name === 'Dup Source',
    'D28 the SOURCE funnel row is unchanged', canon({ slug: srcAfter.slug, name: srcAfter.name }));
  ok(JSON.stringify(srcAfter.settings).includes(MAPS_KEY), 'D29 the source still holds its own credential');

  // ── Duplicate twice → two copies, DIFFERENT slugs ───────────────────────
  const dup2 = await F('POST', `/${SRC}/duplicate`, { confirm: true });
  ok(dup2.status === 201, 'D30 a second duplicate also answers 201', JSON.stringify(dup2.j));
  ok(dup2.j?.data?.funnel?.slug !== COPY.slug,
    'D31 the second copy is on a DIFFERENT slug (de-collision ladder)',
    `${COPY.slug} vs ${dup2.j?.data?.funnel?.slug}`);
  ok(dup2.j?.data?.funnel?.id !== COPY.id, 'D32 the second copy is a different funnel');

  // ── Archived source is refused ──────────────────────────────────────────
  const arch = await F('POST', `/${SRC}/archive`, { archived: true });
  ok(arch.status === 200, 'D33 source archived for the refusal test', JSON.stringify(arch.j));
  const beforeArchDup = await counts();
  const dupArchived = await F('POST', `/${SRC}/duplicate`, { confirm: true });
  ok(dupArchived.status === 400, 'D34 duplicating an ARCHIVED funnel is refused 400', JSON.stringify(dupArchived.j));
  ok(/archived/i.test(dupArchived.j?.error || ''), 'D35 the refusal says why', String(dupArchived.j?.error));
  ok(canon(await counts()) === canon(beforeArchDup), 'D36 the archived refusal created NOTHING');
}

// ═══════════════════════════════════════════════════════════════════════════
// SECTION 3 — RESTORE  (SRC is archived, left that way by D33)
// ═══════════════════════════════════════════════════════════════════════════
{
  const noConfirm = await F('POST', `/${SRC}/restore`, {});
  ok(noConfirm.status === 400, 'R1 restore WITHOUT confirm is refused 400', JSON.stringify(noConfirm.j));
  const [stillArchived] = await sql`SELECT archived FROM funnels WHERE id = ${SRC}`;
  ok(stillArchived.archived === true, 'R2 the refusal left the funnel archived');

  const missing = await F('POST', '/fnl_nope/restore', { confirm: true });
  ok(missing.status === 404, 'R3 restoring an unknown funnel 404s', JSON.stringify(missing.j));

  const noAuth = await F('POST', `/${SRC}/restore`, { confirm: true }, { 'Content-Type': 'application/json' });
  ok(noAuth.status === 401, 'R4 restore with NO token is 401', JSON.stringify(noAuth.j));

  // ── HAPPY PATH: nothing took the slug, so it comes back on its own ──────
  const res = await F('POST', `/${SRC}/restore`, { confirm: true });
  ok(res.status === 200, 'R5 restore answers 200', JSON.stringify(res.j));
  ok(res.j?.data?.restored === true, 'R6 the response says it was restored', canon(res.j?.data));
  ok(res.j?.data?.slug_changed === false, 'R7 the slug did NOT change');
  ok(res.j?.data?.funnel?.slug === 'dup-source', 'R8 the ORIGINAL slug came back', String(res.j?.data?.funnel?.slug));
  ok(res.j?.data?.funnel?.archived === false, 'R9 archived is cleared');
  ok(canon(res.j?.data?.notes) === canon([]), 'R10 no notes when nothing was rewritten', canon(res.j?.data?.notes));

  // ── IDEMPOTENCE: restoring a LIVE funnel is not an error ────────────────
  const again = await F('POST', `/${SRC}/restore`, { confirm: true });
  ok(again.status === 200, 'R11 restoring an already-live funnel answers 200', JSON.stringify(again.j));
  ok(again.j?.data?.restored === false, 'R12 …and reports restored:false rather than pretending');
  ok(again.j?.data?.funnel?.slug === 'dup-source', 'R13 …and did NOT re-slug the live funnel', String(again.j?.data?.funnel?.slug));

  // ── THE COLLISION CASE — the whole reason this route exists ─────────────
  // Trash a funnel, let a NEW live funnel take its slug (the partial unique
  // index frees it on archive, funnels.js:62), then restore.
  const victim = await F('POST', '/', { name: 'Collide Me', slug: 'collide-me' });
  ok(victim.status === 201, 'R14 collision seed funnel created', JSON.stringify(victim.j));
  const VICTIM = victim.j?.data?.id;
  await F('POST', `/${VICTIM}/archive`, { archived: true });

  const usurper = await F('POST', '/', { name: 'Took The Slug', slug: 'collide-me' });
  ok(usurper.status === 201, 'R15 a NEW live funnel took the freed slug', JSON.stringify(usurper.j));
  const USURPER = usurper.j?.data?.id;

  // The pre-existing archive route answers 409 here and leaves the operator
  // stuck (funnels.js:888) — restore must NOT.
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

  // ── Permanent delete is ABSENT (archive-only house rule) ────────────────
  const del = await F('DELETE', `/${VICTIM}`, undefined);
  ok(del.status === 404, 'R24 there is NO permanent-delete endpoint (DELETE /funnels/:id 404s)', String(del.status));
  const [stillThere] = await sql`SELECT COUNT(*)::int AS n FROM funnels WHERE id = ${VICTIM}`;
  ok(stillThere.n === 1, 'R25 the funnel still exists — nothing in this lane destroys a row');
}

// ═══════════════════════════════════════════════════════════════════════════
// SECTION 4 — HEALTH ALERTS
// ═══════════════════════════════════════════════════════════════════════════
{
  // ── AUTH ────────────────────────────────────────────────────────────────
  const anon = await A('GET', '/', undefined, { 'Content-Type': 'application/json' });
  ok(anon.status === 401, 'A1 GET /health-alerts with no token is 401', JSON.stringify(anon.j));
  const anonAck = await A('POST', '/hal_x/ack', {}, { 'Content-Type': 'application/json' });
  ok(anonAck.status === 401, 'A2 POST /:id/ack with no token is 401', JSON.stringify(anonAck.j));
  const wrongPerm = await A('GET', '/', undefined, { Authorization: `Bearer ${TOKEN_NOAUDIT}`, 'Content-Type': 'application/json' });
  ok(wrongPerm.status === 403, 'A3 a token WITHOUT the permission is 403, not 200', JSON.stringify(wrongPerm.j));

  // ── EMPTY STATE ─────────────────────────────────────────────────────────
  const empty = await A('GET', '/');
  ok(empty.status === 200, 'A4 the list answers 200 on an empty table', JSON.stringify(empty.j));
  ok(canon(empty.j?.data?.items) === canon([]) && empty.j?.data?.total === 0 && empty.j?.data?.unacked === 0,
    'A5 empty means items:[] total:0 unacked:0 — never a null', canon(empty.j?.data));

  // ── SEVERITY IS AN ENUM ─────────────────────────────────────────────────
  let sevThrew = null;
  try { await alerts.recordAlert('bad_sev', 'catastrophic', 'nope'); } catch (e) { sevThrew = e; }
  ok(sevThrew instanceof TypeError, 'A6 recordAlert THROWS on an unknown severity', String(sevThrew));
  let kindThrew = null;
  try { await alerts.recordAlert('   ', 'warn', 'nope'); } catch (e) { kindThrew = e; }
  ok(kindThrew instanceof TypeError, 'A7 recordAlert THROWS on an empty kind', String(kindThrew));
  const [{ n: afterThrows }] = await sql`SELECT COUNT(*)::int AS n FROM lb_health_alerts`;
  ok(afterThrows === 0, 'A8 neither throw wrote a row', String(afterThrows));

  const badFilter = await A('GET', '/?severity=urgent');
  ok(badFilter.status === 400 && badFilter.j?.error?.code === 'invalid_severity',
    'A9 an unknown severity FILTER is 400 invalid_severity (not "return everything")', JSON.stringify(badFilter.j));

  // ── RECORD ──────────────────────────────────────────────────────────────
  const rec1 = await alerts.recordAlert('unit_info', 'info', 'An informational thing happened', { a: 1 });
  ok(rec1.created === true && rec1.alert?.id?.startsWith('hal_'), 'A10 recordAlert creates a row', canon(rec1));
  ok(rec1.alert.acked_at === null && rec1.alert.acked_by === null, 'A11 a new alert is UNACKED', canon({ at: rec1.alert.acked_at, by: rec1.alert.acked_by }));
  ok(canon(rec1.alert.context) === canon({ a: 1 }), 'A12 context round-trips as an OBJECT, not a JSON string', canon(rec1.alert.context));

  // ── COOLDOWN / DEDUP ────────────────────────────────────────────────────
  const rec1b = await alerts.recordAlert('unit_info', 'info', 'The same thing, again', { a: 2 });
  ok(rec1b.created === false && rec1b.reason === 'cooldown', 'A13 a second alert of the SAME kind is suppressed', canon(rec1b));
  ok(rec1b.suppressed_by === rec1.alert.id, 'A14 the suppression NAMES the row that won', String(rec1b.suppressed_by));
  const [{ n: afterCooldown }] = await sql`SELECT COUNT(*)::int AS n FROM lb_health_alerts WHERE kind = 'unit_info'`;
  ok(afterCooldown === 1, 'A15 the table really holds ONE row for that kind', String(afterCooldown));
  const rec1c = await alerts.recordAlert('unit_info', 'info', 'Cooldown waived', { a: 3 }, { cooldownMs: 0 });
  ok(rec1c.created === true, 'A16 cooldownMs:0 waives the suppression (a call site can force one)', canon(rec1c));

  // ── CONTEXT CAP: REPLACED, not truncated ────────────────────────────────
  const huge = { blob: 'x'.repeat(alerts.MAX_CONTEXT_BYTES + 5000) };
  const recHuge = await alerts.recordAlert('unit_huge', 'warn', 'Oversized context', huge);
  ok(recHuge.created === true, 'A17 an oversized context does not cost the alert', canon(recHuge.alert?.kind));
  ok(recHuge.alert.context?.context_too_large === true && !('blob' in recHuge.alert.context),
    'A18 the context is REPLACED with an honest marker, never half a document', canon(recHuge.alert.context));

  // ── ORDERING + PAGING ───────────────────────────────────────────────────
  for (let i = 0; i < 8; i++) {
    // eslint-disable-next-line no-await-in-loop
    await alerts.recordAlert(`unit_page_${i}`, i % 2 ? 'warn' : 'critical', `Paged alert ${i}`, { i });
  }
  const all = await A('GET', '/?limit=100');
  ok(all.status === 200 && all.j?.data?.total === 11,
    'A19 11 alerts recorded in total (1 info + 1 waived + 1 huge + 8 paged)', String(all.j?.data?.total));
  ok(all.j.data.unacked === 11, 'A20 all 11 are unacked', String(all.j.data.unacked));

  const p1 = await A('GET', '/?limit=5&offset=0');
  const p2 = await A('GET', '/?limit=5&offset=5');
  const p3 = await A('GET', '/?limit=5&offset=10');
  ok(p1.j.data.items.length === 5 && p2.j.data.items.length === 5 && p3.j.data.items.length === 1,
    'A21 paging returns 5 / 5 / 1', canon([p1.j.data.items.length, p2.j.data.items.length, p3.j.data.items.length]));
  ok(p1.j.data.has_more === true && p2.j.data.has_more === true && p3.j.data.has_more === false,
    'A22 has_more is true, true, false', canon([p1.j.data.has_more, p2.j.data.has_more, p3.j.data.has_more]));
  const pagedIds = [...p1.j.data.items, ...p2.j.data.items, ...p3.j.data.items].map((a) => a.id);
  ok(new Set(pagedIds).size === 11, 'A23 the three pages are disjoint and cover everything', String(new Set(pagedIds).size));

  const over = await A('GET', '/?limit=99999');
  ok(over.j?.data?.limit === alerts.MAX_PAGE_LIMIT, 'A24 an absurd limit is CLAMPED, not honoured', String(over.j?.data?.limit));
  const negative = await A('GET', '/?limit=-4&offset=-9');
  ok(negative.status === 200 && negative.j?.data?.limit >= 1 && negative.j?.data?.offset === 0,
    'A25 negative paging params do not produce a SQL error', canon({ l: negative.j?.data?.limit, o: negative.j?.data?.offset }));
  const garbage = await A('GET', '/?limit=abc&offset=xyz');
  ok(garbage.status === 200, 'A26 non-numeric paging params fall back to defaults', canon({ l: garbage.j?.data?.limit, o: garbage.j?.data?.offset }));

  const crit = await A('GET', '/?severity=critical&limit=100');
  ok(crit.j.data.items.length === 4 && crit.j.data.items.every((a) => a.severity === 'critical'),
    'A27 the severity filter filters', String(crit.j.data.items.length));
  ok(crit.j.data.unacked === 11,
    'A28 `unacked` is the WHOLE surface and does not shrink with the filter', String(crit.j.data.unacked));

  // ── ACK ─────────────────────────────────────────────────────────────────
  const target = rec1.alert.id;
  const ack1 = await A('POST', `/${target}/ack`, {});
  ok(ack1.status === 200, 'A29 ack answers 200', JSON.stringify(ack1.j));
  ok(ack1.j?.data?.already_acked === false, 'A30 …and reports it was a first ack');
  ok(ack1.j?.data?.alert?.acked_at, 'A31 acked_at is stamped', String(ack1.j?.data?.alert?.acked_at));
  ok(ack1.j?.data?.alert?.acked_by === 'u_pf', 'A32 acked_by is the AUTHENTICATED user, not the body', String(ack1.j?.data?.alert?.acked_by));

  const ack2 = await A('POST', `/${target}/ack`, {});
  ok(ack2.status === 200, 'A33 a SECOND ack is 200, not 404 or 409 (idempotent)', JSON.stringify(ack2.j));
  ok(ack2.j?.data?.already_acked === true, 'A34 …and says so');
  ok(ack2.j?.data?.alert?.acked_at === ack1.j?.data?.alert?.acked_at,
    'A35 the ORIGINAL acked_at is preserved — a re-ack does not rewrite history',
    `${ack1.j?.data?.alert?.acked_at} vs ${ack2.j?.data?.alert?.acked_at}`);
  ok(ack2.j?.data?.alert?.acked_by === 'u_pf', 'A36 …and so is the original acked_by');

  const ackMissing = await A('POST', '/hal_not_a_real_id/ack', {});
  ok(ackMissing.status === 404 && ackMissing.j?.error?.code === 'alert_not_found',
    'A37 acking an unknown id is 404 alert_not_found — NOT conflated with already-acked', JSON.stringify(ackMissing.j));

  // ── UNACKED FIRST ───────────────────────────────────────────────────────
  const ordered = await A('GET', '/?limit=100');
  const firstAcked = ordered.j.data.items.findIndex((a) => a.acked_at);
  ok(firstAcked === ordered.j.data.items.length - 1,
    'A38 the single acked alert sorts LAST — unacked first, regardless of age', String(firstAcked));
  ok(ordered.j.data.unacked === 10, 'A39 the unacked count dropped by exactly one', String(ordered.j.data.unacked));

  const onlyUnacked = await A('GET', '/?acked=false&limit=100');
  ok(onlyUnacked.j.data.items.length === 10 && onlyUnacked.j.data.items.every((a) => !a.acked_at),
    'A40 ?acked=false returns only unacked', String(onlyUnacked.j.data.items.length));
  const onlyAcked = await A('GET', '/?acked=true&limit=100');
  ok(onlyAcked.j.data.items.length === 1 && onlyAcked.j.data.items[0].id === target,
    'A41 ?acked=true returns only the acked one', String(onlyAcked.j.data.items.length));

  // ── META ────────────────────────────────────────────────────────────────
  const meta = await A('GET', '/meta');
  ok(canon(meta.j?.data?.severities) === canon(['info', 'warn', 'critical']),
    'A42 /meta serves the severity vocabulary the client badges against', canon(meta.j?.data?.severities));
}

// ═══════════════════════════════════════════════════════════════════════════
// SECTION 5 — THE SWEEP, against REAL seeded state
// ═══════════════════════════════════════════════════════════════════════════
{
  // Create the tables the sweep reads — the same DDL their owning lanes use.
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

  // A HEALTHY feed (synced an hour ago) and a STALE one (36h). Only the stale
  // one may produce an alert — a rule that fires on a working feed is worse
  // than no rule.
  await sql`INSERT INTO lb_spend_sync_state (source, last_sync, last_attempt, last_ok, fail_streak)
            VALUES ('meta_fresh', NOW() - INTERVAL '1 hour', NOW(), TRUE, 0)`;
  await sql`INSERT INTO lb_spend_sync_state (source, last_sync, last_attempt, last_ok, fail_streak)
            VALUES ('meta_stale', NOW() - INTERVAL '36 hours', NOW(), FALSE, 7)`;

  alerts._resetSweepState();
  const s1 = await alerts.runHealthAlertSweep();
  ok((s1.errors || []).length === 0, 'S1.1 the sweep ran clean', JSON.stringify(s1.errors));

  const stale = s1.alerts.filter((a) => a.kind.startsWith('spend_sync_stale:'));
  ok(stale.length === 1, 'S1.2 EXACTLY ONE stale-spend alert — the healthy feed did not fire', JSON.stringify(s1.alerts.map((a) => a.kind)));
  ok(stale[0]?.kind === 'spend_sync_stale:meta_stale', 'S1.3 the alert NAMES the failing source', String(stale[0]?.kind));
  ok(stale[0]?.severity === 'warn', 'S1.4 severity is warn', String(stale[0]?.severity));
  ok(stale[0]?.context?.fail_streak === 7 && Number(stale[0]?.context?.hours_stale) >= 35,
    'S1.5 the context carries the measured staleness and streak', canon(stale[0]?.context));
  ok(/36|35/.test(stale[0]?.message || ''), 'S1.6 the message states the measurement', String(stale[0]?.message));

  // needs_review: FIRST run is a BASELINE and must alert on nothing.
  ok(s1.alerts.every((a) => a.kind !== 'needs_review_rising'),
    'S1.7 the first sweep raises NO needs_review alert (a count is not a trend)', JSON.stringify(s1.alerts.map((a) => a.kind)));
  ok((s1.skipped || []).some((s) => s.check === 'needs_review_rising' && s.reason === 'baseline_only'),
    'S1.8 …and says WHY: baseline_only', JSON.stringify(s1.skipped));
  ok(s1.observations?.needs_review?.count === 0 && s1.observations?.needs_review?.previous === null,
    'S1.9 the baseline observation is reported', canon(s1.observations?.needs_review));

  // Queue depth below the threshold must NOT fire.
  ok(s1.observations?.postback_queue_depth === 0, 'S1.10 queue depth observed as 0', String(s1.observations?.postback_queue_depth));
  ok(s1.alerts.every((a) => a.kind !== 'postback_queue_depth'), 'S1.11 an empty queue raises nothing');

  // ── SECOND SWEEP: the stale feed is STILL stale → cooldown, not a new row ──
  const s2 = await alerts.runHealthAlertSweep();
  ok(s2.alerts.every((a) => !a.kind.startsWith('spend_sync_stale:')),
    'S2.1 the still-stale feed does NOT write a second row', JSON.stringify(s2.alerts.map((a) => a.kind)));
  ok((s2.skipped || []).some((s) => s.check === 'spend_sync_stale:meta_stale' && s.reason === 'cooldown'),
    'S2.2 …and the suppression is reported as a cooldown', JSON.stringify(s2.skipped));
  const [{ n: staleRows }] = await sql`SELECT COUNT(*)::int AS n FROM lb_health_alerts WHERE kind = 'spend_sync_stale:meta_stale'`;
  ok(staleRows === 1, 'S2.3 the table holds exactly ONE row for that source', String(staleRows));

  // ── QUEUE DEPTH over the threshold ──────────────────────────────────────
  const rows = [];
  for (let i = 0; i < 105; i++) rows.push({ id: `pbq_${i}`, status: i < 3 ? 'done' : 'queued' });
  for (const r of rows) {
    // eslint-disable-next-line no-await-in-loop
    await sql`INSERT INTO lb_postback_queue (id, status) VALUES (${r.id}, ${r.status})`;
  }
  const s3 = await alerts.runHealthAlertSweep();
  ok(s3.observations?.postback_queue_depth === 102,
    'S3.1 depth counts queued+sending only — the 3 done rows are excluded', String(s3.observations?.postback_queue_depth));
  const depthAlert = s3.alerts.find((a) => a.kind === 'postback_queue_depth');
  ok(depthAlert, 'S3.2 crossing the threshold raises an alert', JSON.stringify(s3.alerts.map((a) => a.kind)));
  ok(depthAlert?.context?.depth === 102 && depthAlert?.context?.threshold === 100,
    'S3.3 the context carries the measurement AND the threshold it was judged against', canon(depthAlert?.context));

  // ── needs_review RISING ─────────────────────────────────────────────────
  // Below the minimum rise first: a +2 move must NOT alert.
  for (let i = 0; i < 2; i++) {
    // eslint-disable-next-line no-await-in-loop
    await sql`INSERT INTO co_sessions (id, needs_review_reason) VALUES (${`cos_small_${i}`}, 'settlement')`;
  }
  const s4 = await alerts.runHealthAlertSweep();
  ok(s4.observations?.needs_review?.count === 2 && s4.observations?.needs_review?.previous === 0,
    'S4.1 the rise is measured against the PREVIOUS observation', canon(s4.observations?.needs_review));
  ok(s4.alerts.every((a) => a.kind !== 'needs_review_rising'),
    'S4.2 a +2 move is below NEEDS_REVIEW_RISE_MIN and raises nothing');

  for (let i = 0; i < 9; i++) {
    // eslint-disable-next-line no-await-in-loop
    await sql`INSERT INTO co_sessions (id, needs_review_reason) VALUES (${`cos_big_${i}`}, 'webhook')`;
  }
  const s5 = await alerts.runHealthAlertSweep();
  const rising = s5.alerts.find((a) => a.kind === 'needs_review_rising');
  ok(rising, 'S4.3 a +9 move DOES raise needs_review_rising', JSON.stringify(s5.alerts.map((a) => a.kind)));
  ok(rising?.context?.delta === 9 && rising?.context?.previous === 2 && rising?.context?.count === 11,
    'S4.4 the context carries previous, count and delta', canon(rising?.context));

  // A FALLING count must never alert — the check is directional.
  await sql`DELETE FROM co_sessions WHERE id LIKE 'cos_big_%'`;
  const s6 = await alerts.runHealthAlertSweep();
  ok(s6.observations?.needs_review?.count === 2 && s6.observations?.needs_review?.previous === 11,
    'S5.1 a FALL is observed', canon(s6.observations?.needs_review));
  ok(s6.alerts.every((a) => a.kind !== 'needs_review_rising'), 'S5.2 …and raises nothing');

  // ── The sweep is reachable over HTTP, and gated ─────────────────────────
  const sweepAnon = await A('POST', '/sweep', {}, { 'Content-Type': 'application/json' });
  ok(sweepAnon.status === 401, 'S6.1 POST /sweep with no token is 401', JSON.stringify(sweepAnon.j));
  const sweepHttp = await A('POST', '/sweep', {});
  ok(sweepHttp.status === 200 && Array.isArray(sweepHttp.j?.data?.alerts),
    'S6.2 POST /sweep runs the rules and answers 200', JSON.stringify(sweepHttp.j).slice(0, 200));

  // ── The alerts the sweep produced are visible on the surface ────────────
  const feed = await A('GET', '/?limit=100');
  const kinds = (feed.j?.data?.items || []).map((a) => a.kind);
  ok(kinds.includes('spend_sync_stale:meta_stale') && kinds.includes('postback_queue_depth') && kinds.includes('needs_review_rising'),
    'S6.3 every sweep-produced alert appears in the operator feed', JSON.stringify(kinds.filter((k) => !k.startsWith('unit_'))));

  // ── A sweep whose SPEND table exists but is EMPTY raises nothing ────────
  await sql`DELETE FROM lb_spend_sync_state`;
  await sql`DELETE FROM lb_postback_queue`;
  await sql`DELETE FROM lb_health_alerts`;
  alerts._resetSweepState();
  const s7 = await alerts.runHealthAlertSweep();
  ok(s7.alerts.length === 0 && s7.errors.length === 0,
    'S7.1 empty (but present) source tables produce NO alerts and NO errors', canon({ a: s7.alerts.length, e: s7.errors.length }));
  const emptyFeed = await A('GET', '/');
  ok(emptyFeed.j?.data?.total === 0, 'S7.2 the feed is genuinely empty again', String(emptyFeed.j?.data?.total));
}

// ═══ Done ═════════════════════════════════════════════════════════════════
await sql.end();
server.close();
console.log(`\nRESULT: ${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
