import { useState, useRef, useEffect } from 'react';
import {
  Image,
  Play,
  MoreHorizontal,
  Bookmark,
  UserPlus,
  Link2,
  ExternalLink,
  ChevronRight,
  Clock,
  Globe,
  Layers,
  Star,
  ShoppingCart,
} from 'lucide-react';

const platformColors = {
  facebook: 'bg-blue-600',
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

const flagEmojis = {
  US: '\u{1F1FA}\u{1F1F8}',
  GB: '\u{1F1EC}\u{1F1E7}',
  CA: '\u{1F1E8}\u{1F1E6}',
  AU: '\u{1F1E6}\u{1F1FA}',
  DE: '\u{1F1E9}\u{1F1EA}',
  FR: '\u{1F1EB}\u{1F1F7}',
  JP: '\u{1F1EF}\u{1F1F5}',
  BR: '\u{1F1E7}\u{1F1F7}',
  IN: '\u{1F1EE}\u{1F1F3}',
  MX: '\u{1F1F2}\u{1F1FD}',
};

function formatDuration(seconds) {
  const m = Math.floor(seconds / 60);
  const s = seconds % 60;
  return `${m}:${s.toString().padStart(2, '0')}`;
}

function formatNumber(n) {
  if (n >= 1000000) return (n / 1000000).toFixed(1) + 'M';
  if (n >= 1000) return (n / 1000).toFixed(1) + 'K';
  return n.toString();
}

export default function AdCard({ ad, onClick, onSave, onFollow, variant = 'default' }) {
  const [expanded, setExpanded] = useState(false);
  const [menuOpen, setMenuOpen] = useState(false);
  const menuRef = useRef(null);

  useEffect(() => {
    function handleClick(e) {
      if (menuRef.current && !menuRef.current.contains(e.target)) setMenuOpen(false);
    }
    document.addEventListener('mousedown', handleClick);
    return () => document.removeEventListener('mousedown', handleClick);
  }, []);

  const copyLines = ad.adCopy.split('\n');
  const previewLines = copyLines.slice(0, 3);
  const hasMore = copyLines.length > 3;

  const aspectClasses = {
    square: 'aspect-square',
    landscape: 'aspect-video',
    portrait: 'aspect-[3/4]',
  };

  const isShop = variant === 'shop';

  return (
    <div
      className="group bg-bg-card border border-border-subtle rounded-xl overflow-hidden transition-all duration-200 hover:scale-[1.01] hover:shadow-lg hover:shadow-black/30 hover:border-border-default cursor-pointer break-inside-avoid mb-4"
      onClick={() => onClick?.(ad)}
    >
      {/* Header */}
      <div className="flex items-center gap-2.5 px-3.5 py-2.5">
        <div className="w-8 h-8 rounded-full bg-bg-elevated border border-border-default flex items-center justify-center text-xs font-bold text-text-muted shrink-0">
          {ad.brand.name.charAt(0)}
        </div>
        <div className="min-w-0 flex-1">
          <p className="text-sm font-medium text-text-primary truncate">{ad.brand.name}</p>
          <p className="text-xs text-text-faint truncate">{ad.brand.domain}</p>
        </div>
        <span className={`px-1.5 py-0.5 text-[10px] font-bold text-white rounded ${platformColors[ad.platform]}`}>
          {platformLabels[ad.platform]}
        </span>
        <div ref={menuRef} className="relative">
          <button
            onClick={(e) => {
              e.stopPropagation();
              setMenuOpen(!menuOpen);
            }}
            className="p-1 rounded-md text-text-faint hover:text-text-primary hover:bg-bg-hover transition-colors cursor-pointer"
          >
            <MoreHorizontal className="w-4 h-4" />
          </button>
          {menuOpen && (
            <div className="absolute right-0 top-full mt-1 z-30 w-44 bg-bg-card border border-border-default rounded-lg shadow-xl py-1">
              <button
                onClick={(e) => {
                  e.stopPropagation();
                  onSave?.(ad);
                  setMenuOpen(false);
                }}
                className="w-full flex items-center gap-2 px-3 py-1.5 text-sm text-text-muted hover:text-text-primary hover:bg-bg-hover cursor-pointer"
              >
                <Bookmark className="w-3.5 h-3.5" />
                {ad.saved ? 'Unsave' : 'Save ad'}
              </button>
              <button
                onClick={(e) => {
                  e.stopPropagation();
                  onFollow?.(ad);
                  setMenuOpen(false);
                }}
                className="w-full flex items-center gap-2 px-3 py-1.5 text-sm text-text-muted hover:text-text-primary hover:bg-bg-hover cursor-pointer"
              >
                <UserPlus className="w-3.5 h-3.5" />
                {ad.following ? 'Unfollow brand' : 'Follow brand'}
              </button>
              <button
                onClick={(e) => {
                  e.stopPropagation();
                  navigator.clipboard.writeText(ad.landingPage);
                  setMenuOpen(false);
                }}
                className="w-full flex items-center gap-2 px-3 py-1.5 text-sm text-text-muted hover:text-text-primary hover:bg-bg-hover cursor-pointer"
              >
                <Link2 className="w-3.5 h-3.5" />
                Copy link
              </button>
              <button
                onClick={(e) => {
                  e.stopPropagation();
                  window.open(ad.landingPage, '_blank');
                  setMenuOpen(false);
                }}
                className="w-full flex items-center gap-2 px-3 py-1.5 text-sm text-text-muted hover:text-text-primary hover:bg-bg-hover cursor-pointer"
              >
                <ExternalLink className="w-3.5 h-3.5" />
                Open landing page
              </button>
            </div>
          )}
        </div>
      </div>

      {/* Creative area */}
      <div className={`relative bg-bg-elevated ${aspectClasses[ad.imageAspect] || 'aspect-video'}`}>
        <div className="absolute inset-0 flex items-center justify-center">
          {ad.format === 'video' ? (
            <>
              <Image className="w-10 h-10 text-text-faint/30" />
              <div className="absolute inset-0 flex items-center justify-center">
                <div className="w-12 h-12 rounded-full bg-black/60 flex items-center justify-center backdrop-blur-sm">
                  <Play className="w-5 h-5 text-white ml-0.5" fill="white" />
                </div>
              </div>
              {ad.videoDuration && (
                <span className="absolute bottom-2 right-2 px-1.5 py-0.5 text-[10px] font-medium bg-black/80 text-white rounded">
                  {formatDuration(ad.videoDuration)}
                </span>
              )}
            </>
          ) : ad.format === 'carousel' ? (
            <>
              <Image className="w-10 h-10 text-text-faint/30" />
              <span className="absolute top-2 right-2 flex items-center gap-1 px-1.5 py-0.5 text-[10px] font-medium bg-black/80 text-white rounded">
                <Layers className="w-3 h-3" />
                {ad.carouselCount}
              </span>
            </>
          ) : (
            <Image className="w-10 h-10 text-text-faint/30" />
          )}
        </div>
      </div>

      {/* Ad copy */}
      <div className="px-3.5 pt-3 pb-2">
        <div className="text-sm text-text-primary leading-relaxed">
          {(expanded ? copyLines : previewLines).map((line, i) => (
            <p key={i} className={line === '' ? 'h-3' : ''}>
              {line}
            </p>
          ))}
          {hasMore && !expanded && (
            <button
              onClick={(e) => {
                e.stopPropagation();
                setExpanded(true);
              }}
              className="text-text-faint hover:text-text-primary text-xs mt-1 cursor-pointer"
            >
              See More
            </button>
          )}
        </div>

        {/* CTA Badge */}
        <div className="mt-2.5">
          <span className="inline-flex items-center gap-1 px-2.5 py-1 text-xs font-medium bg-bg-elevated border border-border-default rounded-md text-text-muted">
            {ad.cta}
            <ChevronRight className="w-3 h-3" />
          </span>
        </div>

        {/* Shop variant: price + rating */}
        {isShop && ad.price && (
          <div className="mt-2.5 flex items-center gap-3">
            <span className="text-base font-bold text-text-primary">${ad.price}</span>
            {ad.originalPrice && parseFloat(ad.originalPrice) > parseFloat(ad.price) && (
              <span className="text-xs text-text-faint line-through">${ad.originalPrice}</span>
            )}
            <span className="flex items-center gap-0.5 text-xs text-warning">
              <Star className="w-3 h-3" fill="currentColor" />
              {ad.rating}
            </span>
            <span className="text-xs text-text-faint">
              <ShoppingCart className="w-3 h-3 inline mr-0.5" />
              {formatNumber(ad.soldCount)} sold
            </span>
          </div>
        )}
      </div>

      {/* Footer */}
      <div className="flex items-center justify-between px-3.5 py-2.5 border-t border-border-subtle">
        <div className="flex items-center gap-3 text-[11px] text-text-faint">
          <span className="flex items-center gap-1">
            <Clock className="w-3 h-3" />
            {ad.firstSeen}
          </span>
          <span>{ad.daysRunning}d</span>
          <span className="flex items-center gap-0.5">
            {ad.countries.slice(0, 3).map((c) => (
              <span key={c} title={c}>{flagEmojis[c] || c}</span>
            ))}
            {ad.countries.length > 3 && <span>+{ad.countries.length - 3}</span>}
          </span>
        </div>
        <div className="flex items-center gap-1">
          <button
            onClick={(e) => {
              e.stopPropagation();
              onSave?.(ad);
            }}
            className={`p-1.5 rounded-md transition-colors cursor-pointer ${
              ad.saved
                ? 'text-accent bg-accent-muted'
                : 'text-text-faint hover:text-text-primary hover:bg-bg-hover'
            }`}
            title={ad.saved ? 'Unsave' : 'Save'}
          >
            <Bookmark className="w-3.5 h-3.5" fill={ad.saved ? 'currentColor' : 'none'} />
          </button>
          <button
            onClick={(e) => {
              e.stopPropagation();
              onFollow?.(ad);
            }}
            className={`p-1.5 rounded-md transition-colors cursor-pointer ${
              ad.following
                ? 'text-accent bg-accent-muted'
                : 'text-text-faint hover:text-text-primary hover:bg-bg-hover'
            }`}
            title={ad.following ? 'Unfollow' : 'Follow brand'}
          >
            <UserPlus className="w-3.5 h-3.5" />
          </button>
        </div>
      </div>
    </div>
  );
}
