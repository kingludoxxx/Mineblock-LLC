import { useState } from 'react';
import { X, Play, Film, Loader2, Sparkles } from 'lucide-react';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function SectionLabel({ children }) {
  return (
    <h4 className="text-[10px] uppercase tracking-widest text-slate-500 font-semibold mb-2">
      {children}
    </h4>
  );
}

function MetricCell({ label, value }) {
  return (
    <div className="flex flex-col items-center gap-0.5 py-3 px-2 rounded-lg bg-white/[0.03] border border-white/[0.06]">
      <span className="text-lg font-bold text-white leading-none">{value ?? '—'}</span>
      <span className="text-[10px] text-slate-500 uppercase tracking-wider">{label}</span>
    </div>
  );
}

function InfoPill({ label, value }) {
  if (value == null || value === '') return null;
  return (
    <span className="inline-flex items-center gap-1.5 px-2.5 py-1 text-xs rounded-full bg-white/[0.04] border border-white/[0.08] text-slate-300">
      <span className="text-slate-500">{label}:</span>
      <span className="font-medium">{value}</span>
    </span>
  );
}

function HookCard({ hook, index }) {
  const label = `H${index + 1}`;
  return (
    <div className="p-3 bg-white/[0.03] border border-white/[0.06] rounded-lg space-y-1.5">
      <div className="flex items-center gap-2">
        <span className="text-[10px] font-bold uppercase tracking-wider text-amber-400 bg-amber-500/10 px-2 py-0.5 rounded">
          {label}
        </span>
        {hook.mechanism && (
          <span className="text-[10px] text-slate-500 bg-white/[0.04] px-2 py-0.5 rounded">
            {hook.mechanism}
          </span>
        )}
      </div>
      <p className="text-sm text-slate-300 leading-relaxed">{hook.text}</p>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Formatting helpers
// ---------------------------------------------------------------------------

function fmtCurrency(val) {
  if (val == null) return '—';
  return `$${Number(val).toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
}

function fmtNumber(val) {
  if (val == null) return '—';
  return Number(val).toLocaleString();
}

function fmtPercent(val) {
  if (val == null) return '—';
  return `${Number(val).toFixed(2)}%`;
}

function fmtRoas(val) {
  if (val == null) return '—';
  return `${Number(val).toFixed(2)}x`;
}

// ---------------------------------------------------------------------------
// Parse script helper
// ---------------------------------------------------------------------------

function parseScript(parsed, raw) {
  if (!parsed && !raw) return null;
  if (!parsed) return { type: 'raw', content: raw };

  let obj = parsed;
  if (typeof parsed === 'string') {
    try {
      obj = JSON.parse(parsed);
    } catch {
      return { type: 'raw', content: parsed };
    }
  }

  const hooks = (() => {
    if (Array.isArray(obj.hooks)) return obj.hooks;
    if (Array.isArray(obj)) return obj;
    return [];
  })();

  const body = obj.body || obj.script || obj.text || null;

  if (hooks.length === 0 && !body) {
    return { type: 'raw', content: typeof parsed === 'string' ? parsed : JSON.stringify(parsed, null, 2) };
  }

  return { type: 'parsed', hooks, body };
}

// ---------------------------------------------------------------------------
// VideoPreview — plays video or shows clickable thumbnail
// ---------------------------------------------------------------------------

function VideoPreview({ videoUrl, thumbnailUrl }) {
  const [playing, setPlaying] = useState(false);
  const [videoError, setVideoError] = useState(false);

  if (!videoUrl || videoError) {
    // Thumbnail-only mode
    if (!thumbnailUrl) return null;
    return (
      <div>
        <SectionLabel>Preview</SectionLabel>
        <img
          src={thumbnailUrl}
          alt="Winner thumbnail"
          className="w-full max-w-full rounded-lg border border-white/[0.06]"
        />
      </div>
    );
  }

  return (
    <div>
      <SectionLabel>Preview</SectionLabel>
      {playing ? (
        <video
          src={videoUrl}
          poster={thumbnailUrl || undefined}
          controls
          autoPlay
          onError={() => setVideoError(true)}
          className="w-full max-w-full rounded-lg border border-white/[0.06]"
        />
      ) : (
        <div
          className="relative cursor-pointer group"
          onClick={() => setPlaying(true)}
        >
          {thumbnailUrl ? (
            <img
              src={thumbnailUrl}
              alt="Click to play"
              className="w-full max-w-full rounded-lg border border-white/[0.06]"
            />
          ) : (
            <div className="w-full aspect-video rounded-lg border border-white/[0.06] bg-white/[0.03] flex items-center justify-center">
              <Film className="w-8 h-8 text-slate-600" />
            </div>
          )}
          <div className="absolute inset-0 flex items-center justify-center">
            <div className="w-14 h-14 rounded-full bg-black/60 group-hover:bg-black/80 flex items-center justify-center transition-colors">
              <Play className="w-6 h-6 text-white fill-white ml-1" />
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------
// WinnerDetailModal
// ---------------------------------------------------------------------------

const ITER_MODES = [
  { value: 'hook_only', label: 'Hook Only' },
  { value: 'hook_body', label: 'Hook + Body' },
  { value: 'full_rewrite', label: 'Full Rewrite' },
  { value: 'angle_expansion', label: 'Angle Expansion' },
];

const AGGRESSIVENESS = [
  { value: 'conservative', label: 'Conservative' },
  { value: 'medium', label: 'Medium' },
  { value: 'aggressive', label: 'Aggressive' },
  { value: 'extreme', label: 'Extreme' },
];

const VARIATION_COUNTS = [3, 5, 10];

function PillGroup({ options, value, onChange }) {
  return (
    <div className="flex flex-wrap gap-1.5">
      {options.map((opt) => {
        const val = typeof opt === 'object' ? opt.value : opt;
        const label = typeof opt === 'object' ? opt.label : opt;
        const active = val === value;
        return (
          <button
            key={val}
            type="button"
            onClick={() => onChange(val)}
            className={`px-2.5 py-1 text-[11px] font-medium rounded-full border transition-colors cursor-pointer ${
              active
                ? 'bg-emerald-500/20 border-emerald-500/40 text-emerald-300'
                : 'bg-white/[0.03] border-white/[0.08] text-slate-400 hover:bg-white/[0.06]'
            }`}
          >
            {label}
          </button>
        );
      })}
    </div>
  );
}

export default function WinnerDetailModal({ winner, isOpen, onClose, onGenerate, generating }) {
  const [iterMode, setIterMode] = useState('hook_body');
  const [aggressiveness, setAggressiveness] = useState('medium');
  const [numVariations, setNumVariations] = useState(5);

  if (!isOpen || !winner) return null;

  const script = parseScript(winner.parsed_script, winner.raw_script);

  const iterationCodes = (() => {
    if (Array.isArray(winner.iteration_codes)) return winner.iteration_codes;
    if (typeof winner.iteration_codes === 'string') {
      try { return JSON.parse(winner.iteration_codes); } catch { return []; }
    }
    return [];
  })();

  return (
    <div className="fixed inset-0 z-50 flex justify-end">
      {/* Backdrop */}
      <div className="absolute inset-0 bg-black/60" onClick={onClose} />

      {/* Slide-over panel */}
      <div
        className="relative w-[560px] h-full bg-[#0a0a0a] border-l border-white/[0.08] flex flex-col"
        style={{ animation: 'slideInRight 0.25s ease-out' }}
      >
        {/* Header */}
        <div className="flex items-center justify-between px-6 py-4 border-b border-white/[0.06] shrink-0">
          <h2 className="text-sm font-semibold text-white tracking-wide">Winner Detail</h2>
          <button
            type="button"
            onClick={onClose}
            className="p-1.5 rounded-lg text-slate-500 hover:text-white hover:bg-white/[0.06] transition-colors cursor-pointer"
          >
            <X className="w-4 h-4" />
          </button>
        </div>

        {/* Scrollable content */}
        <div className="flex-1 overflow-y-auto px-6 py-5 space-y-6">
          {/* Ad name / naming convention */}
          {winner.ad_name && (
            <div>
              <SectionLabel>Ad Name</SectionLabel>
              <p className="text-xs font-mono text-slate-400 bg-white/[0.03] border border-white/[0.06] rounded-lg px-3 py-2 break-all">
                {winner.ad_name}
              </p>
            </div>
          )}

          {/* Video / Thumbnail preview */}
          {(winner.video_url || winner.thumbnail_url) && (
            <VideoPreview
              videoUrl={winner.video_url}
              thumbnailUrl={winner.thumbnail_url}
            />
          )}

          {/* Metrics grid */}
          <div>
            <SectionLabel>Metrics</SectionLabel>
            <div className="grid grid-cols-4 gap-2">
              <MetricCell label="ROAS" value={fmtRoas(winner.roas)} />
              <MetricCell label="Spend" value={fmtCurrency(winner.spend)} />
              <MetricCell label="CPA" value={fmtCurrency(winner.cpa)} />
              <MetricCell label="CTR" value={fmtPercent(winner.ctr)} />
              <MetricCell label="Purchases" value={fmtNumber(winner.purchases)} />
              <MetricCell label="Revenue" value={fmtCurrency(winner.revenue)} />
              <MetricCell label="Impressions" value={fmtNumber(winner.impressions)} />
              <MetricCell label="Clicks" value={fmtNumber(winner.clicks)} />
            </div>
          </div>

          {/* Info pills */}
          <div>
            <SectionLabel>Details</SectionLabel>
            <div className="flex flex-wrap gap-2">
              <InfoPill label="Angle" value={winner.angle} />
              <InfoPill label="Format" value={winner.format} />
              <InfoPill label="Avatar" value={winner.avatar} />
              <InfoPill label="Editor" value={winner.editor} />
              <InfoPill label="Hook" value={winner.hook_type} />
              <InfoPill label="Week" value={winner.week} />
              <InfoPill label="Winner" value={winner.winner_reason} />
              <InfoPill label="Readiness" value={winner.iteration_readiness} />
            </div>
          </div>

          {/* Iterations */}
          {(winner.existing_iterations != null || iterationCodes.length > 0) && (
            <div>
              <SectionLabel>Iterations</SectionLabel>
              <div className="p-3 bg-white/[0.03] border border-white/[0.06] rounded-lg space-y-2">
                {winner.existing_iterations != null && (
                  <p className="text-sm text-slate-300">
                    <span className="text-slate-500">Existing iterations:</span>{' '}
                    <span className="font-semibold text-white">{winner.existing_iterations}</span>
                  </p>
                )}
                {iterationCodes.length > 0 && (
                  <div className="flex flex-wrap gap-1.5">
                    {iterationCodes.map((code, i) => (
                      <span
                        key={i}
                        className="px-2 py-0.5 text-[11px] font-mono rounded bg-white/[0.06] border border-white/[0.08] text-slate-400"
                      >
                        {code}
                      </span>
                    ))}
                  </div>
                )}
              </div>
            </div>
          )}

          {/* Script */}
          {script && (
            <div>
              <SectionLabel>Script</SectionLabel>
              {script.type === 'parsed' ? (
                <div className="space-y-3">
                  {script.hooks.length > 0 && (
                    <div className="space-y-2">
                      {script.hooks.map((hook, i) => (
                        <HookCard key={i} hook={typeof hook === 'string' ? { text: hook } : hook} index={i} />
                      ))}
                    </div>
                  )}
                  {script.body && (
                    <div className="max-h-80 overflow-y-auto p-4 bg-white/[0.03] border border-white/[0.06] rounded-lg">
                      <p className="text-sm text-slate-300 leading-relaxed whitespace-pre-line">
                        {script.body}
                      </p>
                    </div>
                  )}
                </div>
              ) : (
                <div className="max-h-80 overflow-y-auto p-4 bg-white/[0.03] border border-white/[0.06] rounded-lg">
                  <pre className="text-sm text-slate-300 leading-relaxed whitespace-pre-wrap font-mono">
                    {script.content}
                  </pre>
                </div>
              )}
            </div>
          )}

          {/* Iteration config */}
          <div className="space-y-3">
            <SectionLabel>Iteration Config</SectionLabel>
            <div className="space-y-2">
              <span className="text-[11px] text-slate-500">Mode</span>
              <PillGroup options={ITER_MODES} value={iterMode} onChange={setIterMode} />
            </div>
            <div className="space-y-2">
              <span className="text-[11px] text-slate-500">Aggressiveness</span>
              <PillGroup options={AGGRESSIVENESS} value={aggressiveness} onChange={setAggressiveness} />
            </div>
            <div className="space-y-2">
              <span className="text-[11px] text-slate-500">Variations</span>
              <PillGroup options={VARIATION_COUNTS} value={numVariations} onChange={setNumVariations} />
            </div>
          </div>
        </div>

        {/* Footer */}
        <div className="px-6 py-4 border-t border-white/[0.06] shrink-0">
          <button
            type="button"
            onClick={() => onGenerate?.(winner.id, {
              iteration_mode: iterMode,
              aggressiveness,
              num_variations: numVariations,
            })}
            disabled={generating}
            className="w-full flex items-center justify-center gap-2 px-4 py-2.5 rounded-lg bg-emerald-600 text-sm font-medium text-white hover:bg-emerald-500 transition-colors cursor-pointer disabled:opacity-40"
          >
            {generating ? (
              <>
                <Loader2 className="w-4 h-4 animate-spin" />
                Generating...
              </>
            ) : (
              <>
                <Sparkles className="w-4 h-4" />
                Generate Iterations
              </>
            )}
          </button>
        </div>
      </div>
    </div>
  );
}
