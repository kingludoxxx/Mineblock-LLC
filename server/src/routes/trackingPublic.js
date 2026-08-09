// PUBLIC tracking intake — unauthenticated BY NECESSITY (the visitor is not a
// user of this system), defended exactly like checkoutPublic:
//   1. per-IP rate limit (checkRateLimit — Redis with in-memory fallback)
//   2. real client IP from req.ip (app.js sets `trust proxy 1`)
//   3. optional Origin/Referer allow-list (TRACKING_ALLOWED_ORIGINS)
//   4. FAIL OPEN: every write is fire-and-forget with a swallowed exception —
//      a tracking failure returns 200 {ok:true,...} and NEVER errors the page
//      or the sale (DECISIONS #16).
//
// Consent is enforced SERVER-SIDE, not just in the browser: /touch and /click
// write identity ONLY when consent === 'granted' AND the vid is well-formed.
// A consent-denied beacon writes NO identity (that is correct, not an error).
//
// Mount (integrator-owned, app.js): BEFORE the global apiLimiter, like the
// other public mounts:  app.use('/api/v1/track', trackingPublicRoutes);
import { Router, json } from 'express';
import cookieParser from 'cookie-parser';
import crypto from 'crypto';
import { pgQuery } from '../db/pg.js';
import { checkRateLimit } from '../middleware/rateLimiter.js';
import { ensureTrackingTables } from '../services/trackingSchema.js';
import { recordClick, isValidVid } from '../services/trackingClicks.js';
import { recordTouch, recordFirstSeen } from '../services/trackingAttribution.js';
import { relayBrowserEvent, ALLOWED_CLIENT_EVENTS } from '../services/trackingService.js';
import { startTrackingSweeps } from '../services/trackingSweeps.js';

// The TTL-prune + postback-drain cron rides this module's load (same pattern
// as gatewayWebhooks → startMoneySweeps). No-op when TRACKING_SWEEPS_DISABLED.
startTrackingSweeps();

const router = Router();
router.use(json({ limit: '256kb' }));
router.use(cookieParser());

function clientIp(req) {
  return req.ip || req.socket?.remoteAddress || 'unknown';
}

// Salted IP hash — the RAW ip is NEVER stored (DATA-MODEL: lb_clicks.ip_hash).
function ipHash(req) {
  const salt = process.env.TRACKING_IP_SALT || process.env.JWT_ACCESS_SECRET || 'fos-ip-salt';
  return crypto.createHash('sha256').update(`${salt}:${clientIp(req)}`).digest('hex').slice(0, 32);
}

async function rateLimit(req, res, bucket, limit, windowSec = 60) {
  try {
    const { allowed, retryAfter } = await checkRateLimit(`track:${bucket}:${clientIp(req)}`, limit, windowSec);
    if (!allowed) {
      res.status(429).json({ ok: false, error: 'rate_limited', retryAfter });
      return false;
    }
  } catch (err) {
    // Limiter trouble must never drop a beacon — fail open.
    console.error('[track] rate limit check failed (fail-open):', err.message);
  }
  return true;
}

// Defence-in-depth only (writes are worthless to a forger — no money here).
function originAllowed(req) {
  const allowed = (process.env.TRACKING_ALLOWED_ORIGINS || '')
    .split(',').map((s) => s.trim().toLowerCase()).filter(Boolean);
  if (!allowed.length) return true;
  const raw = req.get('origin') || req.get('referer') || '';
  if (!raw) return true;
  try { return allowed.includes(new URL(raw).hostname.toLowerCase()); } catch { return true; }
}

const consentGranted = (v) => String(v || '').trim().toLowerCase() === 'granted';
const funnelOf = (b) => (b && b.funnel_id != null ? String(b.funnel_id).slice(0, 64) : '');
const pageOf = (b) => (b && b.page_id != null ? String(b.page_id).slice(0, 64) : '');

// GET /config — enabled pixels for the runtime to fire (browser pixels) +
// the default consent posture. MASKED: only pixel_id/kind/mode — never a
// capi_token or any secret. An allow-list, not a deny-list.
router.get('/config', async (req, res) => {
  res.set('Cache-Control', 'no-store');
  try {
    if (!(await rateLimit(req, res, 'config', 120))) return;
    await ensureTrackingTables();
    const funnelId = String(req.query.funnel || '').slice(0, 64);
    let pixels = [];
    if (funnelId) {
      const rows = await pgQuery(
        `SELECT pixel_id, kind, mode FROM lb_pixels
         WHERE funnel_id = $1 AND enabled = TRUE AND mode IN ('native','hybrid')`,
        [funnelId]
      );
      pixels = rows.map((r) => ({ pixel_id: r.pixel_id, kind: r.kind, mode: r.mode }));
    }
    return res.json({ ok: true, data: { pixels, default_consent: String(process.env.TRACKING_DEFAULT_CONSENT || 'granted').toLowerCase() } });
  } catch (err) {
    console.error('[track] config failed (fail-open):', err.message);
    return res.json({ ok: true, data: { pixels: [] } });
  }
});

// POST /consent — record the consent signal (analytics only). A denied signal
// carries no identity by construction.
router.post('/consent', async (req, res) => {
  try {
    if (!(await rateLimit(req, res, 'consent', 120))) return;
    if (!originAllowed(req)) return res.json({ ok: true, skipped: 'origin' });
    const b = req.body || {};
    const status = String(b.status || '').trim().toLowerCase() === 'granted' ? 'granted' : 'denied';
    const vid = isValidVid(b.vid) ? b.vid : '';
    try {
      await ensureTrackingTables();
      await pgQuery(
        `INSERT INTO lb_consent (vid, funnel_id, status, region, ua, ip_hash)
         VALUES ($1,$2,$3,$4,$5,$6)`,
        [vid, funnelOf(b), status,
          typeof b.region === 'boolean' ? b.region : null,
          (req.get('user-agent') || '').slice(0, 300), ipHash(req)]
      );
    } catch (err) { console.error('[track] consent write failed (fail-open):', err.message); }
    return res.json({ ok: true, status });
  } catch (err) {
    console.error('[track] consent failed (fail-open):', err.message);
    return res.json({ ok: true });
  }
});

// POST /touch — writes lb_touches + the write-once first-seen registry.
// Identity is written ONLY on consent granted + a well-formed vid.
router.post('/touch', async (req, res) => {
  try {
    if (!(await rateLimit(req, res, 'touch', 120))) return;
    if (!originAllowed(req)) return res.json({ ok: true, skipped: 'origin' });
    const b = req.body || {};
    // CONSENT GATE (server-side): no consent ⇒ no identity written.
    if (!consentGranted(b.consent) || !isValidVid(b.vid)) {
      return res.json({ ok: true, skipped: 'no_consent_or_vid' });
    }
    const funnelId = funnelOf(b);
    const url = String(b.url || '').slice(0, 2048);
    const ref = String(b.referrer || '').slice(0, 1024);
    // Fire-and-forget; swallow — a tracking failure must never surface.
    const [touch] = await Promise.all([
      recordTouch(funnelId, pageOf(b), b.vid, url, ref),
      recordFirstSeen(funnelId, b.vid, url),
    ]);
    return res.json({ ok: true, deduped: Boolean(touch && touch.deduped) });
  } catch (err) {
    console.error('[track] touch failed (fail-open):', err.message);
    return res.json({ ok: true });
  }
});

// POST /click — captures the ad click into the click-id vault. Consent-gated.
// bot/velocity flags are set-on-insert in recordClick; this public endpoint
// never sends them true, so it can never poison an existing clean click.
router.post('/click', async (req, res) => {
  try {
    if (!(await rateLimit(req, res, 'click', 120))) return;
    if (!originAllowed(req)) return res.json({ ok: true, skipped: 'origin' });
    const b = req.body || {};
    if (!consentGranted(b.consent) || !isValidVid(b.vid)) {
      return res.json({ ok: true, skipped: 'no_consent_or_vid' });
    }
    const r = await recordClick(funnelOf(b), b.vid, String(b.url || '').slice(0, 2048), {
      ipHash: ipHash(req),
    });
    return res.json({ ok: true, network: r.network || '', no_click: Boolean(r.no_click) });
  } catch (err) {
    console.error('[track] click failed (fail-open):', err.message);
    return res.json({ ok: true });
  }
});

// POST /collect — the server-side relay beacon. Echoes the browser's event_id
// so native + relay dedupe. Consent-denied beacons legitimately carry no
// identity → the delivery layer records them as skipped 'no_identity' WITHOUT
// tripping the circuit breaker (DECISIONS #11).
router.post('/collect', async (req, res) => {
  try {
    if (!(await rateLimit(req, res, 'collect', 120))) return;
    if (!originAllowed(req)) return res.json({ ok: true, skipped: 'origin' });
    const b = req.body || {};
    const eventName = String(b.event_name || '');
    if (!ALLOWED_CLIENT_EVENTS.has(eventName)) {
      // A forged beacon cannot drive arbitrary conversion-API calls.
      return res.json({ ok: true, skipped: 'event_not_allowed' });
    }
    const granted = consentGranted(b.consent);
    // Consent decides whether identity is attached. Denied ⇒ no identity →
    // the relay records it and (correctly) never trips the breaker. Never
    // trust client IP/UA for identity — take them from the request itself.
    const rawIdentity = granted && b.identity && typeof b.identity === 'object' ? b.identity : {};
    const identity = granted ? {
      ...rawIdentity,
      ip: clientIp(req),
      ua: (req.get('user-agent') || '').slice(0, 300),
    } : {};
    const customData = b.custom_data && typeof b.custom_data === 'object' ? b.custom_data : {};
    const r = await relayBrowserEvent({
      funnelId: funnelOf(b), eventName,
      eventId: String(b.event_id || '').slice(0, 120),
      identity, customData,
      consent: granted ? 'granted' : 'denied',
      eventSourceUrl: String(b.url || '').slice(0, 500),
      // Server-read visitor id → GA4 client_id seed (visitor-scoped, not
      // forgeable via the body; empty when the cookie is absent/invalid).
      vid: isValidVid(String(req.cookies?._fos_vid || '')) ? String(req.cookies._fos_vid) : '',
    });
    return res.json({ ok: true, fired: r.fired || 0 });
  } catch (err) {
    console.error('[track] collect failed (fail-open):', err.message);
    return res.json({ ok: true });
  }
});

export default router;
