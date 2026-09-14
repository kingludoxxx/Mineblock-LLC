// Brief Pipeline product context. The legacy builder is moved here VERBATIM from routes/briefPipeline.js so it can
// be tested; buildBriefProductContext() is what every brief path calls: the Product Bible pack when one applies
// (never sent alongside the legacy fields / master brief), today's text otherwise.

export function buildProductContextForBrief(p) {
  if (!p) return 'No product profile available.';
  const lines = [
    // ── Core Identity ──
    p.name             && `Product: ${p.name}`,
    p.product_code     && `Product Code: ${p.product_code}`,
    p.short_name       && `Short Name: ${p.short_name}`,
    p.description      && `Description: ${p.description}`,
    p.oneliner         && `One-Liner: ${p.oneliner}`,
    p.tagline          && `Tagline: ${p.tagline}`,
    p.product_type     && `Product Type: ${p.product_type}`,
    p.product_group    && `Product Group: ${p.product_group}`,
    p.category         && `Category: ${p.category}`,
    // ── Pricing & Offer ──
    p.price            && `Price: ${p.price}`,
    p.product_url      && `Product URL: ${p.product_url}`,
    p.unit_details     && `Unit Details: ${p.unit_details}`,
    p.offer_details    && `Offer Details: ${p.offer_details}`,
    p.max_discount     && `Max Discount: ${p.max_discount}`,
    p.discount_codes   && `Discount Codes: ${p.discount_codes}`,
    p.bundle_variants  && `Bundle Variants: ${p.bundle_variants}`,
    p.offers?.length   && `Active Offers: ${Array.isArray(p.offers) ? p.offers.map(o => o.name || o.title || o.text || JSON.stringify(o)).join('; ') : p.offers}`,
    p.guarantee        && `Guarantee: ${p.guarantee}`,
    // ── Persuasion Engine ──
    p.big_promise      && `Big Promise: ${p.big_promise}`,
    p.mechanism        && `Unique Mechanism: ${p.mechanism}`,
    p.differentiator   && `Differentiator: ${p.differentiator}`,
    p.competitive_edge && `Competitive Edge: ${p.competitive_edge}`,
    p.benefits?.length && `Key Benefits: ${Array.isArray(p.benefits) ? p.benefits.map(b => b.text || b.name || b).join(', ') : p.benefits}`,
    // ── Audience ──
    p.customer_avatar  && `Target Customer: ${p.customer_avatar}`,
    p.customer_frustration && `Customer Frustration: ${p.customer_frustration}`,
    p.customer_dream   && `Customer Dream Outcome: ${p.customer_dream}`,
    p.target_demographics && `Target Demographics: ${p.target_demographics}`,
    p.pain_points      && `Pain Points: ${p.pain_points}`,
    p.common_objections && `Common Objections: ${p.common_objections}`,
    // ── Brand & Voice ──
    p.voice            && `Brand Voice/Tone: ${p.voice}`,
    // ── Angles & Strategy ──
    p.winning_angles   && `Winning Angles: ${p.winning_angles}`,
    p.custom_angles_text && `Custom Angles: ${p.custom_angles_text}`,
    p.angles?.length   && `Proven Angles: ${Array.isArray(p.angles) ? p.angles.map(a => a.name || a).join(', ') : p.angles}`,
    // ── Proven Scripts (for style reference) ──
    p.scripts?.length  && `Proven Scripts: ${Array.isArray(p.scripts) ? p.scripts.slice(0, 3).map((s, i) => `[${i + 1}] ${(typeof s === 'string' ? s : (s.text || s.body || JSON.stringify(s))).slice(0, 200)}`).join('\n') : p.scripts}`,
    // ── Compliance ──
    p.compliance_restrictions && `COMPLIANCE — Never claim: ${p.compliance_restrictions}`,
    p.notes            && `Notes: ${p.notes}`,
  ].filter(Boolean);
  const base = lines.join('\n');

  // Full master brief — the operator's complete product document (angles with
  // full strategy, mechanism, avatar deep-dive, offer structure). The distilled
  // fields above are a summary; generation quality depends on the model seeing
  // 100% of this. Appended last so the structured fields stay scannable.
  if (p.master_brief && String(p.master_brief).trim()) {
    return `${base}\n\n===== MASTER PRODUCT BRIEF — FULL DOCUMENT (primary source of truth) =====\n\n${String(p.master_brief).trim()}`;
  }
  return base;
}

/**
 * @param {object|null} profile  product_profiles row
 * @param {object|null} pack     a resolved Product Bible pack (resolvePipelineBible), or null
 */
export function buildBriefProductContext(profile, pack) {
  if (pack && typeof pack.text === 'string' && pack.text) return pack.text;
  return buildProductContextForBrief(profile);
}
