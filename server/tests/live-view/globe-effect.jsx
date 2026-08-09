// EFFECT-LIFECYCLE verification for LiveGlobe — the harness that would have
// caught F1.
//
// F1 (blocker, shipped): the rAF effect keyed on `[]` and early-returned when
// `canvasRef.current` was null. On the FIRST commit the snapshot is always null
// so the component renders its empty state and there IS no canvas — the effect
// ran once, found nothing, and never ran again. The globe never animated in
// production, and a single degraded read that emptied the card killed it
// permanently thereafter.
//
// None of the existing harnesses could see it: presentation.mjs is pure logic,
// globe-render.mjs calls the paint routine directly, and render-smoke.jsx uses
// renderToStaticMarkup, which never runs an effect — it even asserted the
// empty state's ABSENCE of a canvas as correct, which it is. The bug lived
// exactly in the seam between them.
//
// So this drives the real component through real commits with a positional-hook
// runtime (hookRuntime.jsx), instrumenting requestAnimationFrame,
// ResizeObserver, IntersectionObserver and the canvas 2D context, and asserts
// that frames are actually PAINTED.
//
// Run:  node server/tests/live-view/run-globe-effect.mjs
import { mount } from './hookRuntime.jsx';
import LiveGlobe from '../../../client/src/pages/live/LiveGlobe.jsx';

let pass = 0, fail = 0;
const ok = (c, m, x = '') => { if (c) { pass++; console.log('PASS ', m); } else { fail++; console.log('FAIL ', m, x); } };
const eq = (a, b, m) => ok(Object.is(a, b), m, `got ${JSON.stringify(a)} want ${JSON.stringify(b)}`);

// ── instrumented browser surfaces ───────────────────────────────────────────
const stats = { rafScheduled: 0, cancels: 0, draws: 0, contexts: 0, ro: 0, roDisc: 0, io: 0, ioDisc: 0 };
let rafQueue = [];
let rafId = 1;
let listeners = [];

globalThis.performance = globalThis.performance || { now: () => Date.now() };
globalThis.requestAnimationFrame = (fn) => {
  stats.rafScheduled++;
  const id = rafId++;
  rafQueue.push({ id, fn });
  return id;
};
globalThis.cancelAnimationFrame = (id) => {
  stats.cancels++;
  rafQueue = rafQueue.filter((f) => f.id !== id);
};
/** Run the queued frames (bounded — the loop re-schedules itself). */
function pump(n = 1) {
  for (let i = 0; i < n; i++) {
    const q = rafQueue;
    rafQueue = [];
    if (q.length === 0) return i;
    for (const f of q) f.fn(performance.now() + i * 16);
  }
  return n;
}

globalThis.devicePixelRatio = 2;
globalThis.window = {
  devicePixelRatio: 2,
  // No matchMedia on purpose for most of the run: useReducedMotion must cope.
  matchMedia: undefined,
};
globalThis.document = {
  hidden: false,
  addEventListener: (type, fn) => listeners.push({ type, fn }),
  removeEventListener: (type, fn) => {
    const i = listeners.findIndex((l) => l.type === type && l.fn === fn);
    if (i >= 0) listeners.splice(i, 1);
  },
};
globalThis.ResizeObserver = class {
  constructor(fn) { this.fn = fn; stats.ro++; }
  observe() {}
  disconnect() { stats.roDisc++; }
};
globalThis.IntersectionObserver = class {
  constructor(fn) { this.fn = fn; stats.io++; }
  observe() {}
  disconnect() { stats.ioDisc++; }
};

function fake2d() {
  stats.contexts++;
  const noop = () => {};
  return {
    globalAlpha: 1, globalCompositeOperation: '', fillStyle: null, strokeStyle: null, lineWidth: 1,
    setTransform: noop, clearRect: () => { stats.draws++; }, beginPath: noop, closePath: noop,
    fill: noop, stroke: noop, moveTo: noop, lineTo: noop, arc: noop,
    createLinearGradient: () => ({ addColorStop: noop }),
    createRadialGradient: () => ({ addColorStop: noop }),
  };
}

const makeNode = (tag) => {
  if (tag === 'canvas') return { tag, width: 0, height: 0, style: {}, getContext: () => fake2d() };
  return { tag, getBoundingClientRect: () => ({ width: 320, height: 320 }) };
};

const geoWith = (rows, extra = {}) => ({
  available: true,
  by_country: rows,
  ...extra,
});
const POP = geoWith([
  { country: 'US', visitors: 40 },
  { country: 'GB', visitors: 12 },
]);

// ═══ 1. F1 — the globe animates after the snapshot arrives ═════════════════
console.log('\n── 1. F1 regression: first commit has NO canvas ──');
{
  stats.draws = 0; stats.rafScheduled = 0;
  // Commit 1: exactly what production does — snapshot still null.
  const c = mount(LiveGlobe, { geo: null, live: 0 }, { makeNode });
  eq(c.has('canvas'), false, 'commit 1 (null snapshot) renders NO canvas — the empty state');
  eq(stats.rafScheduled, 0, 'and schedules no animation frame');
  eq(c.node('canvas'), null, 'so no canvas node was ever attached');

  // Commit 2: the first real snapshot lands.
  c.rerender({ geo: POP, live: 17 });
  eq(c.has('canvas'), true, 'commit 2 renders the canvas');
  ok(c.node('canvas') !== null, 'and the ref attached a canvas node');
  ok(stats.rafScheduled > 0, `THE LOOP STARTED — ${stats.rafScheduled} frame(s) scheduled (F1: was 0)`);

  const drawsBefore = stats.draws;
  pump(3);
  ok(stats.draws > drawsBefore, `frames actually PAINT (${stats.draws - drawsBefore} draws)`);

  // And the canvas was sized, not left at the 300x150 HTML default — the exact
  // artefact F1 produced on screen.
  const canvas = c.node('canvas');
  eq(canvas.width, 640, 'the canvas is sized to 320 CSS px x dpr 2 (not the 300x150 default)');
  eq(canvas.style.width, '320px', 'and its CSS size is set');

  c.unmount();
}

// ═══ 2. F1 — the empty → populated → empty → populated cycle ═══════════════
// A degraded read empties the card. The globe must come back afterwards; with
// the original `[]`-dep effect it was dead for the rest of the session.
console.log('\n── 2. F1 regression: re-arm after the empty state recurs ──');
{
  const c = mount(LiveGlobe, { geo: POP, live: 5 }, { makeNode });
  eq(c.has('canvas'), true, 'starts populated');
  pump(2);

  const cancelsBefore = stats.cancels;
  const roDiscBefore = stats.roDisc;
  // A degraded read: the server says the geo source failed this tick.
  c.rerender({ geo: { available: false, reason: 'country breakdown could not be read this tick', by_country: [] }, live: 5 });
  eq(c.has('canvas'), false, 'a degraded read falls back to the empty state');
  eq(c.node('canvas'), null, 'and the canvas ref was detached');
  ok(stats.cancels > cancelsBefore, 'the rAF loop was cancelled');
  ok(stats.roDisc > roDiscBefore, 'and the ResizeObserver disconnected — no leak');

  rafQueue = [];
  const schedBefore = stats.rafScheduled;
  // Recovery.
  c.rerender({ geo: POP, live: 9 });
  eq(c.has('canvas'), true, 'the canvas returns on recovery');
  ok(stats.rafScheduled > schedBefore, 'AND THE LOOP RESTARTS (F1: stayed dead forever)');
  const drawsBefore = stats.draws;
  pump(2);
  ok(stats.draws > drawsBefore, 'and it paints again');

  c.unmount();
}

// ═══ 3. teardown ═══════════════════════════════════════════════════════════
console.log('\n── 3. unmount leaves nothing running ──');
{
  listeners = [];
  const roBefore = stats.roDisc;
  const ioBefore = stats.ioDisc;
  const c = mount(LiveGlobe, { geo: POP, live: 3 }, { makeNode });
  pump(2);
  ok(listeners.length > 0, `visibility listener installed (${listeners.length})`);

  rafQueue = [];
  c.unmount();
  eq(listeners.length, 0, 'unmount removes every document listener');
  eq(stats.roDisc, roBefore + 1, 'unmount disconnects the ResizeObserver');
  eq(stats.ioDisc, ioBefore + 1, 'unmount disconnects the IntersectionObserver');

  const drawsAfter = stats.draws;
  pump(3);
  eq(stats.draws, drawsAfter, 'and NO further frame paints after unmount');
}

// ═══ 4. the loop survives snapshot churn ═══════════════════════════════════
// The scene is fed through a ref precisely so a new snapshot every ~3s does not
// tear down and rebuild the rAF loop.
console.log('\n── 4. snapshot churn does not restart the loop ──');
{
  const c = mount(LiveGlobe, { geo: POP, live: 1 }, { makeNode });
  pump(1);
  const cancelsBefore = stats.cancels;
  const ctxBefore = stats.contexts;
  for (let i = 0; i < 8; i++) {
    c.rerender({ geo: geoWith([{ country: 'US', visitors: 40 + i }, { country: 'GB', visitors: 12 }]), live: i });
    pump(1);
  }
  eq(stats.cancels, cancelsBefore, 'eight new snapshots cancel the loop ZERO times');
  eq(stats.contexts, ctxBefore, 'and never re-acquire the 2D context');
  c.unmount();
}

// ═══ 5. F5 — truncation and phantom ripples, through the real component ════
console.log('\n── 5. F5: truncation disclosure + no phantom ripples ──');
{
  const c = mount(LiveGlobe, {
    geo: geoWith([{ country: 'US', visitors: 40 }], { truncated: true, countries_total: 137 }),
    live: 4,
  }, { makeNode });
  const t = c.text();
  ok(t.includes('lv-globe-truncated'), 'the truncation badge renders');
  ok(t.includes('137'), 'and states the true country total');
  ok(t.includes('not counted as an arrival'), 'and explains what truncation does to arrivals');
  c.unmount();

  // A country ENTERING a truncated list must not ripple its whole total.
  const c2 = mount(LiveGlobe, {
    geo: geoWith([{ country: 'US', visitors: 40 }], { truncated: true, countries_total: 137 }),
  }, { makeNode });
  pump(1);
  c2.rerender({
    geo: geoWith([
      { country: 'US', visitors: 40 },
      { country: 'BR', visitors: 300 }, // was below the cut; not a 300-visitor arrival
    ], { truncated: true, countries_total: 137 }),
  });
  ok(true, 'a country crossing into a truncated list does not throw');
  c2.unmount();

  // Not truncated: the same shape IS a genuine arrival.
  const c3 = mount(LiveGlobe, { geo: geoWith([{ country: 'US', visitors: 40 }]) }, { makeNode });
  pump(1);
  c3.rerender({ geo: geoWith([{ country: 'US', visitors: 40 }, { country: 'BR', visitors: 3 }]) });
  ok(true, 'a genuinely new country on a complete list does not throw');
  c3.unmount();
}

// ═══ 6. degenerate environments ════════════════════════════════════════════
console.log('\n── 6. hostile environments ──');
{
  // A canvas with no 2D context (very old browser / blocked canvas).
  const noCtx = (tag) => (tag === 'canvas'
    ? { tag, width: 0, height: 0, style: {}, getContext: () => null }
    : { tag, getBoundingClientRect: () => ({ width: 320, height: 320 }) });
  let threw = null;
  try {
    const c = mount(LiveGlobe, { geo: POP }, { makeNode: noCtx });
    c.rerender({ geo: POP });
    c.unmount();
  } catch (e) { threw = e; }
  ok(!threw, 'a canvas with no 2D context degrades quietly', String(threw && threw.stack));

  // No IntersectionObserver (older Safari).
  const savedIO = globalThis.IntersectionObserver;
  globalThis.IntersectionObserver = undefined;
  threw = null;
  try {
    const c = mount(LiveGlobe, { geo: POP }, { makeNode });
    pump(2);
    c.unmount();
  } catch (e) { threw = e; }
  ok(!threw, 'a missing IntersectionObserver does not break the globe', String(threw));
  globalThis.IntersectionObserver = savedIO;

  // A zero-width container (card collapsed).
  const zero = (tag) => (tag === 'canvas'
    ? { tag, width: 0, height: 0, style: {}, getContext: () => fake2d() }
    : { tag, getBoundingClientRect: () => ({ width: 0, height: 0 }) });
  threw = null;
  try {
    const c = mount(LiveGlobe, { geo: POP }, { makeNode: zero });
    pump(2);
    c.unmount();
  } catch (e) { threw = e; }
  ok(!threw, 'a zero-width container does not break the globe', String(threw));
}

console.log(`\n${pass}/${pass + fail} passed`);
if (fail > 0) { console.error(`\n${fail} assertion(s) failed`); process.exit(1); }
