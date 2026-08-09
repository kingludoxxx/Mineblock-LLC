// HEALTH ALERTS PANEL — the operator surface for /api/v1/health-alerts.
//
// ⚠️ THIS COMPONENT IS NOT MOUNTED, AND THAT IS DELIBERATE. ⚠️
//
// The existing Health surface is `HealthSection` in
// components/funnels/settings/sections.jsx:1141, rendered by
// FunnelSettingsModal.jsx:85. sections.jsx is a CONTESTED file that this lane's
// change fence does not admit, and every other mount point (App.jsx, Sidebar.jsx)
// is fenced off too. Rather than reach across the fence — or leave the feature
// as a server API with no surface at all — the panel is built here, complete and
// self-contained, waiting for a one-line mount by whoever owns sections.jsx:
//
//   // components/funnels/settings/sections.jsx — inside HealthSection's JSX,
//   // below the gateway card:
//   import HealthAlertsPanel from '../../health/HealthAlertsPanel';
//   <HealthAlertsPanel />
//
// It takes no props on purpose: system alerts are platform-wide (postback
// backlog, spend-feed staleness, checkout review backlog), NOT per-funnel, so
// it must not be handed a funnelId it would have to pretend to filter by. It
// drops into a funnel settings pane, a standalone health page, or a dashboard
// card unchanged.
import { useCallback, useEffect, useState } from 'react';
import { AlertTriangle, Check, Info, OctagonAlert, RefreshCw, ShieldCheck } from 'lucide-react';
import api from '../../services/api';

const PAGE_SIZE = 25;

// The vocabulary is the SERVER's (healthAlerts.js SEVERITIES). An unknown
// severity must still render — a monitoring surface that blanks a row it does
// not recognise hides exactly the novel fault it exists to show.
const SEVERITY_META = {
  critical: { label: 'Critical', icon: OctagonAlert, cls: 'bg-red-500/10 text-red-400 border-red-500/20' },
  warn: { label: 'Warning', icon: AlertTriangle, cls: 'bg-amber-500/10 text-amber-300 border-amber-500/20' },
  info: { label: 'Info', icon: Info, cls: 'bg-bg-elevated text-text-muted border-border-default' },
};
const metaFor = (s) => SEVERITY_META[s] || { label: String(s || 'unknown'), icon: Info, cls: 'bg-bg-elevated text-text-muted border-border-default' };

function SeverityBadge({ severity }) {
  const m = metaFor(severity);
  const Icon = m.icon;
  return (
    <span className={`px-2 py-0.5 text-[11px] rounded-full border inline-flex items-center gap-1 shrink-0 ${m.cls}`}>
      <Icon className="w-3 h-3" /> {m.label}
    </span>
  );
}

const fmtWhen = (iso) => {
  if (!iso) return '—';
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return String(iso);
  return d.toLocaleString('en-GB', {
    day: '2-digit', month: 'short', hour: '2-digit', minute: '2-digit',
  });
};

function AlertRow({ alert, onAck, acking }) {
  const acked = Boolean(alert.acked_at);
  return (
    <div className={`rounded-lg border p-3 ${acked ? 'border-border-subtle bg-bg-card/50' : 'border-border-default bg-bg-card'}`}>
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0 flex-1">
          <div className="flex items-center gap-2 flex-wrap">
            <SeverityBadge severity={alert.severity} />
            <span className="text-[11px] font-mono text-text-faint truncate">{alert.kind}</span>
          </div>
          <p className={`mt-1.5 text-sm ${acked ? 'text-text-muted' : 'text-text-primary'}`}>{alert.message}</p>
          <div className="mt-1 text-[11px] text-text-faint">
            {fmtWhen(alert.created_at)}
            {acked && (
              // WHO acked and WHEN, not just "acked". An acknowledgement whose
              // owner is anonymous is not an acknowledgement, it is a dismissal.
              <> · acknowledged {fmtWhen(alert.acked_at)}{alert.acked_by ? ` by ${alert.acked_by}` : ''}</>
            )}
          </div>
        </div>
        {acked ? (
          <span className="text-[11px] text-text-faint inline-flex items-center gap-1 shrink-0 pt-0.5">
            <Check className="w-3.5 h-3.5" /> Acked
          </span>
        ) : (
          <button
            onClick={() => onAck(alert)}
            disabled={acking}
            className="px-2 py-1 rounded-md text-xs text-text-muted border border-border-default hover:text-text-primary
              hover:border-border-strong transition-colors cursor-pointer shrink-0 disabled:opacity-40 disabled:pointer-events-none"
          >
            {acking ? 'Acking…' : 'Ack'}
          </button>
        )}
      </div>
    </div>
  );
}

export default function HealthAlertsPanel() {
  const [data, setData] = useState(null); // { items, total, unacked, has_more, ... }
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(true);
  const [showAcked, setShowAcked] = useState(false);
  const [offset, setOffset] = useState(0);
  const [ackingId, setAckingId] = useState(null);

  const load = useCallback(async (nextOffset = offset, includeAcked = showAcked) => {
    setLoading(true);
    setError('');
    try {
      const params = { limit: PAGE_SIZE, offset: nextOffset };
      // Absent `acked` means "everything"; false means "only what still needs
      // someone". The default view is the second one.
      if (!includeAcked) params.acked = 'false';
      const res = await api.get('/health-alerts', { params });
      setData(res.data?.data || null);
    } catch (e) {
      // A monitoring panel that fails silently is worse than no panel: it reads
      // as "all clear". Say the read failed, and never render the empty state.
      setError(e.response?.data?.error?.code || e.response?.data?.error || 'Could not load alerts');
      setData(null);
    } finally {
      setLoading(false);
    }
  }, [offset, showAcked]);

  useEffect(() => { load(offset, showAcked); }, [load, offset, showAcked]);

  const ack = async (alert) => {
    setAckingId(alert.id);
    setError('');
    try {
      await api.post(`/health-alerts/${alert.id}/ack`);
      await load(offset, showAcked);
    } catch (e) {
      setError(e.response?.data?.error?.code || 'Could not acknowledge that alert');
    } finally {
      setAckingId(null);
    }
  };

  const items = data?.items || [];
  const unacked = data?.unacked ?? 0;

  return (
    <div className="space-y-3">
      <div className="flex items-center justify-between gap-3 flex-wrap">
        <div className="flex items-center gap-2">
          <h3 className="text-base font-semibold text-text-primary">System alerts</h3>
          {unacked > 0 && (
            <span className="px-2 py-0.5 text-[11px] rounded-full border bg-amber-500/10 text-amber-300 border-amber-500/20">
              {unacked} unacknowledged
            </span>
          )}
        </div>
        <div className="flex items-center gap-3">
          <label className="text-xs text-text-muted inline-flex items-center gap-1.5 cursor-pointer">
            <input
              type="checkbox"
              checked={showAcked}
              onChange={(e) => { setOffset(0); setShowAcked(e.target.checked); }}
              className="cursor-pointer"
            />
            Show acknowledged
          </label>
          <button
            onClick={() => load(offset, showAcked)}
            className="flex items-center gap-1.5 text-xs text-text-muted hover:text-text-primary cursor-pointer"
          >
            <RefreshCw className="w-3.5 h-3.5" /> Refresh
          </button>
        </div>
      </div>

      <p className="text-sm text-text-muted">
        Faults this deployment detected on its own — delivery backlogs, stale spend feeds,
        checkout sessions piling up for review. Acknowledging one records that you saw it;
        it does not fix or hide the condition.
      </p>

      {error && (
        <div className="rounded-lg border border-red-500/20 bg-red-500/5 px-3 py-2 text-sm text-red-400">
          {error}
        </div>
      )}

      {loading && data === null && !error ? (
        <p className="text-sm text-text-muted">Loading alerts…</p>
      ) : error ? null : items.length === 0 ? (
        <div className="rounded-lg border border-border-default bg-bg-card px-4 py-10 text-center">
          <ShieldCheck className="w-6 h-6 mx-auto mb-2 text-green-400/70" />
          <div className="text-sm text-text-primary">All clear</div>
          <div className="text-xs text-text-faint mt-1">
            {showAcked ? 'No alerts have been recorded.' : 'Nothing needs your attention right now.'}
          </div>
        </div>
      ) : (
        <div className="space-y-2">
          {items.map((a) => (
            <AlertRow key={a.id} alert={a} onAck={ack} acking={ackingId === a.id} />
          ))}
        </div>
      )}

      {(offset > 0 || data?.has_more) && (
        <div className="flex items-center justify-between text-xs text-text-muted pt-1">
          <span>
            {offset + 1}–{offset + items.length} of {data?.total ?? '—'}
          </span>
          <span className="flex items-center gap-2">
            <button
              onClick={() => setOffset(Math.max(0, offset - PAGE_SIZE))}
              disabled={offset === 0 || loading}
              className="px-2 py-1 rounded-md border border-border-default hover:text-text-primary hover:border-border-strong
                transition-colors cursor-pointer disabled:opacity-40 disabled:pointer-events-none"
            >
              Previous
            </button>
            <button
              onClick={() => setOffset(offset + PAGE_SIZE)}
              disabled={!data?.has_more || loading}
              className="px-2 py-1 rounded-md border border-border-default hover:text-text-primary hover:border-border-strong
                transition-colors cursor-pointer disabled:opacity-40 disabled:pointer-events-none"
            >
              Next
            </button>
          </span>
        </div>
      )}
    </div>
  );
}
