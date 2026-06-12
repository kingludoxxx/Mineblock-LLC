# Mineblock LLC — Admin Dashboard & Automation Platform

Onboarding + working conventions for anyone (human or Claude Code) working in this repo.
**Read this fully before your first change.**

---

## 1. What this is

A secure, modular admin dashboard + automation backend for Mineblock LLC's e‑commerce
operations: creative generation, ad launching, analytics, storefront sync, and platform/auth.

**Tech stack**
- Backend: Node.js + Express (`server/`)
- Frontend: React + Vite + Tailwind (`client/`)
- Database: PostgreSQL (migrations in `server/migrations/`)
- Auth: JWT + refresh tokens + bcrypt
- Hosting: Render.com (see `render.yaml`)

---

## 2. Getting started

**Prerequisites:** Node.js 18+, PostgreSQL 15+

```bash
# install
npm install
cd client && npm install && cd ..

# configure secrets — copy the template and fill in real values
cp .env.example .env        # then edit .env (NEVER commit it)

# database
npm run migrate
npm run seed                # optional: seed initial data

# run (two processes)
npm run dev                 # backend (Express, --watch)
cd client && npm run dev    # frontend (Vite) on :5173

# production build
npm run build
```

`npm start` runs the production server. `postinstall` installs Playwright Chromium
(used by some scraping/automation routes).

---

## 3. Environment variables

All secrets live in `.env` (gitignored — **never commit it**). `.env.example` lists every
required variable with placeholder values, grouped by purpose (core, auth/admin, AI
providers, and per-integration tokens for ClickUp, Triple Whale, Meta, Slack, Shopify, Whop).

Real credential values are **not** in the repo — ask the operator for them.

---

## 4. Architecture map

```
server/
  src/
    routes/        # one file per feature area (see worktree scopes below)
    services/      # external integrations (gemini, image gen, scrapers, meta, etc.)
    utils/         # shared helpers (statics prompts, etc.)
    controllers/   # platform controllers
    models/        # DB models
    middleware/    # auth, audit, etc.
    server.js      # entrypoint
  migrations/      # SQL migrations — run with `npm run migrate`
  seeds/
client/            # React + Vite + Tailwind admin UI
scripts/           # one-off + maintenance scripts
render.yaml        # Render service + cron definitions
app.js             # shared app wiring
```

---

## 5. Worktree / area model (IMPORTANT)

Work is split into **area lanes**, each on its own branch, so multiple people/agents can
work in parallel without colliding. `main` is the integration branch.

| Area | Branch | Owns (routes / services) |
|---|---|---|
| **Creative** | `creative/active` | briefAgent, briefPipeline, advertorialPipeline, staticsGeneration, staticsTemplates, iterationKing, clickupWebhook, geminiImageGen, imageGeneration, redditScraper, utils/staticsPrompts |
| **Ads** | `ads/active` | adLauncher, adRejectionMonitor, adsControlCenter, videoAdsLauncher, metaWebhook, metaAdsApi |
| **Analytics** | `analytics/active` | kpiSystem, creativeAnalysis, creativeIntel, dashboard |
| **Storefront** | `storefront/active` | shopifyWebhook, productProfiles |
| **Platform** | `platform/active` | auth, users, team, departments, settings, audit, health, controllers, models, middleware, authService, auditService |

**Shared — coordinate before editing:** `app.js`, `package.json`, `server/migrations/*`, `render.yaml`.

**Rule:** stay in your lane. If a change requires touching code owned by another area,
STOP and coordinate — don't cross lanes in a single branch. Merge shared-file changes early.

---

## 6. Deploy

Hosting is Render.com, defined in `render.yaml` (web service + cron jobs). Deploys trigger
from `main`. Don't change `render.yaml` without coordinating — it controls production
services and scheduled jobs.

---

## 7. Security

- Secrets only in `.env` (gitignored). Never paste real keys into code, docs, or commits.
- Don't commit machine-specific files (handled by `.gitignore`).
- Rotate any credential that may have been exposed; prefer a git credential helper over
  embedding tokens in remote URLs.

---
---

# Operating protocol (Mineblock standard)

The standard the operator expects for every task. Applies to humans and Claude Code alike.

## Definition of Done

A task is **never** done when the code is merely written or looks correct. It is done only
when it has been **executed, verified, and confirmed**.

**Mandatory completion protocol — every step, in order:**
1. **EXECUTE** — Run the code/script/function. Don't assume it works. If it can't run in the
   current environment, document why and mark it **BLOCKED**, not complete.
2. **VERIFY OUTPUT** — Inspect the actual output and confirm it matches the requirement.
   Confirm based on what it produced, not what it should produce in theory.
3. **TEST EDGE CASES** — Test at least one failure scenario (API error/timeout,
   missing/malformed input, missing file, network down, empty data). It must not crash.
4. **FIX ALL ERRORS BEFORE MOVING ON** — Don't log-and-continue. Fix now, re-run steps 1–2.
5. **CONFIRM & DOCUMENT** — Record what was built, how it was tested, the actual output, and
   any decisions, in `logs/progress.md`.

## Error handling

Every script/function must handle errors before being marked complete. **No silent
failures** — log clearly and exit cleanly rather than producing wrong output silently.
Error entries go in `logs/errors.md` (timestamp, task, verbatim error, what was attempted,
what was tried to fix it).

## No assumed success

Never claim "this should work / appears correct / will likely run." If it hasn't been run,
it isn't known to work. Run it, then report **actual** output.

## Blocked tasks

If blocked by a missing dependency/credential, unclear requirement, or environment limit:
document the blocker, mark the task BLOCKED with a one-line note on what's needed, move to
the next task. Never retry the same failed approach more than twice.

## Decisions

When a decision isn't specified: make the most conservative reasonable choice, document it
with the label **DECISION MADE**, and continue. Don't stall unless the task literally cannot
proceed.

## Delivery standard

When you report a task complete, it must be usable/runnable immediately with zero additional
fixes. If the operator has to fix something afterward, that's a protocol failure, not a new
task.

## Logs & tasks

- `logs/progress.md` — completion entry per finished task
- `logs/errors.md` — error/blocker entries
- `tasks/` — task queue (status labels: `[ ]` not started · `[>]` in progress · `[x]` done & verified · `[!]` blocked)

Create these files if they don't exist before starting work.
