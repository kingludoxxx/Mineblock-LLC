import express from 'express';
import { authenticate } from '../middleware/auth.js';

const router = express.Router();

const CLICKUP_TOKEN = process.env.CLICKUP_API_TOKEN || 'pk_266421907_38TVGF16690R1U9EZOZLBK9BJ6J0YPRD';
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
  // Prefer ```json fences, then bare fences
  const jsonFence = cleaned.match(/```json\s*\n?([\s\S]*?)\n?\s*```/);
  if (jsonFence) return jsonFence[1].trim();
  const bareFence = cleaned.match(/```\s*\n?([\s\S]*?)\n?\s*```/);
  if (bareFence) return bareFence[1].trim();
  return cleaned;
}

// Extract top-level JSON objects from a partial JSON array string using brace-depth parsing
function extractJSONObjects(text) {
  const objects = [];
  let depth = 0;
  let objStart = -1;
  let inString = false;
  let escaped = false;

  for (let i = 0; i < text.length; i++) {
    const ch = text[i];

    if (escaped) { escaped = false; continue; }
    if (ch === '\\' && inString) { escaped = true; continue; }
    if (ch === '"') { inString = !inString; continue; }
    if (inString) continue;

    if (ch === '{') {
      if (depth === 0) objStart = i;
      depth++;
    } else if (ch === '}') {
      depth--;
      if (depth === 0 && objStart !== -1) {
        objects.push(text.slice(objStart, i + 1));
        objStart = -1;
      }
    }
  }
  return objects;
}

const MODEL_FAST = 'claude-haiku-4-5-20251001';
const MODEL_QUALITY = 'claude-sonnet-4-20250514';

async function callClaude(prompt, maxTokens = 8192, { fast = false } = {}) {
  const client = await initClient();
  const message = await client.messages.create({
    model: fast ? MODEL_FAST : MODEL_QUALITY,
    max_tokens: maxTokens,
    messages: [{ role: 'user', content: prompt }],
  });
  return message.content[0].text.trim();
}

async function callClaudeStream(prompt, maxTokens = 8192, { fast = false } = {}) {
  const client = await initClient();
  const stream = await client.messages.stream({
    model: fast ? MODEL_FAST : MODEL_QUALITY,
    max_tokens: maxTokens,
    messages: [{ role: 'user', content: prompt }],
  });
  return stream;
}

// SSE helper: stream Claude response, parse JSON array items as they complete, send each as SSE event
async function streamJSONArray(res, prompt, maxTokens, { fast = true, eventName = 'item' } = {}) {
  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('Connection', 'keep-alive');
  res.flushHeaders();

  let fullText = '';
  let sentCount = 0;

  try {
    const stream = await callClaudeStream(prompt, maxTokens, { fast });

    stream.on('text', (text) => {
      fullText += text;

      // Parse complete JSON objects using brace-depth parser
      const cleaned = extractJSON(fullText);
      const objects = extractJSONObjects(cleaned);
      for (let i = sentCount; i < objects.length; i++) {
        try {
          const obj = JSON.parse(objects[i]);
          res.write(`data: ${JSON.stringify(obj)}\n\n`);
          sentCount++;
        } catch {
          // Incomplete object, skip
        }
      }
    });

    await stream.finalMessage();

    // Final pass: use brace-depth parser (resilient to truncated responses)
    const cleaned = extractJSON(fullText);
    const allObjects = extractJSONObjects(cleaned);
    const items = [];
    for (let i = 0; i < allObjects.length; i++) {
      try {
        const obj = JSON.parse(allObjects[i]);
        items.push(obj);
        if (i >= sentCount) {
          res.write(`data: ${JSON.stringify(obj)}\n\n`);
        }
      } catch { /* skip malformed */ }
    }

    res.write(`data: [DONE]\n\n`);
    res.end();
    return items;
  } catch (err) {
    if (res.headersSent) {
      res.write(`data: ${JSON.stringify({ error: err.message })}\n\n`);
      res.end();
    }
    throw err;
  }
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
      .filter((t) => t.name.toLowerCase().includes(query) && (t.status?.status || '').toLowerCase() !== 'edit queue')
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

    const result = await callClaude(prompt, 1024, { fast: true });
    const analysis = safeParseJSON(result);

    res.json({ success: true, analysis });
  } catch (err) {
    console.error('[IterationKing] Analyze error:', err.message);
    res.status(500).json({ success: false, error: err.message });
  }
});

// ── Product profile context builder ───────────────────────────────
function buildProductContext(p) {
  if (!p) return '';
  const lines = [
    p.name             && `Product: ${p.name}`,
    p.big_promise      && `Big Promise: ${p.big_promise}`,
    p.mechanism        && `Unique Mechanism: ${p.mechanism}`,
    p.benefits?.length && `Key Benefits: ${Array.isArray(p.benefits) ? p.benefits.join(', ') : p.benefits}`,
    p.differentiator   && `Differentiator: ${p.differentiator}`,
    p.guarantee        && `Guarantee: ${p.guarantee}`,
    p.customer_avatar  && `Target Customer: ${p.customer_avatar}`,
    p.customer_frustration && `Customer Frustration: ${p.customer_frustration}`,
    p.customer_dream   && `Customer Dream Outcome: ${p.customer_dream}`,
    p.voice            && `Brand Voice/Tone: ${p.voice}`,
    p.angles?.length   && `Proven Angles: ${Array.isArray(p.angles) ? p.angles.map(a => a.name || a).join(', ') : p.angles}`,
    p.pain_points      && `Pain Points: ${p.pain_points}`,
    p.common_objections && `Common Objections: ${p.common_objections}`,
    p.competitive_edge && `Competitive Edge: ${p.competitive_edge}`,
    p.compliance_restrictions && `COMPLIANCE — Never claim: ${p.compliance_restrictions}`,
  ].filter(Boolean);
  return lines.length ? `\nProduct Intelligence:\n${lines.join('\n')}\n` : '';
}

// ── POST /generate-scripts — Generate script iterations (SSE stream) ───────────
router.post('/generate-scripts', authenticate, async (req, res) => {
  try {
    const { script, aggressiveness = 5, similarity = 5, analysis, productProfile } = req.body;
    if (!script) return res.status(400).json({ success: false, error: 'Script is required' });

    const analysisContext = analysis
      ? `\nWinner Analysis:\n- Hook Mechanism: ${analysis.hookMechanism || 'N/A'}\n- Core Angle: ${analysis.coreAngle || 'N/A'}\n- Emotional Trigger: ${analysis.emotionalTrigger || 'N/A'}\n- Structure: ${analysis.narrativeStructure || 'N/A'}\n`
      : '';
    const productContext = buildProductContext(productProfile);

    const prompt = `You are a world-class direct response ad copy iteration engine used by a media buying team to create winning ad variations.

Your task is to generate 10 high-quality iterations of a winning ad script.

STEP 1 — STRUCTURAL ANALYSIS (do this internally, do NOT output it):
Before generating, identify these parts of the original script:
- HOOK: The first 1-3 sentences that grab attention and stop the scroll.
- TRANSITION: How the hook connects to the body (the bridge sentence).
- BODY: The core persuasion, story, or argument.
- CTA: The closing call to action.

STEP 2 — GENERATION RULES:
- Each iteration MUST follow the same structural flow: Hook → Transition → Body → CTA.
- The hook of each iteration must NATURALLY LEAD INTO its own body. The viewer should feel no "seam" between hook and body — they must read as one continuous script.
- Preserve the core angle, persuasion mechanism, and key claims of the original.
- Keep hooks at a similar LENGTH and FORMAT to the original hook (if the original hook is 1 short sentence, don't write a 3-sentence hook).
- The body must deliver on whatever the hook promises or teases. No bait-and-switch.
- Vary the emotional angle, framing, and language across iterations — but NOT the structure or flow.
- Write like a real person talking, not a marketer. No corporate jargon, no "unlock", no "revolutionize", no "game-changer" unless the original uses those exact words.
- Each variation must be materially different from the others in approach, not just synonym swaps.
- Match the aggressiveness and similarity levels specified.
- Use the product intelligence below to ensure claims, benefits, and language are accurate.
${analysisContext}${productContext}
ORIGINAL WINNING SCRIPT:
${script.slice(0, 5000)}

Aggressiveness: ${aggressiveness}/10 (1=soft persuasion, 5=balanced DR, 10=highly aggressive)
Similarity to original: ${similarity}/10 (1=creative exploration, 5=moderate iteration, 10=close to original)

Return ONLY a valid JSON array (no markdown, no backticks, no explanation). Each object must have:
- "id": number (1-10)
- "text": string (full script text — hook and body as one continuous script, no labels or markers)
- "aggressionLevel": number (1-10)
- "toneLabel": string (one of: Curiosity, Authority, UGC Story, Emotional, Direct Response, Minimalist, Shock, Contrarian, Urgency, Social Proof)

Generate exactly 10 variations.`;

    await streamJSONArray(res, prompt, 16384, { fast: false });
  } catch (err) {
    console.error('[IterationKing] Generate scripts error:', err.message);
    if (!res.headersSent) res.status(500).json({ success: false, error: err.message });
  }
});

// ── POST /generate-full-scripts — Generate complete ad scripts (SSE stream) ────
router.post('/generate-full-scripts', authenticate, async (req, res) => {
  try {
    const { script, aggressiveness = 5, similarity = 5, analysis, productProfile } = req.body;
    if (!script) return res.status(400).json({ success: false, error: 'Script is required' });

    const analysisContext = analysis
      ? `\nWinner Analysis:\n- Hook Mechanism: ${analysis.hookMechanism || 'N/A'}\n- Core Angle: ${analysis.coreAngle || 'N/A'}\n- Emotional Trigger: ${analysis.emotionalTrigger || 'N/A'}\n- Structure: ${analysis.narrativeStructure || 'N/A'}\n`
      : '';
    const productContext = buildProductContext(productProfile);

    const prompt = `You are a world-class direct response ad scriptwriter for a media buying team.

Your task is to generate 10 complete, ready-to-use ad scripts based on a winning ad.

STEP 1 — STRUCTURAL ANALYSIS (do this internally, do NOT output it):
Break down the original script:
- HOOK: First 1-3 sentences (the scroll-stopper).
- BODY: The persuasion narrative (story, argument, proof).
- CTA: The closing action.
- TONE: The conversational register (casual/intense/story-driven/etc).
- HOOK→BODY BRIDGE: How the original transitions from hook to body.

STEP 2 — GENERATION RULES:
- Each script is a COMPLETE ad — hook flows naturally into body into CTA as ONE continuous piece.
- The hook must SET UP what the body DELIVERS. If the hook teases a secret, the body must reveal it. If the hook states a problem, the body must address it. No disconnect.
- Keep hooks at a similar length and intensity to the original hook. Don't write a 3-sentence hook if the original uses 1 punchy line.
- Preserve the core angle, persuasion mechanism, and key product claims.
- The body should feel like a natural continuation of the hook — same voice, same energy, same person talking.
- Write like a real human. Match the original's register. If it's casual/UGC-style, stay casual. If it's authoritative, stay authoritative. No corporate marketing speak unless the original uses it.
- Each script must take a genuinely different creative approach — different hooks, different framings, different emotional entry points. NOT just synonym replacements.
- Match aggressiveness and similarity levels.
- Use the product intelligence to keep claims accurate.
${analysisContext}${productContext}
ORIGINAL WINNING SCRIPT:
${script.slice(0, 5000)}

Aggressiveness: ${aggressiveness}/10 (1=soft persuasion, 5=balanced DR, 10=highly aggressive)
Similarity to original: ${similarity}/10 (1=creative exploration, 5=moderate iteration, 10=close to original)

Return ONLY a valid JSON array (no markdown, no backticks, no explanation). Each object must have:
- "id": number (1-10)
- "text": string (complete ad script — one continuous flow, no section labels)
- "aggressionLevel": number (1-10)
- "toneLabel": string (one of: Curiosity, Authority, UGC Story, Emotional, Direct Response, Minimalist, Shock, Contrarian, Urgency, Social Proof)

Generate exactly 10 complete scripts.`;

    await streamJSONArray(res, prompt, 16384, { fast: false });
  } catch (err) {
    console.error('[IterationKing] Generate full scripts error:', err.message);
    if (!res.headersSent) res.status(500).json({ success: false, error: err.message });
  }
});

// ── POST /generate-hooks — Generate hooks for selected body (SSE stream) ───────
router.post('/generate-hooks', authenticate, async (req, res) => {
  try {
    const { body, aggressiveness = 5, productProfile } = req.body;
    if (!body) return res.status(400).json({ success: false, error: 'Body script is required' });
    const productContext = buildProductContext(productProfile);

    const prompt = `You are a world-class direct response hook writer for a media buying team.

Your task is to generate 10 hooks for the ad body below.

CRITICAL — HOOK-BODY CONTINUITY:
Read the body carefully FIRST. Understand:
- What the body is about (the topic, the story, the argument).
- What tone/voice the body uses (casual, authoritative, story-driven, urgent).
- What the body's opening sentences expect to follow from (what setup do they assume?).

Then write hooks that:
1. MATCH the body's tone and voice exactly. If the body is casual UGC-style, the hook must be too. If it's authoritative, the hook must be too.
2. SET UP what the body delivers. The body's first line after the hook must read as a natural continuation — no jarring shift in topic or energy.
3. DO NOT introduce claims, topics, or promises the body doesn't address.
4. Are 1-2 sentences max. Keep them punchy.
5. Each hook takes a genuinely different angle — not just rewording the same idea.
${productContext}
AD BODY (the hook must flow naturally into this):
${body.slice(0, 5000)}

Aggressiveness: ${aggressiveness}/10 (1=soft, 5=balanced, 10=highly aggressive)

Return ONLY a valid JSON array (no markdown, no backticks, no explanation). Each object must have:
- "id": number (1-10)
- "text": string (hook text, 1-2 sentences)
- "strength": number (1-10, predicted hook strength)
- "curiosityTrigger": string ("Low" or "Medium" or "High")
- "clarity": string ("Low" or "Medium" or "High")
- "scrollStopProbability": string ("Weak" or "Moderate" or "Strong")

Generate exactly 10 hooks.`;

    await streamJSONArray(res, prompt, 2048, { fast: false });
  } catch (err) {
    console.error('[IterationKing] Generate hooks error:', err.message);
    if (!res.headersSent) res.status(500).json({ success: false, error: err.message });
  }
});

// ── POST /generate-brief-hooks — Auto-generate 5 hook variations with angles ─
router.post('/generate-brief-hooks', authenticate, async (req, res) => {
  try {
    const { script, aggressiveness = 5, analysis, productProfile } = req.body;
    if (!script) return res.status(400).json({ success: false, error: 'Source script is required' });
    const productContext = buildProductContext(productProfile);

    // Extract the body (everything after HOOKS: section ends, or after BODY: marker)
    const bodyMatch = script.match(/\bBODY:\s*/i);
    const hooksMatch = script.match(/\bHOOKS?:\s*/i);
    let body = script;
    if (bodyMatch) {
      body = script.slice(bodyMatch.index + bodyMatch[0].length).trim();
    } else if (hooksMatch) {
      // If there's a HOOKS section but no BODY marker, skip past hooks to body
      const lines = script.slice(hooksMatch.index).split('\n');
      const bodyStart = lines.findIndex((l, i) => i > 0 && !l.trim().startsWith('-') && !l.trim().startsWith('•') && l.trim().length > 30);
      if (bodyStart > 0) body = lines.slice(bodyStart).join('\n').trim();
    }

    const analysisContext = analysis ? `
Winner Analysis Context:
- Hook mechanism: ${analysis.hookMechanism || 'Unknown'}
- Core angle: ${analysis.coreAngle || 'Unknown'}
- Emotional trigger: ${analysis.emotionalTrigger || 'Unknown'}
- Narrative structure: ${analysis.narrativeStructure || 'Unknown'}
` : '';

    const prompt = `You are a world-class direct response hook writer for a media buying team.

Your task: Generate exactly 5 hooks for this ad body. Each hook uses a DIFFERENT angle/style.

STEP 1 — READ THE BODY FIRST (do NOT output this analysis):
- What is the body about? What story/argument does it make?
- What tone does it use? (casual, authoritative, story-driven, etc.)
- What does the body's first sentence assume comes before it?

STEP 2 — GENERATE HOOKS USING THESE ANGLES (one per hook):
1. SHOCK — Pattern interrupt. Something unexpected or hard to believe that relates to what the body actually discusses.
2. CURIOSITY — Open a loop the viewer MUST close. Tease the body's key revelation without giving it away.
3. AUTHORITY — Lead with credibility or proof that sets up the body's claims.
4. CONTRARIAN — Challenge conventional wisdom in a way the body then supports.
5. SOCIAL PROOF — Lead with results or social validation that the body elaborates on.

HOOK-BODY CONTINUITY (CRITICAL):
- Each hook must flow DIRECTLY into the body's first line with zero friction. Read hook + body together — they must sound like one person talking.
- Match the body's tone exactly. If the body is casual/UGC, the hook must be casual. If authoritative, stay authoritative.
- DO NOT introduce claims, topics, or promises the body doesn't address.
- Hooks are 1-2 sentences MAX. Keep them punchy and natural.
${analysisContext}${productContext}
AD BODY (hooks must flow naturally into this):
${body.slice(0, 5000)}

Aggressiveness: ${aggressiveness}/10 (1=soft conversational, 5=balanced direct response, 10=extremely aggressive/urgent)

Return ONLY a valid JSON array. Each object:
- "id": number (1-5)
- "angle": string (exactly one of: "Shock", "Curiosity", "Authority", "Contrarian", "Social Proof")
- "text": string (the hook text — 1-2 sentences max)
- "strength": number (1-10, predicted scroll-stop strength)
- "rationale": string (1 sentence explaining why this hook works for this body)
- "scrollStopProbability": string ("Weak" or "Moderate" or "Strong")

Generate exactly 5 hooks.`;

    await streamJSONArray(res, prompt, 2048, { fast: false });
  } catch (err) {
    console.error('[IterationKing] Generate brief hooks error:', err.message);
    if (!res.headersSent) res.status(500).json({ success: false, error: err.message });
  }
});

export default router;
