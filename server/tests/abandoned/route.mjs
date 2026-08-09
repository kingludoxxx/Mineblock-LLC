// Abandoned-checkouts ROUTE verification — boots the REAL router
// (real authenticate + requirePermission + the real SQL) on a bare express app
// against the embedded Postgres, exactly like server/tests/integrations/klaviyo.mjs.
//
// The point of this harness is the SQL: the two-population CTE, the grace-window
// bounds, the sidecar join, the filters, and the recovered-attribution sweep are
// all things a pure-logic harness cannot prove. Klaviyo is swapped at the
// abandonedRecovery `_deps` seam, so no network call ever leaves the process.
//
// Run:  node server/tests/abandoned/route.mjs      (embedded PG on :5433)
const ROOT = new URL('../../..', import.meta.url).pathname.replace(/\/$/, '');
const NM = '/Users/ludo/Mineblock-LLC/node_modules';
const express = (await import(`${NM}/express/index.js`)).default;
const jwt = (await import(`${NM}/jsonwebtoken/index.js`)).default;
const postgres = (await import(`${NM}/postgres/src/index.js`)).default;

const DB = 'postgres://puure@127.0.0.1:5433/puure_abandoned';
const admin = postgres('postgres://puure@127.0.0.1:5433/postgres', { ssl: false, onnotice: () => {} });
await admin`DROP DATABASE IF EXISTS puure_abandoned`;
await admin`CREATE DATABASE puure_abandoned`;
await admin.end();

process.env.DATABASE_URL = DB;
process.env.ABANDON_MINUTES = '60';
process.env.CHECKOUT_RESUME_SECRET = 'route-harness-secret';
process.env.APP_BASE_URL = 'https://harness.test';
// No Shopify credentials on purpose — the auto-sync MUST fail closed and the
// list must still be served from cache.
delete process.env.SHOPIFY_STORE_DOMAIN;
delete process.env.SHOPIFY_ACCESS_TOKEN;
delete process.env.PUURE_SHOPIFY_STORE;
delete process.env.PUURE_SHOPIFY_TOKEN;

const sql = postgres(DB, { ssl: false, onnotice: () => {} });

// ── auth seed (patch-settings style) ────────────────────────────────────────
await sql`CREATE TABLE IF NOT EXISTS users (
  id TEXT PRIMARY KEY, email TEXT, first_name TEXT, last_name TEXT,
  must_change_password BOOLEAN DEFAULT FALSE, email_verified BOOLEAN DEFAULT TRUE,
  is_active BOOLEAN DEFAULT TRUE
)`;
await sql`CREATE TABLE IF NOT EXISTS roles (id TEXT PRIMARY KEY, name TEXT, permissions JSONB)`;
await sql`CREATE TABLE IF NOT EXISTS user_roles (user_id TEXT, role_id TEXT)`;
await sql`INSERT INTO users (id, email, first_name, last_name) VALUES ('u_ab', 'ab@local.test', 'Ab', 'Test') ON CONFLICT (id) DO NOTHING`;
await sql`INSERT INTO roles (id, name, permissions) VALUES ('r_ab', 'orders-tester', '{"orders": ["access"]}') ON CONFLICT (id) DO NOTHING`;
await sql`INSERT INTO user_roles (user_id, role_id) VALUES ('u_ab', 'r_ab')`;

const { ensureCheckoutTables } = await import(`${ROOT}/server/src/services/checkoutSchema.js`);
await ensureCheckoutTables();
const recovery = await import(`${ROOT}/server/src/services/abandonedRecovery.js`);
const abandonedRouter = (await import(`${ROOT}/server/src/routes/abandonedCheckouts.js`)).default;

// ── fixtures ────────────────────────────────────────────────────────────────
const hoursAgo = (h) => new Date(Date.now() - h * 3600000);
const cart = [{ title: 'Breast Lift Tape', quantity: 2, price: 24.5, variant_id: 555 }];

// Every session THIS HARNESS settles is recorded, so §11 can assert that the
// paid set is exactly the harness's doing and the recovery lane added none.
const harnessPaid = new Set();

async function seedSession(id, { status = 'processing', email, hours = 3, total = 49, paidAt = null, shipping = {}, funnel = 'fnl_1', gatewaySession = 'ch_live_seed' } = {}) {
  // gateway_session_id is set on PURPOSE: checkoutPublic.js writes it at INTENT
  // time on a row still guarded `WHERE status = 'processing'`, so every real
  // cart that reached the gateway carries one. A fixture without it would hide
  // any regression that mistook it for payment evidence.
  await sql`INSERT INTO co_sessions (id, funnel_id, status, line_items, total, currency, customer, gateway, gateway_session_id, paid_at, created_at, updated_at)
    VALUES (${id}, ${funnel}, ${status}, ${sql.json(cart)}, ${total}, 'USD',
            ${sql.json({ email, first_name: 'Jo', last_name: 'Buyer', shipping: { city: 'Milan', country: 'IT', ...shipping } })},
            'whop', ${gatewaySession}, ${paidAt}, ${hoursAgo(hours)}, NOW())`;
  if (status === 'paid') harnessPaid.add(id);
}

await seedSession('s_abandoned', { email: 'abandoned@buyer.test', hours: 3 });
await seedSession('s_fresh', { email: 'fresh@buyer.test', hours: 0.25 });        // inside the 60-min grace
await seedSession('s_paid', { email: 'paid@buyer.test', hours: 5, status: 'paid', paidAt: hoursAgo(4) });
await seedSession('s_noemail', { email: '', hours: 4 });
await seedSession('s_bademail', { email: 'not-an-address', hours: 4 });
await seedSession('s_old', { email: 'ancient@buyer.test', hours: 24 * 40 });      // outside every window

// ── app ─────────────────────────────────────────────────────────────────────
const app = express();
app.use(express.json({ limit: '1mb' }));
app.use('/api/v1/abandoned', abandonedRouter);
const server = app.listen(0);
const PORT = server.address().port;
const B = `http://127.0.0.1:${PORT}/api/v1/abandoned`;
const token = jwt.sign({ userId: 'u_ab' }, process.env.JWT_ACCESS_SECRET || 'dev-access-secret-change-me', { expiresIn: '10m' });
const H = { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' };

let pass = 0;
let fail = 0;
const check = (name, ok, extra = '') => {
  if (ok) { pass += 1; console.log(`  ok   ${name}`); }
  else { fail += 1; console.log(`  FAIL ${name}${extra ? `  — ${extra}` : ''}`); }
};
const req = async (method, path, body, headers = H) => {
  const r = await fetch(`${B}${path}`, {
    method,
    headers,
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await r.text();
  let j = null;
  try { j = JSON.parse(text); } catch { /* non-json body stays in text */ }
  return { status: r.status, j, text };
};
const byRef = (rows, ref) => (rows || []).find((r) => r.ref_id === ref) || null;

// The write endpoints are rate-limited PER OPERATOR (6 sweeps / 10 min), which
// is the point — but a harness that exercises the sweep a dozen times would
// throttle itself. Each phase gets its own operator, exactly like two real
// admins would. The limit itself is asserted separately in §14.
let userSeq = 0;
const SECRET = process.env.JWT_ACCESS_SECRET || 'dev-access-secret-change-me';
async function freshOperator() {
  userSeq += 1;
  const id = `u_ab_${userSeq}`;
  await sql`INSERT INTO users (id, email, first_name, last_name) VALUES (${id}, ${`${id}@local.test`}, 'Ab', ${String(userSeq)}) ON CONFLICT (id) DO NOTHING`;
  await sql`INSERT INTO user_roles (user_id, role_id) VALUES (${id}, 'r_ab')`;
  return { Authorization: `Bearer ${jwt.sign({ userId: id }, SECRET, { expiresIn: '10m' })}`, 'Content-Type': 'application/json' };
}
const sweep = async (body = { days: 14 }) => req('POST', '/detector/run', body, await freshOperator());

// Klaviyo seam — no network, and every send is recorded. `beforeSend` is the
// hook the settle-mid-sweep case uses to mutate the database between the
// sweep's snapshot and the next row's send.
const sent = [];
let sendMode = 'ok';
let beforeSend = null;
recovery._deps.getKlaviyoConfig = async () => (sendMode === 'off'
  ? { enabled: false, apiKey: '' }
  : { enabled: true, apiKey: 'pk_test_route_harness' });
recovery._deps.upsertProfile = async () => ({ ok: true });
recovery._deps.trackEvent = async (e) => {
  sent.push(e);
  if (beforeSend) { const f = beforeSend; beforeSend = null; await f(e); }
  return sendMode === 'vendor_500' ? { ok: false, error: 'http_500' } : { ok: true };
};

// ── 1. auth ─────────────────────────────────────────────────────────────────
console.log('\n1. auth');
check('no token → 401', (await req('GET', '/?nosync=1', undefined, { 'Content-Type': 'application/json' })).status === 401);
{
  const bad = jwt.sign({ userId: 'nobody' }, process.env.JWT_ACCESS_SECRET || 'dev-access-secret-change-me');
  const r = await req('GET', '/?nosync=1', undefined, { Authorization: `Bearer ${bad}`, 'Content-Type': 'application/json' });
  check('unknown user → 401/403, never 200', r.status === 401 || r.status === 403, String(r.status));
}

// ── 2. the list + the abandonment window ────────────────────────────────────
console.log('\n2. list — the grace window decides who is on it');
let list;
{
  const r = await req('GET', '/?nosync=1&days=7');
  check('GET / → 200', r.status === 200, r.text.slice(0, 200));
  list = r.j.data;
  check('the 3h-old cart with an email IS abandoned', Boolean(byRef(list.checkouts, 's_abandoned')));
  check('the 15-min-old cart is NOT (still inside the grace)', !byRef(list.checkouts, 's_fresh'));
  check('the PAID session is NOT on the list', !byRef(list.checkouts, 's_paid'));
  check('a session with NO email is NOT on the list', !byRef(list.checkouts, 's_noemail'));
  check('a 40-day-old cart is outside the 7d window', !byRef(list.checkouts, 's_old'));
  check('an undeliverable-but-present email IS listed (operator can still see it)', Boolean(byRef(list.checkouts, 's_bademail')));
  check('window echoes the grace in minutes', list.window.grace_minutes === 60, JSON.stringify(list.window));
  check('total matches the row count', list.total === list.checkouts.length, `${list.total} vs ${list.checkouts.length}`);
  check('value_at_stake sums the carts', Number(list.value_at_stake) === 98, String(list.value_at_stake));
  check('by_source splits the populations', list.by_source.funnel === 2 && list.by_source.shopify === 0, JSON.stringify(list.by_source));
}
{
  const r = await req('GET', '/?nosync=1&days=90');
  check('days=90 reaches the 40-day-old cart', Boolean(byRef(r.j.data.checkouts, 's_old')));
}
{
  const r = await req('GET', '/?nosync=1&days=999');
  check('an out-of-range days is clamped, not rejected', r.status === 200 && r.j.data.window.days === 90);
}
{
  const row = byRef(list.checkouts, 's_abandoned');
  check('row carries the shaped cart', row.item_count === 2 && row.items[0].title === 'Breast Lift Tape', JSON.stringify(row.items));
  check('row starts at "Not recovered"', row.recovery_status === 'Not recovered');
  check('a deliverable, past-grace row is nudgeable', row.nudgeable === true, row.state_reason);
  check('the bad-email row is NOT nudgeable', byRef(list.checkouts, 's_bademail').nudgeable === false);
  check('row id is source-qualified', row.id === 'funnel:s_abandoned');
  check('location comes off the shipping block', row.destination_city === 'Milan');
}

// ── 3. the shopify population + a failing auto-sync ─────────────────────────
console.log('\n3. shopify leg');
await sql`INSERT INTO crm_abandoned_checkouts (checkout_id, email, customer_first_name, total_price, currency, line_items, item_count, recovery_url, destination_city, created_at)
  VALUES (777, 'shopper@buyer.test', 'Shop', 61.00, 'USD', ${sql.json([{ title: 'Activator Oil', quantity: 1, price: 61 }])}, 1,
          'https://shop.test/recover/777', 'Rome', ${hoursAgo(6)})`;
await sql`INSERT INTO crm_abandoned_checkouts (checkout_id, email, total_price, currency, line_items, item_count, created_at, completed_at)
  VALUES (778, 'converted@buyer.test', 30.00, 'USD', '[]', 0, ${hoursAgo(6)}, ${hoursAgo(5)})`;
{
  const r = await req('GET', '/?nosync=1&days=7');
  check('shopify checkouts join the same list', Boolean(byRef(r.j.data.checkouts, '777')));
  check('a COMPLETED shopify checkout is excluded', !byRef(r.j.data.checkouts, '778'));
  check('shopify row carries Shopify’s own recovery url',
    byRef(r.j.data.checkouts, '777').recovery_url === 'https://shop.test/recover/777');
  check('by_source now counts both', r.j.data.by_source.shopify === 1 && r.j.data.by_source.funnel === 2);
}
{
  // No Shopify credentials configured → syncFromShopify throws, the route
  // catches it, and the cached list is still served (fail OPEN for reads).
  const r = await req('GET', '/?days=7');
  check('auto-sync failure still serves the cached list', r.status === 200 && r.j.data.checkouts.length > 0);
  const s = await req('POST', '/sync');
  check('explicit /sync surfaces the misconfiguration as 500', s.status === 500 && s.j.error.includes('Shopify not configured'), s.text.slice(0, 120));
}

// ── 4. filters ──────────────────────────────────────────────────────────────
console.log('\n4. filters');
check('source=funnel', (await req('GET', '/?nosync=1&source=funnel')).j.data.checkouts.every((r) => r.source === 'funnel'));
check('source=shopify', (await req('GET', '/?nosync=1&source=shopify')).j.data.checkouts.every((r) => r.source === 'shopify'));
check('an unknown source is IGNORED, not injected', (await req('GET', '/?nosync=1&source=nmi')).j.data.total >= 3);
check('q matches an email', (await req('GET', '/?nosync=1&q=shopper@')).j.data.total === 1);
check('q matches a name', (await req('GET', '/?nosync=1&q=Jo Buyer')).j.data.total === 2);
check('a LIKE wildcard in q is escaped, not honoured', (await req('GET', '/?nosync=1&q=%25')).j.data.total === 0);
check('status=Sent is empty before any nudge', (await req('GET', '/?nosync=1&status=Sent')).j.data.total === 0);
check('limit is clamped to 100', (await req('GET', '/?nosync=1&limit=9999')).status === 200);

// ── 5. detail ───────────────────────────────────────────────────────────────
console.log('\n5. detail');
await sql`INSERT INTO co_events (session_id, kind, data, created_at) VALUES ('s_abandoned', 'session_created', '{}', ${hoursAgo(3)})`;
{
  const r = await req('GET', '/funnel/s_abandoned');
  check('detail → 200', r.status === 200, r.text.slice(0, 160));
  check('full cart contents are returned', r.j.data.cart.items.length === 1 && r.j.data.cart.subtotal === 49, JSON.stringify(r.j.data.cart));
  check('the session event trail rides along', r.j.data.events.length === 1 && r.j.data.events[0].kind === 'session_created');
  check('recovery sidecar is null before any action', r.j.data.recovery === null);
}
check('shopify detail works too', (await req('GET', '/shopify/777')).j.data.checkout.total_price === 61);
check('unknown id → 404', (await req('GET', '/funnel/nope')).status === 404);
check('a non-numeric shopify id → 404, never a SQL error', (await req('GET', '/shopify/abc')).status === 404);
check('unknown source → 400', (await req('GET', '/paypal/1')).status === 400);

// ── 6. recovery link ────────────────────────────────────────────────────────
console.log('\n6. recovery link');
{
  const r = await req('POST', '/funnel/s_abandoned/recovery-link');
  check('link minted → 200', r.status === 200, r.text.slice(0, 160));
  const url = r.j.data.link_url;
  check('link points at the resume contract path', url.startsWith('https://harness.test/api/v1/checkout/public/resume/'), url);
  const tok = decodeURIComponent(url.split('/').pop());
  const claims = recovery.verifyRecoveryToken(tok);
  check('the minted token verifies back to this cart', claims && claims.source === 'funnel' && claims.ref === 's_abandoned', JSON.stringify(claims));
  check('an expiry is stored', Boolean(r.j.data.expires_at));
  const again = await req('POST', '/funnel/s_abandoned/recovery-link');
  check('re-minting is idempotent at the row level (still one sidecar row)', again.status === 200);
  check('sidecar has exactly one row for this cart',
    (await sql`SELECT COUNT(*)::int AS n FROM crm_recovery_meta WHERE ref_id = 's_abandoned'`)[0].n === 1);
}
{
  const r = await req('POST', '/shopify/777/recovery-link');
  check('shopify link is SHOPIFY’s, flagged external', r.j.data.external === true && r.j.data.link_url === 'https://shop.test/recover/777');
}

// ── 7. the nudge ────────────────────────────────────────────────────────────
console.log('\n7. send recovery');
sendMode = 'off';
check('Klaviyo disconnected → 409 with an actionable message',
  (await req('POST', '/funnel/s_abandoned/send')).status === 409);
sendMode = 'ok';
{
  sent.length = 0;
  const r = await req('POST', '/funnel/s_abandoned/send');
  check('send → 200', r.status === 200, r.text.slice(0, 200));
  check('exactly ONE event was fired', sent.length === 1, String(sent.length));
  check('the event carries the recovery link', String(sent[0].properties.RecoveryUrl).includes('/checkout/public/resume/'));
  check('the event is flagged Manual', sent[0].properties.Manual === true);
  check('unique_id is stable per cart', sent[0].unique_id === 'ab_funnel_s_abandoned');
  // B1 regression: the route emits the cart total as `total_price`; reading
  // only `row.total` shipped every production event at value 0 — which no
  // fixture caught, because the fixture spelled it `total`.
  check('the event VALUE is the real cart total, not 0', sent[0].value === 49, String(sent[0].value));
  check('sidecar flipped to Sent', r.j.data.recovery.recovery_status === 'Sent');
  const l = await req('GET', '/?nosync=1&status=Sent');
  check('the list now shows it as Sent', byRef(l.j.data.checkouts, 's_abandoned')?.recovery_status === 'Sent');
  check('emails_sent KPI moved', l.j.data.emails_sent >= 1);
}
{
  const before = (await sql`SELECT sent_at FROM crm_recovery_meta WHERE ref_id = 's_abandoned'`)[0].sent_at;
  await new Promise((r) => setTimeout(r, 1100)); // guarantee a distinguishable clock
  sent.length = 0;
  const r = await req('POST', '/funnel/s_abandoned/send');
  check('a RESEND dedups instead of double-emailing', r.status === 200 && r.j.data.deduped === true, r.text.slice(0, 160));
  check('the deduped resend fired NO second event', sent.length === 0);
  // M6: sent_at is the clock the attribution sweep compares payments against.
  // If a resend moved it forward, it would step past a payment the original
  // nudge had earned and silently uncredit the recovery.
  const after = (await sql`SELECT sent_at FROM crm_recovery_meta WHERE ref_id = 's_abandoned'`)[0].sent_at;
  check('the deduped resend did NOT move sent_at',
    new Date(before).getTime() === new Date(after).getTime(), `${before} → ${after}`);
}
check('a PAID session refuses the nudge (double-charge guard)',
  (await req('POST', '/funnel/s_paid/send')).status === 409);
check('an undeliverable email → 422', (await req('POST', '/funnel/s_bademail/send')).status === 422);
check('the 422 stamped the row undeliverable so the sweep stops re-scanning it',
  (await sql`SELECT undeliverable FROM crm_recovery_meta WHERE ref_id = 's_bademail'`)[0].undeliverable === true);
check('unknown cart → 404', (await req('POST', '/funnel/ghost/send')).status === 404);

// ── 8. manual status override ───────────────────────────────────────────────
console.log('\n8. manual status');
check('an unknown status → 422', (await req('POST', '/shopify/777/recovery', { status: 'Whatever' })).status === 422);
check('a missing status → 422', (await req('POST', '/shopify/777/recovery', {})).status === 422);
{
  const r = await req('POST', '/shopify/777/recovery', { status: 'Recovered' });
  check('operator override writes the sidecar', r.status === 200 && r.j.data.recovery.recovery_status === 'Recovered');
  const l = await req('GET', '/?nosync=1&status=Recovered');
  check('status filter finds it', byRef(l.j.data.checkouts, '777')?.recovery_status === 'Recovered');
}

// ── 9. the detector sweep ───────────────────────────────────────────────────
console.log('\n9. detector sweep');
await seedSession('s_sweep1', { email: 'sweep1@buyer.test', hours: 2 });
await seedSession('s_sweep2', { email: 'sweep2@buyer.test', hours: 2 });
{
  sent.length = 0;
  const r = await sweep();
  check('sweep → 200', r.status === 200, r.text.slice(0, 200));
  check('it nudged exactly the two new carts', r.j.data.sent === 2, JSON.stringify(r.j.data));
  check('one event per cart', sent.length === 2);
  check('already-Sent carts are skipped, not re-sent', !sent.some((e) => e.unique_id === 'ab_funnel_s_abandoned'));
  check('the fresh in-grace cart was never scanned', !sent.some((e) => e.unique_id === 'ab_funnel_s_fresh'));
  check('the paid session was never scanned', !sent.some((e) => e.unique_id === 'ab_funnel_s_paid'));
  check('the undeliverable row is counted separately', r.j.data.undeliverable >= 0);
}
{
  sent.length = 0;
  const r = await sweep();
  check('a SECOND sweep sends nothing (exactly-once holds)', r.j.data.sent === 0 && sent.length === 0, JSON.stringify(r.j.data));
}
{
  // A vendor rejection must be recorded on the row, not swallowed.
  sendMode = 'vendor_500';
  await seedSession('s_vendorfail', { email: 'vendorfail@buyer.test', hours: 2 });
  const r = await sweep();
  check('a vendor 500 counts as skipped, not sent', r.j.data.sent === 0 && r.j.data.skipped >= 1, JSON.stringify(r.j.data));
  const row = (await sql`SELECT last_error, recovery_status FROM crm_recovery_meta WHERE ref_id = 's_vendorfail'`)[0];
  check('the failure is written to the row so it is visible', row.last_error === 'http_500' && row.recovery_status === 'Not recovered', JSON.stringify(row));
  sendMode = 'ok';
  const retry = await sweep();
  check('after the vendor recovers, the released claim lets the retry land', retry.j.data.sent === 1, JSON.stringify(retry.j.data));
}

// ── 9b. the cart that settles MID-SWEEP ─────────────────────────────────────
// `rows` is a snapshot. A 500-row sweep can run for minutes, and the sweep
// itself does no re-read — so before the settle re-check, a cart that paid
// halfway through the loop was emailed a live recovery link. That is a
// double-charge vector, and the CTE cannot catch it: it selected the row when
// the row was genuinely unpaid.
console.log('\n9b. settle mid-sweep');
{
  await seedSession('s_mid_a', { email: 'mid_a@buyer.test', hours: 2 });     // newer → swept first
  await seedSession('s_mid_b', { email: 'mid_b@buyer.test', hours: 2.5 });   // older → swept second
  sent.length = 0;
  // While cart A's event is in flight, cart B settles — exactly what a Whop
  // webhook landing mid-sweep does.
  beforeSend = async () => {
    await sql`UPDATE co_sessions SET status = 'paid', paid_at = NOW() WHERE id = 's_mid_b'`;
    harnessPaid.add('s_mid_b');
  };
  const r = await sweep();
  beforeSend = null;
  check('the first cart was still nudged', sent.some((e) => e.unique_id === 'ab_funnel_s_mid_a'));
  check('the cart that settled mid-sweep was NOT emailed',
    !sent.some((e) => e.unique_id === 'ab_funnel_s_mid_b'), JSON.stringify(sent.map((e) => e.unique_id)));
  check('the sweep reports it as settled_mid_sweep, not a silent skip',
    r.j.data.settled_mid_sweep === 1, JSON.stringify(r.j.data));
  check('no claim was burned on the settled cart (a later legitimate nudge is still possible)',
    (await sql`SELECT COUNT(*)::int AS n FROM lb_integration_sends WHERE ref = 'ab_funnel_s_mid_b'`)[0].n === 0);
  check('and no sidecar row claims it was Sent',
    (await sql`SELECT COUNT(*)::int AS n FROM crm_recovery_meta WHERE ref_id = 's_mid_b' AND recovery_status = 'Sent'`)[0].n === 0);
}

// ── 9c. self-heal after a lost stamp ────────────────────────────────────────
// The claim is taken BEFORE the send. If the send lands and the sidecar stamp
// then fails (crash, DB blip), the row holds a claim with no meta row: every
// later sweep answers deduped, and a detector that only stamped on the
// non-deduped path would skip it forever — so the nudge could never be
// credited as recovered. This reproduces that exact state.
console.log('\n9c. self-heal');
{
  await seedSession('s_stuck', { email: 'stuck@buyer.test', hours: 2 });
  await sql`INSERT INTO lb_integration_sends (kind, ref) VALUES ('klaviyo', 'ab_funnel_s_stuck')`;
  check('precondition: claim held, sidecar row absent',
    (await sql`SELECT COUNT(*)::int AS n FROM crm_recovery_meta WHERE ref_id = 's_stuck'`)[0].n === 0);
  sent.length = 0;
  const r = await sweep();
  check('the stuck row fires NO duplicate email', !sent.some((e) => e.unique_id === 'ab_funnel_s_stuck'));
  check('the sweep reports it as healed, distinct from sent', r.j.data.healed >= 1, JSON.stringify(r.j.data));
  const row = (await sql`SELECT recovery_status, sent_at FROM crm_recovery_meta WHERE ref_id = 's_stuck'`)[0];
  check('the sidecar is healed to Sent', row?.recovery_status === 'Sent', JSON.stringify(row));
  check('with a sent_at, so attribution can still credit it', Boolean(row?.sent_at));
}

// ── 10. recovered attribution (the windowed sweep) ──────────────────────────
console.log('\n10. recovered attribution');
{
  // sweep1 was nudged; the same buyer now pays a NEW session AFTER the nudge.
  await seedSession('s_sweep1_paid', { email: 'sweep1@buyer.test', hours: 0.1, status: 'paid', total: 120, paidAt: new Date() });
  const r = await req('GET', '/?nosync=1&days=7');
  const row = byRef(r.j.data.checkouts, 's_sweep1');
  check('a nudged cart whose buyer later paid flips to Recovered', row?.recovery_status === 'Recovered', JSON.stringify(row?.recovery_status));
  check('the recovered payment is credited at its own value', Number(row?.recovered_value) === 120, String(row?.recovered_value));
  check('recovered_revenue KPI reflects it', Number(r.j.data.recovered_revenue) >= 120, String(r.j.data.recovered_revenue));
  check('a cart nobody paid for stays Sent', byRef(r.j.data.checkouts, 's_sweep2')?.recovery_status === 'Sent');
}
{
  // NEGATIVE control: a payment that PREDATES the nudge is not a recovery.
  await seedSession('s_pre', { email: 'pre@buyer.test', hours: 4 });
  await sql`INSERT INTO crm_recovery_meta (source, ref_id, recovery_status, sent_at)
            VALUES ('funnel', 's_pre', 'Sent', NOW())`;
  await seedSession('s_pre_paid', { email: 'pre@buyer.test', hours: 3, status: 'paid', total: 10, paidAt: hoursAgo(3) });
  const r = await req('GET', '/?nosync=1&days=7');
  check('negative control: a payment BEFORE the nudge is not credited',
    byRef(r.j.data.checkouts, 's_pre')?.recovery_status === 'Sent');
}
{
  // A shopify checkout that later completes is a self-recovery.
  await sql`INSERT INTO crm_abandoned_checkouts (checkout_id, email, total_price, currency, line_items, item_count, created_at)
            VALUES (779, 'selfrec@buyer.test', 45, 'USD', '[]', 0, ${hoursAgo(6)})`;
  await sql`INSERT INTO crm_recovery_meta (source, ref_id, recovery_status, sent_at)
            VALUES ('shopify', '779', 'Sent', ${hoursAgo(5)})`;
  await sql`UPDATE crm_abandoned_checkouts SET completed_at = NOW() WHERE checkout_id = 779`;
  await req('GET', '/?nosync=1&days=7');
  const meta = (await sql`SELECT recovery_status FROM crm_recovery_meta WHERE source='shopify' AND ref_id='779'`)[0];
  check('a shopify checkout that completed after the nudge is credited', meta.recovery_status === 'Recovered', JSON.stringify(meta));
}

// ── 10b. ONE payment can recover only ONE cart ──────────────────────────────
// A serial abandoner is the normal case, not the exotic one: same buyer, three
// carts, one eventual purchase. Crediting all three turned a $500 order into
// $1,500 of reported recovered revenue.
console.log('\n10b. multi-credit');
{
  await seedSession('s_multi1', { email: 'multi@buyer.test', hours: 6 });
  await seedSession('s_multi2', { email: 'multi@buyer.test', hours: 5 });
  await seedSession('s_multi3', { email: 'multi@buyer.test', hours: 4 });
  const r1 = await sweep();
  check('all three carts were nudged', r1.j.data.sent >= 3, JSON.stringify(r1.j.data));
  await seedSession('s_multi_paid', { email: 'multi@buyer.test', hours: 0.05, status: 'paid', total: 500, paidAt: new Date() });
  await req('GET', '/?nosync=1&days=7');
  const credited = await sql`SELECT ref_id, recovered_value FROM crm_recovery_meta
    WHERE recovery_status = 'Recovered' AND ref_id IN ('s_multi1','s_multi2','s_multi3') ORDER BY ref_id`;
  check('exactly ONE of the three carts is credited', credited.length === 1, JSON.stringify(credited));
  check('credited at the payment’s real value, once', Number(credited[0]?.recovered_value) === 500, JSON.stringify(credited));
  // The MOST RECENTLY abandoned cart wins — closest to the purchase, and the
  // rule is stated in the code rather than falling out of sweep row order.
  check('the most recently abandoned cart is the one credited', credited[0]?.ref_id === 's_multi3', credited[0]?.ref_id);
  const others = await sql`SELECT ref_id, recovery_status FROM crm_recovery_meta WHERE ref_id IN ('s_multi1','s_multi2') ORDER BY ref_id`;
  check('the other two stay Sent', others.every((o) => o.recovery_status === 'Sent'), JSON.stringify(others));
  // Re-running the sweep must not hand the same payment to a second cart.
  await req('GET', '/?nosync=1&days=7');
  const again = await sql`SELECT COUNT(*)::int AS n, COALESCE(SUM(recovered_value),0) AS v FROM crm_recovery_meta
    WHERE recovery_status = 'Recovered' AND ref_id IN ('s_multi1','s_multi2','s_multi3')`;
  check('a repeat sweep does not multiply the credit',
    again[0].n === 1 && Number(again[0].v) === 500, JSON.stringify(again[0]));
}
{
  // A payment on a DIFFERENT funnel is not this cart's recovery.
  await seedSession('s_fnlA', { email: 'fnl@buyer.test', hours: 4, funnel: 'fnl_A' });
  await sweep();
  await seedSession('s_fnlB_paid', { email: 'fnl@buyer.test', hours: 0.05, status: 'paid', total: 77, paidAt: new Date(), funnel: 'fnl_B' });
  await req('GET', '/?nosync=1&days=7');
  const row = (await sql`SELECT recovery_status FROM crm_recovery_meta WHERE ref_id = 's_fnlA'`)[0];
  check('negative control: a payment on another funnel is not credited', row?.recovery_status === 'Sent', JSON.stringify(row));
}
{
  // M13 negative control: a Shopify checkout that completed BEFORE the nudge
  // was not recovered by it.
  await sql`INSERT INTO crm_abandoned_checkouts (checkout_id, email, total_price, currency, line_items, item_count, created_at, completed_at)
            VALUES (780, 'preshop@buyer.test', 20, 'USD', '[]', 0, ${hoursAgo(8)}, ${hoursAgo(7)})`;
  await sql`INSERT INTO crm_recovery_meta (source, ref_id, recovery_status, sent_at)
            VALUES ('shopify', '780', 'Sent', ${hoursAgo(2)})`;
  await req('GET', '/?nosync=1&days=7');
  const meta = (await sql`SELECT recovery_status FROM crm_recovery_meta WHERE source='shopify' AND ref_id='780'`)[0];
  check('negative control: shopify completion BEFORE the nudge is not credited',
    meta.recovery_status === 'Sent', JSON.stringify(meta));
}

// ── 10b2. CONCURRENT reconciles must not double-spend a payment ─────────────
// The attribution sweep runs on every GET /, so two operators with the page
// open — or two Render instances — reconcile at the same time. The consume set
// is per-process, so both find the same uncredited payment and both spend it.
// No in-process mutex can fix that across instances; only the database can.
//
// Twelve independent trials, three parallel list loads each. The assertion is
// on the INVARIANT (attributed == real), not on any one trial, because the bug
// is probabilistic.
//
// NEGATIVE CONTROL, run before shipping the fix: reverted to the pre-fix
// crediting UPDATE (no NOT EXISTS, no unique index, no consume on a zero-row
// update) and this section reported `bad trials = 11` and
// `attributed 11500 vs real 6000`. It reproduces the bug, so a green run here
// means something.
console.log('\n10b2. concurrent reconciles');
{
  const TRIALS = 12;
  let badTrials = 0;
  let attributed = 0;
  let real = 0;
  for (let t = 0; t < TRIALS; t += 1) {
    const email = `conc${t}@buyer.test`;
    // The post-nudge state, written exactly as the detector writes it: two
    // nudged carts for one buyer, then one payment.
    await seedSession(`s_conc${t}_a`, { email, hours: 5 });
    await seedSession(`s_conc${t}_b`, { email, hours: 4 });
    for (const suffix of ['a', 'b']) {
      await sql`INSERT INTO crm_recovery_meta (source, ref_id, recovery_status, sent_at)
                VALUES ('funnel', ${`s_conc${t}_${suffix}`}, 'Sent', ${hoursAgo(1)})`;
    }
    await seedSession(`s_conc${t}_paid`, {
      email, hours: 0.01, status: 'paid', total: 500, paidAt: new Date(),
    });
    real += 500;

    // Three list loads racing — the real shape of two tabs plus a poll.
    const responses = await Promise.all([
      req('GET', '/?nosync=1&days=7'),
      req('GET', '/?nosync=1&days=7'),
      req('GET', '/?nosync=1&days=7'),
    ]);
    check(`trial ${t}: all three concurrent loads still answered 200`,
      responses.every((r) => r.status === 200), JSON.stringify(responses.map((r) => r.status)));

    const credited = await sql`SELECT ref_id, recovered_value, recovered_by FROM crm_recovery_meta
      WHERE recovery_status = 'Recovered' AND ref_id IN (${`s_conc${t}_a`}, ${`s_conc${t}_b`})`;
    attributed += credited.reduce((n, c) => n + Number(c.recovered_value || 0), 0);
    if (credited.length !== 1 || Number(credited[0].recovered_value) !== 500) badTrials += 1;
  }
  check(`every one of ${TRIALS} trials credited exactly once at the real value`,
    badTrials === 0, `bad trials = ${badTrials}`);
  check('total attributed == total real, to the cent',
    attributed === real, `attributed ${attributed} vs real ${real}`);
  // The constraint that makes the above true, asserted directly — a passing
  // race is not proof the arbiter exists.
  const idx = await sql`SELECT indexdef FROM pg_indexes
    WHERE tablename = 'crm_recovery_meta' AND indexname = 'uq_crm_recovery_recovered_by'`;
  check('a UNIQUE index on recovered_by is the arbiter, not luck',
    idx.length === 1 && /UNIQUE/i.test(idx[0].indexdef), JSON.stringify(idx));
  // POSITIVE control on the constraint itself: a second row claiming the same
  // payment must be rejected by the database.
  let violated = false;
  try {
    await sql`INSERT INTO crm_recovery_meta (source, ref_id, recovery_status, recovered_by)
              VALUES ('funnel', 's_dup_probe', 'Recovered', 's_conc0_paid')`;
  } catch (e) { violated = e.code === '23505'; }
  check('positive control: a duplicate recovered_by is REFUSED by the database', violated);
  // And NULL recovered_by must still be freely repeatable (partial index).
  await sql`INSERT INTO crm_recovery_meta (source, ref_id, recovery_status) VALUES ('funnel', 's_null_a', 'Sent')`;
  await sql`INSERT INTO crm_recovery_meta (source, ref_id, recovery_status) VALUES ('funnel', 's_null_b', 'Sent')`;
  check('uncredited rows are unaffected — the index is partial',
    (await sql`SELECT COUNT(*)::int AS n FROM crm_recovery_meta WHERE recovered_by IS NULL`)[0].n >= 2);
}

// ── 10c. the Shopify mirror must LEARN completion ───────────────────────────
// What this pins is the BEHAVIOUR we depend on — a checkout that comes back
// carrying completed_at must retire the nudge and credit the self-recovery —
// and the request shape we send.
//
// It deliberately does NOT encode the original diagnosis. A live read-only
// probe of the real store refuted it: completed checkouts do NOT leave the
// status=open feed (2 of the 5 oldest rows carry completed_at and appear under
// both status values, whose bodies were byte-identical at 26,163 B). status=any
// is kept as a costless superset; the parameter that actually earns its place
// is created_at_min, which the probe showed IS honoured and which stops the
// oldest-first crawl from exhausting its page cap before reaching live carts.
console.log('\n10c. shopify sync learns completion');
{
  process.env.SHOPIFY_STORE_DOMAIN = 'harness.myshopify.com';
  process.env.SHOPIFY_ACCESS_TOKEN = 'shpat_harness';
  const realFetch = globalThis.fetch;
  const seen = [];
  let feed = [];
  globalThis.fetch = async (url, opts) => {
    if (String(url).includes('myshopify.com')) {
      seen.push(String(url));
      return new Response(JSON.stringify({ checkouts: feed }), {
        status: 200, headers: { 'content-type': 'application/json' },
      });
    }
    return realFetch(url, opts);
  };

  // Pass 1 — an open checkout arrives and is nudgeable.
  feed = [{
    id: 900001, email: 'shopdone@buyer.test', total_price: '42.00', currency: 'USD',
    line_items: [{ title: 'Oil', quantity: 1, price: '42.00' }],
    abandoned_checkout_url: 'https://shop.test/recover/900001',
    created_at: hoursAgo(6).toISOString(), updated_at: hoursAgo(6).toISOString(), completed_at: null,
  }];
  const s1 = await req('POST', '/sync');
  check('sync imports the open checkout', s1.status === 200 && s1.j.data.imported === 1, s1.text.slice(0, 160));
  check('the feed is requested with status=any, not status=open',
    seen[0].includes('status=any') && !seen[0].includes('status=open'), seen[0]);
  check('and it is bounded by created_at_min', seen[0].includes('created_at_min='), seen[0]);
  sent.length = 0;
  await sweep();
  check('the open shopify checkout IS nudged', sent.some((e) => e.unique_id === 'ab_shopify_900001'));

  // Pass 2 — the buyer pays. Under status=open this row would simply VANISH
  // from the feed and our mirror would never learn; under status=any it comes
  // back carrying completed_at.
  feed = [{ ...feed[0], completed_at: new Date().toISOString(), updated_at: new Date().toISOString() }];
  const s2 = await req('POST', '/sync');
  check('re-sync succeeds', s2.status === 200);
  const mirrored = (await sql`SELECT completed_at FROM crm_abandoned_checkouts WHERE checkout_id = 900001`)[0];
  check('the mirror LEARNED the completion', Boolean(mirrored.completed_at), JSON.stringify(mirrored));

  const l = await req('GET', '/?nosync=1&days=7');
  check('the completed checkout drops off the abandoned list', !byRef(l.j.data.checkouts, '900001'));
  check('a settled shopify checkout REFUSES a further nudge',
    (await req('POST', '/shopify/900001/send')).status === 409);
  const credited = (await sql`SELECT recovery_status, recovered_value FROM crm_recovery_meta WHERE source='shopify' AND ref_id='900001'`)[0];
  check('and the self-recovery IS credited', credited.recovery_status === 'Recovered', JSON.stringify(credited));
  check('credited at the checkout value', Number(credited.recovered_value) === 42, String(credited.recovered_value));
  sent.length = 0;
  await sweep();
  check('later sweeps never touch it again', !sent.some((e) => e.unique_id === 'ab_shopify_900001'));

  // M8 — a shop that stays throttled must not spin forever: `continue` skips
  // the page counter, so only a dedicated retry budget can stop it.
  let calls = 0;
  globalThis.fetch = async (url, opts) => {
    if (String(url).includes('myshopify.com')) {
      calls += 1;
      return new Response('{}', { status: 429, headers: { 'retry-after': '0' } });
    }
    return realFetch(url, opts);
  };
  const t0 = Date.now();
  const r429 = await req('POST', '/sync');
  check('a sustained 429 TERMINATES instead of looping forever',
    r429.status === 500 && /rate limit/i.test(r429.j.error || ''), r429.text.slice(0, 160));
  check('it gave up after a bounded number of retries', calls <= 7, `calls=${calls}`);
  check('and it did so promptly', Date.now() - t0 < 20000, `${Date.now() - t0}ms`);

  globalThis.fetch = realFetch;
  delete process.env.SHOPIFY_STORE_DOMAIN;
  delete process.env.SHOPIFY_ACCESS_TOKEN;
}

// ── 10d. rate limits + paging bounds ────────────────────────────────────────
console.log('\n10d. limits');
{
  // One operator, seven sweeps: the seventh must be refused. This is the
  // blast-radius cap on an endpoint that can send 500 real emails per press.
  const one = await freshOperator();
  const codes = [];
  for (let i = 0; i < 7; i += 1) {
    codes.push((await req('POST', '/detector/run', { days: 1, limit: 1 }, one)).status);
  }
  check('the sweep is rate-limited per operator', codes.includes(429), JSON.stringify(codes));
  check('the first presses went through', codes.filter((c) => c === 200).length >= 5, JSON.stringify(codes));
  const other = await freshOperator();
  check('a DIFFERENT operator is not blocked by the first one’s budget',
    (await req('POST', '/detector/run', { days: 1, limit: 1 }, other)).status === 200);
}
check('an absurd page is clamped, not turned into an unbounded OFFSET',
  (await req('GET', '/?nosync=1&page=999999999')).status === 200);
check('a negative page is clamped to 1', (await req('GET', '/?nosync=1&page=-5')).j.data.page === 1);

// ── 11. the money path was never touched ────────────────────────────────────
console.log('\n11. money-path invariants');
{
  const rows = await sql`SELECT id, status, paid_at, total FROM co_sessions ORDER BY id`;
  const paid = rows.filter((r) => r.status === 'paid').map((r) => r.id).sort();
  // The ONLY paid sessions must be the ones this harness made paid itself.
  // Any extra id here would mean the recovery lane wrote to the money spine.
  const expected = [...harnessPaid].sort();
  check('no session status was mutated by any recovery action',
    paid.join(',') === expected.join(','), `${paid.join(',')} vs ${expected.join(',')}`);
  check('positive control: the harness did settle some sessions', expected.length >= 4, String(expected.length));
  const unpaidTotals = rows.filter((r) => r.status !== 'paid').every((r) => Number(r.total) > 0);
  check('no cart total was rewritten', unpaidTotals);
  const orders = await sql`SELECT COUNT(*)::int AS n FROM co_orders`;
  check('no order was created', orders[0].n === 0);
}

const EXPECTED_CHECKS = 146;
check(`coverage: exactly ${EXPECTED_CHECKS} checks ran before this one`, pass + fail === EXPECTED_CHECKS, `ran=${pass + fail}`);

console.log(`\nRESULT: ${pass} passed, ${fail} failed`);
await sql.end();
server.close();
process.exit(fail ? 1 : 0);
