#!/usr/bin/env node
// W8f — WHICH USERS WOULD THE SSO EXCHANGE RE-MAP ON THIS DATABASE?  READ ONLY.
//
// Prints the exact set of users that server/src/routes/hubSso.js would move off migration 126's
// broken default role on their next hub hop, and nothing else. It writes NOTHING: no role, no audit
// row, no column. Point it at a CLONE before you point a store at the code.
//
// It does not restate the rule, it IMPORTS it: `REMAP_CANDIDATE_SQL` and `LEGACY_126_DEFAULT_ROLE`
// come from the route itself, so a census that disagrees with the exchange is impossible.
//
//   node scripts/w8f-remap-census.mjs postgres://postgres@127.0.0.1:5433/dash_w8f_mbclone
//
// Exit 0 whatever it finds — zero candidates is an answer, not an error. Exit 1 only on a real
// failure (no DSN, unreachable database, missing column).
import pg from 'pg';

const dsn = process.argv[2] || process.env.DATABASE_URL;
if (!dsn) {
  console.error('usage: node scripts/w8f-remap-census.mjs <postgres-dsn>');
  process.exit(1);
}
// The route module reads DATABASE_URL at import time; give it the one we were asked about.
process.env.DATABASE_URL = dsn;
const { REMAP_CANDIDATE_SQL, LEGACY_126_DEFAULT_ROLE } = await import('../server/src/routes/hubSso.js');

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
    `SELECT count(*)::int AS n FROM users WHERE created_via = 'hub_sso'`)).rows[0].n;
  const legacyHolders = (await client.query(
    `SELECT count(*)::int AS n FROM users u
      WHERE (SELECT count(*) FROM user_roles ur WHERE ur.user_id = u.id) = 1
        AND EXISTS (SELECT 1 FROM user_roles ur JOIN roles r ON r.id = ur.role_id
                     WHERE ur.user_id = u.id AND r.name = $1)`, [LEGACY_126_DEFAULT_ROLE])).rows[0].n;

  const { rows } = await client.query(
    `${REMAP_CANDIDATE_SQL} ORDER BY u.email`, [LEGACY_126_DEFAULT_ROLE]);

  console.log(`database        : ${dsn.replace(/:\/\/[^@]*@/, '://***@')}`);
  console.log(`users           : ${total}`);
  console.log(`created_via=hub_sso : ${hubMade}`);
  console.log(`holding exactly ["${LEGACY_126_DEFAULT_ROLE}"] : ${legacyHolders}`);
  console.log('');
  console.log(`WOULD BE RE-MAPPED (a)+(b)+(c) : ${rows.length}`);
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
