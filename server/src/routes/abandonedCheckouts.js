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
import {
  RECOVERY_STATUSES,
  SOURCES,
  abandonGraceSeconds,
  buildRecoveryRecord,
  cartSummary,
  classifyCheckout,
  ensureRecoveryTables,
  markUndeliverable,
  readRecoveryMeta,
  recoveryWindowDays,
  sanitizeEmail,
  sendRecoveryEvent,
  upsertRecoveryMeta,
} from '../services/abandonedRecovery.js';

const router = Router();

router.use(authenticate, requirePermission('orders', 'access'));

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
  await ensureRecoveryTables();
}

const escapeLike = (s) => String(s).replace(/[\\%_]/g, '\\$&');

const clampInt = (raw, def, lo, hi) => {
  const n = parseInt(raw, 10);
  return Math.max(lo, Math.min(Number.isFinite(n) ? n : def, hi));
};

async function syncFromShopify() {
  const store = process.env.PUURE_SHOPIFY_STORE || process.env.SHOPIFY_STORE_DOMAIN;
  const token = process.env.PUURE_SHOPIFY_TOKEN || process.env.SHOPIFY_ACCESS_TOKEN;
  const apiVersion = process.env.SHOPIFY_API_VERSION || '2024-01';
  if (!store || !token) {
    throw new Error('Shopify not configured (SHOPIFY_STORE_DOMAIN / SHOPIFY_ACCESS_TOKEN)');
  }
  let url = `https://${store}/admin/api/${apiVersion}/checkouts.json?limit=250&status=open`;
  let imported = 0;
  let pages = 0;
  while (url && pages < 40) {
    const resp = await fetch(url, { headers: { 'X-Shopify-Access-Token': token } });
    if (resp.status === 429) {
      const wait = parseFloat(resp.headers.get('retry-after') || '2') * 1000;
      await new Promise((r) => setTimeout(r, wait));
      continue;
    }
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
     ORDER BY sent_at DESC LIMIT 1000`,
    [since]
  );
  if (!sent.length) return { checked: 0, recovered: 0 };

  const funnelRefs = sent.filter((r) => r.source === 'funnel').map((r) => r.ref_id);
  const shopRefs = sent.filter((r) => r.source === 'shopify').map((r) => r.ref_id);

  const emails = new Map(); // `${source}:${ref}` -> email
  if (funnelRefs.length) {
    const rows = await pgQuery(
      `SELECT id::text AS ref_id, lower(NULLIF(customer->>'email','')) AS email
       FROM co_sessions WHERE id = ANY($1)`,
      [funnelRefs]
    );
    for (const r of rows) emails.set(`funnel:${r.ref_id}`, r.email || '');
  }
  const completedShopify = new Set();
  if (shopRefs.length) {
    const rows = await pgQuery(
      `SELECT checkout_id::text AS ref_id, lower(email) AS email, completed_at, total_price
       FROM crm_abandoned_checkouts WHERE checkout_id::text = ANY($1)`,
      [shopRefs]
    );
    for (const r of rows) {
      emails.set(`shopify:${r.ref_id}`, r.email || '');
      if (r.completed_at) completedShopify.add(r.ref_id);
    }
  }

  const paid = await pgQuery(
    `SELECT id, lower(NULLIF(customer->>'email','')) AS email, paid_at, total
     FROM co_sessions
     WHERE status = 'paid' AND paid_at IS NOT NULL AND paid_at >= $1
     ORDER BY paid_at DESC LIMIT 2000`,
    [since]
  );
  const paidByEmail = new Map();
  for (const p of paid) {
    if (!p.email) continue;
    if (!paidByEmail.has(p.email)) paidByEmail.set(p.email, []);
    paidByEmail.get(p.email).push(p);
  }

  let recovered = 0;
  for (const row of sent) {
    const key = `${row.source}:${row.ref_id}`;
    const email = emails.get(key) || '';
    const sentAt = new Date(row.sent_at).getTime();
    let match = null;
    if (row.source === 'shopify' && completedShopify.has(row.ref_id)) {
      match = { id: `shopify:${row.ref_id}`, total: null };
    } else if (email) {
      // The paying session must be a DIFFERENT row and must have settled AFTER
      // the nudge — a payment that predates the email is not a recovery.
      match = (paidByEmail.get(email) || []).find(
        (p) => p.id !== row.ref_id && new Date(p.paid_at).getTime() > sentAt
      ) || null;
    }
    if (!match) continue;
    const res = await pgQuery(
      `UPDATE crm_recovery_meta
       SET recovery_status = 'Recovered', recovered_at = NOW(),
           recovered_by = $3, recovered_value = $4, updated_at = NOW()
       WHERE source = $1 AND ref_id = $2 AND recovery_status = 'Sent'
       RETURNING ref_id`,
      [row.source, row.ref_id, String(match.id).slice(0, 128), match.total == null ? null : Number(match.total)]
    );
    if (res.length) recovered += 1;
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
        await syncFromShopify();
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

    const page = Math.max(parseInt(req.query.page, 10) || 1, 1);
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
      `${UNIFIED_CTE}
       SELECT * FROM joined ${where}
       ORDER BY created_at DESC
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
    console.error('[abandoned] mark recovery failed:', err);
    res.status(500).json({ error: 'Failed to update recovery status' });
  }
});

// POST /api/v1/abandoned/:source/:refId/recovery-link — mint (or re-read) the
// link WITHOUT sending anything. This is the "copy link" action: the operator
// pastes it into their own outreach.
router.post('/:source/:refId/recovery-link', async (req, res) => {
  try {
    const source = requireSource(req, res);
    if (!source) return;
    await ensureTables();
    const row = await loadOne(source, req.params.refId);
    if (!row) return res.status(404).json({ error: 'Checkout not found' });
    if (source === 'shopify' && !row.recovery_url) {
      return res.status(409).json({ error: 'Shopify has not issued a recovery URL for this checkout yet' });
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
    console.error('[abandoned] recovery link failed:', err);
    res.status(500).json({ error: 'Failed to mint recovery link' });
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

    const result = await sendRecoveryEvent({ ...row, source }, { manual: true });
    if (!result.ok) {
      return res.status(result.skipped ? 409 : 502).json({
        error: result.error === 'not_configured'
          ? 'Klaviyo is not connected — connect it in Settings → Integrations'
          : `Recovery send failed: ${result.error}`,
      });
    }
    const record = buildRecoveryRecord({
      source,
      refId: row.ref_id,
      status: 'Sent',
      externalUrl: source === 'shopify' ? row.recovery_url || null : null,
      sentAt: new Date().toISOString(),
    });
    const saved = await upsertRecoveryMeta(record);
    res.json({ success: true, data: { recovery: saved, deduped: Boolean(result.deduped) } });
  } catch (err) {
    console.error('[abandoned] send recovery failed:', err);
    res.status(500).json({ error: 'Failed to send recovery' });
  }
});

// POST /api/v1/abandoned/detector/run — sweep every nudgeable cart in the
// lookback window and fire ONE event each. Safe to run from cron, this
// endpoint and the UI button at the same time: the claim arbitrates.
router.post('/detector/run', async (req, res) => {
  try {
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
       ORDER BY created_at DESC
       LIMIT $3`,
      [windowStart, windowEnd, limit]
    );

    let sent = 0;
    let skipped = 0;
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
      const result = await sendRecoveryEvent(r, { manual: false });
      if (result.ok && !result.deduped) {
        await upsertRecoveryMeta(
          buildRecoveryRecord({
            source: r.source,
            refId: r.ref_id,
            status: 'Sent',
            externalUrl: r.source === 'shopify' ? r.recovery_url || null : null,
            sentAt: new Date().toISOString(),
          })
        );
        sent += 1;
      } else {
        skipped += 1;
        if (!result.ok && errors.length < 5) errors.push(result.error);
        // A hard vendor rejection is recorded so the row shows WHY it is stuck
        // instead of silently sitting at 'Not recovered' forever.
        if (!result.ok && !result.skipped) {
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
      data: { scanned: rows.length, sent, skipped, undeliverable, errors, reconciled },
    });
  } catch (err) {
    console.error('[abandoned] detector run failed:', err);
    res.status(500).json({ error: 'Detector run failed: ' + err.message });
  }
});

// POST /api/v1/abandoned/sync — manual Shopify refresh
router.post('/sync', async (req, res) => {
  try {
    await ensureTables();
    const imported = await syncFromShopify();
    res.json({ success: true, data: { imported } });
  } catch (err) {
    console.error('[abandoned] sync failed:', err);
    res.status(500).json({ error: 'Sync failed: ' + err.message });
  }
});

export default router;
