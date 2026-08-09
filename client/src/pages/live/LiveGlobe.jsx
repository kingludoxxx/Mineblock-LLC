// LiveGlobe — the rotating visitor globe.
//
// DEPENDENCY DECISION. The reference (funnel-os LiveGlobe.jsx) renders with
// `globe.gl` on top of three.js, and pulls its Earth texture + the country
// TopoJSON from a CDN at runtime. We have `three` already (DottedSurface.jsx)
// but NOT `globe.gl`, and the brief rules out remote assets outright. So this
// is the same picture drawn with plain 2D canvas maths: an orthographic
// projection (livePresentation.project, proven in the harness), bundled land
// rings, and additive pulses. No new npm dependency, no network, ~37 KB of
// generated coordinates instead of a WebGL context per card.
//
// WHAT IT PLOTS, AND WHY IT IS NOT A LIE. Our SSE feed events carry NO geo —
// server/src/services/liveViewQueries.js selects neither lb_touches.country
// into a touch event nor any location at all for a purchase. What the snapshot
// DOES carry is geo.by_country: today's distinct visitors per ISO country
// code. So the globe plots COUNTRIES, sized by visitor count, at a country
// centroid — and the card says so in as many words. A rising count between two
// snapshots is the only arrival claim the payload supports, and that is what
// makes a marker ripple (livePresentation.trackArrivals).
//
// The server ships only the TOP N countries and flags the cut with
// geo.truncated / geo.countries_total. Both are honoured: the count is stated
// in the header, and while the list is truncated a country appearing for the
// first time does NOT ripple — we cannot tell "new" from "newly visible", and
// rippling would report its whole running total as if it had just arrived.
//
// Explicitly NOT done: a pin per visitor, an arc between buyer and store, a
// city. Each would require inventing a coordinate we never read.
//
// LEAK CONTRACT: one rAF loop, one ResizeObserver, one reduced-motion
// listener, all torn down on unmount. The loop also parks itself when the tab
// is hidden or the card scrolls out of view — a 60fps canvas in a background
// tab is exactly the immortal-poll bug this codebase has been bitten by.
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Globe2 } from 'lucide-react';
import Card from '../../components/ui/Card';
import LAND_RINGS from './worldLand.js';
import {
  deriveGeoPoints, trackArrivals, createArrivalState, fmtInt, countryLabel,
} from './livePresentation.js';
import drawGlobe from './globeRender.js';

const ROTATION_DEG_PER_SEC = 4.5; // a full turn every 80s — ambient, not dizzying
const TILT_DEG = 18;              // lean the north pole toward the viewer
const MAX_RIPPLES = 24;

function useReducedMotion() {
  const [reduced, setReduced] = useState(false);
  useEffect(() => {
    if (typeof window === 'undefined' || !window.matchMedia) return undefined;
    const mq = window.matchMedia('(prefers-reduced-motion: reduce)');
    const apply = () => setReduced(mq.matches);
    apply();
    // Safari <14 only has the deprecated form; support both, remove both.
    if (mq.addEventListener) {
      mq.addEventListener('change', apply);
      return () => mq.removeEventListener('change', apply);
    }
    mq.addListener(apply);
    return () => mq.removeListener(apply);
  }, []);
  return reduced;
}

export default function LiveGlobe({ geo, live = 0 }) {
  // CALLBACK REFS IN STATE, not useRef. This component early-returns an empty
  // state when there is nothing to plot, and on the very first commit there is
  // ALWAYS nothing to plot — the snapshot starts null, so no <canvas> exists
  // yet. A `useRef` + `[]`-dep effect therefore ran exactly once, found
  // `canvasRef.current === null`, returned, and never ran again when the
  // canvas finally appeared: the globe rendered as a blank default-sized
  // canvas on every single load, and one degraded read that emptied the card
  // killed it permanently. Keying the effect on the ELEMENT re-arms it every
  // time the canvas mounts, including after an empty → populated → empty →
  // populated cycle. (Regression-tested in
  // server/tests/live-view/globe-effect.mjs.)
  // The ELEMENTS live in refs (a DOM node is not React state, and mutating
  // canvas.width on a useState value trips react-hooks/immutability); a
  // MOUNT COUNTER in state is what re-arms the effect. Callback refs write the
  // ref and bump the counter — both at commit time, never during render.
  const canvasRef = useRef(null);
  const wrapRef = useRef(null);
  const [mountTick, setMountTick] = useState(0);
  const setCanvasEl = useCallback((node) => {
    canvasRef.current = node;
    setMountTick((t) => t + 1);
  }, []);
  const setWrapEl = useCallback((node) => {
    wrapRef.current = node;
    setMountTick((t) => t + 1);
  }, []);
  const reduced = useReducedMotion();

  // Derived synchronously so the legend and the canvas can never disagree.
  const derived = useMemo(() => deriveGeoPoints(geo), [geo]);
  const truncated = Boolean(geo?.truncated);

  // Everything the animation loop reads lives in this ref, so a new snapshot
  // (~every 3s) updates the scene WITHOUT tearing down the rAF loop.
  const sceneRef = useRef({ points: [], ripples: [], reduced: false, max: 1 });
  const arrivalRef = useRef(createArrivalState());

  useEffect(() => {
    const pts = derived.points;
    // Stateful across snapshots, and truncation-aware: a country crossing into
    // a truncated top-N list is NOT an arrival of its whole running total.
    const { state, arrivals } = trackArrivals(arrivalRef.current, pts, { truncated });
    arrivalRef.current = state;

    const now = performance.now();
    const scene = sceneRef.current;
    scene.points = pts;
    scene.max = Math.max(1, ...pts.map((p) => p.visitors));
    if (arrivals.length) {
      for (const a of arrivals) scene.ripples.push({ lat: a.lat, lon: a.lon, at: now });
      // Bound it: a first-of-day burst must not grow an unbounded array.
      if (scene.ripples.length > MAX_RIPPLES) {
        scene.ripples.splice(0, scene.ripples.length - MAX_RIPPLES);
      }
    }
  }, [derived, truncated]);

  useEffect(() => { sceneRef.current.reduced = reduced; }, [reduced]);

  useEffect(() => {
    const canvas = canvasRef.current;
    const wrap = wrapRef.current;
    if (!canvas || !wrap) return undefined;
    const ctx = canvas.getContext('2d');
    if (!ctx) return undefined; // canvas unavailable ⇒ the empty state below stands

    let raf = 0;
    let alive = true;
    // Two INDEPENDENT reasons to park the loop. Collapsing them into one flag
    // lets a tab-focus event resurrect the loop for a card that is scrolled
    // out of view (and vice versa).
    let tabVisible = typeof document === 'undefined' || !document.hidden;
    let onScreen = true;
    let size = 0;
    let dpr = 1;
    let rotation = 0;
    let last = performance.now();

    const resize = () => {
      const rect = wrap.getBoundingClientRect();
      const css = Math.max(120, Math.min(rect.width, 420));
      dpr = Math.min(window.devicePixelRatio || 1, 2); // cap: 3x on a phone is free heat
      size = css;
      canvas.width = Math.round(css * dpr);
      canvas.height = Math.round(css * dpr);
      canvas.style.width = `${css}px`;
      canvas.style.height = `${css}px`;
    };
    resize();

    const draw = (now) => {
      const dt = Math.min(0.1, (now - last) / 1000); // clamp: a backgrounded tab
      last = now;                                     // must not jump 40 seconds
      const scene = sceneRef.current;
      if (!scene.reduced) rotation = (rotation + ROTATION_DEG_PER_SEC * dt) % 360;

      // The paint itself lives in globeRender.js so it can be executed by
      // `node server/tests/live-view/globe-render.mjs` against a recording
      // fake context — a canvas is the one part of this page a harness cannot
      // otherwise reach.
      drawGlobe(ctx, scene, {
        size, dpr, rotation, tilt: TILT_DEG, now, landRings: LAND_RINGS,
      });

      if (alive && tabVisible && onScreen) raf = requestAnimationFrame(draw);
      else raf = 0; // parked: `start` must be able to tell it is not running
    };

    const start = () => {
      if (!alive || raf || !tabVisible || !onScreen) return;
      last = performance.now();
      raf = requestAnimationFrame(draw);
    };
    const stop = () => {
      if (raf) cancelAnimationFrame(raf);
      raf = 0;
    };

    // Park the loop when the tab is hidden OR the card is off-screen.
    const onVisibility = () => {
      tabVisible = !document.hidden;
      if (tabVisible) start(); else stop();
    };
    document.addEventListener('visibilitychange', onVisibility);

    const ro = new ResizeObserver(() => {
      resize();
      // A resize while parked still needs one frame, or the canvas stays blank
      // at its new size until something else wakes the loop.
      if (!raf) { const n = performance.now(); last = n; draw(n); stop(); }
    });
    ro.observe(wrap);

    let io = null;
    if (typeof IntersectionObserver !== 'undefined') {
      io = new IntersectionObserver((entries) => {
        onScreen = entries.some((e) => e.isIntersecting);
        if (onScreen) start(); else stop();
      }, { threshold: 0 });
      io.observe(wrap);
    }

    start();

    return () => {
      alive = false;
      stop();
      document.removeEventListener('visibilitychange', onVisibility);
      ro.disconnect();
      if (io) io.disconnect();
    };
  }, [mountTick]);

  const cov = geo?.coverage || null;
  const covLine = cov && cov.resolved_pct != null
    ? `${fmtInt(cov.resolved_visitors)} of ${fmtInt(cov.total_visitors)} visitors today have a country (${cov.resolved_pct}%)`
    : null;

  // ── the honest empty state ─────────────────────────────────────────────────
  // Zero events, a degraded read, or a day where nothing resolved: say which,
  // in the server's own words. Never a globe with no dots passed off as calm.
  if (!geo?.available || derived.plotted === 0) {
    return (
      <Card className="border-dashed" data-testid="lv-globe-empty">
        <div className="flex items-start gap-3">
          <Globe2 className="mt-0.5 h-5 w-5 shrink-0 text-text-faint" />
          <div className="min-w-0">
            <h3 className="text-[13px] font-medium text-text-primary">Visitor globe unavailable</h3>
            <p className="mt-1 text-[12px] leading-relaxed text-text-muted">
              {geo?.reason
                || (derived.total > 0
                  ? 'No visitor country could be placed on the map yet.'
                  : 'No country data for today.')}
            </p>
            {derived.offMap.length > 0 && (
              <p className="mt-1 text-[11px] text-text-faint">
                {fmtInt(derived.offMapVisitors)} visitor(s) came from {derived.offMap.length} code(s)
                with no place on the map ({derived.offMap.slice(0, 6).join(', ')}
                {derived.offMap.length > 6 ? '…' : ''}).
              </p>
            )}
            {covLine && <p className="mt-1 text-[11px] text-text-faint">{covLine}</p>}
          </div>
        </div>
      </Card>
    );
  }

  const top = derived.points.slice(-4).reverse(); // points sort ASC; take the biggest

  return (
    <Card data-testid="lv-globe">
      <div className="mb-3 flex items-baseline justify-between gap-2">
        <div className="flex items-center gap-2">
          <Globe2 className="h-4 w-4 shrink-0 text-text-faint" />
          <h2 className="text-sm font-semibold text-text-primary">Visitors by country</h2>
        </div>
        <span className="shrink-0 text-[11px] tabular-nums text-text-faint">
          {/* A truncated list presented as a whole is the same lie as a sample
              presented as a census — the server flags the cut, so say so. */}
          {truncated ? (
            <span data-testid="lv-globe-truncated">
              top {fmtInt(derived.plotted + derived.offMap.length)} of{' '}
              {fmtInt(geo?.countries_total)} countries
            </span>
          ) : (
            <>{fmtInt(live)} live</>
          )}
        </span>
      </div>

      <div ref={setWrapEl} className="flex items-center justify-center">
        <canvas
          ref={setCanvasEl}
          role="img"
          aria-label={`Rotating globe showing ${derived.plotted} countries with visitors today`}
          className="max-w-full"
        />
      </div>

      {/* The legend is the honest half of the picture: a dot is a COUNTRY, not
          a person, and it sits on a centroid, not on anybody's address. */}
      <ul className="mt-3 space-y-1.5" data-testid="lv-globe-legend">
        {top.map((p) => (
          <li key={p.country} className="flex items-baseline justify-between gap-2 text-[12px]">
            <span className="truncate text-text-primary">
              {p.label || countryLabel(p.country)}
              <span className="ml-1.5 text-[11px] text-text-faint">{p.country}</span>
            </span>
            <span className="shrink-0 tabular-nums font-semibold text-text-primary">
              {fmtInt(p.visitors)}
            </span>
          </li>
        ))}
      </ul>

      <p className="mt-3 text-[11px] leading-relaxed text-text-faint" data-testid="lv-globe-caveat">
        Each marker is a COUNTRY placed at its centroid and sized by today&rsquo;s visitors —
        not a person&rsquo;s location. A marker ripples when that country&rsquo;s count rises.
        {truncated && (
          <span className="mt-0.5 block">
            Only the top {fmtInt(derived.plotted + derived.offMap.length)} of{' '}
            {fmtInt(geo?.countries_total)} countries are shown, so a country entering the
            list is not counted as an arrival.
          </span>
        )}
        {derived.offMap.length > 0 && (
          <span className="mt-0.5 block">
            {fmtInt(derived.offMapVisitors)} visitor(s) from {derived.offMap.length} code(s) have no
            place on the map and are not drawn ({derived.offMap.slice(0, 6).join(', ')}
            {derived.offMap.length > 6 ? '…' : ''}).
          </span>
        )}
        {covLine && <span className="mt-0.5 block">{covLine}</span>}
        <span className="mt-0.5 block">
          A visitor seen from two countries counts in both, so the rows can sum above that number.
        </span>
      </p>
    </Card>
  );
}
