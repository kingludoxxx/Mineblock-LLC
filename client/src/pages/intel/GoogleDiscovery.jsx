import { useState, useMemo, useCallback } from 'react';
import { Search as SearchIcon, Monitor, Smartphone, Layout } from 'lucide-react';
import FilterBar from '../../components/intel/FilterBar';
import AdCard from '../../components/intel/AdCard';
import AdDetailModal from '../../components/intel/AdDetailModal';
import { generateGoogleAds, languages, countries } from '../../utils/mockData';

const initialAds = generateGoogleAds(40);

const defaultFilters = {
  search: '',
  dateRange: 'all',
  platform: '',
  format: '',
  languages: [],
  countries: [],
  sort: 'newest',
  adType: '',
};

export default function GoogleDiscovery() {
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
          ad.adCopy.toLowerCase().includes(q) ||
          ad.landingPage.toLowerCase().includes(q)
      );
    }

    if (filters.format) {
      result = result.filter((ad) => ad.format === filters.format);
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

  const similarAds = selectedAd
    ? ads.filter((a) => a.id !== selectedAd.id && a.brand.id === selectedAd.brand.id).slice(0, 6)
    : [];

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-xl font-bold text-text-primary">Google Ad Discovery</h1>
        <p className="text-sm text-text-muted mt-1">
          Discover display, search, and shopping ads on Google
        </p>
      </div>

      <FilterBar
        filters={filters}
        onFilterChange={setFilters}
        platformOptions={[]}
        formatOptions={[
          { value: 'image', label: 'Display' },
          { value: 'video', label: 'Video' },
          { value: 'carousel', label: 'Shopping' },
        ]}
        languageOptions={languages}
        countryOptions={countries}
        extraFilters={
          <div className="flex items-center gap-1 px-1 py-0.5 bg-bg-elevated border border-border-default rounded-lg">
            {[
              { value: '', icon: Layout, label: 'All' },
              { value: 'desktop', icon: Monitor, label: 'Desktop' },
              { value: 'mobile', icon: Smartphone, label: 'Mobile' },
            ].map(({ value, icon: Icon, label }) => (
              <button
                key={value}
                onClick={() => setFilters((f) => ({ ...f, adType: value }))}
                className={`flex items-center gap-1 px-2 py-1 text-xs rounded-md transition-colors cursor-pointer ${
                  filters.adType === value
                    ? 'bg-bg-hover text-text-primary'
                    : 'text-text-faint hover:text-text-muted'
                }`}
              >
                <Icon className="w-3.5 h-3.5" />
                {label}
              </button>
            ))}
          </div>
        }
      />

      <div className="text-xs text-text-faint">{filtered.length} ads found</div>

      {filtered.length > 0 ? (
        <>
          <div className="columns-1 sm:columns-2 lg:columns-3 xl:columns-4 gap-4">
            {visible.map((ad) => (
              <AdCard
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
        similarAds={similarAds}
        onAdClick={setSelectedAd}
      />
    </div>
  );
}
