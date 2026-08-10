// THEME SYSTEM schema — single owner of the lb_funnel_themes DDL.
//
// Port of funnel-os `lb_themes` (backend/app/services/listicle_themes_service.py
// + the /themes* endpoints in routers/listicle_builders.py) to Postgres.
//
// WHAT A THEME IS HERE: a named bag of design tokens. It is NOT a renderer
// input. Applying a theme is a MACRO over the funnel's EXISTING settings —
// it writes settings.brand_colors / settings.fonts through the same PATCH the
// General and Fonts sections already use, so funnelRender.js needs zero
// changes and a theme can never introduce a new emission path. See
// funnelThemes.js § TOKEN SUPPORT for which tokens actually reach the page.
//
// TWO DELIBERATE DIVERGENCES FROM THE REFERENCE:
//
//  1. NO `extra_css` COLUMN. The reference stores per-theme CSS and stamps it
//     onto the site as `_applied_extra_css`. We have no theme CSS sink: the
//     only funnel-level raw-CSS door is settings.custom_head_code, which is an
//     operator-authored escape hatch. Letting a theme apply overwrite it would
//     destroy hand-written head code to deliver a field the renderer would not
//     otherwise read. A column nothing can consume is a promise the UI would
//     have to lie about, so it does not exist.
//
//  2. PRESETS ARE NOT ROWS. Like the reference, the 7 presets are in-memory
//     constants (funnelThemes.js PRESETS) stamped read-only at read time.
//     They are never inserted, so a preset cannot be edited, archived, or
//     drift per install — and `GET /presets` needs no database at all.
//
// workspace_id: this install is SINGLE-TENANT (same posture as
// funnelCostsSchema.js). The column exists so the reference's per-workspace
// scoping survives the port and every query is already written scoped, but it
// carries one constant value (funnelThemes.DEFAULT_WORKSPACE). Adding real
// tenancy later is a value change, not a schema migration.
import { pgQuery } from '../db/pg.js';

// Concurrent requests must not run the DDL simultaneously — Postgres throws on
// parallel CREATE TABLE IF NOT EXISTS (pg_type unique violation). A single
// in-flight promise serializes setup; on failure it resets so the next request
// retries. (Same pattern as funnelCostsSchema.js / checkoutSchema.js.)
let tablesReadyPromise = null;

export function ensureFunnelThemesTables() {
  if (!tablesReadyPromise) {
    tablesReadyPromise = createTables().catch((err) => {
      tablesReadyPromise = null;
      throw err;
    });
  }
  return tablesReadyPromise;
}

// Test-only: drop the memoized promise so a harness can re-run the DDL against
// a database it just truncated. Never called by the route file.
export function _resetFunnelThemesTablesForTests() {
  tablesReadyPromise = null;
}

async function createTables() {
  // ── lb_funnel_themes — one row per operator-saved theme ──────────────────
  //
  // tokens JSONB: the whole token bag, stored WHOLE even though only a subset
  // reaches the renderer today (funnelThemes.TOKEN_SUPPORT). Storing the full
  // bag is deliberate — an imported or hand-tuned theme keeps its background /
  // radius / cta values so that widening the renderer later is a read change,
  // not a data-loss recovery. The UI is what must be honest about which
  // tokens apply; the store does not need to forget them.
  //
  // Soft delete (archived), matching the reference's `$set {archived: true}`:
  // an applied theme's name is quoted in operator memory long after the theme
  // is retired, and a hard DELETE makes that provenance unrecoverable.
  await pgQuery(`
    CREATE TABLE IF NOT EXISTS lb_funnel_themes (
      id            TEXT PRIMARY KEY,
      workspace_id  TEXT NOT NULL DEFAULT 'default',
      name          TEXT NOT NULL DEFAULT 'Untitled theme',
      tokens        JSONB NOT NULL DEFAULT '{}'::jsonb,
      preview_url   TEXT NOT NULL DEFAULT '',
      imported_from TEXT NOT NULL DEFAULT '',
      archived      BOOLEAN NOT NULL DEFAULT FALSE,
      created_by    TEXT NOT NULL DEFAULT '',
      created_at    TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      updated_at    TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )
  `);

  // The list read is always (workspace, not archived, newest first).
  await pgQuery(`
    CREATE INDEX IF NOT EXISTS lb_funnel_themes_ws_idx
      ON lb_funnel_themes (workspace_id, archived, updated_at DESC)
  `);
}

export default { ensureFunnelThemesTables };
