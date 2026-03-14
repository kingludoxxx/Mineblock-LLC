import pool from '../config/db.js';

const Department = {
  async findAll(includeInactive = false) {
    const condition = includeInactive ? '' : 'WHERE is_active = true';
    const result = await pool.query(
      `SELECT * FROM departments ${condition} ORDER BY sort_order, name`
    );
    return result.rows;
  },

  async findBySlug(slug) {
    const result = await pool.query(
      'SELECT * FROM departments WHERE slug = $1',
      [slug]
    );
    return result.rows[0] || null;
  },

  async findById(id) {
    const result = await pool.query(
      'SELECT * FROM departments WHERE id = $1',
      [id]
    );
    return result.rows[0] || null;
  },

  async create(data) {
    const {
      name, slug, description, icon = 'folder', is_active = true,
      sort_order = 0, config = {}, module_path, version = '1.0.0', settings = {},
    } = data;
    const result = await pool.query(
      `INSERT INTO departments (name, slug, description, icon, is_active, sort_order, config, module_path, version, settings)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)
       RETURNING *`,
      [name, slug, description, icon, is_active, sort_order, JSON.stringify(config), module_path, version, JSON.stringify(settings)]
    );
    return result.rows[0];
  },

  async update(id, data) {
    const fields = [];
    const params = [];
    let paramIndex = 1;

    const allowedFields = [
      'name', 'slug', 'description', 'icon', 'is_active',
      'sort_order', 'module_path', 'version',
    ];

    for (const field of allowedFields) {
      if (data[field] !== undefined) {
        fields.push(`${field} = $${paramIndex++}`);
        params.push(data[field]);
      }
    }

    // Handle JSONB fields separately
    for (const jsonField of ['config', 'settings']) {
      if (data[jsonField] !== undefined) {
        fields.push(`${jsonField} = $${paramIndex++}`);
        params.push(JSON.stringify(data[jsonField]));
      }
    }

    if (fields.length === 0) return null;

    fields.push(`updated_at = NOW()`);
    params.push(id);

    const result = await pool.query(
      `UPDATE departments SET ${fields.join(', ')} WHERE id = $${paramIndex}
       RETURNING *`,
      params
    );
    return result.rows[0] || null;
  },

  async toggleActive(id) {
    const result = await pool.query(
      `UPDATE departments SET is_active = NOT is_active, updated_at = NOW() WHERE id = $1
       RETURNING *`,
      [id]
    );
    return result.rows[0] || null;
  },
};

export default Department;
