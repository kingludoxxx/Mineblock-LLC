#!/usr/bin/env node
// W8f — WHICH USERS WOULD THE SSO EXCHANGE RE-MAP ON THIS DATABASE?  READ ONLY.
//
// Prints the exact set of users that server/src/routes/hubSso.js would move off migration 126's
// broken default role on their next hub hop, and nothing else. It writes NOTHING: no role, no audit
// row, no column. Point it at a CLONE before you point a store at the code.
//
// It does not restate the rule, it IMPORTS it: `REMAP_CANDIDATE_SQL`, `LEGACY_126_DEFAULT_ROLE` and
// the two `created_via` values come from the route itself, so a census that disagrees with the
// exchange is impossible. Since W8g the rule includes the LATCH — a user whose one repair has been
// spent carries `created_via = 'hub_sso_repaired'` and is counted separately below, never as a
// candidate — and `is_active` / `locked_until`, so the census cannot name a user the exchange would
// turn away at the door (401 / 423).
//
//   DATABASE_URL=postgres://postgres@127.0.0.1:5433/dash_w8g_mbclone node scripts/w8f-remap-census.mjs
//
// THE DSN COMES FROM THE ENVIRONMENT, NEVER FROM argv (R20, REVIEW-W8F P2-2). A live store's DSN
// carries a password, and argv is world-readable in `ps` and lands in shell history; an environment
// variable on the process is neither. Passing one as an argument is refused rather than accepted
// quietly, so a habit formed on a clone does not leak a password on a live database.
//
// Exit 0 whatever it finds — zero candidates is an answer, not an error. Exit 1 only on a real
// failure (no DSN, a DSN on argv, unreachable database, missing column).
import pg from 'pg';

if (process.argv.length > 2) {
  console.error('refusing a DSN on the command line: argv is visible in `ps` and in shell history (R20).');
  console.error('usage: DATABASE_URL=postgres://user@host/db node scripts/w8f-remap-census.mjs');
  process.exit(1);
}
const dsn = process.env.DATABASE_URL;
if (!dsn) {
  console.error('usage: DATABASE_URL=postgres://user@host/db node scripts/w8f-remap-census.mjs');
  process.exit(1);
}
const { REMAP_CANDIDATE_SQL, LEGACY_126_DEFAULT_ROLE, CREATED_VIA_HUB_SSO, CREATED_VIA_HUB_SSO_REPAIRED }
  = await import('../server/src/routes/hubSso.js');

const client = new pg.Client({ connectionString: dsn });
await client.connect();
try {
  const { rows: col } = await client.query(
    `SELECT 1 FROM information_schema.columns WHERE table_name = 'users' AND column_name = 'created_via'`);
  if (col.length === 0) {
    console.error('users.created_via does not exist on this database — migration 135 has not run here.');
    console.error('The exchange refuses the repair in that state (fail closed); run the migrations first.');
    process.exit(1);
  }

  const total = (await client.query('SELECT count(*)::int AS n FROM users')).rows[0].n;
  const hubMade = (await client.query(
    'SELECT count(*)::int AS n FROM users WHERE created_via = $1', [CREATED_VIA_HUB_SSO])).rows[0].n;
  // W8g: rows whose one repair has already been spent. They can never be candidates again, and an
  // operator reading this census needs to see that they exist rather than wonder where they went.
  const repaired = (await client.query(
    'SELECT count(*)::int AS n FROM users WHERE created_via = $1', [CREATED_VIA_HUB_SSO_REPAIRED])).rows[0].n;
  const legacyHolders = (await client.query(
    `SELECT count(*)::int AS n FROM users u
      WHERE (SELECT count(*) FROM user_roles ur WHERE ur.user_id = u.id) = 1
        AND EXISTS (SELECT 1 FROM user_roles ur JOIN roles r ON r.id = ur.role_id
                     WHERE ur.user_id = u.id AND r.name = $1)`, [LEGACY_126_DEFAULT_ROLE])).rows[0].n;

  const { rows } = await client.query(
    `${REMAP_CANDIDATE_SQL} ORDER BY u.email`, [LEGACY_126_DEFAULT_ROLE]);

  console.log(`database        : ${dsn.replace(/:\/\/[^@]*@/, '://***@')}`);
  console.log(`users           : ${total}`);
  console.log(`created_via=${CREATED_VIA_HUB_SSO} : ${hubMade}`);
  console.log(`created_via=${CREATED_VIA_HUB_SSO_REPAIRED} (repair already spent, never again) : ${repaired}`);
  console.log(`holding exactly ["${LEGACY_126_DEFAULT_ROLE}"] : ${legacyHolders}`);
  console.log('');
  console.log(`WOULD BE RE-MAPPED (a)+(b)+(c)+(d) : ${rows.length}`);
  for (const r of rows) console.log(`   ${r.email}   (${r.id})`);
  if (rows.length === 0) console.log('   (none)');

  // The other side of the answer: everyone the rule leaves alone, so "none" is never taken on trust.
  const { rows: untouched } = await client.query(
    `SELECT u.email, COALESCE(string_agg(r.name, '+' ORDER BY r.name), '(no role)') AS roles,
            COALESCE(u.created_via, '-') AS created_via
       FROM users u
       LEFT JOIN user_roles ur ON ur.user_id = u.id
       LEFT JOIN roles r ON r.id = ur.role_id
      WHERE NOT (u.id = ANY($1::uuid[]))
      GROUP BY u.id, u.email, u.created_via
      ORDER BY u.email`, [rows.map((r) => r.id)]);
  console.log('');
  console.log(`UNTOUCHED : ${untouched.length}`);
  for (const u of untouched) console.log(`   ${u.email.padEnd(40)} created_via=${u.created_via.padEnd(8)} roles=${u.roles}`);
} finally {
  await client.end();
}
process.exit(0);
