# Runbook — Day-2 Operations

Practical procedures for the buyer to run the dashboard.

---

## Deploy a code change

1. Push to `main` on GitHub
2. Render auto-deploys (configured in service settings)
3. Watch the deploy log in Render dashboard → Service → Events
4. Verify: hit `/api/health` — should return `{"ok": true}`

If a deploy fails:
- Check build log for the specific error
- Common: missing env var → set it in Render → Service → Environment → save (triggers redeploy)
- Rollback: Render → Deploys → previous good deploy → Redeploy

---

## Fresh deploy on your Render account (from handover)

```bash
# 1. On your machine — clone the repo (after GitHub transfer)
git clone git@github.com:YOUR_ORG/Mineblock-LLC.git
cd Mineblock-LLC

# 2. In Render dashboard:
#    New → Web Service → connect the repo
#    Region: virginia (or your preferred, but match your DB)
#    Runtime: Node
#    Build: npm install && cd client && npm install && npm run build && cd .. && node scripts/setup-ytdlp.js
#    Start: node server/src/server.js
#    Plan: starter or higher

# 3. Create Postgres in Render
#    Plan: basic_256mb minimum (upgrade based on data size)
#    Region: same as web service

# 4. Import DB dump from seller
#    On your machine:
psql "postgres://user:pass@yourdb.render.com/dbname?sslmode=require" < mineblock-db-dump.sql

# 5. Set env vars in Render → Service → Environment (see ENV-VARS.md)

# 6. Deploy (Render auto-deploys on env var save)
```

---

## Add a new product to the pipeline

The product library is managed via the dashboard UI:

1. Log in as superadmin
2. Navigate to **Production → Products** (or wherever your permission grants)
3. Click **New Product Profile**
4. Fill: name, short_name (2-4 char code), product_code (e.g. `MR`), category,
   image, avatar, angles, offers
5. Save → available immediately in brief pipeline / statics generator

Products carry a `product_id` FK that all downstream tables reference — never
delete a product that has active creatives; archive instead.

---

## Launch a static ad

Requires: template, copy set, creative(s) approved, Meta ad account connected.

1. **Statics Generation** → filter by product → select 6-18 creatives
2. Click **Launch selected**
3. Choose launch template (defines campaign, ad set, targeting)
4. Choose copy set (primary text, headline, description, CTA)
5. Preview → **Launch**

Backend flow:
- Groups creatives by `angle` (fix in commit `1e62a6a`)
- Creates one Meta ad set per angle
- Uploads images to Meta via `/adimages` endpoint
- Creates one `link_data` creative per creative row (4:5 preferred ratio)
- Creates one ad per creative in its angle's ad set

Ad delivery: campaign starts PAUSED — toggle ON in Meta Ads Manager to spend.

---

## Reset a batch (undo a bad launch)

```bash
# CRON_SECRET-gated endpoint — resets 'launched' rows in a time window
curl -X POST "https://YOUR-DOMAIN/api/v1/statics-generation/reset-launched?within_hours=12" \
  -H "x-cron-secret: YOUR_CRON_SECRET"

# Response: { success: true, reset_count: N, creatives: [...] }
```

Also clears `meta_ad_ids` and deletes matching `statics_launches` log rows.

If you deleted the Meta ad sets in error, the Meta side is manually cleaned in
Ads Manager; the DB reset is idempotent and just re-opens the creatives for
another launch attempt.

---

## Invite a new user

Two paths:

**Via UI** (recommended):
1. Log in as admin
2. **Settings → Team → Invite Member**
3. Fill email, role
4. User receives magic link, sets password, gets access

**Via SQL** (emergency):
```sql
INSERT INTO users (id, email, first_name, last_name, is_active, email_verified, password_hash)
VALUES (gen_random_uuid(), 'user@example.com', 'First', 'Last', true, true, '<bcrypt_hash>');

-- assign a role
INSERT INTO user_roles (user_id, role_id)
SELECT u.id, r.id FROM users u, roles r
WHERE u.email = 'user@example.com' AND r.name = 'admin';
```

Generate bcrypt hash: `node -e "console.log(require('bcrypt').hashSync('password123', 10))"`

---

## Restart a stuck cron

Crons: `lasso-sheet-sync` (every 5 min), `preview-repair-sweep` (daily 03:00),
`ads-report-daily-refresh` (daily 22:00 UTC).

**Symptoms:** stale data, missing snapshots.

**Debug:**
1. Render dashboard → cron service → Logs → filter to last run
2. Look for errors or timeouts
3. If auth-related: check the cron's env vars match the service's

**Manual trigger:**
- `ads-report-daily-refresh` — hit `https://YOUR-DOMAIN/api/v1/ads-reporting/cron/refresh?secret=CRON_SECRET`
- `preview-repair-sweep` — hit `https://YOUR-DOMAIN/api/v1/statics-generation/repair-thumbnails` with `x-cron-secret` header
- `lasso-sheet-sync` — Render → cron service → **Trigger Run**

---

## Rotate a secret

```bash
# 1. Generate new secret
NEW_JWT=$(python3 -c "import secrets; print(secrets.token_urlsafe(48))")

# 2. Update in Render dashboard → Service → Environment
#    (Or via CLI: render env set JWT_ACCESS_SECRET="$NEW_JWT" --service YOUR_SERVICE_ID)

# 3. Render auto-redeploys with new value

# 4. Existing user sessions invalidate — they re-login
```

**Order matters** for some rotations:
- JWT secrets → invalidates sessions, users re-login (immediate)
- CRON_SECRET → must update in cron URLs simultaneously to avoid 403s
- Meta token → old token continues working until it naturally expires; harmless
  overlap

---

## Restore from DB backup

Render Postgres does daily snapshots + PITR.

1. Render dashboard → Postgres → **Backups** tab
2. Pick a backup timestamp
3. Click **Restore** → creates a NEW DB with the backup data
4. Update `DATABASE_URL` on the web service to point at the restored DB
5. Redeploy web service
6. Delete the old (broken) DB after verifying

**Test restore procedure once per quarter** — you don't want to discover backup
issues during a real incident.

---

## Copy R2 bucket during handover

```bash
# Install rclone
brew install rclone

# Configure both Cloudflare accounts
rclone config
# Add remote 1: 'seller-r2' with seller's credentials
# Add remote 2: 'buyer-r2' with your credentials

# Copy everything
rclone copy seller-r2:mineblock-creatives buyer-r2:mineblock-creatives-new \
  --progress --transfers 10

# Verify count
rclone size seller-r2:mineblock-creatives
rclone size buyer-r2:mineblock-creatives-new
```

Update `R2_*` env vars on the service, redeploy, verify new uploads land in
your bucket.

---

## Emergency: service won't boot

1. **Check the log** — Render → Service → Logs (last 100 lines)
2. Most common: `DATABASE_URL` wrong or DB down → verify DB is `available` in
   Render dashboard, verify env var value
3. Missing required env var → check `docs/handover/ENV-VARS.md` for R (required)
   items
4. Migration failure → check `_migrations` table in DB, may need to manually
   fix a migration
5. Rollback: Render → Deploys → previous good deploy → Redeploy

---

## Where things live

- **Code:** GitHub repo (transferred to you)
- **Data:** Render Postgres (transferred / migrated to you)
- **Images:** Cloudflare R2 (bucket copied to your account)
- **Meta assets:** Meta Business Manager (transferred to you)
- **Video review:** Frame.io (project shared / transferred)
- **Task tracking:** ClickUp (your workspace after handover)
- **Alerts:** Slack (your workspace)

If in doubt about something you didn't get: check the sale agreement, then the
seller during the support window.
