// Abandoned-recovery verification — drives the REAL
// server/src/services/abandonedRecovery.js in process. No DB, no network: every
// function under test is either pure or takes its collaborators through the
// exported `_deps` seam, so the outbound-nudge FAILURE PATHS (vendor 500, a
// throw between claim and send, dedup) are executed, not reasoned about.
//
// Covers: the abandonment definition (grace clamps, settled beats everything,
// missing clock fails safe), the signed recovery-link record (round-trip,
// tamper, expiry, wrong secret, ids containing dots), the jsonb dual shape,
// and malformed input on every entry point.
//
// Run:  node server/tests/abandoned/recovery.mjs
process.env.DATABASE_URL = process.env.DATABASE_URL || 'postgresql://localhost:5432/unused_by_this_harness';
// A real signing secret, because an unset one is now a REFUSAL (see §6b).
process.env.CHECKOUT_RESUME_SECRET = 'pure-harness-secret-zzzz';

const M = await import('../../src/services/abandonedRecovery.js');
const {
  abandonGraceSeconds, recoveryWindowDays, recoveryLinkTtlSeconds, publicBaseUrl,
  parseJsonColumn, sanitizeEmail, cartSummary, cartTotal, classifyCheckout,
  signRecoveryToken, verifyRecoveryToken, recoveryLinkUrl, hasRecoverySecret,
  buildRecoveryRecord, buildEventProperties, sendRecoveryEvent,
  RECOVERY_STATUSES, RecoverySecretError, SETTLED_STATUSES, SOURCES, ABANDONED_METRIC, _deps,
} = M;

let pass = 0;
let fail = 0;
function check(name, ok, detail = '') {
  if (ok) { pass += 1; console.log(`  ok   ${name}`); }
  else { fail += 1; console.log(`  FAIL ${name}${detail ? ` — ${detail}` : ''}`); }
}
function throws(name, fn, needle = '') {
  try { fn(); check(name, false, 'did not throw'); }
  catch (e) { check(name, !needle || e.message.includes(needle), e.message); }
}

const SECRET_ENV = { CHECKOUT_RESUME_SECRET: 'harness-secret-aaaa' };
const OTHER_ENV = { CHECKOUT_RESUME_SECRET: 'harness-secret-bbbb' };

// ── 1. config clamps ────────────────────────────────────────────────────────
console.log('\n1. config');
check('grace default = 60 min', abandonGraceSeconds({}) === 3600);
check('grace honours ABANDON_MINUTES', abandonGraceSeconds({ ABANDON_MINUTES: '30' }) === 1800);
check('grace honours the funnel-os spelling', abandonGraceSeconds({ LB_ABANDON_MINUTES: '90' }) === 5400);
check('grace clamps a 1-minute typo up to 5', abandonGraceSeconds({ ABANDON_MINUTES: '1' }) === 300);
check('grace clamps a 99999 typo down to 1440', abandonGraceSeconds({ ABANDON_MINUTES: '99999' }) === 86400);
check('grace survives garbage → default', abandonGraceSeconds({ ABANDON_MINUTES: 'soon' }) === 3600);
check('grace survives null → default', abandonGraceSeconds({ ABANDON_MINUTES: null }) === 3600);
check('window default 7d', recoveryWindowDays({}) === 7);
check('window clamps to [1,90]', recoveryWindowDays({ RECOVERY_WINDOW_DAYS: '0' }) === 1
  && recoveryWindowDays({ RECOVERY_WINDOW_DAYS: '400' }) === 90);
check('link TTL default 14d', recoveryLinkTtlSeconds({}) === 14 * 86400);
check('link TTL clamps to [1,60] days', recoveryLinkTtlSeconds({ RECOVERY_LINK_TTL_DAYS: '999' }) === 60 * 86400);
check('publicBaseUrl strips trailing slashes', publicBaseUrl({ APP_BASE_URL: 'https://x.test///' }) === 'https://x.test');
check('publicBaseUrl empty when unset', publicBaseUrl({}) === '');
check('status + source vocabularies are frozen lists',
  RECOVERY_STATUSES.join('|') === 'Not recovered|Sent|Recovered' && SOURCES.join('|') === 'funnel|shopify');

// ── 2. jsonb dual shape ─────────────────────────────────────────────────────
console.log('\n2. parseJsonColumn — both shapes, malformed input');
check('object passes through', parseJsonColumn({ a: 1 }).a === 1);
check('array passes through', Array.isArray(parseJsonColumn([1, 2])));
check('json string is parsed', parseJsonColumn('[{"title":"X"}]')[0].title === 'X');
check('malformed string → fallback, no throw', parseJsonColumn('{not json', 'FB') === 'FB');
check('null → fallback', parseJsonColumn(null, 'FB') === 'FB');
check('undefined → fallback', parseJsonColumn(undefined, 'FB') === 'FB');
check('number → fallback (not a jsonb payload)', parseJsonColumn(42, 'FB') === 'FB');
check('literal "null" string → fallback', parseJsonColumn('null', 'FB') === 'FB');

// ── 3. email sanitation ─────────────────────────────────────────────────────
console.log('\n3. sanitizeEmail');
check('plain address', sanitizeEmail('Buyer@Example.COM') === 'buyer@example.com');
check('typed spaces are salvaged', sanitizeEmail(' gary @gmail.com ') === 'gary@gmail.com');
check('no @ → unreachable', sanitizeEmail('garygmail.com') === '');
check('two @ → unreachable', sanitizeEmail('a@b@c.com') === '');
check('no dot in domain → unreachable', sanitizeEmail('a@localhost') === '');
check('trailing dot domain → unreachable', sanitizeEmail('a@b.com.') === '');
check('empty local part → unreachable', sanitizeEmail('@b.com') === '');
check('non-string → unreachable', sanitizeEmail(null) === '' && sanitizeEmail(undefined) === '' && sanitizeEmail(12) === '');
check('over 254 chars → unreachable', sanitizeEmail(`${'a'.repeat(250)}@b.com`) === '');
check('unicode/quotes rejected', sanitizeEmail('"weird"@b.com') === '' && sanitizeEmail('gary😀@b.com') === '');

// ── 4. cart shaping ─────────────────────────────────────────────────────────
console.log('\n4. cartSummary');
{
  const c = cartSummary([
    { title: 'Breast Lift Tape', quantity: 2, price: 24.5, variant_id: 111 },
    { title: 'Activator Oil', quantity: 1, price: '19.99' },
  ]);
  check('item_count sums quantities', c.item_count === 3, JSON.stringify(c));
  check('distinct_items counts lines', c.distinct_items === 2);
  check('subtotal is money-rounded', c.subtotal === 68.99, String(c.subtotal));
  check('line_total per row', c.items[0].line_total === 49);
  check('variant_id is stringified', c.items[0].variant_id === '111');
  check('nothing truncated', c.truncated === false);
}
check('string jsonb shape parses', cartSummary('[{"title":"A","quantity":1,"price":5}]').item_count === 1);
check('malformed json → empty cart, no throw', cartSummary('[[[').item_count === 0);
check('null → empty cart', cartSummary(null).distinct_items === 0);
check('non-array object → empty cart', cartSummary({ nope: true }).distinct_items === 0);
check('junk entries are skipped', cartSummary([null, 'x', 7, { title: 'ok', quantity: 1 }]).distinct_items === 1);
check('missing price/quantity default to 0', cartSummary([{ title: 'ok' }]).items[0].line_total === 0);
check('negative quantity floors at 0', cartSummary([{ title: 'x', quantity: -5, price: 10 }]).item_count === 0);
check('NaN price → 0', cartSummary([{ title: 'x', quantity: 1, price: 'abc' }]).items[0].price === 0);
{
  const big = cartSummary(Array.from({ length: 60 }, () => ({ title: 't', quantity: 1, price: 1 })));
  check('caps at 50 lines and flags truncated', big.distinct_items === 50 && big.truncated === true);
}

// ── 5. the abandonment definition ───────────────────────────────────────────
console.log('\n5. classifyCheckout');
const NOW = new Date('2026-08-09T12:00:00Z');
const GRACE = 3600;
const cl = (row, opts = {}) => classifyCheckout(row, { now: NOW, graceSeconds: GRACE, ...opts });
const OLD = '2026-08-09T09:00:00Z';   // 3h old — past a 1h grace
const FRESH = '2026-08-09T11:45:00Z'; // 15m old — inside the grace

check('past grace + email → abandoned + nudgeable',
  (() => { const v = cl({ created_at: OLD, email: 'a@b.com' }); return v.state === 'abandoned' && v.nudgeable === true && v.reason === 'past_grace'; })());
check('inside grace → active, never nudgeable',
  (() => { const v = cl({ created_at: FRESH, email: 'a@b.com' }); return v.state === 'active' && v.nudgeable === false; })());
check('status paid beats everything', cl({ created_at: OLD, email: 'a@b.com', status: 'paid' }).state === 'paid');
check('paid_at beats everything', cl({ created_at: OLD, email: 'a@b.com', paid_at: OLD }).state === 'paid');
check('shopify completed_at beats everything', cl({ created_at: OLD, email: 'a@b.com', completed_at: OLD }).state === 'paid');
// (The old "gateway payment id beats everything" case was DELETED, not fixed:
//  co_sessions has no such column — gateway_payment_id lives on
//  co_upsell_charges — so the assertion only ever passed against a fixture
//  that invented the field. What settled evidence actually is, and what it
//  deliberately is not, is pinned in §5b against production row shapes.)
check('settled is NEVER nudgeable', cl({ created_at: OLD, email: 'a@b.com', status: 'paid' }).nudgeable === false);
check('settled wins even over a Recovered sidecar',
  cl({ created_at: OLD, email: 'a@b.com', status: 'paid' }, { recoveryStatus: 'Recovered' }).state === 'paid');
check('Recovered sidecar → recovered, not nudgeable',
  (() => { const v = cl({ created_at: OLD, email: 'a@b.com' }, { recoveryStatus: 'Recovered' }); return v.state === 'recovered' && v.nudgeable === false; })());
check('already Sent → still abandoned but not nudgeable again',
  (() => { const v = cl({ created_at: OLD, email: 'a@b.com' }, { recoveryStatus: 'Sent' }); return v.state === 'abandoned' && v.nudgeable === false && v.reason === 'already_nudged'; })());
check('unsalvageable email → unreachable', cl({ created_at: OLD, email: 'nope' }).state === 'unreachable');
check('missing email → unreachable', cl({ created_at: OLD }).state === 'unreachable');
check('customer_email is read too', cl({ created_at: OLD, customer_email: 'a@b.com' }).nudgeable === true);
check('missing created_at FAILS SAFE to active (never nudge an unclocked cart)',
  (() => { const v = cl({ email: 'a@b.com' }); return v.state === 'active' && v.nudgeable === false && v.reason === 'no_created_at'; })());
check('garbage created_at fails safe too', cl({ created_at: 'not-a-date', email: 'a@b.com' }).nudgeable === false);
check('null row does not throw', cl(null).state === 'active');
check('undefined row does not throw', cl(undefined).nudgeable === false);
check('bogus recoveryStatus is ignored, not trusted',
  cl({ created_at: OLD, email: 'a@b.com' }, { recoveryStatus: 'Whatever' }).nudgeable === true);
check('grace boundary is exclusive-below (exactly at grace = abandoned)',
  cl({ created_at: new Date(NOW.getTime() - GRACE * 1000).toISOString(), email: 'a@b.com' }).state === 'abandoned');
check('one second inside the grace is still active',
  cl({ created_at: new Date(NOW.getTime() - (GRACE - 1) * 1000).toISOString(), email: 'a@b.com' }).state === 'active');
check('missing graceSeconds falls back to the env default (no throw)',
  classifyCheckout({ created_at: OLD, email: 'a@b.com' }, { now: NOW }).state === 'abandoned');

// ── 5b. settled evidence — the PRODUCTION row shape ─────────────────────────
// The two bugs this section exists to pin: a fixture invented a
// `gateway_payment_id` that no co_sessions row has, and `gateway_session_id` —
// which every gateway-reached cart DOES have — is intent, not payment.
console.log('\n5b. settled evidence (production-shaped co_sessions rows)');
check('SETTLED_STATUSES is the whole vocabulary', SETTLED_STATUSES.join('|') === 'paid|deposit_paid|refunded');
check('a REFUNDED cart is settled (it was paid), never abandoned',
  cl({ created_at: OLD, email: 'a@b.com', status: 'refunded' }).state === 'paid');
check('deposit_paid is settled', cl({ created_at: OLD, email: 'a@b.com', status: 'deposit_paid' }).state === 'paid');
{
  // Exactly the row checkoutPublic.js leaves behind after minting a Whop
  // session: status still 'processing', paid_at NULL, gateway + session id set.
  const reachedGateway = {
    created_at: OLD, email: 'a@b.com', status: 'processing', paid_at: null,
    gateway: 'whop', gateway_session_id: 'ch_live_abc123', gateway_plan_id: 'plan_1',
  };
  const v = cl(reachedGateway);
  check('a cart that reached the gateway is STILL abandoned (session id is INTENT, not payment)',
    v.state === 'abandoned' && v.nudgeable === true, JSON.stringify(v));
}
check('a co_sessions row carries no gateway_payment_id — an undefined field cannot settle anything',
  cl({ created_at: OLD, email: 'a@b.com', gateway_payment_id: undefined }).nudgeable === true);
check('shopify completed_at still settles', cl({ created_at: OLD, email: 'a@b.com', completed_at: OLD }).state === 'paid');

// ── 5c. cartTotal — the column every real caller actually emits ─────────────
console.log('\n5c. cartTotal (route/CTE column naming)');
check('reads total_price, the name the CTE and loadOne emit', cartTotal({ total_price: 88.5 }) === 88.5);
check('still reads a bare total (co_sessions native column)', cartTotal({ total: 12 }) === 12);
check('total_price wins when both are present', cartTotal({ total_price: 5, total: 99 }) === 5);
check('a numeric STRING from pg NUMERIC parses', cartTotal({ total_price: '61.00' }) === 61);
check('missing → 0, not NaN', cartTotal({}) === 0 && cartTotal(null) === 0);
check('garbage → 0, not NaN', cartTotal({ total_price: 'abc' }) === 0);

// ── 6. signed recovery links ────────────────────────────────────────────────
console.log('\n6. signRecoveryToken / verifyRecoveryToken');
{
  const t = signRecoveryToken('funnel', 'sess_abc', { env: SECRET_ENV, now: NOW });
  check('token has three v1 parts', t.token.split('.').length === 3 && t.token.startsWith('v1.'));
  const v = verifyRecoveryToken(t.token, { env: SECRET_ENV, now: NOW });
  check('round-trips source + ref', v && v.source === 'funnel' && v.ref === 'sess_abc', JSON.stringify(v));
  check('expiry is reported and honours the TTL',
    new Date(t.expires_at).getTime() === NOW.getTime() + 14 * 86400000, t.expires_at);

  // POSITIVE control that the assertions below are not vacuous.
  check('positive control: an untampered token verifies', verifyRecoveryToken(t.token, { env: SECRET_ENV, now: NOW }) !== null);

  const [, payload, sig] = t.token.split('.');
  check('tampered payload → null', verifyRecoveryToken(`v1.${payload}X.${sig}`, { env: SECRET_ENV, now: NOW }) === null);
  check('tampered signature → null', verifyRecoveryToken(`v1.${payload}.${sig.slice(0, -1)}Z`, { env: SECRET_ENV, now: NOW }) === null);
  check('truncated signature → null (length mismatch, no timingSafeEqual throw)',
    verifyRecoveryToken(`v1.${payload}.${sig.slice(0, 10)}`, { env: SECRET_ENV, now: NOW }) === null);
  check('wrong secret → null', verifyRecoveryToken(t.token, { env: OTHER_ENV, now: NOW }) === null);
  check('expired → null', verifyRecoveryToken(t.token, { env: SECRET_ENV, now: new Date(NOW.getTime() + 15 * 86400000) }) === null);
  check('one second before expiry still verifies',
    verifyRecoveryToken(t.token, { env: SECRET_ENV, now: new Date(new Date(t.expires_at).getTime() - 1000) }) !== null);
  check('wrong version prefix → null', verifyRecoveryToken(`v2.${payload}.${sig}`, { env: SECRET_ENV, now: NOW }) === null);
  check('two-part token → null', verifyRecoveryToken(`v1.${payload}`, { env: SECRET_ENV, now: NOW }) === null);
  check('empty string → null', verifyRecoveryToken('', { env: SECRET_ENV }) === null);
  check('non-string → null', verifyRecoveryToken(null) === null && verifyRecoveryToken({}) === null);
  check('absurdly long token → null before any crypto', verifyRecoveryToken('v1.' + 'a'.repeat(5000), { env: SECRET_ENV }) === null);
  check('a non-json payload → null (signature check runs first, JSON.parse cannot throw out)',
    verifyRecoveryToken(`v1.${Buffer.from('not json at all').toString('base64url')}.${sig}`,
      { env: SECRET_ENV, now: NOW }) === null);
}
{
  // The dot-collision trap: ids that contain dots must survive, which is why
  // the payload is base64url rather than a raw `id.exp.sig` join.
  const dotted = 'sess.with.dots.v2';
  const t = signRecoveryToken('shopify', dotted, { env: SECRET_ENV, now: NOW });
  const v = verifyRecoveryToken(t.token, { env: SECRET_ENV, now: NOW });
  check('an id containing dots round-trips intact', v && v.ref === dotted && v.source === 'shopify', JSON.stringify(v));
}
throws('unknown source throws at mint time', () => signRecoveryToken('paypal', 'x', { env: SECRET_ENV }), 'unknown recovery source');
throws('empty ref throws at mint time', () => signRecoveryToken('funnel', '', { env: SECRET_ENV }), 'needs a ref id');
throws('null ref throws at mint time', () => signRecoveryToken('funnel', null, { env: SECRET_ENV }), 'needs a ref id');
check('custom TTL is honoured',
  new Date(signRecoveryToken('funnel', 'x', { env: SECRET_ENV, now: NOW, ttlSeconds: 60 }).expires_at).getTime()
  === NOW.getTime() + 60000);
check('recoveryLinkUrl embeds the token under the resume path',
  recoveryLinkUrl('v1.aa.bb', { env: { APP_BASE_URL: 'https://p.test' } }) === 'https://p.test/api/v1/checkout/public/resume/v1.aa.bb');
check('recoveryLinkUrl degrades to a relative path with no base configured',
  recoveryLinkUrl('tok', { env: {} }) === '/api/v1/checkout/public/resume/tok');

// ── 6b. the secret must exist — no derivable fallback ───────────────────────
// With an unset secret the key was sha256('puure-resume:'), a constant anyone
// who has read this file can compute — i.e. forgeable tokens, and once the
// resume endpoint ships, an IDOR into other buyers' carts.
console.log('\n6b. secret is mandatory');
const NO_SECRET = {};
const DEV_SECRET = { JWT_ACCESS_SECRET: 'dev-access-secret-change-me' };
check('hasRecoverySecret: real secret → true', hasRecoverySecret(SECRET_ENV) === true);
check('hasRecoverySecret: unset → false', hasRecoverySecret(NO_SECRET) === false);
check('hasRecoverySecret: the SHIPPED dev default is not a secret', hasRecoverySecret(DEV_SECRET) === false);
check('hasRecoverySecret: whitespace-only is not a secret', hasRecoverySecret({ CHECKOUT_RESUME_SECRET: '   ' }) === false);
check('hasRecoverySecret: a real JWT_ACCESS_SECRET is accepted as the fallback',
  hasRecoverySecret({ JWT_ACCESS_SECRET: 'a-real-production-jwt-secret' }) === true);
throws('mint REFUSES with no secret', () => signRecoveryToken('funnel', 'x', { env: NO_SECRET }), 'CHECKOUT_RESUME_SECRET');
throws('mint REFUSES on the shipped dev default', () => signRecoveryToken('funnel', 'x', { env: DEV_SECRET }), 'CHECKOUT_RESUME_SECRET');
check('the refusal is a typed, catchable error',
  (() => { try { signRecoveryToken('funnel', 'x', { env: NO_SECRET }); return false; }
    catch (e) { return e instanceof RecoverySecretError && e.code === 'recovery_secret_unset'; } })());
throws('buildRecoveryRecord REFUSES for a funnel cart with no secret',
  () => buildRecoveryRecord({ source: 'funnel', refId: 'x', env: NO_SECRET }), 'CHECKOUT_RESUME_SECRET');
check('verify FAILS CLOSED with no secret — same null a forgery gets',
  verifyRecoveryToken(signRecoveryToken('funnel', 'x', { env: SECRET_ENV }).token, { env: NO_SECRET }) === null);
{
  // A Shopify row needs no token of ours, so it must NOT be blocked by an
  // unset secret — the link is Shopify's own URL.
  const r = buildRecoveryRecord({ source: 'shopify', refId: '9', externalUrl: 'https://shop.test/r/9', env: NO_SECRET });
  check('a SHOPIFY row still works with no secret (external link, no token minted)',
    r.link_url === 'https://shop.test/r/9' && r.link_token === null && r.link_is_external === true, JSON.stringify(r));
}

// ── 7. the sidecar record shape ─────────────────────────────────────────────
console.log('\n7. buildRecoveryRecord');
{
  const r = buildRecoveryRecord({ source: 'funnel', refId: 'sess_1', status: 'Sent', now: NOW, env: { ...SECRET_ENV, APP_BASE_URL: 'https://p.test' } });
  check('carries source + ref + status', r.source === 'funnel' && r.ref_id === 'sess_1' && r.recovery_status === 'Sent');
  check('mints our own signed link for a funnel cart',
    r.link_is_external === false && r.link_url.startsWith('https://p.test/api/v1/checkout/public/resume/v1.'), r.link_url);
  check('link token verifies against the same secret',
    verifyRecoveryToken(r.link_token, { env: SECRET_ENV, now: NOW }).ref === 'sess_1');
  check('expiry recorded', typeof r.link_expires_at === 'string');
  check('unknown status degrades to "Not recovered", never trusted',
    buildRecoveryRecord({ source: 'funnel', refId: 'x', status: 'Hacked', env: SECRET_ENV }).recovery_status === 'Not recovered');
}
{
  const r = buildRecoveryRecord({ source: 'shopify', refId: '99', externalUrl: 'https://shop.test/recover/abc', env: SECRET_ENV });
  check('shopify keeps SHOPIFY’s url and flags it external',
    r.link_is_external === true && r.link_url === 'https://shop.test/recover/abc');
}
check('lastError is captured and truncated',
  buildRecoveryRecord({ source: 'funnel', refId: 'x', lastError: 'e'.repeat(500), env: SECRET_ENV }).last_error.length === 300);
check('refId is truncated to 128 chars',
  buildRecoveryRecord({ source: 'funnel', refId: 'r'.repeat(400), env: SECRET_ENV }).ref_id.length === 128);
throws('bad source throws', () => buildRecoveryRecord({ source: 'nmi', refId: 'x' }), 'unknown recovery source');
throws('missing ref throws', () => buildRecoveryRecord({ source: 'funnel' }), 'needs a ref id');
throws('empty input throws', () => buildRecoveryRecord({}), 'unknown recovery source');

// ── 8. the event payload ────────────────────────────────────────────────────
console.log('\n8. buildEventProperties');
{
  const p = buildEventProperties(
    { ref_id: 'sess_9', created_at: OLD, currency: 'EUR', line_items: [{ title: 'A', quantity: 2, price: 10 }] },
    { recoveryUrl: 'https://p.test/r/tok', manual: true, source: 'funnel' }
  );
  check('carries the recovery URL', p.RecoveryUrl === 'https://p.test/r/tok');
  check('carries AbandonedAt + currency + source', p.AbandonedAt === OLD && p.currency === 'EUR' && p.source === 'funnel');
  check('Manual flag distinguishes the button from the sweep', p.Manual === true);
  check('item_count matches the cart', p.item_count === 2);
  check('items are trimmed to title/quantity/price (no PII)',
    Object.keys(p.items[0]).sort().join(',') === 'price,quantity,title');
}
check('a Date created_at is serialized',
  buildEventProperties({ ref_id: 'x', created_at: NOW }, {}).AbandonedAt === NOW.toISOString());
check('null row does not throw', buildEventProperties(null, {}).item_count === 0);
check('malformed line_items do not throw', buildEventProperties({ line_items: '{{{' }, {}).items.length === 0);

// ── 9. the outbound nudge — every failure path, executed ────────────────────
console.log('\n9. sendRecoveryEvent (real code, mocked collaborators)');
const real = { ...Object.fromEntries(Object.keys(_deps).map((k) => [k, _deps[k]])) };
const log = [];
function install({ configured = true, claim = true, sendOk = true, sendThrows = false, releaseThrows = false } = {}) {
  log.length = 0;
  _deps.getKlaviyoConfig = async () => ({ enabled: configured, apiKey: configured ? 'pk_test_harness' : '' });
  _deps.claimSend = async (kind, ref) => { log.push(['claim', kind, ref]); return claim; };
  _deps.releaseSend = async (kind, ref) => { log.push(['release', kind, ref]); if (releaseThrows) throw new Error('release boom'); };
  _deps.upsertProfile = async (p) => { log.push(['profile', JSON.stringify(p)]); return { ok: true }; };
  _deps.trackEvent = async (e) => {
    log.push(['event', e.metric_name, e.unique_id, e.properties?.RecoveryUrl, e.value]);
    if (sendThrows) throw new Error('vendor exploded');
    return sendOk ? { ok: true } : { ok: false, error: 'http_500' };
  };
}
// PRODUCTION-SHAPED: this is exactly what the unified CTE and loadOne emit —
// `total_price` (aliased), NOT `total`. The previous fixture used `total`,
// which is why a $0-value event shipped green.
const ROW = {
  source: 'funnel', ref_id: 'sess_x', email: 'Buyer@Example.com',
  total_price: '88.50', currency: 'USD', status: 'processing', paid_at: null,
  gateway: 'whop', gateway_session_id: 'ch_live_abc', created_at: OLD,
  line_items: [{ title: 'A', quantity: 1, price: 88.5 }],
};

install();
{
  const r = await sendRecoveryEvent(ROW, { manual: true, env: { ...SECRET_ENV, APP_BASE_URL: 'https://p.test' } });
  check('happy path returns ok', r.ok === true, JSON.stringify(r));
  check('claim is taken BEFORE the event', log.findIndex((l) => l[0] === 'claim') < log.findIndex((l) => l[0] === 'event'));
  check('unique_id is ab_<source>_<ref>', log.find((l) => l[0] === 'event')[2] === 'ab_funnel_sess_x');
  check(`metric is "${ABANDONED_METRIC}"`, log.find((l) => l[0] === 'event')[1] === ABANDONED_METRIC);
  check('event value = cart total READ OFF THE PRODUCTION COLUMN (total_price)',
    log.find((l) => l[0] === 'event')[4] === 88.5, String(log.find((l) => l[0] === 'event')[4]));
  check('the recovery link travels in the event', String(log.find((l) => l[0] === 'event')[3]).includes('/checkout/public/resume/'));
  check('profile is EMAIL-ONLY on the unpaid lead path',
    JSON.parse(log.find((l) => l[0] === 'profile')[1]).email === 'buyer@example.com'
    && Object.keys(JSON.parse(log.find((l) => l[0] === 'profile')[1])).length === 1);
  check('no release on the happy path', !log.some((l) => l[0] === 'release'));
}

install({ claim: false });
{
  const r = await sendRecoveryEvent(ROW, {});
  check('a lost claim dedups instead of double-emailing', r.ok === true && r.deduped === true);
  check('dedup fires NO event', !log.some((l) => l[0] === 'event'));
}

install({ sendOk: false });
{
  const r = await sendRecoveryEvent(ROW, {});
  check('vendor 500 → ok:false, error surfaced', r.ok === false && r.error === 'http_500');
  check('a failed send RELEASES the claim so a retry can re-attempt', log.some((l) => l[0] === 'release' && l[2] === 'ab_funnel_sess_x'));
}

install({ sendThrows: true });
{
  const r = await sendRecoveryEvent(ROW, {});
  check('a THROW between claim and send never escapes', r.ok === false && r.error.startsWith('internal:'));
  check('the throw path releases the claim too', log.some((l) => l[0] === 'release'));
}

install({ sendOk: false, releaseThrows: true });
{
  const r = await sendRecoveryEvent(ROW, {});
  check('a failing RELEASE still returns cleanly (orphan is logged, not thrown)', r.ok === false);
}

install({ configured: false });
{
  const r = await sendRecoveryEvent(ROW, {});
  check('Klaviyo off → skipped, and nothing is claimed', r.ok === false && r.skipped === true && r.error === 'not_configured' && log.length === 0);
}

install();
check('unsalvageable email → refused before the claim',
  (await sendRecoveryEvent({ ...ROW, email: 'nope' }, {})).error === 'no_deliverable_email' && !log.some((l) => l[0] === 'claim'));
check('missing email → refused', (await sendRecoveryEvent({ ...ROW, email: null }, {})).error === 'no_deliverable_email');
check('bad source → refused', (await sendRecoveryEvent({ ...ROW, source: 'nmi' }, {})).error === 'bad_source');
check('missing ref → refused', (await sendRecoveryEvent({ ...ROW, ref_id: '' }, {})).error === 'bad_ref');
check('null row → refused, no throw', (await sendRecoveryEvent(null, {})).error === 'bad_source');

// ── 9b. the settle re-check (snapshot staleness) ────────────────────────────
// A sweep holds a SNAPSHOT and can take minutes to reach a row. The row it is
// about to email may have settled in the meantime — and sendRecoveryEvent does
// no DB reads of its own, so without this hook it cannot possibly know.
console.log('\n9b. recheck — the cart that settles mid-sweep');
install();
{
  const r = await sendRecoveryEvent(ROW, { recheck: async () => ({ ...ROW, status: 'paid', paid_at: OLD }) });
  check('a cart that settled since the snapshot is REFUSED', r.ok === false && r.error === 'settled_before_send');
  check('the refusal fires NO event and takes NO claim', !log.some((l) => l[0] === 'event' || l[0] === 'claim'));
}
install();
check('a paid_at with no status flip is caught too',
  (await sendRecoveryEvent(ROW, { recheck: async () => ({ ...ROW, paid_at: OLD }) })).error === 'settled_before_send');
install();
check('a REFUNDED cart is refused (it was paid)',
  (await sendRecoveryEvent(ROW, { recheck: async () => ({ ...ROW, status: 'refunded' }) })).error === 'settled_before_send');
install();
check('a vanished row is refused, not sent blind',
  (await sendRecoveryEvent(ROW, { recheck: async () => null })).error === 'vanished');
install();
{
  // POSITIVE control: a recheck that returns a still-unpaid row must NOT block
  // the send, or the guard would be indistinguishable from a kill switch.
  const r = await sendRecoveryEvent(ROW, { recheck: async () => ({ ...ROW }) });
  check('positive control: an unsettled recheck still sends', r.ok === true && log.some((l) => l[0] === 'event'));
}
install();
{
  // The recheck runs regardless of the row's own age — grace is not re-applied
  // here, so a FRESH-but-settled row is still caught.
  const r = await sendRecoveryEvent(ROW, {
    recheck: async () => ({ ...ROW, created_at: new Date().toISOString(), status: 'paid' }),
  });
  check('grace is not re-applied by the recheck — settled is settled', r.error === 'settled_before_send');
}
install();
{
  const r = await sendRecoveryEvent(ROW, { env: {} });
  check('no signing secret → clean refusal, not an internal error',
    r.ok === false && r.error === 'recovery_secret_unset' && r.skipped === true, JSON.stringify(r));
  check('the secret refusal releases nothing because it claimed nothing', !log.some((l) => l[0] === 'claim'));
}

for (const k of Object.keys(real)) _deps[k] = real[k];
check('deps restored to the real implementations', _deps.trackEvent === real.trackEvent);

// The harness asserts its own coverage — a silently skipped section cannot
// masquerade as green.
const EXPECTED = 163;
check(`coverage: exactly ${EXPECTED} checks ran before this one`, pass + fail === EXPECTED, `ran=${pass + fail}`);

console.log(`\nRESULT: ${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
