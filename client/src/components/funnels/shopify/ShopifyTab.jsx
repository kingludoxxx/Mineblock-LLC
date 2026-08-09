// FROM SHOPIFY — the Clone modal's Shopify tab. Lists the store's Online
// Store pages (GET /api/v1/shopify-pages/list), then imports the picked one
// (POST /api/v1/shopify-pages/import). The import returns the SAME
// { sections, stats } shape as /page-clone/scan — it IS that pipeline — so
// this tab hands the result straight to the modal's existing section picker
// and the existing /page-clone/create. Nothing is duplicated here.
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

// The server flags a dead credential / missing config as NOT retryable. The
// Retry button must never invite an operator to burn time against one.
const isRetryable = (err) => err?.response?.data?.error?.retryable === true;
const errorOf = (err, fallback) => err?.response?.data?.error?.message || fallback;
const codeOf = (err) => err?.response?.data?.error?.code || '';

export default function ShopifyTab({ onScanned, onClose }) {
  const [pages, setPages] = useState([]);
  const [storeDomain, setStoreDomain] = useState('');
  const [truncated, setTruncated] = useState(false);
  const [loading, setLoading] = useState(false);
  const [listError, setListError] = useState(null); // { message, retryable }
  const [query, setQuery] = useState('');
  const [importingId, setImportingId] = useState('');
  const [importError, setImportError] = useState(null); // { message, live_url }
  const loadedRef = useRef(false);

  const load = useCallback(async () => {
    setLoading(true);
    setListError(null);
    setImportError(null);
    try {
      const res = await api.get('/shopify-pages/list', { params: { limit: 250 } });
      const data = res.data?.data || {};
      setPages(Array.isArray(data.pages) ? data.pages : []);
      setStoreDomain(data.store_domain || '');
      setTruncated(Boolean(data.truncated));
    } catch (err) {
      // An outage must NOT read as "this store has no pages" — the list is
      // left untouched and the panel says what actually happened.
      setListError({
        message: errorOf(err, 'Could not load your Shopify pages.'),
        retryable: isRetryable(err),
        code: codeOf(err),
      });
    } finally {
      setLoading(false);
    }
  }, []);

  // Fetch once on first mount of the tab, not on every re-render.
  useEffect(() => {
    if (loadedRef.current) return;
    loadedRef.current = true;
    load();
  }, [load]);

  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase();
    if (!q) return pages;
    return pages.filter((p) => `${p.title || ''} ${p.handle || ''}`.toLowerCase().includes(q));
  }, [pages, query]);

  const importPage = useCallback(async (page) => {
    if (importingId) return;
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
      setImportError({
        message: errorOf(err, 'Could not import that page.'),
        live_url: err?.response?.data?.error?.live_url || page.live_url || '',
        code: codeOf(err),
      });
    } finally {
      setImportingId('');
    }
  }, [importingId, onScanned]);

  const busy = Boolean(importingId);

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
            disabled={loading || busy}
            title="Reload the page list from Shopify"
            className="inline-flex items-center gap-1.5 px-3 py-2 rounded-lg border border-border-default text-xs text-text-muted hover:text-text-primary hover:bg-bg-hover disabled:opacity-40 disabled:cursor-not-allowed cursor-pointer shrink-0"
          >
            <RefreshCw className={`w-3.5 h-3.5 ${loading ? 'animate-spin' : ''}`} />
            Refresh
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
                className="text-[11px] text-text-muted hover:text-text-primary underline cursor-pointer"
              >
                Try again
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
          <div className="space-y-2">
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
                          title="No content in Shopify's page editor — this page is built by your theme or a page builder"
                        >
                          <Layers className="w-2.5 h-2.5" />
                          theme-built
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
                    disabled={busy && !mine}
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
            Showing the first {pages.length} pages — this store has more than the picker fetches.
            Narrow the search or import from the Paste code tab.
          </p>
        )}
      </div>

      {/* ── Footer ───────────────────────────────────────────── */}
      <div className="shrink-0 flex items-center justify-between gap-3 px-5 py-3.5 border-t border-border-subtle">
        <p className="text-[11px] text-text-faint">
          Importing runs the same scan as Paste code — scripts, Meta &amp; Google pixels and
          the source meta are stripped, then the page splits into sections.
        </p>
        <div className="flex items-center gap-2 shrink-0">
          <Button variant="secondary" onClick={onClose}>Cancel</Button>
        </div>
      </div>
    </>
  );
}
