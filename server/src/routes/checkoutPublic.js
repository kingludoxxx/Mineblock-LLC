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
import { Router, json } from 'express';
import cookieParser from 'cookie-parser';
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
// SPLIT-LANE HOOK: exposure denominators are recorded fail-open at session
// mint (page scope) and at the upsell decision point (offer scope).
import { resolveArm } from '../services/splitResolver.js';
import { recordExposure } from '../services/splitCredits.js';

// Write the exposure denominator. Every failure is swallowed: a split outage
// must never block a mint or an upsell decision (fail-open serving).
//
// PAGE scope — the DELIVERED VIEWS are the source of truth (review findings:
// dark-arm re-picks and multi-test funnels made a hash-here diverge from what
// was served). The exposure lands on exactly the tests whose handle this
// visitor actually visited (their lb_split_views rows), under the arm they
// were ACTUALLY SERVED. A visitor who never hit a handle belongs in no page
// test's denominator — and an attacker must actually take delivery of a page
// before their sessions can touch a denominator.
//
// OFFER scope — membership-gated: the exposure concerns the one live offer
// test ONLY when the offer being shown/decided IS that test's target or one
// of its arms' offers. Other offers on the funnel (a second upsell, a
// downsell) stay out of the experiment. Arm = the same sticky hash the
// display override uses, so exposure and display can never disagree.
async function recordSplitExposure({ funnelId, sessionId, visitorId, scope, offerId }) {
  if (!funnelId || !sessionId || !visitorId) return;
  if (scope === 'page') {
    const views = await pgQuery(
      `SELECT v.test_id, v.arm_key FROM lb_split_views v
       JOIN lb_split_tests t ON t.id = v.test_id
       WHERE t.funnel_id = $1 AND t.scope = 'page' AND t.enabled AND NOT t.archived
         AND v.visitor_id = $2`,
      [String(funnelId).slice(0, 64), String(visitorId).slice(0, 120)]
    );
    for (const v of views) {
      await recordExposure({ sessionId, testId: v.test_id, armKey: v.arm_key });
    }
    return;
  }
  const [test] = await pgQuery(
    `SELECT id, target_offer_id FROM lb_split_tests
     WHERE funnel_id = $1 AND scope = 'offer' AND enabled AND NOT archived
     ORDER BY created_at ASC LIMIT 1`,
    [String(funnelId).slice(0, 64)]
  );
  if (!test) return;
  const oid = String(offerId || '');
  if (!oid) return;
  const arms = await pgQuery(
    `SELECT offer_id FROM lb_split_arms WHERE test_id = $1 AND NOT archived`,
    [test.id]
  );
  const member = oid === String(test.target_offer_id || '')
    || arms.some((a) => String(a.offer_id || '') === oid);
  if (!member) return;
  const { armKey } = await resolveArm({ visitorId, testId: test.id });
  if (!armKey) return;
  await recordExposure({ sessionId, testId: test.id, armKey });
}

// SPLIT DELIVERY (offer scope): which offer does THIS visitor's arm show?
// Returns a full, enabled, funnel-pinned offer row when the assigned arm names
// one — the caller swaps it in BEFORE display, so accept/decline reference
// exactly what the buyer saw (a buyer must never be charged an offer they
// were not shown). Test selection is IDENTICAL to recordSplitExposure's
// (first live offer-scope test on the funnel) so the displayed arm and the
// recorded exposure can never disagree. Fail-open: null = keep the default.
async function resolveOfferArmOverride({ funnelId, visitorId, shownOfferId }) {
  try {
    if (!funnelId || !visitorId) return null;
    const [test] = await pgQuery(
      `SELECT id, target_offer_id FROM lb_split_tests
       WHERE funnel_id = $1 AND scope = 'offer' AND enabled AND NOT archived
       ORDER BY created_at ASC LIMIT 1`,
      [String(funnelId).slice(0, 64)]
    );
    if (!test) return null;
    // SCOPE GUARD (review finding): the override applies ONLY when the offer
    // being displayed is the one under test (the target) or already one of
    // the arms' offers (a refresh posting the arm offer maps back to the
    // same arm — the hash is deterministic). Every OTHER offer on the funnel
    // — a second upsell, a downsell — is not part of the experiment and must
    // never be hijacked.
    const arms = await pgQuery(
      `SELECT offer_id FROM lb_split_arms WHERE test_id = $1 AND NOT archived`,
      [test.id]
    );
    const shown = String(shownOfferId || '');
    const inScope = shown && (shown === String(test.target_offer_id || '')
      || arms.some((a) => String(a.offer_id || '') === shown));
    if (!inScope) return null;
    const { arm } = await resolveArm({ visitorId, testId: test.id });
    if (!arm || !arm.offer_id) return null;
    const [offer] = await pgQuery(
      `SELECT id, funnel_id, variant_id, price, title, enabled FROM co_upsells WHERE id = $1`,
      [String(arm.offer_id).slice(0, 80)]
    );
    if (!offer || !offer.enabled) return null;
    if (offer.funnel_id && offer.funnel_id !== funnelId) return null;
    // DISPLAYABILITY GUARD: an arm offer with no fixed price AND no variant
    // cannot be priced for display — swapping it in would 422 a page the
    // default offer renders fine. Keep the default instead.
    if ((offer.price === null || offer.price === undefined) && !offer.variant_id) return null;
    // First overridden display = the offer test's DELIVERY EPOCH (idempotent).
    await pgQuery(
      `UPDATE lb_split_tests SET delivery_epoch_at = NOW()
       WHERE id = $1 AND delivery_epoch_at IS NULL`,
      [test.id]
    ).catch?.(() => {});
    return offer;
  } catch (err) {
    console.error('[checkout] offer-arm override failed (fail-open):', err.message);
    return null;
  }
}
// Exposed for the delivery harness only — not part of the route surface.
export const _splitInternals = { resolveOfferArmOverride };

const router = Router();

// This router is mounted BEFORE the app-level body/cookie parsers (auth
// boundary = file boundary), so it parses its OWN body and cookies — never
// assume an upstream parser ran. Idempotent if one did: express.json is a
// no-op when Content-Type isn't JSON or the body was already read, and
// cookieParser re-parsing is harmless. This makes the mount position safe
// either way and keeps the _fbp/_fbc tracking snapshot working.
router.use(json({ limit: '1mb' }));
router.use(cookieParser());

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
  const addr = (a) => ({
    address1: s(a.address1, 200),
    address2: s(a.address2, 200),
    city: s(a.city, 100),
    state: s(a.state, 100),
    zip: s(a.zip, 20),
    country: s(a.country, 60),
  });
  const sh = c.shipping;
  if (sh && typeof sh === 'object' && !Array.isArray(sh)) out.shipping = addr(sh);
  const bi = c.billing;
  if (bi && typeof bi === 'object' && !Array.isArray(bi)) {
    out.billing = { ...addr(bi), first_name: s(bi.first_name, 100), last_name: s(bi.last_name, 100) };
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
    // Charge-authorization secret (see loadPaidSession). Only the HASH is
    // stored; the token itself leaves this server exactly once, as an HttpOnly
    // cookie, so it can never reach a URL, a beacon, a log or page JavaScript.
    const confirmToken = crypto.randomBytes(32).toString('hex');
    // JSONB params are raw JS values — pgQuery/postgres.js serializes them.
    await pgQuery(
      `INSERT INTO co_sessions (
         id, funnel_id, page_id, status, line_items,
         subtotal, shipping, tax, total, currency, customer, tracking_net,
         confirm_token_hash
       ) VALUES ($1, $2, $3, 'processing', $4, $5, $6, $7, $8, $9, $10, $11, $12)`,
      [
        sessionId,
        body.funnel_id ? String(body.funnel_id).slice(0, 64) : null,
        body.page_id ? String(body.page_id).slice(0, 64) : null,
        cleanItems,
        subtotal, shipping, tax, total,
        currency,
        cleanCustomer(body),
        trackingSnapshot(req),
        hashToken(confirmToken),
      ]
    );

    // HttpOnly so page JS (and therefore any XSS or third-party tag) cannot
    // read it; SameSite=Lax so it survives the funnel's own top-level
    // navigations (checkout -> upsell -> thank-you) but is not sent from a
    // cross-site POST; Secure outside local dev.
    res.cookie(CONFIRM_COOKIE, confirmToken, {
      httpOnly: true,
      sameSite: 'lax',
      secure: process.env.NODE_ENV === 'production',
      path: '/',
      maxAge: 6 * 60 * 60 * 1000,
    });

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

    // SPLIT-LANE HOOK: record the page-scope exposure (denominator) for any
    // live test on this funnel. Fail-open: a split failure never blocks a mint.
    recordSplitExposure({
      funnelId: body.funnel_id ? String(body.funnel_id) : '',
      sessionId,
      visitorId: String(req.cookies?._fos_vid || ''),
      scope: 'page',
    }).catch(() => {});

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

// POST /stripe/create-intent — mint the PaymentIntent for a processing
// session. Amount comes from the SESSION (already server-priced) — the
// client sends only the session id. Customer + setup_future_usage tokenize
// the card for 1-click upsells. Deterministic Stripe Idempotency-Key means a
// replayed call returns the same PI, not a second charge surface.
router.post('/stripe/create-intent', async (req, res) => {
  try {
    if (!(await rateLimit(req, res, 'create-intent', 20))) return;
    await ensureCheckoutTables();
    const sessionId = String(req.body?.session_id || '').slice(0, 80);
    if (!sessionId) {
      return res.status(422).json({ success: false, error: { code: 'session_required' } });
    }
    const rows = await pgQuery(
      `SELECT id, funnel_id, status, total, currency, customer, gateway_session_id,
              gateway, gateway_customer_id
       FROM co_sessions WHERE id = $1`, [sessionId]
    );
    if (!rows.length) {
      return res.status(404).json({ success: false, error: { code: 'not_found' } });
    }
    const session = rows[0];
    if (session.status !== 'processing') {
      return res.status(409).json({ success: false, error: { code: 'session_not_payable' } });
    }
    const { resolveCredential } = await import('../services/gatewayConfigs.js');
    const { createCustomer, createPaymentIntent, modeOf } =
      await import('../services/gateways/stripe.js');
    const secretKey = await resolveCredential(session.funnel_id || '', 'stripe', 'secret_key');
    if (!secretKey) {
      return res.status(503).json({ success: false, error: { code: 'gateway_not_configured' } });
    }

    // Reuse the customer minted on a prior create-intent for THIS session.
    // Minting a fresh customer on every call both leaks orphan customers AND
    // changes the PaymentIntent params under the fixed idempotency key
    // `ci_<session>` — Stripe then rejects the retry (idempotency_error) and
    // the session becomes unpayable for the key's 24h life. A stable customer
    // makes the retried create-intent return the same PI, as intended.
    let customerId = session.gateway_customer_id || '';
    if (!customerId) {
      const cust = session.customer || {};
      const customer = await createCustomer(secretKey, {
        email: cust.email || '',
        name: [cust.first_name, cust.last_name].filter(Boolean).join(' '),
        phone: cust.phone || '',
        metadata: { co_session_id: session.id },
      });
      // A failed customer create degrades to a PI without saved-card upsells —
      // never blocks the sale (but then setup_future_usage is off, so no
      // 1-click; that is the correct trade, not an error).
      customerId = customer.ok ? customer.customer_id : '';
      // Persist immediately so a retry reuses it even if the PI call below
      // fails — otherwise the retry mints another customer and hits the
      // idempotency-param mismatch we are avoiding.
      if (customerId) {
        await pgQuery(
          `UPDATE co_sessions SET gateway_customer_id = COALESCE(gateway_customer_id, $2),
             updated_at = NOW()
           WHERE id = $1 AND status = 'processing'`,
          [session.id, customerId]
        );
      }
    }

    const pi = await createPaymentIntent(secretKey, {
      amount: Number(session.total),
      currency: session.currency,
      customerId,
      metadata: { co_session_id: session.id },
      idempotencyKey: `ci_${session.id}`,
      setupFutureUsage: Boolean(customerId),
    });
    if (!pi.ok) {
      console.error('[checkout] create-intent failed:', pi.error, pi.detail || '');
      return res.status(502).json({ success: false, error: { code: 'gateway_error' } });
    }

    // Guarded on 'processing': the status read above is stale by now, and
    // overwriting a settled session's gateway_session_id would break refund
    // matching and the sweep's order-key derivation.
    await pgQuery(
      `UPDATE co_sessions SET gateway = 'stripe', gateway_session_id = $2,
         gateway_customer_id = COALESCE($3, gateway_customer_id), updated_at = NOW()
       WHERE id = $1 AND status = 'processing'`,
      [session.id, pi.id, customerId || null]
    );
    const publishableKey = await resolveCredential(
      session.funnel_id || '', 'stripe', 'publishable_key'
    );
    return res.json({
      success: true,
      data: {
        payment_intent_id: pi.id,
        client_secret: pi.client_secret,
        publishable_key: publishableKey || null,
        mode: modeOf(secretKey),
        amount: Number(session.total),
        currency: session.currency,
      },
    });
  } catch (err) {
    console.error('[checkout] create-intent failed:', err.message);
    return res.status(500).json({ success: false, error: { code: 'internal_error' } });
  }
});

// POST /whop/create-session — mint the Whop embedded-checkout configuration
// for a processing session. Amount comes from the SESSION (server-priced);
// metadata carries co_session_id so payment.succeeded maps back. The embed
// mounts with setupFutureUsage=off_session (an embed prop, not an API field)
// which tokenizes the card for 1-click upsells.

// Where Whop sends the buyer after payment. Without it Whop falls back to the
// COMPANY's default page (the wrong product, in the visitor's locale — what the
// first live order showed). Resolves the funnel's thank-you page: the checkout
// page's 'main' flow edge target if the operator connected one in the builder,
// else any published page of type 'thankyou'. The URL is absolute (built from
// the request host so it works on custom domains too) and carries ?s=<session>
// so the thank-you page loads THIS order's live totals — dynamic by construction.
async function resolveRedirectUrl(req, session) {
  try {
    if (!session.funnel_id) return '';
    const [f] = await pgQuery(
      `SELECT slug, flow_layout FROM funnels WHERE id = $1 AND NOT archived`, [session.funnel_id]
    );
    if (!f || !f.slug) return '';
    const pages = await pgQuery(
      `SELECT id, slug, type FROM funnel_pages
       WHERE funnel_id = $1 AND NOT archived AND status = 'published'`, [session.funnel_id]
    );
    const byId = new Map(pages.map((p) => [String(p.id), p]));
    let target = null;
    const flow = f.flow_layout && typeof f.flow_layout === 'object' ? f.flow_layout : {};
    const edges = Array.isArray(flow.edges) ? flow.edges : [];
    for (const e of edges) {
      if (!e || String(e.source) !== String(session.page_id)) continue;
      if ((e.kind || 'main') === 'fallback') continue;
      const t = byId.get(String(e.target));
      if (t) { target = t; break; }
    }
    if (!target) target = pages.find((p) => p.type === 'thankyou') || null;
    if (!target) return '';
    const proto = String(req.headers['x-forwarded-proto'] || req.protocol || 'https').split(',')[0].trim();
    const host = String(req.headers['x-forwarded-host'] || req.get('host') || '').split(',')[0].trim();
    if (!host) return '';
    const slug = String(target.slug || '/');
    const path = slug === '/' ? `/f/${f.slug}` : `/f/${f.slug}${slug.startsWith('/') ? slug : '/' + slug}`;
    return `${proto}://${host}${path}?s=${encodeURIComponent(session.id)}`;
  } catch (e) {
    console.error('[checkout] redirect resolve failed (non-fatal):', e.message);
    return '';
  }
}

router.post('/whop/create-session', async (req, res) => {
  try {
    if (!(await rateLimit(req, res, 'whop-create', 20))) return;
    await ensureCheckoutTables();
    const sessionId = String(req.body?.session_id || '').slice(0, 80);
    if (!sessionId) {
      return res.status(422).json({ success: false, error: { code: 'session_required' } });
    }
    const rows = await pgQuery(
      `SELECT id, funnel_id, page_id, status, total, currency FROM co_sessions WHERE id = $1`,
      [sessionId]
    );
    if (!rows.length) {
      return res.status(404).json({ success: false, error: { code: 'not_found' } });
    }
    const session = rows[0];
    if (session.status !== 'processing') {
      return res.status(409).json({ success: false, error: { code: 'session_not_payable' } });
    }
    const { resolveCredential } = await import('../services/gatewayConfigs.js');
    const whop = await import('../services/gateways/whop.js');
    const creds = {
      api_key: await resolveCredential(session.funnel_id || '', 'whop', 'api_key'),
      company_id: await resolveCredential(session.funnel_id || '', 'whop', 'company_id'),
    };
    if (!creds.api_key || !creds.company_id) {
      return res.status(503).json({ success: false, error: { code: 'gateway_not_configured' } });
    }
    const redirectUrl = await resolveRedirectUrl(req, session);
    const result = await whop.createCheckoutSession(creds, {
      amount: Number(session.total),
      currency: session.currency,
      metadata: { co_session_id: session.id, kind: '0' },
      redirectUrl,
    });
    if (!result.ok) {
      console.error('[checkout] whop create-session failed:', result.error, result.detail || '');
      const code = result.error === 'not_configured' ? 503 : 502;
      return res.status(code).json({
        success: false,
        error: { code: result.error === 'not_configured' ? 'gateway_not_configured' : 'gateway_error' },
      });
    }
    // Guarded on 'processing' — see the Stripe mint above.
    await pgQuery(
      `UPDATE co_sessions SET gateway = 'whop', gateway_session_id = $2, updated_at = NOW()
       WHERE id = $1 AND status = 'processing'`,
      [session.id, result.session_id]
    );
    return res.json({
      success: true,
      data: {
        whop_session_id: result.session_id, // ch_… → embed sessionId
        purchase_url: result.purchase_url,
        redirect_url: redirectUrl,

        amount: Number(session.total),
        currency: session.currency,
      },
    });
  } catch (err) {
    console.error('[checkout] whop create-session failed:', err.message);
    return res.status(500).json({ success: false, error: { code: 'internal_error' } });
  }
});

// ── 1-click post-purchase upsells ───────────────────────────────────────────
// Charged against the saved payment method of the PAID base session, through
// the SAME gateway the base paid with. Priced server-side from the linked
// co_upsells offer. Accept AND decline both write co_upsell_charges under the
// TRIPLE (session, offer, charge-slot): accepts claim `v:<variant>`, declines
// claim 'decline' — the deterministic slot makes the unique index the
// double-click/replay guard, and a $0 decline marker can never be settled.

const UPSELL_MIN_CHARGE = 1.0;

// The confirmation secret. The session id is a PUBLIC identifier (it rides in
// `?s=`, so it reaches the address bar, tracking beacons, the ad platform's
// event_source_url and the access log); it identifies a checkout but must never
// AUTHORIZE one. This token is the authorization factor: minted at
// create-session, delivered only as an HttpOnly cookie, never logged or
// beaconed, and compared in constant time against a stored SHA-256.
const CONFIRM_COOKIE = '__fos_ck';
const hashToken = (t) => crypto.createHash('sha256').update(String(t)).digest('hex');

function confirmTokenFrom(req) {
  const raw = req.cookies?.[CONFIRM_COOKIE];
  return typeof raw === 'string' ? raw.slice(0, 120) : '';
}

// Constant-time compare of two hex digests of equal length.
function digestsMatch(a, b) {
  if (!a || !b || a.length !== b.length) return false;
  try {
    return crypto.timingSafeEqual(Buffer.from(a, 'hex'), Buffer.from(b, 'hex'));
  } catch {
    return false;
  }
}

async function loadPaidSession(sessionId, req = null) {
  const rows = await pgQuery(
    `SELECT id, funnel_id, status, gateway, currency, payment_method_id,
            gateway_customer_id, refunds, confirm_token_hash
     FROM co_sessions WHERE id = $1`,
    [String(sessionId || '').slice(0, 80)]
  );
  if (!rows.length) return { error: { status: 404, code: 'session_not_found' } };
  const s = rows[0];
  // Charge authorization. Enforced whenever the session carries a token (every
  // session minted by this code does). Sessions predating the column have a
  // NULL hash and stay on the old behaviour rather than breaking mid-funnel.
  if (req && s.confirm_token_hash) {
    const presented = confirmTokenFrom(req);
    if (!digestsMatch(hashToken(presented), s.confirm_token_hash)) {
      return { error: { status: 403, code: 'confirmation_required' } };
    }
  }
  if (s.status !== 'paid') return { error: { status: 409, code: 'session_not_paid' } };
  // A chargeback must never trigger another off-session charge on that card —
  // cancelling in-flight charges (the dispute handler) is not enough if the
  // page can simply start a NEW one.
  const reversals = Array.isArray(s.refunds) ? s.refunds : [];
  if (reversals.some((r) => r && r.dispute)) {
    return { error: { status: 409, code: 'session_disputed' } };
  }
  if (reversals.length) return { error: { status: 409, code: 'session_refunded' } };
  return { session: s };
}

async function loadOffer(offerId, session) {
  const rows = await pgQuery(
    `SELECT id, funnel_id, variant_id, price, title, enabled FROM co_upsells WHERE id = $1`,
    [String(offerId || '').slice(0, 80)]
  );
  const offer = rows[0];
  if (!offer || !offer.enabled) return { error: { status: 404, code: 'offer_not_found' } };
  // An offer pinned to a funnel only serves that funnel's sessions. Strict
  // equality (not "both truthy"): a NULL-funnel offer is global by design,
  // but a PINNED offer must never be reachable from a funnel-less session.
  if (offer.funnel_id && offer.funnel_id !== (session.funnel_id || '')) {
    return { error: { status: 404, code: 'offer_not_found' } };
  }
  return { offer };
}

router.post('/upsell/accept', async (req, res) => {
  try {
    if (!(await rateLimit(req, res, 'upsell-accept', 20))) return;
    await ensureCheckoutTables();
    const body = req.body || {};
    const { session, error: sErr } = await loadPaidSession(body.session_id, req);
    if (sErr) return res.status(sErr.status).json({ success: false, error: { code: sErr.code } });
    const { offer, error: oErr } = await loadOffer(body.offer_id, session);
    if (oErr) return res.status(oErr.status).json({ success: false, error: { code: oErr.code } });

    // SPLIT-LANE HOOK (STEP 0): the offer-scope exposure denominator lands
    // BEFORE any charge claim, so the credit path can never see a credited
    // leg with no offer-arm denominator. Fail-open.
    recordSplitExposure({
      funnelId: session.funnel_id || '', sessionId: session.id,
      visitorId: String(req.cookies?._fos_vid || ''), scope: 'offer',
      offerId: offer.id,
    }).catch(() => {});

    // variant_id '' on the offer = "charge whatever the on-page selection
    // control resolves to" — the client picks WHICH variant, never the price.
    // Bound the client-supplied id (it lands in the charge_id claim slot) —
    // the offer-side id is already stored bounded.
    const variantId = offer.variant_id || String(body.variant_id || '').trim().slice(0, 80);
    if (!variantId) {
      return res.status(422).json({ success: false, error: { code: 'variant_required' } });
    }
    const qty = Math.max(1, Math.min(parseInt(body.quantity, 10) || 1, MAX_QTY_PER_LINE));

    // Server-side price authority: the operator-configured offer price, else
    // the live Shopify price. Client-sent prices are never read.
    let unit;
    let title = offer.title || '';
    if (offer.price !== null && offer.price !== undefined) {
      unit = round2(Number(offer.price));
    } else {
      let priced;
      try {
        priced = await resolveVariantPrices([variantId]);
      } catch (err) {
        if (err instanceof PricingUnavailableError) {
          return res.status(503).json({ success: false, error: { code: 'pricing_unavailable' } });
        }
        throw err;
      }
      const info = priced[toVariantGid(variantId)];
      if (!info) {
        return res.status(422).json({ success: false, error: { code: 'invalid_variant' } });
      }
      unit = round2(Number(info.price));
      title = title || info.title || '';
    }
    const amount = round2(unit * qty);
    if (amount < UPSELL_MIN_CHARGE) {
      return res.status(422).json({ success: false, error: { code: 'upsell_below_minimum' } });
    }

    // Saved-method check BEFORE any claim: base paid but no reusable PM →
    // 1-click impossible; the UI falls back to on-session card entry.
    const provider = (session.gateway || 'whop').toLowerCase();
    const savedPmOk = Boolean(session.gateway_customer_id && session.payment_method_id);
    if (!savedPmOk) {
      return res.json({
        success: true,
        data: { status: 'requires_payment_method', provider, amount, currency: session.currency },
      });
    }

    // Atomic CLAIM of the (session, offer, `v:<variant>`) slot — the unique
    // index arbitrates double-clicks, replays and concurrent tabs.
    const chargeRowId = `ux_${crypto.randomBytes(12).toString('hex')}`;
    const claimSlot = `v:${variantId}`;
    const lineItems = [{ variant_id: variantId, quantity: qty, unit_price: unit, title }];
    let claimed = await pgQuery(
      `INSERT INTO co_upsell_charges
         (id, session_id, offer_id, charge_id, amount, currency, status, line_items)
       VALUES ($1, $2, $3, $4, $5, $6, 'charging', $7)
       ON CONFLICT (session_id, offer_id, charge_id) DO NOTHING
       RETURNING id`,
      [chargeRowId, session.id, offer.id, claimSlot, amount, session.currency, lineItems]
    );
    let rowId = chargeRowId;
    if (!claimed.length) {
      const [existing] = await pgQuery(
        `SELECT id, status, amount, currency, gateway_payment_id FROM co_upsell_charges
         WHERE session_id = $1 AND offer_id = $2 AND charge_id = $3`,
        [session.id, offer.id, claimSlot]
      );
      if (existing?.status === 'settled') {
        return res.json({
          success: true,
          data: {
            status: 'already_purchased', duplicate: true,
            charge_row: existing.id, amount: Number(existing.amount), currency: existing.currency,
          },
        });
      }
      if (existing?.status === 'charging' || existing?.status === 'pending_settlement') {
        // Another request is mid-charge / awaiting async settlement — the
        // page keeps POLLING; never re-drive a possibly-succeeding charge.
        return res.json({ success: true, data: { status: 'processing', duplicate: true } });
      }
      // Prior attempt DECLINED — re-claim the SAME row for a fresh attempt.
      // Idempotency stays keyed to the row + the deterministic gateway key,
      // so this can never double-charge a success.
      // Only a CLEAN terminal failure is re-claimable. 'needs_review' is the
      // state that means "we cannot prove whether the gateway charged"
      // (stale claim / amount mismatch) and 'canceled' means a dispute killed
      // it — re-driving either would be exactly the auto-retry that mints
      // duplicate charges (DECISIONS rule 3). Those need a human, not a retry.
      const reclaimed = await pgQuery(
        `UPDATE co_upsell_charges
         SET status = 'charging', error = NULL, amount = $4, line_items = $5, updated_at = NOW()
         WHERE session_id = $1 AND offer_id = $2 AND charge_id = $3
           AND status NOT IN ('settled', 'charging', 'pending_settlement',
                              'needs_review', 'canceled')
         RETURNING id`,
        [session.id, offer.id, claimSlot, amount, lineItems]
      );
      if (!reclaimed.length) {
        return res.json({ success: true, data: { status: 'processing', duplicate: true } });
      }
      rowId = reclaimed[0].id;
    }

    // Charge OFF-SESSION through the base session's own gateway, idempotent
    // on a deterministic key (a network retry can never double-bill).
    const idemKey = `upsell:${session.id}:${offer.id}:${variantId}`;
    const { resolveCredential } = await import('../services/gatewayConfigs.js');
    let outcome;
    if (provider === 'stripe') {
      const { chargeOffSession } = await import('../services/gateways/stripe.js');
      const secretKey = await resolveCredential(session.funnel_id || '', 'stripe', 'secret_key');
      const r = await chargeOffSession(secretKey, {
        amount, currency: session.currency,
        customerId: session.gateway_customer_id,
        paymentMethodId: session.payment_method_id,
        metadata: { co_session_id: session.id, kind: 'upsell', charge_row: rowId },
        idempotencyKey: idemKey,
      });
      if (r.ok) outcome = { status: 'settled', paymentId: r.id };
      // TRANSPORT failure ≠ decline: the charge may have succeeded with the
      // response lost. Hold non-terminal so the webhook/sweep decides — never
      // mark it declined (that would strand a real charge, and a later
      // re-accept could double-bill once Stripe's idempotency key expires).
      else if (r.transport) outcome = { status: 'pending', paymentId: r.id || '' };
      else outcome = { status: 'declined', reason: r.decline_code || r.error, requiresAction: Boolean(r.requires_action) };
    } else {
      const whop = await import('../services/gateways/whop.js');
      const creds = {
        api_key: await resolveCredential(session.funnel_id || '', 'whop', 'api_key'),
        company_id: await resolveCredential(session.funnel_id || '', 'whop', 'company_id'),
      };
      const r = await whop.chargeSavedPaymentMethod(creds, {
        amount, currency: session.currency,
        memberId: session.gateway_customer_id,
        paymentMethodId: session.payment_method_id,
        metadata: { co_session_id: session.id, kind: 'upsell', charge_row: rowId, offer_id: offer.id },
        idempotencyKey: idemKey,
      });
      if (r.ok) outcome = { status: 'settled', paymentId: r.payment_id };
      else if (r.pending || r.error === 'network') outcome = { status: 'pending', paymentId: r.payment_id || '' };
      else outcome = { status: 'declined', reason: r.decline_code || r.error, requiresAction: r.error === 'requires_action' };
    }

    if (outcome.status === 'settled') {
      const { settleUpsellCharge } = await import('../services/checkoutSettle.js');
      const settled = await settleUpsellCharge({
        chargeRowId: rowId, gatewayPaymentId: outcome.paymentId, amount,
        expectedSessionId: session.id,
      });
      if (!settled.ok) {
        // Money MOVED but the row could not be flipped (a concurrent dispute
        // canceled it, or an async payment.failed already declined it). Never
        // report a clean 'settled' over a charge the books don't reflect —
        // park it for a human with the gateway id attached.
        console.error(
          `[checkout] upsell charged but not recorded row=${rowId} payment=${outcome.paymentId} err=${settled.error}`
        );
        await pgQuery(
          `UPDATE co_upsell_charges
           SET status = 'needs_review',
               gateway_payment_id = COALESCE($2, gateway_payment_id),
               error = $3, updated_at = NOW()
           WHERE id = $1 AND status <> 'settled'`,
          [rowId, outcome.paymentId || null, `charged_not_recorded:${settled.error}`.slice(0, 200)]
        );
        return res.json({
          success: true,
          data: { status: 'needs_review', charge_row: rowId, amount, currency: session.currency },
        });
      }
      return res.json({
        success: true,
        data: { status: 'settled', charge_row: rowId, amount, currency: session.currency },
      });
    }
    if (outcome.status === 'pending') {
      // Gateway ACCEPTED but hasn't settled — hold non-terminal; the
      // payment.succeeded/failed webhook (or the sweep) is the authority.
      await pgQuery(
        `UPDATE co_upsell_charges
         SET status = 'pending_settlement', gateway_payment_id = $2, updated_at = NOW()
         WHERE id = $1 AND status = 'charging'`,
        [rowId, outcome.paymentId || null]
      );
      return res.json({ success: true, data: { status: 'processing', charge_row: rowId } });
    }
    const { failUpsellCharge } = await import('../services/checkoutSettle.js');
    await failUpsellCharge({ chargeRowId: rowId, reason: outcome.reason, expectedSessionId: session.id });
    return res.json({
      success: true,
      data: {
        status: outcome.requiresAction ? 'requires_action' : 'declined',
        charge_row: rowId, reason: outcome.reason,
      },
    });
  } catch (err) {
    console.error('[checkout] upsell accept failed:', err.message);
    return res.status(500).json({ success: false, error: { code: 'internal_error' } });
  }
});

// POST /upsell/decline — record the decline marker (the take-rate
// denominator). Idempotent on the TRIPLE (session, offer, 'decline'); a $0
// declined_by_user row that settlement can never touch.
router.post('/upsell/decline', async (req, res) => {
  try {
    if (!(await rateLimit(req, res, 'upsell-decline', 30))) return;
    await ensureCheckoutTables();
    const { session, error: sErr } = await loadPaidSession(req.body?.session_id, req);
    if (sErr) return res.status(sErr.status).json({ success: false, error: { code: sErr.code } });
    const { offer, error: oErr } = await loadOffer(req.body?.offer_id, session);
    if (oErr) return res.status(oErr.status).json({ success: false, error: { code: oErr.code } });
    // SPLIT-LANE HOOK: a decline is an exposure too — the arm was SHOWN. The
    // denominator must count it or the shown-but-declined arm looks better
    // than it is. Fail-open.
    recordSplitExposure({
      funnelId: session.funnel_id || '', sessionId: session.id,
      visitorId: String(req.cookies?._fos_vid || ''), scope: 'offer',
      offerId: offer.id,
    }).catch(() => {});
    await pgQuery(
      `INSERT INTO co_upsell_charges
         (id, session_id, offer_id, charge_id, amount, currency, status, declined_by_user)
       VALUES ($1, $2, $3, 'decline', 0, $4, 'declined', TRUE)
       ON CONFLICT (session_id, offer_id, charge_id) DO NOTHING`,
      [`ux_${crypto.randomBytes(12).toString('hex')}`, session.id, offer.id, session.currency]
    );
    try {
      await pgQuery(
        `INSERT INTO co_events (session_id, kind, data) VALUES ($1, 'upsell_declined_by_user', $2)`,
        [session.id, { offer_id: offer.id }]
      );
    } catch { /* non-fatal */ }
    return res.json({ success: true, data: { status: 'declined' } });
  } catch (err) {
    console.error('[checkout] upsell decline failed:', err.message);
    return res.status(500).json({ success: false, error: { code: 'internal_error' } });
  }
});

// GET /upsell/offer — server-priced DISPLAY data for the buyer-facing 1-click
// upsell page. Read-only: it NEVER writes a charge (accept does that). Prices
// are resolved SERVER-SIDE (the operator-set offer price, else the live
// Shopify price); the client never sends, and cannot influence, an amount — it
// only names WHICH offer (by explicit id, else the offer bound to the page,
// else the offer bound to the session's funnel). The accept path re-prices
// independently and is the authority for what is charged.
router.get('/upsell/offer', async (req, res) => {
  try {
    if (!(await rateLimit(req, res, 'upsell-offer', 60))) return;
    await ensureCheckoutTables();
    const sessionId = String(req.query.session_id || '').slice(0, 80);
    if (!sessionId) {
      return res.status(422).json({ success: false, error: { code: 'session_required' } });
    }
    const srows = await pgQuery(
      `SELECT id, funnel_id, currency FROM co_sessions WHERE id = $1`,
      [sessionId]
    );
    const session = srows[0];
    if (!session) {
      return res.status(404).json({ success: false, error: { code: 'session_not_found' } });
    }

    // Resolve WHICH offer to show: explicit offer_id wins; else the enabled
    // offer bound to the page (page_id); else the enabled offer bound to the
    // session's funnel. Newest wins when several are bound.
    const offerId = String(req.query.offer_id || '').slice(0, 80);
    const pageId = String(req.query.page_id || '').slice(0, 64);
    let offer = null;
    if (offerId) {
      const r = await pgQuery(
        `SELECT id, funnel_id, variant_id, price, title, enabled FROM co_upsells WHERE id = $1`,
        [offerId]
      );
      offer = r[0] || null;
    } else if (pageId) {
      const r = await pgQuery(
        `SELECT id, funnel_id, variant_id, price, title, enabled FROM co_upsells
         WHERE page_id = $1 AND enabled = TRUE ORDER BY created_at DESC LIMIT 1`,
        [pageId]
      );
      offer = r[0] || null;
    } else if (session.funnel_id) {
      const r = await pgQuery(
        `SELECT id, funnel_id, variant_id, price, title, enabled FROM co_upsells
         WHERE funnel_id = $1 AND enabled = TRUE ORDER BY created_at DESC LIMIT 1`,
        [session.funnel_id]
      );
      offer = r[0] || null;
    }
    if (!offer || !offer.enabled) {
      return res.status(404).json({ success: false, error: { code: 'offer_not_found' } });
    }
    // Same funnel-pin gate as the accept path: a pinned offer only serves its
    // own funnel's sessions (a NULL-funnel offer is global by design).
    if (offer.funnel_id && offer.funnel_id !== (session.funnel_id || '')) {
      return res.status(404).json({ success: false, error: { code: 'offer_not_found' } });
    }

    // SPLIT DELIVERY: the visitor's assigned arm overrides WHICH offer is
    // shown (the response's offer_id drives the later accept/decline, so the
    // whole flow follows the arm). Fail-open — no live test, no arm offer, or
    // any error keeps the default offer resolved above.
    const armOffer = await resolveOfferArmOverride({
      funnelId: session.funnel_id || '',
      visitorId: String(req.cookies?._fos_vid || ''),
      shownOfferId: offer.id,
    });
    if (armOffer && armOffer.id !== offer.id) offer = armOffer;

    // DISPLAY-time exposure (review finding): buyers who SEE the offer and
    // close the tab must be in the denominator, or silent abandonment biases
    // exactly the arm that causes it. Idempotent per (session, test); the
    // accept/decline hooks below collide into no-ops. Fail-open.
    recordSplitExposure({
      funnelId: session.funnel_id || '', sessionId: session.id,
      visitorId: String(req.cookies?._fos_vid || ''), scope: 'offer',
      offerId: offer.id,
    }).catch(() => {});

    const variantId = offer.variant_id || '';
    const hasFixedPrice = offer.price !== null && offer.price !== undefined;

    // Live variant data (image + regular price to strike through) — best
    // effort. The charged price is authoritative from offer.price when set;
    // only when it is NULL must we resolve the live price (and a pricing outage
    // there is a RETRYABLE 503, never a silent wrong price).
    let live = null;
    if (variantId) {
      try {
        const priced = await resolveVariantPrices([variantId]);
        live = priced[toVariantGid(variantId)] || null;
      } catch (err) {
        if (err instanceof PricingUnavailableError) {
          if (!hasFixedPrice) {
            return res.status(503).json({ success: false, error: { code: 'pricing_unavailable' } });
          }
          // Fixed price set → we can still show the charged amount with no
          // image/original; degrade rather than block the offer.
        } else {
          throw err;
        }
      }
    }

    let charged;
    let original = null;
    if (hasFixedPrice) {
      charged = round2(Number(offer.price));
      if (live && Number(live.price) > charged) original = round2(Number(live.price));
      else if (live && live.compare_at_price) original = round2(Number(live.compare_at_price));
    } else {
      if (!live) {
        // variant_id '' (client-selected) with no fixed price → nothing to show.
        return res.status(422).json({ success: false, error: { code: 'invalid_variant' } });
      }
      charged = round2(Number(live.price));
      original = live.compare_at_price ? round2(Number(live.compare_at_price)) : null;
    }
    if (!Number.isFinite(charged) || charged < 0) {
      return res.status(422).json({ success: false, error: { code: 'invalid_price' } });
    }

    const currency = (live && live.currency) || session.currency || 'USD';
    const title = offer.title || (live && (live.product_title || live.title)) || 'Special offer';
    const image = (live && live.image) || '';
    const discountPct =
      original && original > charged
        ? Math.round(((original - charged) / original) * 100)
        : null;

    return res.json({
      success: true,
      data: {
        offer_id: offer.id,
        variant_id: variantId,
        title,
        image,
        price: charged,
        original_price: original,
        discount_pct: discountPct,
        currency,
      },
    });
  } catch (err) {
    console.error('[checkout] upsell offer failed:', err.message);
    return res.status(500).json({ success: false, error: { code: 'internal_error' } });
  }
});

// GET /session/:id — safe public snapshot (thank-you / upsell pages poll
// this). Hand-picked fields, an allow-list: no tracking net, no customer PII
// beyond nothing, no gateway internals.
// POST /session/:id/customer — attach the buyer's contact + delivery details to
// a session that has not settled yet.
//
// The checkout mints its session on PAGE LOAD, before the buyer has typed
// anything, so without this the session's customer stays EMPTY and the Shopify
// order is created with no shipping or billing address — which is exactly what
// the first real order showed. Authorised by the same HttpOnly confirmation
// token as the charge path, so a leaked session id cannot rewrite someone
// else's delivery address, and refused once the session is settled: an address
// change after payment must go through support, not a public endpoint.
router.post('/session/:id/customer', async (req, res) => {
  try {
    if (!(await rateLimit(req, res, 'session-customer', 60))) return;
    await ensureCheckoutTables();
    const id = String(req.params.id || '').slice(0, 80);
    const rows = await pgQuery(
      `SELECT id, status, confirm_token_hash FROM co_sessions WHERE id = $1`, [id]
    );
    if (!rows.length) return res.status(404).json({ success: false, error: { code: 'session_not_found' } });
    const s = rows[0];
    if (s.confirm_token_hash
      && !digestsMatch(hashToken(confirmTokenFrom(req)), s.confirm_token_hash)) {
      return res.status(403).json({ success: false, error: { code: 'confirmation_required' } });
    }
    if (s.status !== 'processing') {
      return res.status(409).json({ success: false, error: { code: 'session_not_editable' } });
    }
    const customer = cleanCustomer(req.body || {});
    await pgQuery(
      `UPDATE co_sessions SET customer = $2, updated_at = NOW()
       WHERE id = $1 AND status = 'processing'`,
      [id, customer]
    );
    return res.json({ success: true, data: { saved: true } });
  } catch (err) {
    console.error('[checkout] session customer update failed:', err.message);
    return res.status(500).json({ success: false, error: { code: 'internal_error' } });
  }
});

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
