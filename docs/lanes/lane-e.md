# Lane handoff — Lane E (S1-4 hub identity + SSO hop), dashboard side   last session 2026-09-10   branch `day1/lane-sso` (from hub/main edc1030)   commit (see `git log -1`)

## Where I stopped (exact step, file:line)
Slice complete and green: `node server/tests/hub-sso/hub-sso.mjs` 75/75; `HUB_REPO_DIR=~/store-hub node server/tests/hub-sso/e2e-hub.mjs` 19/19 (SKIP, exit 0, without `HUB_REPO_DIR`). Committed on `day1/lane-sso`, not pushed, not deployed, flag off. Nothing else on this branch. Hub side: `/Users/ludo/store-hub` `main` (see its `docs/lanes/lane-e.md`).

## What was built
- `server/src/routes/hubSso.js` (new): `POST /api/v1/hub-sso/exchange` (JSON or form body: `ticket`, `next`). `process.env.HUB_SSO_ENABLED !== '1'` → 404, nothing read. Then: `HUB_SSO_SECRET` / `STORE_CODE` unset → 503 naming the key; `next` not a relative path → 400 (before any write); ticket shape → 400; HMAC-SHA256 over the exact payload bytes, `timingSafeEqual` → 401; payload fields → 400; `store_code !== STORE_CODE` → 401; `exp` with 30 s skew → 401; `exp` more than 120 s ahead → 401; nonce burned in `hub_sso_used_tickets` (`ON CONFLICT DO NOTHING`, rowCount 0 → 401 replay) inside ONE transaction with the JIT user, its role, and the two `audit_logs` rows (`HUB_SSO_JIT_CREATE`, `HUB_SSO_LOGIN`); existing user never re-roled; inactive → 401; then the dashboard's own session and `302 next`. Behind `authRateLimiter` (25 failed / 15 min / IP), like `/auth/login`. No outbound call anywhere.
- `server/src/services/hubSession.js` (new): `issueSession(res, user, {ip, userAgent, roles})` mirroring `authController.js` lines 37-45 / 47-55 (cookies), 213-225 (roles), 228-238 (tokens), 243 (`createSession`), 246-254 (userData). The Redis cache write (255-256) is not mirrored: `middleware/auth.js:99-145` re-verifies on a miss, so the outcome is identical. `authController.js` is untouched.
- `server/migrations/124_hub_sso.sql` (new, idempotent, additive): `hub_sso_used_tickets(nonce PK, exp, used_at)` + `hub_role_map(hub_role PK, dashboard_role)` seeded `viewer→Viewer, editor→Manager, admin→Admin, operator→Manager, owner→Admin, *→Viewer`.
- `server/src/routes/index.js`: one import + one mount line (`/api/v1/hub-sso`), announced in COORDINATION's shared-file section by the HUB lead.
- `.env.example`: `HUB_SSO_ENABLED=0`, `HUB_SSO_SECRET=`, `STORE_CODE=` (names only).
- `server/tests/hub-sso/hub-sso.mjs`, `e2e-hub.mjs` (new). Harness runs the real auth migrations verbatim off disk, seeds roles through `seeds/seed_roles.js`, mounts the real `/api/v1/auth` next to the new router (real `authenticate`, real `/auth/refresh`).

## Migration number and where it goes in order.json
Lane A's `order.json` (wt-lane-migrations) ends at `099_static_ad_naming.sql` and holds `120`, `121_creative_analysis_route_columns.sql` before `017`. Lane C (order.lane-c.json) uses `121_store_code_tagging.sql`, `122_store_code_lazy_tables.sql` and stages `123_clickup_brief_resolutions_rekey.sql`. So this lane takes **124**. Insertion: **append `"124_hub_sso.sql"` at the END of `"order"`**, after Lane C's `121`/`122` (and `123` if it lands), i.e. the last entry. It depends only on `roles` (001) by name at request time, `users`/`user_roles`/`sessions`/`audit_logs` at exchange time, so any position after `015` also works; the end is the R6-safe choice. The legacy `run.js` (filename sort) runs it after `099` and `122`, same effect. Neither worktree was edited.

## Env keys a dashboard needs
`HUB_SSO_ENABLED` exactly `'1'` (anything else = 404; unset in every template by default, R7), `HUB_SSO_SECRET` (the store's own value, set by the hub owner at `PUT /hub/stores/:code/secrets/HUB_SSO_SECRET`; the provisioner later copies it into the service env), `STORE_CODE` (the store's manifest code; Lane C already uses the same name for tagging).

## What is proven (proof pack link) and what is not
Proof: `~/tasks/multistore-hub/briefs/out/PROOF-LANE-E.md`. Proven by execution: A1–A9 as listed at the top of `hub-sso.mjs`, the parallel replay (4 → exactly one 302), the used-ticket TTL sweep, form-encoded body, the rate limiter on the new route (26th failure → 429), and the cross-repo hop with the real hub (e2e E1–E8, incl. a ticket for another store under the same secret refused, and the dashboard's own login answering after the hub server is closed).
NOT proven: the browser flow end-to-end (no UI exists yet on the hub; the 302 + `SameSite=strict` cookies on a cross-site POST navigation is reasoned from the spec, not observed in Chrome/WebKit; R12 applies when the UI lands). Not run on the full `app.js` (helmet/cors/morgan) — the router is mounted after the global parsers exactly as in `routes/index.js`, and needs nothing from `app.js`. Nothing live.

## Open questions for the lead (not for Ludo)
1. After the 302 the SPA has no `localStorage.accessToken`; `AuthContext.jsx:87-88` falls back to `POST /auth/refresh` with the `refreshToken` cookie (Path=/api/v1/auth, same-site from the SPA) — proven server-side in H1. If the lead wants the token in localStorage immediately, the landing page can read it from `/auth/refresh`; nothing in this slice changes the client.
2. `hub_role_map` is data (a store may re-map without a deploy). The `*` fallback is `Viewer`, the least-privileged seeded role. If a store deletes the `Viewer` role, JIT creation refuses (403, transaction rolled back) rather than creating a role-less user. OK?
3. JIT users get a random bcrypt-hashed password (never empty), `must_change_password=false`, `email_verified=true`. They can set a password through the existing forgot-password flow. Confirm the verified flag.
4. Two `hub_*` warnings are logged per refusal class (`hub_sso_bad_signature`, `hub_sso_wrong_store`, ...) with no payload; `hub_sso_ok` logs the user id only. Matches the CRM's `sso.py`.

## Next action for the next session (one line)
Lead merges `day1/lane-sso` into the landing worktree, adds `124_hub_sso.sql` at the end of Lane A's `order.json`, and keeps `HUB_SSO_ENABLED` unset on every live service until the hub UI + a sandbox browser run (R12) exist.
