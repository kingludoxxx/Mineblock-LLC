import pg from 'pg';
import bcrypt from 'bcrypt';

const { Pool } = pg;

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: process.env.NODE_ENV === 'production' ? { rejectUnauthorized: false } : false,
});

const SALT_ROUNDS = 12;

// The first administrator of a store is STORE IDENTITY, so it is data (R5) and
// never a literal in shared code (R15). Both variables are REQUIRED and there is
// no fallback: a default would seed one store's admin — with a password that is
// in the repository — into every store born after it. Unset = refuse, seed
// nothing, exit non-zero, so the operator sets them and re-runs.
function requiredCredential(key) {
  const v = process.env[key];
  if (v === undefined || v === null || String(v).trim() === '') {
    throw new Error(
      `${key} is not set — refusing to seed a super-admin. Set SUPERADMIN_EMAIL and `
      + 'SUPERADMIN_PASSWORD for THIS store (they are per-store credentials, R4) and re-run.'
    );
  }
  return String(v);
}

/** Preflight: both credentials present BEFORE any seed writes a row. */
export function assertSuperAdminEnv() {
  requiredCredential('SUPERADMIN_EMAIL');
  requiredCredential('SUPERADMIN_PASSWORD');
}

export async function seedSuperAdmin() {
  const SUPERADMIN_EMAIL = requiredCredential('SUPERADMIN_EMAIL');
  const SUPERADMIN_PASSWORD = requiredCredential('SUPERADMIN_PASSWORD');
  const client = await pool.connect();
  try {
    // Check if user already exists
    const existing = await client.query(
      'SELECT id FROM users WHERE email = $1',
      [SUPERADMIN_EMAIL]
    );

    if (existing.rows.length > 0) {
      console.log(`SuperAdmin user already exists: ${SUPERADMIN_EMAIL}`);
      return;
    }

    const passwordHash = await bcrypt.hash(SUPERADMIN_PASSWORD, SALT_ROUNDS);

    await client.query('BEGIN');
    try {
      // Create the superadmin user
      const userResult = await client.query(
        `INSERT INTO users (email, password_hash, first_name, last_name, is_active, must_change_password)
         VALUES ($1, $2, $3, $4, true, true)
         RETURNING id`,
        [SUPERADMIN_EMAIL, passwordHash, 'Super', 'Admin']
      );
      const userId = userResult.rows[0].id;

      // Get SuperAdmin role
      const roleResult = await client.query(
        "SELECT id FROM roles WHERE name = 'SuperAdmin'"
      );

      if (roleResult.rows.length === 0) {
        throw new Error('SuperAdmin role not found. Run seed_roles first.');
      }

      const roleId = roleResult.rows[0].id;

      // Assign SuperAdmin role
      await client.query(
        `INSERT INTO user_roles (user_id, role_id)
         VALUES ($1, $2)
         ON CONFLICT (user_id, role_id) DO NOTHING`,
        [userId, roleId]
      );

      await client.query('COMMIT');
      console.log(`SuperAdmin user created: ${SUPERADMIN_EMAIL}`);
    } catch (err) {
      await client.query('ROLLBACK');
      throw err;
    }
  } finally {
    client.release();
  }
}

export { pool };
