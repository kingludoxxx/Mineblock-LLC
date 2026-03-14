import pool from '../config/db.js';

const AuditLog = {
  async create(data) {
    const { user_id, action, resource_type, resource_id, old_values, new_values, ip_address, user_agent } = data;
    const result = await pool.query(
      `INSERT INTO audit_logs (user_id, action, resource_type, resource_id, old_values, new_values, ip_address, user_agent)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
       RETURNING *`,
      [
        user_id || null,
        action,
        resource_type,
        resource_id || null,
        old_values ? JSON.stringify(old_values) : null,
        new_values ? JSON.stringify(new_values) : null,
        ip_address || null,
        user_agent || null,
      ]
    );
    return result.rows[0];
  },

  async findAll(filters = {}, pagination = {}) {
    const { user_id, action, resource_type, resource_id, start_date, end_date } = filters;
    const { page = 1, limit = 50 } = pagination;
    const offset = (page - 1) * limit;

    const conditions = [];
    const params = [];
    let paramIndex = 1;

    if (user_id) {
      conditions.push(`a.user_id = $${paramIndex++}`);
      params.push(user_id);
    }
    if (action) {
      conditions.push(`a.action = $${paramIndex++}`);
      params.push(action);
    }
    if (resource_type) {
      conditions.push(`a.resource_type = $${paramIndex++}`);
      params.push(resource_type);
    }
    if (resource_id) {
      conditions.push(`a.resource_id = $${paramIndex++}`);
      params.push(resource_id);
    }
    if (start_date) {
      conditions.push(`a.created_at >= $${paramIndex++}`);
      params.push(start_date);
    }
    if (end_date) {
      conditions.push(`a.created_at <= $${paramIndex++}`);
      params.push(end_date);
    }

    const whereClause = conditions.length > 0 ? `WHERE ${conditions.join(' AND ')}` : '';

    const result = await pool.query(
      `SELECT a.*, u.email AS user_email, u.first_name AS user_first_name, u.last_name AS user_last_name
       FROM audit_logs a
       LEFT JOIN users u ON a.user_id = u.id
       ${whereClause}
       ORDER BY a.created_at DESC
       LIMIT $${paramIndex++} OFFSET $${paramIndex}`,
      [...params, limit, offset]
    );

    return result.rows;
  },

  async findById(id) {
    const result = await pool.query(
      `SELECT a.*, u.email AS user_email, u.first_name AS user_first_name, u.last_name AS user_last_name
       FROM audit_logs a
       LEFT JOIN users u ON a.user_id = u.id
       WHERE a.id = $1`,
      [id]
    );
    return result.rows[0] || null;
  },

  async count(filters = {}) {
    const { user_id, action, resource_type, resource_id, start_date, end_date } = filters;

    const conditions = [];
    const params = [];
    let paramIndex = 1;

    if (user_id) {
      conditions.push(`user_id = $${paramIndex++}`);
      params.push(user_id);
    }
    if (action) {
      conditions.push(`action = $${paramIndex++}`);
      params.push(action);
    }
    if (resource_type) {
      conditions.push(`resource_type = $${paramIndex++}`);
      params.push(resource_type);
    }
    if (resource_id) {
      conditions.push(`resource_id = $${paramIndex++}`);
      params.push(resource_id);
    }
    if (start_date) {
      conditions.push(`created_at >= $${paramIndex++}`);
      params.push(start_date);
    }
    if (end_date) {
      conditions.push(`created_at <= $${paramIndex++}`);
      params.push(end_date);
    }

    const whereClause = conditions.length > 0 ? `WHERE ${conditions.join(' AND ')}` : '';

    const result = await pool.query(
      `SELECT COUNT(*) FROM audit_logs ${whereClause}`,
      params
    );
    return parseInt(result.rows[0].count, 10);
  },
};

export default AuditLog;
