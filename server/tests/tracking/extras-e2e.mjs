// END-TO-END verification for routes/funnelTrackingExtras.js against a REAL
// Postgres. This is the harness that executes the SQL — the pure shaping
// harnesses (health-shape.mjs / custom-code.mjs) can never catch a typo'd
// column, a bad FILTER alias, a DISTINCT ON ordering mistake, or the jsonb
// concatenation trap in the UPSERT.
//
// Drives the REAL router: real authenticate + requirePermission + the real
// ensure() chain + the real queries. Nothing is stubbed except the seeded rows.
//
// DATABASE: its OWN scratch database (puure_tracking_extras) on the local
// scratch server. It never touches puure_shoporder or any sibling database.
//
// Run:  node server/tests/tracking/extras-e2e.mjs
process.env.DATABASE_URL = 'postgres://puure@127.0.0.1:5433/puure_tracking_extras';
process.env.NODE_ENV = 'development';
process.env.JWT_ACCESS_SECRET = process.env.JWT_ACCESS_SECRET || 'dev-access-secret-change-me';

const NM = '/Users/ludo/Mineblock-LLC/node_modules';
const express = (await import(`${NM}/express/index.js`)).default;
const jwt = (await import(`${NM}/jsonwebtoken/index.js`)).default;
const postgres = (await import(`${NM}/postgres/src/index.js`)).default;

const sql = postgres(process.env.DATABASE_URL, { onnotice: () => {} });

let pass = 0, fail = 0;
const check = (name, ok, extra = '') => { if (ok) { pass++; console.log(`PASS  ${name}`); } else { fail++; console.log(`FAIL  ${name}  ${extra}`); } };

// ── seed auth: minimal users/roles + a funnels:access user ──────────────────
await sql`CREATE TABLE IF NOT EXISTS users (
  id TEXT PRIMARY KEY, email TEXT, first_name TEXT, last_name TEXT,
  must_change_password BOOLEAN DEFAULT FALSE, email_verified BOOLEAN DEFAULT TRUE,
  is_active BOOLEAN DEFAULT TRUE
)`;
await sql`CREATE TABLE IF NOT EXISTS roles (id TEXT PRIMARY KEY, name TEXT, permissions JSONB)`;
await sql`CREATE TABLE IF NOT EXISTS user_roles (user_id TEXT, role_id TEXT)`;
await sql`INSERT INTO users (id, email, first_name, last_name) VALUES ('u_trx_test', 'trx@local.test', 'Trx', 'Test') ON CONFLICT (id) DO NOTHING`;
await sql`INSERT INTO roles (id, name, permissions) VALUES ('r_trx_test', 'extras-tester', '{"funnels": ["access"]}') ON CONFLICT (id) DO NOTHING`;
await sql`DELETE FROM user_roles WHERE user_id = 'u_trx_test'`;
await sql`INSERT INTO user_roles (user_id, role_id) VALUES ('u_trx_test', 'r_trx_test')`;

const extrasRouter = (await import('../../src/routes/funnelTrackingExtras.js')).default;
const { ensureTrackingExtrasTables } = await import('../../src/routes/funnelTrackingExtras.js');

// ── E0: the ensure chain runs against a FRESH database ──────────────────────
// The bug this catches: creating the lb_postback_queue index before
// trackingSchema has created that table. On a fresh DB this is the real test.
{
  let threw = null;
  try { await ensureTrackingExtrasTables(); } catch (e) { threw = e.message; }
  check('E0 ensureTrackingExtrasTables() succeeds on a FRESH database', threw === null, String(threw));

  const t = await sql`SELECT to_regclass('public.lb_tracking_custom_code') AS t`;
  check('E0 lb_tracking_custom_code created', t[0].t !== null, JSON.stringify(t[0]));
  const q = await sql`SELECT to_regclass('public.lb_postback_queue') AS t`;
  check('E0 lb_postback_queue created by the chained ensure', q[0].t !== null, JSON.stringify(q[0]));
  const idx = await sql`SELECT indexname FROM pg_indexes WHERE indexname = 'idx_lb_postback_queue_funnel'`;
  check('E0 idx_lb_postback_queue_funnel created', idx.length === 1, JSON.stringify(idx));
  const cols = await sql`SELECT column_name, data_type FROM information_schema.columns WHERE table_name = 'lb_tracking_custom_code' ORDER BY column_name`;
  const byName = Object.fromEntries(cols.map((c) => [c.column_name, c.data_type]));
  check('E0 code column is jsonb', byName.code === 'jsonb', JSON.stringify(byName));
  check('E0 funnel_id is the PK column', byName.funnel_id === 'text', JSON.stringify(byName));
  // Idempotency: a second call must be a no-op, not a duplicate-object error.
  let threw2 = null;
  try { await ensureTrackingExtrasTables(); } catch (e) { threw2 = e.message; }
  check('E0 ensure is idempotent on a second call', threw2 === null, String(threw2));
}

const app = express();
app.use(express.json());
app.use('/api/v1/funnels', extrasRouter);
const server = app.listen(0);
const B = `http://127.0.0.1:${server.address().port}/api/v1/funnels`;

const token = jwt.sign({ userId: 'u_trx_test' }, process.env.JWT_ACCESS_SECRET, { expiresIn: '10m' });
const H = { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' };
const req = async (method, path, body, headers = H) => {
  const r = await fetch(`${B}${path}`, { method, headers, body: body === undefined ? undefined : JSON.stringify(body) });
  let j = null; let text = '';
  try { text = await r.text(); j = JSON.parse(text); } catch { /* non-JSON */ }
  return { status: r.status, j, text };
};

// ── fixtures: one funnel per scenario (lb_pixels is UNIQUE per funnel+kind) ──
const F = {
  healthy: 'fnl_trx_healthy',
  failing: 'fnl_trx_failing',
  zero: 'fnl_trx_zero',
  breaker: 'fnl_trx_breaker',
  skip: 'fnl_trx_skip',
  empty: 'fnl_trx_empty',
  custom: 'fnl_trx_custom',
};
const ALL = Object.values(F);

// The routes now 404 on a funnel that does not exist (review m7), so every
// scenario funnel needs a real row. ensureFunnelTables() runs inside the route
// on first request, but seeding needs the table NOW.
{
  const { ensureTables: ensureFunnelTables } = await import('../../src/routes/funnels.js');
  await ensureFunnelTables();
}
for (const fid of ALL) {
  await sql`DELETE FROM funnels WHERE id = ${fid}`;
  await sql`INSERT INTO funnels (id, slug, name) VALUES (${fid}, ${fid}, ${fid})`;
}
for (const fid of ALL) {
  await sql`DELETE FROM lb_pixels WHERE funnel_id = ${fid}`;
  await sql`DELETE FROM lb_tracking_events WHERE funnel_id = ${fid}`;
  await sql`DELETE FROM lb_postback_breakers WHERE funnel_id = ${fid}`;
  await sql`DELETE FROM lb_postback_queue WHERE funnel_id = ${fid}`;
  await sql`DELETE FROM lb_tracking_custom_code WHERE funnel_id = ${fid}`;
}

// A configured, server-ready meta pixel for each scenario funnel.
const pxId = (k) => `px_trx_${k}`;
for (const k of ['healthy', 'failing', 'zero', 'breaker', 'skip']) {
  await sql`INSERT INTO lb_pixels (id, funnel_id, kind, pixel_id, mode, enabled, config)
            VALUES (${pxId(k)}, ${F[k]}, 'meta_pixel', '778899001', 'hybrid', TRUE,
                    ${sql.json({ capi_token: 'gcm1:fake' })})`;
}

// lb_tracking_events.platform is the kind minus '_pixel' → 'meta'.
const ev = (fid, status, error, ago) => sql`
  INSERT INTO lb_tracking_events (funnel_id, platform, pixel_id, event_name, event_id, status, source, idk, emq, value, error, ts)
  VALUES (${fid}, 'meta', '778899001', 'Purchase', ${'e_' + Math.random().toString(16).slice(2)},
          ${status}, 'relay', ${sql.json(['em', 'fbc'])}, 7, 49.99, ${error}, NOW() - ${ago}::interval)`;

// healthy: 3 sends inside 24h, 1 send at 3 days (7d only), 1 at 40 days (outside both)
await ev(F.healthy, 'sent', null, '10 minutes');
await ev(F.healthy, 'sent', null, '2 hours');
await ev(F.healthy, 'sent', null, '20 hours');
await ev(F.healthy, 'sent', null, '3 days');
await ev(F.healthy, 'sent', null, '40 days');
// failing: 4 errors in 24h, no sends
for (let i = 0; i < 4; i++) await ev(F.failing, 'error', 'http_500: upstream boom', '1 hour');
// zero: nothing at all
// breaker: sends AND an OPEN breaker — the breaker must outrank the counters
await ev(F.breaker, 'sent', null, '30 minutes');
await sql`INSERT INTO lb_postback_breakers (scope_id, funnel_id, fails, open_until, updated_at)
          VALUES (${`${F.breaker}:${pxId('breaker')}`}, ${F.breaker}, 5, NOW() + INTERVAL '10 minutes', NOW())`;
// skip: skipped-only (declined events) — must NOT read as failing
for (let i = 0; i < 5; i++) await ev(F.skip, 'skipped', 'no_identity', '2 hours');

const health = async (fid) => {
  const r = await req('GET', `/${fid}/tracking/health`);
  return { status: r.status, d: r.j?.data, raw: r.text };
};

// ── E1 HEALTHY (end-to-end row 1) ───────────────────────────────────────────
{
  const { status, d, raw } = await health(F.healthy);
  check('E1 health 200', status === 200, raw?.slice(0, 200));
  const p = d?.pixels?.[0];
  check('E1 exactly one pixel returned', d?.pixels?.length === 1, JSON.stringify(d?.pixels?.length));
  check('E1 status healthy', p?.status === 'healthy', JSON.stringify(p?.status));
  check('E1 overall healthy', d?.overall === 'healthy', JSON.stringify(d?.overall));
  // THE WINDOW ASSERTION the pure harness cannot make: 3 in 24h, 4 in 7d.
  check('E1 24h window counts ONLY the 3 recent sends', p?.windows?.h24?.sent === 3, JSON.stringify(p?.windows?.h24));
  check('E1 7d window counts 4 (adds the 3-day-old send, excludes the 40-day-old)', p?.windows?.d7?.sent === 4, JSON.stringify(p?.windows?.d7));
  check('E1 last_sent_at populated', Boolean(p?.last_sent_at), JSON.stringify(p?.last_sent_at));
  check('E1 last_failed_at null (no failures)', p?.last_failed_at === null, JSON.stringify(p?.last_failed_at));
  check('E1 breaker closed', p?.breaker?.state === 'closed', JSON.stringify(p?.breaker));
  check('E1 server_channel_ready true (hybrid + token + id)', p?.server_channel_ready === true, JSON.stringify(p?.server_channel_ready));
  check('E1 totals_24h.sent === 3', d?.totals_24h?.sent === 3, JSON.stringify(d?.totals_24h));
  check('E1 id_field is pixel_id for meta', p?.id_field === 'pixel_id', JSON.stringify(p?.id_field));
}

// ── E2 FAILING (row 2) ──────────────────────────────────────────────────────
{
  const { d } = await health(F.failing);
  const p = d?.pixels?.[0];
  check('E2 status failing', p?.status === 'failing', JSON.stringify(p?.status));
  check('E2 24h failed === 4', p?.windows?.h24?.failed === 4, JSON.stringify(p?.windows?.h24));
  check('E2 24h sent === 0', p?.windows?.h24?.sent === 0, JSON.stringify(p?.windows?.h24));
  // DISTINCT ON (platform, status) must surface the newest error TEXT.
  check('E2 last_error surfaced from the DISTINCT ON query', p?.last_error === 'http_500: upstream boom', JSON.stringify(p?.last_error));
  check('E2 last_sent_at null', p?.last_sent_at === null, JSON.stringify(p?.last_sent_at));
  check('E2 tone danger', p?.tone === 'danger', JSON.stringify(p?.tone));
}

// ── E3 ZERO TRAFFIC (row 3) — the headline honesty rule ─────────────────────
{
  const { d } = await health(F.zero);
  const p = d?.pixels?.[0];
  check('E3 status no_traffic', p?.status === 'no_traffic', JSON.stringify(p?.status));
  check('E3 NEVER failing', p?.status !== 'failing', JSON.stringify(p?.status));
  check('E3 zeroed 24h window (not undefined/NaN)', p?.windows?.h24?.sent === 0 && p?.windows?.h24?.failed === 0, JSON.stringify(p?.windows?.h24));
  check('E3 zeroed 7d window', p?.windows?.d7?.sent === 0, JSON.stringify(p?.windows?.d7));
  check('E3 last_sent_at null, not fabricated', p?.last_sent_at === null, JSON.stringify(p?.last_sent_at));
  check('E3 tone neutral, not red', p?.tone === 'default', JSON.stringify(p?.tone));
}

// ── E4 BREAKER OPEN (row 4) ─────────────────────────────────────────────────
{
  const { d } = await health(F.breaker);
  const p = d?.pixels?.[0];
  check('E4 status outage (breaker outranks a successful send)', p?.status === 'outage', JSON.stringify(p?.status));
  check('E4 breaker.state open', p?.breaker?.state === 'open', JSON.stringify(p?.breaker));
  check('E4 breaker.fails === 5', p?.breaker?.fails === 5, JSON.stringify(p?.breaker));
  check('E4 open_until returned', Boolean(p?.breaker?.open_until), JSON.stringify(p?.breaker?.open_until));
  check('E4 the send is still counted honestly', p?.windows?.h24?.sent === 1, JSON.stringify(p?.windows?.h24));
  // scope_id keying must be exact — a breaker on another pixel must not leak.
  const other = await health(F.healthy);
  check('E4 breaker did not leak to another funnel', other.d?.pixels?.[0]?.breaker?.state === 'closed', JSON.stringify(other.d?.pixels?.[0]?.breaker));
}

// ── E5 SKIPPED-ONLY (row 5) — a decline is not a failure ────────────────────
{
  const { d } = await health(F.skip);
  const p = d?.pixels?.[0];
  check('E5 status no_deliveries', p?.status === 'no_deliveries', JSON.stringify(p?.status));
  check('E5 NEVER failing (a skip is a decline)', p?.status !== 'failing', JSON.stringify(p?.status));
  check('E5 NEVER healthy (nothing was sent)', p?.status !== 'healthy', JSON.stringify(p?.status));
  check('E5 skipped counted in its OWN bucket === 5', p?.windows?.h24?.skipped === 5, JSON.stringify(p?.windows?.h24));
  check('E5 failed stays 0 — skips are not folded in', p?.windows?.h24?.failed === 0, JSON.stringify(p?.windows?.h24));
  check('E5 last_skip_reason surfaced', p?.last_skip_reason === 'no_identity', JSON.stringify(p?.last_skip_reason));
  check('E5 last_error stays null', p?.last_error === null || p?.last_error === undefined, JSON.stringify(p?.last_error));
}

// ── E6 EMPTY FUNNEL ─────────────────────────────────────────────────────────
{
  const { status, d } = await health(F.empty);
  check('E6 empty funnel answers 200', status === 200, String(status));
  check('E6 no pixels', d?.pixels?.length === 0, JSON.stringify(d?.pixels));
  check('E6 overall no_pixels (never a green light)', d?.overall === 'no_pixels', JSON.stringify(d?.overall));
  check('E6 totals zeroed', d?.totals_24h?.sent === 0, JSON.stringify(d?.totals_24h));
  check('E6 windows still stated', d?.windows?.h24 === '24 hours', JSON.stringify(d?.windows));
}

// ── E7 live queue depth join (lb_postback_queue → lb_pixels) ────────────────
{
  await sql`INSERT INTO lb_postback_queue (id, funnel_id, scope_id, status, envelope, pixel_row_id, attempts, next_at, created_at)
            VALUES ('pq_trx_1', ${F.zero}, ${`${F.zero}:${pxId('zero')}`}, 'queued', ${sql.json({ e: 1 })}, ${pxId('zero')}, 1, NOW(), NOW()),
                   ('pq_trx_2', ${F.zero}, ${`${F.zero}:${pxId('zero')}`}, 'sending', ${sql.json({ e: 2 })}, ${pxId('zero')}, 2, NOW(), NOW()),
                   ('pq_trx_3', ${F.zero}, ${`${F.zero}:${pxId('zero')}`}, 'done', ${sql.json({ e: 3 })}, ${pxId('zero')}, 3, NOW(), NOW())`;
  const { d } = await health(F.zero);
  const p = d?.pixels?.[0];
  check('E7 queued_now counts queued+sending only (2, not 3)', p?.queued_now === 2, JSON.stringify(p?.queued_now));
  check('E7 backlog with zero deliveries → outage', p?.status === 'outage', JSON.stringify(p?.status));
  await sql`DELETE FROM lb_postback_queue WHERE funnel_id = ${F.zero}`;
}

// ── E8 unknown kind reported as a count only ────────────────────────────────
{
  await sql`INSERT INTO lb_pixels (id, funnel_id, kind, pixel_id, mode, enabled, config)
            VALUES ('px_trx_mystery', ${F.empty}, 'mystery_net', 'zz', 's2s', TRUE, ${sql.json({})})`;
  const { d } = await health(F.empty);
  check('E8 unknown_kinds reports the row', d?.unknown_kinds?.[0]?.kind === 'mystery_net' && d?.unknown_kinds?.[0]?.rows === 1, JSON.stringify(d?.unknown_kinds));
  await sql`DELETE FROM lb_pixels WHERE funnel_id = ${F.empty}`;
}

// ── E9 CUSTOM CODE: insert → partial update (the SQL `||` merge) ────────────
{
  const g0 = await req('GET', `/${F.custom}/tracking/custom`);
  check('E9 GET before any write → empty snippets, 200', g0.status === 200 && g0.j?.data?.head_html === '' && g0.j?.data?.body_html === '', g0.text?.slice(0, 200));
  check('E9 GET reports max_bytes', g0.j?.data?.max_bytes === 32768, JSON.stringify(g0.j?.data?.max_bytes));
  check('E9 updated_at null before any write', g0.j?.data?.updated_at === null, JSON.stringify(g0.j?.data?.updated_at));

  const p1 = await req('PUT', `/${F.custom}/tracking/custom`, { head_html: '<script>HEAD_ONE</script>' });
  check('E9 PUT #1 (INSERT) → 200', p1.status === 200, p1.text?.slice(0, 200));
  check('E9 PUT #1 returns the head verbatim', p1.j?.data?.head_html === '<script>HEAD_ONE</script>', JSON.stringify(p1.j?.data?.head_html));

  // Partial update: body only. head MUST survive — this exercises the
  // `code || EXCLUDED.code` jsonb merge in the ON CONFLICT branch.
  const p2 = await req('PUT', `/${F.custom}/tracking/custom`, { body_html: '<noscript>BODY_TWO</noscript>' });
  check('E9 PUT #2 (UPDATE) → 200', p2.status === 200, p2.text?.slice(0, 200));
  check('E9 PUT #2 preserved the head (jsonb || merge works)', p2.j?.data?.head_html === '<script>HEAD_ONE</script>', JSON.stringify(p2.j?.data?.head_html));
  check('E9 PUT #2 set the body', p2.j?.data?.body_html === '<noscript>BODY_TWO</noscript>', JSON.stringify(p2.j?.data?.body_html));

  const g1 = await req('GET', `/${F.custom}/tracking/custom`);
  check('E9 GET reads both fields back', g1.j?.data?.head_html === '<script>HEAD_ONE</script>' && g1.j?.data?.body_html === '<noscript>BODY_TWO</noscript>', JSON.stringify(g1.j?.data));
  check('E9 updated_at now populated', Boolean(g1.j?.data?.updated_at), JSON.stringify(g1.j?.data?.updated_at));

  // Stored shape must be a jsonb OBJECT, never a double-encoded string.
  const row = await sql`SELECT jsonb_typeof(code) AS t, updated_by FROM lb_tracking_custom_code WHERE funnel_id = ${F.custom}`;
  check('E9 stored jsonb is an OBJECT (raw param, not JSON.stringify)', row[0]?.t === 'object', JSON.stringify(row[0]));
  check('E9 updated_by recorded from req.user', row[0]?.updated_by === 'u_trx_test', JSON.stringify(row[0]?.updated_by));

  // Explicit clear via null.
  const p3 = await req('PUT', `/${F.custom}/tracking/custom`, { head_html: null });
  check('E9 PUT null clears the head', p3.j?.data?.head_html === '', JSON.stringify(p3.j?.data?.head_html));
  check('E9 PUT null left the body intact', p3.j?.data?.body_html === '<noscript>BODY_TWO</noscript>', JSON.stringify(p3.j?.data?.body_html));
}

// ── E10 FORCED DOUBLE-ENCODED jsonb (the trap) ──────────────────────────────
// A jsonb STRING SCALAR is what a JSON.stringify-into-a-jsonb-param bug leaves
// behind. The GET must still read it, and — critically — the next PUT must not
// explode on `||`, which throws when its left operand is a scalar.
{
  const FID = F.custom;
  await sql`UPDATE lb_tracking_custom_code
            SET code = to_jsonb(${'{"head_html":"<b>LEGACY</b>","body_html":"<i>LEGACY_B</i>"}'}::text)
            WHERE funnel_id = ${FID}`;
  const t = await sql`SELECT jsonb_typeof(code) AS t FROM lb_tracking_custom_code WHERE funnel_id = ${FID}`;
  check('E10 fixture really is a jsonb STRING scalar', t[0]?.t === 'string', JSON.stringify(t[0]));

  const g = await req('GET', `/${FID}/tracking/custom`);
  check('E10 GET reads the double-encoded STRING shape → 200', g.status === 200, g.text?.slice(0, 200));
  check('E10 head read back correctly from the string shape', g.j?.data?.head_html === '<b>LEGACY</b>', JSON.stringify(g.j?.data?.head_html));
  check('E10 body read back correctly from the string shape', g.j?.data?.body_html === '<i>LEGACY_B</i>', JSON.stringify(g.j?.data?.body_html));

  // THE CASE-guard test: `jsonb_string || jsonb_object` throws in Postgres.
  const p = await req('PUT', `/${FID}/tracking/custom`, { head_html: '<b>REPAIRED</b>' });
  check('E10 PUT over a scalar does NOT 500 (CASE guard works)', p.status === 200, `${p.status} ${p.text?.slice(0, 200)}`);
  check('E10 PUT over a scalar stores the new head', p.j?.data?.head_html === '<b>REPAIRED</b>', JSON.stringify(p.j?.data?.head_html));
  const t2 = await sql`SELECT jsonb_typeof(code) AS t FROM lb_tracking_custom_code WHERE funnel_id = ${FID}`;
  check('E10 the row is repaired to an OBJECT', t2[0]?.t === 'object', JSON.stringify(t2[0]));

  // Unparseable scalar must degrade to empty, never 500.
  await sql`UPDATE lb_tracking_custom_code SET code = to_jsonb(${'{not json at all'}::text) WHERE funnel_id = ${FID}`;
  const g2 = await req('GET', `/${FID}/tracking/custom`);
  check('E10 unparseable scalar → 200 with empty snippets, never a 500', g2.status === 200 && g2.j?.data?.head_html === '', `${g2.status} ${g2.text?.slice(0, 200)}`);
  await sql`DELETE FROM lb_tracking_custom_code WHERE funnel_id = ${FID}`;
}

// ── E11 32KB BOUNDARY enforced AT THE ROUTE ─────────────────────────────────
{
  const FID = F.custom;
  const at = 'a'.repeat(32768);
  const over = 'a'.repeat(32769);
  const rOk = await req('PUT', `/${FID}/tracking/custom`, { head_html: at });
  check('E11 exactly 32768 bytes → 200', rOk.status === 200, `${rOk.status} ${rOk.text?.slice(0, 200)}`);
  check('E11 32768 bytes round-trips byte-for-byte through jsonb', rOk.j?.data?.head_html?.length === 32768, String(rOk.j?.data?.head_html?.length));

  const rBad = await req('PUT', `/${FID}/tracking/custom`, { head_html: over });
  check('E11 32769 bytes → 400', rBad.status === 400, `${rBad.status} ${rBad.text?.slice(0, 200)}`);
  check('E11 400 code is head_html_too_large', rBad.j?.error?.code === 'head_html_too_large', JSON.stringify(rBad.j?.error));

  // The rejected write must NOT have modified the stored row.
  const g = await req('GET', `/${FID}/tracking/custom`);
  check('E11 rejected oversize write left the stored value untouched', g.j?.data?.head_html?.length === 32768, String(g.j?.data?.head_html?.length));

  // Multi-byte: under the limit by .length, over it in BYTES.
  const multi = 'é'.repeat(20000); // 40000 bytes, 20000 chars
  const rMulti = await req('PUT', `/${FID}/tracking/custom`, { body_html: multi });
  check('E11 multi-byte payload rejected on BYTES, not characters', rMulti.status === 400 && rMulti.j?.error?.code === 'body_html_too_large', `${rMulti.status} ${JSON.stringify(rMulti.j?.error)}`);

  // A real multi-byte snippet UNDER the cap must round-trip intact.
  const emoji = '<script>/* ✅ 你好 café */</script>';
  const rE = await req('PUT', `/${FID}/tracking/custom`, { head_html: emoji });
  check('E11 multi-byte snippet under the cap round-trips exactly', rE.j?.data?.head_html === emoji, JSON.stringify(rE.j?.data?.head_html));
}

// ── E12 route-level validation + auth against the REAL DB ───────────────────
{
  const FID = F.custom;
  check('E12 empty PUT → 400 empty_update', (await req('PUT', `/${FID}/tracking/custom`, {})).j?.error?.code === 'empty_update');
  check('E12 wrong type → 400 invalid_head_html', (await req('PUT', `/${FID}/tracking/custom`, { head_html: 5 })).j?.error?.code === 'invalid_head_html');
  const noAuth = { 'Content-Type': 'application/json' };
  check('E12 GET health without token → 401', (await req('GET', `/${F.healthy}/tracking/health`, undefined, noAuth)).status === 401);
  check('E12 GET custom without token → 401', (await req('GET', `/${FID}/tracking/custom`, undefined, noAuth)).status === 401);
  check('E12 PUT custom without token → 401', (await req('PUT', `/${FID}/tracking/custom`, { head_html: 'x' }, noAuth)).status === 401);
}

// ── E13 permission gate: a user WITHOUT funnels:access is refused ───────────
{
  await sql`INSERT INTO users (id, email, first_name, last_name) VALUES ('u_trx_noperm', 'np@local.test', 'No', 'Perm') ON CONFLICT (id) DO NOTHING`;
  await sql`INSERT INTO roles (id, name, permissions) VALUES ('r_trx_noperm', 'no-funnels', '{"orders": ["access"]}') ON CONFLICT (id) DO NOTHING`;
  await sql`DELETE FROM user_roles WHERE user_id = 'u_trx_noperm'`;
  await sql`INSERT INTO user_roles (user_id, role_id) VALUES ('u_trx_noperm', 'r_trx_noperm')`;
  const t2 = jwt.sign({ userId: 'u_trx_noperm' }, process.env.JWT_ACCESS_SECRET, { expiresIn: '10m' });
  const H2 = { Authorization: `Bearer ${t2}`, 'Content-Type': 'application/json' };
  const a = await req('GET', `/${F.healthy}/tracking/health`, undefined, H2);
  check('E13 health refused without funnels:access', a.status === 403, `${a.status} ${a.text?.slice(0, 160)}`);
  const b = await req('PUT', `/${F.custom}/tracking/custom`, { head_html: 'x' }, H2);
  check('E13 custom PUT refused without funnels:access', b.status === 403, `${b.status} ${b.text?.slice(0, 160)}`);
}

// ── E14 PRECEDENCE probes, seeded end-to-end (review M2) ────────────────────
// The exact two shapes the reviewer reproduced: a pixel with NO CAPI token
// (misconfigured by config shape) that is ALSO drowning in real delivery
// failures / stranded conversions. Measured evidence must beat the prediction.
{
  const FM = 'fnl_trx_m2queue';
  const FF = 'fnl_trx_m2failed';
  for (const fid of [FM, FF]) {
    await sql`DELETE FROM lb_pixels WHERE funnel_id = ${fid}`;
    await sql`DELETE FROM lb_tracking_events WHERE funnel_id = ${fid}`;
    await sql`DELETE FROM lb_postback_queue WHERE funnel_id = ${fid}`;
    await sql`INSERT INTO funnels (id, name, slug) VALUES (${fid}, ${fid}, ${fid}) ON CONFLICT (id) DO NOTHING`;
    // config '{}' = NO capi_token → serverChannelReady false → misconfigured.
    await sql`INSERT INTO lb_pixels (id, funnel_id, kind, pixel_id, mode, enabled, config)
              VALUES (${'px_' + fid}, ${fid}, 'meta_pixel', '778899001', 'hybrid', TRUE, ${sql.json({})})`;
  }
  // Probe 1: misconfigured + 12 conversions stranded in the retry queue.
  for (let i = 0; i < 12; i++) {
    await sql`INSERT INTO lb_postback_queue (id, funnel_id, scope_id, status, envelope, pixel_row_id, attempts, next_at, created_at)
              VALUES (${'pq_m2_' + i}, ${FM}, ${`${FM}:px_${FM}`}, 'queued', ${sql.json({ i })}, ${'px_' + FM}, 1, NOW(), NOW())`;
  }
  {
    const { d } = await health(FM);
    const p = d?.pixels?.[0];
    check('E14a misconfigured + stuck queue → outage, NOT misconfigured', p?.status === 'outage', JSON.stringify(p?.status));
    check('E14a renders RED not amber', p?.tone === 'danger', JSON.stringify(p?.tone));
    check('E14a stranded depth reported (12)', p?.queued_now === 12, JSON.stringify(p?.queued_now));
    check('E14a server_channel_ready still honestly false', p?.server_channel_ready === false, JSON.stringify(p?.server_channel_ready));
    check('E14a funnel roll-up is outage', d?.overall === 'outage', JSON.stringify(d?.overall));
  }
  // Probe 2: misconfigured + 20 failed sends, no backlog.
  for (let i = 0; i < 20; i++) await ev(FF, 'error', 'http_401: invalid token', '30 minutes');
  {
    const { d } = await health(FF);
    const p = d?.pixels?.[0];
    check('E14b misconfigured + failed sends → failing, NOT misconfigured', p?.status === 'failing', JSON.stringify(p?.status));
    check('E14b renders RED not amber', p?.tone === 'danger', JSON.stringify(p?.tone));
    check('E14b 24h failed === 20', p?.windows?.h24?.failed === 20, JSON.stringify(p?.windows?.h24));
    check('E14b last_error surfaced', p?.last_error === 'http_401: invalid token', JSON.stringify(p?.last_error));
  }
  // Control: same misconfigured pixel, NO contradicting evidence → misconfigured.
  await sql`DELETE FROM lb_tracking_events WHERE funnel_id = ${FF}`;
  {
    const { d } = await health(FF);
    const p = d?.pixels?.[0];
    check('E14c misconfigured with no evidence against it → misconfigured', p?.status === 'misconfigured', JSON.stringify(p?.status));
    check('E14c names the missing credential', Array.isArray(p?.missing) && p.missing.includes('capi_token'), JSON.stringify(p?.missing));
  }
  for (const fid of [FM, FF]) {
    await sql`DELETE FROM lb_postback_queue WHERE funnel_id = ${fid}`;
    await sql`DELETE FROM lb_pixels WHERE funnel_id = ${fid}`;
    await sql`DELETE FROM lb_tracking_events WHERE funnel_id = ${fid}`;
    await sql`DELETE FROM funnels WHERE id = ${fid}`;
  }
}

// ── E15 breaker copy composed server-side (review m6) ───────────────────────
{
  const scope = `${F.breaker}:${pxId('breaker')}`;
  // Lapsed cooldown: fails above the threshold, open_until in the PAST.
  await sql`UPDATE lb_postback_breakers SET fails = 7, open_until = NOW() - INTERVAL '5 minutes' WHERE scope_id = ${scope}`;
  const { d } = await health(F.breaker);
  const b = d?.pixels?.[0]?.breaker;
  check('E15 lapsed cooldown reads closed', b?.state === 'closed', JSON.stringify(b));
  check('E15 cooldown_lapsed flagged', b?.cooldown_lapsed === true, JSON.stringify(b));
  check('E15 copy says retrying, not "opens at 5"',
    b?.note === 'Cooldown lapsed after 7 consecutive failures — delivery is retrying.', JSON.stringify(b?.note));
  check('E15 no self-contradicting copy', !/opens at/.test(String(b?.note)), JSON.stringify(b?.note));
}

// ── E16 totals: ledger sum vs live gauge (review M3) ────────────────────────
{
  await sql`INSERT INTO lb_postback_queue (id, funnel_id, scope_id, status, envelope, pixel_row_id, attempts, next_at, created_at)
            VALUES ('pq_m3_1', ${F.healthy}, ${`${F.healthy}:${pxId('healthy')}`}, 'queued', ${sql.json({})}, ${pxId('healthy')}, 1, NOW(), NOW())`;
  await ev(F.healthy, 'queued', 'retry scheduled', '1 hour');
  const { d } = await health(F.healthy);
  check('E16 totals_24h.queued is the LEDGER count (1)', d?.totals_24h?.queued === 1, JSON.stringify(d?.totals_24h));
  check('E16 queued_now is the LIVE depth (1), reported separately', d?.queued_now === 1, JSON.stringify(d?.queued_now));
  check('E16 live gauge is NOT inside totals_24h', d?.totals_24h?.queued_now === undefined, JSON.stringify(d?.totals_24h));
  await sql`DELETE FROM lb_postback_queue WHERE funnel_id = ${F.healthy}`;
}

// ── E17 nonexistent funnel → 404 on all three routes (review m7) ────────────
{
  const GHOST = 'fnl_trx_does_not_exist';
  await sql`DELETE FROM funnels WHERE id = ${GHOST}`;
  const a = await req('GET', `/${GHOST}/tracking/health`);
  check('E17 health on a nonexistent funnel → 404', a.status === 404, `${a.status} ${a.text?.slice(0, 120)}`);
  check('E17 404 code is funnel_not_found', a.j?.error?.code === 'funnel_not_found', JSON.stringify(a.j?.error));
  const b = await req('GET', `/${GHOST}/tracking/custom`);
  check('E17 custom GET on a nonexistent funnel → 404', b.status === 404, String(b.status));
  const c = await req('PUT', `/${GHOST}/tracking/custom`, { head_html: '<x>' });
  check('E17 custom PUT on a nonexistent funnel → 404', c.status === 404, String(c.status));
  // THE POINT: the refused PUT must not have created an orphan row.
  const orphan = await sql`SELECT count(*)::int n FROM lb_tracking_custom_code WHERE funnel_id = ${GHOST}`;
  check('E17 no orphan row written (write amplification killed)', orphan[0].n === 0, JSON.stringify(orphan[0]));
}

// ── E18 funnel id is no longer silently truncated (review n8) ───────────────
{
  // A 70-char id: the old `.slice(0, 64)` would have chopped it into a
  // different id, matching nothing and — worse — never lining up with a
  // breaker scope built from the full value.
  const LONG = 'fnl_' + 'x'.repeat(66); // 70 chars
  await sql`INSERT INTO funnels (id, name, slug) VALUES (${LONG}, 'long', ${'s' + Date.now()}) ON CONFLICT (id) DO NOTHING`;
  const r = await req('GET', `/${LONG}/tracking/health`);
  check('E18 a 70-char funnel id resolves (no truncation) → 200', r.status === 200, `${r.status} ${r.text?.slice(0, 160)}`);
  const w = await req('PUT', `/${LONG}/tracking/custom`, { head_html: '<long/>' });
  check('E18 custom PUT stores under the FULL id', w.status === 200, String(w.status));
  const stored = await sql`SELECT funnel_id FROM lb_tracking_custom_code WHERE funnel_id = ${LONG}`;
  check('E18 stored key is the untruncated id', stored[0]?.funnel_id === LONG, JSON.stringify(stored[0]?.funnel_id?.length));
  // Over the hard bound → 400, not a silent truncate.
  const over = 'f'.repeat(200);
  const ro = await req('GET', `/${over}/tracking/health`);
  check('E18 an over-length id → 400 invalid_funnel_id', ro.status === 400 && ro.j?.error?.code === 'invalid_funnel_id', `${ro.status} ${JSON.stringify(ro.j?.error)}`);
  await sql`DELETE FROM lb_tracking_custom_code WHERE funnel_id = ${LONG}`;
  await sql`DELETE FROM funnels WHERE id = ${LONG}`;
}

// ── E19 updated_by surfaced on GET (review item 6) ──────────────────────────
{
  await req('PUT', `/${F.custom}/tracking/custom`, { head_html: '<who/>' });
  const g = await req('GET', `/${F.custom}/tracking/custom`);
  check('E19 GET surfaces updated_by', g.j?.data?.updated_by === 'u_trx_test', JSON.stringify(g.j?.data?.updated_by));
}

// ── E20 the lb_tracking_events prune actually deletes (review m5) ───────────
{
  const { pruneExpired } = await import('../../src/services/trackingSweeps.js');
  await sql`INSERT INTO lb_tracking_events (funnel_id, platform, pixel_id, event_name, event_id, status, source, idk, ts)
            VALUES (${F.healthy}, 'meta', 'x', 'Purchase', 'e_ancient', 'sent', 'relay', ${sql.json([])}, NOW() - INTERVAL '200 days'),
                   (${F.healthy}, 'meta', 'x', 'Purchase', 'e_recent', 'sent', 'relay', ${sql.json([])}, NOW() - INTERVAL '10 days')`;
  const before = await sql`SELECT count(*)::int n FROM lb_tracking_events WHERE event_id IN ('e_ancient','e_recent')`;
  check('E20 both fixture rows present before prune', before[0].n === 2, JSON.stringify(before[0]));
  await pruneExpired();
  const after = await sql`SELECT event_id FROM lb_tracking_events WHERE event_id IN ('e_ancient','e_recent')`;
  const ids = after.map((r) => r.event_id);
  check('E20 the 200-day-old row is pruned', !ids.includes('e_ancient'), JSON.stringify(ids));
  check('E20 the 10-day-old row SURVIVES (order forensics preserved)', ids.includes('e_recent'), JSON.stringify(ids));
  await sql`DELETE FROM lb_tracking_events WHERE event_id IN ('e_ancient','e_recent')`;
}

// ── cleanup ─────────────────────────────────────────────────────────────────
for (const fid of ALL) {
  await sql`DELETE FROM lb_pixels WHERE funnel_id = ${fid}`;
  await sql`DELETE FROM lb_tracking_events WHERE funnel_id = ${fid}`;
  await sql`DELETE FROM lb_postback_breakers WHERE funnel_id = ${fid}`;
  await sql`DELETE FROM lb_postback_queue WHERE funnel_id = ${fid}`;
  await sql`DELETE FROM lb_tracking_custom_code WHERE funnel_id = ${fid}`;
  await sql`DELETE FROM funnels WHERE id = ${fid}`;
}
await sql`DELETE FROM user_roles WHERE user_id IN ('u_trx_test', 'u_trx_noperm')`;
await sql`DELETE FROM roles WHERE id IN ('r_trx_test', 'r_trx_noperm')`;
await sql`DELETE FROM users WHERE id IN ('u_trx_test', 'u_trx_noperm')`;
await sql.end();
server.close();
console.log(`\nRESULT: ${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
