# Brief Pipeline — Quick Reference Card

## API ENDPOINTS
| Method | Route | Purpose |
|--------|-------|---------|
| GET | `/winners` | List detected winners |
| POST | `/detect` | Run winner detection |
| POST | `/generate/:id` | Generate briefs from winner |
| POST | `/generate-from-script` | ⭐ Manual generation |
| GET | `/generated` | List all generated briefs |
| PATCH | `/generated/:id` | Update brief status |
| POST | `/generated/:id/push` | Push to ClickUp |

## GENERATION FLOW

### Path A: `/generate/:id` (Auto Winner)
```
Load Winner → Parse Script → Fetch Product 
→ Deep Analysis (3 agents parallel) → Check Cache
→ Build Directions → Generate N variants (parallel)
→ Score each → Save to DB → Rank
```
Time: ~2-3 minutes for 3 variants

### Path B: `/generate-from-script` (Manual)
```
Text Input or URL (auto-transcribe with Gemini)
→ Create Virtual Winner → Parse Script
→ Fetch Product → Deep Analysis (3 agents)
→ Clone Mode OR Variants Mode
→ Generate/Score → Save to DB
```
Time: ~1.5-2 minutes for 3 variants, ~1 minute for 1 clone

## TWO OUTPUT MODES

### Clone Mode: "1:1 Script Clone"
- Single brief that maps beat-by-beat to reference
- Same structure, pacing, emotional arc
- Only product/avatar swapped
- Uses `buildScriptClonePrompt()` (1800+ words)
- Lower novelty score (3/10)
- Time: ~45s

### Variant Mode: "Generate Variants"
- N independent variations (2-5)
- Each uses different iteration direction
- Different hooks, different angles
- Uses `buildBriefGeneratorPrompt()`
- Higher novelty score (5/10)
- Time: ~90s for 3 variants

## KEY FILES

| File | Lines | Purpose |
|------|-------|---------|
| `/server/src/routes/briefPipeline.js` | 5,018 | All routes + core logic |
| `/client/src/pages/production/BriefPipeline.jsx` | ~600 | Main dashboard |
| `/client/src/pages/production/briefs/ScriptGeneratorPanel.jsx` | 294 | Manual generation form |

## KEY FUNCTIONS

| Function | Line | What it does |
|----------|------|-------------|
| `transcribeWithGemini()` | 570 | Video transcription (Gemini 2.0) |
| `buildScriptClonePrompt()` | 1699 | Clone mode instructions |
| `buildBriefGeneratorPrompt()` | 2019 | Variant generation instructions |
| `buildDeepAnalysisPrompts()` | 1390 | 3-agent analysis setup |
| `buildBriefScorerPrompt()` | 2247 | Scoring instructions |
| `extractScriptFromUrl()` | 849 | Multi-strategy URL extraction |

## DATABASE TABLES

| Table | Purpose |
|-------|---------|
| `brief_pipeline_winners` | Detected winning ads |
| `brief_pipeline_generated` | Generated briefs |
| `brief_pipeline_analysis_cache` | Cached 3-agent analysis |

## AI MODELS USED

| Model | Purpose | Speed |
|-------|---------|-------|
| `claude-sonnet-4-6` | Main generation + analysis | Medium |
| `claude-haiku-4-5-20251001` | Parsing + scoring | Fast |
| `gemini-2.0-flash` | Video transcription | Medium |
| `gemini-2.0-flash-lite` | Transcription fallback | Fast |

## PERFORMANCE BOTTLENECKS

| Issue | Severity | Solution |
|-------|----------|----------|
| Gemini rate limit waits (60s) | HIGH | Implement queue system |
| Sequential score calls | HIGH | Parallelize or combine prompts |
| No video streaming | MEDIUM | Stream large uploads |
| Single Gemini API key | MEDIUM | Add key rotation |
| ClickUp pagination sequential | LOW | Parallel page fetch |

## RATE LIMITS

| API | Limit | Impact |
|-----|-------|--------|
| Gemini | 15K req/min | Video transcription blocked at 429 |
| Claude | 10K req/min | Generation limited by concurrency |
| ClickUp | 100 req/min | Batch push operations limited |

## GEMINI TRANSCRIPTION FLOW

```
URL → Extract strategy (FB/YT/HTML/direct)
→ Download media (60s timeout)
→ Size check: <15MB inline b64, ≥15MB upload to File API
→ Try gemini-2.0-flash (2 attempts)
→ If 429: try gemini-2.0-flash-lite (2 attempts)
→ If still 429: wait 60s and retry (BLOCKS REQUEST ⚠️)
→ Return transcript
```

## SCORING FORMULA

```
overall_score = 
  (novelty × 0.15) +
  (aggression × 0.15) +
  (coherence × 0.25) +
  (hook_body_blend × 0.15) +
  (conversion_potential × 0.30)
```

For clones: novelty weight is lower (3/10 base)
For variants: novelty weight is higher (5/10 base)

## COMMON ERRORS & FIXES

| Error | Cause | Fix |
|-------|-------|-----|
| "wait 1-2 minutes" | Gemini 429 rate limit | Queue system needed |
| "minimum 20 characters" | Script too short | Paste more content |
| No product profile | Product not in library | Generation proceeds with limited context |
| "ClickUp task not found" | Winner has no task | Ensure task has script in description |
| Stuck "generating" status | Process crashed | Auto-recovery on restart |

## TYPICAL TIMELINE

**Variants Mode (3 variations)**:
- Parse: ~10s
- Deep analysis (3 agents): ~30s
- Generate (3 parallel): ~60s
- Score: ~20s
- Save: ~5s
- **Total: ~2 minutes**

**Clone Mode**:
- Parse: ~10s
- Deep analysis (3 agents): ~30s
- Generate clone: ~30s
- Score: ~10s
- Save: ~5s
- **Total: ~85 seconds**

**With Video Transcription** (add):
- Download: 10-30s (depends on size)
- Upload to Gemini: 10-20s (if >15MB)
- Transcription: 20-60s (depends on length)
- **Total add: 40-110s**

## DEBUGGING TIPS

1. **Check status**: `SELECT status FROM brief_pipeline_winners WHERE creative_id = 'B0003'`
2. **View analysis**: `SELECT win_analysis FROM brief_pipeline_analysis_cache WHERE creative_id = 'B0003'`
3. **See scores**: `SELECT * FROM brief_pipeline_generated WHERE parent_creative_id = 'B0003' ORDER BY overall_score DESC`
4. **Logs**: `/logs/` directory
5. **Stuck processes**: Check for `status = 'generating'` records (auto-recovered on restart)

## COMPLIANCE RULES (Clone Mode)

- No fake claims (check against product profile)
- No discount codes unless in product profile
- No named customer attributions (use "someone in community")
- Use real data (stats, institutions, etc.)
- Compliance overrides beat-mapping (better to weaken beat than invent claims)
- Distance framing for performance claims
