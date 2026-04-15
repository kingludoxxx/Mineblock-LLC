# Task Queue

## Brief Pipeline Overhaul

[x] Phase 1: Product Context Integration — expanded buildProductContextForBrief() to ~30 fields
[x] Phase 2: Variants Generator — 3-agent deep analysis, hook quality gate, formatting rules
[x] Debug: B0160 hook misclassification — root cause identified, parser prompt hardened
[x] Phase 3: Drag-and-drop pipeline — HTML5 native drag with valid transition enforcement
[x] Phase 4: Ad Angle Integration — angles injected into variant + clone generation prompts
[x] Phase 5: Prompt Engineering — hook quality gate, WORD COUNT ENFORCEMENT, compliance rules, CTA
[x] Phase 6: 1:1 Script Clone — beat-by-beat preservation, product swap, hook quality gate
[x] BriefDetailModal — 3-agent analysis display, hook word count indicator
[x] Final QA Round — All pass. 8 commits pushed. Parser, variants, clone all verified.
[x] Render Deploy — dep-d79fu0euk2gs73ecve40 LIVE at 2026-04-06T00:33:27Z (commit 621a616)

## Team Member Management API

[x] Team member invite endpoint (POST /api/v1/users/invite + POST /api/v1/team/invite)
[x] List team members endpoint (GET /api/v1/team)
[x] Change team member role endpoint (PUT /api/v1/team/:userId/role)
[x] Deactivate team member endpoint (DELETE /api/v1/team/:userId)
[x] mustChangePassword flag in login response

## Statics Generation Pipeline (Separate Task)

[ ] Fix discount code replacement in statics prompts
[ ] Fix extra text generation in NanoBanana prompt
[ ] Fix product image orientation
[ ] Update product library data utilization
