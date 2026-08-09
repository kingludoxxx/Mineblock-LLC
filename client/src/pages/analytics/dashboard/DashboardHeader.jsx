// DashboardHeader — title, the provenance line, and the control cluster
// (NEW FILE, LANE 3).
//
// THE PROVENANCE LINE IS THE MOST IMPORTANT STRING ON THE PAGE:
//
//   Aug 1 – Aug 9, 2026 · Compared to Jul 24 – Aug 1, 2026 · Madrid time ·
//   All funnels · 7 funnels
//
// Every clause answers a question an operator would otherwise have to guess:
// which window, against WHICH baseline (the compare period's own calendar
// dates, because the two series are overlaid by index and the dashed line's
// dates are not on the axis), which reporting zone the day keys are cut in,
// what the page is scoped to, and how many funnels the scope covers.
//
// THE ZONE IS RENDERED, NOT ASSERTED. `window.timezone` is the server's claim
// about the zone every figure was computed in — Europe/Madrid gets the
// operator's own words ("Madrid time"), any other zone prints its raw IANA
// string, and an absent zone prints nothing at all. Hardcoding the label would
// survive exactly until REPORT_TZ moved, and would then caption one zone's days
// with another zone's name.
//
// The scope selector, the range picker and refresh are the page's ONLY chrome —
// no tab strip. The explorer is a sibling route, reached from the button here.
import { ChevronDown, ChevronRight, RefreshCw, Radio, Compass } from 'lucide-react';
import DateRangePicker from '../../../components/ui/DateRangePicker';
import { prettyRange, tzLabel } from './dashFormat.js';

export default function DashboardHeader({
  start,
  end,
  window: win,
  funnelCount,
  scopeLabel,
  funnelOptions,
  funnelId,
  onScopeChange,
  onRangeChange,
  onRefresh,
  refreshing,
  collapsed,
  onToggleCollapsed,
  onOpenExplorer,
  onOpenLive,
}) {
  const zone = tzLabel(win && win.timezone);
  const comparedTo = win && win.prev_start && win.prev_end
    ? `Compared to ${prettyRange(win.prev_start, win.prev_end)}`
    : 'Compared to the previous period';

  // Joined, not interpolated: a clause with nothing to say is DROPPED rather
  // than printed as "undefined" or as an orphan separator.
  const line = [
    prettyRange(win && win.start ? win.start : start, win && win.end ? win.end : end),
    comparedTo,
    zone,
    scopeLabel,
    funnelCount === null || funnelCount === undefined
      ? null
      : `${funnelCount} funnel${funnelCount === 1 ? '' : 's'}`,
  ].filter(Boolean).join(' · ');

  return (
    <header className="flex items-start justify-between gap-3 flex-wrap" data-testid="an-dash-header">
      <div className="min-w-0">
        <button
          type="button"
          onClick={onToggleCollapsed}
          className="flex items-center gap-1.5 text-left group"
          aria-expanded={!collapsed}
          data-testid="an-dash-collapse"
        >
          {collapsed
            ? <ChevronRight className="w-4 h-4 text-text-muted group-hover:text-text-primary transition-colors" />
            : <ChevronDown className="w-4 h-4 text-text-muted group-hover:text-text-primary transition-colors" />}
          <h1 className="text-xl font-semibold text-text-primary tracking-tight">Analytics</h1>
          <span className="ml-2 text-[10px] uppercase tracking-wide text-text-faint border border-border-default rounded-full px-2 py-0.5">
            Dashboard
          </span>
        </button>
        <p className="text-xs text-text-muted mt-1 tracking-tight" data-testid="an-dash-provenance">
          {line}
        </p>
      </div>

      <div className="flex items-end gap-2 flex-wrap">
        <button
          type="button"
          onClick={onOpenLive}
          className="h-[38px] inline-flex items-center gap-1.5 rounded-lg border border-border-default bg-bg-elevated
                     px-3 text-xs font-medium text-text-muted hover:text-text-primary transition-colors"
          data-testid="an-dash-live-view"
        >
          <Radio className="w-3.5 h-3.5" />
          Live view
        </button>
        <button
          type="button"
          onClick={onOpenExplorer}
          className="h-[38px] inline-flex items-center gap-1.5 rounded-lg border border-border-default bg-bg-elevated
                     px-3 text-xs font-medium text-text-muted hover:text-text-primary transition-colors"
          data-testid="an-dash-explorer"
        >
          <Compass className="w-3.5 h-3.5" />
          Explorer
        </button>

        {/* Scope. The options come out of the composite's own funnel breakdown —
            this page does not spend a third request on a funnel list. */}
        <div>
          <label
            className="block text-[10px] uppercase tracking-wide text-text-muted font-semibold mb-1"
            htmlFor="an-dash-scope"
          >
            Scope
          </label>
          <div className="relative">
            <select
              id="an-dash-scope"
              value={funnelId || ''}
              onChange={(e) => onScopeChange(e.target.value)}
              className="h-[38px] appearance-none pl-3 pr-8 text-xs bg-bg-elevated border border-border-default rounded-lg
                         text-text-primary focus:outline-none focus:ring-2 focus:ring-accent/40 cursor-pointer
                         max-w-[220px] truncate"
              data-testid="an-dash-scope-select"
            >
              <option value="">All funnels</option>
              {(funnelOptions || []).map((o) => (
                <option key={o.value} value={o.value}>{o.label}</option>
              ))}
            </select>
            <ChevronDown className="absolute right-2.5 top-1/2 -translate-y-1/2 w-4 h-4 text-text-muted pointer-events-none" />
          </div>
        </div>

        <div>
          <label className="block text-[10px] uppercase tracking-wide text-text-muted font-semibold mb-1">
            Date range
          </label>
          {/* Day strings pass through UNCHANGED. The picker speaks calendar days
              and the server interprets them in REPORT_TZ — converting here would
              shift every window by the zone offset, twice. */}
          <DateRangePicker
            startDate={start}
            endDate={end}
            onChange={({ startDate, endDate }) => onRangeChange(startDate, endDate)}
          />
        </div>

        <button
          type="button"
          onClick={onRefresh}
          disabled={refreshing}
          title="Refresh"
          aria-label="Refresh"
          className="h-[38px] w-[38px] inline-flex items-center justify-center rounded-lg border border-border-default
                     bg-bg-elevated text-text-muted hover:text-text-primary disabled:opacity-50 transition-colors"
          data-testid="an-dash-refresh"
        >
          <RefreshCw className={`w-4 h-4 ${refreshing ? 'animate-spin' : ''}`} />
        </button>
      </div>
    </header>
  );
}
