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
import { useCallback, useState } from 'react';
import { useNavigate, useSearchParams } from 'react-router-dom';
import DashboardView from './DashboardView.jsx';
import useDashboardData from './useDashboardData.js';
import { daysAgoIso, todayIso } from './dashFormat.js';

export default function AnalyticsDashboardPage() {
  const navigate = useNavigate();
  const [params, setParams] = useSearchParams();

  const [start, setStart] = useState(params.get('start') || daysAgoIso(29));
  const [end, setEnd] = useState(params.get('end') || todayIso());
  const [funnelId, setFunnelId] = useState(params.get('funnel') || '');
  const [collapsed, setCollapsed] = useState(false);

  const { data, marketing, loadState, error, refresh } = useDashboardData({ start, end, funnelId });

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

  return (
    <DashboardView
      data={data}
      marketing={marketing}
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
      onOpenLive={() => navigate('/app/live')}
      onDrillMetric={onDrillMetric}
    />
  );
}
