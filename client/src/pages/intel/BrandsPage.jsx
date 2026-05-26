import { useEffect, useMemo, useState, useCallback } from 'react';
import { useNavigate } from 'react-router-dom';

const API = '/api/v1/brand-spy';

export default function BrandsPage() {
  const navigate = useNavigate();
  const [brands, setBrands] = useState([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);
  const [searchTerm, setSearchTerm] = useState('');
  const [sortKey, setSortKey] = useState('active_desc');
  const [showFollowModal, setShowFollowModal] = useState(false);
  const [scrapingAll, setScrapingAll] = useState(false);

  const fetchBrands = useCallback(async () => {
    try {
      const res = await fetch(`${API}/brands`);
      if (!res.ok) throw new Error(`Failed to load (${res.status})`);
      const data = await res.json();
      setBrands(data.brands);
      setError(null);
    } catch (e) {
      setError(e.message || 'Unknown error');
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => { fetchBrands(); }, [fetchBrands]);

  const stats = useMemo(() => {
    const totalAds  = brands.reduce((s, b) => s + b.totalAdsCount, 0);
    const activeAds = brands.reduce((s, b) => s + b.activeAdsCount, 0);
    const totalPages = brands.reduce((s, b) => s + b.pagesCount, 0);
    const lastScraped = brands
      .map((b) => b.lastScrapedAt)
      .filter(Boolean)
      .sort()
      .reverse()[0];
    return { totalAds, activeAds, totalPages, lastScraped };
  }, [brands]);

  const visible = useMemo(() => {
    const q = searchTerm.trim().toLowerCase();
    const filtered = q
      ? brands.filter((b) => b.domain.toLowerCase().includes(q) || b.displayName?.toLowerCase().includes(q))
      : brands;
    const sorted = [...filtered];
    sorted.sort((a, b) => {
      switch (sortKey) {
        case 'active_asc':  return a.activeAdsCount - b.activeAdsCount;
        case 'total_desc':  return b.totalAdsCount - a.totalAdsCount;
        case 'total_asc':   return a.totalAdsCount - b.totalAdsCount;
        default:            return b.activeAdsCount - a.activeAdsCount;
      }
    });
    return sorted;
  }, [brands, searchTerm, sortKey]);

  const handleScrapeAll = async () => {
    setScrapingAll(true);
    try {
      await fetch(`${API}/brands/scrape-all`, { method: 'POST' });
      setTimeout(fetchBrands, 1500);
    } finally {
      setScrapingAll(false);
    }
  };

  const handleScrapeOne = async (brandId) => {
    await fetch(`${API}/brands/${brandId}/scrape`, { method: 'POST' });
    fetchBrands();
  };

  const handleDelete = async (brandId) => {
    if (!confirm('Stop tracking this brand?')) return;
    await fetch(`${API}/brands/${brandId}`, { method: 'DELETE' });
    fetchBrands();
  };

  return (
    <div className="min-h-screen text-zinc-100 p-6">
      <div className="max-w-7xl mx-auto">
        {/* Header */}
        <div className="flex items-start justify-between mb-6">
          <div>
            <h1 className="text-2xl font-semibold tracking-tight">Following</h1>
            <p className="text-text-muted text-sm mt-1">
              {brands.length} brands across {stats.totalPages} tracked pages
            </p>
          </div>
          <div className="flex items-center gap-2">
            <button
              onClick={handleScrapeAll}
              disabled={scrapingAll || brands.length === 0}
              className="px-4 py-2 text-sm rounded-md bg-bg-elevated border border-border-default hover:bg-bg-hover disabled:opacity-50 transition-colors flex items-center gap-2 cursor-pointer"
            >
              <RefreshIcon spinning={scrapingAll} />
              Scrape All
            </button>
            <button
              onClick={() => setShowFollowModal(true)}
              className="px-4 py-2 text-sm rounded-md bg-white text-black hover:bg-zinc-200 transition-colors flex items-center gap-2 font-medium cursor-pointer"
            >
              <PlusIcon />
              Follow Brand
            </button>
          </div>
        </div>

        {/* Stats strip */}
        <div className="flex items-center justify-between mb-4 text-sm">
          <div className="flex items-center gap-6 text-text-muted">
            <StatChip label="ads"    value={fmtCount(stats.totalAds)}  icon={<DbIcon />} />
            <StatChip label="active" value={fmtCount(stats.activeAds)} icon={<BoltIcon />} valueClassName="text-emerald-400" />
            <StatChip
              label={stats.lastScraped ? `Last scraped ${fmtDateTime(stats.lastScraped)}` : 'Never scraped'}
              value=""
              icon={<ClockIcon />}
            />
          </div>
          <SortControl value={sortKey} onChange={setSortKey} />
        </div>

        {/* Follow modal or search */}
        {showFollowModal ? (
          <FollowPanel
            onClose={() => setShowFollowModal(false)}
            onAdded={() => { setShowFollowModal(false); fetchBrands(); }}
          />
        ) : (
          <div className="relative mb-4">
            <SearchIcon className="absolute left-3 top-1/2 -translate-y-1/2 text-text-faint" />
            <input
              type="text"
              placeholder="Search by domain or page name..."
              value={searchTerm}
              onChange={(e) => setSearchTerm(e.target.value)}
              className="w-full pl-10 pr-4 py-3 bg-bg-elevated border border-border-default rounded-md text-sm placeholder-text-faint focus:outline-none focus:border-accent transition-colors"
            />
          </div>
        )}

        {/* Brand list */}
        {loading ? (
          <div className="text-text-muted text-sm py-12 text-center">Loading...</div>
        ) : error ? (
          <div className="text-rose-400 text-sm py-12 text-center">{error}</div>
        ) : visible.length === 0 ? (
          <div className="text-text-muted text-sm py-12 text-center">
            {brands.length === 0 ? 'No brands followed yet.' : 'No matches.'}
          </div>
        ) : (
          <div className="space-y-2">
            {visible.map((brand) => (
              <BrandRow
                key={brand.id}
                brand={brand}
                onScrape={() => handleScrapeOne(brand.id)}
                onDelete={() => handleDelete(brand.id)}
                onOpen={() => navigate(`/app/brands/${brand.id}`)}
              />
            ))}
          </div>
        )}
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Brand row
// ---------------------------------------------------------------------------

function BrandRow({ brand, onScrape, onDelete, onOpen }) {
  const [expanded, setExpanded] = useState(false);
  const [details, setDetails] = useState(null);
  const [loadingDetails, setLoadingDetails] = useState(false);

  const handleExpand = async () => {
    const next = !expanded;
    setExpanded(next);
    if (next && !details) {
      setLoadingDetails(true);
      try {
        const res = await fetch(`${API}/brands/${brand.id}`);
        const data = await res.json();
        setDetails(data.brand);
      } finally {
        setLoadingDetails(false);
      }
    }
  };

  return (
    <div className="bg-bg-card border border-border-subtle rounded-md hover:border-border-default transition-colors">
      <div className="flex items-center px-4 py-3 gap-3">
        <DragHandleIcon className="text-text-faint cursor-grab" />

        <div className="w-9 h-9 rounded-md bg-bg-elevated flex items-center justify-center text-xs font-medium text-text-muted relative">
          {brand.domain.charAt(0).toUpperCase()}
          {brand.status === 'ACTIVE' && (
            <span className="absolute top-0 right-0 w-2 h-2 bg-emerald-400 rounded-full ring-2 ring-bg-base" />
          )}
          {brand.status === 'NOISY' && (
            <span className="absolute top-0 right-0 w-2 h-2 bg-amber-400 rounded-full ring-2 ring-bg-base" />
          )}
        </div>

        <div className="flex-1 min-w-0">
          <div className="flex items-center gap-2">
            <a
              href={`https://${brand.domain}`}
              target="_blank"
              rel="noreferrer"
              className="text-sm font-medium text-text-primary hover:text-white truncate"
              onClick={(e) => e.stopPropagation()}
            >
              {brand.domain}
            </a>
            <ExternalIcon className="text-text-faint w-3 h-3" />
          </div>
          <div className="text-xs text-text-faint">{brand.pagesCount} pages</div>
        </div>

        {/* Tier chips */}
        <div className="flex items-center gap-1.5 text-[10px] font-medium">
          {brand.tierBreakdown.banger > 0 && (
            <TierChip label="" value={brand.tierBreakdown.banger} icon="🔥" color="rose" />
          )}
          {brand.tierBreakdown.champ !== null && (
            <TierChip label="" value={brand.tierBreakdown.champ} icon="🏆" color="amber" />
          )}
          {brand.tierBreakdown.a !== null && (
            <TierChip label="A" value={brand.tierBreakdown.a} color="emerald" />
          )}
          {brand.tierBreakdown.b !== null && (
            <TierChip label="B" value={brand.tierBreakdown.b} color="sky" />
          )}
          {brand.tierBreakdown.c !== null && (
            <span className="text-text-faint px-1.5">C {brand.tierBreakdown.c}</span>
          )}
        </div>

        {/* Counters */}
        <div className="text-right min-w-[80px]">
          <div className="text-sm font-semibold">{fmtCount(brand.totalAdsCount)}</div>
          <div className="text-xs text-emerald-400">{fmtCount(brand.activeAdsCount)} active</div>
          <div className="text-[10px] text-text-faint">{relTime(brand.lastScrapedAt)}</div>
        </div>

        {/* Actions */}
        <button
          onClick={(e) => { e.stopPropagation(); onScrape(); }}
          className="p-2 text-text-faint hover:text-text-primary transition-colors cursor-pointer"
          title="Refresh"
        >
          <RefreshIcon spinning={brand.lastScrapeStatus === 'RUNNING'} />
        </button>
        <button
          onClick={(e) => { e.stopPropagation(); onDelete(); }}
          className="p-2 text-text-faint hover:text-rose-400 transition-colors cursor-pointer"
          title="Stop tracking"
        >
          <TrashIcon />
        </button>
        <button
          onClick={(e) => { e.stopPropagation(); onOpen(); }}
          className="p-2 text-text-faint hover:text-text-primary transition-colors cursor-pointer"
          title="Open detail"
        >
          <ChevronIcon className="rotate-0" />
        </button>
        <button
          onClick={handleExpand}
          className="p-2 text-text-faint hover:text-text-primary transition-colors cursor-pointer"
          title={expanded ? 'Collapse' : 'Expand'}
        >
          <ChevronIcon className={expanded ? 'rotate-90' : 'rotate-180'} />
        </button>
      </div>

      {expanded && (
        <div className="border-t border-border-subtle px-4 py-3">
          {loadingDetails ? (
            <div className="text-xs text-text-faint py-4">Loading...</div>
          ) : !details ? (
            <div className="text-xs text-text-faint py-4">Failed to load details.</div>
          ) : (
            <>
              {details.pages.length > 0 && (
                <div className="mb-4">
                  <div className="text-[10px] uppercase tracking-wider text-text-faint mb-2">Tracked Pages</div>
                  <div className="space-y-1">
                    {details.pages.map((p) => (
                      <div key={p.id} className="flex items-center py-1.5 text-sm px-2 rounded hover:bg-bg-elevated">
                        <div className="flex-1 flex items-center gap-3">
                          <span className="text-text-primary">{p.pageName}</span>
                          <span className="text-[10px] text-text-faint font-mono">{p.metaPageId}</span>
                        </div>
                        <div className="flex items-center gap-3 text-xs">
                          <span className="text-text-muted">{fmtCount(p.totalAdsCount)}</span>
                          <span className="flex items-center gap-1 text-emerald-400">
                            <span className="w-1.5 h-1.5 bg-emerald-400 rounded-full" />
                            {fmtCount(p.activeAdsCount)}
                          </span>
                        </div>
                      </div>
                    ))}
                  </div>
                </div>
              )}
              {details.domains.length > 0 && (
                <div>
                  <div className="text-[10px] uppercase tracking-wider text-text-faint mb-2 flex items-center gap-1">
                    <GlobeIcon /> Advertised Domains
                  </div>
                  <div className="space-y-1">
                    {details.domains.map((d) => (
                      <div key={d.id} className="flex items-center py-1.5 text-sm px-2 rounded hover:bg-bg-elevated">
                        <div className="flex-1 flex items-center gap-2">
                          <a href={`https://${d.domain}`} target="_blank" rel="noreferrer" className="text-amber-300/80 hover:text-amber-300">
                            {d.domain}
                          </a>
                          {d.isPrimary && (
                            <span className="text-[9px] px-1.5 py-0.5 bg-bg-elevated text-text-faint rounded uppercase tracking-wide">
                              primary
                            </span>
                          )}
                        </div>
                        <div className="flex items-center gap-3 text-xs">
                          <span className="text-text-muted">{fmtCount(d.totalAdsCount)}</span>
                          <span className="flex items-center gap-1 text-emerald-400">
                            <span className="w-1.5 h-1.5 bg-emerald-400 rounded-full" />
                            {fmtCount(d.activeAdsCount)}
                          </span>
                        </div>
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

// ---------------------------------------------------------------------------
// Follow panel
// ---------------------------------------------------------------------------

function FollowPanel({ onClose, onAdded }) {
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
        : { bulk: value.split(/[\n,]/).map((s) => s.trim()).filter(Boolean).map((domain) => ({ domain })) };

      const res = await fetch(`${API}/brands`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      });
      if (!res.ok) {
        const err = await res.json().catch(() => ({}));
        throw new Error(err.error ?? `Request failed (${res.status})`);
      }
      onAdded();
    } catch (e) {
      setError(e.message || 'Unknown error');
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <div className="mb-4 p-4 bg-bg-elevated border border-border-default rounded-md">
      <div className="flex items-center justify-between mb-3">
        <div className="flex bg-bg-base rounded-md p-0.5 border border-border-default">
          {['single', 'bulk'].map((m) => (
            <button
              key={m}
              onClick={() => setMode(m)}
              className={`px-3 py-1 text-xs rounded capitalize cursor-pointer ${mode === m ? 'bg-white text-black' : 'text-text-muted'}`}
            >
              {m}
            </button>
          ))}
        </div>
        <button onClick={onClose} className="text-text-faint hover:text-text-primary cursor-pointer"><CloseIcon /></button>
      </div>
      <div className="flex gap-2">
        {mode === 'single' ? (
          <input
            type="text"
            value={value}
            onChange={(e) => setValue(e.target.value)}
            onKeyDown={(e) => e.key === 'Enter' && submit()}
            placeholder="Enter domain (e.g. nike.com) or Facebook page URL"
            className="flex-1 px-3 py-2 bg-bg-base border border-border-default rounded-md text-sm placeholder-text-faint focus:outline-none focus:border-accent"
            autoFocus
          />
        ) : (
          <textarea
            value={value}
            onChange={(e) => setValue(e.target.value)}
            placeholder="One per line: domain or Facebook page URL"
            rows={4}
            className="flex-1 px-3 py-2 bg-bg-base border border-border-default rounded-md text-sm placeholder-text-faint focus:outline-none focus:border-accent resize-none"
            autoFocus
          />
        )}
        <button
          onClick={submit}
          disabled={submitting || !value.trim()}
          className="px-4 py-2 bg-bg-hover hover:bg-border-default disabled:opacity-50 text-sm rounded-md self-start cursor-pointer"
        >
          {submitting ? 'Adding...' : 'Add'}
        </button>
      </div>
      <p className="text-xs text-text-faint mt-2">
        Paste a website domain, Facebook page URL, or Ad Library link. We'll find all associated pages automatically.
      </p>
      {error && <p className="text-xs text-rose-400 mt-2">{error}</p>}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Small components
// ---------------------------------------------------------------------------

function StatChip({ label, value, icon, valueClassName }) {
  return (
    <div className="flex items-center gap-1.5">
      <span className="text-text-faint">{icon}</span>
      {value && <span className={`font-medium text-text-primary ${valueClassName ?? ''}`}>{value}</span>}
      <span>{label}</span>
    </div>
  );
}

function SortControl({ value, onChange }) {
  const options = [
    { key: 'active_desc', label: 'Active', arrow: '↓' },
    { key: 'active_asc',  label: 'Active', arrow: '↑' },
    { key: 'total_desc',  label: 'Total',  arrow: '↓' },
    { key: 'total_asc',   label: 'Total',  arrow: '↑' },
  ];
  return (
    <div className="flex items-center gap-1 text-[11px]">
      {options.map((o) => (
        <button
          key={o.key}
          onClick={() => onChange(o.key)}
          className={`px-2 py-1 rounded transition-colors cursor-pointer ${
            value === o.key
              ? 'bg-amber-500/10 text-amber-400 border border-amber-500/20'
              : 'text-text-faint hover:text-text-muted'
          }`}
        >
          {o.arrow} {o.label}
        </button>
      ))}
    </div>
  );
}

function TierChip({ label, value, color, icon }) {
  const cls = {
    amber:   'bg-amber-500/10 text-amber-400 border-amber-500/20',
    emerald: 'bg-emerald-500/10 text-emerald-400 border-emerald-500/20',
    sky:     'bg-sky-500/10 text-sky-400 border-sky-500/20',
    rose:    'bg-rose-500/10 text-rose-400 border-rose-500/20',
  }[color];
  return (
    <span className={`px-1.5 py-0.5 rounded border ${cls}`}>
      {icon} {label} {value}
    </span>
  );
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function fmtCount(n) {
  if (n >= 1000) return `${(n / 1000).toFixed(n >= 10_000 ? 0 : 1)}K`;
  return String(n);
}

function relTime(iso) {
  if (!iso) return 'never';
  const diff = Date.now() - new Date(iso).getTime();
  const days = Math.floor(diff / (1000 * 60 * 60 * 24));
  if (days >= 1) return `✓ ${days}d ago`;
  const hours = Math.floor(diff / (1000 * 60 * 60));
  if (hours >= 1) return `✓ ${hours}h ago`;
  return `✓ ${Math.floor(diff / 60000)}m ago`;
}

function fmtDateTime(iso) {
  return new Date(iso).toLocaleString('en-US', { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' });
}

// ---------------------------------------------------------------------------
// Icons
// ---------------------------------------------------------------------------

const ip = { width: 14, height: 14, viewBox: '0 0 24 24', fill: 'none', stroke: 'currentColor', strokeWidth: 2, strokeLinecap: 'round', strokeLinejoin: 'round' };

function PlusIcon()    { return <svg {...ip}><line x1="12" y1="5" x2="12" y2="19"/><line x1="5" y1="12" x2="19" y2="12"/></svg>; }
function RefreshIcon({ spinning }) { return <svg {...ip} className={spinning ? 'animate-spin' : ''}><polyline points="23 4 23 10 17 10"/><polyline points="1 20 1 14 7 14"/><path d="M3.51 9a9 9 0 0 1 14.85-3.36L23 10M1 14l4.64 4.36A9 9 0 0 0 20.49 15"/></svg>; }
function TrashIcon()   { return <svg {...ip}><polyline points="3 6 5 6 21 6"/><path d="M19 6l-2 14a2 2 0 0 1-2 2H9a2 2 0 0 1-2-2L5 6m3 0V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2"/></svg>; }
function ChevronIcon({ className = '' }) { return <svg {...ip} className={`transition-transform ${className}`}><polyline points="9 18 15 12 9 6"/></svg>; }
function DragHandleIcon({ className = '' }) { return <svg width={10} height={14} viewBox="0 0 10 14" fill="currentColor" className={className}><circle cx="2" cy="3" r="1.2"/><circle cx="8" cy="3" r="1.2"/><circle cx="2" cy="7" r="1.2"/><circle cx="8" cy="7" r="1.2"/><circle cx="2" cy="11" r="1.2"/><circle cx="8" cy="11" r="1.2"/></svg>; }
function ExternalIcon({ className = '' }) { return <svg {...ip} className={className}><path d="M18 13v6a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h6"/><polyline points="15 3 21 3 21 9"/><line x1="10" y1="14" x2="21" y2="3"/></svg>; }
function SearchIcon({ className = '' }) { return <svg {...ip} className={className}><circle cx="11" cy="11" r="8"/><line x1="21" y1="21" x2="16.65" y2="16.65"/></svg>; }
function CloseIcon()   { return <svg {...ip}><line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/></svg>; }
function DbIcon()      { return <svg {...ip}><ellipse cx="12" cy="5" rx="9" ry="3"/><path d="M21 12c0 1.66-4 3-9 3s-9-1.34-9-3"/><path d="M3 5v14c0 1.66 4 3 9 3s9-1.34 9-3V5"/></svg>; }
function BoltIcon()    { return <svg {...ip} fill="currentColor"><polygon points="13 2 3 14 12 14 11 22 21 10 12 10 13 2"/></svg>; }
function ClockIcon()   { return <svg {...ip}><circle cx="12" cy="12" r="10"/><polyline points="12 6 12 12 16 14"/></svg>; }
function GlobeIcon()   { return <svg {...ip}><circle cx="12" cy="12" r="10"/><line x1="2" y1="12" x2="22" y2="12"/><path d="M12 2a15.3 15.3 0 0 1 4 10 15.3 15.3 0 0 1-4 10 15.3 15.3 0 0 1-4-10 15.3 15.3 0 0 1 4-10z"/></svg>; }
