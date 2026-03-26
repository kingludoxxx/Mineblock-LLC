#!/usr/bin/env node
// Render Cron Job: pings the server to wake it up.
// The server's catch-up mechanism then checks if yesterday's
// Daily P&L report was sent to Slack — if not, it sends it.

const BASE = process.env.RENDER_EXTERNAL_URL || 'https://mineblock-dashboard.onrender.com';

async function main() {
  console.log(`[cron] Pinging ${BASE} to wake server...`);
  try {
    const res = await fetch(`${BASE}/api/v1/kpi-system/health`);
    console.log(`[cron] Server responded: ${res.status}`);
  } catch (err) {
    console.log(`[cron] First ping failed (server cold start), retrying in 30s...`);
    await new Promise(r => setTimeout(r, 30000));
    try {
      const res = await fetch(`${BASE}/api/v1/kpi-system/health`);
      console.log(`[cron] Retry responded: ${res.status}`);
    } catch (err2) {
      console.error(`[cron] Retry also failed:`, err2.message);
    }
  }

  // Wait 2 minutes for the server's catch-up to fire (runs 90s after boot)
  console.log('[cron] Waiting 120s for catch-up mechanism...');
  await new Promise(r => setTimeout(r, 120000));

  // Ping once more to confirm server is still alive
  try {
    const res = await fetch(`${BASE}/api/v1/kpi-system/health`);
    console.log(`[cron] Final check: ${res.status}`);
  } catch {}

  console.log('[cron] Done.');
}

main();
