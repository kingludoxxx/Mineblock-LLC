import { useEffect, useRef, useState, useCallback } from 'react';
import {
  ArrowLeft, ExternalLink, RefreshCw, Play, Pause,
  Volume2, VolumeX, Maximize2,
  ChevronDown, Settings2, Globe, ScanSearch,
  Sparkles, AlertCircle, RotateCcw,
  MoreHorizontal, Info, Copy, Download,
  Video as VideoIcon, Image as ImageIcon, Columns as CarouselIcon,
} from 'lucide-react';
import IntelDrawer from './IntelDrawer';
import AggregationsTab from './AggregationsTab';

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

// All intel pills are rendered in a single neutral gray. Per-category colors
// were noisy and made the panel hard to scan; only the icon distinguishes
// each row now.
const INTEL_PILL_CLASS = 'bg-white/[0.04] text-text-muted border-white/[0.08]';
const INTEL_CATS = [
  { key: 'personas',  label: 'Personas',  icon: '👤' },
  { key: 'adAngles',  label: 'Ad angles', icon: '🎯' },
  { key: 'usps',      label: 'USPs',      icon: '🚀' },
  { key: 'desires',   label: 'Desires',   icon: '🔥' },
  { key: 'emotions',  label: 'Emotions',  icon: '😀' },
  { key: 'themes',    label: 'Themes',    icon: '🏷️' },
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

const PAGE_SIZE_GRID  = 48;
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
  // Three signals, pick the highest:
  //   1. totalActiveTime (seconds, from upstream API)
  //   2. activeDays (whole-day count, from upstream API)
  //   3. date-range: startDate → end-marker, where end-marker is now (active),
  //      endDate (ended w/ date), or lastSeenAt (ended, no end date)
  // Falling back through all three means we don't render "0d" just because
  // the brand.is_active flag is stale (separate worker bug) — we still have
  // startDate + lastSeenAt to reason about.
  const tatDays  = ad.totalActiveTime != null ? Math.floor(ad.totalActiveTime / 86400) : null;
  const apiDays  = ad.activeDays != null ? ad.activeDays : null;

  let rangeDays = null;
  if (ad.startDate) {
    const startMs = new Date(ad.startDate).getTime();
    let endMs = null;
    if (ad.isActive)        endMs = Date.now();
    else if (ad.endDate)    endMs = new Date(ad.endDate).getTime();
    else if (ad.lastSeenAt) endMs = new Date(ad.lastSeenAt).getTime();
    if (endMs != null && endMs > startMs) {
      rangeDays = Math.floor((endMs - startMs) / 86400000);
    }
  }

  const candidates = [tatDays, apiDays, rangeDays].filter((v) => v != null && v > 0);
  return candidates.length ? Math.max(...candidates) : null;
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
// AdCard — card with page header, ••• menu, inline video player
// ---------------------------------------------------------------------------

function fmtTime(s) {
  if (!isFinite(s) || s < 0) return '0:00';
  const m   = Math.floor(s / 60);
  const sec = Math.floor(s % 60);
  return `${m}:${sec.toString().padStart(2, '0')}`;
}

function AdCard({ ad, brand, onOpenIntel }) {
  const [imgFailed,   setImgFailed]   = useState(false);
  const [playing,     setPlaying]     = useState(false);
  const [paused,      setPaused]      = useState(false);
  const [currentTime, setCurrentTime] = useState(0);
  const [duration,    setDuration]    = useState(0);
  const [muted,       setMuted]       = useState(false);
  const [menuOpen,    setMenuOpen]    = useState(false);
  const [copied,      setCopied]      = useState(false);
  const [downloading, setDownloading] = useState(false);
  const videoRef = useRef(null);
  const menuRef  = useRef(null);

  const fmt      = classifyAdFormat(ad);
  const days     = liveActiveDays(ad);
  const hasVideo = fmt === 'VIDEO' && !!ad.videoUrl;
  const hookText = ad.headline || (ad.bodyText ? ad.bodyText.slice(0, 120) : null) || '';

  // Resolve page info for header
  const page       = brand?.pages?.find((p) => p.id === ad.brandPageId) ?? null;
  const pageName   = ad.pageName ?? page?.pageName ?? brand?.domain ?? '';
  const pageAvatar = { pageName, pageProfilePic: page?.pageProfilePic ?? null };

  // Autoplay when playing flips on
  useEffect(() => {
    if (playing && videoRef.current) videoRef.current.play().catch(() => {});
  }, [playing]);

  // Close ••• menu on outside click
  useEffect(() => {
    if (!menuOpen) return;
    const h = (e) => { if (menuRef.current && !menuRef.current.contains(e.target)) setMenuOpen(false); };
    document.addEventListener('mousedown', h);
    return () => document.removeEventListener('mousedown', h);
  }, [menuOpen]);

  const adLibUrl = ad.adArchiveId
    ? `https://www.facebook.com/ads/library/?id=${ad.adArchiveId}`
    : null;

  const handleCopyLink = async (e) => {
    e.stopPropagation();
    try { await navigator.clipboard.writeText(adLibUrl || ad.videoUrl || ''); } catch {}
    setCopied(true);
    setMenuOpen(false);
    setTimeout(() => setCopied(false), 2000);
  };

  const handleDownload = async (e) => {
    e.stopPropagation();
    setMenuOpen(false);
    if (!ad.videoUrl) return;
    setDownloading(true);
    try {
      const res  = await fetch(ad.videoUrl);
      const blob = await res.blob();
      const url  = URL.createObjectURL(blob);
      const a    = document.createElement('a');
      a.href = url; a.download = `${ad.adArchiveId || 'ad'}.mp4`;
      document.body.appendChild(a); a.click();
      document.body.removeChild(a);
      setTimeout(() => URL.revokeObjectURL(url), 1000);
    } catch {
      window.open(ad.videoUrl, '_blank');
    } finally {
      setDownloading(false);
    }
  };

  const handlePlayClick = (e) => {
    e.stopPropagation();
    if (!hasVideo) return;
    setPlaying(true); setPaused(false);
  };

  const togglePlayPause = (e) => {
    e.stopPropagation();
    const v = videoRef.current;
    if (!v) return;
    if (v.paused) { v.play(); setPaused(false); }
    else          { v.pause(); setPaused(true); }
  };

  const handleSeek = (e) => {
    e.stopPropagation();
    const val = Number(e.target.value);
    if (videoRef.current) videoRef.current.currentTime = val;
    setCurrentTime(val);
  };

  const toggleMute = (e) => {
    e.stopPropagation();
    const v = videoRef.current;
    if (!v) return;
    v.muted = !v.muted; setMuted(v.muted);
  };

  const handleFullscreen = (e) => {
    e.stopPropagation();
    const v = videoRef.current;
    if (!v) return;
    if (v.requestFullscreen) v.requestFullscreen();
    else if (v.webkitRequestFullscreen) v.webkitRequestFullscreen();
  };

  return (
    <div
      onClick={() => onOpenIntel(ad)}
      className="group flex flex-col bg-bg-elevated border border-border-subtle rounded-lg overflow-hidden cursor-pointer hover:border-white/20 transition-all hover:shadow-lg"
    >
      {/* ── Page header ── (clicks bubble up to open IntelDrawer; ••• menu
            and dropdown items stop propagation individually). */}
      <div className="flex items-center gap-1.5 px-2 pt-2 pb-1.5 shrink-0">
        <PageAvatar page={pageAvatar} size={20} />
        <span className="text-[11px] font-semibold text-text-primary flex-1 truncate min-w-0">{pageName}</span>
        {/* ••• menu */}
        <div className="relative shrink-0" ref={menuRef}>
          <button
            onClick={(e) => { e.stopPropagation(); setMenuOpen((o) => !o); }}
            className="w-6 h-6 flex items-center justify-center rounded-md text-text-faint hover:text-text-primary hover:bg-white/5 transition-colors">
            <MoreHorizontal className="w-4 h-4" />
          </button>
          {menuOpen && (
            <div
              className="absolute right-0 top-full mt-1 w-40 rounded-xl shadow-2xl z-[60] overflow-hidden py-1"
              style={{ background: '#1e1e1e', border: '1px solid #303030' }}>
              <button
                onClick={(e) => { e.stopPropagation(); onOpenIntel(ad); setMenuOpen(false); }}
                className="w-full flex items-center gap-2.5 px-3.5 py-2 text-[13px] text-text-muted hover:bg-white/5 hover:text-text-primary text-left transition-colors">
                <Info className="w-3.5 h-3.5 shrink-0" /> Ad details
              </button>
              <button
                onClick={handleCopyLink}
                className="w-full flex items-center gap-2.5 px-3.5 py-2 text-[13px] text-text-muted hover:bg-white/5 hover:text-text-primary text-left transition-colors">
                <Copy className="w-3.5 h-3.5 shrink-0" /> {copied ? 'Copied!' : 'Copy link'}
              </button>
              {hasVideo && (
                <button
                  onClick={handleDownload}
                  disabled={downloading}
                  className="w-full flex items-center gap-2.5 px-3.5 py-2 text-[13px] text-text-muted hover:bg-white/5 hover:text-text-primary text-left transition-colors disabled:opacity-50">
                  <Download className="w-3.5 h-3.5 shrink-0" /> {downloading ? 'Downloading…' : 'Download'}
                </button>
              )}
            </div>
          )}
        </div>
      </div>

      {/* ── Status + date + days ── (clicks bubble to open IntelDrawer) */}
      <div className="px-2 pb-1.5 shrink-0">
        <p className="text-[12px] flex items-center gap-1.5 text-text-faint">
          <span className={`w-2 h-2 rounded-full shrink-0 ${isAdActive(ad) ? 'bg-emerald-400' : 'bg-zinc-600'}`} />
          <span className="truncate">{fmtLaunch(ad.startDate)} – {isAdActive(ad) ? 'Present' : (ad.endDate ? fmtLaunch(ad.endDate) : '?')}</span>
          {days != null && (
            <span className={`ml-auto tabular-nums shrink-0 ${days >= 30 ? 'text-emerald-400 font-semibold' : 'text-text-faint'}`}>
              {days}d
            </span>
          )}
        </p>
      </div>

      {/* ── Body text ── (clicks bubble to open IntelDrawer) */}
      {hookText && (
        <div className="px-2 pb-1.5 shrink-0">
          <p className="text-[11px] text-text-muted leading-snug line-clamp-1">{hookText}</p>
        </div>
      )}

      {/* ── Thumbnail / Inline Video ── */}
      <div className="relative bg-zinc-950 shrink-0" style={{ aspectRatio: '4/5' }}>

        {playing && ad.videoUrl ? (
          <>
            <video
              ref={videoRef}
              src={ad.videoUrl}
              className="w-full h-full object-contain bg-black cursor-pointer"
              onClick={togglePlayPause}
              onTimeUpdate={() => setCurrentTime(videoRef.current?.currentTime ?? 0)}
              onLoadedMetadata={() => setDuration(videoRef.current?.duration ?? 0)}
              onEnded={() => setPaused(true)}
              onPlay={() => setPaused(false)}
              onPause={() => setPaused(true)}
            />
            {/* Controls overlay */}
            <div
              className="absolute bottom-0 left-0 right-0 z-30 px-2 pt-6 pb-2 flex flex-col gap-1.5"
              style={{ background: 'linear-gradient(to top, rgba(0,0,0,0.88) 0%, rgba(0,0,0,0.3) 70%, transparent 100%)' }}
              onClick={(e) => e.stopPropagation()}
            >
              <input
                type="range" min={0} max={duration || 100} step={0.1} value={currentTime}
                onChange={handleSeek}
                className="w-full h-1 cursor-pointer rounded-full appearance-none bg-white/20"
                style={{ accentColor: 'white' }}
              />
              <div className="flex items-center gap-2">
                <button onClick={togglePlayPause} className="text-white hover:text-white/70 transition-colors shrink-0">
                  {paused ? <Play className="w-3.5 h-3.5" fill="white" /> : <Pause className="w-3.5 h-3.5" fill="white" />}
                </button>
                <span className="text-[10px] text-white/60 font-mono tabular-nums leading-none">
                  {fmtTime(currentTime)} / {fmtTime(duration)}
                </span>
                <div className="flex-1" />
                <button onClick={toggleMute} className="text-white/60 hover:text-white transition-colors shrink-0">
                  {muted ? <VolumeX className="w-3.5 h-3.5" /> : <Volume2 className="w-3.5 h-3.5" />}
                </button>
                <button onClick={handleFullscreen} className="text-white/60 hover:text-white transition-colors shrink-0">
                  <Maximize2 className="w-3.5 h-3.5" />
                </button>
              </div>
            </div>
          </>
        ) : (
          <>
            {ad.thumbnailUrl && !imgFailed ? (
              <img src={ad.thumbnailUrl} alt="" className="w-full h-full object-cover"
                onError={() => setImgFailed(true)} />
            ) : (
              <div className="w-full h-full flex items-center justify-center">
                <span className="text-text-faint text-[11px] uppercase tracking-widest opacity-40">{fmt}</span>
              </div>
            )}
            <div className="absolute inset-0 bg-black/15 opacity-0 group-hover:opacity-100 transition-opacity pointer-events-none" />
            {hasVideo && (
              <button onClick={handlePlayClick}
                className="absolute inset-0 flex items-center justify-center z-10" title="Play inline">
                <div className="w-9 h-9 rounded-full bg-black/60 backdrop-blur-sm flex items-center justify-center border border-white/20 group-hover:scale-110 transition-transform">
                  <Play className="w-4 h-4 text-white ml-0.5" fill="white" />
                </div>
              </button>
            )}
          </>
        )}

        {/* Active indicator only — format badge removed per request.
            Visual format cue is the play overlay (videos) or its absence (images). */}
        {!playing && isAdActive(ad) && (
          <div className="absolute top-2 left-2 z-20 pointer-events-none flex items-center">
            <span className="relative flex items-center justify-center" title="Active">
              <span className="absolute w-3 h-3 rounded-full bg-emerald-400 opacity-60 animate-ping" />
              <span className="relative w-2.5 h-2.5 rounded-full bg-emerald-400 ring-2 ring-black/40" />
            </span>
          </div>
        )}
        {/* Tier badge — top right */}
        {ad.tier && !playing && (
          <div className="absolute top-2 right-2 z-20 pointer-events-none">
            <span className={`text-[9px] font-bold px-1.5 py-0.5 rounded-md border backdrop-blur-sm ${TIER_COLORS[ad.tier] ?? ''}`}
              title={TIER_TOOLTIPS[ad.tier]}>
              {TIER_ICONS[ad.tier] ?? ''}{ad.tier}
            </span>
          </div>
        )}
      </div>

      {/* ── Footer — Facebook-style link-preview card
            Matches how Meta renders the destination card under an ad:
              hostname (small gray) / headline (bold) / caption (small)
              + CTA button on the right.
            Pulls hostname from ad.linkUrl, headline from ad.headline,
            caption from ad.caption or first emoji-line of bodyText. */}
      {(ad.headline || ad.linkUrl || ad.caption || ad.ctaText) && (
        <div className="px-2 py-1.5 shrink-0 border-t border-border-subtle bg-bg-card/50">
          <div className="flex items-center gap-2">
            <div className="min-w-0 flex-1">
              {ad.linkUrl && (
                <p className="text-[9px] text-text-faint truncate lowercase">
                  {(() => {
                    try {
                      return new URL(ad.linkUrl.startsWith('http') ? ad.linkUrl : `https://${ad.linkUrl}`)
                        .hostname.replace(/^www\./, '');
                    } catch { return ad.linkUrl.split('/')[0]; }
                  })()}
                </p>
              )}
              {ad.headline && (
                <p className="text-[11px] font-semibold text-text-primary truncate leading-tight mt-0.5">
                  {ad.headline}
                </p>
              )}
              {ad.caption && (
                <p className="text-[10px] text-text-faint truncate leading-tight mt-0.5">
                  {ad.caption}
                </p>
              )}
            </div>
            {ad.ctaText && (
              <span className="shrink-0 text-[10px] font-medium px-2 py-1 rounded border border-border-default bg-bg-elevated text-text-primary whitespace-nowrap">
                {ad.ctaText}
              </span>
            )}
          </div>
        </div>
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------
// MediaMixBar
// ---------------------------------------------------------------------------

// counts shape: { VIDEO, IMAGE, CAROUSEL, OTHER, TOTAL }
// Atria-style card: bold title, colored bar, format rows with icon + dot.
// Green/blue/amber palette so the densest format reads at a glance.
function MediaMixBar({ counts }) {
  if (!counts || !counts.TOTAL) {
    return (
      <div className="rounded-xl border border-border-subtle bg-bg-card p-4 space-y-3">
        <p className="text-[13px] font-semibold text-text-primary">Media mix</p>
        <div className="h-2 rounded-full bg-white/[0.04] animate-pulse" />
        <div className="space-y-2 pt-0.5">
          {[0,1,2].map((i) => <div key={i} className="h-4 rounded bg-white/[0.04] animate-pulse" />)}
        </div>
      </div>
    );
  }
  const total = counts.TOTAL;
  const videos = counts.VIDEO;
  const images = counts.IMAGE;
  const carousels = counts.CAROUSEL;
  const vPct = total ? (videos / total) * 100    : 0;
  const iPct = total ? (images / total) * 100    : 0;
  const cPct = total ? (carousels / total) * 100 : 0;

  const rows = [
    { Icon: VideoIcon,    dot: 'bg-emerald-500', label: 'Video',    count: videos,    pct: vPct },
    { Icon: ImageIcon,    dot: 'bg-sky-500',     label: 'Image',    count: images,    pct: iPct },
    ...(carousels > 0
      ? [{ Icon: CarouselIcon, dot: 'bg-amber-500', label: 'Carousel', count: carousels, pct: cPct }]
      : []),
  ];

  return (
    <div className="rounded-xl border border-border-subtle bg-bg-card p-4 space-y-3">
      <p className="text-[13px] font-semibold text-text-primary">Media mix</p>
      <div className="h-2 rounded-full bg-white/[0.04] flex overflow-hidden gap-px">
        {vPct > 0 && <div className="h-full bg-emerald-500 transition-all" style={{ width: `${vPct}%` }} />}
        {iPct > 0 && <div className="h-full bg-sky-500     transition-all" style={{ width: `${iPct}%` }} />}
        {cPct > 0 && <div className="h-full bg-amber-500   transition-all" style={{ width: `${cPct}%` }} />}
      </div>
      <div className="space-y-2 pt-0.5">
        {rows.map(({ Icon, dot, label, count, pct }) => (
          <div key={label} className="flex items-center gap-2 text-[13px]">
            <span className={`w-2 h-2 rounded-full shrink-0 ${dot}`} />
            <Icon className="w-4 h-4 text-text-faint shrink-0" />
            <span className="text-text-primary">{label}</span>
            <span className="ml-auto tabular-nums text-text-muted">{count.toLocaleString()} ads</span>
            <span className="text-text-primary font-medium tabular-nums w-14 text-right">{pct.toFixed(1)}%</span>
          </div>
        ))}
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// IntelPanel — AI analysis tags (Atria-style: full-width, no card border)
// ---------------------------------------------------------------------------

function IntelPanel({ intel, intelLoading, intelError, onRetry }) {
  const headerNode = (
    <div className="flex items-center gap-1.5 mb-1.5">
      <Sparkles className="w-3 h-3 text-zinc-500" />
      <span className="text-[12px] font-semibold text-text-primary">AI Brand Intel</span>
      <span className="text-[9px] text-text-faint ml-0.5">via Claude Haiku</span>
    </div>
  );

  if (intelLoading) {
    return (
      <div>
        {headerNode}
        <div>
          {INTEL_CATS.map((cat) => (
            <div key={cat.key} className="flex items-center gap-2 py-1.5 border-b border-white/[0.04] last:border-b-0">
              <div className="flex items-center gap-1.5 shrink-0" style={{ width: 110 }}>
                <span className="text-[11px] leading-none">{cat.icon}</span>
                <span className="text-[9px] uppercase tracking-wider text-text-faint">Top {cat.label.toLowerCase()}</span>
              </div>
              <div className="flex flex-wrap gap-1 flex-1">
                {[88, 128, 96, 112, 80].map((w, i) => (
                  <div key={i} className="h-4 rounded-full bg-white/5 animate-pulse" style={{ width: w }} />
                ))}
              </div>
            </div>
          ))}
        </div>
      </div>
    );
  }

  if (intelError) {
    return (
      <div>
        {headerNode}
        <div className="flex items-center justify-between py-1">
          <div className="flex items-center gap-2">
            <AlertCircle className="w-3.5 h-3.5 text-red-400 shrink-0" />
            <span className="text-sm text-text-muted">Could not load AI intel — {intelError}</span>
          </div>
          <button onClick={onRetry} className="flex items-center gap-1.5 text-xs text-text-faint hover:text-text-primary transition-colors shrink-0 ml-4">
            <RotateCcw className="w-3 h-3" /> Retry
          </button>
        </div>
      </div>
    );
  }

  if (!intel) return null;

  const hasData = INTEL_CATS.some((cat) => (intel[cat.key] ?? []).length > 0);
  if (!hasData) return (
    <div>
      {headerNode}
      <div className="flex items-center gap-2 py-1">
        <span className="text-sm text-text-faint">No ad text to analyze yet.</span>
      </div>
    </div>
  );

  return (
    <div>
      {headerNode}
      <div>
        {INTEL_CATS.map((cat) => {
          const items = intel[cat.key] ?? [];
          if (!items.length) return null;
          return (
            <div key={cat.key} className="flex items-start gap-2 py-1.5 border-b border-white/[0.04] last:border-b-0">
              <div className="flex items-center gap-1.5 shrink-0 pt-0.5" style={{ width: 110 }}>
                <span className="text-[11px] leading-none">{cat.icon}</span>
                <span className="text-[9px] uppercase tracking-wider text-text-faint">Top {cat.label.toLowerCase()}</span>
              </div>
              <div className="flex flex-wrap gap-1 flex-1">
                {items.map((item, i) => (
                  <span key={i} className={`text-[10px] px-1.5 py-0.5 rounded border leading-snug ${INTEL_PILL_CLASS}`}>
                    {item}
                  </span>
                ))}
              </div>
            </div>
          );
        })}
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// SortDropdown — custom "Sort: X ▼" styled dropdown
// ---------------------------------------------------------------------------

// ---------------------------------------------------------------------------
// "Currently active" heuristic — used for the green dot indicator. Mirrors
// the backend status='ACTIVE' SQL clause so the filter and the dot agree.
// Active = is_active flag is true OR we saw it in the ad-library within the
// last 2 days. (The worker is currently flipping both is_active and end_date
// spuriously — separate task — so freshness is the most reliable signal.)
// ---------------------------------------------------------------------------
function isAdActive(ad) {
  if (ad?.isActive === true) return true;
  if (!ad?.lastSeenAt) return false;
  const ageMs = Date.now() - new Date(ad.lastSeenAt).getTime();
  return ageMs <= 2 * 86400000;
}

// FilterDropdown — checkbox-style picker for Format / Status. Single-select
// for now; "Clear" deselects. Closed-state shows current selection or label.
function FilterDropdown({ label, value, onChange, options }) {
  const { open, setOpen, ref } = useDropdown();
  const current = options.find((o) => o.value === value);
  return (
    <div className="relative" ref={ref}>
      <button onClick={() => setOpen((o) => !o)}
        className={`flex items-center gap-1.5 px-3 py-1.5 rounded-lg border text-xs transition-colors ${
          value
            ? 'bg-white/10 text-white border-white/20'
            : 'bg-bg-elevated text-text-muted border-border-default hover:bg-bg-hover'
        }`}>
        <span>{current?.label ?? label}</span>
        <ChevronDown className={`w-3 h-3 transition-transform ${open ? 'rotate-180' : ''}`} />
      </button>
      {open && (
        <div className="absolute top-full left-0 mt-1.5 w-44 rounded-xl shadow-2xl z-50 overflow-hidden py-1"
          style={{ background: '#1e1e1e', border: '1px solid #303030' }}>
          {options.map((opt) => {
            const selected = opt.value === value;
            return (
              <button key={opt.value}
                onClick={() => { onChange(selected ? null : opt.value); setOpen(false); }}
                className="w-full flex items-center gap-2.5 px-3.5 py-2 text-[13px] text-text-muted hover:bg-white/5 hover:text-text-primary text-left transition-colors">
                <span className={`w-3.5 h-3.5 rounded border flex items-center justify-center shrink-0 ${
                  selected ? 'bg-white border-white' : 'border-text-faint'
                }`}>
                  {selected && <span className="text-[10px] text-black font-bold leading-none">✓</span>}
                </span>
                {opt.label}
              </button>
            );
          })}
          {value && (
            <>
              <div className="h-px bg-white/[0.06] my-1" />
              <button onClick={() => { onChange(null); setOpen(false); }}
                className="w-full px-3.5 py-1.5 text-[12px] text-text-faint hover:text-text-primary text-center transition-colors">
                Clear
              </button>
            </>
          )}
        </div>
      )}
    </div>
  );
}

function SortDropdown({ value, onChange, options }) {
  const { open, setOpen, ref } = useDropdown();
  const current = options.find((o) => o.value === value);
  return (
    <div className="relative text-xs" ref={ref}>
      <button
        onClick={() => setOpen((o) => !o)}
        className="flex items-center gap-1.5 text-text-muted hover:text-text-primary transition-colors">
        <span className="text-text-faint">Sort:</span>
        <span className="font-medium text-text-primary">{current?.label ?? value}</span>
        <ChevronDown className={`w-3 h-3 text-text-faint transition-transform ${open ? 'rotate-180' : ''}`} />
      </button>
      {open && (
        <div className="absolute right-0 top-full mt-1.5 w-44 rounded-xl shadow-2xl z-50 overflow-hidden py-1"
          style={{ background: '#1e1e1e', border: '1px solid #303030' }}>
          {options.map((opt) => (
            <button
              key={opt.value}
              onClick={() => { onChange(opt.value); setOpen(false); }}
              className={`w-full text-left px-4 py-2 text-[13px] transition-colors ${
                opt.value === value
                  ? 'text-white bg-white/5'
                  : 'text-text-muted hover:bg-white/5 hover:text-white'
              }`}>
              {opt.label}
            </button>
          ))}
        </div>
      )}
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
  const [formatFilter, setFormatFilter] = useState(null);    // 'VIDEO' | 'IMAGE' | 'CAROUSEL' | null
  const [statusFilter, setStatusFilter] = useState(null);    // 'ACTIVE' | 'INACTIVE' | null
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
  // Overview-dashboard side data (brand-wide media mix + aggregation totals)
  const [formatCounts, setFormatCounts] = useState(null);
  const [aggCounts, setAggCounts]       = useState(null);
  // Drawer
  const [selectedAd, setSelectedAd]     = useState(null);

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
      if (formatFilter) params.set('format', formatFilter);
      if (statusFilter) params.set('status', statusFilter);
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
  }, [apiBaseUrl, brandId, page, sort, tierFilter, pageFilter, timeFilter, formatFilter, statusFilter, activeTab]);

  useEffect(() => { loadAds(); }, [loadAds]);
  useEffect(() => { setPage(1); }, [tierFilter, pageFilter, sort, timeFilter, formatFilter, statusFilter, activeTab]);

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

  // ---- Brand-wide media-mix counts (for the Overview Media-Mix card) ----
  useEffect(() => {
    if (activeTab !== 'overview' || !brandId) return;
    let cancelled = false;
    fetch(`${apiBaseUrl}/brands/${brandId}/format-counts`)
      .then((r) => (r.ok ? r.json() : { counts: null }))
      .then((d) => { if (!cancelled) setFormatCounts(d.counts ?? null); })
      .catch(() => { if (!cancelled) setFormatCounts(null); });
    return () => { cancelled = true; };
  }, [apiBaseUrl, brandId, activeTab]);

  // ---- Aggregation totals for the 4 mini stat boxes (Hooks/Ad copy/etc.) ----
  useEffect(() => {
    if (activeTab !== 'overview' || !brandId) return;
    let cancelled = false;
    const fetchTotal = (type) =>
      fetch(`${apiBaseUrl}/brands/${brandId}/aggregations?type=${type}&limit=1`)
        .then((r) => (r.ok ? r.json() : { total: 0 }))
        .then((d) => d.total ?? 0)
        .catch(() => 0);
    Promise.all([
      fetchTotal('hooks'),
      fetchTotal('adcopy'),
      fetchTotal('headlines'),
      fetchTotal('landing'),
    ]).then(([hooks, adcopy, headlines, landing]) => {
      if (!cancelled) setAggCounts({ hooks, adcopy, headlines, landing });
    });
    return () => { cancelled = true; };
  }, [apiBaseUrl, brandId, activeTab]);

  // ---- Open ad in IntelDrawer by ID (used by aggregation tabs) ----
  const openAdById = useCallback(async (adId) => {
    if (!adId) return;
    try {
      const res = await fetch(`${apiBaseUrl}/ads/${adId}`);
      if (!res.ok) throw new Error(`Failed (${res.status})`);
      const data = await res.json();
      if (data.ad) setSelectedAd(data.ad);
    } catch (e) {
      console.error('[brand-spy] failed to load ad:', e);
    }
  }, [apiBaseUrl]);

  // ---- Refresh (re-scrape) ----
  // The scrape endpoint returns 202 immediately — poll brand status until the
  // background job finishes (lastScrapeStatus leaves 'RUNNING'), then reload
  // ads and reset AI intel so it re-analyzes the fresh ad set.
  const handleRefresh = async () => {
    if (refreshing) return;
    setRefreshing(true);
    setRefreshError(null);
    try {
      const scrapeRes = await fetch(`${apiBaseUrl}/brands/${brandId}/scrape`, { method: 'POST' });
      if (!scrapeRes.ok) {
        const body = await scrapeRes.json().catch(() => ({}));
        throw new Error(body.error || `Scrape trigger failed (${scrapeRes.status})`);
      }

      // Poll every 2s until not RUNNING (or 5-min timeout)
      const deadline = Date.now() + 5 * 60 * 1000;
      while (Date.now() < deadline) {
        await new Promise((resolve) => setTimeout(resolve, 2000));
        const r = await fetch(`${apiBaseUrl}/brands/${brandId}`);
        if (r.ok) {
          const d = await r.json();
          if (d.brand) {
            setBrand(d.brand);
            if (d.brand.lastScrapeStatus !== 'RUNNING') break;
          }
        }
      }

      await loadAds();
      // Reset intel so it re-analyzes the freshly-scraped ads
      setIntelFetched(false);
      setIntel(null);
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

            {/* Filter bar — time-window pills + Format + Status (Overview only) */}
            <div className="flex items-center gap-3 flex-wrap">
              {/* Time window pills */}
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

              {/* Format + Status filters */}
              <FilterDropdown
                label="Format"
                value={formatFilter}
                onChange={setFormatFilter}
                options={[
                  { value: 'VIDEO',    label: 'Video' },
                  { value: 'IMAGE',    label: 'Image' },
                  { value: 'CAROUSEL', label: 'Carousel' },
                ]}
              />
              <FilterDropdown
                label="Status"
                value={statusFilter}
                onChange={setStatusFilter}
                options={[
                  { value: 'ACTIVE',   label: 'Active' },
                  { value: 'INACTIVE', label: 'Inactive' },
                ]}
              />
            </div>

            {/* Summary text — plain line above the cards (Atria layout). */}
            {(() => {
              const tf = TIME_FILTERS.find((f) => f.value === timeFilter);
              const label = tf?.value === 'all' ? null : tf?.label;
              return (
                <p className="text-[14px] text-text-muted leading-snug">
                  <span className="text-xl font-bold text-text-primary tabular-nums">{total.toLocaleString()}</span>
                  {' '}<span className="text-text-primary font-semibold">ads</span>{' '}
                  {label
                    ? <>were launched in the <span className="text-text-primary font-semibold">last {label}</span></>
                    : <>tracked across <span className="text-text-primary font-semibold">all time</span></>}
                  {brand?.activeAdsCount != null && (
                    <>{', including '}
                      <span className="text-text-primary font-semibold tabular-nums">
                        {(brand.activeAdsCount).toLocaleString()}
                      </span> currently active</>
                  )}
                  .
                </p>
              );
            })()}

            {/* Two-column dashboard. LEFT = stacked Media-mix card + 4-stat
                card. RIGHT = AI Brand Intel card. */}
            <div className="grid grid-cols-1 lg:grid-cols-2 gap-3">
              {/* LEFT column — two stacked cards */}
              <div className="space-y-3">
                <MediaMixBar counts={formatCounts} />

                <div className="rounded-xl border border-border-subtle bg-bg-card p-4">
                  <div className="grid grid-cols-4 gap-2">
                    {[
                      { label: 'Hooks',     value: aggCounts?.hooks,     tabId: 'hooks'     },
                      { label: 'Ad copy',   value: aggCounts?.adcopy,    tabId: 'adcopy'    },
                      { label: 'Headlines', value: aggCounts?.headlines, tabId: 'headlines' },
                      { label: 'LPs',       value: aggCounts?.landing,   tabId: 'landing'   },
                    ].map(({ label, value, tabId }) => (
                      <button key={label}
                        onClick={() => setActiveTab(tabId)}
                        className="text-center group hover:bg-white/[0.02] rounded-md py-1 transition-colors">
                        <p className="text-[20px] font-bold text-text-primary tabular-nums leading-none">
                          {value == null ? '—' : (value >= 100 ? '99+' : value)}
                        </p>
                        <p className="text-[11px] text-text-muted mt-1.5 group-hover:text-text-primary transition-colors">
                          {label}
                        </p>
                      </button>
                    ))}
                  </div>
                </div>
              </div>

              {/* RIGHT column — AI Brand Intel card */}
              <div className="rounded-xl border border-border-subtle bg-bg-card p-4">
                <IntelPanel intel={intel} intelLoading={intelLoading} intelError={intelError} onRetry={loadIntel} />
              </div>
            </div>

            {/* Count + sort — "1421 Ads" header above grid */}
            {!adsLoading && total > 0 && (
              <div className="flex items-center justify-between pt-2">
                <span className="text-base font-semibold text-text-primary tabular-nums">
                  {total.toLocaleString()} <span className="text-text-muted font-normal">Ads</span>
                </span>
                <SortDropdown value={sort} onChange={setSort} options={SORT_OPTIONS} />
              </div>
            )}

            {/* Ad grid */}
            {adsLoading ? (
              <div className="grid items-start grid-cols-4 lg:grid-cols-5 xl:grid-cols-6 2xl:grid-cols-7 gap-2">
                {Array.from({ length: 16 }).map((_, i) => (
                  <div key={i} className="rounded-xl border border-border-subtle overflow-hidden animate-pulse">
                    <div className="bg-white/5" style={{ aspectRatio: '4/5' }} />
                    <div className="p-2 space-y-1.5">
                      <div className="h-2.5 bg-white/5 rounded" />
                      <div className="h-2.5 bg-white/5 rounded w-2/3" />
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
                <div className="grid items-start grid-cols-4 lg:grid-cols-5 xl:grid-cols-6 2xl:grid-cols-7 gap-2">
                  {ads.map((ad) => <AdCard key={ad.id} ad={ad} brand={brand} onOpenIntel={setSelectedAd} />)}
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
              <SortDropdown value={sort} onChange={setSort} options={SORT_OPTIONS} />

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
            Aggregation tabs: Hooks / Ad Copy / Headlines / Landing Pages
        ============================================================ */}
        {activeTab === 'hooks' && (
          <AggregationsTab apiBaseUrl={apiBaseUrl} brandId={brandId} type="hooks" onOpenAd={openAdById} />
        )}
        {activeTab === 'adcopy' && (
          <AggregationsTab apiBaseUrl={apiBaseUrl} brandId={brandId} type="adcopy" onOpenAd={openAdById} />
        )}
        {activeTab === 'headlines' && (
          <AggregationsTab apiBaseUrl={apiBaseUrl} brandId={brandId} type="headlines" onOpenAd={openAdById} />
        )}
        {activeTab === 'landing' && (
          <AggregationsTab apiBaseUrl={apiBaseUrl} brandId={brandId} type="landing" onOpenAd={openAdById} />
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
