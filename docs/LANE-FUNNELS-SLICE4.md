# Lane 2 — Slice 4 build brief: FLOW ROUTING + REDIRECTS
_Prepared by the integrator. Launch this only AFTER slice-3 review fixes are merged._

## Goal
Make the canvas edges MEAN something at serve time, and add redirects. After
this slice, a published funnel routes a visitor page→page along the flow the
operator drew (main path), with the decline path (fallback) on upsell/downsell.

## Depends on
- Slice 2 render pipeline (server/src/services/funnelRender.js, funnelPublic.js)
- Slice 3 flow_layout persistence (funnels.flow_layout {nodes,edges[kind]})

## Non-negotiables (funnel-os DECISIONS.md)
- Redirects: EXACT match beats longest-prefix; QUERY STRING PRESERVED through
  the 301 (dropping it destroys attribution); only enabled rows.
- Flow is compiled at render time into a `window.__fos_flow` object the page
  runtime reads (next_path, fallback_path, per-button routes). Emit it into
  every rendered page.
- Fail-open serving; no-store on non-200; request-time flags.

## Deliverables
1. `funnel_redirects` table (in funnels.js ensureTables): id, funnel_id,
   from_path, to_path, match('exact'|'prefix'), code(301/302), enabled.
   CRUD endpoints under /api/v1/funnels/:id/redirects. Validate paths.
2. Redirect resolution in funnelPublic.js BEFORE page resolution: exact beats
   longest-prefix; preserve `?query`; only enabled; 301 default.
3. Flow compilation: in funnelRender, from funnel.flow_layout resolve, for the
   page being rendered, its main-target page slug and (if upsell/downsell) its
   fallback-target slug + any per-button bindings; emit `window.__fos_flow`
   (path-based, using the pages' slugs). Buttons/CTA blocks with a target ref
   resolve via this. Decline links follow fallback.
4. Canvas (client): a lightweight "Flow" affordance is already the edges; add
   a Redirects tab on the funnel (simple table CRUD) — minimal UI, theme tokens.

## Verify by execution
Own worktree (git -C /Users/ludo/Mineblock-LLC worktree add ... -b funnels/slice4-flow main),
own DB puure_flow, own port 4006, FUNNEL_PUBLIC_ENABLED=1. Prove with curl:
- 2-page funnel, main edge A→B; render A → emitted __fos_flow.next_path == '/b'.
- upsell with fallback edge → __fos_flow.fallback_path correct.
- redirect /old (exact) → /new preserving ?utm_source=x (301, Location has query).
- prefix vs exact precedence; disabled redirect ignored; query preserved.
- edges referencing archived/missing pages don't crash render (fail-open).
Adversarial review before merge. Integrator merges from Puure-integrator only.
