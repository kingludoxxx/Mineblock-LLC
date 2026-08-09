// EventRail — the Live View scrolling event feed (NEW FILE).
//
// Port of funnel-os's orders-feed / rail-card language onto our three event
// types. Color coding:
//   view           → sky      (a delivered pageview)
//   checkout_start → amber    (co_events 'session_created')
//   purchase       → emerald  (co_events 'paid' / 'upsell_settled')
// Every timestamp renders relative and re-renders on a 5s tick, like the
// reference's timeAgo/useTick pair.
import { useEffect, useState } from 'react';
import { Eye, CreditCard, BadgeDollarSign, Radio } from 'lucide-react';

export function useTick(ms = 5000) {
  const [, setN] = useState(0);
  useEffect(() => {
    const t = setInterval(() => setN((n) => n + 1), ms);
    return () => clearInterval(t);
  }, [ms]);
}

export function timeAgo(ts) {
  if (!ts) return '';
  const s = Math.max(0, Math.floor((Date.now() - new Date(ts).getTime()) / 1000));
  if (s < 5) return 'just now';
  if (s < 60) return `${s}s ago`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m ago`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h}h ago`;
  return `${Math.floor(h / 24)}d ago`;
}

export function fmtMoney(v, currency = 'USD') {
  if (v == null || !Number.isFinite(Number(v))) return null;
  try {
    return new Intl.NumberFormat('en-US', {
      style: 'currency',
      currency: currency || 'USD',
      maximumFractionDigits: 2,
    }).format(Number(v));
  } catch {
    return `$${Number(v).toFixed(2)}`;
  }
}

const TYPE_META = {
  view: {
    icon: Eye,
    label: 'Pageview',
    dot: 'bg-sky-400',
    text: 'text-sky-300',
    ring: 'border-sky-400/20 bg-sky-400/5',
  },
  checkout_start: {
    icon: CreditCard,
    label: 'Checkout started',
    dot: 'bg-amber-400',
    text: 'text-amber-300',
    ring: 'border-amber-400/20 bg-amber-400/5',
  },
  purchase: {
    icon: BadgeDollarSign,
    label: 'Purchase',
    dot: 'bg-emerald-400',
    text: 'text-emerald-300',
    ring: 'border-emerald-400/20 bg-emerald-400/5',
  },
};

function EventRow({ ev }) {
  const meta = TYPE_META[ev.type] || TYPE_META.view;
  const Icon = meta.icon;
  const money = fmtMoney(ev.value, ev.currency);
  const where =
    ev.funnel_name ||
    (ev.funnel_id ? `funnel ${String(ev.funnel_id).slice(0, 12)}…` : 'unattributed');
  const page = ev.page_title || ev.page_slug || null;
  return (
    <li
      className={`flex items-start gap-3 rounded-lg border px-3 py-2.5 ${meta.ring}`}
      data-testid={`lv-event-${ev.type}`}
    >
      <span className={`mt-0.5 flex h-6 w-6 shrink-0 items-center justify-center rounded-full ${meta.ring} border`}>
        <Icon className={`h-3.5 w-3.5 ${meta.text}`} />
      </span>
      <div className="min-w-0 flex-1">
        <div className="flex items-baseline justify-between gap-2">
          <span className={`text-[13px] font-medium ${meta.text}`}>
            {meta.label}
            {ev.upsell ? <span className="ml-1.5 text-[10px] uppercase tracking-wide text-emerald-400/80">upsell</span> : null}
          </span>
          <span className="shrink-0 text-[11px] tabular-nums text-text-faint">{timeAgo(ev.ts)}</span>
        </div>
        <div className="mt-0.5 truncate text-[12px] text-text-muted">
          {where}
          {page ? <span className="text-text-faint"> · {page}</span> : null}
          {money ? <span className="ml-1.5 font-semibold text-text-primary">{money}</span> : null}
        </div>
      </div>
    </li>
  );
}

export default function EventRail({ feed }) {
  useTick(5000); // relative timestamps stay honest without new data
  if (!feed || feed.length === 0) {
    return (
      <div className="flex flex-col items-center justify-center gap-2 py-14 text-center">
        <Radio className="h-6 w-6 text-text-faint" />
        <p className="text-sm text-text-muted">No activity yet</p>
        <p className="max-w-[240px] text-[12px] text-text-faint">
          Pageviews, checkout starts and purchases will stream in here as they happen.
        </p>
      </div>
    );
  }
  return (
    <ul className="space-y-2 overflow-y-auto pr-1" style={{ maxHeight: 'calc(100vh - 260px)' }}>
      {feed.map((ev) => (
        <EventRow key={ev.id} ev={ev} />
      ))}
    </ul>
  );
}
