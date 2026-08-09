// One-shot GENERATOR for client/src/pages/live/worldLand.js
//
// Source: Natural Earth 110m country polygons (TopoJSON), read from the
// funnel-os reference checkout. Emits DECIMATED lon/lat rings so the globe can
// draw land + country borders with no runtime fetch, no CDN texture and no
// topojson dependency. The output is COMMITTED; this script only makes it
// reproducible.
//
// Decimation: Douglas–Peucker at EPS degrees, then 1dp rounding. At the
// globe's on-screen size (~220 px radius ⇒ ~0.4°/px) a 0.5° tolerance is
// sub-pixel-to-one-pixel — a coastline, not a survey.
import fs from 'node:fs';

const SRC = '/Users/ludo/funnel-os/frontend/src/components/listiclebuilders/liveview/world110m.json';
const EPS = 0.5;        // Douglas–Peucker tolerance, degrees
const MIN_AREA = 1.5;   // deg² — drops specks that render as a single pixel
const MIN_PTS = 4;

const topo = JSON.parse(fs.readFileSync(SRC, 'utf8'));
const { scale: [sx, sy], translate: [tx, ty] } = topo.transform;

const arcs = topo.arcs.map((arc) => {
  let x = 0, y = 0;
  return arc.map(([dx, dy]) => { x += dx; y += dy; return [x * sx + tx, y * sy + ty]; });
});

function ring(indices) {
  const pts = [];
  for (const i of indices) {
    const seg = i < 0 ? arcs[~i].slice().reverse() : arcs[i];
    for (let k = pts.length ? 1 : 0; k < seg.length; k++) pts.push(seg[k]);
  }
  return pts;
}

function area(pts) {
  let a = 0;
  for (let i = 0, n = pts.length; i < n; i++) {
    const [x0, y0] = pts[i], [x1, y1] = pts[(i + 1) % n];
    a += x0 * y1 - x1 * y0;
  }
  return Math.abs(a) / 2;
}

function perpDist(p, a, b) {
  const dx = b[0] - a[0], dy = b[1] - a[1];
  const d2 = dx * dx + dy * dy;
  if (d2 === 0) return Math.hypot(p[0] - a[0], p[1] - a[1]);
  const t = ((p[0] - a[0]) * dx + (p[1] - a[1]) * dy) / d2;
  const cl = Math.max(0, Math.min(1, t));
  return Math.hypot(p[0] - (a[0] + cl * dx), p[1] - (a[1] + cl * dy));
}

function dp(pts, eps) {
  if (pts.length < 3) return pts;
  let maxD = -1, idx = 0;
  for (let i = 1; i < pts.length - 1; i++) {
    const d = perpDist(pts[i], pts[0], pts[pts.length - 1]);
    if (d > maxD) { maxD = d; idx = i; }
  }
  if (maxD <= eps) return [pts[0], pts[pts.length - 1]];
  const l = dp(pts.slice(0, idx + 1), eps);
  const r = dp(pts.slice(idx), eps);
  return l.slice(0, -1).concat(r);
}

const rings = [];
let dropped = 0, rawPts = 0, keptPts = 0;
for (const g of topo.objects.countries.geometries) {
  const polys = g.type === 'Polygon' ? [g.arcs] : g.arcs;
  for (const poly of polys) {
    // Outer ring only — 110m holes are lakes, invisible at this scale.
    const raw = ring(poly[0]);
    rawPts += raw.length;
    if (area(raw) < MIN_AREA) { dropped++; continue; }
    let simp = dp(raw, EPS).map(([x, y]) => [Math.round(x * 10) / 10, Math.round(y * 10) / 10]);
    // collapse duplicates created by rounding
    simp = simp.filter((p, i) => i === 0 || p[0] !== simp[i - 1][0] || p[1] !== simp[i - 1][1]);
    if (simp.length < MIN_PTS) { dropped++; continue; }
    keptPts += simp.length;
    rings.push(simp);
  }
}

const body = rings
  .map((r) => '  [' + r.map(([x, y]) => `${x},${y}`).join(', ') + '],')
  .join('\n');

process.stdout.write(`// World land outlines for the Live View globe. GENERATED — do not hand-edit.
//
// ${rings.length} rings / ${keptPts} points, decimated from Natural Earth 110m country
// polygons (Douglas-Peucker at ${EPS}deg, then 1dp rounding, rings under ${MIN_AREA} deg^2
// dropped). Each ring is a flat [lon, lat, lon, lat, ...] pair list in degrees.
//
// This is bundled ON PURPOSE: the Live View globe must not fetch a CDN
// texture or a remote TopoJSON at runtime. Regenerate with
// server/tests/live-view/gen-land.mjs.
export const LAND_RINGS = Object.freeze([
${body}
].map(Object.freeze));

export default LAND_RINGS;
`);

process.stderr.write(`rings=${rings.length} droppedRings=${dropped} rawPts=${rawPts} keptPts=${keptPts}\n`);
