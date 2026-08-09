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
// header of server/src/routes/funnelCommerce.js. The copy below says so rather
// than implying a protection that does not exist.
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { RefreshCw, Plus, Trash2, X, Check, Search, Globe, Info, AlertTriangle } from 'lucide-react';
import api from '../../../services/api';
import Button from '../../ui/Button';
import { SettingsCard, Toggle } from './ui';
import { isObj, saveFunnelPatch } from './settingsPatch';
import { makeSerialQueue } from './serialQueue';

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

const readCommerce = (funnel) => {
  const st = isObj(funnel?.settings) ? funnel.settings : {};
  const c = isObj(st.commerce) ? st.commerce : {};
  return {
    mode: c.shipping_mode === 'manual' ? 'manual' : 'shopify',
    restrict: c.restrict_countries === true,
    allowed: Array.isArray(c.allowed_countries) && c.allowed_countries.length
      ? c.allowed_countries.map((x) => String(x).toUpperCase())
      : ['US'], // the reference tool's default selection
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
  const enqueueRef = useRef(makeSerialQueue()); // the funnels PATCH is a whole-object replace

  // Re-seed when the funnel prop changes (modal reopened / parent refreshed).
  useEffect(() => { setState(readCommerce(funnel)); }, [funnel]);

  // ── zones (read-only, live Shopify) ──
  const [zStatus, setZStatus] = useState('idle'); // idle | loading | ok | error
  const [zones, setZones] = useState([]);
  const [uncovered, setUncovered] = useState([]);
  const [zErr, setZErr] = useState('');
  const [zRetryable, setZRetryable] = useState(true);

  const loadZones = useCallback(async () => {
    if (!funnelId) return;
    setZStatus('loading');
    try {
      const res = await api.get(`/funnel-commerce/${funnelId}/shipping/zones`);
      const d = res.data?.data || {};
      setZones(d.zones || []);
      setUncovered(d.uncovered_countries || []);
      setZErr('');
      setZStatus('ok');
    } catch (e) {
      const error = e?.response?.data?.error || {};
      // An outage is NOT "you have no zones" — the empty list is never shown
      // on this path.
      setZones([]);
      setUncovered([]);
      setZErr(ZONE_ERR[error.hint] || ZONE_ERR[error.code] || error.message || 'Could not load your Shopify shipping zones.');
      setZRetryable(error.retryable !== false);
      setZStatus('error');
    }
  }, [funnelId]);

  useEffect(() => {
    if (state.mode === 'shopify' && zStatus === 'idle') loadZones();
  }, [state.mode, zStatus, loadZones]);

  // ── saves ──
  const persist = (build, setBusy, successMsg) => enqueueRef.current(async () => {
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
  });

  const saveShipping = (mode) => persist(
    (c) => ({
      ...c,
      shipping_mode: mode,
      flat_rates: mode === 'manual' ? state.rates : (c.flat_rates || []),
    }),
    setSavingRates,
    mode === 'shopify' ? 'Shipping set to live Shopify rates.' : 'Flat rates saved.'
  );

  const saveCountries = () => persist(
    (c) => ({
      ...c,
      restrict_countries: state.restrict,
      allowed_countries: state.restrict ? state.allowed : (c.allowed_countries || state.allowed),
    }),
    setSavingCC,
    state.restrict
      ? `Checkout limited to ${state.allowed.length} countr${state.allowed.length === 1 ? 'y' : 'ies'}.`
      : 'Checkout open to all countries.'
  );

  const setMode = (mode) => setState((s) => ({ ...s, mode }));
  const toggleCC = (code) => setState((s) => ({
    ...s,
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
        description="Which countries the checkout offers. Off = every supported country. On = only the ones you pick (United States is the default)."
      >
        <div className="flex items-center justify-between gap-4">
          <div>
            <div className="text-sm text-text-primary">Limit checkout to specific countries</div>
            <div className="text-xs text-text-faint max-w-md">
              Saved as funnel configuration. Enforcement in the public checkout is a separate,
              single-writer change — see the note below.
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
                No countries selected — add at least one, or the limit is ignored (a funnel that sells to nobody is never what you meant).
              </p>
            )}
          </div>
        ) : (
          <p className="text-xs text-text-faint">
            The checkout offers every supported country. Turn this on to sell to a specific set only.
          </p>
        )}

        <Button onClick={saveCountries} loading={savingCC}>Save countries</Button>
      </SettingsCard>

      <div className="flex items-start gap-2 rounded-xl border border-border-default bg-bg-elevated/40 px-4 py-3">
        <Info className="w-4 h-4 shrink-0 mt-0.5 text-text-faint" />
        <p className="text-xs text-text-muted leading-relaxed">
          In Shopify mode the checkout offers each buyer the options for THEIR address and
          <span className="text-text-primary"> re-verifies the price server-side before charging</span> —
          nothing shown in a browser is ever trusted as the amount. The overview below is a read-only
          copy of your live Shopify setup; change it in Shopify and it applies here automatically.
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

          {zStatus === 'ok' && zones.length === 0 && (
            <div className="rounded-lg border border-dashed border-border-default px-3 py-6 text-center text-sm text-text-muted">
              No shipping zones configured in Shopify yet — buyers are charged no shipping anywhere.
              Add zones in Shopify shipping settings and refresh.
            </div>
          )}

          {zStatus === 'ok' && uncovered.length > 0 && (
            <p className="text-xs text-amber-400">
              You allow checkout from {uncovered.join(', ')} but no Shopify zone covers{' '}
              {uncovered.length === 1 ? 'it' : 'them'}.
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
                        <span className="shrink-0 text-sm font-medium tabular-nums text-text-primary">
                          {/* A carrier-calculated option has no fixed price —
                              the buyer's address decides it at quote time. */}
                          {r.carrier ? `${r.carrier} (live)` : (Number(r.price) === 0 ? 'FREE' : money(r.price, r.currency))}
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
