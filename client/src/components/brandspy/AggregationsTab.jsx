import { useEffect, useState, useCallback } from 'react';
import { ExternalLink, Sparkles, AlertCircle, RotateCcw, Search, Image as ImageIcon } from 'lucide-react';

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const TIER_COLORS = {
  BANGER: { dot: 'bg-rose-500',    text: 'text-rose-400' },
  CHAMP:  { dot: 'bg-amber-500',   text: 'text-amber-400' },
  A:      { dot: 'bg-emerald-500', text: 'text-emerald-400' },
  B:      { dot: 'bg-sky-500',     text: 'text-sky-400' },
  C:      { dot: 'bg-zinc-500',    text: 'text-zinc-400' },
  MID:    { dot: 'bg-zinc-600',    text: 'text-zinc-500' },
  TEST:   { dot: 'bg-zinc-700',    text: 'text-zinc-600' },
};

const TYPE_META = {
  hooks: {
    title:    'Hooks',
    subtitle: 'First-line opening copy patterns ordered by active count, longevity, and total uses.',
    emptyMsg: 'No hook patterns found — try refreshing.',
    placeholderShort: 'Search hooks…',
  },
  adcopy: {
    title:    'Ad Copy',
    subtitle: 'Full body-text variants ordered by active count, longevity, and total uses.',
    emptyMsg: 'No ad copy variants yet.',
    placeholderShort: 'Search ad copy…',
  },
  headlines: {
    title:    'Headlines',
    subtitle: 'Headline variants ordered by active count, longevity, and total uses.',
    emptyMsg: 'No headlines yet.',
    placeholderShort: 'Search headlines…',
  },
  landing: {
    title:    'Landing Pages',
    subtitle: 'Destination URLs (normalized) ordered by active count, longevity, and total uses.',
    emptyMsg: 'No landing pages found.',
    placeholderShort: 'Search URLs…',
  },
};

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function highlight(text, q) {
  if (!q) return text;
  const idx = text.toLowerCase().indexOf(q.toLowerCase());
  if (idx === -1) return text;
  return (
    <>
      {text.slice(0, idx)}
      <span className="bg-yellow-400/20 text-yellow-200">{text.slice(idx, idx + q.length)}</span>
      {text.slice(idx + q.length)}
    </>
  );
}

function TierDots({ tierCounts }) {
  const order = ['BANGER', 'CHAMP', 'A', 'B', 'C', 'MID', 'TEST'];
  const shown = order.filter((t) => (tierCounts?.[t] ?? 0) > 0);
  if (!shown.length) return null;
  return (
    <div className="flex items-center gap-1.5 flex-wrap">
      {shown.map((t) => (
        <span key={t} className="inline-flex items-center gap-1" title={`${t}: ${tierCounts[t]}`}>
          <span className={`w-1.5 h-1.5 rounded-full ${TIER_COLORS[t].dot}`} />
          <span className={`text-[10px] tabular-nums ${TIER_COLORS[t].text}`}>
            {t === 'BANGER' ? '🔥' : t === 'CHAMP' ? '🏆' : t} {tierCounts[t]}
          </span>
        </span>
      ))}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Row — single aggregation entry
// ---------------------------------------------------------------------------

function AggRow({ rank, item, type, onOpen, query }) {
  const [imgFailed, setImgFailed] = useState(false);

  const showThumb = ['hooks', 'adcopy', 'headlines'].includes(type);
  const primary   = (() => {
    switch (type) {
      case 'hooks':     return item.key;
      case 'adcopy':    return item.key;
      case 'headlines': return item.key;
      case 'landing':   return item.key;
      default:          return item.key;
    }
  })();

  const secondary = (() => {
    switch (type) {
      case 'hooks':
        // Show longer body context if available
        if (item.sampleBody && item.sampleBody.length > item.key.length) {
          return item.sampleBody.slice(0, 240);
        }
        return null;
      case 'adcopy':
        return item.sampleHeadline ? `Headline: ${item.sampleHeadline}` : null;
      case 'headlines':
        return item.sampleBody ? item.sampleBody.slice(0, 200) : null;
      case 'landing':
        return item.sampleHeadline || (item.sampleBody ? item.sampleBody.slice(0, 200) : null);
      default:
        return null;
    }
  })();

  const isLanding = type === 'landing';
  const fullUrl   = isLanding ? `https://${item.key}` : null;

  return (
    <div
      onClick={() => item.topAdId && onOpen(item.topAdId)}
      className="group flex items-start gap-3 px-3 py-3 rounded-lg border border-border-subtle bg-bg-elevated hover:border-white/15 hover:bg-bg-hover transition-all cursor-pointer"
    >
      {/* Rank */}
      <span className="text-[11px] text-text-faint font-mono tabular-nums shrink-0 pt-0.5 w-7 text-right">
        #{rank}
      </span>

      {/* Thumb */}
      {showThumb && (
        <div className="w-16 h-20 rounded-md bg-zinc-950 border border-border-subtle overflow-hidden shrink-0">
          {item.thumbnailUrl && !imgFailed ? (
            <img
              src={item.thumbnailUrl}
              alt=""
              className="w-full h-full object-cover"
              onError={() => setImgFailed(true)}
              loading="lazy"
            />
          ) : (
            <div className="w-full h-full flex items-center justify-center">
              <ImageIcon className="w-4 h-4 text-text-faint opacity-40" />
            </div>
          )}
        </div>
      )}

      {/* Body */}
      <div className="flex-1 min-w-0">
        <div className="flex items-start gap-3 justify-between">
          <p className={`text-[13px] text-text-primary leading-snug ${isLanding ? 'font-mono break-all' : ''}`}>
            {highlight(primary, query)}
            {isLanding && fullUrl && (
              <a
                href={fullUrl}
                target="_blank"
                rel="noreferrer"
                onClick={(e) => e.stopPropagation()}
                className="inline-flex items-center ml-1.5 align-baseline text-text-faint hover:text-text-primary"
                title="Open landing page"
              >
                <ExternalLink className="w-3 h-3" />
              </a>
            )}
          </p>
          {/* Metric column */}
          <div className="flex items-baseline gap-2 shrink-0">
            <span className="text-sm font-bold text-emerald-400 tabular-nums">{item.activeCount}</span>
            <span className="text-[10px] text-text-faint uppercase tracking-wider">active</span>
            <span className="text-[11px] text-text-faint tabular-nums ml-1">/ {item.count}</span>
          </div>
        </div>

        {secondary && (
          <p className="text-[11px] text-text-faint mt-1 leading-relaxed line-clamp-2">
            {highlight(secondary, query)}
          </p>
        )}

        <div className="flex items-center gap-3 mt-2 flex-wrap">
          <TierDots tierCounts={item.tierCounts} />
          {item.maxActiveDays > 0 && (
            <span className={`text-[10px] tabular-nums ${item.maxActiveDays >= 30 ? 'text-emerald-400 font-semibold' : 'text-text-faint'}`}>
              Longest run: {item.maxActiveDays}d
            </span>
          )}
          {item.sampleCta && (
            <span className="text-[10px] px-1.5 py-0.5 rounded border border-border-default bg-bg-card text-text-faint">
              CTA: {item.sampleCta}
            </span>
          )}
        </div>
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// AggregationsTab — main component, used by Hooks/Ad Copy/Headlines/Landing
// ---------------------------------------------------------------------------

export default function AggregationsTab({ apiBaseUrl, brandId, type, onOpenAd }) {
  const [items, setItems]       = useState([]);
  const [total, setTotal]       = useState(0);
  const [loading, setLoading]   = useState(true);
  const [error, setError]       = useState(null);
  const [activeOnly, setActiveOnly] = useState(true);
  const [search, setSearch]     = useState('');

  const meta = TYPE_META[type];

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const params = new URLSearchParams({ type, limit: '100' });
      if (activeOnly) params.set('activeOnly', '1');
      const res = await fetch(`${apiBaseUrl}/brands/${brandId}/aggregations?${params}`);
      if (!res.ok) throw new Error(`Failed (${res.status})`);
      const data = await res.json();
      setItems(data.items ?? []);
      setTotal(data.total ?? 0);
    } catch (e) {
      setError(e.message);
    } finally {
      setLoading(false);
    }
  }, [apiBaseUrl, brandId, type, activeOnly]);

  useEffect(() => { load(); }, [load]);

  // Client-side search filter
  const q = search.trim().toLowerCase();
  const filtered = q
    ? items.filter((it) => {
        const hay = [it.key, it.sampleHeadline, it.sampleBody, it.sampleLink, it.sampleCta]
          .filter(Boolean).join(' ').toLowerCase();
        return hay.includes(q);
      })
    : items;

  return (
    <div className="flex-1 flex flex-col min-h-0 px-5 pt-4 pb-6 gap-3">
      {/* Header */}
      <div className="flex items-center justify-between gap-3 flex-wrap">
        <div>
          <h2 className="text-base font-semibold text-text-primary flex items-center gap-2">
            <Sparkles className="w-3.5 h-3.5 text-zinc-500" />
            {meta.title}
            {!loading && (
              <span className="text-[11px] font-normal text-text-faint">
                {filtered.length} of {total.toLocaleString()}
              </span>
            )}
          </h2>
          <p className="text-[11px] text-text-faint mt-0.5">{meta.subtitle}</p>
        </div>

        <div className="flex items-center gap-2">
          {/* Active-only toggle */}
          <button
            onClick={() => setActiveOnly((v) => !v)}
            className={`flex items-center gap-1.5 px-2.5 py-1.5 text-[11px] rounded-lg border font-medium transition-colors ${
              activeOnly
                ? 'bg-emerald-500/10 text-emerald-400 border-emerald-500/20'
                : 'bg-bg-elevated text-text-faint border-border-default hover:text-text-muted'
            }`}>
            <span className={`w-1.5 h-1.5 rounded-full ${activeOnly ? 'bg-emerald-400' : 'bg-zinc-600'}`} />
            {activeOnly ? 'Active only' : 'All ads'}
          </button>

          {/* Search box */}
          <div className="relative">
            <Search className="absolute left-2.5 top-1/2 -translate-y-1/2 w-3.5 h-3.5 text-text-faint pointer-events-none" />
            <input
              type="text"
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              placeholder={meta.placeholderShort}
              className="pl-8 pr-3 py-1.5 text-xs rounded-lg bg-bg-elevated border border-border-default focus:border-white/20 focus:outline-none text-text-primary placeholder:text-text-faint transition-colors w-52"
            />
          </div>

          <button
            onClick={load}
            className="flex items-center gap-1.5 px-2.5 py-1.5 text-[11px] rounded-lg bg-bg-elevated border border-border-default hover:bg-bg-hover text-text-muted transition-colors"
            title="Reload">
            <RotateCcw className="w-3 h-3" />
          </button>
        </div>
      </div>

      {/* Body */}
      {loading ? (
        <div className="flex flex-col gap-2">
          {Array.from({ length: 8 }).map((_, i) => (
            <div key={i} className="flex items-start gap-3 px-3 py-3 rounded-lg border border-border-subtle bg-bg-elevated animate-pulse">
              <div className="w-16 h-20 bg-white/5 rounded-md shrink-0" />
              <div className="flex-1 space-y-2 pt-1">
                <div className="h-3 bg-white/5 rounded w-3/4" />
                <div className="h-3 bg-white/5 rounded w-1/2" />
                <div className="h-2 bg-white/5 rounded w-1/3 mt-2" />
              </div>
            </div>
          ))}
        </div>
      ) : error ? (
        <div className="flex items-center gap-2 text-red-400 text-sm py-8 justify-center">
          <AlertCircle className="w-4 h-4" /> {error}
          <button onClick={load} className="ml-2 text-text-muted hover:text-text-primary underline text-xs">
            Retry
          </button>
        </div>
      ) : filtered.length === 0 ? (
        <div className="flex flex-col items-center justify-center py-16 text-text-faint text-sm gap-2">
          {q ? `No matches for "${search}".` : meta.emptyMsg}
        </div>
      ) : (
        <div className="flex flex-col gap-2">
          {filtered.map((item, i) => (
            <AggRow
              key={item.key}
              rank={i + 1}
              item={item}
              type={type}
              onOpen={onOpenAd}
              query={search.trim()}
            />
          ))}
        </div>
      )}
    </div>
  );
}
