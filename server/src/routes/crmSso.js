// CRM SSO TICKET — one login for Puure Software + the embedded Funnel OS CRM.
//
// The CRM is a separate application with its own user database. Without this,
// the operator logs into Puure and then logs in AGAIN inside the embedded
// panel, which is not "one product" in any sense that matters.
//
// This endpoint mints a short-lived, signed ticket asserting "Puure has
// authenticated <email> right now". The CRM's `/api/sso` endpoint verifies the
// signature and exchanges it for its own session. The CRM refuses any email it
// does not already know — the ticket re-states a decision, it does not create
// access.
//
// ── WHY THIS IS SAFE, AND WHERE IT IS NOT ─────────────────────────────────
//  • The ticket asserts ONLY the email of the already-authenticated caller.
//    `req.user.email` comes from the verified JWT — never from the request
//    body, which would let anyone mint a ticket for anyone.
//  • TTL is 30 seconds. The ticket travels in a URL, so it lands in browser
//    history and Referer headers; short life is the mitigation. The CRM also
//    enforces its own ceiling and burns the nonce, so a captured ticket is
//    single-use and near-instantly stale.
//  • SSO_SHARED_SECRET is the whole trust anchor. Anyone holding it can mint a
//    ticket for any email that exists in the CRM. It lives in env on both
//    services and must never be logged or returned to a client.
//  • Unset secret ⇒ 503 with an honest reason, never a ticket signed with an
//    empty/guessable key.
import { Router } from 'express';
import crypto from 'node:crypto';
import { authenticate } from '../middleware/auth.js';

const router = Router();
router.use(authenticate);

const TICKET_TTL_S = 30;

const b64u = (buf) =>
  Buffer.from(buf).toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');

router.get('/ticket', (req, res) => {
  const secret = (process.env.SSO_SHARED_SECRET || '').trim();
  if (!secret) {
    return res.status(503).json({
      error: 'sso_not_configured',
      message: 'SSO_SHARED_SECRET is not set on this service.',
    });
  }

  const email = String(req.user?.email || '').trim().toLowerCase();
  if (!email) {
    // An authenticated principal with no email cannot be matched on the CRM
    // side; failing loudly beats minting a ticket that will 403 there.
    return res.status(400).json({ error: 'no_email_on_principal' });
  }

  const payload = JSON.stringify({
    email,
    exp: Math.floor(Date.now() / 1000) + TICKET_TTL_S,
    nonce: crypto.randomBytes(16).toString('hex'),
  });
  // Sign the exact bytes the CRM will verify — it re-reads the raw payload
  // rather than re-serialising, so the two sides cannot disagree.
  const sig = crypto.createHmac('sha256', secret).update(payload).digest();

  res.json({ ticket: `${b64u(payload)}.${b64u(sig)}`, expires_in: TICKET_TTL_S });
});

export default router;
