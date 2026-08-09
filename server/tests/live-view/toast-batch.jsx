// Direct verification of usePaymentToasts.pushBatch + useSaleAlerts.fireMany —
// the COMPOSITION, not the pure functions underneath.
//
// This closes the same seam that let F1 ship: presentation.mjs proves the queue
// primitives and render-smoke proves the markup, but nothing exercised the hook
// that decides HOW those primitives are composed. N2 lived exactly there —
// pushBatch passed hidden:true unconditionally, so three purchases arriving in
// one live SSE frame were announced as "3 payments while you were away", which
// is a false statement about the operator, not about the data.
//
// Driven through hookRuntime.jsx (real commits, real effects, real timers).
//
// Run:  node server/tests/live-view/run-toast-batch.mjs
import { mount } from './hookRuntime.jsx';
import usePaymentToasts from '../../../client/src/pages/live/usePaymentToasts.js';
import useSaleAlerts from '../../../client/src/pages/live/useSaleAlerts.js';
import chaChing from '../../../client/src/pages/live/chaChing.js';

let pass = 0, fail = 0;
const ok = (c, m, x = '') => { if (c) { pass++; console.log('PASS ', m); } else { fail++; console.log('FAIL ', m, x); } };
const eq = (a, b, m) => ok(Object.is(a, b), m, `got ${JSON.stringify(a)} want ${JSON.stringify(b)}`);

// ── browser stubs ───────────────────────────────────────────────────────────
const store = new Map();
globalThis.localStorage = {
  getItem: (k) => (store.has(k) ? store.get(k) : null),
  setItem: (k, v) => store.set(k, String(v)),
  removeItem: (k) => store.delete(k),
};
let listeners = [];
globalThis.document = {
  hidden: false,
  addEventListener: (t, fn) => listeners.push({ t, fn }),
  removeEventListener: (t, fn) => {
    const i = listeners.findIndex((l) => l.t === t && l.fn === fn);
    if (i >= 0) listeners.splice(i, 1);
  },
};
let winListeners = [];
let plays = 0;
class FakeAudioContext {
  constructor() { this.state = 'running'; this.currentTime = 0; this.sampleRate = 48000; this.destination = {}; }
  _n() {
    return {
      connect() {}, disconnect() {},
      gain: { setValueAtTime() {}, exponentialRampToValueAtTime() {}, value: 0 },
      frequency: { setValueAtTime() {} }, Q: { value: 0 },
      start() {}, stop() {}, onended: null,
    };
  }
  createGain() { return this._n(); }
  createOscillator() { return this._n(); }
  createBiquadFilter() { return this._n(); }
  createBufferSource() { return this._n(); }
  createBuffer(c, f) { return { getChannelData: () => new Float32Array(f) }; }
  resume() { return Promise.resolve(); }
  close() { return Promise.resolve(); }
}
globalThis.window = {
  AudioContext: FakeAudioContext,
  addEventListener: (t, fn) => winListeners.push({ t, fn }),
  removeEventListener: (t, fn) => {
    const i = winListeners.findIndex((l) => l.t === t && l.fn === fn);
    if (i >= 0) winListeners.splice(i, 1);
  },
};

const realPlay = chaChing.play;
chaChing.play = (...a) => { plays++; return realPlay.apply(chaChing, a); };

const buy = (id, over = {}) => ({
  id, type: 'purchase', ts: '2026-08-10T10:00:00.000Z',
  funnel_id: 'f1', funnel_name: 'Breast Lift', page_title: 'Checkout',
  value: 10, currency: 'USD', upsell: false, ...over,
});

// A host component so the hooks run inside a real render/commit cycle.
function Host() {
  const toasts = usePaymentToasts();
  const alerts = useSaleAlerts();
  Host.api = { toasts, alerts };
  return { $$el: true, type: 'div', props: {} };
}

// ARM BOTH GATES, as LiveViewPage does on the first snapshot. The toast queue
// has its own arming (seedAndArm) separate from the chime's (arm); arming only
// one leaves the other silently suppressing everything.
const boot = () => {
  const h = mount(Host, {});
  Host.api.toasts.seedAndArm([]);
  Host.api.alerts.arm();
  h.rerender({});
  return h;
};

// ═══ 1. N2 — a VISIBLE-tab batch must not claim the operator was away ══════
console.log('\n── 1. N2: visible-tab batching ──');
{
  document.hidden = false;
  const h = boot();
  const { toasts } = Host.api;

  // Three purchases in ONE live SSE frame, operator watching.
  toasts.pushBatch([buy('v1'), buy('v2'), buy('v3')]);
  h.rerender({});
  const list = Host.api.toasts.toasts;
  eq(list.length, 1, 'three live sales coalesce into ONE toast (the cap is respected)');
  eq(list[0].aggregate, true, 'as a summary row');
  eq(list[0].count, 3, 'carrying the true count');
  eq(list[0].away, false, 'and away === FALSE — the operator was watching (N2)');
  h.unmount();
}

// ═══ 2. a genuinely hidden tab DOES earn the away wording ══════════════════
console.log('\n── 2. hidden tab ──');
{
  document.hidden = true;
  const h = boot();
  Host.api.toasts.pushBatch([buy('h1'), buy('h2'), buy('h3')]);
  h.rerender({});
  const list = Host.api.toasts.toasts;
  eq(list[0].away, true, 'a hidden tab DOES earn "while you were away"');
  eq(list[0].count, 3, 'with the right count');
  h.unmount();
  document.hidden = false;
}

// ═══ 3. an explicit resync flag earns it even on a visible tab ═════════════
console.log('\n── 3. explicit fromResync ──');
{
  document.hidden = false;
  const h = boot();
  Host.api.toasts.pushBatch([buy('r1'), buy('r2'), buy('r3')], { fromResync: true });
  h.rerender({});
  eq(Host.api.toasts.toasts[0].away, true,
    'a caller that KNOWS it is draining a reconnect gap can say so');
  h.unmount();
}

// ═══ 4. pushBatch composition ══════════════════════════════════════════════
console.log('\n── 4. pushBatch composition ──');
{
  document.hidden = false;
  let h = boot();

  // A single event takes the ORDINARY path — never summarised as "1 payment".
  Host.api.toasts.pushBatch([buy('s1')]);
  h.rerender({});
  let list = Host.api.toasts.toasts;
  eq(list.length, 1, 'a one-event batch emits one toast');
  eq(Boolean(list[0].aggregate), false, 'and it is NOT an aggregate row');
  eq(list[0].where, 'Breast Lift', 'it is the ordinary per-event toast');
  h.unmount();

  // Two events replay verbatim (at/below BUFFER_SAMPLE).
  h = boot();
  Host.api.toasts.pushBatch([buy('t1'), buy('t2')]);
  h.rerender({});
  list = Host.api.toasts.toasts;
  eq(list.length, 2, 'a two-event batch replays VERBATIM');
  ok(list.every((t) => !t.aggregate), 'with no summary row');
  h.unmount();

  // A big batch is bounded by the stack cap.
  h = boot();
  const many = Array.from({ length: 40 }, (_, i) => buy(`m${i}`));
  const accepted = Host.api.toasts.pushBatch(many);
  h.rerender({});
  eq(accepted, 40, 'all 40 were accepted into the buffer');
  eq(Host.api.toasts.toasts.length, 1, 'and 40 sales still produce exactly ONE toast');
  eq(Host.api.toasts.toasts[0].count, 40, 'reporting all 40');
  eq(Host.api.toasts.toasts[0].amount, 400, 'with the real total');

  // Re-delivery of the same batch is silent (dedupe survives batching).
  const again = Host.api.toasts.pushBatch(many);
  h.rerender({});
  eq(again, 0, 'a re-delivered batch is entirely deduped');
  eq(Host.api.toasts.toasts.length, 1, 'and adds no toast');
  h.unmount();

  // Degenerate inputs.
  h = boot();
  eq(Host.api.toasts.pushBatch([]), 0, 'an empty batch is a no-op');
  eq(Host.api.toasts.pushBatch(null), 0, 'a null batch is a no-op');
  eq(Host.api.toasts.pushBatch([{ id: 'v', type: 'view' }, { id: 'k', type: 'checkout_start' }]), 0,
    'a batch of non-payments emits nothing');
  h.rerender({});
  eq(Host.api.toasts.toasts.length, 0, 'and leaves the stack empty');
  h.unmount();
}

// ═══ 5. fireMany — one chime for a batch ═══════════════════════════════════
console.log('\n── 5. fireMany ──');
{
  document.hidden = false;
  chaChing.setMuted(false);
  await chaChing.prime();

  let h = boot();
  plays = 0;
  const evs = Array.from({ length: 25 }, (_, i) => buy(`f${i}`));
  const allowed = Host.api.alerts.fireMany(evs);
  eq(allowed, 25, 'all 25 pass the gate (so all 25 dedupe keys are consumed)');
  eq(plays, 1, 'but the chime sounds exactly ONCE for the batch');

  // The whole point of consuming the keys: the next delivery is silent.
  plays = 0;
  eq(Host.api.alerts.fireMany(evs), 0, 're-delivering the same batch allows nothing');
  eq(plays, 0, 'and plays nothing');
  h.unmount();

  // Muted: no sound, and no keys burned, so unmuting still rings later.
  h = boot();
  chaChing.setMuted(true);
  plays = 0;
  eq(Host.api.alerts.fireMany([buy('mm1'), buy('mm2')]), 0, 'muted allows nothing');
  eq(plays, 0, 'and plays nothing');
  chaChing.setMuted(false);
  eq(Host.api.alerts.fireMany([buy('mm1')]), 1, 'and the suppressed event still rings once unmuted');
  h.unmount();

  // A batch of non-payments never rings.
  h = boot();
  plays = 0;
  eq(Host.api.alerts.fireMany([{ id: 'v1', type: 'view' }, { id: 'c1', type: 'checkout_start', value: 99 }]), 0,
    'views and checkout starts never ring');
  eq(plays, 0, 'no chime');
  eq(Host.api.alerts.fireMany(null), 0, 'a null batch is a no-op');
  h.unmount();

  // Unarmed: nothing rings before the first snapshot has been applied.
  const un = mount(Host, {}); // deliberately NOT armed (no arm(), no seedAndArm)
  plays = 0;
  eq(Host.api.alerts.fireMany([buy('ua1'), buy('ua2')]), 0, 'an UNARMED board rings nothing');
  eq(plays, 0, 'no chime before arming');
  un.unmount();
}

// ═══ 6. teardown ═══════════════════════════════════════════════════════════
console.log('\n── 6. teardown ──');
{
  document.hidden = false;
  listeners = [];
  winListeners = [];
  const h = boot();
  Host.api.toasts.pushBatch([buy('z1'), buy('z2'), buy('z3')]);
  h.rerender({});
  ok(listeners.length > 0, `document listeners installed (${listeners.length})`);

  const timersBefore = process.getActiveResourcesInfo().filter((r) => r === 'Timeout').length;
  ok(timersBefore > 0, `the toast owns a live dismiss timer (${timersBefore})`);

  h.unmount();
  eq(listeners.length, 0, 'unmount removes every document listener');
  const timersAfter = process.getActiveResourcesInfo().filter((r) => r === 'Timeout').length;
  ok(timersAfter < timersBefore, `and clears the pending toast timers (${timersBefore} → ${timersAfter})`);

  // reset() must also clear everything without an unmount (funnel switch).
  const h2 = boot();
  Host.api.toasts.pushBatch([buy('q1'), buy('q2'), buy('q3')]);
  h2.rerender({});
  ok(Host.api.toasts.toasts.length > 0, 'a funnel switch starts with toasts on screen');
  Host.api.toasts.reset();
  h2.rerender({});
  eq(Host.api.toasts.toasts.length, 0, 'reset() clears the stack');
  h2.unmount();
}

console.log(`\n${pass}/${pass + fail} passed`);
if (fail > 0) { console.error(`\n${fail} assertion(s) failed`); process.exit(1); }
