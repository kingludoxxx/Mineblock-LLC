// PnLPage — per-funnel P&L: revenue, real costs, real spend, honest profit
// (NEW FILE, costs lane).
//
// THE ONE RULE: profit is WITHHELD, never invented. A funnel with zero cost
// coverage shows a DASH for GP/margin/net — never 100% margin. A funnel whose
// spend is unknown shows a dash for net profit/ROAS/CPA (`spend_known` is the
// server's claim, and we render exactly it). Missing-leg counts ride beside
// partial numbers so a partial figure is never mistaken for a complete one.
//
// Spend is REAL: Meta campaign-day rows bound to funnels (derived majority
// binding, operator pins win) plus manual entries. The staleness bar at the
// top reads /spend/status — a sync that has not succeeded for ≥6h means the
// spend column may lag, and the bar says so instead of letting the number
// quietly go stale.
import { useCallback, useEffect, useMemo, useState } from 'react';
import { useSearchParams } from 'react-router-dom';
import {
  AlertTriangle, ChevronLeft, Loader2, Pin, PinOff, Plus, RefreshCw, Trash2, TrendingUp,
} from 'lucide-react';
import {
  CartesianGrid, Legend, Line, LineChart, ResponsiveContainer, Tooltip, XAxis, YAxis,
} from 'recharts';
import Card from '../../components/ui/Card';
import DateRangePicker from '../../components/ui/DateRangePicker';
import { usePermissions } from '../../hooks/usePermissions';
import CostsSubnav from './components/CostsSubnav';
import {
  costApiError, dailyOf, deleteManualSpend, fetchPnlFunnel, fetchPnlOverview,
  fetchSpendStatus, manualOf, postCampaignMap, postManualSpend, postSpendSync,
  rowsOf, sourcesOf,
} from './costsApi';
import {
  EM_DASH, daysAgoIso, fmtInt, fmtMoney, fmtMoney0, fmtPct, fmtX,
  parseManualSpend, todayIso,
} from './costTargets';

const STALE_MS = 6 * 60 * 60 * 1000; // the work order's ≥6h staleness bar

const TH = ({ children, right }) => (
  <th
    className={`px-3 py-2 text-[11px] font-semibold uppercase tracking-wide text-text-muted whitespace-nowrap ${
      right ? 'text-right' : 'text-left'
    }`}
  >
    {children}
  </th>
);

const TD = ({ children, right, className = '' }) => (
  <td className={`px-3 py-2 text-sm whitespace-nowrap ${right ? 'text-right tabular-nums' : ''} ${className}`}>
    {children}
  </td>
);

/**
 * A money cell that keeps null (withheld / unknown) distinct from a real
 * number — including a real $0.00. `title` explains WHY the dash, because a
 * dash with no reason reads as a rendering bug on a money page.
 */
function Money({ v, title, cls = 'text-text-primary' }) {
  if (v === null || v === undefined || !Number.isFinite(Number(v))) {
    return <span className="text-text-faint" title={title}>{EM_DASH}</span>;
  }
  const n = Number(v);
  return <span className={`${n < 0 ? 'text-danger' : cls}`}>{fmtMoney(n)}</span>;
}

/** Coverage % with the missing-leg counts that qualify every partial number. */
function CoverageCell({ row }) {
  const pct = row.cost_coverage_pct;
  if (pct === null || pct === undefined) return <span className="text-text-faint">{EM_DASH}</span>;
  const n = Number(pct);
  const tone = n >= 100 ? 'bg-green-400' : n > 0 ? 'bg-amber-400' : 'bg-danger';
  const missing = row.missing_legs ?? null;
  return (
    <div className="flex items-center gap-2 justify-end">
      {missing != null && missing > 0 && (
        <span className="text-[10px] text-amber-400 tabular-nums" title={
          `${missing} order leg${missing === 1 ? '' : 's'} in this window have no cost`
          + (row.missing_cogs_legs != null ? ` (${row.missing_cogs_legs} COGS, ${row.missing_ship_legs ?? 0} ship)` : '')
        }>
          {missing} legs
        </span>
      )}
      <span className="tabular-nums text-xs text-text-muted w-[38px] text-right">{n.toFixed(0)}%</span>
      <span className="h-1.5 w-12 rounded-full bg-bg-elevated overflow-hidden shrink-0">
        <span className={`block h-full rounded-full ${tone}`} style={{ width: `${Math.min(100, Math.max(0, n))}%` }} />
      </span>
    </div>
  );
}

function ChartTooltip({ active, payload, label }) {
  if (!active || !payload?.length) return null;
  return (
    <div className="rounded-lg border border-border-default bg-bg-card px-3 py-2 text-xs shadow-xl">
      <p className="text-text-muted mb-1 tabular-nums">{label}</p>
      {payload.map((p) => (
        <p key={p.dataKey} className="flex items-center gap-2">
          <span className="w-2 h-2 rounded-full" style={{ background: p.stroke }} />
          <span className="text-text-muted">{p.name}:</span>
          <span className="tabular-nums text-text-primary">
            {p.value === null || p.value === undefined ? EM_DASH : fmtMoney(p.value)}
          </span>
        </p>
      ))}
    </div>
  );
}

/* ── spend staleness bar ───────────────────────────────────────────────── */

function SpendStalenessBar({ status, syncing, onSync, canEdit }) {
  // `status` is `{ data, at }` — the clock was read when the response ARRIVED
  // (an event, not a render), so this component stays pure and the age is
  // measured against the moment the status was actually true.
  const sources = sourcesOf(status?.data);
  const meta = sources.find((s) => s.source === 'meta') || sources[0];
  if (!meta || !status?.at) return null;

  const lastOk = meta.last_ok || meta.last_sync;
  const ageMs = lastOk ? status.at - new Date(lastOk).getTime() : Infinity;
  const stale = meta.stale ?? (ageMs >= STALE_MS);
  const ageText = !lastOk
    ? 'never synced'
    : ageMs < 60 * 60 * 1000
      ? `${Math.max(1, Math.round(ageMs / 60000))}m ago`
      : `${Math.round(ageMs / 3600000)}h ago`;

  return (
    <div
      className={`rounded-lg border px-3 py-2.5 flex items-center gap-2.5 flex-wrap ${
        stale ? 'border-amber-500/30 bg-amber-500/5' : 'border-border-default bg-bg-card'
      }`}
      data-testid="pnl-spend-status"
    >
      {stale
        ? <AlertTriangle className="w-4 h-4 text-amber-400 shrink-0" />
        : <TrendingUp className="w-4 h-4 text-text-muted shrink-0" />}
      <span className={`text-[12px] ${stale ? 'text-amber-200/90' : 'text-text-muted'}`}>
        {stale ? (
          <>
            <strong className="font-medium">Meta spend is stale</strong> — last successful sync {ageText}.
            The spend column may lag reality.
          </>
        ) : (
          <>Meta spend synced {ageText}.</>
        )}
        {meta.error ? <span className="ml-1.5">Last error: {String(meta.error)}</span> : null}
        {Number(meta.fail_streak) > 0 ? (
          <span className="ml-1.5 tabular-nums">({meta.fail_streak} consecutive failures)</span>
        ) : null}
      </span>
      {canEdit && (
        <button
          type="button"
          onClick={onSync}
          disabled={syncing}
          data-testid="pnl-spend-sync"
          className="ml-auto inline-flex items-center gap-1.5 h-7 px-2.5 rounded-md border border-border-default
                     bg-bg-elevated text-[11px] text-text-muted hover:text-text-primary disabled:opacity-50 transition-colors"
        >
          {syncing ? <Loader2 className="w-3 h-3 animate-spin" /> : <RefreshCw className="w-3 h-3" />}
          {syncing ? 'Syncing…' : 'Sync now'}
        </button>
      )}
    </div>
  );
}

/* ── the drill-in ──────────────────────────────────────────────────────── */

function FunnelDrillIn({ fid, name, start, end, canEdit, onBack, notify }) {
  const [data, setData] = useState(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);
  const [pinBusy, setPinBusy] = useState(null); // campaign_id in flight
  const [spendDay, setSpendDay] = useState(todayIso());
  const [spendAmount, setSpendAmount] = useState('');
  const [spendNote, setSpendNote] = useState('');
  const [spendErr, setSpendErr] = useState(null);
  const [spendBusy, setSpendBusy] = useState(false);

  const load = useCallback(async ({ quiet = false } = {}) => {
    if (!quiet) setLoading(true);
    try {
      const res = await fetchPnlFunnel(fid, { start, end });
      setData(res);
      setError(null);
    } catch (e) {
      setError(costApiError(e, 'Could not load this funnel'));
    } finally {
      if (!quiet) setLoading(false);
    }
  }, [fid, start, end]);

  useEffect(() => { load(); }, [load]);

  const daily = useMemo(() => dailyOf(data).map((d) => ({
    day: String(d.day || d.date || '').slice(5, 10),
    revenue: d.revenue ?? null,
    spend: d.spend ?? null,
    // gp arrives null on withheld days — the chart line breaks there instead
    // of drawing a flattering zero or a fake 100%-margin ridge.
    gp: d.gp ?? null,
  })), [data]);

  const campaigns = useMemo(() => (Array.isArray(data?.campaigns) ? data.campaigns : []), [data]);
  const manual = useMemo(() => manualOf(data), [data]);
  const totals = data?.totals || null;

  const togglePin = async (c) => {
    const pinned = Boolean(c.pinned ?? (c.binding === 'pin'));
    setPinBusy(c.campaign_id);
    try {
      await postCampaignMap({
        campaign_id: c.campaign_id,
        funnel_id: pinned ? undefined : fid,
        action: pinned ? 'unpin' : 'pin',
      });
      notify(pinned
        ? `Unpinned ${c.campaign_name || c.campaign_id} — derived binding resumes.`
        : `Pinned ${c.campaign_name || c.campaign_id} to this funnel.`);
      await load({ quiet: true });
    } catch (e) {
      notify(costApiError(e, 'Could not update the campaign pin'), true);
    } finally {
      setPinBusy(null);
    }
  };

  const addManual = async () => {
    const parsed = parseManualSpend(spendAmount);
    if (parsed.error) {
      setSpendErr(parsed.error === 'empty'
        ? 'Enter an amount — there is nothing to save.'
        : parsed.error === 'negative' ? 'Spend cannot be negative.' : 'Enter a number.');
      return;
    }
    if (!spendDay) { setSpendErr('Pick a day.'); return; }
    setSpendBusy(true);
    setSpendErr(null);
    try {
      await postManualSpend(fid, { day: spendDay, spend: parsed.value, note: spendNote.trim() || undefined });
      setSpendAmount('');
      setSpendNote('');
      notify(`Manual spend recorded for ${spendDay}.`);
      await load({ quiet: true });
    } catch (e) {
      setSpendErr(costApiError(e, 'Could not save the manual spend'));
    } finally {
      setSpendBusy(false);
    }
  };

  const removeManual = async (day) => {
    try {
      await deleteManualSpend(fid, day);
      notify(`Manual spend for ${day} removed.`);
      await load({ quiet: true });
    } catch (e) {
      notify(costApiError(e, 'Could not remove the manual spend'), true);
    }
  };

  return (
    <div className="space-y-4" data-testid="pnl-drillin">
      <div className="flex items-center gap-3">
        <button
          type="button"
          onClick={onBack}
          className="inline-flex items-center gap-1 text-sm text-text-muted hover:text-text-primary transition-colors"
          data-testid="pnl-back"
        >
          <ChevronLeft className="w-4 h-4" /> All funnels
        </button>
        <h2 className="text-base font-semibold text-text-primary">{name || fid}</h2>
      </div>

      {error ? (
        <Card className="border-danger/30 bg-danger/5 text-sm text-danger flex items-center gap-2">
          <AlertTriangle className="w-4 h-4" />
          {String(error)}
        </Card>
      ) : null}

      {/* Totals strip — same withholding rules as the overview table. */}
      {totals && (
        <div className="grid grid-cols-2 sm:grid-cols-4 lg:grid-cols-7 gap-3">
          {[
            ['Revenue', totals.revenue, null],
            ['COGS', totals.cogs, 'No cost coverage in this window'],
            ['Fees', totals.fees, null],
            ['Shipping', totals.ship_cost, 'Shipping cost unknown'],
            ['Gross profit', totals.gp, 'Withheld — cost coverage is incomplete'],
            ['Spend', totals.spend_known === false ? null : totals.spend, 'Spend unknown for this window'],
            ['Net profit', totals.net_profit, 'Withheld — needs full costs AND known spend'],
          ].map(([label, v, why]) => (
            <Card key={label} className="p-3">
              <p className="text-[10px] uppercase tracking-wide text-text-muted font-semibold">{label}</p>
              <p className="text-base font-semibold mt-1 tabular-nums">
                <Money v={v} title={why || undefined} />
              </p>
            </Card>
          ))}
        </div>
      )}

      {/* Daily series — a null GP day breaks the line rather than reading 0. */}
      <Card className="p-4">
        <h3 className="text-sm font-semibold text-text-primary mb-3">Daily revenue · spend · gross profit</h3>
        {loading && !data ? (
          <div className="text-sm text-text-muted py-10 text-center">Loading…</div>
        ) : daily.length ? (
          <div className="h-[260px]">
            <ResponsiveContainer width="100%" height="100%">
              <LineChart data={daily} margin={{ top: 4, right: 8, bottom: 0, left: 8 }}>
                <CartesianGrid strokeDasharray="3 3" stroke="rgba(255,255,255,0.04)" />
                <XAxis dataKey="day" tick={{ fill: 'rgba(255,255,255,0.4)', fontSize: 10 }} tickLine={false} axisLine={false} />
                <YAxis tickFormatter={(v) => fmtMoney0(v)} tick={{ fill: 'rgba(255,255,255,0.4)', fontSize: 10 }} tickLine={false} axisLine={false} width={64} />
                <Tooltip content={<ChartTooltip />} />
                <Legend wrapperStyle={{ fontSize: 11 }} />
                <Line type="monotone" dataKey="revenue" name="Revenue" stroke="#4ade80" strokeWidth={1.75} dot={false} connectNulls={false} />
                <Line type="monotone" dataKey="spend" name="Spend" stroke="#f87171" strokeWidth={1.75} dot={false} connectNulls={false} />
                <Line type="monotone" dataKey="gp" name="Gross profit" stroke="#60a5fa" strokeWidth={1.75} dot={false} connectNulls={false} />
              </LineChart>
            </ResponsiveContainer>
          </div>
        ) : (
          <div className="text-sm text-text-muted py-10 text-center">No daily rows in this window.</div>
        )}
        <p className="text-[10.5px] text-text-faint mt-2">
          A gap in the gross-profit line is a day whose costs are unknown — the profit is withheld, not zero.
        </p>
      </Card>

      <div className="grid gap-4 lg:grid-cols-2">
        {/* Campaigns — where the spend comes from, and the pin that overrides
            the derived binding. */}
        <Card className="p-0 overflow-hidden">
          <div className="px-4 py-3 border-b border-border-default">
            <h3 className="text-sm font-semibold text-text-primary">Campaigns feeding this funnel</h3>
            <p className="text-[11px] text-text-faint mt-0.5">
              Derived bindings follow the clicks; a pin is an operator override and always wins.
            </p>
          </div>
          <div className="p-2">
            {campaigns.length ? (
              <table className="w-full border-collapse">
                <thead>
                  <tr className="border-b border-border-default">
                    <TH>Campaign</TH>
                    <TH right>Spend</TH>
                    <TH>Binding</TH>
                    <TH right> </TH>
                  </tr>
                </thead>
                <tbody>
                  {campaigns.map((c) => {
                    const pinned = Boolean(c.pinned ?? (c.binding === 'pin'));
                    return (
                      <tr key={c.campaign_id} className="border-b border-border-default/40 last:border-0">
                        <TD>
                          <span className="text-xs text-text-primary">{c.campaign_name || c.campaign_id}</span>
                          <span className="block text-[10px] text-text-faint tabular-nums">{c.campaign_id}</span>
                        </TD>
                        <TD right><Money v={c.spend} /></TD>
                        <TD>
                          <span className={`text-[10px] px-1.5 py-0.5 rounded-full border ${
                            pinned
                              ? 'border-accent/40 text-accent-text'
                              : 'border-border-default text-text-muted'
                          }`}>
                            {pinned ? 'pinned' : 'derived'}
                          </span>
                        </TD>
                        <TD right>
                          {canEdit && (
                            <button
                              type="button"
                              onClick={() => togglePin(c)}
                              disabled={pinBusy === c.campaign_id}
                              title={pinned ? 'Remove the pin (derived binding resumes)' : 'Pin this campaign to this funnel'}
                              data-testid={`pnl-pin-${c.campaign_id}`}
                              className="p-1.5 rounded-md text-text-muted hover:text-text-primary hover:bg-bg-elevated
                                         disabled:opacity-50 transition-colors"
                            >
                              {pinBusy === c.campaign_id
                                ? <Loader2 className="w-3.5 h-3.5 animate-spin" />
                                : pinned ? <PinOff className="w-3.5 h-3.5" /> : <Pin className="w-3.5 h-3.5" />}
                            </button>
                          )}
                        </TD>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            ) : (
              <div className="text-sm text-text-muted py-8 text-center">
                No campaign spend is attributed to this funnel in this window.
              </div>
            )}
          </div>
        </Card>

        {/* Manual spend — for channels the Meta sync cannot see. */}
        <Card className="p-0 overflow-hidden">
          <div className="px-4 py-3 border-b border-border-default">
            <h3 className="text-sm font-semibold text-text-primary">Manual spend</h3>
            <p className="text-[11px] text-text-faint mt-0.5">
              For channels the sync cannot see. One row per day; a typed 0 is a real &ldquo;we spent
              nothing&rdquo;.
            </p>
          </div>
          <div className="p-4 space-y-3">
            {canEdit && (
              <div className="flex items-end gap-2 flex-wrap">
                <div>
                  <label className="block text-[10px] uppercase tracking-wide text-text-muted font-semibold mb-1">Day</label>
                  <input
                    type="date"
                    value={spendDay}
                    onChange={(e) => { setSpendDay(e.target.value); setSpendErr(null); }}
                    className="h-8 px-2 tabular-nums text-xs bg-bg-elevated border border-border-default rounded-md
                               text-text-primary focus:outline-none focus:ring-2 focus:ring-accent/40"
                    data-testid="pnl-manual-day"
                  />
                </div>
                <div>
                  <label className="block text-[10px] uppercase tracking-wide text-text-muted font-semibold mb-1">Spend $</label>
                  <input
                    inputMode="decimal"
                    value={spendAmount}
                    onChange={(e) => { setSpendAmount(e.target.value); setSpendErr(null); }}
                    placeholder="0.00"
                    className="h-8 w-[90px] px-2 tabular-nums text-right text-xs bg-bg-elevated border border-border-default
                               rounded-md text-text-primary focus:outline-none focus:ring-2 focus:ring-accent/40"
                    data-testid="pnl-manual-amount"
                  />
                </div>
                <div className="flex-1 min-w-[140px]">
                  <label className="block text-[10px] uppercase tracking-wide text-text-muted font-semibold mb-1">Note</label>
                  <input
                    value={spendNote}
                    onChange={(e) => setSpendNote(e.target.value)}
                    placeholder="optional"
                    className="h-8 w-full px-2 text-xs bg-bg-elevated border border-border-default rounded-md
                               text-text-primary focus:outline-none focus:ring-2 focus:ring-accent/40"
                    data-testid="pnl-manual-note"
                  />
                </div>
                <button
                  type="button"
                  onClick={addManual}
                  disabled={spendBusy}
                  data-testid="pnl-manual-add"
                  className="inline-flex items-center gap-1 h-8 px-3 rounded-md bg-accent text-white text-xs
                             font-medium disabled:opacity-50 transition-colors"
                >
                  {spendBusy ? <Loader2 className="w-3 h-3 animate-spin" /> : <Plus className="w-3 h-3" />}
                  Add
                </button>
              </div>
            )}
            {spendErr && <p className="text-[11px] text-danger" role="alert">{spendErr}</p>}
            {manual.length ? (
              <ul className="divide-y divide-border-default/40">
                {manual.map((m) => (
                  <li key={m.day} className="flex items-center gap-3 py-1.5 text-xs">
                    <span className="tabular-nums text-text-muted w-[86px]">{String(m.day).slice(0, 10)}</span>
                    <span className="tabular-nums text-text-primary"><Money v={m.spend} /></span>
                    {m.note && <span className="text-text-faint truncate">{m.note}</span>}
                    {canEdit && (
                      <button
                        type="button"
                        onClick={() => removeManual(String(m.day).slice(0, 10))}
                        title="Remove this manual entry"
                        data-testid={`pnl-manual-del-${String(m.day).slice(0, 10)}`}
                        className="ml-auto p-1 rounded text-text-faint hover:text-danger transition-colors"
                      >
                        <Trash2 className="w-3.5 h-3.5" />
                      </button>
                    )}
                  </li>
                ))}
              </ul>
            ) : (
              <p className="text-xs text-text-muted py-2">No manual entries in this window.</p>
            )}
          </div>
        </Card>
      </div>
    </div>
  );
}

/* ── the page ──────────────────────────────────────────────────────────── */

export default function PnLPage() {
  const { hasPermission } = usePermissions();
  const canEdit = hasPermission('funnels:access');

  const [params, setParams] = useSearchParams();
  const [start, setStart] = useState(params.get('start') || daysAgoIso(29));
  const [end, setEnd] = useState(params.get('end') || todayIso());
  const [selected, setSelected] = useState(params.get('funnel') || '');

  const [overview, setOverview] = useState(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);
  const [status, setStatus] = useState(null);
  const [syncing, setSyncing] = useState(false);
  const [flash, setFlash] = useState(null);

  const notify = useCallback((text, isError = false) => {
    setFlash(text ? { text, isError } : null);
  }, []);

  // Keep the URL shareable — an operator quoting a number can send the link.
  useEffect(() => {
    const next = { start, end };
    if (selected) next.funnel = selected;
    setParams(next, { replace: true });
  }, [start, end, selected, setParams]);

  const load = useCallback(async ({ quiet = false } = {}) => {
    if (!quiet) setLoading(true);
    try {
      const [ov, st] = await Promise.all([
        fetchPnlOverview({ start, end }),
        fetchSpendStatus().catch(() => null), // status failing must not blank the P&L
      ]);
      setOverview(ov);
      if (st) setStatus({ data: st, at: Date.now() });
      setError(null);
    } catch (e) {
      setError(costApiError(e, 'Could not load the P&L'));
    } finally {
      if (!quiet) setLoading(false);
    }
  }, [start, end]);

  useEffect(() => { load(); }, [load]);

  const sync = useCallback(async () => {
    setSyncing(true);
    try {
      await postSpendSync();
      notify('Spend sync kicked off — figures refresh when it lands.');
      // The sync runs in the background; re-read status shortly after.
      setTimeout(() => {
        fetchSpendStatus()
          .then((st) => setStatus({ data: st, at: Date.now() }))
          .catch(() => {});
      }, 4000);
    } catch (e) {
      notify(costApiError(e, 'Could not start the spend sync'), true);
    } finally {
      setSyncing(false);
    }
  }, [notify]);

  const rows = useMemo(() => rowsOf(overview), [overview]);
  const totals = overview?.totals || null;
  const selectedRow = rows.find((r) => String(r.fid) === String(selected));

  return (
    <div className="p-6 space-y-5 max-w-[1600px]" data-testid="pnl-page">
      <div className="flex flex-wrap items-end justify-between gap-4">
        <div>
          <h1 className="text-xl font-semibold text-text-primary flex items-center gap-2">
            <TrendingUp className="w-5 h-5 text-accent-text" />
            Funnel P&amp;L
          </h1>
          <p className="text-sm text-text-muted mt-0.5 max-w-[720px]">
            Revenue, real costs and real spend, per funnel. A dash is profit we{' '}
            <span className="italic">refuse</span> to invent — enter costs on the Costs page to earn the number.
          </p>
        </div>
        <div className="flex flex-wrap items-end gap-3">
          <CostsSubnav />
          <div>
            <label className="block text-sm font-medium text-text-muted mb-1.5">Date range</label>
            <DateRangePicker
              startDate={start}
              endDate={end}
              onChange={({ startDate, endDate }) => {
                setStart(startDate);
                if (endDate) setEnd(endDate);
              }}
            />
          </div>
          <button
            type="button"
            onClick={() => load()}
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

      {flash ? (
        <div
          className={`rounded-lg border px-3 py-2 text-[12px] flex items-center justify-between gap-3 ${
            flash.isError
              ? 'border-danger/30 bg-danger/5 text-danger'
              : 'border-border-default bg-bg-elevated/40 text-text-muted'
          }`}
          role={flash.isError ? 'alert' : 'status'}
          data-testid="pnl-flash"
        >
          <span>{flash.text}</span>
          <button
            type="button"
            onClick={() => setFlash(null)}
            className="shrink-0 underline decoration-dotted underline-offset-2 hover:text-text-primary"
          >
            dismiss
          </button>
        </div>
      ) : null}

      <SpendStalenessBar status={status} syncing={syncing} onSync={sync} canEdit={canEdit} />

      {selected ? (
        <FunnelDrillIn
          fid={selected}
          name={selectedRow?.name}
          start={start}
          end={end}
          canEdit={canEdit}
          onBack={() => setSelected('')}
          notify={notify}
        />
      ) : (
        <Card className="p-0 overflow-hidden">
          <div className="px-4 py-3 border-b border-border-default flex items-center justify-between gap-3">
            <h2 className="text-sm font-semibold text-text-primary">Funnels</h2>
            <span className="text-[11px] text-text-faint tabular-nums">{start} → {end}</span>
          </div>
          <div className="overflow-x-auto">
            {loading && !overview ? (
              <div className="text-sm text-text-muted py-10 text-center">Loading…</div>
            ) : !rows.length ? (
              <div className="text-sm text-text-muted py-10 text-center">
                No funnel took money in this window.
              </div>
            ) : (
              <table className="w-full min-w-[1220px] border-collapse">
                <thead>
                  <tr className="border-b border-border-default">
                    <TH>Funnel</TH>
                    <TH right>Orders</TH>
                    <TH right>Revenue</TH>
                    <TH right>COGS</TH>
                    <TH right>Fees</TH>
                    <TH right>Shipping</TH>
                    <TH right>GP</TH>
                    <TH right>GP %</TH>
                    <TH right>Coverage</TH>
                    <TH right>Spend</TH>
                    <TH right>Net profit</TH>
                    <TH right>ROAS</TH>
                    <TH right>CPA</TH>
                  </tr>
                </thead>
                <tbody>
                  {rows.map((r) => {
                    const spendUnknown = r.spend_known === false;
                    return (
                      <tr
                        key={r.fid}
                        onClick={() => setSelected(String(r.fid))}
                        className="border-b border-border-default/50 hover:bg-bg-elevated/40 cursor-pointer"
                        data-testid={`pnl-row-${r.fid}`}
                      >
                        <TD>
                          <span className="font-medium text-text-primary">{r.name || r.fid}</span>
                        </TD>
                        <TD right className="text-text-muted">{fmtInt(r.orders)}</TD>
                        <TD right><Money v={r.revenue} /></TD>
                        <TD right className="text-text-muted">
                          <Money v={r.cogs} cls="text-text-muted" title="No cost coverage — COGS unknown" />
                        </TD>
                        <TD right className="text-text-muted">
                          <Money v={r.fees} cls="text-text-muted" />
                        </TD>
                        <TD right className="text-text-muted">
                          <Money v={r.ship_cost} cls="text-text-muted" title="Shipping cost unknown" />
                        </TD>
                        <TD right>
                          {/* Withheld at zero coverage — a dash, NEVER a number
                              equal to revenue (which is the 100%-margin lie). */}
                          <Money v={r.gp} title="Withheld — this funnel has no cost coverage in this window" />
                        </TD>
                        <TD right>
                          {r.gp_margin === null || r.gp_margin === undefined
                            ? <span className="text-text-faint" title="Withheld — margin is unknown, not 100%">{EM_DASH}</span>
                            : <span className="tabular-nums text-text-primary">{fmtPct(r.gp_margin)}</span>}
                        </TD>
                        <TD right><CoverageCell row={r} /></TD>
                        <TD right>
                          {spendUnknown
                            ? <span className="text-text-faint" title="No spend recorded — bind a campaign or add manual spend">{EM_DASH}</span>
                            : <Money v={r.spend} />}
                        </TD>
                        <TD right>
                          <Money
                            v={r.net_profit}
                            title={spendUnknown
                              ? 'Withheld — spend is unknown for this funnel'
                              : 'Withheld — cost coverage is incomplete'}
                          />
                        </TD>
                        <TD right>
                          {r.roas === null || r.roas === undefined
                            ? <span className="text-text-faint">{EM_DASH}</span>
                            : <span className="tabular-nums text-text-primary">{fmtX(r.roas)}</span>}
                        </TD>
                        <TD right>
                          <Money v={r.cpa} cls="text-text-muted" />
                        </TD>
                      </tr>
                    );
                  })}
                </tbody>
                {totals && (
                  <tfoot>
                    <tr className="border-t border-border-default bg-bg-elevated/20">
                      <TD><span className="font-semibold text-text-primary">Total</span></TD>
                      <TD right className="text-text-muted">{fmtInt(totals.orders)}</TD>
                      <TD right><Money v={totals.revenue} /></TD>
                      <TD right className="text-text-muted"><Money v={totals.cogs} cls="text-text-muted" /></TD>
                      <TD right className="text-text-muted"><Money v={totals.fees} cls="text-text-muted" /></TD>
                      <TD right className="text-text-muted"><Money v={totals.ship_cost} cls="text-text-muted" /></TD>
                      <TD right><Money v={totals.gp} title="Withheld while any funnel's coverage is incomplete" /></TD>
                      <TD right>
                        {totals.gp_margin === null || totals.gp_margin === undefined
                          ? <span className="text-text-faint">{EM_DASH}</span>
                          : <span className="tabular-nums text-text-primary">{fmtPct(totals.gp_margin)}</span>}
                      </TD>
                      <TD right />
                      <TD right>
                        {totals.spend_known === false
                          ? <span className="text-text-faint">{EM_DASH}</span>
                          : <Money v={totals.spend} />}
                      </TD>
                      <TD right><Money v={totals.net_profit} title="Withheld — needs full costs AND known spend" /></TD>
                      <TD right>
                        {totals.roas === null || totals.roas === undefined
                          ? <span className="text-text-faint">{EM_DASH}</span>
                          : <span className="tabular-nums text-text-primary">{fmtX(totals.roas)}</span>}
                      </TD>
                      <TD right><Money v={totals.cpa} cls="text-text-muted" /></TD>
                    </tr>
                  </tfoot>
                )}
              </table>
            )}
          </div>
        </Card>
      )}

      <p className="text-[11px] text-text-faint leading-relaxed max-w-4xl">
        Revenue is captured money (paid sessions plus settled upsell charges); refunds net the top line only —
        COGS and fees are not reversed. Fees are billed per transaction on the captured amount. An upsell settled
        days after the order prices at <em>its</em> settle-day rate. Net profit ={' '}
        <span className="tabular-nums">GP − spend</span>, and only when spend is known — a funnel with no bound
        campaign and no manual spend shows a dash, not a profit.
      </p>
    </div>
  );
}
