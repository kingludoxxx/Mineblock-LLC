import rateLimit from 'express-rate-limit';
import logger from '../utils/logger.js';

// ---------------------------------------------------------------------------
// Redis import — gracefully degrade to in-memory if unavailable
// ---------------------------------------------------------------------------
let redisClient = null;
try {
  const redis = await import('../../db/redis.js');
  redisClient = redis.default || redis.client || null;
} catch {
  logger.warn('Redis module not available — rate limiter will use in-memory fallback');
}

// ---------------------------------------------------------------------------
// In-memory fallback store (Map-based, with periodic cleanup)
// ---------------------------------------------------------------------------
const memoryStore = new Map();
const CLEANUP_INTERVAL = 60_000; // 1 minute

setInterval(() => {
  const now = Date.now();
  for (const [key, entry] of memoryStore) {
    if (entry.expiresAt <= now) {
      memoryStore.delete(key);
    }
  }
}, CLEANUP_INTERVAL).unref();

// ---------------------------------------------------------------------------
// Sliding-window rate-limit check (Redis with in-memory fallback)
//
// Returns: { allowed: boolean, remaining: number, retryAfter: number }
//   - allowed    — true if request is permitted
//   - remaining  — how many requests are left in the window
//   - retryAfter — seconds until the window resets (0 if allowed)
// ---------------------------------------------------------------------------
async function checkRateLimit(key, maxRequests, windowSec) {
  // ---------- Redis path --------------------------------------------------
  if (redisClient) {
    try {
      const redisKey = `rl:${key}`;
      const current = await redisClient.incr(redisKey);

      if (current === 1) {
        await redisClient.expire(redisKey, windowSec);
      }

      const ttl = await redisClient.ttl(redisKey);
      const retryAfter = ttl > 0 ? ttl : windowSec;

      if (current > maxRequests) {
        return { allowed: false, remaining: 0, retryAfter };
      }

      return { allowed: true, remaining: maxRequests - current, retryAfter: 0 };
    } catch (err) {
      logger.warn('Redis rate-limit error, falling through to memory', { error: err.message });
      // fall through to in-memory
    }
  }

  // ---------- In-memory fallback ------------------------------------------
  const now = Date.now();
  const windowMs = windowSec * 1000;

  let entry = memoryStore.get(key);
  if (!entry || entry.expiresAt <= now) {
    entry = { count: 0, expiresAt: now + windowMs };
    memoryStore.set(key, entry);
  }

  entry.count += 1;

  if (entry.count > maxRequests) {
    const retryAfter = Math.ceil((entry.expiresAt - now) / 1000);
    return { allowed: false, remaining: 0, retryAfter };
  }

  return { allowed: true, remaining: maxRequests - entry.count, retryAfter: 0 };
}

// ---------------------------------------------------------------------------
// Middleware factories
// ---------------------------------------------------------------------------

/**
 * Auth endpoints: 10 requests per 15 minutes per IP.
 */
export function authRateLimiter(req, res, next) {
  const ip = req.ip || req.socket.remoteAddress || 'unknown';
  const key = `auth:${ip}`;

  checkRateLimit(key, 10, 15 * 60).then(({ allowed, remaining, retryAfter }) => {
    res.set('X-RateLimit-Remaining', String(remaining));

    if (!allowed) {
      res.set('Retry-After', String(retryAfter));
      return res.status(429).json({
        success: false,
        error: { message: 'Too many requests. Please try again after 15 minutes.' },
      });
    }

    next();
  }).catch((err) => {
    logger.error('Rate limiter error', { error: err.message });
    next(); // fail open
  });
}

/**
 * API endpoints: 100 requests per minute per user (falls back to IP if
 * the user is not authenticated).
 */
export function apiRateLimiter(req, res, next) {
  const identifier = req.user?.id || req.ip || req.socket.remoteAddress || 'unknown';
  const key = `api:${identifier}`;

  checkRateLimit(key, 100, 60).then(({ allowed, remaining, retryAfter }) => {
    res.set('X-RateLimit-Remaining', String(remaining));

    if (!allowed) {
      res.set('Retry-After', String(retryAfter));
      return res.status(429).json({
        success: false,
        error: { message: 'Too many requests. Please try again later.' },
      });
    }

    next();
  }).catch((err) => {
    logger.error('Rate limiter error', { error: err.message });
    next(); // fail open
  });
}

// ---------------------------------------------------------------------------
// Legacy express-rate-limit exports (kept for backward compat with app.js)
// ---------------------------------------------------------------------------
export const loginLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 10,
  standardHeaders: true,
  legacyHeaders: false,
  message: {
    success: false,
    error: { message: 'Too many login attempts. Please try again after 15 minutes.' },
  },
});

export const apiLimiter = rateLimit({
  windowMs: 60 * 1000,
  max: 100,
  standardHeaders: true,
  legacyHeaders: false,
  message: {
    success: false,
    error: { message: 'Too many requests. Please try again later.' },
  },
});

export { checkRateLimit };
