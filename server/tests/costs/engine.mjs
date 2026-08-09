// COGS ENGINE verification — drives the REAL funnelCosts.js (resolveCosts /
// appendRate / runDetectSweep / coverageSummary / pnlOverview) against
// embedded PG. Proves the SIX MONEY INVARIANTS by execution:
//   1. null ≠ 0 — unknown cost withholds profit, for COGS AND ship
//   2. revenue base = captured money; other_revenue delta; fees per
//      transaction pro-rata to legs, last leg absorbs rounding
//   3. profit withheld at zero coverage (net/margin null, never 100%)
//   4. per-leg pricing day — an upsell settled after the order prices at ITS
//      settle-day rate
//   5. refunds net top line only — COGS/fees not reversed
//   6. gp = net_revenue − cogs − ship − fees; net_profit only when spend_known
// plus effective dating, the detect sweep's by_funnel split, the
// revenue_at_risk_30d fixture and the malformed-write refusals.
//
// Run:  node server/tests/costs/engine.mjs
import postgres from 'postgres';

const DB = 'postgres://puure@127.0.0.1:5433/puure_costs_engine';
process.env.DATABASE_URL = DB;
process.env.NODE_ENV = 'development';

let pass = 0, fail = 0;
const ok = (c, m, x = '') => { if (c) { pass++; console.log('PASS ', m); } else { fail++; console.log('FAIL ', m, x); } };

// ---- bootstrap db
const admin = postgres('postgres://puure@127.0.0.1:5433/postgres', { ssl: false });
await admin`DROP DATABASE IF EXISTS puure_costs_engine`;
await admin`CREATE DATABASE puure_costs_engine`;
await admin.end();
const sql = postgres(DB, { ssl: false, onnotice: () => {} });

const {
  CostError, resolveCosts, buildRateIndex, resolveUnitCogs, resolveUnitShip,
  resolveFeeRate, resolveEffectiveFrom, appendRate, listRates, rateHistory,
  runDetectSweep, coverageSummary, listVariants, listByFunnel, patchVariant,
  getFeeSettings, updateFeeSettings, pnlOverview, pnlFunnel, dayKey, daysAgo,
} = await import('../../src/services/funnelCosts.js');
const { ensureFunnelCostsTables } = await import('../../src/services/funnelCostsSchema.js');
const { ensureCheckoutTables } = await import('../../src/services/checkoutSchema.js');
const { ensureTrackingTables } = await import('../../src/services/trackingSchema.js');
await ensureFunnelCostsTables();
await ensureCheckoutTables();
await ensureTrackingTables(); // lb_clicks — the P&L spend read joins it

const TODAY = dayKey();
const D = (n) => daysAgo(n); // n days ago as day key
const V1 = '111111111111';   // main product variant
const V2 = '222222222222';   // upsell variant
const V3 = '333333333333';   // never-costed variant
const V4 = '444444444444';   // digital (no-ship) variant

const mkSession = (over = {}) => ({
  id: over.id || 's_x',
  funnel_id: over.funnel_id || 'f1',
  gateway: over.gateway || 'whop',
  total: over.total !== undefined ? over.total : 100,
  line_items: over.line_items || [{ variant_id: V1, quantity: 2, price: 50, title: '2x', product_title: 'Prod' }],
  refunds: over.refunds || [],
  paid_at: over.paid_at || `${TODAY}T10:00:00Z`,
  status: 'paid',
});

// ═══ T1: INVARIANT 1 — null ≠ 0, COGS side ═════════════════════════════════
{
  const catalog = { [V1]: { variant_id: V1, pays_shipping: false } };
  // No rates at all → unknown
  const r0 = resolveCosts(mkSession({}), TODAY, { catalog, rates: [] });
  ok(r0.legs[0].unit_cogs === null && r0.legs[0].cogs === null, 'T1 no rate → unit_cogs null (never 0)');
  ok(r0.net === null && r0.margin_pct === null, 'T1 unknown COGS withholds net + margin');
  ok(r0.missing_cogs_legs === 1 && r0.missing_legs === 1, 'T1 miss counters name the missing half');
  // Explicit 0 → known free, a REAL answer
  const rates = [{ id: 1, scope: 'variant', variant_id: V1, effective_from: '2020-01-01', unit_cogs: 0, ship: {}, created_at: '2020-01-01T00:00:00Z' }];
  const rz = resolveCosts(mkSession({}), TODAY, { catalog, rates });
  ok(rz.legs[0].unit_cogs === 0 && rz.legs[0].cogs === 0, 'T1 explicit 0 → cogs 0 (known free)');
  ok(rz.net !== null, 'T1 known-free COGS does NOT withhold profit');
  ok(JSON.stringify(r0.legs[0]) !== JSON.stringify(rz.legs[0]), 'T1 unknown and known-free are never byte-identical');
}

// ═══ T2: INVARIANT 1 — null ≠ 0, SHIP side (binds exactly as hard) ═════════
{
  const catalog = { [V1]: { variant_id: V1, pays_shipping: true } };
  const cogsOnly = [{ id: 1, scope: 'variant', variant_id: V1, effective_from: '2020-01-01', unit_cogs: 5, ship: {}, created_at: '2020-01-01T00:00:00Z' }];
  const rU = resolveCosts(mkSession({}), TODAY, { catalog, rates: cogsOnly });
  ok(rU.legs[0].shipping === null && rU.legs[0].ship_known === false, 'T2 shipping variant w/o ship rate → UNKNOWN ship');
  ok(rU.net === null, 'T2 unknown ship withholds profit even with known COGS');
  ok(rU.cogs === 10, 'T2 …but the known COGS still accumulates into totals');
  ok(rU.missing_ship_legs === 1 && rU.missing_cogs_legs === 0, 'T2 miss split says WHICH half is missing');
  const shipZero = [{ id: 1, scope: 'variant', variant_id: V1, effective_from: '2020-01-01', unit_cogs: 5, ship: { default: 0 }, created_at: '2020-01-01T00:00:00Z' }];
  const rZ = resolveCosts(mkSession({}), TODAY, { catalog, rates: shipZero });
  ok(rZ.legs[0].shipping === 0 && rZ.legs[0].ship_known === true, 'T2 explicit ship 0 → known free, chain STOPS');
  ok(rZ.net !== null && rZ.ship_cost === 0, 'T2 known-free ship does not withhold profit');
  // A no-ship variant with a blank ship rate is NOT a miss
  const catNoShip = { [V4]: { variant_id: V4, pays_shipping: false } };
  const rD = resolveCosts(mkSession({ line_items: [{ variant_id: V4, quantity: 1, price: 30 }], total: 30 }), TODAY,
    { catalog: catNoShip, rates: [{ id: 2, scope: 'variant', variant_id: V4, effective_from: '2020-01-01', unit_cogs: 1, ship: {}, created_at: '2020-01-01T00:00:00Z' }] });
  ok(rD.legs[0].ship_known === true && rD.net !== null, 'T2 no-ship variant: blank ship rate is not a miss');
}

// ═══ T3: effective dating (in-memory resolution semantics) ═════════════════
{
  const rates = [
    { id: 1, scope: 'variant', variant_id: V1, effective_from: D(20), unit_cogs: 3, ship: {}, created_at: `${D(20)}T09:00:00Z` },
    { id: 2, scope: 'variant', variant_id: V1, effective_from: TODAY, unit_cogs: 5, ship: {}, created_at: `${TODAY}T09:00:00Z` },
  ];
  const idx1 = buildRateIndex(rates);
  ok(resolveUnitCogs({ variant_id: V1 }, idx1, D(5))[0] === 3, 'T3 yesterday still prices at the old rate (today\'s change does not move it)');
  ok(resolveUnitCogs({ variant_id: V1 }, idx1, TODAY)[0] === 5, 'T3 today prices at the new rate');
  // A BACKDATED edit moves exactly from its own date
  const rates2 = [...rates, { id: 3, scope: 'variant', variant_id: V1, effective_from: D(10), unit_cogs: 4, ship: {}, created_at: `${TODAY}T10:00:00Z` }];
  const idx2 = buildRateIndex(rates2);
  ok(resolveUnitCogs({ variant_id: V1 }, idx2, D(5))[0] === 4, 'T3 backdated rate DOES re-price the days it covers');
  ok(resolveUnitCogs({ variant_id: V1 }, idx2, D(15))[0] === 3, 'T3 …but not the days before its effective_from');
  ok(resolveUnitCogs({ variant_id: V1 }, idx2, TODAY)[0] === 5, 'T3 …and not the newer rate\'s span');
  // Same effective_from twice: the later WRITE wins (typo correction)
  const dup = [
    { id: 4, scope: 'variant', variant_id: V1, effective_from: D(3), unit_cogs: 9, ship: {}, created_at: `${TODAY}T11:00:00Z` },
    { id: 5, scope: 'variant', variant_id: V1, effective_from: D(3), unit_cogs: 7, ship: {}, created_at: `${TODAY}T12:00:00Z` },
  ];
  ok(resolveUnitCogs({ variant_id: V1 }, buildRateIndex(dup), D(1))[0] === 7, 'T3 same-day double write → the later WRITE wins');
}

// ═══ T4: INVARIANT 4 — upsell leg priced at ITS charge day ═════════════════
{
  const catalog = { [V1]: { variant_id: V1, pays_shipping: false }, [V2]: { variant_id: V2, pays_shipping: false } };
  const rates = [
    { id: 1, scope: 'variant', variant_id: V1, effective_from: '2020-01-01', unit_cogs: 2, ship: {}, created_at: '2020-01-01T00:00:00Z' },
    { id: 2, scope: 'variant', variant_id: V2, effective_from: '2020-01-01', unit_cogs: 2, ship: {}, created_at: '2020-01-01T00:00:00Z' },
    // rate change between order day and upsell settle day
    { id: 3, scope: 'variant', variant_id: V2, effective_from: D(2), unit_cogs: 7, ship: {}, created_at: `${D(2)}T00:00:00Z` },
  ];
  const session = mkSession({ paid_at: `${D(6)}T10:00:00Z`, total: 100 });
  const charge = { id: 'ux_1', status: 'settled', amount: 40, line_items: [{ variant_id: V2, quantity: 1, unit_price: 40 }], created_at: `${D(1)}T10:00:00Z` };
  const r = resolveCosts(session, session.paid_at, { catalog, rates, charges: [charge] });
  const cart = r.legs.find((l) => l.kind === 'cart');
  const up = r.legs.find((l) => l.kind === 'upsell');
  ok(cart.unit_cogs === 2, 'T4 cart leg prices at the ORDER day rate');
  ok(up.cost_day === D(1) && up.unit_cogs === 7, `T4 upsell leg carries its own cost_day and prices at the SETTLE-day rate (got ${up.unit_cogs})`);
  ok(r.cogs === 4 + 7, 'T4 order COGS = cart at order-day + upsell at settle-day');
}

// ═══ T5: INVARIANT 2 — fees per transaction, pro-rata, cent-exact ══════════
{
  const fee = { default_pct: 2.9, default_fixed: 0.3, gateways: {} };
  const legs = [
    { variant_id: V1, context: 'main', quantity: 1, revenue: 33.33, tx: 't1', kind: 'cart' },
    { variant_id: V1, context: 'main', quantity: 1, revenue: 33.33, tx: 't1', kind: 'cart' },
    { variant_id: V1, context: 'main', quantity: 1, revenue: 33.35, tx: 't1', kind: 'cart' },
  ];
  const txs = [{ id: 't1', amount: 100.01, provider: 'stripe' }];
  const r = resolveCosts(legs, TODAY, { rates: [], transactions: txs, feeSettings: fee });
  const txFee = Math.round((100.01 * 2.9 / 100 + 0.3) * 100) / 100; // 3.20
  const sumLegFees = Math.round(r.legs.reduce((s, l) => s + l.fees, 0) * 100) / 100;
  ok(r.fees === txFee, `T5 tx fee billed on the captured amount (${r.fees} vs ${txFee})`);
  ok(sumLegFees === txFee, `T5 Σ per-leg fees == the transaction's fee TO THE CENT (${sumLegFees})`);
  const naive = r.legs.slice(0, -1).reduce((s, l) => s + l.fees, 0);
  ok(Math.abs(r.legs[2].fees - (txFee - naive)) < 1e-9, 'T5 last leg absorbs the rounding remainder');
  // fee billed PER TRANSACTION: an upsell is its own charge with its own fixed fee
  const catalog = { [V1]: { variant_id: V1, pays_shipping: false }, [V2]: { variant_id: V2, pays_shipping: false } };
  const s2 = mkSession({ total: 100, gateway: 'stripe' });
  const c2 = { id: 'ux_2', status: 'settled', amount: 50, line_items: [{ variant_id: V2, quantity: 1 }], created_at: `${TODAY}T11:00:00Z` };
  const r2 = resolveCosts(s2, TODAY, { catalog, rates: [], feeSettings: fee, charges: [c2] });
  const expect2 = (Math.round((100 * 0.029 + 0.3) * 100) + Math.round((50 * 0.029 + 0.3) * 100)) / 100;
  ok(r2.fees === expect2, `T5 two charges → two fixed fees, never one blended (${r2.fees} vs ${expect2})`);
  ok(r2.transactions.length === 2, 'T5 base + settled upsell = 2 transactions');
}

// ═══ T6: INVARIANT 2 — revenue base = captured money, other_revenue ════════
{
  // captured 107.50 (line 100 + buyer shipping 5 + tax 2.50) + upsell 40
  const catalog = {};
  const s = mkSession({ total: 107.5, line_items: [{ variant_id: V1, quantity: 2, price: 50 }] });
  const c = { id: 'ux_3', status: 'settled', amount: 40, line_items: [{ variant_id: V2, quantity: 1 }], created_at: `${TODAY}T11:00:00Z` };
  const r = resolveCosts(s, TODAY, { catalog, rates: [], charges: [c] });
  ok(r.other_revenue === 7.5, `T6 other_revenue = captured − cart lines (${r.other_revenue})`);
  ok(r.revenue === 147.5, `T6 revenue = base capture + settled upsell (${r.revenue}) — never Σ cart lines`);
  const legRev = r.legs.reduce((s2, l) => s2 + l.revenue, 0);
  ok(Math.round((legRev + r.other_revenue) * 100) / 100 === r.revenue, 'T6 Σ leg revenue + other_revenue == revenue');
  // discount inverts the sign
  const sd = mkSession({ total: 90, line_items: [{ variant_id: V1, quantity: 2, price: 50 }] });
  const rd = resolveCosts(sd, TODAY, { catalog, rates: [] });
  ok(rd.other_revenue === -10, 'T6 a discount surfaces as NEGATIVE other_revenue');
}

// ═══ T7: INVARIANT 5 — refunds net the top line ONLY ═══════════════════════
{
  const catalog = { [V1]: { variant_id: V1, pays_shipping: false } };
  const rates = [{ id: 1, scope: 'variant', variant_id: V1, effective_from: '2020-01-01', unit_cogs: 5, ship: {}, created_at: '2020-01-01T00:00:00Z' }];
  const fee = { default_pct: 6, default_fixed: 0, gateways: {} };
  const base = resolveCosts(mkSession({}), TODAY, { catalog, rates, feeSettings: fee });
  const refunded = resolveCosts(mkSession({ refunds: [{ amount: 20, id: 're_1' }] }), TODAY, { catalog, rates, feeSettings: fee });
  ok(refunded.refunds === 20 && refunded.net_revenue === base.net_revenue - 20, 'T7 refund nets net_revenue');
  ok(refunded.cogs === base.cogs, 'T7 COGS NOT reversed by a refund');
  ok(refunded.fees === base.fees, 'T7 fees NOT reversed (processors keep them)');
  ok(refunded.net === base.net - 20, 'T7 net falls by exactly the refund');
}

// ═══ T8: INVARIANT 3 — zero coverage withholds, never 100% ═════════════════
{
  const r = resolveCosts(mkSession({}), TODAY, { catalog: {}, rates: [] });
  ok(r.net === null && r.margin_pct === null, 'T8 zero coverage → net null, margin null (NEVER 100%)');
  ok(r.coverage_pct === 0 && r.known_legs === 0, 'T8 coverage 0 with the counters beside it');
  ok(r.revenue > 0 && r.fees > 0, 'T8 revenue and fees still reported beside the withheld profit');
}

// ═══ T9: edge — unknown / blank variant_id in line_items ═══════════════════
{
  const s = mkSession({ line_items: [{ variant_id: '', quantity: 1, price: 10 }, { variant_id: '999999999999', quantity: 1, price: 90 }], total: 100 });
  const r = resolveCosts(s, TODAY, { catalog: {}, rates: [] });
  ok(r.legs.length === 2 && r.missing_legs === 2, 'T9 blank + unknown variant legs stay UNCOSTED, never vanish');
  ok(r.fees > 0, 'T9 their transaction is still billed a fee');
  ok(r.missing_variants.includes('999999999999') && !r.missing_variants.includes(''), 'T9 missing_variants names the ids it has');
  // settled upsell with NO variant: uncosted leg, fee still billed
  const c = { id: 'ux_nv', status: 'settled', amount: 25, line_items: [], created_at: `${TODAY}T11:00:00Z` };
  const r2 = resolveCosts(mkSession({}), TODAY, { catalog: {}, rates: [], charges: [c] });
  ok(r2.legs.some((l) => l.kind === 'upsell' && !l.variant_id && l.cost_known === false), 'T9 variant-less settled upsell = uncosted leg');
  ok(r2.transactions.length === 2, 'T9 …and its transaction still exists (fee not silently free)');
  // declined / $0 marker rows are skipped
  const r3 = resolveCosts(mkSession({}), TODAY, {
    catalog: {}, rates: [],
    charges: [{ id: 'ux_d', status: 'declined', amount: 0, line_items: [] }, { id: 'ux_0', status: 'settled', amount: 0, line_items: [] }],
  });
  ok(r3.legs.length === 1 && r3.transactions.length === 1, 'T9 declines and $0 markers produce no leg and no transaction');
}

// ═══ T10: the write door — validation + effective-from defaults (DB) ═══════
{
  let threw = null;
  try { await appendRate({ scope: 'variant', refId: V1, unitCogs: 'abc' }); } catch (e) { threw = e; }
  ok(threw instanceof CostError && threw.code === 'bad_amount', 'T10 unit_cogs "abc" → CostError bad_amount');
  threw = null;
  try { await appendRate({ scope: 'variant', refId: V1, unitCogs: -2 }); } catch (e) { threw = e; }
  ok(threw && threw.code === 'negative_amount', 'T10 negative unit_cogs refused');
  threw = null;
  try { await appendRate({ scope: 'variant', refId: V1 }); } catch (e) { threw = e; }
  ok(threw && threw.code === 'empty_rate', 'T10 all-null rate refused (must set unit_cogs or a ship value)');
  threw = null;
  try { await appendRate({ scope: 'variant', refId: 'DROP TABLE', unitCogs: 1 }); } catch (e) { threw = e; }
  ok(threw && threw.code === 'bad_variant_id', 'T10 free-text variant id refused');
  threw = null;
  try { await appendRate({ scope: 'variant', refId: V1, unitCogs: 1, ship: { main: '' } }); } catch (e) { threw = e; }
  ok(threw && threw.code === 'bad_amount', 'T10 blank-string ship value refused (blank must arrive as null)');

  // effective-from: first cost backdates to first sale; subsequent → today
  await sql`INSERT INTO lb_variant_costs (variant_id, first_sold) VALUES (${V1}, ${D(40)})
            ON CONFLICT (variant_id) DO UPDATE SET first_sold = ${D(40)}`;
  const r1 = await appendRate({ scope: 'variant', refId: V1, unitCogs: 3 });
  ok(r1.effective_from === D(40), `T10 FIRST rate backdates to first_sold (${r1.effective_from})`);
  const r2 = await appendRate({ scope: 'variant', refId: V1, unitCogs: 5 });
  ok(r2.effective_from === TODAY, 'T10 SUBSEQUENT rate defaults to today (edit ≠ restatement)');
  const r3 = await appendRate({ scope: 'variant', refId: V2, unitCogs: 2, onlyFromToday: true });
  ok(r3.effective_from === TODAY, 'T10 only_from_today pins a first rate to today');
  const r4 = await appendRate({ scope: 'variant', refId: V1, unitCogs: 4, effectiveFrom: D(10) });
  ok(r4.effective_from === D(10), 'T10 explicit effective_from always wins');
  ok(resolveEffectiveFrom({ explicit: null, onlyFromToday: false, hasPriorRate: false, firstSold: null, today: TODAY }) === '2000-01-01',
    'T10 first rate with no known first sale → epoch floor');
  // null stays null through the DB write (ship set, cogs blank)
  const r5 = await appendRate({ scope: 'variant', refId: V2, unitCogs: null, ship: { main: 1.5 } });
  const [row5] = await sql`SELECT unit_cogs, ship FROM lb_cost_rates WHERE id = ${r5.id}`;
  ok(row5.unit_cogs === null, 'T10 blank COGS lands as SQL NULL, never 0');
  ok(Number(row5.ship.main) === 1.5 && row5.ship.upsell === null, 'T10 ship map: set key persisted, unset keys null');
  // append-only: nothing above updated a row
  const n = await sql`SELECT COUNT(*)::int AS n FROM lb_cost_rates`;
  ok(n[0].n === 5, `T10 five writes → five rows, append-only (${n[0].n})`);
  const hist = await rateHistory(V1);
  ok(hist.length === 3 && hist[0].effective_from >= hist[1].effective_from, 'T10 history newest-first, complete audit trail');
  // coverage flipped by the write
  const [vc] = await sql`SELECT coverage FROM lb_variant_costs WHERE variant_id = ${V1}`;
  ok(vc.coverage === 'ready', 'T10 rate write flips coverage needs_cost → ready');
  await sql`DELETE FROM lb_cost_rates`;
  await sql`DELETE FROM lb_variant_costs`;
}

// ═══ T11: detect sweep — SOLD only, by_funnel split, operator columns ══════
{
  // f1: 2 sessions of V1 (2×$50 qty2 → $200 rev, 4 units); f2: 1 session of
  // V1 ($60 qty1) + upsell V2 $40. One old session outside 30d but in 90d.
  const mk = (id, fid, paidDaysAgo, lines, total) => sql`
    INSERT INTO co_sessions (id, funnel_id, status, line_items, total, currency, paid_at, created_at)
    VALUES (${id}, ${fid}, 'paid', ${sql.json(lines)}, ${total}, 'USD',
            ${new Date(Date.now() - paidDaysAgo * 86400000).toISOString()},
            ${new Date(Date.now() - paidDaysAgo * 86400000).toISOString()})`;
  await mk('s_e1', 'f1', 2, [{ variant_id: V1, quantity: 2, price: 50, product_title: 'Cream', variant_title: '2 Pack' }], 100);
  await mk('s_e2', 'f1', 5, [{ variant_id: V1, quantity: 2, price: 50, product_title: 'Cream' }], 100);
  await mk('s_e3', 'f2', 3, [{ variant_id: V1, quantity: 1, price: 60 }], 60);
  await mk('s_e4', 'f2', 60, [{ variant_id: V1, quantity: 3, price: 50 }], 150); // outside 30d, inside 90d
  await mk('s_e5', 'f2', 4, [{ variant_id: V3, quantity: 1, price: 80 }], 80);
  await sql`INSERT INTO co_upsell_charges (id, session_id, offer_id, charge_id, amount, status, line_items, created_at)
            VALUES ('ux_e1', 's_e3', 'up1', ${'v:' + V2}, 40, 'settled',
                    ${sql.json([{ variant_id: V2, quantity: 1, unit_price: 40, title: 'Upsell' }])},
                    ${new Date(Date.now() - 3 * 86400000).toISOString()})`;
  // a DECLINE marker must not become catalog revenue
  await sql`INSERT INTO co_upsell_charges (id, session_id, offer_id, charge_id, amount, status, line_items, created_at)
            VALUES ('ux_e2', 's_e1', 'up1', 'decline', 0, 'declined', '[]', NOW())`;
  // a PROCESSING session is intent, not money — must not be swept
  await sql`INSERT INTO co_sessions (id, funnel_id, status, line_items, total, created_at)
            VALUES ('s_e6', 'f1', 'processing', ${sql.json([{ variant_id: V1, quantity: 99, price: 50 }])}, 4950, NOW())`;

  const rep = await runDetectSweep({ days: 90 });
  ok(rep.variants === 3 && rep.inserted === 3, `T11 sweep found exactly the 3 SOLD variants (${rep.variants})`);
  const [v1] = await sql`SELECT * FROM lb_variant_costs WHERE variant_id = ${V1}`;
  ok(Number(v1.revenue_30d) === 260 && v1.units_30d === 5, `T11 V1 30d money: 100+100+60 (60d session excluded) (${v1.revenue_30d}/${v1.units_30d})`);
  ok(v1.first_sold === dayKey(new Date(Date.now() - 60 * 86400000)), 'T11 first_sold reaches back to the 90d window');
  const bf = v1.by_funnel;
  ok(Number(bf.f1.revenue_30d) === 200 && Number(bf.f2.revenue_30d) === 60,
    `T11 by_funnel split credits each funnel ONLY its own sessions (${JSON.stringify(bf)})`);
  ok(Number(bf.f1.revenue_30d) + Number(bf.f2.revenue_30d) === Number(v1.revenue_30d), 'T11 Σ splits == variant total (no double count)');
  const [v2] = await sql`SELECT * FROM lb_variant_costs WHERE variant_id = ${V2}`;
  ok(Number(v2.revenue_30d) === 40 && v2.kind_auto === 'upsell' && JSON.stringify(v2.contexts) === '["upsell"]',
    'T11 settled upsell detected with upsell context/kind');
  ok(v1.coverage === 'needs_cost', 'T11 uncosted variant lands needs_cost');

  // operator columns survive a re-sweep
  await patchVariant(V1, { kind_override: 'addon', pays_shipping: false });
  await patchVariant(V3, { ignored: true });
  const rep2 = await runDetectSweep({ days: 90 });
  const [v1b] = await sql`SELECT * FROM lb_variant_costs WHERE variant_id = ${V1}`;
  const [v3b] = await sql`SELECT * FROM lb_variant_costs WHERE variant_id = ${V3}`;
  ok(v1b.kind_override === 'addon' && v1b.pays_shipping === false, 'T11 re-sweep never touches operator columns');
  ok(v3b.coverage === 'ignored', 'T11 re-sweep never resets an operator ignore');
  ok(rep2.updated === 3 && rep2.inserted === 0, 'T11 re-run is idempotent (updates, no dupes)');
}

// ═══ T12: coverage summary — revenue_at_risk hand-computed fixture ═════════
{
  // state: V1 needs_cost rev 260; V2 needs_cost rev 40; V3 ignored rev 80.
  // Cost V2 → ready. Hand-computed: at_risk = 260; pct = ready 1 / live 2 = 50.
  await appendRate({ scope: 'variant', refId: V2, unitCogs: 12 });
  const cs = await coverageSummary();
  ok(cs.total === 3 && cs.ready === 1 && cs.needs_cost === 1 && cs.ignored === 1, `T12 counts ${JSON.stringify(cs)}`);
  ok(cs.revenue_at_risk_30d === 260, `T12 revenue_at_risk_30d = exactly V1's 30d revenue (${cs.revenue_at_risk_30d})`);
  ok(cs.units_at_risk_30d === 5, 'T12 units_at_risk beside it');
  ok(cs.coverage_pct === 50, `T12 coverage_pct excludes ignored from the denominator (${cs.coverage_pct})`);
  // grid + filters
  const grid = await listVariants({});
  ok(grid.items[0].variant_id === V1, 'T12 grid sorted by 30d revenue desc (worklist order)');
  ok(grid.items[0].resolved.unit_cogs === null, 'T12 grid row: unknown COGS resolves null (dash), not 0');
  const v2row = grid.items.find((r) => r.variant_id === V2);
  ok(v2row.resolved.unit_cogs === 12, 'T12 grid row: costed variant resolves today\'s rate');
  const byF = await listByFunnel();
  const f1 = byF.funnels.find((f) => f.funnel_id === 'f1');
  ok(f1 && f1.revenue_30d === 200, 'T12 by-funnel view credits f1 only its own $200');
}

// ═══ T13: fee settings — defaults, override, inherit ═══════════════════════
{
  const fs0 = await getFeeSettings();
  ok(fs0.default_pct === 6 && fs0.default_fixed === 0, 'T13 seeded default 6% + $0');
  ok(Object.keys(fs0.gateways).sort().join(',') === 'nmi,paypal,stripe,whop', 'T13 four rails seeded, present-but-null');
  const fs1 = await updateFeeSettings({ gateways: { stripe: { pct: 2.9, fixed: 0.3 } } }, 'test@local');
  ok(fs1.gateways.stripe.pct === 2.9, 'T13 stripe override stored');
  ok(resolveFeeRate(fs1, 'stripe').fixed === 0.3, 'T13 override resolves');
  ok(resolveFeeRate(fs1, 'whop').pct === 6, 'T13 null gateway inherits the default');
  ok(resolveFeeRate(fs1, 'unknown_rail').pct === 6, 'T13 unknown gateway falls to default');
  const partial = await updateFeeSettings({ gateways: { nmi: { pct: 3.5 } } }, 'test@local');
  ok(resolveFeeRate(partial, 'nmi').pct === 3.5 && resolveFeeRate(partial, 'nmi').fixed === 0, 'T13 partial override fills blanks from default');
  let threw = null;
  try { await updateFeeSettings({ default_pct: 5000 }); } catch (e) { threw = e; }
  ok(threw && threw.code === 'bad_pct', 'T13 pct 5000 refused (catastrophic fee guard)');
  await updateFeeSettings({ gateways: { stripe: null, nmi: null } }, 'test@local');
}

// ═══ T14: P&L on-read — INVARIANT 6 + spend tri-state ══════════════════════
{
  // f1 has V1 sessions (uncosted → gp null); cost V1 fully, then f1 gp real.
  const ov0 = await pnlOverview(D(7), TODAY);
  const f1r0 = ov0.rows.find((r) => r.fid === 'f1');
  ok(f1r0 && f1r0.gp === null && f1r0.gp_margin === null, 'T14 uncosted funnel: gp/margin WITHHELD (dash), never 100%');
  ok(f1r0.spend === null && f1r0.spend_known === false && f1r0.net_profit === null && f1r0.roas === null,
    'T14 no spend feed + no manual → spend null / spend_known false / net_profit null');
  ok(f1r0.revenue > 0 && f1r0.fees > 0, 'T14 revenue + fees still real beside the dash');

  await appendRate({ scope: 'variant', refId: V1, unitCogs: 10, ship: { default: 0 }, effectiveFrom: '2020-01-01' });
  const ov1 = await pnlOverview(D(7), TODAY);
  const f1r = ov1.rows.find((r) => r.fid === 'f1');
  // f1 window money: s_e1 + s_e2 = $200 revenue, 4 units V1 → cogs 40; fees 6% = 12
  ok(f1r.cogs === 40 && f1r.revenue === 200, `T14 f1 costed: cogs ${f1r.cogs} rev ${f1r.revenue}`);
  ok(f1r.gp === Math.round((200 - 40 - 0 - f1r.fees) * 100) / 100, 'T14 INVARIANT 6: gp = net_revenue − cogs − ship − fees');
  ok(f1r.cost_coverage_pct === 100, 'T14 coverage 100 once every leg is costed');
  ok(f1r.net_profit === null && f1r.spend_known === false, 'T14 gp real but spend UNKNOWN → net_profit still null');

  // manual spend makes spend known → net_profit = gp − spend
  await sql`INSERT INTO lb_ad_spend_daily (source, ref_id, day, spend) VALUES ('manual', 'f1', ${D(1)}, 50)`;
  const ov2 = await pnlOverview(D(7), TODAY);
  const f1r2 = ov2.rows.find((r) => r.fid === 'f1');
  ok(f1r2.spend === 50 && f1r2.spend_known === true, 'T14 manual row → spend known');
  ok(f1r2.net_profit === Math.round((f1r2.gp - 50) * 100) / 100, 'T14 net_profit = gp − spend ONLY now');
  ok(f1r2.roas === Math.round((200 / 50) * 100) / 100 && f1r2.cpa === 25, 'T14 roas/cpa computed off known spend');
  ok(ov2.rows[0].revenue >= ov2.rows[ov2.rows.length - 1].revenue, 'T14 rows sorted by revenue desc');
  ok(ov2.totals.spend_known === false, 'T14 totals spend stays unknown while ANY funnel is unknown');

  // funnel drill-in: daily series + manual entries
  const fp = await pnlFunnel('f1', D(7), TODAY);
  ok(fp.daily.length === 2 && fp.daily.every((d) => d.orders === 1), `T14 f1 daily series has both order days (${fp.daily.length})`);
  ok(fp.totals.gp !== null && fp.totals.spend === 50, 'T14 drill-in totals agree');
  ok(fp.manual_entries.length === 1 && fp.manual_entries[0].spend === 50, 'T14 manual entry listed');
  const dayWithSpend = fp.daily.find((d) => d.day === D(1));
  ok(!dayWithSpend || dayWithSpend.spend === 50, 'T14 day row carries its manual spend');

  // refund flows through: refund one session $30 → f1 revenue drops, cogs does not
  await sql`UPDATE co_sessions SET refunds = ${sql.json([{ id: 're_x', amount: 30 }])}, status = 'refunded' WHERE id = 's_e1'`;
  const ov3 = await pnlOverview(D(7), TODAY);
  const f1r3 = ov3.rows.find((r) => r.fid === 'f1');
  ok(f1r3.revenue === 170 && f1r3.cogs === 40 && f1r3.refunds === 30, 'T14 INVARIANT 5 at P&L level: refund nets top line, COGS/fees intact');
  ok(f1r3.gross_sales === 200, 'T14 gross_sales stays the captured money');

  // empty window
  const ovE = await pnlOverview('2019-01-01', '2019-01-07');
  ok(ovE.rows.length === 0 && ovE.totals.orders === 0 && ovE.totals.gp === null, 'T14 empty window → empty rows, gp withheld, no crash');
  // malformed range
  let threw = null;
  try { await pnlOverview('2026-13-01', TODAY); } catch (e) { threw = e; }
  ok(threw && threw.code === 'bad_day', 'T14 malformed start day refused');
  threw = null;
  try { await pnlOverview(TODAY, D(5)); } catch (e) { threw = e; }
  ok(threw && threw.code === 'bad_range', 'T14 inverted range refused');
}

console.log(`\nRESULT: ${pass} passed, ${fail} failed`);
await sql.end();
process.exit(fail ? 1 : 0);
