# Lane handoff — W8f, the hub user stranded on migration 126's map is repaired, once

Branch `day2/w8f-jit-remap` off `hub/main` `3a10be7`. Worktree `/Users/ludo/wt-w8f-dash`.
Proof pack (verbatim red/green output): `~/tasks/multistore-hub/briefs/out/PROOF-W8F.md`.
Raw logs: `briefs/out/w8f-logs/`.
Databases `dash_w8f_test`, `w8f_remap`, `w8f_sso`, `w8f_migr`, `dash_w8f_mbclone` on `127.0.0.1:5433`,
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
   re-map. It **imports** the predicate from the route rather than restating it.

## THE RULE, AND WHY EACH SIGNAL IS SOUND

All three must hold. The full justification is in `PROOF-W8F.md` §1 and in migration 135's header.

| | signal | why it is sound |
|---|---|---|
| **(a)** | `users.created_via = 'hub_sso'` | Nothing marked these rows before this lane: the only marker was an `HUB_SSO_JIT_CREATE` audit row. `audit_logs` is a **log** — swept, exported, truncated, `user_id ON DELETE SET NULL` — so a privilege decision must not rest on it. 135 moves provenance onto the user row and backfills it off that audit row **once**. The backfill reads `HUB_SSO_JIT_CREATE` and not `LIKE 'HUB\_SSO\_%'`: a `HUB_SSO_LOGIN` row proves a hop, not a creation. |
| **(b)** | exactly one role, named `Admin` | 126's seeded value. `Admin` **plus** anything else is a store decision and is left alone. Deliberately **not** `Manager` (126's other stranded target): the defect measured is the OWNER. |
| **(c)** | `invited_at`/`invited_by` NULL · `must_change_password = false` · no reset token · `updated_at <= created_at` · `last_login <= max(HUB_SSO_LOGIN)` | `must_change_password` is the **SuperAdmin guard** and it is independent of (b): both creators of a store's first admin (`server.js:77`, `seeds/seed_superadmin.js`) set it TRUE. `updated_at <= created_at` is the decisive one — `users` has **no** `updated_at` trigger on this schema, every local password path names the column, and the hub's own hop deliberately does not. `last_login` catches a login this store served itself. |

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

- `server/tests/hub-sso/w8f-jit-remap.mjs` (new, 36 assertions, real router, real migrations off
  disk, fresh Postgres): **RED 26/10 → GREEN 36/0**. Negative controls, each untouched: Admin plus
  another role · a row written since creation · a local login after the last hop · the store's own
  SuperAdmin · a SuperAdmin-shaped row · a locally created user whose only role is Admin · an invited
  user · a second hop after the upgrade.
- `server/tests/hub-sso/w8-jit-role.mjs` — **37/0**, unchanged behaviour. Its only edit is
  `135_users_created_via.sql` in its fixture's migration list.
- `node server/tests/run-all.mjs` — **127 passed, 0 failed, 0 timed out, 8 skipped** in 919.6 s, exit 0 (W8c's 126 plus this lane's new script, no other script moved).
- The migration runner on an empty database, twice: `Successfully ran 119 migration(s)` /
  `applied: 119 | pending: 0 | mismatches: 0`, and `All migrations are up to date` on the second run.
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
