// Commerce → SHIPPING. Matches the operator's reference tool:
//   1. Shipping rates      — two-option toggle: Sync from Shopify (recommended)
//                            vs Manual flat rates (an editable per-funnel list)
//   2. Checkout countries  — restrict toggle, country typeahead, chips, Save
//   3. an info note that live Shopify shipping is re-verified server-side
//   4. Your shipping — every country & its options: read-only live Shopify
//                            zones with Refresh + a real loading state
//
// PERSISTENCE — funnels.settings.commerce (JSONB) through the EXISTING funnels
// PATCH, read-merge-write exactly like GeneralSection (settingsPatch.js), every
// write serialized (serialQueue.js) so two saves cannot interleave their
// GET/PATCH and drop one. There is no second writer and no new write endpoint.
//   settings.commerce = {
//     shipping_mode: 'shopify' | 'manual',
//     restrict_countries: bool,
//     allowed_countries: ['US', …],      // ISO 3166-1 alpha-2, upper case
//     flat_rates: [{ id, label, description, cost, default }],
//   }
// The server's reader (services/checkoutCountries.js readCommerceSettings)
// normalizes the same shape defensively.
//
// ⚠️ The country limit is ADMIN CONFIG ONLY today — nothing refuses a checkout
// for an unlisted country yet. The exact enforcement point is documented in the
// header of server/src/routes/funnelCommerce.js. EVERY string in this file that
// touches the country list says "saved" and never "limited"/"blocked": copy
// that asserts a protection which does not exist is worse than no copy, because
// an operator reads it and stops checking.
import { useCallback, useEffect, useMemo, useState } from 'react';
import { RefreshCw, Plus, Trash2, X, Check, Search, Globe, Info, AlertTriangle } from 'lucide-react';
import api from '../../../services/api';
import Button from '../../ui/Button';
import { SettingsCard, Toggle } from './ui';
import { isObj, saveFunnelPatch } from './settingsPatch';

// The full country list, generated at runtime from Intl.DisplayNames over every
// ISO 3166-1 alpha-2 code — so ANY country is searchable without a hardcoded
// name table. Aggregates / pseudo / exceptionally-reserved codes are dropped:
// a buyer who picks one fails at the payment processor, so they must not be
// storable. Falls back to a minimal core set on engines without DisplayNames.
const EXCLUDE = new Set(['EU', 'EZ', 'QO', 'QU', 'UN', 'ZZ', 'XA', 'XB', 'XC', 'AC', 'CP', 'DG', 'EA', 'IC', 'TA', 'UK']);
const COUNTRIES = (() => {
  let dn = null;
  try { dn = new Intl.DisplayNames(['en'], { type: 'region' }); } catch { dn = null; }
  const out = [];
  if (dn) {
    for (let a = 65; a <= 90; a += 1) {
      for (let b = 65; b <= 90; b += 1) {
        const code = String.fromCharCode(a) + String.fromCharCode(b);
        if (EXCLUDE.has(code)) continue;
        let name = null;
        try { name = dn.of(code); } catch { name = null; }
        if (name && name !== code && /^\p{L}/u.test(name)) out.push([code, name]);
      }
    }
  }
  if (!out.length) {
    return [['US', 'United States'], ['GB', 'United Kingdom'], ['CA', 'Canada'],
      ['AU', 'Australia'], ['DE', 'Germany'], ['IN', 'India'], ['BD', 'Bangladesh']];
  }
  out.sort((x, y) => x[1].localeCompare(y[1]));
  return out;
})();
const COUNTRY_NAME = Object.fromEntries(COUNTRIES);

const ZONE_ERR = {
  missing_read_shipping_scope: 'The Shopify token is missing the read_shipping permission — re-install the app with that scope to show this overview. (Checkout rates are unaffected; this is the preview only.)',
  shopify_not_configured: 'Shopify is not configured on this environment — this needs operator attention, retrying will not help.',
  shopify_auth_error: 'Shopify rejected our credentials — the access token is missing, expired or revoked. This needs operator attention; retrying will not help.',
  shopify_unavailable: 'Could not load your Shopify shipping zones right now — try again.',
};

function money(amount, currency) {
  const n = Number(amount);
  if (!Number.isFinite(n)) return '—';
  try {
    return new Intl.NumberFormat(undefined, { style: 'currency', currency: currency || 'USD' }).format(n);
  } catch {
    return `$${n.toFixed(2)}`;
  }
}

// "US, CA, GB +12 more" — the full list always lives in the row's title.
function countryLine(zone) {
  const codes = (zone.countries || []).map((c) => c.code || c.name).filter(Boolean);
  const head = codes.slice(0, 8);
  let line = head.join(', ');
  if (codes.length > head.length) line += ` +${codes.length - head.length} more`;
  if (zone.rest_of_world) line = line ? `${line} · Rest of world` : 'Rest of world';
  return line || '—';
}

// US is a UI STARTING POINT for the picker, never a stored value. Seeding it
// into state and then persisting it wrote a US-only allow-list onto funnels
// whose operator only ever toggled the switch on and off — a selection they
// never made. `seeded` marks it so the save path can tell the two apart.
const readCommerce = (funnel) => {
  const st = isObj(funnel?.settings) ? funnel.settings : {};
  const c = isObj(st.commerce) ? st.commerce : {};
  const stored = Array.isArray(c.allowed_countries)
    ? c.allowed_countries.map((x) => String(x).toUpperCase()).filter(Boolean)
    : [];
  return {
    mode: c.shipping_mode === 'manual' ? 'manual' : 'shopify',
    restrict: c.restrict_countries === true,
    allowed: stored.length ? stored : ['US'],
    seeded: stored.length === 0,
    rates: Array.isArray(c.flat_rates) ? c.flat_rates : [],
  };
};

export default function ShippingSection({ funnel, onFunnelUpdated }) {
  const funnelId = funnel?.id;
  const [state, setState] = useState(() => readCommerce(funnel));
  const [savingRates, setSavingRates] = useState(false);
  const [savingCC, setSavingCC] = useState(false);
  const [err, setErr] = useState('');
  const [note, setNote] = useState('');
  const [ccQuery, setCcQuery] = useState('');

  // Re-seed when the funnel prop changes (modal reopened / parent refreshed).
  useEffect(() => { setState(readCommerce(funnel)); }, [funnel]);

  // ── zones (read-only, live Shopify) ──
  const [zStatus, setZStatus] = useState('idle'); // idle | loading | ok | error
  const [zones, setZones] = useState([]);
  const [uncovered, setUncovered] = useState([]);
  const [zTruncated, setZTruncated] = useState(false);
  const [zErr, setZErr] = useState('');
  const [zRetryable, setZRetryable] = useState(true);

  const loadZones = useCallback(async () => {
    if (!funnelId) return;
    const askedFor = funnelId;
    setZStatus('loading');
    try {
      const res = await api.get(`/funnel-commerce/${askedFor}/shipping/zones`);
      // Discard a response for a funnel we are no longer showing.
      if (askedFor !== funnelId) return;
      const d = res.data?.data || {};
      setZones(d.zones || []);
      setUncovered(d.uncovered_countries || []);
      setZTruncated(d.truncated === true);
      setZErr('');
      setZStatus('ok');
    } catch (e) {
      if (askedFor !== funnelId) return;
      const error = e?.response?.data?.error || {};
      // An outage is NOT "you have no zones" — zStatus 'error' is what gates
      // the empty-state copy, so the empty list below is never rendered as a
      // claim about the store.
      setZones([]);
      setUncovered([]);
      setZTruncated(false);
      setZErr(ZONE_ERR[error.hint] || ZONE_ERR[error.code] || error.message || 'Could not load your Shopify shipping zones.');
      setZRetryable(error.retryable !== false);
      setZStatus('error');
    }
  }, [funnelId]);

  useEffect(() => {
    if (state.mode === 'shopify' && zStatus === 'idle') loadZones();
  }, [state.mode, zStatus, loadZones]);

  // ── saves ──
  // No local queue: saveFunnelPatch runs every settings save through the ONE
  // module-level queue in serialQueue.js, which is what actually stops a save
  // from another SECTION interleaving with this one. Wrapping it in a second
  // copy of that same queue here would deadlock.
  const persist = async (build, setBusy, successMsg) => {
    setBusy(true); setErr(''); setNote('');
    try {
      const updated = await saveFunnelPatch(funnelId, (fresh) => {
        const settings = { ...(isObj(fresh.settings) ? fresh.settings : {}) };
        const commerce = { ...(isObj(settings.commerce) ? settings.commerce : {}) };
        settings.commerce = build(commerce);
        return { settings };
      });
      onFunnelUpdated?.(updated);
      setNote(successMsg);
      setTimeout(() => setNote(''), 3000);
    } catch (e) {
      setErr(e?.response?.data?.error || 'Failed to save');
    } finally {
      setBusy(false);
    }
  };

  const saveShipping = (mode) => persist(
    (c) => ({
      ...c,
      shipping_mode: mode,
      flat_rates: mode === 'manual' ? state.rates : (c.flat_rates || []),
    }),
    setSavingRates,
    mode === 'shopify' ? 'Shipping set to live Shopify rates.' : 'Flat rates saved.'
  );

  const saveCountries = () => {
    const n = state.allowed.length;
    // An empty list with the switch ON is a misconfiguration, not a policy —
    // the server reads it as unrestricted (checkoutCountries.readCommerceSettings).
    // Saying "limited to 0 countries" would describe a state that does not
    // exist on either side.
    const msg = !state.restrict
      ? 'Saved — no country list is applied.'
      : n === 0
        ? 'Saved, but no countries are selected, so no list is applied. Add at least one.'
        : `Saved — ${n} countr${n === 1 ? 'y' : 'ies'} on the list. This is configuration only until checkout enforcement ships.`;
    return persist(
      (c) => ({
        ...c,
        restrict_countries: state.restrict,
        // Never persist the UI's US placeholder. If the switch is off and the
        // operator never picked anything, leave whatever was stored alone.
        allowed_countries: state.restrict
          ? state.allowed
          : (Array.isArray(c.allowed_countries) ? c.allowed_countries : (state.seeded ? [] : state.allowed)),
      }),
      setSavingCC,
      msg
    );
  };

  const setMode = (mode) => setState((s) => ({ ...s, mode }));
  const toggleCC = (code) => setState((s) => ({
    ...s,
    seeded: false, // the operator has now made a real selection
    allowed: s.allowed.includes(code) ? s.allowed.filter((c) => c !== code) : [...s.allowed, code],
  }));
  const setRate = (i, patch) => setState((s) => ({
    ...s, rates: s.rates.map((r, j) => (j === i ? { ...r, ...patch } : r)),
  }));
  const addRate = () => setState((s) => ({
    ...s,
    rates: [...s.rates, { id: `ship_${Date.now()}`, label: '', description: '', cost: 0, default: s.rates.length === 0 }],
  }));
  const removeRate = (i) => setState((s) => ({ ...s, rates: s.rates.filter((_, j) => j !== i) }));
  const makeDefault = (i) => setState((s) => ({ ...s, rates: s.rates.map((r, j) => ({ ...r, default: j === i })) }));

  const suggestions = useMemo(() => {
    const q = ccQuery.trim().toLowerCase();
    if (!q) return [];
    return COUNTRIES
      .filter(([code, name]) => !state.allowed.includes(code)
        && (name.toLowerCase().includes(q) || code.toLowerCase().includes(q)))
      .slice(0, 8);
  }, [ccQuery, state.allowed]);

  if (!funnelId) return <p className="text-sm text-text-muted">No funnel selected.</p>;

  const modeBtn = (value, label) => (
    <button
      key={value}
      type="button"
      onClick={() => setMode(value)}
      aria-pressed={state.mode === value}
      className={`flex-1 px-3 py-1.5 text-sm rounded-md transition-colors cursor-pointer
        ${state.mode === value
    ? 'bg-accent-muted text-accent-text font-medium'
    : 'text-text-muted hover:text-text-primary hover:bg-bg-hover'}`}
    >
      {label}
    </button>
  );

  return (
    <div className="space-y-4">
      <h3 className="text-base font-semibold text-text-primary">Shipping</h3>
      {err && <p className="text-sm text-danger">{err}</p>}
      {note && !err && <p className="text-sm text-success">{note}</p>}

      <SettingsCard
        title="Shipping rates"
        description="How this funnel's checkout prices shipping — synced live from Shopify, or a fixed list of flat rates you manage here."
      >
        <div className="flex gap-1 rounded-lg border border-border-default bg-bg-elevated/60 p-1" role="group" aria-label="Shipping rate mode">
          {modeBtn('shopify', 'Sync from Shopify (recommended)')}
          {modeBtn('manual', 'Manual flat rates')}
        </div>

        {state.mode === 'manual' && (
          <div className="space-y-2 pt-1">
            {state.rates.length === 0 ? (
              <div className="rounded-lg border border-dashed border-border-default px-3 py-5 text-center text-sm text-text-muted">
                No flat rates — the checkout charges no shipping until one is added.
              </div>
            ) : state.rates.map((r, i) => (
              <div key={r.id || i} className="rounded-lg border border-border-default bg-bg-elevated/50 p-3 space-y-2">
                <div className="grid grid-cols-1 sm:grid-cols-[1fr_1fr_110px] gap-2">
                  <input
                    value={r.label ?? ''}
                    onChange={(e) => setRate(i, { label: e.target.value })}
                    placeholder="Standard shipping"
                    className="px-3 py-2 text-sm bg-bg-elevated border border-border-default rounded-lg text-text-primary placeholder:text-text-faint focus:outline-none focus:ring-2 focus:ring-accent/40"
                  />
                  <input
                    value={r.description ?? ''}
                    onChange={(e) => setRate(i, { description: e.target.value })}
                    placeholder="3–5 business days"
                    className="px-3 py-2 text-sm bg-bg-elevated border border-border-default rounded-lg text-text-primary placeholder:text-text-faint focus:outline-none focus:ring-2 focus:ring-accent/40"
                  />
                  <input
                    type="number" min={0} step="0.01"
                    value={r.cost ?? 0}
                    onChange={(e) => setRate(i, { cost: Number(e.target.value) || 0 })}
                    className="px-3 py-2 text-sm tabular-nums bg-bg-elevated border border-border-default rounded-lg text-text-primary focus:outline-none focus:ring-2 focus:ring-accent/40"
                  />
                </div>
                <div className="flex items-center justify-between">
                  <label className="inline-flex items-center gap-1.5 text-xs text-text-faint cursor-pointer">
                    <input
                      type="radio" name="flat-rate-default"
                      checked={!!r.default} onChange={() => makeDefault(i)}
                    />
                    Preselected rate
                  </label>
                  <button
                    type="button"
                    onClick={() => removeRate(i)}
                    className="inline-flex items-center gap-1 text-xs text-text-faint hover:text-danger cursor-pointer"
                  >
                    <Trash2 className="w-3 h-3" /> Remove
                  </button>
                </div>
              </div>
            ))}
            <button
              type="button"
              onClick={addRate}
              className="w-full inline-flex items-center justify-center gap-1.5 py-2 text-sm rounded-lg border border-dashed border-border-default text-text-muted hover:text-text-primary hover:border-border-strong transition-colors cursor-pointer"
            >
              <Plus className="w-3.5 h-3.5" /> Add flat rate
            </button>
          </div>
        )}

        <Button onClick={() => saveShipping(state.mode)} loading={savingRates}>Save shipping</Button>
      </SettingsCard>

      <SettingsCard
        title="Checkout countries"
        description="The country list this funnel is configured with. Saved on the funnel today — the checkout does not consult it yet."
      >
        <div className="flex items-start gap-2 rounded-lg border border-amber-500/25 bg-amber-500/10 px-3 py-2.5">
          <AlertTriangle className="w-4 h-4 shrink-0 mt-0.5 text-amber-400" />
          <p className="text-xs text-amber-400 leading-relaxed">
            <span className="font-semibold">Configuration only, not yet enforced.</span> Saving this list
            records your choice on the funnel. The public checkout still accepts every country until the
            checkout gate ships — do not rely on this to block a market.
          </p>
        </div>

        <div className="flex items-center justify-between gap-4">
          <div>
            <div className="text-sm text-text-primary">Restrict this funnel to specific countries</div>
            <div className="text-xs text-text-faint max-w-md">
              Off means no list is applied. On records the list below.
            </div>
          </div>
          <Toggle checked={state.restrict} onChange={(v) => setState((s) => ({ ...s, restrict: v }))} />
        </div>

        {state.restrict ? (
          <div className="space-y-2">
            <div className="relative">
              <Search className="pointer-events-none absolute left-3 top-1/2 -translate-y-1/2 w-3.5 h-3.5 text-text-faint" />
              <input
                value={ccQuery}
                onChange={(e) => setCcQuery(e.target.value)}
                placeholder="Type a country name or code…"
                className="w-full pl-9 pr-3 py-2 text-sm bg-bg-elevated border border-border-default rounded-lg text-text-primary placeholder:text-text-faint focus:outline-none focus:ring-2 focus:ring-accent/40"
              />
              {ccQuery.trim() && (
                <div className="absolute z-10 mt-1 w-full max-h-56 overflow-y-auto rounded-lg border border-border-default bg-bg-card shadow-xl">
                  {suggestions.length === 0 ? (
                    <p className="px-3 py-2 text-xs text-text-faint">No matches.</p>
                  ) : suggestions.map(([code, name]) => (
                    <button
                      key={code}
                      type="button"
                      onClick={() => { toggleCC(code); setCcQuery(''); }}
                      className="w-full flex items-center gap-2 px-3 py-1.5 text-left text-sm text-text-primary hover:bg-bg-hover cursor-pointer"
                    >
                      <Plus className="w-3.5 h-3.5 shrink-0 text-text-faint" />
                      <span className="min-w-0 flex-1 truncate">{name}</span>
                      <span className="shrink-0 text-xs font-mono text-text-faint">{code}</span>
                    </button>
                  ))}
                </div>
              )}
            </div>

            {state.allowed.length ? (
              <div className="flex flex-wrap gap-1.5">
                {state.allowed.map((code) => (
                  <span
                    key={code}
                    className="inline-flex items-center gap-1.5 pl-2 pr-1 py-1 text-xs rounded-full border border-emerald-500/25 bg-emerald-500/10 text-text-primary"
                  >
                    <Check className="w-3 h-3 text-emerald-400" />
                    <span className="max-w-[160px] truncate">{COUNTRY_NAME[code] || code}</span>
                    <span className="font-mono text-text-faint">{code}</span>
                    <button
                      type="button"
                      onClick={() => toggleCC(code)}
                      aria-label={`Remove ${COUNTRY_NAME[code] || code}`}
                      className="grid place-items-center w-4 h-4 rounded-full text-text-faint hover:text-text-primary hover:bg-bg-hover cursor-pointer"
                    >
                      <X className="w-3 h-3" />
                    </button>
                  </span>
                ))}
              </div>
            ) : (
              <p className="text-xs text-text-faint">
                No countries selected — the switch is on but the list is empty, so no list is applied. Add at least one.
              </p>
            )}
          </div>
        ) : (
          <p className="text-xs text-text-faint">
            No country list is applied to this funnel. Turn this on to record one.
          </p>
        )}

        <Button onClick={saveCountries} loading={savingCC}>Save countries</Button>
      </SettingsCard>

      <div className="flex items-start gap-2 rounded-xl border border-border-default bg-bg-elevated/40 px-4 py-3">
        <Info className="w-4 h-4 shrink-0 mt-0.5 text-text-faint" />
        <p className="text-xs text-text-muted leading-relaxed">
          <span className="text-text-primary">Shipping prices</span> in Shopify mode come from your live
          Shopify setup: the checkout offers each buyer the options for THEIR address and
          <span className="text-text-primary"> re-verifies the price server-side before charging</span> —
          nothing shown in a browser is ever trusted as the amount. That server-side re-verification
          covers PRICES only; it is unrelated to the country list above, which nothing enforces yet.
          The overview below is a read-only copy of your Shopify zones.
        </p>
      </div>

      {state.mode === 'shopify' && (
        <SettingsCard
          title="Your shipping — every country & its options"
          description="Straight from Shopify. What each buyer sees depends on their address."
          actions={(
            <Button variant="secondary" size="sm" onClick={loadZones} loading={zStatus === 'loading'}>
              <RefreshCw className="w-3.5 h-3.5" /> Refresh
            </Button>
          )}
        >
          {zStatus === 'loading' && (
            <div className="rounded-lg border border-dashed border-border-default px-3 py-8 text-center text-sm text-text-muted">
              Loading your Shopify zones…
            </div>
          )}

          {zStatus === 'error' && (
            <div className="flex items-start justify-between gap-3 rounded-lg border border-amber-500/25 bg-amber-500/10 px-3 py-2.5">
              <span className="flex items-start gap-2 text-sm text-amber-400">
                <AlertTriangle className="w-4 h-4 shrink-0 mt-0.5" /> {zErr}
              </span>
              {zRetryable && (
                <Button variant="secondary" size="sm" onClick={loadZones}>
                  <RefreshCw className="w-3.5 h-3.5" /> Retry
                </Button>
              )}
            </div>
          )}

          {/* Only claimable on a COMPLETE read. zStatus 'ok' means the fetch
              succeeded, and `truncated` means we did not see every page — an
              empty list under either doubt is not evidence about the store. */}
          {zStatus === 'ok' && zones.length === 0 && !zTruncated && (
            <div className="rounded-lg border border-dashed border-border-default px-3 py-6 text-center text-sm text-text-muted">
              Shopify returned no shipping zones for this store. Add zones in Shopify shipping settings
              and refresh.
            </div>
          )}

          {zStatus === 'ok' && zTruncated && (
            <p className="flex items-start gap-2 text-xs text-amber-400">
              <AlertTriangle className="w-3.5 h-3.5 shrink-0 mt-0.5" />
              Partial view — Shopify paginates zones across several delivery profiles and this query can
              only advance one at a time, so some zones are not shown. Coverage warnings are suppressed
              because an unseen zone could cover the country.
            </p>
          )}

          {zStatus === 'ok' && !zTruncated && uncovered.length > 0 && (
            <p className="flex items-start gap-2 text-xs text-amber-400">
              <AlertTriangle className="w-3.5 h-3.5 shrink-0 mt-0.5" />
              {uncovered.join(', ')} {uncovered.length === 1 ? 'is' : 'are'} on this funnel&apos;s country
              list, but no Shopify zone offers a shipping option there — a buyer from{' '}
              {uncovered.length === 1 ? 'that country' : 'those countries'} cannot complete checkout.
            </p>
          )}

          {zStatus === 'ok' && zones.length > 0 && (
            <div className="space-y-2 max-h-96 overflow-y-auto pr-1">
              {zones.map((z, i) => (
                <div key={`${z.zone}-${i}`} className="rounded-lg border border-border-default bg-bg-elevated/50">
                  <div
                    className="flex items-baseline justify-between gap-3 px-3 py-2 border-b border-border-subtle"
                    title={(z.countries || []).map((c) => c.name || c.code).join(', ')}
                  >
                    <span className="inline-flex min-w-0 items-center gap-1.5 truncate text-sm font-medium text-text-primary">
                      <Globe className="w-3.5 h-3.5 shrink-0 text-text-faint" />
                      {z.zone || countryLine(z)}
                    </span>
                    <span className="shrink-0 text-xs font-mono text-text-faint">{countryLine(z)}</span>
                  </div>
                  <div className="px-3 py-1.5">
                    {(z.rates || []).length === 0 ? (
                      <p className="py-1 text-xs text-text-faint">No rate options in this zone.</p>
                    ) : z.rates.map((r, j) => (
                      <div key={`${r.name}-${j}`} className="flex items-center justify-between gap-3 py-1">
                        <span className="min-w-0 truncate text-sm text-text-muted">
                          {r.name}
                          {r.conditions?.length ? (
                            <span className="ml-1.5 text-xs text-text-faint">({r.conditions.join('; ')})</span>
                          ) : null}
                        </span>
                        <span className={`shrink-0 text-sm font-medium tabular-nums ${
                          !r.carrier && r.price == null ? 'text-amber-400' : 'text-text-primary'}`}
                        >
                          {/* Order matters. A carrier-calculated option has no
                              fixed price (the buyer's address decides it). A
                              NULL price on a non-carrier option means Shopify
                              did not give us an amount — `Number(null) === 0`
                              used to render that as FREE, i.e. it advertised a
                              shipping charge we do not know as no charge. */}
                          {r.carrier
                            ? `${r.carrier} (live)`
                            : r.price == null
                              ? 'Price unavailable'
                              : r.price === 0
                                ? 'FREE'
                                : money(r.price, r.currency)}
                        </span>
                      </div>
                    ))}
                  </div>
                </div>
              ))}
            </div>
          )}
        </SettingsCard>
      )}
    </div>
  );
}
