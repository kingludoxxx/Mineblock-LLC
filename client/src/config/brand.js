// Brand config — RUNTIME first, build-time fallback.
//
// The store's brand is DATA (RULES.md R5): the server serves it from env
// BRAND_* at request time on GET /api/v1/brand (public). This module fetches
// it once at boot and updates the LIVE BINDINGS below, so every importer sees
// the runtime value on its next render. Fields the server leaves null (env
// unset) and any failed or malformed response keep the build-time value — the
// VITE_BRAND_* env the bundle was built with, or the NEUTRAL default (W8a:
// never another store's name, never another store's image).
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

// W8a — THE BUILD-TIME FALLBACK CARRIES NO STORE (R5 / R15).
//
// It used to default to one particular store's name and to that store's own
// bundled images, so a brand-new store whose service sets BRAND_NAME but no
// BRAND_LOGO_* (which is exactly what the provisioner creates) painted THAT
// store's wordmark in its own sidebar. The defaults below name nobody:
//
//   name / shortName -> a neutral placeholder, never a store
//   every logo       -> null, read by the shell as "this store has no image,
//                       draw a wordmark from the short name" (StoreSwitcher)
//   emailDomain      -> the RFC 2606 reserved example domain
//
// A store that HAS images ships them in its OWN env, and both paths below are
// unchanged: VITE_BRAND_LOGO_* at build time (which the two existing dashboard
// services already carry, so their bundles are byte-identical in this respect)
// and BRAND_LOGO_* at request time through GET /api/v1/brand. Only the
// right-hand side of each `||` moved.
export const NEUTRAL_NAME = 'Store';

const FALLBACK = Object.freeze({
  name:        env.VITE_BRAND_NAME         || NEUTRAL_NAME,
  shortName:   env.VITE_BRAND_SHORT_NAME   || NEUTRAL_NAME,
  logoWhite:   env.VITE_BRAND_LOGO_WHITE   || null,
  logoSymbol:  env.VITE_BRAND_LOGO_SYMBOL  || null,
  logoBlack:   env.VITE_BRAND_LOGO_BLACK   || null,
  emailDomain: env.VITE_BRAND_EMAIL_DOMAIN || 'example.com',
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
  if (current.source === 'runtime') { try { fn(getBrand()); } catch { /* see applyBrand() */ } }
  return () => listeners.delete(fn);
}

const str = (v) => (typeof v === 'string' && v.trim() !== '' ? v : null);

/**
 * Apply a brand answer ({name, shortName, logoWhite, logoSymbol, logoBlack,
 * emailDomain}; any field null or absent falls back per field). Exported so a
 * test — and the dev harness the browser check builds — can drive the runtime
 * path without an HTTP server. `load()` below is its only production caller.
 */
export function applyBrand(data) {
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
    applyBrand(data);
  } catch {
    // offline / dev without a server: the build-time brand stands
  }
}

/** Resolves once the runtime read has settled (success or not). */
export const brandReady = load();
