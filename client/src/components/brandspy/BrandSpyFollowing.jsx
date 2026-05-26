import { useEffect, useMemo, useState, useCallback } from 'react';

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
    lastScraped: brands.map(b => b.lastScrapedAt).filter(Boolean).sort().reverse()[0],
  }), [brands]);

  const visible = useMemo(() => {
    const q = searchTerm.trim().toLowerCase();
    const filtered = q ? brands.filter(b => b.domain.toLowerCase().includes(q) || b.displayName?.toLowerCase().includes(q)) : brands;
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
    <div className="space-y-6">
      {/* Header */}
      <div className="flex items-start justify-between">
        <div>
          <h1 className="text-xl font-bold text-text-primary">Brand Spy</h1>
          <p className="text-sm text-text-muted mt-1">
            {brands.length} brands &middot; {stats.totalPages} tracked pages &middot; {fmtCount(stats.activeAds)} active ads
          </p>
        </div>
        <div className="flex items-center gap-2">
          <button
            onClick={handleScrapeAll}
            disabled={scrapingAll || brands.length === 0}
            className="flex items-center gap-2 px-3 py-2 text-sm rounded-lg bg-bg-elevated border border-border-default hover:bg-bg-hover disabled:opacity-50 text-text-primary transition-colors cursor-pointer"
          >
            <span className={scrapingAll ? 'animate-spin inline-block' : ''}>&#8635;</span>
            Scrape All
          </button>
          <button
            onClick={() => setShowFollowModal(true)}
            className="flex items-center gap-2 px-3 py-2 text-sm rounded-lg bg-accent text-white hover:bg-accent/90 transition-colors cursor-pointer"
          >
            + Follow Brand
          </button>
        </div>
      </div>

      {/* Follow modal */}
      {showFollowModal && (
        <FollowPanel apiBaseUrl={apiBaseUrl} onClose={() => setShowFollowModal(false)} onAdded={() => { setShowFollowModal(false); fetchBrands(); }} />
      )}

      {/* Search + sort */}
      {!showFollowModal && (
        <div className="flex items-center gap-3">
          <div className="relative flex-1 max-w-lg">
            <span className="absolute left-3 top-1/2 -translate-y-1/2 text-text-faint text-sm">&#128269;</span>
            <input
              type="text"
              value={searchTerm}
              onChange={e => setSearchTerm(e.target.value)}
              placeholder="Search by domain or page name..."
              className="w-full pl-9 pr-4 py-2.5 text-sm bg-bg-elevated border border-border-default rounded-lg text-text-primary placeholder:text-text-faint focus:outline-none focus:border-accent transition-colors"
            />
          </div>
          <select
            value={sort}
            onChange={e => setSort(e.target.value)}
            className="text-xs bg-bg-elevated border border-border-default rounded-lg px-2 py-2 text-text-muted focus:outline-none"
          >
            <option value="active_desc">&darr; Active ads</option>
            <option value="active_asc">&uarr; Active ads</option>
            <option value="total_desc">&darr; Total ads</option>
          </select>
        </div>
      )}

      {/* Brand list */}
      {loading ? (
        <div className="text-text-faint text-sm py-12 text-center">Loading...</div>
      ) : error ? (
        <div className="text-red-400 text-sm py-12 text-center">{error}</div>
      ) : visible.length === 0 ? (
        <div className="text-text-faint text-sm py-12 text-center">
          {brands.length === 0 ? 'No brands followed yet. Click "+ Follow Brand" to start.' : 'No matches.'}
        </div>
      ) : (
        <div className="space-y-2">
          {visible.map(brand => (
            <BrandRow
              key={brand.id}
              brand={brand}
              apiBaseUrl={apiBaseUrl}
              onOpen={onBrandClick ? () => onBrandClick(brand.id) : undefined}
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

  const t = brand.tierBreakdown || {};

  return (
    <div className="bg-bg-card border border-border-subtle rounded-xl hover:border-border-default transition-colors">
      <div className="flex items-center gap-3 px-4 py-3">
        {/* Avatar */}
        <div className="relative w-9 h-9 rounded-lg bg-bg-elevated border border-border-default flex items-center justify-center text-sm font-bold text-text-muted shrink-0">
          {brand.domain.charAt(0).toUpperCase()}
          {brand.status === 'ACTIVE' && <span className="absolute -top-0.5 -right-0.5 w-2 h-2 bg-emerald-400 rounded-full ring-2 ring-bg-card" />}
          {brand.status === 'NOISY' && <span className="absolute -top-0.5 -right-0.5 w-2 h-2 bg-amber-400 rounded-full ring-2 ring-bg-card" />}
        </div>

        {/* Domain + pages */}
        <div className="flex-1 min-w-0">
          <div className="flex items-center gap-1.5">
            <button
              onClick={onOpen}
              className="text-sm font-medium text-text-primary hover:text-accent transition-colors truncate cursor-pointer"
            >
              {brand.domain}
            </button>
            <a href={`https://${brand.domain}`} target="_blank" rel="noreferrer" className="text-text-faint hover:text-text-muted" onClick={e => e.stopPropagation()}>
              <span className="text-xs">&#8599;</span>
            </a>
          </div>
          <div className="text-xs text-text-faint">{brand.pagesCount} pages</div>
        </div>

        {/* Tier chips */}
        <div className="flex items-center gap-1 text-[10px] font-medium">
          {t.banger > 0 && <span className="px-1.5 py-0.5 rounded border bg-rose-500/10 text-rose-400 border-rose-500/20">&#128293; {t.banger}</span>}
          {t.champ !== null && <span className="px-1.5 py-0.5 rounded border bg-amber-500/10 text-amber-400 border-amber-500/20">&#127942; {t.champ}</span>}
          {t.a !== null && <span className="px-1.5 py-0.5 rounded border bg-emerald-500/10 text-emerald-400 border-emerald-500/20">A {t.a}</span>}
          {t.b !== null && <span className="px-1.5 py-0.5 rounded border bg-sky-500/10 text-sky-400 border-sky-500/20">B {t.b}</span>}
          {t.c !== null && <span className="text-text-faint px-1">C {t.c}</span>}
        </div>

        {/* Counts */}
        <div className="text-right min-w-[80px]">
          <div className="text-sm font-semibold text-text-primary">{fmtCount(brand.totalAdsCount)}</div>
          <div className="text-xs text-emerald-400">{fmtCount(brand.activeAdsCount)} active</div>
          <div className="text-[10px] text-text-faint">{relTime(brand.lastScrapedAt)}</div>
        </div>

        {/* Actions */}
        <button onClick={e => { e.stopPropagation(); onScrape(); }} className="p-1.5 text-text-faint hover:text-text-primary transition-colors cursor-pointer" title="Refresh">
          <span className="text-xs">&#8635;</span>
        </button>
        <button onClick={e => { e.stopPropagation(); onDelete(); }} className="p-1.5 text-text-faint hover:text-red-400 transition-colors cursor-pointer" title="Stop tracking">
          <span className="text-xs">&#128465;</span>
        </button>
        {onOpen && (
          <button onClick={e => { e.stopPropagation(); onOpen(); }} className="p-1.5 text-text-faint hover:text-text-primary transition-colors cursor-pointer" title="Open detail">
            <span className="text-xs">&#8250;</span>
          </button>
        )}
        <button onClick={handleExpand} className="p-1.5 text-text-faint hover:text-text-primary transition-colors cursor-pointer" title={expanded ? 'Collapse' : 'Expand'}>
          <span className={`text-xs inline-block transition-transform ${expanded ? 'rotate-90' : ''}`}>&#8964;</span>
        </button>
      </div>

      {/* Expanded body */}
      {expanded && (
        <div className="border-t border-border-subtle px-4 py-3">
          {loadingDetails ? (
            <p className="text-xs text-text-faint">Loading...</p>
          ) : !details ? (
            <p className="text-xs text-text-faint">Failed to load details.</p>
          ) : (
            <div className="space-y-3">
              {details.pages?.length > 0 && (
                <div>
                  <p className="text-[10px] uppercase tracking-wider text-text-faint mb-1">Tracked Pages</p>
                  <div className="space-y-1">
                    {details.pages.map(p => (
                      <div key={p.id} className="flex items-center text-xs">
                        <span className="flex-1 text-text-primary">{p.pageName}</span>
                        <span className="text-text-faint font-mono text-[10px] mr-4">{p.metaPageId}</span>
                        <span className="text-text-faint">{fmtCount(p.totalAdsCount)}</span>
                        <span className="text-emerald-400 ml-2">&#9679; {fmtCount(p.activeAdsCount)}</span>
                      </div>
                    ))}
                  </div>
                </div>
              )}
              {details.domains?.length > 0 && (
                <div>
                  <p className="text-[10px] uppercase tracking-wider text-text-faint mb-1">&#127760; Advertised Domains</p>
                  <div className="space-y-1">
                    {details.domains.map(d => (
                      <div key={d.id} className="flex items-center text-xs">
                        <a href={`https://${d.domain}`} target="_blank" rel="noreferrer" className="flex-1 text-amber-400/80 hover:text-amber-300">{d.domain}</a>
                        {d.isPrimary && <span className="text-[9px] px-1.5 py-0.5 bg-bg-elevated text-text-faint rounded mr-2">primary</span>}
                        <span className="text-text-faint">{fmtCount(d.totalAdsCount)}</span>
                        <span className="text-emerald-400 ml-2">&#9679; {fmtCount(d.activeAdsCount)}</span>
                      </div>
                    ))}
                  </div>
                </div>
              )}
            </div>
          )}
        </div>
      )}
    </div>
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
        ? { domain: value }
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
    <div className="p-4 bg-bg-elevated border border-border-default rounded-xl">
      <div className="flex items-center justify-between mb-3">
        <div className="flex bg-bg-card rounded-lg p-0.5 border border-border-subtle">
          {['single', 'bulk'].map(m => (
            <button key={m} onClick={() => setMode(m)}
              className={`px-3 py-1 text-xs rounded-md transition-colors cursor-pointer capitalize ${mode === m ? 'bg-accent text-white' : 'text-text-muted hover:text-text-primary'}`}>
              {m}
            </button>
          ))}
        </div>
        <button onClick={onClose} className="text-text-faint hover:text-text-primary text-sm cursor-pointer">&#10005;</button>
      </div>
      <div className="flex gap-2">
        {mode === 'single' ? (
          <input
            autoFocus
            type="text"
            value={value}
            onChange={e => setValue(e.target.value)}
            onKeyDown={e => e.key === 'Enter' && value.trim() && submit()}
            placeholder="Enter domain (e.g. im8health.com) or Facebook page URL"
            className="flex-1 px-3 py-2 text-sm bg-bg-card border border-border-default rounded-lg text-text-primary placeholder:text-text-faint focus:outline-none focus:border-accent"
          />
        ) : (
          <textarea
            autoFocus
            value={value}
            onChange={e => setValue(e.target.value)}
            placeholder="One per line: domain or Facebook page URL"
            rows={4}
            className="flex-1 px-3 py-2 text-sm bg-bg-card border border-border-default rounded-lg text-text-primary placeholder:text-text-faint focus:outline-none focus:border-accent resize-none"
          />
        )}
        <button
          onClick={submit}
          disabled={submitting || !value.trim()}
          className="px-4 py-2 text-sm bg-accent text-white rounded-lg disabled:opacity-50 hover:bg-accent/90 self-start cursor-pointer"
        >
          {submitting ? 'Adding...' : 'Add'}
        </button>
      </div>
      <p className="text-xs text-text-faint mt-2">Paste a domain, Facebook page URL, or Ad Library link. We'll find all associated pages automatically.</p>
      {error && <p className="text-xs text-red-400 mt-2">{error}</p>}
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
