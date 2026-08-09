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
 * WHAT IS AUTHORITATIVE, AND WHAT IS NOT.
 *   • The LEGALITY MATRIX is the engine's. /funnel-metrics/vocabulary is
 *     fetched on mount and installed into reportConfig, which then intersects
 *     with its local fallback table. An illegal chip is greyed with the reason
 *     on it; when the engine 422s anyway, its message is printed verbatim.
 *   • The WINDOW and the TIMEZONE printed in the header are the SERVER's, read
 *     off the response echo. The date picker is an INPUT — the roas/clicks
 *     endpoints take `days` and answer a window ending today, which is not the
 *     window the picker shows, so printing the picker there would date a
 *     report wrongly.
 *   • The BASIS is the server's `meta.basis_label` and nothing else.
 *
 * Money truth rules the pixels: null renders as an em dash, NEVER as 0 (see
 * ../format.js). Charts pass connectNulls={false}. A delta chip is drawn only
 * against a real previous-window baseline.
 *
 * Lane 3 lazy-imports this file's DEFAULT EXPORT from
 * client/src/pages/analytics/explorer/index.jsx. Every prop is optional so it
 * also renders standalone (it then offers its own funnel-id filter).
 */
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Download, Save } from 'lucide-react';
import DateRangePicker from '../../../components/ui/DateRangePicker';
import { EM_DASH, fmtInt } from '../format';
import {
  CHARTS, DIMENSIONS, DIMENSION_KEYS, GATEWAYS, GRANULARITIES, GRANULARITY_KEYS,
  METRICS, METRIC_GROUPS, METRIC_KEYS, MODES, MODE_KEYS, REPORT_TZ_FALLBACK,
  ROAS_DIMENSIONS, buildQueryBody, chartBlockReason, csvFilename,
  daysAgoInZone, dimensionBlockReason, downloadCsv, emptyState,
  formatterFor, granularityBlockReason, labelFor, legalCharts, legalGranularities,
  maxMetrics,
  mergeIntoSearch, metricBlockReason, normalizeState, reportTitle,
  seedFromParams, seedFromQuery, setServerVocabulary, stateToParams, toCsv,
  todayInZone, validateQueryState, windowDays, zoneLabel,
} from '../reportConfig';
import ExplorerChart from './ExplorerChart';
import { colorForIndex } from './chartColors';
import PresetGrid from './PresetGrid';
import SavedReports from './SavedReports';
import { BigNumbers, ClicksTable, QueryTable, RoasTable } from './ResultTables';
import { addSavedReport } from './savedReportsStore';
import {
  explorerApiError, fetchClicks, fetchQueryCsvBlob, fetchRoas, fetchVocabulary,
  readClicksResult, readQueryResult, readRoasResult, runQuery,
} from './explorerApi';

/** Chip-toggles must not burst the API; the work order pins this at 250ms. */
const QUERY_DEBOUNCE_MS = 250;
const LEDGER_DEBOUNCE_MS = 150;
const CLICKS_LIMIT = 200;
const DEFAULT_WINDOW_DAYS = 30;

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

/** A server warning is either a string or {source, reason, ...}. */
function warningText(w) {
  if (typeof w === 'string') return w;
  if (w && typeof w === 'object') {
    const src = typeof w.source === 'string' ? w.source : '';
    const reason = typeof w.reason === 'string' ? w.reason : JSON.stringify(w);
    return src ? `${src}: ${reason}` : reason;
  }
  return String(w);
}

/* ── the surface ───────────────────────────────────────────────────────── */

export default function AnalyticsExplorer({
  funnelId = '',
  funnelName = '',
  seed = null,
  onSyncParams = null,
  syncUrl,
}) {
  // An owning page that handles params itself must not also have the URL
  // rewritten underneath it — two writers on one address bar is a race.
  const writeUrl = syncUrl === undefined ? !onSyncParams : !!syncUrl;

  // Seeded ONCE from the address bar so a deep link opens the view it names.
  // The default window is derived in the REPORT zone, not in UTC and not in the
  // browser's zone: at 01:00 Madrid on the 9th, "today" in UTC is still the
  // 8th, and the default range would silently exclude the current day.
  const [state, setState] = useState(() => {
    const base = emptyState({
      window: {
        start_day: daysAgoInZone(DEFAULT_WINDOW_DAYS - 1, REPORT_TZ_FALLBACK),
        end_day: todayInZone(REPORT_TZ_FALLBACK),
      },
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
  // Bumped when the engine's matrix lands, so every legality read re-runs.
  const [vocabVersion, setVocabVersion] = useState(0);
  const [vocabZone, setVocabZone] = useState('');

  /**
   * A mode change invalidates the result. Without this, loading a saved
   * `clicks` report while a `query` result is on screen renders the clicks
   * table against the query payload — `result.rows` are metric rows, and the
   * first ROAS/clicks column read throws. `kind` gating below is the second
   * guard; this is the first.
   */
  const patch = useCallback((changes) => {
    setState((cur) => {
      const next = normalizeState({
        ...cur,
        ...changes,
        window: { ...cur.window, ...(changes.window || {}) },
        filters: { ...cur.filters, ...(changes.filters || {}) },
      });
      if (next.mode !== cur.mode) {
        setResult(null);
        setError('');
      }
      return next;
    });
  }, []);

  /** Has the operator moved the date picker? An untouched default may be
      re-derived once the engine names its reporting zone; a chosen range never is. */
  const windowTouched = useRef(false);

  /* ── the engine's legality matrix (authority) ── */
  useEffect(() => {
    const controller = new AbortController();
    (async () => {
      try {
        const vocab = await fetchVocabulary({ signal: controller.signal });
        if (controller.signal.aborted) return;
        if (!setServerVocabulary(vocab)) return;
        const zone = typeof vocab?.timezone === 'string' ? vocab.timezone : '';
        if (zone) setVocabZone(zone);
        setVocabVersion((v) => v + 1);
        // Re-run the repair pass against the now-authoritative matrix, and
        // re-derive an UNTOUCHED default window in the zone the engine named.
        setState((cur) => {
          const rederive = zone && zone !== REPORT_TZ_FALLBACK && !windowTouched.current;
          return normalizeState(rederive ? {
            ...cur,
            window: {
              start_day: daysAgoInZone(DEFAULT_WINDOW_DAYS - 1, zone),
              end_day: todayInZone(zone),
            },
          } : cur);
        });
      } catch {
        // Absent or unreachable: the local fallback table stays in charge and
        // the engine still refuses anything it disagrees with.
      }
    })();
    return () => controller.abort();
  }, []);

  /* An owning page (Lane 3) may scope the funnel from outside. Its value wins,
     but only when it actually CHANGES — otherwise it fights the local input. */
  const lastFunnelProp = useRef(funnelId);
  useEffect(() => {
    if (lastFunnelProp.current === funnelId) return;
    lastFunnelProp.current = funnelId;
    patch({ filters: { funnel_id: funnelId } });
  }, [funnelId, patch]);

  /* A preset / saved report handed down from outside; `seq` re-applies. */
  const seedSeq = seed && seed.seq;
  const lastSeedSeq = useRef(null);
  useEffect(() => {
    if (!seed || !seedSeq || lastSeedSeq.current === seedSeq) return;
    lastSeedSeq.current = seedSeq;
    setState((cur) => {
      const next = seedFromQuery(seed.query || seed, cur);
      if (next.mode !== cur.mode) { setResult(null); setError(''); }
      return next;
    });
  }, [seed, seedSeq]);

  /* ── the ONE query body: run, CSV, save and deep link all read it ── */
  const scopedState = useMemo(
    () => normalizeState({
      // vocabVersion is a real input: the installed matrix decides what survives.
      ...(void vocabVersion, state),
      filters: { ...state.filters, funnel_id: funnelId || state.filters.funnel_id },
    }),
    [state, funnelId, vocabVersion],
  );
  const queryBody = useMemo(() => buildQueryBody(scopedState), [scopedState]);
  const bodyKey = useMemo(() => JSON.stringify(queryBody), [queryBody]);
  const validation = useMemo(() => validateQueryState(scopedState), [scopedState]);
  const validationKey = validation.valid ? '' : validation.errors.map((e) => `${e.field}:${e.message}`).join('|');

  /* ── URL sync ──────────────────────────────────────────────────────────
     MERGED into whatever is already on the address bar. Rebuilding the query
     string from scratch deleted every param this component does not own — a
     host page's `tab=`, an inbound `utm_source=`, a session marker. */
  const paramsKey = useMemo(() => JSON.stringify(stateToParams(scopedState)), [scopedState]);
  // Held in a ref so a parent that passes an inline arrow does not re-fire the
  // effect (and re-write the URL) on every one of its own renders.
  const syncRef = useRef(onSyncParams);
  syncRef.current = onSyncParams;
  useEffect(() => {
    syncRef.current?.(JSON.parse(paramsKey));
    if (!writeUrl || typeof window === 'undefined' || !window.history?.replaceState) return;
    const search = mergeIntoSearch(JSON.parse(paramsKey), window.location.search);
    window.history.replaceState(window.history.state, '',
      `${window.location.pathname}${search ? `?${search}` : ''}${window.location.hash}`);
  }, [paramsKey, writeUrl]);

  const mode = scopedState.mode;
  const scopedFunnelId = scopedState.filters.funnel_id;
  const { roas_dimension: roasDimension, clicks_network: clicksNetwork } = scopedState;
  const spanDays = windowDays(scopedState.window.start_day, scopedState.window.end_day);

  /* ── run: query mode (debounced, and GATED ON VALIDATION) ── */
  useEffect(() => {
    if (mode !== 'query') return undefined;
    // An invalid state must not reach the network. It used to: the only gate
    // was `metrics.length`, so an over-long window burned a round-trip to be
    // told what the client already knew.
    if (validationKey) { setLoading(false); return undefined; }
    const controller = new AbortController();
    const timer = setTimeout(async () => {
      setLoading(true);
      setError('');
      try {
        const data = await runQuery(JSON.parse(bodyKey), { signal: controller.signal });
        setResult(readQueryResult(data));
      } catch (e) {
        if (controller.signal.aborted) return;
        setResult(null);
        setError(explorerApiError(e));
      } finally {
        if (!controller.signal.aborted) setLoading(false);
      }
    }, QUERY_DEBOUNCE_MS);
    return () => { clearTimeout(timer); controller.abort(); };
  }, [mode, bodyKey, validationKey]);

  /* ── run: roas / clicks modes ── */
  useEffect(() => {
    if (mode === 'query') return undefined;
    if (!scopedFunnelId) {
      // Clearing `loading` here matters: arriving from a mode whose fetch was
      // in flight otherwise left the spinner up forever with nothing running.
      setResult(null);
      setError('');
      setLoading(false);
      return undefined;
    }
    if (validationKey) { setLoading(false); return undefined; }
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
          setResult(readRoasResult(data));
        } else {
          const data = await fetchClicks(
            { funnelId: scopedFunnelId, network: clicksNetwork, limit: CLICKS_LIMIT },
            { signal: controller.signal },
          );
          setResult(readClicksResult(data));
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
  }, [mode, scopedFunnelId, roasDimension, clicksNetwork, spanDays, validationKey]);

  /**
   * THE SECOND GUARD. A result is only ever rendered by the mode that produced
   * it, so nothing downstream can read a clicks field off a query payload even
   * if a race lands one after a mode switch.
   */
  const active = result && result.kind === mode ? result : null;

  /* ── derived legality for the controls ── */
  const { metrics, dimension, granularity, viz, compare } = scopedState;
  const metricCap = maxMetrics();

  const grainOptions = useMemo(() => {
    void vocabVersion; // the matrix decides which granularities exist
    const legal = legalGranularities(scopedState.window.start_day, scopedState.window.end_day);
    return GRANULARITY_KEYS.map((g) => ({
      key: g,
      label: GRANULARITIES[g].label,
      disabled: !legal.includes(g),
      reason: granularityBlockReason(g, scopedState.window.start_day, scopedState.window.end_day),
    }));
  }, [scopedState.window.start_day, scopedState.window.end_day, vocabVersion]);

  const vizOptions = useMemo(() => {
    const legal = legalCharts(dimension, metrics);
    return Object.keys(CHARTS).map((c) => ({
      key: c,
      label: CHARTS[c].label,
      disabled: !legal.includes(c),
      reason: chartBlockReason(c, dimension, metrics),
    }));
  }, [dimension, metrics]);

  const metricChips = useMemo(() => (void vocabVersion, METRIC_KEYS).map((m) => {
    const reason = metricBlockReason(m, { dimension, granularity });
    const on = metrics.includes(m);
    return {
      key: m,
      label: METRICS[m].label,
      group: METRICS[m].group,
      on,
      // A SELECTED metric is never disabled — it must always be removable, or
      // an illegal combination reached by changing the group-by would trap the
      // operator with no way back.
      disabled: !on && (!!reason || metrics.length >= metricCap),
      reason: reason || (metrics.length >= metricCap && !on
        ? `The engine takes at most ${metricCap} metrics.` : ''),
    };
  }), [metrics, dimension, granularity, metricCap, vocabVersion]);

  const toggleMetric = (key) => {
    patch({
      metrics: metrics.includes(key) ? metrics.filter((k) => k !== key) : [...metrics, key],
    });
  };

  /* ── the zone + window actually printed ── */
  const zone = (active && active.timezone) || vocabZone || REPORT_TZ_FALLBACK;
  const zoneText = zoneLabel(zone);
  // The server's echo when there is one; the picker only until then. For
  // roas/clicks the difference is REAL — those endpoints take `days` and answer
  // a window ending today.
  const shownWindow = active && active.window && active.window.from_server
    ? active.window
    : { start_day: scopedState.window.start_day, end_day: scopedState.window.end_day, from_server: false };

  /* ── CSV ── */
  const csvColumns = mode === 'roas'
    ? [
      { key: 'key', label: 'key' }, { key: 'clicks', label: 'clicks' },
      { key: 'bot_clicks', label: 'bot_clicks' }, { key: 'conversions', label: 'conversions' },
      { key: 'revenue', label: 'revenue' }, { key: 'cost', label: 'cost' },
      { key: 'cpa', label: 'cpa' }, { key: 'roas', label: 'roas' },
      { key: 'cost_source', label: 'cost_source' },
      { key: 'cost_unknown_reason', label: 'cost_unknown_reason' },
      { key: 'cost_note', label: 'cost_note' },
    ]
    : [
      { key: 'time', label: 'time' }, { key: 'day', label: 'day' },
      { key: 'network', label: 'network' }, { key: 'click_id', label: 'click_id' },
      { key: 'campaign', label: 'campaign' }, { key: 'country', label: 'country' },
      { key: 'device', label: 'device' }, { key: 'cpc', label: 'cpc' },
      { key: 'bot', label: 'bot' }, { key: 'velocity_flag', label: 'velocity_flag' },
      { key: 'converted', label: 'converted' },
    ];

  const exportCsv = async () => {
    setExporting(true);
    setError('');
    try {
      if (mode === 'query') {
        const blob = await fetchQueryCsvBlob(queryBody);
        const url = URL.createObjectURL(blob);
        const a = document.createElement('a');
        a.href = url;
        a.download = csvFilename(scopedState);
        a.click();
        URL.revokeObjectURL(url);
      } else {
        // These two endpoints have no .csv twin, so the export is folded from
        // the SAME rows on screen — through the same injection-guarded writer.
        downloadCsv(csvFilename(scopedState), toCsv({ columns: csvColumns, rows: active.rows }));
      }
    } catch (e) {
      // Never a silent failure — a swallowed 422 reads as "nothing to export".
      setError(explorerApiError(e, 'CSV export failed — try again.'));
    } finally {
      setExporting(false);
    }
  };

  /* ── saved reports ── */
  const saveCurrent = () => {
    const name = saveName.trim();
    if (!name) return;
    if (!addSavedReport(name, scopedState)) {
      setSaveError('Could not save — browser storage is unavailable or full.');
      return;
    }
    setSaveError('');
    setSaveName('');
    setSavedRefresh((n) => n + 1);
  };

  /* ── render helpers ── */
  const formatters = useMemo(
    () => Object.fromEntries(metrics.map((m) => [m, formatterFor(m)])),
    [metrics],
  );
  const labels = useMemo(
    () => Object.fromEntries(metrics.map((m) => [m, labelFor(m)])), [metrics]);

  const chartRows = active && mode === 'query' ? (dimension ? active.rows : active.series) : [];
  const warnings = active ? active.warnings : [];

  const hasData = mode === 'query'
    ? (viz === 'big-number'
      ? !!active && Object.keys(active.totals).length > 0
      : chartRows.length > 0)
    : !!active && active.rows.length > 0;

  const prevLabelText = compare && active && mode === 'query'
    ? (active.hasPrevious ? 'vs previous period (dashed)'
      : 'no previous window came back — nothing to compare against')
    : '';

  return (
    <div className="space-y-3" data-testid="analytics-explorer">
      {/* Header */}
      <div className="flex items-end justify-between gap-3 flex-wrap">
        <div>
          <h2 className="text-lg font-semibold text-text-primary">Explore</h2>
          <p className="text-xs text-text-muted" data-testid="ax-header-line">
            {reportTitle(scopedState)}
            {' · '}
            {shownWindow.start_day || EM_DASH} → {shownWindow.end_day || EM_DASH}
            {zoneText ? ` · ${zoneText}` : ''}
            {shownWindow.from_server ? '' : ' · window not yet confirmed by the server'}
            {funnelName ? ` · ${funnelName}` : ''}
            {active && active.meta && active.meta.computed_ms != null
              ? ` · ${fmtInt(active.meta.computed_ms)} ms` : ''}
          </p>
        </div>
        <DateRangePicker
          startDate={scopedState.window.start_day || daysAgoInZone(DEFAULT_WINDOW_DAYS - 1, zone)}
          endDate={scopedState.window.end_day || todayInZone(zone)}
          onChange={({ startDate, endDate }) => {
            windowTouched.current = true;
            patch({ window: { start_day: startDate, end_day: endDate } });
          }}
        />
      </div>

      <SavedReports
        key={savedRefresh}
        onLoad={(entry) => setState((cur) => {
          const next = normalizeState(entry.state || entry.query);
          if (next.mode !== cur.mode) { setResult(null); setError(''); }
          return next;
        })}
      />

      <PresetGrid
        activeId={scopedState.report}
        onPick={(p) => setState((cur) => {
          const next = seedFromQuery({ ...(p.query || {}), mode: p.mode, report: p.id }, cur);
          if (next.mode !== cur.mode) { setResult(null); setError(''); }
          return next;
        })}
      />

      {/* Controls */}
      <div className="rounded-xl border border-border-default bg-bg-card p-4 space-y-3" data-testid="ax-controls">
        <div className="flex items-center justify-between gap-2 flex-wrap">
          <Seg
            testPrefix="ax-mode"
            options={MODE_KEYS.map((m) => ({ key: m, label: MODES[m].label }))}
            value={mode}
            onChange={(m) => patch({ mode: m })}
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
              {/* NO client-side basis here. The basis is whatever the response
                  says it is, and it is printed under the result. */}
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
                  maxLength={64}
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
                maxLength={120}
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
                maxLength={64}
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
            {mode === 'clicks' && active && Object.keys(active.byNetwork).length > 0 && (
              <select
                value={clicksNetwork}
                onChange={(e) => patch({ clicks_network: e.target.value })}
                className="h-8 rounded-lg border border-border-default bg-bg-elevated px-3 text-xs font-medium text-text-primary outline-none cursor-pointer"
                data-testid="ax-clicks-network"
              >
                <option value="">All networks</option>
                {Object.keys(active.byNetwork).map((net) => <option key={net} value={net}>{net}</option>)}
              </select>
            )}
            <span className="text-xs text-text-muted">
              {scopedFunnelId
                ? (mode === 'roas'
                  // The picker supplies a LENGTH here, not a range: the endpoint
                  // takes `days` and answers a window ending today. Saying so
                  // stops the header and the picker reading as a contradiction.
                  ? `Scoped to ${funnelName || scopedFunnelId} · last ${spanDays ?? EM_DASH} days (the picker sets the LENGTH; this report always ends today)`
                  : `Scoped to ${funnelName || scopedFunnelId} · newest ${CLICKS_LIMIT} clicks`)
                : 'This is a per-funnel report — scope a funnel to run it.'}
            </span>
          </div>
        )}
      </div>

      {/* Server-declared caveats, printed before any number is read. */}
      {warnings.length > 0 && (
        <div className="rounded-xl border border-amber-500/30 bg-amber-500/5 px-4 py-2.5 space-y-1" data-testid="ax-warnings">
          {warnings.map((w, i) => (
            <p key={i} className="text-xs text-amber-300">{warningText(w)}</p>
          ))}
        </div>
      )}

      {/* Result */}
      {/* "No funnel scoped" is a MISSING INPUT, not an invalid one, and it is
          checked first so it keeps its own plain-language notice instead of
          being listed as a validation failure. */}
      {mode !== 'query' && !scopedFunnelId ? (
        <Notice testid="ax-need-funnel">
          Scope a funnel to run this report — it is a per-funnel report.
        </Notice>
      ) : !validation.valid ? (
        <Notice testid="ax-invalid" tone="warn">
          <ul className="space-y-0.5">
            {validation.errors.map((e, i) => <li key={i}>{e.message}</li>)}
          </ul>
        </Notice>
      ) : error ? (
        <Notice testid="ax-error" tone="warn">{error}</Notice>
      ) : loading && !active ? (
        <Notice testid="ax-loading">Crunching the numbers…</Notice>
      ) : !hasData ? (
        <Notice testid="ax-empty">No rows in this window.</Notice>
      ) : mode === 'roas' ? (
        <RoasTable result={active} dimension={roasDimension} />
      ) : mode === 'clicks' ? (
        <ClicksTable result={active} timezone={zone} />
      ) : viz === 'big-number' ? (
        <BigNumbers
          metrics={metrics}
          totals={active.totals}
          prevTotals={active.prevTotals}
          hasPrevious={active.hasPrevious}
          compare={compare}
        />
      ) : viz === 'table' ? (
        <QueryTable
          rows={chartRows}
          metrics={metrics}
          headLabel={dimension ? DIMENSIONS[dimension].label : GRANULARITIES[granularity].label}
          totals={active.totals}
          basisLabel={active.basisLabel}
          limit={scopedState.limit}
          grouped={!!dimension}
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
            data={chartRows}
            prevData={compare ? (dimension ? active.prevRows : active.prevSeries) : []}
            metricKeys={metrics}
            labels={labels}
            formatters={formatters}
          />
          <p className="mt-2 text-[10px] text-text-faint" data-testid="ax-basis">
            {active.basisLabel || ''}
          </p>
        </div>
      )}
    </div>
  );
}
