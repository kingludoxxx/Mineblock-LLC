import { useState } from 'react';
import { X, Play, Film, Loader2, Sparkles, Check } from 'lucide-react';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function SectionLabel({ children }) {
  return (
    <h4 className="font-mono text-xs tracking-[0.15em] uppercase text-[#c9a84c] font-semibold mb-3">
      {children}
    </h4>
  );
}

function MetricCell({ label, value }) {
  return (
    <div className="flex flex-col items-center gap-0.5 py-3 px-2 rounded-lg bg-white/[0.02] border border-white/[0.04]">
      <span className="text-lg font-bold text-white leading-none font-mono">{value ?? '—'}</span>
      <span className="text-[10px] text-zinc-600 uppercase tracking-wider font-mono">{label}</span>
    </div>
  );
}

function InfoPill({ label, value }) {
  if (value == null || value === '') return null;
  return (
    <span className="inline-flex items-center gap-1.5 px-2.5 py-1 text-xs rounded bg-white/[0.03] border border-white/[0.06] text-zinc-400 font-mono">
      <span className="text-zinc-600">{label}:</span>
      <span className="font-medium text-zinc-300">{value}</span>
    </span>
  );
}

function HookCard({ hook, index }) {
  const label = `H${index + 1}`;
  return (
    <div className="glass-card border border-white/[0.04] rounded-lg p-4 bg-white/[0.02] space-y-2">
      <div className="flex items-center gap-2">
        <span className="text-[10px] font-mono font-medium uppercase tracking-wider text-[#e8d5a3] bg-[#c9a84c]/10 px-1.5 py-0.5 rounded border border-[#c9a84c]/20">
          {label}
        </span>
        {hook.mechanism && (
          <span className="text-[10px] font-mono uppercase tracking-wider text-zinc-500 bg-white/[0.04] px-1.5 py-0.5 rounded border border-white/[0.06]">
            {hook.mechanism}
          </span>
        )}
      </div>
      <p className="text-sm text-zinc-300 leading-relaxed">{hook.text}</p>
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
// VideoPreview
// ---------------------------------------------------------------------------

function VideoPreview({ videoUrl, thumbnailUrl }) {
  const [playing, setPlaying] = useState(false);
  const [videoError, setVideoError] = useState(false);
  const [thumbError, setThumbError] = useState(false);

  const showFallback = !thumbnailUrl || thumbError;

  if (!videoUrl || videoError) {
    if (showFallback) return (
      <div>
        <SectionLabel>Preview</SectionLabel>
        <div className="w-full aspect-video rounded-lg border border-white/[0.04] bg-white/[0.02] flex items-center justify-center">
          <Film className="w-12 h-12 text-zinc-700" />
        </div>
      </div>
    );
    return (
      <div>
        <SectionLabel>Preview</SectionLabel>
        <img
          src={thumbnailUrl}
          alt="Winner thumbnail"
          className="w-full max-w-full rounded-lg border border-white/[0.04]"
          onError={() => setThumbError(true)}
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
          poster={!showFallback ? thumbnailUrl : undefined}
          controls
          autoPlay
          onError={() => setVideoError(true)}
          className="w-full max-w-full rounded-lg border border-white/[0.04]"
        />
      ) : (
        <div
          className="relative cursor-pointer group"
          onClick={() => setPlaying(true)}
        >
          {!showFallback ? (
            <img
              src={thumbnailUrl}
              alt="Click to play"
              className="w-full max-w-full rounded-lg border border-white/[0.04]"
              onError={() => setThumbError(true)}
            />
          ) : (
            <div className="w-full aspect-video rounded-lg border border-white/[0.04] bg-white/[0.02] flex items-center justify-center">
              <Film className="w-12 h-12 text-zinc-700" />
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
            className={`px-2.5 py-1 text-[11px] font-mono font-medium rounded border transition-all duration-300 cursor-pointer ${
              active
                ? 'bg-[#c9a84c]/10 border-[#c9a84c]/30 text-[#e8d5a3] shadow-[0_0_8px_rgba(201,168,76,0.1)]'
                : 'bg-white/[0.02] border-white/[0.05] text-zinc-500 hover:border-white/[0.1] hover:text-zinc-300'
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
      <div className="absolute inset-0 bg-black/60 backdrop-blur-sm" onClick={onClose} />

      {/* Slide-over panel */}
      <div
        className="relative w-[560px] h-full bg-[#111113] border-l border-white/[0.06] shadow-2xl flex flex-col"
        style={{ animation: 'slideInRight 0.25s ease-out' }}
      >
        {/* Header */}
        <div className="flex items-center justify-between p-6 border-b border-white/[0.06]">
          <h2 className="text-lg font-semibold text-white">Winner Detail</h2>
          <button
            type="button"
            onClick={onClose}
            className="text-zinc-400 hover:text-white transition-colors cursor-pointer"
          >
            <X className="w-5 h-5" />
          </button>
        </div>

        {/* Scrollable content */}
        <div className="flex-1 overflow-y-auto p-6 space-y-8">
          {/* Ad name / naming convention */}
          {winner.ad_name && (
            <section>
              <SectionLabel>Ad Name</SectionLabel>
              <div className="glass-card border border-white/[0.04] rounded-lg p-4 bg-white/[0.02]">
                <p className="font-mono text-xs text-zinc-300 leading-relaxed break-all">
                  {winner.ad_name}
                </p>
              </div>
            </section>
          )}

          {/* Video / Thumbnail preview */}
          {(winner.video_url || winner.thumbnail_url) && (
            <VideoPreview
              videoUrl={winner.video_url}
              thumbnailUrl={winner.thumbnail_url}
            />
          )}

          {/* Metrics grid */}
          <section>
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
          </section>

          {/* Info pills */}
          <section>
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
          </section>

          {/* Iterations */}
          {(winner.existing_iterations != null || iterationCodes.length > 0) && (
            <section>
              <SectionLabel>Iterations</SectionLabel>
              <div className="glass-card border border-white/[0.04] rounded-lg p-4 bg-white/[0.02] space-y-2">
                {winner.existing_iterations != null && (
                  <p className="text-sm text-zinc-400 font-mono">
                    <span className="text-zinc-600">Existing:</span>{' '}
                    <span className="font-semibold text-white">{winner.existing_iterations}</span>
                  </p>
                )}
                {iterationCodes.length > 0 && (
                  <div className="flex flex-wrap gap-1.5">
                    {iterationCodes.map((code, i) => (
                      <span
                        key={i}
                        className="px-2 py-0.5 text-[11px] font-mono rounded bg-white/[0.04] border border-white/[0.06] text-zinc-400"
                      >
                        {code}
                      </span>
                    ))}
                  </div>
                )}
              </div>
            </section>
          )}

          {/* Script */}
          {script && (
            <section>
              <SectionLabel>Script</SectionLabel>
              {script.type === 'parsed' ? (
                <div className="space-y-3">
                  {script.hooks.length > 0 && (
                    <div className="space-y-3">
                      {script.hooks.map((hook, i) => (
                        <HookCard key={i} hook={typeof hook === 'string' ? { text: hook } : hook} index={i} />
                      ))}
                    </div>
                  )}
                  {script.body && (
                    <div className="max-h-80 overflow-y-auto glass-card border border-white/[0.04] rounded-lg p-4 bg-white/[0.02]">
                      <p className="text-sm text-zinc-300 leading-relaxed whitespace-pre-line">
                        {script.body}
                      </p>
                    </div>
                  )}
                </div>
              ) : (
                <div className="max-h-80 overflow-y-auto glass-card border border-white/[0.04] rounded-lg p-4 bg-white/[0.02]">
                  <pre className="text-sm text-zinc-400 leading-relaxed whitespace-pre-wrap font-mono">
                    {script.content}
                  </pre>
                </div>
              )}
            </section>
          )}

          {/* Iteration config */}
          <section className="space-y-4">
            <SectionLabel>Iteration Config</SectionLabel>
            <div className="space-y-2">
              <span className="text-[10px] font-mono text-zinc-500 uppercase tracking-[0.15em]">Mode</span>
              <PillGroup options={ITER_MODES} value={iterMode} onChange={setIterMode} />
            </div>
            <div className="space-y-2">
              <span className="text-[10px] font-mono text-zinc-500 uppercase tracking-[0.15em]">Aggressiveness</span>
              <PillGroup options={AGGRESSIVENESS} value={aggressiveness} onChange={setAggressiveness} />
            </div>
            <div className="space-y-2">
              <span className="text-[10px] font-mono text-zinc-500 uppercase tracking-[0.15em]">Variations</span>
              <PillGroup options={VARIATION_COUNTS} value={numVariations} onChange={setNumVariations} />
            </div>
          </section>
        </div>

        {/* Footer */}
        <div className="p-6 border-t border-white/[0.06] bg-[#111113]">
          <button
            type="button"
            onClick={() => onGenerate?.(winner.id, {
              iteration_mode: iterMode,
              aggressiveness,
              num_variations: numVariations,
            })}
            disabled={generating}
            className="w-full flex items-center justify-center gap-2 px-4 py-3 rounded-lg text-sm font-mono font-semibold uppercase tracking-wide transition-all cursor-pointer disabled:opacity-40"
            style={{
              background: generating ? '#1a1710' : 'linear-gradient(135deg, #c9a84c, #d4b55a)',
              color: generating ? '#c9a84c' : '#111113',
              border: generating ? '1px solid rgba(201,168,76,0.2)' : 'none',
              boxShadow: generating ? 'none' : '0 0 20px rgba(201,168,76,0.25), 0 1px 3px rgba(0,0,0,0.4), inset 0 1px 0 0 rgba(255,255,255,0.2)',
            }}
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
