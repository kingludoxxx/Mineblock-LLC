// PUBLIC checkout endpoints — unauthenticated BY NECESSITY (the buyer is not
// a user of this system), therefore defensive by construction:
//   1. per-IP rate limit (checkRateLimit — Redis with in-memory fallback)
//   2. optional Origin/Referer allow-list (CHECKOUT_ALLOWED_ORIGINS env)
//   3. every line re-priced server-side against Shopify; client prices are
//      NEVER read; quantities clamped; minimum total enforced
// Auth boundary = file boundary: nothing in this file may require a session,
// and nothing outside it may mount unauthenticated checkout surface.
//
// Mount (integrator-owned, app.js): BEFORE the global apiLimiter, like the
// other webhook/public mounts:
//   app.use('/api/v1/checkout/public', checkoutPublicRoutes);
import { Router } from 'express';
import crypto from 'crypto';
import { pgQuery } from '../db/pg.js';
import { checkRateLimit } from '../middleware/rateLimiter.js';
import { ensureCheckoutTables } from '../services/checkoutSchema.js';
import {
  resolveVariantPrices,
  toVariantGid,
  currencyMismatch,
  PricingUnavailableError,
} from '../services/checkoutPricing.js';

const router = Router();

const MAX_LINES = 50;
const MAX_QTY_PER_LINE = 100;
const MIN_TOTAL = 1.0; // gateway documented minimum — sub-$1 sessions can't charge

const round2 = (n) => Math.round(n * 100) / 100;

function clientIp(req) {
  // app.js sets `trust proxy 1` (Render), so req.ip is the client address as
  // the platform proxy saw it — not a client-forgeable left-most XFF entry.
  return req.ip || req.socket?.remoteAddress || 'unknown';
}

async function rateLimit(req, res, bucket, limit, windowSec = 60) {
  const { allowed, retryAfter } = await checkRateLimit(
    `checkout:${bucket}:${clientIp(req)}`, limit, windowSec
  );
  if (!allowed) {
    res.status(429).json({ success: false, error: { code: 'rate_limited', retryAfter } });
    return false;
  }
  return true;
}

// Origin/Referer allow-list — defence-in-depth only (server-side re-pricing
// already makes a forged session worthless). Read at request time (rollback =
// unset the var). Absent/unparseable headers don't block: many legitimate
// clients strip them, and the check must never be load-bearing.
function originAllowed(req) {
  const allowed = (process.env.CHECKOUT_ALLOWED_ORIGINS || '')
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

function cleanCustomer(body) {
  const c = body?.customer;
  if (!c || typeof c !== 'object' || Array.isArray(c)) return {};
  const s = (v, max) => (typeof v === 'string' ? v.slice(0, max) : '');
  const out = {
    email: s(c.email, 254),
    first_name: s(c.first_name, 100),
    last_name: s(c.last_name, 100),
    phone: s(c.phone, 40),
  };
  const sh = c.shipping;
  if (sh && typeof sh === 'object' && !Array.isArray(sh)) {
    out.shipping = {
      address1: s(sh.address1, 200),
      address2: s(sh.address2, 200),
      city: s(sh.city, 100),
      state: s(sh.state, 100),
      zip: s(sh.zip, 20),
      country: s(sh.country, 60),
    };
  }
  return out;
}

// Five-key tracking snapshot, captured at session creation because these
// values are gone by the time the settlement webhook fires. All nullable —
// the tracking lane wires real values later.
function trackingSnapshot(req) {
  return {
    fbp: (req.cookies?._fbp || '').slice(0, 80) || null,
    fbc: (req.cookies?._fbc || '').slice(0, 200) || null,
    ip: clientIp(req),
    ua: (req.get('user-agent') || '').slice(0, 300) || null,
    url: (req.get('referer') || '').slice(0, 500) || null,
  };
}

// POST /create-session — validate the cart SERVER-SIDE, persist a co_sessions
// row at status 'processing' (= payment INTENT, not money), return the
// session snapshot. Sessions are deliberately NOT idempotent — a replayed
// create mints a fresh session; only settlement writes (orders/charges) carry
// idempotency keys.
router.post('/create-session', async (req, res) => {
  try {
    if (!(await rateLimit(req, res, 'create-session', 20))) return;
    if (!originAllowed(req)) {
      return res.status(403).json({ success: false, error: { code: 'origin_not_allowed' } });
    }
    await ensureCheckoutTables();

    const body = req.body || {};
    const rawLines = Array.isArray(body.line_items) ? body.line_items : [];
    const requested = [];
    for (const li of rawLines.slice(0, MAX_LINES)) {
      const vid = li && li.variant_id != null ? String(li.variant_id).trim() : '';
      if (!vid) continue;
      const qty = Math.max(1, Math.min(parseInt(li.quantity, 10) || 1, MAX_QTY_PER_LINE));
      requested.push({ variantId: vid, qty });
    }
    if (!requested.length) {
      return res.status(422).json({ success: false, error: { code: 'empty_cart' } });
    }

    // AUTHORITATIVE re-pricing. Client-sent prices are never read. A Shopify
    // transport failure throws PricingUnavailableError → retryable 503,
    // DISTINCT from the 422 invalid_variant below (unknown/unpurchasable).
    let priced;
    try {
      priced = await resolveVariantPrices(requested.map((r) => r.variantId));
    } catch (err) {
      if (err instanceof PricingUnavailableError) {
        console.error('[checkout] pricing unavailable:', err.message);
        return res.status(503).json({ success: false, error: { code: 'pricing_unavailable' } });
      }
      throw err;
    }

    // Fail closed if the shop currency differs from a configured base
    // currency — the whole store is mispriced; never mint at a wrong amount.
    const baseCurrency = (process.env.CHECKOUT_BASE_CURRENCY || '').toUpperCase();
    const mismatch = currencyMismatch(priced, baseCurrency);
    if (mismatch) {
      console.error(
        `[checkout] currency mismatch: shop=${mismatch} base=${baseCurrency} — refusing to mint`
      );
      return res.status(422).json({ success: false, error: { code: 'currency_mismatch' } });
    }

    const cleanItems = [];
    let currency = baseCurrency || '';
    for (const { variantId, qty } of requested) {
      const info = priced[toVariantGid(variantId)];
      if (!info) {
        // Unknown / unpublished / unpurchasable — reject the cart rather than
        // silently drop the line (the buyer thinks they're buying it).
        return res.status(422).json({ success: false, error: { code: 'invalid_variant' } });
      }
      currency = currency || info.currency || 'USD';
      cleanItems.push({
        variant_id: variantId,
        quantity: qty,
        price: round2(Number(info.price)), // AUTHORITATIVE Shopify price
        currency,
        title: info.title || '',
        product_title: info.product_title || '',
        image: info.image || null,
        line_total: round2(Number(info.price) * qty),
      });
    }

    const subtotal = round2(cleanItems.reduce((s, i) => s + i.price * i.quantity, 0));
    const shipping = 0; // shipping/tax lanes land with the page config port
    const tax = 0;
    const total = round2(subtotal + shipping + tax);
    if (total < MIN_TOTAL) {
      return res.status(422).json({ success: false, error: { code: 'total_below_minimum' } });
    }

    const sessionId = `co_${crypto.randomBytes(16).toString('hex')}`;
    // JSONB params are raw JS values — pgQuery/postgres.js serializes them.
    await pgQuery(
      `INSERT INTO co_sessions (
         id, funnel_id, page_id, status, line_items,
         subtotal, shipping, tax, total, currency, customer, tracking_net
       ) VALUES ($1, $2, $3, 'processing', $4, $5, $6, $7, $8, $9, $10, $11)`,
      [
        sessionId,
        body.funnel_id ? String(body.funnel_id).slice(0, 64) : null,
        body.page_id ? String(body.page_id).slice(0, 64) : null,
        cleanItems,
        subtotal, shipping, tax, total,
        currency,
        cleanCustomer(body),
        trackingSnapshot(req),
      ]
    );

    // Event trail — analytics side of the fail-open/fail-closed line: a
    // failed event write must never fail the mint.
    try {
      await pgQuery(
        `INSERT INTO co_events (session_id, kind, data) VALUES ($1, 'session_created', $2)`,
        [sessionId, { total, currency, lines: cleanItems.length }]
      );
    } catch (err) {
      console.error('[checkout] co_events write failed (non-fatal):', err.message);
    }

    return res.json({
      success: true,
      data: {
        session_id: sessionId,
        status: 'processing',
        line_items: cleanItems,
        totals: { subtotal, shipping, tax, total },
        currency,
      },
    });
  } catch (err) {
    console.error('[checkout] create-session failed:', err.message);
    return res.status(500).json({ success: false, error: { code: 'internal_error' } });
  }
});

// GET /session/:id — safe public snapshot (thank-you / upsell pages poll
// this). Hand-picked fields, an allow-list: no tracking net, no customer PII
// beyond nothing, no gateway internals.
router.get('/session/:id', async (req, res) => {
  try {
    if (!(await rateLimit(req, res, 'get-session', 60))) return;
    await ensureCheckoutTables();
    const rows = await pgQuery(
      `SELECT id, status, line_items, subtotal, shipping, tax, total, currency, created_at
       FROM co_sessions WHERE id = $1`,
      [String(req.params.id || '').slice(0, 80)]
    );
    if (!rows.length) {
      return res.status(404).json({ success: false, error: { code: 'not_found' } });
    }
    const s = rows[0];
    return res.json({
      success: true,
      data: {
        session_id: s.id,
        status: s.status,
        line_items: (Array.isArray(s.line_items) ? s.line_items : []).map((li) => ({
          title: li.title,
          product_title: li.product_title,
          quantity: li.quantity,
          price: li.price,
          image: li.image,
        })),
        totals: {
          subtotal: Number(s.subtotal),
          shipping: Number(s.shipping),
          tax: Number(s.tax),
          total: Number(s.total),
        },
        currency: s.currency,
        created_at: s.created_at,
      },
    });
  } catch (err) {
    console.error('[checkout] get-session failed:', err.message);
    return res.status(500).json({ success: false, error: { code: 'internal_error' } });
  }
});

export default router;
