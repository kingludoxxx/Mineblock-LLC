// A5 — backfill on synthetic data: known codes are copied from
// product_profiles, P1 is recognised by the documented discriminators, and an
// UNKNOWN product code is left untagged and listed, never guessed.
// Also exercises --dry-run (changes nothing) and idempotency (A3 in miniature).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { freshDb, withClient, applySqlFiles, laneMigrationFiles, runBackfill } from './_db.mjs';
import { loadEmptyFixture } from './_fixture-empty.mjs';

const P1_CREATIVE = '11111111-1111-4111-8111-111111111111';
const UNKNOWN_CREATIVE = '22222222-2222-4222-8222-222222222222';
const MR_BRIEF = '33333333-3333-4333-8333-333333333333';
const P1_BRIEF = '44444444-4444-4444-8444-444444444444';

async function seed(c) {
  await c.query(`INSERT INTO product_profiles (id, name, short_name, product_code) VALUES
    (1, 'Mineblock Miner', 'MB', 'MR'),
    (2, 'Pulse Pro', 'P1', NULL),
    (3, 'Mystery Widget', 'MW', NULL),
    (4, 'Puure', 'PU', 'PUURE'),
    (5, 'P10 Decoy', 'PX', NULL)`);
  await c.query(`INSERT INTO spy_creatives (id, product_id, image_url) VALUES
    ($1, 2, 'https://srv/api/v1/statics-generation/tmp-img/img-p1'),
    ($2, 3, 'https://srv/api/v1/statics-generation/tmp-img/img-unknown'),
    (gen_random_uuid(), 1, 'https://cdn/x.png'),
    (gen_random_uuid(), 999, 'https://cdn/orphan.png')`, [P1_CREATIVE, UNKNOWN_CREATIVE]);
  await c.query(`INSERT INTO image_store (id, data) VALUES ('img-p1', '\\x00'), ('img-unknown', '\\x00'), ('img-orphan', '\\x00')`);
  await c.query(`INSERT INTO brief_pipeline_generated (id, brief_number, product_code, naming_convention, clickup_task_id) VALUES
    ($1, 11, 'MR', 'MR - B0011 - IT - NA', 'task-mr-11'),
    ($2, 12, 'MR', 'P1 - B0012 - IT - NA', 'task-p1-12'),
    (gen_random_uuid(), 13, 'P1', 'P1 - B0013 - IT - NA', NULL),
    (gen_random_uuid(), 12, 'PUURE', 'PL - B0012 - IT - NA', 'task-pl-12'),
    (gen_random_uuid(), 14, 'PUURE', 'P1 - B0014 - IT - NA', NULL)`, [MR_BRIEF, P1_BRIEF]);
  await c.query(`INSERT INTO brief_launches (brief_id) VALUES ($1), ($2)`, [MR_BRIEF, P1_BRIEF]);
  await c.query(`INSERT INTO clickup_brief_resolutions (brief_number, task_id, task_url) VALUES
    (12, 'task-p1-12', 'https://app.clickup.com/t/task-p1-12'),
    (11, 'task-mr-11', 'https://app.clickup.com/t/task-mr-11'),
    (97, 'task-na', 'https://app.clickup.com/t/task-na'),
    (98, 'task-ambiguous', 'https://app.clickup.com/t/task-ambiguous'),
    (99, 'task-nobody', 'https://app.clickup.com/t/task-nobody')`);
  // ad-name evidence: 99 seen under one code, 98 under two (collision), 97 only under the NA placeholder
  await c.query(`INSERT INTO creative_analysis (creative_id, ad_name) VALUES
    ('c1', 'MR - B0099 - H1 - NA - Avatar - Angle - Cartoon - Ludovico - NA - Uly - WK17_2026'),
    ('c2', 'MR - B0098 - H1 - NA - Avatar - Angle - Cartoon - Ludovico - NA - Uly - WK17_2026'),
    ('c3', 'P1 - B0098 - IT - NA - Angle - Mashup - Ludovico - NA - WK17_2026'),
    ('c4', 'NA - B0097 - H1 - NA'),
    ('c5', 'Urgency - 1')`);
  await c.query(`INSERT INTO brief_number_counter (id, value) VALUES (1, 500), (2, 21)`);
  await c.query(`INSERT INTO product_im_counters (product_id, next_im) VALUES (2, 7), (3, 4)`);
  await c.query(`INSERT INTO statics_im_counter (id, next_number) VALUES (1, 42)`);
  await c.query(`INSERT INTO statics_launches (creative_id) VALUES ($1), ($2)`, [P1_CREATIVE, UNKNOWN_CREATIVE]);
}

test('A5: dry-run changes nothing and reports; apply tags known + P1, leaves unknown untagged and listed; second apply changes 0 rows', async () => {
  const db = await freshDb('lane_store_code_a5');
  await withClient(db, async (c) => {
    await loadEmptyFixture(c);
    await applySqlFiles(c, laneMigrationFiles());
    await seed(c);
  });

  // ── dry-run ──
  const dry = runBackfill(db, ['--dry-run']);
  assert.equal(dry.code, 0, dry.stderr);
  assert.ok(dry.summary, 'JSON_SUMMARY missing\n' + dry.stdout);
  assert.equal(dry.summary.mode, 'dry-run');
  assert.ok(dry.summary.changed_rows > 0, 'dry-run should report what it WOULD change');
  assert.match(dry.stdout, /UNTAGGED/);
  await withClient(db, async (c) => {
    const r = await c.query(`SELECT count(*)::int AS n FROM spy_creatives WHERE product_code IS NOT NULL`);
    assert.equal(r.rows[0].n, 0, 'dry-run must not write');
    const cnt = await c.query(`SELECT count(*)::int AS n FROM brief_number_counter`);
    assert.equal(cnt.rows[0].n, 2, 'dry-run must not insert counter rows');
  });

  // ── apply ──
  const run1 = runBackfill(db, []);
  assert.equal(run1.code, 0, run1.stderr);
  assert.equal(run1.summary.mode, 'apply');
  assert.equal(run1.summary.changed_rows, dry.summary.changed_rows, 'apply must change exactly what dry-run announced');
  await withClient(db, async (c) => {
    const pp = await c.query(`SELECT id, product_code FROM product_profiles ORDER BY id`);
    assert.deepEqual(pp.rows.map((r) => [r.id, r.product_code]), [[1, 'MR'], [2, 'P1'], [3, null], [4, 'PUURE'], [5, null]]);
    const sc = await c.query(`SELECT product_id, product_code, store_code FROM spy_creatives ORDER BY product_id`);
    assert.deepEqual(sc.rows.map((r) => [r.product_id, r.product_code]), [[1, 'MR'], [2, 'P1'], [3, null], [999, null]]);
    for (const r of sc.rows) assert.equal(r.store_code, 'MB');
    const img = await c.query(`SELECT id, product_code FROM image_store ORDER BY id`);
    assert.deepEqual(img.rows.map((r) => [r.id, r.product_code]), [['img-orphan', null], ['img-p1', 'P1'], ['img-unknown', null]]);
    const br = await c.query(`SELECT brief_number, product_code, naming_convention FROM brief_pipeline_generated ORDER BY brief_number, product_code`);
    assert.deepEqual(br.rows.map((r) => [r.brief_number, r.product_code]),
      [[11, 'MR'], [12, 'P1'], [12, 'PUURE'], [13, 'P1'], [14, 'PUURE']]);
    const bl = await c.query(`SELECT b.brief_number, l.product_code FROM brief_launches l JOIN brief_pipeline_generated b ON b.id = l.brief_id ORDER BY 1`);
    assert.deepEqual(bl.rows.map((r) => [r.brief_number, r.product_code]), [[11, 'MR'], [12, 'P1']]);
    const cbr = await c.query(`SELECT brief_number, product_code FROM clickup_brief_resolutions ORDER BY brief_number`);
    assert.deepEqual(cbr.rows.map((r) => [r.brief_number, r.product_code]), [[11, 'MR'], [12, 'P1'], [97, null], [98, null], [99, 'MR']]);
    // Review F6: this run is store MB, which owns MR only. The positional map
    // (id 2 = PL) is evidence on the store that OWNS PL and a guess anywhere else,
    // so id 2 stays untagged here and no P1 counter is invented. The PL-store run
    // below is where the seeding is asserted.
    const bnc = await c.query(`SELECT id, product_code, value FROM brief_number_counter ORDER BY id`);
    assert.deepEqual(bnc.rows.map((r) => [r.id, r.product_code, r.value]), [[1, 'MR', 500], [2, null, 21]]);
    const pic = await c.query(`SELECT product_id, product_code FROM product_im_counters ORDER BY product_id`);
    assert.deepEqual(pic.rows.map((r) => [r.product_id, r.product_code]), [[2, 'P1'], [3, null]]);
    const sic = await c.query(`SELECT product_code FROM statics_im_counter`);
    assert.equal(sic.rows[0].product_code, null, 'legacy global IM counter has no knowable product code');
    const sl = await c.query(`SELECT creative_id, product_code FROM statics_launches ORDER BY creative_id`);
    assert.deepEqual(sl.rows.map((r) => r.product_code), ['P1', null]);
  });
  // UNTAGGED report names the unknown rows
  const t = run1.summary.tables;
  assert.equal(t.spy_creatives.untagged, 2);
  assert.equal(t.spy_creatives.product_code.P1, 1);
  assert.equal(t.spy_creatives.product_code.MR, 1);
  assert.equal(t.spy_creatives.store_code.MB, 4);
  assert.equal(t.image_store.untagged, 2);
  assert.equal(t.clickup_brief_resolutions.untagged, 2);
  assert.deepEqual(t.clickup_brief_resolutions.untagged_sample, ['97', '98']);
  assert.ok(run1.summary.conflicts.some((x) => x.table === 'clickup_brief_resolutions' && x.id === '98' && x.reason.includes('MR,P1')), 'ambiguous brief number 98 must be a listed conflict');
  assert.equal(t.product_profiles.untagged, 2);
  assert.equal(t.statics_im_counter.untagged, 1);
  assert.ok(run1.summary.conflicts.some((x) => x.table === 'brief_pipeline_generated' && x.reason.includes('P1')), 'PUURE row with a P1 naming prefix must be reported as a conflict, not overwritten');
  // Review F6: a row carrying a code this store does not own is FOREIGN — it has a
  // tag, so it is not UNTAGGED, and nothing disagrees, so it is not a CONFLICT.
  assert.deepEqual(run1.summary.owned_product_codes, ['MR']);
  assert.ok(run1.summary.foreign.some((x) => x.table === 'brief_pipeline_generated' && x.product_code === 'PUURE' && x.rows === 2), 'PUURE briefs on an MB store must be listed as FOREIGN\n' + JSON.stringify(run1.summary.foreign));
  assert.ok(run1.summary.foreign.some((x) => x.table === 'spy_creatives' && x.product_code === 'P1'), 'P1 creatives on an MB store must be listed as FOREIGN');
  assert.ok(run1.summary.notes.some((n) => /counter id 2 maps to 'PL'/.test(n)), 'the skipped positional counter tag must be reported');
  assert.match(run1.stdout, /^FOREIGN \(product_code not owned by store MB/m);
  // Review F3: store_code is never rewritten on the ordinary path.
  assert.equal(run1.summary.relabel_store, null);
  assert.equal(run1.summary.steps.filter((x) => x.step.startsWith('0.store_code')).length, 0, 'no store_code row was touched');

  // ── idempotent ──
  const run2 = runBackfill(db, []);
  assert.equal(run2.code, 0, run2.stderr);
  assert.equal(run2.summary.changed_rows, 0, 'second run must change 0 rows\n' + run2.stdout);
});

test('A5: on the store that OWNS the codes, the counters ARE seeded (review F6 map, other side)', async () => {
  const db = await freshDb('lane_store_code_a5pl');
  await withClient(db, async (c) => {
    await loadEmptyFixture(c);
    await applySqlFiles(c, laneMigrationFiles(), { storeCode: 'PL' });
    await seed(c);
  });
  const run = runBackfill(db, [], { STORE_CODE: 'PL' });
  assert.equal(run.code, 0, run.stderr);
  assert.deepEqual(run.summary.owned_product_codes, ['PL', 'PUURE', 'P1']);
  await withClient(db, async (c) => {
    const bnc = await c.query(`SELECT id, product_code, value FROM brief_number_counter ORDER BY id`);
    // id 1 = MR is NOT owned by PL, so it stays untagged; id 2 = PL is tagged and
    // its value is raised (never lowered); the P1 row is seeded from MAX(P1 brief).
    assert.deepEqual(bnc.rows.map((r) => [r.id, r.product_code, r.value]), [[1, null, 500], [2, 'PL', 21], [3, 'P1', 13]]);
  });
  // MR data now reads as FOREIGN on the Puure store — the mirror of the MB run.
  assert.ok(run.summary.foreign.some((x) => x.product_code === 'MR'), 'MR rows must be FOREIGN on a PL store\n' + JSON.stringify(run.summary.foreign));
  const run2 = runBackfill(db, [], { STORE_CODE: 'PL' });
  assert.equal(run2.summary.changed_rows, 0, 'idempotent on the PL store too');
});

test('A5 failure paths: missing DATABASE_URL and an unreachable database exit non-zero with a clear message', () => {
  const noUrl = runBackfill('unused', ['--dry-run'], { DATABASE_URL: '' });
  assert.notEqual(noUrl.code, 0);
  assert.match(noUrl.stderr + noUrl.stdout, /DATABASE_URL/);
  const bad = runBackfill('lane_store_code_does_not_exist', ['--dry-run']);
  assert.notEqual(bad.code, 0);
  assert.match(bad.stderr + bad.stdout, /does not exist|connect/i);
  const badFlag = runBackfill('lane_store_code_a5', ['--bogus']);
  assert.notEqual(badFlag.code, 0);
  assert.match(badFlag.stderr + badFlag.stdout, /unknown (option|flag|argument)/i);
});
