/**
 * IntelDrawer — full-detail modal for a single ad.
 * Opens when clicking any row in BrandLeague or BrandDetail.
 *
 * Layout (reference screenshot):
 *  Left  ~55%  — Facebook-style ad preview (profile, body copy, creative)
 *  Right ~45%  — SIGNAL panel (rank, tier, velocity, momentum, history)
 */

import { useEffect, useState } from 'react';
import {
  X, ExternalLink, Copy, Download, RefreshCw, Flag, BarChart2,
} from 'lucide-react';

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const TIER_COLORS = {
  BANGER: 'text-rose-400',
  CHAMP:  'text-amber-400',
  A:      'text-emerald-400',
  B:      'text-sky-400',
  C:      'text-zinc-400',
  MID:    'text-text-faint',
  TEST:   'text-text-faint',
};

const TIER_BG = {
  BANGER: 'bg-rose-500/15 border-rose-500/30',
  CHAMP:  'bg-amber-500/15 border-amber-500/30',
  A:      'bg-emerald-500/15 border-emerald-500/30',
  B:      'bg-sky-500/15 border-sky-500/30',
  C:      'bg-zinc-700/40 border-zinc-700',
  MID:    'bg-bg-elevated border-border-default',
  TEST:   'bg-bg-card border-border-subtle',
};

const TIER_ICONS = { BANGER: '🔥', CHAMP: '🏆' };

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function fmtDate(iso) {
  if (!iso) return '—';
  return new Date(iso).toLocaleDateString('en-US', { year: 'numeric', month: 'short', day: 'numeric' });
}

function velocityPct(velocity, currentRank) {
  if (velocity == null || !currentRank) return null;
  const prev = currentRank + velocity;
  if (prev <= 0) return null;
  return Math.round((velocity / prev) * 100);
}

function computeMomentum(v7d, v21d) {
  if (v7d == null && v21d == null) return null;
  return +(((v7d || 0) * 2 + (v21d || 0)) / 3).toFixed(1);
}

function computeQuality(ad) {
  const fields = [
    ad.thumbnailUrl,
    ad.headline,
    ad.bodyText,
    ad.startDate,
    ad.tier,
    ad.linkUrl,
    ad.currentRank,
    ad.displayFormat,
    ad.pageName,
  ];
  const score = Math.round((fields.filter(Boolean).length / fields.length) * 100);
  let label = 'Low';
  let color = 'text-red-400';
  let barColor = 'bg-red-500';
  if (score >= 86) { label = 'Excellent'; color = 'text-emerald-400'; barColor = 'bg-emerald-500'; }
  else if (score >= 71) { label = 'Good'; color = 'text-sky-400'; barColor = 'bg-sky-500'; }
  else if (score >= 51) { label = 'Moderate'; color = 'text-amber-400'; barColor = 'bg-amber-500'; }
  else if (score >= 31) { label = 'Fair'; color = 'text-orange-400'; barColor = 'bg-orange-500'; }
  return { score, label, color, barColor };
}

function detectTechStack(url) {
  if (!url) return [];
  const stack = [];
  if (url.includes('myshopify.com') || url.includes('/products/') || url.includes('shopify')) stack.push('Shopify');
  if (url.includes('clickfunnels')) stack.push('ClickFunnels');
  if (url.includes('kajabi')) stack.push('Kajabi');
  if (url.includes('kartra')) stack.push('Kartra');
  if (url.includes('leadpages')) stack.push('LeadPages');
  if (url.includes('gohighlevel') || url.includes('highlevel')) stack.push('GoHighLevel');
  return stack;
}

// ---------------------------------------------------------------------------
// Sub-components
// ---------------------------------------------------------------------------

function PageProfilePic({ ad, pages, size = 40 }) {
  const [failed, setFailed] = useState(false);
  // Try to find the page profile pic from the brand pages list
  const page = pages?.find((p) => p.metaPageId === ad.metaPageId);
  const src = page?.pageProfilePic;

  const colors = [
    'bg-violet-500/30 text-violet-300',
    'bg-sky-500/30 text-sky-300',
    'bg-emerald-500/30 text-emerald-300',
    'bg-amber-500/30 text-amber-300',
    'bg-rose-500/30 text-rose-300',
  ];
  const color = colors[(ad.pageName?.charCodeAt(0) ?? 0) % colors.length];

  if (src && !failed) {
    return (
      <img
        src={src} alt=""
        className="rounded-full object-cover shrink-0"
        style={{ width: size, height: size }}
        onError={() => setFailed(true)}
      />
    );
  }
  return (
    <div
      className={`rounded-full flex items-center justify-center font-bold shrink-0 ${color}`}
      style={{ width: size, height: size, fontSize: size * 0.38 }}
    >
      {(ad.pageName ?? '?').charAt(0).toUpperCase()}
    </div>
  );
}

function ExpandableText({ text, maxChars = 200 }) {
  const [expanded, setExpanded] = useState(false);
  if (!text) return null;
  if (text.length <= maxChars) return <p className="text-sm text-[#e4e6eb] leading-relaxed">{text}</p>;
  return (
    <div>
      <p className="text-sm text-[#e4e6eb] leading-relaxed">
        {expanded ? text : `${text.slice(0, maxChars)}...`}
        {' '}
        <button
          onClick={() => setExpanded(!expanded)}
          className="text-[#1877f2] hover:underline text-sm font-medium"
        >
          {expanded ? 'see less' : 'see more'}
        </button>
      </p>
    </div>
  );
}

function SignalMetricCard({ label, children, className = '' }) {
  return (
    <div className={`rounded-xl p-3 flex flex-col gap-1 ${className}`} style={{ background: '#252525', border: '1px solid #333' }}>
      <p className="text-[10px] uppercase tracking-wider font-medium" style={{ color: '#6b7280' }}>{label}</p>
      {children}
    </div>
  );
}

function RankHistoryCard({ label, value }) {
  return (
    <div className="flex-1 rounded-lg py-2 px-1 text-center" style={{ background: '#1e1e1e', border: '1px solid #2a2a2a' }}>
      <p className="text-[9px] uppercase tracking-wider mb-1" style={{ color: '#6b7280' }}>{label}</p>
      <p className="text-sm font-bold text-white tabular-nums">{value ?? '—'}</p>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Main IntelDrawer
// ---------------------------------------------------------------------------

function liveActiveDays(ad) {
  if (!ad.startDate) return ad.activeDays ?? null;
  if (ad.isActive) return Math.floor((Date.now() - new Date(ad.startDate).getTime()) / 86400000);
  return ad.activeDays ?? null;
}

export default function IntelDrawer({ ad, brand, onClose }) {
  // ESC to close
  useEffect(() => {
    const h = (e) => { if (e.key === 'Escape') onClose(); };
    window.addEventListener('keydown', h);
    return () => window.removeEventListener('keydown', h);
  }, [onClose]);

  const [copied, setCopied] = useState(false);

  if (!ad) return null;

  const pages = brand?.pages ?? [];
  const activeDays = liveActiveDays(ad);
  const quality = computeQuality(ad);
  const momentum = computeMomentum(ad.velocity7d, ad.velocity21d);
  const pct7d  = velocityPct(ad.velocity7d,  ad.currentRank);
  const pct21d = velocityPct(ad.velocity21d, ad.currentRank);
  const techStack = detectTechStack(ad.linkUrl);

  const adLibUrl = ad.adArchiveId
    ? `https://www.facebook.com/ads/library/?active_status=all&ad_type=all&country=US&id=${ad.adArchiveId}`
    : null;

  async function handleCopy() {
    const text = [ad.headline, ad.bodyText].filter(Boolean).join('\n\n');
    await navigator.clipboard.writeText(text).catch(() => {});
    setCopied(true);
    setTimeout(() => setCopied(false), 2000);
  }

  function handleSave() {
    const url = ad.videoUrl || ad.thumbnailUrl;
    if (!url) return;
    window.open(url, '_blank');
  }

  // ---------------------------------------------------------------------------
  // Render
  // ---------------------------------------------------------------------------
  return (
    <>
      {/* Backdrop */}
      <div
        className="fixed inset-0 z-50 bg-black/75 backdrop-blur-sm"
        onClick={onClose}
      />

      {/* Modal container */}
      <div className="fixed inset-0 z-50 flex items-center justify-center p-4 pointer-events-none">
        <div
          className="pointer-events-auto relative flex w-full rounded-2xl overflow-hidden shadow-2xl"
          style={{
            maxWidth: 1080,
            height: '88vh',
            background: '#161618',
            border: '1px solid #2a2a2a',
          }}
          onClick={(e) => e.stopPropagation()}
        >

          {/* ======================================================= */}
          {/* LEFT PANEL — Ad Preview                                   */}
          {/* ======================================================= */}
          <div
            className="flex flex-col overflow-y-auto"
            style={{ width: '55%', borderRight: '1px solid #2a2a2a', background: '#111113' }}
          >
            {/* Post header */}
            <div className="flex items-start justify-between gap-3 px-5 pt-5 pb-3">
              <div className="flex items-center gap-3 min-w-0">
                <div className="relative shrink-0">
                  <PageProfilePic ad={ad} pages={pages} size={42} />
                  {/* Blue verified/sponsored dot */}
                  <div className="absolute -bottom-0.5 -right-0.5 w-4 h-4 rounded-full bg-[#1877f2] flex items-center justify-center ring-2 ring-[#111113]">
                    <span className="text-white text-[8px] font-bold">f</span>
                  </div>
                </div>
                <div className="min-w-0">
                  <p className="text-[15px] font-semibold text-white truncate">{ad.pageName ?? 'Unknown Page'}</p>
                  <p className="text-xs mt-0.5" style={{ color: '#9ca3af' }}>
                    Sponsored
                    {ad.startDate && (
                      <> · Launched {new Date(ad.startDate).toISOString().split('T')[0]}</>
                    )}
                    {activeDays != null && (
                      <> · <span className="text-emerald-400 font-medium">{activeDays}d active</span></>
                    )}
                  </p>
                </div>
              </div>
              {adLibUrl && (
                <a
                  href={adLibUrl}
                  target="_blank"
                  rel="noreferrer"
                  className="shrink-0 flex items-center gap-1 px-2.5 py-1 rounded-lg text-xs font-medium transition-colors"
                  style={{ background: '#2a2a2e', color: '#9ca3af', border: '1px solid #3a3a3e' }}
                  onMouseEnter={e => e.currentTarget.style.color = '#fff'}
                  onMouseLeave={e => e.currentTarget.style.color = '#9ca3af'}
                >
                  Ad Library
                  <ExternalLink className="w-3 h-3" />
                </a>
              )}
            </div>

            {/* Body copy */}
            {(ad.headline || ad.bodyText) && (
              <div className="px-5 pb-3 space-y-2">
                {ad.headline && (
                  <ExpandableText text={ad.headline} maxChars={120} />
                )}
                {ad.bodyText && ad.bodyText !== ad.headline && (
                  <ExpandableText text={ad.bodyText} maxChars={200} />
                )}
                <button
                  onClick={handleCopy}
                  className="flex items-center gap-1.5 px-3 py-1 rounded-lg text-xs font-medium transition-colors mt-1"
                  style={{ background: '#2a2a2e', color: copied ? '#34d399' : '#9ca3af', border: '1px solid #3a3a3e' }}
                >
                  <Copy className="w-3 h-3" />
                  {copied ? 'Copied!' : 'Copy text'}
                </button>
              </div>
            )}

            {/* Creative */}
            <div className="flex-1 relative mx-5 mb-0 rounded-xl overflow-hidden" style={{ minHeight: 200, background: '#0d0d0f', border: '1px solid #2a2a2a' }}>
              {/* Format badge */}
              {ad.displayFormat && (
                <div className="absolute top-3 left-3 z-10 px-2 py-0.5 rounded text-[10px] font-bold uppercase tracking-wider"
                  style={{ background: '#1877f2', color: '#fff' }}>
                  {ad.displayFormat}
                </div>
              )}

              {/* Save button */}
              <button
                onClick={handleSave}
                className="absolute bottom-3 right-3 z-10 flex items-center gap-1.5 px-2.5 py-1 rounded-lg text-xs font-medium transition-colors"
                style={{ background: 'rgba(0,0,0,0.7)', color: '#fff', backdropFilter: 'blur(4px)', border: '1px solid rgba(255,255,255,0.15)' }}
              >
                <Download className="w-3 h-3" />
                Save
              </button>

              {/* Media */}
              {ad.videoUrl ? (
                <video
                  src={ad.videoUrl}
                  poster={ad.thumbnailUrl}
                  controls
                  className="w-full h-full object-contain"
                  style={{ maxHeight: 440 }}
                />
              ) : ad.thumbnailUrl ? (
                <img
                  src={ad.thumbnailUrl}
                  alt=""
                  className="w-full object-contain"
                  style={{ maxHeight: 440 }}
                />
              ) : (
                <div className="w-full h-48 flex items-center justify-center text-text-faint text-sm">
                  No preview available
                </div>
              )}
            </div>

            {/* Ad destination bar */}
            {(ad.linkUrl || ad.ctaText) && (
              <div
                className="mx-5 mt-0 mb-5 flex items-center justify-between px-4 py-3 rounded-b-xl"
                style={{ background: '#1e1e20', border: '1px solid #2a2a2a', borderTop: 'none' }}
              >
                <div className="min-w-0">
                  {ad.linkUrl && (
                    <p className="text-[11px] uppercase tracking-wide font-medium" style={{ color: '#6b7280' }}>
                      {(() => {
                        try { return new URL(ad.linkUrl.startsWith('http') ? ad.linkUrl : `https://${ad.linkUrl}`).hostname.replace('www.', '').toUpperCase(); }
                        catch { return ad.linkUrl.split('/')[0].toUpperCase(); }
                      })()}
                    </p>
                  )}
                  {ad.headline && (
                    <p className="text-sm font-semibold text-white truncate mt-0.5">{ad.headline}</p>
                  )}
                </div>
                {ad.ctaText && (
                  <div className="shrink-0 ml-3 px-3 py-1.5 rounded-lg text-xs font-semibold"
                    style={{ background: '#3a3b3c', color: '#e4e6eb' }}>
                    {ad.ctaText}
                  </div>
                )}
              </div>
            )}
          </div>

          {/* ======================================================= */}
          {/* RIGHT PANEL — SIGNAL                                      */}
          {/* ======================================================= */}
          <div
            className="flex flex-col overflow-y-auto"
            style={{ width: '45%', background: '#161618' }}
          >
            {/* SIGNAL header */}
            <div className="flex items-center justify-between px-5 pt-5 pb-4 shrink-0">
              <p className="text-[11px] uppercase tracking-[0.15em] font-semibold" style={{ color: '#6b7280' }}>
                Signal
              </p>
              <div className="flex items-center gap-1">
                {[Flag, RefreshCw, BarChart2].map((Icon, i) => (
                  <button key={i} className="p-1.5 rounded-lg transition-colors"
                    style={{ color: '#6b7280' }}
                    onMouseEnter={e => e.currentTarget.style.color = '#fff'}
                    onMouseLeave={e => e.currentTarget.style.color = '#6b7280'}
                  >
                    <Icon className="w-3.5 h-3.5" />
                  </button>
                ))}
                <button onClick={onClose} className="p-1.5 rounded-lg transition-colors ml-1"
                  style={{ color: '#6b7280' }}
                  onMouseEnter={e => e.currentTarget.style.color = '#fff'}
                  onMouseLeave={e => e.currentTarget.style.color = '#6b7280'}
                >
                  <X className="w-4 h-4" />
                </button>
              </div>
            </div>

            <div className="px-5 pb-5 space-y-3 flex-1">
              {/* Metric cards row: RANK · TIER · STATUS · ACTIVE */}
              <div className="grid grid-cols-4 gap-2">
                {/* RANK */}
                <SignalMetricCard label="Rank">
                  <p className="text-2xl font-bold text-white leading-none">
                    {ad.currentRank != null ? `#${ad.currentRank}` : '—'}
                  </p>
                  {ad.poolSize != null && (
                    <p className="text-[11px]" style={{ color: '#6b7280' }}>of {ad.poolSize}</p>
                  )}
                </SignalMetricCard>

                {/* TIER */}
                <SignalMetricCard label="Tier">
                  {ad.tier ? (
                    <p className={`text-xl font-bold leading-none ${TIER_COLORS[ad.tier] ?? 'text-white'}`}>
                      {TIER_ICONS[ad.tier] ? `${TIER_ICONS[ad.tier]} ` : ''}{ad.tier}
                    </p>
                  ) : (
                    <p className="text-xl font-bold text-text-faint leading-none">—</p>
                  )}
                </SignalMetricCard>

                {/* STATUS */}
                <SignalMetricCard label="Status">
                  <div className="flex items-center gap-1.5">
                    <span className={`w-2 h-2 rounded-full shrink-0 ${ad.isActive ? 'bg-emerald-400' : 'bg-zinc-500'}`} />
                    <span className={`text-sm font-semibold ${ad.isActive ? 'text-emerald-400' : 'text-text-faint'}`}>
                      {ad.isActive ? 'Active' : 'Ended'}
                    </span>
                  </div>
                </SignalMetricCard>

                {/* ACTIVE days */}
                <SignalMetricCard label="Active">
                  <p className={`text-2xl font-bold leading-none ${(activeDays ?? 0) >= 30 ? 'text-emerald-400' : 'text-white'}`}>
                    {activeDays != null ? `${activeDays}d` : '—'}
                  </p>
                </SignalMetricCard>
              </div>

              {/* DATA QUALITY */}
              <div className="rounded-xl p-4" style={{ background: '#252525', border: '1px solid #333' }}>
                <p className="text-[10px] uppercase tracking-wider mb-2 font-medium" style={{ color: '#6b7280' }}>
                  Data Quality
                </p>
                <div className="flex items-end justify-between mb-2">
                  <p className={`text-3xl font-bold ${quality.color}`}>{quality.score}%</p>
                  <p className="text-xs pb-1" style={{ color: '#6b7280' }}>{quality.label}</p>
                </div>
                <div className="h-1 rounded-full overflow-hidden" style={{ background: '#333' }}>
                  <div
                    className={`h-full rounded-full transition-all ${quality.barColor}`}
                    style={{ width: `${quality.score}%` }}
                  />
                </div>
              </div>

              {/* VELOCITY 7D + 21D */}
              <div className="grid grid-cols-2 gap-2">
                <SignalMetricCard label="Velocity 7D">
                  {ad.velocity7d != null ? (
                    <>
                      <p className={`text-xl font-bold leading-none ${ad.velocity7d > 0 ? 'text-emerald-400' : ad.velocity7d < 0 ? 'text-rose-400' : 'text-text-faint'}`}>
                        {ad.velocity7d > 0 ? `+${ad.velocity7d} ↑` : ad.velocity7d < 0 ? `${ad.velocity7d} ↓` : `0 →`}
                      </p>
                      {pct7d != null && (
                        <p className="text-[11px] mt-1" style={{ color: '#6b7280' }}>
                          {pct7d > 0 ? `+${pct7d}` : pct7d}% change
                        </p>
                      )}
                    </>
                  ) : (
                    <p className="text-xl font-bold text-text-faint leading-none">—</p>
                  )}
                </SignalMetricCard>

                <SignalMetricCard label="Velocity 21D">
                  {ad.velocity21d != null ? (
                    <>
                      <p className={`text-xl font-bold leading-none ${ad.velocity21d > 0 ? 'text-emerald-400' : ad.velocity21d < 0 ? 'text-rose-400' : 'text-text-faint'}`}>
                        {ad.velocity21d > 0 ? `+${ad.velocity21d} ↑` : ad.velocity21d < 0 ? `${ad.velocity21d} ↓` : `0 →`}
                      </p>
                      {pct21d != null && (
                        <p className="text-[11px] mt-1" style={{ color: '#6b7280' }}>
                          {pct21d > 0 ? `+${pct21d}` : pct21d}% change
                        </p>
                      )}
                    </>
                  ) : (
                    <p className="text-xl font-bold text-text-faint leading-none">—</p>
                  )}
                </SignalMetricCard>
              </div>

              {/* MOMENTUM */}
              <div className="rounded-xl p-4 text-center" style={{ background: '#252525', border: '1px solid #333' }}>
                <p className="text-[10px] uppercase tracking-wider mb-2 font-medium" style={{ color: '#6b7280' }}>
                  Momentum
                </p>
                {momentum != null ? (
                  <p className={`text-3xl font-bold ${momentum > 0 ? 'text-emerald-400' : momentum < 0 ? 'text-rose-400' : 'text-text-faint'}`}>
                    {momentum > 0 ? `+${momentum}` : momentum}
                  </p>
                ) : (
                  <p className="text-3xl font-bold text-text-faint">—</p>
                )}
              </div>

              {/* RANK HISTORY */}
              <div>
                <p className="text-[10px] uppercase tracking-wider mb-2 font-medium" style={{ color: '#6b7280' }}>
                  Rank History
                </p>
                <div className="flex gap-1.5">
                  <RankHistoryCard label="90D" value={null} />
                  <RankHistoryCard label="30D" value={null} />
                  <RankHistoryCard label="21D" value={ad.rank21d} />
                  <RankHistoryCard label="7D"  value={ad.rank7d} />
                  <RankHistoryCard label="3D"  value={ad.rank3d} />
                  <RankHistoryCard label="NOW" value={ad.currentRank} />
                </div>
              </div>

              {/* CHARTS — placeholder */}
              <div>
                <p className="text-[10px] uppercase tracking-wider mb-2 font-medium" style={{ color: '#6b7280' }}>
                  Charts
                </p>
                <div className="rounded-xl py-8 flex items-center justify-center text-xs"
                  style={{ background: '#1e1e20', border: '1px solid #2a2a2a', color: '#4b5563' }}>
                  Coming soon
                </div>
              </div>

              {/* TECH STACK */}
              {techStack.length > 0 && (
                <div>
                  <p className="text-[10px] uppercase tracking-wider mb-2 font-medium" style={{ color: '#6b7280' }}>
                    Tech Stack
                  </p>
                  <div className="flex flex-wrap gap-1.5">
                    {techStack.map((t) => (
                      <span key={t}
                        className="px-3 py-1 rounded-lg text-xs font-medium"
                        style={{ background: '#252525', border: '1px solid #3a3a3a', color: '#e4e6eb' }}>
                        {t}
                      </span>
                    ))}
                  </div>
                </div>
              )}

              {/* Meta Ad Library link */}
              {adLibUrl ? (
                <a
                  href={adLibUrl}
                  target="_blank"
                  rel="noreferrer"
                  className="flex items-center justify-center gap-1.5 w-full py-2.5 rounded-xl text-xs font-medium transition-colors"
                  style={{ background: '#1877f2', color: '#fff' }}
                  onMouseEnter={e => e.currentTarget.style.opacity = '0.9'}
                  onMouseLeave={e => e.currentTarget.style.opacity = '1'}
                >
                  <ExternalLink className="w-3.5 h-3.5" />
                  View on Meta Ad Library
                </a>
              ) : (
                <div
                  className="flex items-center justify-center gap-1.5 w-full py-2.5 rounded-xl text-xs font-medium opacity-40"
                  style={{ background: '#1877f2', color: '#fff', cursor: 'not-allowed' }}
                >
                  <ExternalLink className="w-3.5 h-3.5" />
                  No Ad Library ID
                </div>
              )}
            </div>
          </div>
        </div>
      </div>
    </>
  );
}
