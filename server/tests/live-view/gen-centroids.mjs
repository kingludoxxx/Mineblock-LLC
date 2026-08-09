// One-shot GENERATOR for client/src/pages/live/countryCentroids.js
//
// Source: Natural Earth 110m country polygons (TopoJSON), read from the
// funnel-os reference checkout. The output table is COMMITTED — this script
// exists so the numbers are reproducible, not so they are fetched at runtime.
//
//   node gen-centroids.mjs > countryCentroids.js
//
// Method:
//   1. The valid ISO 3166-1 alpha-2 set is DERIVED, not typed: every AA..ZZ
//      pair that Intl.DisplayNames(type:'region', fallback:'none') resolves.
//   2. TopoJSON arcs are decoded (delta + quantized) into lon/lat rings.
//   3. Each country's representative point is the area-weighted centroid of
//      its LARGEST ring (not of all rings — that puts the US in the Pacific
//      because of Alaska/Hawaii, and Russia off the map at the antimeridian).
//   4. Natural Earth's `name` is matched to the alpha-2 code via the CLDR
//      English name, with an explicit alias table for NE's abbreviations.
import fs from 'node:fs';

const SRC = '/Users/ludo/funnel-os/frontend/src/components/listiclebuilders/liveview/world110m.json';

// ── 1. the real alpha-2 set, derived ────────────────────────────────────────
// CLDR still names WITHDRAWN alpha-2 codes, and it names several of them
// IDENTICALLY to their successor ("DD" and "DE" are both "Germany", "VD" and
// "VN" are both "Vietnam"). A first-wins name→code map therefore silently
// awards Germany to East Germany. Every such collision was enumerated
// (15 names, 16 legacy codes) and the legacy side is excluded here.
const LEGACY = new Set([
  'AN', 'BU', 'CS', 'DD', 'DY', 'FX', 'HV', 'NH',
  'RH', 'SU', 'TP', 'UK', 'VD', 'YD', 'YU', 'ZR',
]);

const dn = new Intl.DisplayNames(['en'], { type: 'region', fallback: 'none' });
const A = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ';
const codeToName = new Map();
for (const a of A) for (const b of A) {
  const cc = a + b;
  if (LEGACY.has(cc)) continue;
  let nm;
  try { nm = dn.of(cc); } catch { nm = undefined; }
  if (nm && nm !== cc) codeToName.set(cc, nm);
}

const norm = (s) => String(s)
  .normalize('NFD').replace(/\p{M}/gu, '')
  .toLowerCase()
  .replace(/&/g, 'and')
  .replace(/[^a-z ]/g, '')
  .replace(/\s+/g, ' ')
  .trim();

const nameToCode = new Map();
for (const [cc, nm] of codeToName) {
  const k = norm(nm);
  if (!nameToCode.has(k)) nameToCode.set(k, cc);
}

// Natural Earth writes abbreviated / historical names. Explicit, auditable.
const ALIAS = {
  'w sahara': 'EH',
  'dem rep congo': 'CD',
  'congo': 'CG',
  'dominican rep': 'DO',
  'falkland is': 'FK',
  'fr s antarctic lands': 'TF',
  'central african rep': 'CF',
  'eq guinea': 'GQ',
  'bosnia and herz': 'BA',
  'n cyprus': 'CY',
  'somaliland': 'SO',
  's sudan': 'SS',
  'united states of america': 'US',
  'russia': 'RU',
  'south korea': 'KR',
  'north korea': 'KP',
  'dem rep korea': 'KP',
  'korea': 'KR',
  'lao pdr': 'LA',
  'solomon is': 'SB',
  'czechia': 'CZ',
  'czech rep': 'CZ',
  'macedonia': 'MK',
  'brunei': 'BN',
  'swaziland': 'SZ',
  'eswatini': 'SZ',
  'burma': 'MM',
  'myanmar': 'MM',
  'cote divoire': 'CI',
  'ivory coast': 'CI',
  'cabo verde': 'CV',
  'timor leste': 'TL',
  'palestine': 'PS',
  'vatican': 'VA',
  'kosovo': 'XK',
  'turkiye': 'TR',
  'turkey': 'TR',
  'antarctica': 'AQ',
  'trinidad and tobago': 'TT',
  'united kingdom': 'GB',
  'st vin and gren': 'VC',
  'ndjamena': 'TD',
};

// ── 2. decode the topology ──────────────────────────────────────────────────
const topo = JSON.parse(fs.readFileSync(SRC, 'utf8'));
const { scale: [sx, sy], translate: [tx, ty] } = topo.transform;

const arcs = topo.arcs.map((arc) => {
  let x = 0, y = 0;
  return arc.map(([dx, dy]) => {
    x += dx; y += dy;
    return [x * sx + tx, y * sy + ty];
  });
});

function ring(indices) {
  const pts = [];
  for (const i of indices) {
    const seg = i < 0 ? arcs[~i].slice().reverse() : arcs[i];
    // consecutive arcs share an endpoint — drop the duplicate
    for (let k = pts.length ? 1 : 0; k < seg.length; k++) pts.push(seg[k]);
  }
  return pts;
}

// ANTIMERIDIAN: a ring that crosses ±180 is stored with longitudes that jump
// +179 → -179. Fed to a planar shoelace that produces nonsense (Russia came
// out at lon 202.8, Fiji at 11.6 — the Gulf of Guinea). Unwrap the ring into a
// continuous longitude run first, then wrap the resulting centroid back.
function unwrap(pts) {
  const out = [pts[0]];
  let shift = 0;
  for (let i = 1; i < pts.length; i++) {
    const d = pts[i][0] - pts[i - 1][0];
    if (d > 180) shift -= 360;
    else if (d < -180) shift += 360;
    out.push([pts[i][0] + shift, pts[i][1]]);
  }
  return out;
}

const wrapLon = (x) => ((((x + 180) % 360) + 360) % 360) - 180;

// Planar (lon/lat) shoelace. Adequate for "where do I put the dot" — the
// globe reprojects it anyway.
function ringCentroid(raw) {
  const pts = unwrap(raw);
  let a = 0, cx = 0, cy = 0;
  for (let i = 0, n = pts.length; i < n; i++) {
    const [x0, y0] = pts[i];
    const [x1, y1] = pts[(i + 1) % n];
    const f = x0 * y1 - x1 * y0;
    a += f; cx += (x0 + x1) * f; cy += (y0 + y1) * f;
  }
  if (Math.abs(a) < 1e-12) {
    // degenerate ring — fall back to the vertex mean
    const m = pts.reduce((p, q) => [p[0] + q[0], p[1] + q[1]], [0, 0]);
    return { lon: wrapLon(m[0] / pts.length), lat: m[1] / pts.length, area: 0 };
  }
  a *= 0.5;
  return { lon: wrapLon(cx / (6 * a)), lat: cy / (6 * a), area: Math.abs(a) };
}

const out = new Map();
const unmatched = [];
for (const g of topo.objects.countries.geometries) {
  const neName = g.properties?.name || '';
  const key = norm(neName);
  const cc = ALIAS[key] || nameToCode.get(key) || null;
  if (!cc) { unmatched.push(neName); continue; }

  const polys = g.type === 'Polygon' ? [g.arcs] : g.arcs;
  let best = null;
  for (const poly of polys) {
    const c = ringCentroid(ring(poly[0])); // [0] = outer ring
    if (!best || c.area > best.area) best = c;
  }
  if (!best) { unmatched.push(neName + ' (no ring)'); continue; }
  // Keep the LARGEST landmass if a code somehow appears twice.
  const prev = out.get(cc);
  if (!prev || best.area > prev.area) out.set(cc, { ...best, neName });
}

// ── 3. supplement: territories Natural Earth 110m drops entirely ────────────
// Small states with real e-commerce traffic. Hand-entered, flagged as such,
// rounded to 1dp — a country pulse is a ~40px dot, 1dp is ~11km.
const SUPPLEMENT = {
  SG: [1.35, 103.8], HK: [22.3, 114.2], MO: [22.2, 113.5], MT: [35.9, 14.4],
  LU: [49.8, 6.1], BH: [26.1, 50.5], MU: [-20.3, 57.6], MV: [3.2, 73.2],
  AD: [42.5, 1.5], MC: [43.7, 7.4], LI: [47.2, 9.5], SM: [43.9, 12.5],
  VA: [41.9, 12.5], BB: [13.2, -59.5], GD: [12.1, -61.7], AG: [17.1, -61.8],
  KN: [17.3, -62.7], LC: [13.9, -61.0], VC: [13.2, -61.2], DM: [15.4, -61.4],
  SC: [-4.7, 55.5], KM: [-11.6, 43.3], ST: [0.3, 6.6], CV: [16.0, -24.0],
  BM: [32.3, -64.8], KY: [19.3, -81.2], VG: [18.4, -64.6], AI: [18.2, -63.1],
  AW: [12.5, -70.0], CW: [12.2, -69.0], SX: [18.0, -63.1], TC: [21.7, -71.8],
  GI: [36.1, -5.4], JE: [49.2, -2.1], GG: [49.5, -2.6], IM: [54.2, -4.5],
  FO: [62.0, -6.8], AX: [60.2, 20.0], GU: [13.4, 144.8], MP: [15.2, 145.7],
  AS: [-14.3, -170.7], VI: [18.3, -64.9], PR: [18.2, -66.4], TO: [-21.2, -175.2],
  WS: [-13.8, -172.1], KI: [1.4, 173.0], TV: [-8.5, 179.2], NR: [-0.5, 166.9],
  PW: [7.5, 134.6], MH: [7.1, 171.4], FM: [6.9, 158.2], CK: [-21.2, -159.8],
  NU: [-19.1, -169.9], PF: [-17.7, -149.4], NC: [-21.3, 165.5], WF: [-13.3, -176.2],
  YT: [-12.8, 45.2], RE: [-21.1, 55.5], MQ: [14.6, -61.0], GP: [16.2, -61.6],
  BL: [17.9, -62.8], MF: [18.1, -63.1], PM: [46.9, -56.3], GF: [4.0, -53.0],
  SH: [-15.9, -5.7], IO: [-7.3, 72.4], CX: [-10.5, 105.6], CC: [-12.2, 96.9],
  NF: [-29.0, 168.0], TK: [-9.2, -171.8], PN: [-24.4, -128.3], GS: [-54.4, -36.5],
  BV: [-54.4, 3.4], HM: [-53.1, 73.5], UM: [19.3, 166.6], AQ: [-82.0, 0.0],
  EH: [24.5, -13.0], PS: [31.9, 35.2], BQ: [12.2, -68.3], TF: [-49.3, 69.2],
};

const rows = [];
for (const [cc, v] of [...out].sort((a, b) => a[0].localeCompare(b[0]))) {
  rows.push([cc, Math.round(v.lat * 10) / 10, Math.round(v.lon * 10) / 10, 'ne']);
}
const have = new Set(rows.map((r) => r[0]));
for (const [cc, [lat, lon]] of Object.entries(SUPPLEMENT)) {
  if (have.has(cc)) continue;
  rows.push([cc, lat, lon, 'manual']);
}
rows.sort((a, b) => a[0].localeCompare(b[0]));

const neCount = rows.filter((r) => r[3] === 'ne').length;
const manCount = rows.filter((r) => r[3] === 'manual').length;

const body = rows
  .map(([cc, lat, lon]) => `  ${cc}: [${lat}, ${lon}],`)
  .join('\n');

process.stdout.write(`// Country → representative point (lat, lon). GENERATED — do not hand-edit.
//
// ${neCount} entries derived from Natural Earth 110m country polygons (the
// area-weighted centroid of each country's LARGEST ring, so the US lands in
// Kansas and not in the Pacific between Alaska and Hawaii), plus ${manCount}
// small states/territories Natural Earth 110m omits entirely, hand-entered at
// 1dp (~11 km — a country pulse is a ~40 px dot, so 1dp is well inside the
// mark). Regenerate with server/tests/live-view/gen-centroids.mjs.
//
// A country code with NO entry here is NOT plotted and NOT silently dropped —
// LiveGlobe surfaces the off-map count. Inventing a coordinate for an unknown
// code would be exactly the fabrication the Live View geo card refuses.
export const COUNTRY_CENTROIDS = Object.freeze({
${body}
});

export default COUNTRY_CENTROIDS;
`);

process.stderr.write(`ne=${neCount} manual=${manCount} total=${rows.length}\nunmatched NE names (${unmatched.length}): ${JSON.stringify(unmatched)}\n`);
