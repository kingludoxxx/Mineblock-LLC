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
 * CLI     node server/migrations/run.js [--dry-run [--allow-pending]] [--strict] [--dir <path>] [--mark-applied a.sql,b.sql]
 *                                      [--relabel-identity --i-typed-the-store-name=<Name>]
 * STORE   STORE_CODE (required for a real run, ^[A-Z0-9]{2,4}$) is set as the
 *         transaction-local `app.store_code` for every migration, so a store-tagging
 *         migration labels rows with THIS store's code. Unset or malformed REFUSES
 *         the run before anything is written (Lane C review F1) — a silent default
 *         would tag a Puure database 'MB'. A dry run only warns.
 * IDENT   `_store_identity` (migration 127) is the DATABASE's own label. It is read
 *         as the first statement under the advisory lock, before the ledger is even
 *         created: a row whose store_code differs from STORE_CODE REFUSES the run
 *         with `STORE IDENTITY MISMATCH: database is <X>, STORE_CODE is <Y>` and
 *         zero writes (review P1-3 — shape-checking STORE_CODE never tied it to the
 *         database it was about to label). No row yet → this run records one.
 *         Deliberate relabel: --relabel-identity --i-typed-the-store-name=<Name>,
 *         where Name must equal STORE_NAME (or BRAND_NAME) for this deployment.
 * REPORT  After a real run the runner counts the `store_code` column defaults:
 *         `store_code column defaults — <CODE>: N, other stores: 0`. Any default
 *         carrying ANOTHER store's literal exits 1 and names the columns; that is
 *         the check the Puure deploy bracket needs, now inside the runner.
 * LOCKS   Every migration transaction runs `SET LOCAL lock_timeout`
 *         (MIGRATION_LOCK_TIMEOUT, default 5s, "0" disables): a migration that cannot
 *         take its ACCESS EXCLUSIVE locks fails fast and re-runnably instead of
 *         stalling the app behind it (review F7).
 *
 * ENV     DATABASE_URL (required) · STORE_CODE (required) · MIGRATIONS_DIR (= --dir)
 *         STRICT_MIGRATIONS=1 (= --strict) · MIGRATION_LOCK_TIMEOUT (default 5s)
 *         MIGRATE_SSL=0|1 (default auto: off for localhost/127.0.0.1/sslmode=disable, on otherwise)
 *         STORE_NAME or BRAND_NAME (only --relabel-identity reads them)
 *         RENDER_GIT_COMMIT (Render sets it; else `git rev-parse HEAD`, else 'unknown')
 * EXIT    0 clean · 1 any error or refusal. A dry run exits 1 when the database is
 *         NOT current: pending files (unless --allow-pending, the pre-apply
 *         rehearsal), a checksum mismatch, a rename, or (STRICT) an orphan —
 *         so a preflight gate can trust `npm run migrate:dry-run`'s exit code.
 *
 * LIBRARY server.js and admin routes import { checkPending } for a READ-ONLY
 *         report. Nothing outside this file writes the ledger.
 */
import pg from 'pg';
import fs from 'fs';
import path from 'path';
import crypto from 'crypto';
import { spawnSync } from 'child_process';
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

/**
 * STORE_CODE — which store's database this run is tagging (Lane C, review F1).
 * FAIL-CLOSED: unset or malformed REFUSES the run. Migrations read it through
 * `current_setting('app.store_code', true)`; a silent fallback there would label
 * every Puure row 'MB', which is exactly the failure this guard exists to stop.
 * ^[A-Z0-9]{2,4}$ is the store-code shape of RULES.md R5 (MB, PL, P1, R2, MR).
 */
export const STORE_CODE_RE = /^[A-Z0-9]{2,4}$/;
export function resolveStoreCode(env = process.env) {
  const raw = env.STORE_CODE;
  if (raw === undefined || String(raw).trim() === '') {
    throw new MigrationError(
      'STORE_CODE is not set — REFUSING to run migrations. Every migrated row is tagged with this store\'s code '
      + `(app.store_code); running without it would label this database's rows with another store's code. `
      + `Set STORE_CODE (${STORE_CODE_RE}) on the service, e.g. MB for mineblock-dashboard, PL for puure-dashboard.`);
  }
  const v = String(raw).trim();
  if (!STORE_CODE_RE.test(v)) {
    throw new MigrationError(`STORE_CODE ${JSON.stringify(v)} is not a valid store code (expected ${STORE_CODE_RE}) — REFUSING to run migrations.`);
  }
  return v;
}

/**
 * Per-migration lock timeout (review F7). Every ALTER TABLE takes an
 * ACCESS EXCLUSIVE lock; 123 takes 39 of them in one transaction. Behind a long
 * read the migration would wait forever AND queue every later reader behind it.
 * SET LOCAL: a migration that cannot get its locks fails fast, rolls back, and
 * leaves the ledger untouched, so it is simply re-runnable at a quieter moment.
 */
export const DEFAULT_LOCK_TIMEOUT = '5s';
export function resolveLockTimeout(env = process.env) {
  const v = (env.MIGRATION_LOCK_TIMEOUT ?? '').trim();
  if (!v) return DEFAULT_LOCK_TIMEOUT;
  if (!/^\d+\s*(ms|s|min)?$/.test(v)) throw new MigrationError(`MIGRATION_LOCK_TIMEOUT ${JSON.stringify(v)} is not a PostgreSQL interval like "5s", "500ms" or "0" (0 disables the timeout)`);
  return v;
}

/* ── Store identity (migration 127, review finding P1-3) ─────────────────────
 *
 * The database's own label. `STORE_CODE` says what THIS RUN thinks it is;
 * `_store_identity.store_code` says what the DATABASE already is. When they
 * disagree the run is refused before a single byte is written — on Puure's
 * first deploy a copy-pasted `STORE_CODE=MB` would otherwise label 100 % of
 * Puure's rows as Mineblock's, exit 0, and the deploy would succeed.
 */

/** Bumped when the runner's identity contract changes; recorded on the row that run writes. */
export const RUNNER_VERSION = 'run.js/2 (store-identity)';

export const IDENTITY_TABLE = '_store_identity';

/**
 * The commit this run is applying: Render's env, else the HEAD of the checkout
 * that contains THIS runner (never `--dir`, which can point at a scratch
 * directory that is not a repository), else 'unknown'.
 */
export function resolveRunCommit(env = process.env, dir = __dirname) {
  const fromEnv = (env.RENDER_GIT_COMMIT ?? '').trim();
  if (fromEnv) return fromEnv;
  const res = spawnSync('git', ['rev-parse', 'HEAD'], { cwd: dir, encoding: 'utf8' });
  const sha = (res.stdout || '').trim();
  return /^[0-9a-f]{7,40}$/.test(sha) ? sha : 'unknown';
}

/**
 * { table: false } table absent (an old database, or 127 not applied yet)
 * { table: true, row: null } table present, no identity recorded yet
 * { table: true, row: {store_code, first_run_at, first_run_commit, runner_version} }
 * Throws MigrationError on a MALFORMED identity (more than one row, or a
 * store_code that is not a store code) — fail closed: an unreadable label is
 * not the same thing as no label, and guessing which store it meant is exactly
 * the mistake this table exists to prevent.
 */
export async function readStoreIdentity(client) {
  const { rows: [{ t }] } = await client.query(`SELECT to_regclass('public.${IDENTITY_TABLE}') AS t`);
  if (!t) return { table: false, row: null };
  const { rows } = await client.query(
    `SELECT store_code, first_run_at, first_run_commit, runner_version FROM ${IDENTITY_TABLE} ORDER BY id`);
  if (rows.length === 0) return { table: true, row: null };
  if (rows.length > 1) {
    throw new MigrationError(
      `MALFORMED STORE IDENTITY: ${IDENTITY_TABLE} holds ${rows.length} rows (${rows.map((r) => JSON.stringify(r.store_code)).join(', ')}) — it must hold exactly one. `
      + 'REFUSING to run: this database does not say which store it belongs to. Resolve the table by hand.');
  }
  const row = rows[0];
  const code = row.store_code == null ? '' : String(row.store_code).trim();
  if (!STORE_CODE_RE.test(code)) {
    throw new MigrationError(
      `MALFORMED STORE IDENTITY: ${IDENTITY_TABLE}.store_code is ${JSON.stringify(row.store_code)}, which is not a store code (expected ${STORE_CODE_RE}). `
      + 'REFUSING to run: this database does not say which store it belongs to. Resolve the row by hand.');
  }
  return { table: true, row: { ...row, store_code: code } };
}

const identityLine = (row) => `${row.store_code} (first run ${new Date(row.first_run_at).toISOString()}, commit ${row.first_run_commit})`;

/** The refusal itself. Throws when the database already belongs to a different store. */
export function assertIdentityMatches(identity, storeCode) {
  if (!identity.row) return;
  if (identity.row.store_code === storeCode) return;
  throw new MigrationError(
    `STORE IDENTITY MISMATCH: database is ${identity.row.store_code}, STORE_CODE is ${storeCode}\n`
    + `  ${IDENTITY_TABLE}: ${identityLine(identity.row)}\n`
    + '  REFUSING to run — nothing was written. Every row this run would tag belongs to the OTHER store.\n'
    + `  Point DATABASE_URL at ${storeCode}'s database, or set STORE_CODE=${identity.row.store_code}.\n`
    + '  A deliberate relabel: --relabel-identity --i-typed-the-store-name=<the store\'s display name>.');
}

/**
 * The typed-name gate for a relabel (RULES.md R3 in the runner). The name must
 * equal this deployment's configured display name — STORE_NAME if the service
 * sets one, otherwise BRAND_NAME, which every store already carries
 * (server/config/env.PL.example: BRAND_NAME=Puure). PRODUCT_CODES_JSON carries
 * no display name, so it is not a source. Neither variable set → REFUSED: a
 * relabel with nothing to type against is just a flag.
 */
export function resolveStoreName(env = process.env) {
  for (const key of ['STORE_NAME', 'BRAND_NAME']) {
    const v = (env[key] ?? '').trim();
    if (v) return { key, name: v };
  }
  return null;
}

export function assertTypedStoreName(typed, env = process.env) {
  const configured = resolveStoreName(env);
  if (!configured) {
    throw new MigrationError(
      '--relabel-identity REFUSED: this deployment has no configured store display name (neither STORE_NAME nor BRAND_NAME is set), '
      + 'so there is nothing for --i-typed-the-store-name to be checked against. Set STORE_NAME (or BRAND_NAME) on the service first.');
  }
  if (typed === undefined || String(typed).trim() === '') {
    throw new MigrationError(`--relabel-identity REFUSED: --i-typed-the-store-name=<Name> is required and must equal ${configured.key} for this deployment.`);
  }
  if (String(typed).trim() !== configured.name) {
    throw new MigrationError(
      `--relabel-identity REFUSED: typed store name ${JSON.stringify(String(typed).trim())} does not match ${configured.key} for this deployment. `
      + 'Nothing was written. Relabelling a database is how a store loses its rows to another store; the name is typed exactly or not at all.');
  }
  return configured;
}

async function recordIdentity(client, { storeCode, commit, log }) {
  await client.query(
    `INSERT INTO ${IDENTITY_TABLE} (id, store_code, first_run_at, first_run_commit, runner_version)
     VALUES (1, $1, NOW(), $2, $3) ON CONFLICT (id) DO NOTHING`,
    [storeCode, commit, RUNNER_VERSION]);
  const after = await readStoreIdentity(client);
  if (after.row) log(`database identity recorded: ${identityLine(after.row)} (runner ${after.row.runner_version})`);
  return after;
}

async function relabelIdentity(client, identity, { storeCode, commit, typedName, env = process.env, log }) {
  if (!identity.table) {
    throw new MigrationError(`--relabel-identity REFUSED: ${IDENTITY_TABLE} does not exist on this database (migration 127 has never run here). There is no identity to relabel.`);
  }
  if (!identity.row) {
    throw new MigrationError(`--relabel-identity REFUSED: ${IDENTITY_TABLE} is empty — this database has no identity yet, so an ordinary run records ${storeCode} without any override.`);
  }
  const configured = assertTypedStoreName(typedName, env);
  const before = identityLine(identity.row);
  if (identity.row.store_code === storeCode) {
    log(`--relabel-identity: database identity is ALREADY ${storeCode} — nothing to relabel (${before})`);
    return identity;
  }
  await client.query(
    `UPDATE ${IDENTITY_TABLE} SET store_code = $1, first_run_commit = $2, runner_version = $3 WHERE id = 1`,
    [storeCode, commit, RUNNER_VERSION]);
  const after = await readStoreIdentity(client);
  log(`RELABELLED database identity (typed ${configured.key} "${configured.name}"): ${before}  ->  ${identityLine(after.row)}`);
  return after;
}

/**
 * The Puure bracket's column-default check, moved inside the runner (brief C3.4).
 * Every `store_code` column whose DEFAULT is a store literal is counted; a
 * literal that is not THIS store's is a mixed-label database and exits 1.
 */
const STORE_DEFAULT_RE = /^'([A-Z0-9]{2,4})'::text$/;
export async function storeCodeDefaults(client) {
  const { rows } = await client.query(
    `SELECT table_name, column_name, column_default
       FROM information_schema.columns
      WHERE table_schema = 'public' AND column_name = 'store_code' AND column_default IS NOT NULL
      ORDER BY table_name, column_name`);
  const byCode = new Map();
  for (const r of rows) {
    const m = STORE_DEFAULT_RE.exec(String(r.column_default).trim());
    if (!m) continue;
    if (!byCode.has(m[1])) byCode.set(m[1], []);
    byCode.get(m[1]).push(`${r.table_name}.${r.column_name}`);
  }
  return byCode;
}

/** Prints the report; throws when another store's literal is defaulted anywhere. */
export async function reportStoreCodeDefaults(client, storeCode, log) {
  const byCode = await storeCodeDefaults(client);
  const mine = byCode.get(storeCode) || [];
  const others = [...byCode.entries()].filter(([code]) => code !== storeCode);
  const otherCount = others.reduce((n, [, cols]) => n + cols.length, 0);
  log(`store_code column defaults — ${storeCode}: ${mine.length}, other stores: ${otherCount}`);
  if (otherCount) {
    const lines = others.map(([code, cols]) => `  ${code}: ${cols.join(', ')}`);
    throw new MigrationError(
      `MIXED STORE LABELS: ${otherCount} store_code column default(s) carry another store's code on a ${storeCode} database. `
      + `The migrations ran; this report FAILS the run so the deploy stops here.\n${lines.join('\n')}`);
  }
  return { mine: mine.length, other: otherCount };
}

async function applyOne(client, filename, file, { storeCode, lockTimeout = DEFAULT_LOCK_TIMEOUT } = {}) {
  await client.query('BEGIN');
  try {
    // Transaction-local (SET LOCAL / is_local = true): both settings are gone at
    // COMMIT or ROLLBACK and never leak into the next migration or the app.
    await client.query(`SET LOCAL lock_timeout = ${quoteLiteral(lockTimeout)}`);
    if (storeCode) await client.query(`SELECT set_config('app.store_code', $1, true)`, [storeCode]);
    await client.query(file.sql);
    await client.query(INSERT_LEDGER_ROW, [filename, file.checksum]);
    await client.query('COMMIT');
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  }
}

/** SET LOCAL takes no parameters; the value is validated by resolveLockTimeout before it gets here. */
const quoteLiteral = (s) => `'${String(s).replace(/'/g, "''")}'`;

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
export async function migrate(client, {
  dir = DEFAULT_DIR, dryRun = false, strict = false, log = console.log,
  relabelIdentity: wantRelabel = false, typedStoreName = undefined, env = process.env,
} = {}) {
  if (dryRun) {
    if (wantRelabel) {
      // A relabel is a WRITE, and the whole point of --dry-run is that it writes
      // nothing. Offering it here would make "rehearse it first" mean the opposite.
      throw new MigrationError('--relabel-identity is not available on a dry run (it writes the identity row). Run it as a real run.');
    }
    const report = await computeReport(client, { dir });
    for (const f of report.pending) log(`pending: ${f}`);
    for (const m of report.mismatches) log(`CHECKSUM MISMATCH: ${m.filename} (ledger ${m.ledger} ≠ disk ${m.disk})`);
    for (const line of renameLines(report)) log(`RENAMED APPLIED FILE (would be re-executed):${line}`);
    for (const f of report.legacy.map((r) => r.filename)) log(`legacy ledger row (checksum will be backfilled on the next real run): ${f}`);
    for (const f of report.orphans) log(`${strict ? 'STRICT would REFUSE: ' : 'WARNING: '}${orphanLine(f)}`);
    // A dry run writes nothing, so it stays usable as a preflight without the
    // variable — but it says out loud that the real run would refuse (F1).
    let sc = null;
    try {
      sc = resolveStoreCode(env);
      log(`store code for a real run (app.store_code): ${sc} · lock_timeout: ${resolveLockTimeout(env)}`);
    } catch (err) {
      log(`STORE_CODE: ${err.message}`);
    }
    // The identity report. A malformed identity THROWS here, exactly as it would
    // on a real run: a preflight that stays quiet about it is worse than useless.
    const identity = await readStoreIdentity(client);
    if (identity.row) {
      log(`database identity: ${identityLine(identity.row)}`);
      if (sc && identity.row.store_code !== sc) {
        report.identityMismatch = { database: identity.row.store_code, storeCode: sc };
        log(`STORE IDENTITY MISMATCH: database is ${identity.row.store_code}, STORE_CODE is ${sc} — a real run would REFUSE and write nothing.`);
      }
    } else if (!identity.table) {
      log(`no identity yet (${IDENTITY_TABLE} does not exist here; migration 127 will create it)`
        + `${sc ? `, this run will record ${sc}` : ''}`);
    } else {
      log(`no identity yet${sc ? `, this run will record ${sc}` : ''}`);
    }
    log(formatSummary(report, { dryRun: true }));
    return report;
  }

  // Fail-closed BEFORE anything is written, ledger backfill included (review F1/F7).
  const storeCode = resolveStoreCode(env);
  const lockTimeout = resolveLockTimeout(env);
  const runCommit = resolveRunCommit(env);

  return withLock(client, async () => {
    // FIRST statement under the lock, before ensureLedger's CREATE TABLE: on a
    // mismatch the run exits with literally zero writes — see the identity block above.
    let identity = await readStoreIdentity(client);
    if (wantRelabel) {
      identity = await relabelIdentity(client, identity, { storeCode, commit: runCommit, typedName: typedStoreName, env, log });
    } else if (identity.row) {
      assertIdentityMatches(identity, storeCode);
      log(`database identity: ${identityLine(identity.row)}`);
    }

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
    if (report.pending.length) log(`store code for this run (app.store_code): ${storeCode} · lock_timeout: ${lockTimeout}`);
    for (const f of report.pending) {
      log(`Running migration: ${f}`);
      try {
        await applyOne(client, f, report.files.get(f), { storeCode, lockTimeout });
      } catch (err) {
        throw new MigrationError(`Failed: ${f} — ${err.message}`);
      }
      log(`Completed: ${f}`);
      ran++;
    }

    // 127 has applied by now (or the table was already there). Record the label
    // this run used, so the NEXT run has something to be refused against.
    if (!identity.row) {
      identity = await readStoreIdentity(client);
      if (identity.table && !identity.row) identity = await recordIdentity(client, { storeCode, commit: runCommit, log });
      else if (!identity.table) log(`WARNING: ${IDENTITY_TABLE} does not exist after the run — this database's store label is NOT recorded and a wrong STORE_CODE cannot be refused here. Is 127_store_identity.sql in order.json?`);
    }

    const final = await computeReport(client, { dir });
    log(ran === 0 ? 'All migrations are up to date.' : `Successfully ran ${ran} migration(s).`);
    log(formatSummary(final));
    // Last, and it can fail the run: the migrations are committed, but a
    // database carrying another store's column defaults must not reach a deploy.
    await reportStoreCodeDefaults(client, storeCode, log);
    return final;
  }, log);
}

/**
 * Mark migrations as applied WITHOUT running them (for a database whose schema
 * arrived by pg_dump). Validates every name against order.json; refuses the
 * whole batch on an unknown name. Records checksum + applied_order like a real run,
 * after backfilling any legacy rows so history order is preserved.
 */
export async function markApplied(client, filenames, { dir = DEFAULT_DIR, dryRun = false, log = console.log } = {}) {
  if (!Array.isArray(filenames) || filenames.length === 0) throw new MigrationError('markApplied: filenames[] is required');
  const order = loadManifest(dir);
  const unknown = filenames.filter((f) => !order.includes(f));
  if (unknown.length) throw new MigrationError(`Unknown migration filename(s) — nothing was written: ${unknown.join(', ')}`);
  const files = readMigrationFiles(dir, filenames);
  const split = (ledgerRows) => {
    const present = new Set(ledgerRows.map((r) => r.filename));
    return { toInsert: filenames.filter((f) => !present.has(f)), alreadyPresent: filenames.filter((f) => present.has(f)) };
  };
  if (dryRun) {
    const { toInsert, alreadyPresent } = split((await readLedger(client)).rows);
    return { dryRun: true, inserted: [], wouldInsert: toInsert, alreadyPresent };
  }
  return withLock(client, async () => {
    // --mark-applied writes ledger rows, so it gets the same identity gate — but
    // it never sets app.store_code, so it only refuses when STORE_CODE is
    // actually set and actually disagrees. A malformed identity refuses outright.
    const identity = await readStoreIdentity(client);
    if (identity.row && (process.env.STORE_CODE ?? '').trim()) {
      assertIdentityMatches(identity, resolveStoreCode());
    }
    await ensureLedger(client);
    // P2-1: on a legacy ledger (filename-only rows) backfill FIRST, exactly as a real
    // run does, so the marked file continues the history (N+1) instead of taking
    // applied_order 1 and pushing the real history to 2..N+1 on the next run.
    const report = await computeReport(client, { dir });
    if (report.legacy.length) {
      const n = await backfillLegacy(client, report);
      log(`Backfilled checksum + applied_order for ${n} legacy ledger row(s) before marking`);
    }
    const { toInsert, alreadyPresent } = split((await readLedger(client)).rows);
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

const USAGE = `usage: node server/migrations/run.js [--dry-run [--allow-pending]] [--strict] [--dir <migrationsDir>] [--mark-applied a.sql,b.sql]
                                    [--relabel-identity --i-typed-the-store-name=<Name>]
  --dry-run        report only, no writes; exit 1 unless the database is current
  --allow-pending  (dry-run only) pending files do not fail the dry run — the pre-apply rehearsal
  --strict         orphan ledger rows refuse instead of warn (= STRICT_MIGRATIONS=1)
  --relabel-identity --i-typed-the-store-name=<Name>
                   deliberately move this database from one store to another. <Name> must equal
                   STORE_NAME (or BRAND_NAME) for this deployment. Never on a dry run.
  env: DATABASE_URL (required), STORE_CODE (required for a real run, ^[A-Z0-9]{2,4}$),
       MIGRATIONS_DIR, STRICT_MIGRATIONS=1 (= --strict), MIGRATION_LOCK_TIMEOUT (default 5s), MIGRATE_SSL=0|1,
       STORE_NAME / BRAND_NAME (--relabel-identity only), RENDER_GIT_COMMIT`;

function parseArgs(argv) {
  const opts = {
    dryRun: false,
    allowPending: false,
    strict: process.env.STRICT_MIGRATIONS === '1',
    dir: process.env.MIGRATIONS_DIR ? path.resolve(process.env.MIGRATIONS_DIR) : DEFAULT_DIR,
    markApplied: null,
    relabelIdentity: false,
    typedStoreName: undefined,
    help: false,
  };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--dry-run') opts.dryRun = true;
    else if (a === '--allow-pending') opts.allowPending = true;
    else if (a === '--strict') opts.strict = true;
    else if (a === '--dir') opts.dir = path.resolve(argv[++i] ?? '');
    else if (a.startsWith('--dir=')) opts.dir = path.resolve(a.slice('--dir='.length));
    else if (a === '--mark-applied') opts.markApplied = (argv[++i] ?? '').split(',').map((s) => s.trim()).filter(Boolean);
    else if (a === '--relabel-identity') opts.relabelIdentity = true;
    else if (a === '--i-typed-the-store-name') opts.typedStoreName = argv[++i] ?? '';
    else if (a.startsWith('--i-typed-the-store-name=')) opts.typedStoreName = a.slice('--i-typed-the-store-name='.length);
    else if (a === '--help' || a === '-h') opts.help = true;
    else throw new MigrationError(`Unknown argument: ${a}\n${USAGE}`);
  }
  if (opts.allowPending && !opts.dryRun) throw new MigrationError(`--allow-pending only applies to --dry-run (a real run applies pending files)\n${USAGE}`);
  if (opts.relabelIdentity && opts.dryRun) throw new MigrationError(`--relabel-identity is not available on a dry run (it writes the identity row)\n${USAGE}`);
  if (opts.relabelIdentity && opts.markApplied) throw new MigrationError(`--relabel-identity and --mark-applied do different jobs; run them separately\n${USAGE}`);
  if (opts.typedStoreName !== undefined && !opts.relabelIdentity) throw new MigrationError(`--i-typed-the-store-name is only meaningful with --relabel-identity\n${USAGE}`);
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
    const report = await migrate(client, {
      dir: opts.dir, dryRun: opts.dryRun, strict: opts.strict,
      relabelIdentity: opts.relabelIdentity, typedStoreName: opts.typedStoreName,
    });
    if (!opts.dryRun) return 0; // a real run throws on every refusal; reaching here means it applied cleanly
    const notCurrent = report.mismatches.length || report.renames.length || (opts.strict && report.orphans.length)
      || report.identityMismatch
      || (report.pending.length && !opts.allowPending);
    if (report.pending.length && !opts.allowPending) console.log(`DRY RUN exit 1: ${report.pending.length} pending file(s) — the database is not current (pass --allow-pending for a pre-apply rehearsal)`);
    return notCurrent ? 1 : 0;
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
