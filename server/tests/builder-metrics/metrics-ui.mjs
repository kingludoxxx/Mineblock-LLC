// Verification harness for the FUNNEL BUILDER METRICS UI server surface:
//   • getFunnelLive        — the canvas live chip ({live, unique_today})
//   • getFunnelsOverviewBatch — the Funnels-list metrics view (one row per
//     non-archived funnel, money predicates mirroring the per-funnel overview)
//
// Pattern: server/tests/money-path/split-delivery.mjs — real service code
// against embedded PG, minimal tables created if absent, seeded fixtures,
// assertions on ACTUAL output.
//
// Run:  node server/tests/builder-metrics/metrics-ui.mjs
process.env.DATABASE_URL = 'postgres://puure@127.0.0.1:5433/puure_shoporder';
process.env.NODE_ENV = 'development';
process.env.MONEY_SWEEP_DISABLED = '1';

const NM = '/Users/ludo/Mineblock-LLC/node_modules';
const postgres = (await import(`${NM}/postgres/src/index.js`)).default;
const sql = postgres(process.env.DATABASE_URL, { onnotice: () => {} });
// pgQuery-shaped adapter over the harness connection.
const q = (text, params = []) => sql.unsafe(text, params);

const { getFunnelLive, getFunnelsOverviewBatch, getFunnelOverview } = await import(
  '../../src/services/funnelAnalytics.js'
);

let pass = 0;
let fail = 0;
const check = (name, ok, extra = '') => {
  if (ok) {
    pass++;
    console.log(`PASS  ${name}`);
  } else {
    fail++;
    console.log(`FAIL  ${name}  ${extra}`);
  }
};
const near = (a, b, eps = 0.005) => Math.abs(Number(a) - Number(b)) < eps;

// ── Minimal tables (IF NOT EXISTS — harmless when the full DDL already ran) ──
await q(`CREATE TABLE IF NOT EXISTS lb_touches (
  id BIGSERIAL PRIMARY KEY, vid TEXT NOT NULL, funnel_id TEXT, page_id TEXT,
  url TEXT, referrer TEXT, utm JSONB NOT NULL DEFAULT '{}',
  click_ids JSONB NOT NULL DEFAULT '{}',
  ts TIMESTAMPTZ NOT NULL DEFAULT NOW(), expires_at TIMESTAMPTZ NOT NULL
)`);
await q(`CREATE TABLE IF NOT EXISTS funnels (
  id TEXT PRIMARY KEY, slug TEXT NOT NULL, name TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'draft', archived BOOLEAN NOT NULL DEFAULT FALSE,
  custom_domain TEXT, default_page_id TEXT, seo JSONB DEFAULT '{}',
  flow_layout JSONB DEFAULT '{"nodes":[],"edges":[]}', misc JSONB DEFAULT '{}',
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(), updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
)`);
await q(`CREATE TABLE IF NOT EXISTS funnel_pages (
  id TEXT PRIMARY KEY, funnel_id TEXT NOT NULL, slug TEXT NOT NULL,
  type TEXT NOT NULL DEFAULT 'generic', title TEXT NOT NULL DEFAULT '',
  status TEXT NOT NULL DEFAULT 'draft', archived BOOLEAN NOT NULL DEFAULT FALSE,
  is_home BOOLEAN NOT NULL DEFAULT FALSE, blocks JSONB NOT NULL DEFAULT '[]',
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(), updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
)`);
await q(`CREATE TABLE IF NOT EXISTS co_sessions (
  id TEXT PRIMARY KEY, funnel_id TEXT, page_id TEXT,
  status TEXT NOT NULL DEFAULT 'processing', line_items JSONB NOT NULL DEFAULT '[]',
  subtotal NUMERIC(12,2) NOT NULL DEFAULT 0, shipping NUMERIC(12,2) NOT NULL DEFAULT 0,
  tax NUMERIC(12,2) NOT NULL DEFAULT 0, total NUMERIC(12,2) NOT NULL DEFAULT 0,
  currency TEXT NOT NULL DEFAULT 'USD', customer JSONB NOT NULL DEFAULT '{}',
  gateway TEXT, gateway_session_id TEXT, vid TEXT,
  refunds JSONB NOT NULL DEFAULT '[]', paid_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(), updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
)`);
await q(`CREATE TABLE IF NOT EXISTS co_upsell_charges (
  id TEXT PRIMARY KEY, session_id TEXT NOT NULL, offer_id TEXT NOT NULL,
  charge_id TEXT NOT NULL, amount NUMERIC(12,2) NOT NULL DEFAULT 0,
  currency TEXT, status TEXT NOT NULL, declined_by_user BOOLEAN NOT NULL DEFAULT FALSE,
  line_items JSONB NOT NULL DEFAULT '[]',
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(), updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
)`);

// ── Clean fixture space ──────────────────────────────────────────────────────
const F1 = 'fnl_bm_alpha'; // live funnel with money + traffic
const F2 = 'fnl_bm_beta'; // draft funnel, traffic only
const F3 = 'fnl_bm_arch'; // ARCHIVED — must be excluded from the batch
const ALL = [F1, F2, F3];
await q(`DELETE FROM lb_touches WHERE funnel_id = ANY($1)`, [ALL]);
await q(`DELETE FROM co_upsell_charges WHERE session_id LIKE 'cs_bm_%'`);
await q(`DELETE FROM co_sessions WHERE funnel_id = ANY($1)`, [ALL]);
await q(`DELETE FROM funnel_pages WHERE funnel_id = ANY($1)`, [ALL]);
await q(`DELETE FROM funnels WHERE id = ANY($1)`, [ALL]);

await q(
  `INSERT INTO funnels (id, slug, name, status, archived) VALUES
   ($1, 'bm-alpha', 'BM Alpha', 'published', FALSE),
   ($2, 'bm-beta',  'BM Beta',  'draft',     FALSE),
   ($3, 'bm-arch',  'BM Arch',  'draft',     TRUE)`,
  [F1, F2, F3]
);
await q(
  `INSERT INTO funnel_pages (id, funnel_id, slug, type, title, is_home) VALUES
   ('pg_bm_lp', $1, '/', 'lead', 'Lander', TRUE),
   ('pg_bm_co', $1, '/checkout', 'checkout', 'Checkout', FALSE)`,
  [F1]
);

// ═══ PART 1 — LIVE COUNTER ═══════════════════════════════════════════════════
// Seed lb_touches: 2 vids in the last 5 minutes, 5 distinct vids today total
// (the 2 recent ones + 3 earlier today), 3 distinct vids yesterday.
// Expected: {live: 2, unique_today: 5}.
const touch = (vid, tsSql, page = 'pg_bm_lp') =>
  q(
    `INSERT INTO lb_touches (vid, funnel_id, page_id, ts, expires_at)
     VALUES ($1, $2, $3, ${tsSql}, NOW() + INTERVAL '90 days')`,
    [vid, F1, page]
  );

// 2 vids inside the 5-minute window (one of them touches twice — distinct
// count must not double it).
await touch('v_live_1', `NOW() - INTERVAL '1 minute'`);
await touch('v_live_1', `NOW() - INTERVAL '2 minutes'`, 'pg_bm_co');
await touch('v_live_2', `NOW() - INTERVAL '3 minutes'`);
// 3 more vids earlier today — placed 5 minutes AFTER UTC midnight so the
// fixture is valid at any wall-clock time of day, and always outside the
// 5-minute live window unless we are within 10 min of midnight (in which case
// they'd legitimately also be live; the offset keeps the two windows disjoint
// whenever NOW() - 5min > midnight + 5min, i.e. any time after 00:10 UTC).
const [{ safe_today: safeToday }] = await q(
  `SELECT (NOW() - (date_trunc('day', NOW() AT TIME ZONE 'utc') AT TIME ZONE 'utc')
           > INTERVAL '10 minutes') AS safe_today`
);
await touch('v_today_1', `date_trunc('day', NOW() AT TIME ZONE 'utc') AT TIME ZONE 'utc' + INTERVAL '5 minutes'`);
await touch('v_today_2', `date_trunc('day', NOW() AT TIME ZONE 'utc') AT TIME ZONE 'utc' + INTERVAL '5 minutes'`);
await touch('v_today_3', `date_trunc('day', NOW() AT TIME ZONE 'utc') AT TIME ZONE 'utc' + INTERVAL '6 minutes'`);
// 3 vids yesterday — must count in NEITHER figure.
await touch('v_yest_1', `date_trunc('day', NOW() AT TIME ZONE 'utc') AT TIME ZONE 'utc' - INTERVAL '10 hours'`);
await touch('v_yest_2', `date_trunc('day', NOW() AT TIME ZONE 'utc') AT TIME ZONE 'utc' - INTERVAL '11 hours'`);
await touch('v_yest_3', `date_trunc('day', NOW() AT TIME ZONE 'utc') AT TIME ZONE 'utc' - INTERVAL '12 hours'`);

{
  const live = await getFunnelLive({ funnelId: F1 }, { query: q });
  if (safeToday) {
    check('T1 live = 2 (distinct vids, last 5 min)', live.live === 2, JSON.stringify(live));
    check('T1 unique_today = 5 (distinct vids since UTC midnight)', live.unique_today === 5, JSON.stringify(live));
  } else {
    // Within 10 min of UTC midnight the "earlier today" rows overlap the live
    // window by construction — assert the invariant that must still hold.
    check('T1 (midnight edge) live ⊆ today', live.live <= live.unique_today && live.unique_today === 5, JSON.stringify(live));
  }
  check('T1 not degraded', live.degraded === false, JSON.stringify(live.warnings));
  check('T1 as_of present', typeof live.as_of === 'string' && !Number.isNaN(Date.parse(live.as_of)));
}

// T2 — edge: funnel with zero touches → hard zeros (measured), not nulls.
{
  const live = await getFunnelLive({ funnelId: F2 }, { query: q });
  check('T2 empty funnel live = 0 / 0 (zero is a measurement)', live.live === 0 && live.unique_today === 0, JSON.stringify(live));
}

// T3 — edge: invalid funnel id refused.
{
  const live = await getFunnelLive({ funnelId: '' }, { query: q });
  check('T3 empty funnel id → invalid_funnel_id', live.error === 'invalid_funnel_id', JSON.stringify(live));
}

// T4 — edge: broken source degrades to null + named warning, never throws,
// never zero.
{
  const boom = async () => {
    throw new Error('relation "lb_touches" does not exist');
  };
  const live = await getFunnelLive({ funnelId: F1 }, { query: boom });
  check(
    'T4 broken table → null (not 0) + warning + degraded',
    live.live === null && live.unique_today === null && live.degraded === true && live.warnings[0]?.source === 'lb_touches',
    JSON.stringify(live)
  );
}

// ═══ PART 2 — BATCH OVERVIEW ═════════════════════════════════════════════════
// Money fixture on F1 (window = today):
//   s1: paid   $100, vid v_today_1, minted+paid today          → order
//   s2: paid   $200 + settled upsell $50, vid v_today_2        → order
//   s3: refunded $80, refund entry $80 dated today             → order + refund
//   s4: processing $999 — INTENT, must be invisible to revenue
// Traffic fixture (already seeded): 8 distinct vids on F1 today+recent... but
// the window below is [today, today] so only today's vids count: v_live_1,
// v_live_2, v_today_1..3 = 5 visitors (yesterday's 3 are outside the window).
// v_live_1 touched TWO different pages → 1 advanced visitor.
// NOTE: refunds is passed as a JS ARRAY. postgres.js serializes a plain JS
// string bound to a jsonb slot as a jsonb STRING scalar ("[]"), which then
// blows up jsonb_array_elements with "cannot extract elements from a scalar"
// — verified by execution. A JS array serializes to a jsonb array correctly.
const mk = (id, { status, total, vid, paidSql, createdSql, refunds = [] }) =>
  q(
    `INSERT INTO co_sessions (id, funnel_id, page_id, status, total, vid, refunds, paid_at, created_at)
     VALUES ($1, $2, 'pg_bm_co', $3, $4, $5, $6, ${paidSql}, ${createdSql})`,
    [id, F1, status, total, vid, refunds]
  );

await mk('cs_bm_1', { status: 'paid', total: 100, vid: 'v_today_1', paidSql: `NOW() - INTERVAL '30 minutes'`, createdSql: `NOW() - INTERVAL '40 minutes'` });
await mk('cs_bm_2', { status: 'paid', total: 200, vid: 'v_today_2', paidSql: `NOW() - INTERVAL '20 minutes'`, createdSql: `NOW() - INTERVAL '25 minutes'` });
await q(
  `INSERT INTO co_upsell_charges (id, session_id, offer_id, charge_id, amount, status)
   VALUES ('uc_bm_1', 'cs_bm_2', 'off_1', 'v:1', 50, 'settled')`
);
{
  const [{ iso }] = await q(`SELECT to_char(NOW() AT TIME ZONE 'utc', 'YYYY-MM-DD"T"HH24:MI:SS"Z"') AS iso`);
  await mk('cs_bm_3', {
    status: 'refunded',
    total: 80,
    vid: 'v_today_3',
    paidSql: `NOW() - INTERVAL '15 minutes'`,
    createdSql: `NOW() - INTERVAL '18 minutes'`,
    refunds: [{ id: 're_bm_1', amount: 80, at: iso }],
  });
}
await mk('cs_bm_4', { status: 'processing', total: 999, vid: 'v_today_1', paidSql: 'NULL', createdSql: `NOW() - INTERVAL '10 minutes'` });

// F2 gets traffic only (2 vids today, no money rows).
await q(
  `INSERT INTO lb_touches (vid, funnel_id, page_id, ts, expires_at) VALUES
   ('v_b1', $1, 'pg_x', NOW() - INTERVAL '1 hour', NOW() + INTERVAL '90 days'),
   ('v_b2', $1, 'pg_x', NOW() - INTERVAL '2 hours', NOW() + INTERVAL '90 days')`,
  [F2]
);
// F3 (ARCHIVED) gets rows that must NOT surface anywhere.
await q(
  `INSERT INTO lb_touches (vid, funnel_id, page_id, ts, expires_at) VALUES
   ('v_arch', $1, 'pg_y', NOW() - INTERVAL '1 hour', NOW() + INTERVAL '90 days')`,
  [F3]
);

// ANALYZE after bulk seeding (the service header documents why: stale
// statistics on a freshly loaded table make the planner pick a nested loop).
await q(`ANALYZE lb_touches`);
await q(`ANALYZE co_sessions`);

const [{ today }] = await q(`SELECT to_char(NOW() AT TIME ZONE 'utc', 'YYYY-MM-DD') AS today`);
const win = { from: today, to: today };

{
  const batch = await getFunnelsOverviewBatch(win, { query: q });
  check('B0 no error', !batch.error, JSON.stringify(batch.error));
  const ids = (batch.funnels || []).map((r) => r.funnel_id);
  check('B1 F1 and F2 present', ids.includes(F1) && ids.includes(F2), JSON.stringify(ids));
  check('B2 ARCHIVED funnel excluded', !ids.includes(F3), JSON.stringify(ids));

  const a = batch.funnels.find((r) => r.funnel_id === F1);
  // Expected for F1 in [today, today]:
  //   visitors  = 5  (v_live_1, v_live_2, v_today_1..3)
  //   orders    = 3  (paid, paid, refunded — processing invisible)
  //   gross     = 100 + 200 + 80 + 50 upsell = 430
  //   refunded  = 80
  //   net       = 350
  //   cvr       = 3/5 = 0.6
  //   aov_post  = 350/3 = 116.67 ; aov_pre = post − 50/3 = 100.00
  check('B3 F1 visitors = 5', a?.visitors === 5, JSON.stringify(a));
  check('B4 F1 orders (SALES) = 3 — processing invisible', a?.orders === 3, JSON.stringify(a?.orders));
  check('B5 F1 gross_revenue = 430 (incl. refunded order + settled upsell)', near(a?.gross_revenue, 430), JSON.stringify(a?.gross_revenue));
  check('B6 F1 refunded = 80', near(a?.refunded, 80), JSON.stringify(a?.refunded));
  check('B7 F1 net_revenue = 350', near(a?.net_revenue, 350), JSON.stringify(a?.net_revenue));
  check('B8 F1 cvr = 0.6', near(a?.cvr, 0.6, 1e-6), JSON.stringify(a?.cvr));
  check('B9 F1 aov_post_upsell = 116.67', near(a?.aov_post_upsell, 116.67), JSON.stringify(a?.aov_post_upsell));
  check('B10 F1 aov_pre_upsell = 100.00', near(a?.aov_pre_upsell, 100.0), JSON.stringify(a?.aov_pre_upsell));
  check('B11 F1 ctr labelled proxy', a?.ctr_is_proxy === true && typeof a?.ctr_basis === 'string', JSON.stringify(a?.ctr_basis));

  const b = batch.funnels.find((r) => r.funnel_id === F2);
  check('B12 F2 visitors = 2, orders = 0 (money source healthy → zero, not null)', b?.visitors === 2 && b?.orders === 0, JSON.stringify(b));
  check('B13 F2 aov null (no orders), net 0', b?.aov_post_upsell === null && near(b?.net_revenue, 0), JSON.stringify(b));

  // Cross-check: the batch row must agree with the per-funnel overview totals
  // over the SAME window (same predicates by construction — prove it).
  const ov = await getFunnelOverview({ funnelId: F1, ...win }, { query: q });
  check(
    'B14 batch row ≡ per-funnel overview totals (visitors/orders/gross/net/refunded)',
    ov.totals.visitors === a.visitors &&
      ov.totals.orders === a.orders &&
      near(ov.totals.gross_revenue, a.gross_revenue) &&
      near(ov.totals.net_revenue, a.net_revenue) &&
      near(ov.totals.refunded, a.refunded),
    JSON.stringify({ batch: a, totals: ov.totals })
  );
}

// B15 — edge: malformed window refused, not guessed.
{
  const r = await getFunnelsOverviewBatch({ from: 'not-a-date', to: today }, { query: q });
  check('B15 malformed from → invalid_date_format', r.error === 'invalid_date_format', JSON.stringify(r));
}

// B16 — edge: to before from refused.
{
  const r = await getFunnelsOverviewBatch({ from: today, to: '2020-01-01' }, { query: q });
  check('B16 to_before_from refused', r.error === 'to_before_from', JSON.stringify(r));
}

// B17 — edge: traffic source down → visitors/ctr null (NOT zero), money still
// served; named warning; nothing throws.
{
  const flaky = async (text, params) => {
    if (/lb_touches/.test(text)) throw new Error('relation "lb_touches" does not exist');
    return q(text, params);
  };
  const r = await getFunnelsOverviewBatch(win, { query: flaky });
  const a = (r.funnels || []).find((x) => x.funnel_id === F1);
  check(
    'B17 traffic down → visitors null, orders still real, warning named',
    a?.visitors === null && a?.ctr === null && a?.orders === 3 && r.degraded === true && r.warnings.some((w) => w.source === 'lb_touches'),
    JSON.stringify({ a, warnings: r.warnings })
  );
}

// B18 — edge: whole DB down → both sources degrade to a named warning; the
// call still returns (empty skeleton), never throws.
{
  const dead = async () => {
    throw new Error('connection refused');
  };
  const r = await getFunnelsOverviewBatch(win, { query: dead });
  check(
    'B18 dead DB → degraded empty response, no throw',
    !r.error && Array.isArray(r.funnels) && r.funnels.length === 0 && r.degraded === true,
    JSON.stringify(r)
  );
}

// ═══ PART 3 — ADVERSARIAL-REVIEW FIXES ═══════════════════════════════════════
// Exercises the exact paths the review flagged:
//   C1  NULL-page money: batch counted it, per-funnel overview dropped it.
//   C2  orders > visitors: the clamp must be published, not silently applied.
//   C3  malformed (non-array) refunds jsonb: one bad row must not null money
//       for every funnel in the batch.
//   C4  reversed upsell leg with no void row: net is an UPPER BOUND and both
//       surfaces must say so.

// ── C1: money-moved session with page_id NULL on F1 ─────────────────────────
await q(
  `INSERT INTO co_sessions (id, funnel_id, page_id, status, total, vid, refunds, paid_at, created_at)
   VALUES ('cs_bm_np', $1, NULL, 'paid', 40, NULL, $2,
           NOW() - INTERVAL '5 minutes', NOW() - INTERVAL '6 minutes')`,
  [F1, []]
);
{
  const batch = await getFunnelsOverviewBatch(win, { query: q });
  const a = (batch.funnels || []).find((r) => r.funnel_id === F1);
  // F1 now: orders 4 (3 paged + 1 NULL-page), gross 430+40=470, net 350+40=390.
  check('C1a batch counts NULL-page money (orders=4, gross=470, net=390)',
    a?.orders === 4 && near(a?.gross_revenue, 470) && near(a?.net_revenue, 390),
    JSON.stringify({ orders: a?.orders, gross: a?.gross_revenue, net: a?.net_revenue }));

  const ov = await getFunnelOverview({ funnelId: F1, ...win }, { query: q });
  check('C1b overview totals now EQUAL the batch row (the divergence is closed)',
    ov.totals.orders === a.orders &&
      near(ov.totals.gross_revenue, a.gross_revenue) &&
      near(ov.totals.net_revenue, a.net_revenue) &&
      near(ov.totals.refunded, a.refunded) &&
      ov.totals.visitors === a.visitors,
    JSON.stringify({ batch: { o: a.orders, g: a.gross_revenue, n: a.net_revenue, v: a.visitors },
      totals: ov.totals }));

  const np = (ov.pages || []).find((p) => p.page_id === null);
  check('C1c synthetic (no page) row present: page_id null, label, net=40, orders=1',
    Boolean(np) && np.title === '(no page)' && near(np.net_revenue, 40) && np.orders === 1,
    JSON.stringify(np));

  // The canvas overlay consumer keys by page_id — prove the null key cannot
  // collide with a real node id and cannot crash Object.fromEntries.
  const overlayMap = Object.fromEntries(
    (ov.pages || []).map((p) => [p.page_id, { visitors: p.visitors, ctr: p.ctr, cvr: p.cvr }])
  );
  check('C1d overlay map tolerates the null key (no real node id is shadowed)',
    overlayMap['pg_bm_co'] !== undefined && overlayMap['null'] !== undefined
      && overlayMap['pg_bm_lp'] !== undefined,
    JSON.stringify(Object.keys(overlayMap)));
}

// ── C2 + C3: orders > visitors on F2, one session carrying a NON-ARRAY
//    refunds jsonb (postgres.js serializes a bound JS string as a jsonb string
//    scalar — the exact corruption shape that kills jsonb_array_elements) ────
await q(
  `INSERT INTO co_sessions (id, funnel_id, page_id, status, total, vid, refunds, paid_at, created_at)
   VALUES
   ('cs_bm_b1', $1, 'pg_x', 'paid', 10, 'v_b1', $2, NOW() - INTERVAL '5 minutes', NOW() - INTERVAL '6 minutes'),
   ('cs_bm_b2', $1, 'pg_x', 'paid', 20, 'v_b2', $2, NOW() - INTERVAL '5 minutes', NOW() - INTERVAL '6 minutes'),
   ('cs_bm_b3', $1, 'pg_x', 'paid', 30, 'v_b3', $3, NOW() - INTERVAL '5 minutes', NOW() - INTERVAL '6 minutes')`,
  [F2, [], 'corrupt-not-an-array']
);
{
  const batch = await getFunnelsOverviewBatch(win, { query: q });
  check('C3a batch survives the malformed refunds row (no degradation of money)',
    !batch.error && batch.warnings.every((w) => w.source !== 'co_sessions'),
    JSON.stringify(batch.warnings));

  const b = (batch.funnels || []).find((r) => r.funnel_id === F2);
  // F2: 2 measured visitors, 3 orders → raw published, clamp published beside.
  check('C2a visitors stays RAW (2) with clamp published (3) and flag true',
    b?.visitors === 2 && b?.visitors_clamped === 3 && b?.visitors_is_clamped === true,
    JSON.stringify({ v: b?.visitors, vc: b?.visitors_clamped, f: b?.visitors_is_clamped }));
  check('C2b cvr uses the CLAMPED denominator (3/3 = 1, never >100%)',
    near(b?.cvr, 1, 1e-6), JSON.stringify(b?.cvr));
  check('C3b funnel B money still served, bad refund row skipped (gross=60, refunded=0, net=60)',
    b?.orders === 3 && near(b?.gross_revenue, 60) && near(b?.refunded, 0) && near(b?.net_revenue, 60),
    JSON.stringify({ o: b?.orders, g: b?.gross_revenue, r: b?.refunded, n: b?.net_revenue }));

  const a = (batch.funnels || []).find((r) => r.funnel_id === F1);
  check('C3c funnel A money UNAFFECTED by funnel B\'s corrupt row (gross=470, net=390, refunded=80)',
    near(a?.gross_revenue, 470) && near(a?.net_revenue, 390) && near(a?.refunded, 80),
    JSON.stringify({ g: a?.gross_revenue, n: a?.net_revenue, r: a?.refunded }));

  // The per-funnel overview degrades LOUDLY: the corrupt value is counted.
  const ovB = await getFunnelOverview({ funnelId: F2, ...win }, { query: q });
  check('C3d overview(F2) reports the corruption (malformed_refund_entries >= 1) with money still served',
    ovB.meta.malformed_refund_entries >= 1 && near(ovB.totals.net_revenue, 60),
    JSON.stringify({ malformed: ovB.meta.malformed_refund_entries, net: ovB.totals.net_revenue }));
}

// ── C4: reversed upsell leg with NO void row → net is an upper bound ────────
await q(
  `INSERT INTO co_sessions (id, funnel_id, page_id, status, total, vid, refunds, paid_at, created_at)
   VALUES ('cs_bm_ub', $1, 'pg_bm_co', 'paid', 60, NULL, $2,
           NOW() - INTERVAL '4 minutes', NOW() - INTERVAL '5 minutes')`,
  [F1, []]
);
await q(
  `INSERT INTO co_upsell_charges (id, session_id, offer_id, charge_id, amount, status)
   VALUES ('uc_bm_2', 'cs_bm_ub', 'off_2', 'v:2', 30, 'refunded')`
);
{
  const batch = await getFunnelsOverviewBatch(win, { query: q });
  const a = (batch.funnels || []).find((r) => r.funnel_id === F1);
  check('C4a batch row carries the qualifier (unmeasured=1, upper_bound=true)',
    a?.upsell_refunds_unmeasured === 1 && a?.net_revenue_is_upper_bound === true,
    JSON.stringify({ un: a?.upsell_refunds_unmeasured, ub: a?.net_revenue_is_upper_bound }));
  check('C4b unaffected funnel carries NO qualifier (F2 upper_bound=false)',
    (batch.funnels || []).find((r) => r.funnel_id === F2)?.net_revenue_is_upper_bound === false,
    JSON.stringify((batch.funnels || []).find((r) => r.funnel_id === F2)));

  const ov = await getFunnelOverview({ funnelId: F1, ...win }, { query: q });
  check('C4c overview agrees (meta.upsell_refunds_unmeasured=1, net_revenue_is_upper_bound=true)',
    ov.meta.upsell_refunds_unmeasured === 1 && ov.meta.net_revenue_is_upper_bound === true,
    JSON.stringify({ un: ov.meta.upsell_refunds_unmeasured, ub: ov.meta.net_revenue_is_upper_bound }));
  // The refunded-at-gross leg adds 60 base + 30 upsell: gross 560, net 480 —
  // and the two surfaces must STILL agree after every fixture landed.
  check('C4d batch ≡ overview totals after all adversarial fixtures (gross=560, net=480)',
    near(a?.gross_revenue, 560) && near(ov.totals.gross_revenue, a.gross_revenue) &&
      near(a?.net_revenue, 480) && near(ov.totals.net_revenue, a.net_revenue) &&
      ov.totals.orders === a.orders,
    JSON.stringify({ batch: { g: a?.gross_revenue, n: a?.net_revenue, o: a?.orders },
      totals: ov.totals }));
}

// ── Cleanup ──────────────────────────────────────────────────────────────────
await q(`DELETE FROM lb_touches WHERE funnel_id = ANY($1)`, [ALL]);
await q(`DELETE FROM co_upsell_charges WHERE session_id LIKE 'cs_bm_%'`);
await q(`DELETE FROM co_sessions WHERE funnel_id = ANY($1)`, [ALL]);
await q(`DELETE FROM funnel_pages WHERE funnel_id = ANY($1)`, [ALL]);
await q(`DELETE FROM funnels WHERE id = ANY($1)`, [ALL]);
await sql.end({ timeout: 5 });

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
