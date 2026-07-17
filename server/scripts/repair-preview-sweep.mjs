#!/usr/bin/env node
/**
 * Daily preview-repair sweep — the "defense in depth" layer for the
 * broken-previews forever-fix.
 *
 * Phase 1 of that fix closed every known ingress leak (mirror at import
 * time, guard blocks volatile writes, backsync scans references + fbcdn).
 * This cron is the safety net that catches any future regression:
 *
 *   1. POST /api/v1/statics-generation/repair-volatile-urls (limit=2000)
 *      Sweeps any spy_creatives row with a volatile image_url — kie.ai,
 *      tempfile.aiquickdraw, /tmp-img/, AND fbcdn/fbsbx/scontent (added
 *      in Phase 1). Rescues live URLs to R2; marks dead ones rejected.
 *
 *   2. POST /api/v1/statics-generation/repair-thumbnails
 *      Sweeps launched creatives where the Meta CDN URL has stale-rotated.
 *      Calls Meta Graph for a fresh URL, mirrors to R2.
 *
 * Env vars:
 *   RENDER_EXTERNAL_URL  target host (auto-set by Render)
 *   CRON_SECRET          bypasses auth for these endpoints
 *   SLACK_WEBHOOK_URL    optional — posts a summary if any row was rescued
 *
 * Exit codes: 0 always (a bad-URL rescue attempt shouldn't page anyone).
 */

const HOST = process.env.RENDER_EXTERNAL_URL || 'https://mineblock-dashboard.onrender.com';
const SECRET = process.env.CRON_SECRET;
const SLACK = process.env.SLACK_WEBHOOK_URL;

if (!SECRET) {
  console.error('[repair-sweep] CRON_SECRET not set — cannot bypass auth. Exiting cleanly.');
  process.exit(0);
}

async function post(pathname, body = {}) {
  const url = `${HOST}${pathname}`;
  const startedAt = Date.now();
  try {
    const r = await fetch(url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-Cron-Secret': SECRET,
      },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(180_000), // 3 min per call
    });
    const elapsed = Date.now() - startedAt;
    const text = await r.text();
    let json = null;
    try { json = JSON.parse(text); } catch { /* keep as text */ }
    if (!r.ok) {
      console.warn(`[repair-sweep] ${pathname} → ${r.status} in ${elapsed}ms: ${text.slice(0, 300)}`);
      return { ok: false, status: r.status, body: json || text };
    }
    console.log(`[repair-sweep] ${pathname} → ${r.status} in ${elapsed}ms: ${JSON.stringify(json?.data || json).slice(0, 400)}`);
    return { ok: true, body: json?.data || json };
  } catch (err) {
    console.error(`[repair-sweep] ${pathname} threw: ${err.message}`);
    return { ok: false, err: err.message };
  }
}

async function slack(text) {
  if (!SLACK) return;
  try {
    await fetch(SLACK, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ text }),
      signal: AbortSignal.timeout(10_000),
    });
  } catch (err) {
    console.warn(`[repair-sweep] slack post failed: ${err.message}`);
  }
}

async function main() {
  console.log(`[repair-sweep] START at ${new Date().toISOString()} → ${HOST}`);

  const rescue = await post('/api/v1/statics-generation/repair-volatile-urls', { limit: 2000 });
  const launched = await post('/api/v1/statics-generation/repair-thumbnails', {});

  // Aggregate a one-line summary for Slack if anything moved. Silence
  // is golden — no notification when the sweep found nothing to fix.
  const rescueBody = rescue.ok ? rescue.body : null;
  const launchedBody = launched.ok ? launched.body : null;
  const rescuedCount = (rescueBody?.rescued_r2 || 0) + (rescueBody?.rescued_from_image_store || 0);
  const rejectedCount = rescueBody?.marked_rejected || 0;
  const launchedRepaired = launchedBody?.repaired || 0;

  const anyMovement = rescuedCount > 0 || rejectedCount > 0 || launchedRepaired > 0;
  if (anyMovement) {
    const summary =
      `[repair-sweep daily] ` +
      `rescued=${rescuedCount} rejected=${rejectedCount} launched-repaired=${launchedRepaired}` +
      (rescueBody?.errors ? ` errors=${rescueBody.errors}` : '');
    console.log(summary);
    await slack(`🩹 ${summary}`);
  } else {
    console.log(`[repair-sweep] no rows needed rescue — table is clean`);
  }

  console.log(`[repair-sweep] DONE at ${new Date().toISOString()}`);
  process.exit(0);
}

main().catch((err) => {
  console.error(`[repair-sweep] FATAL: ${err.message}`);
  process.exit(0); // never fail the cron
});
