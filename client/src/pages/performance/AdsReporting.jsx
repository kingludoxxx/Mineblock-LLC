import { useState, useEffect, useCallback } from 'react';
import api from '../../services/api';
import {
  RefreshCw,
  ExternalLink,
  Copy,
  Check,
  TrendingUp,
  AlertCircle,
  Loader2,
  Link2,
  Calendar,
  Clock,
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

// ── Column header ─────────────────────────────────────────────────────────────
function Th({ children, className = '' }) {
  return (
    <th
      className={`px-4 py-3 text-left text-xs font-semibold uppercase tracking-wider text-[var(--color-text-muted)] whitespace-nowrap ${className}`}
    >
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
// Gradient defined once in a hidden SVG so duplicate-ID issues across rows are avoided
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
const ClickUpLogo = ({ size = 13 }) => (
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

// ── Main page ─────────────────────────────────────────────────────────────────
export default function AdsReporting() {
  const [loading,  setLoading]  = useState(true);
  const [error,    setError]    = useState(null);
  const [data,     setData]     = useState([]);
  const [week,     setWeek]     = useState(null);
  const [genAt,    setGenAt]    = useState(null);
  const [token,    setToken]    = useState(null);
  const [copied,   setCopied]   = useState(false);
  const [refreshing, setRefreshing] = useState(false);
  const [adNameWidth, setAdNameWidth] = useState(220);

  const load = useCallback(async (force = false) => {
    try {
      if (force) setRefreshing(true);
      else       setLoading(true);
      setError(null);

      const url = force ? '/ads-reporting/weekly?refresh=1' : '/ads-reporting/weekly';
      const res = await api.get(url);
      setData(res.data.data || []);
      setWeek(res.data.week);
      setGenAt(res.data.generatedAt);
      setToken(res.data.shareToken);
    } catch (err) {
      setError(err?.response?.data?.error || err.message || 'Failed to load report');
    } finally {
      setLoading(false);
      setRefreshing(false);
    }
  }, []);

  useEffect(() => { load(); }, [load]);

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
    if (!token) return;
    const url = `${window.location.origin}/ads-report/${token}`;
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

  // ── Loading state ─────────────────────────────────────────────────────────
  if (loading) {
    return (
      <div className="flex flex-col items-center justify-center h-72 gap-3 text-[var(--color-text-muted)]">
        <Loader2 size={28} className="animate-spin text-[var(--color-accent)]" />
        <p className="text-sm">Pulling data from Triple Whale…</p>
      </div>
    );
  }

  // ── Error state ───────────────────────────────────────────────────────────
  if (error) {
    return (
      <div className="flex flex-col items-center justify-center h-72 gap-3 text-[var(--color-text-muted)]">
        <AlertCircle size={28} className="text-red-400" />
        <p className="text-sm text-red-400 font-medium">Failed to load report</p>
        <p className="text-xs text-center max-w-sm">{error}</p>
        <button
          onClick={() => load()}
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
            {week && (
              <span className="flex items-center gap-1.5">
                <Calendar size={12} />
                {week.label}
              </span>
            )}
            {genAt && (
              <span className="flex items-center gap-1.5">
                <Clock size={12} />
                Updated {timeAgo(genAt)}
              </span>
            )}
          </div>
        </div>

        <div className="flex items-center gap-2">
          {/* Share button */}
          <button
            onClick={copyLink}
            className="flex items-center gap-1.5 px-3 py-1.5 rounded text-xs font-medium border border-[var(--color-border-default)] bg-[var(--color-bg-elevated)] hover:bg-[var(--color-bg-hover)] text-[var(--color-text-muted)] hover:text-[var(--color-text-primary)] transition-colors"
          >
            {copied ? <Check size={13} className="text-green-400" /> : <Link2 size={13} />}
            {copied ? 'Link copied!' : 'Share report'}
          </button>

          {/* Refresh button */}
          <button
            onClick={() => load(true)}
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
      </div>

      {/* ── Empty state ── */}
      {data.length === 0 && (
        <div className="flex flex-col items-center justify-center h-56 gap-3 border border-[var(--color-border-subtle)] rounded-xl bg-[var(--color-bg-card)]">
          <TrendingUp size={28} className="text-[var(--color-text-faint)]" />
          <p className="text-sm font-medium text-[var(--color-text-muted)]">No qualifying ads this week</p>
          <p className="text-xs text-[var(--color-text-faint)] text-center max-w-xs">
            No ads met the spend ≥ $100 and ROAS ≥ 1.6× threshold for {week?.label}.
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
                  <Th>Link</Th>
                  <Th>Spend</Th>
                  <Th>ROAS</Th>
                  <Th>PUR</Th>
                  <Th>CPA</Th>
                  <Th>AOV</Th>
                  <Th>NVP</Th>
                  <Th>Avatar</Th>
                  <Th>Angle</Th>
                  <Th>Launch Date</Th>
                  <Th>CU</Th>
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

                    {/* Ad Name */}
                    <td className="px-4 py-3 text-sm text-[var(--color-text-primary)]" style={{ maxWidth: adNameWidth, width: adNameWidth }}>
                      <span
                        className="block truncate font-medium"
                        title={row.adName}
                      >
                        {row.adName}
                      </span>
                    </td>

                    {/* FB Link */}
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

                    {/* ClickUp */}
                    <Td>
                      {row.clickupUrl ? (
                        <a
                          href={row.clickupUrl}
                          target="_blank"
                          rel="noopener noreferrer"
                          title="Open in ClickUp"
                          className="inline-flex items-center justify-center w-6 h-6 rounded hover:bg-purple-500/10 transition-colors"
                        >
                          <ClickUpLogo />
                        </a>
                      ) : (
                        <span className="text-[var(--color-text-faint)]">—</span>
                      )}
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
        Data sourced from Triple Whale · Facebook creative links from Meta Ads Library · Updates automatically at 12:00 AM CET
      </p>
    </div>
  );
}
