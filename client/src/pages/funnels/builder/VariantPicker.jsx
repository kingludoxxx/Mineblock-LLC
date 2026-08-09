// PAGE BUILDER — Shopify product/variant picker.
//
// Writes ONE value: the numeric variant id, into whatever prop the caller
// names (order_bump uses props.variant_id, which is exactly what
// checkoutPublic's /session/:id/bump reads off the PUBLISHED page).
//
// It never writes a price. The price shown here is a PICKER LABEL fetched for
// recognition only — the charge is re-priced server-side at checkout
// (services/checkoutPricing.js), so a stale label here cannot move money.
//
// Backed by GET /api/v1/shopify-variants/search?q= (authed proxy; the Shopify
// Admin token never reaches the browser).
import { useCallback, useEffect, useRef, useState } from 'react';
import { Search, Loader2, X, AlertCircle, Check } from 'lucide-react';
import api from '../../../services/api';

const SEARCH_DEBOUNCE_MS = 350;
const Q_MIN = 2;

const inputCls =
  'w-full px-2.5 py-1.5 text-sm bg-bg-elevated border border-border-default rounded-md text-text-primary placeholder:text-text-faint focus:outline-none focus:border-border-strong';

export default function VariantPicker({ value, onChange, onPick, help }) {
  const [q, setQ] = useState('');
  const [open, setOpen] = useState(false);
  const [rows, setRows] = useState([]);
  const [state, setState] = useState('idle'); // idle | loading | ok | error
  const [error, setError] = useState(null);

  // Every in-flight search is abortable and every response is checked against
  // the LATEST query before it renders: typing "gl" then "glow" must not have
  // the slower "gl" response overwrite the "glow" list.
  const abortRef = useRef(null);
  const seqRef = useRef(0);
  const timerRef = useRef(null);

  const run = useCallback(async (term) => {
    const seq = seqRef.current + 1;
    seqRef.current = seq;
    if (abortRef.current) abortRef.current.abort();
    const controller = new AbortController();
    abortRef.current = controller;
    setState('loading');
    setError(null);
    try {
      const res = await api.get('/shopify-variants/search', {
        params: { q: term },
        signal: controller.signal,
      });
      if (seqRef.current !== seq) return; // superseded by a later keystroke
      setRows(res.data?.data?.variants || []);
      setState('ok');
    } catch (err) {
      if (controller.signal.aborted || seqRef.current !== seq) return;
      // An outage must NOT render as "no products found" — that would read as
      // a claim about the catalog.
      setRows([]);
      setState('error');
      setError(
        err.response?.data?.error?.message ||
          err.response?.data?.error ||
          'Product search is unavailable right now'
      );
    } finally {
      if (abortRef.current === controller) abortRef.current = null;
    }
  }, []);

  useEffect(() => {
    if (timerRef.current) clearTimeout(timerRef.current);
    const term = q.trim();
    if (term.length < Q_MIN) {
      setRows([]);
      setState('idle');
      setError(null);
      return undefined;
    }
    timerRef.current = setTimeout(() => run(term), SEARCH_DEBOUNCE_MS);
    return () => { if (timerRef.current) clearTimeout(timerRef.current); };
  }, [q, run]);

  // Abort anything still on the wire when the inspector switches blocks.
  useEffect(() => () => { if (abortRef.current) abortRef.current.abort(); }, []);

  const pick = (v) => {
    onChange(v.variant_id);
    onPick?.(v);
    setOpen(false);
    setQ('');
    setRows([]);
    setState('idle');
  };

  return (
    <div className="space-y-1.5">
      {/* Current binding — the value that actually ships */}
      <div className="flex items-center gap-2">
        <input
          value={value ?? ''}
          onChange={(e) => onChange(e.target.value.trim() || undefined)}
          placeholder="Shopify variant ID — search below or paste"
          spellCheck={false}
          className={`${inputCls} font-mono text-xs`}
        />
        {value ? (
          <button
            onClick={() => onChange(undefined)}
            title="Clear the wired variant — the bump becomes display-only"
            className="p-1.5 rounded-md text-text-faint hover:text-danger cursor-pointer shrink-0"
          >
            <X className="w-3.5 h-3.5" />
          </button>
        ) : null}
      </div>

      {value ? (
        <p className="flex items-center gap-1.5 text-[11px] text-emerald-400/90">
          <Check className="w-3 h-3 shrink-0" /> Wired — the server charges this variant at the price Shopify holds.
        </p>
      ) : (
        <p className="flex items-start gap-1.5 text-[11px] text-amber-400/90 leading-snug">
          <AlertCircle className="w-3 h-3 mt-0.5 shrink-0" />
          No product assigned — this bump renders but cannot be added to an order.
        </p>
      )}

      <button
        onClick={() => setOpen((o) => !o)}
        className="w-full flex items-center gap-1.5 px-2.5 py-1.5 rounded-md border border-border-default text-xs text-text-muted hover:text-text-primary cursor-pointer"
      >
        <Search className="w-3.5 h-3.5" /> {open ? 'Hide product search' : 'Search Shopify products'}
      </button>

      {open && (
        <div className="rounded-md border border-border-default bg-bg-elevated p-2 space-y-2">
          <input
            autoFocus
            value={q}
            onChange={(e) => setQ(e.target.value)}
            placeholder={`Product or variant name (${Q_MIN}+ characters)`}
            className={inputCls}
          />

          {state === 'loading' && (
            <div className="flex items-center gap-1.5 text-[11px] text-text-faint px-1">
              <Loader2 className="w-3 h-3 animate-spin" /> Searching Shopify…
            </div>
          )}
          {state === 'error' && (
            <div className="flex items-start gap-1.5 text-[11px] text-danger px-1 leading-snug">
              <AlertCircle className="w-3 h-3 mt-0.5 shrink-0" />
              <span>
                {error} — this is a Shopify/connection problem, not an empty catalog.{' '}
                <button onClick={() => run(q.trim())} className="underline cursor-pointer">Retry</button>
              </span>
            </div>
          )}
          {state === 'ok' && !rows.length && (
            <div className="text-[11px] text-text-faint px-1">No products matched “{q.trim()}”.</div>
          )}

          <div className="max-h-56 overflow-y-auto space-y-0.5">
            {rows.map((v) => (
              <button
                key={v.variant_id}
                onClick={() => pick(v)}
                className="w-full flex items-center gap-2 p-1.5 rounded-md text-left hover:bg-bg-hover cursor-pointer"
              >
                {v.image ? (
                  <img src={v.image} alt="" className="w-8 h-8 rounded object-cover shrink-0 bg-bg-card" />
                ) : (
                  <div className="w-8 h-8 rounded shrink-0 bg-bg-card border border-border-subtle" />
                )}
                <div className="min-w-0 flex-1">
                  <div className="text-xs text-text-primary truncate">{v.product_title || '(untitled product)'}</div>
                  <div className="text-[10px] text-text-faint truncate">
                    {v.title || 'Default'}
                    {v.sku ? ` · ${v.sku}` : ''}
                    {v.available === false ? ' · unavailable' : ''}
                  </div>
                </div>
                <span className="text-[11px] font-mono text-text-muted shrink-0">{v.price}</span>
              </button>
            ))}
          </div>
        </div>
      )}

      {help && <p className="text-[11px] text-text-faint leading-relaxed">{help}</p>}
    </div>
  );
}
