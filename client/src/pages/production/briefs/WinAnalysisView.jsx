import {
  Brain,
  Zap,
  Target,
  Shield,
  ArrowRight,
  Lightbulb,
  CheckCircle2,
  TrendingUp,
} from 'lucide-react';

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const EMOTION_COLORS = {
  fear:      { bg: 'bg-red-500/20',     text: 'text-red-300',     bar: 'from-red-500 to-red-400' },
  greed:     { bg: 'bg-emerald-500/20',  text: 'text-emerald-300', bar: 'from-emerald-500 to-emerald-400' },
  curiosity: { bg: 'bg-blue-500/20',     text: 'text-blue-300',    bar: 'from-blue-500 to-blue-400' },
  fomo:      { bg: 'bg-orange-500/20',   text: 'text-orange-300',  bar: 'from-orange-500 to-orange-400' },
  desire:    { bg: 'bg-pink-500/20',     text: 'text-pink-300',    bar: 'from-pink-500 to-pink-400' },
  anger:     { bg: 'bg-rose-500/20',     text: 'text-rose-300',    bar: 'from-rose-500 to-rose-400' },
  trust:     { bg: 'bg-cyan-500/20',     text: 'text-cyan-300',    bar: 'from-cyan-500 to-cyan-400' },
  hope:      { bg: 'bg-violet-500/20',   text: 'text-violet-300',  bar: 'from-violet-500 to-violet-400' },
};

const DEFAULT_EMOTION = { bg: 'bg-bg-elevated', text: 'text-text-muted', bar: 'from-white/60 to-white/40' };

function emotionStyle(emotion) {
  return EMOTION_COLORS[emotion?.toLowerCase()] || DEFAULT_EMOTION;
}

// ---------------------------------------------------------------------------
// Shared UI helpers
// ---------------------------------------------------------------------------

const Card = ({ children, className = '' }) => (
  <div className={`bg-bg-main border border-border-default rounded-lg p-4 ${className}`}>
    {children}
  </div>
);

const SectionTitle = ({ icon: Icon, children }) => (
  <h3 className="flex items-center gap-2 text-sm font-semibold text-text-primary mb-3">
    <Icon size={15} className="text-text-faint" />
    {children}
  </h3>
);

const Pill = ({ color, children }) => {
  const style = emotionStyle(color);
  return (
    <span className={`inline-flex items-center px-2 py-0.5 rounded-full text-xs font-medium ${style.bg} ${style.text}`}>
      {children}
    </span>
  );
};

const StrengthBar = ({ value, max = 10, gradient = 'from-blue-500 to-cyan-400' }) => (
  <div className="flex items-center gap-2 w-full">
    <div className="flex-1 h-1.5 rounded-full bg-bg-elevated overflow-hidden">
      <div
        className={`h-full rounded-full bg-gradient-to-r ${gradient}`}
        style={{ width: `${(value / max) * 100}%` }}
      />
    </div>
    <span className="text-[11px] text-text-faint tabular-nums w-5 text-right">{value}</span>
  </div>
);

// ---------------------------------------------------------------------------
// Sub-sections
// ---------------------------------------------------------------------------

function OverallStrength({ analysis }) {
  const strengths = [
    analysis.proof_architecture?.strength,
    analysis.emotional_driver?.intensity,
    ...(analysis.hook_analysis || []).map((h) => h.strength),
  ].filter(Boolean);
  const avg = strengths.length ? Math.round(strengths.reduce((a, b) => a + b, 0) / strengths.length) : 0;
  return (
    <div className="flex items-center gap-3">
      <span className="text-lg font-bold text-text-primary">Win Analysis</span>
      <div className="flex items-center gap-1.5 ml-auto">
        <TrendingUp size={14} className="text-emerald-400" />
        <span className="text-xs text-text-faint">Strength</span>
        <StrengthBar value={avg} gradient="from-emerald-500 to-emerald-300" />
      </div>
    </div>
  );
}

function HookAnalysisSection({ hooks }) {
  if (!hooks?.length) return null;
  return (
    <Card>
      <SectionTitle icon={Zap}>Hook Analysis</SectionTitle>
      <div className="flex gap-3 overflow-x-auto pb-1 -mx-1 px-1">
        {hooks.map((hook) => {
          const style = emotionStyle(hook.mechanism);
          return (
            <div
              key={hook.hook_id}
              className="min-w-[200px] flex-shrink-0 bg-bg-elevated border border-border-subtle rounded-md p-3 space-y-2"
            >
              <div className="flex items-center justify-between">
                <span className="text-xs font-bold text-text-primary">{hook.hook_id}</span>
                <Pill color={hook.mechanism}>{hook.mechanism}</Pill>
              </div>
              <StrengthBar value={hook.strength} gradient={style.bar} />
              <p className="text-[11px] text-text-faint leading-relaxed">{hook.why_it_works}</p>
            </div>
          );
        })}
      </div>
    </Card>
  );
}

function EmotionalDriverSection({ driver }) {
  if (!driver) return null;
  const primary = emotionStyle(driver.primary);
  return (
    <Card>
      <SectionTitle icon={Brain}>Emotional Driver</SectionTitle>
      <div className="space-y-3">
        <div className="flex items-center gap-2 flex-wrap">
          <span className={`px-3 py-1 rounded-full text-sm font-semibold ${primary.bg} ${primary.text}`}>
            {driver.primary}
          </span>
          {(driver.secondary || []).map((e) => (
            <Pill key={e} color={e}>{e}</Pill>
          ))}
        </div>
        <div>
          <span className="text-[11px] text-text-faint block mb-1">Intensity</span>
          <StrengthBar value={driver.intensity} gradient={primary.bar} />
        </div>
        {driver.trigger_sentence && (
          <p className="text-xs text-text-faint italic leading-relaxed">
            &ldquo;{driver.trigger_sentence}&rdquo;
          </p>
        )}
      </div>
    </Card>
  );
}

function BeliefShiftSection({ shift }) {
  if (!shift) return null;
  return (
    <Card>
      <SectionTitle icon={Target}>Belief Shift</SectionTitle>
      <div className="flex items-center gap-3">
        <div className="flex-1 bg-bg-elevated border border-border-subtle rounded-md p-3">
          <span className="text-[10px] uppercase tracking-wider text-text-faint block mb-1">Before</span>
          <p className="text-xs text-text-muted leading-relaxed">{shift.before}</p>
        </div>
        <ArrowRight size={18} className="text-text-faint flex-shrink-0" />
        <div className="flex-1 bg-bg-elevated border border-border-subtle rounded-md p-3">
          <span className="text-[10px] uppercase tracking-wider text-text-faint block mb-1">After</span>
          <p className="text-xs text-text-muted leading-relaxed">{shift.after}</p>
        </div>
      </div>
      {shift.pivot_moment && (
        <p className="text-[11px] text-text-faint mt-2 text-center">
          Pivot: <span className="text-text-muted">{shift.pivot_moment}</span>
        </p>
      )}
    </Card>
  );
}

function ProofArchitectureSection({ proof }) {
  if (!proof) return null;
  return (
    <Card>
      <SectionTitle icon={Shield}>Proof Architecture</SectionTitle>
      <div className="space-y-3">
        <div className="flex items-center gap-2 flex-wrap">
          <Pill color={null}>{proof.type}</Pill>
          <div className="flex-1 min-w-[100px]">
            <StrengthBar value={proof.strength} gradient="from-violet-500 to-violet-300" />
          </div>
        </div>
        <div className="flex gap-1.5 flex-wrap">
          {(proof.elements || []).map((el) => (
            <span key={el} className="px-2 py-0.5 rounded-full text-[11px] bg-bg-elevated text-text-faint">
              {el}
            </span>
          ))}
        </div>
        {proof.most_convincing_line && (
          <p className="text-xs text-text-faint italic leading-relaxed">
            &ldquo;{proof.most_convincing_line}&rdquo;
          </p>
        )}
      </div>
    </Card>
  );
}

function EnemyStructureSection({ enemy }) {
  if (!enemy) return null;
  return (
    <Card>
      <SectionTitle icon={Target}>Enemy Structure</SectionTitle>
      <div className="space-y-2">
        <div className="flex items-center gap-2">
          <span className="text-sm font-bold text-text-primary">{enemy.villain}</span>
          {enemy.us_vs_them && (
            <span className="px-2 py-0.5 rounded-full text-[10px] font-medium bg-red-500/20 text-red-300">
              Us vs Them
            </span>
          )}
        </div>
        {enemy.introduction && (
          <p className="text-[11px] text-text-faint leading-relaxed">
            <span className="text-text-faint">Intro:</span> {enemy.introduction}
          </p>
        )}
        {enemy.defeat && (
          <p className="text-[11px] text-text-faint leading-relaxed">
            <span className="text-text-faint">Defeat:</span> {enemy.defeat}
          </p>
        )}
      </div>
    </Card>
  );
}

function WinningElementsList({ elements }) {
  if (!elements?.length) return null;
  return (
    <Card>
      <SectionTitle icon={CheckCircle2}>Winning Elements</SectionTitle>
      <ol className="space-y-1.5">
        {elements.map((el, i) => (
          <li key={i} className="flex items-start gap-2 text-xs text-text-muted leading-relaxed">
            <CheckCircle2 size={13} className="text-emerald-400 mt-0.5 flex-shrink-0" />
            <span>{el}</span>
          </li>
        ))}
      </ol>
    </Card>
  );
}

function IterationOpportunitiesList({ items }) {
  if (!items?.length) return null;
  return (
    <Card>
      <SectionTitle icon={Lightbulb}>Iteration Opportunities</SectionTitle>
      <ol className="space-y-1.5">
        {items.map((item, i) => (
          <li key={i} className="flex items-start gap-2 text-xs text-text-muted leading-relaxed">
            <Lightbulb size={13} className="text-amber-400 mt-0.5 flex-shrink-0" />
            <span>{item}</span>
          </li>
        ))}
      </ol>
    </Card>
  );
}

// ---------------------------------------------------------------------------
// Main export
// ---------------------------------------------------------------------------

export function WinAnalysisView({ analysis, originalScript }) {
  if (!analysis) return null;

  return (
    <div className="space-y-4">
      <Card>
        <OverallStrength analysis={analysis} />
      </Card>

      <HookAnalysisSection hooks={analysis.hook_analysis} />
      <EmotionalDriverSection driver={analysis.emotional_driver} />
      <BeliefShiftSection shift={analysis.belief_shift} />
      <ProofArchitectureSection proof={analysis.proof_architecture} />
      <EnemyStructureSection enemy={analysis.enemy_structure} />
      <WinningElementsList elements={analysis.winning_elements_ranked} />
      <IterationOpportunitiesList items={analysis.iteration_opportunities} />
    </div>
  );
}
