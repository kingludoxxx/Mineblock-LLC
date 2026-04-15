#!/usr/bin/env node
/**
 * audit_rejections.js
 * Queries all Meta ad accounts for DISAPPROVED / WITH_ISSUES ads,
 * queries the production DB (via the dashboard API) for notified ads,
 * compares and reports gaps.
 */

import { readFileSync } from 'fs';
import { resolve, dirname } from 'path';
import { fileURLToPath } from 'url';

// ── Load .env manually ──────────────────────────────────────────────
const __dirname = dirname(fileURLToPath(import.meta.url));
const envPath = resolve(__dirname, '..', '.env');
let envVars;
try {
  envVars = Object.fromEntries(
    readFileSync(envPath, 'utf-8')
      .split('\n')
      .filter(l => l.trim() && !l.startsWith('#'))
      .map(l => {
        const idx = l.indexOf('=');
        return [l.slice(0, idx).trim(), l.slice(idx + 1).trim()];
      })
  );
} catch (err) {
  console.error(`FATAL: Cannot read .env at ${envPath}: ${err.message}`);
  process.exit(1);
}

const META_ACCESS_TOKEN = envVars.META_ACCESS_TOKEN;
if (!META_ACCESS_TOKEN) { console.error('FATAL: META_ACCESS_TOKEN not found in .env'); process.exit(1); }

// ── Ad accounts ─────────────────────────────────────────────────────
const ACCOUNTS = [
  { id: 'act_938489175321542',    name: 'Mineblock X8' },
  { id: 'act_1972517213693373',   name: 'Mineblock CC 4' },
  { id: 'act_1238893338181787',   name: 'Mineblock CC 5' },
  { id: 'act_25781501541499027',  name: 'Mineblock X6' },
  { id: 'act_1363888491879561',   name: 'Luvora CC' },
  { id: 'act_1417689703203647',   name: 'Luvora CC 2' },
  { id: 'act_642819725560039',    name: 'Luvora CC 3' },
];

const API_VERSION = 'v21.0';
const PROD_BASE = 'https://mineblock-dashboard.onrender.com';

// ── Fetch rejected ads from one Meta account ────────────────────────
async function fetchRejectedAds(accountId) {
  const url = new URL(`https://graph.facebook.com/${API_VERSION}/${accountId}/ads`);
  url.searchParams.set('fields', 'id,name,effective_status,status,configured_status');
  url.searchParams.set('filtering', JSON.stringify([
    { field: 'effective_status', operator: 'IN', value: ['DISAPPROVED', 'WITH_ISSUES'] }
  ]));
  url.searchParams.set('limit', '500');
  url.searchParams.set('access_token', META_ACCESS_TOKEN);

  const resp = await fetch(url.toString());
  if (!resp.ok) {
    const body = await resp.text();
    throw new Error(`Meta API ${resp.status} for ${accountId}: ${body}`);
  }
  const json = await resp.json();
  return json.data || [];
}

// ── Login to prod dashboard ─────────────────────────────────────────
async function loginToProd() {
  const resp = await fetch(`${PROD_BASE}/api/auth/login`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      email: envVars.SUPERADMIN_EMAIL,
      password: envVars.SUPERADMIN_PASSWORD,
    }),
  });
  if (!resp.ok) throw new Error(`Login failed: ${resp.status}`);
  const data = await resp.json();
  if (!data.accessToken) throw new Error('No accessToken in login response');
  return data.accessToken;
}

// ── Get notified count from prod ────────────────────────────────────
async function getNotifiedStatus(token) {
  const resp = await fetch(`${PROD_BASE}/api/v1/ad-rejection-monitor/status`, {
    headers: {
      'Authorization': `Bearer ${token}`,
      'Cookie': `accessToken=${token}`,
    },
  });
  if (!resp.ok) throw new Error(`Status endpoint: ${resp.status}`);
  return resp.json();
}

// ── Trigger check-now on prod (syncs Meta -> DB) ────────────────────
async function triggerCheckNow(token) {
  const resp = await fetch(`${PROD_BASE}/api/v1/ad-rejection-monitor/check-now`, {
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${token}`,
      'Cookie': `accessToken=${token}`,
    },
  });
  if (!resp.ok) throw new Error(`Check-now endpoint: ${resp.status}`);
  return resp.json();
}

// ── Main ────────────────────────────────────────────────────────────
async function main() {
  const killTimer = setTimeout(() => {
    console.error('FATAL: Script timed out after 90s');
    process.exit(1);
  }, 90_000);
  killTimer.unref();

  console.log('\n=== AD REJECTION AUDIT ===');
  console.log(`Date: ${new Date().toISOString()}\n`);

  // 1. Login and get DB status
  let token = null;
  let dbNotifiedCount = 0;
  console.log('Step 1: Querying production database via dashboard API...');
  try {
    token = await loginToProd();
    const statusData = await getNotifiedStatus(token);
    dbNotifiedCount = statusData.data?.totalNotified || 0;
    console.log(`  Total notified in ad_rejections_notified: ${dbNotifiedCount}`);
    console.log(`  Slack configured: ${statusData.data?.slackConfigured}`);
    console.log(`  Meta configured: ${statusData.data?.metaConfigured}`);
    console.log(`  Accounts configured: ${statusData.data?.accountCount}\n`);
  } catch (err) {
    console.error(`  Dashboard API error: ${err.message}\n`);
  }

  // 2. Query each Meta ad account directly
  console.log('Step 2: Querying Meta Graph API for rejected/with-issues ads...\n');
  let totalRejected = 0;
  const allRejected = [];
  const perAccount = [];

  for (const acct of ACCOUNTS) {
    let ads;
    try {
      ads = await fetchRejectedAds(acct.id);
    } catch (err) {
      console.log(`[${acct.name}] ERROR: ${err.message}\n`);
      perAccount.push({ acct, ads: [], error: err.message });
      continue;
    }
    totalRejected += ads.length;
    perAccount.push({ acct, ads });

    console.log(`[${acct.name}] (${acct.id})`);
    console.log(`  Rejected/With Issues: ${ads.length}`);
    if (ads.length > 0) {
      const disapproved = ads.filter(a => a.effective_status === 'DISAPPROVED');
      const withIssues = ads.filter(a => a.effective_status === 'WITH_ISSUES');
      if (disapproved.length) console.log(`    DISAPPROVED: ${disapproved.length}`);
      if (withIssues.length)  console.log(`    WITH_ISSUES: ${withIssues.length}`);
      for (const ad of ads) {
        console.log(`    - ${ad.id}  "${ad.name}"  (${ad.effective_status})`);
        allRejected.push({ ...ad, accountName: acct.name, accountId: acct.id });
      }
    }
    console.log('');
  }

  // 3. Trigger check-now to sync any missed ads
  if (token) {
    console.log('Step 3: Triggering check-now on production to sync missed ads...');
    try {
      const checkResult = await triggerCheckNow(token);
      const d = checkResult.data || {};
      console.log(`  Checked: ${d.checked || 0} ads`);
      console.log(`  New notifications sent: ${d.newRejections || 0}\n`);

      // Re-query status to get updated count
      const updatedStatus = await getNotifiedStatus(token);
      const newCount = updatedStatus.data?.totalNotified || 0;
      console.log(`  Updated notified count: ${newCount} (was ${dbNotifiedCount})`);
      if (newCount > dbNotifiedCount) {
        console.log(`  >>> ${newCount - dbNotifiedCount} NEW ads were just notified! <<<`);
      }
      dbNotifiedCount = newCount;
    } catch (err) {
      console.error(`  Check-now error: ${err.message}`);
    }
    console.log('');
  }

  // 4. Summary
  console.log('=== SUMMARY ===');
  console.log(`Total currently rejected/with-issues on Meta: ${totalRejected}`);
  const disapprovedTotal = allRejected.filter(a => a.effective_status === 'DISAPPROVED').length;
  const withIssuesTotal = allRejected.filter(a => a.effective_status === 'WITH_ISSUES').length;
  console.log(`  - DISAPPROVED: ${disapprovedTotal}`);
  console.log(`  - WITH_ISSUES: ${withIssuesTotal}`);
  console.log(`Total notified in database: ${dbNotifiedCount}`);
  if (dbNotifiedCount >= totalRejected) {
    console.log(`\nAll ${totalRejected} currently rejected ads appear to be covered by the ${dbNotifiedCount} notifications in DB.`);
    console.log(`(DB may also contain historical notifications for ads that are no longer rejected.)`);
  } else {
    console.log(`\nPotential gap: ${totalRejected} rejected on Meta but only ${dbNotifiedCount} in DB.`);
    console.log(`Note: The check-now sync above should have caught any missed ads.`);
  }

  // Per-account breakdown
  console.log('\n--- PER-ACCOUNT BREAKDOWN ---');
  for (const { acct, ads, error } of perAccount) {
    if (error) {
      console.log(`  ${acct.name}: ERROR - ${error}`);
    } else {
      console.log(`  ${acct.name}: ${ads.length} rejected`);
    }
  }

  // Note about Mineblock X8
  const x8 = perAccount.find(p => p.acct.name === 'Mineblock X8');
  if (x8?.error) {
    console.log('\n*** NOTE: Mineblock X8 (act_938489175321542) returned a 403 permissions error.');
    console.log('    The Meta access token may not have ads_read permission for this account.');
    console.log('    Also note: only 6 accounts are configured in production (accountCount=6),');
    console.log('    suggesting X8 may have been intentionally excluded.');
  }
}

main().catch(err => {
  console.error(`FATAL: ${err.message}`);
  process.exit(1);
});
