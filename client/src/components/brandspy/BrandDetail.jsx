import { useEffect, useRef, useState, useCallback } from 'react';
import {
  ArrowLeft, ExternalLink, RefreshCw, Play,
  ChevronDown, Settings2, Globe, ScanSearch,
  Sparkles, AlertCircle, RotateCcw,
} from 'lucide-react';
import IntelDrawer from './IntelDrawer';

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const TIER_COLORS = {
  BANGER: 'bg-rose-500/20 text-rose-400 border-rose-500/30',
  CHAMP:  'bg-amber-500/20 text-amber-400 border-amber-500/30',
  A:      'bg-emerald-500/20 text-emerald-400 border-emerald-500/30',
  B:      'bg-sky-500/20 text-sky-400 border-sky-500/30',
  C:      'bg-zinc-700/40 text-zinc-400 border-zinc-700',
  MID:    'bg-zinc-800/60 text-zinc-500 border-zinc-700/50',
  TEST:   'bg-zinc-900/60 text-zinc-600 border-zinc-800',
};
const TIER_ICONS    = { BANGER: '🔥', CHAMP: '🏆' };
const TIER_TOOLTIPS = {
  BANGER: '🔥 BANGER — Top 3% under 10 days',
  CHAMP:  '🏆 CHAMP — Top 10%',
  A:      'A — Top 25%',
  B:      'B — Top 50%',
  C:      'C — Top 75%',
  MID:    'MID — Bottom 25%',
  TEST:   'TEST — Bottom 10%',
};

const TIER_FILTERS = ['ALL', 'BANGER', 'CHAMP', 'A', 'B', 'C', 'MID', 'TEST'];
const TIER_LABELS  = { ALL: 'ALL', BANGER: '🔥 BANGER', CHAMP: '🏆 CHAMP', A: 'A', B: 'B', C: 'C', MID: 'MID', TEST: 'TEST' };

const SORT_OPTIONS = [
  { value: 'rank_asc',         label: 'Top rank' },
  { value: 'first_seen_desc',  label: 'Most recent' },
  { value: 'active_days_desc', label: 'Longest running' },
  { value: 'velocity_7d_desc', label: 'Climbing fast' },
];

const TIME_FILTERS = [
  { value: 'all', label: 'All time' },
  { value: '7',   label: '7d' },
  { value: '30',  label: '30d' },
  { value: '90',  label: '90d' },
  { value: '180', label: '180d' },
];

const TABS = [
  { id: 'overview',      label: 'Overview' },
  { id: 'intelligence',  label: 'Intelligence' },
  { id: 'hooks',         label: 'Hooks' },
  { id: 'adcopy',        label: 'Ad Copy' },
  { id: 'headlines',     label: 'Headlines' },
  { id: 'landing',       label: 'Landing Pages' },
];

const INTEL_CATS = [
  { key: 'personas',  label: 'Personas',  color: 'bg-violet-500/15 text-violet-300 border-violet-500/25' },
  { key: 'adAngles',  label: 'Ad Angles', color: 'bg-blue-500/15 text-blue-300 border-blue-500/25' },
  { key: 'usps',      label: 'USPs',      color: 'bg-emerald-500/15 text-emerald-300 border-emerald-500/25' },
  { key: 'desires',   label: 'Desires',   color: 'bg-amber-500/15 text-amber-300 border-amber-500/25' },
  { key: 'emotions',  label: 'Emotions',  color: 'bg-rose-500/15 text-rose-300 border-rose-500/25' },
  { key: 'themes',    label: 'Themes',    color: 'bg-cyan-500/15 text-cyan-300 border-cyan-500/25' },
];

const ALL_COLUMNS = [
  { key: 'num',     label: '#',      locked: true,  width: 42 },
  { key: 'ad',      label: 'AD',     locked: true,  width: 280 },
  { key: 'page',    label: 'PAGE',   locked: false, width: 150 },
  { key: 'launch',  label: 'LAUNCH', locked: false, width: 80 },
  { key: 'status',  label: 'STATUS', locked: false, width: 60 },
  { key: 'format',  label: 'FORMAT', locked: false, width: 70 },
  { key: 'rank21d', label: '21D',    locked: false, width: 75 },
  { key: 'rank7d',  label: '7D',     locked: false, width: 75 },
  { key: 'rank3d',  label: '3D',     locked: false, width: 75 },
  { key: 'now',     label: 'NOW',    locked: true,  width: 75 },
  { key: 'active',  label: 'ACTIVE', locked: false, width: 60 },
  { key: 'tier',    label: 'TIER',   locked: true,  width: 90 },
  { key: 'v7d',     label: 'V7D',    locked: false, width: 60 },
  { key: 'v21d',    label: 'V21D',   locked: false, width: 60 },
];

const PAGE_SIZE_GRID  = 30;
const PAGE_SIZE_TABLE = 50;

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function classifyAdFormat(ad) {
  if (ad.displayFormat === 'CAROUSEL') return 'CAROUSEL';
  if (ad.displayFormat === 'VIDEO' || ad.videoUrl) return 'VIDEO';
  return 'IMAGE';
}

function fmtLaunch(iso) {
  if (!iso) return '—';
  const d   = new Date(iso);
  const now = new Date();
  return d.toLocaleDateString('en-US', {
    month: 'short', day: 'numeric',
    ...(d.getFullYear() !== now.getFullYear() ? { year: '2-digit' } : {}),
  });
}

function fmtDateRange(startDate, endDate, isActive) {
  const start = startDate ? fmtLaunch(startDate) : '—';
  if (isActive) return `${start} — Present`;
  const end   = endDate ? fmtLaunch(endDate) : '?';
  return `${start} — ${end}`;
}

function liveActiveDays(ad) {
  const tatDays = ad.totalActiveTime != null ? Math.floor(ad.totalActiveTime / 86400) : null;
  if (ad.startDate && ad.isActive) {
    const fromStart = Math.max(0, Math.floor((Date.now() - new Date(ad.startDate).getTime()) / 86400000));
    return tatDays != null ? Math.max(fromStart, tatDays) : fromStart;
  }
  return tatDays ?? ad.activeDays ?? null;
}

function relTime(iso) {
  if (!iso) return 'never';
  const diff  = Date.now() - new Date(iso).getTime();
  const days  = Math.floor(diff / 86400000);
  if (days >= 1) return `${days}d ago`;
  const hours = Math.floor(diff / 3600000);
  if (hours >= 1) return `${hours}h ago`;
  return 'just now';
}

function fmtCount(n) {
  if (!n) return '0';
  if (n >= 1000) return `${(n / 1000).toFixed(n >= 10000 ? 0 : 1)}K`;
  return String(n);
}

// ---------------------------------------------------------------------------
// Small shared components
// ---------------------------------------------------------------------------

function BrandLogo({ domain }) {
  const [src, setSrc]       = useState(`https://logo.clearbit.com/${domain}`);
  const [failed, setFailed] = useState(false);
  if (failed) return (
    <div className="w-full h-full flex items-center justify-center text-base font-bold text-text-muted">
      {domain.charAt(0).toUpperCase()}
    </div>
  );
  return (
    <img src={src} alt="" className="w-full h-full object-contain p-0.5"
      onError={() => {
        if (src.includes('clearbit')) setSrc(`https://www.google.com/s2/favicons?domain=${domain}&sz=64`);
        else setFailed(true);
      }}
    />
  );
}

function PageAvatar({ page, size = 28 }) {
  const [failed, setFailed] = useState(false);
  const colors = [
    'bg-violet-500/20 text-violet-400', 'bg-sky-500/20 text-sky-400',
    'bg-emerald-500/20 text-emerald-400', 'bg-amber-500/20 text-amber-400',
    'bg-rose-500/20 text-rose-400',
  ];
  const color = colors[(page.pageName?.charCodeAt(0) ?? 0) % colors.length];
  if (page.pageProfilePic && !failed) {
    return (
      <img src={page.pageProfilePic} alt="" className="rounded-full object-cover shrink-0"
        style={{ width: size, height: size }} onError={() => setFailed(true)} />
    );
  }
  return (
    <div className={`rounded-full flex items-center justify-center font-bold shrink-0 ${color}`}
      style={{ width: size, height: size, fontSize: Math.max(9, size * 0.36) }}>
      {(page.pageName ?? '?').charAt(0).toUpperCase()}
    </div>
  );
}

function useDropdown() {
  const [open, setOpen] = useState(false);
  const ref             = useRef(null);
  useEffect(() => {
    if (!open) return;
    const handler = (e) => { if (ref.current && !ref.current.contains(e.target)) setOpen(false); };
    document.addEventListener('mousedown', handler);
    return () => document.removeEventListener('mousedown', handler);
  }, [open]);
  return { open, setOpen, ref };
}

function ColInfo({ children }) {
  const [show, setShow] = useState(false);
  return (
    <span className="relative inline-flex items-center"
      onMouseEnter={() => setShow(true)} onMouseLeave={() => setShow(false)}>
      <span className="text-[9px] leading-none cursor-default select-none ml-0.5"
        style={{ color: show ? '#9ca3af' : '#4b5563' }}>ⓘ</span>
      {show && (
        <div className="absolute bottom-full left-1/2 -translate-x-1/2 mb-2 w-64 rounded-xl p-3.5 shadow-2xl pointer-events-none z-50 text-left normal-case tracking-normal font-normal"
          style={{ background: '#1c1c1e', border: '1px solid #2a2a2a' }}>
          {children}
        </div>
      )}
    </span>
  );
}

const COL_TIPS = {
  now:     (<><p className="text-xs font-bold text-white mb-1">Current Rank</p><p className="text-[11px] leading-relaxed" style={{ color: '#9ca3af' }}>Where this ad ranks right now. <span className="text-white font-medium">rank / pool</span>.</p></>),
  active:  (<><p className="text-xs font-bold text-white mb-1">Active Days</p><p className="text-[11px] leading-relaxed" style={{ color: '#9ca3af' }}><span style={{ color: '#f59e0b' }} className="font-semibold">30+ days</span> = proven winner.</p></>),
  tier:    (<><p className="text-xs font-bold text-white mb-1">Creative Tier</p><p className="text-[11px] leading-relaxed" style={{ color: '#9ca3af' }}><span className="text-rose-400 font-semibold">🔥 BANGER</span> top 3% · <span className="text-amber-400 font-semibold">🏆 CHAMP</span> top 10% · A top 25% · B top 50%.</p></>),
  rank21d: (<><p className="text-xs font-bold text-white mb-1">21-Day Rank</p><p className="text-[11px] leading-relaxed" style={{ color: '#9ca3af' }}>Rank 21 days ago. Delta vs today.</p></>),
  rank7d:  (<><p className="text-xs font-bold text-white mb-1">7-Day Rank</p><p className="text-[11px] leading-relaxed" style={{ color: '#9ca3af' }}>Rank 7 days ago. Short-term momentum.</p></>),
  rank3d:  (<><p className="text-xs font-bold text-white mb-1">3-Day Rank</p><p className="text-[11px] leading-relaxed" style={{ color: '#9ca3af' }}>Rank 3 days ago. Recent acceleration.</p></>),
  v7d:     (<><p className="text-xs font-bold text-white mb-1">Velocity 7D</p><p className="text-[11px] leading-relaxed" style={{ color: '#9ca3af' }}><span className="text-emerald-400 font-semibold">+N↑</span> climbing · <span className="text-rose-400 font-semibold">-N↓</span> falling.</p></>),
  v21d:    (<><p className="text-xs font-bold text-white mb-1">Velocity 21D</p><p className="text-[11px] leading-relaxed" style={{ color: '#9ca3af' }}>Rank change over 21 days.</p></>),
};

function RankWithDelta({ rank, poolSize, delta }) {
  if (rank == null) return <span className="text-text-faint text-xs">—</span>;
  const display = poolSize ? `${rank}/${poolSize}` : String(rank);
  return (
    <div className="flex flex-col items-center gap-0.5">
      <span className="text-xs font-mono text-text-faint tabular-nums">{display}</span>
      {delta != null && delta !== 0 && (
        <span className={`text-[10px] font-medium tabular-nums ${delta > 0 ? 'text-emerald-400' : 'text-rose-400'}`}>
          {delta > 0 ? `(+${delta})` : `(${delta})`}
        </span>
      )}
    </div>
  );
}

function VelocityCell({ value, days, win }) {
  if (value === null || value === undefined) {
    if (days != null && days < win) return <span className="text-sky-400 font-semibold text-[11px]">NEW</span>;
    return <span className="text-text-faint text-xs">—</span>;
  }
  if (value > 0) return <span className="text-emerald-400 text-xs font-medium">+{value}↑</span>;
  if (value < 0) return <span className="text-rose-400 text-xs font-medium">{value}↓</span>;
  return <span className="text-text-faint text-xs">=</span>;
}

// ---------------------------------------------------------------------------
// AdCard — Overview grid card
// ---------------------------------------------------------------------------

function AdCard({ ad, onOpenIntel }) {
  const [imgFailed, setImgFailed] = useState(false);
  const fmt  = classifyAdFormat(ad);
  const days = liveActiveDays(ad);
  const hookText = ad.headline || (ad.bodyText ? ad.bodyText.slice(0, 120) : null) || '(No text)';

  const handlePlay = (e) => {
    e.stopPropagation();
    if (ad.videoUrl) window.open(ad.videoUrl, '_blank', 'noopener,noreferrer');
  };

  return (
    <div
      onClick={() => onOpenIntel(ad)}
      className="group relative flex flex-col bg-bg-elevated border border-border-subtle rounded-xl overflow-hidden cursor-pointer hover:border-white/20 transition-all hover:shadow-xl"
    >
      {/* Thumbnail area */}
      <div className="relative bg-zinc-950 shrink-0" style={{ aspectRatio: '4/3' }}>
        {ad.thumbnailUrl && !imgFailed ? (
          <img src={ad.thumbnailUrl} alt="" className="w-full h-full object-cover"
            onError={() => setImgFailed(true)} />
        ) : (
          <div className="w-full h-full flex items-center justify-center">
            <span className="text-text-faint text-[11px] uppercase tracking-widest opacity-40">{fmt}</span>
          </div>
        )}

        {/* Hover overlay */}
        <div className="absolute inset-0 bg-black/15 opacity-0 group-hover:opacity-100 transition-opacity pointer-events-none" />

        {/* Play button */}
        {fmt === 'VIDEO' && ad.videoUrl && (
          <button onClick={handlePlay}
            className="absolute inset-0 flex items-center justify-center z-10"
            title="Play video">
            <div className="w-12 h-12 rounded-full bg-black/60 backdrop-blur-sm flex items-center justify-center border border-white/20 transition-transform group-hover:scale-110">
              <Play className="w-5 h-5 text-white ml-0.5" fill="white" />
            </div>
          </button>
        )}

        {/* Format badge — top left */}
        <div className="absolute top-2 left-2 z-20 pointer-events-none">
          <span className={`text-[9px] font-bold uppercase tracking-wide px-1.5 py-0.5 rounded-md border backdrop-blur-sm ${
            fmt === 'VIDEO'    ? 'bg-purple-900/70 text-purple-300 border-purple-500/30' :
            fmt === 'CAROUSEL' ? 'bg-amber-900/70 text-amber-300 border-amber-500/30' :
                                 'bg-sky-900/70 text-sky-300 border-sky-500/30'
          }`}>
            {fmt === 'VIDEO' ? '▶ VIDEO' : fmt === 'CAROUSEL' ? '⊞ CAROUSEL' : '🖼 IMAGE'}
          </span>
        </div>

        {/* Tier badge — top right */}
        {ad.tier && (
          <div className="absolute top-2 right-2 z-20 pointer-events-none">
            <span className={`text-[9px] font-bold px-1.5 py-0.5 rounded-md border backdrop-blur-sm ${TIER_COLORS[ad.tier] ?? ''}`}
              title={TIER_TOOLTIPS[ad.tier]}>
              {TIER_ICONS[ad.tier] ?? ''}{ad.tier}
            </span>
          </div>
        )}

        {/* Date range gradient overlay */}
        <div className="absolute bottom-0 left-0 right-0 px-2 py-2 bg-gradient-to-t from-black/80 via-black/40 to-transparent pointer-events-none z-20">
          <p className="text-[10px] text-white/75 font-mono">
            {fmtDateRange(ad.startDate, ad.endDate, ad.isActive)}
          </p>
        </div>
      </div>

      {/* Text area */}
      <div className="p-3 flex flex-col gap-1.5 flex-1">
        <p className="text-[12px] text-text-primary leading-relaxed line-clamp-2">{hookText}</p>
        <div className="flex items-center justify-between gap-2 mt-auto">
          <div className="flex items-center gap-1.5 min-w-0">
            <span className={`w-1.5 h-1.5 rounded-full shrink-0 ${ad.isActive ? 'bg-emerald-400' : 'bg-zinc-600'}`} />
            {ad.ctaText && (
              <span className="text-[10px] text-text-faint truncate">{ad.ctaText}</span>
            )}
          </div>
          {days != null && (
            <span className={`text-[11px] font-semibold shrink-0 tabular-nums ${days >= 30 ? 'text-emerald-400' : 'text-text-faint'}`}>
              {days}d
            </span>
          )}
        </div>
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// MediaMixBar
// ---------------------------------------------------------------------------

function MediaMixBar({ ads }) {
  const total    = ads.length;
  if (!total) return null;
  const videos   = ads.filter((a) => classifyAdFormat(a) === 'VIDEO').length;
  const images   = ads.filter((a) => classifyAdFormat(a) === 'IMAGE').length;
  const carousels = ads.filter((a) => classifyAdFormat(a) === 'CAROUSEL').length;
  const vPct     = Math.round((videos   / total) * 100);
  const iPct     = Math.round((images   / total) * 100);
  const cPct     = Math.round((carousels / total) * 100);

  return (
    <div className="space-y-2">
      <div className="flex items-center gap-4 flex-wrap">
        <span className="text-[10px] uppercase tracking-wider text-text-faint">Media Mix</span>
        <div className="flex items-center gap-1.5">
          <span className="w-2 h-2 rounded-full bg-purple-400 shrink-0" />
          <span className="text-[11px] text-text-muted">
            <span className="text-white font-semibold">{videos}</span> Videos ({vPct}%)
          </span>
        </div>
        <div className="flex items-center gap-1.5">
          <span className="w-2 h-2 rounded-full bg-sky-400 shrink-0" />
          <span className="text-[11px] text-text-muted">
            <span className="text-white font-semibold">{images}</span> Images ({iPct}%)
          </span>
        </div>
        {carousels > 0 && (
          <div className="flex items-center gap-1.5">
            <span className="w-2 h-2 rounded-full bg-amber-400 shrink-0" />
            <span className="text-[11px] text-text-muted">
              <span className="text-white font-semibold">{carousels}</span> Carousels ({cPct}%)
            </span>
          </div>
        )}
        <span className="text-[11px] text-text-faint ml-auto">{total.toLocaleString()} ads</span>
      </div>
      <div className="h-2 rounded-full bg-bg-card flex overflow-hidden gap-px">
        {vPct > 0  && <div className="h-full bg-purple-400/60 transition-all" style={{ width: `${vPct}%` }} />}
        {iPct > 0  && <div className="h-full bg-sky-400/60 transition-all"    style={{ width: `${iPct}%` }} />}
        {cPct > 0  && <div className="h-full bg-amber-400/60 transition-all"  style={{ width: `${cPct}%` }} />}
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// IntelPanel — AI analysis tags
// ---------------------------------------------------------------------------

function IntelPanel({ intel, intelLoading, intelError, onRetry }) {
  if (intelLoading) {
    return (
      <div className="rounded-xl border border-border-subtle p-4 space-y-3" style={{ background: 'rgba(255,255,255,0.015)' }}>
        <div className="flex items-center gap-2 mb-1">
          <Sparkles className="w-4 h-4 text-violet-400 animate-pulse" />
          <span className="text-sm font-semibold text-text-primary">AI Brand Intel</span>
          <span className="text-[10px] text-text-faint">Analyzing ads…</span>
        </div>
        {INTEL_CATS.map((cat) => (
          <div key={cat.key} className="flex items-start gap-3">
            <span className="text-[10px] uppercase tracking-wider text-text-faint w-20 shrink-0 pt-1">{cat.label}</span>
            <div className="flex flex-wrap gap-1.5 flex-1">
              {[90, 130, 100, 110, 80].map((w, i) => (
                <div key={i} className="h-5 rounded-full bg-white/5 animate-pulse" style={{ width: w }} />
              ))}
            </div>
          </div>
        ))}
      </div>
    );
  }

  if (intelError) {
    return (
      <div className="rounded-xl border border-red-500/20 p-4 flex items-center justify-between" style={{ background: 'rgba(255,255,255,0.015)' }}>
        <div className="flex items-center gap-2">
          <AlertCircle className="w-4 h-4 text-red-400 shrink-0" />
          <span className="text-sm text-text-muted">Could not load AI intel — {intelError}</span>
        </div>
        <button onClick={onRetry} className="flex items-center gap-1.5 text-xs text-text-faint hover:text-text-primary transition-colors shrink-0 ml-4">
          <RotateCcw className="w-3 h-3" /> Retry
        </button>
      </div>
    );
  }

  if (!intel) return null;

  const hasData = INTEL_CATS.some((cat) => (intel[cat.key] ?? []).length > 0);
  if (!hasData) {
    return (
      <div className="rounded-xl border border-border-subtle p-4 flex items-center gap-2" style={{ background: 'rgba(255,255,255,0.015)' }}>
        <Sparkles className="w-4 h-4 text-text-faint opacity-50" />
        <span className="text-sm text-text-faint">No ad text to analyze yet.</span>
      </div>
    );
  }

  return (
    <div className="rounded-xl border border-border-subtle p-4 space-y-3" style={{ background: 'rgba(255,255,255,0.015)' }}>
      <div className="flex items-center gap-2 mb-1">
        <Sparkles className="w-4 h-4 text-violet-400" />
        <span className="text-sm font-semibold text-text-primary">AI Brand Intel</span>
        <span className="text-[10px] text-text-faint">via Claude Haiku</span>
      </div>
      {INTEL_CATS.map((cat) => {
        const items = intel[cat.key] ?? [];
        if (!items.length) return null;
        return (
          <div key={cat.key} className="flex items-start gap-3">
            <span className="text-[10px] uppercase tracking-wider text-text-faint w-20 shrink-0 pt-1">{cat.label}</span>
            <div className="flex flex-wrap gap-1.5 flex-1">
              {items.map((item, i) => (
                <span key={i} className={`text-[11px] px-2.5 py-0.5 rounded-full border leading-snug ${cat.color}`}>
                  {item}
                </span>
              ))}
            </div>
          </div>
        );
      })}
    </div>
  );
}

// ---------------------------------------------------------------------------
// BrandDetail — main component
// ---------------------------------------------------------------------------

export default function BrandDetail({ apiBaseUrl, brandId, onBack }) {
  // Brand state
  const [brand, setBrand]               = useState(null);
  const [brandError, setBrandError]     = useState(null);
  // Ads state
  const [ads, setAds]                   = useState([]);
  const [total, setTotal]               = useState(0);
  const [adsLoading, setAdsLoading]     = useState(true);
  const [adsError, setAdsError]         = useState(null);
  // Scrape state
  const [refreshing, setRefreshing]     = useState(false);
  const [refreshError, setRefreshError] = useState(null);
  // Pagination & filters
  const [page, setPage]                 = useState(1);
  const [sort, setSort]                 = useState('rank_asc');
  const [tierFilter, setTierFilter]     = useState('ALL');
  const [pageFilter, setPageFilter]     = useState(null);
  const [timeFilter, setTimeFilter]     = useState('all');
  // UI
  const [activeTab, setActiveTab]       = useState('overview');
  const [visibleCols, setVisibleCols]   = useState(() => {
    const init = {};
    ALL_COLUMNS.forEach((c) => { init[c.key] = true; });
    return init;
  });
  // Intel
  const [intel, setIntel]               = useState(null);
  const [intelLoading, setIntelLoading] = useState(false);
  const [intelError, setIntelError]     = useState(null);
  const [intelFetched, setIntelFetched] = useState(false);
  // Drawer
  const [selectedAd, setSelectedAd]     = useState(null);

  const ovPagesDropdown   = useDropdown(); // Overview tab pages
  const intPagesDropdown  = useDropdown(); // Intelligence tab pages
  const intColsDropdown   = useDropdown(); // Intelligence tab columns

  // ---- Load brand ----
  useEffect(() => {
    setBrandError(null);
    fetch(`${apiBaseUrl}/brands/${brandId}`)
      .then((r) => { if (!r.ok) throw new Error(`Brand not found (${r.status})`); return r.json(); })
      .then((d) => { if (!d.brand) throw new Error('Brand not found'); setBrand(d.brand); })
      .catch((e) => setBrandError(e.message));
  }, [apiBaseUrl, brandId]);

  // ---- Load ads ----
  const loadAds = useCallback(async () => {
    setAdsLoading(true);
    setAdsError(null);
    try {
      const ps     = activeTab === 'overview' ? PAGE_SIZE_GRID : PAGE_SIZE_TABLE;
      const params = new URLSearchParams({ page: String(page), pageSize: String(ps), sort, tier: tierFilter });
      if (pageFilter) params.set('brandPageId', pageFilter);
      if (activeTab === 'overview' && timeFilter !== 'all') params.set('days', timeFilter);
      const res  = await fetch(`${apiBaseUrl}/brands/${brandId}/ads?${params}`);
      if (!res.ok) throw new Error(`Failed (${res.status})`);
      const data = await res.json();
      setAds(data.ads ?? []);
      setTotal(data.total ?? 0);
    } catch (e) {
      setAdsError(e.message);
    } finally {
      setAdsLoading(false);
    }
  }, [apiBaseUrl, brandId, page, sort, tierFilter, pageFilter, timeFilter, activeTab]);

  useEffect(() => { loadAds(); }, [loadAds]);
  useEffect(() => { setPage(1); }, [tierFilter, pageFilter, sort, timeFilter, activeTab]);

  // ---- Load intel (lazy) ----
  const loadIntel = useCallback(async () => {
    setIntelLoading(true);
    setIntelError(null);
    try {
      const res  = await fetch(`${apiBaseUrl}/brands/${brandId}/intel`);
      if (!res.ok) throw new Error(`Failed (${res.status})`);
      const data = await res.json();
      setIntel(data);
      setIntelFetched(true);
    } catch (e) {
      setIntelError(e.message);
    } finally {
      setIntelLoading(false);
    }
  }, [apiBaseUrl, brandId]);

  useEffect(() => {
    if (activeTab === 'overview' && !intelFetched && !intelLoading) {
      loadIntel();
    }
  }, [activeTab, intelFetched, intelLoading, loadIntel]);

  // ---- Refresh (re-scrape) ----
  const handleRefresh = async () => {
    if (refreshing) return;
    setRefreshing(true);
    setRefreshError(null);
    try {
      await fetch(`${apiBaseUrl}/brands/${brandId}/scrape`, { method: 'POST' });
      const r = await fetch(`${apiBaseUrl}/brands/${brandId}`);
      if (r.ok) { const d = await r.json(); if (d.brand) setBrand(d.brand); }
      await loadAds();
    } catch (e) {
      setRefreshError(e.message);
    } finally {
      setRefreshing(false);
    }
  };

  const ps         = activeTab === 'overview' ? PAGE_SIZE_GRID : PAGE_SIZE_TABLE;
  const totalPages = Math.ceil(total / ps);
  const col        = (key) => visibleCols[key];
  const toggleCol  = (key) => setVisibleCols((prev) => ({ ...prev, [key]: !prev[key] }));
  const t          = brand?.tierBreakdown ?? {};

  const selectedOvPage  = brand?.pages?.find((p) => p.id === pageFilter) ?? null;
  const selectedIntPage = brand?.pages?.find((p) => p.id === pageFilter) ?? null;

  // ---- Error state ----
  if (brandError) return (
    <div className="flex flex-col h-full overflow-hidden">
      <div className="p-5">
        <button onClick={onBack} className="flex items-center gap-1.5 text-sm text-text-muted hover:text-text-primary transition-colors">
          <ArrowLeft className="w-4 h-4" /> Brand Spy
        </button>
      </div>
      <div className="flex-1 flex items-center justify-center text-red-400 text-sm">{brandError}</div>
    </div>
  );

  return (
    <div className="flex flex-col h-full overflow-hidden">
      <div className="flex-1 overflow-y-auto flex flex-col min-h-0">

        {/* ============================================================
            HEADER
        ============================================================ */}
        <div className="px-5 pt-4 pb-3 space-y-3 shrink-0">
          {/* Breadcrumb */}
          <button onClick={onBack} className="flex items-center gap-1.5 text-sm text-text-muted hover:text-text-primary transition-colors">
            <ArrowLeft className="w-4 h-4" /> Brand Spy
          </button>

          {refreshError && (
            <div className="text-xs text-red-400 bg-red-400/10 border border-red-400/20 rounded-lg px-3 py-2">{refreshError}</div>
          )}

          {!brand ? (
            <div className="text-text-faint text-sm animate-pulse">Loading brand…</div>
          ) : (
            <>
              {/* Brand row */}
              <div className="flex items-start justify-between gap-4">
                <div className="flex items-center gap-3">
                  <div className="relative w-12 h-12 rounded-2xl bg-bg-elevated border border-border-default overflow-hidden shrink-0">
                    <BrandLogo domain={brand.domain} />
                    <span className={`absolute -top-0.5 -right-0.5 w-3 h-3 rounded-full ring-2 ring-bg-card ${
                      brand.status === 'ACTIVE' ? 'bg-emerald-400' :
                      brand.status === 'NOISY'  ? 'bg-amber-400'   : 'bg-zinc-600'
                    }`} />
                  </div>
                  <div>
                    <div className="flex items-center gap-2 flex-wrap">
                      <h1 className="text-xl font-bold text-white">{brand.domain}</h1>
                      <a href={`https://${brand.domain}`} target="_blank" rel="noreferrer"
                        className="text-text-faint hover:text-text-muted transition-colors">
                        <ExternalLink className="w-3.5 h-3.5" />
                      </a>
                      <span className={`text-[10px] px-2 py-0.5 rounded border uppercase tracking-wide font-medium ${
                        brand.status === 'ACTIVE' ? 'bg-emerald-500/10 text-emerald-400 border-emerald-500/20' :
                        brand.status === 'NOISY'  ? 'bg-amber-500/10 text-amber-400 border-amber-500/20' :
                        'bg-bg-elevated text-text-faint border-border-default'
                      }`}>{brand.status}</span>
                    </div>
                    <p className="text-xs text-text-faint mt-0.5">
                      {brand.pagesCount} pages · {brand.domainsCount} domains · updated {relTime(brand.lastScrapedAt)}
                    </p>
                  </div>
                </div>

                <div className="flex items-center gap-2 shrink-0">
                  <a href={`https://www.facebook.com/ads/library/?active_status=all&ad_type=all&country=US&media_type=all&q=${encodeURIComponent(brand.domain)}&search_type=keyword_unordered`}
                    target="_blank" rel="noreferrer"
                    className="flex items-center gap-1.5 px-3 py-1.5 text-xs rounded-lg bg-bg-elevated border border-border-default hover:bg-bg-hover text-text-muted transition-colors">
                    <ExternalLink className="w-3.5 h-3.5" /> Ad Library
                  </a>
                  <button onClick={handleRefresh} disabled={refreshing}
                    className="flex items-center gap-1.5 px-3 py-1.5 text-xs rounded-lg bg-bg-elevated border border-border-default hover:bg-bg-hover disabled:opacity-40 text-text-primary transition-colors">
                    <RefreshCw className={`w-3.5 h-3.5 ${refreshing ? 'animate-spin' : ''}`} />
                    {refreshing ? 'Scraping…' : 'Refresh'}
                  </button>
                </div>
              </div>

              {/* Stats row */}
              <div className="grid grid-cols-2 sm:grid-cols-4 gap-3">
                {[
                  { label: 'ACTIVE ADS', value: fmtCount(brand.activeAdsCount), accent: 'text-emerald-400' },
                  { label: 'TOTAL ADS',  value: fmtCount(brand.totalAdsCount),  accent: null },
                  { label: 'PAGES',      value: String(brand.pagesCount),       accent: null },
                  { label: 'DOMAINS',    value: String(brand.domainsCount),     accent: null },
                ].map(({ label, value, accent }) => (
                  <div key={label} className="bg-bg-card border border-border-subtle rounded-xl p-3">
                    <p className="text-[10px] uppercase tracking-wider text-text-faint">{label}</p>
                    <p className={`text-2xl font-bold mt-0.5 tabular-nums ${accent ?? 'text-white'}`}>{value}</p>
                  </div>
                ))}
              </div>

              {/* Tier strip */}
              <div className="flex items-center gap-2 flex-wrap">
                <span className="text-[10px] uppercase tracking-wider text-text-faint">Tiers:</span>
                {t.banger > 0 && <span className="text-[10px] font-medium px-2 py-0.5 rounded border bg-rose-500/10 text-rose-400 border-rose-500/20">🔥 {t.banger}</span>}
                {t.champ  > 0 && <span className="text-[10px] font-medium px-2 py-0.5 rounded border bg-amber-500/10 text-amber-400 border-amber-500/20">🏆 {t.champ}</span>}
                {t.a      > 0 && <span className="text-[10px] font-medium px-2 py-0.5 rounded border bg-emerald-500/10 text-emerald-400 border-emerald-500/20">A {t.a}</span>}
                {t.b      > 0 && <span className="text-[10px] font-medium px-2 py-0.5 rounded border bg-sky-500/10 text-sky-400 border-sky-500/20">B {t.b}</span>}
                {t.c      > 0 && <span className="text-[10px] font-medium px-2 py-0.5 rounded border bg-zinc-700/40 text-zinc-400 border-zinc-700">C {t.c}</span>}
                {t.low    > 0 && <span className="text-[10px] font-medium px-2 py-0.5 rounded border bg-bg-elevated text-text-faint border-border-default">MID {t.low}</span>}
                {t.test   > 0 && <span className="text-[10px] font-medium px-2 py-0.5 rounded border bg-bg-card text-text-faint border-border-subtle">TEST {t.test}</span>}
              </div>
            </>
          )}
        </div>

        {/* ============================================================
            TAB NAVIGATION
        ============================================================ */}
        <div className="shrink-0 border-b border-border-subtle px-5">
          <div className="flex items-center gap-0 overflow-x-auto" style={{ scrollbarWidth: 'none' }}>
            {TABS.map((tab) => (
              <button key={tab.id} onClick={() => setActiveTab(tab.id)}
                className={`shrink-0 px-4 py-2.5 text-sm font-medium border-b-2 transition-colors whitespace-nowrap ${
                  activeTab === tab.id
                    ? 'border-white text-white'
                    : 'border-transparent text-text-faint hover:text-text-muted hover:border-border-default'
                }`}>
                {tab.label}
              </button>
            ))}
          </div>
        </div>

        {/* ============================================================
            OVERVIEW TAB
        ============================================================ */}
        {activeTab === 'overview' && (
          <div className="flex-1 flex flex-col min-h-0 px-5 pt-4 pb-6 space-y-4">

            {/* Controls row */}
            <div className="flex items-center justify-between gap-3 flex-wrap">
              {/* Time filters */}
              <div className="flex items-center gap-1">
                {TIME_FILTERS.map((tf) => (
                  <button key={tf.value} onClick={() => setTimeFilter(tf.value)}
                    className={`px-3 py-1.5 text-xs rounded-lg font-medium transition-colors ${
                      timeFilter === tf.value
                        ? 'bg-white/10 text-white border border-white/20'
                        : 'bg-bg-elevated text-text-faint border border-border-subtle hover:text-text-muted'
                    }`}>
                    {tf.label}
                  </button>
                ))}
              </div>

              {/* Right controls */}
              <div className="flex items-center gap-2 flex-wrap">
                {/* Pages dropdown */}
                <div className="relative" ref={ovPagesDropdown.ref}>
                  <button onClick={() => ovPagesDropdown.setOpen((o) => !o)}
                    className="flex items-center gap-1.5 px-3 py-1.5 rounded-lg bg-bg-elevated border border-border-default hover:bg-bg-hover text-xs transition-colors">
                    <span className="text-text-muted">{selectedOvPage ? selectedOvPage.pageName : 'All Pages'}</span>
                    {pageFilter && (
                      <span onClick={(e) => { e.stopPropagation(); setPageFilter(null); }}
                        className="text-text-faint hover:text-text-primary cursor-pointer ml-0.5">×</span>
                    )}
                    <ChevronDown className="w-3 h-3 text-text-faint" />
                  </button>
                  {ovPagesDropdown.open && (
                    <div className="absolute top-full right-0 mt-1 rounded-xl shadow-2xl z-50 p-2"
                      style={{ width: 440, background: '#1c1c1e', border: '1px solid #2a2a2a' }}>
                      <div className="grid grid-cols-2 gap-1.5 max-h-72 overflow-y-auto">
                        <button onClick={() => { setPageFilter(null); ovPagesDropdown.setOpen(false); setPage(1); }}
                          className={`flex items-center gap-2 p-2.5 rounded-lg border text-left transition-all ${!pageFilter ? 'bg-white/5 border-white/10' : 'border-transparent hover:bg-white/5'}`}>
                          <div className="w-8 h-8 rounded-full bg-bg-elevated border border-border-default flex items-center justify-center shrink-0">
                            <ScanSearch className="w-3.5 h-3.5 text-text-faint" />
                          </div>
                          <div>
                            <p className="text-xs font-medium text-text-primary">All Pages</p>
                            <p className="text-[11px] text-text-faint">{brand?.activeAdsCount} active</p>
                          </div>
                        </button>
                        {(brand?.pages ?? []).map((pg) => (
                          <button key={pg.id} onClick={() => { setPageFilter(pg.id); ovPagesDropdown.setOpen(false); setPage(1); }}
                            className={`group flex items-center gap-2 p-2.5 rounded-lg border text-left transition-all ${pageFilter === pg.id ? 'bg-white/5 border-white/10' : 'border-transparent hover:bg-white/5'}`}>
                            <PageAvatar page={pg} size={32} />
                            <div className="min-w-0 flex-1">
                              <div className="flex items-center justify-between gap-1">
                                <p className="text-xs font-medium text-text-primary truncate">{pg.pageName}</p>
                                <a href={`https://www.facebook.com/ads/library/?active_status=all&ad_type=all&country=US&media_type=all&search_type=page&view_all_page_id=${pg.metaPageId ?? ''}`}
                                  target="_blank" rel="noreferrer" onClick={(e) => e.stopPropagation()}
                                  className="opacity-40 hover:opacity-100 transition-opacity shrink-0">
                                  <ExternalLink className="w-3 h-3 text-text-faint" />
                                </a>
                              </div>
                              <p className="text-[11px] text-text-faint">{pg.activeAdsCount} active</p>
                            </div>
                          </button>
                        ))}
                      </div>
                    </div>
                  )}
                </div>

                {/* Sort */}
                <select value={sort} onChange={(e) => setSort(e.target.value)}
                  className="text-xs bg-bg-elevated border border-border-default rounded-lg px-2.5 py-1.5 text-text-muted focus:outline-none cursor-pointer">
                  {SORT_OPTIONS.map((o) => <option key={o.value} value={o.value}>{o.label}</option>)}
                </select>

                {/* Tier pills */}
                <div className="flex items-center gap-1 flex-wrap">
                  {TIER_FILTERS.map((f) => (
                    <button key={f} onClick={() => setTierFilter(f)}
                      className={`px-2 py-0.5 text-[10px] rounded border font-medium transition-colors ${
                        tierFilter === f ? 'bg-accent text-white border-accent' : 'bg-bg-elevated text-text-faint border-border-default hover:text-text-primary'
                      }`}>
                      {TIER_LABELS[f]}
                    </button>
                  ))}
                </div>
              </div>
            </div>

            {/* Media mix */}
            {!adsLoading && ads.length > 0 && <MediaMixBar ads={ads} />}

            {/* AI Intel */}
            <IntelPanel intel={intel} intelLoading={intelLoading} intelError={intelError} onRetry={loadIntel} />

            {/* Ad grid */}
            {adsLoading ? (
              <div className="grid grid-cols-3 gap-4">
                {Array.from({ length: 9 }).map((_, i) => (
                  <div key={i} className="rounded-xl border border-border-subtle overflow-hidden animate-pulse">
                    <div className="bg-white/5" style={{ aspectRatio: '4/3' }} />
                    <div className="p-3 space-y-2">
                      <div className="h-3 bg-white/5 rounded" />
                      <div className="h-3 bg-white/5 rounded w-2/3" />
                    </div>
                  </div>
                ))}
              </div>
            ) : adsError ? (
              <div className="flex items-center justify-center py-20 text-red-400 text-sm">{adsError}</div>
            ) : ads.length === 0 ? (
              <div className="flex items-center justify-center py-16 text-text-faint text-sm">
                {tierFilter !== 'ALL' ? `No ${tierFilter} ads.` : timeFilter !== 'all' ? `No ads launched in the last ${timeFilter}d.` : 'No ads found — click Refresh to scrape.'}
              </div>
            ) : (
              <>
                <div className="grid grid-cols-3 gap-4">
                  {ads.map((ad) => <AdCard key={ad.id} ad={ad} onOpenIntel={setSelectedAd} />)}
                </div>
                {totalPages > 1 && (
                  <div className="flex items-center justify-between pt-2">
                    <span className="text-[11px] text-text-faint">{total.toLocaleString()} ads · page {page} of {totalPages}</span>
                    <div className="flex items-center gap-2">
                      <button onClick={() => setPage((p) => Math.max(1, p - 1))} disabled={page === 1}
                        className="px-3 py-1 text-xs rounded-lg bg-bg-elevated border border-border-default disabled:opacity-40 hover:bg-bg-hover text-text-primary transition-colors">← Prev</button>
                      <button onClick={() => setPage((p) => Math.min(totalPages, p + 1))} disabled={page >= totalPages}
                        className="px-3 py-1 text-xs rounded-lg bg-bg-elevated border border-border-default disabled:opacity-40 hover:bg-bg-hover text-text-primary transition-colors">Next →</button>
                    </div>
                  </div>
                )}
              </>
            )}
          </div>
        )}

        {/* ============================================================
            INTELLIGENCE TAB (existing detailed rank/tier table)
        ============================================================ */}
        {activeTab === 'intelligence' && (
          <div className="flex-1 flex flex-col min-h-0">
            {/* Toolbar */}
            <div className="sticky top-0 z-20 shrink-0 bg-bg-card border-b border-t border-border-subtle px-4 py-2 flex items-center gap-2 flex-wrap">
              {/* Pages dropdown */}
              <div className="relative" ref={intPagesDropdown.ref}>
                <button onClick={() => intPagesDropdown.setOpen((o) => !o)}
                  className="flex items-center gap-1.5 px-3 py-1.5 rounded-lg bg-bg-elevated border border-border-default hover:bg-bg-hover text-xs transition-colors">
                  <span className="text-text-muted">{selectedIntPage ? selectedIntPage.pageName : 'All Pages'}</span>
                  {pageFilter && (
                    <span onClick={(e) => { e.stopPropagation(); setPageFilter(null); }}
                      className="ml-1 text-text-faint hover:text-text-primary cursor-pointer">×</span>
                  )}
                  <ChevronDown className="w-3 h-3 text-text-faint" />
                </button>
                {intPagesDropdown.open && (
                  <div className="absolute top-full left-0 mt-1 rounded-xl shadow-2xl z-50 p-3"
                    style={{ width: 580, background: '#1c1c1e', border: '1px solid #2a2a2a' }}>
                    <div className="grid grid-cols-3 gap-1.5 max-h-80 overflow-y-auto">
                      <button onClick={() => { setPageFilter(null); intPagesDropdown.setOpen(false); setPage(1); }}
                        className={`flex items-center gap-2 p-2.5 rounded-lg border text-left transition-all ${!pageFilter ? 'bg-white/5 border-white/10' : 'border-transparent hover:bg-white/5 hover:border-white/10'}`}>
                        <div className="w-9 h-9 rounded-full bg-bg-elevated border border-border-default flex items-center justify-center shrink-0">
                          <ScanSearch className="w-4 h-4 text-text-faint" />
                        </div>
                        <div>
                          <p className="text-xs font-medium text-text-primary">All Pages</p>
                          <p className="text-[11px] text-text-faint">{brand?.activeAdsCount} active</p>
                        </div>
                      </button>
                      {(brand?.pages ?? []).map((pg) => (
                        <button key={pg.id} onClick={() => { setPageFilter(pg.id); intPagesDropdown.setOpen(false); setPage(1); }}
                          className={`group flex items-center gap-2 p-2.5 rounded-lg border text-left transition-all ${pageFilter === pg.id ? 'bg-white/5 border-white/10' : 'border-transparent hover:bg-white/5 hover:border-white/10'}`}>
                          <PageAvatar page={pg} size={36} />
                          <div className="min-w-0 flex-1">
                            <div className="flex items-center justify-between gap-1">
                              <p className="text-xs font-medium text-text-primary truncate">{pg.pageName}</p>
                              <a href={`https://www.facebook.com/ads/library/?active_status=all&ad_type=all&country=US&media_type=all&search_type=page&view_all_page_id=${pg.metaPageId ?? ''}`}
                                target="_blank" rel="noreferrer" onClick={(e) => e.stopPropagation()}
                                className="opacity-40 hover:opacity-100 transition-opacity shrink-0">
                                <ExternalLink className="w-3 h-3 text-text-faint" />
                              </a>
                            </div>
                            <p className="text-[11px] text-text-faint">{pg.activeAdsCount} active</p>
                          </div>
                        </button>
                      ))}
                    </div>
                  </div>
                )}
              </div>

              {/* Tier pills */}
              <div className="flex items-center gap-1 flex-wrap">
                {TIER_FILTERS.map((f) => (
                  <button key={f} onClick={() => setTierFilter(f)}
                    className={`px-2 py-0.5 text-[11px] rounded border font-medium transition-colors ${
                      tierFilter === f ? 'bg-accent text-white border-accent' : 'bg-bg-elevated text-text-muted border-border-default hover:text-text-primary'
                    }`}>
                    {TIER_LABELS[f]}
                  </button>
                ))}
              </div>

              <div className="flex-1" />

              {/* Sort */}
              <select value={sort} onChange={(e) => setSort(e.target.value)}
                className="text-xs bg-bg-elevated border border-border-default rounded-lg px-2.5 py-1.5 text-text-muted focus:outline-none cursor-pointer">
                {SORT_OPTIONS.map((o) => <option key={o.value} value={o.value}>{o.label}</option>)}
              </select>

              {/* Columns toggle */}
              <div className="relative" ref={intColsDropdown.ref}>
                <button onClick={() => intColsDropdown.setOpen((o) => !o)}
                  className="flex items-center gap-1 px-2.5 py-1.5 rounded-lg bg-bg-elevated border border-border-default hover:bg-bg-hover text-text-primary text-xs transition-colors">
                  <Settings2 className="w-3.5 h-3.5" />
                </button>
                {intColsDropdown.open && (
                  <div className="absolute top-full right-0 mt-1 w-44 bg-bg-card border border-border-default rounded-lg shadow-xl z-50 p-2 space-y-0.5">
                    {ALL_COLUMNS.filter((c) => c.key !== 'num').map((c) => (
                      <label key={c.key} className={`flex items-center gap-2 px-2 py-1 rounded text-xs cursor-pointer hover:bg-bg-elevated transition-colors ${c.locked ? 'opacity-50 cursor-not-allowed' : ''}`}>
                        <input type="checkbox" checked={visibleCols[c.key]} disabled={c.locked}
                          onChange={() => !c.locked && toggleCol(c.key)} className="accent-accent" />
                        <span className="text-text-muted">{c.label || c.key.toUpperCase()}</span>
                      </label>
                    ))}
                  </div>
                )}
              </div>
            </div>

            {/* Table */}
            <div className="flex-1 overflow-x-auto">
              {adsLoading ? (
                <div className="flex items-center justify-center py-20 text-text-faint text-sm">Loading ads…</div>
              ) : adsError ? (
                <div className="flex items-center justify-center py-20 text-red-400 text-sm">{adsError}</div>
              ) : ads.length === 0 ? (
                <div className="flex items-center justify-center py-20 text-text-faint text-sm">
                  {tierFilter !== 'ALL' ? `No ${tierFilter} ads.` : 'No ads found — click Refresh.'}
                </div>
              ) : (
                <table className="min-w-[1300px] w-full border-collapse">
                  <thead className="sticky top-[45px] z-10 bg-bg-elevated">
                    <tr>
                      {col('num')     && <th style={{ width: 42  }} className="px-2 py-2.5 text-right text-[10px] uppercase tracking-wider text-text-faint font-normal">#</th>}
                      {col('ad')      && <th style={{ width: 280 }} className="px-3 py-2.5 text-left text-[10px] uppercase tracking-wider text-text-faint font-normal">AD</th>}
                      {col('page')    && <th style={{ width: 150 }} className="px-3 py-2.5 text-left text-[10px] uppercase tracking-wider text-text-faint font-normal">PAGE</th>}
                      {col('launch')  && <th style={{ width: 80  }} className="px-2 py-2.5 text-center text-[10px] uppercase tracking-wider text-text-faint font-normal">LAUNCH</th>}
                      {col('status')  && <th style={{ width: 60  }} className="px-2 py-2.5 text-center text-[10px] uppercase tracking-wider text-text-faint font-normal">STATUS</th>}
                      {col('format')  && <th style={{ width: 70  }} className="px-2 py-2.5 text-center text-[10px] uppercase tracking-wider text-text-faint font-normal">FORMAT</th>}
                      {col('rank21d') && <th style={{ width: 75  }} className="px-2 py-2.5 text-center text-[10px] uppercase tracking-wider text-text-faint font-normal"><span className="inline-flex items-center gap-0.5">21D<ColInfo>{COL_TIPS.rank21d}</ColInfo></span></th>}
                      {col('rank7d')  && <th style={{ width: 75  }} className="px-2 py-2.5 text-center text-[10px] uppercase tracking-wider text-text-faint font-normal"><span className="inline-flex items-center gap-0.5">7D<ColInfo>{COL_TIPS.rank7d}</ColInfo></span></th>}
                      {col('rank3d')  && <th style={{ width: 75  }} className="px-2 py-2.5 text-center text-[10px] uppercase tracking-wider text-text-faint font-normal"><span className="inline-flex items-center gap-0.5">3D<ColInfo>{COL_TIPS.rank3d}</ColInfo></span></th>}
                      {col('now')     && <th style={{ width: 75  }} className="px-2 py-2.5 text-center text-[10px] uppercase tracking-wider text-text-muted font-semibold bg-bg-hover"><span className="inline-flex items-center gap-0.5">NOW<ColInfo>{COL_TIPS.now}</ColInfo></span></th>}
                      {col('active')  && <th style={{ width: 60  }} className="px-2 py-2.5 text-center text-[10px] uppercase tracking-wider text-text-faint font-normal"><span className="inline-flex items-center gap-0.5">ACTIVE<ColInfo>{COL_TIPS.active}</ColInfo></span></th>}
                      {col('tier')    && <th style={{ width: 90  }} className="px-2 py-2.5 text-center text-[10px] uppercase tracking-wider text-text-faint font-normal"><span className="inline-flex items-center gap-0.5">TIER<ColInfo>{COL_TIPS.tier}</ColInfo></span></th>}
                      {col('v7d')     && <th style={{ width: 60  }} className="px-2 py-2.5 text-center text-[10px] uppercase tracking-wider text-text-faint font-normal"><span className="inline-flex items-center gap-0.5">V7D<ColInfo>{COL_TIPS.v7d}</ColInfo></span></th>}
                      {col('v21d')    && <th style={{ width: 60  }} className="px-2 py-2.5 text-center text-[10px] uppercase tracking-wider text-text-faint font-normal"><span className="inline-flex items-center gap-0.5">V21D<ColInfo>{COL_TIPS.v21d}</ColInfo></span></th>}
                    </tr>
                  </thead>
                  <tbody>
                    {ads.map((ad, i) => (
                      <DetailAdRow key={ad.id} ad={ad} rowNum={(page - 1) * PAGE_SIZE_TABLE + i + 1} onSelect={() => setSelectedAd(ad)} col={col} />
                    ))}
                  </tbody>
                </table>
              )}
            </div>

            {/* Table pagination */}
            <div className="shrink-0 border-t border-border-subtle bg-bg-card px-4 py-2 flex items-center justify-between gap-3">
              <span className="text-[11px] text-text-faint">{total.toLocaleString()} ads · page {page} of {Math.max(1, totalPages)}</span>
              <div className="flex items-center gap-2">
                <button onClick={() => setPage((p) => Math.max(1, p - 1))} disabled={page === 1}
                  className="px-3 py-1 text-xs rounded-lg bg-bg-elevated border border-border-default disabled:opacity-40 hover:bg-bg-hover text-text-primary transition-colors">← Prev</button>
                <button onClick={() => setPage((p) => Math.min(totalPages, p + 1))} disabled={page >= totalPages}
                  className="px-3 py-1 text-xs rounded-lg bg-bg-elevated border border-border-default disabled:opacity-40 hover:bg-bg-hover text-text-primary transition-colors">Next →</button>
              </div>
            </div>
          </div>
        )}

        {/* ============================================================
            COMING SOON stubs for other tabs
        ============================================================ */}
        {!['overview', 'intelligence'].includes(activeTab) && (
          <div className="flex-1 flex flex-col items-center justify-center gap-3 p-12">
            <Sparkles className="w-8 h-8 text-text-faint opacity-30" />
            <p className="text-text-faint text-sm">Coming soon</p>
            <p className="text-text-faint text-xs opacity-60">This tab will be available in a future update.</p>
          </div>
        )}

      </div>

      {/* IntelDrawer */}
      {selectedAd && (
        <IntelDrawer ad={selectedAd} brand={brand} onClose={() => setSelectedAd(null)} />
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------
// DetailAdRow — Intelligence tab table row
// ---------------------------------------------------------------------------

function DetailAdRow({ ad, rowNum, onSelect, col }) {
  const delta3d = (ad.rank3d != null && ad.currentRank != null) ? ad.rank3d - ad.currentRank : null;

  return (
    <tr className="border-b border-border-subtle hover:bg-bg-elevated transition-colors cursor-pointer" onClick={onSelect}>
      {col('num') && (
        <td className="px-2 py-2 text-right text-[11px] text-text-faint tabular-nums">#{rowNum}</td>
      )}
      {col('ad') && (
        <td className="px-3 py-2" style={{ width: 280 }}>
          <div className="flex items-center gap-2.5 min-w-0">
            <div className="w-10 h-10 rounded-lg bg-bg-elevated border border-border-subtle overflow-hidden flex items-center justify-center shrink-0">
              {ad.thumbnailUrl
                ? <img src={ad.thumbnailUrl} alt="" className="w-full h-full object-cover" />
                : <span className="text-text-faint text-[9px] uppercase">{ad.displayFormat || '?'}</span>}
            </div>
            <div className="min-w-0">
              <p className="text-sm text-text-primary truncate leading-snug">
                {ad.headline || ad.bodyText?.slice(0, 60) || ad.adArchiveId}
              </p>
              {ad.pageName && <p className="text-[11px] text-text-faint truncate mt-0.5">{ad.pageName}</p>}
            </div>
          </div>
        </td>
      )}
      {col('page') && (
        <td className="px-3 py-2" style={{ width: 150 }}>
          <div className="flex items-center gap-1.5 min-w-0 group">
            <Globe className="w-3 h-3 text-text-faint shrink-0" />
            <span className="text-xs text-text-muted truncate flex-1 min-w-0">{ad.pageName ?? '—'}</span>
            {ad.metaPageId && (
              <a href={`https://www.facebook.com/ads/library/?active_status=all&ad_type=all&country=US&media_type=all&search_type=page&view_all_page_id=${ad.metaPageId}`}
                target="_blank" rel="noreferrer" onClick={(e) => e.stopPropagation()}
                className="opacity-0 group-hover:opacity-50 hover:!opacity-100 transition-opacity shrink-0">
                <ExternalLink className="w-3 h-3 text-text-faint" />
              </a>
            )}
          </div>
        </td>
      )}
      {col('launch') && (
        <td className="px-2 py-2 text-center" style={{ width: 80 }}>
          <span className="text-xs text-text-faint tabular-nums">{fmtLaunch(ad.startDate)}</span>
        </td>
      )}
      {col('status') && (
        <td className="px-2 py-2 text-center" style={{ width: 60 }}>
          <span className={`w-2 h-2 rounded-full inline-block ${ad.isActive ? 'bg-emerald-400' : 'bg-zinc-600'}`} />
        </td>
      )}
      {col('format') && (
        <td className="px-2 py-2 text-center" style={{ width: 70 }}>
          {ad.displayFormat
            ? <span className="text-[10px] px-1.5 py-0.5 rounded bg-bg-elevated text-text-faint uppercase border border-border-subtle">{ad.displayFormat}</span>
            : <span className="text-text-faint text-xs">—</span>}
        </td>
      )}
      {col('rank21d') && (
        <td className="px-2 py-2 text-center" style={{ width: 75 }}>
          <RankWithDelta rank={ad.rank21d} poolSize={ad.poolSize} delta={ad.velocity21d} />
        </td>
      )}
      {col('rank7d') && (
        <td className="px-2 py-2 text-center" style={{ width: 75 }}>
          <RankWithDelta rank={ad.rank7d} poolSize={ad.poolSize} delta={ad.velocity7d} />
        </td>
      )}
      {col('rank3d') && (
        <td className="px-2 py-2 text-center" style={{ width: 75 }}>
          <RankWithDelta rank={ad.rank3d} poolSize={ad.poolSize} delta={delta3d} />
        </td>
      )}
      {col('now') && (
        <td className="px-2 py-2 text-center bg-bg-hover/40" style={{ width: 75 }}>
          <span className="text-xs font-semibold font-mono text-white tabular-nums">
            {ad.currentRank != null ? (ad.poolSize ? `${ad.currentRank}/${ad.poolSize}` : String(ad.currentRank)) : '—'}
          </span>
        </td>
      )}
      {col('active') && (
        <td className="px-2 py-2 text-center" style={{ width: 60 }}>
          {(() => { const d = liveActiveDays(ad); return d != null
            ? <span className={`text-xs tabular-nums ${d >= 30 ? 'text-emerald-400 font-semibold' : 'text-text-primary'}`}>{d}d</span>
            : <span className="text-text-faint text-xs">—</span>; })()}
        </td>
      )}
      {col('tier') && (
        <td className="px-2 py-2 text-center" style={{ width: 90 }}>
          {ad.tier
            ? <span className={`text-[10px] px-1.5 py-0.5 rounded border font-medium ${TIER_COLORS[ad.tier] ?? ''}`} title={TIER_TOOLTIPS[ad.tier] ?? ad.tier}>
                {TIER_ICONS[ad.tier] ? `${TIER_ICONS[ad.tier]} ` : ''}{ad.tier}
              </span>
            : <span className="text-text-faint text-xs">—</span>}
        </td>
      )}
      {col('v7d') && (
        <td className="px-2 py-2 text-center" style={{ width: 60 }}>
          <VelocityCell value={ad.velocity7d} days={liveActiveDays(ad)} win={7} />
        </td>
      )}
      {col('v21d') && (
        <td className="px-2 py-2 text-center" style={{ width: 60 }}>
          <VelocityCell value={ad.velocity21d} days={liveActiveDays(ad)} win={21} />
        </td>
      )}
    </tr>
  );
}
