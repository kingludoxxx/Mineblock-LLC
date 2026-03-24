// ─── Archetype Configs ───────────────────────────────────────────────────────

export const ARCHETYPES = {
  MIRROR: {
    label: 'Mirror',
    scrollStopTrigger: "That's me right now",
    description: 'Uncomfortable, honest, candid moment of self-recognition',
    subVariants: ['Beach/Pool', 'Home/Bathroom', 'Social Gathering', 'Gym/Locker Room'],
    systemInstruction: `Photorealistic candid phone photograph. Real skin texture with pores, body hair, moles, uneven tone, sun damage, blemishes. Natural imperfect lighting (harsh midday, unflattering overhead, mixed indoor). Slightly off-center imperfect composition. Lived-in environments with clutter (others' belongings, sand, crumbs, towels, cups). Worn, wrinkled clothing. Slight motion blur on hands/periphery. NEVER: Smooth poreless skin, perfect symmetry, centered compositions, studio/professional lighting, HDR, clean minimalist backgrounds.`,
    realismAnchor: 'Shot handheld on phone, slightly off-center, natural ambient light, realistic skin texture, candid/unstaged',
  },
  MYTHIC: {
    label: 'Mythic',
    scrollStopTrigger: 'Those men were built different',
    description: 'Primal awe, physical power, warriors/operators',
    subVariants: ['Viking/Norse', 'Spartan/Roman/Gladiator', 'Military/Operator', 'Ancestral/Tribal'],
    systemInstruction: `High-budget historical documentary/prestige TV production frame. Cinema camera, real actors, historically accurate props/costumes. Cinematic color grading (desaturated, cool for Nordic/military, warm for Mediterranean). Dramatic natural/practical lighting (overcast, firelight, torchlight, dawn, dusk). Anamorphic lens characteristics (horizontal flare, oval bokeh, compressed background). Production costumes showing WEAR (frayed, mud stains, sweat marks, patches, sun fading). Physical variation (different heights, builds, ages, hair colors, facial hair). Environmental grit (mud, wet stone, salt spray, smoke, ash, rain, sand). NEVER: Video game/fantasy aesthetics, pristine costumes, identical people, digital/painterly, perfect modern gym bodies, glowing effects, centered symmetrical compositions.`,
    realismAnchor: 'Cinematic documentary still, low angle, dramatic natural light, anamorphic lens feel, desaturated cool, film grain',
  },
  LEGACY: {
    label: 'Legacy',
    scrollStopTrigger: "It wasn't always this way",
    description: 'Vintage evidence of natural leanness, historical contrast',
    subVariants: ['1940s-50s Beach', '1960s-70s Working Men', 'Early 1900s Athletic', 'Military Historical'],
    systemInstruction: `Authentic historical photograph from specified era. Period-specific photographic characteristics (grain, tonal range, contrast from era film stocks/cameras). Optical characteristics of period lenses (soft corners, barrel distortion, vignetting, limited sharpness). Authentic physical aging of PRINT (foxing, yellowing, corner creasing, silver mirroring for silver gelatin). Period-appropriate body types, grooming, clothing, posture. Individual variation in groups (different heights, builds, ages). Era-appropriate environments/props (NO modern materials, plastic, synthetics). NEVER: Uniform sepia overlays, digital cracks/stains, modern facial features, identical subjects, modern materials, perfectly even aging, clean sharp detail inconsistent with era tech.`,
    realismAnchor: 'Authentic [era] photograph on [film stock], period-accurate grain/lens, physical print aging [foxing/yellowing/creasing]',
  },
  HORIZON: {
    label: 'Horizon',
    scrollStopTrigger: "That's who I want to become",
    description: 'Active, present, confident older man as aspirational ideal',
    subVariants: ['Lake/Beach Active', 'Outdoor Adventure', 'Family Gathering', 'Quiet Confidence'],
    systemInstruction: `Warm natural photograph captured during genuine family moment by friend with good camera/phone. Warm natural light (golden hour, late afternoon, soft overcast, dappled shade). Film-like color rendering (slightly desaturated greens, warm but not orange tones, muted earthy). Visible grain consistent with film/high-ISO. Rich environmental depth (3+ layers foreground to background with detail in each). Genuine human interaction (real laughter, natural touch, bodies in motion, not posed). Real skin on primary subject (sun spots, arm hair, veins, natural tan lines, age-appropriate weathering). At least one unplanned background element (animal, other people, natural debris). NEVER: Studio portraits/professional lighting, fitness photography, stock photo conventions, muscular/fitness-model bodies, clean empty backgrounds, saturated/HDR processing, commercial photography aesthetics.`,
    realismAnchor: 'Warm natural light, golden hour/hazy, film-like color, soft greens/warm tones, off-center, genuine moment, visible grain',
  },
};

// ─── Hard Reject Terms ───────────────────────────────────────────────────────

export const HARD_REJECT_TERMS = [
  'supplement',
  'capsule',
  'bottle',
  'pill',
  'tablet',
  'liver',
  'kidney',
  'intestine',
  'organ',
  'diagnosis',
  'treatment',
  'prescription',
  'clinical',
  'medical',
  'doctor',
  'physician',
  'before/after',
  'before and after',
  'split composition',
  'dramatic transformation',
  'weight loss',
  'fat loss',
  'ingredient',
  'dosage',
  'side effect',
  'label',
  'packaging',
  'product shot',
];

// ─── Banned Words ────────────────────────────────────────────────────────────

export const BANNED_WORDS = [
  'shockingly',
  'massive',
  'enormous',
  'tiny',
  'incredible',
  'amazingly',
];

// ─── Anti-Patterns ───────────────────────────────────────────────────────────

export const ANTI_PATTERNS = [
  'Product bottles, capsules, or supplements visible in frame',
  'Medical contexts, doctor visits, clinical settings',
  'Before/after framing or split compositions',
  'Staged emotional reactions or exaggerated expressions',
  'Complex multi-subject narratives',
  'Text, labels, or watermarks in the image',
  'Hyperbolic body descriptions (e.g., "like toothpicks")',
  'Emotion or expression prescriptions',
  'Modern gym/fitness model bodies in historical archetypes',
  'Studio or professional lighting in candid archetypes',
  'Stock photo conventions or commercial photography aesthetics',
  'Perfect symmetry or centered compositions',
  'HDR or oversaturated processing',
  'Video game or fantasy aesthetics in mythic archetype',
  'Uniform sepia overlays in legacy archetype',
];

// ─── Prompt Builders ─────────────────────────────────────────────────────────

/**
 * Build the Claude prompt that classifies ad copy into primary/secondary archetypes.
 */
export function buildClassificationPrompt(adCopy) {
  const archetypeDescriptions = Object.entries(ARCHETYPES)
    .map(([key, a]) => `- **${key}** ("${a.scrollStopTrigger}"): ${a.description}`)
    .join('\n');

  return `You are an expert ad creative strategist. Classify the following ad copy into image archetypes for visual content generation.

THE FOUR ARCHETYPES:
${archetypeDescriptions}

AD COPY TO CLASSIFY:
"""
${adCopy}
"""

Analyze the emotional core of this copy and determine which archetype best matches the primary emotional trigger, and which is the strongest secondary.

Respond with ONLY valid JSON (no markdown, no explanation):
{
  "primary_archetype": "MIRROR" | "MYTHIC" | "LEGACY" | "HORIZON",
  "secondary_archetype": "MIRROR" | "MYTHIC" | "LEGACY" | "HORIZON",
  "core_emotion": "<2-3 word emotional state the copy evokes>",
  "entry_trigger": "<specific moment/scenario that pulls the reader in>",
  "era_context": "<specific era if LEGACY relevant, otherwise null>",
  "organic_page_context": "<what kind of organic page/community this copy would blend into>"
}

Rules:
- primary and secondary MUST be different archetypes
- core_emotion should be visceral and specific, not generic
- entry_trigger should reference a concrete real-life moment
- era_context is ONLY for LEGACY archetype relevance, null otherwise
- ZERO product, supplement, or medical context in any field`;
}

/**
 * Build the Claude prompt to generate 4 image concepts for a given archetype.
 */
export function buildConceptPrompt(archetype, adCopy) {
  const config = ARCHETYPES[archetype];
  if (!config) throw new Error(`Unknown archetype: ${archetype}`);

  const subVariantList = config.subVariants.map((s) => `"${s}"`).join(', ');

  return `You are a visual concept director specializing in scroll-stopping social media imagery. Generate 4 image concepts for the "${config.label}" archetype.

ARCHETYPE: ${config.label}
SCROLL-STOP TRIGGER: "${config.scrollStopTrigger}"
DESCRIPTION: ${config.description}
SUB-VARIANTS: ${subVariantList}

AD COPY CONTEXT (for emotional alignment only — NEVER reference product/supplement):
"""
${adCopy}
"""

Generate 4 distinct image concepts. Each concept MUST use a different sub-variant. Each concept must evoke the scroll-stop trigger ("${config.scrollStopTrigger}") without any product, supplement, medical, or before/after elements.

Respond with ONLY valid JSON (no markdown, no explanation):
[
  {
    "description": "<what to show — one clear sentence>",
    "setting": "<physical environment with specific sensory details>",
    "subject": "<who is in the image — age, build, natural details>",
    "curiosity_hook": "<ONE small natural detail that creates intrigue and makes the viewer pause>",
    "sub_variant": "<one of: ${subVariantList}>"
  }
]

ANTI-PATTERNS (never include):
${ANTI_PATTERNS.map((a) => `- ${a}`).join('\n')}

Rules:
- Max ONE primary subject per image
- No product, supplement, ingredient, or medical references
- No text or labels in the image
- Curiosity hook must be a subtle, natural detail — not staged or dramatic
- Each concept must feel like it could be a real photograph someone actually took`;
}

/**
 * Convert a concept + archetype into a 2-4 sentence Gemini-ready image prompt.
 *
 * Structure:
 *   Sentence 1: WHAT the image shows (subject + setting)
 *   Sentence 2: KEY VISUAL DETAIL (curiosity hook)
 *   Sentence 3 (optional): Additional environmental detail
 *   Final clause: REALISM ANCHOR (archetype-specific)
 */
export function buildGeminiPrompt(concept, archetype) {
  const config = ARCHETYPES[archetype];
  if (!config) throw new Error(`Unknown archetype: ${archetype}`);

  const anchor = config.realismAnchor;

  // Sentence 1: subject + setting
  const s1 = `${concept.description} ${concept.setting}`;

  // Sentence 2: curiosity hook
  const s2 = concept.curiosity_hook;

  // Build the prompt — 2-4 sentences ending with realism anchor
  let prompt;
  if (concept.setting && concept.setting.length > 40) {
    // Setting is detailed enough to warrant a separate environmental sentence
    prompt = `${concept.description}. ${concept.setting}. ${s2}. ${anchor}.`;
  } else {
    prompt = `${s1}. ${s2}. ${anchor}.`;
  }

  return prompt;
}

// ─── Validation ──────────────────────────────────────────────────────────────

/**
 * Validate a prompt against hard reject terms and banned words.
 * @returns {{ valid: boolean, reason?: string }}
 */
export function validatePrompt(prompt) {
  const lower = prompt.toLowerCase();

  for (const term of HARD_REJECT_TERMS) {
    if (lower.includes(term.toLowerCase())) {
      return { valid: false, reason: `Contains hard-reject term: "${term}"` };
    }
  }

  for (const word of BANNED_WORDS) {
    if (lower.includes(word.toLowerCase())) {
      return { valid: false, reason: `Contains banned word: "${word}"` };
    }
  }

  // Max 5 sentences
  const sentenceCount = prompt.split(/[.!?]+/).filter((s) => s.trim().length > 0).length;
  if (sentenceCount > 5) {
    return { valid: false, reason: `Prompt has ${sentenceCount} sentences (max 5)` };
  }

  return { valid: true };
}
