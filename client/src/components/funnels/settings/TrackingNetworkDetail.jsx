// ONE network detail page, for every card in the directory.
//
// The reference tool shows the same five blocks for every network — back link,
// header, credentials, ad tracking URL, status — and the only thing that varies
// is WHICH credentials and WHETHER anything actually delivers. So this is one
// component driven by the server-side directory
// (services/trackingNetworkDirectory.js) rather than twelve near-copies, and
// the honesty rules are enforced in ONE place:
//
//   wired 'server'  a real adapter delivers (meta_pixel, ga4). Full credential
//                   form + mode switch + live counters + delivery feed.
//   wired 'preset'  no bespoke adapter, but the network's server channel IS a
//                   click-id postback — so the card connects through the
//                   generic custom-S2S template engine, prefilled. The counters
//                   come from the custom-network health surface.
//   wired 'stub'    nothing delivers. The page says exactly that, shows the ad
//                   tracking URL (still useful — the click id is captured on
//                   landing regardless), and offers no credential form that
//                   would imply otherwise.
//
// The credential form for a 'server' network writes through the EXISTING
// registry route (PUT /tracking-admin/:funnelId/networks/:kind) — its
// write-only secret semantics are reused verbatim, never re-implemented:
//   ''    → keep the stored secret (a masked re-submit must not wipe it)
//   null  → clear it
//   value → replace it
import { useCallback, useEffect, useState } from 'react';
import { ArrowLeft, RefreshCw, ChevronRight, PlugZap } from 'lucide-react';
import api from '../../../services/api';
import Button from '../../ui/Button';
import { GatewayLogo, CredentialField } from './ui';
import {
  ConnChip, CopyUrlButton, CheckboxRow, Panel, StatRow,
} from './trackingUi';
import { EVT_STATUS_CLS, errOf } from './trackingConstants';

// Which fields each SERVER-WIRED kind exposes. Mirrors the server registry
// (routes/trackingAdmin.js TRACKING_NETWORKS) — the server is the authority and
// rejects anything else, so a drift here surfaces as a 400 with a named code,
// never as a silently-dropped field.
const CRED_SPECS = {
  meta_pixel: {
    idField: 'pixel_id',
    idPlaceholder: '1234567890123456',
    secrets: [{ name: 'capi_token', label: 'Conversions API token', placeholder: 'EAAB…' }],
    plain: [{ name: 'test_event_code', label: 'Test event code — optional', placeholder: 'TEST12345', help: 'Routes tests to Events Manager → Test Events.' }],
  },
  ga4: {
    idField: 'measurement_id',
    idPlaceholder: 'G-XXXXXXXXXX',
    secrets: [{ name: 'api_secret', label: 'Measurement Protocol API secret', placeholder: '••••••' }],
    plain: [],
  },
  google_ads: {
    idField: 'customer_id',
    idPlaceholder: '123-456-7890',
    secrets: [
      { name: 'developer_token', label: 'Developer token', placeholder: '••••••' },
      { name: 'refresh_token', label: 'OAuth refresh token', placeholder: '••••••' },
    ],
    plain: [{ name: 'conversion_action_id', label: 'Conversion action ID', placeholder: '987654321' }],
  },
};

const MODE_LABELS = { native: 'Browser only', s2s: 'Server only', hybrid: 'Server + Browser' };

export default function TrackingNetworkDetail({
  funnel, card, network, summary, customNetwork, customHealth, adUrl,
  onBack, onSaved, onOpenCustom, onCreatePreset,
}) {
  const kind = card.kind || '';
  const spec = CRED_SPECS[kind] || null;
  const isServerWired = card.wired === 'server' && Boolean(spec);
  const isPreset = card.wired === 'preset';

  // ── credential form state (server-wired kinds only) ───────────────────────
  const [idVal, setIdVal] = useState('');
  const [secretVals, setSecretVals] = useState({});   // typed replacements
  const [secretCleared, setSecretCleared] = useState({});
  const [plainVals, setPlainVals] = useState({});
  const [enabled, setEnabled] = useState(true);
  const [saving, setSaving] = useState(false);
  const [saveErr, setSaveErr] = useState('');
  const [savedFlash, setSavedFlash] = useState(false);
  const [mode, setMode] = useState('hybrid');
  const [modeSaving, setModeSaving] = useState('');
  const [modeErr, setModeErr] = useState('');

  // Reseed whenever the server view changes. `network` is the MASKED view — a
  // secret is only ever a `<name>_set` boolean, never a value.
  useEffect(() => {
    if (!spec) return;
    setIdVal(network?.[spec.idField] ?? network?.pixel_id ?? '');
    setPlainVals(Object.fromEntries(spec.plain.map((p) => [p.name, network?.[p.name] || ''])));
    setSecretVals({});
    setSecretCleared({});
    setEnabled(network ? network.enabled === true : true);
    setMode(network?.mode || card.default_mode || 'hybrid');
  }, [network, spec, card.default_mode]);

  // ── delivery feed ─────────────────────────────────────────────────────────
  // lb_tracking_events.platform is the kind minus '_pixel' for a named network,
  // and literally 'custom' for a custom S2S network keyed by pixel_id.
  const platform = isPreset ? 'custom' : kind.replace(/_pixel$/, '');
  const customKey = customNetwork?.key || '';
  const [events, setEvents] = useState(null); // null=first load, 'error', or []
  const [eventsLoading, setEventsLoading] = useState(false);
  const [eventsErr, setEventsErr] = useState('');

  const loadEvents = useCallback(async () => {
    if (!platform) { setEvents([]); return; }
    setEventsLoading(true);
    try {
      const res = await api.get(`/tracking-admin/${encodeURIComponent(funnel.id)}/events`, { params: { limit: 50 } });
      const all = Array.isArray(res.data?.data?.events) ? res.data.data.events : [];
      setEvents(all.filter((e) => e.platform === platform && (!isPreset || e.pixel_id === customKey)));
      setEventsErr('');
    } catch (e) {
      // A failed REFRESH keeps the last-known rows on screen and reports
      // inline; only a failed FIRST load has nothing to show.
      setEvents((prev) => (Array.isArray(prev) ? prev : 'error'));
      setEventsErr(errOf(e, 'Failed to load deliveries'));
    } finally { setEventsLoading(false); }
  }, [funnel.id, platform, isPreset, customKey]);

  useEffect(() => {
    if (isServerWired || (isPreset && customNetwork)) loadEvents();
    else setEvents([]);
  }, [loadEvents, isServerWired, isPreset, customNetwork]);

  // ── save ──────────────────────────────────────────────────────────────────
  // Baseline = the masked view this form was seeded from. Only fields the
  // operator actually CHANGED go in the body: an omitted field keeps its stored
  // value server-side, so a form seeded from a stale read can never clear
  // config it never displayed.
  const baseId = network?.[spec?.idField] ?? network?.pixel_id ?? '';
  const baseEnabled = network ? network.enabled === true : true;
  const dirty = spec ? (
    idVal.trim() !== baseId
    || enabled !== baseEnabled
    || spec.plain.some((p) => (plainVals[p.name] || '').trim() !== (network?.[p.name] || ''))
    || spec.secrets.some((s) => (secretVals[s.name] || '').trim() !== '' || secretCleared[s.name])
  ) : false;

  const save = async () => {
    setSaving(true); setSaveErr('');
    try {
      const body = {};
      if (idVal.trim() !== baseId) body[spec.idField] = idVal.trim();
      if (enabled !== baseEnabled) body.enabled = enabled;
      for (const p of spec.plain) {
        const v = (plainVals[p.name] || '').trim();
        if (v !== (network?.[p.name] || '')) body[p.name] = v;
      }
      for (const s of spec.secrets) {
        // Write-only semantics, exactly as the server documents them.
        if (secretCleared[s.name]) body[s.name] = null;
        else if ((secretVals[s.name] || '').trim() !== '') body[s.name] = secretVals[s.name].trim();
      }
      await api.put(`/tracking-admin/${encodeURIComponent(funnel.id)}/networks/${kind}`, body);
      setSavedFlash(true); setTimeout(() => setSavedFlash(false), 2000);
      setSecretVals({}); setSecretCleared({});
      onSaved?.();
    } catch (e) {
      setSaveErr(errOf(e, 'Failed to save credentials'));
    } finally { setSaving(false); }
  };

  const setModeRemote = async (m) => {
    if (m === mode || modeSaving) return;
    const prev = mode;
    setMode(m); setModeErr(''); setModeSaving(m);
    try {
      await api.put(`/tracking-admin/${encodeURIComponent(funnel.id)}/networks/${kind}`, { mode: m });
      onSaved?.();
    } catch (e) {
      setMode(prev); // revert the optimistic switch
      setModeErr(errOf(e, 'Failed to change the mode'));
    } finally { setModeSaving(''); }
  };

  // ── status ────────────────────────────────────────────────────────────────
  // `summary === undefined` = still loading, `null` = the load FAILED. Neither
  // may render as a confident "not connected" — that is how an operator ends up
  // re-pasting a token that was never missing.
  const stat = isPreset ? customHealth : summary;
  const ready = Boolean(stat?.server_channel_ready);
  const chip = stat === undefined ? 'checking'
    : stat === null ? 'unknown'
      : (ready ? 'connected' : 'not_connected');
  const breakerOpen = stat?.breaker?.state === 'open';
  const clickIds = (card.click_ids || []).join(', ') || '—';

  return (
    <div className="space-y-5 max-w-2xl">
      <button onClick={onBack} className="flex items-center gap-1.5 text-sm text-text-muted hover:text-text-primary cursor-pointer">
        <ArrowLeft className="w-4 h-4" /> All networks
      </button>

      <div className="flex items-center gap-3">
        <GatewayLogo name={card.name} accent={card.accent} />
        <div className="min-w-0">
          <div className="flex items-center gap-2 flex-wrap">
            <h3 className="text-base font-semibold text-text-primary">{card.name}</h3>
            <ConnChip state={chip} />
          </div>
          <p className="text-xs text-text-muted">{card.method}</p>
        </div>
      </div>
      {card.setup && <p className="text-xs text-text-faint">{card.setup}</p>}

      {/* CREDENTIALS — only where a real adapter consumes them */}
      {isServerWired && (
        <Panel
          title="Credentials"
          description="Used server-side to relay events. Secrets are encrypted at rest and write-only — they are never shown again."
        >
          <div className="space-y-1">
            <label className="block text-xs font-medium text-text-muted">{card.id_label}</label>
            <input
              value={idVal}
              onChange={(e) => setIdVal(e.target.value)}
              placeholder={spec.idPlaceholder}
              autoComplete="off"
              spellCheck={false}
              className="w-full px-3 py-2 text-sm bg-bg-elevated border border-border-default rounded-lg text-text-primary placeholder:text-text-faint font-mono focus:outline-none focus:ring-2 focus:ring-accent/40 focus:border-accent transition-colors"
            />
          </div>
          {spec.secrets.map((s) => {
            const isSet = Boolean(network?.[`${s.name}_set`]) && !secretCleared[s.name];
            return (
              <div key={s.name}>
                <CredentialField
                  field={{
                    kind: 'secret',
                    label: s.label,
                    placeholder: s.placeholder,
                    setPlaceholder: '•••••• saved — type to replace, blank keeps it',
                  }}
                  currentSet={isSet}
                  value={secretVals[s.name] || ''}
                  onChange={(v) => {
                    setSecretVals((p) => ({ ...p, [s.name]: v }));
                    if (v !== '') setSecretCleared((p) => ({ ...p, [s.name]: false }));
                  }}
                  onClear={isSet ? () => {
                    setSecretCleared((p) => ({ ...p, [s.name]: true }));
                    setSecretVals((p) => ({ ...p, [s.name]: '' }));
                  } : undefined}
                  autoComplete="new-password"
                />
                {secretCleared[s.name] && (
                  <p className="mt-1 text-xs text-amber-400">The stored {s.label.toLowerCase()} will be cleared when you save.</p>
                )}
              </div>
            );
          })}
          {spec.plain.map((p) => (
            <div key={p.name} className="space-y-1">
              <label className="block text-xs font-medium text-text-muted">{p.label}</label>
              <input
                value={plainVals[p.name] || ''}
                onChange={(e) => setPlainVals((prev) => ({ ...prev, [p.name]: e.target.value }))}
                placeholder={p.placeholder}
                autoComplete="off"
                spellCheck={false}
                className="w-full px-3 py-2 text-sm bg-bg-elevated border border-border-default rounded-lg text-text-primary placeholder:text-text-faint font-mono focus:outline-none focus:ring-2 focus:ring-accent/40 focus:border-accent transition-colors"
              />
              {p.help && <p className="text-xs text-text-faint">{p.help}</p>}
            </div>
          ))}
          <CheckboxRow label="Enabled" checked={enabled} onChange={setEnabled} />
          {network?.delivery_note && (
            <p className="text-xs text-amber-400/90 leading-relaxed">{network.delivery_note}</p>
          )}
          {saveErr && <p className="text-sm text-danger">{saveErr}</p>}
          <div className="flex items-center gap-3 pt-1">
            <Button onClick={save} loading={saving} disabled={!dirty}>Save credentials</Button>
            {savedFlash && <span className="text-sm text-success">Saved</span>}
            {dirty && !savedFlash && <span className="text-xs text-text-faint">Unsaved changes</span>}
          </div>
        </Panel>
      )}

      {/* PRESET — connect through the custom-S2S template engine */}
      {isPreset && (
        <Panel
          title="Server channel — postback template"
          description="This network's server channel is a plain click-id postback, so it runs through the custom S2S engine rather than a bespoke adapter. The preset fills in the network's documented postback URL; you can edit it, and you can test-fire it before any money rides on it."
        >
          {customNetwork ? (
            <>
              <StatRow label="Connected as">
                <span className="font-mono text-xs">{customNetwork.label}</span>
              </StatRow>
              <StatRow label="Enabled" tone={customNetwork.enabled ? 'text-emerald-400' : 'text-amber-400'}>
                {customNetwork.enabled ? 'yes' : 'no — not firing'}
              </StatRow>
              <code className="block px-3 py-2 text-xs bg-bg-elevated border border-border-default rounded-lg text-text-primary font-mono break-all select-all">
                {customNetwork.url_template}
              </code>
              <button
                onClick={() => onOpenCustom?.(customNetwork.id)}
                className="flex items-center gap-1 text-sm text-accent-text hover:underline cursor-pointer"
              >
                Edit, toggle events and test-fire <ChevronRight className="w-4 h-4" />
              </button>
            </>
          ) : (
            <>
              {card.preset_needs_credential && (
                <p className="text-xs text-amber-400">
                  {card.preset_credential_note || 'This preset needs an account credential pasted into the URL before it can fire.'}
                  {' '}It will be created DISABLED so nothing is sent to a placeholder URL.
                </p>
              )}
              <Button onClick={() => onCreatePreset?.(card.key)}>
                <PlugZap className="w-4 h-4 mr-1.5" /> Create from preset
              </Button>
            </>
          )}
        </Panel>
      )}

      {/* STUB — no credential form, because nothing would consume it */}
      {card.wired === 'stub' && (
        <div className="rounded-lg border border-dashed border-border-default bg-bg-elevated/40 px-4 py-6 text-center space-y-1">
          <p className="text-sm text-text-muted">
            No server channel is wired for this network yet — nothing is being sent.
          </p>
          <p className="text-xs text-text-faint">
            The card is here because the click id below IS still captured on landing, so the
            traffic is already attributed in this dashboard. Only the conversion POST back to
            the network is missing.
          </p>
        </div>
      )}

      {/* AD TRACKING URL */}
      {adUrl ? (
        <Panel title="Ad tracking URL">
          <div className="flex items-start gap-2">
            <code className="flex-1 min-w-0 block px-3 py-2 text-xs bg-bg-elevated border border-border-default rounded-lg text-text-primary font-mono break-all select-all">
              {adUrl}
            </code>
            <CopyUrlButton value={adUrl} />
          </div>
          <p className="text-xs text-text-faint">
            Append this to your {card.name} campaign&apos;s landing/ad URL — the tracker captures the
            click id and sub-ids on landing.
          </p>
          {card.click_id_note && <p className="text-xs text-amber-400/90">{card.click_id_note}</p>}
        </Panel>
      ) : (
        <Panel title="Ad tracking URL">
          <p className="text-sm text-text-muted">
            This network has no URL macros to paste — it supplies its identifiers another way.
          </p>
        </Panel>
      )}

      {/* STATUS */}
      <Panel title="Status">
        {stat === undefined ? (
          <p className="text-sm text-text-muted">Loading status…</p>
        ) : stat === null ? (
          <p className="text-sm text-danger">Could not load the delivery summary — refresh to retry.</p>
        ) : (
          <div className="space-y-1.5">
            <StatRow label="Click-id parameters">
              <span className="font-mono">{clickIds}</span>
            </StatRow>
            <StatRow label="Server channel ready" tone={ready ? 'text-emerald-400' : 'text-amber-400'}>
              {ready ? 'yes'
                : card.wired === 'stub' ? 'no — no server adapter for this network'
                  : isPreset && !customNetwork ? 'no — not connected yet'
                    : 'no — credentials missing'}
            </StatRow>
            <StatRow label="Delivered last 24h">
              {(stat?.sent_24h ?? 0)} sent · {(stat?.failed_24h ?? 0)} failed · {(stat?.deduped_24h ?? 0)} deduped
            </StatRow>
            {Number(stat?.queued_now) > 0 && (
              <StatRow label="Waiting to retry" tone="text-amber-400">{stat.queued_now} queued</StatRow>
            )}
            {breakerOpen && (
              <StatRow label="Delivery breaker" tone="text-red-400">
                open ({stat.breaker.fails} fails) — deliveries paused until{' '}
                {stat.breaker.open_until ? new Date(stat.breaker.open_until).toLocaleString() : 'reset'}
              </StatRow>
            )}
          </div>
        )}
      </Panel>

      {/* TRACKING MODE — only where more than one mode is actually offered */}
      {isServerWired && Array.isArray(network?.modes) && network.modes.length > 1 && (
        <Panel title="Tracking mode">
          <div className="inline-flex rounded-lg border border-border-default bg-bg-elevated p-0.5">
            {network.modes.map((m) => (
              <button
                key={m}
                onClick={() => setModeRemote(m)}
                disabled={Boolean(modeSaving)}
                className={`px-3 py-1.5 text-xs font-medium rounded-md cursor-pointer transition-colors disabled:cursor-not-allowed
                  ${mode === m ? 'bg-accent-muted text-accent-text' : 'text-text-muted hover:text-text-primary'}`}
              >
                {modeSaving === m ? 'Saving…' : (MODE_LABELS[m] || m)}
              </button>
            ))}
          </div>
          <p className="text-xs text-text-faint">
            Server + Browser fires each event on both channels with one shared event id — the browser
            pixel for match quality, the server for reliability — and the platform dedupes on that id.
            Server only relays exclusively server-side; Browser only fires the pixel alone.
          </p>
          {modeErr && <p className="text-sm text-danger">{modeErr}</p>}
        </Panel>
      )}

      {/* RECENT DELIVERIES */}
      {(isServerWired || (isPreset && customNetwork)) && (
        <Panel>
          <div className="flex items-center justify-between">
            <div className="text-sm font-semibold text-text-primary">Recent deliveries</div>
            <button
              onClick={loadEvents}
              disabled={eventsLoading}
              className="flex items-center gap-1.5 text-xs text-text-muted hover:text-text-primary cursor-pointer disabled:opacity-50 disabled:cursor-not-allowed"
            >
              <RefreshCw className={`w-3.5 h-3.5 ${eventsLoading ? 'animate-spin' : ''}`} /> Refresh
            </button>
          </div>
          {eventsErr && Array.isArray(events) && <p className="text-sm text-danger">{eventsErr}</p>}
          {events === null ? (
            <p className="text-sm text-text-muted">Loading deliveries…</p>
          ) : events === 'error' ? (
            <p className="text-sm text-danger">{eventsErr}</p>
          ) : events.length === 0 ? (
            <div className="rounded-lg border border-dashed border-border-default bg-bg-elevated/40 px-4 py-6 text-center text-sm text-text-muted">
              No deliveries yet — events show up here as visitors convert.
            </div>
          ) : (
            <div className="divide-y divide-border-subtle">
              {events.slice(0, 25).map((e) => (
                <div key={e.id} className="flex items-center justify-between gap-3 py-2 text-sm">
                  <div className="min-w-0">
                    <span className="text-text-primary font-medium">{e.event_name || '—'}</span>
                    {e.value != null && e.value !== '' && (
                      <span className="ml-2 text-text-muted">
                        {Number.isFinite(Number(e.value)) ? `$${Number(e.value).toFixed(2)}` : '—'}
                      </span>
                    )}
                    {e.error && <div className="text-xs text-red-400 truncate max-w-md">{e.error}</div>}
                  </div>
                  <div className="flex items-center gap-3 shrink-0 text-xs">
                    <span className={`font-medium ${EVT_STATUS_CLS[e.status] || 'text-text-muted'}`}>{e.status}</span>
                    <span className="text-text-faint">{e.ts ? new Date(e.ts).toLocaleString() : '—'}</span>
                  </div>
                </div>
              ))}
            </div>
          )}
        </Panel>
      )}
    </div>
  );
}
