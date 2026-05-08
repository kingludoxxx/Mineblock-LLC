import { useState, useEffect } from 'react';
import { useParams } from 'react-router-dom';
import { TrendingUp, ExternalLink, AlertCircle, Loader2, Calendar } from 'lucide-react';

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
  if (roas >= 2.5) return '#4ade80';
  if (roas >= 1.6) return '#c9a84c';
  return '#f87171';
}

function Tag({ label }) {
  if (!label) return <span style={{ color: '#52525b' }}>—</span>;
  return (
    <span style={{
      display: 'inline-block',
      padding: '2px 8px',
      borderRadius: '4px',
      background: 'rgba(201,168,76,0.12)',
      color: '#e8d5a3',
      border: '1px solid rgba(201,168,76,0.2)',
      fontSize: '11px',
      fontWeight: 500,
    }}>
      {label}
    </span>
  );
}

function TagGrey({ label }) {
  if (!label) return <span style={{ color: '#52525b' }}>—</span>;
  return (
    <span style={{
      display: 'inline-block',
      padding: '2px 8px',
      borderRadius: '4px',
      background: 'rgba(255,255,255,0.04)',
      color: '#a1a1aa',
      border: '1px solid rgba(255,255,255,0.08)',
      fontSize: '11px',
      fontWeight: 500,
    }}>
      {label}
    </span>
  );
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
  const [data,        setData]        = useState([]);
  const [range,       setRange]       = useState(null);
  const [adNameWidth, setAdNameWidth] = useState(220);

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
    fetch(`/api/v1/ads-reporting/public?token=${encodeURIComponent(token)}`)
      .then(r => r.json())
      .then(res => {
        if (!res.ok) throw new Error(res.error || 'Failed to load');
        // Public share = curated "winning ads" view; backend now returns all
        // ads, so apply the historical winning filter here for shareable
        // snapshots that read like the original report.
        const all = res.data || [];
        const winners = all.filter(r => r.spend >= 100 && r.roas >= 1.6)
          .sort((a, b) => b.roas - a.roas);
        setData(winners);
        setRange(res.range || res.week || null);
      })
      .catch(err => setError(err.message))
      .finally(() => setLoading(false));
  }, [token]);

  if (loading) {
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
            <TrendingUp size={18} style={{ color: '#c9a84c' }} />
            <h1 style={S.title}>Ads Reporting</h1>
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
        <div style={S.logo}>
          <TrendingUp size={14} />
          MineBlock
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
                  {['FB Post','Spend','ROAS','PUR','CPA','AOV','NVP','Avatar','Angle','Format','Launch Date'].map(h => (
                    <th key={h} style={S.th}>{h}</th>
                  ))}
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

      <p style={{ marginTop: '20px', fontSize: '11px', color: '#3f3f46' }}>
        Data from Triple Whale · Facebook post links via Meta Graph API
      </p>
    </div>
  );
}
