import crypto from 'crypto';
import pool from '../config/db.js';
import { signAccessToken, signRefreshToken, verifyRefreshToken } from '../utils/jwt.js';
import { hashPassword, comparePassword } from '../utils/hash.js';
import {
  getUserWithRoles,
  createSession,
  hashToken,
  findUserByEmail,
  createUser,
  updatePassword,
} from '../services/authService.js';
import logger from '../utils/logger.js';
import env from '../config/env.js';

// ---------------------------------------------------------------------------
// Redis import — for session caching; gracefully degrade
// ---------------------------------------------------------------------------
let redisClient = null;
try {
  const redis = await import('../../db/redis.js');
  redisClient = redis.default || redis.client || null;
} catch {
  // Redis not yet available
}

const LOCK_THRESHOLD = 5;
const LOCK_DURATION_MS = 15 * 60 * 1000; // 15 minutes
const REFRESH_COOKIE_MAX_AGE = 7 * 24 * 60 * 60 * 1000; // 7 days
const ACCESS_COOKIE_MAX_AGE = 15 * 60 * 1000; // 15 minutes
const SESSION_TTL = 300; // 5 minutes (Redis)

// ---------------------------------------------------------------------------
// Cookie helpers
// ---------------------------------------------------------------------------

const setAccessCookie = (res, token) => {
  res.cookie('accessToken', token, {
    httpOnly: true,
    secure: env.NODE_ENV === 'production',
    sameSite: 'strict',
    path: '/',
    maxAge: ACCESS_COOKIE_MAX_AGE,
  });
};

const setRefreshCookie = (res, token) => {
  res.cookie('refreshToken', token, {
    httpOnly: true,
    secure: env.NODE_ENV === 'production',
    sameSite: 'strict',
    path: '/api/v1/auth',
    maxAge: REFRESH_COOKIE_MAX_AGE,
  });
};

const clearAuthCookies = (res) => {
  res.clearCookie('accessToken', {
    httpOnly: true,
    secure: env.NODE_ENV === 'production',
    sameSite: 'strict',
    path: '/',
  });
  res.clearCookie('refreshToken', {
    httpOnly: true,
    secure: env.NODE_ENV === 'production',
    sameSite: 'strict',
    path: '/api/v1/auth',
  });
};

// ---------------------------------------------------------------------------
// Redis session cache helpers
// ---------------------------------------------------------------------------

const cacheSession = async (tokenHash, userData) => {
  if (!redisClient) return;
  try {
    await redisClient.set(
      `session:${tokenHash}`,
      JSON.stringify(userData),
      'EX',
      SESSION_TTL,
    );
  } catch { /* non-fatal */ }
};

const deleteSessionCache = async (tokenHash) => {
  if (!redisClient) return;
  try {
    await redisClient.del(`session:${tokenHash}`);
  } catch { /* non-fatal */ }
};

// ---------------------------------------------------------------------------
// POST /api/auth/signup
// ---------------------------------------------------------------------------
export const signup = async (req, res, next) => {
  try {
    const { email, password, firstName, lastName } = req.body;

    if (!email || !password) {
      return res.status(400).json({ error: 'Email and password are required' });
    }

    if (password.length < 8) {
      return res.status(400).json({ error: 'Password must be at least 8 characters' });
    }

    // Check for existing user
    const existing = await findUserByEmail(email);
    if (existing) {
      return res.status(409).json({ error: 'An account with this email already exists' });
    }

    // Hash password and create user
    const passwordHash = await hashPassword(password);
    const { user, verificationToken } = await createUser({
      email,
      passwordHash,
      firstName: firstName || '',
      lastName: lastName || '',
    });

    // Assign default role if exists
    const defaultRole = await pool.query(
      "SELECT id FROM roles WHERE name = 'user' LIMIT 1",
    );
    if (defaultRole.rows.length > 0) {
      await pool.query(
        'INSERT INTO user_roles (user_id, role_id) VALUES ($1, $2) ON CONFLICT DO NOTHING',
        [user.id, defaultRole.rows[0].id],
      );
    }

    // TODO: Send verification email with verificationToken
    logger.info('Signup: verification email placeholder', {
      userId: user.id,
      verificationLink: `/api/auth/verify-email?token=${verificationToken}`,
    });

    return res.status(201).json({
      message: 'Account created. Please check your email to verify your address.',
      user: {
        id: user.id,
        email: user.email,
        firstName: user.first_name,
        lastName: user.last_name,
      },
    });
  } catch (err) {
    logger.error('Signup error', { error: err.message, stack: err.stack });
    next(err);
  }
};

// ---------------------------------------------------------------------------
// POST /api/auth/login
// ---------------------------------------------------------------------------
export const login = async (req, res, next) => {
  try {
    const { email, password } = req.body;

    if (!email || !password) {
      return res.status(400).json({ error: 'Email and password are required' });
    }

    // Find user
    const user = await findUserByEmail(email);
    if (!user) {
      return res.status(401).json({ error: 'Invalid credentials' });
    }

    if (!user.is_active) {
      return res.status(401).json({ error: 'Account deactivated' });
    }

    // Check lock
    if (user.locked_until && new Date(user.locked_until) > new Date()) {
      return res.status(423).json({ error: 'Account locked' });
    }

    // Verify password
    const passwordValid = await comparePassword(password, user.password_hash);

    if (!passwordValid) {
      const newAttempts = (user.failed_login_attempts || 0) + 1;

      if (newAttempts >= LOCK_THRESHOLD) {
        const lockedUntil = new Date(Date.now() + LOCK_DURATION_MS);
        await pool.query(
          'UPDATE users SET failed_login_attempts = $1, locked_until = $2 WHERE id = $3',
          [newAttempts, lockedUntil, user.id],
        );
        logger.warn('Account locked due to too many failed attempts', { email, userId: user.id });
      } else {
        await pool.query(
          'UPDATE users SET failed_login_attempts = $1 WHERE id = $2',
          [newAttempts, user.id],
        );
      }

      return res.status(401).json({ error: 'Invalid credentials' });
    }

    // Reset failed attempts, update last_login
    await pool.query(
      'UPDATE users SET failed_login_attempts = 0, locked_until = NULL, last_login = NOW() WHERE id = $1',
      [user.id],
    );

    // Get roles
    const rolesResult = await pool.query(
      `SELECT r.id, r.name, r.permissions
       FROM roles r
       INNER JOIN user_roles ur ON r.id = ur.role_id
       WHERE ur.user_id = $1`,
      [user.id],
    );

    const roles = rolesResult.rows.map((r) => ({
      id: r.id,
      name: r.name,
      permissions: r.permissions,
    }));

    // Generate tokens
    const accessToken = signAccessToken({
      userId: user.id,
      email: user.email,
      roles,
    });

    const tokenId = crypto.randomUUID();
    const refreshToken = signRefreshToken({
      userId: user.id,
      tokenId,
    });

    // Store session in DB
    const ip = req.ip;
    const userAgent = req.headers['user-agent'] || '';
    await createSession(user.id, refreshToken, ip, userAgent);

    // Cache session in Redis
    const userData = {
      id: user.id,
      email: user.email,
      firstName: user.first_name,
      lastName: user.last_name,
      roles,
      mustChangePassword: user.must_change_password,
      emailVerified: user.email_verified,
    };
    const accessHash = crypto.createHash('sha256').update(accessToken).digest('hex');
    await cacheSession(accessHash, userData);

    // Set httpOnly cookies
    setAccessCookie(res, accessToken);
    setRefreshCookie(res, refreshToken);

    // Build response — include mustChangePassword flag so the frontend
    // can redirect to the password-change form on first login.
    const loginResponse = {
      accessToken,
      user: userData,
    };

    if (user.must_change_password) {
      loginResponse.mustChangePassword = true;
    }

    return res.status(200).json(loginResponse);
  } catch (err) {
    logger.error('Login error', { error: err.message, stack: err.stack });
    next(err);
  }
};

// ---------------------------------------------------------------------------
// POST /api/auth/logout
// ---------------------------------------------------------------------------
export const logout = async (req, res) => {
  try {
    // Delete refresh session from DB
    const refreshToken = req.cookies?.refreshToken;
    if (refreshToken) {
      const tokenHashValue = hashToken(refreshToken);
      await pool.query('DELETE FROM sessions WHERE token_hash = $1', [tokenHashValue]);
    }

    // Delete access token session cache from Redis
    const accessToken = req.cookies?.accessToken
      || (req.headers.authorization?.startsWith('Bearer ') && req.headers.authorization.slice(7));
    if (accessToken) {
      const accessHash = crypto.createHash('sha256').update(accessToken).digest('hex');
      await deleteSessionCache(accessHash);
    }

    clearAuthCookies(res);
    return res.status(200).json({ message: 'Logged out successfully' });
  } catch (err) {
    logger.error('Logout error', { error: err.message });
    clearAuthCookies(res);
    return res.status(200).json({ message: 'Logged out successfully' });
  }
};

// ---------------------------------------------------------------------------
// POST /api/auth/refresh
// ---------------------------------------------------------------------------
export const refresh = async (req, res, next) => {
  try {
    const refreshToken = req.cookies?.refreshToken;

    if (!refreshToken) {
      return res.status(401).json({ error: 'Refresh token required' });
    }

    let decoded;
    try {
      decoded = verifyRefreshToken(refreshToken);
    } catch {
      clearAuthCookies(res);
      return res.status(401).json({ error: 'Invalid refresh token' });
    }

    // Find session by token hash
    const tokenHashValue = hashToken(refreshToken);
    const sessionResult = await pool.query(
      'SELECT * FROM sessions WHERE token_hash = $1',
      [tokenHashValue],
    );

    if (sessionResult.rows.length === 0) {
      clearAuthCookies(res);
      return res.status(401).json({ error: 'Invalid session' });
    }

    const session = sessionResult.rows[0];

    if (new Date(session.expires_at) < new Date()) {
      await pool.query('DELETE FROM sessions WHERE id = $1', [session.id]);
      clearAuthCookies(res);
      return res.status(401).json({ error: 'Session expired' });
    }

    // Rotate: delete old session
    await pool.query('DELETE FROM sessions WHERE id = $1', [session.id]);

    // Get user
    const user = await getUserWithRoles(decoded.userId);
    if (!user) {
      clearAuthCookies(res);
      return res.status(401).json({ error: 'User not found' });
    }

    // New tokens
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

    // Cache new session in Redis
    const accessHash = crypto.createHash('sha256').update(accessToken).digest('hex');
    await cacheSession(accessHash, user);

    setAccessCookie(res, accessToken);
    setRefreshCookie(res, newRefreshToken);

    return res.status(200).json({
      accessToken,
      user,
    });
  } catch (err) {
    logger.error('Refresh error', { error: err.message, stack: err.stack });
    next(err);
  }
};

// ---------------------------------------------------------------------------
// POST /api/auth/forgot-password
// ---------------------------------------------------------------------------
export const forgotPassword = async (req, res, next) => {
  try {
    const { email } = req.body;

    if (!email) {
      return res.status(400).json({ error: 'Email is required' });
    }

    // Always return success to prevent email enumeration
    const successMsg = 'If an account with that email exists, a reset link has been sent.';

    const user = await findUserByEmail(email);
    if (!user) {
      return res.status(200).json({ message: successMsg });
    }

    // Generate reset token
    const resetToken = crypto.randomBytes(32).toString('hex');
    const resetTokenHash = hashToken(resetToken);
    const resetExpires = new Date(Date.now() + 60 * 60 * 1000); // 1 hour

    await pool.query(
      'UPDATE users SET password_reset_token = $1, password_reset_expires = $2, updated_at = NOW() WHERE id = $3',
      [resetTokenHash, resetExpires, user.id],
    );

    // TODO: Send email with reset link
    logger.info('Forgot-password: email placeholder', {
      userId: user.id,
      resetLink: `/api/auth/reset-password?token=${resetToken}`,
    });

    return res.status(200).json({ message: successMsg });
  } catch (err) {
    logger.error('Forgot-password error', { error: err.message, stack: err.stack });
    next(err);
  }
};

// ---------------------------------------------------------------------------
// POST /api/auth/reset-password
// ---------------------------------------------------------------------------
export const resetPassword = async (req, res, next) => {
  try {
    const { token, newPassword } = req.body;

    if (!token || !newPassword) {
      return res.status(400).json({ error: 'Token and new password are required' });
    }

    if (newPassword.length < 8) {
      return res.status(400).json({ error: 'Password must be at least 8 characters' });
    }

    const tokenHashValue = hashToken(token);

    const result = await pool.query(
      `SELECT id FROM users
       WHERE password_reset_token = $1
         AND password_reset_expires > NOW()
         AND is_active = true`,
      [tokenHashValue],
    );

    if (result.rows.length === 0) {
      return res.status(400).json({ error: 'Invalid or expired reset token' });
    }

    const userId = result.rows[0].id;
    const newHash = await hashPassword(newPassword);

    await updatePassword(userId, newHash);

    // Clear reset token fields
    await pool.query(
      'UPDATE users SET password_reset_token = NULL, password_reset_expires = NULL WHERE id = $1',
      [userId],
    );

    // Invalidate all existing sessions
    await pool.query('DELETE FROM sessions WHERE user_id = $1', [userId]);

    return res.status(200).json({ message: 'Password has been reset successfully' });
  } catch (err) {
    logger.error('Reset-password error', { error: err.message, stack: err.stack });
    next(err);
  }
};

// ---------------------------------------------------------------------------
// GET /api/auth/verify-email?token=xxx
// ---------------------------------------------------------------------------
export const verifyEmail = async (req, res, next) => {
  try {
    const { token } = req.query;

    if (!token) {
      return res.status(400).json({ error: 'Verification token is required' });
    }

    const tokenHashValue = hashToken(token);

    const result = await pool.query(
      `UPDATE users
       SET email_verified = true,
           email_verify_token = NULL,
           updated_at = NOW()
       WHERE email_verify_token = $1
         AND is_active = true
       RETURNING id, email`,
      [tokenHashValue],
    );

    if (result.rows.length === 0) {
      return res.status(400).json({ error: 'Invalid or expired verification token' });
    }

    logger.info('Email verified', { userId: result.rows[0].id, email: result.rows[0].email });

    return res.status(200).json({ message: 'Email verified successfully' });
  } catch (err) {
    logger.error('Verify-email error', { error: err.message, stack: err.stack });
    next(err);
  }
};

// ---------------------------------------------------------------------------
// GET /api/auth/me
// ---------------------------------------------------------------------------
export const me = (req, res) => {
  return res.status(200).json(req.user);
};

// ---------------------------------------------------------------------------
// POST /api/auth/change-password
// ---------------------------------------------------------------------------
export const changePassword = async (req, res, next) => {
  try {
    const { currentPassword, newPassword, confirmPassword } = req.body;

    if (!currentPassword || !newPassword || !confirmPassword) {
      return res.status(400).json({ error: 'Current password, new password, and confirmation are required' });
    }

    if (newPassword === currentPassword) {
      return res.status(400).json({ error: 'New password must be different from current password' });
    }

    if (newPassword !== confirmPassword) {
      return res.status(400).json({ error: 'New password and confirmation do not match' });
    }

    if (newPassword.length < 8) {
      return res.status(400).json({ error: 'Password must be at least 8 characters' });
    }

    // Verify current password
    const userResult = await pool.query(
      'SELECT id, password_hash FROM users WHERE id = $1',
      [req.user.id],
    );

    if (userResult.rows.length === 0) {
      return res.status(401).json({ error: 'User not found' });
    }

    const user = userResult.rows[0];
    const passwordValid = await comparePassword(currentPassword, user.password_hash);

    if (!passwordValid) {
      return res.status(401).json({ error: 'Current password is incorrect' });
    }

    // Update password
    const newHash = await hashPassword(newPassword);
    await updatePassword(req.user.id, newHash);

    // Invalidate other sessions (keep current)
    const refreshToken = req.cookies?.refreshToken;
    if (refreshToken) {
      const currentHash = hashToken(refreshToken);
      await pool.query(
        'DELETE FROM sessions WHERE user_id = $1 AND token_hash != $2',
        [req.user.id, currentHash],
      );
    } else {
      await pool.query(
        'DELETE FROM sessions WHERE user_id = $1',
        [req.user.id],
      );
    }

    return res.status(200).json({ message: 'Password changed successfully' });
  } catch (err) {
    logger.error('Change password error', { error: err.message, stack: err.stack });
    next(err);
  }
};

export default {
  signup,
  login,
  logout,
  refresh,
  me,
  changePassword,
  forgotPassword,
  resetPassword,
  verifyEmail,
};
