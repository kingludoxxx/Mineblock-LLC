// LANE A — S0b-3 MIGRATION RESET — acceptance tests (written BEFORE the code, R24).
//
// Drives the REAL runner (`node server/migrations/run.js`) as a child process
// against databases this file creates on the local Postgres 16 server
// (host 127.0.0.1, port 5433, user postgres, trust). Nothing here talks to a
// live service. Databases created: lane_migrations, lane_migrations_legacy,
// lane_migrations_068, lane_a2_mark, lane_a2_dry, lane_a2_ca, lane_a2_mbcopy (TEMPLATE mineblock_copy, only if it exists).
//
// Acceptance lines (brief LANE-A-MIGRATIONS.md):
//   A1 empty DB migrates 001→N with 0 errors, in the order of order.json
//   A2 _migrations gains checksum (sha256 of file bytes) + applied_order;
//      an edited already-applied file → refusal naming the file (on a COPY)
//   A3 legacy ledger (filename-only rows) → checksum backfilled ONCE, run continues
//   A4 only run.js writes _migrations (grep)
//   A5 068 has no EXCEPTION WHEN OTHERS; its failure is VISIBLE on a DB without the table
//   A6 missing order.json / listed-but-absent / unlisted / DB unreachable → clear error, non-zero
//   A7 copy of mineblock_copy (if present): dry-run → 0 pending, 0 mismatches
//
// Run:  node server/tests/migrations/migrations.mjs
import postgres from 'postgres';
import { spawnSync } from 'child_process';
import { readFileSync, readdirSync, cpSync, mkdtempSync, writeFileSync, appendFileSync, rmSync, renameSync, existsSync } from 'fs';
import { createHash } from 'crypto';
import { tmpdir } from 'os';
import { fileURLToPath } from 'url';
import { dirname, join, relative } from 'path';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO = join(HERE, '..', '..', '..');
const MIG_DIR = join(REPO, 'server', 'migrations');
const RUN_JS = join(MIG_DIR, 'run.js');
const PG = { host: '127.0.0.1', port: 5433, user: 'postgres' };
const ADMIN_URL = `postgres://${PG.user}@${PG.host}:${PG.port}/postgres`;
const dbUrl = (name) => `postgres://${PG.user}@${PG.host}:${PG.port}/${name}`;
const SCRATCH = process.env.LANE_SCRATCH || tmpdir();

let pass = 0, fail = 0, skip = 0;
const ok = (c, m, x = '') => { if (c) { pass++; console.log('PASS ', m); } else { fail++; console.log('FAIL ', m, x ? `\n      ${String(x).split('\n').join('\n      ')}` : ''); } };
const skipped = (m, why) => { skip++; console.log('SKIP ', m, `— ${why}`); };
const sha256 = (buf) => createHash('sha256').update(buf).digest('hex');
const tail = (s, n = 1200) => (s.length > n ? '…' + s.slice(-n) : s);

function runMigrate(env, args = []) {
  const r = spawnSync(process.execPath, [RUN_JS, ...args], {
    env: { ...process.env, ...env },
    encoding: 'utf8',
    timeout: 120000,
  });
  return { code: r.status, out: (r.stdout || '') + (r.stderr || ''), stdout: r.stdout || '', stderr: r.stderr || '' };
}

async function recreate(name) {
  const admin = postgres(ADMIN_URL, { ssl: false, onnotice: () => {} });
  await admin.unsafe(`DROP DATABASE IF EXISTS ${name}`);
  await admin.unsafe(`CREATE DATABASE ${name}`);
  await admin.end();
}
async function dbExists(name) {
  const admin = postgres(ADMIN_URL, { ssl: false, onnotice: () => {} });
  const r = await admin`SELECT 1 FROM pg_database WHERE datname = ${name}`;
  await admin.end();
  return r.length === 1;
}
async function ledger(url) {
  const sql = postgres(url, { ssl: false, onnotice: () => {} });
  try {
    const exists = (await sql`SELECT to_regclass('public._migrations') AS t`)[0].t;
    if (!exists) return null;
    const cols = (await sql`SELECT column_name FROM information_schema.columns WHERE table_schema='public' AND table_name='_migrations'`).map((r) => r.column_name);
    return cols.includes('checksum') && cols.includes('applied_order')
      ? await sql`SELECT id, filename, checksum, applied_order, executed_at FROM _migrations ORDER BY id`
      : await sql`SELECT id, filename, NULL::text AS checksum, NULL::int AS applied_order, executed_at FROM _migrations ORDER BY id`;
  } finally { await sql.end(); }
}
async function tableExists(url, table) {
  const sql = postgres(url, { ssl: false, onnotice: () => {} });
  try { return !!(await sql`SELECT to_regclass(${'public.' + table}) AS t`)[0].t; } finally { await sql.end(); }
}
async function columns(url, table) {
  const sql = postgres(url, { ssl: false, onnotice: () => {} });
  try {
    return (await sql`SELECT column_name FROM information_schema.columns WHERE table_schema='public' AND table_name=${table} ORDER BY column_name`).map((r) => r.column_name);
  } finally { await sql.end(); }
}
function loadManifestOrThrow() {
  const p = join(MIG_DIR, 'order.json');
  if (!existsSync(p)) throw new Error(`order.json missing at ${p}`);
  const m = JSON.parse(readFileSync(p, 'utf8'));
  if (!Array.isArray(m.order)) throw new Error('order.json has no "order" array');
  return m.order;
}
const onDiskSql = () => readdirSync(MIG_DIR).filter((f) => f.endsWith('.sql')).sort();
function copyMigrationsDir(label) {
  const dir = mkdtempSync(join(SCRATCH, `lane-a-${label}-`));
  cpSync(MIG_DIR, dir, { recursive: true });
  return dir;
}
const snapshot = (rows) => JSON.stringify(rows.map((r) => [r.id, r.filename, r.checksum, r.applied_order, String(r.executed_at)]));

// ═══════════════════════════════════════════════════════════════════════════
// A1 — empty database migrates 001→N with zero errors, in manifest order
// ═══════════════════════════════════════════════════════════════════════════
console.log('\n── A1 empty database ──');
const DB1 = dbUrl('lane_migrations');
await recreate('lane_migrations');
let manifest = [];
try { manifest = loadManifestOrThrow(); ok(true, 'A1.0 order.json present with an "order" array'); }
catch (e) { ok(false, 'A1.0 order.json present with an "order" array', e.message); }

const r1 = runMigrate({ DATABASE_URL: DB1 });
ok(r1.code === 0, 'A1.1 run.js exits 0 against an EMPTY database', tail(r1.out));
ok(!/\bFailed\b|error/i.test(r1.stderr), 'A1.2 nothing on stderr looks like a failure', tail(r1.stderr));
const led1 = await ledger(DB1);
ok(Array.isArray(led1) && led1.length === manifest.length && manifest.length > 0,
  `A1.3 ledger has one row per manifest entry (${led1?.length ?? 'no table'} vs manifest ${manifest.length})`);
ok(led1 && led1.map((r) => r.filename).join('\n') === manifest.join('\n'),
  'A1.4 ledger rows (by applied_order) are EXACTLY the manifest order');
ok(led1 && led1.every((r, i) => r.applied_order === i + 1),
  'A1.5 applied_order is 1..N in run order');
const disk = onDiskSql();
ok(disk.every((f) => manifest.includes(f)) && manifest.every((f) => disk.includes(f)),
  `A1.6 manifest == files on disk (disk ${disk.length}, manifest ${manifest.length})`,
  `disk-not-in-manifest: ${disk.filter((f) => !manifest.includes(f)).join(', ')} | manifest-not-on-disk: ${manifest.filter((f) => !disk.includes(f)).join(', ')}`);
for (const t of ['product_profiles', 'spy_custom_images', 'spy_creatives', 'advertorial_copies', 'ad_batches', 'spy_brand_follows', 'statics_queue']) {
  ok(await tableExists(DB1, t), `A1.7 table ${t} exists after a fresh migrate`);
}
const ppCols = await columns(DB1, 'product_profiles');
ok(['price_from', 'key_benefits', 'avatars', 'formats', 'master_brief', 'product_code'].every((c) => ppCols.includes(c)),
  'A1.8 product_profiles carries the columns 068/070/… add (price_from, key_benefits, avatars, formats, master_brief, product_code)', ppCols.join(','));
const iPP = manifest.findIndex((f) => /^12\d_.*product_profiles/.test(f));
const i017 = manifest.indexOf('017_create_spy_custom_images.sql');
ok(iPP >= 0 && i017 >= 0 && iPP < i017, `A1.9 the 120+ product_profiles migration precedes 017 in the manifest (idx ${iPP} < ${i017})`);
ok(manifest.indexOf('081_pl_renumber_stragglers.sql') < manifest.indexOf('081_reset_pl_brief_counter.sql'),
  'A1.10 manifest makes the 081 pair order explicit (renumber_stragglers BEFORE reset_pl_brief_counter)');

const r1b = runMigrate({ DATABASE_URL: DB1 });
const led1b = await ledger(DB1);
ok(r1b.code === 0 && /up to date/i.test(r1b.out) && snapshot(led1b) === snapshot(led1),
  'A1.11 second run: exit 0, "up to date", ledger byte-identical (idempotent)', tail(r1b.out, 400));

// ═══════════════════════════════════════════════════════════════════════════
// A2 — checksum + applied_order; an edited applied file is REFUSED by name
// ═══════════════════════════════════════════════════════════════════════════
console.log('\n── A2 checksum ledger ──');
const ledCols = await columns(DB1, '_migrations');
ok(ledCols.includes('checksum') && ledCols.includes('applied_order'), 'A2.1 _migrations has checksum + applied_order columns', ledCols.join(','));
const bad = (led1 || []).filter((r) => r.checksum !== sha256(readFileSync(join(MIG_DIR, r.filename))));
ok(led1 && bad.length === 0, `A2.2 every checksum == sha256(file bytes) (${bad.length} wrong)`, bad.map((r) => r.filename).join(','));

const editedDir = copyMigrationsDir('edited');
appendFileSync(join(editedDir, '001_create_roles.sql'), '\n-- edited after apply (test A2)\n');
const r2 = runMigrate({ DATABASE_URL: DB1, MIGRATIONS_DIR: editedDir });
ok(r2.code !== 0, 'A2.3 run REFUSES when an already-applied file changed (non-zero exit)', tail(r2.out));
ok(/001_create_roles\.sql/.test(r2.out) && /checksum/i.test(r2.out), 'A2.4 refusal names the file and says "checksum"', tail(r2.out, 600));
ok(snapshot(await ledger(DB1)) === snapshot(led1), 'A2.5 refusal wrote NOTHING to the ledger');
const r2d = runMigrate({ DATABASE_URL: DB1, MIGRATIONS_DIR: editedDir }, ['--dry-run']);
ok(r2d.code !== 0 && /mismatches:\s*1\b/.test(r2d.out) && /001_create_roles\.sql/.test(r2d.out),
  'A2.6 --dry-run reports the mismatch by name and exits non-zero', tail(r2d.out, 600));
rmSync(editedDir, { recursive: true, force: true });

// A2.7–A2.9 (review P1-1): a RENAMED applied file is a re-execution, not a new
// migration. Rename 001 on a COPY of the dir, list the new name in order.json:
// the old row becomes an orphan and the identical bytes show up as "pending".
const renamedDir = copyMigrationsDir('renamed');
renameSync(join(renamedDir, '001_create_roles.sql'), join(renamedDir, '001_create_roles_v2.sql'));
{
  const m = JSON.parse(readFileSync(join(renamedDir, 'order.json'), 'utf8'));
  m.order = m.order.map((f) => (f === '001_create_roles.sql' ? '001_create_roles_v2.sql' : f));
  writeFileSync(join(renamedDir, 'order.json'), JSON.stringify(m, null, 2));
}
const r27 = runMigrate({ DATABASE_URL: DB1, MIGRATIONS_DIR: renamedDir });
ok(r27.code !== 0 && /001_create_roles_v2\.sql/.test(r27.out) && /001_create_roles\.sql/.test(r27.out) && /renam/i.test(r27.out),
  'A2.7 renamed applied file (orphan row + pending file, SAME checksum) → REFUSED, message names both names and says rename', tail(r27.out, 700));
ok(snapshot(await ledger(DB1)) === snapshot(led1), 'A2.8 the rename refusal wrote NOTHING to the ledger (the bytes were not re-executed)');
const r27d = runMigrate({ DATABASE_URL: DB1, MIGRATIONS_DIR: renamedDir }, ['--dry-run']);
ok(r27d.code !== 0 && /001_create_roles_v2\.sql/.test(r27d.out) && /renam/i.test(r27d.out),
  'A2.9 --dry-run reports the rename by name and exits non-zero', tail(r27d.out, 700));
rmSync(renamedDir, { recursive: true, force: true });

// ═══════════════════════════════════════════════════════════════════════════
// A3 — LEGACY REMAP: filename-only ledger rows get checksum backfilled ONCE
// ═══════════════════════════════════════════════════════════════════════════
console.log('\n── A3 legacy ledger ──');
const DB3 = dbUrl('lane_migrations_legacy');
await recreate('lane_migrations_legacy');
{
  // Simulate a LIVE database as it exists today: product_profiles was created by
  // the ROUTE (productProfiles.js ensureTable) — extracted from that file so the
  // simulation cannot drift from it — then every pre-120 migration was applied
  // in plain lexicographic order by the OLD runner, which recorded filename only.
  const sql = postgres(DB3, { ssl: false, onnotice: () => {} });
  const routeSrc = readFileSync(join(REPO, 'server/src/routes/productProfiles.js'), 'utf8');
  const ddl = routeSrc.match(/CREATE TABLE IF NOT EXISTS product_profiles \([\s\S]*?\);/);
  const alters = routeSrc.match(/DO \$\$ BEGIN\s+ALTER TABLE product_profiles[\s\S]*?END \$\$;/);
  ok(!!ddl && !!alters, 'A3.0 route DDL for product_profiles extracted from productProfiles.js');
  await sql.unsafe(ddl[0]);
  await sql.unsafe(alters[0]);
  await sql.unsafe(`CREATE TABLE _migrations (id SERIAL PRIMARY KEY, filename VARCHAR(255) UNIQUE NOT NULL, executed_at TIMESTAMPTZ DEFAULT NOW())`);
  // Likewise creativeAnalysis.js ensureTable() added columns to creative_analysis
  // at runtime (meta_ad_id etc.) before 061 indexed them — extracted from the
  // route so the simulation cannot drift from it; applied right after 016.
  const caSrc = readFileSync(join(REPO, 'server/src/routes/creativeAnalysis.js'), 'utf8');
  const caAlters = caSrc.match(/ALTER TABLE creative_analysis ADD COLUMN IF NOT EXISTS [^;]+;/g) || [];
  ok(caAlters.length >= 3, `A3.0b route ADD COLUMN statements for creative_analysis extracted from creativeAnalysis.js (${caAlters.length})`);
  const legacyFiles = onDiskSql().filter((f) => f < '120_');
  let legacyFailed = null;
  for (const f of legacyFiles) {
    try {
      await sql.begin(async (tx) => {
        await tx.unsafe(readFileSync(join(MIG_DIR, f), 'utf8'));
        await tx.unsafe(`INSERT INTO _migrations (filename) VALUES ($1)`, [f]);
      });
      if (f === '016_create_creative_analysis.sql') for (const a of caAlters) await sql.unsafe(a);
    } catch (e) { legacyFailed = `${f}: ${e.message}`; break; }
  }
  await sql.end();
  ok(!legacyFailed, `A3.1 legacy seeding applied ${legacyFiles.length} pre-120 files lexicographically over a route-created product_profiles`, legacyFailed);
}
const led3before = await ledger(DB3);
ok(led3before && led3before.every((r) => r.checksum == null && r.applied_order == null),
  `A3.2 seeded ledger is legacy (${led3before?.length} rows, checksum/applied_order NULL)`);
const r3 = runMigrate({ DATABASE_URL: DB3 });
ok(r3.code === 0, 'A3.3 run.js on a legacy-ledger database exits 0', tail(r3.out));
ok(/backfill/i.test(r3.out) && new RegExp(`backfill[^\\n]*\\b${led3before.length}\\b`, 'i').test(r3.out),
  `A3.4 output says it backfilled ${led3before.length} legacy rows`, tail(r3.out, 800));
const led3 = await ledger(DB3);
ok(led3 && led3.every((r) => typeof r.checksum === 'string' && r.checksum.length === 64 && Number.isInteger(r.applied_order)),
  'A3.5 after the run every row has a 64-hex checksum and an applied_order');
const legacyRows = led3.filter((r) => led3before.some((b) => b.id === r.id));
ok(legacyRows.every((r, i) => r.applied_order === i + 1) && legacyRows.every((r) => r.checksum === sha256(readFileSync(join(MIG_DIR, r.filename)))),
  'A3.6 legacy rows: applied_order = rank by id, checksum = sha256 of current file bytes');
ok(legacyRows.every((r) => String(r.executed_at) === String(led3before.find((b) => b.id === r.id).executed_at)),
  'A3.7 backfill did not touch executed_at on legacy rows');
const newRows = led3.filter((r) => !led3before.some((b) => b.id === r.id));
ok(newRows.length === manifest.length - led3before.length && newRows.every((r) => /^1[2-9]\d_/.test(r.filename)),
  `A3.8 the run continued and applied the ${newRows.length} new (120+) file(s) after the backfill`, newRows.map((r) => r.filename).join(','));
ok(newRows.length > 0 && newRows[0].applied_order === led3before.length + 1, 'A3.9 new rows continue applied_order after the legacy rows');
const r3d = runMigrate({ DATABASE_URL: DB3 }, ['--dry-run']);
ok(r3d.code === 0 && /pending:\s*0\b/.test(r3d.out) && /mismatches:\s*0\b/.test(r3d.out),
  'A3.10 --dry-run afterwards: 0 pending, 0 mismatches, exit 0', tail(r3d.out, 500));
const r3c = runMigrate({ DATABASE_URL: DB3 });
ok(r3c.code === 0 && snapshot(await ledger(DB3)) === snapshot(led3), 'A3.11 backfill happened ONCE: a further run leaves every row byte-identical', tail(r3c.out, 300));

// A3.12 (review P2-1): --mark-applied on a LEGACY ledger must backfill the legacy
// rows first, so history order is preserved (legacy 1..N, marked file N+1) instead
// of the marked file taking applied_order 1 and the real history becoming 2..N+1.
{
  const DBM = dbUrl('lane_a2_mark');
  await recreate('lane_a2_mark');
  const sql = postgres(DBM, { ssl: false, onnotice: () => {} });
  await sql.unsafe(`CREATE TABLE _migrations (id SERIAL PRIMARY KEY, filename VARCHAR(255) UNIQUE NOT NULL, executed_at TIMESTAMPTZ DEFAULT NOW())`);
  for (const f of manifest.slice(0, 3)) await sql.unsafe(`INSERT INTO _migrations (filename) VALUES ($1)`, [f]);
  await sql.end();
  const rm = runMigrate({ DATABASE_URL: DBM }, ['--mark-applied', manifest[3]]);
  const lm = (await ledger(DBM)) || [];
  const want = manifest.slice(0, 4).map((f, i) => `${f}|${i + 1}`).join(',');
  const got = lm.map((r) => `${r.filename}|${r.applied_order}`).join(',');
  ok(rm.code === 0 && got === want && lm.every((r) => typeof r.checksum === 'string' && r.checksum.length === 64),
    `A3.12 --mark-applied on a legacy ledger: legacy rows backfilled FIRST (applied_order 1..3), marked file = 4, every row checksummed`, `exit=${rm.code} got: ${got}\n${tail(rm.out, 300)}`);
}

// ═══════════════════════════════════════════════════════════════════════════
// A4 — ONE ledger writer (grep)
// ═══════════════════════════════════════════════════════════════════════════
console.log('\n── A4 one writer ──');
{
  const WRITE_RE = /(INSERT\s+INTO|UPDATE|DELETE\s+FROM|CREATE\s+TABLE(\s+IF\s+NOT\s+EXISTS)?|ALTER\s+TABLE|DROP\s+TABLE(\s+IF\s+EXISTS)?)\s+_migrations\b/i;
  const hits = [];
  const walk = (dir) => {
    for (const e of readdirSync(dir, { withFileTypes: true })) {
      const p = join(dir, e.name);
      if (e.isDirectory()) { if (e.name !== 'node_modules' && e.name !== 'tests') walk(p); continue; }
      if (!/\.(m?js|sql)$/.test(e.name)) continue;
      readFileSync(p, 'utf8').split('\n').forEach((line, i) => { if (WRITE_RE.test(line)) hits.push(`${relative(REPO, p)}:${i + 1}: ${line.trim()}`); });
    }
  };
  walk(join(REPO, 'server'));
  console.log('      grep (write statements on _migrations):\n      ' + hits.join('\n      '));
  const files = [...new Set(hits.map((h) => h.split(':')[0]))];
  ok(!hits.some((h) => h.startsWith('server/src/server.js')), 'A4.1 server.js no longer writes _migrations (boot writer removed)');
  ok(!hits.some((h) => /staticsGeneration\.js:14[5-9]\d:/.test(h)), 'A4.2 staticsGeneration.js /admin-init-puure-schema block (~1472) no longer writes _migrations');
  // KNOWN GAP, documented in the proof pack + handoff: /admin-reconcile-migrations
  // (staticsGeneration.js ~1239-1300) is a SECOND deliberate writer the brief's
  // ownership list did not cover ("ONLY the block around 1472"). It is left
  // untouched here; run.js now exports markApplied() so the lead can swap it
  // in one line. The allowlist below is the honest current state, not the goal.
  const ALLOW = ['server/migrations/run.js', 'server/src/routes/staticsGeneration.js'];
  ok(files.every((f) => ALLOW.includes(f)) && files.includes('server/migrations/run.js'),
    `A4.3 writers ⊆ {run.js, staticsGeneration.js:/admin-reconcile-migrations (OPEN for the lead)} — found: ${files.join(', ')}`);
  const reconcileOnly = hits.filter((h) => h.includes('staticsGeneration.js')).every((h) => { const ln = +h.split(':')[1]; return ln >= 1228 && ln <= 1310; });
  ok(reconcileOnly, 'A4.4 the only remaining non-run.js write is inside /admin-reconcile-migrations (lines 1228-1310)');
  ok(/pg_advisory/.test(readFileSync(RUN_JS, 'utf8')), 'A4.5 run.js serialises itself with an advisory lock (two runners cannot interleave)');
}

// ═══════════════════════════════════════════════════════════════════════════
// A5 — 068 fails VISIBLY instead of swallowing errors
// ═══════════════════════════════════════════════════════════════════════════
console.log('\n── A5 migration 068 ──');
const m068 = readFileSync(join(MIG_DIR, '068_add_missing_product_columns.sql'), 'utf8');
const m068code = m068.split('\n').map((l) => l.replace(/--.*$/, '')).join('\n'); // strip SQL comments: judge code, not prose
ok(!/EXCEPTION\s+WHEN\s+OTHERS/i.test(m068code) && !/\bDO\s+\$\$/i.test(m068code), 'A5.1 068 code contains no EXCEPTION WHEN OTHERS / DO block');
ok((m068.match(/ADD COLUMN IF NOT EXISTS/g) || []).length === 4, 'A5.2 068 guards all four columns with ADD COLUMN IF NOT EXISTS');
const DB5 = dbUrl('lane_migrations_068');
await recreate('lane_migrations_068');
{
  const sql = postgres(DB5, { ssl: false, onnotice: () => {} });
  let err = null;
  try { await sql.unsafe(m068); } catch (e) { err = e; }
  ok(err && err.code === '42P01', 'A5.3 068 against a DB WITHOUT product_profiles FAILS VISIBLY (42P01 undefined_table)', err ? `${err.code} ${err.message}` : 'no error thrown');
  await sql.unsafe(`CREATE TABLE product_profiles (id SERIAL PRIMARY KEY, name TEXT NOT NULL)`);
  err = null;
  try { await sql.unsafe(m068); await sql.unsafe(m068); } catch (e) { err = e; }
  ok(!err, 'A5.4 068 with the table present applies, and applies AGAIN (idempotent)', err?.message);
  await sql.end();
  const c = await columns(DB5, 'product_profiles');
  ok(['price_from', 'key_benefits', 'avatars', 'formats'].every((x) => c.includes(x)), 'A5.5 068 added price_from, key_benefits, avatars, formats', c.join(','));
}

// ═══════════════════════════════════════════════════════════════════════════
// A6 — failure paths: clear message, non-zero exit, nothing written
// ═══════════════════════════════════════════════════════════════════════════
console.log('\n── A6 failure paths ──');
{
  const before = snapshot(await ledger(DB1));
  const d1 = copyMigrationsDir('noorder'); rmSync(join(d1, 'order.json'));
  const f1 = runMigrate({ DATABASE_URL: DB1, MIGRATIONS_DIR: d1 });
  ok(f1.code !== 0 && /order\.json/.test(f1.out), 'A6.1 missing order.json → non-zero exit, message names order.json', tail(f1.out, 400));

  const d2 = copyMigrationsDir('phantom');
  const m2 = JSON.parse(readFileSync(join(d2, 'order.json'), 'utf8')); m2.order.push('999_phantom.sql');
  writeFileSync(join(d2, 'order.json'), JSON.stringify(m2, null, 2));
  const f2 = runMigrate({ DATABASE_URL: DB1, MIGRATIONS_DIR: d2 });
  ok(f2.code !== 0 && /999_phantom\.sql/.test(f2.out), 'A6.2 file listed in order.json but absent on disk → non-zero, message names 999_phantom.sql', tail(f2.out, 400));

  const d3 = copyMigrationsDir('unlisted');
  writeFileSync(join(d3, '998_unlisted.sql'), 'SELECT 1;\n');
  const f3 = runMigrate({ DATABASE_URL: DB1, MIGRATIONS_DIR: d3 });
  ok(f3.code !== 0 && /998_unlisted\.sql/.test(f3.out), 'A6.3 .sql on disk but NOT in order.json → non-zero, message names 998_unlisted.sql', tail(f3.out, 400));

  const d4 = copyMigrationsDir('dupe');
  const m4 = JSON.parse(readFileSync(join(d4, 'order.json'), 'utf8')); m4.order.push(m4.order[0]);
  writeFileSync(join(d4, 'order.json'), JSON.stringify(m4, null, 2));
  const f4 = runMigrate({ DATABASE_URL: DB1, MIGRATIONS_DIR: d4 });
  ok(f4.code !== 0 && /duplicate/i.test(f4.out) && f4.out.includes(m4.order[0]), 'A6.4 duplicate entry in order.json → non-zero, message says duplicate + names it', tail(f4.out, 400));

  const d5 = copyMigrationsDir('badjson'); writeFileSync(join(d5, 'order.json'), '{ not json');
  const f5 = runMigrate({ DATABASE_URL: DB1, MIGRATIONS_DIR: d5 });
  ok(f5.code !== 0 && /order\.json/.test(f5.out), 'A6.5 unparseable order.json → non-zero, message names order.json', tail(f5.out, 400));

  const f6 = runMigrate({ DATABASE_URL: `postgres://${PG.user}@127.0.0.1:1/nowhere` });
  ok(f6.code !== 0 && /ECONNREFUSED|connect|unreachable/i.test(f6.out), 'A6.6 DB unreachable → non-zero exit with a connection message', tail(f6.out, 400));

  const env7 = { ...process.env }; delete env7.DATABASE_URL;
  const r7 = spawnSync(process.execPath, [RUN_JS], { env: env7, encoding: 'utf8' });
  ok(r7.status !== 0 && /DATABASE_URL/.test((r7.stdout || '') + (r7.stderr || '')), 'A6.7 no DATABASE_URL → non-zero exit, message names DATABASE_URL', tail((r7.stdout || '') + (r7.stderr || ''), 400));

  // A6.9–A6.11 (review P1-1 / P2-3): "skip by deletion" — an applied file deleted
  // from disk AND removed from order.json leaves an orphan ledger row. Non-STRICT:
  // the run continues but the orphan is a VISIBLE warning naming the file.
  // STRICT (--strict flag or STRICT_MIGRATIONS=1): the run REFUSES.
  const d6 = copyMigrationsDir('deleted');
  rmSync(join(d6, '099_static_ad_naming.sql'));
  const m6 = JSON.parse(readFileSync(join(d6, 'order.json'), 'utf8')); m6.order = m6.order.filter((f) => f !== '099_static_ad_naming.sql');
  writeFileSync(join(d6, 'order.json'), JSON.stringify(m6, null, 2));
  const f9 = runMigrate({ DATABASE_URL: DB1, MIGRATIONS_DIR: d6 });
  ok(f9.code === 0 && /WARNING[^\n]*099_static_ad_naming\.sql/.test(f9.out) && /orphan/i.test(f9.out),
    'A6.9 deleted + de-listed applied file, non-STRICT → exit 0 but a visible WARNING line naming the orphan', tail(f9.out, 500));
  const f10 = runMigrate({ DATABASE_URL: DB1, MIGRATIONS_DIR: d6 }, ['--strict']);
  ok(f10.code !== 0 && /099_static_ad_naming\.sql/.test(f10.out) && /orphan/i.test(f10.out) && /REFUS/i.test(f10.out),
    'A6.10 same under --strict → REFUSED, message names the orphan', tail(f10.out, 500));
  const f11 = runMigrate({ DATABASE_URL: DB1, MIGRATIONS_DIR: d6, STRICT_MIGRATIONS: '1' }, ['--dry-run']);
  ok(f11.code !== 0 && /099_static_ad_naming\.sql/.test(f11.out),
    'A6.11 STRICT_MIGRATIONS=1 --dry-run with an orphan → exits non-zero, names it', tail(f11.out, 500));

  // A6.12–A6.15 (review P2-2): a preflight gate must be able to trust --dry-run's
  // exit code as "is this database current". Pending files → non-zero, unless the
  // caller says --allow-pending (the pre-apply rehearsal case). Never writes.
  const DB6 = dbUrl('lane_a2_dry');
  await recreate('lane_a2_dry');
  const f12 = runMigrate({ DATABASE_URL: DB6 }, ['--dry-run']);
  ok(f12.code !== 0 && /pending:\s*[1-9]\d*/.test(f12.out), 'A6.12 --dry-run with pending files exits NON-zero (reports the count)', tail(f12.out, 300));
  const f13 = runMigrate({ DATABASE_URL: DB6 }, ['--dry-run', '--allow-pending']);
  ok(f13.code === 0 && /pending:\s*[1-9]\d*/.test(f13.out), 'A6.13 --dry-run --allow-pending (rehearsal) exits 0 with the same pending files', tail(f13.out, 300));
  ok((await ledger(DB6)) === null, 'A6.14 neither dry-run created the ledger table (no writes)');
  const f15 = runMigrate({ DATABASE_URL: DB6 }, ['--allow-pending']);
  ok(f15.code !== 0 && /allow-pending/.test(f15.out) && /dry-run/.test(f15.out) && (await ledger(DB6)) === null,
    'A6.15 --allow-pending without --dry-run is refused (names both flags), nothing applied', tail(f15.out, 300));

  ok(snapshot(await ledger(DB1)) === before, 'A6.8 none of the failure paths wrote to the ledger');
  for (const d of [d1, d2, d3, d4, d5, d6]) rmSync(d, { recursive: true, force: true });
}

// ═══════════════════════════════════════════════════════════════════════════
// A7 — copy of a live database (mineblock_copy) → 0 pending, 0 mismatches
// ═══════════════════════════════════════════════════════════════════════════
console.log('\n── A7 live-copy dry run ──');
let DB7 = null;
if (await dbExists('mineblock_copy')) {
  const admin = postgres(ADMIN_URL, { ssl: false, onnotice: () => {} });
  await admin.unsafe('DROP DATABASE IF EXISTS lane_a2_mbcopy');
  await admin.unsafe('CREATE DATABASE lane_a2_mbcopy TEMPLATE mineblock_copy');
  await admin.end();
  DB7 = dbUrl('lane_a2_mbcopy');
  const pre = runMigrate({ DATABASE_URL: DB7 }, ['--dry-run']);
  console.log('      pre-apply dry-run:\n      ' + tail(pre.out, 900).split('\n').join('\n      '));
  const ap = runMigrate({ DATABASE_URL: DB7 });
  ok(ap.code === 0, 'A7.1 run.js on the live copy exits 0 (legacy backfill + 120+ applied)', tail(ap.out));
  const dr = runMigrate({ DATABASE_URL: DB7 }, ['--dry-run']);
  ok(dr.code === 0 && /pending:\s*0\b/.test(dr.out) && /mismatches:\s*0\b/.test(dr.out), 'A7.2 --dry-run on the live copy: 0 pending, 0 mismatches', tail(dr.out, 600));
} else {
  skipped('A7 live-copy dry run', 'precondition unmet: database mineblock_copy does not exist on 127.0.0.1:5433 (no restored dump)');
}

// ═══════════════════════════════════════════════════════════════════════════
// A8 — review P1-2: a FRESH database ends with creative_analysis in the LIVE
// shape (mineblock_copy's information_schema), and the route can insert into it
// ═══════════════════════════════════════════════════════════════════════════
console.log('\n── A8 fresh creative_analysis == live shape (P1-2) ──');
async function shape(url) {
  const sql = postgres(url, { ssl: false, onnotice: () => {} });
  try {
    return await sql`SELECT column_name, data_type, character_maximum_length, numeric_precision, numeric_scale, is_nullable, column_default
                       FROM information_schema.columns WHERE table_schema = 'public' AND table_name = 'creative_analysis' ORDER BY column_name`;
  } finally { await sql.end(); }
}
const shapeLines = (rows) => rows.map((r) => [r.column_name, r.data_type, r.character_maximum_length, r.numeric_precision, r.numeric_scale, r.is_nullable, r.column_default].map((v) => v ?? '-').join('|'));
const shapeDiff = (fresh, live) => [
  ...fresh.filter((l) => !live.includes(l)).map((l) => `fresh-only: ${l}`),
  ...live.filter((l) => !fresh.includes(l)).map((l) => `live-only:  ${l}`),
];
async function uniques(url) {
  const sql = postgres(url, { ssl: false, onnotice: () => {} });
  try { return (await sql`SELECT pg_get_constraintdef(oid) AS d FROM pg_constraint WHERE conrelid = 'public.creative_analysis'::regclass AND contype = 'u'`).map((r) => r.d); }
  finally { await sql.end(); }
}
const caRoute = readFileSync(join(REPO, 'server/src/routes/creativeAnalysis.js'), 'utf8');
const insertMatch = caRoute.match(/INSERT INTO creative_analysis\s*\(([^)]*)\)\s*VALUES\s*\(((?:[^()]|\([^()]*\))*)\)/); // value list may contain NOW()
ok(!!insertMatch, 'A8.0 the route INSERT column list extracted from creativeAnalysis.js');
async function routeInsert(url) {
  // The route's own INSERT (columns + placeholders verbatim from the source), with a
  // 25-char synthetic creative_id like the naming-agnostic sync produces. Rolled back.
  const sql = postgres(url, { ssl: false, onnotice: () => {} });
  const params = ['A8 synthetic ad', 'AUTO-' + 'x'.repeat(20), 'H1', 'video', 'avatar', 'angle', 'format', 'editor', '2026-W37',
    1.5, 3, 2, 100, 10, 2, 0.75, 15, 1.5, 0.15, 10, true, 'act_1', 'acct'];
  let id, err;
  try {
    await sql.begin(async (tx) => {
      const r = await tx.unsafe(`INSERT INTO creative_analysis (${insertMatch[1]}) VALUES (${insertMatch[2]}) RETURNING id`, params);
      id = r[0].id;
      throw new Error('ROLLBACK_A8');
    });
  } catch (e) { if (e.message !== 'ROLLBACK_A8') err = e; }
  finally { await sql.end(); }
  return { id, err };
}
const freshShape = shapeLines(await shape(DB1));
if (await dbExists('mineblock_copy')) {
  const liveShape = shapeLines(await shape(dbUrl('mineblock_copy')));
  const d81 = shapeDiff(freshShape, liveShape);
  ok(d81.length === 0 && freshShape.length === liveShape.length,
    `A8.1 fresh DB creative_analysis == mineblock_copy on (name, type, length, precision, scale, nullability, default) (${freshShape.length} vs ${liveShape.length} columns)`, d81.join('\n'));
  if (DB7) {
    const copyShape = shapeLines(await shape(DB7));
    ok(shapeDiff(copyShape, liveShape).length === 0, 'A8.4 the full run (incl. 122) is a NO-OP on the live copy: its shape still == mineblock_copy', shapeDiff(copyShape, liveShape).join('\n'));
  }
} else {
  skipped('A8.1 fresh == mineblock_copy shape', 'precondition unmet: database mineblock_copy does not exist');
  skipped('A8.4 122 no-op on the live copy', 'precondition unmet: database mineblock_copy does not exist');
}
const u1 = await uniques(DB1);
ok(u1.some((d) => /\(creative_id, hook_id, week\)/.test(d)) && !u1.some((d) => /\(creative_id, hook_id\)/.test(d)),
  "A8.2 fresh has the route's UNIQUE (creative_id, hook_id, week) (its ON CONFLICT target) and not the 016 pair", u1.join(' ; '));
const ins = await routeInsert(DB1);
ok(!ins.err && typeof ins.id === 'number', "A8.3 the route's INSERT (23 columns, 25-char creative_id) succeeds on the fresh DB and RETURNING id is an integer", ins.err ? ins.err.message : `id=${JSON.stringify(ins.id)}`);
{
  // A8.5 idempotent: apply 122 a second time on the fresh DB → no error, shape unchanged
  const f122 = manifest.find((f) => /^122_/.test(f));
  const sql = postgres(DB1, { ssl: false, onnotice: () => {} });
  let err = null;
  try { if (!f122) throw new Error('no 122_* file in order.json'); await sql.unsafe(readFileSync(join(MIG_DIR, f122), 'utf8')); } catch (e) { err = e; }
  await sql.end();
  ok(!err && shapeLines(await shape(DB1)).join('\n') === freshShape.join('\n'), 'A8.5 122 applied a second time: no error, shape unchanged (idempotent)', err?.message);
}
{
  // A8.6 failure path: a NON-EMPTY table that still has the 016 shape (uuid id) is
  // neither fresh nor live. 122 must keep its rows, add what the route needs, and
  // say so with a WARNING that run.js prints; it must not fail the run.
  const DB8 = dbUrl('lane_a2_ca');
  await recreate('lane_a2_ca');
  const sql = postgres(DB8, { ssl: false, onnotice: () => {} });
  await sql.unsafe('CREATE EXTENSION IF NOT EXISTS "uuid-ossp"');
  await sql.unsafe(readFileSync(join(MIG_DIR, '016_create_creative_analysis.sql'), 'utf8'));
  await sql.unsafe(`INSERT INTO creative_analysis (ad_name, creative_id, hook_id, creative_type) VALUES ('pre-existing', 'IM001', 'H1', 'video')`);
  await sql.end();
  const r86 = runMigrate({ DATABASE_URL: DB8 });
  const s86 = await shape(DB8);
  const idType = s86.find((r) => r.column_name === 'id')?.data_type;
  const sql2 = postgres(DB8, { ssl: false, onnotice: () => {} });
  const rows = await sql2`SELECT count(*)::int AS n FROM creative_analysis`;
  await sql2.end();
  ok(r86.code === 0 && /WARNING[^\n]*122_creative_analysis_fresh_shape[^\n]*\bid\b/.test(r86.out),
    'A8.6 non-empty uuid-shaped creative_analysis: the run exits 0 and run.js PRINTS the migration\'s WARNING naming 122 and the id divergence', tail(r86.out, 700));
  ok(idType === 'uuid' && rows[0].n === 1 && s86.some((r) => r.column_name === 'type') && s86.find((r) => r.column_name === 'creative_id')?.data_type === 'text',
    `A8.7 …its row survived (${rows[0].n}), id stayed ${idType}, and the route's needs (type column, TEXT creative_id) were still added`);
}

console.log(`\n${pass} passed, ${fail} failed, ${skip} skipped`);
process.exit(fail ? 1 : 0);
