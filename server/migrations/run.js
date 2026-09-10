#!/usr/bin/env node
/**
 * server/migrations/run.js — THE ONLY WRITER of the `_migrations` ledger (S0b-3).
 *
 * ORDER   server/migrations/order.json  { "order": ["001_….sql", …] }
 *         The manifest IS the run order; the numeric prefix is not. Every .sql
 *         file in the directory must be listed exactly once and every listed
 *         file must exist, otherwise the run refuses BEFORE touching the DB.
 *         New files go at the END of "order" unless they must precede an
 *         existing dependent (then directly before that dependent).
 * LEDGER  _migrations(id, filename UNIQUE, executed_at,
 *           checksum      sha256 hex of the file BYTES as applied,
 *           applied_order 1-based sequence in which THIS database applied it)
 *         Legacy rows (filename only, from the pre-checksum runner) are
 *         backfilled ONCE from the current file bytes; the run then continues.
 *         An already-applied file whose bytes changed → the run REFUSES and
 *         names the file. Applied migrations are immutable: add a new one.
 *         A RENAMED applied file (pending file whose checksum equals an orphan
 *         ledger row's checksum) is a re-execution in disguise → REFUSED.
 *         An ORPHAN row (applied here, no such file on disk any more) is a
 *         visible WARNING, and a refusal under STRICT.
 * STRICT  --strict or STRICT_MIGRATIONS=1: orphans refuse instead of warn.
 * LOCK    pg_advisory_lock serialises runners; two cannot interleave.
 * OUTPUT  Database WARNINGs raised by a migration are printed (`WARNING (database): …`).
 *
 * CLI     node server/migrations/run.js [--dry-run] [--strict] [--dir <path>] [--mark-applied a.sql,b.sql]
 * ENV     DATABASE_URL (required) · MIGRATIONS_DIR (= --dir) · STRICT_MIGRATIONS=1 (= --strict)
 *         MIGRATE_SSL=0|1 (default auto: off for localhost/127.0.0.1/sslmode=disable, on otherwise)
 * EXIT    0 clean · 1 any error or refusal; a dry run also exits 1 on a checksum
 *         mismatch, a rename, or (STRICT) an orphan
 *
 * LIBRARY server.js and admin routes import { checkPending } for a READ-ONLY
 *         report. Nothing outside this file writes the ledger.
 */
import pg from 'pg';
import fs from 'fs';
import path from 'path';
import crypto from 'crypto';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

export const DEFAULT_DIR = __dirname;
export const MANIFEST_NAME = 'order.json';
const LOCK_KEY = 726174710; // arbitrary constant: one migration runner per database at a time

export class MigrationError extends Error {
  constructor(message) { super(message); this.name = 'MigrationError'; }
}

export const sha256 = (buf) => crypto.createHash('sha256').update(buf).digest('hex');

/** Read + validate order.json. Throws MigrationError with a message naming the offending file(s). */
export function loadManifest(dir = DEFAULT_DIR) {
  const manifestPath = path.join(dir, MANIFEST_NAME);
  if (!fs.existsSync(manifestPath)) {
    throw new MigrationError(`order.json not found at ${manifestPath} — the run-order manifest (server/migrations/order.json) is required`);
  }
  let parsed;
  try {
    parsed = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
  } catch (err) {
    throw new MigrationError(`order.json is not valid JSON (${manifestPath}): ${err.message}`);
  }
  const order = parsed && parsed.order;
  if (!Array.isArray(order) || !order.every((f) => typeof f === 'string')) {
    throw new MigrationError(`order.json (${manifestPath}) must contain an "order" array of migration filenames`);
  }
  const notSql = order.filter((f) => !f.endsWith('.sql') || f.includes('/') || f.includes('\\'));
  if (notSql.length) throw new MigrationError(`order.json entries must be bare .sql filenames: ${notSql.join(', ')}`);
  const seen = new Set();
  const dupes = new Set();
  for (const f of order) { if (seen.has(f)) dupes.add(f); seen.add(f); }
  if (dupes.size) {
    throw new MigrationError(`order.json lists duplicate entr${dupes.size > 1 ? 'ies' : 'y'}: ${[...dupes].join(', ')}`);
  }
  const onDisk = fs.readdirSync(dir).filter((f) => f.endsWith('.sql'));
  const absent = order.filter((f) => !onDisk.includes(f));
  if (absent.length) throw new MigrationError(`order.json lists file(s) that do not exist in ${dir}: ${absent.join(', ')}`);
  const unlisted = onDisk.filter((f) => !seen.has(f)).sort();
  if (unlisted.length) {
    throw new MigrationError(`migration file(s) present in ${dir} but NOT listed in order.json (add them at the right position): ${unlisted.join(', ')}`);
  }
  return order;
}

/** filename → { sql, checksum } for the given filenames (bytes hashed, not the decoded string). */
export function readMigrationFiles(dir, filenames) {
  const files = new Map();
  for (const f of filenames) {
    const bytes = fs.readFileSync(path.join(dir, f));
    files.set(f, { sql: bytes.toString('utf8'), checksum: sha256(bytes) });
  }
  return files;
}

/** Read-only view of the ledger; tolerates a missing table and the legacy (no checksum column) shape. */
export async function readLedger(client) {
  const { rows: [{ t }] } = await client.query(`SELECT to_regclass('public._migrations') AS t`);
  if (!t) return { exists: false, hasChecksumColumns: false, rows: [] };
  const { rows: cols } = await client.query(
    `SELECT column_name FROM information_schema.columns WHERE table_schema = 'public' AND table_name = '_migrations'`
  );
  const names = new Set(cols.map((c) => c.column_name));
  const hasChecksumColumns = names.has('checksum') && names.has('applied_order');
  const { rows } = await client.query(hasChecksumColumns
    ? 'SELECT id, filename, checksum, applied_order FROM _migrations ORDER BY id'
    : 'SELECT id, filename, NULL::text AS checksum, NULL::int AS applied_order FROM _migrations ORDER BY id');
  return { exists: true, hasChecksumColumns, rows };
}

/**
 * READ-ONLY comparison of manifest + files on disk vs the ledger.
 * { order, files, ledger, applied[], pending[], legacy[], mismatches[{filename, ledger, disk}], orphans[], clean }
 */
export async function computeReport(client, { dir = DEFAULT_DIR } = {}) {
  const order = loadManifest(dir);
  const files = readMigrationFiles(dir, order);
  const ledger = await readLedger(client);
  const byName = new Map(ledger.rows.map((r) => [r.filename, r]));
  const applied = order.filter((f) => byName.has(f));
  const pending = order.filter((f) => !byName.has(f));
  const legacy = ledger.rows.filter((r) => files.has(r.filename) && (r.checksum == null || r.applied_order == null));
  const mismatches = ledger.rows
    .filter((r) => files.has(r.filename) && r.checksum != null && r.checksum !== files.get(r.filename).checksum)
    .map((r) => ({ filename: r.filename, ledger: r.checksum, disk: files.get(r.filename).checksum }));
  const orphanRows = ledger.rows.filter((r) => !files.has(r.filename));
  const orphans = orphanRows.map((r) => r.filename);
  // A pending file whose bytes equal an orphan row's bytes is that row's file
  // RENAMED (the manifest was edited to match): running it would re-execute an
  // applied migration. Legacy orphans (checksum NULL) cannot be matched this
  // way; STRICT catches those by refusing every orphan.
  const orphanByChecksum = new Map(orphanRows.filter((r) => r.checksum != null).map((r) => [r.checksum, r.filename]));
  const renames = pending
    .filter((f) => orphanByChecksum.has(files.get(f).checksum))
    .map((f) => ({ pending: f, orphan: orphanByChecksum.get(files.get(f).checksum), checksum: files.get(f).checksum }));
  return {
    dir, order, files, ledger, applied, pending, legacy, mismatches, orphans, renames,
    clean: pending.length === 0 && mismatches.length === 0,
  };
}

/** Alias used by server.js and admin routes: a read-only check, never writes. */
export const checkPending = computeReport;

export function formatSummary(r, { dryRun = false } = {}) {
  return `${dryRun ? 'DRY RUN — ' : ''}applied: ${r.applied.length} | pending: ${r.pending.length} | mismatches: ${r.mismatches.length}`
    + ` | legacy (no checksum): ${r.legacy.length} | orphans (ledger rows without a file): ${r.orphans.length}`
    + (r.renames.length ? ` | renamed applied files: ${r.renames.length}` : '');
}

const renameLines = (r) => r.renames.map((x) => `  ${x.pending} has the same checksum as orphan ledger row ${x.orphan} (sha256 ${x.checksum})`);
const orphanLine = (f) => `orphan ledger row ${f}: applied on this database but no such file is on disk or in order.json`
  + ' — a deleted migration never runs on a fresh database; STRICT refuses this';

async function ensureLedger(client) {
  await client.query(`
    CREATE TABLE IF NOT EXISTS _migrations (
      id SERIAL PRIMARY KEY,
      filename VARCHAR(255) UNIQUE NOT NULL,
      executed_at TIMESTAMPTZ DEFAULT NOW(),
      checksum TEXT,
      applied_order INTEGER
    )
  `);
  await client.query('ALTER TABLE _migrations ADD COLUMN IF NOT EXISTS checksum TEXT');
  await client.query('ALTER TABLE _migrations ADD COLUMN IF NOT EXISTS applied_order INTEGER');
  await client.query('CREATE UNIQUE INDEX IF NOT EXISTS _migrations_applied_order_key ON _migrations (applied_order)');
}

/** A3: legacy rows get checksum = sha256(current bytes) and applied_order = rank by id, ONCE. */
async function backfillLegacy(client, report) {
  if (!report.legacy.length) return 0;
  await client.query('BEGIN');
  try {
    const { rows: [{ max }] } = await client.query('SELECT COALESCE(MAX(applied_order), 0) AS max FROM _migrations');
    let next = Number(max);
    for (const row of report.legacy) { // ledger rows arrive ordered by id
      const appliedOrder = row.applied_order == null ? ++next : row.applied_order;
      await client.query(
        'UPDATE _migrations SET checksum = COALESCE(checksum, $1), applied_order = $2 WHERE id = $3',
        [report.files.get(row.filename).checksum, appliedOrder, row.id]
      );
    }
    await client.query('COMMIT');
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  }
  return report.legacy.length;
}

const INSERT_LEDGER_ROW = `
  INSERT INTO _migrations (filename, checksum, applied_order)
  VALUES ($1, $2, (SELECT COALESCE(MAX(applied_order), 0) + 1 FROM _migrations))`;

async function applyOne(client, filename, file) {
  await client.query('BEGIN');
  try {
    await client.query(file.sql);
    await client.query(INSERT_LEDGER_ROW, [filename, file.checksum]);
    await client.query('COMMIT');
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  }
}

async function withLock(client, fn, log) {
  await client.query('SELECT pg_advisory_lock($1)', [LOCK_KEY]);
  try {
    return await fn();
  } finally {
    try { await client.query('SELECT pg_advisory_unlock($1)', [LOCK_KEY]); }
    catch (err) { log(`WARNING: advisory unlock failed (lock is released with the session anyway): ${err.message}`); }
  }
}

/**
 * Apply pending migrations in manifest order. dryRun → report only, no writes of any kind
 * (no ledger creation, no backfill). Returns the final report.
 */
export async function migrate(client, { dir = DEFAULT_DIR, dryRun = false, strict = false, log = console.log } = {}) {
  if (dryRun) {
    const report = await computeReport(client, { dir });
    for (const f of report.pending) log(`pending: ${f}`);
    for (const m of report.mismatches) log(`CHECKSUM MISMATCH: ${m.filename} (ledger ${m.ledger} ≠ disk ${m.disk})`);
    for (const line of renameLines(report)) log(`RENAMED APPLIED FILE (would be re-executed):${line}`);
    for (const f of report.legacy.map((r) => r.filename)) log(`legacy ledger row (checksum will be backfilled on the next real run): ${f}`);
    for (const f of report.orphans) log(`${strict ? 'STRICT would REFUSE: ' : 'WARNING: '}${orphanLine(f)}`);
    log(formatSummary(report, { dryRun: true }));
    return report;
  }

  return withLock(client, async () => {
    await ensureLedger(client);
    let report = await computeReport(client, { dir });

    if (report.legacy.length) {
      const n = await backfillLegacy(client, report);
      log(`Backfilled checksum + applied_order for ${n} legacy ledger row(s) (filename-only rows written by the previous runner)`);
      report = await computeReport(client, { dir });
    }

    if (report.mismatches.length) {
      const lines = report.mismatches.map((m) => `  ${m.filename}: ledger ${m.ledger} ≠ disk ${m.disk}`);
      throw new MigrationError(
        `REFUSING to run: ${report.mismatches.length} already-applied migration file(s) changed on disk (checksum mismatch). `
        + `Applied migrations are immutable — add a new migration instead.\n${lines.join('\n')}`
      );
    }
    if (report.renames.length) {
      throw new MigrationError(
        `REFUSING to run: ${report.renames.length} pending file(s) carry the checksum of an orphan ledger row — that is a RENAMED applied migration, `
        + `and running it would re-execute it. Restore the original filename (and its order.json entry) or fix forward with a new file.\n${renameLines(report).join('\n')}`
      );
    }
    if (strict && report.orphans.length) {
      throw new MigrationError(
        `REFUSING to run (STRICT): ${report.orphans.length} orphan ledger row(s) — applied on this database but no such file on disk or in order.json. `
        + `Restore the file(s) or resolve the ledger deliberately.\n${report.orphans.map((f) => `  ${f}`).join('\n')}`
      );
    }
    for (const f of report.orphans) log(`WARNING: ${orphanLine(f)}`);

    let ran = 0;
    for (const f of report.pending) {
      log(`Running migration: ${f}`);
      try {
        await applyOne(client, f, report.files.get(f));
      } catch (err) {
        throw new MigrationError(`Failed: ${f} — ${err.message}`);
      }
      log(`Completed: ${f}`);
      ran++;
    }

    const final = await computeReport(client, { dir });
    log(ran === 0 ? 'All migrations are up to date.' : `Successfully ran ${ran} migration(s).`);
    log(formatSummary(final));
    return final;
  }, log);
}

/**
 * Mark migrations as applied WITHOUT running them (for a database whose schema
 * arrived by pg_dump). Validates every name against order.json; refuses the
 * whole batch on an unknown name. Records checksum + applied_order like a real run.
 */
export async function markApplied(client, filenames, { dir = DEFAULT_DIR, dryRun = false, log = console.log } = {}) {
  if (!Array.isArray(filenames) || filenames.length === 0) throw new MigrationError('markApplied: filenames[] is required');
  const order = loadManifest(dir);
  const unknown = filenames.filter((f) => !order.includes(f));
  if (unknown.length) throw new MigrationError(`Unknown migration filename(s) — nothing was written: ${unknown.join(', ')}`);
  const files = readMigrationFiles(dir, filenames);
  const ledger = await readLedger(client);
  const present = new Set(ledger.rows.map((r) => r.filename));
  const toInsert = filenames.filter((f) => !present.has(f));
  const alreadyPresent = filenames.filter((f) => present.has(f));
  if (dryRun) return { dryRun: true, inserted: [], wouldInsert: toInsert, alreadyPresent };
  return withLock(client, async () => {
    await ensureLedger(client);
    await client.query('BEGIN');
    try {
      for (const f of toInsert) await client.query(INSERT_LEDGER_ROW, [f, files.get(f).checksum]);
      await client.query('COMMIT');
    } catch (err) {
      await client.query('ROLLBACK');
      throw err;
    }
    return { dryRun: false, inserted: toInsert, wouldInsert: [], alreadyPresent };
  }, log);
}

/** SSL policy: explicit MIGRATE_SSL wins; otherwise off for local targets, on (no CA check) for remote ones. */
export function resolveSsl(connectionString) {
  const v = process.env.MIGRATE_SSL;
  if (v === '0' || v === 'false') return false;
  if (v === '1' || v === 'true') return { rejectUnauthorized: false };
  if (/sslmode=disable/i.test(connectionString)) return false;
  if (/@(localhost|127\.0\.0\.1|\[::1\])(:\d+)?(\/|\?|$)/.test(connectionString)) return false;
  return { rejectUnauthorized: false };
}

/** host:port/db only — never echoes credentials. */
function describeTarget(url) {
  try { const u = new URL(url); return `${u.hostname}:${u.port || '5432'}${u.pathname}`; }
  catch { return '<unparseable DATABASE_URL>'; }
}

const USAGE = `usage: node server/migrations/run.js [--dry-run] [--strict] [--dir <migrationsDir>] [--mark-applied a.sql,b.sql]
  env: DATABASE_URL (required), MIGRATIONS_DIR, STRICT_MIGRATIONS=1 (= --strict), MIGRATE_SSL=0|1`;

function parseArgs(argv) {
  const opts = {
    dryRun: false,
    strict: process.env.STRICT_MIGRATIONS === '1',
    dir: process.env.MIGRATIONS_DIR ? path.resolve(process.env.MIGRATIONS_DIR) : DEFAULT_DIR,
    markApplied: null,
    help: false,
  };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--dry-run') opts.dryRun = true;
    else if (a === '--strict') opts.strict = true;
    else if (a === '--dir') opts.dir = path.resolve(argv[++i] ?? '');
    else if (a.startsWith('--dir=')) opts.dir = path.resolve(a.slice('--dir='.length));
    else if (a === '--mark-applied') opts.markApplied = (argv[++i] ?? '').split(',').map((s) => s.trim()).filter(Boolean);
    else if (a === '--help' || a === '-h') opts.help = true;
    else throw new MigrationError(`Unknown argument: ${a}\n${USAGE}`);
  }
  return opts;
}

async function main(argv) {
  const { default: dotenv } = await import('dotenv');
  dotenv.config({ path: path.join(__dirname, '../../.env'), quiet: true });

  let opts;
  try { opts = parseArgs(argv); } catch (err) { console.error(err.message); return 1; }
  if (opts.help) { console.log(USAGE); return 0; }

  const url = process.env.DATABASE_URL;
  if (!url) {
    console.error('DATABASE_URL is not set — refusing to run migrations against an unknown database.');
    return 1;
  }
  // Validate the manifest BEFORE connecting: a broken manifest never touches a database.
  try { loadManifest(opts.dir); } catch (err) { console.error(err.message); return 1; }

  const pool = new pg.Pool({ connectionString: url, ssl: resolveSsl(url), connectionTimeoutMillis: 10000, max: 1 });
  let client;
  try {
    client = await pool.connect();
  } catch (err) {
    console.error(`Cannot connect to the database at ${describeTarget(url)}: ${err.message}`);
    await pool.end();
    return 1;
  }
  // A migration's RAISE WARNING (e.g. 122 declining to reshape a table with rows)
  // must reach the deploy log. NOTICEs (IF NOT EXISTS "skipping" chatter) are not printed.
  client.on('notice', (n) => {
    if (['WARNING', 'ERROR', 'FATAL', 'PANIC'].includes(n.severity)) console.log(`${n.severity} (database): ${n.message}`);
  });
  try {
    if (opts.markApplied) {
      const r = await markApplied(client, opts.markApplied, { dir: opts.dir, dryRun: opts.dryRun });
      console.log(`${r.dryRun ? 'DRY RUN — would mark' : 'Marked'} applied: ${(r.dryRun ? r.wouldInsert : r.inserted).join(', ') || '(none)'}; already present: ${r.alreadyPresent.join(', ') || '(none)'}`);
      return 0;
    }
    const report = await migrate(client, { dir: opts.dir, dryRun: opts.dryRun, strict: opts.strict });
    if (!opts.dryRun) return 0; // a real run throws on every refusal; reaching here means it applied cleanly
    const refuse = report.mismatches.length || report.renames.length || (opts.strict && report.orphans.length);
    return refuse ? 1 : 0;
  } catch (err) {
    console.error(err instanceof MigrationError ? `Migration failed: ${err.message}` : `Migration failed: ${err.stack || err.message}`);
    return 1;
  } finally {
    client.release();
    await pool.end();
  }
}

const isMain = Boolean(process.argv[1]) && path.resolve(process.argv[1]) === __filename;
if (isMain) {
  main(process.argv.slice(2)).then(
    (code) => process.exit(code),
    (err) => { console.error(`Migration failed: ${err.stack || err.message}`); process.exit(1); }
  );
}
