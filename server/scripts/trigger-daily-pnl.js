#!/usr/bin/env node
/**
 * Render Cron Job: Triggers the Daily P&L report.
 * Wakes the server, then calls the /cron/daily-pnl endpoint directly.
 *
 * SCHEDULE: 08:30 UTC (10:30 Berlin CEST / 09:30 CET). Moved from the
 * previous 23:30 UTC slot so the Slack message captures the full Amazon
 * PST day (closes 07:00 UTC summer / 08:00 UTC winter). The legacy
 * 23:30 UTC cron service still exists in Render until it can be deleted
 * via the dashboard — this script no-ops itself if fired in that slot.
 *
 * RELIABILITY: Retries the P&L endpoint itself (not just the health check)
 * to handle cases where the server is mid-deploy or DB isn't ready.
 */

const BASE = process.env.RENDER_EXTERNAL_URL || 'https://mineblock-dashboard.onrender.com';
const CRON_SECRET = process.env.CRON_SECRET || '';

// Suppress the legacy 23:30 UTC fire. Daily P&L now runs at 08:30 UTC so
// Amazon's PST day is fully closed before the message is generated.
// Exits cleanly (exit 0) so Render doesn't email a cron-failed alert.
const utcHour = new Date().getUTCHours();
if (utcHour === 22 || utcHour === 23) {
  console.log(`[cron] Suppressed at ${utcHour}:xx UTC — daily P&L now fires at 08:30 UTC for full Amazon data. Delete this cron in the Render dashboard to clean up.`);
  process.exit(0);
}

if (!CRON_SECRET) {
  console.error('[cron] CRON_SECRET not set — cannot trigger P&L');
  process.exit(1);
}

async function sleep(ms) {
  return new Promise(r => setTimeout(r, ms));
}

async function wakeServer() {
  for (let attempt = 1; attempt <= 5; attempt++) {
    try {
      const res = await fetch(`${BASE}/api/health`);
      if (res.ok) {
        console.log(`[cron] Server awake (attempt ${attempt})`);
        return true;
      }
      console.log(`[cron] Wake attempt ${attempt}: HTTP ${res.status}`);
    } catch (err) {
      console.log(`[cron] Wake attempt ${attempt}: ${err.message}`);
    }
    await sleep(15000);
  }
  console.log('[cron] Server may still be waking — proceeding anyway');
  return false;
}

async function triggerPnl() {
  const url = `${BASE}/api/v1/kpi-system/cron/daily-pnl?secret=${encodeURIComponent(CRON_SECRET)}`;

  for (let attempt = 1; attempt <= 5; attempt++) {
    try {
      console.log(`[cron] P&L trigger attempt ${attempt}/5...`);
      const res = await fetch(url);
      const data = await res.json().catch(() => ({}));

      if (res.ok && data.success) {
        console.log(`[cron] P&L sent successfully for ${data.date}`);
        return;
      }

      console.error(`[cron] P&L attempt ${attempt}: HTTP ${res.status}`, JSON.stringify(data));
    } catch (err) {
      console.error(`[cron] P&L attempt ${attempt}: ${err.message}`);
    }

    if (attempt < 5) {
      const wait = attempt * 30000; // 30s, 60s, 90s, 120s
      console.log(`[cron] Retrying in ${wait / 1000}s...`);
      await sleep(wait);
    }
  }

  console.error('[cron] FAILED: P&L report not sent after 5 attempts');
  process.exit(1);
}

async function main() {
  console.log(`[cron] Starting Daily P&L trigger at ${new Date().toISOString()}`);

  await wakeServer();
  await sleep(10000); // 10s for DB to settle

  await triggerPnl();

  console.log('[cron] Done.');
}

main();
