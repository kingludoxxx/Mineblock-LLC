// C3 — `_store_identity`: the database's own store label, and the runner's gate.
//
// The hole this closes (REVIEW-MERGE-1 P1-3): STORE_CODE was shape-checked only,
// so `STORE_CODE=PL npm run migrate` against an MB database exited 0 with no
// complaint — and on Puure's first run a copy-pasted `STORE_CODE=MB` would have
// labelled every Puure row as Mineblock's and the deploy would have succeeded.
//
// Most cases run the REAL `server/migrations/run.js` as a child process (the way
// Render's pre-deploy command does) against a migrations dir holding only
// 127_store_identity.sql: this file tests the runner's identity contract, not the
// other 110 migrations, and a full apply per case would cost minutes.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { freshDb, withClient, connectionString, REPO_ROOT, MIGRATIONS_DIR } from './_db.mjs';
import {
  assertIdentityMatches, assertTypedStoreName, resolveStoreName, readStoreIdentity,
  storeCodeDefaults, resolveRunCommit, RUNNER_VERSION, MigrationError,
} from '../../migrations/run.js';

const RUN_JS = path.join(MIGRATIONS_DIR, 'run.js');
const IDENTITY_SQL = '127_store_identity.sql';

// A migrations directory holding ONLY 127 + its manifest. run.js validates the
// manifest against the directory, so both must agree.
function identityOnlyDir() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'c3-identity-'));
  fs.copyFileSync(path.join(MIGRATIONS_DIR, IDENTITY_SQL), path.join(dir, IDENTITY_SQL));
  fs.writeFileSync(path.join(dir, 'order.json'), JSON.stringify({ order: [IDENTITY_SQL] }, null, 2));
  return dir;
}
const ONLY_127 = identityOnlyDir();

function runMigrate(dbname, args = [], env = {}) {
  const res = spawnSync(process.execPath, [RUN_JS, '--dir', ONLY_127, ...args], {
    cwd: REPO_ROOT,
    // env is REPLACED, not merged: a STORE_CODE / BRAND_NAME left over from the
    // shell would decide these tests instead of the case deciding them.
    env: { PATH: process.env.PATH, HOME: process.env.HOME, DATABASE_URL: connectionString(dbname), MIGRATE_SSL: '0', ...env },
    encoding: 'utf8',
  });
  const out = `${res.stdout || ''}${res.stderr || ''}`;
  if (process.env.LANE_DEBUG) process.stderr.write(`\n--- migrate ${args.join(' ')} on ${dbname} exit=${res.status} ---\n${out}`);
  return { code: res.status, out };
}

const identityRow = (db) => withClient(db, async (c) => (await readStoreIdentity(c)).row);
const ledgerCount = (db) => withClient(db, async (c) => {
  const r = await c.query(`SELECT count(*)::int AS n FROM _migrations`);
  return r.rows[0].n;
});

// ── 1. Registration ─────────────────────────────────────────────────────────

test('C3.1: 127_store_identity.sql exists, is registered in order.json AFTER 126, and is not in the lane-C day-1 manifest', () => {
  assert.ok(fs.existsSync(path.join(MIGRATIONS_DIR, IDENTITY_SQL)), `${IDENTITY_SQL} is not on disk`);
  const order = JSON.parse(fs.readFileSync(path.join(MIGRATIONS_DIR, 'order.json'), 'utf8')).order;
  const i = order.indexOf(IDENTITY_SQL);
  assert.ok(i >= 0, `${IDENTITY_SQL} is not listed in order.json — run.js would REFUSE every run`);
  assert.equal(new Set(order).size, order.length, 'duplicate entry in order.json');
  for (const earlier of order.slice(0, i)) {
    const n = Number(earlier.slice(0, 3));
    if (Number.isFinite(n) && n >= 120) assert.ok(n < 127, `${earlier} is a HUB migration listed before 127 but is not lower-numbered`);
  }
  // a1-empty-db.test.mjs asserts Lane C's day-1 files are CONTIGUOUS in order.json.
  // 127 sits after Lane E's 126, so it must NOT join that set.
  const laneC = JSON.parse(fs.readFileSync(path.join(MIGRATIONS_DIR, 'order.lane-c.json'), 'utf8')).migrations;
  assert.ok(!laneC.includes(IDENTITY_SQL), '127 must stay out of order.lane-c.json (it is not part of Lane C day 1)');
  // The migration itself carries no store literal (R15).
  const sql = fs.readFileSync(path.join(MIGRATIONS_DIR, IDENTITY_SQL), 'utf8');
  const inCode = sql.split('\n').filter((l) => !l.trim().startsWith('--')).join('\n');
  assert.ok(!/'(MB|PL|P1)'/.test(inCode), 'no store literal may appear in the migration');
});

// ── 2. The refusal, as a unit ───────────────────────────────────────────────

test('C3.2: assertIdentityMatches prints the exact mismatch line, passes on a match, and is a no-op with no row', () => {
  const row = { store_code: 'MB', first_run_at: '2026-09-10T00:00:00.000Z', first_run_commit: 'abc1234', runner_version: RUNNER_VERSION };
  assert.throws(() => assertIdentityMatches({ table: true, row }, 'PL'), (err) => {
    assert.ok(err instanceof MigrationError);
    assert.match(err.message, /^STORE IDENTITY MISMATCH: database is MB, STORE_CODE is PL$/m);
    assert.match(err.message, /REFUSING to run — nothing was written/);
    return true;
  });
  assert.doesNotThrow(() => assertIdentityMatches({ table: true, row }, 'MB'));
  assert.doesNotThrow(() => assertIdentityMatches({ table: false, row: null }, 'PL'));
  assert.doesNotThrow(() => assertIdentityMatches({ table: true, row: null }, 'PL'));
});

test('C3.3: the typed-name gate reads STORE_NAME, else BRAND_NAME, and refuses everything else', () => {
  assert.equal(resolveStoreName({}), null);
  assert.deepEqual(resolveStoreName({ BRAND_NAME: 'Puure' }), { key: 'BRAND_NAME', name: 'Puure' });
  assert.deepEqual(resolveStoreName({ STORE_NAME: 'Puure Ltd', BRAND_NAME: 'Puure' }), { key: 'STORE_NAME', name: 'Puure Ltd' });
  assert.throws(() => assertTypedStoreName('Puure', {}), /no configured store display name/);
  assert.throws(() => assertTypedStoreName(undefined, { BRAND_NAME: 'Puure' }), /--i-typed-the-store-name=<Name> is required/);
  assert.throws(() => assertTypedStoreName('', { BRAND_NAME: 'Puure' }), /is required/);
  assert.throws(() => assertTypedStoreName('puure', { BRAND_NAME: 'Puure' }), /does not match BRAND_NAME/);
  assert.throws(() => assertTypedStoreName('Mineblock', { BRAND_NAME: 'Puure' }), /does not match BRAND_NAME/);
  assert.deepEqual(assertTypedStoreName(' Puure ', { BRAND_NAME: 'Puure' }), { key: 'BRAND_NAME', name: 'Puure' });
});

test('C3.4: the run commit comes from RENDER_GIT_COMMIT, else the checkout, else "unknown"', () => {
  assert.equal(resolveRunCommit({ RENDER_GIT_COMMIT: 'deadbeef' }), 'deadbeef');
  assert.match(resolveRunCommit({}), /^[0-9a-f]{7,40}$/);
  assert.equal(resolveRunCommit({}, os.tmpdir()), 'unknown');
});

// ── 3. First run, second run, wrong code ────────────────────────────────────

test('C3.5: the first run records the identity; the second reports it; a different STORE_CODE is refused with zero writes', async () => {
  const db = await freshDb('lane_store_code_c3_first');
  const first = runMigrate(db, [], { STORE_CODE: 'MB' });
  assert.equal(first.code, 0, first.out);
  assert.match(first.out, /database identity recorded: MB \(first run \d{4}-\d\d-\d\dT/);

  const row = await identityRow(db);
  assert.equal(row.store_code, 'MB');
  assert.ok(row.first_run_at instanceof Date && Number.isFinite(row.first_run_at.getTime()), 'first_run_at must be a timestamp');
  assert.ok(Date.now() - row.first_run_at.getTime() < 5 * 60 * 1000, 'first_run_at must be this run');
  assert.match(row.first_run_commit, /^[0-9a-f]{7,40}$/, 'first_run_commit must be the commit that ran');
  assert.equal(row.runner_version, RUNNER_VERSION);

  const second = runMigrate(db, [], { STORE_CODE: 'MB' });
  assert.equal(second.code, 0, second.out);
  assert.match(second.out, /database identity: MB \(first run /);
  assert.match(second.out, /All migrations are up to date\./);
  const afterSecond = await identityRow(db);
  assert.deepEqual(afterSecond.first_run_at, row.first_run_at, 'a later run must not move first_run_at');

  const ledgerBefore = await ledgerCount(db);
  const wrong = runMigrate(db, [], { STORE_CODE: 'PL' });
  assert.equal(wrong.code, 1, wrong.out);
  assert.match(wrong.out, /^Migration failed: STORE IDENTITY MISMATCH: database is MB, STORE_CODE is PL$/m);
  assert.deepEqual(await identityRow(db), row, 'the identity row must be untouched');
  assert.equal(await ledgerCount(db), ledgerBefore, 'the ledger must be untouched');

  // RENDER_GIT_COMMIT is what Render actually supplies.
  const db2 = await freshDb('lane_store_code_c3_first_render');
  assert.equal(runMigrate(db2, [], { STORE_CODE: 'PL', RENDER_GIT_COMMIT: 'f4367c5' }).code, 0);
  assert.equal((await identityRow(db2)).first_run_commit, 'f4367c5');
});

test('C3.6: the mismatch refusal happens before the ledger is even created (zero writes on a bare database)', async () => {
  const db = await freshDb('lane_store_code_c3_prelock');
  // A database that carries an identity but has never had this runner's ledger:
  // the refusal must come before ensureLedger's CREATE TABLE.
  await withClient(db, async (c) => {
    await c.query(fs.readFileSync(path.join(MIGRATIONS_DIR, IDENTITY_SQL), 'utf8'));
    await c.query(`INSERT INTO _store_identity (id, store_code) VALUES (1, 'MB')`);
  });
  const r = runMigrate(db, [], { STORE_CODE: 'PL' });
  assert.equal(r.code, 1, r.out);
  assert.match(r.out, /STORE IDENTITY MISMATCH: database is MB, STORE_CODE is PL/);
  const ledger = await withClient(db, async (c) => (await c.query(`SELECT to_regclass('public._migrations') AS t`)).rows[0].t);
  assert.equal(ledger, null, '_migrations must not exist: the run wrote nothing at all');
});

// ── 4. Edges: no table, malformed row, two rows ─────────────────────────────

test('C3.7: a database with no _store_identity is "no identity yet"; a malformed row REFUSES', async () => {
  const db = await freshDb('lane_store_code_c3_edges');
  const dry = runMigrate(db, ['--dry-run', '--allow-pending'], { STORE_CODE: 'MB' });
  assert.equal(dry.code, 0, dry.out);
  assert.match(dry.out, /no identity yet \(_store_identity does not exist here; migration 127 will create it\), this run will record MB/);

  assert.equal(runMigrate(db, [], { STORE_CODE: 'MB' }).code, 0);

  for (const bad of ['mb', 'mineblock', '', '   ', 'TOOLONGCODE']) {
    await withClient(db, (c) => c.query('UPDATE _store_identity SET store_code = $1 WHERE id = 1', [bad]));
    const r = runMigrate(db, [], { STORE_CODE: 'MB' });
    assert.equal(r.code, 1, `store_code ${JSON.stringify(bad)} should have been refused:\n${r.out}`);
    assert.match(r.out, /MALFORMED STORE IDENTITY/);
    // The dry run refuses too — a preflight that stays quiet is worse than none.
    const d = runMigrate(db, ['--dry-run'], { STORE_CODE: 'MB' });
    assert.equal(d.code, 1, d.out);
    assert.match(d.out, /MALFORMED STORE IDENTITY/);
  }

  // Two rows (an identity table from an older dump, without the id = 1 CHECK).
  await withClient(db, async (c) => {
    await c.query(`UPDATE _store_identity SET store_code = 'MB' WHERE id = 1`);
    await c.query('ALTER TABLE _store_identity DROP CONSTRAINT _store_identity_id_check');
    await c.query(`INSERT INTO _store_identity (id, store_code) VALUES (2, 'PL')`);
  });
  const two = runMigrate(db, [], { STORE_CODE: 'MB' });
  assert.equal(two.code, 1, two.out);
  assert.match(two.out, /MALFORMED STORE IDENTITY: _store_identity holds 2 rows \("MB", "PL"\)/);
});

test('C3.8: the single-row shape is structural — a second row is rejected by the table itself', async () => {
  const db = await freshDb('lane_store_code_c3_singlerow');
  assert.equal(runMigrate(db, [], { STORE_CODE: 'MB' }).code, 0);
  await withClient(db, async (c) => {
    await assert.rejects(c.query(`INSERT INTO _store_identity (id, store_code) VALUES (2, 'PL')`), /violates check constraint/);
    await assert.rejects(c.query(`INSERT INTO _store_identity (store_code) VALUES ('PL')`), /duplicate key value/);
  });
});

// ── 5. The deliberate relabel ───────────────────────────────────────────────

test('C3.9: --relabel-identity needs the typed display name, is never available on a dry run, and prints old -> new', async () => {
  const db = await freshDb('lane_store_code_c3_relabel');
  assert.equal(runMigrate(db, [], { STORE_CODE: 'MB' }).code, 0);
  const before = await identityRow(db);

  const dry = runMigrate(db, ['--dry-run', '--relabel-identity', '--i-typed-the-store-name=Puure'], { STORE_CODE: 'PL', BRAND_NAME: 'Puure' });
  assert.equal(dry.code, 1, dry.out);
  assert.match(dry.out, /--relabel-identity is not available on a dry run/);

  for (const [args, env, re] of [
    [['--relabel-identity'], { STORE_CODE: 'PL', BRAND_NAME: 'Puure' }, /--i-typed-the-store-name=<Name> is required/],
    [['--relabel-identity', '--i-typed-the-store-name=puure'], { STORE_CODE: 'PL', BRAND_NAME: 'Puure' }, /does not match BRAND_NAME/],
    [['--relabel-identity', '--i-typed-the-store-name=Mineblock'], { STORE_CODE: 'PL', BRAND_NAME: 'Puure' }, /does not match BRAND_NAME/],
    [['--relabel-identity', '--i-typed-the-store-name=Puure'], { STORE_CODE: 'PL' }, /no configured store display name/],
    [['--i-typed-the-store-name=Puure'], { STORE_CODE: 'PL', BRAND_NAME: 'Puure' }, /only meaningful with --relabel-identity/],
  ]) {
    const r = runMigrate(db, args, env);
    assert.equal(r.code, 1, `${args.join(' ')} should have been refused:\n${r.out}`);
    assert.match(r.out, re);
    assert.deepEqual(await identityRow(db), before, `${args.join(' ')} must write nothing`);
  }

  const ok = runMigrate(db, ['--relabel-identity', '--i-typed-the-store-name=Puure'], { STORE_CODE: 'PL', BRAND_NAME: 'Puure' });
  assert.equal(ok.code, 0, ok.out);
  assert.match(ok.out, /RELABELLED database identity \(typed BRAND_NAME "Puure"\): MB \(first run .*\)  ->  PL \(first run /);
  const after = await identityRow(db);
  assert.equal(after.store_code, 'PL');
  assert.deepEqual(after.first_run_at, before.first_run_at, 'first_run_at is the database\'s first run, not the relabel');

  // And the ordinary run that used to be refused now passes.
  const plain = runMigrate(db, [], { STORE_CODE: 'PL' });
  assert.equal(plain.code, 0, plain.out);
  assert.match(plain.out, /database identity: PL/);
  assert.equal(runMigrate(db, [], { STORE_CODE: 'MB' }).code, 1, 'MB is now the refused one');
});

test('C3.10: --relabel-identity on a database with no identity is refused, not silently helpful', async () => {
  const db = await freshDb('lane_store_code_c3_relabel_empty');
  const noTable = runMigrate(db, ['--relabel-identity', '--i-typed-the-store-name=Puure'], { STORE_CODE: 'PL', BRAND_NAME: 'Puure' });
  assert.equal(noTable.code, 1, noTable.out);
  assert.match(noTable.out, /_store_identity does not exist on this database/);

  assert.equal(runMigrate(db, [], { STORE_CODE: 'PL' }).code, 0);
  await withClient(db, (c) => c.query('DELETE FROM _store_identity'));
  const emptyTable = runMigrate(db, ['--relabel-identity', '--i-typed-the-store-name=Puure'], { STORE_CODE: 'PL', BRAND_NAME: 'Puure' });
  assert.equal(emptyTable.code, 1, emptyTable.out);
  assert.match(emptyTable.out, /_store_identity is empty/);
});

// ── 6. The column-default report (the Puure bracket's check, in the runner) ──

test('C3.11: the post-run report counts this store\'s store_code defaults and EXITS 1 on any other store\'s', async () => {
  const db = await freshDb('lane_store_code_c3_defaults');
  await withClient(db, async (c) => {
    await c.query(`CREATE TABLE mine_a (id serial primary key, store_code TEXT NOT NULL DEFAULT 'MB')`);
    await c.query(`CREATE TABLE mine_b (id serial primary key, store_code TEXT NOT NULL DEFAULT 'MB')`);
    // Not a store literal: neither counted nor an error.
    await c.query(`CREATE TABLE no_default (id serial primary key, store_code TEXT)`);
  });
  const green = runMigrate(db, [], { STORE_CODE: 'MB' });
  assert.equal(green.code, 0, green.out);
  assert.match(green.out, /^store_code column defaults — MB: 2, other stores: 0$/m);

  await withClient(db, (c) => c.query(`CREATE TABLE puure_leftovers (id serial primary key, store_code TEXT NOT NULL DEFAULT 'PL')`));
  const red = runMigrate(db, [], { STORE_CODE: 'MB' });
  assert.equal(red.code, 1, red.out);
  assert.match(red.out, /^store_code column defaults — MB: 2, other stores: 1$/m);
  assert.match(red.out, /MIXED STORE LABELS: 1 store_code column default\(s\) carry another store's code on a MB database/);
  assert.match(red.out, /PL: puure_leftovers\.store_code/);

  const byCode = await withClient(db, (c) => storeCodeDefaults(c));
  assert.deepEqual([...byCode.keys()].sort(), ['MB', 'PL']);
  assert.deepEqual(byCode.get('PL'), ['puure_leftovers.store_code']);
});

// ── 7. The dry run as a preflight gate ──────────────────────────────────────

test('C3.12: the dry run reports the identity and exits 1 on a mismatch, writing nothing', async () => {
  const db = await freshDb('lane_store_code_c3_dry');
  assert.equal(runMigrate(db, [], { STORE_CODE: 'MB' }).code, 0);
  const before = await identityRow(db);

  const same = runMigrate(db, ['--dry-run'], { STORE_CODE: 'MB' });
  assert.equal(same.code, 0, same.out);
  assert.match(same.out, /database identity: MB \(first run /);

  const diff = runMigrate(db, ['--dry-run'], { STORE_CODE: 'PL' });
  assert.equal(diff.code, 1, diff.out);
  assert.match(diff.out, /STORE IDENTITY MISMATCH: database is MB, STORE_CODE is PL — a real run would REFUSE and write nothing\./);
  assert.deepEqual(await identityRow(db), before);

  // Even the pre-apply rehearsal (--allow-pending) fails on the wrong database.
  const rehearse = runMigrate(db, ['--dry-run', '--allow-pending'], { STORE_CODE: 'PL' });
  assert.equal(rehearse.code, 1, rehearse.out);

  // With no STORE_CODE at all the dry run still reports the identity (and says
  // the real run would refuse), because it is the preflight for exactly that.
  const noCode = runMigrate(db, ['--dry-run'], {});
  assert.equal(noCode.code, 0, noCode.out);
  assert.match(noCode.out, /STORE_CODE: STORE_CODE is not set/);
  assert.match(noCode.out, /database identity: MB \(first run /);
});

// ── 8. --mark-applied is a write path too ───────────────────────────────────

test('C3.13: --mark-applied refuses on a mismatched identity and works on a matching one', async () => {
  const db = await freshDb('lane_store_code_c3_mark');
  assert.equal(runMigrate(db, [], { STORE_CODE: 'MB' }).code, 0);
  await withClient(db, (c) => c.query('DELETE FROM _migrations'));

  const wrong = runMigrate(db, ['--mark-applied', IDENTITY_SQL], { STORE_CODE: 'PL' });
  assert.equal(wrong.code, 1, wrong.out);
  assert.match(wrong.out, /STORE IDENTITY MISMATCH: database is MB, STORE_CODE is PL/);
  assert.equal(await ledgerCount(db), 0, 'nothing may be marked on the wrong database');

  const right = runMigrate(db, ['--mark-applied', IDENTITY_SQL], { STORE_CODE: 'MB' });
  assert.equal(right.code, 0, right.out);
  assert.equal(await ledgerCount(db), 1);
});
