// PUBLIC opt-in lead intake — unauthenticated BY NECESSITY (the visitor is
// not a user of this system), therefore defensive by construction, mirroring
// routes/checkoutPublic.js postures:
//   1. per-IP rate limit (checkRateLimit — Redis with in-memory fallback)
//   2. optional Origin/Referer allow-list (OPTIN_ALLOWED_ORIGINS env,
//      falling back to CHECKOUT_ALLOWED_ORIGINS so one setting covers both)
//   3. honeypot: the seeded optin_form block renders a visually-hidden
//      `website` field — a non-empty value gets a success-shaped response
//      (no oracle for the bot) and the lead is silently dropped
//   4. strict input bounds; email validated; nothing else trusted
// LEADS ONLY: this file must never touch money, sessions, or gateways.
// Auth boundary = file boundary, exactly like checkoutPublic.js.
//
// ── INTEGRATION HOOK (app.js — NOT edited by this branch) ───────────────────
// Mount next to the checkout public mount, after the global JSON parser and
// BEFORE the /api apiLimiter (same posture as /api/v1/checkout/public):
//
//   import optinPublicRoutes from './routes/optinPublic.js';
//   app.use('/api/v1/optin/public', optinPublicRoutes);
// ────────────────────────────────────────────────────────────────────────────
import { Router, json } from 'express';
import crypto from 'crypto';
import { checkRateLimit } from '../middleware/rateLimiter.js';
import { ensureOptinTables, insertOptinLead } from '../services/optinLeads.js';

const router = Router();

// Parses its OWN body — never assume an upstream parser ran (idempotent if
// one did; express.json is a no-op when the body was already read).
router.use(json({ limit: '64kb' }));

function clientIp(req) {
  // app.js sets `trust proxy 1` (Render), so req.ip is the client address as
  // the platform proxy saw it — not a client-forgeable left-most XFF entry.
  return req.ip || req.socket?.remoteAddress || 'unknown';
}

async function rateLimit(req, res, bucket, limit, windowSec = 60) {
  const { allowed, retryAfter } = await checkRateLimit(
    `optin:${bucket}:${clientIp(req)}`, limit, windowSec
  );
  if (!allowed) {
    res.status(429).json({ success: false, error: { code: 'rate_limited', retryAfter } });
    return false;
  }
  return true;
}

// Origin/Referer allow-list — defence-in-depth only (a forged lead is just a
// bad row; the rate limit is the real spam control). Absent/unparseable
// headers don't block: many legitimate clients strip them.
function originAllowed(req) {
  const allowed = (
    process.env.OPTIN_ALLOWED_ORIGINS ||
    process.env.CHECKOUT_ALLOWED_ORIGINS ||
    ''
  )
    .split(',').map((s) => s.trim().toLowerCase()).filter(Boolean);
  if (!allowed.length) return true;
  const raw = req.get('origin') || req.get('referer') || '';
  if (!raw) return true;
  try {
    return allowed.includes(new URL(raw).hostname.toLowerCase());
  } catch {
    return true;
  }
}

// Pragmatic email shape check (full RFC validation is a fool's errand): one
// @, something before it, a dot in the domain, sane length. Bounded BEFORE
// the regex runs so a megabyte "email" can't cost regex time.
const EMAIL_RE = /^[^\s@]{1,64}@[^\s@]{1,255}\.[^\s@]{2,24}$/;

// POST /submit — { email, name?, funnel_id?, page_id?, website? (honeypot) }
router.post('/submit', async (req, res) => {
  try {
    if (!(await rateLimit(req, res, 'submit', 10))) return;
    if (!originAllowed(req)) {
      return res.status(403).json({ success: false, error: { code: 'origin_not_allowed' } });
    }
    const b = req.body || {};

    // Honeypot: real visitors never see the field; bots fill it. Answer
    // success-shaped (no oracle to iterate against) and store NOTHING.
    if (typeof b.website === 'string' && b.website.trim()) {
      return res.status(201).json({ success: true, data: { accepted: true } });
    }

    const email = typeof b.email === 'string' ? b.email.trim().slice(0, 254) : '';
    if (!EMAIL_RE.test(email)) {
      return res.status(400).json({ success: false, error: { code: 'invalid_email' } });
    }
    const name = typeof b.name === 'string' ? b.name.trim().slice(0, 120) : '';
    const funnelId = b.funnel_id != null ? String(b.funnel_id).slice(0, 80) : null;
    const pageId = b.page_id != null ? String(b.page_id).slice(0, 80) : null;

    await ensureOptinTables();
    const id = `lead_${crypto.randomBytes(9).toString('hex')}`;
    await insertOptinLead({
      id,
      funnel_id: funnelId,
      page_id: pageId,
      email,
      name: name || null,
      ip: clientIp(req),
      user_agent: (req.get('user-agent') || '').slice(0, 300) || null,
    });
    return res.status(201).json({ success: true, data: { lead_id: id, accepted: true } });
  } catch (err) {
    console.error('[optin] submit failed:', err.message);
    return res.status(500).json({ success: false, error: { code: 'internal_error' } });
  }
});

export default router;
