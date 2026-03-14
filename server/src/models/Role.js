import pool from '../config/db.js';

const Role = {
  async findAll() {
    const result = await pool.query(
      'SELECT * FROM roles ORDER BY name'
    );
    return result.rows;
  },

  async findById(id) {
    const result = await pool.query(
      'SELECT * FROM roles WHERE id = $1',
      [id]
    );
    return result.rows[0] || null;
  },

  async findByName(name) {
    const result = await pool.query(
      'SELECT * FROM roles WHERE name = $1',
      [name]
    );
    return result.rows[0] || null;
  },

  async create(data) {
    const { name, description, permissions, is_system = false } = data;
    const result = await pool.query(
      `INSERT INTO roles (name, description, permissions, is_system)
       VALUES ($1, $2, $3, $4)
       RETURNING *`,
      [name, description, JSON.stringify(permissions), is_system]
    );
    return result.rows[0];
  },

  async update(id, data) {
    const fields = [];
    const params = [];
    let paramIndex = 1;

    if (data.name !== undefined) {
      fields.push(`name = $${paramIndex++}`);
      params.push(data.name);
    }
    if (data.description !== undefined) {
      fields.push(`description = $${paramIndex++}`);
      params.push(data.description);
    }
    if (data.permissions !== undefined) {
      fields.push(`permissions = $${paramIndex++}`);
      params.push(JSON.stringify(data.permissions));
    }

    if (fields.length === 0) return null;

    fields.push(`updated_at = NOW()`);
    params.push(id);

    const result = await pool.query(
      `UPDATE roles SET ${fields.join(', ')} WHERE id = $${paramIndex}
       RETURNING *`,
      params
    );
    return result.rows[0] || null;
  },

  async delete(id) {
    const result = await pool.query(
      'DELETE FROM roles WHERE id = $1 AND is_system = false RETURNING *',
      [id]
    );
    return result.rows[0] || null;
  },
};

export default Role;
