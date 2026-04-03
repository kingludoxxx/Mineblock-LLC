import { useState, useEffect, useCallback } from 'react';
import { createPortal } from 'react-dom';
import { X, Loader2, RotateCcw, Check, AlertCircle } from 'lucide-react';
import api from '../../../services/api';

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const TABS = [
  { key: 'claudeAnalysis', label: 'Claude Analysis' },
  { key: 'nanoBanana', label: 'Image Generation' },
];

const FIELD_CONFIG = {
  claudeAnalysis: [
    { key: 'productIdentity', label: 'Product Identity', type: 'textarea', placeholder: 'Product identity description...' },
    { key: 'headlineRules', label: 'Headline Rules', type: 'textarea', placeholder: 'Rules for headline generation...' },
    { key: 'headlineExamples', label: 'Headline Examples', type: 'textarea', placeholder: 'Example headlines for inspiration...' },
    { key: 'pricingRules', label: 'Pricing Rules', type: 'textarea', placeholder: 'Pricing constraints...' },
    { key: 'formulaPreservation', label: 'Formula Preservation', type: 'textarea', placeholder: 'Rules for preserving copywriting formulas...' },
    { key: 'crossNicheAdaptation', label: 'Cross-Niche Adaptation', type: 'textarea', placeholder: 'Rules for adapting across product niches...' },
    { key: 'visualAdaptation', label: 'Visual Adaptation', type: 'textarea', placeholder: 'How to map visual elements to your product...' },
    { key: 'bannedPhrases', label: 'Banned Phrases', type: 'input', placeholder: 'Comma-separated banned phrases...' },
  ],
  nanoBanana: [
    { key: 'productRules', label: 'Product Replacement Rules', type: 'textarea', placeholder: 'Product replacement rules...' },
    { key: 'textRules', label: 'Text Rendering Rules', type: 'textarea', placeholder: 'Text rendering rules...' },
    { key: 'absoluteRules', label: 'Absolute Rules / Constraints', type: 'textarea', placeholder: 'Absolute rules/constraints...' },
  ],
};

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
// StaticsSettingsModal
// ---------------------------------------------------------------------------

export function StaticsSettingsModal({ isOpen, onClose }) {
  const [activeTab, setActiveTab] = useState('claudeAnalysis');
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
      setDefaults(data.defaults || {});
      // Merge: use custom values where they exist, otherwise defaults
      const merged = {};
      for (const section of Object.keys(FIELD_CONFIG)) {
        merged[section] = {};
        for (const field of FIELD_CONFIG[section]) {
          merged[section][field.key] =
            data.custom?.[section]?.[field.key] ?? data.defaults?.[section]?.[field.key] ?? '';
        }
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
  const handleChange = (section, key, value) => {
    setValues((prev) => ({
      ...prev,
      [section]: { ...prev[section], [key]: value },
    }));
  };

  const handleResetField = (section, key) => {
    const defaultVal = defaults?.[section]?.[key] ?? '';
    handleChange(section, key, defaultVal);
  };

  const handleSave = async () => {
    setSaving(true);
    try {
      await api.put('/statics-generation/settings/prompts', { prompts: values });
      setToast({ type: 'success', message: 'Settings saved successfully' });
    } catch (err) {
      console.error('Failed to save settings:', err);
      setToast({ type: 'error', message: 'Failed to save settings' });
    } finally {
      setSaving(false);
    }
  };

  const handleResetAll = async () => {
    try {
      await api.post('/statics-generation/settings/prompts/reset');
      await fetchSettings();
      setToast({ type: 'success', message: 'All prompts reset to defaults' });
    } catch (err) {
      console.error('Failed to reset settings:', err);
      setToast({ type: 'error', message: 'Failed to reset settings' });
    }
  };

  const isFieldCustom = (section, key) => {
    const current = values?.[section]?.[key] ?? '';
    const def = defaults?.[section]?.[key] ?? '';
    return current !== def;
  };

  // ---- Don't render if closed ----
  if (!isOpen) return null;

  const fields = FIELD_CONFIG[activeTab] || [];

  return createPortal(
    <>
      {/* Backdrop */}
      <div className="fixed inset-0 bg-black/70 z-[9998]" onClick={onClose} />

      {/* Slide-over panel */}
      <div className="fixed inset-y-0 right-0 w-full max-w-2xl bg-bg-card border-l border-border-subtle z-[9999] flex flex-col animate-slide-in-right">
        {/* Header */}
        <div className="flex items-center justify-between px-6 py-4 border-b border-border-subtle shrink-0">
          <h2 className="text-base font-semibold text-text-primary">Prompt &amp; Logic Settings</h2>
          <button
            onClick={onClose}
            className="p-1.5 rounded-lg text-text-muted hover:text-text-primary hover:bg-bg-hover transition-colors cursor-pointer"
          >
            <X className="w-5 h-5" />
          </button>
        </div>

        {/* Tabs */}
        <div className="flex items-center gap-1 px-6 pt-4 pb-2 shrink-0">
          {TABS.map((tab) => (
            <button
              key={tab.key}
              type="button"
              onClick={() => setActiveTab(tab.key)}
              className={`px-4 py-2 rounded-lg text-sm font-medium transition-colors cursor-pointer ${
                activeTab === tab.key
                  ? 'bg-accent/15 text-accent-text'
                  : 'text-text-muted hover:text-text-primary hover:bg-bg-hover'
              }`}
            >
              {tab.label}
            </button>
          ))}
        </div>

        {/* Content */}
        <div className="flex-1 overflow-y-auto px-6 py-4 space-y-5">
          {loading ? (
            <div className="flex items-center justify-center py-20">
              <Loader2 className="w-6 h-6 animate-spin text-accent" />
            </div>
          ) : (
            fields.map((field) => (
              <div key={field.key}>
                <div className="flex items-center justify-between mb-1.5">
                  <label className="text-xs text-text-muted block">{field.label}</label>
                  {isFieldCustom(activeTab, field.key) && (
                    <button
                      type="button"
                      onClick={() => handleResetField(activeTab, field.key)}
                      className="flex items-center gap-1 text-xs text-red-400 hover:text-red-300 transition-colors cursor-pointer"
                    >
                      <RotateCcw className="w-3 h-3" />
                      Reset to Default
                    </button>
                  )}
                </div>
                {field.type === 'textarea' ? (
                  <textarea
                    value={values?.[activeTab]?.[field.key] ?? ''}
                    onChange={(e) => handleChange(activeTab, field.key, e.target.value)}
                    placeholder={field.placeholder}
                    rows={6}
                    className="w-full bg-bg-main border border-border-default rounded-lg px-3 py-2.5 text-sm text-text-primary font-mono placeholder:text-text-faint resize-y focus:outline-none focus:border-accent/30 transition-colors"
                  />
                ) : (
                  <input
                    type="text"
                    value={values?.[activeTab]?.[field.key] ?? ''}
                    onChange={(e) => handleChange(activeTab, field.key, e.target.value)}
                    placeholder={field.placeholder}
                    className="w-full bg-bg-main border border-border-default rounded-lg px-3 py-2.5 text-sm text-text-primary placeholder:text-text-faint focus:outline-none focus:border-accent/30 transition-colors"
                  />
                )}
              </div>
            ))
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
              Reset All to Defaults
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
