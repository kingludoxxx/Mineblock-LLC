import React, { useState, useEffect } from 'react';
import {
  X,
  ChevronDown,
  ChevronRight,
  RefreshCw,
  Loader2,
  AlertTriangle,
  CheckCircle,
  Layout,
  Type,
  Palette,
  Image,
  Layers,
  BookOpen,
  Zap,
} from 'lucide-react';
import api from '../../../services/api';

const API_BASE = import.meta.env.VITE_API_URL || '';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function ColorSwatch({ color, label }) {
  if (!color) return null;
  return (
    <div className="flex items-center gap-2">
      <div
        className="w-5 h-5 rounded border border-gray-600 shrink-0"
        style={{ backgroundColor: color }}
      />
      <span className="text-sm text-gray-300">{color}</span>
      {label && <span className="text-xs text-gray-500">({label})</span>}
    </div>
  );
}

function Section({ title, icon: Icon, children, defaultOpen = false }) {
  const [isOpen, setIsOpen] = useState(defaultOpen);
  return (
    <div className="border border-white/[0.08] rounded-lg overflow-hidden">
      <button
        type="button"
        onClick={() => setIsOpen(!isOpen)}
        className="w-full flex items-center gap-2 px-4 py-3 bg-white/[0.03] hover:bg-white/[0.06] transition-colors text-left cursor-pointer"
      >
        <Icon className="w-4 h-4 text-blue-400 shrink-0" />
        <span className="text-sm font-medium text-slate-200 flex-1">{title}</span>
        {isOpen ? (
          <ChevronDown className="w-4 h-4 text-slate-400" />
        ) : (
          <ChevronRight className="w-4 h-4 text-slate-400" />
        )}
      </button>
      {isOpen && <div className="px-4 py-3 space-y-2">{children}</div>}
    </div>
  );
}

function InfoRow({ label, value }) {
  if (value === null || value === undefined || value === '') return null;
  return (
    <div className="flex justify-between items-start gap-4">
      <span className="text-xs text-slate-500 uppercase tracking-wide shrink-0">
        {label}
      </span>
      <span className="text-sm text-slate-300 text-right">
        {typeof value === 'object' ? JSON.stringify(value) : String(value)}
      </span>
    </div>
  );
}

// ---------------------------------------------------------------------------
// TemplateAnalysisModal
// ---------------------------------------------------------------------------

export default function TemplateAnalysisModal({ isOpen, onClose, template }) {
  const [analysis, setAnalysis] = useState(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState(null);

  // Sync analysis from template prop
  useEffect(() => {
    if (template?.deep_analysis) {
      setAnalysis(template.deep_analysis);
    } else {
      setAnalysis(null);
    }
    setError(null);
  }, [template]);

  // Close on Escape
  useEffect(() => {
    if (!isOpen) return;
    const handler = (e) => {
      if (e.key === 'Escape') onClose?.();
    };
    window.addEventListener('keydown', handler);
    return () => window.removeEventListener('keydown', handler);
  }, [isOpen, onClose]);

  const runAnalysis = async () => {
    if (!template?.id) return;
    setLoading(true);
    setError(null);
    try {
      const res = await api.post(`/statics-generation/templates/${template.id}/analyze`);
      const data = res.data;
      if (data.success) {
        setAnalysis(data.analysis);
      } else {
        setError(data.error || 'Analysis failed');
      }
    } catch (err) {
      const msg = err.response?.data?.error?.message || err.message || 'Network error';
      setError(msg);
    } finally {
      setLoading(false);
    }
  };

  if (!isOpen || !template) return null;

  const a = analysis; // shorthand

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/80 backdrop-blur-sm p-4">
      {/* Backdrop click to close */}
      <div className="absolute inset-0" onClick={onClose} />

      {/* Modal */}
      <div className="relative bg-[#111] rounded-xl border border-white/[0.08] w-full max-w-5xl max-h-[90vh] overflow-hidden flex flex-col shadow-2xl">
        {/* Header */}
        <div className="flex items-center justify-between px-6 py-4 border-b border-white/[0.06]">
          <h2 className="text-lg font-semibold text-white">Template Analysis</h2>
          <div className="flex items-center gap-2">
            <button
              type="button"
              onClick={runAnalysis}
              disabled={loading}
              className="flex items-center gap-1.5 px-3 py-1.5 text-sm bg-blue-600 hover:bg-blue-500 disabled:bg-slate-700 disabled:cursor-not-allowed text-white rounded-lg transition-colors cursor-pointer"
            >
              {loading ? (
                <Loader2 className="w-3.5 h-3.5 animate-spin" />
              ) : (
                <RefreshCw className="w-3.5 h-3.5" />
              )}
              {loading ? 'Analyzing...' : a ? 'Re-analyze' : 'Analyze Template'}
            </button>
            <button
              type="button"
              onClick={onClose}
              className="p-1.5 text-slate-400 hover:text-white rounded-lg hover:bg-white/[0.06] transition-colors cursor-pointer"
            >
              <X className="w-5 h-5" />
            </button>
          </div>
        </div>

        {/* Body */}
        <div className="flex-1 overflow-y-auto p-6">
          <div className="flex gap-6 flex-col lg:flex-row">
            {/* Left — Image */}
            <div className="lg:w-1/3 shrink-0">
              <img
                src={
                  template.image_url?.startsWith('/')
                    ? `${API_BASE}${template.image_url}`
                    : template.image_url
                }
                alt={template.name || 'Template'}
                className="w-full rounded-lg border border-white/[0.08] object-contain bg-black"
              />
              {template.name && (
                <p className="mt-2 text-sm text-slate-400 text-center">
                  {template.name}
                </p>
              )}
              {a?.analyzed_at && (
                <p className="mt-1 text-xs text-slate-600 text-center">
                  Analyzed: {new Date(a.analyzed_at).toLocaleDateString()}
                </p>
              )}
            </div>

            {/* Right — Analysis */}
            <div className="flex-1 space-y-3 min-w-0">
              {/* Error banner */}
              {error && (
                <div className="flex items-center gap-2 p-3 bg-red-500/10 border border-red-500/20 rounded-lg text-red-300 text-sm">
                  <AlertTriangle className="w-4 h-4 shrink-0" />
                  {error}
                </div>
              )}

              {/* Loading state (no existing analysis) */}
              {loading && !a && (
                <div className="flex flex-col items-center justify-center py-16 text-slate-400">
                  <Loader2 className="w-8 h-8 animate-spin mb-3" />
                  <p>Analyzing template with AI...</p>
                  <p className="text-xs text-slate-600 mt-1">
                    This may take 15-30 seconds
                  </p>
                </div>
              )}

              {/* Empty state */}
              {!a && !loading && (
                <div className="flex flex-col items-center justify-center py-16 text-slate-500">
                  <Zap className="w-8 h-8 mb-3" />
                  <p>No analysis yet</p>
                  <p className="text-xs mt-1">
                    Click &quot;Analyze Template&quot; to generate a deep
                    analysis
                  </p>
                </div>
              )}

              {/* Analysis sections */}
              {a && (
                <>
                  {/* Overview */}
                  <Section title="Overview" icon={BookOpen} defaultOpen={true}>
                    <InfoRow label="Type" value={a.template_type} />
                    <InfoRow label="Tone" value={a.emotional_tone} />
                    <InfoRow label="Target" value={a.target_audience} />
                    {a.ad_effectiveness_notes && (
                      <p className="text-sm text-slate-400 mt-2 italic">
                        {a.ad_effectiveness_notes}
                      </p>
                    )}
                  </Section>

                  {/* Layout & Structure */}
                  <Section title="Layout & Structure" icon={Layout}>
                    <InfoRow
                      label="Orientation"
                      value={a.layout?.orientation}
                    />
                    <InfoRow label="Grid" value={a.layout?.grid_structure} />
                    {Array.isArray(a.layout?.visual_hierarchy) &&
                      a.layout.visual_hierarchy.length > 0 && (
                        <div>
                          <span className="text-xs text-slate-500 uppercase tracking-wide">
                            Visual Hierarchy
                          </span>
                          <ol className="mt-1 space-y-1">
                            {a.layout.visual_hierarchy.map((item, i) => (
                              <li
                                key={i}
                                className="text-sm text-slate-300 flex items-center gap-2"
                              >
                                <span className="w-5 h-5 rounded-full bg-blue-600/30 text-blue-400 text-xs flex items-center justify-center shrink-0">
                                  {i + 1}
                                </span>
                                {item}
                              </li>
                            ))}
                          </ol>
                        </div>
                      )}
                    {a.layout?.safe_zones && (
                      <div className="mt-2 space-y-1">
                        <span className="text-xs text-slate-500 uppercase tracking-wide">
                          Safe Zones
                        </span>
                        <InfoRow
                          label="Product"
                          value={
                            a.layout.safe_zones.product_zone
                              ? `${a.layout.safe_zones.product_zone.position || '?'} (${a.layout.safe_zones.product_zone.size_percent || '?'}%)`
                              : undefined
                          }
                        />
                        <InfoRow
                          label="Logo"
                          value={a.layout.safe_zones.logo_zone?.position}
                        />
                        <InfoRow
                          label="CTA"
                          value={a.layout.safe_zones.cta_zone?.position}
                        />
                      </div>
                    )}
                  </Section>

                  {/* Typography */}
                  <Section title="Typography" icon={Type}>
                    <InfoRow
                      label="Total Elements"
                      value={a.typography?.total_text_elements}
                    />
                    {a.typography?.headline && (
                      <div className="p-2 bg-[#0a0a0a] border border-white/[0.06] rounded mt-1">
                        <span className="text-xs text-blue-400">Headline</span>
                        <p className="text-sm text-slate-200 font-medium">
                          {a.typography.headline.text_content}
                        </p>
                        <div className="flex gap-3 mt-1 flex-wrap">
                          {a.typography.headline.font_style && (
                            <span className="text-xs text-slate-500">
                              {a.typography.headline.font_style}
                            </span>
                          )}
                          {a.typography.headline.estimated_size && (
                            <span className="text-xs text-slate-500">
                              {a.typography.headline.estimated_size}
                            </span>
                          )}
                          <ColorSwatch color={a.typography.headline.color} />
                        </div>
                      </div>
                    )}
                    {a.typography?.subheadline?.text_content && (
                      <div className="p-2 bg-[#0a0a0a] border border-white/[0.06] rounded">
                        <span className="text-xs text-purple-400">
                          Subheadline
                        </span>
                        <p className="text-sm text-slate-200">
                          {a.typography.subheadline.text_content}
                        </p>
                      </div>
                    )}
                    {a.typography?.body_text?.text_content && (
                      <div className="p-2 bg-[#0a0a0a] border border-white/[0.06] rounded">
                        <span className="text-xs text-green-400">Body</span>
                        <p className="text-sm text-slate-200">
                          {a.typography.body_text.text_content}
                        </p>
                      </div>
                    )}
                    {a.typography?.cta_text?.text_content && (
                      <div className="p-2 bg-[#0a0a0a] border border-white/[0.06] rounded">
                        <span className="text-xs text-orange-400">CTA</span>
                        <p className="text-sm text-slate-200">
                          {a.typography.cta_text.text_content}
                        </p>
                        {a.typography.cta_text.style && (
                          <span className="text-xs text-slate-500">
                            {a.typography.cta_text.style}
                          </span>
                        )}
                      </div>
                    )}
                    {a.typography?.discount_code?.text_content && (
                      <div className="p-2 bg-yellow-900/30 border border-yellow-800/50 rounded">
                        <span className="text-xs text-yellow-400">
                          Discount Code
                        </span>
                        <p className="text-sm text-yellow-200 font-mono">
                          {a.typography.discount_code.text_content}
                        </p>
                      </div>
                    )}
                  </Section>

                  {/* Product Analysis */}
                  <Section title="Product Analysis" icon={Image}>
                    <InfoRow
                      label="Product Visible"
                      value={
                        a.product_analysis?.product_visible != null
                          ? a.product_analysis.product_visible
                            ? 'Yes'
                            : 'No'
                          : undefined
                      }
                    />
                    <InfoRow
                      label="Count"
                      value={a.product_analysis?.product_count}
                    />
                    <InfoRow
                      label="Type"
                      value={a.product_analysis?.product_type}
                    />
                    <InfoRow
                      label="Orientation"
                      value={a.product_analysis?.product_orientation}
                    />
                    <InfoRow
                      label="Cutout"
                      value={
                        a.product_analysis?.product_is_cutout != null
                          ? a.product_analysis.product_is_cutout
                            ? 'Yes'
                            : 'No'
                          : undefined
                      }
                    />
                    <InfoRow
                      label="Has Shadow"
                      value={
                        a.product_analysis?.product_has_shadow != null
                          ? a.product_analysis.product_has_shadow
                            ? 'Yes'
                            : 'No'
                          : undefined
                      }
                    />
                    <InfoRow
                      label="Has Packaging"
                      value={
                        a.product_analysis?.product_has_packaging != null
                          ? a.product_analysis.product_has_packaging
                            ? 'Yes'
                            : 'No'
                          : undefined
                      }
                    />
                    <InfoRow
                      label="Background"
                      value={
                        a.product_analysis?.product_background_interaction
                      }
                    />
                    <InfoRow
                      label="Category"
                      value={a.product_analysis?.reference_product_category}
                    />
                  </Section>

                  {/* Color Palette */}
                  <Section title="Color Palette" icon={Palette}>
                    <div className="grid grid-cols-2 gap-3">
                      <ColorSwatch
                        color={a.color_palette?.dominant}
                        label="Dominant"
                      />
                      <ColorSwatch
                        color={a.color_palette?.accent}
                        label="Accent"
                      />
                      <ColorSwatch
                        color={a.color_palette?.text_primary}
                        label="Text Primary"
                      />
                      <ColorSwatch
                        color={a.color_palette?.text_secondary}
                        label="Text Secondary"
                      />
                    </div>
                    <InfoRow label="Mood" value={a.color_palette?.overall_mood} />
                    {a.background && (
                      <div className="mt-2 space-y-1">
                        <InfoRow
                          label="Background Type"
                          value={a.background.type}
                        />
                        <ColorSwatch
                          color={a.background.primary_color}
                          label="BG Primary"
                        />
                        {a.background.secondary_color && (
                          <ColorSwatch
                            color={a.background.secondary_color}
                            label="BG Secondary"
                          />
                        )}
                      </div>
                    )}
                  </Section>

                  {/* Design Elements */}
                  <Section title="Design Elements" icon={Layers}>
                    <div className="flex flex-wrap gap-2">
                      {a.design_elements?.has_border && (
                        <span className="px-2 py-1 bg-white/[0.04] border border-white/[0.08] rounded text-xs text-slate-300">
                          Border
                        </span>
                      )}
                      {a.design_elements?.has_badge && (
                        <span className="px-2 py-1 bg-white/[0.04] border border-white/[0.08] rounded text-xs text-slate-300">
                          Badge: {a.design_elements.badge_text || 'Yes'}
                        </span>
                      )}
                      {a.design_elements?.has_icon && (
                        <span className="px-2 py-1 bg-white/[0.04] border border-white/[0.08] rounded text-xs text-slate-300">
                          Icons
                        </span>
                      )}
                      {a.design_elements?.has_pattern && (
                        <span className="px-2 py-1 bg-white/[0.04] border border-white/[0.08] rounded text-xs text-slate-300">
                          Pattern
                        </span>
                      )}
                      {a.design_elements?.has_divider && (
                        <span className="px-2 py-1 bg-white/[0.04] border border-white/[0.08] rounded text-xs text-slate-300">
                          Divider
                        </span>
                      )}
                      {a.design_elements?.rounded_corners && (
                        <span className="px-2 py-1 bg-white/[0.04] border border-white/[0.08] rounded text-xs text-slate-300">
                          Rounded
                        </span>
                      )}
                    </div>
                    <InfoRow
                      label="Shadows"
                      value={a.design_elements?.shadow_effects}
                    />
                    {Array.isArray(a.design_elements?.decorative_elements) &&
                      a.design_elements.decorative_elements.length > 0 && (
                        <InfoRow
                          label="Decorative"
                          value={a.design_elements.decorative_elements.join(
                            ', '
                          )}
                        />
                      )}
                  </Section>

                  {/* Adaptation Guide */}
                  <Section title="Adaptation Guide" icon={Zap}>
                    <InfoRow
                      label="Replacement Difficulty"
                      value={
                        a.adaptation_instructions
                          ?.product_replacement_difficulty
                      }
                    />
                    <InfoRow
                      label="Text Strategy"
                      value={
                        a.adaptation_instructions?.text_replacement_strategy
                      }
                    />
                    {a.adaptation_instructions?.product_replacement_notes && (
                      <p className="text-sm text-slate-400 italic">
                        {a.adaptation_instructions.product_replacement_notes}
                      </p>
                    )}
                    {Array.isArray(
                      a.adaptation_instructions
                        ?.critical_elements_to_preserve
                    ) &&
                      a.adaptation_instructions.critical_elements_to_preserve
                        .length > 0 && (
                        <div>
                          <span className="text-xs text-green-500 uppercase tracking-wide">
                            Must Preserve
                          </span>
                          <ul className="mt-1 space-y-1">
                            {a.adaptation_instructions.critical_elements_to_preserve.map(
                              (item, i) => (
                                <li
                                  key={i}
                                  className="text-sm text-slate-300 flex items-center gap-2"
                                >
                                  <CheckCircle className="w-3 h-3 text-green-500 shrink-0" />
                                  {item}
                                </li>
                              )
                            )}
                          </ul>
                        </div>
                      )}
                    {Array.isArray(
                      a.adaptation_instructions?.common_failure_modes
                    ) &&
                      a.adaptation_instructions.common_failure_modes.length >
                        0 && (
                        <div>
                          <span className="text-xs text-red-500 uppercase tracking-wide">
                            Common Failures to Avoid
                          </span>
                          <ul className="mt-1 space-y-1">
                            {a.adaptation_instructions.common_failure_modes.map(
                              (item, i) => (
                                <li
                                  key={i}
                                  className="text-sm text-red-300 flex items-center gap-2"
                                >
                                  <AlertTriangle className="w-3 h-3 text-red-500 shrink-0" />
                                  {item}
                                </li>
                              )
                            )}
                          </ul>
                        </div>
                      )}
                  </Section>
                </>
              )}
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}
