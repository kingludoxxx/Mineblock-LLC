// THEME SYSTEM — token schema, the seeded preset library, the apply macro and
// the import-from-URL extractor.
//
// Port of funnel-os `backend/app/services/listicle_themes_service.py`
// (Phase Z.89 "Listicle Builders Theme Engine") + the /themes* endpoints in
// `backend/app/routers/listicle_builders.py`.
//
// ─────────────────────────────────────────────────────────────────────────────
// THE CENTRAL CLAIM, AND WHY IT IS TRUE
// ─────────────────────────────────────────────────────────────────────────────
// A theme is a MACRO OVER EXISTING SETTINGS. Applying one writes only keys the
// funnel settings blob already carries and funnelRender.js already reads, so
// the renderer needs zero changes and themes add no new emission path.
//
// VERIFIED BY READING funnelRender.js § funnelSettingsHead (line ~2848) — the
// COMPLETE set of settings keys that reach a visitor page is:
//
//   settings.brand_colors.primary    → :root{--brand-primary}   (hex-validated)
//   settings.brand_colors.secondary  → :root{--brand-secondary} (hex-validated)
//   settings.fonts.family            → font-family on body/main/input/select/
//                                      textarea/button + the Google Fonts <link>
//                                      (an ALLOWLIST KEY, never a CSS string)
//   settings.custom_head_code        → verbatim (operator escape hatch)
//   settings.checkout.*              → checkout enhancements (not design)
//
// That is the whole surface. The reference's token bag is 11 keys wide; ours
// is 3 keys wide. THE APPLY IS AN INTERSECTION, and the difference is
// published to the operator rather than hidden — see TOKEN_SUPPORT.
//
// ─────────────────────────────────────────────────────────────────────────────
// THE HONESTY THAT MATTERS MOST: 'published' IS NOT 'styled'
// ─────────────────────────────────────────────────────────────────────────────
// --brand-primary / --brand-secondary are EMITTED by the renderer but consumed
// by NOTHING in the shipped block library or the 8 page templates (grep for
// `var(--brand` across server/ and client/: zero hits). They are variables
// published FOR page CSS to reference. So applying a theme's colors is a real,
// persisted, rendered change to the document — and it repaints a page only
// where that page's own CSS reads the variable.
//
// A UI that says "applies your brand colors" without that caveat is selling a
// visual change the operator will not see. TOKEN_SUPPORT marks these tokens
// 'variable' rather than 'applied' precisely so the Themes section can say the
// true thing. Do not "simplify" that distinction away.
import { FUNNEL_FONTS } from './funnelRender.js';

// Single-tenant install (see funnelThemesSchema.js). One constant, every query
// already scoped, so real tenancy is later a value change and not a migration.
export const DEFAULT_WORKSPACE = 'default';

// ── TOKEN SCHEMA ────────────────────────────────────────────────────────────
// Ported 1:1 from the reference's token bag (listicle_themes_service.py:15-37
// and the .get() fallbacks in theme_to_css :179-219, which are the only place
// its defaults are actually written down). 11 keys, ALL STRINGS — `radius` is
// a CSS length string, not a number.
export const TOKEN_KEYS = [
  'primary', 'secondary', 'background', 'foreground', 'muted', 'border',
  'radius', 'font_heading', 'font_body', 'cta_bg', 'cta_fg',
];

export const TOKEN_DEFAULTS = Object.freeze({
  primary: '#7c3aed',
  secondary: '#06b6d4',
  background: '#0a0a0a',
  foreground: '#fafafa',
  muted: '#1f2937',
  border: '#27272a',
  radius: '12px',
  font_heading: 'system-ui',
  font_body: 'system-ui',
  cta_bg: '#7c3aed',
  cta_fg: '#ffffff',
});

// ── TOKEN SUPPORT — the intersection, stated once, for the UI to render ─────
// `support` is one of:
//   'variable' — written to settings, emitted by the renderer as a CSS
//                variable, and visible only where page CSS references it.
//   'partial'  — written, but through a narrower channel than the reference's
//                (our font surface is ONE allowlisted key for the whole page,
//                so heading and body fonts cannot differ).
//   'none'     — STORED ON THE THEME, NEVER APPLIED. The renderer has no sink.
//
// `note` is operator-facing copy. It is shown verbatim in the Themes section,
// so it must remain literally true about what funnelRender.js does.
export const TOKEN_SUPPORT = Object.freeze({
  primary: {
    support: 'variable',
    settings_path: 'brand_colors.primary',
    note: 'Published as the --brand-primary CSS variable. Repaints a page only where that page’s CSS reads var(--brand-primary).',
  },
  secondary: {
    support: 'variable',
    settings_path: 'brand_colors.secondary',
    note: 'Published as the --brand-secondary CSS variable. Repaints a page only where that page’s CSS reads var(--brand-secondary).',
  },
  font_body: {
    support: 'partial',
    settings_path: 'fonts.family',
    note: 'Sets the page font when the family is on the visitor-page allowlist. One font governs the whole page — headings inherit it.',
  },
  font_heading: {
    support: 'none',
    settings_path: null,
    note: 'Not applied. The renderer emits a single page font (taken from the body font); it has no separate heading family.',
  },
  background: { support: 'none', settings_path: null, note: 'Not applied. The renderer emits no page background variable.' },
  foreground: { support: 'none', settings_path: null, note: 'Not applied. The renderer emits no text-color variable.' },
  muted: { support: 'none', settings_path: null, note: 'Not applied. The renderer emits no muted-surface variable.' },
  border: { support: 'none', settings_path: null, note: 'Not applied. The renderer emits no border-color variable.' },
  radius: { support: 'none', settings_path: null, note: 'Not applied. The renderer emits no radius variable.' },
  cta_bg: { support: 'none', settings_path: null, note: 'Not applied. Button styling is per-block, not funnel-level.' },
  cta_fg: { support: 'none', settings_path: null, note: 'Not applied. Button styling is per-block, not funnel-level.' },
});

// ── SEEDED PRESET LIBRARY — 7, ported verbatim ──────────────────────────────
// listicle_themes_service.py:66-158. Values are copied LITERALLY, including
// the reference's inconsistent hex casing and the deliberate house-style
// quirk: cta_bg is pinned to Slash green (#5FAE5F) on 5 of the 7 presets, and
// on 4 of those it deliberately DISAGREES with `primary` (editorial, health,
// editorial-dark, conversion-dr). That is not a bug to tidy — it is the
// reference's brand decision, and normalizing cta_bg to primary would silently
// redesign those four.
//
// Presets are CONSTANTS, never rows (see funnelThemesSchema.js). is_preset and
// the read-only stamp are applied at read time by listPresets().
export const PRESETS = Object.freeze([
  {
    id: 'thm_preset_brand',
    preset_slug: 'brand',
    name: 'Brand (Slash Green)',
    description: 'House style — Slash green on warm cream. The default for new sites.',
    tokens: {
      primary: '#5FAE5F',
      secondary: '#7EB6A8',
      background: '#FBF8F2',
      foreground: '#1F1D1A',
      muted: '#F3EFE7',
      border: '#E4DED2',
      radius: '12px',
      font_heading: "'Inter Tight', 'Inter', system-ui, sans-serif",
      font_body: "'Inter', system-ui, sans-serif",
      cta_bg: '#5FAE5F',
      cta_fg: '#FFFFFF',
    },
  },
  {
    id: 'thm_preset_editorial',
    preset_slug: 'editorial',
    name: 'Editorial Light',
    description: 'Serif headlines, ample whitespace. Best for healthcare + lifestyle listicles.',
    tokens: {
      primary: '#111827',
      secondary: '#C97F7F',
      background: '#fdfaf6',
      foreground: '#1f2937',
      muted: '#f3f4f6',
      border: '#e5e7eb',
      radius: '4px',
      font_heading: "'Source Serif Pro', Georgia, serif",
      font_body: "'Source Sans Pro', system-ui, sans-serif",
      cta_bg: '#5FAE5F',
      cta_fg: '#ffffff',
    },
  },
  {
    id: 'thm_preset_minimal',
    preset_slug: 'minimal',
    name: 'Minimal',
    description: 'Mono accents, large type. Premium feel for SaaS + B2B.',
    tokens: {
      primary: '#000000',
      secondary: '#525252',
      background: '#ffffff',
      foreground: '#0a0a0a',
      muted: '#fafafa',
      border: '#e5e5e5',
      radius: '2px',
      font_heading: "'Inter Tight', system-ui, sans-serif",
      font_body: "'Inter', system-ui, sans-serif",
      cta_bg: '#000000',
      cta_fg: '#ffffff',
    },
  },
  {
    id: 'thm_preset_health',
    preset_slug: 'health',
    name: 'Health',
    description: 'Calming teal + sage. Best for supplements, wellness, healthcare.',
    tokens: {
      primary: '#7EB6A8',
      secondary: '#5FAE5F',
      background: '#f8fafa',
      foreground: '#0f172a',
      muted: '#ecfdf5',
      border: '#d1fae5',
      radius: '20px',
      font_heading: "'Plus Jakarta Sans', system-ui, sans-serif",
      font_body: "'Inter', system-ui, sans-serif",
      cta_bg: '#5FAE5F',
      cta_fg: '#ffffff',
    },
  },
  {
    id: 'thm_preset_tech',
    preset_slug: 'tech',
    name: 'Tech',
    description: 'Cool dark canvas, geometric. Best for SaaS reviews + tech listicles.',
    tokens: {
      primary: '#7BC279',
      secondary: '#7EB6A8',
      background: '#0b1220',
      foreground: '#f1f5f9',
      muted: '#1e293b',
      border: '#334155',
      radius: '8px',
      font_heading: "'JetBrains Mono', monospace",
      font_body: "'Inter', system-ui, sans-serif",
      cta_bg: '#7BC279',
      cta_fg: '#0b1220',
    },
  },
  {
    id: 'thm_preset_editorial_dark',
    preset_slug: 'editorial-dark',
    name: 'Editorial Dark',
    description: 'Dark serif, magazine vibe. Best for opinion + reviews + premium content.',
    tokens: {
      primary: '#fafafa',
      secondary: '#C97F7F',
      background: '#0c0a09',
      foreground: '#fafaf9',
      muted: '#1c1917',
      border: '#292524',
      radius: '4px',
      font_heading: "'Source Serif Pro', Georgia, serif",
      font_body: "'Source Sans Pro', system-ui, sans-serif",
      cta_bg: '#5FAE5F',
      cta_fg: '#ffffff',
    },
  },
  {
    id: 'thm_preset_conversion',
    preset_slug: 'conversion-dr',
    name: 'Conversion DR',
    description: 'High-contrast gold + black. Maximum-aggression direct-response. Trust-busting.',
    tokens: {
      primary: '#D4B05F',
      secondary: '#C97F7F',
      background: '#ffffff',
      foreground: '#0a0a0a',
      muted: '#FAF5E7',
      border: '#EAD893',
      radius: '0px',
      font_heading: "'Impact', 'Arial Black', sans-serif",
      font_body: "'Arial', sans-serif",
      cta_bg: '#5FAE5F',
      cta_fg: '#ffffff',
    },
  },
]);

// Read-only stamp, mirroring the reference's list_presets().
export function listPresets() {
  return PRESETS.map((p) => ({ ...p, tokens: { ...p.tokens }, is_preset: true }));
}

export function getPreset(slug) {
  const p = PRESETS.find((x) => x.preset_slug === slug);
  return p ? { ...p, tokens: { ...p.tokens }, is_preset: true } : null;
}

// ── validation ──────────────────────────────────────────────────────────────

export class ThemeError extends Error {
  constructor(code) { super(code); this.code = code; }
}

const isPlainObject = (v) => v != null && typeof v === 'object' && !Array.isArray(v);

// MIRRORS funnelRender.js § isHexColor EXACTLY (#rgb / #rrggbb / #rrggbbaa).
// That function is not exported, so this is a deliberate duplicate rather than
// an import. It must not drift: a token the theme layer accepts but the
// renderer rejects becomes a settings write that silently emits nothing —
// exactly the "claimed but not applied" failure this lane exists to prevent.
// The themes harness asserts the two agree over a shared corpus.
export function isHexColor(v) {
  return typeof v === 'string' && /^#(?:[0-9a-fA-F]{3}|[0-9a-fA-F]{6}|[0-9a-fA-F]{8})$/.test(v);
}

const TOKEN_MAX = 200;          // a token value is a color or a font stack
const NAME_MAX = 80;            // reference: name.strip()[:80]
const TOKENS_BYTES_MAX = 8_192; // a token bag is ~400 bytes; this is a wall, not a budget

// Accept only known token keys with string values. Unknown keys are DROPPED,
// not rejected: a draft round-tripped from import carries palette_full /
// fonts_full, and a 422 on those would make the natural import→save flow fail.
export function sanitizeTokens(tokens) {
  if (!isPlainObject(tokens)) throw new ThemeError('tokens_must_be_object');
  const out = {};
  for (const key of TOKEN_KEYS) {
    const raw = tokens[key];
    if (raw === undefined || raw === null || raw === '') continue;
    if (typeof raw !== 'string') throw new ThemeError(`token_not_string:${key}`);
    const v = raw.trim();
    if (!v) continue;
    if (v.length > TOKEN_MAX) throw new ThemeError(`token_too_long:${key}`);
    out[key] = v;
  }
  if (Buffer.byteLength(JSON.stringify(out), 'utf8') > TOKENS_BYTES_MAX) {
    throw new ThemeError('tokens_too_large');
  }
  return out;
}

export function sanitizeName(name) {
  const v = typeof name === 'string' ? name.trim().slice(0, NAME_MAX) : '';
  return v || 'Untitled theme';
}

// A stored URL is display/provenance only — it is never re-fetched without
// going back through the SSRF guard, and never emitted into a page.
export function sanitizeUrl(url) {
  if (typeof url !== 'string') return '';
  const v = url.trim().slice(0, 500);
  if (!v) return '';
  try {
    const u = new URL(v);
    return (u.protocol === 'https:' || u.protocol === 'http:') ? v : '';
  } catch { return ''; }
}

// ── FONT RESOLUTION — a CSS stack down to one allowlist key ─────────────────
// The reference stores free CSS font stacks. Our renderer stores an ALLOWLIST
// KEY into FUNNEL_FONTS and emits only server-side constants, which is why a
// hostile settings.fonts.family can never reach the document. That property is
// worth more than font fidelity, so the port resolves rather than passes
// through: walk the stack left to right and take the FIRST family that is on
// the allowlist.
//
// NO FALLBACK TO THE HEADING FONT, DELIBERATELY. 'Source Sans Pro', system-ui
// resolves to nothing; falling back to Editorial Light's heading stack would
// apply Georgia to the entire page — a redesign the operator never asked for.
// An unresolvable font writes NOTHING and is reported as unsupported.
export function resolveFontKey(stack) {
  if (typeof stack !== 'string' || !stack.trim()) return null;
  const families = stack.split(',')
    .map((s) => s.trim().replace(/^['"]/, '').replace(/['"]$/, '').toLowerCase())
    .filter(Boolean);
  for (const fam of families) {
    const key = fam.replace(/\s+/g, '-');
    // 'default' is the renderer's "emit nothing" sentinel, not a family — a
    // stack can never legitimately name it, and matching it would turn a font
    // token into a silent no-op that still reported as applied.
    if (key !== 'default' && Object.prototype.hasOwnProperty.call(FUNNEL_FONTS, key)) return key;
  }
  return null;
}

// ── THE APPLY MACRO ─────────────────────────────────────────────────────────
// PURE. Given a token bag and the funnel's CURRENT settings, return the plan:
// which settings paths change, from what, to what, and which tokens are being
// dropped and why.
//
// The plan is DATA, not a write. The route hands it to the client, which
// applies it inside the existing serialized settings PATCH (enqueueSettingsSave
// → saveFunnelPatch), so a theme apply is serialized against every other
// settings save exactly like a General or Fonts save. There is deliberately no
// server-side write door: a second path into funnels.settings would be a second
// read-modify-write racing the first.
//
// `writes` carries dotted paths the client sets verbatim; the client never
// re-derives which token maps where, so this stays the single implementation.
export function buildApplyPlan(tokens, currentSettings) {
  const t = isPlainObject(tokens) ? tokens : {};
  const st = isPlainObject(currentSettings) ? currentSettings : {};
  const bc = isPlainObject(st.brand_colors) ? st.brand_colors : {};
  const fonts = isPlainObject(st.fonts) ? st.fonts : {};

  const writes = [];
  const skipped = [];

  // brand colors ------------------------------------------------------------
  for (const [token, key] of [['primary', 'primary'], ['secondary', 'secondary']]) {
    const value = t[token];
    if (value === undefined) continue;
    if (!isHexColor(value)) {
      // The renderer hex-validates again before emitting, so a bad value would
      // be stored and then silently ignored. Refuse it here instead.
      skipped.push({ token, value, reason: 'not_a_hex_color', note: `“${value}” is not a #rgb / #rrggbb / #rrggbbaa color, so the renderer would ignore it.` });
      continue;
    }
    const from = typeof bc[key] === 'string' ? bc[key] : '';
    writes.push({
      token,
      path: `brand_colors.${key}`,
      from,
      to: value,
      changed: from.toLowerCase() !== value.toLowerCase(),
      support: TOKEN_SUPPORT[token].support,
      note: TOKEN_SUPPORT[token].note,
    });
  }

  // page font ---------------------------------------------------------------
  if (t.font_body !== undefined) {
    const key = resolveFontKey(t.font_body);
    if (!key) {
      skipped.push({
        token: 'font_body',
        value: t.font_body,
        reason: 'font_not_on_allowlist',
        note: `No family in “${t.font_body}” is on the visitor-page font allowlist, so the page font is left unchanged.`,
      });
    } else {
      const from = typeof fonts.family === 'string' && fonts.family ? fonts.family : 'default';
      writes.push({
        token: 'font_body',
        path: 'fonts.family',
        from,
        to: key,
        changed: from !== key,
        support: TOKEN_SUPPORT.font_body.support,
        note: TOKEN_SUPPORT.font_body.note,
      });
    }
  }

  // everything the renderer has no sink for -----------------------------------
  for (const token of TOKEN_KEYS) {
    if (t[token] === undefined || t[token] === null || t[token] === '') continue;
    if (TOKEN_SUPPORT[token].support !== 'none') continue;
    skipped.push({
      token,
      value: t[token],
      reason: 'no_renderer_sink',
      note: TOKEN_SUPPORT[token].note,
    });
  }

  return {
    writes,
    skipped,
    // The confirm dialog's headline number: paths whose stored value actually
    // moves. A theme re-applied over itself changes nothing and must say so.
    changed_count: writes.filter((w) => w.changed).length,
    // Destructive-overwrite warning material: paths that already held a
    // DIFFERENT hand-tuned value. `from === ''` is a fill, not an overwrite.
    overwrites: writes
      .filter((w) => w.changed && w.from && w.from !== 'default')
      .map((w) => ({ path: w.path, from: w.from, to: w.to })),
  };
}

// Apply a plan's writes to a settings object, returning a NEW object.
// Used by the harness to prove the plan is a faithful description of the
// resulting settings; the client runs the identical dotted-set over the FRESH
// row it re-GETs inside saveFunnelPatch.
export function applyPlanToSettings(plan, settings) {
  const out = isPlainObject(settings) ? JSON.parse(JSON.stringify(settings)) : {};
  for (const w of (plan.writes || [])) {
    const [head, tail] = w.path.split('.');
    if (!tail) { out[head] = w.to; continue; }
    out[head] = isPlainObject(out[head]) ? { ...out[head] } : {};
    out[head][tail] = w.to;
  }
  return out;
}

// ── IMPORT FROM URL — extraction ────────────────────────────────────────────
// Ported from listicle_themes_service.py:225-322. The heuristics are copied
// faithfully, INCLUDING their quirks, because changing them changes which
// theme an operator gets from a given page:
//
//   • only #rgb and #rrggbb are counted (len 4 / 7) — #rgba and #rrggbbaa are
//     dropped rather than truncated;
//   • rgb()/rgba() are normalized to lowercase hex and MERGED OVER the hex
//     tally, so an rgb-derived count REPLACES a same-color hex count rather
//     than summing (`{**hex_hits, **rgb_hits}` in the reference; `{...a,...b}`
//     here is identical);
//   • #abc is expanded to #aabbcc only AFTER counting, so #fff and #ffffff are
//     tallied separately and can both survive into the palette;
//   • only the FIRST family of each font-family declaration is kept.
//
// What is NOT ported: the reference follows external stylesheets never, and
// neither do we — extraction sees the initial HTML document only.
//
// AND WHAT IS DELIBERATELY *NOT* copied: the reference's
// `font-family\s*:\s*([^;]+?);` regex. It has two defects this port fixes.
//   M2 (perf) — `([^;]+?);` on a 2MB paste with no semicolon is catastrophic
//     backtracking: it stalled the single-threaded process ~9s, and this
//     process also serves live checkout. extractFonts below is a LINEAR scan
//     with a per-declaration character cap, so a hostile body is O(n).
//   M3 (correctness) — requiring a trailing `;` means the reference finds NO
//     fonts in minified CSS (`h1{font-family:Inter}`) or inline style
//     attributes (`style="font-family:Inter"`) — i.e. the headline import
//     feature guts itself on real pages. The scan instead ends a declaration
//     at `;`, the rule boundary `}`, a tag boundary `<`, or the cap.
const HEX_RE = /#[0-9a-fA-F]{3,8}\b/g;
const RGB_RE = /rgba?\(\s*(\d{1,3})\s*,\s*(\d{1,3})\s*,\s*(\d{1,3})/gi;
const FONT_DECL_RE = /font-family\s*:/gi;
// A real font stack is short; this bounds each declaration read so no single
// match can walk the whole document.
const FONT_DECL_MAX = 200;

const clampByte = (n) => Math.max(0, Math.min(255, n));

export function isNearWhite(c) {
  if (typeof c !== 'string' || c.length < 7) return false;
  const r = parseInt(c.slice(1, 3), 16), g = parseInt(c.slice(3, 5), 16), b = parseInt(c.slice(5, 7), 16);
  if (!Number.isFinite(r) || !Number.isFinite(g) || !Number.isFinite(b)) return false;
  return r > 230 && g > 230 && b > 230;
}

export function isNearBlack(c) {
  if (typeof c !== 'string' || c.length < 7) return false;
  const r = parseInt(c.slice(1, 3), 16), g = parseInt(c.slice(3, 5), 16), b = parseInt(c.slice(5, 7), 16);
  if (!Number.isFinite(r) || !Number.isFinite(g) || !Number.isFinite(b)) return false;
  return r < 30 && g < 30 && b < 30;
}

function expand3Hex(c) {
  return c.length === 4 ? `#${c[1]}${c[1]}${c[2]}${c[2]}${c[3]}${c[3]}` : c;
}

// Returns [[color, count], …] sorted by count desc, ties in first-seen order
// (JS string-keyed object insertion order matches Python's dict order here).
export function extractPalette(html) {
  const s = typeof html === 'string' ? html : '';
  const hexHits = {};
  for (const m of s.matchAll(HEX_RE)) {
    const h = m[0].toLowerCase();
    if (h.length === 4 || h.length === 7) hexHits[h] = (hexHits[h] || 0) + 1;
  }
  const rgbHits = {};
  for (const m of s.matchAll(RGB_RE)) {
    const hex = '#' + [m[1], m[2], m[3]]
      .map((n) => clampByte(parseInt(n, 10)).toString(16).padStart(2, '0')).join('');
    rgbHits[hex] = (rgbHits[hex] || 0) + 1;
  }
  const merged = { ...hexHits, ...rgbHits };
  return Object.entries(merged)
    .sort((a, b) => b[1] - a[1])
    .map(([c, n]) => [expand3Hex(c), n]);
}

// Pull the first family name out of a raw declaration body. Handles a quoted
// first family ('Inter', …) and an unquoted one, and never lets trailing junk
// from a boundary-terminated read (Inter">text) contaminate the name.
function firstFamily(decl) {
  const first = String(decl).split(',')[0].trim();
  if (!first) return '';
  if (first[0] === "'" || first[0] === '"') {
    const q = first[0];
    const idx = first.indexOf(q, 1);
    return (idx > 0 ? first.slice(1, idx) : first.slice(1)).trim();
  }
  // Unquoted: cut at the first char that cannot be part of a family token.
  return first.replace(/["'>;}].*$/s, '').trim();
}

// LINEAR font extraction (see the FONT_DECL_RE note above). For each
// `font-family:` occurrence, read forward to the first boundary (`;` `}` `<`)
// or FONT_DECL_MAX chars — no backtracking, no trailing-`;` requirement.
export function extractFonts(html) {
  const s = typeof html === 'string' ? html : '';
  const hits = {};
  FONT_DECL_RE.lastIndex = 0;
  let m;
  while ((m = FONT_DECL_RE.exec(s)) !== null) {
    const start = m.index + m[0].length;
    let end = start;
    const limit = Math.min(s.length, start + FONT_DECL_MAX);
    while (end < limit) {
      const ch = s.charCodeAt(end);
      // ; (59)  } (125)  < (60)
      if (ch === 59 || ch === 125 || ch === 60) break;
      end += 1;
    }
    const ff = firstFamily(s.slice(start, end));
    if (ff.length >= 2 && ff.length <= 50) hits[ff] = (hits[ff] || 0) + 1;
    // Advance past what we consumed so an overlapping match can't re-scan it.
    FONT_DECL_RE.lastIndex = end;
  }
  return Object.entries(hits).sort((a, b) => b[1] - a[1]);
}

// The og:image regex requires property BEFORE content, same as the reference —
// a reversed-attribute tag simply yields no preview.
const OG_RE = /<meta[^>]+property=["']og:image["'][^>]+content=["']([^"']+)["']/i;

// Build the draft the operator names and saves. PURE — the fetch lives in the
// route so this half is testable against fixture HTML with no network.
export function buildDraftFromHtml(html, url) {
  const palette = extractPalette(html);
  const fonts = extractFonts(html);

  const primary = (palette.find(([c]) => !isNearWhite(c) && !isNearBlack(c)) || [])[0] || '#7c3aed';
  const secondary = (palette.find(([c]) => c !== primary && !isNearWhite(c) && !isNearBlack(c)) || [])[0] || '#06b6d4';
  const bg = (palette.find(([c]) => isNearWhite(c)) || [])[0] || '#ffffff';
  const fg = (palette.find(([c]) => isNearBlack(c)) || [])[0] || '#0a0a0a';

  const primaryFont = fonts.length ? fonts[0][0] : 'system-ui';
  const ogMatch = typeof html === 'string' ? html.match(OG_RE) : null;

  let host = '';
  try { host = new URL(url).hostname.replace(/^www\./, ''); } catch { host = ''; }
  const name = (host || 'Imported Theme').slice(0, 40);

  // FINDING — the reference's dark muted/border branch is UNREACHABLE, and the
  // port keeps it that way on purpose. `bg` is the first near-white in the
  // palette, and its fallback when the page has none is '#ffffff' — itself
  // near-white. So isNearWhite(bg) is a tautology and muted/border are
  // constants; an imported dark site still gets the light pair. Diverging here
  // would be an unverifiable cosmetic change: both tokens are 'none' in
  // TOKEN_SUPPORT, so neither has ever reached a rendered page. Asserted by
  // execution in the themes harness rather than left as a comment to trust.
  const lightBg = isNearWhite(bg);
  return {
    name: `From ${name}`,
    is_preset: false,
    imported_from: sanitizeUrl(url),
    preview_url: ogMatch ? sanitizeUrl(ogMatch[1]) : '',
    tokens: {
      primary,
      secondary,
      background: bg,
      foreground: fg,
      muted: lightBg ? '#f3f4f6' : '#1f2937',
      border: lightBg ? '#e5e7eb' : '#27272a',
      radius: '12px',
      font_heading: `'${primaryFont}', system-ui, sans-serif`,
      font_body: `'${primaryFont}', system-ui, sans-serif`,
      cta_bg: primary,
      cta_fg: '#ffffff',
    },
    // Swatch/family pickers for the draft editor — top 12 / top 6, as the
    // reference returns them. Not tokens; never persisted.
    palette_full: palette.slice(0, 12).map(([c]) => c),
    fonts_full: fonts.slice(0, 6).map(([f]) => f),
  };
}

export default {
  PRESETS, TOKEN_KEYS, TOKEN_DEFAULTS, TOKEN_SUPPORT,
  listPresets, getPreset, buildApplyPlan, buildDraftFromHtml,
};
