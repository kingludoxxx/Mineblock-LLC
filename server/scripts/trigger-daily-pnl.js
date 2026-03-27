#!/usr/bin/env node
/**
 * Render Cron Job: Triggers the Daily P&L report.
 * Wakes the server, then calls the /cron/daily-pnl endpoint directly.
 * Scheduled at 23:30 UTC (00:30 CET) — after the Shopify day ends at midnight CET.
 */

const BASE = process.env.RENDER_EXTERNAL_URL || 'https://mineblock-dashboard.onrender.com';
const CRON_SECRET = process.env.CRON_SECRET || '';

async function main() {
  // Step 1: Wake the server (Render free tier may be sleeping)
  console.log(`[cron] Waking server at ${BASE}...`);
  for (let attempt = 1; attempt <= 3; attempt++) {
    try {
      const res = await fetch(`${BASE}/api/v1/kpi-system/health`);
      console.log(`[cron] Server awake (attempt ${attempt}): ${res.status}`);
      break;
    } catch (err) {
      console.log(`[cron] Attempt ${attempt} failed: ${err.message}`);
      if (attempt < 3) await new Promise(r => setTimeout(r, 15000));
    }
  }

  // Step 2: Wait for DB connections to settle
  console.log('[cron] Waiting 30s for DB to settle...');
  await new Promise(r => setTimeout(r, 30000));

  // Step 3: Call the daily P&L endpoint directly
  if (!CRON_SECRET) {
    console.error('[cron] CRON_SECRET not set — cannot trigger P&L');
    process.exit(1);
  }

  console.log('[cron] Triggering Daily P&L report...');
  try {
    const res = await fetch(`${BASE}/api/v1/kpi-system/cron/daily-pnl?secret=${encodeURIComponent(CRON_SECRET)}`);
    const data = await res.json();
    console.log(`[cron] Result: ${res.status}`, JSON.stringify(data));
  } catch (err) {
    console.error(`[cron] P&L trigger failed: ${err.message}`);
    process.exit(1);
  }

  console.log('[cron] Done.');
}

main();
