# CREATIVE — Active Task Queue

Branch: `creative/active`
Worktree: `/Users/ludo/Mineblock-LLC-creative`

This file is the live queue for the Creative area. `tasks/TASKS.md` (the old shared file) is historical — do not edit it here.

Status labels: `[ ]` not started · `[>]` in progress · `[x]` complete · `[!]` blocked

---

## Open
- [!] Brief Agent trailing comma — `DIMARANAN,` editor name has stray comma (cosmetic). Searched extensively in briefAgent.js, clickupEditors.js, and entire CREATIVE scope — cannot locate the stray comma. See /logs/errors.md for details. Operator clarification needed on where this issue is located.

## Completed

- [x] **Gamblingaddiction angle UUID** (2026-06-01) — Updated ANGLE_OPTIONS in briefAgent.js (line 74) from `null` to ClickUp UUID `253d18aa-9114-40a4-97d7-a77b0498bb25` for the Gambling angle option. Fetched from ClickUp API field options. Syntax validated.
- [x] **Statics $ in bullets** (2026-06-01) — Added BULLET RULES to claude_analysis prompt (line 1435, staticsGeneration.js): (1) Spell out dollar amounts as words (e.g., "$50" → "Fifty Dollars"), (2) Bullet length tolerance 1.8x original, max 38 characters. Syntax validated.
- [x] **Statics logo-on-product rule** (2026-06-01) — Added two PRODUCT_RULE constraints to buildNanoBananaImagePrompt (lines 197-199, staticsPrompts.js): (1) NEVER overlay logo/brand marks ON TOP OF physical product itself, (2) NEVER render product in retail packaging unless reference shows it. Unit tested. Deploy ready.
- [x] **Video Ads Languages Pipeline** (2026-04-25) — Full automation: ClickUp list created (ID 901523010131), Express route + React UI, Frame.io subfolder creation, Claude Sonnet translation, 13/13 QA tests PASS. Deploy: `2b779b8`, live at `/app/languages-pipeline`. TC-09 Frame.io v4 subfolder-reuse fix (`77d18f9`). Translation prompt strengthened for native-sounding copy (`36683ae`).

(see `tasks/TASKS.md` for full historical record before the area split)
