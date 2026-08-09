/**
 * AnalyticsExplorer — the freeform "explore" surface (Lane 4).
 *
 *   metrics × dimension × filters × window × granularity × compare × viz
 *      → POST /funnel-metrics/query  → recharts / table / big numbers
 *      → GET  /funnel-metrics/query.csv?q=<url-encoded JSON body>  (same body)
 *
 * Two extra modes surface the Lane 2 attribution engine directly:
 *   • roas   → GET /funnel-attribution/roas   (spend joined to the click ledger)
 *   • clicks → GET /funnel-attribution/clicks (the raw ledger)
 * Both are PER-FUNNEL reports and say so when no funnel is scoped.
 *
 * WHAT THIS FILE IS AND IS NOT RESPONSIBLE FOR.
 *   Legality lives in ../reportConfig.js and is UX ONLY — an illegal chip is
 *   greyed with the reason on it so the operator never spends a round-trip
 *   discovering a 422. THE ENGINE REMAINS THE AUTHORITY; when it 422s anyway,
 *   its message is printed verbatim rather than replaced with a guess.
 *
 *   Money truth rules the pixels: null renders as an em dash, NEVER as 0 (see
 *   ../format.js). Charts pass connectNulls={false}. A delta chip is drawn only
 *   when a real previous-window baseline came back — a compare with no
 *   `previous` block shows nothing, never "0%".
 *
 * TIMEZONE: v1 computes AND prints UTC. The header says so out loud.
 *
 * Lane 3 lazy-imports this file's DEFAULT EXPORT from
 * client/src/pages/analytics/explorer/index.jsx. Every prop is optional so it
 * also renders standalone (it then offers its own funnel-id filter).
 */
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Download, Save } from 'lucide-react';
import DateRangePicker from '../../../components/ui/DateRangePicker';
import { EM_DASH, daysAgoIso, fmtInt, fmtMoney, todayIso } from '../format';
import {
  CHARTS, DIMENSIONS, DIMENSION_KEYS, GATEWAYS, GRANULARITIES, GRANULARITY_KEYS,
  MAX_METRICS, METRICS, METRIC_GROUPS, METRIC_KEYS, MODES, MODE_KEYS,
  ROAS_DIMENSIONS, buildQueryBody, chartBlockReason, csvFilename,
  dimensionBlockReason, emptyState, fmtMultiple, formatterFor,
  granularityBlockReason, labelFor, legalCharts, legalGranularities,
  metricBlockReason, normalizeState, reportTitle, seedFromParams, seedFromQuery,
  stateToParams, stateToSearch, windowDays,
} from '../reportConfig';
import ExplorerChart from './ExplorerChart';
import { colorForIndex } from './chartColors';
import PresetGrid from './PresetGrid';
import SavedReports from './SavedReports';
import { addSavedReport } from './savedReportsStore';
import {
  explorerApiError, fetchClicks, fetchQueryCsvBlob, fetchRoas, readClicksResult,
  readQueryResult, readRoasResult, runQuery,
} from './explorerApi';

/** Chip-toggles must not burst the API; the work order pins this at 250ms. */
const QUERY_DEBOUNCE_MS = 250;
const LEDGER_DEBOUNCE_MS = 150;
const CLICKS_LIMIT = 200;

/* ── tiny presentational atoms (kept local: this is the only consumer) ──── */

function Seg({ options, value, onChange, testPrefix }) {
  return (
    <span className="inline-flex rounded-lg border border-border-default overflow-hidden">
      {options.map((o) => (
        <button
          key={o.key}
          type="button"
          disabled={!!o.disabled}
          title={o.reason || undefined}
          onClick={() => onChange(o.key)}
          className={`h-8 px-3 text-xs font-medium border-r border-border-default last:border-r-0 transition-colors
            disabled:opacity-40 disabled:cursor-not-allowed
            ${value === o.key ? 'bg-accent-muted text-accent-text' : 'text-text-muted hover:bg-bg-hover enabled:cursor-pointer'}`}
          data-testid={`${testPrefix}-${o.key}`}
        >
          {o.label}
        </button>
      ))}
    </span>
  );
}

function Notice({ children, testid, tone = 'muted' }) {
  const toneClass = tone === 'warn'
    ? 'border-amber-500/30 bg-amber-500/5 text-amber-300'
    : 'border-dashed border-border-default text-text-muted';
  return (
    <div className={`rounded-xl border p-6 text-center text-xs ${toneClass}`} data-testid={testid}>
      {children}
    </div>
  );
}

const TH = ({ children, right }) => (
  <th className={`px-3 py-2 text-[10px] font-semibold uppercase tracking-wider text-text-faint whitespace-nowrap ${right ? 'text-right' : 'text-left'}`}>
    {children}
  </th>
);
const TD = ({ children, right, className = '' }) => (
  <td className={`px-3 py-2 text-xs whitespace-nowrap ${right ? 'text-right tabular-nums' : ''} ${className}`}>
    {children}
  </td>
);

/** UTC, printed as UTC — the only clock this surface speaks. */
function fmtUtcMinute(ts) {
  if (!ts) return EM_DASH;
  const d = new Date(ts);
  if (Number.isNaN(d.getTime())) return EM_DASH;
  return `${d.toISOString().slice(0, 10)} ${d.toISOString().slice(11, 16)}`;
}

/* ── the surface ───────────────────────────────────────────────────────── */

export default function AnalyticsExplorer({
  funnelId = '',
  funnelName = '',
  seed = null,
  onSyncParams = null,
  syncUrl = true,
}) {
  // Seeded ONCE from the address bar so a deep link opens the view it names.
  const [state, setState] = useState(() => {
    const base = emptyState({
      window: { start_day: daysAgoIso(29), end_day: todayIso() },
      filters: { funnel_id: funnelId },
    });
    const search = typeof window !== 'undefined' ? window.location.search : '';
    return search ? seedFromParams(search, base) : base;
  });

  const [result, setResult] = useState(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');
  const [exporting, setExporting] = useState(false);
  const [saveName, setSaveName] = useState('');
  const [saveError, setSaveError] = useState('');
  const [savedRefresh, setSavedRefresh] = useState(0);

  const patch = useCallback((changes) => {
    setState((cur) => normalizeState({
      ...cur,
      ...changes,
      window: { ...cur.window, ...(changes.window || {}) },
      filters: { ...cur.filters, ...(changes.filters || {}) },
    }));
  }, []);

  /* An owning page (Lane 3) may scope the funnel from outside. Its value wins,
     but only when it actually changes — otherwise it would fight the local
     filter input on every render. */
  const lastFunnelProp = useRef(funnelId);
  useEffect(() => {
    if (lastFunnelProp.current === funnelId) return;
    lastFunnelProp.current = funnelId;
    patch({ filters: { funnel_id: funnelId } });
  }, [funnelId, patch]);

  /* A preset / saved report handed down from outside; `seq` makes a repeat of
     the same seed re-apply. */
  const seedSeq = seed && seed.seq;
  const lastSeedSeq = useRef(null);
  useEffect(() => {
    if (!seed || !seedSeq || lastSeedSeq.current === seedSeq) return;
    lastSeedSeq.current = seedSeq;
    setState((cur) => seedFromQuery(seed.query || seed, cur));
  }, [seed, seedSeq]);

  /* ── the ONE query body: run, CSV, save and deep link all read it ── */
  const scopedState = useMemo(
    () => normalizeState({ ...state, filters: { ...state.filters, funnel_id: funnelId || state.filters.funnel_id } }),
    [state, funnelId],
  );
  const queryBody = useMemo(() => buildQueryBody(scopedState), [scopedState]);
  const bodyKey = useMemo(() => JSON.stringify(queryBody), [queryBody]);

  /* ── URL sync (router-agnostic: replaceState never needs a Router) ── */
  const paramsKey = useMemo(() => JSON.stringify(stateToParams(scopedState)), [scopedState]);
  useEffect(() => {
    onSyncParams?.(JSON.parse(paramsKey));
    if (!syncUrl || typeof window === 'undefined' || !window.history?.replaceState) return;
    const search = stateToSearch(JSON.parse(paramsKey));
    window.history.replaceState(window.history.state, '',
      `${window.location.pathname}${search ? `?${search}` : ''}${window.location.hash}`);
  }, [paramsKey, onSyncParams, syncUrl]);

  /* ── run: query mode (debounced) ── */
  const mode = scopedState.mode;
  const scopedFunnelId = scopedState.filters.funnel_id;
  const { roas_dimension: roasDimension, clicks_network: clicksNetwork } = scopedState;
  const spanDays = windowDays(scopedState.window.start_day, scopedState.window.end_day);

  useEffect(() => {
    if (mode !== 'query') return undefined;
    const controller = new AbortController();
    const timer = setTimeout(async () => {
      setLoading(true);
      setError('');
      try {
        const data = await runQuery(JSON.parse(bodyKey), { signal: controller.signal });
        setResult({ kind: 'query', ...readQueryResult(data) });
      } catch (e) {
        if (controller.signal.aborted) return;
        setResult(null);
        setError(explorerApiError(e));
      } finally {
        if (!controller.signal.aborted) setLoading(false);
      }
    }, QUERY_DEBOUNCE_MS);
    return () => { clearTimeout(timer); controller.abort(); };
  }, [mode, bodyKey]);

  /* ── run: roas / clicks modes ── */
  useEffect(() => {
    if (mode === 'query') return undefined;
    if (!scopedFunnelId) { setResult(null); setError(''); return undefined; }
    const controller = new AbortController();
    const timer = setTimeout(async () => {
      setLoading(true);
      setError('');
      try {
        if (mode === 'roas') {
          const data = await fetchRoas(
            { funnelId: scopedFunnelId, dimension: roasDimension, days: spanDays || 30 },
            { signal: controller.signal },
          );
          setResult({ kind: 'roas', ...readRoasResult(data) });
        } else {
          const data = await fetchClicks(
            { funnelId: scopedFunnelId, network: clicksNetwork, limit: CLICKS_LIMIT },
            { signal: controller.signal },
          );
          setResult({ kind: 'clicks', ...readClicksResult(data) });
        }
      } catch (e) {
        if (controller.signal.aborted) return;
        setResult(null);
        setError(explorerApiError(e, 'Report failed — try again.'));
      } finally {
        if (!controller.signal.aborted) setLoading(false);
      }
    }, LEDGER_DEBOUNCE_MS);
    return () => { clearTimeout(timer); controller.abort(); };
  }, [mode, scopedFunnelId, roasDimension, clicksNetwork, spanDays]);

  /* ── derived legality for the controls ── */
  const { metrics, dimension, granularity, viz, compare } = scopedState;
  const grainOptions = useMemo(() => {
    const legal = legalGranularities(scopedState.window.start_day, scopedState.window.end_day);
    return GRANULARITY_KEYS.map((g) => ({
      key: g,
      label: GRANULARITIES[g].label,
      disabled: !legal.includes(g),
      reason: granularityBlockReason(g, scopedState.window.start_day, scopedState.window.end_day),
    }));
  }, [scopedState.window.start_day, scopedState.window.end_day]);

  const vizOptions = useMemo(() => {
    const legal = legalCharts(dimension, metrics);
    return Object.keys(CHARTS).map((c) => ({
      key: c,
      label: CHARTS[c].label,
      disabled: !legal.includes(c),
      reason: chartBlockReason(c, dimension, metrics),
    }));
  }, [dimension, metrics]);

  const metricChips = useMemo(() => METRIC_KEYS.map((m) => {
    const reason = metricBlockReason(m, { dimension, granularity });
    const on = metrics.includes(m);
    return {
      key: m,
      label: METRICS[m].label,
      group: METRICS[m].group,
      on,
      // A selected metric is never disabled — it must always be removable, or
      // an illegal combination arrived at by changing the group-by would trap
      // the operator with no way back.
      disabled: !on && (!!reason || metrics.length >= MAX_METRICS),
      reason: reason || (metrics.length >= MAX_METRICS && !on
        ? `The engine takes at most ${MAX_METRICS} metrics.` : ''),
    };
  }), [metrics, dimension, granularity]);

  const toggleMetric = (key) => {
    patch({
      metrics: metrics.includes(key) ? metrics.filter((k) => k !== key) : [...metrics, key],
    });
  };

  /* ── CSV ── */
  const exportCsv = async () => {
    setExporting(true);
    setError('');
    try {
      const blob = await fetchQueryCsvBlob(queryBody);
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = csvFilename(scopedState);
      a.click();
      URL.revokeObjectURL(url);
    } catch (e) {
      // Never a silent failure — a swallowed 422 here reads as "nothing to export".
      setError(explorerApiError(e, 'CSV export failed — try again.'));
    } finally {
      setExporting(false);
    }
  };

  /* ── saved reports ── */
  const saveCurrent = () => {
    const name = saveName.trim();
    if (!name) return;
    const entry = addSavedReport(name, scopedState);
    if (!entry) { setSaveError('Could not save — browser storage is unavailable or full.'); return; }
    setSaveError('');
    setSaveName('');
    setSavedRefresh((n) => n + 1);
  };

  /* ── render helpers ── */
  const formatters = useMemo(
    () => Object.fromEntries(metrics.map((m) => [m, formatterFor(m)])), [metrics]);
  const labels = useMemo(
    () => Object.fromEntries(metrics.map((m) => [m, labelFor(m)])), [metrics]);

  const q = result && result.kind === 'query' ? result : null;
  const tableRows = q ? (dimension ? q.rows : q.series) : [];
  const meta = (result && result.meta) || {};
  const warnings = Array.isArray(meta.warnings) ? meta.warnings : [];

  const hasData = mode === 'query'
    ? (viz === 'big-number' ? !!q && Object.keys(q.totals).length > 0 : tableRows.length > 0)
    : mode === 'roas' ? !!result && result.rows.length > 0
      : !!result && result.clicks.length > 0;

  const prevLabelText = compare && q && q.hasPrevious
    ? 'vs previous period (dashed)'
    : compare ? 'no previous window returned — no baseline to compare against' : '';

  return (
    <div className="space-y-3" data-testid="analytics-explorer">
      {/* Header */}
      <div className="flex items-end justify-between gap-3 flex-wrap">
        <div>
          <h2 className="text-lg font-semibold text-text-primary">Explore</h2>
          <p className="text-xs text-text-muted">
            {reportTitle(scopedState)}
            {' · '}
            {scopedState.window.start_day || EM_DASH} → {scopedState.window.end_day || EM_DASH}
            {' · UTC'}
            {funnelName ? ` · ${funnelName}` : ''}
            {meta.computed_ms != null ? ` · ${fmtInt(meta.computed_ms)} ms` : ''}
          </p>
        </div>
        <DateRangePicker
          startDate={scopedState.window.start_day || daysAgoIso(29)}
          endDate={scopedState.window.end_day || todayIso()}
          onChange={({ startDate, endDate }) => patch({ window: { start_day: startDate, end_day: endDate } })}
        />
      </div>

      <SavedReports
        key={savedRefresh}
        onLoad={(entry) => setState(normalizeState(entry.state || entry.query))}
      />

      <PresetGrid
        activeId={scopedState.report}
        onPick={(p) => setState((cur) => seedFromQuery(
          { ...(p.query || {}), mode: p.mode, report: p.id }, cur,
        ))}
      />

      {/* Controls */}
      <div className="rounded-xl border border-border-default bg-bg-card p-4 space-y-3" data-testid="ax-controls">
        <div className="flex items-center justify-between gap-2 flex-wrap">
          <Seg
            testPrefix="ax-mode"
            options={MODE_KEYS.map((m) => ({ key: m, label: MODES[m].label }))}
            value={mode}
            onChange={(m) => { setResult(null); setError(''); patch({ mode: m }); }}
          />
          <div className="flex items-center gap-2 flex-wrap">
            {mode === 'query' && (
              <button
                type="button"
                onClick={() => patch({ compare: !compare })}
                className={`h-8 px-3 text-xs font-medium rounded-lg border transition-colors cursor-pointer
                  ${compare ? 'border-accent/40 bg-accent-muted text-accent-text' : 'border-border-default text-text-muted hover:bg-bg-hover'}`}
                data-testid="ax-compare"
              >
                Compare: {compare ? 'on' : 'off'}
              </button>
            )}
            {mode === 'query' && (
              <button
                type="button"
                onClick={exportCsv}
                disabled={exporting || !hasData}
                className="h-8 px-3 text-xs font-medium rounded-lg border border-border-default text-text-muted hover:bg-bg-hover disabled:opacity-50 disabled:cursor-not-allowed inline-flex items-center gap-1.5 enabled:cursor-pointer"
                data-testid="ax-export"
              >
                <Download className="h-3 w-3" />
                {exporting ? 'Exporting…' : 'Export CSV'}
              </button>
            )}
          </div>
        </div>

        {mode === 'query' ? (
          <>
            {/* Metric chips, grouped */}
            <div className="space-y-2" data-testid="ax-metrics">
              {METRIC_GROUPS.map((group) => (
                <div key={group} className="flex items-center gap-1.5 flex-wrap">
                  <span className="text-[10px] uppercase tracking-wider text-text-faint font-semibold w-16 shrink-0">
                    {group}
                  </span>
                  {metricChips.filter((c) => c.group === group).map((c) => (
                    <button
                      key={c.key}
                      type="button"
                      disabled={c.disabled}
                      title={c.reason || METRICS[c.key].hint || undefined}
                      onClick={() => toggleMetric(c.key)}
                      className={`h-7 px-2.5 rounded-full border text-xs font-medium transition-colors
                        disabled:opacity-35 disabled:cursor-not-allowed
                        ${c.on ? 'border-accent/40 bg-accent-muted text-accent-text' : 'border-border-default text-text-muted hover:bg-bg-hover enabled:cursor-pointer'}`}
                      data-testid={`ax-metric-${c.key}`}
                    >
                      {c.label}
                    </button>
                  ))}
                </div>
              ))}
            </div>

            {/* Group-by + granularity + viz */}
            <div className="flex items-center gap-2 flex-wrap">
              <select
                value={dimension}
                onChange={(e) => patch({ dimension: e.target.value })}
                className="h-8 rounded-lg border border-border-default bg-bg-elevated px-3 text-xs font-medium text-text-primary outline-none cursor-pointer"
                data-testid="ax-dimension"
              >
                <option value="">Over time</option>
                {DIMENSION_KEYS.map((d) => {
                  const reason = dimensionBlockReason(d, metrics);
                  return (
                    <option key={d} value={d} disabled={!!reason} title={reason || undefined}>
                      {`By ${DIMENSIONS[d].label}${reason ? ' — unavailable' : ''}`}
                    </option>
                  );
                })}
              </select>
              {!dimension && (
                <Seg testPrefix="ax-granularity" options={grainOptions}
                  value={granularity} onChange={(g) => patch({ granularity: g })} />
              )}
              <Seg testPrefix="ax-viz" options={vizOptions} value={viz}
                onChange={(v) => patch({ viz: v })} />
              {dimension && DIMENSIONS[dimension].basis && (
                <span className="text-[10px] text-text-faint">
                  {`basis: ${DIMENSIONS[dimension].basis}`}
                </span>
              )}
            </div>

            {/* Filters + save */}
            <div className="flex items-center gap-2 flex-wrap" data-testid="ax-filters">
              <span className="text-[10px] uppercase tracking-wider text-text-faint font-semibold">
                Filters
              </span>
              {funnelId ? (
                <span className="h-7 inline-flex items-center rounded-full border border-accent/40 bg-accent-muted px-2.5 text-xs font-medium text-accent-text">
                  {funnelName || funnelId}
                </span>
              ) : (
                <input
                  value={scopedState.filters.funnel_id}
                  placeholder="Funnel id"
                  onChange={(e) => patch({ filters: { funnel_id: e.target.value } })}
                  className="h-7 w-40 rounded-full border border-border-default bg-bg-elevated px-2.5 text-xs text-text-primary placeholder:text-text-faint outline-none"
                  data-testid="ax-filter-funnel"
                />
              )}
              <input
                value={scopedState.filters.country}
                placeholder="Country (US)"
                maxLength={2}
                onChange={(e) => patch({ filters: { country: e.target.value.toUpperCase() } })}
                className="h-7 w-24 rounded-full border border-border-default bg-bg-elevated px-2.5 text-xs text-text-primary placeholder:text-text-faint outline-none"
                data-testid="ax-filter-country"
              />
              <select
                value={scopedState.filters.gateway}
                onChange={(e) => patch({ filters: { gateway: e.target.value } })}
                className="h-7 rounded-full border border-border-default bg-bg-elevated px-2.5 text-xs text-text-primary outline-none cursor-pointer"
                data-testid="ax-filter-gateway"
              >
                <option value="">Any gateway</option>
                {GATEWAYS.map((g) => <option key={g} value={g}>{g}</option>)}
              </select>
              <input
                value={scopedState.filters.source}
                placeholder="Source (utm)"
                onChange={(e) => patch({ filters: { source: e.target.value } })}
                className="h-7 w-32 rounded-full border border-border-default bg-bg-elevated px-2.5 text-xs text-text-primary placeholder:text-text-faint outline-none"
                data-testid="ax-filter-source"
              />
              <span className="flex-1" />
              <input
                value={saveName}
                placeholder="Save as…"
                onChange={(e) => setSaveName(e.target.value)}
                onKeyDown={(e) => e.key === 'Enter' && saveCurrent()}
                className="h-7 w-32 rounded-full border border-border-default bg-bg-elevated px-2.5 text-xs text-text-primary placeholder:text-text-faint outline-none"
                data-testid="ax-save-name"
              />
              <button
                type="button"
                onClick={saveCurrent}
                disabled={!saveName.trim()}
                className="h-7 px-2.5 text-xs font-medium rounded-full border border-border-default text-text-muted hover:bg-bg-hover disabled:opacity-50 disabled:cursor-not-allowed inline-flex items-center gap-1 enabled:cursor-pointer"
                data-testid="ax-save"
              >
                <Save className="h-3 w-3" /> Save
              </button>
            </div>
            {saveError && <p className="text-xs text-danger" data-testid="ax-save-error">{saveError}</p>}
          </>
        ) : (
          <div className="flex items-center gap-2 flex-wrap">
            {!funnelId && (
              <input
                value={scopedState.filters.funnel_id}
                placeholder="Funnel id"
                onChange={(e) => patch({ filters: { funnel_id: e.target.value } })}
                className="h-8 w-40 rounded-lg border border-border-default bg-bg-elevated px-2.5 text-xs text-text-primary placeholder:text-text-faint outline-none"
                data-testid="ax-ledger-funnel"
              />
            )}
            {mode === 'roas' && (
              <select
                value={roasDimension}
                onChange={(e) => patch({ roas_dimension: e.target.value })}
                className="h-8 rounded-lg border border-border-default bg-bg-elevated px-3 text-xs font-medium text-text-primary outline-none cursor-pointer"
                data-testid="ax-roas-dimension"
              >
                {ROAS_DIMENSIONS.map((d) => <option key={d} value={d}>{`By ${d}`}</option>)}
              </select>
            )}
            {mode === 'clicks' && result && result.kind === 'clicks' && Object.keys(result.byNetwork).length > 0 && (
              <select
                value={clicksNetwork}
                onChange={(e) => patch({ clicks_network: e.target.value })}
                className="h-8 rounded-lg border border-border-default bg-bg-elevated px-3 text-xs font-medium text-text-primary outline-none cursor-pointer"
                data-testid="ax-clicks-network"
              >
                <option value="">All networks</option>
                {Object.keys(result.byNetwork).map((n) => <option key={n} value={n}>{n}</option>)}
              </select>
            )}
            <span className="text-xs text-text-muted">
              {scopedFunnelId
                ? `Scoped to ${funnelName || scopedFunnelId}${mode === 'roas' ? ` · ${spanDays ?? EM_DASH} days` : ` · latest ${CLICKS_LIMIT} clicks`}`
                : 'This is a per-funnel report — scope a funnel to run it.'}
            </span>
          </div>
        )}
      </div>

      {/* Server-declared caveats, printed before any number is read. */}
      {warnings.length > 0 && (
        <div className="rounded-xl border border-amber-500/30 bg-amber-500/5 px-4 py-2.5 space-y-1" data-testid="ax-warnings">
          {warnings.map((w, i) => (
            <p key={i} className="text-xs text-amber-300">{typeof w === 'string' ? w : (w?.message ?? JSON.stringify(w))}</p>
          ))}
        </div>
      )}

      {/* Result */}
      {error ? (
        <Notice testid="ax-error" tone="warn">{error}</Notice>
      ) : loading && !result ? (
        <Notice testid="ax-loading">Crunching the numbers…</Notice>
      ) : mode === 'query' && !metrics.length ? (
        <Notice testid="ax-no-metrics">Pick at least one metric to explore.</Notice>
      ) : mode !== 'query' && !scopedFunnelId ? (
        <Notice testid="ax-need-funnel">Scope a funnel to run this report.</Notice>
      ) : !hasData ? (
        <Notice testid="ax-empty">No rows in this window.</Notice>
      ) : mode === 'roas' ? (
        <RoasTable result={result} dimension={roasDimension} />
      ) : mode === 'clicks' ? (
        <ClicksTable result={result} />
      ) : viz === 'big-number' ? (
        <BigNumbers metrics={metrics} q={q} compare={compare} />
      ) : viz === 'table' ? (
        <QueryTable
          rows={tableRows} metrics={metrics}
          headLabel={dimension ? DIMENSIONS[dimension].label : GRANULARITIES[granularity].label}
          totals={q.totals} meta={meta}
        />
      ) : (
        <div className="rounded-xl border border-border-default bg-bg-card p-4" data-testid="ax-chartcard">
          <div className="flex items-center justify-between gap-2 flex-wrap mb-2">
            <p className="text-sm font-semibold text-text-primary">{reportTitle(scopedState)}</p>
            <div className="flex items-center gap-3 flex-wrap">
              {metrics.map((m, i) => (
                <span key={m} className="inline-flex items-center gap-1.5 text-xs text-text-muted">
                  <span className="h-2 w-2 rounded-full" style={{ background: colorForIndex(i) }} />
                  {labelFor(m)}
                </span>
              ))}
              {prevLabelText && <span className="text-xs text-text-faint">{prevLabelText}</span>}
            </div>
          </div>
          <ExplorerChart
            viz={viz === 'line' ? 'line' : 'bar'}
            data={tableRows}
            prevData={compare ? q.prevSeries : []}
            metricKeys={metrics}
            labels={labels}
            formatters={formatters}
          />
          <MetaFootnote meta={meta} />
        </div>
      )}
    </div>
  );
}

/* ── result sub-surfaces ───────────────────────────────────────────────── */

function MetaFootnote({ meta }) {
  const basisLabel = meta && typeof meta.basis_label === 'string' ? meta.basis_label : '';
  const basis = meta && typeof meta.basis === 'string' ? meta.basis : '';
  if (!basisLabel && !basis) return null;
  return (
    <p className="mt-2 text-[10px] text-text-faint" data-testid="ax-basis">
      {basisLabel || `basis: ${basis}`}
    </p>
  );
}

function BigNumbers({ metrics, q, compare }) {
  return (
    <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4 gap-3" data-testid="ax-bignumbers">
      {metrics.map((m) => {
        const fmt = formatterFor(m);
        const cur = q.totals[m];
        const prev = q.hasPrevious ? q.prevTotals[m] : null;
        // NO DELTA WITHOUT A BASELINE. A missing or zero previous value has no
        // percentage — printing 0% or +100% there would be a fabricated fact.
        const canDelta = compare && q.hasPrevious
          && typeof prev === 'number' && Number.isFinite(prev) && prev !== 0
          && typeof cur === 'number' && Number.isFinite(cur);
        const delta = canDelta ? ((cur - prev) / Math.abs(prev)) * 100 : null;
        return (
          <div key={m} className="rounded-xl border border-border-default bg-bg-card p-4" data-testid={`ax-big-${m}`}>
            <p className="text-[10px] uppercase tracking-wider text-text-faint font-semibold">{labelFor(m)}</p>
            <p className="text-2xl font-medium tracking-tight mt-1 text-text-primary tabular-nums">{fmt(cur)}</p>
            {compare && (
              delta === null ? (
                <p className="text-[10px] text-text-faint mt-0.5">no baseline</p>
              ) : (
                <p className={`text-xs mt-0.5 tabular-nums ${delta >= 0 ? 'text-emerald-400' : 'text-danger'}`}>
                  {`${delta >= 0 ? '↗' : '↘'} ${Math.abs(delta).toFixed(1)}% vs previous`}
                </p>
              )
            )}
          </div>
        );
      })}
    </div>
  );
}

function QueryTable({ rows, metrics, headLabel, totals, meta }) {
  const hasTotals = totals && Object.keys(totals).length > 0;
  return (
    <div className="rounded-xl border border-border-default bg-bg-card p-4" data-testid="ax-table">
      <div className="overflow-x-auto">
        <table className="w-full min-w-[560px]">
          <thead>
            <tr className="border-b border-border-subtle">
              <TH>{headLabel}</TH>
              {metrics.map((m) => <TH key={m} right>{labelFor(m)}</TH>)}
            </tr>
          </thead>
          <tbody>
            {rows.map((r, i) => (
              <tr key={r.key ?? i} className="border-b border-border-subtle last:border-b-0" data-testid={`ax-row-${i}`}>
                <TD className="font-medium text-text-primary max-w-[280px] truncate">
                  {r.label ?? r.key ?? EM_DASH}
                </TD>
                {metrics.map((m) => (
                  <TD key={m} right className="text-text-primary">{formatterFor(m)(r[m])}</TD>
                ))}
              </tr>
            ))}
          </tbody>
          {hasTotals && (
            <tfoot>
              <tr className="border-t border-border-default">
                <TD className="font-semibold text-text-primary">Total</TD>
                {metrics.map((m) => (
                  <TD key={m} right className="font-semibold text-text-primary">{formatterFor(m)(totals[m])}</TD>
                ))}
              </tr>
            </tfoot>
          )}
        </table>
      </div>
      <MetaFootnote meta={meta} />
    </div>
  );
}

function RoasTable({ result, dimension }) {
  const { rows, totals } = result;
  return (
    <div className="rounded-xl border border-border-default bg-bg-card p-4" data-testid="ax-roas-table">
      <p className="text-sm font-semibold text-text-primary mb-2">{`ROAS by ${result.dimension || dimension}`}</p>
      <div className="overflow-x-auto">
        <table className="w-full min-w-[760px]">
          <thead>
            <tr className="border-b border-border-subtle">
              <TH>{result.dimension || dimension}</TH>
              <TH right>Clicks</TH>
              <TH right>Conversions</TH>
              <TH right>Revenue</TH>
              <TH right>Cost</TH>
              <TH right>CPA</TH>
              <TH right>ROAS</TH>
              <TH right>Cost source</TH>
            </tr>
          </thead>
          <tbody>
            {rows.map((r, i) => (
              <tr key={r.key ?? i} className="border-b border-border-subtle last:border-b-0" data-testid={`ax-roas-row-${i}`}>
                <TD className="font-medium text-text-primary max-w-[260px] truncate">{r.key || '(none)'}</TD>
                <TD right className="text-text-primary">{fmtInt(r.clicks)}</TD>
                <TD right className="text-text-primary">{fmtInt(r.conversions)}</TD>
                <TD right className="text-text-primary">{fmtMoney(r.revenue)}</TD>
                <TD right className="text-text-primary">{fmtMoney(r.cost)}</TD>
                <TD right className="text-text-primary">{fmtMoney(r.cpa)}</TD>
                <TD right className="text-text-primary">{fmtMultiple(r.roas)}</TD>
                {/* cost_source is a FIELD, not a footnote: an unknown cost is
                    why the two columns to its left are dashes. */}
                <TD right className="text-text-muted">{r.cost_source || EM_DASH}</TD>
              </tr>
            ))}
          </tbody>
          {totals && (
            <tfoot>
              <tr className="border-t border-border-default">
                <TD className="font-semibold text-text-primary">Total</TD>
                <TD right className="font-semibold text-text-primary">{fmtInt(totals.clicks)}</TD>
                <TD right className="font-semibold text-text-primary">{fmtInt(totals.conversions)}</TD>
                <TD right className="font-semibold text-text-primary">{fmtMoney(totals.revenue)}</TD>
                <TD right className="font-semibold text-text-primary">{fmtMoney(totals.cost)}</TD>
                <TD right className="font-semibold text-text-primary">{fmtMoney(totals.cpa)}</TD>
                <TD right className="font-semibold text-text-primary">{fmtMultiple(totals.roas)}</TD>
                <TD />
              </tr>
            </tfoot>
          )}
        </table>
      </div>
    </div>
  );
}

function ClicksTable({ result }) {
  const { clicks, byNetwork } = result;
  return (
    <div className="rounded-xl border border-border-default bg-bg-card p-4" data-testid="ax-clicks-table">
      <div className="flex items-center gap-2 flex-wrap mb-2">
        <p className="text-sm font-semibold text-text-primary">Click ledger</p>
        {Object.entries(byNetwork).map(([n, s]) => (
          <span key={n} className="rounded-full bg-bg-elevated border border-border-default px-2 py-0.5 text-[10px] text-text-muted tabular-nums">
            {`${n}: ${fmtInt(s?.clicks)} clicks · ${fmtInt(s?.converted)} conv`}
          </span>
        ))}
      </div>
      <div className="overflow-x-auto">
        <table className="w-full min-w-[860px]">
          <thead>
            <tr className="border-b border-border-subtle">
              <TH>Time (UTC)</TH>
              <TH>Network</TH>
              <TH>Click ID</TH>
              <TH>Campaign</TH>
              <TH right>Country</TH>
              <TH right>Device</TH>
              <TH right>CPC</TH>
              <TH right>Converted</TH>
            </tr>
          </thead>
          <tbody>
            {clicks.map((r, i) => (
              <tr key={r.id ?? i} className="border-b border-border-subtle last:border-b-0" data-testid={`ax-click-row-${i}`}>
                <TD className="text-text-primary tabular-nums">{fmtUtcMinute(r.ts)}</TD>
                <TD className="text-text-primary">{r.network || EM_DASH}</TD>
                <TD className="text-text-muted max-w-[180px] truncate" title={r.click_id}>{r.click_id || EM_DASH}</TD>
                <TD className="text-text-primary max-w-[160px] truncate">{r.campaign || r.struct?.campaign_id || EM_DASH}</TD>
                <TD right className="text-text-primary">{r.country || EM_DASH}</TD>
                <TD right className="text-text-primary">{r.device || EM_DASH}</TD>
                <TD right className="text-text-primary">{fmtMoney(r.cpc)}</TD>
                <TD right>
                  <span className={`rounded-full px-2 py-0.5 text-[10px] font-medium ${r.converted ? 'bg-emerald-500/10 text-emerald-400' : 'bg-bg-elevated text-text-muted'}`}>
                    {r.converted ? 'yes' : 'no'}
                  </span>
                </TD>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}
