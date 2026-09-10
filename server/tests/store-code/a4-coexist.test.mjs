// A4 — a P1 brief number and a PL brief number coexist in
// clickup_brief_resolutions, unique on (product_code, brief_number).
//
// Today the table's PRIMARY KEY is brief_number alone (adsReporting.js:62), and
// the cache write at adsReporting.js:714 is `ON CONFLICT (brief_number)`. That
// insert form can only be planned while a unique index on (brief_number) alone
// exists, so the key swap and the code change must ship together. 123 expands
// (adds the columns); the swap lives in server/migrations/staged/ and is
// applied here explicitly. Both states are asserted.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { freshDb, withClient, applySqlFiles, laneMigrationFiles, stagedMigrationFiles } from './_db.mjs';
import { loadEmptyFixture } from './_fixture-empty.mjs';

const LEGACY_INSERT = `INSERT INTO clickup_brief_resolutions (brief_number, task_url)
  SELECT n, u FROM unnest($1::int[], $2::text[]) AS t(n, u)
  ON CONFLICT (brief_number) DO UPDATE SET task_url = EXCLUDED.task_url, resolved_at = NOW()`;

test('A4: after 123 alone the legacy write still works and same-number coexistence is still blocked', async () => {
  const db = await freshDb('lane_store_code_a4a');
  await withClient(db, async (c) => {
    await loadEmptyFixture(c);
    await applySqlFiles(c, laneMigrationFiles());
    await c.query(LEGACY_INSERT, [[12], ['https://app.clickup.com/t/legacy12']]);
    await c.query(`INSERT INTO clickup_brief_resolutions (brief_number, task_url, product_code) VALUES (12, 'u', 'P1')`)
      .then(() => assert.fail('PK on brief_number should still block the second row'), (err) => assert.equal(err.code, '23505'));
  });
});

test('A4: after the staged rekey, P1 and PL share a brief number; duplicates and the legacy insert form fail', async () => {
  const staged = stagedMigrationFiles();
  assert.ok(staged.length >= 1, 'expected the staged rekey migration');
  const db = await freshDb('lane_store_code_a4b');
  await withClient(db, async (c) => {
    await loadEmptyFixture(c);
    await applySqlFiles(c, laneMigrationFiles());
    // pre-existing untagged rows must survive the swap
    await c.query(LEGACY_INSERT, [[5, 6], ['https://app.clickup.com/t/a', 'https://app.clickup.com/t/b']]);
    await applySqlFiles(c, staged);
    await c.query(`INSERT INTO clickup_brief_resolutions (product_code, brief_number, task_url) VALUES ('P1', 12, 'https://app.clickup.com/t/p1')`);
    await c.query(`INSERT INTO clickup_brief_resolutions (product_code, brief_number, task_url) VALUES ('PL', 12, 'https://app.clickup.com/t/pl')`);
    const rows = await c.query(`SELECT product_code, task_url FROM clickup_brief_resolutions WHERE brief_number = 12 ORDER BY product_code`);
    assert.deepEqual(rows.rows.map((r) => r.product_code), ['P1', 'PL']);
    // unique on (product_code, brief_number)
    await c.query(`INSERT INTO clickup_brief_resolutions (product_code, brief_number, task_url) VALUES ('P1', 12, 'dup')`)
      .then(() => assert.fail('duplicate (P1,12) must be rejected'), (err) => assert.equal(err.code, '23505'));
    // untagged rows are also unique per number (NULLS NOT DISTINCT)
    await c.query(`INSERT INTO clickup_brief_resolutions (brief_number, task_url) VALUES (5, 'dup')`)
      .then(() => assert.fail('duplicate (NULL,5) must be rejected'), (err) => assert.equal(err.code, '23505'));
    // the keyed upsert the future adsReporting.js write must use
    await c.query(`INSERT INTO clickup_brief_resolutions (product_code, brief_number, task_url) VALUES ('P1', 12, 'https://app.clickup.com/t/p1-new')
      ON CONFLICT (product_code, brief_number) DO UPDATE SET task_url = EXCLUDED.task_url`);
    const upd = await c.query(`SELECT task_url FROM clickup_brief_resolutions WHERE product_code='P1' AND brief_number=12`);
    assert.equal(upd.rows[0].task_url, 'https://app.clickup.com/t/p1-new');
    // FAILURE PATH: the legacy insert form can no longer be planned. This is the
    // exact reason adsReporting.js:714 must change before staged/125 runs live.
    await c.query(LEGACY_INSERT, [[13], ['x']])
      .then(() => assert.fail('legacy ON CONFLICT (brief_number) should fail after the rekey'),
            (err) => assert.equal(err.code, '42P10'));
    const survivors = await c.query(`SELECT brief_number FROM clickup_brief_resolutions WHERE product_code IS NULL ORDER BY 1`);
    assert.deepEqual(survivors.rows.map((r) => r.brief_number), [5, 6]);
  });
});
