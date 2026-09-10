// test-timeout: 300s
// S4-SB — the operator-research IMPORT CLI, proven on a fixture folder.
//
//   npm run brain:import -- --product <CODE> --source "operator research" <folder>
//
// Asserts BY EXECUTION:
//   C1 three fixture files (.md/.txt/.json) ingest as three documents
//   C2 a SECOND run over the same folder adds 0 new documents (idempotent by hash)
//   C3 an edited file is a NEW document (the hash is the identity, not the path)
//   C4 non-ingestable extensions are skipped, not silently mangled
//   C5 failure paths: missing folder, unknown product code, missing --source,
//       unreadable DSN — each exits non-zero with a message naming the problem
//
// Run:  node server/tests/brain/brain-import.mjs
import postgres from 'postgres';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, writeFileSync, rmSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO = join(HERE, '..', '..', '..');
const CLI = join(REPO, 'server/scripts/brain-import.mjs');
const PG = 'postgres://postgres@127.0.0.1:5433';
const DBNAME = 's4_brain_import';
const DB = `${PG}/${DBNAME}`;
const PRODUCT_CODES_JSON = JSON.stringify({ AAA: { default: true } });

let pass = 0, fail = 0;
const ok = (c, m, x = '') => { if (c) { pass++; console.log('PASS ', m); } else { fail++; console.log('FAIL ', m, x ? `\n      ${String(x).split('\n').join('\n      ')}` : ''); } };

const admin = postgres(`${PG}/postgres`, { ssl: false, onnotice: () => {} });
await admin.unsafe(`DROP DATABASE IF EXISTS ${DBNAME}`);
await admin.unsafe(`CREATE DATABASE ${DBNAME}`);
await admin.end();

const mig = spawnSync(process.execPath, [join(REPO, 'server/migrations/run.js')], {
  env: { ...process.env, DATABASE_URL: DB, MIGRATE_SSL: '0', STORE_CODE: 'SA' },
  encoding: 'utf8', timeout: 180000,
});
ok(mig.status === 0, 'C0.1 import test database migrated', (mig.stdout || '') + (mig.stderr || ''));

const FIX = mkdtempSync(join(tmpdir(), 's4-brain-fixture-'));
mkdirSync(join(FIX, 'sub'), { recursive: true });
writeFileSync(join(FIX, 'avatar-notes.md'), '# Avatar notes\n\nShe is 42, runs three times a week, and hates the smell of menthol gels.\n');
writeFileSync(join(FIX, 'call-transcript.txt'), 'Operator: what made you look for this?\nCustomer: my knee locked up on a stairwell and I panicked.\n');
writeFileSync(join(FIX, 'sub', 'competitor-prices.json'), JSON.stringify({ competitors: [{ name: 'rival one', price: 39 }, { name: 'rival two', price: 55 }] }, null, 2));
writeFileSync(join(FIX, 'photo.png'), Buffer.from([0x89, 0x50, 0x4e, 0x47]));

function run(args, env = {}) {
  const r = spawnSync(process.execPath, [CLI, ...args], {
    env: { ...process.env, DATABASE_URL: DB, DATABASE_SSL: '0', PRODUCT_CODES_JSON, NODE_ENV: 'development', ...env },
    encoding: 'utf8', timeout: 120000,
  });
  return { code: r.status, out: (r.stdout || '') + (r.stderr || '') };
}

const sql = postgres(DB, { ssl: false, onnotice: () => {} });
const count = async () => (await sql`SELECT count(*)::int AS n FROM kb_documents`)[0].n;

// ── C1 first run ───────────────────────────────────────────────────────────
const r1 = run(['--product', 'AAA', '--source', 'operator research', FIX]);
ok(r1.code === 0, 'C1.1 first import exits 0', r1.out);
ok(/new:\s*3\b/.test(r1.out), 'C1.2 …and reports new: 3', r1.out);
ok(await count() === 3, 'C1.3 …three documents in kb_documents', String(await count()));
{
  const rows = await sql`SELECT source, product_code, body_object_key, byte_size FROM kb_documents ORDER BY id`;
  ok(rows.every((r) => r.source === 'operator research' && r.product_code === 'AAA'),
    'C1.4 every row carries source="operator research" and the product code', JSON.stringify(rows.map((r) => [r.source, r.product_code])));
  ok(rows.every((r) => /^knowledge\/raw\/operator-research\/\d{4}-\d{2}-\d{2}\/[0-9a-f]{64}\.(txt|md|json)$/.test(r.body_object_key || '')),
    'C1.5 …and a bucket key under knowledge/raw/<source>/<date>/', JSON.stringify(rows.map((r) => r.body_object_key)));
}
ok(!/photo\.png/.test(r1.out) || /skipped/.test(r1.out), 'C4.1 the .png is skipped, not ingested', r1.out);
ok(await count() === 3, 'C4.2 …the binary did not become a document', String(await count()));

// ── C2 second run: 0 new ───────────────────────────────────────────────────
const r2 = run(['--product', 'AAA', '--source', 'operator research', FIX]);
ok(r2.code === 0, 'C2.1 second import exits 0', r2.out);
ok(/new:\s*0\b/.test(r2.out), 'C2.2 …and reports new: 0 (idempotent)', r2.out);
ok(await count() === 3, 'C2.3 …still three documents', String(await count()));

// ── C3 an edit is a new document ───────────────────────────────────────────
writeFileSync(join(FIX, 'avatar-notes.md'), '# Avatar notes\n\nShe is 42 and now she also swims on Sundays.\n');
const r3 = run(['--product', 'AAA', '--source', 'operator research', FIX]);
ok(/new:\s*1\b/.test(r3.out) && await count() === 4,
  'C3.1 an EDITED file is a new immutable document (hash is the identity); the original survives', r3.out);

// ── C5 failure paths ───────────────────────────────────────────────────────
{
  const r = run(['--product', 'AAA', '--source', 'operator research', join(FIX, 'does-not-exist')]);
  ok(r.code !== 0 && /not a (readable )?(directory|folder)|no such/i.test(r.out),
    'C5.1 FAILURE PATH: a missing folder exits non-zero naming the path', r.out);
}
{
  const r = run(['--product', 'ZZZ', '--source', 'operator research', FIX]);
  ok(r.code !== 0 && /product/i.test(r.out), 'C5.2 FAILURE PATH: an unknown product code is refused', r.out);
}
{
  const r = run(['--product', 'AAA', FIX]);
  ok(r.code !== 0 && /--source/.test(r.out), 'C5.3 FAILURE PATH: a missing --source is refused', r.out);
}
{
  // The name is BUILT AT RUNTIME on purpose. run-all.mjs preflights every DSN it
  // can find in a test file and CREATES the database — a literal name here would
  // have been created for us and this failure path would have silently passed.
  const absent = ['s4', 'brain', 'absent', String(process.pid), String(Date.now())].join('_');
  const admin2 = postgres(`${PG}/postgres`, { ssl: false, onnotice: () => {} });
  await admin2.unsafe(`DROP DATABASE IF EXISTS ${absent}`);
  await admin2.end();
  const r = run(['--product', 'AAA', '--source', 'operator research', FIX],
    { DATABASE_URL: `${PG}/${absent}` });
  ok(r.code !== 0 && /does not exist|ECONNREFUSED|database/i.test(r.out),
    'C5.4 FAILURE PATH: an unreachable database exits non-zero with the real error, never "0 new"', r.out);
  ok(new RegExp(`"${absent}" does not exist`).test(r.out),
    'C5.4b …and the message names the database it could not reach', r.out.slice(-300));
}
{
  const empty = mkdtempSync(join(tmpdir(), 's4-brain-empty-'));
  const r = run(['--product', 'AAA', '--source', 'operator research', empty]);
  ok(r.code !== 0 && /no ingestable/i.test(r.out),
    'C5.5 FAILURE PATH: a folder with nothing ingestable is an ERROR, not a silent success', r.out);
  rmSync(empty, { recursive: true, force: true });
}

await sql.end();
rmSync(FIX, { recursive: true, force: true });
console.log(`\n${pass} passed, ${fail} failed, 0 skipped`);
process.exit(fail ? 1 : 0);
