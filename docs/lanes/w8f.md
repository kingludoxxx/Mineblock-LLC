# Lane handoff — W8f (+ W8g), the hub user stranded on migration 126's map is repaired, once

> **W8g closed REVIEW-W8F (BLOCK) on this branch.** The word ONCE in this document was, as W8f first
> shipped it, false: nothing recorded that the repair had run, so every later hop re-forced the
> mapped role over the store's own decision — measured four rounds, four `HUB_SSO_ROLE_UPGRADED`
> rows, always toward more privilege. **What makes ONCE true is the latch:** the repair stamps
> `users.created_via = 'hub_sso_repaired'` on the row it repairs, in the same transaction, one
> statement before it moves the role, and the predicate matches only `'hub_sso'`. A repaired user is
> never a candidate again — not after a demotion, not after the map is re-pointed, not after a
> hundred hops. Read every "once" below as "once, because of the latch". W8g also takes the user row
> `FOR UPDATE` before deciding (concurrent hops used to double-write and could leave two roles), and
> refuses to spend a user's one repair on a ticket whose hub role the map does not name.
> Proof: `PROOF-W8F.md` § **W8g**.

Branch `day2/w8f-jit-remap` off `hub/main` `3a10be7`. Worktree `/Users/ludo/wt-w8f-dash`.
Proof pack (verbatim red/green output): `~/tasks/multistore-hub/briefs/out/PROOF-W8F.md`.
Raw logs: `briefs/out/w8f-logs/`; W8g's logs and its two drivers: `briefs/out/w8g-logs/`.
Databases `dash_w8f_test`, `w8f_remap`, `w8f_sso`, `w8f_migr`, `dash_w8f_mbclone` (W8f) and
`dash_w8g_test`, `w8g_remap`, `w8g_remap2`, `w8g_remap3`, `w8g_sso`, `w8g_migr`, `w8g_migr_old`,
`w8g_probe`, `w8g_race`, `dash_w8g_mbclone`, `w8g_s4_brain_*` (W8g), all on `127.0.0.1:5433`,
all mine, all dropped at the end (R43). `mineblock_copy` was only ever read as a `TEMPLATE`.
Nothing pushed, nothing deployed, no live service and no live database touched.

---

## The defect, measured

Migration 126 seeded `hub_role_map` with `owner -> 'Admin'`. `'Admin'` administers the **users table**
and carries none of the page keys migration 031 seeds, so a hub owner lands on an empty sidebar and a
locked KPI card. 133/134 fixed the **map**; by W8b's deliberate design they never re-role an
**existing** user. Every store that had a hop before 2026-09-11 (MB, SB, TW) therefore still carries
a hub user stranded on `Admin`. Measured live 2026-09-11 14:41Z on the MB and SB databases: the user
holds exactly `["Admin"]`, `hub_role_map` is correct, `Hub Owner` exists with the `kpi-system` key and
zero holders.

Red, on this tree before the lane:

```
PASS  R1: and it strands the hub owner on exactly ["Admin"]
FAIL  R3: the stranded user now holds exactly ["Hub Owner"]      got ["Admin"]
FAIL  R4: exactly ONE HUB_SSO_ROLE_UPGRADED row                  n=0
```

## What changed

1. **`server/migrations/135_users_created_via.sql`** (new, additive, idempotent, runs on an empty
   database) — `users.created_via TEXT`, NULL default, plus a **guarded backfill** for rows that carry
   an `HUB_SSO_JIT_CREATE` audit row **and** show no local login, plus a partial index. It changes no
   role, no permission and no user's access: it records where a row came from. `order.json` += one
   entry at the end (**119**), `_doc`'s "next free HUB number" moved 135 → 136.

2. **`server/src/routes/hubSso.js`** — the JIT `INSERT` stamps `created_via = 'hub_sso'`.
   `upgradeStrandedHubUser()` moves a stranded user onto the role the **current** map gives their
   ticket's hub role and writes `HUB_SSO_ROLE_UPGRADED` with the old and the new roles. W8b's
   `HUB_SSO_ROLE_UNCHANGED` is now the branch taken when the repair does **not** apply, which is
   everything outside (a)+(b)+(c).

3. **`scripts/w8f-remap-census.mjs`** (new, read-only) — prints the users a given database would
   re-map. It **imports** the predicate from the route rather than restating it. **W8g: the DSN comes
   from `DATABASE_URL`, never from `argv`** (R20 — argv is visible in `ps` and lands in shell history);
   a DSN passed as an argument is now refused rather than accepted quietly. It also prints the count
   of rows whose repair has already been spent.

4. **W8g — `server/src/routes/hubSso.js`, closing REVIEW-W8F:**
   - **the latch (P0-1)** — `UPDATE users SET created_via = 'hub_sso_repaired' WHERE id = $1 AND
     created_via = 'hub_sso'`, inside the repair's own transaction, one statement **before** the role
     move, and a compare-and-set: `rowCount !== 1` means somebody else repaired this row, and the
     repair abandons without writing roles.
   - **the row lock (P1-1)** — `SELECT id FROM users WHERE id = $1 FOR UPDATE` for **every** existing
     user, before the predicate and before `loadRoles`, so concurrent hops serialise instead of both
     passing a stale snapshot. The exchange's own `UPDATE users SET … last_login = NOW()` locks the
     same row later, so this only moves an acquisition that was already going to happen, in the same
     order for both hops: no new deadlock, measured over 40 concurrent races.
   - **an unknown hub role no longer burns the repair (P2-3)** — `mappedRoleName` became
     `mappedRole`, which reports whether the map named this hub role **itself** or the `*` fallback
     answered. The JIT path is unchanged (a new user on an unknown role still lands on the `*` role);
     the repair requires an exact hit. **Chosen: leave the user untouched, rather than re-map without
     latching.** Not latching would not have helped — the user would have been moved onto `Viewer`,
     and (b) demands exactly `Admin`, so their repair would have been spent all the same. Untouched is
     the only option that actually preserves it, and it is visible: the hop writes
     `HUB_SSO_ROLE_UNCHANGED` and logs `hub_sso_remap_skipped_unknown_hub_role`.
   - **(d) in the predicate (P2-1)** — see the table above.

## THE RULE, AND WHY EACH SIGNAL IS SOUND

All three must hold. The full justification is in `PROOF-W8F.md` §1 and in migration 135's header.

| | signal | why it is sound |
|---|---|---|
| **(a)** | `users.created_via = 'hub_sso'` — hub-created **and not yet repaired** (W8g: the repair stamps `'hub_sso_repaired'`, which this equality does not match; that is the whole mechanism behind ONCE) | Nothing marked these rows before this lane: the only marker was an `HUB_SSO_JIT_CREATE` audit row. `audit_logs` is a **log** — swept, exported, truncated, `user_id ON DELETE SET NULL` — so a privilege decision must not rest on it. 135 moves provenance onto the user row and backfills it off that audit row **once**. The backfill reads `HUB_SSO_JIT_CREATE` and not `LIKE 'HUB\_SSO\_%'`: a `HUB_SSO_LOGIN` row proves a hop, not a creation. |
| **(b)** | exactly one role, named `Admin` | 126's seeded value. `Admin` **plus** anything else is a store decision and is left alone. Deliberately **not** `Manager` (126's other stranded target): the defect measured is the OWNER. |
| **(c)** | `invited_at`/`invited_by` NULL · `must_change_password = false` · no reset token · `updated_at <= created_at` · `last_login <= max(HUB_SSO_LOGIN)` | `must_change_password` is the **SuperAdmin guard** and it is independent of (b): both creators of a store's first admin (`server.js:77`, `seeds/seed_superadmin.js`) set it TRUE. `updated_at <= created_at` is the decisive one — `users` has **no** `updated_at` trigger on this schema, every local password path names the column, and the hub's own hop deliberately does not. `last_login` catches a login this store served itself. |
| **(d)** | `is_active = true` · `locked_until` NULL or past | W8g (REVIEW-W8F P2-1). The exchange already refuses a deactivated user 401 and a locked one 423 **before** the repair is reached, but the shared predicate did not know it, so `w8f-remap-census.mjs` listed users the exchange would turn away. The rule and the door now agree; `D1` in the suite asserts both halves, and that an EXPIRED lock makes the user a candidate again. |

## WHAT `hub_role_map` CAN AND CANNOT DO AFTER THIS LANE (REVIEW-W8F P1-2)

`hub_role_map` is a data table, and migrations 133/134 print an `UPDATE hub_role_map …` line in their
headers, so operators are actively invited to edit it by hand. Exactly three things it decides, and
nothing else:

1. **It decides what a NEW user gets.** Unchanged since W8b. Measured control, `X1`: with the map
   re-pointed `owner -> SuperAdmin`, a brand-new JIT user is created as `SuperAdmin`.
2. **It decides the ONE repair of a stranded legacy user** — a user the hub itself created, still
   holding exactly migration 126's `Admin`, who has never become a local account. Measured, `M0`:
   with the map re-pointed `owner -> SuperAdmin`, a stranded user is moved to `SuperAdmin`, **once**;
   the second hop changes nothing, because the row is latched. This is the widest thing the map can
   do to an existing account, it is inside the store's own database trust boundary, and it is
   auditable (`HUB_SSO_ROLE_UPGRADED` carries the old roles, the new role, the hub role and the store
   code).
3. **Nothing else. It is not a lever on a repaired user, and never was one on any other user.**
   Measured, `X1` and — the sharp one — `X2`: repair a user, let the store DEMOTE them back to
   `Admin` through its own endpoint, then re-point the map at `SuperAdmin` and hop. On the reviewed
   route that ended at `roles=["SuperAdmin"]` with two upgrade rows: one row edited in a data table
   plus one hop, and an existing account held the store's most privileged role. With the latch it
   ends at `roles=["Admin"]`, one upgrade row, ever. Every other existing user —
   locally created, invited, SuperAdmin, holding `Admin` plus anything, written since creation, with
   a local login, deactivated, locked — was never reachable by the map and still is not (`N1`–`N6`,
   `D1`).

So the hub cannot raise or lower a store's people by editing a map, with the single, once-per-user,
audited exception of undoing migration 126's bug. **A store that wants even that off has the same
answer it always had: touch the user row (the repair needs `updated_at <= created_at`), or run
`UPDATE users SET created_via = 'hub_sso_repaired'` and the exchange will never re-role them.**

**ORDER IS LOAD-BEARING.** The predicate is evaluated **before** this request's
`UPDATE users SET … last_login = NOW()`. After it, (c) would read the request's own footprint and
refuse everyone. `w8f-jit-remap.mjs` `R3` bites if that moves.

## THE POSTGRES TRAP

A failed statement inside a transaction aborts the whole transaction, and the later `COMMIT` silently
behaves as a `ROLLBACK`. The optional audit insert is therefore wrapped in
`SAVEPOINT` / `ROLLBACK TO SAVEPOINT`. Both halves were run down:

- `T0` executes the trap on a throwaway table and re-reads after the commit (`v = 'before'`, pg
  reports `command = 'ROLLBACK'`).
- `T1` RED, with the savepoint removed from the real route and a `CHECK` constraint refusing the
  upgrade row: `status=500`, `roles=["Admin"]`,
  `error: current transaction is aborted, commands ignored until end of transaction block`.
  GREEN with the savepoint: the hop is a 302, the re-map is there on a **re-read from a brand-new
  connection after the commit**, and the failure is loud
  (`logger.error('hub_sso_role_upgrade_not_audited')`).

## Proof

- `server/tests/hub-sso/w8f-jit-remap.mjs` (new, **64** assertions after W8g, real router, real
  migrations off disk, fresh Postgres): **RED 26/10 → GREEN 36/0** (W8f), then **RED 52/12 → GREEN
  64/0** (W8g, the RED taken by restoring `d2ce0017`'s route under the new suite). Negative controls,
  each untouched: Admin plus another role · a row written since creation · a local login after the
  last hop · the store's own SuperAdmin · a SuperAdmin-shaped row · a locally created user whose only
  role is Admin · an invited user · a second hop after the upgrade · **a deactivated user · a locked
  user · a user whose repair has been spent · a ticket on an unknown hub role**.
- **W8g's drivers** (`briefs/out/w8g-logs/`, deliberately outside `server/tests/` so the suite's
  script count cannot move): `w8g-latch.mjs` **RED 5/8 → GREEN 14/0** — four rounds with the store
  resetting the role through `teamController.changeTeamMemberRole` itself: RED `upgradeRows=4` and
  the store overridden every time, GREEN `upgradeRows=1` and rounds 2-4 leaving the store's choice
  alone. `w8g-race.mjs` **RED 1/4 → GREEN 5/0** — 20 races of each kind: RED 20/20 same-role races
  double-wrote and 20/20 different-role races left the user holding `["Hub Owner","Viewer"]`; GREEN
  20/20 and 20/20 clean, and 50/50 + 50/50 on a re-run at 200 hops, no deadlock, no 500.
- `server/tests/hub-sso/w8-jit-role.mjs` — **37/0**, unchanged behaviour. Its only edit is
  `135_users_created_via.sql` in its fixture's migration list.
- `node server/tests/run-all.mjs` — **127 passed, 0 failed, 0 timed out, 8 skipped** in 919.6 s, exit 0 (W8c's 126 plus this lane's new script, no other script moved).
  **Re-run on W8g's tree, twice: `127 passed, 0 failed, 0 timed out, 8 skipped` in `849.9s` and then
  in `863.4s` on the exact committed tree**, exit 0 both times — the same script count, because W8g's
  two drivers live outside `server/tests/` on purpose.
- The migration runner on an empty database, twice: `Successfully ran 119 migration(s)` /
  `applied: 119 | pending: 0 | mismatches: 0`, and `All migrations are up to date` on the second run.
- ⚠️ **W8g edited migration 135's header, so its checksum moved.** Measured, on a database that had
  already applied W8f's 135: the runner **refuses**, names the file, and exits **1**
  (`REFUSING to run: 1 already-applied migration file(s) changed on disk`). That is safe for the
  fleet only because **135 has never been applied outside throwaway test databases** — the branch is
  unmerged and nothing was ever pushed or deployed. Anyone holding a local dashboard database that
  ran W8f's 135 must drop its ledger row for 135 and let it re-apply, or recreate the database.
  Full output: `PROOF-W8F.md` § W8g-7.
- The A6 scope guard SKIPs off the store-code lane, as W6c's lead decision says it does
  (`branch day2/w8f-jit-remap does not match /store-code/`); its second test ran and passed.

## The clone census

`CREATE DATABASE dash_w8f_mbclone TEMPLATE mineblock_copy`, migrated (`Successfully ran 15
migration(s)` → `applied: 119`), then `node scripts/w8f-remap-census.mjs …`:

- **As it stands: 0 of 17.** `mineblock_copy` **predates the hub SSO deploy** — no `hub_role_map`
  table, zero `HUB_SSO_%` audit rows, no `info@trypuure.co` row. The hub-created user the brief
  expects is not on this snapshot. All 17 real users are listed untouched, the store's own
  `admin@try-mineblock.com` (SuperAdmin) among them.
- **With the 2026-09-10 row reconstructed on it exactly as the exchange wrote it: exactly 1 —
  `info@trypuure.co`**, and none of the 17.

The clone was dropped afterwards.

## Still open / for the next lane

- **`Manager`.** 126 also stranded `operator` and `editor` on `'Manager'`, which is equally
  page-less. This lane repairs only the `Admin` case it measured. A lane that measures a stranded
  operator can widen `LEGACY_126_DEFAULT_ROLE` to a set; the predicate is already one exported
  constant plus one exported SQL string.
- **The residual in (c4).** `updated_at <= created_at` also refuses a hub row an admin merely edited
  in the UI. That direction is fail-closed: the cost is a stranded user who still needs a manual fix,
  never a user who is wrongly elevated.
- Everything W8b/W8c left open (the "REPORTED, NOT FIXED" table in `docs/lanes/w8.md`, the 375 px
  shell overflow, `A6_ENFORCE=1` on the integration branch) is unchanged by this lane.
- Nothing here is deployed. On a live store the repair only fires **after** migration 135 has run
  there, and until then the exchange behaves exactly as it did before W8f (proved: `M1`).
- **W8g left three REVIEW-W8F P2s open, deliberately** (full reasoning in `PROOF-W8F.md` § W8g-6):
  - **P2-4**, (b) reads the role NAME, never its permissions — a store that widened `Admin` itself
    still has its hub user moved off it, once. Comparing permission SETS is a new comparison with its
    own semantics and a new failure mode per store; well past "a few lines", and it changes what the
    repair means.
  - **P2-5**, a missing `hub_role_map` is a 500 whose Postgres message reaches the browser.
    Pre-existing (W8b's) and not in this lane's diff: the cause is
    `server/src/middleware/errorHandler.js` putting `err.message` in the body for **every** route in
    the product. Product-wide change, own lane, own review.
  - **P2-7**, (a) is the only separator for a never-logged-in locally created row. Accurate and
    unchanged; it needs direct database write access, which is already game over. W8g does bound it:
    even a forged row now gets exactly one re-map, not an unlimited supply.
- **The repair does not survive a restore from a pre-repair dump** — decided, not accidental
  (`PROOF-W8F.md` § W8g-9.3). A restored row carries `'hub_sso'` again and gets its one repair again.
