// DUNNING verification — drives the REAL /api/v1/dunning router (real
// authenticate + requirePermission + ensureTables) against embedded PG on 5433.
//
// Klaviyo is swapped at the service's `_deps` seam (same pattern as
// klaviyoEvents._deps / abandonedRecovery._deps), so the exactly-once claim
// protocol is proved against the REAL lb_integration_sends table with a fake
// vendor — including the release-on-failure path that a network cannot be
// asked to produce on demand.
//
// Proves BY EXECUTION:
//   D1  every endpoint refuses an unauthenticated request (401)
//   D2  classification: the hard-decline denylist, the reporting buckets, and
//       the ladder arithmetic — all as pure functions
//   D3  scan projects real declines and EXCLUDES every non-decline: the
//       declined_by_user $0 marker, settled / needs_review / canceled /
//       pending_settlement / charging rows, and sub-minimum amounts
//   D4  base-order failures come from last_failed_payment_id + the
//       payment_failed event's reason
//   D5  the scan is idempotent — a re-run never duplicates a row, never resets
//       a ladder an operator already climbed, and never un-sends an email
//   D6  the retry ladder: 1h → 24h → 72h, then 'exhausted'
//   D7  a retry RECORDS INTENT ONLY — money_moved:false, an append-only intent
//       row per attempt, and a double-click produces one row plus one refusal
//   D8  every refusal is NAMED (state / exhausted / hard decline)
//   D9  the dunning email is exactly-once: claimed before send, deduped on
//       replay, RELEASED when the send fails, and skipped for a hard decline,
//       a missing email, or an unconfigured integration
//   D10 a decline older than the ladder is recorded 'stale', never scheduled
//   D11 list windowing + stats, with the top-bucket percentage guarded at 0 rows
//   D12 detail names the integrator's precondition (no_saved_payment_method)
//   D13 close: 'recovered' once, then refused
//   D14 malformed input is refused with a NAMED error, never a 500
//   D15 grep-proof: this lane never writes the money path's tables
//
// Run:  node server/tests/orders/dunning.mjs
process.env.DATABASE_URL = 'postgres://puure@127.0.0.1:5433/puure_dunning';
process.env.NODE_ENV = 'development';
process.env.JWT_ACCESS_SECRET = process.env.JWT_ACCESS_SECRET || 'dev-access-secret-change-me';

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';

const HERE = dirname(fileURLToPath(import.meta.url));
const NM = '/Users/ludo/Mineblock-LLC/node_modules';
const express = (await import(`${NM}/express/index.js`)).default;
const jwt = (await import(`${NM}/jsonwebtoken/index.js`)).default;
const postgres = (await import(`${NM}/postgres/src/index.js`)).default;

const sql = postgres(process.env.DATABASE_URL, { onnotice: () => {} });

{
  const [{ n }] = await sql`
    SELECT COUNT(*)::int AS n FROM pg_stat_activity
    WHERE datname = current_database() AND pid <> pg_backend_pid()`;
  if (n > 0) {
    await sql`SELECT pg_terminate_backend(pid) FROM pg_stat_activity
              WHERE datname = current_database() AND pid <> pg_backend_pid()`;
    console.log(`bootstrap: terminated ${n} stale backend(s)`);
  }
}

let pass = 0, fail = 0;
const check = (name, ok, extra = '') => {
  if (ok) { pass++; console.log(`PASS  ${name}`); }
  else { fail++; console.log(`FAIL  ${name}  ${extra}`); }
};

// ── seed auth ───────────────────────────────────────────────────────────────
await sql`CREATE TABLE IF NOT EXISTS users (
  id TEXT PRIMARY KEY, email TEXT, first_name TEXT, last_name TEXT,
  must_change_password BOOLEAN DEFAULT FALSE, email_verified BOOLEAN DEFAULT TRUE,
  is_active BOOLEAN DEFAULT TRUE)`;
await sql`CREATE TABLE IF NOT EXISTS roles (id TEXT PRIMARY KEY, name TEXT, permissions JSONB)`;
await sql`CREATE TABLE IF NOT EXISTS user_roles (user_id TEXT, role_id TEXT)`;
await sql`INSERT INTO users (id, email, first_name, last_name)
  VALUES ('u_dn_a', 'dna@local.test', 'Dun', 'Alpha') ON CONFLICT (id) DO NOTHING`;
await sql`INSERT INTO roles (id, name, permissions)
  VALUES ('r_dn_test', 'dn-tester', '{"orders": ["access"]}')
  ON CONFLICT (id) DO UPDATE SET permissions = EXCLUDED.permissions`;
await sql`DELETE FROM user_roles WHERE user_id = 'u_dn_a'`;
await sql`INSERT INTO user_roles (user_id, role_id) VALUES ('u_dn_a','r_dn_test')`;

const dunningRouter = (await import('../../src/routes/dunning.js')).default;
const dun = await import('../../src/services/dunningService.js');
const { ensureCheckoutTables } = await import('../../src/services/checkoutSchema.js');
const { ensureIntegrationTables } = await import('../../src/services/integrationsSchema.js');
await ensureCheckoutTables();
await ensureIntegrationTables();
await dun.ensureDunningTables();

const app = express();
app.use(express.json());
app.use('/api/v1/dunning', dunningRouter);
const server = app.listen(0);
const PORT = server.address().port;
const B = `http://127.0.0.1:${PORT}/api/v1/dunning`;

const HA = {
  Authorization: `Bearer ${jwt.sign({ userId: 'u_dn_a' }, process.env.JWT_ACCESS_SECRET, { expiresIn: '10m' })}`,
  'Content-Type': 'application/json',
};
const NOAUTH = { 'Content-Type': 'application/json' };
const req = async (method, path, body, headers = HA) => {
  const r = await fetch(`${B}${path}`, {
    method, headers, body: body === undefined ? undefined : JSON.stringify(body),
  });
  let j = null; let text = '';
  try { text = await r.text(); j = JSON.parse(text); } catch { /* non-JSON */ }
  return { status: r.status, j, text };
};

// ── fake Klaviyo ────────────────────────────────────────────────────────────
const klav = { enabled: true, apiKey: 'pk_fake', sent: [], profiles: [], failNext: false, throwNext: false };
const realDeps = { ...dun._deps };
dun._deps.getKlaviyoConfig = async () => ({ enabled: klav.enabled, apiKey: klav.apiKey });
dun._deps.upsertProfile = async (p) => { klav.profiles.push(p); return { ok: true }; };
dun._deps.trackEvent = async (e) => {
  if (klav.throwNext) { klav.throwNext = false; throw new Error('vendor exploded'); }
  if (klav.failNext) { klav.failNext = false; return { ok: false, error: 'http_500' }; }
  klav.sent.push(e);
  return { ok: true };
};

// ── fixtures ────────────────────────────────────────────────────────────────
const S_PAID = 'co_dn_paid';        // paid session with a saved PM
const S_NOPM = 'co_dn_nopm';        // paid session with NO saved PM
const S_PROC = 'co_dn_proc';        // processing session whose base payment failed
const S_STALE = 'co_dn_stale';
const ALL = [S_PAID, S_NOPM, S_PROC, S_STALE];

const cleanup = async () => {
  await sql`DELETE FROM co_dunning_retry_requests WHERE session_id = ANY(${ALL})`;
  await sql`DELETE FROM co_dunning_queue WHERE session_id = ANY(${ALL})`;
  await sql`DELETE FROM co_events WHERE session_id = ANY(${ALL})`;
  await sql`DELETE FROM co_upsell_charges WHERE session_id = ANY(${ALL})`;
  await sql`DELETE FROM co_sessions WHERE id = ANY(${ALL})`;
  await sql`DELETE FROM lb_integration_sends WHERE kind = 'klaviyo' AND ref LIKE 'kdf_%'`;
};
await cleanup();

const ago = (h) => new Date(Date.now() - h * 3600_000);

await sql`INSERT INTO co_sessions (id, funnel_id, status, total, currency, customer, gateway,
    payment_method_id, paid_at, created_at, updated_at)
  VALUES
  (${S_PAID}, 'f_dn', 'paid', 120.00, 'USD',
   ${sql.json({ email: 'buyer@local.test' })}, 'whop', 'pm_1', ${ago(4)}, ${ago(4)}, ${ago(2)}),
  (${S_NOPM}, 'f_dn', 'paid', 80.00, 'USD',
   ${sql.json({ email: 'nopm@local.test' })}, 'whop', NULL, ${ago(4)}, ${ago(4)}, ${ago(2)}),
  (${S_PROC}, 'f_dn', 'processing', 65.00, 'USD',
   ${sql.json({ email: 'proc@local.test' })}, 'whop', NULL, NULL, ${ago(3)}, ${ago(2)}),
  (${S_STALE}, 'f_dn', 'paid', 55.00, 'USD',
   ${sql.json({ email: 'stale@local.test' })}, 'whop', 'pm_2', ${ago(200)}, ${ago(200)}, ${ago(1)})`;

// Base-order failure evidence for the processing session.
await sql`UPDATE co_sessions SET last_failed_payment_id = 'pay_failed_1' WHERE id = ${S_PROC}`;
await sql`INSERT INTO co_events (session_id, kind, data, created_at)
  VALUES (${S_PROC}, 'payment_failed',
          ${sql.json({ gateway: 'whop', payment_id: 'pay_failed_1', reason: 'insufficient_funds' })},
          ${ago(2)})`;

// The upsell ledger. Only ONE of these is a dunnable decline.
const uc = (id, sid, offer, chargeId, amount, status, extra = {}) => sql`
  INSERT INTO co_upsell_charges (id, session_id, offer_id, charge_id, amount, currency, status,
      declined_by_user, error, created_at, updated_at)
  VALUES (${id}, ${sid}, ${offer}, ${chargeId}, ${amount}, 'USD', ${status},
      ${extra.byUser || false}, ${extra.error || ''}, ${extra.at || ago(2)}, ${extra.at || ago(2)})`;

await uc('uc_dn_soft', S_PAID, 'offer_1', 'v:111', 49.00, 'declined', { error: 'insufficient_funds' });
await uc('uc_dn_hard', S_PAID, 'offer_2', 'v:222', 39.00, 'declined', { error: 'card reported stolen' });
await uc('uc_dn_user', S_PAID, 'offer_3', 'decline', 0, 'declined', { byUser: true });
await uc('uc_dn_settled', S_PAID, 'offer_4', 'v:444', 25.00, 'settled');
await uc('uc_dn_review', S_PAID, 'offer_5', 'v:555', 30.00, 'needs_review', { error: 'amount_mismatch' });
await uc('uc_dn_cancel', S_PAID, 'offer_6', 'v:666', 15.00, 'canceled');
await uc('uc_dn_pending', S_PAID, 'offer_7', 'v:777', 12.00, 'pending_settlement');
await uc('uc_dn_charging', S_PAID, 'offer_8', 'v:888', 11.00, 'charging');
await uc('uc_dn_tiny', S_PAID, 'offer_9', 'v:999', 0.50, 'declined', { error: 'generic_decline' });
await uc('uc_dn_nopm', S_NOPM, 'offer_1', 'v:111', 22.00, 'declined', { error: 'processing_error' });
// A SOFT decline that is simply too old — the staleness branch must be reached
// on its own merits, not short-circuited by a hard-decline marker in the text.
await uc('uc_dn_stale', S_STALE, 'offer_1', 'v:111', 33.00, 'declined', { error: 'generic_decline', at: ago(24 * 6) });

// ════════════════════════════════════════════════════════════════════════════
// D1 — auth
// ════════════════════════════════════════════════════════════════════════════
{
  const paths = [
    ['GET', '/config'], ['GET', '/failed-payments'], ['POST', '/scan'],
    ['GET', '/failed-payments/x'], ['POST', '/failed-payments/x/retry'], ['POST', '/failed-payments/x/close'],
  ];
  let all401 = true; const seen = [];
  for (const [m, p] of paths) {
    const r = await req(m, p, m === 'GET' ? undefined : {}, NOAUTH);
    seen.push(`${m} ${p}=${r.status}`);
    if (r.status !== 401) all401 = false;
  }
  check('D1 every dunning endpoint 401s without a token', all401, seen.join(' '));
}

// ════════════════════════════════════════════════════════════════════════════
// D2 — pure classification
// ════════════════════════════════════════════════════════════════════════════
{
  const retryable = ['insufficient_funds', 'processing error', 'generic_decline', 'network timeout', 'issuer unavailable', ''];
  const hard = ['card reported stolen', 'lost card', 'FRAUD suspected', 'pickup card', 'do_not_honor',
    'expired card', 'invalid_card', 'closed account', 'authorization revoked', 'restricted card'];
  check('D2 every soft/retryable reason stays retryable',
    retryable.every((r) => dun.isRetryableReason(r)),
    retryable.filter((r) => !dun.isRetryableReason(r)).join('|'));
  check('D2 every hard decline is refused a retry',
    hard.every((r) => !dun.isRetryableReason(r)),
    hard.filter((r) => dun.isRetryableReason(r)).join('|'));

  const buckets = [
    ['insufficient_funds', 'insufficient_funds'], ['Insufficient Funds', 'insufficient_funds'],
    ['nsf', 'insufficient_funds'], ['expired card', 'expired_card'],
    ['do-not-honor', 'do_not_honor'], ['authorization revoked', 'payment_method_revoked'],
    ['card reported stolen', 'fraud_suspected'], ['closed account', 'invalid_payment_method'],
    ['issuer unavailable', 'processing_error'], ['generic decline', 'card_declined'],
    ['', 'unknown'], ['something nobody has ever seen', 'unknown'],
  ];
  const wrong = buckets.filter(([r, want]) => dun.classifyDecline(r) !== want);
  check('D2 the reporting taxonomy buckets every reason, and NORMALIZES separators',
    wrong.length === 0, wrong.map(([r, w]) => `${r}→${dun.classifyDecline(r)}≠${w}`).join(' | '));

  const t0 = new Date('2026-05-01T00:00:00Z');
  const h = (d) => (d.getTime() - t0.getTime()) / 3600_000;
  check('D2 the ladder is 1h → 24h → 72h and then SPENT',
    h(dun.nextRetryAt(t0, 0)) === 1 && h(dun.nextRetryAt(t0, 1)) === 24
    && h(dun.nextRetryAt(t0, 2)) === 72 && dun.nextRetryAt(t0, 3) === null
    && dun.nextRetryAt(t0, 99) === null);
  check('D2 an unparseable timestamp does not throw or produce an Invalid Date',
    dun.nextRetryAt('not-a-date', 0) instanceof Date
    && Number.isFinite(dun.nextRetryAt('not-a-date', 0).getTime()));

  const now = new Date();
  check('D2 a $0 declined_by_user marker is NOT dunnable',
    dun.classifyFailure({ reason: '', amount: 0, declinedByUser: true, failedAt: now, now }).dunnable === false);
  check('D2 a sub-minimum amount is NOT dunnable',
    dun.classifyFailure({ reason: 'generic', amount: 0.5, declinedByUser: false, failedAt: now, now }).why === 'amount_below_minimum');
  check('D2 a hard decline IS queued but NOT scheduled',
    (() => { const c = dun.classifyFailure({ reason: 'stolen', amount: 40, declinedByUser: false, failedAt: now, now }); return c.dunnable && c.state === 'not_retryable' && c.retryable === false; })());
}

// ════════════════════════════════════════════════════════════════════════════
// D3/D4 — the scan
// ════════════════════════════════════════════════════════════════════════════
{
  klav.sent = [];
  const r = await req('POST', '/scan', { days: 30 });
  check('D3 scan 200 and reports money_moved:false', r.status === 200 && r.j?.money_moved === false, JSON.stringify(r.j).slice(0, 200));

  const rows = await sql`SELECT * FROM co_dunning_queue WHERE session_id = ANY(${ALL}) ORDER BY id`;
  const ids = rows.map((x) => x.source_id).sort();
  check('D3 exactly the five real failures were queued — every non-decline excluded',
    JSON.stringify(ids) === JSON.stringify([S_PROC, 'uc_dn_hard', 'uc_dn_nopm', 'uc_dn_soft', 'uc_dn_stale'].sort()),
    JSON.stringify(ids));
  check('D3 the $0 declined_by_user marker is NOT in the queue',
    !ids.includes('uc_dn_user'));
  check('D3 the sub-minimum $0.50 decline is NOT in the queue', !ids.includes('uc_dn_tiny'));
  check('D3 settled / needs_review / canceled / pending_settlement / charging are all absent',
    !['uc_dn_settled', 'uc_dn_review', 'uc_dn_cancel', 'uc_dn_pending', 'uc_dn_charging'].some((x) => ids.includes(x)));

  const soft = rows.find((x) => x.source_id === 'uc_dn_soft');
  check('D3 the soft decline is scheduled, bucketed and given a next_retry_at ~1h out',
    soft.state === 'scheduled' && soft.retryable === true
    && soft.decline_bucket === 'insufficient_funds' && soft.next_retry_at !== null
    && Math.abs(new Date(soft.next_retry_at) - (new Date(soft.first_failed_at).getTime() + 3600_000)) < 2000,
    JSON.stringify({ s: soft.state, b: soft.decline_bucket, n: soft.next_retry_at }));

  const hard = rows.find((x) => x.source_id === 'uc_dn_hard');
  check('D3 the hard decline is queued NOT retryable, with NO scheduled retry',
    hard.state === 'not_retryable' && hard.retryable === false && hard.next_retry_at === null
    && hard.decline_bucket === 'fraud_suspected', JSON.stringify({ s: hard.state, n: hard.next_retry_at }));

  const base = rows.find((x) => x.source === 'session');
  check('D4 the base-order failure was projected from last_failed_payment_id',
    base && base.source_id === S_PROC && Number(base.amount) === 65
    && base.customer_email === 'proc@local.test', JSON.stringify(base && { a: base.amount, e: base.customer_email }));
  check('D4 its reason came from the payment_failed event, not from thin air',
    base.decline_reason === 'insufficient_funds' && base.decline_bucket === 'insufficient_funds',
    `${base?.decline_reason}`);

  // Six rows were seeded 'declined' (four dunnable, plus the $0 user marker and
  // the sub-minimum one). All six must STILL read 'declined' — the queue reads
  // this ledger and must never write it.
  check('D3 the scan wrote NOTHING to the money path — every charge status is untouched',
    (await sql`SELECT COUNT(*)::int n FROM co_upsell_charges
       WHERE session_id = ANY(${ALL}) AND status = 'declined'`)[0].n === 6);
}

// ════════════════════════════════════════════════════════════════════════════
// D10 — stale decline
// ════════════════════════════════════════════════════════════════════════════
{
  const [stale] = await sql`SELECT * FROM co_dunning_queue WHERE source_id = 'uc_dn_stale'`;
  check('D10 a decline older than the ladder is recorded stale and never scheduled',
    stale.state === 'stale' && stale.next_retry_at === null && stale.state_reason === 'decline_too_old',
    JSON.stringify({ s: stale.state, n: stale.next_retry_at, r: stale.state_reason }));
}

// ════════════════════════════════════════════════════════════════════════════
// D9 — the dunning email
// ════════════════════════════════════════════════════════════════════════════
const SOFT_ID = `dq_u_uc_dn_soft`;
{
  const sends = await sql`SELECT ref FROM lb_integration_sends WHERE kind = 'klaviyo' AND ref LIKE 'kdf_%' ORDER BY ref`;
  const refs = sends.map((s) => s.ref);
  check('D9 the scan sent ONE dunning email per SCHEDULED failure and claimed each',
    refs.includes(`kdf_${SOFT_ID}`) && refs.includes(`kdf_dq_s_${S_PROC}`),
    JSON.stringify(refs));
  check('D9 a HARD decline gets NO "we will try again" email — the promise would be false',
    !refs.includes('kdf_dq_u_uc_dn_hard'), JSON.stringify(refs));
  check('D9 a STALE decline gets no email either', !refs.includes('kdf_dq_u_uc_dn_stale'));
  check('D9 the event carries the metric, the unique_id and the classification',
    klav.sent.some((e) => e.metric_name === 'Payment Failed' && e.unique_id === `kdf_${SOFT_ID}`
      && e.properties.reason_bucket === 'insufficient_funds' && e.value === 49), JSON.stringify(klav.sent[0]));
  check('D9 the profile is EMAIL-ONLY (the buyer has not completed this purchase)',
    klav.profiles.every((p) => Object.keys(p).length === 1 && p.email), JSON.stringify(klav.profiles[0]));

  // Replay — the claim must dedup.
  const before = klav.sent.length;
  const [row] = await sql`SELECT * FROM co_dunning_queue WHERE id = ${SOFT_ID}`;
  const again = await dun.sendDunningEvent(row);
  check('D9 a replayed send is deduped at OUR claim, with no second vendor call',
    again.ok === true && again.deduped === true && klav.sent.length === before, JSON.stringify(again));

  // A FAILED send must RELEASE the claim, or the event is lost forever.
  await sql`DELETE FROM lb_integration_sends WHERE kind = 'klaviyo' AND ref = ${'kdf_' + SOFT_ID}`;
  klav.failNext = true;
  const failed = await dun.sendDunningEvent(row);
  const held = await sql`SELECT 1 FROM lb_integration_sends WHERE kind = 'klaviyo' AND ref = ${'kdf_' + SOFT_ID}`;
  check('D9 a FAILED send releases its claim so a later attempt can re-send',
    failed.ok === false && held.length === 0, `${JSON.stringify(failed)} held=${held.length}`);

  // A THROW between claim and send must also release.
  klav.throwNext = true;
  const threw = await dun.sendDunningEvent(row);
  const held2 = await sql`SELECT 1 FROM lb_integration_sends WHERE kind = 'klaviyo' AND ref = ${'kdf_' + SOFT_ID}`;
  check('D9 a THROW between claim and send releases the claim and never propagates',
    threw.ok === false && /internal:/.test(threw.error) && held2.length === 0,
    `${JSON.stringify(threw)} held=${held2.length}`);

  // Now let it succeed once more and confirm exactly one vendor call landed.
  const n0 = klav.sent.length;
  const good = await dun.sendDunningEvent(row);
  check('D9 after the releases, exactly ONE further send lands and re-claims',
    good.ok === true && !good.deduped && klav.sent.length === n0 + 1
    && (await sql`SELECT 1 FROM lb_integration_sends WHERE kind='klaviyo' AND ref=${'kdf_' + SOFT_ID}`).length === 1);

  // Guards.
  klav.enabled = false;
  const off = await dun.sendDunningEvent({ ...row, id: 'dq_u_offtest' });
  check('D9 an unconfigured Klaviyo is skipped, never an error the caller must handle',
    off.ok === false && off.skipped === true && off.error === 'not_configured', JSON.stringify(off));
  klav.enabled = true;
  const noMail = await dun.sendDunningEvent({ ...row, id: 'dq_u_nomail', customer_email: 'not-an-email' });
  check('D9 an undeliverable address is skipped', noMail.skipped === true && noMail.error === 'no_deliverable_email');
  const hardRow = (await sql`SELECT * FROM co_dunning_queue WHERE source_id = 'uc_dn_hard'`)[0];
  check('D9 a hard-decline row is skipped by the sender itself, not only by the scan',
    (await dun.sendDunningEvent(hardRow)).error === 'not_retryable');
}

// ════════════════════════════════════════════════════════════════════════════
// D5 — the scan is idempotent
// ════════════════════════════════════════════════════════════════════════════
{
  const before = await sql`SELECT id, attempts, notified_at, next_retry_at FROM co_dunning_queue
    WHERE session_id = ANY(${ALL}) ORDER BY id`;
  const nSends = klav.sent.length;
  const r = await req('POST', '/scan', { days: 30 });
  const after = await sql`SELECT id, attempts, notified_at, next_retry_at FROM co_dunning_queue
    WHERE session_id = ANY(${ALL}) ORDER BY id`;
  check('D5 a re-scan queues NOTHING new and updates the existing rows in place',
    r.j?.data?.queued === 0 && after.length === before.length && r.j.data.updated === before.length,
    `queued=${r.j?.data?.queued} updated=${r.j?.data?.updated} rows ${before.length}->${after.length}`);
  check('D5 a re-scan sends NO second email (the claim holds across runs)',
    klav.sent.length === nSends, `${nSends} -> ${klav.sent.length}`);
  check('D5 a re-scan preserves attempts, notified_at and next_retry_at exactly',
    JSON.stringify(before) === JSON.stringify(after),
    `${JSON.stringify(before).slice(0, 200)}\n  vs ${JSON.stringify(after).slice(0, 200)}`);
}

// ════════════════════════════════════════════════════════════════════════════
// D6/D7 — the retry ladder and the intent ledger
// ════════════════════════════════════════════════════════════════════════════
{
  const cfg = await req('GET', '/config');
  check('D6 /config publishes the ladder and says out loud that a retry charges nothing',
    cfg.j?.data?.max_attempts === 3
    && JSON.stringify(cfg.j.data.retry_delays_hours) === '[1,24,72]'
    && cfg.j.data.retry_min_spacing_seconds === 60
    && cfg.j.data.retry_charges_card === false && cfg.j.data.retry_records_intent_only === true,
    JSON.stringify(cfg.j?.data));

  const r1 = await req('POST', `/failed-payments/${SOFT_ID}/retry`, { note: 'operator asked' });
  check('D7 the first retry records intent, attempt 1, money_moved:false',
    r1.status === 200 && r1.j?.money_moved === false && r1.j?.data?.charged === false
    && r1.j.data.attempt_no === 1 && r1.j.data.state === 'scheduled',
    `${r1.status} ${JSON.stringify(r1.j?.data?.attempt_no)}`);
  const q1 = (await sql`SELECT * FROM co_dunning_queue WHERE id = ${SOFT_ID}`)[0];
  check('D6 the ladder advanced to the 24h rung',
    q1.attempts === 1 && Math.abs(new Date(q1.next_retry_at) - (Date.now() + 24 * 3600_000)) < 5000,
    `${q1.attempts} ${q1.next_retry_at}`);

  // A DOUBLE-CLICK, immediately after the first retry. The atomic claim alone
  // would happily grant both (they are genuinely separate requests, and the
  // second correctly re-reads attempts=1 after the row lock) — burning two of
  // three rungs in a second. The spacing floor is what refuses it.
  const dbl = await req('POST', `/failed-payments/${SOFT_ID}/retry`);
  check('D7 an immediate second click is refused retry_too_soon, not granted a rung',
    dbl.status === 409 && dbl.j?.error === 'retry_too_soon' && dbl.j?.min_spacing_seconds === 60,
    `${dbl.status}/${dbl.j?.error}`);
  check('D7 the refused click burned NO rung',
    (await sql`SELECT attempts FROM co_dunning_queue WHERE id = ${SOFT_ID}`)[0].attempts === 1);

  // Time passes (simulated by backdating the last attempt). Now fire TWO
  // requests concurrently: they must resolve to DISTINCT attempt numbers and
  // distinct intent rows — never the same one twice.
  const rewind = async () => sql`UPDATE co_dunning_queue
    SET last_attempt_at = NOW() - interval '2 hours' WHERE id = ${SOFT_ID}`;
  await rewind();
  const [a, b] = await Promise.all([
    req('POST', `/failed-payments/${SOFT_ID}/retry`),
    req('POST', `/failed-payments/${SOFT_ID}/retry`),
  ]);
  const oks = [a, b].filter((x) => x.status === 200);
  check('D7 two CONCURRENT retries can never collide on one attempt number',
    oks.length >= 1
    && new Set(oks.map((x) => x.j.data.attempt_no)).size === oks.length,
    `${a.status}/${a.j?.error || a.j?.data?.attempt_no} ${b.status}/${b.j?.error || b.j?.data?.attempt_no}`);

  const reqs = await sql`SELECT attempt_no, origin, requested_by FROM co_dunning_retry_requests
    WHERE queue_id = ${SOFT_ID} ORDER BY attempt_no`;
  check('D7 the intent ledger is append-only with one row per attempt, strictly ascending',
    reqs.length === 1 + oks.length
    && reqs.every((x, i) => x.attempt_no === i + 1)
    && reqs.every((x) => x.origin === 'manual' && x.requested_by === 'Dun Alpha'),
    JSON.stringify(reqs));

  // Climb to the top of the ladder.
  let r3 = { j: { data: { attempt_no: reqs.length } } };
  while (r3.j.data.attempt_no < 3) {
    await rewind();
    r3 = await req('POST', `/failed-payments/${SOFT_ID}/retry`);
    if (r3.status !== 200) break;
  }
  check('D6 the third retry EXHAUSTS the ladder and clears the schedule',
    r3.j?.data?.attempt_no === 3 && r3.j.data.state === 'exhausted'
    && r3.j.data.next_retry_at === null, JSON.stringify(r3.j?.data).slice(0, 200));

  const r4 = await req('POST', `/failed-payments/${SOFT_ID}/retry`);
  check('D8 a fourth retry is refused 409 naming the exhausted state',
    r4.status === 409 && r4.j?.error === 'state:exhausted', `${r4.status} ${JSON.stringify(r4.j?.error)}`);

  const reqs2 = await sql`SELECT COUNT(*)::int n FROM co_dunning_retry_requests WHERE queue_id = ${SOFT_ID}`;
  check('D7 the refused attempts wrote NO intent rows', reqs2[0].n === 3, `${reqs2[0].n}`);

  const hard = await req('POST', '/failed-payments/dq_u_uc_dn_hard/retry');
  check('D8 a hard decline is refused, naming its state rather than failing generically',
    hard.status === 409 && hard.j?.error === 'state:not_retryable', `${hard.status} ${JSON.stringify(hard.j?.error)}`);
  const staleR = await req('POST', '/failed-payments/dq_u_uc_dn_stale/retry');
  check('D8 a stale decline is refused, naming its state',
    staleR.status === 409 && staleR.j?.error === 'state:stale', `${staleR.status} ${JSON.stringify(staleR.j?.error)}`);
}

// ════════════════════════════════════════════════════════════════════════════
// D11 — list + stats
// ════════════════════════════════════════════════════════════════════════════
{
  const r = await req('GET', '/failed-payments?days=30');
  const d = r.j?.data;
  check('D11 the open list returns every unresolved failure with its stats',
    r.status === 200 && d.total === 5 && d.stats.total === 5
    && d.stats.exhausted === 1 && d.stats.not_retryable === 1 && d.stats.stale === 1,
    JSON.stringify(d?.stats));
  check('D11 at_risk sums the money still on the table',
    d.stats.at_risk === 49 + 39 + 22 + 33 + 65, `${d.stats.at_risk}`);
  check('D11 the top bucket is reported with a percentage of the SAME filtered set',
    d.stats.top_bucket === 'insufficient_funds' && d.stats.top_bucket_pct === 40,
    `${d.stats.top_bucket} ${d.stats.top_bucket_pct}`);
  check('D11 the retry-request count rides each row',
    d.rows.find((x) => x.id === SOFT_ID).retry_requests === 3);

  const narrow = await req('GET', '/failed-payments?days=1');
  check('D11 the window is honoured — a 1-day window drops the 6-day-old decline',
    narrow.j.data.rows.every((x) => x.source_id !== 'uc_dn_stale'),
    JSON.stringify(narrow.j.data.rows.map((x) => x.source_id)));

  const byBucket = await req('GET', '/failed-payments?days=30&bucket=fraud_suspected');
  check('D11 the bucket filter narrows to one row',
    byBucket.j.data.total === 1 && byBucket.j.data.rows[0].source_id === 'uc_dn_hard');

  const empty = await req('GET', '/failed-payments?days=30&bucket=no_such_bucket');
  check('D11 an EMPTY window reports 0%, never NaN%',
    empty.j.data.total === 0 && empty.j.data.stats.top_bucket_pct === 0
    && empty.j.data.stats.at_risk === 0, JSON.stringify(empty.j?.data?.stats));

  const badState = await req('GET', '/failed-payments?state=nonsense');
  check('D11 an unknown state filter is a 400, not a silently empty list',
    badState.status === 400 && badState.j?.error === 'bad_state', `${badState.status}`);
}

// ════════════════════════════════════════════════════════════════════════════
// D12 — detail + the integrator precondition
// ════════════════════════════════════════════════════════════════════════════
{
  const r = await req('GET', `/failed-payments/dq_u_uc_dn_nopm`);
  const d = r.j?.data;
  check('D12 detail returns the queue row, the session and the source charge row',
    r.status === 200 && d.queue.source_id === 'uc_dn_nopm'
    && d.session.id === S_NOPM && d.source_row.id === 'uc_dn_nopm', JSON.stringify(r.j).slice(0, 200));
  check('D12 a session with NO saved payment method is retry_possible:false with the reason named',
    d.retry_possible === false && d.retry_blocked_reason === 'no_saved_payment_method'
    && d.session.has_saved_pm === false, JSON.stringify({ p: d.retry_possible, r: d.retry_blocked_reason }));

  const ok = await req('GET', `/failed-payments/dq_u_uc_dn_soft`);
  check('D12 the exhausted row reports attempts_exhausted, not a generic false',
    ok.j.data.retry_possible === false && ok.j.data.retry_blocked_reason === 'state:exhausted',
    ok.j.data.retry_blocked_reason);
  check('D12 the intent history rides the detail payload',
    ok.j.data.retry_requests.length === 3 && ok.j.data.retry_requests[0].attempt_no === 1);

  const missing = await req('GET', '/failed-payments/dq_u_nope');
  check('D12 an unknown queue id is 404', missing.status === 404);
}

// ════════════════════════════════════════════════════════════════════════════
// D12b — the no-saved-payment-method precondition is enforced ON THE WRITE PATH,
//        not only in the display flag. A scheduled row on a session with no
//        vaulted card must: (1) be retry_possible:false in the LIST so the
//        button is gated; (2) have the server claim REFUSE without advancing
//        attempts. Without both, a click drives attempts→exhausted and writes a
//        dishonest intent row against a card that could never be charged.
// ════════════════════════════════════════════════════════════════════════════
{
  const NOPM_ID = 'dq_u_uc_dn_nopm';
  // Precondition for the test itself: the row is scheduled and has climbed no
  // rungs yet.
  const [before] = await sql`SELECT state, attempts FROM co_dunning_queue WHERE id = ${NOPM_ID}`;
  check('D12b fixture: the no-card row is scheduled at attempt 0',
    before.state === 'scheduled' && before.attempts === 0, JSON.stringify(before));

  // (1) LIST gating — retry_possible / has_saved_pm ride every row.
  const list = await req('GET', '/failed-payments?days=30&state=scheduled');
  const nopmRow = (list.j?.data?.rows || []).find((r) => r.id === NOPM_ID);
  check('D12b the LIST row for a no-card session carries retry_possible:false + has_saved_pm:false',
    nopmRow && nopmRow.retry_possible === false && nopmRow.has_saved_pm === false,
    JSON.stringify(nopmRow && { rp: nopmRow.retry_possible, pm: nopmRow.has_saved_pm }));

  // (2) WRITE-PATH refusal — the claim refuses AND does not increment attempts.
  const retry = await req('POST', `/failed-payments/${NOPM_ID}/retry`);
  check('D12b the server claim REFUSES a no-card retry with the reason named',
    retry.status === 409 && retry.j?.error === 'no_saved_payment_method',
    `${retry.status} ${JSON.stringify(retry.j?.error)}`);
  const [after] = await sql`SELECT state, attempts FROM co_dunning_queue WHERE id = ${NOPM_ID}`;
  check('D12b the refused retry burned NO rung — attempts and state are untouched',
    after.attempts === 0 && after.state === 'scheduled', JSON.stringify(after));
  check('D12b the refused retry wrote NO intent row',
    (await sql`SELECT COUNT(*)::int n FROM co_dunning_retry_requests WHERE queue_id = ${NOPM_ID}`)[0].n === 0);

  // A card that DISAPPEARS between the display flag and the click is still
  // refused — the guard is in the claim WHERE, not a stale read. Strip the PM
  // off the soft row's session, then attempt a (spacing-cleared) retry.
  await sql`UPDATE co_sessions SET payment_method_id = NULL WHERE id = ${S_PAID}`;
  await sql`UPDATE co_dunning_queue SET last_attempt_at = NOW() - interval '2 hours',
    state = 'scheduled', attempts = 0, next_retry_at = NOW() - interval '1 minute'
    WHERE id = 'dq_u_uc_dn_soft'`;
  const stripped = await req('POST', '/failed-payments/dq_u_uc_dn_soft/retry');
  check('D12b a card removed AFTER the row was scheduled is caught by the claim, not a stale read',
    stripped.status === 409 && stripped.j?.error === 'no_saved_payment_method',
    `${stripped.status} ${JSON.stringify(stripped.j?.error)}`);
  check('D12b that refusal also burned no rung',
    (await sql`SELECT attempts FROM co_dunning_queue WHERE id = 'dq_u_uc_dn_soft'`)[0].attempts === 0);
  // Restore the card so later blocks see a coherent world.
  await sql`UPDATE co_sessions SET payment_method_id = 'pm_1' WHERE id = ${S_PAID}`;
}

// ════════════════════════════════════════════════════════════════════════════
// D13 — close
// ════════════════════════════════════════════════════════════════════════════
{
  const a = await req('POST', `/failed-payments/dq_u_uc_dn_nopm/close`, { state: 'recovered', reason: 'buyer paid by link' });
  check('D13 closing as recovered succeeds and clears the schedule',
    a.status === 200 && a.j?.data?.state === 'recovered' && a.j.data.next_retry_at === null,
    `${a.status} ${JSON.stringify(a.j?.data?.state)}`);
  const b = await req('POST', `/failed-payments/dq_u_uc_dn_nopm/close`, { state: 'closed' });
  check('D13 a second close is refused 409 naming the current state',
    b.status === 409 && b.j?.error === 'already_closed' && b.j?.current_state === 'recovered',
    `${b.status} ${JSON.stringify(b.j)}`);
  const retryClosed = await req('POST', `/failed-payments/dq_u_uc_dn_nopm/retry`);
  check('D13 a recovered row can no longer be retried',
    retryClosed.status === 409 && retryClosed.j?.error === 'state:recovered');

  const rescan = await req('POST', '/scan', { days: 30, notify: false });
  const [rec] = await sql`SELECT state FROM co_dunning_queue WHERE id = 'dq_u_uc_dn_nopm'`;
  check('D13 a re-scan does NOT resurrect a recovered row',
    rec.state === 'recovered' && rescan.status === 200, rec.state);

  const stats = await req('GET', '/failed-payments?days=30&state=recovered');
  check('D13 the recovered row is reported under its own state, out of the open list',
    stats.j.data.total === 1 && stats.j.data.rows[0].id === 'dq_u_uc_dn_nopm');
}

// ════════════════════════════════════════════════════════════════════════════
// D14 — malformed input
// ════════════════════════════════════════════════════════════════════════════
{
  const cases = [
    ['GET', '/failed-payments/' + 'x'.repeat(300), undefined, 404],
    ['GET', '/failed-payments/has%20a%20space', undefined, 404],
    ['POST', '/failed-payments/dq_u_nope/retry', {}, 404],
    ['POST', '/failed-payments/dq_u_uc_dn_hard/close', { state: 'nonsense' }, 200],
  ];
  let ok = true; const seen = [];
  for (const [m, p, body, want] of cases) {
    const r = await req(m, p, body);
    seen.push(`${m} ${p.slice(0, 40)}=${r.status}`);
    if (r.status !== want) ok = false;
  }
  check('D14 malformed ids and bodies are refused cleanly, never a 500', ok, seen.join(' | '));

  const huge = await req('GET', '/failed-payments?days=99999&limit=99999');
  check('D14 out-of-range paging is CLAMPED server-side, not passed through',
    huge.status === 200 && huge.j.data.days === 90 && huge.j.data.limit === 200,
    `${huge.j?.data?.days}/${huge.j?.data?.limit}`);

  const scanBad = await req('POST', '/scan', { days: 'lots', limit: -5, notify: false });
  check('D14 a garbage scan body falls back to the defaults rather than throwing',
    scanBad.status === 200 && scanBad.j.data.days === 7, JSON.stringify(scanBad.j?.data?.days));
}

// ════════════════════════════════════════════════════════════════════════════
// D15 — grep-proof
// ════════════════════════════════════════════════════════════════════════════
{
  const svcSrc = readFileSync(resolve(HERE, '../../src/services/dunningService.js'), 'utf8');
  const routeSrc = readFileSync(resolve(HERE, '../../src/routes/dunning.js'), 'utf8');

  const forbiddenImport = /^import[^\n]*from\s+['"][^'"]*(checkoutSettle|checkoutPublic|gatewayWebhooks|moneySweeps|gateways\/)[^'"]*['"]/m;
  check('D15 dunningService imports NO settle/webhook/gateway module',
    !forbiddenImport.test(svcSrc), (svcSrc.match(forbiddenImport) || [''])[0]);
  check('D15 the route file imports NO settle/webhook/gateway module', !forbiddenImport.test(routeSrc));

  const writesMoney = /(INSERT\s+INTO|UPDATE)\s+(co_upsell_charges|co_orders|co_shopify_refunds)\b/i;
  check('D15 this lane never writes co_upsell_charges / co_orders — it only READS the ledger',
    !writesMoney.test(svcSrc) && !writesMoney.test(routeSrc),
    (svcSrc.match(writesMoney) || [''])[0]);

  const writesSession = /UPDATE\s+co_sessions/i;
  check('D15 this lane never writes co_sessions either',
    !writesSession.test(svcSrc) && !writesSession.test(routeSrc),
    (svcSrc.match(writesSession) || [''])[0]);

  const updatesIntent = /UPDATE\s+co_dunning_retry_requests/i;
  check('D15 the intent ledger is append-only in source as well as in behaviour',
    !updatesIntent.test(svcSrc) && !updatesIntent.test(routeSrc));

  check('D15 the money-seam contract is documented for the integrator',
    /MONEY SEAM/.test(routeSrc) && /dun_<queue_id>_<attempt_no>/.test(routeSrc)
    && /MONEY SEAM/.test(svcSrc) && /settleUpsellCharge/.test(routeSrc));
}

// ════════════════════════════════════════════════════════════════════════════
// D16 — CONTRACT ↔ ROUTER LOCK. The metadata `kind` the service header tells the
// integrator to send MUST equal the literal the LIVE webhook router matches, or
// a charger built to the doc sends a kind that matches nothing, falls through to
// the base handler, gets an already_paid ack, and the money is captured while
// the charge row stays declined. This block reads the live router + accept path
// and asserts the documented value is byte-identical to what the router keys on,
// so the two can never silently drift again.
// ════════════════════════════════════════════════════════════════════════════
{
  const svcSrc = readFileSync(resolve(HERE, '../../src/services/dunningService.js'), 'utf8');
  const whSrc = readFileSync(resolve(HERE, '../../src/routes/gatewayWebhooks.js'), 'utf8');
  const cpSrc = readFileSync(resolve(HERE, '../../src/routes/checkoutPublic.js'), 'utf8');

  // Every string literal the router equality-checks a `kind` against. '0' is the
  // base sentinel the router maps to '' before matching; the DISCRIMINATING kind
  // (the one that routes to the upsell settle path) is everything else.
  const routerKinds = new Set(
    [...whSrc.matchAll(/kind[^\n]{0,24}===\s*'([^']+)'/g)].map((m) => m[1])
  );
  const discriminating = [...routerKinds].filter((k) => k !== '0' && k !== '');
  check('D16 the live router discriminates on exactly one kind literal: "upsell"',
    discriminating.length === 1 && discriminating[0] === 'upsell',
    JSON.stringify([...routerKinds]));

  const matched = discriminating[0]; // whatever the router actually keys on
  // The accept path must stamp that same literal for upsells, and '0' for base
  // (checkoutPublic) — the ground truth the charger must mirror.
  check('D16 the accept path stamps kind:"upsell" for upsells and kind:"0" for base',
    new RegExp(`kind: '${matched}'`).test(cpSrc) && /kind: '0'/.test(cpSrc),
    'checkoutPublic stamp not found');

  // THE LOCK: the dunning service header must document the SAME literal the
  // router matches, and must NOT ship the poison values the audit caught.
  check('D16 the service header documents kind:"upsell" — the exact string the router matches',
    new RegExp(`kind: '${matched}'`).test(svcSrc),
    'service header does not document the router-matched kind');
  // The hazard is presenting a poison value AS the kind to send (`kind: 'X'`),
  // not naming it in a cautionary "do NOT send this" note — the header keeps the
  // concrete counter-example on purpose, so we forbid only the dangerous form.
  check('D16 the service header never presents "post_purchase_upsell" as a kind to send',
    !/kind: 'post_purchase_upsell'/.test(svcSrc), 'poison literal presented as kind');
  check('D16 the service header never presents a bare "base" as a kind to send (base is absent/"0")',
    !/kind: 'base'/.test(svcSrc), '"base" presented as kind');
  check('D16 the service header states the router matches ONLY "upsell"',
    /matches nothing|keys STRICTLY on|matches only 'upsell'|matches NOTHING/i.test(svcSrc)
    || /STRICTLY on the literal string 'upsell'/.test(svcSrc),
    'router-only-matches-upsell note missing');
}

// ── cleanup ─────────────────────────────────────────────────────────────────
Object.assign(dun._deps, realDeps);
await cleanup();
await sql`DELETE FROM user_roles WHERE user_id = 'u_dn_a'`;
await sql`DELETE FROM roles WHERE id = 'r_dn_test'`;
await sql`DELETE FROM users WHERE id = 'u_dn_a'`;
await sql.end();
server.close();
console.log(`\nRESULT: ${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
