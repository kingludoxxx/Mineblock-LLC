# PLATFORM — Active Task Queue

Branch: `platform/active`
Worktree: `/Users/ludo/Mineblock-LLC-platform`

This file is the live queue for the Platform area (auth, users, team, departments, settings, audit, health, middleware, shared services). `tasks/TASKS.md` (the old shared file) is historical — do not edit it here.

Status labels: `[ ]` not started · `[>]` in progress · `[x]` complete · `[!]` blocked

---

## Open (infra / ops)

- [ ] DELETE `mineblock-db-2` from Render dashboard — accidentally created 2026-04-20.
- [ ] Add `GEMINI_API_KEY_2` + `GEMINI_API_KEY_3` to Render — async rotation code is LIVE in `edbcda4`. Without these, statics runs on 1/3 quota.
- [ ] Add `FRAMEIO_CLEANUP_SECRET` to Render (if not set). Falls back to `CRON_SECRET`.
- [ ] Disable Make.com Frame.io folder-creation scenario — duplicates folders now that webhook `bde532e` is live.

## Completed

(none yet)
