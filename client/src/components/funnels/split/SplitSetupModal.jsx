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
import { useCallback, useEffect, useMemo, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { X, Monitor, Shuffle, Pencil, Copy, AlertTriangle, Loader2, ExternalLink } from 'lucide-react';
import api from '../../../services/api';
import usePageThumbnail from '../usePageThumbnail';
import {
  fetchSplitTest, patchSplitTest, patchSplitArm, addSplitArm, setSplitEntryArm,
  fetchEligiblePages, armLetter, weightSum, fmtDate, handlePath, num, armLiveUrl,
} from './splitApi';
import {
  pageOptionText, partitionArmPages, ineligibleCountsPhrase, nextSplitLetter,
} from './splitUiCopy';

// One select skin, shared by the import column and the per-arm page pickers.
const selectCls = `w-full px-2.5 py-1.5 text-xs bg-bg-elevated border border-border-default rounded-lg
  text-text-primary focus:outline-none focus:ring-2 focus:ring-accent/40 focus:border-accent
  transition-colors cursor-pointer disabled:opacity-40 disabled:cursor-not-allowed`;

const ERROR_COPY = {
  invalid_handle: 'Handle must be lowercase letters, numbers and dashes (max 64).',
  handle_reserved: 'That handle is reserved by the platform — pick another one.',
  handle_exists: 'Another live split on this funnel already owns that handle.',
  handle_conflicts_page_slug: 'A page on this funnel already serves at that path — the split and the page cannot both own it.',
  invalid_domain: 'That does not look like a domain name.',
  arm_key_exists: 'An arm with that key already exists.',
  multiple_control_arms: 'Another arm is already the control.',
  // Reachable from the API, not from this modal today — but if the modal ever
  // grows an archive/control control, the operator gets a sentence, not a code.
  control_required: 'Every split needs one control arm — move the control to another arm first.',
  last_live_arm: 'This is the last live arm — archiving it would leave the split route with nothing behind it.',
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
  // Per-PAGE inline refusals (slug collision etc.) — prose that stays on the
  // card until the next commit, never a toast that vanishes.
  const [pageErrors, setPageErrors] = useState({});

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
      setPageErrors({});
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
  // Weighted live arms whose page is a DRAFT: the serve path only delivers
  // published arms and silently re-picks, so these hold weight while receiving
  // zero traffic — the strip below is the only place that says so.
  const draftWeightedLetters = useMemo(
    () => liveArms
      .map((a, i) => ({ a, letter: armLetter(i) }))
      .filter(({ a }) => (num(a.weight) ?? 0) > 0)
      .filter(({ a }) => {
        const p = a.page_id ? pageById.get(a.page_id) : null;
        return Boolean(p) && p.status !== 'published';
      })
      .map(({ letter }) => letter),
    [liveArms, pageById]
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

  // 2-ARM SLIDER COMMIT — one drag sets BOTH weights, sum locked to 100.
  // Same PATCH-per-arm contract as saveWeight; nothing new server-side.
  const saveWeightPair = useCallback(async (v) => {
    if (liveArms.length !== 2) return;
    const [a, b] = liveArms;
    const w = Math.min(100, Math.max(0, Math.round(num(v) ?? 50)));
    if (w === num(a.weight) && 100 - w === num(b.weight)) return;
    setBusy(true); setError(null);
    try {
      await patchSplitArm(testId, a.id, { weight: w });
      await patchSplitArm(testId, b.id, { weight: 100 - w });
      setTest((t) => ({
        ...t,
        arms: t.arms.map((x) =>
          x.id === a.id ? { ...x, weight: w } : x.id === b.id ? { ...x, weight: 100 - w } : x
        ),
      }));
      setWeightDrafts((d) => ({ ...d, [a.id]: String(w), [b.id]: String(100 - w) }));
      onTestChanged?.();
    } catch (err) {
      setError(errText(err, 'Failed to save the weights'));
      load();
    } finally { setBusy(false); }
  }, [liveArms, testId, onTestChanged, load]);

  // PAGE-LEVEL edits (name / slug / seo-title) go through the funnels pages
  // PATCH. A refusal (e.g. a slug collision, a 409 with prose) lands in
  // pageErrors[pageId] and stays inline on the card. Returns the updated page
  // row, or null when the server refused (the caller reconciles its draft).
  const patchPage = useCallback(async (page, patch) => {
    if (!page?.id) return null;
    setBusy(true);
    setPageErrors((e) => ({ ...e, [page.id]: null }));
    try {
      const res = await api.patch(`/funnels/${funnelId}/pages/${page.id}`, patch);
      const updated = res.data?.data;
      if (updated) {
        // Reconcile the eligible-pages projection in place — a full reload
        // would blank every draft the operator is mid-way through.
        setEligible((e) => ({
          ...e,
          pages: (e.pages || []).map((p) =>
            p.id === updated.id
              ? {
                  ...p,
                  title: updated.title,
                  slug: updated.slug,
                  seo: updated.seo || {},
                  updated_at: updated.updated_at,
                  status: updated.status,
                  is_home: updated.is_home,
                }
              : p
          ),
        }));
      }
      onTestChanged?.();
      return updated || null;
    } catch (err) {
      // funnels.js answers { error: '<prose>' } (not { error: { code } }).
      const prose = err?.response?.data?.error;
      setPageErrors((e) => ({
        ...e,
        [page.id]: typeof prose === 'string' && prose ? prose : 'Failed to save the page',
      }));
      return null;
    } finally { setBusy(false); }
  }, [funnelId, onTestChanged]);

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
    } catch (err) {
      setError(errText(err, 'Failed to add the arm'));
    } finally { setBusy(false); }
  }, [testId, nextArmKey, load, onTestChanged]);

  // "Choose / import page" — re-point an EXISTING arm at a different page.
  // One PATCH. The arm keeps its key, its weight and its ledger history: every
  // credit row is keyed by arm_key, so past exposures stay attributed to the
  // ARM, not to the page that used to be behind it.
  //
  // Never offered on the first arm. Arm A is the split's original page — the
  // thing every other arm is being compared against — and swapping it silently
  // would change what "the control" means without changing a single number.
  const setArmPage = useCallback(async (arm, pageId) => {
    if (!pageId || pageId === arm.page_id) return;
    setBusy(true); setError(null);
    try {
      await patchSplitArm(testId, arm.id, { page_id: pageId });
      await load();
      onTestChanged?.();
    } catch (err) {
      setError(errText(err, 'Failed to change this arm’s page'));
      load();
    } finally { setBusy(false); }
  }, [testId, load, onTestChanged]);

  const duplicateAndAdd = useCallback(async () => {
    const source = liveArms.find((a) => a.is_entry) || liveArms[0];
    const srcPage = source?.page_id ? pageById.get(source.page_id) : null;
    if (!srcPage) { setError('No source page to duplicate — add a page to this funnel first.'); return; }
    setBusy(true); setError(null);
    try {
      // ATOMIC server-side copy: page row + blocks + escape-hatch fields land
      // together or not at all (POST .../duplicate). The old 3-call composite
      // swallowed a failed blocks PATCH and could silently arm an EMPTY page.
      const res = await api.post(`/funnels/${funnelId}/pages/${srcPage.id}/duplicate`);
      const np = res.data?.data;
      await addSplitArm(testId, { arm_key: nextArmKey(), weight: 0, page_id: np.id });
      await load();
      onTestChanged?.();
    } catch (err) {
      // The duplicate route answers { error: '<prose>' }; the arms route
      // answers { error: { code } } — surface whichever refused.
      const prose = err?.response?.data?.error;
      setError(typeof prose === 'string' && prose
        ? prose
        : errText(err, 'Failed to duplicate a page for the new arm'));
    } finally { setBusy(false); }
  }, [liveArms, pageById, funnelId, testId, nextArmKey, load, onTestChanged]);

  if (!open) return null;

  const { importable, ineligible } = partitionArmPages({ pages: eligible.pages, liveArms });
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
            </p>
          </div>
          <div className="flex items-start gap-3">
            {/* PAGE ANALYTICS — the split's own row timestamps, top-right
                (reference placement). These are the lb_split_tests row's
                created_at/updated_at: when the TEST was defined and last
                edited. They are NOT traffic figures — the numbers live in the
                results modal, and nothing here is windowed. */}
            <div className="hidden sm:block text-right leading-tight">
              <div className="text-[10px] font-semibold uppercase tracking-wide text-text-faint">
                Page Analytics
              </div>
              <div className="mt-0.5 text-[11px] text-text-muted whitespace-nowrap">
                Created {fmtDate(test?.created_at)}
              </div>
              <div className="text-[11px] text-text-muted whitespace-nowrap">
                Last edited {fmtDate(test?.updated_at)}
              </div>
            </div>
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
                  <h3 className="flex items-center gap-2 text-sm font-semibold text-text-primary">
                    <span className="inline-flex items-center justify-center w-5 h-5 rounded-md bg-bg-elevated border border-border-default text-[11px] font-semibold text-text-muted">
                      1
                    </span>
                    What&apos;s being tested
                  </h3>
                  <p className="mt-1 text-xs text-text-muted">
                    One route, one domain, and the arms it serves. Preview shows an arm without touching live traffic.
                  </p>
                </div>

                {/* Handle + domain */}
                <div className="grid gap-4 sm:grid-cols-2">
                  <div className="space-y-1">
                    <label htmlFor="split-handle" className="block text-xs font-medium text-text-muted">
                      Split Name (handle)
                    </label>
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

                {/* 2-arm weight slider (reference look). One drag sets BOTH
                    weights, locked to a 100% total; 3+ arms keep the per-arm
                    numeric inputs on the cards instead. */}
                {liveArms.length === 2 && (
                  <WeightSlider
                    arms={liveArms}
                    draft={weightDrafts[liveArms[0].id]}
                    onDraft={(v) => setWeightDrafts((d) => ({
                      ...d,
                      [liveArms[0].id]: String(v),
                      [liveArms[1].id]: String(100 - v),
                    }))}
                    onCommit={(v) => saveWeightPair(v)}
                    disabled={busy}
                  />
                )}

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

                {/* Draft-arm warning — a "50/50" over a draft is really 100/0 */}
                {draftWeightedLetters.length > 0 && (
                  <div className="flex items-start gap-2 px-3 py-2 rounded-lg border border-amber-500/20 bg-amber-500/10 text-xs text-amber-400">
                    <AlertTriangle className="w-4 h-4 mt-0.5 shrink-0" />
                    <span>
                      {draftWeightedLetters.length === 1
                        ? `Arm ${draftWeightedLetters[0]}'s page is a draft — traffic all goes to the published arm(s) until it's published.`
                        : `Arms ${draftWeightedLetters.join(', ')} have draft pages — traffic all goes to the published arm(s) until they're published.`}
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
                      test={test}
                      funnel={funnel}
                      weightDraft={weightDrafts[arm.id] ?? ''}
                      onWeightDraft={(v) => setWeightDrafts((d) => ({ ...d, [arm.id]: v }))}
                      onWeightCommit={() => saveWeight(arm)}
                      showWeightInput={liveArms.length !== 2}
                      onPreview={() => previewArm(arm)}
                      onEntry={() => makeEntry(arm)}
                      onEdit={() => editArm(arm)}
                      onPagePatch={patchPage}
                      pageError={arm.page_id ? pageErrors[arm.page_id] : null}
                      // Arm A is the original page — no picker (see setArmPage).
                      canChoosePage={i > 0}
                      pageChoices={partitionArmPages({
                        pages: eligible.pages,
                        liveArms,
                        currentPageId: arm.page_id,
                      })}
                      onChoosePage={(pageId) => setArmPage(arm, pageId)}
                      disabled={busy}
                    />
                  ))}

                  {/* ── "+ Add Split C" column ────────────────────────────
                      Two ways to mint the next arm: DUPLICATE the entry arm's
                      page, or IMPORT one that already exists. Both end in the
                      same single POST /:id/arms.

                      A third arm needs NO server change: the route's only
                      arm-count rule is a FLOOR (need_at_least_two_arms), the
                      arm_key column is an open charset with no CHECK and no
                      enum, and the resolver walks a cumulative sum over N
                      relative weights. Verified against the route + schema,
                      not assumed. */}
                  <div className="w-56 shrink-0 rounded-xl border border-dashed border-border-default bg-bg-elevated/30 p-3 flex flex-col gap-2">
                    <div className="text-sm font-medium text-text-primary">
                      + Add Split {nextSplitLetter(liveArms.length)}
                    </div>
                    <button
                      type="button"
                      onClick={duplicateAndAdd}
                      disabled={busy}
                      className="flex items-center justify-center gap-1.5 px-2.5 py-1.5 rounded-lg border border-border-default
                        text-xs text-text-muted hover:text-text-primary hover:bg-bg-hover transition-colors cursor-pointer
                        disabled:opacity-40 disabled:cursor-not-allowed"
                      title="Copies the entry arm's page — its blocks and escape hatches — and arms the copy at weight 0."
                    >
                      <Copy className="w-3.5 h-3.5" /> Duplicate a page
                    </button>

                    {/* OR divider */}
                    <div className="flex items-center gap-2">
                      <span className="h-px flex-1 bg-border-subtle" />
                      <span className="text-[10px] font-semibold uppercase tracking-wide text-text-faint">or</span>
                      <span className="h-px flex-1 bg-border-subtle" />
                    </div>

                    <div className="space-y-1">
                      <label htmlFor="split-import-page" className="block text-[11px] font-medium text-text-muted">
                        Import existing page
                      </label>
                      <select
                        id="split-import-page"
                        value=""
                        onChange={(e) => { if (e.target.value) addFromPage(e.target.value); }}
                        disabled={busy}
                        className={`${selectCls} ${!importable.length ? 'opacity-60' : ''}`}
                      >
                        {/* Ineligible pages stay LISTED and disabled, with the
                            reason — an option that silently vanishes is an
                            option the operator cannot ask about. */}
                        <option value="">
                          {importable.length ? 'Choose a page…' : 'No page to import'}
                        </option>
                        {importable.map((p) => (
                          <option key={p.id} value={p.id}>{pageOptionText(p)}</option>
                        ))}
                        {ineligible.map((p) => (
                          <option key={p.id} value="" disabled>{pageOptionText(p)}</option>
                        ))}
                      </select>
                    </div>

                    {ineligible.length > 0 && (
                      <p className="text-[11px] text-text-faint leading-snug">
                        {ineligible.length} of this funnel&apos;s pages can&apos;t be an arm
                        {' ('}{ineligibleCountsPhrase(counts)}{') '}
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

// ── 2-arm traffic slider ───────────────────────────────────────────────────
// "Split Traffic By [% Percentage]" — reference look. The draft moves live
// while dragging; the PATCHes fire once on release (pointer up / blur), one
// per arm, through the existing weight contract.
function WeightSlider({ arms, draft, onDraft, onCommit, disabled }) {
  const v = Math.min(100, Math.max(0, Math.round(num(draft) ?? num(arms[0]?.weight) ?? 50)));
  return (
    <div className="space-y-1.5">
      <label htmlFor="split-weight-slider" className="block text-xs font-medium text-text-muted">
        Split Traffic By{' '}
        <span className="px-1.5 py-0.5 rounded-md bg-bg-elevated border border-border-default text-[11px] text-text-primary">
          % Percentage
        </span>
      </label>
      <div className="flex items-center gap-3">
        <span className="text-[11px] font-mono tabular-nums text-text-muted whitespace-nowrap">A · {v}%</span>
        <input
          id="split-weight-slider"
          type="range"
          min="0"
          max="100"
          step="1"
          value={v}
          onChange={(e) => onDraft(Math.round(Number(e.target.value)))}
          onPointerUp={(e) => onCommit(Number(e.currentTarget.value))}
          onBlur={(e) => onCommit(Number(e.currentTarget.value))}
          disabled={disabled}
          aria-label="Traffic split between arm A and arm B, percent to A"
          className="flex-1 accent-emerald-500 cursor-pointer disabled:opacity-40 disabled:cursor-not-allowed"
        />
        <span className="text-[11px] font-mono tabular-nums text-text-muted whitespace-nowrap">B · {100 - v}%</span>
      </div>
      <p className="text-[11px] text-text-faint">Drag to set both weights — they always total 100%.</p>
    </div>
  );
}

// ── One arm ────────────────────────────────────────────────────────────────
function ArmCard({
  arm, letter, page, test, funnel, weightDraft, onWeightDraft, onWeightCommit,
  showWeightInput, onPreview, onEntry, onEdit, onPagePatch, pageError,
  canChoosePage, pageChoices, onChoosePage, disabled,
}) {
  const thumbUrl = usePageThumbnail(
    page?.id && funnel?.id ? { id: page.id, funnel_id: funnel.id, updated_at: page.updated_at } : null
  );

  // Name + slug drafts, reconciled from the page row (never from the
  // optimistic value — same rule as the handle/weight drafts above). The
  // reconcile is an adjust-during-render, not an effect: when the server's
  // value moves, the draft snaps to it in the same render pass.
  const [nameDraft, setNameDraft] = useState(page?.title || '');
  const [slugDraft, setSlugDraft] = useState((page?.slug || '').replace(/^\//, ''));
  const [prevPage, setPrevPage] = useState({ title: page?.title, slug: page?.slug });
  if (page?.title !== prevPage.title || page?.slug !== prevPage.slug) {
    setPrevPage({ title: page?.title, slug: page?.slug });
    setNameDraft(page?.title || '');
    setSlugDraft((page?.slug || '').replace(/^\//, ''));
  }

  // "Use name as title" — the page's DOCUMENT title. renderPageHtml resolves
  // it as seo.title || site title || page.title, so ticked = no seo.title (the
  // name flows through) and unticking PINS the current title into seo.title so
  // later renames stop moving it.
  const seoTitle = typeof page?.seo?.title === 'string' && page.seo.title ? page.seo.title : null;
  const useNameAsTitle = !seoTitle;

  const commitName = async () => {
    const v = nameDraft.trim();
    if (!page || !v || v === page.title) { setNameDraft(page?.title || ''); return; }
    const updated = await onPagePatch(page, { title: v });
    if (!updated) setNameDraft(page?.title || '');
  };

  const commitSlug = async () => {
    if (!page) return;
    const next = `/${slugDraft.trim().replace(/^\//, '')}`;
    if (next === page.slug) return;
    const updated = await onPagePatch(page, { slug: next });
    if (!updated) setSlugDraft((page?.slug || '').replace(/^\//, ''));
  };

  const toggleUseName = async (checked) => {
    if (!page) return;
    const seo = { ...(page.seo || {}) };
    if (checked) delete seo.title;
    else seo.title = seoTitle || page.title || '';
    await onPagePatch(page, { seo });
  };

  // View live — the REAL public URL (fires pixels, counts an impression; the
  // legend below the modal says so). Every part crosses a charset guard in
  // armLiveUrl; when no safe link exists the button renders disabled instead.
  const liveUrl = armLiveUrl({
    isEntry: Boolean(arm.is_entry),
    handle: test?.handle,
    domain: test?.domain || funnel?.custom_domain || '',
    funnelSlug: funnel?.slug,
    pageSlug: page?.slug,
  });

  const iconBtn =
    'p-1.5 rounded-md text-text-muted hover:text-text-primary hover:bg-bg-hover transition-colors cursor-pointer disabled:opacity-40 disabled:cursor-not-allowed';
  const fieldCls = `w-full px-2.5 py-1.5 text-sm bg-bg-elevated border border-border-default rounded-lg
    text-text-primary placeholder:text-text-faint
    focus:outline-none focus:ring-2 focus:ring-accent/40 focus:border-accent transition-colors
    disabled:opacity-40 disabled:cursor-not-allowed`;

  return (
    <div
      className={`w-64 shrink-0 rounded-xl border bg-bg-elevated/40 p-3 space-y-2 ${
        arm.is_entry ? 'border-emerald-500/40' : 'border-border-default'
      }`}
    >
      {/* Live page thumbnail (gradient placeholder until it lands) + letter + weight */}
      <div className="relative h-24 rounded-lg border border-border-subtle overflow-hidden bg-gradient-to-br from-white/[0.04] to-transparent flex items-center justify-center">
        {thumbUrl && (
          <img src={thumbUrl} alt="" draggable={false} className="absolute inset-0 w-full h-full object-cover object-top" />
        )}
        <span className="relative inline-flex items-center justify-center w-8 h-8 rounded-lg bg-bg-card/90 border border-border-default text-sm font-bold text-text-primary">
          {letter}
        </span>
        <div className="absolute top-1.5 right-1.5 flex items-center gap-0.5 px-1 py-0.5 rounded-md bg-bg-card/90 border border-border-default">
          {showWeightInput ? (
            <input
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
          ) : (
            // 2-arm mode: the slider above owns the weights; the badge reads.
            <span className="text-[11px] tabular-nums text-text-primary">{num(arm.weight) ?? 0}</span>
          )}
          <span className="text-[11px] text-text-faint">%</span>
        </div>
        {arm.is_entry && (
          <span className="absolute top-1.5 left-1.5 px-1.5 py-0.5 rounded text-[9px] font-semibold uppercase tracking-wide
            bg-emerald-500/15 text-emerald-400 border border-emerald-500/30">
            Entry
          </span>
        )}
        {/* The serve path only delivers PUBLISHED arms (it silently re-picks
            around a draft), so a draft arm holds weight without receiving
            traffic — say so where the weight is shown. */}
        {page && page.status !== 'published' && (
          <span
            className="absolute bottom-1.5 left-1.5 px-1.5 py-0.5 rounded text-[9px] font-semibold uppercase tracking-wide
              bg-amber-500/15 text-amber-400 border border-amber-500/30"
            title="Draft pages are never served — this arm's traffic goes to the published arm(s) until it's published"
          >
            Draft — not serving
          </span>
        )}
      </div>

      {page ? (
        <>
          {/* Name + document-title control (reference: "Lead Page Name") */}
          <div className="space-y-1">
            <label htmlFor={`arm-name-${arm.id}`} className="block text-[11px] font-medium text-text-muted">
              Lead Page Name
            </label>
            <input
              id={`arm-name-${arm.id}`}
              value={nameDraft}
              onChange={(e) => setNameDraft(e.target.value)}
              onBlur={commitName}
              onKeyDown={(e) => e.key === 'Enter' && e.currentTarget.blur()}
              placeholder="Untitled"
              autoComplete="off"
              disabled={disabled}
              className={fieldCls}
            />
            <label className="flex items-center gap-1.5 text-[11px] text-text-muted cursor-pointer">
              <input
                type="checkbox"
                checked={useNameAsTitle}
                onChange={(e) => toggleUseName(e.target.checked)}
                disabled={disabled}
                className="accent-emerald-500 cursor-pointer"
              />
              Use name as title
            </label>
          </div>

          {/* Slug (reference: "Published Page Name") */}
          <div className="space-y-1">
            <label htmlFor={`arm-slug-${arm.id}`} className="block text-[11px] font-medium text-text-muted">
              Published Page Name
            </label>
            <div className="flex items-stretch">
              <span className="inline-flex items-center px-2 rounded-l-lg border border-r-0 border-border-default bg-bg-elevated text-sm text-text-faint font-mono">/</span>
              <input
                id={`arm-slug-${arm.id}`}
                value={slugDraft}
                onChange={(e) => setSlugDraft(e.target.value)}
                onBlur={commitSlug}
                onKeyDown={(e) => e.key === 'Enter' && e.currentTarget.blur()}
                placeholder="page"
                autoComplete="off"
                spellCheck={false}
                disabled={disabled}
                className={`${fieldCls} rounded-l-none font-mono`}
              />
            </div>
          </div>

          {/* The server's refusal, inline and persistent (slug collisions land here) */}
          {pageError && (
            <p className="flex items-start gap-1.5 text-[11px] text-red-400 leading-snug">
              <AlertTriangle className="w-3.5 h-3.5 mt-px shrink-0" />
              <span>{pageError}</span>
            </p>
          )}

          {/* Default (entry) radio — maps to our ENTRY arm, moved atomically
              server-side (POST /:id/arms/:armId/entry). The radio is just the
              control; the semantics stay exactly the entry arm's. */}
          <label className="flex items-center gap-1.5 text-[11px] text-text-muted cursor-pointer">
            <input
              type="radio"
              name={`split-entry-${test?.id || 'test'}`}
              checked={Boolean(arm.is_entry)}
              onChange={() => onEntry()}
              disabled={disabled || Boolean(arm.is_entry)}
              className="accent-emerald-500 cursor-pointer"
            />
            Set as Default Page
            {arm.is_entry && (
              <span className="text-[10px] font-semibold uppercase tracking-wide text-emerald-400/80">· entry</span>
            )}
          </label>
        </>
      ) : (
        <div className="min-w-0">
          <div className="text-sm font-medium text-text-primary truncate">
            {arm.page_id ? 'Page not on this funnel' : 'No page yet'}
          </div>
          <div className="text-[11px] text-text-faint font-mono truncate">—</div>
        </div>
      )}

      {/* "Choose / import page" — every arm after the first. Rendered whether
          or not the arm HAS a page: an arm with none is exactly the case this
          picker exists for. */}
      {canChoosePage && (
        <div className="space-y-1">
          <label htmlFor={`arm-page-${arm.id}`} className="block text-[11px] font-medium text-text-muted">
            Choose / import page
          </label>
          <select
            id={`arm-page-${arm.id}`}
            value={arm.page_id || ''}
            onChange={(e) => onChoosePage?.(e.target.value)}
            disabled={disabled}
            className={selectCls}
          >
            <option value="">
              {(pageChoices?.importable || []).length ? 'Choose a page…' : 'No page to choose'}
            </option>
            {(pageChoices?.importable || []).map((p) => (
              <option key={p.id} value={p.id}>{pageOptionText(p)}</option>
            ))}
            {(pageChoices?.ineligible || []).map((p) => (
              <option key={p.id} value="" disabled>{pageOptionText(p)}</option>
            ))}
          </select>
        </div>
      )}

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
        {liveUrl ? (
          <a
            href={liveUrl}
            target="_blank"
            rel="noopener noreferrer"
            className={`${iconBtn} ml-auto`}
            title={arm.is_entry
              ? 'View live — opens the split route (re-splits, fires pixels, counts an impression)'
              : 'View live — opens this arm’s public URL (fires pixels, counts an impression)'}
          >
            <ExternalLink className="w-4 h-4" />
          </a>
        ) : (
          <button
            type="button"
            className={`${iconBtn} ml-auto`}
            disabled
            title="View live unavailable — no safe public URL for this arm yet"
          >
            <ExternalLink className="w-4 h-4" />
          </button>
        )}
      </div>
    </div>
  );
}
