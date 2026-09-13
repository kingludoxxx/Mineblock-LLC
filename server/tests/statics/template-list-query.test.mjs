// The Statics template list must not read the two heavy columns (the stored image, the deep analysis).
// Measured on a live store 2026-09-13: reading them made the list 8.5 MB and 2.8 s of database time; under the
// page's 12-request burst it passed the 8 s query limit and answered 500. Without them: 1.8 MB, ~0.4 s.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import postgres from 'postgres';
import { templateListQuery, TEMPLATE_HEAVY_COLUMNS } from '../../src/utils/templateListQuery.js';

const COLS = ['id', 'name', 'category', 'image_url', 'tags', 'is_hidden', 'sort_order', 'created_at', 'deep_analysis', 'analyzed_at'];

test('T1: the heavy columns are never selected, only tested', () => {
  const { text } = templateListQuery(COLS, {});
  assert.deepEqual(TEMPLATE_HEAVY_COLUMNS, ['image_url', 'deep_analysis']);
  assert.ok(!/to_jsonb\(t\)|SELECT \*/.test(text), 'a whole-row read pulls every heavy value out of storage');
  assert.ok(!/"deep_analysis"\s*(,|FROM|AS "deep_analysis")/.test(text), 'deep_analysis body is not selected');
  assert.match(text, /\("deep_analysis" IS NOT NULL\) AS "has_analysis"/);
  assert.match(text, /left\("image_url", 5\) = 'data:'/, 'inline check reads 5 bytes, not the image');
});

test('T2: filters are parameters, never spliced; hidden and Uncategorized follow the old rules', () => {
  const a = templateListQuery(COLS, { category: "x'; DROP TABLE users; --", search: '50%' });
  assert.deepEqual(a.params, ["x'; DROP TABLE users; --", '%50%%', '%50%%']);
  assert.ok(!a.text.includes('DROP'));
  assert.match(a.text, /"is_hidden" = false/);
  assert.match(templateListQuery(COLS, {}).text, /category IS NULL OR category != 'Uncategorized'/);
  assert.ok(!/is_hidden" = false/.test(templateListQuery(COLS, { showHidden: true }).text));
});

test('T3: a column name that is not a plain identifier is refused, not quoted into SQL', () => {
  for (const bad of ['a"b', 'x; drop', 'Name', '1x', '']) assert.throws(() => templateListQuery([...COLS, bad], {}), new RegExp('column'));
  assert.throws(() => templateListQuery([], {}), /column/);
});

test('T3b: a table that has no deep_analysis column yet (a new store) still lists, every template unanalyzed', () => {
  const { text } = templateListQuery(COLS.filter((c) => c !== 'deep_analysis'), {});
  assert.ok(!text.includes('"deep_analysis"'), 'a missing column must not be referenced');
  assert.match(text, /false AS "has_analysis"/);
});

test('T4: against a real database: same rows and order, inline flag right, analysis reduced to a flag', { skip: !process.env.DATABASE_URL }, async () => {
  const admin = postgres(process.env.DATABASE_URL, { ssl: false, onnotice: () => {}, max: 1 });
  const db = 'puure_template_list_query';
  await admin.unsafe(`DROP DATABASE IF EXISTS ${db}`);
  await admin.unsafe(`CREATE DATABASE ${db}`);
  const url = new URL(process.env.DATABASE_URL); url.pathname = `/${db}`;
  const sql = postgres(url.toString(), { ssl: false, onnotice: () => {}, max: 1 });
  try {
    await sql.unsafe(`CREATE TABLE statics_templates (id uuid PRIMARY KEY DEFAULT gen_random_uuid(), name text, category text,
      image_url text, tags jsonb DEFAULT '[]', is_hidden boolean DEFAULT false, sort_order int DEFAULT 0,
      created_at timestamptz DEFAULT now(), deep_analysis jsonb, analyzed_at timestamptz)`);
    const big = JSON.stringify({ summary: 'x'.repeat(200_000) });
    await sql.unsafe(`INSERT INTO statics_templates (name, category, image_url, deep_analysis, sort_order, created_at) VALUES
      ('linked', 'Meme', 'https://cdn.example/a.png', to_jsonb($1::text), 1, now() - interval '1 day'),
      ('inline', 'Meme', 'data:image/png;base64,' || repeat('A', 300000), NULL, 1, now()),
      ('hidden', 'Meme', 'https://cdn.example/h.png', NULL, 0, now()),
      ('uncat', 'Uncategorized', 'https://cdn.example/u.png', NULL, 0, now())`, [big]);
    await sql.unsafe(`UPDATE statics_templates SET is_hidden = true WHERE name = 'hidden'`);
    const cols = (await sql.unsafe(`SELECT column_name FROM information_schema.columns WHERE table_name = 'statics_templates' ORDER BY ordinal_position`)).map((r) => r.column_name);

    const { text, params } = templateListQuery(cols, {});
    const rows = (await sql.unsafe(text, params)).map((r) => r.r);
    assert.deepEqual(rows.map((r) => r.name), ['inline', 'linked'], 'hidden and Uncategorized excluded; newest first within a sort_order');
    const [inline, linked] = rows;
    assert.equal(inline.image_url, null); assert.equal(inline.image_url__inline, true);
    assert.equal(linked.image_url, 'https://cdn.example/a.png'); assert.equal(linked.image_url__inline, false);
    assert.equal(linked.has_analysis, true); assert.equal(inline.has_analysis, false);
    for (const r of rows) assert.ok(!('deep_analysis' in r), 'the analysis body never ships in the list');
    assert.ok(JSON.stringify(rows).length < 2_000, `list stays small: ${JSON.stringify(rows).length} bytes`);
    for (const k of ['id', 'category', 'tags', 'is_hidden', 'sort_order', 'created_at', 'analyzed_at']) assert.ok(k in linked, k);

    const withSearch = templateListQuery(cols, { search: 'LINK', showHidden: true });
    assert.deepEqual((await sql.unsafe(withSearch.text, withSearch.params)).map((r) => r.r.name), ['linked']);
  } finally {
    await sql.end();
    await admin.unsafe(`DROP DATABASE IF EXISTS ${db}`);
    await admin.end();
  }
});
