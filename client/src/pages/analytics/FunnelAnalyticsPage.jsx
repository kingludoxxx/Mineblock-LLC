// Funnel Analytics — the operator-facing reporting view (NEW FILE).
//
// Reads ONLY the new /api/v1/funnel-analytics surface. It never writes.
//
// ⚠️ INTEGRATION HOOKS (both flagged in the delivery report):
//   client/src/App.jsx  — ONE additive route line
//   components/layout/Sidebar.jsx — ONE additive nav item
import { useCallback, useEffect, useMemo, useState } from 'react';
import { useSearchParams } from 'react-router-dom';
import { BarChart3, AlertTriangle, RefreshCw, FlaskConical } from 'lucide-react';
import api from '../../services/api';
import Card from '../../components/ui/Card';
import Select from '../../components/ui/Select';
import DateRangePicker from '../../components/ui/DateRangePicker';
import FunnelTotalsCards from './components/FunnelTotalsCards';
import PageMetricsTable from './components/PageMetricsTable';
import SplitResultsPanel from './components/SplitResultsPanel';
import { daysAgoIso, todayIso } from './format';

const BASE = '/funnel-analytics';

export default function FunnelAnalyticsPage() {
  const [params, setParams] = useSearchParams();

  const [funnels, setFunnels] = useState([]);
  const [funnelId, setFunnelId] = useState(params.get('funnel') || '');
  const [from, setFrom] = useState(params.get('from') || daysAgoIso(29));
  const [to, setTo] = useState(params.get('to') || todayIso());

  const [tests, setTests] = useState([]);
  const [testId, setTestId] = useState(params.get('test') || '');

  const [overview, setOverview] = useState(null);
  const [split, setSplit] = useState(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState(null);

  // Funnel list — once.
  useEffect(() => {
    let alive = true;
    api
      .get(`${BASE}/funnels`)
      .then((r) => {
        if (!alive) return;
        const list = r.data?.funnels || [];
        setFunnels(list);
        setFunnelId((cur) => cur || list[0]?.id || '');
      })
      .catch((e) => alive && setError(e?.response?.data?.error || e.message));
    return () => {
      alive = false;
    };
  }, []);

  // Keep the URL shareable — an operator quoting a number can send the link.
  useEffect(() => {
    const next = {};
    if (funnelId) next.funnel = funnelId;
    if (from) next.from = from;
    if (to) next.to = to;
    if (testId) next.test = testId;
    setParams(next, { replace: true });
  }, [funnelId, from, to, testId, setParams]);

  const load = useCallback(async () => {
    if (!funnelId) return;
    setLoading(true);
    setError(null);
    try {
      const [ov, ts] = await Promise.all([
        api.get(`${BASE}/funnel/${encodeURIComponent(funnelId)}/overview`, { params: { from, to } }),
        api.get(`${BASE}/funnel/${encodeURIComponent(funnelId)}/split-tests`),
      ]);
      setOverview(ov.data);
      const list = ts.data?.tests || [];
      setTests(list);
      setTestId((cur) => (list.some((t) => t.id === cur) ? cur : ''));
    } catch (e) {
      setError(e?.response?.data?.error || e.message);
      setOverview(null);
    } finally {
      setLoading(false);
    }
  }, [funnelId, from, to]);

  useEffect(() => {
    load();
  }, [load]);

  useEffect(() => {
    let alive = true;
    if (!testId) {
      setSplit(null);
      return undefined;
    }
    api
      .get(`${BASE}/split/${encodeURIComponent(testId)}/results`, { params: { from, to } })
      .then((r) => alive && setSplit(r.data))
      .catch((e) => alive && setSplit({ error: e?.response?.data?.error || e.message }));
    return () => {
      alive = false;
    };
  }, [testId, from, to]);

  const funnelOptions = useMemo(
    () => funnels.map((f) => ({ value: f.id, label: f.name || f.slug || f.id })),
    [funnels]
  );
  const testOptions = useMemo(
    () => [{ value: '', label: 'No split test selected' }, ...tests.map((t) => ({ value: t.id, label: t.name || t.id }))],
    [tests]
  );

  const currency = overview?.meta?.currency || 'USD';

  return (
    <div className="p-6 space-y-5 max-w-[1600px]">
      <div className="flex flex-wrap items-end justify-between gap-4">
        <div>
          <h1 className="text-xl font-semibold text-text-primary flex items-center gap-2">
            <BarChart3 className="w-5 h-5 text-accent-text" />
            Funnel Analytics
          </h1>
          <p className="text-sm text-text-muted mt-0.5">
            Per-page and per-funnel performance, derived from the ledgers at query time.
          </p>
        </div>
        <div className="flex flex-wrap items-end gap-3">
          <div className="w-56">
            <Select
              label="Funnel"
              value={funnelId}
              options={funnelOptions}
              placeholder={funnels.length ? undefined : 'No funnels'}
              onChange={(e) => setFunnelId(e.target.value)}
            />
          </div>
          <div>
            <label className="block text-sm font-medium text-text-muted mb-1.5">Date range</label>
            <DateRangePicker
              startDate={from}
              endDate={to}
              onChange={({ startDate, endDate }) => {
                setFrom(startDate);
                setEndSafe(endDate, setTo);
              }}
            />
          </div>
          <button
            type="button"
            onClick={load}
            disabled={loading}
            className="h-[38px] px-3 rounded-lg border border-border-default bg-bg-elevated text-text-muted
                       hover:text-text-primary disabled:opacity-50 transition-colors"
            title="Refresh"
          >
            <RefreshCw className={`w-4 h-4 ${loading ? 'animate-spin' : ''}`} />
          </button>
        </div>
      </div>

      {error ? (
        <Card className="border-danger/30 bg-danger/5 text-sm text-danger flex items-center gap-2">
          <AlertTriangle className="w-4 h-4" />
          {String(error)}
        </Card>
      ) : null}

      {overview?.degraded ? (
        <div className="rounded-lg border border-amber-500/30 bg-amber-500/5 px-3 py-2.5 flex gap-2.5">
          <AlertTriangle className="w-4 h-4 text-amber-400 shrink-0 mt-0.5" />
          <div className="text-[12px] text-amber-200/90 leading-relaxed">
            <strong className="font-medium">Partial data.</strong> These sources did not answer:{' '}
            {overview.warnings.map((w) => w.source).join(', ')}. Anything they feed shows as “—”, never as zero.
          </div>
        </div>
      ) : null}

      {overview?.meta?.mixed_currency ? (
        <div className="rounded-lg border border-amber-500/30 bg-amber-500/5 px-3 py-2.5 text-[12px] text-amber-200/90">
          <strong className="font-medium">Mixed currencies in this window.</strong> The money columns are raw sums
          across more than one currency and are not directly comparable.
        </div>
      ) : null}

      <FunnelTotalsCards totals={overview?.totals} meta={overview?.meta} />

      <Card className="p-0 overflow-hidden">
        <div className="px-4 py-3 border-b border-border-default flex items-center justify-between gap-3">
          <h2 className="text-sm font-semibold text-text-primary">Pages</h2>
          <span className="text-[11px] text-text-faint">
            {overview?.window ? `${overview.window.from} → ${overview.window.to} · ${overview.window.days}d · UTC` : ''}
          </span>
        </div>
        <div className="p-4">
          {loading && !overview ? (
            <div className="text-sm text-text-muted py-8 text-center">Loading…</div>
          ) : (
            <PageMetricsTable pages={overview?.pages || []} currency={currency} />
          )}
        </div>
      </Card>

      <Card className="p-0 overflow-hidden">
        <div className="px-4 py-3 border-b border-border-default flex flex-wrap items-center justify-between gap-3">
          <h2 className="text-sm font-semibold text-text-primary flex items-center gap-2">
            <FlaskConical className="w-4 h-4 text-accent-text" />
            Split test results
          </h2>
          <div className="w-72">
            <Select value={testId} options={testOptions} onChange={(e) => setTestId(e.target.value)} />
          </div>
        </div>
        <div className="p-4">
          {testId ? (
            <SplitResultsPanel data={split} />
          ) : (
            <div className="text-sm text-text-muted py-6 text-center">
              {tests.length
                ? 'Pick a split test to see the A/B comparison.'
                : 'No split tests on this funnel yet.'}
            </div>
          )}
        </div>
      </Card>

      <p className="text-[11px] text-text-faint leading-relaxed max-w-4xl">
        Revenue counts <strong className="text-text-muted">paid sessions only</strong> — a session at{' '}
        <code>processing</code> is intent, not money, and is excluded from every figure above (the excluded amount is
        shown on the Orders card). Fully refunded sessions stay counted as orders and net against gross, so a refund
        never makes a sale disappear. Orders are windowed on <code>paid_at</code>; refunds on the refund entry&apos;s own
        date; traffic on the touch timestamp. All windows are UTC, half-open.
      </p>
    </div>
  );
}

// DateRangePicker hands back both dates together; this guards against a picker
// that only reports a start while the user is mid-selection.
function setEndSafe(endDate, setTo) {
  if (endDate) setTo(endDate);
}
