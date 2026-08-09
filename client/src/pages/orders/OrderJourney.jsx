// Order journey — the cross-system event trail for one order.
//
// Ported from funnel-os's OrderJourneyPanels.jsx. Read-only: this component
// issues exactly one GET and renders it. There is no action anywhere in it,
// deliberately — several of the events it shows (a needs_review upsell, a
// failed tracking send) are states a human owns, and a retry button next to
// them would be an invitation to double-charge.
import { useEffect, useState } from 'react';
import {
  AlertTriangle,
  ChevronRight,
  CreditCard,
  ExternalLink,
  Mail,
  RotateCcw,
  ShoppingBag,
  Target,
  Zap,
} from 'lucide-react';
import api from '../../services/api';

const SOURCE_META = {
  checkout: { icon: CreditCard, label: 'Checkout', tone: 'text-sky-400 bg-sky-500/10 border-sky-500/20' },
  upsell: { icon: Zap, label: 'Upsell', tone: 'text-violet-400 bg-violet-500/10 border-violet-500/20' },
  tracking: { icon: Target, label: 'Tracking', tone: 'text-amber-400 bg-amber-500/10 border-amber-500/20' },
  klaviyo: { icon: Mail, label: 'Klaviyo', tone: 'text-emerald-400 bg-emerald-500/10 border-emerald-500/20' },
  shopify: { icon: ShoppingBag, label: 'Shopify', tone: 'text-text-muted bg-bg-elevated border-border-default' },
  refund: { icon: RotateCcw, label: 'Refund', tone: 'text-red-400 bg-red-500/10 border-red-500/20' },
};

const FAILED_TONE = 'text-red-400 bg-red-500/10 border-red-500/20';

const fmtAbs = (iso) => {
  if (!iso) return 'undated';
  const d = new Date(iso);
  return `${d.toLocaleDateString('en-GB', { day: '2-digit', month: 'short' })} ${d.toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit', second: '2-digit' })}`;
};

// Relative to the FIRST entry, not to now. "3 minutes after the session
// started" is what an operator reading a funnel trail actually wants; "4 months
// ago" repeated on every row tells them nothing about the order.
function relativeToStart(iso, startIso) {
  if (!iso || !startIso) return null;
  const delta = (new Date(iso) - new Date(startIso)) / 1000;
  if (!Number.isFinite(delta)) return null;
  if (delta < 1) return 'start';
  if (delta < 60) return `+${Math.round(delta)}s`;
  if (delta < 3600) return `+${Math.round(delta / 60)}m`;
  if (delta < 86400) return `+${(delta / 3600).toFixed(1)}h`;
  return `+${(delta / 86400).toFixed(1)}d`;
}

function Entry({ entry, startIso }) {
  const [open, setOpen] = useState(false);
  const meta = SOURCE_META[entry.source] || SOURCE_META.shopify;
  const Icon = entry.failed ? AlertTriangle : meta.icon;
  const tone = entry.failed ? FAILED_TONE : meta.tone;
  const hasPayload = entry.payload && Object.keys(entry.payload).length > 0;

  return (
    <li className="relative pl-9 pb-4 last:pb-0">
      <span
        className={`absolute left-0 top-0 inline-flex items-center justify-center w-6 h-6 rounded-full border ${tone}`}
      >
        <Icon className="w-3.5 h-3.5" />
      </span>
      <div className="flex items-baseline gap-2 flex-wrap">
        <span className="text-sm font-medium text-text-primary">{entry.title}</span>
        <span className="text-[11px] uppercase tracking-wider text-text-faint">{meta.label}</span>
        <span className="text-xs text-text-muted ml-auto whitespace-nowrap">
          {relativeToStart(entry.ts, startIso)} · {fmtAbs(entry.ts)}
        </span>
      </div>
      {entry.detail && <div className="mt-0.5 text-xs text-text-muted break-all">{entry.detail}</div>}
      {hasPayload && (
        <>
          <button
            onClick={() => setOpen((o) => !o)}
            className="mt-1 inline-flex items-center gap-1 text-[11px] text-text-faint hover:text-text-primary cursor-pointer transition-colors"
          >
            <ChevronRight className={`w-3 h-3 transition-transform ${open ? 'rotate-90' : ''}`} />
            {open ? 'Hide' : 'Show'} payload
          </button>
          {open && (
            <pre className="mt-1 px-2.5 py-2 text-[11px] leading-relaxed text-text-muted bg-bg-elevated border border-border-subtle rounded-md overflow-x-auto">
              {JSON.stringify(entry.payload, null, 2)}
            </pre>
          )}
        </>
      )}
    </li>
  );
}

export default function OrderJourney({ orderId }) {
  // One state object carrying the id it belongs to. The effect therefore never
  // has to setState synchronously just to show a spinner: "loading" is derived
  // from the result being for a DIFFERENT order than the one asked for, which
  // is also what makes a mid-flight orderId change render correctly instead of
  // briefly showing the previous order's trail under the new order's heading.
  const [result, setResult] = useState({ forId: null, data: null, error: null });

  useEffect(() => {
    let cancelled = false;
    api
      .get(`/orders/${orderId}/journey`)
      .then((res) => {
        if (!cancelled) setResult({ forId: orderId, data: res.data?.data || null, error: null });
      })
      .catch((err) => {
        if (!cancelled) {
          setResult({
            forId: orderId,
            data: null,
            error: err.response?.data?.error || 'Failed to load the journey',
          });
        }
      });
    return () => {
      cancelled = true;
    };
  }, [orderId]);

  if (String(result.forId) !== String(orderId)) {
    return <div className="py-8 text-center text-sm text-text-muted">Loading journey…</div>;
  }
  if (result.error) return <div className="py-8 text-center text-sm text-danger">{result.error}</div>;
  const data = result.data;
  if (!data) return null;

  const entries = data.entries || [];
  const startIso = entries[0]?.ts || null;
  const counts = data.counts || {};

  return (
    <div className="space-y-4">
      {!data.linked && (
        <div className="flex gap-2.5 px-3 py-2.5 rounded-lg bg-bg-elevated border border-border-default">
          <AlertTriangle className="w-4 h-4 text-text-muted shrink-0 mt-0.5" />
          <p className="text-xs text-text-muted leading-relaxed">{data.link_reason}</p>
        </div>
      )}

      {data.sources_unavailable?.length > 0 && (
        <div className="px-3 py-2 text-xs text-amber-400 bg-amber-500/10 border border-amber-500/20 rounded-lg">
          Not provisioned in this deployment, so nothing from them is shown:{' '}
          {data.sources_unavailable.join(', ')}. These are absent systems, not empty ones.
        </div>
      )}

      <div className="flex items-center gap-2 flex-wrap text-xs">
        {Object.entries(SOURCE_META).map(([key, m]) => {
          const n = counts[key];
          if (!n) return null;
          return (
            <span
              key={key}
              className={`inline-flex items-center gap-1.5 px-2 py-0.5 rounded-full border ${m.tone}`}
            >
              <m.icon className="w-3 h-3" />
              {n} {m.label.toLowerCase()}
            </span>
          );
        })}
        {data.session_id && (
          <span className="text-text-faint">
            session <span className="text-text-muted">{data.session_id}</span>
          </span>
        )}
        {data.shopify?.admin_url && (
          <a
            href={data.shopify.admin_url}
            target="_blank"
            rel="noreferrer"
            className="inline-flex items-center gap-1 text-accent-text hover:underline"
          >
            Open in Shopify <ExternalLink className="w-3 h-3" />
          </a>
        )}
      </div>

      {entries.length === 0 ? (
        <p className="py-8 text-center text-sm text-text-muted">No events recorded for this order.</p>
      ) : (
        <ol className="relative border-l border-border-subtle ml-3 pl-0 mt-2">
          <div className="space-y-0">
            {entries.map((e, i) => (
              <Entry key={`${e.source}-${e.kind}-${e.ts}-${i}`} entry={e} startIso={startIso} />
            ))}
          </div>
        </ol>
      )}
    </div>
  );
}
