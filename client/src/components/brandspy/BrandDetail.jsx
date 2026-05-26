import { useEffect, useState, useCallback } from 'react';

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
    await fetch(`${apiBaseUrl}/brands/${brandId}/scrape`, { method: 'POST' });
    const res = await fetch(`${apiBaseUrl}/brands/${brandId}`);
    const data = await res.json();
    setBrand(data.brand);
    await loadAds();
    setRefreshing(false);
  };

  if (!brand) return <div className="text-text-faint text-sm p-8">Loading...</div>;

  const totalPages = Math.ceil(total / PAGE_SIZE);
  const t = brand.tierBreakdown || {};

  return (
    <div className="space-y-6">
      {/* Breadcrumb */}
      <div className="flex items-center gap-2 text-sm text-text-faint">
        <button onClick={onBack} className="hover:text-text-primary transition-colors cursor-pointer">&#8592; Brand Spy</button>
        <span>/</span>
        <span className="text-text-primary">{brand.domain}</span>
      </div>

      {/* Header */}
      <div className="flex items-start justify-between">
        <div className="flex items-center gap-3">
          <div className="relative w-12 h-12 rounded-xl bg-bg-elevated border border-border-default flex items-center justify-center text-lg font-bold text-text-muted">
            {brand.domain.charAt(0).toUpperCase()}
            {brand.status === 'ACTIVE' && <span className="absolute -top-0.5 -right-0.5 w-2.5 h-2.5 bg-emerald-400 rounded-full ring-2 ring-bg-card" />}
          </div>
          <div>
            <div className="flex items-center gap-2">
              <h1 className="text-xl font-bold text-text-primary">{brand.domain}</h1>
              <a href={`https://${brand.domain}`} target="_blank" rel="noreferrer" className="text-text-faint hover:text-text-muted text-xs">&#8599;</a>
              <span className={`text-[10px] px-2 py-0.5 rounded uppercase tracking-wider ${
                brand.status === 'ACTIVE' ? 'bg-emerald-500/10 text-emerald-400 border border-emerald-500/20' :
                brand.status === 'NOISY' ? 'bg-amber-500/10 text-amber-400 border border-amber-500/20' :
                'bg-bg-elevated text-text-faint border border-border-default'
              }`}>{brand.status}</span>
            </div>
            <p className="text-xs text-text-faint mt-0.5">{brand.pagesCount} pages &middot; {brand.domainsCount} domains &middot; last scraped {relTime(brand.lastScrapedAt)}</p>
          </div>
        </div>
        <button
          onClick={handleRefresh}
          disabled={refreshing}
          className="flex items-center gap-2 px-3 py-2 text-sm rounded-lg bg-bg-elevated border border-border-default hover:bg-bg-hover disabled:opacity-50 text-text-primary transition-colors cursor-pointer"
        >
          <span className={refreshing ? 'animate-spin inline-block' : ''}>&#8635;</span> Refresh
        </button>
      </div>

      {/* Metric cards */}
      <div className="grid grid-cols-3 gap-3">
        <div className="bg-bg-card border border-border-subtle rounded-xl p-4">
          <p className="text-[10px] uppercase tracking-wider text-text-faint">Active Ads</p>
          <p className="text-2xl font-semibold text-emerald-400 mt-1">{fmtCount(brand.activeAdsCount)}</p>
        </div>
        <div className="bg-bg-card border border-border-subtle rounded-xl p-4">
          <p className="text-[10px] uppercase tracking-wider text-text-faint">Pages</p>
          <p className="text-2xl font-semibold text-text-primary mt-1">{brand.pagesCount}</p>
        </div>
        <div className="bg-bg-card border border-border-subtle rounded-xl p-4">
          <p className="text-[10px] uppercase tracking-wider text-text-faint">Domains</p>
          <p className="text-2xl font-semibold text-text-primary mt-1">{brand.domainsCount}</p>
        </div>
      </div>

      {/* Tier strip */}
      <div className="flex items-center gap-2 flex-wrap">
        <span className="text-[10px] uppercase tracking-wider text-text-faint">Tier Breakdown</span>
        {t.champ === null ? (
          <span className="text-xs text-text-faint">Scoring pending — click Refresh</span>
        ) : (
          <>
            {t.banger > 0 && <span className="text-[10px] font-medium px-2 py-1 rounded border bg-rose-500/10 text-rose-400 border-rose-500/20">&#128293; {t.banger}</span>}
            <span className="text-[10px] font-medium px-2 py-1 rounded border bg-amber-500/10 text-amber-400 border-amber-500/20">&#127942; {t.champ}</span>
            <span className="text-[10px] font-medium px-2 py-1 rounded border bg-emerald-500/10 text-emerald-400 border-emerald-500/20">A {t.a}</span>
            <span className="text-[10px] font-medium px-2 py-1 rounded border bg-sky-500/10 text-sky-400 border-sky-500/20">B {t.b}</span>
            <span className="text-[10px] font-medium px-2 py-1 rounded border bg-zinc-700/30 text-text-muted border-zinc-700">C {t.c}</span>
            <span className="text-[10px] font-medium px-2 py-1 rounded border bg-bg-elevated text-text-faint border-border-default">MID {t.low}</span>
            <span className="text-[10px] font-medium px-2 py-1 rounded border bg-bg-card text-text-faint border-border-subtle">TEST {t.test}</span>
          </>
        )}
      </div>

      {/* Filter + sort */}
      <div className="flex items-center justify-between gap-3 flex-wrap">
        <div className="flex items-center gap-1.5 flex-wrap">
          {['ALL','BANGER','CHAMP','A','B','C','MID','TEST'].map(f => (
            <button key={f} onClick={() => { setTierFilter(f); setPage(1); }}
              className={`px-2.5 py-1 text-[11px] rounded-lg border font-medium transition-colors cursor-pointer ${
                tierFilter === f ? 'bg-text-primary text-bg-card border-text-primary' : 'bg-bg-elevated text-text-muted border-border-default hover:border-border-hover hover:text-text-primary'
              }`}>
              {f}
            </button>
          ))}
        </div>
        <select value={sort} onChange={e => { setSort(e.target.value); setPage(1); }}
          className="text-xs bg-bg-elevated border border-border-default rounded-lg px-2 py-1.5 text-text-muted focus:outline-none">
          <option value="rank_asc">Top rank</option>
          <option value="velocity_7d_desc">Climbing (7D)</option>
          <option value="active_days_desc">Longest running</option>
          <option value="first_seen_desc">Newest</option>
        </select>
      </div>

      {/* Column headers */}
      <div className="hidden lg:grid grid-cols-[56px_1fr_56px_56px_56px_64px_64px_72px_56px_56px] gap-2 px-3 py-2 text-[10px] uppercase tracking-wider text-text-faint border-b border-border-subtle">
        <div></div><div>Ad</div>
        <div className="text-center" title="Where this ad ranked ~21 days ago">21D</div>
        <div className="text-center" title="Where this ad ranked ~7 days ago">7D</div>
        <div className="text-center" title="Where this ad ranked ~3 days ago">3D</div>
        <div className="text-center font-semibold text-text-muted" title="Current rank by impressions — the live score">NOW</div>
        <div className="text-center text-emerald-500/80" title="Days the ad has been running. 30+ = proven winner">ACTIVE</div>
        <div className="text-center" title="BANGER/CHAMP/A/B/C/MID/TEST">TIER</div>
        <div className="text-center" title="Rank positions moved in 7 days. Positive = climbing">V7D</div>
        <div className="text-center" title="Rank positions moved in 21 days">V21D</div>
      </div>

      {/* Ads */}
      {loading ? (
        <div className="text-text-faint text-sm py-12 text-center">Loading ads...</div>
      ) : ads.length === 0 ? (
        <div className="text-text-faint text-sm py-12 text-center">
          {tierFilter === 'ALL' ? 'No ads tracked yet — click Refresh.' : `No ${tierFilter} ads.`}
        </div>
      ) : (
        <div>
          {ads.map(ad => <AdRow key={ad.id} ad={ad} onClick={() => setSelectedAd(ad)} />)}
        </div>
      )}

      {/* Pagination */}
      {totalPages > 1 && (
        <div className="flex items-center justify-between text-sm">
          <span className="text-text-faint">{total.toLocaleString()} ads &middot; page {page} of {totalPages}</span>
          <div className="flex gap-2">
            <button onClick={() => setPage(p => Math.max(1, p - 1))} disabled={page === 1}
              className="px-3 py-1.5 rounded-lg bg-bg-elevated border border-border-default disabled:opacity-40 hover:bg-bg-hover text-text-primary cursor-pointer">
              &larr; Prev
            </button>
            <button onClick={() => setPage(p => Math.min(totalPages, p + 1))} disabled={page >= totalPages}
              className="px-3 py-1.5 rounded-lg bg-bg-elevated border border-border-default disabled:opacity-40 hover:bg-bg-hover text-text-primary cursor-pointer">
              Next &rarr;
            </button>
          </div>
        </div>
      )}

      {/* Intelligence drawer */}
      {selectedAd && <IntelDrawer ad={selectedAd} onClose={() => setSelectedAd(null)} />}
    </div>
  );
}

function AdRow({ ad, onClick }) {
  const tierColors = {
    BANGER: 'bg-rose-500/15 text-rose-400 border-rose-500/30',
    CHAMP: 'bg-amber-500/15 text-amber-400 border-amber-500/30',
    A: 'bg-emerald-500/15 text-emerald-400 border-emerald-500/30',
    B: 'bg-sky-500/15 text-sky-400 border-sky-500/30',
    C: 'bg-zinc-700/30 text-text-muted border-zinc-700',
    MID: 'bg-bg-elevated text-text-faint border-border-default',
    TEST: 'bg-bg-card text-text-faint border-border-subtle',
  };

  return (
    <div onClick={onClick}
      className="grid grid-cols-[56px_1fr] lg:grid-cols-[56px_1fr_56px_56px_56px_64px_64px_72px_56px_56px] gap-2 px-3 py-3 items-center border-b border-border-subtle hover:bg-bg-elevated cursor-pointer transition-colors">
      {/* Thumbnail */}
      <div className="w-12 h-12 rounded-lg bg-bg-elevated border border-border-subtle overflow-hidden flex items-center justify-center">
        {ad.thumbnailUrl
          ? <img src={ad.thumbnailUrl} alt="" className="w-full h-full object-cover" />
          : <span className="text-text-faint text-[10px]">{ad.displayFormat || '?'}</span>}
      </div>

      {/* Summary */}
      <div className="min-w-0">
        <div className="text-sm text-text-primary truncate">{ad.headline || ad.bodyText?.slice(0, 60) || ad.adArchiveId}</div>
        <div className="text-[11px] text-text-faint flex items-center gap-2 mt-0.5">
          {ad.pageName && <span>{ad.pageName}</span>}
          {ad.displayFormat && <span className="px-1 py-0.5 rounded bg-bg-elevated text-[9px] uppercase">{ad.displayFormat}</span>}
          {ad.collationCount > 1 && <span className="text-text-faint">&times;{ad.collationCount}</span>}
        </div>
      </div>

      {/* Rank cols — only shown on lg+ */}
      <div className="hidden lg:block text-center text-xs text-text-faint font-mono">{ad.rank21d ?? '—'}</div>
      <div className="hidden lg:block text-center text-xs text-text-faint font-mono">{ad.rank7d ?? '—'}</div>
      <div className="hidden lg:block text-center text-xs text-text-faint font-mono">{ad.rank3d ?? '—'}</div>
      <div className="hidden lg:block text-center text-xs text-text-primary font-semibold font-mono">{ad.currentRank ?? '—'}</div>
      <div className="hidden lg:block text-center text-xs">
        {ad.activeDays !== null ? (
          <span className={ad.activeDays >= 30 ? 'text-emerald-400 font-semibold' : 'text-text-primary'}>{ad.activeDays}d</span>
        ) : '—'}
      </div>
      <div className="hidden lg:block text-center">
        {ad.tier ? (
          <span className={`text-[10px] px-1.5 py-0.5 rounded border font-semibold ${tierColors[ad.tier] || ''}`}>
            {ad.tier === 'BANGER' ? '&#128293; ' : ad.tier === 'CHAMP' ? '&#127942; ' : ''}{ad.tier}
          </span>
        ) : '—'}
      </div>
      <div className="hidden lg:block text-center text-xs">
        <VelCell value={ad.velocity7d} days={ad.activeDays} win={7} />
      </div>
      <div className="hidden lg:block text-center text-xs">
        <VelCell value={ad.velocity21d} days={ad.activeDays} win={21} />
      </div>
    </div>
  );
}

function VelCell({ value, days, win }) {
  if (value === null) {
    if (days !== null && days < win) return <span className="text-sky-400 font-semibold text-[10px]">NEW</span>;
    return <span className="text-text-faint">—</span>;
  }
  if (value > 0) return <span className="text-emerald-400 font-medium">+{value}&uarr;</span>;
  if (value < 0) return <span className="text-rose-400 font-medium">{value}&darr;</span>;
  return <span className="text-text-faint">0</span>;
}

function IntelDrawer({ ad, onClose }) {
  useEffect(() => {
    const h = (e) => e.key === 'Escape' && onClose();
    window.addEventListener('keydown', h);
    return () => window.removeEventListener('keydown', h);
  }, [onClose]);

  return (
    <>
      <div className="fixed inset-0 bg-black/60 z-40" onClick={onClose} />
      <div className="fixed top-0 right-0 bottom-0 w-full max-w-lg bg-bg-card border-l border-border-default z-50 overflow-y-auto">
        <div className="sticky top-0 bg-bg-card border-b border-border-subtle px-5 py-4 flex items-center justify-between">
          <div className="flex items-center gap-2">
            {ad.tier && <span className="text-xs font-semibold px-2 py-0.5 rounded border bg-bg-elevated text-text-primary border-border-default">{ad.tier}</span>}
            {ad.currentRank && <span className="text-xs text-text-faint">Rank #{ad.currentRank}</span>}
          </div>
          <button onClick={onClose} className="text-text-faint hover:text-text-primary text-lg cursor-pointer">&#10005;</button>
        </div>
        <div className="p-5 space-y-5">
          {/* Creative */}
          <div className="rounded-xl overflow-hidden bg-bg-elevated border border-border-subtle">
            {ad.videoUrl ? (
              <video src={ad.videoUrl} controls poster={ad.thumbnailUrl} className="w-full max-h-80 object-contain" />
            ) : ad.thumbnailUrl ? (
              <img src={ad.thumbnailUrl} alt="" className="w-full max-h-80 object-contain" />
            ) : (
              <div className="aspect-video flex items-center justify-center text-text-faint text-sm">No preview</div>
            )}
          </div>

          {/* Rank grid */}
          <div className="grid grid-cols-4 gap-2 text-center">
            {[['21D', ad.rank21d], ['7D', ad.rank7d], ['3D', ad.rank3d], ['NOW', ad.currentRank]].map(([l, v]) => (
              <div key={l} className="bg-bg-elevated border border-border-subtle rounded-lg py-2 px-1">
                <div className="text-[9px] uppercase tracking-wider text-text-faint">{l}</div>
                <div className="text-sm font-mono text-text-primary font-semibold mt-0.5">{v ?? '—'}</div>
              </div>
            ))}
          </div>

          <div className="grid grid-cols-3 gap-2 text-center">
            <div className="bg-bg-elevated border border-border-subtle rounded-lg py-2">
              <div className="text-[9px] uppercase tracking-wider text-text-faint">Active</div>
              <div className={`text-sm font-mono mt-0.5 ${ad.activeDays >= 30 ? 'text-emerald-400 font-semibold' : 'text-text-primary'}`}>{ad.activeDays !== null ? `${ad.activeDays}d` : '—'}</div>
            </div>
            <div className="bg-bg-elevated border border-border-subtle rounded-lg py-2">
              <div className="text-[9px] uppercase tracking-wider text-text-faint">V7D</div>
              <div className="text-sm font-mono mt-0.5"><VelCell value={ad.velocity7d} days={ad.activeDays} win={7} /></div>
            </div>
            <div className="bg-bg-elevated border border-border-subtle rounded-lg py-2">
              <div className="text-[9px] uppercase tracking-wider text-text-faint">V21D</div>
              <div className="text-sm font-mono mt-0.5"><VelCell value={ad.velocity21d} days={ad.activeDays} win={21} /></div>
            </div>
          </div>

          {/* Copy */}
          {(ad.headline || ad.bodyText) && (
            <div>
              <p className="text-[10px] uppercase tracking-wider text-text-faint mb-1.5">Copy</p>
              {ad.headline && <p className="text-sm font-medium text-text-primary">{ad.headline}</p>}
              {ad.bodyText && <p className="text-sm text-text-muted mt-1 whitespace-pre-wrap">{ad.bodyText}</p>}
            </div>
          )}

          {/* Destination */}
          {(ad.ctaText || ad.linkUrl) && (
            <div>
              <p className="text-[10px] uppercase tracking-wider text-text-faint mb-1.5">Destination</p>
              {ad.ctaText && <p className="text-xs text-text-muted mb-1">CTA: <span className="text-text-primary">{ad.ctaText}</span></p>}
              {ad.linkUrl && <a href={ad.linkUrl} target="_blank" rel="noreferrer" className="text-sm text-amber-400/80 hover:text-amber-300 break-all">{ad.linkUrl}</a>}
            </div>
          )}

          {/* Details */}
          <div>
            <p className="text-[10px] uppercase tracking-wider text-text-faint mb-1.5">Details</p>
            <dl className="grid grid-cols-2 gap-y-1.5 text-xs">
              {[['Page', ad.pageName], ['Format', ad.displayFormat], ['Variants', ad.collationCount || '1'], ['Status', ad.isActive ? 'Running' : 'Ended'], ['Started', ad.startDate ? new Date(ad.startDate).toLocaleDateString() : '—'], ['Platforms', ad.publisherPlatforms?.join(', ') || '—']].map(([l, v]) => (
                <><dt key={l+'l'} className="text-text-faint">{l}</dt><dd key={l+'v'} className="text-text-primary">{v || '—'}</dd></>
              ))}
            </dl>
            <a href={`https://www.facebook.com/ads/library/?id=${ad.adArchiveId}`} target="_blank" rel="noreferrer"
              className="text-xs text-amber-400/80 hover:text-amber-300 mt-3 inline-flex items-center gap-1">
              View on Meta Ad Library &#8599;
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
