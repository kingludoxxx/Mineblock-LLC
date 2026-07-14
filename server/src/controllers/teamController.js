import crypto from 'crypto';
import pool from '../config/db.js';
import { createAuditLog } from '../services/auditService.js';
import { hashToken } from '../services/authService.js';
import { buildInviteLink } from '../services/emailService.js';
import logger from '../utils/logger.js';

// 7 days — matches typical SaaS invite expiry. Long enough for someone
// to check their inbox after the weekend.
const INVITE_EXPIRY_MS = 7 * 24 * 60 * 60 * 1000;

// Generate a fresh invite token pair (raw for the link, hashed for the DB).
function newInviteToken() {
  const raw = crypto.randomBytes(32).toString('hex');
  return {
    raw,
    hash: hashToken(raw),
    expiresAt: new Date(Date.now() + INVITE_EXPIRY_MS),
  };
}

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
// POST /api/v1/team/invite — Send a real invite.
//
// Flow:
//   1. Admin submits { email, roleId? , pages? } (no name — invitee fills that
//      in on the accept page)
//   2. We create (or reuse) a Pending users row with password_hash=NULL,
//      is_active=false, and a fresh single-use invite token
//   3. Response includes an `inviteLink` the admin copies + sends. Until we
//      wire an email provider (Phase 2) this is the delivery mechanism.
//
// Re-inviting an email that's already Pending regenerates the token so
// the old link stops working — no way to end up with two live invites
// for the same person.
// ---------------------------------------------------------------------------
export const inviteTeamMember = async (req, res) => {
  try {
    const { email, roleId, pages } = req.body;

    if (!email) {
      return res.status(400).json({ error: 'email is required' });
    }
    if (!roleId && (!Array.isArray(pages) || pages.length === 0)) {
      return res.status(400).json({ error: 'Either roleId or pages array is required' });
    }

    const emailRegex = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
    if (!emailRegex.test(email)) {
      return res.status(400).json({ error: 'Invalid email format' });
    }

    const normalizedEmail = email.toLowerCase().trim();

    // Existing-user check. Three states matter here:
    //   • Active/Deactivated user with a password → 409, admin must revoke first
    //   • Pending invitee (password_hash NULL) → replace token, resend
    //   • No row → create fresh Pending row
    const existing = await pool.query(
      'SELECT id, password_hash, is_active FROM users WHERE email = $1',
      [normalizedEmail],
    );
    const existingUser = existing.rows[0] || null;
    if (existingUser && existingUser.password_hash !== null) {
      return res.status(409).json({
        error: existingUser.is_active
          ? 'A user with this email is already on your team'
          : 'A user with this email exists but is deactivated. Reactivate them instead of re-inviting.',
      });
    }

    // Resolve the role to assign (preset or custom-per-pages).
    let assignedRoleId;
    let assignedRoleName;

    if (Array.isArray(pages) && pages.length > 0) {
      // Custom pages mode — create a per-invitee role. Name it by email
      // rather than first/last (which we don't have yet at invite time).
      const permissions = buildPermissionsFromPages(pages);
      const customRoleName = `Custom - ${normalizedEmail}`;
      const roleResult = await pool.query(
        `INSERT INTO roles (name, permissions) VALUES ($1, $2)
         ON CONFLICT (name) DO UPDATE SET permissions = EXCLUDED.permissions
         RETURNING id, name`,
        [customRoleName, JSON.stringify(permissions)],
      );
      assignedRoleId = roleResult.rows[0].id;
      assignedRoleName = roleResult.rows[0].name;
    } else {
      const roleCheck = await pool.query('SELECT id, name FROM roles WHERE id = $1', [roleId]);
      if (roleCheck.rows.length === 0) {
        return res.status(404).json({ error: 'Role not found' });
      }
      assignedRoleId = roleCheck.rows[0].id;
      assignedRoleName = roleCheck.rows[0].name;
    }

    const invite = newInviteToken();

    const client = await pool.connect();
    try {
      await client.query('BEGIN');

      let userId;
      if (existingUser) {
        // Re-issuing invite to a Pending row — refresh token + expiry.
        userId = existingUser.id;
        await client.query(
          `UPDATE users
              SET password_reset_token   = $1,
                  password_reset_expires = $2,
                  invited_at             = NOW(),
                  invited_by             = $3,
                  updated_at             = NOW()
            WHERE id = $4`,
          [invite.hash, invite.expiresAt, req.user.id, userId],
        );
        // Clear any prior role assignment so pages/role changes take effect.
        await client.query('DELETE FROM user_roles WHERE user_id = $1', [userId]);
      } else {
        const userResult = await client.query(
          `INSERT INTO users
             (email, first_name, last_name,
              password_hash, is_active, email_verified,
              password_reset_token, password_reset_expires,
              invited_at, invited_by)
           VALUES ($1, '', '',
                   NULL, false, false,
                   $2, $3,
                   NOW(), $4)
           RETURNING id`,
          [normalizedEmail, invite.hash, invite.expiresAt, req.user.id],
        );
        userId = userResult.rows[0].id;
      }

      await client.query(
        'INSERT INTO user_roles (user_id, role_id) VALUES ($1, $2)',
        [userId, assignedRoleId],
      );

      await client.query('COMMIT');

      await createAuditLog({
        userId: req.user.id,
        action: existingUser ? 'RESEND_TEAM_INVITE' : 'INVITE_TEAM_MEMBER',
        resourceType: 'user',
        resourceId: userId,
        newValues: {
          email: normalizedEmail,
          roleId: assignedRoleId,
          roleName: assignedRoleName,
          pages: pages || null,
          expiresAt: invite.expiresAt,
        },
        ip: req.ip,
        userAgent: req.headers['user-agent'],
      });

      const inviteLink = buildInviteLink({ token: invite.raw });

      return res.status(existingUser ? 200 : 201).json({
        success: true,
        message: existingUser
          ? 'Invite re-issued — old link no longer works'
          : 'Invite created — copy the link and send it to the invitee',
        user: {
          id: userId,
          email: normalizedEmail,
          role: { id: assignedRoleId, name: assignedRoleName },
        },
        inviteLink,
        expiresAt: invite.expiresAt,
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
// POST /api/v1/team/:userId/resend-invite — Regenerate the invite token for a
// still-pending invitee and return a fresh link. Idempotent; safe to call as
// many times as the admin wants (each call invalidates the previous link).
// ---------------------------------------------------------------------------
export const resendTeamInvite = async (req, res) => {
  try {
    const { userId } = req.params;

    const userRes = await pool.query(
      'SELECT id, email, password_hash, is_active FROM users WHERE id = $1',
      [userId],
    );
    const user = userRes.rows[0];
    if (!user) return res.status(404).json({ error: 'User not found' });

    // Only Pending / Expired invitees are eligible.
    if (user.password_hash !== null) {
      return res.status(400).json({
        error: user.is_active
          ? 'User is already active — nothing to resend'
          : 'User is deactivated — reactivate instead of resending invite',
      });
    }

    const invite = newInviteToken();

    await pool.query(
      `UPDATE users
          SET password_reset_token   = $1,
              password_reset_expires = $2,
              invited_at             = NOW(),
              invited_by             = $3,
              updated_at             = NOW()
        WHERE id = $4`,
      [invite.hash, invite.expiresAt, req.user.id, userId],
    );

    await createAuditLog({
      userId: req.user.id,
      action: 'RESEND_TEAM_INVITE',
      resourceType: 'user',
      resourceId: userId,
      newValues: { email: user.email, expiresAt: invite.expiresAt },
      ip: req.ip,
      userAgent: req.headers['user-agent'],
    });

    return res.status(200).json({
      success: true,
      message: 'Invite re-issued — old link no longer works',
      inviteLink: buildInviteLink({ token: invite.raw }),
      expiresAt: invite.expiresAt,
    });
  } catch (err) {
    logger.error('resendTeamInvite error', { error: err.message, stack: err.stack });
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
         u.password_hash IS NOT NULL             AS has_password,
         u.password_reset_expires                AS invite_expires_at,
         u.invited_at, u.invited_by,
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

    const now = Date.now();
    const members = result.rows.map((row) => {
      // Derive invite status without a new column — everything is a function
      // of has_password + is_active + password_reset_expires (see plan file
      // for the truth table). Frontend renders a coloured pill per status.
      let status;
      if (row.has_password && row.is_active)          status = 'active';
      else if (row.has_password && !row.is_active)    status = 'deactivated';
      else if (row.invite_expires_at &&
               new Date(row.invite_expires_at).getTime() > now)
                                                      status = 'pending';
      else                                            status = 'expired';

      return {
        id: row.id,
        email: row.email,
        firstName: row.first_name,
        lastName: row.last_name,
        isActive: row.is_active,
        status,
        invitedAt: row.invited_at,
        inviteExpiresAt: row.invite_expires_at,
        lastLogin: row.last_login,
        createdAt: row.created_at,
        roles: row.roles || [],
      };
    });

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
// PATCH /api/v1/team/:userId/activate — Reactivate a previously deactivated team member
// ---------------------------------------------------------------------------
export const reactivateTeamMember = async (req, res) => {
  try {
    const { userId } = req.params;

    const userCheck = await pool.query(
      'SELECT id, email, is_active FROM users WHERE id = $1',
      [userId],
    );
    if (userCheck.rows.length === 0) {
      return res.status(404).json({ error: 'User not found' });
    }

    if (userCheck.rows[0].is_active) {
      return res.status(400).json({ error: 'User is already active' });
    }

    await pool.query(
      'UPDATE users SET is_active = true, updated_at = NOW() WHERE id = $1',
      [userId],
    );

    await createAuditLog({
      userId: req.user.id,
      action: 'REACTIVATE_TEAM_MEMBER',
      resourceType: 'user',
      resourceId: userId,
      oldValues: { isActive: false },
      newValues: { isActive: true },
      ip: req.ip,
      userAgent: req.headers['user-agent'],
    });

    return res.json({
      success: true,
      message: 'Team member reactivated successfully',
      user: {
        id: userId,
        email: userCheck.rows[0].email,
        isActive: true,
      },
    });
  } catch (err) {
    logger.error('reactivateTeamMember error', { error: err.message, stack: err.stack });
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
