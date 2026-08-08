# BRIEF — Statics Image Generator: product-image selection (Mineblock) + Puure multi-product

> Handoff brief for a fresh session. Everything under **Verified findings** was confirmed
> by reading the code and querying the live production API on 2026-07-17 — it is **not**
> assumption. Line numbers were accurate at the time of writing; re-verify before relying
> on them, and trust the code over this doc if they ever disagree.

---

## 0. TL;DR — two workstreams, in this order

**A. Mineblock-first (standalone win, do this first).**
The generator has **only ever used `product_images[0]`**. Mineblock/MinerForge has 5
product images and images #2–5 have **never been used, ever** — not in a generate, not in
an iteration, not in a regenerate. This is the verified cause of the operator's
long-standing complaint: *"my product images look the same inside every static."* It was
never the prompts or the model. Fixing this is the highest-leverage change in the tool and
**it delivers value even if Puure never ships.**

**B. Puure multi-product enablement.**
Make the statics generator work for Puure the way we already made the Brief Pipeline work
for it. Less is missing than you'd expect (Puure is already in the selector; its angles
likely already auto-import) — but its context isn't wired and it has no product images.

Both are **additive**. Mineblock's behaviour must not regress.

---

## 1. What the Statics tool is

Takes a **League reference** (a competitor's static ad we've scraped — the operator says
"lead", they mean the **League** reference library) plus **our product**, and rebuilds that
ad's winning composition for our product.

Two-step AI pipeline:
1. **Step 1 — Claude analysis.** Claude gets the *reference image* + our *product image* +
   the flattened product profile, and returns structured JSON: composition, visual swaps,
   text swaps.
2. **Step 2 — NanoBanana image gen.** The image prompt is built from Claude's JSON and
   **ONLY the product image** — deliberately *not* the reference image. This is a guard
   against reference bleed-through; the code comments cite real bugs (BUTCHERBOX text
   surviving in column headers, foreign logos leaking). **Do not "fix" this.**

**The consequence that drives this whole brief: the product image is the visual source of
truth.** Wrong/missing/always-the-same product image → wrong/same output, every time.

### Where it lives
| Path | Lines | Role |
|---|---|---|
| `server/src/routes/staticsGeneration.js` | ~8,143 | main engine (generate / iterate / regenerate / launch) |
| `server/src/routes/staticsTemplates.js` | ~608 | prompt templates (**DB-stored**) |
| `server/src/utils/staticsPrompts.js` | ~361 | prompt builders + product-row → flat profile |
| `client/src/pages/production/statics/` | — | UI (ConfigSidebar, LeagueImportModal, PipelineView, …) |
| `client/src/components/ProductSelector.jsx` | — | shared product dropdown |

---

## 2. Verified findings

### 🔴 A. Only `product_images[0]` is EVER used — Mineblock's real bug

`firstProductImageFromRow()` (`staticsGeneration.js:1507`) hardcodes index 0:

```js
if (Array.isArray(pi) && pi.length > 0) {
  const first = pi[0];                       // ← always image #1, forever
  if (typeof first === 'string' && first.length > 10) return first;
  if (first && typeof first === 'object' && first.url) return first.url;
}
```

**Every path calls it and takes the first image:**
- `/generate` + `/iterate` — `staticsGeneration.js:2753`
- `regenerate` — `staticsGeneration.js:5814` (also `throw new Error('no product_image_url')` if absent)

**There is no selection logic anywhere** — no index param, no per-angle/template choice,
no rotation, no random. **And there is no picker in the UI or API**: a search of the whole
statics UI surfaces only `{{PRODUCT_IMAGE_NOTE}}` in `StaticsSettingsModal.jsx:22`, which
is a *prompt variable*, not an image chooser. There is no way to say "use image 3."

**Evidence of impact:** MinerForge (id 3) has **5** product images. Image #1 has done
**100%** of the work. This looks like a v1 simplification nobody revisited — a missing
feature, not a decision. Nothing in the code suggests it was deliberate.

**The fix (recommended shape):**
1. **Deliberate selection** — choose the shot from the angle/template/concept
   (mechanism-led static → lights-on shot; scale claim → in-hand shot). This is the real win.
2. **Manual override in the UI** — let the operator pick the shot for a given run.
3. **Avoid pure random rotation** — it buys variety but picks the wrong shot half the time.

Applies to **all three** paths (generate, iterate, regenerate), or iterations will keep
collapsing back to the same photo.

### ✅ B0. Already working for Puure — do NOT rebuild
- **Puure is already in the selector.** `ProductSelector` calls `GET /product-profiles`
  and lists everything. Live: `37:Puure (PUURE) | 3:Miner Forge Pro`.
- **`productId` is already required and product-driven** (`staticsGeneration.js:2738`); an
  older "silently default to Miner Forge Pro" bug was already fixed. Product loads from the
  shared `product_profiles` table — the **same table the Brief Pipeline uses**.
- **Angle auto-import is likely already there.** `ConfigSidebar.jsx:130` renders "Product
  angles from library" with funnel-stage labels whenever a product has angles — and **Puure
  has 7**. **Verify in the UI before writing any code here.**
- **Prompts are product-agnostic.** `grep -i "minerforge|mineblock|bitcoin|crypto"` over
  `staticsPrompts.js` → **0 hits**. Nothing hardcoded to rip out.

### 🔴 B1. Puure has ZERO product images (blocker)
| | Puure (37) | MinerForge (3) |
|---|---|---|
| `product_images` | **0** | 5 |

`firstProductImageFromRow` returns `null`, so at `staticsGeneration.js:2165-2191`
`productImageMsg` stays null and the `PRODUCT_IMAGE_NOTE` ("IMAGE 2 … is the PRODUCT we
are advertising. Use it as the visual source of truth") is never added.

**This fails *soft*, which is worse than a crash** — `/generate` still returns a polished
image that simply isn't the Puure device. (`regenerate` does throw.) Fix first; little else
is testable until it's done. See §3 for the asset spec.

### 🔴 B2. Statics never reads `master_brief`
`grep -c master_brief server/src/utils/staticsPrompts.js` → **0**.
No `master_brief` / `buildProductContext` / `PRODUCT_CONTEXT` in `staticsGeneration.js`.

**Puure's `master_brief` is 24,451 characters** of exactly the needed context (voice,
mechanism, avatars, angle strategy, offer, compliance) — and the statics tool cannot see
any of it. It only sees the ~35 flat columns from `mapProductRowToFlatProfile()`
(`staticsPrompts.js:127-183`). The Brief Pipeline already solved this — see §4.

### 🟡 B3. Puure's flat profile is thin exactly where statics reads
| Product | Filled | Empty |
|---|---|---|
| **Puure (37)** | **19/33** | **14** |
| MinerForge (3) | 28/33 | 5 |

**Empty on Puure (all read by the statics prompts):** `tagline, ingredients,
winning_angles, custom_angles_text, offer_details, bundle_variants,
compliance_restrictions, max_discount, discount_codes, offers, notes, product_type,
unit_details, product_url`

Puure would render with holes exactly where MinerForge is rich — offer, pricing, discount,
compliance. Most of this content **does** exist inside the master brief, so fixing B2 may
cover much of B3. Decide deliberately: backfill the columns, rely on the master brief, or
both — and write down which.

### ℹ️ Statics does NOT push to ClickUp
`STATIC_ADS_LIST` appears only in `clickupWebhook.js`, never in `staticsGeneration.js`. So
do **not** port the Brief Pipeline's `pipelineForProduct` ClickUp routing. If Puure statics
ever need a ClickUp destination, that is a **separate scoped decision** — confirm with the
operator, don't invent it.

---

## 3. Product image asset spec (what "good" looks like)

Because Step 2 composites the product into a brand-new scene and is fed **only** the
product image:

- **Transparent PNG cutout — not optional.** Any background reintroduces exactly the
  bleed-through the architecture exists to prevent.
- **High resolution, sharp, product fills the frame.**
- **No baked-in shadows or reflections** — the generator adds scene-appropriate lighting;
  baked-in lighting fights it.
- **No text, watermarks, logos, or borders** — they survive into the output.
- **Neutral, even lighting** — not a stylized hero shot with a vibe already applied.

**Recommended set per product** (only useful once §2A selection is built):

| Shot | Used for |
|---|---|
| Front hero | default / safe composition |
| 3/4 angle | dimensional layouts, depth |
| Mechanism / in-action detail (e.g. Puure's TriRed lights on) | mechanism-led statics |
| In-hand / scale (cutout incl. hand) | size claims ("palm-sized", "ten minutes on the couch") |
| *Optional:* with box/packaging | offer- and bundle-led statics |

Operator has the Puure assets — **ask for them; do not scrape or invent product imagery.**

---

## 4. The pattern to mirror (how the Brief Pipeline solved B2)

Read `server/src/routes/briefPipeline.js:2467-2525` — `buildProductContextForBrief(p)`.
It assembles the flat fields **and then appends the whole master brief**:

```js
if (p.master_brief && String(p.master_brief).trim()) {
  return `${base}\n\n===== MASTER PRODUCT BRIEF — FULL DOCUMENT (primary source of truth) =====\n\n${String(p.master_brief).trim()}`;
}
```

That single move is what made Puure briefs actually sound like Puure. Statics needs the
equivalent: get the master brief into the Step 1 Claude prompt
(`buildClaudeAnalysisPrompt`, `staticsPrompts.js:67`), most likely as a new
`{{PRODUCT_CONTEXT}}` / `{{MASTER_BRIEF}}` template var.

⚠️ **Token budget** — 24.5k chars is large and Step 1 already carries two images. Check the
existing template/token handling before dumping it in whole; a targeted excerpt may be
needed. **Never silently truncate — if you cap it, log it.**

⚠️ **Templates are DB-stored** (`staticsTemplates.js`). A new `{{VAR}}` in code does
**nothing** until the stored template references it. The Brief Pipeline hit this exact trap
and solved it with a **signature-based re-seeder** — search `CLONE_V2_SIGNATURE` in
`briefPipeline.js`. Expect to do the same, or your change will look deployed and silently
do nothing.

Other precedents: product/angle/avatar catalogs all come from `product_profiles` (already
shared). Puure's angles/avatars/master brief were seeded via migrations `069`, `070`, `079`.

---

## 5. The work

**Workstream A — Mineblock (do first, ships alone):**
1. Add deliberate product-image selection (angle/template/concept-driven) + a UI override.
   Cover **all three** paths: generate, iterate, regenerate.
2. Regression-check: an existing MinerForge flow must still work identically when the
   selection resolves to image #1.

**Workstream B — Puure:**
3. **Add Puure product images** (blocker). Populate `product_profiles.product_images` for
   id 37. **Inspect MinerForge (id 3) first** and copy its existing convention rather than
   guessing (data URI vs URL; `firstProductImageFromRow` handles JSONB *and* JSON-encoded
   TEXT, so whatever you write must too).
4. **Wire `master_brief` into the statics product context** (mirror
   `buildProductContextForBrief`), respecting the token-budget and DB-template traps above.
5. **Confirm Puure angle auto-import** actually works in the UI before building anything.
6. **Decide + handle the 14 empty flat fields** (B3). Backfill via migration and/or rely on
   the master brief. Document the choice.
7. **Regression-check Mineblock again.** Branch on the product (the Brief Pipeline branches
   on `product_code === 'PL'`) rather than mutating shared behaviour.

---

## 6. Definition of done (this repo's standard — enforced)

Per `CLAUDE.md`: **written ≠ done. Executed + verified + confirmed = done.**

- [ ] **A:** Two Mineblock statics generated with *different* product shots — prove #2–5 are
      finally reachable, and that the choice is deliberate (right shot for the concept).
- [ ] **B:** Generate a real **Puure** static from a real League reference, end to end.
- [ ] Output shows the **real Puure device** (proves the product image is wired).
- [ ] Copy/voice reflects **Puure's master brief** (proves context is wired).
- [ ] A **Puure angle** from the library is selectable and reflected in the output.
- [ ] **MinerForge regression:** existing flow unchanged.
- [ ] Log the run in `logs/progress.md` (built / tested / **actual** output / decisions).
- [ ] **No assumed success.** Report real output, including failures.

---

## 7. Gotchas

- **Silent-failure product image.** No product image ≠ error on `/generate`. It returns a
  *nice wrong image*. Always confirm the real device is in the output — don't trust a 200.
- **DB-stored prompt templates.** Code-side `{{VARS}}` are inert until the stored template
  uses them. See the `CLONE_V2_SIGNATURE` re-seed pattern.
- **NanoBanana intentionally never sees the reference image.** Deliberate guard against
  bleed-through. Don't "fix" it.
- **`product_images` may be JSONB *or* a JSON-encoded TEXT string.** Handle both.
- **Statics ≠ Brief Pipeline on ClickUp.** No ClickUp push here. Don't port it.
- **Worktree lanes** (`CLAUDE.md` §5): statics and briefPipeline are both **Creative** lane.
- **Prod DB is not directly reachable** from a local session (IP allowlist; the Render query
  tool fails with `SSL/TLS required`, and it's read-only anyway). Data fixes go through
  **migrations** or the app's API — this shapes how you do steps 3 and 6.
- **Iterations must vary too.** If only `/generate` learns to pick a shot, iterations will
  quietly collapse back to image #1 and the "everything looks the same" bug survives.

---

## 8. Quick reference

| Thing | Value |
|---|---|
| Puure product id / code | **37** / `PUURE` |
| MinerForge product id | **3** |
| Puure master_brief | **24,451 chars** (present, unused by statics) |
| Puure angles / avatars | **7 / 4** |
| Puure product_images | **0** ← blocker |
| MinerForge product_images | **5** (only #1 ever used) |
| Prod app | `https://mineblock-dashboard.onrender.com` |
| Render service | `srv-d6qavvf5gffc73em69n0` (auto-deploys from `main`) |
| Admin login | `SUPERADMIN_EMAIL` / `SUPERADMIN_PASSWORD` in `.env` |
| Products API | `GET /api/v1/product-profiles`, `GET /api/v1/product-profiles/:id` |
