import { useEffect, useState, useCallback, useMemo } from 'react';
import { createPortal } from 'react-dom';
import { X, Loader2, Search, Globe, Check } from 'lucide-react';
import api from '../../../services/api';

const ALL_TIERS = ['BANGER', 'CHAMP', 'A', 'B', 'C', 'MID', 'TEST'];
const DEFAULT_TIERS = ['BANGER', 'CHAMP', 'A'];
const FORMATS = [
  { key: 'IMAGE',      label: 'Image' },
  { key: 'CAROUSEL',   label: 'Carousel' },
  { key: 'ALL_STATIC', label: 'All Static' },
];

function useDebounced(value, delay = 300) {
  const [v, setV] = useState(value);
  useEffect(() => {
    const t = setTimeout(() => setV(value), delay);
    return () => clearTimeout(t);
  }, [value, delay]);
  return v;
}

export function LeagueImportModal({ onClose, onImported }) {
  const [brands, setBrands] = useState([]);
  const [brandId, setBrandId] = useState('');
  const [tiers, setTiers] = useState(new Set(DEFAULT_TIERS));
  const [format, setFormat] = useState('IMAGE');
  const [activeOnly, setActiveOnly] = useState(true);
  const [search, setSearch] = useState('');
  const debouncedSearch = useDebounced(search, 300);
  const [ads, setAds] = useState([]);
  const [loadingBrands, setLoadingBrands] = useState(false);
  const [loadingAds, setLoadingAds] = useState(false);
  const [error, setError] = useState(null);
  const [selected, setSelected] = useState(new Set());
  const [importing, setImporting] = useState(false);

  // Load brands once.
  useEffect(() => {
    setLoadingBrands(true);
    api.get('/statics-generation/league/brands')
      .then(res => {
        const list = res.data?.data || [];
        setBrands(list);
        if (list.length > 0 && !brandId) setBrandId(list[0].id);
      })
      .catch(err => setError(err.response?.data?.error?.message || err.message))
      .finally(() => setLoadingBrands(false));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const loadAds = useCallback(async () => {
    if (!brandId) return;
    setLoadingAds(true);
    setError(null);
    try {
      const res = await api.get('/statics-generation/league/ads', {
        params: {
          brand_id: brandId,
          tiers: Array.from(tiers).join(','),
          format,
          active_only: activeOnly,
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
  }, [brandId, tiers, format, activeOnly, debouncedSearch]);

  useEffect(() => { loadAds(); }, [loadAds]);

  const toggleTier = (t) => {
    setTiers(prev => {
      const next = new Set(prev);
      if (next.has(t)) next.delete(t); else next.add(t);
      return next;
    });
  };

  const alreadyCount = useMemo(() => ads.filter(a => a.already_imported).length, [ads]);
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
    else setSelected(new Set(selectableAds.map(a => a.id)));
  };

  const submit = async () => {
    if (selected.size === 0) return;
    setImporting(true);
    setError(null);
    try {
      const res = await api.post('/statics-generation/league/import', {
        brand_id: brandId,
        ad_ids: Array.from(selected),
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
      <div className="fixed inset-y-0 right-0 w-full max-w-3xl bg-bg-card border-l border-border-subtle z-[9999] flex flex-col animate-slide-in-right">
        {/* Header */}
        <div className="flex items-center justify-between p-5 border-b border-white/[0.06]">
          <div>
            <h2 className="text-sm font-mono font-semibold text-white uppercase tracking-wider flex items-center gap-2">
              <Globe className="w-4 h-4 text-[#d4b55a]" />
              Import from League
            </h2>
            <p className="text-xs text-zinc-400 mt-1 leading-relaxed">
              Pick canonical-ranked Meta ads from a followed brand and push them into the Reference column.
            </p>
          </div>
          <button onClick={onClose} className="text-zinc-400 hover:text-white cursor-pointer">
            <X className="w-4 h-4" />
          </button>
        </div>

        {/* Filters */}
        <div className="p-5 border-b border-white/[0.06] space-y-3">
          {/* Brand select */}
          <div>
            <label className="text-[10px] font-mono uppercase tracking-wider text-zinc-400 mb-1.5 block">Brand</label>
            <select
              value={brandId}
              onChange={(e) => setBrandId(e.target.value)}
              disabled={loadingBrands}
              className="w-full bg-black/40 border border-white/[0.08] rounded text-xs text-white px-3 py-2 font-mono focus:border-[#d4b55a] focus:outline-none"
            >
              {loadingBrands && <option>Loading…</option>}
              {!loadingBrands && brands.length === 0 && <option value="">No followed brands</option>}
              {brands.map(b => (
                <option key={b.id} value={b.id}>
                  {b.name || b.domain} — {b.static_count} static
                </option>
              ))}
            </select>
          </div>

          {/* Format pills */}
          <div>
            <label className="text-[10px] font-mono uppercase tracking-wider text-zinc-400 mb-1.5 block">Format</label>
            <div className="flex gap-1">
              {FORMATS.map(f => (
                <button
                  key={f.key}
                  onClick={() => setFormat(f.key)}
                  className={`px-3 py-1 text-[11px] font-mono uppercase tracking-wider rounded border cursor-pointer ${
                    format === f.key
                      ? 'bg-[#c9a84c]/15 border-[#c9a84c]/40 text-[#d4b55a]'
                      : 'border-white/[0.08] text-zinc-400 hover:border-white/[0.2]'
                  }`}
                >{f.label}</button>
              ))}
            </div>
          </div>

          {/* Tiers */}
          <div>
            <label className="text-[10px] font-mono uppercase tracking-wider text-zinc-400 mb-1.5 block">Tiers</label>
            <div className="flex flex-wrap gap-1">
              {ALL_TIERS.map(t => (
                <label key={t} className="inline-flex items-center gap-1 cursor-pointer">
                  <input
                    type="checkbox"
                    checked={tiers.has(t)}
                    onChange={() => toggleTier(t)}
                    className="accent-[#d4b55a]"
                  />
                  <span className={`text-[11px] font-mono ${tiers.has(t) ? 'text-[#d4b55a]' : 'text-zinc-500'}`}>{t}</span>
                </label>
              ))}
            </div>
          </div>

          {/* Active + search */}
          <div className="flex items-center gap-4">
            <label className="inline-flex items-center gap-1 cursor-pointer">
              <input type="checkbox" checked={activeOnly} onChange={(e) => setActiveOnly(e.target.checked)} className="accent-[#d4b55a]" />
              <span className="text-[11px] font-mono uppercase tracking-wider text-zinc-300">Active only</span>
            </label>
            <div className="flex-1 relative">
              <Search className="w-3 h-3 absolute left-2 top-1/2 -translate-y-1/2 text-zinc-500" />
              <input
                type="text"
                value={search}
                onChange={(e) => setSearch(e.target.value)}
                placeholder="Search headline / body / caption…"
                className="w-full bg-black/40 border border-white/[0.08] rounded text-xs text-white pl-7 pr-2 py-1.5 font-mono focus:border-[#d4b55a] focus:outline-none"
              />
            </div>
          </div>
        </div>

        {/* List */}
        <div className="flex-1 overflow-y-auto p-5">
          {error && (
            <div className="mb-3 px-3 py-2 bg-red-500/10 border border-red-500/30 rounded text-xs text-red-300">
              {error}
            </div>
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
              const isSel = selected.has(ad.id);
              const disabled = !!ad.already_imported;
              return (
                <div
                  key={ad.id}
                  onClick={() => !disabled && toggleSelect(ad.id)}
                  className={`relative glass-card border rounded-lg overflow-hidden transition ${
                    disabled
                      ? 'border-white/[0.04] opacity-50 cursor-not-allowed'
                      : isSel
                        ? 'border-[#d4b55a] cursor-pointer'
                        : 'border-white/[0.06] hover:border-white/[0.15] cursor-pointer'
                  }`}
                >
                  {ad.image_url ? (
                    <img
                      src={ad.image_url}
                      alt=""
                      loading="lazy"
                      decoding="async"
                      className="w-full aspect-[4/5] object-cover"
                      onError={(e) => { e.currentTarget.style.opacity = '0.2'; }}
                    />
                  ) : (
                    <div className="w-full aspect-[4/5] bg-white/[0.02]" />
                  )}
                  {ad.tier && (
                    <span className="absolute top-1.5 left-1.5 text-[9px] font-mono font-bold bg-[#c9a84c]/90 text-black px-1.5 py-0.5 rounded">
                      {ad.tier}
                    </span>
                  )}
                  {disabled && (
                    <span className="absolute top-1.5 right-1.5 text-[9px] font-mono font-bold bg-zinc-700 text-zinc-200 px-1.5 py-0.5 rounded">
                      IN LIB
                    </span>
                  )}
                  {isSel && !disabled && (
                    <div className="absolute inset-0 bg-[#d4b55a]/20 flex items-center justify-center">
                      <div className="w-7 h-7 bg-[#d4b55a] rounded-full flex items-center justify-center">
                        <Check className="w-4 h-4 text-black" />
                      </div>
                    </div>
                  )}
                  <div className="p-2 space-y-0.5">
                    <div className="text-[10px] font-mono text-zinc-300 truncate">{ad.headline || ad.body_text || ad.ad_archive_id}</div>
                    <div className="text-[9px] text-zinc-500">{ad.display_format} · {ad.active_days || 0}d</div>
                  </div>
                </div>
              );
            })}
          </div>
        </div>

        {/* Footer */}
        <div className="border-t border-white/[0.06] p-4 flex items-center justify-between">
          <div className="text-[11px] font-mono text-zinc-400">
            {ads.length} ads available · {alreadyCount} already in library
          </div>
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
              className="px-4 py-1.5 text-[11px] font-mono uppercase tracking-wider text-black bg-[#d4b55a] hover:bg-[#e4c56a] rounded disabled:opacity-40 cursor-pointer flex items-center gap-1.5"
            >
              {importing ? <Loader2 className="w-3 h-3 animate-spin" /> : null}
              Import {selected.size > 0 ? `(${selected.size})` : ''} to Reference
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

export default LeagueImportModal;
