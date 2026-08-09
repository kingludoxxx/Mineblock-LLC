// Live View — the real-time board (NEW FILE).
//
// Port of funnel-os's LiveViewPage composition (top bar + live counter +
// rail) onto Puure's data, minus what we honestly cannot show:
//   • THE GLOBE IS NOT PORTED. The reference geolocates visitors from
//     Cloudflare edge headers captured at ingest; Puure stores salted IP
//     hashes only and captures no geo header, so there is nothing truthful to
//     plot. The board says so in an explicit "geo unavailable" card instead
//     of fabricating locations (server: liveViewQueries.js geo.available).
//   • Sparklines/checkout-health/new-vs-returning are follow-ups, not here.
//
// What IS here, matching the reference's shape:
//   • big live-visitor counter (same definition as the canvas live chip) +
//     today tiles (unique visitors, checkout starts, purchases, revenue)
//   • per-funnel live breakdown
//   • scrolling event rail (view / checkout_start / purchase, color-coded,
//     relative timestamps)
//   • connection dot (live / reconnecting) + manual resync + auto-reconnect
//     with jittered backoff (useLiveFeed.js)
//
// ⚠️ INTEGRATION HOOKS (flagged in the delivery report):
//   client/src/App.jsx                    — ONE additive route line
//   client/src/components/layout/Sidebar.jsx — ONE additive nav item
import { Radio, RefreshCw, Globe2, Users, CreditCard, BadgeDollarSign, TrendingUp } from 'lucide-react';
import Card from '../../components/ui/Card';
import useLiveFeed from './useLiveFeed';
import EventRail, { useTick, timeAgo, fmtMoney } from './EventRail';

function ConnectionDot({ status }) {
  const color =
    status === 'live' ? 'bg-success' : status === 'connecting' ? 'bg-warning' : 'bg-danger';
  return (
    <span className="relative inline-flex h-2.5 w-2.5">
      {status === 'live' && (
        <span className={`absolute inline-flex h-full w-full animate-ping rounded-full opacity-60 ${color}`} />
      )}
      <span className={`relative inline-flex h-2.5 w-2.5 rounded-full ${color}`} />
    </span>
  );
}

const STATUS_LABEL = {
  connecting: 'Connecting…',
  live: 'Live',
  reconnecting: 'Reconnecting…',
  error: 'Disconnected',
};

// null means "could not measure" (a degraded source) — render a dash, never 0.
const showInt = (v) => (v == null ? '—' : Number(v).toLocaleString('en-US'));

function Tile({ icon: Icon, label, value, accent = false }) {
  return (
    <Card className="p-4">
      <div className="flex items-center gap-2 text-[11px] font-medium uppercase tracking-wide text-text-faint">
        <Icon className="h-3.5 w-3.5" />
        {label}
      </div>
      <div className={`mt-1.5 text-2xl font-semibold tabular-nums ${accent ? 'text-accent-text' : 'text-text-primary'}`}>
        {value}
      </div>
    </Card>
  );
}

function FunnelBreakdown({ rows }) {
  if (!rows || rows.length === 0) {
    return <p className="py-6 text-center text-[12px] text-text-faint">No funnel traffic today.</p>;
  }
  const maxLive = Math.max(1, ...rows.map((r) => r.live || 0));
  return (
    <ul className="space-y-2.5">
      {rows.map((r) => (
        <li key={r.funnel_id || 'unattributed'}>
          <div className="flex items-baseline justify-between gap-2 text-[13px]">
            <span className="truncate text-text-primary">
              {r.name || r.slug || r.funnel_id || 'Unattributed'}
            </span>
            <span className="shrink-0 tabular-nums text-text-muted">
              <span className="font-semibold text-text-primary">{showInt(r.live)}</span> live
              <span className="mx-1 text-text-faint">·</span>
              {showInt(r.unique_today)} today
            </span>
          </div>
          <div className="mt-1 h-1.5 overflow-hidden rounded-full bg-bg-elevated">
            <div
              className="h-full rounded-full bg-success transition-all duration-700"
              style={{ width: `${Math.round(((r.live || 0) / maxLive) * 100)}%` }}
            />
          </div>
        </li>
      ))}
    </ul>
  );
}

export default function LiveViewPage() {
  const { status, error, snapshot, feed, lastMessageAt, reconnect } = useLiveFeed();
  useTick(5000); // keeps "updated Xs ago" honest between frames

  const s = snapshot || {};
  const degraded = Boolean(s.degraded);

  return (
    <div className="max-w-[1600px] space-y-5 p-6">
      {/* Top bar — title + connection state + resync */}
      <div className="flex flex-wrap items-end justify-between gap-4">
        <div>
          <h1 className="flex items-center gap-2 text-xl font-semibold text-text-primary">
            <Radio className="h-5 w-5 text-accent-text" />
            Live View
          </h1>
          <p className="mt-0.5 text-sm text-text-muted">
            Visitors, checkouts and purchases as they happen. Live = distinct visitors in the last 5 minutes.
          </p>
        </div>
        <div className="flex items-center gap-3">
          <span className="flex items-center gap-2 rounded-lg border border-border-default bg-bg-elevated px-3 py-1.5 text-[12px] text-text-muted">
            <ConnectionDot status={status} />
            {STATUS_LABEL[status] || status}
            {lastMessageAt ? (
              <span className="text-text-faint">· updated {timeAgo(lastMessageAt)}</span>
            ) : null}
          </span>
          <button
            type="button"
            onClick={reconnect}
            className="flex h-[34px] items-center gap-1.5 rounded-lg border border-border-default bg-bg-elevated px-3 text-[12px] text-text-muted transition-colors hover:text-text-primary"
          >
            <RefreshCw className="h-3.5 w-3.5" />
            Resync
          </button>
        </div>
      </div>

      {/* Connection / degradation notices */}
      {status !== 'live' && error ? (
        <div className="flex items-center gap-2.5 rounded-lg border border-danger/30 bg-danger/5 px-3 py-2.5 text-[12px] text-danger">
          <span className="font-medium">Stream interrupted:</span> {error} — retrying automatically.
        </div>
      ) : null}
      {degraded ? (
        <div className="rounded-lg border border-amber-500/30 bg-amber-500/5 px-3 py-2.5 text-[12px] text-amber-200/90">
          Some sources degraded this refresh —{' '}
          {(s.warnings || []).map((w) => w.source).join(', ') || 'unknown source'}. Dashes mean
          &ldquo;could not measure&rdquo;, never zero.
        </div>
      ) : null}

      {/* Hero counter + today tiles */}
      <div className="grid grid-cols-2 gap-4 lg:grid-cols-5">
        <Card className="col-span-2 flex flex-col justify-between p-5 lg:col-span-1">
          <div className="flex items-center gap-2 text-[11px] font-medium uppercase tracking-wide text-text-faint">
            <span className="relative inline-flex h-2 w-2">
              <span className="absolute inline-flex h-full w-full animate-ping rounded-full bg-success opacity-60" />
              <span className="relative inline-flex h-2 w-2 rounded-full bg-success" />
            </span>
            Visitors now
          </div>
          <div className="mt-2 text-5xl font-semibold tabular-nums leading-none text-text-primary" data-testid="lv-live-total">
            {showInt(s.live_total)}
          </div>
          <div className="mt-2 text-[11px] text-text-faint">last 5 minutes, all funnels</div>
        </Card>
        <Tile icon={Users} label="Unique today" value={showInt(s.unique_today_total)} />
        <Tile icon={CreditCard} label="Checkout starts today" value={showInt(s.checkout_starts_today)} />
        <Tile icon={BadgeDollarSign} label="Purchases today" value={showInt(s.purchases_today)} />
        <Tile
          icon={TrendingUp}
          label="Revenue today"
          value={s.revenue_today == null ? '—' : fmtMoney(s.revenue_today) || '—'}
          accent
        />
      </div>

      {/* Two-zone body: breakdown + geo note (left) · event rail (right) */}
      <div className="grid grid-cols-1 gap-4 xl:grid-cols-5">
        <div className="space-y-4 xl:col-span-2">
          <Card>
            <h2 className="mb-3 text-sm font-semibold text-text-primary">Live by funnel</h2>
            <FunnelBreakdown rows={s.by_funnel} />
          </Card>
          {/* The honest globe replacement — see file header. */}
          <Card className="border-dashed">
            <div className="flex items-start gap-3">
              <Globe2 className="mt-0.5 h-5 w-5 shrink-0 text-text-faint" />
              <div>
                <h3 className="text-[13px] font-medium text-text-primary">Visitor map unavailable</h3>
                <p className="mt-1 text-[12px] leading-relaxed text-text-muted">
                  {s.geo?.reason ||
                    'Tracking stores salted IP hashes only and no geo headers are captured, so visitor locations cannot be shown truthfully.'}
                </p>
              </div>
            </div>
          </Card>
        </div>
        <Card className="xl:col-span-3">
          <div className="mb-3 flex items-baseline justify-between">
            <h2 className="text-sm font-semibold text-text-primary">Activity</h2>
            <span className="text-[11px] text-text-faint">
              pageviews · checkout starts · purchases
            </span>
          </div>
          <EventRail feed={feed} />
        </Card>
      </div>
    </div>
  );
}
