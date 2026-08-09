// Abandoned Checkouts — CRM Lane 1. People who started buying but never paid:
// recoverable revenue. TWO populations feed ONE list, because Puure sells
// through two front doors:
//
//   • 'shopify' — Shopify's own abandoned checkouts, pulled from the checkouts
//     API (webhook-less; synced on demand + on list load when stale). Shopify
//     mints its own recovery URL for these.
//   • 'funnel'  — our funnel checkout sessions (co_sessions) that captured an
//     email and never settled. These carts are ours, so the recovery link is
//     ours to sign (see the RESUME CONTRACT below).
//
// Gated under orders:access — same audience as Orders, deliberately no extra
// permission.
//
// WHAT THIS FILE MAY NOT DO: it never writes co_sessions, never creates an
// order, never calls a gateway. The only writes are the recovery sidecar
// (crm_recovery_meta) and the Shopify mirror table. Classification, link
// signing and cart shaping all live in services/abandonedRecovery.js and are
// covered by server/tests/abandoned/recovery.mjs.
//
// ───────────────────────────────────────────────────────────────────────────
// RESUME CONTRACT — OWED BY THE INTEGRATOR (the money path is not ours)
//
//   GET /api/v1/checkout/public/resume/:token        (PUBLIC, no auth)
//
//   The token is minted here and travels in the recovery email. It is opaque
//   to the buyer and carries no PII. Verify it with:
//
//     import { verifyRecoveryToken } from '../services/abandonedRecovery.js';
//     const claims = verifyRecoveryToken(req.params.token);   // null on ANY failure
//     // claims === { source: 'funnel'|'shopify', ref: '<id>', expires_at }
//
//   Required behavior:
//     • claims === null                → 302 to the storefront home. NEVER leak
//       whether the token was forged, expired, or malformed.
//     • claims.source === 'shopify'    → 302 to crm_abandoned_checkouts
//       .recovery_url for that checkout_id (Shopify owns that revival).
//     • claims.source === 'funnel'     → load co_sessions by claims.ref and:
//         - if status = 'paid' OR paid_at IS NOT NULL → 302 to the funnel's
//           thank-you page. NEVER re-open a settled cart (double-charge vector).
//         - else → 302 to the session's checkout page with
//           ?resume=<ref>&co_session_id=<ref> so the page runtime rehydrates
//           the cart + contact fields and the funnel picks the journey back up.
//     • The endpoint must NOT mint a new gateway session, must NOT mutate
//       co_sessions.status, and must NOT extend the token's life.
//     • Rate-limit it (it is unauthenticated) and log a 'resume' co_events row
//       for the session so the journey shows the click.
//
//   Everything up to that endpoint is already built: the signed token, the
//   sidecar record, the admin UI action, and the Klaviyo event that carries
//   the link. Until the endpoint exists the link 404s — nothing else breaks.
// ───────────────────────────────────────────────────────────────────────────
import { Router } from 'express';
import { pgQuery } from '../db/pg.js';
import { authenticate } from '../middleware/auth.js';
import { requirePermission } from '../middleware/rbac.js';
import { checkRateLimit } from '../middleware/rateLimiter.js';
import {
  RECOVERY_STATUSES,
  RecoverySecretError,
  SOURCES,
  abandonGraceSeconds,
  buildRecoveryRecord,
  cartSummary,
  classifyCheckout,
  ensureRecoveryTables,
  hasRecoverySecret,
  markUndeliverable,
  readRecoveryMeta,
  recoveryWindowDays,
  sanitizeEmail,
  sendRecoveryEvent,
  upsertRecoveryMeta,
} from '../services/abandonedRecovery.js';

const router = Router();

router.use(authenticate, requirePermission('orders', 'access'));

// Per-operator rate limits. Every one of these endpoints can send REAL email
// (the sweep up to 500 in a press) or hammer Shopify, so the gate is on the
// user id, not the IP — two operators behind one office NAT must not share a
// budget, and one operator on two devices must not get double.
async function rateLimit(req, res, bucket, limit, windowSec) {
  const who = req.user?.id || req.user?.userId || 'unknown';
  const { allowed, retryAfter } = await checkRateLimit(`abandoned:${bucket}:${who}`, limit, windowSec);
  if (!allowed) {
    res.status(429).json({ error: `Too many ${bucket} requests — retry in ${retryAfter}s`, retryAfter });
    return false;
  }
  return true;
}

let tablesReadyPromise = null;

function ensureTables() {
  if (!tablesReadyPromise) {
    tablesReadyPromise = createTables().catch((err) => {
      tablesReadyPromise = null;
      throw err;
    });
  }
  return tablesReadyPromise;
}

async function createTables() {
  await pgQuery(`
    CREATE TABLE IF NOT EXISTS crm_abandoned_checkouts (
      checkout_id BIGINT PRIMARY KEY,
      token TEXT,
      email TEXT,
      customer_first_name TEXT,
      customer_last_name TEXT,
      phone TEXT,
      total_price NUMERIC(12,2) DEFAULT 0,
      currency TEXT DEFAULT 'USD',
      line_items JSONB DEFAULT '[]',
      item_count INT DEFAULT 0,
      recovery_url TEXT,
      destination_city TEXT,
      destination_state TEXT,
      destination_country TEXT,
      created_at TIMESTAMPTZ,
      updated_at TIMESTAMPTZ,
      completed_at TIMESTAMPTZ,
      raw JSONB,
      synced_at TIMESTAMPTZ DEFAULT NOW()
    )
  `);
  await pgQuery(
    `CREATE INDEX IF NOT EXISTS idx_crm_abandoned_created ON crm_abandoned_checkouts (created_at DESC)`
  );
  // Since the sync moved to status=any this table also accumulates COMPLETED
  // checkouts, which the list never shows. Every read filters
  // `completed_at IS NULL`, so a partial index keeps the scan proportional to
  // the open population instead of to everything the store has ever sold.
  await pgQuery(
    `CREATE INDEX IF NOT EXISTS idx_crm_abandoned_open
     ON crm_abandoned_checkouts (created_at DESC) WHERE completed_at IS NULL`
  );
  await ensureRecoveryTables();
}

const escapeLike = (s) => String(s).replace(/[\\%_]/g, '\\$&');

const clampInt = (raw, def, lo, hi) => {
  const n = parseInt(raw, 10);
  return Math.max(lo, Math.min(Number.isFinite(n) ? n : def, hi));
};

const SECRET_UNSET_MESSAGE =
  'CHECKOUT_RESUME_SECRET is not set — recovery links would be forgeable, so none will be issued. Set it in the environment and retry.';

// A missing signing secret is a CONFIGURATION fault, not a bug: answer 503 with
// the fix, never a generic 500 that sends the operator reading logs.
function handleRouteError(res, err, where, fallback) {
  if (err instanceof RecoverySecretError) {
    return res.status(503).json({ error: SECRET_UNSET_MESSAGE });
  }
  console.error(`[abandoned] ${where} failed:`, err);
  return res.status(500).json({ error: fallback });
}

// Shopify's checkouts feed. Both parameters here were verified against the LIVE
// store (17cca0-2.myshopify.com, API 2024-01) with read-only GETs before this
// shipped, because both encode a claim about somebody else's API:
//
// status=any (was: status=open)
//   PROBE RESULT: `status` is read — status=closed answers {"checkouts":[]} —
//   but status=any and status=open returned BYTE-IDENTICAL bodies (26,163 B,
//   same 5 ids), because this store has zero "closed" checkouts.
//   The probe also REFUTED the reason this was changed. Completed checkouts do
//   NOT leave the open feed: 2 of the 5 oldest rows carry a completed_at
//   (2025-03-31, 2025-03-20) and are returned under status=open as well. So the
//   mirror was already able to learn completion, and `any` is kept only because
//   it is a superset by definition and costs nothing — NOT because it fixed a
//   demonstrated production failure. Do not re-derive that story from this line.
//
// created_at_min (new)
//   PROBE RESULT: honoured — a 90-day floor dropped the 2025 rows and cleared
//   the `rel="next"` link; a 1-day floor returned {"checkouts":[]} (16 B).
//   This one IS load-bearing. The feed is ordered OLDEST-FIRST (ascending id),
//   so the old unbounded crawl started at the store's most ancient checkouts
//   and, on a store with more than 40×250 = 10,000 of them, would exhaust the
//   page cap before ever reaching a recoverable cart. The floor is 90 days
//   because the list's own maximum window is 90 and the sweep looks back at
//   most 30. Rows outside it are never deleted — the upsert just stops
//   refreshing them.
//
// `limit` was probed too (5 → 2 shrank the result), so the page size is real
// and the 40-page cap means what it says.
const SYNC_LOOKBACK_DAYS = 90;
const MAX_429_RETRIES = 5;

async function syncFromShopify() {
  const store = process.env.PUURE_SHOPIFY_STORE || process.env.SHOPIFY_STORE_DOMAIN;
  const token = process.env.PUURE_SHOPIFY_TOKEN || process.env.SHOPIFY_ACCESS_TOKEN;
  const apiVersion = process.env.SHOPIFY_API_VERSION || '2024-01';
  if (!store || !token) {
    throw new Error('Shopify not configured (SHOPIFY_STORE_DOMAIN / SHOPIFY_ACCESS_TOKEN)');
  }
  const since = new Date(Date.now() - SYNC_LOOKBACK_DAYS * 86400000).toISOString();
  let url = `https://${store}/admin/api/${apiVersion}/checkouts.json?limit=250&status=any`
    + `&created_at_min=${encodeURIComponent(since)}`;
  let imported = 0;
  let pages = 0;
  let throttled = 0;
  while (url && pages < 40) {
    const resp = await fetch(url, { headers: { 'X-Shopify-Access-Token': token } });
    if (resp.status === 429) {
      // `continue` does NOT advance `pages`, so without its own counter a
      // shop that stays throttled spins here forever, holding the request.
      throttled += 1;
      if (throttled > MAX_429_RETRIES) {
        throw new Error(`Shopify rate limit: still 429 after ${MAX_429_RETRIES} retries — try again later`);
      }
      const wait = parseFloat(resp.headers.get('retry-after') || '2') * 1000;
      await new Promise((r) => setTimeout(r, Math.min(Number.isFinite(wait) ? wait : 2000, 10000)));
      continue;
    }
    throttled = 0;
    if (!resp.ok) {
      const body = (await resp.text()).slice(0, 200);
      throw new Error(`Shopify checkouts fetch failed: HTTP ${resp.status} ${body}`);
    }
    const { checkouts } = await resp.json();
    for (const c of checkouts || []) {
      const ship = c.shipping_address || c.billing_address || null;
      const items = Array.isArray(c.line_items) ? c.line_items : [];
      await pgQuery(
        `
        INSERT INTO crm_abandoned_checkouts (
          checkout_id, token, email, customer_first_name, customer_last_name, phone,
          total_price, currency, line_items, item_count, recovery_url,
          destination_city, destination_state, destination_country,
          created_at, updated_at, completed_at, raw, synced_at
        ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,NOW())
        ON CONFLICT (checkout_id) DO UPDATE SET
          email = COALESCE(EXCLUDED.email, crm_abandoned_checkouts.email),
          total_price = EXCLUDED.total_price,
          line_items = EXCLUDED.line_items,
          item_count = EXCLUDED.item_count,
          recovery_url = COALESCE(EXCLUDED.recovery_url, crm_abandoned_checkouts.recovery_url),
          updated_at = EXCLUDED.updated_at,
          completed_at = EXCLUDED.completed_at,
          raw = EXCLUDED.raw,
          synced_at = NOW()
        `,
        [
          c.id,
          c.token || null,
          c.email || null,
          c.customer?.first_name || ship?.first_name || null,
          c.customer?.last_name || ship?.last_name || null,
          c.phone || c.customer?.phone || null,
          parseFloat(c.total_price || 0),
          c.currency || 'USD',
          items,
          items.reduce((n, li) => n + (parseInt(li.quantity, 10) || 0), 0),
          c.abandoned_checkout_url || null,
          ship?.city || null,
          ship?.province_code || ship?.province || null,
          ship?.country_code || ship?.country || null,
          c.created_at,
          c.updated_at,
          c.completed_at || null,
          c,
        ]
      );
      imported += 1;
    }
    pages += 1;
    const link = resp.headers.get('link') || '';
    const next = link.split(',').find((p) => p.includes('rel="next"'));
    url = next ? next.match(/<([^>]+)>/)?.[1] : null;
    if (url) await new Promise((r) => setTimeout(r, 550));
  }
  return imported;
}

// The inline auto-sync on GET / used to be unlocked: two operators opening the
// page together (or one double-clicking) each ran a full 40-page Shopify crawl
// concurrently, and the losers' writes were pure waste. One in-process promise
// serializes them, and a recency floor makes the second caller a no-op instead
// of a second crawl. Explicit POST /sync bypasses the floor (but not the lock)
// — pressing "Sync now" must actually sync.
let syncInFlight = null;
let lastSyncAt = 0;
const SYNC_MIN_INTERVAL_MS = 60_000;

function syncFromShopifyGuarded({ force = false } = {}) {
  if (!force && Date.now() - lastSyncAt < SYNC_MIN_INTERVAL_MS && !syncInFlight) {
    return Promise.resolve({ imported: 0, skipped: 'recent' });
  }
  if (!syncInFlight) {
    syncInFlight = syncFromShopify()
      .then((imported) => ({ imported }))
      .finally(() => {
        // The floor is stamped in `finally`, so a FAILING Shopify counts as an
        // attempt. Stamping only on success meant a store with bad credentials
        // (or a sustained 429) launched a fresh 40-page crawl attempt on every
        // single list load, forever, with the error swallowed into a log line.
        lastSyncAt = Date.now();
        syncInFlight = null;
      });
  }
  return syncInFlight;
}

// ── the unified read model ──────────────────────────────────────────────────
// One CTE per population, UNION ALL, then the recovery sidecar joined on
// (source, ref_id). BOTH legs are windowed on created_at — the funnel leg
// scans co_sessions, which is the money spine, so an unbounded scan is never
// acceptable here.
//
// `unpaid` for a funnel session is expressed NEGATIVELY (status <> 'paid' AND
// paid_at IS NULL) rather than as a list of pending statuses: a new status
// added elsewhere must not silently start emailing recovery links to buyers.
const UNIFIED_CTE = `
  WITH funnel AS (
    SELECT
      'funnel'::text                              AS source,
      s.id::text                                  AS ref_id,
      NULLIF(s.customer->>'email', '')            AS email,
      NULLIF(s.customer->>'first_name', '')       AS customer_first_name,
      NULLIF(s.customer->>'last_name', '')        AS customer_last_name,
      NULLIF(s.customer->>'phone', '')            AS phone,
      s.total                                     AS total_price,
      s.currency                                  AS currency,
      s.line_items                                AS line_items,
      s.funnel_id                                 AS funnel_id,
      NULL::text                                  AS recovery_url,
      NULLIF(s.customer->'shipping'->>'city', '')     AS destination_city,
      NULLIF(s.customer->'shipping'->>'state', '')    AS destination_state,
      NULLIF(s.customer->'shipping'->>'country', '')  AS destination_country,
      s.status                                    AS status,
      s.paid_at                                   AS paid_at,
      s.created_at                                AS created_at
    FROM co_sessions s
    WHERE s.status <> 'paid'
      AND s.paid_at IS NULL
      AND s.created_at >= $1
      AND s.created_at < $2
      AND COALESCE(s.customer->>'email', '') <> ''
  ),
  shop AS (
    SELECT
      'shopify'::text                             AS source,
      c.checkout_id::text                         AS ref_id,
      c.email,
      c.customer_first_name,
      c.customer_last_name,
      c.phone,
      c.total_price,
      c.currency,
      c.line_items,
      NULL::text                                  AS funnel_id,
      c.recovery_url,
      c.destination_city,
      c.destination_state,
      c.destination_country,
      NULL::text                                  AS status,
      c.completed_at                              AS paid_at,
      c.created_at
    FROM crm_abandoned_checkouts c
    WHERE c.completed_at IS NULL
      AND c.created_at >= $1
      AND c.created_at < $2
  ),
  unified AS (SELECT * FROM funnel UNION ALL SELECT * FROM shop),
  joined AS (
    SELECT u.*,
           COALESCE(m.recovery_status, 'Not recovered') AS recovery_status,
           m.sent_at, m.recovered_at, m.recovered_value, m.link_url,
           COALESCE(m.undeliverable, FALSE) AS undeliverable
    FROM unified u
    LEFT JOIN crm_recovery_meta m
      ON m.source = u.source AND m.ref_id = u.ref_id
  )
`;

// Builds the WHERE clause applied to `joined` plus its params. $1/$2 are the
// window bounds and are always present, so extra params start at $3.
function listFilters(query, params) {
  const clauses = [];
  if (SOURCES.includes(query.source)) {
    params.push(query.source);
    clauses.push(`source = $${params.length}`);
  }
  const status = String(query.status || '').trim();
  if (RECOVERY_STATUSES.includes(status)) {
    params.push(status);
    clauses.push(`recovery_status = $${params.length}`);
  }
  if (query.q) {
    params.push(`%${escapeLike(query.q)}%`);
    const i = params.length;
    clauses.push(
      `(email ILIKE $${i} OR (COALESCE(customer_first_name,'') || ' ' || COALESCE(customer_last_name,'')) ILIKE $${i})`
    );
  }
  return clauses.length ? `WHERE ${clauses.join(' AND ')}` : '';
}

function shapeRow(r, graceSeconds, now) {
  const verdict = classifyCheckout(r, {
    now,
    graceSeconds,
    recoveryStatus: r.recovery_status,
  });
  const cart = cartSummary(r.line_items);
  return {
    source: r.source,
    ref_id: r.ref_id,
    id: `${r.source}:${r.ref_id}`,
    email: r.email,
    customer_first_name: r.customer_first_name,
    customer_last_name: r.customer_last_name,
    phone: r.phone,
    total_price: Number(r.total_price) || 0,
    currency: r.currency || 'USD',
    funnel_id: r.funnel_id || null,
    item_count: cart.item_count,
    items: cart.items.slice(0, 6),
    line_items: cart.items,
    destination_city: r.destination_city,
    destination_state: r.destination_state,
    destination_country: r.destination_country,
    created_at: r.created_at,
    recovery_status: r.recovery_status,
    recovery_url: r.recovery_url || r.link_url || null,
    link_url: r.link_url || null,
    sent_at: r.sent_at || null,
    recovered_at: r.recovered_at || null,
    recovered_value: r.recovered_value == null ? null : Number(r.recovered_value),
    undeliverable: Boolean(r.undeliverable),
    state: verdict.state,
    nudgeable: verdict.nudgeable && !r.undeliverable,
    state_reason: verdict.reason,
  };
}

// Recovered-attribution sweep. We may NOT hook the settle path (the money
// path is another lane's file), so attribution is a WINDOWED sweep instead:
//
//   • a Shopify checkout that later completed → self-recovered.
//   • a nudged cart whose email later paid a funnel session AFTER the nudge →
//     recovered, credited with that session's total.
//
// Both sides are bounded by the recovery window; the sidecar is the only thing
// written. Idempotent: only rows still at 'Sent' are touched.
async function reconcileRecovered({ windowDays }) {
  await ensureTables();
  const since = new Date(Date.now() - windowDays * 86400000);
  const sent = await pgQuery(
    `SELECT source, ref_id, sent_at FROM crm_recovery_meta
     WHERE recovery_status = 'Sent' AND sent_at IS NOT NULL AND sent_at >= $1
     ORDER BY sent_at DESC, source ASC, ref_id ASC LIMIT 1000`,
    [since]
  );
  if (!sent.length) return { checked: 0, recovered: 0 };

  const funnelRefs = sent.filter((r) => r.source === 'funnel').map((r) => r.ref_id);
  const shopRefs = sent.filter((r) => r.source === 'shopify').map((r) => r.ref_id);

  const carts = new Map(); // `${source}:${ref}` -> { email, funnel_id, completed_at, total }
  if (funnelRefs.length) {
    const rows = await pgQuery(
      `SELECT id::text AS ref_id, lower(NULLIF(customer->>'email','')) AS email, funnel_id, created_at
       FROM co_sessions WHERE id = ANY($1)`,
      [funnelRefs]
    );
    for (const r of rows) {
      carts.set(`funnel:${r.ref_id}`, {
        email: r.email || '', funnel_id: r.funnel_id || null, created_at: r.created_at,
      });
    }
  }
  if (shopRefs.length) {
    const rows = await pgQuery(
      `SELECT checkout_id::text AS ref_id, lower(email) AS email, completed_at, total_price, created_at
       FROM crm_abandoned_checkouts WHERE checkout_id::text = ANY($1)`,
      [shopRefs]
    );
    for (const r of rows) {
      carts.set(`shopify:${r.ref_id}`, {
        email: r.email || '',
        funnel_id: null,
        completed_at: r.completed_at,
        total: r.total_price,
        created_at: r.created_at,
      });
    }
  }

  const paid = await pgQuery(
    `SELECT id, lower(NULLIF(customer->>'email','')) AS email, funnel_id, paid_at, total
     FROM co_sessions
     WHERE status = 'paid' AND paid_at IS NOT NULL AND paid_at >= $1
     ORDER BY paid_at ASC LIMIT 2000`,
    [since]
  );
  const paidByEmail = new Map();
  for (const p of paid) {
    if (!p.email) continue;
    if (!paidByEmail.has(p.email)) paidByEmail.set(p.email, []);
    paidByEmail.get(p.email).push(p);
  }
  // ONE payment can only recover ONE cart. Without this, a buyer who abandoned
  // three carts and then paid once had all three credited — a single $500 order
  // reported as $1,500 of recovered revenue. A matched payment is CONSUMED, so
  // the second cart looking at the same email finds nothing.
  //
  // The set is SEEDED FROM THE DATABASE, not merely built inside this loop. A
  // cart credited on an earlier sweep has left the 'Sent' population, so an
  // in-memory-only guard would hand the very same payment to the NEXT cart on
  // the next run — the KPI would then climb by one cart per sweep, forever, on
  // completely static data. `recovered_by` is the durable record of which
  // payment has already been spent.
  const consumed = new Set();
  const alreadyCredited = await pgQuery(
    `SELECT recovered_by FROM crm_recovery_meta
     WHERE recovered_by IS NOT NULL AND recovered_at IS NOT NULL AND recovered_at >= $1`,
    [since]
  );
  for (const r of alreadyCredited) consumed.add(r.recovered_by);

  // WHICH cart gets the credit when a serial abandoner finally buys: the one
  // they abandoned MOST RECENTLY. That is the cart closest to the purchase and
  // the likeliest to be what they actually came back for.
  //
  // Ordering on the cart's created_at — not on sent_at — is deliberate. A
  // single sweep stamps every row it nudges within the same millisecond, so
  // sent_at carries no usable order, and whatever order it appeared to have
  // was an artifact of the sweep's own row ordering. The (source, ref_id)
  // tiebreaker then makes the result reproducible run to run, which matters
  // because this decides a money-reporting KPI.
  const cartAge = (r) => {
    const t = new Date(carts.get(`${r.source}:${r.ref_id}`)?.created_at ?? NaN).getTime();
    return Number.isFinite(t) ? t : 0;
  };
  const ordered = [...sent].sort((a, b) => {
    const d = cartAge(b) - cartAge(a);        // newest cart first
    if (d) return d;
    if (a.source !== b.source) return a.source < b.source ? -1 : 1;
    return a.ref_id < b.ref_id ? -1 : a.ref_id > b.ref_id ? 1 : 0;
  });

  let recovered = 0;
  for (const row of ordered) {
    const key = `${row.source}:${row.ref_id}`;
    const cart = carts.get(key);
    if (!cart) continue;
    const sentAt = new Date(row.sent_at).getTime();
    let match = null;
    // A Shopify checkout that COMPLETED after the nudge recovered itself —
    // there is no separate paying session to consume. `completed_at > sent_at`
    // is load-bearing: a checkout that completed BEFORE the nudge was never
    // recovered by it (that is a nudge we should not have sent at all).
    if (row.source === 'shopify' && cart.completed_at
        && new Date(cart.completed_at).getTime() > sentAt) {
      match = { id: `shopify:${row.ref_id}`, total: cart.total };
    } else if (cart.email) {
      // The paying session must be a DIFFERENT row, must have settled AFTER
      // the nudge, must not already be credited elsewhere, and — when both
      // sides name a funnel — must be the same funnel.
      match = (paidByEmail.get(cart.email) || []).find(
        (p) => p.id !== row.ref_id
          && !consumed.has(p.id)
          && new Date(p.paid_at).getTime() > sentAt
          && (!cart.funnel_id || !p.funnel_id || cart.funnel_id === p.funnel_id)
      ) || null;
    }
    if (!match) continue;
    const payer = String(match.id).slice(0, 128);
    // THE CREDIT IS TAKEN IN ONE STATEMENT, and the database is the arbiter.
    //
    // This sweep runs on every list load, so two operators with the page open —
    // or two Render instances — reconcile at the same time. `consumed` is
    // per-process, so both would find the same uncredited payment and both
    // would spend it. The NOT EXISTS closes the common case inside one
    // statement's snapshot; the UNIQUE index on recovered_by closes the rest,
    // because two concurrent transactions CAN both pass a NOT EXISTS under READ
    // COMMITTED and only a constraint can break that tie. Losing the tie is a
    // normal outcome here, not an error: skip the row and leave it 'Sent'.
    let res = [];
    try {
      res = await pgQuery(
        `UPDATE crm_recovery_meta
         SET recovery_status = 'Recovered', recovered_at = NOW(),
             recovered_by = $3, recovered_value = $4, updated_at = NOW()
         WHERE source = $1 AND ref_id = $2 AND recovery_status = 'Sent'
           AND NOT EXISTS (
             SELECT 1 FROM crm_recovery_meta m2 WHERE m2.recovered_by = $3
           )
         RETURNING ref_id`,
        [row.source, row.ref_id, payer, match.total == null ? null : Number(match.total)]
      );
    } catch (err) {
      // 23505 = unique_violation on uq_crm_recovery_recovered_by: a concurrent
      // reconcile credited this payment first. That is the guard working.
      if (err.code !== '23505') throw err;
      consumed.add(payer);
      continue;
    }
    // Consume only on a credit that actually landed: if the row had already
    // moved off 'Sent', the payment is still available to the next cart.
    if (res.length) {
      recovered += 1;
      consumed.add(payer);
    } else {
      // Zero rows means either the NOT EXISTS refused it (someone else owns the
      // payment) or this row left 'Sent' underneath us. We cannot tell which
      // from here, so take the conservative reading and stop offering the
      // payment in this pass. Under-crediting is self-correcting — the next
      // sweep re-seeds `consumed` from recovered_by and will credit it if it is
      // genuinely still free. Over-crediting is not.
      consumed.add(payer);
    }
  }
  return { checked: sent.length, recovered };
}

// GET /api/v1/abandoned — unified list (auto-syncs Shopify when stale > 10 min)
router.get('/', async (req, res) => {
  try {
    await ensureTables();
    const stale = await pgQuery(
      `SELECT COALESCE(MAX(synced_at) < NOW() - INTERVAL '10 minutes', TRUE) AS stale
       FROM crm_abandoned_checkouts`
    );
    if (stale[0].stale && req.query.nosync !== '1') {
      try {
        await syncFromShopifyGuarded();
      } catch (err) {
        console.error('[abandoned] auto-sync failed (serving cached):', err.message);
      }
    }

    const windowDays = recoveryWindowDays();
    try {
      await reconcileRecovered({ windowDays });
    } catch (err) {
      // Attribution is analytics, not money — a failed sweep must not blank
      // the operator's list.
      console.error('[abandoned] recovered sweep failed (serving list anyway):', err.message);
    }

    const days = clampInt(req.query.days, 7, 1, 90);
    const graceSeconds = abandonGraceSeconds();
    const now = new Date();
    const windowStart = new Date(now.getTime() - days * 86400000);
    // Right edge = the grace boundary: a cart younger than the grace is still
    // an ACTIVE checkout, not an abandoned one. Same definition the detector
    // and the KPI strip use — the card can never disagree with the rows.
    const windowEnd = new Date(now.getTime() - graceSeconds * 1000);

    // Clamped, not just floored: an unbounded page turns into an unbounded
    // OFFSET, and the CTE is fully materialized before the offset applies.
    const page = clampInt(req.query.page, 1, 1, 10000);
    const limit = clampInt(req.query.limit, 25, 1, 100);
    const params = [windowStart, windowEnd];
    const where = listFilters(req.query, params);

    const totals = await pgQuery(
      `${UNIFIED_CTE}
       SELECT COUNT(*)::int AS n,
              COALESCE(SUM(total_price), 0) AS value,
              COUNT(*) FILTER (WHERE email IS NOT NULL)::int AS with_email,
              COUNT(*) FILTER (WHERE recovery_status IN ('Sent','Recovered'))::int AS emails_sent,
              COUNT(*) FILTER (WHERE source = 'funnel')::int AS funnel_count,
              COUNT(*) FILTER (WHERE source = 'shopify')::int AS shopify_count
       FROM joined ${where}`,
      params
    );
    const rows = await pgQuery(
      // Tiebreaker is not cosmetic: two carts can share a created_at (a sweep
      // of imported rows, or a shopper who opened two funnels in the same
      // second), and without a total order the same row can appear on page 1
      // and page 2 while another is never shown at all.
      `${UNIFIED_CTE}
       SELECT * FROM joined ${where}
       ORDER BY created_at DESC, source ASC, ref_id ASC
       LIMIT $${params.length + 1} OFFSET $${params.length + 2}`,
      [...params, limit, (page - 1) * limit]
    );

    // Recovered counts come from the SIDECAR, not from `joined`: a funnel cart
    // that was revived and PAID leaves the unpaid set entirely, so counting
    // recoveries off the list would erase exactly the wins we are measuring.
    const rec = await pgQuery(
      `SELECT COUNT(*)::int AS n, COALESCE(SUM(recovered_value), 0) AS value
       FROM crm_recovery_meta
       WHERE recovery_status = 'Recovered' AND recovered_at >= $1`,
      [windowStart]
    );

    const t = totals[0];
    res.json({
      success: true,
      data: {
        checkouts: rows.map((r) => shapeRow(r, graceSeconds, now)),
        total: t.n,
        value_at_stake: Number(t.value) || 0,
        with_email: t.with_email,
        emails_sent: t.emails_sent,
        recovered: rec[0].n,
        recovered_revenue: Number(rec[0].value) || 0,
        by_source: { funnel: t.funnel_count, shopify: t.shopify_count },
        page,
        pages: Math.max(Math.ceil(t.n / limit), 1),
        window: {
          days,
          grace_minutes: Math.round(graceSeconds / 60),
          from: windowStart.toISOString(),
          to: windowEnd.toISOString(),
        },
      },
    });
  } catch (err) {
    console.error('[abandoned] list failed:', err);
    res.status(500).json({ error: 'Failed to load abandoned checkouts' });
  }
});

// Look one checkout up in whichever population owns it. Returns null when the
// id is unknown — callers turn that into a 404, never a throw.
async function loadOne(source, refId) {
  if (source === 'funnel') {
    const rows = await pgQuery(
      `SELECT 'funnel'::text AS source, id::text AS ref_id,
              NULLIF(customer->>'email','') AS email,
              NULLIF(customer->>'first_name','') AS customer_first_name,
              NULLIF(customer->>'last_name','') AS customer_last_name,
              NULLIF(customer->>'phone','') AS phone,
              total AS total_price, currency, line_items, funnel_id, page_id,
              NULL::text AS recovery_url,
              NULLIF(customer->'shipping'->>'city','') AS destination_city,
              NULLIF(customer->'shipping'->>'state','') AS destination_state,
              NULLIF(customer->'shipping'->>'country','') AS destination_country,
              status, paid_at, created_at, updated_at
       FROM co_sessions WHERE id = $1`,
      [String(refId).slice(0, 128)]
    );
    return rows.length ? rows[0] : null;
  }
  if (!/^\d+$/.test(String(refId))) return null; // checkout_id is BIGINT
  const rows = await pgQuery(
    `SELECT 'shopify'::text AS source, checkout_id::text AS ref_id, email,
            customer_first_name, customer_last_name, phone,
            total_price, currency, line_items, NULL::text AS funnel_id,
            NULL::text AS page_id, recovery_url,
            destination_city, destination_state, destination_country,
            NULL::text AS status, completed_at AS paid_at, created_at, updated_at
     FROM crm_abandoned_checkouts WHERE checkout_id = $1`,
    [refId]
  );
  return rows.length ? rows[0] : null;
}

function requireSource(req, res) {
  const { source } = req.params;
  if (!SOURCES.includes(source)) {
    res.status(400).json({ error: `Unknown source '${source}' (expected funnel or shopify)` });
    return null;
  }
  return source;
}

// GET /api/v1/abandoned/:source/:refId — detail: full cart contents, recovery
// state, and (funnel only) the windowed event trail for that session.
router.get('/:source/:refId', async (req, res) => {
  try {
    const source = requireSource(req, res);
    if (!source) return;
    await ensureTables();
    const row = await loadOne(source, req.params.refId);
    if (!row) return res.status(404).json({ error: 'Checkout not found' });
    const meta = await readRecoveryMeta(source, row.ref_id);
    const shaped = shapeRow(
      { ...row, recovery_status: meta?.recovery_status || 'Not recovered', link_url: meta?.link_url, sent_at: meta?.sent_at, recovered_at: meta?.recovered_at, recovered_value: meta?.recovered_value, undeliverable: meta?.undeliverable },
      abandonGraceSeconds(),
      new Date()
    );
    const cart = cartSummary(row.line_items);
    let events = [];
    if (source === 'funnel') {
      events = await pgQuery(
        `SELECT kind, created_at, data FROM co_events
         WHERE session_id = $1 AND created_at >= NOW() - INTERVAL '90 days'
         ORDER BY created_at ASC LIMIT 100`,
        [row.ref_id]
      );
    }
    res.json({
      success: true,
      data: {
        checkout: { ...shaped, status: row.status, page_id: row.page_id, updated_at: row.updated_at },
        cart,
        recovery: meta || null,
        events,
      },
    });
  } catch (err) {
    console.error('[abandoned] detail failed:', err);
    res.status(500).json({ error: 'Failed to load checkout' });
  }
});

// POST /api/v1/abandoned/:source/:refId/recovery — set the status by hand.
// Operator override only: it writes the sidecar, never the cart.
router.post('/:source/:refId/recovery', async (req, res) => {
  try {
    const source = requireSource(req, res);
    if (!source) return;
    const status = String(req.body?.status || '');
    if (!RECOVERY_STATUSES.includes(status)) {
      return res.status(422).json({ error: `status must be one of: ${RECOVERY_STATUSES.join(', ')}` });
    }
    await ensureTables();
    const row = await loadOne(source, req.params.refId);
    if (!row) return res.status(404).json({ error: 'Checkout not found' });
    const nowIso = new Date().toISOString();
    const record = buildRecoveryRecord({
      source,
      refId: row.ref_id,
      status,
      externalUrl: source === 'shopify' ? row.recovery_url || null : null,
      sentAt: status === 'Sent' ? nowIso : null,
      recoveredAt: status === 'Recovered' ? nowIso : null,
    });
    const saved = await upsertRecoveryMeta(record);
    res.json({ success: true, data: { recovery: saved } });
  } catch (err) {
    return handleRouteError(res, err, 'mark recovery', 'Failed to update recovery status');
  }
});

// POST /api/v1/abandoned/:source/:refId/recovery-link — mint (or re-read) the
// link WITHOUT sending anything. This is the "copy link" action: the operator
// pastes it into their own outreach.
router.post('/:source/:refId/recovery-link', async (req, res) => {
  try {
    const source = requireSource(req, res);
    if (!source) return;
    if (!(await rateLimit(req, res, 'link', 120, 60))) return;
    await ensureTables();
    const row = await loadOne(source, req.params.refId);
    if (!row) return res.status(404).json({ error: 'Checkout not found' });
    if (source === 'shopify' && !row.recovery_url) {
      return res.status(409).json({ error: 'Shopify has not issued a recovery URL for this checkout yet' });
    }
    if (source === 'funnel' && !hasRecoverySecret()) {
      return res.status(503).json({ error: SECRET_UNSET_MESSAGE });
    }
    const existing = await readRecoveryMeta(source, row.ref_id);
    const record = buildRecoveryRecord({
      source,
      refId: row.ref_id,
      status: existing?.recovery_status || 'Not recovered',
      externalUrl: source === 'shopify' ? row.recovery_url : null,
    });
    const saved = await upsertRecoveryMeta(record);
    res.json({
      success: true,
      data: {
        link_url: saved.link_url,
        expires_at: saved.link_expires_at,
        external: source === 'shopify',
      },
    });
  } catch (err) {
    return handleRouteError(res, err, 'recovery link', 'Failed to mint recovery link');
  }
});

// POST /api/v1/abandoned/:source/:refId/send — the real nudge: mint the link,
// fire the Klaviyo 'Abandoned Checkout' event carrying it, mark Sent.
// Exactly-once per checkout (lb_integration_sends claim + Klaviyo unique_id);
// a resend after the detector already fired answers deduped:true.
router.post('/:source/:refId/send', async (req, res) => {
  try {
    const source = requireSource(req, res);
    if (!source) return;
    if (!(await rateLimit(req, res, 'send', 60, 60))) return;
    await ensureTables();
    const row = await loadOne(source, req.params.refId);
    if (!row) return res.status(404).json({ error: 'Checkout not found' });

    const meta = await readRecoveryMeta(source, row.ref_id);
    const verdict = classifyCheckout(row, {
      graceSeconds: abandonGraceSeconds(),
      recoveryStatus: meta?.recovery_status,
    });
    // NEVER email a live recovery link to somebody who already paid.
    if (verdict.state === 'paid') {
      return res.status(409).json({ error: 'This checkout already settled — refusing to send a recovery link' });
    }
    if (!sanitizeEmail(row.email)) {
      await markUndeliverable(source, row.ref_id);
      return res.status(422).json({ error: 'No deliverable email on this checkout' });
    }

    const result = await sendRecoveryEvent({ ...row, source }, {
      manual: true,
      recheck: () => loadOne(source, row.ref_id),
    });
    if (!result.ok) {
      // A missing signing secret is a CONFIGURATION fault, not a conflict —
      // 503 here matches what /recovery-link answers for the same cause, so
      // the operator gets one consistent, actionable message either way.
      if (result.error === 'recovery_secret_unset') {
        return res.status(503).json({ error: SECRET_UNSET_MESSAGE });
      }
      const message = {
        not_configured: 'Klaviyo is not connected — connect it in Settings → Integrations',
        settled_before_send: 'This checkout settled while the request was in flight — refusing to send',
        vanished: 'This checkout no longer exists',
      }[result.error];
      return res.status(result.skipped ? 409 : 502).json({
        error: message || `Recovery send failed: ${result.error}`,
      });
    }
    const record = buildRecoveryRecord({
      source,
      refId: row.ref_id,
      status: 'Sent',
      externalUrl: source === 'shopify' ? row.recovery_url || null : null,
      // A DEDUPED resend never re-stamps sent_at. That timestamp is the clock
      // the attribution sweep measures payments against, so moving it forward
      // on a resend would step it past a payment the original nudge earned and
      // silently uncredit the recovery. (The upsert is first-stamp-wins too —
      // belt and braces, because this is a money-reporting invariant.)
      sentAt: result.deduped ? null : new Date().toISOString(),
    });
    const saved = await upsertRecoveryMeta(record);
    res.json({ success: true, data: { recovery: saved, deduped: Boolean(result.deduped) } });
  } catch (err) {
    return handleRouteError(res, err, 'send recovery', 'Failed to send recovery');
  }
});

// POST /api/v1/abandoned/detector/run — sweep every nudgeable cart in the
// lookback window and fire ONE event each.
//
// MANUAL ONLY TODAY: render.yaml defines two crons (lasso-sheet-sync,
// preview-repair-sweep) and NEITHER calls this. The only trigger is an
// operator pressing "Run recovery sweep". The exactly-once design means a cron
// COULD be added safely — the lb_integration_sends claim arbitrates between
// concurrent runners — but until one exists, saying so would be a claim about
// a scheduler that does not exist.
//
// One press can send up to `limit` (max 500) REAL emails, so it carries its
// own per-operator rate limit on top of the claim.
router.post('/detector/run', async (req, res) => {
  try {
    if (!(await rateLimit(req, res, 'detector', 6, 600))) return;
    await ensureTables();
    const lookbackDays = clampInt(req.body?.days, 14, 1, 30);
    const limit = clampInt(req.body?.limit, 200, 1, 500);
    const graceSeconds = abandonGraceSeconds();
    const now = new Date();
    const windowStart = new Date(now.getTime() - lookbackDays * 86400000);
    const windowEnd = new Date(now.getTime() - graceSeconds * 1000);

    const rows = await pgQuery(
      `${UNIFIED_CTE}
       SELECT * FROM joined
       WHERE recovery_status = 'Not recovered' AND undeliverable = FALSE
       ORDER BY created_at DESC, source ASC, ref_id ASC
       LIMIT $3`,
      [windowStart, windowEnd, limit]
    );

    let sent = 0;
    let skipped = 0;
    let healed = 0;
    let settledMidSweep = 0;
    let undeliverable = 0;
    const errors = [];
    for (const r of rows) {
      const verdict = classifyCheckout(r, { now, graceSeconds, recoveryStatus: r.recovery_status });
      if (verdict.state === 'unreachable') {
        await markUndeliverable(r.source, r.ref_id);
        undeliverable += 1;
        continue;
      }
      if (!verdict.nudgeable) {
        skipped += 1;
        continue;
      }
      // `rows` is a SNAPSHOT. A 500-row sweep can spend minutes in this loop,
      // and a cart that settles partway through must not be emailed a live
      // recovery link — so the settle check is re-taken against the database
      // immediately before the send, not trusted from the snapshot.
      const result = await sendRecoveryEvent(r, {
        manual: false,
        recheck: () => loadOne(r.source, r.ref_id),
      });
      if (result.error === 'settled_before_send' || result.error === 'vanished') {
        settledMidSweep += 1;
        skipped += 1;
        continue;
      }
      if (result.ok) {
        // Stamped on `deduped` TOO. A claim is taken before the send, so if the
        // send landed and the stamp below failed, the row is left holding a
        // claim with no sidecar row: every later sweep would answer deduped and
        // — if this only stamped on the non-deduped path — skip it forever, so
        // the cart could never be credited as recovered. Stamping here is the
        // self-heal. sent_at is first-stamp-wins, so healing cannot move it.
        await upsertRecoveryMeta(
          buildRecoveryRecord({
            source: r.source,
            refId: r.ref_id,
            status: 'Sent',
            externalUrl: r.source === 'shopify' ? r.recovery_url || null : null,
            sentAt: new Date().toISOString(),
          })
        );
        if (result.deduped) healed += 1;
        else sent += 1;
      } else {
        skipped += 1;
        if (errors.length < 5) errors.push(result.error);
        // A hard vendor rejection is recorded so the row shows WHY it is stuck
        // instead of silently sitting at 'Not recovered' forever.
        if (!result.skipped) {
          await upsertRecoveryMeta(
            buildRecoveryRecord({
              source: r.source,
              refId: r.ref_id,
              status: 'Not recovered',
              externalUrl: r.source === 'shopify' ? r.recovery_url || null : null,
              lastError: result.error,
            })
          );
        }
      }
    }
    const reconciled = await reconcileRecovered({ windowDays: recoveryWindowDays() });
    res.json({
      success: true,
      data: { scanned: rows.length, sent, healed, skipped, settled_mid_sweep: settledMidSweep, undeliverable, errors, reconciled },
    });
  } catch (err) {
    console.error('[abandoned] detector run failed:', err);
    res.status(500).json({ error: 'Detector run failed: ' + err.message });
  }
});

// POST /api/v1/abandoned/sync — manual Shopify refresh
router.post('/sync', async (req, res) => {
  try {
    if (!(await rateLimit(req, res, 'sync', 10, 60))) return;
    await ensureTables();
    const { imported } = await syncFromShopifyGuarded({ force: true });
    res.json({ success: true, data: { imported } });
  } catch (err) {
    console.error('[abandoned] sync failed:', err);
    res.status(500).json({ error: 'Sync failed: ' + err.message });
  }
});

export default router;
