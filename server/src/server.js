import app from './app.js';
import env from './config/env.js';
import pool, { testConnection } from './config/db.js';
import { pgQuery } from './db/pg.js';
import redis from './db/redis.js';
import logger from './utils/logger.js';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { hashPassword } from './utils/hash.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

// ---------------------------------------------------------------------------
// Auto-migration (reads .sql files from server/migrations/)
// Uses the legacy pg Pool for migrations since it supports transactional DDL
// with explicit BEGIN/COMMIT via client.query.
// ---------------------------------------------------------------------------
async function runMigrations() {
  const client = await pool.connect();
  try {
    await client.query(`
      CREATE TABLE IF NOT EXISTS _migrations (
        id SERIAL PRIMARY KEY,
        filename VARCHAR(255) UNIQUE NOT NULL,
        executed_at TIMESTAMPTZ DEFAULT NOW()
      )
    `);
    const { rows } = await client.query('SELECT filename FROM _migrations');
    const executed = new Set(rows.map(r => r.filename));

    const migrationsDir = path.resolve(__dirname, '../migrations');
    const files = fs.readdirSync(migrationsDir).filter(f => f.endsWith('.sql')).sort();

    for (const file of files) {
      if (executed.has(file)) continue;
      const sql = fs.readFileSync(path.join(migrationsDir, file), 'utf-8');
      logger.info(`Running migration: ${file}`);
      await client.query('BEGIN');
      try {
        await client.query(sql);
        await client.query('INSERT INTO _migrations (filename) VALUES ($1)', [file]);
        await client.query('COMMIT');
        logger.info(`Migration complete: ${file}`);
      } catch (err) {
        await client.query('ROLLBACK');
        throw err;
      }
    }
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

  const email = process.env.SUPERADMIN_EMAIL || 'admin@try-mineblock.com';
  const { rows: existing } = await pool.query('SELECT id FROM users WHERE email = $1', [email]);
  if (existing.length === 0) {
    const password = process.env.SUPERADMIN_PASSWORD || 'MineblockAdmin2026!';
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

  // 4. Run migrations & seeds
  try {
    await runMigrations();
    logger.info('Migrations complete');
    await runSeeds();
    logger.info('Seeds complete');
  } catch (err) {
    logger.warn(`Database setup issue: ${err.message}. Starting server anyway.`);
  }

  // 5. Start HTTP server
  const server = app.listen(env.PORT, () => {
    logger.info(`Server running on port ${env.PORT} in ${env.NODE_ENV} mode`);
  });

  // Graceful shutdown
  const shutdown = async (signal) => {
    logger.info(`${signal} received — shutting down gracefully`);
    server.close(async () => {
      logger.info('HTTP server closed');
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
