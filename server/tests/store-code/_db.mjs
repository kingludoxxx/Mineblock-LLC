// Shared helpers for the Lane C store-code tests.
//
// Local Postgres 16 (see briefs/COMMON.md): host /tmp, port 5433, user postgres,
// trust auth. Every test creates its OWN database named lane_store_code_* and
// never touches one it did not create, except `mineblock_copy` which is a
// READ-ONLY template (A2/A3 copy it with CREATE DATABASE ... TEMPLATE).
import pg from 'pg';
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

export const PG_HOST = process.env.LANE_PG_HOST || '/tmp';
export const PG_PORT = Number(process.env.LANE_PG_PORT || 5433);
export const PG_USER = process.env.LANE_PG_USER || 'postgres';

const here = path.dirname(fileURLToPath(import.meta.url));
export const REPO_ROOT = path.resolve(here, '../../..');
export const MIGRATIONS_DIR = path.join(REPO_ROOT, 'server/migrations');
export const STAGED_DIR = path.join(MIGRATIONS_DIR, 'staged');
export const BACKFILL_SCRIPT = path.join(REPO_ROOT, 'server/scripts/backfill-store-codes.mjs');

export function connectionString(dbname) {
  // pg-connection-string accepts a unix-socket directory via ?host=
  return `postgres://${PG_USER}@localhost:${PG_PORT}/${dbname}?host=${encodeURIComponent(PG_HOST)}`;
}

export function client(dbname) {
  return new pg.Client({ host: PG_HOST, port: PG_PORT, user: PG_USER, database: dbname });
}

export async function withClient(dbname, fn) {
  const c = client(dbname);
  await c.connect();
  try { return await fn(c); } finally { await c.end(); }
}

// Drop-and-create a database the test owns. Throws if the name is not ours.
export async function freshDb(name, { template } = {}) {
  if (!/^lane_store_code_[a-z0-9_]+$/.test(name)) throw new Error(`refusing to touch database ${name}`);
  await withClient('postgres', async (c) => {
    await c.query(`DROP DATABASE IF EXISTS ${name}`);
    // node --test runs files in parallel; concurrent CREATE DATABASE can race on
    // pg_database_datname_index (SQLSTATE 23505). Retry a few times.
    for (let attempt = 1; ; attempt++) {
      try {
        await c.query(template ? `CREATE DATABASE ${name} TEMPLATE ${template}` : `CREATE DATABASE ${name}`);
        break;
      } catch (err) {
        if (err.code !== '23505' || attempt >= 5) throw err;
        await new Promise((r) => setTimeout(r, 200 * attempt));
      }
    }
  });
  return name;
}

export async function dbExists(name) {
  return withClient('postgres', async (c) => {
    const r = await c.query('SELECT 1 FROM pg_database WHERE datname = $1', [name]);
    return r.rowCount === 1;
  });
}

// Lane C's migration files, in filename order (121+ only; the numbered files
// this lane owns). `staged/` is NOT applied here: it is opt-in.
export function laneMigrationFiles() {
  return fs.readdirSync(MIGRATIONS_DIR)
    .filter((f) => /^1[2-9]\d_.*\.sql$/.test(f))
    .sort()
    .map((f) => path.join(MIGRATIONS_DIR, f));
}

export function stagedMigrationFiles() {
  if (!fs.existsSync(STAGED_DIR)) return [];
  return fs.readdirSync(STAGED_DIR).filter((f) => f.endsWith('.sql')).sort().map((f) => path.join(STAGED_DIR, f));
}

// Apply SQL files the same way server/migrations/run.js does: one transaction
// per file, ledger row in _migrations. `settings` are applied inside the
// transaction (SET LOCAL) so `app.store_code` reaches the migration exactly
// as a runner would pass it.
export async function applySqlFiles(c, files, { settings = {} } = {}) {
  await c.query(`CREATE TABLE IF NOT EXISTS _migrations (
    id SERIAL PRIMARY KEY, filename VARCHAR(255) UNIQUE NOT NULL, executed_at TIMESTAMPTZ DEFAULT NOW())`);
  const applied = [];
  for (const file of files) {
    const sql = fs.readFileSync(file, 'utf8');
    await c.query('BEGIN');
    try {
      for (const [k, v] of Object.entries(settings)) await c.query(`SELECT set_config($1, $2, true)`, [k, v]);
      await c.query(sql);
      await c.query('INSERT INTO _migrations (filename) VALUES ($1) ON CONFLICT (filename) DO NOTHING', [path.basename(file)]);
      await c.query('COMMIT');
      applied.push(path.basename(file));
    } catch (err) {
      await c.query('ROLLBACK');
      err.message = `${path.basename(file)}: ${err.message}`;
      throw err;
    }
  }
  return applied;
}

export async function columnInfo(c, table, column) {
  const r = await c.query(
    `SELECT column_name, data_type, is_nullable, column_default
       FROM information_schema.columns WHERE table_schema='public' AND table_name=$1 AND column_name=$2`,
    [table, column]);
  return r.rows[0] || null;
}

// Run the backfill script as a child process (the way an operator would) and
// return { code, stdout, stderr, summary } where summary is the parsed
// JSON_SUMMARY line the script prints last.
export function runBackfill(dbname, args = [], env = {}) {
  const res = spawnSync(process.execPath, [BACKFILL_SCRIPT, ...args], {
    cwd: REPO_ROOT,
    env: { ...process.env, DATABASE_URL: connectionString(dbname), ...env },
    encoding: 'utf8',
  });
  if (process.env.LANE_DEBUG) process.stderr.write(`\n--- backfill ${args.join(' ') || '(apply)'} on ${dbname} exit=${res.status} ---\n${res.stdout}${res.stderr}`);
  let summary = null;
  for (const line of (res.stdout || '').split('\n')) {
    if (line.startsWith('JSON_SUMMARY ')) summary = JSON.parse(line.slice('JSON_SUMMARY '.length));
  }
  return { code: res.status, stdout: res.stdout, stderr: res.stderr, summary };
}
