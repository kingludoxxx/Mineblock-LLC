// AI DEVELOPER EXTRAS — route-level verification for the PERSISTED THREAD and
// the exposed MODEL ALLOWLIST.
//
// The REAL router (REAL authenticate + requirePermission + ensureTables +
// ensureAiDevChatTables) mounted on a minimal express host against a fresh
// embedded-PG database — same shape as builder/page-versions.mjs.
//
// Asserts BY EXECUTION:
//   • GET /models returns the server's allowlist and its default
//   • 401 without a token on every thread verb
//   • append → GET round-trip, OLDEST FIRST, with the attachment jsonb intact
//   • the 50-message bound holds against a 60-message thread, and it keeps the
//     NEWEST 50 (the failure mode being defended is `ORDER BY id ASC LIMIT 50`,
//     which returns the oldest and hides every recent turn)
//   • DELETE clears, and a second DELETE is a clean 0 rather than an error
//   • CROSS-FUNNEL: the same page id under the wrong funnel 404s on GET and on
//     DELETE, and a DELETE aimed at the wrong funnel deletes NOTHING
//   • an ARCHIVED page 404s
//   • a missing page_id/funnel_id is a 400, an unknown page a 404
//   • image BYTES are never stored — the column set cannot hold them
//   • a jsonb attachment survives a real Postgres round-trip in BOTH the parsed
//     and the ::text shape
//
// Run:  node server/tests/ai-developer/thread-routes.mjs
import postgres from 'postgres';

const DB = 'postgres://puure@127.0.0.1:5433/puure_aidev';
let pass = 0, fail = 0;
const ok = (c, m, x = '') => { if (c) { pass++; console.log('PASS ', m); } else { fail++; console.log('FAIL ', m, x); } };
const eq = (got, want, m) => ok(
  JSON.stringify(got) === JSON.stringify(want), m,
  `\n      got  ${JSON.stringify(got)}\n      want ${JSON.stringify(want)}`
);
// JSONB normalizes object-key order, so equality on a value that has been
// through a jsonb column must be CANONICAL. (This is not cosmetic: the first
// run of this harness "passed" a byte-order comparison precisely BECAUSE the
// attachment was being stored as a double-encoded STRING and came back
// byte-identical. Real jsonb reorders — and the reorder is the proof.)
const canon = (v) => {
  if (Array.isArray(v)) return `[${v.map(canon).join(',')}]`;
  if (v && typeof v === 'object') {
    return `{${Object.keys(v).sort().map((k) => `${JSON.stringify(k)}:${canon(v[k])}`).join(',')}}`;
  }
  return JSON.stringify(v);
};
const eqJson = (got, want, m) => ok(
  canon(got) === canon(want), m,
  `\n      got  ${JSON.stringify(got)}\n      want ${JSON.stringify(want)}`
);

const admin = postgres('postgres://puure@127.0.0.1:5433/postgres', { ssl: false });
await admin`DROP DATABASE IF EXISTS puure_aidev`;
await admin`CREATE DATABASE puure_aidev`;
await admin.end();

Object.assign(process.env, {
  DATABASE_URL: DB, NODE_ENV: 'development',
  JWT_ACCESS_SECRET: 'localdev', JWT_REFRESH_SECRET: 'localdev',
  MONEY_SWEEP_DISABLED: '1', TRACKING_SWEEPS_DISABLED: '1', DOMAIN_SWEEP_DISABLED: '1',
});

const { default: express } = await import('express');
const { default: funnelsRoutes, ensureTables } = await import('../../src/routes/funnels.js');
const { default: aiDevRoutes, MODEL_ALLOWLIST, DEFAULT_MODEL } = await import('../../src/routes/aiDeveloper.js');
const {
  THREAD_LIMIT, appendThread, clearThread, ensureAiDevChatTables, openThreadEpoch,
  readThread, readThreadEpoch,
} = await import('../../src/services/aiDeveloperSchema.js');

const app = express();
app.use(express.json({ limit: '10mb' }));
app.use('/api/v1/funnels', funnelsRoutes);
app.use('/api/v1/ai-developer', aiDevRoutes);
const server = app.listen(0);
await new Promise((r) => server.once('listening', r));
const PORT = server.address().port;

const sql = postgres(DB, { ssl: false });
const { signAccessToken } = await import('../../src/utils/jwt.js');
await ensureTables();
await ensureAiDevChatTables();

// ---- Seed: user + funnels role -------------------------------------------
await sql`CREATE TABLE IF NOT EXISTS users (
  id TEXT PRIMARY KEY, email TEXT, first_name TEXT, last_name TEXT,
  must_change_password BOOLEAN DEFAULT FALSE, email_verified BOOLEAN DEFAULT TRUE,
  is_active BOOLEAN DEFAULT TRUE
)`;
await sql`CREATE TABLE IF NOT EXISTS roles (id TEXT PRIMARY KEY, name TEXT, permissions JSONB)`;
await sql`CREATE TABLE IF NOT EXISTS user_roles (user_id TEXT, role_id TEXT)`;
await sql`INSERT INTO users (id, email, first_name, last_name) VALUES ('u_aidev','a@t.co','A','I')`;
await sql`INSERT INTO roles (id, name, permissions) VALUES ('r_aidev','aidev-tester', ${sql.json({ funnels: ['access'] })})`;
await sql`INSERT INTO user_roles (user_id, role_id) VALUES ('u_aidev','r_aidev')`;
const TOKEN = signAccessToken({ userId: 'u_aidev' });

const FB_ = `http://127.0.0.1:${PORT}/api/v1/funnels`;
const AB = `http://127.0.0.1:${PORT}/api/v1/ai-developer`;
const H = { Authorization: `Bearer ${TOKEN}`, 'Content-Type': 'application/json' };

const call = (base) => async (method, path, body, headers = H) => {
  const r = await fetch(`${base}${path}`, {
    method, headers, body: body === undefined ? undefined : JSON.stringify(body),
  });
  let j = null; try { j = await r.json(); } catch { /* non-JSON body */ }
  return { status: r.status, j };
};
const freq = call(FB_);
const areq = call(AB);

// ---- Seed: funnel A + page, funnel B + decoy page -------------------------
const fa = await freq('POST', '/', { name: 'AI A', slug: 'aidev-harness-a' });
const fb = await freq('POST', '/', { name: 'AI B', slug: 'aidev-harness-b' });
ok(fa.status === 201 && fb.status === 201, 'seed: two funnels created', JSON.stringify({ a: fa.status, b: fb.status }));
const FA = fa.j?.data?.id;
const FBID = fb.j?.data?.id;

const p1 = await freq('POST', `/${FA}/pages`, { title: 'Chatted page', slug: '/', type: 'generic' });
ok(p1.status === 201, 'seed: page created', JSON.stringify(p1.j));
const P1 = p1.j?.data?.id;

const p2 = await freq('POST', `/${FA}/pages`, { title: 'Second page', slug: '/two', type: 'generic' });
const P2 = p2.j?.data?.id;
ok(p2.status === 201, 'seed: a SECOND page in the same funnel (thread isolation decoy)');

const pb = await freq('POST', `/${FBID}/pages`, { title: 'Other funnel', slug: '/', type: 'generic' });
const PB = pb.j?.data?.id;
ok(pb.status === 201, 'seed: decoy page in funnel B');

const q = (pid, fid) => `/chat?page_id=${encodeURIComponent(pid)}&funnel_id=${encodeURIComponent(fid)}`;

// ===========================================================================
// GET /models — the server exposes its allowlist
// ===========================================================================
console.log('\n=== GET /models ===');
{
  const r = await areq('GET', '/models');
  ok(r.status === 200, 'GET /models is 200', JSON.stringify(r.j));
  eq(r.j?.data?.models?.map((m) => m.id), [...MODEL_ALLOWLIST],
    'the exposed ids are exactly the enforced allowlist');
  eq(r.j?.data?.default, DEFAULT_MODEL, 'the default is exposed');
  ok(r.j?.data?.models?.every((m) => typeof m.label === 'string' && m.label),
    'every exposed model carries a label');
}
{
  const r = await areq('GET', '/models', undefined, { 'Content-Type': 'application/json' });
  eq(r.status, 401, 'GET /models without a token is 401 — the allowlist is not public');
}

// ===========================================================================
// Auth gate on the thread verbs
// ===========================================================================
console.log('\n=== auth gate ===');
{
  const noAuth = { 'Content-Type': 'application/json' };
  const g = await areq('GET', q(P1, FA), undefined, noAuth);
  const d = await areq('DELETE', q(P1, FA), undefined, noAuth);
  eq(g.status, 401, 'GET /chat without a token is 401');
  eq(d.status, 401, 'DELETE /chat without a token is 401');
}

// ===========================================================================
// Round-trip
// ===========================================================================
console.log('\n=== append → read round-trip ===');
{
  const r = await areq('GET', q(P1, FA));
  ok(r.status === 200, 'GET on a page with no thread is 200', JSON.stringify(r.j));
  eq(r.j?.data?.messages, [], 'an unused page has an EMPTY thread, not a 404');
  eq(r.j?.data?.limit, THREAD_LIMIT, 'the response advertises the bound');
}
{
  const n = await appendThread(P1, FA, [
    {
      role: 'user', content: 'make the headline bigger', image_count: 2,
      attachment: { block_id: 'blk_hero', block_type: 'hero', excerpt: 'Lift in 30 days' },
      model: 'claude-fable-5',
    },
    { role: 'assistant', content: 'Done — 1 op applied.', ops_count: 1, model: 'claude-fable-5' },
  ], { createdBy: 'u_aidev' });
  eq(n, 2, 'appendThread reports 2 rows written');

  const r = await areq('GET', q(P1, FA));
  const msgs = r.j?.data?.messages || [];
  eq(msgs.length, 2, 'both messages come back');
  eq(msgs[0].role, 'user', 'OLDEST FIRST — the user turn is first');
  eq(msgs[1].role, 'assistant', 'and the assistant turn second');
  eq(msgs[0].content, 'make the headline bigger', 'the user text round-trips');
  eq(msgs[0].image_count, 2, 'the image COUNT round-trips');
  eqJson(msgs[0].attachment, { block_id: 'blk_hero', block_type: 'hero', excerpt: 'Lift in 30 days' },
    'the jsonb attachment survives a REAL Postgres round-trip (compared CANONICALLY — jsonb reorders keys)');
  eq(Object.keys(msgs[0].attachment).sort(), ['block_id', 'block_type', 'excerpt'],
    'and it carries exactly the three chip fields, no more');
  eq(msgs[1].ops_count, 1, 'the assistant ops_count round-trips');
  eq(msgs[0].model, 'claude-fable-5', 'the model that produced the turn is recorded');
  ok(typeof msgs[0].id === 'string', 'the row id crosses the wire as a string');
  ok(msgs[0].created_at && !Number.isNaN(Date.parse(msgs[0].created_at)), 'created_at parses as an instant');
}
{
  // jsonb DISCIPLINE: the column must hold a real jsonb object, not the string
  // "[object Object]" that a bare-object bind produces.
  const [row] = await sql`SELECT jsonb_typeof(attachment) AS t, attachment->>'block_id' AS bid
                            FROM lb_ai_dev_chats WHERE page_id = ${P1} AND role = 'user' ORDER BY id LIMIT 1`;
  eq(row.t, 'object', 'the attachment column holds a jsonb OBJECT (not a string, not "[object Object]")');
  eq(row.bid, 'blk_hero', 'and Postgres can address its keys — proof it is real jsonb, not a jsonb-encoded string');
}
{
  // The stored shape can hold no image bytes: there is no column for them.
  const cols = await sql`SELECT column_name FROM information_schema.columns
                          WHERE table_name = 'lb_ai_dev_chats'`;
  const names = cols.map((c) => c.column_name).sort();
  ok(!names.some((n) => /image_data|images|payload|bytes|blob|data_url/.test(n)),
    'THE INVARIANT: the table has NO column that could hold image bytes', names.join(','));
  ok(names.includes('image_count'), 'only the count is stored');
}
{
  // Thread isolation between pages of the SAME funnel.
  const r = await areq('GET', q(P2, FA));
  eq(r.j?.data?.messages, [], 'a sibling page in the same funnel has its OWN (empty) thread');
}

// ===========================================================================
// The 50-message bound
// ===========================================================================
console.log('\n=== the 50-message bound ===');
{
  const many = Array.from({ length: 60 }, (_, i) => ({ role: i % 2 ? 'assistant' : 'user', content: `turn-${i}` }));
  await appendThread(P2, FA, many);

  const [{ count }] = await sql`SELECT COUNT(*)::int AS count FROM lb_ai_dev_chats WHERE page_id = ${P2}`;
  eq(count, THREAD_LIMIT, 'the PRUNE ran in the write transaction — only 50 rows survive on disk');

  const r = await areq('GET', q(P2, FA));
  const msgs = r.j?.data?.messages || [];
  eq(msgs.length, THREAD_LIMIT, 'the endpoint returns 50');
  eq(msgs[0].content, 'turn-10', 'the NEWEST 50 survived — turn-10, not turn-0 (an ASC LIMIT would answer turn-0 and hide every recent turn)');
  eq(msgs[49].content, 'turn-59', 'and the last entry is the newest message');
}
{
  // Appending again past the cap keeps it at the cap.
  await appendThread(P2, FA, [{ role: 'user', content: 'turn-60' }]);
  const [{ count }] = await sql`SELECT COUNT(*)::int AS count FROM lb_ai_dev_chats WHERE page_id = ${P2}`;
  eq(count, THREAD_LIMIT, 'a further append does not grow the thread past the cap');
  const msgs = await readThread(P2, FA);
  eq(msgs[49].content, 'turn-60', 'and the new turn is the newest one');
  eq(msgs[0].content, 'turn-11', 'the oldest survivor advanced by exactly one');
}
{
  eq(await appendThread(P2, FA, []), 0, 'appending an EMPTY list writes nothing');
  eq(await appendThread(P2, FA, [{ role: 'system', content: 'x' }]), 0,
    'appending only unstorable messages writes nothing (and does not open a transaction that fails)');
  eq(await appendThread(P2, FA, null), 0, 'appending null writes nothing, never throws');
}

// ===========================================================================
// F4 — the prune bound under REAL concurrency
// ===========================================================================
// The header used to claim a burst "can never outrun a pruner". That was only
// true single-threaded: two appends racing could each see <=50 rows and each
// insert. The epoch row is now locked FOR UPDATE by every append, which
// serializes them per thread and makes the bound EXACT. This asserts the
// contract that is actually kept.
console.log('\n=== the bound under concurrency (F4) ===');
{
  const p3 = await freq('POST', `/${FA}/pages`, { title: 'Concurrent', slug: '/three', type: 'generic' });
  const P3 = p3.j?.data?.id;
  ok(p3.status === 201, 'seed: a third page for the concurrency case');

  // 40 appends x 4 messages = 160 messages, fired in PARALLEL at one thread.
  const bursts = Array.from({ length: 40 }, (_, i) => appendThread(P3, FA, [
    { role: 'user', content: `c${i}-a` }, { role: 'assistant', content: `c${i}-b` },
    { role: 'user', content: `c${i}-c` }, { role: 'assistant', content: `c${i}-d` },
  ]));
  const written = await Promise.all(bursts);
  eq(written.reduce((a, b) => a + b, 0), 160, 'all 160 messages report as written');

  const [{ count }] = await sql`SELECT COUNT(*)::int AS count FROM lb_ai_dev_chats WHERE page_id = ${P3}`;
  eq(count, THREAD_LIMIT,
    'THE BOUND IS EXACT UNDER CONCURRENCY — 40 parallel appends leave exactly 50 rows, not 50+excess');

  const msgs = await readThread(P3, FA);
  eq(msgs.length, THREAD_LIMIT, 'and the read agrees');
  ok(new Set(msgs.map((m) => m.id)).size === THREAD_LIMIT, 'with no duplicate rows');
}

// ===========================================================================
// F3 — the epoch: a clear beats an in-flight append
// ===========================================================================
console.log('\n=== the thread epoch (F3) ===');
{
  const p4 = await freq('POST', `/${FA}/pages`, { title: 'Epoch', slug: '/four', type: 'generic' });
  const P4 = p4.j?.data?.id;
  ok(p4.status === 201, 'seed: a page for the epoch cases');

  eq(await readThreadEpoch(P4, FA), '0', 'a never-used thread reads epoch 0 WITHOUT creating a row');
  const opened = await openThreadEpoch(P4, FA);
  eq(opened, '0', 'opening the epoch returns 0 and creates the row');
  eq(await openThreadEpoch(P4, FA), '0', 'opening again is idempotent — it does NOT bump');

  await appendThread(P4, FA, [{ role: 'user', content: 'kept' }], { expectEpoch: opened });
  eq((await readThread(P4, FA)).length, 1, 'an append with the CURRENT epoch is written');

  // The defect: a turn opens at epoch N, the operator clears, the turn persists.
  const stale = await openThreadEpoch(P4, FA);
  const cleared = await clearThread(P4, FA);
  eq(cleared, 1, 'the clear removed the existing row');
  eq(await readThreadEpoch(P4, FA), '1', 'and BUMPED the epoch');

  const wrote = await appendThread(P4, FA, [
    { role: 'user', content: 'ghost' }, { role: 'assistant', content: 'ghost reply' },
  ], { expectEpoch: stale });
  eq(wrote, 0, 'F3: an append holding the STALE epoch writes NOTHING');
  const [{ c }] = await sql`SELECT COUNT(*)::int AS c FROM lb_ai_dev_chats WHERE page_id = ${P4}`;
  eq(c, 0, 'F3: THE CLEARED THREAD STAYS CLEARED — the in-flight turn did not repopulate it');

  // And the thread is usable again immediately afterwards.
  const fresh = await openThreadEpoch(P4, FA);
  eq(fresh, '1', 'the next turn opens at the new epoch');
  eq(await appendThread(P4, FA, [{ role: 'user', content: 'after' }], { expectEpoch: fresh }), 1,
    'and appends normally — the clear did not wedge the thread');
  eq((await readThread(P4, FA)).map((m) => m.content), ['after'], 'only the post-clear turn is present');
}
{
  // An append with NO expectEpoch is unconditional (the escape hatch stays open).
  const p5 = await freq('POST', `/${FA}/pages`, { title: 'Uncond', slug: '/five', type: 'generic' });
  const P5 = p5.j?.data?.id;
  await openThreadEpoch(P5, FA);
  await clearThread(P5, FA); // epoch is now 1
  eq(await appendThread(P5, FA, [{ role: 'user', content: 'x' }]), 1,
    'an append that passes NO epoch is unconditional');
}
{
  // Epochs are per (page, funnel) — clearing one must not stand down another.
  // NB: deliberately NOT clearing P1 here. An earlier draft did, and it emptied
  // the thread the DELETE section below asserts a count of — the harness broke
  // its own later case. Cross-test state is a real hazard in a shared-DB run.
  const p6 = await freq('POST', `/${FA}/pages`, { title: 'Sibling', slug: '/six', type: 'generic' });
  const P6 = p6.j?.data?.id;
  await openThreadEpoch(P6, FA);
  const siblingBefore = await readThreadEpoch(P6, FA);
  const p7 = await freq('POST', `/${FA}/pages`, { title: 'Cleared', slug: '/seven', type: 'generic' });
  const P7 = p7.j?.data?.id;
  await openThreadEpoch(P7, FA);
  await clearThread(P7, FA);
  eq(await readThreadEpoch(P7, FA), '1', 'the cleared page\'s epoch advanced');
  eq(await readThreadEpoch(P6, FA), siblingBefore, 'clearing one page does not move a sibling page\'s epoch');
}

// ===========================================================================
// Cross-funnel + missing-page refusals
// ===========================================================================
console.log('\n=== cross-funnel / not-found ===');
{
  const r = await areq('GET', q(P1, FBID));
  eq(r.status, 404, 'the RIGHT page id under the WRONG funnel is a 404 on GET');
}
{
  const before = await sql`SELECT COUNT(*)::int AS c FROM lb_ai_dev_chats WHERE page_id = ${P1}`;
  const r = await areq('DELETE', q(P1, FBID));
  eq(r.status, 404, 'and a 404 on DELETE');
  const after = await sql`SELECT COUNT(*)::int AS c FROM lb_ai_dev_chats WHERE page_id = ${P1}`;
  eq(after[0].c, before[0].c, 'THE DELETE THAT 404s DELETED NOTHING — the refusal is not just a status code');
}
{
  eq((await areq('GET', '/chat?page_id=&funnel_id=')).status, 400, 'a missing page_id/funnel_id is a 400');
  eq((await areq('GET', '/chat')).status, 400, 'no query at all is a 400');
  eq((await areq('DELETE', '/chat')).status, 400, 'DELETE with no query is a 400');
  eq((await areq('GET', q('pg_does_not_exist', FA))).status, 404, 'an unknown page id is a 404');
  eq((await areq('GET', q(P1, 'fn_does_not_exist'))).status, 404, 'an unknown funnel id is a 404');
}
{
  // An archived page must not expose its thread.
  await sql`UPDATE funnel_pages SET archived = TRUE WHERE id = ${PB}`;
  await appendThread(PB, FBID, [{ role: 'user', content: 'hidden' }]);
  const r = await areq('GET', q(PB, FBID));
  eq(r.status, 404, 'an ARCHIVED page 404s rather than serving its thread');
}

// ===========================================================================
// DELETE
// ===========================================================================
console.log('\n=== DELETE /chat ===');
{
  const r = await areq('DELETE', q(P1, FA));
  eq(r.status, 200, 'DELETE is 200');
  eq(r.j?.data?.cleared, 2, 'it reports how many messages it removed');

  const g = await areq('GET', q(P1, FA));
  eq(g.j?.data?.messages, [], 'the thread is gone');

  const [{ c }] = await sql`SELECT COUNT(*)::int AS c FROM lb_ai_dev_chats WHERE page_id = ${P1}`;
  eq(c, 0, 'and the rows are gone from disk, not just hidden');
}
{
  const r = await areq('DELETE', q(P1, FA));
  eq(r.status, 200, 'a SECOND delete is a clean 200, not an error');
  eq(r.j?.data?.cleared, 0, 'and reports 0 — clearing an empty thread is not a failure');
}
{
  // The sibling page's thread must be untouched by P1's clear.
  const msgs = await readThread(P2, FA);
  eq(msgs.length, THREAD_LIMIT, 'clearing one page did NOT clear its sibling in the same funnel');
}

await sql.end();
server.close();
console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
