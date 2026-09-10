// A1 — Lane C migrations apply on an EMPTY database (after the post-099
// fixture), are idempotent, honour app.store_code, and refuse a bad code.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import fs from 'node:fs';
import { freshDb, withClient, applySqlFiles, laneMigrationFiles, stagedMigrationFiles, columnInfo, MIGRATIONS_DIR, TEST_STORE_CODE } from './_db.mjs';
import { loadEmptyFixture } from './_fixture-empty.mjs';

// Every table the brief names must carry store_code; the value says whether
// product_code must be present ('product': identifiable, or natively there)
// or must NOT be added ('store': no product identifiable per row).
const EXPECT = {
  image_store: 'product', clickup_brief_resolutions: 'product', brief_number_counter: 'product', product_im_counters: 'product',
  statics_im_counter: 'product', crm_orders: 'store', shopify_orders_cache: 'store', spy_creatives: 'product',
  brief_pipeline_winners: 'product', brief_pipeline_generated: 'product', brief_generation_jobs: 'product',
  brief_copy_sets: 'product', brief_launches: 'product', brief_pipeline_references: 'product', video_ads: 'product',
  ad_batches: 'product', statics_queue: 'product', statics_generation_events: 'product', statics_composer_imports: 'product',
  launch_templates: 'product', product_profiles: 'product',
};

test('A1: lane migration files exist, are numbered 123+, are registered in order.json, and staged/ is not auto-run', () => {
  const files = laneMigrationFiles().map((f) => path.basename(f));
  assert.ok(files.length >= 1, 'expected at least one 123+ migration');
  for (const f of files) assert.match(f, /^12[3-9]_|^1[3-9]\d_/);
  // run.js / server.js read only *.sql directly under server/migrations —
  // a file under staged/ must never be picked up by the boot-time runner.
  const rootSql = fs.readdirSync(MIGRATIONS_DIR).filter((f) => f.endsWith('.sql'));
  for (const s of stagedMigrationFiles()) assert.ok(!rootSql.includes(path.basename(s)), `${s} leaked into the root`);
  assert.ok(fs.existsSync(path.join(MIGRATIONS_DIR, 'order.lane-c.json')), 'order.lane-c.json missing');
  const order = JSON.parse(fs.readFileSync(path.join(MIGRATIONS_DIR, 'order.lane-c.json'), 'utf8'));
  for (const f of files) assert.ok(order.migrations.includes(f), `${f} not listed in order.lane-c.json`);
  // Review F4: the lane's files must be listed in the REAL manifest run.js reads,
  // at the END, after Lane A's 120/121/122 (docs/MIGRATIONS.md §4).
  const runOrder = JSON.parse(fs.readFileSync(path.join(MIGRATIONS_DIR, 'order.json'), 'utf8')).order;
  for (const f of files) assert.ok(runOrder.includes(f), `${f} not listed in order.json (run.js would refuse the run)`);
  const first = Math.min(...files.map((f) => runOrder.indexOf(f)));
  for (const a of ['120_create_product_profiles.sql', '121_creative_analysis_route_columns.sql', '122_creative_analysis_fresh_shape.sql']) {
    assert.ok(runOrder.indexOf(a) < first, `${a} (Lane A) must run before Lane C's files`);
  }
  assert.equal(runOrder.length - files.length, runOrder.indexOf(files[0]), 'Lane C files must be the LAST entries of order.json');
  // No duplicate entries and every .sql on disk is listed (run.js refuses otherwise).
  assert.equal(new Set(runOrder).size, runOrder.length, 'duplicate entry in order.json');
  for (const f of rootSql) assert.ok(runOrder.includes(f), `${f} on disk but not in order.json`);
});

// The store code the runner would pass. Read from one place, asserted from the
// same place (review F9): a hard-coded 'MB'::text would silently flip the day
// the test environment carries a STORE_CODE.
// (imported from _db.mjs, the single place the suite's store code is decided)

test('A1: migrations apply on an empty DB; every listed table gets store_code (and product_code where identifiable)', async () => {
  const db = await freshDb('lane_store_code_a1');
  await withClient(db, async (c) => {
    await loadEmptyFixture(c);
    // one lazily-created §1b table present, the rest absent: 124 must tag the
    // present one and skip the others without failing (R6 empty-DB rule)
    await c.query('CREATE TABLE co_sessions (id TEXT PRIMARY KEY)');
    const applied = await applySqlFiles(c, laneMigrationFiles(), { settings: { 'app.store_code': TEST_STORE_CODE } });
    assert.ok(applied.length >= 2, 'expected 123 and 124');
    assert.ok(await columnInfo(c, 'co_sessions', 'store_code'), 'co_sessions (present lazy table) should be tagged by 124');
    assert.equal((await c.query(`SELECT to_regclass('crm_order_comments') AS t`)).rows[0].t, null, '124 must not create absent lazy tables');
    for (const [table, kind] of Object.entries(EXPECT)) {
      const sc = await columnInfo(c, table, 'store_code');
      assert.ok(sc, `${table}.store_code missing`);
      assert.equal(sc.is_nullable, 'NO', `${table}.store_code must be NOT NULL`);
      assert.equal(sc.column_default, `'${TEST_STORE_CODE}'::text`, `${table}.store_code default must follow app.store_code`);
      const pc = await columnInfo(c, table, 'product_code');
      if (kind === 'product') { assert.ok(pc, `${table}.product_code missing`); assert.equal(pc.data_type, 'text'); }
      else assert.equal(pc, null, `${table}.product_code must not be added (no product identifiable)`);
    }
    // Counters keyed by product code: a unique index on product_code exists —
    // except product_im_counters, which is keyed PER PRODUCT and where a code
    // legitimately covers several products (review F2).
    for (const t of ['brief_number_counter', 'statics_im_counter']) {
      const r = await c.query(`SELECT indexdef FROM pg_indexes WHERE tablename=$1 AND indexdef ILIKE '%UNIQUE%' AND indexdef ILIKE '%(product_code)%'`, [t]);
      assert.equal(r.rowCount, 1, `${t}: expected exactly one unique index on (product_code)`);
    }
    const imBare = await c.query(`SELECT indexdef FROM pg_indexes WHERE tablename='product_im_counters' AND indexdef ILIKE '%UNIQUE%' AND indexdef ILIKE '%(product_code)%'`);
    assert.equal(imBare.rowCount, 0, 'product_im_counters must NOT be unique on product_code alone (one code may cover several products)');
    const imKeyed = await c.query(`SELECT indexdef FROM pg_indexes WHERE tablename='product_im_counters' AND indexdef ILIKE '%UNIQUE%' AND indexdef ILIKE '%(product_code, product_id)%'`);
    assert.equal(imKeyed.rowCount, 1, 'product_im_counters must be keyed (product_code, product_id)');
    // The failure the old index caused: two products under one code, both with a counter.
    await c.query(`INSERT INTO product_profiles (id, name, short_name, product_code) VALUES (901,'A','X1','PUURE'),(902,'B','X2','PUURE') ON CONFLICT (id) DO NOTHING`);
    await c.query(`INSERT INTO product_im_counters (product_id, next_im, product_code) VALUES (901,5,'PUURE'),(902,7,'PUURE')`);
    // Idempotent: applying the same files again must not throw (IF NOT EXISTS everywhere).
    await c.query('DELETE FROM _migrations');
    await applySqlFiles(c, laneMigrationFiles(), { settings: { 'app.store_code': TEST_STORE_CODE } });
    // Lazily-created tables the app owns were created here so the column exists
    // before the route's CREATE TABLE IF NOT EXISTS ever runs.
    for (const t of ['product_profiles', 'crm_orders', 'shopify_orders_cache', 'video_ads', 'clickup_brief_resolutions', 'statics_im_counter']) {
      const r = await c.query(`SELECT to_regclass($1) AS t`, [t]);
      assert.ok(r.rows[0].t, `${t} should exist after the migration`);
    }
  });
});

test('A1: app.store_code drives the default; an invalid code is refused (failure path)', async () => {
  const db = await freshDb('lane_store_code_a1b');
  await withClient(db, async (c) => {
    await loadEmptyFixture(c);
    await applySqlFiles(c, laneMigrationFiles(), { settings: { 'app.store_code': 'PL' } });
    const sc = await columnInfo(c, 'spy_creatives', 'store_code');
    assert.equal(sc.column_default, "'PL'::text");
  });
  const db2 = await freshDb('lane_store_code_a1c');
  await withClient(db2, async (c) => {
    await loadEmptyFixture(c);
    await assert.rejects(
      () => applySqlFiles(c, laneMigrationFiles(), { settings: { 'app.store_code': "x'; drop" } }),
      (err) => { assert.match(err.message, /store_code/i); return true; },
    );
    // and nothing leaked in: the transaction rolled back
    assert.equal(await columnInfo(c, 'spy_creatives', 'store_code'), null);
  });
  // Review F1: an UNSET app.store_code must RAISE, not silently pick a store.
  // Nothing in the file may name a store, so there is no code left to fall back to.
  const db3 = await freshDb('lane_store_code_a1d');
  await withClient(db3, async (c) => {
    await loadEmptyFixture(c);
    await assert.rejects(
      () => applySqlFiles(c, laneMigrationFiles(), { storeCode: null }),
      (err) => { assert.match(err.message, /app\.store_code is not set/i); return true; },
    );
    assert.equal(await columnInfo(c, 'spy_creatives', 'store_code'), null);
  });
});

test('A1: run.js itself refuses an unset or malformed STORE_CODE before it writes anything (review F1)', async () => {
  const { resolveStoreCode, resolveLockTimeout, STORE_CODE_RE } = await import('../../migrations/run.js');
  assert.equal(resolveStoreCode({ STORE_CODE: 'PL' }), 'PL');
  assert.equal(resolveStoreCode({ STORE_CODE: '  MB  ' }), 'MB');
  for (const bad of [{}, { STORE_CODE: '' }, { STORE_CODE: '   ' }, { STORE_CODE: 'pl' }, { STORE_CODE: 'PUURE' }, { STORE_CODE: 'P' }, { STORE_CODE: "pl'; drop" }]) {
    assert.throws(() => resolveStoreCode(bad), /REFUSING to run migrations/, `expected a refusal for ${JSON.stringify(bad)}`);
  }
  assert.match(String(STORE_CODE_RE), /A-Z0-9/);
  // and the lock timeout the migration transaction runs under (review F7)
  assert.equal(resolveLockTimeout({}), '5s');
  assert.equal(resolveLockTimeout({ MIGRATION_LOCK_TIMEOUT: '500ms' }), '500ms');
  assert.equal(resolveLockTimeout({ MIGRATION_LOCK_TIMEOUT: '0' }), '0');
  assert.throws(() => resolveLockTimeout({ MIGRATION_LOCK_TIMEOUT: "5s'; SELECT 1" }), /not a PostgreSQL interval/);
});
