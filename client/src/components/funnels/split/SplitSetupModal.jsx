// SPLIT SETUP MODAL — "Split Pages /<handle>".
//
// The operator surface for defining WHAT is being tested: the route the split
// owns, the domain it serves on, and the arms behind it. Modelled on the
// reference tool and on funnel-os's lb_split_groups ("slug — the canonical
// route it owns").
//
// THIS MODAL IS READ-ONLY WITH RESPECT TO THE LEDGER. It writes lb_split_tests
// and lb_split_arms rows only. No action in here — not Preview, not switching
// the entry arm, not adding an arm — can create an exposure or a credit row.
// The ledger is written by real buyer traffic and by the settle path, nowhere
// else. That is what makes the numbers in the results modal mean anything.
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { X, Monitor, Shuffle, Pencil, Copy, Plus, AlertTriangle, Loader2 } from 'lucide-react';
import api from '../../../services/api';
import {
  fetchSplitTest, patchSplitTest, patchSplitArm, addSplitArm, setSplitEntryArm,
  fetchEligiblePages, armLetter, weightSum, fmtDate, handlePath, num,
} from './splitApi';

const ERROR_COPY = {
  invalid_handle: 'Handle must be lowercase letters, numbers and dashes (max 64).',
  invalid_domain: 'That does not look like a domain name.',
  handle_exists: 'Another live split on this funnel already owns that handle.',
  arm_key_exists: 'An arm with that key already exists.',
  multiple_control_arms: 'Another arm is already the control.',
  arm_archived: 'That arm is archived — restore it before making it the entry.',
  not_found: 'That test or arm no longer exists — reloading.',
};
const errText = (err, fallback) =>
  ERROR_COPY[err?.response?.data?.error?.code] || err?.response?.data?.error?.code || fallback;

export default function SplitSetupModal({ open, onClose, funnel, testId, onTestChanged }) {
  const navigate = useNavigate();
  const [test, setTest] = useState(null);
  const [eligible, setEligible] = useState({ pages: [], counts: {} });
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);
  const [busy, setBusy] = useState(false);

  // Local drafts — the inputs stay responsive while the PATCH is in flight and
  // are reconciled from the server response, never from the optimistic value.
  const [handleDraft, setHandleDraft] = useState('');
  const [weightDrafts, setWeightDrafts] = useState({});
  const [importOpen, setImportOpen] = useState(false);

  const funnelId = funnel?.id;

  const load = useCallback(async () => {
    if (!testId || !funnelId) return;
    setError(null);
    try {
      const [t, e] = await Promise.all([
        fetchSplitTest(testId),
        fetchEligiblePages(funnelId, testId),
      ]);
      setTest(t);
      setEligible(e);
      setHandleDraft(t?.handle || '');
      setWeightDrafts(Object.fromEntries((t?.arms || []).map((a) => [a.id, String(num(a.weight) ?? 0)])));
    } catch (err) {
      setError(errText(err, 'Failed to load this split test'));
    } finally {
      setLoading(false);
    }
  }, [testId, funnelId]);

  useEffect(() => { if (open) { setLoading(true); load(); } }, [open, load]);

  useEffect(() => {
    if (!open) return undefined;
    document.body.style.overflow = 'hidden';
    const onEsc = (e) => e.key === 'Escape' && onClose?.();
    window.addEventListener('keydown', onEsc);
    return () => { document.body.style.overflow = ''; window.removeEventListener('keydown', onEsc); };
  }, [open, onClose]);

  const liveArms = useMemo(() => (test?.arms || []).filter((a) => !a.archived), [test]);
  const { sum: wSum, ok: wOk } = useMemo(() => weightSum(liveArms), [liveArms]);
  const pageById = useMemo(
    () => new Map((eligible.pages || []).map((p) => [p.id, p])),
    [eligible]
  );
  const handle = test?.handle || '';

  // ── Mutations ───────────────────────────────────────────────────────────
  const applyTest = useCallback((updated) => {
    if (!updated) return;
    setTest((t) => ({ ...t, ...updated }));
    onTestChanged?.();
  }, [onTestChanged]);

  const saveHandle = useCallback(async () => {
    const v = handleDraft.trim().replace(/^\//, '');
    if (v === (test?.handle || '')) return;
    setBusy(true); setError(null);
    try {
      applyTest(await patchSplitTest(testId, { handle: v }));
    } catch (err) {
      setError(errText(err, 'Failed to save the handle'));
      setHandleDraft(test?.handle || ''); // reconcile: the server refused
    } finally { setBusy(false); }
  }, [handleDraft, test, testId, applyTest]);

  const saveDomain = useCallback(async (value) => {
    setBusy(true); setError(null);
    try {
      applyTest(await patchSplitTest(testId, { domain: value || '' }));
    } catch (err) {
      setError(errText(err, 'Failed to save the domain'));
      load();
    } finally { setBusy(false); }
  }, [testId, applyTest, load]);

  const saveWeight = useCallback(async (arm) => {
    const raw = weightDrafts[arm.id];
    const w = num(raw);
    if (w === undefined || w < 0) {
      setWeightDrafts((d) => ({ ...d, [arm.id]: String(num(arm.weight) ?? 0) }));
      return;
    }
    if (w === num(arm.weight)) return;
    setBusy(true); setError(null);
    try {
      await patchSplitArm(testId, arm.id, { weight: w });
      setTest((t) => ({ ...t, arms: t.arms.map((a) => (a.id === arm.id ? { ...a, weight: w } : a)) }));
      onTestChanged?.();
    } catch (err) {
      setError(errText(err, 'Failed to save the weight'));
      load();
    } finally { setBusy(false); }
  }, [weightDrafts, testId, onTestChanged, load]);

  const makeEntry = useCallback(async (arm) => {
    if (arm.is_entry) return;
    setBusy(true); setError(null);
    try {
      await setSplitEntryArm(testId, arm.id);
      // Re-read rather than patch locally: the entry move touches TWO rows and
      // the server is the only thing that knows which one lost the flag.
      await load();
      onTestChanged?.();
    } catch (err) {
      setError(errText(err, 'Failed to move the entry arm'));
      load();
    } finally { setBusy(false); }
  }, [testId, load, onTestChanged]);

  // PREVIEW — the authenticated render of the SAVED page. It resolves through
  // the funnel's own preview-url endpoint (which returns the public path plus
  // a `preview` flag) and opens it with ?preview=1. It never touches the split
  // route, so the resolver never runs and NO exposure row is written.
  const previewArm = useCallback(async (arm) => {
    if (!arm.page_id) { setError('That arm has no page yet.'); return; }
    setError(null);
    try {
      const res = await api.get(`/funnels/${funnelId}/pages/${arm.page_id}/preview-url`);
      const { path, preview } = res.data?.data || {};
      if (path) window.open(preview ? `${path}?preview=1` : path, '_blank', 'noopener');
    } catch {
      setError('Failed to build the preview URL for that arm');
    }
  }, [funnelId]);

  const editArm = useCallback((arm) => {
    if (!arm.page_id) { setError('That arm has no page yet.'); return; }
    onClose?.();
    navigate(`/app/funnels/${funnelId}/pages/${arm.page_id}/builder`);
  }, [funnelId, navigate, onClose]);

  // ADD ARM — duplicate the entry arm's page, or import an existing eligible
  // page. Both end in one POST to /arms; neither writes a ledger row.
  const nextArmKey = useCallback(() => {
    const used = new Set(liveArms.map((a) => String(a.arm_key)));
    for (let i = 0; i < 26 * 27; i++) {
      const k = armLetter(i).toLowerCase();
      if (!used.has(k)) return k;
    }
    return `arm${Date.now()}`;
  }, [liveArms]);

  const addFromPage = useCallback(async (pageId) => {
    setBusy(true); setError(null);
    try {
      await addSplitArm(testId, { arm_key: nextArmKey(), weight: 0, page_id: pageId });
      await load();
      onTestChanged?.();
      setImportOpen(false);
    } catch (err) {
      setError(errText(err, 'Failed to add the arm'));
    } finally { setBusy(false); }
  }, [testId, nextArmKey, load, onTestChanged]);

  const duplicateAndAdd = useCallback(async () => {
    const source = liveArms.find((a) => a.is_entry) || liveArms[0];
    const srcPage = source?.page_id ? pageById.get(source.page_id) : null;
    if (!srcPage) { setError('No source page to duplicate — add a page to this funnel first.'); return; }
    setBusy(true); setError(null);
    try {
      const suffix = Math.random().toString(16).slice(2, 6);
      const res = await api.post(`/funnels/${funnelId}/pages`, {
        title: `${srcPage.title || 'Page'} copy`,
        slug: `/${srcPage.type || 'page'}-${suffix}`,
        type: srcPage.type || 'generic',
      });
      const np = res.data?.data;
      // Carry the blocks over. Non-fatal: an arm with an empty page is still a
      // valid arm, and failing the whole add would strand the created page.
      try {
        const full = await api.get(`/funnels/${funnelId}`);
        const src = (full.data?.data?.pages || []).find((p) => p.id === srcPage.id);
        if (src) await api.patch(`/funnels/${funnelId}/pages/${np.id}`, { blocks: src.blocks ?? [] });
      } catch { /* non-fatal — the arm still exists with an empty page */ }
      await addSplitArm(testId, { arm_key: nextArmKey(), weight: 0, page_id: np.id });
      await load();
      onTestChanged?.();
    } catch (err) {
      setError(errText(err, 'Failed to duplicate a page for the new arm'));
    } finally { setBusy(false); }
  }, [liveArms, pageById, funnelId, testId, nextArmKey, load, onTestChanged]);

  if (!open) return null;

  const ineligible = (eligible.pages || []).filter((p) => !p.eligible);
  const importable = (eligible.pages || []).filter(
    (p) => p.eligible && !liveArms.some((a) => a.page_id === p.id)
  );
  const counts = eligible.counts || {};
  const livePath = handlePath(handle);

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 backdrop-blur-sm p-4"
      onClick={(e) => { if (e.target === e.currentTarget) onClose?.(); }}
    >
      <div className="w-full max-w-5xl max-h-[88vh] flex flex-col bg-bg-card border border-border-default rounded-xl shadow-2xl overflow-hidden">
        {/* ── Header ─────────────────────────────────────────────── */}
        <div className="shrink-0 flex items-start justify-between px-5 py-3.5 border-b border-border-subtle">
          <div className="min-w-0">
            <div className="flex items-center gap-2.5 min-w-0">
              <h2 className="text-base font-semibold text-text-primary">Split Pages</h2>
              <span className="text-sm text-emerald-400 font-mono truncate">/{handle || '…'}</span>
            </div>
            <p className="mt-0.5 text-xs text-text-faint">
              {liveArms.length} {liveArms.length === 1 ? 'arm' : 'arms'}
              {' · '}Created {fmtDate(test?.created_at)}
              {' · '}Last edited {fmtDate(test?.updated_at)}
            </p>
          </div>
          <div className="flex items-center gap-2">
            {busy && <Loader2 className="w-4 h-4 animate-spin text-text-faint" />}
            <button
              onClick={onClose}
              className="p-1 rounded-md text-text-muted hover:text-text-primary hover:bg-bg-hover transition-colors cursor-pointer"
              title="Close"
            >
              <X className="w-4 h-4" />
            </button>
          </div>
        </div>

        {/* ── Body ───────────────────────────────────────────────── */}
        <div className="flex-1 overflow-y-auto px-5 py-4 space-y-5">
          {error && (
            <div className="flex items-start gap-2 px-3 py-2 rounded-lg border border-red-500/20 bg-red-500/10 text-sm text-red-400">
              <AlertTriangle className="w-4 h-4 mt-0.5 shrink-0" />
              <span>{error}</span>
            </div>
          )}

          {loading ? (
            <div className="py-16 text-center text-text-muted text-sm">Loading split…</div>
          ) : !test ? (
            <div className="py-16 text-center text-text-muted text-sm">This split test could not be loaded.</div>
          ) : (
            <>
              <section className="space-y-4">
                <div>
                  <h3 className="text-sm font-semibold text-text-primary">What&apos;s being tested</h3>
                  <p className="mt-1 text-xs text-text-muted">
                    One route, one domain, and the arms it serves. Preview shows an arm without touching live traffic.
                  </p>
                </div>

                {/* Handle + domain */}
                <div className="grid gap-4 sm:grid-cols-2">
                  <div className="space-y-1">
                    <label htmlFor="split-handle" className="block text-xs font-medium text-text-muted">Split handle</label>
                    <div className="flex items-stretch">
                      <span className="inline-flex items-center px-2.5 rounded-l-lg border border-r-0 border-border-default bg-bg-elevated text-sm text-text-faint font-mono">/</span>
                      <input
                        id="split-handle"
                        value={handleDraft}
                        onChange={(e) => setHandleDraft(e.target.value)}
                        onBlur={saveHandle}
                        onKeyDown={(e) => e.key === 'Enter' && e.currentTarget.blur()}
                        placeholder="offer"
                        autoComplete="off"
                        spellCheck={false}
                        className="flex-1 min-w-0 px-3 py-2 text-sm bg-bg-elevated border border-border-default rounded-r-lg
                          text-text-primary placeholder:text-text-faint font-mono
                          focus:outline-none focus:ring-2 focus:ring-accent/40 focus:border-accent transition-colors"
                      />
                    </div>
                    <p className="text-[11px] text-text-faint">
                      Traffic is sent to this link: <span className="font-mono">/{handleDraft.trim().replace(/^\//, '') || '…'}</span>
                    </p>
                  </div>

                  <div className="space-y-1">
                    <label htmlFor="split-domain" className="block text-xs font-medium text-text-muted">Domain</label>
                    <select
                      id="split-domain"
                      value={test.domain || ''}
                      onChange={(e) => saveDomain(e.target.value)}
                      className="w-full px-3 py-2 text-sm bg-bg-elevated border border-border-default rounded-lg
                        text-text-primary focus:outline-none focus:ring-2 focus:ring-accent/40 focus:border-accent
                        transition-colors cursor-pointer"
                    >
                      <option value="">Funnel default</option>
                      {[funnel?.custom_domain, test.domain]
                        .filter((d, i, arr) => d && arr.indexOf(d) === i)
                        .map((d) => <option key={d} value={d}>{d}</option>)}
                    </select>
                    <p className="text-[11px] text-text-faint">
                      Applies to all variants — the whole split serves on this domain (blank = funnel default).
                    </p>
                  </div>
                </div>

                {/* Weight warning */}
                {!wOk && liveArms.length > 0 && (
                  <div className="flex items-start gap-2 px-3 py-2 rounded-lg border border-amber-500/20 bg-amber-500/10 text-xs text-amber-400">
                    <AlertTriangle className="w-4 h-4 mt-0.5 shrink-0" />
                    <span>
                      Weights add up to {wSum}%, not 100%. Traffic is still split in proportion to the numbers you
                      set — serving never rejects — but the percentages shown here will not match what arms actually receive.
                    </span>
                  </div>
                )}

                {/* ── Arm cards ─────────────────────────────────── */}
                <div className="flex flex-wrap gap-3">
                  {liveArms.map((arm, i) => (
                    <ArmCard
                      key={arm.id}
                      arm={arm}
                      letter={armLetter(i)}
                      page={arm.page_id ? pageById.get(arm.page_id) : null}
                      weightDraft={weightDrafts[arm.id] ?? ''}
                      onWeightDraft={(v) => setWeightDrafts((d) => ({ ...d, [arm.id]: v }))}
                      onWeightCommit={() => saveWeight(arm)}
                      onPreview={() => previewArm(arm)}
                      onEntry={() => makeEntry(arm)}
                      onEdit={() => editArm(arm)}
                      disabled={busy}
                    />
                  ))}

                  {/* Add arm card */}
                  <div className="w-56 shrink-0 rounded-xl border border-dashed border-border-default bg-bg-elevated/30 p-3 flex flex-col gap-2">
                    <div className="text-sm font-medium text-text-primary">
                      + Add Split {armLetter(liveArms.length)}
                    </div>
                    <button
                      type="button"
                      onClick={duplicateAndAdd}
                      disabled={busy}
                      className="flex items-center justify-center gap-1.5 px-2.5 py-1.5 rounded-lg border border-border-default
                        text-xs text-text-muted hover:text-text-primary hover:bg-bg-hover transition-colors cursor-pointer
                        disabled:opacity-40 disabled:cursor-not-allowed"
                    >
                      <Copy className="w-3.5 h-3.5" /> Duplicate a page
                    </button>
                    <div className="relative">
                      <button
                        type="button"
                        onClick={() => setImportOpen((v) => !v)}
                        disabled={busy}
                        className="w-full flex items-center justify-center gap-1.5 px-2.5 py-1.5 rounded-lg border border-border-default
                          text-xs text-text-muted hover:text-text-primary hover:bg-bg-hover transition-colors cursor-pointer
                          disabled:opacity-40 disabled:cursor-not-allowed"
                      >
                        <Plus className="w-3.5 h-3.5" /> Import existing page
                      </button>
                      {importOpen && (
                        <div className="absolute z-30 mt-1 left-0 right-0 max-h-56 overflow-y-auto rounded-lg bg-bg-elevated border border-border-default shadow-xl py-1">
                          {importable.length === 0 && ineligible.length === 0 && (
                            <div className="px-2.5 py-2 text-[11px] text-text-faint">No other pages on this funnel.</div>
                          )}
                          {importable.map((p) => (
                            <button
                              key={p.id}
                              type="button"
                              onClick={() => addFromPage(p.id)}
                              className="w-full text-left px-2.5 py-1.5 text-xs text-text-muted hover:text-text-primary hover:bg-bg-hover cursor-pointer"
                            >
                              <span className="block truncate">{p.title || 'Untitled'}</span>
                              <span className="block font-mono text-[10px] text-text-faint truncate">{p.slug}</span>
                            </button>
                          ))}
                          {/* Ineligible pages are LISTED, greyed, with the reason. */}
                          {ineligible.map((p) => (
                            <div
                              key={p.id}
                              className="px-2.5 py-1.5 text-xs opacity-40 cursor-not-allowed"
                              title={`Can't be an arm: ${p.reason_label}`}
                            >
                              <span className="block truncate text-text-muted">{p.title || 'Untitled'}</span>
                              <span className="block font-mono text-[10px] text-text-faint truncate">
                                {p.slug} · {p.reason_label}
                              </span>
                            </div>
                          ))}
                        </div>
                      )}
                    </div>
                    {ineligible.length > 0 && (
                      <p className="text-[11px] text-text-faint leading-snug">
                        {ineligible.length} of this funnel&apos;s pages can&apos;t be an arm
                        {' ('}
                        {[
                          counts.post_purchase ? `${counts.post_purchase} post-purchase` : null,
                          counts.funnel_default ? `${counts.funnel_default} funnel default` : null,
                          counts.in_other_test ? `${counts.in_other_test} in another split` : null,
                        ].filter(Boolean).join(', ')}
                        {') '}
                        — they&apos;re listed greyed out with the reason.
                      </p>
                    )}
                  </div>
                </div>

                {/* Entry-arm footnote */}
                <div className="rounded-lg border border-emerald-500/20 bg-emerald-500/5 px-3 py-2.5">
                  <p className="text-xs text-text-muted">
                    Live link = the split entry{' '}
                    {livePath
                      ? <span className="font-mono text-emerald-400">{livePath}</span>
                      : <span className="font-mono text-text-faint">/{handle || '…'}</span>}
                    : it re-splits, can show another variant, pins you for 30 days and counts an impression in
                    section 3.
                  </p>
                </div>
              </section>
            </>
          )}
        </div>

        {/* ── Legend ─────────────────────────────────────────────── */}
        <div className="shrink-0 border-t border-border-subtle px-5 py-3 bg-bg-elevated/30">
          <p className="text-[11px] leading-relaxed text-text-faint">
            <strong className="text-text-muted">Preview</strong> opens the authenticated render of the saved page —
            no pixels, no impression, and always the arm you clicked.{' '}
            <strong className="text-text-muted">View live</strong> opens the real domain: it fires this funnel&apos;s
            pixels and counts a human impression in the tiles below.{' '}
            <strong className="text-text-muted">Entry</strong> marks the arm served at /{handle || '…'} itself —
            opening it re-splits and may show a different arm.{' '}
            <strong className="text-text-muted">Edit page</strong> opens that arm in the page builder.
          </p>
        </div>
      </div>
    </div>
  );
}

// ── One arm ────────────────────────────────────────────────────────────────
function ArmCard({
  arm, letter, page, weightDraft, onWeightDraft, onWeightCommit,
  onPreview, onEntry, onEdit, disabled,
}) {
  const inputRef = useRef(null);
  const iconBtn =
    'p-1.5 rounded-md text-text-muted hover:text-text-primary hover:bg-bg-hover transition-colors cursor-pointer disabled:opacity-40 disabled:cursor-not-allowed';

  return (
    <div
      className={`w-56 shrink-0 rounded-xl border bg-bg-elevated/40 p-3 space-y-2 ${
        arm.is_entry ? 'border-emerald-500/40' : 'border-border-default'
      }`}
    >
      {/* Thumbnail placeholder + letter + weight */}
      <div className="relative h-24 rounded-lg border border-border-subtle bg-gradient-to-br from-white/[0.04] to-transparent flex items-center justify-center">
        <span className="inline-flex items-center justify-center w-8 h-8 rounded-lg bg-bg-card border border-border-default text-sm font-bold text-text-primary">
          {letter}
        </span>
        <div className="absolute top-1.5 right-1.5 flex items-center gap-0.5 px-1 py-0.5 rounded-md bg-bg-card/90 border border-border-default">
          <input
            ref={inputRef}
            type="number"
            min="0"
            max="100"
            step="1"
            value={weightDraft}
            onChange={(e) => onWeightDraft(e.target.value)}
            onBlur={onWeightCommit}
            onKeyDown={(e) => e.key === 'Enter' && e.currentTarget.blur()}
            disabled={disabled}
            aria-label={`Arm ${letter} traffic weight, percent`}
            className="w-9 bg-transparent text-right text-[11px] tabular-nums text-text-primary focus:outline-none
              [appearance:textfield] [&::-webkit-outer-spin-button]:appearance-none [&::-webkit-inner-spin-button]:appearance-none"
          />
          <span className="text-[11px] text-text-faint">%</span>
        </div>
        {arm.is_entry && (
          <span className="absolute top-1.5 left-1.5 px-1.5 py-0.5 rounded text-[9px] font-semibold uppercase tracking-wide
            bg-emerald-500/15 text-emerald-400 border border-emerald-500/30">
            Entry
          </span>
        )}
      </div>

      {/* Page identity */}
      <div className="min-w-0">
        <div className="text-sm font-medium text-text-primary truncate">
          {page?.title || (arm.page_id ? 'Page not on this funnel' : 'No page yet')}
        </div>
        <div className="text-[11px] text-text-faint font-mono truncate">{page?.slug || '—'}</div>
        {arm.is_entry && (
          <div className="mt-0.5 text-[10px] font-semibold uppercase tracking-wide text-emerald-400/80">
            Default arm
          </div>
        )}
      </div>

      {/* Per-arm actions */}
      <div className="flex items-center gap-0.5 pt-0.5 border-t border-border-subtle">
        <button type="button" className={iconBtn} title="Preview this arm (no impression)" onClick={onPreview} disabled={disabled}>
          <Monitor className="w-4 h-4" />
        </button>
        <button
          type="button"
          className={`${iconBtn} ${arm.is_entry ? 'text-emerald-400' : ''}`}
          title={arm.is_entry ? 'This arm is the entry' : 'Make this the entry arm'}
          onClick={onEntry}
          disabled={disabled || arm.is_entry}
        >
          <Shuffle className="w-4 h-4" />
        </button>
        <button type="button" className={iconBtn} title="Edit page in the builder" onClick={onEdit} disabled={disabled}>
          <Pencil className="w-4 h-4" />
        </button>
      </div>
    </div>
  );
}
