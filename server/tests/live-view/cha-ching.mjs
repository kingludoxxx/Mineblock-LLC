// Verification for the sale chime module — client/src/pages/live/chaChing.js.
//
// This module owns the two things on the page that leak if you get them wrong:
// document-level gesture listeners and an AudioContext. Neither is reachable
// from a pure-logic harness, so the browser surfaces it needs are stubbed here
// and its LIFECYCLE is exercised for real.
//
// The single highest-stakes assertion is the snapshot cache. chaChing is
// consumed through useSyncExternalStore, whose contract is that getSnapshot()
// returns a referentially stable value until something actually changes. A
// fresh object literal per call would put React into an infinite render loop —
// a bug that shows up as a hung browser tab, not as a failed build.
//
// Run:  node server/tests/live-view/cha-ching.mjs
import assert from 'node:assert';

let pass = 0, fail = 0;
const ok = (c, m, x = '') => { if (c) { pass++; console.log('PASS ', m); } else { fail++; console.log('FAIL ', m, x); } };
const eq = (a, b, m) => ok(Object.is(a, b), m, `got ${JSON.stringify(a)} want ${JSON.stringify(b)}`);

// ── browser stubs, installed BEFORE the module is imported ──────────────────
const store = new Map();
globalThis.localStorage = {
  getItem: (k) => (store.has(k) ? store.get(k) : null),
  setItem: (k, v) => store.set(k, String(v)),
  removeItem: (k) => store.delete(k),
  clear: () => store.clear(),
};

const listeners = []; // every addEventListener that has not been removed
globalThis.document = {
  addEventListener: (type, fn, opts) => listeners.push({ type, fn, opts }),
  removeEventListener: (type, fn) => {
    const i = listeners.findIndex((l) => l.type === type && l.fn === fn);
    if (i >= 0) listeners.splice(i, 1);
  },
};

let ctxCount = 0;
let closedCount = 0;
const nodes = { osc: 0, gain: 0, buffer: 0, filter: 0, started: 0, stopped: 0, disconnected: 0 };

class FakeAudioContext {
  constructor() { ctxCount++; this.state = 'running'; this.currentTime = 0; this.sampleRate = 48000; this.destination = { _d: 1 }; }
  _node(kind) {
    nodes[kind]++;
    return {
      connect: () => {}, disconnect: () => { nodes.disconnected++; },
      gain: { setValueAtTime: () => {}, exponentialRampToValueAtTime: () => {}, value: 0 },
      frequency: { setValueAtTime: () => {} },
      Q: { value: 0 },
      start: () => { nodes.started++; }, stop: () => { nodes.stopped++; },
      onended: null, type: '', buffer: null,
    };
  }
  createGain() { return this._node('gain'); }
  createOscillator() { return this._node('osc'); }
  createBiquadFilter() { return this._node('filter'); }
  createBufferSource() { return this._node('buffer'); }
  createBuffer(ch, frames) { return { getChannelData: () => new Float32Array(frames) }; }
  resume() { this.state = 'running'; return Promise.resolve(); }
  close() { closedCount++; this.state = 'closed'; return Promise.resolve(); }
}
globalThis.window = { AudioContext: FakeAudioContext };

const cc = (await import('../../../client/src/pages/live/chaChing.js')).default;

// ═══ 1. the snapshot cache ═════════════════════════════════════════════════
console.log('\n── 1. snapshot stability (useSyncExternalStore contract) ──');
{
  const a = cc.getSnapshot();
  const b = cc.getSnapshot();
  ok(a === b, 'two getSnapshot() calls return the IDENTICAL object (else React loops forever)');
  eq(a.muted, false, 'defaults to audible');
  eq(a.volume, 0.5, 'defaults to half volume');

  cc.setVolume(0.5); // same value
  ok(cc.getSnapshot() === a, 'setting a field to its CURRENT value does not churn the snapshot');

  cc.setVolume(0.8);
  const c = cc.getSnapshot();
  ok(c !== a, 'a real change produces a new snapshot');
  eq(c.volume, 0.8, 'with the new value');
  ok(Object.isFrozen(c), 'the snapshot is frozen — a consumer cannot corrupt the store');
}

// ═══ 2. persistence ════════════════════════════════════════════════════════
console.log('\n── 2. persistence ──');
{
  eq(store.get('lv:sound-volume'), '0.8', 'volume is persisted under its own key');
  eq(cc.getVolume(), 0.8, 'and read back');

  cc.setMuted(true);
  eq(store.get('lv:sound-muted'), '1', 'mute is persisted');
  eq(cc.isMuted(), true, 'and read back');
  cc.setMuted(false);
  ok(!store.has('lv:sound-muted'), 'unmuting REMOVES the key rather than writing "0"');

  eq(cc.toggleMuted(), true, 'toggle returns the new state');
  eq(cc.isMuted(), true, 'and applies it');
  cc.setMuted(false);

  // Clamping at the boundary.
  eq(cc.setVolume(5), 1, 'an over-range volume clamps to 1');
  eq(cc.setVolume(-2), 0, 'an under-range volume clamps to 0');
  eq(cc.setVolume('nonsense'), 0.5, 'an unparseable volume falls back to the default');

  // A hostile localStorage (private mode / disabled cookies) must not throw.
  const good = globalThis.localStorage;
  globalThis.localStorage = {
    getItem() { throw new Error('SecurityError'); },
    setItem() { throw new Error('SecurityError'); },
    removeItem() { throw new Error('SecurityError'); },
  };
  let threw = null;
  try {
    cc.setVolume(0.3); cc.setMuted(true); cc.getVolume(); cc.isMuted();
  } catch (e) { threw = e; }
  ok(!threw, 'a throwing localStorage never propagates', String(threw));
  eq(cc.isMuted(), false, 'and an unreadable preference defaults to AUDIBLE, not silent');
  eq(cc.getVolume(), 0.5, 'and to half volume, not zero');
  globalThis.localStorage = good;
  store.clear();
}

// ═══ 3. subscriptions ══════════════════════════════════════════════════════
console.log('\n── 3. subscriptions ──');
{
  let hits = 0;
  const off = cc.subscribe(() => { hits++; });
  cc.setVolume(0.25);
  eq(hits, 1, 'a subscriber is notified on change');
  cc.setVolume(0.25);
  eq(hits, 1, 'but NOT on a no-op change');
  off();
  cc.setVolume(0.75);
  eq(hits, 1, 'an unsubscribed listener stops receiving — no leak');

  // A broken subscriber must not take the others (or the sound) down.
  const seen = [];
  const offBad = cc.subscribe(() => { throw new Error('boom'); });
  const offGood = cc.subscribe(() => seen.push(1));
  let threw = null;
  try { cc.setVolume(0.1); } catch (e) { threw = e; }
  ok(!threw, 'a throwing subscriber does not propagate', String(threw));
  eq(seen.length, 1, 'and the other subscribers still run');
  offBad(); offGood();
}

// ═══ 4. gesture-unlock listener lifecycle ══════════════════════════════════
console.log('\n── 4. gesture listeners ──');
{
  eq(listeners.length, 0, 'no listeners are installed at rest');

  const cleanup = cc.installGestureUnlock();
  eq(listeners.length, 3, 'three gesture listeners are installed (pointer, key, touch)');
  ok(listeners.every((l) => l.opts && l.opts.once && l.opts.capture && l.opts.passive),
    'each is capture + once + passive');

  const again = cc.installGestureUnlock();
  eq(listeners.length, 3, 'a second install is a no-op — listeners do not accumulate');

  cleanup();
  eq(listeners.length, 0, 'the returned cleanup removes EVERY listener');
  again(); // must be safe to call the stale handle
  eq(listeners.length, 0, 'calling a stale cleanup twice is harmless');

  // The real-world path: a gesture fires, and the handler removes the rest.
  cc.installGestureUnlock();
  eq(listeners.length, 3, 'reinstalled after cleanup');
  const first = listeners[0];
  first.fn(); // simulate the user clicking
  eq(listeners.length, 0, 'the first gesture removes all three listeners itself');
}

// ═══ 5. play() ═════════════════════════════════════════════════════════════
console.log('\n── 5. play ──');
{
  cc.setMuted(false);
  cc.setVolume(0.5);
  await cc.prime();
  eq(cc.getState(), 'ready', 'priming opens a running context');
  eq(ctxCount, 1, 'exactly ONE AudioContext is created');

  const before = { ...nodes };
  eq(await cc.play(), 'played', 'a ring plays');
  ok(nodes.osc > before.osc, 'oscillators were created');
  ok(nodes.started > before.started, 'and started');
  eq(nodes.started, nodes.stopped, 'EVERY started node is also stopped — nothing runs forever');

  cc.setMuted(true);
  eq(await cc.play(), 'muted', 'a muted board does not ring');
  eq(await cc.play({ force: true }), 'played', 'but force overrides the mute (the test button)');
  cc.setMuted(false);

  eq(await cc.play({ volume: 0 }), 'muted', 'a zero volume is silence, not a crash');

  // Burst: the scheduler staggers rings and drops what it cannot fit.
  const results = [];
  for (let i = 0; i < 40; i++) results.push(await cc.play());
  ok(results.includes('dropped'), 'a long burst DROPS rings rather than queueing minutes of chimes');
  ok(results.filter((r) => r === 'played').length < 40, 'so not every ring in a burst sounds');

  eq(nodes.started, nodes.stopped, 'after a burst, started still equals stopped');

  // No AudioContext at all.
  const savedWin = globalThis.window;
  globalThis.window = {};
  cc.dispose();
  eq(await cc.play(), 'unsupported', 'no AudioContext ⇒ "unsupported", never a throw');
  eq(cc.isSupported(), false, 'and isSupported reports it');
  globalThis.window = savedWin;
}

// ═══ 6. dispose ════════════════════════════════════════════════════════════
console.log('\n── 6. dispose ──');
{
  cc.dispose();
  const closedBefore = closedCount;
  const ctxBefore = ctxCount;
  await cc.prime();
  eq(ctxCount, ctxBefore + 1, 'prime after dispose opens a fresh context');
  cc.installGestureUnlock();
  ok(listeners.length > 0, 'with listeners installed');

  cc.dispose();
  eq(closedCount, closedBefore + 1, 'dispose CLOSES the AudioContext');
  eq(listeners.length, 0, 'and removes the gesture listeners');
  eq(cc.getState(), 'idle', 'and resets the state');

  let threw = null;
  try { cc.dispose(); cc.dispose(); } catch (e) { threw = e; }
  ok(!threw, 'dispose is idempotent', String(threw));
}

console.log(`\n${pass}/${pass + fail} passed`);
assert.equal(fail, 0, `${fail} assertion(s) failed`);
