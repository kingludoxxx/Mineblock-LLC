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

// Only active accounts
const ACCOUNT_NAMES = {
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
    return { ok: false };
  }

  const body = {
    channel: SLACK_CHANNEL,
    text,
    username: 'Mineblock Bot',
    icon_url: 'https://i.imgur.com/PJCRE4g.png',
    ...(blocks ? { blocks } : {}),
  };

  try {
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
  } catch (err) {
    console.error('[Ad Rejection] Slack fetch error:', err.message);
    return { ok: false };
  }
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
  if (!resp.ok) {
    throw new Error(`Meta API error for ${accountId}: HTTP ${resp.status} ${resp.statusText}`);
  }
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

    // FIX #1: Only skip ARCHIVED — NOT paused. Meta auto-pauses after rejection.
    const adConfig = ad.configured_status;
    if (adConfig === 'ARCHIVED') continue;

    const adName = ad.name || 'Unknown';

    // FIX #3: Handle re-rejections and status escalations
    const existing = await pgQuery(
      'SELECT ad_id, status FROM ad_rejections_notified WHERE ad_id = $1',
      [ad.id]
    );
    if (existing.length > 0) {
      const oldStatus = existing[0].status;
      // If status escalated (WITH_ISSUES → DISAPPROVED), re-notify
      if (oldStatus === 'WITH_ISSUES' && status === 'DISAPPROVED') {
        await pgQuery('DELETE FROM ad_rejections_notified WHERE ad_id = $1', [ad.id]);
        console.log(`[Ad Rejection] Status escalated for ad ${ad.id}: ${oldStatus} → ${status}`);
      } else {
        continue; // Already notified
      }
    }

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

    const slackResult = await sendSlackMessage(`${statusLabel}: ${adName} (${accountName})`, blocks);

    // Only mark as notified if Slack succeeded — otherwise retry next cycle
    if (slackResult?.ok) {
      await pgQuery(
        'INSERT INTO ad_rejections_notified (ad_id, ad_name, account_id, status) VALUES ($1, $2, $3, $4) ON CONFLICT (ad_id) DO UPDATE SET status = $4, notified_at = NOW()',
        [ad.id, adName, accountId, status]
      );
      newRejections++;
      console.log(`[Ad Rejection] Notified: "${adName}" [${status}] from ${accountName}`);
    } else {
      console.error(`[Ad Rejection] Slack failed for "${adName}" — will retry next cycle`);
    }
  }

  return { success: true, rateLimit: false, accountId, checked: ads.length, newRejections };
}

// ── FIX #3: Clean up resolved rejections ───────────────────────────
// Remove ads from notified table that are no longer rejected (appeal succeeded)
// so if they get re-rejected later, we catch it
async function cleanupResolvedAds() {
  try {
    const notified = await pgQuery('SELECT ad_id, account_id FROM ad_rejections_notified');
    if (notified.length === 0) return 0;

    let cleaned = 0;
    // Check in batches of 50
    for (let i = 0; i < notified.length; i += 50) {
      const batch = notified.slice(i, i + 50);
      const ids = batch.map(r => r.ad_id).join(',');

      try {
        const resp = await fetch(`${META_GRAPH_URL}/?ids=${ids}&fields=effective_status&access_token=${META_ACCESS_TOKEN}`);
        const data = await resp.json();

        for (const row of batch) {
          const adData = data[row.ad_id];
          if (!adData) continue; // Ad deleted or inaccessible

          const currentStatus = adData.effective_status;
          // If ad is no longer rejected (e.g. ACTIVE, PAUSED without issues), remove from tracking
          if (currentStatus !== 'DISAPPROVED' && currentStatus !== 'WITH_ISSUES') {
            await pgQuery('DELETE FROM ad_rejections_notified WHERE ad_id = $1', [row.ad_id]);
            cleaned++;
            console.log(`[Ad Rejection] Cleaned resolved ad ${row.ad_id} (now ${currentStatus})`);
          }
        }
      } catch (err) {
        console.warn(`[Ad Rejection] Cleanup batch error:`, err.message);
      }

      if (i + 50 < notified.length) await sleep(5000); // Rate limit protection
    }

    if (cleaned > 0) console.log(`[Ad Rejection] Cleaned ${cleaned} resolved ads from tracking`);
    return cleaned;
  } catch (err) {
    console.error('[Ad Rejection] Cleanup error:', err.message);
    return 0;
  }
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

// ── FIX #5: Daily summary digest ────────────────────────────────────
async function sendDailySummary() {
  if (!META_ACCESS_TOKEN || META_AD_ACCOUNT_IDS.length === 0) return;

  await ensureTable();

  let totalRejected = 0;
  const accountSummaries = [];

  for (let i = 0; i < META_AD_ACCOUNT_IDS.length; i++) {
    const accountId = META_AD_ACCOUNT_IDS[i];
    if (i > 0) await sleep(5000);

    const accountName = ACCOUNT_NAMES[accountId] || accountId;

    try {
      const data = await fetchAdsForAccount(accountId);
      if (data.error) {
        accountSummaries.push(`*${accountName}:* Error fetching`);
        continue;
      }

      const ads = (data.data || []).filter(ad => ad.configured_status !== 'ARCHIVED');
      const disapproved = ads.filter(a => a.effective_status === 'DISAPPROVED').length;
      const withIssues = ads.filter(a => a.effective_status === 'WITH_ISSUES').length;
      const total = disapproved + withIssues;
      totalRejected += total;

      if (total > 0) {
        accountSummaries.push(`*${accountName}:* ${total} rejected (${disapproved} disapproved, ${withIssues} with issues)`);
      } else {
        accountSummaries.push(`*${accountName}:* All clear`);
      }
    } catch (err) {
      accountSummaries.push(`*${accountName}:* Error — ${err.message}`);
    }
  }

  const emoji = totalRejected === 0 ? ':white_check_mark:' : ':warning:';
  const header = totalRejected === 0
    ? `${emoji} Daily Ad Health: All Clear`
    : `${emoji} Daily Ad Health: ${totalRejected} Rejected Ads`;

  const blocks = [
    { type: 'header', text: { type: 'plain_text', text: header, emoji: true } },
    { type: 'section', text: { type: 'mrkdwn', text: accountSummaries.join('\n') } },
    { type: 'context', elements: [
      { type: 'mrkdwn', text: `_Daily digest — ${new Date().toISOString().slice(0, 10)}_` },
    ]},
    { type: 'divider' },
  ];

  await sendSlackMessage(header, blocks);
  console.log(`[Ad Rejection] Daily summary sent: ${totalRejected} total rejected`);
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
        accounts: META_AD_ACCOUNT_IDS.map(id => ({ id, name: ACCOUNT_NAMES[id] || id })),
      },
    });
  } catch (err) {
    res.status(500).json({ success: false, error: { message: err.message } });
  }
});

/** POST /check-now — Manually trigger a rejection check (also used by cron) */
router.post('/check-now', authenticate, async (req, res) => {
  try {
    const result = await checkRejectedAds();
    res.json({ success: true, data: result });
  } catch (err) {
    res.status(500).json({ success: false, error: { message: err.message } });
  }
});

/** POST /daily-summary — Trigger daily summary (used by cron) */
router.post('/daily-summary', authenticate, async (req, res) => {
  try {
    await sendDailySummary();
    res.json({ success: true, message: 'Daily summary sent' });
  } catch (err) {
    res.status(500).json({ success: false, error: { message: err.message } });
  }
});

/** POST /cleanup — Clean up resolved rejections (used by cron) */
router.post('/cleanup', authenticate, async (req, res) => {
  try {
    const cleaned = await cleanupResolvedAds();
    res.json({ success: true, data: { cleaned } });
  } catch (err) {
    res.status(500).json({ success: false, error: { message: err.message } });
  }
});

// Re-notify: clear an ad from notified list so it gets re-checked
router.post('/re-notify', authenticate, async (req, res) => {
  try {
    await ensureTable();
    const { ad_name } = req.body;
    if (!ad_name) return res.status(400).json({ success: false, error: { message: 'ad_name required' } });
    const deleted = await pgQuery('DELETE FROM ad_rejections_notified WHERE ad_name LIKE $1 RETURNING ad_id', [`%${ad_name}%`]);
    if (deleted.length === 0) return res.json({ success: true, message: 'No matching notifications found' });
    const result = await checkRejectedAds();
    res.json({ success: true, cleared: deleted.length, recheckResult: result });
  } catch (err) {
    res.status(500).json({ success: false, error: { message: err.message } });
  }
});

// ── Keep-alive ping (prevents Render free tier from sleeping) ──────
const RENDER_URL = process.env.RENDER_EXTERNAL_URL || 'https://mineblock-dashboard.onrender.com';
setInterval(async () => {
  try { await fetch(`${RENDER_URL}/api/health`); } catch {}
}, 5 * 60 * 1000); // FIX #4: Every 5 min instead of 10 to prevent sleep

// ── Poll every 10 minutes with staggered account checks ────────────
// Webhook (metaWebhook.js) handles real-time; this is the safety net
setTimeout(() => {
  checkRejectedAds().catch(err => console.warn('[Ad Rejection] Initial check error:', err.message));
  setInterval(() => checkRejectedAds().catch(() => {}), 10 * 60 * 1000);
}, 45_000);

// ── FIX #3: Clean up resolved ads every hour ────────────────────────
setTimeout(() => {
  setInterval(() => cleanupResolvedAds().catch(() => {}), 60 * 60 * 1000);
}, 120_000); // Start 2 min after boot

// ── FIX #5: Daily summary at 9:00 AM EST ────────────────────────────
function scheduleDailySummary() {
  const now = new Date();
  const est = new Date(now.toLocaleString('en-US', { timeZone: 'America/New_York' }));
  const target = new Date(est);
  target.setHours(9, 0, 0, 0);

  // If already past 9 AM today, schedule for tomorrow
  if (est >= target) target.setDate(target.getDate() + 1);

  const msUntil = target.getTime() - est.getTime();
  console.log(`[Ad Rejection] Daily summary scheduled in ${Math.round(msUntil / 60000)} minutes`);

  setTimeout(() => {
    sendDailySummary().catch(err => console.error('[Ad Rejection] Daily summary error:', err.message));
    // Then repeat every 24 hours
    setInterval(() => {
      sendDailySummary().catch(err => console.error('[Ad Rejection] Daily summary error:', err.message));
    }, 24 * 60 * 60 * 1000);
  }, msUntil);
}

scheduleDailySummary();

export default router;
