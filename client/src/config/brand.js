// Brand config — driven by Vite env vars so the same client code renders
// correctly for each fork (Mineblock, Puure). Fallbacks preserve Mineblock's
// original behavior when env vars are unset (dev / current Mineblock deploy).
//
// To brand a fork, set on the client's build env (Render → env vars, prefix VITE_):
//   VITE_BRAND_NAME="Puure"
//   VITE_BRAND_SHORT_NAME="Puure"
//   VITE_BRAND_LOGO_WHITE="/logo-puure-white.png"
//   VITE_BRAND_LOGO_SYMBOL="/logo-puure-symbol-white.png"
//   VITE_BRAND_LOGO_BLACK="/logo-puure-black.svg"
//   VITE_BRAND_EMAIL_DOMAIN="trypuure.co"

export const BRAND_NAME         = import.meta.env.VITE_BRAND_NAME         || 'Mineblock LLC';
export const BRAND_SHORT_NAME   = import.meta.env.VITE_BRAND_SHORT_NAME   || 'Mineblock';
export const BRAND_LOGO_WHITE   = import.meta.env.VITE_BRAND_LOGO_WHITE   || '/logo-white.png';
export const BRAND_LOGO_SYMBOL  = import.meta.env.VITE_BRAND_LOGO_SYMBOL  || '/logo-symbol-white.png';
export const BRAND_LOGO_BLACK   = import.meta.env.VITE_BRAND_LOGO_BLACK   || '/logo-black.svg';
export const BRAND_EMAIL_DOMAIN = import.meta.env.VITE_BRAND_EMAIL_DOMAIN || 'mineblock.com';
