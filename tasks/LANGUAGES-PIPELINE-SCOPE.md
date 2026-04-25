# Video Ads Languages Pipeline — Full Implementation Scope

**Author**: Senior Automation Engineer  
**Date**: 2026-04-25  
**Status**: SCOPE DRAFT — awaiting approval before build  
**Worktree**: `/Users/ludo/Mineblock-LLC-creative` (branch: `creative/active`)  

---

## 1. Recommended System Architecture

### Decision: Dashboard-triggered API endpoint (custom-code approach)

**Architecture**: New Express route + React UI page inside the existing `mineblock-dashboard` Render service.

```
[React UI — LanguagesPipeline.jsx]
        ↓  POST /api/v1/languages-pipeline/generate
[Express route — languagesPipeline.js]
        ↓                    ↓                    ↓
[ClickUp API]        [Claude API]          [Frame.io v4 API]
  - read source task  - translate script    - create lang subfolder
  - create new task   - returns native      - return subfolder URL
  - set fields          localized copy
  - set status
```

**Why not no-code (Make.com / ClickUp native automations)?**  
- ClickUp's native automations cannot call external AI translation APIs.  
- Make.com could trigger on a custom field change, but cannot do conditional language routing or anti-duplicate logic across multiple languages in a single scenario without significant complexity. Also, Make.com is already causing problems (duplicate Frame.io folders) and we're moving away from it.  
- Full custom-code gives us: translation quality control, idempotency guards, Slack error alerts, audit log, and a clean test harness.

**Deployment**: Ships on the `creative/active` branch, merges to `main`, auto-deploys to Render.

---

## 2. Required ClickUp Fields / Custom Fields

### New List: "Video Ads Languages"

This is a **new ClickUp List** (separate from "Video Ad Pipeline"). Must be created manually in ClickUp before the first deploy.

Once created, we need:
- The **List ID** — goes into `LANGUAGES_LIST_ID` constant
- The **"Edit Queue" status ID** (or just use the status name string — ClickUp API accepts either)

### Custom Fields Required on "Video Ads Languages" list

| Field Name | Field Type | Purpose |
|---|---|---|
| `Brief Number` | Number | Copy from source card — same B-code |
| `Source Card` | URL or Short Text | Link back to original English ClickUp task |
| `Language Code` | Dropdown | ES / FR / DT / IT |
| `Source Frame Folder` | URL | Link to original English Frame.io folder |
| `Ads Frame Link` | URL | New language-specific Frame.io subfolder link |
| `Brief Type` | Dropdown (NN/IT) | Copied from source |
| `Angle` | Dropdown | Copied from source |
| `Creative Type` | Dropdown | Copied from source |
| `Creation Week` | Short Text | Copied from source |
| `Creative Strategist` | Users | Copied from source |

> **NOTE**: "Source Card" and "Language Code" are **new fields** that don't exist yet.  
> All other fields can reuse the same field UUIDs as the Video Ads list **only if** they are workspace-level shared fields. If list-scoped, we'll need new UUIDs after the list is created.

We will **not** copy the Editor field — new cards land unassigned in Edit Queue for Ludo to assign per-language editors manually.

---

## 3. Required Statuses

The "Video Ads Languages" list needs these statuses (at minimum):

| Status | Color | Purpose |
|---|---|---|
| `Edit Queue` | Blue | Default landing status — card created here |
| `In Progress` | Yellow | Editor picked it up |
| `Ready to Review` | Purple | Editor uploaded localized video |
| `Approved` | Green | Approved for launch |
| `Rejected` | Red | Needs re-edit |

> **Only "Edit Queue" is required at build time.** Other statuses can be added later in ClickUp directly.

---

## 4. Required Automations

We are NOT using ClickUp native automations. All logic runs inside our Express API. The following automation flows will be built:

| Trigger | Action |
|---|---|
| User clicks "Generate" in dashboard | API creates 1 ClickUp card per language |
| Card created | Status set to "Edit Queue" |
| Card created | Script translated by Claude API |
| Card created | Frame.io language subfolder created |
| Card created | Frame link set on new card |
| Card created | Source Card link set as custom field |
| Duplicate detected | Skip creation, return warning to UI |
| Any failure | Slack alert + error returned to UI |

---

## 5. Required API Integrations

| API | Already integrated? | Use |
|---|---|---|
| ClickUp API v2 | ✅ YES (`CLICKUP_API_TOKEN` on Render) | Read source task, create language task, set fields/status |
| Frame.io v4 | ✅ YES (`createFrameFolder()` in `clickupWebhook.js`) | Create language subfolder inside source folder |
| Anthropic Claude API | ✅ YES (`ANTHROPIC_API_KEY` on Render, Sonnet in use) | Translate script — localized, native-sounding |
| Slack | ✅ YES (`SLACK_BOT_TOKEN` on Render) | Error alerts |

**Zero new API keys required.**

---

## 6. Data Flow — Original English Card → Translated Language Card

```
STEP 1 — USER SELECTION
  User selects source card IDs (from Video Ads Pipeline)
  User selects target language codes: [ES, FR, DT, IT]

STEP 2 — FETCH SOURCE TASK
  GET /api/v2/task/:taskId
  Extract:
    - task.name              → naming convention base
    - task.description       → English script
    - task.custom_fields     → angle, briefType, creativeType, editor,
                               strategist, briefNumber, creationWeek,
                               adsFrameLink (source Frame.io folder URL)

STEP 3 — DUPLICATE CHECK
  Query "Video Ads Languages" list for tasks where:
    name contains "[SOURCE_BRIEF_CODE] - [LANG_CODE]"
  If found → skip, return {skipped: true, reason: "already exists"}

STEP 4 — TRANSLATE SCRIPT (per language)
  Call Claude API with translation prompt
  Input: English script + target language + target market
  Output: native-sounding localized script

STEP 5 — BUILD TASK NAME
  Original: MR - B0223 - NN - NA - MoneySeeker - Lottery - ShortVid - Ludovico - NA - Fazlul - WK17_2026
  Insert lang code after first prefix:
  Result:   MR - ES - B0223 - NN - NA - MoneySeeker - Lottery - ShortVid - Ludovico - NA - Fazlul - WK17_2026

STEP 6 — EXTRACT SOURCE FRAME FOLDER ID
  Parse source adsFrameLink (format: https://next.frame.io/project/:projectId/:folderId)
  Extract the :folderId segment as the parent for the language subfolder

STEP 7 — CREATE FRAME.IO LANGUAGE SUBFOLDER
  Check if subfolder named "ES" already exists under source folder
  If not found → createFrameFolder(sourceFolderId, "ES")
  Result: subfolder URL (https://next.frame.io/project/:projectId/:subFolderId)

STEP 8 — CREATE CLICKUP TASK
  POST /api/v2/list/:LANGUAGES_LIST_ID/task
  Body:
    name: "MR - ES - B0223 - ..."
    description: [translated script]
    status: "Edit Queue"

STEP 9 — SET CUSTOM FIELDS ON NEW TASK
  - Language Code: "ES"
  - Source Card: link to original task URL
  - Brief Number: same as source
  - Brief Type: copied from source
  - Angle: copied from source
  - Creative Type: copied from source
  - Creation Week: current week label
  - Source Frame Folder: original Frame.io link
  - Ads Frame Link: new language subfolder URL

STEP 10 — RETURN RESULT TO UI
  { success: true, tasks: [{lang: "ES", taskId, taskUrl, frameUrl}] }
```

---

## 7. Naming Convention Logic

**Rule**: Insert the language code immediately after the first dash-separated segment (the "product prefix").

```javascript
function buildLanguageTaskName(originalName, langCode) {
  const parts = originalName.split(' - ');
  // parts[0] = "MR", parts[1] = "B0223", ...
  return [parts[0], langCode, ...parts.slice(1)].join(' - ');
}
```

**Examples:**
```
MR - B0223 - NN - ...  →  MR - ES - B0223 - NN - ...
TX - B0115 - IT - ...  →  TX - FR - B0115 - IT - ...
```

**Edge case**: If original name already contains a language code (e.g. `MR - ES - B0223 - ...`), the duplicate check catches it before we build a new name.

---

## 8. Translation Logic

**Engine**: Claude Sonnet (`claude-sonnet-4-6`) — already in use for other features.

**Language → Market mapping** (used in the prompt):
| Code | Language | Target Market |
|---|---|---|
| ES | Spanish | Spanish-speaking Facebook audience (Spain + LatAm) |
| FR | French | French-speaking Facebook audience (France + Belgium) |
| DT | Dutch | Dutch-speaking Facebook audience (Netherlands + Belgium) |
| IT | Italian | Italian-speaking Facebook audience (Italy) |

**Translation Prompt** (exactly as specified, with parameters filled):
```
Translate and localize the following Facebook video ad script into [LANGUAGE].

The goal is not a literal translation. The goal is to make it sound like it was 
originally written by a native performance marketer for a Facebook audience in [MARKET].

Requirements:
- Keep the same meaning, offer, hook, emotional angle, and CTA.
- Make the language natural, persuasive, and native.
- Avoid AI-sounding phrasing.
- Avoid overly formal wording unless the original script requires it.
- Keep the structure close to the original script.
- Optimize for short-form video ads.
- Make it sound human, clear, and conversion-focused.
- Preserve any product names, brand names, creator names, codes, and campaign identifiers.
- Do not add claims that are not in the original script.
- Do not remove important selling points.

Original English script:
[SCRIPT]

Return only the translated script.
```

**API call settings:**
- Model: `claude-sonnet-4-6`
- Max tokens: 4096 (scripts can be long)
- Temperature: 0.7 (some creativity for naturalness, not too high)
- System prompt: none needed (task-specific prompt handles it)

**What if description is empty?**  
→ Return `{error: "missing_script"}` to UI, skip task creation for that source card, Slack alert.

---

## 9. Frame.io Folder Creation Logic

**Source folder extraction:**
```javascript
function parseFrameFolderId(frameUrl) {
  // URL format: https://next.frame.io/project/:projectId/:folderId
  const match = frameUrl?.match(/\/project\/[^/]+\/([^/?#]+)/);
  return match?.[1] || null;
}
```

**Subfolder creation flow:**
```javascript
async function getOrCreateLangSubfolder(sourceFolderId, langCode) {
  // 1. List children of source folder
  const children = await frameioFetchV4(`/assets/${sourceFolderId}/children`);
  const existing = children?.data?.find(
    c => c.name === langCode && c.type === 'folder'
  );
  if (existing) {
    // Reuse existing subfolder — return its URL
    return {
      folderId: existing.id,
      folderUrl: `https://next.frame.io/project/${FRAMEIO_PROJECT_ID}/${existing.id}`,
      existed: true,
    };
  }
  // 2. Create new subfolder
  return createFrameFolder(sourceFolderId, langCode);
}
```

**If source card has no Frame.io link:**  
→ Skip Frame.io subfolder creation, create ClickUp card anyway, set `Ads Frame Link` to blank.  
→ Log warning, include `{frameWarning: "no_source_frame_link"}` in response.

---

## 10. Error Handling

Every failure surface is handled:

| Failure | Behavior |
|---|---|
| ClickUp GET source task fails | Return 400 to UI with error message, Slack alert |
| Script is empty / missing | Skip translation, skip card creation, return `{error: "missing_script"}` |
| Claude API translation fails | Return `{error: "translation_failed"}`, Slack alert, do NOT create card |
| Frame.io subfolder creation fails | Create ClickUp card anyway, set Frame link to source folder URL as fallback, flag `{frameWarning: "subfolder_failed"}` in response |
| ClickUp task creation fails | Return `{error: "clickup_create_failed"}`, Slack alert, do NOT claim success |
| ClickUp custom field set fails | Log warning, do NOT fail the whole request (card exists, metadata can be fixed manually) |
| Duplicate detected | Return `{skipped: true}` — NOT an error |
| Invalid language code | Return 400 immediately before any API calls |

All errors are also written to Render logs via `logger.error()`.

---

## 11. Duplicate Prevention

**Strategy**: Name-based lookup before creating.

```javascript
async function checkDuplicate(langCode, sourceBriefCode) {
  // Search "Video Ads Languages" list for tasks matching pattern
  const data = await clickupFetch(
    `/list/${LANGUAGES_LIST_ID}/task?include_closed=true&limit=100`
  );
  const pattern = `- ${langCode} - ${sourceBriefCode} -`;
  return data.tasks?.some(t => t.name.includes(pattern));
}
```

**Why name-based vs custom field-based?**  
Custom field search in ClickUp requires field ID and value — works but is slower. Name-based is fast and reliable given our strict naming convention. We use the `[LANG] - [BCODE]` pair which is unique per card.

**Edge case**: If someone manually creates a card with the same name and a different language code embedded differently → the name check would miss it. Acceptable risk — the naming convention is enforced by the system, not by users.

---

## 12. Manual Language Selection Flow (Dashboard UX)

**Page**: `/app/languages-pipeline` (new route in React)

**UX design:**
```
┌─────────────────────────────────────────────────────────┐
│  Video Ads Languages Pipeline                            │
│                                                          │
│  [Search source cards...]                                │
│                                                          │
│  □ MR - B0223 - MoneySeeker - Lottery (WK17)            │
│  □ MR - B0218 - Cryptoaddict - GTRS (WK16)              │
│  □ MR - B0215 - MoneySeeker - Hiddenopportunity (WK15)  │
│                                                          │
│  Target Languages:  [ES] [FR] [DT] [IT]                 │
│                     (multi-select toggle buttons)        │
│                                                          │
│  [Generate Language Versions →]                          │
│                                                          │
│  ─── Results ───────────────────────────────────────────│
│  ✅ MR - ES - B0223 - ...  → View in ClickUp            │
│  ✅ MR - FR - B0223 - ...  → View in ClickUp            │
│  ⚠️ MR - ES - B0218 - ...  → Already exists (skipped)  │
└─────────────────────────────────────────────────────────┘
```

**Backend endpoints:**
- `GET /api/v1/languages-pipeline/source-tasks` — returns paginated Video Ads tasks for the picker
- `POST /api/v1/languages-pipeline/generate` — runs the full generation flow

---

## 13. Automatic Winner Detection Flow

**Can this be done?** YES — but as an enhancement, not the primary trigger.

**Definition of "winner"**: Cards in the Video Ads Pipeline that have been marked "launched" AND have spend ≥ $200 AND ROAS ≥ 2.0 in our Creative Analysis data (already in `spy_creatives` table).

**Implementation**: Add an optional filter on the source task picker:
```
[Show all] [Show winners only ($200+ spend, ROAS ≥ 2.0)]
```

When "winners only" is selected:
1. Backend calls `GET /api/v1/creative-analysis/winners` (already exists for brief pipeline)
2. Joins with `spy_creatives` table on `generation_task_id` (ClickUp task ID)
3. Returns only winner task IDs for the picker

**Limitation**: Not all Video Ads tasks are in `spy_creatives` — only those launched through our statics pipeline or synced via the ClickUp webhook. Briefs that were created manually in ClickUp without going through our system won't be in the DB. For those, user picks manually.

**Build priority**: Build the manual picker first (core feature). Add winner filter as Phase 2 enhancement.

---

## 14. Permissions and Access Requirements

**Authentication**: Standard `authenticate` middleware (JWT cookie).  
**Permission key**: `languages-pipeline` with `access` action.  
**Roles**: SuperAdmin + Admin at minimum. Ludo can extend via RBAC settings.

**ClickUp API**: Already configured (same token as Brief Agent).  
**Frame.io**: Already authorized via OAuth (v4 tokens in DB).  
**Claude API**: Already configured (`ANTHROPIC_API_KEY` on Render).  

**New Render env vars needed**: NONE.  
**New ClickUp configuration needed**: 
- Create "Video Ads Languages" list in ClickUp (manual step by Ludo)
- Get the List ID and paste into code constant `LANGUAGES_LIST_ID`
- Create custom fields "Source Card" and "Language Code" on that list

---

## 15. Edge Cases

| Case | Handling |
|---|---|
| Source task name has no `-` separator | Return 400: "Cannot parse naming convention" |
| Source task description is null/empty | Skip with `{error: "missing_script"}` |
| Frame.io link on source card is null | Create ClickUp card, skip Frame subfolder, warn in response |
| Frame.io folder ID parsed as null from URL | Same as above |
| Language code not in [ES, FR, DT, IT] | Return 400 immediately |
| Multiple sources × multiple languages — partial failure mid-batch | Process each (source×lang) pair independently; return array of results with individual success/fail per pair |
| Script contains HTML tags | Strip HTML before sending to Claude |
| Script is in English but very short (< 20 chars) | Proceed — Claude can translate anything |
| Source card is itself a language card (name already has ES/FR/etc.) | Warn user in UI, still process unless explicitly blocked |
| Languages list not configured (LANGUAGES_LIST_ID is blank) | Return 500 with clear message: "LANGUAGES_LIST_ID not configured" |
| ClickUp rate limit (429) | Retry once after 2s delay, then fail with Slack alert |
| Claude API rate limit (429) | Retry once after 3s delay, then fail |
| Frame.io OAuth token expired mid-request | `getV4AccessToken()` refreshes automatically (existing pattern) |

---

## 16. Technical Risks

| Risk | Likelihood | Impact | Mitigation |
|---|---|---|---|
| Translation sounds too formal / AI-like | Medium | Medium | Use temperature 0.7 + specific anti-AI instructions. Can tune. |
| ClickUp List ID not configured on first deploy | High (manual step) | High | Fail early with clear error message. |
| Custom field UUIDs differ between lists | Medium | Medium | After creating Languages list, run a setup endpoint to verify/map field IDs. |
| Frame.io subfolder already exists (same editor ran twice) | Medium | Low | `getOrCreateLangSubfolder()` handles this — reuses existing folder. |
| Script is stored as rich text with formatting markers | Low | Low | Strip HTML + normalize whitespace before translating. |
| Very long scripts hit Claude 4096 token output limit | Low | Medium | Use `max_tokens: 8096` for VSL-type scripts. |
| ClickUp `include_closed=true` pagination slow for duplicate check | Low | Low | Only check the Languages list (not Video Ads list) — much smaller. |

---

## 17. No-Code / Low-Code / Custom-Code Options

### Option A — ClickUp Native Automations (No-code)
**Rating**: ❌ Not viable  
- Cannot call external AI APIs for translation.
- Cannot do conditional logic per language.
- Cannot create Frame.io subfolders.

### Option B — Make.com + ClickUp webhook (Low-code)
**Rating**: ⚠️ Possible but problematic  
- Can trigger on custom field change in ClickUp.
- Would need an OpenAI module for translation (available in Make.com).
- Cannot natively call Frame.io API for subfolder creation.
- Already causes duplicate folder issues — adding more Make.com scenarios is risky.
- No anti-duplicate logic possible in Make.com without DB.
- Estimated Make.com build: 3-4 complex scenarios, hard to debug.

### Option C — Custom-code Express API + React UI (Recommended)
**Rating**: ✅ RECOMMENDED  
- Uses existing infrastructure, APIs, and patterns already in the codebase.
- Full control over idempotency, error handling, translation quality.
- Easy to test (automated test suite).
- Slack alerts on failures.
- Reuses `createFrameFolder()`, `clickupFetch()`, Claude API patterns already proven in production.
- Estimated build: 1-2 sessions.

---

## 18. Recommended Approach

**Build**: New Express route `languagesPipeline.js` + new React page `LanguagesPipeline.jsx`.

**Key reuses from existing codebase:**
- `createFrameFolder(parentFolderId, name)` — already works on Frame.io v4
- `frameioFetchV4(url, options)` — already handles OAuth token refresh
- `clickupFetch(url, options)` — already handles errors
- `callClaude(prompt)` pattern from `briefPipeline.js`
- `sendSlackAlert()` for error reporting
- `authenticate` + `requirePermission` middleware
- `generateNamingConvention` pattern from `clickupWebhook.js`

**Minimal new code required.**

---

## 19. Build Steps

### Phase 1 — ClickUp Setup (manual, by Ludo — 10 min)
1. Create "Video Ads Languages" list in ClickUp (same space as Video Ad Pipeline)
2. Add statuses: Edit Queue, In Progress, Ready to Review, Approved, Rejected
3. Add custom fields: Language Code (dropdown: ES/FR/DT/IT), Source Card (URL field)
4. Note the List ID (appears in the ClickUp URL)
5. Provide List ID to Claude for step 2

### Phase 2 — Backend Route (code)
1. Create `server/src/routes/languagesPipeline.js`
   - `GET /source-tasks` — fetch Video Ads Pipeline tasks for UI picker
   - `POST /generate` — main generation endpoint (translate + create cards)
   - `GET /languages-tasks` — fetch existing Language cards for UI
2. Register route in `app.js` at `/api/v1/languages-pipeline`
3. Add permission preset for `languages-pipeline` in platform/team roles

### Phase 3 — Frontend Page (code)
1. Create `client/src/pages/production/LanguagesPipeline.jsx`
   - Source task picker with search
   - Language checkboxes (ES / FR / DT / IT)
   - Generate button with loading state
   - Results panel showing success/skip/error per card×language pair
2. Add route to `App.jsx`
3. Add sidebar nav link in the Creative or Production section

### Phase 4 — Integration Testing
Run all 12 QA test cases (see Section 20).

### Phase 5 — Deploy
1. Commit to `creative/active`
2. Merge to `main`
3. Render auto-deploys

---

## 20. Testing and QA Plan

### Pre-requisites
- "Video Ads Languages" list created in ClickUp with correct ID configured
- At least 2 real Video Ads tasks with scripts in their descriptions (for live tests)
- Test will use a real but designated "test" source task to avoid polluting production

### Test Cases

---

**TC-01: Single card, single language**
- Input: Source card `MR - B0223 - ...` → language `ES`
- Expected: 1 new card `MR - ES - B0223 - ...` in Languages list, status=Edit Queue, ES script in description, Frame.io ES subfolder created
- Pass criteria: Card exists, script is in Spanish, Frame.io link set

**TC-02: Single card, multiple languages**
- Input: Source card `MR - B0223 - ...` → languages `[ES, FR]`
- Expected: 2 new cards (ES + FR), both in Edit Queue
- Pass criteria: Both cards exist with correct names and localized scripts

**TC-03: Multiple cards, single language**
- Input: Source cards `[B0223, B0218]` → language `FR`
- Expected: 2 new cards, one per source card, both in FR
- Pass criteria: Both cards created, partial failure returns partial results

**TC-04: Multiple cards, multiple languages**
- Input: Source cards `[B0223, B0218]` → languages `[ES, FR]`
- Expected: 4 new cards (2×2 matrix)
- Pass criteria: All 4 cards created correctly

**TC-05: Duplicate prevention**
- Input: Run TC-01 again (same card + ES)
- Expected: `{skipped: true, reason: "already exists"}` — no new card created
- Pass criteria: Only 1 ES card exists in ClickUp (not 2)

**TC-06: Missing script**
- Input: Source card with empty description
- Expected: `{error: "missing_script"}` — no card created, Slack alert sent
- Pass criteria: No card in ClickUp, error in response

**TC-07: Missing Frame.io link**
- Input: Source card with no `adsFrameLink` field set
- Expected: ClickUp card IS created, Frame.io subfolder is NOT created, response includes `{frameWarning: "no_source_frame_link"}`
- Pass criteria: Card exists, Frame link field empty, no crash

**TC-08: Invalid language code**
- Input: Language code `ZZ` (not in supported list)
- Expected: 400 error returned immediately, no API calls made
- Pass criteria: HTTP 400 with clear message "Unsupported language code: ZZ"

**TC-09: Existing Frame.io language subfolder**
- Input: Same TC-01, but ES subfolder was already created manually in Frame.io
- Expected: System reuses existing subfolder (no duplicate), card created normally
- Pass criteria: `{existed: true}` in frame result, only 1 ES subfolder in Frame.io

**TC-10: Claude API failure (mock)**
- Input: Temporarily set `ANTHROPIC_API_KEY` to invalid value, then run TC-01
- Expected: `{error: "translation_failed"}` — no card created, Slack alert sent
- Pass criteria: No card in ClickUp, Slack alert received, key restored after test

**TC-11: ClickUp API failure (mock)**
- Input: Temporarily set `CLICKUP_API_TOKEN` to invalid value
- Expected: `{error: "clickup_create_failed"}` — error returned, Slack alert
- Pass criteria: HTTP 500 with error, Slack alert received

**TC-12: Frame.io folder creation failure (mock)**
- Input: Temporarily revoke Frame.io OAuth token, then run TC-01
- Expected: ClickUp card IS created, Frame.io subfolder creation fails gracefully, `{frameWarning: "subfolder_failed"}` in response
- Pass criteria: Card exists in ClickUp, Frame link field blank or set to source link, no crash

---

### For Each Test, Document:
- Input
- Expected output
- Actual output
- Pass/Fail
- Bug found (if any)
- Fix applied (if any)
- Retest result

---

## Deliverables Checklist

- [x] Full project scope document (this file)
- [ ] Technical implementation plan (embedded above in Build Steps)
- [ ] Required ClickUp custom field structure (Section 2)
- [ ] API/data mapping (Section 6)
- [ ] Translation prompt system (Section 8)
- [ ] Debugging checklist (Section 10 + 15)
- [ ] QA test cases (Section 20)
- [ ] Final build instructions (Section 19 + task queue below)
- [ ] Final handoff documentation (post-build)

---

## Task Queue (ACTIVE-creative.md additions)

```
- [ ] LANG-01: Ludo creates "Video Ads Languages" ClickUp list + provides List ID
- [ ] LANG-02: Build languagesPipeline.js backend route (GET source-tasks, POST generate)
- [ ] LANG-03: Register route in app.js + add RBAC permission
- [ ] LANG-04: Build LanguagesPipeline.jsx frontend page
- [ ] LANG-05: Add sidebar nav link
- [ ] LANG-06: Run TC-01 through TC-12, document results
- [ ] LANG-07: Fix any bugs found in TC-01..TC-12
- [ ] LANG-08: Commit + merge + verify on Render
- [ ] LANG-09: Write handoff documentation
```

---

## Open Design Questions — Resolved

| Question | Decision |
|---|---|
| Trigger surface | Dashboard page with task picker + language multi-select |
| Translation engine | Claude Sonnet (`claude-sonnet-4-6`) — already in use |
| Idempotency | Skip (don't duplicate) — check by name pattern before creating |
| Frame.io subfolder naming | Bare language code only: `ES`, `FR`, `DT`, `IT` |
| Editor assignment | Leave unassigned in Edit Queue — Ludo assigns per language |
| Winner auto-detection | Phase 2 enhancement — Phase 1 is manual picker only |
| Script location in task | ClickUp task `description` field |

---

*Scope doc complete. Awaiting Ludo approval before LANG-01 build begins.*
