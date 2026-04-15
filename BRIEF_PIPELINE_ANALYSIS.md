# Mineblock Brief Pipeline — Complete Architecture Analysis

## EXECUTIVE SUMMARY

The Mineblock Brief Pipeline is a sophisticated AI-driven creative iteration system that automatically detects winning video ads and generates optimized variations using Claude API. The system has a full-stack architecture with:

- **Frontend**: React dashboard with Kanban-style workflow (5 columns)
- **Backend**: Node.js/Express REST API with PostgreSQL state management
- **AI**: Claude Sonnet for analysis + generation, Gemini 2.0 Flash for video transcription
- **External**: ClickUp integration, Meta Ads API, Creative Analysis data

---

## 1. ARCHITECTURE OVERVIEW

### System Flow
```
Creative Analysis (Meta data) 
    ↓
Winner Detection (automatic)
    ↓
Script Extraction (ClickUp or video transcription via Gemini)
    ↓
Deep Analysis (3 parallel Claude agents)
    ↓
Brief Generation (parallel variants or 1:1 clone)
    ↓
Scoring & Ranking (Claude evaluation)
    ↓
Save to Database
    ↓
Push to ClickUp
```

### Technology Stack
- **Frontend**: React 18, TailwindCSS, Lucide Icons
- **Backend**: Node.js (ESM), Express.js
- **Database**: PostgreSQL (Render.com hosted)
- **AI Models**:
  - `claude-sonnet-4-6` — Main generation & analysis
  - `claude-haiku-4-5-20251001` — Fast operations (parsing, scoring)
  - `gemini-2.0-flash` — Video transcription (primary)
  - `gemini-2.0-flash-lite` — Video transcription fallback
- **External APIs**: ClickUp API v2, Meta Graph API v21, Anthropic API, Google Generative AI

---

## 2. FRONTEND ARCHITECTURE

### Main Page: `/pages/production/BriefPipeline.jsx`

**5-Column Kanban Layout**:
1. **Generated** — AI-created briefs (icon: Sparkles)
2. **Approved** — User-approved briefs (icon: CheckCircle2)
3. **Pushed** — Sent to ClickUp (icon: Rocket)
4. **Ready to Launch** — Staging area (icon: Send)
5. **Launched** — Completed (icon: Zap)

**Key Components**:
- `WinnerCard.jsx` — Displays detected winning ads
- `GeneratedBriefCard.jsx` — Shows generated brief previews
- `ScriptGeneratorPanel.jsx` — Form for manual brief generation
- `BriefDetailModal.jsx` — Full brief viewer/editor
- `WinnerDetailModal.jsx` — Winner details + analysis
- `LaunchTemplateEditor.jsx` — Template management
- `AdCopySetsManager.jsx` — Copy set organization

### ScriptGeneratorPanel Input Modes

The panel has TWO generation pathways:

#### Path 1: Manual Script Generation (`/generate-from-script`)
```javascript
const handleGenerateFromScript = async (config) => {
  await api.post('/brief-pipeline/generate-from-script', {
    script: config.script,           // Pasted text
    url: config.url,                 // FB Ad Library or video URL
    productCode: config.productCode,
    angle: config.angle,             // Optional: "Lottery", "Scarcity", etc.
    mode: config.mode,               // "clone" or "variants"
    numVariations: config.numVariations, // 2-5 variants
  });
}
```

#### Path 2: Auto-Detection from Winners (`/generate/:id`)
```javascript
const handleGenerate = async (winnerId, config) => {
  await api.post(`/brief-pipeline/generate/${winnerId}`, config);
}
```

**Two Output Modes**:
1. **Generate Variants** (default):
   - Creates N independent brief variations (2-5)
   - Each variation is a unique creative direction
   - Different hooks, different body angles
   - All parallel generation
   
2. **1:1 Script Clone**:
   - Creates a single brief that maps the reference script beat-for-beat
   - Same structure, same pacing, same emotional arc
   - ONLY product/avatar details swapped
   - Used for "proven winners" that need adaptation

---

## 3. BACKEND API ROUTES

### Core Routes

#### `GET /brief-pipeline/winners`
- Lists all detected winning ads
- Returns: array of `brief_pipeline_winners` records
- Status filter: `detected`, `selected`, `generating`

#### `POST /brief-pipeline/detect`
- Triggers winner detection from Creative Analysis
- Queries last 7 days of performance data
- Filters: ROAS ≥ 1.5, spend ≥ $100
- Creates new `brief_pipeline_winners` records

#### `GET /brief-pipeline/winners/:id`
- Get winner detail with parsed script
- Extracts script from ClickUp if not cached
- Returns performance metrics + script content

#### `POST /brief-pipeline/winners/:id/select`
- User selects a winner for generation
- Saves generation config (mode, aggressiveness, # of variants)
- Updates status → `selected`

#### `POST /brief-pipeline/generate/:id`
- **MAIN GENERATION ENDPOINT**
- Triggers full pipeline: parse → analyze → generate → score → save
- Works on `detected` or `selected` winners
- Atomic status update: `generating` state prevents concurrent runs

#### `POST /brief-pipeline/generate-from-script` ⭐
- **MANUAL GENERATION ENDPOINT**
- Accepts raw script text OR URL (with auto-transcription)
- Supports both **Clone Mode** and **Variants Mode**
- Creates virtual winner record if needed
- Returns array of generated briefs

#### `GET /brief-pipeline/generated`
- Lists all generated briefs
- Ordered by `overall_score DESC`
- Includes original script + analysis

#### `PATCH /brief-pipeline/generated/:id`
- Update brief status
- Moves between columns: `generated` → `approved` → `pushed` → `ready_to_launch`

#### `POST /brief-pipeline/generated/:id/push`
- Push approved brief to ClickUp
- Creates task with full naming convention
- Sets all custom fields (product, angle, format, etc.)
- Returns ClickUp task URL

#### `POST /brief-pipeline/batch-push`
- Push all approved briefs to ClickUp in parallel

---

## 4. DATABASE SCHEMA

### Table: `brief_pipeline_winners`
```sql
CREATE TABLE brief_pipeline_winners (
  id UUID PRIMARY KEY,
  creative_id TEXT UNIQUE,     -- e.g. "B0003"
  ad_name TEXT,                -- Full naming convention
  
  -- Identifiers
  product_code TEXT,           -- "MR", "TX"
  angle TEXT,                  -- "Against competition", "Lottery", etc.
  format TEXT,                 -- "Mashup", "VSL", "ShortVid"
  avatar TEXT,                 -- Avatar name
  editor TEXT,                 -- Person who edited
  hook_type TEXT,              -- H1, H2, HX
  week TEXT,                   -- WK12_2026
  
  -- Performance (snapshot at detection)
  spend NUMERIC,
  revenue NUMERIC,
  roas NUMERIC,
  purchases INTEGER,
  cpa NUMERIC,
  ctr NUMERIC,
  impressions BIGINT,
  clicks BIGINT,
  cpm NUMERIC,
  aov NUMERIC,
  
  -- Content
  raw_script TEXT,             -- Extracted from ClickUp or transcribed
  parsed_script JSONB,         -- {hooks: [{id, text}, ...], body: "...", cta: "..."}
  
  -- State
  status TEXT,                 -- detected|selected|generating|generated|approved|pushed
  detected_at TIMESTAMPTZ,
  selected_at TIMESTAMPTZ,
  
  -- ClickUp
  clickup_task_id TEXT,
  existing_iterations INTEGER,
  iteration_codes JSONB,       -- ["B0122", "B0155"]
  
  -- Classification
  winner_reason TEXT,          -- high_roas|rising_star|volume_winner|efficiency_winner
  iteration_readiness TEXT,    -- ready|over_iterated|not_enough_data
  
  -- Video
  thumbnail_url TEXT,
  video_url TEXT
);
```

### Table: `brief_pipeline_generated`
```sql
CREATE TABLE brief_pipeline_generated (
  id UUID PRIMARY KEY,
  winner_id UUID REFERENCES brief_pipeline_winners(id),
  parent_creative_id TEXT,     -- Which winner this is based on
  
  -- Generation config
  iteration_mode TEXT,         -- "clone" or "hook_body"
  aggressiveness TEXT,         -- "medium", etc.
  
  -- AI Analysis
  win_analysis JSONB,          -- {scriptDna, psychology, iterationRules}
  
  -- Content
  hooks JSONB,                 -- [{id: "H1", text: "..."}, ...]
  body TEXT,
  iteration_direction TEXT,    -- What changed and why
  
  -- Scoring
  novelty_score NUMERIC(3,1),
  aggression_score NUMERIC(3,1),
  coherence_score NUMERIC(3,1),
  overall_score NUMERIC(3,1),
  verdict TEXT,
  scores_json JSONB,
  rank INTEGER,
  
  -- Naming convention
  brief_number INTEGER,
  product_code TEXT,
  angle TEXT,
  format TEXT,
  avatar TEXT,
  editor TEXT,
  strategist TEXT,
  creator TEXT,
  naming_convention TEXT,
  
  -- State
  status TEXT,                 -- generated|approved|rejected|pushed
  clickup_task_id TEXT,
  clickup_task_url TEXT,
  created_at TIMESTAMPTZ,
  approved_at TIMESTAMPTZ,
  pushed_at TIMESTAMPTZ
);
```

### Table: `brief_pipeline_analysis_cache`
```sql
CREATE TABLE brief_pipeline_analysis_cache (
  creative_id TEXT PRIMARY KEY,
  script_hash TEXT,            -- MD5(raw_script)
  win_analysis JSONB,          -- Cached 3-agent analysis
  analyzed_at TIMESTAMPTZ
);
```

---

## 5. GENERATION FLOW DEEP DIVE

### PATH A: `/generate/:id` (Auto-Detected Winner)

#### Step 1: Load Winner + Script
- Load `brief_pipeline_winners` record
- If no `raw_script`, extract from ClickUp task description
- Validate script length ≥ 20 chars

#### Step 2: Parse Script into Structure
- **Claude API Call** (Haiku/fast)
- Prompt: `buildScriptParserPrompt()`
- Returns: `{hooks: [{id, text}, ...], body: "...", cta: "...", format_notes: "..."}`
- Cached in `parsed_script` field

#### Step 3: Fetch Product Profile
- Query product library (external system)
- Returns: product name, features, pricing, proven scripts, credibility data
- Used to build `productContext` string

#### Step 4: Deep Analysis (3 Parallel Agents)
- **Check cache first**: MD5 hash of raw_script
- If cache miss, run all 3 agents in parallel:

##### Agent 1: Script DNA
- **Claude API** (Sonnet, 2500 tokens)
- Analyzes: core angle, emotions, belief shifts, mechanism, proof type, etc.
- Returns: `scriptDna` object

##### Agent 2: Psychology
- **Claude API** (Sonnet, 2500 tokens)
- Analyzes: audience, emotional arc, hook mechanics, objection handling
- Returns: `psychology` object

##### Agent 3: Iteration Rules
- **Claude API** (Haiku/fast, 4000 tokens)
- Analyzes: safe directions, must-stay-fixed elements, warnings
- Returns: `iterationRules` object

- **Save to cache**: Avoid re-analysis for same script

#### Step 5: Build Directions
- Extract `safe_iteration_directions` from iterationRules
- Create N direction objects (one per variation)
- Each has: name, description, what_changes, what_stays

#### Step 6: Generate N Briefs in Parallel
```javascript
const results = await Promise.all(directions.map(async (direction) => {
  const { system, user } = buildBriefGeneratorPrompt(...);
  const generated = await callClaude(system, user, 3000);
  const scores = await callClaude(scoreSystem, scoreUser, 1500, {fast: true});
  return { generated, scores, overall, direction };
}));
```

- **Key optimization**: All N generations run in parallel
- Each gets its own Claude call with unique prompt
- Each scored independently after generation

#### Step 7: Save Results to DB
- Insert each successful brief → `brief_pipeline_generated`
- Auto-increment brief_number
- Rank by overall_score

#### Step 8: Update Winner Status
- Mark winner → `status: 'generated'`
- Keep in winners column but now linked to generated briefs

---

### PATH B: `/generate-from-script` (Manual Script)

#### Input Handling
- **Text mode**: Accept pasted script directly
- **URL mode**: 
  - If video URL → transcribe with Gemini
  - If Facebook Ad Library → extract with yt-dlp → transcribe
  - If HTML page → search for video tags → transcribe

#### Script Processing
Same as Path A steps 2-8:
1. Parse into structure
2. Fetch product profile
3. Deep analysis (3 agents)
4. Build directions
5. Generate in parallel
6. Score and save
7. Rank results

#### Two Output Modes

##### Mode 1: "Generate Variants" (default)
- `mode: 'hook_body'`
- Creates N independent variations
- Each variation follows different iteration direction
- All variations use full brief generator prompt
- Full parallel generation

##### Mode 2: "1:1 Script Clone" ⭐
- `mode: 'clone'`
- Creates single brief that maps reference beat-by-beat
- **Special prompt**: `buildScriptClonePrompt()`
- Constraints:
  - Same number of hooks as original
  - Same section structure
  - Same emotional arc
  - Same pacing/rhythm
  - Same rhetorical devices
  - ONLY product/avatar swapped
- **Lower scoring weights for clone**:
  - novelty: 3 (clones shouldn't be novel!)
  - aggression: 5
  - coherence: 5
  - hook_body_blend: 5
  - conversion_potential: 5

---

## 6. VIDEO TRANSCRIPTION FLOW

### Entry Points
1. `extractScriptFromUrl(url)` — Multi-strategy extraction
2. `transcribeWithGemini(mediaUrl)` — Direct transcription

### Multi-Strategy Extraction (`extractScriptFromUrl`)

#### Strategy 1: Facebook Ad Library
- Detect URL: `facebook.com/ads/library`
- Extract video via yt-dlp
- Transcribe with Gemini

#### Strategy 2: YouTube
- Detect URL: `youtube.com`, `youtu.be`
- Extract audio via yt-dlp
- Transcribe with Gemini

#### Strategy 3: Meta Ad Snapshot HTML
- Fetch page HTML
- Search for video in snapshot
- Extract and transcribe

#### Strategy 4: Direct Video/Audio
- If URL points to media file
- Download and transcribe directly

#### Strategy 5-6: HTML Video Tags + Fallback
- Search page HTML for `<video>` tags
- Extract src URLs
- Transcribe

### Gemini Transcription Flow

#### File Size Check
```
< 15MB → inline base64
≥ 15MB → Gemini File API (upload, wait for ACTIVE, reference)
```

#### Models Used (with fallback)
1. `gemini-2.0-flash` (primary)
2. `gemini-2.0-flash-lite` (fallback)

#### Rate Limit Handling ⚠️
- **Problem**: 429 rate limit errors from Gemini API
- **Current strategy**:
  1. Try model 1 (2 attempts)
  2. If 429 → try model 2 (2 attempts)
  3. If both 429 → wait 60s and retry
  4. If still 429 → throw error with "wait 1-2 minutes" message

#### Issues & Bottlenecks
1. **Rate limits not distributed**: Single key shares quota across all requests
2. **Sequential retry delay**: 60s wait blocks the request
3. **No queue/backoff strategy**: No exponential backoff between models
4. **Upload timeout for large files**: 120s timeout can fail on slow connections

---

## 7. PERFORMANCE ANALYSIS

### Parallelization ✅ Good
```javascript
// Deep analysis: 3 agents in parallel
const [scriptDna, psychology, iterationRules] = await Promise.all([
  callClaude(...), // Agent 1
  callClaude(...), // Agent 2
  callClaude(..., {fast: true}), // Agent 3 (Haiku for speed)
]);

// Brief generation: N variants in parallel
const results = await Promise.all(directions.map(async (dir) => {
  const generated = await callClaude(...); // Generate
  const scores = await callClaude(...);    // Score
}));

// Database updates: Parallel inserts
await Promise.all(briefs.map(brief => pgQuery(INSERT ...)));
```

### Potential Bottlenecks ⚠️

#### 1. Sequential Score/Validate Calls
```javascript
// Each brief generation includes TWO sequential calls
const generated = await callClaude(genSystem, genUser, 3000);  // 1st call
const scores = await callClaude(scoreSystem, scoreUser, 1500); // 2nd call (waits)
```
**Fix**: Combine generation + scoring into single prompt or score in parallel

#### 2. Gemini Rate Limit Waits
```javascript
if (result) return result;
console.log('[BriefPipeline] waiting 60s for rate limit reset...');
await new Promise(r => setTimeout(r, 60000)); // Blocks entire request
```
**Fix**: Implement queue system, exponential backoff, key rotation

#### 3. Video Transcription is Fully Sequential
- Download media → Transcribe → Return
- No streaming, no chunking
- Large files can timeout

#### 4. Product Profile Fetch is Separate Call
```javascript
// Not in parallel with script parsing
const productProfile = await fetchProductProfile(...);
```
**Could parallelize** with script parsing

#### 5. ClickUp Iteration Count Query is Paginated
```javascript
// Fetches all pages sequentially
while (hasMore) {
  const data = await clickupFetch(`...?page=${page}`);
  // ... process
  page++;
}
```
**Could parallelize** first N pages

---

## 8. CLONE MODE VS VARIANT MODE

### Clone Mode: "1:1 Script Clone"

**When to use**:
- Proven winner that just needs product swap
- Competitor ad with strong structure
- Want to preserve exact beat sequence

**What it does**:
1. Analyzes reference script structure
2. Extracts: hooks framework, body sections, emotional arc, rhetorical devices
3. **Maps beat-by-beat**: reference beat N → clone beat N
4. **Preserves**:
   - Number of hooks (if original has 3, clone has 3)
   - Section count (if original has 5 sections, clone has 5)
   - Pacing and rhythm
   - Emotional progression
5. **Changes only**:
   - Product name/features
   - Avatar/spokesperson
   - Specific claims (swapped to our product)

**Prompt**: `buildScriptClonePrompt()` (1699 lines)
- 1,800+ words of detailed instructions
- Beat mapping rules
- Perspective lock (keep same POV as original)
- Zero bridge needed (hook → body should flow naturally)
- Hook quality gates
- Product specificity requirements

**Scoring weights for clone**:
- novelty: 3/10 (clones should be faithful, not novel)
- aggression: 5/10
- coherence: 5/10
- hook_body_blend: 5/10
- conversion_potential: 5/10

### Variant Mode: "Generate Variants"

**When to use**:
- Want multiple creative angles
- Exploring different emotional approaches
- Build portfolio of hooks

**What it does**:
1. Analyzes reference script
2. Extracts safe iteration directions
3. **Generates N independent variations**:
   - Each variation uses different direction
   - Different hook angles
   - Different body approaches
   - Different emotional texture
4. Each is a complete brief (not constrained to match original structure)

**Prompt**: `buildBriefGeneratorPrompt()` (228 lines)
- Uses win analysis to inform new generation
- Applies iteration direction constraints
- Adds angle constraint if selected
- Includes proven scripts as style reference

**Scoring weights for variants**:
- novelty: 5/10 (variants should be novel)
- aggression: 5/10
- coherence: 5/10
- hook_body_blend: 5/10
- conversion_potential: 5/10

---

## 9. KEY FILES LOCATION & SIZE

### Backend Routes
```
/server/src/routes/briefPipeline.js — 5,018 lines
├─ API endpoints (all routes)
├─ Core functions (transcribe, parse, analyze, generate)
├─ Helper functions (Gemini, yt-dlp, Claude)
├─ Database schema initialization
└─ ClickUp integration
```

### Key Functions by Line
- `transcribeWithGemini()` — L570
- `buildScriptClonePrompt()` — L1699
- `buildBriefGeneratorPrompt()` — L2019
- `buildBriefScorerPrompt()` — L2247
- `buildDeepAnalysisPrompts()` — L1390
- `extractScriptFromUrl()` — L849
- `/generate/:id` endpoint — L2876
- `/generate-from-script` endpoint — L3183

### Frontend Components
```
/client/src/pages/production/BriefPipeline.jsx — Main page
/client/src/pages/production/briefs/
├─ ScriptGeneratorPanel.jsx — Manual input form
├─ GeneratedBriefCard.jsx — Brief preview card
├─ BriefDetailModal.jsx — Full brief viewer
├─ WinnerCard.jsx — Winner ad card
├─ WinnerDetailModal.jsx — Winner analysis viewer
└─ LaunchTemplateEditor.jsx — Template management
```

### Services
```
/server/src/services/geminiImageGen.js — Image generation (separate)
```

---

## 10. API KEYS & CONFIGURATION

### Required Environment Variables
```env
ANTHROPIC_API_KEY=sk-ant-...     # Claude API
GEMINI_API_KEY=AIzaSy...         # Google Generative AI
CLICKUP_API_TOKEN=pk_...         # ClickUp
META_ACCESS_TOKEN=EAA...         # Meta Graph API
META_AD_ACCOUNT_IDS=act_...,... # Multiple accounts
```

### API Endpoints Used
```
Claude API:
  https://api.anthropic.com/v1/messages
  Model: claude-sonnet-4-6 (main) | claude-haiku-4-5-20251001 (fast)

Gemini API:
  https://generativelanguage.googleapis.com/v1beta/models/{model}:generateContent
  Models: gemini-2.0-flash | gemini-2.0-flash-lite
  File API: /upload/v1beta/files (for large videos)

ClickUp API:
  https://api.clickup.com/api/v2/...
  Lists: 901518716584 (video ads) | 901518769621 (media buying)

Meta Graph API:
  https://graph.facebook.com/v21.0/...
  Endpoints: /me/adaccounts, /me/customaudiences, etc.

yt-dlp binary:
  /bin/yt-dlp — Extracts videos from URLs
```

---

## 11. RATE LIMITS & QUOTAS

### Gemini API Rate Limits ⚠️
- **Transcription quota**: 15,000 requests/minute/key
- **429 error handling**: Retry with backoff (currently broken)
- **File API**: Resumable upload protocol (120s timeout)

### Claude API Rate Limits
- **Requests**: 10,000/minute
- **Tokens**: 500,000/minute (Sonnet), 1,000,000/minute (Haiku)
- **Strategy**: Use Haiku for fast calls (parsing, scoring)

### ClickUp API Rate Limits
- **Requests**: 100/minute
- **Strategy**: Batch operations, parallel updates where possible

---

## 12. PROMPT ENGINEERING DETAILS

### Script Parser Prompt (`buildScriptParserPrompt`)
- Instructs Claude to extract: hooks (H1, H2, H3), body, CTA, format_notes
- Returns JSON: `{hooks: [{id, text}, ...], body, cta, format_notes}`
- Used by: both Path A and Path B

### Deep Analysis Prompts (3 agents)

#### DNA Prompt (scriptDna)
- Analyzes: core angle, primary/secondary emotions, belief shift
- Extracts: mechanism, proof type, audience awareness level
- Identifies: rhetorical devices, hook framework, pacing/rhythm, signature phrases
- Returns: structural skeleton for beat mapping

#### Psychology Prompt
- Analyzes: audience profile, skepticism level, existing beliefs
- Extracts: emotional arc (hook→proof→CTA states)
- Hook analysis: type, why it works, objection handling
- Returns: psychological insights for adaptation

#### Iteration Rules Prompt (Haiku/fast)
- Identifies: safe iteration directions (3-5 suggestions)
- Lists: must-stay-fixed elements (core claim, mechanism, proof)
- Warnings: what would break the ad
- Returns: constraints for generation

### Clone Prompt (`buildScriptClonePrompt`)
- 1,800+ words
- Detailed beat mapping rules
- Perspective lock (must match original POV)
- Hook quality gates (product specificity, scroll-stop, etc.)
- Compliance rules (no fake claims, use real data)

### Generator Prompt (`buildBriefGeneratorPrompt`)
- Uses iteration direction to guide generation
- Includes style reference (proven scripts)
- Angle constraint (if provided)
- Variation identity (make each unique)
- Returns: hooks + body

### Scorer Prompt (`buildBriefScorerPrompt`)
- Compares generated brief to original + analysis
- Scores: novelty (1-10), aggression, coherence, hook_body_blend, conversion_potential
- Returns: score object + verdict (YES/MAYBE/NO)

---

## 13. ERROR HANDLING & RECOVERY

### Stuck Regeneration States
```javascript
// Auto-recover: on startup, reset winners stuck in 'generating'
const stuck = await pgQuery(
  `UPDATE brief_pipeline_winners 
   SET status = 'detected' 
   WHERE status = 'generating' 
   RETURNING creative_id`
);
```

### Video Transcription Failures
- **Timeout**: 60s download, 120s transcription
- **Rate limit**: Retry with wait (currently causes blocking)
- **Empty transcript**: Fall back to error message

### Claude API Failures
- **Timeout**: AbortSignal timeout at 60s
- **Invalid response**: Default to fallback scores
- **Parsing error**: Try JSON parse with fallback

### Database Failures
- **Connection timeout**: 15s timeout on queries
- **Constraint violation**: Catch and log (don't crash)

---

## 14. PERFORMANCE BOTTLENECKS & RECOMMENDATIONS

### Critical Issues

| Issue | Severity | Impact | Fix Effort |
|-------|----------|--------|-----------|
| Gemini rate limit blocking | HIGH | 60s wait per video | MEDIUM |
| Sequential score calls | HIGH | 2x API latency per brief | EASY |
| No video streaming | MEDIUM | Timeouts on large files | MEDIUM |
| Single Gemini API key | MEDIUM | Shared quota across users | EASY |
| ClickUp pagination sequential | LOW | Slow for large lists | EASY |

### Recommended Optimizations

#### 1. Parallel Score Generation
```javascript
// Current: sequential
const generated = await callClaude(genSystem, genUser, 3000);
const scores = await callClaude(scoreSystem, scoreUser, 1500);

// Better: parallel
const [generated, scores] = await Promise.all([
  callClaude(genSystem, genUser, 3000),
  callClaude(scoreSystem, scoreUser, 1500),
]);

// Or: combine into single prompt
const result = await callClaude(genSystem, genScoreUser, 4000);
```

#### 2. Gemini Queue System
```javascript
// Replace blocking waits with queue
class GeminiQueue {
  async transcribe(url) {
    return new Promise((resolve, reject) => {
      this.queue.push({url, resolve, reject});
      this.process();
    });
  }
  
  async process() {
    if (this.processing) return;
    this.processing = true;
    
    while (this.queue.length > 0) {
      const {url, resolve, reject} = this.queue.shift();
      try {
        const result = await this._transcribeWithRetry(url);
        resolve(result);
      } catch (err) {
        reject(err);
      }
      // Exponential backoff between requests
      await new Promise(r => setTimeout(r, 1000));
    }
    this.processing = false;
  }
}
```

#### 3. Product Profile + Script Parsing Parallel
```javascript
// Current: sequential
const productProfile = await fetchProductProfile(...);
const parsedScript = await parseScript(...);

// Better: parallel (independent calls)
const [productProfile, parsedScript] = await Promise.all([
  fetchProductProfile(...),
  parseScript(...),
]);
```

#### 4. ClickUp Pagination Parallel
```javascript
// Current: sequential while loop
// Better: fetch first N pages in parallel
const pages = await Promise.all([
  clickupFetch(...?page=0),
  clickupFetch(...?page=1),
  clickupFetch(...?page=2),
]);
```

#### 5. Streaming Large File Upload
```javascript
// Current: load entire file into memory, then upload
// Better: stream upload to Gemini
const stream = fs.createReadStream(path);
await uploadStream(stream);
```

---

## 15. TESTING SCENARIOS

### Happy Path
1. Paste competitor script text
2. Select product (MR)
3. Select angle (optional)
4. Choose "Generate Variants" mode (3 variants)
5. Click Generate
6. Wait ~90s for 3 parallel generations
7. See 3 ranked briefs in Generated column

### Clone Mode Path
1. Paste competitor script
2. Select product
3. Select "1:1 Script Clone" mode
4. Click Generate
5. Wait ~45s for single clone
6. See single ranked brief

### Video URL Path
1. Paste Facebook Ad Library URL
2. System auto-extracts video via yt-dlp
3. Transcribes with Gemini (30-60s depending on length)
4. Proceeds with generation

### Error Cases
- Empty script → "minimum 20 characters" error
- Gemini rate limit → "wait 1-2 minutes" error
- No product found → Generation proceeds with limited context
- ClickUp task not found → "ensure task has script in description" error

---

## 16. CONCLUSIONS

### Strengths
✅ Full end-to-end automation (detection → generation → ClickUp)
✅ Sophisticated 3-agent deep analysis
✅ Parallel brief generation (all N variants at once)
✅ Multiple input strategies (text, URL, video)
✅ 1:1 cloning mode for structure preservation
✅ Comprehensive caching (analysis cache, product profiles)
✅ Atomic operations (status guards prevent race conditions)

### Weaknesses
⚠️ Gemini rate limit handling is blocking (60s waits)
⚠️ Score generation is sequential (2x latency per brief)
⚠️ Single Gemini API key (no key rotation)
⚠️ Video transcription not streamed (full file load)
⚠️ ClickUp pagination is sequential

### Next Steps
1. Implement Gemini queue system for rate limit handling
2. Parallelize score generation (combine with generation or parallel call)
3. Add Gemini API key rotation for load distribution
4. Implement streaming upload for large files
5. Add ClickUp pagination parallel fetch
6. Monitor Claude API token usage (may hit limits with many users)
