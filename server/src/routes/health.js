import { Router } from 'express';
import { query } from '../config/db.js';

const router = Router();

router.get('/', (req, res) => {
  res.json({
    success: true,
    data: {
      status: 'ok',
      uptime: process.uptime(),
      timestamp: new Date().toISOString(),
    },
  });
});

router.get('/deep', async (req, res, next) => {
  try {
    const dbStart = Date.now();
    await query('SELECT 1');
    const dbLatencyMs = Date.now() - dbStart;

    const memoryUsage = process.memoryUsage();

    res.json({
      success: true,
      data: {
        status: 'ok',
        uptime: process.uptime(),
        timestamp: new Date().toISOString(),
        database: {
          connected: true,
          latencyMs: dbLatencyMs,
        },
        memory: {
          rss: `${Math.round(memoryUsage.rss / 1024 / 1024)} MB`,
          heapUsed: `${Math.round(memoryUsage.heapUsed / 1024 / 1024)} MB`,
          heapTotal: `${Math.round(memoryUsage.heapTotal / 1024 / 1024)} MB`,
        },
      },
    });
  } catch (err) {
    res.status(503).json({
      success: false,
      data: {
        status: 'degraded',
        uptime: process.uptime(),
        timestamp: new Date().toISOString(),
        database: {
          connected: false,
          error: err.message,
        },
      },
    });
  }
});

export default router;
