import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  X,
  Loader2,
  RefreshCw,
  Search,
  CheckCircle2,
  AlertCircle,
  TrendingUp,
  LineChart,
  Video as VideoIcon,
  Play,
  ChevronDown,
  Sparkles,
} from 'lucide-react';
import api from '../../../services/api';

// Only active videos — paused/deleted ads are never useful for iteration.
const WINDOWS = [7, 30, 90];
const SORTS = [
  { key: 'spend',       label: 'Spend ↓' },
  { key: 'roas',        label: 'ROAS ↓' },
  { key: 'revenue',     label: 'Revenue ↓' },
  { key: 'cpa',         label: 'CPA ↑' },
  { key: 'ctr',         label: 'CTR ↓' },
  { key: 'impressions', label: 'Impressions ↓' },
];

function timeAgo(iso) {
  if (!iso) return '';
  const t = new Date(iso).getTime();
  if (Number.isNaN(t)) return '';
  const secs = Math.max(1, Math.round((Date.now() - t) / 1000));
  if (secs < 60) return `${secs}s ago`;
  const m = Math.round(secs / 60); if (m < 60) return `${m}m ago`;
  const h = Math.round(m / 60);    if (h < 24) return `${h}h ago`;
  return `${Math.round(h / 24)}d ago`;
}

function fmt$(n) {
  if (n == null) return '$0';
  const abs = Math.abs(n);
  if (abs >= 1000) return `$${(n / 1000).toFixed(1)}k`;
  return `$${Math.round(n)}`;
}

function fmtRoas(n) { return `${(n || 0).toFixed(2)}×`; }
function roasColor(n) {
  if (n >= 2)    return { color: '#10b981', bg: 'rgba(16,185,129,0.1)',  border: 'rgba(16,185,129,0.3)' };
  if (n >= 1.5)  return { color: '#d4b55a', bg: 'rgba(201,168,76,0.1)',  border: 'rgba(201,168,76,0.3)' };
  if (n >= 1)    return { color: '#f59e0b', bg: 'rgba(245,158,11,0.1)',  border: 'rgba(245,158,11,0.3)' };
  return         { color: '#ef4444', bg: 'rgba(239,68,68,0.1)',          border: 'rgba(239,68,68,0.3)' };
}

export default function MetaVideoImportModal({ open, onClose, onImported }) {
  // Filters
  const [accounts, setAccounts]       = useState([]);
  const [selectedAccts, setSelected]  = useState(new Set());
  const [window, setWindow]           = useState(30);
  const [sort, setSort]               = useState('spend');
  const [minRoas, setMinRoas]         = useState('');
  const [minSpend, setMinSpend]       = useState('');
  const [search, setSearch]           = useState('');

  // Data
  const [ads, setAds]                 = useState([]);
  const [total, setTotal]             = useState(0);
  const [page, setPage]               = useState(1);
  const [limit]                       = useState(30);
  const [lastSync, setLastSync]       = useState(null);

  // UI
  const [loading, setLoading]             = useState(false);
  const [accountsLoading, setAcctsLoading] = useState(false);
  const [accountsError, setAccountsError] = useState(null);  // separate from ads error
  const [error, setError]                 = useState(null);
  const [importing, setImporting]         = useState(false);
  const [importedIds, setImportedIds]     = useState(new Set());
  const [selectedAdIds, setSelectedAdIds] = useState(new Set());

  const searchTimer  = useRef(null);
  const roasTimer    = useRef(null);
  const spendTimer   = useRef(null);
  const [debouncedSearch, setDebouncedSearch] = useState('');
  const [debouncedRoas,  setDebouncedRoas]  = useState('');
  const [debouncedSpend, setDebouncedSpend] = useState('');

  // ── Fetchers ──────────────────────────────────────────────────────────
  const fetchAccounts = useCallback(async () => {
    setAcctsLoading(true);
    setAccountsError(null);
    try {
      const { data } = await api.get('/brief-pipeline/meta-video-ads/accounts', {
        params: { window },
      });
      setAccounts(data.accounts || []);
      setLastSync(data.last_sync || null);
    } catch (err) {
      setAccountsError(err.response?.data?.error?.message || err.message || 'Failed to load accounts');
    } finally {
      setAcctsLoading(false);
    }
  }, [window]);

  const fetchAds = useCallback(async (resetPage = false) => {
    setLoading(true);
    setError(null);
    try {
      const params = {
        accounts: [...selectedAccts].join(','),
        status: 'active',
        window,
        sort,
        min_roas: parseFloat(debouncedRoas) || 0,
        min_spend: parseFloat(debouncedSpend) || 0,
        search: debouncedSearch || '',
        page: resetPage ? 1 : page,
        limit,
      };
      const { data } = await api.get('/brief-pipeline/meta-video-ads', { params });
      const list = data.ads || [];
      if (resetPage) {
        setAds(list);
        setPage(1);
      } else {
        setAds(prev => [...prev, ...list]);
      }
      setTotal(data.total || 0);
    } catch (err) {
      setError(err.response?.data?.error?.message || err.message || 'Failed to load ads');
    } finally {
      setLoading(false);
    }
  }, [selectedAccts, window, sort, debouncedRoas, debouncedSpend, debouncedSearch, page, limit]);

  // ── Effects ───────────────────────────────────────────────────────────
  useEffect(() => {
    if (!open) {
      setSelectedAdIds(new Set());
      setImportedIds(new Set());
      setAds([]);
      setTotal(0);
      setPage(1);
      setSearch('');
      setDebouncedSearch('');
      setDebouncedRoas('');
      setDebouncedSpend('');
      setError(null);
      setAccountsError(null);
      return;
    }
    fetchAccounts();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open]);

  // Re-fetch accounts when window changes (spend totals are window-scoped)
  useEffect(() => {
    if (!open) return;
    fetchAccounts();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [window]);

  // Debounce search
  useEffect(() => {
    if (searchTimer.current) clearTimeout(searchTimer.current);
    searchTimer.current = setTimeout(() => setDebouncedSearch(search), 250);
    return () => { if (searchTimer.current) clearTimeout(searchTimer.current); };
  }, [search]);

  // Debounce minRoas / minSpend inputs (prevent a fetch per keystroke)
  useEffect(() => {
    if (roasTimer.current) clearTimeout(roasTimer.current);
    roasTimer.current = setTimeout(() => setDebouncedRoas(minRoas), 400);
    return () => { if (roasTimer.current) clearTimeout(roasTimer.current); };
  }, [minRoas]);

  useEffect(() => {
    if (spendTimer.current) clearTimeout(spendTimer.current);
    spendTimer.current = setTimeout(() => setDebouncedSpend(minSpend), 400);
    return () => { if (spendTimer.current) clearTimeout(spendTimer.current); };
  }, [minSpend]);

  // Fetch ads when filters change (reset to page 1)
  useEffect(() => {
    if (!open) return;
    fetchAds(true);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, selectedAccts, window, sort, debouncedRoas, debouncedSpend, debouncedSearch]);

  // Fetch next page when page > 1 (load more)
  useEffect(() => {
    if (!open || page === 1) return;
    fetchAds(false);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [page]);

  // Escape closes
  useEffect(() => {
    if (!open) return;
    const fn = (e) => { if (e.key === 'Escape') onClose(); };
    document.addEventListener('keydown', fn);
    return () => document.removeEventListener('keydown', fn);
  }, [open, onClose]);

  // ── Handlers ──────────────────────────────────────────────────────────
  const toggleAccount = (id) => {
    setSelected(prev => {
      const next = new Set(prev);
      if (id === 'ALL') {
        // "All" = select all when none/some selected; clear when all selected
        const allSel = accounts.length > 0 && accounts.every(a => next.has(a.id));
        if (allSel) next.clear();
        else accounts.forEach(a => next.add(a.id));
      } else {
        if (next.has(id)) next.delete(id);
        else next.add(id);
      }
      return next;
    });
  };

  const toggleAd = (creativeId) => {
    setSelectedAdIds(prev => {
      const next = new Set(prev);
      if (next.has(creativeId)) next.delete(creativeId);
      else next.add(creativeId);
      return next;
    });
  };

  const selectAllVisible = () => {
    setSelectedAdIds(prev => {
      const next = new Set(prev);
      ads.filter(a => !a.already_imported && !importedIds.has(a.creative_id))
         .forEach(a => next.add(a.creative_id));
      return next;
    });
  };

  const clearSelection = () => setSelectedAdIds(new Set());

  const handleImport = async () => {
    if (selectedAdIds.size === 0 || importing) return;
    setImporting(true);
    setError(null);
    try {
      const { data } = await api.post('/brief-pipeline/references/import-meta', {
        creativeIds: [...selectedAdIds],
      });
      const imported = data.imported || [];
      const newlyImported = new Set([...importedIds, ...imported.map(x => {
        const ad = ads.find(a => a.ad_id === x.ad_id);
        return ad?.creative_id || x.ad_id;
      })]);
      setImportedIds(newlyImported);
      setSelectedAdIds(new Set());
      if (onImported) onImported(imported);
      // Only close if at least one row was actually inserted
      if (imported.length > 0) setTimeout(() => onClose(), 600);
      else setError(`Import returned 0 results — no matching video rows found in the database`);
    } catch (err) {
      setError(err.response?.data?.error?.message || err.message || 'Import failed');
    } finally {
      setImporting(false);
    }
  };

  const handleRefresh = async () => {
    await fetchAccounts();
    await fetchAds(true);
  };

  const allSelected = accounts.length > 0 && accounts.every(a => selectedAccts.has(a.id));
  const hasMore = ads.length < total;

  if (!open) return null;

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center p-4 sm:p-6">
      <div className="absolute inset-0 bg-black/70 backdrop-blur-sm" onClick={onClose} />

      <div
        className="relative w-full max-w-6xl h-[88vh] bg-[#0a0a0a] border border-white/[0.08] rounded-xl shadow-2xl flex flex-col overflow-hidden"
        onClick={(e) => e.stopPropagation()}
      >
        {/* Header */}
        <div className="px-5 py-4 border-b border-white/[0.06] shrink-0">
          <div className="flex items-start justify-between">
            <div>
              <div className="flex items-center gap-3 mb-1">
                <TrendingUp className="w-4 h-4 text-sky-400" />
                <h2 className="text-sm font-mono font-semibold text-white tracking-[0.18em] uppercase">
                  Import Active Ads
                </h2>
                <span className="inline-flex items-center gap-1.5 px-2 py-0.5 rounded text-[10px] font-mono uppercase tracking-wider border border-sky-500/30 bg-sky-500/10 text-sky-300">
                  $ Triple Whale
                </span>
                <span className="inline-flex items-center gap-1.5 px-2 py-0.5 rounded text-[10px] font-mono uppercase tracking-wider border border-white/[0.08] bg-white/[0.04] text-zinc-300">
                  📹 Videos Only
                </span>
                {lastSync && (
                  <span className="text-[10px] font-mono text-zinc-500">
                    Synced {timeAgo(lastSync)}
                  </span>
                )}
              </div>
              <p className="text-[11px] text-zinc-500 leading-relaxed max-w-3xl">
                Active video creatives pulled from Triple Whale's attribution warehouse —
                true 7d_click revenue, ROAS &amp; CPA. Multi-select accounts; static creatives
                are filtered server-side.
              </p>
            </div>
            <button
              type="button"
              onClick={onClose}
              className="p-1.5 rounded-md text-zinc-400 hover:text-white hover:bg-white/[0.06] transition-colors cursor-pointer"
              title="Close (Esc)"
            >
              <X className="w-4 h-4" />
            </button>
          </div>
        </div>

        {/* Filters */}
        <div className="px-5 py-3 border-b border-white/[0.05] shrink-0 space-y-3">
          {/* Accounts */}
          <div>
            <div className="text-[10px] font-mono uppercase tracking-[0.15em] text-zinc-500 mb-1.5">
              Accounts {accountsLoading && <Loader2 className="inline w-2.5 h-2.5 animate-spin ml-1" />}
            </div>
            <div className="flex flex-wrap gap-1.5">
              <button
                type="button"
                onClick={() => toggleAccount('ALL')}
                className={`inline-flex items-center gap-1.5 px-2.5 py-1 text-[10px] font-mono uppercase tracking-wider rounded-md border transition-colors cursor-pointer ${
                  allSelected ? 'bg-sky-500/15 border-sky-500/40 text-sky-200' : 'bg-white/[0.02] border-white/[0.06] text-zinc-400 hover:bg-white/[0.04]'
                }`}
              >
                All
              </button>
              {accounts.map(a => {
                const active = selectedAccts.has(a.id);
                return (
                  <button
                    key={a.id}
                    type="button"
                    onClick={() => toggleAccount(a.id)}
                    className={`inline-flex items-center gap-1.5 px-2.5 py-1 text-[10px] font-mono uppercase tracking-wider rounded-md border transition-colors cursor-pointer ${
                      active ? 'bg-sky-500/15 border-sky-500/40 text-sky-200' : 'bg-white/[0.02] border-white/[0.06] text-zinc-400 hover:bg-white/[0.04]'
                    }`}
                    title={a.name}
                  >
                    {a.name.length > 24 ? a.name.slice(0, 24) + '…' : a.name}
                    {a.spend > 0 && (
                      <span className="text-[9px] text-zinc-500">{fmt$(a.spend)}</span>
                    )}
                  </button>
                );
              })}
            </div>
          </div>

          {/* Row of pill groups */}
          <div className="flex flex-wrap items-end gap-4">
            {/* Window */}
            <div>
              <div className="text-[10px] font-mono uppercase tracking-[0.15em] text-zinc-500 mb-1">Window</div>
              <div className="flex">
                {WINDOWS.map(w => (
                  <button
                    key={w}
                    type="button"
                    onClick={() => setWindow(w)}
                    className={`px-2.5 py-1 text-[10px] font-mono uppercase tracking-wider border transition-colors cursor-pointer first:rounded-l-md last:rounded-r-md ${
                      window === w ? 'bg-sky-500/15 border-sky-500/40 text-sky-200' : 'bg-white/[0.02] border-white/[0.06] text-zinc-400 hover:bg-white/[0.04]'
                    }`}
                  >
                    {w}D
                  </button>
                ))}
              </div>
            </div>

            {/* Sort */}
            <div>
              <div className="text-[10px] font-mono uppercase tracking-[0.15em] text-zinc-500 mb-1">Sort</div>
              <div className="relative">
                <select
                  value={sort}
                  onChange={e => setSort(e.target.value)}
                  className="appearance-none bg-white/[0.02] border border-white/[0.06] rounded-md pl-2.5 pr-8 py-1 text-[11px] font-mono text-zinc-300 focus:outline-none focus:border-sky-500/40 cursor-pointer"
                >
                  {SORTS.map(s => <option key={s.key} value={s.key}>{s.label}</option>)}
                </select>
                <ChevronDown className="absolute right-2 top-1/2 -translate-y-1/2 w-3 h-3 text-zinc-500 pointer-events-none" />
              </div>
            </div>

            {/* Refresh */}
            <div className="ml-auto">
              <button
                type="button"
                onClick={handleRefresh}
                disabled={loading || accountsLoading}
                className="inline-flex items-center gap-1.5 px-3 py-1 text-[10px] font-mono uppercase tracking-wider rounded-md border border-white/[0.08] bg-white/[0.02] text-zinc-300 hover:bg-white/[0.04] transition-colors cursor-pointer disabled:opacity-40"
              >
                {loading || accountsLoading ? <Loader2 className="w-3 h-3 animate-spin" /> : <RefreshCw className="w-3 h-3" />}
                Refresh
              </button>
            </div>
          </div>

          {/* Inputs row */}
          <div className="grid grid-cols-3 gap-3">
            <div>
              <div className="text-[10px] font-mono uppercase tracking-[0.15em] text-zinc-500 mb-1">ROAS ≥</div>
              <input
                type="number"
                step="0.1"
                value={minRoas}
                onChange={e => setMinRoas(e.target.value)}
                placeholder="0"
                className="w-full bg-white/[0.02] border border-white/[0.06] rounded-md px-2.5 py-1 text-xs text-zinc-300 placeholder:text-zinc-600 focus:outline-none focus:border-sky-500/40"
              />
            </div>
            <div>
              <div className="text-[10px] font-mono uppercase tracking-[0.15em] text-zinc-500 mb-1">Spend ≥ $</div>
              <input
                type="number"
                step="100"
                value={minSpend}
                onChange={e => setMinSpend(e.target.value)}
                placeholder="0"
                className="w-full bg-white/[0.02] border border-white/[0.06] rounded-md px-2.5 py-1 text-xs text-zinc-300 placeholder:text-zinc-600 focus:outline-none focus:border-sky-500/40"
              />
            </div>
            <div>
              <div className="text-[10px] font-mono uppercase tracking-[0.15em] text-zinc-500 mb-1">Search</div>
              <div className="relative">
                <Search className="absolute left-2 top-1/2 -translate-y-1/2 w-3 h-3 text-zinc-500" />
                <input
                  type="text"
                  value={search}
                  onChange={e => setSearch(e.target.value)}
                  placeholder="name or ad id"
                  className="w-full bg-white/[0.02] border border-white/[0.06] rounded-md pl-7 pr-2.5 py-1 text-xs text-zinc-300 placeholder:text-zinc-600 focus:outline-none focus:border-sky-500/40"
                />
              </div>
            </div>
          </div>

          {accountsError && (
            <div className="flex items-start gap-2 text-xs text-amber-300 bg-amber-500/10 border border-amber-500/25 rounded-md p-2.5">
              <AlertCircle className="w-3.5 h-3.5 shrink-0 mt-0.5" />
              <span>Accounts: {accountsError}</span>
            </div>
          )}
          {error && (
            <div className="flex items-start gap-2 text-xs text-red-300 bg-red-500/10 border border-red-500/25 rounded-md p-2.5">
              <AlertCircle className="w-3.5 h-3.5 shrink-0 mt-0.5" />
              <span>{error}</span>
            </div>
          )}
        </div>

        {/* Ad grid */}
        <div className="flex-1 overflow-y-auto p-5 min-h-0">
          {loading && ads.length === 0 ? (
            <div className="grid grid-cols-3 gap-4">
              {[0,1,2,3,4,5].map(i => (
                <div key={i} className="aspect-[9/16] bg-white/[0.02] rounded-lg border border-white/[0.04] animate-pulse" />
              ))}
            </div>
          ) : ads.length === 0 ? (
            // Distinguish "no data ever synced" from "filters returned 0"
            (accounts.length === 0 && !accountsLoading) ? (
              <div className="flex flex-col items-center justify-center py-16 text-center max-w-md mx-auto px-6">
                <VideoIcon className="w-8 h-8 text-zinc-700 mb-3" />
                <div className="text-sm text-zinc-300 font-medium mb-1.5">
                  No video creatives synced from Triple Whale yet
                </div>
                <div className="text-xs text-zinc-500 leading-relaxed">
                  Triple Whale is currently syncing only image creatives into
                  Mineblock. Video sync needs to be enabled in your TW account
                  settings before this list populates.
                </div>
              </div>
            ) : (
              <div className="flex flex-col items-center justify-center py-16 text-center">
                <VideoIcon className="w-8 h-8 text-zinc-700 mb-2" />
                <div className="text-xs text-zinc-500">
                  No video ads match these filters.
                </div>
                <div className="text-[10px] text-zinc-600 mt-1.5">
                  Try widening the window, dropping ROAS ≥, or switching to Active + Paused.
                </div>
              </div>
            )
          ) : (
            <div className="grid grid-cols-3 gap-4">
              {ads.map(ad => {
                const imported  = ad.already_imported || importedIds.has(ad.creative_id);
                const selected  = selectedAdIds.has(ad.creative_id);
                const roasC     = roasColor(ad.roas);
                return (
                  <button
                    key={ad.creative_id}
                    type="button"
                    onClick={() => !imported && toggleAd(ad.creative_id)}
                    disabled={imported}
                    className={`relative text-left rounded-lg border overflow-hidden transition-all cursor-pointer disabled:cursor-not-allowed ${
                      selected
                        ? 'border-sky-500/60 ring-2 ring-sky-500/30 bg-sky-500/[0.04]'
                        : imported
                          ? 'border-emerald-500/30 bg-emerald-500/[0.04] opacity-70'
                          : 'border-white/[0.06] bg-white/[0.02] hover:border-white/[0.12] hover:bg-white/[0.04]'
                    }`}
                  >
                    {/* AUTO badge only — all cards are active by definition */}
                    {ad.auto_detected && (
                      <div className="absolute top-2 left-2 z-10">
                        <span className="inline-flex items-center px-1.5 py-0.5 rounded text-[9px] font-mono font-semibold uppercase tracking-wider bg-violet-500/15 border border-violet-500/40 text-violet-300">
                          Auto
                        </span>
                      </div>
                    )}

                    {/* Imported overlay */}
                    {imported && (
                      <div className="absolute top-2 right-2 z-10 inline-flex items-center gap-1 px-1.5 py-0.5 rounded text-[9px] font-mono font-semibold uppercase tracking-wider bg-emerald-500/15 border border-emerald-500/40 text-emerald-300">
                        <CheckCircle2 className="w-2.5 h-2.5" />
                        Imported
                      </div>
                    )}

                    {/* Thumbnail */}
                    <div className="relative aspect-[9/12] bg-black/40 overflow-hidden">
                      {ad.thumbnail_url ? (
                        <img
                          src={ad.thumbnail_url}
                          alt=""
                          className="w-full h-full object-cover"
                          onError={(e) => { e.currentTarget.style.display = 'none'; }}
                        />
                      ) : (
                        <div className="w-full h-full flex items-center justify-center">
                          <Play className="w-6 h-6 text-zinc-700" />
                        </div>
                      )}
                    </div>

                    {/* Footer */}
                    <div className="p-2.5 space-y-1.5">
                      <div className="text-[11px] text-zinc-300 font-mono leading-snug line-clamp-1">
                        {ad.ad_name || ad.creative_id}
                      </div>
                      <div className="flex items-center justify-between gap-2 flex-wrap">
                        <span
                          className="inline-flex items-center gap-1 px-1.5 py-0.5 rounded text-[10px] font-mono font-semibold border"
                          style={{ color: roasC.color, borderColor: roasC.border, background: roasC.bg }}
                        >
                          <LineChart className="w-2.5 h-2.5" />
                          {fmtRoas(ad.roas)}
                        </span>
                        <span className="text-[10px] font-mono text-zinc-400">{fmt$(ad.spend)}</span>
                      </div>
                      <div className="text-[9px] font-mono text-zinc-500">
                        Rev {fmt$(ad.revenue)} · CPA {fmt$(ad.cpa)} · CTR {(ad.ctr || 0).toFixed(1)}%
                      </div>
                      <div className="text-[9px] font-mono text-zinc-600">
                        {(ad.impressions || 0).toLocaleString()} imp · {ad.days_active}d
                      </div>
                    </div>
                  </button>
                );
              })}
            </div>
          )}

          {/* Load More */}
          {hasMore && !loading && ads.length > 0 && (
            <div className="flex justify-center pt-4 pb-2">
              <button
                type="button"
                onClick={() => setPage(p => p + 1)}
                className="px-4 py-2 text-[11px] font-mono uppercase tracking-wider rounded-md border border-white/[0.08] bg-white/[0.02] text-zinc-300 hover:bg-white/[0.04] transition-colors cursor-pointer"
              >
                Load More ({total - ads.length} remaining)
              </button>
            </div>
          )}
          {loading && ads.length > 0 && (
            <div className="flex justify-center pt-4 pb-2">
              <Loader2 className="w-4 h-4 animate-spin text-zinc-500" />
            </div>
          )}
        </div>

        {/* Footer */}
        <div className="px-5 py-3 border-t border-white/[0.06] shrink-0 flex items-center justify-between gap-3">
          <div className="text-[11px] font-mono text-zinc-500">
            {total > 0 ? `${total} ads` : ''} {selectedAdIds.size > 0 && <span className="text-sky-300 ml-2">· {selectedAdIds.size} selected</span>}
          </div>
          <div className="flex items-center gap-2">
            <button
              type="button"
              onClick={selectAllVisible}
              disabled={ads.length === 0}
              className="px-3 py-1.5 text-[11px] font-mono uppercase tracking-wider rounded-md border border-white/[0.08] bg-white/[0.02] text-zinc-300 hover:bg-white/[0.04] transition-colors cursor-pointer disabled:opacity-40"
            >
              Select All
            </button>
            {selectedAdIds.size > 0 && (
              <button
                type="button"
                onClick={clearSelection}
                className="px-3 py-1.5 text-[11px] font-mono uppercase tracking-wider rounded-md text-zinc-400 hover:text-white transition-colors cursor-pointer"
              >
                Clear
              </button>
            )}
            <button
              type="button"
              onClick={handleImport}
              disabled={selectedAdIds.size === 0 || importing}
              className="inline-flex items-center gap-2 px-4 py-2 text-xs font-mono font-semibold uppercase tracking-wider rounded-md transition-all cursor-pointer disabled:opacity-40 disabled:cursor-not-allowed"
              style={{
                background: 'linear-gradient(135deg, #0ea5e9, #38bdf8)',
                color: '#0a0a0a',
                boxShadow: '0 0 16px rgba(14,165,233,0.25)',
              }}
            >
              {importing ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <Sparkles className="w-3.5 h-3.5" />}
              Import {selectedAdIds.size > 0 ? `(${selectedAdIds.size})` : ''}
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}
