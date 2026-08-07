# Buyer Day-1 Checklist

Print this. Check items off as you complete them. Nothing else works until
these are done.

---

## Prerequisites (before Day 1)

- [ ] You've received the sale agreement, signed and returned it
- [ ] GitHub username sent to seller
- [ ] Render account created (`dashboard.render.com`)
- [ ] Cloudflare account created (for R2 bucket handover)
- [ ] Meta Business Manager admin access confirmed (BM ID `1757150421916101`)
- [ ] Shopify store admin access confirmed
- [ ] ClickUp workspace admin access confirmed
- [ ] Frame.io / Adobe IMS account access confirmed
- [ ] Slack workspace admin access confirmed

## Day 1

### GitHub
- [ ] Seller initiated repo transfer → **you accepted** in GitHub notifications
- [ ] Confirmed you can clone the repo locally
- [ ] Set up branch protection on `main`, add teammates as needed

### Render (Option A: workspace transfer)
- [ ] Seller opened support ticket at Render
- [ ] You opened support ticket linking to seller's request
- [ ] Render processed transfer (1-5 business days)
- [ ] You're the owner of the workspace + services + DB

### Render (Option B: fresh deploy — recommended)
- [ ] Seller sent `pg_dump` of Mineblock DB
- [ ] Created new Render workspace under your account
- [ ] Created new Postgres in your workspace (region: virginia)
- [ ] Imported the dump — verified row counts match what seller reported
- [ ] Created new Web Service in your workspace (see RUNBOOK for build/start commands)
- [ ] Set env vars per `ENV-VARS.md` — all R (required) items filled
- [ ] Service booted successfully (`/api/health` returns 200)
- [ ] Logged in as superadmin with credentials seller provided

### Immediate security actions
- [ ] Rotated `JWT_ACCESS_SECRET`
- [ ] Rotated `JWT_REFRESH_SECRET`
- [ ] Rotated `SESSION_SECRET`
- [ ] Rotated `CRON_SECRET` (updated in `ads-report-daily-refresh` cron URL too)
- [ ] Rotated `SUPPLIER_SHARE_TOKEN`
- [ ] Changed superadmin password via UI
- [ ] All human users' passwords: force reset via SQL or UI

### Cloudflare R2
- [ ] Created R2 bucket in your Cloudflare account
- [ ] Seller ran `rclone copy` to move bucket contents (~1-5 GB)
- [ ] Row counts / file counts verified
- [ ] Updated `R2_*` env vars in Render
- [ ] Redeployed → verified new image uploads land in your bucket
- [ ] Seller marked their bucket for 30-day cold backup, then delete

### Meta
- [ ] Seller added you as admin on the Business Manager
- [ ] Seller transferred BM ownership to you
- [ ] Confirmed you can access all ad accounts + pages
- [ ] Generated a fresh Meta System User token
- [ ] Updated `META_ACCESS_TOKEN`, `META_APP_ID`, `META_APP_SECRET`,
      `META_BUSINESS_ID`, `META_AD_ACCOUNT_IDS`, `META_PAGE_ID`
- [ ] Updated Meta webhook URL in Meta App settings → point at your Render URL
- [ ] Test: launched one test ad in a paused campaign — end-to-end works

### Shopify
- [ ] Confirmed access to Shopify store admin
- [ ] Created new custom app with required API scopes
- [ ] Updated `SHOPIFY_ACCESS_TOKEN`, `SHOPIFY_WEBHOOK_SECRET`, `SHOPIFY_STORE_URL`
- [ ] Updated Shopify webhook URLs to your Render URL
- [ ] Test: placed a test order → webhook fired → order visible in dashboard

### ClickUp
- [ ] Confirmed workspace access
- [ ] Generated new ClickUp API token
- [ ] Updated `CLICKUP_API_TOKEN`, `CLICKUP_TEAM_ID`, list IDs
- [ ] Test: created a ClickUp task → sync to dashboard works

### Frame.io / Adobe
- [ ] Adobe IMS credentials for OAuth generated
- [ ] Ran OAuth flow → got new `FRAMEIO_TOKEN`
- [ ] Updated all `FRAMEIO_*` env vars
- [ ] Test: launched a creative that requires a Frame.io folder — auto-created

### LLM keys (bring your own)
- [ ] Anthropic API key → `ANTHROPIC_API_KEY`
- [ ] Gemini API key → `GEMINI_API_KEY`
- [ ] NanoBanana / Kie.ai key → `NANOBANANA_API_KEY`
- [ ] Test: generated one static ad end-to-end

### DNS + custom domain (optional but recommended)
- [ ] Point your domain at Render (Render → Service → Custom Domain)
- [ ] Update `PUBLIC_APP_URL` env var to match
- [ ] Update Meta webhook, Shopify webhook, ClickUp webhook, Frame.io redirect
- [ ] TLS cert auto-provisioned by Render

### Verify all crons
- [ ] `lasso-sheet-sync` — check last successful run in Render logs (or skip if
      not using Lasso)
- [ ] `preview-repair-sweep` — check last run
- [ ] `ads-report-daily-refresh` — cron URL includes your new `CRON_SECRET`

### Documentation
- [ ] Read `README.md` (overview)
- [ ] Read `ARCHITECTURE.md` (mental model)
- [ ] Bookmark `RUNBOOK.md` (day-2 ops)
- [ ] Add seller's support-window contact to your address book

---

## When you can say "done"

- Log in as any user → see the dashboard load
- Meta ad launcher works end-to-end (launched a test ad, saw it in Meta)
- All 3+ crons ran successfully at least once under your ownership
- No secrets inherited from seller are still in use (all rotated)
- You've made and shipped one small code change (e.g. update the brand name in
  UI) — proves the deploy pipeline is under your control
