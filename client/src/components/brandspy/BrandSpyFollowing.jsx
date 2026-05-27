import { useEffect, useMemo, useState, useCallback } from 'react';
import { Search, RefreshCw, Plus, X, ChevronRight } from 'lucide-react';

export default function BrandSpyFollowing({ apiBaseUrl, onBrandClick }) {
  const [brands, setBrands] = useState([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);
  const [searchTerm, setSearchTerm] = useState('');
  const [sort, setSort] = useState('active_desc');
  const [showFollowPanel, setShowFollowPanel] = useState(false);
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

  const stats = useMemo(() => {
    const totalAds = brands.reduce((s, b) => s + (b.totalAdsCount || 0), 0);
    const activeAds = brands.reduce((s, b) => s + (b.activeAdsCount || 0), 0);
    const totalPages = brands.reduce((s, b) => s + (b.pagesCount || 0), 0);
    const lastScraped = brands.reduce((latest, b) => {
      if (!b.lastScrapedAt) return latest;
      if (!latest) return b.lastScrapedAt;
      return new Date(b.lastScrapedAt) > new Date(latest) ? b.lastScrapedAt : latest;
    }, null);
    return { totalAds, activeAds, totalPages, lastScraped };
  }, [brands]);

  const visible = useMemo(() => {
    const q = searchTerm.trim().toLowerCase();
    const filtered = q
      ? brands.filter(b => b.domain.toLowerCase().includes(q) || b.displayName?.toLowerCase().includes(q))
      : brands;
    return [...filtered].sort((a, b) => {
      if (sort === 'active_asc') return (a.activeAdsCount || 0) - (b.activeAdsCount || 0);
      if (sort === 'total_desc') return (b.totalAdsCount || 0) - (a.totalAdsCount || 0);
      if (sort === 'total_asc') return (a.totalAdsCount || 0) - (b.totalAdsCount || 0);
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
    try {
      const res = await fetch(`${apiBaseUrl}/brands/${id}`, { method: 'DELETE' });
      if (!res.ok && res.status !== 404) throw new Error(`Delete failed (${res.status})`);
    } catch (e) {
      setError(e.message);
    }
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
          <h1 className="text-2xl font-semibold text-white">Following</h1>
          <p className="text-sm text-text-muted mt-0.5">
            {brands.length} brands across {stats.totalPages} tracked pages
          </p>
        </div>
        <div className="flex items-center gap-2">
          <button
            onClick={handleScrapeAll}
            disabled={scrapingAll || brands.length === 0}
            className="flex items-center gap-1.5 px-3 py-2 text-sm rounded-lg bg-bg-elevated border border-border-default hover:bg-bg-hover disabled:opacity-40 text-text-primary transition-colors"
          >
            <RefreshCw className={`w-4 h-4 ${scrapingAll ? 'animate-spin' : ''}`} />
            Scrape All
          </button>
          <button
            onClick={() => setShowFollowPanel(p => !p)}
            className="flex items-center gap-1.5 px-3 py-2 text-sm rounded-lg bg-accent text-white hover:bg-accent/90 transition-colors"
          >
            <Plus className="w-4 h-4" />
            Follow Brand
          </button>
        </div>
      </div>

      {/* Stats strip */}
      {brands.length > 0 && (
        <div className="flex items-center gap-5 text-sm">
          <span className="flex items-center gap-1.5 text-text-muted">
            <svg className="w-4 h-4 text-text-faint" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={1.5}>
              <path strokeLinecap="round" strokeLinejoin="round" d="M9 12h3.75M9 15h3.75M9 18h3.75m3 .75H18a2.25 2.25 0 002.25-2.25V6.108c0-1.135-.845-2.098-1.976-2.192a48.424 48.424 0 00-1.123-.08m-5.801 0c-.065.21-.1.433-.1.664 0 .414.336.75.75.75h4.5a.75.75 0 00.75-.75 2.25 2.25 0 00-.1-.664m-5.8 0A2.251 2.251 0 0113.5 2.25H15c1.012 0 1.867.668 2.15 1.586m-5.8 0c-.376.023-.75.05-1.124.08C9.095 4.01 8.25 4.973 8.25 6.108V8.25m0 0H4.875c-.621 0-1.125.504-1.125 1.125v11.25c0 .621.504 1.125 1.125 1.125h9.75c.621 0 1.125-.504 1.125-1.125V9.375c0-.621-.504-1.125-1.125-1.125H8.25zM6.75 12h.008v.008H6.75V12zm0 3h.008v.008H6.75V15zm0 3h.008v.008H6.75V18z" />
            </svg>
            <span className="font-semibold text-text-primary">{fmtCount(stats.totalAds)}</span> ads
          </span>
          <span className="flex items-center gap-1.5 text-text-muted">
            <svg className="w-4 h-4 text-emerald-400" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={1.5}>
              <path strokeLinecap="round" strokeLinejoin="round" d="M3.75 13.5l10.5-11.25L12 10.5h8.25L9.75 21.75 12 13.5H3.75z" />
            </svg>
            <span className="font-semibold text-emerald-400">{fmtCount(stats.activeAds)}</span> active
          </span>
          {stats.lastScraped && (
            <span className="flex items-center gap-1.5 text-text-muted">
              <svg className="w-4 h-4 text-text-faint" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={1.5}>
                <path strokeLinecap="round" strokeLinejoin="round" d="M12 6v6h4.5m4.5 0a9 9 0 11-18 0 9 9 0 0118 0z" />
              </svg>
              Last scraped <span className="text-text-primary">{fmtDate(stats.lastScraped)}</span>
            </span>
          )}
        </div>
      )}

      {/* Follow panel */}
      {showFollowPanel && (
        <FollowPanel
          apiBaseUrl={apiBaseUrl}
          onClose={() => setShowFollowPanel(false)}
          onAdded={() => { setShowFollowPanel(false); fetchBrands(); }}
        />
      )}

      {/* Search + sort pills */}
      <div className="flex items-center gap-3">
        <div className="relative flex-1">
          <Search className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-text-faint" />
          <input
            type="text"
            value={searchTerm}
            onChange={e => setSearchTerm(e.target.value)}
            placeholder="Search by domain or page name..."
            className="w-full pl-10 pr-3 py-2 text-sm bg-bg-elevated border border-border-default rounded-lg text-text-primary placeholder:text-text-faint focus:outline-none focus:border-accent transition-colors"
          />
        </div>
        <div className="flex items-center gap-1 shrink-0">
          {[
            { val: 'active_desc', label: '↓ Active' },
            { val: 'active_asc', label: '↑ Active' },
            { val: 'total_desc', label: '↓ Total' },
            { val: 'total_asc', label: '↑ Total' },
          ].map(s => (
            <button
              key={s.val}
              onClick={() => setSort(s.val)}
              className={`px-2.5 py-1.5 text-xs rounded-lg border font-medium transition-colors ${
                sort === s.val
                  ? 'bg-accent/20 text-accent border-accent/40'
                  : 'bg-bg-elevated text-text-muted border-border-default hover:text-text-primary hover:border-border-hover'
              }`}
            >
              {s.label}
            </button>
          ))}
        </div>
      </div>

      {/* Brand list */}
      {loading ? (
        <div className="flex items-center justify-center py-20 text-text-faint text-sm">Loading...</div>
      ) : error ? (
        <div className="flex items-center justify-center py-20 text-red-400 text-sm">{error}</div>
      ) : visible.length === 0 ? (
        <div className="flex flex-col items-center justify-center py-20 text-text-faint">
          <p className="text-sm">{brands.length === 0 ? 'No brands followed yet.' : 'No matches.'}</p>
          {brands.length === 0 && (
            <button onClick={() => setShowFollowPanel(true)} className="mt-3 text-sm text-accent hover:underline">
              + Follow your first brand
            </button>
          )}
        </div>
      ) : (
        <div className="space-y-1">
          {visible.map(brand => (
            <BrandRow
              key={brand.id}
              brand={brand}
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

function BrandRow({ brand, onOpen, onScrape, onDelete }) {
  const [scraping, setScraping] = useState(false);
  const t = brand.tierBreakdown || {};

  const handleScrape = async (e) => {
    e.stopPropagation();
    setScraping(true);
    try { await onScrape(); } finally { setScraping(false); }
  };

  return (
    <div className="flex items-center gap-3 px-4 py-3 bg-bg-card border border-border-subtle rounded-xl hover:border-border-default transition-colors group">
      {/* Avatar: Clearbit logo → Google favicon → letter fallback */}
      <div className="relative w-9 h-9 rounded-lg bg-bg-elevated border border-border-default flex items-center justify-center shrink-0 overflow-hidden">
        <span className="text-xs font-bold text-text-muted select-none">
          {brand.domain.charAt(0).toUpperCase()}
        </span>
        <BrandLogo domain={brand.domain} />
        <span className={`absolute -top-0.5 -right-0.5 w-2 h-2 rounded-full ring-2 ring-bg-card ${
          brand.status === 'ACTIVE' ? 'bg-emerald-400' :
          brand.status === 'NOISY' ? 'bg-amber-400' : 'bg-zinc-600'
        }`} />
      </div>

      {/* Domain + pages */}
      <div className="flex-1 min-w-0">
        <div className="flex items-center gap-1.5">
          {onOpen ? (
            <button onClick={onOpen} className="text-sm font-medium text-text-primary hover:text-accent transition-colors truncate">
              {brand.domain}
            </button>
          ) : (
            <span className="text-sm font-medium text-text-primary truncate">{brand.domain}</span>
          )}
          <a
            href={`https://${brand.domain}`}
            target="_blank"
            rel="noreferrer"
            onClick={e => e.stopPropagation()}
            className="text-text-faint hover:text-text-muted shrink-0"
          >
            <svg className="w-3 h-3" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
              <path strokeLinecap="round" strokeLinejoin="round" d="M10 6H6a2 2 0 00-2 2v10a2 2 0 002 2h10a2 2 0 002-2v-4M14 4h6m0 0v6m0-6L10 14" />
            </svg>
          </a>
        </div>
        <p className="text-xs text-text-faint">{brand.pagesCount} pages</p>
      </div>

      {/* Tier chips */}
      <div className="hidden sm:flex items-center gap-1">
        {t.banger > 0 && <TierChip label={`🔥 ${t.banger}`} cls="bg-rose-500/10 text-rose-400 border-rose-500/20" />}
        {t.champ > 0 && <TierChip label={`🏆 ${t.champ}`} cls="bg-amber-500/10 text-amber-400 border-amber-500/20" />}
        {t.a > 0 && <TierChip label={`A ${t.a}`} cls="bg-emerald-500/10 text-emerald-400 border-emerald-500/20" />}
        {t.b > 0 && <TierChip label={`B ${t.b}`} cls="bg-sky-500/10 text-sky-400 border-sky-500/20" />}
        {t.c > 0 && <TierChip label={`C ${t.c}`} cls="bg-zinc-700/40 text-zinc-400 border-zinc-700" />}
      </div>

      {/* Counts */}
      <div className="text-right shrink-0 min-w-[72px]">
        <p className="text-sm font-semibold text-text-primary tabular-nums">{fmtCount(brand.totalAdsCount)}</p>
        <p className="text-xs text-emerald-400 tabular-nums">{fmtCount(brand.activeAdsCount)} active</p>
        <p className="text-[10px] text-text-faint">{relTime(brand.lastScrapedAt)}</p>
      </div>

      {/* Actions — visible on hover */}
      <div className="flex items-center gap-0.5 shrink-0 opacity-0 group-hover:opacity-100 transition-opacity">
        <button
          onClick={handleScrape}
          disabled={scraping}
          title="Refresh"
          className="p-1.5 rounded-md text-text-faint hover:text-text-primary hover:bg-bg-hover disabled:opacity-40 transition-colors"
        >
          <RefreshCw className={`w-3.5 h-3.5 ${scraping ? 'animate-spin' : ''}`} />
        </button>
        <button
          onClick={e => { e.stopPropagation(); onDelete(); }}
          title="Stop tracking"
          className="p-1.5 rounded-md text-text-faint hover:text-red-400 hover:bg-bg-hover transition-colors"
        >
          <svg className="w-3.5 h-3.5" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
            <path strokeLinecap="round" strokeLinejoin="round" d="M19 7l-.867 12.142A2 2 0 0116.138 21H7.862a2 2 0 01-1.995-1.858L5 7m5 4v6m4-6v6m1-10V4a1 1 0 00-1-1h-4a1 1 0 00-1 1v3M4 7h16" />
          </svg>
        </button>
        {onOpen && (
          <button
            onClick={e => { e.stopPropagation(); onOpen(); }}
            title="View ads"
            className="p-1.5 rounded-md text-text-faint hover:text-text-primary hover:bg-bg-hover transition-colors"
          >
            <ChevronRight className="w-3.5 h-3.5" />
          </button>
        )}
      </div>
    </div>
  );
}

function BrandLogo({ domain }) {
  const [src, setSrc] = useState(`https://logo.clearbit.com/${domain}`);
  const [failed, setFailed] = useState(false);

  if (failed) return null;

  return (
    <img
      src={src}
      alt=""
      className="absolute inset-0 w-full h-full object-contain p-1"
      onError={() => {
        if (src.includes('clearbit')) {
          setSrc(`https://www.google.com/s2/favicons?domain=${domain}&sz=64`);
        } else {
          setFailed(true);
        }
      }}
    />
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
          {['Single', 'Bulk'].map(m => (
            <button
              key={m}
              onClick={() => setMode(m.toLowerCase())}
              className={`px-3 py-1 text-xs rounded-md transition-colors ${
                mode === m.toLowerCase() ? 'bg-accent text-white' : 'text-text-muted hover:text-text-primary'
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
            placeholder="Enter domain (e.g. nike.com) or Facebook page URL"
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
      <p className="text-xs text-text-faint mt-2">
        Paste a website domain, Facebook page URL, or Ad Library link. We'll find all associated pages automatically.
      </p>
      {error && <p className="text-xs text-red-400 mt-1.5">{error}</p>}
    </div>
  );
}

function fmtCount(n) {
  if (!n) return '0';
  if (n >= 1000) return `${(n / 1000).toFixed(n >= 10000 ? 0 : 1)}K`;
  return String(n);
}

function fmtDate(iso) {
  if (!iso) return '';
  return new Date(iso).toLocaleDateString('en-US', {
    month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit',
  });
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
