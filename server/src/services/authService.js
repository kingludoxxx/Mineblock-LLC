import crypto from 'crypto';
import pool from '../config/db.js';
import { signAccessToken, signRefreshToken, verifyAccessToken, verifyRefreshToken } from '../utils/jwt.js';
import { hashPassword, comparePassword } from '../utils/hash.js';
import logger from '../utils/logger.js';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

export const hashToken = (token) => {
  return crypto.createHash('sha256').update(token).digest('hex');
};

// ---------------------------------------------------------------------------
// User queries
// ---------------------------------------------------------------------------

export const findUserByEmail = async (email) => {
  const result = await pool.query(
    'SELECT * FROM users WHERE email = $1',
    [email.toLowerCase().trim()],
  );
  return result.rows[0] || null;
};

export const createUser = async ({ email, passwordHash, firstName, lastName }) => {
  const verificationToken = crypto.randomBytes(32).toString('hex');
  const verificationExpires = new Date(Date.now() + 24 * 60 * 60 * 1000); // 24 h

  const result = await pool.query(
    `INSERT INTO users
       (email, password_hash, first_name, last_name, email_verification_token, email_verification_expires, is_active)
     VALUES ($1, $2, $3, $4, $5, $6, true)
     RETURNING *`,
    [
      email.toLowerCase().trim(),
      passwordHash,
      firstName,
      lastName,
      hashToken(verificationToken),
      verificationExpires,
    ],
  );

  return { user: result.rows[0], verificationToken };
};

export const getUserWithRoles = async (userId) => {
  const result = await pool.query(
    `SELECT
       u.id,
       u.email,
       u.first_name,
       u.last_name,
       u.must_change_password,
       u.email_verified,
       json_agg(
         json_build_object('id', r.id, 'name', r.name, 'permissions', r.permissions)
       ) FILTER (WHERE r.id IS NOT NULL) AS roles
     FROM users u
     LEFT JOIN user_roles ur ON u.id = ur.user_id
     LEFT JOIN roles r ON ur.role_id = r.id
     WHERE u.id = $1 AND u.is_active = true
     GROUP BY u.id`,
    [userId],
  );

  if (result.rows.length === 0) return null;

  const row = result.rows[0];
  return {
    id: row.id,
    email: row.email,
    firstName: row.first_name,
    lastName: row.last_name,
    roles: row.roles || [],
    mustChangePassword: row.must_change_password,
    emailVerified: row.email_verified,
  };
};

// ---------------------------------------------------------------------------
// Password helpers
// ---------------------------------------------------------------------------

export const updatePassword = async (userId, newPasswordHash) => {
  await pool.query(
    'UPDATE users SET password_hash = $1, must_change_password = false, updated_at = NOW() WHERE id = $2',
    [newPasswordHash, userId],
  );
};

// ---------------------------------------------------------------------------
// Sessions
// ---------------------------------------------------------------------------

export const createSession = async (userId, refreshToken, ip, userAgent) => {
  const hash = hashToken(refreshToken);
  const expiresAt = new Date(Date.now() + 7 * 24 * 60 * 60 * 1000);

  const result = await pool.query(
    `INSERT INTO sessions (user_id, token_hash, ip_address, user_agent, expires_at)
     VALUES ($1, $2, $3, $4, $5)
     RETURNING *`,
    [userId, hash, ip, userAgent, expiresAt],
  );

  return result.rows[0];
};

// ---------------------------------------------------------------------------
// Re-exports for convenience
// ---------------------------------------------------------------------------

export {
  signAccessToken,
  signRefreshToken,
  verifyAccessToken,
  verifyRefreshToken,
  hashPassword,
  comparePassword,
};

export default {
  hashToken,
  getUserWithRoles,
  createSession,
  findUserByEmail,
  createUser,
  updatePassword,
};
