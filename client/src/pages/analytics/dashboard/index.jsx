// AnalyticsDashboardPage — state, URL sync and the two fetches (NEW FILE, LANE 3).
//
// Deliberately thin. Everything visual lives in ./DashboardView.jsx, which is
// pure and takes the payloads as props — that separation is what lets the
// render harness mount the REAL page against seeded data (including a payload
// where every measurable thing is withheld) and screenshot it, with no server,
// no login and no mocked axios.
//
// URL SYNC. The window and the scope live in the query string so an operator
// quoting a number can send the link and land on the same figures. The picker's
// day strings are passed through UNCHANGED — they are reporting-zone calendar
// days and the server interprets them in REPORT_TZ.
import { useCallback, useRef, useState } from 'react';
import { useNavigate, useSearchParams } from 'react-router-dom';
import DashboardView from './DashboardView.jsx';
import useDashboardData from './useDashboardData.js';
import useInsightsData, { COHORT_WINDOW_DAYS } from './useInsightsData.js';
import { daysAgoIso, todayIso } from './dashFormat.js';

/**
 * THE FUNNEL LIVE VIEW'S ROUTE, PINNED.
 *
 * App.jsx mounts LiveViewPage at `live-view`, NOT at `live` — `live` is the
 * Performance lane's LivePage, gated on a different permission
 * (`live-metrics:access`). This lane branched when the funnel page still owned
 * `live`, and the rename landed on main afterwards; the header button would
 * have sent operators to a different page behind a gate most of them fail,
 * which reads as "Live view is broken" rather than "the link is wrong".
 *
 * The constant is asserted against App.jsx's source by
 * ./__checks__/formatterContract.mjs, so the next rename fails a harness
 * instead of a click.
 */
export const LIVE_VIEW_PATH = '/app/live-view';

export default function AnalyticsDashboardPage() {
  const navigate = useNavigate();
  const [params, setParams] = useSearchParams();

  const [start, setStart] = useState(params.get('start') || daysAgoIso(29));
  const [end, setEnd] = useState(params.get('end') || todayIso());
  const [funnelId, setFunnelId] = useState(params.get('funnel') || '');
  const [collapsed, setCollapsed] = useState(false);

  /**
   * ADOPT THE SERVER'S WINDOW ECHO — ONCE, and only if the operator has not
   * touched the picker.
   *
   * The seed above is computed from a hardcoded REPORT_TZ guess; the server
   * cuts its days on the real one and echoes what it actually used
   * (`meta.window`). Where the two disagree — a zone change, a DST edge, a
   * clamped range — the page would otherwise keep printing the dates it ASKED
   * for above figures computed for different ones, which is the worst kind of
   * quiet wrong: every number is right and the label above them is not.
   *
   * ⚠️ THIS RUNS IN THE RESPONSE CALLBACK, NOT IN AN EFFECT. Adopting from an
   * effect body is a synchronous setState during commit — cascading renders,
   * and exactly what react-hooks/set-state-in-effect refuses. As a callback it
   * is what it actually is: an event that carried new information.
   *
   * ONCE, because after that the picker is the operator's instrument and a
   * server echo overriding a deliberate selection would fight them. The ref is
   * set even when nothing changes, so a later response cannot re-arm it.
   */
  const adopted = useRef(false);
  const onServerWindow = useCallback((echo) => {
    if (adopted.current) return;
    adopted.current = true;
    if (echo.start === start && echo.end === end) return;
    setStart(echo.start);
    setEnd(echo.end);
    const q = { start: echo.start, end: echo.end };
    if (funnelId) q.funnel = funnelId;
    setParams(q, { replace: true });
  }, [start, end, funnelId, setParams]);

  const {
    data, marketing, marketingError, loadState, error, refresh,
  } = useDashboardData({ start, end, funnelId, onServerWindow });

  /**
   * THE INSIGHT LANE'S OWN WINDOWS, and they are deliberately NOT the picker's.
   *
   *   · the detector cards judge ONE DAY against its own trailing 28-day
   *     baseline. The natural day is the LAST day of the selected range: an
   *     operator looking at "last 30 days" is asking about the state of things
   *     now, and the end of their range is the most recent day they have chosen
   *     to look at. Clamping to today instead would put a card about today over
   *     a report about March.
   *   · cohorts open on their own 90-day ACQUISITION window, because a cohort
   *     acquired inside a 7-day picker range has had 7 days to come back and
   *     every horizon past D7 would be blank. The card prints the window it is
   *     actually on.
   *
   * Both windows are visible on their surfaces, so the divergence is stated
   * rather than discovered.
   */
  const insightDay = end || todayIso();
  const cohortEnd = end || todayIso();
  const cohortStart = daysAgoIso(COHORT_WINDOW_DAYS - 1);
  const [cohortGroupBy, setCohortGroupBy] = useState('day');

  const {
    insights, insightsError, insightsState,
    cohorts, cohortsError, cohortsState, cohortsCsvUrl,
  } = useInsightsData({
    day: insightDay,
    funnelId,
    cohortStart,
    cohortEnd,
    groupBy: cohortGroupBy,
  });

  const syncParams = useCallback((next) => {
    const q = { start: next.start, end: next.end };
    if (next.funnelId) q.funnel = next.funnelId;
    setParams(q, { replace: true });
  }, [setParams]);

  const onRangeChange = useCallback((startDate, endDate) => {
    // The picker reports a start as soon as one is clicked and the end once the
    // range closes; committing an undefined end would blank the window.
    const s = startDate || start;
    const e = endDate || end;
    setStart(s);
    setEnd(e);
    syncParams({ start: s, end: e, funnelId });
  }, [start, end, funnelId, syncParams]);

  const onScopeChange = useCallback((nextId) => {
    const id = nextId || '';
    setFunnelId(id);
    syncParams({ start, end, funnelId: id });
  }, [start, end, syncParams]);

  // A KPI tile drills into the explorer pre-seeded with the same window, scope
  // and metric — the explorer owns the vocabulary, this page only speaks it.
  const onDrillMetric = useCallback((metric) => {
    const q = new URLSearchParams({ start_day: start, end_day: end, metrics: metric });
    if (funnelId) q.set('funnel_id', funnelId);
    navigate(`explorer?${q.toString()}`);
  }, [navigate, start, end, funnelId]);

  /**
   * An insight card drills into the explorer using THE SERVER'S OWN params.
   *
   * ⚠️ THE CARD'S WINDOW WINS, not the picker's. The whole point of the drill
   * is to show the day against the exact baseline the detector judged it by —
   * substituting the page's range here would open a view that cannot reproduce
   * the finding, and an operator who cannot reproduce a card stops believing
   * the cards.
   *
   * Only whitelisted keys are forwarded, so a future server-side addition
   * cannot inject an arbitrary query param into this app's URL space.
   */
  const onDrillInsight = useCallback((deepLink) => {
    if (!deepLink || deepLink.page !== 'explorer') return;
    const src = deepLink.params && typeof deepLink.params === 'object' ? deepLink.params : {};
    const q = new URLSearchParams();
    for (const k of ['metrics', 'start_day', 'end_day', 'funnel_id', 'dimension', 'granularity']) {
      if (src[k] !== undefined && src[k] !== null && src[k] !== '') q.set(k, String(src[k]));
    }
    if (!q.get('metrics') || !q.get('start_day') || !q.get('end_day')) return;
    navigate(`explorer?${q.toString()}`);
  }, [navigate]);

  return (
    <DashboardView
      data={data}
      marketing={marketing}
      marketingError={marketingError}
      loadState={loadState}
      error={error}
      start={start}
      end={end}
      funnelId={funnelId}
      collapsed={collapsed}
      onToggleCollapsed={() => setCollapsed((c) => !c)}
      onScopeChange={onScopeChange}
      onRangeChange={onRangeChange}
      onRefresh={refresh}
      onOpenExplorer={() => navigate('explorer')}
      onOpenLive={() => navigate(LIVE_VIEW_PATH)}
      onDrillMetric={onDrillMetric}
      insights={insights}
      insightsError={insightsError}
      insightsState={insightsState}
      cohorts={cohorts}
      cohortsError={cohortsError}
      cohortsState={cohortsState}
      cohortsCsvUrl={cohortsCsvUrl}
      cohortGroupBy={cohortGroupBy}
      onCohortGroupByChange={setCohortGroupBy}
      onDrillInsight={onDrillInsight}
    />
  );
}
