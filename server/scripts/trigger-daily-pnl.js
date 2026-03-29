#!/usr/bin/env node
/**
 * Render Cron Job: Triggers the Daily P&L report.
 * Wakes the server, then calls the /cron/daily-pnl endpoint directly.
 * Scheduled at 23:30 UTC (00:30 CET) — after the Shopify day ends at midnight CET.
 *
 * RELIABILITY: Retries the P&L endpoint itself (not just the health check)
 * to handle cases where the server is mid-deploy or DB isn't ready.
 */

const BASE = process.env.RENDER_EXTERNAL_URL || 'https://mineblock-dashboard.onrender.com';
const CRON_SECRET = process.env.CRON_SECRET || '';

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
