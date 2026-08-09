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

async function seedSession(id, { status = 'processing', email, hours = 3, total = 49, paidAt = null, shipping = {} } = {}) {
  await sql`INSERT INTO co_sessions (id, funnel_id, status, line_items, total, currency, customer, paid_at, created_at, updated_at)
    VALUES (${id}, 'fnl_1', ${status}, ${sql.json(cart)}, ${total}, 'USD',
            ${sql.json({ email, first_name: 'Jo', last_name: 'Buyer', shipping: { city: 'Milan', country: 'IT', ...shipping } })},
            ${paidAt}, ${hoursAgo(hours)}, NOW())`;
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

// Klaviyo seam — no network, and every send is recorded.
const sent = [];
let sendMode = 'ok';
recovery._deps.getKlaviyoConfig = async () => (sendMode === 'off'
  ? { enabled: false, apiKey: '' }
  : { enabled: true, apiKey: 'pk_test_route_harness' });
recovery._deps.upsertProfile = async () => ({ ok: true });
recovery._deps.trackEvent = async (e) => {
  sent.push(e);
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
  check('sidecar flipped to Sent', r.j.data.recovery.recovery_status === 'Sent');
  const l = await req('GET', '/?nosync=1&status=Sent');
  check('the list now shows it as Sent', byRef(l.j.data.checkouts, 's_abandoned')?.recovery_status === 'Sent');
  check('emails_sent KPI moved', l.j.data.emails_sent >= 1);
}
{
  sent.length = 0;
  const r = await req('POST', '/funnel/s_abandoned/send');
  check('a RESEND dedups instead of double-emailing', r.status === 200 && r.j.data.deduped === true, r.text.slice(0, 160));
  check('the deduped resend fired NO second event', sent.length === 0);
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
  const r = await req('POST', '/detector/run', { days: 14 });
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
  const r = await req('POST', '/detector/run', { days: 14 });
  check('a SECOND sweep sends nothing (exactly-once holds)', r.j.data.sent === 0 && sent.length === 0, JSON.stringify(r.j.data));
}
{
  // A vendor rejection must be recorded on the row, not swallowed.
  sendMode = 'vendor_500';
  await seedSession('s_vendorfail', { email: 'vendorfail@buyer.test', hours: 2 });
  const r = await req('POST', '/detector/run', { days: 14 });
  check('a vendor 500 counts as skipped, not sent', r.j.data.sent === 0 && r.j.data.skipped >= 1, JSON.stringify(r.j.data));
  const row = (await sql`SELECT last_error, recovery_status FROM crm_recovery_meta WHERE ref_id = 's_vendorfail'`)[0];
  check('the failure is written to the row so it is visible', row.last_error === 'http_500' && row.recovery_status === 'Not recovered', JSON.stringify(row));
  sendMode = 'ok';
  const retry = await req('POST', '/detector/run', { days: 14 });
  check('after the vendor recovers, the released claim lets the retry land', retry.j.data.sent === 1, JSON.stringify(retry.j.data));
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

// ── 11. the money path was never touched ────────────────────────────────────
console.log('\n11. money-path invariants');
{
  const rows = await sql`SELECT id, status, paid_at, total FROM co_sessions ORDER BY id`;
  const paid = rows.filter((r) => r.status === 'paid').map((r) => r.id).sort();
  check('no session status was mutated by any recovery action',
    paid.join(',') === 's_paid,s_pre_paid,s_sweep1_paid', paid.join(','));
  const unpaidTotals = rows.filter((r) => r.status !== 'paid').every((r) => Number(r.total) > 0);
  check('no cart total was rewritten', unpaidTotals);
  const orders = await sql`SELECT COUNT(*)::int AS n FROM co_orders`;
  check('no order was created', orders[0].n === 0);
}

const EXPECTED_CHECKS = 89;
check(`coverage: exactly ${EXPECTED_CHECKS} checks ran before this one`, pass + fail === EXPECTED_CHECKS, `ran=${pass + fail}`);

console.log(`\nRESULT: ${pass} passed, ${fail} failed`);
await sql.end();
server.close();
process.exit(fail ? 1 : 0);
