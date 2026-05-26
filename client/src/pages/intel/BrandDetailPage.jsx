import { useEffect, useState, useCallback } from 'react';
import { useParams, useNavigate } from 'react-router-dom';

const API = '/api/v1/brand-spy';

export default function BrandDetailPage() {
  const { id: brandId } = useParams();
  const navigate = useNavigate();

  const [brand, setBrand] = useState(null);
  const [ads, setAds] = useState([]);
  const [total, setTotal] = useState(0);
  const [page, setPage] = useState(1);
  const pageSize = 24;
  const [sort, setSort] = useState('rank_asc');
  const [tierFilter, setTierFilter] = useState('ALL');
  const [loading, setLoading] = useState(true);
  const [selectedAd, setSelectedAd] = useState(null);
  const [refreshing, setRefreshing] = useState(false);

  useEffect(() => {
    fetch(`${API}/brands/${brandId}`)
      .then((r) => r.json())
      .then((d) => setBrand(d.brand))
      .catch(console.error);
  }, [brandId]);

  const loadAds = useCallback(async () => {
    setLoading(true);
    try {
      const params = new URLSearchParams({ page: String(page), pageSize: String(pageSize), sort, tier: tierFilter });
      const res = await fetch(`${API}/brands/${brandId}/ads?${params}`);
      const data = await res.json();
      setAds(data.ads);
      setTotal(data.total);
    } finally {
      setLoading(false);
    }
  }, [brandId, page, pageSize, sort, tierFilter]);

  useEffect(() => { loadAds(); }, [loadAds]);

  const handleRefresh = async () => {
    setRefreshing(true);
    try {
      await fetch(`${API}/brands/${brandId}/scrape`, { method: 'POST' });
      const res = await fetch(`${API}/brands/${brandId}`);
      const data = await res.json();
      setBrand(data.brand);
      await loadAds();
    } finally {
      setRefreshing(false);
    }
  };

  if (!brand) {
    return <div className="min-h-screen text-zinc-100 p-8"><div className="text-text-muted">Loading...</div></div>;
  }

  const totalPages = Math.ceil(total / pageSize);

  return (
    <div className="min-h-screen text-zinc-100">
      <div className="max-w-7xl mx-auto p-6">
        {/* Breadcrumb */}
        <div className="flex items-center gap-2 mb-6 text-sm text-text-muted">
          <button onClick={() => navigate(-1)} className="hover:text-text-primary flex items-center gap-1.5 cursor-pointer">
            <ChevronLeftIcon /> Brand Spy
          </button>
          <span>/</span>
          <span className="text-text-primary">{brand.domain}</span>
        </div>

        {/* Header */}
        <div className="flex items-start justify-between mb-6">
          <div className="flex items-center gap-4">
            <div className="w-14 h-14 rounded-md bg-bg-elevated flex items-center justify-center text-xl font-medium text-text-muted relative">
              {brand.domain.charAt(0).toUpperCase()}
              {brand.status === 'ACTIVE' && (
                <span className="absolute top-0 right-0 w-2.5 h-2.5 bg-emerald-400 rounded-full ring-2 ring-bg-base" />
              )}
              {brand.status === 'NOISY' && (
                <span className="absolute top-0 right-0 w-2.5 h-2.5 bg-amber-400 rounded-full ring-2 ring-bg-base" />
              )}
            </div>
            <div>
              <div className="flex items-center gap-2">
                <h1 className="text-2xl font-semibold">{brand.domain}</h1>
                <a href={`https://${brand.domain}`} target="_blank" rel="noreferrer" className="text-text-faint hover:text-text-primary">
                  <ExternalIcon />
                </a>
                <StatusBadge status={brand.status} />
              </div>
              <div className="text-sm text-text-muted mt-1">
                {brand.pagesCount} pages · {brand.domainsCount} domains · last scraped {relTime(brand.lastScrapedAt)}
              </div>
            </div>
          </div>
          <button
            onClick={handleRefresh}
            disabled={refreshing}
            className="px-3 py-2 text-sm rounded-md bg-bg-elevated border border-border-default hover:bg-bg-hover disabled:opacity-50 flex items-center gap-2 cursor-pointer"
          >
            <RefreshIcon spinning={refreshing} /> Refresh
          </button>
        </div>

        {/* Metric cards */}
        <div className="grid grid-cols-3 gap-3 mb-6">
          <MetricCard label="Active Ads" value={fmtCount(brand.activeAdsCount)} accent="emerald" />
          <MetricCard label="Pages"      value={String(brand.pagesCount)} />
          <MetricCard label="Domains"    value={String(brand.domainsCount)} />
        </div>

        {/* Tier breakdown */}
        <div className="mb-6 flex items-center gap-2 flex-wrap">
          <div className="text-[10px] uppercase tracking-wider text-text-faint mr-2">Tier Breakdown</div>
          <TierStrip brand={brand} />
        </div>

        {/* Filter + sort */}
        <div className="flex items-center justify-between mb-3 gap-3 flex-wrap">
          <div className="flex items-center gap-1.5 flex-wrap">
            {['ALL', 'BANGER', 'CHAMP', 'A', 'B', 'C', 'MID', 'TEST'].map((t) => (
              <FilterPill key={t} active={tierFilter === t} onClick={() => { setTierFilter(t); setPage(1); }} label={t === 'ALL' ? 'All' : t} />
            ))}
          </div>
          <SortControl value={sort} onChange={(s) => { setSort(s); setPage(1); }} />
        </div>

        {/* Column headers */}
        <div className="hidden md:grid grid-cols-[60px_1fr_60px_60px_60px_60px_60px_70px_60px_60px] gap-2 px-3 py-2 text-[10px] uppercase tracking-wider text-text-faint border-b border-border-subtle">
          <div></div>
          <div>Ad</div>
          <div className="text-center" title={TT_21D}>21D ⓘ</div>
          <div className="text-center" title={TT_7D}>7D ⓘ</div>
          <div className="text-center" title={TT_3D}>3D ⓘ</div>
          <div className="text-center font-semibold text-text-primary" title={TT_NOW}>NOW ⓘ</div>
          <div className="text-center text-emerald-500/80" title={TT_ACTIVE}>ACTIVE ⓘ</div>
          <div className="text-center" title={TT_TIER}>TIER ⓘ</div>
          <div className="text-center" title={TT_V7D}>V7D ⓘ</div>
          <div className="text-center" title={TT_V21D}>V21D ⓘ</div>
        </div>

        {/* Ad rows */}
        {loading ? (
          <div className="text-text-muted text-sm py-12 text-center">Loading ads...</div>
        ) : ads.length === 0 ? (
          <div className="text-text-muted text-sm py-12 text-center">
            {tierFilter === 'ALL' ? 'No ads tracked yet — try Refresh.' : `No ${tierFilter} ads.`}
          </div>
        ) : (
          <div>{ads.map((ad) => <AdRow key={ad.id} ad={ad} onClick={() => setSelectedAd(ad)} />)}</div>
        )}

        {/* Pagination */}
        {totalPages > 1 && (
          <div className="flex items-center justify-between mt-6 text-sm">
            <div className="text-text-muted">Page {page} of {totalPages} · {total.toLocaleString()} ads</div>
            <div className="flex gap-2">
              <button
                onClick={() => setPage((p) => Math.max(1, p - 1))}
                disabled={page === 1}
                className="px-3 py-1.5 rounded-md bg-bg-elevated border border-border-default disabled:opacity-40 hover:bg-bg-hover cursor-pointer"
              >
                ← Prev
              </button>
              <button
                onClick={() => setPage((p) => Math.min(totalPages, p + 1))}
                disabled={page >= totalPages}
                className="px-3 py-1.5 rounded-md bg-bg-elevated border border-border-default disabled:opacity-40 hover:bg-bg-hover cursor-pointer"
              >
                Next →
              </button>
            </div>
          </div>
        )}
      </div>

      {selectedAd && <IntelligenceDrawer ad={selectedAd} onClose={() => setSelectedAd(null)} />}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Ad row
// ---------------------------------------------------------------------------

function AdRow({ ad, onClick }) {
  return (
    <div
      onClick={onClick}
      className="grid grid-cols-[60px_1fr_60px_60px_60px_60px_60px_70px_60px_60px] gap-2 px-3 py-3 items-center border-b border-border-subtle hover:bg-bg-elevated cursor-pointer transition-colors"
    >
      <div className="w-12 h-12 rounded-md bg-bg-elevated border border-border-subtle overflow-hidden flex items-center justify-center">
        {ad.thumbnailUrl ? (
          <img src={ad.thumbnailUrl} alt="" className="w-full h-full object-cover" />
        ) : (
          <span className="text-text-faint text-[10px]">{ad.displayFormat ?? '?'}</span>
        )}
      </div>
      <div className="min-w-0">
        <div className="text-sm text-text-primary truncate">
          {ad.headline || ad.bodyText?.slice(0, 60) || ad.adArchiveId}
        </div>
        <div className="text-[11px] text-text-faint truncate flex items-center gap-2">
          {ad.pageName && <span>{ad.pageName}</span>}
          {ad.displayFormat && (
            <span className="px-1 py-0.5 rounded bg-bg-elevated text-[9px] uppercase tracking-wide">{ad.displayFormat}</span>
          )}
          {ad.collationCount > 1 && <span className="text-text-faint">×{ad.collationCount}</span>}
        </div>
      </div>
      <RankCell value={ad.rank21d}    muted />
      <RankCell value={ad.rank7d}     muted />
      <RankCell value={ad.rank3d}     muted />
      <RankCell value={ad.currentRank} prominent />
      <div className="text-center text-xs">
        {ad.activeDays !== null
          ? <span className={ad.activeDays >= 30 ? 'text-emerald-400 font-semibold' : 'text-text-primary'}>{ad.activeDays}d</span>
          : <span className="text-text-faint">—</span>
        }
      </div>
      <div className="text-center"><TierBadge tier={ad.tier} /></div>
      <VelocityCell value={ad.velocity7d}  activeDays={ad.activeDays} window={7} />
      <VelocityCell value={ad.velocity21d} activeDays={ad.activeDays} window={21} />
    </div>
  );
}

function RankCell({ value, prominent, muted }) {
  if (value === null) return <div className="text-center text-text-faint text-xs">—</div>;
  return (
    <div className={`text-center font-mono text-xs ${prominent ? 'text-text-primary font-semibold' : muted ? 'text-text-muted' : 'text-text-primary'}`}>
      {value}
    </div>
  );
}

function VelocityCell({ value, activeDays, window }) {
  if (value === null) {
    if (activeDays !== null && activeDays < window) {
      return <div className="text-center text-[10px] text-sky-400 font-semibold">NEW</div>;
    }
    return <div className="text-center text-text-faint text-xs">—</div>;
  }
  if (value > 0) return <div className="text-center text-xs text-emerald-400 font-medium">+{value}↑</div>;
  if (value < 0) return <div className="text-center text-xs text-rose-400 font-medium">{value}↓</div>;
  return <div className="text-center text-xs text-text-muted">0</div>;
}

function TierBadge({ tier }) {
  if (!tier) return <span className="text-text-faint text-xs">—</span>;
  const styles = {
    BANGER: 'bg-rose-500/15 text-rose-400 border-rose-500/30',
    CHAMP:  'bg-amber-500/15 text-amber-400 border-amber-500/30',
    A:      'bg-emerald-500/15 text-emerald-400 border-emerald-500/30',
    B:      'bg-sky-500/15 text-sky-400 border-sky-500/30',
    C:      'bg-zinc-700/30 text-zinc-400 border-zinc-700',
    MID:    'bg-zinc-800/50 text-zinc-500 border-zinc-800',
    TEST:   'bg-zinc-900 text-zinc-600 border-zinc-800',
  };
  const icons = { BANGER: '🔥', CHAMP: '🏆' };
  return (
    <span className={`text-[10px] px-1.5 py-0.5 rounded border font-semibold ${styles[tier]}`}>
      {icons[tier] ?? ''} {tier}
    </span>
  );
}

// ---------------------------------------------------------------------------
// Intelligence drawer
// ---------------------------------------------------------------------------

function IntelligenceDrawer({ ad, onClose }) {
  useEffect(() => {
    const h = (e) => e.key === 'Escape' && onClose();
    window.addEventListener('keydown', h);
    return () => window.removeEventListener('keydown', h);
  }, [onClose]);

  return (
    <>
      <div className="fixed inset-0 bg-black/60 z-40" onClick={onClose} />
      <div className="fixed top-0 right-0 bottom-0 w-full max-w-xl bg-bg-card border-l border-border-default z-50 overflow-y-auto">
        <div className="sticky top-0 bg-bg-card border-b border-border-default px-5 py-4 flex items-center justify-between">
          <div className="flex items-center gap-2">
            <TierBadge tier={ad.tier} />
            {ad.currentRank !== null && ad.poolSize !== null && (
              <span className="text-xs text-text-muted">Rank #{ad.currentRank} of {ad.poolSize}</span>
            )}
          </div>
          <button onClick={onClose} className="text-text-faint hover:text-text-primary cursor-pointer"><CloseIcon /></button>
        </div>

        <div className="p-5 space-y-5">
          {/* Creative */}
          <div className="rounded-md overflow-hidden bg-bg-elevated border border-border-subtle">
            {ad.videoUrl ? (
              <video src={ad.videoUrl} controls poster={ad.thumbnailUrl ?? undefined} className="w-full max-h-96 object-contain" />
            ) : ad.thumbnailUrl ? (
              <img src={ad.thumbnailUrl} alt="" className="w-full max-h-96 object-contain" />
            ) : (
              <div className="aspect-video flex items-center justify-center text-text-faint text-sm">No preview available</div>
            )}
          </div>

          {/* Rank grid */}
          <div className="grid grid-cols-4 gap-2 text-center">
            <DrawerStat label="21D"  value={ad.rank21d} />
            <DrawerStat label="7D"   value={ad.rank7d} />
            <DrawerStat label="3D"   value={ad.rank3d} />
            <DrawerStat label="NOW"  value={ad.currentRank} prominent />
          </div>
          <div className="grid grid-cols-3 gap-2 text-center">
            <DrawerStat label="Active" value={ad.activeDays !== null ? `${ad.activeDays}d` : null} highlight={ad.activeDays >= 30} />
            <DrawerStat label="V7D"    value={fmtVelocity(ad.velocity7d, ad.activeDays, 7)} />
            <DrawerStat label="V21D"   value={fmtVelocity(ad.velocity21d, ad.activeDays, 21)} />
          </div>

          {/* Copy */}
          {(ad.headline || ad.bodyText) && (
            <Section title="Copy">
              {ad.headline && <div className="text-sm text-text-primary font-medium">{ad.headline}</div>}
              {ad.bodyText && <div className="text-sm text-text-muted whitespace-pre-wrap mt-1">{ad.bodyText}</div>}
            </Section>
          )}

          {/* Destination */}
          {(ad.ctaText || ad.linkUrl) && (
            <Section title="Destination">
              {ad.ctaText && (
                <div className="text-xs text-text-muted mb-1">
                  CTA: <span className="text-text-primary">{ad.ctaText}</span>
                  {ad.ctaType && <span className="text-text-faint"> ({ad.ctaType})</span>}
                </div>
              )}
              {ad.linkUrl && (
                <a href={ad.linkUrl} target="_blank" rel="noreferrer" className="text-sm text-amber-300/80 hover:text-amber-300 break-all">
                  {ad.linkUrl}
                </a>
              )}
            </Section>
          )}

          {/* Details */}
          <Section title="Details">
            <dl className="grid grid-cols-2 gap-y-1.5 text-xs">
              <dt className="text-text-muted">Page</dt>      <dd className="text-text-primary">{ad.pageName ?? '—'}</dd>
              <dt className="text-text-muted">Format</dt>    <dd className="text-text-primary">{ad.displayFormat ?? '—'}</dd>
              <dt className="text-text-muted">Variants</dt>  <dd className="text-text-primary">{ad.collationCount?.toString() ?? '1'}</dd>
              <dt className="text-text-muted">Status</dt>    <dd className="text-text-primary">{ad.isActive ? 'Running' : 'Ended'}</dd>
              <dt className="text-text-muted">Started</dt>   <dd className="text-text-primary">{ad.startDate ? new Date(ad.startDate).toLocaleDateString() : '—'}</dd>
              <dt className="text-text-muted">Platforms</dt> <dd className="text-text-primary">{ad.publisherPlatforms?.join(', ') || '—'}</dd>
              <dt className="text-text-muted">Archive ID</dt><dd className="text-text-primary font-mono text-[10px] break-all">{ad.adArchiveId}</dd>
            </dl>
            <a
              href={`https://www.facebook.com/ads/library/?active_status=all&ad_type=all&country=US&id=${ad.adArchiveId}`}
              target="_blank"
              rel="noreferrer"
              className="text-xs text-amber-300/80 hover:text-amber-300 mt-3 inline-flex items-center gap-1"
            >
              View on Meta Ad Library <ExternalIcon className="w-3 h-3" />
            </a>
          </Section>
        </div>
      </div>
    </>
  );
}

// ---------------------------------------------------------------------------
// Sub-components
// ---------------------------------------------------------------------------

function MetricCard({ label, value, accent }) {
  return (
    <div className="bg-bg-elevated border border-border-subtle rounded-md p-4">
      <div className="text-[10px] uppercase tracking-wider text-text-faint">{label}</div>
      <div className={`text-2xl font-semibold mt-1 ${accent === 'emerald' ? 'text-emerald-400' : 'text-text-primary'}`}>{value}</div>
    </div>
  );
}

function TierStrip({ brand }) {
  const t = brand.tierBreakdown;
  if (t.champ === null) return <span className="text-xs text-text-faint">Scoring pending — refresh to populate</span>;
  return (
    <>
      {t.banger > 0 && <TierStripChip icon="🔥" value={t.banger} color="rose" />}
      <TierStripChip icon="🏆" value={t.champ ?? 0} color="amber" />
      <TierStripChip label="A"    value={t.a    ?? 0} color="emerald" />
      <TierStripChip label="B"    value={t.b    ?? 0} color="sky" />
      <TierStripChip label="C"    value={t.c    ?? 0} color="zinc" />
      <TierStripChip label="MID"  value={t.low  ?? 0} color="zincDim" />
      <TierStripChip label="TEST" value={t.test ?? 0} color="zincDim" />
    </>
  );
}

function TierStripChip({ label, icon, value, color }) {
  const cls = {
    rose:    'bg-rose-500/10 text-rose-400 border-rose-500/20',
    amber:   'bg-amber-500/10 text-amber-400 border-amber-500/20',
    emerald: 'bg-emerald-500/10 text-emerald-400 border-emerald-500/20',
    sky:     'bg-sky-500/10 text-sky-400 border-sky-500/20',
    zinc:    'bg-zinc-700/30 text-zinc-300 border-zinc-700',
    zincDim: 'bg-zinc-900 text-zinc-500 border-zinc-800',
  }[color];
  return (
    <span className={`text-[10px] font-medium px-2 py-1 rounded border ${cls}`}>
      {icon} {label} {value}
    </span>
  );
}

function FilterPill({ active, onClick, label }) {
  return (
    <button
      onClick={onClick}
      className={`px-2.5 py-1 text-[11px] rounded-md border font-medium transition-colors cursor-pointer ${
        active
          ? 'bg-zinc-100 text-zinc-950 border-zinc-100'
          : 'bg-bg-elevated text-text-muted border-border-default hover:border-border-subtle hover:text-text-primary'
      }`}
    >
      {label}
    </button>
  );
}

function SortControl({ value, onChange }) {
  return (
    <select
      value={value}
      onChange={(e) => onChange(e.target.value)}
      className="bg-bg-elevated border border-border-default rounded-md text-xs px-2 py-1.5 text-text-primary focus:outline-none focus:border-accent"
    >
      <option value="rank_asc">Sort: Top rank</option>
      <option value="velocity_7d_desc">Sort: Climbing (7D)</option>
      <option value="active_days_desc">Sort: Longest running</option>
      <option value="first_seen_desc">Sort: Newest</option>
    </select>
  );
}

function StatusBadge({ status }) {
  const cls = status === 'ACTIVE' ? 'bg-emerald-500/10 text-emerald-400 border-emerald-500/20'
            : status === 'NOISY'  ? 'bg-amber-500/10 text-amber-400 border-amber-500/20'
            : 'bg-bg-elevated text-text-muted border-border-default';
  return <span className={`text-[10px] px-2 py-0.5 rounded uppercase tracking-wider border ${cls}`}>{status}</span>;
}

function Section({ title, children }) {
  return (
    <div>
      <div className="text-[10px] uppercase tracking-wider text-text-faint mb-1.5">{title}</div>
      {children}
    </div>
  );
}

function DrawerStat({ label, value, prominent, highlight }) {
  const display = (value === null || value === undefined || value === '') ? '—' : value;
  return (
    <div className="bg-bg-elevated border border-border-subtle rounded-md py-2 px-1">
      <div className="text-[9px] uppercase tracking-wider text-text-faint">{label}</div>
      <div className={`text-sm font-mono mt-0.5 ${prominent ? 'text-text-primary font-semibold' : highlight ? 'text-emerald-400' : 'text-text-primary'}`}>
        {display}
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Helpers & tooltips
// ---------------------------------------------------------------------------

const TT_21D    = '21-Day Rank — Where this ad ranked ~21 days ago.';
const TT_7D     = '7-Day Rank — Where this ad ranked ~7 days ago.';
const TT_3D     = '3-Day Rank — Where this ad ranked ~3 days ago.';
const TT_NOW    = 'Current Rank — Rank 1 = most eyeballs right now.';
const TT_ACTIVE = 'Active Days — Days the ad has been running. 30+ = proven winner.';
const TT_TIER   = 'Tier — 🔥 BANGER=Top 3% <10d · 🏆 CHAMP=Top 10% · A=25% · B=50% · C=75% · MID=90% · TEST=rest';
const TT_V7D    = 'Velocity 7D — rank positions moved in 7 days. Positive = climbing. NEW if ad < 7 days old.';
const TT_V21D   = 'Velocity 21D — rank positions moved in 21 days. NEW if ad < 21 days old.';

function fmtCount(n) {
  if (n >= 1000) return `${(n / 1000).toFixed(n >= 10_000 ? 0 : 1)}K`;
  return String(n);
}

function relTime(iso) {
  if (!iso) return 'never';
  const diff = Date.now() - new Date(iso).getTime();
  const days = Math.floor(diff / (1000 * 60 * 60 * 24));
  if (days >= 1) return `${days}d ago`;
  const hours = Math.floor(diff / (1000 * 60 * 60));
  if (hours >= 1) return `${hours}h ago`;
  return 'just now';
}

function fmtVelocity(value, activeDays, window) {
  if (value === null) return activeDays !== null && activeDays < window ? 'NEW' : '—';
  if (value > 0) return `+${value}↑`;
  if (value < 0) return `${value}↓`;
  return '0';
}

// ---------------------------------------------------------------------------
// Icons
// ---------------------------------------------------------------------------

const ip = { width: 14, height: 14, viewBox: '0 0 24 24', fill: 'none', stroke: 'currentColor', strokeWidth: 2, strokeLinecap: 'round', strokeLinejoin: 'round' };

function ChevronLeftIcon() { return <svg {...ip}><polyline points="15 18 9 12 15 6"/></svg>; }
function ExternalIcon({ className = '' }) { return <svg {...ip} className={className}><path d="M18 13v6a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h6"/><polyline points="15 3 21 3 21 9"/><line x1="10" y1="14" x2="21" y2="3"/></svg>; }
function RefreshIcon({ spinning }) { return <svg {...ip} className={spinning ? 'animate-spin' : ''}><polyline points="23 4 23 10 17 10"/><polyline points="1 20 1 14 7 14"/><path d="M3.51 9a9 9 0 0 1 14.85-3.36L23 10M1 14l4.64 4.36A9 9 0 0 0 20.49 15"/></svg>; }
function CloseIcon() { return <svg {...ip}><line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/></svg>; }
