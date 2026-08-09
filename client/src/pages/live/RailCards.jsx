// RailCards — the event-rail card kit.
//
// Port of funnel-os's RailCards.jsx structure onto our three wire types and
// our dark tokens. His hierarchy, kept verbatim:
//   [icon]  TITLE ................................ timeAgo
//           where · page                           AMOUNT
// with the type carried by an accent (icon colour + left rail + tint) rather
// than by a text label, so a fast-moving feed reads as colour first.
//
// Our types (server/src/services/liveViewQueries.js):
//   view           ← lb_touches                    sky
//   checkout_start ← co_events 'session_created'   amber
//   purchase       ← co_events 'paid'              emerald
//                    ('upsell_settled' → purchase + upsell:true)
import { Eye, CreditCard, BadgeDollarSign, Radio } from 'lucide-react';
import { fmtMoney, timeAgo } from './livePresentation.js';
import './liveview.css';

// Module-local on purpose: exporting a non-component beside components trips
// react-refresh/only-export-components, and nothing outside this file needs it.
const TYPE_META = {
  view: {
    icon: Eye,
    label: 'Pageview',
    text: 'text-sky-300',
    tint: 'border-sky-400/20 bg-sky-400/5',
    rail: 'bg-sky-400/60',
  },
  checkout_start: {
    icon: CreditCard,
    label: 'Checkout started',
    text: 'text-amber-300',
    tint: 'border-amber-400/20 bg-amber-400/5',
    rail: 'bg-amber-400/70',
  },
  purchase: {
    icon: BadgeDollarSign,
    label: 'Purchase',
    text: 'text-emerald-300',
    tint: 'border-emerald-400/20 bg-emerald-400/5',
    rail: 'bg-emerald-400/80',
  },
};

/**
 * One rail row.
 * `fresh` flashes the row once — driven by diffFreshIds, which deliberately
 * does NOT flash the backfill on first paint (opening the board at 6pm must
 * not light up every purchase of the day as if it had just landed).
 */
export function RailCard({ ev, fresh = false }) {
  const meta = TYPE_META[ev.type] || TYPE_META.view;
  const Icon = meta.icon;
  const money = fmtMoney(ev.value, ev.currency);
  const where = ev.funnel_name
    || (ev.funnel_id ? `funnel ${String(ev.funnel_id).slice(0, 12)}…` : 'unattributed');
  const page = ev.page_title || ev.page_slug || null;

  return (
    <li
      className={`relative flex items-start gap-3 overflow-hidden rounded-lg border py-2.5 pl-4 pr-3 ${meta.tint} ${fresh ? 'lv-row-fresh' : ''}`}
      data-testid={`lv-event-${ev.type}`}
    >
      {/* the type rail */}
      <span className={`absolute inset-y-0 left-0 w-[3px] ${meta.rail}`} aria-hidden="true" />

      <span className={`mt-0.5 flex h-6 w-6 shrink-0 items-center justify-center rounded-full border ${meta.tint}`}>
        <Icon className={`h-3.5 w-3.5 ${meta.text}`} />
      </span>

      <div className="min-w-0 flex-1">
        <div className="flex items-baseline justify-between gap-2">
          <span className={`truncate text-[13px] font-medium ${meta.text}`}>
            {meta.label}
            {ev.upsell ? (
              <span className="ml-1.5 rounded bg-accent-muted px-1 py-px text-[9px] uppercase tracking-wide text-accent-text">
                upsell
              </span>
            ) : null}
          </span>
          <span className="shrink-0 text-[11px] tabular-nums text-text-faint">{timeAgo(ev.ts)}</span>
        </div>

        <div className="mt-0.5 flex items-baseline justify-between gap-2">
          <span className="min-w-0 truncate text-[12px] text-text-muted">
            {where}
            {page ? <span className="text-text-faint"> · {page}</span> : null}
          </span>
          {/* An amount is rendered only when there IS one. A purchase with a
              null value means the amount was not recorded — printing $0.00
              there would claim the sale was free. */}
          {money ? (
            <span className="shrink-0 text-[12px] font-semibold tabular-nums text-text-primary">
              {money}
            </span>
          ) : null}
        </div>
      </div>
    </li>
  );
}

/** The zero-event state. Honest about what will appear, and why nothing has. */
export function RailEmpty({ connected = true }) {
  return (
    <div
      className="flex flex-col items-center justify-center gap-2 py-14 text-center"
      data-testid="lv-rail-empty"
    >
      <Radio className={`h-6 w-6 text-text-faint ${connected ? 'lv-breathe' : ''}`} />
      <p className="text-sm text-text-muted">No activity yet</p>
      <p className="max-w-[260px] text-[12px] leading-relaxed text-text-faint">
        {connected
          ? 'Pageviews, checkout starts and purchases will stream in here as they happen.'
          : 'The stream is reconnecting — this list will refill from the next snapshot.'}
      </p>
    </div>
  );
}

export default RailCard;
