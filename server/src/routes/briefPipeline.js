import { Router } from 'express';
import { authenticate } from '../middleware/auth.js';
import { pgQuery } from '../db/pg.js';
import crypto from 'crypto';

const router = Router();

// ── Config ────────────────────────────────────────────────────────────
const CLICKUP_TOKEN = process.env.CLICKUP_API_TOKEN || '';
const VIDEO_ADS_LIST = '901518716584';
const MEDIA_BUYING_LIST = '901518769621';
const CLICKUP_API = 'https://api.clickup.com/api/v2';
const META_ACCESS_TOKEN = process.env.META_ACCESS_TOKEN || '';
const META_AD_ACCOUNT_IDS = (process.env.META_AD_ACCOUNT_IDS || '').split(',').filter(Boolean);
const META_GRAPH_URL = 'https://graph.facebook.com/v22.0';
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
        iteration_mode TEXT,
        iteration_config JSONB,
        thumbnail_url TEXT,
        video_url TEXT,
        UNIQUE(creative_id)
      )
    `, [], { timeout: 15000 });

    // Add columns that may not exist on older tables
    await pgQuery(`ALTER TABLE brief_pipeline_winners ADD COLUMN IF NOT EXISTS thumbnail_url TEXT`).catch(() => {});
    await pgQuery(`ALTER TABLE brief_pipeline_winners ADD COLUMN IF NOT EXISTS video_url TEXT`).catch(() => {});
    await pgQuery(`ALTER TABLE brief_pipeline_winners ADD COLUMN IF NOT EXISTS iteration_mode TEXT`).catch(() => {});
    await pgQuery(`ALTER TABLE brief_pipeline_winners ADD COLUMN IF NOT EXISTS iteration_config JSONB`).catch(() => {});

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

    // Recover any winners stuck in 'generating' from a previous crash
    const stuck = await pgQuery(
      `UPDATE brief_pipeline_winners SET status = 'detected' WHERE status = 'generating' RETURNING creative_id`
    ).catch(() => []);
    if (stuck.length) {
      console.log(`[BriefPipeline] Recovered ${stuck.length} stuck winners: ${stuck.map(r => r.creative_id).join(', ')}`);
    }

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
async function callClaude(systemPrompt, userPrompt, maxTokens = 3000, { fast = false } = {}) {
  const body = {
    model: fast ? 'claude-haiku-4-5-20251001' : CLAUDE_MODEL,
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

  // Strip markdown fences if present, then parse JSON
  let cleaned = text.trim();
  const fenceMatch = cleaned.match(/```(?:json)?\s*\n?([\s\S]*?)\n?\s*```/);
  if (fenceMatch) cleaned = fenceMatch[1].trim();

  const jsonMatch = cleaned.match(/\{[\s\S]*\}/);
  if (!jsonMatch) {
    throw new Error(`Claude returned no JSON block. Response: ${cleaned.slice(0, 500)}`);
  }
  try {
    return JSON.parse(jsonMatch[0]);
  } catch (parseErr) {
    // Try to fix common issues: trailing commas, truncated responses
    let fixable = jsonMatch[0]
      .replace(/,\s*([}\]])/g, '$1')  // remove trailing commas
      .replace(/\n/g, '\\n')          // escape raw newlines in strings
      .replace(/\\n/g, '\\n');        // keep escaped ones
    // If still truncated, try to close open braces
    const opens = (fixable.match(/\{/g) || []).length;
    const closes = (fixable.match(/\}/g) || []).length;
    for (let i = 0; i < opens - closes; i++) fixable += '}';
    try { return JSON.parse(fixable); } catch {}
    throw new Error(`Failed to parse Claude JSON: ${parseErr.message}\nRaw: ${jsonMatch[0].slice(0, 300)}`);
  }
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

// ── Fetch product profile from DB ────────────────────────────────────
async function fetchProductProfile(productCode) {
  try {
    const rows = await pgQuery(
      `SELECT * FROM product_profiles WHERE LOWER(short_name) = LOWER($1) OR LOWER(product_code) = LOWER($1) OR LOWER(name) ILIKE '%' || LOWER($1) || '%' ORDER BY updated_at DESC LIMIT 1`,
      [productCode || 'MR']
    );
    if (!rows.length) return null;
    const p = rows[0];
    // Parse JSONB fields
    for (const f of ['product_images', 'logos', 'fonts', 'brand_colors', 'benefits', 'angles', 'scripts', 'offers']) {
      if (p[f] && typeof p[f] === 'string') try { p[f] = JSON.parse(p[f]); } catch {}
    }
    return p;
  } catch { return null; }
}

function buildProductContextForBrief(p) {
  if (!p) return 'No product profile available.';
  const lines = [
    p.name             && `Product: ${p.name}`,
    p.description      && `Description: ${p.description}`,
    p.price            && `Price: ${p.price}`,
    p.big_promise      && `Big Promise: ${p.big_promise}`,
    p.mechanism        && `Unique Mechanism: ${p.mechanism}`,
    p.benefits?.length && `Key Benefits: ${Array.isArray(p.benefits) ? p.benefits.map(b => b.text || b.name || b).join(', ') : p.benefits}`,
    p.differentiator   && `Differentiator: ${p.differentiator}`,
    p.guarantee        && `Guarantee: ${p.guarantee}`,
    p.customer_avatar  && `Target Customer: ${p.customer_avatar}`,
    p.customer_frustration && `Customer Frustration: ${p.customer_frustration}`,
    p.customer_dream   && `Customer Dream Outcome: ${p.customer_dream}`,
    p.target_demographics && `Target Demographics: ${p.target_demographics}`,
    p.voice            && `Brand Voice/Tone: ${p.voice}`,
    p.winning_angles   && `Winning Angles: ${p.winning_angles}`,
    p.angles?.length   && `Proven Angles: ${Array.isArray(p.angles) ? p.angles.map(a => a.name || a).join(', ') : p.angles}`,
    p.pain_points      && `Pain Points: ${p.pain_points}`,
    p.common_objections && `Common Objections: ${p.common_objections}`,
    p.competitive_edge && `Competitive Edge: ${p.competitive_edge}`,
    p.offer_details    && `Offer Details: ${p.offer_details}`,
    p.discount_codes   && `Discount Codes: ${p.discount_codes}`,
    p.bundle_variants  && `Bundle Variants: ${p.bundle_variants}`,
    p.compliance_restrictions && `COMPLIANCE — Never claim: ${p.compliance_restrictions}`,
  ].filter(Boolean);
  return lines.join('\n');
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

// ── 3-Agent Deep Analysis (replaces old single win analysis) ─────────
function buildDeepAnalysisPrompts(winner, parsedScript, productContext) {
  const hooksFormatted = (parsedScript.hooks || [])
    .map(h => `${h.id}: ${h.text}`)
    .join('\n');
  const scriptText = `Hooks:\n${hooksFormatted}\n\nBody:\n${parsedScript.body || '(no body)'}`;
  const perfContext = `Performance (last 7 days): Spend $${winner.spend}, ROAS ${winner.roas}x, CPA $${winner.cpa}, CTR ${winner.ctr}%, Purchases ${winner.purchases}`;

  // ── Agent 1: Script DNA ──
  const dnaPrompt = {
    system: 'You are a senior direct-response strategist and copy analyst.',
    user: `# TASK
Deconstruct this winning ad into its core conversion components AND map its narrative structure step-by-step. Identify the logical engine — WHY this ad converts, not just what it says.

# AD CONTEXT
- Brief Code: ${winner.creative_id}
- Angle: ${winner.angle || 'NA'}
- Format: ${winner.format || 'Mashup'}
- ${perfContext}

# PRODUCT CONTEXT
${productContext}

# WINNING AD SCRIPT
${scriptText}

# OUTPUT (JSON only, no markdown, no backticks, no explanation)
{
  "core_angle": "the central persuasion angle driving the ad",
  "primary_emotion": "the dominant emotion leveraged",
  "secondary_emotions": ["list", "of", "supporting", "emotions"],
  "target_desire": "what the viewer wants that this ad promises",
  "target_fear": "what the viewer is afraid of that this ad addresses",
  "belief_shift": "what belief must change for the viewer to buy",
  "problem_presented": "the specific problem framed in the ad",
  "solution_presented": "how the product/offer is positioned as the answer",
  "mechanism": "the unique mechanism or reason WHY the solution works",
  "proof_type": "how credibility is established",
  "cta_type": "how the call to action is structured",
  "audience_awareness_level": "unaware / problem-aware / solution-aware / product-aware / most-aware",
  "narrative_structure": {
    "hook_type": "the hook technique used",
    "opening_tension": "what tension or open loop is created immediately",
    "problem_escalation": "how the problem is intensified after the hook",
    "explanation": "how the solution/mechanism is introduced and explained",
    "proof_moment": "where and how proof or credibility is delivered",
    "contrast": "any before/after or us-vs-them comparison (or null if absent)",
    "resolution": "how tension is resolved and the viewer is moved toward action",
    "cta_structure": "exact CTA approach"
  },
  "why_it_works": "1-2 sentences on WHY this ad converts",
  "core_argument": "the central argument in one sentence",
  "undeniable_truth": "the fact or truth used to make the argument believable",
  "what_makes_it_believable": "the credibility mechanism",
  "what_would_break_it": "the single change that would destroy this ad's effectiveness",
  "structural_skeleton": {
    "hook_framework": "the exact hook technique/framework used (e.g. 'confession/apology', 'warning', 'story opening', 'question', 'bold claim')",
    "rhetorical_devices": ["list every distinct rhetorical device or pattern used in the body — e.g. 'repetition (yes it's true that...)', 'twist reveal (here's where I lied)', 'us-vs-them comparison', 'social proof anecdote', 'stacking benefits'"],
    "section_by_section": ["list each section of the script in order — e.g. 'Apology/confession hook', 'Repetitive validation (5x yes statements)', 'Emotional testimonial', 'Twist reveal', 'Competitor callout', 'Urgency close'"],
    "signature_phrases": ["list any distinctive phrases or patterns that define this script's identity — e.g. 'Yes, it's true that...', 'Here's where I lied', 'A lottery ticket that never expires'"],
    "pacing_rhythm": "describe the sentence rhythm pattern (e.g. 'Short punchy opener, then long flowing validation paragraphs, then short twist')"
  }
}

# RULES
- Be precise, not generic. Every field must be specific to THIS ad.
- Do NOT rewrite the ad. Extract what makes it convert.
- Focus on reasoning, not wording.
- The structural_skeleton is CRITICAL — it must capture the exact rhetorical framework so iterations can replicate the same skeleton with different words.`
  };

  // ── Agent 2: Psychology ──
  const psychologyPrompt = {
    system: 'You are a consumer psychology expert and hook specialist for paid social ads.',
    user: `# TASK
Perform three analyses on this winning ad:
1. Map the emotional journey of the viewer at each stage
2. Deep-analyze every hook in the ad
3. Infer and validate the target audience against the product profile

# PRODUCT CONTEXT
${productContext}

# WINNING AD SCRIPT
${scriptText}

# OUTPUT (JSON only, no markdown, no backticks, no explanation)
{
  "emotional_arc": {
    "at_hook": "what the viewer feels in the first 1-3 seconds",
    "after_problem": "emotional state once the problem is presented",
    "during_explanation": "how the viewer feels as the mechanism/solution unfolds",
    "at_proof": "emotional response to the credibility moment",
    "before_cta": "emotional state right before the call to action",
    "final_state": "the emotion the viewer is left with"
  },
  "hooks": [
    {
      "text": "exact hook text from the ad",
      "hook_type": "curiosity / warning / contrarian / shock / story / authority / social proof / pattern interrupt",
      "scroll_stop_mechanism": "what specifically makes someone stop scrolling",
      "emotional_trigger": "the emotion activated by this hook",
      "why_it_works": "1 sentence on why this hook is effective",
      "strength": 8
    }
  ],
  "hook_patterns": {
    "shared_patterns": "what patterns all hooks share",
    "must_not_change": "what must stay fixed in any new hook variation"
  },
  "audience": {
    "who_is_this_for": "specific description of the target viewer",
    "what_they_already_believe": "existing beliefs the ad leverages",
    "what_they_are_skeptical_about": "doubts or objections they carry",
    "awareness_stage": "unaware / problem-aware / solution-aware / product-aware / most-aware",
    "implicit_objection_handled": "the objection the ad addresses without stating it directly",
    "product_alignment": "how well the ad matches the product profile's target customer"
  }
}

# RULES
- Describe FEELINGS, not content.
- Extract EXACT hook text. List every hook present.
- Cross-reference audience against the product profile.`
  };

  // ── Agent 3: Iteration Rules ──
  const rulesPrompt = {
    system: 'You are a senior creative director specializing in direct-response ad iteration for a media buying team.',
    user: `# TASK
Define the precise boundaries for iteration — what MUST stay fixed, what CAN be varied, and what is HIGH-RISK to change. This output directly constrains the script generator.

# PRODUCT CONTEXT
${productContext}

# WINNING AD SCRIPT
${scriptText}

# OUTPUT (JSON only, no markdown, no backticks, no explanation)
{
  "must_stay_fixed": [
    "list of elements that must NOT change in any iteration"
  ],
  "can_be_varied": [
    "list of elements safe to change"
  ],
  "high_risk_changes": [
    "list of changes that could break the ad"
  ],
  "safe_iteration_directions": [
    "specific creative directions that would produce strong variations"
  ],
  "hook_rules": {
    "must_preserve": "what every new hook must achieve",
    "safe_variations": "specific hook reframing ideas that maintain the core mechanism",
    "avoid": "hook approaches that would disconnect from the body"
  },
  "tone_boundaries": {
    "current_register": "the tone of the original",
    "acceptable_range": "how far the tone can shift",
    "never_do": "tone shifts that would break the ad"
  },
  "compliance_notes": "any claims that must stay within product profile compliance restrictions"
}

# RULES
- Be specific to THIS ad. Generic advice is useless.
- Think like a creative director briefing a copywriter.
- Keep each array item to ONE SHORT sentence (under 20 words). Be concise — no long explanations in list items.
- If the product profile has compliance restrictions, flag any original claims that are borderline.`
  };

  return { dnaPrompt, psychologyPrompt, rulesPrompt };
}

// buildIterationStrategyPrompt removed — directions now built from iterationRules.safe_iteration_directions
// Kept as comment for git history reference
function _deprecated_buildIterationStrategyPrompt(winAnalysis, parsedScript, config, productContext) {
  const hooksFormatted = (parsedScript.hooks || [])
    .map(h => `${h.id}: ${h.text}`)
    .join('\n');

  const fixedElements = (config.fixed_elements || []).join(', ') || 'none';
  const allElements = ['hook mechanism', 'proof type', 'CTA structure', 'villain/enemy', 'emotional driver'];
  const changeableElements = allElements
    .filter(e => !(config.fixed_elements || []).includes(e))
    .join(', ') || 'all';

  const system = `You are an iteration strategist for direct response video ads. Based on the win analysis of a proven ad, you propose specific iteration directions that preserve what works while introducing strategic variation.`;

  // Format the 3-agent analysis for the strategy prompt
  const { scriptDna, psychology, iterationRules } = winAnalysis || {};
  const analysisFormatted = [];
  if (scriptDna) {
    analysisFormatted.push(`SCRIPT DNA:
- Core Angle: ${scriptDna.core_angle || 'N/A'}
- Primary Emotion: ${scriptDna.primary_emotion || 'N/A'}
- Mechanism: ${scriptDna.mechanism || 'N/A'}
- Belief Shift: ${scriptDna.belief_shift || 'N/A'}
- Awareness Level: ${scriptDna.audience_awareness_level || 'N/A'}
- Why It Works: ${scriptDna.why_it_works || 'N/A'}
- What Would Break It: ${scriptDna.what_would_break_it || 'N/A'}`);
  }
  if (psychology) {
    if (psychology.emotional_arc) {
      const ea = psychology.emotional_arc;
      analysisFormatted.push(`EMOTIONAL ARC: ${ea.at_hook || '?'} → ${ea.after_problem || '?'} → ${ea.during_explanation || '?'} → ${ea.at_proof || '?'} → ${ea.before_cta || '?'} → ${ea.final_state || '?'}`);
    }
    if (psychology.hooks?.length) {
      analysisFormatted.push(`HOOK ANALYSIS:\n${psychology.hooks.map(h => `- "${h.text?.slice(0, 60)}..." — ${h.hook_type}, strength ${h.strength}/10, stops scroll because: ${h.scroll_stop_mechanism}`).join('\n')}`);
    }
    if (psychology.audience) {
      analysisFormatted.push(`AUDIENCE: ${psychology.audience.who_is_this_for || 'N/A'} — Awareness: ${psychology.audience.awareness_stage || 'N/A'}`);
    }
  }
  if (iterationRules) {
    analysisFormatted.push(`ITERATION BOUNDARIES:
MUST STAY FIXED: ${(iterationRules.must_stay_fixed || []).join('; ')}
CAN VARY: ${(iterationRules.can_be_varied || []).join('; ')}
HIGH-RISK (AVOID): ${(iterationRules.high_risk_changes || []).join('; ')}
SAFE DIRECTIONS: ${(iterationRules.safe_iteration_directions || []).join('; ')}`);
  }

  const user = `DEEP ANALYSIS:
${analysisFormatted.join('\n\n')}

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
${productContext}

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

function buildBriefGeneratorPrompt(parsedScript, deepAnalysis, direction, config, productContext) {
  const originalHooks = (parsedScript.hooks || [])
    .map(h => `${h.id}: ${h.text}`)
    .join('\n');

  // Build analysis context from the 3-agent results
  const { scriptDna, psychology, iterationRules } = deepAnalysis || {};
  const analysisLines = [];
  if (scriptDna) {
    analysisLines.push(`SCRIPT DNA:
- Core Angle: ${scriptDna.core_angle || 'N/A'}
- Primary Emotion: ${scriptDna.primary_emotion || 'N/A'}
- Belief Shift: ${scriptDna.belief_shift || 'N/A'}
- Mechanism: ${scriptDna.mechanism || 'N/A'}
- Awareness Level: ${scriptDna.audience_awareness_level || 'N/A'}
- Why It Works: ${scriptDna.why_it_works || 'N/A'}
- What Would Break It: ${scriptDna.what_would_break_it || 'N/A'}`);

    // Add structural skeleton — this is the most critical part for iteration fidelity
    if (scriptDna.structural_skeleton) {
      const sk = scriptDna.structural_skeleton;
      const skLines = [`STRUCTURAL SKELETON (YOUR ITERATION MUST FOLLOW THIS EXACT FRAMEWORK):`];
      if (sk.hook_framework) skLines.push(`Hook Framework: ${sk.hook_framework}`);
      if (sk.rhetorical_devices?.length) skLines.push(`Rhetorical Devices: ${sk.rhetorical_devices.join(' | ')}`);
      if (sk.section_by_section?.length) skLines.push(`Section Flow:\n  ${sk.section_by_section.map((s, i) => `${i + 1}. ${s}`).join('\n  ')}`);
      if (sk.signature_phrases?.length) skLines.push(`Signature Patterns (use equivalent patterns, NOT these exact words): ${sk.signature_phrases.join(' | ')}`);
      if (sk.pacing_rhythm) skLines.push(`Pacing: ${sk.pacing_rhythm}`);
      analysisLines.push(skLines.join('\n'));
    }
  }
  if (psychology?.emotional_arc) {
    const ea = psychology.emotional_arc;
    analysisLines.push(`EMOTIONAL ARC: ${ea.at_hook} → ${ea.after_problem} → ${ea.during_explanation} → ${ea.at_proof} → ${ea.before_cta} → ${ea.final_state}`);
  }
  if (iterationRules) {
    if (iterationRules.must_stay_fixed?.length) analysisLines.push(`MUST STAY FIXED:\n- ${iterationRules.must_stay_fixed.join('\n- ')}`);
    if (iterationRules.can_be_varied?.length) analysisLines.push(`CAN BE VARIED:\n- ${iterationRules.can_be_varied.join('\n- ')}`);
    if (iterationRules.high_risk_changes?.length) analysisLines.push(`HIGH-RISK (AVOID):\n- ${iterationRules.high_risk_changes.join('\n- ')}`);
    if (iterationRules.tone_boundaries) {
      analysisLines.push(`TONE: ${iterationRules.tone_boundaries.current_register || 'N/A'} — Range: ${iterationRules.tone_boundaries.acceptable_range || 'N/A'} — Never: ${iterationRules.tone_boundaries.never_do || 'N/A'}`);
    }
    if (iterationRules.hook_rules) {
      analysisLines.push(`HOOK RULES: Preserve: ${iterationRules.hook_rules.must_preserve || 'N/A'} | Avoid: ${iterationRules.hook_rules.avoid || 'N/A'}`);
    }
    if (iterationRules.compliance_notes) analysisLines.push(`COMPLIANCE: ${iterationRules.compliance_notes}`);
  }
  const analysisContext = analysisLines.length ? analysisLines.join('\n\n') : '';

  const system = `You are a senior direct-response copywriter specialized in Facebook and TikTok ad iteration.

You understand that the goal is NOT to create new ads, but to generate variations of a proven winner while preserving its psychological mechanism, persuasive structure, and conversion logic.

You write like a human performance marketer — not like an AI, not like a brand copywriter.`;

  const user = `# OBJECTIVE

Generate a high-quality iteration of a winning ad script.

This iteration must:
- Preserve the original angle and mechanism
- Follow the same narrative flow
- Maintain the same emotional journey
- Use completely new wording, phrasing, and sentence structures
- The 3 hooks must blend PERFECTLY with the body — each hook must flow naturally into the body as if they were written together

The goal is to create a variation that feels fresh while behaving identically in terms of conversion.

# PRODUCT CONTEXT
${productContext}

# ORIGINAL WINNING SCRIPT
Hooks:
${originalHooks}

Body:
${parsedScript.body || '(no body)'}

# DEEP ANALYSIS
${analysisContext}

# ITERATION DIRECTION
${direction.description}
- What changes: ${direction.what_changes}
- What stays: ${direction.what_stays}
- Hook direction: ${direction.hook_direction}
- Body direction: ${direction.body_direction}
- Emotional shift: ${direction.emotional_shift}

# ITERATION RULES

## STRUCTURAL SKELETON PRESERVATION (MOST IMPORTANT RULE)
- The STRUCTURAL SKELETON section above describes the exact rhetorical framework of the original.
- Your iteration MUST follow the SAME section-by-section flow as the original.
- If the original uses a confession/apology hook framework, your hooks MUST also use confession/apology.
- If the original uses repetition patterns (e.g. "Yes, it's true that..."), your iteration MUST use an equivalent repetition pattern — different words, SAME device.
- If the original has a twist/reveal moment, your iteration MUST have a twist/reveal at the same structural point.
- If the original uses competitor callouts, your iteration MUST include competitor callouts.
- Every rhetorical device listed in the skeleton must appear in your iteration. You can rephrase it, but you CANNOT remove it.
- The section flow must match: if the original goes Apology → Validation → Proof → Twist → Urgency, your iteration must go through those same stages in that order.

## Angle & Narrative Preservation
- Keep the exact same core angle
- Do NOT introduce new selling points or mechanisms
- Do NOT change the story structure
- Do NOT remove any persuasive step
- Maintain the same emotional progression
- AWARENESS LEVEL LOCK: Target the same market awareness stage as the original

## Hook Generation — REPHRASE the original hooks, don't invent new ones
- Generate 3 hooks that are VARIATIONS of the original hooks — same framework, same emotional trigger, different words
- Look at the original hooks above. Your 3 hooks must achieve the EXACT SAME THING those hooks achieve.
- If the original hooks use confession/apology ("I need to apologize", "I lied"), your hooks MUST also use confession/apology. Not curiosity. Not pain. Not contrarian. Confession/apology.
- Each hook is a REPHRASING of the original hook concept — not a new concept
- H1 = closest to original hook energy, strongest version
- H2 = same framework, slightly different angle
- H3 = same framework, different entry point but same emotional trigger
- Each hook must BLEND PERFECTLY with the body — reading hook + body must feel like one continuous script
- Do NOT reuse exact phrases from original hooks
- The hook framework is NON-NEGOTIABLE. If the original says "I apologize because I lied", your hooks must also be about apologizing/confessing/admitting something — NOT about lottery comparisons, NOT about product features, NOT about warnings.

## Body Generation — SECTION-BY-SECTION REPHRASING (NOT rewriting)
- Go through the original body paragraph by paragraph, section by section
- For EACH section of the original, write the EQUIVALENT section in your iteration
- Same point. Same purpose. Same position in the script. Different words.
- If the original body has 8 paragraphs, your iteration must have ~8 paragraphs making the same points in the same order
- Do NOT add new sections that aren't in the original
- Do NOT remove sections that are in the original
- Do NOT rearrange the order of sections
- Do NOT introduce new angles, comparisons, or narratives that weren't in the original
- The iteration body should feel like the SAME PERSON saying the SAME THINGS in a SLIGHTLY DIFFERENT WAY — not a different person writing a different script
- Think of it like re-recording the same speech with different word choices, not writing a new speech

## Style & Tone
- Match the tone of the original (direct, conversational, persuasive)
- Avoid robotic or "clean marketing" language
- Write like a human speaking to one person
- Keep rhythm natural and engaging

# HARD CONSTRAINTS
- Do NOT introduce new claims not supported by the product profile
- Do NOT change product positioning
- Do NOT simplify to the point of losing persuasion
- Do NOT generate generic or bland copy
- Be aggressive and direct to consumer — the goal is to convert cold traffic
- If iteration rules specify "must stay fixed" items, treat them as absolute constraints
- If iteration rules specify "high-risk changes", treat them as forbidden
- If compliance restrictions exist, respect them absolutely

Return ONLY valid JSON:
{
  "hooks": [
    {
      "id": "H1",
      "text": "the hook text",
      "mechanism": "curiosity/pain/contrarian",
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

function buildBriefScorerPrompt(winner, parsedScript, generatedBrief, directionName, deepAnalysis, productContext) {
  const originalHooks = (parsedScript.hooks || [])
    .map(h => `${h.id}: ${h.text}`)
    .join('\n');

  const generatedHooks = (generatedBrief.hooks || [])
    .map((h, i) => `${h.id || `H${i + 1}`}: ${h.text || '(empty)'}`)
    .join('\n');

  // Build iteration rules context for scoring
  const rules = deepAnalysis?.iterationRules;
  const rulesContext = rules ? `
ITERATION RULES TO EVALUATE AGAINST:
- Must stay fixed: ${(rules.must_stay_fixed || []).join('; ')}
- High-risk changes (should NOT have been made): ${(rules.high_risk_changes || []).join('; ')}
- Tone boundary: ${rules.tone_boundaries?.current_register || 'N/A'} (acceptable range: ${rules.tone_boundaries?.acceptable_range || 'N/A'})
- Compliance: ${rules.compliance_notes || 'None'}` : '';

  const system = `You are a performance media buyer who has spent $50M+ on paid social. You evaluate ad scripts purely on their likelihood to convert cold traffic. You are ruthlessly honest — most scripts are mediocre.`;

  const user = `PRODUCT CONTEXT:
${productContext}

ORIGINAL WINNING SCRIPT (baseline):
Hooks:
${originalHooks}

Body:
${parsedScript.body || '(no body)'}

ORIGINAL PERFORMANCE:
- ROAS: ${winner.roas}x
- CPA: $${winner.cpa}
- CTR: ${winner.ctr}%
${rulesContext}

GENERATED BRIEF:
Hooks:
${generatedHooks}

Body:
${generatedBrief.body || '(no body)'}

ITERATION DIRECTION: ${directionName}

Score this brief on 5 dimensions (1-10 scale):

1. NOVELTY (1-10): How different is this from the original?
   - 1 = basically the same script / synonym swaps
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

4. HOOK-BODY BLEND (1-10): Do ALL 3 hooks flow naturally into the body?
   - Read each hook followed immediately by the body's first sentence.
   - 1 = jarring disconnect, different voice/topic
   - 5 = acceptable transition
   - 10 = perfectly seamless, sounds like one person talking

5. CONVERSION POTENTIAL (1-10): Will this actually convert cold traffic?
   - 1 = waste of ad spend
   - 5 = will perform equal to original
   - 10 = likely to significantly outperform

Also check:
- Did the iteration respect the "must stay fixed" elements? Flag any violations.
- Did it make any "high-risk changes"? Flag them.
- Are all product claims accurate per the product context?
- Does it maintain the same market awareness level as the original?

Return ONLY valid JSON:
{
  "novelty": { "score": 7, "reason": "one sentence" },
  "aggression": { "score": 8, "reason": "one sentence" },
  "coherence": { "score": 6, "reason": "one sentence" },
  "hook_body_blend": { "score": 8, "reason": "one sentence" },
  "conversion_potential": { "score": 7, "reason": "one sentence" },
  "overall": 7.0,
  "verdict": "SHIP" | "MAYBE" | "KILL",
  "rule_violations": ["list any iteration rule violations, or empty array if none"],
  "one_line_feedback": "what's strong and what's weak in one sentence",
  "suggested_improvement": "optional one-sentence fix if verdict is MAYBE"
}`;

  return { system, user };
}

// ── Hook-Body Blend Validation Agent ─────────────────────────────────
function buildBlendValidationPrompt(generatedBrief) {
  const hooks = (generatedBrief.hooks || []).map(h => h.text).filter(Boolean);
  const body = generatedBrief.body || '';
  const bodyFirstLine = body.split('\n').find(l => l.trim().length > 10) || body.slice(0, 200);

  const system = `You are a continuity editor for direct response ad scripts. Your ONLY job is to check if hooks flow naturally into the body.`;

  const user = `Read each hook below, then immediately read the body's opening. Judge if they sound like one continuous script written by the same person.

${hooks.map((h, i) => `HOOK ${i + 1}: "${h}"
→ BODY STARTS: "${bodyFirstLine}"`).join('\n\n')}

For each hook, return:
- blend_score (1-10): 1 = jarring disconnect, 10 = perfectly seamless
- issue: null if score >= 7, otherwise describe the disconnect in one sentence
- fix_suggestion: null if score >= 7, otherwise suggest a one-sentence fix

Return ONLY valid JSON:
{
  "hooks": [
    { "id": 1, "blend_score": 8, "issue": null, "fix_suggestion": null },
    { "id": 2, "blend_score": 5, "issue": "Hook uses casual UGC tone but body opens with authoritative data", "fix_suggestion": "Soften the body's opening to match the casual hook tone" },
    { "id": 3, "blend_score": 9, "issue": null, "fix_suggestion": null }
  ],
  "overall_blend": 7.3,
  "pass": true
}

A brief PASSES if overall_blend >= 6.5.`;

  return { system, user };
}

// ── Push to ClickUp ───────────────────────────────────────────────────

async function pushBriefToClickUp(generatedBrief, parentClickupTaskId) {
  const {
    brief_number, product_code, angle, format, avatar,
    editor, strategist, creator, parent_creative_id, hooks, body, naming_convention, iteration_direction,
  } = generatedBrief;

  const weekLabel = getCurrentWeekLabel();
  const namingConvention = naming_convention || buildNamingConvention({
    product_code, brief_number, parent_creative_id, avatar, angle, format,
    strategist, creator, editor, week: weekLabel,
  });

  // Fetch parent ad's Frame.io link from ClickUp
  let referenceLink = '';
  if (parentClickupTaskId) {
    try {
      const parentTask = await clickupFetch(`/task/${parentClickupTaskId}`);
      const frameField = parentTask.custom_fields?.find(f => f.id === FIELD_IDS.adsFrameLink);
      if (frameField?.value) {
        referenceLink = frameField.value;
      }
    } catch (err) {
      console.warn(`[BriefPipeline] Could not fetch parent Frame link from ${parentClickupTaskId}:`, err.message);
    }
  }

  // Build description with script
  const parsedHooks = (() => {
    if (Array.isArray(hooks)) return hooks;
    if (typeof hooks === 'string') { try { return JSON.parse(hooks); } catch { return []; } }
    return [];
  })();
  const hooksFormatted = parsedHooks
    .map((h, i) => `Hook ${i + 1}:\n${h.text || ''}`.trim())
    .join('\n');

  const referenceLine = referenceLink ? `Reference: ${referenceLink}\n\n` : '';
  const description = `${referenceLine}--- Hooks ---\n\n${hooksFormatted}\n\n--- Body ---\n\n${body || ''}\n\n[brief-pipeline]`;

  // Resolve dropdown option IDs
  const angleUuid = ANGLE_OPTIONS[angle] || ANGLE_OPTIONS.NA;
  const briefTypeUuid = BRIEF_TYPE_OPTIONS.IT;
  const creativeTypeUuid = CREATIVE_TYPE_OPTIONS[format] || CREATIVE_TYPE_OPTIONS.Mashup;

  const editorUserId = USER_IDS[editor] || USER_IDS.Ludovico;

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
    { id: FIELD_IDS.editor, value: { add: [editorUserId], rem: [] } },
  ].filter(f => f.value != null);

  const taskPayload = {
    name: namingConvention,
    description,
    status: 'edit queue',
    assignees: [editorUserId],
    custom_fields: customFields,
  };

  let createdTask;
  try {
    createdTask = await clickupFetch(
      `/list/${VIDEO_ADS_LIST}/task`,
      { method: 'POST', body: JSON.stringify(taskPayload) }
    );
  } catch (err) {
    // If editor user doesn't have workspace access, retry without user fields
    if (err.message.includes('FIELD_129') || err.message.includes('must have access')) {
      console.warn(`[BriefPipeline] Editor ${editor} (${editorUserId}) not accessible, falling back to Ludovico`);
      const fallbackFields = customFields.map(f => {
        if (f.id === FIELD_IDS.editor) return { ...f, value: { add: [USER_IDS.Ludovico], rem: [] } };
        return f;
      });
      const fallbackPayload = { ...taskPayload, assignees: [USER_IDS.Ludovico], custom_fields: fallbackFields };
      createdTask = await clickupFetch(
        `/list/${VIDEO_ADS_LIST}/task`,
        { method: 'POST', body: JSON.stringify(fallbackPayload) }
      );
    } else {
      throw err;
    }
  }

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

  return {
    taskId,
    taskUrl: createdTask.url || `https://app.clickup.com/t/${taskId}`,
    namingConvention,
  };
}

// ── On-demand Meta thumbnail refresh ──────────────────────────────────
/**
 * Fetch a fresh thumbnail_url from Meta API for a given creative_id (e.g. "B0071").
 * Returns { thumbnail_url, video_url } or null if not found.
 */
async function refreshMetaThumbnail(creativeId) {
  if (!META_ACCESS_TOKEN || META_AD_ACCOUNT_IDS.length === 0) return null;

  for (const accountId of META_AD_ACCOUNT_IDS) {
    try {
      const searchUrl = `${META_GRAPH_URL}/${accountId}/ads?fields=name,creative.fields(thumbnail_url,image_url,video_id).thumbnail_width(720).thumbnail_height(720)&filtering=[{"field":"name","operator":"CONTAIN","value":"${creativeId}"}]&limit=10&access_token=${META_ACCESS_TOKEN}`;
      const resp = await fetch(searchUrl);
      const data = await resp.json();
      if (data.error || !data.data?.length) continue;

      for (const ad of data.data) {
        const thumbUrl = ad.creative?.image_url || ad.creative?.thumbnail_url || null;
        if (!thumbUrl) continue;

        // Also fetch permanent video source if there's a video_id
        let videoUrl = null;
        const videoId = ad.creative?.video_id;
        if (videoId) {
          try {
            const vidResp = await fetch(`${META_GRAPH_URL}/${videoId}?fields=source&access_token=${META_ACCESS_TOKEN}`);
            const vidData = await vidResp.json();
            if (vidData.source) videoUrl = vidData.source;
          } catch (_) { /* ignore */ }
        }

        // Update creative_analysis so other endpoints benefit
        await pgQuery(
          `UPDATE creative_analysis SET thumbnail_url = $1, video_url = COALESCE($2, video_url)
           WHERE creative_id = $3`,
          [thumbUrl, videoUrl, creativeId]
        ).catch(() => {});

        return { thumbnail_url: thumbUrl, video_url: videoUrl };
      }
    } catch (err) {
      console.warn(`[BriefPipeline] Meta thumbnail refresh error for ${accountId}:`, err.message);
    }
  }
  return null;
}

// ══════════════════════════════════════════════════════════════════════
// ROUTES
// ══════════════════════════════════════════════════════════════════════

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
function validateUuid(req, res) {
  if (!UUID_RE.test(req.params.id)) {
    res.status(400).json({ success: false, error: { message: 'Invalid ID format' } });
    return false;
  }
  return true;
}

// GET /winners — list all detected winners
router.get('/winners', authenticate, async (_req, res) => {
  try {
    await ensureTables();
    const rows = await pgQuery(
      `SELECT * FROM brief_pipeline_winners ORDER BY roas DESC, detected_at DESC`
    );

    // Refresh stale thumbnail/video URLs from creative_analysis (Meta CDN URLs expire)
    if (rows.length) {
      const creativeIds = rows.map(r => r.creative_id);
      const freshUrls = await pgQuery(`
        SELECT DISTINCT ON (creative_id) creative_id, thumbnail_url, video_url
        FROM creative_analysis
        WHERE creative_id = ANY($1)
          AND (thumbnail_url IS NOT NULL OR video_url IS NOT NULL)
        ORDER BY creative_id, synced_at DESC
      `, [creativeIds]);

      const urlMap = {};
      for (const r of freshUrls) urlMap[r.creative_id] = r;

      for (const row of rows) {
        const fresh = urlMap[row.creative_id];
        if (fresh) {
          if (fresh.thumbnail_url) row.thumbnail_url = fresh.thumbnail_url;
          if (fresh.video_url) row.video_url = fresh.video_url;
        }
      }

      // On-demand Meta refresh for winners with missing or stale thumbnails
      const staleRows = rows.filter(r =>
        !r.thumbnail_url ||
        (r.thumbnail_url && r.thumbnail_url.includes('fbcdn.net')) ||
        (r.video_url && !r.video_url.includes('.mp4'))
      );
      if (staleRows.length > 0 && META_ACCESS_TOKEN) {
        // Limit concurrent refreshes to avoid rate limiting
        const toRefresh = staleRows.slice(0, 10);
        const refreshPromises = toRefresh.map(async (row) => {
          try {
            const fresh = await refreshMetaThumbnail(row.creative_id);
            if (fresh) {
              if (fresh.thumbnail_url) row.thumbnail_url = fresh.thumbnail_url;
              if (fresh.video_url) row.video_url = fresh.video_url;
              await pgQuery(
                `UPDATE brief_pipeline_winners SET thumbnail_url = COALESCE($1, thumbnail_url), video_url = COALESCE($2, video_url) WHERE id = $3`,
                [fresh.thumbnail_url, fresh.video_url, row.id]
              ).catch(() => {});
            }
          } catch (_) { /* ignore individual refresh failures */ }
        });
        await Promise.all(refreshPromises);
      }
    }
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
             MAX(week) as week,
             MAX(thumbnail_url) as thumbnail_url,
             MAX(video_url) as video_url
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
          iteration_codes, winner_reason, iteration_readiness, thumbnail_url, video_url, status, detected_at
        ) VALUES (
          $1, $2, 'MR', $3, $4, $5, $6, $7, $8,
          $9, $10, $11, $12, $13, $14, $15, $16,
          $17, $18, $19, $20, $21, $22, $23, 'detected', NOW()
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
          thumbnail_url = EXCLUDED.thumbnail_url,
          video_url = EXCLUDED.video_url
        WHERE brief_pipeline_winners.status = 'detected'
        RETURNING *
      `, [
        w.creative_id, w.ad_name, w.angle, w.format, w.avatar, w.editor,
        w.hook_type, w.week, w.total_spend, w.total_revenue, w.roas,
        w.purchases, w.cpa, w.ctr, w.impressions, w.clicks,
        clickupTaskId, iterations.length,
        JSON.stringify(iterations.map(i => i.code)),
        winnerReason, readiness,
        w.thumbnail_url || null, w.video_url || null,
      ], { timeout: 10000 });

      if (upserted && upserted[0]) {
        results.push(upserted[0]);
      }
    }

    res.json({ success: true, detected: results.length, winners: results });
  } catch (err) {
    console.error('[BriefPipeline] POST /detect error:', err.message);
    res.status(500).json({ success: false, error: { message: err.message } });
  }
});

// GET /winners/:id — get winner detail including ClickUp script
router.get('/winners/:id', authenticate, async (req, res) => {
  if (!validateUuid(req, res)) return;
  try {
    await ensureTables();
    const rows = await pgQuery(
      `SELECT * FROM brief_pipeline_winners WHERE id = $1`,
      [req.params.id]
    );
    if (!rows.length) {
      return res.status(404).json({ success: false, error: { message: 'Winner not found' } });
    }

    // Refresh thumbnail/video from creative_analysis (Meta CDN URLs expire)
    const freshUrls = await pgQuery(`
      SELECT thumbnail_url, video_url FROM creative_analysis
      WHERE creative_id = $1 AND (thumbnail_url IS NOT NULL OR video_url IS NOT NULL)
      ORDER BY synced_at DESC LIMIT 1
    `, [rows[0].creative_id]);
    if (freshUrls.length) {
      if (freshUrls[0].thumbnail_url) rows[0].thumbnail_url = freshUrls[0].thumbnail_url;
      if (freshUrls[0].video_url) rows[0].video_url = freshUrls[0].video_url;
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

    // Respond immediately — don't block on Meta API
    res.json({ success: true, winner });

    // Background: refresh Meta URLs if missing or expired CDN (not permanent .mp4), for next time
    const needsRefresh = !winner.thumbnail_url || !winner.video_url
      || (winner.thumbnail_url && winner.thumbnail_url.includes('fbcdn.net'))
      || (winner.video_url && !winner.video_url.includes('.mp4'));
    if (META_ACCESS_TOKEN && needsRefresh) {
      refreshMetaThumbnail(winner.creative_id).then(fresh => {
        if (!fresh) return;
        const updates = [];
        const params = [];
        if (fresh.thumbnail_url) { updates.push(`thumbnail_url = $${params.length + 1}`); params.push(fresh.thumbnail_url); }
        if (fresh.video_url) { updates.push(`video_url = $${params.length + 1}`); params.push(fresh.video_url); }
        if (updates.length) {
          params.push(winner.id);
          pgQuery(`UPDATE brief_pipeline_winners SET ${updates.join(', ')} WHERE id = $${params.length}`, params).catch(() => {});
        }
      }).catch(err => console.warn(`[BriefPipeline] Background Meta refresh error:`, err.message));
    }
  } catch (err) {
    console.error('[BriefPipeline] GET /winners/:id error:', err.message);
    res.status(500).json({ success: false, error: { message: err.message } });
  }
});

// POST /winners/:id/select — update status to 'selected', save iteration config
router.post('/winners/:id/select', authenticate, async (req, res) => {
  if (!validateUuid(req, res)) return;
  try {
    await ensureTables();
    const body = req.body || {};
    const { iteration_mode, mode: modeAlt, aggressiveness, num_variations, fixed_elements, editor } = body;
    const mode = iteration_mode || modeAlt || 'hook_body';

    const rows = await pgQuery(
      `UPDATE brief_pipeline_winners
       SET status = 'selected',
           selected_at = NOW(),
           iteration_mode = $2,
           iteration_config = $3
       WHERE id = $1
       RETURNING *`,
      [req.params.id, mode, JSON.stringify({ mode, aggressiveness, num_variations, fixed_elements, editor })]
    );

    if (!rows.length) {
      return res.status(404).json({ success: false, error: { message: 'Winner not found' } });
    }

    res.json({ success: true, winner: rows[0] });
  } catch (err) {
    console.error('[BriefPipeline] POST /winners/:id/select error:', err.message);
    res.status(500).json({ success: false, error: { message: err.message } });
  }
});

// POST /generate/:id — the MAIN generation pipeline (Steps 4-8)
router.post('/generate/:id', authenticate, async (req, res) => {
  if (!validateUuid(req, res)) return;
  try {
    await ensureTables();
    // Fetch the winner
    const winnerRows = await pgQuery(
      `SELECT * FROM brief_pipeline_winners WHERE id = $1`,
      [req.params.id]
    );
    if (!winnerRows.length) {
      return res.status(404).json({ success: false, error: { message: 'Winner not found' } });
    }
    const winner = winnerRows[0];

    // Read config from request body, or fall back to saved iteration_config from select step
    const savedConfig = winner.iteration_config || {};
    const body = req.body || {};
    const mode = body.mode || body.iteration_mode || savedConfig.mode || 'hook_body';
    const aggressiveness = body.aggressiveness || savedConfig.aggressiveness || 'medium';
    const num_variations = body.num_variations || savedConfig.num_variations || 3;
    const fixed_elements = body.fixed_elements || savedConfig.fixed_elements || [];
    const configEditor = body.editor || savedConfig.editor || null;

    // Guard: only allow generation from 'detected' or 'selected' status
    if (winner.status === 'generating') {
      return res.status(409).json({ success: false, error: { message: 'Generation already in progress for this winner.' } });
    }
    if (!['detected', 'selected'].includes(winner.status)) {
      return res.status(400).json({ success: false, error: { message: `Winner must be in "detected" or "selected" status to generate. Current status: "${winner.status}".` } });
    }

    // Update status to generating (atomic check — only from 'detected' or 'selected')
    const updated = await pgQuery(
      `UPDATE brief_pipeline_winners SET status = 'generating' WHERE id = $1 AND status IN ('detected', 'selected') RETURNING id`,
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
      await pgQuery(`UPDATE brief_pipeline_winners SET status = 'detected' WHERE id = $1`, [winner.id]);
      return res.status(400).json({
        success: false,
        error: { message: 'No script available. Ensure the winner has a ClickUp task with a script in the description.' },
      });
    }

    // Step 4: Parse script with Claude
    console.log(`[BriefPipeline] Step 4: Parsing script for ${winner.creative_id}`);
    let parsedScript = winner.parsed_script;
    if (typeof parsedScript === 'string') { try { parsedScript = JSON.parse(parsedScript); } catch { parsedScript = null; } }
    if (!parsedScript) {
      const { system, user } = buildScriptParserPrompt(winner.raw_script, winner.ad_name || winner.creative_id);
      parsedScript = await callClaude(system, user, 2000);
      if (!parsedScript || (!parsedScript.hooks?.length && !parsedScript.body?.trim())) {
        throw new Error('Claude failed to parse the script into a valid structure (missing hooks/body).');
      }
      await pgQuery(
        `UPDATE brief_pipeline_winners SET parsed_script = $1 WHERE id = $2`,
        [JSON.stringify(parsedScript), winner.id]
      );
    }

    // Step 5: Fetch product profile from library
    console.log(`[BriefPipeline] Step 5a: Fetching product profile for ${winner.product_code || 'MR'}`);
    const productProfile = await fetchProductProfile(winner.product_code || 'MR');
    const productContext = buildProductContextForBrief(productProfile);

    // Step 5b: Deep 3-agent analysis (check cache first)
    console.log(`[BriefPipeline] Step 5b: Running deep analysis for ${winner.creative_id}`);
    const scriptHash = crypto.createHash('md5').update(winner.raw_script).digest('hex');
    let winAnalysis = null;

    const cacheRows = await pgQuery(
      `SELECT * FROM brief_pipeline_analysis_cache WHERE creative_id = $1 AND script_hash = $2`,
      [winner.creative_id, scriptHash]
    );

    const cachedAnalysis = cacheRows.length ? cacheRows[0].win_analysis : null;
    // Validate cache has new 3-agent format (scriptDna/psychology/iterationRules)
    // Old format had flat keys like hookMechanism — invalidate those
    if (cachedAnalysis?.scriptDna && cachedAnalysis?.psychology && cachedAnalysis?.iterationRules) {
      winAnalysis = cachedAnalysis;
      console.log(`[BriefPipeline] Using cached deep analysis for ${winner.creative_id}`);
    } else {
      if (cachedAnalysis) console.log(`[BriefPipeline] Stale analysis cache for ${winner.creative_id} — re-analyzing with 3-agent pipeline`);
      const { dnaPrompt, psychologyPrompt, rulesPrompt } = buildDeepAnalysisPrompts(winner, parsedScript, productContext);

      // Run all 3 agents in parallel
      const [scriptDna, psychology, iterationRules] = await Promise.all([
        callClaude(dnaPrompt.system, dnaPrompt.user, 4096),
        callClaude(psychologyPrompt.system, psychologyPrompt.user, 4096),
        callClaude(rulesPrompt.system, rulesPrompt.user, 4096),
      ]);

      winAnalysis = { scriptDna, psychology, iterationRules };

      await pgQuery(
        `INSERT INTO brief_pipeline_analysis_cache (creative_id, script_hash, win_analysis)
         VALUES ($1, $2, $3)
         ON CONFLICT (creative_id) DO UPDATE SET script_hash = $2, win_analysis = $3, analyzed_at = NOW()`,
        [winner.creative_id, scriptHash, JSON.stringify(winAnalysis)]
      );
    }

    // Step 6: Build directions from analysis (skip separate strategy call)
    console.log(`[BriefPipeline] Step 6: Building ${num_variations} directions from analysis`);
    const config = { mode, aggressiveness, num_variations, fixed_elements };
    const safeDirections = winAnalysis.iterationRules?.safe_iteration_directions || [];
    const directions = [];
    for (let i = 0; i < num_variations; i++) {
      const dirText = safeDirections[i] || `Variation ${i + 1}: Fresh creative approach with different hook framing and tone`;
      directions.push({
        id: i + 1,
        name: `Direction ${i + 1}`,
        description: dirText,
        what_changes: dirText,
        what_stays: (winAnalysis.iterationRules?.must_stay_fixed || []).slice(0, 3).join('; ') || 'Core angle and mechanism',
        hook_direction: `Use a completely different hook approach than the original — variation ${i + 1} of ${num_variations}`,
        body_direction: dirText,
        emotional_shift: winAnalysis.psychology?.emotional_arc
          ? `${winAnalysis.psychology.emotional_arc?.at_hook || '?'} → ${winAnalysis.psychology.emotional_arc?.final_state || '?'}`
          : 'Maintain original emotional arc',
      });
    }

    // Step 7: Generate ALL briefs in parallel
    console.log(`[BriefPipeline] Step 7: Generating ${directions.length} briefs in parallel`);

    // Extract proven scripts from product profile as style reference
    const provenScripts = productProfile?.scripts;
    const styleRef = Array.isArray(provenScripts) && provenScripts.length
      ? provenScripts.slice(0, 2).map((s, i) => `STYLE REF ${i + 1}: ${typeof s === 'string' ? s.slice(0, 300) : (s.text || s.body || JSON.stringify(s)).slice(0, 300)}`).join('\n\n')
      : '';

    let nextBriefNum = await getNextBriefNumber();

    // Generate all variations in parallel — each direction is naturally different
    const generationResults = await Promise.all(directions.map(async (direction) => {
      try {
        const { system: genSystem, user: genUser } = buildBriefGeneratorPrompt(parsedScript, winAnalysis, direction, config, productContext);
        let enhancedUser = genUser;
        if (styleRef) {
          enhancedUser += `\n\n# STYLE REFERENCE (proven scripts for this product — match this voice/tone)\n${styleRef}`;
        }
        // Add dedup instruction without needing previous outputs
        enhancedUser += `\n\n# VARIATION IDENTITY\nThis is variation ${direction.id} of ${directions.length}. Each variation follows a DIFFERENT iteration direction. Your creative approach must be COMPLETELY UNIQUE — different hook angles, different phrasing, different emotional entry point. Do NOT produce generic or safe copy.`;

        const generated = await callClaude(genSystem, enhancedUser, 3000);

        // Validate generated response has required fields
        if (!generated || (!generated.hooks && !generated.body)) {
          throw new Error('Claude returned invalid brief structure (missing hooks/body)');
        }
        if (!Array.isArray(generated.hooks)) generated.hooks = [];
        if (!generated.body) generated.body = '';

        // Step 8: Blend validation + Scoring IN PARALLEL (both read generated, don't depend on each other)
        const { system: blendSystem, user: blendUser } = buildBlendValidationPrompt(generated);
        const { system: scoreSystem, user: scoreUser } = buildBriefScorerPrompt(winner, parsedScript, generated, direction.name, winAnalysis, productContext);

        let blendResult = null;
        let scores = { novelty: { score: 5 }, aggression: { score: 5 }, coherence: { score: 5 }, hook_body_blend: { score: 5 }, conversion_potential: { score: 5 } };
        try {
          const [br, sc] = await Promise.all([
            callClaude(blendSystem, blendUser, 1000, { fast: true }),  // Haiku for blend check
            callClaude(scoreSystem, scoreUser, 1500),                  // Sonnet for scoring
          ]);
          blendResult = br;
          if (sc) scores = sc;
        } catch (evalErr) {
          console.warn(`[BriefPipeline] Scoring/blend error for direction #${direction.id}:`, evalErr.message);
        }

        // Incorporate blend validation into scores
        if (blendResult?.overall_blend != null) {
          scores.hook_body_blend = scores.hook_body_blend || {};
          scores.hook_body_blend.blend_validation = blendResult;
          if (blendResult.overall_blend < 6.5) {
            scores.hook_body_blend.score = Math.min(scores.hook_body_blend?.score ?? 5, Math.round(blendResult.overall_blend));
          }
        }

        const overall = scores.overall ?? (
          ((scores.novelty?.score ?? 5) * 0.15) +
          ((scores.aggression?.score ?? 5) * 0.15) +
          ((scores.coherence?.score ?? 5) * 0.25) +
          ((scores.hook_body_blend?.score ?? 5) * 0.15) +
          ((scores.conversion_potential?.score ?? 5) * 0.30)
        );

        return { generated, scores, overall, direction, success: true };
      } catch (dirErr) {
        console.error(`[BriefPipeline] Error generating direction #${direction.id}:`, dirErr.message);
        return { direction, success: false, error: dirErr.message };
      }
    }));

    // Step 9: Save all successful briefs to DB
    const generatedBriefs = [];
    for (const result of generationResults) {
      if (!result.success) continue;
      const { generated, scores, overall, direction } = result;

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
        editor: configEditor || winner.editor || 'Antoni',
        week: weekLabel,
      });

      try {
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
          winner.avatar, configEditor || winner.editor || 'Antoni',
          'Ludovico', 'NA', namingConvention,
        ], { timeout: 10000 });

        generatedBriefs.push({
          ...inserted[0],
          scores,
          direction,
        });
      } catch (dbErr) {
        console.error(`[BriefPipeline] DB insert error for direction #${direction.id}:`, dbErr.message);
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

    // Reset winner status back to detected so it stays in Winning Ads column
    await pgQuery(
      `UPDATE brief_pipeline_winners SET status = 'detected' WHERE id = $1`,
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
      `UPDATE brief_pipeline_winners SET status = 'detected' WHERE id = $1`,
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
      `SELECT g.*, w.parsed_script AS original_script, w.raw_script AS original_raw_script
       FROM brief_pipeline_generated g
       LEFT JOIN brief_pipeline_winners w ON g.winner_id = w.id
       WHERE g.status != 'rejected'
       ORDER BY g.overall_score DESC, g.created_at DESC`
    );
    res.json({ success: true, briefs: rows });
  } catch (err) {
    console.error('[BriefPipeline] GET /generated error:', err.message);
    res.status(500).json({ success: false, error: { message: err.message } });
  }
});

// GET /generated/:id — get generated brief detail
router.get('/generated/:id', authenticate, async (req, res) => {
  if (!validateUuid(req, res)) return;
  try {
    await ensureTables();
    const rows = await pgQuery(
      `SELECT g.*, w.parsed_script AS original_script, w.raw_script AS original_raw_script
       FROM brief_pipeline_generated g
       LEFT JOIN brief_pipeline_winners w ON g.winner_id = w.id
       WHERE g.id = $1`,
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
  if (!validateUuid(req, res)) return;
  try {
    await ensureTables();
    const reqBody = req.body || {};
    const { status: newStatus, hooks, body: briefBody } = reqBody;

    // If content edit (hooks/body) - handle this BEFORE status change
    if (hooks !== undefined || briefBody !== undefined) {
      const setClauses = [];
      const params = [];
      let idx = 1;
      if (hooks !== undefined) { setClauses.push(`hooks = $${idx++}`); params.push(JSON.stringify(hooks)); }
      if (briefBody !== undefined) { setClauses.push(`body = $${idx++}`); params.push(briefBody); }
      params.push(req.params.id);
      const rows = await pgQuery(
        `UPDATE brief_pipeline_generated SET ${setClauses.join(', ')} WHERE id = $${idx} RETURNING *`,
        params
      );
      if (!rows.length) return res.status(404).json({ success: false, error: { message: 'Brief not found' } });
      if (!newStatus) return res.json({ success: true, brief: rows[0] });
    }

    if (!['approved', 'rejected'].includes(newStatus)) {
      return res.status(400).json({ success: false, error: { message: 'Status must be "approved" or "rejected"' } });
    }

    // Only allow transitions from 'generated' status
    const extra = newStatus === 'approved' ? ', approved_at = NOW()' : '';
    const rows = await pgQuery(
      `UPDATE brief_pipeline_generated SET status = $1${extra} WHERE id = $2 AND status = 'generated' RETURNING *`,
      [newStatus, req.params.id]
    );

    if (!rows.length) {
      // Check if brief exists but is in wrong status
      const existing = await pgQuery(`SELECT id, status FROM brief_pipeline_generated WHERE id = $1`, [req.params.id]);
      if (existing.length) {
        return res.status(409).json({ success: false, error: { message: `Brief is already "${existing[0].status}" and cannot be changed.` } });
      }
    }

    if (!rows.length) {
      return res.status(404).json({ success: false, error: { message: 'Brief not found' } });
    }

    res.json({ success: true, brief: rows[0] });
  } catch (err) {
    console.error('[BriefPipeline] PATCH /generated/:id error:', err.message);
    res.status(500).json({ success: false, error: { message: err.message } });
  }
});

// POST /generated/:id/enhance — AI enhancement endpoint
router.post('/generated/:id/enhance', authenticate, async (req, res) => {
  if (!validateUuid(req, res)) return;
  try {
    const { instruction, currentHooks, currentBody } = req.body || {};

    if (!instruction?.trim()) {
      return res.status(400).json({ success: false, error: { message: 'Instruction is required' } });
    }

    // Verify brief exists
    const rows = await pgQuery(`SELECT * FROM brief_pipeline_generated WHERE id = $1`, [req.params.id]);
    if (!rows.length) return res.status(404).json({ success: false, error: { message: 'Brief not found' } });

    const hooksFormatted = (currentHooks || []).map((h, i) => `Hook ${i+1}: ${h.text}${h.mechanism ? ` [${h.mechanism}]` : ''}`).join('\n');

    const response = await fetch(CLAUDE_API_URL, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': ANTHROPIC_API_KEY,
        'anthropic-version': '2023-06-01',
      },
      body: JSON.stringify({
        model: CLAUDE_MODEL,
        max_tokens: 3000,
        messages: [{
          role: 'user',
          content: `You are an elite direct response copywriter editing an existing ad brief.

CURRENT BRIEF:
--- Hooks ---
${hooksFormatted}

--- Body ---
${currentBody || '(no body)'}

USER INSTRUCTION: ${instruction}

Apply the instruction and return the COMPLETE updated brief as JSON (no markdown, no code fences, just raw JSON):
{
  "hooks": [
    { "id": "H1", "text": "...", "mechanism": "..." },
    { "id": "H2", "text": "...", "mechanism": "..." }
  ],
  "body": "the complete updated body text"
}

RULES:
- Apply ONLY what the user asked for
- Keep everything else unchanged
- If asked to add a hook, add it as the next number
- If asked to change a specific hook, change ONLY that hook
- Return ALL hooks and the full body, not just changes
- Preserve the ad's tone and style`
        }],
      }),
    });

    const data = await response.json();
    const text = data.content?.[0]?.text || '';

    // Parse JSON from response
    let enhanced;
    try {
      const jsonMatch = text.match(/\{[\s\S]*\}/);
      enhanced = jsonMatch ? JSON.parse(jsonMatch[0]) : JSON.parse(text);
    } catch (parseErr) {
      return res.status(500).json({ success: false, error: { message: 'Failed to parse AI response' } });
    }

    res.json({
      success: true,
      hooks: enhanced.hooks || currentHooks,
      body: enhanced.body || currentBody,
    });
  } catch (err) {
    console.error('[BriefPipeline] POST /generated/:id/enhance error:', err.message);
    res.status(500).json({ success: false, error: { message: err.message } });
  }
});

// POST /generated/:id/push — push approved brief to ClickUp
router.post('/generated/:id/push', authenticate, async (req, res) => {
  if (!validateUuid(req, res)) return;
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

    // Look up parent winner's ClickUp task ID for the Frame.io reference link
    let parentClickupTaskId = null;
    if (brief.winner_id) {
      const winnerRows = await pgQuery(`SELECT clickup_task_id FROM brief_pipeline_winners WHERE id = $1`, [brief.winner_id]);
      parentClickupTaskId = winnerRows[0]?.clickup_task_id || null;
    }

    const result = await pushBriefToClickUp(brief, parentClickupTaskId);

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
      `SELECT g.*, w.clickup_task_id AS parent_clickup_task_id
       FROM brief_pipeline_generated g
       LEFT JOIN brief_pipeline_winners w ON g.winner_id = w.id
       WHERE g.status = 'approved' AND g.clickup_task_id IS NULL
       ORDER BY g.rank ASC`
    );

    if (!approvedRows.length) {
      return res.json({ success: true, pushed: 0, message: 'No approved briefs to push' });
    }

    const results = [];
    const errors = [];

    for (const brief of approvedRows) {
      try {
        const result = await pushBriefToClickUp(brief, brief.parent_clickup_task_id);

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

// ── Admin: Reset all winners back to detected ────────────────────────
router.post('/admin/reset-winners', authenticate, async (_req, res) => {
  try {
    await pgQuery(`UPDATE brief_pipeline_winners SET status = 'detected' WHERE status IN ('selected', 'generating', 'generated')`);
    await pgQuery(`DELETE FROM brief_pipeline_generated WHERE status = 'pushed'`);
    const rows = await pgQuery(`SELECT id, creative_id, status FROM brief_pipeline_winners ORDER BY detected_at DESC`);
    res.json({ success: true, message: 'All winners reset to detected', winners: rows });
  } catch (err) {
    console.error('[BriefPipeline] Reset error:', err.message);
    res.status(500).json({ success: false, error: { message: err.message } });
  }
});

export default router;
