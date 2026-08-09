// useSaleAlerts — the operator's sound switch, and the gate in front of it.
//
// Port of funnel-os's useSaleAlerts.js, minus the desktop-notification half
// (that needs a Notification permission prompt and a secure-context story we
// have not designed; it is a follow-up, not a silent omission) and PLUS a
// volume control, which the reference never had — it hardcoded 0.5.
//
// All the gating lives in livePresentation.shouldAlert so it can be proven by
// `node server/tests/live-view/presentation.mjs`. This hook is the wiring:
// subscribe to the chime module, mirror its state into React, and clean up.
//
// WHY UNMOUNT DOES NOT CLOSE THE AUDIOCONTEXT: browsers only unlock audio from
// a user gesture. Closing the context on unmount would silently re-lock the
// board every time the operator visited another page and came back, and the
// next sale would go unheard until they clicked something. The context is a
// module singleton with a bounded graph (see chaChing's leak contract); what
// this hook DOES own — subscriptions, the gesture hook, window listeners — is
// released in full below.
import { useCallback, useEffect, useRef, useState, useSyncExternalStore } from 'react';
import chaChing from './chaChing.js';
import { createAlertState, shouldAlert, clampVolume } from './livePresentation.js';

export default function useSaleAlerts() {
  // useSyncExternalStore, not useState+useEffect: the chime module IS an
  // external store (it owns the AudioContext and the localStorage round-trip),
  // and this is the API that subscribes without a cascading setState-in-effect
  // and without a tear between render and subscription.
  const { state: soundState, muted, volume } = useSyncExternalStore(
    chaChing.subscribe,
    chaChing.getSnapshot,
    chaChing.getSnapshot, // no SSR in this app; same value keeps hydration honest
  );
  const [armed, setArmed] = useState(false);

  // The dedupe ledger lives in a ref: it must survive re-renders without
  // causing them, and it must never be part of the render output.
  const gateRef = useRef(createAlertState());
  // `armed` is mirrored into a ref because `fire` is called from a stream
  // callback that closes over its creation-time render. Written from `arm`
  // (an event handler), never during render — React 19 forbids the latter.
  const armedRef = useRef(false);

  // NOTE there is deliberately NO mutedRef/volumeRef. The chime module is the
  // single source of truth for both (it owns the localStorage round-trip), and
  // `fire` reads it directly at call time. Mirroring them into refs bought
  // nothing and opened a staleness gap between the switch and the sound.

  // The ONLY effect: arm the browser's gesture-unlock listener and take it
  // back down on unmount. The store subscription is handled above.
  useEffect(() => chaChing.installGestureUnlock(), []);

  /**
   * Offer an event to the chime. Synchronous, returns the gate's reason string
   * (useful in the console and in tests), and CANNOT throw — a failing sound
   * must never take a revenue board down.
   */
  const fire = useCallback((ev) => {
    const vol = chaChing.getVolume();
    const r = shouldAlert(gateRef.current, ev, {
      muted: chaChing.isMuted(),
      volume: vol,
      armed: armedRef.current,
      supported: chaChing.isSupported(),
    });
    gateRef.current = r.state;
    if (!r.allowed) return r.reason;
    try {
      // Deliberately not awaited and deliberately caught.
      Promise.resolve(chaChing.play({ volume: vol })).catch(() => {});
    } catch { /* sound is never load-bearing */ }
    return r.reason;
  }, []);

  /** Arm after the first snapshot — otherwise a reconnect replays the day. */
  const arm = useCallback(() => {
    armedRef.current = true;
    setArmed(true);
  }, []);

  const toggleMute = useCallback(() => {
    const nowMuted = chaChing.toggleMuted();
    if (!nowMuted) {
      // Unmuting IS a user gesture — spend it unlocking the context and
      // confirming audibly, so the operator learns the switch works now and
      // not at the next sale.
      chaChing.prime().then(() => chaChing.play({ volume: chaChing.getVolume() })).catch(() => {});
    }
  }, []);

  const setVolume = useCallback((v) => {
    chaChing.setVolume(clampVolume(v));
  }, []);

  /** Commit a slider drag: persist and preview, from inside the gesture. */
  const previewVolume = useCallback((v) => {
    const vol = chaChing.setVolume(clampVolume(v));
    if (vol > 0 && !chaChing.isMuted()) {
      chaChing.prime().then(() => chaChing.play({ volume: vol, force: true })).catch(() => {});
    }
  }, []);

  const enable = useCallback(async () => {
    try {
      await chaChing.prime();
      if (chaChing.isMuted()) chaChing.setMuted(false);
      await chaChing.play({ volume: chaChing.getVolume(), force: true });
    } catch { /* subscribers already reflect whatever happened */ }
  }, []);

  const test = useCallback(() => {
    chaChing.prime().then(() => chaChing.play({ volume: chaChing.getVolume(), force: true })).catch(() => {});
  }, []);

  return {
    fire,
    arm,
    armed,
    sound: {
      state: soundState,
      muted,
      volume,
      supported: soundState !== 'unsupported' && chaChing.isSupported(),
      // "locked" is not a failure — it is a browser waiting for a click. The
      // UI says so with an explicit unlock affordance instead of going quiet.
      needsUnlock: soundState === 'locked' && !muted,
      enable,
      toggleMute,
      setVolume,
      previewVolume,
      test,
    },
  };
}
