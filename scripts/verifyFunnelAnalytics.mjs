// Verification harness for the funnel-analytics subsystem. Runs the REAL
// service code against the embedded Postgres and asserts every guarantee BY
// EXECUTION against a HAND-COMPUTED fixture.
//
//   DATABASE_URL=postgresql://puure@127.0.0.1:5433/puure_analytics \
//     node scripts/verifyFunnelAnalytics.mjs
//
// The DDL is the repo's own (ensureTrackingTables / ensureCheckoutTables /
// ensureSplitTables / funnels' ensureTables) — nothing is re-declared here, so
// a schema drift breaks this harness instead of hiding.
// ⚠️ MUST BE THE FIRST IMPORT. It pins DATABASE_URL as a module side effect,
// and module evaluation follows import order — every import below builds a DB
// handle at load time, so anything placed after them is too late. A plain
// top-level assignment does NOT work here: ESM hoists imports above it.
import { HARNESS_DB_URL } from './analyticsHarnessEnv.mjs';
import postgres from 'postgres';
import { ensureTrackingTables } from '../server/src/services/trackingSchema.js';
import { ensureCheckoutTables } from '../server/src/services/checkoutSchema.js';
import { ensureSplitTables } from '../server/src/services/splitTestSchema.js';
import { ensureTables as ensureFunnelTables } from '../server/src/routes/funnels.js';
import { readResults } from '../server/src/services/splitCredits.js';
import {
  getFunnelOverview,
  getPageMetrics,
  getSplitResults,
  parseWindow,
  derivePageMetrics,
} from '../server/src/services/funnelAnalytics.js';
import {
  compareConversion,
  compareRevenuePerVisitor,
  requiredSampleForProportions,
  requiredSampleForMeans,
  buildVerdict,
  varianceFromSums,
} from '../server/src/services/analyticsStats.js';

const DB = HARNESS_DB_URL;
const sql = postgres(DB, { max: 10, idle_timeout: 5 });
const query = (text, params = []) => sql.unsafe(text, params);

let passed = 0;
let failed = 0;
const failures = [];
function assert(cond, msg) {
  if (cond) {
    passed += 1;
    console.log(`  PASS  ${msg}`);
  } else {
    failed += 1;
    failures.push(msg);
    console.log(`  FAIL  ${msg}`);
  }
}
const eq = (actual, expected, msg) =>
  assert(actual === expected, `${msg} (expected ${expected}, got ${actual})`);
const near = (actual, expected, tol, msg) =>
  assert(
    Number.isFinite(actual) && Math.abs(actual - expected) <= tol,
    `${msg} (expected ~${expected}±${tol}, got ${actual})`
  );
const hr = (t) => console.log(`\n=== ${t} ===`);

// Every number a response can carry must be a real number. This walks the WHOLE
// response and fails on any NaN or Infinity, so a division-by-zero anywhere is
// caught even in a field no assertion names.
function assertNoNonFinite(obj, label, path = '') {
  let bad = [];
  const walk = (v, p) => {
    if (typeof v === 'number') {
      if (!Number.isFinite(v)) bad.push(`${p} = ${v}`);
    } else if (Array.isArray(v)) v.forEach((x, i) => walk(x, `${p}[${i}]`));
    else if (v && typeof v === 'object' && !(v instanceof Date)) {
      for (const [k, x] of Object.entries(v)) walk(x, p ? `${p}.${k}` : k);
    }
  };
  walk(obj, path);
  assert(bad.length === 0, `${label}: no NaN/Infinity anywhere${bad.length ? ` — found ${bad.join(', ')}` : ''}`);
}

// ── Fixture ids + window ───────────────────────────────────────────────────
const F1 = 'fnl_main';
const F_EMPTY = 'fnl_empty';
const F_ONE = 'fnl_one';
const F2 = 'fnl_split';
const P_LANDER = 'pg_lander';
const P_CHECKOUT = 'pg_checkout';
const P_UPSELL = 'pg_upsell';
const WIN = { from: '2026-07-01', to: '2026-07-31' };
const inWin = (day, hour = 12) => new Date(Date.UTC(2026, 6, day, hour, 0, 0));
const OUT_BEFORE = new Date(Date.UTC(2026, 5, 15, 12, 0, 0)); // 2026-06-15
const OUT_AFTER = new Date(Date.UTC(2026, 7, 15, 12, 0, 0)); //  2026-08-15

async function reset() {
  for (const t of [
    'lb_split_pending_credits', 'lb_split_credits', 'lb_split_arms', 'lb_split_tests',
    'co_upsell_charges', 'co_orders', 'co_events', 'co_sessions',
    'lb_touches', 'lb_clicks', 'lb_visitor_firstseen',
    'funnel_pages', 'funnel_redirects', 'funnels',
  ]) {
    await query(`DROP TABLE IF EXISTS ${t} CASCADE`);
  }
  await ensureFunnelTables();
  await ensureTrackingTables();
  await ensureCheckoutTables();
  await ensureSplitTables(query);
}

const TTL = new Date(Date.UTC(2027, 0, 1));

async function touch(funnelId, pageId, vid, at) {
  await query(
    `INSERT INTO lb_touches (vid, funnel_id, page_id, url, referrer, utm, click_ids, ts, expires_at)
     VALUES ($1,$2,$3,'https://x/','',$4,$5,$6,$7)`,
    [vid, funnelId, pageId, {}, {}, at, TTL]
  );
}

async function session({ id, funnelId, pageId, vid, status, total, paidAt, createdAt, refunds = [] }) {
  await query(
    `INSERT INTO co_sessions (id, funnel_id, page_id, status, line_items, subtotal, shipping, tax,
                              total, currency, customer, refunds, vid, paid_at, created_at, updated_at)
     VALUES ($1,$2,$3,$4,$5,0,0,0,$6,'USD',$7,$8,$9,$10,$11,$11)`,
    [id, funnelId, pageId, status, [], total, {}, refunds, vid, paidAt, createdAt]
  );
}

async function upsell({ id, sessionId, offerId, chargeId, amount, status }) {
  await query(
    `INSERT INTO co_upsell_charges (id, session_id, offer_id, charge_id, amount, currency, status, line_items)
     VALUES ($1,$2,$3,$4,$5,'USD',$6,$7)`,
    [id, sessionId, offerId, chargeId, amount, status, []]
  );
}

// A refund's TRUE amount as gatewayWebhooks records it: a negative 'void' row
// in the credits ledger keyed by the co_upsell_charges row id. This is the only
// place a PARTIAL upsell refund amount survives (there is no refunded_total
// column). `group` mirrors the test the session was exposed to.
async function voidRow({ sessionId, chargeId, amount, refundKey, group, arm = 'a', at = inWin(24) }) {
  await query(
    `INSERT INTO lb_split_credits (entry_id, kind, session_id, group_id, arm_key, charge_id,
                                   value, credited, currency, day, refund_key, created_at)
     VALUES ($1,'void',$2,$3,$4,$5,$6,TRUE,'USD',$7,$8,$9)
     ON CONFLICT (entry_id) DO NOTHING`,
    [
      `void:${sessionId}|${group}|u:${chargeId}|${refundKey}`,
      sessionId, group, arm, chargeId, -Math.abs(amount),
      at.toISOString().slice(0, 10), refundKey, at,
    ]
  );
}

async function seedFunnels() {
  for (const [id, slug, name] of [
    [F1, 'main', 'Main Funnel'], [F_EMPTY, 'empty', 'Empty Funnel'],
    [F_ONE, 'one', 'One Visitor'], [F2, 'split', 'Split Funnel'],
  ]) {
    await query(
      `INSERT INTO funnels (id, slug, name, status, created_at, updated_at)
       VALUES ($1,$2,$3,'live',$4,$4)`,
      [id, slug, name, OUT_BEFORE]
    );
  }
  for (const [id, fid, slug, title, type, home] of [
    [P_LANDER, F1, 'lander', 'Lander', 'landing', true],
    [P_CHECKOUT, F1, 'checkout', 'Checkout', 'checkout', false],
    [P_UPSELL, F1, 'upsell', 'Upsell 1', 'upsell', false],
  ]) {
    await query(
      `INSERT INTO funnel_pages (id, funnel_id, slug, type, title, status, is_home, blocks)
       VALUES ($1,$2,$3,$4,$5,'live',$6,$7)`,
      [id, fid, slug, type, title, home, []]
    );
  }
}

// ═══════════════════════════════════════════════════════════════════════════
// THE HAND-COMPUTED FIXTURE — every expected number below is derived on paper
// in the comments, then asserted EXACTLY (not as a range).
// ═══════════════════════════════════════════════════════════════════════════
//
// TRAFFIC (lb_touches), all inside 2026-07-01 .. 2026-07-31:
//   v1..v50  touch P_LANDER   (v1 twice)  → lander visitors 50, pageviews 51
//   v1..v40  later touch P_CHECKOUT       → checkout visitors 40, pageviews 40
//   v1..v5   later touch P_UPSELL         → upsell visitors 5,  pageviews 5
//   ONE out-of-window touch (v99 on lander, 2026-06-15) — must be EXCLUDED.
//   funnel visitors = 50 DISTINCT (NOT 50+40+5 = 95)
//   funnel pageviews = 51 + 40 + 5 = 96
//   lander advanced   = 40 (v1..v40 later hit a different page)
//   checkout advanced = 5  (v1..v5 later hit upsell)
//   upsell advanced   = 0
//
// MONEY (co_sessions), page_id = P_CHECKOUT:
//   s1..s6  status 'paid'      total 100  paid_at in window   → 6 orders, 600
//   s7      status 'refunded'  total 100  paid_at in window   → +1 order, +100
//             refunds [{amount:100, at: in window}]           → refunded 100
//   s8      status 'paid'      total 100  paid_at in window   → +1 order, +100
//             refunds [{amount: 30, at: in window}]           → refunded +30
//   sp1..sp3 status 'processing' total 250 created_at in window
//             → THE #1 BUG: must contribute 0 revenue, 0 orders ($750 excluded)
//   s9      status 'paid'      total 500  paid_at OUT of window → excluded
//   ⇒ orders = 8, base_revenue = 800, refunded = 130
//
// UPSELLS (co_upsell_charges):
//   s1: settled 40 + settled 25          → 2 legs, 1 buyer, 65
//   s2: settled 40                       → +1 leg, +1 buyer, +40
//   s3: declined 0                       → declined leg, NO money
//   sp1 (processing): settled 999        → MUST BE EXCLUDED
//   ⇒ upsell_legs = 3, upsell_buyers = 2, upsell_revenue = 105, declined = 1
//
// DERIVED (P_CHECKOUT):
//   gross = 800 + 105 = 905 ; refunded = 130 ; net = 775
//   visitors_raw 40, submits 11 (s1..s8 + sp1..sp3 created in window), orders 8
//     ⇒ clamp max(40,11,8) = 40, NOT clamped
//   cvr = 8/40 = 0.2 EXACTLY
//   step_through = 5/40 = 0.125 ; submit_rate = 11/40 = 0.275
//     ⇒ ctr = 0.275, basis 'checkout_submit_proxy' (submit proxy wins)
//   aov_post = 775/8 = 96.875 → 96.88 ; aov_pre = 96.875 − 105/8 = 83.75
//   rev/visitor = 775/40 = 19.375
//
// DERIVED (P_LANDER):
//   visitors 50, advanced 40, submits 0, orders 0
//   ctr = 40/50 = 0.8 EXACTLY, basis 'step_through_proxy'
//   cvr = 0, revenue 0
//
// DERIVED (P_UPSELL): visitors 5 → BELOW the 30 rate floor ⇒ ctr null
async function seedMain() {
  for (let i = 1; i <= 50; i += 1) await touch(F1, P_LANDER, `v${i}`, inWin(5, 1));
  await touch(F1, P_LANDER, 'v1', inWin(5, 2)); // second pageview, same visitor
  await touch(F1, P_LANDER, 'v99', OUT_BEFORE); // out of window — must vanish
  for (let i = 1; i <= 40; i += 1) await touch(F1, P_CHECKOUT, `v${i}`, inWin(5, 3));
  for (let i = 1; i <= 5; i += 1) await touch(F1, P_UPSELL, `v${i}`, inWin(5, 4));

  for (let i = 1; i <= 6; i += 1) {
    await session({
      id: `s${i}`, funnelId: F1, pageId: P_CHECKOUT, vid: `v${i}`, status: 'paid',
      total: 100, paidAt: inWin(10), createdAt: inWin(10),
    });
  }
  await session({
    id: 's7', funnelId: F1, pageId: P_CHECKOUT, vid: 'v7', status: 'refunded', total: 100,
    paidAt: inWin(11), createdAt: inWin(11),
    refunds: [{ id: 'rf1', amount: 100, gateway: 'stripe', dispute: false, at: inWin(20).toISOString() }],
  });
  await session({
    id: 's8', funnelId: F1, pageId: P_CHECKOUT, vid: 'v8', status: 'paid', total: 100,
    paidAt: inWin(11), createdAt: inWin(11),
    refunds: [{ id: 'rf2', amount: 30, gateway: 'stripe', dispute: false, at: inWin(21).toISOString() }],
  });
  for (let i = 1; i <= 3; i += 1) {
    await session({
      id: `sp${i}`, funnelId: F1, pageId: P_CHECKOUT, vid: `v${40 + i}`, status: 'processing',
      total: 250, paidAt: null, createdAt: inWin(12),
    });
  }
  await session({
    id: 's9', funnelId: F1, pageId: P_CHECKOUT, vid: 'v50', status: 'paid', total: 500,
    paidAt: OUT_AFTER, createdAt: OUT_AFTER,
  });

  await upsell({ id: 'u1', sessionId: 's1', offerId: 'o1', chargeId: 'v:1', amount: 40, status: 'settled' });
  await upsell({ id: 'u2', sessionId: 's1', offerId: 'o2', chargeId: 'v:2', amount: 25, status: 'settled' });
  await upsell({ id: 'u3', sessionId: 's2', offerId: 'o1', chargeId: 'v:1', amount: 40, status: 'settled' });
  await upsell({ id: 'u4', sessionId: 's3', offerId: 'o1', chargeId: 'decline', amount: 0, status: 'declined' });
  await upsell({ id: 'u5', sessionId: 'sp1', offerId: 'o1', chargeId: 'v:1', amount: 999, status: 'settled' });

  // ── THE PARTIAL-UPSELL-REFUND FIXTURE (both gateways) ───────────────────
  // s4: STRIPE path. A $200 upsell leg, $5 partially refunded. main flips the
  // WHOLE leg to 'refunded' and appends NOTHING to co_sessions.refunds. The
  // true amount survives only in the void row.
  //   truth: gross +200, refunded +5, net +195
  //   the old `status='settled'` filter reported: gross +0, refunded +0
  await upsell({ id: 'u6', sessionId: 's4', offerId: 'o3', chargeId: 'v:3', amount: 200, status: 'refunded' });
  await voidRow({ sessionId: 's4', chargeId: 'u6', amount: 5, refundKey: 're_stripe_partial', group: T_MAIN });

  // s5: WHOP path. A $120 upsell leg, $20 refunded. main flips the leg AND
  // appends to co_sessions.refunds (applyRefund runs unconditionally), so the
  // same $20 is in TWO places and must be counted ONCE.
  //   truth: gross +120, refunded +20, net +100
  await upsell({ id: 'u7', sessionId: 's5', offerId: 'o4', chargeId: 'v:4', amount: 120, status: 'refunded' });
  await voidRow({ sessionId: 's5', chargeId: 'u7', amount: 20, refundKey: 'whop_rf_1', group: T_MAIN });
  await query(`UPDATE co_sessions SET refunds = $1::jsonb WHERE id = 's5'`, [
    [{ id: 'whop_rf_1', amount: 20, gateway: 'whop', dispute: false, at: inWin(23).toISOString() }],
  ]);

  // s6: the UNMEASURABLE case. A $60 leg flipped to 'refunded' with NO void row
  // — a funnel with no split test, on the Stripe path. The amount exists
  // nowhere in the database. It must be counted at GROSS, flagged, and the
  // report must say net revenue is an upper bound. It must NOT be guessed at.
  await upsell({ id: 'u8', sessionId: 's6', offerId: 'o5', chargeId: 'v:5', amount: 60, status: 'refunded' });

  // One-visitor funnel: a single touch, no money at all.
  await touch(F_ONE, 'pg_solo', 'vOne', inWin(6));
}

// ── Split fixture (funnel F2, test T1, arms a=control / b) ────────────────
//   arm a: 400 exposures; 30 money-moved @ $100; 2 of them carry a $50 settled
//          upsell; 1 of them refunded $30.
//          gross = 3000 + 100 = 3100 ; refunded = 30 ; net = 3070
//          Σx  = 27·100 + 2·150 + 1·70 = 2700 + 300 + 70 = 3070
//          Σx² = 27·10000 + 2·22500 + 4900 = 270000 + 45000 + 4900 = 319900
//   arm b: 400 exposures; 80 money-moved @ $100; no upsells, no refunds.
//          gross = net = 8000 ; Σx = 8000 ; Σx² = 80·10000 = 800000
//   Both arms clear the floors (400 ≥ 300 visitors, 30 & 80 ≥ 25 orders).
const T1 = 'lbsg_t1';
const T2 = 'lbsg_t2';
const T3 = 'lbsg_t3';
const T_MAIN = 'lbsg_main';
async function seedSplit() {
  await query(
    `INSERT INTO lb_split_tests (id, funnel_id, name, scope, enabled, archived, created_at, updated_at)
     VALUES ($1,$2,'Headline test','page',TRUE,FALSE,$3,$3)`,
    [T1, F2, OUT_BEFORE]
  );
  for (const [key, ctrl] of [['a', true], ['b', false]]) {
    await query(
      `INSERT INTO lb_split_arms (id, test_id, arm_key, weight, is_control, archived)
       VALUES ($1,$2,$3,50,$4,FALSE)`,
      [`arm_${key}`, T1, key, ctrl]
    );
  }
  // Tracking for F2 starts INSIDE the window, i.e. AFTER T1 was created →
  // the disclosure flag must fire.
  await touch(F2, 'pg_a', 'vsplit', inWin(2));

  const mk = async (arm, n, paidCount) => {
    for (let i = 0; i < n; i += 1) {
      const sid = `${arm}_s${i}`;
      const paid = i < paidCount;
      const refunds =
        arm === 'a' && i === 0
          ? [{ id: `rf_${arm}_${i}`, amount: 30, gateway: 'stripe', dispute: false, at: inWin(22).toISOString() }]
          : [];
      await session({
        id: sid, funnelId: F2, pageId: 'pg_a', vid: `vs_${arm}_${i}`,
        status: paid ? 'paid' : 'processing', total: 100,
        paidAt: paid ? inWin(10) : null, createdAt: inWin(9), refunds,
      });
      if (arm === 'a' && paid && (i === 1 || i === 2)) {
        await upsell({ id: `up_${arm}_${i}`, sessionId: sid, offerId: 'o1', chargeId: 'v:1', amount: 50, status: 'settled' });
      }
      await query(
        `INSERT INTO lb_split_credits (entry_id, kind, session_id, group_id, arm_key, charge_id,
                                       value, credited, currency, day, created_at)
         VALUES ($1,'exposure',$2,$3,$4,'__exposure__',0,FALSE,'USD',$5,$6)`,
        [`exp:${sid}|${T1}`, sid, T1, arm, '2026-07-09', inWin(9)]
      );
      if (paid) {
        await query(
          `INSERT INTO lb_split_credits (entry_id, kind, session_id, group_id, arm_key, charge_id,
                                         value, credited, currency, day, created_at)
           VALUES ($1,'credit',$2,$3,$4,$5,$6,TRUE,'USD',$7,$8)`,
          [`cr:${sid}|${T1}|u:base`, sid, T1, arm, 'base', 100, '2026-07-10', inWin(10)]
        );
      }
    }
  };
  await mk('a', 400, 30);
  await mk('b', 400, 80);

  // ── T3: a THREE-arm test (comparisons = 2 ⇒ Bonferroni actually bites) ────
  // a = control (400 exp, 40 paid), b = strong winner (400, 90), c = LOSER
  // (400, 20). The bug this catches: one scalar confidence painted under every
  // non-control arm makes losing arm c display winning arm b's confidence.
  await query(
    `INSERT INTO lb_split_tests (id, funnel_id, name, scope, enabled, archived, created_at, updated_at)
     VALUES ($1,$2,'Three arm','page',TRUE,FALSE,$3,$3)`,
    [T3, F2, OUT_BEFORE]
  );
  for (const [key, ctrl] of [['a', true], ['b', false], ['c', false]]) {
    await query(
      `INSERT INTO lb_split_arms (id, test_id, arm_key, weight, is_control, archived)
       VALUES ($1,$2,$3,33,$4,FALSE)`,
      [`arm3_${key}`, T3, key, ctrl]
    );
  }
  const mk3 = async (arm, n, paidCount) => {
    for (let i = 0; i < n; i += 1) {
      const sid = `t3_${arm}_s${i}`;
      const paid = i < paidCount;
      await session({
        id: sid, funnelId: F2, pageId: 'pg_a', vid: `vt3_${arm}_${i}`,
        status: paid ? 'paid' : 'processing', total: 100,
        paidAt: paid ? inWin(10) : null, createdAt: inWin(9),
      });
      await query(
        `INSERT INTO lb_split_credits (entry_id, kind, session_id, group_id, arm_key, charge_id,
                                       value, credited, currency, day, created_at)
         VALUES ($1,'exposure',$2,$3,$4,'__exposure__',0,FALSE,'USD',$5,$6)`,
        [`exp:${sid}|${T3}`, sid, T3, arm, '2026-07-09', inWin(9)]
      );
    }
  };
  await mk3('a', 400, 40);
  await mk3('b', 400, 90);
  await mk3('c', 400, 20);

  // T2 — created AFTER the funnel's first touch → disclosure flag must be false.
  await query(
    `INSERT INTO lb_split_tests (id, funnel_id, name, scope, enabled, archived, created_at, updated_at)
     VALUES ($1,$2,'Late test','page',TRUE,FALSE,$3,$3)`,
    [T2, F2, OUT_AFTER]
  );
}

async function main() {
  console.log(`DB: ${DB.replace(/\/\/.*@/, '//***@')}`);
  await reset();
  await seedFunnels();
  await seedMain();
  await seedSplit();
  console.log('Fixture seeded.\n');

  const deps = { query };

  // ═══════════════════════════════════════════════════════════════════════
  hr('1. processing ≠ paid — the #1 analytics bug');
  const ov = await getFunnelOverview({ funnelId: F1, ...WIN }, deps);
  assert(!ov.error, `overview returned without error (${ov.error ?? 'ok'})`);
  const co = ov.pages.find((p) => p.page_id === P_CHECKOUT);
  eq(ov.totals.orders, 8, 'orders exclude the 3 processing sessions');
  eq(co.base_revenue, 800, 'base revenue excludes $750 of processing sessions');
  eq(ov.totals.processing_sessions, 3, 'processing sessions are reported separately');
  eq(ov.totals.processing_amount_excluded, 750, 'the excluded processing amount is disclosed');
  // If processing leaked in it would add $750 of base + the $999 upsell leg,
  // i.e. 1285 → 3034. The exact equality is the assertion; the inequality names
  // the number a leak would produce.
  eq(ov.totals.gross_revenue, 1285, 'gross revenue is 1285');
  assert(
    ov.totals.gross_revenue < 1285 + 750 + 999,
    `gross is NOT 3034 — processing base+upsell stayed out (got ${ov.totals.gross_revenue})`
  );
  eq(co.upsell_revenue, 485, "upsell gross excludes the processing session's $999 leg");
  assert(
    co.upsell_revenue < 999,
    `the $999 processing leg is absent (upsell gross ${co.upsell_revenue} < 999)`
  );
  eq(co.orders, 8, 'the out-of-window $500 paid session is excluded');

  hr('2. fully-refunded sessions stay counted; refunds net; no negatives');
  eq(co.base_refunded, 130, 'base refunded = 100 (full) + 30 (partial); the Whop $20 is NOT double-counted here');
  eq(co.upsell_refunded, 25, 'upsell refunded = $5 (Stripe partial) + $20 (Whop) from the void ledger');
  eq(co.refunded, 155, 'total refunded = 130 base + 25 upsell');
  eq(co.gross_revenue, 1285, 'gross = 800 base + 485 upsell (refunded LEGS included at gross)');
  eq(co.net_revenue, 1130, 'net = gross − refunded = 1285 − 155');
  eq(co.net_revenue, co.gross_revenue - co.refunded, 'net === gross − refunded identity');
  assert(
    ov.pages.every((p) => p.visitors === null || p.visitors >= 0),
    'no negative visitor count on any page'
  );
  assertNoNonFinite(ov, 'main funnel overview');

  hr('3. upsell legs vs buyers; AOV post > pre');
  eq(co.upsell_legs, 6, 'upsell legs = 6 (3 settled + 3 refunded); a refunded leg WAS sold');
  eq(co.upsell_buyers, 5, 'upsell buyers = 5 distinct sessions');
  assert(co.upsell_legs >= co.upsell_buyers, `legs (${co.upsell_legs}) >= buyers (${co.upsell_buyers})`);
  eq(co.upsell_refunded_legs, 3, 'reversed legs counted separately');
  eq(co.upsell_declined_legs, 1, 'the declined leg is counted separately, not as revenue');
  eq(co.upsell_revenue, 485, 'upsell gross = 40+25+40+200+120+60 (processing $999 still excluded)');
  eq(co.aov_pre_upsell, 80.63, 'AOV pre-upsell = 1130/8 − 485/8');
  eq(co.aov_post_upsell, 141.25, 'AOV post-upsell = 1130/8');
  assert(
    co.aov_post_upsell > co.aov_pre_upsell,
    `AOV post (${co.aov_post_upsell}) > pre (${co.aov_pre_upsell}) when upsells exist`
  );

  hr('3b. F1 — a PARTIAL upsell refund must not delete the whole leg');
  // The regression this exists to catch: filtering `status='settled'` made a
  // $200 leg vanish over a $5 refund, and on Stripe `refunded` stayed 0, so the
  // report lost $195 silently and a closed month restated.
  const [legs] = await query(
    `SELECT COALESCE(SUM(c.amount),0) AS gross
     FROM co_upsell_charges c JOIN co_sessions s ON s.id=c.session_id
     WHERE s.funnel_id=$1 AND c.status='refunded'`, [F1]
  );
  eq(Number(legs.gross), 380, 'the three reversed legs carry $380 of gross in the DB (200+120+60)');
  assert(
    co.upsell_revenue >= 380,
    `all $380 of reversed-leg gross survives into the report (got ${co.upsell_revenue})`
  );
  eq(co.upsell_refunded, 25, 'and only the $25 actually refunded is subtracted — not $380');

  hr('3c. F2 — a Whop upsell refund is counted ONCE, not twice');
  // Whop writes the SAME refund to co_sessions.refunds AND to a void row.
  // Stripe writes only the void row. Both must net to the same total.
  eq(co.base_refunded, 130, 'the Whop $20 is excluded from the base refunds[] sum');
  eq(co.upsell_refunded, 25, 'and counted once, in the upsell column');
  eq(co.refunded, 155, 'so the $20 moves net by exactly −20, not −40');

  hr('3d. an unmeasurable upsell refund is FLAGGED, never guessed');
  eq(ov.meta.upsell_refunds_unmeasured, 1, 's6 has a reversed leg with no void row');
  eq(ov.meta.net_revenue_is_upper_bound, true, 'so net revenue is disclosed as an UPPER BOUND');
  assert(
    co.upsell_revenue >= 60,
    'the unmeasurable leg is still counted at gross rather than dropped'
  );

  hr('4. per-page overlay numbers match the hand-computed fixture EXACTLY');
  const la = ov.pages.find((p) => p.page_id === P_LANDER);
  const up = ov.pages.find((p) => p.page_id === P_UPSELL);
  eq(la.visitors, 50, 'lander visitors = 50 distinct vids');
  eq(la.pageviews, 51, 'lander pageviews = 51 (v1 visited twice)');
  eq(la.advanced_visitors, 40, 'lander advanced = 40 visitors reached another page');
  eq(la.ctr, 0.8, 'lander CTR proxy = 40/50 EXACTLY');
  eq(la.ctr_basis, 'step_through_proxy', 'lander CTR basis = step-through');
  eq(la.cvr, 0, 'lander CVR = 0 (no session is minted on the lander)');
  eq(co.visitors, 40, 'checkout visitors = 40');
  eq(co.visitors_clamped, false, 'checkout denominator was not clamped (40 > 11 submits)');
  eq(co.submits, 11, 'checkout submits = 8 paid + 3 processing sessions minted in window');
  eq(co.cvr, 0.2, 'checkout CVR = 8/40 EXACTLY');
  eq(co.step_through_rate, 0.125, 'checkout step-through = 5/40 EXACTLY');
  eq(co.submit_rate, 0.275, 'checkout submit rate = 11/40 EXACTLY');
  eq(co.ctr, 0.275, 'checkout CTR proxy = the LARGER of the two proxies');
  eq(co.ctr_basis, 'checkout_submit_proxy', 'checkout CTR basis = submit proxy');
  eq(co.rev_per_visitor, 28.25, 'checkout rev/visitor = 1130/40 EXACTLY');
  eq(up.visitors, 5, 'upsell page visitors = 5');
  eq(up.ctr, null, 'CTR withheld below the 30-visitor floor');
  eq(up.ctr_basis, 'sample_below_floor', 'and the reason is named');
  assert(ov.pages.every((p) => p.ctr_is_proxy === true), 'every CTR is labelled a proxy');

  hr('4b. funnel visitors is a DISTINCT count, not a sum of pages');
  const pageSum = ov.pages.reduce((t, p) => t + (p.visitors || 0), 0);
  eq(pageSum, 95, 'the sum of per-page visitors is 95');
  eq(ov.totals.visitors, 50, 'funnel visitors is 50 DISTINCT — NOT the 95 sum');
  eq(ov.totals.pageviews, 96, 'funnel pageviews = 51 + 40 + 5');
  eq(ov.totals.rev_per_visitor, 22.6, 'funnel rev/visitor = 1130/50 EXACTLY');
  eq(ov.totals.cvr, 0.16, 'funnel CVR = 8/50 EXACTLY');

  hr('5. empty funnel and 1-visitor funnel — no divide-by-zero');
  const empty = await getFunnelOverview({ funnelId: F_EMPTY, ...WIN }, deps);
  eq(empty.totals.visitors, 0, 'empty funnel visitors = 0');
  eq(empty.totals.orders, 0, 'empty funnel orders = 0');
  eq(empty.totals.cvr, null, 'empty funnel CVR is null, not NaN and not 0');
  eq(empty.totals.aov_post_upsell, null, 'empty funnel AOV is null');
  eq(empty.totals.rev_per_visitor, null, 'empty funnel rev/visitor is null');
  eq(empty.pages.length, 0, 'empty funnel has no page rows');
  assertNoNonFinite(empty, 'empty funnel overview');

  const one = await getFunnelOverview({ funnelId: F_ONE, ...WIN }, deps);
  eq(one.totals.visitors, 1, '1-visitor funnel visitors = 1');
  const solo = one.pages.find((p) => p.page_id === 'pg_solo');
  eq(solo.visitors, 1, 'the single page has 1 visitor');
  eq(solo.cvr, 0, '1-visitor CVR = 0/1 = 0 (a real zero, not a null)');
  eq(solo.ctr, null, 'CTR withheld at n=1');
  eq(solo.aov_post_upsell, null, 'AOV null at 0 orders');
  eq(solo.aov_reason, 'no_orders', 'and the reason is named');
  eq(solo.rev_per_visitor, 0, 'rev/visitor = 0/1 = 0');
  assertNoNonFinite(one, '1-visitor funnel overview');

  hr('5b. the clamp — a rate can never exceed 100%');
  const clampRow = derivePageMetrics({
    page: { page_id: 'x' },
    traffic: { visitors: 2, pageviews: 2, advanced_visitors: 2 },
    moneyRow: { orders: 9, submits: 9, submit_visitors: 9, base_revenue: 900 },
  });
  eq(clampRow.visitors, 9, 'denominator floored at the order count (9 orders, 2 touches)');
  eq(clampRow.visitors_clamped, true, 'and the clamp is flagged');
  eq(clampRow.cvr, 1, 'clamped CVR = 9/9 = 1.0, never > 1');
  eq(clampRow.rate_conflict.visitors_raw, 2, 'the unclamped raw count is published');
  eq(clampRow.rate_conflict.cvr_true, 4.5, 'and so is the unclamped 450% truth');

  hr('6. per-page endpoint = the same math, one code path');
  const pm = await getPageMetrics({ funnelId: F1, pageId: P_CHECKOUT, ...WIN }, deps);
  eq(pm.page.net_revenue, co.net_revenue, 'page endpoint net matches the overview row');
  eq(pm.page.cvr, co.cvr, 'page endpoint CVR matches the overview row');
  const missing = await getPageMetrics({ funnelId: F1, pageId: 'nope', ...WIN }, deps);
  eq(missing.error, 'page_not_found', 'unknown page → page_not_found');

  // ═══════════════════════════════════════════════════════════════════════
  hr('7. statistical helper — degenerate inputs');
  const ident = compareConversion({ visitors: 1000, conversions: 100 }, { visitors: 1000, conversions: 100 });
  eq(ident.confidence, 0.5, 'identical arms → confidence exactly 0.5');
  eq(ident.significant, false, 'identical arms → not significant');
  eq(ident.requiredSamplePerArm, null, 'identical arms → required N is null, not Infinity');
  eq(ident.reason, 'no_observed_difference', 'and the reason is named');

  const winner = compareConversion({ visitors: 1000, conversions: 100 }, { visitors: 1000, conversions: 200 });
  assert(winner.confidence > 0.95, `clear winner → confidence > 95% (got ${(winner.confidence * 100).toFixed(2)}%)`);
  eq(winner.significant, true, 'clear winner → significant');
  assert(Number.isFinite(winner.requiredSamplePerArm), `required N finite (${winner.requiredSamplePerArm})`);

  const zero = compareConversion({ visitors: 0, conversions: 0 }, { visitors: 0, conversions: 0 });
  eq(zero.confidence, 0.5, 'n=0 → confidence 0.5');
  eq(zero.reason, 'insufficient_sample', 'n=0 → insufficient_sample');
  assertNoNonFinite(zero, 'n=0 conversion comparison');
  const one1 = compareConversion({ visitors: 1, conversions: 0 }, { visitors: 1, conversions: 1 });
  assertNoNonFinite(one1, 'n=1 conversion comparison');

  const zeroVar = compareRevenuePerVisitor(
    { visitors: 100, revenueSum: 0, revenueSumSquares: 0 },
    { visitors: 100, revenueSum: 0, revenueSumSquares: 0 }
  );
  eq(zeroVar.confidence, 0.5, 'zero variance + identical → confidence 0.5');
  eq(zeroVar.reason, 'zero_variance_identical', 'and the reason is named');
  assertNoNonFinite(zeroVar, 'zero-variance revenue comparison');
  const rpvZeroN = compareRevenuePerVisitor(
    { visitors: 0, revenueSum: 0, revenueSumSquares: 0 },
    { visitors: 1, revenueSum: 5, revenueSumSquares: 25 }
  );
  assertNoNonFinite(rpvZeroN, 'n=0/n=1 revenue comparison');
  eq(rpvZeroN.reason, 'insufficient_sample', 'n<2 → insufficient_sample');
  eq(varianceFromSums(1, 5, 25), 0, 'variance at n=1 is 0, not NaN');
  eq(varianceFromSums(0, 0, 0), 0, 'variance at n=0 is 0, not NaN');

  hr('7b. required sample is sane and MONOTONIC (smaller gap ⇒ larger N)');
  const nBig = requiredSampleForProportions(0.1, 0.2);
  const nMid = requiredSampleForProportions(0.1, 0.12);
  const nSmall = requiredSampleForProportions(0.1, 0.101);
  console.log(`  N per arm: gap 10pp → ${nBig} | gap 2pp → ${nMid} | gap 0.1pp → ${nSmall}`);
  assert(nBig < nMid && nMid < nSmall, 'required N grows strictly as the gap shrinks');
  // Textbook check: detecting 10% vs 12% at α=.05/power .80 is ~3,800/arm.
  near(nMid, 3841, 250, 'required N for 10%→12% matches the textbook value');
  eq(requiredSampleForProportions(0.1, 0.1), null, 'zero gap → null, never Infinity');
  eq(requiredSampleForMeans(1, 1, 0), null, 'zero mean gap → null');
  eq(requiredSampleForMeans(0, 0, 5), null, 'zero variance → null (nothing to size against)');
  const mBig = requiredSampleForMeans(100, 100, 2);
  const mSmall = requiredSampleForMeans(100, 100, 0.5);
  assert(mBig < mSmall, `mean-gap N monotonic too (${mBig} < ${mSmall})`);

  hr('7c. verdict on a verifiable synthetic pair');
  const vIdent = buildVerdict([
    { arm_key: 'a', is_control: true, visitors: 500, orders: 50, net_revenue: 5000, net_revenue_sum_squares: 500000 },
    { arm_key: 'b', is_control: false, visitors: 500, orders: 50, net_revenue: 5000, net_revenue_sum_squares: 500000 },
  ]);
  eq(vIdent.status, 'no_winner', 'identical arms → no_winner');
  eq(vIdent.revenue.confidence, 0.5, 'identical arms → 50% confidence');
  assert(vIdent.headline.includes('too close'), `headline says too close: "${vIdent.headline}"`);
  const vThin = buildVerdict([
    { arm_key: 'a', is_control: true, visitors: 10, orders: 1, net_revenue: 100, net_revenue_sum_squares: 10000 },
    { arm_key: 'b', is_control: false, visitors: 10, orders: 5, net_revenue: 500, net_revenue_sum_squares: 50000 },
  ]);
  eq(vThin.status, 'not_ready', 'thin sample → not_ready, never a winner');
  eq(vThin.sample.ready, false, 'readiness flag is false');
  assertNoNonFinite(vThin, 'thin verdict');

  // ═══════════════════════════════════════════════════════════════════════
  hr('8. split results — per-arm table matches the hand-computed fixture');
  const sr = await getSplitResults({ testId: T1, ...WIN }, { query, readLedger: readResults });
  assert(!sr.error, `split results returned without error (${sr.error ?? 'ok'})`);
  const A = sr.arms.find((a) => a.arm_key === 'a');
  const B = sr.arms.find((a) => a.arm_key === 'b');
  eq(A.visitors, 400, 'arm a exposures = 400');
  eq(B.visitors, 400, 'arm b exposures = 400');
  eq(A.orders, 30, 'arm a money-moved orders = 30 (370 processing excluded)');
  eq(B.orders, 80, 'arm b money-moved orders = 80');
  eq(A.base_revenue, 3000, 'arm a base revenue = 3000');
  eq(A.upsell_legs, 2, 'arm a upsell legs = 2');
  eq(A.upsell_buyers, 2, 'arm a upsell buyers = 2');
  assert(A.upsell_legs >= A.upsell_buyers, 'arm a legs >= buyers');
  eq(A.upsell_revenue, 100, 'arm a upsell revenue = 100');
  eq(A.gross_revenue, 3100, 'arm a gross = 3000 + 100');
  eq(A.refunded, 30, 'arm a refunded = 30');
  eq(A.net_revenue, 3070, 'arm a net = 3100 − 30');
  eq(A.net_revenue_sum, 3070, 'arm a Σx from the moments query agrees with net');
  eq(A.net_revenue_sum_squares, 319900, 'arm a Σx² = 27·10000 + 2·22500 + 4900');
  eq(B.net_revenue, 8000, 'arm b net = 8000');
  eq(B.net_revenue_sum_squares, 800000, 'arm b Σx² = 80·10000');
  eq(A.cvr, 0.075, 'arm a CVR = 30/400 EXACTLY');
  eq(B.cvr, 0.2, 'arm b CVR = 80/400 EXACTLY');
  eq(A.rev_per_visitor, 7.675, 'arm a RPV = 3070/400 EXACTLY');
  eq(B.rev_per_visitor, 20, 'arm b RPV = 8000/400 EXACTLY');
  near(B.vs_control_rpv_pct, ((20 - 7.675) / 7.675) * 100, 0.1, 'arm b vs control % is correct');
  eq(sr.totals.net_revenue, 11070, 'split totals net = 3070 + 8000');
  assertNoNonFinite(sr, 'split results');

  hr('8c. split refunds are COHORT-based, funnel refunds are CALENDAR-based');
  // The same refund, settling AFTER the window closes, must be netted by the
  // split (it is evidence about the arm that earned the sale) and NOT by the
  // funnel report (which asks "what did this month cost me?"). Two bases, both
  // deliberate, both documented — asserted here so they can never silently drift.
  await query(`UPDATE co_sessions SET refunds = $1::jsonb WHERE id = 'b_s0'`, [
    [{ id: 'rf_late', amount: 55, gateway: 'stripe', dispute: false, at: OUT_AFTER.toISOString() }],
  ]);
  const srLate = await getSplitResults({ testId: T1, ...WIN }, { query });
  const BLate = srLate.arms.find((a) => a.arm_key === 'b');
  eq(BLate.refunded, 55, 'a refund settling after the window still nets against its arm (cohort)');
  eq(BLate.net_revenue, 7945, 'arm b net = 8000 − 55');
  eq(BLate.net_revenue_sum, 7945, 'and the t-test moments agree with it exactly');
  const fnlLate = await getFunnelOverview({ funnelId: F2, ...WIN }, deps);
  eq(fnlLate.totals.refunded, 30, 'the FUNNEL report excludes it — dated outside the window (calendar)');
  await query(`UPDATE co_sessions SET refunds = '[]'::jsonb WHERE id = 'b_s0'`);

  hr('8b. split verdict + readiness + the ledger reconciliation');
  console.log(`  verdict: ${sr.verdict.status} — ${sr.verdict.headline}`);
  // ARM DELIVERY GATE: nothing in the serve path renders a different variant
  // yet, so every arm shows the same page and any gap is noise. The API must
  // REFUSE to name a winner until SPLIT_DELIVERY_WIRED flips — otherwise the
  // significance engine eventually prints a confident winner from sampling
  // error. (The engine's own math is asserted directly below.)
  eq(sr.verdict.status, 'not_ready', 'API refuses a winner while arms are not served');
  eq(sr.verdict.blocked_reason, 'arm_delivery_not_wired', 'the refusal names its reason');
  eq(sr.verdict.leader, null, 'no leader is published while unscoreable');
  {
    // The underlying engine is unaffected — it still finds b on this data.
    const raw = buildVerdict([
      { arm_key: 'a', is_control: true, visitors: sr.arms.find(x => x.arm_key === 'a').visitors, orders: sr.arms.find(x => x.arm_key === 'a').orders, net_revenue: sr.arms.find(x => x.arm_key === 'a').net_revenue_sum, net_revenue_sum_squares: sr.arms.find(x => x.arm_key === 'a').net_revenue_sum_squares },
      { arm_key: 'b', is_control: false, visitors: sr.arms.find(x => x.arm_key === 'b').visitors, orders: sr.arms.find(x => x.arm_key === 'b').orders, net_revenue: sr.arms.find(x => x.arm_key === 'b').net_revenue_sum, net_revenue_sum_squares: sr.arms.find(x => x.arm_key === 'b').net_revenue_sum_squares },
    ]);
    eq(raw.status, 'winner', 'engine itself still declares the winner (math intact)');
    eq(raw.leader, 'b', 'engine leader is still b');
  }
  eq(sr.verdict.sample.ready, true, 'both arms clear the sample floors');
  eq(sr.verdict.sample.comparisons, 1, 'Bonferroni comparisons = arms − 1');
  assert(sr.verdict.revenue.confidence > 0.95, `revenue confidence > 95% (got ${(sr.verdict.revenue.confidence * 100).toFixed(2)}%)`);
  assert(sr.ledger && Array.isArray(sr.ledger.arms), 'splitCredits.readResults is reused verbatim under `ledger`');
  const ledgerA = sr.ledger.arms.find((a) => a.arm_key === 'a');
  eq(ledgerA.exposures, 400, 'ledger arm a exposures agree with the table');
  eq(ledgerA.conversions, 30, 'ledger arm a conversions agree with the table');

  hr('8d. F4/F8 — 3 arms: per-arm confidence, and Bonferroni actually applied');
  const sr3 = await getSplitResults({ testId: T3, ...WIN }, { query });
  const a3 = sr3.arms.find((a) => a.arm_key === 'a');
  const b3 = sr3.arms.find((a) => a.arm_key === 'b');
  const c3 = sr3.arms.find((a) => a.arm_key === 'c');
  eq(a3.orders, 40, 'T3 control a = 40 orders');
  eq(b3.orders, 90, 'T3 arm b = 90 orders (winner)');
  eq(c3.orders, 20, 'T3 arm c = 20 orders (loser)');
  eq(sr3.verdict.sample.comparisons, 2, 'comparisons = arms − 1 = 2');
  eq(sr3.verdict.sample.alphaAdjusted, 0.025, 'Bonferroni α = 0.05/2');
  assert(sr3.verdict.perArm && sr3.verdict.perArm.b && sr3.verdict.perArm.c,
    'verdict carries PER-ARM comparisons, not one scalar');
  const cb = sr3.verdict.perArm.b.revenue_confidence;
  const cc = sr3.verdict.perArm.c.revenue_confidence;
  console.log(`  per-arm rev confidence: b=${(cb * 100).toFixed(2)}%  c=${(cc * 100).toFixed(2)}%`);
  assert(cb !== cc, `arm b and arm c carry DIFFERENT confidences (${cb} vs ${cc})`);
  eq(sr3.verdict.leader, null, 'multi-arm: no leader published while unscoreable');
  eq(sr3.verdict.perArm.c.significant && c3.rev_per_visitor > a3.rev_per_visitor, false,
    'the LOSING arm is never reported as a significant winner');
  // F8: `significant` must agree with the Bonferroni gate, not a flat 0.05.
  const borderline = compareConversion(
    { visitors: 1000, conversions: 100 }, { visitors: 1000, conversions: 128 },
    { alpha: 0.025 }
  );
  console.log(`  borderline p=${borderline.pValue} α=0.025`);
  eq(borderline.significant, borderline.pValue < 0.025, '`significant` is judged at the ADJUSTED α');
  eq(borderline.significant_uncorrected, borderline.pValue < 0.05, '`significant_uncorrected` keeps the raw answer');
  assert(borderline.pValue > 0.025 && borderline.pValue < 0.05,
    `and this case actually separates them (p=${borderline.pValue})`);
  eq(borderline.significant, false, 'so the corrected verdict refuses where the raw one would not');
  assertNoNonFinite(sr3, 'three-arm split results');

  hr('8e. F9 — required-N never contradicts the readiness floor');
  const vThin2 = buildVerdict([
    { arm_key: 'a', is_control: true, visitors: 40, orders: 4, net_revenue: 400, net_revenue_sum_squares: 40000 },
    { arm_key: 'b', is_control: false, visitors: 40, orders: 20, net_revenue: 2000, net_revenue_sum_squares: 200000 },
  ]);
  assert(
    vThin2.requiredSamplePerArm >= 300,
    `required N is floored at the readiness bar (got ${vThin2.requiredSamplePerArm}, raw ${vThin2.sample.requiredSampleRaw})`
  );
  eq(vThin2.sample.sized_on_observed_effect, true, 'and is flagged as sized on the observed (biased) effect');
  assert(
    !(vThin2.headline.includes('300 visitors') && /about (\d+) visitors/.test(vThin2.headline)
      && Number(RegExp.$1) < 300),
    `headline cannot say "needs 300" and "about <300" at once: "${vThin2.headline}"`
  );

  hr('9. the honest window disclosure');
  eq(sr.disclosure.tracking_started_after_test, true, 'tracking began AFTER T1 was created → flag fires');
  assert(sr.disclosure.test_created_at instanceof Date, 'test_created_at is returned');
  assert(sr.disclosure.tracking_started_at instanceof Date, 'tracking_started_at is returned');
  assert(
    new Date(sr.disclosure.tracking_started_at) > new Date(sr.disclosure.test_created_at),
    'and the ordering is what the flag claims'
  );
  assert(sr.disclosure.note && sr.disclosure.note.includes('missing, not zero'), 'the note explains the consequence');
  eq(sr.disclosure.visitors_understated, true, 'the exposure-basis caveat is disclosed');
  const sr2 = await getSplitResults({ testId: T2, ...WIN }, { query, readLedger: readResults });
  eq(sr2.disclosure.tracking_started_after_test, false, 'T2 (created after tracking) → flag does NOT fire');
  const srMissing = await getSplitResults({ testId: 'nope', ...WIN }, { query });
  eq(srMissing.error, 'test_not_found', 'unknown test → test_not_found');

  // ═══════════════════════════════════════════════════════════════════════
  hr('10. window validation + SQL injection via from/to');
  const injections = [
    "2026-01-01'; DROP TABLE co_sessions; --",
    "2026-01-01' OR '1'='1",
    '2026-01-01 UNION SELECT * FROM users',
    '2026-13-01', '2026-02-31', '0000-00-00', 'yesterday', ' 2026-01-01',
    '2026-01-01T00:00:00Z', '../../etc/passwd', '2026-1-1',
  ];
  let allRejected = true;
  for (const bad of injections) {
    const r = parseWindow({ from: bad, to: '2026-07-31' });
    if (r.ok) {
      allRejected = false;
      console.log(`    NOT REJECTED: ${JSON.stringify(bad)}`);
    }
  }
  assert(allRejected, `all ${injections.length} hostile from/to values rejected by parseWindow`);
  // An ABSENT window is not hostile — it defaults. Asserted explicitly so the
  // difference between "omitted" and "malformed" stays deliberate.
  const dflt = parseWindow({});
  eq(dflt.ok, true, 'an omitted window defaults instead of erroring');
  eq(dflt.days, 30, 'the default window is 30 days');
  eq(parseWindow({ from: '', to: '' }).days, 30, 'empty strings default the same way');
  const svcInj = await getFunnelOverview(
    { funnelId: F1, from: "2026-01-01'; DROP TABLE co_sessions; --", to: '2026-07-31' },
    deps
  );
  eq(svcInj.error, 'invalid_date_format', 'the service refuses a hostile window');
  const stillThere = await query(
    `SELECT COUNT(*)::int AS n FROM information_schema.tables WHERE table_name = 'co_sessions'`
  );
  eq(stillThere[0].n, 1, 'co_sessions still exists — nothing was executed');
  eq(parseWindow({ from: '2026-07-31', to: '2026-07-01' }).error, 'to_before_from', 'reversed window refused');
  eq(parseWindow({ from: '2020-01-01', to: '2026-07-31' }).error, 'window_too_large', 'a 2400-day window refused');
  const w1 = parseWindow({ from: '2026-07-01', to: '2026-07-01' });
  eq(w1.days, 1, 'a single-day window spans exactly 1 day (half-open, no off-by-one)');
  eq(w1.toTs.toISOString(), '2026-07-02T00:00:00.000Z', 'right edge is exclusive at to+1d');

  hr('10b. boundary rows land in exactly one window');
  // The refund on 2026-07-20 must appear in a window ending 07-20 and NOT in
  // one starting 07-21 — the half-open edge, verified on a real row.
  const inc = await getFunnelOverview({ funnelId: F1, from: '2026-07-20', to: '2026-07-20' }, deps);
  const exc = await getFunnelOverview({ funnelId: F1, from: '2026-07-21', to: '2026-07-21' }, deps);
  eq(inc.totals.refunded, 100, 'the 07-20 refund is inside a 07-20..07-20 window');
  eq(exc.totals.refunded, 30, 'and NOT in the 07-21 window (which holds its own $30)');
  const both = await getFunnelOverview({ funnelId: F1, from: '2026-07-20', to: '2026-07-21' }, deps);
  eq(both.totals.refunded, 130, 'a window spanning both counts each refund exactly once');

  hr('10c. read-only — the subsystem never writes to money tables');
  const before = await query(
    `SELECT (SELECT COUNT(*) FROM co_sessions) AS s, (SELECT COUNT(*) FROM co_upsell_charges) AS u,
            (SELECT COUNT(*) FROM lb_split_credits) AS c, (SELECT COUNT(*) FROM lb_touches) AS t`
  );
  await getFunnelOverview({ funnelId: F1, ...WIN }, deps);
  await getSplitResults({ testId: T1, ...WIN }, { query, readLedger: readResults });
  await getPageMetrics({ funnelId: F1, pageId: P_CHECKOUT, ...WIN }, deps);
  const after = await query(
    `SELECT (SELECT COUNT(*) FROM co_sessions) AS s, (SELECT COUNT(*) FROM co_upsell_charges) AS u,
            (SELECT COUNT(*) FROM lb_split_credits) AS c, (SELECT COUNT(*) FROM lb_touches) AS t`
  );
  assert(
    JSON.stringify(before[0]) === JSON.stringify(after[0]),
    `row counts unchanged after every read path ran (${JSON.stringify(after[0])})`
  );

  hr('11. fail-open — a missing tracking table must not throw');
  await query(`ALTER TABLE lb_touches RENAME TO lb_touches_hidden`);
  const degraded = await getFunnelOverview({ funnelId: F1, ...WIN }, deps);
  assert(!degraded.error, 'the overview still returns with lb_touches missing');
  eq(degraded.degraded, true, 'and is flagged degraded');
  assert(
    degraded.warnings.some((w) => w.source === 'lb_touches'),
    `the degraded source is named (${JSON.stringify(degraded.warnings.map((w) => w.source))})`
  );
  eq(degraded.totals.visitors, null, 'visitors is NULL, not 0 — "unmeasured" ≠ "no traffic"');
  eq(degraded.pages.find((p) => p.page_id === P_CHECKOUT).cvr, null, 'CVR is null when the denominator is unmeasured');
  eq(degraded.pages.find((p) => p.page_id === P_CHECKOUT).net_revenue, 1130, 'money still reports while tracking is down');
  assertNoNonFinite(degraded, 'degraded overview');
  await query(`ALTER TABLE lb_touches_hidden RENAME TO lb_touches`);

  hr('11b. a malformed refund entry cannot take the report down');
  await query(
    `UPDATE co_sessions SET refunds = $1::jsonb WHERE id = 's6'`,
    [[{ id: 'bad', amount: 'not-a-number', at: 'whenever' }]]
  );
  const withBad = await getFunnelOverview({ funnelId: F1, ...WIN }, deps);
  assert(!withBad.error, 'a malformed refunds[] entry does not throw');
  eq(withBad.totals.refunded, 155, 'the malformed entry is skipped, the good ones still count');
  eq(withBad.meta.malformed_refund_entries, 1, 'and the skipped entry is disclosed');
  await query(`UPDATE co_sessions SET refunds = '[]'::jsonb WHERE id = 's6'`);

  // ═══════════════════════════════════════════════════════════════════════
  hr('11c. F5 — analytics cannot open the money path\'s circuit breaker');
  // The coupling: pgQuery's timeout is a Promise.race (no server-side cancel),
  // so a slow analytics query holds a connection from the SHARED max-10 pool
  // until statement_timeout, and EVERY lost race calls recordFailure() on a
  // process-wide breaker that opens after 5 and then rejects settlement for 30s.
  // Analytics now runs on its own pool and never touches that breaker.
  const { analyticsQuery, ANALYTICS_DB_LIMITS, closeAnalyticsPool } =
    await import('../server/src/services/analyticsDb.js');
  const pgMod = await import('../server/src/db/pg.js');
  eq(ANALYTICS_DB_LIMITS.sharedBreaker, false, 'the analytics handle declares no breaker participation');
  assert(ANALYTICS_DB_LIMITS.poolMax <= 3, `analytics pool is small (max ${ANALYTICS_DB_LIMITS.poolMax}) — it cannot starve the money pool`);
  eq(pgMod.isDbCircuitOpen(), false, 'breaker starts closed');
  // Fire enough failing analytics queries to trip a 5-failure breaker, if it
  // were shared. It must stay closed, and pgQuery must still work afterwards.
  for (let i = 0; i < 8; i += 1) {
    try { await analyticsQuery('SELECT * FROM a_table_that_does_not_exist'); } catch { /* expected */ }
  }
  eq(pgMod.isDbCircuitOpen(), false, '8 failed analytics queries leave the shared breaker CLOSED');
  const moneyStillWorks = await pgMod.pgQuery(`SELECT COUNT(*)::int AS n FROM co_sessions`);
  assert(Number.isFinite(moneyStillWorks[0].n), 'the money path still queries fine after the analytics failures');
  // And the analytics pool enforces a server-side cancel, not an abandoned race.
  const tSlow = Date.now();
  let cancelled = false;
  try { await analyticsQuery('SELECT pg_sleep(30)'); }
  catch (e) { cancelled = /statement timeout|canceling/i.test(e.message); }
  const slowMs = Date.now() - tSlow;
  assert(cancelled, `a slow analytics query is CANCELLED server-side (not abandoned) — ${slowMs}ms`);
  assert(slowMs < 12_000, `and it gives up inside its own budget (${slowMs}ms < 12s)`);
  eq(pgMod.isDbCircuitOpen(), false, 'even the timeout leaves the money breaker closed');
  await closeAnalyticsPool();

  hr('12. performance at realistic volume (rollup decision)');
  const t0 = Date.now();
  await query(
    `INSERT INTO lb_touches (vid, funnel_id, page_id, url, referrer, utm, click_ids, ts, expires_at)
     SELECT 'pv' || (g % 20000), $1,
            (ARRAY['pg_lander','pg_checkout','pg_upsell'])[1 + (g % 3)],
            'https://x/', '', '{}'::jsonb, '{}'::jsonb,
            TIMESTAMPTZ '2026-07-01' + (g % 30) * INTERVAL '1 day' + (g % 1440) * INTERVAL '1 minute',
            $2
     FROM generate_series(1, 60000) g`,
    [F1, TTL]
  );
  await query(
    `INSERT INTO co_sessions (id, funnel_id, page_id, status, line_items, subtotal, shipping, tax,
                              total, currency, customer, refunds, vid, paid_at, created_at, updated_at)
     SELECT 'perf' || g, $1, 'pg_checkout',
            CASE WHEN g % 4 = 0 THEN 'paid' ELSE 'processing' END,
            '[]'::jsonb, 0,0,0, 100, 'USD', '{}'::jsonb, '[]'::jsonb, 'pv' || (g % 20000),
            CASE WHEN g % 4 = 0 THEN TIMESTAMPTZ '2026-07-01' + (g % 30) * INTERVAL '1 day' END,
            TIMESTAMPTZ '2026-07-01' + (g % 30) * INTERVAL '1 day', NOW()
     FROM generate_series(1, 20000) g`,
    [F1]
  );
  // ANALYZE after the bulk load. This is NOT cheating: production writes
  // lb_touches one beacon row at a time and autovacuum keeps its statistics
  // current. A bulk INSERT ... generate_series leaves the planner estimating
  // ~2,000 rows against 60,000 real ones, which makes it pick a nested loop
  // and blows past any timeout — see the measured table in funnelAnalytics.js.
  // Without this line the harness measures a condition production never has.
  await query(`ANALYZE lb_touches`);
  await query(`ANALYZE co_sessions`);
  console.log(`  seeded 60,000 touches + 20,000 sessions in ${Date.now() - t0}ms`);
  const counts = await query(
    `SELECT (SELECT COUNT(*) FROM lb_touches WHERE funnel_id=$1) AS touches,
            (SELECT COUNT(*) FROM co_sessions WHERE funnel_id=$1) AS sessions`,
    [F1]
  );
  console.log(`  volume: ${counts[0].touches} touches, ${counts[0].sessions} sessions`);
  const timings = [];
  for (let i = 0; i < 3; i += 1) {
    const t = Date.now();
    const r = await getFunnelOverview({ funnelId: F1, ...WIN }, deps);
    timings.push(Date.now() - t);
    if (i === 0) {
      assert(!r.error, 'the overview still succeeds at volume');
      assertNoNonFinite(r, 'high-volume overview');
      console.log(`  at volume: visitors=${r.totals.visitors} orders=${r.totals.orders} net=${r.totals.net_revenue}`);
    }
  }
  const best = Math.min(...timings);
  console.log(`  getFunnelOverview timings: ${timings.join('ms, ')}ms (best ${best}ms)`);
  assert(best < 8000, `overview completes inside the 8s pgQuery timeout (best ${best}ms)`);
  console.log(
    best < 1500
      ? `  ⇒ ROLLUP DECISION: live queries are fast enough (${best}ms). NO rollup table built.`
      : `  ⇒ ROLLUP DECISION: ${best}ms — a daily rollup cache would be justified.`
  );

  // ── Result ───────────────────────────────────────────────────────────────
  console.log(`\n${'='.repeat(60)}`);
  console.log(`RESULT: ${passed} passed, ${failed} failed`);
  if (failed) {
    console.log('\nFAILURES:');
    failures.forEach((f) => console.log(`  - ${f}`));
  }
  console.log('='.repeat(60));
  await sql.end();
  process.exit(failed ? 1 : 0);
}

main().catch(async (err) => {
  console.error('\nHARNESS THREW:', err);
  await sql.end().catch(() => {});
  process.exit(2);
});
