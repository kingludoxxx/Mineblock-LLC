// Tracking — the funnel's ad-network directory, shaped to the operator's
// reference tool (network grid → network detail), wired to the tracking
// lane's authed admin surface (server routes/trackingAdmin.js, mounted at
// /api/v1/tracking-admin — verified against the tracking-server branch).
//
// WIRED TODAY: meta_pixel (the only kind in the server's TRACKING_NETWORKS
// registry). Every other card is a directory stub that opens an honest
// "not wired yet" page — no fake connectivity, no fake numbers, ever.
//
// PERSISTENCE:
//   Network credentials/mode  → PUT /tracking-admin/:funnelId/networks/:kind
//     (capi_token is write-only: '' keeps the stored token, null clears it —
//      the server never echoes it back in any state)
//   GENERAL event options     → funnels.settings.tracking (JSONB) via the
//     existing funnels PATCH, read-merge-write like the sibling sections.
import { useCallback, useEffect, useState } from 'react';
import { ArrowLeft, RefreshCw, Copy, Check, ChevronRight } from 'lucide-react';
import api from '../../../services/api';
import Button from '../../ui/Button';
import { Toggle, GatewayLogo, CredentialField } from './ui';
import { isObj, saveFunnelPatch } from './sections';

// ── static client registry (directory cards) ────────────────────────────────
// `kind` present = wired to the server registry; absent = directory stub.
const AD_NETWORKS = [
  { key: 'meta', kind: 'meta_pixel', name: 'Meta (Facebook & Instagram)', method: 'Conversions API', tag: 'S+B', accent: '#1877F2' },
  { key: 'tiktok', name: 'TikTok', method: 'Events API', tag: 'S+B', accent: '#00F2EA' },
  { key: 'applovin', name: 'AppLovin', method: 'AXON', tag: 'BROWSER', accent: '#0AB4FF' },
  { key: 'pinterest', name: 'Pinterest', method: 'CAPI v5', tag: 'S+B', accent: '#E60023' },
  { key: 'snapchat', name: 'Snapchat', method: 'CAPI v3', tag: 'S+B', accent: '#FFFC00' },
  { key: 'taboola', name: 'Taboola', method: 'S2S postback', tag: 'S2S', accent: '#3D5AFE' },
  { key: 'outbrain', name: 'Outbrain', method: 'S2S postback', tag: 'S2S', accent: '#F18421' },
  { key: 'newsbreak', name: 'NewsBreak', method: 'S2S postback', tag: 'SERVER', accent: '#D1372C' },
  { key: 'revcontent', name: 'RevContent', method: 'S2S postback', tag: 'SERVER', accent: '#00A4E4' },
  { key: 'mgid', name: 'MGID', method: 'S2S postback', tag: 'SERVER', accent: '#1E88E5' },
  { key: 'google_ads', name: 'Google Ads (incl. YouTube)', method: 'Enhanced conversions', tag: 'S+B', accent: '#4285F4' },
  { key: 'reddit', name: 'Reddit Ads', method: 'CAPI', tag: 'S+B', accent: '#FF4500' },
];

// Server 400 codes → operator prose (routes/trackingAdmin.js).
const TRK_ERR = {
  unknown_kind: 'The server does not support this network yet.',
  invalid_mode: 'Invalid tracking mode — pick one of the three options.',
  invalid_graph_version: 'Graph version must look like v23.0.',
  pixel_id_required: 'Enter a Pixel ID first — the network config is stored keyed to it.',
  internal_error: 'Server error — try again.',
};
const trkErr = (code, fallback = 'Request failed') => TRK_ERR[code] || (code ? `Failed (${code})` : fallback);

// The funnel's public serving base — same model the Domains tab persists:
// custom_domain (primary) serves the funnel root; otherwise /f/<slug> on this
// app's origin (FunnelSettingsModal's publicPath / HealthSection's warnText).
function servingBase(funnel) {
  if (funnel?.custom_domain) return `https://${funnel.custom_domain}/`;
  return `${window.location.origin}/f/${funnel?.slug || ''}`;
}

function ConnChip({ state }) {
  // state: 'connected' | 'not_connected' | 'checking' | 'unknown'
  const map = {
    connected: { label: 'Connected', cls: 'bg-emerald-500/10 text-emerald-400 border-emerald-500/20' },
    not_connected: { label: 'Not connected', cls: 'bg-bg-elevated text-text-muted border-border-default' },
    checking: { label: 'Checking…', cls: 'bg-bg-elevated text-text-faint border-border-default' },
    unknown: { label: 'Status unknown', cls: 'bg-amber-500/10 text-amber-400 border-amber-500/20' },
  };
  const s = map[state] || map.unknown;
  return (
    <span className={`inline-flex items-center px-2 py-0.5 text-[10px] font-semibold uppercase tracking-wide rounded-full border ${s.cls}`}>
      {s.label}
    </span>
  );
}

function ModeTag({ tag }) {
  return (
    <span className="inline-flex items-center px-1.5 py-0.5 text-[10px] font-semibold uppercase tracking-wide rounded border border-border-default bg-bg-elevated text-text-faint shrink-0">
      {tag}
    </span>
  );
}

function CopyUrlButton({ value }) {
  const [copied, setCopied] = useState(false);
  const copy = async () => {
    try {
      await navigator.clipboard.writeText(String(value ?? ''));
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    } catch { /* clipboard unavailable (http / permissions) — non-fatal */ }
  };
  return (
    <button
      onClick={copy}
      title="Copy URL"
      className="inline-flex items-center gap-1.5 px-3 py-1.5 text-xs rounded-lg border border-border-default bg-bg-elevated text-text-primary hover:bg-bg-hover cursor-pointer transition-colors shrink-0"
    >
      {copied ? <Check className="w-3.5 h-3.5 text-emerald-400" /> : <Copy className="w-3.5 h-3.5" />}
      {copied ? 'Copied' : 'Copy'}
    </button>
  );
}

function CheckboxRow({ label, checked, onChange, disabled = false }) {
  return (
    <label className={`flex items-center gap-2.5 text-sm text-text-primary ${disabled ? 'opacity-60' : 'cursor-pointer'}`}>
      <input
        type="checkbox"
        checked={checked}
        disabled={disabled}
        onChange={(e) => onChange(e.target.checked)}
        className="w-4 h-4 rounded border-border-default bg-bg-elevated accent-accent cursor-pointer disabled:cursor-not-allowed"
      />
      {label}
    </label>
  );
}

// ── GENERAL panel — event options persisted to settings.tracking ────────────
// Optimistic: the checkbox flips immediately, the PATCH runs read-merge-write
// (saveFunnelPatch), and a failure reverts the flip + shows inline prose.
const GENERAL_DEFAULTS = {
  fire_purchase: 'checkout_server',
  send_external_id: false,
  fire_addtocart_checkout: false,
  fire_viewcontent_lead: false,
  unique_txn_per_upsell: false,
};

function GeneralPanel({ funnel, onFunnelUpdated }) {
  const stored = () => {
    const st = isObj(funnel?.settings) ? funnel.settings : {};
    const tr = isObj(st.tracking) ? st.tracking : {};
    return { ...GENERAL_DEFAULTS, ...tr };
  };
  const [vals, setVals] = useState(stored);
  const [err, setErr] = useState('');
  const [savingKey, setSavingKey] = useState('');

  useEffect(() => { setVals(stored()); }, [funnel]); // eslint-disable-line react-hooks/exhaustive-deps

  const saveKey = async (key, value) => {
    const prev = vals;
    const next = { ...vals, [key]: value };
    setVals(next); setErr(''); setSavingKey(key);
    try {
      const updated = await saveFunnelPatch(funnel.id, (fresh) => {
        const settings = { ...(isObj(fresh.settings) ? fresh.settings : {}) };
        settings.tracking = { ...(isObj(settings.tracking) ? settings.tracking : {}), [key]: value };
        return { settings };
      });
      onFunnelUpdated?.(updated);
    } catch (e) {
      setVals(prev); // revert the optimistic flip
      setErr(e.response?.data?.error || 'Failed to save — the change was reverted');
    } finally { setSavingKey(''); }
  };

  return (
    <div className="rounded-xl border border-border-default bg-bg-card p-4 space-y-3">
      <div>
        <h4 className="text-sm font-semibold text-text-primary">General</h4>
        <p className="text-xs text-text-faint">Event options applied across every connected network.</p>
      </div>
      <div className="flex items-center gap-3">
        <label className="text-sm text-text-primary shrink-0">Fire Purchase</label>
        <select
          value={vals.fire_purchase}
          onChange={(e) => saveKey('fire_purchase', e.target.value)}
          className="px-3 py-2 text-sm bg-bg-elevated border border-border-default rounded-lg text-text-primary focus:outline-none focus:ring-2 focus:ring-accent/40 focus:border-accent cursor-pointer"
        >
          <option value="checkout_server">right after checkout (server)</option>
        </select>
      </div>
      <div className="space-y-2 pt-1">
        <CheckboxRow label="Send hashed external id" checked={vals.send_external_id === true}
          disabled={savingKey === 'send_external_id'} onChange={(v) => saveKey('send_external_id', v)} />
        <CheckboxRow label="Fire AddToCart at checkout" checked={vals.fire_addtocart_checkout === true}
          disabled={savingKey === 'fire_addtocart_checkout'} onChange={(v) => saveKey('fire_addtocart_checkout', v)} />
        <CheckboxRow label="Fire ViewContent on lead" checked={vals.fire_viewcontent_lead === true}
          disabled={savingKey === 'fire_viewcontent_lead'} onChange={(v) => saveKey('fire_viewcontent_lead', v)} />
        <CheckboxRow label="Unique txn id per upsell" checked={vals.unique_txn_per_upsell === true}
          disabled={savingKey === 'unique_txn_per_upsell'} onChange={(v) => saveKey('unique_txn_per_upsell', v)} />
      </div>
      {err && <p className="text-sm text-danger">{err}</p>}
    </div>
  );
}

// ── META detail — credentials, ad URL, status, mode, recent deliveries ──────
const MODES = [
  { key: 'native', label: 'Browser only' },
  { key: 's2s', label: 'Server only' },
  { key: 'hybrid', label: 'Server + Browser' },
];
const EVT_STATUS_CLS = {
  sent: 'text-emerald-400',
  error: 'text-red-400',
  skipped: 'text-red-400',
  deduped: 'text-text-faint',
  queued: 'text-amber-400',
};

function MetaDetail({ funnel, network, summary, onBack, onSaved }) {
  const meta = AD_NETWORKS[0];
  const [pixelId, setPixelId] = useState(network?.pixel_id || '');
  const [token, setToken] = useState('');        // typed replacement (empty = keep)
  const [tokenCleared, setTokenCleared] = useState(false);
  const [testCode, setTestCode] = useState(network?.test_event_code || '');
  const [enabled, setEnabled] = useState(network ? network.enabled === true : true);
  const [saving, setSaving] = useState(false);
  const [saveErr, setSaveErr] = useState('');
  const [savedFlash, setSavedFlash] = useState(false);
  const [modeErr, setModeErr] = useState('');
  const [modeSaving, setModeSaving] = useState('');
  const [mode, setMode] = useState(network?.mode || 'hybrid');
  const [events, setEvents] = useState(null);    // null=loading, 'error', or []
  const [eventsErr, setEventsErr] = useState('');

  useEffect(() => {
    setPixelId(network?.pixel_id || '');
    setTestCode(network?.test_event_code || '');
    setEnabled(network ? network.enabled === true : true);
    setMode(network?.mode || 'hybrid');
    setToken(''); setTokenCleared(false);
  }, [network]);

  const loadEvents = useCallback(async () => {
    setEvents(null); setEventsErr('');
    try {
      const res = await api.get(`/tracking-admin/${encodeURIComponent(funnel.id)}/events`, { params: { limit: 50 } });
      const all = Array.isArray(res.data?.data?.events) ? res.data.data.events : [];
      // lb_tracking_events.platform is the kind minus '_pixel' (server comment).
      setEvents(all.filter((e) => e.platform === 'meta'));
    } catch (e) {
      setEvents('error');
      setEventsErr(trkErr(e.response?.data?.error?.code, 'Failed to load deliveries'));
    }
  }, [funnel.id]);

  useEffect(() => { loadEvents(); }, [loadEvents]);

  const save = async () => {
    setSaving(true); setSaveErr('');
    try {
      const body = { pixel_id: pixelId.trim(), enabled, test_event_code: testCode.trim() };
      // Write-only token semantics (server contract): '' keeps the stored
      // token, null clears it, a typed value replaces it.
      if (tokenCleared) body.capi_token = null;
      else if (token.trim() !== '') body.capi_token = token.trim();
      else body.capi_token = '';
      await api.put(`/tracking-admin/${encodeURIComponent(funnel.id)}/networks/meta_pixel`, body);
      setSavedFlash(true); setTimeout(() => setSavedFlash(false), 2000);
      setToken(''); setTokenCleared(false);
      onSaved?.();
    } catch (e) {
      setSaveErr(trkErr(e.response?.data?.error?.code, 'Failed to save credentials'));
    } finally { setSaving(false); }
  };

  const setModeRemote = async (m) => {
    if (m === mode || modeSaving) return;
    const prev = mode;
    setMode(m); setModeErr(''); setModeSaving(m);
    try {
      await api.put(`/tracking-admin/${encodeURIComponent(funnel.id)}/networks/meta_pixel`, { mode: m });
      onSaved?.();
    } catch (e) {
      setMode(prev); // revert the optimistic switch
      setModeErr(trkErr(e.response?.data?.error?.code, 'Failed to change the mode'));
    } finally { setModeSaving(''); }
  };

  const tokenSet = Boolean(network?.capi_token_set) && !tokenCleared;
  const ready = Boolean(summary?.server_channel_ready);
  const chip = summary === undefined ? 'checking'
    : summary === null ? 'unknown'
    : (ready ? 'connected' : 'not_connected');
  const adUrl = `${servingBase(funnel)}?utm_source=meta&campaignid={{campaign.id}}&adsetid={{adset.id}}&adid={{ad.id}}&fbclid={{fbclid}}`;
  const breakerOpen = summary?.breaker?.state === 'open';

  return (
    <div className="space-y-5 max-w-2xl">
      <button onClick={onBack} className="flex items-center gap-1.5 text-sm text-text-muted hover:text-text-primary cursor-pointer">
        <ArrowLeft className="w-4 h-4" /> All networks
      </button>

      <div className="flex items-center gap-3">
        <GatewayLogo name="Meta" accent={meta.accent} />
        <div className="min-w-0">
          <div className="flex items-center gap-2 flex-wrap">
            <h3 className="text-base font-semibold text-text-primary">{meta.name}</h3>
            <ConnChip state={chip} />
          </div>
          <p className="text-xs text-text-muted">Conversions API</p>
        </div>
      </div>
      <p className="text-xs text-text-faint">
        Events Manager → Settings → Conversions API → Generate access token.
      </p>

      {/* CREDENTIALS */}
      <div className="rounded-xl border border-border-default bg-bg-card p-4 space-y-3">
        <div>
          <div className="text-sm font-semibold text-text-primary">Credentials</div>
          <div className="text-xs text-text-faint">Used server-side to relay events. The token is encrypted at rest and write-only — it is never shown again.</div>
        </div>
        <div className="space-y-1">
          <label className="block text-xs font-medium text-text-muted">Meta Pixel ID</label>
          <input
            value={pixelId}
            onChange={(e) => setPixelId(e.target.value)}
            placeholder="1234567890123456"
            autoComplete="off"
            spellCheck={false}
            className="w-full px-3 py-2 text-sm bg-bg-elevated border border-border-default rounded-lg text-text-primary placeholder:text-text-faint font-mono focus:outline-none focus:ring-2 focus:ring-accent/40 focus:border-accent transition-colors"
          />
        </div>
        <CredentialField
          field={{
            kind: 'secret',
            label: 'Conversions API token',
            placeholder: 'EAAB…',
            setPlaceholder: '•••••• saved — type to replace, blank keeps it',
          }}
          currentSet={tokenSet}
          value={token}
          onChange={(v) => { setToken(v); if (v !== '') setTokenCleared(false); }}
          onClear={tokenSet ? () => { setTokenCleared(true); setToken(''); } : undefined}
        />
        {tokenCleared && (
          <p className="text-xs text-amber-400">The stored token will be cleared when you save credentials.</p>
        )}
        <div className="space-y-1">
          <label className="block text-xs font-medium text-text-muted">Test event code — optional (routes tests to Events Manager → Test Events)</label>
          <input
            value={testCode}
            onChange={(e) => setTestCode(e.target.value)}
            placeholder="TEST12345"
            autoComplete="off"
            spellCheck={false}
            className="w-full px-3 py-2 text-sm bg-bg-elevated border border-border-default rounded-lg text-text-primary placeholder:text-text-faint font-mono focus:outline-none focus:ring-2 focus:ring-accent/40 focus:border-accent transition-colors"
          />
        </div>
        <CheckboxRow label="Enabled" checked={enabled} onChange={setEnabled} />
        {saveErr && <p className="text-sm text-danger">{saveErr}</p>}
        <div className="flex items-center gap-3 pt-1">
          <Button onClick={save} loading={saving}>Save credentials</Button>
          {savedFlash && <span className="text-sm text-success">Saved</span>}
        </div>
      </div>

      {/* AD TRACKING URL */}
      <div className="rounded-xl border border-border-default bg-bg-card p-4 space-y-2">
        <div className="text-sm font-semibold text-text-primary">Ad tracking URL</div>
        <div className="flex items-start gap-2">
          <code className="flex-1 min-w-0 block px-3 py-2 text-xs bg-bg-elevated border border-border-default rounded-lg text-text-primary font-mono break-all select-all">
            {adUrl}
          </code>
          <CopyUrlButton value={adUrl} />
        </div>
        <p className="text-xs text-text-faint">
          Append this to your Meta (Facebook &amp; Instagram) campaign's landing/ad URL — the tracker captures the click id and sub-ids on landing.
        </p>
      </div>

      {/* STATUS */}
      <div className="rounded-xl border border-border-default bg-bg-card p-4 space-y-2">
        <div className="text-sm font-semibold text-text-primary">Status</div>
        {summary === undefined ? (
          <p className="text-sm text-text-muted">Loading status…</p>
        ) : summary === null ? (
          <p className="text-sm text-danger">Could not load the delivery summary — refresh to retry.</p>
        ) : (
          <div className="space-y-1.5 text-sm">
            <div className="flex items-center justify-between gap-4">
              <span className="text-text-muted">Click-id parameters</span>
              <span className="font-mono text-text-primary">{(summary.click_id_params || []).join(', ') || '—'}</span>
            </div>
            <div className="flex items-center justify-between gap-4">
              <span className="text-text-muted">Server channel ready</span>
              <span className={ready ? 'text-emerald-400' : 'text-amber-400'}>
                {ready ? 'yes' : 'no — credentials missing'}
              </span>
            </div>
            <div className="flex items-center justify-between gap-4">
              <span className="text-text-muted">Delivered last 24h</span>
              <span className="text-text-primary">
                {summary.sent_24h} sent · {summary.failed_24h} failed · {summary.deduped_24h} deduped
              </span>
            </div>
            {breakerOpen && (
              <div className="flex items-center justify-between gap-4">
                <span className="text-text-muted">Delivery breaker</span>
                <span className="text-red-400">open ({summary.breaker.fails} fails) — deliveries paused until {summary.breaker.open_until ? new Date(summary.breaker.open_until).toLocaleString() : 'reset'}</span>
              </div>
            )}
          </div>
        )}
      </div>

      {/* TRACKING MODE */}
      <div className="rounded-xl border border-border-default bg-bg-card p-4 space-y-2">
        <div className="text-sm font-semibold text-text-primary">Tracking mode</div>
        <div className="inline-flex rounded-lg border border-border-default bg-bg-elevated p-0.5">
          {MODES.map((m) => (
            <button
              key={m.key}
              onClick={() => setModeRemote(m.key)}
              disabled={Boolean(modeSaving)}
              className={`px-3 py-1.5 text-xs font-medium rounded-md cursor-pointer transition-colors disabled:cursor-not-allowed
                ${mode === m.key ? 'bg-accent-muted text-accent-text' : 'text-text-muted hover:text-text-primary'}`}
            >
              {modeSaving === m.key ? 'Saving…' : m.label}
            </button>
          ))}
        </div>
        <p className="text-xs text-text-faint">
          Server + Browser fires each event on both channels with one shared event id — the browser
          pixel for match quality, the server for reliability — and Meta dedupes on that id.
          Server only relays exclusively server-side; Browser only fires the pixel alone.
        </p>
        {modeErr && <p className="text-sm text-danger">{modeErr}</p>}
      </div>

      {/* RECENT DELIVERIES */}
      <div className="rounded-xl border border-border-default bg-bg-card p-4 space-y-2">
        <div className="flex items-center justify-between">
          <div className="text-sm font-semibold text-text-primary">Recent deliveries</div>
          <button onClick={loadEvents} className="flex items-center gap-1.5 text-xs text-text-muted hover:text-text-primary cursor-pointer">
            <RefreshCw className="w-3.5 h-3.5" /> Refresh
          </button>
        </div>
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
                    <span className="ml-2 text-text-muted">${Number(e.value).toFixed(2)}</span>
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
      </div>
    </div>
  );
}

// ── stub detail pages (honest — nothing is wired) ───────────────────────────
function StubDetail({ net, onBack }) {
  return (
    <div className="space-y-5 max-w-2xl">
      <button onClick={onBack} className="flex items-center gap-1.5 text-sm text-text-muted hover:text-text-primary cursor-pointer">
        <ArrowLeft className="w-4 h-4" /> All networks
      </button>
      <div className="flex items-center gap-3">
        <GatewayLogo name={net.name} accent={net.accent} />
        <div>
          <div className="flex items-center gap-2">
            <h3 className="text-base font-semibold text-text-primary">{net.name}</h3>
            <ConnChip state="not_connected" />
          </div>
          <p className="text-xs text-text-muted">{net.method}</p>
        </div>
      </div>
      <div className="rounded-lg border border-dashed border-border-default bg-bg-elevated/40 px-4 py-6 text-center">
        <p className="text-sm text-text-muted">
          Not wired yet — this network is in the directory, but credentials and delivery
          come with its integration phase. Nothing is being sent.
        </p>
      </div>
    </div>
  );
}

function GtmDetail({ onBack }) {
  return (
    <div className="space-y-5 max-w-2xl">
      <button onClick={onBack} className="flex items-center gap-1.5 text-sm text-text-muted hover:text-text-primary cursor-pointer">
        <ArrowLeft className="w-4 h-4" /> All networks
      </button>
      <div className="flex items-center gap-3">
        <GatewayLogo name="GTM" accent="#8AB4F8" />
        <div>
          <div className="flex items-center gap-2">
            <h3 className="text-base font-semibold text-text-primary">Google Tag Manager</h3>
            <ConnChip state="not_connected" />
          </div>
          <p className="text-xs text-text-muted">GTM · GA4 · first-party tagging server</p>
        </div>
      </div>
      <div className="rounded-lg border border-dashed border-border-default bg-bg-elevated/40 px-4 py-6 text-center">
        <p className="text-sm text-text-muted">Coming with the Google phase.</p>
      </div>
    </div>
  );
}

// ── the directory ───────────────────────────────────────────────────────────
export default function TrackingSection({ funnel, onFunnelUpdated }) {
  const [view, setView] = useState({ page: 'directory' });
  const [networks, setNetworks] = useState(null); // null=loading, 'error', or []
  const [summary, setSummary] = useState(null);   // null=loading, 'error', or []
  const [loadErr, setLoadErr] = useState('');

  const load = useCallback(async () => {
    try {
      const [nRes, sRes] = await Promise.all([
        api.get(`/tracking-admin/${encodeURIComponent(funnel.id)}/networks`),
        api.get(`/tracking-admin/${encodeURIComponent(funnel.id)}/tracking/summary`),
      ]);
      setNetworks(Array.isArray(nRes.data?.data?.networks) ? nRes.data.data.networks : []);
      setSummary(Array.isArray(sRes.data?.data?.networks) ? sRes.data.data.networks : []);
      setLoadErr('');
    } catch (e) {
      setNetworks((prev) => (Array.isArray(prev) ? prev : 'error'));
      setSummary((prev) => (Array.isArray(prev) ? prev : 'error'));
      setLoadErr(e.response?.status === 404
        ? 'Tracking endpoints are not available on this server yet (tracking lane not deployed).'
        : trkErr(e.response?.data?.error?.code, 'Failed to load tracking status'));
    }
  }, [funnel.id]);

  useEffect(() => { load(); }, [load]);

  const metaNetwork = Array.isArray(networks) ? networks.find((n) => n.kind === 'meta_pixel') : undefined;
  const metaSummary = Array.isArray(summary) ? summary.find((n) => n.kind === 'meta_pixel') : undefined;
  // Card chip: real server truth only — checking while in flight, unknown on error.
  const metaChip = summary === null ? 'checking'
    : summary === 'error' ? 'unknown'
    : (metaSummary?.server_channel_ready ? 'connected' : 'not_connected');

  if (view.page === 'meta') {
    return (
      <MetaDetail
        funnel={funnel}
        network={metaNetwork}
        // undefined = still loading, null = load failed, object = data
        summary={summary === null ? undefined : (summary === 'error' ? null : metaSummary)}
        onBack={() => setView({ page: 'directory' })}
        onSaved={load}
      />
    );
  }
  if (view.page === 'gtm') return <GtmDetail onBack={() => setView({ page: 'directory' })} />;
  if (view.page === 'stub') {
    const net = AD_NETWORKS.find((n) => n.key === view.key);
    return <StubDetail net={net || AD_NETWORKS[1]} onBack={() => setView({ page: 'directory' })} />;
  }

  return (
    <div className="space-y-5">
      <div>
        <h3 className="text-base font-semibold text-text-primary">Tracking</h3>
        <p className="mt-1 text-sm text-text-muted max-w-2xl">
          Every ad network in one place. Click a network to set its credentials, tracking mode
          (Server only, or Server + Browser for pixel platforms) and attribution — postback-first,
          server-to-server. This directory shows what's connected and whether deliveries flow.
        </p>
      </div>

      {loadErr && (
        <div className="flex items-center justify-between gap-3 px-3 py-2 rounded-lg border border-amber-500/20 bg-amber-500/10 text-xs text-amber-400">
          <span>{loadErr}</span>
          <button onClick={load} className="underline cursor-pointer shrink-0">Retry</button>
        </div>
      )}

      <GeneralPanel funnel={funnel} onFunnelUpdated={onFunnelUpdated} />

      {/* GTM — recommended base layer, full width */}
      <button
        onClick={() => setView({ page: 'gtm' })}
        className="w-full flex items-center justify-between gap-3 rounded-xl border border-border-default bg-bg-card p-4 text-left cursor-pointer hover:bg-bg-hover/40 transition-colors"
      >
        <div className="flex items-center gap-3 min-w-0">
          <GatewayLogo name="GTM" accent="#8AB4F8" />
          <div className="min-w-0">
            <div className="flex items-center gap-2 flex-wrap">
              <span className="text-sm font-semibold text-text-primary">Google Tag Manager — GTM · GA4 · first-party tagging server</span>
              <span className="inline-flex items-center px-2 py-0.5 text-[10px] font-semibold uppercase tracking-wide rounded-full border border-accent/20 bg-accent-muted text-accent-text shrink-0">
                Recommended base layer
              </span>
            </div>
            <div className="mt-1 flex items-center gap-2 text-xs text-text-muted">
              <span className="w-2 h-2 rounded-full bg-text-faint shrink-0" />
              GTM · GA4 · tagging server — optional, boosts match quality
            </div>
          </div>
        </div>
        <ChevronRight className="w-4 h-4 text-text-faint shrink-0" />
      </button>

      {/* Network cards */}
      <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
        {AD_NETWORKS.map((net) => {
          const wired = Boolean(net.kind);
          return (
            <button
              key={net.key}
              onClick={() => setView(wired ? { page: 'meta' } : { page: 'stub', key: net.key })}
              className="flex items-center justify-between gap-3 rounded-xl border border-border-default bg-bg-card p-4 text-left cursor-pointer hover:bg-bg-hover/40 transition-colors"
            >
              <div className="flex items-center gap-3 min-w-0">
                <GatewayLogo name={net.name} accent={net.accent} size="sm" />
                <div className="min-w-0">
                  <div className="flex items-center gap-2">
                    <span className="text-sm font-semibold text-text-primary truncate">{net.name}</span>
                    <ModeTag tag={net.tag} />
                  </div>
                  <div className="text-xs text-text-muted truncate">{net.method}</div>
                  <div className="mt-1.5">
                    <ConnChip state={wired ? metaChip : 'not_connected'} />
                  </div>
                </div>
              </div>
              <ChevronRight className="w-4 h-4 text-text-faint shrink-0" />
            </button>
          );
        })}
      </div>
    </div>
  );
}
