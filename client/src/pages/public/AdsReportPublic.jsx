import { useState, useEffect } from 'react';
import { useParams } from 'react-router-dom';
import { TrendingUp, ExternalLink, AlertCircle, Loader2, Calendar } from 'lucide-react';

const fmtMoney = (n) =>
  '$' + Number(n || 0).toLocaleString(undefined, { minimumFractionDigits: 0, maximumFractionDigits: 0 });

const fmtDec = (n, d = 2) => Number(n || 0).toFixed(d);

const fmtPct = (n) => (n != null ? Number(n).toFixed(1) + '%' : '—');

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
  const [loading, setLoading] = useState(true);
  const [error,   setError]   = useState(null);
  const [data,    setData]    = useState([]);
  const [week,    setWeek]    = useState(null);

  useEffect(() => {
    if (!token) { setError('Invalid share link'); setLoading(false); return; }
    fetch(`/api/v1/ads-reporting/public?token=${encodeURIComponent(token)}`)
      .then(r => r.json())
      .then(res => {
        if (!res.ok) throw new Error(res.error || 'Failed to load');
        setData(res.data || []);
        setWeek(res.week);
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

  const weekLabel = week
    ? (() => {
        const months = ['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec'];
        const s = new Date(week.start + 'T00:00:00Z');
        const e = new Date(week.end   + 'T00:00:00Z');
        return `${months[s.getUTCMonth()]} ${s.getUTCDate()} – ${months[e.getUTCMonth()]} ${e.getUTCDate()}`;
      })()
    : '';

  return (
    <div style={S.page}>
      <div style={S.header}>
        <div>
          <div style={{ display: 'flex', alignItems: 'center', gap: '8px', marginBottom: '4px' }}>
            <TrendingUp size={18} style={{ color: '#c9a84c' }} />
            <h1 style={S.title}>Ads Reporting</h1>
          </div>
          {weekLabel && (
            <div style={S.subtitle}>
              <Calendar size={12} />
              {weekLabel}
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
          <p style={{ fontWeight: 500, color: '#a1a1aa' }}>No qualifying ads this week</p>
        </div>
      ) : (
        <div style={S.card}>
          <div style={S.tableWrap}>
            <table style={S.table}>
              <thead>
                <tr>
                  {['#','Campaign','Ad Name','Link','Spend','ROAS','PUR','CPA','AOV','NVP','Avatar','Angle'].map(h => (
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

                    <td style={S.td}>
                      <span style={{ display: 'block', maxWidth: '220px', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', fontWeight: 500 }}
                        title={row.adName}>
                        {row.adName}
                      </span>
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
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      )}

      <p style={{ marginTop: '20px', fontSize: '11px', color: '#3f3f46' }}>
        Data from Triple Whale · Facebook creative links via Meta Ads Library
      </p>
    </div>
  );
}
