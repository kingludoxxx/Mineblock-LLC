import { useEffect, useMemo, useState, useCallback } from 'react';
import { Search, RefreshCw, Plus, X, ChevronDown, ChevronRight, ExternalLink } from 'lucide-react';

export default function BrandSpyFollowing({ apiBaseUrl, onBrandClick }) {
  const [brands, setBrands] = useState([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);
  const [searchTerm, setSearchTerm] = useState('');
  const [sort, setSort] = useState('active_desc');
  const [showFollowModal, setShowFollowModal] = useState(false);
  const [scrapingAll, setScrapingAll] = useState(false);

  const fetchBrands = useCallback(async () => {
    try {
      const res = await fetch(`${apiBaseUrl}/brands`);
      if (!res.ok) throw new Error(`Failed (${res.status})`);
      const data = await res.json();
      setBrands(data.brands || []);
      setError(null);
    } catch (e) {
      setError(e.message);
    } finally {
      setLoading(false);
    }
  }, [apiBaseUrl]);

  useEffect(() => { fetchBrands(); }, [fetchBrands]);

  const stats = useMemo(() => ({
    totalAds: brands.reduce((s, b) => s + (b.totalAdsCount || 0), 0),
    activeAds: brands.reduce((s, b) => s + (b.activeAdsCount || 0), 0),
    totalPages: brands.reduce((s, b) => s + (b.pagesCount || 0), 0),
  }), [brands]);

  const visible = useMemo(() => {
    const q = searchTerm.trim().toLowerCase();
    const filtered = q
      ? brands.filter(b => b.domain.toLowerCase().includes(q) || b.displayName?.toLowerCase().includes(q))
      : brands;
    return [...filtered].sort((a, b) => {
      if (sort === 'active_asc') return (a.activeAdsCount || 0) - (b.activeAdsCount || 0);
      if (sort === 'total_desc') return (b.totalAdsCount || 0) - (a.totalAdsCount || 0);
      return (b.activeAdsCount || 0) - (a.activeAdsCount || 0);
    });
  }, [brands, searchTerm, sort]);

  const handleScrapeAll = async () => {
    setScrapingAll(true);
    try {
      await fetch(`${apiBaseUrl}/brands/scrape-all`, { method: 'POST' });
      setTimeout(fetchBrands, 2000);
    } finally { setScrapingAll(false); }
  };

  const handleDelete = async (id) => {
    if (!confirm('Stop tracking this brand?')) return;
    await fetch(`${apiBaseUrl}/brands/${id}`, { method: 'DELETE' });
    fetchBrands();
  };

  const handleScrapeOne = async (id) => {
    await fetch(`${apiBaseUrl}/brands/${id}/scrape`, { method: 'POST' });
    fetchBrands();
  };

  return (
    <div className="space-y-5">
      {/* Header */}
      <div className="flex items-start justify-between">
        <div>
          <h1 className="text-xl font-semibold text-white">Brand Spy</h1>
          <p className="text-sm text-text-muted mt-0.5">
            {brands.length} brands &middot; {stats.totalPages} pages &middot; {fmtCount(stats.activeAds)} active ads
          </p>
        </div>
        <div className="flex items-center gap-2">
          <button
            onClick={handleScrapeAll}
            disabled={scrapingAll || brands.length === 0}
            className="flex items-center gap-1.5 px-3 py-1.5 text-sm rounded-lg bg-bg-elevated border border-border-default hover:bg-bg-hover disabled:opacity-40 text-text-primary transition-colors"
          >
            <RefreshCw className={`w-3.5 h-3.5 ${scrapingAll ? 'animate-spin' : ''}`} />
            Scrape All
          </button>
          <button
            onClick={() => setShowFollowModal(true)}
            className="flex items-center gap-1.5 px-3 py-1.5 text-sm rounded-lg bg-accent text-white hover:bg-accent/90 transition-colors"
          >
            <Plus className="w-3.5 h-3.5" />
            Follow Brand
          </button>
        </div>
      </div>

      {/* Follow modal */}
      {showFollowModal && (
        <FollowPanel
          apiBaseUrl={apiBaseUrl}
          onClose={() => setShowFollowModal(false)}
          onAdded={() => { setShowFollowModal(false); fetchBrands(); }}
        />
      )}

      {/* Search + sort */}
      {!showFollowModal && (
        <div className="flex items-center gap-3">
          <div className="relative flex-1 max-w-md">
            <Search className="absolute left-3 top-1/2 -translate-y-1/2 w-3.5 h-3.5 text-text-faint" />
            <input
              type="text"
              value={searchTerm}
              onChange={e => setSearchTerm(e.target.value)}
              placeholder="Search by domain or page name..."
              className="w-full pl-9 pr-3 py-2 text-sm bg-bg-elevated border border-border-default rounded-lg text-text-primary placeholder:text-text-faint focus:outline-none focus:border-accent transition-colors"
            />
          </div>
          <select
            value={sort}
            onChange={e => setSort(e.target.value)}
            className="text-xs bg-bg-elevated border border-border-default rounded-lg px-2.5 py-2 text-text-muted focus:outline-none cursor-pointer"
          >
            <option value="active_desc">↓ Active ads</option>
            <option value="active_asc">↑ Active ads</option>
            <option value="total_desc">↓ Total ads</option>
          </select>
        </div>
      )}

      {/* Brand list */}
      {loading ? (
        <div className="flex items-center justify-center py-20 text-text-faint text-sm">Loading...</div>
      ) : error ? (
        <div className="flex items-center justify-center py-20 text-red-400 text-sm">{error}</div>
      ) : visible.length === 0 ? (
        <div className="flex flex-col items-center justify-center py-20 text-text-faint">
          <p className="text-sm">{brands.length === 0 ? 'No brands followed yet.' : 'No matches.'}</p>
          {brands.length === 0 && (
            <button
              onClick={() => setShowFollowModal(true)}
              className="mt-3 text-sm text-accent hover:underline"
            >
              + Follow your first brand
            </button>
          )}
        </div>
      ) : (
        <div className="space-y-1.5">
          {visible.map(brand => (
            <BrandRow
              key={brand.id}
              brand={brand}
              apiBaseUrl={apiBaseUrl}
              onOpen={onBrandClick ? () => onBrandClick(brand.id) : null}
              onScrape={() => handleScrapeOne(brand.id)}
              onDelete={() => handleDelete(brand.id)}
            />
          ))}
        </div>
      )}
    </div>
  );
}

function BrandRow({ brand, apiBaseUrl, onOpen, onScrape, onDelete }) {
  const [expanded, setExpanded] = useState(false);
  const [details, setDetails] = useState(null);
  const [loadingDetails, setLoadingDetails] = useState(false);
  const [scraping, setScraping] = useState(false);

  const handleExpand = async () => {
    const next = !expanded;
    setExpanded(next);
    if (next && !details) {
      setLoadingDetails(true);
      try {
        const res = await fetch(`${apiBaseUrl}/brands/${brand.id}`);
        const data = await res.json();
        setDetails(data.brand);
      } finally { setLoadingDetails(false); }
    }
  };

  const handleScrape = async (e) => {
    e.stopPropagation();
    setScraping(true);
    try { await onScrape(); } finally { setScraping(false); }
  };

  const t = brand.tierBreakdown || {};

  return (
    <div className="bg-bg-card border border-border-subtle rounded-xl overflow-hidden hover:border-border-default transition-colors">
      <div className="flex items-center gap-3 px-4 py-3">
        {/* Avatar */}
        <div className="relative w-8 h-8 rounded-lg bg-bg-elevated border border-border-default flex items-center justify-center text-xs font-bold text-text-muted shrink-0">
          {brand.domain.charAt(0).toUpperCase()}
          <span className={`absolute -top-0.5 -right-0.5 w-2 h-2 rounded-full ring-2 ring-bg-card ${
            brand.status === 'ACTIVE' ? 'bg-emerald-400' :
            brand.status === 'NOISY' ? 'bg-amber-400' : 'bg-zinc-600'
          }`} />
        </div>

        {/* Domain */}
        <div className="flex-1 min-w-0">
          <div className="flex items-center gap-1.5">
            {onOpen ? (
              <button onClick={onOpen} className="text-sm font-medium text-text-primary hover:text-accent transition-colors truncate">
                {brand.domain}
              </button>
            ) : (
              <span className="text-sm font-medium text-text-primary truncate">{brand.domain}</span>
            )}
            <a href={`https://${brand.domain}`} target="_blank" rel="noreferrer" onClick={e => e.stopPropagation()} className="text-text-faint hover:text-text-muted shrink-0">
              <ExternalLink className="w-3 h-3" />
            </a>
          </div>
          <p className="text-xs text-text-faint">{brand.pagesCount} pages</p>
        </div>

        {/* Tier chips */}
        <div className="hidden sm:flex items-center gap-1">
          {t.banger > 0 && <TierChip label={`🔥 ${t.banger}`} cls="bg-rose-500/10 text-rose-400 border-rose-500/20" />}
          {t.champ != null && <TierChip label={`🏆 ${t.champ}`} cls="bg-amber-500/10 text-amber-400 border-amber-500/20" />}
          {t.a != null && <TierChip label={`A ${t.a}`} cls="bg-emerald-500/10 text-emerald-400 border-emerald-500/20" />}
          {t.b != null && <TierChip label={`B ${t.b}`} cls="bg-sky-500/10 text-sky-400 border-sky-500/20" />}
          {t.c != null && <span className="text-[10px] text-text-faint px-1">C {t.c}</span>}
        </div>

        {/* Counts */}
        <div className="text-right shrink-0">
          <p className="text-sm font-semibold text-text-primary tabular-nums">{fmtCount(brand.totalAdsCount)}</p>
          <p className="text-xs text-emerald-400 tabular-nums">{fmtCount(brand.activeAdsCount)} active</p>
          <p className="text-[10px] text-text-faint">{relTime(brand.lastScrapedAt)}</p>
        </div>

        {/* Actions */}
        <div className="flex items-center gap-0.5 shrink-0">
          <button onClick={handleScrape} disabled={scraping} className="p-1.5 rounded-md text-text-faint hover:text-text-primary hover:bg-bg-hover disabled:opacity-40 transition-colors" title="Refresh">
            <RefreshCw className={`w-3.5 h-3.5 ${scraping ? 'animate-spin' : ''}`} />
          </button>
          <button onClick={e => { e.stopPropagation(); onDelete(); }} className="p-1.5 rounded-md text-text-faint hover:text-red-400 hover:bg-bg-hover transition-colors" title="Stop tracking">
            <X className="w-3.5 h-3.5" />
          </button>
          {onOpen && (
            <button onClick={e => { e.stopPropagation(); onOpen(); }} className="p-1.5 rounded-md text-text-faint hover:text-text-primary hover:bg-bg-hover transition-colors" title="Open detail">
              <ChevronRight className="w-3.5 h-3.5" />
            </button>
          )}
          <button onClick={handleExpand} className="p-1.5 rounded-md text-text-faint hover:text-text-primary hover:bg-bg-hover transition-colors" title={expanded ? 'Collapse' : 'Expand'}>
            <ChevronDown className={`w-3.5 h-3.5 transition-transform ${expanded ? 'rotate-180' : ''}`} />
          </button>
        </div>
      </div>

      {/* Expanded */}
      {expanded && (
        <div className="border-t border-border-subtle bg-bg-main px-4 py-3 space-y-3">
          {loadingDetails ? (
            <p className="text-xs text-text-faint">Loading...</p>
          ) : !details ? (
            <p className="text-xs text-text-faint">Failed to load details.</p>
          ) : (
            <>
              {details.pages?.length > 0 && (
                <div>
                  <p className="text-[10px] uppercase tracking-wider text-text-faint mb-2">Tracked Pages</p>
                  <div className="space-y-1">
                    {details.pages.map(p => (
                      <div key={p.id} className="flex items-center gap-3 text-xs py-0.5">
                        <span className="flex-1 text-text-primary truncate">{p.pageName}</span>
                        <span className="text-text-faint font-mono text-[10px] hidden md:block">{p.metaPageId}</span>
                        <span className="text-text-faint tabular-nums">{fmtCount(p.totalAdsCount)}</span>
                        <span className="text-emerald-400 tabular-nums w-16 text-right">● {fmtCount(p.activeAdsCount)}</span>
                      </div>
                    ))}
                  </div>
                </div>
              )}
              {details.domains?.length > 0 && (
                <div>
                  <p className="text-[10px] uppercase tracking-wider text-text-faint mb-2">Advertised Domains</p>
                  <div className="space-y-1">
                    {details.domains.map(d => (
                      <div key={d.id} className="flex items-center gap-3 text-xs py-0.5">
                        <a href={`https://${d.domain}`} target="_blank" rel="noreferrer" className="flex-1 text-amber-400/80 hover:text-amber-300 truncate">{d.domain}</a>
                        {d.isPrimary && <span className="text-[9px] px-1.5 py-0.5 bg-bg-elevated text-text-faint rounded border border-border-subtle">primary</span>}
                        <span className="text-text-faint tabular-nums">{fmtCount(d.totalAdsCount)}</span>
                        <span className="text-emerald-400 tabular-nums w-16 text-right">● {fmtCount(d.activeAdsCount)}</span>
                      </div>
                    ))}
                  </div>
                </div>
              )}
            </>
          )}
        </div>
      )}
    </div>
  );
}

function TierChip({ label, cls }) {
  return (
    <span className={`text-[10px] font-medium px-1.5 py-0.5 rounded border ${cls}`}>{label}</span>
  );
}

function FollowPanel({ apiBaseUrl, onClose, onAdded }) {
  const [mode, setMode] = useState('single');
  const [value, setValue] = useState('');
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState(null);

  const submit = async () => {
    setError(null);
    setSubmitting(true);
    try {
      const body = mode === 'single'
        ? { domain: value.trim() }
        : { bulk: value.split(/[\n,]/).map(s => s.trim()).filter(Boolean).map(domain => ({ domain })) };
      const res = await fetch(`${apiBaseUrl}/brands`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      });
      if (!res.ok) {
        const err = await res.json().catch(() => ({}));
        throw new Error(err.error || `Request failed (${res.status})`);
      }
      onAdded();
    } catch (e) {
      setError(e.message);
    } finally { setSubmitting(false); }
  };

  return (
    <div className="bg-bg-elevated border border-border-default rounded-xl p-4">
      <div className="flex items-center justify-between mb-3">
        <div className="flex bg-bg-card rounded-lg p-0.5 border border-border-subtle gap-0.5">
          {['single', 'bulk'].map(m => (
            <button
              key={m}
              onClick={() => setMode(m)}
              className={`px-3 py-1 text-xs rounded-md capitalize transition-colors ${
                mode === m ? 'bg-accent text-white' : 'text-text-muted hover:text-text-primary'
              }`}
            >
              {m}
            </button>
          ))}
        </div>
        <button onClick={onClose} className="p-1 rounded-md text-text-faint hover:text-text-primary hover:bg-bg-hover transition-colors">
          <X className="w-4 h-4" />
        </button>
      </div>
      <div className="flex gap-2">
        {mode === 'single' ? (
          <input
            autoFocus
            type="text"
            value={value}
            onChange={e => setValue(e.target.value)}
            onKeyDown={e => e.key === 'Enter' && value.trim() && submit()}
            placeholder="e.g. im8health.com or facebook.com/im8health"
            className="flex-1 px-3 py-2 text-sm bg-bg-card border border-border-default rounded-lg text-text-primary placeholder:text-text-faint focus:outline-none focus:border-accent transition-colors"
          />
        ) : (
          <textarea
            autoFocus
            value={value}
            onChange={e => setValue(e.target.value)}
            placeholder="One per line: domain or Facebook page URL"
            rows={3}
            className="flex-1 px-3 py-2 text-sm bg-bg-card border border-border-default rounded-lg text-text-primary placeholder:text-text-faint focus:outline-none focus:border-accent transition-colors resize-none"
          />
        )}
        <button
          onClick={submit}
          disabled={submitting || !value.trim()}
          className="px-4 py-2 text-sm bg-accent text-white rounded-lg disabled:opacity-40 hover:bg-accent/90 self-start transition-colors"
        >
          {submitting ? 'Adding...' : 'Add'}
        </button>
      </div>
      <p className="text-xs text-text-faint mt-2">Paste a domain, Facebook page URL, or Ad Library link.</p>
      {error && <p className="text-xs text-red-400 mt-1.5">{error}</p>}
    </div>
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
