import { useState, useMemo, useCallback } from 'react';
import { Search as SearchIcon, Play, Image, Eye, Heart, MessageCircle, Share2, Clock, Bookmark, UserPlus } from 'lucide-react';
import FilterBar from '../../components/intel/FilterBar';
import AdDetailModal from '../../components/intel/AdDetailModal';
import { generateTikTokOrganic, languages, countries } from '../../utils/mockData';
import { toLocalDateStr } from '../../utils/dateUtils';

const initialAds = generateTikTokOrganic(40);

const defaultFilters = {
  search: '',
  dateRange: 'all',
  platform: '',
  format: '',
  languages: [],
  countries: [],
  sort: 'newest',
};

function formatNumber(n) {
  if (n >= 1000000) return (n / 1000000).toFixed(1) + 'M';
  if (n >= 1000) return (n / 1000).toFixed(1) + 'K';
  return n.toString();
}

function formatDuration(seconds) {
  const m = Math.floor(seconds / 60);
  const s = seconds % 60;
  return `${m}:${s.toString().padStart(2, '0')}`;
}

function OrganicCard({ ad, onClick, onSave, onFollow }) {
  const copyLines = ad.adCopy.split('\n');

  return (
    <div
      className="group bg-bg-card border border-border-subtle rounded-xl overflow-hidden transition-all duration-200 hover:scale-[1.01] hover:shadow-lg hover:shadow-black/30 hover:border-border-default cursor-pointer break-inside-avoid mb-4"
      onClick={() => onClick?.(ad)}
    >
      {/* Video thumbnail */}
      <div className="relative aspect-[9/16] bg-bg-elevated">
        <div className="absolute inset-0 flex items-center justify-center">
          <Image className="w-10 h-10 text-text-faint/20" />
        </div>
        <div className="absolute inset-0 flex items-center justify-center opacity-0 group-hover:opacity-100 transition-opacity">
          <div className="w-12 h-12 rounded-full bg-black/60 flex items-center justify-center backdrop-blur-sm">
            <Play className="w-5 h-5 text-white ml-0.5" fill="white" />
          </div>
        </div>
        {ad.videoDuration && (
          <span className="absolute bottom-2 right-2 px-1.5 py-0.5 text-[10px] font-medium bg-black/80 text-white rounded">
            {formatDuration(ad.videoDuration)}
          </span>
        )}
        <span className="absolute top-2 left-2 px-1.5 py-0.5 text-[10px] font-bold bg-green-600 text-white rounded">
          ORGANIC
        </span>

        {/* Engagement overlay at bottom */}
        <div className="absolute bottom-0 left-0 right-0 bg-gradient-to-t from-black/80 to-transparent p-3 pt-8">
          <div className="flex items-center gap-3 text-white text-[11px]">
            <span className="flex items-center gap-1">
              <Eye className="w-3 h-3" />
              {formatNumber(ad.views)}
            </span>
            <span className="flex items-center gap-1">
              <Heart className="w-3 h-3" />
              {formatNumber(ad.likes)}
            </span>
            <span className="flex items-center gap-1">
              <MessageCircle className="w-3 h-3" />
              {formatNumber(ad.comments)}
            </span>
            <span className="flex items-center gap-1">
              <Share2 className="w-3 h-3" />
              {formatNumber(ad.shares)}
            </span>
          </div>
        </div>
      </div>

      {/* Info */}
      <div className="p-3">
        <div className="flex items-center gap-2 mb-2">
          <div className="w-7 h-7 rounded-full bg-bg-elevated border border-border-default flex items-center justify-center text-[10px] font-bold text-text-muted shrink-0">
            {ad.brand.name.charAt(0)}
          </div>
          <span className="text-xs font-medium text-text-primary truncate">{ad.brand.name}</span>
        </div>
        <p className="text-xs text-text-muted line-clamp-2 leading-relaxed">{copyLines[0]}</p>
        <div className="flex items-center justify-between mt-2">
          <span className="text-[10px] text-text-faint flex items-center gap-1">
            <Clock className="w-3 h-3" />
            {ad.firstSeen}
          </span>
          <div className="flex items-center gap-1">
            <button
              onClick={(e) => { e.stopPropagation(); onSave?.(ad); }}
              className={`p-1 rounded-md transition-colors cursor-pointer ${
                ad.saved ? 'text-accent' : 'text-text-faint hover:text-text-primary'
              }`}
            >
              <Bookmark className="w-3 h-3" fill={ad.saved ? 'currentColor' : 'none'} />
            </button>
            <button
              onClick={(e) => { e.stopPropagation(); onFollow?.(ad); }}
              className={`p-1 rounded-md transition-colors cursor-pointer ${
                ad.following ? 'text-accent' : 'text-text-faint hover:text-text-primary'
              }`}
            >
              <UserPlus className="w-3 h-3" />
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}

export default function TikTokOrganic() {
  const [ads, setAds] = useState(initialAds);
  const [filters, setFilters] = useState(defaultFilters);
  const [selectedAd, setSelectedAd] = useState(null);
  const [visibleCount, setVisibleCount] = useState(20);

  const filtered = useMemo(() => {
    let result = [...ads];

    if (filters.search) {
      const q = filters.search.toLowerCase();
      result = result.filter(
        (ad) =>
          ad.brand.name.toLowerCase().includes(q) ||
          ad.adCopy.toLowerCase().includes(q)
      );
    }

    if (filters.languages.length > 0) {
      result = result.filter((ad) => filters.languages.includes(ad.language));
    }

    if (filters.countries.length > 0) {
      result = result.filter((ad) => ad.countries.some((c) => filters.countries.includes(c)));
    }

    if (filters.dateRange !== 'all') {
      const days = { '7d': 7, '30d': 30, '90d': 90 }[filters.dateRange];
      if (days) {
        const cutoff = toLocalDateStr(new Date(Date.now() - days * 86400000));
        result = result.filter((ad) => ad.firstSeen >= cutoff);
      }
    }

    result.sort((a, b) => {
      switch (filters.sort) {
        case 'oldest': return a.firstSeen.localeCompare(b.firstSeen);
        case 'longest': return b.daysRunning - a.daysRunning;
        case 'recent': return b.lastSeen.localeCompare(a.lastSeen);
        default: return b.firstSeen.localeCompare(a.firstSeen);
      }
    });

    return result;
  }, [ads, filters]);

  const visible = filtered.slice(0, visibleCount);

  const toggleSave = useCallback((ad) => {
    setAds((prev) => prev.map((a) => (a.id === ad.id ? { ...a, saved: !a.saved } : a)));
  }, []);

  const toggleFollow = useCallback((ad) => {
    setAds((prev) => prev.map((a) => (a.brand.id === ad.brand.id ? { ...a, following: !a.following } : a)));
  }, []);

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-xl font-bold text-text-primary">TikTok Organic Discovery</h1>
        <p className="text-sm text-text-muted mt-1">
          Discover trending organic content and viral videos on TikTok
        </p>
      </div>

      <FilterBar
        filters={filters}
        onFilterChange={setFilters}
        platformOptions={[]}
        formatOptions={[]}
        languageOptions={languages}
        countryOptions={countries}
      />

      <div className="text-xs text-text-faint">{filtered.length} videos found</div>

      {filtered.length > 0 ? (
        <>
          <div className="columns-2 sm:columns-3 lg:columns-4 xl:columns-5 gap-4">
            {visible.map((ad) => (
              <OrganicCard
                key={ad.id}
                ad={ad}
                onClick={setSelectedAd}
                onSave={toggleSave}
                onFollow={toggleFollow}
              />
            ))}
          </div>

          {visibleCount < filtered.length && (
            <div className="flex justify-center pt-4">
              <button
                onClick={() => setVisibleCount((c) => c + 20)}
                className="px-6 py-2.5 text-sm font-medium bg-bg-elevated border border-border-default rounded-lg text-text-primary hover:bg-bg-hover transition-colors cursor-pointer"
              >
                Load more ({filtered.length - visibleCount} remaining)
              </button>
            </div>
          )}
        </>
      ) : (
        <div className="flex flex-col items-center justify-center py-20">
          <SearchIcon className="w-12 h-12 text-text-faint/30 mb-4" />
          <p className="text-text-muted font-medium">No videos found</p>
          <p className="text-sm text-text-faint mt-1">Try adjusting your filters or search terms</p>
        </div>
      )}

      <AdDetailModal
        ad={selectedAd}
        open={!!selectedAd}
        onClose={() => setSelectedAd(null)}
        onSave={toggleSave}
        similarAds={ads.filter((a) => selectedAd && a.id !== selectedAd.id).slice(0, 6)}
        onAdClick={setSelectedAd}
      />
    </div>
  );
}
