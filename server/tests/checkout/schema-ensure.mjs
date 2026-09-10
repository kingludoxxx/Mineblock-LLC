// ensureCheckoutTables() must be able to run on an EXISTING database, not only an empty one.
//
// The bug (recorded in wt-lane-ci-fleet/server/tests/QUARANTINE.md): the co_* column lists live inside
// `CREATE TABLE IF NOT EXISTS`, so a table that predates a column never gains it. The very next statement
// (`CREATE INDEX ... ON co_sessions (last_failed_payment_id)`) throws SQLSTATE 42703 and every consumer
// of the money path 500s. R6's mirror image: an ensure that cannot run on an existing database is a bug.
//
// Proves BY EXECUTION:
//   A  a brand-new (empty) database still works, and a second call is a no-op
//   B  a STALE co_sessions (one declared column dropped) makes the CURRENT code throw 42703  <- the RED
//      and, once repaired, gains every column the DDL declares, with no data loss
//   C  every column declared in every CREATE TABLE in the source is present after the ensure (drift guard)
//   D  failure path: a NOT NULL column re-added to a table that already holds rows cannot be marked
//      NOT NULL (23502); the ensure must handle that, not die on it
//
// Run:  CHECKOUT_TEST_DB=postgres://postgres@127.0.0.1:5433/h1_ensure node server/tests/checkout/schema-ensure.mjs
import crypto from 'node:crypto';

import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO = join(HERE, '..', '..', '..');
const SRC = join(REPO, 'server/src/services/checkoutSchema.js');
const DB = process.env.CHECKOUT_TEST_DB || 'postgres://postgres@127.0.0.1:5433/h1_ensure';
const ADMIN = DB.replace(/\/[^/]+$/, '/postgres');
const DBNAME = DB.split('/').pop();

let pass = 0, fail = 0;
const ok = (c, m, x = '') => { if (c) { pass++; console.log('PASS ', m); } else { fail++; console.log('FAIL ', m, x); } };

const { default: postgres } = await import('postgres');

// ---- a clean database for this run -----------------------------------------
{
  const admin = postgres(ADMIN, { ssl: false, max: 1, onnotice: () => {} });
  await admin.unsafe(`DROP DATABASE IF EXISTS ${DBNAME} WITH (FORCE)`);
  await admin.unsafe(`CREATE DATABASE ${DBNAME}`);
  await admin.end();
}

Object.assign(process.env, {
  DATABASE_URL: DB,
  NODE_ENV: 'development',
  MIGRATE_SSL: '0',
  JWT_ACCESS_SECRET: 'test-access-' + crypto.randomBytes(8).toString('hex'),
  JWT_REFRESH_SECRET: 'test-refresh-' + crypto.randomBytes(8).toString('hex'),
});

const sql = postgres(DB, { ssl: false, onnotice: () => {} });
const q = (text, params = []) => sql.unsafe(text, params);

// What the DDL DECLARES is read back off a FRESH database in phase A below, never re-parsed
// out of the source by this test: a second parser is a second thing that can be wrong, and the
// database's own catalogue is the authority on what the CREATE TABLE statements actually declare.
let DECLARED = {};

const columnsOf = async (t) =>
  (await q('SELECT column_name, is_nullable FROM information_schema.columns WHERE table_name=$1 ORDER BY 1', [t]))
    .map((r) => `${r.column_name}:${r.is_nullable}`);
const indexesOf = async (t) =>
  (await q('SELECT indexname FROM pg_indexes WHERE tablename=$1 ORDER BY 1', [t])).map((r) => r.indexname);

// ─────────────────────────────────────────────────────────────────────────────
// A  brand-new database
// ─────────────────────────────────────────────────────────────────────────────
let freshShape = {};
{
  const mod = await import(SRC + '?a=' + Date.now());
  let threw = null;
  try { await mod.ensureCheckoutTables(); } catch (e) { threw = e; }
  ok(!threw, 'A ensureCheckoutTables() on an EMPTY database completes', threw && `${threw.code} ${threw.message}`);

  const tables = (await q(
    `SELECT table_name FROM information_schema.tables
      WHERE table_schema = current_schema() AND table_name LIKE 'co\\_%' ORDER BY 1`,
  )).map((r) => r.table_name);
  ok(tables.length === 9, `A the fresh database carries all 9 co_* tables`, tables.join(','));
  for (const t of tables) {
    freshShape[t] = await columnsOf(t);
    DECLARED[t] = freshShape[t].map((s) => s.split(':')[0]);
  }
  ok((DECLARED.co_sessions || []).includes('last_failed_payment_id'),
    'A the reference shape includes co_sessions.last_failed_payment_id (the column the incident lost)');
  ok(DECLARED.co_sessions.length === 31, `A co_sessions declares 31 columns`, String(DECLARED.co_sessions.length));
  ok((await indexesOf('co_sessions')).includes('idx_co_sessions_last_failed_payment'),
    'A the partial index on last_failed_payment_id exists on the fresh database');

  const mod2 = await import(SRC + '?a2=' + Date.now());
  let threw2 = null;
  try { await mod2.ensureCheckoutTables(); } catch (e) { threw2 = e; }
  ok(!threw2, 'A a SECOND, independent call on the same database is a no-op (no throw)', threw2 && `${threw2.code} ${threw2.message}`);
  const after = await columnsOf('co_sessions');
  ok(JSON.stringify(after) === JSON.stringify(freshShape.co_sessions), 'A the second call changed nothing');
}

// ─────────────────────────────────────────────────────────────────────────────
// B  a STALE database (the shape this Mac actually had) — the RED
// ─────────────────────────────────────────────────────────────────────────────
const STALE_DROPS = {
  co_sessions: ['last_failed_payment_id', 'payment_method_id', 'tracking_net', 'click_vault',
    'import_status', 'import_due_at', 'needs_review_reason', 'vid', 'refunds', 'paid_at'],
  co_orders: ['external_order_id', 'currency'],
  co_upsell_charges: ['declined_by_user', 'line_items', 'currency'],
  co_webhook_events: ['outcome', 'processed_at'],
  co_events: ['data'],
  co_upsells: ['title', 'enabled'],
  co_unmatched_payments: ['reason', 'resolved'],
  co_gateway_configs: ['updated_at'],
  co_shopify_refunds: ['error', 'amount'],
};
{
  // real rows first: the repair must not lose data
  await q(`INSERT INTO co_sessions (id, status, total, currency) VALUES ('sess_keep','paid',89.00,'USD')`);
  await q(`INSERT INTO co_orders (id, session_id, idempotency_key, total) VALUES ('ord_keep','sess_keep','idem_keep',89.00)`);
  for (const [t, cols] of Object.entries(STALE_DROPS)) {
    for (const c of cols) await q(`ALTER TABLE ${t} DROP COLUMN IF EXISTS ${c}`);
  }
  await q(`DROP INDEX IF EXISTS idx_co_sessions_last_failed_payment`);
  await q(`DROP INDEX IF EXISTS idx_co_sessions_paid_at`);

  // control: the stale state is real
  let ctl = null;
  try { await q('SELECT last_failed_payment_id FROM co_sessions LIMIT 1'); } catch (e) { ctl = e; }
  ok(ctl && ctl.code === '42703', 'B CONTROL the stale co_sessions really is missing the column (42703)', ctl && ctl.code);

  const mod = await import(SRC + '?b=' + Date.now());
  let threw = null;
  try { await mod.ensureCheckoutTables(); } catch (e) { threw = e; }
  ok(!threw, 'B ensureCheckoutTables() REPAIRS a stale database instead of throwing 42703',
    threw && `${threw.code} ${threw.message}`);

  if (!threw) {
    const missing = [];
    for (const [t, cols] of Object.entries(DECLARED)) {
      const have = await columnsOf(t);
      for (const c of cols) if (!have.some((s) => s.startsWith(c + ':'))) missing.push(`${t}.${c}`);
    }
    ok(missing.length === 0, 'B every declared column is back after the repair', missing.join(','));
    ok((await indexesOf('co_sessions')).includes('idx_co_sessions_last_failed_payment'),
      'B the index that used to throw 42703 exists again');
    ok((await indexesOf('co_sessions')).includes('idx_co_sessions_paid_at'), 'B the paid_at partial index is back');

    const consumer = await q(`SELECT last_failed_payment_id, tracking_net, refunds, paid_at FROM co_sessions WHERE id='sess_keep'`);
    ok(consumer.length === 1, 'B the consumer query that used to 42703 now runs');
    ok(String(consumer[0].refunds) === '[]' || JSON.stringify(consumer[0].refunds) === '[]',
      'B a re-added NOT NULL DEFAULT column is backfilled with its default, not left NULL', JSON.stringify(consumer[0].refunds));

    const kept = await q(`SELECT id, status, total FROM co_sessions WHERE id='sess_keep'`);
    ok(kept.length === 1 && String(kept[0].total) === '89.00', 'B NO DATA LOSS: the pre-existing row survived the repair', JSON.stringify(kept));
    const keptOrd = await q(`SELECT id, idempotency_key FROM co_orders WHERE id='ord_keep'`);
    ok(keptOrd.length === 1, 'B NO DATA LOSS: the pre-existing order survived');

    // money invariant: the unique claim slots are still enforced after a repair
    let dup = null;
    try { await q(`INSERT INTO co_orders (id, session_id, idempotency_key, total) VALUES ('ord_dup','sess_keep','idem_keep',1)`); }
    catch (e) { dup = e; }
    ok(dup && dup.code === '23505', 'B co_orders.idempotency_key is still UNIQUE after the repair (exactly-once holds)', dup && dup.code);

    const mod2 = await import(SRC + '?b2=' + Date.now());
    let threw2 = null;
    try { await mod2.ensureCheckoutTables(); } catch (e) { threw2 = e; }
    ok(!threw2, 'B a second call on the REPAIRED database is a no-op', threw2 && `${threw2.code} ${threw2.message}`);
    const shapeNow = await columnsOf('co_sessions');
    ok(JSON.stringify(shapeNow) === JSON.stringify(freshShape.co_sessions),
      'B the repaired shape equals the FRESH shape, column for column and nullability for nullability',
      JSON.stringify(shapeNow.filter((s) => !freshShape.co_sessions.includes(s))));
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// D  failure path — a NOT NULL column that cannot be marked NOT NULL
// ─────────────────────────────────────────────────────────────────────────────
{
  await q(`INSERT INTO co_events (session_id, kind) VALUES ('sess_keep','created')`);
  await q(`ALTER TABLE co_events DROP COLUMN IF EXISTS kind`);

  // the naked repair a careless fix would write, shown FAILING
  await q(`ALTER TABLE co_events ADD COLUMN IF NOT EXISTS kind TEXT`);
  let naked = null;
  try { await q(`ALTER TABLE co_events ALTER COLUMN kind SET NOT NULL`); } catch (e) { naked = e; }
  ok(naked && naked.code === '23502',
    'D CONTROL a blind SET NOT NULL on a table that already holds rows throws 23502', naked && naked.code);
  await q(`ALTER TABLE co_events DROP COLUMN IF EXISTS kind`);

  const mod = await import(SRC + '?d=' + Date.now());
  let threw = null;
  try { await mod.ensureCheckoutTables(); } catch (e) { threw = e; }
  ok(!threw, 'D ensureCheckoutTables() HANDLES that case instead of dying on it', threw && `${threw.code} ${threw.message}`);
  const have = await columnsOf('co_events');
  ok(have.some((s) => s.startsWith('kind:')), 'D the column is present (consumers no longer 42703)', have.join(','));

  // and once the offending rows are gone, the ensure completes the job
  await q(`DELETE FROM co_events WHERE kind IS NULL`);
  const mod2 = await import(SRC + '?d2=' + Date.now());
  await mod2.ensureCheckoutTables();
  const nn = await q(`SELECT is_nullable FROM information_schema.columns WHERE table_name='co_events' AND column_name='kind'`);
  ok(nn[0].is_nullable === 'NO', 'D once the NULL rows are gone, a later ensure finishes the job and restores NOT NULL', JSON.stringify(nn));
}

// ─────────────────────────────────────────────────────────────────────────────
// C  drift guard — the fix must cover EVERY declared column, not the seven from the incident
// ─────────────────────────────────────────────────────────────────────────────
// Behavioural, not textual: DROP every declared column the database will let go of
// (a primary-key column is not droppable and is not this fix's job), then ensure.
{
  await q('DROP SCHEMA public CASCADE; CREATE SCHEMA public;');
  const mod0 = await import(SRC + '?c0=' + Date.now());
  await mod0.ensureCheckoutTables();

  const dropped = [];
  const undroppable = [];
  for (const [t, cols] of Object.entries(DECLARED)) {
    for (const c of cols) {
      try { await q(`ALTER TABLE ${t} DROP COLUMN ${c}`); dropped.push(`${t}.${c}`); }
      catch (e) { undroppable.push(`${t}.${c}:${e.code}`); }
    }
  }
  ok(dropped.length > 40, `C dropped ${dropped.length} of the declared columns to build the worst stale shape`,
    `undroppable (primary keys): ${undroppable.join(',')}`);

  const mod = await import(SRC + '?c=' + Date.now());
  let threw = null;
  try { await mod.ensureCheckoutTables(); } catch (e) { threw = e; }
  ok(!threw, 'C ensureCheckoutTables() repairs a table stripped to its primary key', threw && `${threw.code} ${threw.message}`);

  const missing = [];
  for (const [t, cols] of Object.entries(DECLARED)) {
    const have = await columnsOf(t);
    for (const c of cols) if (!have.some((s) => s.startsWith(c + ':'))) missing.push(`${t}.${c}`);
  }
  ok(missing.length === 0, 'C EVERY declared column is restored, not just the seven from the incident', missing.join(','));

  // Everything is restored EXCEPT the primary key: dropping a PK column drops the constraint with
  // it, and inventing a primary key on rows that are already there is not a repair an ensure may
  // make (it is a migration's call). Stated here as a boundary, not discovered later as a surprise.
  const shape = await columnsOf('co_sessions');
  const diff = shape.filter((s) => !freshShape.co_sessions.includes(s));
  ok(diff.length === 1 && diff[0] === 'id:YES',
    'C the fully-stripped table matches the fresh shape except the primary-key column, which stays nullable (documented limit)',
    JSON.stringify(diff));
  const pk = await q(
    `SELECT conname FROM pg_constraint WHERE conrelid='co_sessions'::regclass AND contype='p'`);
  ok(pk.length === 0, 'C CONTROL the primary key really is gone after the strip, and the ensure does not fake one', JSON.stringify(pk));
  const nonKey = shape.filter((s) => !s.startsWith('id:'));
  const freshNonKey = freshShape.co_sessions.filter((s) => !s.startsWith('id:'));
  ok(JSON.stringify(nonKey) === JSON.stringify(freshNonKey),
    'C every NON-KEY column is restored to the exact fresh shape, nullability included',
    JSON.stringify(nonKey.filter((s) => !freshNonKey.includes(s))));

  const idx = await indexesOf('co_sessions');
  const wantIdx = ['idx_co_sessions_status', 'idx_co_sessions_created', 'idx_co_sessions_gateway_session',
    'idx_co_sessions_last_failed_payment', 'idx_co_sessions_paid_at'];
  ok(wantIdx.every((i) => idx.includes(i)), 'C every co_sessions index is back', idx.join(','));

  // the upsell TRIPLE, the invariant this file's header calls out by name
  await q(`INSERT INTO co_upsell_charges (id, session_id, offer_id, charge_id, status) VALUES ('u1','s','o','decline','declined')`);
  let dup = null;
  try { await q(`INSERT INTO co_upsell_charges (id, session_id, offer_id, charge_id, status) VALUES ('u2','s','o','decline','declined')`); }
  catch (e) { dup = e; }
  ok(dup && dup.code === '23505', 'C UNIQUE (session_id, offer_id, charge_id) survives a full repair', dup && dup.code);
}

console.log(`\n${pass} passed, ${fail} failed`);
await sql.end();
process.exit(fail === 0 ? 0 : 1);
