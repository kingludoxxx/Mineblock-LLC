import Redis from 'ioredis';
import env from '../config/env.js';
import logger from '../utils/logger.js';

// ---------------------------------------------------------------------------
// Redis client
// ---------------------------------------------------------------------------

const redis = new Redis(env.REDIS_URL, {
  maxRetriesPerRequest: 3,
  retryStrategy(times) {
    if (times > 10) return null; // stop retrying
    return Math.min(times * 200, 5000);
  },
  lazyConnect: true,          // we'll connect explicitly in server.js
  enableReadyCheck: true,
});

redis.on('error', (err) => {
  logger.error(`Redis error: ${err.message}`);
});

redis.on('connect', () => {
  logger.info('Redis connected');
});

// ---------------------------------------------------------------------------
// Session helpers  (prefix: sess:)
// ---------------------------------------------------------------------------

const SESSION_TTL = 300; // 5 minutes

/**
 * Retrieve a session by key.
 * @param {string} key
 * @returns {Promise<object|null>}
 */
export async function getSession(key) {
  try {
    const raw = await redis.get(`session:${key}`);
    return raw ? JSON.parse(raw) : null;
  } catch (err) {
    logger.error(`getSession error: ${err.message}`);
    return null;
  }
}

/**
 * Store a session with a default 5-minute TTL.
 * @param {string} key
 * @param {object} data
 * @param {number} [ttl=300] — seconds
 */
export async function setSession(key, data, ttl = SESSION_TTL) {
  try {
    await redis.set(`session:${key}`, JSON.stringify(data), 'EX', ttl);
  } catch (err) {
    logger.error(`setSession error: ${err.message}`);
  }
}

/**
 * Delete a session.
 * @param {string} key
 */
export async function deleteSession(key) {
  try {
    await redis.del(`session:${key}`);
  } catch (err) {
    logger.error(`deleteSession error: ${err.message}`);
  }
}

// ---------------------------------------------------------------------------
// Rate limiting  (prefix: rl:)
// ---------------------------------------------------------------------------

/**
 * Simple sliding-window rate limiter using INCR + EXPIRE.
 *
 * @param {string} key        — e.g. ip address or user id
 * @param {number} limit      — max requests allowed in the window
 * @param {number} windowSec  — window size in seconds
 * @returns {Promise<{allowed: boolean, remaining: number, total: number}>}
 */
export async function rateLimit(key, limit, windowSec) {
  try {
    const redisKey = `rl:${key}`;
    const current = await redis.incr(redisKey);
    if (current === 1) {
      await redis.expire(redisKey, windowSec);
    }
    return {
      allowed: current <= limit,
      remaining: Math.max(0, limit - current),
      total: current,
    };
  } catch (err) {
    logger.error(`rateLimit error: ${err.message}`);
    // Fail open — allow the request if Redis is down
    return { allowed: true, remaining: limit, total: 0 };
  }
}

// ---------------------------------------------------------------------------
// Cache helpers  (prefix: cache:)
// ---------------------------------------------------------------------------

/**
 * Get a cached value.
 * @param {string} key
 * @returns {Promise<any|null>}
 */
export async function cacheGet(key) {
  try {
    const raw = await redis.get(`cache:${key}`);
    return raw ? JSON.parse(raw) : null;
  } catch (err) {
    logger.error(`cacheGet error: ${err.message}`);
    return null;
  }
}

/**
 * Set a cached value.
 * @param {string} key
 * @param {any}    value
 * @param {number} [ttlSec=300] — seconds
 */
export async function cacheSet(key, value, ttlSec = 300) {
  try {
    await redis.set(`cache:${key}`, JSON.stringify(value), 'EX', ttlSec);
  } catch (err) {
    logger.error(`cacheSet error: ${err.message}`);
  }
}

/**
 * Delete a single cache key.
 * @param {string} key
 */
export async function cacheDel(key) {
  try {
    await redis.del(`cache:${key}`);
  } catch (err) {
    logger.error(`cacheDel error: ${err.message}`);
  }
}

/**
 * Delete all cache keys matching a glob pattern.
 * Uses SCAN so it won't block the server on large keyspaces.
 * @param {string} pattern — e.g. "workspace:*"
 */
export async function cacheDelPattern(pattern) {
  try {
    const fullPattern = `cache:${pattern}`;
    let cursor = '0';
    do {
      const [nextCursor, keys] = await redis.scan(cursor, 'MATCH', fullPattern, 'COUNT', 100);
      cursor = nextCursor;
      if (keys.length > 0) {
        await redis.del(...keys);
      }
    } while (cursor !== '0');
  } catch (err) {
    logger.error(`cacheDelPattern error: ${err.message}`);
  }
}

export default redis;
