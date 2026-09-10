// A7 — the C2 review fixes that need their own failure path, each written as the
// reviewer's repro:
//   F3  a STORE_CODE that disagrees with the database REFUSES instead of silently
//       relabelling the whole store; --relabel-store is the loud, opt-in way.
//   F5  ad-name evidence never attributes a number-keyed cache row on a store
//       where two product lines share the number space.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { freshDb, withClient, applySqlFiles, laneMigrationFiles, runBackfill } from './_db.mjs';
import { loadEmptyFixture } from './_fixture-empty.mjs';

test('A7/F3: a wrong STORE_CODE refuses; the existing labels are untouched; --relabel-store is explicit', async () => {
  const db = await freshDb('lane_store_code_a7f3');
  await withClient(db, async (c) => {
    await loadEmptyFixture(c);
    await applySqlFiles(c, laneMigrationFiles(), { storeCode: 'PL' });   // a Puure database
    await c.query(`INSERT INTO spy_creatives (product_id) VALUES (1), (2), (3)`);
  });

  // no STORE_CODE at all: usage error, nothing read, nothing written
  const unset = runBackfill(db, ['--dry-run'], { STORE_CODE: '' });
  assert.equal(unset.code, 2, unset.stdout + unset.stderr);
  assert.match(unset.stderr, /STORE_CODE is not set/);

  // the wrong store: a refusal that names the row count it would have rewritten
  const wrong = runBackfill(db, [], { STORE_CODE: 'MB' });
  assert.equal(wrong.code, 1, wrong.stdout);
  assert.match(wrong.stderr, /REFUSING/);
  assert.match(wrong.stderr, /would REWRITE 3 existing row label\(s\)/);
  assert.match(wrong.stderr, /--relabel-store MB/);
  await withClient(db, async (c) => {
    const r = await c.query(`SELECT DISTINCT store_code FROM spy_creatives`);
    assert.deepEqual(r.rows.map((x) => x.store_code), ['PL'], 'the refusal must not have touched a single label');
  });

  // the right store: a FILL. Under NOT NULL there is nothing to fill, and above
  // all nothing is rewritten — that is the whole point of the fix.
  const right = runBackfill(db, [], { STORE_CODE: 'PL' });
  assert.equal(right.code, 0, right.stderr);
  assert.equal(right.summary.steps.filter((x) => x.step.startsWith('0.store_code')).length, 0);
  assert.equal(right.summary.relabel_store, null);

  // the deliberate repair, dry: says so loudly, counts the rows, rolls back
  const relabel = runBackfill(db, ['--relabel-store', 'MB', '--dry-run'], { STORE_CODE: 'MB' });
  assert.equal(relabel.code, 0, relabel.stderr);
  assert.match(relabel.stdout, /RELABEL-STORE: rewriting the store_code of \d+ existing row\(s\)/);
  assert.match(relabel.stdout, /This is NOT a fill/);
  assert.equal(relabel.summary.relabel_store.rows_relabelled, relabel.summary.relabel_store.tables.length ? relabel.summary.relabel_store.rows_relabelled : 0);
  assert.ok(relabel.summary.relabel_store.rows_relabelled >= 3);
  await withClient(db, async (c) => {
    const r = await c.query(`SELECT DISTINCT store_code FROM spy_creatives`);
    assert.deepEqual(r.rows.map((x) => x.store_code), ['PL'], 'a dry relabel must still change nothing');
  });

  // --relabel-store must name the same code as STORE_CODE (typed twice, on purpose)
  const mismatch = runBackfill(db, ['--relabel-store', 'PL'], { STORE_CODE: 'MB' });
  assert.equal(mismatch.code, 2);
  assert.match(mismatch.stderr, /does not match STORE_CODE/);
});

test('A7/F5: a brief number that two codes share is never attributed from ad names alone', async () => {
  const db = await freshDb('lane_store_code_a7f5');
  await withClient(db, async (c) => {
    await loadEmptyFixture(c);
    await applySqlFiles(c, laneMigrationFiles(), { storeCode: 'PL' });
    // Puure's shape: PL and P1 share the ClickUp list AND the brief number space.
    await c.query(`INSERT INTO product_profiles (id, name, short_name, product_code) VALUES (10,'Breast Lift','BL','PL'), (11,'Pulse Pro','P1','P1')`);
    await c.query(`INSERT INTO brief_pipeline_generated (brief_number, product_code, naming_convention, parent_creative_id) VALUES
      (12, 'PL', 'PL - B0012 - x', 'c1'),
      (12, 'P1', 'P1 - B0012 - x', 'c2'),
      (13, 'PL', 'PL - B0013 - x', 'c3')`);
    // the cache row is keyed by NUMBER alone (adsReporting.js:62) — this URL is P1's card
    await c.query(`INSERT INTO clickup_brief_resolutions (brief_number, task_url) VALUES (12, 'https://app.clickup.com/t/86c-p1-card'), (13, 'https://app.clickup.com/t/86c-pl-card')`);
    // and the only LAUNCHED ad carrying number 12 is PL's
    await c.query(`INSERT INTO creative_analysis (creative_id, ad_name) VALUES ('a1', 'PL - B0012 - IM001'), ('a2', 'PL - B0013 - IM001')`);
  });

  const run = runBackfill(db, [], { STORE_CODE: 'PL' });
  assert.equal(run.code, 0, run.stderr);
  await withClient(db, async (c) => {
    const r = await c.query(`SELECT brief_number, product_code, task_url FROM clickup_brief_resolutions ORDER BY brief_number`);
    const byNumber = Object.fromEntries(r.rows.map((x) => [x.brief_number, x.product_code]));
    assert.equal(byNumber[12], null, 'number 12 exists under PL AND P1: the P1 card must NOT be labelled PL');
    assert.equal(byNumber[13], 'PL', 'number 13 exists under one code only: ad-name evidence still attributes it');
  });
  assert.ok(run.summary.conflicts.some((x) => x.table === 'clickup_brief_resolutions' && x.id === '12' && /also exists under/.test(x.reason)),
    'the ambiguous number must be reported, not silently skipped\n' + JSON.stringify(run.summary.conflicts));
});
