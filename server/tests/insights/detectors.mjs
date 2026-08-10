// INSIGHT DETECTOR verification — drives the REAL detector rules from
// services/funnelInsights.js against authored fixture series (LANE 5,
// verification only).
//
// PURE ON PURPOSE, and no database anywhere. Every detector in this build is a
// function of (baseline, current) — the reads are separate — so the rules can
// be driven directly, one PASS case, one FAIL case and one FLOOR case each.
// That is what makes "the threshold is 7 measured baseline days" a fact rather
// than a comment: the sixth day is asserted silent and the seventh is asserted
// loud.
//
// ⚠️ FIXTURES ARE LEGITIMATE HERE, and this is the one place in this workspace
// where that is true. A captured payload proves SHAPE; it cannot prove that a
// rule fires at 6 days and not at 5, because a real database does not
// obligingly contain both. The shape half is covered where it belongs — the
// render harness runs against CAPTURED insight payloads
// (../../../client/src/pages/analytics/dashboard/__checks__/captureInsightsSeed.mjs).
//
// Run:  node server/tests/insights/detectors.mjs
import { readFileSync } from 'node:fs';

process.env.REPORT_TZ = process.env.REPORT_TZ || 'Europe/Madrid';

const I = await import('../../src/services/funnelInsights.js');
const {
  detectAnomaly, detectTopMover, detectFunnelLeak, detectAovShift,
  detectDeadRail, detectFirstSale, rankInsights, suppressPartialDay,
  splitSeries, measuredColumn,
  measured, pstdev, fmean, dayAdd, validDay, explorerLink, whenOf,
  THRESHOLDS, RULES, DROPPED, POLICIES, MAX_CARDS, BASELINE_DAYS, LAST_N_DAYS,
  SERIES_METRICS, STEP_ORDER, STEP_LABELS, SEVERITIES,
} = I;

let pass = 0; let fail = 0;
const ok = (c, m, x = '') => { if (c) { pass++; console.log('PASS ', m); } else { fail++; console.log('FAIL ', m, x); } };
const eq = (got, want, m) => ok(
  JSON.stringify(got) === JSON.stringify(want), m,
  `got=${JSON.stringify(got)} want=${JSON.stringify(want)}`,
);
const near = (a, b, eps = 0.011) => a !== null && a !== undefined && Math.abs(Number(a) - Number(b)) <= eps;

const DAY = '2026-08-09';
const TODAY = '2026-08-09';

/** A baseline of `n` days ending the day before `day`, all at `value`. */
const flat = (n, patch, day = DAY) => Array.from({ length: n }, (_v, i) => ({
  key: dayAdd(day, -(n - i)),
  ...patch,
}));

/** A baseline that alternates two values, so σ > 0. */
const wobble = (n, metric, lo, hi, extra = {}, day = DAY) =>
  Array.from({ length: n }, (_v, i) => ({
    key: dayAdd(day, -(n - i)),
    [metric]: i % 2 === 0 ? lo : hi,
    ...extra,
  }));

console.log('\n== insight detector rules ==\n');

/* ═══ 0. PINS — the constants this file's assertions are worth nothing without ═══ */

{
  const src = readFileSync(new URL('../../src/services/funnelMetrics.js', import.meta.url), 'utf8');
  // The step vocabulary is DUPLICATED into funnelInsights (that lane's fence is
  // create-only). The duplication is only safe if it is CHECKED.
  for (const step of STEP_ORDER) {
    ok(src.includes(`'${step}'`), `PIN funnelMetrics.js still carries the step '${step}'`);
  }
  ok(src.includes(`const STEP_ORDER = Object.freeze(['listicle', 'product', 'checkout', 'upsell', 'downsell', 'thankyou', 'other'])`),
    'PIN funnelMetrics.js STEP_ORDER is byte-identical to the order this lane assumes (plus its own "other" tail)');
  ok(src.includes(`lead: 'listicle', listicle: 'listicle', optin: 'listicle', quiz: 'listicle', generic: 'listicle'`),
    'PIN funnelMetrics.js TYPE_TO_STEP maps the same page types onto the landing step');
  // The engine must still export every symbol this lane reads through.
  for (const name of ['runQuery', 'todayInTz', 'zonedDayStart', 'REPORT_TIMEZONE', 'MetricsError', 'csvCell']) {
    ok(new RegExp(`export (async )?(function|const|class) ${name}\\b`).test(src)
      || new RegExp(`\\b${name},`).test(src),
      `PIN funnelMetrics.js still exports '${name}'`);
  }
  // The explorer's URL vocabulary — the deep link is worthless if it drifts.
  const rc = readFileSync(new URL('../../../client/src/pages/analytics/reportConfig.js', import.meta.url), 'utf8');
  const link = explorerLink('net_sales', DAY, 'f1');
  eq(Object.keys(link.params).sort(), ['end_day', 'funnel_id', 'metrics', 'start_day'],
    'PIN the deep link speaks exactly four explorer params');
  for (const k of Object.keys(link.params)) {
    ok(rc.includes(`'${k}'`), `PIN reportConfig.seedFromParams reads '${k}'`);
  }
  eq(link.params.start_day, dayAdd(DAY, -BASELINE_DAYS),
    'PIN the drill window is the trailing baseline ending on the card day');
  eq(explorerLink('aov', DAY).params.funnel_id, undefined,
    'PIN an account-wide card carries NO funnel_id (it would scope the drill to nothing)');
}

/* ═══ 1. THE NULL DISCIPLINE — the whole port turns on this ═══ */

eq(measured(null), null, 'N1 null is NOT a measurement');
eq(measured(undefined), null, 'N1 undefined is NOT a measurement');
eq(measured(''), null, 'N1 the empty string is NOT a measurement (Number("") is 0)');
eq(measured(0), 0, 'N1 a measured ZERO is a measurement and survives');
eq(measured(NaN), null, 'N1 NaN is not a measurement');
eq(measured(Infinity), null, 'N1 Infinity is not a measurement');
eq(measured('12.5'), 12.5, 'N1 a numeric string is read');
eq(measuredColumn([{ a: 1 }, { a: null }, { a: 3 }], 'a'), [1, 3],
  'N2 a null point is DROPPED from a baseline column, never read as 0');
eq(measuredColumn([{ a: null }, { a: null }], 'a'), [],
  'N2 …a wholly withheld baseline yields NO values (and will therefore fail its floor)');
ok(near(pstdev([2, 4, 4, 4, 5, 5, 7, 9]), 2), 'N3 pstdev is the POPULATION deviation (matches statistics.pstdev)');
ok(near(fmean([1, 2, 3, 4]), 2.5), 'N3 fmean');
eq(pstdev([]), 0, 'N3 an empty series has no deviation (and σ=0 blocks the anomaly test)');

/* ═══ 2. splitSeries ═══ */

{
  const pts = Array.from({ length: 40 }, (_v, i) => ({ key: dayAdd(DAY, -(39 - i)), orders: i }));
  const { baseline, current } = splitSeries(pts, DAY);
  eq(baseline.length, BASELINE_DAYS, `S1 the baseline is exactly ${BASELINE_DAYS} days`);
  eq(baseline[0].key, dayAdd(DAY, -BASELINE_DAYS), 'S1 …starting day-28');
  eq(baseline[baseline.length - 1].key, dayAdd(DAY, -1), 'S1 …ending the day BEFORE the card day');
  eq(current.key, DAY, 'S1 the current point is the card day itself');
  ok(!baseline.some((p) => p.key === DAY), 'S1 the card day is NEVER in its own baseline');
  eq(splitSeries([], DAY).current, null, 'S2 an empty series has no current point (null, not {})');
}

/* ═══ 3. DETECTOR 1 — anomaly ═══ */

{
  // A wobbling baseline: mean 100, σ 10.
  const base = wobble(10, 'net_sales', 90, 110);
  const vals = measuredColumn(base, 'net_sales');
  ok(near(fmean(vals), 100) && near(pstdev(vals), 10), '3 (fixture) baseline mean 100, σ 10');

  const low = detectAnomaly(base, { key: DAY, net_sales: 50 }, DAY, TODAY);
  ok(low !== null, '3 PASS a net-sales day at 50 (mean − 5σ) fires');
  eq(low.kind, 'anomaly', '3 …as an anomaly card');
  eq(low.severity, 'bad', '3 …and a NET SALES FALL is bad (the reference\'s own severity rule)');
  ok(low.prose.includes('$50.00') && low.prose.includes('$100.00'),
    `3 …naming both the value and the baseline mean (${low.prose})`);
  eq(low.deep_link.params.metrics, 'net_sales', '3 …and drills into the metric it is about');

  const high = detectAnomaly(base, { key: DAY, net_sales: 150 }, DAY, TODAY);
  eq(high.severity, 'good', '3 PASS an UPWARD net-sales anomaly is good, not bad');

  eq(detectAnomaly(base, { key: DAY, net_sales: 115 }, DAY, TODAY), null,
    '3 FAIL a day inside mean ± 2σ (115 vs 100±20) fires nothing');
  eq(detectAnomaly(base, { key: DAY, net_sales: 121 }, DAY, TODAY) === null, false,
    '3 …while 121 (just outside the band) does fire');

  // FLOOR — measured baseline days.
  const six = wobble(6, 'net_sales', 90, 110);
  eq(detectAnomaly(six, { key: DAY, net_sales: 50 }, DAY, TODAY), null,
    `3 FLOOR ${THRESHOLDS.anomaly_min_baseline.value - 1} baseline days is NOT enough — silent`);
  const seven = wobble(7, 'net_sales', 90, 110);
  ok(detectAnomaly(seven, { key: DAY, net_sales: 50 }, DAY, TODAY) !== null,
    `3 FLOOR …and ${THRESHOLDS.anomaly_min_baseline.value} IS enough — fires`);

  // FLOOR — a flat baseline cannot have an outlier.
  eq(detectAnomaly(flat(10, { net_sales: 100 }), { key: DAY, net_sales: 5000 }, DAY, TODAY), null,
    '3 FLOOR σ = 0 (a perfectly flat baseline) fires nothing, however wild the day');

  // THE DEVIATION, both halves.
  const withNulls = base.map((p, i) => (i < 5 ? { ...p, net_sales: null } : p));
  eq(detectAnomaly(withNulls, { key: DAY, net_sales: 50 }, DAY, TODAY), null,
    '3 DEVIATION 5 withheld baseline days drop the MEASURED count to 5 — under the floor, so silent '
    + '(the reference would read them as 0 and fire a fabricated collapse)');
  eq(detectAnomaly(base, { key: DAY, net_sales: null }, DAY, TODAY), null,
    '3 DEVIATION a WITHHELD current value fires nothing (the reference reads it as 0 → "dropped to $0")');
  eq(detectAnomaly(base, null, DAY, TODAY), null,
    '3 DEVIATION an ABSENT current point fires nothing');

  // Metric order: net_sales is checked before orders, first hit wins.
  const both = wobble(10, 'net_sales', 90, 110).map((p, i) => ({ ...p, orders: i % 2 ? 11 : 9 }));
  const c = detectAnomaly(both, { key: DAY, net_sales: 20, orders: 1 }, DAY, TODAY);
  eq(c.evidence.metric, 'net_sales', '3 ORDER net_sales is tested before orders — first anomaly wins');

  // Sessions and orders fall as WARN, not bad.
  const sess = wobble(10, 'sessions', 900, 1100);
  eq(detectAnomaly(sess, { key: DAY, sessions: 100 }, DAY, TODAY).severity, 'warn',
    '3 a SESSIONS fall is warn (only net sales is bad)');

  // Scope: the top-funnel pass names the funnel and scopes the drill.
  const scoped = detectAnomaly(base, { key: DAY, net_sales: 50 }, DAY, TODAY,
    { scope: ' on Puure Main', funnelId: 'f-123' });
  ok(scoped.headline.includes('on Puure Main'), '3 SCOPE the funnel-scoped card names the funnel');
  eq(scoped.deep_link.params.funnel_id, 'f-123', '3 …and its drill is scoped to that funnel');
}

/* ═══ 4. DETECTOR 2 — top mover ═══ */

{
  const cur = [
    { key: 'a', label: 'Alpha', net_sales: 500 },
    { key: 'b', label: 'Beta', net_sales: 100 },
  ];
  const prev = [
    { key: 'a', label: 'Alpha', net_sales: 200 },
    { key: 'b', label: 'Beta', net_sales: 150 },
  ];
  const c = detectTopMover(cur, prev, DAY, TODAY);
  ok(c !== null, '4 PASS a measured day-over-day move fires');
  eq(c.evidence.funnel_id, 'a', '4 …and picks the LARGEST ABSOLUTE delta (+300 beats −50)');
  eq(c.evidence.delta, 300, '4 …with the delta on the evidence');
  eq(c.severity, 'info', '4 …at info severity (a move is not a verdict)');
  ok(near(c.evidence.delta_pct, 150), '4 …and a delta_pct over the ABSOLUTE previous value');

  // THE DEVIATION: a funnel with no previous row is UNKNOWN, not zero.
  const brandNew = [{ key: 'z', label: 'Zeta', net_sales: 99_999 }];
  eq(detectTopMover([...cur, ...brandNew], prev, DAY, TODAY).evidence.funnel_id, 'a',
    '4 DEVIATION a funnel ABSENT from the previous day cannot win — its change is unknown, '
    + 'not its whole value (the reference defaults it to 0 and lets it win)');
  eq(detectTopMover(brandNew, prev, DAY, TODAY), null,
    '4 DEVIATION …and with ONLY unbaselined funnels the detector is silent, not confident');
  eq(detectTopMover(cur, [{ key: 'a', net_sales: null }, { key: 'b', net_sales: null }], DAY, TODAY), null,
    '4 DEVIATION a WITHHELD previous value is not a baseline either');

  // FLOOR: sub-cent movement is rounding.
  eq(detectTopMover([{ key: 'a', net_sales: 100.004 }], [{ key: 'a', net_sales: 100 }], DAY, TODAY), null,
    `4 FLOOR a delta under ${THRESHOLDS.mover_min_abs_delta.value} is rounding, not a move`);
  eq(detectTopMover([], [], DAY, TODAY), null, '4 an empty fold fires nothing');
  eq(detectTopMover(null, null, DAY, TODAY), null, '4 …and a non-array does not throw');
}

/* ═══ 5. DETECTOR 3 — funnel leak ═══ */

{
  /** 28 baseline days at `baseRate`, then the card day at `dayRate`. */
  const steps = ({ dayFrom, dayTo, baseFrom, baseTo, fid = 'f1' }) => {
    const rows = [{ funnel_id: fid, day: DAY, step: 'product', visitors: dayFrom },
      { funnel_id: fid, day: DAY, step: 'checkout', visitors: dayTo }];
    rows.push({ funnel_id: fid, day: dayAdd(DAY, -1), step: 'product', visitors: baseFrom });
    rows.push({ funnel_id: fid, day: dayAdd(DAY, -1), step: 'checkout', visitors: baseTo });
    return rows;
  };
  const names = new Map([['f1', 'Puure Main']]);

  // baseline 100 → 40 = 40%; today 50 → 5 = 10%, which is below half of 40%.
  const c = detectFunnelLeak(steps({ dayFrom: 50, dayTo: 5, baseFrom: 100, baseTo: 40 }), DAY, TODAY, names);
  ok(c !== null, '5 PASS a step-through that halved fires');
  eq(c.severity, 'warn', '5 …at warn while some visitors still get through');
  ok(near(c.evidence.day_pct, 10) && near(c.evidence.baseline_pct, 40),
    `5 …with both rates on the evidence (${c.evidence.day_pct} vs ${c.evidence.baseline_pct})`);
  ok(c.headline.includes('Puure Main'), '5 …and the funnel is named, not printed as an id');
  eq([c.evidence.from_step, c.evidence.to_step], ['product', 'checkout'], '5 …naming the step PAIR');

  eq(detectFunnelLeak(steps({ dayFrom: 50, dayTo: 0, baseFrom: 100, baseTo: 40 }), DAY, TODAY, names).severity,
    'bad', '5 …a step-through of ZERO is bad, not warn');

  // FAIL — a drop that is not below HALF.
  eq(detectFunnelLeak(steps({ dayFrom: 50, dayTo: 11, baseFrom: 100, baseTo: 40 }), DAY, TODAY, names), null,
    '5 FAIL 22% against a 40% baseline is a drop but not below half — silent');

  // FLOOR — today's upstream traffic.
  eq(detectFunnelLeak(steps({ dayFrom: 9, dayTo: 0, baseFrom: 100, baseTo: 40 }), DAY, TODAY, names), null,
    `5 FLOOR ${THRESHOLDS.leak_min_day_hits.value - 1} visitors today is under the floor — silent`);
  ok(detectFunnelLeak(steps({ dayFrom: 10, dayTo: 0, baseFrom: 100, baseTo: 40 }), DAY, TODAY, names) !== null,
    `5 FLOOR …and ${THRESHOLDS.leak_min_day_hits.value} clears it`);

  // FLOOR — the baseline's own traffic.
  eq(detectFunnelLeak(steps({ dayFrom: 50, dayTo: 0, baseFrom: 49, baseTo: 20 }), DAY, TODAY, names), null,
    `5 FLOOR ${THRESHOLDS.leak_min_base_hits.value - 1} baseline visitors is not a baseline — silent`);
  ok(detectFunnelLeak(steps({ dayFrom: 50, dayTo: 0, baseFrom: 50, baseTo: 20 }), DAY, TODAY, names) !== null,
    `5 FLOOR …and ${THRESHOLDS.leak_min_base_hits.value} is`);

  // A baseline that never converted has no rate to fall from.
  eq(detectFunnelLeak(steps({ dayFrom: 50, dayTo: 0, baseFrom: 100, baseTo: 0 }), DAY, TODAY, names), null,
    '5 FLOOR a baseline through-rate of 0% cannot fall — silent, never a division by zero');

  // CONSECUTIVE PAIRS ONLY, and only steps this funnel actually has.
  const gapped = [
    { funnel_id: 'f1', day: DAY, step: 'product', visitors: 100 },
    { funnel_id: 'f1', day: DAY, step: 'thankyou', visitors: 1 },
    { funnel_id: 'f1', day: dayAdd(DAY, -1), step: 'product', visitors: 200 },
    { funnel_id: 'f1', day: dayAdd(DAY, -1), step: 'thankyou', visitors: 100 },
  ];
  const g = detectFunnelLeak(gapped, DAY, TODAY, names);
  eq([g.evidence.from_step, g.evidence.to_step], ['product', 'thankyou'],
    '5 a funnel with no checkout step compares product → thankyou, NOT product → (missing) → 0');

  eq(detectFunnelLeak([], DAY, TODAY), null, '5 no step rows fires nothing');
  eq(detectFunnelLeak(null, DAY, TODAY), null, '5 …and a non-array does not throw');
}

/* ═══ 6. DETECTOR 4 — AOV shift ═══ */

{
  const base = flat(10, { orders: 5, aov: 100 });
  const up = detectAovShift(base, { key: DAY, orders: 5, aov: 130 }, DAY, TODAY);
  ok(up !== null, '6 PASS a +30% AOV move fires');
  eq(up.severity, 'good', '6 …upward is good');
  ok(near(up.evidence.shift_pct, 30), '6 …with the shift on the evidence');
  eq(detectAovShift(base, { key: DAY, orders: 5, aov: 70 }, DAY, TODAY).severity, 'warn',
    '6 PASS downward is warn');

  eq(detectAovShift(base, { key: DAY, orders: 5, aov: 119 }, DAY, TODAY), null,
    `6 FAIL +19% is under the ${THRESHOLDS.aov_shift_min_pct.value}% threshold — silent`);
  ok(detectAovShift(base, { key: DAY, orders: 5, aov: 120 }, DAY, TODAY) !== null,
    `6 FAIL …and exactly ${THRESHOLDS.aov_shift_min_pct.value}% fires`);

  // FLOOR — baseline days WITH ORDERS.
  eq(detectAovShift(flat(4, { orders: 5, aov: 100 }), { key: DAY, orders: 5, aov: 200 }, DAY, TODAY), null,
    `6 FLOOR ${THRESHOLDS.aov_min_baseline.value - 1} baseline days is under the floor — silent`);
  ok(detectAovShift(flat(5, { orders: 5, aov: 100 }), { key: DAY, orders: 5, aov: 200 }, DAY, TODAY) !== null,
    `6 FLOOR …and ${THRESHOLDS.aov_min_baseline.value} clears it`);

  // THE DEVIATION: a quiet day is not a $0 AOV day.
  const quiet = [...flat(10, { orders: 0, aov: null }), ...flat(4, { orders: 5, aov: 100 })];
  eq(detectAovShift(quiet, { key: DAY, orders: 5, aov: 200 }, DAY, TODAY), null,
    '6 DEVIATION 10 order-less days do NOT count toward the baseline (the reference reads their '
    + 'null AOV as 0 and halves the mean, manufacturing a shift)');
  eq(detectAovShift(base, { key: DAY, orders: 0, aov: null }, DAY, TODAY), null,
    '6 DEVIATION a day with no orders has no AOV to compare — silent, not "AOV fell to $0"');
  eq(detectAovShift(base, { key: DAY, orders: 5, aov: null }, DAY, TODAY), null,
    '6 DEVIATION …and a withheld AOV over real orders is also silent');
}

/* ═══ 7. DETECTOR 5 — dead rail ═══ */

{
  const names = new Map([['f1', 'Puure Main']]);
  const capi = detectDeadRail([{ funnel_id: 'f1', has_capi: false }], [], names);
  ok(capi !== null, '7 PASS an enabled Meta pixel with no CAPI token fires');
  eq(capi.severity, 'bad', '7 …as bad');
  ok(capi.prose.includes('Funnel Settings → Tracking → Meta Pixel → CAPI token'),
    '7 …and says exactly what to paste where');
  ok(!JSON.stringify(capi).includes('capi_token"'), '7 …and never carries a token value');
  eq(detectDeadRail([{ funnel_id: 'f1', has_capi: true }], [], names), null,
    '7 FAIL a pixel WITH a token fires nothing');

  const dead = detectDeadRail([], [{
    funnel_id: 'f1', platform: 'meta_pixel', sent: 0, failed: 12, deduped: 3, queued: 1,
  }], names);
  ok(dead !== null, '7 PASS a platform with 16 attempts and 0 deliveries fires');
  eq(dead.evidence.attempted, 16, '7 …attempted = error + deduped + queued');
  eq(detectDeadRail([], [{
    funnel_id: 'f1', platform: 'meta_pixel', sent: 1, failed: 99, deduped: 0, queued: 0,
  }], names), null, '7 FAIL one successful delivery is enough to say the rail is alive');
  eq(detectDeadRail([], [{
    funnel_id: 'f1', platform: 'meta_pixel', sent: 0, failed: 0, deduped: 0, queued: 0, skipped: 900,
  }], names), null,
  '7 DEVIATION 900 SKIPPED events are declines, not attempts — a consent-denied funnel is not a dead rail');
  eq(detectDeadRail([], [{ funnel_id: 'f1', platform: 'x', sent: null, failed: 5 }], names), null,
    '7 a withheld sent count cannot prove a rail is dead — silent');
  eq(detectDeadRail([], []), null, '7 nothing configured fires nothing');
  eq(detectDeadRail(null, null), null, '7 …and non-arrays do not throw');
}

/* ═══ 8. DETECTOR 6 — first sale ═══ */

{
  const dry = flat(20, { orders: 0, net_sales: 0 });
  const c = detectFirstSale(dry, { key: DAY, orders: 3, net_sales: 240 }, DAY, TODAY);
  ok(c !== null, '8 PASS 0 → 3 orders after a measured dry window fires');
  eq(c.severity, 'good', '8 …as good');
  ok(c.prose.includes('$240.00') && c.prose.includes('20 measured days at zero'),
    `8 …naming the money and the length of the dry spell (${c.prose})`);

  eq(detectFirstSale([...dry.slice(0, 19), { key: dayAdd(DAY, -1), orders: 1 }],
    { key: DAY, orders: 3 }, DAY, TODAY), null,
  '8 FAIL one order anywhere in the baseline means this is not a first sale');
  eq(detectFirstSale(dry, { key: DAY, orders: 0 }, DAY, TODAY), null,
    '8 FAIL no orders today either — nothing to celebrate');
  eq(detectFirstSale([], { key: DAY, orders: 3 }, DAY, TODAY), null,
    '8 FLOOR an EMPTY baseline is not a dry one — silent');

  // THE DEVIATION.
  const oneNull = [...dry.slice(0, 19), { key: dayAdd(DAY, -1), orders: null }];
  eq(detectFirstSale(oneNull, { key: DAY, orders: 3 }, DAY, TODAY), null,
    '8 DEVIATION ONE withheld baseline day blocks the card — "nobody bought" and "we did not look" '
    + 'are different claims (the reference celebrates a first sale for an account trading for a year)');
  const noNet = detectFirstSale(dry, { key: DAY, orders: 3, net_sales: null }, DAY, TODAY);
  ok(noNet !== null && noNet.evidence.net_sales === null,
    '8 a measured order count with WITHHELD money still fires, and says the money is unknown');
  ok(!noNet.prose.includes('$0.00'), '8 …and never prints $0.00 for it');
}

/* ═══ 9. RANKING AND THE CAP ═══ */

{
  const mk = (severity, order) => ({ order, card: { kind: `k${order}`, severity } });
  const ranked = rankInsights([
    mk('info', 6), mk('good', 5), mk('warn', 4), mk('bad', 3), mk('warn', 2), mk('bad', 1),
  ]);
  eq(ranked.map((c) => c.severity), ['bad', 'bad', 'warn', 'warn', 'good', 'info'],
    '9 ranked bad → warn → good → info');
  eq(ranked.map((c) => c.kind), ['k1', 'k3', 'k2', 'k4', 'k5', 'k6'],
    '9 …and ties break on DETECTOR ORDER, so two loads of the same day cannot swap them');
  eq(rankInsights(Array.from({ length: 12 }, (_v, i) => mk('info', i))).length, MAX_CARDS,
    `9 the strip is capped at ${MAX_CARDS} cards`);
  eq(rankInsights([null, undefined, { order: 1 }, mk('bad', 2)]).length, 1,
    '9 a detector that returned nothing contributes nothing (and does not throw)');
  eq(rankInsights([]), [], '9 no cards is an empty list, never a fabricated one');
}

/* ═══ 10. THE CARD CONTRACT — every card, every key ═══ */

{
  const cards = [
    detectAnomaly(wobble(10, 'net_sales', 90, 110), { key: DAY, net_sales: 50 }, DAY, TODAY),
    detectTopMover([{ key: 'a', label: 'A', net_sales: 500 }], [{ key: 'a', net_sales: 200 }], DAY, TODAY),
    detectFunnelLeak([
      { funnel_id: 'f1', day: DAY, step: 'product', visitors: 50 },
      { funnel_id: 'f1', day: DAY, step: 'checkout', visitors: 1 },
      { funnel_id: 'f1', day: dayAdd(DAY, -1), step: 'product', visitors: 100 },
      { funnel_id: 'f1', day: dayAdd(DAY, -1), step: 'checkout', visitors: 40 },
    ], DAY, TODAY),
    detectAovShift(flat(10, { orders: 5, aov: 100 }), { key: DAY, orders: 5, aov: 200 }, DAY, TODAY),
    detectDeadRail([{ funnel_id: 'f1', has_capi: false }], []),
    detectFirstSale(flat(10, { orders: 0 }), { key: DAY, orders: 1, net_sales: 10 }, DAY, TODAY),
  ];
  eq(cards.filter(Boolean).length, 6, '10 all six detectors produced a card for the contract check');
  for (const c of cards) {
    for (const k of ['kind', 'severity', 'headline', 'prose', 'deep_link', 'evidence']) {
      ok(Object.prototype.hasOwnProperty.call(c, k), `10 [${c.kind}] carries '${k}'`);
    }
    ok(SEVERITIES.includes(c.severity), `10 [${c.kind}] severity is one of the four (${c.severity})`);
    ok(typeof c.headline === 'string' && c.headline.length > 0 && c.headline.length <= 90,
      `10 [${c.kind}] headline is one short line (${c.headline.length} chars)`);
    ok(typeof c.prose === 'string' && c.prose.trim().endsWith('.'),
      `10 [${c.kind}] prose is a finished sentence`);
    ok(c.deep_link && typeof c.deep_link.page === 'string' && c.deep_link.params
      && typeof c.deep_link.params === 'object',
    `10 [${c.kind}] deep_link is {page, params}`);
    ok(!/\bundefined\b|\bNaN\b|\bnull\b/.test(c.headline + c.prose),
      `10 [${c.kind}] no undefined/NaN/null leaked into the prose`);
  }
  // Every kind in RULES produced a card, and every card's kind is in RULES.
  eq([...new Set(cards.map((c) => c.kind))].sort(), RULES.map((r) => r.kind).sort(),
    '10 the rule table and the detectors name the SAME six kinds');
}

/* ═══ 11. THE PUBLISHED RULE TABLE ═══ */

{
  eq(RULES.length, 6, '11 six rules are published');
  for (const r of RULES) {
    for (const k of ['kind', 'order', 'ported', 'what', 'floors', 'severity', 'deviation']) {
      ok(Object.prototype.hasOwnProperty.call(r, k), `11 [${r.kind}] rule row carries '${k}'`);
    }
    for (const f of r.floors) {
      ok(Object.prototype.hasOwnProperty.call(THRESHOLDS, f),
        `11 [${r.kind}] names a REAL threshold '${f}'`);
    }
  }
  eq(RULES.map((r) => r.order), [1, 2, 3, 4, 5, 6], '11 the rule order is the reference detector order');
  ok(RULES.filter((r) => r.ported === 'adapted').map((r) => r.kind).includes('funnel_leak'),
    '11 funnel_leak is declared ADAPTED, not silently ported');
  for (const [name, t] of Object.entries(THRESHOLDS)) {
    ok(typeof t.value === 'number' && ['reference', 'adapted'].includes(t.source) && t.note,
      `11 threshold '${name}' says its value, its provenance and what it means`);
  }
  ok(DROPPED.length >= 2 && DROPPED.every((d) => d.kind && d.what && d.why),
    '11 what did NOT survive the port is named WITH a reason');
  eq(BASELINE_DAYS, 28, '11 the baseline is the reference\'s 28 days');
  eq(LAST_N_DAYS, 60, '11 the long series is 60 days');
  ok(SERIES_METRICS.length <= 8, `11 the series read fits the engine's 8-metric cap (${SERIES_METRICS.length})`);
  ok(STEP_ORDER.every((s) => STEP_LABELS[s]), '11 every step has an operator-facing label');
}

/* ═══ 12. SMALL PURE HELPERS ═══ */

eq(validDay('2026-08-09'), '2026-08-09', '12 a real day validates');
eq(validDay('2026-13-99'), null, '12 an impossible date is refused, not parsed into something else');
eq(validDay('2026-02-30'), null, '12 …including a Feb 30 that Date would silently roll to Mar 2');
eq(validDay('nope'), null, '12 junk is refused');
eq(validDay(''), null, '12 the empty string is refused');
eq(validDay(null), null, '12 null is refused');
eq(dayAdd('2026-03-01', -1), '2026-02-28', '12 dayAdd steps back over a month boundary');
eq(dayAdd('2026-10-25', 1), '2026-10-26', '12 …and across the Madrid DST day (noon-anchored)');
eq(dayAdd('2026-03-29', 1), '2026-03-30', '12 …and across the spring one');
eq(whenOf('2026-08-09', '2026-08-09'), 'today', '12 the card day IS today');
eq(whenOf('2026-08-04', '2026-08-09'), 'on 2026-08-04', '12 …and an older day names itself');

/* ═══ 13. DIRECTION — every card declares which way it points ═══
   The partial-day guard drops `direction === 'down'` cards, so a detector that
   sets the wrong direction (or forgets it) would let a false downward alarm
   through on an in-progress day, or needlessly hide good news. Each direction
   is pinned to the case that produces it. */

{
  const base = wobble(10, 'net_sales', 90, 110);
  eq(detectAnomaly(base, { key: DAY, net_sales: 50 }, DAY, TODAY).direction, 'down',
    '13 a DOWNWARD anomaly declares direction:down (the one the partial guard drops)');
  eq(detectAnomaly(base, { key: DAY, net_sales: 150 }, DAY, TODAY).direction, 'up',
    '13 an UPWARD anomaly declares direction:up (kept on a partial day — genuinely ahead)');

  eq(detectTopMover([{ key: 'a', label: 'A', net_sales: 100 }], [{ key: 'a', net_sales: 500 }], DAY, TODAY).direction,
    'down', '13 a mover that FELL is direction:down even at info severity');
  eq(detectTopMover([{ key: 'a', label: 'A', net_sales: 500 }], [{ key: 'a', net_sales: 100 }], DAY, TODAY).direction,
    'up', '13 …and one that rose is up');

  const leakRows = [
    { funnel_id: 'f1', day: DAY, step: 'product', visitors: 50 },
    { funnel_id: 'f1', day: DAY, step: 'checkout', visitors: 1 },
    { funnel_id: 'f1', day: dayAdd(DAY, -1), step: 'product', visitors: 100 },
    { funnel_id: 'f1', day: dayAdd(DAY, -1), step: 'checkout', visitors: 40 },
  ];
  eq(detectFunnelLeak(leakRows, DAY, TODAY).direction, 'down',
    '13 a funnel leak is ALWAYS direction:down (a partial day\'s lagging checkout reads as a collapse)');

  eq(detectAovShift(flat(10, { orders: 5, aov: 100 }), { key: DAY, orders: 5, aov: 200 }, DAY, TODAY).direction,
    'up', '13 an AOV that rose is up');
  eq(detectAovShift(flat(10, { orders: 5, aov: 100 }), { key: DAY, orders: 5, aov: 50 }, DAY, TODAY).direction,
    'down', '13 …and one that fell is down');

  eq(detectDeadRail([{ funnel_id: 'f1', has_capi: false }], []).direction, 'neutral',
    '13 a dead rail is direction:neutral — a config problem, not a day-over-day movement, so it '
    + 'SURVIVES a partial day');
  eq(detectFirstSale(flat(10, { orders: 0 }), { key: DAY, orders: 1, net_sales: 10 }, DAY, TODAY).direction,
    'up', '13 a first sale is up — the first order of the day is real however early it lands');

  // The four severities never contradict the direction: a 'good' card is up, a
  // downward card is bad or warn. (dead_rail is bad+neutral by design — a
  // config failure is serious but not a movement, hence kept on a partial day.)
  const upAnom = detectAnomaly(base, { key: DAY, net_sales: 150 }, DAY, TODAY);
  ok(upAnom.severity === 'good' && upAnom.direction === 'up', '13 good ⇒ up');
}

/* ═══ 14. THE PARTIAL-DAY GUARD (pure) ═══
   suppressPartialDay is the whole of the current-side fix in one function: on
   an in-progress day it drops exactly the downward cards. This is the mirror of
   the absent-means-zero discipline, applied to the current value instead of the
   baseline. */

{
  const mk = (kind, severity, direction) => ({ kind, severity, direction, headline: 'h', prose: 'p.' });
  const mixed = [
    mk('anomaly', 'bad', 'down'),
    mk('aov_shift', 'good', 'up'),
    mk('funnel_leak', 'warn', 'down'),
    mk('dead_rail', 'bad', 'neutral'),
    mk('first_sale', 'good', 'up'),
    mk('top_mover', 'info', 'down'),
  ];
  const kept = suppressPartialDay(mixed);
  eq(kept.map((c) => c.kind).sort(), ['aov_shift', 'dead_rail', 'first_sale'],
    '14 a partial day keeps ONLY up + neutral cards — every downward one is withheld');
  ok(!kept.some((c) => c.direction === 'down'),
    '14 …not one direction:down card survives, whatever its severity');
  ok(kept.some((c) => c.kind === 'dead_rail'),
    '14 …and the bad-but-neutral dead-rail card is KEPT (a config failure is not a clock artifact)');

  eq(suppressPartialDay([]), [], '14 an empty list suppresses to empty, never throws');
  eq(suppressPartialDay(null), [], '14 …and a non-array does not throw');
  // A card missing a direction defaults to neutral in the factory, so it is
  // never dropped by accident — the safe failure mode.
  eq(suppressPartialDay([{ kind: 'x', severity: 'info' }]).length, 1,
    '14 a directionless card is kept, not silently dropped (neutral is the safe default)');

  // MUTATION CHECK, in-file: prove the guard is load-bearing. If it were a
  // no-op (returned its input), the downward cards would survive — assert they
  // do NOT, so a future refactor that neuters it fails here.
  ok(kept.length < mixed.length, '14 MUTATION the guard actually removes cards — it is not a no-op');
  ok(!kept.some((c) => c.severity === 'bad' && c.direction === 'down'),
    '14 MUTATION …specifically the red downward alarm the reviewer proved (bad + down) is gone');
}

/* ═══ 15. THE PARTIAL-DAY POLICY IS PUBLISHED ═══ */

{
  ok(Array.isArray(POLICIES) && POLICIES.length >= 2, '15 POLICIES ships the cross-cutting behaviour');
  const kinds = POLICIES.map((p) => p.kind);
  ok(kinds.includes('complete_day_default'),
    '15 …including the default-to-yesterday policy');
  ok(kinds.includes('partial_day_suppression'),
    '15 …and the downward-suppression policy');
  for (const p of POLICIES) {
    ok(p.kind && p.what && p.why, `15 [${p.kind}] policy row carries kind/what/why`);
  }
}

console.log(`\nRESULT: ${pass} passed, ${fail} failed\n`);
process.exit(fail ? 1 : 0);
