import { useEffect, useRef, useState, useCallback } from 'react';
import {
  ArrowLeft, ExternalLink, RefreshCw,
  ChevronDown, Settings2, Globe, ScanSearch,
} from 'lucide-react';
import IntelDrawer from './IntelDrawer';

// ---------------------------------------------------------------------------
// Constants (same as BrandLeague)
// ---------------------------------------------------------------------------

const PAGE_SIZE = 50;

const TIER_COLORS = {
  BANGER: 'bg-rose-500/15 text-rose-400 border-rose-500/30',
  CHAMP:  'bg-amber-500/15 text-amber-400 border-amber-500/30',
  A:      'bg-emerald-500/15 text-emerald-400 border-emerald-500/30',
  B:      'bg-sky-500/15 text-sky-400 border-sky-500/30',
  C:      'bg-zinc-700/40 text-zinc-400 border-zinc-700',
  MID:    'bg-bg-elevated text-text-faint border-border-default',
  TEST:   'bg-bg-card text-text-faint border-border-subtle',
};
const TIER_ICONS    = { BANGER: '🔥', CHAMP: '🏆' };
const TIER_TOOLTIPS = {
  BANGER: '🔥 BANGER — Top 3% in active < 10 days',
  CHAMP:  '🏆 CHAMP — Top 10%',
  A:      'A — Top 25%',
  B:      'B — Top 50%',
  C:      'C — Top 75%',
  MID:    'MID — Bottom 25%',
  TEST:   'TEST — Bottom 10%',
};
const TIER_FILTERS = ['ALL', 'BANGER', 'CHAMP', 'A', 'B', 'C', 'MID', 'TEST'];
const TIER_LABELS  = { ALL:'ALL', BANGER:'🔥 BANGER', CHAMP:'🏆 CHAMP', A:'A', B:'B', C:'C', MID:'MID', TEST:'TEST' };

const SORT_OPTIONS = [
  { value: 'rank_asc',          label: 'Top rank' },
  { value: 'velocity_7d_desc',  label: 'Climbing fast' },
  { value: 'active_days_desc',  label: 'Longest running' },
  { value: 'first_seen_desc',   label: 'Newest' },
];

const ALL_COLUMNS = [
  { key: 'num',      label: '#',      locked: true,  width: 42 },
  { key: 'ad',       label: 'AD',     locked: true,  width: 280 },
  { key: 'page',     label: 'PAGE',   locked: false, width: 150 },
  { key: 'launch',   label: 'LAUNCH', locked: false, width: 80 },
  { key: 'status',   label: 'STATUS', locked: false, width: 60 },
  { key: 'format',   label: 'FORMAT', locked: false, width: 70 },
  { key: 'rank21d',  label: '21D',    locked: false, width: 75 },
  { key: 'rank7d',   label: '7D',     locked: false, width: 75 },
  { key: 'rank3d',   label: '3D',     locked: false, width: 75 },
  { key: 'now',      label: 'NOW',    locked: true,  width: 75 },
  { key: 'active',   label: 'ACTIVE', locked: false, width: 60 },
  { key: 'tier',     label: 'TIER',   locked: true,  width: 90 },
  { key: 'v7d',      label: 'V7D',    locked: false, width: 60 },
  { key: 'v21d',     label: 'V21D',   locked: false, width: 60 },
];

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function fmtLaunch(iso) {
  if (!iso) return '—';
  const d = new Date(iso);
  const now = new Date();
  return d.toLocaleDateString('en-US', {
    month: 'short', day: 'numeric',
    ...(d.getFullYear() !== now.getFullYear() ? { year: '2-digit' } : {}),
  });
}

function liveActiveDays(ad) {
  const tatDays = ad.totalActiveTime != null ? Math.floor(ad.totalActiveTime / 86400) : null;
  if (ad.startDate && ad.isActive) {
    const fromStart = Math.max(0, Math.floor((Date.now() - new Date(ad.startDate).getTime()) / 86400000));
    return tatDays != null ? Math.max(fromStart, tatDays) : fromStart;
  }
  return tatDays ?? ad.activeDays ?? null;
}

function fmtCount(n) {
  if (!n) return '0';
  if (n >= 1000) return `${(n / 1000).toFixed(n >= 10000 ? 0 : 1)}K`;
  return String(n);
}

function relTime(iso) {
  if (!iso) return 'never';
  const diff = Date.now() - new Date(iso).getTime();
  const days = Math.floor(diff / 86400000);
  if (days >= 1) return `${days}d ago`;
  const hours = Math.floor(diff / 3600000);
  if (hours >= 1) return `${hours}h ago`;
  return 'just now';
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

const COL_TOOLTIPS = {
  now: (<><p className="text-xs font-bold text-white mb-1">Current Rank</p><p className="text-[11px] leading-relaxed" style={{ color: '#9ca3af' }}>Where this ad ranks <span className="text-white font-medium">right now</span> in the active pool. Format is <span className="text-white font-medium">rank / pool size</span>. Lower = stronger.</p></>),
  active: (<><p className="text-xs font-bold text-white mb-1">Active Days</p><p className="text-[11px] leading-relaxed" style={{ color: '#9ca3af' }}>How many days this ad has been running since it launched. Ads running for <span style={{ color: '#f59e0b' }} className="font-semibold">30+ days</span> are usually proven winners the brand keeps spending on because they work.</p></>),
  tier: (<><p className="text-xs font-bold text-white mb-1">Creative Tier</p><p className="text-[11px] leading-relaxed" style={{ color: '#9ca3af' }}>Rank percentile classification. <span className="text-rose-400 font-semibold">🔥 BANGER</span> = top 3% under 10 days · <span className="text-amber-400 font-semibold">🏆 CHAMP</span> = top 10% · <span className="text-emerald-400 font-semibold">A</span> = top 25% · <span className="text-sky-400 font-semibold">B</span> = top 50%.</p></>),
  rank21d: (<><p className="text-xs font-bold text-white mb-1">21-Day Rank</p><p className="text-[11px] leading-relaxed" style={{ color: '#9ca3af' }}>Rank 21 days ago. Delta shows improvement <span className="text-emerald-400 font-semibold">(+N)</span> or drop <span className="text-rose-400 font-semibold">(-N)</span> vs today.</p></>),
  rank7d: (<><p className="text-xs font-bold text-white mb-1">7-Day Rank</p><p className="text-[11px] leading-relaxed" style={{ color: '#9ca3af' }}>Rank 7 days ago. Delta shows short-term momentum vs current rank.</p></>),
  rank3d: (<><p className="text-xs font-bold text-white mb-1">3-Day Rank</p><p className="text-[11px] leading-relaxed" style={{ color: '#9ca3af' }}>Rank 3 days ago. Closest window — shows very recent acceleration or stalling.</p></>),
  v7d: (<><p className="text-xs font-bold text-white mb-1">Velocity 7D</p><p className="text-[11px] leading-relaxed" style={{ color: '#9ca3af' }}>Rank change over 7 days. <span className="text-emerald-400 font-semibold">+N↑</span> = climbing · <span className="text-rose-400 font-semibold">-N↓</span> = falling.</p></>),
  v21d: (<><p className="text-xs font-bold text-white mb-1">Velocity 21D</p><p className="text-[11px] leading-relaxed" style={{ color: '#9ca3af' }}>Rank change over 21 days. Combined with 7D to calculate <span className="text-white font-medium">Momentum</span> in the ad detail view.</p></>),
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
    if (days != null && days < win)
      return <span className="text-sky-400 font-semibold text-[11px]">NEW</span>;
    return <span className="text-text-faint text-xs">—</span>;
  }
  if (value > 0) return <span className="text-emerald-400 text-xs font-medium">+{value}↑</span>;
  if (value < 0) return <span className="text-rose-400 text-xs font-medium">{value}↓</span>;
  return <span className="text-text-faint text-xs">=</span>;
}

function BrandLogo({ domain }) {
  const [src, setSrc] = useState(`https://logo.clearbit.com/${domain}`);
  const [failed, setFailed] = useState(false);
  if (failed) return (
    <div className="w-full h-full flex items-center justify-center text-sm font-bold text-text-muted">
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
        style={{ width: size, height: size }}
        onError={() => setFailed(true)}
      />
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
  const ref = useRef(null);
  useEffect(() => {
    if (!open) return;
    const handler = (e) => { if (ref.current && !ref.current.contains(e.target)) setOpen(false); };
    document.addEventListener('mousedown', handler);
    return () => document.removeEventListener('mousedown', handler);
  }, [open]);
  return { open, setOpen, ref };
}

// ---------------------------------------------------------------------------
// Main component
// ---------------------------------------------------------------------------

export default function BrandDetail({ apiBaseUrl, brandId, onBack }) {
  const [brand, setBrand]             = useState(null);
  const [brandError, setBrandError]   = useState(null);
  const [ads, setAds]                 = useState([]);
  const [total, setTotal]             = useState(0);
  const [adsLoading, setAdsLoading]   = useState(true);
  const [adsError, setAdsError]       = useState(null);
  const [refreshing, setRefreshing]   = useState(false);
  const [refreshError, setRefreshError] = useState(null);

  const [page, setPage]               = useState(1);
  const [sort, setSort]               = useState('rank_asc');
  const [tierFilter, setTierFilter]   = useState('ALL');
  const [pageFilter, setPageFilter]   = useState(null); // brand_page_id UUID or null
  const [selectedAd, setSelectedAd] = useState(null);
  const [visibleCols, setVisibleCols] = useState(() => {
    const init = {};
    ALL_COLUMNS.forEach((c) => { init[c.key] = true; });
    return init;
  });

  const pagesDropdown   = useDropdown();
  const columnsDropdown = useDropdown();

  // Load brand (includes pages via getBrandExpanded)
  useEffect(() => {
    setBrandError(null);
    fetch(`${apiBaseUrl}/brands/${brandId}`)
      .then((r) => { if (!r.ok) throw new Error(`Brand not found (${r.status})`); return r.json(); })
      .then((d) => { if (!d.brand) throw new Error('Brand not found'); setBrand(d.brand); })
      .catch((e) => setBrandError(e.message));
  }, [apiBaseUrl, brandId]);

  // Load ads
  const loadAds = useCallback(async () => {
    setAdsLoading(true);
    setAdsError(null);
    try {
      const params = new URLSearchParams({ page: String(page), pageSize: String(PAGE_SIZE), sort, tier: tierFilter });
      if (pageFilter) params.set('brandPageId', pageFilter);
      const res = await fetch(`${apiBaseUrl}/brands/${brandId}/ads?${params}`);
      if (!res.ok) throw new Error(`Failed (${res.status})`);
      const data = await res.json();
      setAds(data.ads ?? []);
      setTotal(data.total ?? 0);
    } catch (e) { setAdsError(e.message); }
    finally { setAdsLoading(false); }
  }, [apiBaseUrl, brandId, page, sort, tierFilter, pageFilter]);

  useEffect(() => { loadAds(); }, [loadAds]);
  useEffect(() => { setPage(1); }, [tierFilter, pageFilter, sort]);

  const handleRefresh = async () => {
    if (refreshing) return;
    setRefreshing(true);
    setRefreshError(null);
    try {
      await fetch(`${apiBaseUrl}/brands/${brandId}/scrape`, { method: 'POST' });
      const r = await fetch(`${apiBaseUrl}/brands/${brandId}`);
      if (r.ok) {
        const d = await r.json();
        if (d.brand) setBrand(d.brand);
      }
      await loadAds();
    } catch (e) { setRefreshError(e.message); }
    finally { setRefreshing(false); }
  };

  const totalPages = Math.ceil(total / PAGE_SIZE);
  const toggleCol = (key) => setVisibleCols((prev) => ({ ...prev, [key]: !prev[key] }));

  const selectedPageObj = brand?.pages?.find((p) => p.id === pageFilter) ?? null;
  const col = (key) => visibleCols[key];
  const t = brand?.tierBreakdown ?? {};

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
      {/* ---- scrollable upper area (header + toolbar + table) ---- */}
      <div className="flex-1 overflow-y-auto flex flex-col min-h-0">

        {/* Header */}
        <div className="px-5 pt-4 pb-3 space-y-4 shrink-0">
          {/* Breadcrumb */}
          <button onClick={onBack} className="flex items-center gap-1.5 text-sm text-text-muted hover:text-text-primary transition-colors">
            <ArrowLeft className="w-4 h-4" /> Brand Spy
          </button>

          {refreshError && (
            <div className="text-xs text-red-400 bg-red-400/10 border border-red-400/20 rounded-lg px-3 py-2">{refreshError}</div>
          )}

          {!brand ? (
            <div className="text-text-faint text-sm">Loading...</div>
          ) : (
            <>
              {/* Brand header row */}
              <div className="flex items-start justify-between gap-4">
                <div className="flex items-center gap-3">
                  <div className="relative w-11 h-11 rounded-xl bg-bg-elevated border border-border-default overflow-hidden shrink-0">
                    <BrandLogo domain={brand.domain} />
                    <span className={`absolute -top-0.5 -right-0.5 w-2.5 h-2.5 rounded-full ring-2 ring-bg-card ${
                      brand.status === 'ACTIVE' ? 'bg-emerald-400' : brand.status === 'NOISY' ? 'bg-amber-400' : 'bg-zinc-600'
                    }`} />
                  </div>
                  <div>
                    <div className="flex items-center gap-2">
                      <h1 className="text-xl font-semibold text-white">{brand.domain}</h1>
                      <a href={`https://${brand.domain}`} target="_blank" rel="noreferrer" className="text-text-faint hover:text-text-muted">
                        <ExternalLink className="w-3.5 h-3.5" />
                      </a>
                      <span className={`text-[10px] px-2 py-0.5 rounded border uppercase tracking-wide ${
                        brand.status === 'ACTIVE' ? 'bg-emerald-500/10 text-emerald-400 border-emerald-500/20' :
                        brand.status === 'NOISY'  ? 'bg-amber-500/10 text-amber-400 border-amber-500/20' :
                        'bg-bg-elevated text-text-faint border-border-default'
                      }`}>{brand.status}</span>
                    </div>
                    <p className="text-xs text-text-faint mt-0.5">
                      {brand.pagesCount} pages · {brand.domainsCount} domains · scraped {relTime(brand.lastScrapedAt)}
                    </p>
                  </div>
                </div>
                <button onClick={handleRefresh} disabled={refreshing}
                  className="flex items-center gap-1.5 px-3 py-1.5 text-sm rounded-lg bg-bg-elevated border border-border-default hover:bg-bg-hover disabled:opacity-40 text-text-primary transition-colors shrink-0">
                  <RefreshCw className={`w-3.5 h-3.5 ${refreshing ? 'animate-spin' : ''}`} />
                  Refresh
                </button>
              </div>

              {/* Metric cards */}
              <div className="grid grid-cols-3 gap-3">
                {[
                  { label: 'ACTIVE ADS', value: fmtCount(brand.activeAdsCount), accent: true },
                  { label: 'PAGES', value: String(brand.pagesCount) },
                  { label: 'DOMAINS', value: String(brand.domainsCount) },
                ].map(({ label, value, accent }) => (
                  <div key={label} className="bg-bg-card border border-border-subtle rounded-xl p-4">
                    <p className="text-[10px] uppercase tracking-wider text-text-faint">{label}</p>
                    <p className={`text-2xl font-semibold mt-1 ${accent ? 'text-emerald-400' : 'text-white'}`}>{value}</p>
                  </div>
                ))}
              </div>

              {/* Tier strip */}
              <div className="flex items-center gap-2 flex-wrap">
                <span className="text-[10px] uppercase tracking-wider text-text-faint">Tiers</span>
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

        {/* Sticky toolbar */}
        <div className="sticky top-0 z-20 shrink-0 bg-bg-card border-b border-t border-border-subtle px-4 py-2 flex items-center gap-2 flex-wrap">

          {/* Pages dropdown */}
          <div className="relative" ref={pagesDropdown.ref}>
            <button
              onClick={() => pagesDropdown.setOpen((o) => !o)}
              className="flex items-center gap-1.5 px-3 py-1.5 rounded-lg bg-bg-elevated border border-border-default hover:bg-bg-hover text-xs transition-colors"
            >
              <span className="text-text-muted">{selectedPageObj ? selectedPageObj.pageName : 'All Pages'}</span>
              {pageFilter && (
                <span onClick={(e) => { e.stopPropagation(); setPageFilter(null); }}
                  className="ml-1 text-text-faint hover:text-text-primary cursor-pointer">×</span>
              )}
              <ChevronDown className="w-3 h-3 text-text-faint" />
            </button>

            {pagesDropdown.open && (
              <div className="absolute top-full left-0 mt-1 rounded-xl shadow-2xl z-50 p-3"
                style={{ width: 580, background: '#1c1c1e', border: '1px solid #2a2a2a' }}>
                <div className="grid grid-cols-3 gap-1.5 max-h-80 overflow-y-auto">
                  <button
                    onClick={() => { setPageFilter(null); pagesDropdown.setOpen(false); setPage(1); }}
                    className={`flex items-center gap-2 p-2.5 rounded-lg border text-left transition-all ${
                      !pageFilter ? 'bg-white/5 border-white/10' : 'border-transparent hover:bg-white/5 hover:border-white/10'
                    }`}
                  >
                    <div className="w-9 h-9 rounded-full bg-bg-elevated border border-border-default flex items-center justify-center shrink-0">
                      <ScanSearch className="w-4 h-4 text-text-faint" />
                    </div>
                    <div className="min-w-0 flex-1">
                      <p className="text-xs font-medium text-text-primary">All Pages</p>
                      <div className="flex items-center gap-1 mt-0.5">
                        <span className="w-1.5 h-1.5 rounded-full bg-emerald-400 shrink-0" />
                        <span className="text-[11px] text-text-faint">{brand?.activeAdsCount} active</span>
                      </div>
                    </div>
                  </button>
                  {(brand?.pages ?? []).map((pg) => (
                    <button key={pg.id}
                      onClick={() => { setPageFilter(pg.id); pagesDropdown.setOpen(false); setPage(1); }}
                      className={`group flex items-center gap-2 p-2.5 rounded-lg border text-left transition-all ${
                        pageFilter === pg.id ? 'bg-white/5 border-white/10' : 'border-transparent hover:bg-white/5 hover:border-white/10'
                      }`}
                    >
                      <PageAvatar page={pg} size={36} />
                      <div className="min-w-0 flex-1">
                        <div className="flex items-center justify-between gap-1">
                          <p className="text-xs font-medium text-text-primary truncate">{pg.pageName}</p>
                          <a href={`https://www.facebook.com/ads/library/?active_status=all&ad_type=all&country=US&media_type=all&search_type=page&view_all_page_id=${pg.metaPageId ?? ''}`} target="_blank" rel="noreferrer"
                            onClick={(e) => e.stopPropagation()}
                            className="opacity-40 hover:opacity-100 transition-opacity shrink-0">
                            <ExternalLink className="w-3 h-3 text-text-faint" />
                          </a>
                        </div>
                        <div className="flex items-center gap-1 mt-0.5">
                          <span className="w-1.5 h-1.5 rounded-full bg-emerald-400 shrink-0" />
                          <span className="text-[11px] text-text-faint">{pg.activeAdsCount} active</span>
                        </div>
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
                  tierFilter === f
                    ? 'bg-accent text-white border-accent'
                    : 'bg-bg-elevated text-text-muted border-border-default hover:text-text-primary'
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
          <div className="relative" ref={columnsDropdown.ref}>
            <button onClick={() => columnsDropdown.setOpen((o) => !o)}
              className="flex items-center gap-1 px-2.5 py-1.5 rounded-lg bg-bg-elevated border border-border-default hover:bg-bg-hover text-text-primary text-xs transition-colors">
              <Settings2 className="w-3.5 h-3.5" />
            </button>
            {columnsDropdown.open && (
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
        <div className="flex-1">
          {adsLoading ? (
            <div className="flex items-center justify-center py-20 text-text-faint text-sm">Loading ads...</div>
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
                  {col('num')     && <th style={{ width: 42 }} className="px-2 py-2.5 text-right text-[10px] uppercase tracking-wider text-text-faint font-normal">#</th>}
                  {col('ad')      && <th style={{ width: 280 }} className="px-3 py-2.5 text-left text-[10px] uppercase tracking-wider text-text-faint font-normal">AD</th>}
                  {col('page')    && <th style={{ width: 150 }} className="px-3 py-2.5 text-left text-[10px] uppercase tracking-wider text-text-faint font-normal">PAGE</th>}
                  {col('launch')  && <th style={{ width: 80 }} className="px-2 py-2.5 text-center text-[10px] uppercase tracking-wider text-text-faint font-normal">LAUNCH</th>}
                  {col('status')  && <th style={{ width: 60 }} className="px-2 py-2.5 text-center text-[10px] uppercase tracking-wider text-text-faint font-normal">STATUS</th>}
                  {col('format')  && <th style={{ width: 70 }} className="px-2 py-2.5 text-center text-[10px] uppercase tracking-wider text-text-faint font-normal">FORMAT</th>}
                  {col('rank21d') && <th style={{ width: 75 }} className="px-2 py-2.5 text-center text-[10px] uppercase tracking-wider text-text-faint font-normal"><span className="inline-flex items-center gap-0.5">21D<ColInfo>{COL_TOOLTIPS.rank21d}</ColInfo></span></th>}
                  {col('rank7d')  && <th style={{ width: 75 }} className="px-2 py-2.5 text-center text-[10px] uppercase tracking-wider text-text-faint font-normal"><span className="inline-flex items-center gap-0.5">7D<ColInfo>{COL_TOOLTIPS.rank7d}</ColInfo></span></th>}
                  {col('rank3d')  && <th style={{ width: 75 }} className="px-2 py-2.5 text-center text-[10px] uppercase tracking-wider text-text-faint font-normal"><span className="inline-flex items-center gap-0.5">3D<ColInfo>{COL_TOOLTIPS.rank3d}</ColInfo></span></th>}
                  {col('now')     && <th style={{ width: 75 }} className="px-2 py-2.5 text-center text-[10px] uppercase tracking-wider text-text-muted font-semibold bg-bg-hover"><span className="inline-flex items-center gap-0.5">NOW<ColInfo>{COL_TOOLTIPS.now}</ColInfo></span></th>}
                  {col('active')  && <th style={{ width: 60 }} className="px-2 py-2.5 text-center text-[10px] uppercase tracking-wider text-text-faint font-normal"><span className="inline-flex items-center gap-0.5">ACTIVE<ColInfo>{COL_TOOLTIPS.active}</ColInfo></span></th>}
                  {col('tier')    && <th style={{ width: 90 }} className="px-2 py-2.5 text-center text-[10px] uppercase tracking-wider text-text-faint font-normal"><span className="inline-flex items-center gap-0.5">TIER<ColInfo>{COL_TOOLTIPS.tier}</ColInfo></span></th>}
                  {col('v7d')     && <th style={{ width: 60 }} className="px-2 py-2.5 text-center text-[10px] uppercase tracking-wider text-text-faint font-normal"><span className="inline-flex items-center gap-0.5">V7D<ColInfo>{COL_TOOLTIPS.v7d}</ColInfo></span></th>}
                  {col('v21d')    && <th style={{ width: 60 }} className="px-2 py-2.5 text-center text-[10px] uppercase tracking-wider text-text-faint font-normal"><span className="inline-flex items-center gap-0.5">V21D<ColInfo>{COL_TOOLTIPS.v21d}</ColInfo></span></th>}
                </tr>
              </thead>
              <tbody>
                {ads.map((ad, i) => (
                  <DetailAdRow
                    key={ad.id}
                    ad={ad}
                    rowNum={(page - 1) * PAGE_SIZE + i + 1}
                    onSelect={() => setSelectedAd(ad)}
                    col={col}
                  />
                ))}
              </tbody>
            </table>
          )}
        </div>
      </div>

      {/* Bottom bar */}
      <div className="shrink-0 border-t border-border-subtle bg-bg-card px-4 py-2 flex items-center justify-between gap-3">
        <span className="text-[11px] text-text-faint">{total.toLocaleString()} ads · page {page} of {Math.max(1, totalPages)}</span>
        <div className="flex items-center gap-2">
          <button onClick={() => setPage((p) => Math.max(1, p - 1))} disabled={page === 1}
            className="px-3 py-1 text-xs rounded-lg bg-bg-elevated border border-border-default disabled:opacity-40 hover:bg-bg-hover text-text-primary transition-colors">
            ← Prev
          </button>
          <button onClick={() => setPage((p) => Math.min(totalPages, p + 1))} disabled={page >= totalPages}
            className="px-3 py-1 text-xs rounded-lg bg-bg-elevated border border-border-default disabled:opacity-40 hover:bg-bg-hover text-text-primary transition-colors">
            Next →
          </button>
        </div>
      </div>
      {selectedAd && (
        <IntelDrawer
          ad={selectedAd}
          brand={brand}
          onClose={() => setSelectedAd(null)}
        />
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Table row
// ---------------------------------------------------------------------------

function DetailAdRow({ ad, rowNum, onSelect, col }) {
  const delta3d = (ad.rank3d != null && ad.currentRank != null) ? ad.rank3d - ad.currentRank : null;

  return (
    <tr
      className="border-b border-border-subtle hover:bg-bg-elevated transition-colors cursor-pointer"
      onClick={onSelect}
    >
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
              <a
                href={`https://www.facebook.com/ads/library/?active_status=all&ad_type=all&country=US&media_type=all&search_type=page&view_all_page_id=${ad.metaPageId}`}
                target="_blank"
                rel="noreferrer"
                onClick={(e) => e.stopPropagation()}
                className="opacity-0 group-hover:opacity-50 hover:!opacity-100 transition-opacity shrink-0"
                title="View on Facebook Ad Library"
              >
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
