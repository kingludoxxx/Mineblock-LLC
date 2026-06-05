#!/usr/bin/env node
/**
 * Render Cron Job: Daily P&L Watchdog
 *
 * SCHEDULE: ≥ 09:00 UTC, i.e. AFTER the daily-pnl-morning cron at 08:30 UTC.
 * Running earlier (the legacy 01:00 UTC slot) created a race: the watchdog
 * saw "no ledger row for yesterday yet" and force-sent the report — but at
 * 01:00 UTC, Amazon's PST day hadn't closed yet (closes 07:00 UTC), so the
 * force-send went out without the Amazon block, and then dedup blocked the
 * legitimate 08:30 UTC morning send.
 *
 * Calls /cron/pnl-watchdog which:
 *   1. Checks the daily_pnl_reports ledger for yesterday's row.
 *   2. If present → OK, exits 0.
 *   3. If missing → force-triggers sendDailyPnlReport.
 *   4. If still missing → posts a loud Slack alert + returns 500.
 *
 * This is the lock-in: it catches ANY failure mode in the main cron
 * (auth bug, Slack token expired, DB snapshot missing, code crash, etc.)
 * and either self-heals or alerts the team loud enough to fix same-day.
 */

const BASE = process.env.RENDER_EXTERNAL_URL || 'https://mineblock-dashboard.onrender.com';
const CRON_SECRET = process.env.CRON_SECRET || '';

// Time-gate: legacy cron service still fires at 01:00 UTC. If we ran at that
// time we'd pre-empt the 08:30 UTC daily-pnl-morning cron (Amazon's PST day
// not yet closed). Skip cleanly until UTC hour ≥ 9 — a parallel watchdog
// cron at 09:00 UTC handles the real check.
const utcHour = new Date().getUTCHours();
if (utcHour < 9) {
  console.log(`[watchdog] Suppressed at ${utcHour}:xx UTC — watchdog moved to ≥09:00 UTC so Amazon PST day is closed before checking. Delete the legacy 01:00 UTC cron in the Render dashboard to clean up.`);
  process.exit(0);
}

if (!CRON_SECRET) {
  console.error('[watchdog] CRON_SECRET not set — cannot check P&L');
  process.exit(1);
}

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

async function wakeServer() {
  for (let i = 1; i <= 5; i++) {
    try {
      const res = await fetch(`${BASE}/api/health`);
      if (res.ok) {
        console.log(`[watchdog] Server awake (attempt ${i})`);
        return true;
      }
      console.log(`[watchdog] Wake attempt ${i}: HTTP ${res.status}`);
    } catch (err) {
      console.log(`[watchdog] Wake attempt ${i}: ${err.message}`);
    }
    await sleep(15000);
  }
  console.log('[watchdog] Server still waking — proceeding anyway');
  return false;
}

async function runWatchdog() {
  const url = `${BASE}/api/v1/kpi-system/cron/pnl-watchdog?secret=${encodeURIComponent(CRON_SECRET)}`;

  for (let attempt = 1; attempt <= 3; attempt++) {
    try {
      console.log(`[watchdog] Check attempt ${attempt}/3...`);
      const res = await fetch(url);
      const data = await res.json().catch(() => ({}));

      if (res.ok && data.ok) {
        console.log(`[watchdog] OK for ${data.date} (action: ${data.action})`);
        return;
      }

      console.error(`[watchdog] Attempt ${attempt}: HTTP ${res.status}`, JSON.stringify(data));
    } catch (err) {
      console.error(`[watchdog] Attempt ${attempt}: ${err.message}`);
    }

    if (attempt < 3) {
      const wait = attempt * 60000; // 60s, 120s
      console.log(`[watchdog] Retrying in ${wait / 1000}s...`);
      await sleep(wait);
    }
  }

  console.error('[watchdog] FAILED — P&L missing after 3 attempts. Server-side alert should have fired.');
  process.exit(1);
}

async function main() {
  console.log(`[watchdog] Starting P&L watchdog at ${new Date().toISOString()}`);
  await wakeServer();
  await sleep(5000);
  await runWatchdog();
  console.log('[watchdog] Done.');
}

main();
