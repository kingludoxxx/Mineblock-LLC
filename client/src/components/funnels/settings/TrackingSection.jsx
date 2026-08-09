// Tracking — the funnel's ad-network directory, shaped to the operator's
// reference tool (network grid → network detail), wired to the tracking lane's
// authed admin surfaces:
//
//   routes/trackingAdmin.js        (/api/v1/tracking-admin) named-network
//                                  registry CRUD + per-kind delivery summary
//   routes/trackingIntegrations.js (same base) the card-grid DIRECTORY, custom
//                                  S2S postback templates, and the tokenized
//                                  inbound postback endpoints
//
// THE DIRECTORY IS SERVER-OWNED. Card names, methods, click-id params, setup
// prose, the per-network AD-URL macro sets and the postback PRESETS all come
// from services/trackingNetworkDirectory.js on the server. This file used to
// carry a second, hand-maintained copy of that list; it does not any more,
// because the two drifted the moment either changed and a card claiming a
// click-id param the vault does not capture is worse than no card.
//
// HONESTY RULES (every one of them is a rule the reference tool breaks):
//   • a card's state comes from real server truth or it reads "Checking…" /
//     "Status unknown" — never a confident "Not connected" off a failed read;
//   • `wired` decides what the detail page offers. Only meta_pixel and ga4
//     have delivery adapters; five more connect through the generic custom-S2S
//     engine via a preset; the rest say plainly that nothing is sent;
//   • a GENERAL flag that nothing consumes yet says so under the checkbox.
//
// PERSISTENCE:
//   Network credentials/mode  → PUT /tracking-admin/:funnelId/networks/:kind
//     (secrets are write-only: '' keeps the stored value, null clears it —
//      the server never echoes one back in any state)
//   GENERAL event options     → funnels.settings.tracking (JSONB) via the
//     existing funnels PATCH, read-merge-write like the sibling sections.
import { useCallback, useEffect, useRef, useState } from 'react';
import { ChevronRight } from 'lucide-react';
import api from '../../../services/api';
import { GatewayLogo } from './ui';
import { isObj, saveFunnelPatch } from './settingsPatch';
import { makeSerialQueue } from './serialQueue';
import { ConnChip, StatusDot, ModeTag, CheckboxRow } from './trackingUi';
import { errOf, servingBase } from './trackingConstants';
import TrackingNetworkDetail from './TrackingNetworkDetail';
import {
  CustomNetworksDetail, InboundEndpointsDetail, IntegrationCard,
} from './TrackingIntegrations';

// ── GENERAL panel — event options persisted to settings.tracking ────────────
// Optimistic: the checkbox flips immediately, the PATCH runs read-merge-write
// (saveFunnelPatch), and a failure reverts the flip + shows inline prose.
//
// CONCURRENCY (review MAJOR F3): the funnels PATCH is a whole-object replace,
// so two overlapping saves can interleave GET/PATCH and silently drop one
// flip. Saves therefore run through ONE promise chain (each save's fresh GET
// happens only after the previous PATCH committed), every control is disabled
// while any save is in flight, and a failure reverts against a ref of the
// last SERVER-CONFIRMED state — never a render-closure snapshot.
//
// send_external_id DEFAULTS TO TRUE, and that is a deliberate correction. The
// server has always sent a hashed external_id on Purchase; a default of false
// here would have shown an unchecked box next to behaviour that was happening
// anyway. The delivery layer now reads this flag (trackingService.trackingFlags)
// as `!== false`, so the box and the wire agree in both positions and a failed
// settings read keeps today's behaviour rather than silently degrading match
// quality.
const GENERAL_DEFAULTS = {
  fire_purchase: 'checkout_server',
  send_external_id: true,
  fire_addtocart_checkout: false,
  fire_viewcontent_lead: false,
  unique_txn_per_upsell: true,
};

// What each flag ACTUALLY does today. A flag with no consumer must say so
// where the operator is looking — a persisted checkbox that changes nothing is
// the most expensive kind of lie in a tracking panel.
const GENERAL_NOTES = {
  send_external_id: 'Live — the hashed session id is sent as external_id on server Purchase events. Unchecking it stops that on the next conversion.',
  fire_addtocart_checkout: 'Saved, not yet wired — AddToCart is emitted by the page runtime, not the server, so this flag has no consumer until the checkout beacon lands. Nothing changes when you tick it.',
  fire_viewcontent_lead: 'Saved, not yet wired — same reason: ViewContent comes from the browser beacon, which does not read this flag yet.',
  unique_txn_per_upsell: 'Always on — an accepted upsell always fires as its own conversion with its own transaction id (pur_<session>_u_<charge>). This cannot currently be turned off.',
};

function GeneralPanel({ funnel, onFunnelUpdated }) {
  const stored = () => {
    const st = isObj(funnel?.settings) ? funnel.settings : {};
    const tr = isObj(st.tracking) ? st.tracking : {};
    return { ...GENERAL_DEFAULTS, ...tr };
  };
  const [vals, setVals] = useState(stored);
  const [err, setErr] = useState('');
  const [busy, setBusy] = useState(false);
  const confirmedRef = useRef(vals);            // last server-confirmed tracking state
  // Serializes THIS panel's optimistic flips + their pendingRef bookkeeping.
  // Cross-SECTION ordering is saveFunnelPatch's job (it runs every settings
  // save through one module-level queue). Two distinct queue instances, so
  // nesting them cannot deadlock.
  const enqueueRef = useRef(makeSerialQueue());
  const pendingRef = useRef(0);

  useEffect(() => {
    // Reseed from the funnel prop only when no save is in flight — a mid-queue
    // reseed would wipe a queued optimistic flip with a stale server echo.
    if (pendingRef.current === 0) {
      const s = stored();
      setVals(s);
      confirmedRef.current = s;
    }
  }, [funnel]); // eslint-disable-line react-hooks/exhaustive-deps

  const saveKey = (key, value) => {
    setVals((v) => ({ ...v, [key]: value })); // optimistic flip
    setErr('');
    pendingRef.current += 1;
    setBusy(true);
    enqueueRef.current(async () => {
      try {
        const updated = await saveFunnelPatch(funnel.id, (fresh) => {
          const settings = { ...(isObj(fresh.settings) ? fresh.settings : {}) };
          settings.tracking = { ...(isObj(settings.tracking) ? settings.tracking : {}), [key]: value };
          return { settings };
        });
        // Confirm from the server's echo, not our own draft.
        const echo = isObj(updated?.settings) && isObj(updated.settings.tracking) ? updated.settings.tracking : {};
        confirmedRef.current = { ...GENERAL_DEFAULTS, ...echo };
        onFunnelUpdated?.(updated);
      } catch (e) {
        setVals({ ...confirmedRef.current }); // revert to last confirmed server state
        setErr(e.response?.data?.error || 'Failed to save — the change was reverted');
      } finally {
        pendingRef.current -= 1;
        if (pendingRef.current === 0) setBusy(false);
      }
    });
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
          disabled={busy}
          onChange={(e) => saveKey('fire_purchase', e.target.value)}
          className="px-3 py-2 text-sm bg-bg-elevated border border-border-default rounded-lg text-text-primary focus:outline-none focus:ring-2 focus:ring-accent/40 focus:border-accent cursor-pointer disabled:opacity-60 disabled:cursor-not-allowed"
        >
          <option value="checkout_server">right after checkout (server)</option>
        </select>
        {busy && <span className="text-xs text-text-faint">Saving…</span>}
      </div>
      <p className="text-xs text-text-faint">
        Purchase is owned exclusively by the settlement webhook — a paid session fires it once, with a
        deterministic event id. There is no browser-fired alternative, by design: a client-mintable
        money event would let anyone with a funnel id inject conversions.
      </p>
      <div className="space-y-2.5 pt-1">
        <CheckboxRow label="Send hashed external id" checked={vals.send_external_id === true}
          disabled={busy} note={GENERAL_NOTES.send_external_id}
          onChange={(v) => saveKey('send_external_id', v)} />
        <CheckboxRow label="Fire AddToCart at checkout" checked={vals.fire_addtocart_checkout === true}
          disabled={busy} note={GENERAL_NOTES.fire_addtocart_checkout}
          onChange={(v) => saveKey('fire_addtocart_checkout', v)} />
        <CheckboxRow label="Fire ViewContent on lead" checked={vals.fire_viewcontent_lead === true}
          disabled={busy} note={GENERAL_NOTES.fire_viewcontent_lead}
          onChange={(v) => saveKey('fire_viewcontent_lead', v)} />
        <CheckboxRow label="Unique txn id per upsell" checked disabled
          note={GENERAL_NOTES.unique_txn_per_upsell} onChange={() => {}} />
      </div>
      {err && <p className="text-sm text-danger">{err}</p>}
    </div>
  );
}

// ── the directory ───────────────────────────────────────────────────────────
export default function TrackingSection({ funnel, onFunnelUpdated }) {
  const [view, setView] = useState({ page: 'directory' });
  const [dir, setDir] = useState(null);        // null=loading, 'error', or {}
  const [networks, setNetworks] = useState(null); // registry rows (meta/ga4/google_ads)
  const [summary, setSummary] = useState(null);
  const [customs, setCustoms] = useState(null);   // custom S2S networks
  const [customHealth, setCustomHealth] = useState([]);
  const [inbound, setInbound] = useState(null);
  const [loadErr, setLoadErr] = useState('');
  const [presetErr, setPresetErr] = useState('');

  const load = useCallback(async () => {
    try {
      const [dRes, nRes, sRes] = await Promise.all([
        api.get(`/tracking-admin/${encodeURIComponent(funnel.id)}/directory`),
        api.get(`/tracking-admin/${encodeURIComponent(funnel.id)}/networks`),
        api.get(`/tracking-admin/${encodeURIComponent(funnel.id)}/tracking/summary`),
      ]);
      const d = dRes.data?.data;
      const nets = nRes.data?.data?.networks;
      const sums = sRes.data?.data?.networks;
      // A 200 with a malformed body is the ERROR path — never coerce it to []
      // and paint a confident NOT CONNECTED chip off garbage.
      if (!d || !Array.isArray(d.networks) || !Array.isArray(nets) || !Array.isArray(sums)) {
        throw new Error('malformed_tracking_response');
      }
      setDir(d); setNetworks(nets); setSummary(sums);
      setLoadErr('');
    } catch (e) {
      setDir((prev) => (prev && prev.networks ? prev : 'error'));
      setNetworks((prev) => (Array.isArray(prev) ? prev : 'error'));
      setSummary((prev) => (Array.isArray(prev) ? prev : 'error'));
      setLoadErr(e.response?.status === 404
        ? 'Tracking endpoints are not available on this server yet (tracking lane not deployed).'
        : errOf(e, 'Failed to load tracking status'));
    }
  }, [funnel.id]);

  // The integrations reads are SEPARATE from the load above on purpose: they
  // are newer endpoints, and a server that predates them must still render the
  // whole directory. A failure here degrades those two cards, nothing else.
  const loadIntegrations = useCallback(async () => {
    try {
      const [c, h, i] = await Promise.all([
        api.get(`/tracking-admin/${encodeURIComponent(funnel.id)}/custom-networks`),
        api.get(`/tracking-admin/${encodeURIComponent(funnel.id)}/custom-networks/health`),
        api.get(`/tracking-admin/${encodeURIComponent(funnel.id)}/inbound-endpoints`),
      ]);
      setCustoms(Array.isArray(c.data?.data?.networks) ? c.data.data.networks : 'error');
      setCustomHealth(Array.isArray(h.data?.data?.health) ? h.data.data.health : []);
      setInbound(Array.isArray(i.data?.data?.endpoints) ? i.data.data.endpoints : 'error');
    } catch {
      setCustoms((prev) => (Array.isArray(prev) ? prev : 'error'));
      setInbound((prev) => (Array.isArray(prev) ? prev : 'error'));
    }
  }, [funnel.id]);

  useEffect(() => { load(); loadIntegrations(); }, [load, loadIntegrations]);

  const cards = dir && dir !== 'error' && Array.isArray(dir.networks) ? dir.networks : [];
  const base = servingBase(funnel, dir && dir !== 'error' ? dir.serving_base : '');

  const registryOf = (kind) => (Array.isArray(networks) ? networks.find((n) => n.kind === kind) : undefined);
  const summaryOf = (kind) => (Array.isArray(summary) ? summary.find((n) => n.kind === kind) : undefined);
  // A preset card is "connected" through the custom network its preset creates.
  // The key comes from the SERVER (directory.preset_network_key, sluggified
  // from the preset label by the same function the create path uses) — deriving
  // it here would be a second copy of the slug rule, and the two would drift.
  const customOf = (card) => {
    if (!Array.isArray(customs) || !card.preset_network_key) return undefined;
    return customs.find((c) => c.key === card.preset_network_key);
  };
  const customHealthOf = (card) => {
    const c = customOf(card);
    if (!c) return undefined;
    return customHealth.find((h) => h.id === c.id) || null;
  };

  // The card chip, from real server truth only.
  const chipFor = (card) => {
    if (card.wired === 'server') {
      if (summary === null) return 'checking';
      if (summary === 'error') return 'unknown';
      return summaryOf(card.kind)?.server_channel_ready ? 'connected' : 'not_connected';
    }
    if (card.wired === 'preset') {
      if (customs === null) return 'checking';
      if (customs === 'error') return 'unknown';
      const c = customOf(card);
      return c && c.enabled ? 'connected' : 'not_connected';
    }
    return 'not_connected';
  };

  const createPreset = async (key) => {
    setPresetErr('');
    try {
      const res = await api.post(`/tracking-admin/${encodeURIComponent(funnel.id)}/custom-networks/preset/${encodeURIComponent(key)}`);
      await loadIntegrations();
      const id = res.data?.data?.network?.id;
      if (id) setView({ page: 'custom', id });
    } catch (e) {
      setPresetErr(errOf(e, 'Could not create this network from the preset'));
    }
  };

  // ── detail routes ─────────────────────────────────────────────────────────
  if (view.page === 'network') {
    const card = cards.find((c) => c.key === view.key);
    if (card) {
      const adUrl = card.ad_url_params && base
        ? `${base}${base.includes('?') ? '&' : '?'}${card.ad_url_params}`
        : '';
      return (
        <TrackingNetworkDetail
          funnel={funnel}
          card={card}
          network={registryOf(card.kind)}
          // undefined = still loading, null = load failed, object = data
          summary={summary === null ? undefined : (summary === 'error' ? null : summaryOf(card.kind))}
          customNetwork={customOf(card)}
          customHealth={customs === null ? undefined : (customs === 'error' ? null : customHealthOf(card))}
          adUrl={adUrl}
          onBack={() => setView({ page: 'directory' })}
          onSaved={() => { load(); loadIntegrations(); }}
          onOpenCustom={(id) => setView({ page: 'custom', id })}
          onCreatePreset={createPreset}
        />
      );
    }
  }
  if (view.page === 'foundation') {
    const f = dir && dir !== 'error' ? dir.foundation : null;
    const ga4Card = f?.members?.find((m) => m.kind === 'ga4');
    if (ga4Card) {
      return (
        <TrackingNetworkDetail
          funnel={funnel}
          card={{ ...ga4Card, accent: f.accent, click_ids: [], ad_url_params: '' }}
          network={registryOf('ga4')}
          summary={summary === null ? undefined : (summary === 'error' ? null : summaryOf('ga4'))}
          adUrl=""
          onBack={() => setView({ page: 'directory' })}
          onSaved={load}
        />
      );
    }
  }
  if (view.page === 'custom') {
    return (
      <CustomNetworksDetail
        funnel={funnel}
        macros={dir !== 'error' ? dir?.macros : []}
        events={dir !== 'error' ? dir?.custom_events : []}
        focusId={view.id}
        onBack={() => setView({ page: 'directory' })}
        onChanged={loadIntegrations}
      />
    );
  }
  if (view.page === 'inbound') {
    return (
      <InboundEndpointsDetail
        funnel={funnel}
        allowedEvents={dir !== 'error' ? dir?.inbound_events : []}
        onBack={() => setView({ page: 'directory' })}
      />
    );
  }

  const customCount = Array.isArray(customs) ? customs.length : null;
  const inboundCount = Array.isArray(inbound) ? inbound.length : null;

  return (
    <div className="space-y-5">
      <div>
        <h3 className="text-base font-semibold text-text-primary">Tracking</h3>
        <p className="mt-1 text-sm text-text-muted max-w-2xl">
          Every ad network in one place. Click a network to set its credentials, tracking mode
          (Server only, or Server + Browser for pixel platforms) and attribution — postback-first,
          server-to-server. This directory shows what&apos;s connected and whether deliveries flow.
        </p>
      </div>

      {loadErr && (
        <div className="flex items-center justify-between gap-3 px-3 py-2 rounded-lg border border-amber-500/20 bg-amber-500/10 text-xs text-amber-400">
          <span>{loadErr}</span>
          <button onClick={load} className="underline cursor-pointer shrink-0">Retry</button>
        </div>
      )}
      {presetErr && <p className="text-sm text-danger">{presetErr}</p>}

      <GeneralPanel funnel={funnel} onFunnelUpdated={onFunnelUpdated} />

      {/* GTM — recommended base layer, full width */}
      {dir && dir !== 'error' && dir.foundation && (
        <button
          onClick={() => setView({ page: 'foundation' })}
          className="w-full flex items-center justify-between gap-3 rounded-xl border border-accent/20 bg-bg-card p-4 text-left cursor-pointer hover:bg-bg-hover/40 transition-colors"
        >
          <div className="flex items-center gap-3 min-w-0">
            <GatewayLogo name="GTM" accent={dir.foundation.accent} />
            <div className="min-w-0">
              <div className="flex items-center gap-2 flex-wrap">
                <span className="text-sm font-semibold text-text-primary">
                  {dir.foundation.name} — {dir.foundation.sublabel}
                </span>
                <span className="inline-flex items-center px-2 py-0.5 text-[10px] font-semibold uppercase tracking-wide rounded-full border border-accent/20 bg-accent-muted text-accent-text shrink-0">
                  {dir.foundation.badge}
                </span>
              </div>
              <div className="mt-1 flex items-center gap-2 text-xs text-text-muted">
                <StatusDot state={summaryOf('ga4')?.server_channel_ready ? 'connected' : 'not_connected'} />
                GA4 Measurement Protocol is wired · the GTM container ships with the tag-manager phase
              </div>
            </div>
          </div>
          <ChevronRight className="w-4 h-4 text-text-faint shrink-0" />
        </button>
      )}

      {/* Network cards */}
      <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
        {cards.map((card) => {
          const chip = chipFor(card);
          // A card whose detail page opens a credential form seeded from
          // /networks stays unclickable until that read RESOLVED to real data,
          // so a form can never seed empty off a pending/failed read and then
          // clear stored config on save.
          const blocked = card.wired === 'server' && !Array.isArray(networks);
          return (
            <button
              key={card.key}
              disabled={blocked}
              title={blocked ? 'Waiting for the network config to load…' : undefined}
              onClick={() => setView({ page: 'network', key: card.key })}
              className="flex items-center justify-between gap-3 rounded-xl border border-border-default bg-bg-card p-4 text-left cursor-pointer hover:bg-bg-hover/40 transition-colors disabled:opacity-60 disabled:cursor-not-allowed"
            >
              <div className="flex items-center gap-3 min-w-0">
                <GatewayLogo name={card.name} accent={card.accent} size="sm" />
                <div className="min-w-0">
                  <div className="flex items-center gap-2">
                    <span className="text-sm font-semibold text-text-primary truncate">{card.name}</span>
                    <ModeTag tag={card.tag} />
                  </div>
                  <div className="text-xs text-text-muted truncate">{card.method}</div>
                  <div className="mt-1.5 flex items-center gap-2">
                    <StatusDot state={chip} />
                    <ConnChip state={chip} />
                  </div>
                </div>
              </div>
              <ChevronRight className="w-4 h-4 text-text-faint shrink-0" />
            </button>
          );
        })}
      </div>

      {/* The two generic integration surfaces */}
      <div className="space-y-3">
        <IntegrationCard
          accent="#22C55E"
          title="Custom S2S networks"
          subtitle="Outbound postback templates — wire any tracker that takes a click-id postback"
          meta={customCount === null
            ? 'Loading…'
            : customs === 'error'
              ? 'Status unknown — the read failed'
              : `${customCount} configured${customCount ? ` · ${customs.filter((c) => c.enabled).length} enabled` : ''}`}
          onClick={() => setView({ page: 'custom' })}
        />
        <IntegrationCard
          accent="#A78BFA"
          title="Inbound postbacks"
          subtitle="Tokenized URLs networks and partners post conversions back into"
          meta={inboundCount === null
            ? 'Loading…'
            : inbound === 'error'
              ? 'Status unknown — the read failed'
              : `${inboundCount} endpoint${inboundCount === 1 ? '' : 's'}`}
          onClick={() => setView({ page: 'inbound' })}
        />
      </div>

      {dir && dir !== 'error' && dir.sub_convention && (
        <p className="text-xs text-text-faint max-w-2xl">
          Sub-id convention across every network — {dir.sub_convention}.
        </p>
      )}
    </div>
  );
}
