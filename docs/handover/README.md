# Mineblock LLC — Admin Dashboard: Buyer Handover Packet

This is the operator's guide for the new owner of the Mineblock admin dashboard.
Read this **first** — it maps the whole system in the order you'll interact with it.

---

## 1. What you're getting

A production Node.js + Express + React admin dashboard that runs Mineblock's
e-commerce operations:

- **Creative pipeline** — brief generation, statics generation (AI images),
  advertorial writing, iteration workflows
- **Ad launcher** — Meta Ads API integration, launches image + video ads,
  auto-monitors rejections
- **Ads reporting** — pulls spend/ROAS from Meta + TripleWhale
- **Storefront sync** — Shopify webhook consumer, product profile management
- **Analytics** — KPI system, PnL, creative intelligence
- **ClickUp bridge** — bidirectional sync with the video/static ad pipeline
- **Frame.io integration** — auto-creates project folders, video asset workflow
- **Brand spy** — competitor Meta ad library scraper (external repo, integrates
  via API)

**Tech stack:** Node.js 18+, Express, PostgreSQL 16, React + Vite + Tailwind,
JWT auth. Runs on Render.com.

---

## 2. What's included in the sale

- **GitHub repo:** `github.com/kingludoxxx/Mineblock-LLC` — will be transferred
  to your GitHub account/org (see §6)
- **Render infra:** one workspace with the web service, Postgres DB, cron jobs
  — either transferred to your Render account (Option A) or you set up fresh
  (Option B). See §7.
- **Cloudflare R2 bucket:** `mineblock-creatives` — image asset storage; see §8
  for handover
- **Meta App (Business Manager 2082207262730692):** ownership transferable via
  Meta Business Settings; see §9
- **Shopify custom app credentials:** for your Shopify store; see §10
- **This handover packet** — the docs you're reading

---

## 3. What's NOT included

- The seller's Puure brand data (stripped from the DB before handover)
- Shared LLM API keys (Anthropic, Gemini, NanoBanana) — you get placeholder
  values; substitute your own accounts
- Shared 3rd-party accounts the seller keeps for their other brands
- Support beyond the agreed handover window

---

## 4. First-boot checklist

Once the GitHub repo + Render service are in your account:

1. **Rotate every secret** (see §5 for the full list). Values you inherited must
   be treated as compromised.
2. **Change the superadmin password.** SSH into the Render service or log in
   with the credentials the seller provided, immediately change your password.
3. **Verify the DB backup restore works.** Render Postgres has daily backups;
   test the restore procedure once before you rely on it.
4. **Test the Meta launcher.** Launch one test ad in a paused campaign,
   confirm end-to-end.
5. **Confirm all crons are running.** `lasso-sheet-sync`, `preview-repair-sweep`
   — check their logs for successful last-run timestamps.
6. **Point your DNS.** If you're moving to a custom domain, update Render's
   custom domain settings and your DNS records.

---

## 5. Environment variables (secret reference)

See `docs/handover/ENV-VARS.md` for the full reference — every env var
explained, whether it's required, and how to set it up on your side.

**Rotation order (do this on Day 1):**
1. `JWT_ACCESS_SECRET`, `JWT_REFRESH_SECRET`, `SESSION_SECRET` — rotates all
   user sessions. Users will need to re-login.
2. `CRON_SECRET` — update in the cron job's URL too (`ads-report-daily-refresh`
   uses `?secret=` query param).
3. `SUPERADMIN_EMAIL` + `SUPERADMIN_PASSWORD` — on first boot the app seeds
   a superadmin from these; change immediately after first login.
4. Meta System User token — regenerate in Meta Business Settings.
5. Shopify Access Token — regenerate in your Shopify custom app admin.
6. ClickUp API Token — regenerate in ClickUp profile settings.
7. Frame.io OAuth — go through the OAuth flow with your Adobe IMS account.
8. LLM keys — swap to your own Anthropic / Gemini / NanoBanana keys.

---

## 6. GitHub repo handover

The seller will initiate a repo transfer to your GitHub account:

1. You provide your GitHub username
2. Seller: repo Settings → Transfer ownership → enter your username
3. You accept the transfer request in your GitHub notifications
4. Update any GitHub Actions secrets/env if the repo uses them
5. Update Render's repo connection to point at your fork

---

## 7. Render handover

Two paths — pick whichever fits your infra plans:

### Option A: Transfer the existing Render workspace (support-ticket process)
Render doesn't expose workspace ownership transfer via UI. Both parties
open a support ticket at dashboard.render.com and Render moves ownership.
Takes 1-5 business days. Downtime: none.

### Option B: Fresh deploy on your Render account *(recommended for control)*
1. You create your own Render workspace (self-serve, 5 min)
2. Seller provides `pg_dump` of the Mineblock DB
3. You create new Postgres in your workspace, restore the dump
4. You create new web service pointed at the transferred GitHub repo
5. You set all env vars (from `ENV-VARS.md`)
6. Deploy → verify
7. Update DNS to point at your new Render URL
8. Seller deletes their original service after 30-day cold-backup window

**See `docs/handover/RUNBOOK.md` § "Fresh deploy" for step-by-step commands.**

---

## 8. Cloudflare R2 bucket handover

R2 is where all creative image assets live (~1-5 GB typically).

1. You create a Cloudflare account (if you don't have one)
2. Create a new R2 bucket in your account (e.g. `mineblock-creatives-new`)
3. Seller uses `rclone` to copy from their bucket to yours (see RUNBOOK)
4. You update `R2_ACCOUNT_ID`, `R2_ACCESS_KEY_ID`, `R2_SECRET_ACCESS_KEY`,
   `R2_BUCKET_NAME`, `R2_PUBLIC_URL` env vars on your service
5. Test a fresh ad launch to confirm uploads work
6. Seller deletes their bucket after 30-day cold-backup window

---

## 9. Meta App + Business Manager

**Meta App ID:** `2082207262730692` (Mineblock APP V2)
**Business Manager ID:** `1757150421916101`

Handover in Meta Business Settings:
1. Seller adds you as admin on the BM
2. Seller transfers BM ownership to you
3. You generate a fresh System User token
4. Update `META_ACCESS_TOKEN`, `META_APP_ID`, `META_APP_SECRET`,
   `META_BUSINESS_ID`, `META_AD_ACCOUNT_IDS`, `META_PAGE_ID` env vars

---

## 10. Shopify handover

**Store:** the Mineblock Shopify store (URL confirmed at sale).

The dashboard uses Shopify custom app credentials — you'll create a new
custom app in your Shopify admin:
1. Shopify admin → Apps → Develop apps → Create custom app
2. Grant same API access scopes (see RUNBOOK)
3. Generate credentials
4. Update `SHOPIFY_ACCESS_TOKEN`, `SHOPIFY_WEBHOOK_SECRET`, `SHOPIFY_STORE_URL`

---

## 11. Support window

The seller is available for [30 / 60 / 90] days post-handover for questions
and troubleshooting. See your sale agreement for exact terms.

Contact: [seller email in agreement]

---

## Documents in this packet
- **README.md** (this file) — overview and handover flow
- **ENV-VARS.md** — env var reference, every key explained
- **RUNBOOK.md** — day-2 operations (deploy, add product, launch ad, rotate
  secrets, restore backup, debug cron)
- **ARCHITECTURE.md** — 1-page system overview: services, DBs, integrations
- **MIGRATION-CHECKLIST.md** — the buyer's Day 1 checklist in one place
