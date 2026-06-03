// LaunchTemplatesListModal.jsx
// Templates list view for the Statics Launcher — mirrors the video launcher
// (mineblock-video-launcher tool)'s Templates tab UX: card-per-template with
// edit / duplicate / delete actions plus a prominent "+ New Template" button.
//
// Triggered from the TEMPLATES button at the top of the Pipeline view. Before
// this list, clicking TEMPLATES went straight into LaunchTemplateEditor with
// an empty form — operator had no way to see existing templates as a board,
// no duplicate, no delete from one place.
//
// Cross-lane note: this file lives under client/src/pages/production/briefs/
// (creative-pipeline territory). Edit-from-ads-worktree pattern — same as the
// other LaunchTemplate* edits this session.

import { useMemo, useState } from 'react';
import { X, Plus, Edit2, Copy, Trash2, Loader2, AlertCircle, Tag, Users } from 'lucide-react';
import api from '../../../services/api';

// Payload fields we DON'T want to carry across a duplicate (server will
// re-stamp id / timestamps / created_by from the auth context).
const DUPLICATE_STRIP_FIELDS = ['id', 'created_at', 'updated_at', 'created_by', 'is_default'];

function buildDuplicatePayload(template) {
  // Postgres JSONB columns can come back as strings or arrays — normalize to
  // an array so the POST is consistent regardless of which path PG took.
  // Mirrors safeArr in LaunchTemplateEditor.
  const safeArr = (v) => {
    if (Array.isArray(v)) return v;
    if (typeof v === 'string') {
      try {
        let p = JSON.parse(v);
        if (typeof p === 'string') p = JSON.parse(p);
        return Array.isArray(p) ? p : [];
      } catch { return []; }
    }
    return [];
  };

  const out = { ...template };
  for (const k of DUPLICATE_STRIP_FIELDS) delete out[k];

  // Normalize JSONB collections so the POST endpoint accepts them
  out.page_ids = safeArr(template.page_ids);
  out.include_audiences = safeArr(template.include_audiences);
  out.exclude_audiences = safeArr(template.exclude_audiences);
  out.countries = safeArr(template.countries);
  if (!out.countries.length) out.countries = ['US'];
  out.translation_languages = safeArr(template.translation_languages);

  // Append " (Copy)" — but if the original already ends in "(Copy)" or
  // "(Copy N)", increment instead of stacking.
  const baseName = (template.name || 'Template').trim();
  const copyMatch = baseName.match(/^(.*) \(Copy(?: (\d+))?\)$/);
  if (copyMatch) {
    const stem = copyMatch[1];
    const n = parseInt(copyMatch[2] || '1', 10);
    out.name = `${stem} (Copy ${n + 1})`;
  } else {
    out.name = `${baseName} (Copy)`;
  }

  // Defensive coercions (some fields are numeric in DB, may be string)
  if (out.daily_budget != null) out.daily_budget = Number(out.daily_budget);
  if (out.target_roas != null && out.target_roas !== '') {
    out.target_roas = Number(out.target_roas);
  } else {
    out.target_roas = null;
  }

  return out;
}

function TemplateCard({ template, onEdit, onDuplicate, onDelete, busy }) {
  const accountTag = template.ad_account_name || template.ad_account_id || '—';
  const budgetTag = template.daily_budget != null ? `$${Number(template.daily_budget).toFixed(2)}/day` : '—';
  const budgetType = template.bid_strategy?.includes('ROAS') ? 'ROAS' : 'CBO';
  // Countries — handle string-vs-array
  let countries = template.countries;
  if (typeof countries === 'string') {
    try {
      let p = JSON.parse(countries);
      if (typeof p === 'string') p = JSON.parse(p);
      countries = Array.isArray(p) ? p : [];
    } catch { countries = []; }
  }
  if (!Array.isArray(countries)) countries = [];
  const countryStr = countries.length ? countries.slice(0, 3).join(', ') + (countries.length > 3 ? ` +${countries.length - 3}` : '') : '—';

  return (
    <div className="group relative rounded-xl border border-white/[0.06] bg-white/[0.02] hover:border-white/[0.12] hover:bg-white/[0.03] transition-all p-5">
      {/* Action row */}
      <div className="absolute top-3 right-3 flex items-center gap-1 opacity-0 group-hover:opacity-100 transition-opacity">
        <button
          type="button"
          title="Edit"
          onClick={() => onEdit(template)}
          disabled={busy}
          className="p-1.5 rounded-md text-zinc-400 hover:text-white hover:bg-white/[0.06] transition disabled:opacity-40 cursor-pointer"
        >
          <Edit2 className="w-4 h-4" />
        </button>
        <button
          type="button"
          title="Duplicate"
          onClick={() => onDuplicate(template)}
          disabled={busy}
          className="p-1.5 rounded-md text-zinc-400 hover:text-white hover:bg-white/[0.06] transition disabled:opacity-40 cursor-pointer"
        >
          <Copy className="w-4 h-4" />
        </button>
        <button
          type="button"
          title="Delete"
          onClick={() => onDelete(template)}
          disabled={busy}
          className="p-1.5 rounded-md text-zinc-400 hover:text-red-400 hover:bg-red-500/10 transition disabled:opacity-40 cursor-pointer"
        >
          <Trash2 className="w-4 h-4" />
        </button>
      </div>

      <h3 className="text-sm font-semibold text-white pr-24 truncate" title={template.name}>
        {template.name || 'Untitled template'}
      </h3>

      <dl className="mt-3 space-y-1 text-[11px] font-mono text-zinc-500">
        <div className="flex gap-2">
          <dt className="text-zinc-600 shrink-0">Account:</dt>
          <dd className="text-zinc-300 truncate" title={accountTag}>{accountTag}</dd>
        </div>
        {template.campaign_name ? (
          <div className="flex gap-2">
            <dt className="text-zinc-600 shrink-0">Campaign:</dt>
            <dd className="text-zinc-300 truncate" title={template.campaign_name}>{template.campaign_name}</dd>
          </div>
        ) : null}
      </dl>

      <div className="mt-3 flex flex-wrap items-center gap-1.5">
        <span className="inline-flex items-center px-1.5 py-0.5 rounded text-[10px] font-mono uppercase tracking-wider text-zinc-400 bg-white/[0.04] border border-white/[0.06]">
          {countryStr}
        </span>
        <span className="inline-flex items-center px-1.5 py-0.5 rounded text-[10px] font-mono uppercase tracking-wider text-zinc-400 bg-white/[0.04] border border-white/[0.06]">
          {budgetType}
        </span>
        <span className="inline-flex items-center px-1.5 py-0.5 rounded text-[10px] font-mono text-emerald-300 bg-emerald-500/[0.08] border border-emerald-500/[0.15]">
          {budgetTag}
        </span>
      </div>
    </div>
  );
}

/**
 * @param open {boolean}
 * @param templates {Array}   pre-loaded list (parent owns the GET so we don't duplicate that)
 * @param onClose {Function}
 * @param onNew {Function}      open the editor in "new template" mode
 * @param onEdit {Function}     open the editor with a specific template
 * @param onChanged {Function}  signal to parent to refresh templates after duplicate/delete
 */
export default function LaunchTemplatesListModal({ open, templates = [], onClose, onNew, onEdit, onChanged }) {
  const [busyId, setBusyId] = useState(null);
  const [error, setError] = useState(null);
  const [pendingDelete, setPendingDelete] = useState(null); // template waiting for confirm

  const sorted = useMemo(() => {
    return [...templates].sort((a, b) => {
      // Templates with names first, then by created_at desc
      const an = (a.name || '').toLowerCase();
      const bn = (b.name || '').toLowerCase();
      if (an !== bn) return an.localeCompare(bn);
      return (b.created_at || '').localeCompare(a.created_at || '');
    });
  }, [templates]);

  if (!open) return null;

  const handleDuplicate = async (template) => {
    setBusyId(template.id);
    setError(null);
    try {
      const payload = buildDuplicatePayload(template);
      await api.post('/brief-pipeline/launch-templates', payload);
      onChanged?.();
    } catch (err) {
      setError(err.response?.data?.error?.message || err.message || 'Failed to duplicate template');
    } finally {
      setBusyId(null);
    }
  };

  const confirmDelete = async () => {
    if (!pendingDelete) return;
    const template = pendingDelete;
    setBusyId(template.id);
    setError(null);
    try {
      await api.delete(`/brief-pipeline/launch-templates/${template.id}`);
      setPendingDelete(null);
      onChanged?.();
    } catch (err) {
      setError(err.response?.data?.error?.message || err.message || 'Failed to delete template');
    } finally {
      setBusyId(null);
    }
  };

  return (
    <div
      className="fixed inset-0 z-50 flex items-start justify-center bg-black/70 p-6 overflow-y-auto"
      onClick={(e) => { if (e.target === e.currentTarget) onClose?.(); }}
    >
      <div className="w-full max-w-5xl bg-zinc-950 border border-white/[0.08] rounded-2xl shadow-2xl mt-12">
        {/* Header */}
        <div className="flex items-center justify-between px-6 py-4 border-b border-white/[0.05]">
          <div>
            <h2 className="text-base font-semibold text-zinc-100 flex items-center gap-2">
              <Tag className="w-4 h-4 text-[#c9a84c]" />
              Launch Templates
            </h2>
            <p className="text-[11px] font-mono text-zinc-500 mt-0.5">
              {templates.length} {templates.length === 1 ? 'template' : 'templates'} · Click a template to edit, duplicate, or delete
            </p>
          </div>
          <div className="flex items-center gap-2">
            <button
              type="button"
              onClick={onNew}
              className="flex items-center gap-1.5 px-3 py-1.5 text-xs font-semibold text-[#111113]
                         bg-gradient-to-r from-[#c9a84c] to-[#d4b55a]
                         hover:from-[#d4b55a] hover:to-[#dfc068]
                         rounded-lg shadow-[0_0_20px_rgba(201,168,76,0.2)]
                         transition cursor-pointer"
            >
              <Plus className="w-4 h-4" />
              New Template
            </button>
            <button
              type="button"
              onClick={onClose}
              className="p-1.5 rounded-md text-zinc-400 hover:text-white hover:bg-white/[0.06] transition cursor-pointer"
              aria-label="Close templates list"
            >
              <X className="w-5 h-5" />
            </button>
          </div>
        </div>

        {/* Error banner */}
        {error ? (
          <div className="mx-6 mt-4 flex items-center gap-2 text-xs text-red-300 bg-red-500/10 border border-red-500/30 rounded-lg px-3 py-2">
            <AlertCircle className="w-4 h-4 flex-shrink-0" />
            <span>{error}</span>
          </div>
        ) : null}

        {/* Grid */}
        <div className="px-6 py-6 min-h-[200px]">
          {sorted.length === 0 ? (
            <div className="flex flex-col items-center justify-center py-12 text-center">
              <Users className="w-10 h-10 text-zinc-700 mb-3" />
              <p className="text-sm text-zinc-300 mb-1">No templates yet</p>
              <p className="text-xs text-zinc-500 mb-4 max-w-md">
                Templates store your campaign + page + pixel + targeting setup so you can launch ad sets without retyping the config every time.
              </p>
              <button
                type="button"
                onClick={onNew}
                className="flex items-center gap-1.5 px-3 py-1.5 text-xs font-semibold text-[#111113]
                           bg-gradient-to-r from-[#c9a84c] to-[#d4b55a] rounded-lg cursor-pointer"
              >
                <Plus className="w-4 h-4" />
                Create your first template
              </button>
            </div>
          ) : (
            <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
              {sorted.map((t) => (
                <TemplateCard
                  key={t.id}
                  template={t}
                  onEdit={onEdit}
                  onDuplicate={handleDuplicate}
                  onDelete={(tpl) => setPendingDelete(tpl)}
                  busy={busyId === t.id}
                />
              ))}
            </div>
          )}
        </div>
      </div>

      {/* Delete confirm */}
      {pendingDelete ? (
        <div
          className="fixed inset-0 z-[60] flex items-center justify-center bg-black/70 p-4"
          onClick={(e) => { if (e.target === e.currentTarget) setPendingDelete(null); }}
        >
          <div className="w-full max-w-md bg-zinc-950 border border-red-500/[0.4] rounded-xl shadow-2xl">
            <div className="px-5 py-4 border-b border-white/[0.05]">
              <h3 className="text-sm font-semibold text-red-300 flex items-center gap-2">
                <AlertCircle className="w-4 h-4" />
                Delete template?
              </h3>
            </div>
            <div className="px-5 py-4">
              <p className="text-xs text-zinc-300 mb-1">
                <span className="font-mono text-zinc-100">{pendingDelete.name || 'Untitled template'}</span>
              </p>
              <p className="text-xs text-zinc-500">
                This is permanent. Any saved launches still reference the template by id so they keep working, but new launches can no longer pick it.
              </p>
            </div>
            <div className="px-5 py-3 border-t border-white/[0.05] flex items-center justify-end gap-2">
              <button
                type="button"
                onClick={() => setPendingDelete(null)}
                disabled={busyId === pendingDelete.id}
                className="px-3 py-1.5 text-xs text-zinc-400 hover:text-white transition disabled:opacity-40 cursor-pointer"
              >
                Cancel
              </button>
              <button
                type="button"
                onClick={confirmDelete}
                disabled={busyId === pendingDelete.id}
                className="flex items-center gap-1.5 px-3 py-1.5 text-xs font-medium text-white
                           bg-red-500/[0.15] hover:bg-red-500/[0.25] border border-red-500/[0.4] hover:border-red-500/[0.6]
                           rounded-lg transition disabled:opacity-40 cursor-pointer"
              >
                {busyId === pendingDelete.id ? (
                  <Loader2 className="w-3.5 h-3.5 animate-spin" />
                ) : (
                  <Trash2 className="w-3.5 h-3.5" />
                )}
                Delete template
              </button>
            </div>
          </div>
        </div>
      ) : null}
    </div>
  );
}
