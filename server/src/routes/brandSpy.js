/**
 * Brand Spy proxy route
 * Forwards all /api/v1/brand-spy/* requests to the brand-spy-api service.
 * Keeps the frontend on a single origin — no CORS issues.
 * Uses Node 18+ native fetch (no extra dependency needed).
 */
import express from 'express';

const router = express.Router();

const BRAND_SPY_API = process.env.BRAND_SPY_API_URL || 'https://brand-spy-api.onrender.com';

router.all('/*', async (req, res) => {
  try {
    const url = `${BRAND_SPY_API}/api/brand-spy${req.path}`;
    const queryString = new URLSearchParams(req.query).toString();
    const fullUrl = queryString ? `${url}?${queryString}` : url;

    const options = {
      method: req.method,
      headers: { 'Content-Type': 'application/json' },
    };

    if (['POST', 'PUT', 'PATCH'].includes(req.method) && req.body) {
      options.body = JSON.stringify(req.body);
    }

    const upstream = await fetch(fullUrl, options);
    const data = await upstream.json().catch(() => ({}));
    res.status(upstream.status).json(data);
  } catch (err) {
    console.error('[brand-spy proxy]', err);
    res.status(502).json({ error: 'Brand Spy service unavailable' });
  }
});

export default router;
