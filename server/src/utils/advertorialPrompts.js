// ─── Compliance Scoring Scale ───────────────────────────────────────────────
export const COMPLIANCE_SCALE = {
  10: 'Completely clean',
  9: 'Excellent — soft structure/function claims only',
  8: 'Very good — aggressive language but defensible',
  7: 'Good — pushes boundaries but doesn\'t fabricate',
  6: 'Borderline — aggressive, still launchable',
  5: 'Risky — FDA/FTC review possible',
  4: 'Too risky',
};

// ─── XML Response Format (shared across copy prompts) ───────────────────────
const RESPONSE_FORMAT = `
RESPONSE FORMAT — Return XML (with JSON fallback):
<title>Short Ad Title</title>
<adcopy>Full 300+ word ad copy...</adcopy>
<headlines>["5 words max", "different angle", "third option"]</headlines>
<descriptions>["5 words max", "different angle", "third option"]</descriptions>
<compliance_score>8</compliance_score>
<compliance_notes>Soft structure claims only, defensible...</compliance_notes>
`.trim();

// ─── 1. System Prompt ───────────────────────────────────────────────────────
export function buildCopySystemPrompt() {
  return `You write direct-response, story-driven Meta ads (300+ words).

COPY STRUCTURE:
- Personal hook → Problem discovery → Hidden cause → Solution discovery
- → Product introduction → Social proof → Quality differentiators
- → Urgency/scarcity → CTA

CRITICAL RULES:
- First-person narrative throughout
- Authentic, conversational feel
- Natural product integration (not forced)
- NO URLs — replace with "click the link below"
- Strong urgency and clear CTA

COMPLIANCE GUIDELINES:
- No fake studies or mechanisms
- No disease cure claims
- Soft structure/function claims OK
- Emotional storytelling fine
- Subjective personal claims acceptable`;
}

// ─── 2. Copy Adaptation Prompt ──────────────────────────────────────────────
export function buildCopyAdaptPrompt(sourceCopy, product, angle, adaptationType) {
  const profile = product.profile || {};

  const productContext = `
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
- Marketing Angle: ${angle}`.trim();

  const adaptationInstructions = {
    direct_adapt: `ADAPTATION METHOD: Direct Adapt (faithful structural rewrite)
- Keep the EXACT narrative arc, story beats, and emotional flow
- Same hook style, pacing, and number of sections
- Translation approach: same story, different product/angle
- Same approximate word count
- Mirror the source copy's structure beat-for-beat`,

    pain_pivot: `ADAPTATION METHOD: Pain Pivot (sub-pain-point variation)
- Keep the same structural skeleton and copy architecture
- Swap the core pain point to a DIFFERENT sub-angle within the "${angle}" macro angle
- Use different symptoms, frustrations, and emotional triggers
- Same opening hook STYLE but target a different specific symptom
- The reader should feel a different specific pain while following the same journey`,

    creative_swing: `ADAPTATION METHOD: Creative Swing (creatively free version)
- Use the source copy as INSPIRATION ONLY, not as a template
- Write a completely different story with a different narrative structure
- Different hook style, story arc, and emotional entry point
- Take bigger creative risks while maintaining the angle and product focus
- Surprise the reader — this should feel like a totally different ad`,
  };

  return `${productContext}

SOURCE AD COPY (reference):
---
${sourceCopy}
---

${adaptationInstructions[adaptationType] || adaptationInstructions.direct_adapt}

Write a new 300+ word ad copy for the product above, targeting the "${angle}" angle.
Generate a unique 2-4 word concept name for this copy (e.g., "Liver Failure", "Beer Belly Truth", "Grandpa's Secret").

${RESPONSE_FORMAT}`;
}

// ─── 3. Inline Edit Prompt ──────────────────────────────────────────────────
export function buildInlineEditPrompt(selectedText, instruction, fullCopyContext) {
  return `You are editing a specific section of an ad copy. Here is the FULL copy for context:

---
${fullCopyContext}
---

The user has selected this specific text to edit:
"${selectedText}"

USER INSTRUCTION: ${instruction}

Rewrite ONLY the selected text according to the instruction. Keep it consistent with the surrounding copy's tone, voice, and narrative flow. Return ONLY the replacement text — no XML, no explanation, no surrounding copy.`;
}

// ─── 4. Archetype Classification Prompt ─────────────────────────────────────
export function buildArchetypeClassifyPrompt(adCopy) {
  return `Classify this ad copy into image archetypes for visual pairing.

THE FOUR ARCHETYPES:

MIRROR — "That's me right now"
Uncomfortable, honest, candid moment of self-recognition. The reader sees themselves in an unflattering but truthful light.

MYTHIC — "Those men were built different"
Primal awe, physical power, warriors/operators. Aspirational through historical or primal masculine energy.

LEGACY — "It wasn't always this way"
Vintage evidence of natural leanness, historical contrast. Nostalgia-driven, showing a past era where the problem didn't exist.

HORIZON — "That's who I want to become"
Active, present, confident older man as aspirational ideal. Near-future self, achievable transformation.

AD COPY:
---
${adCopy}
---

Analyze the copy's emotional core, pain points, and aspirational direction. Return ONLY valid JSON (no markdown, no code fences):
{
  "primary_archetype": "MIRROR|MYTHIC|LEGACY|HORIZON",
  "secondary_archetype": "MIRROR|MYTHIC|LEGACY|HORIZON",
  "core_emotion": "the dominant emotional state the copy evokes",
  "entry_trigger": "the specific moment/scenario that hooks the reader"
}`;
}

// ─── 5. Concept Name Prompt ─────────────────────────────────────────────────
export function buildConceptNamePrompt(productName, angle) {
  return `Generate a unique, memorable 2-4 word concept name for a direct-response ad.

PRODUCT: ${productName}
ANGLE: ${angle}

The concept name should be:
- Punchy and memorable (2-4 words)
- Evocative of the angle's core pain or promise
- Work as an internal reference name for the creative team
- Examples: "Liver Failure", "Beer Belly Truth", "Grandpa's Secret", "Mirror Moment", "Kitchen Table Fix"

Return ONLY the concept name — no quotes, no explanation, no punctuation.`;
}
