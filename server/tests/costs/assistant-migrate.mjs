// SCHEMA FORWARD-FIX — its own file, and its own scratch database.
//
// ensureCogsAssistantTables memoizes its DDL in a module-level promise, so a
// second database cannot be exercised in the same process as assistant.mjs.
// Hence a separate runner rather than another block in that suite.
//
// Run:  node server/tests/costs/assistant-migrate.mjs
//
// Proves the forward-fix in cogsAssistantSchema.js upgrades a database that
// was created by the FIRST cut of the file (UNIQUE batch_id, no event_id, no
// skipped columns) without losing the row that is already in it.
const DB = 'postgres://puure@127.0.0.1:5433/puure_cogs_migrate';
process.env.DATABASE_URL = DB;
process.env.NODE_ENV = 'development';

const NM = '/Users/ludo/Mineblock-LLC/node_modules';
const postgres = (await import(`${NM}/postgres/src/index.js`)).default;

const admin = postgres('postgres://puure@127.0.0.1:5433/postgres', { ssl: false });
await admin`DROP DATABASE IF EXISTS puure_cogs_migrate`;
await admin`CREATE DATABASE puure_cogs_migrate`;
await admin.end();
const sql = postgres(DB, { ssl: false, onnotice: () => {} });

// ── the OLD shape, exactly as the first cut created it ────────────────────
await sql`
  CREATE TABLE lb_cogs_assistant_audit (
    id BIGSERIAL PRIMARY KEY,
    batch_id TEXT NOT NULL UNIQUE,
    kind TEXT NOT NULL DEFAULT 'chat' CHECK (kind IN ('chat','quote')),
    model TEXT NOT NULL DEFAULT '',
    source_text TEXT NOT NULL DEFAULT '',
    quote_scan_id TEXT,
    proposal JSONB NOT NULL DEFAULT '[]',
    applied JSONB NOT NULL DEFAULT '[]',
    applied_count INT NOT NULL DEFAULT 0,
    rejected_count INT NOT NULL DEFAULT 0,
    created_by TEXT NOT NULL DEFAULT '',
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
  )`;
await sql`INSERT INTO lb_cogs_assistant_audit (batch_id, kind, model, created_by, applied_count)
          VALUES ('cab_legacy_one', 'chat', 'claude-fable-5', 'old@local.test', 3)`;

let pass = 0; let fail = 0;
const ok = (c, m, x = '') => { if (c) { pass += 1; console.log('PASS ', m); } else { fail += 1; console.log('FAIL ', m, x); } };

const { ensureCogsAssistantTables } = await import(
  '../../src/services/cogsAssistantSchema.js');

await ensureCogsAssistantTables();

const cons = await sql`
  SELECT conname FROM pg_constraint
  WHERE conrelid = 'lb_cogs_assistant_audit'::regclass AND contype = 'u'`;
ok(!cons.some((c) => c.conname === 'lb_cogs_assistant_audit_batch_id_key'),
  `the UNIQUE constraint on batch_id is gone (${cons.map((c) => c.conname).join(',') || 'none'})`);

const cols = (await sql`
  SELECT column_name FROM information_schema.columns WHERE table_name = 'lb_cogs_assistant_audit'`)
  .map((c) => c.column_name);
ok(cols.includes('event_id') && cols.includes('skipped') && cols.includes('skipped_count'),
  `the new columns exist (${cols.join(',')})`);

const rows = await sql`SELECT id, batch_id, event_id, applied_count, created_by FROM lb_cogs_assistant_audit`;
ok(rows.length === 1, `the legacy row SURVIVED (${rows.length})`);
ok(rows[0].batch_id === 'cab_legacy_one' && rows[0].applied_count === 3 && rows[0].created_by === 'old@local.test',
  'with its data intact');
ok(rows[0].event_id === `evt_legacy_${rows[0].id}`, `and a backfilled event id (${rows[0].event_id})`);

const idx = await sql`SELECT indexname FROM pg_indexes WHERE tablename = 'lb_cogs_assistant_audit'`;
const names = idx.map((i) => i.indexname);
ok(names.includes('idx_lb_cogs_audit_event'), `the unique event index was built (${names.join(',')})`);
ok(names.includes('idx_lb_cogs_audit_batch'), 'and batch_id is indexed but no longer unique');

// Two audit rows under ONE batch id — the whole point of the change.
await sql`INSERT INTO lb_cogs_assistant_audit (event_id, batch_id) VALUES ('evt_a', 'cab_shared')`;
await sql`INSERT INTO lb_cogs_assistant_audit (event_id, batch_id) VALUES ('evt_b', 'cab_shared')`;
const shared = await sql`SELECT id FROM lb_cogs_assistant_audit WHERE batch_id = 'cab_shared'`;
ok(shared.length === 2, `two apply events can now share one batch id (${shared.length})`);
let dupThrew = false;
try {
  await sql`INSERT INTO lb_cogs_assistant_audit (event_id, batch_id) VALUES ('evt_a', 'cab_other')`;
} catch { dupThrew = true; }
ok(dupThrew, 'while a duplicate event id is still refused');

// Idempotent: running it a second time changes nothing and throws nothing.
await ensureCogsAssistantTables.call(null);
const again = await sql`SELECT COUNT(*)::int AS n FROM lb_cogs_assistant_audit`;
ok(again[0].n === 3, `re-running the ensure is a no-op (${again[0].n} rows)`);

await sql.end();
console.log(`\nRESULT: ${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
