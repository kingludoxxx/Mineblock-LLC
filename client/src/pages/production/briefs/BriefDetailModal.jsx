import { useState, useEffect, useRef } from 'react';
import {
  X,
  Check,
  ThumbsDown,
  ExternalLink,
  ChevronDown,
  ChevronRight,
  Brain,
  Zap,
  Target,
  Shield,
  Loader2,
  Sparkles,
  Save,
  Send,
  Trash2,
  Plus,
  Play,
  Film,
} from 'lucide-react';
import api from '../../../services/api';

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const SCORE_CONFIG = {
  novelty:    { label: 'Novelty',    icon: Zap,    color: 'bg-purple-500/10 text-purple-300 border-purple-500/20' },
  aggression: { label: 'Aggression', icon: Target, color: 'bg-red-500/10 text-red-300 border-red-500/20' },
  coherence:  { label: 'Coherence',  icon: Brain,  color: 'bg-[#c9a84c]/10 text-[#e8d5a3] border-[#c9a84c]/20' },
  overall:    { label: 'Overall',    icon: Shield, color: 'bg-emerald-500/10 text-emerald-300 border-emerald-500/20' },
};

// Quick-action chips fed to the AI chat box. They expand to a sensible
// natural-language instruction when clicked. Curated to match the most
// common edits Ludo asks for during reviews.
const QUICK_ACTIONS = [
  { label: 'More aggressive', prompt: 'Make all hooks more aggressive and confrontational, sharpen the body to match.' },
  { label: 'Shorter hooks',   prompt: 'Compress every hook to under 12 words while keeping the same angle and tension.' },
  { label: 'Add a stat',      prompt: 'Inject a concrete number or stat into hook 1 and the first body paragraph.' },
  { label: 'Try fear angle',  prompt: 'Rewrite hook 1 with a fear-of-missing-out framing. Keep the other hooks intact.' },
  { label: 'Discount label',  prompt: 'Add a top-banner discount label to highlighted_text in the BIGGEST SALE 🇺🇸 style.' },
  { label: 'Apology overlay', prompt: 'Replace highlighted_text with a 2-label PUBLIC APOLOGY 👁️ / WE LIED 🤥 style framing.' },
];

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function SectionLabel({ children, actions }) {
  return (
    <div className="flex items-center justify-between mb-3">
      <h4 className="font-mono text-xs tracking-[0.15em] uppercase text-[#c9a84c] font-semibold">
        {children}
      </h4>
      {actions}
    </div>
  );
}

function ScoreCard({ scoreKey, value }) {
  const config = SCORE_CONFIG[scoreKey];
  if (!config) return null;
  const Icon = config.icon;
  return (
    <div className={`flex-1 flex flex-col items-center gap-1 py-3 px-2 rounded-lg border ${config.color}`}>
      <Icon className="w-3.5 h-3.5" />
      <span className="text-lg font-bold leading-none">{value ?? '—'}</span>
      <span className="text-[10px] opacity-70 font-mono uppercase tracking-wider">{config.label}</span>
    </div>
  );
}

// Normalize highlighted_text into a JS array regardless of how it arrives
// (some endpoints still hand back the string "[]" on older rows).
function parseHighlighted(raw) {
  if (Array.isArray(raw)) return raw.filter(Boolean).map((s) => String(s));
  if (typeof raw === 'string') {
    try { const a = JSON.parse(raw); return Array.isArray(a) ? a.filter(Boolean).map(String) : []; }
    catch { return []; }
  }
  return [];
}

// ---------------------------------------------------------------------------
// BriefDetailModal
// ---------------------------------------------------------------------------

// ReferenceMedia — renders an embedded video player when the source has a
// direct video file URL (Meta refs from Triple Whale typically do), or a
// clickable thumbnail card when only a sourceUrl is known (League refs from
// the FB Ad Library). Always shows the "Watch source ad" link to sourceUrl
// so the editor can open the original in a new tab no matter what.
function ReferenceMedia({ reference }) {
  const { videoUrl, thumbnailUrl, sourceUrl, headline, brandName, source } = reference || {};
  // True when the URL looks like a direct video file (mp4/webm/mov/m4v),
  // OR when it points at our own R2/CDN. Avoids trying to render an FB
  // Ad Library page URL inside a <video> element.
  const isPlayableVideo =
    typeof videoUrl === 'string' && /\.(mp4|webm|mov|m4v)(\?|$)/i.test(videoUrl);
  return (
    <div className="glass-card border border-white/[0.04] rounded-lg overflow-hidden bg-white/[0.02]">
      {isPlayableVideo ? (
        <video
          src={videoUrl}
          controls
          playsInline
          preload="metadata"
          poster={thumbnailUrl || undefined}
          className="w-full aspect-[9/16] max-h-[420px] bg-black object-contain"
        />
      ) : thumbnailUrl ? (
        <a
          href={sourceUrl || videoUrl || '#'}
          target="_blank"
          rel="noopener noreferrer"
          className="relative block group"
          aria-label="Open source ad in a new tab"
        >
          <img
            src={thumbnailUrl}
            alt={headline || brandName || 'Source ad thumbnail'}
            className="w-full aspect-[9/16] max-h-[420px] object-cover bg-black"
          />
          <div className="absolute inset-0 flex items-center justify-center bg-black/40 group-hover:bg-black/30 transition-colors">
            <div className="flex items-center gap-2 px-3 py-2 rounded-full bg-white/10 border border-white/20 backdrop-blur-sm">
              <Play className="w-4 h-4 text-white" fill="currentColor" />
              <span className="text-xs font-mono uppercase tracking-wider text-white">Watch source</span>
            </div>
          </div>
        </a>
      ) : (
        <div className="aspect-[9/16] max-h-[300px] flex items-center justify-center text-zinc-600 bg-black/40">
          <Film className="w-8 h-8" />
        </div>
      )}
      <div className="p-3 space-y-2">
        {(brandName || headline) && (
          <div className="text-[10px] font-mono uppercase tracking-wider text-zinc-500 truncate">
            {[brandName, source ? source.toUpperCase() : null].filter(Boolean).join(' · ')}
          </div>
        )}
        {headline && (
          <div className="text-xs text-zinc-300 leading-snug line-clamp-2">{headline}</div>
        )}
        {sourceUrl && (
          <a
            href={sourceUrl}
            target="_blank"
            rel="noopener noreferrer"
            className="inline-flex items-center gap-1.5 text-[10px] font-mono uppercase tracking-wider text-[#c9a84c] hover:text-[#e8d5a3] transition-colors"
          >
            <ExternalLink className="w-3 h-3" />
            Open in source
          </a>
        )}
      </div>
    </div>
  );
}

export default function BriefDetailModal({
  brief,
  isOpen,
  onClose,
  onApprove,
  onReject,
  onMoveToReady,
  onPushToClickup,
  onLaunch,
  onMarkLaunched,
  onMoveBackToApproved,
  onSave,
  originalScript,
  originalRawScript,
  winAnalysis,
}) {
  // Parse the raw transcript Vertex multimodal emits — it interleaves
  // - [ON-SCREEN TEXT] block (one fragment per line, ALL CAPS subtitle dump)
  // - [AUDIO / VOICEOVER] block (the actual spoken script in a paragraph)
  // - [SELLING MESSAGE], [BRAND], [VISUAL NARRATIVE] etc. — analyzer
  //   metadata that the operator doesn't want to see in the script panel.
  // Operator only wants to see the spoken script flowing normally; the
  // on-screen lines surface separately as small chips so they're still
  // visible at a glance without dominating the column.
  const parsedTranscript = (() => {
    if (!originalRawScript) return null;
    // Strip every metadata section by name. The bracket sections we want
    // GONE from the rendered script entirely, regardless of where in the
    // transcript they appear. Run before extracting the audio block so
    // even if the audio match captures too greedily, no metadata leaks
    // through.
    const METADATA_STRIP_REGEX = /\[(?:SELLING\s*MESSAGE|BRAND|METADATA|VISUAL\s*NARRATIVE|ANALYSIS|NOTES|CTA)\][\s\S]*?(?=\n\s*\[[A-Z]|$)/gi;
    const cleaned = originalRawScript.replace(METADATA_STRIP_REGEX, '').trim();

    const onScreenMatch  = cleaned.match(/\[ON[- ]?SCREEN\s*TEXT\]\s*([\s\S]*?)(?=\n\s*\[[A-Z]|$)/i);
    const audioMatch     = cleaned.match(/\[(?:AUDIO\s*\/?\s*VOICEOVER|AUDIO|VOICEOVER)\]\s*([\s\S]*?)(?=\n\s*\[[A-Z]|$)/i);
    const rawOnScreenLines  = onScreenMatch
      ? onScreenMatch[1].split('\n').map((s) => s.trim()).filter(Boolean)
      : [];
    let spoken = audioMatch ? audioMatch[1].trim() : '';
    // Caption dedup applied at READ time so old cached transcripts (Vertex
    // run BEFORE the prompt + dedup landed) also get cleaned up in the UI.
    // Matches the heuristic in server/src/services/videoTranscribe.js:
    //   - keep framing panels (≥20 words AND ≥2 sentences)
    //   - drop ALL-CAPS lines whose every meaningful token appears in audio
    //   - drop any 2+ word line whose normalised form is a substring of
    //     normalised audio
    const onScreenLines = (() => {
      if (rawOnScreenLines.length === 0 || !spoken) return rawOnScreenLines;
      const norm = (s) => String(s || '')
        .toLowerCase()
        .replace(/[^\p{L}\p{N}\s]/gu, ' ')
        .replace(/\s+/g, ' ')
        .trim();
      const normalisedAudio = norm(spoken);
      const audioWordSet = new Set(normalisedAudio.split(' ').filter((w) => w.length > 2));
      const isFramingPanel = (line) => {
        const wc = line.split(/\s+/).filter(Boolean).length;
        const sentenceCount = (line.match(/[.!?](\s|$)/g) || []).length;
        return wc >= 20 && sentenceCount >= 2;
      };
      const survivors = [];
      for (const line of rawOnScreenLines) {
        const n = norm(line);
        if (!n) continue;
        if (isFramingPanel(line)) { survivors.push(line); continue; }
        // ALL-CAPS teleprompter fragment whose tokens all appear in audio.
        if (/^[A-Z0-9\s\W]+$/.test(line) && line === line.toUpperCase()) {
          const tokens = n.split(' ').filter((w) => w.length > 2);
          if (tokens.length > 0 && tokens.every((w) => audioWordSet.has(w))) continue;
        }
        // Multi-word line whose normalised form is a substring of audio.
        if (n.split(' ').length >= 2 && normalisedAudio.includes(n)) continue;
        survivors.push(line);
      }
      return survivors;
    })();
    if (!spoken) {
      // No labeled audio block — strip the on-screen block too and show
      // whatever paragraph remains. Covers Whisper-only sources (Forge-class
      // refs) which have no section labels at all.
      spoken = cleaned
        .replace(/\[ON[- ]?SCREEN\s*TEXT\][\s\S]*?(?=\n\s*\[[A-Z]|$)/i, '')
        .replace(/\[(?:AUDIO|VOICEOVER)[^\]]*\]\s*/gi, '')
        .trim();
    }
    // Defence in depth — if any [SECTION] tag still survived, scrub it.
    spoken = spoken.replace(/\[(?:SELLING\s*MESSAGE|BRAND|METADATA|VISUAL\s*NARRATIVE|ANALYSIS|NOTES|CTA)\][\s\S]*$/gi, '').trim();
    return { onScreenLines, spoken };
  })();
  const [winAnalysisOpen, setWinAnalysisOpen] = useState(false);
  const [editableHooks, setEditableHooks] = useState([]);
  const [editableBody, setEditableBody] = useState('');
  const [editableHighlighted, setEditableHighlighted] = useState([]);
  const [hasChanges, setHasChanges] = useState(false);
  const [aiPrompt, setAiPrompt] = useState('');
  const [aiBusy, setAiBusy] = useState(false);
  const [aiHistory, setAiHistory] = useState([]); // [{ role:'user'|'ai', text, summary }]
  const [saving, setSaving] = useState(false);
  const chatScrollRef = useRef(null);

  useEffect(() => {
    if (!brief) return;
    const parsedHooks = (() => {
      if (Array.isArray(brief.hooks)) return brief.hooks;
      if (typeof brief.hooks === 'string') { try { return JSON.parse(brief.hooks); } catch { return []; } }
      return [];
    })();
    setEditableHooks(parsedHooks);
    setEditableBody(brief.body || '');
    setEditableHighlighted(parseHighlighted(brief.highlighted_text));
    setHasChanges(false);
    setAiHistory([]);
    setAiPrompt('');
  }, [brief?.id]);

  // Auto-scroll AI chat to bottom on new messages
  useEffect(() => {
    if (chatScrollRef.current) {
      chatScrollRef.current.scrollTop = chatScrollRef.current.scrollHeight;
    }
  }, [aiHistory.length, aiBusy]);

  if (!isOpen || !brief) return null;

  const status = brief.status || 'generated';
  const scores = {
    novelty:    brief.novelty_score,
    aggression: brief.aggression_score,
    coherence:  brief.coherence_score,
    overall:    brief.overall_score,
  };
  const hasScores = Object.values(scores).some((v) => v != null);

  const originalHooks = (() => {
    if (!originalScript) return [];
    let obj = originalScript;
    if (typeof obj === 'string') { try { obj = JSON.parse(obj); } catch { return []; } }
    if (Array.isArray(obj.hooks)) return obj.hooks;
    if (Array.isArray(obj)) return obj;
    return [];
  })();

  const originalBody = (() => {
    if (!originalScript) return null;
    let obj = originalScript;
    if (typeof obj === 'string') { try { obj = JSON.parse(obj); } catch { return null; } }
    return obj.body || obj.script || obj.text || null;
  })();

  const handleAi = async (instructionOverride) => {
    const instruction = (instructionOverride ?? aiPrompt).trim();
    if (!instruction || aiBusy) return;
    setAiBusy(true);
    const userTurn = { role: 'user', text: instruction };
    setAiHistory((h) => [...h, userTurn]);
    setAiPrompt('');
    try {
      const { data } = await api.post(`/brief-pipeline/generated/${brief.id}/enhance`, {
        instruction,
        currentHooks: editableHooks,
        currentBody: editableBody,
        currentHighlightedText: editableHighlighted,
      });
      if (Array.isArray(data.hooks)) setEditableHooks(data.hooks);
      if (typeof data.body === 'string') setEditableBody(data.body);
      if (Array.isArray(data.highlighted_text)) setEditableHighlighted(data.highlighted_text);
      setHasChanges(true);
      setAiHistory((h) => [...h, { role: 'ai', text: data.edit_summary || 'Applied.', summary: data.edit_summary }]);
    } catch (err) {
      const msg = err.response?.data?.error?.message || err.message || 'AI edit failed';
      setAiHistory((h) => [...h, { role: 'ai', text: `Error: ${msg}` }]);
    } finally {
      setAiBusy(false);
    }
  };

  const handleDeleteHook = (idx) => {
    setEditableHooks((prev) => prev.filter((_, i) => i !== idx));
    setHasChanges(true);
  };

  const handleDeleteHighlight = (idx) => {
    setEditableHighlighted((prev) => prev.filter((_, i) => i !== idx));
    setHasChanges(true);
  };

  const handleAddHighlight = () => {
    setEditableHighlighted((prev) => prev.length >= 4 ? prev : [...prev, '']);
    setHasChanges(true);
  };

  const handleUpdateHighlight = (idx, value) => {
    setEditableHighlighted((prev) => prev.map((s, i) => i === idx ? value : s));
    setHasChanges(true);
  };

  const handleSave = async () => {
    setSaving(true);
    try {
      // Pass highlighted_text — empty labels get filtered server-side
      const trimmedHighlights = editableHighlighted.map((s) => (s || '').trim()).filter(Boolean);
      await onSave?.(brief.id, {
        hooks: editableHooks,
        body: editableBody,
        highlighted_text: trimmedHighlights,
      });
      setHasChanges(false);
    } finally {
      setSaving(false);
    }
  };

  const parsedWinAnalysis = (() => {
    if (!winAnalysis) return null;
    if (typeof winAnalysis === 'object') return winAnalysis;
    try { return JSON.parse(winAnalysis); } catch { return null; }
  })();

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center p-4 sm:p-8"
      onClick={(e) => { if (e.target === e.currentTarget) onClose?.(); }}
    >
      {/* Backdrop */}
      <div className="absolute inset-0 bg-black/70 backdrop-blur-sm" />

      {/* Centered modal — 90vw × 90vh max, 3-column grid on lg+ */}
      <div className="relative w-full max-w-[1400px] h-[90vh] bg-[#0c0c0e] border border-white/[0.07] rounded-2xl shadow-2xl flex flex-col overflow-hidden">
        {/* Sticky header — naming convention is the prominent centered title.
            "Brief Detail · STATUS" demotes to a small pill above. */}
        <div className="relative px-6 py-4 border-b border-white/[0.06] shrink-0">
          {/* Top row: tiny label pill on the left, scores + close on the right */}
          <div className="flex items-start justify-between gap-4 mb-2">
            <div className="flex items-center gap-2">
              <span className="text-[10px] font-mono uppercase tracking-wider text-zinc-500">Brief Detail</span>
              <span className="text-[10px] uppercase tracking-wider font-mono px-1.5 py-0.5 rounded bg-white/[0.04] text-zinc-400 border border-white/[0.06]">
                {status}
              </span>
            </div>
            <div className="flex items-center gap-3">
              {hasScores && (
                <div className="hidden md:flex gap-1.5">
                  {Object.entries(scores).map(([k, v]) => (
                    <ScoreCard key={k} scoreKey={k} value={v} />
                  ))}
                </div>
              )}
              <button
                type="button"
                onClick={onClose}
                aria-label="Close brief detail modal"
                className="text-zinc-400 hover:text-white transition-colors cursor-pointer"
              >
                <X className="w-5 h-5" />
              </button>
            </div>
          </div>
          {/* Centered big title — the naming convention is what the editor
              actually needs to read at a glance. Mono, white, large. */}
          {brief.naming_convention && (
            <h2 className="font-mono text-base md:text-lg text-white text-center tracking-wide leading-snug px-12 break-words">
              {brief.naming_convention}
            </h2>
          )}
        </div>

        {/* Body — 3 columns on lg+, stacked on smaller. Left = source, middle = brief, right = AI chat. */}
        <div className="flex-1 min-h-0 grid grid-cols-1 lg:grid-cols-[1fr_1.3fr_400px] overflow-hidden">
          {/* ── LEFT: Original Script + Win Analysis ────────────────── */}
          <div className="overflow-y-auto p-6 space-y-6 border-r border-white/[0.04]">
            {hasScores && (
              <section className="md:hidden">
                <SectionLabel>Scores</SectionLabel>
                <div className="flex gap-2">
                  {Object.entries(scores).map(([k, v]) => (
                    <ScoreCard key={k} scoreKey={k} value={v} />
                  ))}
                </div>
              </section>
            )}

            {brief.reference && (brief.reference.videoUrl || brief.reference.thumbnailUrl || brief.reference.sourceUrl) && (
              <section>
                <SectionLabel>Source Reference</SectionLabel>
                <ReferenceMedia reference={brief.reference} />
              </section>
            )}

            {(originalRawScript || originalHooks.length > 0 || originalBody) && (
              <section>
                <SectionLabel>Original Script</SectionLabel>
                <div className="glass-card border border-white/[0.04] rounded-lg p-4 bg-white/[0.02] space-y-3 max-h-[60vh] overflow-y-auto">
                  {parsedTranscript ? (
                    <>
                      {parsedTranscript.onScreenLines.length > 0 && (
                        <div className="space-y-1.5 pb-3 border-b border-white/[0.05]">
                          <div className="text-[10px] font-mono uppercase tracking-wider text-zinc-500">
                            On-screen text · {parsedTranscript.onScreenLines.length} lines
                          </div>
                          <div className="flex flex-wrap gap-1">
                            {parsedTranscript.onScreenLines.map((line, i) => (
                              <span
                                key={i}
                                className="text-[10px] font-mono px-1.5 py-0.5 rounded bg-white/[0.04] text-zinc-400 border border-white/[0.04]"
                              >
                                {line}
                              </span>
                            ))}
                          </div>
                        </div>
                      )}
                      {parsedTranscript.spoken ? (
                        <p className="text-xs text-zinc-300 leading-relaxed whitespace-pre-line">
                          {parsedTranscript.spoken}
                        </p>
                      ) : (
                        <p className="text-[10px] font-mono text-zinc-500 italic">
                          (No spoken transcript — source is overlay-only.)
                        </p>
                      )}
                    </>
                  ) : (
                    <>
                      {originalHooks.map((hook, i) => (
                        <div key={i}>
                          <span className="font-mono text-[10px] text-zinc-500 mr-2">H{i + 1}</span>
                          <span className={`text-xs ${i === 0 ? 'font-medium text-zinc-200' : 'text-zinc-400'} leading-relaxed`}>
                            {typeof hook === 'string' ? hook : hook.text}
                          </span>
                        </div>
                      ))}
                      {originalBody && (
                        <p className="text-xs text-zinc-400 leading-relaxed whitespace-pre-line">{originalBody}</p>
                      )}
                    </>
                  )}
                </div>
              </section>
            )}

            {parsedWinAnalysis && (
              <section>
                <button
                  type="button"
                  onClick={() => setWinAnalysisOpen(!winAnalysisOpen)}
                  className="flex items-center gap-2 font-mono text-xs tracking-[0.15em] uppercase text-[#c9a84c] font-semibold hover:text-[#e8d5a3] transition-colors cursor-pointer"
                >
                  {winAnalysisOpen ? <ChevronDown className="w-3.5 h-3.5" /> : <ChevronRight className="w-3.5 h-3.5" />}
                  Why the Original Won
                </button>

                {winAnalysisOpen && (
                  <div className="mt-3 glass-card border border-white/[0.04] rounded-lg p-4 bg-white/[0.02] space-y-3 text-xs text-zinc-400">
                    {parsedWinAnalysis.scriptDna?.core_angle && <p><span className="text-zinc-500 font-mono">Angle:</span> {parsedWinAnalysis.scriptDna.core_angle}</p>}
                    {parsedWinAnalysis.scriptDna?.mechanism && <p><span className="text-zinc-500 font-mono">Mechanism:</span> {parsedWinAnalysis.scriptDna.mechanism}</p>}
                    {parsedWinAnalysis.scriptDna?.belief_shift && <p><span className="text-zinc-500 font-mono">Belief Shift:</span> {parsedWinAnalysis.scriptDna.belief_shift}</p>}
                    {parsedWinAnalysis.scriptDna?.why_it_works && <p><span className="text-zinc-500 font-mono">Why It Works:</span> {parsedWinAnalysis.scriptDna.why_it_works}</p>}
                  </div>
                )}
              </section>
            )}
          </div>

          {/* ── MIDDLE: Editable brief — highlighted_text + hooks + body ──── */}
          <div className="overflow-y-auto p-6 space-y-6">
            {/* Highlighted text — only render when array non-empty OR operator adds first label */}
            {editableHighlighted.length > 0 && (
              <section>
                <SectionLabel
                  actions={
                    editableHighlighted.length < 4 && (
                      <button
                        type="button"
                        onClick={handleAddHighlight}
                        className="flex items-center gap-1 text-[10px] uppercase tracking-wider font-mono text-zinc-400 hover:text-[#c9a84c] transition-colors cursor-pointer"
                      >
                        <Plus className="w-3 h-3" /> Add label
                      </button>
                    )
                  }
                >
                  On-Screen Text
                </SectionLabel>
                <div className="space-y-2">
                  {editableHighlighted.map((label, i) => (
                    <div
                      key={i}
                      className="flex items-center gap-2 glass-card border border-white/[0.04] rounded-lg px-3 py-2 bg-white/[0.02]"
                    >
                      <span className="text-[10px] font-mono uppercase tracking-wider text-zinc-500 shrink-0">
                        L{i + 1}
                      </span>
                      <input
                        type="text"
                        value={label}
                        placeholder="e.g. BIGGEST SALE 🇺🇸"
                        onChange={(e) => handleUpdateHighlight(i, e.target.value)}
                        className="flex-1 bg-transparent text-sm text-zinc-200 focus:outline-none border-0 p-0 font-medium"
                      />
                      <button
                        type="button"
                        onClick={() => handleDeleteHighlight(i)}
                        aria-label={`Delete label ${i + 1}`}
                        className="text-zinc-600 hover:text-red-400 transition-colors cursor-pointer shrink-0"
                      >
                        <Trash2 className="w-3.5 h-3.5" />
                      </button>
                    </div>
                  ))}
                </div>
              </section>
            )}

            {/* If no overlays exist, surface a discreet "Add overlay" affordance.
                Operator-initiated only — never auto-populated. */}
            {editableHighlighted.length === 0 && (
              <button
                type="button"
                onClick={handleAddHighlight}
                className="w-full flex items-center justify-center gap-1.5 px-3 py-2 rounded-lg border border-dashed border-white/[0.08] text-[11px] uppercase tracking-wider font-mono text-zinc-500 hover:text-[#c9a84c] hover:border-[#c9a84c]/30 transition-colors cursor-pointer"
              >
                <Plus className="w-3.5 h-3.5" /> Add on-screen overlay
              </button>
            )}

            {/* Hooks — per-hook delete + edit */}
            {editableHooks.length > 0 && (
              <section>
                <SectionLabel>
                  Hooks <span className="text-zinc-500 normal-case tracking-normal font-normal">({editableHooks.length})</span>
                </SectionLabel>
                <div className="space-y-3">
                  {editableHooks.map((hook, i) => {
                    const wordCount = (hook.text || '').trim().split(/\s+/).filter(Boolean).length;
                    const isLong = wordCount > 25;
                    return (
                      <div
                        key={hook.id || i}
                        className={`glass-card border rounded-lg p-3 bg-white/[0.02] group ${isLong ? 'border-amber-500/30' : 'border-white/[0.04]'}`}
                      >
                        <div className="flex gap-2 mb-2 items-center">
                          <span className="text-[10px] font-mono uppercase tracking-wider font-medium px-1.5 py-0.5 rounded bg-[#c9a84c]/10 text-[#e8d5a3] border border-[#c9a84c]/20">
                            H{i + 1}
                          </span>
                          {hook.mechanism && (
                            <span className="text-[10px] font-mono uppercase tracking-wider font-medium px-1.5 py-0.5 rounded bg-white/[0.04] text-zinc-400 border border-white/[0.06]">
                              {hook.mechanism}
                            </span>
                          )}
                          <span className={`ml-auto text-[10px] font-mono ${isLong ? 'text-amber-400' : 'text-zinc-600'}`}>
                            {wordCount}w{isLong ? ' ⚠' : ''}
                          </span>
                          <button
                            type="button"
                            onClick={() => handleDeleteHook(i)}
                            aria-label={`Delete hook ${i + 1}`}
                            className="text-zinc-600 hover:text-red-400 transition-colors cursor-pointer opacity-0 group-hover:opacity-100"
                          >
                            <Trash2 className="w-3.5 h-3.5" />
                          </button>
                        </div>
                        <textarea
                          value={hook.text || ''}
                          onChange={(e) => {
                            const updated = [...editableHooks];
                            updated[i] = { ...updated[i], text: e.target.value };
                            setEditableHooks(updated);
                            setHasChanges(true);
                          }}
                          className="w-full bg-transparent text-sm text-zinc-300 leading-relaxed resize-none focus:outline-none border-0 p-0"
                          rows={3}
                        />
                      </div>
                    );
                  })}
                </div>
              </section>
            )}

            {/* Body */}
            {(editableBody || brief.body) && (
              <section>
                <SectionLabel>Body</SectionLabel>
                <textarea
                  value={editableBody}
                  onChange={(e) => { setEditableBody(e.target.value); setHasChanges(true); }}
                  className="w-full h-64 glass-card border border-white/[0.04] rounded-lg p-3 bg-white/[0.02] text-sm text-zinc-300 leading-relaxed resize-y focus:outline-none focus:border-[#c9a84c]/50 focus:ring-1 focus:ring-[#c9a84c]/50 transition-all"
                />
              </section>
            )}
          </div>

          {/* ── RIGHT: AI chat sidebar ──────────────────────────────────── */}
          <div className="hidden lg:flex flex-col border-l border-white/[0.04] bg-white/[0.01]">
            <div className="px-5 py-4 border-b border-white/[0.04] shrink-0">
              <h4 className="font-mono text-xs tracking-[0.15em] uppercase text-[#c9a84c] font-semibold flex items-center gap-2">
                <Sparkles className="w-3.5 h-3.5" /> AI Editor
              </h4>
              <p className="text-[11px] text-zinc-500 mt-1">Brief is loaded. Ask for edits — labels, hooks, body, or whole rewrites.</p>
            </div>

            {/* Quick action chips */}
            <div className="px-4 pt-3 pb-2 shrink-0 flex flex-wrap gap-1.5">
              {QUICK_ACTIONS.map((qa) => (
                <button
                  key={qa.label}
                  type="button"
                  disabled={aiBusy}
                  onClick={() => handleAi(qa.prompt)}
                  className="text-[10px] uppercase tracking-wider font-mono px-2 py-1 rounded bg-white/[0.03] border border-white/[0.05] text-zinc-400 hover:text-zinc-200 hover:bg-white/[0.06] disabled:opacity-40 disabled:cursor-not-allowed transition-colors cursor-pointer"
                >
                  {qa.label}
                </button>
              ))}
            </div>

            {/* Chat scroll history */}
            <div ref={chatScrollRef} className="flex-1 overflow-y-auto px-4 py-3 space-y-3 min-h-0">
              {aiHistory.length === 0 && !aiBusy && (
                <div className="text-[11px] text-zinc-600 italic text-center py-6">
                  No edits yet. Try a quick action above or type your own instruction below.
                </div>
              )}
              {aiHistory.map((turn, i) => (
                <div
                  key={i}
                  className={`text-xs leading-relaxed rounded-lg px-3 py-2 ${
                    turn.role === 'user'
                      ? 'bg-[#c9a84c]/10 text-[#e8d5a3] border border-[#c9a84c]/20 ml-4'
                      : 'bg-white/[0.03] text-zinc-300 border border-white/[0.05] mr-4'
                  }`}
                >
                  {turn.text}
                </div>
              ))}
              {aiBusy && (
                <div className="text-xs text-zinc-500 flex items-center gap-2 mr-4 px-3 py-2 bg-white/[0.02] rounded-lg border border-white/[0.04]">
                  <Loader2 className="w-3.5 h-3.5 animate-spin" /> Thinking…
                </div>
              )}
            </div>

            {/* Chat input */}
            <div className="px-4 py-3 border-t border-white/[0.04] shrink-0">
              <textarea
                value={aiPrompt}
                onChange={(e) => setAiPrompt(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) { e.preventDefault(); handleAi(); }
                }}
                placeholder="e.g. 'rewrite hook 2 as a quote-reply', 'shorten body 30%'…"
                rows={2}
                className="w-full bg-white/[0.02] border border-white/[0.06] rounded-lg px-3 py-2 text-sm text-zinc-200 placeholder:text-zinc-600 resize-none focus:outline-none focus:ring-1 focus:ring-[#c9a84c]/30 focus:border-[#c9a84c]/30 transition-all"
              />
              <button
                type="button"
                onClick={() => handleAi()}
                disabled={aiBusy || !aiPrompt.trim()}
                aria-label="Send AI edit instruction"
                className="mt-2 w-full flex items-center justify-center gap-1.5 px-3 py-2 rounded-lg text-xs font-medium uppercase tracking-wider font-mono transition-colors disabled:opacity-40 disabled:cursor-not-allowed cursor-pointer"
                style={{ background: 'linear-gradient(135deg, #c9a84c, #d4b55a)', color: '#111113' }}
              >
                {aiBusy ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <Sparkles className="w-3.5 h-3.5" />}
                {aiBusy ? 'Editing…' : 'Send ⌘↵'}
              </button>
            </div>
          </div>
        </div>

        {/* Sticky footer — actions */}
        <div className="px-6 py-3 border-t border-white/[0.06] bg-[#0c0c0e] shrink-0 flex items-center gap-2">
          {hasChanges && (
            <button
              type="button"
              onClick={handleSave}
              disabled={saving}
              className="flex items-center gap-2 px-4 py-2 rounded-lg text-sm font-medium transition-colors cursor-pointer disabled:opacity-40"
              style={{ background: 'linear-gradient(135deg, #c9a84c, #d4b55a)', color: '#111113' }}
            >
              {saving ? <Loader2 className="w-4 h-4 animate-spin" /> : <Save className="w-4 h-4" />}
              Save Changes
            </button>
          )}

          <div className="flex-1" />

          {status === 'generated' && (
            <>
              <button
                type="button"
                onClick={() => onReject?.(brief.id)}
                className="flex items-center gap-2 px-3 py-2 rounded-lg bg-red-500/5 text-red-400/80 hover:bg-red-500/10 border border-red-500/10 hover:border-red-500/20 text-sm font-medium transition-all cursor-pointer"
              >
                <ThumbsDown className="w-4 h-4" /> Reject
              </button>
              <button
                type="button"
                onClick={() => onApprove?.(brief.id)}
                className="flex items-center gap-2 px-4 py-2 rounded-lg bg-emerald-500/10 text-emerald-400 hover:bg-emerald-500/20 border border-emerald-500/20 hover:border-emerald-500/40 shadow-[0_0_15px_rgba(16,185,129,0.1)] text-sm font-medium transition-all cursor-pointer"
              >
                <Check className="w-4 h-4" /> Approve
              </button>
            </>
          )}

          {status === 'approved' && (
            <>
              <button
                type="button"
                onClick={() => onMoveToReady?.(brief.id)}
                aria-label="Move brief to Ready ClickUp column without opening ClickUp form"
                className="flex items-center gap-2 px-3 py-2 rounded-lg bg-blue-500/10 text-blue-400 hover:bg-blue-500/15 border border-blue-500/25 text-xs font-mono uppercase tracking-wide transition-all cursor-pointer"
              >
                <Send className="w-3.5 h-3.5" /> Skip form
              </button>
              {onPushToClickup && (
                <button
                  type="button"
                  onClick={() => onPushToClickup?.(brief.id)}
                  aria-label="Push this brief to ClickUp and assign editor"
                  className="flex items-center gap-2 px-4 py-2 rounded-lg bg-amber-500/15 text-amber-300 hover:bg-amber-500/25 border border-amber-500/30 hover:border-amber-500/50 shadow-[0_0_15px_rgba(245,158,11,0.1)] text-sm font-mono font-semibold uppercase tracking-wide transition-all cursor-pointer"
                >
                  <Send className="w-4 h-4" /> Push to ClickUp
                </button>
              )}
            </>
          )}

          {status === 'ready_to_launch' && (
            <>
              {onMoveBackToApproved && (
                <button
                  type="button"
                  onClick={() => onMoveBackToApproved?.(brief.id)}
                  aria-label="Move brief back to Approved column"
                  className="flex items-center gap-2 px-3 py-2 rounded-lg bg-amber-500/5 text-amber-400/80 hover:bg-amber-500/10 border border-amber-500/10 text-xs transition-all cursor-pointer"
                >
                  ↩ Back to Approved
                </button>
              )}
              {onMarkLaunched && (
                <button
                  type="button"
                  onClick={() => onMarkLaunched?.(brief.id)}
                  aria-label="Mark this brief as launched without creating a Meta ad"
                  className="flex items-center gap-2 px-3 py-2 rounded-lg bg-white/[0.03] border border-white/[0.06] text-sm text-zinc-400 hover:text-zinc-200 transition-all cursor-pointer"
                >
                  <Check className="w-4 h-4" /> Already live
                </button>
              )}
              {onLaunch && (
                <button
                  type="button"
                  onClick={() => onLaunch?.(brief.id)}
                  aria-label="Launch this brief on Meta"
                  className="flex items-center gap-2 px-4 py-2 rounded-lg bg-emerald-500/15 text-emerald-300 hover:bg-emerald-500/25 border border-emerald-500/30 shadow-[0_0_15px_rgba(16,185,129,0.1)] text-sm font-mono font-semibold uppercase tracking-wide transition-all cursor-pointer"
                >
                  <Send className="w-4 h-4" /> Launch on Meta
                </button>
              )}
            </>
          )}

          {status === 'pushed' && brief.clickup_task_url && (
            <a
              href={brief.clickup_task_url}
              target="_blank"
              rel="noopener noreferrer"
              className="flex items-center gap-2 px-4 py-2 rounded-lg bg-white/[0.03] border border-white/[0.06] text-sm text-zinc-400 hover:text-zinc-200 transition-all"
            >
              <ExternalLink className="w-4 h-4" /> View in ClickUp
            </a>
          )}
        </div>
      </div>
    </div>
  );
}
