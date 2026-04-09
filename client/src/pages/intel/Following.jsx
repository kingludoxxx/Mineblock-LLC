import { useState, useMemo, useCallback } from 'react';
import { UserPlus, Bell } from 'lucide-react';
import AdCard from '../../components/intel/AdCard';
import AdDetailModal from '../../components/intel/AdDetailModal';
import { generateMetaAds } from '../../utils/mockData';
import { toLocalDateStr } from '../../utils/dateUtils';

// Simulate followed brands' ads
const initialAds = generateMetaAds(30).map((ad) => ({ ...ad, following: true }));

export default function Following() {
  const [ads, setAds] = useState(initialAds);
  const [selectedAd, setSelectedAd] = useState(null);
  const [visibleCount, setVisibleCount] = useState(20);
  const [viewMode, setViewMode] = useState('all'); // 'all' | 'new'

  const filtered = useMemo(() => {
    let result = ads.filter((ad) => ad.following);
    if (viewMode === 'new') {
      const weekAgo = toLocalDateStr(new Date(Date.now() - 7 * 86400000));
      result = result.filter((ad) => ad.firstSeen >= weekAgo);
    }
    return result.sort((a, b) => b.firstSeen.localeCompare(a.firstSeen));
  }, [ads, viewMode]);

  const visible = filtered.slice(0, visibleCount);

  const toggleSave = useCallback((ad) => {
    setAds((prev) => prev.map((a) => (a.id === ad.id ? { ...a, saved: !a.saved } : a)));
  }, []);

  const toggleFollow = useCallback((ad) => {
    setAds((prev) => prev.map((a) => (a.brand.id === ad.brand.id ? { ...a, following: !a.following } : a)));
  }, []);

  const followedBrands = useMemo(() => {
    const seen = new Set();
    return ads
      .filter((ad) => {
        if (ad.following && !seen.has(ad.brand.id)) {
          seen.add(ad.brand.id);
          return true;
        }
        return false;
      })
      .map((ad) => ad.brand);
  }, [ads]);

  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-xl font-bold text-text-primary">Following</h1>
          <p className="text-sm text-text-muted mt-1">
            Latest ads from brands you follow
          </p>
        </div>
        <div className="flex items-center gap-1 px-1 py-0.5 bg-bg-elevated border border-border-default rounded-lg">
          <button
            onClick={() => setViewMode('all')}
            className={`px-3 py-1.5 text-xs font-medium rounded-md transition-colors cursor-pointer ${
              viewMode === 'all' ? 'bg-bg-hover text-text-primary' : 'text-text-faint hover:text-text-muted'
            }`}
          >
            All
          </button>
          <button
            onClick={() => setViewMode('new')}
            className={`px-3 py-1.5 text-xs font-medium rounded-md transition-colors cursor-pointer ${
              viewMode === 'new' ? 'bg-bg-hover text-text-primary' : 'text-text-faint hover:text-text-muted'
            }`}
          >
            New this week
          </button>
        </div>
      </div>

      {/* Followed brands strip */}
      {followedBrands.length > 0 && (
        <div className="flex items-center gap-3 overflow-x-auto pb-2">
          {followedBrands.map((brand) => (
            <div key={brand.id} className="flex flex-col items-center gap-1 shrink-0">
              <div className="w-12 h-12 rounded-full bg-bg-elevated border-2 border-accent flex items-center justify-center text-sm font-bold text-text-muted">
                {brand.name.charAt(0)}
              </div>
              <span className="text-[10px] text-text-faint truncate max-w-[60px]">{brand.name}</span>
            </div>
          ))}
        </div>
      )}

      <div className="text-xs text-text-faint">
        {filtered.length} ads from {followedBrands.length} followed brands
      </div>

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
          {followedBrands.length === 0 ? (
            <>
              <UserPlus className="w-12 h-12 text-text-faint/30 mb-4" />
              <p className="text-text-muted font-medium">No brands followed yet</p>
              <p className="text-sm text-text-faint mt-1">Follow brands to see their latest ads here</p>
            </>
          ) : (
            <>
              <Bell className="w-12 h-12 text-text-faint/30 mb-4" />
              <p className="text-text-muted font-medium">No new ads this week</p>
              <p className="text-sm text-text-faint mt-1">Check back later or view all ads</p>
            </>
          )}
        </div>
      )}

      <AdDetailModal
        ad={selectedAd}
        open={!!selectedAd}
        onClose={() => setSelectedAd(null)}
        onSave={toggleSave}
        similarAds={ads.filter((a) => selectedAd && a.id !== selectedAd.id && a.brand.id === selectedAd.brand.id).slice(0, 6)}
        onAdClick={setSelectedAd}
      />
    </div>
  );
}
