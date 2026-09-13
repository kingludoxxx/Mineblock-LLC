import postgres from 'postgres';
import env from '../config/env.js';
import { dbSslEnabled } from '../config/dbSsl.js';
import logger from '../utils/logger.js';

// --- Circuit breaker state ---
let circuitOpen = false;
let circuitOpenedAt = 0;
const CIRCUIT_RESET_MS = 30_000; // try again after 30s
let consecutiveFailures = 0;
const FAILURE_THRESHOLD = 5;

/**
 * postgres.js client — NOT the same as node-postgres (pg).
 * This is the primary query interface for the SaaS platform.
 */
/**
 * How many connections the postgres.js pool may hold (PG_POOL_MAX, default 20, clamped 5..40).
 *
 * It was a fixed 10. Measured 2026-09-13 in real Chrome on a live store: the Statics Generation page fires 12 API
 * requests at the same instant, every one of them through THIS pool. Requests returning 0 KB took 2.5-5 s (queueing,
 * not working), and the two at the back - a 0.15 ms query among them - passed pgQuery's 8 s limit and answered 500.
 * The app's OTHER pool (config/db.js) already allows 20; this one now matches it. Bounded both ways so a typo cannot
 * starve the page (below 5) or exhaust the database's connection limit (above 40).
 */
export function poolMax(raw = process.env.PG_POOL_MAX) {
  const n = Number.parseInt(String(raw ?? '').trim(), 10);
  if (!Number.isFinite(n)) return 20;
  return Math.min(40, Math.max(5, n));
}

const pgDb = postgres(env.DATABASE_URL, {
  max: poolMax(),
  idle_timeout: 20,
  connect_timeout: 10,
  ssl: dbSslEnabled() ? 'require' : false,
  connection: {
    statement_timeout: 15_000, // 15 seconds
  },
  onnotice: () => {},       // suppress NOTICE messages
});

/**
 * Expose the raw client for callers that need tagged-template queries directly.
 * Usage:  import { client } from '../db/pg.js';
 *         const rows = await client`SELECT * FROM users WHERE id = ${id}`;
 */
const client = pgDb;

/**
 * Check whether the circuit breaker is currently open.
 * If enough time has passed, allow a probe request through (half-open).
 */
export function isDbCircuitOpen() {
  if (!circuitOpen) return false;
  if (Date.now() - circuitOpenedAt >= CIRCUIT_RESET_MS) {
    // half-open: allow the next request to try
    return false;
  }
  return true;
}

function recordSuccess() {
  if (circuitOpen) {
    logger.info('DB circuit breaker closed — connection recovered');
  }
  consecutiveFailures = 0;
  circuitOpen = false;
}

function recordFailure(err) {
  consecutiveFailures++;
  if (consecutiveFailures >= FAILURE_THRESHOLD && !circuitOpen) {
    circuitOpen = true;
    circuitOpenedAt = Date.now();
    logger.error(`DB circuit breaker OPEN after ${consecutiveFailures} failures: ${err.message}`);
  }
}

/**
 * Execute a parameterised SQL query with a timeout race.
 *
 * @param {string} text  — SQL string with $1, $2 … placeholders
 * @param {any[]}  params — parameter values
 * @param {object} [opts]
 * @param {number} [opts.timeout=8000] — per-query timeout in ms
 * @returns {Promise<any[]>} rows
 */
export async function pgQuery(text, params = [], { timeout = 8_000 } = {}) {
  if (isDbCircuitOpen()) {
    throw new Error('Database circuit breaker is open — request rejected');
  }

  const queryPromise = pgDb.unsafe(text, params);

  const timeoutPromise = new Promise((_, reject) => {
    const timer = setTimeout(() => {
      reject(new Error(`pgQuery timed out after ${timeout}ms`));
    }, timeout);
    // Allow Node to exit even if this timer is pending
    if (timer.unref) timer.unref();
  });

  try {
    const rows = await Promise.race([queryPromise, timeoutPromise]);
    recordSuccess();
    return rows;
  } catch (err) {
    recordFailure(err);
    throw err;
  }
}

export { pgDb, client };
export default pgDb;
