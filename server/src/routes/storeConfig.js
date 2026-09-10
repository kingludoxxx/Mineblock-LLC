// STORE CONFIG ROUTES
//   GET /api/v1/store-config  — session required; the non-secret store snapshot
//                               (storeConfig.snapshot()). Never cached.
//   GET /api/v1/brand         — PUBLIC; brand identity for the client shell
//                               (name, short name, logos, email domain) read
//                               from env BRAND_* at request time. Unset keys
//                               are null and the client keeps its build-time
//                               fallback. Nothing secret is reachable from
//                               either handler: they only call getters whose
//                               output is scanned in server/tests/store-config.
import { Router } from 'express';
import { authenticate } from '../middleware/auth.js';
import storeConfig from '../config/storeConfig.js';

const router = Router();

router.get('/brand', (_req, res) => {
  res.set('Cache-Control', 'public, max-age=60');
  res.json({ success: true, data: storeConfig.brand() });
});

router.get('/store-config', authenticate, (_req, res) => {
  res.set('Cache-Control', 'no-store');
  res.json({ success: true, data: storeConfig.snapshot() });
});

export default router;
