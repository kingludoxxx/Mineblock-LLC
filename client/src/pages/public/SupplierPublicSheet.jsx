import { useState, useEffect, useCallback, useRef, useMemo } from 'react';
import { todayLocalStr } from '../../utils/dateUtils';

// ── Helpers ──────────────────────────────────────────────────────────────────

const fmtMoney = (n) =>
  '$' +
  Number(n || 0).toLocaleString(undefined, {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  });

const todayStr = todayLocalStr;

const BASE_URL = '/api/v1/kpi-system/public/cost-sheet';

// ── Calendar Date Picker ────────────────────────────────────────────────────

const CAL_DAYS = ['Su', 'Mo', 'Tu', 'We', 'Th', 'Fr', 'Sa'];
const CAL_MONTHS_SHORT = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
const CAL_MONTHS = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];

function calParseDate(str) {
  const [y, m, d] = (str || '').split('-').map(Number);
  return { year: y || new Date().getFullYear(), month: (m || 1) - 1, day: d || 1 };
}
function calToDateStr(y, m, d) {
  return `${y}-${String(m + 1).padStart(2, '0')}-${String(d).padStart(2, '0')}`;
}
function calDaysInMonth(y, m) { return new Date(y, m + 1, 0).getDate(); }
function calFirstDow(y, m) { return new Date(y, m, 1).getDay(); }
function calSameDay(a, b) { return a.year === b.year && a.month === b.month && a.day === b.day; }

function buildGrid(year, month) {
  const dim = calDaysInMonth(year, month);
  const fdow = calFirstDow(year, month);
  const prevDim = calDaysInMonth(year, month - 1);
  const cells = [];
  for (let i = fdow - 1; i >= 0; i--) {
    const d = prevDim - i, m = month === 0 ? 11 : month - 1, y = month === 0 ? year - 1 : year;
    cells.push({ day: d, month: m, year: y, outside: true });
  }
  for (let d = 1; d <= dim; d++) cells.push({ day: d, month, year, outside: false });
  const rem = 42 - cells.length;
  for (let d = 1; d <= rem; d++) {
    const m = month === 11 ? 0 : month + 1, y = month === 11 ? year + 1 : year;
    cells.push({ day: d, month: m, year: y, outside: true });
  }
  const weeks = [];
  for (let i = 0; i < cells.length; i += 7) weeks.push(cells.slice(i, i + 7));
  return weeks;
}

function CalendarPicker({ value, onChange, period = 'daily' }) {
  const [open, setOpen] = useState(false);
  const [pending, setPending] = useState(value);
  const ref = useRef(null);
  const init = calParseDate(value);
  const [vy, setVy] = useState(init.year);
  const [vm, setVm] = useState(init.month);
  const today = useMemo(() => {
    const t = new Date();
    return { year: t.getFullYear(), month: t.getMonth(), day: t.getDate() };
  }, []);

  useEffect(() => {
    if (!open) { setPending(value); const p = calParseDate(value); setVy(p.year); setVm(p.month); }
  }, [value, open]);

  useEffect(() => {
    if (!open) return;
    const h = (e) => { if (ref.current && !ref.current.contains(e.target)) setOpen(false); };
    const k = (e) => { if (e.key === 'Escape') setOpen(false); };
    document.addEventListener('mousedown', h);
    document.addEventListener('keydown', k);
    return () => { document.removeEventListener('mousedown', h); document.removeEventListener('keydown', k); };
  }, [open]);

  const goPrev = () => {
    if (period === 'monthly') setVy(y => y - 1);
    else setVm(m => { if (m === 0) { setVy(y => y - 1); return 11; } return m - 1; });
  };
  const goNext = () => {
    if (period === 'monthly') setVy(y => y + 1);
    else setVm(m => { if (m === 11) { setVy(y => y + 1); return 0; } return m + 1; });
  };
  const selectDay = (ds) => { setPending(ds); const p = calParseDate(ds); setVm(p.month); setVy(p.year); };
  const apply = () => { onChange(pending); setOpen(false); };
  const cancel = () => { setPending(value); const p = calParseDate(value); setVy(p.year); setVm(p.month); setOpen(false); };

  const sel = calParseDate(pending);
  const displayText = period === 'monthly'
    ? `${CAL_MONTHS_SHORT[sel.month]} ${sel.year}`
    : `${CAL_MONTHS_SHORT[sel.month]} ${sel.day}, ${sel.year}`;
  const headerTitle = period === 'monthly' ? String(vy) : `${CAL_MONTHS[vm]} ${vy}`;
  const weeks = useMemo(() => buildGrid(vy, vm), [vy, vm]);

  // Determine week row for weekly highlight
  const selInView = sel.year === vy && sel.month === vm;
  const selWeekRow = period === 'weekly' && selInView ? Math.floor((calFirstDow(vy, vm) + sel.day - 1) / 7) : -1;

  return (
    <div ref={ref} style={{ position: 'relative', display: 'inline-block' }}>
      {/* Trigger */}
      <button type="button" onClick={() => setOpen(o => !o)} style={calStyles.trigger}>
        <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="#888" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><rect x="3" y="4" width="18" height="18" rx="2" ry="2"/><line x1="16" y1="2" x2="16" y2="6"/><line x1="8" y1="2" x2="8" y2="6"/><line x1="3" y1="10" x2="21" y2="10"/></svg>
        <span>{displayText}</span>
        <svg width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="#888" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round"><polyline points="6 9 12 15 18 9"/></svg>
      </button>

      {/* Popover */}
      {open && (
        <div style={calStyles.popover}>
          {/* Nav header */}
          <div style={calStyles.navRow}>
            <button type="button" onClick={goPrev} style={calStyles.navBtn}>
              <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="#555" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><polyline points="15 18 9 12 15 6"/></svg>
            </button>
            <span style={calStyles.navTitle}>{headerTitle}</span>
            <button type="button" onClick={goNext} style={calStyles.navBtn}>
              <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="#555" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><polyline points="9 18 15 12 9 6"/></svg>
            </button>
          </div>

          <div style={calStyles.sep} />

          {/* Body */}
          <div style={{ padding: '8px 12px 4px' }}>
            {period === 'monthly' ? (
              /* Month grid */
              <div style={{ display: 'grid', gridTemplateColumns: 'repeat(3, 1fr)', gap: 6 }}>
                {CAL_MONTHS_SHORT.map((name, i) => {
                  const isSel = sel.year === vy && sel.month === i;
                  const isCur = today.year === vy && today.month === i;
                  return (
                    <button key={name} type="button" onClick={() => {
                      const maxD = calDaysInMonth(vy, i);
                      selectDay(calToDateStr(vy, i, Math.min(sel.day, maxD)));
                    }} style={{
                      ...calStyles.monthCell,
                      ...(isSel ? calStyles.monthCellSel : {}),
                      ...(isCur && !isSel ? calStyles.monthCellCur : {}),
                    }}>
                      {name}
                    </button>
                  );
                })}
              </div>
            ) : (
              <>
                {/* DOW headers */}
                <div style={{ display: 'grid', gridTemplateColumns: 'repeat(7, 1fr)', marginBottom: 4 }}>
                  {CAL_DAYS.map(d => (
                    <div key={d} style={calStyles.dowHeader}>{d}</div>
                  ))}
                </div>
                {/* Weeks */}
                <div style={{ display: 'flex', flexDirection: 'column', gap: 2 }}>
                  {weeks.map((week, wi) => (
                    <div key={wi} style={{
                      display: 'grid', gridTemplateColumns: 'repeat(7, 1fr)', borderRadius: 8,
                      background: wi === selWeekRow ? 'rgba(59,130,246,0.1)' : 'transparent',
                    }}>
                      {week.map((cell, ci) => {
                        const isToday = calSameDay(cell, today);
                        const isSel = calSameDay(cell, sel);
                        return (
                          <button key={ci} type="button"
                            onClick={() => selectDay(calToDateStr(cell.year, cell.month, cell.day))}
                            style={{
                              ...calStyles.dayCell,
                              color: isSel ? '#fff' : cell.outside ? '#bbb' : '#333',
                              background: isSel ? '#3b82f6' : 'transparent',
                              fontWeight: isSel ? 600 : 400,
                              boxShadow: isToday && !isSel ? 'inset 0 0 0 1px rgba(59,130,246,0.5)' : 'none',
                            }}
                            onMouseEnter={(e) => { if (!isSel) e.currentTarget.style.background = '#f0f0f0'; }}
                            onMouseLeave={(e) => { if (!isSel) e.currentTarget.style.background = 'transparent'; }}
                          >
                            {cell.day}
                          </button>
                        );
                      })}
                    </div>
                  ))}
                </div>
              </>
            )}
          </div>

          <div style={calStyles.sep} />

          {/* Footer */}
          <div style={calStyles.footer}>
            <button type="button" onClick={cancel} style={calStyles.cancelBtn}
              onMouseEnter={(e) => e.currentTarget.style.background = '#f0f0f0'}
              onMouseLeave={(e) => e.currentTarget.style.background = 'transparent'}
            >Cancel</button>
            <button type="button" onClick={apply} style={calStyles.applyBtn}
              onMouseEnter={(e) => e.currentTarget.style.background = '#2563eb'}
              onMouseLeave={(e) => e.currentTarget.style.background = '#3b82f6'}
            >Apply</button>
          </div>
        </div>
      )}
    </div>
  );
}

const calStyles = {
  trigger: {
    display: 'flex', alignItems: 'center', gap: 8,
    padding: '7px 12px', fontSize: 13, fontWeight: 500,
    border: '1px solid #ddd', borderRadius: 8,
    background: '#fff', color: '#333', cursor: 'pointer',
    transition: 'border-color 0.15s',
  },
  popover: {
    position: 'absolute', top: '100%', right: 0, marginTop: 8,
    width: 280, background: '#fff', border: '1px solid #e5e7eb',
    borderRadius: 12, boxShadow: '0 10px 40px rgba(0,0,0,0.12)',
    zIndex: 50, overflow: 'hidden',
  },
  navRow: {
    display: 'flex', alignItems: 'center', justifyContent: 'space-between',
    padding: '10px 12px',
  },
  navBtn: {
    width: 28, height: 28, display: 'flex', alignItems: 'center', justifyContent: 'center',
    borderRadius: '50%', border: 'none', background: 'transparent', cursor: 'pointer',
    transition: 'background 0.15s',
  },
  navTitle: {
    fontSize: 14, fontWeight: 600, color: '#3b82f6', userSelect: 'none',
  },
  sep: { borderTop: '1px solid #f0f0f0' },
  dowHeader: {
    textAlign: 'center', fontSize: 10, fontWeight: 500, color: '#999',
    padding: '6px 0', userSelect: 'none',
  },
  dayCell: {
    width: '100%', aspectRatio: '1', display: 'flex', alignItems: 'center', justifyContent: 'center',
    fontSize: 12, border: 'none', borderRadius: '50%', cursor: 'pointer',
    transition: 'all 0.15s', padding: 0,
  },
  monthCell: {
    padding: '10px 0', borderRadius: 8, fontSize: 13, fontWeight: 500,
    border: 'none', background: 'transparent', color: '#555', cursor: 'pointer',
    transition: 'all 0.15s', textAlign: 'center',
  },
  monthCellSel: { background: '#3b82f6', color: '#fff' },
  monthCellCur: { boxShadow: 'inset 0 0 0 1px rgba(59,130,246,0.5)' },
  footer: {
    display: 'flex', alignItems: 'center', justifyContent: 'flex-end', gap: 8,
    padding: '8px 12px',
  },
  cancelBtn: {
    padding: '5px 12px', fontSize: 12, fontWeight: 500, color: '#888',
    border: 'none', borderRadius: 6, background: 'transparent', cursor: 'pointer',
    transition: 'all 0.15s',
  },
  applyBtn: {
    padding: '5px 12px', fontSize: 12, fontWeight: 500, color: '#fff',
    border: 'none', borderRadius: 6, background: '#3b82f6', cursor: 'pointer',
    transition: 'all 0.15s',
  },
};

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

  const inner = data?.data || data || {};
  const rawOrders = inner?.orders || [];
  const summary = inner?.summary || {};

  // Map API fields to display fields
  const orders = rawOrders.map(o => {
    const miners = Number(o.miners || 0);
    const rigs = Number(o.rigs || 0);
    const item = miners > 0 && rigs > 0 ? `Miner Forge PRO (${miners}) + Mining Rig (${rigs})`
      : miners > 0 ? `Miner Forge PRO 2.0` : rigs > 0 ? `Mining Rig` : '-';
    const qty = miners + rigs || 1;
    const d = o.date ? new Date(o.date) : null;
    const dateStr = d ? d.toLocaleDateString('en-CA', { timeZone: 'Europe/Berlin' }) + ' ' + d.toLocaleTimeString('en-GB', { timeZone: 'Europe/Berlin', hour: '2-digit', minute: '2-digit' }) : '-';
    return { ...o, item, qty, dateStr, productCost: o.cogs || 0, total: (o.cogs || 0) + (o.shipping || 0) };
  });

  const totalProductCost = summary.totalCogs ?? orders.reduce((s, o) => s + o.productCost, 0);
  const totalShipping = summary.totalShipping ?? orders.reduce((s, o) => s + (o.shipping || 0), 0);
  const grandTotal = totalProductCost + totalShipping;

  return (
    <div style={styles.page}>
      <div style={styles.container}>
        {/* ── Header ──────────────────────────────────────────────────── */}
        <header style={styles.header}>
          <div style={styles.headerTop}>
            <div>
              <div style={styles.logo}>
                <img src="/logo-black.svg" alt="Mineblock" style={{ height: 23, width: 'auto' }} />
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
            <CalendarPicker value={date} onChange={setDate} period={period} />
          </div>
        </header>

        {/* ── Summary Cards ───────────────────────────────────────────── */}
        <section style={styles.summaryRow}>
          <SummaryCard label="Total Product Cost" value={fmtMoney(totalProductCost)} color="#3b82f6" />
          <SummaryCard label="Total Shipping" value={fmtMoney(totalShipping)} color="#8b5cf6" />
          <SummaryCard label="Grand Total" value={fmtMoney(grandTotal)} color="#10b981" />
        </section>

        {inner.start && inner.end && (
          <p style={styles.dateRangeLabel}>
            Showing data from <strong>{inner.start}</strong> to <strong>{inner.end}</strong>
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
                      <td style={styles.td}>#{o.orderNumber || '-'}</td>
                      <td style={styles.td}>{o.dateStr || '-'}</td>
                      <td style={styles.td}>{o.item || '-'}</td>
                      <td style={{ ...styles.td, textAlign: 'right' }}>{o.qty}</td>
                      <td style={styles.td}>{o.country || '-'}</td>
                      <td style={{ ...styles.td, textAlign: 'right' }}>{fmtMoney(o.productCost)}</td>
                      <td style={{ ...styles.td, textAlign: 'right' }}>{fmtMoney(o.shipping)}</td>
                      <td style={{ ...styles.td, textAlign: 'right', fontWeight: 600 }}>
                        {fmtMoney(o.total)}
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
