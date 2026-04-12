import crypto from 'crypto';
import pool from '../config/db.js';
import { hashPassword } from '../utils/hash.js';
import { createAuditLog } from '../services/auditService.js';
import logger from '../utils/logger.js';

// ---------------------------------------------------------------------------
// Helper: build permissions JSONB from a list of page keys
// ---------------------------------------------------------------------------
function buildPermissionsFromPages(pages) {
  const perms = { dashboard: ['access'] };
  if (Array.isArray(pages)) {
    for (const p of pages) {
      if (typeof p === 'string' && p.trim()) {
        perms[p.trim()] = ['access'];
      }
    }
  }
  return perms;
}

// ---------------------------------------------------------------------------
// POST /api/v1/team/invite — Invite a new team member
// ---------------------------------------------------------------------------
export const inviteTeamMember = async (req, res) => {
  try {
    const { email, firstName, lastName, roleId, pages } = req.body;

    // Must have either roleId or pages
    if (!email || !firstName || !lastName) {
      return res.status(400).json({ error: 'email, firstName, and lastName are required' });
    }
    if (!roleId && (!Array.isArray(pages) || pages.length === 0)) {
      return res.status(400).json({ error: 'Either roleId or pages array is required' });
    }

    // Validate email format
    const emailRegex = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
    if (!emailRegex.test(email)) {
      return res.status(400).json({ error: 'Invalid email format' });
    }

    // Check if user already exists
    const existing = await pool.query(
      'SELECT id FROM users WHERE email = $1',
      [email.toLowerCase().trim()],
    );
    if (existing.rows.length > 0) {
      return res.status(409).json({ error: 'A user with this email already exists' });
    }

    let assignedRoleId;
    let assignedRoleName;

    if (Array.isArray(pages) && pages.length > 0) {
      // Custom pages mode — create a custom role
      const permissions = buildPermissionsFromPages(pages);
      const customRoleName = `Custom - ${firstName} ${lastName}`;
      const roleResult = await pool.query(
        `INSERT INTO roles (name, permissions) VALUES ($1, $2) RETURNING id, name`,
        [customRoleName, JSON.stringify(permissions)],
      );
      assignedRoleId = roleResult.rows[0].id;
      assignedRoleName = roleResult.rows[0].name;
    } else {
      // Preset role mode — validate role exists
      const roleCheck = await pool.query('SELECT id, name FROM roles WHERE id = $1', [roleId]);
      if (roleCheck.rows.length === 0) {
        return res.status(404).json({ error: 'Role not found' });
      }
      assignedRoleId = roleCheck.rows[0].id;
      assignedRoleName = roleCheck.rows[0].name;
    }

    // Generate temporary password
    const tempPassword = crypto.randomBytes(12).toString('base64url');
    const hashedPassword = await hashPassword(tempPassword);

    const client = await pool.connect();
    try {
      await client.query('BEGIN');

      const userResult = await client.query(
        `INSERT INTO users (email, first_name, last_name, password_hash, must_change_password, is_active)
         VALUES ($1, $2, $3, $4, true, true)
         RETURNING id, email, first_name, last_name, is_active, must_change_password, created_at`,
        [email.toLowerCase().trim(), firstName, lastName, hashedPassword],
      );

      const newUser = userResult.rows[0];

      await client.query(
        'INSERT INTO user_roles (user_id, role_id) VALUES ($1, $2)',
        [newUser.id, assignedRoleId],
      );

      await client.query('COMMIT');

      await createAuditLog({
        userId: req.user.id,
        action: 'INVITE_TEAM_MEMBER',
        resourceType: 'user',
        resourceId: newUser.id,
        newValues: { email: newUser.email, firstName, lastName, roleId: assignedRoleId, roleName: assignedRoleName, pages: pages || null },
        ip: req.ip,
        userAgent: req.headers['user-agent'],
      });

      return res.status(201).json({
        success: true,
        message: 'Team member invited successfully',
        user: {
          id: newUser.id,
          email: newUser.email,
          firstName: newUser.first_name,
          lastName: newUser.last_name,
          isActive: newUser.is_active,
          mustChangePassword: newUser.must_change_password,
          createdAt: newUser.created_at,
          role: { id: assignedRoleId, name: assignedRoleName },
        },
        temporaryPassword: tempPassword,
      });
    } catch (err) {
      await client.query('ROLLBACK');
      throw err;
    } finally {
      client.release();
    }
  } catch (err) {
    logger.error('inviteTeamMember error', { error: err.message, stack: err.stack });
    return res.status(500).json({ error: 'Internal server error' });
  }
};

// ---------------------------------------------------------------------------
// GET /api/v1/team — List all team members with roles and permissions
// ---------------------------------------------------------------------------
export const listTeamMembers = async (req, res) => {
  try {
    const result = await pool.query(
      `SELECT
         u.id, u.email, u.first_name, u.last_name, u.is_active,
         u.last_login, u.created_at,
         json_agg(
           json_build_object('id', r.id, 'name', r.name, 'permissions', r.permissions)
         ) FILTER (WHERE r.id IS NOT NULL) AS roles
       FROM users u
       LEFT JOIN user_roles ur ON u.id = ur.user_id
       LEFT JOIN roles r ON ur.role_id = r.id
       GROUP BY u.id
       ORDER BY u.created_at DESC`,
    );

    const members = result.rows.map((row) => ({
      id: row.id,
      email: row.email,
      firstName: row.first_name,
      lastName: row.last_name,
      isActive: row.is_active,
      lastLogin: row.last_login,
      createdAt: row.created_at,
      roles: row.roles || [],
    }));

    return res.json({ success: true, members });
  } catch (err) {
    logger.error('listTeamMembers error', { error: err.message, stack: err.stack });
    return res.status(500).json({ error: 'Internal server error' });
  }
};

// ---------------------------------------------------------------------------
// PUT /api/v1/team/:userId/role — Change a team member's role
// ---------------------------------------------------------------------------
export const changeTeamMemberRole = async (req, res) => {
  try {
    const { userId } = req.params;
    const { roleId } = req.body;

    if (!roleId) {
      return res.status(400).json({ error: 'roleId is required' });
    }

    // Cannot change own role
    if (userId === req.user.id) {
      return res.status(400).json({ error: 'Cannot change your own role' });
    }

    // Check user exists
    const userCheck = await pool.query(
      'SELECT id, email, is_active FROM users WHERE id = $1',
      [userId],
    );
    if (userCheck.rows.length === 0) {
      return res.status(404).json({ error: 'User not found' });
    }

    // Check new role exists
    const roleCheck = await pool.query('SELECT id, name FROM roles WHERE id = $1', [roleId]);
    if (roleCheck.rows.length === 0) {
      return res.status(404).json({ error: 'Role not found' });
    }

    // Get current roles
    const currentRoles = await pool.query(
      `SELECT r.id, r.name FROM roles r
       JOIN user_roles ur ON r.id = ur.role_id
       WHERE ur.user_id = $1`,
      [userId],
    );

    // Check if demoting the last SuperAdmin
    const isSuperAdmin = currentRoles.rows.some((r) => r.name === 'SuperAdmin');
    const newRoleIsSuperAdmin = roleCheck.rows[0].name === 'SuperAdmin';

    if (isSuperAdmin && !newRoleIsSuperAdmin) {
      const otherSuperAdmins = await pool.query(
        `SELECT COUNT(DISTINCT u.id) as count
         FROM users u
         JOIN user_roles ur ON u.id = ur.user_id
         JOIN roles r ON ur.role_id = r.id
         WHERE r.name = 'SuperAdmin' AND u.is_active = true AND u.id != $1`,
        [userId],
      );

      if (parseInt(otherSuperAdmins.rows[0].count, 10) === 0) {
        return res.status(400).json({ error: 'Cannot demote the last SuperAdmin' });
      }
    }

    const client = await pool.connect();
    try {
      await client.query('BEGIN');

      // Remove all current roles
      await client.query('DELETE FROM user_roles WHERE user_id = $1', [userId]);

      // Assign the new role
      await client.query(
        'INSERT INTO user_roles (user_id, role_id) VALUES ($1, $2)',
        [userId, roleId],
      );

      await client.query('COMMIT');
    } catch (err) {
      await client.query('ROLLBACK');
      throw err;
    } finally {
      client.release();
    }

    // Invalidate user's sessions so new permissions take effect immediately
    await pool.query('DELETE FROM sessions WHERE user_id = $1', [userId]);

    await createAuditLog({
      userId: req.user.id,
      action: 'CHANGE_TEAM_ROLE',
      resourceType: 'user',
      resourceId: userId,
      oldValues: { roles: currentRoles.rows },
      newValues: { roleId, roleName: roleCheck.rows[0].name },
      ip: req.ip,
      userAgent: req.headers['user-agent'],
    });

    return res.json({
      success: true,
      message: 'Role updated successfully',
      user: {
        id: userId,
        email: userCheck.rows[0].email,
        newRole: { id: roleCheck.rows[0].id, name: roleCheck.rows[0].name },
      },
    });
  } catch (err) {
    logger.error('changeTeamMemberRole error', { error: err.message, stack: err.stack });
    return res.status(500).json({ error: 'Internal server error' });
  }
};

// ---------------------------------------------------------------------------
// DELETE /api/v1/team/:userId — Deactivate a team member
// ---------------------------------------------------------------------------
export const deactivateTeamMember = async (req, res) => {
  try {
    const { userId } = req.params;

    // Cannot deactivate self
    if (userId === req.user.id) {
      return res.status(400).json({ error: 'Cannot deactivate your own account' });
    }

    // Check user exists
    const userCheck = await pool.query(
      'SELECT id, email, is_active FROM users WHERE id = $1',
      [userId],
    );
    if (userCheck.rows.length === 0) {
      return res.status(404).json({ error: 'User not found' });
    }

    if (!userCheck.rows[0].is_active) {
      return res.status(400).json({ error: 'User is already deactivated' });
    }

    // Check if deactivating the last SuperAdmin
    const hasSuperAdminRole = await pool.query(
      `SELECT 1 FROM user_roles ur
       JOIN roles r ON ur.role_id = r.id
       WHERE ur.user_id = $1 AND r.name = 'SuperAdmin'`,
      [userId],
    );

    if (hasSuperAdminRole.rows.length > 0) {
      const otherSuperAdmins = await pool.query(
        `SELECT COUNT(DISTINCT u.id) as count
         FROM users u
         JOIN user_roles ur ON u.id = ur.user_id
         JOIN roles r ON ur.role_id = r.id
         WHERE r.name = 'SuperAdmin' AND u.is_active = true AND u.id != $1`,
        [userId],
      );

      if (parseInt(otherSuperAdmins.rows[0].count, 10) === 0) {
        return res.status(400).json({ error: 'Cannot deactivate the last SuperAdmin' });
      }
    }

    // Deactivate user
    await pool.query(
      'UPDATE users SET is_active = false, updated_at = NOW() WHERE id = $1',
      [userId],
    );

    // Invalidate all sessions
    await pool.query('DELETE FROM sessions WHERE user_id = $1', [userId]);

    await createAuditLog({
      userId: req.user.id,
      action: 'DEACTIVATE_TEAM_MEMBER',
      resourceType: 'user',
      resourceId: userId,
      oldValues: { isActive: true },
      newValues: { isActive: false },
      ip: req.ip,
      userAgent: req.headers['user-agent'],
    });

    return res.json({
      success: true,
      message: 'Team member deactivated successfully',
      user: {
        id: userId,
        email: userCheck.rows[0].email,
        isActive: false,
      },
    });
  } catch (err) {
    logger.error('deactivateTeamMember error', { error: err.message, stack: err.stack });
    return res.status(500).json({ error: 'Internal server error' });
  }
};

// ---------------------------------------------------------------------------
// PUT /api/v1/team/:userId/pages — Update a team member's page access
// ---------------------------------------------------------------------------
export const updateTeamMemberPages = async (req, res) => {
  try {
    const { userId } = req.params;
    const { pages } = req.body;

    if (!Array.isArray(pages) || pages.length === 0) {
      return res.status(400).json({ error: 'pages array is required and must not be empty' });
    }

    // Cannot change own pages
    if (String(userId) === String(req.user.id)) {
      return res.status(400).json({ error: 'Cannot change your own page access' });
    }

    // Check user exists
    const userCheck = await pool.query(
      'SELECT id, email, first_name, last_name FROM users WHERE id = $1',
      [userId],
    );
    if (userCheck.rows.length === 0) {
      return res.status(404).json({ error: 'User not found' });
    }

    const targetUser = userCheck.rows[0];
    const permissions = buildPermissionsFromPages(pages);
    const customRoleName = `Custom - ${targetUser.first_name} ${targetUser.last_name}`;

    const client = await pool.connect();
    try {
      await client.query('BEGIN');

      // Check if user already has a custom role we can update
      const existingCustomRole = await client.query(
        `SELECT r.id FROM roles r
         JOIN user_roles ur ON r.id = ur.role_id
         WHERE ur.user_id = $1 AND r.name LIKE 'Custom - %'`,
        [userId],
      );

      let assignedRoleId;
      let assignedRoleName;

      if (existingCustomRole.rows.length > 0) {
        // Update existing custom role permissions
        const existingId = existingCustomRole.rows[0].id;
        await client.query(
          'UPDATE roles SET name = $1, permissions = $2 WHERE id = $3',
          [customRoleName, JSON.stringify(permissions), existingId],
        );
        assignedRoleId = existingId;
        assignedRoleName = customRoleName;
      } else {
        // Create a new custom role
        const roleResult = await client.query(
          'INSERT INTO roles (name, permissions) VALUES ($1, $2) RETURNING id, name',
          [customRoleName, JSON.stringify(permissions)],
        );
        assignedRoleId = roleResult.rows[0].id;
        assignedRoleName = roleResult.rows[0].name;

        // Remove old role assignments and assign the new custom role
        await client.query('DELETE FROM user_roles WHERE user_id = $1', [userId]);
        await client.query(
          'INSERT INTO user_roles (user_id, role_id) VALUES ($1, $2)',
          [userId, assignedRoleId],
        );
      }

      await client.query('COMMIT');

      // Invalidate user's sessions so new permissions take effect immediately
      await pool.query('DELETE FROM sessions WHERE user_id = $1', [userId]);

      await createAuditLog({
        userId: req.user.id,
        action: 'UPDATE_TEAM_PAGES',
        resourceType: 'user',
        resourceId: userId,
        newValues: { pages, roleName: assignedRoleName },
        ip: req.ip,
        userAgent: req.headers['user-agent'],
      });

      return res.json({
        success: true,
        message: 'Page access updated successfully',
        user: {
          id: userId,
          email: targetUser.email,
          role: { id: assignedRoleId, name: assignedRoleName },
          pages,
        },
      });
    } catch (err) {
      await client.query('ROLLBACK');
      throw err;
    } finally {
      client.release();
    }
  } catch (err) {
    logger.error('updateTeamMemberPages error', { error: err.message, stack: err.stack });
    return res.status(500).json({ error: 'Internal server error' });
  }
};
