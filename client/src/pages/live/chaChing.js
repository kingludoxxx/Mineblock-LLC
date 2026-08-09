// chaChing — the sale chime, synthesised.
//
// Port of funnel-os's lib/chaChing.js. The sound is GENERATED with WebAudio:
// zero bytes shipped, zero requests, no binary asset in the repo, and nothing
// a CSP `media-src` rule can block. Structure = a band-passed noise transient
// (the "cha") plus two inharmonic bell strikes 90 ms apart (the "ching").
//
// Module-level singleton on purpose: an AudioContext is a scarce, per-tab
// resource, and browsers only let one be unlocked by a user gesture. A hook
// that opened one per mount would re-lock the audio every time the operator
// navigated away and back.
//
// LIFECYCLE / LEAK CONTRACT (this page has had immortal-poll bugs before):
//   • every oscillator and buffer source is `stop()`ed at a known time and
//     disconnects itself in `onended` — nothing accumulates in the graph;
//   • the per-ring master gain is disconnected on a timer sized to the ring;
//   • the gesture-unlock listeners are `once` + self-removing, and the
//     installer returns its own cleanup;
//   • `dispose()` closes the context outright — called by the harness and by
//     nothing else (see useSaleAlerts for why an unmount must NOT close it).
import { clampVolume, VOLUME_DEFAULT } from './livePresentation.js';

const MUTE_KEY = 'lv:sound-muted';     // "1" when muted; key REMOVED when audible
const VOLUME_KEY = 'lv:sound-volume';  // "0".."1"
const RING_SPACING_S = 0.28;           // min gap between two rings in a burst
const MAX_LOOKAHEAD_S = 1.5;           // queued further out than this → dropped

let ctx = null;
// Starts LOCKED, not 'idle'. Every browser blocks audio until a user gesture,
// so "locked" is the truthful description of a fresh page — and it is what
// makes SaleAlertControls show its "Enable sound" affordance BEFORE the first
// sale is missed rather than after. 'idle' rendered as if sound were working.
let state = 'locked'; // locked | ready | unsupported
let nextSlot = 0;
let primingPromise = null;
let gestureCleanup = null;
let warned = false;

const subscribers = new Set();
// Outstanding master-gain teardown timers, so dispose() can cancel them.
const pendingTimers = new Set();

function warnOnce(...args) {
  if (warned) return;
  warned = true;
  console.warn('[live-view/chaChing]', ...args);
}

function AudioCtor() {
  if (typeof window === 'undefined') return null;
  return window.AudioContext || window.webkitAudioContext || null;
}

export function isSupported() {
  return AudioCtor() !== null;
}

// CACHED SNAPSHOT. This module is consumed through useSyncExternalStore, whose
// contract is that getSnapshot() returns a REFERENTIALLY STABLE value until
// something actually changes — returning a fresh object literal each call
// makes React re-render forever. So the object is rebuilt only in emit(), and
// only when a field really moved.
let snapshot = null;

function buildSnapshot() {
  return Object.freeze({ state, muted: isMuted(), volume: getVolume() });
}

export function getSnapshot() {
  if (!snapshot) snapshot = buildSnapshot();
  return snapshot;
}

function emit() {
  const next = buildSnapshot();
  const prev = snapshot;
  if (prev && prev.state === next.state && prev.muted === next.muted && prev.volume === next.volume) {
    return; // nothing moved — do not churn React
  }
  snapshot = next;
  for (const fn of subscribers) {
    try { fn(next); } catch { /* a broken listener must never break the sound */ }
  }
}

function setState(next) {
  if (state === next) return;
  state = next;
  emit();
}

export function subscribe(fn) {
  subscribers.add(fn);
  return () => subscribers.delete(fn);
}

export function getState() { return state; }

// ── persisted preferences ───────────────────────────────────────────────────
// Storage can throw (private mode, disabled cookies, cross-origin iframe).
// Every read defaults to AUDIBLE AT HALF VOLUME, because failing to read a
// preference is not the operator asking for silence.

export function isMuted() {
  try { return localStorage.getItem(MUTE_KEY) === '1'; } catch { return false; }
}

export function setMuted(muted) {
  try {
    if (muted) localStorage.setItem(MUTE_KEY, '1');
    else localStorage.removeItem(MUTE_KEY);
  } catch { /* not persisted this session — still emit so the UI reflects intent */ }
  emit();
  return Boolean(muted);
}

export function toggleMuted() { return setMuted(!isMuted()); }

export function getVolume() {
  try { return clampVolume(localStorage.getItem(VOLUME_KEY)); } catch { return VOLUME_DEFAULT; }
}

export function setVolume(v) {
  const vol = clampVolume(v);
  try { localStorage.setItem(VOLUME_KEY, String(vol)); } catch { /* see above */ }
  emit();
  return vol;
}

// ── the context ─────────────────────────────────────────────────────────────

export function prime() {
  const Ctor = AudioCtor();
  if (!Ctor) { setState('unsupported'); return Promise.resolve(state); }
  if (primingPromise) return primingPromise; // concurrent calls share one promise

  primingPromise = (async () => {
    try {
      if (!ctx) {
        ctx = new Ctor();
        nextSlot = 0;
        try {
          // Some engines only surface the unlock through this callback.
          ctx.onstatechange = () => {
            if (!ctx) return;
            setState(ctx.state === 'running' ? 'ready' : 'locked');
          };
        } catch { /* noop */ }
      }
      if (ctx.state !== 'running') {
        try { await ctx.resume(); } catch { /* not from a gesture — stays suspended */ }
      }
      setState(ctx.state === 'running' ? 'ready' : 'locked');
    } catch (e) {
      warnOnce('could not open an AudioContext:', e);
      ctx = null;
      setState('unsupported');
    } finally {
      primingPromise = null;
    }
    return state;
  })();

  return primingPromise;
}

/**
 * Unlock on the first user gesture anywhere on the page.
 * capture + once + passive, self-removing; returns its own cleanup so an
 * unmounting hook can pull the listeners even if no gesture ever came.
 */
export function installGestureUnlock() {
  if (gestureCleanup || typeof document === 'undefined') return gestureCleanup || (() => {});
  if (!isSupported()) { setState('unsupported'); return () => {}; }

  const events = ['pointerdown', 'keydown', 'touchend'];
  const onGesture = () => { cleanup(); prime(); };
  const cleanup = () => {
    for (const ev of events) {
      try { document.removeEventListener(ev, onGesture, true); } catch { /* noop */ }
    }
    gestureCleanup = null;
  };
  for (const ev of events) {
    try {
      document.addEventListener(ev, onGesture, { capture: true, once: true, passive: true });
    } catch { /* noop */ }
  }
  gestureCleanup = cleanup;
  return cleanup;
}

/** Tear the context down completely. Harness + hard reset only. */
export function dispose() {
  const c = ctx;
  ctx = null;
  nextSlot = 0;
  primingPromise = null;
  if (gestureCleanup) gestureCleanup();
  // Every pending master-gain disconnect timer dies with the context —
  // otherwise dispose() leaves timers pointing at a closed graph.
  for (const t of pendingTimers) clearTimeout(t);
  pendingTimers.clear();
  setState('locked'); // back to the pre-gesture state, not a fake 'idle'
  if (c) {
    try { c.onstatechange = null; c.close(); } catch { /* noop */ }
  }
}

// ── synthesis ───────────────────────────────────────────────────────────────

/** One bell strike: sine partials → shared lowpass → exponential decay. */
function strike(dest, t0, partials, { peak, decay, bright }) {
  const tone = ctx.createGain();
  tone.gain.setValueAtTime(0.0001, t0);
  tone.gain.exponentialRampToValueAtTime(Math.max(peak, 0.0002), t0 + 0.006);
  tone.gain.exponentialRampToValueAtTime(0.0001, t0 + decay);

  // A gentle low-pass keeps the top partials from sounding like a smoke alarm.
  const lp = ctx.createBiquadFilter();
  lp.type = 'lowpass';
  lp.frequency.setValueAtTime(bright, t0);
  lp.Q.value = 0.7;

  tone.connect(lp);
  lp.connect(dest);

  for (const [freq, gain] of partials) {
    const osc = ctx.createOscillator();
    osc.type = 'sine';
    osc.frequency.setValueAtTime(freq, t0);
    const g = ctx.createGain();
    g.gain.setValueAtTime(gain, t0);
    osc.connect(g);
    g.connect(tone);
    osc.start(t0);
    osc.stop(t0 + decay + 0.05);
    osc.onended = () => {
      try { osc.disconnect(); g.disconnect(); } catch { /* noop */ }
    };
  }
  return decay;
}

/** The mechanical "cha": 50 ms of cubically-decaying noise through a bandpass. */
function transient(dest, t0) {
  const dur = 0.05;
  const frames = Math.max(1, Math.floor(ctx.sampleRate * dur));
  const buf = ctx.createBuffer(1, frames, ctx.sampleRate);
  const data = buf.getChannelData(0);
  for (let i = 0; i < frames; i++) {
    data[i] = (Math.random() * 2 - 1) * (1 - i / frames) ** 3;
  }
  const src = ctx.createBufferSource();
  src.buffer = buf;

  const bp = ctx.createBiquadFilter();
  bp.type = 'bandpass';
  bp.frequency.setValueAtTime(2600, t0);
  bp.Q.value = 1.1;

  const g = ctx.createGain();
  g.gain.setValueAtTime(0.16, t0);
  g.gain.exponentialRampToValueAtTime(0.0001, t0 + dur);

  src.connect(bp); bp.connect(g); g.connect(dest);
  src.start(t0);
  src.stop(t0 + dur + 0.01);
  src.onended = () => {
    try { src.disconnect(); bp.disconnect(); g.disconnect(); } catch { /* noop */ }
  };
}

/**
 * Ring once.
 * Returns 'played' | 'muted' | 'locked' | 'unsupported' | 'dropped' | 'error'.
 * NEVER throws: the sound is decoration, and decoration must not take the
 * board down.
 */
export async function play(opts = {}) {
  const { volume = getVolume(), force = false } = opts;
  try {
    if (!force && isMuted()) return 'muted';
    if (!isSupported()) { setState('unsupported'); return 'unsupported'; }
    if (!ctx || ctx.state !== 'running') await prime();
    if (!ctx || ctx.state !== 'running') {
      if (state !== 'unsupported') setState('locked');
      return state === 'unsupported' ? 'unsupported' : 'locked';
    }

    const vol = clampVolume(volume);
    if (vol <= 0) return 'muted'; // a slider at rest is silence, not a crash

    const now = ctx.currentTime;
    // Stagger a burst instead of stacking every ring on the same instant —
    // ten simultaneous chimes is a klaxon, not ten sales.
    const t0 = Math.max(now, nextSlot);
    if (t0 - now > MAX_LOOKAHEAD_S) return 'dropped';
    nextSlot = t0 + RING_SPACING_S;

    const master = ctx.createGain();
    master.gain.setValueAtTime(vol, t0);
    master.connect(ctx.destination);

    transient(master, t0);
    // Strike 1 — the "cha": A5 + E6 + A6, short.
    strike(master, t0, [[880, 0.5], [1318.5, 0.28], [1760, 0.12]], {
      peak: 0.5, decay: 0.2, bright: 5200,
    });
    // Strike 2 — the "ching": E6 + B6 + E7 + A7, brighter, rings out.
    const tail = strike(master, t0 + 0.09,
      [[1318.5, 0.5], [1975.5, 0.3], [2637, 0.16], [3520, 0.07]],
      { peak: 0.55, decay: 0.62, bright: 7200 });

    const endsAt = t0 + 0.09 + tail + 0.1;
    const timer = setTimeout(() => {
      pendingTimers.delete(timer);
      try { master.disconnect(); } catch { /* noop */ }
    }, Math.max(0, (endsAt - ctx.currentTime) * 1000) + 60);
    pendingTimers.add(timer);

    return 'played';
  } catch (e) {
    warnOnce('play failed:', e);
    return 'error';
  }
}

export default {
  isSupported, subscribe, getState, getSnapshot, prime, dispose, play,
  isMuted, setMuted, toggleMuted, getVolume, setVolume, installGestureUnlock,
};
