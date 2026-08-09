// useDashboardData — the page's ONLY fetch loop (NEW FILE, LANE 3).
//
// TWO REQUESTS, and the work order fixes both:
//   · ONE  GET /funnel-metrics/dashboard      (Lane 1's composite)
//   · ONE  GET /funnel-attribution/marketing  (Lane 2's campaign bars)
// No SWR port, no per-card fetching. Every other surface on the page reads a
// block out of those two payloads.
//
// ── THE REPOLL TARGETS THE BAND, NOT THE COMPOSITE ──────────────────────────
//
// The live band wants a 15-second heartbeat. The band is four numbers; the
// composite is fifteen concurrent Postgres GROUP BYs over the whole window
// (Lane 1 runs them under Promise.all and reports `meta.rows_scanned` in the
// hundreds of thousands). Polling THAT every fifteen seconds, per open tab, to
// refresh four counters would be a self-inflicted load problem on the money
// database — so this hook briefly ran at 60s instead, with the header softened
// to match, rather than advertise a cadence it was not keeping.
//
// Lane 1 shipped `GET /funnel-metrics/band` (3e42a8e): ONE cheap query, and
// runDashboard calls the same `runBand` for its first paint, "so the polled
// value and the first paint come from one derivation and cannot drift apart".
// The quiet tick now fetches ONLY that, at 15s, and splices the block into the
// payload already on screen.
//
// ⚠️ `in_window` IS NOT ON THE BAND ROUTE. It is runDashboard's statement about
// the SELECTED window ("does the chart cover today?"), and /band has no idea
// what range the page is showing. The splice therefore PRESERVES the composite's
// `in_window` instead of letting it come back undefined — dropping it would
// silently delete the "today is outside the selected window" line fifteen
// seconds after the page painted it.
//
// ── THE OTHER RULES ─────────────────────────────────────────────────────────
//   · QUIET means the repoll never returns a settled card to the loading state
//     and never blanks a good payload on a transient error.
//   · A QUIET TICK NEVER STACKS. If a request is still in flight the tick is
//     SKIPPED, not queued: on a slow window (a 90-day composite can outrun the
//     interval) the old code opened a new request every tick, each one
//     aborting its predecessor, so the page could starve forever and never
//     paint. A window change still supersedes — that one aborts on purpose.
//   · THE MARKETING PAYLOAD IS TAGGED WITH THE WINDOW IT WAS FETCHED FOR and
//     is blanked the moment the window moves. Attribution is slower than the
//     composite; without the tag, last month's campaign bars sat under this
//     week's headline with nothing on screen saying they disagreed.
//   · LOAD STATE IS THE OUTCOME, NOT THE PAYLOAD. Without it a failed fetch and
//     a still-running fetch both leave every card blank, so a healthy dashboard
//     is indistinguishable from a dead one.
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  fetchBand, fetchDashboard, fetchMarketing, metricsApiError, windowOf,
} from '../metricsApi.js';

/** The window the server says it actually served, for the adoption callback. */
const windowEchoOf = (payload) => {
  const w = windowOf(payload);
  return { start: w.start, end: w.end };
};

/** GET /funnel-metrics/band shipped in Lane 1 @3e42a8e. */
export const BAND_ENDPOINT_READY = true;

/** Heartbeat now that the band has its own cheap endpoint. */
export const BAND_MS = 15000;
/** The fallback heartbeat if the quiet tick ever has to ride the composite. */
export const COMPOSITE_MS = 60000;

export const REPOLL_MS = BAND_ENDPOINT_READY ? BAND_MS : COMPOSITE_MS;

/** The identity of a window+scope — what a payload is ABOUT. */
const windowKey = ({ start, end, funnelId }) => `${start || ''}|${end || ''}|${funnelId || ''}`;

export default function useDashboardData({ start, end, funnelId, onServerWindow }) {
  const [data, setData] = useState(null);
  // Tagged: `{ key, payload }`. Read back through a key check, never directly.
  const [marketingBox, setMarketingBox] = useState(null);
  const [marketingErrorBox, setMarketingErrorBox] = useState(null);
  // 'loading' until the first composite settles, then 'ready' | 'failed'.
  const [loadState, setLoadState] = useState('loading');
  const [error, setError] = useState(null);
  const [refreshedAt, setRefreshedAt] = useState(null);

  const key = windowKey({ start, end, funnelId });

  // The in-flight controller, so a window change aborts the request it
  // supersedes instead of racing it to setState.
  const inflight = useRef(null);
  const bandInflight = useRef(null);
  const mounted = useRef(true);
  useEffect(() => {
    mounted.current = true;
    return () => { mounted.current = false; };
  }, []);

  const load = useCallback(async ({ quiet = false } = {}) => {
    if (!start || !end) return;
    if (inflight.current) {
      // A quiet tick yields to the request already running; an explicit load
      // (new window, refresh button) supersedes it.
      if (quiet) return;
      inflight.current.abort();
    }
    const ctrl = new AbortController();
    inflight.current = ctrl;
    const myKey = windowKey({ start, end, funnelId });
    if (!quiet) setLoadState('loading');
    try {
      // allSettled, not all: attribution failing must not blank the composite.
      // Losing the marketing card is a lost card; losing the composite is a
      // lost page.
      const [d, m] = await Promise.allSettled([
        fetchDashboard({ start, end, funnelId }, { signal: ctrl.signal }),
        fetchMarketing({ start, end, funnelId }, { signal: ctrl.signal }),
      ]);
      if (!mounted.current || ctrl.signal.aborted) return;

      if (d.status === 'fulfilled' && d.value) {
        setData(d.value);
        setError(null);
        setLoadState('ready');
        setRefreshedAt(Date.now());
        // THE SERVER'S WINDOW ECHO, handed back in the RESPONSE CALLBACK — not
        // in an effect. Adopting it from an effect body means calling setState
        // synchronously during render-commit, which cascades renders and is
        // what react-hooks/set-state-in-effect exists to stop. Here it is an
        // event: the response arrived, and this is what it said the window was.
        const echoed = windowEchoOf(d.value);
        if (onServerWindow && echoed.start && echoed.end) onServerWindow(echoed);
      } else if (d.status === 'rejected') {
        const msg = metricsApiError(d.reason, 'Could not load the analytics dashboard');
        if (msg === null) return; // aborted, not failed
        setError(msg);
        // KEEP THE LAST GOOD PAYLOAD on a refresh failure — but say so. Only a
        // cold failure (nothing on screen) may set 'failed'.
        setLoadState((prev) => (prev === 'ready' ? 'ready' : 'failed'));
      }

      if (m.status === 'fulfilled' && m.value !== undefined) {
        setMarketingBox({ key: myKey, payload: m.value });
        setMarketingErrorBox(null);
      } else if (m.status === 'rejected') {
        const msg = metricsApiError(m.reason, 'Could not load marketing attribution');
        if (msg !== null) {
          // The card must be able to say WHY, not just go blank — and it must
          // never fall through to "no attributed sales in this date range".
          setMarketingBox(null);
          setMarketingErrorBox({ key: myKey, message: msg });
        }
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
  }, [start, end, funnelId, onServerWindow]);

  /**
   * THE 15s TICK — the band alone, spliced into the payload on screen.
   *
   * It never sets `loadState`, never sets `error`, and never blanks anything:
   * a failed heartbeat means the four live counters are a few seconds stale,
   * not that the window's figures are in doubt. Turning a dropped tick into a
   * page-level error would put a red banner over a completely healthy report.
   */
  const pollBand = useCallback(async () => {
    if (!BAND_ENDPOINT_READY) return;
    // Never stack: behind a full load, or behind a previous tick that is still
    // out. A tick that cannot run is simply skipped — the next one is 15s away.
    if (inflight.current || bandInflight.current) return;
    const ctrl = new AbortController();
    bandInflight.current = ctrl;
    try {
      const b = await fetchBand({ funnelId }, { signal: ctrl.signal });
      if (!mounted.current || ctrl.signal.aborted || !b || typeof b !== 'object') return;
      setData((prev) => {
        if (!prev) return prev; // nothing to splice into yet
        const nextBand = { ...b };
        // ⚠️ COPY THE KEY ONLY IF IT EXISTS. `in_window: prev.band?.in_window`
        // would ADD the key with the value `undefined` whenever the composite
        // had not sent it — and `hasKey` would then report it present while its
        // value is not `true`, which reads as FALSE and prints "today is
        // outside the selected window" over a window that contains today.
        // Absent must stay absent.
        if (prev.band && Object.prototype.hasOwnProperty.call(prev.band, 'in_window')) {
          nextBand.in_window = prev.band.in_window;
        }
        return { ...prev, band: nextBand };
      });
    } catch {
      /* a dropped heartbeat is not a page failure — see above */
    } finally {
      if (bandInflight.current === ctrl) bandInflight.current = null;
    }
  }, [funnelId]);

  // Window / scope change → a full, visible load.
  useEffect(() => {
    load();
    return () => {
      if (inflight.current) inflight.current.abort();
    };
  }, [load]);

  // The heartbeat, gated on tab visibility. Re-armed on visibilitychange so a
  // tab that comes back to the front refreshes immediately instead of showing
  // counters from whenever it was last looked at.
  useEffect(() => {
    let timer = null;
    const stop = () => {
      if (timer) { clearInterval(timer); timer = null; }
    };
    const arm = () => {
      stop();
      timer = setInterval(pollBand, REPOLL_MS);
    };
    const onVisibility = () => {
      if (document.visibilityState === 'visible') {
        pollBand();
        arm();
      } else {
        stop();
      }
    };
    if (document.visibilityState === 'visible') arm();
    document.addEventListener('visibilitychange', onVisibility);
    return () => {
      stop();
      if (bandInflight.current) bandInflight.current.abort();
      document.removeEventListener('visibilitychange', onVisibility);
    };
  }, [pollBand]);

  // A payload is only shown beside figures it is ABOUT. A stale-window
  // attribution result is dropped rather than rendered under a new headline.
  const marketing = useMemo(
    () => (marketingBox && marketingBox.key === key ? marketingBox.payload : null),
    [marketingBox, key],
  );
  const marketingError = useMemo(
    () => (marketingErrorBox && marketingErrorBox.key === key ? marketingErrorBox.message : null),
    [marketingErrorBox, key],
  );

  return {
    data,
    marketing,
    marketingError,
    loadState,
    error,
    refreshedAt,
    refresh: useCallback(() => load(), [load]),
  };
}
