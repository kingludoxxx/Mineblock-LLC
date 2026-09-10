// BRAIN AUTH — a dashboard session OR a per-pair service token.
//
// The CRM reads its store's Brain through the same HTTP API as the dashboard,
// with a service token that belongs to THAT pair (its own BRAIN_SERVICE_TOKEN in
// its own environment). There is no shared token and no cross-store token: a
// token is only ever compared against the one this process was given, so store
// A's token presented to store B's API is simply wrong (R4).
//
// Read at REQUEST time (R7): unset the variable and every service call stops.
// FAIL CLOSED: an unset or too-short token answers 503, never "allow".

import crypto from 'node:crypto';
import { authenticate } from './auth.js';
import { requirePermission } from './rbac.js';

export const SERVICE_TOKEN_HEADER = 'x-brain-service-token';
const MIN_TOKEN_LENGTH = 16;

/** Length-safe constant-time compare. Never logs, never echoes either side. */
export function tokensMatch(presented, expected) {
  const a = Buffer.from(String(presented ?? ''), 'utf8');
  const b = Buffer.from(String(expected ?? ''), 'utf8');
  if (a.length !== b.length) {
    // Still do the work, so a length mismatch is not faster than a value mismatch.
    crypto.timingSafeEqual(a, a);
    return false;
  }
  return crypto.timingSafeEqual(a, b);
}

const sessionChain = [authenticate, requirePermission('brain', 'access')];

export function brainAuth(req, res, next) {
  const presented = req.headers[SERVICE_TOKEN_HEADER];

  if (presented !== undefined && String(presented).trim() !== '') {
    const expected = process.env.BRAIN_SERVICE_TOKEN;
    if (!expected || String(expected).trim().length < MIN_TOKEN_LENGTH) {
      return res.status(503).json({
        error: 'Brain service access is not configured on this store',
        code: 'service_token_unconfigured',
      });
    }
    if (!tokensMatch(presented, expected)) {
      return res.status(401).json({ error: 'Invalid service token', code: 'bad_service_token' });
    }
    req.brainActor = 'service';
    return next();
  }

  // No service token → the dashboard session path.
  let i = 0;
  const step = (err) => {
    if (err) return next(err);
    if (i >= sessionChain.length) {
      req.brainActor = req.user?.id ? `user:${req.user.id}` : 'user';
      return next();
    }
    const mw = sessionChain[i++];
    return mw(req, res, step);
  };
  return step();
}

export default brainAuth;
