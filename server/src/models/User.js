import pool from '../config/db.js';

const User = {
  async findByEmail(email) {
    const result = await pool.query(
      `SELECT u.*, json_agg(json_build_object('id', r.id, 'name', r.name, 'permissions', r.permissions))
         FILTER (WHERE r.id IS NOT NULL) AS roles
       FROM users u
       LEFT JOIN user_roles ur ON u.id = ur.user_id
       LEFT JOIN roles r ON ur.role_id = r.id
       WHERE u.email = $1
       GROUP BY u.id`,
      [email]
    );
    return result.rows[0] || null;
  },

  async findById(id) {
    const result = await pool.query(
      `SELECT u.*, json_agg(json_build_object('id', r.id, 'name', r.name, 'permissions', r.permissions))
         FILTER (WHERE r.id IS NOT NULL) AS roles
       FROM users u
       LEFT JOIN user_roles ur ON u.id = ur.user_id
       LEFT JOIN roles r ON ur.role_id = r.id
       WHERE u.id = $1
       GROUP BY u.id`,
      [id]
    );
    return result.rows[0] || null;
  },

  async findAll(filters = {}, pagination = {}) {
    const { is_active, search } = filters;
    const { page = 1, limit = 20 } = pagination;
    const offset = (page - 1) * limit;

    const conditions = [];
    const params = [];
    let paramIndex = 1;

    if (typeof is_active === 'boolean') {
      conditions.push(`u.is_active = $${paramIndex++}`);
      params.push(is_active);
    }

    if (search) {
      conditions.push(
        `(u.email ILIKE $${paramIndex} OR u.first_name ILIKE $${paramIndex} OR u.last_name ILIKE $${paramIndex})`
      );
      params.push(`%${search}%`);
      paramIndex++;
    }

    const whereClause = conditions.length > 0 ? `WHERE ${conditions.join(' AND ')}` : '';

    const countResult = await pool.query(
      `SELECT COUNT(*) FROM users u ${whereClause}`,
      params
    );
    const total = parseInt(countResult.rows[0].count, 10);

    const result = await pool.query(
      `SELECT u.id, u.email, u.first_name, u.last_name, u.is_active,
              u.must_change_password, u.last_login, u.created_at, u.updated_at,
              json_agg(json_build_object('id', r.id, 'name', r.name))
                FILTER (WHERE r.id IS NOT NULL) AS roles
       FROM users u
       LEFT JOIN user_roles ur ON u.id = ur.user_id
       LEFT JOIN roles r ON ur.role_id = r.id
       ${whereClause}
       GROUP BY u.id
       ORDER BY u.created_at DESC
       LIMIT $${paramIndex++} OFFSET $${paramIndex}`,
      [...params, limit, offset]
    );

    return {
      users: result.rows,
      total,
      page,
      limit,
      totalPages: Math.ceil(total / limit),
    };
  },

  async create(data) {
    const { email, password_hash, first_name, last_name, must_change_password = false } = data;
    const result = await pool.query(
      `INSERT INTO users (email, password_hash, first_name, last_name, must_change_password)
       VALUES ($1, $2, $3, $4, $5)
       RETURNING id, email, first_name, last_name, is_active, must_change_password, created_at`,
      [email, password_hash, first_name, last_name, must_change_password]
    );
    return result.rows[0];
  },

  async update(id, data) {
    const fields = [];
    const params = [];
    let paramIndex = 1;

    const allowedFields = ['email', 'password_hash', 'first_name', 'last_name', 'is_active', 'must_change_password'];

    for (const field of allowedFields) {
      if (data[field] !== undefined) {
        fields.push(`${field} = $${paramIndex++}`);
        params.push(data[field]);
      }
    }

    if (fields.length === 0) return null;

    fields.push(`updated_at = NOW()`);
    params.push(id);

    const result = await pool.query(
      `UPDATE users SET ${fields.join(', ')} WHERE id = $${paramIndex}
       RETURNING id, email, first_name, last_name, is_active, must_change_password, updated_at`,
      params
    );
    return result.rows[0] || null;
  },

  async deactivate(id) {
    const result = await pool.query(
      `UPDATE users SET is_active = false, updated_at = NOW() WHERE id = $1
       RETURNING id, email, is_active`,
      [id]
    );
    return result.rows[0] || null;
  },

  async updateLoginAttempts(id, attempts) {
    await pool.query(
      `UPDATE users SET failed_login_attempts = $2, updated_at = NOW() WHERE id = $1`,
      [id, attempts]
    );
  },

  async resetLoginAttempts(id) {
    await pool.query(
      `UPDATE users SET failed_login_attempts = 0, locked_until = NULL, updated_at = NOW() WHERE id = $1`,
      [id]
    );
  },

  async updateLastLogin(id) {
    await pool.query(
      `UPDATE users SET last_login = NOW(), updated_at = NOW() WHERE id = $1`,
      [id]
    );
  },
};

export default User;
