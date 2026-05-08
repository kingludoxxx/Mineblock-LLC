import { useState, useEffect, useCallback, useRef } from 'react';
import api from '../../services/api';
import {
  RefreshCw,
  ExternalLink,
  Check,
  TrendingUp,
  AlertCircle,
  Loader2,
  Link2,
  Calendar,
  Clock,
  ChevronDown,
  ChevronLeft,
  ChevronRight,
} from 'lucide-react';

// ── Formatters ────────────────────────────────────────────────────────────────
const fmtMoney = (n) =>
  '$' + Number(n || 0).toLocaleString(undefined, { minimumFractionDigits: 0, maximumFractionDigits: 0 });

const fmtDec = (n, d = 2) => Number(n || 0).toFixed(d);
const fmtPct = (n) => (n != null ? Number(n).toFixed(1) + '%' : '—');
const fmtDate = (iso) => {
  if (!iso) return '—';
  const months = ['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec'];
  const d = new Date(iso + 'T00:00:00Z');
  if (isNaN(d.getTime())) return '—';
  return `${months[d.getUTCMonth()]} ${d.getUTCDate()}, ${d.getUTCFullYear()}`;
};

function roasColor(roas) {
  if (roas >= 2.5) return 'text-green-400';
  if (roas >= 1.6) return 'text-[var(--color-accent)]';
  return 'text-red-400';
}

function timeAgo(iso) {
  if (!iso) return '';
  const diff = Date.now() - new Date(iso).getTime();
  const m = Math.floor(diff / 60000);
  if (m < 1)  return 'just now';
  if (m < 60) return `${m}m ago`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h}h ago`;
  return `${Math.floor(h / 24)}d ago`;
}

// ── Date range presets ────────────────────────────────────────────────────────
const RANGE_PRESETS = [
  { key: 'today',         label: 'Today' },
  { key: 'yesterday',     label: 'Yesterday' },
  { key: 'this_week',     label: 'This week' },
  { key: 'last_week',     label: 'Last week' },
  { key: 'this_month',    label: 'This month' },
  { key: 'last_month',    label: 'Last month' },
  { key: 'last_7_days',   label: 'Last 7 days' },
  { key: 'last_14_days',  label: 'Last 14 days' },
  { key: 'last_30_days',  label: 'Last 30 days' },
  { key: 'last_90_days',  label: 'Last 90 days' },
  { key: 'last_365_days', label: 'Last 365 days' },
  { key: 'lifetime',      label: 'Lifetime' },
];

const MONTH_NAMES = ['January','February','March','April','May','June','July','August','September','October','November','December'];
const DOW_LABELS = ['Su','Mo','Tu','We','Th','Fr','Sa'];

const fmtIsoDay = (d) => `${d.getUTCFullYear()}-${String(d.getUTCMonth()+1).padStart(2,'0')}-${String(d.getUTCDate()).padStart(2,'0')}`;
const todayUtc  = () => { const n = new Date(); return new Date(Date.UTC(n.getUTCFullYear(), n.getUTCMonth(), n.getUTCDate())); };

// ── Column helpers ────────────────────────────────────────────────────────────
function Th({ children, className = '' }) {
  return (
    <th className={`px-4 py-3 text-left text-xs font-semibold uppercase tracking-wider text-[var(--color-text-muted)] whitespace-nowrap ${className}`}>
      {children}
    </th>
  );
}

function Td({ children, className = '' }) {
  return (
    <td className={`px-4 py-3 text-sm text-[var(--color-text-primary)] ${className}`}>
      {children}
    </td>
  );
}

// ── ClickUp logo ─────────────────────────────────────────────────────────────
const CU_GRAD_ID = 'cu-grad-internal';
function ClickUpGradientDef() {
  return (
    <svg width={0} height={0} style={{ position: 'absolute' }}>
      <defs>
        <linearGradient id={CU_GRAD_ID} x1="4" y1="21" x2="44" y2="21" gradientUnits="userSpaceOnUse">
          <stop stopColor="#FF7043"/>
          <stop offset="0.5" stopColor="#C550E0"/>
          <stop offset="1" stopColor="#38B2F4"/>
        </linearGradient>
      </defs>
    </svg>
  );
}
const ClickUpLogo = ({ size = 14 }) => (
  <svg width={size} height={size} viewBox="0 0 48 32" fill="none">
    <path d="M4 26 L14 16 L24 26 L34 16 L44 26" stroke={`url(#${CU_GRAD_ID})`} strokeWidth="6" strokeLinecap="round" strokeLinejoin="round"/>
  </svg>
);

// ── Tag pill ──────────────────────────────────────────────────────────────────
function Tag({ label, color = 'default' }) {
  if (!label) return <span className="text-[var(--color-text-faint)]">—</span>;
  const styles = {
    default: 'bg-[var(--color-bg-elevated)] text-[var(--color-text-muted)] border-[var(--color-border-default)]',
    gold:    'bg-[var(--color-accent-muted)] text-[var(--color-accent-text)] border-[var(--color-accent-muted)]',
  };
  return (
    <span className={`inline-block px-2 py-0.5 rounded text-xs border font-medium ${styles[color]}`}>
      {label}
    </span>
  );
}

// ── Date range picker (presets + single-month calendar) ──────────────────────
function DateRangePicker({ value, customRange, onPreset, onCustom, disabled }) {
  const [open, setOpen] = useState(false);
  const ref = useRef(null);

  // View state for the calendar
  const initial = todayUtc();
  const [viewYear, setViewYear]   = useState(initial.getUTCFullYear());
  const [viewMonth, setViewMonth] = useState(initial.getUTCMonth());
  const [tempStart, setTempStart] = useState(null);
  const [tempEnd,   setTempEnd]   = useState(null);

  useEffect(() => {
    function onClick(e) { if (ref.current && !ref.current.contains(e.target)) setOpen(false); }
    if (open) document.addEventListener('mousedown', onClick);
    return () => document.removeEventListener('mousedown', onClick);
  }, [open]);

  // Reset temp range when opening
  useEffect(() => {
    if (open) {
      if (value === 'custom' && customRange?.from && customRange?.to) {
        setTempStart(new Date(customRange.from + 'T00:00:00Z'));
        setTempEnd(new Date(customRange.to   + 'T00:00:00Z'));
        const d = new Date(customRange.to + 'T00:00:00Z');
        setViewYear(d.getUTCFullYear()); setViewMonth(d.getUTCMonth());
      } else {
        setTempStart(null); setTempEnd(null);
      }
    }
  }, [open, value, customRange?.from, customRange?.to]);

  // Trigger button label
  const triggerLabel = (() => {
    if (value === 'custom' && customRange?.from && customRange?.to) {
      const s = new Date(customRange.from + 'T00:00:00Z');
      const e = new Date(customRange.to   + 'T00:00:00Z');
      const months = ['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec'];
      return `${months[s.getUTCMonth()]} ${s.getUTCDate()} – ${months[e.getUTCMonth()]} ${e.getUTCDate()}`;
    }
    return RANGE_PRESETS.find(p => p.key === value)?.label || 'Range';
  })();

  function pickPreset(k) {
    onPreset(k);
    setOpen(false);
  }

  function pickDay(d) {
    if (!tempStart || (tempStart && tempEnd)) {
      setTempStart(d); setTempEnd(null);
      return;
    }
    if (+d < +tempStart) {
      setTempEnd(tempStart); setTempStart(d);
    } else {
      setTempEnd(d);
    }
  }

  function applyCustom() {
    if (!tempStart || !tempEnd) return;
    onCustom(fmtIsoDay(tempStart), fmtIsoDay(tempEnd));
    setOpen(false);
  }

  function shiftMonth(delta) {
    let m = viewMonth + delta, y = viewYear;
    if (m < 0)  { m = 11; y -= 1; }
    if (m > 11) { m = 0;  y += 1; }
    setViewMonth(m); setViewYear(y);
  }

  // Build calendar grid (Sunday-start)
  const today = todayUtc();
  const firstDow     = new Date(Date.UTC(viewYear, viewMonth, 1)).getUTCDay();
  const daysInMonth  = new Date(Date.UTC(viewYear, viewMonth + 1, 0)).getUTCDate();
  const cells = [];
  for (let i = 0; i < firstDow; i++) cells.push(null);
  for (let d = 1; d <= daysInMonth; d++) cells.push(new Date(Date.UTC(viewYear, viewMonth, d)));

  return (
    <div className="relative" ref={ref}>
      <button
        type="button"
        onClick={() => setOpen(o => !o)}
        disabled={disabled}
        className="flex items-center gap-2 px-3 py-1.5 rounded text-xs font-medium border border-[var(--color-border-default)] bg-[var(--color-bg-elevated)] hover:bg-[var(--color-bg-hover)] text-[var(--color-text-primary)] transition-colors disabled:opacity-50 min-w-[170px]"
      >
        <Calendar size={13} className="text-[var(--color-text-muted)]" />
        <span className="flex-1 text-left">{triggerLabel}</span>
        <ChevronDown size={13} className={`text-[var(--color-text-muted)] transition-transform ${open ? 'rotate-180' : ''}`} />
      </button>

      {open && (
        <div className="absolute z-30 mt-2 right-0 rounded-xl border border-[var(--color-border-default)] bg-[var(--color-bg-card)] shadow-2xl overflow-hidden flex" style={{ width: 600 }}>
          {/* Presets sidebar */}
          <div className="w-44 border-r border-[var(--color-border-subtle)] py-2 bg-[var(--color-bg-elevated)]/40">
            <div className="px-3 py-1 text-[10px] uppercase tracking-wider text-[var(--color-text-faint)]">Presets</div>
            {RANGE_PRESETS.map(p => {
              const active = p.key === value;
              return (
                <button
                  key={p.key}
                  onClick={() => pickPreset(p.key)}
                  className={`w-full flex items-center justify-between px-3 py-1.5 text-xs transition-colors ${
                    active
                      ? 'bg-[var(--color-accent-muted)] text-[var(--color-accent-text)] font-medium'
                      : 'text-[var(--color-text-primary)] hover:bg-[var(--color-bg-hover)]'
                  }`}
                >
                  <span>{p.label}</span>
                  {active && <Check size={12} className="text-[var(--color-accent)]" />}
                </button>
              );
            })}
          </div>

          {/* Calendar */}
          <div className="flex-1 p-4 flex flex-col">
            <div className="flex items-center justify-between mb-3">
              <button
                onClick={() => shiftMonth(-1)}
                className="w-7 h-7 inline-flex items-center justify-center rounded hover:bg-[var(--color-bg-hover)] text-[var(--color-text-muted)] hover:text-[var(--color-text-primary)]"
                aria-label="Previous month"
              >
                <ChevronLeft size={15} />
              </button>
              <div className="text-sm font-medium text-[var(--color-accent)]">
                {MONTH_NAMES[viewMonth]} {viewYear}
              </div>
              <button
                onClick={() => shiftMonth(1)}
                className="w-7 h-7 inline-flex items-center justify-center rounded hover:bg-[var(--color-bg-hover)] text-[var(--color-text-muted)] hover:text-[var(--color-text-primary)]"
                aria-label="Next month"
              >
                <ChevronRight size={15} />
              </button>
            </div>

            {/* Day-of-week headers */}
            <div className="grid grid-cols-7 gap-y-1 mb-1">
              {DOW_LABELS.map((d, i) => (
                <div
                  key={d}
                  className={`text-[10px] uppercase text-center font-medium ${
                    i === today.getUTCDay() && viewMonth === today.getUTCMonth() && viewYear === today.getUTCFullYear()
                      ? 'text-[var(--color-text-primary)]'
                      : 'text-[var(--color-text-faint)]'
                  }`}
                >
                  {d}
                </div>
              ))}
            </div>

            {/* Date grid */}
            <div className="grid grid-cols-7 gap-y-1">
              {cells.map((cell, i) => {
                if (!cell) return <div key={`e${i}`} />;
                const isToday   = +cell === +today;
                const isStart   = tempStart && +cell === +tempStart;
                const isEnd     = tempEnd   && +cell === +tempEnd;
                const inRange   = tempStart && tempEnd && +cell > +tempStart && +cell < +tempEnd;
                const isFuture  = +cell > +today;
                return (
                  <button
                    key={i}
                    onClick={() => !isFuture && pickDay(cell)}
                    disabled={isFuture}
                    className={`
                      h-9 w-9 mx-auto inline-flex items-center justify-center text-xs rounded-md transition-colors
                      ${isStart || isEnd
                        ? 'bg-[var(--color-accent)] text-black font-semibold'
                        : inRange
                          ? 'bg-[var(--color-accent-muted)] text-[var(--color-accent-text)]'
                          : isFuture
                            ? 'text-[var(--color-text-faint)] cursor-not-allowed'
                            : isToday
                              ? 'text-[var(--color-accent)] font-medium hover:bg-[var(--color-bg-hover)]'
                              : 'text-[var(--color-text-primary)] hover:bg-[var(--color-bg-hover)]'
                      }
                    `}
                  >
                    {cell.getUTCDate()}
                  </button>
                );
              })}
            </div>

            <div className="text-[11px] text-[var(--color-text-faint)] mt-3 pt-3 border-t border-[var(--color-border-subtle)]">
              {tempStart && tempEnd
                ? `${fmtIsoDay(tempStart)} → ${fmtIsoDay(tempEnd)}`
                : tempStart
                  ? `Start: ${fmtIsoDay(tempStart)} — pick end date`
                  : 'Click a day to start a custom range'}
              <span className="float-right">Timezone: UTC</span>
            </div>

            <div className="flex justify-end gap-2 mt-3">
              <button
                onClick={() => setOpen(false)}
                className="px-4 py-1.5 text-xs font-medium rounded border border-[var(--color-border-default)] bg-[var(--color-bg-elevated)] hover:bg-[var(--color-bg-hover)] text-[var(--color-text-primary)] transition-colors"
              >
                Cancel
              </button>
              <button
                onClick={applyCustom}
                disabled={!tempStart || !tempEnd}
                className="px-4 py-1.5 text-xs font-medium rounded bg-[var(--color-accent)] text-black hover:opacity-90 transition-opacity disabled:opacity-40 disabled:cursor-not-allowed"
              >
                Apply
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

// ── Main page ─────────────────────────────────────────────────────────────────
export default function AdsReporting() {
  const [range,    setRange]    = useState('this_week');         // preset key OR 'custom'
  const [customRange, setCustomRange] = useState({ from: null, to: null });
  // `displayed` is the cache key whose data is currently rendered — only
  // updates once a fetch completes, so switching ranges never blanks the page.
  const [displayed, setDisplayed] = useState('this_week');
  const [error,    setError]    = useState(null);
  const [refreshing, setRefreshing] = useState(false);
  const [copied,   setCopied]   = useState(false);
  const [adNameWidth, setAdNameWidth] = useState(220);

  // Cache responses per cache key — flips between presets are instant after first load
  const cacheRef = useRef(new Map());
  const [tick, setTick] = useState(0); // eslint-disable-line no-unused-vars
  const current = cacheRef.current.get(displayed);

  const cacheKeyFor = (key, from, to) => key === 'custom' ? `custom:${from}:${to}` : key;

  const load = useCallback(async (rangeKey, opts = {}) => {
    const { force = false, from = null, to = null } = opts;
    if (rangeKey === 'custom' && (!from || !to)) return;
    const cacheKey = cacheKeyFor(rangeKey, from, to);
    const cached = cacheRef.current.get(cacheKey);
    if (cached && !force) {
      setDisplayed(cacheKey);
      setError(null);
      return;
    }

    try {
      setRefreshing(true);
      setError(null);

      const params = new URLSearchParams({ range: rangeKey });
      if (rangeKey === 'custom') { params.set('from', from); params.set('to', to); }
      if (force) params.set('refresh', '1');

      const res = await api.get(`/ads-reporting/report?${params.toString()}`);
      cacheRef.current.set(cacheKey, {
        data:        res.data.data || [],
        rangeMeta:   res.data.range,
        generatedAt: res.data.generatedAt,
        shareToken:  res.data.shareToken,
      });
      setDisplayed(cacheKey);
      setTick(t => t + 1);
    } catch (err) {
      setError(err?.response?.data?.error || err.message || 'Failed to load report');
    } finally {
      setRefreshing(false);
    }
  }, []);

  // Load whenever range or custom range changes
  useEffect(() => {
    if (range === 'custom') load('custom', { from: customRange.from, to: customRange.to });
    else                    load(range);
  }, [range, customRange.from, customRange.to, load]);

  const onPresetSelect = useCallback((k) => {
    setRange(k);
  }, []);

  const onCustomApply = useCallback((from, to) => {
    setCustomRange({ from, to });
    setRange('custom');
  }, []);

  function startResize(e) {
    const startX = e.clientX;
    const startW = adNameWidth;
    function onMove(ev) { setAdNameWidth(Math.max(80, startW + ev.clientX - startX)); }
    function onUp()     { window.removeEventListener('mousemove', onMove); window.removeEventListener('mouseup', onUp); }
    window.addEventListener('mousemove', onMove);
    window.addEventListener('mouseup', onUp);
    e.preventDefault();
  }

  const copyLink = async () => {
    if (!current?.shareToken) return;
    const url = `${window.location.origin}/ads-report/${current.shareToken}`;
    try {
      await navigator.clipboard.writeText(url);
    } catch {
      const el = document.createElement('textarea');
      el.value = url;
      document.body.appendChild(el);
      el.select();
      document.execCommand('copy');
      document.body.removeChild(el);
    }
    setCopied(true);
    setTimeout(() => setCopied(false), 2500);
  };

  const data        = current?.data || [];
  const rangeMeta   = current?.rangeMeta;
  const generatedAt = current?.generatedAt;

  // ── Initial loading state (no data anywhere yet) ──────────────────────────
  if (refreshing && !current && cacheRef.current.size === 0) {
    return (
      <div className="flex flex-col items-center justify-center h-72 gap-3 text-[var(--color-text-muted)]">
        <Loader2 size={28} className="animate-spin text-[var(--color-accent)]" />
        <p className="text-sm">Pulling data from Triple Whale…</p>
      </div>
    );
  }

  // ── Error state ───────────────────────────────────────────────────────────
  if (error && !current) {
    return (
      <div className="flex flex-col items-center justify-center h-72 gap-3 text-[var(--color-text-muted)]">
        <AlertCircle size={28} className="text-red-400" />
        <p className="text-sm text-red-400 font-medium">Failed to load report</p>
        <p className="text-xs text-center max-w-sm">{error}</p>
        <button
          onClick={() => load(range, { force: true, from: customRange.from, to: customRange.to })}
          className="mt-2 px-4 py-1.5 rounded text-xs font-medium bg-[var(--color-bg-elevated)] hover:bg-[var(--color-bg-hover)] border border-[var(--color-border-default)] text-[var(--color-text-primary)] transition-colors"
        >
          Try again
        </button>
      </div>
    );
  }

  return (
    <div className="p-6 space-y-5">
      <ClickUpGradientDef />

      {/* ── Header ── */}
      <div className="flex items-start justify-between gap-4 flex-wrap">
        <div>
          <div className="flex items-center gap-2 mb-1">
            <TrendingUp size={18} className="text-[var(--color-accent)]" />
            <h1 className="text-xl font-semibold text-[var(--color-text-primary)]">Ads Reporting</h1>
          </div>
          <div className="flex items-center gap-3 text-xs text-[var(--color-text-muted)]">
            {rangeMeta?.label && (
              <span className="flex items-center gap-1.5">
                <Calendar size={12} />
                {rangeMeta.label}
              </span>
            )}
            {generatedAt && (
              <span className="flex items-center gap-1.5">
                <Clock size={12} />
                Updated {timeAgo(generatedAt)}
              </span>
            )}
          </div>
        </div>

        <div className="flex items-center gap-2">
          {/* Range picker */}
          <DateRangePicker
            value={range}
            customRange={customRange}
            onPreset={onPresetSelect}
            onCustom={onCustomApply}
            disabled={refreshing}
          />

          {/* Share button */}
          <button
            onClick={copyLink}
            disabled={!current?.shareToken}
            className="flex items-center gap-1.5 px-3 py-1.5 rounded text-xs font-medium border border-[var(--color-border-default)] bg-[var(--color-bg-elevated)] hover:bg-[var(--color-bg-hover)] text-[var(--color-text-muted)] hover:text-[var(--color-text-primary)] transition-colors disabled:opacity-50"
          >
            {copied ? <Check size={13} className="text-green-400" /> : <Link2 size={13} />}
            {copied ? 'Link copied!' : 'Share report'}
          </button>

          {/* Refresh button */}
          <button
            onClick={() => load(range, { force: true, from: customRange.from, to: customRange.to })}
            disabled={refreshing}
            className="flex items-center gap-1.5 px-3 py-1.5 rounded text-xs font-medium bg-[var(--color-accent-muted)] hover:bg-[var(--color-accent-muted)] text-[var(--color-accent-text)] border border-[var(--color-accent-muted)] hover:border-[var(--color-accent)] transition-colors disabled:opacity-50"
          >
            <RefreshCw size={13} className={refreshing ? 'animate-spin' : ''} />
            {refreshing ? 'Refreshing…' : 'Refresh'}
          </button>
        </div>
      </div>

      {/* ── Filter badge ── */}
      <div className="flex items-center gap-2 text-xs text-[var(--color-text-muted)]">
        <span className="px-2 py-0.5 rounded bg-[var(--color-bg-elevated)] border border-[var(--color-border-default)]">
          Spend ≥ $100
        </span>
        <span className="px-2 py-0.5 rounded bg-[var(--color-bg-elevated)] border border-[var(--color-border-default)]">
          ROAS ≥ 1.6×
        </span>
        <span className="text-[var(--color-text-faint)]">·</span>
        <span>{data.length} winning ad{data.length !== 1 ? 's' : ''}</span>
        {refreshing && (
          <span className="flex items-center gap-1 text-[var(--color-accent)]">
            <Loader2 size={11} className="animate-spin" /> refreshing…
          </span>
        )}
      </div>

      {/* ── Empty state ── */}
      {data.length === 0 && !refreshing && (
        <div className="flex flex-col items-center justify-center h-56 gap-3 border border-[var(--color-border-subtle)] rounded-xl bg-[var(--color-bg-card)]">
          <TrendingUp size={28} className="text-[var(--color-text-faint)]" />
          <p className="text-sm font-medium text-[var(--color-text-muted)]">No qualifying ads</p>
          <p className="text-xs text-[var(--color-text-faint)] text-center max-w-xs">
            No ads met the spend ≥ $100 and ROAS ≥ 1.6× threshold for {rangeMeta?.label || 'this range'}.
          </p>
        </div>
      )}

      {/* ── Table ── */}
      {data.length > 0 && (
        <div className="rounded-xl border border-[var(--color-border-subtle)] bg-[var(--color-bg-card)] overflow-hidden">
          <div className="overflow-x-auto">
            <table className="w-full border-collapse">
              <thead>
                <tr className="border-b border-[var(--color-border-subtle)]">
                  <Th>#</Th>
                  <Th>Campaign</Th>
                  <th
                    className="px-4 py-3 text-left text-xs font-semibold uppercase tracking-wider text-[var(--color-text-muted)] whitespace-nowrap select-none"
                    style={{ position: 'relative', minWidth: adNameWidth, width: adNameWidth }}
                  >
                    Ad Name
                    <div
                      onMouseDown={startResize}
                      style={{ position: 'absolute', right: 0, top: 0, bottom: 0, width: 6, cursor: 'col-resize', borderRight: '2px solid rgba(255,255,255,0.08)' }}
                    />
                  </th>
                  <Th>FB Post</Th>
                  <Th>Spend</Th>
                  <Th>ROAS</Th>
                  <Th>PUR</Th>
                  <Th>CPA</Th>
                  <Th>AOV</Th>
                  <Th>NVP</Th>
                  <Th>Avatar</Th>
                  <Th>Angle</Th>
                  <Th>Launch Date</Th>
                </tr>
              </thead>
              <tbody>
                {data.map((row, i) => (
                  <tr
                    key={i}
                    className="border-b border-[var(--color-border-subtle)] last:border-0 hover:bg-[var(--color-bg-hover)] transition-colors"
                  >
                    <Td className="text-[var(--color-text-faint)] w-8">{i + 1}</Td>

                    {/* Campaign */}
                    <Td>
                      <span
                        className="block max-w-[180px] truncate text-[var(--color-text-muted)] text-xs"
                        title={row.campaignName || '—'}
                      >
                        {row.campaignName || <span className="text-[var(--color-text-faint)]">—</span>}
                      </span>
                    </Td>

                    {/* Ad Name + ClickUp logo on the left */}
                    <td className="px-4 py-3 text-sm text-[var(--color-text-primary)]" style={{ maxWidth: adNameWidth, width: adNameWidth }}>
                      <div className="flex items-center gap-2 min-w-0">
                        {row.clickupUrl ? (
                          <a
                            href={row.clickupUrl}
                            target="_blank"
                            rel="noopener noreferrer"
                            title="Open in ClickUp"
                            className="inline-flex items-center justify-center w-5 h-5 rounded hover:bg-purple-500/10 transition-colors flex-shrink-0"
                          >
                            <ClickUpLogo />
                          </a>
                        ) : (
                          <span className="inline-block w-5 h-5 flex-shrink-0" aria-hidden="true" />
                        )}
                        <span
                          className="block truncate font-medium min-w-0"
                          title={row.adName}
                        >
                          {row.adName}
                        </span>
                      </div>
                    </td>

                    {/* FB Post link */}
                    <Td>
                      {row.fbLink ? (
                        <a
                          href={row.fbLink}
                          target="_blank"
                          rel="noopener noreferrer"
                          className="flex items-center gap-1 text-[var(--color-accent)] hover:text-[var(--color-accent-text)] transition-colors text-xs font-medium"
                        >
                          View <ExternalLink size={11} />
                        </a>
                      ) : (
                        <span className="text-[var(--color-text-faint)] text-xs">—</span>
                      )}
                    </Td>

                    {/* Spend */}
                    <Td className="font-medium tabular-nums">{fmtMoney(row.spend)}</Td>

                    {/* ROAS */}
                    <Td>
                      <span className={`font-bold tabular-nums ${roasColor(row.roas)}`}>
                        {fmtDec(row.roas)}×
                      </span>
                    </Td>

                    {/* PUR */}
                    <Td className="tabular-nums text-[var(--color-text-muted)]">
                      {row.purchases ?? '—'}
                    </Td>

                    {/* CPA */}
                    <Td className="tabular-nums text-[var(--color-text-muted)]">
                      {row.cpa != null ? fmtMoney(row.cpa) : '—'}
                    </Td>

                    {/* AOV */}
                    <Td className="tabular-nums text-[var(--color-text-muted)]">
                      {row.aov != null ? fmtMoney(row.aov) : '—'}
                    </Td>

                    {/* NVP */}
                    <Td className="tabular-nums text-[var(--color-text-muted)]">
                      {fmtPct(row.nvp)}
                    </Td>

                    {/* Avatar */}
                    <Td><Tag label={row.avatar} color="gold" /></Td>

                    {/* Angle */}
                    <Td><Tag label={row.angle} /></Td>

                    {/* Launch Date */}
                    <Td className="tabular-nums text-[var(--color-text-muted)] whitespace-nowrap">
                      {fmtDate(row.dateLaunched)}
                    </Td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      )}

      {/* ── Footer note ── */}
      <p className="text-xs text-[var(--color-text-faint)]">
        Data sourced from Triple Whale · Facebook post links from Meta Graph API · Cached refresh runs daily at 12:00 AM CET
      </p>
    </div>
  );
}
