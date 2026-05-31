// PushToClickupModal.jsx — Brief Pipeline → ClickUp push form
//
// Triggered from an approved brief card (or the brief detail panel).
// Pre-fills from /api/v1/brief-pipeline/generated/:id/clickup-prefill,
// posts to /push-to-clickup, then moves the card to "Ready ClickUp".
//
// Mirrors the Brief Agent form layout (Q3 in the design scope says we
// reuse that screen's UX as-is) so operators familiar with Brief Agent
// have zero learning curve here.

import { useState, useEffect, useMemo } from 'react';
import { X, Loader2, CheckCircle2, ExternalLink, AlertCircle, Zap } from 'lucide-react';
// FIX: original import `../../../lib/api` doesn't exist — that path resolves
// to client/src/lib/api which isn't a real directory. The actual api client
// lives at client/src/services/api.js (used by every other page in this dir).
// Cross-lane fix from ads worktree to unblock the build chain.
import api from '../../../services/api';

// Compute the same ISO-ish week the backend uses. Mirrors briefAgent's
// getISOWeekNumber + the existing live preview math.
function getCurrentWeekStr() {
  const now = new Date();
  const start = new Date(now.getFullYear(), 0, 1);
  const diff = now - start;
  const week = Math.ceil(((diff / 86400000) + start.getDay() + 1) / 7);
  return `WK${String(week).padStart(2, '0')}_${now.getFullYear()}`;
}

const EMPTY_FORM = {
  product:        'MR',
  angle:          '',
  creativeType:   'Mashup',
  briefType:      'IT',           // locked — Brief Pipeline only generates iterations
  editor:         '',
  avatar:         'NA',
  idea:           '',
  briefText:      '',
  referenceLink: '',
  parentBriefId: '',
  briefNumber:   null,
};

export default function PushToClickupModal({ briefId, briefTitle, isOpen, onClose, onSuccess }) {
  const [loading, setLoading] = useState(true);
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState(null);
  const [result, setResult] = useState(null);
  const [form, setForm] = useState(EMPTY_FORM);
  const [options, setOptions] = useState({
    angles: [], creativeTypes: [], briefTypes: ['IT'],
    editors: [], avatars: [], products: ['MR'],
    creativeTypeCodes: {},
  });

  // Load prefill on open
  useEffect(() => {
    if (!isOpen || !briefId) return;
    let cancelled = false;
    (async () => {
      setLoading(true);
      setError(null);
      setResult(null);
      try {
        const { data } = await api.get(`/brief-pipeline/generated/${briefId}/clickup-prefill`);
        if (cancelled) return;
        if (data.success) {
          setForm({ ...EMPTY_FORM, ...(data.defaults || {}) });
          if (data.options) setOptions(data.options);
        } else {
          setError(data.error?.message || 'Could not load prefill data.');
        }
      } catch (err) {
        if (cancelled) return;
        setError(err.response?.data?.error?.message || err.message || 'Failed to load.');
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();
    return () => { cancelled = true; };
  }, [isOpen, briefId]);

  const updateField = (key, value) => {
    setForm((prev) => ({ ...prev, [key]: value }));
    setError(null);
  };

  // Live task-name preview. Mirrors server-side buildNamingConvention:
  // - parent slot drops entirely for NN (clones — no meaningful parent)
  //   or when parentBriefId is a synthetic "MANUAL-XXXXXXXX" id
  // - real parent B-codes ("B0223") still surface for IT iterations
  const taskPreview = useMemo(() => {
    const code = options.creativeTypeCodes?.[form.creativeType] || 'HX';
    const num = form.briefNumber ? `B${String(form.briefNumber).padStart(4, '0')}` : 'B????';
    const briefType = form.briefType || 'IT';
    const rawParent = briefType === 'IT' ? form.parentBriefId : null;
    const isSyntheticParent = !rawParent || /^MANUAL[-_]/i.test(String(rawParent));
    const dropParent = briefType === 'NN' || isSyntheticParent;
    const weekStr = getCurrentWeekStr();
    const slots = [
      form.product || 'MR',
      num,
      code,
      briefType,
      dropParent ? null : rawParent,
      form.angle || '?',
      weekStr,
    ];
    return slots.filter((s) => s !== null && s !== undefined && s !== '').join(' - ');
  }, [form, options.creativeTypeCodes]);

  const canSubmit = !!(form.angle && form.creativeType && form.editor && form.avatar);

  const handleSubmit = async (e) => {
    e?.preventDefault?.();
    if (!canSubmit || submitting) return;
    setSubmitting(true);
    setError(null);
    try {
      // Map form → backend override shape. Field names match what
      // pushBriefToClickUp() destructures from `overrides`.
      const payload = {
        product_code:        form.product,
        angle:               form.angle,
        format:              form.creativeType,        // backend uses 'format'
        brief_type:          form.briefType,           // NN | IT — drives both naming + ClickUp dropdown
        avatar:              form.avatar,
        editor:              form.editor,
        idea:                form.idea,
        body:                form.briefText,            // Brief Text → body
        reference_link:      form.referenceLink,
        // Parent slot only meaningful for IT iterations. NN sends empty so
        // the backend doesn't accidentally stamp a stale parent on the
        // ClickUp custom field.
        parent_creative_id:  form.briefType === 'IT' ? form.parentBriefId : '',
        naming_convention:   taskPreview,
      };
      const { data } = await api.post(`/brief-pipeline/generated/${briefId}/push-to-clickup`, payload);
      if (data.success) {
        setResult({
          name: data.naming_convention,
          url: data.clickup_task_url,
        });
        // Notify parent so the column lists refresh + card animates to Ready ClickUp
        if (onSuccess) onSuccess({ briefId, ...data });
      } else {
        setError(data.error?.message || 'Push failed.');
      }
    } catch (err) {
      const errCode = err.response?.data?.error?.code;
      const errMsg = err.response?.data?.error?.message || err.message || 'Push failed.';
      if (errCode === 'ALREADY_PUSHED') {
        setError(`This brief was already pushed. Open it in ClickUp instead.`);
      } else if (errCode === 'NOT_APPROVED') {
        setError(errMsg);
      } else {
        setError(errMsg);
      }
    } finally {
      setSubmitting(false);
    }
  };

  if (!isOpen) return null;

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/70 p-4 overflow-y-auto"
      onClick={(e) => { if (e.target === e.currentTarget) onClose?.(); }}
    >
      <div className="w-full max-w-3xl bg-zinc-950 border border-white/[0.08] rounded-2xl shadow-2xl">
        {/* Header */}
        <div className="flex items-start justify-between px-6 py-4 border-b border-white/[0.05]">
          <div className="min-w-0">
            <h2 className="text-base font-semibold text-zinc-100 flex items-center gap-2">
              <Zap className="w-4 h-4 text-amber-400" />
              Push to ClickUp
            </h2>
            {briefTitle && (
              <p className="text-xs text-zinc-500 mt-0.5 truncate font-mono">{briefTitle}</p>
            )}
          </div>
          <button
            type="button"
            onClick={onClose}
            aria-label="Close push to ClickUp modal"
            className="text-zinc-500 hover:text-zinc-200 transition-colors"
          >
            <X className="w-5 h-5" />
          </button>
        </div>

        {/* Body */}
        {loading ? (
          <div className="flex items-center justify-center py-16 text-zinc-500">
            <Loader2 className="w-5 h-5 animate-spin mr-2" /> Loading defaults…
          </div>
        ) : (
          <form onSubmit={handleSubmit} className="p-6 space-y-5">
            {/* Row 1 — Core */}
            <div className="grid grid-cols-3 gap-4">
              <FieldSelect
                label="Product"
                value={form.product}
                onChange={(v) => updateField('product', v)}
                options={options.products}
              />
              <FieldSelect
                label="Angle"
                value={form.angle}
                onChange={(v) => updateField('angle', v)}
                options={options.angles}
                placeholder="Select angle..."
              />
              <FieldSelect
                label="Creative Type"
                value={form.creativeType}
                onChange={(v) => updateField('creativeType', v)}
                options={options.creativeTypes}
                placeholder="Select type..."
              />
            </div>

            {/* Row 2 — Brief Type / Editor / Avatar */}
            <div className="grid grid-cols-3 gap-4">
              <FieldSelect
                label="Brief Type"
                value={form.briefType}
                onChange={(v) => {
                  updateField('briefType', v);
                  // Switching to NN clears the parent brief id — net-new
                  // clones have no meaningful parent. Switching back to
                  // IT leaves whatever the operator types next.
                  if (v === 'NN') updateField('parentBriefId', '');
                }}
                options={options.briefTypes}
                labelFor={(b) => (b === 'NN' ? 'NN (Net New)' : 'IT (Iteration)')}
              />
              <FieldSelect
                label="Editor"
                value={form.editor}
                onChange={(v) => updateField('editor', v)}
                options={options.editors}
                placeholder="Select editor..."
              />
              <FieldSelect
                label="Avatar"
                value={form.avatar}
                onChange={(v) => updateField('avatar', v)}
                options={options.avatars}
                placeholder="Select avatar..."
              />
            </div>

            {/* Parent Brief ID — visible only for IT iterations. NN clones
                have no meaningful parent so the field is hidden entirely. */}
            {form.briefType === 'IT' && (
              <FieldInput
                label="Parent Brief ID"
                value={form.parentBriefId}
                onChange={(v) => updateField('parentBriefId', v)}
                placeholder="e.g. B0223"
              />
            )}

            {/* Idea */}
            <FieldInput
              label="Idea / Hook"
              value={form.idea}
              onChange={(v) => updateField('idea', v)}
              placeholder="Quick summary of the creative idea..."
            />

            {/* Brief Text */}
            <div className="space-y-1.5">
              <label className="block text-sm font-medium text-zinc-400">Brief Text</label>
              <textarea
                value={form.briefText}
                onChange={(e) => updateField('briefText', e.target.value)}
                placeholder="Detailed brief instructions for the editor..."
                rows={6}
                className="w-full px-3 py-2 text-sm bg-zinc-900 border border-white/[0.08] rounded-lg
                         text-zinc-100 placeholder:text-zinc-600 font-mono
                         focus:outline-none focus:ring-2 focus:ring-amber-400/40 focus:border-amber-400
                         resize-y"
              />
            </div>

            {/* Reference Link */}
            <FieldInput
              label="Reference Link"
              value={form.referenceLink}
              onChange={(v) => updateField('referenceLink', v)}
              placeholder="https://..."
            />

            {/* Task name preview */}
            <div className="bg-zinc-900/60 border border-white/[0.05] rounded-lg p-3">
              <p className="text-[10px] uppercase tracking-wider text-zinc-500 mb-1">Task name preview</p>
              <p className="text-sm text-zinc-200 font-mono break-all">{taskPreview}</p>
            </div>

            {/* Error */}
            {error && (
              <div className="flex items-start gap-2 text-sm text-red-400 bg-red-500/10 border border-red-500/20 rounded-lg px-3 py-2">
                <AlertCircle className="w-4 h-4 shrink-0 mt-0.5" />
                <span className="whitespace-pre-line">{error}</span>
              </div>
            )}

            {/* Success */}
            {result && (
              <div className="flex items-center justify-between bg-emerald-500/10 border border-emerald-500/20 rounded-lg px-3 py-2">
                <div className="flex items-center gap-2 text-sm text-emerald-400">
                  <CheckCircle2 className="w-4 h-4 shrink-0" />
                  Created <span className="font-mono font-semibold truncate max-w-md">{result.name}</span>
                </div>
                {result.url && (
                  <a
                    href={result.url}
                    target="_blank"
                    rel="noopener noreferrer"
                    className="text-xs text-emerald-300 hover:underline flex items-center gap-1"
                  >
                    Open in ClickUp <ExternalLink className="w-3 h-3" />
                  </a>
                )}
              </div>
            )}

            {/* Submit */}
            <button
              type="submit"
              disabled={!canSubmit || submitting || !!result}
              aria-label="Generate brief in ClickUp"
              className="w-full flex items-center justify-center gap-2 px-4 py-3 rounded-lg
                       bg-amber-500/15 text-amber-300 hover:bg-amber-500/25
                       border border-amber-500/30 hover:border-amber-500/50
                       shadow-[0_0_15px_rgba(245,158,11,0.1)] hover:shadow-[0_0_20px_rgba(245,158,11,0.2)]
                       font-mono font-semibold uppercase tracking-wide text-sm
                       disabled:opacity-40 disabled:cursor-not-allowed
                       transition-all"
            >
              {submitting ? (
                <><Loader2 className="w-4 h-4 animate-spin" /> Creating in ClickUp…</>
              ) : result ? (
                <><CheckCircle2 className="w-4 h-4" /> Created — close to finish</>
              ) : (
                <><Zap className="w-4 h-4" /> Generate Brief in ClickUp</>
              )}
            </button>
          </form>
        )}
      </div>
    </div>
  );
}

function FieldSelect({ label, value, onChange, options = [], placeholder = '', labelFor, disabled = false }) {
  return (
    <div className="space-y-1.5">
      <label className="block text-sm font-medium text-zinc-400">{label}</label>
      <select
        value={value || ''}
        onChange={(e) => onChange(e.target.value)}
        disabled={disabled}
        className="w-full px-3 py-2 text-sm bg-zinc-900 border border-white/[0.08] rounded-lg
                   text-zinc-100 focus:outline-none focus:ring-2 focus:ring-amber-400/40 focus:border-amber-400
                   disabled:opacity-50 disabled:cursor-not-allowed appearance-none"
      >
        {placeholder && <option value="">{placeholder}</option>}
        {options.map((opt) => (
          <option key={opt} value={opt}>{labelFor ? labelFor(opt) : opt}</option>
        ))}
      </select>
    </div>
  );
}

function FieldInput({ label, value, onChange, placeholder = '' }) {
  return (
    <div className="space-y-1.5">
      <label className="block text-sm font-medium text-zinc-400">{label}</label>
      <input
        type="text"
        value={value || ''}
        onChange={(e) => onChange(e.target.value)}
        placeholder={placeholder}
        className="w-full px-3 py-2 text-sm bg-zinc-900 border border-white/[0.08] rounded-lg
                   text-zinc-100 placeholder:text-zinc-600
                   focus:outline-none focus:ring-2 focus:ring-amber-400/40 focus:border-amber-400"
      />
    </div>
  );
}
