// Opt-in lead storage — single owner of the optin_leads DDL so the intake
// route (routes/optinPublic.js) and any future admin read surface can never
// drift. Leads only: NO money fields, NO payment data, ever. Deliberately a
// separate table + file from the co_* checkout schema — the auth/money
// boundary stays a file boundary.
import { pgQuery } from '../db/pg.js';

// Concurrent requests must not run the DDL simultaneously — Postgres throws
// on parallel CREATE TABLE IF NOT EXISTS (pg_type unique violation). A single
// in-flight promise serializes setup; on failure it resets so the next
// request retries. (Same pattern as services/checkoutSchema.js.)
let tablesReadyPromise = null;

export function ensureOptinTables() {
  if (!tablesReadyPromise) {
    tablesReadyPromise = createTables().catch((err) => {
      tablesReadyPromise = null;
      throw err;
    });
  }
  return tablesReadyPromise;
}

async function createTables() {
  await pgQuery(`
    CREATE TABLE IF NOT EXISTS optin_leads (
      id TEXT PRIMARY KEY,
      funnel_id TEXT,
      page_id TEXT,
      email TEXT NOT NULL,
      name TEXT,
      ip TEXT,
      user_agent TEXT,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )
  `);
  await pgQuery(
    `CREATE INDEX IF NOT EXISTS idx_optin_leads_funnel ON optin_leads (funnel_id)`
  );
  await pgQuery(
    `CREATE INDEX IF NOT EXISTS idx_optin_leads_email ON optin_leads (lower(email))`
  );
  await pgQuery(
    `CREATE INDEX IF NOT EXISTS idx_optin_leads_created ON optin_leads (created_at DESC)`
  );
}

// Insert one lead. Caller is responsible for validation/limits (the route);
// this function only persists. Throws on DB failure — the route translates
// that to a clean 500 (no silent drops).
export async function insertOptinLead({
  id,
  funnel_id,
  page_id,
  email,
  name,
  ip,
  user_agent,
}) {
  await pgQuery(
    `INSERT INTO optin_leads (id, funnel_id, page_id, email, name, ip, user_agent)
     VALUES ($1, $2, $3, $4, $5, $6, $7)`,
    [id, funnel_id ?? null, page_id ?? null, email, name ?? null, ip ?? null, user_agent ?? null]
  );
}

export default { ensureOptinTables, insertOptinLead };
