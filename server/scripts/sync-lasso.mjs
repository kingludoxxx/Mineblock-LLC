#!/usr/bin/env node
/**
 * Lasso → HubSpot daily sync
 *
 * Usage:
 *   LASSO_EMAIL=... LASSO_PASSWORD=... HUBSPOT_TOKEN=pat-na2-... \
 *   node server/scripts/sync-lasso.mjs
 *
 * Flags:
 *   --csv <path>   Skip Playwright, parse a local CSV (testing)
 *   --dry-run      Parse + filter, but do NOT write to HubSpot
 *
 * What it does:
 *   1. Headless Chromium logs into dashboard.lassocheckout.com
 *   2. Navigates to /sales/cart-abandoners, clicks Download CSV
 *   3. Parses CSV, filters out rows with no phone number
 *   4. Dedupes by Lasso Session ID against existing HubSpot contacts
 *   5. Batch-creates Contacts (with custom Lasso properties)
 *   6. Batch-creates Deals in the Cart Recovery pipeline
 *   7. Associates each Deal with its Contact
 *   8. Posts a Slack alert if SLACK_WEBHOOK_URL is set
 */

import { chromium } from 'playwright';
import { parse } from 'csv-parse/sync';
import path from 'node:path';
import { tmpdir } from 'node:os';
import { readFileSync, unlinkSync } from 'node:fs';
import { execSync } from 'node:child_process';
import { existsSync } from 'node:fs';

// Self-healing: check if the Chromium binary actually exists on disk.
// Render cron containers are ephemeral — the build cache doesn't carry over
// to runtime, so the start command installs it first. This is a belt-and-
// suspenders fallback in case the start command ever changes.
function ensureChromium() {
  const exePath = chromium.executablePath();
  if (!existsSync(exePath)) {
    log('Chromium binary missing — installing now...');
    execSync('npx playwright install chromium', { stdio: 'pipe' });
    log('Chromium installed.');
  }
}

// ─── Config ────────────────────────────────────────────────────────────────
const {
  LASSO_EMAIL,
  LASSO_PASSWORD,
  HUBSPOT_TOKEN,
  HUBSPOT_PIPELINE_ID = '2237887205',     // Cart Recovery pipeline
  HUBSPOT_STAGE_NEW = '3592302301',        // "New" stage
  LASSO_LOGIN_URL = 'https://dashboard.lassocheckout.com/login',
  LASSO_ABANDONERS_URL = 'https://dashboard.lassocheckout.com/sales/cart-abandoners',
  SLACK_WEBHOOK_URL,
  LASSO_HEADLESS = 'true',
} = process.env;

const DRY_RUN = process.argv.includes('--dry-run');
const USING_CSV = process.argv.includes('--csv');

const REQUIRED = DRY_RUN
  ? {}
  : USING_CSV
    ? { HUBSPOT_TOKEN }
    : { LASSO_EMAIL, LASSO_PASSWORD, HUBSPOT_TOKEN };
for (const [k, v] of Object.entries(REQUIRED)) {
  if (!v) {
    console.error(`[sync-lasso] FATAL: missing env var ${k}`);
    process.exit(1);
  }
}

const HUB_BASE = 'https://api.hubapi.com';
const HUB_HEADERS = {
  'Authorization': `Bearer ${HUBSPOT_TOKEN}`,
  'Content-Type': 'application/json',
};

// ─── Helpers ───────────────────────────────────────────────────────────────
const log = (msg) => console.log(`[${new Date().toISOString()}] ${msg}`);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function notifySlack(text, color = 'good') {
  if (!SLACK_WEBHOOK_URL) return;
  try {
    await fetch(SLACK_WEBHOOK_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        attachments: [{
          color,
          text,
          footer: 'Lasso → HubSpot sync',
          ts: Math.floor(Date.now() / 1000),
        }],
      }),
    });
  } catch (e) {
    log(`Slack notify failed: ${e.message}`);
  }
}

function parseCartValue(s) {
  return parseFloat((s || '0').replace(/[$,]/g, '')) || 0;
}

function splitName(full) {
  const parts = (full || '').trim().split(/\s+/);
  if (parts.length === 0) return { firstname: '', lastname: '' };
  if (parts.length === 1) return { firstname: parts[0], lastname: '' };
  return { firstname: parts[0], lastname: parts.slice(1).join(' ') };
}

function isoDay(dateStr) {
  if (!dateStr) return '';
  const d = new Date(dateStr);
  if (isNaN(d.getTime())) return '';
  // HubSpot date properties want YYYY-MM-DD at midnight UTC
  return d.toISOString().slice(0, 10);
}

// HubSpot helper with retry on 429
async function hub(method, pathStr, body) {
  for (let attempt = 0; attempt < 4; attempt++) {
    const res = await fetch(`${HUB_BASE}${pathStr}`, {
      method,
      headers: HUB_HEADERS,
      body: body ? JSON.stringify(body) : undefined,
    });
    if (res.status === 429) {
      const wait = Math.min(2000 * (attempt + 1), 8000);
      log(`Rate limited; waiting ${wait}ms`);
      await sleep(wait);
      continue;
    }
    const text = await res.text();
    let data;
    try { data = text ? JSON.parse(text) : {}; } catch { data = { raw: text }; }
    if (!res.ok) {
      const err = new Error(`HubSpot ${method} ${pathStr} → ${res.status}: ${text}`);
      err.status = res.status;
      err.data = data;
      throw err;
    }
    return data;
  }
  throw new Error(`HubSpot ${method} ${pathStr} kept rate-limiting after retries`);
}

function chunk(arr, size) {
  const out = [];
  for (let i = 0; i < arr.length; i += size) out.push(arr.slice(i, i + size));
  return out;
}

// ─── Step 1: Scrape Lasso ──────────────────────────────────────────────────
async function downloadLassoCSV() {
  ensureChromium();
  log('Launching headless Chromium...');
  const browser = await chromium.launch({
    headless: LASSO_HEADLESS !== 'false',
    args: ['--no-sandbox', '--disable-setuid-sandbox'],
  });
  const context = await browser.newContext({ acceptDownloads: true });
  const page = await context.newPage();

  try {
    log(`Navigating to login: ${LASSO_LOGIN_URL}`);
    await page.goto(LASSO_LOGIN_URL, { waitUntil: 'networkidle', timeout: 45000 });

    log('Filling login form...');
    const emailSelector = await page.locator('input[type="email"], input[name="email"], input[placeholder*="mail" i]').first();
    const pwSelector = await page.locator('input[type="password"], input[name="password"]').first();
    await emailSelector.fill(LASSO_EMAIL);
    await pwSelector.fill(LASSO_PASSWORD);

    log('Submitting login...');
    await Promise.all([
      page.waitForURL((url) => !/login/i.test(url.toString()), { timeout: 45000 }),
      page.locator('button[type="submit"], button:has-text("Sign in"), button:has-text("Log in"), button:has-text("Login")').first().click(),
    ]);
    log(`Logged in. Current URL: ${page.url()}`);

    log(`Navigating to cart abandoners: ${LASSO_ABANDONERS_URL}`);
    await page.goto(LASSO_ABANDONERS_URL, { waitUntil: 'networkidle', timeout: 45000 });
    await page.waitForTimeout(2000);

    log('Clicking Download CSV...');
    const downloadPromise = page.waitForEvent('download', { timeout: 45000 });
    await page.locator('button:has-text("Download CSV"), a:has-text("Download CSV"), button:has-text("Export"):not(:has-text("Filter"))').first().click();
    const download = await downloadPromise;

    const tmpPath = path.join(tmpdir(), `lasso-${Date.now()}.csv`);
    await download.saveAs(tmpPath);
    const csv = readFileSync(tmpPath, 'utf-8');
    unlinkSync(tmpPath);
    log(`CSV downloaded: ${csv.length} bytes`);
    return csv;
  } finally {
    await browser.close();
  }
}

// ─── Step 2: HubSpot dedup lookup ──────────────────────────────────────────
async function getExistingSessionIds() {
  // Search returns up to 100/page; paginate.
  const ids = new Set();
  let after;
  for (let page = 0; page < 50; page++) { // safety cap = 5000 contacts
    const body = {
      filterGroups: [{ filters: [{ propertyName: 'lasso_session_id', operator: 'HAS_PROPERTY' }] }],
      properties: ['lasso_session_id'],
      limit: 100,
      after,
    };
    const data = await hub('POST', '/crm/v3/objects/contacts/search', body);
    for (const r of data.results || []) {
      const sid = r.properties?.lasso_session_id;
      if (sid) ids.add(sid);
    }
    if (!data.paging?.next?.after) break;
    after = data.paging.next.after;
  }
  return ids;
}

// ─── Step 3: Batch create in HubSpot ───────────────────────────────────────
async function createContactsAndDeals(records) {
  let createdContacts = 0;
  let createdDeals = 0;
  let failedContacts = 0;
  let failedDeals = 0;

  // Batch upsert contacts by email (100 per request max).
  // Upsert creates new contacts OR updates existing ones — no 409 duplicates.
  for (const batch of chunk(records, 100)) {
    const inputs = batch
      .filter((r) => {
        // Strip trailing garbage chars (=====) that Lasso sometimes appends
        const email = (r['Email'] || '').toLowerCase().trim().replace(/[^a-z0-9@._+\-]/g, '');
        // Basic structural check: has @, has dot after @, no spaces
        if (!email || !email.includes('@') || !email.includes('.')) return false;
        const [local, domain] = email.split('@');
        // Domain must have a TLD of at least 2 chars and no stray chars
        return local && domain && /^[a-z0-9.-]+\.[a-z]{2,}$/.test(domain);
      })
      .map((r) => {
        const { firstname, lastname } = splitName(r['Customer Name']);
        const cartAbandonedAt = isoDay(r['Updated At']);
        // Apply same sanitization as the filter
        const email = (r['Email'] || '').toLowerCase().trim().replace(/[^a-z0-9@._+\-]/g, '');
        return {
          idProperty: 'email',
          id: email,
          properties: {
            email,
            firstname,
            lastname,
            phone: (r['Phone'] || '').trim(),
            country: r['Country'] || '',
            lasso_session_id: r['Session ID'],
            cart_value: parseCartValue(r['Cart Value']),
            cart_items: parseInt(r['Items'], 10) || 0,
            ...(cartAbandonedAt ? { cart_abandoned_at: cartAbandonedAt } : {}),
          },
        };
      });

    if (inputs.length === 0) continue;

    let result;
    try {
      result = await hub('POST', '/crm/v3/objects/contacts/batch/upsert', { inputs });
    } catch (err) {
      const batchErrDetail = JSON.stringify(err.data || '').slice(0, 500);
      log(`Batch contact upsert failed (${err.status}): ${batchErrDetail}`);
      log(`Falling back to individual upserts (${inputs.length} records)`);
      result = { results: [] };
      for (const input of inputs) {
        try {
          const single = await hub('POST', '/crm/v3/objects/contacts/batch/upsert', { inputs: [input] });
          result.results.push(...(single.results || []));
          log(`  ✓ ${input.id}`);
        } catch (e) {
          const errBody = JSON.stringify(e.data || '');
          log(`  ✗ ${input.id} → ${e.status}: ${errBody.slice(0, 200)}`);
          if (e.status === 400 && errBody.includes('INVALID_EMAIL')) {
            // Email is genuinely malformed (e.g. hotmail.cim). Create the contact
            // WITHOUT email so the lasso_session_id is persisted and this record
            // is never retried on future runs. Phone + name are still captured.
            try {
              const props = { ...input.properties };
              delete props.email;
              const fallback = await hub('POST', '/crm/v3/objects/contacts', { properties: props });
              result.results.push(fallback);
              log(`  contact saved without invalid email '${input.id}' (HS ID: ${fallback.id})`);
            } catch (e2) {
              failedContacts++;
              log(`  contact ${input.id} failed permanently: ${e2.status} ${e2.data?.message || ''}`);
            }
          } else {
            failedContacts++;
            log(`  contact ${input.id} failed: ${e.status} ${e.data?.message || ''}`);
          }
        }
      }
    }
    createdContacts += (result.results || []).length;

    // Match contacts → batch records by email so we can build deals + associations
    const emailToContactId = new Map();
    for (const c of result.results || []) {
      emailToContactId.set(c.properties?.email?.toLowerCase(), c.id);
    }

    // Build deal inputs for the contacts we successfully created
    const dealInputs = batch
      .filter((r) => emailToContactId.has((r['Email'] || '').toLowerCase().trim()))
      .map((r) => {
        const cartValue = parseCartValue(r['Cart Value']);
        const { firstname, lastname } = splitName(r['Customer Name']);
        const dealName = `Cart Recovery — ${firstname || ''} ${lastname || ''}`.trim() || `Cart ${r['Session ID']}`;
        return {
          properties: {
            dealname: dealName,
            amount: cartValue,
            pipeline: HUBSPOT_PIPELINE_ID,
            dealstage: HUBSPOT_STAGE_NEW,
          },
          // Inline associations require knowing contact ID
          _email: (r['Email'] || '').toLowerCase().trim(),
        };
      });

    // Create deals (batch) — with associations
    const dealPayload = {
      inputs: dealInputs.map((d) => ({
        properties: d.properties,
        associations: [
          {
            to: { id: emailToContactId.get(d._email) },
            types: [{ associationCategory: 'HUBSPOT_DEFINED', associationTypeId: 3 }], // contact_to_deal
          },
        ],
      })),
    };

    if (dealPayload.inputs.length === 0) continue;

    let dealResult;
    try {
      dealResult = await hub('POST', '/crm/v3/objects/deals/batch/create', dealPayload);
    } catch (err) {
      log(`Batch deal create failed (${err.status}); falling back to individual creates`);
      dealResult = { results: [] };
      for (const dealInput of dealPayload.inputs) {
        try {
          const single = await hub('POST', '/crm/v3/objects/deals', dealInput);
          dealResult.results.push(single);
        } catch (e) {
          failedDeals++;
          log(`  deal failed: ${e.status} ${e.data?.message || ''}`);
        }
      }
    }
    createdDeals += (dealResult.results || []).length;

    log(`  Batch processed: ${result.results?.length || 0} contacts, ${dealResult.results?.length || 0} deals`);
  }

  return { createdContacts, createdDeals, failedContacts, failedDeals };
}

// ─── Step 4: Sync orchestrator ─────────────────────────────────────────────
async function syncToHubSpot(csvText) {
  const records = parse(csvText, { columns: true, skip_empty_lines: true, trim: true });
  log(`Parsed ${records.length} rows from Lasso CSV`);

  // Filter: must have phone
  const withPhone = records.filter((r) => r['Phone'] && r['Phone'].trim());
  const noPhoneCount = records.length - withPhone.length;
  if (noPhoneCount > 0) log(`Skipped ${noPhoneCount} records with no phone number`);

  // Filter: must have valid Session ID + email
  const valid = withPhone.filter((r) => r['Session ID'] && r['Email']);
  const noIdOrEmail = withPhone.length - valid.length;
  if (noIdOrEmail > 0) log(`Skipped ${noIdOrEmail} records missing Session ID or email`);

  if (DRY_RUN) {
    log(`DRY RUN — would push ${valid.length} contacts to HubSpot`);
    return { added: 0, total: 0, noPhone: noPhoneCount, dryRun: valid.length };
  }

  log('Fetching existing Lasso Session IDs from HubSpot...');
  const existingIds = await getExistingSessionIds();
  log(`HubSpot already has ${existingIds.size} contacts with a Lasso Session ID`);

  const newRecords = valid.filter((r) => !existingIds.has(r['Session ID']));
  log(`New leads to create: ${newRecords.length}`);

  if (newRecords.length === 0) {
    return { added: 0, total: existingIds.size, noPhone: noPhoneCount, skipped: valid.length };
  }

  const result = await createContactsAndDeals(newRecords);
  log(`Created ${result.createdContacts} contacts and ${result.createdDeals} deals`);
  if (result.failedContacts || result.failedDeals) {
    log(`Failures: ${result.failedContacts} contacts, ${result.failedDeals} deals`);
  }

  return {
    added: result.createdContacts,
    deals: result.createdDeals,
    failedContacts: result.failedContacts,
    failedDeals: result.failedDeals,
    total: existingIds.size + result.createdContacts,
    noPhone: noPhoneCount,
    skipped: valid.length - newRecords.length,
  };
}

// ─── Main ──────────────────────────────────────────────────────────────────
(async () => {
  const startTime = Date.now();
  try {
    log('=== Lasso → HubSpot sync starting ===');
    const csvFlagIdx = process.argv.indexOf('--csv');
    const csv = csvFlagIdx !== -1 && process.argv[csvFlagIdx + 1]
      ? (log(`Using local CSV file: ${process.argv[csvFlagIdx + 1]}`), readFileSync(process.argv[csvFlagIdx + 1], 'utf-8'))
      : await downloadLassoCSV();

    const result = await syncToHubSpot(csv);
    const elapsed = ((Date.now() - startTime) / 1000).toFixed(1);

    if (DRY_RUN) {
      log(`DRY RUN complete in ${elapsed}s`);
      process.exit(0);
    }

    const noPhoneNote = result.noPhone > 0 ? ` Skipped (no phone): ${result.noPhone}.` : '';
    const failNote = (result.failedContacts || result.failedDeals)
      ? ` ⚠️ Failures: ${result.failedContacts} contacts, ${result.failedDeals} deals.`
      : '';
    const msg = result.added === 0
      ? `✅ Lasso → HubSpot — no new leads. Total contacts: ${result.total}.${noPhoneNote} (${elapsed}s)`
      : `✅ Lasso → HubSpot — ${result.added} new contacts, ${result.deals} new deals.${failNote} Total: ${result.total}. Skipped (existing): ${result.skipped}.${noPhoneNote} (${elapsed}s)`;
    log(msg);
    await notifySlack(msg, (result.failedContacts || result.failedDeals) ? 'warning' : 'good');
    process.exit(0);
  } catch (err) {
    const elapsed = ((Date.now() - startTime) / 1000).toFixed(1);
    const msg = `❌ Lasso → HubSpot FAILED after ${elapsed}s: ${err.message}`;
    console.error(msg);
    console.error(err.stack);
    await notifySlack(msg, 'danger');
    process.exit(1);
  }
})();
