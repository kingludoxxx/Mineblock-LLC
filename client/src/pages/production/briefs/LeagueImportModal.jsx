import { useState, useEffect, useCallback, useMemo, useRef } from 'react';
import {
  X,
  Loader2,
  Trophy,
  Flame,
  Star,
  Search,
  Video as VideoIcon,
  CheckCircle2,
  AlertCircle,
  FileText,
  Mic,
  Play,
} from 'lucide-react';
import api from '../../../services/api';

const TIER_META = {
  BANGER: {
    label: 'Banger',
    Icon: Flame,
    color: 'text-amber-400',
    bg: 'bg-amber-500/10',
    border: 'border-amber-500/30',
    activeBg: 'bg-amber-500/15',
    activeBorder: 'border-amber-500/50',
    activeText: 'text-amber-300',
  },
  CHAMP: {
    label: 'Champ',
    Icon: Trophy,
    color: 'text-yellow-400',
    bg: 'bg-yellow-500/10',
    border: 'border-yellow-500/30',
    activeBg: 'bg-yellow-500/15',
    activeBorder: 'border-yellow-500/50',
    activeText: 'text-yellow-300',
  },
  A: {
    label: 'A-Tier',
    Icon: Star,
    color: 'text-sky-400',
    bg: 'bg-sky-500/10',
    border: 'border-sky-500/30',
    activeBg: 'bg-sky-500/15',
    activeBorder: 'border-sky-500/50',
    activeText: 'text-sky-300',
  },
};

const TIER_ORDER = ['BANGER', 'CHAMP', 'A'];

function TierBadge({ tier, size = 'sm' }) {
  const meta = TIER_META[tier];
  if (!meta) return null;
  const { Icon, color, bg, border, label } = meta;
  const sizing = size === 'sm'
    ? 'text-[10px] px-1.5 py-0.5 gap-1'
    : 'text-xs px-2 py-1 gap-1.5';
  return (
    <span className={`inline-flex items-center font-mono font-semibold uppercase tracking-wider rounded border ${bg} ${border} ${color} ${sizing} whitespace-nowrap`}>
      <Icon className={size === 'sm' ? 'w-2.5 h-2.5' : 'w-3 h-3'} />
      {label}
    </span>
  );
}

export default function LeagueImportModal({ open, onClose, onImported }) {
  // Brand list
  const [brands, setBrands] = useState([]);
  const [loadingBrands, setLoadingBrands] = useState(false);
  const [brandsError, setBrandsError] = useState(null);
  const [selectedBrandId, setSelectedBrandId] = useState(null);
  const [brandSearch, setBrandSearch] = useState('');
  const [brandDropdownOpen, setBrandDropdownOpen] = useState(false);
  const brandDropdownRef = useRef(null);

  // Tier filter — all three selected by default
  const [selectedTiers, setSelectedTiers] = useState(new Set(TIER_ORDER));

  // Ads list
  const [ads, setAds] = useState([]);
  const [adsTotal, setAdsTotal] = useState(0);
  const [adsPage, setAdsPage] = useState(1);
  const [loadingAds, setLoadingAds] = useState(false);
  const [adsError, setAdsError] = useState(null);

  // Right-panel preview
  const [selectedAd, setSelectedAd] = useState(null);
  const [videoError, setVideoError] = useState(false);
  const [transcribing, setTranscribing] = useState(false);
  const [transcriptError, setTranscriptError] = useState(null);

  // Import state
  const [importing, setImporting] = useState(false);
  const [importError, setImportError] = useState(null);
  const [importedAdIds, setImportedAdIds] = useState(new Set());
  const [importSuccess, setImportSuccess] = useState(false);

  const PAGE_SIZE = 20;

  // ── Brand fetch ───────────────────────────────────────────────────────
  const fetchBrands = useCallback(async () => {
    setLoadingBrands(true);
    setBrandsError(null);
    try {
      const { data } = await api.get('/brief-pipeline/league/brands');
      const list = data.brands || [];
      setBrands(list);
      // Auto-select first brand with video count > 0
      if (!selectedBrandId && list.length > 0) {
        const firstWithVideos = list.find(b => b.totalVideoCount > 0) || list[0];
        setSelectedBrandId(firstWithVideos.id);
      }
    } catch (err) {
      console.error('[LeagueImportModal] fetchBrands failed:', err);
      setBrandsError(
        err.response?.data?.error?.message || err.message || 'Failed to load brands'
      );
    } finally {
      setLoadingBrands(false);
    }
  }, [selectedBrandId]);

  // ── Ads fetch ─────────────────────────────────────────────────────────
  const fetchAds = useCallback(async (brandId, tiers, page) => {
    if (!brandId || tiers.length === 0) {
      setAds([]);
      setAdsTotal(0);
      return;
    }
    setLoadingAds(true);
    setAdsError(null);
    try {
      const { data } = await api.get('/brief-pipeline/league/ads', {
        params: {
          brand_id: brandId,
          tiers: tiers.join(','),
          page,
          limit: PAGE_SIZE,
        },
      });
      const newAds = data.ads || [];
      setAds(prev => page === 1 ? newAds : [...prev, ...newAds]);
      setAdsTotal(data.total || 0);
    } catch (err) {
      console.error('[LeagueImportModal] fetchAds failed:', err);
      setAdsError(
        err.response?.data?.error?.message || err.message || 'Failed to load ads'
      );
    } finally {
      setLoadingAds(false);
    }
  }, []);

  // ── Lifecycle ─────────────────────────────────────────────────────────
  useEffect(() => {
    if (open) {
      fetchBrands();
    } else {
      // Reset transient state when closed
      setSelectedAd(null);
      setBrandDropdownOpen(false);
      setBrandSearch('');
      setImportSuccess(false);
      setImportError(null);
      setTranscriptError(null);
      setVideoError(false);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open]);

  useEffect(() => {
    if (!open || !selectedBrandId) return;
    setAdsPage(1);
    setSelectedAd(null);
    fetchAds(selectedBrandId, [...selectedTiers], 1);
  }, [open, selectedBrandId, selectedTiers, fetchAds]);

  // Click-outside for brand dropdown
  useEffect(() => {
    function handler(e) {
      if (brandDropdownRef.current && !brandDropdownRef.current.contains(e.target)) {
        setBrandDropdownOpen(false);
      }
    }
    if (brandDropdownOpen) {
      document.addEventListener('mousedown', handler);
      return () => document.removeEventListener('mousedown', handler);
    }
  }, [brandDropdownOpen]);

  // Escape key closes modal
  useEffect(() => {
    if (!open) return;
    function handler(e) { if (e.key === 'Escape') onClose(); }
    document.addEventListener('keydown', handler);
    return () => document.removeEventListener('keydown', handler);
  }, [open, onClose]);

  // ── Derived ───────────────────────────────────────────────────────────
  const selectedBrand = useMemo(
    () => brands.find(b => b.id === selectedBrandId) || null,
    [brands, selectedBrandId]
  );

  const filteredBrands = useMemo(() => {
    const q = brandSearch.trim().toLowerCase();
    if (!q) return brands;
    return brands.filter(b =>
      (b.name || '').toLowerCase().includes(q) ||
      (b.domain || '').toLowerCase().includes(q)
    );
  }, [brands, brandSearch]);

  // ── Handlers ──────────────────────────────────────────────────────────
  const toggleTier = (tier) => {
    setSelectedTiers(prev => {
      const next = new Set(prev);
      if (next.has(tier)) {
        if (next.size === 1) return prev; // keep at least one selected
        next.delete(tier);
      } else {
        next.add(tier);
      }
      return next;
    });
  };

  const handleSelectAd = (ad) => {
    setSelectedAd(ad);
    setVideoError(false);
    setTranscriptError(null);
    setImportError(null);
    setImportSuccess(false);
  };

  const handleTranscribe = async () => {
    if (!selectedAd || transcribing) return;
    setTranscribing(true);
    setTranscriptError(null);
    try {
      const res = await api.post(`/brand-spy/ads/${selectedAd.id}/transcribe`);
      const transcript = res.data?.transcript;
      const transcriptAt = res.data?.transcriptAt;
      if (!transcript) throw new Error('Transcription returned empty text');
      // Update the selected ad locally so the right panel re-renders
      const updated = { ...selectedAd, transcript, transcriptAt };
      setSelectedAd(updated);
      // Reflect into the left list too
      setAds(prev => prev.map(a => a.id === selectedAd.id ? updated : a));
    } catch (err) {
      console.error('[LeagueImportModal] transcribe failed:', err);
      const reason = err.response?.data?.reason;
      let msg = err.response?.data?.error || err.message || 'Transcription failed';
      if (reason === 'NO_VIDEO_URL') {
        msg = 'No video URL stored for this ad — try a different ad, or import without a transcript.';
      } else if (typeof msg === 'object') {
        msg = msg.message || 'Transcription failed';
      }
      setTranscriptError(msg);
    } finally {
      setTranscribing(false);
    }
  };

  const handleImport = async () => {
    if (!selectedAd || !selectedBrand || importing) return;
    setImporting(true);
    setImportError(null);
    try {
      const { data } = await api.post('/brief-pipeline/references', {
        brandSpyAdId: selectedAd.id,
        adArchiveId: String(selectedAd.adArchiveId),
        brandId: selectedBrand.id,
        brandName: selectedBrand.name || selectedBrand.domain || 'Unknown brand',
        tier: selectedAd.tier,
        videoUrl: selectedAd.videoUrl,
        thumbnailUrl: selectedAd.thumbnailUrl,
        headline: selectedAd.headline,
        bodyText: selectedAd.bodyText,
        transcript: selectedAd.transcript || null,
        transcriptAt: selectedAd.transcriptAt || null,
      });
      setImportSuccess(true);
      // Mark this ad as imported in the left list immediately
      setImportedAdIds(prev => new Set(prev).add(selectedAd.adArchiveId));
      setAds(prev => prev.map(a =>
        a.adArchiveId === selectedAd.adArchiveId ? { ...a, alreadyImported: true } : a
      ));
      // Notify parent so it can refresh the Reference column
      if (onImported) onImported(data.reference);
      // Close after a short success flash
      setTimeout(() => {
        onClose();
      }, 1200);
    } catch (err) {
      console.error('[LeagueImportModal] import failed:', err);
      setImportError(
        err.response?.data?.error?.message || err.message || 'Import failed'
      );
    } finally {
      setImporting(false);
    }
  };

  const handleLoadMore = () => {
    const next = adsPage + 1;
    setAdsPage(next);
    fetchAds(selectedBrandId, [...selectedTiers], next);
  };

  if (!open) return null;

  const canImport = !!selectedAd && !!selectedAd.transcript && !importing && !importSuccess;

  // ── Render ────────────────────────────────────────────────────────────
  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center p-4 sm:p-6">
      {/* Backdrop */}
      <div
        className="absolute inset-0 bg-black/70 backdrop-blur-sm"
        onClick={onClose}
      />

      {/* Modal */}
      <div
        className="relative w-full max-w-6xl h-[88vh] bg-[#0a0a0a] border border-white/[0.08] rounded-xl shadow-2xl flex flex-col overflow-hidden"
        onClick={(e) => e.stopPropagation()}
      >
        {/* Header */}
        <div className="h-14 border-b border-white/[0.06] flex items-center justify-between px-5 shrink-0">
          <div className="flex items-center gap-3">
            <Trophy className="w-4 h-4 text-violet-400" />
            <h2 className="text-sm font-mono font-semibold text-white tracking-[0.18em] uppercase">
              Import from League
            </h2>
            <span className="text-[10px] font-mono text-zinc-500 uppercase tracking-widest">
              · Competitor video → reference
            </span>
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

        {/* Body — two-panel */}
        <div className="flex-1 flex min-h-0">
          {/* LEFT PANEL ─ Browser */}
          <div className="w-full md:w-[40%] border-r border-white/[0.06] flex flex-col min-h-0">
            {/* Brand selector + tier filter */}
            <div className="p-4 space-y-3 border-b border-white/[0.04] shrink-0">
              {/* Brand picker */}
              <div ref={brandDropdownRef} className="relative">
                <button
                  type="button"
                  onClick={() => setBrandDropdownOpen(o => !o)}
                  className="w-full flex items-center justify-between gap-2 bg-white/[0.02] border border-white/[0.08] rounded-lg px-3 py-2.5 text-left hover:border-white/[0.15] transition-colors cursor-pointer"
                >
                  <div className="flex items-center gap-2 min-w-0">
                    <Search className="w-3.5 h-3.5 text-zinc-500 shrink-0" />
                    <div className="min-w-0">
                      {loadingBrands ? (
                        <span className="text-xs text-zinc-500">Loading brands...</span>
                      ) : selectedBrand ? (
                        <>
                          <div className="text-sm text-white font-medium truncate">
                            {selectedBrand.name || selectedBrand.domain}
                          </div>
                          {selectedBrand.domain && selectedBrand.name && (
                            <div className="text-[10px] text-zinc-500 font-mono truncate">
                              {selectedBrand.domain}
                            </div>
                          )}
                        </>
                      ) : (
                        <span className="text-xs text-zinc-500">Pick a followed brand...</span>
                      )}
                    </div>
                  </div>
                  {selectedBrand && (
                    <div className="flex items-center gap-1 shrink-0">
                      {TIER_ORDER.map(t => {
                        const n = selectedBrand.tierCounts?.[t] || 0;
                        if (n === 0) return null;
                        const meta = TIER_META[t];
                        const { Icon } = meta;
                        return (
                          <span
                            key={t}
                            className={`inline-flex items-center gap-0.5 text-[10px] font-mono ${meta.color}`}
                            title={`${n} ${meta.label}`}
                          >
                            <Icon className="w-2.5 h-2.5" />
                            {n}
                          </span>
                        );
                      })}
                    </div>
                  )}
                </button>

                {brandDropdownOpen && (
                  <div className="absolute top-full mt-1 left-0 right-0 z-20 bg-[#0a0a0a] border border-white/[0.1] rounded-lg shadow-2xl max-h-80 overflow-hidden flex flex-col">
                    <div className="p-2 border-b border-white/[0.04] shrink-0">
                      <input
                        type="text"
                        value={brandSearch}
                        onChange={e => setBrandSearch(e.target.value)}
                        placeholder="Search brand..."
                        autoFocus
                        className="w-full bg-white/[0.02] border border-white/[0.06] rounded px-2.5 py-1.5 text-xs text-white placeholder:text-zinc-600 focus:outline-none focus:border-white/[0.15]"
                      />
                    </div>
                    <div className="overflow-y-auto">
                      {brandsError ? (
                        <div className="p-3 text-xs text-red-400">{brandsError}</div>
                      ) : filteredBrands.length === 0 ? (
                        <div className="p-3 text-xs text-zinc-500 text-center">
                          {brandSearch ? 'No matching brands' : 'No followed brands yet — follow a brand in Brand Spy first.'}
                        </div>
                      ) : (
                        filteredBrands.map(b => {
                          const active = b.id === selectedBrandId;
                          return (
                            <button
                              key={b.id}
                              type="button"
                              onClick={() => {
                                setSelectedBrandId(b.id);
                                setBrandDropdownOpen(false);
                                setBrandSearch('');
                              }}
                              className={`w-full text-left px-3 py-2 hover:bg-white/[0.04] transition-colors cursor-pointer flex items-center justify-between gap-2 ${
                                active ? 'bg-white/[0.03]' : ''
                              }`}
                            >
                              <div className="min-w-0">
                                <div className="text-sm text-white truncate">
                                  {b.name || b.domain}
                                </div>
                                {b.domain && b.name && (
                                  <div className="text-[10px] text-zinc-500 font-mono truncate">
                                    {b.domain}
                                  </div>
                                )}
                              </div>
                              <div className="flex items-center gap-1.5 shrink-0">
                                {TIER_ORDER.map(t => {
                                  const n = b.tierCounts?.[t] || 0;
                                  if (n === 0) return null;
                                  const meta = TIER_META[t];
                                  const { Icon } = meta;
                                  return (
                                    <span
                                      key={t}
                                      className={`inline-flex items-center gap-0.5 text-[10px] font-mono ${meta.color}`}
                                    >
                                      <Icon className="w-2.5 h-2.5" />
                                      {n}
                                    </span>
                                  );
                                })}
                              </div>
                            </button>
                          );
                        })
                      )}
                    </div>
                  </div>
                )}
              </div>

              {/* Tier filter pills */}
              <div className="flex items-center gap-1.5">
                {TIER_ORDER.map(t => {
                  const meta = TIER_META[t];
                  const active = selectedTiers.has(t);
                  const { Icon, label } = meta;
                  return (
                    <button
                      key={t}
                      type="button"
                      onClick={() => toggleTier(t)}
                      className={`flex-1 flex items-center justify-center gap-1.5 px-2 py-1.5 rounded-md text-[11px] font-mono font-semibold uppercase tracking-wide border transition-all cursor-pointer ${
                        active
                          ? `${meta.activeBg} ${meta.activeBorder} ${meta.activeText}`
                          : 'bg-white/[0.02] border-white/[0.05] text-zinc-500 hover:text-zinc-300 hover:bg-white/[0.04]'
                      }`}
                    >
                      <Icon className="w-3 h-3" />
                      {label}
                    </button>
                  );
                })}
              </div>
            </div>

            {/* Ad list */}
            <div className="flex-1 overflow-y-auto p-3 space-y-2 min-h-0">
              {adsError && (
                <div className="text-xs text-red-400 bg-red-500/10 border border-red-500/20 rounded p-2.5">
                  {adsError}
                </div>
              )}
              {!adsError && loadingAds && ads.length === 0 && (
                <div className="space-y-2">
                  {[0, 1, 2].map(i => (
                    <div key={i} className="h-20 bg-white/[0.02] border border-white/[0.04] rounded-lg animate-pulse" />
                  ))}
                </div>
              )}
              {!adsError && !loadingAds && ads.length === 0 && (
                <div className="flex flex-col items-center justify-center py-12 text-center">
                  <VideoIcon className="w-8 h-8 text-zinc-700 mb-2" />
                  <div className="text-xs text-zinc-500">
                    No video ads at the selected tiers for this brand.
                  </div>
                </div>
              )}
              {ads.map(ad => {
                const isSelected = selectedAd?.id === ad.id;
                const imported = ad.alreadyImported || importedAdIds.has(ad.adArchiveId);
                return (
                  <button
                    key={ad.id}
                    type="button"
                    onClick={() => handleSelectAd(ad)}
                    className={`w-full text-left flex gap-3 p-2.5 rounded-lg border transition-all cursor-pointer ${
                      isSelected
                        ? 'bg-violet-500/10 border-violet-500/40'
                        : 'bg-white/[0.02] border-white/[0.05] hover:bg-white/[0.04] hover:border-white/[0.1]'
                    }`}
                  >
                    {/* Thumb */}
                    <div className="w-16 h-16 rounded bg-black/40 border border-white/[0.04] overflow-hidden shrink-0 relative flex items-center justify-center">
                      {ad.thumbnailUrl ? (
                        <img
                          src={ad.thumbnailUrl}
                          alt=""
                          className="w-full h-full object-cover"
                          onError={(e) => { e.currentTarget.style.display = 'none'; }}
                        />
                      ) : (
                        <Play className="w-4 h-4 text-zinc-600" />
                      )}
                    </div>
                    {/* Info */}
                    <div className="flex-1 min-w-0 flex flex-col gap-1">
                      <div className="flex items-center gap-1.5">
                        <TierBadge tier={ad.tier} />
                        {imported && (
                          <span className="inline-flex items-center gap-1 text-[10px] font-mono uppercase tracking-wider text-emerald-400 bg-emerald-500/10 border border-emerald-500/25 rounded px-1.5 py-0.5">
                            <CheckCircle2 className="w-2.5 h-2.5" />
                            Imported
                          </span>
                        )}
                      </div>
                      {ad.headline && (
                        <div className="text-xs text-zinc-200 line-clamp-2 leading-snug">
                          {ad.headline}
                        </div>
                      )}
                      <div className="text-[10px] text-zinc-500 font-mono">
                        {ad.activeDays != null ? `${ad.activeDays}d active` : '—'}
                        {ad.transcript && <span className="ml-2 text-violet-400/80">· transcript ready</span>}
                      </div>
                    </div>
                  </button>
                );
              })}

              {ads.length > 0 && ads.length < adsTotal && (
                <button
                  type="button"
                  onClick={handleLoadMore}
                  disabled={loadingAds}
                  className="w-full py-2 text-xs font-mono text-zinc-400 hover:text-white bg-white/[0.02] border border-white/[0.05] rounded-lg hover:bg-white/[0.04] hover:border-white/[0.1] transition-colors cursor-pointer disabled:opacity-40"
                >
                  {loadingAds ? (
                    <span className="inline-flex items-center gap-1.5">
                      <Loader2 className="w-3 h-3 animate-spin" /> Loading...
                    </span>
                  ) : (
                    `Load more (${ads.length} / ${adsTotal})`
                  )}
                </button>
              )}
            </div>
          </div>

          {/* RIGHT PANEL ─ Preview */}
          <div className="flex-1 flex flex-col min-h-0 bg-[#0c0c0e]">
            {!selectedAd ? (
              <div className="flex-1 flex flex-col items-center justify-center text-center px-8">
                <VideoIcon className="w-10 h-10 text-zinc-700 mb-3" />
                <div className="text-sm text-zinc-400 mb-1">Select an ad from the list</div>
                <div className="text-xs text-zinc-600">
                  Pick a video to preview, transcribe, and import as a reference.
                </div>
              </div>
            ) : (
              <>
                {/* Preview header */}
                <div className="px-5 py-3 border-b border-white/[0.04] shrink-0 flex items-center gap-3">
                  <TierBadge tier={selectedAd.tier} size="md" />
                  <div className="min-w-0 flex-1">
                    {selectedAd.headline && (
                      <div className="text-sm text-white truncate font-medium">
                        {selectedAd.headline}
                      </div>
                    )}
                    <div className="text-[10px] font-mono text-zinc-500 truncate">
                      {selectedBrand?.name || selectedBrand?.domain || ''}
                      {selectedAd.activeDays != null && ` · ${selectedAd.activeDays}d active`}
                      {' · '}
                      <span className="text-zinc-600">{selectedAd.adArchiveId}</span>
                    </div>
                  </div>
                </div>

                {/* Video + transcript scroll */}
                <div className="flex-1 overflow-y-auto min-h-0">
                  {/* Video */}
                  <div className="p-5">
                    {selectedAd.videoUrl && !videoError ? (
                      <div className="rounded-lg overflow-hidden bg-black border border-white/[0.06]">
                        <video
                          key={selectedAd.id}
                          src={selectedAd.videoUrl}
                          controls
                          playsInline
                          poster={selectedAd.thumbnailUrl || undefined}
                          className="w-full max-h-[40vh] object-contain bg-black"
                          onError={() => setVideoError(true)}
                        />
                      </div>
                    ) : (
                      <div className="rounded-lg border border-white/[0.06] bg-black/40 p-6 text-center">
                        {selectedAd.thumbnailUrl ? (
                          <img
                            src={selectedAd.thumbnailUrl}
                            alt=""
                            className="max-h-[24vh] mx-auto rounded mb-3 opacity-60"
                          />
                        ) : (
                          <VideoIcon className="w-10 h-10 text-zinc-700 mx-auto mb-3" />
                        )}
                        <div className="text-xs text-zinc-400 mb-2">
                          {selectedAd.videoUrl
                            ? "Video can't play inline (Meta CDN blocks it)."
                            : "No direct video URL stored for this ad."}
                        </div>
                        {selectedAd.videoUrl && (
                          <a
                            href={selectedAd.videoUrl}
                            target="_blank"
                            rel="noopener noreferrer"
                            className="inline-flex items-center gap-1.5 px-3 py-1.5 text-[11px] font-mono rounded bg-white/[0.04] border border-white/[0.08] text-zinc-300 hover:text-white hover:bg-white/[0.06] transition-colors"
                          >
                            Open video in new tab
                          </a>
                        )}
                        <div className="text-[10px] text-zinc-600 mt-2">
                          You can still transcribe and import as a reference.
                        </div>
                      </div>
                    )}
                  </div>

                  {/* Transcript */}
                  <div className="px-5 pb-5 space-y-2">
                    <div className="flex items-center justify-between">
                      <div className="text-[10px] font-mono font-semibold text-zinc-500 uppercase tracking-[0.15em] flex items-center gap-1.5">
                        <FileText className="w-3 h-3" />
                        Transcript
                        {selectedAd.transcript && (
                          <span className="text-emerald-400/80 normal-case tracking-normal">
                            · ready
                          </span>
                        )}
                      </div>
                      {!selectedAd.transcript && (
                        <button
                          type="button"
                          onClick={handleTranscribe}
                          disabled={transcribing}
                          className="inline-flex items-center gap-1.5 px-2.5 py-1 text-[11px] font-mono rounded border border-violet-500/30 bg-violet-500/10 text-violet-300 hover:bg-violet-500/15 hover:border-violet-500/50 transition-colors cursor-pointer disabled:opacity-40 disabled:cursor-not-allowed"
                        >
                          {transcribing ? (
                            <>
                              <Loader2 className="w-3 h-3 animate-spin" />
                              Transcribing (30–60s)...
                            </>
                          ) : (
                            <>
                              <Mic className="w-3 h-3" />
                              Transcribe Video
                            </>
                          )}
                        </button>
                      )}
                    </div>

                    {transcriptError && (
                      <div className="text-xs text-red-400 bg-red-500/10 border border-red-500/20 rounded p-2.5 flex items-start gap-2">
                        <AlertCircle className="w-3.5 h-3.5 shrink-0 mt-0.5" />
                        <span>{transcriptError}</span>
                      </div>
                    )}

                    {selectedAd.transcript ? (
                      <div className="bg-white/[0.02] border border-white/[0.06] rounded-lg p-3 max-h-72 overflow-y-auto">
                        <p className="text-xs text-zinc-300 whitespace-pre-wrap leading-relaxed">
                          {selectedAd.transcript}
                        </p>
                      </div>
                    ) : !transcribing && !transcriptError ? (
                      <div className="text-xs text-zinc-500 bg-white/[0.01] border border-dashed border-white/[0.06] rounded-lg p-4 text-center">
                        Click <span className="text-violet-300">Transcribe Video</span> to extract the spoken script.
                      </div>
                    ) : null}
                  </div>
                </div>

                {/* Footer — Import button */}
                <div className="px-5 py-3 border-t border-white/[0.06] shrink-0 flex items-center justify-between gap-3">
                  <div className="text-[10px] font-mono text-zinc-500">
                    {importSuccess
                      ? <span className="text-emerald-400">Imported into Reference column</span>
                      : importError
                        ? <span className="text-red-400">{importError}</span>
                        : 'Transcript is required to enable import.'}
                  </div>
                  <button
                    type="button"
                    onClick={handleImport}
                    disabled={!canImport}
                    className="inline-flex items-center gap-2 px-4 py-2 text-xs font-mono font-semibold uppercase tracking-wider rounded-lg transition-all cursor-pointer disabled:opacity-40 disabled:cursor-not-allowed"
                    style={importSuccess
                      ? { background: 'rgba(16,185,129,0.15)', color: '#6ee7b7', border: '1px solid rgba(16,185,129,0.4)' }
                      : { background: 'linear-gradient(135deg, #8b5cf6, #a78bfa)', color: '#0a0a0a', boxShadow: '0 0 16px rgba(139,92,246,0.25)' }}
                  >
                    {importing ? (
                      <>
                        <Loader2 className="w-3.5 h-3.5 animate-spin" />
                        Importing...
                      </>
                    ) : importSuccess ? (
                      <>
                        <CheckCircle2 className="w-3.5 h-3.5" />
                        Imported!
                      </>
                    ) : (
                      <>
                        <Trophy className="w-3.5 h-3.5" />
                        Import to Reference
                      </>
                    )}
                  </button>
                </div>
              </>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}
