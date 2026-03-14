import pg from 'pg';
import bcrypt from 'bcrypt';

const { Pool } = pg;

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: process.env.NODE_ENV === 'production' ? { rejectUnauthorized: false } : false,
});

const SUPERADMIN_EMAIL = 'admin@try-mineblock.com';
const SUPERADMIN_PASSWORD = 'MineblockAdmin2026!';
const SALT_ROUNDS = 12;

export async function seedSuperAdmin() {
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
