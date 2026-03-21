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
      notified_at TIMESTAMPTZ DEFAULT NOW()
    )
  `);
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

// ── Core: Check for Rejected Ads ────────────────────────────────────
async function checkRejectedAds() {
  if (!META_ACCESS_TOKEN || META_AD_ACCOUNT_IDS.length === 0) {
    console.warn('[Ad Rejection] No META_ACCESS_TOKEN or META_AD_ACCOUNT_IDS configured');
    return { checked: 0, newRejections: 0 };
  }

  await ensureTable();

  let totalChecked = 0;
  let newRejections = 0;

  for (const accountId of META_AD_ACCOUNT_IDS) {
    try {
      // Fetch disapproved ads from this account
      const url = `${META_GRAPH_URL}/${accountId}/ads?fields=name,effective_status,ad_review_feedback&effective_status=["DISAPPROVED"]&limit=100&access_token=${META_ACCESS_TOKEN}`;
      const resp = await fetch(url);
      const data = await resp.json();

      if (data.error) {
        console.warn(`[Ad Rejection] Error for ${accountId}:`, data.error.message);
        continue;
      }

      const rejectedAds = data.data || [];
      totalChecked += rejectedAds.length;

      for (const ad of rejectedAds) {
        // Check if we already notified about this ad
        const existing = await pgQuery(
          'SELECT ad_id FROM ad_rejections_notified WHERE ad_id = $1',
          [ad.id]
        );

        if (existing.length > 0) continue; // Already notified

        // New rejection — send Slack notification
        const accountName = ACCOUNT_NAMES[accountId] || accountId;
        const adName = ad.name || 'Unknown';

        const blocks = [
          {
            type: 'header',
            text: { type: 'plain_text', text: ':no_entry: Ad Rejected', emoji: true },
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
            ],
          },
          { type: 'divider' },
        ];

        await sendSlackMessage(`Ad Rejected: ${adName} (${accountName})`, blocks);

        // Mark as notified
        await pgQuery(
          'INSERT INTO ad_rejections_notified (ad_id, ad_name, account_id) VALUES ($1, $2, $3) ON CONFLICT (ad_id) DO NOTHING',
          [ad.id, adName, accountId]
        );

        newRejections++;
        console.log(`[Ad Rejection] Notified: "${adName}" from ${accountName}`);
      }
    } catch (err) {
      console.error(`[Ad Rejection] Error checking ${accountId}:`, err.message);
    }
  }

  console.log(`[Ad Rejection] Checked ${totalChecked} rejected ads, ${newRejections} new notifications sent`);
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

// ── Auto-check every 5 minutes ─────────────────────────────────────
setTimeout(() => {
  checkRejectedAds().catch(err => console.warn('[Ad Rejection] Initial check error:', err.message));
  setInterval(() => checkRejectedAds().catch(() => {}), 5 * 60 * 1000);
}, 45_000); // Start 45s after boot (after other init tasks)

export default router;
