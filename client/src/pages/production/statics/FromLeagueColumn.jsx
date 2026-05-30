import React, { useState, useEffect, useCallback, useMemo } from 'react';
import { Globe, Loader2, Sparkles, Settings, X, ZoomIn, CheckCircle2 } from 'lucide-react';
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
  const [ads, setAds] = useState([]); // { ...ad, brand_id, brand_name }[]
  // Locally-dismissed ad IDs — operator clicks the red X on a card and we
  // hide it from the column until the next loadAds() refresh.
  const [dismissed, setDismissed] = useState(() => new Set());
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
      // Merge + sort: imported-first (so the operator's manual Import
      // choices land at the top of the column, giving them visible
      // feedback that the button did something), then by tier_score desc.
      const merged = results.flat().sort((a, b) => {
        const aImp = a.already_imported ? 1 : 0;
        const bImp = b.already_imported ? 1 : 0;
        if (bImp !== aImp) return bImp - aImp;
        return (b.tier_score ?? 0) - (a.tier_score ?? 0);
      });
      setAds(merged);
    } catch (err) {
      setError(err.response?.data?.error?.message || err.message);
    } finally {
      setLoadingAds(false);
    }
  }, [selectedBrands, brands]);

  useEffect(() => { loadAds(); }, [loadAds]);

  const visibleAds = useMemo(() => ads.filter(a => !dismissed.has(`${a.brand_id}:${a.id}`)), [ads, dismissed]);
  const visibleCount = visibleAds.length;
  const importedCount = useMemo(() => visibleAds.filter(a => a.already_imported).length, [visibleAds]);
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

      {/* Brand-filter dropdown removed — followed-brand selection now lives
          entirely in the Brand Follow Config modal (gear icon above). All
          followed brands flow in by default; per-brand inclusion/exclusion
          is controlled there. */}

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
        {visibleAds.map((ad) => (
          <LeagueAdCard
            key={`${ad.brand_id}:${ad.id}`}
            ad={ad}
            onUseAsReference={onUseAsReference}
            onDismiss={() => setDismissed(prev => {
              const next = new Set(prev);
              next.add(`${ad.brand_id}:${ad.id}`);
              return next;
            })}
          />
        ))}
      </div>
    </div>
  );
}

function LeagueAdCard({ ad, onUseAsReference, onDismiss }) {
  const [busy, setBusy] = useState(false);
  const [picked, setPicked] = useState(false);
  const [previewOpen, setPreviewOpen] = useState(false);
  const thumb = ad.image_url;
  const title = ad.headline || ad.body_text || ad.ad_archive_id || 'Untitled';

  // ESC closes the preview lightbox.
  useEffect(() => {
    if (!previewOpen) return undefined;
    const h = (e) => { if (e.key === 'Escape') setPreviewOpen(false); };
    window.addEventListener('keydown', h);
    return () => window.removeEventListener('keydown', h);
  }, [previewOpen]);

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
        <button
          type="button"
          onClick={() => setPreviewOpen(true)}
          className="group relative aspect-[4/5] w-full bg-black/40 overflow-hidden cursor-zoom-in block"
          title="Click to preview at full size"
        >
          <img
            src={thumb}
            alt={title}
            loading="lazy"
            decoding="async"
            className="w-full h-full object-cover transition-transform group-hover:scale-[1.02]"
            onError={(e) => { e.currentTarget.style.opacity = '0.2'; }}
          />
          {/* Subtle dark gradient + zoom icon on hover to signal clickability */}
          <div className="absolute inset-0 bg-gradient-to-t from-black/40 via-transparent to-transparent opacity-0 group-hover:opacity-100 transition-opacity pointer-events-none" />
          <div className="absolute bottom-2 right-2 opacity-0 group-hover:opacity-100 transition-opacity pointer-events-none">
            <span className="inline-flex items-center gap-1 px-1.5 py-0.5 rounded bg-black/70 text-white text-[9px] font-mono">
              <ZoomIn className="w-2.5 h-2.5" /> Preview
            </span>
          </div>
          {ad.tier && (
            <span className="absolute top-1.5 left-1.5 text-[9px] font-mono font-bold bg-[#c9a84c]/90 text-black px-1.5 py-0.5 rounded">
              {ad.tier}
            </span>
          )}
          {ad.already_imported && !picked && (
            <span
              className="absolute top-1.5 right-1.5 text-[9px] font-mono font-bold bg-amber-500/90 text-black px-1.5 py-0.5 rounded"
              title="You imported this card via Brand Follow Config"
            >
              ★ IMPORTED
            </span>
          )}
          {picked && (
            <span className="absolute top-1.5 right-1.5 text-[9px] font-mono font-bold bg-emerald-500/90 text-black px-1.5 py-0.5 rounded">
              PICKED
            </span>
          )}
        </button>
      ) : (
        <div className="aspect-[4/5] bg-white/[0.02] flex items-center justify-center text-zinc-600 text-xs">No preview</div>
      )}

      {/* Lightbox preview — opens on image click. ESC + backdrop click + X dismiss. */}
      {previewOpen && thumb && (
        <div
          className="fixed inset-0 z-[70] flex items-center justify-center bg-black/85 backdrop-blur-sm p-6"
          onClick={() => setPreviewOpen(false)}
        >
          <div
            className="relative max-w-5xl w-full max-h-[92vh] flex flex-col md:flex-row gap-4"
            onClick={(e) => e.stopPropagation()}
          >
            {/* Image */}
            <div className="flex-1 min-h-0 flex items-center justify-center bg-black/40 rounded-lg overflow-hidden border border-white/[0.08]">
              <img
                src={thumb}
                alt={title}
                className="max-w-full max-h-[88vh] object-contain"
                onError={(e) => { e.currentTarget.style.opacity = '0.2'; }}
              />
            </div>
            {/* Side info panel */}
            <div className="w-full md:w-80 shrink-0 flex flex-col gap-3 bg-zinc-950/80 border border-white/[0.08] rounded-lg p-4 overflow-y-auto custom-scrollbar">
              <div className="flex items-start justify-between gap-2">
                <div className="flex items-center gap-1.5 flex-wrap">
                  {ad.tier && (
                    <span className="text-[10px] font-mono font-bold bg-[#c9a84c]/90 text-black px-1.5 py-0.5 rounded">{ad.tier}</span>
                  )}
                  {ad.display_format && (
                    <span className="text-[10px] font-mono text-zinc-300 bg-white/[0.06] border border-white/[0.08] px-1.5 py-0.5 rounded">
                      {ad.display_format}
                    </span>
                  )}
                  {typeof ad.active_days === 'number' && (
                    <span className="text-[10px] font-mono text-zinc-400">{ad.active_days}d active</span>
                  )}
                </div>
                <button
                  type="button"
                  onClick={() => setPreviewOpen(false)}
                  className="p-1 rounded text-zinc-400 hover:text-white hover:bg-white/[0.06] cursor-pointer"
                  title="Close"
                >
                  <X className="w-4 h-4" />
                </button>
              </div>
              {ad.brand_name && (
                <div className="text-[11px] font-mono text-violet-300">{ad.brand_name}</div>
              )}
              {ad.headline && (
                <div>
                  <div className="text-[9px] font-mono uppercase tracking-wider text-zinc-500 mb-1">Headline</div>
                  <div className="text-sm text-zinc-100 leading-relaxed">{ad.headline}</div>
                </div>
              )}
              {ad.body_text && (
                <div>
                  <div className="text-[9px] font-mono uppercase tracking-wider text-zinc-500 mb-1">Body</div>
                  <div className="text-xs text-zinc-200 leading-relaxed whitespace-pre-wrap">{ad.body_text}</div>
                </div>
              )}
              {ad.caption && (
                <div>
                  <div className="text-[9px] font-mono uppercase tracking-wider text-zinc-500 mb-1">Caption</div>
                  <div className="text-xs text-zinc-300 leading-relaxed">{ad.caption}</div>
                </div>
              )}
              <button
                type="button"
                onClick={() => { handleUse(); setPreviewOpen(false); }}
                disabled={busy || picked}
                className={`mt-auto w-full inline-flex items-center justify-center gap-1.5 px-3 py-2 rounded-lg border text-[11px] font-mono font-semibold uppercase tracking-wide transition-all cursor-pointer disabled:opacity-50 disabled:cursor-not-allowed ${
                  picked
                    ? 'bg-emerald-500/15 border-emerald-400/30 text-emerald-300'
                    : 'bg-violet-500/15 border-violet-400/30 text-violet-300 hover:bg-violet-500/25'
                }`}
              >
                <Sparkles className="w-3.5 h-3.5" />
                {picked ? 'Picked' : 'Use as Reference'}
              </button>
            </div>
          </div>
        </div>
      )}
      <div className="px-3 pt-2 pb-2.5 space-y-2">
        <div className="space-y-0.5">
          <div className="text-[11px] font-mono text-zinc-100 truncate" title={title}>{title}</div>
          <div className="text-[10px] text-zinc-500 font-mono truncate">{ad.brand_name} · {ad.display_format} · {ad.active_days || 0}d</div>
        </div>
        <div className="flex items-center gap-2">
          <button
            type="button"
            onClick={handleUse}
            disabled={busy}
            className={`flex-1 inline-flex items-center justify-center gap-1.5 px-2.5 py-1 rounded-full border text-[10px] font-mono font-medium transition-all cursor-pointer disabled:opacity-50 disabled:cursor-not-allowed ${
              picked
                ? 'bg-emerald-500/15 border-emerald-400/40 text-emerald-300'
                : 'bg-emerald-500/10 border-emerald-400/30 text-emerald-300 hover:bg-emerald-500/20'
            }`}
            title="Set as the single-pick reference for the next generation"
          >
            <CheckCircle2 className="w-3 h-3" />
            {picked ? 'Picked' : 'Select'}
          </button>
          <button
            type="button"
            onClick={(e) => { e.stopPropagation(); onDismiss?.(); }}
            className="shrink-0 p-1.5 rounded-full text-red-400 hover:text-red-300 hover:bg-red-500/15 cursor-pointer transition-colors"
            title="Dismiss this card from the column"
          >
            <X className="w-3.5 h-3.5" />
          </button>
        </div>
      </div>
    </div>
  );
}

export default FromLeagueColumn;
