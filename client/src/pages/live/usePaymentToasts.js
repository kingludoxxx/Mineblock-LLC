// usePaymentToasts — the React shell around livePresentation's toast queue.
//
// Port of funnel-os's usePaymentToasts.js. Every decision (cap, dedupe,
// hidden-tab coalescing, what counts as a payment) lives in the pure module so
// it is provable by `node server/tests/live-view/presentation.mjs`; this file
// owns only the two things a pure function cannot: React state and TIMERS.
//
// TIMER CONTRACT — this page has had immortal-poll bugs, so it is spelled out:
//   • every toast owns at most two timers (hide, then remove);
//   • a toast evicted by the cap has its timers cleared in the SAME tick —
//     pushToast returns the evicted keys precisely so nothing has to be swept
//     up later by a scanning effect;
//   • unmount clears EVERY outstanding timer and drops the listeners;
//   • the feed cursor is a ref, so a funnel switch that empties the feed
//     resets cleanly instead of re-toasting the new funnel's backfill.
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  createToastState, pushToast, flushBuffer, markExiting, removeToast, seedSeen,
  TOAST_TTL_MS, TOAST_EXIT_MS, TOAST_MAX,
} from './livePresentation.js';

export default function usePaymentToasts({ onPayment } = {}) {
  const [toasts, setToasts] = useState([]);
  const stateRef = useRef(createToastState());
  const timersRef = useRef(new Map()); // key → { hide, remove }
  const armedRef = useRef(false);
  const aliveRef = useRef(true);
  // Mirrored in an effect, not during render (React 19 forbids the latter).
  // The callback only ever runs from a timer or a stream event, both of which
  // are strictly after commit, so an effect-synced ref is never stale for it.
  const onPaymentRef = useRef(onPayment);
  useEffect(() => { onPaymentRef.current = onPayment; }, [onPayment]);

  const clearTimers = useCallback((key) => {
    const rec = timersRef.current.get(key);
    if (!rec) return;
    if (rec.hide) clearTimeout(rec.hide);
    if (rec.remove) clearTimeout(rec.remove);
    timersRef.current.delete(key);
  }, []);

  const remove = useCallback((key) => {
    clearTimers(key);
    if (!aliveRef.current) return;
    stateRef.current = removeToast(stateRef.current, key);
    setToasts(stateRef.current.toasts);
  }, [clearTimers]);

  const dismiss = useCallback((key) => {
    if (!aliveRef.current) return;
    stateRef.current = markExiting(stateRef.current, key);
    setToasts(stateRef.current.toasts);
    const rec = timersRef.current.get(key) || {};
    if (rec.hide) clearTimeout(rec.hide);
    rec.hide = null;
    // Idempotent: a second dismiss (click during auto-dismiss) must not stack
    // a second removal timer.
    if (!rec.remove) rec.remove = setTimeout(() => remove(key), TOAST_EXIT_MS);
    timersRef.current.set(key, rec);
  }, [remove]);

  // Apply a pure-module result: arm the new toast's timers, kill the evicted
  // ones, publish the new list.
  const commit = useCallback((result) => {
    stateRef.current = result.state;
    for (const key of result.dropped || []) clearTimers(key);
    const emitted = Array.isArray(result.emitted) ? result.emitted : (result.emitted ? [result.emitted] : []);
    for (const item of emitted) {
      timersRef.current.set(item.key, {
        hide: setTimeout(() => dismiss(item.key), TOAST_TTL_MS),
        remove: null,
      });
      if (onPaymentRef.current) {
        try { onPaymentRef.current(item); } catch { /* a broken listener must never break the toast */ }
      }
    }
    setToasts(stateRef.current.toasts);
    return emitted;
  }, [clearTimers, dismiss]);

  /** Offer one feed event. Returns the gate's reason string. */
  const push = useCallback((ev) => {
    if (!aliveRef.current) return 'unmounted';
    const hidden = typeof document !== 'undefined' && document.hidden;
    const r = pushToast(stateRef.current, ev, {
      armed: armedRef.current, hidden, max: TOAST_MAX,
    });
    commit(r);
    return r.reason;
  }, [commit]);

  /**
   * Offer a BATCH of events that arrived together.
   *
   * This is the path a resync takes, and it is why the coalescing buffer is
   * reachable at all. useLiveFeed CLOSES the stream while the tab is hidden,
   * so events never trickle in behind the operator's back — instead the whole
   * gap lands at once in the reconnect's snapshot backfill. Pushed one by one
   * that is a wall of toasts and a machine-gun of chimes; routed through the
   * buffer it becomes a single "N payments while you were away" row.
   *
   * Below BUFFER_SAMPLE the events still replay verbatim, so two sales during
   * a short glance away look exactly as they would have live.
   *
   * Returns the number of events that were genuinely new.
   */
  const pushBatch = useCallback((events) => {
    if (!aliveRef.current) return 0;
    const list = Array.isArray(events) ? events : [];
    if (list.length === 0) return 0;
    if (list.length === 1) return push(list[0]) === 'emitted' ? 1 : 0;

    let s = stateRef.current;
    let accepted = 0;
    for (const ev of list) {
      const r = pushToast(s, ev, { armed: armedRef.current, hidden: true, max: TOAST_MAX });
      s = r.state;
      if (r.reason === 'buffered') accepted++;
    }
    stateRef.current = s;
    commit(flushBuffer(stateRef.current, { max: TOAST_MAX }));
    return accepted;
  }, [commit, push]);

  /**
   * Seed the dedupe set from a snapshot's backfill, then arm.
   * Idempotent on the ARM (a resync re-seeds but never disarms), and it is the
   * reason a reconnect does not fire the whole afternoon's sales at once.
   */
  const seedAndArm = useCallback((events) => {
    stateRef.current = seedSeen(stateRef.current, events);
    armedRef.current = true;
  }, []);

  /** Funnel switch / hard resync: drop every toast and every timer. */
  const reset = useCallback(() => {
    for (const key of [...timersRef.current.keys()]) clearTimers(key);
    stateRef.current = createToastState();
    armedRef.current = false;
    setToasts([]);
  }, [clearTimers]);

  useEffect(() => {
    aliveRef.current = true;
    // Captured once: the Map identity is created with the ref and never
    // reassigned, so this IS the live map at cleanup time (and it satisfies
    // react-hooks/exhaustive-deps, which cannot know that).
    const timers = timersRef.current;
    const drain = () => {
      if (!aliveRef.current) return;
      if (typeof document !== 'undefined' && document.hidden) return;
      commit(flushBuffer(stateRef.current, { max: TOAST_MAX }));
    };
    document.addEventListener('visibilitychange', drain);
    window.addEventListener('focus', drain);

    return () => {
      aliveRef.current = false;
      document.removeEventListener('visibilitychange', drain);
      window.removeEventListener('focus', drain);
      // Nothing outlives the component.
      for (const rec of timers.values()) {
        if (rec.hide) clearTimeout(rec.hide);
        if (rec.remove) clearTimeout(rec.remove);
      }
      timers.clear();
    };
  }, [commit]);

  return useMemo(
    () => ({ toasts, push, pushBatch, dismiss, seedAndArm, reset }),
    [toasts, push, pushBatch, dismiss, seedAndArm, reset],
  );
}
