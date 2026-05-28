import { useEffect, useRef, useState, useCallback, useMemo } from 'react';
import { createPortal } from 'react-dom';
import { X, Loader2, Search, RefreshCw, TrendingUp, Check, DollarSign } from 'lucide-react';
import api from '../../../services/api';

const STATUSES = [
  { key: 'active',        label: 'Active' },
  { key: 'active+paused', label: 'Active + Paused' },
  { key: 'all',           label: 'All' },
];
const WINDOWS = [7, 30, 90];
const SORTS = [
  { key: 'spend',   label: 'Spend' },
  { key: 'revenue', label: 'Revenue' },
  { key: 'roas',    label: 'ROAS' },
  { key: 'cpa',     label: 'CPA' },
];

function fmtMoney(n) {
  const num = Number(n) || 0;
  if (num >= 1000) return `$${(num / 1000).toFixed(1)}k`;
  return `$${num.toFixed(0)}`;
}

function timeAgo(iso) {
  if (!iso) return '—';
  const ms = Date.now() - new Date(iso).getTime();
  if (ms < 0) return 'now';
  const sec = Math.floor(ms / 1000);
  if (sec < 60) return `${sec}s ago`;
  const min = Math.floor(sec / 60);
  if (min < 60) return `${min}m ago`;
  const hr = Math.floor(min / 60);
  if (hr < 24) return `${hr}h ago`;
  return `${Math.floor(hr / 24)}d ago`;
}

function useDebounced(value, delay = 300) {
  const [v, setV] = useState(value);
  useEffect(() => {
    const t = setTimeout(() => setV(value), delay);
    return () => clearTimeout(t);
  }, [value, delay]);
  return v;
}

export function MetaImportModal({ onClose, onImported }) {
  const [accounts, setAccounts] = useState([]);
  const [selectedAccounts, setSelectedAccounts] = useState(new Set());
  const [status, setStatus] = useState('active');
  const [windowDays, setWindowDays] = useState(30);
  const [sort, setSort] = useState('spend');
  const [minRoas, setMinRoas] = useState(0);
  const [minSpend, setMinSpend] = useState(0);
  const [search, setSearch] = useState('');
  const debouncedSearch = useDebounced(search, 300);
  const [ads, setAds] = useState([]);
  const [loadingAds, setLoadingAds] = useState(false);
  const [error, setError] = useState(null);
  const [selected, setSelected] = useState(new Set());
  const [importing, setImporting] = useState(false);
  const [syncStatus, setSyncStatus] = useState('idle'); // idle | pending | fresh
  const [lastSync, setLastSync] = useState(null);

  const loadAccounts = useCallback(async () => {
    try {
      const res = await api.get('/statics-generation/meta-ads/accounts');
      const list = res.data?.data || [];
      setAccounts(list);
      setSelectedAccounts(prev => prev.size === 0 ? new Set(list.map(a => a.ad_account_id)) : prev);
      setSyncStatus(res.data?.synced || 'fresh');
      setLastSync(res.data?.last_sync || null);
      return res.data?.synced;
    } catch (err) {
      setError(err.response?.data?.error?.message || err.message);
      return 'error';
    }
  }, []);

  // On open: load accounts once. If the backend reports 'pending' (a backfill
  // or stale-data sync was kicked off), poll every 4s until it's fresh.
  useEffect(() => {
    let cancelled = false;
    let pollTimer = null;
    (async () => {
      const status = await loadAccounts();
      if (cancelled) return;
      if (status === 'pending') {
        const poll = async () => {
          if (cancelled) return;
          const s = await loadAccounts();
          if (cancelled) return;
          if (s === 'pending') {
            pollTimer = setTimeout(poll, 4000);
          } else {
            // sync finished — refresh the ad grid too
            loadAdsRef.current?.();
          }
        };
        pollTimer = setTimeout(poll, 4000);
      }
    })();
    return () => {
      cancelled = true;
      if (pollTimer) clearTimeout(pollTimer);
    };
  }, [loadAccounts]);

  // Explicit "Force refresh" — POST /meta-ads/refresh (awaits the sync), then
  // reload both accounts and ads.
  const forceRefresh = useCallback(async () => {
    setSyncStatus('pending');
    setError(null);
    try {
      await api.post('/statics-generation/meta-ads/refresh');
    } catch (err) {
      // Rate-limited or no CRON_SECRET — fall through and just reload anyway
      console.warn('Refresh request rejected:', err.response?.data || err.message);
    }
    await loadAccounts();
    loadAdsRef.current?.();
  }, [loadAccounts]);

  // forward-ref so loadAds (defined below) can be invoked from the open-effect
  const loadAdsRef = useRef(null);

  const loadAds = useCallback(async () => {
    setLoadingAds(true);
    setError(null);
    try {
      const res = await api.get('/statics-generation/meta-ads/ads', {
        params: {
          accounts: Array.from(selectedAccounts).join(','),
          status,
          window: windowDays,
          sort,
          min_roas: minRoas,
          min_spend: minSpend,
          search: debouncedSearch || undefined,
        },
      });
      setAds(res.data?.data || []);
      setSelected(new Set());
    } catch (err) {
      setError(err.response?.data?.error?.message || err.message);
    } finally {
      setLoadingAds(false);
    }
  }, [selectedAccounts, status, windowDays, sort, minRoas, minSpend, debouncedSearch]);

  useEffect(() => { loadAds(); }, [loadAds]);
  useEffect(() => { loadAdsRef.current = loadAds; }, [loadAds]);

  const toggleAccount = (id) => {
    setSelectedAccounts(prev => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id); else next.add(id);
      return next;
    });
  };

  const toggleAll = () => {
    if (selectedAccounts.size === accounts.length) setSelectedAccounts(new Set());
    else setSelectedAccounts(new Set(accounts.map(a => a.ad_account_id)));
  };

  const selectableAds = useMemo(() => ads.filter(a => !a.already_imported), [ads]);

  const toggleSelect = (id) => {
    setSelected(prev => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id); else next.add(id);
      return next;
    });
  };

  const selectAll = () => {
    if (selected.size === selectableAds.length) setSelected(new Set());
    else setSelected(new Set(selectableAds.map(a => a.creative_id)));
  };

  const submit = async () => {
    if (selected.size === 0) return;
    setImporting(true);
    setError(null);
    try {
      const res = await api.post('/statics-generation/meta-ads/import', {
        creative_ids: Array.from(selected),
      });
      const data = res.data?.data || {};
      onImported?.(data);
    } catch (err) {
      setError(err.response?.data?.error?.message || err.message);
    } finally {
      setImporting(false);
    }
  };

  return createPortal(
    <>
      <div className="fixed inset-0 bg-black/70 z-[9998]" onClick={onClose} />
      <div className="fixed inset-y-0 right-0 w-full max-w-4xl bg-bg-card border-l border-border-subtle z-[9999] flex flex-col animate-slide-in-right">
        {/* Header */}
        <div className="flex items-center justify-between p-5 border-b border-white/[0.06]">
          <div>
            <h2 className="text-sm font-mono font-semibold text-white uppercase tracking-wider flex items-center gap-2">
              <TrendingUp className="w-4 h-4 text-cyan-300" />
              Import Active Ads
              <span className="ml-1 inline-flex items-center gap-1 text-[9px] font-mono uppercase bg-cyan-500/10 border border-cyan-500/30 text-cyan-300 px-1.5 py-0.5 rounded">
                <DollarSign className="w-2.5 h-2.5" /> Triple Whale
              </span>
              <span className="text-[9px] font-mono uppercase bg-white/[0.04] border border-white/[0.08] text-zinc-300 px-1.5 py-0.5 rounded">Images Only</span>
              {syncStatus === 'pending' && (
                <span className="text-[9px] font-mono uppercase bg-amber-500/10 border border-amber-500/30 text-amber-300 px-1.5 py-0.5 rounded inline-flex items-center gap-1">
                  <Loader2 className="w-2.5 h-2.5 animate-spin" /> Syncing
                </span>
              )}
              {syncStatus !== 'pending' && lastSync && (
                <span className="text-[9px] font-mono uppercase bg-white/[0.04] border border-white/[0.08] text-zinc-400 px-1.5 py-0.5 rounded" title={new Date(lastSync).toLocaleString()}>
                  Synced {timeAgo(lastSync)}
                </span>
              )}
            </h2>
            <p className="text-xs text-zinc-400 mt-1 leading-relaxed max-w-2xl">
              Static creatives pulled from Triple Whale's attribution warehouse — true 7d_click revenue,
              ROAS &amp; CPA. Multi-select accounts; videos are filtered server-side.
            </p>
          </div>
          <button onClick={onClose} className="text-zinc-400 hover:text-white cursor-pointer">
            <X className="w-4 h-4" />
          </button>
        </div>

        {/* Filters */}
        <div className="p-5 border-b border-white/[0.06] space-y-3">
          {/* Accounts */}
          <div>
            <label className="text-[10px] font-mono uppercase tracking-wider text-zinc-400 mb-1.5 block">Accounts</label>
            <div className="flex flex-wrap gap-1.5">
              <button
                onClick={toggleAll}
                className={`px-2 py-1 text-[11px] font-mono uppercase tracking-wider rounded border cursor-pointer ${
                  selectedAccounts.size === accounts.length && accounts.length > 0
                    ? 'bg-cyan-500/15 border-cyan-500/40 text-cyan-300'
                    : 'border-white/[0.08] text-zinc-400 hover:border-white/[0.2]'
                }`}
              >ALL</button>
              {accounts.map(a => {
                const on = selectedAccounts.has(a.ad_account_id);
                return (
                  <button
                    key={a.ad_account_id}
                    onClick={() => toggleAccount(a.ad_account_id)}
                    className={`px-2 py-1 text-[11px] font-mono rounded border cursor-pointer ${
                      on
                        ? 'bg-cyan-500/15 border-cyan-500/40 text-cyan-300'
                        : 'border-white/[0.08] text-zinc-400 hover:border-white/[0.2]'
                    }`}
                    title={a.ad_account_id}
                  >
                    {a.ad_account_name || a.ad_account_id} <span className="text-[9px] text-zinc-500">{fmtMoney(a.spend_30d)}</span>
                  </button>
                );
              })}
            </div>
          </div>

          <div className="grid grid-cols-2 lg:grid-cols-4 gap-3">
            {/* Status */}
            <div>
              <label className="text-[10px] font-mono uppercase tracking-wider text-zinc-400 mb-1 block">Status</label>
              <div className="flex gap-1">
                {STATUSES.map(s => (
                  <button
                    key={s.key}
                    onClick={() => setStatus(s.key)}
                    className={`px-2 py-1 text-[10px] font-mono uppercase rounded border cursor-pointer ${
                      status === s.key ? 'bg-cyan-500/15 border-cyan-500/40 text-cyan-300' : 'border-white/[0.08] text-zinc-400 hover:border-white/[0.2]'
                    }`}
                  >{s.label}</button>
                ))}
              </div>
            </div>
            {/* Window */}
            <div>
              <label className="text-[10px] font-mono uppercase tracking-wider text-zinc-400 mb-1 block">Window</label>
              <div className="flex gap-1">
                {WINDOWS.map(w => (
                  <button
                    key={w}
                    onClick={() => setWindowDays(w)}
                    className={`px-2 py-1 text-[10px] font-mono rounded border cursor-pointer ${
                      windowDays === w ? 'bg-cyan-500/15 border-cyan-500/40 text-cyan-300' : 'border-white/[0.08] text-zinc-400 hover:border-white/[0.2]'
                    }`}
                  >{w}D</button>
                ))}
              </div>
            </div>
            {/* Sort */}
            <div>
              <label className="text-[10px] font-mono uppercase tracking-wider text-zinc-400 mb-1 block">Sort</label>
              <select
                value={sort}
                onChange={(e) => setSort(e.target.value)}
                className="w-full bg-black/40 border border-white/[0.08] rounded text-[11px] text-white px-2 py-1 font-mono focus:border-cyan-400 focus:outline-none"
              >
                {SORTS.map(s => <option key={s.key} value={s.key}>{s.label} ↓</option>)}
              </select>
            </div>
            {/* Refresh — forces a fresh TW sync upstream */}
            <div className="flex items-end">
              <button
                onClick={forceRefresh}
                disabled={loadingAds || syncStatus === 'pending'}
                title={lastSync ? `Last sync: ${new Date(lastSync).toLocaleString()}` : 'Force a fresh Triple Whale sync'}
                className="w-full px-2 py-1 text-[10px] font-mono uppercase tracking-wider text-zinc-300 border border-white/[0.08] rounded hover:border-white/[0.2] disabled:opacity-40 cursor-pointer inline-flex items-center justify-center gap-1"
              >
                {(loadingAds || syncStatus === 'pending')
                  ? <><Loader2 className="w-3 h-3 animate-spin" /> {syncStatus === 'pending' ? 'Syncing…' : 'Loading…'}</>
                  : <><RefreshCw className="w-3 h-3" /> Refresh</>}
              </button>
            </div>
          </div>

          {/* Min ROAS / Min Spend / Search */}
          <div className="grid grid-cols-3 gap-3">
            <label className="block">
              <span className="text-[10px] font-mono uppercase tracking-wider text-zinc-400 mb-1 block">ROAS ≥</span>
              <input
                type="number" step="0.1" min="0" value={minRoas}
                onChange={(e) => setMinRoas(Number(e.target.value) || 0)}
                className="w-full bg-black/40 border border-white/[0.08] rounded text-[11px] text-white px-2 py-1 font-mono focus:border-cyan-400 focus:outline-none"
              />
            </label>
            <label className="block">
              <span className="text-[10px] font-mono uppercase tracking-wider text-zinc-400 mb-1 block">Spend ≥ $</span>
              <input
                type="number" step="10" min="0" value={minSpend}
                onChange={(e) => setMinSpend(Number(e.target.value) || 0)}
                className="w-full bg-black/40 border border-white/[0.08] rounded text-[11px] text-white px-2 py-1 font-mono focus:border-cyan-400 focus:outline-none"
              />
            </label>
            <label className="block">
              <span className="text-[10px] font-mono uppercase tracking-wider text-zinc-400 mb-1 block">Search</span>
              <div className="relative">
                <Search className="w-3 h-3 absolute left-2 top-1/2 -translate-y-1/2 text-zinc-500" />
                <input
                  type="text"
                  value={search}
                  onChange={(e) => setSearch(e.target.value)}
                  placeholder="name or ad id"
                  className="w-full bg-black/40 border border-white/[0.08] rounded text-[11px] text-white pl-7 pr-2 py-1 font-mono focus:border-cyan-400 focus:outline-none"
                />
              </div>
            </label>
          </div>
        </div>

        {/* Grid */}
        <div className="flex-1 overflow-y-auto p-5">
          {error && (
            <div className="mb-3 px-3 py-2 bg-red-500/10 border border-red-500/30 rounded text-xs text-red-300">{error}</div>
          )}
          {loadingAds && (
            <div className="text-center text-xs text-zinc-500 py-8">
              <Loader2 className="w-4 h-4 animate-spin inline mr-2" /> Loading ads…
            </div>
          )}
          {!loadingAds && ads.length === 0 && !error && (
            <div className="text-center text-xs text-zinc-500 py-8">No ads match the current filters.</div>
          )}
          <div className="grid grid-cols-3 gap-3">
            {ads.map(ad => {
              const isSel = selected.has(ad.creative_id);
              const disabled = !!ad.already_imported;
              return (
                <div
                  key={ad.creative_id}
                  onClick={() => !disabled && toggleSelect(ad.creative_id)}
                  className={`relative glass-card border rounded-lg overflow-hidden transition ${
                    disabled
                      ? 'border-white/[0.04] opacity-50 cursor-not-allowed'
                      : isSel
                        ? 'border-cyan-400 cursor-pointer'
                        : 'border-white/[0.06] hover:border-white/[0.15] cursor-pointer'
                  }`}
                >
                  {ad.thumbnail_url ? (
                    <img src={ad.thumbnail_url} alt="" className="w-full aspect-[4/5] object-cover" onError={(e) => { e.currentTarget.style.opacity = '0.2'; }} />
                  ) : (
                    <div className="w-full aspect-[4/5] bg-white/[0.02]" />
                  )}
                  <span className="absolute top-1.5 left-1.5 text-[9px] font-mono font-bold bg-emerald-500/90 text-black px-1.5 py-0.5 rounded">ACTIVE</span>
                  {ad.auto_detected && (
                    <span
                      className="absolute top-1.5 left-[60px] text-[9px] font-mono font-bold bg-purple-500/90 text-white px-1.5 py-0.5 rounded"
                      title="Auto-detected — ad name did not match our IM/B naming convention, metadata was inferred from keywords"
                    >AUTO</span>
                  )}
                  {disabled && (
                    <span className="absolute top-1.5 right-1.5 text-[9px] font-mono font-bold bg-zinc-700 text-zinc-200 px-1.5 py-0.5 rounded">IN LIB</span>
                  )}
                  {isSel && !disabled && (
                    <div className="absolute inset-0 bg-cyan-400/20 flex items-center justify-center">
                      <div className="w-7 h-7 bg-cyan-400 rounded-full flex items-center justify-center">
                        <Check className="w-4 h-4 text-black" />
                      </div>
                    </div>
                  )}
                  <div className="p-2 space-y-1">
                    <div className="text-[10px] font-mono text-zinc-300 truncate" title={ad.account_name}>{ad.account_name}</div>
                    <div className="text-[10px] font-mono text-zinc-400 truncate" title={ad.ad_name}>{ad.ad_name || ad.creative_id}</div>
                    {/* Top row: ROAS + Spend — the two most-important metrics, larger size */}
                    <div className="flex items-baseline gap-2 mb-0.5">
                      <span className={`text-[12px] font-mono font-bold ${Number(ad.roas) >= 2 ? 'text-emerald-400' : Number(ad.roas) >= 1 ? 'text-amber-400' : 'text-rose-400'}`}>
                        {Number(ad.roas || 0).toFixed(2)}x ROAS
                      </span>
                      <span className="text-[10px] font-mono text-zinc-400">{fmtMoney(ad.spend)}</span>
                    </div>
                    <div className="flex flex-wrap gap-x-2 text-[9px] font-mono text-zinc-500">
                      <span>Rev {fmtMoney(ad.revenue)}</span>
                      <span>CPA {fmtMoney(ad.cpa)}</span>
                      <span>CTR {Number(ad.ctr || 0).toFixed(1)}%</span>
                    </div>
                    <div className="text-[9px] text-zinc-600 font-mono">{Number(ad.impressions || 0).toLocaleString()} imp · {ad.days_active || 0}d</div>
                  </div>
                </div>
              );
            })}
          </div>
        </div>

        {/* Footer */}
        <div className="border-t border-white/[0.06] p-4 flex items-center justify-between">
          <div className="text-[11px] font-mono text-zinc-400">{ads.length} ads</div>
          <div className="flex items-center gap-2">
            <button
              onClick={selectAll}
              className="px-3 py-1.5 text-[11px] font-mono uppercase tracking-wider text-zinc-300 border border-white/[0.08] rounded hover:border-white/[0.2] cursor-pointer"
            >
              {selected.size === selectableAds.length && selectableAds.length > 0 ? 'Clear' : 'Select all'}
            </button>
            <button
              onClick={submit}
              disabled={selected.size === 0 || importing}
              className="px-4 py-1.5 text-[11px] font-mono uppercase tracking-wider text-black bg-cyan-400 hover:bg-cyan-300 rounded disabled:opacity-40 cursor-pointer flex items-center gap-1.5"
            >
              {importing ? <Loader2 className="w-3 h-3 animate-spin" /> : null}
              Import {selected.size > 0 ? `(${selected.size})` : ''}
            </button>
          </div>
        </div>

        <style>{`
          @keyframes slide-in-right { from { transform: translateX(100%); } to { transform: translateX(0); } }
          .animate-slide-in-right { animation: slide-in-right 0.25s ease-out; }
        `}</style>
      </div>
    </>,
    document.body
  );
}

export default MetaImportModal;
