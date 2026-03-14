import pool from '../config/db.js';
import { hashPassword } from '../utils/hash.js';
import { createAuditLog } from '../services/auditService.js';

export const listUsers = async (req, res) => {
  try {
    const page = Math.max(1, parseInt(req.query.page, 10) || 1);
    const limit = Math.min(100, Math.max(1, parseInt(req.query.limit, 10) || 20));
    const offset = (page - 1) * limit;
    const { search, role, status } = req.query;

    const conditions = [];
    const params = [];
    let paramIndex = 1;

    if (search) {
      conditions.push(`(u.email ILIKE $${paramIndex} OR u.first_name ILIKE $${paramIndex} OR u.last_name ILIKE $${paramIndex})`);
      params.push(`%${search}%`);
      paramIndex++;
    }

    if (role) {
      conditions.push(`r.name = $${paramIndex}`);
      params.push(role);
      paramIndex++;
    }

    if (status === 'active') {
      conditions.push('u.is_active = true');
    } else if (status === 'inactive') {
      conditions.push('u.is_active = false');
    }

    const whereClause = conditions.length > 0 ? `WHERE ${conditions.join(' AND ')}` : '';

    const countResult = await pool.query(
      `SELECT COUNT(DISTINCT u.id) as total
       FROM users u
       LEFT JOIN user_roles ur ON u.id = ur.user_id
       LEFT JOIN roles r ON ur.role_id = r.id
       ${whereClause}`,
      params
    );

    const total = parseInt(countResult.rows[0].total, 10);

    const dataParams = [...params, limit, offset];
    const result = await pool.query(
      `SELECT u.*, json_agg(json_build_object('id', r.id, 'name', r.name)) FILTER (WHERE r.id IS NOT NULL) as roles
       FROM users u
       LEFT JOIN user_roles ur ON u.id = ur.user_id
       LEFT JOIN roles r ON ur.role_id = r.id
       ${whereClause}
       GROUP BY u.id
       ORDER BY u.created_at DESC
       LIMIT $${paramIndex} OFFSET $${paramIndex + 1}`,
      dataParams
    );

    const users = result.rows.map((row) => ({
      id: row.id,
      email: row.email,
      firstName: row.first_name,
      lastName: row.last_name,
      isActive: row.is_active,
      createdAt: row.created_at,
      updatedAt: row.updated_at,
      roles: row.roles || [],
    }));

    return res.json({ users, total, page, limit });
  } catch (err) {
    console.error('listUsers error:', err);
    return res.status(500).json({ error: 'Internal server error' });
  }
};

export const getUserById = async (req, res) => {
  try {
    const { id } = req.params;

    const result = await pool.query(
      `SELECT u.*, json_agg(json_build_object('id', r.id, 'name', r.name, 'permissions', r.permissions)) FILTER (WHERE r.id IS NOT NULL) as roles
       FROM users u
       LEFT JOIN user_roles ur ON u.id = ur.user_id
       LEFT JOIN roles r ON ur.role_id = r.id
       WHERE u.id = $1
       GROUP BY u.id`,
      [id]
    );

    if (result.rows.length === 0) {
      return res.status(404).json({ error: 'User not found' });
    }

    const row = result.rows[0];
    const user = {
      id: row.id,
      email: row.email,
      firstName: row.first_name,
      lastName: row.last_name,
      isActive: row.is_active,
      mustChangePassword: row.must_change_password,
      createdAt: row.created_at,
      updatedAt: row.updated_at,
      roles: row.roles || [],
    };

    return res.json({ user });
  } catch (err) {
    console.error('getUserById error:', err);
    return res.status(500).json({ error: 'Internal server error' });
  }
};

export const createUser = async (req, res) => {
  try {
    const { email, firstName, lastName, password, roleId } = req.body;

    if (!email || !firstName || !lastName || !password || !roleId) {
      return res.status(400).json({ error: 'email, firstName, lastName, password, and roleId are required' });
    }

    const existing = await pool.query('SELECT id FROM users WHERE email = $1', [email.toLowerCase()]);
    if (existing.rows.length > 0) {
      return res.status(409).json({ error: 'Email already in use' });
    }

    const hashedPassword = await hashPassword(password);

    const client = await pool.connect();
    try {
      await client.query('BEGIN');

      const userResult = await client.query(
        `INSERT INTO users (email, first_name, last_name, password_hash)
         VALUES ($1, $2, $3, $4)
         RETURNING *`,
        [email.toLowerCase(), firstName, lastName, hashedPassword]
      );

      const newUser = userResult.rows[0];

      await client.query(
        'INSERT INTO user_roles (user_id, role_id) VALUES ($1, $2)',
        [newUser.id, roleId]
      );

      await client.query('COMMIT');

      await createAuditLog({
        userId: req.user.id,
        action: 'CREATE_USER',
        resourceType: 'user',
        resourceId: newUser.id,
        newValues: { email: newUser.email, firstName, lastName, roleId },
        ip: req.ip,
        userAgent: req.headers['user-agent'],
      });

      return res.status(201).json({
        user: {
          id: newUser.id,
          email: newUser.email,
          firstName: newUser.first_name,
          lastName: newUser.last_name,
          isActive: newUser.is_active,
          createdAt: newUser.created_at,
        },
      });
    } catch (err) {
      await client.query('ROLLBACK');
      throw err;
    } finally {
      client.release();
    }
  } catch (err) {
    console.error('createUser error:', err);
    return res.status(500).json({ error: 'Internal server error' });
  }
};

export const updateUser = async (req, res) => {
  try {
    const { id } = req.params;
    const { firstName, lastName, email } = req.body;

    const existing = await pool.query('SELECT * FROM users WHERE id = $1', [id]);
    if (existing.rows.length === 0) {
      return res.status(404).json({ error: 'User not found' });
    }

    const oldUser = existing.rows[0];

    if (email && email.toLowerCase() !== oldUser.email) {
      const emailCheck = await pool.query('SELECT id FROM users WHERE email = $1 AND id != $2', [email.toLowerCase(), id]);
      if (emailCheck.rows.length > 0) {
        return res.status(409).json({ error: 'Email already in use' });
      }
    }

    const result = await pool.query(
      `UPDATE users
       SET first_name = COALESCE($1, first_name),
           last_name = COALESCE($2, last_name),
           email = COALESCE($3, email),
           updated_at = NOW()
       WHERE id = $4
       RETURNING *`,
      [firstName || null, lastName || null, email ? email.toLowerCase() : null, id]
    );

    const updated = result.rows[0];

    await createAuditLog({
      userId: req.user.id,
      action: 'UPDATE_USER',
      resourceType: 'user',
      resourceId: id,
      oldValues: { firstName: oldUser.first_name, lastName: oldUser.last_name, email: oldUser.email },
      newValues: { firstName: updated.first_name, lastName: updated.last_name, email: updated.email },
      ip: req.ip,
      userAgent: req.headers['user-agent'],
    });

    return res.json({
      user: {
        id: updated.id,
        email: updated.email,
        firstName: updated.first_name,
        lastName: updated.last_name,
        isActive: updated.is_active,
        updatedAt: updated.updated_at,
      },
    });
  } catch (err) {
    console.error('updateUser error:', err);
    return res.status(500).json({ error: 'Internal server error' });
  }
};

export const toggleUserStatus = async (req, res) => {
  try {
    const { id } = req.params;

    const existing = await pool.query('SELECT * FROM users WHERE id = $1', [id]);
    if (existing.rows.length === 0) {
      return res.status(404).json({ error: 'User not found' });
    }

    const user = existing.rows[0];
    const newStatus = !user.is_active;

    // If deactivating, check not the last active SuperAdmin
    if (!newStatus) {
      const superAdminCount = await pool.query(
        `SELECT COUNT(DISTINCT u.id) as count
         FROM users u
         JOIN user_roles ur ON u.id = ur.user_id
         JOIN roles r ON ur.role_id = r.id
         WHERE r.name = 'SuperAdmin' AND u.is_active = true AND u.id != $1`,
        [id]
      );

      const hasSuperAdminRole = await pool.query(
        `SELECT 1 FROM user_roles ur JOIN roles r ON ur.role_id = r.id WHERE ur.user_id = $1 AND r.name = 'SuperAdmin'`,
        [id]
      );

      if (hasSuperAdminRole.rows.length > 0 && parseInt(superAdminCount.rows[0].count, 10) === 0) {
        return res.status(400).json({ error: 'Cannot deactivate the last SuperAdmin' });
      }
    }

    const result = await pool.query(
      'UPDATE users SET is_active = $1, updated_at = NOW() WHERE id = $2 RETURNING *',
      [newStatus, id]
    );

    // If deactivating, remove all sessions
    if (!newStatus) {
      await pool.query('DELETE FROM sessions WHERE user_id = $1', [id]);
    }

    await createAuditLog({
      userId: req.user.id,
      action: newStatus ? 'ACTIVATE_USER' : 'DEACTIVATE_USER',
      resourceType: 'user',
      resourceId: id,
      oldValues: { isActive: user.is_active },
      newValues: { isActive: newStatus },
      ip: req.ip,
      userAgent: req.headers['user-agent'],
    });

    const updated = result.rows[0];
    return res.json({
      user: {
        id: updated.id,
        email: updated.email,
        firstName: updated.first_name,
        lastName: updated.last_name,
        isActive: updated.is_active,
        updatedAt: updated.updated_at,
      },
    });
  } catch (err) {
    console.error('toggleUserStatus error:', err);
    return res.status(500).json({ error: 'Internal server error' });
  }
};

export const assignRole = async (req, res) => {
  try {
    const { id } = req.params;
    const { roleId } = req.body;

    if (!roleId) {
      return res.status(400).json({ error: 'roleId is required' });
    }

    const userCheck = await pool.query('SELECT id FROM users WHERE id = $1', [id]);
    if (userCheck.rows.length === 0) {
      return res.status(404).json({ error: 'User not found' });
    }

    const roleCheck = await pool.query('SELECT id, name FROM roles WHERE id = $1', [roleId]);
    if (roleCheck.rows.length === 0) {
      return res.status(404).json({ error: 'Role not found' });
    }

    const existing = await pool.query(
      'SELECT 1 FROM user_roles WHERE user_id = $1 AND role_id = $2',
      [id, roleId]
    );
    if (existing.rows.length > 0) {
      return res.status(409).json({ error: 'User already has this role' });
    }

    await pool.query('INSERT INTO user_roles (user_id, role_id) VALUES ($1, $2)', [id, roleId]);

    await createAuditLog({
      userId: req.user.id,
      action: 'ASSIGN_ROLE',
      resourceType: 'user',
      resourceId: id,
      newValues: { roleId, roleName: roleCheck.rows[0].name },
      ip: req.ip,
      userAgent: req.headers['user-agent'],
    });

    return res.json({ success: true, message: 'Role assigned successfully' });
  } catch (err) {
    console.error('assignRole error:', err);
    return res.status(500).json({ error: 'Internal server error' });
  }
};

export const removeRole = async (req, res) => {
  try {
    const { id, roleId } = req.params;

    // Check if removing a SuperAdmin role
    const roleCheck = await pool.query('SELECT id, name FROM roles WHERE id = $1', [roleId]);
    if (roleCheck.rows.length === 0) {
      return res.status(404).json({ error: 'Role not found' });
    }

    if (roleCheck.rows[0].name === 'SuperAdmin') {
      const superAdminCount = await pool.query(
        `SELECT COUNT(DISTINCT ur.user_id) as count
         FROM user_roles ur
         JOIN roles r ON ur.role_id = r.id
         JOIN users u ON ur.user_id = u.id
         WHERE r.name = 'SuperAdmin' AND u.is_active = true AND ur.user_id != $1`,
        [id]
      );

      if (parseInt(superAdminCount.rows[0].count, 10) === 0) {
        return res.status(400).json({ error: 'Cannot remove the last SuperAdmin role' });
      }
    }

    const result = await pool.query(
      'DELETE FROM user_roles WHERE user_id = $1 AND role_id = $2',
      [id, roleId]
    );

    if (result.rowCount === 0) {
      return res.status(404).json({ error: 'User role not found' });
    }

    await createAuditLog({
      userId: req.user.id,
      action: 'REMOVE_ROLE',
      resourceType: 'user',
      resourceId: id,
      oldValues: { roleId, roleName: roleCheck.rows[0].name },
      ip: req.ip,
      userAgent: req.headers['user-agent'],
    });

    return res.json({ success: true, message: 'Role removed successfully' });
  } catch (err) {
    console.error('removeRole error:', err);
    return res.status(500).json({ error: 'Internal server error' });
  }
};
