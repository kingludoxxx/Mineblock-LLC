// PUBLIC inbound postback intake — GET/POST /pb/:token.
//
// Unauthenticated BY NECESSITY: the caller is an ad network's postback pinger,
// a partner funnel or a call centre — none of them are users of this system.
// The token in the path is the ONLY credential.
//
// ─────────────────────────────────────────────────────────────────────────────
// MOUNT (integrator-owned, server/src/app.js). This file MUST NOT be mounted
// from routes/index.js, for two SEPARATE reasons that are worth keeping apart:
//
//   • THE BODY PARSER — the binding one, and it applies wherever this router
//     is mounted. Behind the global `express.json({limit:'50mb'})` the router's
//     own 32kb parser is skipped entirely (the global one already set
//     req._body), so the documented cap becomes a NO-OP and an 80kb postback is
//     fully parsed on an unauthenticated path. This is not a comment you have
//     to take on trust: server/tests/tracking/s2s-integrations-e2e.mjs E11b
//     stands both orderings up side by side and asserts the cap goes inert in
//     the wrong one and fires in the right one.
//
//   • THE `/api` LIMITER — narrower than it first looks. `app.use('/api',
//     apiLimiter)` is PATH-PREFIXED, so a root-level `/pb` mount never passes
//     through it whatever the order. It matters only because routes/index.js
//     mounts everything under `/api/v1/...`: putting this router there would
//     put it behind that limiter, whose budget and 429 shape are tuned for
//     authed API traffic, not for a partner network's postback pinger.
//
// Add the import beside the other public routers (near line 32):
//
//     import trackingPostbackPublicRoutes from './routes/trackingPostbackPublic.js';
//
// and the mount immediately AFTER the `/api/v1/media` mount and BEFORE the
// global body parsers (i.e. between the current lines 96 and 98):
//
//     app.use('/pb', trackingPostbackPublicRoutes);
//
// Root-level `/pb`, not `/api/v1/...`, on purpose: this URL is pasted into ad
// networks' postback fields by hand and every character costs. It sits above
// `app.use('/f', funnelPublicRoutes)` in the same namespace and cannot collide
// with it.
// ─────────────────────────────────────────────────────────────────────────────
//
// DEFENCES, in the order a request meets them:
//   1. per-IP rate limit (checkRateLimit — Redis with in-memory fallback)
//   2. token compare with a CONSTANT-WORK FLOOR (trackingInbound.resolveToken):
//      the token BYTES are compared with crypto.timingSafeEqual, and every
//      request — malformed token, unknown token, disabled endpoint, valid
//      token — performs the same shaped lookup and at least one full-length
//      comparison. That removes the structural oracle (an early return that
//      skipped the query and answered visibly faster). It is NOT an end-to-end
//      constant-time guarantee and is not claimed as one: index state, pool
//      scheduling and the event loop are not ours to control.
//   3. ANTI-PROBING: the response body is byte-identical on EVERY path —
//      unknown token, disabled endpoint, valid token that ingested, valid
//      token that deduped, malformed payload. See ANSWER below.
//   4. FAIL-OPEN: every failure is swallowed and answered 200. A postback
//      pinger that gets a 500 retries forever or, worse, disables the
//      integration.
//
// The ONE status code that is not 200 is 429, and it is keyed to the CLIENT IP
// rather than the token, so it reveals nothing about whether a token exists.
import { Router, json, urlencoded } from 'express';
import crypto from 'crypto';
import { checkRateLimit } from '../middleware/rateLimiter.js';
import { resolveToken, ingest, flattenParams } from '../services/trackingInbound.js';

const router = Router();
// Small caps: a postback is a handful of query params. These only bind because
// the router is mounted AHEAD of the global 50mb parser (see MOUNT above).
router.use(json({ limit: '32kb' }));
router.use(urlencoded({ extended: false, limit: '32kb' }));

// THE ONE ANSWER. Every successful path returns exactly this object, so a
// prober cannot distinguish "no such token" from "valid token, nothing
// ingested" from "valid token, conversion recorded" by body, length or shape.
// Operator-facing truth lives on the AUTHED surface
// (GET /tracking-admin/:funnelId/inbound-events), which is where a real
// integration is verified.
const ANSWER = { ok: true };

function clientIp(req) {
  return req.ip || req.socket?.remoteAddress || 'unknown';
}

// Salted IP hash — the RAW ip is NEVER stored, same posture as
// trackingPublic.ipHash and lb_clicks.ip_hash.
function ipHash(req) {
  const salt = process.env.TRACKING_IP_SALT || process.env.JWT_ACCESS_SECRET || 'fos-ip-salt';
  return crypto.createHash('sha256').update(`${salt}:${clientIp(req)}`).digest('hex').slice(0, 32);
}

const RATE_LIMIT = Number(process.env.INBOUND_POSTBACK_RATE_LIMIT) > 0
  ? Number(process.env.INBOUND_POSTBACK_RATE_LIMIT)
  : 120;
const RATE_WINDOW_SEC = 60;

async function rateLimited(req, res) {
  try {
    const { allowed, retryAfter } = await checkRateLimit(`pb:${clientIp(req)}`, RATE_LIMIT, RATE_WINDOW_SEC);
    if (!allowed) {
      res.set('Retry-After', String(retryAfter));
      res.status(429).json({ ok: false, error: 'rate_limited', retryAfter });
      return true;
    }
  } catch (err) {
    // Limiter trouble must never drop a partner conversion — fail open.
    console.error('[pb] rate limit check failed (fail-open):', err.message);
  }
  return false;
}

async function handle(req, res) {
  res.set('Cache-Control', 'no-store');
  try {
    if (await rateLimited(req, res)) return undefined;

    const token = String(req.params.token || '');
    // A GET with NO `event` parameter is a link preview, a crawler, an uptime
    // monitor or the operator pasting the URL into a browser — not a postback.
    // Answer readiness and write nothing. Checked BEFORE the token is
    // resolved so this path costs no database work at all.
    const query = (req.query && typeof req.query === 'object') ? req.query : {};
    if (req.method === 'GET' && !query.event) return res.json(ANSWER);

    const endpoint = await resolveToken(token);
    // Unknown token, malformed token and disabled endpoint all land here and
    // all answer ANSWER — identical to a valid token that recorded nothing.
    if (!endpoint) return res.json(ANSWER);

    // Query first, then body: a param present in both takes the query value,
    // which is the half that survives a proxy rewriting a body.
    const body = (req.body && typeof req.body === 'object' && !Array.isArray(req.body)) ? req.body : {};
    const params = flattenParams(query, body);

    // The result is deliberately DISCARDED. It is the ledger's record, not the
    // caller's — returning it would leak token validity (see ANSWER).
    await ingest(endpoint, params, { ipHash: ipHash(req) });
    return res.json(ANSWER);
  } catch (err) {
    // Nothing reaches the caller. A postback pinger must never see a 5xx from
    // us: it either retries in a loop or the operator's network disables the
    // integration outright.
    console.error('[pb] inbound postback failed (fail-open):', err.message);
    return res.json(ANSWER);
  }
}

router.get('/:token', handle);
router.post('/:token', handle);

// A body that express's parser itself rejects (malformed JSON, oversize)
// raises before `handle` ever runs. Without this the global error handler
// would answer 400/413 and hand a prober a distinguishable response — and a
// partner a failure it will retry forever. Swallow to the SAME answer.
// eslint-disable-next-line no-unused-vars
router.use((err, req, res, next) => {
  console.error('[pb] malformed request body (fail-open):', err && err.message);
  res.set('Cache-Control', 'no-store');
  return res.status(200).json(ANSWER);
});

export default router;
