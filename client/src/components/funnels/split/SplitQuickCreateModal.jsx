// QUICK-CREATE "Create A/B test" — the lightweight entry point from a page
// node (reference look). Variant A is the page the operator clicked; variant B
// is an existing eligible page; the split starts 50/50 with A as the entry
// arm. On create it hands off to the full SplitSetupModal — this modal owns
// NOTHING beyond the one POST.
//
// Writes lb_split_tests/lb_split_arms only (one POST). Never a ledger row.
import { useCallback, useEffect, useMemo, useState } from 'react';
import { X, Shuffle, AlertTriangle, Loader2, Image as ImageIcon } from 'lucide-react';
import usePageThumbnail from '../usePageThumbnail';
import { createSplitTest, fetchEligiblePages, quickHandleFromSlug, randSuffix4 } from './splitApi';

const ERROR_COPY = {
  invalid_handle: 'Could not derive a valid route handle from this page — rename its slug first.',
  handle_reserved: 'The derived handle is reserved by the platform.',
  handle_exists: 'Another live split on this funnel already owns the derived handle.',
  handle_conflicts_page_slug: 'A page on this funnel already serves at the derived path.',
  need_at_least_two_arms: 'An A/B test needs two arms.',
  server_error: 'The server could not create the test.',
};
const errCode = (err) => err?.response?.data?.error?.code;
const errText = (err, fallback) => ERROR_COPY[errCode(err)] || errCode(err) || fallback;

// Handle derivation + suffix live in splitApi (quickHandleFromSlug /
// randSuffix4) so the length bounds are exercised by the guards harness.

export default function SplitQuickCreateModal({ open, onClose, funnel, pageA, onCreated }) {
  const funnelId = funnel?.id;
  const [eligible, setEligible] = useState({ pages: [], counts: {} });
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);
  const [busy, setBusy] = useState(false);
  const [pageBId, setPageBId] = useState('');

  useEffect(() => {
    if (!open || !funnelId) return;
    setLoading(true);
    setError(null);
    setPageBId('');
    fetchEligiblePages(funnelId)
      .then((e) => setEligible(e))
      .catch(() => setError('Failed to load this funnel’s pages.'))
      .finally(() => setLoading(false));
  }, [open, funnelId]);

  useEffect(() => {
    if (!open) return undefined;
    document.body.style.overflow = 'hidden';
    const onEsc = (e) => e.key === 'Escape' && onClose?.();
    window.addEventListener('keydown', onEsc);
    return () => { document.body.style.overflow = ''; window.removeEventListener('keydown', onEsc); };
  }, [open, onClose]);

  const pageById = useMemo(() => new Map((eligible.pages || []).map((p) => [p.id, p])), [eligible]);
  const aInfo = pageA ? pageById.get(pageA.id) : null;
  const aIneligible = aInfo && !aInfo.eligible ? aInfo.reason_label : null;
  const pageB = pageBId ? pageById.get(pageBId) : null;
  const options = useMemo(
    () => (eligible.pages || []).filter((p) => p.id !== pageA?.id),
    [eligible, pageA]
  );

  const create = useCallback(async () => {
    if (!funnelId || !pageA?.id || !pageBId) return;
    setBusy(true); setError(null);
    const body = (handle) => ({
      funnel_id: funnelId,
      name: `${pageA.title || 'Page'} A/B`,
      scope: 'page',
      handle,
      arms: [
        { arm_key: 'a', weight: 50, page_id: pageA.id, is_control: true, is_entry: true },
        { arm_key: 'b', weight: 50, page_id: pageBId },
      ],
    });
    const base = quickHandleFromSlug(pageA.slug);
    try {
      let created;
      try {
        created = await createSplitTest(body(base));
      } catch (err) {
        // The derived handle being taken is expected occasionally — ONE retry
        // with a random suffix, then the refusal surfaces as prose.
        const code = errCode(err);
        if (code !== 'handle_exists' && code !== 'handle_conflicts_page_slug') throw err;
        created = await createSplitTest(body(`${base}-${randSuffix4()}`));
      }
      onCreated?.(created?.id);
    } catch (err) {
      setError(errText(err, 'Failed to create the A/B test'));
    } finally { setBusy(false); }
  }, [funnelId, pageA, pageBId, onCreated]);

  if (!open || !pageA) return null;

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 backdrop-blur-sm p-4"
      onClick={(e) => { if (e.target === e.currentTarget) onClose?.(); }}
    >
      <div className="w-full max-w-2xl flex flex-col bg-bg-card border border-border-default rounded-xl shadow-2xl overflow-hidden">
        {/* Header */}
        <div className="shrink-0 flex items-start justify-between px-5 py-3.5 border-b border-border-subtle">
          <div className="min-w-0">
            <div className="flex items-center gap-2">
              <Shuffle className="w-4 h-4 text-emerald-400" />
              <h2 className="text-base font-semibold text-text-primary">Create A/B test</h2>
            </div>
            <p className="mt-1 text-xs text-text-muted max-w-md">
              Variant A is this page. Pick an existing page for variant B — traffic starts at a 50/50
              split (adjust the weights any time after).
            </p>
          </div>
          <button
            onClick={onClose}
            className="p-1 rounded-md text-text-muted hover:text-text-primary hover:bg-bg-hover transition-colors cursor-pointer"
            title="Close"
          >
            <X className="w-4 h-4" />
          </button>
        </div>

        {/* Body */}
        <div className="px-5 py-4 space-y-4">
          {error && (
            <div className="flex items-start gap-2 px-3 py-2 rounded-lg border border-red-500/20 bg-red-500/10 text-sm text-red-400">
              <AlertTriangle className="w-4 h-4 mt-0.5 shrink-0" />
              <span>{error}</span>
            </div>
          )}
          {aIneligible && (
            <div className="flex items-start gap-2 px-3 py-2 rounded-lg border border-amber-500/20 bg-amber-500/10 text-xs text-amber-400">
              <AlertTriangle className="w-4 h-4 mt-0.5 shrink-0" />
              <span>This page can&apos;t be an arm of a split: {aIneligible}.</span>
            </div>
          )}

          <div className="grid gap-4 sm:grid-cols-2">
            {/* Variant A — the clicked page */}
            <VariantPanel
              label="Variant A"
              funnelId={funnelId}
              page={pageA}
              caption="Weight 50%"
            />
            {/* Variant B — picked from the eligible pages */}
            <div className="rounded-xl border border-border-default bg-bg-elevated/40 p-3 space-y-2">
              <div className="text-[10px] font-semibold uppercase tracking-wide text-text-faint">Variant B</div>
              <VariantThumb funnelId={funnelId} page={pageB} emptyLabel="Pick a page" />
              <label htmlFor="split-quick-page-b" className="block text-xs font-medium text-text-muted">
                Variant B page
              </label>
              <select
                id="split-quick-page-b"
                value={pageBId}
                onChange={(e) => setPageBId(e.target.value)}
                disabled={loading || busy}
                className="w-full px-2.5 py-1.5 text-sm bg-bg-elevated border border-border-default rounded-lg
                  text-text-primary focus:outline-none focus:ring-2 focus:ring-accent/40 focus:border-accent
                  transition-colors cursor-pointer disabled:opacity-40"
              >
                <option value="">{loading ? 'Loading pages…' : 'Pick a page'}</option>
                {options.map((p) => (
                  <option key={p.id} value={p.id} disabled={!p.eligible}>
                    {p.title || 'Untitled'} ({p.slug})
                    {p.eligible ? '' : ` — ${p.reason_label}`}
                    {p.eligible && p.status !== 'published' ? " · draft (won't serve until published)" : ''}
                  </option>
                ))}
              </select>
              {!loading && options.every((p) => !p.eligible) && (
                <p className="text-[11px] text-text-faint leading-snug">
                  No other page on this funnel is eligible — duplicate one from the split settings instead.
                </p>
              )}
              <div className="text-[11px] text-text-faint">Weight 50%</div>
            </div>
          </div>
        </div>

        {/* Footer */}
        <div className="shrink-0 flex items-center justify-end gap-2 px-5 py-3 border-t border-border-subtle bg-bg-elevated/30">
          {busy && <Loader2 className="w-4 h-4 animate-spin text-text-faint" />}
          <button
            type="button"
            onClick={onClose}
            disabled={busy}
            className="px-3 py-1.5 rounded-lg border border-border-default text-sm text-text-muted
              hover:text-text-primary hover:bg-bg-hover transition-colors cursor-pointer disabled:opacity-40"
          >
            Cancel
          </button>
          <button
            type="button"
            onClick={create}
            disabled={busy || loading || !pageBId || Boolean(aIneligible)}
            className="px-3 py-1.5 rounded-lg bg-emerald-600 hover:bg-emerald-500 text-sm font-medium text-white
              transition-colors cursor-pointer disabled:opacity-40 disabled:cursor-not-allowed"
          >
            Create A/B test
          </button>
        </div>
      </div>
    </div>
  );
}

function VariantPanel({ label, funnelId, page, caption }) {
  return (
    <div className="rounded-xl border border-border-default bg-bg-elevated/40 p-3 space-y-2">
      <div className="text-[10px] font-semibold uppercase tracking-wide text-text-faint">{label}</div>
      <VariantThumb funnelId={funnelId} page={page} />
      <div className="min-w-0">
        <div className="text-sm font-medium text-text-primary truncate">{page?.title || 'Untitled'}</div>
        <div className="text-[11px] text-text-faint font-mono truncate">{page?.slug || '—'}</div>
      </div>
      <div className="text-[11px] text-text-faint">{caption}</div>
    </div>
  );
}

function VariantThumb({ funnelId, page, emptyLabel }) {
  const thumbUrl = usePageThumbnail(
    page?.id && funnelId ? { id: page.id, funnel_id: funnelId, updated_at: page.updated_at } : null
  );
  return (
    <div className="relative h-24 rounded-lg border border-border-subtle overflow-hidden flex items-center justify-center bg-gradient-to-br from-white/[0.04] to-transparent">
      {thumbUrl ? (
        <img src={thumbUrl} alt="" draggable={false} className="absolute inset-0 w-full h-full object-cover object-top" />
      ) : (
        <span className="inline-flex items-center gap-1.5 text-[11px] text-text-faint">
          <ImageIcon className="w-3.5 h-3.5" /> {page ? 'No preview yet' : (emptyLabel || 'No page')}
        </span>
      )}
    </div>
  );
}
