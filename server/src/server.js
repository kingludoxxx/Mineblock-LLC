import app from './app.js';
import env from './config/env.js';
import pool, { testConnection } from './config/db.js';
import logger from './utils/logger.js';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { hashPassword } from './utils/hash.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

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

async function runSeeds() {
  // Seed roles
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

  // Seed SuperAdmin user
  const email = env.SUPERADMIN_EMAIL || 'admin@try-mineblock.com';
  const { rows: existing } = await pool.query('SELECT id FROM users WHERE email = $1', [email]);
  if (existing.length === 0) {
    const password = env.SUPERADMIN_PASSWORD || 'MineblockAdmin2026!';
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

const start = async () => {
  try {
    await testConnection();
    logger.info('Database connection established');

    // Auto-run migrations and seeds
    await runMigrations();
    logger.info('Migrations complete');
    await runSeeds();
    logger.info('Seeds complete');
  } catch (err) {
    logger.warn(`Database setup issue: ${err.message}. Starting server anyway.`);
  }

  app.listen(env.PORT, () => {
    logger.info(`Server running on port ${env.PORT} in ${env.NODE_ENV} mode`);
  });
};

start();
