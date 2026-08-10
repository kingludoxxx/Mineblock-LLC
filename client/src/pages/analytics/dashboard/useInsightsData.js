// useInsightsData — the insight layer's own fetch loop (NEW FILE, LANE 5).
//
// DELIBERATELY SEPARATE FROM useDashboardData, not folded into it. Three
// reasons, and the first one is the only one that matters:
//
//   1. INDEPENDENT FAILURE. The composite is the page. The insight strip and
//      the cohort table are two extra reads, and neither may be able to blank
//      a dashboard that loaded fine — nor may a dead composite make the strip
//      claim "nothing stood out". Separate hooks make separate `state`s
//      structurally, rather than by remembering to thread a flag.
//   2. DIFFERENT WINDOWS. The insight endpoint takes a DAY (the card day, with
//      its own trailing 28-day baseline) and the cohort endpoint takes a
//      90-day acquisition window. Neither is the picker's range. Sharing the
//      dashboard hook would have meant three window vocabularies in one place.
//   3. NO HEARTBEAT. Nothing here re-polls. Detector cards are a statement
//      about a DAY, and re-running them every 15 seconds would make cards
//      appear and vanish under the operator's cursor for no new information.
//
// ── THE TAGGING RULE, INHERITED ─────────────────────────────────────────────
// Both payloads are tagged with the scope they were fetched for and are read
// back through a key check, exactly as useDashboardData tags the marketing
// payload. A cohort table for "all funnels" must never sit under a header that
// says one funnel — attribution and cohorts are both slower than the composite,
// and without the tag the stale one renders silently under the new heading.
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  cohortsCsvUrl, fetchCohorts, fetchInsights, insightsApiError,
} from '../insightsApi.js';

/** The acquisition window the cohort card opens on, in days. */
export const COHORT_WINDOW_DAYS = 90;

/** What a payload is ABOUT — scope + the window that produced it. */
const keyOf = (parts) => parts.map((p) => p || '').join('|');

export default function useInsightsData({
  day, funnelId, cohortStart, cohortEnd, groupBy = 'day',
} = {}) {
  const [insightsBox, setInsightsBox] = useState(null);
  const [insightsErrorBox, setInsightsErrorBox] = useState(null);
  const [insightsState, setInsightsState] = useState('loading');

  const [cohortsBox, setCohortsBox] = useState(null);
  const [cohortsErrorBox, setCohortsErrorBox] = useState(null);
  const [cohortsState, setCohortsState] = useState('loading');

  const insightKey = keyOf([day, funnelId]);
  const cohortKey = keyOf([cohortStart, cohortEnd, funnelId, groupBy]);

  const insightInflight = useRef(null);
  const cohortInflight = useRef(null);
  const mounted = useRef(true);
  useEffect(() => {
    mounted.current = true;
    return () => { mounted.current = false; };
  }, []);

  const loadInsights = useCallback(async () => {
    // `day: null` means "this surface has no insight strip" — the cohorts page
    // is the caller. It is a DELIBERATE SKIP, and it parks the state on
    // 'skipped' rather than on 'ready': a surface that never asked must not be
    // able to render "nothing stood out today", which is exactly the claim
    // 'ready' with an empty payload would license.
    if (day === null) { setInsightsState('skipped'); return; }
    if (insightInflight.current) insightInflight.current.abort();
    const ctrl = new AbortController();
    insightInflight.current = ctrl;
    const myKey = keyOf([day, funnelId]);
    setInsightsState('loading');
    try {
      const p = await fetchInsights({ day, funnelId }, { signal: ctrl.signal });
      if (!mounted.current || ctrl.signal.aborted) return;
      setInsightsBox({ key: myKey, payload: p });
      setInsightsErrorBox(null);
      setInsightsState('ready');
    } catch (e) {
      if (!mounted.current) return;
      const msg = insightsApiError(e, 'Could not load insights');
      // An ABORT is not a failure. Returning here leaves the state on
      // 'loading', which is correct: the superseding request is still out.
      if (msg === null) return;
      setInsightsBox(null);
      setInsightsErrorBox({ key: myKey, message: msg });
      setInsightsState('failed');
    } finally {
      if (insightInflight.current === ctrl) insightInflight.current = null;
    }
  }, [day, funnelId]);

  const loadCohorts = useCallback(async () => {
    if (cohortInflight.current) cohortInflight.current.abort();
    const ctrl = new AbortController();
    cohortInflight.current = ctrl;
    const myKey = keyOf([cohortStart, cohortEnd, funnelId, groupBy]);
    setCohortsState('loading');
    try {
      const p = await fetchCohorts(
        { start: cohortStart, end: cohortEnd, funnelId, groupBy },
        { signal: ctrl.signal },
      );
      if (!mounted.current || ctrl.signal.aborted) return;
      setCohortsBox({ key: myKey, payload: p });
      setCohortsErrorBox(null);
      setCohortsState('ready');
    } catch (e) {
      if (!mounted.current) return;
      const msg = insightsApiError(e, 'Could not load cohorts');
      if (msg === null) return;
      setCohortsBox(null);
      setCohortsErrorBox({ key: myKey, message: msg });
      setCohortsState('failed');
    } finally {
      if (cohortInflight.current === ctrl) cohortInflight.current = null;
    }
  }, [cohortStart, cohortEnd, funnelId, groupBy]);

  useEffect(() => {
    loadInsights();
    return () => { if (insightInflight.current) insightInflight.current.abort(); };
  }, [loadInsights]);

  useEffect(() => {
    loadCohorts();
    return () => { if (cohortInflight.current) cohortInflight.current.abort(); };
  }, [loadCohorts]);

  // A payload is only shown beside figures it is ABOUT.
  const insights = useMemo(
    () => (insightsBox && insightsBox.key === insightKey ? insightsBox.payload : null),
    [insightsBox, insightKey],
  );
  const insightsError = useMemo(
    () => (insightsErrorBox && insightsErrorBox.key === insightKey ? insightsErrorBox.message : null),
    [insightsErrorBox, insightKey],
  );
  const cohorts = useMemo(
    () => (cohortsBox && cohortsBox.key === cohortKey ? cohortsBox.payload : null),
    [cohortsBox, cohortKey],
  );
  const cohortsError = useMemo(
    () => (cohortsErrorBox && cohortsErrorBox.key === cohortKey ? cohortsErrorBox.message : null),
    [cohortsErrorBox, cohortKey],
  );

  const csvUrl = useMemo(
    () => cohortsCsvUrl({ start: cohortStart, end: cohortEnd, funnelId, groupBy }),
    [cohortStart, cohortEnd, funnelId, groupBy],
  );

  return {
    insights,
    insightsError,
    insightsState,
    cohorts,
    cohortsError,
    cohortsState,
    cohortsCsvUrl: csvUrl,
    refresh: useCallback(() => { loadInsights(); loadCohorts(); }, [loadInsights, loadCohorts]),
  };
}
