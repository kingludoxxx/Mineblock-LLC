#!/usr/bin/env node
// verifyCostsUi.mjs — client-logic harness for the costs lane (costs lane).
//
// Pins the pure logic the review bar cares about, WITHOUT a browser:
//   · null-vs-zero on every parse/format path (blank→null payload, 0 gated
//     behind known-free, null renders a dash, 0 renders $0.00)
//   · rate-body snapshot semantics (ship carried on a cogs save, cogs carried
//     on a ship save, no effective_from pinned)
//   · fee-settings body shaping (blank pair → null, never {0,0})
//   · costsApi request shaping against a monkey-patched axios instance (the
//     module and the patch share one object, so no network is touched)
//
// Run:  cd client && node scripts/verifyCostsUi.mjs
// Exits non-zero on the first failure. No network, no DOM.
import {
  buildFeeSettingsBody, buildInlineRateBody, buildInlineShipBody, computeCoverage,
  computeMargin, EM_DASH, fmtMoney, fmtMoney0, fmtPct, fmtX, formatCost, hasShipMap,
  matchesFilter, parseCostInput, parseManualSpend, resolveFanOutTargets, resolveShip,
  rowCoverage, toFeeDraft, uncostedRevenue, utcDay,
} from '../src/pages/costs/costTargets.js';

import api from '../src/services/api.js';
import {
  COSTS_ROUTES, GATEWAYS, costApiError, dailyOf, fetchPnlOverview, fetchVariants,
  manualOf, postDetect, postManualSpend, postRate, postSpendSync, rowsOf, sourcesOf,
  unwrap,
} from '../src/pages/costs/costsApi.js';

let passed = 0;
let failed = 0;
const eq = (name, got, want) => {
  const g = JSON.stringify(got);
  const w = JSON.stringify(want);
  if (g === w) { passed += 1; return; }
  failed += 1;
  console.error(`✗ ${name}\n    got:  ${g}\n    want: ${w}`);
};
const ok = (name, cond) => {
  if (cond) { passed += 1; return; }
  failed += 1;
  console.error(`✗ ${name}`);
};

/* ── 1. parseCostInput: blank ≠ zero, forever ─────────────────────────── */
eq('blank clears to null (never 0)', parseCostInput(''), { value: null, error: null, cleared: true });
eq('whitespace clears to null', parseCostInput('   '), { value: null, error: null, cleared: true });
eq('a typed 0 is refused', parseCostInput('0').error, 'zero_requires_known_free');
eq('known-free is the one door to 0', parseCostInput('anything', { knownFree: true }),
  { value: 0, error: null, cleared: false });
eq('negative refused', parseCostInput('-1').error, 'negative');
eq('junk refused', parseCostInput('abc').error, 'not_a_number');
eq('a real number parses', parseCostInput('3.20').value, 3.2);

/* ── 2. formatCost / fmtMoney: unknown renders a dash, 0 renders $0.00 ── */
eq('formatCost(null) is an unknown dash', formatCost(null), { state: 'unknown', text: EM_DASH });
eq('formatCost(undefined) is unknown', formatCost(undefined).state, 'unknown');
eq('formatCost("") is unknown', formatCost('').state, 'unknown');
eq('formatCost(0) is free $0.00', formatCost(0), { state: 'free', text: '$0.00' });
eq('formatCost(3.2) is a value', formatCost(3.2), { state: 'value', text: '$3.20' });
eq('fmtMoney(null) → dash', fmtMoney(null), EM_DASH);
eq('fmtMoney(NaN) → dash', fmtMoney(NaN), EM_DASH);
eq('fmtMoney(0) → $0.00', fmtMoney(0), '$0.00');
eq('fmtMoney0(null) → dash', fmtMoney0(null), EM_DASH);
eq('fmtPct(null) → dash', fmtPct(null), EM_DASH);
eq('fmtX(null) → dash', fmtX(null), EM_DASH);

/* ── 3. resolveShip: null-aware fall-through ──────────────────────────── */
eq('explicit 0 on the context wins', resolveShip({ main: 0, default: 5 }, 'main'), 0);
eq('null context falls to default', resolveShip({ main: null, default: 5 }, 'main'), 5);
eq('0 default is a real answer', resolveShip({ main: null, default: 0 }, 'main'), 0);
eq('both absent → unknown', resolveShip({ main: null, default: null }, 'main'), null);
eq('no ship map → unknown', resolveShip(null, 'main'), null);

/* ── 4. margin withholding: never 100% off an unknown ─────────────────── */
const noCost = { price: 50, unit_cogs: null, ship: {}, contexts: ['main'], requires_shipping: true };
eq('no COGS → margin null (never 100)', computeMargin(noCost), null);
eq('no COGS → coverage none', rowCoverage(noCost), 'none');
const shipsUnknown = { price: 50, unit_cogs: 10, ship: {}, contexts: ['main'], requires_shipping: true };
eq('ships + ship unknown → margin null', computeMargin(shipsUnknown), null);
eq('ships + ship unknown → coverage partial', rowCoverage(shipsUnknown), 'partial');
const full = { price: 50, unit_cogs: 10, ship: { main: 5 }, contexts: ['main'], requires_shipping: true };
eq('full row → real margin', computeMargin(full), 70);
const knownFreeRow = { price: 50, unit_cogs: 0, ship: { main: 0 }, contexts: ['main'], requires_shipping: true };
eq('known-free row → 100 is EARNED here (explicit 0s)', computeMargin(knownFreeRow), 100);
const noShipLeg = { price: 50, unit_cogs: 10, ship: {}, contexts: ['upsell'], requires_shipping: false };
eq('non-shipping row needs no ship figure', computeMargin(noShipLeg), 80);

/* ── 5. coverage + at-risk revenue ────────────────────────────────────── */
const rows = [
  { variant_id: '1', unit_cogs: 10, ship: { main: 1 }, contexts: ['main'], requires_shipping: true, revenue_30d: 100, coverage: 'ready' },
  { variant_id: '2', unit_cogs: null, ship: {}, contexts: ['main'], requires_shipping: true, revenue_30d: 250, coverage: 'needs_cost' },
  { variant_id: '3', unit_cogs: null, ship: {}, contexts: ['main'], requires_shipping: true, revenue_30d: 999, coverage: 'ignored' },
];
eq('coverage excludes ignored from denominator', computeCoverage(rows), { costed: 1, total: 2, pct: 50 });
eq('uncosted revenue counts only live needs-cost rows', uncostedRevenue(rows), 250);
eq('filter all hides ignored', matchesFilter(rows[2], 'all'), false);
eq('filter ignored shows ignored', matchesFilter(rows[2], 'ignored'), true);

/* ── 6. rate bodies are SNAPSHOTS, and null survives to the wire ──────── */
const row = { variant_id: '111', unit_cogs: 4.5, ship: { main: 2, upsell: null } };
const { body: cogsBody } = buildInlineRateBody(row, null);
eq('clearing a cost sends null (never 0)', cogsBody.unit_cogs, null);
eq('a cogs save carries the ship map forward', cogsBody.ship, { main: 2, upsell: null });
ok('inline body pins no effective_from', !('effective_from' in cogsBody) && !('only_from_today' in cogsBody));
const { body: shipBody } = buildInlineShipBody(row, 'upsell', 0);
eq('a ship save carries unit_cogs forward', shipBody.unit_cogs, 4.5);
eq('an explicit ship 0 survives (known free leg)', shipBody.ship.upsell, 0);
const { body: shipClear } = buildInlineShipBody({ ...row, unit_cogs: null }, 'main', null);
eq('unknown cogs stays null on a ship save', shipClear.unit_cogs, null);
eq('clearing a ship leg sends null', shipClear.ship.main, null);

/* ── 6b. THE SHIP WRITE-GUARD (contract v2 B4) ────────────────────────── */
const noShipRow = { variant_id: '222', unit_cogs: 3 }; // ship map missing entirely
eq('cogs save on a shipless row is REFUSED', buildInlineRateBody(noShipRow, 7),
  { error: 'missing_ship_map' });
eq('ship save on a shipless row is REFUSED', buildInlineShipBody(noShipRow, 'main', 4),
  { error: 'missing_ship_map' });
eq('null ship map is refused too', buildInlineRateBody({ variant_id: '2', ship: null }, 7),
  { error: 'missing_ship_map' });
ok('hasShipMap: {} IS a ship map (present, empty is the row truth)', hasShipMap({ ship: {} }));
ok('hasShipMap: missing/null are not', !hasShipMap({}) && !hasShipMap({ ship: null }) && !hasShipMap(null));
const { body: verbatim } = buildInlineRateBody({ variant_id: '3', unit_cogs: null, ship: { main: 4 } }, 9);
eq('a row with ship {main:4} carries main:4 verbatim', verbatim.ship, { main: 4 });
ok('refused bodies produce NO body key', !('body' in buildInlineRateBody(noShipRow, 7)));

/* ── 7. fee settings: blank = inherit (null), never {0,0} ─────────────── */
const feeDraft = {
  pct: '6', fixed: '0.30',
  gateways: {
    whop: { pct: '', fixed: '' },       // untouched → null
    stripe: { pct: '2.9', fixed: '' },  // partial → {pct:2.9, fixed:null}
    paypal: { pct: '0', fixed: '0' },   // genuinely free rail → pinned zeros
    nmi: { pct: '', fixed: '' },
  },
};
const feeBody = buildFeeSettingsBody(feeDraft, GATEWAYS);
eq('both blank → null (clears override)', feeBody.gateways.whop, null);
eq('partial override keeps blank half null', feeBody.gateways.stripe, { pct: 2.9, fixed: null });
eq('typed zeros pin a free rail', feeBody.gateways.paypal, { pct: 0, fixed: 0 });
eq('default shape', feeBody.default, { pct: 6, fixed: 0.3 });
ok('negative fee throws', (() => {
  try { buildFeeSettingsBody({ ...feeDraft, pct: '-1' }, GATEWAYS); return false; } catch { return true; }
})());
ok('blank required default throws', (() => {
  try { buildFeeSettingsBody({ ...feeDraft, pct: '' }, GATEWAYS); return false; } catch { return true; }
})());

/* ── 8. manual spend: 0 is real, blank is refused ─────────────────────── */
eq('manual spend 0 is a real claim', parseManualSpend('0'), { value: 0, error: null });
eq('manual spend blank is refused', parseManualSpend('').error, 'empty');
eq('manual spend negative refused', parseManualSpend('-3').error, 'negative');

/* ── 8b. UTC day keys (contract v2 M7) — the 23:50Z fixture ───────────── */
eq('23:50Z stays the SAME UTC day (CEST would say next-day)',
  utcDay('2026-08-09T23:50:00Z'), '2026-08-09');
eq('00:10Z stays the same UTC day', utcDay('2026-08-10T00:10:00Z'), '2026-08-10');
eq('a +02:00 local instant converts to its UTC day',
  utcDay('2026-08-10T01:30:00+02:00'), '2026-08-09');
eq('utcDay of junk is empty, never a wrong day', utcDay('not-a-date'), '');
eq('utcDay of a Date object works', utcDay(new Date('2026-01-01T23:59:59Z')), '2026-01-01');

/* ── 8c. fee nested shape round-trip (contract v2 B5) ─────────────────── */
const serverFees = {
  default: { pct: 6, fixed: 0.3 },
  gateways: { whop: null, stripe: { pct: 2.9, fixed: null }, paypal: { pct: 0, fixed: 0 }, nmi: null },
  updated_at: '2026-08-09T10:00:00Z',
};
const roundTrip = buildFeeSettingsBody(toFeeDraft(serverFees, GATEWAYS), GATEWAYS);
eq('GET → draft → PATCH round-trips the nested shape', roundTrip, {
  default: { pct: 6, fixed: 0.3 },
  gateways: { whop: null, stripe: { pct: 2.9, fixed: null }, paypal: { pct: 0, fixed: 0 }, nmi: null },
});
eq('toFeeDraft keeps a stored 0 visible as "0", null as blank',
  toFeeDraft(serverFees, GATEWAYS).gateways.paypal, { pct: '0', fixed: '0' });
eq('toFeeDraft of an empty payload seeds the defaults',
  [toFeeDraft(null, GATEWAYS).pct, toFeeDraft(null, GATEWAYS).gateways.whop.pct], ['6', '']);

/* ── 9. fan-out ───────────────────────────────────────────────────────── */
const v1 = { variant_id: 'a', cost_item_id: 'g1', cogs_source: 'item', funnels: ['f1'], units_30d: 5, product_title: 'P', variant_title: 'A' };
const v2 = { variant_id: 'b', cost_item_id: 'g1', cogs_source: 'variant', funnels: ['f2'], units_30d: 9, product_title: 'P', variant_title: 'B' };
const fanVariant = resolveFanOutTargets({ row: v1, rows: [v1, v2], scope: 'variant' });
eq('variant scope touches exactly one row', fanVariant.affected.length, 1);
eq('variant scope never crosses funnels', fanVariant.crossFunnel, false);
const fanItem = resolveFanOutTargets({ row: v1, rows: [v1, v2], scope: 'item' });
eq('item scope lists the whole group', fanItem.targets.length, 2);
eq('own-rate rows are shadowed, not moved', fanItem.shadowed.map((t) => t.variant_id), ['b']);
// A shadowed row's funnels are NOT "reached" — its resolved cost does not
// move — so crossFunnel is false here…
eq('shadowed rows do not count as cross-funnel reach', fanItem.crossFunnel, false);
// …and true only when a genuinely-affected group member sits on another funnel.
const v3 = { ...v2, cogs_source: 'item' };
const fanItemLive = resolveFanOutTargets({ row: v1, rows: [v1, v3], scope: 'item' });
eq('item scope names cross-funnel reach', fanItemLive.crossFunnel, true);

/* ── 10. the envelope unwrap (contract v2 B1) ─────────────────────────── */
eq('unwrap peels {success,data}', unwrap({ data: { success: true, data: { items: [1] } } }), { items: [1] });
eq('unwrap passes a bare body through', unwrap({ data: { items: [2] } }), { items: [2] });
eq('unwrap of {success,data:null} yields the bare body (?? not ||)',
  unwrap({ data: { success: true, data: null } }), { success: true, data: null });
eq('unwrap tolerates an empty response', unwrap({ data: undefined }), undefined);
eq('unwrap does NOT double-unwrap a payload that itself has data',
  unwrap({ data: { success: true, data: { data: 'inner' } } }), { data: 'inner' });

/* ── 10b. costsApi request shaping (monkey-patched axios instance) ────── */
const calls = [];
const record = (method) => (url, a, b) => {
  calls.push({ method, url, a, b });
  // The house envelope, exactly as the wire carries it — every fetcher must
  // hand back the unwrapped payload.
  return Promise.resolve({ data: { success: true, data: { echoed: true } } });
};
api.get = record('get');
api.post = record('post');
api.patch = record('patch');
api.delete = record('delete');

const variantsRes = await fetchVariants({ limit: 500, coverage: 'needs_cost' });
eq('GET /variants path', calls.at(-1).url, '/funnel-costs/variants');
eq('GET /variants params ride in config', calls.at(-1).a, { params: { limit: 500, coverage: 'needs_cost' } });
eq('fetcher returns the UNWRAPPED payload', variantsRes, { echoed: true });

await postRate({ scope: 'variant', variant_id: '9', unit_cogs: null, ship: { main: null } });
eq('POST /rates path', calls.at(-1).url, '/funnel-costs/rates');
eq('POST /rates body keeps unit_cogs null on the wire', calls.at(-1).a.unit_cogs, null);
eq('POST /rates body keeps ship nulls', calls.at(-1).a.ship, { main: null });

await postDetect(90);
eq('POST /detect body is {} — NEVER null (B2)', calls.at(-1).a, {});
eq('POST /detect carries days as a param', calls.at(-1).b, { params: { days: 90 } });
await postDetect();
eq('POST /detect body stays {} with days omitted', calls.at(-1).a, {});
eq('POST /detect omits params when days omitted', calls.at(-1).b, undefined);

await fetchPnlOverview({ start: '2026-07-01', end: '2026-07-31' });
eq('GET /pnl/overview path+params', [calls.at(-1).url, calls.at(-1).a],
  ['/funnel-costs/pnl/overview', { params: { start: '2026-07-01', end: '2026-07-31' } }]);

await postManualSpend('f 1', { day: '2026-08-01', spend: 0, note: undefined });
eq('manual spend fid is URL-encoded', calls.at(-1).url, '/funnel-costs/pnl/funnel/f%201/spend-manual');
eq('manual spend 0 survives to the wire', calls.at(-1).a.spend, 0);

await postSpendSync();
eq('POST /spend/sync path', calls.at(-1).url, '/funnel-costs/spend/sync');
eq('POST /spend/sync body is {} — NEVER null (B2)', calls.at(-1).a, {});

eq('route helper encodes variant ids', COSTS_ROUTES.rateHistory('gid/1'), '/funnel-costs/rates/history/gid%2F1');

/* ── 11. payload readers + error-code mapping (contract v2 M2/M5) ─────── */
eq('rowsOf items (contract)', rowsOf({ items: [2] }), [2]);
eq('rowsOf junk → []', rowsOf({ nope: 1 }), []);
eq('dailyOf reads the contract key `daily`', dailyOf({ daily: [1] }), [1]);
eq('dailyOf ignores non-contract keys', dailyOf({ series: [2] }), []);
eq('manualOf reads `manual_entries`', manualOf({ manual_entries: [1] }), [1]);
eq('sourcesOf reads {sources:[…]} (M2)', sourcesOf({ sources: [2] }), [2]);
eq('sourcesOf of junk → []', sourcesOf([1]), []);
eq('costApiError maps error.code through API_ERRORS',
  costApiError({ response: { data: { success: false, error: { code: 'empty_rate' } } } }),
  'A rate has to set a cost or a shipping value — there is nothing to save.');
eq('costApiError maps the new v2 codes',
  [costApiError({ response: { data: { error: { code: 'usd_only' } } } }),
    costApiError({ response: { data: { error: { code: 'window_too_small' } } } })],
  ['Only USD rates are supported in v1.', 'The detection window must be at least 30 days.']);
eq('an UNKNOWN code gets generic prose, never the raw code',
  costApiError({ response: { status: 422, data: { error: { code: 'brand_new_code' } } } }),
  'The cost API rejected that.');
eq('an ABSENT code gets generic prose',
  costApiError({ response: { status: 500, data: {} } }),
  'The cost API rejected that.');
eq('a legacy string error field is NOT echoed to the operator',
  costApiError({ response: { status: 400, data: { error: 'raw server text' } } }),
  'The cost API rejected that.');
eq('costApiError 403', costApiError({ response: { status: 403, data: {} } }),
  'You need funnels access to change costs.');
eq('costApiError network fallback carries the cause',
  costApiError({ message: 'Network Error' }, 'The cost API rejected that.'),
  'The cost API rejected that. (Network Error)');

/* ── verdict ──────────────────────────────────────────────────────────── */
console.log(`\n${passed} passed, ${failed} failed`);
if (failed > 0) process.exit(1);
console.log('verifyCostsUi: ALL GREEN');
