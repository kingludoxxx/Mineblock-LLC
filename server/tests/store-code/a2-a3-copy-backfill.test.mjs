// A2/A3 — on a copy of the reference database `mineblock_copy` (restored by
// the lead; READ-ONLY; never created or modified here) the dry-run prints
// per-table MB/P1/untagged counts and an UNTAGGED list, and the backfill is
// idempotent (second apply changes 0 rows).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { dbExists, freshDb, withClient, applySqlFiles, laneMigrationFiles, runBackfill } from './_db.mjs';

const TEMPLATE = 'mineblock_copy';
// Review F9: NOT `lane_store_code_mb` — that is the lane's own inspection copy,
// and a reviewer running the suite used to destroy it without noticing.
const COPY = 'lane_store_code_a2a3_copy';

test('A2/A3: dry-run report + idempotent apply on a copy of mineblock_copy', async (t) => {
  if (!(await dbExists(TEMPLATE))) {
    // Not a pass: the reference DB is not restored yet. Surface it loudly.
    t.skip(`${TEMPLATE} is not present on the local server; A2/A3 NOT RUN`);
    return;
  }
  await freshDb(COPY, { template: TEMPLATE });
  await withClient(COPY, async (c) => {
    const before = await c.query(`SELECT count(*)::int AS n FROM spy_creatives`);
    t.diagnostic(`spy_creatives rows in copy: ${before.rows[0].n}`);
    await applySqlFiles(c, laneMigrationFiles());
  });

  const dry = runBackfill(COPY, ['--dry-run']);
  assert.equal(dry.code, 0, dry.stderr);
  assert.equal(dry.summary.mode, 'dry-run');
  assert.match(dry.stdout, /UNTAGGED/);
  const tables = dry.summary.tables;
  for (const name of ['product_profiles', 'spy_creatives', 'brief_pipeline_generated', 'image_store', 'clickup_brief_resolutions', 'brief_number_counter', 'product_im_counters']) {
    assert.ok(tables[name], `no report row for ${name}`);
    assert.equal(typeof tables[name].total, 'number');
    assert.equal(typeof tables[name].untagged, 'number');
    assert.ok(tables[name].store_code, `no store_code breakdown for ${name}`);
  }
  // Nothing written by a dry-run: product_code stays as the pre-backfill state.
  await withClient(COPY, async (c) => {
    const r = await c.query(`SELECT count(*)::int AS n FROM spy_creatives WHERE product_code IS NOT NULL`);
    assert.equal(r.rows[0].n, 0);
  });
  const lines = ['table | total | MB | P1 | other codes | untagged'];
  for (const [name, row] of Object.entries(tables)) {
    const other = Object.entries(row.product_code || {}).filter(([k]) => k !== 'P1').map(([k, v]) => `${k}=${v}`).join(' ');
    lines.push(`${name} | ${row.total} | ${row.store_code.MB ?? 0} | ${row.product_code?.P1 ?? 0} | ${other || '-'} | ${row.untagged}`);
  }
  t.diagnostic('\n' + lines.join('\n'));

  const run1 = runBackfill(COPY, []);
  assert.equal(run1.code, 0, run1.stderr);
  assert.equal(run1.summary.changed_rows, dry.summary.changed_rows, 'apply must match the dry-run plan');
  const run2 = runBackfill(COPY, []);
  assert.equal(run2.code, 0, run2.stderr);
  assert.equal(run2.summary.changed_rows, 0, 'A3: second apply must change 0 rows');
  t.diagnostic(`changed_rows: dry=${dry.summary.changed_rows} apply#1=${run1.summary.changed_rows} apply#2=${run2.summary.changed_rows}`);
});
