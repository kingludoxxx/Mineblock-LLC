import crypto from 'crypto';
import { verifyAccessToken } from '../utils/jwt.js';
import pool from '../config/db.js';
import logger from '../utils/logger.js';

// ---------------------------------------------------------------------------
// Redis import — another agent creates db/redis.js; gracefully degrade if
// the module is not yet present or Redis is unavailable.
// ---------------------------------------------------------------------------
let redisClient = null;
try {
  const redis = await import('../../db/redis.js');
  redisClient = redis.default || redis.client || null;
} catch {
  logger.warn('Redis module not available — auth middleware will skip session cache');
}

const SESSION_TTL = 300; // 5 minutes in seconds

/**
 * Hash a token to use as a Redis cache key.
 */
const tokenHash = (token) =>
  crypto.createHash('sha256').update(token).digest('hex');

/**
 * Try to get a cached session from Redis.
 * Returns parsed user object or null.
 */
const getCachedSession = async (hash) => {
  if (!redisClient) return null;
  try {
    const data = await redisClient.get(`session:${hash}`);
    return data ? JSON.parse(data) : null;
  } catch {
    return null;
  }
};

/**
 * Store session in Redis with a 5-minute TTL.
 */
const cacheSession = async (hash, userObj) => {
  if (!redisClient) return;
  try {
    await redisClient.set(`session:${hash}`, JSON.stringify(userObj), 'EX', SESSION_TTL);
  } catch {
    // non-fatal
  }
};

/**
 * Express middleware — authenticates the request via JWT.
 *
 * 1. Extract token from httpOnly cookie OR Authorization header.
 * 2. Check Redis session cache (key: session:<tokenHash>).
 * 3. On cache miss, verify JWT, query DB for user+roles, then cache result.
 * 4. Attach user to req.user.
 * 5. Handle expired tokens gracefully.
 */
export const authenticate = async (req, res, next) => {
  try {
    // ---- 1. Extract token ------------------------------------------------
    let token = req.cookies?.accessToken || null;

    if (!token) {
      const authHeader = req.headers.authorization;
      if (authHeader) {
        const parts = authHeader.split(' ');
        if (parts.length === 2 && parts[0] === 'Bearer') {
          token = parts[1];
        }
      }
    }

    if (!token) {
      return res.status(401).json({ error: 'Authentication required' });
    }

    // ---- 2. Redis cache check --------------------------------------------
    const hash = tokenHash(token);
    const cached = await getCachedSession(hash);

    if (cached) {
      req.user = cached;
      return next();
    }

    // ---- 3. Verify JWT ---------------------------------------------------
    let decoded;
    try {
      decoded = verifyAccessToken(token);
    } catch (err) {
      if (err.name === 'TokenExpiredError') {
        return res.status(401).json({ error: 'Token expired', code: 'TOKEN_EXPIRED' });
      }
      logger.warn('Invalid access token', { error: err.message });
      return res.status(401).json({ error: 'Authentication required' });
    }

    // ---- 4. Query DB for user + roles ------------------------------------
    const result = await pool.query(
      `SELECT
         u.id, u.email, u.first_name, u.last_name,
         u.must_change_password, u.email_verified,
         json_agg(
           json_build_object('id', r.id, 'name', r.name, 'permissions', r.permissions)
         ) FILTER (WHERE r.id IS NOT NULL) AS roles
       FROM users u
       LEFT JOIN user_roles ur ON u.id = ur.user_id
       LEFT JOIN roles r ON ur.role_id = r.id
       WHERE u.id = $1 AND u.is_active = true
       GROUP BY u.id`,
      [decoded.userId],
    );

    if (result.rows.length === 0) {
      return res.status(401).json({ error: 'Authentication required' });
    }

    const row = result.rows[0];
    const userObj = {
      id: row.id,
      email: row.email,
      firstName: row.first_name,
      lastName: row.last_name,
      roles: row.roles || [],
      mustChangePassword: row.must_change_password,
      emailVerified: row.email_verified,
    };

    // ---- 5. Cache in Redis -----------------------------------------------
    await cacheSession(hash, userObj);

    req.user = userObj;
    next();
  } catch (err) {
    logger.error('Authentication error', { error: err.message });
    return res.status(401).json({ error: 'Authentication required' });
  }
};

export default authenticate;
