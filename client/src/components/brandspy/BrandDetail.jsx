import { useEffect, useState, useCallback } from 'react';
import { ArrowLeft, ExternalLink, RefreshCw, X, ChevronDown } from 'lucide-react';

const TIER_COLORS = {
  BANGER: 'bg-rose-500/15 text-rose-400 border-rose-500/30',
  CHAMP: 'bg-amber-500/15 text-amber-400 border-amber-500/30',
  A: 'bg-emerald-500/15 text-emerald-400 border-emerald-500/30',
  B: 'bg-sky-500/15 text-sky-400 border-sky-500/30',
  C: 'bg-zinc-700/40 text-zinc-400 border-zinc-700',
  MID: 'bg-bg-elevated text-text-faint border-border-default',
  TEST: 'bg-bg-card text-text-faint border-border-subtle',
};
const TIER_ICONS = { BANGER: '🔥', CHAMP: '🏆' };

export default function BrandDetail({ apiBaseUrl, brandId, onBack }) {
  const [brand, setBrand] = useState(null);
  const [ads, setAds] = useState([]);
  const [total, setTotal] = useState(0);
  const [page, setPage] = useState(1);
  const [sort, setSort] = useState('rank_asc');
  const [tierFilter, setTierFilter] = useState('ALL');
  const [loading, setLoading] = useState(true);
  const [selectedAd, setSelectedAd] = useState(null);
  const [refreshing, setRefreshing] = useState(false);
  const PAGE_SIZE = 24;

  useEffect(() => {
    fetch(`${apiBaseUrl}/brands/${brandId}`)
      .then(r => r.json())
      .then(d => setBrand(d.brand))
      .catch(console.error);
  }, [apiBaseUrl, brandId]);

  const loadAds = useCallback(async () => {
    setLoading(true);
    try {
      const params = new URLSearchParams({ page: String(page), pageSize: String(PAGE_SIZE), sort, tier: tierFilter });
      const res = await fetch(`${apiBaseUrl}/brands/${brandId}/ads?${params}`);
      const data = await res.json();
      setAds(data.ads || []);
      setTotal(data.total || 0);
    } finally { setLoading(false); }
  }, [apiBaseUrl, brandId, page, sort, tierFilter]);

  useEffect(() => { loadAds(); }, [loadAds]);

  const handleRefresh = async () => {
    setRefreshing(true);
    try {
      await fetch(`${apiBaseUrl}/brands/${brandId}/scrape`, { method: 'POST' });
      const res = await fetch(`${apiBaseUrl}/brands/${brandId}`);
      const data = await res.json();
      setBrand(data.brand);
      await loadAds();
    } finally { setRefreshing(false); }
  };

  if (!brand) return (
    <div className="flex items-center justify-center py-20 text-text-faint text-sm">Loading...</div>
  );

  const totalPages = Math.ceil(total / PAGE_SIZE);
  const t = brand.tierBreakdown || {};

  return (
    <div className="space-y-5">
      {/* Breadcrumb */}
      <button onClick={onBack} className="flex items-center gap-1.5 text-sm text-text-muted hover:text-text-primary transition-colors">
        <ArrowLeft className="w-4 h-4" />
        Brand Spy
      </button>

      {/* Header */}
      <div className="flex items-start justify-between gap-4">
        <div className="flex items-center gap-3">
          <div className="relative w-11 h-11 rounded-xl bg-bg-elevated border border-border-default flex items-center justify-center text-base font-bold text-text-muted shrink-0">
            {brand.domain.charAt(0).toUpperCase()}
            <span className={`absolute -top-0.5 -right-0.5 w-2.5 h-2.5 rounded-full ring-2 ring-bg-main ${
              brand.status === 'ACTIVE' ? 'bg-emerald-400' : 'bg-zinc-600'
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
                brand.status === 'NOISY' ? 'bg-amber-500/10 text-amber-400 border-amber-500/20' :
                'bg-bg-elevated text-text-faint border-border-default'
              }`}>{brand.status}</span>
            </div>
            <p className="text-xs text-text-faint mt-0.5">
              {brand.pagesCount} pages &middot; {brand.domainsCount} domains &middot; scraped {relTime(brand.lastScrapedAt)}
            </p>
          </div>
        </div>
        <button
          onClick={handleRefresh}
          disabled={refreshing}
          className="flex items-center gap-1.5 px-3 py-1.5 text-sm rounded-lg bg-bg-elevated border border-border-default hover:bg-bg-hover disabled:opacity-40 text-text-primary transition-colors shrink-0"
        >
          <RefreshCw className={`w-3.5 h-3.5 ${refreshing ? 'animate-spin' : ''}`} />
          Refresh
        </button>
      </div>

      {/* Metric cards */}
      <div className="grid grid-cols-3 gap-3">
        <MetricCard label="Active Ads" value={fmtCount(brand.activeAdsCount)} accent />
        <MetricCard label="Pages" value={String(brand.pagesCount)} />
        <MetricCard label="Domains" value={String(brand.domainsCount)} />
      </div>

      {/* Tier strip */}
      <div className="flex items-center gap-2 flex-wrap">
        <span className="text-[10px] uppercase tracking-wider text-text-faint">Tiers</span>
        {t.champ == null ? (
          <span className="text-xs text-text-faint">Scoring pending — click Refresh</span>
        ) : (
          <>
            {t.banger > 0 && <span className="text-[10px] font-medium px-2 py-0.5 rounded border bg-rose-500/10 text-rose-400 border-rose-500/20">🔥 {t.banger}</span>}
            <span className="text-[10px] font-medium px-2 py-0.5 rounded border bg-amber-500/10 text-amber-400 border-amber-500/20">🏆 {t.champ}</span>
            <span className="text-[10px] font-medium px-2 py-0.5 rounded border bg-emerald-500/10 text-emerald-400 border-emerald-500/20">A {t.a}</span>
            <span className="text-[10px] font-medium px-2 py-0.5 rounded border bg-sky-500/10 text-sky-400 border-sky-500/20">B {t.b}</span>
            <span className="text-[10px] font-medium px-2 py-0.5 rounded border bg-zinc-700/40 text-zinc-400 border-zinc-700">C {t.c}</span>
            <span className="text-[10px] font-medium px-2 py-0.5 rounded border bg-bg-elevated text-text-faint border-border-default">MID {t.low}</span>
            <span className="text-[10px] font-medium px-2 py-0.5 rounded border bg-bg-card text-text-faint border-border-subtle">TEST {t.test}</span>
          </>
        )}
      </div>

      {/* Filter + sort */}
      <div className="flex items-center justify-between gap-3 flex-wrap">
        <div className="flex items-center gap-1 flex-wrap">
          {['ALL','BANGER','CHAMP','A','B','C','MID','TEST'].map(f => (
            <button
              key={f}
              onClick={() => { setTierFilter(f); setPage(1); }}
              className={`px-2.5 py-1 text-xs rounded-lg border font-medium transition-colors ${
                tierFilter === f
                  ? 'bg-accent text-white border-accent'
                  : 'bg-bg-elevated text-text-muted border-border-default hover:text-text-primary hover:border-border-hover'
              }`}
            >
              {f}
            </button>
          ))}
        </div>
        <select
          value={sort}
          onChange={e => { setSort(e.target.value); setPage(1); }}
          className="text-xs bg-bg-elevated border border-border-default rounded-lg px-2.5 py-1.5 text-text-muted focus:outline-none cursor-pointer"
        >
          <option value="rank_asc">Top rank</option>
          <option value="velocity_7d_desc">Climbing fast</option>
          <option value="active_days_desc">Longest running</option>
          <option value="first_seen_desc">Newest</option>
        </select>
      </div>

      {/* Column headers */}
      <div className="hidden lg:grid grid-cols-[48px_1fr_52px_52px_52px_60px_60px_68px_52px_52px] gap-2 px-3 pb-1 text-[10px] uppercase tracking-wider text-text-faint border-b border-border-subtle">
        <div /><div>Ad</div>
        <div className="text-center">21D</div>
        <div className="text-center">7D</div>
        <div className="text-center">3D</div>
        <div className="text-center font-semibold text-text-muted">NOW</div>
        <div className="text-center text-emerald-500/70">ACTIVE</div>
        <div className="text-center">TIER</div>
        <div className="text-center">V7D</div>
        <div className="text-center">V21D</div>
      </div>

      {/* Ads */}
      {loading ? (
        <div className="flex items-center justify-center py-16 text-text-faint text-sm">Loading ads...</div>
      ) : ads.length === 0 ? (
        <div className="flex items-center justify-center py-16 text-text-faint text-sm">
          {tierFilter === 'ALL' ? 'No ads tracked yet — click Refresh.' : `No ${tierFilter} ads.`}
        </div>
      ) : (
        <div className="rounded-xl border border-border-subtle overflow-hidden">
          {ads.map((ad, i) => <AdRow key={ad.id} ad={ad} onClick={() => setSelectedAd(ad)} last={i === ads.length - 1} />)}
        </div>
      )}

      {/* Pagination */}
      {totalPages > 1 && (
        <div className="flex items-center justify-between text-sm pt-1">
          <span className="text-text-faint text-xs">{total.toLocaleString()} ads &middot; page {page} of {totalPages}</span>
          <div className="flex gap-2">
            <button onClick={() => setPage(p => Math.max(1, p - 1))} disabled={page === 1}
              className="px-3 py-1.5 text-xs rounded-lg bg-bg-elevated border border-border-default disabled:opacity-40 hover:bg-bg-hover text-text-primary transition-colors">
              &larr; Prev
            </button>
            <button onClick={() => setPage(p => Math.min(totalPages, p + 1))} disabled={page >= totalPages}
              className="px-3 py-1.5 text-xs rounded-lg bg-bg-elevated border border-border-default disabled:opacity-40 hover:bg-bg-hover text-text-primary transition-colors">
              Next &rarr;
            </button>
          </div>
        </div>
      )}

      {selectedAd && <IntelDrawer ad={selectedAd} onClose={() => setSelectedAd(null)} />}
    </div>
  );
}

function MetricCard({ label, value, accent }) {
  return (
    <div className="bg-bg-card border border-border-subtle rounded-xl p-4">
      <p className="text-[10px] uppercase tracking-wider text-text-faint">{label}</p>
      <p className={`text-2xl font-semibold mt-1 ${accent ? 'text-emerald-400' : 'text-white'}`}>{value}</p>
    </div>
  );
}

function AdRow({ ad, onClick, last }) {
  return (
    <div
      onClick={onClick}
      className={`grid grid-cols-[48px_1fr] lg:grid-cols-[48px_1fr_52px_52px_52px_60px_60px_68px_52px_52px] gap-2 px-3 py-2.5 items-center hover:bg-bg-elevated cursor-pointer transition-colors ${
        !last ? 'border-b border-border-subtle' : ''
      }`}
    >
      <div className="w-10 h-10 rounded-lg bg-bg-elevated border border-border-subtle overflow-hidden flex items-center justify-center shrink-0">
        {ad.thumbnailUrl
          ? <img src={ad.thumbnailUrl} alt="" className="w-full h-full object-cover" />
          : <span className="text-text-faint text-[9px]">{ad.displayFormat || '?'}</span>}
      </div>
      <div className="min-w-0">
        <p className="text-sm text-text-primary truncate">{ad.headline || ad.bodyText?.slice(0, 60) || ad.adArchiveId}</p>
        <div className="flex items-center gap-2 mt-0.5">
          {ad.pageName && <span className="text-[11px] text-text-faint truncate">{ad.pageName}</span>}
          {ad.displayFormat && <span className="text-[9px] px-1 py-0.5 rounded bg-bg-elevated text-text-faint uppercase shrink-0">{ad.displayFormat}</span>}
        </div>
      </div>
      <RankCell value={ad.rank21d} />
      <RankCell value={ad.rank7d} />
      <RankCell value={ad.rank3d} />
      <RankCell value={ad.currentRank} bold />
      <div className="hidden lg:flex justify-center">
        {ad.activeDays != null
          ? <span className={`text-xs tabular-nums ${ad.activeDays >= 30 ? 'text-emerald-400 font-semibold' : 'text-text-primary'}`}>{ad.activeDays}d</span>
          : <span className="text-text-faint text-xs">—</span>}
      </div>
      <div className="hidden lg:flex justify-center">
        {ad.tier ? (
          <span className={`text-[10px] px-1.5 py-0.5 rounded border font-medium ${TIER_COLORS[ad.tier] || ''}`}>
            {TIER_ICONS[ad.tier] ? `${TIER_ICONS[ad.tier]} ` : ''}{ad.tier}
          </span>
        ) : <span className="text-text-faint text-xs">—</span>}
      </div>
      <VelCell value={ad.velocity7d} days={ad.activeDays} win={7} />
      <VelCell value={ad.velocity21d} days={ad.activeDays} win={21} />
    </div>
  );
}

function RankCell({ value, bold }) {
  if (!value && value !== 0) return <div className="hidden lg:flex justify-center text-xs text-text-faint">—</div>;
  return <div className={`hidden lg:flex justify-center text-xs font-mono tabular-nums ${bold ? 'text-white font-semibold' : 'text-text-faint'}`}>{value}</div>;
}

function VelCell({ value, days, win }) {
  if (value === null || value === undefined) {
    if (days != null && days < win) return <div className="hidden lg:flex justify-center text-[10px] text-sky-400 font-semibold">NEW</div>;
    return <div className="hidden lg:flex justify-center text-xs text-text-faint">—</div>;
  }
  if (value > 0) return <div className="hidden lg:flex justify-center text-xs text-emerald-400 font-medium">+{value}↑</div>;
  if (value < 0) return <div className="hidden lg:flex justify-center text-xs text-rose-400 font-medium">{value}↓</div>;
  return <div className="hidden lg:flex justify-center text-xs text-text-faint">0</div>;
}

function IntelDrawer({ ad, onClose }) {
  useEffect(() => {
    const h = e => e.key === 'Escape' && onClose();
    window.addEventListener('keydown', h);
    return () => window.removeEventListener('keydown', h);
  }, [onClose]);

  return (
    <>
      <div className="fixed inset-0 bg-black/50 z-40" onClick={onClose} />
      <div className="fixed top-0 right-0 bottom-0 w-full max-w-md bg-bg-card border-l border-border-default z-50 overflow-y-auto flex flex-col">
        <div className="sticky top-0 bg-bg-card border-b border-border-subtle px-5 py-3.5 flex items-center justify-between shrink-0">
          <div className="flex items-center gap-2">
            {ad.tier && (
              <span className={`text-xs font-semibold px-2 py-0.5 rounded border ${TIER_COLORS[ad.tier] || ''}`}>
                {TIER_ICONS[ad.tier] ? `${TIER_ICONS[ad.tier]} ` : ''}{ad.tier}
              </span>
            )}
            {ad.currentRank && <span className="text-xs text-text-faint">Rank #{ad.currentRank}</span>}
          </div>
          <button onClick={onClose} className="p-1 rounded-md text-text-faint hover:text-text-primary hover:bg-bg-hover transition-colors">
            <X className="w-4 h-4" />
          </button>
        </div>

        <div className="p-5 space-y-4 flex-1">
          {/* Creative */}
          <div className="rounded-xl overflow-hidden bg-bg-elevated border border-border-subtle">
            {ad.videoUrl ? (
              <video src={ad.videoUrl} controls poster={ad.thumbnailUrl} className="w-full max-h-72 object-contain" />
            ) : ad.thumbnailUrl ? (
              <img src={ad.thumbnailUrl} alt="" className="w-full max-h-72 object-contain" />
            ) : (
              <div className="aspect-video flex items-center justify-center text-text-faint text-sm">No preview</div>
            )}
          </div>

          {/* Rank grid */}
          <div className="grid grid-cols-4 gap-2">
            {[['21D', ad.rank21d], ['7D', ad.rank7d], ['3D', ad.rank3d], ['NOW', ad.currentRank]].map(([l, v]) => (
              <div key={l} className="bg-bg-elevated border border-border-subtle rounded-lg py-2 text-center">
                <p className="text-[9px] uppercase tracking-wider text-text-faint">{l}</p>
                <p className="text-sm font-mono font-semibold text-white mt-0.5">{v ?? '—'}</p>
              </div>
            ))}
          </div>

          <div className="grid grid-cols-3 gap-2">
            <div className="bg-bg-elevated border border-border-subtle rounded-lg py-2 text-center">
              <p className="text-[9px] uppercase tracking-wider text-text-faint">Active</p>
              <p className={`text-sm font-mono mt-0.5 ${ad.activeDays >= 30 ? 'text-emerald-400 font-semibold' : 'text-white'}`}>
                {ad.activeDays != null ? `${ad.activeDays}d` : '—'}
              </p>
            </div>
            {[['V7D', ad.velocity7d, ad.activeDays, 7], ['V21D', ad.velocity21d, ad.activeDays, 21]].map(([l, v, d, w]) => (
              <div key={l} className="bg-bg-elevated border border-border-subtle rounded-lg py-2 text-center">
                <p className="text-[9px] uppercase tracking-wider text-text-faint">{l}</p>
                <div className="text-sm font-mono mt-0.5">
                  {v == null ? (d != null && d < w ? <span className="text-sky-400 font-semibold text-xs">NEW</span> : <span className="text-text-faint">—</span>)
                    : v > 0 ? <span className="text-emerald-400">+{v}↑</span>
                    : v < 0 ? <span className="text-rose-400">{v}↓</span>
                    : <span className="text-text-faint">0</span>}
                </div>
              </div>
            ))}
          </div>

          {(ad.headline || ad.bodyText) && (
            <div>
              <p className="text-[10px] uppercase tracking-wider text-text-faint mb-1.5">Copy</p>
              {ad.headline && <p className="text-sm font-medium text-white">{ad.headline}</p>}
              {ad.bodyText && <p className="text-sm text-text-muted mt-1 whitespace-pre-wrap">{ad.bodyText}</p>}
            </div>
          )}

          {(ad.ctaText || ad.linkUrl) && (
            <div>
              <p className="text-[10px] uppercase tracking-wider text-text-faint mb-1.5">Destination</p>
              {ad.ctaText && <p className="text-xs text-text-muted mb-1">CTA: <span className="text-text-primary">{ad.ctaText}</span></p>}
              {ad.linkUrl && (
                <a href={ad.linkUrl} target="_blank" rel="noreferrer" className="text-sm text-amber-400/80 hover:text-amber-300 break-all">
                  {ad.linkUrl}
                </a>
              )}
            </div>
          )}

          <div>
            <p className="text-[10px] uppercase tracking-wider text-text-faint mb-1.5">Details</p>
            <div className="grid grid-cols-2 gap-x-4 gap-y-1.5 text-xs">
              {[['Page', ad.pageName], ['Format', ad.displayFormat], ['Variants', ad.collationCount || '1'],
                ['Status', ad.isActive ? 'Running' : 'Ended'],
                ['Started', ad.startDate ? new Date(ad.startDate).toLocaleDateString() : '—'],
                ['Platforms', ad.publisherPlatforms?.join(', ') || '—']
              ].map(([l, v]) => (
                <div key={l} className="contents">
                  <span className="text-text-faint">{l}</span>
                  <span className="text-text-primary">{v || '—'}</span>
                </div>
              ))}
            </div>
            <a
              href={`https://www.facebook.com/ads/library/?id=${ad.adArchiveId}`}
              target="_blank" rel="noreferrer"
              className="mt-3 inline-flex items-center gap-1 text-xs text-amber-400/80 hover:text-amber-300"
            >
              View on Meta Ad Library <ExternalLink className="w-3 h-3" />
            </a>
          </div>
        </div>
      </div>
    </>
  );
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
