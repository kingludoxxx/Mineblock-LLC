# FORK PROJECT — Mineblock ↔ Puure

**Owner**: Ludo · **Started**: 2026-08-07 · **Sale target**: Mineblock store + tool
**Retained**: Puure instance (same tool, Puure-only data)

## Goal
Duplicate the current Mineblock LLC dashboard into two independent, fully-functional instances that share the same codebase but hold different data + credentials.

## Deliverables
1. Two Render workspaces, each with own web service, Postgres, R2 bucket, crons, subdomain, env vars
2. One shared codebase — all hardcoded brand values lifted to env vars
3. Split data per rules below
4. Rotated secrets on both sides
5. Buyer handover packet: DB dump, env-var reference, README, runbook, architecture doc, migration checklist

## Split rules (brand-scoped)
- `product_profiles` → own brand only
- Brief-pipeline angles → own only
- Statics-pipeline angles + templates → own only
- FK-cascaded tables (`spy_creatives`, `launch_templates`, `statics_launches`, `brief_generation_jobs`, `ad_batches`, `ad_launches`, `advertorial_copies`, `image_scrape_jobs`, `creative_analysis`, `meta_account_audit`) → split with parent

## Copy-wholesale rules
- `brand_spy.*` (full library both sides)
- `users`, `roles`, `user_roles`, `sessions`, `audit_logs`
- `system_settings`, `api_keys`, `integrations`, `departments`
- Any reference/library table not tied to a specific brand's products

## Not in scope
- Multi-tenant refactor
- Setting up Puure integrations that don't exist yet (TripleWhale, Sellerboard, etc.)
- Feature stripping from either fork
- Legal drafting of sale agreement

## Phases
| # | Phase | Est. | Depends on |
|---|-------|------|-----------|
| 0 | Legal + snapshots | ½d (Ludo/lawyer) | — |
| 1 | Parameterize hardcoded brand strings | 2d | — |
| 2 | Fork the repo | ½d | 1 |
| 3 | Provision Puure Render workspace + infra | ½d | — (parallel with 1) |
| 4 | Data migration (split + wholesale copy) | 1d | 3 |
| 5 | Secret rotation | ½d | 4 |
| 6 | Buyer handover packet | 1–2d | 5 |
| 7 | Cutover | ½d | Buyer ready |

**Total: ~5–6 dev-days** (Phases 1–5) + buyer-gated 6–7.

## Risks
- `briefPipeline.js` product-code branches — cheap fix: keep both codes valid in both forks (inert if data absent).
- Secret leak to buyer — mandatory Phase 5 rotation.
- Orphan FKs after product split — cascade split via one script; verify FK integrity before delete.
- R2 bucket handover — Cloudflare-side, explicit `rclone` step.

## Definition of done
- Both instances deployed at own URLs
- Puure: only Puure products/angles visible; brand_spy library intact
- Mineblock (pre-handover): only Mineblock products/angles; all live integrations functional
- Zero cross-brand data leakage
- Handover packet complete
- Puure-retained secrets rotated

## Autonomy scope
- Free hand: Render workspaces/services/DBs/crons/env vars, GitHub commits/forks, non-destructive infra
- Pause + confirm for: table drops, service deletions, production secret rotation, buyer cutover
