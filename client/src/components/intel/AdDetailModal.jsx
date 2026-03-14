import { useState } from 'react';
import {
  X,
  Image,
  Play,
  Layers,
  ExternalLink,
  Bookmark,
  Download,
  Share2,
  Clock,
  Calendar,
  Globe,
  Target,
  ChevronRight,
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
  facebook: 'Facebook',
  instagram: 'Instagram',
  google: 'Google',
  youtube: 'YouTube',
  tiktok: 'TikTok',
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

export default function AdDetailModal({ ad, open, onClose, onSave, similarAds = [], onAdClick }) {
  const [copyExpanded, setCopyExpanded] = useState(false);

  if (!open || !ad) return null;

  const copyLines = ad.adCopy.split('\n');

  return (
    <div
      className="fixed inset-0 z-50 flex items-start justify-center bg-black/70 backdrop-blur-sm overflow-y-auto py-8"
      onClick={(e) => {
        if (e.target === e.currentTarget) onClose();
      }}
    >
      <div className="w-full max-w-3xl mx-4 bg-bg-card border border-border-default rounded-xl shadow-2xl">
        {/* Header */}
        <div className="flex items-center justify-between px-5 py-4 border-b border-border-subtle">
          <div className="flex items-center gap-3">
            <div className="w-10 h-10 rounded-full bg-bg-elevated border border-border-default flex items-center justify-center text-sm font-bold text-text-muted">
              {ad.brand.name.charAt(0)}
            </div>
            <div>
              <p className="text-sm font-semibold text-text-primary">{ad.brand.name}</p>
              <p className="text-xs text-text-faint">{ad.brand.domain}</p>
            </div>
            <span className={`px-2 py-0.5 text-[11px] font-bold text-white rounded ${platformColors[ad.platform]}`}>
              {platformLabels[ad.platform]}
            </span>
          </div>
          <button
            onClick={onClose}
            className="p-1.5 rounded-md text-text-muted hover:text-text-primary hover:bg-bg-hover transition-colors cursor-pointer"
          >
            <X className="w-5 h-5" />
          </button>
        </div>

        {/* Creative preview */}
        <div className="relative bg-bg-elevated aspect-video mx-5 mt-4 rounded-lg overflow-hidden">
          <div className="absolute inset-0 flex items-center justify-center">
            {ad.format === 'video' ? (
              <>
                <Image className="w-16 h-16 text-text-faint/20" />
                <div className="absolute inset-0 flex items-center justify-center">
                  <div className="w-16 h-16 rounded-full bg-black/60 flex items-center justify-center backdrop-blur-sm cursor-pointer hover:bg-black/80 transition-colors">
                    <Play className="w-7 h-7 text-white ml-1" fill="white" />
                  </div>
                </div>
                {ad.videoDuration && (
                  <span className="absolute bottom-3 right-3 px-2 py-1 text-xs font-medium bg-black/80 text-white rounded">
                    {formatDuration(ad.videoDuration)}
                  </span>
                )}
              </>
            ) : ad.format === 'carousel' ? (
              <>
                <Image className="w-16 h-16 text-text-faint/20" />
                <span className="absolute top-3 right-3 flex items-center gap-1 px-2 py-1 text-xs font-medium bg-black/80 text-white rounded">
                  <Layers className="w-3.5 h-3.5" />
                  {ad.carouselCount} images
                </span>
              </>
            ) : (
              <Image className="w-16 h-16 text-text-faint/20" />
            )}
          </div>
        </div>

        {/* Content */}
        <div className="px-5 py-4 space-y-4">
          {/* Ad copy */}
          <div>
            <h3 className="text-xs font-semibold text-text-faint uppercase tracking-wider mb-2">Ad Copy</h3>
            <div className="text-sm text-text-primary leading-relaxed bg-bg-elevated rounded-lg p-3">
              {(copyExpanded ? copyLines : copyLines.slice(0, 4)).map((line, i) => (
                <p key={i} className={line === '' ? 'h-3' : ''}>
                  {line}
                </p>
              ))}
              {copyLines.length > 4 && (
                <button
                  onClick={() => setCopyExpanded(!copyExpanded)}
                  className="text-accent text-xs mt-2 cursor-pointer hover:underline"
                >
                  {copyExpanded ? 'Show less' : 'Show full copy'}
                </button>
              )}
            </div>
          </div>

          {/* CTA */}
          <div>
            <h3 className="text-xs font-semibold text-text-faint uppercase tracking-wider mb-2">Call to Action</h3>
            <span className="inline-flex items-center gap-1.5 px-3 py-1.5 text-sm font-medium bg-accent text-white rounded-lg">
              {ad.cta}
              <ChevronRight className="w-3.5 h-3.5" />
            </span>
          </div>

          {/* Landing page */}
          <div>
            <h3 className="text-xs font-semibold text-text-faint uppercase tracking-wider mb-2">Landing Page</h3>
            <div className="flex items-center gap-2">
              <p className="text-sm text-text-muted truncate flex-1">{ad.landingPage}</p>
              <button
                onClick={() => window.open(ad.landingPage, '_blank')}
                className="flex items-center gap-1.5 px-3 py-1.5 text-sm font-medium bg-bg-elevated border border-border-default rounded-lg text-text-primary hover:bg-bg-hover transition-colors cursor-pointer"
              >
                <ExternalLink className="w-3.5 h-3.5" />
                Visit
              </button>
            </div>
          </div>

          {/* Timeline */}
          <div>
            <h3 className="text-xs font-semibold text-text-faint uppercase tracking-wider mb-2">Timeline</h3>
            <div className="grid grid-cols-3 gap-3">
              <div className="bg-bg-elevated rounded-lg p-3 text-center">
                <Calendar className="w-4 h-4 text-text-faint mx-auto mb-1" />
                <p className="text-xs text-text-faint">First seen</p>
                <p className="text-sm font-medium text-text-primary">{ad.firstSeen}</p>
              </div>
              <div className="bg-bg-elevated rounded-lg p-3 text-center">
                <Calendar className="w-4 h-4 text-text-faint mx-auto mb-1" />
                <p className="text-xs text-text-faint">Last seen</p>
                <p className="text-sm font-medium text-text-primary">{ad.lastSeen}</p>
              </div>
              <div className="bg-bg-elevated rounded-lg p-3 text-center">
                <Clock className="w-4 h-4 text-text-faint mx-auto mb-1" />
                <p className="text-xs text-text-faint">Days running</p>
                <p className="text-sm font-medium text-text-primary">{ad.daysRunning}</p>
              </div>
            </div>
          </div>

          {/* Targeting insights */}
          <div>
            <h3 className="text-xs font-semibold text-text-faint uppercase tracking-wider mb-2">Targeting Insights</h3>
            <div className="bg-bg-elevated rounded-lg p-3 space-y-2">
              <div className="flex items-center gap-2">
                <Globe className="w-4 h-4 text-text-faint" />
                <span className="text-xs text-text-faint">Countries:</span>
                <span className="text-sm text-text-primary">
                  {ad.countries.map((c) => `${flagEmojis[c] || ''} ${c}`).join(', ')}
                </span>
              </div>
              <div className="flex items-center gap-2">
                <Target className="w-4 h-4 text-text-faint" />
                <span className="text-xs text-text-faint">Language:</span>
                <span className="text-sm text-text-primary">{ad.language}</span>
              </div>
              <div className="flex items-center gap-2">
                <Image className="w-4 h-4 text-text-faint" />
                <span className="text-xs text-text-faint">Format:</span>
                <span className="text-sm text-text-primary capitalize">{ad.format}</span>
              </div>
            </div>
          </div>

          {/* Shop info */}
          {ad.price && (
            <div>
              <h3 className="text-xs font-semibold text-text-faint uppercase tracking-wider mb-2">Product Info</h3>
              <div className="bg-bg-elevated rounded-lg p-3 flex items-center gap-4">
                <div>
                  <span className="text-lg font-bold text-text-primary">${ad.price}</span>
                  {ad.originalPrice && parseFloat(ad.originalPrice) > parseFloat(ad.price) && (
                    <span className="text-sm text-text-faint line-through ml-2">${ad.originalPrice}</span>
                  )}
                </div>
                <span className="flex items-center gap-1 text-sm text-warning">
                  <Star className="w-4 h-4" fill="currentColor" />
                  {ad.rating}
                </span>
                <span className="text-sm text-text-faint">
                  <ShoppingCart className="w-4 h-4 inline mr-1" />
                  {ad.soldCount?.toLocaleString()} sold
                </span>
              </div>
            </div>
          )}

          {/* Similar ads */}
          {similarAds.length > 0 && (
            <div>
              <h3 className="text-xs font-semibold text-text-faint uppercase tracking-wider mb-2">Similar Ads</h3>
              <div className="grid grid-cols-3 gap-2">
                {similarAds.slice(0, 6).map((sim) => (
                  <div
                    key={sim.id}
                    onClick={() => onAdClick?.(sim)}
                    className="bg-bg-elevated rounded-lg overflow-hidden cursor-pointer hover:ring-1 hover:ring-border-strong transition-all"
                  >
                    <div className="aspect-video bg-bg-hover flex items-center justify-center">
                      <Image className="w-6 h-6 text-text-faint/30" />
                    </div>
                    <div className="p-2">
                      <p className="text-[11px] text-text-muted truncate">{sim.brand.name}</p>
                      <p className="text-[10px] text-text-faint">{sim.firstSeen}</p>
                    </div>
                  </div>
                ))}
              </div>
            </div>
          )}
        </div>

        {/* Action bar */}
        <div className="flex items-center gap-2 px-5 py-4 border-t border-border-subtle">
          <button
            onClick={() => onSave?.(ad)}
            className={`flex items-center gap-1.5 px-4 py-2 text-sm font-medium rounded-lg transition-colors cursor-pointer ${
              ad.saved
                ? 'bg-accent text-white'
                : 'bg-bg-elevated border border-border-default text-text-primary hover:bg-bg-hover'
            }`}
          >
            <Bookmark className="w-4 h-4" fill={ad.saved ? 'currentColor' : 'none'} />
            {ad.saved ? 'Saved' : 'Save'}
          </button>
          <button className="flex items-center gap-1.5 px-4 py-2 text-sm font-medium bg-bg-elevated border border-border-default rounded-lg text-text-primary hover:bg-bg-hover transition-colors cursor-pointer">
            <Download className="w-4 h-4" />
            Download
          </button>
          <button className="flex items-center gap-1.5 px-4 py-2 text-sm font-medium bg-bg-elevated border border-border-default rounded-lg text-text-primary hover:bg-bg-hover transition-colors cursor-pointer">
            <Share2 className="w-4 h-4" />
            Share
          </button>
        </div>
      </div>
    </div>
  );
}
