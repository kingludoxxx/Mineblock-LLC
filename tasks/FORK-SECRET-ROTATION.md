# Fork — Secret Rotation Runbook (Phase 5)

**Owner:** Ludo
**Runs:** Just before Phase 7 (buyer cutover)
**Rationale:** After the fork completes, Puure and Mineblock instances both hold copies of secrets that used to be shared. Every secret Puure retains that WAS also in Mineblock's env must be rotated on both sides — otherwise the buyer inherits keys that Puure can use, and vice versa.

---

## Already Puure-specific (no rotation needed)

These were generated fresh for Puure during Phase 3.4 — Mineblock never had these values:

- `JWT_ACCESS_SECRET` (Puure fresh)
- `JWT_REFRESH_SECRET` (Puure fresh)
- `SESSION_SECRET` (Puure fresh)
- `CRON_SECRET` (Puure: `puure-cron-2026-a8kfP93lQ` · Mineblock keeps: `mb-reset-2026-xK9p`)
- `SUPERADMIN_EMAIL` / `SUPERADMIN_PASSWORD` (Puure: `admin@trypuure.co` / `PuureAdmin2026!` — **change on first login**)

## Not-yet-configured on Puure (no rotation needed until Puure connects them)

These are unset on Puure — no shared value to rotate:

- Meta: `META_ACCESS_TOKEN`, `META_APP_*`, `META_BUSINESS_ID`, `META_AD_ACCOUNT_IDS`, `META_PAGE_ID`
- Shopify: `SHOPIFY_ACCESS_TOKEN`, `SHOPIFY_WEBHOOK_SECRET`
- ClickUp: `CLICKUP_API_TOKEN` + list IDs
- Frame.io: `FRAMEIO_TOKEN`, `FRAMEIO_CLIENT_ID/SECRET`, project/folder IDs
- Slack: `SLACK_BOT_TOKEN`, webhook URLs, channel IDs
- Cloudflare R2: `R2_*`
- TripleWhale, Sellerboard, Lasso, Whop, HubSpot, ScrapeCreators

When Puure connects any of these, use fresh credentials — never reuse Mineblock's.

## MUST rotate before buyer cutover

These ARE shared between Mineblock and Puure right now. Rotation plan below.

### 1. LLM keys (shared with Puure)

Both instances currently hold the same values:

| Env var | Where to rotate |
|---------|-----------------|
| `ANTHROPIC_API_KEY` | console.anthropic.com → Settings → API Keys |
| `GEMINI_API_KEY` | aistudio.google.com → API keys |
| `NANOBANANA_API_KEY` | kie.ai (or NanoBanana provider) dashboard |

**Procedure per key:**
1. Generate two new keys (one for Mineblock, one for Puure).
2. Update Mineblock's env var (Render dashboard → mineblock-dashboard → Environment) with Mineblock's new value.
3. Update Puure's env var with Puure's new value.
4. Wait for both services to auto-redeploy (~2-3 min each).
5. Verify both services still work: hit a creative generation endpoint on each.
6. **Delete the OLD (shared) key** from the LLM provider console — this is the security-critical step. Both instances now use fresh, isolated keys.

### 2. R2 bucket credentials (SHARED via my earlier commit)

If Puure ends up using the same R2 bucket short-term, its credentials are Mineblock's. Preferred: Puure gets its own R2 bucket.

**Immediate procedure:** none needed unless Puure connects R2. Long-term: create Puure R2 bucket (Phase 3.3).

### 3. GitHub PAT / Render API key (if either exists in either env)

Check `.env` for `GITHUB_TOKEN`, `RENDER_API_KEY`. If present, rotate:

```bash
grep -E '^(GITHUB_TOKEN|RENDER_API_KEY)=' /Users/ludo/Mineblock-LLC/.env
```

If any hits, revoke old + generate new for the retained instance.

## Rotation for the MINEBLOCK side (before sale)

Before handing Mineblock to the buyer, ALSO rotate everything the buyer will inherit — because Puure/you saw those values during the fork process:

1. `JWT_ACCESS_SECRET`, `JWT_REFRESH_SECRET`, `SESSION_SECRET` (Mineblock's originals)
2. `CRON_SECRET` (Mineblock's `mb-reset-2026-xK9p`)
3. `META_ACCESS_TOKEN` (Meta BM System User token) — regenerate in Meta Business Settings
4. `SHOPIFY_ACCESS_TOKEN` — regenerate in Shopify custom app admin
5. `SHOPIFY_WEBHOOK_SECRET` — regenerate + re-register webhooks
6. `CLICKUP_API_TOKEN` — regenerate in ClickUp settings
7. `FRAMEIO_TOKEN` — re-run OAuth flow to get fresh token
8. `SLACK_BOT_TOKEN` — regenerate in Slack app admin
9. `R2_ACCESS_KEY_ID` + `R2_SECRET_ACCESS_KEY` — regenerate in Cloudflare
10. `SUPPLIER_SHARE_TOKEN` — regenerate any 32+ char random string
11. Any `TRIPLEWHALE_API_KEY`, `SELLERBOARD_FEED_URL`, etc. that Mineblock uses
12. `SUPERADMIN_PASSWORD` — buyer changes on first login (they need the current password once to log in)

**Order:** rotate JWT+session first (invalidates sessions, users re-login) → CRON_SECRET (update in cron URLs simultaneously) → 3rd-party tokens (each in its own admin, then update Render env) → LLM keys last (least disruptive if you get one wrong).

## Verification after rotation

After both sides are rotated:
```bash
# Puure
curl https://puure-dashboard.onrender.com/api/health
# Mineblock
curl https://mineblock-dashboard.onrender.com/api/health
```

Both should return `{"success":true,"data":{"status":"healthy",...}}`.

Test one creative generation on each side to confirm LLM keys work.

## Git history scrub (if any secrets ever committed)

```bash
# Check if any known secret patterns are in git history
git log --all -p -- .env | head -50   # should be empty; .env is gitignored
git log --all -p | grep -E "sk-ant-|AIza|xoxb-|EAAX" | head -5

# If hits found: use BFG Repo-Cleaner or git-filter-repo to remove them
# See RUNBOOK.md → "Emergency: secret committed"
```

## Sign-off

Once this is complete:
- Both instances run with independent credentials
- The buyer inherits Mineblock with all-fresh secrets
- You keep Puure with all-fresh secrets
- No cross-instance leverage remains
