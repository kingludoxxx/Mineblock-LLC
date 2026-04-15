#!/usr/bin/env node
/**
 * Render Cron Job: Frame.io health + stray monitoring.
 *
 * Hits both `/frameio-oauth-health` and `/frameio-stray-check` on the
 * mineblock-dashboard service. Either endpoint is expected to post a
 * Slack alert directly when it detects a problem, but we also exit
 * non-zero here so Render's built-in cron-failure email fires as a
 * second alerting layer.
 *
 * Intended schedule: once per day (e.g. "0 7 * * *" — 07:00 UTC).
 */

const BASE = process.env.RENDER_EXTERNAL_URL || 'https://mineblock-dashboard.onrender.com';

async function sleep(ms) {
  return new Promise(r => setTimeout(r, ms));
}

async function wakeServer() {
  for (let attempt = 1; attempt <= 5; attempt++) {
    try {
      const res = await fetch(`${BASE}/api/health`);
      if (res.ok) {
        console.log(`[frameio-health] Server awake (attempt ${attempt})`);
        return true;
      }
      console.log(`[frameio-health] Wake attempt ${attempt}: HTTP ${res.status}`);
    } catch (err) {
      console.log(`[frameio-health] Wake attempt ${attempt}: ${err.message}`);
    }
    await sleep(15000);
  }
  console.log('[frameio-health] Server may still be waking — proceeding anyway');
  return false;
}

async function checkEndpoint(path, expectedCode = 200) {
  const url = `${BASE}${path}`;
  for (let attempt = 1; attempt <= 3; attempt++) {
    try {
      console.log(`[frameio-health] GET ${path} (attempt ${attempt}/3)`);
      const res = await fetch(url);
      const body = await res.json().catch(() => ({}));
      console.log(`[frameio-health]   → HTTP ${res.status} ${JSON.stringify(body).slice(0, 200)}`);
      if (res.status === expectedCode) return { ok: true, body };
      // 409 from stray-check or 503 from oauth-health both indicate a real
      // problem that the endpoint already Slacked about — fail the cron.
      return { ok: false, status: res.status, body };
    } catch (err) {
      console.error(`[frameio-health]   → fetch error: ${err.message}`);
      if (attempt === 3) return { ok: false, error: err.message };
      await sleep(30000);
    }
  }
  return { ok: false };
}

async function main() {
  console.log(`[frameio-health] Starting at ${new Date().toISOString()}`);
  await wakeServer();
  await sleep(5000); // 5s for DB to settle

  const oauth = await checkEndpoint('/api/v1/webhook/frameio-oauth-health', 200);
  const stray = await checkEndpoint('/api/v1/webhook/frameio-stray-check', 200);

  const failed = [];
  if (!oauth.ok) failed.push('oauth-health');
  if (!stray.ok) failed.push('stray-check');

  if (failed.length > 0) {
    console.error(`[frameio-health] FAILED: ${failed.join(', ')} — Slack alert already posted by endpoint.`);
    process.exit(1);
  }

  console.log('[frameio-health] All checks passed.');
}

main().catch(err => {
  console.error('[frameio-health] Fatal:', err);
  process.exit(1);
});
