import { useState, useEffect, useRef } from 'react';
import { useParams } from 'react-router-dom';
import { TrendingUp, ExternalLink, AlertCircle, Loader2, Calendar, ChevronDown } from 'lucide-react';
import { PieChart, Pie, Cell, BarChart, Bar, XAxis, YAxis, ResponsiveContainer, Tooltip, CartesianGrid } from 'recharts';
import { Trophy, Target, User } from 'lucide-react';

const CHART_COLORS = ['#c9a84c', '#e8d5a3', '#a08838', '#806a2a', '#4ade80', '#d4b169', '#5d4d1e', '#f0e0b8', '#bf9e44', '#9a8030'];

function aggregateByPublic(rows, key) {
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

function aggregateWithTotalsPublic(winners, allRows, key) {
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

function aggregateRoasByPublic(rows, key) {
  const buckets = new Map();
  for (const r of rows) {
    const k = r[key];
    if (!k || !r.spend) continue;
    if (!buckets.has(k)) buckets.set(k, { spend: 0, revenue: 0 });
    const b = buckets.get(k);
    b.spend   += r.spend || 0;
    b.revenue += (r.spend || 0) * (r.roas || 0);
  }
  return [...buckets.entries()]
    .map(([name, b]) => ({
      name,
      roas: b.spend > 0 ? +(b.revenue / b.spend).toFixed(2) : 0,
    }))
    .sort((a, b) => b.roas - a.roas);
}

const PUBLIC_PRESETS = [
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

// ROAS color thresholds aligned to the Magic Patterns design.
function roasColor(roas) {
  if (roas >= 2.0) return '#22c55e';
  if (roas >= 1.0) return '#c9a84c';
  return '#f87171';
}

// Stable color per tag value (must match the auth page's TAG_OVERRIDES).
const TAG_PALETTE_PUB = ['#fb923c', '#f87171', '#a78bfa', '#38bdf8', '#22c55e', '#facc15', '#fb7185', '#22d3ee', '#e8d5a3', '#06b6d4', '#c084fc', '#fbbf24'];
const TAG_OVERRIDES_PUB = {
  'Lottery': '#fb923c', 'Againstcompetition': '#f87171', 'Offer': '#a78bfa',
  'ASMR': '#22d3ee', 'BTC Made easy': '#4ade80', 'GTRS': '#06b6d4',
  'BTCFARM': '#22c55e', 'Reaction': '#fb7185', 'Missedopportunity': '#facc15',
  'Aware': '#94a3b8', 'Mashup': '#a78bfa', 'ShortVid': '#38bdf8',
  'Cartoon': '#22c55e', 'UGC': '#fb923c', 'IMG': '#22d3ee', 'Mini VSL': '#e8d5a3',
  'MoneySeeker': '#c9a84c', 'Cryptoaddict': '#facc15', 'NA': '#71717a',
};
function tagColorPub(label) {
  if (!label) return '#71717a';
  if (TAG_OVERRIDES_PUB[label]) return TAG_OVERRIDES_PUB[label];
  let hash = 0;
  for (let i = 0; i < label.length; i++) {
    hash = ((hash << 5) - hash) + label.charCodeAt(i);
    hash |= 0;
  }
  return TAG_PALETTE_PUB[Math.abs(hash) % TAG_PALETTE_PUB.length];
}

function Tag({ label }) {
  if (!label) return <span style={{ color: '#52525b' }}>—</span>;
  const c = tagColorPub(label);
  return (
    <span style={{
      display: 'inline-block',
      padding: '2px 8px',
      borderRadius: '4px',
      background: `${c}14`,
      color: c,
      border: `1px solid ${c}66`,
      fontSize: '10px',
      fontWeight: 600,
      textTransform: 'uppercase',
      letterSpacing: '0.05em',
    }}>
      {label}
    </span>
  );
}

// Kept for compatibility with existing call sites; same look as Tag now.
function TagGrey({ label }) {
  return <Tag label={label} />;
}

const S = {
  page: {
    minHeight: '100vh',
    background: '#09090b',
    color: '#fafafa',
    fontFamily: "'Inter', system-ui, sans-serif",
    padding: '32px 24px',
  },
  header: {
    display: 'flex',
    alignItems: 'flex-start',
    justifyContent: 'space-between',
    marginBottom: '24px',
    flexWrap: 'wrap',
    gap: '12px',
  },
  title: { fontSize: '20px', fontWeight: 600, margin: 0 },
  subtitle: { fontSize: '12px', color: '#a1a1aa', marginTop: '4px', display: 'flex', alignItems: 'center', gap: '6px' },
  badge: {
    display: 'inline-block',
    padding: '2px 8px',
    borderRadius: '4px',
    background: 'rgba(255,255,255,0.04)',
    color: '#a1a1aa',
    border: '1px solid rgba(255,255,255,0.08)',
    fontSize: '11px',
    marginRight: '6px',
  },
  card: {
    borderRadius: '12px',
    border: '1px solid rgba(255,255,255,0.05)',
    background: '#111113',
    overflow: 'hidden',
  },
  tableWrap: { overflowX: 'auto' },
  table: { width: '100%', borderCollapse: 'collapse' },
  th: {
    padding: '12px 16px',
    textAlign: 'left',
    fontSize: '11px',
    fontWeight: 600,
    textTransform: 'uppercase',
    letterSpacing: '0.05em',
    color: '#71717a',
    borderBottom: '1px solid rgba(255,255,255,0.05)',
    whiteSpace: 'nowrap',
  },
  td: {
    padding: '12px 16px',
    fontSize: '13px',
    borderBottom: '1px solid rgba(255,255,255,0.04)',
    verticalAlign: 'middle',
  },
  center: {
    display: 'flex',
    flexDirection: 'column',
    alignItems: 'center',
    justifyContent: 'center',
    minHeight: '280px',
    gap: '12px',
    color: '#71717a',
  },
  logo: {
    display: 'flex',
    alignItems: 'center',
    gap: '8px',
    padding: '6px 12px',
    borderRadius: '8px',
    background: 'rgba(201,168,76,0.08)',
    border: '1px solid rgba(201,168,76,0.15)',
    color: '#c9a84c',
    fontSize: '13px',
    fontWeight: 600,
  },
};

export default function AdsReportPublic() {
  const { token } = useParams();
  const [loading,     setLoading]     = useState(true);
  const [error,       setError]       = useState(null);
  const [rawData,     setRawData]     = useState([]);
  const [range,       setRange]       = useState(null);
  const [rangeKey,    setRangeKey]    = useState(null);  // null = use snapshot's range
  const [generatedAt, setGeneratedAt] = useState(null);
  const [pickerOpen,  setPickerOpen]  = useState(false);
  const [adNameWidth, setAdNameWidth] = useState(220);
  const [sort,        setSort]        = useState({ key: 'roas', dir: 'desc' });
  const pickerRef = useRef(null);

  function handleSort(key) {
    setSort(s => {
      if (s.key !== key) return { key, dir: 'desc' };
      if (s.dir === 'desc') return { key, dir: 'asc' };
      return { key: 'roas', dir: 'desc' };
    });
  }

  useEffect(() => {
    function onClick(e) { if (pickerRef.current && !pickerRef.current.contains(e.target)) setPickerOpen(false); }
    if (pickerOpen) document.addEventListener('mousedown', onClick);
    return () => document.removeEventListener('mousedown', onClick);
  }, [pickerOpen]);

  // Winning-ads filter + user-driven sort (default ROAS desc)
  const filtered = rawData.filter(r => r.spend >= 100 && r.roas >= 1.6);
  const data = (() => {
    if (!filtered.length) return filtered;
    const dir = sort.dir === 'asc' ? 1 : -1;
    return [...filtered].sort((a, b) => {
      const av = a[sort.key], bv = b[sort.key];
      if (av == null && bv == null) return 0;
      if (av == null) return 1;
      if (bv == null) return -1;
      if (typeof av === 'string' && typeof bv === 'string') return av.localeCompare(bv) * dir;
      return (av - bv) * dir;
    });
  })();

  function startResize(e) {
    const startX = e.clientX;
    const startW = adNameWidth;
    function onMove(ev) { setAdNameWidth(Math.max(80, startW + ev.clientX - startX)); }
    function onUp()     { window.removeEventListener('mousemove', onMove); window.removeEventListener('mouseup', onUp); }
    window.addEventListener('mousemove', onMove);
    window.addEventListener('mouseup', onUp);
    e.preventDefault();
  }

  useEffect(() => {
    if (!token) { setError('Invalid share link'); setLoading(false); return; }
    setLoading(true);
    setError(null);
    const params = new URLSearchParams({ token });
    if (rangeKey) params.set('range', rangeKey);
    fetch(`/api/v1/ads-reporting/public?${params.toString()}`)
      .then(r => r.json())
      .then(res => {
        if (!res.ok) throw new Error(res.error || 'Failed to load');
        setRawData(res.data || []);
        setRange(res.range || res.week || null);
        setGeneratedAt(res.generatedAt || null);
      })
      .catch(err => setError(err.message))
      .finally(() => setLoading(false));
  }, [token, rangeKey]);

  // Only show full-page spinner on the very first load (no data + no range yet)
  if (loading && !range) {
    return (
      <div style={S.page}>
        <div style={S.center}>
          <Loader2 size={28} style={{ color: '#c9a84c', animation: 'spin 1s linear infinite' }} />
          <p style={{ fontSize: '14px' }}>Loading report…</p>
        </div>
      </div>
    );
  }

  if (error) {
    return (
      <div style={S.page}>
        <div style={S.center}>
          <AlertCircle size={28} style={{ color: '#f87171' }} />
          <p style={{ color: '#f87171', fontWeight: 500 }}>Could not load report</p>
          <p style={{ fontSize: '13px', textAlign: 'center', maxWidth: '320px' }}>{error}</p>
        </div>
      </div>
    );
  }

  const rangeLabel = range
    ? (range.label || (() => {
        const months = ['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec'];
        const s = new Date(range.start);
        const e = new Date(range.end);
        if (isNaN(s.getTime()) || isNaN(e.getTime())) return '';
        const sLabel = `${months[s.getUTCMonth()]} ${s.getUTCDate()}`;
        const eLabel = `${months[e.getUTCMonth()]} ${e.getUTCDate()}`;
        return sLabel === eLabel ? sLabel : `${sLabel} – ${eLabel}`;
      })())
    : '';

  return (
    <div style={S.page}>
      {/* Suppress browser's default focus rectangle on chart SVGs */}
      <style>{`
        .recharts-wrapper, .recharts-wrapper *,
        .recharts-surface, .recharts-surface * { outline: none !important; }
      `}</style>
      {/* Single gradient definition — avoids duplicate IDs across rows */}
      <svg width={0} height={0} style={{ position: 'absolute' }}>
        <defs>
          <linearGradient id="cu-p" x1="4" y1="21" x2="44" y2="21" gradientUnits="userSpaceOnUse">
            <stop stopColor="#FF7043"/><stop offset="0.5" stopColor="#C550E0"/><stop offset="1" stopColor="#38B2F4"/>
          </linearGradient>
        </defs>
      </svg>

      <div style={S.header}>
        <div>
          <div style={{ display: 'flex', alignItems: 'center', gap: '8px', marginBottom: '4px' }}>
            <TrendingUp size={26} strokeWidth={2.5} style={{ color: '#c9a84c' }} />
            <h1 style={{ fontSize: '24px', fontWeight: 700, margin: 0, letterSpacing: '-0.01em' }}>
              <span style={{ color: '#fafafa' }}>Ads</span>{' '}
              <span style={{ color: '#c9a84c' }}>Reporting</span>
            </h1>
          </div>
          {rangeLabel && (
            <div style={S.subtitle}>
              <Calendar size={12} />
              {rangeLabel}
              <span style={{ color: '#52525b' }}>·</span>
              {data.length} winning ad{data.length !== 1 ? 's' : ''}
            </div>
          )}
        </div>
        <div style={{ display: 'flex', alignItems: 'center', gap: '8px' }}>
          {/* Range picker */}
          <div ref={pickerRef} style={{ position: 'relative' }}>
            <button
              type="button"
              onClick={() => setPickerOpen(o => !o)}
              style={{
                display: 'flex', alignItems: 'center', gap: '8px',
                padding: '8px 14px', borderRadius: '8px',
                background: 'transparent',
                border: '1px solid rgba(201,168,76,0.6)',
                color: '#c9a84c', fontSize: '12px', fontWeight: 500,
                cursor: 'pointer', minWidth: 170,
              }}
            >
              <Calendar size={14} style={{ color: '#c9a84c' }} />
              <span style={{ flex: 1, textAlign: 'left' }}>
                {PUBLIC_PRESETS.find(p => p.key === (rangeKey || range?.key))?.label || 'Range'}
              </span>
              <ChevronDown size={14} style={{ color: '#c9a84c', transform: pickerOpen ? 'rotate(180deg)' : '', transition: 'transform 0.15s' }} />
            </button>
            {pickerOpen && (
              <div style={{
                position: 'absolute', zIndex: 30, marginTop: '4px', right: 0,
                width: '224px', borderRadius: '8px',
                background: '#111113', border: '1px solid rgba(255,255,255,0.08)',
                boxShadow: '0 12px 40px rgba(0,0,0,0.5)', overflow: 'hidden',
                padding: '4px 0', maxHeight: '320px', overflowY: 'auto',
              }}>
                {PUBLIC_PRESETS.map(p => {
                  const active = p.key === (rangeKey || range?.key);
                  return (
                    <button
                      key={p.key}
                      onClick={() => { setRangeKey(p.key); setPickerOpen(false); }}
                      style={{
                        width: '100%', textAlign: 'left',
                        padding: '6px 12px', fontSize: '12px',
                        background: active ? 'rgba(201,168,76,0.12)' : 'transparent',
                        color: active ? '#e8d5a3' : '#fafafa',
                        border: 'none', cursor: 'pointer',
                      }}
                      onMouseEnter={(e) => { if (!active) e.currentTarget.style.background = 'rgba(255,255,255,0.04)'; }}
                      onMouseLeave={(e) => { if (!active) e.currentTarget.style.background = 'transparent'; }}
                    >
                      {p.label}
                    </button>
                  );
                })}
              </div>
            )}
          </div>
          <div style={S.logo}>
            <TrendingUp size={14} />
            MineBlock
          </div>
        </div>
      </div>

      <div style={{ display: 'flex', gap: '6px', marginBottom: '20px', flexWrap: 'wrap' }}>
        <span style={S.badge}>Spend ≥ $100</span>
        <span style={S.badge}>ROAS ≥ 1.6×</span>
        <span style={S.badge}>Sorted by ROAS</span>
      </div>

      {data.length === 0 ? (
        <div style={{ ...S.center, border: '1px solid rgba(255,255,255,0.05)', borderRadius: '12px' }}>
          <TrendingUp size={28} style={{ color: '#3f3f46' }} />
          <p style={{ fontWeight: 500, color: '#a1a1aa' }}>No qualifying ads in this range</p>
        </div>
      ) : (
        <div style={S.card}>
          <div style={S.tableWrap}>
            <table style={S.table}>
              <thead>
                <tr>
                  {['#','Campaign'].map(h => <th key={h} style={S.th}>{h}</th>)}
                  <th style={{ ...S.th, position: 'relative', minWidth: adNameWidth, width: adNameWidth, userSelect: 'none' }}>
                    Ad Name
                    <div onMouseDown={startResize} style={{ position: 'absolute', right: 0, top: 0, bottom: 0, width: 6, cursor: 'col-resize', borderRight: '2px solid rgba(255,255,255,0.06)' }} />
                  </th>
                  <th style={S.th}>FB Post</th>
                  {[
                    { label: 'Spend', key: 'spend' },
                    { label: 'ROAS',  key: 'roas'  },
                    { label: 'PUR',   key: 'purchases' },
                    { label: 'CPA',   key: 'cpa'   },
                    { label: 'AOV',   key: 'aov'   },
                  ].map(h => {
                    const active = sort.key === h.key;
                    const arrow  = !active ? '⇕' : sort.dir === 'asc' ? '▲' : '▼';
                    return (
                      <th
                        key={h.key}
                        onClick={() => handleSort(h.key)}
                        style={{
                          ...S.th,
                          cursor: 'pointer',
                          color: active ? '#c9a84c' : '#71717a',
                          userSelect: 'none',
                        }}
                      >
                        <span style={{ display: 'inline-flex', alignItems: 'center', gap: '4px' }}>
                          {h.label}
                          <span style={{ fontSize: '9px', opacity: active ? 1 : 0.5 }}>{arrow}</span>
                        </span>
                      </th>
                    );
                  })}
                  <th style={S.th}>NVP</th>
                  <th style={S.th}>Avatar</th>
                  <th style={S.th}>Angle</th>
                  <th style={S.th}>Format</th>
                  <th
                    onClick={() => handleSort('dateLaunched')}
                    style={{
                      ...S.th,
                      cursor: 'pointer',
                      color: sort.key === 'dateLaunched' ? '#c9a84c' : '#71717a',
                      userSelect: 'none',
                    }}
                  >
                    <span style={{ display: 'inline-flex', alignItems: 'center', gap: '4px' }}>
                      Launch Date
                      <span style={{ fontSize: '9px', opacity: sort.key === 'dateLaunched' ? 1 : 0.5 }}>
                        {sort.key !== 'dateLaunched' ? '⇕' : sort.dir === 'asc' ? '▲' : '▼'}
                      </span>
                    </span>
                  </th>
                </tr>
              </thead>
              <tbody>
                {data.map((row, i) => (
                  <tr key={i} style={{ background: i % 2 === 0 ? 'transparent' : 'rgba(255,255,255,0.01)' }}>
                    <td style={{ ...S.td, color: '#52525b', width: '32px' }}>{i + 1}</td>

                    <td style={S.td}>
                      <span style={{ display: 'block', maxWidth: '160px', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', color: '#a1a1aa', fontSize: '12px' }}
                        title={row.campaignName}>
                        {row.campaignName || '—'}
                      </span>
                    </td>

                    <td style={{ ...S.td, maxWidth: adNameWidth, width: adNameWidth }}>
                      <div style={{ display: 'flex', alignItems: 'center', gap: '8px', minWidth: 0 }}>
                        {row.clickupUrl ? (
                          <a href={row.clickupUrl} target="_blank" rel="noopener noreferrer" title="Open in ClickUp"
                            style={{ display: 'inline-flex', alignItems: 'center', justifyContent: 'center', width: 20, height: 20, borderRadius: 4, cursor: 'pointer', textDecoration: 'none', flexShrink: 0 }}>
                            <svg width="14" height="10" viewBox="0 0 48 32" fill="none">
                              <path d="M4 26 L14 16 L24 26 L34 16 L44 26" stroke="url(#cu-p)" strokeWidth="6" strokeLinecap="round" strokeLinejoin="round"/>
                            </svg>
                          </a>
                        ) : (
                          <span style={{ display: 'inline-block', width: 20, height: 20, flexShrink: 0 }} aria-hidden="true" />
                        )}
                        <span style={{ display: 'block', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', fontWeight: 500, minWidth: 0 }}
                          title={row.adName}>
                          {row.adName}
                        </span>
                      </div>
                    </td>

                    <td style={S.td}>
                      {row.fbLink ? (
                        <a href={row.fbLink} target="_blank" rel="noopener noreferrer"
                          style={{ color: '#c9a84c', display: 'flex', alignItems: 'center', gap: '4px', fontSize: '12px', fontWeight: 500, textDecoration: 'none' }}>
                          View <ExternalLink size={11} />
                        </a>
                      ) : <span style={{ color: '#52525b' }}>—</span>}
                    </td>

                    <td style={{ ...S.td, fontWeight: 500, fontVariantNumeric: 'tabular-nums' }}>
                      {fmtMoney(row.spend)}
                    </td>

                    <td style={{ ...S.td, fontWeight: 700, fontVariantNumeric: 'tabular-nums', color: roasColor(row.roas) }}>
                      {fmtDec(row.roas)}×
                    </td>

                    <td style={{ ...S.td, color: '#a1a1aa', fontVariantNumeric: 'tabular-nums' }}>
                      {row.purchases ?? '—'}
                    </td>

                    <td style={{ ...S.td, color: '#a1a1aa', fontVariantNumeric: 'tabular-nums' }}>
                      {row.cpa != null ? fmtMoney(row.cpa) : '—'}
                    </td>

                    <td style={{ ...S.td, color: '#a1a1aa', fontVariantNumeric: 'tabular-nums' }}>
                      {row.aov != null ? fmtMoney(row.aov) : '—'}
                    </td>

                    <td style={{ ...S.td, color: '#a1a1aa', fontVariantNumeric: 'tabular-nums' }}>
                      {fmtPct(row.nvp)}
                    </td>

                    <td style={S.td}><Tag label={row.avatar} /></td>
                    <td style={S.td}><TagGrey label={row.angle} /></td>
                    <td style={S.td}><TagGrey label={row.format} /></td>
                    <td style={{ ...S.td, color: '#a1a1aa', whiteSpace: 'nowrap' }}>{fmtDate(row.dateLaunched)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      )}

      {/* ── Insights (charts) — Magic Patterns design ── */}
      {data.length > 0 && (() => {
        const allAdsAtScale = rawData.filter(r => r.spend >= 100);
        const byFormat = aggregateWithTotalsPublic(data, allAdsAtScale, 'format');
        const byAngle  = aggregateByPublic(data, 'angle');
        // Editor ROAS over ALL their ≥$100 ads — same rationale as auth page.
        const byEditor = aggregateRoasByPublic(allAdsAtScale, 'editor');
        const total    = data.length;
        const topFormat = byFormat[0]?.name;
        const topAngle  = byAngle[0]?.name;
        const topEditor = byEditor[0];

        const card = {
          borderRadius: '16px',
          padding: '24px',
          display: 'flex',
          flexDirection: 'column',
          background: 'linear-gradient(135deg, #181818, #0e0e10)',
          border: '1px solid rgba(255,255,255,0.06)',
          boxShadow: '0 4px 24px rgba(0,0,0,0.2)',
        };
        const headerRow = { display: 'flex', alignItems: 'flex-start', gap: '12px', marginBottom: '20px' };
        const iconBox = { display: 'inline-flex', alignItems: 'center', justifyContent: 'center', width: '40px', height: '40px', borderRadius: '12px', border: '1px solid rgba(201,168,76,0.4)', background: 'rgba(201,168,76,0.06)', color: '#c9a84c', flexShrink: 0 };
        const title = { fontSize: '14px', textTransform: 'uppercase', letterSpacing: '0.22em', fontWeight: 600, color: '#fafafa', margin: 0 };
        const subtitle = { fontSize: '12px', color: '#52525b', fontStyle: 'italic', marginTop: '4px', margin: 0 };
        const footer = { marginTop: 'auto', paddingTop: '16px', borderTop: '1px solid rgba(255,255,255,0.05)', display: 'flex', alignItems: 'center', justifyContent: 'space-between' };
        const footerLabel = { fontSize: '10px', textTransform: 'uppercase', letterSpacing: '0.15em', color: '#52525b' };

        const tipFn = ({ active, payload, suffix = '' }) => {
          if (!active || !payload?.length) return null;
          const p = payload[0];
          return (
            <div style={{ padding: '6px 10px', borderRadius: '6px', border: '1px solid rgba(255,255,255,0.08)', background: '#111113', fontSize: '12px' }}>
              <div style={{ color: '#fafafa', fontWeight: 500 }}>{p.payload.name}</div>
              <div style={{ color: '#a1a1aa' }}>{p.value}{suffix}</div>
            </div>
          );
        };

        return (
          <div style={{ marginTop: '24px', display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(340px, 1fr))', gap: '20px' }}>
            {/* Winning Ads by Format */}
            <div style={card}>
              <div style={headerRow}>
                <span style={iconBox}><Trophy size={14} /></span>
                <div>
                  <h3 style={title}>Winning Ads by Format</h3>
                  <p style={subtitle}>Share of winners (ROAS ≥ 1.6×)</p>
                </div>
              </div>
              {byFormat.length === 0 ? (
                <div style={{ height: '240px', display: 'flex', alignItems: 'center', justifyContent: 'center', color: '#52525b', fontSize: '12px' }}>No format data</div>
              ) : (
                <>
                  <div style={{ position: 'relative' }}>
                    <div style={{ position: 'absolute', inset: 0, pointerEvents: 'none', borderRadius: '50%', background: 'radial-gradient(circle at 50% 50%, rgba(34,197,94,0.18), rgba(34,197,94,0) 55%)' }} />
                    <ResponsiveContainer width="100%" height={240}>
                      <PieChart>
                        <defs>
                          <linearGradient id="formatWinnerPub" x1="0" y1="0" x2="0" y2="1">
                            <stop offset="0%" stopColor="#34d399" />
                            <stop offset="100%" stopColor="#15a169" />
                          </linearGradient>
                          <linearGradient id="formatSecondPub" x1="0" y1="0" x2="0" y2="1">
                            <stop offset="0%" stopColor="#f0e0b8" />
                            <stop offset="100%" stopColor="#c9a84c" />
                          </linearGradient>
                          <linearGradient id="formatThirdPub" x1="0" y1="0" x2="0" y2="1">
                            <stop offset="0%" stopColor="#5b6b80" />
                            <stop offset="100%" stopColor="#3a4756" />
                          </linearGradient>
                          <linearGradient id="formatFourthPub" x1="0" y1="0" x2="0" y2="1">
                            <stop offset="0%" stopColor="#3a3a3a" />
                            <stop offset="100%" stopColor="#1f1f1f" />
                          </linearGradient>
                          <filter id="winnerGlowPub" x="-30%" y="-30%" width="160%" height="160%">
                            <feGaussianBlur stdDeviation="3" result="blur" />
                            <feMerge>
                              <feMergeNode in="blur" />
                              <feMergeNode in="SourceGraphic" />
                            </feMerge>
                          </filter>
                        </defs>
                        <Pie data={byFormat} dataKey="winCount" nameKey="name" innerRadius={72} outerRadius={104} paddingAngle={2} stroke="none">
                          {byFormat.map((_, i) => {
                            const fills = ['url(#formatWinnerPub)', 'url(#formatSecondPub)', 'url(#formatThirdPub)', 'url(#formatFourthPub)'];
                            return <Cell key={i} fill={fills[i] || 'url(#formatFourthPub)'} filter={i === 0 ? 'url(#winnerGlowPub)' : undefined} />;
                          })}
                        </Pie>
                        <Tooltip content={(p) => tipFn({ ...p, suffix: ' winners' })} />
                      </PieChart>
                    </ResponsiveContainer>
                    <div style={{ position: 'absolute', inset: 0, display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center', pointerEvents: 'none' }}>
                      <div style={{ fontSize: '36px', fontWeight: 600, color: '#fafafa', fontVariantNumeric: 'tabular-nums' }}>{total}</div>
                      <div style={{ fontSize: '10px', textTransform: 'uppercase', letterSpacing: '0.22em', color: '#52525b', marginTop: '4px' }}>winners</div>
                    </div>
                  </div>
                  <div style={{ marginTop: '20px' }}>
                    {byFormat.map((r, i) => {
                      const pct = (100 * r.winCount / total).toFixed(1);
                      const legendColors = ['#22c55e', '#e8d5a3', '#5b6b80', '#3a3a3a', '#7a7a7a', '#52525b'];
                      const dotColor = legendColors[i] || legendColors[legendColors.length - 1];
                      const pctColor = i === 0 ? '#22c55e' : '#c9a84c';
                      return (
                        <div key={r.name} style={{ display: 'flex', alignItems: 'center', gap: '12px', fontSize: '12px', marginBottom: '10px', minWidth: 0 }}>
                          <span style={{ width: '8px', height: '8px', borderRadius: '50%', background: dotColor, flexShrink: 0 }} />
                          <span style={{ flex: 1, color: '#fafafa', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }} title={r.name}>{r.name}</span>
                          <span style={{ color: '#52525b', fontVariantNumeric: 'tabular-nums', width: '52px', textAlign: 'right' }}>{r.winCount}/{r.totalCount}</span>
                          <span style={{ color: pctColor, fontWeight: 600, fontVariantNumeric: 'tabular-nums', width: '50px', textAlign: 'right' }}>{pct}%</span>
                        </div>
                      );
                    })}
                  </div>
                </>
              )}
              <div style={footer}>
                <span style={footerLabel}>Top Format</span>
                <span style={{ fontSize: '12px', fontWeight: 500, color: '#22c55e' }}>{topFormat || '—'}</span>
              </div>
            </div>

            {/* Winning Ads by Angle */}
            <div style={card}>
              <div style={headerRow}>
                <span style={iconBox}><Target size={14} /></span>
                <div>
                  <h3 style={title}>Winning Ads by Angle</h3>
                  <p style={subtitle}>Count of winners (ROAS ≥ 1.6×) per angle</p>
                </div>
              </div>
              {byAngle.length === 0 ? (
                <div style={{ height: '240px', display: 'flex', alignItems: 'center', justifyContent: 'center', color: '#52525b', fontSize: '12px' }}>No angle data</div>
              ) : (
                <div style={{ flex: 1, minHeight: '340px' }}>
                  <ResponsiveContainer width="100%" height={340}>
                    <BarChart data={byAngle} margin={{ top: 10, right: 8, bottom: 8, left: 0 }}>
                      <defs>
                        <linearGradient id="goldBarPub" x1="0" y1="0" x2="0" y2="1">
                          <stop offset="0%"   stopColor="#d8b66a" />
                          <stop offset="100%" stopColor="#a98a3a" />
                        </linearGradient>
                        <linearGradient id="dimBarPub" x1="0" y1="0" x2="0" y2="1">
                          <stop offset="0%"   stopColor="#2a2a2a" />
                          <stop offset="100%" stopColor="#141414" />
                        </linearGradient>
                      </defs>
                      <CartesianGrid stroke="rgba(255,255,255,0.05)" strokeDasharray="2 4" vertical={false} />
                      <XAxis dataKey="name" tick={{ fontSize: 12, fill: '#a1a1aa', fontStyle: 'italic' }} axisLine={false} tickLine={false} interval={0} angle={-25} textAnchor="end" height={80} />
                      <YAxis tick={{ fontSize: 13, fill: '#a1a1aa' }} axisLine={false} tickLine={false} width={36} allowDecimals={false} />
                      <Tooltip content={(p) => tipFn({ ...p, suffix: ' winners' })} cursor={false} />
                      <Bar dataKey="value" radius={[4, 4, 0, 0]} maxBarSize={64}>
                        {byAngle.map((_, i) => (
                          <Cell key={i} fill={i === 0 ? 'url(#goldBarPub)' : 'url(#dimBarPub)'} />
                        ))}
                      </Bar>
                    </BarChart>
                  </ResponsiveContainer>
                </div>
              )}
              <div style={footer}>
                <span style={footerLabel}>Top Angle</span>
                <span style={{ fontSize: '12px', fontWeight: 500, color: '#c9a84c', display: 'inline-flex', alignItems: 'center', gap: '6px' }}>
                  <span style={{ width: '6px', height: '6px', borderRadius: '50%', background: '#c9a84c' }} />
                  {topAngle || '—'}
                </span>
              </div>
            </div>

            {/* ROAS by Editor */}
            <div style={card}>
              <div style={headerRow}>
                <span style={iconBox}><User size={14} /></span>
                <div>
                  <h3 style={title}>ROAS by Editor</h3>
                  <p style={subtitle}>Average return on ad spend per editor</p>
                </div>
              </div>
              {byEditor.length === 0 ? (
                <div style={{ height: '240px', display: 'flex', alignItems: 'center', justifyContent: 'center', color: '#52525b', fontSize: '12px' }}>No editor data</div>
              ) : (
                <div style={{ flex: 1 }}>
                  <ResponsiveContainer width="100%" height={Math.max(220, byEditor.length * 34 + 30)}>
                    <BarChart data={byEditor} layout="vertical" margin={{ top: 4, right: 24, bottom: 4, left: 4 }}>
                      <defs>
                        <linearGradient id="editorGreenPub" x1="0" y1="0" x2="1" y2="0">
                          <stop offset="0%"   stopColor="#0d9b6c" />
                          <stop offset="100%" stopColor="#aef5d4" />
                        </linearGradient>
                        <linearGradient id="editorGoldPub" x1="0" y1="0" x2="1" y2="0">
                          <stop offset="0%"   stopColor="#a98a3a" />
                          <stop offset="100%" stopColor="#f0e0b8" />
                        </linearGradient>
                        <linearGradient id="editorPinkPub" x1="0" y1="0" x2="1" y2="0">
                          <stop offset="0%"   stopColor="#c2185b" />
                          <stop offset="100%" stopColor="#f5a3b8" />
                        </linearGradient>
                        <filter id="editorGreenGlowPub" x="-10%" y="-100%" width="120%" height="300%">
                          <feGaussianBlur stdDeviation="2" result="blur" />
                          <feMerge>
                            <feMergeNode in="blur" />
                            <feMergeNode in="SourceGraphic" />
                          </feMerge>
                        </filter>
                      </defs>
                      <CartesianGrid stroke="rgba(255,255,255,0.04)" strokeDasharray="2 4" horizontal={false} />
                      <XAxis type="number" tick={{ fontSize: 10, fill: '#71717a' }} axisLine={false} tickLine={false} tickFormatter={(v) => `${v}×`} />
                      <YAxis dataKey="name" type="category" width={86} tick={{ fontSize: 12, fill: '#fafafa' }} axisLine={false} tickLine={false} />
                      <Tooltip content={(p) => tipFn({ active: p.active, payload: p.payload?.map(x => ({...x, value: x.payload.roas})), suffix: '× ROAS' })} cursor={false} />
                      <Bar dataKey="roas" radius={[10, 10, 10, 10]} maxBarSize={14}>
                        {byEditor.map((e, i) => {
                          const grad = e.roas >= 2.0 ? 'url(#editorGreenPub)' : e.roas >= 1.5 ? 'url(#editorGoldPub)' : 'url(#editorPinkPub)';
                          return <Cell key={i} fill={grad} filter={e.roas >= 2.0 ? 'url(#editorGreenGlowPub)' : undefined} />;
                        })}
                      </Bar>
                    </BarChart>
                  </ResponsiveContainer>
                </div>
              )}
              <div style={footer}>
                <span style={footerLabel}>Top Editor</span>
                <span style={{
                  fontSize: '12px',
                  fontWeight: 500,
                  color: topEditor && topEditor.roas >= 2.0 ? '#4ade80'
                       : topEditor && topEditor.roas >= 1.5 ? '#c9a84c'
                       : '#fafafa',
                }}>
                  {topEditor ? `${topEditor.name} · ${topEditor.roas.toFixed(2)}×` : '—'}
                </span>
              </div>
            </div>
          </div>
        );
      })()}

      <p style={{ marginTop: '20px', fontSize: '11px', color: '#3f3f46' }}>
        Data from Triple Whale · Facebook post links via Meta Graph API
      </p>
    </div>
  );
}
