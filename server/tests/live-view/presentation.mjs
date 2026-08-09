// Verification for the Live View PRESENTATION logic —
// client/src/pages/live/livePresentation.js + countryCentroids.js.
//
// No DB, no browser, no server: the whole point of that module is that the
// tricky parts (toast queue bounding, alert gating, country→centroid lookup,
// the globe projection, the arrivals diff) are pure functions, so they can be
// proven here in milliseconds instead of by squinting at a canvas.
//
// Run:  node server/tests/live-view/presentation.mjs
import assert from 'node:assert';

const M = await import('../../../client/src/pages/live/livePresentation.js');
const { COUNTRY_CENTROIDS } = await import('../../../client/src/pages/live/countryCentroids.js');
const { LAND_RINGS } = await import('../../../client/src/pages/live/worldLand.js');

let pass = 0, fail = 0;
const ok = (c, m, x = '') => { if (c) { pass++; console.log('PASS ', m); } else { fail++; console.log('FAIL ', m, x); } };
const eq = (a, b, m) => ok(Object.is(a, b) || JSON.stringify(a) === JSON.stringify(b), m, `got ${JSON.stringify(a)} want ${JSON.stringify(b)}`);

const purchase = (id, over = {}) => ({
  id, type: 'purchase', ts: '2026-08-09T12:00:00.000Z',
  funnel_id: 'f1', funnel_name: 'Breast Lift', page_id: 'p1', page_title: 'Checkout',
  value: 59, currency: 'USD', upsell: false, ...over,
});

// ═══ 1. country → centroid ═════════════════════════════════════════════════
console.log('\n── 1. country → centroid ──');
{
  const n = Object.keys(COUNTRY_CENTROIDS).length;
  ok(n >= 240, `table has ${n} countries (>=240)`);

  // Every entry is a real coordinate. A table that silently held a NaN or a
  // lon of 202.8 (the antimeridian bug the generator had) would put pins in
  // the sea with no error anywhere.
  const bad = Object.entries(COUNTRY_CENTROIDS).filter(([cc, v]) =>
    !/^[A-Z]{2}$/.test(cc) || !Array.isArray(v) || v.length !== 2 ||
    !Number.isFinite(v[0]) || !Number.isFinite(v[1]) ||
    v[0] < -90 || v[0] > 90 || v[1] < -180 || v[1] > 180);
  eq(bad.length, 0, 'every centroid is a well-formed in-range (lat, lon)');

  // Known-good spot checks — these are the codes our traffic actually carries.
  const near = (cc, lat, lon, tol = 3) => {
    const c = M.lookupCentroid(cc);
    ok(c && Math.abs(c.lat - lat) <= tol && Math.abs(c.lon - lon) <= tol,
      `${cc} lands near (${lat}, ${lon})`, JSON.stringify(c));
  };
  near('US', 39.5, -99.1); near('GB', 53.9, -2.7); near('DE', 51.1, 10.3);
  near('AU', -25.6, 134.4); near('CA', 57.7, -101.6); near('SG', 1.4, 103.8);
  near('RU', 61.7, 99.9);   // antimeridian regression: was lon 202.8
  near('FJ', -17.8, 178.0); // antimeridian regression: was lon 11.6
  near('VN', 16.7, 106.3);  // legacy-code collision regression: VD stole this
  near('DE', 51.1, 10.3);   // legacy-code collision regression: DD stole this

  // Case + whitespace tolerance, and REFUSAL on everything else.
  eq(M.lookupCentroid('us'), M.lookupCentroid('US'), 'lookup is case-insensitive');
  eq(M.lookupCentroid(' gb '), M.lookupCentroid('GB'), 'lookup trims');
  for (const junk of [null, undefined, '', 'X', 'USA', 'ZZ', 42, {}, [], NaN])
    eq(M.lookupCentroid(junk), null, `lookupCentroid(${JSON.stringify(junk)}) → null`);
  eq(M.hasCentroid('QQ'), false, 'hasCentroid is false for an unknown code');
}

// ═══ 2. deriveGeoPoints ════════════════════════════════════════════════════
console.log('\n── 2. deriveGeoPoints ──');
{
  const g = M.deriveGeoPoints({
    by_country: [
      { country: 'US', visitors: 40 },
      { country: 'ZZ', visitors: 7 },   // valid-looking but not a plottable country
      { country: 'GB', visitors: 12 },
      { country: 'QQ', visitors: 1 },
    ],
  });
  eq(g.plotted, 2, 'two of four codes are plottable');
  eq(g.offMap, ['ZZ', 'QQ'], 'unplottable codes are NAMED, not dropped');
  eq(g.offMapVisitors, 8, 'off-map visitors are counted');
  eq(g.total, 60, 'total counts every row, plottable or not');
  eq(g.points.map((p) => p.country), ['GB', 'US'], 'points sort visitors ASC (biggest painted last)');
  eq(g.points[1].label, 'United States', 'points carry a display label');
  ok(Number.isFinite(g.points[0].lat) && Number.isFinite(g.points[0].lon), 'points carry coordinates');

  // Zero events / degraded reads must not throw — the page has to survive them.
  for (const junk of [null, undefined, {}, { by_country: null }, { by_country: 'nope' }, { by_country: [] }]) {
    const r = M.deriveGeoPoints(junk);
    eq(r.plotted, 0, `deriveGeoPoints(${JSON.stringify(junk)}) → empty, no throw`);
  }
  // F7: an unusable count is NOT a zero-visitor marker. A marker asserts that
  // somebody was there, so a NaN/negative/missing count is excluded and
  // COUNTED as malformed rather than plotted at the origin of that country.
  const messy = M.deriveGeoPoints({
    by_country: [null, { country: '' }, { country: 'US' }, { country: 'GB', visitors: -5 },
      { country: 'DE', visitors: 'abc' }, { country: 'FR', visitors: 0 }, { country: 'IT', visitors: 4 }],
  });
  eq(messy.plotted, 1, 'only the row with a usable positive count is plotted');
  eq(messy.points[0].country, 'IT', 'and it is the right one');
  eq(messy.malformed, 6, 'every unusable row is COUNTED, not silently dropped');
  eq(messy.total, 4, 'unusable rows contribute nothing to the total');
}

// ═══ 3. trackArrivals (F5) ═════════════════════════════════════════════════
console.log('\n── 3. trackArrivals ──');
{
  const P = (cc, v) => ({ country: cc, visitors: v, lat: 0, lon: 0 });
  const step = (st, pts, opts) => M.trackArrivals(st, pts, opts);

  // Priming: the first reading is a baseline, never a wall of arrivals.
  let s = M.createArrivalState();
  let r = step(s, [P('US', 10), P('GB', 5)]);
  eq(r.arrivals, [], 'the FIRST reading arrives nothing (else the whole day pulses at once)');
  s = r.state;

  r = step(s, [P('US', 12), P('GB', 5), P('FR', 3)]);
  eq(r.arrivals.map((x) => [x.country, x.gained]), [['US', 2], ['FR', 3]],
    'a rise and a genuinely new country both arrive, with the gain');
  s = r.state;

  eq(step(s, [P('US', 12), P('GB', 5), P('FR', 3)]).arrivals, [],
    'an unchanged reading arrives nothing');

  // F5(a) TRUNCATION — a country crossing into the top-N cut is NOT a new
  // arrival of its entire running total.
  let t = M.createArrivalState();
  t = step(t, [P('US', 40)], { truncated: true }).state;
  r = step(t, [P('US', 40), P('BR', 300)], { truncated: true });
  eq(r.arrivals, [], 'while TRUNCATED, a newly-listed country does NOT ripple its whole total');
  t = r.state;
  // But once it is being tracked, its own subsequent rise is real.
  r = step(t, [P('US', 40), P('BR', 305)], { truncated: true });
  eq(r.arrivals.map((x) => [x.country, x.gained]), [['BR', 5]],
    'and its next genuine rise DOES ripple, at the true delta');

  // On a COMPLETE list the same shape is a real arrival.
  let u = M.createArrivalState();
  u = step(u, [P('US', 40)]).state;
  eq(step(u, [P('US', 40), P('BR', 3)]).arrivals.map((x) => x.country), ['BR'],
    'on a complete list a new country IS an arrival');

  // F5(b) DEGRADED READ / RECOVERY — 50 → 12 → 50 must be silent on recovery.
  const fifty = Array.from({ length: 50 }, (_, i) => P(`C${i}`, 10 + i));
  let d = M.createArrivalState();
  d = step(d, fifty).state;
  const twelve = fifty.slice(0, 12);
  r = step(d, twelve);
  eq(r.arrivals, [], 'a read that returns only 12 of 50 countries arrives nothing');
  d = r.state;
  r = step(d, fifty);
  eq(r.arrivals, [], 'and RECOVERY to the same 50 arrives nothing — the 38 were never forgotten');
  d = r.state;
  // A real rise after recovery still lands.
  const bumped = fifty.map((p, i) => (i === 3 ? P(p.country, p.visitors + 7) : p));
  eq(step(d, bumped).arrivals.map((x) => [x.country, x.gained]), [['C3', 7]],
    'a genuine rise after recovery still arrives');

  // F5(c) MIDNIGHT ROLLOVER — counts reset; no arrivals, and the baseline
  // drops so the next real visitor ripples instead of the board going dead.
  let m = M.createArrivalState();
  m = step(m, [P('US', 900)]).state;
  r = step(m, [P('US', 2)]);
  eq(r.arrivals, [], 'a FALLING count (midnight rollover) arrives nothing');
  m = r.state;
  eq(step(m, [P('US', 3)]).arrivals.map((x) => [x.country, x.gained]), [['US', 1]],
    'and the baseline was re-anchored DOWN, so the next visitor ripples');

  // The gain is bounded, so a bad read cannot spray hundreds of ripples.
  let b = M.createArrivalState();
  b = step(b, [P('US', 1)]).state;
  eq(step(b, [P('US', 99999)]).arrivals[0].gained, M.MAX_ARRIVAL_GAIN,
    'an absurd jump is capped at MAX_ARRIVAL_GAIN');

  // Robustness.
  eq(step(M.createArrivalState(), null).arrivals, [], 'a null list is not a throw');
  eq(step(M.createArrivalState(), []).arrivals, [], 'empty → empty');
  const junk = step(step(M.createArrivalState(), [P('US', 1)]).state,
    [null, { country: 'US', visitors: 5 }, { visitors: 3 }]);
  eq(junk.arrivals.map((x) => x.country), ['US'], 'malformed rows are skipped, not crashed on');

  // Purity.
  const before = M.createArrivalState();
  const snap = before.known.size;
  M.trackArrivals(before, [P('US', 1)]);
  eq(before.known.size, snap, 'trackArrivals does not mutate the state it is given');
  eq(before.primed, false, 'nor its primed flag');
}

// ═══ 4. orthographic projection ════════════════════════════════════════════
console.log('\n── 4. projection ──');
{
  const O = { rotation: 0, tilt: 0, radius: 100, cx: 0, cy: 0 };
  const c = M.project(0, 0, O);
  ok(Math.abs(c.x) < 1e-9 && Math.abs(c.y) < 1e-9 && c.visible, '(0,0) projects to the disc centre, visible');

  const np = M.project(90, 0, O);
  ok(Math.abs(np.x) < 1e-9 && Math.abs(np.y + 100) < 1e-9, 'north pole is at the TOP (canvas Y grows down)');
  const sp = M.project(-90, 0, O);
  ok(Math.abs(sp.y - 100) < 1e-9, 'south pole is at the bottom');

  eq(M.project(0, 180, O).visible, false, 'the antipode is on the FAR hemisphere');
  eq(M.project(0, 90, O).visible, true, 'the limb (90deg) is the visibility boundary, inclusive');
  ok(M.project(0, 90, O).x > 99.9, '+90 lon is at the right limb');
  ok(M.project(0, -90, O).x < -99.9, '-90 lon is at the left limb');

  // Rotation carries the far side round to the front — that IS the spin.
  eq(M.project(0, 180, { ...O, rotation: 180 }).visible, true, 'rotation brings the far side forward');

  // Everything stays on the disc, for every lat/lon, at every rotation/tilt.
  let off = 0, nan = 0;
  for (let rot = 0; rot < 360; rot += 37) {
    for (let tilt = -40; tilt <= 40; tilt += 20) {
      for (let lat = -90; lat <= 90; lat += 15) {
        for (let lon = -180; lon <= 180; lon += 15) {
          const p = M.project(lat, lon, { rotation: rot, tilt, radius: 100, cx: 250, cy: 250 });
          if (!Number.isFinite(p.x) || !Number.isFinite(p.y)) nan++;
          if (Math.hypot(p.x - 250, p.y - 250) > 100.0001) off++;
        }
      }
    }
  }
  eq(nan, 0, 'no NaN across the full lat/lon × rotation × tilt sweep');
  eq(off, 0, 'no point ever escapes the globe disc');
  ok(M.project(0, 0, {}).visible, 'project() with NO options does not throw');
}

// ═══ 5. toast queue bounding ═══════════════════════════════════════════════
console.log('\n── 5. toast queue ──');
{
  let s = M.createToastState();
  eq(s.toasts.length, 0, 'a fresh queue is empty');

  // GATE: armed
  let r = M.pushToast(s, purchase('c_1'), { armed: false });
  eq(r.reason, 'not_armed', 'unarmed pushes are suppressed');
  eq(r.state.toasts.length, 0, 'unarmed push does not mutate the queue');

  // GATE: kind — a view or a checkout START is not money
  for (const t of ['view', 'checkout_start']) {
    eq(M.pushToast(s, { id: 'x', type: t, value: 99 }).reason, 'not_payment', `${t} does not toast`);
  }

  // GATE: key
  eq(M.pushToast(s, { type: 'purchase', value: 10 }).reason, 'no_key', 'an id-less purchase does not toast');

  // Happy path + cap
  for (const id of ['c_1', 'c_2', 'c_3']) s = M.pushToast(s, purchase(id)).state;
  eq(s.toasts.length, 3, 'three toasts fit the cap');
  eq(s.toasts.map((t) => t.key), ['pt3', 'pt2', 'pt1'], 'NEWEST is first');

  r = M.pushToast(s, purchase('c_4'));
  eq(r.state.toasts.length, 3, 'the cap holds at TOAST_MAX');
  eq(r.state.toasts.map((t) => t.key), ['pt4', 'pt3', 'pt2'], 'the OLDEST is evicted');
  eq(r.dropped, ['pt1'], 'the evicted key is REPORTED (so its timers can be cleared, not leaked)');
  s = r.state;

  // GATE: dedupe
  eq(M.pushToast(s, purchase('c_2')).reason, 'duplicate', 'a re-delivered event does not re-toast');
  eq(M.pushToast(s, purchase('c_2', { upsell: true })).reason, 'emitted',
    'the SAME id as an upsell is a different moment and DOES toast');

  // Cap of 1 — the degenerate case
  let one = M.createToastState();
  one = M.pushToast(one, purchase('a'), { max: 1 }).state;
  const r1 = M.pushToast(one, purchase('b'), { max: 1 });
  eq(r1.state.toasts.length, 1, 'max=1 keeps exactly one');
  eq(r1.dropped, ['pt1'], 'max=1 reports the eviction');
  eq(M.pushToast(M.createToastState(), purchase('a'), { max: 0 }).state.toasts.length, 1,
    'max=0 is clamped to 1 rather than emitting into the void');

  // Burst far beyond the cap
  let burst = M.createToastState();
  let totalDropped = 0;
  for (let i = 0; i < 50; i++) {
    const rr = M.pushToast(burst, purchase(`b_${i}`));
    burst = rr.state;
    totalDropped += rr.dropped.length;
  }
  eq(burst.toasts.length, 3, '50 events still leave exactly 3 toasts');
  eq(totalDropped, 47, 'every evicted toast was reported exactly once');

  // Seen-set bound
  let big = M.createToastState();
  for (let i = 0; i < M.SEEN_MAX + 60; i++) big = M.pushToast(big, purchase(`s_${i}`)).state;
  ok(big.seen.length <= M.SEEN_MAX, `seen set stays bounded (${big.seen.length} <= ${M.SEEN_MAX})`);
  eq(M.pushToast(big, purchase(`s_${M.SEEN_MAX + 59}`)).reason, 'duplicate', 'the NEWEST keys survive eviction');
  eq(M.pushToast(big, purchase('s_0')).reason, 'emitted', 'the OLDEST key was evicted FIFO (it toasts again)');

  // markExiting / removeToast
  const ex = M.markExiting(burst, burst.toasts[0].key);
  eq(ex.toasts[0].exiting, true, 'markExiting flags only the named toast');
  eq(ex.toasts[1].exiting, false, 'markExiting leaves the others alone');
  eq(M.removeToast(ex, ex.toasts[0].key).toasts.length, 2, 'removeToast removes it');
  eq(M.removeToast(ex, 'nope').toasts.length, 3, 'removing an unknown key is a no-op, not a throw');
}

// ═══ 6. hidden-tab coalescing ══════════════════════════════════════════════
console.log('\n── 6. hidden-tab buffer ──');
{
  let s = M.createToastState();
  for (const id of ['h1', 'h2']) s = M.pushToast(s, purchase(id), { hidden: true }).state;
  eq(s.toasts.length, 0, 'a hidden tab stacks NOTHING');
  eq(s.buffer.count, 2, 'the buffer counted both');

  let f = M.flushBuffer(s);
  eq(f.emitted.length, 2, 'at/below BUFFER_SAMPLE the events replay VERBATIM');
  eq(f.state.buffer, null, 'the buffer is cleared by the flush');
  eq(f.state.toasts[0].key, 'pt2', 'replayed oldest-first, so the newest lands on top');

  let many = M.createToastState();
  for (let i = 0; i < 9; i++) many = M.pushToast(many, purchase(`m${i}`, { value: 10 }), { hidden: true }).state;
  f = M.flushBuffer(many);
  eq(f.emitted.length, 1, 'above BUFFER_SAMPLE they COALESCE into one row');
  eq(f.emitted[0].aggregate, true, 'the coalesced row is flagged aggregate');
  eq(f.emitted[0].count, 9, 'the coalesced row carries the true count');
  eq(f.emitted[0].amount, 90, 'the coalesced row sums the amounts');

  // A null amount means "unrecorded", not "$0" — the sum must say so.
  let mixed = M.createToastState();
  for (let i = 0; i < 5; i++) {
    mixed = M.pushToast(mixed, purchase(`x${i}`, { value: i < 3 ? 10 : null }), { hidden: true }).state;
  }
  const fm = M.flushBuffer(mixed);
  eq(fm.emitted[0].amount, 30, 'unpriced events add 0 to the sum');
  eq(fm.emitted[0].unpriced, 2, 'the number of UNPRICED events is carried, so the sum is not read as complete');

  eq(M.flushBuffer(M.createToastState()).emitted, [], 'flushing an empty buffer emits nothing');
  eq(M.flushBuffer({ ...M.createToastState(), buffer: { count: 0 } }).emitted, [], 'flushing a zero-count buffer emits nothing');

  // Dedupe still applies while hidden.
  let dh = M.createToastState();
  dh = M.pushToast(dh, purchase('d1'), { hidden: true }).state;
  eq(M.pushToast(dh, purchase('d1'), { hidden: true }).reason, 'duplicate', 'the hidden path still dedupes');
}

// ═══ 6b. F4 — the aggregate must never invent a total ══════════════════════
console.log('\n── 6b. aggregate money honesty (F4) ──');
{
  const buy = (id, over) => purchase(id, over);
  const bufferUp = (evs) => {
    let s = M.createToastState();
    for (const ev of evs) s = M.pushToast(s, ev, { hidden: true }).state;
    return M.flushBuffer(s).emitted[0];
  };

  // (a) MIXED CURRENCIES — summing USD + JPY + EUR into one figure invents a
  // number that looks entirely plausible on a dashboard.
  const mixed = bufferUp([
    buy('m1', { value: 100, currency: 'USD' }),
    buy('m2', { value: 100, currency: 'JPY' }),
    buy('m3', { value: 100, currency: 'EUR' }),
  ]);
  eq(mixed.count, 3, 'the mixed batch counts all three');
  eq(mixed.amount, null, 'and refuses a total (was $300 across three currencies)');
  eq(mixed.mixedCurrencies, true, 'flagging WHY');
  eq(mixed.currencies.sort(), ['EUR', 'JPY', 'USD'], 'and naming the currencies seen');

  // One currency throughout ⇒ a real total is fine.
  const same = bufferUp([
    buy('s1', { value: 100, currency: 'USD' }),
    buy('s2', { value: 50, currency: 'USD' }),
    buy('s3', { value: 25, currency: 'USD' }),
  ]);
  eq(same.amount, 175, 'a single-currency batch DOES total');
  eq(same.mixedCurrencies, false, 'and is not flagged mixed');
  eq(same.currency, 'USD', 'carrying the currency');

  // (b) NOTHING PRICED — $0.00 would read as five free orders.
  const unpriced = bufferUp([
    buy('u1', { value: null }), buy('u2', { value: null }), buy('u3', { value: null }),
    buy('u4', { value: null }), buy('u5', { value: null }),
  ]);
  eq(unpriced.count, 5, 'the all-unpriced batch counts all five');
  eq(unpriced.amount, null, 'and refuses a total (was $0.00 — "five free orders")');
  eq(unpriced.unpriced, 5, 'reporting how many were unpriced');
  eq(unpriced.priced, 0, 'and that none carried a price');

  // Partially priced: a real total, plus the shortfall.
  const partial = bufferUp([
    buy('p1', { value: 10, currency: 'USD' }), buy('p2', { value: 20, currency: 'USD' }),
    buy('p3', { value: null, currency: 'USD' }), buy('p4', { value: null, currency: 'USD' }),
    buy('p5', { value: null, currency: 'USD' }),
  ]);
  eq(partial.amount, 30, 'a partly-priced batch totals what it CAN');
  eq(partial.unpriced, 3, 'and says how many it could not');
  eq(partial.priced, 2, 'and how many it could');

  // A batch with no currency recorded at all. (Three events: at or below
  // BUFFER_SAMPLE the buffer replays VERBATIM instead of aggregating, so a
  // two-event batch would return the first toast, not a summary.)
  const noCur = bufferUp([
    buy('n1', { value: 10, currency: null }),
    buy('n2', { value: 20, currency: null }),
    buy('n3', { value: null, currency: null }),
  ]);
  eq(noCur.aggregate, true, 'three events DO aggregate');
  eq(noCur.amount, 30, 'amounts with no currency still total');
  eq(noCur.currency, null, 'but the unit stays unknown');
  eq(M.fmtMoneyParts(noCur.amount, noCur.currency).hasCurrency, false,
    'so it renders bare, never as dollars');
}

// ═══ 6c. F3 — the batch path (reconnect after an absence) ══════════════════
// useLiveFeed CLOSES the stream while the tab is hidden, so events never
// trickle in behind the operator's back — the whole gap lands at once in the
// reconnect's snapshot backfill. That made the hidden-tab buffer dead code and
// meant a 20-minute absence produced a wall of toasts and one chime per sale.
// The buffer is now reached by BATCHING that backfill instead.
console.log('\n── 6c. batch coalescing (F3) ──');
{
  // The batch path is pushToast(hidden:true) x N followed by one flush — the
  // same primitives usePaymentToasts.pushBatch composes.
  const batch = (n) => {
    let s = M.createToastState();
    for (let i = 0; i < n; i++) {
      s = M.pushToast(s, purchase(`b${i}`, { value: 10, currency: 'USD' }), { hidden: true }).state;
    }
    return M.flushBuffer(s);
  };

  const many = batch(23);
  eq(many.emitted.length, 1, '23 backfilled sales produce ONE toast, not 23');
  eq(many.emitted[0].aggregate, true, 'and it is the summary row');
  eq(many.emitted[0].count, 23, 'carrying the true count');
  eq(many.emitted[0].amount, 230, 'and the real total');
  eq(many.state.toasts.length, 1, 'the stack holds exactly one row');

  // A short glance away still replays verbatim — two sales should look normal.
  const few = batch(2);
  eq(few.emitted.length, 2, 'two backfilled sales replay VERBATIM');
  ok(few.emitted.every((t) => !t.aggregate), 'neither is a summary');

  // Alert gating over the same batch: every key is consumed, so the NEXT tick
  // is silent even though the chime itself only sounds once.
  let a = M.createAlertState();
  const evs = Array.from({ length: 23 }, (_, i) => purchase(`b${i}`));
  let allowed = 0;
  for (const ev of evs) {
    const r = M.shouldAlert(a, ev);
    a = r.state;
    if (r.allowed) allowed++;
  }
  eq(allowed, 23, 'all 23 pass the gate (so all 23 dedupe keys are consumed)');
  let again = 0;
  for (const ev of evs) {
    const r = M.shouldAlert(a, ev);
    a = r.state;
    if (r.allowed) again++;
  }
  eq(again, 0, 'and a re-delivery of the same backfill is entirely silent');
}

// ═══ 7. alert gating ═══════════════════════════════════════════════════════
console.log('\n── 7. alert gating ──');
{
  const s0 = M.createAlertState();
  eq(M.shouldAlert(s0, purchase('a1')).allowed, true, 'a fresh purchase rings');
  eq(M.shouldAlert(s0, purchase('a1'), { muted: true }).reason, 'muted', 'muted suppresses');
  eq(M.shouldAlert(s0, purchase('a1'), { volume: 0 }).reason, 'zero_volume',
    'a zero slider suppresses — and is named DIFFERENTLY from a mute');
  eq(M.shouldAlert(s0, purchase('a1'), { armed: false }).reason, 'not_armed', 'unarmed suppresses');
  eq(M.shouldAlert(s0, purchase('a1'), { supported: false }).reason, 'unsupported', 'no WebAudio suppresses');
  eq(M.shouldAlert(s0, { id: 'v', type: 'view' }).reason, 'not_payment', 'a pageview never rings');
  eq(M.shouldAlert(s0, { id: 'k', type: 'checkout_start', value: 99 }).reason, 'not_payment',
    'a checkout START never rings (an intention is not revenue)');
  eq(M.shouldAlert(s0, { type: 'purchase' }).reason, 'no_key', 'an id-less purchase never rings');
  eq(M.shouldAlert(s0, null).reason, 'not_payment', 'a null event never rings');

  // A suppressed alert must NOT consume the dedupe slot, or unmuting goes
  // silent for every event that arrived while muted.
  const muted = M.shouldAlert(s0, purchase('a2'), { muted: true });
  eq(muted.state.fired.length, 0, 'a suppressed alert does not burn its dedupe key');
  eq(M.shouldAlert(muted.state, purchase('a2')).allowed, true, 'so it rings once unmuted');

  const r1 = M.shouldAlert(s0, purchase('a3'));
  eq(M.shouldAlert(r1.state, purchase('a3')).reason, 'duplicate', 'the same event rings only once');
  eq(M.shouldAlert(r1.state, purchase('a3', { upsell: true })).allowed, true, 'its upsell is a separate ring');

  let big = M.createAlertState();
  for (let i = 0; i < M.ALERT_DEDUPE_MAX + 40; i++) big = M.shouldAlert(big, purchase(`f${i}`)).state;
  ok(big.fired.length <= M.ALERT_DEDUPE_MAX, `fired set stays bounded (${big.fired.length})`);

  // Volume clamping
  eq(M.clampVolume(-1), 0, 'volume clamps at 0');
  eq(M.clampVolume(5), 1, 'volume clamps at 1');
  eq(M.clampVolume(0.3), 0.3, 'a valid volume passes through');
  for (const junk of [null, undefined, 'loud', NaN, {}])
    eq(M.clampVolume(junk), M.VOLUME_DEFAULT, `clampVolume(${JSON.stringify(junk)}) → default`);
}

// ═══ 8. toast view-model ═══════════════════════════════════════════════════
console.log('\n── 8. toast view-model ──');
{
  const t = M.toastFromEvent(purchase('c_9', { value: 129.5, currency: 'EUR' }));
  eq(t.amount, 129.5, 'amount comes off value');
  eq(t.currency, 'EUR', 'currency is carried');
  eq(t.where, 'Breast Lift', 'where is the funnel name');
  eq(t.page, 'Checkout', 'page is carried');
  eq(t.country, null, 'no country on our wire today → null, NOT a guessed location');

  const t2 = M.toastFromEvent(purchase('c_10', { value: null }));
  eq(t2.amount, null, 'an unrecorded amount is null, NEVER 0 (0 would mean "free")');

  const t3 = M.toastFromEvent(purchase('c_11', { funnel_name: null, funnel_id: 'abcdefghijklmnop' }));
  eq(t3.where, 'funnel abcdefghijkl…', 'a nameless funnel degrades to a truncated id');

  // Opportunistic: lights up for free if a future additive server field lands.
  const t4 = M.toastFromEvent(purchase('c_12', { country: 'gb' }));
  eq(t4.country, 'GB', 'a country, if ever present, is normalised');
  eq(t4.countryLabel, 'United Kingdom', 'and labelled');

  eq(M.fmtMoney(59, 'USD'), '$59.00', 'fmtMoney formats');
  eq(M.fmtMoney(null), null, 'fmtMoney(null) → null (the caller renders a dash)');
  eq(M.fmtMoney(0, 'USD'), '$0.00', 'fmtMoney(0, USD) is $0.00 — zero is a real amount');
  ok(typeof M.fmtMoney(10, 'NOTACURRENCY') === 'string',
    'a bogus ISO code falls back instead of throwing RangeError');

  // F4(c): an UNRECORDED currency is never dressed up as dollars.
  eq(M.fmtMoney(59), '59.00', 'no currency ⇒ a BARE number, never a $ we did not read');
  eq(M.fmtMoney(59, null), '59.00', 'an explicit null currency is bare too');
  eq(M.fmtMoney(59, '  '), '59.00', 'a whitespace currency is bare too');
  eq(M.fmtMoneyParts(59, null).hasCurrency, false, 'and the caller is TOLD the unit is unknown');
  eq(M.fmtMoneyParts(59, 'USD').hasCurrency, true, 'a real currency reports true');
  eq(M.fmtMoneyParts(59, 'jpy').currency, 'JPY', 'the code is normalised upward');
  eq(M.fmtMoneyParts(null, 'USD').text, null, 'a null amount still yields no text');
  eq(M.fmtInt(null), '—', 'fmtInt(null) → dash, never 0');
  eq(M.fmtInt(1234), '1,234', 'fmtInt groups');

  const now = Date.parse('2026-08-09T12:00:00Z');
  eq(M.timeAgo('2026-08-09T11:59:58Z', now), 'just now', 'timeAgo: just now');
  eq(M.timeAgo('2026-08-09T11:59:00Z', now), '1m ago', 'timeAgo: minutes');
  eq(M.timeAgo('2026-08-08T12:00:00Z', now), '1d ago', 'timeAgo: days');
  eq(M.timeAgo(null, now), '', 'timeAgo(null) → empty');
  eq(M.timeAgo('not a date', now), '', 'timeAgo of garbage → empty, not "NaN ago"');
  eq(M.timeAgo('2026-08-09T12:00:30Z', now), 'just now', 'a future ts clamps to just now, never negative');
}

// ═══ 9. rail freshness ═════════════════════════════════════════════════════
console.log('\n── 9. rail freshness ──');
{
  const feed = [{ id: 'a' }, { id: 'b' }];
  const first = M.diffFreshIds(null, feed);
  eq(first.fresh, [], 'FIRST paint flashes nothing (the backfill is not news)');
  eq(first.ids, ['a', 'b'], 'first paint still records the baseline');

  const second = M.diffFreshIds(first.ids, [{ id: 'c' }, { id: 'a' }, { id: 'b' }]);
  eq(second.fresh, ['c'], 'only the genuinely new row flashes');
  eq(M.diffFreshIds(second.ids, feed).fresh, [], 'a shrinking feed flashes nothing');
  eq(M.diffFreshIds([], []).fresh, [], 'empty → empty');
  eq(M.diffFreshIds(['a'], null).ids, [], 'a null feed is not a throw');
  eq(M.diffFreshIds(['a'], [{}, { id: 'z' }]).ids, ['z'], 'rows without an id are skipped');
}

// ═══ 10. land ring data ════════════════════════════════════════════════════
console.log('\n── 10. land rings ──');
{
  ok(LAND_RINGS.length > 100, `${LAND_RINGS.length} land rings bundled`);
  let badPt = 0, shortRing = 0;
  for (const r of LAND_RINGS) {
    if (r.length < 8 || r.length % 2 !== 0) shortRing++;
    for (let i = 0; i < r.length; i += 2) {
      if (!Number.isFinite(r[i]) || r[i] < -180 || r[i] > 180) badPt++;
      if (!Number.isFinite(r[i + 1]) || r[i + 1] < -90 || r[i + 1] > 90) badPt++;
    }
  }
  eq(shortRing, 0, 'every ring is an even-length list of at least 4 points');
  eq(badPt, 0, 'every land coordinate is finite and in range');
}

// ═══ 11. immutability ══════════════════════════════════════════════════════
// The React components hold these states in refs and compare them; a function
// that mutated its input would produce a stale-render bug that no amount of
// staring at JSX would find.
console.log('\n── 11. purity ──');
{
  const s = M.createToastState();
  const before = JSON.stringify(s);
  M.pushToast(s, purchase('p1'));
  M.markExiting(s, 'pt1');
  M.removeToast(s, 'pt1');
  M.seedSeen(s, [purchase('p2')]);
  M.flushBuffer(s);
  eq(JSON.stringify(s), before, 'the toast state is never mutated in place');

  const a = M.createAlertState();
  const aBefore = JSON.stringify(a);
  M.shouldAlert(a, purchase('p3'));
  eq(JSON.stringify(a), aBefore, 'the alert state is never mutated in place');

  const geo = { by_country: [{ country: 'US', visitors: 3 }] };
  const gBefore = JSON.stringify(geo);
  M.deriveGeoPoints(geo);
  eq(JSON.stringify(geo), gBefore, 'deriveGeoPoints does not mutate its input');

  // seedSeen arms the dedupe so a reconnect's backfill cannot re-toast.
  const seeded = M.seedSeen(M.createToastState(), [purchase('r1'), { id: 'v', type: 'view' }]);
  eq(seeded.seen, ['paid:r1'], 'seedSeen records purchases only');
  eq(M.pushToast(seeded, purchase('r1')).reason, 'duplicate', 'a seeded event does not toast on reconnect');
}

console.log(`\n${pass}/${pass + fail} passed`);
assert.equal(fail, 0, `${fail} assertion(s) failed`);
