// globeRender — the globe's paint routine, lifted out of the component.
//
// It lives here rather than inside LiveGlobe's rAF closure for one reason:
// this is the only part of the globe that a harness can execute without a
// browser. `node server/tests/live-view/globe-render.mjs` drives it with a
// recording fake 2D context and asserts what actually got drawn — that the far
// hemisphere is never painted, that nothing escapes the disc, that a marker
// appears per visible country, and that ripples expire.
//
// It is written as a HOT LOOP, not as a pure data transform: it issues ctx
// calls directly instead of building an intermediate scene graph, because at
// 60fps a per-frame array for each of ~3,100 land vertices would be 180k
// allocations a second. The pure maths it stands on (project) is proven
// separately in presentation.mjs.
import { project } from './livePresentation.js';

export const RIPPLE_MS = 2600;

// Palette pulled from the app's own tokens (client/src/index.css) so the globe
// cannot drift from the dark theme. Literals because a canvas cannot read
// Tailwind classes.
export const COLORS = {
  sphereTop: 'rgba(34, 197, 94, 0.10)',   // success, very dilute
  sphereBottom: 'rgba(9, 9, 11, 0.9)',    // bg-main
  limb: 'rgba(255, 255, 255, 0.14)',      // border-strong
  graticule: 'rgba(255, 255, 255, 0.045)',
  land: 'rgba(255, 255, 255, 0.055)',
  landStroke: 'rgba(255, 255, 255, 0.13)',
  marker: '#22c55e',                      // success
  markerCore: '#eafff1',
  ripple: '#e8d5a3',                      // accent-text
};

/**
 * Trace a lat/lon polyline, lifting the pen wherever it crosses the limb.
 *
 * Returns true if anything was traced. Without the pen-lift the far side of
 * the sphere is drawn straight across the front of the disc and the globe
 * looks like a ball of wool.
 */
function tracePath(ctx, pts, opts, { closed = false } = {}) {
  let pen = false;
  let drew = false;
  for (let i = 0; i < pts.length; i += 2) {
    const p = project(pts[i + 1], pts[i], opts);
    if (!p.visible) { pen = false; continue; }
    if (pen) ctx.lineTo(p.x, p.y);
    else { ctx.moveTo(p.x, p.y); pen = true; }
    drew = true;
  }
  if (drew && closed) ctx.closePath();
  return drew;
}

/**
 * Paint one frame.
 *
 * @param ctx   a CanvasRenderingContext2D (or anything with the same surface)
 * @param scene { points, ripples, max } — points are {lat, lon, visitors},
 *              ripples are {lat, lon, at} and are MUTATED in place as they
 *              expire (the array is owned by the caller's scene ref)
 * @param opts  { size, dpr, rotation, tilt, now, landRings }
 * @returns     counts, for the harness and for nothing else
 */
export function drawGlobe(ctx, scene, opts) {
  const { size, dpr = 1, rotation = 0, tilt = 0, now = 0, landRings = [] } = opts;
  const r = (size / 2) * 0.86;
  const cx = size / 2;
  const cy = size / 2;
  const P = { rotation, tilt, radius: r, cx, cy };

  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  ctx.clearRect(0, 0, size, size);

  // ── the sphere
  const grad = ctx.createLinearGradient(cx, cy - r, cx, cy + r);
  grad.addColorStop(0, COLORS.sphereTop);
  grad.addColorStop(1, COLORS.sphereBottom);
  ctx.beginPath();
  ctx.arc(cx, cy, r, 0, Math.PI * 2);
  ctx.fillStyle = grad;
  ctx.fill();

  // ── graticule every 30 degrees, front hemisphere only
  ctx.strokeStyle = COLORS.graticule;
  ctx.lineWidth = 1;
  for (let lat = -60; lat <= 60; lat += 30) {
    ctx.beginPath();
    let pen = false;
    for (let lon = -180; lon <= 180; lon += 4) {
      const p = project(lat, lon, P);
      if (!p.visible) { pen = false; continue; }
      if (pen) ctx.lineTo(p.x, p.y); else { ctx.moveTo(p.x, p.y); pen = true; }
    }
    ctx.stroke();
  }
  for (let lon = -180; lon < 180; lon += 30) {
    ctx.beginPath();
    let pen = false;
    for (let lat = -90; lat <= 90; lat += 4) {
      const p = project(lat, lon, P);
      if (!p.visible) { pen = false; continue; }
      if (pen) ctx.lineTo(p.x, p.y); else { ctx.moveTo(p.x, p.y); pen = true; }
    }
    ctx.stroke();
  }

  // ── land
  let landDrawn = 0;
  ctx.fillStyle = COLORS.land;
  ctx.strokeStyle = COLORS.landStroke;
  ctx.lineWidth = 0.7;
  for (const ring of landRings) {
    ctx.beginPath();
    if (!tracePath(ctx, ring, P)) continue; // wholly on the far side
    landDrawn++;
    ctx.fill();
    ctx.stroke();
  }

  // ── limb
  ctx.beginPath();
  ctx.arc(cx, cy, r, 0, Math.PI * 2);
  ctx.strokeStyle = COLORS.limb;
  ctx.lineWidth = 1;
  ctx.stroke();

  // ── arrival ripples, under the markers
  let ripplesDrawn = 0;
  const ripples = scene.ripples || [];
  for (let i = ripples.length - 1; i >= 0; i--) {
    const age = now - ripples[i].at;
    // Reverse iteration is load-bearing: splicing while walking forwards skips
    // the element after every removal.
    if (age > RIPPLE_MS) { ripples.splice(i, 1); continue; }
    const p = project(ripples[i].lat, ripples[i].lon, P);
    if (!p.visible) continue;
    const t = age / RIPPLE_MS;
    ctx.beginPath();
    ctx.arc(p.x, p.y, 3 + t * 22, 0, Math.PI * 2);
    ctx.strokeStyle = COLORS.ripple;
    ctx.globalAlpha = (1 - t) * 0.55 * p.z; // fade toward the limb
    ctx.lineWidth = 1.5;
    ctx.stroke();
    ctx.globalAlpha = 1;
    ripplesDrawn++;
  }

  // ── country markers. Area is proportional to visitors, so the RADIUS goes
  // as the square root — scaling the radius by the count would make a
  // 40-visitor country look sixteen times a 10-visitor one.
  let markersDrawn = 0;
  const max = Math.max(1, scene.max || 1);
  ctx.globalCompositeOperation = 'lighter';
  for (const pt of scene.points || []) {
    const p = project(pt.lat, pt.lon, P);
    if (!p.visible) continue;
    const share = Math.sqrt(Math.max(0, pt.visitors) / max);
    const rad = 2 + share * 6;
    const depth = 0.35 + 0.65 * p.z; // dim toward the limb, for roundness

    const halo = ctx.createRadialGradient(p.x, p.y, 0, p.x, p.y, rad * 3.4);
    halo.addColorStop(0, COLORS.marker);
    halo.addColorStop(1, 'rgba(34, 197, 94, 0)');
    ctx.globalAlpha = 0.42 * depth;
    ctx.beginPath();
    ctx.arc(p.x, p.y, rad * 3.4, 0, Math.PI * 2);
    ctx.fillStyle = halo;
    ctx.fill();

    ctx.globalAlpha = 0.95 * depth;
    ctx.beginPath();
    ctx.arc(p.x, p.y, rad, 0, Math.PI * 2);
    ctx.fillStyle = COLORS.markerCore;
    ctx.fill();
    markersDrawn++;
  }
  ctx.globalAlpha = 1;
  ctx.globalCompositeOperation = 'source-over';

  return { landDrawn, markersDrawn, ripplesDrawn, radius: r, cx, cy };
}

export default drawGlobe;
