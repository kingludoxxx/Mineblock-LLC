import express from 'express';
import { authenticate } from '../middleware/auth.js';

const router = express.Router();

const CLICKUP_TOKEN = 'pk_266421907_38TVGF16690R1U9EZOZLBK9BJ6J0YPRD';
const VIDEO_ADS_LIST_ID = '901518716584';
const CLICKUP_API = 'https://api.clickup.com/api/v2';

const clickupHeaders = {
  Authorization: CLICKUP_TOKEN,
  'Content-Type': 'application/json',
};

async function clickupFetch(url, options = {}) {
  const res = await fetch(url, { ...options, headers: clickupHeaders });
  if (!res.ok) {
    const text = await res.text();
    throw new Error(`ClickUp API error ${res.status}: ${text}`);
  }
  return res.json();
}

// ── Cached Anthropic client ───────────────────────────────────────
let anthropicClient = null;

function getAnthropicClient() {
  if (anthropicClient) return anthropicClient;
  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) throw new Error('ANTHROPIC_API_KEY not configured');
  // Dynamic import is needed for ESM compatibility, but we cache the result
  return null; // Will be set by initClient
}

async function initClient() {
  if (anthropicClient) return anthropicClient;
  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) throw new Error('ANTHROPIC_API_KEY not configured');
  const { default: Anthropic } = await import('@anthropic-ai/sdk');
  anthropicClient = new Anthropic({ apiKey });
  return anthropicClient;
}

// Strip markdown fences and extract pure JSON from Claude output
function extractJSON(text) {
  let cleaned = text.trim();
  // Remove ```json ... ``` or ``` ... ``` wrappers
  const fenceMatch = cleaned.match(/```(?:json)?\s*\n?([\s\S]*?)\n?\s*```/);
  if (fenceMatch) cleaned = fenceMatch[1].trim();
  return cleaned;
}

async function callClaude(prompt, maxTokens = 8192) {
  const client = await initClient();
  const message = await client.messages.create({
    model: 'claude-sonnet-4-20250514',
    max_tokens: maxTokens,
    messages: [{ role: 'user', content: prompt }],
  });
  return message.content[0].text.trim();
}

function safeParseJSON(text) {
  const cleaned = extractJSON(text);
  try {
    return JSON.parse(cleaned);
  } catch (e) {
    throw new Error(`Failed to parse AI response as JSON: ${e.message}\nRaw output: ${cleaned.slice(0, 200)}`);
  }
}

// ── Task search cache (5 minute TTL) ──────────────────────────────
let taskCache = { data: null, timestamp: 0 };
const CACHE_TTL = 5 * 60 * 1000;

async function getAllTasks() {
  if (taskCache.data && Date.now() - taskCache.timestamp < CACHE_TTL) {
    return taskCache.data;
  }

  let allTasks = [];
  let page = 0;
  let hasMore = true;

  while (hasMore && page < 15) {
    const data = await clickupFetch(
      `${CLICKUP_API}/list/${VIDEO_ADS_LIST_ID}/task?page=${page}&limit=100&include_closed=true&subtasks=true`,
    );
    const tasks = data.tasks || [];
    allTasks = allTasks.concat(tasks);
    hasMore = tasks.length === 100;
    page++;
  }

  taskCache = { data: allTasks, timestamp: Date.now() };
  return allTasks;
}

// ── GET /search?q=keyword — Search ClickUp briefs ─────────────────
router.get('/search', authenticate, async (req, res) => {
  try {
    const { q } = req.query;
    if (!q || q.length < 2) {
      return res.status(400).json({ success: false, error: 'Search query too short' });
    }

    const allTasks = await getAllTasks();
    const query = q.toLowerCase();
    const matches = allTasks
      .filter((t) => t.name.toLowerCase().includes(query))
      .slice(0, 25)
      .map((t) => ({
        id: t.id,
        name: t.name,
        status: t.status?.status || 'unknown',
        url: t.url,
      }));

    res.json({ success: true, results: matches });
  } catch (err) {
    console.error('[IterationKing] Search error:', err.message);
    res.status(500).json({ success: false, error: err.message });
  }
});

// ── GET /brief/:taskId — Get full brief details ───────────────────
router.get('/brief/:taskId', authenticate, async (req, res) => {
  try {
    const { taskId } = req.params;
    const task = await clickupFetch(`${CLICKUP_API}/task/${taskId}`);

    res.json({
      success: true,
      brief: {
        id: task.id,
        name: task.name,
        description: task.description || '',
        status: task.status?.status || 'unknown',
        url: task.url,
      },
    });
  } catch (err) {
    console.error('[IterationKing] Brief fetch error:', err.message);
    res.status(500).json({ success: false, error: err.message });
  }
});

// ── POST /analyze — Analyze winning pattern ───────────────────────
router.post('/analyze', authenticate, async (req, res) => {
  try {
    const { script } = req.body;
    if (!script || script.length < 10) {
      return res.status(400).json({ success: false, error: 'Script is required (minimum 10 characters)' });
    }

    const prompt = `You are an expert direct-response ad analyst. Analyze this winning ad script and identify why it works.

Script:
${script.slice(0, 5000)}

Return ONLY valid JSON with this exact structure (no markdown, no explanation, no backticks):
{
  "hookMechanism": "string - the hook mechanism used (e.g. Curiosity, Authority, Shock, Story, Contrarian, Lottery Analogy)",
  "coreAngle": "string - the core persuasion angle",
  "emotionalTrigger": "string - the primary emotional trigger",
  "narrativeStructure": "string - brief structure description (e.g. Hook > Curiosity > Explanation > Reward > CTA)",
  "pacingPattern": "string - description of pacing (e.g. Fast open, slow build, urgent close)",
  "ctaStructure": "string - how the call to action is structured",
  "overallStrength": 8,
  "summary": "string - 1-2 sentence summary of why this script wins"
}`;

    const result = await callClaude(prompt, 1024);
    const analysis = safeParseJSON(result);

    res.json({ success: true, analysis });
  } catch (err) {
    console.error('[IterationKing] Analyze error:', err.message);
    res.status(500).json({ success: false, error: err.message });
  }
});

// ── POST /generate-scripts — Generate script iterations ───────────
router.post('/generate-scripts', authenticate, async (req, res) => {
  try {
    const { script, aggressiveness = 5, similarity = 5, analysis } = req.body;
    if (!script) return res.status(400).json({ success: false, error: 'Script is required' });

    const analysisContext = analysis
      ? `\nWinner Analysis:\n- Hook Mechanism: ${analysis.hookMechanism}\n- Core Angle: ${analysis.coreAngle}\n- Emotional Trigger: ${analysis.emotionalTrigger}\n- Structure: ${analysis.narrativeStructure}\n`
      : '';

    const prompt = `You are a world-class direct response ad copy iteration engine.

Your task is to generate 10 high-quality iterations of a winning ad script.

Rules:
- Preserve the core angle and persuasion mechanism.
- Do not generate random rewrites.
- These must feel like performance-focused iterations of a proven ad.
- Vary language, pacing, emotional tension and framing.
- Avoid robotic language or generic marketing copy.
- Maintain direct-response energy.
- Each variation must be materially different from the others.
- Match the aggressiveness level specified.
- Match the similarity-to-original level specified.
${analysisContext}
Input script:
${script.slice(0, 5000)}

Aggressiveness: ${aggressiveness}/10 (1=soft persuasion, 5=balanced DR, 10=highly aggressive)
Similarity to original: ${similarity}/10 (1=creative exploration, 5=moderate iteration, 10=close to original)

Return ONLY a valid JSON array (no markdown, no backticks, no explanation). Each object must have:
- "id": number (1-10)
- "text": string (full script text)
- "aggressionLevel": number (1-10)
- "toneLabel": string (one of: Curiosity, Authority, UGC Story, Emotional, Direct Response, Minimalist, Shock, Contrarian, Urgency, Social Proof)

Generate exactly 10 variations.`;

    const result = await callClaude(prompt, 12000);
    const scripts = safeParseJSON(result);

    res.json({ success: true, scripts: Array.isArray(scripts) ? scripts : [] });
  } catch (err) {
    console.error('[IterationKing] Generate scripts error:', err.message);
    res.status(500).json({ success: false, error: err.message });
  }
});

// ── POST /generate-full-scripts — Generate complete ad scripts ────
router.post('/generate-full-scripts', authenticate, async (req, res) => {
  try {
    const { script, aggressiveness = 5, similarity = 5, analysis } = req.body;
    if (!script) return res.status(400).json({ success: false, error: 'Script is required' });

    const analysisContext = analysis
      ? `\nWinner Analysis:\n- Hook Mechanism: ${analysis.hookMechanism}\n- Core Angle: ${analysis.coreAngle}\n- Emotional Trigger: ${analysis.emotionalTrigger}\n- Structure: ${analysis.narrativeStructure}\n`
      : '';

    const prompt = `You are a world-class direct response ad scriptwriter.

Your task is to generate 10 complete ad scripts (hooks + body combined) based on a winning ad.

This mode generates full ready-to-use ad scripts. Each script should include its own unique hook seamlessly integrated with the body.

Rules:
- Each script is a complete ad — hook and body together.
- Preserve the core angle and persuasion mechanism of the original.
- Vary hooks, framing, language, pacing, and emotional tension.
- Avoid robotic language or generic marketing copy.
- Maintain direct-response energy.
- Each script must be materially different.
${analysisContext}
Original winning script:
${script.slice(0, 5000)}

Aggressiveness: ${aggressiveness}/10 (1=soft persuasion, 5=balanced DR, 10=highly aggressive)
Similarity to original: ${similarity}/10 (1=creative exploration, 5=moderate iteration, 10=close to original)

Return ONLY a valid JSON array (no markdown, no backticks, no explanation). Each object must have:
- "id": number (1-10)
- "text": string (complete ad script with hook and body)
- "aggressionLevel": number (1-10)
- "toneLabel": string (one of: Curiosity, Authority, UGC Story, Emotional, Direct Response, Minimalist, Shock, Contrarian, Urgency, Social Proof)

Generate exactly 10 complete scripts.`;

    const result = await callClaude(prompt, 12000);
    const scripts = safeParseJSON(result);

    res.json({ success: true, scripts: Array.isArray(scripts) ? scripts : [] });
  } catch (err) {
    console.error('[IterationKing] Generate full scripts error:', err.message);
    res.status(500).json({ success: false, error: err.message });
  }
});

// ── POST /generate-hooks — Generate hooks for selected body ───────
router.post('/generate-hooks', authenticate, async (req, res) => {
  try {
    const { body, aggressiveness = 5 } = req.body;
    if (!body) return res.status(400).json({ success: false, error: 'Body script is required' });

    const prompt = `You are a world-class direct response hook writer.

Your task is to generate 10 hooks for the ad body below.

Rules:
- Hooks are the first 1-2 phrases of the ad.
- From phrase 3 onward the body must remain natural.
- Hooks must blend seamlessly with the body.
- Hooks must not introduce claims the body does not support.
- Hooks must increase scroll-stopping power while preserving continuity.
- Hooks must not create tone mismatch with the body.
- Each hook must be materially different from the others.

Body:
${body.slice(0, 5000)}

Aggressiveness: ${aggressiveness}/10 (1=soft, 5=balanced, 10=highly aggressive)

Return ONLY a valid JSON array (no markdown, no backticks, no explanation). Each object must have:
- "id": number (1-10)
- "text": string (hook text, 1-2 phrases)
- "strength": number (1-10, predicted hook strength)
- "curiosityTrigger": string ("Low" or "Medium" or "High")
- "clarity": string ("Low" or "Medium" or "High")
- "scrollStopProbability": string ("Weak" or "Moderate" or "Strong")

Generate exactly 10 hooks.`;

    const result = await callClaude(prompt, 4096);
    const hooks = safeParseJSON(result);

    // Validate and normalize hook fields
    const normalizedHooks = (Array.isArray(hooks) ? hooks : []).map((h, i) => ({
      id: h.id || i + 1,
      text: h.text || '',
      strength: typeof h.strength === 'number' ? h.strength : parseFloat(h.strength) || 5,
      curiosityTrigger: ['Low', 'Medium', 'High'].includes(h.curiosityTrigger) ? h.curiosityTrigger : 'Medium',
      clarity: ['Low', 'Medium', 'High'].includes(h.clarity) ? h.clarity : 'Medium',
      scrollStopProbability: ['Weak', 'Moderate', 'Strong'].includes(h.scrollStopProbability)
        ? h.scrollStopProbability
        : 'Moderate',
    }));

    res.json({ success: true, hooks: normalizedHooks });
  } catch (err) {
    console.error('[IterationKing] Generate hooks error:', err.message);
    res.status(500).json({ success: false, error: err.message });
  }
});

export default router;
