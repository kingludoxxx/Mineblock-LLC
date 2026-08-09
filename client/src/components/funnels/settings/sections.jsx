// Non-payment sections of the Funnel Settings modal. Wired where a backend
// already exists (General, Fonts, Scripts, Redirects, Health); clean scaffolds
// otherwise — no fake data. Tracking panels carry a documented API shape to
// reconcile with the tracking lane at merge.
//
// PERSISTENCE MAP (DECISION MADE — see funnels PATCH):
//   name / slug / status            → funnels columns (existing)
//   Title / SEO description / OG image / Favicon → funnels.seo jsonb
//     (site_title / site_description / og_image / favicon — these are the
//      exact keys renderPageHtml already reads for every page of the funnel)
//   Logo, Description, Brand colors, Checkout enhancements, Fonts,
//   funnel-level Scripts               → funnels.settings jsonb (new column)
// Every save is read-merge-write: it re-GETs the funnel first so a save from
// one section never clobbers keys another section (or another operator tab)
// wrote in the meantime.
import { useCallback, useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { ExternalLink, RefreshCw, Globe, CheckCircle2, AlertTriangle } from 'lucide-react';
import api from '../../../services/api';
import Button from '../../ui/Button';
import Input from '../../ui/Input';
import { GATEWAY_META } from './gatewayMeta';
import { StatusPill, ScaffoldPanel, Toggle } from './ui';

const isObj = (v) => v != null && typeof v === 'object' && !Array.isArray(v);

// Fetch the freshest funnel row, merge, PATCH. `build(fresh)` returns the
// PATCH body. Returns the updated funnel row.
async function saveFunnelPatch(funnelId, build) {
  const res = await api.get(`/funnels/${funnelId}`);
  const fresh = res.data?.data?.funnel || {};
  const body = build(fresh);
  const patched = await api.patch(`/funnels/${funnelId}`, body);
  return patched.data?.data || null;
}

// Set key to a trimmed string, or delete it when empty — keeps the stored
// blobs free of dangling '' keys.
function setOrDelete(obj, key, value) {
  const v = typeof value === 'string' ? value.trim() : value;
  if (v === '' || v === undefined || v === null) delete obj[key];
  else obj[key] = v;
}

function SectionSaveBar({ onSave, saving, dirty, saved, err }) {
  return (
    <div className="space-y-2">
      {err && <p className="text-sm text-danger">{err}</p>}
      <div className="flex items-center gap-3">
        <Button onClick={onSave} loading={saving} disabled={!dirty}>Save changes</Button>
        {saved && <span className="text-sm text-success">Saved</span>}
        {dirty && !saved && <span className="text-xs text-text-faint">Unsaved changes</span>}
      </div>
    </div>
  );
}

// Swatch + hex text pair (e.g. #21a05f). The swatch needs a valid #rrggbb; an
// incomplete hex falls back to black for the swatch only — the typed text is
// what persists (server-side render validates the hex again before emitting).
function ColorInput({ label, value, onChange }) {
  const swatch = /^#[0-9a-fA-F]{6}$/.test(value) ? value : '#000000';
  return (
    <div className="space-y-1.5">
      <label className="block text-sm font-medium text-text-muted">{label}</label>
      <div className="flex items-center gap-2">
        <input
          type="color"
          value={swatch}
          onChange={(e) => onChange(e.target.value)}
          className="w-9 h-9 p-0.5 rounded-lg border border-border-default bg-bg-elevated cursor-pointer"
        />
        <input
          value={value}
          onChange={(e) => onChange(e.target.value)}
          placeholder="#21a05f"
          spellCheck={false}
          className="w-28 px-3 py-2 text-sm bg-bg-elevated border border-border-default rounded-lg text-text-primary font-mono focus:outline-none focus:ring-2 focus:ring-accent/40 focus:border-accent"
        />
      </div>
    </div>
  );
}

function ToggleRow({ label, hint, checked, onChange, disabled = false }) {
  return (
    <div className="flex items-center justify-between gap-4">
      <div className={disabled ? 'opacity-60' : ''}>
        <div className="text-sm text-text-primary">{label}</div>
        {hint && <div className="text-xs text-text-faint max-w-md">{hint}</div>}
      </div>
      <Toggle checked={checked} onChange={onChange} disabled={disabled} />
    </div>
  );
}

// ── GENERAL — identity, SEO surface, brand colors, checkout enhancements ────
export function GeneralSection({ funnel, onFunnelUpdated }) {
  const seo0 = isObj(funnel?.seo) ? funnel.seo : {};
  const st0 = isObj(funnel?.settings) ? funnel.settings : {};
  const co0 = isObj(st0.checkout) ? st0.checkout : {};
  const bc0 = isObj(st0.brand_colors) ? st0.brand_colors : {};

  const init = () => ({
    name: funnel?.name || '',
    slug: funnel?.slug || '',
    status: funnel?.status || 'draft',
    title: seo0.site_title || '',
    seoDescription: seo0.site_description || '',
    ogImage: seo0.og_image || '',
    favicon: seo0.favicon || '',
    logoUrl: st0.logo_url || '',
    description: st0.description || '',
    brandPrimary: bc0.primary || '',
    brandSecondary: bc0.secondary || '',
    addrAutocomplete: co0.address_autocomplete === true,
    mapsKey: co0.maps_api_key || '',
    intlPhone: co0.intl_phone === true,
  });

  const [form, setForm] = useState(init);
  const [saving, setSaving] = useState(false);
  const [err, setErr] = useState('');
  const [saved, setSaved] = useState(false);

  // Re-seed when the funnel prop changes (modal reopened / parent refreshed).
  useEffect(() => { setForm(init()); }, [funnel]); // eslint-disable-line react-hooks/exhaustive-deps

  const set = (k) => (v) => setForm((f) => ({ ...f, [k]: v }));
  const setE = (k) => (e) => setForm((f) => ({ ...f, [k]: e.target.value }));
  const dirty = JSON.stringify(form) !== JSON.stringify(init());

  const save = async () => {
    setSaving(true); setErr('');
    try {
      const updated = await saveFunnelPatch(funnel.id, (fresh) => {
        const seo = { ...(isObj(fresh.seo) ? fresh.seo : {}) };
        setOrDelete(seo, 'site_title', form.title);
        setOrDelete(seo, 'site_description', form.seoDescription);
        setOrDelete(seo, 'og_image', form.ogImage);
        setOrDelete(seo, 'favicon', form.favicon);
        const settings = { ...(isObj(fresh.settings) ? fresh.settings : {}) };
        setOrDelete(settings, 'logo_url', form.logoUrl);
        setOrDelete(settings, 'description', form.description);
        const brand = { ...(isObj(settings.brand_colors) ? settings.brand_colors : {}) };
        setOrDelete(brand, 'primary', form.brandPrimary);
        setOrDelete(brand, 'secondary', form.brandSecondary);
        if (Object.keys(brand).length) settings.brand_colors = brand; else delete settings.brand_colors;
        const checkout = { ...(isObj(settings.checkout) ? settings.checkout : {}) };
        checkout.address_autocomplete = form.addrAutocomplete === true;
        setOrDelete(checkout, 'maps_api_key', form.mapsKey);
        checkout.intl_phone = form.intlPhone === true;
        settings.checkout = checkout;
        return { name: form.name.trim(), slug: form.slug.trim(), status: form.status, seo, settings };
      });
      onFunnelUpdated?.(updated);
      setSaved(true); setTimeout(() => setSaved(false), 2000);
    } catch (e) {
      setErr(e.response?.data?.error || 'Failed to save');
    } finally { setSaving(false); }
  };

  return (
    <div className="space-y-5 max-w-lg">
      <h3 className="text-base font-semibold text-text-primary">General</h3>

      <Input label="Funnel name" value={form.name} onChange={setE('name')} />
      <div className="space-y-1.5">
        <label className="block text-sm font-medium text-text-muted">Slug</label>
        <div className="flex items-center gap-2">
          <span className="text-sm text-text-faint font-mono">/f/</span>
          <input
            value={form.slug}
            onChange={setE('slug')}
            className="flex-1 px-3 py-2 text-sm bg-bg-elevated border border-border-default rounded-lg text-text-primary font-mono focus:outline-none focus:ring-2 focus:ring-accent/40 focus:border-accent"
          />
        </div>
        <p className="text-xs text-text-faint">Lowercase letters, numbers and dashes.</p>
      </div>
      <div className="space-y-1.5">
        <label className="block text-sm font-medium text-text-muted">Status</label>
        <select
          value={form.status}
          onChange={setE('status')}
          className="w-full px-3 py-2 text-sm bg-bg-elevated border border-border-default rounded-lg text-text-primary focus:outline-none focus:ring-2 focus:ring-accent/40 focus:border-accent cursor-pointer"
        >
          <option value="draft">Draft</option>
          <option value="published">Published</option>
        </select>
      </div>

      <div className="space-y-4 pt-2 border-t border-border-subtle">
        <div className="space-y-1.5">
          <Input label="Title" value={form.title} onChange={setE('title')} placeholder="Shown on every page of this funnel" />
          <p className="text-xs text-text-faint -mt-0.5">Browser tab / SEO. Pages with their own SEO title override this.</p>
        </div>
        <Input label="Favicon URL" value={form.favicon} onChange={setE('favicon')} placeholder="https://…/favicon.png" />
        <Input label="Logo / thumbnail URL" value={form.logoUrl} onChange={setE('logoUrl')} placeholder="https://…/logo.png" />
        <div className="space-y-1.5">
          <label className="block text-sm font-medium text-text-muted">Description</label>
          <textarea
            value={form.description}
            onChange={setE('description')}
            rows={2}
            placeholder="Internal description of this funnel"
            className="w-full px-3 py-2 text-sm bg-bg-elevated border border-border-default rounded-lg text-text-primary focus:outline-none focus:ring-2 focus:ring-accent/40 focus:border-accent resize-y"
          />
        </div>
        <div className="space-y-1.5">
          <label className="block text-sm font-medium text-text-muted">SEO description</label>
          <textarea
            value={form.seoDescription}
            onChange={setE('seoDescription')}
            rows={2}
            placeholder="Meta description for search results & link previews"
            className="w-full px-3 py-2 text-sm bg-bg-elevated border border-border-default rounded-lg text-text-primary focus:outline-none focus:ring-2 focus:ring-accent/40 focus:border-accent resize-y"
          />
        </div>
        <Input label="OG image URL" value={form.ogImage} onChange={setE('ogImage')} placeholder="https://…/og.jpg" />
      </div>

      <div className="space-y-3 pt-2 border-t border-border-subtle">
        <div>
          <h4 className="text-sm font-semibold text-text-primary">Brand colors</h4>
          <p className="text-xs text-text-faint">Visitor pages — published as CSS variables (--brand-primary / --brand-secondary).</p>
        </div>
        <div className="flex items-start gap-6">
          <ColorInput label="Primary" value={form.brandPrimary} onChange={set('brandPrimary')} />
          <ColorInput label="Secondary" value={form.brandSecondary} onChange={set('brandSecondary')} />
        </div>
      </div>

      {/* Checkout enhancements */}
      <div className="rounded-xl border border-border-default bg-bg-card p-4 space-y-4">
        <div>
          <h4 className="text-sm font-semibold text-text-primary">Checkout enhancements</h4>
          <p className="text-xs text-text-faint">Progressive upgrades to the checkout form. Everything fails open — if a script cannot load, the plain inputs keep working.</p>
        </div>
        <ToggleRow
          label="Google address autocomplete"
          hint="Suggests addresses as the buyer types and fills city / state / ZIP / country automatically."
          checked={form.addrAutocomplete}
          onChange={set('addrAutocomplete')}
        />
        {form.addrAutocomplete && (
          <div className="space-y-1.5 pl-1">
            <label className="block text-sm font-medium text-text-muted">Google Maps API key</label>
            <p className="text-xs text-text-faint -mt-0.5">Client key — restrict by HTTP referrer in the Google console.</p>
            <input
              value={form.mapsKey}
              onChange={setE('mapsKey')}
              placeholder="AIza…"
              spellCheck={false}
              autoComplete="off"
              className="w-full px-3 py-2 text-sm bg-bg-elevated border border-border-default rounded-lg text-text-primary font-mono focus:outline-none focus:ring-2 focus:ring-accent/40 focus:border-accent"
            />
            <p className="text-xs text-text-faint">Enable the Maps JavaScript API and Places API for this key.</p>
          </div>
        )}
        <ToggleRow
          label="International phone input"
          hint="Adds a country flag + dial-code selector and formatted placeholder to phone fields. No key required."
          checked={form.intlPhone}
          onChange={set('intlPhone')}
        />
      </div>

      <SectionSaveBar onSave={save} saving={saving} dirty={dirty} saved={saved} err={err} />
    </div>
  );
}

// ── FONTS — visitor-page font family (settings.fonts.family) ────────────────
// Keys mirror the server's FUNNEL_FONTS allowlist (funnelRender.js) — the
// stored value is a key, never a CSS string, so nothing hostile can be stored.
export const FONT_OPTIONS = [
  { key: 'default', label: 'Theme default', css: '' },
  { key: 'inter', label: 'Inter', css: "'Inter', system-ui, sans-serif" },
  { key: 'roboto', label: 'Roboto', css: "'Roboto', system-ui, sans-serif" },
  { key: 'open-sans', label: 'Open Sans', css: "'Open Sans', system-ui, sans-serif" },
  { key: 'lato', label: 'Lato', css: "'Lato', system-ui, sans-serif" },
  { key: 'montserrat', label: 'Montserrat', css: "'Montserrat', system-ui, sans-serif" },
  { key: 'poppins', label: 'Poppins', css: "'Poppins', system-ui, sans-serif" },
  { key: 'playfair-display', label: 'Playfair Display', css: "'Playfair Display', Georgia, serif" },
  { key: 'merriweather', label: 'Merriweather', css: "'Merriweather', Georgia, serif" },
  { key: 'georgia', label: 'Georgia (web-safe)', css: 'Georgia, serif' },
  { key: 'arial', label: 'Arial (web-safe)', css: 'Arial, Helvetica, sans-serif' },
];

export function FontsSection({ funnel, onFunnelUpdated }) {
  const st0 = isObj(funnel?.settings) ? funnel.settings : {};
  const current = (isObj(st0.fonts) && st0.fonts.family) || 'default';
  const [family, setFamily] = useState(current);
  const [saving, setSaving] = useState(false);
  const [err, setErr] = useState('');
  const [saved, setSaved] = useState(false);

  useEffect(() => { setFamily(current); }, [funnel]); // eslint-disable-line react-hooks/exhaustive-deps

  const selected = FONT_OPTIONS.find((f) => f.key === family) || FONT_OPTIONS[0];

  const save = async () => {
    setSaving(true); setErr('');
    try {
      const updated = await saveFunnelPatch(funnel.id, (fresh) => {
        const settings = { ...(isObj(fresh.settings) ? fresh.settings : {}) };
        if (family === 'default') delete settings.fonts;
        else settings.fonts = { ...(isObj(settings.fonts) ? settings.fonts : {}), family };
        return { settings };
      });
      onFunnelUpdated?.(updated);
      setSaved(true); setTimeout(() => setSaved(false), 2000);
    } catch (e) {
      setErr(e.response?.data?.error || 'Failed to save');
    } finally { setSaving(false); }
  };

  return (
    <div className="space-y-4 max-w-lg">
      <div>
        <h3 className="text-base font-semibold text-text-primary">Fonts</h3>
        <p className="mt-1 text-sm text-text-muted">
          Font family for this funnel’s visitor pages. Google fonts load from
          Google Fonts on the public page; web-safe fonts load nothing.
        </p>
      </div>
      <div className="space-y-1.5">
        <label className="block text-sm font-medium text-text-muted">Font family</label>
        <select
          value={family}
          onChange={(e) => setFamily(e.target.value)}
          className="w-full px-3 py-2 text-sm bg-bg-elevated border border-border-default rounded-lg text-text-primary focus:outline-none focus:ring-2 focus:ring-accent/40 focus:border-accent cursor-pointer"
        >
          {FONT_OPTIONS.map((f) => <option key={f.key} value={f.key}>{f.label}</option>)}
        </select>
      </div>
      <div className="rounded-lg border border-border-default bg-bg-elevated/40 p-4">
        <p className="text-xs text-text-faint mb-2">Preview (approximate — the admin app has not loaded the web font)</p>
        <p className="text-lg text-text-primary" style={selected.css ? { fontFamily: selected.css } : undefined}>
          The quick brown fox jumps over the lazy dog — 0123456789
        </p>
      </div>
      <p className="text-xs text-text-faint">
        Applied as a page-level default — explicit styles on individual blocks and
        the checkout form keep priority.
      </p>
      <SectionSaveBar onSave={save} saving={saving} dirty={family !== current} saved={saved} err={err} />
    </div>
  );
}

// ── SCRIPTS — funnel-level head / body-end code (settings.custom_*_code) ────
// The per-page escape hatches (head_html / body_end_html) already exist —
// these are FUNNEL-level and injected on EVERY page of the funnel.
export function ScriptsSection({ funnel, onFunnelUpdated }) {
  const st0 = isObj(funnel?.settings) ? funnel.settings : {};
  const init = () => ({
    head: st0.custom_head_code || '',
    body: st0.custom_body_end_code || '',
  });
  const [form, setForm] = useState(init);
  const [saving, setSaving] = useState(false);
  const [err, setErr] = useState('');
  const [saved, setSaved] = useState(false);

  useEffect(() => { setForm(init()); }, [funnel]); // eslint-disable-line react-hooks/exhaustive-deps

  const dirty = JSON.stringify(form) !== JSON.stringify(init());

  const save = async () => {
    setSaving(true); setErr('');
    try {
      const updated = await saveFunnelPatch(funnel.id, (fresh) => {
        const settings = { ...(isObj(fresh.settings) ? fresh.settings : {}) };
        if (form.head) settings.custom_head_code = form.head; else delete settings.custom_head_code;
        if (form.body) settings.custom_body_end_code = form.body; else delete settings.custom_body_end_code;
        return { settings };
      });
      onFunnelUpdated?.(updated);
      setSaved(true); setTimeout(() => setSaved(false), 2000);
    } catch (e) {
      setErr(e.response?.data?.error || 'Failed to save');
    } finally { setSaving(false); }
  };

  const areaCls = 'w-full px-3 py-2 text-sm bg-bg-elevated border border-border-default rounded-lg text-text-primary font-mono focus:outline-none focus:ring-2 focus:ring-accent/40 focus:border-accent resize-y';

  return (
    <div className="space-y-4 max-w-2xl">
      <div>
        <h3 className="text-base font-semibold text-text-primary">Scripts</h3>
        <p className="mt-1 text-sm text-text-muted">
          Funnel-level code injected on <span className="text-text-primary font-medium">every page</span> of
          this funnel. For a single page, use that page’s own head / body escape
          hatches in the builder. 2MB per field.
        </p>
      </div>
      <div className="space-y-1.5">
        <label className="block text-sm font-medium text-text-muted">Custom head code</label>
        <p className="text-xs text-text-faint -mt-0.5">Injected at the end of &lt;head&gt;.</p>
        <textarea value={form.head} onChange={(e) => setForm((f) => ({ ...f, head: e.target.value }))} rows={7} spellCheck={false} placeholder={'<meta …>\n<script>…</script>'} className={areaCls} />
      </div>
      <div className="space-y-1.5">
        <label className="block text-sm font-medium text-text-muted">Custom body-end code</label>
        <p className="text-xs text-text-faint -mt-0.5">Injected just before &lt;/body&gt;.</p>
        <textarea value={form.body} onChange={(e) => setForm((f) => ({ ...f, body: e.target.value }))} rows={7} spellCheck={false} placeholder={'<script>…</script>'} className={areaCls} />
      </div>
      <SectionSaveBar onSave={save} saving={saving} dirty={dirty} saved={saved} err={err} />
    </div>
  );
}

// ── DOMAINS — deep-link to the existing Domain Hub surface ──────────────────
export function DomainsSection({ funnel }) {
  return (
    <div className="space-y-4 max-w-lg">
      <div>
        <h3 className="text-base font-semibold text-text-primary">Domains</h3>
        <p className="mt-1 text-sm text-text-muted">Custom domains for this funnel are managed in the Domain Hub.</p>
      </div>
      <div className="rounded-xl border border-border-default bg-bg-card p-4 space-y-3">
        <div className="flex items-center gap-3">
          <Globe className="w-5 h-5 text-text-muted shrink-0" />
          <div className="min-w-0">
            {funnel?.custom_domain ? (
              <>
                <div className="text-sm font-medium text-text-primary font-mono truncate">{funnel.custom_domain}</div>
                <div className="text-xs text-text-faint">Attached to this funnel</div>
              </>
            ) : (
              <>
                <div className="text-sm font-medium text-text-primary">No custom domain attached</div>
                <div className="text-xs text-text-faint">Serving on <span className="font-mono">/f/{funnel?.slug}</span></div>
              </>
            )}
          </div>
        </div>
        <Link
          to="/domains"
          className="inline-flex items-center gap-1.5 px-3 py-1.5 text-sm rounded-lg border border-border-default bg-bg-elevated text-text-primary hover:bg-bg-hover transition-colors"
        >
          Open Domain Hub <ExternalLink className="w-3.5 h-3.5" />
        </Link>
      </div>
    </div>
  );
}

// ── REDIRECTS — read-only view + deep-link to the canvas Redirects tab ──────
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
        Path redirects for this funnel — this is a read-only view.{' '}
        <Link to={`/funnels/${funnel.id}?view=redirects`} className="text-accent-text hover:underline">
          Manage on the canvas → Redirects tab
        </Link>
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

// ── HEALTH (Advanced) — funnel readiness checks + live Whop API health ──────
function CheckRow({ ok, label, okText, warnText }) {
  return (
    <div className="flex items-center justify-between rounded-lg border border-border-default bg-bg-card px-3 py-2.5">
      <span className="text-sm text-text-primary">{label}</span>
      <span className={`inline-flex items-center gap-1.5 text-xs font-medium ${ok ? 'text-emerald-400' : 'text-amber-400'}`}>
        {ok ? <CheckCircle2 className="w-3.5 h-3.5" /> : <AlertTriangle className="w-3.5 h-3.5" />}
        {ok ? okText : warnText}
      </span>
    </div>
  );
}

export function HealthSection({ funnelId }) {
  const [detail, setDetail] = useState(null); // { funnel, pages }
  const [gwStatus, setGwStatus] = useState(null);
  const [err, setErr] = useState('');

  // force=true bypasses the server's 45s gateway-status cache (Re-check only).
  const load = useCallback(async (force = false) => {
    setDetail(null); setGwStatus(null); setErr('');
    try {
      const res = await api.get(`/funnels/${funnelId}`);
      setDetail(res.data?.data || { funnel: null, pages: [] });
    } catch (e) {
      setErr(e.response?.data?.error || 'Failed to load funnel');
      setDetail({ funnel: null, pages: [] });
    }
    try {
      const res = await api.get(
        `/checkout/gateways/${encodeURIComponent(funnelId)}/status${force ? '?force=1' : ''}`
      );
      setGwStatus(res.data?.data || {});
    } catch {
      setGwStatus({}); // resolve to "unknown" pills rather than spinning forever
    }
  }, [funnelId]);

  useEffect(() => { load(); }, [load]);

  const f = detail?.funnel;
  const pages = Array.isArray(detail?.pages) ? detail.pages : [];
  const whop = gwStatus?.whop;
  const whopMeta = GATEWAY_META.whop;

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between">
        <h3 className="text-base font-semibold text-text-primary">Health</h3>
        <button onClick={() => load(true)} className="flex items-center gap-1.5 text-xs text-text-muted hover:text-text-primary cursor-pointer">
          <RefreshCw className="w-3.5 h-3.5" /> Re-check
        </button>
      </div>
      {err && <p className="text-sm text-danger">{err}</p>}

      <p className="text-sm text-text-muted">Readiness of this funnel, from its live data.</p>
      {detail === null ? (
        <p className="text-sm text-text-muted">Loading…</p>
      ) : (
        <div className="space-y-2">
          <CheckRow ok={f?.status === 'published'} label="Funnel published" okText="Published" warnText="Draft — public URLs 404" />
          <CheckRow ok={pages.some((p) => p.is_home)} label="Home page set" okText="Set" warnText="No home page" />
          <CheckRow ok={pages.some((p) => p.type === 'checkout')} label="Checkout page present" okText="Present" warnText="None — funnel cannot take orders" />
          <CheckRow ok={Boolean(f?.custom_domain)} label="Custom domain attached" okText={f?.custom_domain || 'Attached'} warnText={`Serving on /f/${f?.slug || '…'}`} />
          <CheckRow ok={pages.length > 0} label="Pages" okText={`${pages.length} live page${pages.length === 1 ? '' : 's'}`} warnText="No pages yet" />
        </div>
      )}

      <p className="text-sm text-text-muted pt-2">Live API health for this funnel’s payment gateway.</p>
      <div className="rounded-lg border border-border-default bg-bg-card p-3">
        <div className="flex items-center justify-between">
          <span className="text-sm font-medium text-text-primary">{whopMeta.name}</span>
          <StatusPill status={gwStatus ? (whop?.aggregate || 'unknown') : 'checking'} />
        </div>
        <div className="mt-2 flex items-center gap-4 text-xs text-text-muted">
          <span className="flex items-center gap-1.5">Live <StatusPill status={gwStatus ? (whop?.live?.status || 'unknown') : 'checking'} /></span>
          <span className="flex items-center gap-1.5">Sandbox <StatusPill status={gwStatus ? (whop?.sandbox?.status || 'unknown') : 'checking'} /></span>
        </div>
      </div>
    </div>
  );
}

// ── TRACKING scaffolds — documented API shape for the tracking lane ─────────
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
      note="Coming with the tracking phase (tracking lane) — GET/PUT /api/v1/funnels/:id/tracking."
    />
  );
}
export function TrackingHealthSection() {
  return (
    <ScaffoldPanel
      title="Tracking Health"
      description="Whether each configured pixel is firing correctly."
      note="Coming with the tracking phase (tracking lane) — GET /api/v1/funnels/:id/tracking/health."
    />
  );
}
export function CustomTrackingSection() {
  return (
    <ScaffoldPanel
      title="Custom Tracking Code"
      description="Raw <head> / <body> tracking snippets injected into every funnel page."
      note="Coming with the tracking phase (tracking lane) — GET/PUT /api/v1/funnels/:id/tracking/custom. For general (non-tracking) code, use Advanced → Scripts today."
    />
  );
}

// ── Simple scaffolds (no backend yet) ───────────────────────────────────────
export const ProductsSection = () => (
  <ScaffoldPanel title="Products" description="Catalog products offered in this funnel." note="Coming with the products phase." />
);
export const ShippingSection = () => (
  <ScaffoldPanel title="Shipping" description="Shipping rates & rules." note="Coming with the shipping phase." />
);
export const SubscriptionsSection = () => (
  <ScaffoldPanel title="Subscriptions" description="Recurring plans for this funnel." note="Coming with the subscriptions phase." />
);
