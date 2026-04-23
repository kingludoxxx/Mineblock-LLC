# AREA SCOPE: PLATFORM

This worktree is the **Platform** area (auth, users, infra, shared services). Branch: `platform/active`.

## In scope (edit freely)
- `server/src/routes/auth.js`
- `server/src/routes/users.js`
- `server/src/routes/team.js`
- `server/src/routes/departments.js`
- `server/src/routes/settings.js`
- `server/src/routes/audit.js`
- `server/src/routes/health.js`
- `server/src/routes/index.js`
- All `server/src/controllers/*`
- All `server/src/models/*`
- All `server/src/middleware/*`
- `server/src/services/authService.js`
- `server/src/services/auditService.js`
- `server/src/utils/jwt.js`, shared utils (slackAlert, logger, hash, r2)
- `server/src/config/*`, `server/src/db/*`

## Out of scope (DO NOT EDIT — use the right worktree)
- Ads (`adLauncher`, `adRejectionMonitor`, `adsControlCenter`, `videoAdsLauncher`, `metaWebhook`, `metaAdsApi`) → **`/Users/ludo/Mineblock-LLC-ads`**
- Creative pipeline (`briefAgent`, `briefPipeline`, `advertorialPipeline`, `statics*`, `iterationKing`, `clickupWebhook`, creative utils) → **`/Users/ludo/Mineblock-LLC-creative`**
- Analytics (`kpiSystem`, `creativeAnalysis`, `creativeIntel`, `dashboard`) → **`/Users/ludo/Mineblock-LLC-analytics`**
- Storefront (`shopifyWebhook`, `productProfiles`) → **`/Users/ludo/Mineblock-LLC-storefront`**

## Shared coordination files (Platform usually owns these — coordinate when other areas need changes)
- `app.js` (route mounting), `package.json`, `server/migrations/*`, `render.yaml`

If a change requires touching out-of-scope code, STOP and tell the operator — do not cross lanes.

---

# CLAUDE.md — Behavior Instructions

---

## DEFINITION OF DONE

A task is NEVER done when the code is written.
A task is NEVER done when it looks correct.
A task is ONLY done when it has been executed, tested,
verified, and the output has been confirmed correct.

This rule applies to every single task without exception.
There is no task type exempt from this rule.

---

## MANDATORY COMPLETION PROTOCOL

Before marking any task complete, execute every step in
this protocol in order. Skipping any step is not permitted.

### STEP 1. EXECUTE
Run the code, script, or function.
Do not assume it works. Run it.
If it cannot be run in the current environment, document
exactly why and mark the task BLOCKED, not complete.

### STEP 2. VERIFY OUTPUT
Inspect the actual output produced.
Confirm it matches what the task specified as done.
Do not confirm based on what the output should be in theory.
Confirm based on what it actually produced.

### STEP 3. TEST EDGE CASES
Test at least one failure scenario before marking complete.
Examples to test depending on task type:
- What happens if the API returns an error or timeout?
- What happens if the input is missing or malformed?
- What happens if the file does not exist?
- What happens if the network is unavailable?
- What happens if the data returned is empty?
The code must handle these without crashing.
If it crashes on any edge case, fix it before proceeding.
Do not mark complete until edge cases pass.

### STEP 4. FIX ALL ERRORS BEFORE MOVING ON
If any error occurs during steps 1, 2, or 3, fix it
immediately before proceeding to the next task.
Do not log the error and move on.
Do not note it as something to revisit later.
Fix it now. Re-run steps 1 and 2 to confirm the fix worked.
Only then mark the task complete.

### STEP 5. CONFIRM AND DOCUMENT
Write a completion entry in /logs/progress.md containing:
- Task name and number
- What was built
- How it was tested
- What the actual output was
- Any decisions made and why
- Timestamp

Only after this entry is written is the task considered done.

---

## ERROR HANDLING RULES

Every script and function must include error handling
before the task is marked complete.
Silent failures are not acceptable.
If something goes wrong the script must log it clearly
and exit cleanly rather than producing incorrect output silently.

Error logs go to /logs/errors.md with:
- Timestamp
- Task name
- Error message verbatim
- What was attempted
- What was tried to fix it

---

## NO ASSUMED SUCCESS

Never write or say:
- "This should work"
- "This ought to handle it"
- "This will likely run correctly"
- "I believe this is working"
- "This appears to be correct"

If it has not been run, it is not known to work.
Run it. Then report what actually happened.
Report actual output, not expected output.

---

## BLOCKED TASK PROTOCOL

If a task cannot be completed because of a missing
dependency, missing credential, unclear requirement,
or environment limitation:

1. Write the blocker to /logs/errors.md with full context
2. Mark the task as BLOCKED in /tasks/TASKS.md with a
   one line explanation of what is needed to unblock it
3. Move immediately to the next task in the queue
4. Never stall, never loop, never retry the same
   failed approach more than twice

---

## SESSION START PROTOCOL

At the start of every session, before doing anything else:

1. Read this file fully (includes AREA SCOPE: PLATFORM at the top)
2. Check /tasks/ACTIVE-platform.md for the current task queue (NOT /tasks/TASKS.md — that's historical)
3. Check /logs/progress.md for the last recorded checkpoint
4. Begin at the first incomplete task
5. Do not ask for confirmation before starting. Start.

---

## TASK QUEUE BEHAVIOR

Work through tasks in the order they appear in TASKS.md.
Complete one task fully before starting the next.
Do not work on multiple tasks simultaneously.
Do not skip a task unless it is explicitly marked BLOCKED.
If a task is BLOCKED, document it and move to the next one.

---

## DECISION MAKING

When a task requires a decision the operator has not specified:

1. Make the most conservative reasonable choice
2. Document the decision and the reasoning in /logs/progress.md
3. Flag it with the label DECISION MADE so the operator
   can review it on return
4. Never stall waiting for operator input unless the task
   literally cannot proceed without it

---

## DELIVERY STANDARD

When reporting a task as complete to the operator,
the operator must be able to use or run it immediately
with zero additional fixes required.

If the operator has to fix something after a task is
reported complete, that is a failure of this protocol,
not a new follow-up task.

Responsibility for delivery quality does not end when
the code is written. It ends when the output is verified.

---

## LOG FILE STRUCTURE

/logs/progress.md — completion entries for every finished task
/logs/errors.md   — error entries for every failure or blocker
/tasks/TASKS.md   — task queue with status per task

If these files do not exist at session start, create them
before beginning any task.

---

## TASK STATUS LABELS

Use only these labels in TASKS.md:

[ ]  — not started
[>]  — in progress
[x]  — complete and verified
[!]  — blocked, reason documented in errors.md

---

## PROGRESS LOG FORMAT

Each entry in /logs/progress.md must follow this format:

---
TIMESTAMP: YYYY-MM-DD HH:MM
TASK: [task name and number]
BUILT: [one paragraph describing what was built]
TESTED: [what was run, what edge cases were tested]
OUTPUT: [what the actual output was]
DECISIONS: [any decisions made, or NONE]
STATUS: COMPLETE
---

---

## ERROR LOG FORMAT

Each entry in /logs/errors.md must follow this format:

---
TIMESTAMP: YYYY-MM-DD HH:MM
TASK: [task name and number]
ERROR: [exact error message]
ATTEMPTED: [what was tried]
FIX TRIED: [what was done to resolve it]
STATUS: [FIXED or BLOCKED]
---
