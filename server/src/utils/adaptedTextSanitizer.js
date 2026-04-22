// ─────────────────────────────────────────────────────────────────────────────
// Adapted-Text Sanitizer — P0.4.6
//
// Runs AFTER Claude returns adapted_text, BEFORE we build swap pairs or pass
// the copy to Gemini / the overlay. Deterministic regex pass that rewrites or
// strips the specific fabrication patterns Claude keeps producing even with
// prompt rules in place:
//
//   - "X% OFF" where X doesn't match product.profile.maxDiscount
//   - "LIFETIME WARRANTY" when the real guarantee is a specific period
//   - "N-DAY MONEY BACK" / "N-YEAR WARRANTY" that don't match reality
//   - "WAS $X, NOW $Y" where $X isn't the actual product.price
//   - Any $ amount that isn't product.price, a bundle variant, or the
//     maxDiscount-derived price
//
// The overlay will render whatever adapted_text we pass it, so this is our
// last chance to catch Claude's fabrications. Everything that gets through
// here ships to the user.
//
// Strategy: prefer REWRITE over DELETE — keep the slot filled with a valid
// claim so the ad still has content. Only strip when there's no valid
// substitute.
// ─────────────────────────────────────────────────────────────────────────────

const LOG = '[adaptedTextSanitizer]';

/**
 * Walk any value (string, array, nested object) and apply `transform` to each
 * string. Returns a new structure with transforms applied.
 */
function walkStrings(value, transform) {
  if (value == null) return value;
  if (typeof value === 'string') return transform(value);
  if (Array.isArray(value)) return value.map(v => walkStrings(v, transform)).filter(v => v !== null);
  if (typeof value === 'object') {
    const out = {};
    for (const [k, v] of Object.entries(value)) {
      out[k] = walkStrings(v, transform);
    }
    return out;
  }
  return value;
}

/**
 * Extract the numeric discount percentage from a maxDiscount string.
 * "10% off" → 10, "Up to 15% off" → 15, "10 percent" → 10, null if no digit.
 */
function extractDiscountPct(maxDiscountStr) {
  if (!maxDiscountStr || typeof maxDiscountStr !== 'string') return null;
  const m = maxDiscountStr.match(/(\d{1,2})\s*%/);
  if (m) return parseInt(m[1], 10);
  const m2 = maxDiscountStr.match(/(\d{1,2})\s*percent/i);
  if (m2) return parseInt(m2[1], 10);
  return null;
}

/**
 * Extract the base product price as a number. "$249" → 249, "$59.99" → 59.99.
 */
function extractPrice(priceStr) {
  if (!priceStr || typeof priceStr !== 'string') return null;
  const m = priceStr.match(/\$?\s*(\d+(?:\.\d+)?)/);
  if (m) return parseFloat(m[1]);
  return null;
}

/**
 * Extract every $ amount referenced by a product's bundle variants.
 * "1 unit: $249 | 2-pack: $449 (save $49) | 3-pack: $629" →
 *   [249, 449, 49, 629]
 */
function extractBundlePrices(bundleStr) {
  if (!bundleStr || typeof bundleStr !== 'string') return [];
  return [...bundleStr.matchAll(/\$\s*(\d+(?:\.\d+)?)/g)].map(m => parseFloat(m[1]));
}

/**
 * Normalize "a 90-day", "30 day", "30 days", "2-year", "2 yr", "2 years",
 * "lifetime" into canonical tokens like "90-DAY" / "2-YEAR" / "LIFETIME".
 */
function extractGuaranteeTokens(guaranteeStr, offerDetailsStr) {
  const tokens = new Set();
  const combined = `${guaranteeStr || ''} ${offerDetailsStr || ''}`.toLowerCase();
  if (!combined.trim()) return tokens;
  for (const m of combined.matchAll(/(\d{1,3})[-\s]?(day|yr|year|month|mo)s?/g)) {
    const num = m[1];
    const unit = m[2].startsWith('y') ? 'YEAR' : m[2].startsWith('mo') ? 'MONTH' : 'DAY';
    tokens.add(`${num}-${unit}`);
  }
  if (/lifetime/.test(combined)) tokens.add('LIFETIME');
  return tokens;
}

/**
 * Main sanitize entry point.
 *
 * @param {object} adaptedText - Claude's adapted_text JSON
 * @param {object} product - { name, price, profile: { maxDiscount, guarantee, offerDetails, bundleVariants, discountCodes, ... } }
 * @returns {{ sanitizedText: object, changes: string[] }}
 */
export function sanitizeAdaptedText(adaptedText, product) {
  if (!adaptedText || typeof adaptedText !== 'object') {
    return { sanitizedText: adaptedText, changes: [] };
  }

  const profile = product?.profile || {};
  const maxDiscountPct = extractDiscountPct(profile.maxDiscount);
  const basePrice = extractPrice(product?.price);
  const bundlePrices = extractBundlePrices(profile.bundleVariants);
  const validPrices = new Set();
  if (basePrice) {
    validPrices.add(basePrice);
    if (maxDiscountPct) {
      // discounted price to 2dp
      const disc = +(basePrice * (1 - maxDiscountPct / 100)).toFixed(2);
      validPrices.add(disc);
      validPrices.add(Math.round(disc));
    }
  }
  for (const p of bundlePrices) validPrices.add(p);
  const validGuaranteeTokens = extractGuaranteeTokens(profile.guarantee, profile.offerDetails);
  const discountCode = profile.discountCodes || '';

  const changes = [];

  // ── Rewrite function applied to every string ──
  const rewrite = (str) => {
    if (!str || typeof str !== 'string') return str;
    let out = str;

    // ── A. Fake "% OFF" rewrites ──
    if (maxDiscountPct != null) {
      // Only match explicit discount claims: "58% OFF", "UP TO 65% SAVE", "SAVE 70%", etc.
      // Bare percentages without a discount keyword (e.g. "100% yours", "100% of the block reward")
      // are NOT discount claims and must NOT be rewritten — they are reward-share or retention figures.
      // 100% is always exempt: it is the correct reward-share value for solo mining.
      const pctRe = /\b(?:up\s+to\s+)?(\d{1,3})\s*%\s*(?:off|savings?|save|discount)\b/gi;
      out = out.replace(pctRe, (match, digits) => {
        const n = parseInt(digits, 10);
        if (n === 100) return match;            // 100% is always a valid reward-share claim
        if (n === maxDiscountPct) return match; // already correct
        if (n < maxDiscountPct) return match;   // smaller claim — allow it
        // Inflated claim — rewrite to the real max
        const replacement = match
          .replace(/\d{1,3}\s*%/, `${maxDiscountPct}%`)
          .replace(/up\s+to\s+/i, '');
        changes.push(`fake-%OFF: "${match}" → "${replacement}" (real max ${maxDiscountPct}%)`);
        return replacement;
      });
    } else {
      // No maxDiscount configured — strip any "% OFF" claim entirely, it's all fabricated
      const pctRe = /\b(?:up\s+to\s+)?\d{1,3}\s*%\s*off\b/gi;
      const pre = out;
      out = out.replace(pctRe, '').replace(/\s+/g, ' ').trim();
      if (pre !== out) changes.push(`fake-%OFF-stripped: "${pre}" → "${out}"`);
    }

    // ── B. Fake guarantee / warranty rewrites ──
    // Match "LIFETIME WARRANTY", "90-DAY MONEY BACK", "2-YEAR WARRANTY", etc.
    const guarRe = /\b(lifetime|(\d{1,3})[-\s]?(day|yr|year|month|mo)s?)\b\s*(warranty|money[-\s]?back|guarantee|returns?|coverage)?/gi;
    out = out.replace(guarRe, (match, _whole, digits, unit) => {
      let token;
      if (/lifetime/i.test(match)) token = 'LIFETIME';
      else if (digits && unit) {
        const U = unit.toLowerCase().startsWith('y') ? 'YEAR' : unit.toLowerCase().startsWith('mo') ? 'MONTH' : 'DAY';
        token = `${digits}-${U}`;
      } else {
        return match;
      }
      if (validGuaranteeTokens.has(token)) return match; // legit
      if (validGuaranteeTokens.size === 0) return match; // no ground truth, pass through
      // Pick the first valid guarantee token to substitute
      const real = [...validGuaranteeTokens][0];
      const [realN, realU] = real.split('-');
      // Rebuild the matched phrase with real numbers
      let replacement = match.replace(/lifetime|\d{1,3}[-\s]?(day|yr|year|month|mo)s?/i, () => {
        if (real === 'LIFETIME') return 'LIFETIME';
        const unitWord = realU === 'YEAR' ? (realN === '1' ? 'YEAR' : 'YEAR') : realU === 'MONTH' ? (realN === '1' ? 'MONTH' : 'MONTH') : (realN === '1' ? 'DAY' : 'DAY');
        return `${realN}-${unitWord}`;
      });
      changes.push(`fake-guarantee: "${match}" → "${replacement}" (real: ${real})`);
      return replacement;
    });

    // ── C. Fake "WAS $X" anchor prices ──
    // Patterns: "WAS $277, NOW $249", "WAS $277", "ORIGINALLY $350", "$277 $249"
    if (basePrice != null) {
      const wasRe = /\bwas\s*\$\s*(\d+(?:\.\d+)?)/gi;
      out = out.replace(wasRe, (match, digits) => {
        const n = parseFloat(digits);
        if (validPrices.has(n) || validPrices.has(Math.round(n))) return match;
        // Inflated fake anchor — strip the "WAS $X" part
        changes.push(`fake-WAS: "${match}" stripped (not in valid prices)`);
        return '';
      });
      const origRe = /\boriginally\s*\$\s*(\d+(?:\.\d+)?)/gi;
      out = out.replace(origRe, (match, digits) => {
        const n = parseFloat(digits);
        if (validPrices.has(n) || validPrices.has(Math.round(n))) return match;
        changes.push(`fake-ORIGINALLY: "${match}" stripped`);
        return '';
      });
    }

    // ── D. Any $ amount that isn't in validPrices — strip ──
    if (basePrice != null && validPrices.size > 0) {
      const priceRe = /\$\s*(\d+(?:\.\d+)?)/g;
      out = out.replace(priceRe, (match, digits) => {
        const n = parseFloat(digits);
        if (validPrices.has(n) || validPrices.has(Math.round(n))) return match;
        // Also accept very small discounts/savings ($5, $10, $20) as bundle-savings
        // if they're under 50% of base price — those might be legitimate mentions.
        if (n < basePrice * 0.4 && bundlePrices.length > 0 && bundlePrices.some(bp => Math.abs(bp - n) < 1)) {
          return match;
        }
        changes.push(`fake-$: "${match}" stripped (not in validPrices ${[...validPrices].join(',')})`);
        return '';
      });
    }

    // Collapse whitespace artifacts from strips
    out = out.replace(/,\s*,/g, ',').replace(/\s+/g, ' ').replace(/^[,\s—–-]+|[,\s—–-]+$/g, '').trim();

    return out;
  };

  const sanitizedText = walkStrings(adaptedText, (s) => {
    const result = rewrite(s);
    return result == null || result === '' ? '' : result;
  });

  if (changes.length > 0) {
    console.log(`${LOG} sanitized ${changes.length} claim(s):`);
    for (const c of changes) console.log(`${LOG}   - ${c}`);
  }

  return { sanitizedText, changes };
}
