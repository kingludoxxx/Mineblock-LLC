import { useEffect, useRef, useState } from 'react';

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
// AresAgent — Canvas-based animated AI agent indicator (Magic Patterns match)
// ---------------------------------------------------------------------------

export function AresAgent({ active, step = 0 }) {
  const canvasRef = useRef(null);
  const frameRef = useRef();
  const tRef = useRef(0);
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

  // Canvas orb animation — exact Magic Patterns implementation
  useEffect(() => {
    if (!active) return;
    const canvas = canvasRef.current;
    if (!canvas) return;
    const ctx = canvas.getContext('2d');
    if (!ctx) return;

    const dpr = window.devicePixelRatio || 1;
    const W = 48;
    const H = 48;
    canvas.width = W * dpr;
    canvas.height = H * dpr;
    ctx.scale(dpr, dpr);

    const cx = W / 2;
    const cy = H / 2;
    const orbR = 16;

    const draw = () => {
      tRef.current += 0.006;
      const t = tRef.current;
      ctx.clearRect(0, 0, W, H);

      // Outer ambient haze (blue-purple)
      const haze = ctx.createRadialGradient(cx, cy, orbR - 2, cx, cy, orbR + 8);
      haze.addColorStop(0, 'rgba(100, 60, 180, 0.18)');
      haze.addColorStop(0.5, 'rgba(80, 40, 160, 0.08)');
      haze.addColorStop(1, 'rgba(60, 20, 120, 0)');
      ctx.fillStyle = haze;
      ctx.beginPath();
      ctx.arc(cx, cy, orbR + 8, 0, Math.PI * 2);
      ctx.fill();

      // Orb base (dark sphere)
      const baseGrad = ctx.createRadialGradient(cx, cy, 0, cx, cy, orbR);
      baseGrad.addColorStop(0, 'rgba(40, 15, 30, 0.95)');
      baseGrad.addColorStop(0.7, 'rgba(25, 8, 20, 0.95)');
      baseGrad.addColorStop(1, 'rgba(15, 5, 15, 0.85)');
      ctx.fillStyle = baseGrad;
      ctx.beginPath();
      ctx.arc(cx, cy, orbR, 0, Math.PI * 2);
      ctx.fill();

      // Clip to orb
      ctx.save();
      ctx.beginPath();
      ctx.arc(cx, cy, orbR, 0, Math.PI * 2);
      ctx.clip();
      ctx.globalCompositeOperation = 'screen';

      // Gold blob — fast visible orbit
      const goldAngle = t * 1.8;
      const goldX = cx + Math.cos(goldAngle) * 7 + Math.sin(t * 2.5) * 2;
      const goldY = cy + Math.sin(goldAngle * 0.9) * 6 + Math.cos(t * 1.4) * 2;
      const goldR = 9 + Math.sin(t * 2.2) * 2;
      const goldGrad = ctx.createRadialGradient(goldX, goldY, 0, goldX, goldY, goldR);
      goldGrad.addColorStop(0, 'rgba(255, 210, 80, 0.95)');
      goldGrad.addColorStop(0.3, 'rgba(255, 170, 40, 0.75)');
      goldGrad.addColorStop(0.6, 'rgba(230, 120, 20, 0.35)');
      goldGrad.addColorStop(1, 'rgba(200, 80, 10, 0)');
      ctx.fillStyle = goldGrad;
      ctx.beginPath();
      ctx.arc(goldX, goldY, goldR, 0, Math.PI * 2);
      ctx.fill();

      // Red blob — opposite orbit
      const redAngle = t * 1.5 + Math.PI;
      const redX = cx + Math.cos(redAngle) * 8 + Math.sin(t * 1.8 + 1) * 2;
      const redY = cy + Math.sin(redAngle * 1.1) * 7 + Math.cos(t * 2.1) * 2;
      const redR = 10 + Math.sin(t * 1.9 + 1) * 2;
      const redGrad = ctx.createRadialGradient(redX, redY, 0, redX, redY, redR);
      redGrad.addColorStop(0, 'rgba(230, 45, 30, 0.9)');
      redGrad.addColorStop(0.3, 'rgba(190, 30, 20, 0.65)');
      redGrad.addColorStop(0.6, 'rgba(140, 20, 15, 0.3)');
      redGrad.addColorStop(1, 'rgba(100, 10, 10, 0)');
      ctx.fillStyle = redGrad;
      ctx.beginPath();
      ctx.arc(redX, redY, redR, 0, Math.PI * 2);
      ctx.fill();

      // Hot white-gold accent — faster drift
      const hotAngle = t * 2.5;
      const hotX = cx + Math.cos(hotAngle) * 4;
      const hotY = cy + Math.sin(hotAngle * 1.3) * 4;
      const hotGrad = ctx.createRadialGradient(hotX, hotY, 0, hotX, hotY, 4.5);
      hotGrad.addColorStop(0, 'rgba(255, 245, 210, 0.9)');
      hotGrad.addColorStop(0.4, 'rgba(255, 190, 80, 0.5)');
      hotGrad.addColorStop(1, 'rgba(255, 120, 40, 0)');
      ctx.fillStyle = hotGrad;
      ctx.beginPath();
      ctx.arc(hotX, hotY, 4.5, 0, Math.PI * 2);
      ctx.fill();

      // Small red spark
      const spkAngle = t * 3.2 + 1;
      const spkX = cx + Math.cos(spkAngle) * 5;
      const spkY = cy + Math.sin(spkAngle * 0.8) * 5;
      const spkGrad = ctx.createRadialGradient(spkX, spkY, 0, spkX, spkY, 3);
      spkGrad.addColorStop(0, 'rgba(255, 70, 30, 0.7)');
      spkGrad.addColorStop(1, 'rgba(180, 20, 10, 0)');
      ctx.fillStyle = spkGrad;
      ctx.beginPath();
      ctx.arc(spkX, spkY, 3, 0, Math.PI * 2);
      ctx.fill();

      ctx.globalCompositeOperation = 'source-over';
      ctx.restore();

      // Rim light
      const rimGrad = ctx.createRadialGradient(cx, cy, orbR - 2, cx, cy, orbR + 0.5);
      rimGrad.addColorStop(0, 'rgba(255, 150, 60, 0)');
      rimGrad.addColorStop(0.6, 'rgba(255, 120, 40, 0.2)');
      rimGrad.addColorStop(1, 'rgba(200, 60, 20, 0.05)');
      ctx.fillStyle = rimGrad;
      ctx.beginPath();
      ctx.arc(cx, cy, orbR + 0.5, 0, Math.PI * 2);
      ctx.fill();

      // Outer ring 1 — rotating segmented arcs
      const ringAngle = t * 0.5;
      ctx.strokeStyle = 'rgba(200, 100, 50, 0.2)';
      ctx.lineWidth = 0.8;
      ctx.lineCap = 'round';
      for (let i = 0; i < 3; i++) {
        const start = ringAngle + (i * Math.PI * 2) / 3;
        ctx.beginPath();
        ctx.arc(cx, cy, orbR + 4, start, start + Math.PI * 0.45);
        ctx.stroke();
      }

      // Outer ring 2 — counter-rotate
      ctx.strokeStyle = 'rgba(130, 60, 160, 0.12)';
      ctx.lineWidth = 0.6;
      for (let i = 0; i < 4; i++) {
        const start = -ringAngle * 0.7 + (i * Math.PI * 2) / 4;
        ctx.beginPath();
        ctx.arc(cx, cy, orbR + 6.5, start, start + Math.PI * 0.28);
        ctx.stroke();
      }

      frameRef.current = requestAnimationFrame(draw);
    };

    draw();
    return () => {
      if (frameRef.current) cancelAnimationFrame(frameRef.current);
    };
  }, [active]);

  if (!active) return null;

  const statusText = STEP_MESSAGES[step] || STEP_MESSAGES[1];

  return (
    <div
      className={`transition-all duration-500 ${visible ? 'opacity-100 translate-y-0' : 'opacity-0 translate-y-2'}`}
    >
      {/* Animated border gradient wrapper */}
      <div className="relative rounded-lg" style={{ position: 'relative' }}>
        {/* Animated gradient border */}
        <div
          className="absolute rounded-lg pointer-events-none"
          style={{
            inset: '-1px',
            padding: '1px',
            background: 'linear-gradient(135deg, rgba(201, 168, 76, 0.4), rgba(255, 255, 255, 0.15), rgba(201, 168, 76, 0.4))',
            backgroundSize: '200% auto',
            WebkitMask: 'linear-gradient(#fff 0 0) content-box, linear-gradient(#fff 0 0)',
            WebkitMaskComposite: 'xor',
            maskComposite: 'exclude',
            borderRadius: 'inherit',
            animation: 'ares-border-flow 4s linear infinite',
          }}
        />

        {/* Glass card */}
        <div
          className="border border-white/[0.05] rounded-lg px-3 py-2.5"
          style={{
            background: 'linear-gradient(135deg, rgba(255,255,255,0.04) 0%, rgba(255,255,255,0.01) 100%)',
            backdropFilter: 'blur(12px)',
            WebkitBackdropFilter: 'blur(12px)',
            boxShadow: 'inset 0 1px 0 0 rgba(255,255,255,0.02), 0 2px 12px rgba(200,60,10,0.04)',
          }}
        >
          <div className="flex items-center gap-3">
            {/* Canvas orb */}
            <div className="shrink-0">
              <canvas
                ref={canvasRef}
                style={{ width: '48px', height: '48px' }}
              />
            </div>

            {/* Text content */}
            <div className="flex-1 min-w-0">
              {/* Name + badge */}
              <div className="flex items-center gap-1.5 mb-px">
                <span
                  className="font-mono text-[11px] uppercase tracking-wider text-[#e8d5a3]"
                  style={{ textShadow: '0 0 12px rgba(201, 168, 76, 0.4)' }}
                >
                  ARES AI
                </span>
                <span className="font-mono text-[8px] uppercase tracking-wider text-zinc-600 bg-white/[0.03] border border-white/[0.06] rounded px-1 py-px leading-none">
                  Agent
                </span>
              </div>

              {/* Status text */}
              <p className="text-[10px] text-zinc-500 leading-snug truncate">
                {statusText}
              </p>

              {/* Active indicator */}
              <div className="flex items-center gap-1 mt-1">
                <div
                  className="w-1 h-1 rounded-full bg-emerald-500"
                  style={{ boxShadow: '0 0 4px rgba(16,185,129,0.6)' }}
                />
                <span className="font-mono text-[8px] uppercase tracking-wider text-zinc-400">
                  Active{dots}
                </span>
              </div>
            </div>
          </div>
        </div>
      </div>

      {/* CSS Animation for border flow */}
      <style>{`
        @keyframes ares-border-flow {
          0% { background-position: 0% 50%; }
          50% { background-position: 100% 50%; }
          100% { background-position: 0% 50%; }
        }
      `}</style>
    </div>
  );
}
