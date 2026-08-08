// Payments — the funnel's payment-processor control center. Two views:
//   1. a 2×2 grid of gateway cards with live status pills
//   2. a per-gateway detail implementing the DUAL LIVE + SANDBOX APP MODEL:
//      keep a live app and a sandbox app connected at once; buyers use LIVE,
//      previews/tests use SANDBOX, live takes over the moment it is saved.
import { useCallback, useEffect, useMemo, useState } from 'react';
import { ArrowLeft, ExternalLink, RefreshCw, Info } from 'lucide-react';
import api from '../../../services/api';
import Button from '../../ui/Button';
import { GATEWAY_META, GATEWAY_ORDER } from './gatewayMeta';
import { StatusPill, Toggle, GatewayLogo, CredentialField } from './ui';

const emptyDraft = () => ({ live: {}, sandbox: {}, clearedLive: {}, clearedSandbox: {} });

export default function PaymentsSection({ funnelId }) {
  const [configs, setConfigs] = useState(null);
  const [status, setStatus] = useState(null); // null = still checking
  const [loadErr, setLoadErr] = useState('');
  const [detail, setDetail] = useState(null); // gateway key or null

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
  // a plain modal open rides the cache so it never hammers the processors.
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
        gateway={detail}
        funnelId={funnelId}
        config={configs[detail]}
        status={status?.[detail]}
        onBack={() => setDetail(null)}
        onSaved={() => { loadConfigs(); loadStatus(); }}
      />
    );
  }

  return (
    <div className="space-y-5">
      <div className="flex items-start justify-between gap-4">
        <div>
          <h3 className="text-base font-semibold text-text-primary">Payments</h3>
          <p className="mt-1 text-sm text-text-muted max-w-xl">
            The processors this funnel can charge through — connect each with its own
            credentials. Live API health lives under Advanced → Health.
          </p>
        </div>
        <button
          onClick={() => loadStatus(true)}
          className="flex items-center gap-1.5 text-xs text-text-muted hover:text-text-primary cursor-pointer shrink-0"
          title="Re-check connections (bypasses the status cache)"
        >
          <RefreshCw className="w-3.5 h-3.5" /> Re-check
        </button>
      </div>

      <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
        {GATEWAY_ORDER.map((gw) => {
          const meta = GATEWAY_META[gw];
          const st = status ? (status[gw]?.aggregate || 'unknown') : 'checking';
          return (
            <div
              key={gw}
              className="flex items-center justify-between gap-3 rounded-xl border border-border-default bg-bg-card p-4"
            >
              <div className="flex items-center gap-3 min-w-0">
                <GatewayLogo name={meta.name} accent={meta.accent} />
                <div className="min-w-0">
                  <div className="flex items-center gap-2">
                    <span className="text-sm font-semibold text-text-primary">{meta.name}</span>
                    {!meta.hasAdapter && (
                      <span className="text-[10px] uppercase tracking-wide text-text-faint border border-border-default rounded px-1 py-0.5">
                        storage only
                      </span>
                    )}
                  </div>
                  <div className="mt-1"><StatusPill status={st} /></div>
                </div>
              </div>
              <Button variant="secondary" size="sm" onClick={() => setDetail(gw)}>Settings</Button>
            </div>
          );
        })}
      </div>
    </div>
  );
}

function GatewayDetail({ gateway, funnelId, config, status, onBack, onSaved }) {
  const meta = GATEWAY_META[gateway];
  const [draft, setDraft] = useState(emptyDraft);
  const [enabled, setEnabled] = useState(Boolean(config?.enabled));
  const [allowSandbox, setAllowSandbox] = useState(Boolean(config?.allow_sandbox_on_live));
  const [saving, setSaving] = useState(false);
  const [saveErr, setSaveErr] = useState('');
  const [savedFlash, setSavedFlash] = useState(false);

  useEffect(() => {
    setEnabled(Boolean(config?.enabled));
    setAllowSandbox(Boolean(config?.allow_sandbox_on_live));
    setDraft(emptyDraft());
  }, [config]);

  const dirty = useMemo(() => {
    const d = draft;
    const anyField = Object.keys(d.live).length || Object.keys(d.sandbox).length
      || Object.keys(d.clearedLive).length || Object.keys(d.clearedSandbox).length;
    const toggleChanged = enabled !== Boolean(config?.enabled)
      || allowSandbox !== Boolean(config?.allow_sandbox_on_live);
    return Boolean(anyField || toggleChanged);
  }, [draft, enabled, allowSandbox, config]);

  const setField = (mode, key, val) => {
    setDraft((d) => {
      const next = { ...d, [mode]: { ...d[mode] }, [mode === 'live' ? 'clearedLive' : 'clearedSandbox']: { ...d[mode === 'live' ? 'clearedLive' : 'clearedSandbox'] } };
      const clearKey = mode === 'live' ? 'clearedLive' : 'clearedSandbox';
      if (val === '') delete next[mode][key];
      else next[mode][key] = val;
      delete next[clearKey][key]; // typing cancels a pending clear
      return next;
    });
  };

  const clearField = (mode, key) => {
    setDraft((d) => {
      const clearKey = mode === 'live' ? 'clearedLive' : 'clearedSandbox';
      const next = { ...d, [mode]: { ...d[mode] }, [clearKey]: { ...d[clearKey], [key]: true } };
      delete next[mode][key];
      return next;
    });
  };

  const save = async () => {
    setSaving(true);
    setSaveErr('');
    try {
      // Build one PATCH body per mode. Only typed fields (replace) and cleared
      // fields ("") are sent — untouched fields are omitted so the stored value
      // is kept (write-only semantics). Root toggles ride with the live PATCH.
      const liveBody = { mode: 'live', enabled, allow_sandbox_on_live: allowSandbox, ...draft.live };
      for (const k of Object.keys(draft.clearedLive)) liveBody[k] = '';
      await api.put(`/checkout/gateways/${encodeURIComponent(funnelId)}/${gateway}`, liveBody);

      const sandboxDirty = Object.keys(draft.sandbox).length || Object.keys(draft.clearedSandbox).length;
      if (sandboxDirty) {
        const sbxBody = { mode: 'sandbox', ...draft.sandbox };
        for (const k of Object.keys(draft.clearedSandbox)) sbxBody[k] = '';
        await api.put(`/checkout/gateways/${encodeURIComponent(funnelId)}/${gateway}`, sbxBody);
      }
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
  const sandboxStatus = status ? (status.sandbox?.status || 'unknown') : 'checking';

  return (
    <div className="space-y-5">
      <button
        onClick={onBack}
        className="flex items-center gap-1.5 text-sm text-text-muted hover:text-text-primary cursor-pointer"
      >
        <ArrowLeft className="w-4 h-4" /> All processors
      </button>

      <div className="flex items-center justify-between gap-3">
        <div className="flex items-center gap-3">
          <GatewayLogo name={meta.name} accent={meta.accent} />
          <div>
            <h3 className="text-base font-semibold text-text-primary">{meta.name}</h3>
            <a
              href={meta.dashboard.live}
              target="_blank"
              rel="noopener noreferrer"
              className="inline-flex items-center gap-1 text-xs text-text-muted hover:text-accent-text cursor-pointer"
            >
              {meta.name} dashboard <ExternalLink className="w-3 h-3" />
            </a>
          </div>
        </div>
        <span className="inline-flex items-center gap-1.5 px-2.5 py-1 rounded-lg bg-emerald-500/10 text-emerald-400 text-xs font-medium border border-emerald-500/20">
          <span className="w-1.5 h-1.5 rounded-full bg-emerald-400" /> Buyers pay on: LIVE
        </span>
      </div>

      {!meta.hasAdapter && (
        <div className="flex items-start gap-2 rounded-lg border border-amber-500/20 bg-amber-500/5 px-3 py-2 text-xs text-amber-300/90">
          <Info className="w-4 h-4 shrink-0 mt-0.5" />
          <span>
            {meta.name} credentials are stored & health-checked, but the charge adapter
            is not built yet — this funnel can’t charge through {meta.name} today.
          </span>
        </div>
      )}

      {/* Model explainer + toggles */}
      <div className="rounded-xl border border-border-default bg-bg-card p-4 space-y-3">
        <p className="text-xs text-text-muted">
          Keep a <span className="text-text-primary font-medium">Live</span> app and a{' '}
          <span className="text-text-primary font-medium">Sandbox</span> app connected at once.
          Buyers automatically use Live; checkout previews and connection tests use Sandbox.
          No manual switch — Live takes over the moment its credentials are saved.
        </p>
        <ToggleRow
          label={`Enable ${meta.name} on this funnel`}
          hint="Off → checkout won’t offer it even with valid credentials."
          checked={enabled}
          onChange={setEnabled}
        />
        {/* Stored but not yet consulted anywhere — disabled until the
            preview-mode wiring lands, so the operator is never lied to. */}
        <ToggleRow
          label="Allow sandbox on the live funnel (coming soon — preview wiring)"
          hint="Off by default — will let the sandbox app run on the real host for staging once preview mode ships."
          checked={allowSandbox}
          onChange={setAllowSandbox}
          disabled
        />
      </div>

      {/* Two credential cards, side by side */}
      <div className="grid grid-cols-1 lg:grid-cols-2 gap-3">
        <CredentialCard
          title="Sandbox app"
          subtitle="Previews & connection tests"
          status={sandboxStatus}
          meta={meta}
          set={config?.sandbox}
          draft={draft.sandbox}
          cleared={draft.clearedSandbox}
          onChange={(k, v) => setField('sandbox', k, v)}
          onClear={(k) => clearField('sandbox', k)}
        />
        <CredentialCard
          title="Live app"
          subtitle="Real buyers"
          status={liveStatus}
          meta={meta}
          set={config?.live}
          draft={draft.live}
          cleared={draft.clearedLive}
          onChange={(k, v) => setField('live', k, v)}
          onClear={(k) => clearField('live', k)}
        />
      </div>

      {saveErr && <p className="text-sm text-danger">{saveErr}</p>}
      <div className="flex items-center gap-3">
        <Button onClick={save} loading={saving} disabled={!dirty}>Save credentials</Button>
        {savedFlash && <span className="text-sm text-success">Saved</span>}
        {dirty && !savedFlash && <span className="text-xs text-text-faint">Unsaved changes</span>}
      </div>
    </div>
  );
}

function ToggleRow({ label, hint, checked, onChange, disabled = false }) {
  return (
    <div className="flex items-center justify-between gap-4">
      <div className={disabled ? 'opacity-60' : ''}>
        <div className="text-sm text-text-primary">{label}</div>
        <div className="text-xs text-text-faint">{hint}</div>
      </div>
      <Toggle checked={checked} onChange={onChange} disabled={disabled} />
    </div>
  );
}

function CredentialCard({ title, subtitle, status, meta, set, draft, cleared, onChange, onClear }) {
  return (
    <div className="rounded-xl border border-border-default bg-bg-card p-4 space-y-3">
      <div className="flex items-center justify-between">
        <div>
          <div className="text-sm font-semibold text-text-primary">{title}</div>
          <div className="text-xs text-text-faint">{subtitle}</div>
        </div>
        <StatusPill status={status} />
      </div>
      <div className="space-y-3">
        {meta.fields.map((f) => {
          const secretSet = f.kind === 'secret' ? Boolean(set?.[`${f.key}_set`]) && !cleared[f.key] : false;
          const plainVal = f.kind === 'plain' ? (set?.[f.key] ?? '') : '';
          return (
            <CredentialField
              key={f.key}
              field={f}
              currentSet={secretSet}
              currentValue={plainVal}
              value={draft[f.key]}
              onChange={(v) => onChange(f.key, v)}
              onClear={f.kind === 'secret' && secretSet ? () => onClear(f.key) : undefined}
            />
          );
        })}
      </div>
    </div>
  );
}
