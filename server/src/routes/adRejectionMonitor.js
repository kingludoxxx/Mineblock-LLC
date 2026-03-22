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

function shuffleArray(arr) {
  const a = [...arr];
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
}

async function fetchAdsForAccount(accountId) {
  const url = `${META_GRAPH_URL}/${accountId}/ads?fields=name,effective_status,configured_status,adset{configured_status},campaign{configured_status}&effective_status=["DISAPPROVED","WITH_ISSUES"]&limit=100&access_token=${META_ACCESS_TOKEN}`;
  const resp = await fetch(url);
  return resp.json();
}

async function processAdsForAccount(accountId, accountName) {
  const data = await fetchAdsForAccount(accountId);

  if (data.error) {
    const isRateLimit = data.error.code === 17 || data.error.code === 4 ||
      (data.error.message && data.error.message.includes('request limit'));
    if (isRateLimit) {
      return { success: false, rateLimit: true, accountId };
    }
    console.warn(`[Ad Rejection] Error for ${accountId}:`, data.error.message);
    return { success: false, rateLimit: false, accountId };
  }

  const ads = data.data || [];
  let newRejections = 0;

  for (const ad of ads) {
    const status = ad.effective_status;
    if (status !== 'DISAPPROVED' && status !== 'WITH_ISSUES') continue;

    // Skip ads that are already turned off (paused/archived at any level)
    const adConfig = ad.configured_status;
    const adsetConfig = ad.adset?.configured_status;
    const campaignConfig = ad.campaign?.configured_status;
    if (adConfig === 'PAUSED' || adConfig === 'ARCHIVED' ||
        adsetConfig === 'PAUSED' || adsetConfig === 'ARCHIVED' ||
        campaignConfig === 'PAUSED' || campaignConfig === 'ARCHIVED') {
      continue;
    }

    const existing = await pgQuery(
      'SELECT ad_id FROM ad_rejections_notified WHERE ad_id = $1',
      [ad.id]
    );
    if (existing.length > 0) continue;

    const adName = ad.name || 'Unknown';
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
    console.log(`[Ad Rejection] Notified: "${adName}" [${status}] from ${accountName}`);
  }

  return { success: true, rateLimit: false, accountId, checked: ads.length, newRejections };
}

// ── Core: Check for Rejected Ads ────────────────────────────────────
async function checkRejectedAds() {
  if (!META_ACCESS_TOKEN || META_AD_ACCOUNT_IDS.length === 0) {
    console.warn('[Ad Rejection] No META_ACCESS_TOKEN or META_AD_ACCOUNT_IDS configured');
    return { checked: 0, newRejections: 0 };
  }

  await ensureTable();

  let totalChecked = 0;
  let totalNew = 0;
  let rateLimitedAccounts = [];

  // Randomize order so the same accounts don't always get rate-limited
  const accounts = shuffleArray(META_AD_ACCOUNT_IDS);

  // First pass — 10s delay between each account
  for (let i = 0; i < accounts.length; i++) {
    const accountId = accounts[i];
    if (i > 0) await sleep(10_000);

    const accountName = ACCOUNT_NAMES[accountId] || accountId;
    const result = await processAdsForAccount(accountId, accountName);

    if (result.rateLimit) {
      rateLimitedAccounts.push(accountId);
      console.warn(`[Ad Rejection] Rate-limited: ${accountName}`);
    } else if (result.success) {
      totalChecked += result.checked;
      totalNew += result.newRejections;
    }
  }

  // Retry rate-limited accounts with exponential backoff
  if (rateLimitedAccounts.length > 0) {
    const retryDelays = [120_000, 300_000]; // 2 min, then 5 min

    for (let attempt = 0; attempt < retryDelays.length && rateLimitedAccounts.length > 0; attempt++) {
      const delay = retryDelays[attempt];
      console.log(`[Ad Rejection] ${rateLimitedAccounts.length} accounts rate-limited, retry ${attempt + 1} in ${delay / 1000}s...`);
      await sleep(delay);

      const stillLimited = [];
      for (let i = 0; i < rateLimitedAccounts.length; i++) {
        const accountId = rateLimitedAccounts[i];
        if (i > 0) await sleep(10_000);

        const accountName = ACCOUNT_NAMES[accountId] || accountId;
        const result = await processAdsForAccount(accountId, accountName);

        if (result.rateLimit) {
          stillLimited.push(accountId);
          console.warn(`[Ad Rejection] Still rate-limited (attempt ${attempt + 2}): ${accountName}`);
        } else if (result.success) {
          totalChecked += result.checked;
          totalNew += result.newRejections;
          console.log(`[Ad Rejection] Retry success: ${accountName}`);
        }
      }
      rateLimitedAccounts = stillLimited;
    }

    if (rateLimitedAccounts.length > 0) {
      const names = rateLimitedAccounts.map(id => ACCOUNT_NAMES[id] || id).join(', ');
      console.error(`[Ad Rejection] FAILED after all retries: ${names}`);
    }
  }

  console.log(`[Ad Rejection] Done — checked ${totalChecked} ads, ${totalNew} new notifications`);
  return { checked: totalChecked, newRejections: totalNew };
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
}, 10 * 60 * 1000);

// ── Poll every 10 minutes with staggered account checks ────────────
// Webhook (metaWebhook.js) handles real-time; this is the safety net
setTimeout(() => {
  checkRejectedAds().catch(err => console.warn('[Ad Rejection] Initial check error:', err.message));
  setInterval(() => checkRejectedAds().catch(() => {}), 10 * 60 * 1000);
}, 45_000);

export default router;
