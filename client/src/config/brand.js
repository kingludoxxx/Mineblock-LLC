// Brand config — RUNTIME first, build-time fallback.
//
// The store's brand is DATA (RULES.md R5): the server serves it from env
// BRAND_* at request time on GET /api/v1/brand (public). This module fetches
// it once at boot and updates the LIVE BINDINGS below, so every importer sees
// the runtime value on its next render. Fields the server leaves null (env
// unset) and any failed or malformed response keep the build-time value —
// the VITE_BRAND_* env the bundle was built with, or the historical default.
//
// Build env (still honoured as the fallback while the runtime read soaks):
//   VITE_BRAND_NAME, VITE_BRAND_SHORT_NAME, VITE_BRAND_LOGO_WHITE,
//   VITE_BRAND_LOGO_SYMBOL, VITE_BRAND_LOGO_BLACK, VITE_BRAND_EMAIL_DOMAIN
//
// Runtime env on the SERVER (server/config/env.<STORE>.example):
//   BRAND_NAME, BRAND_SHORT_NAME, BRAND_LOGO_WHITE, BRAND_LOGO_SYMBOL,
//   BRAND_LOGO_BLACK, BRAND_EMAIL_DOMAIN
//
// Importers keep using the named constants. Components rendered before the
// response arrives show the build-time value until their next render (the
// auth bootstrap re-renders the shell right after boot, so in practice the
// runtime brand is visible by first paint of the app). `brandReady` resolves
// once the fetch has settled either way; `onBrand(fn)` subscribes.

const env = (typeof import.meta !== 'undefined' && import.meta.env) || {};

const FALLBACK = Object.freeze({
  name:        env.VITE_BRAND_NAME         || 'Mineblock LLC',
  shortName:   env.VITE_BRAND_SHORT_NAME   || 'Mineblock',
  logoWhite:   env.VITE_BRAND_LOGO_WHITE   || '/logo-white.png',
  logoSymbol:  env.VITE_BRAND_LOGO_SYMBOL  || '/logo-symbol-white.png',
  logoBlack:   env.VITE_BRAND_LOGO_BLACK   || '/logo-black.svg',
  emailDomain: env.VITE_BRAND_EMAIL_DOMAIN || 'mineblock.com',
});

export let BRAND_NAME         = FALLBACK.name;
export let BRAND_SHORT_NAME   = FALLBACK.shortName;
export let BRAND_LOGO_WHITE   = FALLBACK.logoWhite;
export let BRAND_LOGO_SYMBOL  = FALLBACK.logoSymbol;
export let BRAND_LOGO_BLACK   = FALLBACK.logoBlack;
export let BRAND_EMAIL_DOMAIN = FALLBACK.emailDomain;

let current = { ...FALLBACK, source: 'build' };
const listeners = new Set();

/** The brand as currently resolved ({...fields, source: 'build' | 'runtime'}). */
export function getBrand() { return { ...current }; }

/**
 * Subscribe to the runtime brand; returns an unsubscribe function. If the
 * runtime brand has already been resolved the listener is called at once, so
 * a late subscriber never misses it.
 */
export function onBrand(fn) {
  listeners.add(fn);
  if (current.source === 'runtime') { try { fn(getBrand()); } catch { /* see apply() */ } }
  return () => listeners.delete(fn);
}

const str = (v) => (typeof v === 'string' && v.trim() !== '' ? v : null);

function apply(data) {
  const next = {
    name:        str(data.name)        ?? FALLBACK.name,
    shortName:   str(data.shortName)   ?? FALLBACK.shortName,
    logoWhite:   str(data.logoWhite)   ?? FALLBACK.logoWhite,
    logoSymbol:  str(data.logoSymbol)  ?? FALLBACK.logoSymbol,
    logoBlack:   str(data.logoBlack)   ?? FALLBACK.logoBlack,
    emailDomain: str(data.emailDomain) ?? FALLBACK.emailDomain,
  };
  BRAND_NAME = next.name; BRAND_SHORT_NAME = next.shortName;
  BRAND_LOGO_WHITE = next.logoWhite; BRAND_LOGO_SYMBOL = next.logoSymbol;
  BRAND_LOGO_BLACK = next.logoBlack; BRAND_EMAIL_DOMAIN = next.emailDomain;
  current = { ...next, source: 'runtime' };
  if (typeof document !== 'undefined') {
    const slug = next.shortName.toLowerCase().trim();
    if (slug) document.documentElement.setAttribute('data-brand', slug);
  }
  for (const fn of listeners) { try { fn(getBrand()); } catch { /* a listener must not break the others */ } }
}

async function load() {
  try {
    if (typeof fetch !== 'function') return;
    const r = await fetch('/api/v1/brand', { credentials: 'same-origin' });
    if (!r || !r.ok) return;
    const body = await r.json();
    const data = body && typeof body === 'object' && body.data && typeof body.data === 'object' ? body.data : null;
    if (!data) return;
    apply(data);
  } catch {
    // offline / dev without a server: the build-time brand stands
  }
}

/** Resolves once the runtime read has settled (success or not). */
export const brandReady = load();
