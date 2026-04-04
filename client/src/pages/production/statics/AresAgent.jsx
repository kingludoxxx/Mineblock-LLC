import { useEffect, useState } from 'react';

// ---------------------------------------------------------------------------
// Step-based status messages
// ---------------------------------------------------------------------------
const STEP_MESSAGES = {
  0: 'Initializing pipeline...',
  1: 'Analyzing reference template...',
  2: 'Generating creative assets...',
  3: 'Saving to pipeline...',
};

// ---------------------------------------------------------------------------
// AresAgent — Animated AI agent indicator for the statics sidebar
// ---------------------------------------------------------------------------

export function AresAgent({ active, step = 0 }) {
  const [visible, setVisible] = useState(false);
  const [dots, setDots] = useState('');

  // Fade in/out
  useEffect(() => {
    if (active) {
      const t = setTimeout(() => setVisible(true), 50);
      return () => clearTimeout(t);
    }
    setVisible(false);
  }, [active]);

  // Animated dots
  useEffect(() => {
    if (!active) return;
    const iv = setInterval(() => {
      setDots(prev => (prev.length >= 3 ? '' : prev + '.'));
    }, 500);
    return () => clearInterval(iv);
  }, [active]);

  if (!active) return null;

  const statusText = STEP_MESSAGES[step] || STEP_MESSAGES[1];

  return (
    <div
      className={`transition-all duration-500 ${visible ? 'opacity-100 translate-y-0' : 'opacity-0 translate-y-2'}`}
    >
      <div className="relative rounded-xl overflow-hidden border border-white/[0.06] bg-[#0c0c0e]">
        {/* Subtle animated border glow */}
        <div
          className="absolute inset-0 rounded-xl pointer-events-none"
          style={{
            background: 'linear-gradient(135deg, rgba(201,168,76,0.08) 0%, transparent 50%, rgba(201,168,76,0.04) 100%)',
          }}
        />

        <div className="relative p-4 flex items-center gap-3.5">
          {/* Orb */}
          <div className="relative w-10 h-10 shrink-0">
            {/* Outer ring — slow rotation */}
            <div
              className="absolute inset-0 rounded-full border border-[#c9a84c]/20"
              style={{
                animation: 'ares-spin 8s linear infinite',
              }}
            >
              <div className="absolute -top-[2px] left-1/2 -translate-x-1/2 w-1 h-1 rounded-full bg-[#c9a84c]/60" />
            </div>

            {/* Middle ring — counter rotation */}
            <div
              className="absolute inset-[4px] rounded-full border border-[#c9a84c]/15"
              style={{
                animation: 'ares-spin 5s linear infinite reverse',
              }}
            >
              <div className="absolute -bottom-[2px] left-1/2 -translate-x-1/2 w-[3px] h-[3px] rounded-full bg-[#c9a84c]/40" />
            </div>

            {/* Core orb */}
            <div
              className="absolute inset-[8px] rounded-full"
              style={{
                background: 'radial-gradient(circle at 40% 35%, #d4a84c, #8b6914 60%, #3d2e08)',
                boxShadow: '0 0 12px rgba(201,168,76,0.35), 0 0 24px rgba(201,168,76,0.15), inset 0 -2px 4px rgba(0,0,0,0.4)',
                animation: 'ares-pulse 3s ease-in-out infinite',
              }}
            />
          </div>

          {/* Text content */}
          <div className="flex-1 min-w-0">
            {/* Name + badge */}
            <div className="flex items-center gap-2 mb-1">
              <span className="text-[11px] font-mono font-bold text-zinc-200 tracking-wide">
                ARES AI
              </span>
              <span className="text-[8px] font-mono font-semibold px-1.5 py-[1px] rounded border border-[#c9a84c]/25 text-[#c9a84c]/80 bg-[#c9a84c]/5 tracking-wider">
                AGENT
              </span>
            </div>

            {/* Status text */}
            <p className="text-[10px] text-zinc-500 font-medium leading-tight truncate">
              {statusText}
            </p>

            {/* Active indicator */}
            <div className="flex items-center gap-1.5 mt-1.5">
              <div
                className="w-[5px] h-[5px] rounded-full bg-emerald-500"
                style={{
                  boxShadow: '0 0 6px rgba(16,185,129,0.6)',
                  animation: 'ares-glow 2s ease-in-out infinite',
                }}
              />
              <span className="text-[9px] font-mono font-semibold text-emerald-500/80 tracking-[0.12em] uppercase">
                Active{dots}
              </span>
            </div>
          </div>
        </div>
      </div>

      {/* CSS Animations — injected once via <style> */}
      <style>{`
        @keyframes ares-spin {
          from { transform: rotate(0deg); }
          to { transform: rotate(360deg); }
        }
        @keyframes ares-pulse {
          0%, 100% { transform: scale(1); box-shadow: 0 0 12px rgba(201,168,76,0.35), 0 0 24px rgba(201,168,76,0.15), inset 0 -2px 4px rgba(0,0,0,0.4); }
          50% { transform: scale(1.06); box-shadow: 0 0 18px rgba(201,168,76,0.5), 0 0 32px rgba(201,168,76,0.2), inset 0 -2px 4px rgba(0,0,0,0.4); }
        }
        @keyframes ares-glow {
          0%, 100% { opacity: 1; }
          50% { opacity: 0.5; }
        }
      `}</style>
    </div>
  );
}
