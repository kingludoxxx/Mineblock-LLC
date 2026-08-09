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
import { RefreshCw, Globe, CheckCircle2, AlertTriangle, ChevronDown, ChevronUp, Trash2, Copy, Check } from 'lucide-react';
import api from '../../../services/api';
import Button from '../../ui/Button';
import Input from '../../ui/Input';
import { GATEWAY_META } from './gatewayMeta';
import { StatusPill, ScaffoldPanel, Toggle } from './ui';
import { isObj, saveFunnelPatch } from './settingsPatch';

// Set key to a trimmed string, or delete it when empty — keeps the stored
// blobs free of dangling '' keys.
function setOrDelete(obj, key, value) {
  const v = typeof value === 'string' ? value.trim() : value;
  if (v === '' || v === undefined || v === null) delete obj[key];
  else obj[key] = v;
}

// The code-editor textarea style, shared by Scripts and Custom Tracking Code
// so the two raw-code editors stay visually identical.
const CODE_AREA_CLS = 'w-full px-3 py-2 text-sm bg-bg-elevated border border-border-default rounded-lg text-text-primary font-mono focus:outline-none focus:ring-2 focus:ring-accent/40 focus:border-accent resize-y';

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

  const areaCls = CODE_AREA_CLS;

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

// ── DOMAINS — full in-modal tab over the existing Domain Hub endpoints ──────
// Endpoints reused verbatim (routes/domainHub.js — {data} envelopes, {error}
// codes): POST /domain-hub/attach · GET /domain-hub/list?funnel_id= ·
// POST /domain-hub/:domain/verify · GET /domain-hub/:domain/records ·
// DELETE /domain-hub/:domain {confirm} — plus PATCH /funnels/:id
// {custom_domain} for the primary radio.
//
// MODEL MAPPING (DECISION MADE): our host routing serves the funnel root on
// EVERY connected lb_domains host simultaneously (hostRouting rewrites '/' →
// /f/<slug> per host) — there is no exclusive "owns /" switch to flip. The
// reference's radio therefore maps to the funnel's PRIMARY domain, persisted
// to funnels.custom_domain (validated server-side against this funnel's
// attached domains; Default URL = NULL). It is a designation (primary /
// canonical URL, Health display), not a serving change. No per-domain
// "account" affordance — our model has none (registrar creds are platform-
// level), so it is omitted per spec.
const DOMAIN_STATUS = {
  connected: { label: 'Connected', cls: 'bg-emerald-500/10 text-emerald-400 border-emerald-500/20', ssl: 'SSL: issued' },
  verifying: { label: 'Verifying', cls: 'bg-accent-muted text-accent-text border-accent/20', ssl: 'SSL: issuing — DNS resolves, certificate in flight' },
  pending_dns: { label: 'Pending DNS', cls: 'bg-amber-500/10 text-amber-400 border-amber-500/20', ssl: 'Waiting for DNS to point at us' },
  error: { label: 'Error', cls: 'bg-red-500/10 text-red-400 border-red-500/20', ssl: 'Needs attention' },
};

function DomainChip({ status }) {
  const s = DOMAIN_STATUS[status] || { label: status || 'Unknown', cls: 'bg-bg-elevated text-text-muted border-border-default' };
  return (
    <span className={`inline-flex items-center px-2 py-0.5 text-[10px] font-semibold uppercase tracking-wide rounded-full border ${s.cls}`}>
      {s.label}
    </span>
  );
}

const DOMAIN_ERR = {
  domain_attached_to_other_funnel: 'This domain is already attached to another funnel — detach it there first.',
  funnel_not_found: 'Funnel not found.',
  confirm_must_match_domain: 'Type the exact domain to confirm.',
  domain_not_found: 'Domain not found.',
  confirm_required: 'Confirmation required.',
  funnel_id_required: 'Funnel id missing.',
  domain_already_on_this_funnel: 'This domain is already attached to this funnel.',
  reassign_conflict: 'The domain moved to another funnel since this list loaded — refresh and try again.',
  from_funnel_id_invalid: 'Invalid source funnel.',
};
const domainErr = (code) => DOMAIN_ERR[code] || (code ? `Failed (${code})` : 'Request failed');

// Mirrors the server's apex heuristic (dnsInspect.js TWO_PART_SUFFIXES) so a
// row can show its required-record count WITHOUT expanding: apex = 2 records
// (A @ + www CNAME), subdomain = 1 (CNAME). The server stays the authority —
// the expanded records view always shows its exact answer.
const APEX_TWO_PART_SUFFIXES = new Set([
  'co.uk', 'org.uk', 'me.uk', 'ac.uk', 'gov.uk',
  'com.au', 'net.au', 'org.au',
  'co.nz', 'net.nz', 'org.nz',
  'com.br', 'com.mx', 'com.ar', 'com.co',
  'co.jp', 'ne.jp', 'or.jp',
  'co.in', 'net.in', 'org.in', 'co.za',
  'com.sg', 'com.hk', 'com.tw', 'com.cn',
  'co.kr', 'com.tr', 'com.ua', 'com.pl',
]);
function requiredRecordCount(domain) {
  const labels = String(domain || '').toLowerCase().split('.');
  const apex = labels.length <= 2 ||
    (labels.length === 3 && APEX_TWO_PART_SUFFIXES.has(labels.slice(-2).join('.')));
  return apex ? 2 : 1;
}

function CopyValueButton({ value }) {
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
      title="Copy value"
      className="inline-flex items-center p-1 rounded text-text-faint hover:text-text-primary hover:bg-bg-hover cursor-pointer shrink-0 transition-colors align-middle"
    >
      {copied ? <Check className="w-3 h-3 text-emerald-400" /> : <Copy className="w-3 h-3" />}
    </button>
  );
}

// Card with a chevron header — the shared shell for the tab's collapsibles.
function CollapsibleCard({ title, subtitle, open, onToggle, children }) {
  return (
    <div className="rounded-xl border border-border-default bg-bg-card">
      <button
        onClick={onToggle}
        className="w-full flex items-center justify-between px-4 py-3 cursor-pointer text-left"
      >
        <div>
          <h4 className="text-sm font-semibold text-text-primary">{title}</h4>
          {subtitle && <p className="text-xs text-text-faint">{subtitle}</p>}
        </div>
        {open ? <ChevronUp className="w-4 h-4 text-text-faint shrink-0" /> : <ChevronDown className="w-4 h-4 text-text-faint shrink-0" />}
      </button>
      {open && <div className="border-t border-border-subtle">{children}</div>}
    </div>
  );
}

function RecordsView({ data }) {
  if (data === 'loading') return <p className="text-xs text-text-muted px-3 py-2">Loading records…</p>;
  if (!data || !Array.isArray(data.required)) return <p className="text-xs text-danger px-3 py-2">Could not load records.</p>;
  const obs = data.observed || {};
  const obsLine = (label, arr) =>
    Array.isArray(arr) && arr.length ? (
      <div><span className="text-text-faint">{label}:</span> <span className="font-mono">{arr.join(', ')}</span></div>
    ) : null;
  return (
    <div className="space-y-2 px-3 py-2">
      <table className="w-full text-xs">
        <thead className="text-text-faint uppercase tracking-wide">
          <tr><th className="text-left py-1 pr-2">Type</th><th className="text-left py-1 pr-2">Name</th><th className="text-left py-1">Value</th></tr>
        </thead>
        <tbody>
          {data.required.map((r, i) => (
            <tr key={i} className="border-t border-border-subtle align-top">
              <td className="py-1.5 pr-2 font-mono text-text-primary">{r.type}</td>
              <td className="py-1.5 pr-2 font-mono text-text-primary">{r.name}</td>
              <td className="py-1.5">
                <span className="inline-flex items-start gap-1">
                  <span className="font-mono text-text-primary break-all">{r.value}</span>
                  <CopyValueButton value={r.value} />
                </span>
                {r.note && <div className="text-text-faint mt-0.5">{r.note}</div>}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
      <div className="text-xs text-text-muted space-y-0.5 border-t border-border-subtle pt-2">
        <div className="text-text-faint uppercase tracking-wide text-[10px]">DNS currently answers</div>
        {obsLine('CNAME', obs.cname)}
        {obsLine('A', obs.a)}
        {obsLine('AAAA', obs.aaaa)}
        {!((obs.cname || []).length || (obs.a || []).length || (obs.aaaa || []).length) && (
          <div className="text-text-faint">No records observed yet (or the lookup failed — try again).</div>
        )}
      </div>
    </div>
  );
}

export function DomainsSection({ funnel, onFunnelUpdated }) {
  const [rows, setRows] = useState(null);
  const [listErr, setListErr] = useState('');
  const [open, setOpen] = useState(true);
  const [connectInput, setConnectInput] = useState('');
  const [connecting, setConnecting] = useState(false);
  const [connectErr, setConnectErr] = useState('');
  const [connectResult, setConnectResult] = useState(null); // attach response data
  const [busyDomain, setBusyDomain] = useState('');   // verify/radio/detach/reuse in flight
  const [verifyFlash, setVerifyFlash] = useState({}); // domain → text
  const [records, setRecords] = useState({});         // domain → 'loading' | data
  const [recordsOpen, setRecordsOpen] = useState({}); // domain → bool
  const [detachArm, setDetachArm] = useState('');     // domain being confirmed
  const [detachText, setDetachText] = useState('');
  const [detachErr, setDetachErr] = useState('');
  const [primaryErr, setPrimaryErr] = useState('');
  const [hub, setHub] = useState(null);               // registrar/status banner data
  const [addOpen, setAddOpen] = useState(null);       // null until first list load decides
  const [availOpen, setAvailOpen] = useState(false);  // "Available on your account"
  const [avail, setAvail] = useState(null);           // rows attached to OTHER funnels
  const [availErr, setAvailErr] = useState('');
  const [funnelNames, setFunnelNames] = useState({}); // funnel_id → name (cosmetic)
  const [reuseArm, setReuseArm] = useState('');       // domain being reuse-confirmed
  const [reuseText, setReuseText] = useState('');
  const [reuseErr, setReuseErr] = useState('');
  const [dnsOpen, setDnsOpen] = useState(false);      // bottom aggregate records

  const load = useCallback(async () => {
    try {
      const res = await api.get(`/domain-hub/list`, { params: { funnel_id: funnel.id } });
      setRows(Array.isArray(res.data?.data) ? res.data.data : []);
      setListErr('');
    } catch (e) {
      // Keep the last-known rows on a failed poll — clearing them would also
      // kill the auto-refresh timer (hasInFlight) on one transient error.
      // The inline listErr notice surfaces the failure; polling continues.
      setListErr(domainErr(e.response?.data?.error));
      setRows((prev) => (Array.isArray(prev) ? prev : []));
    }
  }, [funnel.id]);

  useEffect(() => { load(); }, [load]);

  // Header banner data — one fetch on mount.
  useEffect(() => {
    let alive = true;
    api.get('/domain-hub/registrar/status')
      .then((res) => { if (alive) setHub(res.data?.data || null); })
      .catch(() => { if (alive) setHub(null); });
    return () => { alive = false; };
  }, []);

  // "Add a domain" starts open only when nothing is attached yet — decided
  // once, from the first list load; the operator's toggle wins afterwards.
  useEffect(() => {
    if (addOpen === null && Array.isArray(rows)) setAddOpen(rows.length === 0);
  }, [rows, addOpen]);

  // AUTO STATUS REFRESH — while any row is still pending_dns / verifying,
  // re-poll the list every 15s. ONE timer for the whole section; cleared on
  // unmount and as soon as every row is terminal (connected / error).
  const hasInFlight = Array.isArray(rows) &&
    rows.some((r) => r.status === 'pending_dns' || r.status === 'verifying');
  useEffect(() => {
    if (!hasInFlight) return undefined;
    const timer = setInterval(() => { load(); }, 15_000);
    return () => clearInterval(timer);
  }, [hasInFlight, load]);

  const connect = async () => {
    const domain = connectInput.trim().toLowerCase();
    if (!domain) return;
    setConnecting(true); setConnectErr(''); setConnectResult(null);
    try {
      const res = await api.post(`/domain-hub/attach`, { domain, funnel_id: funnel.id, auto_dns: true });
      setConnectResult(res.data?.data || null);
      setConnectInput('');
      await load();
    } catch (e) {
      setConnectErr(domainErr(e.response?.data?.error));
    } finally { setConnecting(false); }
  };

  const verify = async (domain) => {
    setBusyDomain(domain);
    setVerifyFlash((f) => ({ ...f, [domain]: '' }));
    try {
      const res = await api.post(`/domain-hub/${encodeURIComponent(domain)}/verify`);
      const row = res.data?.data;
      if (row) {
        setRows((rs) => (rs || []).map((r) => (r.domain === domain ? row : r)));
        const s = DOMAIN_STATUS[row.status];
        setVerifyFlash((f) => ({ ...f, [domain]: `Checked — ${s ? s.label.toLowerCase() : row.status}${row.error_detail ? `: ${row.error_detail}` : ''}` }));
      }
    } catch (e) {
      setVerifyFlash((f) => ({ ...f, [domain]: domainErr(e.response?.data?.error) }));
    } finally { setBusyDomain(''); }
  };

  const fetchRecords = useCallback(async (domain) => {
    setRecords((r) => ({ ...r, [domain]: 'loading' }));
    try {
      const res = await api.get(`/domain-hub/${encodeURIComponent(domain)}/records`);
      setRecords((r) => ({ ...r, [domain]: res.data?.data || null }));
    } catch {
      setRecords((r) => ({ ...r, [domain]: null }));
    }
  }, []);

  const toggleRecords = (domain) => {
    const opening = !recordsOpen[domain];
    setRecordsOpen((o) => ({ ...o, [domain]: opening }));
    if (opening && !records[domain]) fetchRecords(domain);
  };

  // Bottom "DNS records" aggregate — live required + observed records for
  // every domain on this funnel; loads whatever is not already cached.
  const toggleDnsAggregate = () => {
    const opening = !dnsOpen;
    setDnsOpen(opening);
    if (opening && Array.isArray(rows)) {
      for (const r of rows) {
        if (!records[r.domain]) fetchRecords(r.domain);
      }
    }
  };

  // "Available on your account" — every attached domain minus this funnel's.
  const loadAvailable = useCallback(async () => {
    setAvailErr('');
    try {
      const res = await api.get('/domain-hub/list');
      const all = Array.isArray(res.data?.data) ? res.data.data : [];
      setAvail(all.filter((r) => r.funnel_id !== funnel.id));
    } catch (e) {
      setAvailErr(domainErr(e.response?.data?.error));
      setAvail([]);
    }
    try {
      const res = await api.get('/funnels', { params: { limit: 200 } });
      const list = res.data?.data?.funnels || [];
      setFunnelNames(Object.fromEntries(list.map((f) => [f.id, f.name])));
    } catch { /* names are cosmetic — rows still render with the funnel id */ }
  }, [funnel.id]);

  const toggleAvailable = () => {
    const opening = !availOpen;
    setAvailOpen(opening);
    if (opening && avail === null) loadAvailable();
  };

  const reuse = async (row) => {
    const domain = row.domain;
    setBusyDomain(domain);
    setReuseErr('');
    try {
      // from_funnel_id anchors the server's conflict guard to the funnel this
      // confirm dialog NAMED — if the row moved since this list loaded, the
      // server refuses (reassign_conflict) instead of chain-moving it.
      await api.post(`/domain-hub/${encodeURIComponent(domain)}/reassign`, {
        funnel_id: funnel.id, from_funnel_id: row.funnel_id, confirm: true,
      });
      setReuseArm(''); setReuseText('');
      await Promise.all([load(), loadAvailable()]);
    } catch (e) {
      setReuseErr(domainErr(e.response?.data?.error));
    } finally { setBusyDomain(''); }
  };

  const setPrimary = async (domain) => { // domain or null (Default URL)
    setBusyDomain(domain || '__default');
    setPrimaryErr('');
    try {
      const res = await api.patch(`/funnels/${funnel.id}`, { custom_domain: domain });
      onFunnelUpdated?.(res.data?.data || null);
    } catch (e) {
      setPrimaryErr(e.response?.data?.error || 'Failed to set the primary domain');
    } finally { setBusyDomain(''); }
  };

  const detach = async (domain) => {
    setBusyDomain(domain); setDetachErr('');
    try {
      await api.delete(`/domain-hub/${encodeURIComponent(domain)}`, { data: { confirm: detachText.trim().toLowerCase() } });
      setDetachArm(''); setDetachText('');
      if (funnel?.custom_domain === domain) {
        // Server cleared the dangling pointer; refresh the parent's copy.
        try { const res = await api.get(`/funnels/${funnel.id}`); onFunnelUpdated?.(res.data?.data?.funnel || null); } catch { /* non-fatal */ }
      }
      await load();
    } catch (e) {
      setDetachErr(domainErr(e.response?.data?.error));
    } finally { setBusyDomain(''); }
  };

  const primary = funnel?.custom_domain || null;

  return (
    <div className="space-y-5 max-w-2xl">
      <div>
        <h3 className="text-base font-semibold text-text-primary">Domains</h3>
        <p className="mt-1 text-sm text-text-muted">Custom domains this funnel serves on.</p>
      </div>

      {/* Header banner — domain-automation status from /registrar/status */}
      {hub && (
        <div className="flex flex-wrap items-center gap-2">
          {hub.render_configured ? (
            <span className="inline-flex items-center gap-2 px-3 py-1.5 rounded-full border border-emerald-500/20 bg-emerald-500/10 text-xs text-emerald-400">
              <span className="w-2 h-2 rounded-full bg-emerald-400 shrink-0" />
              Render connected · <span className="font-mono">{hub.render_target_host}</span>
            </span>
          ) : (
            <span className="inline-flex items-center gap-2 px-3 py-1.5 rounded-full border border-amber-500/20 bg-amber-500/10 text-xs text-amber-400">
              <span className="w-2 h-2 rounded-full bg-amber-400 shrink-0" />
              Domain automation not configured
            </span>
          )}
          {hub.cloudflare_dns_configured && (
            <span className="inline-flex items-center gap-2 px-3 py-1.5 rounded-full border border-border-default bg-bg-elevated text-xs text-text-muted">
              <span className="w-2 h-2 rounded-full bg-emerald-400 shrink-0" />
              Cloudflare DNS token configured
            </span>
          )}
        </div>
      )}

      {/* Add a domain — buy (Domain Hub) or connect one you already own */}
      <CollapsibleCard
        title="Add a domain"
        subtitle="Buy a new domain or connect one you already own"
        open={addOpen === true}
        onToggle={() => setAddOpen((o) => !(o === true))}
      >
        <div className="p-4 space-y-3">
          <div className="flex items-center gap-2">
            <input
              value={connectInput}
              onChange={(e) => setConnectInput(e.target.value)}
              onKeyDown={(e) => { if (e.key === 'Enter') connect(); }}
              placeholder="example.com"
              spellCheck={false}
              autoComplete="off"
              className="flex-1 px-3 py-2 text-sm bg-bg-elevated border border-border-default rounded-lg text-text-primary font-mono focus:outline-none focus:ring-2 focus:ring-accent/40 focus:border-accent"
            />
            <button
              onClick={connect}
              disabled={connecting || !connectInput.trim()}
              className="px-4 py-2 text-sm font-medium rounded-lg bg-emerald-600 text-white hover:bg-emerald-500 disabled:opacity-50 disabled:cursor-not-allowed cursor-pointer transition-colors"
            >
              {connecting ? 'Connecting…' : 'Connect'}
            </button>
          </div>
          <p className="text-xs text-text-faint">
            Keep your existing nameservers and DNS — just add the record(s) shown after
            connecting at your registrar: a subdomain needs one CNAME; an apex domain an
            A record (plus a www CNAME). If your DNS is on Cloudflare and a token is
            configured, the records are created for you automatically. SSL is issued
            automatically by our host once DNS resolves — usually within minutes.
          </p>
          <p className="text-xs text-text-faint">
            Need a new domain? Buy one (and manage the WHOIS contact) in the{' '}
            <Link to="/domains" className="text-accent-text hover:underline">Domain Hub</Link>.
          </p>
          {connectErr && <p className="text-sm text-danger">{connectErr}</p>}
          {connectResult && (
            <div className="rounded-lg border border-border-subtle bg-bg-elevated/40">
              <p className="text-xs text-text-muted px-3 pt-2">
                {connectResult.resumed ? 'Already attached — resumed.' : 'Attached.'}{' '}
                {connectResult.cloudflare?.auto?.ok
                  ? 'Cloudflare created the DNS records automatically.'
                  : 'Create these records at your registrar:'}
                {connectResult.provider && connectResult.provider !== 'unknown' && (
                  <span className="text-text-faint"> (detected DNS provider: {connectResult.provider})</span>
                )}
              </p>
              <RecordsView data={{ required: connectResult.records, observed: {} }} />
              <p className="text-xs text-text-muted px-3 pb-2">
                DNS propagation can take 5 min – 24 h. Open the domain’s row below to
                watch it go live (status refreshes automatically).
              </p>
            </div>
          )}
        </div>
      </CollapsibleCard>

      {/* Active domains */}
      <div className="rounded-xl border border-border-default bg-bg-card">
        <button
          onClick={() => setOpen((o) => !o)}
          className="w-full flex items-center justify-between px-4 py-3 cursor-pointer text-left"
        >
          <div>
            <h4 className="text-sm font-semibold text-text-primary">Active domains</h4>
            <p className="text-xs text-text-faint">
              Every domain this funnel serves on — each connected domain serves this
              funnel from its root. The selected one is the funnel’s primary URL.
            </p>
          </div>
          {open ? <ChevronUp className="w-4 h-4 text-text-faint shrink-0" /> : <ChevronDown className="w-4 h-4 text-text-faint shrink-0" />}
        </button>
        {open && (
          <div className="border-t border-border-subtle divide-y divide-border-subtle">
            {/* Default URL row */}
            <div className="flex items-center gap-3 px-4 py-3">
              <input
                type="radio"
                name="primary-domain"
                checked={!primary}
                onChange={() => setPrimary(null)}
                disabled={busyDomain === '__default'}
                className="accent-[var(--color-accent,#10b981)] cursor-pointer"
              />
              <Globe className="w-4 h-4 text-text-faint shrink-0" />
              <div className="min-w-0 flex-1">
                <div className="text-sm font-mono text-text-primary truncate">/f/{funnel?.slug}</div>
                <div className="text-xs text-text-faint">Default URL — always serves</div>
              </div>
              {!primary && (
                <span className="text-[10px] uppercase tracking-wide text-accent-text border border-accent/20 rounded px-1.5 py-0.5 shrink-0">Primary</span>
              )}
            </div>

            {rows === null ? (
              <p className="text-sm text-text-muted px-4 py-3">Loading…</p>
            ) : rows.length === 0 ? (
              <p className="text-sm text-text-muted px-4 py-3">No custom domains attached yet.</p>
            ) : rows.map((r) => {
              const st = DOMAIN_STATUS[r.status] || null;
              const recData = records[r.domain];
              // Inline count WITHOUT expanding — apex = 2 (A @ + www CNAME),
              // subdomain = 1; the loaded records view refines it if it differs.
              const nRecords = recData && recData !== 'loading' && Array.isArray(recData.required)
                ? recData.required.length
                : requiredRecordCount(r.domain);
              return (
                <div key={r.domain} className="px-4 py-3 space-y-2">
                  <div className="flex items-center gap-3">
                    <input
                      type="radio"
                      name="primary-domain"
                      checked={primary === r.domain}
                      onChange={() => setPrimary(r.domain)}
                      disabled={busyDomain === r.domain}
                      className="accent-[var(--color-accent,#10b981)] cursor-pointer"
                      title="Make this the funnel’s primary URL"
                    />
                    <div className="min-w-0 flex-1">
                      <div className="flex items-center gap-2 min-w-0">
                        <span className="text-sm font-mono text-text-primary truncate">{r.domain}</span>
                        <DomainChip status={r.status} />
                        {primary === r.domain && (
                          <span className="text-[10px] uppercase tracking-wide text-accent-text border border-accent/20 rounded px-1.5 py-0.5 shrink-0">Primary</span>
                        )}
                      </div>
                      <div className="text-xs text-text-faint truncate">
                        {r.dns_provider && r.dns_provider !== 'unknown' ? `${r.dns_provider} · ` : ''}
                        {r.status === 'error' ? (r.error_detail || st?.ssl || 'Needs attention') : (st?.ssl || r.status)}
                        {nRecords != null ? ` · ${nRecords} DNS record${nRecords === 1 ? '' : 's'}` : ''}
                      </div>
                    </div>
                    <button
                      onClick={() => verify(r.domain)}
                      disabled={busyDomain === r.domain}
                      className="text-xs px-2.5 py-1.5 rounded-lg border border-border-default bg-bg-elevated text-text-primary hover:bg-bg-hover disabled:opacity-50 cursor-pointer shrink-0 transition-colors"
                    >
                      {busyDomain === r.domain ? 'Checking…' : 'Verify DNS'}
                    </button>
                    <button
                      onClick={() => { setDetachArm(detachArm === r.domain ? '' : r.domain); setDetachText(''); setDetachErr(''); }}
                      className="p-1.5 rounded-lg text-text-faint hover:text-danger hover:bg-bg-hover cursor-pointer shrink-0 transition-colors"
                      title="Detach this domain"
                    >
                      <Trash2 className="w-4 h-4" />
                    </button>
                  </div>
                  {verifyFlash[r.domain] && <p className="text-xs text-text-muted pl-7">{verifyFlash[r.domain]}</p>}
                  {detachArm === r.domain && (
                    <div className="pl-7 space-y-1.5">
                      <p className="text-xs text-text-muted">
                        Detaching takes this host offline{r.status === 'connected' ? ' immediately' : ''}. Type the domain to confirm:
                      </p>
                      <div className="flex items-center gap-2">
                        <input
                          value={detachText}
                          onChange={(e) => setDetachText(e.target.value)}
                          placeholder={r.domain}
                          spellCheck={false}
                          className="flex-1 px-2.5 py-1.5 text-xs bg-bg-elevated border border-border-default rounded-lg text-text-primary font-mono focus:outline-none focus:ring-2 focus:ring-accent/40"
                        />
                        <button
                          onClick={() => detach(r.domain)}
                          disabled={busyDomain === r.domain || detachText.trim().toLowerCase() !== r.domain}
                          className="text-xs px-2.5 py-1.5 rounded-lg bg-red-600 text-white hover:bg-red-500 disabled:opacity-40 disabled:cursor-not-allowed cursor-pointer transition-colors"
                        >
                          Detach
                        </button>
                      </div>
                      {detachErr && <p className="text-xs text-danger">{detachErr}</p>}
                    </div>
                  )}
                  {/* DNS records footer row */}
                  <button
                    onClick={() => toggleRecords(r.domain)}
                    className="pl-7 flex items-center gap-1 text-xs text-text-muted hover:text-text-primary cursor-pointer"
                  >
                    {recordsOpen[r.domain] ? <ChevronUp className="w-3 h-3" /> : <ChevronDown className="w-3 h-3" />} DNS records
                  </button>
                  {recordsOpen[r.domain] && (
                    <div className="ml-7 rounded-lg border border-border-subtle bg-bg-elevated/40">
                      <RecordsView data={recData} />
                    </div>
                  )}
                </div>
              );
            })}
          </div>
        )}
      </div>
      {primaryErr && <p className="text-sm text-danger">{primaryErr}</p>}
      {listErr && <p className="text-sm text-danger">{listErr}</p>}

      {/* Available on your account — reuse a domain from another funnel */}
      <CollapsibleCard
        title="Available on your account"
        subtitle="Reuse a domain you connected on another funnel"
        open={availOpen}
        onToggle={toggleAvailable}
      >
        <div className="divide-y divide-border-subtle">
          {avail === null ? (
            <p className="text-sm text-text-muted px-4 py-3">Loading…</p>
          ) : avail.length === 0 ? (
            <p className="text-sm text-text-muted px-4 py-3">No domains attached to other funnels.</p>
          ) : avail.map((r) => (
            <div key={r.domain} className="px-4 py-3 space-y-2">
              <div className="flex items-center gap-3">
                <Globe className="w-4 h-4 text-text-faint shrink-0" />
                <div className="min-w-0 flex-1">
                  <div className="flex items-center gap-2 min-w-0">
                    <span className="text-sm font-mono text-text-primary truncate">{r.domain}</span>
                    <DomainChip status={r.status} />
                  </div>
                  <div className="text-xs text-text-faint truncate">
                    Currently on: {funnelNames[r.funnel_id] || r.funnel_id}
                  </div>
                </div>
                <button
                  onClick={() => { setReuseArm(reuseArm === r.domain ? '' : r.domain); setReuseText(''); setReuseErr(''); }}
                  className="text-xs px-2.5 py-1.5 rounded-lg border border-border-default bg-bg-elevated text-text-primary hover:bg-bg-hover cursor-pointer shrink-0 transition-colors"
                >
                  Reuse here
                </button>
              </div>
              {reuseArm === r.domain && (
                <div className="pl-7 space-y-1.5">
                  <p className="text-xs text-text-muted">
                    Moving this domain detaches it from{' '}
                    {funnelNames[r.funnel_id] || 'its current funnel'}
                    {r.status === 'connected' ? ' — the live host starts serving THIS funnel immediately' : ''}.
                    Type the domain to confirm:
                  </p>
                  <div className="flex items-center gap-2">
                    <input
                      value={reuseText}
                      onChange={(e) => setReuseText(e.target.value)}
                      placeholder={r.domain}
                      spellCheck={false}
                      className="flex-1 px-2.5 py-1.5 text-xs bg-bg-elevated border border-border-default rounded-lg text-text-primary font-mono focus:outline-none focus:ring-2 focus:ring-accent/40"
                    />
                    <button
                      onClick={() => reuse(r)}
                      disabled={busyDomain === r.domain || reuseText.trim().toLowerCase() !== r.domain}
                      className="text-xs px-2.5 py-1.5 rounded-lg bg-emerald-600 text-white hover:bg-emerald-500 disabled:opacity-40 disabled:cursor-not-allowed cursor-pointer transition-colors"
                    >
                      {busyDomain === r.domain ? 'Moving…' : 'Move here'}
                    </button>
                  </div>
                  {reuseErr && <p className="text-xs text-danger">{reuseErr}</p>}
                </div>
              )}
            </div>
          ))}
          {availErr && <p className="text-sm text-danger px-4 py-3">{availErr}</p>}
        </div>
      </CollapsibleCard>

      {/* DNS records — aggregate live view across this funnel's domains */}
      <CollapsibleCard
        title="DNS records"
        subtitle="Live records for domains on this funnel"
        open={dnsOpen}
        onToggle={toggleDnsAggregate}
      >
        <div className="divide-y divide-border-subtle">
          {rows === null ? (
            <p className="text-sm text-text-muted px-4 py-3">Loading…</p>
          ) : rows.length === 0 ? (
            <p className="text-sm text-text-muted px-4 py-3">No custom domains attached yet.</p>
          ) : rows.map((r) => (
            <div key={r.domain} className="px-4 py-3 space-y-1">
              <div className="flex items-center gap-2">
                <span className="text-sm font-mono text-text-primary truncate">{r.domain}</span>
                <DomainChip status={r.status} />
              </div>
              <div className="rounded-lg border border-border-subtle bg-bg-elevated/40">
                <RecordsView data={records[r.domain]} />
              </div>
            </div>
          ))}
        </div>
      </CollapsibleCard>
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

// ── TRACKING HEALTH + CUSTOM TRACKING CODE ──────────────────────────────────
// Both wired to routes/funnelTrackingExtras.js:
//   GET     /api/v1/funnels/:id/tracking/health  -> per-pixel fire status
//   GET/PUT /api/v1/funnels/:id/tracking/custom  -> { head_html, body_html }
// The Tracking DIRECTORY (network credentials) lives in ./TrackingSection.jsx.

// Tone → pill classes, same palette as ./ui.jsx StatusPill. A local pill
// because these statuses are tracking-health states, not gateway statuses, so
// they are not in STATUS_PRESENTATION.
const HEALTH_TONES = {
  success: 'bg-emerald-500/10 text-emerald-400 border-emerald-500/20',
  warning: 'bg-amber-500/10 text-amber-400 border-amber-500/20',
  danger: 'bg-red-500/10 text-red-400 border-red-500/20',
  default: 'bg-bg-elevated text-text-muted border-border-default',
};
const HEALTH_DOTS = {
  success: 'bg-emerald-400',
  warning: 'bg-amber-400',
  danger: 'bg-red-400',
  default: 'bg-text-faint',
};

function HealthPill({ tone = 'default', label }) {
  return (
    <span className={`inline-flex items-center gap-1.5 px-2 py-0.5 text-xs font-medium rounded-full border ${HEALTH_TONES[tone] || HEALTH_TONES.default}`}>
      <span className={`w-1.5 h-1.5 rounded-full ${HEALTH_DOTS[tone] || HEALTH_DOTS.default}`} />
      {label}
    </span>
  );
}

// A counter cell. Zero renders as a muted 0 — never as a dash, which would read
// as "unknown" when we actually know the answer is none.
function Stat({ label, value, tone }) {
  const toneCls = tone && value > 0 ? { danger: 'text-red-400', warning: 'text-amber-400' }[tone] : 'text-text-primary';
  return (
    <div>
      <p className="text-[10px] uppercase tracking-wide text-text-faint">{label}</p>
      <p className={`text-sm font-semibold ${value > 0 ? toneCls : 'text-text-muted'}`}>{value ?? 0}</p>
    </div>
  );
}

// Absolute local time — the operator is diagnosing a live outage and a fuzzy
// "2 hours ago" is not good enough to line up against a campaign change.
function whenText(iso) {
  if (!iso) return 'never';
  const t = Date.parse(iso);
  if (!Number.isFinite(t)) return String(iso);
  return new Date(t).toLocaleString();
}

function WindowCounts({ title, w }) {
  return (
    <div>
      <p className="text-xs font-medium text-text-muted mb-1.5">{title}</p>
      <div className="grid grid-cols-5 gap-2">
        <Stat label="Sent" value={w?.sent} />
        <Stat label="Failed" value={w?.failed} tone="danger" />
        <Stat label="Skipped" value={w?.skipped} tone="warning" />
        <Stat label="Deduped" value={w?.deduped} />
        <Stat label="Queued" value={w?.queued} tone="warning" />
      </div>
    </div>
  );
}

function PixelHealthCard({ p }) {
  return (
    <div className="rounded-lg border border-border-default bg-bg-card p-3.5 space-y-3">
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0">
          <div className="flex items-center gap-2 flex-wrap">
            <span className="text-sm font-medium text-text-primary">{p.label}</span>
            {p.mode && (
              <span className="inline-flex items-center px-1.5 py-0.5 text-[10px] font-semibold uppercase tracking-wide rounded border border-border-default bg-bg-elevated text-text-faint">
                {p.mode}
              </span>
            )}
          </div>
          <p className="mt-0.5 text-xs text-text-faint font-mono truncate">
            {p.id_field}: {p.pixel_id || '— not set —'}
          </p>
        </div>
        <HealthPill tone={p.tone} label={p.status_label} />
      </div>

      <p className="text-xs text-text-muted">{p.reason}</p>

      {/*
        breaker.note is composed SERVER-SIDE (trackingHealth.breakerView) rather
        than re-derived here. The old client-side version printed "N consecutive
        failures — the breaker opens at 5" next to a 'closed' state whenever the
        cooldown had lapsed with N >= 5, which reads as a contradiction. The
        server names that third state (cooldown_lapsed) and owns the wording, so
        there is exactly one place it can be wrong — and a harness can assert it.
      */}
      {p.breaker?.note && (
        p.breaker.state === 'open' ? (
          <div className="rounded-md border border-red-500/20 bg-red-500/10 px-2.5 py-1.5">
            <p className="text-xs text-red-400">
              {p.breaker.note}{p.breaker.open_until ? ` Retrying after ${whenText(p.breaker.open_until)}.` : ''}
            </p>
          </div>
        ) : (
          <p className="text-xs text-amber-400">{p.breaker.note}</p>
        )
      )}

      <div className="grid sm:grid-cols-2 gap-3">
        <WindowCounts title="Last 24 hours" w={p.windows?.h24} />
        <WindowCounts title="Last 7 days" w={p.windows?.d7} />
      </div>

      <div className="grid sm:grid-cols-2 gap-x-4 gap-y-1 text-xs pt-1 border-t border-border-subtle">
        <p className="text-text-faint">Last delivered: <span className="text-text-muted">{whenText(p.last_sent_at)}</span></p>
        <p className="text-text-faint">Last failure: <span className="text-text-muted">{whenText(p.last_failed_at)}</span></p>
        {p.queued_now > 0 && (
          <p className="text-amber-400 sm:col-span-2">{p.queued_now} event{p.queued_now === 1 ? '' : 's'} waiting in the retry queue right now.</p>
        )}
        {p.last_error && (
          <p className="text-text-faint sm:col-span-2 break-all">
            Last error: <span className="font-mono text-red-400">{p.last_error}</span>
          </p>
        )}
        {p.last_skip_reason && (
          <p className="text-text-faint sm:col-span-2 break-all">
            Most recent skip: <span className="font-mono text-text-muted">{p.last_skip_reason}</span>
            <span className="text-text-faint"> — a skip is a declined event, not a delivery failure.</span>
          </p>
        )}
      </div>
    </div>
  );
}

export function TrackingHealthSection({ funnel }) {
  const funnelId = funnel?.id;
  const [data, setData] = useState(null);
  const [loading, setLoading] = useState(true);
  const [err, setErr] = useState('');

  const load = useCallback(async () => {
    if (!funnelId) return;
    setLoading(true); setErr('');
    try {
      const res = await api.get(`/funnels/${funnelId}/tracking/health`);
      setData(res.data?.data || null);
    } catch (e) {
      setErr(e.response?.data?.error?.code === 'internal_error'
        ? 'Server error while reading tracking health — try again.'
        : (e.response?.data?.error?.message || 'Could not load tracking health.'));
      setData(null);
    } finally { setLoading(false); }
  }, [funnelId]);

  useEffect(() => { load(); }, [load]);

  const pixels = data?.pixels || [];

  return (
    <div className="space-y-4 max-w-3xl">
      <div className="flex items-start justify-between gap-3">
        <div>
          <h3 className="text-base font-semibold text-text-primary">Tracking Health</h3>
          <p className="mt-1 text-sm text-text-muted">
            Whether each configured pixel is actually firing, computed from real
            delivery records — never from configuration alone.
          </p>
        </div>
        <Button variant="secondary" onClick={load} loading={loading} className="shrink-0">
          <RefreshCw className="w-4 h-4 mr-1.5" /> Refresh
        </Button>
      </div>

      {err && <p className="text-sm text-danger">{err}</p>}

      {loading && !data && <p className="text-sm text-text-muted">Loading…</p>}

      {data && (
        <>
          <div className="flex items-center gap-3 flex-wrap">
            <HealthPill
              tone={data.overall === 'healthy' ? 'success' : (pixels[0]?.tone || 'default')}
              label={data.overall_label}
            />
            <span className="text-xs text-text-faint">
              Checked {whenText(data.generated_at)} · windows: {data.windows?.h24} and {data.windows?.d7}
            </span>
          </div>

          {pixels.length === 0 ? (
            <div className="rounded-lg border border-dashed border-border-default bg-bg-elevated/40 px-4 py-6 text-center space-y-1">
              <p className="text-sm text-text-muted">No pixels are configured on this funnel.</p>
              <p className="text-xs text-text-faint">
                Add a network under Tracking to start delivering conversions — there is
                nothing to report until then.
              </p>
            </div>
          ) : (
            <>
              {/*
                Two figures, two headings, on purpose. Everything under "last 24
                hours" is a COUNT OF LOGGED EVENTS in that window; "in the retry
                queue" is an INSTANTANEOUS depth with no window at all. They were
                previously shown side by side under the 24h heading, which read
                as "N events queued today" — a number that does not exist.
              */}
              <div className="rounded-lg border border-border-default bg-bg-card p-3.5 space-y-3">
                <div>
                  <p className="text-xs font-medium text-text-muted mb-2">All pixels · last 24 hours</p>
                  <div className="grid grid-cols-5 gap-2">
                    <Stat label="Sent" value={data.totals_24h?.sent} />
                    <Stat label="Failed" value={data.totals_24h?.failed} tone="danger" />
                    <Stat label="Skipped" value={data.totals_24h?.skipped} tone="warning" />
                    <Stat label="Deduped" value={data.totals_24h?.deduped} />
                    <Stat label="Queued" value={data.totals_24h?.queued} tone="warning" />
                  </div>
                </div>
                <div className="pt-2.5 border-t border-border-subtle flex items-baseline justify-between gap-3">
                  <div>
                    <p className="text-xs font-medium text-text-muted">In the retry queue right now</p>
                    <p className="text-[11px] text-text-faint">Live depth across all pixels — not a 24h count.</p>
                  </div>
                  <span className={`text-lg font-semibold ${data.queued_now > 0 ? 'text-amber-400' : 'text-text-muted'}`}>
                    {data.queued_now ?? 0}
                  </span>
                </div>
              </div>

              <div className="space-y-3">
                {pixels.map((p) => <PixelHealthCard key={p.kind} p={p} />)}
              </div>
            </>
          )}

          {(data.notes || []).map((n) => (
            <div key={n.kind} className="rounded-lg border border-amber-500/20 bg-amber-500/5 px-3 py-2">
              <p className="text-xs text-amber-400/90">
                <AlertTriangle className="w-3.5 h-3.5 inline mr-1 -mt-0.5" />
                {n.note}
              </p>
            </div>
          ))}

          {(data.unknown_kinds || []).length > 0 && (
            <div className="rounded-lg border border-amber-500/20 bg-amber-500/5 px-3 py-2">
              <p className="text-xs text-amber-400/90">
                {data.unknown_kinds.map((u) => `${u.rows} row(s) of kind "${u.kind}"`).join(', ')} exist
                but no adapter serves them — nothing is delivered for those.
              </p>
            </div>
          )}
        </>
      )}
    </div>
  );
}

// ── CUSTOM TRACKING CODE ────────────────────────────────────────────────────
// Raw head / body tracking snippets, stored verbatim (no sanitization — the
// same trusted-operator posture as Scripts). Stored server-side in
// lb_tracking_custom_code, NOT in funnels.settings: routes/funnels.js budgets
// non-allow-listed settings keys at 32KB combined, which two 32KB snippets
// would blow, breaking every other settings save.
const CUSTOM_MAX_BYTES = 32 * 1024;
const byteLen = (s) => new TextEncoder().encode(String(s ?? '')).length;

function CodeField({ label, hint, value, onChange, placeholder }) {
  const bytes = byteLen(value);
  const over = bytes > CUSTOM_MAX_BYTES;
  return (
    <div className="space-y-1.5">
      <div className="flex items-baseline justify-between gap-2">
        <label className="block text-sm font-medium text-text-muted">{label}</label>
        <span className={`text-[11px] font-mono ${over ? 'text-red-400' : 'text-text-faint'}`}>
          {bytes.toLocaleString()} / {CUSTOM_MAX_BYTES.toLocaleString()} bytes
        </span>
      </div>
      <p className="text-xs text-text-faint -mt-0.5">{hint}</p>
      <textarea
        value={value}
        onChange={(e) => onChange(e.target.value)}
        rows={9}
        spellCheck={false}
        placeholder={placeholder}
        className={CODE_AREA_CLS}
      />
    </div>
  );
}

export function CustomTrackingSection({ funnel }) {
  const funnelId = funnel?.id;
  const [form, setForm] = useState({ head: '', body: '' });
  const [initial, setInitial] = useState({ head: '', body: '' });
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [saved, setSaved] = useState(false);
  const [err, setErr] = useState('');

  const load = useCallback(async () => {
    if (!funnelId) return;
    setLoading(true); setErr('');
    try {
      const res = await api.get(`/funnels/${funnelId}/tracking/custom`);
      const d = res.data?.data || {};
      const next = { head: d.head_html || '', body: d.body_html || '' };
      setForm(next); setInitial(next);
    } catch (e) {
      setErr(e.response?.data?.error?.message || 'Could not load the custom tracking code.');
    } finally { setLoading(false); }
  }, [funnelId]);

  useEffect(() => { load(); }, [load]);

  const dirty = form.head !== initial.head || form.body !== initial.body;
  const tooBig = byteLen(form.head) > CUSTOM_MAX_BYTES || byteLen(form.body) > CUSTOM_MAX_BYTES;

  const save = async () => {
    setSaving(true); setErr('');
    try {
      // Always send BOTH fields: the server treats an absent field as "no
      // change", so a cleared textarea must arrive as an explicit ''.
      const res = await api.put(`/funnels/${funnelId}/tracking/custom`, {
        head_html: form.head,
        body_html: form.body,
      });
      const d = res.data?.data || {};
      const next = { head: d.head_html || '', body: d.body_html || '' };
      setForm(next); setInitial(next);
      setSaved(true); setTimeout(() => setSaved(false), 2000);
    } catch (e) {
      setErr(e.response?.data?.error?.message || 'Failed to save.');
    } finally { setSaving(false); }
  };

  return (
    <div className="space-y-4 max-w-2xl">
      <div>
        <h3 className="text-base font-semibold text-text-primary">Custom Tracking Code</h3>
        <p className="mt-1 text-sm text-text-muted">
          Raw tracking snippets for <span className="text-text-primary font-medium">every page</span> of
          this funnel. Stored and validated verbatim — nothing is rewritten or sanitized,
          so a tag that works elsewhere will work here. 32KB per field.
        </p>
        <p className="mt-1.5 text-xs text-text-faint">
          For non-tracking code use Advanced → Scripts; for one page, use that page’s
          own head / body escape hatches in the builder.
        </p>
      </div>

      {/*
        TODO(tracking-render-wiring): NOT-YET-LIVE notice — DELETE THIS BLOCK, and
        flip the tense of the copy above and of both CodeField hints below
        ("Will be injected" → "Injected"), when the integrator wires the public
        renderer to emit these snippets. That wiring is
        services/funnelRender.js (funnelSettingsHead :2835 / funnelSettingsBodyEnd
        :2872, consumed at :1600-1602) reading lb_tracking_custom_code, which
        funnelPublic.js:125 must join in. Until it lands, saving here changes
        nothing about what a visitor's browser executes, and the panel must say
        so — an operator who pastes a Meta base pixel, sees a green "Saved" and
        this copy would otherwise believe their tags are live while zero tags
        render.
      */}
      <div className="rounded-lg border border-dashed border-amber-500/30 bg-amber-500/5 px-4 py-3">
        <p className="text-sm text-amber-400/90 font-medium">Saved, but not live yet</p>
        <p className="mt-1 text-xs text-amber-400/70">
          These snippets are stored and validated now, but they are
          {' '}<span className="font-medium">not yet emitted on public pages</span> — the renderer
          wiring lands with the tracking phase. Nothing you save here affects a live visitor
          until then. To ship a tag today, use Advanced → Scripts.
        </p>
      </div>

      {loading ? (
        <p className="text-sm text-text-muted">Loading…</p>
      ) : (
        <>
          <CodeField
            label="Head snippet"
            hint="Will be injected at the end of <head> — pixel base codes, tag managers, consent tools."
            value={form.head}
            onChange={(v) => setForm((f) => ({ ...f, head: v }))}
            placeholder={'<script>…</script>\n<noscript>…</noscript>'}
          />
          <CodeField
            label="Body snippet"
            hint="Will be injected just before </body> — deferred tags, <noscript> fallbacks."
            value={form.body}
            onChange={(v) => setForm((f) => ({ ...f, body: v }))}
            placeholder={'<noscript><img src="…"/></noscript>'}
          />
          {tooBig && (
            <p className="text-sm text-danger">One of the snippets is over the 32KB limit — trim it before saving.</p>
          )}
          <SectionSaveBar onSave={save} saving={saving} dirty={dirty && !tooBig} saved={saved} err={err} />
        </>
      )}
    </div>
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
