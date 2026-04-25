# CREATIVE — Active Task Queue

Branch: `creative/active`
Worktree: `/Users/ludo/Mineblock-LLC-creative`

This file is the live queue for the Creative area. `tasks/TASKS.md` (the old shared file) is historical — do not edit it here.

Status labels: `[ ]` not started · `[>]` in progress · `[x]` complete · `[!]` blocked

---

## Open

- [ ] Statics logo-on-product rule — ban logo/brand mark on top of physical product in `buildNanoBananaPrompt` (`server/src/utils/staticsPrompts.js`). Never put product in retail packaging unless reference shows it.
- [ ] Statics `$` in bullets — continue spelling out dollar amounts (e.g. "One Dollar a Year"), raise bullet tolerance to 1.8x/38.
- [ ] Gamblingaddiction angle UUID — `briefAgent.js` has `null` UUID. Needs ClickUp angle dropdown UUID.
- [ ] Brief Agent trailing comma — `DIMARANAN,` editor name has stray comma (cosmetic).

## Completed

- [x] **Video Ads Languages Pipeline** (2026-04-25) — Full automation: ClickUp list created (ID 901523010131), Express route + React UI, Frame.io subfolder creation, Claude Sonnet translation, 13/13 QA tests PASS. Deploy: `2b779b8`, live at `/app/languages-pipeline`. TC-09 Frame.io v4 subfolder-reuse fix (`77d18f9`). Translation prompt strengthened for native-sounding copy (`36683ae`).

(see `tasks/TASKS.md` for full historical record before the area split)
