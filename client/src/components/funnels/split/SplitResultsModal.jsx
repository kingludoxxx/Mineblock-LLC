// SPLIT RESULTS MODAL — "<handle> A/B — results".
//
// Reads the ANALYTICS lane's windowed metrics contract (documented in
// ./splitApi.js) and renders the per-arm comparison table plus the verdict.
//
// THE DEGRADATION RULE, stated once: this modal must be USEFUL before that
// endpoint exists and HONEST after it does. So:
//   • the endpoint's absence is a first-class state, not an error — the table
//     still renders, every cell reads '—', and one banner says why;
//   • a metric that is present renders; a metric that is missing renders '—'.
//     There is no interpolation, no "0 because we didn't get a number", and no
//     computed stand-in. A blank cell is the truth when the number is unknown;
//   • the verdict is never invented. With no data the headline is "Not enough
//     data yet", never "no winner" — those say different things.
//
// ONE WRITE, AND ONLY ONE: promoting the winner. Everything else on this
// surface is a pure read of derived figures. The promote button appears only
// when the SERVICE says there is a winner (verdict.status === 'winner', with
// verdict.leader naming the arm) — this modal never decides a winner itself,
// for exactly the reason the banner never composes its own prose.
import { useCallback, useEffect, useMemo, useState } from 'react';
import { X, TrendingUp, AlertTriangle, Loader2, Trophy, CheckCircle2, Hourglass } from 'lucide-react';
import {
  fetchSplitMetrics, fetchLifetimeStats, shouldShowWinnerBadge, promoteSplitWinner,
  armLetter, fmtInt, fmtMoney, fmtPct, fmtDate, fmtDateTime, isoDay, utcDay, num, DASH,
} from './splitApi';

export default function SplitResultsModal({ open, onClose, test, onPromoted }) {
  const testId = test?.id;
  const handle = test?.handle || '';
  const createdAt = test?.created_at;

  // Default window: the day the test was created → today. The experiment view
  // is defined as "only traffic from that day onward", so the default IS that
  // statement rather than a rolling 7/30 days that would silently exclude it.
  // The presets are shortcuts that WRITE this same range; only 'custom'
  // reveals the raw from/to inputs.
  const [preset, setPreset] = useState('created'); // 'created' | '7d' | '30d' | 'custom'
  const [range, setRange] = useState(() => ({ from: '', to: '' }));
  const [state, setState] = useState({ loading: true, available: false, reason: null, data: null });

  // LIFETIME statistics — a SECOND, INDEPENDENT read, and independent on
  // purpose. It comes from /split-tests/:id/results, which is this lane's own
  // endpoint and is always present, so the readiness panel below renders even
  // when the windowed analytics overlay 404s — which is the state this modal
  // was already written to survive, and the state in which an operator
  // previously had no statistics at all.
  //
  // NOT windowed: it does not depend on `range`, so it is fetched once per
  // test rather than on every date change.
  const [lifetime, setLifetime] = useState({ available: false, reason: null, data: null });

  const presetRange = useCallback((p) => {
    const today = isoDay(new Date());
    if (p === '7d' || p === '30d') {
      const d = new Date();
      d.setDate(d.getDate() - (p === '7d' ? 6 : 29)); // window INCLUDES today
      return { from: isoDay(d), to: today };
    }
    // UTC day for created_at (the server truncates in UTC — the local day of a
    // 23:50Z creation would start the window a day late and drop the first
    // hours); `today` stays local, it is the picker's own frame.
    const start = createdAt ? utcDay(createdAt) : today;
    return { from: start && start <= today ? start : today, to: today };
  }, [createdAt]);

  useEffect(() => {
    if (!open) return;
    setPreset('created');
    setRange(presetRange('created'));
  }, [open, presetRange]);

  const pickPreset = useCallback((p) => {
    setPreset(p);
    // 'custom' keeps whatever window is showing — it only reveals the inputs.
    if (p !== 'custom') setRange(presetRange(p));
  }, [presetRange]);

  const load = useCallback(async () => {
    if (!testId) return;
    setState((s) => ({ ...s, loading: true }));
    const res = await fetchSplitMetrics(testId, { from: range.from, to: range.to });
    setState({ loading: false, available: res.available, reason: res.reason || null, data: res.data || null });
  }, [testId, range.from, range.to]);

  useEffect(() => { if (open && range.from && range.to) load(); }, [open, range.from, range.to, load]);

  // fetchLifetimeStats never throws — same posture as fetchSplitMetrics. A
  // surface whose whole point is degrading honestly cannot have one of its two
  // reads take the modal down.
  //
  // Used by the promote handler to refresh after a write. The MOUNT read is the
  // effect below rather than this callback, for two reasons: calling a
  // setState-ing function synchronously in an effect body is what
  // react-hooks/set-state-in-effect flags, and the effect needs a
  // stale-response guard this callback cannot carry.
  const loadLifetime = useCallback(async () => {
    if (!testId) return;
    setLifetime(await fetchLifetimeStats(testId));
  }, [testId]);

  // STALE-RESPONSE GUARD, same shape as FunnelCanvasPage's metricsIdRef: opening
  // test A and then test B can leave A's request in flight, and without the flag
  // its late response would paint A's readiness under B's heading. The cleanup
  // runs on every dependency change, so the losing request resolves into a
  // cancelled closure and writes nothing.
  useEffect(() => {
    if (!open || !testId) return undefined;
    let cancelled = false;
    (async () => {
      const res = await fetchLifetimeStats(testId);
      if (!cancelled) setLifetime(res);
    })();
    return () => { cancelled = true; };
  }, [open, testId]);

  useEffect(() => {
    if (!open) return undefined;
    document.body.style.overflow = 'hidden';
    const onEsc = (e) => e.key === 'Escape' && onClose?.();
    window.addEventListener('keydown', onEsc);
    return () => { document.body.style.overflow = ''; window.removeEventListener('keydown', onEsc); };
  }, [open, onClose]);

  // The columns. When metrics are available they come from the contract (its
  // arm order is authoritative — it ranked them). When they are not, the arms
  // come from the test definition so the operator still sees WHICH arms exist.
  const columns = useMemo(() => {
    if (state.available && state.data?.arms?.length) {
      return state.data.arms.map((a, i) => ({
        key: a.arm_key || `arm${i}`,
        letter: armLetter(i),
        is_control: a.is_control,
        m: a,
      }));
    }
    return (test?.arms || [])
      .filter((a) => !a.archived)
      .map((a, i) => ({ key: a.arm_key, letter: armLetter(i), is_control: a.is_control, m: {} }));
  }, [state, test]);

  const verdict = state.data?.verdict || {};
  const disclosure = state.data?.disclosure || {};

  if (!open) return null;

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 backdrop-blur-sm p-4"
      onClick={(e) => { if (e.target === e.currentTarget) onClose?.(); }}
    >
      <div className="w-full max-w-5xl max-h-[88vh] flex flex-col bg-bg-card border border-border-default rounded-xl shadow-2xl overflow-hidden">
        {/* Header */}
        <div className="shrink-0 flex items-center justify-between px-5 py-3.5 border-b border-border-subtle">
          <h2 className="text-base font-semibold text-text-primary min-w-0 truncate">
            <span className="font-mono text-emerald-400">{handle || '…'}</span> A/B — results
          </h2>
          <div className="flex items-center gap-2">
            {state.loading && <Loader2 className="w-4 h-4 animate-spin text-text-faint" />}
            <button
              onClick={onClose}
              className="p-1 rounded-md text-text-muted hover:text-text-primary hover:bg-bg-hover transition-colors cursor-pointer"
              title="Close"
            >
              <X className="w-4 h-4" />
            </button>
          </div>
        </div>

        <div className="flex-1 overflow-y-auto px-5 py-4 space-y-4">
          {/* ── Verdict banner ────────────────────────────────── */}
          <VerdictBanner
            available={state.available}
            verdict={verdict}
            from={state.data?.window?.from || range.from}
            to={state.data?.window?.to || range.to}
          />

          {/* ── Readiness + significance (lifetime ledger) ────── */}
          <ReadinessPanel lifetime={lifetime} />

          {/* ── Promote the winner ────────────────────────────── */}
          <PromoteWinner
            test={test}
            handle={handle}
            available={state.available}
            verdict={verdict}
            onPromoted={(updated) => { onPromoted?.(updated); load(); loadLifetime(); }}
          />

          {/* ── Degraded-source strip ─────────────────────────── */}
          {/* The service reports a partial read rather than throwing. A number
              computed from a source that degraded is not the same number, and
              the operator has to be told WHICH source before trusting it. */}
          {state.available && state.data?.degraded && (
            <div className="flex items-start gap-2 px-3 py-2 rounded-lg border border-amber-500/20 bg-amber-500/10">
              <AlertTriangle className="w-4 h-4 mt-0.5 shrink-0 text-amber-400" />
              <p className="text-xs text-amber-300/90">
                Some sources degraded while computing this window
                {state.data.warnings?.length
                  ? <span className="font-mono"> ({state.data.warnings.map((w) => (typeof w === 'string' ? w : w?.source || 'unknown')).join(', ')})</span>
                  : null}. Figures drawn from them are understated, not zero.
              </p>
            </div>
          )}

          {/* ── Metrics-unavailable banner ────────────────────── */}
          {!state.available && !state.loading && (
            <div className="flex items-start gap-2 px-3 py-2.5 rounded-lg border border-border-default bg-bg-elevated/50">
              <AlertTriangle className="w-4 h-4 mt-0.5 shrink-0 text-text-faint" />
              <p className="text-xs text-text-muted">
                <strong className="text-text-primary">Metrics unavailable.</strong>{' '}
                The experiment metrics service did not answer for this test
                {state.reason ? <span className="font-mono text-text-faint"> ({state.reason})</span> : null}. The arms
                below are the ones this split is running; every figure is blank because no number was returned —
                none of them are zero.
              </p>
            </div>
          )}

          {/* ── Amber tracking disclosure ─────────────────────── */}
          {state.available && disclosure.tracking_started_after_test && (
            <div className="flex items-start gap-2 px-3 py-2.5 rounded-lg border border-amber-500/20 bg-amber-500/10">
              <AlertTriangle className="w-4 h-4 mt-0.5 shrink-0 text-amber-400" />
              <p className="text-xs text-amber-300/90">
                Experiment tracking began {fmtDateTime(disclosure.tracking_started_at)}, after this test started.
                Exposures before then were never recorded per day and cannot be recovered, so the visitor counts
                below are lower than the all-time totals. The comparison is still fair — both arms lost the same
                window — but treat the sample as starting from that time.
              </p>
            </div>
          )}

          {/* ── Caption + date range ──────────────────────────── */}
          <div className="flex flex-wrap items-end justify-between gap-3">
            <p className="text-xs text-text-faint max-w-lg">
              Test created {fmtDate(createdAt)}. The experiment view counts only traffic from that day onward.
            </p>
            <div className="flex items-end gap-2">
              <label className="block">
                <span className="block text-[10px] uppercase tracking-wide text-text-faint mb-0.5">Window</span>
                <select
                  value={preset}
                  onChange={(e) => pickPreset(e.target.value)}
                  className="px-2 py-1 text-xs bg-bg-elevated border border-border-default rounded-md text-text-primary
                    focus:outline-none focus:border-accent cursor-pointer"
                >
                  <option value="created">Since created</option>
                  <option value="7d">Last 7 days</option>
                  <option value="30d">Last 30 days</option>
                  <option value="custom">Custom</option>
                </select>
              </label>
              {preset === 'custom' && (
                <>
                  <label className="block">
                    <span className="block text-[10px] uppercase tracking-wide text-text-faint mb-0.5">From</span>
                    <input
                      type="date"
                      value={range.from}
                      max={range.to || undefined}
                      onChange={(e) => setRange((r) => ({ ...r, from: e.target.value }))}
                      className="px-2 py-1 text-xs bg-bg-elevated border border-border-default rounded-md text-text-primary
                        focus:outline-none focus:border-accent cursor-pointer"
                    />
                  </label>
                  <label className="block">
                    <span className="block text-[10px] uppercase tracking-wide text-text-faint mb-0.5">To</span>
                    <input
                      type="date"
                      value={range.to}
                      min={range.from || undefined}
                      onChange={(e) => setRange((r) => ({ ...r, to: e.target.value }))}
                      className="px-2 py-1 text-xs bg-bg-elevated border border-border-default rounded-md text-text-primary
                        focus:outline-none focus:border-accent cursor-pointer"
                    />
                  </label>
                </>
              )}
            </div>
          </div>

          {/* ── The table ─────────────────────────────────────── */}
          <MetricsTable columns={columns} />
        </div>
      </div>
    </div>
  );
}

// ── Verdict ────────────────────────────────────────────────────────────────
//
// THE SERVICE'S HEADLINE IS THE WHOLE VERDICT. analyticsStats.buildVerdict
// returns complete prose for every status — including the confidence figure and
// the required sample — so this renders it and stops.
//
// It used to COMPOSE a second "body" sentence underneath from fields that did
// not exist, so the fallback fired unconditionally and printed "no arm beats
// the control" directly beneath a headline announcing a winner at 100%
// confidence. Two contradictory sentences in one banner is worse than one terse
// one: the operator cannot tell which to believe.
//
// The service DOES supply a `body` in exactly one case — the arm-delivery gate,
// where it explains that the numbers are real but the comparison is not. That
// body is rendered verbatim when present. Nothing is ever composed when it is
// absent; the only text this file adds is a caveat that is TRUE ALONGSIDE a
// status, never instead of one.
//
// BLOCKED beats status for tone. When `blocked_reason` is set the test is not
// scoreable at all, which is a warning regardless of the status string the
// service pairs it with.
const STATUS_TONE = {
  winner: { border: 'border-emerald-500/25', bg: 'bg-emerald-500/[0.07]', icon: 'text-emerald-400' },
  no_winner: { border: 'border-border-default', bg: 'bg-bg-elevated/50', icon: 'text-text-faint' },
  not_ready: { border: 'border-amber-500/20', bg: 'bg-amber-500/[0.07]', icon: 'text-amber-400' },
  no_data: { border: 'border-border-default', bg: 'bg-bg-elevated/50', icon: 'text-text-faint' },
  insufficient_arms: { border: 'border-border-default', bg: 'bg-bg-elevated/50', icon: 'text-text-faint' },
  // Kept so an unknown/legacy status still renders in a neutral skin rather
  // than crashing on an undefined lookup.
  unavailable: { border: 'border-border-default', bg: 'bg-bg-elevated/50', icon: 'text-text-faint' },
  // `blocked_reason` set — the comparison itself is invalid. Never green.
  blocked: { border: 'border-amber-500/30', bg: 'bg-amber-500/[0.09]', icon: 'text-amber-400' },
};

// ── PROMOTE THE WINNER ─────────────────────────────────────────────────────
//
// Shown ONLY when the service returns verdict.status === 'winner' AND names the
// arm in verdict.leader. `verdict.winner_arm_key` does not exist on this
// endpoint (splitApi.js documents it in the "must never be invented" list), so
// `leader` is the field, and it carries an ARM KEY — the arm ID the endpoint
// wants is looked up on the test definition.
//
// TYPED CONFIRM, not a checkbox: this repoints a live route AND stops the
// experiment. Typing the arm key is the smallest gesture that cannot be made by
// a mis-click, and it also forces the operator to look at WHICH arm they are
// crowning.
function PromoteWinner({ test, handle, available, verdict, onPromoted }) {
  const [typed, setTyped] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(null);
  const [done, setDone] = useState(null);
  const [arming, setArming] = useState(false);

  const winnerKey = available && verdict.status === 'winner' ? verdict.leader : null;
  const arms = Array.isArray(test?.arms) ? test.arms : [];
  const winnerArm = winnerKey ? arms.find((a) => a.arm_key === winnerKey && !a.archived) : null;
  // Review LOW #12: the service can crown an arm that has since been ARCHIVED
  // (the verdict is computed over the window's ledger, which still contains the
  // arm's traffic). Rendering nothing in that case was the worst option — the
  // operator reads "winner: b" in the banner directly above and finds no way to
  // act on it, with no explanation. Say why instead.
  const archivedWinner = Boolean(
    winnerKey && !winnerArm && arms.some((a) => a.arm_key === winnerKey && a.archived)
  );
  // A test that has already ENDED must not offer the button again — the
  // endpoint would answer 409 for a different arm and the operator would be
  // reading an error instead of a state.
  //
  // `enabled === false` is the load-bearing half of this test: promoting always
  // pauses, so a paused test has either been promoted or been stopped by hand,
  // and "promote the winner" is the wrong offer in both cases. It is also the
  // half that is actually PRESENT here — the split-test list response
  // (splitTests.js TEST_COLS) carries `enabled` but not `promoted_arm_id`, so
  // relying on the latter alone would have left the button showing forever.
  const alreadyEnded = Boolean(test?.promoted_arm_id) || test?.enabled === false;

  const promote = useCallback(async () => {
    if (!winnerArm || busy) return;
    setBusy(true);
    setError(null);
    try {
      const updated = await promoteSplitWinner(test.id, winnerArm.id);
      setDone(updated || { promoted_arm_key: winnerKey });
      onPromoted?.(updated);
    } catch (err) {
      const code = err?.response?.data?.error?.code;
      setError({
        arm_page_not_published: 'That arm\u2019s page is still a draft, so it would never serve. Publish the page first.',
        arm_has_no_page: 'That arm has no page attached, so there is nothing to serve.',
        arm_archived: 'That arm is archived and takes no traffic.',
        already_promoted: 'A different arm has already been promoted on this test.',
        not_found: 'That arm no longer exists on this test.',
        confirm_required: 'The server refused without a confirmation.',
      }[code] || (code ? `Promote refused: ${code}` : 'Promote failed. Nothing changed.'));
      setBusy(false);
    }
  }, [winnerArm, winnerKey, busy, test, onPromoted]);

  if (done) {
    const key = done.promoted_arm_key || winnerKey;
    return (
      <div className="rounded-xl border border-emerald-500/25 bg-emerald-500/[0.07] px-4 py-3">
        <div className="flex items-start gap-2.5">
          <CheckCircle2 className="w-4 h-4 mt-0.5 shrink-0 text-emerald-400" />
          <div className="min-w-0">
            <p className="text-sm font-semibold text-text-primary">
              Winner promoted \u2014 test paused, <span className="font-mono text-emerald-400">/{handle}</span> now
              serves <span className="font-mono text-emerald-400">{key}</span>
            </p>
            <p className="mt-1 text-xs text-text-muted leading-relaxed">
              The route stays live and every visitor sees the winning page. Nothing already in the ledger moved \u2014
              the figures above still describe the traffic that was split.
            </p>
          </div>
        </div>
      </div>
    );
  }

  if (archivedWinner && !alreadyEnded) {
    return (
      <div className="rounded-xl border border-border-default bg-bg-elevated/50 px-4 py-3">
        <div className="flex items-start gap-2.5">
          <Trophy className="w-4 h-4 mt-0.5 shrink-0 text-text-faint" />
          <div className="min-w-0">
            <p className="text-sm font-semibold text-text-muted">
              Cannot promote <span className="font-mono">{winnerKey}</span> — the winning arm is archived
            </p>
            <p className="mt-1 text-xs text-text-muted leading-relaxed">
              The verdict above is computed from traffic this arm took before it was retired. An archived arm
              takes no traffic and cannot serve the route, so it cannot be promoted. Restore the arm first if
              you want it to win.
            </p>
          </div>
        </div>
      </div>
    );
  }

  if (!winnerArm || alreadyEnded) return null;

  return (
    <div className="rounded-xl border border-emerald-500/20 bg-emerald-500/[0.05] px-4 py-3">
      <div className="flex items-start gap-2.5">
        <Trophy className="w-4 h-4 mt-0.5 shrink-0 text-emerald-400" />
        <div className="min-w-0 flex-1">
          <p className="text-sm font-semibold text-text-primary">
            Promote <span className="font-mono text-emerald-400">{winnerKey}</span> and end the test
          </p>
          <p className="mt-1 text-xs text-text-muted leading-relaxed">
            <span className="font-mono">/{handle || '\u2026'}</span> will serve this arm\u2019s page to
            everyone and the test is paused. The route stays live; the split stops.
          </p>

          {!arming ? (
            <button
              onClick={() => setArming(true)}
              className="mt-2.5 px-3 py-1.5 text-xs rounded-lg border border-emerald-500/30 bg-emerald-500/10
                text-emerald-300 hover:bg-emerald-500/20 transition-colors cursor-pointer"
            >
              Promote winner
            </button>
          ) : (
            <div className="mt-2.5 space-y-2">
              <label className="block text-[11px] text-text-muted">
                Type <span className="font-mono text-text-primary">{winnerKey}</span> to confirm
              </label>
              <div className="flex items-center gap-2">
                <input
                  autoFocus
                  value={typed}
                  onChange={(e) => setTyped(e.target.value)}
                  onKeyDown={(e) => { if (e.key === 'Enter' && typed.trim() === winnerKey) promote(); }}
                  placeholder={winnerKey}
                  className="px-2.5 py-1.5 text-xs font-mono bg-bg-elevated border border-border-default rounded-md
                    text-text-primary placeholder:text-text-faint focus:outline-none focus:border-emerald-500/40"
                />
                <button
                  onClick={promote}
                  disabled={typed.trim() !== winnerKey || busy}
                  className="px-3 py-1.5 text-xs rounded-lg border border-emerald-500/30 bg-emerald-500/10
                    text-emerald-300 hover:bg-emerald-500/20 transition-colors cursor-pointer
                    disabled:opacity-40 disabled:pointer-events-none inline-flex items-center gap-1.5"
                >
                  {busy && <Loader2 className="w-3 h-3 animate-spin" />}
                  Confirm promote
                </button>
                <button
                  onClick={() => { setArming(false); setTyped(''); setError(null); }}
                  disabled={busy}
                  className="px-2.5 py-1.5 text-xs rounded-lg text-text-muted hover:text-text-primary
                    hover:bg-bg-hover transition-colors cursor-pointer"
                >
                  Cancel
                </button>
              </div>
            </div>
          )}
          {error && <p className="mt-2 text-xs text-red-400">{error}</p>}
        </div>
      </div>
    </div>
  );
}

// ── READINESS + SIGNIFICANCE ───────────────────────────────────────────────
//
// THE FAILURE THIS ANSWERS. Before this panel, an operator looking at this
// modal with the windowed analytics endpoint unavailable saw a table of dashes
// and a banner saying "metrics unavailable" — and promoted on the raw counts
// they could see elsewhere. The lifetime endpoint has always been present and
// now carries statistics, so there is no longer any state in which this surface
// shows counts without telling the operator whether they mean anything.
//
// IT IS A DIFFERENT BASIS FROM THE TABLE, AND IT SAYS SO IN ITS OWN HEADER.
// The table above is WINDOWED (the date range the operator picked). This is the
// LIFETIME ledger — every exposure since the test started. Two numbers computed
// over two populations will differ, and an operator who cannot see which is
// which will read the difference as a bug. Labelled once, at the top, rather
// than annotated on every cell.
//
// IT NEVER NAMES A WINNER THE SERVICE HAS NOT NAMED, and it never names one
// below readiness — `is_winner` is only ever set by splitStats' winner gate,
// which requires every arm past both floors AND significance at the
// Bonferroni-corrected alpha. This component adds no gate of its own and,
// crucially, invents no fallback: there is no "highest RPV wins" branch here.
//
// A WITHHELD NUMBER RENDERS AS A DASH WITH ITS REASON, NEVER AS 0%. `p_value:
// null` means the service refused to compute one (below the sample floor, fewer
// than two arms with data, zero variance). "0.0% confidence" would be a
// measurement claim about something that was never measured.
function ReadinessPanel({ lifetime }) {
  const data = lifetime?.data;
  const verdict = data?.verdict;
  const arms = Array.isArray(data?.arms) ? data.arms : [];

  // The endpoint answered, but this deploy does not compute statistics (or the
  // shape was not understood). Say which — silence here reads as "no problem".
  if (!lifetime?.available || !verdict) {
    return (
      <div className="rounded-xl border border-border-default bg-bg-elevated/50 px-4 py-3">
        <div className="flex items-start gap-2.5">
          <Hourglass className="w-4 h-4 mt-0.5 shrink-0 text-text-faint" />
          <div className="min-w-0">
            <p className="text-sm font-semibold text-text-muted">Readiness unavailable</p>
            <p className="mt-1 text-xs text-text-muted leading-relaxed">
              The lifetime ledger did not return a statistics block
              {lifetime?.reason ? <span className="font-mono text-text-faint"> ({lifetime.reason})</span> : null}, so
              this test&rsquo;s readiness cannot be shown. No figure below is zero &mdash; they are unknown.
            </p>
          </div>
        </div>
      </div>
    );
  }

  const ready = Boolean(verdict.ready);
  const insufficient = verdict.status === 'insufficient_data';
  // Green ONLY when the service both cleared readiness and named a winner.
  // A ready test with no winner is neutral, not green: "we looked and there is
  // no difference" is a real answer but it is not a success.
  const tone = verdict.status === 'winner'
    ? STATUS_TONE.winner
    : (ready && !insufficient ? STATUS_TONE.no_winner : STATUS_TONE.not_ready);

  return (
    <div className={`rounded-xl border ${tone.border} ${tone.bg} overflow-hidden`}>
      <div className="px-4 py-2.5 border-b border-border-subtle/60 flex items-center gap-2">
        <Hourglass className={`w-3.5 h-3.5 shrink-0 ${tone.icon}`} />
        <span className="text-[10px] font-semibold uppercase tracking-wider text-text-faint">
          Readiness &amp; significance &middot; lifetime ledger, all traffic since the test started
        </span>
        {!ready && (
          <span className="ml-auto px-1.5 py-0.5 rounded text-[10px] font-semibold uppercase tracking-wide
            border border-amber-500/30 bg-amber-500/10 text-amber-300">
            Not ready
          </span>
        )}
      </div>

      <div className="px-4 py-3">
        <p className="text-sm font-semibold text-text-primary">{verdict.headline}</p>
        {verdict.body && <p className="mt-1 text-xs text-text-muted leading-relaxed">{verdict.body}</p>}

        {/* The projection caveat, rendered only when there IS a projection and
            only when the service says it was sized on the observed effect. */}
        {verdict.sized_on_observed_effect && verdict.required_sample_per_arm ? (
          <p className="mt-1 text-xs text-text-muted leading-relaxed">
            That projection is sized on the gap observed so far &mdash; at low traffic the gap is mostly noise, so
            treat it as a floor, not a forecast.
          </p>
        ) : null}

        <div className="mt-3 space-y-1.5">
          {arms.map((a) => (
            <ArmReadinessRow key={a.arm_key} arm={a} verdict={verdict} />
          ))}
          {arms.length === 0 && (
            <p className="text-xs text-text-faint">This test has no arms.</p>
          )}
        </div>

        <p className="mt-2.5 text-[11px] text-text-faint font-mono">
          {verdict.status}
          {verdict.reason ? ` · ${verdict.reason}` : ''}
          {verdict.comparisons ? ` · ${verdict.comparisons} comparison${verdict.comparisons === 1 ? '' : 's'}` : ''}
          {num(verdict.alpha_adjusted) === undefined ? '' : ` · α ${verdict.alpha_adjusted}`}
          {num(verdict.time_to_decision_days) === undefined
            ? ''
            : ` · ~${verdict.time_to_decision_days}d to decide`}
        </p>
      </div>
    </div>
  );
}

// One arm's line: how far it is from scoreable, and — only if it is — how
// confident the comparison against the control is.
function ArmReadinessRow({ arm, verdict }) {
  const st = arm?.stats;
  if (!st) {
    return (
      <div className="flex items-center gap-2 text-xs">
        <span className="font-mono text-text-primary">{arm?.arm_key}</span>
        <span className="text-text-faint">{DASH} no statistics for this arm</span>
      </div>
    );
  }
  const r = st.readiness || {};
  const isControl = Boolean(st.is_control);
  // The badge rule lives in splitApi as a pure predicate so the harness can pin
  // its truth table. It is NOT inlined here on purpose: a safety rule inside a
  // render function is a safety rule nothing tests.
  const isWinner = shouldShowWinnerBadge(st, verdict);

  // Confidence is the REVENUE comparison's — the metric the winner is ranked
  // on. Undefined (withheld) renders as a dash with the reason, never as 0%.
  const conf = num(st.revenue?.confidence_pct);
  const reason = st.revenue?.reason;

  const shortfall = [];
  if (r.needs_visitors > 0) shortfall.push(`${fmtInt(r.needs_visitors)} more visitors`);
  if (r.needs_conversions > 0) shortfall.push(`${fmtInt(r.needs_conversions)} more orders`);

  return (
    <div className="flex flex-wrap items-center gap-x-2 gap-y-1 text-xs">
      <span className="font-mono text-text-primary shrink-0">{arm.arm_key}</span>
      {isControl && (
        <span className="px-1.5 py-0.5 rounded text-[10px] uppercase tracking-wide
          border border-border-default text-text-faint">
          control
        </span>
      )}
      {isWinner && (
        <span className="px-1.5 py-0.5 rounded text-[10px] font-semibold uppercase tracking-wide
          border border-emerald-500/30 bg-emerald-500/10 text-emerald-300 inline-flex items-center gap-1">
          <Trophy className="w-3 h-3" /> winner
        </span>
      )}

      <span className="text-text-muted tabular-nums">
        {fmtInt(r.visitors)}/{fmtInt(r.min_visitors)} visitors
        {' · '}
        {fmtInt(r.conversions)}/{fmtInt(r.min_conversions)} orders
      </span>

      {r.ready ? (
        <span className="inline-flex items-center gap-1 text-emerald-400">
          <CheckCircle2 className="w-3 h-3" /> ready
        </span>
      ) : (
        <span className="text-amber-300">
          needs ~{shortfall.join(' and ')}
        </span>
      )}

      {/* The control has nothing to compare itself to — a dash, never 0%. */}
      <span className="ml-auto text-text-muted tabular-nums shrink-0">
        {isControl
          ? DASH
          : (conf === undefined
            ? <span title={reason ? String(reason).replace(/_/g, ' ') : 'withheld'}>
              {DASH}{reason ? ` (${String(reason).replace(/_/g, ' ')})` : ''}
            </span>
            : <>
              {fmtPct(conf)}
              <span className={st.revenue?.significant ? ' text-emerald-400' : ' text-text-faint'}>
                {st.revenue?.significant ? ' significant' : ' not significant'}
              </span>
            </>)}
      </span>
    </div>
  );
}

function VerdictBanner({ available, verdict, from, to }) {
  const status = available ? (verdict.status || 'no_winner') : 'unavailable';
  const blocked = available && Boolean(verdict.blocked_reason);
  const tone = blocked ? STATUS_TONE.blocked : (STATUS_TONE[status] || STATUS_TONE.unavailable);

  const headline = available
    ? (verdict.headline || 'No verdict was returned for this window.')
    : 'No verdict yet — experiment metrics are unavailable';

  // The service's own body, verbatim. Never a substitute of my own.
  const serviceBody = available ? verdict.body : null;

  // A caveat is only added when the service said nothing further itself, and
  // only when it is true alongside the status shown.
  let caveat = null;
  if (!available) {
    caveat = 'No experiment metrics were returned for this window, so no verdict can be drawn.';
  } else if (!serviceBody && verdict.sample?.sized_on_observed_effect && verdict.requiredSamplePerArm) {
    caveat = 'The projected sample is sized on the gap observed so far — at low traffic that gap is mostly noise, so treat it as a floor, not a forecast.';
  }

  return (
    <div className={`rounded-xl border px-4 py-3 ${tone.border} ${tone.bg}`}>
      <div className="flex items-start gap-2.5">
        <TrendingUp className={`w-4 h-4 mt-0.5 shrink-0 ${tone.icon}`} />
        <div className="min-w-0">
          <div className="text-sm font-semibold text-text-primary">{headline}</div>
          {serviceBody && <p className="mt-1 text-xs text-text-muted leading-relaxed">{serviceBody}</p>}
          {caveat && <p className="mt-1 text-xs text-text-muted leading-relaxed">{caveat}</p>}
          <p className="mt-1.5 text-[11px] text-text-faint font-mono">
            Window {from || DASH} → {to || DASH}
            {available && verdict.status ? ` · ${verdict.status}` : ''}
            {blocked ? ` · ${verdict.blocked_reason}` : ''}
          </p>
        </div>
      </div>
    </div>
  );
}

// ── Table ──────────────────────────────────────────────────────────────────
// Row order is the reference tool's, verbatim, and it is not arbitrary: it
// walks the funnel top-down (visitors → submits → orders), then money
// pre-upsell → post-upsell, then nets refunds out, and only then reduces
// everything to the one number the ranking uses (revenue per visitor).
//
// Every field name below was read off the MERGED service, not guessed. Two
// sub-lines the reference tool shows (`today · N in window`, `of N
// attributable`) have no source on this endpoint and are GONE rather than
// rendered from an invented number.
const ROWS = [
  {
    key: 'visitors',
    label: 'Visitors',
    fmt: (m) => fmtInt(m.visitors),
    // The service is explicit that this is a checkout-mint count, not page
    // traffic. Saying so once, here, stops the number being read as sessions.
    sub: () => 'reached checkout',
  },
  {
    key: 'submits',
    label: 'Submits',
    fmt: (m) => fmtInt(m.submits),
    // On this endpoint a submit IS the exposure event, so the column always
    // equals Visitors. Labelling that is the honest move: an operator reading
    // two identical columns will otherwise assume one of them is broken.
    sub: (m) => (m.submits === undefined ? null : 'same event as visitors'),
  },
  {
    key: 'submit_rate',
    label: 'Submit rate',
    // submit_rate is `visitors > 0 ? 1 : null` by construction — a constant,
    // not a measurement. Rendering "100.00%" would advertise a perfect submit
    // rate. Shown as not-measured while it is degenerate, and rendered for
    // real the moment the service starts returning a genuine rate.
    fmt: (m) => (isDegenerateSubmitRate(m) ? DASH : fmtPct(m.submit_rate)),
    sub: (m) => (isDegenerateSubmitRate(m) ? 'not measured — no submit event' : null),
  },
  { key: 'orders', label: 'Orders', fmt: (m) => fmtInt(m.orders) },
  {
    key: 'cvr',
    label: 'Conv. rate',
    fmt: (m) => fmtPct(m.cvr),
    // The service withholds a rate under its sample floor. That is a decision,
    // not a gap, and it reads as one.
    sub: (m) => (m.cvr_withheld ? 'withheld — under sample floor' : null),
  },
  {
    key: 'aov_pre_upsell',
    label: 'AOV pre-upsell',
    fmt: (m) => fmtMoney(m.aov_pre_upsell),
    sub: (m) => (m.aov_pre_upsell === undefined && m.aov_reason ? String(m.aov_reason).replace(/_/g, ' ') : null),
  },
  {
    key: 'upsell_legs',
    label: 'Upsell sales (legs)',
    fmt: (m) => fmtInt(m.upsell_legs),
    sub: (m) => (m.upsell_buyers === undefined ? null : `${fmtInt(m.upsell_buyers)} buyers`),
  },
  {
    key: 'upsell_revenue',
    label: 'Upsell revenue',
    fmt: (m) => fmtMoney(m.upsell_revenue),
    sub: (m) => (m.upsell_refunded === undefined ? null : `${fmtMoney(m.upsell_refunded)} refunded`),
  },
  { key: 'aov_post_upsell', label: 'AOV post-upsell', fmt: (m) => fmtMoney(m.aov_post_upsell), highlight: true },
  // The service has no single `revenue` field: gross_revenue = base + upsell.
  { key: 'gross_revenue', label: 'Revenue', fmt: (m) => fmtMoney(m.gross_revenue) },
  // A refund is money leaving. It is rendered NEGATIVE and red even though the
  // API reports it as a positive magnitude — a refund shown as a positive
  // number in a revenue table reads as income.
  {
    key: 'refunded',
    label: 'Refunded',
    fmt: (m) => (m.refunded === undefined ? DASH : fmtMoney(-Math.abs(m.refunded))),
    tone: (m) => (num(m.refunded) ? 'neg' : null),
  },
  { key: 'net_revenue', label: 'Net revenue', fmt: (m) => fmtMoney(m.net_revenue) },
  { key: 'rev_per_visitor', label: 'Rev / visitor', fmt: (m) => fmtMoney(m.rev_per_visitor), highlight: true },
  {
    key: 'vs_control_rpv_pct',
    label: 'vs control',
    // ALREADY a percent from the service — it must not cross fracToPct.
    // The control is the baseline: it has nothing to compare itself to, so the
    // cell is a dash, NOT 0.00% (which would read as "flat against itself").
    fmt: (m, col) => (col.is_control ? DASH : fmtPct(m.vs_control_rpv_pct, { signed: true })),
    tone: (m, col) => (col.is_control ? null : (num(m.vs_control_rpv_pct) < 0 ? 'neg' : null)),
  },
  {
    key: 'confidence',
    label: 'Confidence',
    // From verdict.perArm[arm_key].revenue_confidence, already converted from a
    // fraction to a percent exactly once in splitApi.normalizeMetrics.
    fmt: (m, col) => (col.is_control ? DASH : fmtPct(m.confidence)),
    sub: (m, col) => (col.is_control || m.significant === undefined ? null : (m.significant ? 'significant' : 'not significant')),
  },
];

// submit_rate is degenerate when it is exactly 100% and equals the visitor
// count — the service's `visitors > 0 ? 1 : null` identity.
function isDegenerateSubmitRate(m) {
  const r = num(m.submit_rate);
  return r === undefined || (Math.abs(r - 100) < 1e-9 && m.submits === m.visitors);
}

function MetricsTable({ columns }) {
  return (
    <div className="rounded-xl border border-border-default overflow-hidden">
      <div className="px-4 py-2 border-b border-border-subtle bg-bg-elevated/40">
        <span className="text-[10px] font-semibold uppercase tracking-wider text-text-faint">
          Experiment — only this window · ranked on net revenue per visitor
        </span>
      </div>
      <div className="overflow-x-auto">
        <table className="w-full text-sm">
          <thead>
            <tr className="border-b border-border-subtle">
              <th className="text-left font-medium px-4 py-2.5 text-[11px] uppercase tracking-wider text-text-faint">
                Metric
              </th>
              {columns.map((c) => (
                <th key={c.key} className="text-right font-medium px-4 py-2.5 text-[11px] uppercase tracking-wider text-text-faint">
                  {c.letter}{c.is_control ? ' ctrl' : ''}
                </th>
              ))}
              {columns.length === 0 && (
                <th className="text-right px-4 py-2.5 text-[11px] text-text-faint">No arms</th>
              )}
            </tr>
          </thead>
          <tbody>
            {ROWS.map((row) => (
              <tr
                key={row.key}
                className={`border-b border-border-subtle last:border-0 ${row.highlight ? 'bg-accent-muted/30' : ''}`}
              >
                <td className={`px-4 py-2 ${row.highlight ? 'text-text-primary font-semibold' : 'text-text-muted'}`}>
                  {row.label}
                </td>
                {columns.map((c) => {
                  const tone = row.tone?.(c.m, c);
                  const sub = row.sub?.(c.m, c);
                  return (
                    <td key={c.key} className="px-4 py-2 text-right tabular-nums">
                      <span className={
                        tone === 'neg'
                          ? 'text-red-400'
                          : row.highlight ? 'text-text-primary font-semibold' : 'text-text-primary'
                      }>
                        {row.fmt(c.m, c)}
                      </span>
                      {sub && <span className="block text-[10px] text-text-faint">{sub}</span>}
                    </td>
                  );
                })}
                {columns.length === 0 && <td className="px-4 py-2 text-right text-text-faint">{DASH}</td>}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}
