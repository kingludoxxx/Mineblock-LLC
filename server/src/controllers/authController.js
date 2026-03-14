import crypto from 'crypto';
import pool from '../config/db.js';
import { signAccessToken, signRefreshToken, verifyRefreshToken } from '../utils/jwt.js';
import { hashPassword, comparePassword } from '../utils/hash.js';
import { getUserWithRoles, createSession, hashToken } from '../services/authService.js';
import logger from '../utils/logger.js';
import env from '../config/env.js';

const LOCK_THRESHOLD = 5;
const LOCK_DURATION_MS = 15 * 60 * 1000; // 15 minutes
const REFRESH_COOKIE_MAX_AGE = 7 * 24 * 60 * 60 * 1000; // 7 days

const setRefreshCookie = (res, token) => {
  res.cookie('refreshToken', token, {
    httpOnly: true,
    secure: env.NODE_ENV === 'production',
    sameSite: 'strict',
    path: '/api/v1/auth',
    maxAge: REFRESH_COOKIE_MAX_AGE,
  });
};

const clearRefreshCookie = (res) => {
  res.clearCookie('refreshToken', {
    httpOnly: true,
    secure: env.NODE_ENV === 'production',
    sameSite: 'strict',
    path: '/api/v1/auth',
  });
};

export const login = async (req, res, next) => {
  try {
    const { email, password } = req.body;

    // 1. Validate email + password
    if (!email || !password) {
      return res.status(400).json({ error: 'Email and password are required' });
    }

    // 2. Find user by email
    const userResult = await pool.query(
      'SELECT * FROM users WHERE email = $1',
      [email]
    );

    if (userResult.rows.length === 0) {
      return res.status(401).json({ error: 'Invalid credentials' });
    }

    const user = userResult.rows[0];

    // 3. Check is_active
    if (!user.is_active) {
      return res.status(401).json({ error: 'Account deactivated' });
    }

    // 4. Check locked_until
    if (user.locked_until && new Date(user.locked_until) > new Date()) {
      return res.status(423).json({ error: 'Account locked' });
    }

    // 5. Compare password
    const passwordValid = await comparePassword(password, user.password_hash);

    if (!passwordValid) {
      const newAttempts = (user.failed_login_attempts || 0) + 1;
      const updateFields = { failed_login_attempts: newAttempts };

      if (newAttempts >= LOCK_THRESHOLD) {
        const lockedUntil = new Date(Date.now() + LOCK_DURATION_MS);
        await pool.query(
          'UPDATE users SET failed_login_attempts = $1, locked_until = $2 WHERE id = $3',
          [newAttempts, lockedUntil, user.id]
        );
        logger.warn('Account locked due to too many failed attempts', { email, userId: user.id });
      } else {
        await pool.query(
          'UPDATE users SET failed_login_attempts = $1 WHERE id = $2',
          [newAttempts, user.id]
        );
      }

      return res.status(401).json({ error: 'Invalid credentials' });
    }

    // 6. Reset failed_login_attempts, update last_login
    await pool.query(
      'UPDATE users SET failed_login_attempts = 0, locked_until = NULL, last_login = NOW() WHERE id = $1',
      [user.id]
    );

    // 7. Get user's roles
    const rolesResult = await pool.query(
      `SELECT r.id, r.name, r.permissions
       FROM roles r
       INNER JOIN user_roles ur ON r.id = ur.role_id
       WHERE ur.user_id = $1`,
      [user.id]
    );

    const roles = rolesResult.rows.map((r) => ({
      id: r.id,
      name: r.name,
      permissions: r.permissions,
    }));

    // 8. Generate access token
    const accessToken = signAccessToken({
      userId: user.id,
      email: user.email,
      roles,
    });

    // 9. Generate refresh token
    const tokenId = crypto.randomUUID();
    const refreshToken = signRefreshToken({
      userId: user.id,
      tokenId,
    });

    // 10. Store session
    const ip = req.ip;
    const userAgent = req.headers['user-agent'] || '';
    await createSession(user.id, refreshToken, ip, userAgent);

    // 11. Set refresh token cookie
    setRefreshCookie(res, refreshToken);

    // 12. Return response
    return res.status(200).json({
      accessToken,
      user: {
        id: user.id,
        email: user.email,
        firstName: user.first_name,
        lastName: user.last_name,
        roles,
        mustChangePassword: user.must_change_password,
      },
    });
  } catch (err) {
    logger.error('Login error', { error: err.message, stack: err.stack });
    next(err);
  }
};

export const refresh = async (req, res, next) => {
  try {
    // 1. Get refreshToken from cookies
    const refreshToken = req.cookies?.refreshToken;

    // 2. If no token, return 401
    if (!refreshToken) {
      return res.status(401).json({ error: 'Refresh token required' });
    }

    // 3. Verify JWT
    let decoded;
    try {
      decoded = verifyRefreshToken(refreshToken);
    } catch (err) {
      clearRefreshCookie(res);
      return res.status(401).json({ error: 'Invalid refresh token' });
    }

    // 4. Hash and find session
    const tokenHash = hashToken(refreshToken);
    const sessionResult = await pool.query(
      'SELECT * FROM sessions WHERE token_hash = $1',
      [tokenHash]
    );

    // 5. If no session or expired
    if (sessionResult.rows.length === 0) {
      clearRefreshCookie(res);
      return res.status(401).json({ error: 'Invalid session' });
    }

    const session = sessionResult.rows[0];

    if (new Date(session.expires_at) < new Date()) {
      await pool.query('DELETE FROM sessions WHERE id = $1', [session.id]);
      clearRefreshCookie(res);
      return res.status(401).json({ error: 'Session expired' });
    }

    // 6. Delete old session (rotation)
    await pool.query('DELETE FROM sessions WHERE id = $1', [session.id]);

    // 7. Get user + roles
    const user = await getUserWithRoles(decoded.userId);

    if (!user) {
      clearRefreshCookie(res);
      return res.status(401).json({ error: 'User not found' });
    }

    // 8. Generate new tokens and session
    const accessToken = signAccessToken({
      userId: user.id,
      email: user.email,
      roles: user.roles,
    });

    const newTokenId = crypto.randomUUID();
    const newRefreshToken = signRefreshToken({
      userId: user.id,
      tokenId: newTokenId,
    });

    const ip = req.ip;
    const userAgent = req.headers['user-agent'] || '';
    await createSession(user.id, newRefreshToken, ip, userAgent);

    // 9. Set new cookie, return response
    setRefreshCookie(res, newRefreshToken);

    return res.status(200).json({
      accessToken,
      user: {
        id: user.id,
        email: user.email,
        firstName: user.firstName,
        lastName: user.lastName,
        roles: user.roles,
        mustChangePassword: user.mustChangePassword,
      },
    });
  } catch (err) {
    logger.error('Refresh error', { error: err.message, stack: err.stack });
    next(err);
  }
};

export const logout = async (req, res) => {
  try {
    // 1. Get refreshToken from cookie
    const refreshToken = req.cookies?.refreshToken;

    // 2. If exists, hash and delete session
    if (refreshToken) {
      const tokenHash = hashToken(refreshToken);
      await pool.query('DELETE FROM sessions WHERE token_hash = $1', [tokenHash]);
    }

    // 3. Clear cookie
    clearRefreshCookie(res);

    // 4. Return success
    return res.status(200).json({ message: 'Logged out successfully' });
  } catch (err) {
    logger.error('Logout error', { error: err.message });
    clearRefreshCookie(res);
    return res.status(200).json({ message: 'Logged out successfully' });
  }
};

export const me = (req, res) => {
  return res.status(200).json(req.user);
};

export const changePassword = async (req, res, next) => {
  try {
    const { currentPassword, newPassword, confirmPassword } = req.body;

    // 1. Validate inputs
    if (!currentPassword || !newPassword || !confirmPassword) {
      return res.status(400).json({ error: 'Current password, new password, and confirmation are required' });
    }

    // 2. newPassword !== currentPassword
    if (newPassword === currentPassword) {
      return res.status(400).json({ error: 'New password must be different from current password' });
    }

    // 2. newPassword === confirmPassword
    if (newPassword !== confirmPassword) {
      return res.status(400).json({ error: 'New password and confirmation do not match' });
    }

    // 3. Verify current password against DB
    const userResult = await pool.query(
      'SELECT id, password_hash FROM users WHERE id = $1',
      [req.user.id]
    );

    if (userResult.rows.length === 0) {
      return res.status(401).json({ error: 'User not found' });
    }

    const user = userResult.rows[0];
    const passwordValid = await comparePassword(currentPassword, user.password_hash);

    if (!passwordValid) {
      return res.status(401).json({ error: 'Current password is incorrect' });
    }

    // 4. Hash new password, update user
    const newHash = await hashPassword(newPassword);
    await pool.query(
      'UPDATE users SET password_hash = $1, must_change_password = false, updated_at = NOW() WHERE id = $2',
      [newHash, req.user.id]
    );

    // 5. Delete all other sessions for this user (keep current one via cookie)
    const refreshToken = req.cookies?.refreshToken;
    if (refreshToken) {
      const currentHash = hashToken(refreshToken);
      await pool.query(
        'DELETE FROM sessions WHERE user_id = $1 AND token_hash != $2',
        [req.user.id, currentHash]
      );
    } else {
      await pool.query(
        'DELETE FROM sessions WHERE user_id = $1',
        [req.user.id]
      );
    }

    // 6. Return success
    return res.status(200).json({ message: 'Password changed successfully' });
  } catch (err) {
    logger.error('Change password error', { error: err.message, stack: err.stack });
    next(err);
  }
};

export default {
  login,
  refresh,
  logout,
  me,
  changePassword,
};
