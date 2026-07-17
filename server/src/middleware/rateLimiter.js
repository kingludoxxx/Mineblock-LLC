import rateLimit from 'express-rate-limit';
import logger from '../utils/logger.js';

// ---------------------------------------------------------------------------
// Redis import — gracefully degrade to in-memory if unavailable
// ---------------------------------------------------------------------------
let redisClient = null;
try {
  const redis = await import('../db/redis.js');
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
 * Auth endpoints: 25 failed attempts per 15 minutes per IP.
 *
 * Only FAILED attempts (4xx/5xx) count against the budget. A user typing
 * their password right on attempt 26 should get through — the limiter is
 * anti-brute-force, not anti-user. On a successful response we decrement
 * the counter via a `res.on('finish', ...)` hook.
 *
 * (Prior version counted every hit at 10/15min, so a wave of legitimate
 * hits — refresh, page navigation, a couple of typos — locked the
 * operator out for 15 minutes. Refresh has since been moved to the
 * general API limiter; this covers the residual case.)
 */
const AUTH_LIMIT = 25;
const AUTH_WINDOW_SEC = 15 * 60;

export function authRateLimiter(req, res, next) {
  const ip = req.ip || req.socket.remoteAddress || 'unknown';
  const key = `auth:${ip}`;

  checkRateLimit(key, AUTH_LIMIT, AUTH_WINDOW_SEC).then(({ allowed, remaining, retryAfter }) => {
    res.set('X-RateLimit-Remaining', String(remaining));

    if (!allowed) {
      res.set('Retry-After', String(retryAfter));
      return res.status(429).json({
        success: false,
        error: { message: 'Too many failed attempts. Please try again after 15 minutes.' },
      });
    }

    // Uncount on success: if the response ends 2xx, roll back the increment
    // we just did so a legitimate login doesn't eat into the budget.
    res.on('finish', () => {
      if (res.statusCode >= 200 && res.statusCode < 300) {
        _decrementCounter(key);
      }
    });

    next();
  }).catch((err) => {
    logger.error('Rate limiter error', { error: err.message });
    next(); // fail open
  });
}

// Roll back a successful auth's counter increment.  Best-effort — Redis
// path uses DECR; in-memory path mutates the Map entry directly.  Never
// throws (limiter must never break the auth response).
async function _decrementCounter(key) {
  try {
    if (redisClient) {
      const redisKey = `rl:${key}`;
      const val = await redisClient.decr(redisKey);
      if (val <= 0) await redisClient.del(redisKey);
      return;
    }
    const entry = memoryStore.get(key);
    if (entry && entry.count > 0) entry.count -= 1;
  } catch (err) {
    logger.warn('Rate-limit decrement failed (non-fatal)', { error: err.message });
  }
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
