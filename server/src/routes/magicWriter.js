import express from 'express';

const router = express.Router();

// ---------------------------------------------------------------------------
// Mock data fallbacks
// ---------------------------------------------------------------------------

function buildProductContext(profile) {
  return [
    `Product: ${profile.productName}`,
    `Benefits: ${profile.benefits}`,
    `Target Audience: ${profile.targetAudience}`,
    `Unique Mechanism: ${profile.uniqueMechanism}`,
    `Power Phrases: ${profile.powerPhrases}`,
  ].join('\n');
}

function generateMockCompetitor(script, profile) {
  return [
    {
      id: 1,
      text: `[Competitor Rephrase]\n\n${script
        .split('\n')
        .map((line) =>
          line.trim()
            ? line
                .replace(/\b[A-Z][a-z]+(?:\s[A-Z][a-z]+)*\b/, profile.productName)
            : line
        )
        .join('\n')}\n\n— Powered by ${profile.productName} | ${profile.uniqueMechanism}`,
    },
  ];
}

function generateMockVariants(script, profile, count) {
  const angles = ['curiosity', 'fear-of-missing-out', 'social proof', 'authority', 'urgency'];
  return Array.from({ length: count }, (_, i) => ({
    id: i + 1,
    text: `[Variant ${i + 1} — ${angles[i % angles.length]} angle]\n\nAttention ${profile.targetAudience}!\n\n${profile.benefits}\n\nIntroducing ${profile.productName} — powered by ${profile.uniqueMechanism}.\n\n${script.slice(0, 200)}…\n\n${profile.powerPhrases}\n\n→ [Get ${profile.productName} Now]`,
  }));
}

function generateMockHooks(selectedVariant, profile, count) {
  const hookAngles = ['curiosity', 'fear', 'social proof', 'authority', 'urgency'];
  return Array.from({ length: count }, (_, i) => ({
    id: i + 1,
    text: `[Hook ${i + 1} — ${hookAngles[i % hookAngles.length]}]\n\n${
      i === 0
        ? `What if everything you knew about ${profile.targetAudience.toLowerCase()} solutions was wrong?`
        : i === 1
          ? `WARNING: If you're still ignoring ${profile.uniqueMechanism}, you're leaving money on the table.`
          : i === 2
            ? `Over 10,000 ${profile.targetAudience.toLowerCase()} have already switched to ${profile.productName}.`
            : i === 3
              ? `Leading experts agree: ${profile.uniqueMechanism} changes everything.`
              : `This offer won't last. ${profile.powerPhrases}`
    }\n\n${selectedVariant.slice(selectedVariant.indexOf('\n\n') + 2)}`,
  }));
}

// ---------------------------------------------------------------------------
// AI generation helpers
// ---------------------------------------------------------------------------

async function callAnthropic(systemPrompt, userPrompt, maxTokens = 4096) {
  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) return null;

  try {
    const { default: Anthropic } = await import('@anthropic-ai/sdk');
    const client = new Anthropic({ apiKey });

    const message = await client.messages.create({
      model: 'claude-sonnet-4-20250514',
      max_tokens: maxTokens,
      messages: [
        {
          role: 'user',
          content: `${systemPrompt}\n\n${userPrompt}`,
        },
      ],
    });

    const text = message.content[0].text.trim();
    // Strip markdown fences if the model wraps them
    const cleaned = text.replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/i, '');
    return JSON.parse(cleaned);
  } catch (err) {
    console.error('[MagicWriter] AI error:', err.message);
    return null;
  }
}

async function generateWithAI(mode, script, productProfile, variantCount) {
  const context = buildProductContext(productProfile);

  if (mode === 'competitor') {
    const system = `You are an expert direct-response copywriter. Rephrase this competitor script keeping EXACTLY the same structure, flow, format, hooks, and persuasion techniques. Adapt the content for our product using the provided product profile. Include the product context: benefits, unique mechanism, target audience, power phrases. Return a single rewritten script.`;

    const user = `Competitor Script:
${script}

Product Profile:
${context}

Return ONLY a JSON array with one object: [{"id": 1, "text": "...the rewritten script..."}]. No markdown, no explanation, just valid JSON.`;

    return callAnthropic(system, user);
  }

  // variations mode
  const system = `You are an expert direct-response copywriter. Create ${variantCount} distinct variations of this winning script. Each variation should have a different angle, hook, or emotional trigger. Maintain the same general length and persuasion quality. Use the product profile context to enrich each variation.`;

  const user = `Winning Script:
${script}

Product Profile:
${context}

Return ONLY a JSON array of ${variantCount} objects with "id" (number) and "text" (string) fields. No markdown, no explanation, just valid JSON.`;

  return callAnthropic(system, user);
}

async function generateHooksWithAI(selectedVariant, productProfile, hookCount) {
  const context = buildProductContext(productProfile);

  const system = `You are an expert direct-response copywriter. Generate ${hookCount} new hooks (opening lines/paragraphs) that blend perfectly with the body of the selected script. Each hook should use a different angle: curiosity, fear, social proof, authority, urgency. The hook should flow naturally into the body of the script. Use the product profile context, especially the power phrases and unique mechanism.`;

  const user = `Selected Script:
${selectedVariant}

Product Profile:
${context}

Return ONLY a JSON array of ${hookCount} objects with "id" (number) and "text" (string) fields. Each "text" should be the full script with the new hook replacing the original opening. No markdown, no explanation, just valid JSON.`;

  return callAnthropic(system, user);
}

// ---------------------------------------------------------------------------
// Routes
// ---------------------------------------------------------------------------

// POST /api/v1/magic-writer/generate
router.post('/generate', async (req, res) => {
  try {
    const { mode, script, productProfile, variantCount = 5 } = req.body;

    if (!mode || !script || !productProfile) {
      return res.status(400).json({
        success: false,
        error: { message: 'mode, script, and productProfile are required.' },
      });
    }

    if (!['competitor', 'variations'].includes(mode)) {
      return res.status(400).json({
        success: false,
        error: { message: 'mode must be "competitor" or "variations".' },
      });
    }

    const { productName, benefits, targetAudience, uniqueMechanism, powerPhrases } =
      productProfile;
    if (!productName || !benefits || !targetAudience || !uniqueMechanism || !powerPhrases) {
      return res.status(400).json({
        success: false,
        error: {
          message:
            'productProfile must include productName, benefits, targetAudience, uniqueMechanism, and powerPhrases.',
        },
      });
    }

    // Try AI first, fall back to mock
    const aiResult = await generateWithAI(mode, script, productProfile, variantCount);
    const variants =
      aiResult ||
      (mode === 'competitor'
        ? generateMockCompetitor(script, productProfile)
        : generateMockVariants(script, productProfile, variantCount));
    const source = aiResult ? 'claude-sonnet-4' : 'mock';

    res.json({ success: true, variants, source });
  } catch (err) {
    console.error('[MagicWriter] /generate error:', err.message);
    res.status(500).json({
      success: false,
      error: { message: 'Failed to generate copy.' },
    });
  }
});

// POST /api/v1/magic-writer/generate-hooks
router.post('/generate-hooks', async (req, res) => {
  try {
    const { selectedVariant, productProfile, hookCount = 5 } = req.body;

    if (!selectedVariant || !productProfile) {
      return res.status(400).json({
        success: false,
        error: { message: 'selectedVariant and productProfile are required.' },
      });
    }

    const { productName, benefits, targetAudience, uniqueMechanism, powerPhrases } =
      productProfile;
    if (!productName || !benefits || !targetAudience || !uniqueMechanism || !powerPhrases) {
      return res.status(400).json({
        success: false,
        error: {
          message:
            'productProfile must include productName, benefits, targetAudience, uniqueMechanism, and powerPhrases.',
        },
      });
    }

    // Try AI first, fall back to mock
    const aiResult = await generateHooksWithAI(selectedVariant, productProfile, hookCount);
    const hooks = aiResult || generateMockHooks(selectedVariant, productProfile, hookCount);
    const source = aiResult ? 'claude-sonnet-4' : 'mock';

    res.json({ success: true, hooks, source });
  } catch (err) {
    console.error('[MagicWriter] /generate-hooks error:', err.message);
    res.status(500).json({
      success: false,
      error: { message: 'Failed to generate hooks.' },
    });
  }
});

export default router;
