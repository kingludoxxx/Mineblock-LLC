// METRICS ENGINE verification — drives the REAL funnelMetrics.js against
// embedded PG. Proves BY EXECUTION every claim the engine makes:
//
//   L  legality — illegal metric × dimension is 422 BEFORE any query runs
//   C  compare — equal-length preceding window, series aligned BY INDEX
//   W  week/month ratios recomputed from folded sums, never averaged
//   B  every breakdown names its basis, and captured_base is TRUE (the upsell
//      folds do not run there) rather than merely printed
//   T  tri-state — missing denominator ⇒ null, incl. the lb_touches TTL
//   N  new + returning == orders, on filtered AND unfiltered reads
//   U  an upsell reversal nets on the UPSELL line, not on refunds (and the
//      Whop double-write is de-duplicated exactly once)
//   K  cost withholding at zero coverage; spend tri-state
//   Z  REPORT_TZ (Europe/Madrid) — a 23:30Z order lands on the NEXT Madrid
//      day; the 23h and 25h DST days bucket correctly; week/month keys are
//      Madrid-calendar
//   P  p95 < 1500ms over a 90-day window on a 50K-session fixture
//   E  edges — empty window, past-TTL window, zero-traffic funnel with orders,
//      malformed day, 401-day window
//
// Run:  node server/tests/metrics/engine.mjs
import postgres from 'postgres';

const DB = 'postgres://puure@127.0.0.1:5433/puure_metrics_engine';
process.env.DATABASE_URL = DB;
process.env.NODE_ENV = 'development';
process.env.REPORT_TZ = process.env.REPORT_TZ || 'Europe/Madrid';

let pass = 0; let fail = 0;
const ok = (c, m, x = '') => { if (c) { pass++; console.log('PASS ', m); } else { fail++; console.log('FAIL ', m, x); } };
const near = (a, b, eps = 0.011) => a !== null && a !== undefined && Math.abs(Number(a) - Number(b)) <= eps;

// ---- bootstrap db
const admin = postgres('postgres://puure@127.0.0.1:5433/postgres', { ssl: false });
await admin`DROP DATABASE IF EXISTS puure_metrics_engine`;
await admin`CREATE DATABASE puure_metrics_engine`;
await admin.end();
const sql = postgres(DB, { ssl: false, onnotice: () => {} });
const q = (text, params = []) => sql.unsafe(text, params);

const M = await import('../../src/services/funnelMetrics.js');
const {
  runQuery, runDashboard, reportPresets, validateQuery, toCsv, csvCell,
  MetricsError, METRICS, DIMENSIONS, DIM_METRICS, BREAKDOWN_BASES,
  BREAKDOWN_BASIS_LABELS, MONEY_MOVED_SQL, REPORT_TZ,
  HOUR_ONLY_EXCLUSIONS, MAX_WINDOW_DAYS,
  zonedDayStart, dayInTz, todayInTz, hoursInLocalDay, weekKey, monthKey,
  bucketsFor, computeMetrics, UNSERVABLE_PRESETS,
} = M;

const { ensureCheckoutTables } = await import('../../src/services/checkoutSchema.js');
const { ensureTrackingTables } = await import('../../src/services/trackingSchema.js');
const { ensureFunnelCostsTables } = await import('../../src/services/funnelCostsSchema.js');
const { ensureSplitTables } = await import('../../src/services/splitTestSchema.js');
await ensureCheckoutTables();
await ensureTrackingTables();
await ensureFunnelCostsTables();
await ensureSplitTables();

// funnels / funnel_pages are created on demand by routes/funnels.js in
// production; the harness stands them up directly (same DDL).
await q(`CREATE TABLE IF NOT EXISTS funnels (
  id TEXT PRIMARY KEY, slug TEXT NOT NULL, name TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'draft', archived BOOLEAN NOT NULL DEFAULT FALSE,
  custom_domain TEXT, default_page_id TEXT, seo JSONB DEFAULT '{}',
  flow_layout JSONB DEFAULT '{"nodes":[],"edges":[]}', misc JSONB DEFAULT '{}',
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(), updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW())`);
await q(`CREATE TABLE IF NOT EXISTS funnel_pages (
  id TEXT PRIMARY KEY, funnel_id TEXT NOT NULL, slug TEXT NOT NULL,
  type TEXT NOT NULL DEFAULT 'generic', title TEXT NOT NULL DEFAULT '',
  status TEXT NOT NULL DEFAULT 'draft', archived BOOLEAN NOT NULL DEFAULT FALSE,
  is_home BOOLEAN NOT NULL DEFAULT FALSE, blocks JSONB NOT NULL DEFAULT '[]',
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(), updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW())`);

// ═══ THE PREDICATE PIN ══════════════════════════════════════════════════════
// funnelMetrics declares MONEY_MOVED locally (its lane's fence is create-only,
// and both owners keep theirs module-private). That duplication is only safe
// if it is CHECKED, so it is checked here against the source on disk.
{
  const fs = await import('fs');
  const a = fs.readFileSync(new URL('../../src/services/funnelAnalytics.js', import.meta.url), 'utf8');
  const b = fs.readFileSync(new URL('../../src/services/funnelCosts.js', import.meta.url), 'utf8');
  ok(a.includes(MONEY_MOVED_SQL), 'PIN funnelAnalytics.js carries the identical MONEY_MOVED predicate');
  ok(b.includes(MONEY_MOVED_SQL), 'PIN funnelCosts.js carries the identical MONEY_MOVED predicate');
  ok(!MONEY_MOVED_SQL.includes(`'processing'`), 'PIN the predicate can never see a processing row');
  // /definitions PUBLISHES max_window_days; parseWindow ENFORCES it. A
  // published limit looser than the enforced one invites the client to offer a
  // range that always 422s, so the two are pinned together.
  const enforced = /MAX_WINDOW_DAYS\s*=\s*(\d+)/.exec(a);
  ok(enforced && Number(enforced[1]) === MAX_WINDOW_DAYS,
    'PIN the published max_window_days equals the one parseWindow enforces', `${enforced?.[1]} vs ${MAX_WINDOW_DAYS}`);
}

// ═══ FIXTURE ════════════════════════════════════════════════════════════════
const T0 = todayInTz();
const D = (n) => new Date(new Date(`${T0}T12:00:00Z`).getTime() - n * 86400000).toISOString().slice(0, 10);
/** n REPORT_TZ days AHEAD of today — for the unstarted-bucket cases. */
const dayFwd = (n) => D(-n);
// A wall-clock instant on a REPORT_TZ day, expressed as the UTC instant.
const at = (day, hourLocal) => new Date(zonedDayStart(day).getTime() + hourLocal * 3600000).toISOString();

const V1 = 'v_costed';
const V2 = 'v_upsell';
const V3 = 'v_uncosted';

await q(`INSERT INTO funnels (id, slug, name, status) VALUES
  ('f1','alpha','Alpha','live'), ('f2','beta','Beta','live'), ('f3','gamma','Gamma','live'),
  ('fnoleg','noleg','NoLeg','live'), ('ftz','tz','TZ','live'), ('fdst','dst','DST','live'),
  ('fweek','week','Week','live'), ('fperf','perf','Perf','live')`);
await q(`INSERT INTO funnel_pages (id, funnel_id, slug, type, title) VALUES
  ('p1','f1','checkout','checkout','Checkout'),
  ('p2','f1','upsell-1','upsell','Upsell 1'),
  ('p3','f2','checkout','checkout','Beta Checkout'),
  ('p4','f3','checkout','checkout','Gamma Checkout')`);

// ⚠️ JSONB params are passed as OBJECTS, never as JSON strings: postgres.js
// JSON-encodes a value bound to a json/jsonb parameter, so a pre-stringified
// array arrives as a jsonb STRING and every `jsonb_typeof = 'array'` guard in
// the engine silently skips it. (That is the guard working — a corrupt shape
// is filtered out instead of throwing — which is exactly why it has to be the
// FIXTURE that is fixed here.)
const mkSession = async (o) => {
  await q(
    `INSERT INTO co_sessions (id, funnel_id, page_id, status, line_items, total, currency,
                              customer, gateway, vid, refunds, paid_at, created_at)
     VALUES ($1,$2,$3,$4,$5,$6,'USD',$7,$8,$9,$10,$11,$12)`,
    [o.id, o.funnel_id, o.page_id ?? null, o.status ?? 'paid',
      o.line_items ?? [], o.total ?? 0,
      o.customer ?? {}, o.gateway ?? 'whop', o.vid ?? null,
      o.refunds ?? [], o.paid_at ?? null, o.created_at ?? o.paid_at]
  );
};
const cust = (email, country) => ({
  email: email ?? '', shipping: country ? { country } : undefined,
});

// ── f1: the arithmetic fixture ──────────────────────────────────────────────
await mkSession({ id: 's0', funnel_id: 'f1', page_id: 'p1', total: 80, gateway: 'whop', vid: 'v1',
  customer: cust('carol@x.com', 'ES'), line_items: [{ variant_id: V1, quantity: 1, price: 80 }],
  paid_at: at(D(40), 10) });
await mkSession({ id: 's1', funnel_id: 'f1', page_id: 'p1', total: 100, gateway: 'whop', vid: 'v1',
  customer: cust('alice@x.com', 'ES'), line_items: [{ variant_id: V1, quantity: 1, price: 100, title: 'Widget', product_title: 'Widget' }],
  paid_at: at(D(3), 10) });
await mkSession({ id: 's2', funnel_id: 'f1', page_id: 'p1', total: 200, gateway: 'stripe', vid: 'v2',
  customer: cust('BOB@x.com', 'US'), line_items: [{ variant_id: V1, quantity: 2, price: 100, title: 'Widget', product_title: 'Widget' }],
  refunds: [{ id: 'ref_u1', amount: 25, at: at(D(1), 10) }], // the WHOP double-write
  paid_at: at(D(3), 12) });
await mkSession({ id: 's3', funnel_id: 'f1', page_id: 'p1', total: 50, gateway: 'whop', vid: 'v1',
  customer: cust('alice@x.com', 'ES'), line_items: [{ variant_id: V3, quantity: 1, price: 50, title: 'Mystery', product_title: 'Mystery' }],
  refunds: [{ id: 'ref_b1', amount: 10, at: at(D(1), 11) }],
  paid_at: at(D(2), 9) });
await mkSession({ id: 's5', funnel_id: 'f1', page_id: 'p1', total: 120, gateway: 'whop', vid: 'v2',
  customer: cust('Carol@X.com', 'ES'), line_items: [{ variant_id: V1, quantity: 1, price: 120, title: 'Widget', product_title: 'Widget' }],
  paid_at: at(D(2), 16) });
// f2 — anonymous buyer (⇒ NEW), different country
await mkSession({ id: 's4', funnel_id: 'f2', page_id: 'p3', total: 300, gateway: 'whop', vid: 'v3',
  customer: cust('', 'FR'), line_items: [{ variant_id: V1, quantity: 3, price: 100, title: 'Widget', product_title: 'Widget' }],
  paid_at: at(D(2), 15) });
// f3 — orders, ONE leg, and that leg is uncosted ⇒ coverage 0%, profit withheld
await mkSession({ id: 's6', funnel_id: 'f3', page_id: 'p4', total: 70, gateway: 'whop', vid: 'v11',
  customer: cust('dave@x.com', 'DE'), line_items: [{ variant_id: V3, quantity: 1, price: 70 }],
  paid_at: at(D(2), 11) });
// fnoleg — an order with NO legs at all ⇒ coverage is NULL, not 0
await mkSession({ id: 's7', funnel_id: 'fnoleg', total: 90, gateway: 'whop',
  customer: cust('erin@x.com', 'IT'), line_items: [],
  paid_at: at(D(2), 12) });
// abandoned: two past the grace, one inside it (must NOT count)
await mkSession({ id: 'a1', funnel_id: 'f1', page_id: 'p1', status: 'processing', total: 40,
  paid_at: null, created_at: at(D(2), 10) });
await mkSession({ id: 'a2', funnel_id: 'f1', page_id: 'p1', status: 'processing', total: 40,
  paid_at: null, created_at: at(D(2), 11) });
await q(`INSERT INTO co_sessions (id, funnel_id, page_id, status, total, created_at)
         VALUES ('a3','f1','p1','processing',40, NOW() - interval '2 minutes')`);
// a REFUNDED session that never paid — the trap MONEY_MOVED exists to close
await mkSession({ id: 'x1', funnel_id: 'f1', page_id: 'p1', status: 'refunded', total: 500,
  refunds: [{ id: 'ref_x', amount: 500, at: at(D(2), 12) }], paid_at: null, created_at: at(D(2), 12) });

const mkCharge = async (id, sessionId, amount, status, createdAt, variantId) => {
  await q(
    `INSERT INTO co_upsell_charges (id, session_id, offer_id, charge_id, amount, currency,
                                    status, line_items, created_at)
     VALUES ($1,$2,$7,$1,$3,'USD',$4,$5,$6)`,
    [id, sessionId, amount, status, [{ variant_id: variantId, quantity: 1 }], createdAt, `off_${id}`]
  );
};
await mkCharge('c1', 's1', 40, 'settled', at(D(3), 10.1), V2);
await mkCharge('c2', 's2', 60, 'refunded', at(D(3), 12.1), V2);
await mkCharge('c3', 's1', 0, 'declined', at(D(3), 10.2), V2); // marker row, no money

// The void ledger: the ONLY place the real partial upsell-refund amount lives.
// TWO rows for ONE physical refund (a session in two split tests) — the engine
// must collapse them, not double the refund.
const mkVoid = async (entryId, groupId, sessionId, chargeId, value, createdAt, refundKey) => {
  await q(
    `INSERT INTO lb_split_credits (entry_id, kind, session_id, group_id, arm_key, charge_id,
                                   value, refund_key, created_at)
     VALUES ($1,'void',$2,$3,'A',$4,$5,$6,$7)`,
    [entryId, sessionId, groupId, chargeId, value, refundKey, createdAt]
  );
};
await mkVoid('void:s2|g1|u:c2|ref_u1', 'g1', 's2', 'c2', -25, at(D(1), 10), 'ref_u1');
await mkVoid('void:s2|g2|u:c2|ref_u1', 'g2', 's2', 'c2', -20, at(D(1), 10), 'ref_u1');

// ── traffic ─────────────────────────────────────────────────────────────────
const mkTouch = async (vid, funnelId, pageId, whenIso, utm = {}, referrer = null, url = null) => {
  await q(
    `INSERT INTO lb_touches (vid, funnel_id, page_id, url, referrer, utm, ts, expires_at)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$7::timestamptz + interval '90 days')`,
    [vid, funnelId, pageId, url, referrer, utm, whenIso]
  );
};
await mkTouch('v1', 'f1', 'p1', at(D(3), 9), { utm_source: 'meta', utm_campaign: 'C1' }, 'https://facebook.com/x', 'https://a.com/lp');
await mkTouch('v1', 'f1', 'p1', at(D(2), 8), { utm_source: 'meta', utm_campaign: 'C1' }, 'https://facebook.com/x', 'https://a.com/lp');
await mkTouch('v2', 'f1', 'p1', at(D(3), 11), { utm_source: 'google' }, 'https://google.com/s', 'https://a.com/lp2');
await mkTouch('v2', 'f1', 'p1', at(D(3), 11.5), { utm_source: 'google' }, 'https://google.com/s', 'https://a.com/lp2');
await mkTouch('v3', 'f2', 'p3', at(D(2), 14), {}, null, 'https://b.com/lp');
for (const [i, v] of ['v4', 'v5', 'v6', 'v7'].entries()) {
  await mkTouch(v, 'f1', 'p2', at(D(3), 10 + i * 0.05), { utm_source: 'meta' });
}
for (const v of ['v8', 'v9', 'v10']) await mkTouch(v, 'f1', 'p1', at(D(3), 12), { utm_source: 'meta' });

// ── costs ───────────────────────────────────────────────────────────────────
await q(`INSERT INTO lb_variant_costs (variant_id, pays_shipping) VALUES ($1,false),($2,false),($3,false)`, [V1, V2, V3]);
await q(`INSERT INTO lb_cost_rates (scope, variant_id, effective_from, unit_cogs, ship, source)
         VALUES ('variant',$1,'2020-01-01',10,'{}','manual'), ('variant',$2,'2020-01-01',5,'{}','manual')`, [V1, V2]);
await q(`INSERT INTO lb_fee_settings (id, default_pct, default_fixed) VALUES (1, 6.0, 0)
         ON CONFLICT (id) DO UPDATE SET default_pct = 6.0, default_fixed = 0`);

// ── spend (manual ⇒ known; f2/f3 have none ⇒ tri-state null) ────────────────
await q(`INSERT INTO lb_ad_spend_daily (source, ref_id, day, spend) VALUES
  ('manual','f1',$1,100), ('manual','f1',$2,50)`, [D(3), D(2)]);

await q(`ANALYZE`);

const W = { start_day: D(3), end_day: D(0) };
const F1 = { funnel_id: 'f1' };
const ALL_MONEY = ['orders', 'gross_sales', 'net_sales', 'refunds', 'aov', 'aov_pre_upsell', 'upsell_revenue'];

const run = (body) => runQuery(body, { query: q });
const expect422 = async (body, code, msg) => {
  try {
    await run(body);
    ok(false, msg, 'no throw');
  } catch (e) {
    ok(e instanceof MetricsError && e.status === 422 && (!code || e.code === code), msg, `${e.code}/${e.status}`);
  }
};

// ═══ A: the arithmetic, on f1 ═══════════════════════════════════════════════
{
  const r = await run({ metrics: ALL_MONEY, filters: F1, window: W });
  const t = r.totals;
  ok(t.orders === 4, 'A1 orders = 4 (the never-paid refunded session is excluded)', t.orders);
  ok(near(t.gross_sales, 570), 'A2 gross = base 470 + upsells 100', t.gross_sales);
  ok(near(t.refunds, 35), 'A3 refunds = base 10 + upsell 25 (Whop double-write de-duplicated ONCE)', t.refunds);
  ok(near(t.net_sales, 535), 'A4 net = 570 - 35', t.net_sales);
  ok(near(t.aov, 133.75), 'A5 aov = net / refund-inclusive orders', t.aov);
  ok(near(t.aov_pre_upsell, 108.75), 'A6 aov_pre = (net - upsell) / orders', t.aov_pre_upsell);
  ok(near(t.aov - t.aov_pre_upsell, t.upsell_revenue / t.orders),
    'A7 aov - aov_pre is EXACTLY upsell_revenue/orders (an identity, not an estimate)');
  ok(near(t.upsell_revenue, 100), 'A8 upsell revenue counts the refunded leg at GROSS', t.upsell_revenue);
}

// ═══ U: the reversal nets on the UPSELL line, not on refunds ════════════════
{
  // If the void rows were summed raw (two tests, one refund) refunds would be
  // 55; if the Whop refunds[] entry were also counted it would be 60.
  const r = await run({ metrics: ['refunds', 'net_sales'], filters: F1, window: W });
  ok(near(r.totals.refunds, 35), 'U1 two void rows for ONE physical refund collapse to one', r.totals.refunds);
  const d = await runDashboard({ start: D(3), end: D(0), funnel_id: 'f1' }, { query: q });
  ok(near(d.kpis.upsell_lines.upsell_refunds, 25), 'U2 dashboard nets the reversal on the UPSELL line', d.kpis.upsell_lines.upsell_refunds);
  ok(near(d.kpis.upsell_lines.aov_post, 133.75) && near(d.kpis.upsell_lines.aov_pre, 108.75),
    'U3 the tile labelled AOV publishes BOTH the post- and pre-upsell figure');
  ok(d.kpis.upsell_lines.take_rate !== null, 'U4 take rate is present as a labelled proxy');
}

// ═══ N: new + returning == orders ═══════════════════════════════════════════
{
  const g = await run({ metrics: ['orders', 'new_customers', 'returning_customers'], window: W });
  ok(g.totals.new_customers + g.totals.returning_customers === g.totals.orders,
    'N1 unfiltered: new + returning == orders', JSON.stringify(g.totals));
  ok(g.totals.returning_customers === 1, 'N2 the CASE-DIFFERENT prior buyer is RETURNING (Carol@X.com vs carol@x.com)', g.totals.returning_customers);
  const f = await run({ metrics: ['orders', 'new_customers', 'returning_customers'], filters: F1, window: W });
  ok(f.totals.new_customers + f.totals.returning_customers === f.totals.orders,
    'N3 filtered: the identity survives the filter', JSON.stringify(f.totals));
  const b = await run({ metrics: ['orders', 'new_customers', 'returning_customers'], dimension: 'funnel', window: W });
  ok(b.rows.every((x) => x.new_customers + x.returning_customers === x.orders),
    'N4 the identity holds on EVERY breakdown row');
  ok(b.rows.find((x) => x.key === 'f2')?.new_customers === 1, 'N5 an anonymous buyer counts as NEW');
}

// ═══ T: tri-state ═══════════════════════════════════════════════════════════
{
  const t = await run({ metrics: ['orders', 'sessions', 'pageviews', 'conv_pct', 'rev_per_session'], filters: F1, window: W });
  // 9 distinct visitors, but v1 came back on a second day — and `sessions` is
  // distinct-visitors-PER-DAY summed (the reference's additive definition), so
  // the honest answer is 10, not 9.
  ok(t.totals.sessions === 10, 'T1 sessions = distinct vids PER DAY, summed (a return visit is a second session)', t.totals.sessions);
  ok(t.totals.pageviews === 11, 'T2 pageviews = raw touch rows', t.totals.pageviews);
  ok(near(t.totals.conv_pct, 40), 'T3 conv = orders / sessions', t.totals.conv_pct);
  ok(t.totals.sessions === t.series.reduce((s, p) => s + p.sessions, 0),
    'T3b totals.sessions == the sum of the series drawn beneath it (additive by construction)');
  ok(/per day, summed/.test(t.meta.sessions_basis), 'T3c meta names the bucket the count is distinct within', t.meta.sessions_basis);
  // f3 has orders and NO traffic at all
  const z = await run({ metrics: ['orders', 'sessions', 'conv_pct', 'rev_per_session'], dimension: 'funnel', window: W });
  const f3 = z.rows.find((x) => x.key === 'f3');
  ok(f3.orders === 1 && f3.sessions === 0, 'T4 zero-traffic funnel WITH orders: sessions 0, orders 1');
  ok(f3.conv_pct === null && f3.rev_per_session === null,
    'T5 …and its rates are NULL, never 0 and never Infinity', JSON.stringify(f3));
  // an empty window
  const e = await run({ metrics: ['orders', 'aov', 'conv_pct', 'abandoned_rate'], filters: { funnel_id: 'f2' }, window: { start_day: D(3), end_day: D(3) } });
  ok(e.totals.orders === 0 && e.totals.aov === null, 'T6 empty window: orders 0, aov NULL (not 0.00)');
  ok(e.totals.abandoned_rate === null, 'T7 no checkouts at all ⇒ abandoned_rate NULL');
  // TTL: a window wholly older than the touch retention
  const old = await run({ metrics: ['orders', 'sessions', 'conv_pct'], window: { start_day: D(200), end_day: D(190) } });
  ok(old.totals.sessions === null, 'T8 past-TTL window WITHHOLDS sessions (null, not 0)', old.totals.sessions);
  ok(old.totals.conv_pct === null, 'T9 …and every rate over sessions dashes with it');
  ok(old.meta.warnings.some((x) => x.source === 'lb_touches'), 'T10 …and the withholding is NAMED in warnings');
  ok(old.series.every((p) => p.sessions === null), 'T11 …in every bucket of the series too');
}

// ═══ K: costs + spend ═══════════════════════════════════════════════════════
{
  const c = await run({ metrics: ['net_sales', 'cogs', 'ship_cost', 'fees', 'net_after_cogs', 'margin_pct', 'cost_coverage_pct'], filters: F1, window: W });
  const t = c.totals;
  ok(near(t.cogs, 50), 'K1 cogs = 10+20+10 cart + 5+5 upsell legs (uncosted leg contributes nothing)', t.cogs);
  ok(near(t.fees, 34.2), 'K2 fees are billed PER TRANSACTION, not once on the order total', t.fees);
  ok(near(t.net_after_cogs, 450.8), 'K3 net_after_cogs = net - cogs - ship - fees', t.net_after_cogs);
  ok(near(t.cost_coverage_pct, 83.33), 'K4 coverage names how much of the cost side is still guesswork', t.cost_coverage_pct);
  const b = await run({ metrics: ['orders', 'net_after_cogs', 'margin_pct', 'cost_coverage_pct'], dimension: 'funnel', window: W });
  const f3 = b.rows.find((x) => x.key === 'f3');
  ok(f3.net_after_cogs === null && f3.margin_pct === null,
    'K5 ZERO coverage WITHHOLDS profit — a funnel nobody has costed never reads 100% margin');
  ok(near(f3.cost_coverage_pct, 0), 'K6 …and its coverage is a real 0%, because it HAS a leg', f3.cost_coverage_pct);
  const noleg = b.rows.find((x) => x.key === 'fnoleg');
  ok(noleg.cost_coverage_pct === null, 'K7 an order with NO legs has NULL coverage — "0%" and "nothing to cover" are different facts');
  const s = await run({ metrics: ['net_sales', 'spend', 'roas', 'cpa', 'net_profit'], dimension: 'funnel', window: W });
  const r1 = s.rows.find((x) => x.key === 'f1');
  ok(near(r1.spend, 150), 'K8 manual spend is KNOWN', r1.spend);
  ok(near(r1.roas, 3.57) && near(r1.cpa, 37.5), 'K9 roas/cpa computed off known spend', `${r1.roas}/${r1.cpa}`);
  const r2 = s.rows.find((x) => x.key === 'f2');
  ok(r2.spend === null && r2.roas === null && r2.cpa === null && r2.net_profit === null,
    'K10 UNKNOWN spend is NULL everywhere — a 0 would read as "no ad spend"', JSON.stringify(r2));
}

// ═══ L: legality — 422 BEFORE any query ═════════════════════════════════════
{
  await expect422({ metrics: ['spend'], dimension: 'country', window: W }, 'illegal_metric_for_dimension', 'L1 spend on country is illegal (no honest split of a budget)');
  await expect422({ metrics: ['pageviews'], dimension: 'country', window: W }, 'illegal_metric_for_dimension', 'L2 pageviews on country is illegal (no geo on the traffic spine)');
  await expect422({ metrics: ['upsell_revenue'], dimension: 'gateway', window: W }, 'illegal_metric_for_dimension', 'L3 upsell_revenue on a captured_base dimension is illegal');
  await expect422({ metrics: ['net_sales'], dimension: 'product', window: W }, 'illegal_metric_for_dimension', 'L4 net_sales on product is illegal (a refund has no line reference)');
  await expect422({ metrics: ['cogs'], dimension: 'product', window: W }, 'illegal_metric_for_dimension', 'L5 no cost metric on product');
  await expect422({ metrics: ['sessions'], dimension: 'device', window: W }, 'dimension_unavailable', 'L6 device is REGISTERED but unavailable ⇒ 422 with a reason');
  await expect422({ metrics: ['orders'], dimension: 'nope', window: W }, 'unknown_dimension', 'L7 unknown dimension');
  await expect422({ metrics: ['profit'], window: W }, 'unknown_metric', 'L8 unknown metric');
  await expect422({ metrics: [], window: W }, 'metrics_required', 'L9 empty metric list');
  await expect422({ metrics: [...METRICS].slice(0, 9), window: W }, 'too_many_metrics', 'L10 more than 8 metrics');
  await expect422({ metrics: ['orders'], window: W, granularity: 'hour' }, 'hour_requires_single_day', 'L11 hourly across a multi-day window');
  await expect422({ metrics: ['orders'], window: W, granularity: 'fortnight' }, 'unknown_granularity', 'L12 unknown granularity');
  await expect422({ metrics: ['orders'], window: { start_day: '2026-02-31', end_day: D(0) } }, 'invalid_date', 'L13 a date that looks valid but is not a day');
  await expect422({ metrics: ['orders'], window: { start_day: 'yesterday', end_day: D(0) } }, 'invalid_date_format', 'L14 malformed day');
  await expect422({ metrics: ['orders'], window: { start_day: D(400), end_day: D(0) } }, 'window_too_large', 'L15 a 401-day window is refused');
  await expect422({ metrics: ['orders'], window: { start_day: D(0), end_day: D(3) } }, 'to_before_from', 'L16 reversed window');
  await expect422({ metrics: ['orders'], window: W, limit: 9999 }, 'bad_limit', 'L17 limit beyond the cap');
  ok(await run({ metrics: ['orders'], window: { start_day: D(399), end_day: D(0) } }).then(() => true).catch(() => false),
    'L18 a 400-day window is ACCEPTED (the boundary is inclusive)');
  // The gate really is BEFORE the database: a legality refusal must not depend
  // on the tables existing at all.
  let touchedDb = false;
  const spy = async (...a) => { touchedDb = true; return q(...a); };
  try { await runQuery({ metrics: ['spend'], dimension: 'country', window: W }, { query: spy }); } catch { /* expected */ }
  ok(touchedDb === false, 'L19 an illegal combination NEVER reaches the database');

  // ── HOURLY EXCLUSIONS — day-only metrics are refused hourly REGARDLESS OF
  //    DIMENSION. Both branches are checked (no dimension, and with one),
  //    because "with a dimension present" is exactly the case a client that
  //    mirrors the rule gets wrong.
  const oneDay = { start_day: D(3), end_day: D(3) };
  for (const m of HOUR_ONLY_EXCLUSIONS) {
    await expect422({ metrics: [m], window: oneDay, granularity: 'hour' },
      'metric_not_available_hourly', `L20 '${m}' is refused at granularity=hour (no dimension)`);
  }
  await expect422({ metrics: ['spend'], dimension: 'funnel', window: oneDay, granularity: 'hour' },
    'metric_not_available_hourly', 'L21 …and refused hourly WITH a dimension present');
  await expect422({ metrics: ['new_customers'], dimension: 'country', window: oneDay, granularity: 'hour' },
    'metric_not_available_hourly', 'L22 …on a dimension where the metric is otherwise perfectly legal');
  await expect422({ metrics: ['orders', 'cogs'], dimension: 'funnel', window: oneDay, granularity: 'hour' },
    'metric_not_available_hourly', 'L23 …and ONE day-only metric poisons an otherwise-hourly list');
  // The complement really does still work hourly.
  const hourly = await run({ metrics: ['orders', 'gross_sales', 'sessions', 'conv_pct'], filters: F1, window: oneDay, granularity: 'hour' });
  ok(hourly.series.length >= 23, 'L24 an hourly-legal metric list is still served hourly', hourly.series.length);
  ok(HOUR_ONLY_EXCLUSIONS.every((m) => METRICS.includes(m)),
    'L25 every excluded metric is a real metric (the list cannot rot into nonsense)');
  ok(MAX_WINDOW_DAYS === 400, 'L26 the published window cap is 400 days', MAX_WINDOW_DAYS);
}

// ═══ CONTRACT — the keys the client is coded against ════════════════════════
{
  const r = await run({ metrics: ['orders', 'net_sales'], filters: F1, window: { start_day: D(2), end_day: D(1) }, compare: true });
  ok(Array.isArray(r.previous?.series) && r.prev_series === undefined,
    'CT1 /query compare ships previous.series — `prev_series` is the DASHBOARD key only');
  ok(r.meta.window.start === D(2) && r.meta.window.end === D(1) && r.meta.window.timezone === 'Europe/Madrid',
    'CT2 every response echoes the window as {start,end,timezone}', JSON.stringify(r.meta.window));
  ok(r.meta.window.start_day === r.meta.window.start && r.meta.window.end_day === r.meta.window.end,
    'CT3 …and the request-vocabulary spelling agrees with it, byte for byte');
  const b = await run({ metrics: ['net_sales'], dimension: 'funnel', window: W, limit: 1 });
  ok(b.rows.length === 1, 'CT4 limit is honoured', b.rows.length);
  ok(b.meta.rows_total > 1 && b.meta.rows_truncated === true,
    'CT5 …and rows_total reports the PRE-truncation count for a Top-N-of-M footer', `${b.meta.rows_total}`);
  const full = await run({ metrics: ['net_sales'], dimension: 'funnel', window: W });
  ok(near(b.totals.net_sales, full.totals.net_sales),
    'CT6 …while totals fold ALL buckets, not just the page (the footer $total is the real one)');
  ok(b.meta.rows_total === full.rows.length, 'CT7 rows_total equals the untruncated row count', `${b.meta.rows_total}/${full.rows.length}`);
  ok(full.meta.rows_truncated === false, 'CT8 an untruncated breakdown says so');
  ok(typeof b.meta.basis_label === 'string' && b.meta.basis_label.length > 10, 'CT9 basis_label on every breakdown');
  const d = await runDashboard({ start: D(3), end: D(0) }, { query: q });
  ok(Array.isArray(d.prev_series) && d.previous === undefined,
    'CT10 the dashboard ships prev_series (flat) — the two endpoints keep their documented keys');
  ok(d.meta.window.start === D(3) && d.meta.window.timezone === 'Europe/Madrid',
    'CT11 the dashboard carries the same meta.window echo', JSON.stringify(d.meta.window));
  ok(Object.values(d.breakdown_summary).every((s) => typeof s.rows_total === 'number' && s.basis_label),
    'CT12 every composite breakdown ships rows_total + basis_label for its footer');
}

// ═══ B: bases ═══════════════════════════════════════════════════════════════
{
  for (const d of DIMENSIONS.filter((x) => x !== 'device')) {
    const metrics = ['orders'].filter((m) => DIM_METRICS[d].has(m));
    const r = await run({ metrics, dimension: d, window: W });
    // basis_label COMPOSES the metric phrase with the population phrase, so it
    // is no longer byte-equal to the population label — it must CONTAIN it.
    ok(r.meta.basis === BREAKDOWN_BASES[d]
      && r.meta.basis_label.includes(BREAKDOWN_BASIS_LABELS[BREAKDOWN_BASES[d]]),
    `B1 dimension '${d}' names its basis (${r.meta.basis}) and folds the population phrase into the label`,
    r.meta.basis_label);
    ok(typeof r.meta.basis_label === 'string' && r.meta.basis_label.length > 10,
      `B2 dimension '${d}' ships an operator-facing basis label`);
  }
  // captured_base is TRUE, not merely printed: on gateway the upsell fold does
  // not run, so gross is the captured base ONLY (470, not 570).
  const g = await run({ metrics: ['gross_sales'], dimension: 'gateway', filters: F1, window: W });
  const sum = g.rows.reduce((t, r) => t + r.gross_sales, 0);
  ok(near(sum, 470), 'B3 captured_base really EXCLUDES upsell money (470, not 570)', sum);
  const f = await run({ metrics: ['gross_sales'], dimension: 'funnel', filters: F1, window: W });
  ok(near(f.rows[0].gross_sales, 570), 'B4 …while the gross basis INCLUDES it (570)', f.rows[0].gross_sales);
  ok(g.meta.basis_label.includes('upsell'), 'B5 the captured-base copy names what is missing');
  // product = line_items basis
  const p = await run({ metrics: ['orders', 'gross_sales'], dimension: 'product', filters: F1, window: W });
  ok(p.meta.basis === 'line_items', 'B6 product is the line_items basis');
  ok(p.meta.warnings.some((w) => w.source === 'product_dimension'), 'B7 …and the per-line order count is named, not hidden');
}

// ═══ C: compare ═════════════════════════════════════════════════════════════
{
  const r = await run({ metrics: ['orders', 'net_sales'], filters: F1, window: { start_day: D(2), end_day: D(1) }, compare: true });
  ok(r.series.length === 2 && r.previous.series.length === 2, 'C1 compare series are EQUAL LENGTH');
  ok(r.previous.window.start_day === D(4) && r.previous.window.end_day === D(3),
    'C2 previous is the immediately-preceding equal-length window', JSON.stringify(r.previous.window));
  ok(r.totals.orders === 2, 'C3 current window orders', r.totals.orders);
  ok(r.previous.totals.orders === 2, 'C4 previous window orders', r.previous.totals.orders);
  ok(r.previous.series[1].orders === 2 && r.previous.series[0].orders === 0,
    'C5 series are aligned BY INDEX (position 1 of the previous window, not by date key)');
  ok(r.previous.aligned_by === 'index', 'C6 …and the payload says so');
  const b = await run({ metrics: ['orders'], dimension: 'funnel', window: W, compare: true });
  ok(Array.isArray(b.previous.rows), 'C7 breakdowns compare too');
}

// ═══ W: week / month recomputed from folded sums ════════════════════════════
{
  // Two days in the SAME Madrid week: one at 100% conv, one at 10%.
  // Averaging the daily rates gives 55%; the truth is 2/11 = 18.18%.
  let d1 = null;
  for (let n = 4; n < 12; n += 1) {
    if (weekKey(D(n)) === weekKey(D(n - 1))) { d1 = n; break; }
  }
  ok(d1 !== null, 'W0 found two adjacent days inside one Madrid week');
  const dayA = D(d1); const dayB = D(d1 - 1);
  await mkSession({ id: 'w1', funnel_id: 'fweek', total: 100, customer: cust('w1@x.com', 'ES'),
    line_items: [{ variant_id: V1, quantity: 1, price: 100 }], paid_at: at(dayA, 10) });
  await mkSession({ id: 'w2', funnel_id: 'fweek', total: 100, customer: cust('w2@x.com', 'ES'),
    line_items: [{ variant_id: V1, quantity: 1, price: 100 }], paid_at: at(dayB, 10) });
  await mkTouch('wv1', 'fweek', null, at(dayA, 9));
  for (let i = 0; i < 10; i += 1) await mkTouch(`wv${i + 2}`, 'fweek', null, at(dayB, 9));

  const day = await run({ metrics: ['orders', 'sessions', 'conv_pct'], filters: { funnel_id: 'fweek' }, window: { start_day: dayA, end_day: dayB }, granularity: 'day' });
  const rates = day.series.map((p) => p.conv_pct);
  const mean = rates.reduce((a, b) => a + b, 0) / rates.length;
  const wk = await run({ metrics: ['orders', 'sessions', 'conv_pct'], filters: { funnel_id: 'fweek' }, window: { start_day: dayA, end_day: dayB }, granularity: 'week' });
  ok(wk.series.length === 1, 'W1 both days fold into ONE Madrid-calendar week bucket', wk.series.length);
  ok(wk.series[0].orders === 2 && wk.series[0].sessions === 11, 'W2 the week folds the SUMS', JSON.stringify(wk.series[0]));
  ok(near(wk.series[0].conv_pct, 18.18), 'W3 the week rate is RECOMPUTED from the sums (18.18%)', wk.series[0].conv_pct);
  ok(!near(wk.series[0].conv_pct, mean, 1), `W4 …and is NOT the average of the daily rates (${mean.toFixed(2)}%)`);
  const mo = await run({ metrics: ['orders', 'sessions', 'conv_pct'], filters: { funnel_id: 'fweek' }, window: { start_day: dayA, end_day: dayB }, granularity: 'month' });
  ok(mo.series.every((p) => p.key.length === 7), 'W5 month buckets are YYYY-MM keys');
  const moTotal = mo.series.reduce((t, p) => t + p.orders, 0);
  ok(moTotal === 2, 'W6 month buckets conserve the order count', moTotal);
  ok(near(wk.totals.conv_pct, 18.18), 'W7 window TOTALS recompute the ratio too');
}

// ═══ Z: REPORT_TZ ═══════════════════════════════════════════════════════════
{
  ok(REPORT_TZ === 'Europe/Madrid', 'Z0 REPORT_TZ is Europe/Madrid', REPORT_TZ);

  // Z1 — a 23:30Z order belongs to the NEXT Madrid day (Madrid is UTC+1/+2, so
  // this holds year-round).
  const day = D(5);
  const next = D(4);
  await mkSession({ id: 'tz1', funnel_id: 'ftz', total: 10, customer: cust('tz@x.com', 'ES'),
    line_items: [], paid_at: `${day}T23:30:00Z` });
  const r = await run({ metrics: ['orders'], filters: { funnel_id: 'ftz' }, window: { start_day: day, end_day: next } });
  const onDay = r.series.find((p) => p.key === day).orders;
  const onNext = r.series.find((p) => p.key === next).orders;
  ok(onDay === 0 && onNext === 1, `Z1 a ${day}T23:30Z order lands on the NEXT Madrid day (${next})`, `${onDay}/${onNext}`);

  // Z2/Z3 — the DST days really are 23h and 25h, and zonedDayStart proves it.
  ok(hoursInLocalDay('2026-03-29') === 23, 'Z2 2026-03-29 (spring forward) is a 23-hour Madrid day', hoursInLocalDay('2026-03-29'));
  ok(hoursInLocalDay('2025-10-26') === 25, 'Z3 2025-10-26 (fall back) is a 25-hour Madrid day', hoursInLocalDay('2025-10-26'));
  ok(zonedDayStart('2026-03-29').toISOString() === '2026-03-28T23:00:00.000Z', 'Z4 CET midnight is 23:00Z the day before', zonedDayStart('2026-03-29').toISOString());
  ok(zonedDayStart('2026-03-30').toISOString() === '2026-03-29T22:00:00.000Z', 'Z5 CEST midnight is 22:00Z the day before', zonedDayStart('2026-03-30').toISOString());

  // Z6 — the 25-hour day sums right, INCLUDING the wall-clock hour that
  // happened twice, and the instant after local midnight rolls to the next day.
  const seedDst = async (id, iso, total) => mkSession({
    id, funnel_id: 'fdst', total, customer: cust(`${id}@x.com`, 'ES'), line_items: [], paid_at: iso,
  });
  await seedDst('d1', '2025-10-25T22:30:00Z', 1); // 00:30 CEST on the 26th
  await seedDst('d2', '2025-10-26T00:30:00Z', 1); // 02:30 CEST — first pass
  await seedDst('d3', '2025-10-26T01:30:00Z', 1); // 02:30 CET  — the repeat
  await seedDst('d4', '2025-10-26T22:30:00Z', 1); // 23:30 CET on the 26th
  await seedDst('d5', '2025-10-26T23:30:00Z', 1); // 00:30 CET on the 27th
  const fall = await run({ metrics: ['orders', 'gross_sales'], filters: { funnel_id: 'fdst' },
    window: { start_day: '2025-10-25', end_day: '2025-10-27' } });
  const on26 = fall.series.find((p) => p.key === '2025-10-26');
  const on27 = fall.series.find((p) => p.key === '2025-10-27');
  ok(on26.orders === 4, 'Z6 the 25-hour Madrid day holds all four of its orders', on26.orders);
  ok(on27.orders === 1, 'Z7 …and the 23:30Z one rolls onto the next Madrid day', on27.orders);
  ok(fall.series.reduce((t, p) => t + p.orders, 0) === 5, 'Z8 no order is lost or double-counted across the transition');
  ok(fall.meta.warnings.some((w) => w.source === 'timezone'), 'Z9 the DST transition is NAMED in warnings');

  // Z10 — the 23-hour day
  await seedDst('d6', '2026-03-28T23:30:00Z', 1); // 00:30 CET on the 29th
  await seedDst('d7', '2026-03-29T01:30:00Z', 1); // 03:30 CEST on the 29th (the skipped hour is gone)
  await seedDst('d8', '2026-03-29T22:30:00Z', 1); // 00:30 CEST on the 30th
  const spring = await run({ metrics: ['orders'], filters: { funnel_id: 'fdst' },
    window: { start_day: '2026-03-28', end_day: '2026-03-30' } });
  ok(spring.series.find((p) => p.key === '2026-03-29').orders === 2, 'Z10 the 23-hour Madrid day holds its two orders');
  ok(spring.series.find((p) => p.key === '2026-03-30').orders === 1, 'Z11 …and the 22:30Z one is already the next Madrid day');

  // Z12 — hourly buckets follow the real clock, not a hard-coded 24
  ok(bucketsFor({ from: '2025-10-26', to: '2025-10-26' }, 'hour').length === 24,
    'Z12 the repeated wall-clock hour folds into ONE bucket (24 labels for a 25h day)',
    bucketsFor({ from: '2025-10-26', to: '2025-10-26' }, 'hour').length);
  ok(bucketsFor({ from: '2026-03-29', to: '2026-03-29' }, 'hour').length === 23,
    'Z13 the skipped hour is NOT invented (23 labels for a 23h day)',
    bucketsFor({ from: '2026-03-29', to: '2026-03-29' }, 'hour').length);

  // Z14 — week keys are Madrid-calendar. The 2025-10-26T23:30Z order is Madrid
  // Monday the 27th, so its ISO week starts 2025-10-27 — a UTC read would put
  // it on Sunday the 26th, in the week starting 2025-10-20.
  ok(weekKey('2025-10-27') === '2025-10-27' && weekKey('2025-10-26') === '2025-10-20',
    'Z14 ISO week starts on Monday');
  const wkDst = await run({ metrics: ['orders'], filters: { funnel_id: 'fdst' },
    window: { start_day: '2025-10-20', end_day: '2025-10-27' }, granularity: 'week' });
  const wkLate = wkDst.series.find((p) => p.key === '2025-10-27');
  ok(wkLate && wkLate.orders === 1, 'Z15 the 23:30Z order weeks with the Madrid Monday, not the UTC Sunday', JSON.stringify(wkDst.series));
  ok(monthKey('2025-10-26') === '2025-10', 'Z16 month keys are YYYY-MM');

  // Z17 — hourly granularity actually buckets on Madrid hours
  const hr = await run({ metrics: ['orders'], filters: { funnel_id: 'ftz' }, window: { start_day: next, end_day: next }, granularity: 'hour' });
  const h = hr.series.find((p) => p.orders > 0);
  // 23:30Z is 00:30 or 01:30 Madrid depending on the season — either way the
  // order sits in a SMALL-HOURS bucket of the NEXT day, never in hour 23.
  ok(h && h.key.startsWith(`${next}T0`), `Z17 the 23:30Z order buckets into a small-hours Madrid hour of ${next}`, h?.key);
  ok(hr.series.length >= 23 && hr.series.length <= 25, 'Z18 an hourly day has 23..25 buckets', hr.series.length);
  ok(hr.series.reduce((t, p) => t + p.orders, 0) === 1, 'Z19 the hourly fold conserves the order');
  ok(hr.meta.timezone === 'Europe/Madrid', 'Z20 meta.timezone is published on every response', hr.meta.timezone);
}

// ═══ E: remaining edges ═════════════════════════════════════════════════════
{
  const ab = await run({ metrics: ['orders', 'abandoned', 'abandoned_rate'], filters: F1, window: W });
  ok(ab.totals.abandoned === 2, 'E1 abandoned counts only processing sessions past the 3600s grace', ab.totals.abandoned);
  ok(near(ab.totals.abandoned_rate, 33.33), 'E2 abandoned_rate = abandoned / (abandoned + orders)', ab.totals.abandoned_rate);
  const csvBody = { metrics: ['orders', 'net_sales'], dimension: 'funnel', window: W };
  const csv = toCsv(await run(csvBody), validateQuery(csvBody));
  ok(csv.split('\n')[0] === 'key,label,orders,net_sales', 'E3 CSV header', csv.split('\n')[0]);
  ok(csv.includes('totals,'), 'E4 CSV carries a totals row');
  ok(csvCell('=cmd|calc') === "'=cmd|calc", 'E5 CSV formula injection is neutralised', csvCell('=cmd|calc'));
  ok(csvCell('-2+3') === "'-2+3" && csvCell('@SUM(A1)') === "'@SUM(A1)" && csvCell('\tx') === "'\tx",
    'E6 …for every formula prefix Excel honours');
  ok(csvCell(null) === '', 'E7 a null cell is EMPTY in CSV — never a 0');
  const meta = await run({ metrics: ['orders'], window: W });
  ok(typeof meta.meta.computed_ms === 'number' && typeof meta.meta.rows_scanned === 'number',
    'E8 every response carries computed_ms + rows_scanned');
  // computeMetrics is pure — drive the withholding directly
  const pureNull = computeMetrics({ orders: 0, base_revenue: 0, upsell_revenue: 0, upsell_legs: 0,
    base_refunds: 0, upsell_refunds: 0, sessions: 0, pageviews: 0, upsell_views: 0,
    sessions_unknown: true, new_customers: 0, returning_customers: 0, abandoned: 0,
    cogs: 0, ship_cost: 0, fees: 0, known_legs: 0, missing_legs: 0, spend: 0, spend_known: false },
  ['sessions', 'conv_pct', 'aov', 'roas', 'net_after_cogs', 'cost_coverage_pct']);
  ok(Object.values(pureNull).every((v) => v === null), 'E9 an all-unknown fold returns NULL for every derived metric', JSON.stringify(pureNull));
}

// ═══ WIRE CONTRACT, SECOND BATCH ════════════════════════════════════════════
// (1) scalar total + rows_total on every breakdown block
// (2) funnel rows carry name
// (3) basis_label follows the metric actually folded
// (4) meta.sessions_unknown on the wire
// (5) GET /band as its own read
// (6) every warning carries a string reason
// (7) FUTURE report-day buckets are null, not zero
{
  // ── (3) basis_label describes the METRIC, not just the dimension ─────────
  const net = await run({ metrics: ['net_sales', 'orders'], dimension: 'funnel', window: W });
  ok(net.meta.basis_label.startsWith('Net sales'),
    'X1 a net_sales breakdown leads with "Net sales", NOT "Gross sales"', net.meta.basis_label);
  ok(!/gross sales/i.test(net.meta.basis_label),
    'X2 …and the phrase "gross sales" appears nowhere in it', net.meta.basis_label);
  ok(net.meta.basis_metric === 'net_sales', 'X3 basis_metric names the figure', net.meta.basis_metric);
  const gross = await run({ metrics: ['gross_sales'], dimension: 'funnel', window: W });
  ok(gross.meta.basis_label.startsWith('Gross sales'), 'X4 …while a gross_sales breakdown DOES say Gross sales', gross.meta.basis_label);
  ok(gross.meta.basis_label.includes('captured base plus upsells'),
    'X5 …and still names the population it folded', gross.meta.basis_label);
  const gw = await run({ metrics: ['net_sales'], dimension: 'gateway', window: W });
  ok(gw.meta.basis_label.startsWith('Net sales') && gw.meta.basis_label.includes('upsell money has no gateway'),
    'X6 metric phrase + captured-base population compose correctly', gw.meta.basis_label);
  const traffic = await run({ metrics: ['sessions'], dimension: 'source', window: W });
  ok(/not money/.test(traffic.meta.basis_label),
    'X7 a fold with NO money metric says so rather than mislabelling itself', traffic.meta.basis_label);

  // ── (2) funnel rows carry name; key stays the id; '(none)' preserved ─────
  await mkSession({ id: 'nofid', funnel_id: '', total: 25, customer: cust('nf@x.com', 'ES'),
    line_items: [], paid_at: at(D(2), 13) });
  const f = await run({ metrics: ['net_sales'], dimension: 'funnel', window: W });
  const alpha = f.rows.find((r) => r.key === 'f1');
  ok(alpha.name === 'Alpha', 'X8 funnel rows carry funnels.name', alpha.name);
  ok(alpha.key === 'f1', 'X9 …while the KEY stays the funnel id (two funnels may share a name)', alpha.key);
  ok(alpha.label === 'Alpha', 'X10 …and label upgrades to the readable name');
  const none = f.rows.find((r) => r.key === '(none)');
  ok(none && none.label === '(none)' && none.name === null,
    'X11 the "(none)" bucket is PRESERVED, unlooked-up, with a null name', JSON.stringify(none && { k: none.key, l: none.label, n: none.name }));
  const fCmp = await run({ metrics: ['net_sales'], dimension: 'funnel', window: W, compare: true });
  ok(fCmp.previous.rows.every((r) => 'name' in r), 'X12 the previous-window rows carry name too');
  const notFunnel = await run({ metrics: ['net_sales'], dimension: 'gateway', window: W });
  ok(notFunnel.rows.every((r) => r.name === undefined), 'X13 …and no other dimension grows a bogus name');

  // ── (1) scalar total + rows_total ───────────────────────────────────────
  const lim = await run({ metrics: ['net_sales'], dimension: 'funnel', window: W, limit: 1 });
  ok(lim.meta.total_metric === 'net_sales', 'X14 the breakdown names its footer metric', lim.meta.total_metric);
  ok(near(lim.meta.total, lim.totals.net_sales),
    'X15 …and the scalar total is the PRE-truncation fold, not the page', `${lim.meta.total}/${lim.totals.net_sales}`);
  ok(lim.meta.total > lim.rows[0].net_sales, 'X16 …which is strictly larger than the one row shown');

  // ── (4) meta.sessions_unknown on the wire ───────────────────────────────
  const okWin = await run({ metrics: ['orders', 'sessions'], filters: F1, window: W });
  ok(okWin.meta.sessions_unknown === false, 'X17 meta.sessions_unknown is false on a measurable window', okWin.meta.sessions_unknown);
  const ttlWin = await run({ metrics: ['orders', 'sessions'], window: { start_day: D(200), end_day: D(190) } });
  ok(ttlWin.meta.sessions_unknown === true, 'X18 …and true when the TTL clamp withheld sessions', ttlWin.meta.sessions_unknown);
  ok(ttlWin.totals.sessions === null, 'X19 …matching the withheld value it explains');

  // ── (6) every warning carries a string reason ───────────────────────────
  const warned = [okWin, ttlWin, net, await run({ metrics: ['orders'], dimension: 'product', window: W }),
    await run({ metrics: ['orders'], filters: { funnel_id: 'f1', source: 'meta' }, dimension: 'funnel', window: W })];
  const allWarnings = warned.flatMap((r) => r.meta.warnings);
  ok(allWarnings.length > 0, 'X20 the fixture actually produced warnings to check', allWarnings.length);
  ok(allWarnings.every((w) => typeof w.source === 'string' && w.source.length > 0),
    'X21 every warning has a non-empty string source');
  ok(allWarnings.every((w) => typeof w.reason === 'string' && w.reason.length > 0),
    'X22 every warning has a non-empty string reason (an empty banner is worse than none)',
    JSON.stringify(allWarnings.filter((w) => typeof w.reason !== 'string')));

  // ── (7) FUTURE report-days are null, not zero — the Auckland cliff ──────
  const future = await run({ metrics: ['orders', 'gross_sales', 'net_sales', 'sessions'], filters: F1,
    window: { start_day: D(1), end_day: dayFwd(3) } });
  const past = future.series.filter((p) => p.key <= T0);
  const ahead = future.series.filter((p) => p.key > T0);
  ok(ahead.length === 3, 'X23 the window really does contain three unstarted days', ahead.length);
  ok(ahead.every((p) => p.future === true), 'X24 unstarted buckets are flagged future');
  ok(ahead.every((p) => p.orders === null && p.gross_sales === null && p.net_sales === null && p.sessions === null),
    'X25 …and report NULL money, never 0 (no cliff-to-zero on the chart)', JSON.stringify(ahead[0]));
  ok(past.every((p) => p.future === false), 'X26 today and earlier are NOT future');
  const todayPoint = future.series.find((p) => p.key === T0);
  ok(todayPoint && todayPoint.orders !== null,
    'X27 TODAY is partial but REAL — it reports a number, not a null', todayPoint?.orders);
  ok(future.meta.warnings.some((w) => w.source === 'window' && /null, never 0/.test(w.reason)),
    'X28 …and the future gap is NAMED so it reads as "not yet", not "data lost"');
  ok(near(future.totals.orders, past.reduce((t, p) => t + p.orders, 0)),
    'X29 totals are unaffected — a future bucket contributes nothing either way');
}

// ═══ (5) GET /band — the 15s repoll target ══════════════════════════════════
{
  const band = await M.runBand({}, { query: q });
  for (const k of ['live', 'unique_today', 'today', 'yesterday', 'timezone', 'meta']) {
    ok(Object.prototype.hasOwnProperty.call(band, k), `BND1 band ships '${k}'`);
  }
  ok(band.today.day === T0 && band.yesterday.day === D(1), 'BND2 the band is always [yesterday, today] in REPORT_TZ',
    `${band.today.day}/${band.yesterday.day}`);
  for (const k of ['day', 'orders', 'revenue', 'spend', 'net']) {
    ok(Object.prototype.hasOwnProperty.call(band.today, k), `BND3 today block ships '${k}'`);
  }
  ok(band.timezone === 'Europe/Madrid', 'BND4 the band names the reporting timezone', band.timezone);
  ok(typeof band.meta.computed_ms === 'number', 'BND5 the band carries computed_ms', band.meta.computed_ms);
  ok(band.today.spend === null || typeof band.today.spend === 'number',
    'BND6 spend is a number or NULL — never a fabricated 0');

  // The dashboard MUST serve the identical block, or the first paint and the
  // 15s repoll print different numbers under the same two labels.
  const d = await runDashboard({ start: D(3), end: D(0) }, { query: q });
  for (const k of ['live', 'unique_today']) {
    ok(typeof d.band[k] === 'number', `BND7 dashboard band ships '${k}'`);
  }
  ok(JSON.stringify(d.band.today) === JSON.stringify(band.today)
    && JSON.stringify(d.band.yesterday) === JSON.stringify(band.yesterday),
  'BND8 the dashboard band is BYTE-IDENTICAL to GET /band (one derivation)',
  `${JSON.stringify(d.band.today)} vs ${JSON.stringify(band.today)}`);
  ok(d.band.in_window === true, 'BND9 …plus in_window, saying whether the CHART covers today', d.band.in_window);
  const outWin = await runDashboard({ start: D(30), end: D(10) }, { query: q });
  ok(outWin.band.in_window === false && outWin.band.today.day === T0,
    'BND10 a window that excludes today still reports TODAY in the band — "live" means live');
  // Cheapness is the whole reason it exists; measure it rather than assert it.
  const bt = []; const dt = [];
  for (let i = 0; i < 3; i += 1) {
    bt.push((await M.runBand({}, { query: q })).meta.computed_ms);
    dt.push((await runDashboard({ start: D(3), end: D(0) }, { query: q })).meta.computed_ms);
  }
  console.log(`  → band ${bt.join('/')}ms vs composite ${dt.join('/')}ms`);
  ok(true, `BND11 band timing recorded: ${bt.join('/')}ms vs composite ${dt.join('/')}ms`);

  // (1) again, on the composite's own summary blocks
  ok(Object.values(d.breakdown_summary).every((s) => typeof s.rows_total === 'number' && s.total_metric),
    'BND12 every composite breakdown ships rows_total + total_metric');
  ok(Object.values(d.breakdown_summary).every((s) => s.total === null || typeof s.total === 'number'),
    'BND13 …and a scalar total that is a number or NULL');
  ok(near(d.breakdown_summary.funnels.total, d.breakdown_summary.funnels.totals.net_sales),
    'BND14 …equal to the pre-truncation fold of its own metric');
  ok(!/gross sales/i.test(d.breakdown_summary.funnels.basis_label),
    'BND15 the funnels block (net_sales) does not say "Gross sales"', d.breakdown_summary.funnels.basis_label);
  ok(d.breakdown_summary.funnels.rows.every((r) => 'name' in r), 'BND16 composite funnel rows carry name');
  ok(typeof d.meta.sessions_unknown === 'boolean', 'BND17 the dashboard surfaces sessions_unknown', d.meta.sessions_unknown);
  ok(d.meta.warnings.every((w) => typeof w.reason === 'string' && w.reason.length > 0),
    'BND18 every dashboard warning carries a string reason');
}

// ═══ PRESETS ════════════════════════════════════════════════════════════════
{
  const presets = reportPresets(D(3), D(0));
  ok(presets.length === 16, `PR1 the library ships ${presets.length} presets (18 reference − 4 unservable + 2 additions)`, presets.length);
  ok(UNSERVABLE_PRESETS.length === 4, 'PR2 the four unservable reference reports are NAMED with reasons', UNSERVABLE_PRESETS.length);
  ok(presets.some((p) => p.id === 'contribution_margin_by_funnel') && presets.some((p) => p.id === 'net_profit_by_funnel'),
    'PR3 the two additions are present');
  let bad = 0;
  for (const p of presets) {
    try {
      await run(p.query);
    } catch (e) {
      bad += 1;
      console.log('  preset failed:', p.id, e.code, e.message);
    }
  }
  ok(bad === 0, 'PR4 EVERY preset runs against the real engine — none 422s', `${bad} failed`);
  ok(presets.every((p) => p.label && p.category && p.query), 'PR5 every preset carries id/label/category/query');
}

// ═══ DASHBOARD ══════════════════════════════════════════════════════════════
{
  const d = await runDashboard({ start: D(3), end: D(0) }, { query: q });
  for (const k of ['band', 'kpis', 'series', 'prev_series', 'breakdown_summary', 'waterfall', 'movers', 'window', 'meta']) {
    ok(Object.prototype.hasOwnProperty.call(d, k), `DB1 dashboard ships '${k}'`);
  }
  ok(d.series.length === d.prev_series.length, 'DB2 series and prev_series are equal length (index-aligned)');
  ok(d.window.timezone === 'Europe/Madrid' && d.window.prev_start === D(7) && d.window.prev_end === D(4),
    'DB3 the window block names both periods and the timezone', JSON.stringify(d.window));
  for (const [name, b] of Object.entries(d.breakdown_summary)) {
    ok(typeof b.basis === 'string' && typeof b.basis_label === 'string' && b.basis_label.length > 10,
      `DB4 breakdown '${name}' names its basis (${b.basis})`);
  }
  ok(d.movers.length <= 3, 'DB5 at most three movers', d.movers.length);
  ok(d.movers.every((m) => m.previous_net_sales !== null && m.previous_net_sales !== 0),
    'DB6 NO mover without a real baseline (never a fabricated 0% delta)');
  ok(Array.isArray(d.waterfall.steps) && d.waterfall.steps.length > 0, 'DB7 the waterfall draws its steps', d.waterfall.steps.length);
  ok(d.waterfall.steps.every((s) => s.pct_of_top !== undefined), 'DB8 …each with an honest share of the widest step');
  ok(typeof d.meta.computed_ms === 'number', 'DB9 dashboard carries computed_ms', d.meta.computed_ms);
  ok(d.kpis.previous && typeof d.kpis.previous === 'object', 'DB10 kpis carry their previous-window twin');
  console.log(`  → dashboard computed_ms = ${d.meta.computed_ms}ms, rows_scanned = ${d.meta.rows_scanned}`);
}

// ═══ P: PERFORMANCE — 90-day window over a 50K-session fixture ══════════════
console.log('\n--- seeding the 50K-session performance fixture ---');
{
  const seedT0 = Date.now();
  // 50,000 money-moved sessions spread over 90 Madrid days, plus 150,000
  // touches. Generated server-side so the harness measures the ENGINE, not the
  // driver's insert throughput.
  await q(
    `INSERT INTO co_sessions (id, funnel_id, page_id, status, line_items, total, currency,
                              customer, gateway, vid, refunds, paid_at, created_at)
     SELECT 'perf_' || g,
            'fperf',
            'p1',
            'paid',
            jsonb_build_array(jsonb_build_object('variant_id', $1::text, 'quantity', 1 + (g % 3),
                                                 'price', 25, 'title', 'P' || (g % 40),
                                                 'product_title', 'P' || (g % 40))),
            25 * (1 + (g % 3)),
            'USD',
            jsonb_build_object('email', 'buyer' || (g % 9000) || '@x.com',
                               'shipping', jsonb_build_object('country', (ARRAY['ES','US','FR','DE','IT'])[1 + (g % 5)])),
            (ARRAY['whop','stripe','paypal'])[1 + (g % 3)],
            'pv_' || (g % 30000),
            CASE WHEN g % 25 = 0
                 THEN jsonb_build_array(jsonb_build_object('id', 'r_' || g, 'amount', 5,
                        'at', to_char($2::timestamptz + ((g % 90) * interval '1 day'), 'YYYY-MM-DD"T"HH24:MI:SSOF')))
                 ELSE '[]'::jsonb END,
            $2::timestamptz + ((g % 90) * interval '1 day') + ((g % 1440) * interval '1 minute'),
            $2::timestamptz + ((g % 90) * interval '1 day')
     FROM generate_series(1, 50000) g`,
    [V1, zonedDayStart(D(89)).toISOString()]
  );
  await q(
    `INSERT INTO co_upsell_charges (id, session_id, offer_id, charge_id, amount, currency, status, line_items, created_at)
     SELECT 'pc_' || g, 'perf_' || g, 'off', 'ch', 20, 'USD', 'settled',
            jsonb_build_array(jsonb_build_object('variant_id', $1::text, 'quantity', 1)),
            $2::timestamptz + ((g % 90) * interval '1 day') + interval '5 minutes'
     FROM generate_series(1, 50000) g WHERE g % 4 = 0`,
    [V2, zonedDayStart(D(89)).toISOString()]
  );
  await q(
    `INSERT INTO lb_touches (vid, funnel_id, page_id, url, referrer, utm, ts, expires_at)
     SELECT 'pv_' || (g % 30000), 'fperf', 'p1', 'https://a.com/lp' || (g % 7),
            'https://src' || (g % 6) || '.com/x',
            jsonb_build_object('utm_source', (ARRAY['meta','google','tiktok','direct'])[1 + (g % 4)],
                               'utm_campaign', 'camp_' || (g % 25)),
            $1::timestamptz + ((g % 90) * interval '1 day') + ((g % 1440) * interval '1 minute'),
            NOW() + interval '90 days'
     FROM generate_series(1, 150000) g`,
    [zonedDayStart(D(89)).toISOString()]
  );
  await q(`INSERT INTO lb_ad_spend_daily (source, ref_id, day, spend)
           SELECT 'manual', 'fperf', to_char($1::timestamptz + (g * interval '1 day'), 'YYYY-MM-DD'), 100
           FROM generate_series(0, 89) g`, [zonedDayStart(D(89)).toISOString()]);
  // Fresh statistics — autovacuum does this in production, where these tables
  // are written one row at a time and never bulk-loaded. Without it the planner
  // estimates ~2,000 rows where there are 200,000 and picks a nested loop.
  await q(`ANALYZE`);
  const [{ n }] = await q(`SELECT COUNT(*)::int AS n FROM co_sessions WHERE funnel_id = 'fperf'`);
  const [{ t }] = await q(`SELECT COUNT(*)::int AS t FROM lb_touches WHERE funnel_id = 'fperf'`);
  console.log(`  seeded ${n} sessions + ${t} touches in ${((Date.now() - seedT0) / 1000).toFixed(1)}s`);
  ok(n === 50000, 'P0 the fixture really holds 50,000 sessions', n);

  const PERF_WINDOW = { start_day: D(89), end_day: D(0) };
  const PF = { funnel_id: 'fperf' };
  const mix = [
    ['timeseries money', { metrics: ['orders', 'gross_sales', 'net_sales', 'refunds', 'aov'], filters: PF, window: PERF_WINDOW }],
    ['timeseries + traffic', { metrics: ['orders', 'sessions', 'pageviews', 'conv_pct', 'rev_per_session'], filters: PF, window: PERF_WINDOW }],
    ['breakdown funnel', { metrics: ['orders', 'net_sales', 'aov'], dimension: 'funnel', filters: PF, window: PERF_WINDOW }],
    ['breakdown country', { metrics: ['orders', 'net_sales'], dimension: 'country', filters: PF, window: PERF_WINDOW }],
    ['breakdown gateway', { metrics: ['orders', 'net_sales'], dimension: 'gateway', filters: PF, window: PERF_WINDOW }],
    ['breakdown source', { metrics: ['orders', 'net_sales'], dimension: 'source', filters: PF, window: PERF_WINDOW }],
    ['breakdown product', { metrics: ['orders', 'gross_sales'], dimension: 'product', filters: PF, window: PERF_WINDOW }],
    ['customers', { metrics: ['orders', 'new_customers', 'returning_customers'], filters: PF, window: PERF_WINDOW }],
    ['compare', { metrics: ['orders', 'net_sales'], filters: PF, window: PERF_WINDOW, compare: true }],
    ['week granularity', { metrics: ['orders', 'net_sales', 'conv_pct'], filters: PF, window: PERF_WINDOW, granularity: 'week' }],
  ];

  const samples = [];
  const perQuery = [];
  for (const [name, body] of mix) {
    const runs = [];
    for (let i = 0; i < 3; i += 1) {
      const r = await run(body);
      runs.push(r.meta.computed_ms);
      samples.push(r.meta.computed_ms);
    }
    perQuery.push([name, runs]);
  }
  samples.sort((a, b) => a - b);
  const p = (x) => samples[Math.min(samples.length - 1, Math.ceil((x / 100) * samples.length) - 1)];
  console.log('\n  per-query computed_ms (3 runs each):');
  for (const [name, runs] of perQuery) console.log(`    ${name.padEnd(24)} ${runs.map((v) => `${v}ms`).join(' ')}`);
  console.log(`\n  n=${samples.length}  min=${samples[0]}ms  p50=${p(50)}ms  p95=${p(95)}ms  max=${samples[samples.length - 1]}ms`);
  ok(p(95) < 1500, `P1 p95 < 1500ms over a 90-day window on 50K sessions (p95 = ${p(95)}ms)`, `${p(95)}ms`);

  // The cost fold is measured SEPARATELY and reported, because it is the one
  // family that resolves per session in JS rather than folding in SQL — a
  // number worth knowing before someone puts it on a default dashboard.
  const costRuns = [];
  for (let i = 0; i < 3; i += 1) {
    const r = await run({ metrics: ['net_sales', 'cogs', 'fees', 'net_after_cogs', 'cost_coverage_pct'], filters: PF, window: PERF_WINDOW });
    costRuns.push(r.meta.computed_ms);
  }
  console.log(`  cost fold (per-session resolveCosts over 50K + 12.5K legs): ${costRuns.map((v) => `${v}ms`).join(' ')}`);
  ok(true, `P2 cost-fold timing recorded: ${costRuns.join('/')}ms (reported, see notes)`);

  const dashRuns = [];
  for (let i = 0; i < 3; i += 1) {
    const d = await runDashboard({ start: D(89), end: D(0), funnel_id: 'fperf' }, { query: q });
    dashRuns.push(d.meta.computed_ms);
  }
  console.log(`  dashboard composite: ${dashRuns.map((v) => `${v}ms`).join(' ')}`);
  ok(true, `P3 dashboard composite timing recorded: ${dashRuns.join('/')}ms`);
}

console.log(`\n${pass} passed, ${fail} failed`);
await sql.end();
const { closeAnalyticsPool } = await import('../../src/services/analyticsDb.js');
await closeAnalyticsPool().catch(() => {});
const pg = await import('../../src/db/pg.js');
await (pg.closePool?.() ?? pg.default?.closePool?.() ?? Promise.resolve()).catch?.(() => {});
process.exit(fail ? 1 : 0);
