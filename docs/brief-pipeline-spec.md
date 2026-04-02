
# Brief Pipeline — Full Technical Specification

## 1. Overview

The Brief Pipeline is the creative intelligence engine of Mineblock. It connects Creative Analysis (performance data) with ClickUp (production management) to automate the iteration cycle: detect winners → analyze why they work → generate new briefs → push to ClickUp.

### Core Loop
```
Creative Analysis → Winner Detection → Script Extraction → Pattern Analysis →
Brief Generation → Scoring → Approval → ClickUp Task Creation
```

### Tech Stack
- **Frontend**: React page at `/app/brief-pipeline`, same styling as Static Ads pipeline
- **Backend**: Express route at `/api/v1/brief-pipeline`
- **Database**: Postgres tables for pipeline state, generated briefs, analysis cache
- **External**: ClickUp API, Claude API (Anthropic), Creative Analysis data
- **Existing code to reuse**:
  - `briefAgent.js` — ClickUp field IDs, naming convention, task creation
  - `creativeAnalysis.js` — Performance data, naming parser, metrics
  - `iterationKing.js` — Claude script generation patterns
  - `clickupWebhook.js` — Task creation, status sync, naming generation

---

## 2. Database Schema

```sql
-- Winning ads detected from Creative Analysis
CREATE TABLE brief_pipeline_winners (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  creative_id TEXT NOT NULL,          -- e.g. "B0003"
  ad_name TEXT,                        -- full naming convention string
  product_code TEXT DEFAULT 'MR',
  angle TEXT,
  format TEXT,
  avatar TEXT,
  editor TEXT,
  hook_type TEXT,                       -- H1, H2, HX, etc.
  week TEXT,                            -- WK12_2026

  -- Performance metrics (snapshot at detection time)
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

  -- ClickUp iteration tracking
  clickup_task_id TEXT,                -- original task ID in ClickUp
  existing_iterations INTEGER DEFAULT 0,
  iteration_codes JSONB DEFAULT '[]',  -- ["B0122", "B0155"] existing IT codes

  -- Script content (pulled from ClickUp)
  raw_script TEXT,                     -- raw text from ClickUp task description
  parsed_script JSONB,                 -- structured {hooks: [], body: ""}

  -- Pipeline state
  status TEXT DEFAULT 'detected',      -- detected | selected | generating | generated | approved | pushed
  detected_at TIMESTAMPTZ DEFAULT NOW(),
  selected_at TIMESTAMPTZ,

  -- Winner classification
  winner_reason TEXT,                  -- "high_roas" | "rising_star" | "volume_winner" | "efficiency_winner"
  iteration_readiness TEXT,            -- "ready" | "over_iterated" | "not_enough_data"

  UNIQUE(creative_id)
);

-- Generated briefs (iterations)
CREATE TABLE brief_pipeline_generated (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  winner_id UUID REFERENCES brief_pipeline_winners(id),
  parent_creative_id TEXT NOT NULL,    -- B0003 (the ad we're iterating)

  -- Generation config
  iteration_mode TEXT,                 -- hook_only | hook_body | full_reinterpretation | angle_expansion | competitor_reframing
  aggressiveness TEXT DEFAULT 'medium', -- conservative | medium | aggressive | extreme

  -- AI Analysis (why the original won)
  win_analysis JSONB,                  -- structured analysis of why the ad works

  -- Generated content
  hooks JSONB DEFAULT '[]',            -- [{id: "H1", text: "..."}, ...]
  body TEXT,
  iteration_direction TEXT,            -- what was changed and why

  -- Scoring
  novelty_score NUMERIC(3,1),          -- 1-10: how different from original
  aggression_score NUMERIC(3,1),       -- 1-10: how bold the claims are
  coherence_score NUMERIC(3,1),        -- 1-10: does it hold together
  overall_score NUMERIC(3,1),          -- weighted average
  rank INTEGER,                        -- rank among siblings

  -- Naming convention fields (pre-computed for ClickUp)
  brief_number INTEGER,                -- next available B number
  product_code TEXT DEFAULT 'MR',
  angle TEXT,
  format TEXT,
  avatar TEXT,
  editor TEXT,
  strategist TEXT DEFAULT 'Ludovico',
  creator TEXT DEFAULT 'NA',
  naming_convention TEXT,              -- full computed string

  -- Pipeline state
  status TEXT DEFAULT 'generated',     -- generated | approved | rejected | pushed
  clickup_task_id TEXT,                -- set after push to ClickUp
  clickup_task_url TEXT,

  created_at TIMESTAMPTZ DEFAULT NOW(),
  approved_at TIMESTAMPTZ,
  pushed_at TIMESTAMPTZ
);

-- Analysis cache (avoid re-analyzing same scripts)
CREATE TABLE brief_pipeline_analysis_cache (
  creative_id TEXT PRIMARY KEY,
  script_hash TEXT,                    -- MD5 of raw script for cache invalidation
  win_analysis JSONB,
  analyzed_at TIMESTAMPTZ DEFAULT NOW()
);
```

---

## 3. Pipeline Columns & UI

### Column 1: "Winning Ads Detected"
**Auto-populated from Creative Analysis data.**

Each card shows:
- **Brief code**: B0003
- **Ad name**: Full naming convention
- **Product**: MR (Miner Forge Pro)
- **Angle**: Againstcompetition
- **Format**: Mashup
- **Hook type**: HX
- **Performance metrics**: Spend, CPA, ROAS, CTR (last 7 days)
- **Existing iterations**: "3 iterations in ClickUp" (with codes: B0122, B0155, B0189)
- **Status badge**:
  - **Ready for iteration** — ROAS ≥ 1.5, spend ≥ $100, < 8 iterations
  - **Over-iterated** — ≥ 8 existing iterations
  - **Not enough data** — spend < $100 or < 7 days running

### Column 2: "Selected for Iteration"
**User drags/selects cards here to build the queue.**

Controls per card:
- **Number of variations**: 3 / 5 / 10
- **Iteration mode** (dropdown):
  - `hook_only` — New hooks, same body
  - `hook_body` — New hooks + modified body
  - `full_reinterpretation` — Complete rewrite, same angle
  - `angle_expansion` — Same mechanism, different angle
  - `competitor_reframing` — Reframe against a different enemy
- **Aggressiveness** (slider):
  - `conservative` — Minor tweaks, safe claims
  - `medium` — Moderate changes, proven patterns
  - `aggressive` — Bold claims, new hooks
  - `extreme` — Shock value, maximum divergence
- **Fixed elements** (multi-select checkboxes):
  - Keep hook mechanism
  - Keep proof type
  - Keep CTA structure
  - Keep villain/enemy
  - Keep emotional driver
- **Generate button** — Triggers the full generation pipeline

### Column 3: "Generated"
**AI-generated briefs land here after scoring.**

Each card shows:
- **Brief preview**: Hooks + body snippet
- **Scores**: Novelty / Aggression / Coherence / Overall
- **Iteration direction**: "Shifted from scam-fear to FOMO — now positions ownership as status symbol"
- **Parent reference**: "Iteration of B0003"
- **Naming convention preview**: `MR - B0122 - IT - B0003 - NA - Againstcompetition - Mashup - Ludovico - NA - Antoni - WK14_2026`

Actions:
- **View full brief** — Opens detail modal with full hooks + body + analysis
- **Approve** → Moves to Approved
- **Reject** → Removes from pipeline

### Column 4: "Approved"
**User-approved briefs waiting to be pushed.**

Actions:
- **Create in ClickUp** — Creates task in Video Ads pipeline with full naming convention, script in description, all custom fields set
- **Batch push** — Push all approved at once

### Column 5: "Pushed to ClickUp"
**Completed briefs with ClickUp links.**

Shows:
- ClickUp task link
- Created date
- Naming convention

---

## 4. Backend API Endpoints

```
GET    /api/v1/brief-pipeline/winners          — List all detected winners
POST   /api/v1/brief-pipeline/detect           — Run winner detection from Creative Analysis
GET    /api/v1/brief-pipeline/winners/:id       — Get winner detail + ClickUp script
POST   /api/v1/brief-pipeline/winners/:id/select — Move to "Selected" with config
POST   /api/v1/brief-pipeline/generate/:id      — Run full generation pipeline for a winner
GET    /api/v1/brief-pipeline/generated         — List all generated briefs
GET    /api/v1/brief-pipeline/generated/:id     — Get generated brief detail
PATCH  /api/v1/brief-pipeline/generated/:id     — Update status (approve/reject)
POST   /api/v1/brief-pipeline/generated/:id/push — Push approved brief to ClickUp
POST   /api/v1/brief-pipeline/batch-push        — Push all approved briefs
GET    /api/v1/brief-pipeline/stats             — Pipeline stats (counts per column)
```

---

## 5. Step-by-Step Logic & Prompts

---

### STEP 1: Winner Detection
**Trigger**: Manual or scheduled (daily)
**Source**: `creative_analysis` table

```javascript
// Query: Find winning ads from the last 7 days
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
`);
```

**Classification logic:**
```javascript
function classifyWinner(winner) {
  if (winner.roas >= 3.0 && winner.total_spend >= 500) return 'volume_winner';
  if (winner.roas >= 2.0) return 'high_roas';
  if (winner.total_spend >= 50 && winner.total_spend <= 500 && winner.roas >= 1.5) return 'rising_star';
  if (winner.cpa <= 20) return 'efficiency_winner';
  return 'high_roas';
}

function classifyReadiness(winner, existingIterations) {
  if (winner.total_spend < 100) return 'not_enough_data';
  if (existingIterations >= 8) return 'over_iterated';
  return 'ready';
}
```

---

### STEP 2: ClickUp Iteration Count
**For each detected winner, count existing iterations in ClickUp.**

```javascript
async function countIterations(creativeId) {
  // e.g. creativeId = "B0003"
  let page = 0, hasMore = true;
  const iterations = [];

  while (hasMore) {
    const data = await clickupFetch(
      `/list/${VIDEO_ADS_LIST}/task?page=${page}&limit=100&include_closed=true&subtasks=true`
    );
    const tasks = data.tasks || [];

    for (const task of tasks) {
      // Check parentBriefId field
      const parentField = task.custom_fields?.find(f => f.id === FIELD_IDS.parentBriefId);
      const briefTypeField = task.custom_fields?.find(f => f.id === FIELD_IDS.briefType);

      // Check if this task is an IT (iteration) of our creative
      const briefType = briefTypeField?.type_config?.options?.find(
        o => o.orderindex === briefTypeField?.value
      )?.name;

      if (briefType === 'IT') {
        // Check if parent matches our creative
        const parentValue = parentField?.value;
        if (parentValue && parentValue.includes(creativeId)) {
          const briefMatch = task.name?.match(/B(\d{2,5})/);
          if (briefMatch) {
            iterations.push({
              code: `B${briefMatch[1].padStart(4, '0')}`,
              taskId: task.id,
              name: task.name,
              status: task.status?.status
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
```

---

### STEP 3: Script Extraction from ClickUp
**Pull the raw script from the ClickUp task description.**

```javascript
async function extractScript(clickupTaskId) {
  const task = await clickupFetch(`/task/${clickupTaskId}`);
  const description = task.description || task.text_content || '';

  // Also check comments for script content
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
```

---

### STEP 4: Script Parser Prompt
**Converts raw ClickUp text into structured hooks + body.**

```
SYSTEM: You are a script parser for video ad briefs. Extract the structured components from the raw script text below.

RAW SCRIPT:
{raw_script}

TASK NAME: {task_name}

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
- If the script has multiple sections (e.g. "Body:", "CTA:"), respect those boundaries
```

---

### STEP 5: Win Analysis Prompt
**Analyzes WHY an ad is winning. This runs BEFORE iteration.**

```
SYSTEM: You are a world-class direct response copywriter and ad creative strategist. You've generated over $500M in tracked revenue from paid social ads. Your job is to perform a surgical analysis of WHY this ad script is winning.

WINNING AD CONTEXT:
- Brief Code: {creative_id}
- Product: MinerForge Pro — a mini Bitcoin miner, $59.99, 144 daily mining attempts, plug-and-play
- Angle: {angle}
- Format: {format}
- Performance (last 7 days):
  - Spend: ${spend}
  - ROAS: {roas}x
  - CPA: ${cpa}
  - CTR: {ctr}%
  - Purchases: {purchases}

WINNING SCRIPT:
Hooks:
{hooks_formatted}

Body:
{body}

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
}
```

---

### STEP 6: Iteration Strategy Prompt
**Proposes specific directions based on analysis + config.**

```
SYSTEM: You are an iteration strategist for direct response video ads. Based on the win analysis of a proven ad, you propose specific iteration directions that preserve what works while introducing strategic variation.

WIN ANALYSIS:
{win_analysis_json}

ORIGINAL SCRIPT:
Hooks: {hooks}
Body: {body}

ITERATION CONFIG:
- Mode: {iteration_mode}
- Aggressiveness: {aggressiveness}
- Number of variations: {num_variations}
- Fixed elements: {fixed_elements}
- Elements that can change: {changeable_elements}

PRODUCT CONTEXT:
- Product: MinerForge Pro
- Price: $59.99
- Key promise: 144 daily Bitcoin mining attempts, keep 100% of block reward
- Winning angles: Lottery, Against Competition, BTC Made Easy, Hidden Opportunity, Scarcity
- Discount code: MINER10

Based on the analysis, propose exactly {num_variations} distinct iteration directions.

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
      "what_changes": "New H1 uses victim testimonial hook. H2 uses data-shock. Body adds 'I lost $X' proof element.",
      "what_stays": "Blockchain verification proof. Side-by-side comparison. CTA logic.",
      "why_it_could_win": "Victim stories have 2.3x higher hook rates in crypto niche",
      "expected_lift": "medium",
      "risk": "safe",
      "hook_direction": "Open with 'My neighbor bought a $30 Bitcoin miner. Here's what happened.'",
      "body_direction": "Same proof sequence but add victim context before the comparison",
      "emotional_shift": "fear → empathy → fear → solution"
    }
  ]
}
```

---

### STEP 7: Brief Generation Prompt
**Generates the actual script variations.**

```
SYSTEM: You are an elite direct response copywriter for crypto/Bitcoin products. You write scripts that convert cold traffic into buyers. Your scripts are aggressive, specific, and impossible to scroll past.

You are generating iteration #{direction_number} of a winning ad.

ORIGINAL WINNING SCRIPT:
Hooks:
{original_hooks}

Body:
{original_body}

WIN ANALYSIS:
{win_analysis_summary}

ITERATION DIRECTION:
{direction_description}
- What changes: {what_changes}
- What stays: {what_stays}
- Hook direction: {hook_direction}
- Body direction: {body_direction}
- Emotional shift: {emotional_shift}

PRODUCT CONTEXT:
- Product: MinerForge Pro — a mini plug-and-play Bitcoin mining device
- Price: $59.99 (bundles: 2 for $109.99, 3+1 free for $179.99)
- Key facts: 144 daily mining attempts, 1 watt power, solo mining, keep 100% of block reward
- Discount: MINER10
- What it is NOT: NOT a USB stick, NOT a flash drive. It's a compact electronic device with a display screen.

ITERATION MODE: {iteration_mode}
AGGRESSIVENESS: {aggressiveness}

RULES:
1. Write exactly 3 hooks (H1, H2, H3) — each must be a COMPLETELY different approach to stopping the scroll
2. H1 = strongest hook (the one you'd bet money on)
3. Every hook must be under 25 words
4. Hooks must contain a SPECIFIC claim, number, or provocative statement — no vague generalities
5. The body must flow naturally from any of the 3 hooks
6. Body should be 150-300 words (60-90 seconds when read aloud)
7. Include a clear CTA with the discount code MINER10
8. Match the aggressiveness level: {aggressiveness}
9. NEVER use these weak phrases: "works at home", "easy to use", "get started today", "join the revolution"
10. Every sentence must either create tension, provide proof, or drive toward the CTA
11. Pricing must be accurate: $59.99 base, bundles as listed above
12. Respect the iteration direction — this is not a free rewrite, it's a STRATEGIC variation

HOOK QUALITY CHECKLIST (every hook must pass ALL):
- [ ] Contains a specific number, dollar amount, or timeframe
- [ ] Creates an information gap or emotional reaction
- [ ] Could NOT be used for any other product (it's specific to Bitcoin mining)
- [ ] A normal person would stop scrolling to find out more
- [ ] It does NOT sound like a product description or tagline

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
}
```

---

### STEP 8: Brief Scoring Prompt
**Scores and ranks generated briefs.**

```
SYSTEM: You are a performance media buyer who has spent $50M+ on paid social. You evaluate ad scripts purely on their likelihood to convert cold traffic. You are ruthlessly honest — most scripts are mediocre.

ORIGINAL WINNING SCRIPT (baseline):
{original_script}

ORIGINAL PERFORMANCE:
- ROAS: {roas}x
- CPA: ${cpa}
- CTR: {ctr}%

GENERATED BRIEF #{n}:
Hooks:
{generated_hooks}

Body:
{generated_body}

ITERATION DIRECTION: {direction_name}

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
  "one_line_feedback": "The scam-comparison hook is strong but the body loses tension in paragraph 3 — tighten the proof section.",
  "suggested_improvement": "optional one-sentence fix if verdict is MAYBE"
}
```

---

### STEP 9: ClickUp Task Creation
**Push approved brief to ClickUp Video Ads pipeline.**

```javascript
// Reuse existing briefAgent.js logic
async function pushBriefToClickUp(generatedBrief) {
  const {
    brief_number, product_code, angle, format, avatar,
    editor, strategist, creator, parent_creative_id, hooks, body
  } = generatedBrief;

  // Build naming convention
  // Format: MR - B0122 - IT - B0003 - NA - Againstcompetition - Mashup - Ludovico - NA - Antoni - WK14_2026
  const briefId = `B${String(brief_number).padStart(4, '0')}`;
  const weekLabel = getCurrentWeekLabel(); // WK14_2026

  // Map to creative type code
  const creativeTypeCode = CREATIVE_TYPE_CODES[format] || 'HX'; // Mashup → HX

  const namingConvention = [
    product_code,        // MR
    briefId,             // B0122
    'IT',                // always IT for iterations
    parent_creative_id,  // B0003
    avatar || 'NA',
    angle,               // Againstcompetition
    format,              // Mashup
    strategist,          // Ludovico
    creator || 'NA',
    editor,              // Antoni
    weekLabel            // WK14_2026
  ].join(' - ');

  // Build description with script
  const hooksFormatted = hooks
    .map(h => `${h.id}\n${h.text}`)
    .join('\n\n');

  const description = `Hooks:\n\n${hooksFormatted}\n\nBody:\n\n${body}`;

  // Resolve dropdown option IDs
  const angleUuid = ANGLE_OPTIONS[angle] || ANGLE_OPTIONS.NA;
  const briefTypeUuid = BRIEF_TYPE_OPTIONS.IT;
  const creativeTypeUuid = CREATIVE_TYPE_OPTIONS[format] || CREATIVE_TYPE_OPTIONS.Mashup;

  // Create task
  const task = await clickupFetch(`/list/${VIDEO_ADS_LIST}/task`, {
    method: 'POST',
    body: JSON.stringify({
      name: namingConvention,
      description,
      status: 'open',
      custom_fields: [
        { id: FIELD_IDS.briefNumber, value: brief_number },
        { id: FIELD_IDS.briefType, value: briefTypeUuid },
        { id: FIELD_IDS.parentBriefId, value: parent_creative_id },
        { id: FIELD_IDS.angle, value: angleUuid },
        { id: FIELD_IDS.creativeType, value: creativeTypeUuid },
        { id: FIELD_IDS.namingConvention, value: namingConvention },
        { id: FIELD_IDS.creationWeek, value: weekLabel },
        { id: FIELD_IDS.creativeStrategist, value: USER_IDS.Ludovico },
      ],
      assignees: [USER_IDS[editor] || USER_IDS.Antoni],
    }),
  });

  // Set relationship fields (can't be set in creation payload)
  const productTaskId = PRODUCT_TASK_IDS[product_code] || PRODUCT_TASK_IDS.MR;
  if (productTaskId) {
    await clickupFetch(`/task/${task.id}/field/${FIELD_IDS.product}`, {
      method: 'POST',
      body: JSON.stringify({ value: { add: [productTaskId], rem: [] } }),
    });
  }

  return {
    taskId: task.id,
    taskUrl: task.url || `https://app.clickup.com/t/${task.id}`,
    namingConvention,
  };
}
```

---

## 6. Generation Pipeline Flow (Combined)

```
┌─────────────────────────────────────────────────────────────────────┐
│  STEP 1: DETECT WINNERS                                            │
│  Source: creative_analysis table                                    │
│  Filter: spend ≥ $100, ROAS ≥ 1.5, last 7 days                   │
│  Output: List of winning creative_ids with metrics                  │
└────────────────────────┬────────────────────────────────────────────┘
                         ▼
┌─────────────────────────────────────────────────────────────────────┐
│  STEP 2: COUNT ITERATIONS                                           │
│  Source: ClickUp API (VIDEO_ADS_LIST)                               │
│  Action: For each winner, count tasks where briefType=IT            │
│          and parentBriefId matches                                   │
│  Output: iteration count + codes per winner                          │
└────────────────────────┬────────────────────────────────────────────┘
                         ▼
┌─────────────────────────────────────────────────────────────────────┐
│  STEP 3: EXTRACT SCRIPT                                             │
│  Source: ClickUp task description + comments                        │
│  Action: Pull raw text from the original brief's ClickUp task       │
│  Output: Raw script text                                             │
└────────────────────────┬────────────────────────────────────────────┘
                         ▼
┌─────────────────────────────────────────────────────────────────────┐
│  STEP 4: PARSE SCRIPT (Claude)                                      │
│  Prompt: Script Parser                                               │
│  Input: Raw script text                                              │
│  Output: Structured {hooks[], body, cta, villains[], proof[]}       │
└────────────────────────┬────────────────────────────────────────────┘
                         ▼
┌─────────────────────────────────────────────────────────────────────┐
│  STEP 5: ANALYZE WIN PATTERN (Claude)                               │
│  Prompt: Win Analysis                                                │
│  Input: Structured script + performance metrics                      │
│  Output: 8-dimension analysis JSON (cached in DB)                    │
└────────────────────────┬────────────────────────────────────────────┘
                         ▼
┌─────────────────────────────────────────────────────────────────────┐
│  STEP 6: PROPOSE DIRECTIONS (Claude)                                │
│  Prompt: Iteration Strategy                                          │
│  Input: Win analysis + iteration config (mode, aggression, etc.)    │
│  Output: N distinct iteration directions with rationale              │
└────────────────────────┬────────────────────────────────────────────┘
                         ▼
┌─────────────────────────────────────────────────────────────────────┐
│  STEP 7: GENERATE BRIEFS (Claude × N)                               │
│  Prompt: Brief Generator (called once per direction)                 │
│  Input: Original script + direction + product context                │
│  Output: N complete scripts with hooks + body                        │
└────────────────────────┬────────────────────────────────────────────┘
                         ▼
┌─────────────────────────────────────────────────────────────────────┐
│  STEP 8: SCORE & RANK (Claude)                                      │
│  Prompt: Brief Scorer (called once per generated brief)              │
│  Input: Original script + generated script + metrics                 │
│  Output: Scores (novelty, aggression, coherence, conversion)         │
│  Action: Sort by overall score, assign ranks                         │
└────────────────────────┬────────────────────────────────────────────┘
                         ▼
┌─────────────────────────────────────────────────────────────────────┐
│  STEP 9: DISPLAY IN "GENERATED" COLUMN                              │
│  Show: Ranked cards with scores, preview, direction label            │
│  User action: Approve / Reject                                       │
└────────────────────────┬────────────────────────────────────────────┘
                         ▼
┌─────────────────────────────────────────────────────────────────────┐
│  STEP 10: PUSH TO CLICKUP                                           │
│  Action: Create task in VIDEO_ADS_LIST with:                        │
│  - Full naming convention                                            │
│  - Script in description                                             │
│  - All custom fields (angle, format, editor, brief type=IT, etc.)   │
│  - Assigned to selected editor                                       │
│  Output: ClickUp task URL                                            │
└─────────────────────────────────────────────────────────────────────┘
```

---

## 7. Claude API Usage

All Claude calls use the Anthropic SDK (already configured in `iterationKing.js`).

| Step | Prompt | Model | Max Tokens | Estimated Cost/Call |
|------|--------|-------|------------|---------------------|
| 4. Script Parser | Simple extraction | claude-sonnet-4-20250514 | 2,000 | ~$0.01 |
| 5. Win Analysis | Deep analysis | claude-sonnet-4-20250514 | 4,000 | ~$0.03 |
| 6. Iteration Strategy | Strategic planning | claude-sonnet-4-20250514 | 3,000 | ~$0.02 |
| 7. Brief Generation | Creative writing (×N) | claude-sonnet-4-20250514 | 3,000 | ~$0.02 each |
| 8. Brief Scoring | Evaluation (×N) | claude-sonnet-4-20250514 | 1,500 | ~$0.01 each |

**For 5 variations**: ~$0.16 total per winner iteration cycle.

---

## 8. Existing Code to Reuse

| Component | File | What to reuse |
|-----------|------|---------------|
| ClickUp field IDs | `briefAgent.js:34-49` | All custom field UUIDs |
| Dropdown options | `briefAgent.js:52-83` | Angle, format, brief type mappings |
| Task creation | `briefAgent.js:318+` | Create task with naming convention |
| Naming convention | `clickupWebhook.js:168-192` | Name generation pattern |
| Ad name parser | `creativeAnalysis.js:67-275` | Parse B0003, angle, format from ad names |
| Performance data | `creativeAnalysis.js:858+` | GET /data endpoint |
| Claude streaming | `iterationKing.js:295+` | SSE pattern for long generations |
| Pipeline UI | `StaticsGeneration.jsx` | Column layout, card components |
| PipelineView | `statics/PipelineView.jsx` | Kanban column component |

---

## 9. File Structure

```
server/src/routes/
  briefPipeline.js              — All API endpoints

client/src/pages/production/
  BriefPipeline.jsx             — Main page component
  briefs/
    WinnerCard.jsx              — Card for detected winners
    GeneratedBriefCard.jsx      — Card for generated briefs
    BriefDetailModal.jsx        — Full brief view modal
    IterationConfigPanel.jsx    — Config sidebar (mode, aggression, etc.)
    WinAnalysisView.jsx         — Visual display of win analysis
```

---

## 10. Key Constants Reference

```javascript
// ClickUp
const VIDEO_ADS_LIST = '901518716584';
const MEDIA_BUYING_LIST = '901518769621';
const CLICKUP_TOKEN = process.env.CLICKUP_API_TOKEN;

// Field IDs (from briefAgent.js)
const FIELD_IDS = {
  briefNumber:        '62b61cc4-2d35-4dfc-86f4-a3913e2bbca3',
  briefType:          '98d04d2d-9575-4363-8eee-9bf150b1c319',
  parentBriefId:      '4f72235e-0a41-4824-9e67-d27e38ba16d9',
  idea:               '0c5460ee-2645-4892-815d-7913fb5d241d',
  angle:              '7e740c52-a05b-4b3b-9798-0801acd84b8a',
  creativeType:       'b7f50dff-c752-47a7-830d-c3780021a27f',
  editor:             'a9613cd9-715a-4a2a-bbbb-fbb7f664980a',
  creationWeek:       'a609d8d0-661e-400f-87cb-2557bd48857b',
  creativeStrategist: '372d59af-e573-4eb4-be9f-31cb02f3ad5b',
  namingConvention:   'c97d93bc-ad82-4b90-98e0-092df383d9b8',
  product:            '7bc3b414-363e-421e-9445-473b4b8ccf18',
  avatar:             '4ad59f88-89cc-45e5-bc56-0027a4ab8624',
  creator:            'be5a2a58-f355-4fac-8263-2824725eaa64',
};

// Dropdown Options
const ANGLE_OPTIONS = {
  NA: '2933a618-a7aa-4b42-9e61-c5ee9e0903e5',
  Lottery: '4a493db2-441e-46db-9c58-7b7c3fd0a163',
  Againstcompetition: '0efc2411-1a1a-4d1d-96c6-760e6cff503e',
  'BTC Made easy': '4a1ef4f4-d3e1-4dd3-90a5-b2bd9303d423',
  // ... (full list in briefAgent.js:52-66)
};

const BRIEF_TYPE_OPTIONS = { NN: '...', IT: '...' };
const CREATIVE_TYPE_OPTIONS = { Mashup: '...', ShortVid: '...', /* ... */ };

// Creative Type Codes (for naming)
const CREATIVE_TYPE_CODES = {
  Mashup: 'HX', ShortVid: 'VX', UGC: 'UX',
  VSL: 'VL', 'Mini VSL': 'MV', 'Long VSL': 'LV', Cartoon: 'CT'
};

// User IDs
const USER_IDS = {
  Ludovico: 266421907, Antoni: 94595626,
  Faiz: 170558610, Uly: 106674594
};

// Product Relationship IDs
const PRODUCT_TASK_IDS = { MR: '86c75fure', TX: '86c7jxxtj' };
const AVATAR_TASK_IDS = {
  Cryptoaddict: '86c7hf58v', MoneySeeker: '86c7m5417',
  'Test Avatar': '86c75fyjh', Aware: '86c8jhvfk'
};
```
