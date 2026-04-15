# Error Log

---
TIMESTAMP: 2026-04-15 05:35
TASK: Frame.io cleanup — move stray projects into FRAMEIO_EDITING_FOLDER, delete originals
ERROR:
  - v2 GET /me/teams            -> 404 Not found
  - v2 GET /projects/19c0...    -> 404 Not found (legit project invisible to v2 token)
  - v2 GET /assets/19c0.../...  -> 403 Forbidden
  - v2 GET /assets/2eb1.../children -> 404 Not found (target editing folder invisible)
  - v4 GET /me                  -> 401 Unauthorized "Invalid or missing authorization token"
  - v4 GET /assets/:id          -> 404 "no route found for GET /v4/assets/..."
ATTEMPTED:
  1. Hit existing debug route /frame-diagnose -> v2 /me works (user info@trypuure.com,
     account 4d65ef83-9323-4ef2-ae6a-585d38cce2af) but every v2 read against the target
     project/folder returns 404/403.
  2. Hit /frame-list -> no teams, no projects returned. v4 /me returns 401.
  3. Hit /frame-children/:FRAMEIO_EDITING_FOLDER (both v2 and v4 paths) -> both fail.
  4. Searched repo + render.yaml for any alternate Frame.io v4 token -> none exists.
FIX TRIED:
  None possible without a v4 API token. Exact root cause already documented in
  MEMORY.md: "fio-u-... token is v2; workspace is v4. v2 token sees 404 for ALL content.
  createFrameFolder() webhook code has NEVER worked."
STATUS: BLOCKED
NEEDED TO UNBLOCK:
  - Issue a v4 API token via Adobe Developer Console (Server-to-Server OAuth for Frame.io)
    and set it on Render srv-d6qavvf5gffc73em69n0 as FRAMEIO_V4_TOKEN.
  - OR: Ludo drags the 4 stray projects into Mineblock LLC -> Video Ads Pipeline in the
    next.frame.io UI manually (same route Make.com editing scenario requires).
---

---
TIMESTAMP: 2026-04-06 14:30
TASK: Brief Pipeline Script Parser Hook Detection — Test 1 (Mislabeled Hooks)
ERROR: Parser returned 3 hooks instead of expected 2. Hook 3 ("Real mining devices make 144 blockchain attempts per day. Fakes make zero. The difference is verifiable in 10 seconds.") is a 3-sentence data comparison that should be body text per the CRITICAL DISTINCTION rules, but was classified as hook with mechanism "statistic".
ATTEMPTED: Ran production buildScriptParserPrompt() with claude-haiku-4-5-20251001 against a script with 4 labeled hooks where only 2 are true hooks.
FIX TRIED: None yet — this is a prompt weakness, not a code bug. The "statistic" mechanism enum value likely encourages the model to keep data-point text as hooks.
STATUS: OPEN — prompt improvement recommended
---

---
TIMESTAMP: 2026-04-05 12:00
TASK: Template Intelligence System — Migration & API Endpoints
ERROR: Node.js runtime not available in the sandbox environment — cannot syntax-check or run server to verify endpoints
ATTEMPTED: Searched for node binary in PATH, nvm, volta, fnm, asdf, /usr/local/bin, /opt/homebrew/bin
FIX TRIED: N/A — environment limitation, not a code issue
STATUS: BLOCKED (syntax-check and runtime verification only; code has been written and visually inspected)
---

