import { useEffect, useState, useCallback, useMemo } from 'react';
import { useParams, useNavigate, Link } from 'react-router-dom';
import {
  ArrowLeft,
  Loader2,
  RefreshCw,
  AlertCircle,
  Flame,
  Trophy,
  Star,
  Sparkles,
  Eye,
  FileText,
  Trash2,
  Zap,
  AlertTriangle,
  Target,
  Play,
  ExternalLink,
  Clock,
  Palette,
  Users,
  Film,
  Volume2,
  Check,
} from 'lucide-react';
import api from '../../services/api';

// Source-driven header pill metadata. META + UPLOAD don't have a real tier,
// so we surface their source identity in the same slot.
const SOURCE_META = {
  meta:   { label: 'Our Winner', color: '#7dd3fc', bg: 'rgba(14,165,233,0.18)', border: 'rgba(14,165,233,0.45)' },
  upload: { label: 'Upload',     color: '#e4e4e7', bg: 'rgba(255,255,255,0.04)', border: 'rgba(255,255,255,0.12)' },
};

function fmt$(n) {
  if (n == null) return '$0';
  const abs = Math.abs(n);
  if (abs >= 1000) return `$${(n / 1000).toFixed(1)}k`;
  return `$${Math.round(n)}`;
}
function fmtRoas(n) { return `${(Number(n) || 0).toFixed(2)}×`; }

const TIER_META = {
  BANGER: { Icon: Flame,  label: 'Banger' },
  CHAMP:  { Icon: Trophy, label: 'Champ' },
  A:      { Icon: Star,   label: 'A-Tier' },
};

function timeAgo(iso) {
  if (!iso) return '';
  const t = new Date(iso).getTime();
  if (Number.isNaN(t)) return '';
  const secs = Math.max(1, Math.round((Date.now() - t) / 1000));
  if (secs < 60) return `${secs}s ago`;
  const m = Math.round(secs / 60);
  if (m < 60) return `${m}m ago`;
  const h = Math.round(m / 60);
  if (h < 24) return `${h}h ago`;
  const d = Math.round(h / 24);
  return `${d}d ago`;
}

function isHexColor(s) {
  return typeof s === 'string' && /^#[0-9a-fA-F]{6}$/.test(s.trim());
}

// ─────────────────────────────────────────────────────────────────────────
// Tiny presentational helpers
// ─────────────────────────────────────────────────────────────────────────

function SectionLabel({ icon: Icon, color, children }) {
  return (
    <div className="flex items-center gap-1.5 text-[10px] font-mono uppercase tracking-[0.18em] mb-2" style={{ color }}>
      {Icon && <Icon className="w-3 h-3" />}
      {children}
    </div>
  );
}

function PerfStat({ label, value }) {
  return (
    <div className="rounded-md bg-white/[0.02] border border-white/[0.04] px-2 py-1.5">
      <div className="text-[9px] font-mono uppercase tracking-wider text-zinc-500">{label}</div>
      <div className="text-xs font-mono text-zinc-100 mt-0.5">{value}</div>
    </div>
  );
}

function StrengthDot({ value }) {
  const v = String(value || '').toLowerCase();
  const color = v === 'strong' ? '#10b981' : v === 'medium' ? '#d4b55a' : v === 'weak' ? '#ef4444' : '#52525b';
  return (
    <span
      className="inline-block w-1.5 h-1.5 rounded-full shrink-0"
      style={{ background: color, boxShadow: `0 0 6px ${color}80` }}
      title={v || 'unrated'}
    />
  );
}

// ─────────────────────────────────────────────────────────────────────────
// Page
// ─────────────────────────────────────────────────────────────────────────

export default function BriefPipelineReferenceAnalysis() {
  const { id } = useParams();
  const navigate = useNavigate();

  const [reference, setReference] = useState(null);
  const [loadingRef, setLoadingRef] = useState(true);
  const [refError, setRefError] = useState(null);

  const [analyzing, setAnalyzing] = useState(false);
  const [analysisError, setAnalysisError] = useState(null);
  const [autoTriggered, setAutoTriggered] = useState(false);

  const [deleting, setDeleting] = useState(false);

  const isMeta   = reference?.source === 'meta';
  const isUpload = reference?.source === 'upload';
  const tierMeta = TIER_META[reference?.tier] || TIER_META.A;
  const sourceMeta = isMeta ? SOURCE_META.meta : isUpload ? SOURCE_META.upload : null;
  const perf       = reference?.importedMetadata || {};

  const fetchReference = useCallback(async () => {
    setLoadingRef(true);
    setRefError(null);
    try {
      const { data } = await api.get(`/brief-pipeline/references/${id}`);
      setReference(data.reference);
    } catch (err) {
      const msg = err.response?.data?.error?.message || err.message;
      setRefError(msg || 'Failed to load reference');
    } finally {
      setLoadingRef(false);
    }
  }, [id]);

  const runAnalysis = useCallback(async (force = false) => {
    if (analyzing) return;
    setAnalyzing(true);
    setAnalysisError(null);
    try {
      const { data } = await api.post(
        `/brief-pipeline/references/${id}/analyze${force ? '?force=1' : ''}`
      );
      setReference((prev) => prev ? {
        ...prev,
        analysis:      data.analysis,
        analyzedAt:    data.analyzedAt,
        analysisModel: data.analysisModel,
        analysisError: null,
      } : prev);
    } catch (err) {
      const msg = err.response?.data?.error?.message || err.message;
      setAnalysisError(msg || 'Analysis failed');
    } finally {
      setAnalyzing(false);
    }
  }, [id, analyzing]);

  // Initial load
  useEffect(() => { fetchReference(); }, [fetchReference]);

  // Auto-run analysis once on first load if not already cached
  useEffect(() => {
    if (loadingRef || !reference || autoTriggered) return;
    if (!reference.analysis && reference.videoUrl) {
      setAutoTriggered(true);
      runAnalysis(false);
    }
  }, [loadingRef, reference, autoTriggered, runAnalysis]);

  const handleDelete = useCallback(async () => {
    if (!reference || deleting) return;
    if (!window.confirm(`Delete this reference (${reference.brandName || 'untitled'})?`)) return;
    setDeleting(true);
    try {
      await api.delete(`/brief-pipeline/references/${reference.id}`);
      navigate('/app/brief-pipeline');
    } catch (err) {
      setDeleting(false);
      const msg = err.response?.data?.error?.message || err.message;
      alert(`Failed to delete: ${msg}`);
    }
  }, [reference, deleting, navigate]);

  const analysis = reference?.analysis || null;
  const visual = analysis?.visual || null;
  const narrative = analysis?.narrative_breakdown || null;

  const palette = useMemo(() => {
    return Array.isArray(visual?.color_palette)
      ? visual.color_palette.filter(isHexColor).slice(0, 8)
      : [];
  }, [visual]);

  // ─────────────────────────────────────────────────────────────────────
  // Render
  // ─────────────────────────────────────────────────────────────────────
  if (loadingRef) {
    return (
      <div className="flex flex-col items-center justify-center min-h-screen bg-[#111113] text-zinc-500 gap-3">
        <Loader2 className="w-6 h-6 animate-spin" />
        <p className="text-xs font-mono uppercase tracking-wider">Loading reference…</p>
      </div>
    );
  }

  if (refError || !reference) {
    return (
      <div className="flex flex-col items-center justify-center min-h-screen bg-[#111113] gap-3 text-center px-4">
        <AlertCircle className="w-6 h-6 text-red-400" />
        <p className="text-xs font-mono text-red-300">{refError || 'Reference not found.'}</p>
        <Link to="/app/brief-pipeline" className="text-xs font-mono text-zinc-400 hover:text-white underline">
          Back to Brief Pipeline
        </Link>
      </div>
    );
  }

  return (
    <div className="flex flex-col min-h-screen bg-[#0a0a0a] text-zinc-100 overflow-hidden relative">
      {/* Subtle background */}
      <div className="absolute inset-0 bg-dot-pattern pointer-events-none z-0 opacity-30" />
      <div
        className="absolute inset-0 pointer-events-none z-0"
        style={{
          background: 'radial-gradient(ellipse 60% 30% at 50% -10%, rgba(139,92,246,0.04) 0%, transparent 60%)',
        }}
      />

      <div className="relative z-10 flex flex-col h-screen w-full">
        {/* Header */}
        <header className="h-14 bg-[#0a0a0a]/90 backdrop-blur-md flex items-center justify-between px-5 shrink-0 border-b border-white/[0.05]">
          <div className="flex items-center gap-3 min-w-0">
            <Link
              to="/app/brief-pipeline"
              className="p-1.5 rounded-md text-zinc-500 hover:text-white hover:bg-white/[0.05] transition-colors"
              title="Back to Brief Pipeline"
            >
              <ArrowLeft className="w-4 h-4" />
            </Link>
            {sourceMeta ? (
              <span
                className="inline-flex items-center gap-1.5 px-2 py-1 rounded text-[10px] font-mono font-semibold uppercase tracking-wider border"
                style={{ color: sourceMeta.color, background: sourceMeta.bg, borderColor: sourceMeta.border }}
              >
                {isMeta ? <Sparkles className="w-3 h-3" /> : <Eye className="w-3 h-3" />}
                {sourceMeta.label}
                {isMeta && perf.roas != null && (
                  <span className="ml-1 text-[10px]">{fmtRoas(perf.roas)}</span>
                )}
              </span>
            ) : (
              <span className="inline-flex items-center gap-1.5 px-2 py-1 rounded text-[10px] font-mono font-semibold uppercase tracking-wider border bg-white/[0.04] border-white/[0.1] text-zinc-200">
                <tierMeta.Icon className="w-3 h-3" />
                {tierMeta.label}
              </span>
            )}
            <div className="min-w-0">
              <div className="text-sm text-white font-medium truncate leading-tight">
                {reference.headline || reference.brandName || 'Reference'}
              </div>
              <div className="text-[10px] font-mono text-zinc-500 truncate flex items-center gap-2">
                <span>{reference.brandName}</span>
                <span className="text-zinc-700">·</span>
                <span className="inline-flex items-center gap-1">
                  <Clock className="w-2.5 h-2.5" />
                  imported {timeAgo(reference.createdAt)}
                </span>
                {reference.analysisModel && (
                  <>
                    <span className="text-zinc-700">·</span>
                    <span>{reference.analysisModel}</span>
                  </>
                )}
                {reference.analysis?._provider === 'openai-fallback' && (
                  <>
                    <span className="text-zinc-700">·</span>
                    <span className="inline-flex items-center gap-1 text-amber-400/80" title="OpenAI fallback used — visual analysis is limited to the thumbnail; script analysis is full-depth.">
                      <AlertCircle className="w-2.5 h-2.5" />
                      thumbnail-only visual
                    </span>
                  </>
                )}
              </div>
            </div>
          </div>
          <div className="flex items-center gap-1.5">
            <button
              type="button"
              onClick={() => runAnalysis(true)}
              disabled={analyzing || !reference.videoUrl}
              className="inline-flex items-center gap-1.5 px-3 py-1.5 text-[11px] font-mono uppercase tracking-wider rounded-md border border-violet-500/30 bg-violet-500/10 text-violet-200 hover:bg-violet-500/15 hover:border-violet-500/50 transition-colors cursor-pointer disabled:opacity-40 disabled:cursor-not-allowed"
              title={reference.analysis ? 'Re-run the whole-video analysis (fresh tokens)' : 'Run the whole-video analysis'}
            >
              {analyzing ? <Loader2 className="w-3 h-3 animate-spin" /> : <RefreshCw className="w-3 h-3" />}
              {analyzing ? 'Analyzing…' : reference.analysis ? 'Re-analyze' : 'Analyze'}
            </button>
            <button
              type="button"
              onClick={handleDelete}
              disabled={deleting}
              className="p-1.5 rounded-md text-zinc-500 hover:text-red-300 hover:bg-red-500/10 transition-colors cursor-pointer disabled:opacity-40"
              title="Delete reference"
            >
              {deleting ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <Trash2 className="w-3.5 h-3.5" />}
            </button>
          </div>
        </header>

        {/* Body — 3 columns */}
        <div className="flex-1 grid grid-cols-12 gap-4 p-4 overflow-hidden min-h-0">
          {/* LEFT — Video + Visual + Script analysis */}
          <div className="col-span-5 overflow-y-auto pr-2 space-y-4 min-h-0">
            {/* Reference header card */}
            <div className="rounded-xl border border-white/[0.06] bg-white/[0.01] p-4">
              <SectionLabel color="#c9a84c">Reference</SectionLabel>
              <div className="text-sm text-white font-medium leading-snug mb-1">
                {reference.headline || reference.brandName || 'Untitled'}
              </div>
              <div className="text-[11px] text-zinc-500">{reference.brandName}</div>
              {reference.videoUrl && (
                <a
                  href={reference.videoUrl}
                  target="_blank"
                  rel="noopener noreferrer"
                  className="inline-flex items-center gap-1 mt-2 text-[11px] font-mono text-violet-300 hover:text-violet-200 transition-colors"
                >
                  Open original
                  <ExternalLink className="w-3 h-3" />
                </a>
              )}
            </div>

            {/* Video player */}
            <div className="rounded-xl border border-white/[0.06] bg-black overflow-hidden">
              {reference.videoUrl ? (
                <video
                  key={reference.id}
                  src={reference.videoUrl}
                  controls
                  playsInline
                  poster={reference.thumbnailUrl || undefined}
                  className="w-full max-h-[50vh] object-contain bg-black"
                />
              ) : (
                <div className="aspect-[9/16] flex items-center justify-center p-6 text-center text-xs text-zinc-500">
                  No direct video URL stored for this ad — analysis will be limited to the transcript.
                </div>
              )}
            </div>

            {/* Performance card — only for META refs (this is OUR winning ad) */}
            {isMeta && perf && Object.keys(perf).length > 0 && (
              <div
                className="rounded-xl border p-4"
                style={{ borderColor: 'rgba(14,165,233,0.25)', background: 'rgba(14,165,233,0.04)' }}
              >
                <SectionLabel icon={Sparkles} color="#7dd3fc">Performance</SectionLabel>
                <div className="grid grid-cols-3 gap-3 text-xs">
                  <PerfStat label="ROAS"        value={perf.roas != null ? fmtRoas(perf.roas) : '—'} />
                  <PerfStat label="Spend"       value={perf.spend != null ? fmt$(perf.spend) : '—'} />
                  <PerfStat label="Revenue"     value={perf.revenue != null ? fmt$(perf.revenue) : '—'} />
                  <PerfStat label="CPA"         value={perf.cpa != null && perf.cpa > 0 ? fmt$(perf.cpa) : '—'} />
                  <PerfStat label="CTR"         value={perf.ctr != null ? `${Number(perf.ctr).toFixed(1)}%` : '—'} />
                  <PerfStat label="Impressions" value={perf.impressions != null ? Number(perf.impressions).toLocaleString() : '—'} />
                </div>
                {perf.account_name && (
                  <div className="mt-3 pt-3 border-t border-white/[0.04] text-[10px] font-mono text-zinc-500">
                    Account: <span className="text-zinc-300">{perf.account_name}</span>
                    {perf.angle && <> · Angle: <span className="text-zinc-300">{perf.angle}</span></>}
                  </div>
                )}
              </div>
            )}

            {/* Analysis error banner */}
            {analysisError && (
              <div className="rounded-xl border border-red-500/30 bg-red-500/10 p-3 text-xs text-red-200 flex items-start gap-2">
                <AlertCircle className="w-4 h-4 shrink-0 mt-0.5" />
                <div>
                  <div className="font-semibold mb-1">Analysis failed</div>
                  <div className="text-[11px] text-red-300/90">{analysisError}</div>
                </div>
              </div>
            )}

            {/* Empty / loading state */}
            {!analysis && !analysisError && (
              <div className="rounded-xl border border-dashed border-white/[0.08] bg-white/[0.01] p-6 text-center">
                {analyzing ? (
                  <div className="flex flex-col items-center gap-2">
                    <Loader2 className="w-5 h-5 text-violet-400 animate-spin" />
                    <p className="text-xs font-mono uppercase tracking-wider text-zinc-400">
                      Gemini is watching the whole video…
                    </p>
                    <p className="text-[10px] text-zinc-600">
                      Visual + script breakdown · usually 30–90s
                    </p>
                  </div>
                ) : (
                  <p className="text-xs text-zinc-500">
                    No analysis yet. Click <span className="text-violet-300">Analyze</span> to start.
                  </p>
                )}
              </div>
            )}

            {/* Gemini Visual Analysis card */}
            {visual && (
              <div className="rounded-xl border border-white/[0.06] bg-white/[0.01] p-4">
                <SectionLabel icon={Eye} color="#a78bfa">Gemini Visual Analysis</SectionLabel>
                <div className="space-y-1.5 text-xs text-zinc-300">
                  {visual.setting && (
                    <div className="flex items-start gap-2">
                      <Film className="w-3 h-3 mt-0.5 text-zinc-500 shrink-0" />
                      <span>{visual.setting}</span>
                    </div>
                  )}
                  {visual.speaker_count != null && (
                    <div className="flex items-start gap-2">
                      <Users className="w-3 h-3 mt-0.5 text-zinc-500 shrink-0" />
                      <span>{visual.speaker_count} on-screen speaker{visual.speaker_count === 1 ? '' : 's'}</span>
                    </div>
                  )}
                  {(visual.cuts_count != null || visual.scene_type) && (
                    <div className="flex items-start gap-2">
                      <Volume2 className="w-3 h-3 mt-0.5 text-zinc-500 shrink-0" />
                      <span>
                        {visual.cuts_count != null && `${visual.cuts_count} cuts`}
                        {visual.cuts_count != null && visual.scene_type && ' · '}
                        {visual.scene_type}
                      </span>
                    </div>
                  )}
                  {Array.isArray(visual.captions) && visual.captions.length > 0 && (
                    <div className="pt-1.5 mt-1 border-t border-white/[0.04]">
                      <div className="text-[10px] font-mono uppercase tracking-wider text-zinc-500 mb-1.5">
                        Captions
                      </div>
                      <div className="flex flex-wrap gap-1">
                        {visual.captions.slice(0, 10).map((c, i) => (
                          <span
                            key={i}
                            className="text-[10px] font-mono px-1.5 py-0.5 rounded bg-white/[0.03] border border-white/[0.06] text-zinc-300"
                          >
                            "{c.length > 40 ? c.slice(0, 40) + '…' : c}"
                          </span>
                        ))}
                      </div>
                    </div>
                  )}
                  {palette.length > 0 && (
                    <div className="pt-1.5 mt-1 border-t border-white/[0.04]">
                      <div className="text-[10px] font-mono uppercase tracking-wider text-zinc-500 mb-1.5 inline-flex items-center gap-1">
                        <Palette className="w-2.5 h-2.5" /> Palette
                      </div>
                      <div className="flex items-center gap-1.5">
                        {palette.map((hex) => (
                          <div
                            key={hex}
                            className="w-7 h-7 rounded border border-white/[0.1]"
                            style={{ background: hex }}
                            title={hex}
                          />
                        ))}
                      </div>
                    </div>
                  )}
                  {visual.production_notes && (
                    <div className="pt-2 text-[11px] text-zinc-400 leading-relaxed italic">
                      {visual.production_notes}
                    </div>
                  )}
                </div>
              </div>
            )}

            {/* Narrative breakdown */}
            {narrative && (
              <div className="rounded-xl border border-white/[0.06] bg-white/[0.01] p-4 space-y-3">
                <SectionLabel icon={Target} color="#c9a84c">Narrative Breakdown</SectionLabel>
                {narrative.hook && (
                  <NarrativeBeat label="Hook" beat={narrative.hook} accent="#d4b55a" />
                )}
                {narrative.problem && (
                  <NarrativeBeat label="Problem" beat={narrative.problem} accent="#9ca3af" framedKey="framed" />
                )}
                {narrative.agitation && (
                  <NarrativeBeat label="Agitation" beat={narrative.agitation} accent="#9ca3af" framedKey="used" />
                )}
                {narrative.solution_intro && (
                  <NarrativeBeat label="Solution Intro" beat={narrative.solution_intro} accent="#9ca3af" />
                )}
                {Array.isArray(narrative.proof_points) && narrative.proof_points.length > 0 && (
                  <div>
                    <div className="text-[10px] font-mono uppercase tracking-wider text-zinc-500 mb-1.5">
                      Proof Points
                    </div>
                    <div className="space-y-1.5">
                      {narrative.proof_points.map((p, i) => (
                        <div key={i} className="flex items-start gap-2 text-xs text-zinc-300">
                          <StrengthDot value={p.strength} />
                          <div className="min-w-0">
                            {p.quote && <div className="text-zinc-200 italic">"{p.quote}"</div>}
                            {p.claim && <div className="text-zinc-400 mt-0.5">→ {p.claim}</div>}
                            {p.evidence_type && (
                              <div className="text-[10px] font-mono text-zinc-600 mt-0.5 uppercase tracking-wider">
                                {p.evidence_type}
                              </div>
                            )}
                          </div>
                        </div>
                      ))}
                    </div>
                  </div>
                )}
                {narrative.cta && (
                  <NarrativeBeat label="CTA" beat={narrative.cta} accent="#9ca3af" strengthKey="strength" />
                )}
              </div>
            )}
          </div>

          {/* CENTER — Transcript */}
          <div className="col-span-4 overflow-y-auto pr-2 min-h-0">
            <div className="rounded-xl border border-white/[0.06] bg-white/[0.01] p-4">
              <SectionLabel icon={FileText} color="#9ca3af">Transcript</SectionLabel>
              {reference.transcript ? (
                <div className="text-xs text-zinc-300 leading-relaxed whitespace-pre-wrap">
                  {reference.transcript}
                </div>
              ) : (
                <div className="text-xs text-zinc-500 italic">
                  No transcript on file. Open the original or re-import this ad after transcribing.
                </div>
              )}
            </div>
          </div>

          {/* RIGHT — Why it works / Triggers / Weaknesses / How to beat */}
          <div className="col-span-3 overflow-y-auto pr-2 space-y-4 min-h-0">
            {analysis?.why_it_works && (
              <div className="rounded-xl border border-white/[0.06] bg-white/[0.01] p-4">
                <SectionLabel icon={Sparkles} color="#c9a84c">Why It Works</SectionLabel>
                <p className="text-xs text-zinc-300 leading-relaxed">{analysis.why_it_works}</p>
              </div>
            )}

            {Array.isArray(analysis?.psychological_triggers) && analysis.psychological_triggers.length > 0 && (
              <div className="rounded-xl border border-white/[0.06] bg-white/[0.01] p-4">
                <SectionLabel icon={Zap} color="#a78bfa">Psychological Triggers</SectionLabel>
                <div className="space-y-2">
                  {analysis.psychological_triggers.map((t, i) => (
                    <div key={i} className="flex items-start gap-2 text-xs">
                      <StrengthDot value={t.strength} />
                      <div className="min-w-0">
                        <div className="text-zinc-200 font-medium">{t.trigger}</div>
                        {t.evidence && (
                          <div className="text-zinc-500 mt-0.5 leading-relaxed">{t.evidence}</div>
                        )}
                      </div>
                    </div>
                  ))}
                </div>
              </div>
            )}

            {Array.isArray(analysis?.weaknesses) && analysis.weaknesses.length > 0 && (
              <div className="rounded-xl border border-amber-500/20 bg-amber-500/[0.03] p-4">
                <SectionLabel icon={AlertTriangle} color="#f59e0b">Weaknesses</SectionLabel>
                <div className="space-y-2">
                  {analysis.weaknesses.map((w, i) => (
                    <div key={i} className="text-xs">
                      <div className="text-amber-300/90 font-medium">{w.label}</div>
                      {w.explanation && (
                        <div className="text-zinc-400 mt-0.5 leading-relaxed">{w.explanation}</div>
                      )}
                    </div>
                  ))}
                </div>
              </div>
            )}

            {analysis?.how_to_beat_it && (
              <div className="rounded-xl border border-emerald-500/25 bg-emerald-500/[0.04] p-4">
                <SectionLabel icon={Target} color="#10b981">
                  {isMeta ? 'How To Iterate' : 'How To Beat It'}
                </SectionLabel>
                <p className="text-xs text-zinc-200 leading-relaxed">{analysis.how_to_beat_it}</p>
              </div>
            )}

            {analysis?.adaptation_confidence && (
              <div className="rounded-xl border border-white/[0.06] bg-white/[0.01] p-3">
                <div className="flex items-center justify-between gap-2">
                  <SectionLabel color="#9ca3af">{isMeta ? 'Iteration Fit' : 'Adaptation Fit'}</SectionLabel>
                  <span
                    className="text-[10px] font-mono uppercase tracking-wider px-1.5 py-0.5 rounded border"
                    style={{
                      color:        analysis.adaptation_confidence === 'high' ? '#10b981' : analysis.adaptation_confidence === 'medium' ? '#d4b55a' : '#ef4444',
                      borderColor:  analysis.adaptation_confidence === 'high' ? 'rgba(16,185,129,0.3)' : analysis.adaptation_confidence === 'medium' ? 'rgba(201,168,76,0.3)' : 'rgba(239,68,68,0.3)',
                      background:   analysis.adaptation_confidence === 'high' ? 'rgba(16,185,129,0.08)' : analysis.adaptation_confidence === 'medium' ? 'rgba(201,168,76,0.08)' : 'rgba(239,68,68,0.08)',
                    }}
                  >
                    {analysis.adaptation_confidence}
                  </span>
                </div>
                {analysis.adaptation_confidence_reason && (
                  <p className="text-[11px] text-zinc-400 leading-relaxed mt-1">
                    {analysis.adaptation_confidence_reason}
                  </p>
                )}
              </div>
            )}

            {/* Next step placeholder */}
            <div className="rounded-xl border border-dashed border-white/[0.06] bg-white/[0.01] p-4 text-center">
              <p className="text-[10px] font-mono uppercase tracking-wider text-zinc-600 mb-1">
                Next Step
              </p>
              <p className="text-[11px] text-zinc-500 leading-relaxed">
                Rewrite reference + brief metadata + Generate Scripts will land in the next pass.
              </p>
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}

function NarrativeBeat({ label, beat, accent, framedKey, strengthKey }) {
  const truthy = framedKey ? beat?.[framedKey] : null;
  return (
    <div className="border-l-2 pl-3" style={{ borderColor: `${accent}55` }}>
      <div className="flex items-center gap-1.5 mb-1">
        <div className="text-[10px] font-mono uppercase tracking-wider" style={{ color: accent }}>
          {label}
        </div>
        {framedKey && truthy === false && (
          <span className="text-[9px] font-mono uppercase tracking-wider px-1 py-0.5 rounded bg-red-500/10 border border-red-500/25 text-red-300">
            absent
          </span>
        )}
        {framedKey && truthy === true && (
          <span className="text-[9px] font-mono uppercase tracking-wider px-1 py-0.5 rounded bg-emerald-500/10 border border-emerald-500/25 text-emerald-300 inline-flex items-center gap-0.5">
            <Check className="w-2 h-2" /> present
          </span>
        )}
        {strengthKey && beat?.[strengthKey] && (
          <span className="inline-flex items-center gap-1">
            <StrengthDot value={beat[strengthKey]} />
            <span className="text-[9px] font-mono uppercase tracking-wider text-zinc-500">{beat[strengthKey]}</span>
          </span>
        )}
      </div>
      {beat.quote && (
        <div className="text-xs text-zinc-200 italic leading-snug mb-1">"{beat.quote}"</div>
      )}
      {beat.analysis && (
        <div className="text-[11px] text-zinc-400 leading-relaxed">{beat.analysis}</div>
      )}
    </div>
  );
}
