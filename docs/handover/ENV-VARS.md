# Environment Variables — Full Reference

Every env var the dashboard reads. Grouped by system, marked required (R) or
optional (O). Set these on your Render service (dashboard → Environment tab).

---

## Core

| Var | R/O | What it is |
|-----|-----|-----------|
| `DATABASE_URL` | R | Postgres connection string. Auto-set by Render if you link the DB. |
| `NODE_ENV` | R | `production` on Render, `development` locally |
| `PORT` | O | Defaults to 3000 |
| `RENDER_EXTERNAL_URL` | auto | Set by Render automatically |
| `PUBLIC_APP_URL` | O | Fallback if `RENDER_EXTERNAL_URL` unset (e.g. self-hosted). Used for absolute URL generation. |

## Auth / Admin

| Var | R/O | What it is |
|-----|-----|-----------|
| `JWT_ACCESS_SECRET` | R | Signs access tokens. Generate: `python3 -c "import secrets; print(secrets.token_urlsafe(48))"` |
| `JWT_REFRESH_SECRET` | R | Signs refresh tokens. Same generator, different value. |
| `SESSION_SECRET` | R | Session encryption key. Same generator. |
| `SUPERADMIN_EMAIL` | R | Email for the auto-seeded superadmin account. |
| `SUPERADMIN_PASSWORD` | R | Initial password. **Change immediately after first login.** |
| `CRON_SECRET` | R | Shared secret for cron endpoint auth. Any random ~24 char string. Also embed in `ads-report-daily-refresh` cron URL. |

## Branding

| Var | R/O | What it is |
|-----|-----|-----------|
| `BRAND_NAME` | O | Full brand name for logs/Slack (e.g. `"Mineblock LLC"`) |
| `BRAND_SHORT_NAME` | O | Short brand name for UI (e.g. `"Mineblock"`) |
| `BRAND_APP_NAME` | O | Logger service name (e.g. `"mineblock-admin"`) |
| `BRAND_EMAIL_DOMAIN` | O | Default email domain for placeholders (e.g. `"mineblock.com"`) |
| `VITE_BRAND_NAME` | O | Same as `BRAND_NAME` but for the client build |
| `VITE_BRAND_SHORT_NAME` | O | Same for client |
| `VITE_BRAND_LOGO_WHITE` | O | Path to white logo asset in `client/public/` |
| `VITE_BRAND_LOGO_SYMBOL` | O | Path to symbol/mark logo |
| `VITE_BRAND_LOGO_BLACK` | O | Path to black-background logo |
| `VITE_BRAND_EMAIL_DOMAIN` | O | Client-side email domain |

## AI Providers

| Var | R/O | What it is |
|-----|-----|-----------|
| `ANTHROPIC_API_KEY` | R | Claude API key (creative generation). |
| `GEMINI_API_KEY` | R | Gemini API key. |
| `NANOBANANA_API_KEY` | R | NanoBanana / Kie.ai key for image generation. |
| `OPENAI_API_KEY` | O | Optional — used in specific paths only. |
| `GOOGLE_API_KEY` | O | Google Cloud key if using specific Google services. |
| `GOOGLE_SA_JSON` | O | Google service account JSON (as string) for GCP resources. |

## Meta (Facebook/Instagram Ads)

| Var | R/O | What it is |
|-----|-----|-----------|
| `META_ACCESS_TOKEN` | R | System User token (long-lived, from Meta BM). |
| `META_APP_ID` | R | Meta App ID (from developers.facebook.com). |
| `META_APP_SECRET` | R | Meta App Secret. |
| `META_BUSINESS_ID` | R | Business Manager ID. |
| `META_AD_ACCOUNT_IDS` | R | Comma-separated `act_XXXXX` IDs. |
| `META_PAGE_ID` | R | Facebook Page ID for ad delivery. |
| `META_WEBHOOK_VERIFY_TOKEN` | R | Random string, must match Meta webhook config. |
| `META_APP_TOKEN` | O | App-level token for some webhook paths. |

## Shopify

| Var | R/O | What it is |
|-----|-----|-----------|
| `SHOPIFY_ACCESS_TOKEN` | R | Custom app access token. |
| `SHOPIFY_STORE_URL` | R | e.g. `https://your-store.myshopify.com` or `https://your-brand.co` |
| `SHOPIFY_WEBHOOK_SECRET` | R | Shopify webhook signing secret. |

## ClickUp

| Var | R/O | What it is |
|-----|-----|-----------|
| `CLICKUP_API_TOKEN` | R | ClickUp API v2 token. |
| `CLICKUP_TEAM_ID` | R | Workspace/team ID. |
| `CLICKUP_MB_VIDEO_LIST_ID` | R | Video ads list ID for this brand. |
| `CLICKUP_MB_STATIC_LIST_ID` | R | Static ads list ID. |
| `CLICKUP_MB_MEDIA_BUYING_LIST_ID` | O | Media buying list ID. |
| `CLICKUP_MB_PRODUCTS_LIST_ID` | O | Products relationship list. |
| `CLICKUP_MB_AVATARS_LIST_ID` | O | Avatars relationship list. |
| `CLICKUP_MB_CREATORS_LIST_ID` | O | Creators database list. |
| `CLICKUP_LANGUAGES_LIST_ID` | O | Video ads languages list. |
| `CLICKUP_PUURE_VIDEO_LIST_ID` | O | Leave unset unless you're operating multiple brands. |

## Frame.io / Adobe

| Var | R/O | What it is |
|-----|-----|-----------|
| `FRAMEIO_TOKEN` | R | Frame.io API token (from OAuth flow). |
| `FRAMEIO_ACCOUNT_ID` | R | Your Adobe/Frame.io account ID (UUID). |
| `FRAMEIO_CLIENT_ID` | R | OAuth client ID. |
| `FRAMEIO_CLIENT_SECRET` | R | OAuth client secret. |
| `FRAMEIO_MB_PROJECT_ID` | R | Frame.io project UUID for this brand. |
| `FRAMEIO_MB_EDITING_FOLDER` | R | Folder UUID for video pipeline. |
| `FRAMEIO_MB_STATIC_EDITING_FOLDER` | R | Folder UUID for static pipeline. |
| `FRAMEIO_LEGIT_PROJECT_NAMES` | O | Comma-separated allow-list of legit Frame.io project names. |
| `FRAMEIO_CLEANUP_SECRET` | O | Admin secret for the cleanup endpoint. |
| `FRAMEIO_PUURE_PROJECT_ID` | O | Leave unset unless multi-brand. |
| `FRAMEIO_PUURE_EDITING_FOLDER` | O | Same. |

## Slack

| Var | R/O | What it is |
|-----|-----|-----------|
| `SLACK_BOT_TOKEN` | R | Slack bot token (starts with `xoxb-`). |
| `SLACK_WEBHOOK_URL` | O | Fallback webhook if bot token isn't set. |
| `SLACK_ALERTS_CHANNEL` | O | Channel ID for alerts. |
| `SLACK_REJECTION_CHANNEL` | O | Channel ID for ad rejection notices. |
| `SLACK_PNL_CHANNEL` | O | Channel ID for P&L reports. |

## Cloudflare R2 (Image storage)

| Var | R/O | What it is |
|-----|-----|-----------|
| `R2_ACCOUNT_ID` | R | Cloudflare account ID. |
| `R2_ACCESS_KEY_ID` | R | R2 API key ID. |
| `R2_SECRET_ACCESS_KEY` | R | R2 API secret. |
| `R2_BUCKET_NAME` | R | Bucket name (e.g. `mineblock-creatives`). |
| `R2_PUBLIC_URL` | R | Public URL prefix for bucket (custom domain or `pub-xxx.r2.dev`). |

## Optional integrations

| Var | R/O | What it is |
|-----|-----|-----------|
| `TRIPLEWHALE_API_KEY` | O | Only if you use TripleWhale. |
| `TRIPLEWHALE_SHOP_ID` | O | Same. |
| `SELLERBOARD_FEED_URL` | O | Only if you have Amazon KPIs. |
| `LASSO_EMAIL`, `LASSO_PASSWORD`, `LASSO_SHEET_ID` | O | Only for `lasso-sheet-sync` cron. |
| `WHOP_API_TOKEN` | O | Whop.com integration. |
| `SCRAPECREATORS_API_KEY` | O | Meta Ad Library scraper backend. |
| `HUBSPOT_API_KEY` | O | HubSpot integration. |
| `REDIS_URL` | O | Redis for session cache. Falls back to in-memory if unset. |

## Fork/multi-brand flags

| Var | R/O | What it is |
|-----|-----|-----------|
| `PUURE_DATABASE_URL` | O | Set on the source instance during fork migration only. Ignore. |
| `SEED_MINERFORGE_ANGLES` | O | Set to `false` on a non-Mineblock instance to skip the MinerForge angle seed. |
| `SUPPLIER_SHARE_TOKEN` | O | Secret for the public supplier sheet page. |

---

## Quick generation snippets

```bash
# JWT/SESSION secret
python3 -c "import secrets; print(secrets.token_urlsafe(48))"

# CRON secret (24 char, URL-safe)
python3 -c "import secrets; print(secrets.token_urlsafe(24))"
```
