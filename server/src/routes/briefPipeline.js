import { Router } from 'express';
import { authenticate } from '../middleware/auth.js';
import { pgQuery } from '../db/pg.js';
import crypto from 'crypto';

const router = Router();

// ── Config ────────────────────────────────────────────────────────────
const CLICKUP_TOKEN = 'pk_266421907_38TVGF16690R1U9EZOZLBK9BJ6J0YPRD';
const VIDEO_ADS_LIST = '901518716584';
const MEDIA_BUYING_LIST = '901518769621';
const CLICKUP_API = 'https://api.clickup.com/api/v2';
const ANTHROPIC_API_KEY = process.env.ANTHROPIC_API_KEY || '';
const CLAUDE_API_URL = 'https://api.anthropic.com/v1/messages';
const CLAUDE_MODEL = 'claude-sonnet-4-6';

const headers = {
  Authorization: CLICKUP_TOKEN,
  'Content-Type': 'application/json',
};

// ── ClickUp Field IDs ─────────────────────────────────────────────────
const FIELD_IDS = {
  briefNumber: '62b61cc4-2d35-4dfc-86f4-a3913e2bbca3',
  briefType: '98d04d2d-9575-4363-8eee-9bf150b1c319',
  parentBriefId: '4f72235e-0a41-4824-9e67-d27e38ba16d9',
  idea: '0c5460ee-2645-4892-815d-7913fb5d241d',
  angle: '7e740c52-a05b-4b3b-9798-0801acd84b8a',
  creativeType: 'b7f50dff-c752-47a7-830d-c3780021a27f',
  editor: 'a9613cd9-715a-4a2a-bbbb-fbb7f664980a',
  creationWeek: 'a609d8d0-661e-400f-87cb-2557bd48857b',
  creativeStrategist: '372d59af-e573-4eb4-be9f-31cb02f3ad5b',
  copywriter: '3a55a5ef-6ed7-4cd3-b8ad-10ad2eeec472',
  product: '7bc3b414-363e-421e-9445-473b4b8ccf18',
  avatar: '4ad59f88-89cc-45e5-bc56-0027a4ab8624',
  creator: 'be5a2a58-f355-4fac-8263-2824725eaa64',
  namingConvention: 'c97d93bc-ad82-4b90-98e0-092df383d9b8',
  adsFrameLink: 'd90f9f25-d7a0-4eb4-9ded-aca0b4519a3b',
};

// ── Dropdown Option IDs ───────────────────────────────────────────────
const ANGLE_OPTIONS = {
  NA: '2933a618-a7aa-4b42-9e61-c5ee9e0903e5',
  Lottery: '4a493db2-441e-46db-9c58-7b7c3fd0a163',
  Againstcompetition: '0efc2411-1a1a-4d1d-96c6-760e6cff503e',
  'BTC Made easy': '4a1ef4f4-d3e1-4dd3-90a5-b2bd9303d423',
  GTRS: 'c1c56755-f2e4-410d-9f5f-9b3e048c1b36',
  livestream: 'c5e44df4-d814-41dc-acf2-58ab90a2726c',
  Hiddenopportunity: '068ce448-b78e-4b4e-b531-180c422daaa4',
  Rebranding: '1c4f33a4-1034-4101-93ca-93842ca7dc92',
  Missedopportunity: '74f4e8a6-d831-454f-9b39-f15026765a6e',
  BTCFARM: '666601ea-21c1-4685-b1c0-7a951f84dc5f',
  Sale: 'f6cca7fe-4626-4592-90a5-f30efb7a62ba',
  Scarcity: 'e15fc1b9-d90b-4e1b-a4d8-04553e3b8d15',
  Breakingnews: 'e5cd049f-13a5-45e4-a8d7-6b78f0acc9a3',
  Offer: 'e0c1d0fd-b376-4146-8887-ad7c0c209489',
  Reaction: 'bbe5f0c0-8bbf-45a2-bc04-fbcebb11e242',
};

const BRIEF_TYPE_OPTIONS = {
  NN: '1e274045-a4b3-4b0d-85c2-d7ec1a347d3c',
  IT: 'e0999d3c-faab-4d4e-8336-a6272dab8393',
};

const CREATIVE_TYPE_OPTIONS = {
  Mashup: 'a72f1eeb-b245-4a4a-8982-271b52f2650f',
  ShortVid: '02526d2e-ff4f-43db-a586-daf937f6ba86',
  UGC: '95b8cafc-8b15-4a22-be53-7e7398d49d6f',
  VSL: 'ba975681-cebb-416c-8b1f-0880a9cd9e56',
  'Mini VSL': 'e5efc26b-a8bc-4306-9ede-cec47d37ce32',
  'Long VSL': '3cdf6abf-a162-4e81-b32c-e30ae3c7d4ba',
  Cartoon: '3edf3ba9-2518-4699-808d-364ed6831383',
};

const CREATIVE_TYPE_CODES = {
  Mashup: 'HX',
  ShortVid: 'VX',
  UGC: 'UX',
  VSL: 'VL',
  'Mini VSL': 'MV',
  'Long VSL': 'LV',
  Cartoon: 'CT',
};

// ── Relationship Task IDs ─────────────────────────────────────────────
const PRODUCT_TASK_IDS = {
  MR: '86c75fure',
  TX: '86c7jxxtj',
};

const AVATAR_TASK_IDS = {
  Cryptoaddict: '86c7hf58v',
  MoneySeeker: '86c7m5417',
  'Test Avatar': '86c75fyjh',
  Aware: '86c8jhvfk',
  NA: null,
};

const CREATOR_NA_TASK_ID = '86c7n9cvr';

const USER_IDS = {
  Ludovico: 266421907,
  Antoni: 94595626,
  Faiz: 170558610,
  Uly: 106674594,
};

// ── Table Initialization ──────────────────────────────────────────────
let tablesReady = false;

async function ensureTables() {
  if (tablesReady) return;
  try {
    await pgQuery(`
      CREATE TABLE IF NOT EXISTS brief_pipeline_winners (
        id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        creative_id TEXT NOT NULL,
        ad_name TEXT,
        product_code TEXT DEFAULT 'MR',
        angle TEXT,
        format TEXT,
        avatar TEXT,
        editor TEXT,
        hook_type TEXT,
        week TEXT,
        spend NUMERIC(12,2) DEFAULT 0,
        revenue NUMERIC(12,2) DEFAULT 0,
        roas NUMERIC(8,2) DEFAULT 0,
        purchases INTEGER DEFAULT 0,
        cpa NUMERIC(10,2) DEFAULT 0,
        ctr NUMERIC(8,2) DEFAULT 0,
        impressions BIGINT DEFAULT 0,
        clicks BIGINT DEFAULT 0,
        cpm NUMERIC(10,2) DEFAULT 0,
        aov NUMERIC(10,2) DEFAULT 0,
        clickup_task_id TEXT,
        existing_iterations INTEGER DEFAULT 0,
        iteration_codes JSONB DEFAULT '[]',
        raw_script TEXT,
        parsed_script JSONB,
        status TEXT DEFAULT 'detected',
        detected_at TIMESTAMPTZ DEFAULT NOW(),
        selected_at TIMESTAMPTZ,
        winner_reason TEXT,
        iteration_readiness TEXT,
        UNIQUE(creative_id)
      )
    `, [], { timeout: 15000 });

    await pgQuery(`
      CREATE TABLE IF NOT EXISTS brief_pipeline_generated (
        id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        winner_id UUID REFERENCES brief_pipeline_winners(id),
        parent_creative_id TEXT NOT NULL,
        iteration_mode TEXT,
        aggressiveness TEXT DEFAULT 'medium',
        win_analysis JSONB,
        hooks JSONB DEFAULT '[]',
        body TEXT,
        iteration_direction TEXT,
        novelty_score NUMERIC(3,1),
        aggression_score NUMERIC(3,1),
        coherence_score NUMERIC(3,1),
        overall_score NUMERIC(3,1),
        verdict TEXT,
        scores_json JSONB,
        rank INTEGER,
        brief_number INTEGER,
        product_code TEXT DEFAULT 'MR',
        angle TEXT,
        format TEXT,
        avatar TEXT,
        editor TEXT,
        strategist TEXT DEFAULT 'Ludovico',
        creator TEXT DEFAULT 'NA',
        naming_convention TEXT,
        status TEXT DEFAULT 'generated',
        clickup_task_id TEXT,
        clickup_task_url TEXT,
        created_at TIMESTAMPTZ DEFAULT NOW(),
        approved_at TIMESTAMPTZ,
        pushed_at TIMESTAMPTZ
      )
    `, [], { timeout: 15000 });

    await pgQuery(`
      CREATE TABLE IF NOT EXISTS brief_pipeline_analysis_cache (
        creative_id TEXT PRIMARY KEY,
        script_hash TEXT,
        win_analysis JSONB,
        analyzed_at TIMESTAMPTZ DEFAULT NOW()
      )
    `, [], { timeout: 15000 });

    tablesReady = true;
    console.log('[BriefPipeline] Tables ready');
  } catch (err) {
    console.error('[BriefPipeline] Table creation error:', err.message);
    throw err;
  }
}

// ── Helpers ───────────────────────────────────────────────────────────

async function clickupFetch(url, options = {}) {
  const fullUrl = url.startsWith('http') ? url : `${CLICKUP_API}${url}`;
  const res = await fetch(fullUrl, { ...options, headers });
  if (!res.ok) {
    const text = await res.text();
    throw new Error(`ClickUp API error ${res.status}: ${text}`);
  }
  return res.json();
}

function getISOWeekNumber() {
  const now = new Date();
  const d = new Date(Date.UTC(now.getFullYear(), now.getMonth(), now.getDate()));
  const dayNum = d.getUTCDay() || 7;
  d.setUTCDate(d.getUTCDate() + 4 - dayNum);
  const yearStart = new Date(Date.UTC(d.getUTCFullYear(), 0, 1));
  const weekNum = Math.ceil((((d - yearStart) / 86400000) + 1) / 7);
  return { weekNum, year: d.getUTCFullYear() };
}

function getCurrentWeekLabel() {
  const { weekNum, year } = getISOWeekNumber();
  return `WK${String(weekNum).padStart(2, '0')}_${year}`;
}

/**
 * Call Claude API and return parsed JSON from the response.
 */
async function callClaude(systemPrompt, userPrompt, maxTokens = 3000) {
  const body = {
    model: CLAUDE_MODEL,
    max_tokens: maxTokens,
    messages: [
      { role: 'user', content: userPrompt },
    ],
    system: systemPrompt,
  };

  const res = await fetch(CLAUDE_API_URL, {
    method: 'POST',
    headers: {
      'x-api-key': ANTHROPIC_API_KEY,
      'anthropic-version': '2023-06-01',
      'Content-Type': 'application/json',
    },
    body: JSON.stringify(body),
  });

  if (!res.ok) {
    const errText = await res.text();
    throw new Error(`Claude API error ${res.status}: ${errText}`);
  }

  const data = await res.json();
  const text = data.content?.[0]?.text || '';

  // Parse JSON from response — find the first { ... } block
  const jsonMatch = text.match(/\{[\s\S]*\}/);
  if (!jsonMatch) {
    throw new Error(`Claude returned no JSON block. Response: ${text.slice(0, 500)}`);
  }
  return JSON.parse(jsonMatch[0]);
}

/**
 * Classify why a winner is winning.
 */
function classifyWinner(winner) {
  if (winner.roas >= 3.0 && winner.total_spend >= 500) return 'volume_winner';
  if (winner.roas >= 2.0) return 'high_roas';
  if (winner.total_spend >= 50 && winner.total_spend <= 500 && winner.roas >= 1.5) return 'rising_star';
  if (winner.cpa <= 20) return 'efficiency_winner';
  return 'high_roas';
}

/**
 * Classify iteration readiness.
 */
function classifyReadiness(winner, existingIterations) {
  if (winner.total_spend < 100) return 'not_enough_data';
  if (existingIterations >= 8) return 'over_iterated';
  return 'ready';
}

/**
 * Count existing iterations for a creative in ClickUp.
 */
async function countIterations(creativeId) {
  let page = 0;
  let hasMore = true;
  const iterations = [];

  while (hasMore) {
    const data = await clickupFetch(
      `/list/${VIDEO_ADS_LIST}/task?page=${page}&limit=100&include_closed=true&subtasks=true`
    );
    const tasks = data.tasks || [];

    for (const task of tasks) {
      const parentField = task.custom_fields?.find(f => f.id === FIELD_IDS.parentBriefId);
      const briefTypeField = task.custom_fields?.find(f => f.id === FIELD_IDS.briefType);

      const briefType = briefTypeField?.type_config?.options?.find(
        o => o.orderindex === briefTypeField?.value
      )?.name;

      if (briefType === 'IT') {
        const parentValue = parentField?.value;
        if (parentValue && parentValue.includes(creativeId)) {
          const briefMatch = task.name?.match(/B(\d{2,5})/);
          if (briefMatch) {
            iterations.push({
              code: `B${briefMatch[1].padStart(4, '0')}`,
              taskId: task.id,
              name: task.name,
              status: task.status?.status,
            });
          }
        }
      }
    }

    hasMore = tasks.length === 100;
    page++;
  }

  return iterations;
}

/**
 * Extract script from a ClickUp task (description + comments).
 */
async function extractScript(clickupTaskId) {
  const task = await clickupFetch(`/task/${clickupTaskId}`);
  const description = task.description || task.text_content || '';

  const comments = await clickupFetch(`/task/${clickupTaskId}/comment`);
  const commentText = (comments.comments || [])
    .map(c => c.comment_text || '')
    .join('\n\n');

  return {
    raw: description + '\n\n' + commentText,
    taskName: task.name,
    status: task.status?.status,
  };
}

/**
 * Find the ClickUp task ID for a creative by its brief code (e.g. B0003).
 */
async function findClickUpTaskByBriefCode(briefCode) {
  const briefNum = parseInt(briefCode.replace(/^B0*/, ''), 10);
  if (isNaN(briefNum)) return null;

  let page = 0;
  let hasMore = true;

  while (hasMore) {
    const data = await clickupFetch(
      `/list/${VIDEO_ADS_LIST}/task?page=${page}&limit=100&include_closed=true&subtasks=true`
    );
    const tasks = data.tasks || [];

    for (const task of tasks) {
      const briefField = task.custom_fields?.find(f => f.id === FIELD_IDS.briefNumber);
      const taskBriefNum = briefField?.value != null ? parseInt(briefField.value, 10) : null;
      const nameMatch = task.name?.match(/B0*(\d+)/);
      const nameBriefNum = nameMatch ? parseInt(nameMatch[1], 10) : null;

      if (taskBriefNum === briefNum || nameBriefNum === briefNum) {
        return task.id;
      }
    }

    hasMore = tasks.length === 100;
    page++;
  }

  return null;
}

/**
 * Get the next available brief number from ClickUp.
 */
async function getNextBriefNumber() {
  let maxBrief = 0;
  let page = 0;
  let hasMore = true;

  while (hasMore) {
    const data = await clickupFetch(
      `/list/${VIDEO_ADS_LIST}/task?page=${page}&limit=100&include_closed=true&subtasks=true`
    );
    const tasks = data.tasks || [];

    for (const task of tasks) {
      const briefField = task.custom_fields?.find(f => f.id === FIELD_IDS.briefNumber);
      if (briefField?.value != null) {
        const num = parseInt(briefField.value, 10);
        if (!isNaN(num) && num > maxBrief) maxBrief = num;
      }
      const match = task.name?.match(/B(\d{2,5})/);
      if (match) {
        const num = parseInt(match[1], 10);
        if (!isNaN(num) && num > maxBrief) maxBrief = num;
      }
    }

    hasMore = tasks.length === 100;
    page++;
  }

  return maxBrief + 1;
}

/**
 * Build the naming convention string.
 */
function buildNamingConvention({ product_code, brief_number, parent_creative_id, avatar, angle, format, strategist, creator, editor, week }) {
  const briefId = `B${String(brief_number).padStart(4, '0')}`;
  return [
    product_code || 'MR',
    briefId,
    'IT',
    parent_creative_id,
    avatar || 'NA',
    angle || 'NA',
    format || 'Mashup',
    strategist || 'Ludovico',
    creator || 'NA',
    editor || 'Antoni',
    week || getCurrentWeekLabel(),
  ].join(' - ');
}

// ── Claude Prompts ────────────────────────────────────────────────────

function buildScriptParserPrompt(rawScript, taskName) {
  const system = `You are a script parser for video ad briefs. Extract the structured components from the raw script text below.`;
  const user = `RAW SCRIPT:
${rawScript}

TASK NAME: ${taskName}

Extract and return ONLY valid JSON:
{
  "hooks": [
    {
      "id": "H1",
      "text": "the full hook text",
      "mechanism": "fear" | "curiosity" | "social_proof" | "authority" | "controversy" | "shock" | "question" | "statistic" | "story" | "challenge",
      "length": "short" | "medium" | "long"
    }
  ],
  "body": "the full body script text, preserving paragraphs",
  "cta": "the call-to-action text if present",
  "format_notes": "any production notes, visual directions, or format instructions",
  "estimated_length_seconds": number,
  "villains": ["list of enemies/villains mentioned"],
  "proof_elements": ["list of proof mechanisms used"],
  "offer_mentioned": true/false,
  "discount_code_used": "MINER10" or null
}

RULES:
- Hooks are usually labeled H1, H2, H3 or Hook 1, Hook 2, Hook 3 or numbered
- If hooks aren't explicitly labeled, the first 1-3 sentences before the body are hooks
- The body is everything after the hooks until the CTA
- Preserve the exact wording — do NOT paraphrase or rewrite
- If the script has multiple sections (e.g. "Body:", "CTA:"), respect those boundaries`;

  return { system, user };
}

function buildWinAnalysisPrompt(winner, parsedScript) {
  const hooksFormatted = (parsedScript.hooks || [])
    .map(h => `${h.id}: ${h.text}`)
    .join('\n');

  const system = `You are a world-class direct response copywriter and ad creative strategist. You've generated over $500M in tracked revenue from paid social ads. Your job is to perform a surgical analysis of WHY this ad script is winning.`;

  const user = `WINNING AD CONTEXT:
- Brief Code: ${winner.creative_id}
- Product: MinerForge Pro — a mini Bitcoin miner, $59.99, 144 daily mining attempts, plug-and-play
- Angle: ${winner.angle || 'NA'}
- Format: ${winner.format || 'Mashup'}
- Performance (last 7 days):
  - Spend: $${winner.spend}
  - ROAS: ${winner.roas}x
  - CPA: $${winner.cpa}
  - CTR: ${winner.ctr}%
  - Purchases: ${winner.purchases}

WINNING SCRIPT:
Hooks:
${hooksFormatted}

Body:
${parsedScript.body || '(no body extracted)'}

ANALYZE THIS AD IN 8 DIMENSIONS:

1. HOOK MECHANISM
What psychological trigger does each hook use? Why does it stop the scroll?
Rate each hook's strength (1-10) and explain why.

2. EMOTIONAL DRIVER
What primary emotion powers this ad? (fear, greed, curiosity, anger, hope, shame, pride, FOMO)
What secondary emotions support it?

3. BELIEF SHIFT
What does the viewer believe BEFORE watching? What do they believe AFTER?
Map the exact belief transformation arc.

4. PROOF ARCHITECTURE
How does the ad prove its claims? (demonstration, social proof, authority, comparison, data, testimonial, logic chain)
Rate the proof strength (1-10).

5. ENEMY/VILLAIN STRUCTURE
Who or what is the enemy? How is the enemy introduced and defeated?
Does the ad create an us-vs-them dynamic?

6. OFFER POSITIONING
How is the product positioned? (solution, opportunity, weapon, secret, ticket, insurance)
What makes the offer feel urgent or scarce?

7. CTA LOGIC
What drives the click? Fear of missing out? Desire for proof? Curiosity gap?

8. STRUCTURAL PATTERN
What is the narrative arc? (problem-agitate-solve, story-proof-offer, hook-demo-cta, enemy-proof-opportunity)
What makes the pacing work?

Return ONLY valid JSON:
{
  "hook_analysis": [
    {
      "hook_id": "H1",
      "mechanism": "fear/curiosity/etc",
      "strength": 8,
      "why_it_works": "one sentence",
      "scroll_stop_factor": "what makes someone stop scrolling"
    }
  ],
  "emotional_driver": {
    "primary": "fear",
    "secondary": ["curiosity", "greed"],
    "intensity": 8,
    "trigger_sentence": "the exact sentence that hits hardest"
  },
  "belief_shift": {
    "before": "what they believe before",
    "after": "what they believe after",
    "pivot_moment": "the exact moment the shift happens"
  },
  "proof_architecture": {
    "type": "demonstration",
    "elements": ["blockchain verification", "side-by-side comparison"],
    "strength": 9,
    "most_convincing_line": "exact quote"
  },
  "enemy_structure": {
    "villain": "cheap knockoff miners / scammers",
    "introduction": "how the enemy is introduced",
    "defeat": "how the enemy is defeated",
    "us_vs_them": true
  },
  "offer_positioning": {
    "frame": "solution/opportunity/weapon/etc",
    "urgency_mechanism": "what creates urgency",
    "value_anchor": "what they compare the price against"
  },
  "cta_logic": {
    "driver": "fear_of_fakes",
    "click_motivation": "why someone clicks now"
  },
  "structural_pattern": {
    "arc": "enemy-proof-opportunity",
    "pacing": "fast/medium/slow",
    "section_count": 4,
    "key_transitions": ["hook → problem", "problem → proof", "proof → offer"]
  },
  "winning_elements_ranked": [
    "1. Enemy framing (scam knockoffs) creates immediate tension",
    "2. Live blockchain verification = undeniable proof",
    "3. Side-by-side comparison makes choice obvious",
    "4. 'Verified storefront' CTA removes purchase anxiety"
  ],
  "iteration_opportunities": [
    "Test different enemies (banks, big mining companies, crypto exchanges)",
    "Try curiosity-first hooks instead of fear-first",
    "Add social proof layer (X people already mining)",
    "Test urgency (limited stock / price increase)"
  ]
}`;

  return { system, user };
}

function buildIterationStrategyPrompt(winAnalysis, parsedScript, config) {
  const hooksFormatted = (parsedScript.hooks || [])
    .map(h => `${h.id}: ${h.text}`)
    .join('\n');

  const fixedElements = (config.fixed_elements || []).join(', ') || 'none';
  const allElements = ['hook mechanism', 'proof type', 'CTA structure', 'villain/enemy', 'emotional driver'];
  const changeableElements = allElements
    .filter(e => !(config.fixed_elements || []).includes(e))
    .join(', ') || 'all';

  const system = `You are an iteration strategist for direct response video ads. Based on the win analysis of a proven ad, you propose specific iteration directions that preserve what works while introducing strategic variation.`;

  const user = `WIN ANALYSIS:
${JSON.stringify(winAnalysis, null, 2)}

ORIGINAL SCRIPT:
Hooks:
${hooksFormatted}

Body:
${parsedScript.body || '(no body)'}

ITERATION CONFIG:
- Mode: ${config.mode || 'hook_body'}
- Aggressiveness: ${config.aggressiveness || 'medium'}
- Number of variations: ${config.num_variations || 3}
- Fixed elements: ${fixedElements}
- Elements that can change: ${changeableElements}

PRODUCT CONTEXT:
- Product: MinerForge Pro
- Price: $59.99
- Key promise: 144 daily Bitcoin mining attempts, keep 100% of block reward
- Winning angles: Lottery, Against Competition, BTC Made Easy, Hidden Opportunity, Scarcity
- Discount code: MINER10

Based on the analysis, propose exactly ${config.num_variations || 3} distinct iteration directions.

Each direction must:
1. Preserve the winning elements marked as "fixed"
2. Introduce a SPECIFIC, NAMED change (not vague like "try different hook")
3. Explain WHY this variation could outperform
4. Rate expected lift potential (low/medium/high)
5. Rate risk level (safe/moderate/bold)

ITERATION MODE RULES:
- hook_only: ONLY change hooks. Body stays identical.
- hook_body: Change hooks AND modify body. Keep same structure.
- full_reinterpretation: Rewrite everything. Keep same angle and core mechanism.
- angle_expansion: Keep the winning mechanism but apply it through a different angle.
- competitor_reframing: Keep the structure but change the enemy/villain.

AGGRESSIVENESS RULES:
- conservative: Minimal changes. Safe bets. Change 1-2 words in hooks, keep body 90%+ same.
- medium: Moderate changes. New hooks, body adjustments. Stay within proven patterns.
- aggressive: Bold moves. New hook mechanisms, restructured body, stronger claims.
- extreme: Maximum divergence. Completely new hooks, different emotional driver, shock value.

Return ONLY valid JSON:
{
  "directions": [
    {
      "id": 1,
      "name": "Fear Amplification",
      "description": "Intensify the scam-fear angle by opening with a specific victim story",
      "what_changes": "New H1 uses victim testimonial hook. H2 uses data-shock. Body adds proof element.",
      "what_stays": "Blockchain verification proof. Side-by-side comparison. CTA logic.",
      "why_it_could_win": "Victim stories have 2.3x higher hook rates in crypto niche",
      "expected_lift": "medium",
      "risk": "safe",
      "hook_direction": "Open with 'My neighbor bought a $30 Bitcoin miner. Here's what happened.'",
      "body_direction": "Same proof sequence but add victim context before the comparison",
      "emotional_shift": "fear → empathy → fear → solution"
    }
  ]
}`;

  return { system, user };
}

function buildBriefGeneratorPrompt(parsedScript, winAnalysis, direction, config) {
  const originalHooks = (parsedScript.hooks || [])
    .map(h => `${h.id}: ${h.text}`)
    .join('\n');

  const system = `You are an elite direct response copywriter for crypto/Bitcoin products. You write scripts that convert cold traffic into buyers. Your scripts are aggressive, specific, and impossible to scroll past.`;

  const user = `You are generating iteration #${direction.id} of a winning ad.

ORIGINAL WINNING SCRIPT:
Hooks:
${originalHooks}

Body:
${parsedScript.body || '(no body)'}

WIN ANALYSIS:
${JSON.stringify(winAnalysis, null, 2)}

ITERATION DIRECTION:
${direction.description}
- What changes: ${direction.what_changes}
- What stays: ${direction.what_stays}
- Hook direction: ${direction.hook_direction}
- Body direction: ${direction.body_direction}
- Emotional shift: ${direction.emotional_shift}

PRODUCT CONTEXT:
- Product: MinerForge Pro — a mini plug-and-play Bitcoin mining device
- Price: $59.99 (bundles: 2 for $109.99, 3+1 free for $179.99)
- Key facts: 144 daily mining attempts, 1 watt power, solo mining, keep 100% of block reward
- Discount: MINER10
- What it is NOT: NOT a USB stick, NOT a flash drive. It's a compact electronic device with a display screen.

ITERATION MODE: ${config.mode || 'hook_body'}
AGGRESSIVENESS: ${config.aggressiveness || 'medium'}

RULES:
1. Write exactly 3 hooks (H1, H2, H3) — each must be a COMPLETELY different approach to stopping the scroll
2. H1 = strongest hook (the one you'd bet money on)
3. Every hook must be under 25 words
4. Hooks must contain a SPECIFIC claim, number, or provocative statement — no vague generalities
5. The body must flow naturally from any of the 3 hooks
6. Body should be 150-300 words (60-90 seconds when read aloud)
7. Include a clear CTA with the discount code MINER10
8. Match the aggressiveness level: ${config.aggressiveness || 'medium'}
9. NEVER use these weak phrases: "works at home", "easy to use", "get started today", "join the revolution"
10. Every sentence must either create tension, provide proof, or drive toward the CTA
11. Pricing must be accurate: $59.99 base, bundles as listed above
12. Respect the iteration direction — this is not a free rewrite, it's a STRATEGIC variation

HOOK QUALITY CHECKLIST (every hook must pass ALL):
- Contains a specific number, dollar amount, or timeframe
- Creates an information gap or emotional reaction
- Could NOT be used for any other product (it's specific to Bitcoin mining)
- A normal person would stop scrolling to find out more
- It does NOT sound like a product description or tagline

Return ONLY valid JSON:
{
  "hooks": [
    {
      "id": "H1",
      "text": "the hook text",
      "mechanism": "fear/curiosity/shock/etc",
      "scroll_stop_reason": "why someone stops"
    },
    {
      "id": "H2",
      "text": "...",
      "mechanism": "...",
      "scroll_stop_reason": "..."
    },
    {
      "id": "H3",
      "text": "...",
      "mechanism": "...",
      "scroll_stop_reason": "..."
    }
  ],
  "body": "the full body script with natural paragraph breaks",
  "cta": "the call-to-action text",
  "word_count": number,
  "estimated_seconds": number,
  "key_changes_from_original": "2-3 sentence summary of what changed and why",
  "emotional_arc": "hook_emotion → middle_emotion → close_emotion"
}`;

  return { system, user };
}

function buildBriefScorerPrompt(winner, parsedScript, generatedBrief, directionName) {
  const originalHooks = (parsedScript.hooks || [])
    .map(h => `${h.id}: ${h.text}`)
    .join('\n');

  const generatedHooks = (generatedBrief.hooks || [])
    .map(h => `${h.id}: ${h.text}`)
    .join('\n');

  const system = `You are a performance media buyer who has spent $50M+ on paid social. You evaluate ad scripts purely on their likelihood to convert cold traffic. You are ruthlessly honest — most scripts are mediocre.`;

  const user = `ORIGINAL WINNING SCRIPT (baseline):
Hooks:
${originalHooks}

Body:
${parsedScript.body || '(no body)'}

ORIGINAL PERFORMANCE:
- ROAS: ${winner.roas}x
- CPA: $${winner.cpa}
- CTR: ${winner.ctr}%

GENERATED BRIEF:
Hooks:
${generatedHooks}

Body:
${generatedBrief.body || '(no body)'}

ITERATION DIRECTION: ${directionName}

Score this brief on 4 dimensions (1-10 scale, 5 = equal to original, 10 = significantly better):

1. NOVELTY (1-10): How different is this from the original?
   - 1 = basically the same script
   - 5 = recognizably related but distinct
   - 10 = completely fresh take

2. AGGRESSION (1-10): How bold are the claims and hooks?
   - 1 = timid, corporate
   - 5 = standard DTC aggressive
   - 10 = maximum scroll-stop, borderline shocking

3. COHERENCE (1-10): Does the script flow? Is the logic chain tight?
   - 1 = disjointed, confusing
   - 5 = acceptable flow
   - 10 = seamless, every sentence earns the next

4. CONVERSION POTENTIAL (1-10): Will this actually convert?
   - 1 = waste of ad spend
   - 5 = will perform equal to original
   - 10 = likely to significantly outperform

Return ONLY valid JSON:
{
  "novelty": { "score": 7, "reason": "one sentence" },
  "aggression": { "score": 8, "reason": "one sentence" },
  "coherence": { "score": 6, "reason": "one sentence" },
  "conversion_potential": { "score": 7, "reason": "one sentence" },
  "overall": 7.0,
  "verdict": "SHIP" | "MAYBE" | "KILL",
  "one_line_feedback": "The scam-comparison hook is strong but the body loses tension in paragraph 3.",
  "suggested_improvement": "optional one-sentence fix if verdict is MAYBE"
}`;

  return { system, user };
}

// ── Push to ClickUp ───────────────────────────────────────────────────

async function pushBriefToClickUp(generatedBrief) {
  const {
    brief_number, product_code, angle, format, avatar,
    editor, strategist, creator, parent_creative_id, hooks, body, naming_convention, iteration_direction,
  } = generatedBrief;

  const weekLabel = getCurrentWeekLabel();
  const namingConvention = naming_convention || buildNamingConvention({
    product_code, brief_number, parent_creative_id, avatar, angle, format,
    strategist, creator, editor, week: weekLabel,
  });

  // Build description with script
  const hooksFormatted = (hooks || [])
    .map(h => `${h.id}\n${h.text}`)
    .join('\n\n');
  const description = `Hooks:\n\n${hooksFormatted}\n\nBody:\n\n${body || ''}`;

  // Resolve dropdown option IDs
  const angleUuid = ANGLE_OPTIONS[angle] || ANGLE_OPTIONS.NA;
  const briefTypeUuid = BRIEF_TYPE_OPTIONS.IT;
  const creativeTypeUuid = CREATIVE_TYPE_OPTIONS[format] || CREATIVE_TYPE_OPTIONS.Mashup;

  const customFields = [
    { id: FIELD_IDS.briefNumber, value: brief_number },
    { id: FIELD_IDS.briefType, value: briefTypeUuid },
    { id: FIELD_IDS.parentBriefId, value: parent_creative_id },
    { id: FIELD_IDS.idea, value: iteration_direction || '-' },
    { id: FIELD_IDS.angle, value: angleUuid },
    { id: FIELD_IDS.creativeType, value: creativeTypeUuid },
    { id: FIELD_IDS.namingConvention, value: namingConvention },
    { id: FIELD_IDS.creationWeek, value: weekLabel },
    { id: FIELD_IDS.creativeStrategist, value: { add: [USER_IDS.Ludovico], rem: [] } },
    { id: FIELD_IDS.copywriter, value: { add: [USER_IDS.Ludovico], rem: [] } },
    { id: FIELD_IDS.editor, value: { add: [USER_IDS[editor] || USER_IDS.Antoni], rem: [] } },
  ].filter(f => f.value != null);

  const taskPayload = {
    name: namingConvention,
    description,
    status: 'edit queue',
    assignees: [USER_IDS[editor] || USER_IDS.Antoni],
    custom_fields: customFields,
  };

  const createdTask = await clickupFetch(
    `/list/${VIDEO_ADS_LIST}/task`,
    { method: 'POST', body: JSON.stringify(taskPayload) }
  );

  const taskId = createdTask.id;

  // Set relationship fields (Product, Avatar, Creator)
  const relationshipPromises = [];

  const productTaskId = PRODUCT_TASK_IDS[product_code] || PRODUCT_TASK_IDS.MR;
  if (productTaskId) {
    relationshipPromises.push(
      clickupFetch(`/task/${taskId}/field/${FIELD_IDS.product}`, {
        method: 'POST',
        body: JSON.stringify({ value: { add: [{ id: productTaskId }], rem: [] } }),
      }).catch(err => console.error('[BriefPipeline] Product relationship error:', err.message))
    );
  }

  const avatarTaskId = AVATAR_TASK_IDS[avatar];
  if (avatarTaskId) {
    relationshipPromises.push(
      clickupFetch(`/task/${taskId}/field/${FIELD_IDS.avatar}`, {
        method: 'POST',
        body: JSON.stringify({ value: { add: [{ id: avatarTaskId }], rem: [] } }),
      }).catch(err => console.error('[BriefPipeline] Avatar relationship error:', err.message))
    );
  }

  relationshipPromises.push(
    clickupFetch(`/task/${taskId}/field/${FIELD_IDS.creator}`, {
      method: 'POST',
      body: JSON.stringify({ value: { add: [{ id: CREATOR_NA_TASK_ID }], rem: [] } }),
    }).catch(err => console.error('[BriefPipeline] Creator relationship error:', err.message))
  );

  await Promise.all(relationshipPromises);

  // Re-set task name after relationships to avoid webhook race condition
  await clickupFetch(`/task/${taskId}`, {
    method: 'PUT',
    body: JSON.stringify({ name: namingConvention }),
  }).catch(err => console.error('[BriefPipeline] Name re-set error:', err.message));

  return {
    taskId,
    taskUrl: createdTask.url || `https://app.clickup.com/t/${taskId}`,
    namingConvention,
  };
}

// ══════════════════════════════════════════════════════════════════════
// ROUTES
// ══════════════════════════════════════════════════════════════════════

// GET /winners — list all detected winners
router.get('/winners', authenticate, async (_req, res) => {
  try {
    await ensureTables();
    const rows = await pgQuery(
      `SELECT * FROM brief_pipeline_winners ORDER BY roas DESC, detected_at DESC`
    );
    res.json({ success: true, winners: rows });
  } catch (err) {
    console.error('[BriefPipeline] GET /winners error:', err.message);
    res.status(500).json({ success: false, error: { message: err.message } });
  }
});

// POST /detect — run winner detection from creative_analysis table
router.post('/detect', authenticate, async (_req, res) => {
  try {
    await ensureTables();

    // Step 1: Query creative_analysis for winners
    const winners = await pgQuery(`
      SELECT creative_id,
             SUM(spend) as total_spend,
             SUM(revenue) as total_revenue,
             CASE WHEN SUM(spend) > 0 THEN SUM(revenue) / SUM(spend) ELSE 0 END as roas,
             SUM(purchases) as purchases,
             CASE WHEN SUM(purchases) > 0 THEN SUM(spend) / SUM(purchases) ELSE 0 END as cpa,
             CASE WHEN SUM(impressions) > 0 THEN (SUM(clicks)::float / SUM(impressions)) * 100 ELSE 0 END as ctr,
             SUM(impressions) as impressions,
             SUM(clicks) as clicks,
             MAX(ad_name) as ad_name,
             MAX(angle) as angle,
             MAX(format) as format,
             MAX(avatar) as avatar,
             MAX(editor) as editor,
             MAX(hook_id) as hook_type,
             MAX(week) as week
      FROM creative_analysis
      WHERE synced_at >= NOW() - INTERVAL '7 days'
        AND type = 'video'
      GROUP BY creative_id
      HAVING SUM(spend) >= 100
         AND CASE WHEN SUM(spend) > 0 THEN SUM(revenue) / SUM(spend) ELSE 0 END >= 1.5
      ORDER BY roas DESC
      LIMIT 20
    `, [], { timeout: 15000 });

    console.log(`[BriefPipeline] Detected ${winners.length} potential winners`);

    const results = [];

    for (const w of winners) {
      // Step 2: Count existing iterations in ClickUp
      let iterations = [];
      try {
        iterations = await countIterations(w.creative_id);
      } catch (err) {
        console.error(`[BriefPipeline] countIterations error for ${w.creative_id}:`, err.message);
      }

      const winnerReason = classifyWinner(w);
      const readiness = classifyReadiness(w, iterations.length);

      // Find ClickUp task ID for this creative
      let clickupTaskId = null;
      try {
        clickupTaskId = await findClickUpTaskByBriefCode(w.creative_id);
      } catch (err) {
        console.error(`[BriefPipeline] findClickUpTask error for ${w.creative_id}:`, err.message);
      }

      // Upsert into brief_pipeline_winners
      const upserted = await pgQuery(`
        INSERT INTO brief_pipeline_winners (
          creative_id, ad_name, product_code, angle, format, avatar, editor,
          hook_type, week, spend, revenue, roas, purchases, cpa, ctr,
          impressions, clicks, clickup_task_id, existing_iterations,
          iteration_codes, winner_reason, iteration_readiness, status, detected_at
        ) VALUES (
          $1, $2, 'MR', $3, $4, $5, $6, $7, $8,
          $9, $10, $11, $12, $13, $14, $15, $16,
          $17, $18, $19, $20, $21, 'detected', NOW()
        )
        ON CONFLICT (creative_id) DO UPDATE SET
          ad_name = EXCLUDED.ad_name,
          angle = EXCLUDED.angle,
          format = EXCLUDED.format,
          avatar = EXCLUDED.avatar,
          editor = EXCLUDED.editor,
          hook_type = EXCLUDED.hook_type,
          week = EXCLUDED.week,
          spend = EXCLUDED.spend,
          revenue = EXCLUDED.revenue,
          roas = EXCLUDED.roas,
          purchases = EXCLUDED.purchases,
          cpa = EXCLUDED.cpa,
          ctr = EXCLUDED.ctr,
          impressions = EXCLUDED.impressions,
          clicks = EXCLUDED.clicks,
          clickup_task_id = EXCLUDED.clickup_task_id,
          existing_iterations = EXCLUDED.existing_iterations,
          iteration_codes = EXCLUDED.iteration_codes,
          winner_reason = EXCLUDED.winner_reason,
          iteration_readiness = EXCLUDED.iteration_readiness,
          detected_at = NOW()
        RETURNING *
      `, [
        w.creative_id, w.ad_name, w.angle, w.format, w.avatar, w.editor,
        w.hook_type, w.week, w.total_spend, w.total_revenue, w.roas,
        w.purchases, w.cpa, w.ctr, w.impressions, w.clicks,
        clickupTaskId, iterations.length,
        JSON.stringify(iterations.map(i => i.code)),
        winnerReason, readiness,
      ], { timeout: 10000 });

      results.push(upserted[0]);
    }

    res.json({ success: true, detected: results.length, winners: results });
  } catch (err) {
    console.error('[BriefPipeline] POST /detect error:', err.message);
    res.status(500).json({ success: false, error: { message: err.message } });
  }
});

// GET /winners/:id — get winner detail including ClickUp script
router.get('/winners/:id', authenticate, async (req, res) => {
  try {
    await ensureTables();
    const rows = await pgQuery(
      `SELECT * FROM brief_pipeline_winners WHERE id = $1`,
      [req.params.id]
    );
    if (!rows.length) {
      return res.status(404).json({ success: false, error: { message: 'Winner not found' } });
    }

    const winner = rows[0];

    // Pull script from ClickUp if we have a task ID and don't have it cached
    if (winner.clickup_task_id && !winner.raw_script) {
      try {
        const scriptData = await extractScript(winner.clickup_task_id);
        await pgQuery(
          `UPDATE brief_pipeline_winners SET raw_script = $1 WHERE id = $2`,
          [scriptData.raw, winner.id]
        );
        winner.raw_script = scriptData.raw;
      } catch (err) {
        console.error(`[BriefPipeline] Script extraction error for ${winner.creative_id}:`, err.message);
      }
    }

    res.json({ success: true, winner });
  } catch (err) {
    console.error('[BriefPipeline] GET /winners/:id error:', err.message);
    res.status(500).json({ success: false, error: { message: err.message } });
  }
});

// POST /winners/:id/select — update status to 'selected', save iteration config
router.post('/winners/:id/select', authenticate, async (req, res) => {
  try {
    await ensureTables();
    const { mode, aggressiveness, num_variations, fixed_elements } = req.body;

    const rows = await pgQuery(
      `UPDATE brief_pipeline_winners
       SET status = 'selected',
           selected_at = NOW()
       WHERE id = $1
       RETURNING *`,
      [req.params.id]
    );

    if (!rows.length) {
      return res.status(404).json({ success: false, error: { message: 'Winner not found' } });
    }

    // Store config alongside the winner (we pass it to generation later)
    const winner = rows[0];
    winner._config = { mode, aggressiveness, num_variations, fixed_elements };

    res.json({ success: true, winner });
  } catch (err) {
    console.error('[BriefPipeline] POST /winners/:id/select error:', err.message);
    res.status(500).json({ success: false, error: { message: err.message } });
  }
});

// POST /generate/:id — the MAIN generation pipeline (Steps 4-8)
router.post('/generate/:id', authenticate, async (req, res) => {
  try {
    await ensureTables();
    const { mode = 'hook_body', aggressiveness = 'medium', num_variations = 3, fixed_elements = [] } = req.body;

    // Fetch the winner
    const winnerRows = await pgQuery(
      `SELECT * FROM brief_pipeline_winners WHERE id = $1`,
      [req.params.id]
    );
    if (!winnerRows.length) {
      return res.status(404).json({ success: false, error: { message: 'Winner not found' } });
    }
    const winner = winnerRows[0];

    // Guard against concurrent generation
    if (winner.status === 'generating') {
      return res.status(409).json({ success: false, error: { message: 'Generation already in progress for this winner.' } });
    }

    // Update status to generating (atomic check)
    const updated = await pgQuery(
      `UPDATE brief_pipeline_winners SET status = 'generating' WHERE id = $1 AND status != 'generating' RETURNING id`,
      [winner.id]
    );
    if (!updated.length) {
      return res.status(409).json({ success: false, error: { message: 'Generation already in progress for this winner.' } });
    }

    console.log(`[BriefPipeline] Starting generation pipeline for ${winner.creative_id}`);

    // Step 3: Extract script from ClickUp if needed
    if (!winner.raw_script && winner.clickup_task_id) {
      try {
        const scriptData = await extractScript(winner.clickup_task_id);
        winner.raw_script = scriptData.raw;
        await pgQuery(
          `UPDATE brief_pipeline_winners SET raw_script = $1 WHERE id = $2`,
          [scriptData.raw, winner.id]
        );
      } catch (scriptErr) {
        console.error(`[BriefPipeline] Script extraction failed:`, scriptErr.message);
      }
    }

    if (!winner.raw_script) {
      await pgQuery(`UPDATE brief_pipeline_winners SET status = 'selected' WHERE id = $1`, [winner.id]);
      return res.status(400).json({
        success: false,
        error: { message: 'No script available. Ensure the winner has a ClickUp task with a script in the description.' },
      });
    }

    // Step 4: Parse script with Claude
    console.log(`[BriefPipeline] Step 4: Parsing script for ${winner.creative_id}`);
    let parsedScript = winner.parsed_script;
    if (!parsedScript) {
      const { system, user } = buildScriptParserPrompt(winner.raw_script, winner.ad_name || winner.creative_id);
      parsedScript = await callClaude(system, user, 2000);
      if (!parsedScript || (!parsedScript.hooks && !parsedScript.body)) {
        throw new Error('Claude failed to parse the script into a valid structure (missing hooks/body).');
      }
      await pgQuery(
        `UPDATE brief_pipeline_winners SET parsed_script = $1 WHERE id = $2`,
        [JSON.stringify(parsedScript), winner.id]
      );
    }

    // Step 5: Win Analysis (check cache first)
    console.log(`[BriefPipeline] Step 5: Analyzing win pattern for ${winner.creative_id}`);
    const scriptHash = crypto.createHash('md5').update(winner.raw_script).digest('hex');
    let winAnalysis = null;

    const cacheRows = await pgQuery(
      `SELECT * FROM brief_pipeline_analysis_cache WHERE creative_id = $1 AND script_hash = $2`,
      [winner.creative_id, scriptHash]
    );

    if (cacheRows.length) {
      winAnalysis = cacheRows[0].win_analysis;
      console.log(`[BriefPipeline] Using cached win analysis for ${winner.creative_id}`);
    } else {
      const { system, user } = buildWinAnalysisPrompt(winner, parsedScript);
      winAnalysis = await callClaude(system, user, 4000);
      await pgQuery(
        `INSERT INTO brief_pipeline_analysis_cache (creative_id, script_hash, win_analysis)
         VALUES ($1, $2, $3)
         ON CONFLICT (creative_id) DO UPDATE SET script_hash = $2, win_analysis = $3, analyzed_at = NOW()`,
        [winner.creative_id, scriptHash, JSON.stringify(winAnalysis)]
      );
    }

    // Step 6: Propose iteration directions
    console.log(`[BriefPipeline] Step 6: Proposing ${num_variations} iteration directions`);
    const config = { mode, aggressiveness, num_variations, fixed_elements };
    const { system: stratSystem, user: stratUser } = buildIterationStrategyPrompt(winAnalysis, parsedScript, config);
    const strategyResult = await callClaude(stratSystem, stratUser, 3000);
    const directions = strategyResult.directions || [];

    // Step 7: Generate briefs (one per direction)
    console.log(`[BriefPipeline] Step 7: Generating ${directions.length} briefs`);
    const generatedBriefs = [];

    // Get next brief number range
    let nextBriefNum = await getNextBriefNumber();

    for (const direction of directions) {
      try {
        const { system: genSystem, user: genUser } = buildBriefGeneratorPrompt(parsedScript, winAnalysis, direction, config);
        const generated = await callClaude(genSystem, genUser, 3000);

        // Step 8: Score this brief
        console.log(`[BriefPipeline] Step 8: Scoring brief direction #${direction.id}`);
        const { system: scoreSystem, user: scoreUser } = buildBriefScorerPrompt(winner, parsedScript, generated, direction.name);
        const scores = await callClaude(scoreSystem, scoreUser, 1500);

        const overall = scores.overall || (
          ((scores.novelty?.score || 5) * 0.2) +
          ((scores.aggression?.score || 5) * 0.2) +
          ((scores.coherence?.score || 5) * 0.3) +
          ((scores.conversion_potential?.score || 5) * 0.3)
        );

        const briefNumber = nextBriefNum++;
        const weekLabel = getCurrentWeekLabel();

        const namingConvention = buildNamingConvention({
          product_code: winner.product_code || 'MR',
          brief_number: briefNumber,
          parent_creative_id: winner.creative_id,
          avatar: winner.avatar,
          angle: winner.angle,
          format: winner.format,
          strategist: 'Ludovico',
          creator: 'NA',
          editor: winner.editor || 'Antoni',
          week: weekLabel,
        });

        // Save to DB
        const inserted = await pgQuery(`
          INSERT INTO brief_pipeline_generated (
            winner_id, parent_creative_id, iteration_mode, aggressiveness,
            win_analysis, hooks, body, iteration_direction,
            novelty_score, aggression_score, coherence_score, overall_score,
            verdict, scores_json,
            brief_number, product_code, angle, format, avatar, editor,
            strategist, creator, naming_convention, status
          ) VALUES (
            $1, $2, $3, $4, $5, $6, $7, $8,
            $9, $10, $11, $12, $13, $14,
            $15, $16, $17, $18, $19, $20,
            $21, $22, $23, 'generated'
          )
          RETURNING *
        `, [
          winner.id, winner.creative_id, mode, aggressiveness,
          JSON.stringify(winAnalysis), JSON.stringify(generated.hooks), generated.body,
          `${direction.name}: ${direction.description}`,
          scores.novelty?.score || 5, scores.aggression?.score || 5,
          scores.coherence?.score || 5, overall,
          scores.verdict || 'MAYBE', JSON.stringify(scores),
          briefNumber, winner.product_code || 'MR', winner.angle, winner.format,
          winner.avatar, winner.editor || 'Antoni',
          'Ludovico', 'NA', namingConvention,
        ], { timeout: 10000 });

        generatedBriefs.push({
          ...inserted[0],
          scores,
          direction,
        });
      } catch (dirErr) {
        console.error(`[BriefPipeline] Error generating direction #${direction.id}:`, dirErr.message);
      }
    }

    // Assign ranks based on overall score
    generatedBriefs.sort((a, b) => (b.overall_score || 0) - (a.overall_score || 0));
    for (let i = 0; i < generatedBriefs.length; i++) {
      const rank = i + 1;
      generatedBriefs[i].rank = rank;
      await pgQuery(
        `UPDATE brief_pipeline_generated SET rank = $1 WHERE id = $2`,
        [rank, generatedBriefs[i].id]
      );
    }

    // Update winner status
    await pgQuery(
      `UPDATE brief_pipeline_winners SET status = 'generated' WHERE id = $1`,
      [winner.id]
    );

    console.log(`[BriefPipeline] Generation complete: ${generatedBriefs.length} briefs for ${winner.creative_id}`);

    res.json({
      success: true,
      winner_id: winner.id,
      creative_id: winner.creative_id,
      briefs_generated: generatedBriefs.length,
      briefs: generatedBriefs,
    });
  } catch (err) {
    console.error('[BriefPipeline] POST /generate/:id error:', err.message);
    // Reset status on failure
    await pgQuery(
      `UPDATE brief_pipeline_winners SET status = 'selected' WHERE id = $1`,
      [req.params.id]
    ).catch(() => {});
    res.status(500).json({ success: false, error: { message: err.message } });
  }
});

// GET /generated — list all generated briefs
router.get('/generated', authenticate, async (_req, res) => {
  try {
    await ensureTables();
    const rows = await pgQuery(
      `SELECT * FROM brief_pipeline_generated ORDER BY overall_score DESC, created_at DESC`
    );
    res.json({ success: true, briefs: rows });
  } catch (err) {
    console.error('[BriefPipeline] GET /generated error:', err.message);
    res.status(500).json({ success: false, error: { message: err.message } });
  }
});

// GET /generated/:id — get generated brief detail
router.get('/generated/:id', authenticate, async (req, res) => {
  try {
    await ensureTables();
    const rows = await pgQuery(
      `SELECT * FROM brief_pipeline_generated WHERE id = $1`,
      [req.params.id]
    );
    if (!rows.length) {
      return res.status(404).json({ success: false, error: { message: 'Brief not found' } });
    }
    res.json({ success: true, brief: rows[0] });
  } catch (err) {
    console.error('[BriefPipeline] GET /generated/:id error:', err.message);
    res.status(500).json({ success: false, error: { message: err.message } });
  }
});

// PATCH /generated/:id — update status (approve/reject)
router.patch('/generated/:id', authenticate, async (req, res) => {
  try {
    await ensureTables();
    const { status } = req.body;

    if (!['approved', 'rejected'].includes(status)) {
      return res.status(400).json({ success: false, error: { message: 'Status must be "approved" or "rejected"' } });
    }

    const extra = status === 'approved' ? ', approved_at = NOW()' : '';
    const rows = await pgQuery(
      `UPDATE brief_pipeline_generated SET status = $1${extra} WHERE id = $2 RETURNING *`,
      [status, req.params.id]
    );

    if (!rows.length) {
      return res.status(404).json({ success: false, error: { message: 'Brief not found' } });
    }

    res.json({ success: true, brief: rows[0] });
  } catch (err) {
    console.error('[BriefPipeline] PATCH /generated/:id error:', err.message);
    res.status(500).json({ success: false, error: { message: err.message } });
  }
});

// POST /generated/:id/push — push approved brief to ClickUp
router.post('/generated/:id/push', authenticate, async (req, res) => {
  try {
    await ensureTables();
    const rows = await pgQuery(
      `SELECT * FROM brief_pipeline_generated WHERE id = $1`,
      [req.params.id]
    );
    if (!rows.length) {
      return res.status(404).json({ success: false, error: { message: 'Brief not found' } });
    }

    const brief = rows[0];
    if (brief.status !== 'approved') {
      return res.status(400).json({ success: false, error: { message: 'Brief must be approved before pushing to ClickUp' } });
    }

    if (brief.clickup_task_id) {
      return res.status(400).json({ success: false, error: { message: 'Brief already pushed to ClickUp' } });
    }

    const result = await pushBriefToClickUp(brief);

    await pgQuery(
      `UPDATE brief_pipeline_generated
       SET status = 'pushed', clickup_task_id = $1, clickup_task_url = $2, pushed_at = NOW()
       WHERE id = $3`,
      [result.taskId, result.taskUrl, brief.id]
    );

    res.json({
      success: true,
      brief_id: brief.id,
      clickup_task_id: result.taskId,
      clickup_task_url: result.taskUrl,
      naming_convention: result.namingConvention,
    });
  } catch (err) {
    console.error('[BriefPipeline] POST /generated/:id/push error:', err.message);
    res.status(500).json({ success: false, error: { message: err.message } });
  }
});

// POST /batch-push — push all approved briefs to ClickUp
router.post('/batch-push', authenticate, async (_req, res) => {
  try {
    await ensureTables();
    const approvedRows = await pgQuery(
      `SELECT * FROM brief_pipeline_generated WHERE status = 'approved' AND clickup_task_id IS NULL ORDER BY rank ASC`
    );

    if (!approvedRows.length) {
      return res.json({ success: true, pushed: 0, message: 'No approved briefs to push' });
    }

    const results = [];
    const errors = [];

    for (const brief of approvedRows) {
      try {
        const result = await pushBriefToClickUp(brief);

        await pgQuery(
          `UPDATE brief_pipeline_generated
           SET status = 'pushed', clickup_task_id = $1, clickup_task_url = $2, pushed_at = NOW()
           WHERE id = $3`,
          [result.taskId, result.taskUrl, brief.id]
        );

        results.push({
          brief_id: brief.id,
          clickup_task_id: result.taskId,
          clickup_task_url: result.taskUrl,
          naming_convention: result.namingConvention,
        });
      } catch (pushErr) {
        console.error(`[BriefPipeline] Batch push error for ${brief.id}:`, pushErr.message);
        errors.push({ brief_id: brief.id, error: pushErr.message });
      }
    }

    res.json({
      success: true,
      pushed: results.length,
      failed: errors.length,
      results,
      errors: errors.length ? errors : undefined,
    });
  } catch (err) {
    console.error('[BriefPipeline] POST /batch-push error:', err.message);
    res.status(500).json({ success: false, error: { message: err.message } });
  }
});

// GET /stats — pipeline stats (counts per column)
router.get('/stats', authenticate, async (_req, res) => {
  try {
    await ensureTables();

    const winnerStats = await pgQuery(`
      SELECT status, COUNT(*)::int as count
      FROM brief_pipeline_winners
      GROUP BY status
    `);

    const briefStats = await pgQuery(`
      SELECT status, COUNT(*)::int as count
      FROM brief_pipeline_generated
      GROUP BY status
    `);

    const stats = {
      detected: 0,
      selected: 0,
      generating: 0,
      generated: 0,
      approved: 0,
      rejected: 0,
      pushed: 0,
    };

    for (const row of winnerStats) {
      if (row.status in stats) stats[row.status] = row.count;
    }
    for (const row of briefStats) {
      if (row.status in stats) stats[row.status] += row.count;
      else stats[row.status] = row.count;
    }

    res.json({ success: true, stats });
  } catch (err) {
    console.error('[BriefPipeline] GET /stats error:', err.message);
    res.status(500).json({ success: false, error: { message: err.message } });
  }
});

export default router;
