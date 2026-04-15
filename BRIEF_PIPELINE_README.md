# Brief Pipeline Documentation Index

This directory contains comprehensive documentation of the Mineblock Brief Pipeline architecture.

## Documents

### 1. **BRIEF_PIPELINE_ANALYSIS.md** (27 KB)
**Complete architecture reference — START HERE**

Contains:
- Executive summary of the entire system
- Frontend architecture (Kanban dashboard, 5 columns, React components)
- Backend API routes (11 main endpoints)
- Database schema (3 tables: winners, generated, cache)
- Generation flow (Path A: auto-detection, Path B: manual)
- Two output modes (Clone vs Variants)
- Video transcription flow (Gemini multi-strategy)
- Performance analysis (parallelization, bottlenecks)
- Prompt engineering details (all 5 main prompts)
- Error handling & recovery
- Rate limits & quotas
- Conclusions & next steps

**Use this when you need**: Complete understanding of how the system works

### 2. **BRIEF_PIPELINE_QUICK_REF.md** (5.9 KB)
**Quick lookup reference — USE DURING DEVELOPMENT**

Contains:
- API endpoints table
- Generation flow diagrams
- Two output modes comparison
- Key files & functions with line numbers
- Database tables summary
- AI models used
- Performance bottlenecks table
- Rate limits summary
- Gemini transcription flow
- Scoring formula
- Common errors & fixes
- Typical timeline
- Debugging tips
- Compliance rules

**Use this when you need**: Quick lookups while working on code

### 3. **BRIEF_PIPELINE_GEMINI_ISSUE.md** (11 KB)
**Root cause analysis & solutions for video transcription rate limiting**

Contains:
- Problem statement (60s blocking waits)
- Root cause analysis (5 factors)
- Solution architecture (3 options)
- Implementation recommendation (3 phases)
- Phase 1: Quick fix with multiple API keys (30 min)
- Phase 2: Queue system (2 hours)
- Phase 3: Alternative services (future)
- Testing scenarios
- Monitoring & alerting
- Exact code changes needed

**Use this when you need**: To fix the Gemini rate limit issue

---

## Key Findings Summary

### Architecture
- **Frontend**: React Kanban dashboard (5 columns: Generated → Approved → Pushed → Ready → Launched)
- **Backend**: Node.js/Express, 5,018 lines in briefPipeline.js
- **Database**: PostgreSQL (Render.com)
- **AI**: Claude Sonnet (generation) + Haiku (parsing/scoring) + Gemini 2.0 (transcription)

### Two Generation Modes
1. **Clone Mode** ("1:1 Script Clone"):
   - Maps reference script beat-by-beat to output
   - Same structure, pacing, emotional arc
   - Only product/avatar swapped
   - Time: ~45 seconds
   - Special 1,800+ word prompt

2. **Variant Mode** ("Generate Variants"):
   - Creates N independent variations (2-5)
   - Different hooks, different angles
   - Full creative freedom
   - Time: ~90 seconds for 3 variants
   - Uses standard generator prompt

### Critical Bottleneck
**Gemini Video Transcription Rate Limit** (HIGH severity)
- Single API key has 15K req/min quota
- Hitting quota causes 60s blocking waits
- Solution: Add 2-3 more API keys (3x quota, no code changes needed)
- Implementation: 30 minutes (Phase 1)

### Performance Insights
- ✅ Good: 3-agent analysis runs in parallel, N brief generations run in parallel
- ⚠️ Bad: Scoring calls are sequential (2x latency per brief)
- ⚠️ Bad: Video transcription full-file load (should stream)
- ⚠️ Bad: ClickUp pagination sequential (should parallelize)

### API Routes
- `GET /winners` — List detected winners
- `POST /generate/:id` — Generate from detected winner
- `POST /generate-from-script` — ⭐ Manual generation (supports clone/variants)
- `GET /generated` — List all generated briefs
- `PATCH /generated/:id` — Update status
- `POST /generated/:id/push` — Push to ClickUp

---

## Quick Start

### 1. Understanding the System
1. Read **BRIEF_PIPELINE_ANALYSIS.md** sections 1-3 (30 min)
2. Look at **BRIEF_PIPELINE_QUICK_REF.md** for specific functions
3. Grep `/server/src/routes/briefPipeline.js` for implementation

### 2. Fixing the Gemini Issue
1. Read **BRIEF_PIPELINE_GEMINI_ISSUE.md** "The Problem" section
2. Follow "Phase 1: Quick Fix" (30 min)
3. Test with test cases in same document

### 3. Adding a Feature
1. Check **BRIEF_PIPELINE_QUICK_REF.md** for relevant endpoints
2. Read relevant sections of **BRIEF_PIPELINE_ANALYSIS.md**
3. Check performance bottlenecks section before implementing

### 4. Debugging an Issue
1. Check **BRIEF_PIPELINE_QUICK_REF.md** "Debugging Tips" section
2. Use SQL queries provided to check database state
3. Grep logs for error messages
4. Check **BRIEF_PIPELINE_ANALYSIS.md** error handling section

---

## File Locations (Absolute Paths)

### Backend
- Main route file: `/Users/ludo/Mineblock-LLC/server/src/routes/briefPipeline.js` (5,018 lines)
- Gemini service: `/Users/ludo/Mineblock-LLC/server/src/services/geminiImageGen.js`

### Frontend
- Main dashboard: `/Users/ludo/Mineblock-LLC/client/src/pages/production/BriefPipeline.jsx`
- Manual generation form: `/Users/ludo/Mineblock-LLC/client/src/pages/production/briefs/ScriptGeneratorPanel.jsx`
- Generated brief card: `/Users/ludo/Mineblock-LLC/client/src/pages/production/briefs/GeneratedBriefCard.jsx`

### Docs
- Full spec: `/Users/ludo/Mineblock-LLC/docs/brief-pipeline-spec.md`

---

## API Models & Quotas

### Anthropic Claude
- **Models**: claude-sonnet-4-6 (main), claude-haiku-4-5-20251001 (fast)
- **Quota**: 10K req/min, 500K tokens/min (Sonnet), 1M tokens/min (Haiku)
- **Usage**: Generation & analysis

### Google Gemini
- **Models**: gemini-2.0-flash (primary), gemini-2.0-flash-lite (fallback)
- **Quota**: 15K req/min per API key
- **Usage**: Video transcription only
- **⚠️ Issue**: Rate limiting at 429 (see BRIEF_PIPELINE_GEMINI_ISSUE.md)

### ClickUp
- **Quota**: 100 req/min
- **Lists**: 901518716584 (video ads), 901518769621 (media buying)
- **Usage**: Task creation, field updates

### Meta Graph
- **Quota**: Variable per endpoint
- **Version**: v21.0
- **Usage**: Ad account/campaign data (not used in Brief Pipeline)

---

## Key Concepts

### Winner Detection
- Runs daily or on-demand
- Queries Creative Analysis for ads from last 7 days
- Filters: ROAS ≥ 1.5, spend ≥ $100
- Classifies: high_roas, rising_star, volume_winner, efficiency_winner

### Deep Analysis (3-Agent Pipeline)
1. **Script DNA**: Structural skeleton, rhetorical devices, pacing, hooks framework
2. **Psychology**: Audience profile, emotional arc, skepticism handling
3. **Iteration Rules**: Safe directions, must-stay-fixed elements, warnings

### Naming Convention
Format: `PRODUCT - BRIEF# - MODE - PARENT - AVATAR - ANGLE - FORMAT - STRATEGIST - CREATOR - EDITOR - WEEK`
Example: `MR - B0122 - IT - B0003 - NA - Against competition - Mashup - Ludovico - NA - Antoni - WK14_2026`

### Brief Status Workflow
```
detected → selected → generating → generated → approved → pushed → ready_to_launch → launched
```

---

## Maintenance & Monitoring

### Health Checks
1. Check for stuck "generating" winners: `SELECT * FROM brief_pipeline_winners WHERE status = 'generating'`
2. Monitor Gemini rate limit errors in logs: `grep "429" /logs/*.md`
3. Check for failed generations: `SELECT COUNT(*) FROM brief_pipeline_generated WHERE success = false`

### Common Issues
- Gemini rate limit → See BRIEF_PIPELINE_GEMINI_ISSUE.md
- No product profile → Generation proceeds with limited context (expected)
- ClickUp task not found → Ensure task has script in description
- Stuck "generating" → Auto-recovered on restart

### Scaling Considerations
- Add more Gemini API keys for transcription throughput
- Parallelize score generation (currently sequential)
- Cache transcripts by URL hash
- Consider alternative transcription service (Assembly.ai, Rev.com)

---

## Next Steps

1. **Immediate** (This Week):
   - Implement Phase 1 Gemini fix (multiple API keys)
   - Remove blocking 60s wait
   - Test with concurrent video submissions

2. **Short-term** (Next Week):
   - Parallelize score generation
   - Add monitoring/alerting for rate limits
   - Document all custom field IDs in code

3. **Medium-term** (Next Sprint):
   - Implement queue system for transcriptions
   - Cache transcripts by URL
   - Add performance metrics dashboard

4. **Long-term** (Future):
   - Alternative transcription service
   - Auto-scaling for peak usage
   - Machine learning feedback loop on scoring

---

## Questions?

Refer to the specific document:
- **"How does the entire system work?"** → BRIEF_PIPELINE_ANALYSIS.md
- **"Where is function X?"** → BRIEF_PIPELINE_QUICK_REF.md + grep
- **"Why is video transcription timing out?"** → BRIEF_PIPELINE_GEMINI_ISSUE.md
- **"What's the database schema?"** → BRIEF_PIPELINE_ANALYSIS.md section 4
- **"How do I debug X?"** → BRIEF_PIPELINE_QUICK_REF.md "Debugging Tips"

Generated: 2026-04-08
By: Claude Code Agent
