import authFetch from '../../services/authFetch';
import { useCallback, useEffect, useMemo, useState } from 'react';
import { ChevronDown, ChevronsUpDown } from 'lucide-react';

/**
 * Landing pages — plain table, built to the operator's reference.
 *
 * Deliberately minimal: URL, ad count, share, longest run, actions. No
 * thumbnails, tier dots, CTA chips or icons — on the previous card layout
 * those crowded out the only three numbers anyone reads.
 */

// Matches the reference exactly. Note this is NOT the brand page's window set
// (All time / 7d / 30d / 90d / 180d): no "all time", no 7d, and it adds 60d.
const WINDOWS = [
  { value: 30,  label: 'Last 30 days' },
  { value: 60,  label: 'Last 60 days' },
  { value: 90,  label: 'Last 90 days' },
  { value: 180, label: 'Last 180 days' },
];

const PAGE_SIZES = [20, 50, 100];

function SortCaret({ active, dir }) {
  if (!active) return <ChevronsUpDown className="w-3 h-3 opacity-30 shrink-0" />;
  return <ChevronDown className={`w-3 h-3 shrink-0 transition-transform ${dir === 'asc' ? 'rotate-180' : ''}`} />;
}

export default function LandingPagesTable({ apiBaseUrl, brandId, onViewAds }) {
  const [items, setItems]     = useState([]);
  const [loading, setLoading] = useState(true);
  const [error, setError]     = useState(null);
  const [days, setDays]       = useState(30);
  const [winOpen, setWinOpen] = useState(false);
  const [sizeOpen, setSizeOpen] = useState(false);
  const [sortKey, setSortKey] = useState('count');
  const [sortDir, setSortDir] = useState('desc');
  const [page, setPage]       = useState(1);
  const [pageSize, setPageSize] = useState(20);
  const [copied, setCopied]   = useState(null);

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const params = new URLSearchParams({ type: 'landing', limit: '100' });
      if (days) params.set('days', String(days));
      const res = await authFetch(`${apiBaseUrl}/brands/${brandId}/aggregations?${params}`);
      if (!res.ok) throw new Error(`Failed to load landing pages (HTTP ${res.status})`);
      const data = await res.json();
      setItems(data.items ?? []);
      setPage(1);
    } catch (e) {
      setError(e.message);
    } finally {
      setLoading(false);
    }
  }, [apiBaseUrl, brandId, days]);

  useEffect(() => { load(); }, [load]);

  // Share of every ad in the window, not of the rows currently on screen.
  // The reference reads 77.3% for a page holding 1296 of ~1676 ads, so the
  // denominator is the whole window — paging must not move the percentages.
  const totalAds = useMemo(
    () => items.reduce((sum, it) => sum + (it.count ?? 0), 0),
    [items],
  );

  const sorted = useMemo(() => {
    const pick = (it) => (sortKey === 'days' ? (it.maxActiveDays ?? 0) : (it.count ?? 0));
    return [...items].sort((a, b) => (sortDir === 'asc' ? pick(a) - pick(b) : pick(b) - pick(a)));
  }, [items, sortKey, sortDir]);

  const pageCount = Math.max(1, Math.ceil(sorted.length / pageSize));
  const visible = sorted.slice((page - 1) * pageSize, page * pageSize);

  const toggleSort = (key) => {
    if (sortKey === key) setSortDir((d) => (d === 'desc' ? 'asc' : 'desc'));
    else { setSortKey(key); setSortDir('desc'); }
  };

  const copy = async (url) => {
    try { await navigator.clipboard.writeText(url); setCopied(url); setTimeout(() => setCopied(null), 1500); }
    catch { /* clipboard blocked — the URL is visible and selectable anyway */ }
  };

  const th = 'text-[11px] font-medium text-text-muted select-none';
  const link = 'text-[12px] text-amber-500/90 hover:text-amber-400 transition-colors whitespace-nowrap';

  return (
    <div className="flex-1 flex flex-col min-h-0 px-5 pt-4 pb-4 gap-3">
      {/* Header — title + window on the left, caption far right */}
      <div className="flex items-center justify-between gap-3 flex-wrap shrink-0">
        <div className="flex items-center gap-3">
          <h2 className="text-[15px] font-semibold text-text-primary">Landing pages</h2>
          <div className="relative">
            <button
              onClick={() => setWinOpen((o) => !o)}
              onBlur={() => setTimeout(() => setWinOpen(false), 150)}
              className="flex items-center gap-2 px-3 py-1.5 rounded-lg border border-border-default bg-bg-elevated text-[12px] text-text-primary hover:bg-bg-hover transition-colors">
              {WINDOWS.find((w) => w.value === days)?.label ?? 'Custom'}
              <ChevronDown className={`w-3 h-3 text-text-faint transition-transform ${winOpen ? 'rotate-180' : ''}`} />
            </button>
            {winOpen && (
              <div className="absolute left-0 top-full mt-1.5 w-44 rounded-xl shadow-2xl z-50 overflow-hidden py-1"
                style={{ background: '#1e1e1e', border: '1px solid #303030' }}>
                {WINDOWS.map((w) => (
                  <button key={w.value}
                    onMouseDown={() => { setDays(w.value); setWinOpen(false); }}
                    className={`w-full text-left px-3.5 py-2 text-[13px] transition-colors ${
                      days === w.value ? 'text-white bg-white/5 font-medium' : 'text-text-muted hover:bg-white/5 hover:text-white'
                    }`}>
                    {w.label}
                  </button>
                ))}
              </div>
            )}
          </div>
        </div>
        <p className="text-[12px] text-text-faint">Landing pages for ads that were live in selected timeframe</p>
      </div>

      {/* Table */}
      <div className="flex-1 min-h-0 overflow-auto rounded-xl border border-border-subtle">
        <table className="w-full border-collapse">
          <thead className="sticky top-0 z-10 bg-bg-elevated">
            <tr className="border-b border-border-subtle">
              <th className={`${th} text-left px-4 py-2.5`}>Landing page</th>
              <th className={`${th} text-left px-4 py-2.5 w-[110px]`}>
                <button onClick={() => toggleSort('count')} className="flex items-center gap-1 hover:text-text-primary transition-colors">
                  Ads <SortCaret active={sortKey === 'count'} dir={sortDir} />
                </button>
              </th>
              <th className={`${th} text-left px-4 py-2.5 w-[120px]`}>
                <button onClick={() => toggleSort('count')} className="flex items-center gap-1 hover:text-text-primary transition-colors">
                  Percentage <SortCaret active={sortKey === 'count'} dir={sortDir} />
                </button>
              </th>
              <th className={`${th} text-left px-4 py-2.5 w-[150px]`}>
                <button onClick={() => toggleSort('days')} className="flex items-center gap-1 hover:text-text-primary transition-colors">
                  Longest running <SortCaret active={sortKey === 'days'} dir={sortDir} />
                </button>
              </th>
              <th className={`${th} text-left px-4 py-2.5 w-[230px]`}>Action</th>
            </tr>
          </thead>
          <tbody>
            {loading ? (
              <tr><td colSpan={5} className="px-4 py-10 text-center text-[13px] text-text-faint">Loading…</td></tr>
            ) : error ? (
              <tr><td colSpan={5} className="px-4 py-10 text-center text-[13px] text-red-400">{error}</td></tr>
            ) : !visible.length ? (
              <tr><td colSpan={5} className="px-4 py-10 text-center text-[13px] text-text-faint">
                No landing pages for ads live in this timeframe.
              </td></tr>
            ) : visible.map((it) => {
              const url = it.key;
              const pct = totalAds ? ((it.count / totalAds) * 100).toFixed(1) : '0.0';
              return (
                <tr key={url} className="border-b border-border-subtle/60 last:border-0 hover:bg-white/[0.02] transition-colors">
                  <td className="px-4 py-2.5 text-[13px] text-text-primary max-w-0">
                    <span className="block truncate" title={url}>{url}</span>
                  </td>
                  <td className="px-4 py-2.5 text-[13px] text-text-primary tabular-nums">{it.count}</td>
                  <td className="px-4 py-2.5 text-[13px] text-text-primary tabular-nums">{pct}%</td>
                  <td className="px-4 py-2.5 text-[13px] text-text-primary tabular-nums">{it.maxActiveDays ?? 0} days</td>
                  <td className="px-4 py-2.5">
                    <div className="flex items-center gap-4">
                      <a href={url} target="_blank" rel="noreferrer" className={link}>Open URL</a>
                      <button onClick={() => copy(url)} className={link}>{copied === url ? 'Copied' : 'Copy'}</button>
                      <button onClick={() => onViewAds?.(url)} className={link}>View ads</button>
                    </div>
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>

      {/* Footer */}
      <div className="flex items-center justify-between gap-3 flex-wrap shrink-0 text-[12px] text-text-faint">
        <span>Return up to 100 results</span>
        <div className="flex items-center gap-3">
          <span>Total {sorted.length} items</span>
          <div className="flex items-center gap-1">
            <button disabled={page <= 1} onClick={() => setPage((p) => p - 1)}
              className="px-2 py-1 rounded disabled:opacity-30 hover:text-text-primary transition-colors">‹</button>
            {Array.from({ length: pageCount }, (_, i) => i + 1).slice(0, 8).map((n) => (
              <button key={n} onClick={() => setPage(n)}
                className={`min-w-[24px] px-1.5 py-1 rounded transition-colors ${
                  n === page ? 'text-amber-400 border border-amber-500/40' : 'hover:text-text-primary'
                }`}>{n}</button>
            ))}
            <button disabled={page >= pageCount} onClick={() => setPage((p) => p + 1)}
              className="px-2 py-1 rounded disabled:opacity-30 hover:text-text-primary transition-colors">›</button>
          </div>
          <div className="relative">
            <button
              onClick={() => setSizeOpen((o) => !o)}
              onBlur={() => setTimeout(() => setSizeOpen(false), 150)}
              className="flex items-center gap-1.5 px-2.5 py-1 rounded-lg border border-border-default bg-bg-elevated text-text-primary hover:bg-bg-hover transition-colors">
              {pageSize} / page
              <ChevronDown className={`w-3 h-3 text-text-faint transition-transform ${sizeOpen ? 'rotate-180' : ''}`} />
            </button>
            {sizeOpen && (
              <div className="absolute right-0 bottom-full mb-1.5 w-28 rounded-xl shadow-2xl z-50 overflow-hidden py-1"
                style={{ background: '#1e1e1e', border: '1px solid #303030' }}>
                {PAGE_SIZES.map((n) => (
                  <button key={n}
                    onMouseDown={() => { setPageSize(n); setPage(1); setSizeOpen(false); }}
                    className={`w-full text-left px-3.5 py-2 text-[13px] transition-colors ${
                      n === pageSize ? 'text-white bg-white/5 font-medium' : 'text-text-muted hover:bg-white/5 hover:text-white'
                    }`}>{n} / page</button>
                ))}
              </div>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}
