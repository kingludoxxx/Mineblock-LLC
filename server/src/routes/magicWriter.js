import express from 'express';

const router = express.Router();

// Mock copy generation
function generateMockVariants(body) {
  const { productName, targetAudience, mode, variantCount = 3, aggressiveness = 5 } = body;
  const count = mode === 'clone' ? 1 : variantCount;

  const urgencyLevel =
    aggressiveness <= 3 ? 'gentle' : aggressiveness <= 6 ? 'moderate' : 'aggressive';

  const urgencyPhrases = {
    gentle: 'Take your time to explore what works best for you.',
    moderate: 'Join thousands who have already made the switch.',
    aggressive: 'WARNING: This offer expires TONIGHT. Act NOW or miss out forever!',
  };

  return Array.from({ length: count }, (_, i) => ({
    id: i + 1,
    text: `[Variant ${i + 1}] Attention ${targetAudience}!\n\nAre you tired of solutions that just don't work? It's not your fault. The industry has been selling you the wrong approach for years.\n\nIntroducing ${productName} — built on a completely different mechanism that gets to the root of the problem.\n\nHere's why ${productName} is different:\n\n• Proprietary method that addresses the REAL cause\n• Backed by real results from people just like you\n• Designed specifically for ${targetAudience}\n• Zero risk — full money-back guarantee\n\n${urgencyPhrases[urgencyLevel]}\n\n→ [Get ${productName} Now]`,
  }));
}

// Try to use Anthropic API, fall back to mock
async function generateWithAI(body) {
  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) return null;

  try {
    const { default: Anthropic } = await import('@anthropic-ai/sdk');
    const client = new Anthropic({ apiKey });

    const { referenceText, productName, targetAudience, mode, variantCount = 3, aggressiveness = 5 } = body;
    const count = mode === 'clone' ? 1 : variantCount;

    const modeInstruction =
      mode === 'clone'
        ? 'Create a 1:1 structural clone of the reference copy, maintaining the same flow, hooks, and persuasion techniques, but rewritten for the given product and audience.'
        : `Generate ${count} distinct variant(s) of marketing copy inspired by the reference content, each with a different angle or hook.`;

    const message = await client.messages.create({
      model: 'claude-sonnet-4-20250514',
      max_tokens: 4096,
      messages: [
        {
          role: 'user',
          content: `You are an expert direct-response copywriter. ${modeInstruction}

Reference Content:
${referenceText}

Product: ${productName}
Target Audience: ${targetAudience}
Conversion Aggressiveness (1=subtle, 10=hard sell): ${aggressiveness}

Return ONLY a JSON array of objects with "id" (number) and "text" (string) fields. No markdown, no explanation, just valid JSON.`,
        },
      ],
    });

    const text = message.content[0].text.trim();
    const parsed = JSON.parse(text);
    return Array.isArray(parsed) ? parsed : null;
  } catch (err) {
    console.error('[MagicWriter] AI generate error:', err.message);
    return null;
  }
}

async function enhanceWithAI(field, value) {
  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) return null;

  try {
    const { default: Anthropic } = await import('@anthropic-ai/sdk');
    const client = new Anthropic({ apiKey });

    const prompt =
      field === 'productName'
        ? `Enhance this product name to be more compelling and marketable. Keep it concise (under 10 words). Original: "${value}". Return ONLY the enhanced name, nothing else.`
        : `Expand this target audience description to be more specific and actionable for copywriting. Keep it to 1-2 sentences. Original: "${value}". Return ONLY the enhanced description, nothing else.`;

    const message = await client.messages.create({
      model: 'claude-sonnet-4-20250514',
      max_tokens: 200,
      messages: [{ role: 'user', content: prompt }],
    });

    return message.content[0].text.trim();
  } catch (err) {
    console.error('[MagicWriter] AI enhance error:', err.message);
    return null;
  }
}

// POST /api/v1/magic-writer/generate
router.post('/generate', async (req, res) => {
  try {
    const { referenceText, productName, targetAudience } = req.body;

    if (!referenceText || !productName || !targetAudience) {
      return res.status(400).json({
        success: false,
        error: { message: 'referenceText, productName, and targetAudience are required.' },
      });
    }

    // Try AI first, fall back to mock
    const aiResult = await generateWithAI(req.body);
    const variants = aiResult || generateMockVariants(req.body);
    const source = aiResult ? 'claude-sonnet-4.6' : 'mock';

    res.json({ success: true, variants, source });
  } catch (err) {
    res.status(500).json({
      success: false,
      error: { message: 'Failed to generate copy.' },
    });
  }
});

// POST /api/v1/magic-writer/enhance
router.post('/enhance', async (req, res) => {
  try {
    const { field, value } = req.body;

    if (!field || !value) {
      return res.status(400).json({
        success: false,
        error: { message: 'field and value are required.' },
      });
    }

    const aiResult = await enhanceWithAI(field, value);

    const enhanced =
      aiResult ||
      (field === 'productName'
        ? `${value} - Premium Edition`
        : `${value} who are frustrated with existing solutions and ready to invest in real change`);

    res.json({ success: true, enhanced });
  } catch (err) {
    res.status(500).json({
      success: false,
      error: { message: 'Failed to enhance field.' },
    });
  }
});

export default router;
