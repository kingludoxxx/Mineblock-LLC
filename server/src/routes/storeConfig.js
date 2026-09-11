// STORE CONFIG ROUTES
//   GET /api/v1/store-config  — session required; the non-secret store snapshot
//                               (storeConfig.snapshot()), plus `switcher`, the
//                               per-SESSION store list the hub signed (W6).
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

// W6 — the sidebar's store switcher.
//   snapshot() is pure env (R7, read per request) and carries `hub`.
//   `switcher` cannot live there: the store LIST belongs to the session, not to the deployment. It is what the
//   hub SIGNED into the SSO ticket this session was opened with, parked on the session row by the exchange and
//   put on req.user by authenticate. It is NEVER read from the request: a client that sends its own list, in a
//   header, a query or a body, changes nothing here.
//   No hub / a local login -> stores: [] and the sidebar stays the plain brand block it is today (R21).
router.get('/store-config', authenticate, (req, res) => {
  res.set('Cache-Control', 'no-store');
  const snapshot = storeConfig.snapshot();
  res.json({
    success: true,
    data: {
      ...snapshot,
      switcher: {
        current: snapshot.storeCode,
        stores: Array.isArray(req.user?.hubStores) ? req.user.hubStores : [],
      },
    },
  });
});

export default router;
