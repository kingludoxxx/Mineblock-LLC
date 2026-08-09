// PAGE BUILDER — style inspector helpers.
//
// props.style is the generic per-block style bag written by the RightPanel
// Style/Advanced tabs and applied:
//   • on the PUBLIC page by server funnelRender.js blockStyleWrap() — the
//     authority, with metachar stripping;
//   • on the CANVAS by styleToCanvas() below — a React-style mirror so the
//     builder is representative. Values are used as React inline styles
//     (never innerHTML), so no escaping is needed here.
//
// Keys (all optional):
//   width height min_width min_height max_width max_height  (CSS lengths)
//   z_index (int) · bg (color) · text_color (color)
//   font_family font_weight (strings) · font_size (px number)
//   line_height (unitless number) · letter_spacing (px number)
//   margin padding (CSS shorthand) · css_class (string)
//   text_align (left|center|right|justify) · justify_content (flex preset)
//   hide_desktop hide_mobile (bool)
//
// BREAKPOINTS (additive): props.mobile_styles is an OVERRIDE bag with the
// SAME keys as props.style. It is not a second style system — it is the same
// bag, read second, at widths <= MOBILE_MAX_PX. A key absent from
// mobile_styles INHERITS the base value; a key present overrides it. That is
// plain CSS cascade semantics, so what the canvas shows and what a media
// query produces are the same thing by construction.
//
// MOBILE_MAX_PX is pinned to the breakpoint the theme ALREADY uses for
// .lb-hide-mobile / .lb-hide-desktop (funnelRender THEME_CSS) — one boundary
// in the product, not two that can disagree.

export const FONT_FAMILIES = [
  { value: '', label: 'Default (theme)' },
  { value: 'Arial, sans-serif', label: 'Arial' },
  { value: 'Helvetica, Arial, sans-serif', label: 'Helvetica' },
  { value: 'Georgia, serif', label: 'Georgia' },
  { value: 'Times New Roman, Times, serif', label: 'Times New Roman' },
  { value: 'Courier New, monospace', label: 'Courier New' },
  { value: 'Verdana, sans-serif', label: 'Verdana' },
  { value: 'Tahoma, sans-serif', label: 'Tahoma' },
  { value: 'Trebuchet MS, sans-serif', label: 'Trebuchet MS' },
  { value: 'system-ui, sans-serif', label: 'System UI' },
];

export const FONT_WEIGHTS = [
  { value: '', label: 'Default' },
  { value: '100', label: 'Thin (100)' },
  { value: '300', label: 'Light (300)' },
  { value: '400', label: 'Regular (400)' },
  { value: '500', label: 'Medium (500)' },
  { value: '600', label: 'Semibold (600)' },
  { value: '700', label: 'Bold (700)' },
  { value: '800', label: 'Extrabold (800)' },
  { value: '900', label: 'Black (900)' },
];

// The ONE mobile boundary. Mirrors funnelRender's THEME_CSS visibility rules
// (@media (max-width: 767px) { .lb-hide-mobile … }).
export const MOBILE_MAX_PX = 767;

// The two style bags a block can carry, in cascade order.
export const BASE_STYLE_KEY = 'style';
export const MOBILE_STYLE_KEY = 'mobile_styles';

export const BREAKPOINTS = [
  { id: 'desktop', label: 'Desktop', bag: BASE_STYLE_KEY, hint: 'Base — applies everywhere unless overridden' },
  { id: 'mobile', label: 'Mobile', bag: MOBILE_STYLE_KEY, hint: `Overrides the base at \u2264${MOBILE_MAX_PX}px` },
];

export const bagForBreakpoint = (bp) => (bp === 'mobile' ? MOBILE_STYLE_KEY : BASE_STYLE_KEY);

export const TEXT_ALIGNS = [
  { value: 'left', label: 'Left' },
  { value: 'center', label: 'Center' },
  { value: 'right', label: 'Right' },
  { value: 'justify', label: 'Justify' },
];

// Flex justify presets. Setting one makes the block wrapper a flex row — the
// control says so, because a block that silently becomes a flex container is
// a layout surprise the operator cannot debug from the inspector.
export const JUSTIFY_PRESETS = [
  { value: 'flex-start', label: 'Start' },
  { value: 'center', label: 'Center' },
  { value: 'flex-end', label: 'End' },
  { value: 'space-between', label: 'Between' },
];

const isObj = (v) => v != null && typeof v === 'object' && !Array.isArray(v);

// The raw bag for one breakpoint — never merged, so the inspector can tell
// "no mobile override" (inherit) apart from "mobile override equal to base".
export function styleBag(props, bp) {
  const p = isObj(props) ? props : {};
  const bag = p[bagForBreakpoint(bp)];
  return isObj(bag) ? bag : {};
}

// base ← mobile, the cascade. `bp === 'mobile'` yields the EFFECTIVE style at
// mobile widths; anything else yields the base untouched.
export function effectiveStyle(props, bp) {
  const base = styleBag(props, 'desktop');
  if (bp !== 'mobile') return base;
  return { ...base, ...styleBag(props, 'mobile') };
}

// True when the block carries any mobile override at all (drives the dot on
// the Mobile segment so an operator can see a page's overrides exist without
// clicking every block).
export function hasMobileOverrides(props) {
  return Object.keys(styleBag(props, 'mobile')).length > 0;
}

// Mirror of the server's length-key map (blockStyleWrap).
const LEN_KEYS = [
  ['width', 'width'],
  ['height', 'height'],
  ['min_width', 'minWidth'],
  ['min_height', 'minHeight'],
  ['max_width', 'maxWidth'],
  ['max_height', 'maxHeight'],
  ['margin', 'margin'],
  ['padding', 'padding'],
];

// props → React inline style for the canvas block wrapper, for the builder
// device currently previewed. `device` is the builder's 3-way preview
// (mobile | tablet | desktop); only 'mobile' is <= MOBILE_MAX_PX, so tablet
// and desktop read the base bag — exactly what a max-width media query does.
export function styleToCanvas(props, device = 'desktop') {
  const s = effectiveStyle(props, device === 'mobile' ? 'mobile' : 'desktop');
  if (!s || !Object.keys(s).length) return null;
  const out = {};
  for (const [key, reactKey] of LEN_KEYS) {
    if (s[key] != null && String(s[key]).trim() !== '') out[reactKey] = String(s[key]);
  }
  const z = parseInt(s.z_index, 10);
  if (Number.isFinite(z)) { out.position = 'relative'; out.zIndex = z; }
  if (s.bg) out.background = String(s.bg);
  if (s.text_color) out.color = String(s.text_color);
  if (s.font_family) out.fontFamily = String(s.font_family);
  if (s.font_weight) out.fontWeight = String(s.font_weight);
  const fs = Number(s.font_size);
  if (Number.isFinite(fs)) out.fontSize = fs;
  const lh = Number(s.line_height);
  if (Number.isFinite(lh)) out.lineHeight = lh;
  const ls = Number(s.letter_spacing);
  if (Number.isFinite(ls)) out.letterSpacing = `${ls}px`;
  if (s.text_align) out.textAlign = String(s.text_align);
  // A justify preset only means anything on a flex container, so the wrapper
  // becomes one. Mirrored EXACTLY by the renderer patch (display:flex is
  // emitted alongside justify-content, never on its own).
  if (s.justify_content) {
    out.display = 'flex';
    out.justifyContent = String(s.justify_content);
  }
  return Object.keys(out).length ? out : null;
}

// True when the block is hidden on the given builder device preview.
// Visibility lives on the BASE bag only: "hide on mobile" is already a
// breakpoint statement, so a per-breakpoint copy of it would be a second
// switch for the same wire.
export function hiddenOnDevice(props, device) {
  const s = styleBag(props, 'desktop');
  if (device === 'mobile') return s.hide_mobile === true;
  return s.hide_desktop === true; // tablet previews follow desktop (≥768px)
}
