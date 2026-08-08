# Funnels (Lane 2) — Acceptance Spec from friend's live tool screenshots
_Captured 2026-08-08 from Ludo's screenshots of the reference system
("Listicle Builders — Direct-response funnels OS"). This is the UI/feature
acceptance spec; the engineering constraints live in /Users/ludo/funnel-os/docs
(DECISIONS.md is non-negotiable). Ludo's placement decision: the Funnels
entry lives under the existing **Production** group in the Puure sidebar._

## Screens observed

### 1. Funnels Dashboard (their "Dashboard" under Tools)
- Date-ranged (vs previous period), store timezone (theirs: Madrid).
- KPI cards: Net Sales, Orders, AOV Post-upsell, Sessions, Conv %, Upsell
  Revenue, Clicks, Ad Spend ("no spend sync" empty state), Net ("needs ad
  spend"), Net After Costs ("needs costs"). Each card shows Δ% vs prev period.
- Revenue Today big number + intraday chart with tabs Revenue|Orders|Sessions|Net.
- "Last 60 minutes" live chart + "N live now" + today totals.
- Insights cards (auto-generated warnings, e.g. "Meta logged 296 tracking
  events but delivered 0 — re-check credentials"; "top mover" callouts).
- Funnels·today mini-table + Top movers vs previous.
- NOTE: needs tracking + costs lanes; build LAST in lane 2 or defer to analytics lane.

### 2. Funnels list
- Subtitle: "Listicles, advertorials, landing pages, and multi-page checkout funnels".
- Filter chips: All | Published | Inactive | Not Yet Published | Deleted;
  category dropdown; grid/list view toggles; sort (Date Created); "Hidden N";
  date picker; Import Funnel; + New Funnel.
- Row per funnel: avatar initials, name, expandable "N sites" (channel
  sub-rows, e.g. Google/Meta each with published badge + per-channel metrics
  + external-link icon).
- Row metrics: AT CHECKOUT · VISITORS · SALES · REVENUE · CTR · AOV PRE-UPSELL
  · AOV POST-UPSELL · REFUNDS · NET · PROFIT (— until data exists).
- Channel tags under name (Google, Meta).
- KEY CONCEPT: one funnel groups multiple "sites" (channel variants). Maps to
  our schema as funnel → sites/variants (phase 2 of lane 2; slice 1's single
  funnel is the degenerate case).

### 3. Funnel canvas (the builder core — THIS is the editor, not a form)
- Header: back, status dot, funnel name + (channel), PUBLISHED badge, path
  (/sites/stripe-copy), Settings dropdown, "Saved just now", Domain picker
  (custom domain + NOT DEFAULT badge), Manage, Live indicator, Analytics,
  Live site (external), green Publish button.
- Live badge top-right: "21 live · 48 unique today".
- LEFT PANEL "ADD A PAGE" (page-type palette — these are the page types):
  - Storefront (Product grid)
  - Quiz (Multi-step questions)
  - Lead / Advertorial (Listicle, VSL)
  - Checkout (Payment page)
  - Upsell (1-click offer)
  - Downsell (Fallback offer)
  - Thank You (Confirmation)
  - Customer Portal (Self-service)
  - Generic / Opt-in (Blank + form)
  - Clone a page (Link · HTML · file upload)
  - Page library (N pages · drag to clone)
- CANVAS: infinite zoom/pan board; pages appear as live mini-thumbnails with
  per-page stat chips (visitors, CTR, CVR); connection curves between pages
  (flow edges); selected page gets a floating toolbar: settings, analytics,
  edit, present, preview/eye, duplicate, code — plus its public URL.
- Bottom-right toolbar: selection, undo/redo, fit, frame, grid, zoom %,
  S/M/L device-size toggles.
- Observed scale: an "angle map" — 12 labeled angle groups (Angle1 No Power …
  Angle12 Rationing), each angle column of listicle/advertorial pages, all
  flowing into ONE shared checkout then a chain of ~10 upsell pages then
  thank-you. This is the lander-angles → shared money-path pattern from
  DATA-FLOW.md. Flow edges must support many→one.

### 4. Clone a page modal
- Title: "Clone a page — paste code or import a file"; subtitle: "Scan strips
  junk scripts & tracking pixels (Meta, Google, …), the source title & meta —
  then splits it into sections."
- Tabs: Paste code | Import file | Generate with AI | From Shopify.
- Import: .html or .zip ("HTML or a Claude Design .zip export"); optional
  original URL (fixes relative image/link paths); "Scan & clean" action;
  result chips: Junk scripts removed · Meta+Google pixels stripped · Split
  into sections · Source title & meta removed; footer "N of M sections
  selected" → "Create page · N sections".
- Toast after create: `Created "{{zeroHeadline}}" with 2 sections` — cloned
  pages support {{placeholder}} template tokens in copy.

## Build-order mapping (updates the 6-slice plan)
- Slice 1 (CRUD) — unchanged, in progress. Page `type` enum matches palette.
- Slice 2 (render) — unchanged; page thumbnails on canvas come later (use
  type-colored placeholders first).
- Slice 3 (builder UX) — TARGET IS THE CANVAS, not a form editor: pan/zoom
  board, ADD A PAGE palette (creates typed page), page cards w/ toolbar
  (edit/duplicate/preview/settings), simple edge-drawing between pages
  (writes flow_layout). Page CONTENT editing = separate editor screen.
- Slice 4 (flow+redirects) — edges on canvas ARE flow_layout; decline path =
  downsell edge kind 'fallback'.
- Slice 5 (domains) — Domain picker in header; custom hostname per funnel.
- Slice 6+ — Clone a page (Paste/Import first; AI + From Shopify later),
  Page library, funnel list channel sub-rows ("sites"), Import Funnel,
  per-page live stats chips (needs tracking lane), Funnels Dashboard KPIs
  (needs tracking + costs lanes).

## Slice 3 (canvas) — acceptance checklist against Ludo's screenshots
Reviewer must tick every line against the screenshots before integration:
- [ ] Header bar: back arrow · status dot · funnel name · PUBLISHED badge ·
      path subtitle · Settings dropdown · "Saved just now" autosave hint ·
      Domain picker slot (placeholder until slice 5) · Analytics + Live site
      buttons (placeholder targets ok) · green/accent Publish button.
- [ ] Live counter chip top-right ("N live · M unique today") — placeholder
      values until tracking lane, but the chip exists.
- [ ] Left panel "ADD A PAGE": collapsible; EXACT items + subtitles:
      Storefront (Product grid) · Quiz (Multi-step questions) ·
      Lead / Advertorial (Listicle, VSL) · Checkout (Payment page) ·
      Upsell (1-click offer) · Downsell (Fallback offer) ·
      Thank You (Confirmation) · Customer Portal (Self-service) ·
      Generic / Opt-in (Blank + form) · divider · Clone a page (disabled
      "coming soon" ok this slice) · Page library (disabled ok).
      Clicking an item creates a page of that type at canvas center.
- [ ] Canvas: pan (drag empty space) + zoom (wheel/buttons, % indicator);
      pages as cards (type-colored placeholder thumbnail this slice) with
      name + type label + stat chip row (— placeholders); drag to reposition
      (persists to flow_layout.nodes x/y).
- [ ] Edges: drag from a card's edge handle to another card draws a curve;
      persists to flow_layout.edges {source,target,kind:'main'}; a second
      distinct handle or modifier creates kind:'fallback' (decline path,
      visually distinct); edge deletable. Many→one supported (angle pattern).
- [ ] Selected card floating toolbar: settings · analytics (placeholder) ·
      edit (→ page editor route) · preview (→ /f preview URL) · duplicate ·
      code/JSON — plus the page's public URL text.
- [ ] Bottom-right toolbar: undo/redo (canvas ops) · zoom fit · zoom % ·
      S/M/L device toggles (affect page-card aspect only this slice).
- [ ] Funnels list page upgraded toward screenshot: filter chips (All/
      Published/Inactive/Not Yet Published/Deleted), sort, search, metric
      columns rendered with "—" placeholders until data lanes land.
- [ ] Puure branding everywhere; p-6 padding; theme tokens; dark theme.

## Constraints reminder (from funnel-os DECISIONS.md — apply to every slice)
Fail-open serving; no-store on non-200/drafts; blocks validated on write;
(funnel_id, slug) partial-unique arbitration; query string preserved through
redirects; render-cache key includes every byte-changing axis; public serving
ships behind default-off env flag until Ludo's explicit go.
