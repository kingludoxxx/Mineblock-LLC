import { useEffect, useRef, useState, useCallback } from 'react';
import { useNavigate } from 'react-router-dom';
import {
  ChevronDown,
  RefreshCw,
  Columns3,
  ScanSearch,
  Globe,
  ExternalLink,
  Search,
} from 'lucide-react';

// ---------------------------------------------------------------------------
// Constants
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

const TIER_ICONS = { BANGER: '🔥', CHAMP: '🏆' };

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

const TIER_LABELS = {
  ALL:    'ALL',
  BANGER: '🔥 BANGER',
  CHAMP:  '🏆 CHAMP',
  A:      'A',
  B:      'B',
  C:      'C',
  MID:    'MID',
  TEST:   'TEST',
};

const SORT_OPTIONS = [
  { value: 'rank_asc',         label: 'Top rank' },
  { value: 'impressions_desc', label: 'Top impressions (Meta)' },
  { value: 'velocity_7d_desc', label: 'Climbing fast' },
  { value: 'active_days_desc', label: 'Longest running' },
  { value: 'first_seen_desc',  label: 'Newest' },
];

// All columns with optional toggle support
const ALL_COLUMNS = [
  { key: 'num',       label: '#',       locked: true,  width: 36 },
  { key: 'ad',        label: 'AD',      locked: true,  width: 280 },
  { key: 'page',      label: 'PAGE',    locked: false, width: 150 },
  { key: 'launch',    label: 'LAUNCH',  locked: false, width: 80 },
  { key: 'status',    label: 'STATUS',  locked: false, width: 60 },
  { key: 'format',    label: 'FORMAT',  locked: false, width: 70 },
  { key: 'rank21d',   label: '21D',     locked: false, width: 70 },
  { key: 'rank7d',    label: '7D',      locked: false, width: 70 },
  { key: 'rank3d',    label: '3D',      locked: false, width: 70 },
  { key: 'now',       label: 'NOW',     locked: true,  width: 70 },
  { key: 'active',    label: 'ACTIVE',  locked: false, width: 60 },
  { key: 'tier',      label: 'TIER',    locked: true,  width: 90 },
  { key: 'v7d',       label: 'V7D',     locked: false, width: 60 },
  { key: 'v21d',      label: 'V21D',    locked: false, width: 60 },
];

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function fmtLaunch(iso) {
  if (!iso) return '—';
  const d = new Date(iso);
  const now = new Date();
  const sameYear = d.getFullYear() === now.getFullYear();
  return d.toLocaleDateString('en-US', {
    month: 'short',
    day: 'numeric',
    ...(sameYear ? {} : { year: '2-digit' }),
  });
}

// Live active-days: compute from startDate at render so it never goes stale
// between scrapes. Ended ads use stored activeDays (their duration is fixed).
// totalActiveTime (seconds) used as a floor — handles paused/resumed ads.
function liveActiveDays(ad) {
  const tatDays = ad.totalActiveTime != null ? Math.floor(ad.totalActiveTime / 86400) : null;
  if (ad.startDate && ad.isActive) {
    const fromStart = Math.max(0, Math.floor((Date.now() - new Date(ad.startDate).getTime()) / 86400000));
    return tatDays != null ? Math.max(fromStart, tatDays) : fromStart;
  }
  return tatDays ?? ad.activeDays ?? null;
}

function rankDisplay(rank, poolSize) {
  if (rank == null) return '—';
  if (!poolSize) return String(rank);
  return `${rank}/${poolSize}`;
}

function VelocityCell({ value, days, win }) {
  if (value === null || value === undefined) {
    if (days != null && days < win) {
      return <span className="text-sky-400 font-semibold text-[11px]">NEW</span>;
    }
    return <span className="text-text-faint text-xs">—</span>;
  }
  if (value > 0) return <span className="text-emerald-400 text-xs font-medium">+{value}↑</span>;
  if (value < 0) return <span className="text-rose-400 text-xs font-medium">{value}↓</span>;
  return <span className="text-text-faint text-xs">=</span>;
}

function BrandLogo({ domain }) {
  const [src, setSrc] = useState(`https://logo.clearbit.com/${domain}`);
  const [failed, setFailed] = useState(false);
  if (failed) {
    return (
      <div className="w-6 h-6 rounded bg-bg-elevated border border-border-subtle flex items-center justify-center text-[10px] font-bold text-text-faint shrink-0">
        {domain.charAt(0).toUpperCase()}
      </div>
    );
  }
  return (
    <img
      src={src}
      alt=""
      className="w-6 h-6 rounded object-contain shrink-0"
      onError={() => {
        if (src.includes('clearbit')) {
          setSrc(`https://www.google.com/s2/favicons?domain=${domain}&sz=32`);
        } else {
          setFailed(true);
        }
      }}
    />
  );
}

function PageAvatar({ page, size = 28 }) {
  const [imgFailed, setImgFailed] = useState(false);
  if (page.pageProfilePic && !imgFailed) {
    return (
      <img
        src={page.pageProfilePic}
        alt=""
        className="rounded-full object-cover shrink-0"
        style={{ width: size, height: size }}
        onError={() => setImgFailed(true)}
      />
    );
  }
  // colored letter avatar
  const colors = [
    'bg-violet-500/20 text-violet-400',
    'bg-sky-500/20 text-sky-400',
    'bg-emerald-500/20 text-emerald-400',
    'bg-amber-500/20 text-amber-400',
    'bg-rose-500/20 text-rose-400',
  ];
  const color = colors[(page.pageName?.charCodeAt(0) ?? 0) % colors.length];
  return (
    <div
      className={`rounded-full flex items-center justify-center font-bold shrink-0 ${color}`}
      style={{ width: size, height: size, fontSize: Math.max(9, size * 0.36) }}
    >
      {(page.pageName ?? '?').charAt(0).toUpperCase()}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Dropdown hook — close on outside click
// ---------------------------------------------------------------------------

function useDropdown() {
  const [open, setOpen] = useState(false);
  const ref = useRef(null);

  useEffect(() => {
    if (!open) return;
    function handler(e) {
      if (ref.current && !ref.current.contains(e.target)) {
        setOpen(false);
      }
    }
    document.addEventListener('mousedown', handler);
    return () => document.removeEventListener('mousedown', handler);
  }, [open]);

  return { open, setOpen, ref };
}

// ---------------------------------------------------------------------------
// Column header tooltip
// ---------------------------------------------------------------------------

function ColInfo({ children }) {
  const [show, setShow] = useState(false);
  return (
    <span
      className="relative inline-flex items-center"
      onMouseEnter={() => setShow(true)}
      onMouseLeave={() => setShow(false)}
    >
      <span className="text-[9px] leading-none cursor-default select-none ml-0.5"
        style={{ color: show ? '#9ca3af' : '#4b5563' }}>ⓘ</span>
      {show && (
        <div
          className="absolute bottom-full left-1/2 -translate-x-1/2 mb-2 w-64 rounded-xl p-3.5 shadow-2xl pointer-events-none z-50 text-left normal-case tracking-normal font-normal"
          style={{ background: '#1c1c1e', border: '1px solid #2a2a2a' }}
        >
          {children}
        </div>
      )}
    </span>
  );
}

// Tooltip content definitions
const COL_TOOLTIPS = {
  now: (
    <>
      <p className="text-xs font-bold text-white mb-1">Current Rank</p>
      <p className="text-[11px] leading-relaxed" style={{ color: '#9ca3af' }}>
        Where this ad ranks <span className="text-white font-medium">right now</span> in the active pool.
        Format is <span className="text-white font-medium">rank / pool size</span>. Lower rank = stronger ad.
      </p>
    </>
  ),
  active: (
    <>
      <p className="text-xs font-bold text-white mb-1">Active Days</p>
      <p className="text-[11px] leading-relaxed" style={{ color: '#9ca3af' }}>
        How many days this ad has been running since it launched. Like counting how old the ad is.
        Ads running for{' '}
        <span style={{ color: '#f59e0b' }} className="font-semibold">30+ days</span>
        {' '}are usually proven winners the brand keeps spending on because they work.
      </p>
    </>
  ),
  tier: (
    <>
      <p className="text-xs font-bold text-white mb-1">Creative Tier</p>
      <p className="text-[11px] leading-relaxed" style={{ color: '#9ca3af' }}>
        Strength classification based on rank percentile.{' '}
        <span className="text-rose-400 font-semibold">🔥 BANGER</span> = top 3% under 10 days ·{' '}
        <span className="text-amber-400 font-semibold">🏆 CHAMP</span> = top 10% ·{' '}
        <span className="text-emerald-400 font-semibold">A</span> = top 25% ·{' '}
        <span className="text-sky-400 font-semibold">B</span> = top 50%.
      </p>
    </>
  ),
  rank21d: (
    <>
      <p className="text-xs font-bold text-white mb-1">21-Day Rank</p>
      <p className="text-[11px] leading-relaxed" style={{ color: '#9ca3af' }}>
        Rank 21 days ago. Delta below shows improvement{' '}
        <span className="text-emerald-400 font-semibold">(+N)</span> or drop{' '}
        <span className="text-rose-400 font-semibold">(-N)</span> vs current rank.
      </p>
    </>
  ),
  rank7d: (
    <>
      <p className="text-xs font-bold text-white mb-1">7-Day Rank</p>
      <p className="text-[11px] leading-relaxed" style={{ color: '#9ca3af' }}>
        Where this ad ranked{' '}
        <span className="text-white font-medium">~7 days ago</span>{' '}
        based on the closest refresh snapshot.
        Climbing from 90D → 21D → 7D → NOW signals the brand is scaling up.
      </p>
    </>
  ),
  rank3d: (
    <>
      <p className="text-xs font-bold text-white mb-1">3-Day Rank</p>
      <p className="text-[11px] leading-relaxed" style={{ color: '#9ca3af' }}>
        Rank 3 days ago. Closest window to now — shows very recent acceleration or stalling.
      </p>
    </>
  ),
  v7d: (
    <>
      <p className="text-xs font-bold text-white mb-1">Velocity 7D</p>
      <p className="text-[11px] leading-relaxed" style={{ color: '#9ca3af' }}>
        How much the rank changed over the last 7 days.{' '}
        <span className="text-emerald-400 font-semibold">+N↑</span> = climbing (rank improved) ·{' '}
        <span className="text-rose-400 font-semibold">-N↓</span> = falling.
      </p>
    </>
  ),
  v21d: (
    <>
      <p className="text-xs font-bold text-white mb-1">Velocity 21D</p>
      <p className="text-[11px] leading-relaxed" style={{ color: '#9ca3af' }}>
        How many rank positions this ad moved in the last 21 days.
        Same logic as V7D but over a longer window — better for spotting sustained scaling vs short spikes.
        Shows <span className="text-sky-400 font-semibold">NEW</span> for ads less than 21 days old.
      </p>
    </>
  ),
};

// ---------------------------------------------------------------------------
// SortDropdown — custom "Sort: X ▼" styled dropdown
// ---------------------------------------------------------------------------

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

// ---------------------------------------------------------------------------
// Main component
// ---------------------------------------------------------------------------

export default function BrandLeague({ apiBaseUrl }) {
  // Data state
  const [brands, setBrands] = useState([]);
  const [brandsError, setBrandsError] = useState(null);
  const [brandsLoading, setBrandsLoading] = useState(true);
  const [selectedBrand, setSelectedBrand] = useState(null);
  const [brandDetail, setBrandDetail] = useState(null); // includes pages
  const [ads, setAds] = useState([]);
  const [total, setTotal] = useState(0);
  const [adsLoading, setAdsLoading] = useState(true);
  const [adsError, setAdsError] = useState(null);
  const [refreshing, setRefreshing] = useState(false);
  const [refreshError, setRefreshError] = useState(null);

  // Filters / pagination
  const [page, setPage] = useState(1);
  const [sort, setSort] = useState('rank_asc');
  const [tierFilter, setTierFilter] = useState('ALL');
  const [pageFilter, setPageFilter] = useState(null); // brand_page_id or null

  // Ad-detail navigation — clicking a row routes to the page instead of
  // opening a modal. The brandId on the ad row drives the URL.
  const navigate = useNavigate();
  const openAd = useCallback((ad) => {
    if (!ad?.id || !ad?.brandId) return;
    navigate(`/app/brand-spy/${ad.brandId}/ads/${ad.id}`);
  }, [navigate]);

  // Visible columns
  const [visibleCols, setVisibleCols] = useState(() => {
    const init = {};
    ALL_COLUMNS.forEach((c) => { init[c.key] = true; });
    return init;
  });

  // Dropdowns
  const brandDropdown  = useDropdown();
  const pagesDropdown  = useDropdown();
  const columnsDropdown = useDropdown();

  // Brand-list search (filters the brand selector dropdown)
  const [brandSearch, setBrandSearch] = useState('');
  // Reset search whenever the dropdown closes so it reopens clean
  useEffect(() => {
    if (!brandDropdown.open) setBrandSearch('');
  }, [brandDropdown.open]);
  const filteredBrands = brandSearch.trim()
    ? brands.filter((b) => b.domain.toLowerCase().includes(brandSearch.trim().toLowerCase()))
    : brands;

  // ---------------------------------------------------------------------------
  // Load brands on mount
  // ---------------------------------------------------------------------------
  useEffect(() => {
    setBrandsLoading(true);
    setBrandsError(null);
    fetch(`${apiBaseUrl}/brands`)
      .then((r) => {
        if (!r.ok) throw new Error(`Failed to load brands (${r.status})`);
        return r.json();
      })
      .then((d) => {
        const list = d.brands ?? [];
        setBrands(list);
        if (list.length > 0) setSelectedBrand(list[0]);
      })
      .catch((e) => setBrandsError(e.message))
      .finally(() => setBrandsLoading(false));
  }, [apiBaseUrl]);

  // ---------------------------------------------------------------------------
  // Load brand detail (pages) when brand changes
  // ---------------------------------------------------------------------------
  useEffect(() => {
    if (!selectedBrand) { setBrandDetail(null); return; }
    fetch(`${apiBaseUrl}/brands/${selectedBrand.id}`)
      .then((r) => {
        if (!r.ok) throw new Error(`Failed to load brand (${r.status})`);
        return r.json();
      })
      .then((d) => setBrandDetail(d.brand ?? null))
      .catch((e) => {
        console.warn('[brand-spy] brand detail fetch failed:', e.message);
        setBrandDetail(null);
      });
  }, [apiBaseUrl, selectedBrand]);

  // ---------------------------------------------------------------------------
  // Load ads
  // ---------------------------------------------------------------------------
  const loadAds = useCallback(async () => {
    if (!selectedBrand) return;
    setAdsLoading(true);
    setAdsError(null);
    try {
      const params = new URLSearchParams({
        page: String(page),
        pageSize: String(PAGE_SIZE),
        sort,
        tier: tierFilter,
      });
      if (pageFilter) params.set('brandPageId', pageFilter);
      const res = await fetch(`${apiBaseUrl}/brands/${selectedBrand.id}/ads?${params}`);
      if (!res.ok) throw new Error(`Failed to load ads (${res.status})`);
      const data = await res.json();
      setAds(data.ads ?? []);
      setTotal(data.total ?? 0);
    } catch (e) {
      setAdsError(e.message);
    } finally {
      setAdsLoading(false);
    }
  }, [apiBaseUrl, selectedBrand, page, sort, tierFilter, pageFilter]);

  useEffect(() => { loadAds(); }, [loadAds]);

  // Reset page when filters change
  useEffect(() => { setPage(1); }, [selectedBrand, tierFilter, pageFilter, sort]);

  // ---------------------------------------------------------------------------
  // Actions
  // ---------------------------------------------------------------------------
  function handleSelectBrand(brand) {
    setSelectedBrand(brand);
    setPageFilter(null);
    brandDropdown.setOpen(false);
  }

  function handleSelectPage(pageId) {
    setPageFilter(pageId);
    pagesDropdown.setOpen(false);
  }

  async function handleRefresh() {
    if (!selectedBrand || refreshing) return;
    setRefreshing(true);
    setRefreshError(null);
    try {
      const scrapeRes = await fetch(`${apiBaseUrl}/brands/${selectedBrand.id}/scrape`, { method: 'POST' });
      if (!scrapeRes.ok) {
        const body = await scrapeRes.json().catch(() => ({}));
        throw new Error(body.error || `Scrape trigger failed (${scrapeRes.status})`);
      }

      // Poll every 2s until scrape completes (max 5 min)
      const deadline = Date.now() + 5 * 60 * 1000;
      while (Date.now() < deadline) {
        await new Promise((resolve) => setTimeout(resolve, 2000));
        const r = await fetch(`${apiBaseUrl}/brands/${selectedBrand.id}`);
        if (r.ok) {
          const d = await r.json();
          if (d.brand) {
            setBrandDetail(d.brand);
            // Also update the brands list so the brand selector shows fresh counts
            setBrands((prev) => prev.map((b) => b.id === d.brand.id
              ? { ...b, activeAdsCount: d.brand.activeAdsCount, totalAdsCount: d.brand.totalAdsCount }
              : b,
            ));
            if (d.brand.lastScrapeStatus !== 'RUNNING') break;
          }
        }
      }

      await loadAds();
    } catch (e) {
      setRefreshError(e.message);
    } finally {
      setRefreshing(false);
    }
  }

  const totalPages = Math.ceil(total / PAGE_SIZE);

  // ---------------------------------------------------------------------------
  // Column visibility toggle
  // ---------------------------------------------------------------------------
  function toggleCol(key) {
    setVisibleCols((prev) => ({ ...prev, [key]: !prev[key] }));
  }

  const visibleColDefs = ALL_COLUMNS.filter((c) => visibleCols[c.key]);

  // ---------------------------------------------------------------------------
  // Selected page name for display
  // ---------------------------------------------------------------------------
  const selectedPageObj = brandDetail?.pages?.find((p) => p.id === pageFilter) ?? null;

  // ---------------------------------------------------------------------------
  // Empty / error states
  // ---------------------------------------------------------------------------
  if (brandsLoading) {
    return (
      <div className="flex-1 flex items-center justify-center text-text-faint text-sm">
        Loading brands...
      </div>
    );
  }

  if (brandsError) {
    return (
      <div className="flex-1 flex items-center justify-center text-red-400 text-sm">
        {brandsError}
      </div>
    );
  }

  if (brands.length === 0) {
    return (
      <div className="flex-1 flex flex-col items-center justify-center gap-3 text-text-faint">
        <ScanSearch className="w-10 h-10 opacity-30" />
        <p className="text-sm">No brands followed yet. Go to <strong>Brand Spy</strong> in the sidebar to add one.</p>
      </div>
    );
  }

  // ---------------------------------------------------------------------------
  // Render
  // ---------------------------------------------------------------------------
  return (
    <div className="h-full flex flex-col overflow-hidden">
      {/* ------------------------------------------------------------------ */}
      {/* Toolbar */}
      {/* ------------------------------------------------------------------ */}
      {refreshError && (
        <div className="shrink-0 px-4 py-1.5 text-xs text-red-400 bg-red-400/10 border-b border-red-400/20">
          {refreshError}
        </div>
      )}
      <div className="shrink-0 flex items-center gap-2 px-4 py-2.5 border-b border-border-subtle bg-bg-card flex-wrap">

        {/* Brand selector */}
        <div className="relative" ref={brandDropdown.ref}>
          <button
            onClick={() => brandDropdown.setOpen((o) => !o)}
            className="flex items-center gap-1.5 px-3 py-1.5 rounded-lg bg-bg-elevated border border-border-default hover:bg-bg-hover text-text-primary text-xs font-medium transition-colors"
          >
            {/* Overlapping page avatars from brandDetail, or brand logo fallback */}
            {brandDetail?.pages?.length > 0 ? (
              <div className="flex -space-x-1.5 shrink-0">
                {brandDetail.pages.slice(0, 5).map((pg, i) => (
                  <div
                    key={pg.id}
                    className="relative rounded-full border-2 border-bg-card overflow-hidden shrink-0"
                    style={{ width: 20, height: 20, zIndex: 5 - i }}
                  >
                    <PageAvatar page={pg} size={20} />
                  </div>
                ))}
              </div>
            ) : selectedBrand ? (
              <BrandLogo domain={selectedBrand.domain} />
            ) : null}
            <span className="uppercase tracking-wide">
              {selectedBrand
                ? `${selectedBrand.domain} · ${selectedBrand.pagesCount} pages · ${selectedBrand.activeAdsCount} active`
                : 'Select brand'}
            </span>
            <ChevronDown className="w-3 h-3 text-text-faint" />
          </button>

          {brandDropdown.open && (
            <div className="absolute top-full left-0 mt-1 w-80 bg-bg-card border border-border-default rounded-lg shadow-xl z-50 overflow-hidden">
              {/* Search */}
              <div className="p-2 border-b border-border-subtle">
                <div className="relative">
                  <Search className="absolute left-2.5 top-1/2 -translate-y-1/2 w-3.5 h-3.5 text-text-faint pointer-events-none" />
                  <input
                    type="text"
                    value={brandSearch}
                    onChange={(e) => setBrandSearch(e.target.value)}
                    placeholder={`Search ${brands.length} brand${brands.length === 1 ? '' : 's'}…`}
                    autoFocus
                    className="w-full pl-8 pr-2.5 py-1.5 text-xs rounded-md bg-bg-elevated border border-border-default focus:border-white/20 focus:outline-none text-text-primary placeholder:text-text-faint transition-colors"
                  />
                </div>
              </div>
              <div className="max-h-64 overflow-y-auto">
                {filteredBrands.length === 0 ? (
                  <div className="px-3 py-4 text-xs text-text-faint text-center">
                    No brands match &ldquo;{brandSearch}&rdquo;.
                  </div>
                ) : (
                  filteredBrands.map((b) => (
                    <button
                      key={b.id}
                      onClick={() => handleSelectBrand(b)}
                      className="w-full flex items-center gap-2.5 px-3 py-2 hover:bg-bg-elevated text-left transition-colors"
                    >
                      <BrandLogo domain={b.domain} />
                      <div className="min-w-0 flex-1">
                        <p className="text-sm text-text-primary truncate">{b.domain}</p>
                        <p className="text-[11px] text-text-faint">
                          {b.pagesCount} pages · {b.activeAdsCount} active
                        </p>
                      </div>
                      {selectedBrand?.id === b.id && (
                        <span className="text-accent text-xs">✓</span>
                      )}
                    </button>
                  ))
                )}
              </div>
            </div>
          )}
        </div>

        {/* Pages filter */}
        <div className="relative" ref={pagesDropdown.ref}>
          <button
            onClick={() => pagesDropdown.setOpen((o) => !o)}
            className="flex items-center gap-1.5 px-3 py-1.5 rounded-lg bg-bg-elevated border border-border-default hover:bg-bg-hover text-text-primary text-xs transition-colors"
          >
            <span className="text-text-muted">
              {selectedPageObj ? selectedPageObj.pageName : 'All Pages'}
            </span>
            {pageFilter && (
              <span
                onClick={(e) => { e.stopPropagation(); setPageFilter(null); }}
                className="ml-1 text-text-faint hover:text-text-primary cursor-pointer"
                title="Clear page filter"
              >
                ×
              </span>
            )}
            <ChevronDown className="w-3 h-3 text-text-faint" />
          </button>

          {pagesDropdown.open && (
            <div
              className="absolute top-full left-0 mt-1 rounded-xl shadow-2xl z-50 p-3"
              style={{ width: 580, background: '#1c1c1e', border: '1px solid #2a2a2a' }}
            >
              <div className="grid grid-cols-3 gap-1.5 max-h-80 overflow-y-auto">
                {/* All Pages tile */}
                <button
                  onClick={() => handleSelectPage(null)}
                  className={`flex items-center gap-2 p-2.5 rounded-lg border text-left transition-all ${
                    !pageFilter
                      ? 'bg-white/5 border-white/10'
                      : 'border-transparent hover:bg-white/5 hover:border-white/10'
                  }`}
                >
                  <div className="w-9 h-9 rounded-full bg-bg-elevated border border-border-default flex items-center justify-center shrink-0">
                    <ScanSearch className="w-4 h-4 text-text-faint" />
                  </div>
                  <div className="min-w-0 flex-1">
                    <p className="text-xs font-medium text-text-primary">All Pages</p>
                    <div className="flex items-center gap-1 mt-0.5">
                      <span className="w-1.5 h-1.5 rounded-full bg-emerald-400 shrink-0" />
                      <span className="text-[11px] text-text-faint">{selectedBrand?.activeAdsCount} active</span>
                    </div>
                  </div>
                </button>

                {(brandDetail?.pages ?? []).map((pg) => (
                  <button
                    key={pg.id}
                    onClick={() => handleSelectPage(pg.id)}
                    className={`group flex items-center gap-2 p-2.5 rounded-lg border text-left transition-all ${
                      pageFilter === pg.id
                        ? 'bg-white/5 border-white/10'
                        : 'border-transparent hover:bg-white/5 hover:border-white/10'
                    }`}
                  >
                    <PageAvatar page={pg} size={36} />
                    <div className="min-w-0 flex-1">
                      <div className="flex items-center justify-between gap-1">
                        <p className="text-xs font-medium text-text-primary truncate">{pg.pageName}</p>
                        <a
                          href={`https://www.facebook.com/ads/library/?active_status=all&ad_type=all&country=US&media_type=all&search_type=page&view_all_page_id=${pg.metaPageId ?? ''}`}
                          target="_blank"
                          rel="noreferrer"
                          onClick={(e) => e.stopPropagation()}
                          className="opacity-40 hover:opacity-100 transition-opacity shrink-0"
                        >
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

        {/* Tier filter pills */}
        <div className="flex items-center gap-1 flex-wrap">
          {TIER_FILTERS.map((f) => (
            <button
              key={f}
              onClick={() => setTierFilter(f)}
              className={`px-2 py-0.5 text-[11px] rounded border font-medium transition-colors ${
                tierFilter === f
                  ? 'bg-accent text-white border-accent'
                  : 'bg-bg-elevated text-text-muted border-border-default hover:text-text-primary'
              }`}
            >
              {TIER_LABELS[f]}
            </button>
          ))}
        </div>

        <div className="flex-1" />

        {/* Sort */}
        <SortDropdown value={sort} onChange={setSort} options={SORT_OPTIONS} />

        {/* Refresh */}
        <button
          onClick={handleRefresh}
          disabled={refreshing}
          title="Refresh ads"
          className="flex items-center gap-1 px-2.5 py-1.5 rounded-lg bg-bg-elevated border border-border-default hover:bg-bg-hover disabled:opacity-40 text-text-primary text-xs transition-colors"
        >
          <RefreshCw className={`w-3.5 h-3.5 ${refreshing ? 'animate-spin' : ''}`} />
        </button>

        {/* Columns toggle */}
        <div className="relative" ref={columnsDropdown.ref}>
          <button
            onClick={() => columnsDropdown.setOpen((o) => !o)}
            title="Toggle columns"
            className="flex items-center gap-1 px-2.5 py-1.5 rounded-lg bg-bg-elevated border border-border-default hover:bg-bg-hover text-text-primary text-xs transition-colors"
          >
            <Columns3 className="w-3.5 h-3.5" />
          </button>

          {columnsDropdown.open && (
            <div className="absolute top-full right-0 mt-1 w-44 bg-bg-card border border-border-default rounded-lg shadow-xl z-50 p-2 space-y-0.5">
              {ALL_COLUMNS.filter((c) => c.key !== 'num').map((c) => (
                <label
                  key={c.key}
                  className={`flex items-center gap-2 px-2 py-1 rounded text-xs cursor-pointer hover:bg-bg-elevated transition-colors ${
                    c.locked ? 'opacity-50 cursor-not-allowed' : ''
                  }`}
                >
                  <input
                    type="checkbox"
                    checked={visibleCols[c.key]}
                    disabled={c.locked}
                    onChange={() => !c.locked && toggleCol(c.key)}
                    className="accent-accent"
                  />
                  <span className="text-text-muted">{c.label || c.key.toUpperCase()}</span>
                </label>
              ))}
            </div>
          )}
        </div>
      </div>

      {/* ------------------------------------------------------------------ */}
      {/* Table area */}
      {/* ------------------------------------------------------------------ */}
      <div className="flex-1 overflow-auto">
        {adsLoading ? (
          <div className="flex items-center justify-center py-20 text-text-faint text-sm">
            Loading ads...
          </div>
        ) : adsError ? (
          <div className="flex items-center justify-center py-20 text-red-400 text-sm">
            {adsError}
          </div>
        ) : ads.length === 0 ? (
          <div className="flex items-center justify-center py-20 text-text-faint text-sm">
            No ads found — click Refresh.
          </div>
        ) : (
          <table className="min-w-[1300px] w-full border-collapse">
            <thead className="sticky top-0 z-10 bg-bg-elevated">
              <tr>
                {/* # */}
                {visibleCols.num && (
                  <th style={{ width: 36 }} className="px-2 py-2 text-right text-[10px] uppercase tracking-wider text-text-faint font-normal">
                    #
                  </th>
                )}
                {/* AD */}
                {visibleCols.ad && (
                  <th style={{ width: 280 }} className="px-3 py-2 text-left text-[10px] uppercase tracking-wider text-text-faint font-normal">
                    AD
                  </th>
                )}
                {/* PAGE */}
                {visibleCols.page && (
                  <th style={{ width: 150 }} className="px-3 py-2 text-left text-[10px] uppercase tracking-wider text-text-faint font-normal">
                    PAGE
                  </th>
                )}
                {/* LAUNCH */}
                {visibleCols.launch && (
                  <th style={{ width: 80 }} className="px-2 py-2 text-center text-[10px] uppercase tracking-wider text-text-faint font-normal">
                    LAUNCH
                  </th>
                )}
                {/* STATUS */}
                {visibleCols.status && (
                  <th style={{ width: 60 }} className="px-2 py-2 text-center text-[10px] uppercase tracking-wider text-text-faint font-normal">
                    STATUS
                  </th>
                )}
                {/* FORMAT */}
                {visibleCols.format && (
                  <th style={{ width: 70 }} className="px-2 py-2 text-center text-[10px] uppercase tracking-wider text-text-faint font-normal">
                    FORMAT
                  </th>
                )}
                {/* 21D */}
                {visibleCols.rank21d && (
                  <th style={{ width: 70 }} className="px-2 py-2 text-center text-[10px] uppercase tracking-wider text-text-faint font-normal">
                    <span className="inline-flex items-center gap-0.5">21D<ColInfo>{COL_TOOLTIPS.rank21d}</ColInfo></span>
                  </th>
                )}
                {/* 7D */}
                {visibleCols.rank7d && (
                  <th style={{ width: 70 }} className="px-2 py-2 text-center text-[10px] uppercase tracking-wider text-text-faint font-normal">
                    <span className="inline-flex items-center gap-0.5">7D<ColInfo>{COL_TOOLTIPS.rank7d}</ColInfo></span>
                  </th>
                )}
                {/* 3D */}
                {visibleCols.rank3d && (
                  <th style={{ width: 70 }} className="px-2 py-2 text-center text-[10px] uppercase tracking-wider text-text-faint font-normal">
                    <span className="inline-flex items-center gap-0.5">3D<ColInfo>{COL_TOOLTIPS.rank3d}</ColInfo></span>
                  </th>
                )}
                {/* NOW — locked, highlighted */}
                {visibleCols.now && (
                  <th style={{ width: 70 }} className="px-2 py-2 text-center text-[10px] uppercase tracking-wider text-text-muted font-semibold bg-bg-hover">
                    <span className="inline-flex items-center gap-0.5">NOW<ColInfo>{COL_TOOLTIPS.now}</ColInfo></span>
                  </th>
                )}
                {/* ACTIVE */}
                {visibleCols.active && (
                  <th style={{ width: 60 }} className="px-2 py-2 text-center text-[10px] uppercase tracking-wider text-text-faint font-normal">
                    <span className="inline-flex items-center gap-0.5">ACTIVE<ColInfo>{COL_TOOLTIPS.active}</ColInfo></span>
                  </th>
                )}
                {/* TIER — locked */}
                {visibleCols.tier && (
                  <th style={{ width: 90 }} className="px-2 py-2 text-center text-[10px] uppercase tracking-wider text-text-faint font-normal">
                    <span className="inline-flex items-center gap-0.5">TIER<ColInfo>{COL_TOOLTIPS.tier}</ColInfo></span>
                  </th>
                )}
                {/* V7D */}
                {visibleCols.v7d && (
                  <th style={{ width: 60 }} className="px-2 py-2 text-center text-[10px] uppercase tracking-wider text-text-faint font-normal">
                    <span className="inline-flex items-center gap-0.5">V7D<ColInfo>{COL_TOOLTIPS.v7d}</ColInfo></span>
                  </th>
                )}
                {/* V21D */}
                {visibleCols.v21d && (
                  <th style={{ width: 60 }} className="px-2 py-2 text-center text-[10px] uppercase tracking-wider text-text-faint font-normal">
                    <span className="inline-flex items-center gap-0.5">V21D<ColInfo>{COL_TOOLTIPS.v21d}</ColInfo></span>
                  </th>
                )}
              </tr>
            </thead>
            <tbody>
              {ads.map((ad, i) => (
                <AdTableRow
                  key={ad.id}
                  ad={ad}
                  rowNum={(page - 1) * PAGE_SIZE + i + 1}
                  onSelect={() => openAd(ad)}
                  visibleCols={visibleCols}
                />
              ))}
            </tbody>
          </table>
        )}
      </div>

      {/* ------------------------------------------------------------------ */}
      {/* Bottom bar: bulk actions or pagination */}
      {/* ------------------------------------------------------------------ */}
      <div className="shrink-0 border-t border-border-subtle bg-bg-card px-4 py-2 flex items-center justify-between gap-3">
        <span className="text-[11px] text-text-faint">
          {total.toLocaleString()} ads · page {page} of {Math.max(1, totalPages)}
        </span>
        <div className="flex items-center gap-2">
          <button
            onClick={() => setPage((p) => Math.max(1, p - 1))}
            disabled={page === 1}
            className="px-3 py-1 text-xs rounded-lg bg-bg-elevated border border-border-default disabled:opacity-40 hover:bg-bg-hover text-text-primary transition-colors"
          >
            ← Prev
          </button>
          <button
            onClick={() => setPage((p) => Math.min(totalPages, p + 1))}
            disabled={page >= totalPages}
            className="px-3 py-1 text-xs rounded-lg bg-bg-elevated border border-border-default disabled:opacity-40 hover:bg-bg-hover text-text-primary transition-colors"
          >
            Next →
          </button>
        </div>
      </div>

      {/* Ad detail lives at /app/brand-spy/:brandId/ads/:adId now —
          BrandSpyAdDetailPage. The modal mount was removed; row clicks
          call openAd(ad) which routes to the page. */}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Table row
// ---------------------------------------------------------------------------

function AdTableRow({ ad, rowNum, onSelect, visibleCols }) {
  const delta3d = (ad.rank3d != null && ad.currentRank != null) ? ad.rank3d - ad.currentRank : null;
  return (
    <tr
      className="border-b border-border-subtle hover:bg-bg-elevated transition-colors cursor-pointer"
      onClick={onSelect}
    >
      {/* # */}
      {visibleCols.num && (
        <td className="px-2 py-2 text-right text-[11px] text-text-faint tabular-nums w-9">
          #{rowNum}
        </td>
      )}

      {/* AD */}
      {visibleCols.ad && (
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
              {ad.pageName && (
                <p className="text-[11px] text-text-faint truncate mt-0.5">{ad.pageName}</p>
              )}
            </div>
          </div>
        </td>
      )}

      {/* PAGE */}
      {visibleCols.page && (
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

      {/* LAUNCH */}
      {visibleCols.launch && (
        <td className="px-2 py-2 text-center" style={{ width: 80 }}>
          <span className="text-xs text-text-faint tabular-nums">{fmtLaunch(ad.startDate)}</span>
        </td>
      )}

      {/* STATUS */}
      {visibleCols.status && (
        <td className="px-2 py-2 text-center" style={{ width: 60 }}>
          <div className="flex items-center justify-center gap-1">
            <span className={`w-1.5 h-1.5 rounded-full ${ad.isActive ? 'bg-emerald-400' : 'bg-zinc-600'}`} />
            <span className={`text-[11px] ${ad.isActive ? 'text-emerald-400' : 'text-text-faint'}`}>
              {ad.isActive ? 'LIVE' : 'OFF'}
            </span>
          </div>
        </td>
      )}

      {/* FORMAT */}
      {visibleCols.format && (
        <td className="px-2 py-2 text-center" style={{ width: 70 }}>
          {ad.displayFormat
            ? <span className="text-[10px] px-1.5 py-0.5 rounded bg-bg-elevated text-text-faint uppercase border border-border-subtle">{ad.displayFormat}</span>
            : <span className="text-text-faint text-xs">—</span>}
        </td>
      )}

      {/* 21D */}
      {visibleCols.rank21d && (
        <td className="px-2 py-2 text-center" style={{ width: 70 }}>
          <RankWithDelta rank={ad.rank21d} poolSize={ad.poolSize} delta={ad.velocity21d} />
        </td>
      )}

      {/* 7D */}
      {visibleCols.rank7d && (
        <td className="px-2 py-2 text-center" style={{ width: 70 }}>
          <RankWithDelta rank={ad.rank7d} poolSize={ad.poolSize} delta={ad.velocity7d} />
        </td>
      )}

      {/* 3D */}
      {visibleCols.rank3d && (
        <td className="px-2 py-2 text-center" style={{ width: 70 }}>
          <RankWithDelta rank={ad.rank3d} poolSize={ad.poolSize} delta={delta3d} />
        </td>
      )}

      {/* NOW — highlighted */}
      {visibleCols.now && (
        <td className="px-2 py-2 text-center bg-bg-hover/40" style={{ width: 70 }}>
          <span className="text-xs font-semibold font-mono text-white tabular-nums">
            {ad.currentRank != null
              ? (ad.poolSize ? `${ad.currentRank}/${ad.poolSize}` : String(ad.currentRank))
              : '—'}
          </span>
        </td>
      )}

      {/* ACTIVE */}
      {visibleCols.active && (
        <td className="px-2 py-2 text-center" style={{ width: 60 }}>
          {(() => { const d = liveActiveDays(ad); return d != null
            ? <span className={`text-xs tabular-nums ${d >= 30 ? 'text-emerald-400 font-semibold' : 'text-text-primary'}`}>{d}d</span>
            : <span className="text-text-faint text-xs">—</span>; })()}
        </td>
      )}

      {/* TIER */}
      {visibleCols.tier && (
        <td className="px-2 py-2 text-center" style={{ width: 96 }}>
          {ad.tier
            ? (
              // inline-flex + whitespace-nowrap so the emoji + label stay on
              // one line. With a plain inline-span the border would draw
              // around each wrapped fragment, producing two stacked pills.
              <span
                className={`inline-flex items-center gap-1 whitespace-nowrap text-[10px] px-1.5 py-0.5 rounded border font-medium ${TIER_COLORS[ad.tier] ?? ''}`}
                title={TIER_TOOLTIPS[ad.tier] ?? ad.tier}
              >
                {TIER_ICONS[ad.tier] && <span aria-hidden>{TIER_ICONS[ad.tier]}</span>}
                {ad.tier}
              </span>
            )
            : <span className="text-text-faint text-xs">—</span>}
        </td>
      )}

      {/* V7D */}
      {visibleCols.v7d && (
        <td className="px-2 py-2 text-center" style={{ width: 60 }}>
          <VelocityCell value={ad.velocity7d} days={liveActiveDays(ad)} win={7} />
        </td>
      )}

      {/* V21D */}
      {visibleCols.v21d && (
        <td className="px-2 py-2 text-center" style={{ width: 60 }}>
          <VelocityCell value={ad.velocity21d} days={liveActiveDays(ad)} win={21} />
        </td>
      )}
    </tr>
  );
}
