import { useState, useEffect, useCallback } from 'react';
import { createPortal } from 'react-dom';
import { X, Loader2, RotateCcw, Check, AlertCircle } from 'lucide-react';
import api from '../../../services/api';

// ---------------------------------------------------------------------------
// 3-prompt architecture (migration 036)
//
// Pipeline:
//   1. claude_analysis   — Claude sees ref + product, emits JSON brief
//   2. nanobanana_image  — NanoBanana sees only product image, generates ad
//   3. ai_adjustment     — Claude turns freeform correction into NB regen prompt
//
// Each prompt is a single editable template with {{VAR}} interpolation.
// ---------------------------------------------------------------------------

const TABS = [
  {
    key: 'claude_analysis',
    label: '① Claude Analysis',
    summary: 'Step 1 — Sent to Claude with the reference ad image (+ product image if available). Claude extracts the layout and adapts the text for your product.',
    vars: '{{PRODUCT_NAME}} {{PRODUCT_PRICE}} {{PRODUCT_DESCRIPTION}} {{ANGLE}} {{BRAND_VOICE}} {{CUSTOMER}} {{BIG_PROMISE}} {{DIFFERENTIATOR}} {{UNIQUE_MECHANISM}} {{KEY_BENEFITS}} {{TARGET_AUDIENCE}} {{PAIN_POINTS}} {{INGREDIENTS}} {{WINNING_ANGLES}} {{OBJECTIONS}} {{OFFER_HOOK}} {{PRICING}} {{COMPLIANCE}} {{PRODUCT_IMAGE_NOTE}}',
  },
  {
    key: 'nanobanana_image',
    label: '② NanoBanana Image',
    summary: 'Step 2 — Sent to NanoBanana with the product image as the sole visual reference. Built from Claude\'s analysis output.',
    vars: '{{PRODUCT_NAME}} {{PRODUCT_INSTRUCTION}} {{PRODUCT_RULE}} {{VISUAL_CHANGES}} {{TEXT_SWAPS}} {{PEOPLE_COUNT}} {{CHARACTER_ADAPTATION}}',
  },
  {
    key: 'ai_adjustment',
    label: '③ AI Adjustment',
    summary: 'Optional Step — Sent to Claude when user clicks "Regenerate with Correction". Claude turns the user\'s freeform correction into a precise NanoBanana instruction.',
    vars: '{{PRODUCT_NAME}} {{ANGLE}} {{ADAPTED_HEADLINE}} {{ADAPTED_CTA}} {{PEOPLE_COUNT}} {{USER_CORRECTION}}',
  },
];

// ---------------------------------------------------------------------------
// Toast
// ---------------------------------------------------------------------------

function Toast({ type, message, onDismiss }) {
  useEffect(() => {
    const timer = setTimeout(onDismiss, 4000);
    return () => clearTimeout(timer);
  }, [onDismiss]);

  return (
    <div
      className={`flex items-center gap-2 px-4 py-2.5 rounded-lg border text-sm font-medium shadow-lg transition-all ${
        type === 'success'
          ? 'bg-emerald-950/90 border-emerald-500/30 text-emerald-200'
          : 'bg-red-950/90 border-red-500/30 text-red-200'
      }`}
    >
      {type === 'success' ? (
        <Check className="w-4 h-4 text-emerald-400 shrink-0" />
      ) : (
        <AlertCircle className="w-4 h-4 text-red-400 shrink-0" />
      )}
      <span>{message}</span>
      <button onClick={onDismiss} className="ml-2 p-0.5 rounded hover:bg-white/10 text-white/40 hover:text-white/80 transition-colors cursor-pointer">
        <X className="w-3.5 h-3.5" />
      </button>
    </div>
  );
}

// ---------------------------------------------------------------------------
// StaticsSettingsModal — 3 prompts, one large textarea per tab
// ---------------------------------------------------------------------------

export function StaticsSettingsModal({ isOpen, onClose }) {
  const [activeTab, setActiveTab] = useState('claude_analysis');
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [defaults, setDefaults] = useState({});
  const [values, setValues] = useState({});
  const [toast, setToast] = useState(null);

  // ---- Fetch settings ----
  const fetchSettings = useCallback(async () => {
    setLoading(true);
    try {
      const { data } = await api.get('/statics-generation/settings/prompts');
      const defs = data?.defaults || {};
      const cur = data?.current || {};
      setDefaults(defs);
      // Merge: current > defaults > empty string
      const merged = {};
      for (const tab of TABS) {
        merged[tab.key] = cur[tab.key] ?? defs[tab.key] ?? '';
      }
      setValues(merged);
    } catch (err) {
      console.error('Failed to load settings:', err);
      setToast({ type: 'error', message: 'Failed to load settings' });
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    if (isOpen) {
      fetchSettings();
    }
  }, [isOpen, fetchSettings]);

  // ---- Handlers ----
  const handleChange = (key, value) => {
    setValues((prev) => ({ ...prev, [key]: value }));
  };

  const handleResetField = (key) => {
    const defaultVal = defaults?.[key] ?? '';
    handleChange(key, defaultVal);
  };

  const handleSave = async () => {
    setSaving(true);
    try {
      // New backend expects { prompts: { claude_analysis, nanobanana_image, ai_adjustment } }
      const payload = { prompts: values };
      await api.put('/statics-generation/settings/prompts', payload);
      setToast({ type: 'success', message: 'Prompts saved successfully' });
    } catch (err) {
      console.error('Failed to save prompts:', err);
      const msg = err?.response?.data?.error || err?.message || 'Failed to save prompts';
      setToast({ type: 'error', message: msg });
    } finally {
      setSaving(false);
    }
  };

  const handleResetAll = async () => {
    try {
      await api.post('/statics-generation/settings/prompts/reset');
      await fetchSettings();
      setToast({ type: 'success', message: 'All 3 prompts reset to defaults' });
    } catch (err) {
      console.error('Failed to reset prompts:', err);
      setToast({ type: 'error', message: 'Failed to reset prompts' });
    }
  };

  const isFieldCustom = (key) => {
    const current = values?.[key] ?? '';
    const def = defaults?.[key] ?? '';
    return current !== def;
  };

  // ---- Don't render if closed ----
  if (!isOpen) return null;

  const tab = TABS.find((t) => t.key === activeTab) || TABS[0];

  return createPortal(
    <>
      {/* Backdrop */}
      <div className="fixed inset-0 bg-black/70 z-[9998]" onClick={onClose} />

      {/* Slide-over panel */}
      <div className="fixed inset-y-0 right-0 w-full max-w-3xl bg-bg-card border-l border-border-subtle z-[9999] flex flex-col animate-slide-in-right">
        {/* Header */}
        <div className="flex items-center justify-between px-6 py-4 border-b border-border-subtle shrink-0">
          <div>
            <h2 className="text-base font-semibold text-text-primary">Pipeline Prompt Settings</h2>
            <p className="text-xs text-text-muted mt-0.5">Edit the 3 prompts that drive the entire static-ad pipeline</p>
          </div>
          <button
            onClick={onClose}
            className="p-1.5 rounded-lg text-text-muted hover:text-text-primary hover:bg-bg-hover transition-colors cursor-pointer"
          >
            <X className="w-5 h-5" />
          </button>
        </div>

        {/* Tabs */}
        <div className="flex items-center gap-1 px-6 pt-4 pb-2 shrink-0">
          {TABS.map((t) => (
            <button
              key={t.key}
              type="button"
              onClick={() => setActiveTab(t.key)}
              className={`px-4 py-2 rounded-lg text-sm font-medium transition-colors cursor-pointer ${
                activeTab === t.key
                  ? 'bg-accent/15 text-accent-text'
                  : 'text-text-muted hover:text-text-primary hover:bg-bg-hover'
              }`}
            >
              {t.label}
            </button>
          ))}
        </div>

        {/* Step description + available vars */}
        {!loading && (
          <div className="px-6 pb-3 shrink-0">
            <p className="text-xs text-text-muted leading-relaxed">{tab.summary}</p>
            <p className="text-[11px] text-text-faint mt-1.5 font-mono break-words">
              Available variables: {tab.vars}
            </p>
          </div>
        )}

        {/* Content — single big textarea per tab */}
        <div className="flex-1 overflow-y-auto px-6 pb-4">
          {loading ? (
            <div className="flex items-center justify-center py-20">
              <Loader2 className="w-6 h-6 animate-spin text-accent" />
            </div>
          ) : (
            <div>
              <div className="flex items-center justify-between mb-1.5">
                <label className="text-xs text-text-muted block">Prompt template</label>
                {isFieldCustom(activeTab) && (
                  <button
                    type="button"
                    onClick={() => handleResetField(activeTab)}
                    className="flex items-center gap-1 text-xs text-red-400 hover:text-red-300 transition-colors cursor-pointer"
                  >
                    <RotateCcw className="w-3 h-3" />
                    Reset to Default
                  </button>
                )}
              </div>
              <textarea
                value={values?.[activeTab] ?? ''}
                onChange={(e) => handleChange(activeTab, e.target.value)}
                placeholder="Prompt template with {{VARIABLE}} markers..."
                rows={22}
                className="w-full bg-bg-main border border-border-default rounded-lg px-3 py-2.5 text-[13px] text-text-primary font-mono placeholder:text-text-faint resize-y focus:outline-none focus:border-accent/30 transition-colors leading-relaxed"
              />
              <p className="text-[11px] text-text-faint mt-2">
                Use <span className="font-mono text-text-muted">{'{{VARIABLE}}'}</span> syntax for dynamic values. Unknown variables are replaced with an empty string.
              </p>
            </div>
          )}
        </div>

        {/* Footer (sticky) */}
        {!loading && (
          <div className="flex items-center justify-between px-6 py-4 border-t border-border-subtle shrink-0">
            <button
              type="button"
              onClick={handleResetAll}
              className="flex items-center gap-2 px-4 py-2 rounded-lg text-sm font-medium border border-red-500/40 text-red-400 hover:bg-red-500/10 transition-colors cursor-pointer"
            >
              <RotateCcw className="w-4 h-4" />
              Reset All 3 Prompts
            </button>
            <button
              type="button"
              onClick={handleSave}
              disabled={saving}
              className="flex items-center gap-2 px-5 py-2 rounded-lg text-sm font-semibold bg-accent hover:bg-accent-hover text-bg-main shadow-[0_1px_12px_rgba(201,162,39,0.25)] transition-all cursor-pointer disabled:opacity-50 disabled:cursor-not-allowed"
            >
              {saving ? <Loader2 className="w-4 h-4 animate-spin" /> : <Check className="w-4 h-4" />}
              {saving ? 'Saving...' : 'Save Changes'}
            </button>
          </div>
        )}
      </div>

      {/* Toast */}
      {toast && (
        <div className="fixed bottom-6 right-6 z-[10000]">
          <Toast type={toast.type} message={toast.message} onDismiss={() => setToast(null)} />
        </div>
      )}

      {/* Slide-in animation */}
      <style>{`
        @keyframes slide-in-right {
          from { transform: translateX(100%); }
          to { transform: translateX(0); }
        }
        .animate-slide-in-right {
          animation: slide-in-right 0.25s ease-out;
        }
      `}</style>
    </>,
    document.body
  );
}

export default StaticsSettingsModal;
