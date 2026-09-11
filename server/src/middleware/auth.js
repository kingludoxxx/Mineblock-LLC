import crypto from 'crypto';
import { verifyAccessToken } from '../utils/jwt.js';
import pool from '../config/db.js';
import logger from '../utils/logger.js';
import { peekHubSsoClaims, loadHubSession } from '../services/hubSession.js';

// ---------------------------------------------------------------------------
// Redis import — another agent creates db/redis.js; gracefully degrade if
// the module is not yet present or Redis is unavailable.
// ---------------------------------------------------------------------------
let redisClient = null;
try {
  const redis = await import('../db/redis.js');
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

// Maximum ms to wait for Redis before falling through to DB query.
// ioredis offline queue can hang for up to 3×5000ms when Redis is down —
// this timeout ensures a Redis outage never stalls every authenticated request.
const REDIS_TIMEOUT_MS = 300;

/**
 * Try to get a cached session from Redis.
 * Fails fast (300 ms) so a Redis outage doesn't stall every request.
 * Returns parsed user object or null.
 */
const getCachedSession = async (hash) => {
  if (!redisClient) return null;
  try {
    const redisPromise = redisClient.get(`session:${hash}`);
    const timeoutPromise = new Promise((_, reject) =>
      setTimeout(() => reject(new Error('Redis timeout')), REDIS_TIMEOUT_MS)
    );
    const data = await Promise.race([redisPromise, timeoutPromise]);
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
    // Hub-SSO sessions (services/hubSession.js) opt OUT of the cache: a revoked session must be refused on the very
    // next request, not up to SESSION_TTL later. The peek is unverified and only ever routes onto the STRICTER path.
    const hubSso = peekHubSsoClaims(token);
    const hash = tokenHash(token);
    const cached = hubSso ? null : await getCachedSession(hash);

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

    // Hub-SSO session: the sessions row must still be there. Deleting it (logout, "log out other devices", an admin
    // revoke, or the hub removing the operator) ends the session on this request, with no grace window.
    // The same read returns the switcher list this session arrived with (W6) — one query, both answers.
    let hubSession = null;
    if (hubSso) {
      hubSession = await loadHubSession(decoded.sid, decoded.userId);
      if (!hubSession) {
        logger.warn('Hub SSO session revoked', { userId: decoded.userId });
        return res.status(401).json({ error: 'Authentication required' });
      }
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
      // W6: [] for a local login — a store with no hub behind it shows no switcher, it does not break (R21).
      hubStores: Array.isArray(hubSession?.hub_stores) ? hubSession.hub_stores : [],
    };

    // ---- 5. Cache in Redis (never for a hub-SSO session) -------------------
    if (!hubSso) await cacheSession(hash, userObj);

    req.user = userObj;
    next();
  } catch (err) {
    logger.error('Authentication error', { error: err.message });
    return res.status(401).json({ error: 'Authentication required' });
  }
};

export default authenticate;
