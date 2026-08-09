// Verification for the globe's PAINT routine — client/src/pages/live/globeRender.js.
//
// The projection maths is proven in presentation.mjs and the components are
// proven in render-smoke.jsx, but neither of those ever executes a single
// canvas call. This does: it drives drawGlobe with a recording fake 2D context
// and asserts what was actually drawn.
//
// What it is really guarding:
//   • the far hemisphere is NEVER painted (without the pen-lift at the limb,
//     the back of the globe is drawn straight across the front and the whole
//     thing looks like a ball of wool);
//   • no drawn coordinate escapes the disc;
//   • one marker per visible country, sized by sqrt(share);
//   • ripples expire, and the reverse-iteration splice does not skip any;
//   • zero data still paints a sphere and does not throw.
//
// Run:  node server/tests/live-view/globe-render.mjs
import assert from 'node:assert';

const { drawGlobe, RIPPLE_MS } = await import('../../../client/src/pages/live/globeRender.js');
const { LAND_RINGS } = await import('../../../client/src/pages/live/worldLand.js');
const { COUNTRY_CENTROIDS } = await import('../../../client/src/pages/live/countryCentroids.js');

let pass = 0, fail = 0;
const ok = (c, m, x = '') => { if (c) { pass++; console.log('PASS ', m); } else { fail++; console.log('FAIL ', m, x); } };
const eq = (a, b, m) => ok(Object.is(a, b), m, `got ${a} want ${b}`);

/** A recording CanvasRenderingContext2D stand-in. */
function fakeCtx() {
  const calls = [];
  const pts = [];   // every coordinate handed to moveTo/lineTo/arc
  const rec = (op) => (...args) => { calls.push([op, ...args]); };
  const ctx = {
    calls, pts,
    globalAlpha: 1, globalCompositeOperation: 'source-over',
    fillStyle: null, strokeStyle: null, lineWidth: 1,
    setTransform: rec('setTransform'),
    clearRect: rec('clearRect'),
    beginPath: rec('beginPath'),
    closePath: rec('closePath'),
    fill: rec('fill'),
    stroke: rec('stroke'),
    moveTo: (x, y) => { calls.push(['moveTo', x, y]); pts.push([x, y]); },
    lineTo: (x, y) => { calls.push(['lineTo', x, y]); pts.push([x, y]); },
    arc: (x, y, r, a, b) => { calls.push(['arc', x, y, r, a, b]); pts.push([x, y]); },
    createLinearGradient: (...a) => { calls.push(['createLinearGradient', ...a]); return { addColorStop() {} }; },
    createRadialGradient: (...a) => { calls.push(['createRadialGradient', ...a]); return { addColorStop() {} }; },
  };
  return ctx;
}

const count = (ctx, op) => ctx.calls.filter((c) => c[0] === op).length;

const SIZE = 320;
const OPTS = { size: SIZE, dpr: 2, rotation: 0, tilt: 18, now: 1000, landRings: LAND_RINGS };
const centroid = (cc) => ({ lat: COUNTRY_CENTROIDS[cc][0], lon: COUNTRY_CENTROIDS[cc][1] });

// ═══ 1. it runs at all ═════════════════════════════════════════════════════
console.log('\n── 1. a full frame ──');
{
  const ctx = fakeCtx();
  const scene = {
    points: [
      { ...centroid('US'), country: 'US', visitors: 40 },
      { ...centroid('GB'), country: 'GB', visitors: 10 },
    ],
    ripples: [],
    max: 40,
  };
  let threw = null;
  let out = null;
  try { out = drawGlobe(ctx, scene, OPTS); } catch (e) { threw = e; }
  ok(!threw, 'a full frame paints without throwing', String(threw && threw.stack));

  eq(ctx.calls[0][0], 'setTransform', 'the frame starts by setting the DPR transform');
  eq(ctx.calls[0][1], 2, 'the DPR transform carries the device ratio');
  eq(ctx.calls[1][0], 'clearRect', 'and clears the canvas');
  ok(count(ctx, 'stroke') > 20, `the graticule + land + limb stroke a lot (${count(ctx, 'stroke')})`);
  ok(out.landDrawn > 40, `land rings were painted (${out.landDrawn} of ${LAND_RINGS.length})`);
  ok(out.landDrawn < LAND_RINGS.length,
    'but NOT all of them — the far hemisphere is skipped, which is the whole point');
  eq(out.markersDrawn, 2, 'both visible countries got a marker');
  eq(ctx.globalAlpha, 1, 'globalAlpha is restored at the end of the frame');
  eq(ctx.globalCompositeOperation, 'source-over', 'the composite mode is restored');
}

// ═══ 2. nothing escapes the disc ═══════════════════════════════════════════
console.log('\n── 2. containment ──');
{
  let worst = 0;
  let nonFinite = 0;
  for (let rot = 0; rot < 360; rot += 41) {
    const ctx = fakeCtx();
    const scene = {
      points: Object.keys(COUNTRY_CENTROIDS).map((cc) => ({ ...centroid(cc), country: cc, visitors: 5 })),
      ripples: [],
      max: 5,
    };
    drawGlobe(ctx, scene, { ...OPTS, rotation: rot });
    const cx = SIZE / 2, cy = SIZE / 2, r = (SIZE / 2) * 0.86;
    for (const [x, y] of ctx.pts) {
      if (!Number.isFinite(x) || !Number.isFinite(y)) { nonFinite++; continue; }
      worst = Math.max(worst, Math.hypot(x - cx, y - cy) - r);
    }
  }
  eq(nonFinite, 0, 'no non-finite coordinate is ever handed to the canvas');
  // The marker HALO arc is intentionally larger than its centre point, so a
  // small overshoot at the limb is expected; a wild one is a projection bug.
  ok(worst < 25, `no path point escapes the disc beyond the marker halo (worst +${worst.toFixed(2)}px)`);
}

// ═══ 3. the far hemisphere is never painted ════════════════════════════════
console.log('\n── 3. hemisphere culling ──');
{
  // With rotation 0 / tilt 0, longitude 0 faces the viewer and +/-180 is behind.
  const ctx = fakeCtx();
  drawGlobe(ctx, {
    points: [
      { lat: 0, lon: 0, visitors: 10 },     // dead centre, visible
      { lat: 0, lon: 180, visitors: 10 },   // antipode, hidden
      { lat: 0, lon: 150, visitors: 10 },   // hidden
    ],
    ripples: [],
    max: 10,
  }, { ...OPTS, rotation: 0, tilt: 0, landRings: [] });
  eq(ctx.calls.filter((c) => c[0] === 'createRadialGradient').length, 1,
    'only the front-facing country is drawn — the two behind the globe are culled');
}

// ═══ 4. marker sizing ══════════════════════════════════════════════════════
console.log('\n── 4. marker sizing ──');
{
  const ctx = fakeCtx();
  drawGlobe(ctx, {
    points: [{ lat: 0, lon: 0, visitors: 40 }],
    ripples: [], max: 40,
  }, { ...OPTS, rotation: 0, tilt: 0, landRings: [] });
  // The last arc of a marker is its solid core.
  const arcs = ctx.calls.filter((c) => c[0] === 'arc');
  const core = arcs[arcs.length - 1];
  eq(Math.round(core[3] * 100) / 100, 8, 'a full-share marker has the max core radius (2 + 6)');

  const ctx2 = fakeCtx();
  drawGlobe(ctx2, {
    points: [{ lat: 0, lon: 0, visitors: 10 }],
    ripples: [], max: 40,
  }, { ...OPTS, rotation: 0, tilt: 0, landRings: [] });
  const arcs2 = ctx2.calls.filter((c) => c[0] === 'arc');
  const core2 = arcs2[arcs2.length - 1];
  // sqrt(10/40) = 0.5 ⇒ 2 + 3 = 5. Area, not radius, tracks the count.
  eq(Math.round(core2[3] * 100) / 100, 5, 'a quarter-share marker scales by SQRT, not linearly');

  // A zero/negative count must not produce a NaN radius.
  const ctx3 = fakeCtx();
  let threw = null;
  try {
    drawGlobe(ctx3, { points: [{ lat: 0, lon: 0, visitors: -3 }], ripples: [], max: 0 },
      { ...OPTS, rotation: 0, tilt: 0, landRings: [] });
  } catch (e) { threw = e; }
  ok(!threw, 'a negative count / zero max does not throw', String(threw));
  ok(ctx3.pts.every(([x, y]) => Number.isFinite(x) && Number.isFinite(y)),
    'and produces no NaN coordinate');
}

// ═══ 5. ripples ════════════════════════════════════════════════════════════
console.log('\n── 5. ripples ──');
{
  const now = 10_000;
  const ripples = [
    { lat: 0, lon: 0, at: now },                  // brand new
    { lat: 0, lon: 0, at: now - RIPPLE_MS / 2 },  // half way
    { lat: 0, lon: 0, at: now - RIPPLE_MS - 1 },  // expired
    { lat: 0, lon: 0, at: now - RIPPLE_MS * 3 },  // long expired
  ];
  const ctx = fakeCtx();
  const out = drawGlobe(ctx, { points: [], ripples, max: 1 },
    { ...OPTS, now, rotation: 0, tilt: 0, landRings: [] });
  eq(out.ripplesDrawn, 2, 'only the live ripples are drawn');
  eq(ripples.length, 2, 'the expired ones are spliced out of the caller-owned array');
  ok(ripples.every((r) => now - r.at <= RIPPLE_MS), 'and the survivors are the LIVE ones');

  // Every ripple expired at once — the classic forward-splice skip.
  const allDead = [
    { lat: 0, lon: 0, at: 0 }, { lat: 0, lon: 0, at: 0 },
    { lat: 0, lon: 0, at: 0 }, { lat: 0, lon: 0, at: 0 }, { lat: 0, lon: 0, at: 0 },
  ];
  drawGlobe(fakeCtx(), { points: [], ripples: allDead, max: 1 },
    { ...OPTS, now: 999_999, landRings: [] });
  eq(allDead.length, 0, 'a whole expired batch is removed — reverse iteration skips none');

  // A ripple behind the globe is not drawn but is NOT dropped either.
  const behind = [{ lat: 0, lon: 180, at: now }];
  const out2 = drawGlobe(fakeCtx(), { points: [], ripples: behind, max: 1 },
    { ...OPTS, now, rotation: 0, tilt: 0, landRings: [] });
  eq(out2.ripplesDrawn, 0, 'a ripple on the far side is not painted');
  eq(behind.length, 1, 'but it survives to be painted when the globe turns');
}

// ═══ 6. the empty / degenerate frame ═══════════════════════════════════════
console.log('\n── 6. zero data ──');
{
  const ctx = fakeCtx();
  let threw = null;
  let out = null;
  try { out = drawGlobe(ctx, { points: [], ripples: [], max: 1 }, OPTS); } catch (e) { threw = e; }
  ok(!threw, 'ZERO countries paints without throwing', String(threw));
  eq(out.markersDrawn, 0, 'and draws no markers');
  ok(out.landDrawn > 0, 'but still paints the Earth — an empty board is not a blank card');
  ok(count(ctx, 'fill') > 0, 'the sphere itself is filled');

  // Missing scene keys entirely.
  for (const scene of [{}, { points: null, ripples: null }]) {
    let t = null;
    try { drawGlobe(fakeCtx(), scene, OPTS); } catch (e) { t = e; }
    ok(!t, `drawGlobe(${JSON.stringify(scene)}) does not throw`, String(t));
  }

  // A degenerate canvas size (the card collapsed to nothing).
  let t2 = null;
  try { drawGlobe(fakeCtx(), { points: [{ lat: 0, lon: 0, visitors: 1 }], ripples: [], max: 1 }, { ...OPTS, size: 0 }); } catch (e) { t2 = e; }
  ok(!t2, 'a zero-size canvas does not throw', String(t2));
}

// ═══ 7. rotation actually moves things ═════════════════════════════════════
console.log('\n── 7. rotation ──');
{
  // NOTE: keyed off the RETURNED marker count, not off "the last arc". The
  // sphere and the limb are also arcs, so when a marker is culled the last arc
  // is the limb at cx — which reads as a marker sitting dead centre.
  const at = (rot) => {
    const ctx = fakeCtx();
    const out = drawGlobe(ctx, { points: [{ lat: 0, lon: 0, visitors: 1 }], ripples: [], max: 1 },
      { ...OPTS, rotation: rot, tilt: 0, landRings: [] });
    if (out.markersDrawn === 0) return null;
    const arcs = ctx.calls.filter((c) => c[0] === 'arc');
    return arcs[arcs.length - 1][1];
  };
  const a = at(0), b = at(45);
  ok(a !== null && b !== null && Math.abs(a - b) > 1, 'rotating the globe moves the marker');
  eq(at(180), null, 'rotating a point to the far side culls it');
}

console.log(`\n${pass}/${pass + fail} passed`);
assert.equal(fail, 0, `${fail} assertion(s) failed`);
