import React, { useState, useEffect, useMemo, useCallback } from 'react';
import { Globe, Loader2, ChevronDown, ChevronUp, Sparkles, Settings } from 'lucide-react';
import api from '../../../services/api';
import { BrandFollowConfigModal } from './BrandFollowConfigModal';

// localStorage key for brand-filter persistence (Q3 default: localStorage v1).
const LS_KEY = 'mb.statics.fromLeague.brandFilter.v1';

function readPersisted() {
  try {
    const v = window.localStorage.getItem(LS_KEY);
    if (!v) return null;
    const parsed = JSON.parse(v);
    return Array.isArray(parsed) ? parsed : null;
  } catch { return null; }
}
function writePersisted(brandIds) {
  try { window.localStorage.setItem(LS_KEY, JSON.stringify(brandIds)); } catch { /* quota / private mode */ }
}

/**
 * FROM LEAGUE — Phase B implementation.
 *
 * Renders static ads from brands the operator follows. Multi-select brand
 * filter at the top (localStorage-persisted). Per-card "Use as Reference"
 * button promotes the ad into the user's REFERENCE column (via the same
 * onSelectReference callback the rest of the pipeline already uses).
 *
 * No queueing or generation happens directly from this column — it's a
 * discovery surface, generation always flows through Reference.
 */
export function FromLeagueColumn({ onUseAsReference }) {
  const [brands, setBrands] = useState([]);
  const [selectedBrands, setSelectedBrands] = useState(() => readPersisted() || []);
  const [filterOpen, setFilterOpen] = useState(false);
  const [ads, setAds] = useState([]); // { ...ad, brand_id, brand_name }[]
  const [loadingBrands, setLoadingBrands] = useState(true);
  const [loadingAds, setLoadingAds] = useState(false);
  const [error, setError] = useState(null);

  // 1. Load followed brands once on mount.
  useEffect(() => {
    let cancelled = false;
    (async () => {
      setLoadingBrands(true);
      setError(null);
      try {
        const { data } = await api.get('/statics-generation/league/brands');
        if (cancelled) return;
        const list = data?.data || [];
        setBrands(list);
        // First-load default: select all followed brands. After that, the
        // user's choices persist via localStorage.
        const persisted = readPersisted();
        if (persisted === null) {
          const all = list.map(b => b.id);
          setSelectedBrands(all);
          writePersisted(all);
        }
      } catch (err) {
        if (!cancelled) setError(err.response?.data?.error?.message || err.message);
      } finally {
        if (!cancelled) setLoadingBrands(false);
      }
    })();
    return () => { cancelled = true; };
  }, []);

  // 2. Fetch ads for each selected brand and merge.
  const loadAds = useCallback(async () => {
    if (selectedBrands.length === 0) { setAds([]); return; }
    setLoadingAds(true);
    setError(null);
    try {
      const results = await Promise.all(
        selectedBrands.map((bid) =>
          api.get('/statics-generation/league/ads', {
            params: { brand_id: bid, format: 'IMAGE', tiers: 'BANGER,CHAMP,A', active_only: true },
          }).then(r => (r.data?.data || []).slice(0, 20).map(a => ({
            ...a,
            brand_id: bid,
            brand_name: brands.find(b => b.id === bid)?.name || '',
          }))).catch(() => [])
        )
      );
      // Merge + sort by tier_score desc (already roughly sorted per-brand).
      const merged = results.flat().sort((a, b) =>
        (b.tier_score ?? 0) - (a.tier_score ?? 0)
      );
      setAds(merged);
    } catch (err) {
      setError(err.response?.data?.error?.message || err.message);
    } finally {
      setLoadingAds(false);
    }
  }, [selectedBrands, brands]);

  useEffect(() => { loadAds(); }, [loadAds]);

  const toggleBrand = (id) => {
    setSelectedBrands((prev) => {
      const next = prev.includes(id) ? prev.filter(x => x !== id) : [...prev, id];
      writePersisted(next);
      return next;
    });
  };

  const selectAll = () => {
    const all = brands.map(b => b.id);
    setSelectedBrands(all);
    writePersisted(all);
  };
  const clearAll = () => {
    setSelectedBrands([]);
    writePersisted([]);
  };

  const visibleCount = ads.length;
  const filterButtonLabel = useMemo(() => {
    if (selectedBrands.length === 0) return 'No brands';
    if (selectedBrands.length === brands.length) return 'All brands';
    return `${selectedBrands.length} of ${brands.length}`;
  }, [selectedBrands, brands]);

  const [configOpen, setConfigOpen] = useState(false);

  return (
    <div className="flex flex-col min-w-[260px] max-w-[340px] flex-1 relative h-full">
      {/* Header */}
      <div className="flex items-center justify-between mb-3 px-1">
        <div className="flex items-center gap-2">
          <Globe className="w-4 h-4 text-violet-400 drop-shadow-[0_0_6px_rgba(139,92,246,0.4)]" />
          <span className="text-xs font-mono font-semibold text-white uppercase tracking-[0.15em]">
            From League
          </span>
          <span className="px-1.5 py-0.5 text-[10px] font-mono font-bold bg-violet-500/10 text-violet-300 border border-violet-500/25 rounded">
            {visibleCount}
          </span>
        </div>
        <button
          type="button"
          onClick={() => setConfigOpen(true)}
          className="p-1 rounded-md text-zinc-500 hover:text-violet-300 hover:bg-violet-500/10 transition-colors cursor-pointer"
          title="Brand Follow Config — per-brand import preferences"
        >
          <Settings className="w-3.5 h-3.5" />
        </button>
      </div>

      <BrandFollowConfigModal
        isOpen={configOpen}
        onClose={() => setConfigOpen(false)}
        onSynced={() => { loadAds(); }}
      />

      {/* Brand filter */}
      <div className="mb-3 px-1">
        <button
          type="button"
          onClick={() => setFilterOpen((v) => !v)}
          className="w-full flex items-center justify-between gap-2 px-3 py-2 rounded-md bg-white/[0.04] border border-white/[0.08] hover:border-white/[0.15] text-xs font-mono text-zinc-300 cursor-pointer transition-colors"
          disabled={loadingBrands}
        >
          <span>{loadingBrands ? 'Loading brands…' : filterButtonLabel}</span>
          {filterOpen ? <ChevronUp className="w-3.5 h-3.5" /> : <ChevronDown className="w-3.5 h-3.5" />}
        </button>
        {filterOpen && (
          <div className="mt-2 p-2 rounded-md bg-black/40 border border-white/[0.06] space-y-1 max-h-[260px] overflow-y-auto">
            <div className="flex items-center gap-2 px-1 pb-2 border-b border-white/[0.05]">
              <button onClick={selectAll} className="text-[10px] font-mono text-violet-300 hover:text-violet-200 cursor-pointer">All</button>
              <span className="text-zinc-700">·</span>
              <button onClick={clearAll} className="text-[10px] font-mono text-zinc-500 hover:text-zinc-300 cursor-pointer">None</button>
            </div>
            {brands.length === 0 && !loadingBrands && (
              <div className="text-[10px] text-zinc-600 px-1 py-2">No followed brands. Add some from the League view.</div>
            )}
            {brands.map((b) => {
              const checked = selectedBrands.includes(b.id);
              return (
                <label key={b.id} className="flex items-center gap-2 px-1 py-1 rounded hover:bg-white/[0.03] cursor-pointer">
                  <input
                    type="checkbox"
                    checked={checked}
                    onChange={() => toggleBrand(b.id)}
                    className="accent-violet-500"
                  />
                  <span className="text-[11px] font-mono text-zinc-300 truncate flex-1" title={b.name}>{b.name}</span>
                  {typeof b.static_count === 'number' && (
                    <span className="text-[9px] font-mono text-zinc-600">{b.static_count}</span>
                  )}
                </label>
              );
            })}
          </div>
        )}
      </div>

      {/* Body */}
      <div className="flex-1 overflow-y-auto space-y-3 pr-1 custom-scrollbar">
        {error && (
          <div className="px-3 py-2 bg-red-500/10 border border-red-500/30 rounded text-xs text-red-300">
            {error}
          </div>
        )}
        {loadingAds && (
          <div className="flex items-center justify-center py-8">
            <Loader2 className="w-4 h-4 animate-spin text-violet-400" />
          </div>
        )}
        {!loadingAds && !error && selectedBrands.length === 0 && (
          <div className="text-[11px] text-zinc-600 text-center px-3 py-8 leading-relaxed">
            Pick brands from the filter above to see their statics.
          </div>
        )}
        {!loadingAds && !error && selectedBrands.length > 0 && ads.length === 0 && (
          <div className="text-[11px] text-zinc-600 text-center px-3 py-8 leading-relaxed">
            No active image ads from the selected brand{selectedBrands.length === 1 ? '' : 's'}.
          </div>
        )}
        {ads.map((ad) => (
          <LeagueAdCard
            key={`${ad.brand_id}:${ad.id}`}
            ad={ad}
            onUseAsReference={onUseAsReference}
          />
        ))}
      </div>
    </div>
  );
}

function LeagueAdCard({ ad, onUseAsReference }) {
  const [busy, setBusy] = useState(false);
  const [picked, setPicked] = useState(false);
  const thumb = ad.image_url;
  const title = ad.headline || ad.body_text || ad.ad_archive_id || 'Untitled';

  // PIPELINE-V2 BEHAVIOR: clicking "Use" just sets this ad as the active
  // single-pick reference for the next generation. It does NOT persist
  // into spy_creatives. The Reference column is reserved for the
  // operator's OWN winners (Meta-imported + uploads); league ads are
  // inspiration-only, used inline from this column.
  const handleUse = () => {
    if (busy) return;
    setBusy(true);
    try {
      onUseAsReference?.(ad);
      setPicked(true);
      // Visual confirmation flashes for 2s then resets so the same card
      // can be re-picked if the operator wants to regenerate with it.
      setTimeout(() => setPicked(false), 2000);
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="glass-card border border-white/[0.05] rounded-xl overflow-hidden hover:border-white/[0.12] transition-all">
      {thumb ? (
        <div className="relative aspect-[4/5] bg-black/40 overflow-hidden">
          <img
            src={thumb}
            alt={title}
            loading="lazy"
            decoding="async"
            className="w-full h-full object-cover"
            onError={(e) => { e.currentTarget.style.opacity = '0.2'; }}
          />
          {ad.tier && (
            <span className="absolute top-1.5 left-1.5 text-[9px] font-mono font-bold bg-[#c9a84c]/90 text-black px-1.5 py-0.5 rounded">
              {ad.tier}
            </span>
          )}
          {picked && (
            <span className="absolute top-1.5 right-1.5 text-[9px] font-mono font-bold bg-emerald-500/90 text-black px-1.5 py-0.5 rounded">
              PICKED
            </span>
          )}
        </div>
      ) : (
        <div className="aspect-[4/5] bg-white/[0.02] flex items-center justify-center text-zinc-600 text-xs">No preview</div>
      )}
      <div className="px-3 pt-2 pb-2.5 space-y-2">
        <div className="space-y-0.5">
          <div className="text-[11px] font-mono text-zinc-100 truncate" title={title}>{title}</div>
          <div className="text-[10px] text-zinc-500 font-mono truncate">{ad.brand_name} · {ad.display_format} · {ad.active_days || 0}d</div>
        </div>
        <button
          type="button"
          onClick={handleUse}
          disabled={busy}
          className={`w-full inline-flex items-center justify-center gap-1.5 px-2.5 py-1.5 rounded-lg border text-[10px] font-mono font-semibold uppercase tracking-wide transition-all cursor-pointer disabled:opacity-50 disabled:cursor-not-allowed ${
            picked
              ? 'bg-emerald-500/15 border-emerald-400/30 text-emerald-300'
              : 'bg-violet-500/15 border-violet-400/30 text-violet-300 hover:bg-violet-500/25'
          }`}
          title="Set as single-pick reference for the next generation. Not persisted to your library."
        >
          <Sparkles className="w-3 h-3" />
          {picked ? 'Picked' : 'Use as Reference'}
        </button>
      </div>
    </div>
  );
}

export default FromLeagueColumn;
