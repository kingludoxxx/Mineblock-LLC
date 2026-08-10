// Last60Card — sixty days of trend, independent of the picker
// (NEW FILE, LANE 5).
//
// ── WHY IT IGNORES THE DATE PICKER, AND SAYS SO ─────────────────────────────
//
// Every other card on this page moves with the range selector. This one does
// not: it is the long baseline the INSIGHT DETECTORS judge against, and its
// whole value is that it does not change when the operator narrows the window.
// A card silently on a different window from the one in the header is the
// quietest kind of wrong, so the window it IS on is printed in its subtitle,
// and the comparison window is never implied.
//
// ── ONE SERIES, THREE READINGS ──────────────────────────────────────────────
// The payload carries six metrics over the same sixty buckets. This card draws
// one at a time (net sales by default) rather than overlaying money on counts —
// a $12,000 line and a 340-order line share no axis, and drawing them together
// makes one of them a flat line at the bottom of the canvas.
//
// A NEVER-MEASURED BUCKET IS A HOLE. `numOrGap` + `connectNulls={false}`, the
// same rule the rest of this workspace runs, and the count of holes is admitted
// in the caption — sixty days is long enough to reach the touch retention, so
// the `sessions` reading in particular WILL have gaps on most accounts.
import { useMemo, useState } from 'react';
import { LineCard } from './cardKit.jsx';
import { lastNOf, seriesCol, bucketKeys } from '../insightsApi.js';
import {
  EM_DASH, fmtCountShort, fmtMoney, fmtMoneyShort, fmtInt, present,
} from './dashFormat.js';

/**
 * The readings this card offers. `agg` says how the headline is folded:
 * money and counts SUM, and nothing here averages a rate — the engine's own
 * rule is that a ratio is recomputed from folded sums, never averaged, so this
 * card simply does not offer a rate reading rather than offering a wrong one.
 */
const READINGS = Object.freeze([
  {
    id: 'net_sales', label: 'Net sales', fmt: fmtMoneyShort, headFmt: fmtMoney,
    sub: 'Refunds already taken off',
  },
  {
    id: 'orders', label: 'Orders', fmt: fmtCountShort, headFmt: fmtInt,
    sub: 'Base orders — upsell reversals are not counted here',
  },
  {
    id: 'sessions', label: 'Sessions', fmt: fmtCountShort, headFmt: fmtInt,
    sub: 'Distinct visitors per day — not hits',
  },
]);

export default function Last60Card({
  insights, state, error, testid = 'an-card-last-60',
}) {
  const [reading, setReading] = useState('net_sales');
  const block = useMemo(() => lastNOf(insights), [insights]);
  const spec = READINGS.find((r) => r.id === reading) || READINGS[0];

  const points = useMemo(() => seriesCol(block.series, spec.id), [block.series, spec.id]);
  const labels = useMemo(() => bucketKeys(block.series), [block.series]);

  // THE HEADLINE IS A FOLD OF THE MEASURED BUCKETS, and it says how many it
  // folded. Summing sixty buckets of which nineteen are holes and printing the
  // result as "last 60 days" would understate by exactly the missing days with
  // nothing on screen admitting it.
  const measured = points.filter((v) => v !== null);
  const total = measured.length ? measured.reduce((a, b) => a + b, 0) : null;
  const gaps = points.length - measured.length;

  const win = block.window;
  const sub = [
    win && win.start && win.end ? `${win.start} → ${win.end}` : '',
    'fixed 60-day window — this card does not follow the date picker',
    spec.sub,
  ].filter(Boolean).join(' · ');

  // A withheld-sessions reading over a 60-day window is the EXPECTED case, not
  // a fault: the touch ledger keeps 90 days but the composite may still have
  // clipped it. Name the reason so the holes read as retention, not as outage.
  const withheldReason = spec.id === 'sessions' && block.sessionsUnknown
    ? 'Part of this 60-day window reaches past the 90-day tracking retention, so the visitor spine '
      + 'for those days no longer exists. The visitors are not zero — the record of them has expired.'
    : undefined;

  const action = (
    <div className="flex gap-1 shrink-0" role="group" aria-label="Reading" data-testid={`${testid}-readings`}>
      {READINGS.map((r) => (
        <button
          key={r.id}
          type="button"
          onClick={() => setReading(r.id)}
          aria-pressed={r.id === reading}
          className={`text-[10px] px-1.5 py-0.5 rounded border transition-colors ${
            r.id === reading
              ? 'border-accent/45 text-accent-text bg-accent/10'
              : 'border-border-default text-text-faint hover:text-text-muted'
          }`}
          data-testid={`${testid}-reading-${r.id}`}
        >
          {r.label}
        </button>
      ))}
    </div>
  );

  return (
    <LineCard
      title="Last 60 days"
      headline={state === 'loading' ? undefined : (present(total) ? spec.headFmt(total) : EM_DASH)}
      sub={sub}
      action={action}
      points={points}
      prevPoints={[]}
      labels={labels}
      prevLabels={[]}
      fmt={spec.fmt}
      height={190}
      state={state}
      reason={error ? String(error) : undefined}
      withheldReason={withheldReason}
      testid={testid}
      comparisonLabel={`${spec.label}, ${measured.length} of ${points.length} days measured`}
      footNote={gaps > 0 ? 'holes are days this build could not measure, never days at zero' : undefined}
    />
  );
}
