import { Router } from 'express';
import { pgQuery } from '../db/pg.js';

const router = Router();

// ── Config ──────────────────────────────────────────────────────────
const META_ACCESS_TOKEN = process.env.META_ACCESS_TOKEN || '';
const META_GRAPH_URL = 'https://graph.facebook.com/v21.0';
const META_WEBHOOK_VERIFY_TOKEN = process.env.META_WEBHOOK_VERIFY_TOKEN || '';
const SLACK_BOT_TOKEN = process.env.SLACK_BOT_TOKEN || '';
const SLACK_CHANNEL = process.env.SLACK_REJECTION_CHANNEL || '';

const ACCOUNT_NAMES = {
  'act_938489175321542': 'Mineblock X8',
  'act_1972517213693373': 'Mineblock CC 4',
  'act_1238893338181787': 'Mineblock CC 5',
  'act_25781501541499027': 'Mineblock X6',
  'act_1363888491879561': 'Luvora CC',
  'act_1417689703203647': 'Luvora CC 2',
  'act_642819725560039': 'Luvora CC 3',
};

// ── DB ──────────────────────────────────────────────────────────────
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
  await pgQuery(`ALTER TABLE ad_rejections_notified ADD COLUMN IF NOT EXISTS status TEXT DEFAULT 'DISAPPROVED'`).catch(() => {});
  tableReady = true;
}

// ── Slack Helper ────────────────────────────────────────────────────
async function sendSlackMessage(text, blocks) {
  if (!SLACK_BOT_TOKEN || !SLACK_CHANNEL) return;
  const body = {
    channel: SLACK_CHANNEL,
    text,
    username: 'Mineblock Bot',
    icon_url: 'https://i.imgur.com/PJCRE4g.png',
    ...(blocks ? { blocks } : {}),
  };
  const resp = await fetch('https://slack.com/api/chat.postMessage', {
    method: 'POST',
    headers: { 'Authorization': `Bearer ${SLACK_BOT_TOKEN}`, 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  const data = await resp.json();
  if (!data.ok) console.error('[Meta Webhook] Slack error:', data.error);
}

// ── GET: Webhook Verification ───────────────────────────────────────
router.get('/', (req, res) => {
  const mode = req.query['hub.mode'];
  const token = req.query['hub.verify_token'];
  const challenge = req.query['hub.challenge'];

  if (mode === 'subscribe' && token === META_WEBHOOK_VERIFY_TOKEN) {
    console.log('[Meta Webhook] Verification successful');
    return res.status(200).send(challenge);
  }

  console.warn('[Meta Webhook] Verification failed — invalid token');
  return res.sendStatus(403);
});

// ── POST: Webhook Event Handler ─────────────────────────────────────
router.post('/', async (req, res) => {
  // Always respond 200 immediately so Meta doesn't retry
  res.sendStatus(200);

  try {
    const body = req.body;
    if (body.object !== 'ad_account') return;

    console.log('[Meta Webhook] Received event:', JSON.stringify(body).slice(0, 500));

    await ensureTable();

    for (const entry of (body.entry || [])) {
      const accountId = entry.id ? `act_${entry.id}` : null;
      const changes = entry.changes || [];

      for (const change of changes) {
        // Handle with_issues_ad_objects — fires when ads get WITH_ISSUES status
        if (change.field === 'with_issues_ad_objects') {
          const value = change.value || {};
          const adIds = value.ad_ids || value.ads || [];
          const level = value.object_level; // AD, AD_SET, CAMPAIGN

          // Only process ad-level issues
          if (level && level !== 'AD' && adIds.length === 0) continue;

          // If we get ad IDs directly, process them
          if (adIds.length > 0) {
            await processRejectedAdIds(adIds, accountId);
          } else {
            // If no ad IDs provided, fetch current WITH_ISSUES ads for this account
            if (accountId) {
              await fetchAndNotifyAccount(accountId);
            }
          }
        }

        // Handle in_process_ad_objects — can also indicate rejection after review
        if (change.field === 'in_process_ad_objects') {
          const value = change.value || {};
          if (value.status === 'WITH_ISSUES' || value.status === 'DISAPPROVED') {
            const adIds = value.ad_ids || [];
            if (adIds.length > 0) {
              await processRejectedAdIds(adIds, accountId);
            } else if (accountId) {
              await fetchAndNotifyAccount(accountId);
            }
          }
        }
      }
    }
  } catch (err) {
    console.error('[Meta Webhook] Error processing event:', err.message);
  }
});

// ── Process specific ad IDs ─────────────────────────────────────────
async function processRejectedAdIds(adIds, accountId) {
  for (const adId of adIds) {
    try {
      // Check if already notified
      const existing = await pgQuery('SELECT ad_id FROM ad_rejections_notified WHERE ad_id = $1', [String(adId)]);
      if (existing.length > 0) continue;

      // Fetch ad details
      const resp = await fetch(`${META_GRAPH_URL}/${adId}?fields=name,effective_status,account_id&access_token=${META_ACCESS_TOKEN}`);
      const ad = await resp.json();

      if (ad.error) {
        console.warn(`[Meta Webhook] Error fetching ad ${adId}:`, ad.error.message);
        continue;
      }

      const status = ad.effective_status;
      if (status !== 'DISAPPROVED' && status !== 'WITH_ISSUES') continue;

      const resolvedAccountId = accountId || (ad.account_id ? `act_${ad.account_id}` : 'unknown');
      const accountName = ACCOUNT_NAMES[resolvedAccountId] || resolvedAccountId;
      const adName = ad.name || 'Unknown';

      await sendRejectionNotification(adId, adName, accountName, status, resolvedAccountId);
    } catch (err) {
      console.error(`[Meta Webhook] Error processing ad ${adId}:`, err.message);
    }
  }
}

// ── Fetch and notify for an account ─────────────────────────────────
async function fetchAndNotifyAccount(accountId) {
  try {
    const url = `${META_GRAPH_URL}/${accountId}/ads?fields=name,effective_status&effective_status=["DISAPPROVED","WITH_ISSUES"]&limit=100&access_token=${META_ACCESS_TOKEN}`;
    const resp = await fetch(url);
    const data = await resp.json();

    if (data.error) {
      console.warn(`[Meta Webhook] Error fetching ads for ${accountId}:`, data.error.message);
      return;
    }

    const accountName = ACCOUNT_NAMES[accountId] || accountId;

    for (const ad of (data.data || [])) {
      const existing = await pgQuery('SELECT ad_id FROM ad_rejections_notified WHERE ad_id = $1', [ad.id]);
      if (existing.length > 0) continue;

      await sendRejectionNotification(ad.id, ad.name, accountName, ad.effective_status, accountId);
    }
  } catch (err) {
    console.error(`[Meta Webhook] Error fetching account ${accountId}:`, err.message);
  }
}

// ── Send rejection notification ─────────────────────────────────────
async function sendRejectionNotification(adId, adName, accountName, status, accountId) {
  const statusLabel = status === 'WITH_ISSUES' ? 'Ad Rejected (With Issues)' : 'Ad Rejected';

  const blocks = [
    { type: 'header', text: { type: 'plain_text', text: `:no_entry: ${statusLabel}`, emoji: true } },
    { type: 'section', fields: [
      { type: 'mrkdwn', text: `*Ad Name:*\n${adName}` },
      { type: 'mrkdwn', text: `*Ad Account:*\n${accountName}` },
    ]},
    { type: 'section', fields: [
      { type: 'mrkdwn', text: `*Ad ID:*\n\`${adId}\`` },
      { type: 'mrkdwn', text: `*Status:*\n${status}` },
    ]},
    { type: 'context', elements: [
      { type: 'mrkdwn', text: ':zap: _Real-time webhook notification_' },
    ]},
    { type: 'divider' },
  ];

  await sendSlackMessage(`${statusLabel}: ${adName} (${accountName})`, blocks);

  await pgQuery(
    'INSERT INTO ad_rejections_notified (ad_id, ad_name, account_id, status) VALUES ($1, $2, $3, $4) ON CONFLICT (ad_id) DO NOTHING',
    [String(adId), adName, accountId, status]
  );

  console.log(`[Meta Webhook] Notified: "${adName}" [${status}] from ${accountName}`);
}

export default router;
