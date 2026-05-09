import { useState, useEffect, useCallback, useRef } from 'react';
import api from '../../services/api';
import { PieChart, Pie, Cell, BarChart, Bar, XAxis, YAxis, ResponsiveContainer, Tooltip, CartesianGrid } from 'recharts';
import { Trophy, Target, User } from 'lucide-react';
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
  ChevronsUpDown,
  ChevronUp,
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

// ROAS color thresholds aligned to the Magic Patterns design:
// ≥ 2.0× green, ≥ 1.0× gold, < 1.0× red.
function roasColor(roas) {
  if (roas >= 2.0) return 'text-[#22c55e]';
  if (roas >= 1.0) return 'text-[var(--color-accent)]';
  return 'text-red-400';
}

// Stable color per tag value: known keys mapped explicitly, unknowns hash
// into a curated palette so every distinct angle/format/avatar gets a
// consistent color across the page.
const TAG_PALETTE = ['#fb923c', '#f87171', '#a78bfa', '#38bdf8', '#22c55e', '#facc15', '#fb7185', '#22d3ee', '#e8d5a3', '#06b6d4', '#c084fc', '#fbbf24'];
const TAG_OVERRIDES = {
  // Angles
  'Lottery': '#fb923c',
  'Againstcompetition': '#f87171',
  'Offer': '#a78bfa',
  'ASMR': '#22d3ee',
  'BTC Made easy': '#4ade80',
  'GTRS': '#06b6d4',
  'BTCFARM': '#22c55e',
  'Reaction': '#fb7185',
  'Missedopportunity': '#facc15',
  'Aware': '#94a3b8',
  // Formats
  'Mashup': '#a78bfa',
  'ShortVid': '#38bdf8',
  'Cartoon': '#22c55e',
  'UGC': '#fb923c',
  'IMG': '#22d3ee',
  'Mini VSL': '#e8d5a3',
  // Avatars
  'MoneySeeker': '#c9a84c',
  'Cryptoaddict': '#facc15',
  'NA': '#71717a',
};
function tagColor(label) {
  if (!label) return '#71717a';
  if (TAG_OVERRIDES[label]) return TAG_OVERRIDES[label];
  let hash = 0;
  for (let i = 0; i < label.length; i++) {
    hash = ((hash << 5) - hash) + label.charCodeAt(i);
    hash |= 0;
  }
  return TAG_PALETTE[Math.abs(hash) % TAG_PALETTE.length];
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

// Sortable header — click toggles direction (or switches column with desc default)
function SortableTh({ children, sortKey, sort, onSort, className = '' }) {
  const active = sort?.key === sortKey;
  const dir = active ? sort.dir : null;
  return (
    <th
      onClick={() => onSort(sortKey)}
      className={`px-4 py-3 text-left text-xs font-semibold uppercase tracking-wider whitespace-nowrap select-none cursor-pointer transition-colors ${
        active ? 'text-[var(--color-accent)]' : 'text-[var(--color-text-muted)] hover:text-[var(--color-text-primary)]'
      } ${className}`}
    >
      <span className="inline-flex items-center gap-1">
        {children}
        {dir === 'asc'  ? <ChevronUp size={12} />
          : dir === 'desc' ? <ChevronDown size={12} />
          : <ChevronsUpDown size={11} className="opacity-60" />}
      </span>
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

// ── Chart palette + helpers ──────────────────────────────────────────────────
// Refined gold-forward palette matching the Magic Patterns design — varied
// gold tones with one mint accent so the donut reads as a cohesive set.
const CHART_COLORS = ['#c9a84c', '#e8d5a3', '#a08838', '#806a2a', '#4ade80', '#d4b169', '#5d4d1e', '#f0e0b8', '#bf9e44', '#9a8030'];

function aggregateBy(rows, key) {
  const map = new Map();
  for (const r of rows) {
    const v = r[key];
    if (!v) continue;
    map.set(v, (map.get(v) || 0) + 1);
  }
  return [...map.entries()]
    .map(([name, value]) => ({ name, value }))
    .sort((a, b) => b.value - a.value);
}

// Aggregate winners + total per category. Used for the "12/18" win-rate
// ratio in the Format card. `winners` is the filtered winning set,
// `allRows` is the full ad list (server returns ≥$1 spend).
function aggregateWithTotals(winners, allRows, key) {
  const totals = new Map();
  for (const r of allRows) {
    const v = r[key];
    if (!v) continue;
    totals.set(v, (totals.get(v) || 0) + 1);
  }
  const wins = new Map();
  for (const r of winners) {
    const v = r[key];
    if (!v) continue;
    wins.set(v, (wins.get(v) || 0) + 1);
  }
  return [...wins.entries()]
    .map(([name, winCount]) => ({
      name,
      winCount,
      totalCount: totals.get(name) || winCount,
    }))
    .sort((a, b) => b.winCount - a.winCount);
}

function aggregateRoasBy(rows, key) {
  const buckets = new Map();
  for (const r of rows) {
    const k = r[key];
    if (!k || !r.spend) continue;
    if (!buckets.has(k)) buckets.set(k, { spend: 0, revenue: 0 });
    const b = buckets.get(k);
    b.spend   += r.spend || 0;
    b.revenue += (r.spend || 0) * (r.roas || 0); // back into revenue from spend × ROAS
  }
  return [...buckets.entries()]
    .map(([name, b]) => ({
      name,
      roas: b.spend > 0 ? +(b.revenue / b.spend).toFixed(2) : 0,
      spend: +b.spend.toFixed(0),
    }))
    .sort((a, b) => b.roas - a.roas);
}

function ChartTooltip({ active, payload, valueKey = 'value', suffix = '' }) {
  if (!active || !payload?.length) return null;
  const p = payload[0];
  return (
    <div className="px-2 py-1.5 rounded-md border border-[var(--color-border-default)] bg-[var(--color-bg-card)] text-xs">
      <div className="font-medium text-[var(--color-text-primary)]">{p.payload.name}</div>
      <div className="text-[var(--color-text-muted)]">
        {p.payload[valueKey]}{suffix}
      </div>
    </div>
  );
}

// ── Tag pill ──────────────────────────────────────────────────────────────────
// Each tag gets a distinct outline color from `tagColor(label)`. The `color`
// prop is no longer used — kept on the signature so existing callsites still
// compile, but every value derives its own outline now.
function Tag({ label }) {
  if (!label) return <span className="text-[var(--color-text-faint)]">—</span>;
  const c = tagColor(label);
  return (
    <span
      className="inline-block px-2 py-0.5 rounded text-[11px] uppercase tracking-wider font-semibold border"
      style={{ color: c, borderColor: `${c}66`, background: `${c}14` }}
    >
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

  // Compute the date range a preset represents — mirror of the backend logic.
  function computePresetRange(key) {
    const t = todayUtc();
    const dow = t.getUTCDay();
    const daysFromMon = dow === 0 ? 6 : dow - 1;
    const subtractDays = (n) => { const d = new Date(t); d.setUTCDate(t.getUTCDate() - n); return d; };
    switch (key) {
      case 'today':         return [t, t];
      case 'yesterday':     return [subtractDays(1), subtractDays(1)];
      case 'this_week':     return [subtractDays(daysFromMon), t];
      case 'last_week':     { const we = subtractDays(daysFromMon + 1); const ws = subtractDays(daysFromMon + 7); return [ws, we]; }
      case 'this_month':    return [new Date(Date.UTC(t.getUTCFullYear(), t.getUTCMonth(), 1)), t];
      case 'last_month':    return [new Date(Date.UTC(t.getUTCFullYear(), t.getUTCMonth() - 1, 1)), new Date(Date.UTC(t.getUTCFullYear(), t.getUTCMonth(), 0))];
      case 'last_7_days':   return [subtractDays(6), t];
      case 'last_14_days':  return [subtractDays(13), t];
      case 'last_30_days':  return [subtractDays(29), t];
      case 'last_90_days':  return [subtractDays(89), t];
      case 'last_365_days': return [subtractDays(364), t];
      case 'lifetime':      return [new Date(Date.UTC(2020, 0, 1)), t];
      default:              return [null, null];
    }
  }

  // Reset temp range when opening — populate it from the active selection so
  // the calendar visually highlights whatever range is currently chosen.
  useEffect(() => {
    if (open) {
      if (value === 'custom' && customRange?.from && customRange?.to) {
        setTempStart(new Date(customRange.from + 'T00:00:00Z'));
        setTempEnd(new Date(customRange.to   + 'T00:00:00Z'));
        const d = new Date(customRange.to + 'T00:00:00Z');
        setViewYear(d.getUTCFullYear()); setViewMonth(d.getUTCMonth());
      } else {
        const [s, e] = computePresetRange(value);
        setTempStart(s); setTempEnd(e);
        const focus = e || s || todayUtc();
        setViewYear(focus.getUTCFullYear()); setViewMonth(focus.getUTCMonth());
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
        className="flex items-center gap-2 px-4 py-2 rounded-lg text-xs font-medium border border-[var(--color-accent)]/60 hover:border-[var(--color-accent)] bg-transparent hover:bg-[var(--color-accent)]/10 text-[var(--color-accent)] transition-colors disabled:opacity-50 min-w-[170px]"
      >
        <Calendar size={14} className="text-[var(--color-accent)]" />
        <span className="flex-1 text-left">{triggerLabel}</span>
        <ChevronDown size={14} className={`text-[var(--color-accent)] transition-transform ${open ? 'rotate-180' : ''}`} />
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
  // Default sort matches what the API returns: ROAS desc.
  const [sort, setSort] = useState({ key: 'roas', dir: 'desc' });
  // Fixed winning-ads thresholds. The server now returns all ads ≥ $1 so the
  // /audit endpoint can cross-check against TW, but the dashboard view is
  // strictly the winning subset.
  const SPEND_MIN = 100;
  const ROAS_MIN  = 1.6;

  function handleSort(key) {
    setSort(s => {
      if (s.key !== key) return { key, dir: 'desc' }; // new column → desc default
      if (s.dir === 'desc') return { key, dir: 'asc' };
      return { key: 'roas', dir: 'desc' }; // third click resets
    });
  }

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

  const rawData     = current?.data || [];
  const totalCount  = rawData.length;
  const filtered    = rawData.filter(r => r.spend >= SPEND_MIN && r.roas >= ROAS_MIN);
  const data        = (() => {
    if (!sort || !filtered.length) return filtered;
    const dir = sort.dir === 'asc' ? 1 : -1;
    return [...filtered].sort((a, b) => {
      const av = a[sort.key], bv = b[sort.key];
      // null/undefined sort to the end regardless of direction
      if (av == null && bv == null) return 0;
      if (av == null) return 1;
      if (bv == null) return -1;
      // For dateLaunched (YYYY-MM-DD strings), string compare works.
      if (typeof av === 'string' && typeof bv === 'string') return av.localeCompare(bv) * dir;
      return (av - bv) * dir;
    });
  })();
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
      {/* Suppress the default browser focus ring on recharts SVGs so clicking
          a chart doesn't draw a blue rectangle around the card. */}
      <style>{`
        .recharts-wrapper, .recharts-wrapper *,
        .recharts-surface, .recharts-surface * { outline: none !important; }
      `}</style>

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

          {/* Share button — matches date picker size, neutral palette */}
          <button
            onClick={copyLink}
            disabled={!current?.shareToken}
            className="flex items-center gap-2 px-4 py-2 rounded-lg text-xs font-medium border border-white/[0.08] hover:border-white/[0.16] bg-transparent hover:bg-white/[0.04] text-[var(--color-text-primary)] transition-colors disabled:opacity-50"
          >
            {copied ? <Check size={14} className="text-green-400" /> : <Link2 size={14} className="text-[var(--color-text-muted)]" />}
            {copied ? 'Link copied!' : 'Share report'}
          </button>

          {/* Refresh button — matches date picker size, neutral palette */}
          <button
            onClick={() => load(range, { force: true, from: customRange.from, to: customRange.to })}
            disabled={refreshing}
            className="flex items-center gap-2 px-4 py-2 rounded-lg text-xs font-medium border border-white/[0.08] hover:border-white/[0.16] bg-transparent hover:bg-white/[0.04] text-[var(--color-text-primary)] transition-colors disabled:opacity-50"
          >
            <RefreshCw size={14} className={`text-[var(--color-text-muted)] ${refreshing ? 'animate-spin' : ''}`} />
            {refreshing ? 'Refreshing…' : 'Refresh'}
          </button>
        </div>
      </div>

      {/* ── Filter badges (fixed thresholds) ── */}
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
            No ads met the Spend ≥ $100 AND ROAS ≥ 1.6× threshold for {rangeMeta?.label || 'this range'}.
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
                  <SortableTh sortKey="spend"        sort={sort} onSort={handleSort}>Spend</SortableTh>
                  <SortableTh sortKey="roas"         sort={sort} onSort={handleSort}>ROAS</SortableTh>
                  <SortableTh sortKey="purchases"    sort={sort} onSort={handleSort}>PUR</SortableTh>
                  <SortableTh sortKey="cpa"          sort={sort} onSort={handleSort}>CPA</SortableTh>
                  <SortableTh sortKey="aov"          sort={sort} onSort={handleSort}>AOV</SortableTh>
                  <Th>NVP</Th>
                  <Th>Avatar</Th>
                  <Th>Angle</Th>
                  <Th>Format</Th>
                  <SortableTh sortKey="dateLaunched" sort={sort} onSort={handleSort}>Launch Date</SortableTh>
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

                    {/* Format */}
                    <Td><Tag label={row.format} /></Td>

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

      {/* ── Insights (charts) — Magic Patterns design ── */}
      {data.length > 0 && (() => {
        // Denominator for the format X/Y ratio: ads tested at meaningful
        // scale (≥ $100 spend), not raw ≥ $1 — matches the user's mental
        // model of "12 of the 18 Mashup ads we actually tested".
        const allAdsAtScale = rawData.filter(r => r.spend >= 100);
        const byFormat = aggregateWithTotals(data, allAdsAtScale, 'format');
        const byAngle  = aggregateBy(data, 'angle');
        // Editor ROAS over ALL their ≥$100 ads — winners-only would skew
        // the picture (an editor with a small sample of high-ROAS winners
        // would outrank one with broader, steadier performance).
        const byEditor = aggregateRoasBy(allAdsAtScale, 'editor');
        const total    = data.length;
        const topFormat = byFormat[0]?.name;
        const topAngle  = byAngle[0]?.name;
        const topEditor = byEditor[0];

        const cardCls = "rounded-2xl p-6 flex flex-col bg-gradient-to-br from-[#181818] to-[#0e0e10] border border-white/[0.06] shadow-lg";
        const headerCls = "flex items-start gap-3 mb-5";
        const iconCls  = "inline-flex items-center justify-center w-10 h-10 rounded-xl border border-[var(--color-accent)]/40 text-[var(--color-accent)] bg-[var(--color-accent)]/[0.06] flex-shrink-0";
        const titleCls = "text-sm uppercase tracking-[0.22em] font-semibold text-[var(--color-text-primary)]";
        const subCls   = "text-xs text-[var(--color-text-faint)] mt-1 italic";
        const footerCls = "mt-auto pt-4 border-t border-white/[0.05] flex items-center justify-between";
        const footerLabelCls = "text-[10px] uppercase tracking-[0.15em] text-[var(--color-text-faint)]";

        return (
          <div className="grid grid-cols-1 md:grid-cols-3 gap-5 pt-3">
            {/* ─── Winning Ads by Format ─── */}
            <div className={cardCls}>
              <div className={headerCls}>
                <span className={iconCls}><Trophy size={14} /></span>
                <div>
                  <h3 className={titleCls}>Winning Ads by Format</h3>
                  <p className={subCls}>Share of winners (ROAS ≥ 1.6×)</p>
                </div>
              </div>

              {byFormat.length === 0 ? (
                <div className="h-60 flex items-center justify-center text-xs text-[var(--color-text-faint)]">No format data</div>
              ) : (
                <>
                  <div className="relative">
                    {/* soft green glow halo behind the donut */}
                    <div
                      className="absolute inset-0 rounded-full pointer-events-none"
                      style={{ background: 'radial-gradient(circle at 50% 50%, rgba(34,197,94,0.18), rgba(34,197,94,0) 55%)' }}
                    />
                    <ResponsiveContainer width="100%" height={240}>
                      <PieChart>
                        <defs>
                          <linearGradient id="formatWinner" x1="0" y1="0" x2="0" y2="1">
                            <stop offset="0%" stopColor="#34d399" />
                            <stop offset="100%" stopColor="#15a169" />
                          </linearGradient>
                          <linearGradient id="formatSecond" x1="0" y1="0" x2="0" y2="1">
                            <stop offset="0%" stopColor="#f0e0b8" />
                            <stop offset="100%" stopColor="#c9a84c" />
                          </linearGradient>
                          <linearGradient id="formatThird" x1="0" y1="0" x2="0" y2="1">
                            <stop offset="0%" stopColor="#5b6b80" />
                            <stop offset="100%" stopColor="#3a4756" />
                          </linearGradient>
                          <linearGradient id="formatFourth" x1="0" y1="0" x2="0" y2="1">
                            <stop offset="0%" stopColor="#3a3a3a" />
                            <stop offset="100%" stopColor="#1f1f1f" />
                          </linearGradient>
                          <filter id="winnerGlow" x="-30%" y="-30%" width="160%" height="160%">
                            <feGaussianBlur stdDeviation="3" result="blur" />
                            <feMerge>
                              <feMergeNode in="blur" />
                              <feMergeNode in="SourceGraphic" />
                            </feMerge>
                          </filter>
                        </defs>
                        <Pie data={byFormat} dataKey="winCount" nameKey="name" innerRadius={72} outerRadius={104} paddingAngle={2} stroke="none">
                          {byFormat.map((_, i) => {
                            const fills = ['url(#formatWinner)', 'url(#formatSecond)', 'url(#formatThird)', 'url(#formatFourth)'];
                            return <Cell key={i} fill={fills[i] || 'url(#formatFourth)'} filter={i === 0 ? 'url(#winnerGlow)' : undefined} />;
                          })}
                        </Pie>
                        <Tooltip content={<ChartTooltip valueKey="winCount" suffix=" winners" />} />
                      </PieChart>
                    </ResponsiveContainer>
                    <div className="absolute inset-0 flex flex-col items-center justify-center pointer-events-none">
                      <div className="text-4xl font-semibold tabular-nums text-[var(--color-text-primary)]">{total}</div>
                      <div className="text-[10px] uppercase tracking-[0.22em] text-[var(--color-text-faint)] mt-1">winners</div>
                    </div>
                  </div>

                  <div className="mt-5 space-y-2.5 text-xs">
                    {byFormat.map((r, i) => {
                      const pct = (100 * r.winCount / total).toFixed(1);
                      const legendColors = ['#22c55e', '#e8d5a3', '#5b6b80', '#3a3a3a', '#7a7a7a', '#52525b'];
                      const dotColor = legendColors[i] || legendColors[legendColors.length - 1];
                      const pctColor = i === 0 ? '#22c55e' : 'var(--color-accent)';
                      return (
                        <div key={r.name} className="flex items-center gap-3">
                          <span className="w-2 h-2 rounded-full flex-shrink-0" style={{ background: dotColor }} />
                          <span className="flex-1 truncate text-[var(--color-text-primary)]" title={r.name}>{r.name}</span>
                          <span className="tabular-nums text-[var(--color-text-faint)] w-12 text-right">{r.winCount}/{r.totalCount}</span>
                          <span className="tabular-nums font-semibold w-12 text-right" style={{ color: pctColor }}>{pct}%</span>
                        </div>
                      );
                    })}
                  </div>
                </>
              )}

              <div className={footerCls}>
                <span className={footerLabelCls}>Top Format</span>
                <span className="text-xs font-medium" style={{ color: '#22c55e' }}>{topFormat || '—'}</span>
              </div>
            </div>

            {/* ─── Winning Ads by Angle ─── */}
            <div className={cardCls}>
              <div className={headerCls}>
                <span className={iconCls}><Target size={14} /></span>
                <div>
                  <h3 className={titleCls}>Winning Ads by Angle</h3>
                  <p className={subCls}>Count of winners (ROAS ≥ 1.6×) per angle</p>
                </div>
              </div>

              {byAngle.length === 0 ? (
                <div className="h-60 flex items-center justify-center text-xs text-[var(--color-text-faint)]">No angle data</div>
              ) : (
                <div className="flex-1">
                  <ResponsiveContainer width="100%" height={340}>
                    <BarChart data={byAngle} margin={{ top: 10, right: 8, bottom: 8, left: 0 }}>
                      <defs>
                        <linearGradient id="goldBar" x1="0" y1="0" x2="0" y2="1">
                          <stop offset="0%"   stopColor="#d8b66a" />
                          <stop offset="100%" stopColor="#a98a3a" />
                        </linearGradient>
                        <linearGradient id="dimBar" x1="0" y1="0" x2="0" y2="1">
                          <stop offset="0%"   stopColor="#2a2a2a" />
                          <stop offset="100%" stopColor="#141414" />
                        </linearGradient>
                      </defs>
                      <CartesianGrid stroke="rgba(255,255,255,0.05)" strokeDasharray="2 4" vertical={false} />
                      <XAxis
                        dataKey="name"
                        tick={{ fontSize: 12, fill: '#a1a1aa', fontStyle: 'italic' }}
                        axisLine={false}
                        tickLine={false}
                        interval={0}
                        angle={-25}
                        textAnchor="end"
                        height={80}
                      />
                      <YAxis
                        tick={{ fontSize: 13, fill: '#a1a1aa' }}
                        axisLine={false}
                        tickLine={false}
                        width={36}
                        allowDecimals={false}
                      />
                      <Tooltip content={<ChartTooltip valueKey="value" suffix=" winners" />} cursor={{ fill: 'rgba(255,255,255,0.04)' }} />
                      <Bar dataKey="value" radius={[4, 4, 0, 0]} maxBarSize={64}>
                        {byAngle.map((_, i) => (
                          <Cell key={i} fill={i === 0 ? 'url(#goldBar)' : 'url(#dimBar)'} />
                        ))}
                      </Bar>
                    </BarChart>
                  </ResponsiveContainer>
                </div>
              )}

              <div className={footerCls}>
                <span className={footerLabelCls}>Top Angle</span>
                <span className="inline-flex items-center gap-2 text-xs font-medium text-[var(--color-accent)]">
                  <span className="w-1.5 h-1.5 rounded-full bg-[var(--color-accent)]" />
                  {topAngle || '—'}
                </span>
              </div>
            </div>

            {/* ─── ROAS by Editor ─── */}
            <div className={cardCls}>
              <div className={headerCls}>
                <span className={iconCls}><User size={14} /></span>
                <div>
                  <h3 className={titleCls}>ROAS by Editor</h3>
                  <p className={subCls}>Average return on ad spend per editor</p>
                </div>
              </div>

              {byEditor.length === 0 ? (
                <div className="h-60 flex items-center justify-center text-xs text-[var(--color-text-faint)]">No editor data</div>
              ) : (
                <div className="flex-1">
                  <ResponsiveContainer width="100%" height={Math.max(220, byEditor.length * 34 + 30)}>
                    <BarChart data={byEditor} layout="vertical" margin={{ top: 4, right: 24, bottom: 4, left: 4 }}>
                      <defs>
                        <linearGradient id="editorGreen" x1="0" y1="0" x2="1" y2="0">
                          <stop offset="0%"   stopColor="#0d9b6c" />
                          <stop offset="100%" stopColor="#aef5d4" />
                        </linearGradient>
                        <linearGradient id="editorGold" x1="0" y1="0" x2="1" y2="0">
                          <stop offset="0%"   stopColor="#a98a3a" />
                          <stop offset="100%" stopColor="#f0e0b8" />
                        </linearGradient>
                        <linearGradient id="editorPink" x1="0" y1="0" x2="1" y2="0">
                          <stop offset="0%"   stopColor="#c2185b" />
                          <stop offset="100%" stopColor="#f5a3b8" />
                        </linearGradient>
                        <filter id="editorGreenGlow" x="-10%" y="-100%" width="120%" height="300%">
                          <feGaussianBlur stdDeviation="2" result="blur" />
                          <feMerge>
                            <feMergeNode in="blur" />
                            <feMergeNode in="SourceGraphic" />
                          </feMerge>
                        </filter>
                      </defs>
                      <CartesianGrid stroke="rgba(255,255,255,0.04)" strokeDasharray="2 4" horizontal={false} />
                      <XAxis
                        type="number"
                        tick={{ fontSize: 10, fill: '#71717a' }}
                        axisLine={false}
                        tickLine={false}
                        tickFormatter={(v) => `${v}×`}
                      />
                      <YAxis
                        dataKey="name"
                        type="category"
                        width={86}
                        tick={{ fontSize: 12, fill: '#fafafa' }}
                        axisLine={false}
                        tickLine={false}
                      />
                      <Tooltip content={<ChartTooltip valueKey="roas" suffix="× ROAS" />} cursor={false} />
                      <Bar dataKey="roas" radius={[10, 10, 10, 10]} maxBarSize={14}>
                        {byEditor.map((e, i) => {
                          const grad = e.roas >= 2.0 ? 'url(#editorGreen)' : e.roas >= 1.5 ? 'url(#editorGold)' : 'url(#editorPink)';
                          return <Cell key={i} fill={grad} filter={e.roas >= 2.0 ? 'url(#editorGreenGlow)' : undefined} />;
                        })}
                      </Bar>
                    </BarChart>
                  </ResponsiveContainer>
                </div>
              )}

              <div className={footerCls}>
                <span className={footerLabelCls}>Top Editor</span>
                <span className="text-xs font-medium" style={{
                  color: topEditor && topEditor.roas >= 2.0 ? '#4ade80'
                       : topEditor && topEditor.roas >= 1.5 ? '#c9a84c'
                       : '#fafafa'
                }}>
                  {topEditor ? `${topEditor.name} · ${topEditor.roas.toFixed(2)}×` : '—'}
                </span>
              </div>
            </div>
          </div>
        );
      })()}

      {/* ── Footer note ── */}
      <p className="text-xs text-[var(--color-text-faint)]">
        Data sourced from Triple Whale · Facebook post links from Meta Graph API · Cached refresh runs daily at 12:00 AM CET
      </p>
    </div>
  );
}
