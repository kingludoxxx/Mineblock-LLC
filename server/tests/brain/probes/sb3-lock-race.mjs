// S4-SB3 probe B — NEW-2: the playbook lock check is outside the transaction.
//
// TWO real connections, a CONTROLLED interleave. Connection 1 runs putPlaybook.
// Connection 2 takes the LOCK at one fixed semantic point: the instant the PUT's
// own lock CHECK (the read of `locked_at` from playbook_products) resolves. That
// is a reviewer clicking Lock during an in-flight PUT.
//
// The harm asserted is P1-4's exactly: A LOCK WAS GRANTED AND THE PLAYBOOK'S
// CONTENT CHANGED AFTERWARDS, so a run manifest naming that locked version means
// nothing.
//
// The trigger point is the SAME line of source in both trees — before the fix the
// read is a bare statement, after it is `SELECT … FOR UPDATE` inside `sql.begin` —
// so the interleave is not re-aimed between RED and GREEN. Connection 2's lock is
// awaited with a 2.5 s ceiling: if it is still blocked when the ceiling expires,
// that IS the fix (the row lock serialises it behind the write).
//
// GUARD: a review probe, not a test. BRAIN_PROBE=1 to run. Own database (R43):
// sb3_lockrace on :5433.
if (process.env.BRAIN_PROBE !== '1') {
  console.log('SKIP  brain/probes: a review probe, not a test — run with BRAIN_PROBE=1 (see probes/README.md)');
  process.exit(0);
}

import postgres from 'postgres';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO = join(HERE, '..', '..', '..', '..');
const PG = 'postgres://postgres@127.0.0.1:5433';
const DBNAME = 'sb3_lockrace';
const DB = `${PG}/${DBNAME}`;

const admin = postgres(`${PG}/postgres`, { ssl: false, onnotice: () => {} });
await admin.unsafe(`DROP DATABASE IF EXISTS ${DBNAME}`);
await admin.unsafe(`CREATE DATABASE ${DBNAME}`);
await admin.end();

Object.assign(process.env, {
  DATABASE_URL: DB, DATABASE_SSL: '0', NODE_ENV: 'development',
  PRODUCT_CODES_JSON: JSON.stringify({ AAA: { default: true } }), STORE_CODE: 'SA',
});
const mig = spawnSync(process.execPath, [join(REPO, 'server/migrations/run.js')], {
  env: { ...process.env, MIGRATE_SSL: '0' }, encoding: 'utf8', timeout: 180000,
});
if (mig.status !== 0) { console.error(mig.stdout, mig.stderr); process.exit(2); }

const conn1 = postgres(DB, { ssl: false, onnotice: () => {}, max: 4 });
const conn2 = postgres(DB, { ssl: false, onnotice: () => {}, max: 4 });
const store = await import(join(REPO, 'server/src/services/brainStore.js'));

// ── the interleave ──────────────────────────────────────────────────────────
// A proxy over connection 1 that fires ONE hook, the first time a statement that
// reads `locked_at` from `playbook_products` resolves. `begin` is proxied too, so
// the hook fires whether that read sits inside the transaction or outside it.
const HEAD_READ = /locked_at[\s\S]*from\s+playbook_products|from\s+playbook_products[\s\S]*locked_at/i;
let hook = null;
let fired = false;

function proxy(handle) {
  return new Proxy(handle, {
    apply(target, thisArg, args) {
      const out = Reflect.apply(target, thisArg, args);
      const text = Array.isArray(args[0]) ? args[0].join(' ? ') : '';
      if (!HEAD_READ.test(text)) return out;
      return (async () => {
        const rows = await out;
        if (!fired && hook) { fired = true; await hook(); }
        return rows;
      })();
    },
    get(target, prop, recv) {
      if (prop === 'begin') {
        return (fn) => target.begin((tx) => fn(proxy(tx)));
      }
      const v = Reflect.get(target, prop, recv);
      return typeof v === 'function' ? v.bind(target) : v;
    },
  });
}
const sql1 = proxy(conn1);

const NOW = () => Number(process.hrtime.bigint() / 1000000n);
const T0 = NOW();
const at = () => `+${String(NOW() - T0).padStart(5)}ms`;
const show = async (where) => {
  const p = await store.getPlaybook(conn2, 'AAA');
  const copy = p.sections?.angles?.[0]?.value?.copy;
  console.log(`  ${where.padEnd(9)} version=${p.version} entry=${JSON.stringify({ copy })} locked_at=${p.locked_at ? new Date(p.locked_at).toISOString() : null} locked_by=${JSON.stringify(p.locked_by)}`);
  return p;
};

// seed: an UNLOCKED playbook at version 1
await store.putPlaybook(conn1, 'AAA', { sections: { angles: [{ key: 'a1', value: { copy: 'before the race' } }] } }, { actor: 'user:the-writer' });
await show('before');

// the hook: connection 2 takes the lock, with a ceiling
let lockOutcome = 'not attempted';
let lockGrantedAt = null;
let lockPromise = null;
hook = async () => {
  console.log(`  [interleave ${at()}] the PUT's lock CHECK has just resolved — connection 2 now asks for the LOCK`);
  lockPromise = store.lockPlaybook(conn2, 'AAA', { actor: 'user:the-reviewer' })
    .then((p) => { lockGrantedAt = NOW(); lockOutcome = `GRANTED (locked_at=${new Date(p.locked_at).toISOString()})`; return p; })
    .catch((e) => { lockGrantedAt = NOW(); lockOutcome = `REFUSED ${e.code || ''} ${e.message}`; return null; });
  const ceiling = new Promise((r) => setTimeout(() => r('CEILING'), 2500));
  const who = await Promise.race([lockPromise.then(() => 'LOCK'), ceiling]);
  if (who === 'CEILING') {
    console.log(`  [interleave ${at()}] connection 2 is STILL BLOCKED after 2500 ms — the write holds the row`);
  } else {
    console.log(`  [interleave ${at()}] connection 2's LOCK returned already: ${lockOutcome}`);
  }
};

let putOutcome = null;
let putCommittedAt = null;
try {
  const p = await store.putPlaybook(sql1, 'AAA', {
    sections: { angles: [{ key: 'a1', value: { copy: 'WRITTEN THROUGH THE RACE' } }] },
  }, { actor: 'user:the-writer' });
  putCommittedAt = NOW();
  putOutcome = `RETURNED version=${p.version} entry=${JSON.stringify(p.sections?.angles?.[0]?.value)}`;
} catch (e) {
  putCommittedAt = NOW();
  putOutcome = `REFUSED ${e.code || ''} ${e.message}`;
}
console.log(`  [interleave ${at()}] putPlaybook ${putOutcome}`);
if (lockPromise) await lockPromise;
console.log(`  [interleave ${at()}] connection 2's LOCK final outcome: ${lockOutcome}`);

const after = await show('after');

// Was a lock GRANTED before the write committed? That is the harm.
const lockWonFirst = lockGrantedAt !== null && lockOutcome.startsWith('GRANTED') && lockGrantedAt < putCommittedAt;
console.log(`\n  hook fired: ${fired}`);
console.log(`  lock GRANTED at ${lockGrantedAt === null ? 'n/a' : `+${lockGrantedAt - T0}ms`}, PUT settled at +${putCommittedAt - T0}ms`);
console.log(`  VERDICT: a lock was granted and the CONTENT changed under it = ${lockWonFirst && after.sections?.angles?.[0]?.value?.copy === 'WRITTEN THROUGH THE RACE'}`);

// ── the OTHER interleaving ──────────────────────────────────────────────────
// A lock that commits while the PUT is between ENTERING putPlaybook and reading
// the head row. The trigger is the PUT's first statement — the citation check,
// which sits before the transaction in both trees. Before the fix the head read
// followed it and saw the lock, so this direction already refused; it is here so
// that BOTH orderings are on the record, and because it is the direction that
// proves the check is genuinely re-read inside the transaction rather than
// carried over from a value read earlier.
console.log('\n  ── interleaving 2: the LOCK commits BEFORE the write reaches its check ──');
{
  await store.unlockPlaybook(conn2, 'AAA', { actor: 'user:the-reviewer' });
  const [ins] = await conn2`INSERT INTO kb_insights (insight_type, body, status, proposed_by)
    VALUES ('pain','a citable approved claim','approved','seed') RETURNING id`;
  fired = false;
  hook = async () => {
    console.log(`  [interleave ${at()}] the PUT's CITATION check has resolved — connection 2 locks and COMMITS`);
    const p = await store.lockPlaybook(conn2, 'AAA', { actor: 'user:the-reviewer' });
    console.log(`  [interleave ${at()}] lock committed: locked_at=${new Date(p.locked_at).toISOString()}`);
  };
  // re-aim the hook at the citation statement
  HEAD_READ.lastIndex = 0;
  const CITATION = /select\s+id,\s*status\s+from\s+kb_insights/i;
  const sql2 = new Proxy(conn1, {
    apply(target, thisArg, args) {
      const out = Reflect.apply(target, thisArg, args);
      const text = Array.isArray(args[0]) ? args[0].join(' ? ') : '';
      if (!CITATION.test(text)) return out;
      return (async () => { const rows = await out; if (!fired && hook) { fired = true; await hook(); } return rows; })();
    },
    get(target, prop, recv) {
      if (prop === 'begin') return (fn) => target.begin((tx) => fn(sql2Inner(tx)));
      const v = Reflect.get(target, prop, recv);
      return typeof v === 'function' ? v.bind(target) : v;
    },
  });
  const sql2Inner = (tx) => tx;
  let outcome;
  try {
    const p = await store.putPlaybook(sql2, 'AAA', {
      sections: { angles: [{ key: 'a1', value: { copy: 'MUST NOT LAND' }, cites: [Number(ins.id)] }] },
    }, { actor: 'user:the-writer' });
    outcome = `RETURNED version=${p.version} entry=${JSON.stringify(p.sections?.angles?.[0]?.value)}`;
  } catch (e) {
    outcome = `REFUSED HTTP ${e.status} code=${e.code}: ${e.message}`;
  }
  console.log(`  [interleave ${at()}] putPlaybook ${outcome}`);
  await show('after');
}

await conn1.end(); await conn2.end();
console.log('\n(probe B done)');
