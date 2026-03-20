export function buildClaudePrompt(product, angle) {
  const profile = product.profile || {};
  return `You are a senior direct-response ad copywriter and visual analyst. Analyze this reference ad image with extreme precision.

PRODUCT CONTEXT:
- Product Name: ${product.name}
- Description: ${product.description || 'N/A'}
- Price: ${product.price || 'N/A'}
- One-liner: ${profile.oneliner || 'N/A'}
- Target Customer: ${profile.customerAvatar || 'N/A'}
- Customer Frustration: ${profile.customerFrustration || 'N/A'}
- Customer Dream: ${profile.customerDream || 'N/A'}
- Big Promise: ${profile.bigPromise || 'N/A'}
- Mechanism: ${profile.mechanism || 'N/A'}
- Differentiator: ${profile.differentiator || 'N/A'}
- Voice/Tone: ${profile.voice || 'N/A'}
- Guarantee: ${profile.guarantee || 'N/A'}
${angle ? `- Marketing Angle: ${angle}` : ''}

INSTRUCTIONS:

1. TEXT EXTRACTION — Extract EVERY piece of visible text from this ad image:
   - Headlines, Subheadlines, Body copy, CTAs, Badges, Bullet points, Statistics, Any other text
   RULES: Only extract text ACTUALLY VISIBLE. Do NOT hallucinate. Do NOT include layout labels like "Day 0", "Before", "After".

2. COPY ADAPTATION — Rewrite each text element for the product above.
   CRITICAL: Adapted text MUST follow the EXACT same sentence structure, opening words, and approximate word count as the original.
   Examples: "Bye Bye, Beer Belly" → "Bye Bye, Gut Bloat" (keeps "Bye Bye," formula)

3. VISUAL ANALYSIS — Count people, count products, identify angle-specific visual elements.

Return ONLY valid JSON (no markdown, no code fences, no explanation):
{
  "original_text": { "headline": "", "subheadline": "", "body": "", "cta": "", "badges": [], "bullets": [], "stats": [], "other_text": [] },
  "adapted_text": { "headline": "", "subheadline": "", "body": "", "cta": "", "badges": [], "bullets": [], "stats": [], "other_text": [] },
  "people_count": 0, "product_count": 0, "adapted_audience": "", "character_adaptation": "",
  "visual_adaptations": [{ "original_visual": "", "adapted_visual": "", "position": "", "is_angle_specific": false }]
}`;
}

export function buildNanoBananaPrompt(claudeResult, swapPairs, product) {
  const { people_count, product_count, adapted_audience, character_adaptation, visual_adaptations } = claudeResult;

  const swapSection = swapPairs.map((pair, i) => `  ${i + 1}. Replace "${pair.original}" with "${pair.adapted}"`).join('\n');

  let characterRules = people_count === 0
    ? 'PEOPLE: Do NOT add any human faces or bodies. The reference has zero people.'
    : `PEOPLE: Output must have EXACTLY ${people_count} person(s). Use DIFFERENT person(s) of same gender/age. Target: ${adapted_audience || 'similar to reference'}. ${character_adaptation || ''}`;

  const visualSection = (visual_adaptations || []).map((v, i) =>
    `  ${i + 1}. ${v.position}: ${v.original_visual} → ${v.adapted_visual}${v.is_angle_specific ? ' [MANDATORY]' : ''}`
  ).join('\n');

  return `Generate a new ad creative based on the reference ad (image 2). Use the product from image 1.

PRODUCT REPLACEMENT:
- Remove ALL competitor branding, logos, product imagery
- Replace with product from image 1 (${product.name})
- Show exactly ${product_count || 1} product(s). Realistic lighting/shadows/perspective
- Preserve exact layout, composition, design structure

TEXT REPLACEMENTS (exactly ${swapPairs.length} swaps):
${swapSection || '  (No text changes)'}
- Font style, weight, size, color must EXACTLY match reference
- Do NOT add extra text blocks. Do NOT remove unlisted text.

${characterRules}

VISUAL ADAPTATIONS:
${visualSection || '  (None)'}

ABSOLUTE RULES:
1. ZERO extra faces beyond ${people_count}
2. ZERO extra text beyond ${swapPairs.length} swap(s)
3. Layout labels stay as-is
4. No competitor branding remaining
5. Same background color/gradient/texture
6. Hands: exactly 5 fingers, realistic
7. Match reference style, palette, mood
8. Text must be sharp, legible, correctly spelled`;
}

export function buildSwapPairs(originalText, adaptedText) {
  const pairs = [];
  for (const field of ['headline', 'subheadline', 'body', 'cta']) {
    const orig = originalText[field], adapted = adaptedText[field];
    if (orig && adapted && orig.trim() !== adapted.trim())
      pairs.push({ original: orig.trim(), adapted: adapted.trim(), field });
  }
  for (const field of ['badges', 'bullets', 'stats', 'other_text']) {
    const origArr = originalText[field] || [], adaptedArr = adaptedText[field] || [];
    for (let i = 0; i < Math.min(origArr.length, adaptedArr.length); i++) {
      if (origArr[i] && adaptedArr[i] && origArr[i].trim() !== adaptedArr[i].trim())
        pairs.push({ original: origArr[i].trim(), adapted: adaptedArr[i].trim(), field: `${field}[${i}]` });
    }
  }
  return pairs;
}
