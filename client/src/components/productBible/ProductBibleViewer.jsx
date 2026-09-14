// PRODUCT BIBLE VIEWER: read-only research document for one product, one market at a time.
// Sticky table of contents (drawer on narrow screens), scoped document typography (productBible.css),
// clickable quote chips that resolve the verbatim quote through the quotes API.
import { memo, useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { BookOpen, ChevronDown, ChevronRight, ExternalLink, List, Loader2, RotateCw, X } from 'lucide-react';
import { fetchBibleDocument, fetchBibleQuotes, bibleErrorText } from './bibleApi';
import './productBible.css';

const STAT_KEYS = [
  ['avatar', 'Avatars'],
  ['angle', 'Angles'],
  ['hook', 'Hooks'],
  ['quotes', 'Quotes'],
];

function decodeEntities(s) {
  if (!s || !/&[#a-z0-9]+;/i.test(s)) return s || '';
  const t = document.createElement('textarea');
  t.innerHTML = s;
  return t.value;
}

function formatDate(v) {
  if (!v) return null;
  const d = new Date(v);
  return Number.isNaN(d.getTime()) ? null : d.toLocaleDateString(undefined, { year: 'numeric', month: 'short', day: 'numeric' });
}

function safeUrl(u) {
  try {
    const url = new URL(String(u));
    return url.protocol === 'http:' || url.protocol === 'https:' ? url.href : null;
  } catch {
    return null;
  }
}

export function MarketSwitch({ markets, value, onChange, label = 'Market' }) {
  return (
    <div role="radiogroup" aria-label={label} className="flex flex-wrap gap-1.5">
      {markets.map((m) => {
        const on = m.market_key === value;
        return (
          <button
            key={m.market_key}
            type="button"
            role="radio"
            aria-checked={on}
            onClick={() => onChange(m.market_key)}
            className={`px-3 py-1.5 text-xs font-medium rounded-lg border transition-colors cursor-pointer focus:outline-none focus-visible:ring-1 focus-visible:ring-[#c9a84c]/50 ${
              on
                ? 'bg-[#c9a84c]/10 border-[#c9a84c]/30 text-[#e8d5a3]'
                : 'bg-white/[0.02] border-white/[0.05] text-zinc-400 hover:border-white/[0.1] hover:text-zinc-200'
            }`}
          >
            {m.label}{m.price ? ` · ${m.price}` : ''}
          </button>
        );
      })}
    </div>
  );
}

function QuotePopover({ state, onClose }) {
  const ref = useRef(null);
  const [pos, setPos] = useState({ left: 8, top: 8 });

  useEffect(() => {
    if (!state) return;
    const r = state.rect;
    const vw = window.innerWidth;
    const vh = window.innerHeight;
    const w = Math.min(360, vw - 16);
    const h = ref.current?.offsetHeight || 200;
    const left = Math.max(8, Math.min(r.left, vw - w - 8));
    const below = r.bottom + 6;
    const top = below + h > vh - 8 && r.top - h - 6 > 8 ? r.top - h - 6 : Math.max(8, Math.min(below, vh - h - 8));
    setPos({ left, top });
  }, [state, state?.quote, state?.loading]);

  useEffect(() => {
    if (!state) return undefined;
    ref.current?.focus();
    const onKey = (e) => { if (e.key === 'Escape') onClose(true); };
    const onDown = (e) => {
      if (ref.current?.contains(e.target) || e.target.closest?.('.pb-qid')) return;
      onClose(false);
    };
    const onScroll = (e) => { if (!ref.current?.contains(e.target)) onClose(false); };
    document.addEventListener('keydown', onKey);
    document.addEventListener('mousedown', onDown);
    document.addEventListener('scroll', onScroll, { capture: true, passive: true });
    window.addEventListener('resize', onScroll);
    return () => {
      document.removeEventListener('keydown', onKey);
      document.removeEventListener('mousedown', onDown);
      document.removeEventListener('scroll', onScroll, { capture: true });
      window.removeEventListener('resize', onScroll);
    };
  }, [state, onClose]);

  if (!state) return null;
  const q = state.quote;
  const link = q ? safeUrl(q.url) : null;

  return (
    <div
      ref={ref}
      role="dialog"
      aria-label={`Quote ${state.id}`}
      tabIndex={-1}
      className="pb-quote-pop p-4 focus:outline-none"
      style={{ left: pos.left, top: pos.top }}
    >
      <div className="flex items-center gap-2 mb-2">
        <span className="font-mono text-[10px] font-semibold text-[#c9a84c] uppercase tracking-[0.15em]">{state.id}</span>
        {q?.source && (
          <span className="font-mono text-[10px] uppercase tracking-wider text-zinc-400 px-1.5 py-0.5 rounded border border-white/[0.08] bg-white/[0.02]">
            {q.source}
          </span>
        )}
        <button
          type="button"
          onClick={() => onClose(true)}
          aria-label="Close quote"
          className="ml-auto w-6 h-6 rounded flex items-center justify-center text-zinc-500 hover:text-white hover:bg-white/[0.06] cursor-pointer"
        >
          <X className="w-3.5 h-3.5" />
        </button>
      </div>
      {state.loading && (
        <div className="flex items-center gap-2 text-xs text-zinc-500 py-3"><Loader2 className="w-3.5 h-3.5 animate-spin" /> Loading quote</div>
      )}
      {state.error && <p className="text-xs text-red-400 py-2" role="alert">Could not load this quote: {state.error}</p>}
      {!state.loading && !state.error && !q && <p className="text-xs text-zinc-500 py-2">This quote is not in the imported library.</p>}
      {q && (
        <>
          <blockquote className="text-sm leading-relaxed text-zinc-100 border-l-2 border-[#c9a84c] pl-3 my-2 whitespace-pre-line break-words">
            {q.quote}
          </blockquote>
          <div className="flex flex-wrap gap-x-3 gap-y-1 text-[11px] text-zinc-500 mt-3">
            {q.speaker && <span>Speaker: <span className="text-zinc-300">{q.speaker}</span></span>}
            {q.avatar && <span>Avatar: <span className="text-zinc-300">{q.avatar}</span></span>}
            {q.hook_strength != null && <span>Hook strength: <span className="text-zinc-300">{q.hook_strength}</span></span>}
          </div>
          {Array.isArray(q.tags) && q.tags.length > 0 && (
            <div className="flex flex-wrap gap-1 mt-2">
              {q.tags.map((t) => (
                <span key={t} className="font-mono text-[9px] uppercase tracking-wider text-zinc-500 px-1.5 py-0.5 rounded bg-white/[0.03] border border-white/[0.05]">{t}</span>
              ))}
            </div>
          )}
          {link && (
            <a
              href={link}
              target="_blank"
              rel="noopener noreferrer"
              className="inline-flex items-center gap-1 mt-3 text-xs text-[#e8d5a3] hover:text-[#c9a84c] break-all"
            >
              <ExternalLink className="w-3 h-3 shrink-0" /> Open source
            </a>
          )}
        </>
      )}
    </div>
  );
}

// Memoised on its strings: re-rendering an element with dangerouslySetInnerHTML re-parses it, which would re-create
// every chip (losing focus/aria state) and re-layout the whole document on each active-section change.
const DocSection = memo(function DocSection({ anchor, html }) {
  return <section className="pb-section" data-pb-section={anchor} dangerouslySetInnerHTML={{ __html: html }} />;
});

function TocList({ toc, active, activeParent, expanded, onToggle, onJump }) {
  return (
    <ul className="space-y-0.5">
      {toc.map((h2) => {
        const isOpen = expanded.has(h2.anchor) ? expanded.get(h2.anchor) : activeParent === h2.anchor;
        const hasKids = h2.children?.length > 0;
        const on = active === h2.anchor || activeParent === h2.anchor;
        return (
          <li key={h2.anchor}>
            <div className="flex items-start">
              {hasKids ? (
                <button
                  type="button"
                  onClick={() => onToggle(h2.anchor)}
                  aria-expanded={isOpen}
                  aria-label={`${isOpen ? 'Collapse' : 'Expand'} ${decodeEntities(h2.title)}`}
                  className="w-5 h-6 shrink-0 flex items-center justify-center text-zinc-600 hover:text-zinc-300 cursor-pointer"
                >
                  {isOpen ? <ChevronDown className="w-3 h-3" /> : <ChevronRight className="w-3 h-3" />}
                </button>
              ) : <span className="w-5 shrink-0" />}
              <a
                href={`#${h2.anchor}`}
                onClick={(e) => { e.preventDefault(); onJump(h2.anchor); }}
                aria-current={active === h2.anchor ? 'location' : undefined}
                className={`flex-1 min-w-0 py-1 pr-2 text-[13px] leading-snug rounded transition-colors ${
                  on ? 'text-[#e8d5a3] font-medium' : 'text-zinc-400 hover:text-zinc-100'
                }`}
              >
                {decodeEntities(h2.title)}
              </a>
            </div>
            {hasKids && isOpen && (
              <ul className="ml-5 border-l border-white/[0.06] mb-1">
                {h2.children.map((h3) => (
                  <li key={h3.anchor}>
                    <a
                      href={`#${h3.anchor}`}
                      onClick={(e) => { e.preventDefault(); onJump(h3.anchor); }}
                      aria-current={active === h3.anchor ? 'location' : undefined}
                      className={`block -ml-px pl-3 pr-2 py-1 text-xs leading-snug border-l transition-colors ${
                        active === h3.anchor
                          ? 'border-[#c9a84c] text-[#e8d5a3]'
                          : 'border-transparent text-zinc-500 hover:text-zinc-200'
                      }`}
                    >
                      {decodeEntities(h3.title)}
                    </a>
                  </li>
                ))}
              </ul>
            )}
          </li>
        );
      })}
    </ul>
  );
}

/**
 * @param productId  product id (or code) the markets belong to
 * @param markets    rows from GET /product-bible/products/:product/markets (non-empty)
 */
export default function ProductBibleViewer({ productId, markets }) {
  const [pickedMarket, setMarket] = useState(markets[0]?.market_key || '');
  const market = markets.some((m) => m.market_key === pickedMarket) ? pickedMarket : (markets[0]?.market_key || '');
  const [loaded, setLoaded] = useState({ key: null, doc: null, error: null });
  const [retry, setRetry] = useState(0);
  const [active, setActive] = useState(null);
  const [expanded, setExpanded] = useState(() => new Map());
  const [drawerOpen, setDrawerOpen] = useState(false);
  const [pop, setPop] = useState(null);
  const articleRef = useRef(null);
  const popChipRef = useRef(null);
  const jumpLockUntil = useRef(0); // a TOC click owns the highlight until its smooth scroll settles

  const docKey = productId && market ? `${productId}:${market}:${retry}` : null;
  const loading = !!docKey && loaded.key !== docKey;
  const doc = loading ? null : loaded.doc;
  const error = loading ? null : loaded.error;

  useEffect(() => {
    if (!docKey) return undefined;
    let alive = true;
    fetchBibleDocument(productId, market)
      .then((d) => { if (alive) { setLoaded({ key: docKey, doc: d, error: null }); setActive(null); setExpanded(new Map()); setPop(null); } })
      .catch((err) => { if (alive) { setLoaded({ key: docKey, doc: null, error: bibleErrorText(err) }); setPop(null); } });
    return () => { alive = false; };
  }, [docKey, productId, market]);

  const toc = useMemo(() => doc?.toc || [], [doc]);
  const parentOf = useMemo(() => {
    const m = new Map();
    for (const h2 of toc) for (const h3 of h2.children || []) m.set(h3.anchor, h2.anchor);
    return m;
  }, [toc]);
  const activeParent = active ? (parentOf.get(active) || active) : null;

  const findTarget = useCallback((anchor) => {
    const root = articleRef.current;
    if (!root || !anchor) return null;
    const esc = window.CSS?.escape ? window.CSS.escape(anchor) : anchor.replace(/["\\]/g, '\\$&');
    return root.querySelector(`[id="${esc}"]`) || root.querySelector(`[data-pb-section="${esc}"]`);
  }, []);

  const jump = useCallback((anchor) => {
    const el = findTarget(anchor);
    if (!el) return;
    jumpLockUntil.current = Date.now() + 1200;
    el.scrollIntoView({ behavior: 'smooth', block: 'start' });
    setActive(anchor);
    setDrawerOpen(false);
  }, [findTarget]);

  // Quote chips become keyboard buttons in the HTML itself (not by DOM mutation, which a re-render can undo).
  const sections = useMemo(() => (doc?.sections || []).map((sec) => ({
    ...sec,
    html: String(sec.html || '').replace(
      /<span class="pb-qid" data-qid="(Q\d{4,5})">/g,
      '<span class="pb-qid" data-qid="$1" role="button" tabindex="0" aria-haspopup="dialog" aria-label="Show quote $1">',
    ),
  })), [doc]);

  // Active section: the last TOC heading whose top has passed the upper part of the viewport.
  useEffect(() => {
    const root = articleRef.current;
    if (!root || !toc.length) return undefined;
    const anchors = [];
    for (const h2 of toc) { anchors.push(h2.anchor); for (const h3 of h2.children || []) anchors.push(h3.anchor); }
    const els = anchors.map((a) => [a, findTarget(a)]).filter(([, el]) => el);
    let raf = 0;
    let lockTimer = 0;
    const measure = () => {
      raf = 0;
      const wait = jumpLockUntil.current - Date.now();
      if (wait > 0) { clearTimeout(lockTimer); lockTimer = setTimeout(onScroll, wait + 20); return; }
      const line = Math.min(96, window.innerHeight * 0.2);
      let cur = els[0]?.[0] || null;
      for (const [a, el] of els) {
        if (el.getBoundingClientRect().top - line <= 0) cur = a; else break;
      }
      setActive((prev) => (prev === cur ? prev : cur));
    };
    const onScroll = () => { if (!raf) raf = requestAnimationFrame(measure); };
    document.addEventListener('scroll', onScroll, { capture: true, passive: true });
    measure();
    return () => {
      document.removeEventListener('scroll', onScroll, { capture: true });
      if (raf) cancelAnimationFrame(raf);
      clearTimeout(lockTimer);
    };
  }, [toc, findTarget]);

  const closePop = useCallback((restoreFocus) => {
    const chip = popChipRef.current;
    if (chip) chip.setAttribute('aria-expanded', 'false');
    popChipRef.current = null;
    setPop(null);
    if (restoreFocus && chip) chip.focus();
  }, []);

  const openQuote = useCallback((chip) => {
    const id = chip.dataset.qid || chip.textContent.trim();
    if (!/^Q\d{4,5}$/.test(id)) return;
    if (popChipRef.current === chip) { closePop(false); return; }
    if (popChipRef.current) popChipRef.current.setAttribute('aria-expanded', 'false');
    popChipRef.current = chip;
    chip.setAttribute('aria-expanded', 'true');
    const rect = chip.getBoundingClientRect();
    setPop({ id, rect, loading: true, quote: null, error: null });
    // Resolve every chip in the same section at once so the next clicks there are instant (cached).
    const section = chip.closest('[data-pb-section]');
    const ids = section
      ? [id, ...[...section.querySelectorAll('.pb-qid')].map((el) => el.dataset.qid).filter((x) => x && x !== id)].slice(0, 200)
      : [id];
    fetchBibleQuotes(productId, market, ids)
      .then((map) => setPop((p) => (p && p.id === id ? { ...p, loading: false, quote: map.get(id) || null } : p)))
      .catch((err) => setPop((p) => (p && p.id === id ? { ...p, loading: false, error: bibleErrorText(err) } : p)));
  }, [productId, market, closePop]);

  const onArticleClick = (e) => {
    const chip = e.target.closest?.('.pb-qid');
    if (chip && articleRef.current?.contains(chip)) { e.preventDefault(); openQuote(chip); }
  };
  const onArticleKey = (e) => {
    if (e.key !== 'Enter' && e.key !== ' ') return;
    const chip = e.target.closest?.('.pb-qid');
    if (chip) { e.preventDefault(); openQuote(chip); }
  };

  // expanded: anchor -> operator's explicit open/closed choice; without one, the active section's group is open.
  const toggle = (anchor) => setExpanded((prev) => {
    const next = new Map(prev);
    const open = next.has(anchor) ? next.get(anchor) : activeParent === anchor;
    next.set(anchor, !open);
    return next;
  });

  const meta = doc?.market || markets.find((m) => m.market_key === market) || {};
  const stats = meta.stats || {};
  const imported = formatDate(meta.imported_at);
  const productLink = safeUrl(meta.product_url);
  const activeTitle = (() => {
    for (const h2 of toc) {
      if (h2.anchor === active) return h2.title;
      const c = (h2.children || []).find((h3) => h3.anchor === active);
      if (c) return c.title;
    }
    return toc[0]?.title || '';
  })();

  return (
    <div className="space-y-4 min-w-0">
      {/* Header */}
      <div className="glass-card border border-white/[0.05] rounded-xl p-5 shadow-[inset_0_1px_0_0_rgba(255,255,255,0.03)] space-y-4">
        <div className="flex flex-col sm:flex-row sm:items-center gap-3">
          <div className="flex items-center gap-2 shrink-0">
            <BookOpen className="w-4 h-4 text-[#c9a84c]" aria-hidden="true" />
            <span className="font-mono text-[10px] font-semibold text-[#c9a84c] uppercase tracking-[0.15em]">Product Bible</span>
          </div>
          <div className="sm:ml-auto min-w-0">
            <MarketSwitch markets={markets} value={market} onChange={setMarket} />
          </div>
        </div>
        <div className="min-w-0">
          <h2 className="text-lg font-semibold text-white leading-snug break-words">
            {meta.bible_title || meta.label || 'Product Bible'}
          </h2>
          <div className="flex flex-wrap items-center gap-x-3 gap-y-1 mt-1.5 text-xs text-zinc-500">
            {meta.bible_version && (
              <span className="font-mono text-[10px] uppercase tracking-wider px-1.5 py-0.5 rounded bg-[#c9a84c]/10 text-[#e8d5a3] border border-[#c9a84c]/20">
                {meta.bible_version}
              </span>
            )}
            {imported && <span>Imported {imported}</span>}
            {productLink && (
              <a href={productLink} target="_blank" rel="noopener noreferrer" className="inline-flex items-center gap-1 hover:text-zinc-300 min-w-0">
                <ExternalLink className="w-3 h-3 shrink-0" /> <span className="truncate">Product page</span>
              </a>
            )}
          </div>
        </div>
        <div className="grid grid-cols-2 sm:grid-cols-4 gap-2">
          {STAT_KEYS.map(([k, label]) => (
            <div key={k} className="rounded-lg border border-white/[0.05] bg-white/[0.02] px-3 py-2">
              <div className="font-mono text-[10px] text-zinc-500 uppercase tracking-[0.15em] font-semibold">{label}</div>
              <div className="text-base font-semibold text-white tabular-nums mt-0.5">
                {Number.isFinite(Number(stats[k])) ? Number(stats[k]).toLocaleString() : '-'}
              </div>
            </div>
          ))}
        </div>
      </div>

      {loading && (
        <div className="flex items-center justify-center py-16 text-sm text-zinc-500 gap-2">
          <Loader2 className="w-5 h-5 animate-spin text-[#c9a84c]" /> Loading the bible
        </div>
      )}

      {!loading && error && (
        <div className="glass-card border border-red-500/20 rounded-xl p-5 flex flex-wrap items-center gap-3" role="alert">
          <p className="text-sm text-red-400 flex-1 min-w-0 break-words">Could not load this bible: {error}</p>
          <button
            type="button"
            onClick={() => setRetry((n) => n + 1)}
            className="inline-flex items-center gap-1.5 text-xs text-zinc-300 hover:text-white px-3 py-2 rounded-lg border border-white/[0.08] hover:bg-white/[0.04] cursor-pointer"
          >
            <RotateCw className="w-3.5 h-3.5" /> Retry
          </button>
        </div>
      )}

      {!loading && !error && doc && doc.sections?.length === 0 && (
        <p className="text-sm text-zinc-500 px-1">This market has no bible sections.</p>
      )}

      {!loading && !error && doc && doc.sections?.length > 0 && (
        <>
          {/* Narrow screens: contents drawer */}
          <div className="lg:hidden sticky top-0 z-20 -mx-1 px-1 py-1 bg-[#111113]/95 backdrop-blur">
            <button
              type="button"
              onClick={() => setDrawerOpen((o) => !o)}
              aria-expanded={drawerOpen}
              aria-controls="pb-toc-drawer"
              className="w-full flex items-center gap-2 px-3 py-2.5 rounded-lg border border-white/[0.08] bg-white/[0.02] text-left cursor-pointer"
            >
              <List className="w-4 h-4 text-[#c9a84c] shrink-0" />
              <span className="font-mono text-[10px] font-semibold text-[#c9a84c] uppercase tracking-[0.15em] shrink-0">Contents</span>
              <span className="text-xs text-zinc-400 truncate min-w-0 flex-1">{decodeEntities(activeTitle)}</span>
              <ChevronDown className={`w-4 h-4 text-zinc-500 shrink-0 transition-transform ${drawerOpen ? 'rotate-180' : ''}`} />
            </button>
            {drawerOpen && (
              <nav
                id="pb-toc-drawer"
                aria-label="Bible contents"
                className="mt-1 max-h-[60vh] overflow-y-auto rounded-lg border border-white/[0.08] bg-[#18181b] p-2"
              >
                <TocList toc={toc} active={active} activeParent={activeParent} expanded={expanded} onToggle={toggle} onJump={jump} />
              </nav>
            )}
          </div>

          <div className="lg:grid lg:grid-cols-[240px_minmax(0,1fr)] lg:gap-8">
            <nav
              aria-label="Bible contents"
              className="hidden lg:block sticky top-4 self-start max-h-[calc(100vh-6rem)] overflow-y-auto pr-1"
            >
              <div className="font-mono text-[10px] font-semibold text-zinc-500 uppercase tracking-[0.15em] mb-2 pl-5">Contents</div>
              <TocList toc={toc} active={active} activeParent={activeParent} expanded={expanded} onToggle={toggle} onJump={jump} />
            </nav>

            {/* Section HTML is server-rendered and sanitised (raw HTML escaped) by the Product Bible import. */}
            <article
              ref={articleRef}
              className="product-bible-doc"
              onClick={onArticleClick}
              onKeyDown={onArticleKey}
            >
              {sections.map((sec) => (
                <DocSection key={`${market}:${sec.anchor}`} anchor={sec.anchor} html={sec.html} />
              ))}
            </article>
          </div>
        </>
      )}

      <QuotePopover state={pop} onClose={closePop} />
    </div>
  );
}
