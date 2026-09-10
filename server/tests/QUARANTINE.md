# QUARANTINE — scripts `npm test` skips, and why

The runner (`server/tests/run-all.mjs`) reads this file. Every line of the form

```
- `relative/path.mjs` — reason
```

is skipped with a visible `SKIP` and its reason. Paths are relative to
`server/tests/`. A quarantine entry that points at a script that no longer
exists makes the runner **exit 2** — a stale entry is a maintenance bug, not a
free pass.

Quarantine is a debt register, not a bin. Every entry below names the condition
that would let it come back.

---

## Q1 — imports source from an absolute path OUTSIDE this repository (37)

These scripts do not test this checkout. They `import` production source and
`node_modules` from other clones on one particular Mac
(`/Users/ludo/Mineblock-LLC/...`, `/Users/ludo/Puure-integrator/...`,
`/Users/ludo/funnel-os/...`). Consequences:

* they can never run on a CI runner, where those paths do not exist;
* when they pass locally they prove something about *another working copy*, so a
  regression committed here can leave them green;
* the lane brief preamble (`~/tasks/multistore-hub/briefs/COMMON.md`) forbids this lane from reading those
  directories at all.

**Comes back when:** the absolute import is replaced by a relative one
(`../../src/...`) and the script is re-run green. That is a one-line change per
file, but it is an edit to files this lane does not own — it needs its own slice.

- `abandoned/route.mjs` — imports from /Users/ludo/Mineblock-LLC (outside the repo)
- `ai-generate/route-stream.mjs` — imports from /Users/ludo/Mineblock-LLC (outside the repo)
- `builder-metrics/metrics-ui.mjs` — imports from /Users/ludo/Mineblock-LLC (outside the repo)
- `builder/variant-search.mjs` — imports from /Users/ludo/Mineblock-LLC (outside the repo)
- `clone-page/scan-create.mjs` — imports from /Users/ludo/Mineblock-LLC (outside the repo)
- `clone-page/shopify-import.mjs` — imports from /Users/ludo/Mineblock-LLC (outside the repo)
- `costs/assistant-migrate.mjs` — imports from /Users/ludo/Mineblock-LLC (outside the repo)
- `costs/assistant.mjs` — imports from /Users/ludo/Mineblock-LLC (outside the repo)
- `funnel-settings/commerce.mjs` — imports from /Users/ludo/Mineblock-LLC (outside the repo)
- `funnel-settings/domains-tab.mjs` — imports from /Users/ludo/Mineblock-LLC (outside the repo)
- `funnel-settings/patch-settings.mjs` — imports from /Users/ludo/Mineblock-LLC (outside the repo)
- `funnel-settings/themes.mjs` — imports from /Users/ludo/Mineblock-LLC (outside the repo)
- `funnel-settings/tracking-tab.mjs` — imports from /Users/ludo/Mineblock-LLC (outside the repo)
- `funnels/page-thumbnails.mjs` — imports from /Users/ludo/Mineblock-LLC (outside the repo)
- `integrations/klaviyo.mjs` — imports from /Users/ludo/Mineblock-LLC (outside the repo)
- `live-view/gen-centroids.mjs` — imports from /Users/ludo/funnel-os (outside the repo)
- `live-view/gen-land.mjs` — imports from /Users/ludo/funnel-os (outside the repo)
- `money-path/order-bump.mjs` — imports from /Users/ludo/Puure-integrator (outside the repo)
- `money-path/review-regression.mjs` — imports from /Users/ludo/Mineblock-LLC (outside the repo)
- `money-path/seam-fixes.mjs` — imports from /Users/ludo/Puure-integrator (outside the repo)
- `money-path/session-auth.mjs` — imports from /Users/ludo/Puure-integrator (outside the repo)
- `money-path/shopify-order-create.mjs` — imports from /Users/ludo/Mineblock-LLC (outside the repo)
- `money-path/shopify-refund-reflect.mjs` — imports from /Users/ludo/Mineblock-LLC (outside the repo)
- `money-path/split-arm-page-guard.mjs` — imports from /Users/ludo/Mineblock-LLC (outside the repo)
- `money-path/split-delivery.mjs` — imports from /Users/ludo/Mineblock-LLC (outside the repo)
- `money-path/tracking-wiring.mjs` — imports from /Users/ludo/Puure-integrator (outside the repo)
- `money-path/upsell-page.mjs` — imports from /Users/ludo/Mineblock-LLC (outside the repo)
- `orders/dunning.mjs` — imports from /Users/ludo/Mineblock-LLC (outside the repo)
- `orders/order-edit.mjs` — imports from /Users/ludo/Mineblock-LLC (outside the repo)
- `orders/orders-extras.mjs` — imports from /Users/ludo/Mineblock-LLC (outside the repo)
- `page-types/page-types.mjs` — imports from /Users/ludo/Mineblock-LLC (outside the repo)
- `tracking/admin-crud.mjs` — imports from /Users/ludo/Mineblock-LLC (outside the repo)
- `tracking/delivery-patches.mjs` — imports from /Users/ludo/Mineblock-LLC (outside the repo)
- `tracking/device-geo.mjs` — imports from /Users/ludo/Mineblock-LLC (outside the repo)
- `tracking/extras-e2e.mjs` — imports from /Users/ludo/Mineblock-LLC (outside the repo)
- `tracking/google-adapter.mjs` — imports from /Users/ludo/Mineblock-LLC (outside the repo)
- `tracking/s2s-integrations-e2e.mjs` — imports from /Users/ludo/Mineblock-LLC (outside the repo)

## Q2 — needs credentials and a live login (1)

- `brief-pipeline/golden.mjs` — refuses to start without `EMAIL`/`PASSWORD` (or `PUURE_EMAIL`/`PUURE_PASSWORD`): it logs in to a running dashboard. Comes back when it is split into a pure golden-fixture comparison plus a separately-gated live probe.

## Q3 — not a test (1)

- `brief-pipeline/golden.fixtures.mjs` — a fixture module imported by `golden.mjs`. It exits 0 without asserting anything, so running it reports a green that means nothing. Comes back if it ever grows assertions; the durable fix is to move fixtures out of the `*.mjs` discovery glob.

## Q4 — a real, pre-existing failing assertion on `origin/main` (1)

- `orders/post-purchase-ui.mjs` — `FAIL U8 the dunning page is in the sidebar under orders:access` (32 passed, 1 failed). Reproduced on a clean `edc1030` checkout, so it is not caused by this lane. The assertion is about the client sidebar, under `client/`, which Lane B may not touch. Comes back the moment U8 is fixed — this entry is the only thing keeping `npm test` from being red on arrival.

---

## Not quarantined, but you need to know

* **The suite needs scratch databases nobody creates.** 22 scripts share a
  `puure_shoporder` database and `split/statistics.mjs` needs `puure_split`;
  none of them creates it, so on a clean machine they die with
  `database "..." does not exist`. The runner now provisions every role and
  database named by a DSN inside the scripts it is about to run (local clusters
  only) — see `preflight()` in `run-all.mjs`.
* **58 scripts hardcode `postgres://puure@127.0.0.1:5433/<db>`** instead of
  reading the environment. `PGURL` is exported to every child process and is
  what the preflight provisions against, but the scripts themselves still ignore
  it. Making them read `PGURL` is a follow-up slice.
* **The client toolchain is a hard dependency of four scripts**
  (`ai-media/dialog-dom.mjs`, `live-view/run-*.mjs`): they need
  `client/node_modules` (vite/rollup), and `dialog-dom.mjs` additionally needs a
  Playwright Chromium. CI installs both. Locally, `cd client && npm ci` first.
* **Gaps the smoke suite could not fill.** The brief asked smoke to cover
  *orders list* and *product-profile CRUD*. All four `orders/*` scripts are
  quarantined (three by Q1, one by Q4), and there is **no test anywhere in the
  repo for product profiles** even though `server/src/routes/productProfiles.js`
  exists. Smoke substitutes the nearest real coverage and the gap stands.
