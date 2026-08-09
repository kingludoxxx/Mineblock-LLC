// Domain Hub — schema. Mirrors funnel-os's lb_domains model (DATA-MODEL.md):
// serving is PER-HOST — a published page still 404s until the host has a
// connected lb_domains row. This module owns exactly two tables plus the
// WHOIS-contact store; nothing here touches the funnels/funnel_pages DDL.
//
// Same serialized-DDL pattern as funnels.js ensureTables(): Postgres throws
// on concurrent CREATE TABLE IF NOT EXISTS (pg_type unique violation), so a
// single in-flight promise serializes setup and resets on failure.
import { pgQuery } from '../../db/pg.js';

let tablesReadyPromise = null;

export function ensureDomainTables() {
  if (!tablesReadyPromise) {
    tablesReadyPromise = createTables().catch((err) => {
      tablesReadyPromise = null;
      throw err;
    });
  }
  return tablesReadyPromise;
}

async function createTables() {
  // lb_domains — one row per HOST attached to a funnel.
  // status: pending_dns → verifying → connected | error
  //   pending_dns : attached; DNS not yet pointing at us
  //   verifying   : DNS points at us; Render registration/TLS in flight
  //   connected   : registered on the Render service — host serves the funnel
  //   error       : bounded retries exhausted / hard failure (error_detail set)
  await pgQuery(`
    CREATE TABLE IF NOT EXISTS lb_domains (
      id TEXT PRIMARY KEY,
      domain TEXT NOT NULL,
      funnel_id TEXT NOT NULL,
      status TEXT NOT NULL DEFAULT 'pending_dns',
      verification_method TEXT NOT NULL DEFAULT 'dns_pointing',
      verification_token TEXT NOT NULL,
      dns_provider TEXT,
      registrar TEXT NOT NULL DEFAULT 'manual',
      render_domain_id TEXT,
      error_detail TEXT,
      verify_attempts INTEGER NOT NULL DEFAULT 0,
      last_check TIMESTAMPTZ,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )
  `);
  // A host serves exactly one funnel — domain is globally unique. (funnel-os
  // allows multi-funnel hosts routed by page handle; we deliberately keep the
  // simpler 1:1 model — re-attach resumes, never duplicates.)
  await pgQuery(
    `CREATE UNIQUE INDEX IF NOT EXISTS uq_lb_domains_domain ON lb_domains (domain)`
  );
  await pgQuery(
    `CREATE INDEX IF NOT EXISTS idx_lb_domains_funnel ON lb_domains (funnel_id)`
  );
  // The sweep scans by status; keep that path indexed.
  await pgQuery(
    `CREATE INDEX IF NOT EXISTS idx_lb_domains_status ON lb_domains (status)`
  );

  // domain_events — append-only audit trail (attach, dns checks, Render calls,
  // purchases, detaches). detail is jsonb; postgres.js auto-serializes.
  await pgQuery(`
    CREATE TABLE IF NOT EXISTS domain_events (
      id BIGSERIAL PRIMARY KEY,
      domain TEXT NOT NULL,
      event TEXT NOT NULL,
      detail JSONB DEFAULT '{}',
      actor TEXT,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )
  `);
  await pgQuery(
    `CREATE INDEX IF NOT EXISTS idx_domain_events_domain ON domain_events (domain, created_at DESC)`
  );

  // WHOIS registrant contact — stored once, reused for every purchase.
  // Single-row table (id fixed to 'default').
  await pgQuery(`
    CREATE TABLE IF NOT EXISTS domain_whois_contact (
      id TEXT PRIMARY KEY DEFAULT 'default',
      contact JSONB NOT NULL DEFAULT '{}',
      updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )
  `);
}

/** Append an audit event. Never throws — an audit failure must not take the
 *  mutation down; it logs and continues (serving/config is fail-open here,
 *  money is not involved). */
export async function logDomainEvent(domain, event, detail = {}, actor = null) {
  try {
    await pgQuery(
      `INSERT INTO domain_events (domain, event, detail, actor) VALUES ($1, $2, $3, $4)`,
      [domain, event, JSON.stringify(detail), actor]
    );
  } catch (err) {
    console.error('[domainHub] event log failed (non-fatal):', err.message);
  }
}
