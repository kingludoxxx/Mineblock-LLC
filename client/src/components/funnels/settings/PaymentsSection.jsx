// Payments — the funnel's payment-gateway control center, shaped to the
// operator's reference tool (gateway list → gateway detail), adapted to Whop:
// this platform is Whop-only, so the list shows ONE gateway card and the
// detail panel is the Whop credential surface.
//
// Persistence is the EXISTING write-only gatewayConfigs surface
// (routes/checkoutAdmin.js — GET returns only *_set booleans for secrets;
// PUT: null/omitted keeps, '' clears, value replaces; the root `enabled`
// toggle rides the same PUT). No new credential endpoints. The enable toggle
// is ENFORCED server-side today: gatewayConfigs.resolveCredential returns no
// credential (stored OR env fallback) for a funnel whose config row is
// disabled — so "off" genuinely turns checkout payment off for this funnel.
import { useCallback, useEffect, useMemo, useState } from 'react';
import { ArrowLeft, ExternalLink, RefreshCw, ChevronRight } from 'lucide-react';
import api from '../../../services/api';
import Button from '../../ui/Button';
import { GATEWAY_META } from './gatewayMeta';
import { StatusPill, Toggle, GatewayLogo, CredentialField } from './ui';

const GATEWAY = 'whop';

export default function PaymentsSection({ funnelId }) {
  const [configs, setConfigs] = useState(null);
  const [status, setStatus] = useState(null); // null = still checking
  const [loadErr, setLoadErr] = useState('');
  const [detail, setDetail] = useState(false);

  const loadConfigs = useCallback(async () => {
    setLoadErr('');
    try {
      const res = await api.get(`/checkout/gateways/${encodeURIComponent(funnelId)}`);
      setConfigs(res.data?.data || {});
    } catch (err) {
      setLoadErr(err.response?.data?.error?.code || 'Failed to load gateways');
    }
  }, [funnelId]);

  // force=true bypasses the server's 45s status cache (the Re-check button);
  // a plain modal open rides the cache so it never hammers the processor.
  const loadStatus = useCallback(async (force = false) => {
    setStatus(null);
    try {
      const res = await api.get(
        `/checkout/gateways/${encodeURIComponent(funnelId)}/status${force ? '?force=1' : ''}`
      );
      setStatus(res.data?.data || {});
    } catch {
      setStatus({}); // resolve to "unknown" pills rather than spinning forever
    }
  }, [funnelId]);

  useEffect(() => { loadConfigs(); loadStatus(); }, [loadConfigs, loadStatus]);

  if (loadErr) {
    return (
      <div className="space-y-3">
        <p className="text-sm text-danger">{loadErr}</p>
        <Button variant="secondary" size="sm" onClick={loadConfigs}>Retry</Button>
      </div>
    );
  }
  if (!configs) return <div className="text-sm text-text-muted">Loading payments…</div>;

  if (detail) {
    return (
      <GatewayDetail
        funnelId={funnelId}
        config={configs[GATEWAY]}
        status={status?.[GATEWAY]}
        onBack={() => setDetail(false)}
        onSaved={() => { loadConfigs(); loadStatus(); }}
      />
    );
  }

  const meta = GATEWAY_META[GATEWAY];
  const st = status ? (status[GATEWAY]?.aggregate || 'unknown') : 'checking';

  return (
    <div className="space-y-5">
      <div className="flex items-start justify-between gap-4">
        <div>
          <h3 className="text-base font-semibold text-text-primary">Payment gateways</h3>
          <p className="mt-1 text-sm text-text-muted max-w-xl">
            The processor this funnel charges through. Live API health also shows
            under Advanced → Health.
          </p>
        </div>
        <button
          onClick={() => loadStatus(true)}
          className="flex items-center gap-1.5 text-xs text-text-muted hover:text-text-primary cursor-pointer shrink-0"
          title="Re-check connection (bypasses the status cache)"
        >
          <RefreshCw className="w-3.5 h-3.5" /> Re-check
        </button>
      </div>

      <button
        onClick={() => setDetail(true)}
        className="w-full flex items-center justify-between gap-3 rounded-xl border border-border-default bg-bg-card p-4 text-left cursor-pointer hover:border-border-default hover:bg-bg-hover/40 transition-colors"
      >
        <div className="flex items-center gap-3 min-w-0">
          <GatewayLogo name={meta.name} accent={meta.accent} />
          <div className="min-w-0">
            <span className="text-sm font-semibold text-text-primary">{meta.name}</span>
            <div className="mt-1"><StatusPill status={st} /></div>
          </div>
        </div>
        <ChevronRight className="w-4 h-4 text-text-faint shrink-0" />
      </button>
    </div>
  );
}

function GatewayDetail({ funnelId, config, status, onBack, onSaved }) {
  const meta = GATEWAY_META[GATEWAY];
  const [draft, setDraft] = useState({});      // typed values (live mode)
  const [cleared, setCleared] = useState({});  // pending '' clears
  const [enabled, setEnabled] = useState(Boolean(config?.enabled));
  const [saving, setSaving] = useState(false);
  const [saveErr, setSaveErr] = useState('');
  const [savedFlash, setSavedFlash] = useState(false);

  useEffect(() => {
    setEnabled(Boolean(config?.enabled));
    setDraft({});
    setCleared({});
  }, [config]);

  const dirty = useMemo(
    () => Boolean(Object.keys(draft).length || Object.keys(cleared).length
      || enabled !== Boolean(config?.enabled)),
    [draft, cleared, enabled, config]
  );

  const setField = (key, val) => {
    setDraft((d) => {
      const next = { ...d };
      if (val === '') delete next[key];
      else next[key] = val;
      return next;
    });
    setCleared((c) => { const next = { ...c }; delete next[key]; return next; }); // typing cancels a pending clear
  };

  const clearField = (key) => {
    setCleared((c) => ({ ...c, [key]: true }));
    setDraft((d) => { const next = { ...d }; delete next[key]; return next; });
  };

  const save = async () => {
    setSaving(true);
    setSaveErr('');
    try {
      // One PUT: typed fields replace, cleared fields send '', untouched
      // fields are omitted so stored values are kept (write-only semantics).
      const body = { mode: 'live', enabled, ...draft };
      for (const k of Object.keys(cleared)) body[k] = '';
      await api.put(`/checkout/gateways/${encodeURIComponent(funnelId)}/${GATEWAY}`, body);
      setSavedFlash(true);
      setTimeout(() => setSavedFlash(false), 2000);
      onSaved?.();
    } catch (err) {
      setSaveErr(err.response?.data?.error?.code || 'Failed to save credentials');
    } finally {
      setSaving(false);
    }
  };

  const liveStatus = status ? (status.live?.status || 'unknown') : 'checking';
  const liveConfigured = Boolean(config?.live?.api_key_set);
  const paysLive = enabled && liveConfigured;

  return (
    <div className="space-y-5">
      <button
        onClick={onBack}
        className="flex items-center gap-1.5 text-sm text-text-muted hover:text-text-primary cursor-pointer"
      >
        <ArrowLeft className="w-4 h-4" /> Payment gateways
      </button>

      <div className="flex items-center justify-between gap-3">
        <div className="flex items-center gap-3">
          <GatewayLogo name={meta.name} accent={meta.accent} />
          <h3 className="text-base font-semibold text-text-primary">{meta.name}</h3>
          {paysLive ? (
            <span className="inline-flex items-center gap-1.5 px-2.5 py-1 rounded-lg bg-emerald-500/10 text-emerald-400 text-xs font-medium border border-emerald-500/20">
              <span className="w-1.5 h-1.5 rounded-full bg-emerald-400" /> Buyers pay on: LIVE
            </span>
          ) : (
            <span className="inline-flex items-center gap-1.5 px-2.5 py-1 rounded-lg bg-amber-500/10 text-amber-400 text-xs font-medium border border-amber-500/20">
              <span className="w-1.5 h-1.5 rounded-full bg-amber-400" /> {enabled ? 'Not configured' : 'Disabled'}
            </span>
          )}
        </div>
        <a
          href={meta.dashboard.live}
          target="_blank"
          rel="noopener noreferrer"
          className="inline-flex items-center gap-1.5 px-3 py-1.5 text-xs rounded-lg border border-border-default bg-bg-elevated text-text-primary hover:bg-bg-hover transition-colors shrink-0"
        >
          Whop dashboard <ExternalLink className="w-3 h-3" />
        </a>
      </div>

      {/* Enable toggle */}
      <div className="rounded-xl border border-border-default bg-bg-card p-4 space-y-2">
        <div className="flex items-center justify-between gap-4">
          <div>
            <div className="text-sm text-text-primary">Enable Whop on this funnel</div>
            <div className="text-xs text-text-faint max-w-md">
              When off, checkout pages won’t offer payment even with valid credentials.
            </div>
          </div>
          <Toggle checked={enabled} onChange={setEnabled} />
        </div>
        <p className="text-xs text-text-faint border-t border-border-subtle pt-2">
          Serving reads this setting — while off, no Whop credential resolves for
          this funnel (stored keys and the platform fallback are both gated).
        </p>
      </div>

      {/* Live credentials */}
      <div className="rounded-xl border border-border-default bg-bg-card p-4 space-y-3">
        <div className="flex items-center justify-between">
          <div>
            <div className="text-sm font-semibold text-text-primary">Credentials</div>
            <div className="text-xs text-text-faint">Used server-side to mint payments. Encrypted at rest, write-only.</div>
          </div>
          <StatusPill status={liveStatus} />
        </div>
        <div className="space-y-3">
          {meta.fields.map((f) => {
            const secretSet = f.kind === 'secret' ? Boolean(config?.live?.[`${f.key}_set`]) && !cleared[f.key] : false;
            const plainVal = f.kind === 'plain' ? (config?.live?.[f.key] ?? '') : '';
            return (
              <CredentialField
                key={f.key}
                field={f}
                currentSet={secretSet}
                currentValue={plainVal}
                value={draft[f.key]}
                onChange={(v) => setField(f.key, v)}
                onClear={f.kind === 'secret' && secretSet ? () => clearField(f.key) : undefined}
              />
            );
          })}
        </div>
      </div>

      {/* Sandbox — visible but not operator-exposed yet */}
      <div className="rounded-xl border border-dashed border-border-default bg-bg-card/60 p-4 opacity-60">
        <div className="flex items-center justify-between">
          <div>
            <div className="text-sm font-semibold text-text-primary">Sandbox</div>
            <div className="text-xs text-text-faint">
              Separate sandbox credentials for previews & test charges — coming soon.
              Buyers always use the live credentials above.
            </div>
          </div>
          <span className="text-[10px] uppercase tracking-wide text-text-faint border border-border-default rounded px-1.5 py-0.5">Soon</span>
        </div>
      </div>

      {saveErr && <p className="text-sm text-danger">{saveErr}</p>}
      <div className="flex items-center gap-3">
        <Button onClick={save} loading={saving} disabled={!dirty}>Save</Button>
        {savedFlash && <span className="text-sm text-success">Saved</span>}
        {dirty && !savedFlash && <span className="text-xs text-text-faint">Unsaved changes</span>}
      </div>
    </div>
  );
}
