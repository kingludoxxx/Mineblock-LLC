import pool from '../config/db.js';
import { createAuditLog } from '../services/auditService.js';

const generateSlug = (name) => {
  return name
    .toLowerCase()
    .trim()
    .replace(/[^\w\s-]/g, '')
    .replace(/\s+/g, '-')
    .replace(/-+/g, '-');
};

export const listDepartments = async (req, res) => {
  try {
    const activeOnly = req.query.active === 'true';

    let query = 'SELECT * FROM departments';
    const params = [];

    if (activeOnly) {
      query += ' WHERE is_active = true';
    }

    query += ' ORDER BY sort_order ASC, name ASC';

    const result = await pool.query(query, params);

    return res.json({ departments: result.rows });
  } catch (err) {
    console.error('listDepartments error:', err);
    return res.status(500).json({ error: 'Internal server error' });
  }
};

export const getDepartment = async (req, res) => {
  try {
    const { id } = req.params;

    // Determine if id is a UUID or a slug
    const isUUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(id);

    let result;
    if (isUUID) {
      result = await pool.query('SELECT * FROM departments WHERE id = $1', [id]);
    } else {
      result = await pool.query('SELECT * FROM departments WHERE slug = $1', [id]);
    }

    if (result.rows.length === 0) {
      return res.status(404).json({ error: 'Department not found' });
    }

    return res.json({ department: result.rows[0] });
  } catch (err) {
    console.error('getDepartment error:', err);
    return res.status(500).json({ error: 'Internal server error' });
  }
};

export const createDepartment = async (req, res) => {
  try {
    const { name, description, icon, sortOrder } = req.body;

    if (!name || !description) {
      return res.status(400).json({ error: 'name and description are required' });
    }

    const slug = generateSlug(name);

    const slugCheck = await pool.query('SELECT id FROM departments WHERE slug = $1', [slug]);
    if (slugCheck.rows.length > 0) {
      return res.status(409).json({ error: 'A department with a similar name already exists' });
    }

    const result = await pool.query(
      `INSERT INTO departments (name, slug, description, icon, sort_order)
       VALUES ($1, $2, $3, $4, $5)
       RETURNING *`,
      [name, slug, description, icon || null, sortOrder || 0]
    );

    await createAuditLog({
      userId: req.user.id,
      action: 'CREATE_DEPARTMENT',
      resourceType: 'department',
      resourceId: result.rows[0].id,
      newValues: { name, slug, description },
      ip: req.ip,
      userAgent: req.headers['user-agent'],
    });

    return res.status(201).json({ department: result.rows[0] });
  } catch (err) {
    console.error('createDepartment error:', err);
    return res.status(500).json({ error: 'Internal server error' });
  }
};

export const updateDepartment = async (req, res) => {
  try {
    const { id } = req.params;
    const { name, description, icon, sortOrder } = req.body;

    const existing = await pool.query('SELECT * FROM departments WHERE id = $1', [id]);
    if (existing.rows.length === 0) {
      return res.status(404).json({ error: 'Department not found' });
    }

    const oldDept = existing.rows[0];

    const result = await pool.query(
      `UPDATE departments
       SET name = COALESCE($1, name),
           description = COALESCE($2, description),
           icon = COALESCE($3, icon),
           sort_order = COALESCE($4, sort_order),
           updated_at = NOW()
       WHERE id = $5
       RETURNING *`,
      [name || null, description || null, icon || null, sortOrder != null ? sortOrder : null, id]
    );

    await createAuditLog({
      userId: req.user.id,
      action: 'UPDATE_DEPARTMENT',
      resourceType: 'department',
      resourceId: id,
      oldValues: { name: oldDept.name, description: oldDept.description, icon: oldDept.icon, sortOrder: oldDept.sort_order },
      newValues: { name: result.rows[0].name, description: result.rows[0].description, icon: result.rows[0].icon, sortOrder: result.rows[0].sort_order },
      ip: req.ip,
      userAgent: req.headers['user-agent'],
    });

    return res.json({ department: result.rows[0] });
  } catch (err) {
    console.error('updateDepartment error:', err);
    return res.status(500).json({ error: 'Internal server error' });
  }
};

export const toggleDepartmentStatus = async (req, res) => {
  try {
    const { id } = req.params;

    const existing = await pool.query('SELECT * FROM departments WHERE id = $1', [id]);
    if (existing.rows.length === 0) {
      return res.status(404).json({ error: 'Department not found' });
    }

    const newStatus = !existing.rows[0].is_active;

    const result = await pool.query(
      'UPDATE departments SET is_active = $1, updated_at = NOW() WHERE id = $2 RETURNING *',
      [newStatus, id]
    );

    await createAuditLog({
      userId: req.user.id,
      action: newStatus ? 'ACTIVATE_DEPARTMENT' : 'DEACTIVATE_DEPARTMENT',
      resourceType: 'department',
      resourceId: id,
      oldValues: { isActive: existing.rows[0].is_active },
      newValues: { isActive: newStatus },
      ip: req.ip,
      userAgent: req.headers['user-agent'],
    });

    return res.json({ department: result.rows[0] });
  } catch (err) {
    console.error('toggleDepartmentStatus error:', err);
    return res.status(500).json({ error: 'Internal server error' });
  }
};
