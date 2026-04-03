import { useState, useMemo, useCallback } from 'react';
import { Search as SearchIcon, Play, Image, Clock } from 'lucide-react';
import FilterBar from '../../components/intel/FilterBar';
import AdDetailModal from '../../components/intel/AdDetailModal';
import { generateYouTubeAds, languages, countries } from '../../utils/mockData';
import { Bookmark, UserPlus } from 'lucide-react';

const initialAds = generateYouTubeAds(40);

const defaultFilters = {
  search: '',
  dateRange: 'all',
  platform: '',
  format: '',
  languages: [],
  countries: [],
  sort: 'newest',
};

const flagEmojis = {
  US: '\u{1F1FA}\u{1F1F8}', GB: '\u{1F1EC}\u{1F1E7}', CA: '\u{1F1E8}\u{1F1E6}',
  AU: '\u{1F1E6}\u{1F1FA}', DE: '\u{1F1E9}\u{1F1EA}', FR: '\u{1F1EB}\u{1F1F7}',
  JP: '\u{1F1EF}\u{1F1F5}', BR: '\u{1F1E7}\u{1F1F7}', IN: '\u{1F1EE}\u{1F1F3}',
  MX: '\u{1F1F2}\u{1F1FD}',
};

function formatDuration(seconds) {
  const m = Math.floor(seconds / 60);
  const s = seconds % 60;
  return `${m}:${s.toString().padStart(2, '0')}`;
}

function VideoCard({ ad, onClick, onSave, onFollow }) {
  const copyLines = ad.adCopy.split('\n');

  return (
    <div
      className="group bg-bg-card border border-border-subtle rounded-xl overflow-hidden transition-all duration-200 hover:scale-[1.01] hover:shadow-lg hover:shadow-black/30 hover:border-border-default cursor-pointer"
      onClick={() => onClick?.(ad)}
    >
      {/* Video thumbnail with duration overlay */}
      <div className="relative aspect-video bg-bg-elevated">
        <div className="absolute inset-0 flex items-center justify-center">
          <Image className="w-12 h-12 text-text-faint/20" />
        </div>
        <div className="absolute inset-0 flex items-center justify-center opacity-0 group-hover:opacity-100 transition-opacity">
          <div className="w-14 h-14 rounded-full bg-black/60 flex items-center justify-center backdrop-blur-sm">
            <Play className="w-6 h-6 text-white ml-0.5" fill="white" />
          </div>
        </div>
        {ad.videoDuration && (
          <span className="absolute bottom-2 right-2 px-1.5 py-0.5 text-[11px] font-medium bg-black/90 text-white rounded">
            {formatDuration(ad.videoDuration)}
          </span>
        )}
        <span className="absolute top-2 left-2 px-1.5 py-0.5 text-[10px] font-bold bg-red-600 text-white rounded">
          AD
        </span>
      </div>

      {/* Info */}
      <div className="p-3">
        <div className="flex gap-2.5">
          <div className="w-9 h-9 rounded-full bg-bg-elevated border border-border-default flex items-center justify-center text-xs font-bold text-text-muted shrink-0 mt-0.5">
            {ad.brand.name.charAt(0)}
          </div>
          <div className="min-w-0 flex-1">
            <p className="text-sm font-medium text-text-primary line-clamp-2 leading-snug">
              {copyLines[0]}
            </p>
            <p className="text-xs text-text-faint mt-1">{ad.brand.name}</p>
            <div className="flex items-center gap-2 mt-1 text-[11px] text-text-faint">
              <span className="flex items-center gap-1">
                <Clock className="w-3 h-3" />
                {ad.firstSeen}
              </span>
              <span>{ad.daysRunning}d running</span>
              <span>
                {ad.countries.slice(0, 2).map((c) => flagEmojis[c] || c).join(' ')}
              </span>
            </div>
          </div>
        </div>
      </div>

      {/* Actions */}
      <div className="flex items-center justify-between px-3 py-2 border-t border-border-subtle">
        <span className="text-[11px] text-text-faint">{ad.language}</span>
        <div className="flex items-center gap-1">
          <button
            onClick={(e) => { e.stopPropagation(); onSave?.(ad); }}
            className={`p-1.5 rounded-md transition-colors cursor-pointer ${
              ad.saved ? 'text-accent bg-accent-muted' : 'text-text-faint hover:text-text-primary hover:bg-bg-hover'
            }`}
          >
            <Bookmark className="w-3.5 h-3.5" fill={ad.saved ? 'currentColor' : 'none'} />
          </button>
          <button
            onClick={(e) => { e.stopPropagation(); onFollow?.(ad); }}
            className={`p-1.5 rounded-md transition-colors cursor-pointer ${
              ad.following ? 'text-accent bg-accent-muted' : 'text-text-faint hover:text-text-primary hover:bg-bg-hover'
            }`}
          >
            <UserPlus className="w-3.5 h-3.5" />
          </button>
        </div>
      </div>
    </div>
  );
}

export default function YouTubeDiscovery() {
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
        const cutoff = new Date(Date.now() - days * 86400000).toISOString().split('T')[0];
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
        <h1 className="text-xl font-bold text-text-primary">YouTube Ad Discovery</h1>
        <p className="text-sm text-text-muted mt-1">
          Discover video ads running on YouTube
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

      <div className="text-xs text-text-faint">{filtered.length} ads found</div>

      {filtered.length > 0 ? (
        <>
          <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4 gap-4">
            {visible.map((ad) => (
              <VideoCard
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
          <p className="text-text-muted font-medium">No ads found</p>
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
