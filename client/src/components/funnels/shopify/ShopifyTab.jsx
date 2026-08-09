// FROM SHOPIFY — the Clone modal's Shopify tab. Lists the store's Online
// Store pages (GET /api/v1/shopify-pages/list), then imports the picked one
// (POST /api/v1/shopify-pages/import). The import returns the SAME
// { sections, stats } shape as /page-clone/scan — it IS that pipeline — so
// this tab hands the result straight to the modal's existing section picker
// and the existing /page-clone/create. Nothing is duplicated here.
//
// The fetched list is OWNED BY THE MODAL (`cache` / `onLoaded`), not by this
// component: hitting Back from the section picker unmounts this tab, and a
// component-owned list would re-hit the Shopify Admin API — the bucket shared
// with live checkout pricing — every single time.
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  ShoppingBag, Search, RefreshCw, Loader2, ExternalLink,
  AlertTriangle, Layers,
} from 'lucide-react';
import api from '../../../services/api';
import Button from '../../ui/Button';

const fmtDate = (raw) => {
  if (!raw) return '';
  const d = new Date(raw);
  if (Number.isNaN(d.getTime())) return '';
  return d.toLocaleDateString(undefined, { month: 'short', day: 'numeric', year: 'numeric' });
};

// The server flags every PERMANENT failure (dead credential, frozen store,
// deleted page, bad config) as retryable:false. Retry is offered only when
// the server says the failure clears on its own.
const isRetryable = (err) => err?.response?.data?.error?.retryable === true;
const errorOf = (err, fallback) => err?.response?.data?.error?.message || fallback;
const codeOf = (err) => err?.response?.data?.error?.code || '';
const retryAfterOf = (err) => {
  const n = err?.response?.data?.error?.retry_after;
  return Number.isFinite(n) && n > 0 ? Math.ceil(n) : 0;
};
const isAborted = (err) => err?.code === 'ERR_CANCELED' || err?.name === 'CanceledError';

export default function ShopifyTab({ cache, onLoaded, onScanned, onClose }) {
  const [pages, setPages] = useState(cache?.pages || []);
  const [storeDomain, setStoreDomain] = useState(cache?.storeDomain || '');
  const [truncated, setTruncated] = useState(Boolean(cache?.truncated));
  const [loading, setLoading] = useState(false);
  const [listError, setListError] = useState(null); // { message, retryable, code }
  const [query, setQuery] = useState('');
  const [importingId, setImportingId] = useState('');
  const [importError, setImportError] = useState(null); // { message, live_url, code }
  const [cooldown, setCooldown] = useState(0); // seconds left on a Retry-After

  // m4 — every in-flight request carries a generation. A response whose
  // generation is stale (the operator hit Refresh again, or left the tab) is
  // DROPPED: without this, a slow first response lands after a fast second
  // one and the older list wins.
  const reqIdRef = useRef(0);
  const abortRef = useRef(null);

  const load = useCallback(async () => {
    const gen = (reqIdRef.current += 1);
    abortRef.current?.abort();
    const controller = new AbortController();
    abortRef.current = controller;

    setLoading(true);
    setListError(null);
    setImportError(null);
    try {
      const res = await api.get('/shopify-pages/list', {
        params: { limit: 250 },
        signal: controller.signal,
      });
      if (reqIdRef.current !== gen) return;
      const data = res.data?.data || {};
      const next = {
        pages: Array.isArray(data.pages) ? data.pages : [],
        storeDomain: data.store_domain || '',
        truncated: Boolean(data.truncated),
      };
      setPages(next.pages);
      setStoreDomain(next.storeDomain);
      setTruncated(next.truncated);
      onLoaded?.(next); // hand the list to the modal so Back does not refetch
    } catch (err) {
      if (isAborted(err) || reqIdRef.current !== gen) return;
      // An outage must NOT read as "this store has no pages" — the list is
      // left untouched and the panel says what actually happened.
      setListError({
        message: errorOf(err, 'Could not load your Shopify pages.'),
        retryable: isRetryable(err),
        code: codeOf(err),
      });
      setCooldown(retryAfterOf(err));
    } finally {
      if (reqIdRef.current === gen) setLoading(false);
    }
  }, [onLoaded]);

  // Fetch once, and only when the modal has nothing cached for us.
  useEffect(() => {
    if (cache?.pages) return;
    load();
    // `load` is stable and `cache` is only read on mount — a dependency on
    // either would re-fire the fetch this guard exists to prevent.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Abort anything in flight when the tab goes away (Back, tab switch, close).
  useEffect(() => () => {
    reqIdRef.current += 1;
    abortRef.current?.abort();
  }, []);

  // m6 — honour the server's Retry-After rather than letting the operator
  // hammer a throttle that has told us exactly how long to wait.
  useEffect(() => {
    if (cooldown <= 0) return undefined;
    const t = setTimeout(() => setCooldown((n) => (n > 0 ? n - 1 : 0)), 1000);
    return () => clearTimeout(t);
  }, [cooldown]);

  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase();
    if (!q) return pages;
    return pages.filter((p) => `${p.title || ''} ${p.handle || ''}`.toLowerCase().includes(q));
  }, [pages, query]);

  const importPage = useCallback(async (page) => {
    if (importingId || loading) return;
    setImportingId(page.id);
    setImportError(null);
    try {
      const res = await api.post('/shopify-pages/import', { page_id: page.id });
      const data = res.data?.data || {};
      // The modal returns a message instead of swallowing a refusal — a
      // handoff that failed silently would look like a dead Import button.
      const refusal = onScanned?.(data);
      if (refusal) setImportError({ message: refusal, live_url: page.live_url || '', code: 'no_sections' });
    } catch (err) {
      if (isAborted(err)) return;
      setImportError({
        message: errorOf(err, 'Could not import that page.'),
        live_url: err?.response?.data?.error?.live_url || page.live_url || '',
        code: codeOf(err),
      });
      setCooldown(retryAfterOf(err));
    } finally {
      setImportingId('');
    }
  }, [importingId, loading, onScanned]);

  const busy = Boolean(importingId);
  // m4 — while a refresh is in flight, every row on screen is from the OLD
  // list. Importing one of them by id would be importing a row the operator
  // can no longer see, so the buttons are held until the new list lands.
  const rowsStale = loading && pages.length > 0;
  const retryBlocked = cooldown > 0;

  return (
    <>
      <div className="flex-1 min-h-0 overflow-y-auto p-5 space-y-4">
        {/* ── Search + refresh ─────────────────────────────────── */}
        <div className="flex items-center gap-2">
          <div className="relative flex-1 min-w-0">
            <Search className="absolute left-3 top-1/2 -translate-y-1/2 w-3.5 h-3.5 text-text-faint pointer-events-none" />
            <input
              type="text"
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              placeholder={storeDomain ? `Search ${storeDomain} pages…` : 'Search pages by title or handle…'}
              className="w-full pl-9 pr-3 py-2 rounded-lg bg-bg-elevated border border-border-default text-text-primary text-sm placeholder:text-text-faint focus:outline-none focus:border-accent/60"
            />
          </div>
          <button
            type="button"
            onClick={load}
            disabled={loading || busy || retryBlocked}
            title={retryBlocked ? `Shopify asked us to wait ${cooldown}s` : 'Reload the page list from Shopify'}
            className="inline-flex items-center gap-1.5 px-3 py-2 rounded-lg border border-border-default text-xs text-text-muted hover:text-text-primary hover:bg-bg-hover disabled:opacity-40 disabled:cursor-not-allowed cursor-pointer shrink-0"
          >
            <RefreshCw className={`w-3.5 h-3.5 ${loading ? 'animate-spin' : ''}`} />
            {retryBlocked ? `${cooldown}s` : 'Refresh'}
          </button>
        </div>

        {/* ── List error: an outage is an outage, never an empty store ── */}
        {listError && (
          <div className="px-3 py-3 rounded-lg bg-danger/10 border border-danger/30 space-y-2">
            <div className="flex items-start gap-2 text-danger text-xs">
              <AlertTriangle className="w-3.5 h-3.5 mt-0.5 shrink-0" />
              <span>{listError.message}</span>
            </div>
            {listError.retryable && (
              <button
                type="button"
                onClick={load}
                disabled={retryBlocked}
                className="text-[11px] text-text-muted hover:text-text-primary underline cursor-pointer disabled:opacity-40 disabled:cursor-not-allowed"
              >
                {retryBlocked ? `Try again in ${cooldown}s` : 'Try again'}
              </button>
            )}
          </div>
        )}

        {/* ── Import error ─────────────────────────────────────── */}
        {importError && (
          <div className="px-3 py-3 rounded-lg bg-amber-500/10 border border-amber-500/30 space-y-2">
            <div className="flex items-start gap-2 text-amber-400 text-xs">
              <AlertTriangle className="w-3.5 h-3.5 mt-0.5 shrink-0" />
              <span>{importError.message}</span>
            </div>
            <div className="flex items-center gap-3">
              {importError.live_url && (
                <a
                  href={importError.live_url}
                  target="_blank"
                  rel="noopener noreferrer"
                  className="inline-flex items-center gap-1 text-[11px] text-text-muted hover:text-text-primary underline"
                >
                  <ExternalLink className="w-3 h-3" />
                  Open the live page
                </a>
              )}
              {importError.code === 'page_not_found' && (
                <button
                  type="button"
                  onClick={load}
                  disabled={retryBlocked}
                  className="text-[11px] text-text-muted hover:text-text-primary underline cursor-pointer disabled:opacity-40"
                >
                  Refresh the list
                </button>
              )}
            </div>
          </div>
        )}

        {/* ── Body ─────────────────────────────────────────────── */}
        {loading && !pages.length ? (
          <div className="h-56 flex flex-col items-center justify-center gap-2 rounded-lg border-2 border-dashed border-border-default bg-bg-elevated">
            <Loader2 className="w-6 h-6 text-text-faint animate-spin" />
            <span className="text-xs text-text-faint">Loading Shopify pages…</span>
          </div>
        ) : !listError && !filtered.length ? (
          <div className="h-40 flex flex-col items-center justify-center gap-2 rounded-lg border-2 border-dashed border-border-default bg-bg-elevated">
            <ShoppingBag className="w-6 h-6 text-text-faint" />
            <span className="text-xs text-text-faint">
              {pages.length ? 'No pages match your search.' : 'No pages found on this store yet.'}
            </span>
          </div>
        ) : (
          <div className={`space-y-2 ${rowsStale ? 'opacity-50' : ''}`}>
            {filtered.map((p) => {
              const mine = importingId === p.id;
              return (
                <div
                  key={p.id}
                  className={`flex items-start gap-3 px-3 py-2.5 rounded-lg border transition-colors ${
                    mine
                      ? 'border-accent/60 bg-accent/5'
                      : `border-border-default bg-bg-elevated ${busy ? 'opacity-40' : 'hover:border-border-strong'}`
                  }`}
                >
                  <div className="min-w-0 flex-1">
                    <div className="flex items-center gap-2 flex-wrap">
                      <span className="text-xs font-medium text-text-primary truncate" title={p.title}>
                        {p.title || 'Untitled'}
                      </span>
                      {p.is_theme_built && (
                        <span
                          className="inline-flex items-center gap-1 px-1.5 py-0.5 rounded bg-amber-500/10 border border-amber-500/25 text-amber-400 text-[9px] uppercase tracking-wide"
                          // m2 — the OBSERVATION. We read the page editor's
                          // content; we did not read the theme, so we do not
                          // claim to know where the live content comes from.
                          title="Shopify's page editor holds almost no content for this page — importing it may bring back very little"
                        >
                          <Layers className="w-2.5 h-2.5" />
                          little editor content
                        </span>
                      )}
                      {!p.published && (
                        <span className="px-1.5 py-0.5 rounded bg-bg-hover text-text-faint text-[9px] uppercase tracking-wide">
                          unpublished
                        </span>
                      )}
                    </div>
                    <div className="mt-0.5 flex items-center gap-2 text-[10px] text-text-faint">
                      <span className="font-mono truncate">/pages/{p.handle}</span>
                      {p.updated_at && <span>· Updated {fmtDate(p.updated_at)}</span>}
                      {p.live_url && (
                        <a
                          href={p.live_url}
                          target="_blank"
                          rel="noopener noreferrer"
                          onClick={(e) => e.stopPropagation()}
                          className="inline-flex items-center hover:text-text-primary"
                          title="Open the live page"
                        >
                          <ExternalLink className="w-3 h-3" />
                        </a>
                      )}
                    </div>
                    {p.summary && (
                      <p className="mt-1 text-xs text-text-muted truncate">{p.summary}</p>
                    )}
                  </div>
                  <Button
                    variant="secondary"
                    size="sm"
                    onClick={() => importPage(p)}
                    disabled={(busy && !mine) || rowsStale}
                    loading={mine}
                    className="shrink-0"
                  >
                    {mine ? 'Importing…' : 'Import'}
                  </Button>
                </div>
              );
            })}
          </div>
        )}

        {truncated && !listError && (
          <p className="text-[11px] text-text-faint">
            {/* m3 — the search box filters what was already fetched, so
                "narrow the search" would not reach an unlisted page. */}
            This store has more pages than the picker fetches, and the search box only
            filters the {pages.length} shown. If the page you want is not here, open it in
            Shopify and use the Paste code tab.
          </p>
        )}
      </div>

      {/* ── Footer ───────────────────────────────────────────── */}
      <div className="shrink-0 flex items-center justify-between gap-3 px-5 py-3.5 border-t border-border-subtle">
        <p className="text-[11px] text-text-faint">
          Importing runs the same scan as Paste code: scripts, Meta &amp; Google pixels,
          inline event handlers, <code className="font-mono">javascript:</code> links and
          non-video iframes are removed, and off-site form actions are disarmed.
        </p>
        <div className="flex items-center gap-2 shrink-0">
          <Button variant="secondary" onClick={onClose}>Cancel</Button>
        </div>
      </div>
    </>
  );
}
