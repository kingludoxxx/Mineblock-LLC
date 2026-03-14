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

  const overall = dbStatus === 'ok' && redisStatus === 'ok' ? 'healthy' : 'degraded';
  const httpCode = overall === 'healthy' ? 200 : 503;

  res.status(httpCode).json({
    success: overall === 'healthy',
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
