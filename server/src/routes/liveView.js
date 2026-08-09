// Live View — authed real-time surface (SELF-CONTAINED, NEW FILE).
//
// Follows the repo's route+permission pattern (funnelAnalytics.js):
//   router.use(authenticate, requirePermission('funnels', 'access'))
//
// PERMISSION — DECISION MADE, same reasoning funnelAnalytics.js recorded:
// reuse 'funnels':'access' instead of minting a new RBAC permission via a
// shared-seed migration. Watching live funnel traffic is a sub-capability of
// the funnel surface; to split it out later, change the one line below.
//
// ⚠️ INTEGRATION HOOK — routes/index.js carries the one-line mount:
//     app.use('/api/v1/live', liveViewRoutes);
//
// Endpoints:
//   GET /snapshot        → initial state (buildLiveSnapshot). ?limit=1..200.
//   GET /stream          → SSE. Poll-backed hub (liveViewHub.js): "snapshot"
//                          ~every 3s, "events" deltas, ": keepalive" comments.
//                          Per-process connection cap → 503 when full.
//
// READ-ONLY — like funnelAnalytics.js there is no POST/PUT/PATCH/DELETE and
// there must never be. Reads go through the ISOLATED analytics pool
// (analyticsDb.js): a slow live board can never starve the money path's
// shared pool or trip its circuit breaker.
import { Router } from 'express';
import { authenticate } from '../middleware/auth.js';
import { requirePermission } from '../middleware/rbac.js';
import {
  buildLiveSnapshot,
  DEFAULT_EVENT_LIMIT,
  MAX_EVENT_LIMIT,
} from '../services/liveViewQueries.js';
import { subscribe, LIVE_VIEW_LIMITS } from '../services/liveViewHub.js';

const router = Router();
router.use(authenticate, requirePermission('funnels', 'access'));

// ?limit must be a plain positive integer within bounds. Anything else is the
// caller's fault: 400, named error, nothing leaks.
function parseLimit(raw) {
  if (raw === undefined) return { limit: DEFAULT_EVENT_LIMIT };
  if (!/^\d{1,4}$/.test(String(raw))) return { error: 'invalid_limit' };
  const n = Number(raw);
  if (n < 1 || n > MAX_EVENT_LIMIT) return { error: 'invalid_limit' };
  return { limit: n };
}

/**
 * GET /snapshot?limit — the board's initial state:
 * {as_of, live_total, unique_today_total, checkout_starts_today,
 *  purchases_today, revenue_today, by_funnel[], events[], geo, basis,
 *  warnings[], degraded}.
 *
 * geo.available is false ON PURPOSE: we store salted IP hashes, capture no
 * edge geo headers, and never fabricate locations (see liveViewQueries.js).
 */
router.get('/snapshot', async (req, res, next) => {
  try {
    const parsed = parseLimit(req.query.limit);
    if (parsed.error) return res.status(400).json({ error: parsed.error });
    res.json(await buildLiveSnapshot({ limit: parsed.limit }));
  } catch (err) {
    next(err);
  }
});

// The JWT's exp claim, in ms — authenticate has ALREADY verified the token's
// signature; this only re-reads the payload of that same (verified) token so
// the hub can end the stream when it lapses (review M4). Never a verification
// path of its own: an unreadable exp yields null (no mid-stream cutoff), it
// never grants access.
function tokenExpMs(req) {
  const header = req.headers.authorization || '';
  const parts = header.split(' ');
  const token = req.cookies?.accessToken
    || (parts.length === 2 && parts[0] === 'Bearer' ? parts[1] : '');
  try {
    const payload = JSON.parse(Buffer.from(token.split('.')[1], 'base64url').toString('utf8'));
    return Number.isFinite(payload.exp) ? payload.exp * 1000 : null;
  } catch {
    return null;
  }
}

/**
 * GET /stream — SSE. The hub owns headers + lifecycle from here; this handler
 * only enforces the connection caps (per-process and per-user → 503 with a
 * named error). No query params are accepted: a stray ?limit here is a caller
 * bug, name it instead of silently ignoring it.
 */
router.get('/stream', (req, res, next) => {
  try {
    if (req.query.limit !== undefined || req.query.since !== undefined) {
      return res.status(400).json({ error: 'stream_takes_no_params' });
    }
    const attached = subscribe(req, res, {
      userId: req.user?.id || 'unknown',
      authExpiresAt: tokenExpMs(req),
    });
    if (!attached.ok) {
      return res.status(503).json(
        attached.reason === 'user_cap'
          ? { error: 'too_many_user_connections', max: LIVE_VIEW_LIMITS.maxPerUser }
          : { error: 'too_many_live_connections', max: LIVE_VIEW_LIMITS.maxClients }
      );
    }
  } catch (err) {
    next(err);
  }
});

export default router;
