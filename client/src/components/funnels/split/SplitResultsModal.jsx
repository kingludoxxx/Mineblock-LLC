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
// This modal writes NOTHING. It is a pure read of derived figures.
import { useCallback, useEffect, useMemo, useState } from 'react';
import { X, TrendingUp, AlertTriangle, Loader2 } from 'lucide-react';
import {
  fetchSplitMetrics, armLetter, fmtInt, fmtMoney, fmtPct, fmtDate, fmtDateTime,
  isoDay, num, DASH,
} from './splitApi';

export default function SplitResultsModal({ open, onClose, test }) {
  const testId = test?.id;
  const handle = test?.handle || '';
  const createdAt = test?.created_at;

  // Default window: the day the test was created → today. The experiment view
  // is defined as "only traffic from that day onward", so the default IS that
  // statement rather than a rolling 7/30 days that would silently exclude it.
  const [range, setRange] = useState(() => ({ from: '', to: '' }));
  const [state, setState] = useState({ loading: true, available: false, reason: null, data: null });

  useEffect(() => {
    if (!open) return;
    const today = isoDay(new Date());
    const start = createdAt ? isoDay(new Date(createdAt)) : today;
    setRange({ from: start && start <= today ? start : today, to: today });
  }, [open, createdAt]);

  const load = useCallback(async () => {
    if (!testId) return;
    setState((s) => ({ ...s, loading: true }));
    const res = await fetchSplitMetrics(testId, { from: range.from, to: range.to });
    setState({ loading: false, available: res.available, reason: res.reason || null, data: res.data || null });
  }, [testId, range.from, range.to]);

  useEffect(() => { if (open && range.from && range.to) load(); }, [open, range.from, range.to, load]);

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
