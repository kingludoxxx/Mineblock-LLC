// Analytics DB handle — ISOLATED FROM THE MONEY PATH (SELF-CONTAINED, NEW FILE).
//
// WHY THIS EXISTS. Reporting must never be able to take down settlement, and
// with the shared pgQuery it demonstrably could:
//
//   1. pgQuery's timeout is a `Promise.race`, NOT a server-side cancel. The
//      losing query keeps running inside Postgres and KEEPS ITS CONNECTION
//      until the pool's statement_timeout (15s) fires. The shared pool is
//      max: 10. Seven concurrent Analytics loads on a cold cache can therefore
//      hold most of the money path's connections for 15 seconds.
//
//   2. Every lost race calls recordFailure() on a PROCESS-WIDE circuit
//      breaker. Five of them in a row set circuitOpen = true, and for the next
//      30 seconds pgQuery REJECTS EVERY CALLER — including the Stripe/Whop
//      settlement webhooks. An operator opening a wide date range could stop
//      money from settling. That is an unacceptable coupling for a read-only
//      reporting page.
//
// THE FIX, three parts:
//   • Its own small pool (max 2). Analytics can exhaust its own budget and the
//     money path never notices — the shared pool's 10 connections are untouched.
//   • A SERVER-SIDE statement_timeout, so a slow query is genuinely CANCELLED
//     and its connection returned, rather than abandoned while still running.
//   • No breaker participation at all. A slow report degrades this subsystem
//     (safeRead turns it into a named warning and a null) and nothing else.
//
// The cost is 2 extra Postgres connections. That is the correct trade against
// "a report can reject a settlement".
import postgres from 'postgres';
import env from '../config/env.js';

// Below the shared pool's 15s statement_timeout on purpose: analytics should
// give up first, and give up cleanly.
const ANALYTICS_STATEMENT_TIMEOUT_MS = 8_000;
const ANALYTICS_POOL_MAX = 2;

let pool = null;

function getPool() {
  if (!pool) {
    pool = postgres(env.DATABASE_URL, {
      max: ANALYTICS_POOL_MAX,
      idle_timeout: 10,
      connect_timeout: 10,
      ssl:
        env.DATABASE_URL?.includes('render.com') || env.NODE_ENV === 'production'
          ? 'require'
          : false,
      connection: {
        // SERVER-SIDE. Postgres cancels the query and frees the connection —
        // the whole point of not reusing the shared handle.
        statement_timeout: ANALYTICS_STATEMENT_TIMEOUT_MS,
      },
      onnotice: () => {},
    });
  }
  return pool;
}

/**
 * Parameterised read on the analytics pool. Same signature as pgQuery so the
 * services are agnostic about which handle they were given, and the harness can
 * still inject its own.
 *
 * Deliberately does NOT touch the shared circuit breaker in db/pg.js — neither
 * reading it nor recording failures into it.
 */
export async function analyticsQuery(text, params = []) {
  return getPool().unsafe(text, params);
}

/** Release the pool (tests / graceful shutdown). */
export async function closeAnalyticsPool() {
  if (pool) {
    const p = pool;
    pool = null;
    await p.end({ timeout: 5 });
  }
}

export const ANALYTICS_DB_LIMITS = Object.freeze({
  poolMax: ANALYTICS_POOL_MAX,
  statementTimeoutMs: ANALYTICS_STATEMENT_TIMEOUT_MS,
  sharedBreaker: false,
});
