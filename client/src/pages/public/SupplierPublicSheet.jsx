import { useState, useEffect, useCallback } from 'react';

// ── Helpers ──────────────────────────────────────────────────────────────────

const fmtMoney = (n) =>
  '$' +
  Number(n || 0).toLocaleString(undefined, {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  });

const todayStr = () => new Date().toISOString().slice(0, 10);

const BASE_URL = '/api/v1/kpi-system/public/cost-sheet';

// ── Main Component ───────────────────────────────────────────────────────────

export default function SupplierPublicSheet() {
  const params = new URLSearchParams(window.location.search);
  const token = params.get('token') || '';

  const [period, setPeriod] = useState('daily');
  const [date, setDate] = useState(todayStr());
  const [data, setData] = useState(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);

  const fetchData = useCallback(async () => {
    if (!token) {
      setError('Access Denied');
      setLoading(false);
      return;
    }

    setLoading(true);
    setError(null);

    try {
      const url = `${BASE_URL}?token=${encodeURIComponent(token)}&period=${period}&date=${date}`;
      const res = await fetch(url);

      if (res.status === 403) {
        setError('Access Denied');
        setData(null);
        setLoading(false);
        return;
      }

      if (!res.ok) {
        throw new Error(`Server error (${res.status})`);
      }

      const json = await res.json();
      setData(json);
    } catch (err) {
      setError(err.message || 'Failed to load data');
    } finally {
      setLoading(false);
    }
  }, [token, period, date]);

  useEffect(() => {
    fetchData();
  }, [fetchData]);

  // ── Access Denied ──────────────────────────────────────────────────────────

  if (error === 'Access Denied') {
    return (
      <div style={styles.page}>
        <div style={styles.accessDenied}>
          <div style={{ fontSize: 48, marginBottom: 16 }}>&#128274;</div>
          <h1 style={{ fontSize: 24, fontWeight: 700, marginBottom: 8, color: '#1a1a2e' }}>
            Access Denied
          </h1>
          <p style={{ color: '#666', fontSize: 14 }}>
            Invalid or expired token. Please contact Mineblock for a valid link.
          </p>
        </div>
      </div>
    );
  }

  // ── Loading ────────────────────────────────────────────────────────────────

  if (loading) {
    return (
      <div style={styles.page}>
        <div style={styles.loadingContainer}>
          <div style={styles.spinner} />
          <p style={{ color: '#666', marginTop: 16, fontSize: 14 }}>Loading cost sheet...</p>
        </div>
      </div>
    );
  }

  // ── Error ──────────────────────────────────────────────────────────────────

  if (error) {
    return (
      <div style={styles.page}>
        <div style={styles.accessDenied}>
          <h1 style={{ fontSize: 20, fontWeight: 600, color: '#c0392b', marginBottom: 8 }}>
            Error
          </h1>
          <p style={{ color: '#666', fontSize: 14 }}>{error}</p>
          <button onClick={fetchData} style={styles.retryBtn}>
            Retry
          </button>
        </div>
      </div>
    );
  }

  // ── Data ───────────────────────────────────────────────────────────────────

  const orders = data?.orders || [];
  const summary = data?.summary || {};
  const dateRange = data?.dateRange || {};

  const totalProductCost = summary.totalProductCost ?? orders.reduce((s, o) => s + (o.productCost || 0), 0);
  const totalShipping = summary.totalShipping ?? orders.reduce((s, o) => s + (o.shipping || 0), 0);
  const grandTotal = summary.grandTotal ?? totalProductCost + totalShipping;

  return (
    <div style={styles.page}>
      <div style={styles.container}>
        {/* ── Header ──────────────────────────────────────────────────── */}
        <header style={styles.header}>
          <div style={styles.headerTop}>
            <div>
              <div style={styles.logo}>
                <div style={styles.logoIcon}>M</div>
                <span style={styles.logoText}>Mineblock</span>
              </div>
              <h1 style={styles.title}>Supplier Cost Report</h1>
            </div>
            <button onClick={() => window.print()} style={styles.printBtn}>
              &#128424; Print
            </button>
          </div>

          <div style={styles.controls}>
            <div style={styles.periodGroup}>
              {['daily', 'weekly', 'monthly'].map((p) => (
                <button
                  key={p}
                  onClick={() => setPeriod(p)}
                  style={{
                    ...styles.periodBtn,
                    ...(period === p ? styles.periodBtnActive : {}),
                  }}
                >
                  {p.charAt(0).toUpperCase() + p.slice(1)}
                </button>
              ))}
            </div>
            <input
              type="date"
              value={date}
              onChange={(e) => setDate(e.target.value)}
              style={styles.dateInput}
            />
          </div>
        </header>

        {/* ── Summary Cards ───────────────────────────────────────────── */}
        <section style={styles.summaryRow}>
          <SummaryCard label="Total Product Cost" value={fmtMoney(totalProductCost)} color="#3b82f6" />
          <SummaryCard label="Total Shipping" value={fmtMoney(totalShipping)} color="#8b5cf6" />
          <SummaryCard label="Grand Total" value={fmtMoney(grandTotal)} color="#10b981" />
        </section>

        {dateRange.start && dateRange.end && (
          <p style={styles.dateRangeLabel}>
            Showing data from <strong>{dateRange.start}</strong> to <strong>{dateRange.end}</strong>
          </p>
        )}

        {/* ── Order Table ─────────────────────────────────────────────── */}
        <section style={styles.tableSection}>
          <div style={styles.tableWrapper}>
            <table style={styles.table}>
              <thead>
                <tr>
                  {['Order #', 'Date', 'Item', 'Qty', 'Country', 'Product Cost', 'Shipping', 'Total'].map(
                    (col) => (
                      <th key={col} style={styles.th}>
                        {col}
                      </th>
                    ),
                  )}
                </tr>
              </thead>
              <tbody>
                {orders.length === 0 ? (
                  <tr>
                    <td colSpan={8} style={styles.emptyRow}>
                      No orders found for this period.
                    </td>
                  </tr>
                ) : (
                  orders.map((o, i) => (
                    <tr key={o.orderNumber || i} style={i % 2 === 0 ? {} : styles.altRow}>
                      <td style={styles.td}>{o.orderNumber || '-'}</td>
                      <td style={styles.td}>{o.date || '-'}</td>
                      <td style={styles.td}>{o.item || '-'}</td>
                      <td style={{ ...styles.td, textAlign: 'right' }}>{o.quantity ?? '-'}</td>
                      <td style={styles.td}>{o.country || '-'}</td>
                      <td style={{ ...styles.td, textAlign: 'right' }}>{fmtMoney(o.productCost)}</td>
                      <td style={{ ...styles.td, textAlign: 'right' }}>{fmtMoney(o.shipping)}</td>
                      <td style={{ ...styles.td, textAlign: 'right', fontWeight: 600 }}>
                        {fmtMoney((o.productCost || 0) + (o.shipping || 0))}
                      </td>
                    </tr>
                  ))
                )}
              </tbody>
              {orders.length > 0 && (
                <tfoot>
                  <tr style={styles.footerRow}>
                    <td colSpan={5} style={{ ...styles.td, fontWeight: 700 }}>
                      Totals
                    </td>
                    <td style={{ ...styles.td, textAlign: 'right', fontWeight: 700 }}>
                      {fmtMoney(totalProductCost)}
                    </td>
                    <td style={{ ...styles.td, textAlign: 'right', fontWeight: 700 }}>
                      {fmtMoney(totalShipping)}
                    </td>
                    <td style={{ ...styles.td, textAlign: 'right', fontWeight: 700 }}>
                      {fmtMoney(grandTotal)}
                    </td>
                  </tr>
                </tfoot>
              )}
            </table>
          </div>
        </section>

        {/* ── Footer ──────────────────────────────────────────────────── */}
        <footer style={styles.footer}>
          Generated by Mineblock KPI System &middot; {new Date().toLocaleString()}
        </footer>
      </div>

      {/* Print styles injected via <style> */}
      <style>{printCSS}</style>
    </div>
  );
}

// ── Summary Card Sub-component ───────────────────────────────────────────────

function SummaryCard({ label, value, color }) {
  return (
    <div style={{ ...styles.card, borderTop: `3px solid ${color}` }}>
      <p style={styles.cardLabel}>{label}</p>
      <p style={{ ...styles.cardValue, color }}>{value}</p>
    </div>
  );
}

// ── Print CSS ────────────────────────────────────────────────────────────────

const printCSS = `
@media print {
  body { background: #fff !important; }
  button { display: none !important; }
  @page { margin: 0.75in; }
}
`;

// ── Spinner keyframes (injected once) ────────────────────────────────────────

if (typeof document !== 'undefined' && !document.getElementById('sps-spin')) {
  const style = document.createElement('style');
  style.id = 'sps-spin';
  style.textContent = `@keyframes sps-spin { to { transform: rotate(360deg); } }`;
  document.head.appendChild(style);
}

// ── Inline Styles ────────────────────────────────────────────────────────────

const styles = {
  page: {
    minHeight: '100vh',
    background: '#f8f9fb',
    fontFamily:
      '-apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, "Helvetica Neue", Arial, sans-serif',
    color: '#1a1a2e',
    padding: '24px 16px',
    boxSizing: 'border-box',
  },
  container: {
    maxWidth: 960,
    margin: '0 auto',
  },

  // Header
  header: {
    marginBottom: 24,
  },
  headerTop: {
    display: 'flex',
    justifyContent: 'space-between',
    alignItems: 'flex-start',
    flexWrap: 'wrap',
    gap: 12,
    marginBottom: 16,
  },
  logo: {
    display: 'flex',
    alignItems: 'center',
    gap: 10,
    marginBottom: 4,
  },
  logoIcon: {
    width: 36,
    height: 36,
    borderRadius: 8,
    background: 'linear-gradient(135deg, #3b82f6, #6366f1)',
    color: '#fff',
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'center',
    fontWeight: 800,
    fontSize: 18,
  },
  logoText: {
    fontSize: 20,
    fontWeight: 700,
    color: '#1a1a2e',
  },
  title: {
    fontSize: 15,
    fontWeight: 500,
    color: '#666',
    margin: '4px 0 0 0',
  },
  printBtn: {
    padding: '8px 16px',
    fontSize: 13,
    fontWeight: 600,
    border: '1px solid #ddd',
    borderRadius: 8,
    background: '#fff',
    color: '#333',
    cursor: 'pointer',
  },
  controls: {
    display: 'flex',
    alignItems: 'center',
    gap: 12,
    flexWrap: 'wrap',
  },
  periodGroup: {
    display: 'flex',
    borderRadius: 8,
    overflow: 'hidden',
    border: '1px solid #ddd',
  },
  periodBtn: {
    padding: '7px 16px',
    fontSize: 13,
    fontWeight: 500,
    border: 'none',
    background: '#fff',
    color: '#666',
    cursor: 'pointer',
    transition: 'all 0.15s',
  },
  periodBtnActive: {
    background: '#3b82f6',
    color: '#fff',
  },
  dateInput: {
    padding: '7px 12px',
    fontSize: 13,
    border: '1px solid #ddd',
    borderRadius: 8,
    background: '#fff',
    color: '#333',
    outline: 'none',
  },

  // Summary
  summaryRow: {
    display: 'grid',
    gridTemplateColumns: 'repeat(auto-fit, minmax(200px, 1fr))',
    gap: 16,
    marginBottom: 16,
  },
  card: {
    background: '#fff',
    borderRadius: 10,
    padding: '20px 20px 16px',
    boxShadow: '0 1px 3px rgba(0,0,0,0.06)',
  },
  cardLabel: {
    fontSize: 13,
    color: '#888',
    margin: '0 0 6px',
    fontWeight: 500,
  },
  cardValue: {
    fontSize: 26,
    fontWeight: 700,
    margin: 0,
  },
  dateRangeLabel: {
    fontSize: 13,
    color: '#888',
    marginBottom: 16,
  },

  // Table
  tableSection: {
    background: '#fff',
    borderRadius: 10,
    boxShadow: '0 1px 3px rgba(0,0,0,0.06)',
    overflow: 'hidden',
    marginBottom: 24,
  },
  tableWrapper: {
    overflowX: 'auto',
  },
  table: {
    width: '100%',
    borderCollapse: 'collapse',
    fontSize: 13,
  },
  th: {
    textAlign: 'left',
    padding: '12px 14px',
    fontWeight: 600,
    fontSize: 12,
    color: '#888',
    textTransform: 'uppercase',
    letterSpacing: '0.03em',
    borderBottom: '2px solid #eee',
    whiteSpace: 'nowrap',
  },
  td: {
    padding: '10px 14px',
    borderBottom: '1px solid #f0f0f0',
    whiteSpace: 'nowrap',
  },
  altRow: {
    background: '#fafbfc',
  },
  emptyRow: {
    padding: '32px 14px',
    textAlign: 'center',
    color: '#999',
  },
  footerRow: {
    background: '#f5f6f8',
    borderTop: '2px solid #ddd',
  },

  // Footer
  footer: {
    textAlign: 'center',
    fontSize: 12,
    color: '#aaa',
    padding: '8px 0',
  },

  // States
  accessDenied: {
    textAlign: 'center',
    padding: '80px 24px',
  },
  loadingContainer: {
    display: 'flex',
    flexDirection: 'column',
    alignItems: 'center',
    justifyContent: 'center',
    padding: '120px 24px',
  },
  spinner: {
    width: 36,
    height: 36,
    border: '3px solid #e0e0e0',
    borderTopColor: '#3b82f6',
    borderRadius: '50%',
    animation: 'sps-spin 0.7s linear infinite',
  },
  retryBtn: {
    marginTop: 16,
    padding: '8px 20px',
    fontSize: 13,
    fontWeight: 600,
    border: '1px solid #ddd',
    borderRadius: 8,
    background: '#fff',
    color: '#333',
    cursor: 'pointer',
  },
};
