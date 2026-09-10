// A1 — Lane C migrations apply on an EMPTY database (after the post-099
// fixture), are idempotent, honour app.store_code, and refuse a bad code.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import fs from 'node:fs';
import { freshDb, withClient, applySqlFiles, laneMigrationFiles, stagedMigrationFiles, columnInfo, MIGRATIONS_DIR } from './_db.mjs';
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

test('A1: lane migration files exist, are numbered 121+, and staged/ is not auto-run', () => {
  const files = laneMigrationFiles().map((f) => path.basename(f));
  assert.ok(files.length >= 1, 'expected at least one 121+ migration');
  for (const f of files) assert.match(f, /^12[1-9]_|^1[3-9]\d_/);
  // run.js / server.js read only *.sql directly under server/migrations —
  // a file under staged/ must never be picked up by the boot-time runner.
  const rootSql = fs.readdirSync(MIGRATIONS_DIR).filter((f) => f.endsWith('.sql'));
  for (const s of stagedMigrationFiles()) assert.ok(!rootSql.includes(path.basename(s)), `${s} leaked into the root`);
  assert.ok(fs.existsSync(path.join(MIGRATIONS_DIR, 'order.lane-c.json')), 'order.lane-c.json missing');
  const order = JSON.parse(fs.readFileSync(path.join(MIGRATIONS_DIR, 'order.lane-c.json'), 'utf8'));
  for (const f of files) assert.ok(order.migrations.includes(f), `${f} not listed in order.lane-c.json`);
});

test('A1: migrations apply on an empty DB; every listed table gets store_code (and product_code where identifiable)', async () => {
  const db = await freshDb('lane_store_code_a1');
  await withClient(db, async (c) => {
    await loadEmptyFixture(c);
    // one lazily-created §1b table present, the rest absent: 122 must tag the
    // present one and skip the others without failing (R6 empty-DB rule)
    await c.query('CREATE TABLE co_sessions (id TEXT PRIMARY KEY)');
    const applied = await applySqlFiles(c, laneMigrationFiles());
    assert.ok(applied.length >= 2, 'expected 121 and 122');
    assert.ok(await columnInfo(c, 'co_sessions', 'store_code'), 'co_sessions (present lazy table) should be tagged by 122');
    assert.equal((await c.query(`SELECT to_regclass('crm_order_comments') AS t`)).rows[0].t, null, '122 must not create absent lazy tables');
    for (const [table, kind] of Object.entries(EXPECT)) {
      const sc = await columnInfo(c, table, 'store_code');
      assert.ok(sc, `${table}.store_code missing`);
      assert.equal(sc.is_nullable, 'NO', `${table}.store_code must be NOT NULL`);
      assert.equal(sc.column_default, "'MB'::text", `${table}.store_code default must be 'MB' when app.store_code is unset`);
      const pc = await columnInfo(c, table, 'product_code');
      if (kind === 'product') { assert.ok(pc, `${table}.product_code missing`); assert.equal(pc.data_type, 'text'); }
      else assert.equal(pc, null, `${table}.product_code must not be added (no product identifiable)`);
    }
    // Counters keyed by product code: a unique index on product_code exists.
    for (const t of ['brief_number_counter', 'product_im_counters', 'statics_im_counter']) {
      const r = await c.query(`SELECT indexdef FROM pg_indexes WHERE tablename=$1 AND indexdef ILIKE '%UNIQUE%' AND indexdef ILIKE '%(product_code)%'`, [t]);
      assert.equal(r.rowCount, 1, `${t}: expected exactly one unique index on (product_code)`);
    }
    // Idempotent: applying the same files again must not throw (IF NOT EXISTS everywhere).
    await c.query('DELETE FROM _migrations');
    await applySqlFiles(c, laneMigrationFiles());
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
});
