import { Router } from 'express';
import { authenticate } from '../middleware/auth.js';
import { pgQuery } from '../db/pg.js';

const router = Router();

// ── Config ──────────────────────────────────────────────────────────
const META_ACCESS_TOKEN = process.env.META_ACCESS_TOKEN || '';
const META_AD_ACCOUNT_IDS = (process.env.META_AD_ACCOUNT_IDS || '').split(',').filter(Boolean);
const META_GRAPH_URL = 'https://graph.facebook.com/v21.0';
const SLACK_BOT_TOKEN = process.env.SLACK_BOT_TOKEN || '';
const SLACK_CHANNEL = process.env.SLACK_REJECTION_CHANNEL || '';

// Map account IDs to friendly names
const ACCOUNT_NAMES = {
  'act_938489175321542': 'Mineblock X8',
  'act_1972517213693373': 'Mineblock CC 4',
  'act_1238893338181787': 'Mineblock CC 5',
  'act_25781501541499027': 'Mineblock X6',
  'act_1363888491879561': 'Luvora CC',
  'act_1417689703203647': 'Luvora CC 2',
  'act_642819725560039': 'Luvora CC 3',
};

// ── DB Table ────────────────────────────────────────────────────────
let tableReady = false;

async function ensureTable() {
  if (tableReady) return;
  await pgQuery(`
    CREATE TABLE IF NOT EXISTS ad_rejections_notified (
      ad_id TEXT PRIMARY KEY,
      ad_name TEXT,
      account_id TEXT,
      status TEXT DEFAULT 'DISAPPROVED',
      notified_at TIMESTAMPTZ DEFAULT NOW()
    )
  `);
  // Add status column if missing (existing installs)
  await pgQuery(`
    ALTER TABLE ad_rejections_notified ADD COLUMN IF NOT EXISTS status TEXT DEFAULT 'DISAPPROVED'
  `).catch(() => {});
  tableReady = true;
}

// ── Slack Helper ────────────────────────────────────────────────────
async function sendSlackMessage(text, blocks) {
  if (!SLACK_BOT_TOKEN || !SLACK_CHANNEL) {
    console.warn('[Ad Rejection] No SLACK_BOT_TOKEN or SLACK_REJECTION_CHANNEL configured');
    return;
  }

  const body = {
    channel: SLACK_CHANNEL,
    text,
    username: 'Mineblock Bot',
    icon_url: 'https://i.imgur.com/PJCRE4g.png',
    ...(blocks ? { blocks } : {}),
  };

  const resp = await fetch('https://slack.com/api/chat.postMessage', {
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${SLACK_BOT_TOKEN}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify(body),
  });

  const data = await resp.json();
  if (!data.ok) console.error('[Ad Rejection] Slack error:', data.error);
  return data;
}

// ── Helpers ─────────────────────────────────────────────────────────
const sleep = (ms) => new Promise(resolve => setTimeout(resolve, ms));

async function fetchAdsForAccount(accountId) {
  // Meta uses multiple statuses for rejected/problematic ads:
  // DISAPPROVED — permanently rejected
  // WITH_ISSUES — rejected but can be edited and resubmitted
  // PENDING_REVIEW — could be a resubmission after rejection (we track to catch fast rejections)
  const url = `${META_GRAPH_URL}/${accountId}/ads?fields=name,effective_status,ad_review_feedback&effective_status=["DISAPPROVED","WITH_ISSUES","PENDING_REVIEW"]&limit=100&access_token=${META_ACCESS_TOKEN}`;
  const resp = await fetch(url);
  return resp.json();
}

// ── Core: Check for Rejected Ads ────────────────────────────────────
async function checkRejectedAds() {
  if (!META_ACCESS_TOKEN || META_AD_ACCOUNT_IDS.length === 0) {
    console.warn('[Ad Rejection] No META_ACCESS_TOKEN or META_AD_ACCOUNT_IDS configured');
    return { checked: 0, newRejections: 0 };
  }

  await ensureTable();

  let totalChecked = 0;
  let newRejections = 0;
  const rateLimitedAccounts = [];

  for (let i = 0; i < META_AD_ACCOUNT_IDS.length; i++) {
    const accountId = META_AD_ACCOUNT_IDS[i];
    if (i > 0) await sleep(5000); // 5s delay between accounts

    try {
      const data = await fetchAdsForAccount(accountId);

      if (data.error) {
        console.warn(`[Ad Rejection] Error for ${accountId}:`, data.error.message);
        if (data.error.code === 17) rateLimitedAccounts.push(accountId);
        continue;
      }

      const ads = data.data || [];
      const accountName = ACCOUNT_NAMES[accountId] || accountId;

      for (const ad of ads) {
        const status = ad.effective_status;

        // Only notify for DISAPPROVED and WITH_ISSUES (actual rejections)
        // PENDING_REVIEW ads are tracked but only notified if they were previously rejected
        if (status === 'PENDING_REVIEW') {
          // Check if this was a previously rejected ad that got resubmitted
          // If we already notified, skip. If not, it's a new submission — skip too.
          continue;
        }

        // Check if we already notified about this ad
        const existing = await pgQuery(
          'SELECT ad_id FROM ad_rejections_notified WHERE ad_id = $1',
          [ad.id]
        );
        if (existing.length > 0) continue;

        // New rejection — send Slack notification
        const adName = ad.name || 'Unknown';
        totalChecked++;

        const statusLabel = status === 'WITH_ISSUES' ? 'Ad Rejected (With Issues)' : 'Ad Rejected';

        const blocks = [
          {
            type: 'header',
            text: { type: 'plain_text', text: `:no_entry: ${statusLabel}`, emoji: true },
          },
          {
            type: 'section',
            fields: [
              { type: 'mrkdwn', text: `*Ad Name:*\n${adName}` },
              { type: 'mrkdwn', text: `*Ad Account:*\n${accountName}` },
            ],
          },
          {
            type: 'section',
            fields: [
              { type: 'mrkdwn', text: `*Ad ID:*\n\`${ad.id}\`` },
              { type: 'mrkdwn', text: `*Status:*\n${status}` },
            ],
          },
          { type: 'divider' },
        ];

        await sendSlackMessage(`${statusLabel}: ${adName} (${accountName})`, blocks);

        await pgQuery(
          'INSERT INTO ad_rejections_notified (ad_id, ad_name, account_id, status) VALUES ($1, $2, $3, $4) ON CONFLICT (ad_id) DO NOTHING',
          [ad.id, adName, accountId, status]
        );

        newRejections++;
        console.log(`[Ad Rejection] Notified: "${adName}" [${status}] from ${accountName}`);
      }
    } catch (err) {
      console.error(`[Ad Rejection] Error checking ${accountId}:`, err.message);
    }
  }

  // Retry rate-limited accounts after 60s cooldown
  if (rateLimitedAccounts.length > 0) {
    console.log(`[Ad Rejection] ${rateLimitedAccounts.length} accounts rate-limited, retrying in 60s...`);
    await sleep(60_000);
    for (let i = 0; i < rateLimitedAccounts.length; i++) {
      const accountId = rateLimitedAccounts[i];
      if (i > 0) await sleep(5000);
      try {
        const data = await fetchAdsForAccount(accountId);
        if (data.error) {
          console.warn(`[Ad Rejection] Retry failed for ${accountId}:`, data.error.message);
          continue;
        }
        const ads = data.data || [];
        const accountName = ACCOUNT_NAMES[accountId] || accountId;
        for (const ad of ads) {
          if (ad.effective_status === 'PENDING_REVIEW') continue;
          const existing = await pgQuery('SELECT ad_id FROM ad_rejections_notified WHERE ad_id = $1', [ad.id]);
          if (existing.length > 0) continue;
          const adName = ad.name || 'Unknown';
          const status = ad.effective_status;
          totalChecked++;
          const statusLabel = status === 'WITH_ISSUES' ? 'Ad Rejected (With Issues)' : 'Ad Rejected';
          const blocks = [
            { type: 'header', text: { type: 'plain_text', text: `:no_entry: ${statusLabel}`, emoji: true } },
            { type: 'section', fields: [
              { type: 'mrkdwn', text: `*Ad Name:*\n${adName}` },
              { type: 'mrkdwn', text: `*Ad Account:*\n${accountName}` },
            ]},
            { type: 'section', fields: [
              { type: 'mrkdwn', text: `*Ad ID:*\n\`${ad.id}\`` },
              { type: 'mrkdwn', text: `*Status:*\n${status}` },
            ]},
            { type: 'divider' },
          ];
          await sendSlackMessage(`${statusLabel}: ${adName} (${accountName})`, blocks);
          await pgQuery(
            'INSERT INTO ad_rejections_notified (ad_id, ad_name, account_id, status) VALUES ($1, $2, $3, $4) ON CONFLICT (ad_id) DO NOTHING',
            [ad.id, adName, accountId, status]
          );
          newRejections++;
          console.log(`[Ad Rejection] Notified (retry): "${adName}" [${status}] from ${accountName}`);
        }
      } catch (err) {
        console.error(`[Ad Rejection] Retry error for ${accountId}:`, err.message);
      }
    }
  }

  console.log(`[Ad Rejection] Checked ads, ${newRejections} new notifications sent`);
  return { checked: totalChecked, newRejections };
}

// ── Routes ──────────────────────────────────────────────────────────

/** GET /status — Check current rejection monitor status */
router.get('/status', authenticate, async (req, res) => {
  try {
    await ensureTable();
    const notified = await pgQuery('SELECT COUNT(*) as count FROM ad_rejections_notified');
    res.json({
      success: true,
      data: {
        totalNotified: parseInt(notified[0].count),
        slackConfigured: !!(SLACK_BOT_TOKEN && SLACK_CHANNEL),
        metaConfigured: !!(META_ACCESS_TOKEN && META_AD_ACCOUNT_IDS.length),
        accountCount: META_AD_ACCOUNT_IDS.length,
      },
    });
  } catch (err) {
    res.status(500).json({ success: false, error: { message: err.message } });
  }
});

/** POST /check-now — Manually trigger a rejection check */
router.post('/check-now', authenticate, async (req, res) => {
  try {
    const result = await checkRejectedAds();
    res.json({ success: true, data: result });
  } catch (err) {
    res.status(500).json({ success: false, error: { message: err.message } });
  }
});

// ── Keep-alive ping (prevents Render free tier from sleeping) ──────
const RENDER_URL = process.env.RENDER_EXTERNAL_URL || 'https://mineblock-dashboard.onrender.com';
setInterval(async () => {
  try { await fetch(`${RENDER_URL}/api/health`); } catch {}
}, 10 * 60 * 1000); // Ping every 10 minutes

// ── Fallback poll every 30 minutes (primary: Meta webhook in metaWebhook.js) ──
setTimeout(() => {
  checkRejectedAds().catch(err => console.warn('[Ad Rejection] Initial check error:', err.message));
  setInterval(() => checkRejectedAds().catch(() => {}), 30 * 60 * 1000);
}, 45_000);

export default router;
