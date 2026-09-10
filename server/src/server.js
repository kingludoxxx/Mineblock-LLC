import app from './app.js';
import env from './config/env.js';
import pool, { testConnection } from './config/db.js';
import { pgQuery } from './db/pg.js';
import redis from './db/redis.js';
import logger from './utils/logger.js';
import path from 'path';
import { fileURLToPath } from 'url';
import { hashPassword } from './utils/hash.js';
import { requestShutdown } from './workers/brandSpyWorker.js';
import {
  startStaticsQueueWorker,
  requestShutdown as requestStaticsQueueShutdown,
} from './workers/staticsQueueWorker.js';
import { closeBrowser as closeThumbBrowser } from './routes/pageThumbnails.js';
import { checkPending } from '../migrations/run.js';
import storeConfig from './config/storeConfig.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

// ── Playwright browser path — must point inside project dir so Render deploys it ──
// Default (/opt/render/.cache/…) is build-time only and NOT available at runtime.
// process.cwd() = project root in both build and runtime on Render.
if (!process.env.PLAYWRIGHT_BROWSERS_PATH) {
  process.env.PLAYWRIGHT_BROWSERS_PATH = path.join(process.cwd(), 'playwright-browsers');
  console.log(`[server] PLAYWRIGHT_BROWSERS_PATH auto-set to: ${process.env.PLAYWRIGHT_BROWSERS_PATH}`);
}

// ---------------------------------------------------------------------------
// Migration ledger check — READ-ONLY (S0b-3).
// server/migrations/run.js is the ONLY writer of `_migrations`. The server no
// longer applies migrations at boot: it compares the ledger with
// server/migrations/order.json and reports. With STRICT_MIGRATIONS=1 a pending
// or checksum-mismatched migration refuses boot; otherwise it is logged so a
// developer can still work against a partial database.
//   Apply:   npm run migrate          Preview:  npm run migrate:dry-run
// ---------------------------------------------------------------------------
async function checkMigrations() {
  const client = await pool.connect();
  try {
    return await checkPending(client, { dir: path.resolve(__dirname, '../migrations') });
  } finally {
    client.release();
  }
}

// ---------------------------------------------------------------------------
// Seed default roles & super-admin user
// ---------------------------------------------------------------------------
async function runSeeds() {
  const roles = [
    { name: 'SuperAdmin', description: 'Full system access', permissions: { '*': ['*'] } },
    { name: 'Admin', description: 'Administrative access', permissions: { users: ['read','create','update'], departments: ['*'], audit: ['read'], settings: ['read'] } },
    { name: 'Manager', description: 'Department management', permissions: { departments: ['read','update'], audit: ['read'] } },
    { name: 'Viewer', description: 'Read-only access', permissions: { departments: ['read'], audit: ['read'] } },
  ];
  for (const role of roles) {
    await pool.query(
      `INSERT INTO roles (name, description, permissions, is_system) VALUES ($1, $2, $3, true) ON CONFLICT (name) DO NOTHING`,
      [role.name, role.description, JSON.stringify(role.permissions)]
    );
  }
  logger.info('Roles seeded');

  // SUPERADMIN_EMAIL + SUPERADMIN_PASSWORD are REQUIRED env vars per instance.
  // Dev defaults kept so local `npm run dev` still bootstraps; production
  // startup below warns when env vars are missing.
  const email = process.env.SUPERADMIN_EMAIL || 'admin@example.com';
  const password = process.env.SUPERADMIN_PASSWORD || 'ChangeMeInProduction!';
  if (env.NODE_ENV === 'production' && (!process.env.SUPERADMIN_EMAIL || !process.env.SUPERADMIN_PASSWORD)) {
    logger.warn('SUPERADMIN_EMAIL and/or SUPERADMIN_PASSWORD not set — using hard-coded defaults in production is a security risk');
  }
  const { rows: existing } = await pool.query('SELECT id FROM users WHERE email = $1', [email]);
  if (existing.length === 0) {
    const hash = await hashPassword(password);
    const { rows: [user] } = await pool.query(
      `INSERT INTO users (email, password_hash, first_name, last_name, must_change_password) VALUES ($1, $2, $3, $4, true) RETURNING id`,
      [email, hash, 'Super', 'Admin']
    );
    const { rows: [superRole] } = await pool.query(`SELECT id FROM roles WHERE name = 'SuperAdmin'`);
    if (superRole) {
      await pool.query(`INSERT INTO user_roles (user_id, role_id) VALUES ($1, $2) ON CONFLICT DO NOTHING`, [user.id, superRole.id]);
    }
    logger.info(`SuperAdmin created: ${email}`);
  } else {
    logger.info('SuperAdmin already exists, skipping seed');
  }
}

// ---------------------------------------------------------------------------
// Startup
// ---------------------------------------------------------------------------
const start = async () => {
  // 0. Store-config gate — FAIL CLOSED (R5/R15, REVIEW-LANE-F.md P1-1).
  // A required store key that is missing or malformed is a routing hazard, not
  // a dormant feature: with no PRODUCT_CODES_JSON the ClickUp/Frame.io paths
  // used to fall through to another product's project and rename live cards.
  // The process refuses to start instead. Rollback stays "set the variable".
  try {
    const gate = storeConfig.assertBootConfig();
    logger.info(`Store config OK (${gate.checked.join(', ')})`);
  } catch (err) {
    logger.error(`STORE CONFIG INVALID — refusing to start: ${err.message}`);
    process.exit(1);
  }

  // 1. Connect legacy pg pool (used by migrations, seeds, existing code)
  try {
    await testConnection();
    logger.info('PostgreSQL (pg pool) connection established');
  } catch (err) {
    logger.warn(`PostgreSQL (pg pool) connection failed: ${err.message}`);
  }

  // 2. Verify postgres.js driver
  try {
    await pgQuery('SELECT 1');
    logger.info('PostgreSQL (postgres.js) connection established');
  } catch (err) {
    logger.warn(`PostgreSQL (postgres.js) connection failed: ${err.message}`);
  }

  // 3. Connect Redis
  try {
    await redis.connect();
    logger.info('Redis connection established');
  } catch (err) {
    logger.warn(`Redis connection failed: ${err.message}. Continuing without Redis.`);
  }

  // 4. Check migrations (read-only) & run seeds.
  // Seeds are deliberately OUTSIDE the migration try: they were previously in
  // the same block, so one failing migration also skipped role/superadmin
  // seeding and produced a running server with no way to log in.
  let migrationsOk = true;
  try {
    const report = await checkMigrations();
    if (report.clean) {
      logger.info(`Migrations: ledger matches order.json (${report.applied.length} applied, 0 pending, 0 mismatches`
        + (report.legacy.length ? `, ${report.legacy.length} legacy row(s) awaiting checksum backfill by npm run migrate)` : ')'));
    } else {
      migrationsOk = false;
      // A half-migrated schema is a silent data-integrity hazard: the app boots,
      // the health check goes green, and features whose tables/permissions live
      // in the pending migrations fail at runtime with confusing errors.
      logger.error(`MIGRATIONS NOT APPLIED: ${report.pending.length} pending [${report.pending.join(', ')}], `
        + `${report.mismatches.length} checksum mismatch(es) [${report.mismatches.map((m) => m.filename).join(', ')}]. `
        + 'This server does not apply migrations at boot — run `npm run migrate` against this database.');
      if (process.env.STRICT_MIGRATIONS === '1') {
        logger.error('STRICT_MIGRATIONS=1 — refusing to start with pending or mismatched migrations.');
        process.exit(1);
      }
    }
  } catch (err) {
    migrationsOk = false;
    // Also reached on a broken/missing order.json or a DB blip at check time.
    logger.error(`MIGRATION CHECK FAILED: ${err.message}`);
    if (process.env.STRICT_MIGRATIONS === '1') {
      logger.error('STRICT_MIGRATIONS=1 — refusing to start.');
      process.exit(1);
    }
  }
  try {
    await runSeeds();
    logger.info('Seeds complete');
  } catch (err) {
    logger.warn(`Seed issue: ${err.message}${migrationsOk ? '' : ' (expected — migrations failed)'}`);
  }

  // 5. Start HTTP server
  const server = app.listen(env.PORT, () => {
    logger.info(`Server running on port ${env.PORT} in ${env.NODE_ENV} mode`);
  });

  // 6. Start statics queue worker (server-owned pipeline for /generate-batch).
  try {
    await startStaticsQueueWorker();
  } catch (err) {
    logger.warn(`Statics queue worker failed to start: ${err.message}`);
  }

  // 7. Autopilot Mode — checks every minute, fires at the configured Madrid
  // hour only when enabled in settings. Inert until the operator turns it on.
  try {
    const { startAutopilotScheduler } = await import('./services/autopilot.js');
    startAutopilotScheduler();
  } catch (err) {
    logger.warn(`Autopilot scheduler failed to start: ${err.message}`);
  }

  // Graceful shutdown
  const shutdown = async (signal) => {
    logger.info(`${signal} received — shutting down gracefully`);
    requestShutdown(); // signal in-flight brand scrapes to stop after current API call
    try { requestStaticsQueueShutdown(); } catch (e) { logger.error('statics queue shutdown error:', e.message); }
    server.close(async () => {
      logger.info('HTTP server closed');
      try { await closeThumbBrowser(); logger.info('thumbnail chromium closed'); } catch (e) { logger.error('thumb browser close error:', e.message); }
      try { await pool.end(); logger.info('pg Pool drained'); } catch (e) { logger.error('pg Pool drain error:', e.message); }
      try { if (redis && typeof redis.quit === 'function') { await redis.quit(); logger.info('Redis disconnected'); } } catch (e) { logger.error('Redis disconnect error:', e.message); }
      process.exit(0);
    });
    // Force exit after 10s if graceful shutdown hangs
    setTimeout(() => { logger.warn('Forced shutdown after timeout'); process.exit(1); }, 10000).unref();
  };
  process.on('SIGTERM', () => shutdown('SIGTERM'));
  process.on('SIGINT', () => shutdown('SIGINT'));
};

// Global error handlers — prevent silent crashes
process.on('unhandledRejection', (reason) => {
  logger.error('Unhandled promise rejection:', reason);
});
process.on('uncaughtException', (err) => {
  logger.error('Uncaught exception:', err);
  process.exit(1);
});

start();
