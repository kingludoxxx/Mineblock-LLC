// ─────────────────────────────────────────────────────────────────────────────
// defaultProduct — which product the Static Ads page starts on.
//
// Landing with nothing selected is not a neutral state: the manual Product Info
// panel appears, and any generation from there sends product_id=null, which
// silently skips the server's product_profiles re-fetch — no master brief, no
// per-angle shot selection, no angles. The output degrades with no error.
//
// The previous rule was `list.find(p => /miner\s*forge\s*pro/i.test(p.name))`.
// Puure's database contains exactly one product ("Puure") and no MinerForge, so
// on the Puure instance nothing was ever auto-selected. Rather than hardcode a
// second product name into shared code, resolve by precedence.
// ─────────────────────────────────────────────────────────────────────────────

import { BRAND_NAME, BRAND_SHORT_NAME } from '../../../config/brand';

export const LAST_PRODUCT_LS_KEY = 'statics_last_product_id';

const norm = (s) => String(s || '').toLowerCase().replace(/[^a-z0-9]+/g, '');

/**
 * Pick the product to select on load.
 *
 * Precedence, most specific first:
 *   1. the product the operator last worked on, if it is still in the list —
 *      an explicit past choice beats any inference
 *   2. a product whose name matches this deployment's brand (Puure → "Puure",
 *      Mineblock → falls through, since "Mineblock LLC" is not a product name)
 *   3. the only product, when there is exactly one — no ambiguity to resolve
 *   4. a legacy MinerForge match, preserving Mineblock's original behaviour on
 *      a multi-product list
 *   5. the first product — better than leaving the operator on the null state
 *
 * @param {Array<{id:*, name:string}>} list
 * @param {string|number|null} lastUsedId  injected for testability
 * @returns {object|null}
 */
export function resolveDefaultProduct(list, lastUsedId = readLastProductId()) {
  if (!Array.isArray(list) || list.length === 0) return null;

  if (lastUsedId != null && lastUsedId !== '') {
    const remembered = list.find(p => String(p?.id) === String(lastUsedId));
    if (remembered) return remembered;
  }

  const brandKeys = [BRAND_SHORT_NAME, BRAND_NAME].map(norm).filter(Boolean);
  const brandMatch = list.find(p => {
    const n = norm(p?.name);
    if (!n) return false;
    return brandKeys.some(b => {
      if (!b) return false;
      if (n === b) return true;
      // Substring matching only when BOTH sides are long enough to be
      // meaningful. Without the length floor a product literally named "B"
      // matches the brand "Mineblock", because 'mineblock'.includes('b').
      return n.length >= 4 && b.length >= 4 && (n.includes(b) || b.includes(n));
    });
  });
  if (brandMatch) return brandMatch;

  if (list.length === 1) return list[0];

  const miner = list.find(p => /miner\s*forge\s*pro/i.test(p?.name || ''));
  if (miner) return miner;

  return list[0];
}

export function readLastProductId() {
  try { return localStorage.getItem(LAST_PRODUCT_LS_KEY); }
  catch { return null; }   // private mode / storage disabled
}

export function rememberProduct(id) {
  try {
    if (id == null || id === '') localStorage.removeItem(LAST_PRODUCT_LS_KEY);
    else localStorage.setItem(LAST_PRODUCT_LS_KEY, String(id));
  } catch { /* non-fatal — selection still works for this session */ }
}
