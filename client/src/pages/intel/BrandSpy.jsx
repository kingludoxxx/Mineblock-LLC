import { useState, useMemo, useRef, useEffect } from 'react';
import { Search, Radar, Globe, BarChart3, ExternalLink, UserPlus, UserCheck } from 'lucide-react';
import { brands } from '../../utils/mockData';

const platformColors = {
  facebook: 'bg-accent',
  instagram: 'bg-gradient-to-br from-purple-600 to-pink-500',
  google: 'bg-emerald-600',
  youtube: 'bg-red-600',
  tiktok: 'bg-gray-800',
};

const platformLabels = {
  facebook: 'FB',
  instagram: 'IG',
  google: 'G',
  youtube: 'YT',
  tiktok: 'TT',
};

// Extend brands with more mock data
const extendedBrands = brands.map((b) => ({
  ...b,
  platforms: ['facebook', 'instagram', 'google', 'youtube', 'tiktok']
    .filter(() => Math.random() > 0.3),
  following: false,
  description: `Leading brand in their category. Running ads across multiple platforms.`,
  topCountries: ['US', 'GB', 'CA'].slice(0, Math.floor(Math.random() * 3) + 1),
  avgDaysRunning: Math.floor(Math.random() * 60) + 5,
  activeAds: Math.floor(Math.random() * 200) + 10,
}));

export default function BrandSpy() {
  const [search, setSearch] = useState('');
  const [brandList, setBrandList] = useState(extendedBrands);
  const [showSuggestions, setShowSuggestions] = useState(false);
  const searchRef = useRef(null);

  useEffect(() => {
    function handleClick(e) {
      if (searchRef.current && !searchRef.current.contains(e.target)) {
        setShowSuggestions(false);
      }
    }
    document.addEventListener('mousedown', handleClick);
    return () => document.removeEventListener('mousedown', handleClick);
  }, []);

  const filtered = useMemo(() => {
    if (!search) return brandList;
    const q = search.toLowerCase();
    return brandList.filter(
      (b) =>
        b.name.toLowerCase().includes(q) ||
        b.domain.toLowerCase().includes(q)
    );
  }, [brandList, search]);

  const suggestions = useMemo(() => {
    if (!search || search.length < 2) return [];
    const q = search.toLowerCase();
    return brandList
      .filter((b) => b.name.toLowerCase().includes(q))
      .slice(0, 5);
  }, [brandList, search]);

  const toggleFollow = (brandId) => {
    setBrandList((prev) =>
      prev.map((b) => (b.id === brandId ? { ...b, following: !b.following } : b))
    );
  };

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-xl font-bold text-text-primary">Brand Spy</h1>
        <p className="text-sm text-text-muted mt-1">
          Research any brand's advertising strategy across platforms
        </p>
      </div>

      {/* Search with autocomplete */}
      <div ref={searchRef} className="relative max-w-xl">
        <Search className="absolute left-3 top-1/2 -translate-y-1/2 w-5 h-5 text-text-faint" />
        <input
          type="text"
          value={search}
          onChange={(e) => {
            setSearch(e.target.value);
            setShowSuggestions(true);
          }}
          onFocus={() => setShowSuggestions(true)}
          placeholder="Search for a brand by name or domain..."
          className="w-full pl-11 pr-4 py-3 text-sm bg-bg-elevated border border-border-default rounded-xl text-text-primary placeholder:text-text-faint focus:outline-none focus:ring-2 focus:ring-accent/40 focus:border-accent transition-colors"
        />

        {/* Autocomplete dropdown */}
        {showSuggestions && suggestions.length > 0 && (
          <div className="absolute top-full mt-1 left-0 right-0 z-40 bg-bg-card border border-border-default rounded-xl shadow-xl overflow-hidden">
            {suggestions.map((brand) => (
              <button
                key={brand.id}
                onClick={() => {
                  setSearch(brand.name);
                  setShowSuggestions(false);
                }}
                className="w-full flex items-center gap-3 px-4 py-2.5 text-left hover:bg-bg-hover transition-colors cursor-pointer"
              >
                <div className="w-8 h-8 rounded-full bg-bg-elevated border border-border-default flex items-center justify-center text-xs font-bold text-text-muted">
                  {brand.name.charAt(0)}
                </div>
                <div>
                  <p className="text-sm font-medium text-text-primary">{brand.name}</p>
                  <p className="text-xs text-text-faint">{brand.domain}</p>
                </div>
                <span className="ml-auto text-xs text-text-faint">{brand.adCount} ads</span>
              </button>
            ))}
          </div>
        )}
      </div>

      {/* Brand cards grid */}
      <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4 gap-4">
        {filtered.map((brand) => (
          <div
            key={brand.id}
            className="bg-bg-card border border-border-subtle rounded-xl p-4 transition-all duration-200 hover:border-border-default hover:shadow-lg hover:shadow-black/20"
          >
            {/* Brand header */}
            <div className="flex items-start gap-3 mb-3">
              <div className="w-12 h-12 rounded-full bg-bg-elevated border border-border-default flex items-center justify-center text-lg font-bold text-text-muted shrink-0">
                {brand.name.charAt(0)}
              </div>
              <div className="min-w-0 flex-1">
                <h3 className="text-sm font-semibold text-text-primary truncate">{brand.name}</h3>
                <p className="text-xs text-text-faint">{brand.domain}</p>
              </div>
            </div>

            {/* Platform badges */}
            <div className="flex items-center gap-1 mb-3">
              {brand.platforms.map((p) => (
                <span
                  key={p}
                  className={`px-1.5 py-0.5 text-[10px] font-bold text-white rounded ${platformColors[p]}`}
                >
                  {platformLabels[p]}
                </span>
              ))}
            </div>

            {/* Stats */}
            <div className="grid grid-cols-2 gap-2 mb-3">
              <div className="bg-bg-elevated rounded-lg p-2 text-center">
                <p className="text-xs text-text-faint">Total Ads</p>
                <p className="text-sm font-bold text-text-primary">{brand.adCount.toLocaleString()}</p>
              </div>
              <div className="bg-bg-elevated rounded-lg p-2 text-center">
                <p className="text-xs text-text-faint">Active</p>
                <p className="text-sm font-bold text-text-primary">{brand.activeAds}</p>
              </div>
            </div>

            {/* Actions */}
            <div className="flex items-center gap-2">
              <button
                onClick={() => toggleFollow(brand.id)}
                className={`flex-1 flex items-center justify-center gap-1.5 px-3 py-1.5 text-xs font-medium rounded-lg transition-colors cursor-pointer ${
                  brand.following
                    ? 'bg-accent text-white'
                    : 'bg-bg-elevated border border-border-default text-text-primary hover:bg-bg-hover'
                }`}
              >
                {brand.following ? (
                  <>
                    <UserCheck className="w-3.5 h-3.5" />
                    Following
                  </>
                ) : (
                  <>
                    <UserPlus className="w-3.5 h-3.5" />
                    Follow
                  </>
                )}
              </button>
              <button className="p-1.5 rounded-lg bg-bg-elevated border border-border-default text-text-muted hover:text-text-primary hover:bg-bg-hover transition-colors cursor-pointer">
                <ExternalLink className="w-3.5 h-3.5" />
              </button>
            </div>
          </div>
        ))}
      </div>

      {filtered.length === 0 && (
        <div className="flex flex-col items-center justify-center py-20">
          <Radar className="w-12 h-12 text-text-faint/30 mb-4" />
          <p className="text-text-muted font-medium">No brands found</p>
          <p className="text-sm text-text-faint mt-1">Try searching for a different brand name</p>
        </div>
      )}
    </div>
  );
}
