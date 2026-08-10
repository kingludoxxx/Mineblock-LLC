// Themes — named token bags applied to the funnel as a macro over the settings
// this modal already writes.
//
// PERSISTENCE. Applying a theme does NOT get its own write path. The server
// answers POST /funnel-themes/apply-plan with a PLAN (which settings paths
// change, from what, to what, and which tokens are being dropped); this
// component commits that plan through saveFunnelPatch — the same serialized
// read-merge-write queue (enqueueSettingsSave) the General and Fonts sections
// use. So a theme apply is serialized against every other settings save, and
// funnelRender.js needed no change to support any of this.
//
// HONESTY IS THE FEATURE. The reference's token bag is 11 keys wide; the keys
// this renderer actually reads are 3. The UI never shows a token without
// showing what it does, and 'Not applied' is rendered as prominently as the
// swatch beside it. The support copy is fetched from the server's own
// TOKEN_SUPPORT map rather than duplicated here, so it cannot drift away from
// what the renderer really does.
import { useCallback, useEffect, useMemo, useState } from 'react';
import { RefreshCw, Trash2, Download, Check, AlertTriangle, Palette } from 'lucide-react';
import api from '../../../services/api';
import Button from '../../ui/Button';
import Input from '../../ui/Input';
import { SettingsCard } from './ui';
import { isObj, saveFunnelPatch } from './settingsPatch';

// Apply a plan's dotted writes onto a settings object, returning a NEW one.
// The client deliberately does NOT re-derive which token maps to which key —
// it only sets the paths the server named, so the mapping has one home.
function applyWrites(settings, writes) {
  const out = isObj(settings) ? { ...settings } : {};
  for (const w of writes || []) {
    const [head, tail] = String(w.path).split('.');
    if (!tail) { out[head] = w.to; continue; }
    out[head] = isObj(out[head]) ? { ...out[head] } : {};
    out[head][tail] = w.to;
  }
  return out;
}

const SUPPORT_STYLE = {
  variable: 'bg-emerald-500/10 text-emerald-400 border-emerald-500/20',
  partial: 'bg-amber-500/10 text-amber-400 border-amber-500/20',
  none: 'bg-bg-elevated text-text-faint border-border-default',
};
const SUPPORT_LABEL = { variable: 'Applied', partial: 'Applied (limited)', none: 'Not applied' };

function Swatch({ value }) {
  const ok = /^#[0-9a-fA-F]{3,8}$/.test(String(value || ''));
  return (
    <span
      className="inline-block w-5 h-5 rounded border border-border-default shrink-0"
      style={ok ? { backgroundColor: value } : { backgroundImage: 'repeating-linear-gradient(45deg,#555 0 4px,#333 4px 8px)' }}
      title={String(value || '')}
    />
  );
}

function isColorToken(k) {
  return ['primary', 'secondary', 'background', 'foreground', 'muted', 'border', 'cta_bg', 'cta_fg'].includes(k);
}

// A preset/theme card: four swatches and the two facts that matter.
function ThemeCard({ theme, support, onApply, onDelete, busy }) {
  const t = theme.tokens || {};
  const applied = ['primary', 'secondary', 'font_body']
    .filter((k) => t[k] && support[k] && support[k].support !== 'none').length;
  return (
    <div className="rounded-lg border border-border-default bg-bg-elevated/40 p-3 space-y-2.5">
      <div className="flex items-start justify-between gap-2">
        <div className="min-w-0">
          <div className="text-sm font-medium text-text-primary truncate">{theme.name}</div>
          {theme.description && <div className="text-xs text-text-faint mt-0.5 line-clamp-2">{theme.description}</div>}
          {theme.imported_from && (
            <div className="text-[10px] text-text-faint mt-0.5 font-mono truncate">from {theme.imported_from}</div>
          )}
        </div>
        {!theme.is_preset && (
          <button
            type="button"
            onClick={() => onDelete(theme)}
            title="Delete this theme"
            className="shrink-0 text-text-faint hover:text-danger cursor-pointer"
          >
            <Trash2 className="w-3.5 h-3.5" />
          </button>
        )}
      </div>
      <div className="flex items-center gap-1.5">
        {['primary', 'secondary', 'background', 'foreground'].map((k) => <Swatch key={k} value={t[k]} />)}
        <span className="text-[10px] text-text-faint ml-1 truncate">{t.font_body || '—'}</span>
      </div>
      <div className="flex items-center justify-between gap-2">
        <span className="text-[10px] text-text-faint">
          {applied} of {Object.keys(t).length} tokens reach the page
        </span>
        <Button size="sm" variant="secondary" onClick={() => onApply(theme)} disabled={busy}>Apply…</Button>
      </div>
    </div>
  );
}

export default function ThemesSection({ funnel, onFunnelUpdated }) {
  const funnelId = funnel?.id;
  const [presets, setPresets] = useState([]);
  const [support, setSupport] = useState({});
  const [themes, setThemes] = useState([]);
  const [loadErr, setLoadErr] = useState('');
  const [loading, setLoading] = useState(true);

  // apply-confirm state
  const [confirm, setConfirm] = useState(null); // { source, plan }
  const [applying, setApplying] = useState(false);
  const [applyErr, setApplyErr] = useState('');
  const [applied, setApplied] = useState('');

  // import state
  const [importUrl, setImportUrl] = useState('');
  const [importing, setImporting] = useState(false);
  const [importErr, setImportErr] = useState('');
  const [draft, setDraft] = useState(null);
  const [draftName, setDraftName] = useState('');
  const [savingDraft, setSavingDraft] = useState(false);

  const load = useCallback(async () => {
    setLoading(true); setLoadErr('');
    try {
      const [p, t] = await Promise.all([
        api.get('/funnel-themes/presets'),
        api.get('/funnel-themes'),
      ]);
      setPresets(p.data?.data?.presets || []);
      setSupport(p.data?.data?.token_support || {});
      setThemes(t.data?.data?.themes || []);
    } catch (err) {
      setLoadErr(err.response?.data?.error?.code || 'Failed to load themes');
    } finally { setLoading(false); }
  }, []);

  useEffect(() => { load(); }, [load]);

  const openApply = async (theme) => {
    setApplyErr(''); setApplied('');
    try {
      const body = theme.is_preset
        ? { funnel_id: funnelId, preset_slug: theme.preset_slug }
        : { funnel_id: funnelId, theme_id: theme.id };
      const res = await api.post('/funnel-themes/apply-plan', body);
      setConfirm(res.data?.data || null);
    } catch (err) {
      setApplyErr(err.response?.data?.error?.code || 'Could not build the apply plan');
    }
  };

  // THE COMMIT. Rides saveFunnelPatch, so it re-GETs the freshest funnel row
  // inside the shared queue and merges onto that — never onto the snapshot the
  // plan was built from.
  const doApply = async () => {
    if (!confirm) return;
    setApplying(true); setApplyErr('');
    try {
      const updated = await saveFunnelPatch(funnelId, (fresh) => ({
        settings: applyWrites(isObj(fresh.settings) ? fresh.settings : {}, confirm.plan.writes),
      }));
      onFunnelUpdated?.(updated);
      setApplied(confirm.source?.name || 'Theme');
      setConfirm(null);
      setTimeout(() => setApplied(''), 4000);
    } catch (err) {
      setApplyErr(err.response?.data?.error || 'Failed to apply');
    } finally { setApplying(false); }
  };

  const doImport = async () => {
    setImporting(true); setImportErr(''); setDraft(null);
    try {
      const res = await api.post('/funnel-themes/import-url', { url: importUrl.trim() });
      const d = res.data?.data?.draft || null;
      setDraft(d);
      setDraftName(d?.name || '');
    } catch (err) {
      setImportErr(err.response?.data?.error?.message || err.response?.data?.error?.code || 'Import failed');
    } finally { setImporting(false); }
  };

  const saveDraft = async () => {
    if (!draft) return;
    setSavingDraft(true); setImportErr('');
    try {
      await api.post('/funnel-themes', {
        name: draftName,
        tokens: draft.tokens,
        preview_url: draft.preview_url,
        imported_from: draft.imported_from,
      });
      setDraft(null); setImportUrl(''); setDraftName('');
      await load();
    } catch (err) {
      setImportErr(err.response?.data?.error?.code || 'Could not save the theme');
    } finally { setSavingDraft(false); }
  };

  const deleteTheme = async (theme) => {
    try {
      await api.delete(`/funnel-themes/${encodeURIComponent(theme.id)}`);
      await load();
    } catch (err) {
      setLoadErr(err.response?.data?.error?.code || 'Delete failed');
    }
  };

  const unsupported = useMemo(
    () => Object.entries(support).filter(([, v]) => v.support === 'none'),
    [support],
  );

  if (loading) {
    return <div className="flex items-center gap-2 text-sm text-text-muted"><RefreshCw className="w-4 h-4 animate-spin" /> Loading themes…</div>;
  }
  if (loadErr) {
    return (
      <div className="space-y-3">
        <p className="text-sm text-danger">{loadErr}</p>
        <Button variant="secondary" size="sm" onClick={load}>Retry</Button>
      </div>
    );
  }

  return (
    <div className="space-y-5">
      <div>
        <h3 className="text-base font-semibold text-text-primary">Themes</h3>
        <p className="mt-1 text-sm text-text-muted">
          A theme is a saved set of design tokens. Applying one writes this funnel’s
          brand colors and page font — the same settings the General and Fonts
          sections write. Nothing else about the funnel changes.
        </p>
      </div>

      {applied && (
        <div className="flex items-center gap-2 rounded-lg border border-emerald-500/20 bg-emerald-500/10 px-3 py-2 text-sm text-emerald-400">
          <Check className="w-4 h-4" /> Applied “{applied}”.
        </div>
      )}
      {applyErr && <p className="text-sm text-danger">{applyErr}</p>}

      {/* ── What a theme can actually change ───────────────────────────── */}
      <SettingsCard
        title="What a theme changes on this funnel"
        description="Stated plainly, because a theme carries more tokens than this renderer reads."
      >
        <ul className="space-y-1.5 text-xs">
          <li className="text-text-muted">
            <span className="text-emerald-400 font-medium">Brand colors</span> — published as the
            <span className="font-mono"> --brand-primary </span> / <span className="font-mono">--brand-secondary </span>
            CSS variables. They repaint a page only where that page’s own CSS reads those variables.
          </li>
          <li className="text-text-muted">
            <span className="text-amber-400 font-medium">Page font</span> — set only when the theme’s body font
            is on the visitor-page allowlist. One font governs the whole page, so headings inherit it;
            a theme’s separate heading font cannot be applied.
          </li>
          <li className="text-text-faint">
            <span className="font-medium">Everything else is stored, not applied.</span> {unsupported.length} tokens
            ({unsupported.map(([k]) => k).join(', ')}) are kept on the theme so they survive editing and export,
            but this renderer has no place to put them and they never reach a visitor page.
          </li>
        </ul>
      </SettingsCard>

      {/* ── Preset gallery ─────────────────────────────────────────────── */}
      <div className="space-y-2">
        <h4 className="text-sm font-semibold text-text-primary flex items-center gap-1.5">
          <Palette className="w-4 h-4" /> Preset library
        </h4>
        <div className="grid grid-cols-1 sm:grid-cols-2 gap-2.5">
          {presets.map((p) => (
            <ThemeCard key={p.id} theme={p} support={support} onApply={openApply} onDelete={deleteTheme} busy={applying} />
          ))}
        </div>
      </div>

      {/* ── Saved themes ───────────────────────────────────────────────── */}
      <div className="space-y-2">
        <h4 className="text-sm font-semibold text-text-primary">Your themes</h4>
        {themes.length === 0 ? (
          <div className="rounded-lg border border-dashed border-border-default bg-bg-elevated/40 px-4 py-5 text-center">
            <p className="text-sm text-text-muted">No saved themes yet — import one from a URL below.</p>
          </div>
        ) : (
          <div className="grid grid-cols-1 sm:grid-cols-2 gap-2.5">
            {themes.map((t) => (
              <ThemeCard key={t.id} theme={t} support={support} onApply={openApply} onDelete={deleteTheme} busy={applying} />
            ))}
          </div>
        )}
      </div>

      {/* ── Import from URL ────────────────────────────────────────────── */}
      <SettingsCard
        title="Import a theme from a URL"
        description="Fetches a public https page and proposes a theme from its most-used colors and fonts. Public pages only — internal and private addresses are refused."
        testid="themes-import"
      >
        <div className="flex items-end gap-2">
          <div className="flex-1">
            <Input label="Page URL" value={importUrl} onChange={(e) => setImportUrl(e.target.value)} placeholder="https://example.com" />
          </div>
          <Button onClick={doImport} loading={importing} disabled={!importUrl.trim()}>
            <Download className="w-4 h-4 mr-1.5" /> Import
          </Button>
        </div>
        {importErr && <p className="text-sm text-danger">{importErr}</p>}

        {draft && (
          <div className="rounded-lg border border-border-default bg-bg-elevated/40 p-3 space-y-3">
            <div className="text-xs text-text-muted">
              Extracted from the page. Only the colors and font below reach a visitor page — review, name it, and save.
            </div>
            <div className="flex flex-wrap items-center gap-1.5">
              {(draft.palette_full || []).map((c) => <Swatch key={c} value={c} />)}
            </div>
            <div className="grid grid-cols-2 gap-2 text-xs">
              {Object.entries(draft.tokens || {}).map(([k, v]) => {
                const s = support[k]?.support || 'none';
                return (
                  <div key={k} className="flex items-center gap-1.5 min-w-0">
                    {isColorToken(k) && <Swatch value={v} />}
                    <span className="text-text-faint shrink-0">{k}</span>
                    <span className="text-text-muted font-mono truncate">{v}</span>
                    <span className={`ml-auto shrink-0 px-1.5 py-0.5 rounded border text-[9px] uppercase tracking-wide ${SUPPORT_STYLE[s]}`}>
                      {SUPPORT_LABEL[s]}
                    </span>
                  </div>
                );
              })}
            </div>
            <div className="flex items-end gap-2">
              <div className="flex-1">
                <Input label="Theme name" value={draftName} onChange={(e) => setDraftName(e.target.value)} />
              </div>
              <Button onClick={saveDraft} loading={savingDraft} disabled={!draftName.trim()}>Save theme</Button>
              <Button variant="secondary" onClick={() => setDraft(null)}>Discard</Button>
            </div>
          </div>
        )}
      </SettingsCard>

      {/* ── Apply confirm ──────────────────────────────────────────────── */}
      {confirm && (
        <div
          className="fixed inset-0 z-[60] flex items-center justify-center bg-black/60 backdrop-blur-sm p-4"
          onClick={(e) => { if (e.target === e.currentTarget && !applying) setConfirm(null); }}
        >
          <div className="w-full max-w-lg max-h-[80vh] overflow-y-auto rounded-xl border border-border-default bg-bg-card p-5 space-y-4">
            <div>
              <h4 className="text-sm font-semibold text-text-primary">
                Apply “{confirm.source?.name}” to {confirm.funnel?.name}?
              </h4>
              <p className="mt-1 text-xs text-text-muted">
                This overwrites the settings listed below. It cannot be undone from here.
              </p>
            </div>

            {/* THE DESTRUCTIVE PART, FIRST AND LOUDEST. An apply replaces
                hand-tuned colors, so every value being destroyed is named. */}
            {confirm.plan.overwrites.length > 0 && (
              <div className="rounded-lg border border-amber-500/20 bg-amber-500/10 p-3 space-y-1.5">
                <div className="flex items-center gap-1.5 text-xs font-semibold text-amber-400">
                  <AlertTriangle className="w-3.5 h-3.5" />
                  {confirm.plan.overwrites.length} hand-tuned {confirm.plan.overwrites.length === 1 ? 'value' : 'values'} will be replaced
                </div>
                {confirm.plan.overwrites.map((o) => (
                  <div key={o.path} className="text-xs font-mono text-text-muted flex items-center gap-1.5 flex-wrap">
                    <span className="text-text-faint">{o.path}</span>
                    <span className="line-through text-danger">{o.from}</span>
                    <span>→</span>
                    <span className="text-emerald-400">{o.to}</span>
                  </div>
                ))}
              </div>
            )}

            <div className="space-y-1.5">
              <div className="text-xs font-semibold text-text-primary">
                Settings keys being written ({confirm.plan.changed_count} of {confirm.plan.writes.length} actually change)
              </div>
              {confirm.plan.writes.length === 0 && (
                <p className="text-xs text-text-faint">Nothing — this theme carries no token this renderer can apply.</p>
              )}
              {confirm.plan.writes.map((w) => (
                <div key={w.path} className="rounded border border-border-default bg-bg-elevated/40 px-2.5 py-1.5">
                  <div className="flex items-center gap-1.5 text-xs">
                    {isColorToken(w.token) && <Swatch value={w.to} />}
                    <span className="font-mono text-text-muted">settings.{w.path}</span>
                    <span className="text-text-faint">=</span>
                    <span className="font-mono text-text-primary">{w.to}</span>
                    {!w.changed && <span className="ml-auto text-[10px] text-text-faint">unchanged</span>}
                  </div>
                  <div className="mt-0.5 text-[10px] text-text-faint">{w.note}</div>
                </div>
              ))}
            </div>

            {confirm.plan.skipped.length > 0 && (
              <details className="rounded-lg border border-border-default bg-bg-elevated/40 p-2.5">
                <summary className="text-xs text-text-muted cursor-pointer">
                  {confirm.plan.skipped.length} tokens in this theme will NOT be applied
                </summary>
                <div className="mt-2 space-y-1">
                  {confirm.plan.skipped.map((s) => (
                    <div key={s.token} className="text-[10px] text-text-faint flex gap-1.5">
                      {isColorToken(s.token) && <Swatch value={s.value} />}
                      <span className="font-mono shrink-0">{s.token}</span>
                      <span>— {s.note}</span>
                    </div>
                  ))}
                </div>
              </details>
            )}

            <div className="flex items-center gap-2 pt-1">
              <Button onClick={doApply} loading={applying} disabled={confirm.plan.writes.length === 0}>
                Apply theme
              </Button>
              <Button variant="secondary" onClick={() => setConfirm(null)} disabled={applying}>Cancel</Button>
            </div>
          </div>
        </div>
      )}

      {/* ── Theme A/B — named, and honestly out of scope ────────────────── */}
      <div className="rounded-lg border border-dashed border-border-default bg-bg-elevated/30 px-4 py-3">
        <div className="text-xs font-semibold text-text-muted">Theme A/B testing</div>
        <p className="mt-1 text-xs text-text-faint">
          Not built. This install already has a split-test lane with its own traffic
          assignment and results ledger — themes will be wired into those arms rather
          than getting a second, separate assignment path that could not be scored
          against it. No toggle here would do anything today.
        </p>
      </div>
    </div>
  );
}
