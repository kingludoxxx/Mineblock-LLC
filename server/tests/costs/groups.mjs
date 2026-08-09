// COST GROUPS + PROPOSALS — in-process verification against a scratch PG.
//
// Proves BY EXECUTION:
//   G1  the detection rule is exact stem equality — a shared PREFIX and a
//       2-edit neighbour do NOT link, a channel suffix DOES
//   G2  pack-size parsing (six rules, order is the contract) and Stage 0
//   G3  the four Stage-C cross-checks fire on their own thresholds
//   G4  RESOLUTION PRECEDENCE: an explicit variant rate BEATS the group rate,
//       and the group rate multiplies by units_per while shipping does not
//   G5  a group rate flows into the SAME P&L read path — the REAL engine's
//       margins move when a group rate lands, and move again when a variant
//       rate shadows it
//   G6  rates are APPEND-ONLY: an "edit" adds a row, the old row survives
//       verbatim, and history reads newest-first
//   G7  proposals detect off SEEDED ORDERS (through the real SOLD sweep),
//       accept creates a group and is idempotent, dismiss is idempotent AND
//       STICKY across a re-detect
//   G8  null-vs-0: unknown COGS stays null and WITHHOLDS gp; an explicit 0 is
//       a real answer that grants it
//
// ── CLOCK ──────────────────────────────────────────────────────────────────
// Every day fixture here comes from reportTz (Europe/Madrid), never from a
// UTC .toISOString().slice(0,10). The existing costs harnesses use
// funnelCosts.daysAgo, which is UTC, while the engine buckets in Madrid — so
// between 22:00 and 24:00 UTC their day keys are off by one and they flake.
// `onDay()` below anchors every seeded instant to MIDDAY of a REPORT day, so
// this file is correct at every hour and across both DST transitions.
//
// Run:  node server/tests/costs/groups.mjs
import postgres from 'postgres';

const DB = 'postgres://puure@127.0.0.1:5433/puure_cost_groups';
process.env.DATABASE_URL = DB;
process.env.NODE_ENV = 'development';
process.env.JWT_ACCESS_SECRET = process.env.JWT_ACCESS_SECRET || 'dev-access-secret-change-me';

let pass = 0, fail = 0;
const ok = (c, m, x = '') => { if (c) { pass++; console.log('PASS ', m); } else { fail++; console.log('FAIL ', m, x); } };

const admin = postgres('postgres://puure@127.0.0.1:5433/postgres', { ssl: false });
await admin`DROP DATABASE IF EXISTS puure_cost_groups`;
await admin`CREATE DATABASE puure_cost_groups`;
await admin.end();
const sql = postgres(DB, { ssl: false, onnotice: () => {} });

const {
  reportDayKey, reportDayStartIso, reportDaysAgo,
} = await import('../../src/services/reportTz.js');
const detect = await import('../../src/services/funnelCostGroupDetect.js');
const groups = await import('../../src/services/funnelCostGroups.js');
const costs = await import('../../src/services/funnelCosts.js');
const { ensureFunnelCostsTables } = await import('../../src/services/funnelCostsSchema.js');
const { ensureCheckoutTables } = await import('../../src/services/checkoutSchema.js');

// ── Report-tz day fixtures. MIDDAY of a report day is unambiguous at every
// hour of the wall clock and on both 23h/25h DST days.
const RDAY = (n) => reportDaysAgo(n);
const onDay = (day, hour = 12) =>
  new Date(Date.parse(reportDayStartIso(day)) + hour * 3600000).toISOString();

console.log(`\n── clock: report day ${reportDayKey()} · UTC ${new Date().toISOString()} ──\n`);

// ══════════════════════════════════════════════════════════════════════════
// G1-G3 — PURE. No DB, no clock.
// ══════════════════════════════════════════════════════════════════════════
console.log('── G1 exact stem equality ──');
{
  const s = detect.stem;
  ok(s('Puure Breast Lift') === 'puure breast lift', 'G1 plain title stems to itself, casefolded');
  ok(s('Puure Breast Lift - Downsell (en-dws2)') === s('Puure Breast Lift'),
    'G1 channel suffix "- Downsell (en-dws2)" strips', s('Puure Breast Lift - Downsell (en-dws2)'));
  ok(s('Puure Breast Lift - Upsell') === s('Puure Breast Lift'), 'G1 "- Upsell" strips');
  ok(s('Puure Breast Lift Upsell LegacyCheckout') === s('Puure Breast Lift'), 'G1 "Upsell LegacyCheckout" strips');
  ok(s('Puure Breast Lift (en-dws1)') === s('Puure Breast Lift'), 'G1 bare clone tag strips');
  // THE TRAPS. Every looser rule than exact equality merges these.
  ok(s('Acme Power Bank') !== s('Acme Power Kit'), 'G1 TRAP: shared prefix does NOT stem-match');
  ok(s('Widget Pro') !== s('Power Kit'), 'G1 TRAP: edit-distance-2 does NOT stem-match');
  ok(s('Puure Breast Lift') !== s('Puure Breast Serum'), 'G1 TRAP: sibling product does NOT stem-match');
  // A title that is ONLY a channel tag must not collapse to blank and link to
  // every other blank.
  ok(s('(en-dws1)') === '(en-dws1)', 'G1 tag-only title falls back, does not blank', s('(en-dws1)'));
}

console.log('\n── G2 pack size + Stage 0 ──');
{
  const P = (vt, pt = 'Some Product') => detect.parsePackSize({ variantTitle: vt, productTitle: pt });
  ok(P('1 Bottle').size === 1 && P('1 Bottle').rule === 'leading-int', 'G2 leading int "1 Bottle" → 1');
  ok(P('3 Bottles').size === 3, 'G2 leading int "3 Bottles" → 3');
  ok(P('Three Bottles').size === 3 && P('Three Bottles').rule === 'word', 'G2 number word "Three Bottles" → 3');
  const bogo = P('Buy 2 Get 1 Free (3 Bottles)');
  ok(bogo.size === 3 && bogo.confidence === 'review', 'G2 BOGO reconciles → 3, confidence review');
  const bad = P('Buy 2 Get 2 Free (3 Bottles)');
  ok(bad.size === null && bad.confidence === 'none', 'G2 BOGO that does NOT reconcile refuses a number');
  ok(P('Digital Download').is_digital === true, 'G2 digital flagged');
  ok(P('Default Title').is_service === true, 'G2 "Default Title" is a service');
  ok(P('Expedited', 'Expedited Shipping').is_service === true, 'G2 shipping upgrade is a service');
  // THE ONE THAT MATTERS: unknown is null, never a silent 1. A default of 1
  // on a "3 Pack" understates its COGS threefold on every unit sold.
  const unknown = P('Blue / Large');
  ok(unknown.size === null && unknown.confidence === 'none', 'G2 unreadable pack size is NULL, not 1');
  // Price must never be a size signal.
  ok(P('Bottle', 'Product $99.00').size === null, 'G2 price is never a pack-size signal');
  ok(detect.isExcluded(P('Digital Download')).excluded === true, 'G2 Stage 0 excludes digital');
  ok(detect.isExcluded(P('Default Title')).excluded === true, 'G2 Stage 0 excludes services');
  ok(detect.isExcluded(P('3 Bottles')).excluded === false, 'G2 Stage 0 keeps a real good');
}

console.log('\n── G3 Stage-C cross-checks ──');
{
  const mk = (o) => ({
    variant_id: o.vid, product_title: o.pt || 'Same Good', variant_title: o.vt,
    price: o.price ?? null, units_30d: 1, revenue_30d: 0, image_url: '',
    shopify_product_id: o.pid || '', coverage: 'needs_cost', contexts: [], funnels: [],
    cost_item_id: o.bound || null,
  });
  // Two DIFFERENT shopify products sharing an exact stem → linked → all four
  // checks run.
  const run = (rows) => detect.cluster(rows).proposals[0];

  // C2 same-tier: same pack size, per-unit prices 3.5x apart → contradiction.
  const tier = run([
    mk({ vid: '100000000001', vt: '1 Bottle', price: 10, pid: 'P1' }),
    mk({ vid: '100000000002', vt: '1 Bottle', price: 35, pid: 'P2' }),
  ]);
  const tierCheck = tier.checks.find((c) => c.code === 'price_ladder');
  ok(tierCheck && !tierCheck.ok, 'G3 C2 same-tier 3.5x per-unit spread FAILS', tierCheck && tierCheck.detail);
  // …and 2x does not (under the 3.0 threshold).
  const tierOk = run([
    mk({ vid: '100000000001', vt: '1 Bottle', price: 10, pid: 'P1' }),
    mk({ vid: '100000000002', vt: '1 Bottle', price: 20, pid: 'P2' }),
  ]);
  ok(tierOk.checks.find((c) => c.code === 'price_ladder').ok, 'G3 C2 same-tier 2x spread PASSES (threshold is 3.0)');

  // C2 ladder: a 3-pack at 12/unit above a 1-pack at 8/unit is a 50%
  // inversion → contradiction.
  const ladder = run([
    mk({ vid: '100000000001', vt: '1 Bottle', price: 8, pid: 'P1' }),
    mk({ vid: '100000000003', vt: '3 Bottles', price: 36, pid: 'P2' }),
  ]);
  ok(!ladder.checks.find((c) => c.code === 'price_ladder').ok, 'G3 C2 inverted ladder (12/u over 8/u) FAILS');
  // A rounding crumb must NOT fail — that is what the 1.15 tolerance is for.
  const crumb = run([
    mk({ vid: '100000000001', vt: '1 Bottle', price: 15.0, pid: 'P1' }),
    mk({ vid: '100000000003', vt: '3 Bottles', price: 45.0051, pid: 'P2' }),
  ]);
  ok(crumb.checks.find((c) => c.code === 'price_ladder').ok,
    'G3 C2 0.02% per-unit crumb PASSES (1.15 tolerance, not epsilon)');

  // C4 trailing noun — THE live over-merge: "1 Test Kit" vs "3 Testers".
  const noun = run([
    mk({ vid: '100000000001', vt: '1 Test Kit', price: 30, pid: 'P1' }),
    mk({ vid: '100000000003', vt: '3 Testers', price: 30, pid: 'P2' }),
  ]);
  const nounCheck = noun.checks.find((c) => c.code === 'trailing_noun');
  ok(nounCheck && !nounCheck.ok, 'G3 C4 "1 Test Kit" vs "3 Testers" FAILS (kit ≠ tester)', nounCheck && nounCheck.detail);
  ok(noun.confidence === 'review', 'G3 a failed check downgrades the proposal to review');
  ok(noun.members.length === 2, 'G3 a failed check NEVER drops a member');
  // Generic packaging words say nothing → no contradiction.
  const generic = run([
    mk({ vid: '100000000001', vt: '1 Pack', price: 10, pid: 'P1' }),
    mk({ vid: '100000000003', vt: '3 Boxes', price: 30, pid: 'P2' }),
  ]);
  ok(generic.checks.find((c) => c.code === 'trailing_noun').ok, 'G3 C4 generic nouns (pack/box) do not contradict');

  // C1 blocks the one-click when a size is unreadable.
  const unreadable = run([
    mk({ vid: '100000000001', vt: 'Blue', price: 10, pid: 'P1' }),
    mk({ vid: '100000000003', vt: '3 Bottles', price: 30, pid: 'P2' }),
  ]);
  ok(!unreadable.checks.find((c) => c.code === 'pack_sizes_parse').ok, 'G3 C1 unreadable pack size FAILS');
  ok(unreadable.blockers.some((b) => b.code === 'units_per_unknown'), 'G3 C1 raises a units_per_unknown blocker');
  ok(!unreadable.members_ready.includes('100000000001'), 'G3 a blocked member is not in members_ready');

  // A single Shopify product is ONE good by construction — cross-product
  // checks have nothing to contradict, and confidence is 'certain'.
  const single = run([
    mk({ vid: '100000000001', vt: '1 Bottle', price: 10, pid: 'P1' }),
    mk({ vid: '100000000003', vt: '3 Bottles', price: 30, pid: 'P1' }),
  ]);
  ok(single.linked === false && single.confidence === 'certain', 'G3 one Shopify product → certain, unlinked', single.confidence);
  ok(single.checks.length === 1, 'G3 unlinked cluster runs C1 only');

  // The prefix trap end-to-end: two products sharing "Acme Power" must
  // produce NO cross proposal.
  const trap = detect.cluster([
    mk({ vid: '100000000001', pt: 'Acme Power Bank', vt: '1 Bottle', price: 10, pid: 'P1' }),
    mk({ vid: '100000000002', pt: 'Acme Power Kit', vt: '1 Bottle', price: 500, pid: 'P2' }),
  ]);
  ok(trap.proposals.length === 0, 'G1/G3 TRAP: prefix-sharing products produce NO proposal', JSON.stringify(trap.proposals.map((p) => p.suggested_name)));
}

// ══════════════════════════════════════════════════════════════════════════
// DB from here down.
// ══════════════════════════════════════════════════════════════════════════
await ensureCheckoutTables();
await ensureFunnelCostsTables();

const VA = '900000000001'; // engine variant A — 1 unit of the group's good
const VB = '900000000003'; // engine variant B — 3 units (units_per 3)
const DAY = RDAY(1);       // a settled REPORT day, comfortably in the past

await sql`INSERT INTO co_sessions (id, funnel_id, status, line_items, total, refunds, paid_at, created_at)
  VALUES ('s_g1', 'f_g1', 'paid',
    ${sql.json([
    { variant_id: VA, quantity: 1, price: 100, product_title: 'Engine Widget', variant_title: '1 Bottle' },
    { variant_id: VB, quantity: 1, price: 250, product_title: 'Engine Widget', variant_title: '3 Bottles' },
  ])},
    350, ${sql.json([])}, ${onDay(DAY)}, ${onDay(DAY)})`;

// Build the catalog from the ORDERS through the real SOLD sweep.
const sweep = await costs.runDetectSweep({ days: 90 });
ok(sweep.variants >= 2, `G4 SOLD sweep built the catalog from orders (${sweep.variants} variants)`);

console.log('\n── G4/G5 resolution precedence through the REAL engine ──');

const pnlRow = async () => {
  const ov = await costs.pnlOverview(DAY, DAY);
  return ov.rows.find((r) => r.fid === 'f_g1');
};

// ── step 1: no costs at all → gp WITHHELD, never 100% margin ──
{
  const r = await pnlRow();
  ok(r && r.revenue === 350, `G5 step1 revenue lands (${r && r.revenue})`);
  ok(r.cogs === 0 && r.gp === null,
    `G5 step1 ZERO coverage → cogs 0 and gp WITHHELD (null), not a flattering number (gp=${JSON.stringify(r.gp)})`);
  ok(r.cost_coverage_pct === 0, 'G5 step1 cost_coverage_pct 0');
}

// ── step 2: bind both variants into ONE group ──
const created = await groups.createGroup({
  name: 'Engine Widget bottle',
  members: [{ variant_id: VA, units_per: 1 }, { variant_id: VB, units_per: 3 }],
  createdBy: 'harness',
});
const GID = created.group.cost_item_id;
ok(/^ci_[0-9a-z_-]{2,64}$/i.test(GID), `G4 group minted a ci_ id (${GID})`);
ok(created.bound.length === 2, 'G4 both variants bound');
{
  const [row] = await sql`SELECT cost_item_id, units_per FROM lb_variant_costs WHERE variant_id = ${VB}`;
  ok(String(row.cost_item_id) === GID && Number(row.units_per) === 3,
    'G4 MEMBERSHIP LIVES ON THE VARIANT ROW — the column the engine already reads');
}
{
  // Binding alone must not invent a cost.
  const r = await pnlRow();
  ok(r.cogs === 0 && r.gp === null, 'G4 binding a group with no rate does NOT create a cost');
}

// ── step 3: the GROUP rate lands → the REAL engine's margins move ──
await costs.appendRate({
  scope: 'item', refId: GID, unitCogs: 30, ship: { default: 0 },
  effectiveFrom: DAY, source: 'manual', createdBy: 'harness',
});
{
  const r = await pnlRow();
  // VA: 30 × units_per 1 = 30. VB: 30 × units_per 3 = 90. Total 120.
  ok(r.cogs === 120, `G5 GROUP RATE FLOWS INTO THE P&L: cogs 0 → 120 (${r.cogs})`);
  ok(r.gp !== null, 'G5 gp is granted once the cost side is answered');
  ok(r.gp === costs.round2(r.revenue - r.cogs - r.ship_cost - r.fees),
    `G5 gp identity holds (${r.gp} vs ${costs.round2(r.revenue - r.cogs - r.ship_cost - r.fees)})`);
  ok(r.cost_coverage_pct === 100, `G5 coverage 100% (${r.cost_coverage_pct})`);
  ok(r.ship_cost === 0, 'G5 an explicit ship 0 is a REAL answer (known free), not unknown');
}
{
  // units_per multiplies COGS but NOT shipping — the deliberate asymmetry.
  const rates = costs.buildRateIndex(await costs.loadRates());
  const [vcB] = await sql`SELECT * FROM lb_variant_costs WHERE variant_id = ${VB}`;
  const [cogsB, srcB] = costs.resolveUnitCogs(vcB, rates, DAY);
  const [shipB] = costs.resolveUnitShip(vcB, rates, DAY, 'main');
  ok(cogsB === 90 && srcB === 'item', `G4 group COGS × units_per 3 = 90, source 'item' (${cogsB}/${srcB})`);
  ok(shipB === 0, `G4 shipping is NOT multiplied by units_per (${shipB})`);
}

// ── step 4: an explicit VARIANT rate BEATS the group rate ──
await costs.appendRate({
  scope: 'variant', refId: VA, unitCogs: 10, ship: { default: 0 },
  effectiveFrom: DAY, source: 'manual', createdBy: 'harness',
});
{
  const rates = costs.buildRateIndex(await costs.loadRates());
  const [vcA] = await sql`SELECT * FROM lb_variant_costs WHERE variant_id = ${VA}`;
  const [cogsA, srcA] = costs.resolveUnitCogs(vcA, rates, DAY);
  ok(cogsA === 10 && srcA === 'variant',
    `G4 PRECEDENCE: explicit variant rate 10 BEATS group rate 30 (${cogsA}/${srcA})`);
  const r = await pnlRow();
  ok(r.cogs === 100, `G5 the P&L follows the same precedence: 120 → 100 (${r.cogs})`);
}
{
  // The shadow is per-FIELD: a variant rate that sets only ship must not
  // shadow the group's COGS.
  const V_SHIPONLY = '900000000005';
  await sql`INSERT INTO lb_variant_costs (variant_id, product_title, variant_title, cost_item_id, units_per, price, first_sold)
            VALUES (${V_SHIPONLY}, 'Engine Widget', '1 Bottle', ${GID}, 1, 100, ${DAY})`;
  await costs.appendRate({
    scope: 'variant', refId: V_SHIPONLY, unitCogs: null, ship: { default: 2 },
    effectiveFrom: DAY, source: 'manual', createdBy: 'harness',
  });
  const rates = costs.buildRateIndex(await costs.loadRates());
  const [vc] = await sql`SELECT * FROM lb_variant_costs WHERE variant_id = ${V_SHIPONLY}`;
  const [c, src] = costs.resolveUnitCogs(vc, rates, DAY);
  const [s] = costs.resolveUnitShip(vc, rates, DAY, 'main');
  ok(c === 30 && src === 'item', `G4 a ship-only variant rate does NOT shadow the group's COGS (${c}/${src})`);
  ok(s === 2, `G4 …while its ship DOES win (${s})`);
}

console.log('\n── G6 append-only history ──');
{
  const before = await sql`SELECT id, unit_cogs FROM lb_cost_rates WHERE scope = 'item' AND cost_item_id = ${GID} ORDER BY id`;
  // An "edit": a NEW row, effective from a LATER day.
  await costs.appendRate({
    scope: 'item', refId: GID, unitCogs: 44, ship: { default: 0 },
    effectiveFrom: RDAY(0), source: 'manual', note: 'supplier raised', createdBy: 'harness',
  });
  const after = await sql`SELECT id, unit_cogs FROM lb_cost_rates WHERE scope = 'item' AND cost_item_id = ${GID} ORDER BY id`;
  ok(after.length === before.length + 1, `G6 an edit APPENDS a row (${before.length} → ${after.length})`);
  ok(Number(after[0].unit_cogs) === 30 && after[0].id === before[0].id,
    'G6 the superseded row survives VERBATIM — nothing is rewritten in place');
  // …and the OLD day still prices at the OLD rate. This is the whole point:
  // editing a cost today cannot silently restate last quarter.
  const rates = costs.buildRateIndex(await costs.loadRates());
  const [vcB] = await sql`SELECT * FROM lb_variant_costs WHERE variant_id = ${VB}`;
  ok(costs.resolveUnitCogs(vcB, rates, DAY)[0] === 90, 'G6 the PAST day still prices at the OLD rate (90)');
  ok(costs.resolveUnitCogs(vcB, rates, RDAY(0))[0] === 132, 'G6 today prices at the NEW rate (44 × 3 = 132)');

  const hist = await groups.groupRateHistory(GID);
  ok(hist.items.length === after.length, `G6 history returns every group row (${hist.items.length})`);
  ok(hist.items[0].effective_from >= hist.items[hist.items.length - 1].effective_from, 'G6 history is newest-first');
  ok(hist.items.every((r) => r.scope === 'item' && r.cost_item_id === GID), 'G6 history is scoped to this group');
  // The variant's own history folds in its group's rows — "why is this
  // variant's cost what it is" stays answerable in one call.
  const vh = await costs.rateHistory(VA);
  ok(vh.some((r) => r.scope === 'item' && r.cost_item_id === GID), 'G6 a member\'s history folds in the group rows');
}

console.log('\n── G8 null-vs-0 discipline ──');
let G2ID = null;
{
  // A rate that says NOTHING is refused at the write door.
  let threw = null;
  try {
    await costs.appendRate({ scope: 'item', refId: GID, unitCogs: null, ship: null, createdBy: 'h' });
  } catch (e) { threw = e; }
  ok(threw && threw.code === 'empty_rate', 'G8 a rate setting neither cost nor ship is REFUSED', threw && threw.code);

  // A group whose rate leaves unit_cogs null → member cost UNKNOWN (null),
  // never 0, and the P&L withholds gp.
  const V_UNK = '900000000007';
  await sql`INSERT INTO co_sessions (id, funnel_id, status, line_items, total, refunds, paid_at, created_at)
    VALUES ('s_g2', 'f_g2', 'paid',
      ${sql.json([{ variant_id: V_UNK, quantity: 1, price: 80, product_title: 'Unknown Good', variant_title: '1 Bottle' }])},
      80, ${sql.json([])}, ${onDay(DAY)}, ${onDay(DAY)})`;
  await sql`INSERT INTO lb_variant_costs (variant_id, product_title, variant_title, price, first_sold, coverage)
            VALUES (${V_UNK}, 'Unknown Good', '1 Bottle', 80, ${DAY}, 'needs_cost')`;
  const g2 = await groups.createGroup({
    name: 'Unknown group',
    members: [{ variant_id: V_UNK, units_per: 1 }, { variant_id: VA, units_per: 1 }],
    createdBy: 'harness',
  });
  G2ID = g2.group.cost_item_id;
  // This create TOOK VA out of the engine group — and said so. A rebind is
  // never silent, because it changes which rate answers that variant.
  ok(g2.moved.some((m) => m.variant_id === VA && m.from === GID),
    `G8 taking VA from the engine group is REPORTED (${JSON.stringify(g2.moved)})`);
  // ship-only group rate: cost stays UNKNOWN.
  await costs.appendRate({
    scope: 'item', refId: g2.group.cost_item_id, unitCogs: null, ship: { default: 1 },
    effectiveFrom: DAY, source: 'manual', createdBy: 'harness',
  });
  const rates = costs.buildRateIndex(await costs.loadRates());
  const [vc] = await sql`SELECT * FROM lb_variant_costs WHERE variant_id = ${V_UNK}`;
  const [c] = costs.resolveUnitCogs(vc, rates, DAY);
  ok(c === null, `G8 unknown group COGS resolves to NULL, not 0 (${JSON.stringify(c)})`);
  const ov = await costs.pnlOverview(DAY, DAY);
  const r2 = ov.rows.find((r) => r.fid === 'f_g2');
  ok(r2 && r2.gp === null, `G8 the P&L WITHHOLDS gp on an unknown cost (${JSON.stringify(r2 && r2.gp)})`);
  ok(r2.missing_cogs_legs >= 1, `G8 …and counts the miss (${r2.missing_cogs_legs})`);

  // An explicit 0 is a DIFFERENT answer — known free, gp granted.
  await costs.appendRate({
    scope: 'item', refId: g2.group.cost_item_id, unitCogs: 0, ship: { default: 0 },
    effectiveFrom: DAY, source: 'manual', createdBy: 'harness',
  });
  const rates2 = costs.buildRateIndex(await costs.loadRates());
  const [vc2] = await sql`SELECT * FROM lb_variant_costs WHERE variant_id = ${V_UNK}`;
  ok(costs.resolveUnitCogs(vc2, rates2, DAY)[0] === 0, 'G8 an explicit 0 resolves to 0 (known free)');
  const ov2 = await costs.pnlOverview(DAY, DAY);
  const r3 = ov2.rows.find((r) => r.fid === 'f_g2');
  ok(r3 && r3.gp !== null, 'G8 known-free GRANTS gp — 0 and null are different answers');
  ok(r3.cogs === 0, `G8 …with cogs 0 (${r3.cogs})`);
}

console.log('\n── G4b membership lifecycle ──');
{
  // Unbinding takes the group's cost away — and the member falls back to
  // UNKNOWN, never to a stale number.
  await groups.removeMembers(GID, [VB]);
  const rates = costs.buildRateIndex(await costs.loadRates());
  const [vcB] = await sql`SELECT * FROM lb_variant_costs WHERE variant_id = ${VB}`;
  ok(vcB.cost_item_id === null && Number(vcB.units_per) === 1, 'G4b unbind clears the pointer and resets units_per');
  ok(costs.resolveUnitCogs(vcB, rates, DAY)[0] === null, 'G4b an unbound member falls back to UNKNOWN, not a stale cost');
  ok(vcB.coverage === 'needs_cost', `G4b …and coverage flips back to needs_cost (${vcB.coverage})`);
  await groups.addMembers(GID, [{ variant_id: VB, units_per: 3 }]);
  const [reb] = await sql`SELECT * FROM lb_variant_costs WHERE variant_id = ${VB}`;
  ok(String(reb.cost_item_id) === GID && reb.coverage === 'ready', 'G4b re-binding restores the cost and flips coverage to ready');

  // A rebind from another group is REPORTED, never silent.
  const other = await groups.createGroup({
    name: 'Other group', members: [{ variant_id: VA, units_per: 1 }, { variant_id: VB, units_per: 1 }], createdBy: 'h',
  });
  // Each member's reported provenance is its ACTUAL previous group — VA was
  // moved into G2ID by the null-vs-0 block above, VB is still in GID. A
  // blanket "they all came from GID" would have passed a wrong implementation.
  const fromOf = Object.fromEntries(other.moved.map((m) => [m.variant_id, m.from]));
  ok(other.moved.length === 2, `G4b both variants report a move (${JSON.stringify(other.moved)})`);
  ok(fromOf[VB] === GID, `G4b VB's provenance is the engine group (${fromOf[VB]})`);
  ok(fromOf[VA] === G2ID, `G4b VA's provenance is the group that took it earlier (${fromOf[VA]})`);
  // Put them back.
  await groups.addMembers(GID, [{ variant_id: VA, units_per: 1 }, { variant_id: VB, units_per: 3 }]);

  // DELETE is an archive + unbind; the RATE HISTORY SURVIVES.
  const ratesBefore = (await sql`SELECT id FROM lb_cost_rates WHERE cost_item_id = ${other.group.cost_item_id}`).length;
  const del = await groups.deleteGroup(other.group.cost_item_id, 'harness');
  ok(del.archived === true && del.rates_kept === true, 'G4b delete ARCHIVES rather than dropping the row');
  const ratesAfter = (await sql`SELECT id FROM lb_cost_rates WHERE cost_item_id = ${other.group.cost_item_id}`).length;
  ok(ratesAfter === ratesBefore, 'G4b deleting a group KEEPS its rate history (money history is never dropped)');
  const live = await groups.listGroups();
  ok(!live.items.some((g) => g.cost_item_id === other.group.cost_item_id), 'G4b an archived group leaves the live list');
  const all = await groups.listGroups({ includeArchived: true });
  ok(all.items.some((g) => g.cost_item_id === other.group.cost_item_id), 'G4b …but is still readable with include_archived');

  // Guards.
  const guard = async (fn) => { try { await fn(); return null; } catch (e) { return e.code; } };
  ok(await guard(() => groups.createGroup({ name: 'x', members: [{ variant_id: VA }] })) === 'too_few_members',
    'G4b a one-member group is refused');
  ok(await guard(() => groups.createGroup({ name: '', members: [{ variant_id: VA }, { variant_id: VB }] })) === 'name_required',
    'G4b a nameless group is refused');
  ok(await guard(() => groups.addMembers(GID, [{ variant_id: VA, units_per: 0 }])) === 'bad_units_per',
    'G4b units_per 0 is refused (it would zero a real cost)');
  ok(await guard(() => groups.addMembers(GID, [{ variant_id: VA, units_per: 1.5 }])) === 'bad_units_per',
    'G4b a fractional units_per is refused');
  ok(await guard(() => groups.addMembers('ci_nope_missing', [{ variant_id: VA }])) === 'group_not_found',
    'G4b binding into a non-existent group is refused');
  const ghost = await groups.addMembers(GID, [{ variant_id: '111111111111' }]);
  ok(ghost.missing.includes('111111111111'), 'G4b a variant with no catalog row is reported missing, never written as a ghost');

  // The group read surface labels a shadowed member rather than hiding it.
  const g = await groups.getGroup(GID);
  const mA = g.members.find((m) => m.variant_id === VA);
  ok(mA && mA.shadowed_by_variant_rate === true, 'G4b the group view LABELS a member shadowed by its own variant rate');
  ok(mA.cogs_source === 'variant', `G4b …and reports which layer answered (${mA && mA.cogs_source})`);
  ok(g.coverage.counts.ready >= 1, 'G4b the group carries its own coverage rollup');
}

console.log('\n── G7 proposals: detect on seeded orders, accept/dismiss ──');
{
  // Seed ORDERS for a real grouping plus the two traps, then let the SOLD
  // sweep build the catalog — the detector reads the catalog, never the
  // order tables directly.
  const LIFT1 = '910000000001';
  const LIFT3 = '910000000003';
  const LIFT_DWS = '910000000005'; // same good, arriving via a cloned downsell page
  const SERUM = '910000000007';    // sibling product — must NOT link
  const DIGITAL = '910000000009';  // Stage 0 exclusion
  const line = (vid, pt, vt, price) => ({ variant_id: vid, quantity: 1, price, product_title: pt, variant_title: vt });
  await sql`INSERT INTO co_sessions (id, funnel_id, status, line_items, total, refunds, paid_at, created_at)
    VALUES ('s_g3', 'f_g3', 'paid', ${sql.json([
    line(LIFT1, 'Puure Breast Lift', '1 Bottle', 60),
    line(LIFT3, 'Puure Breast Lift', '3 Bottles', 150),
    line(LIFT_DWS, 'Puure Breast Lift - Downsell (en-dws2)', '2 Bottles', 100),
    line(SERUM, 'Puure Breast Serum', '1 Bottle', 55),
    line(DIGITAL, 'Puure Guide', 'Digital Download', 9),
  ])}, 374, ${sql.json([])}, ${onDay(DAY)}, ${onDay(DAY)})`;
  await costs.runDetectSweep({ days: 90 });

  const run1 = await detect.detectProposals();
  ok(run1.variants_scanned >= 5, `G7 detect scanned the catalog (${run1.variants_scanned})`);
  ok(run1.excluded >= 1, `G7 Stage 0 excluded the digital good (${run1.excluded})`);

  const list1 = await detect.listProposals({ status: 'open' });
  const lift = list1.items.find((p) => p.members.some((m) => m.variant_id === LIFT1));
  ok(Boolean(lift), 'G7 a proposal covers the Breast Lift variants');
  const liftIds = lift.members.map((m) => m.variant_id).sort();
  ok(liftIds.includes(LIFT1) && liftIds.includes(LIFT3) && liftIds.includes(LIFT_DWS),
    `G7 the downsell-suffixed clone joins the same proposal (${liftIds.join(',')})`);
  ok(!liftIds.includes(SERUM), 'G7 TRAP: the sibling "Serum" is NOT in the proposal');
  ok(!liftIds.includes(DIGITAL), 'G7 the digital good is not a member');
  ok(!list1.items.some((p) => p.members.some((m) => m.variant_id === DIGITAL)),
    'G7 the digital good appears in NO proposal');
  // Pack sizes came off the VARIANT titles.
  const sizes = Object.fromEntries(lift.members.map((m) => [m.variant_id, m.units_per]));
  ok(sizes[LIFT1] === 1 && sizes[LIFT3] === 3 && sizes[LIFT_DWS] === 2,
    `G7 pack sizes parsed per member (${JSON.stringify(sizes)})`);

  // IDEMPOTENCY: a second detect must not duplicate.
  const countAfter1 = (await sql`SELECT COUNT(*)::int AS n FROM lb_cost_group_proposals`)[0].n;
  const run2 = await detect.detectProposals();
  const countAfter2 = (await sql`SELECT COUNT(*)::int AS n FROM lb_cost_group_proposals`)[0].n;
  ok(countAfter1 === countAfter2, `G7 re-running detect does NOT duplicate proposals (${countAfter1} → ${countAfter2})`);
  ok(run2.dropped_stale === 0, 'G7 a stable estate reaps no phantoms');

  // DISMISS — idempotent, and STICKY across a re-detect.
  const victim = list1.items.find((p) => p.proposal_id !== lift.proposal_id);
  ok(Boolean(victim), 'G7 there is a second proposal to dismiss');
  const d1 = await detect.dismissProposal(victim.proposal_id, { reason: 'not the same good', actor: 'harness' });
  ok(d1.status === 'dismissed', 'G7 dismiss returns dismissed');
  const d2 = await detect.dismissProposal(victim.proposal_id, { reason: 'again', actor: 'harness' });
  ok(d2.status === 'dismissed', 'G7 dismiss is IDEMPOTENT');
  await detect.detectProposals();
  const stillDismissed = await detect.getProposal(victim.proposal_id);
  ok(stillDismissed.status === 'dismissed', 'G7 a dismissal SURVIVES a re-detect (sticky suppression)');
  ok(!(await detect.listProposals({ status: 'open' })).items.some((p) => p.proposal_id === victim.proposal_id),
    'G7 a dismissed proposal is out of the open worklist');
  ok((await detect.listProposals({ status: 'dismissed' })).items.some((p) => p.proposal_id === victim.proposal_id),
    'G7 …and readable under status=dismissed');
  // The escape hatch.
  await detect.reopenProposal(victim.proposal_id);
  ok((await detect.getProposal(victim.proposal_id)).status === 'open', 'G7 reopen undoes a mis-click');
  await detect.dismissProposal(victim.proposal_id, { actor: 'harness' });

  // ACCEPT — the proposal becomes a group.
  const acc = await detect.acceptProposal(lift.proposal_id, { actor: 'harness' });
  ok(acc.status === 'accepted' && acc.group && acc.group.cost_item_id, 'G7 accept creates a group');
  ok(acc.group.member_count === lift.members_ready.length,
    `G7 accept binds exactly members_ready (${acc.group.member_count}/${lift.members_ready.length})`);
  {
    const [row] = await sql`SELECT cost_item_id, units_per FROM lb_variant_costs WHERE variant_id = ${LIFT3}`;
    ok(String(row.cost_item_id) === acc.group.cost_item_id && Number(row.units_per) === 3,
      'G7 accept carried the detected units_per onto the membership');
  }
  // Accepting creates NO cost.
  ok(acc.group.rate === null, 'G7 accepting creates NO rate — the group is still uncosted');
  {
    const [n] = await sql`SELECT COUNT(*)::int AS n FROM lb_cost_rates WHERE cost_item_id = ${acc.group.cost_item_id}`;
    ok(n.n === 0, 'G7 …and no rate row exists for it');
  }
  // ACCEPT IDEMPOTENCY: a double-click must not mint a second group over the
  // same variants (the second bind would steal them from the first).
  let re = null;
  try { await detect.acceptProposal(lift.proposal_id, { actor: 'harness' }); } catch (e) { re = e; }
  ok(re && re.code === 'already_accepted', `G7 accepting twice is REFUSED (${re && re.code})`);
  const groupCount = (await sql`SELECT COUNT(*)::int AS n FROM lb_cost_items`)[0].n;
  await detect.detectProposals();
  ok((await sql`SELECT COUNT(*)::int AS n FROM lb_cost_items`)[0].n === groupCount,
    'G7 a re-detect after acceptance mints no extra group');
  ok((await detect.getProposal(lift.proposal_id)).status === 'accepted', 'G7 an acceptance survives a re-detect');

  // And the accepted group works end-to-end: one rate, every member costed.
  await costs.appendRate({
    scope: 'item', refId: acc.group.cost_item_id, unitCogs: 5, ship: { default: 0 },
    effectiveFrom: DAY, source: 'manual', createdBy: 'harness',
  });
  const rates = costs.buildRateIndex(await costs.loadRates());
  const [v1] = await sql`SELECT * FROM lb_variant_costs WHERE variant_id = ${LIFT1}`;
  const [v3] = await sql`SELECT * FROM lb_variant_costs WHERE variant_id = ${LIFT3}`;
  ok(costs.resolveUnitCogs(v1, rates, DAY)[0] === 5, 'G7 ONE rate costs the 1-bottle member at 5');
  ok(costs.resolveUnitCogs(v3, rates, DAY)[0] === 15, 'G7 …and the 3-bottle member at 15 (× units_per)');
  const ov = await costs.pnlOverview(DAY, DAY);
  const r = ov.rows.find((x) => x.fid === 'f_g3');
  ok(r && r.cogs > 0, `G7 the accepted group's rate reaches the P&L (cogs ${r && r.cogs})`);
}

console.log('\n── G9 route surface (real router, real auth) ──');
{
  await sql`CREATE TABLE IF NOT EXISTS users (
    id TEXT PRIMARY KEY, email TEXT, first_name TEXT, last_name TEXT,
    must_change_password BOOLEAN DEFAULT FALSE, email_verified BOOLEAN DEFAULT TRUE,
    is_active BOOLEAN DEFAULT TRUE)`;
  await sql`CREATE TABLE IF NOT EXISTS roles (id TEXT PRIMARY KEY, name TEXT, permissions JSONB)`;
  await sql`CREATE TABLE IF NOT EXISTS user_roles (user_id TEXT, role_id TEXT)`;
  await sql`INSERT INTO users (id, email, first_name, last_name) VALUES ('u_cg', 'cg@local.test', 'CG', 'Tester')
            ON CONFLICT (id) DO NOTHING`;
  await sql`INSERT INTO roles (id, name, permissions) VALUES ('r_cg', 'cg-tester', '{"funnels": ["access"]}')
            ON CONFLICT (id) DO NOTHING`;
  await sql`INSERT INTO user_roles (user_id, role_id) VALUES ('u_cg', 'r_cg')`;

  const express = (await import('express')).default;
  const jwt = (await import('jsonwebtoken')).default;
  const router = (await import('../../src/routes/funnelCostGroups.js')).default;
  const app = express();
  app.use(express.json());
  app.use('/api/v1/funnel-cost-groups', router);
  const server = app.listen(0);
  const B = `http://127.0.0.1:${server.address().port}/api/v1/funnel-cost-groups`;
  const token = jwt.sign({ userId: 'u_cg' }, process.env.JWT_ACCESS_SECRET, { expiresIn: '10m' });
  const H = { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' };
  const req = async (method, path, body, headers = H) => {
    const r = await fetch(`${B}${path}`, {
      method, headers, body: body === undefined ? undefined : JSON.stringify(body),
    });
    let j = null;
    try { j = JSON.parse(await r.text()); } catch { /* non-JSON */ }
    return { status: r.status, j };
  };

  // The guard is real.
  ok((await req('GET', '/', undefined, { 'Content-Type': 'application/json' })).status === 401,
    'G9 unauthenticated → 401');

  const list = await req('GET', '/');
  ok(list.status === 200 && list.j.success === true && Array.isArray(list.j.data.items),
    `G9 GET / → {success,data:{items}} (${list.status})`);

  const props = await req('GET', '/proposals?status=all&limit=50');
  ok(props.status === 200 && Array.isArray(props.j.data.items), 'G9 GET /proposals answers');
  ok((await req('GET', '/proposals?status=bogus')).status === 422, 'G9 a bad status is 422');

  const det = await req('POST', '/proposals/detect', {});
  ok(det.status === 200 && typeof det.j.data.open === 'number', 'G9 POST /proposals/detect answers');

  // Create → read → patch → members → history → delete, over HTTP.
  const mk = await req('POST', '/', {
    name: 'Route group', members: [{ variant_id: VA, units_per: 1 }, { variant_id: VB, units_per: 2 }],
  });
  ok(mk.status === 201 && mk.j.data.group.cost_item_id, `G9 POST / → 201 with a group (${mk.status})`);
  const RID = mk.j.data.group.cost_item_id;
  ok((await req('GET', `/${RID}`)).j.data.group.member_count === 2, 'G9 GET /:id returns the members');
  ok((await req('PATCH', `/${RID}`, { name: 'Renamed' })).j.data.group.name === 'Renamed', 'G9 PATCH /:id renames');
  ok((await req('PATCH', `/${RID}`, { member_count: 9 })).status === 422, 'G9 PATCH rejects a non-identity field');
  ok((await req('POST', '/', { name: 'x', members: 'nope' })).status === 422, 'G9 a non-array members is 422');
  ok((await req('POST', '/', { name: 'x', members: [{ variant_id: VA }] })).status === 422, 'G9 a one-member group is 422');
  ok((await req('GET', `/${RID}/history`)).j.data.items.length === 0, 'G9 GET /:id/history is empty before any rate');
  const rm = await req('DELETE', `/${RID}/members/${VB}`);
  ok(rm.status === 200 && rm.j.data.removed.includes(VB), 'G9 DELETE /:id/members/:vid unbinds one');
  const del = await req('DELETE', `/${RID}`);
  ok(del.status === 200 && del.j.data.archived === true && del.j.data.rates_kept === true,
    'G9 DELETE /:id archives and keeps rates');
  ok((await req('GET', '/ci_does_not_exist')).status === 422, 'G9 an unknown group is 422 with a code');
  ok((await req('POST', '/proposals/not_an_id/dismiss', {})).status === 422, 'G9 a malformed proposal id is 422');

  server.close();
}

console.log(`\nRESULT: ${pass} passed, ${fail} failed`);
await sql.end();
process.exit(fail ? 1 : 0);
