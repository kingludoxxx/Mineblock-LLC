// Live View — the real-time board.
//
// Presentation layer ported from funnel-os's liveview kit: the rotating globe,
// the payment toast stack, the sale-alert controls and the rail card language.
// The data plane underneath (SSE + snapshot) is ours and unchanged — this lane
// did not touch server/src/routes/liveView.js or its services.
//
// WHAT IS REAL AND WHAT IS NOT. The reference plots a pin per visitor and an
// arc from buyer to store. Our wire cannot support that and the globe says so:
// feed events carry no geo at all (liveViewQueries.js selects neither
// lb_touches.country into a touch event nor any location for a purchase), so
// LiveGlobe plots COUNTRIES from snapshot.geo.by_country at their centroids,
// sized by visitor count, and ripples one when a country's count RISES between
// snapshots. That rise is the only arrival claim the payload supports.
//
// Sparklines / checkout-health / new-vs-returning remain follow-ups.
//
// ⚠️ INTEGRATION HOOKS (already merged on main):
//   client/src/App.jsx                       — route  /app/live-view
//   client/src/components/layout/Sidebar.jsx — nav item
import { useCallback, useEffect, useRef } from 'react';
import { Radio, RefreshCw, Users, CreditCard, BadgeDollarSign, TrendingUp } from 'lucide-react';
import Card from '../../components/ui/Card';
import useLiveFeed from './useLiveFeed';
import EventRail from './EventRail';
import LiveGlobe from './LiveGlobe';
import PaymentToastStack from './PaymentToastStack';
import SaleAlertControls from './SaleAlertControls';
import usePaymentToasts from './usePaymentToasts';
import useSaleAlerts from './useSaleAlerts';
import useTick from './useTick';
import { fmtInt, fmtMoney, timeAgo, isPaymentEvent } from './livePresentation.js';
import './liveview.css';

function ConnectionDot({ status }) {
  const color =
    status === 'live'
      ? 'bg-success'
      : status === 'connecting' || status === 'paused'
        ? 'bg-warning'
        : 'bg-danger';
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
  paused: 'Paused (tab in background)',
  error: 'Disconnected — retrying',
};

function Tile({ icon, label, value, accent = false }) {
  // Assigned to a capitalised CONST rather than renamed in the parameter list.
  // This project's eslint has no eslint-plugin-react, so JSX usage does not
  // count as a variable use; `varsIgnorePattern: '^[A-Z_]'` rescues a const but
  // not a destructured argument. The old `{ icon: Icon }` form was a standing
  // lint error on this file.
  const TileIcon = icon;
  return (
    <Card className="p-4">
      <div className="flex items-center gap-2 text-[11px] font-medium uppercase tracking-wide text-text-faint">
        <TileIcon className="h-3.5 w-3.5" />
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
              <span className="font-semibold text-text-primary">{fmtInt(r.live)}</span> live
              <span className="mx-1 text-text-faint">·</span>
              {fmtInt(r.unique_today)} today
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

  const alerts = useSaleAlerts();
  const toasts = usePaymentToasts();

  // Stable handles for the effect below — `alerts`/`toasts` are rebuilt each
  // render, and depending on them directly would re-run the arming effect (and
  // re-scan the feed) on every single snapshot.
  const alertsRef = useRef(alerts);
  const toastsRef = useRef(toasts);
  useEffect(() => { alertsRef.current = alerts; toastsRef.current = toasts; });

  // ARMING. The first snapshot's backfill seeds the dedupe sets and nothing
  // else — without this a reconnect (or simply opening the page at 6pm) fires
  // the whole day's sales as toasts and chimes at once.
  const armedRef = useRef(false);
  useEffect(() => {
    if (armedRef.current || !snapshot) return;
    armedRef.current = true;
    toastsRef.current.seedAndArm(snapshot.events || []);
    alertsRef.current.arm();
  }, [snapshot]);

  // NEW payment events → toast + chime. The rail feed is the source; both
  // gates dedupe internally, so re-scanning a merged feed is safe by
  // construction. `seen` bounds the scan to rows we have not offered yet.
  const offeredRef = useRef(new Set());
  useEffect(() => {
    if (!armedRef.current || !Array.isArray(feed)) return;
    const offered = offeredRef.current;
    // Oldest-first, so a burst toasts in the order it happened.
    for (let i = feed.length - 1; i >= 0; i--) {
      const ev = feed[i];
      if (!ev || !ev.id || offered.has(ev.id) || !isPaymentEvent(ev)) continue;
      offered.add(ev.id);
      toastsRef.current.push(ev);
      alertsRef.current.fire(ev);
    }
    // The feed is capped at 100 by useLiveFeed; keep this set from outliving
    // it. The queue's own SEEN_MAX is the real dedupe — this is just a cheap
    // pre-filter, so trimming it can never cause a double toast.
    if (offered.size > 400) {
      const live = new Set(feed.map((e) => e?.id));
      for (const id of offered) if (!live.has(id)) offered.delete(id);
    }
  }, [feed]);

  const onDismiss = useCallback((key) => toastsRef.current.dismiss(key), []);

  const s = snapshot || {};
  const degraded = Boolean(s.degraded);

  return (
    <div className="max-w-[1600px] space-y-5 p-6">
      {/* Top bar — title + sound + connection state + resync */}
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
          <SaleAlertControls sound={alerts.sound} />
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
            {fmtInt(s.live_total)}
          </div>
          <div className="mt-2 text-[11px] text-text-faint">last 5 minutes, all funnels</div>
        </Card>
        <Tile icon={Users} label="Unique today" value={fmtInt(s.unique_today_total)} />
        <Tile icon={CreditCard} label="Checkout starts today" value={fmtInt(s.checkout_starts_today)} />
        <Tile icon={BadgeDollarSign} label="Purchases today" value={fmtInt(s.purchases_today)} />
        <Tile
          icon={TrendingUp}
          label="Revenue today"
          value={s.revenue_today == null ? '—' : fmtMoney(s.revenue_today) || '—'}
          accent
        />
      </div>

      {/* Two-zone body: globe + breakdown (left) · event rail (right) */}
      <div className="grid grid-cols-1 gap-4 xl:grid-cols-5">
        <div className="space-y-4 xl:col-span-2">
          <LiveGlobe geo={s.geo} live={s.live_total} />
          <Card>
            <h2 className="mb-3 text-sm font-semibold text-text-primary">Live by funnel</h2>
            <FunnelBreakdown rows={s.by_funnel} />
          </Card>
        </div>
        <Card className="xl:col-span-3">
          <div className="mb-3 flex items-baseline justify-between">
            <h2 className="text-sm font-semibold text-text-primary">Activity</h2>
            <span className="text-[11px] text-text-faint">
              pageviews · checkout starts · purchases
            </span>
          </div>
          <EventRail feed={feed} connected={status === 'live'} />
        </Card>
      </div>

      <PaymentToastStack toasts={toasts.toasts} onDismiss={onDismiss} />
    </div>
  );
}
