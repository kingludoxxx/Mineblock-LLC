// S1-1 — a store born from nothing must not inherit another store's admin.
//
// `npm run seed` (server/seeds/run.js) hard-coded admin@try-mineblock.com and a
// published password, ignoring SUPERADMIN_EMAIL / SUPERADMIN_PASSWORD. On a new
// store that seeds a foreign identity with a known password (R5 store identity
// is data, R15 no store literal in shared code, R20 no credential literals).
//
// Acceptance:
//   A1  with SUPERADMIN_EMAIL/PASSWORD set, exactly that user is created,
//       the password verifies, and no other user row exists.
//   A2  with either variable unset the seed REFUSES (non-zero exit) and writes
//       no user row  ← the failure path.
//   A3  server/seeds carries no e-mail / password literal.
//
// Real seed program, real local Postgres, run through the shell as Render would.
// Run:  node server/tests/sandbox/seed-superadmin-env.mjs
import postgres from 'postgres';
import bcrypt from 'bcrypt';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { readdirSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..');
const NAME = 'sb_seed_test';
const DB = `postgres://postgres@127.0.0.1:5433/${NAME}`;

const admin = postgres('postgres://postgres@127.0.0.1:5433/postgres', { ssl: false });
await admin`DROP DATABASE IF EXISTS ${admin(NAME)}`;
await admin`CREATE DATABASE ${admin(NAME)}`;
await admin.end();

const sql = postgres(DB, { ssl: false, onnotice: () => {} });
// The three tables the seed touches, in the shape migration 001/002 give them.
await sql`CREATE TABLE roles (id SERIAL PRIMARY KEY, name TEXT UNIQUE NOT NULL, description TEXT,
  permissions JSONB, is_system BOOLEAN DEFAULT FALSE)`;
await sql`CREATE TABLE users (id SERIAL PRIMARY KEY, email TEXT UNIQUE NOT NULL, password_hash TEXT,
  first_name TEXT, last_name TEXT, is_active BOOLEAN DEFAULT TRUE, must_change_password BOOLEAN DEFAULT FALSE)`;
await sql`CREATE TABLE user_roles (user_id INT REFERENCES users(id), role_id INT REFERENCES roles(id),
  PRIMARY KEY (user_id, role_id))`;

function runSeed(extraEnv) {
  return new Promise((resolve) => {
    const env = { ...process.env, DATABASE_URL: DB, NODE_ENV: 'development' };
    delete env.SUPERADMIN_EMAIL;
    delete env.SUPERADMIN_PASSWORD;
    Object.assign(env, extraEnv);
    execFile(process.execPath, ['server/seeds/run.js'], { cwd: REPO, env },
      (err, stdout, stderr) => resolve({ code: err ? err.code ?? 1 : 0, stdout, stderr }));
  });
}

test('A2 (failure path) — no SUPERADMIN_EMAIL/PASSWORD: refuses, seeds no user', async () => {
  for (const partial of [{}, { SUPERADMIN_EMAIL: 'x@sandbox.local' }, { SUPERADMIN_PASSWORD: 'Sb-Pass-2026!' }]) {
    const r = await runSeed(partial);
    assert.notEqual(r.code, 0, `expected refusal for ${JSON.stringify(partial)}; got exit 0\n${r.stdout}`);
    assert.match(r.stdout + r.stderr, /SUPERADMIN_EMAIL|SUPERADMIN_PASSWORD/);
    const [{ count }] = await sql`SELECT count(*)::int AS count FROM users`;
    assert.equal(count, 0, 'refusing seed must write no user row');
  }
});

test('A1 — env values are the ones seeded, and the only ones', async () => {
  const email = 'sb-admin@sandbox.local';
  const password = 'Sb-Sandbox-2026!';
  const r = await runSeed({ SUPERADMIN_EMAIL: email, SUPERADMIN_PASSWORD: password });
  assert.equal(r.code, 0, r.stdout + r.stderr);
  const rows = await sql`SELECT email, password_hash, must_change_password FROM users`;
  assert.equal(rows.length, 1, `expected exactly 1 user, got ${rows.map((u) => u.email).join(', ')}`);
  assert.equal(rows[0].email, email);
  assert.equal(rows[0].must_change_password, true);
  assert.equal(await bcrypt.compare(password, rows[0].password_hash), true, 'seeded password must verify');
  const roles = await sql`SELECT name FROM roles ORDER BY name`;
  assert.deepEqual(roles.map((x) => x.name), ['Admin', 'Manager', 'SuperAdmin', 'Viewer']);
  const links = await sql`SELECT r.name FROM user_roles ur JOIN roles r ON r.id = ur.role_id`;
  assert.deepEqual(links.map((x) => x.name), ['SuperAdmin']);
});

test('A3 — server/seeds carries no e-mail or password literal', () => {
  const dir = path.join(REPO, 'server/seeds');
  for (const f of readdirSync(dir).filter((f) => f.endsWith('.js'))) {
    const src = readFileSync(path.join(dir, f), 'utf8');
    const mail = src.match(/['"][A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}['"]/g) || [];
    assert.deepEqual(mail, [], `${f}: e-mail literal ${mail.join(', ')}`);
    const pw = src.match(/(PASSWORD|password)\s*=\s*['"][^'"]{6,}['"]/g) || [];
    assert.deepEqual(pw, [], `${f}: password literal`);
  }
});

test.after(async () => { await sql.end(); });
