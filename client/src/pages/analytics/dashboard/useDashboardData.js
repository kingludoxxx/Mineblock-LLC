// useDashboardData — the page's ONLY fetch loop (NEW FILE, LANE 3).
//
// TWO REQUESTS, and the work order fixes both:
//   · ONE  GET /funnel-metrics/dashboard      (Lane 1's composite)
//   · ONE  GET /funnel-attribution/marketing  (Lane 2's campaign bars)
// No SWR port, no per-card fetching. Every other surface on the page reads a
// block out of those two payloads.
//
// THE REPOLL IS CONDITIONAL AND QUIET.
//   · 15s, and ONLY while the tab is visible. A backgrounded dashboard polling
//     a Postgres GROUP BY every fifteen seconds is a self-inflicted load
//     problem, and the answer nobody is looking at is worth nothing.
//   · QUIET means the repoll never returns a settled tile to the loading state
//     and never blanks a good payload on a transient error. A dashboard that
//     flickers to skeletons every 15s is unreadable.
//   · Only the composite repolls. Attribution moves with the window, not with
//     the clock — repolling it too would double the request rate for a card
//     that cannot change between two 15-second ticks any faster than the
//     composite it sits beside.
//
// LOAD STATE IS THE OUTCOME, NOT THE PAYLOAD. Without it a failed fetch and a
// still-running fetch both leave every tile on an em dash, so a healthy
// dashboard is pixel-identical to a dead one — which is how an honest page gets
// reported as broken.
import { useCallback, useEffect, useRef, useState } from 'react';
import { fetchDashboard, fetchMarketing, metricsApiError } from '../metricsApi.js';

export const REPOLL_MS = 15000;

export default function useDashboardData({ start, end, funnelId }) {
  const [data, setData] = useState(null);
  const [marketing, setMarketing] = useState(null);
  // 'loading' until the first composite settles, then 'ready' | 'failed'.
  const [loadState, setLoadState] = useState('loading');
  const [error, setError] = useState(null);
  const [refreshedAt, setRefreshedAt] = useState(null);

  // The in-flight controller, so a window change aborts the request it
  // supersedes instead of racing it to setState.
  const inflight = useRef(null);
  // Survives across renders without re-triggering the effect that owns it.
  const mounted = useRef(true);
  useEffect(() => {
    mounted.current = true;
    return () => { mounted.current = false; };
  }, []);

  const load = useCallback(async ({ quiet = false } = {}) => {
    if (!start || !end) return;
    if (inflight.current) inflight.current.abort();
    const ctrl = new AbortController();
    inflight.current = ctrl;
    if (!quiet) setLoadState('loading');
    try {
      // Promise.allSettled, not Promise.all: attribution failing must not blank
      // the composite. Losing the marketing card is a lost card; losing the
      // composite is a lost page.
      const [d, m] = await Promise.allSettled([
        fetchDashboard({ start, end, funnelId }, { signal: ctrl.signal }),
        quiet
          ? Promise.resolve(undefined)
          : fetchMarketing({ start, end, funnelId }, { signal: ctrl.signal }),
      ]);
      if (!mounted.current || ctrl.signal.aborted) return;

      if (d.status === 'fulfilled' && d.value) {
        setData(d.value);
        setError(null);
        setLoadState('ready');
        setRefreshedAt(Date.now());
      } else if (d.status === 'rejected') {
        const msg = metricsApiError(d.reason, 'Could not load the analytics dashboard');
        if (msg === null) return; // aborted, not failed
        setError(msg);
        // KEEP THE LAST GOOD PAYLOAD on a repoll failure — but say so. Only a
        // cold failure (nothing on screen) may set 'failed'.
        setLoadState((prev) => (prev === 'ready' ? 'ready' : 'failed'));
      }

      if (!quiet) {
        if (m.status === 'fulfilled' && m.value !== undefined) setMarketing(m.value);
        // A rejected attribution call leaves `marketing` null; the card renders
        // its own empty state rather than inventing rows.
        else if (m.status === 'rejected') setMarketing(null);
      }
    } catch (e) {
      if (!mounted.current) return;
      const msg = metricsApiError(e, 'Could not load the analytics dashboard');
      if (msg === null) return;
      setError(msg);
      setLoadState((prev) => (prev === 'ready' ? 'ready' : 'failed'));
    } finally {
      if (inflight.current === ctrl) inflight.current = null;
    }
  }, [start, end, funnelId]);

  // Window / scope change → a full, visible load.
  useEffect(() => {
    load();
    return () => {
      if (inflight.current) inflight.current.abort();
    };
  }, [load]);

  // The 15s band repoll, gated on tab visibility. Re-armed on visibilitychange
  // so a tab that comes back to the front refreshes immediately instead of
  // showing figures from whenever it was last looked at.
  useEffect(() => {
    let timer = null;
    const stop = () => {
      if (timer) { clearInterval(timer); timer = null; }
    };
    const start_ = () => {
      stop();
      timer = setInterval(() => load({ quiet: true }), REPOLL_MS);
    };
    const onVisibility = () => {
      if (document.visibilityState === 'visible') {
        load({ quiet: true });
        start_();
      } else {
        stop();
      }
    };
    if (document.visibilityState === 'visible') start_();
    document.addEventListener('visibilitychange', onVisibility);
    return () => {
      stop();
      document.removeEventListener('visibilitychange', onVisibility);
    };
  }, [load]);

  return {
    data,
    marketing,
    loadState,
    error,
    refreshedAt,
    refresh: useCallback(() => load(), [load]),
  };
}
