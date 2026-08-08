// Non-payment sections of the Funnel Settings modal. Wired where a backend
// already exists (General, Redirects, Health); clean scaffolds otherwise — no
// fake data. Tracking panels carry a documented API shape to reconcile with
// the tracking branch at merge.
import { useCallback, useEffect, useState } from 'react';
import { ExternalLink, RefreshCw } from 'lucide-react';
import api from '../../../services/api';
import Button from '../../ui/Button';
import Input from '../../ui/Input';
import { GATEWAY_META, GATEWAY_ORDER } from './gatewayMeta';
import { StatusPill, ScaffoldPanel } from './ui';

// ── GENERAL — funnel name / slug / status via the existing funnels API ──────
export function GeneralSection({ funnel, onFunnelUpdated }) {
  const [name, setName] = useState(funnel?.name || '');
  const [slug, setSlug] = useState(funnel?.slug || '');
  const [status, setStatus] = useState(funnel?.status || 'draft');
  const [saving, setSaving] = useState(false);
  const [err, setErr] = useState('');
  const [saved, setSaved] = useState(false);

  useEffect(() => {
    setName(funnel?.name || '');
    setSlug(funnel?.slug || '');
    setStatus(funnel?.status || 'draft');
  }, [funnel]);

  const dirty = name !== (funnel?.name || '') || slug !== (funnel?.slug || '') || status !== (funnel?.status || 'draft');

  const save = async () => {
    setSaving(true); setErr('');
    try {
      const res = await api.patch(`/funnels/${funnel.id}`, { name: name.trim(), slug: slug.trim(), status });
      onFunnelUpdated?.(res.data?.data || null);
      setSaved(true); setTimeout(() => setSaved(false), 2000);
    } catch (e) {
      setErr(e.response?.data?.error || 'Failed to save');
    } finally { setSaving(false); }
  };

  return (
    <div className="space-y-4 max-w-lg">
      <h3 className="text-base font-semibold text-text-primary">General</h3>
      <Input label="Funnel name" value={name} onChange={(e) => setName(e.target.value)} />
      <div className="space-y-1.5">
        <label className="block text-sm font-medium text-text-muted">Slug</label>
        <div className="flex items-center gap-2">
          <span className="text-sm text-text-faint font-mono">/f/</span>
          <input
            value={slug}
            onChange={(e) => setSlug(e.target.value)}
            className="flex-1 px-3 py-2 text-sm bg-bg-elevated border border-border-default rounded-lg text-text-primary font-mono focus:outline-none focus:ring-2 focus:ring-accent/40 focus:border-accent"
          />
        </div>
        <p className="text-xs text-text-faint">Lowercase letters, numbers and dashes.</p>
      </div>
      <div className="space-y-1.5">
        <label className="block text-sm font-medium text-text-muted">Status</label>
        <select
          value={status}
          onChange={(e) => setStatus(e.target.value)}
          className="w-full px-3 py-2 text-sm bg-bg-elevated border border-border-default rounded-lg text-text-primary focus:outline-none focus:ring-2 focus:ring-accent/40 focus:border-accent cursor-pointer"
        >
          <option value="draft">Draft</option>
          <option value="published">Published</option>
        </select>
      </div>
      {err && <p className="text-sm text-danger">{err}</p>}
      <div className="flex items-center gap-3">
        <Button onClick={save} loading={saving} disabled={!dirty}>Save changes</Button>
        {saved && <span className="text-sm text-success">Saved</span>}
      </div>
    </div>
  );
}

// ── REDIRECTS — read-only view over the existing funnels redirects CRUD ──────
export function RedirectsSection({ funnel }) {
  const [rows, setRows] = useState(null);
  const [err, setErr] = useState('');

  const load = useCallback(async () => {
    setErr('');
    try {
      const res = await api.get(`/funnels/${funnel.id}/redirects`);
      const d = res.data?.data;
      setRows(Array.isArray(d) ? d : (d?.redirects || []));
    } catch (e) {
      setErr(e.response?.data?.error || 'Failed to load redirects');
      setRows([]);
    }
  }, [funnel.id]);

  useEffect(() => { load(); }, [load]);

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between">
        <h3 className="text-base font-semibold text-text-primary">Redirects</h3>
        <button onClick={load} className="flex items-center gap-1.5 text-xs text-text-muted hover:text-text-primary cursor-pointer">
          <RefreshCw className="w-3.5 h-3.5" /> Refresh
        </button>
      </div>
      <p className="text-sm text-text-muted">
        Path redirects for this funnel. Managed on the funnel flow — this is a read-only view.
      </p>
      {err && <p className="text-sm text-danger">{err}</p>}
      {rows === null ? (
        <p className="text-sm text-text-muted">Loading…</p>
      ) : rows.length === 0 ? (
        <div className="rounded-lg border border-dashed border-border-default bg-bg-elevated/40 px-4 py-6 text-center text-sm text-text-muted">
          No redirects configured.
        </div>
      ) : (
        <div className="rounded-lg border border-border-default overflow-hidden">
          <table className="w-full text-sm">
            <thead className="bg-bg-elevated text-text-faint text-xs uppercase tracking-wide">
              <tr><th className="text-left px-3 py-2">From</th><th className="text-left px-3 py-2">To</th><th className="text-left px-3 py-2">Code</th></tr>
            </thead>
            <tbody>
              {rows.map((r, i) => (
                <tr key={r.id || i} className="border-t border-border-subtle">
                  <td className="px-3 py-2 font-mono text-text-primary">{r.from_path || r.from || '—'}</td>
                  <td className="px-3 py-2 font-mono text-text-muted">{r.to_path || r.to || r.target || '—'}</td>
                  <td className="px-3 py-2 text-text-muted">{r.status_code || r.code || 301}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}

// ── HEALTH (Advanced) — live gateway connection health ──────────────────────
export function HealthSection({ funnelId }) {
  const [status, setStatus] = useState(null);
  const [err, setErr] = useState('');

  const load = useCallback(async () => {
    setStatus(null); setErr('');
    try {
      // Served by the lane-owned checkoutAdmin router (always mounted). The
      // standalone /api/v1/funnel-health route returns identical data once its
      // routes/index.js mount lands.
      const res = await api.get(`/checkout/gateways/${encodeURIComponent(funnelId)}/status`);
      setStatus(res.data?.data || {});
    } catch (e) {
      setErr(e.response?.data?.error?.code || 'Failed to load health');
      setStatus({});
    }
  }, [funnelId]);

  useEffect(() => { load(); }, [load]);

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between">
        <h3 className="text-base font-semibold text-text-primary">Health</h3>
        <button onClick={load} className="flex items-center gap-1.5 text-xs text-text-muted hover:text-text-primary cursor-pointer">
          <RefreshCw className="w-3.5 h-3.5" /> Re-check
        </button>
      </div>
      <p className="text-sm text-text-muted">Live API health for this funnel’s payment gateways.</p>
      {err && <p className="text-sm text-danger">{err}</p>}
      <div className="space-y-2">
        {GATEWAY_ORDER.map((gw) => {
          const meta = GATEWAY_META[gw];
          const s = status?.[gw];
          return (
            <div key={gw} className="rounded-lg border border-border-default bg-bg-card p-3">
              <div className="flex items-center justify-between">
                <span className="text-sm font-medium text-text-primary">{meta.name}</span>
                <StatusPill status={status ? (s?.aggregate || 'unknown') : 'checking'} />
              </div>
              <div className="mt-2 flex items-center gap-4 text-xs text-text-muted">
                <span className="flex items-center gap-1.5">Live <StatusPill status={status ? (s?.live?.status || 'unknown') : 'checking'} /></span>
                <span className="flex items-center gap-1.5">Sandbox <StatusPill status={status ? (s?.sandbox?.status || 'unknown') : 'checking'} /></span>
              </div>
            </div>
          );
        })}
      </div>
    </div>
  );
}

// ── TRACKING scaffolds — documented API shape for the tracking branch ───────
// Expected (to reconcile at merge):
//   GET  /api/v1/funnels/:id/tracking            -> { pixels:[{id,provider,pixel_id,enabled}], ... }
//   PUT  /api/v1/funnels/:id/tracking            -> upsert pixel/provider config
//   GET  /api/v1/funnels/:id/tracking/health     -> per-pixel fire status
//   GET/PUT /api/v1/funnels/:id/tracking/custom  -> { head_html, body_html }
export function TrackingSection() {
  return (
    <ScaffoldPanel
      title="Tracking"
      description="Ad-platform pixels & conversion APIs for this funnel (Meta, TikTok, Google, …)."
      note="Wired to the tracking service at merge — GET/PUT /api/v1/funnels/:id/tracking."
    />
  );
}
export function TrackingHealthSection() {
  return (
    <ScaffoldPanel
      title="Tracking Health"
      description="Whether each configured pixel is firing correctly."
      note="Wired at merge — GET /api/v1/funnels/:id/tracking/health."
    />
  );
}
export function CustomTrackingSection() {
  return (
    <ScaffoldPanel
      title="Custom Tracking Code"
      description="Raw <head> / <body> snippets injected into every funnel page."
      note="Wired at merge — GET/PUT /api/v1/funnels/:id/tracking/custom."
    />
  );
}

// ── Simple scaffolds (no backend yet) ───────────────────────────────────────
export const FontsSection = () => (
  <ScaffoldPanel title="Fonts" description="Typography for this funnel." note="Coming soon — will persist to funnel.seo.fonts." />
);
export const DomainsSection = () => (
  <ScaffoldPanel title="Domains" description="Custom domains for this funnel." note="Custom domains are a later wave." />
);
export const ProductsSection = () => (
  <ScaffoldPanel title="Products" description="Catalog products offered in this funnel." note="Coming soon." />
);
export const ShippingSection = () => (
  <ScaffoldPanel title="Shipping" description="Shipping rates & rules." note="Coming soon." />
);
export const SubscriptionsSection = () => (
  <ScaffoldPanel title="Subscriptions" description="Recurring plans for this funnel." note="Coming soon." />
);
export const ScriptsSection = () => (
  <ScaffoldPanel title="Scripts" description="Third-party scripts for this funnel." note="Coming soon — will persist to funnel.seo.scripts." />
);
