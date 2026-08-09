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
//   hide_desktop hide_mobile (bool)

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

const isObj = (v) => v != null && typeof v === 'object' && !Array.isArray(v);

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

// props.style → React inline style for the canvas block wrapper.
export function styleToCanvas(props) {
  const s = isObj(props) && isObj(props.style) ? props.style : null;
  if (!s) return null;
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
  return Object.keys(out).length ? out : null;
}

// True when the block is hidden on the given builder device preview.
export function hiddenOnDevice(props, device) {
  const s = isObj(props) && isObj(props.style) ? props.style : null;
  if (!s) return false;
  if (device === 'mobile') return s.hide_mobile === true;
  return s.hide_desktop === true; // tablet previews follow desktop (≥768px)
}
