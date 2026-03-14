import postgres from 'postgres';
import env from '../config/env.js';
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
const pgDb = postgres(env.DATABASE_URL, {
  max: 10,
  idle_timeout: 20,
  connect_timeout: 10,
  ssl: env.NODE_ENV === 'production' ? 'require' : false,
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
