import { Router } from 'express';
import { pgQuery, isDbCircuitOpen } from '../db/pg.js';
import redis from '../db/redis.js';

const router = Router();

router.get('/', async (req, res) => {
  // Database check
  let dbStatus = 'ok';
  let dbLatencyMs = null;
  try {
    if (isDbCircuitOpen()) {
      dbStatus = 'circuit_open';
    } else {
      const start = Date.now();
      await pgQuery('SELECT 1');
      dbLatencyMs = Date.now() - start;
    }
  } catch {
    dbStatus = 'error';
  }

  // Redis check
  let redisStatus = 'ok';
  let redisLatencyMs = null;
  try {
    const start = Date.now();
    await redis.ping();
    redisLatencyMs = Date.now() - start;
  } catch {
    redisStatus = 'error';
  }

  // Redis is intentionally unprovisioned (`render.yaml:27` sets REDIS_URL="")
  // — the app degrades gracefully to in-memory. A missing Redis MUST NOT flip
  // the health endpoint to 503, because Render's own health probe reads 503
  // as "app dead" and kills the pod every ~30-40 min, producing 502 storms
  // across every endpoint (queue, generate, transcribe) during each cycle.
  //
  // Only DB failure warrants 503. Redis status is reported in the body so
  // the trap remains visible if we ever add a real Redis and it goes down.
  const overall = dbStatus === 'ok'
    ? (redisStatus === 'ok' ? 'healthy' : 'healthy_redis_degraded')
    : 'unhealthy';
  const httpCode = dbStatus === 'ok' ? 200 : 503;

  res.status(httpCode).json({
    success: dbStatus === 'ok',
    data: {
      status: overall,
      uptime: process.uptime(),
      timestamp: new Date().toISOString(),
      database: {
        status: dbStatus,
        latencyMs: dbLatencyMs,
      },
      redis: {
        status: redisStatus,
        latencyMs: redisLatencyMs,
      },
    },
  });
});

export default router;
