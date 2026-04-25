#!/usr/bin/env node
/**
 * Lasso → Google Sheet daily sync
 *
 * Usage:
 *   LASSO_EMAIL=... LASSO_PASSWORD=... GOOGLE_SHEETS_CREDENTIALS_JSON='{...}' \
 *   node server/scripts/sync-lasso.mjs
 *
 * What it does:
 *   1. Headless Chromium logs into dashboard.lassocheckout.com
 *   2. Navigates to /sales/cart-abandoners
 *   3. Clicks "Download CSV" and captures the file
 *   4. Parses CSV, dedupes by Session ID against rows already in the sheet
 *   5. Auto-assigns new rows alternating Caller 1 / Caller 2 (round-robin)
 *   6. Appends new rows to the sheet (workflow columns preserved on existing rows)
 *   7. Posts a Slack alert if SLACK_WEBHOOK_URL is set
 */

import { chromium } from 'playwright';
import { google } from 'googleapis';
import { parse } from 'csv-parse/sync';
import path from 'node:path';
import { tmpdir } from 'node:os';
import { readFileSync, unlinkSync } from 'node:fs';

// ─── Config ────────────────────────────────────────────────────────────────
const {
  LASSO_EMAIL,
  LASSO_PASSWORD,
  GOOGLE_SHEETS_CREDENTIALS_JSON,
  LASSO_SHEET_ID = '1bv_tMbizihBeGpd-uxUPMlm0OHUL3VnRKYnExPjsNAo',
  LASSO_LOGIN_URL = 'https://dashboard.lassocheckout.com/login',
  LASSO_ABANDONERS_URL = 'https://dashboard.lassocheckout.com/sales/cart-abandoners',
  SLACK_WEBHOOK_URL,
  LASSO_HEADLESS = 'true',
} = process.env;

const REQUIRED = { LASSO_EMAIL, LASSO_PASSWORD, GOOGLE_SHEETS_CREDENTIALS_JSON };
for (const [k, v] of Object.entries(REQUIRED)) {
  if (!v) {
    console.error(`[sync-lasso] FATAL: missing env var ${k}`);
    process.exit(1);
  }
}

// ─── Helpers ───────────────────────────────────────────────────────────────
const log = (msg) => console.log(`[${new Date().toISOString()}] ${msg}`);

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
          footer: 'Lasso → Sheet sync',
          ts: Math.floor(Date.now() / 1000),
        }],
      }),
    });
  } catch (e) {
    log(`Slack notify failed: ${e.message}`);
  }
}

function fmtDate(iso) {
  if (!iso) return '';
  try {
    const d = new Date(iso);
    if (isNaN(d.getTime())) return iso;
    return d.toLocaleString('en-US', {
      weekday: 'short', month: 'short', day: 'numeric', year: 'numeric',
      hour: 'numeric', minute: '2-digit', hour12: true,
    });
  } catch {
    return iso;
  }
}

// ─── Step 1: Scrape Lasso ──────────────────────────────────────────────────
async function downloadLassoCSV() {
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

    // Try multiple selector strategies for email/password
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
    // Give the table a moment to fully populate
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

// ─── Step 2: Google Sheets client ──────────────────────────────────────────
function getSheetsClient() {
  let creds;
  try {
    creds = JSON.parse(GOOGLE_SHEETS_CREDENTIALS_JSON);
  } catch (e) {
    throw new Error(`GOOGLE_SHEETS_CREDENTIALS_JSON is not valid JSON: ${e.message}`);
  }
  const auth = new google.auth.JWT({
    email: creds.client_email,
    key: creds.private_key,
    scopes: ['https://www.googleapis.com/auth/spreadsheets'],
  });
  return google.sheets({ version: 'v4', auth });
}

// ─── Step 3: Sync to sheet ─────────────────────────────────────────────────
async function syncToSheet(csvText) {
  const sheets = getSheetsClient();

  // Parse incoming CSV
  const records = parse(csvText, { columns: true, skip_empty_lines: true, trim: true });
  log(`Parsed ${records.length} rows from Lasso CSV`);

  // Read existing Session IDs from sheet (column M)
  const existing = await sheets.spreadsheets.values.get({
    spreadsheetId: LASSO_SHEET_ID,
    range: 'M2:M10000',
  });
  const existingIds = new Set((existing.data.values || []).flat().filter(Boolean));
  log(`Sheet already has ${existingIds.size} unique abandoners`);

  // Read full existing data (to merge after we add new rows on top)
  const allExisting = await sheets.spreadsheets.values.get({
    spreadsheetId: LASSO_SHEET_ID,
    range: 'A2:M10000',
  });
  const existingRows = allExisting.data.values || [];

  // Filter only new
  const newRecords = records.filter((r) => r['Session ID'] && !existingIds.has(r['Session ID']));
  log(`New abandoners to add: ${newRecords.length}`);

  if (newRecords.length === 0) {
    log('Nothing to add — sheet is up to date');
    return { added: 0, total: existingIds.size, c1: 0, c2: 0, skipped: 0 };
  }

  // Auto-assign: balance round-robin from current totals
  // Count existing assignments to keep distribution even
  let c1Existing = 0, c2Existing = 0;
  for (const row of existingRows) {
    if (row[9] === 'Caller 1') c1Existing++;
    else if (row[9] === 'Caller 2') c2Existing++;
  }
  log(`Existing assignment: Caller 1 = ${c1Existing}, Caller 2 = ${c2Existing}`);

  // Sort new records newest first
  newRecords.sort((a, b) => (b['Updated At'] || '').localeCompare(a['Updated At'] || ''));

  let c1New = 0, c2New = 0;
  const newSheetRows = newRecords.map((r) => {
    const cartValue = parseFloat((r['Cart Value'] || '0').replace(/[$,]/g, '')) || 0;
    const items = parseInt(r['Items'], 10) || 0;
    // Assign to whoever has fewer total leads currently
    let assignedTo;
    if (c1Existing + c1New <= c2Existing + c2New) {
      assignedTo = 'Caller 1';
      c1New++;
    } else {
      assignedTo = 'Caller 2';
      c2New++;
    }
    return [
      fmtDate(r['Updated At']),
      r['Customer Name'] || '',
      r['Email'] || '',
      r['Phone'] || '',
      cartValue,
      items,
      r['Address'] || '',
      r['Country'] || '',
      'New',           // Status
      assignedTo,      // Assigned To (auto-balanced)
      '',              // Call Notes
      '',              // Call Date
      r['Session ID'] || '',
    ];
  });

  // Combine: new rows on top, then all existing rows (preserves Status/Notes/Call Date)
  const combined = [...newSheetRows, ...existingRows];

  // Clear data area + write everything back in one shot
  await sheets.spreadsheets.values.clear({
    spreadsheetId: LASSO_SHEET_ID,
    range: 'A2:M10000',
  });
  await sheets.spreadsheets.values.update({
    spreadsheetId: LASSO_SHEET_ID,
    range: `A2:M${combined.length + 1}`,
    valueInputOption: 'USER_ENTERED',
    requestBody: { values: combined },
  });

  return {
    added: newRecords.length,
    total: combined.length,
    c1: c1New,
    c2: c2New,
    skipped: records.length - newRecords.length,
  };
}

// ─── Main ──────────────────────────────────────────────────────────────────
(async () => {
  const startTime = Date.now();
  try {
    log('=== Lasso → Sheet sync starting ===');
    // --csv <path> flag: skip Playwright, use a local CSV file (for testing)
    const csvFlagIdx = process.argv.indexOf('--csv');
    const csv = csvFlagIdx !== -1 && process.argv[csvFlagIdx + 1]
      ? (log(`Using local CSV file: ${process.argv[csvFlagIdx + 1]}`), readFileSync(process.argv[csvFlagIdx + 1], 'utf-8'))
      : await downloadLassoCSV();
    const result = await syncToSheet(csv);
    const elapsed = ((Date.now() - startTime) / 1000).toFixed(1);
    const msg = result.added === 0
      ? `✅ Lasso sync — no new abandoners. Total: ${result.total}. (${elapsed}s)`
      : `✅ Lasso sync — ${result.added} new abandoners added (Caller 1: ${result.c1}, Caller 2: ${result.c2}). Total in sheet: ${result.total}. Skipped (already present): ${result.skipped}. (${elapsed}s)`;
    log(msg);
    await notifySlack(msg, 'good');
    process.exit(0);
  } catch (err) {
    const elapsed = ((Date.now() - startTime) / 1000).toFixed(1);
    const msg = `❌ Lasso sync FAILED after ${elapsed}s: ${err.message}`;
    console.error(msg);
    console.error(err.stack);
    await notifySlack(msg, 'danger');
    process.exit(1);
  }
})();
