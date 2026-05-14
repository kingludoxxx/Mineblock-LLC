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
  HUBSPOT_AGENTS = '',                     // Format: "Jerome:ownerId1,Christian:ownerId2,Tyrone:ownerId3"
  WHOP_API_TOKEN,                          // Used to pull failed payments into HubSpot
  WHOP_API_URL = 'https://api.whop.com/api',
  WHOP_DECLINE_PAGES = '5',                // How many pages of recent Whop payments to scan each run
} = process.env;

// Round-robin agent pool — parsed once at startup
// Format: HUBSPOT_AGENTS=Christian:id1,Tyrone:id2:400
// Optional 3rd field = max cart value this agent accepts (no limit if omitted)
const OWNER_POOL = HUBSPOT_AGENTS
  .split(',')
  .map((s) => {
    const parts = s.trim().split(':');
    const name = parts[0]?.trim();
    const id   = parts[1]?.trim();
    const maxCart = parts[2] ? parseFloat(parts[2]) : Infinity;
    return (name && id) ? { name, id, maxCart } : null;
  })
  .filter(Boolean);

// Returns the eligible agent for a given cart value using round-robin
// among agents whose maxCart >= cartValue
const ownerCounters = {};
function assignAgent(cartValue) {
  const eligible = OWNER_POOL.filter((a) => cartValue <= a.maxCart);
  if (eligible.length === 0) {
    // Fallback: assign to agent with highest maxCart (or first if all unlimited)
    const fallback = OWNER_POOL.slice().sort((a, b) => b.maxCart - a.maxCart)[0];
    return fallback || null;
  }
  // Round-robin key is the sorted list of eligible names (so the counter is
  // shared across the same eligibility group, giving true alternation)
  const key = eligible.map((a) => a.name).join(',');
  ownerCounters[key] = (ownerCounters[key] || 0);
  const agent = eligible[ownerCounters[key] % eligible.length];
  ownerCounters[key]++;
  return agent;
}

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

function toHubSpotDatetime(dateStr) {
  if (!dateStr) return null;
  const d = new Date(dateStr);
  if (isNaN(d.getTime())) return null;
  // HubSpot datetime properties want Unix epoch in milliseconds
  return d.getTime();
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

// ─── Email helpers ──────────────────────────────────────────────────────────
function sanitizeEmail(raw) {
  return (raw || '').toLowerCase().trim().replace(/[^a-z0-9@._+\-]/g, '');
}

// Common TLD typos that pass structural checks but HubSpot rejects as INVALID_EMAIL
const INVALID_TLDS = new Set(['cim', 'ocm', 'cpm', 'con', 'comm', 'conm', 'gmai', 'gmial', 'yaho', 'yahooo', 'htomail', 'hotmal']);

function isValidEmail(email) {
  if (!email || !email.includes('@') || !email.includes('.')) return false;
  const [local, domain] = email.split('@');
  if (!local || !domain) return false;
  if (!/^[a-z0-9.-]+\.[a-z]{2,}$/.test(domain)) return false;
  const tld = domain.split('.').pop();
  if (INVALID_TLDS.has(tld)) return false;
  return true;
}

// ─── Step 2: HubSpot dedup lookup (email-based) ─────────────────────────────
// Returns the set of emails already in HubSpot that came from Lasso.
// Email-based (not session-ID-based) so repeat abandoners (same person,
// two sessions) are correctly identified as already-processed.
async function getExistingLassoEmails() {
  const emails = new Set();
  let after;
  for (let page = 0; page < 100; page++) { // cap = 10 000 contacts
    const body = {
      filterGroups: [{ filters: [{ propertyName: 'lasso_session_id', operator: 'HAS_PROPERTY' }] }],
      properties: ['email'],
      limit: 100,
      ...(after ? { after } : {}),
    };
    const data = await hub('POST', '/crm/v3/objects/contacts/search', body);
    for (const r of data.results || []) {
      const email = (r.properties?.email || '').toLowerCase().trim();
      if (email) emails.add(email);
    }
    if (!data.paging?.next?.after) break;
    after = data.paging.next.after;
  }
  return emails;
}

// ─── Step 3: Batch create in HubSpot ───────────────────────────────────────
// ownerStartIndex: global offset so round-robin continues across batches
async function createContactsAndDeals(records) {
  let createdContacts = 0;
  let createdDeals = 0;
  let failedContacts = 0;
  let failedDeals = 0;

  // Batch upsert contacts by email (100 per request max).
  // Upsert creates new contacts OR updates existing ones — no 409 duplicates.
  for (const batch of chunk(records, 100)) {
    // Records arriving here are already email-validated and deduplicated upstream.
    const inputs = batch.map((r) => {
      const { firstname, lastname } = splitName(r['Customer Name']);
      const cartAbandonedAt = toHubSpotDatetime(r['Updated At']);
      const email = sanitizeEmail(r['Email']);
      // Assign agent based on cart value constraint + round-robin
      const cartValue = parseCartValue(r['Cart Value']);
      const agent = OWNER_POOL.length > 0 ? assignAgent(cartValue) : null;
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
          hs_lead_status: 'READY_TO_CALL',
          ...(cartAbandonedAt ? { cart_abandoned_at: cartAbandonedAt } : {}),
          ...(agent ? { hubspot_owner_id: agent.id, agent: agent.name } : {}),
        },
      };
    });

    if (inputs.length === 0) continue;

    let result;
    try {
      result = await hub('POST', '/crm/v3/objects/contacts/batch/upsert', { inputs });
    } catch (err) {
      const batchErrDetail = JSON.stringify(err.data || '').slice(0, 300);
      log(`Batch contact upsert failed (${err.status}): ${batchErrDetail}`);
      log(`Falling back to individual upserts (${inputs.length} records)`);
      result = { results: [] };
      for (const input of inputs) {
        try {
          const single = await hub('POST', '/crm/v3/objects/contacts/batch/upsert', { inputs: [input] });
          result.results.push(...(single.results || []));
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
      .filter((r) => emailToContactId.has(sanitizeEmail(r['Email'])))
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
          _email: sanitizeEmail(r['Email']),
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

// ─── One-shot bulk reassignment ────────────────────────────────────────────
// When env FORCE_ASSIGN_TO=<ownerId> is set, scan EVERY HubSpot contact and
// reassign any whose hubspot_owner_id != <ownerId>. Used to bulk-move legacy
// leads onto a new agent (e.g. retiring Christian/Tyrone, putting everyone
// on Joshua). Idempotent — once everyone is on the target, subsequent runs
// are zero-write. Set FORCE_ASSIGN_TO back to empty when done.
async function forceAssignAllContacts(targetOwnerId) {
  // Look up the agent display name from OWNER_POOL (so the custom 'agent' field
  // stays in sync with the new owner). Falls back to '' if not found.
  const matched = OWNER_POOL.find(a => String(a.id) === String(targetOwnerId));
  const targetAgentName = matched?.name || '';
  log(`[FORCE_ASSIGN] Scanning all HubSpot contacts to reassign to owner ${targetOwnerId}${targetAgentName ? ` (${targetAgentName})` : ''}...`);
  let after;
  let totalScanned = 0;
  const toUpdate = [];

  // Walk all contacts (paged) — fetch both owner_id and the 'agent' custom field
  for (let page = 0; page < 500; page++) { // cap = 50,000 contacts
    const qs = `limit=100&properties=hubspot_owner_id,agent${after ? `&after=${encodeURIComponent(after)}` : ''}`;
    let data;
    try {
      data = await hub('GET', `/crm/v3/objects/contacts?${qs}`);
    } catch (e) {
      log(`[FORCE_ASSIGN] paginated fetch failed (page ${page}): ${e.status} ${e.data?.message || e.message}`);
      break;
    }
    const results = data.results || [];
    totalScanned += results.length;
    for (const c of results) {
      const curOwner = c.properties?.hubspot_owner_id;
      const curAgent = c.properties?.agent || '';
      const updates = {};
      if (curOwner !== String(targetOwnerId)) updates.hubspot_owner_id = String(targetOwnerId);
      if (targetAgentName && curAgent !== targetAgentName) updates.agent = targetAgentName;
      if (Object.keys(updates).length > 0) {
        toUpdate.push({ id: c.id, properties: updates });
      }
    }
    if (!data.paging?.next?.after) break;
    after = data.paging.next.after;
  }

  log(`[FORCE_ASSIGN] Scanned ${totalScanned}, need to reassign ${toUpdate.length}`);
  if (toUpdate.length === 0) return { scanned: totalScanned, reassigned: 0 };

  // Batch update — 100 inputs per request
  let reassigned = 0;
  let failed = 0;
  for (const batch of chunk(toUpdate, 100)) {
    try {
      await hub('POST', '/crm/v3/objects/contacts/batch/update', { inputs: batch });
      reassigned += batch.length;
    } catch (e) {
      log(`[FORCE_ASSIGN] batch update failed: ${e.status} ${e.data?.message || e.message}`);
      // Fallback to individual updates so one bad record doesn't kill the batch
      for (const input of batch) {
        try {
          await hub('PATCH', `/crm/v3/objects/contacts/${input.id}`, { properties: input.properties });
          reassigned++;
        } catch (e2) {
          failed++;
          log(`  ${input.id} → ${e2.status} ${e2.data?.message || ''}`);
        }
      }
    }
  }
  log(`[FORCE_ASSIGN] ✅ Reassigned ${reassigned} contacts to owner ${targetOwnerId} (${failed} failed)`);
  return { scanned: totalScanned, reassigned, failed };
}

// One-shot bulk SPLIT: divide every HubSpot contact across multiple owner IDs
// in deterministic round-robin order (hash-based on contact ID so the split
// is stable across runs and idempotent — same contact always ends up on the
// same owner). Triggered by SPLIT_BETWEEN env var with comma-separated IDs.
async function splitContactsBetweenOwners(ownerIds) {
  // Build name lookup from OWNER_POOL (which is already parsed from HUBSPOT_AGENTS)
  const targetById = {};
  for (const id of ownerIds) {
    const match = OWNER_POOL.find(a => String(a.id) === String(id));
    targetById[id] = { id, name: match?.name || '' };
  }
  const nameList = Object.values(targetById).map(t => `${t.id}(${t.name || '?'})`).join(', ');
  log(`[SPLIT] Splitting all contacts between ${ownerIds.length} owners: ${nameList}`);

  let after;
  let scanned = 0;
  const toUpdate = [];

  for (let page = 0; page < 500; page++) {
    const qs = `limit=100&properties=hubspot_owner_id,agent${after ? `&after=${encodeURIComponent(after)}` : ''}`;
    let data;
    try {
      data = await hub('GET', `/crm/v3/objects/contacts?${qs}`);
    } catch (e) {
      log(`[SPLIT] paginated fetch failed (page ${page}): ${e.status} ${e.data?.message || e.message}`);
      break;
    }
    const results = data.results || [];
    for (const c of results) {
      scanned++;
      // Stable round-robin: hash the contact ID and mod by owner count.
      // Same contact always ends up on the same owner across runs.
      const hash = [...String(c.id)].reduce((h, ch) => (h * 31 + ch.charCodeAt(0)) >>> 0, 0);
      const target = targetById[ownerIds[hash % ownerIds.length]];
      const curOwner = c.properties?.hubspot_owner_id;
      const curAgent = c.properties?.agent || '';
      const updates = {};
      if (curOwner !== String(target.id)) updates.hubspot_owner_id = String(target.id);
      if (target.name && curAgent !== target.name) updates.agent = target.name;
      if (Object.keys(updates).length > 0) toUpdate.push({ id: c.id, properties: updates });
    }
    if (!data.paging?.next?.after) break;
    after = data.paging.next.after;
  }

  log(`[SPLIT] Scanned ${scanned}, need to reassign ${toUpdate.length}`);
  if (toUpdate.length === 0) return { scanned, reassigned: 0 };

  // Count distribution of the split
  const dist = {};
  for (const u of toUpdate) {
    const owner = u.properties.hubspot_owner_id || '?';
    dist[owner] = (dist[owner] || 0) + 1;
  }
  log(`[SPLIT] Distribution: ${JSON.stringify(dist)}`);

  let reassigned = 0, failed = 0;
  for (const batch of chunk(toUpdate, 100)) {
    try {
      await hub('POST', '/crm/v3/objects/contacts/batch/update', { inputs: batch });
      reassigned += batch.length;
    } catch (e) {
      log(`[SPLIT] batch update failed: ${e.status} ${e.data?.message || e.message}`);
      for (const input of batch) {
        try {
          await hub('PATCH', `/crm/v3/objects/contacts/${input.id}`, { properties: input.properties });
          reassigned++;
        } catch (e2) { failed++; log(`  ${input.id} → ${e2.status} ${e2.data?.message || ''}`); }
      }
    }
  }
  log(`[SPLIT] ✅ Reassigned ${reassigned} (${failed} failed)`);
  return { scanned, reassigned, failed };
}

// ─── Whop decline sync ─────────────────────────────────────────────────────
// Pull recent declined Whop payments (status=open + payments_failed >= 1) and
// push them into HubSpot. Creates/updates contacts with decline metadata and
// flags them with hs_lead_status="DECLINE" so Mark/Jasper can call back.
//
// Matching strategy:
//   1. Whop's membership_metadata.lasso_session_id (if present) — exact match
//   2. user_email (lowercased) — falls back to upsert
//
// HubSpot fields written (must exist on the contacts object):
//   last_decline_amount  (number)
//   last_decline_at      (datetime, ms)
//   decline_count        (number)
//   total_declined       (number, cumulative)
//   hs_lead_status       (= "DECLINE")

async function ensureWhopDeclineProperties() {
  const props = [
    { name: 'last_decline_amount', label: 'Last Decline Amount', type: 'number', fieldType: 'number', groupName: 'contactinformation', description: 'Most recent failed payment amount from Whop' },
    { name: 'last_decline_at',     label: 'Last Decline At',     type: 'datetime', fieldType: 'date',   groupName: 'contactinformation', description: 'Timestamp of most recent failed Whop payment attempt' },
    { name: 'decline_count',       label: 'Decline Count',       type: 'number', fieldType: 'number', groupName: 'contactinformation', description: 'Number of failed Whop payment attempts' },
    { name: 'total_declined',      label: 'Total Declined',      type: 'number', fieldType: 'number', groupName: 'contactinformation', description: 'Cumulative $ amount of failed Whop payment attempts' },
    { name: 'last_whop_payment_id',label: 'Last Whop Payment ID',type: 'string', fieldType: 'text',   groupName: 'contactinformation', description: 'Whop payment ID of most recent decline (for idempotency)' },
  ];
  for (const p of props) {
    try {
      await hub('POST', '/crm/v3/properties/contacts', p);
      log(`[WHOP] Created contact property: ${p.name}`);
    } catch (e) {
      if (e.status === 409 || /already exists/i.test(JSON.stringify(e.data || ''))) {
        // already exists — fine
      } else {
        log(`[WHOP] Failed to create property ${p.name}: ${e.status} ${e.data?.message || e.message}`);
      }
    }
  }

  // Ensure hs_lead_status has a "DECLINE" option
  try {
    const lsProp = await hub('GET', '/crm/v3/properties/contacts/hs_lead_status');
    const opts = lsProp?.options || [];
    if (!opts.find(o => (o.value || '').toUpperCase() === 'DECLINE')) {
      const newOptions = [...opts, { label: 'Decline', value: 'DECLINE', displayOrder: opts.length, hidden: false }];
      await hub('PATCH', '/crm/v3/properties/contacts/hs_lead_status', { options: newOptions });
      log('[WHOP] Added "DECLINE" option to hs_lead_status');
    }
  } catch (e) {
    log(`[WHOP] Could not ensure DECLINE lead status: ${e.status} ${e.data?.message || e.message}`);
  }
}

// Diagnostic: check whether Whop decliners overlap with HubSpot contacts.
// Sample N recent Whop declines, look them up in HubSpot by email, and report
// how many already exist + have phone numbers. Triggered by DIAG_WHOP_OVERLAP=1.
async function diagnoseWhopOverlap() {
  if (!WHOP_API_TOKEN) { log('[DIAG] no WHOP_API_TOKEN'); return; }
  const resp = await fetch(`${WHOP_API_URL}/v5/company/payments?per=100&page=1`, {
    headers: { Authorization: `Bearer ${WHOP_API_TOKEN}` },
  });
  if (!resp.ok) { log(`[DIAG] whop fetch ${resp.status}`); return; }
  const data = await resp.json();
  const declines = (data.data || []).filter(p =>
    p.status !== 'paid' && (p.payments_failed || 0) >= 1 && p.user_email
  );
  log(`[DIAG] Sampling ${declines.length} recent Whop declines from page 1`);

  // Look up in HubSpot by email — fetch phone + lasso_session_id
  const inputs = declines.map(p => ({ id: sanitizeEmail(p.user_email) }));
  let results = [];
  try {
    const r = await hub('POST', '/crm/v3/objects/contacts/batch/read', {
      idProperty: 'email',
      properties: ['email', 'phone', 'lasso_session_id', 'firstname', 'lastname'],
      inputs,
    });
    results = r.results || [];
  } catch (e) {
    log(`[DIAG] batch read error: ${e.status} ${JSON.stringify(e.data || '').slice(0,200)}`);
    if (e.data?.results) results = e.data.results;  // partial results on 207
  }

  const foundByEmail = new Map();
  for (const c of results) {
    const e = (c.properties?.email || '').toLowerCase();
    if (e) foundByEmail.set(e, c.properties);
  }

  let inHubspot = 0, withPhone = 0, withLassoId = 0, notFound = 0;
  const sampleNotFound = [];
  for (const p of declines) {
    const email = sanitizeEmail(p.user_email);
    const hub = foundByEmail.get(email);
    if (hub) {
      inHubspot++;
      if (hub.phone) withPhone++;
      if (hub.lasso_session_id) withLassoId++;
    } else {
      notFound++;
      if (sampleNotFound.length < 3) sampleNotFound.push({email, lasso: p.membership_metadata?.lasso_session_id, amount: p.final_amount});
    }
  }
  log(`[DIAG] Whop decliners: ${declines.length} sampled`);
  log(`[DIAG]   in HubSpot:    ${inHubspot} (${Math.round(100*inHubspot/declines.length)}%)`);
  log(`[DIAG]   with phone:    ${withPhone} (${Math.round(100*withPhone/declines.length)}% of total)`);
  log(`[DIAG]   with lasso_id: ${withLassoId}`);
  log(`[DIAG]   NOT in HubSpot: ${notFound}`);
  if (sampleNotFound.length) {
    log(`[DIAG] Sample missing: ${JSON.stringify(sampleNotFound)}`);
  }
}

// One-shot cleanup: undo the import of historical (pre-today) Whop declines.
// Finds contacts whose last_decline_at is BEFORE today and clears their decline
// fields + resets hs_lead_status back to READY_TO_CALL if it's still DECLINE.
// Safe to leave running — once everyone with old declines is cleared it's a no-op.
async function cleanupHistoricalDeclines() {
  const now = new Date();
  const startOfTodayUTC = Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate());
  log(`[CLEANUP] Looking for decline contacts whose last_decline_at < ${new Date(startOfTodayUTC).toISOString()}`);

  // Search for contacts that have last_decline_at set AND it's before today.
  const toUpdate = [];
  let after;
  for (let page = 0; page < 50; page++) {
    let resp;
    try {
      resp = await hub('POST', '/crm/v3/objects/contacts/search', {
        filterGroups: [{
          filters: [
            { propertyName: 'last_decline_at', operator: 'LT', value: String(startOfTodayUTC) },
            { propertyName: 'last_decline_at', operator: 'HAS_PROPERTY' },
          ],
        }],
        properties: ['email', 'last_decline_at', 'hs_lead_status'],
        limit: 100,
        ...(after ? { after } : {}),
      });
    } catch (e) {
      log(`[CLEANUP] search failed: ${e.status} ${e.data?.message || e.message}`);
      break;
    }
    for (const c of (resp.results || [])) {
      const props = c.properties || {};
      const update = {
        // Clear all decline-related fields
        last_decline_amount: '',
        last_decline_at: '',
        decline_count: '',
        total_declined: '',
        last_whop_payment_id: '',
      };
      // Reset lead status only if it's currently DECLINE
      if (props.hs_lead_status === 'DECLINE') {
        update.hs_lead_status = 'READY_TO_CALL';
      }
      toUpdate.push({ id: c.id, properties: update });
    }
    if (!resp.paging?.next?.after) break;
    after = resp.paging.next.after;
  }

  log(`[CLEANUP] Found ${toUpdate.length} historical-decline contacts to clean up`);
  if (toUpdate.length === 0) return { cleaned: 0 };

  let cleaned = 0, failed = 0;
  for (const batch of chunk(toUpdate, 100)) {
    try {
      await hub('POST', '/crm/v3/objects/contacts/batch/update', { inputs: batch });
      cleaned += batch.length;
    } catch (e) {
      log(`[CLEANUP] batch failed: ${e.status} ${e.data?.message || e.message}`);
      for (const input of batch) {
        try {
          await hub('PATCH', `/crm/v3/objects/contacts/${input.id}`, { properties: input.properties });
          cleaned++;
        } catch (e2) { failed++; }
      }
    }
  }
  log(`[CLEANUP] ✅ Cleaned ${cleaned} historical decline contacts (${failed} failed)`);
  return { cleaned, failed };
}

async function syncWhopDeclines() {
  if (!WHOP_API_TOKEN) {
    log('[WHOP] WHOP_API_TOKEN not set — skipping decline sync');
    return { synced: 0 };
  }

  // Make sure custom properties exist before writing to them
  await ensureWhopDeclineProperties();

  // Only import declines from TODAY onward (per Ludo's instruction —
  // historical declines are too cold to be worth a recovery call).
  // Cutoff = start of today in UTC, as a unix-second timestamp.
  const now = new Date();
  const startOfTodayUTC = Math.floor(
    Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()) / 1000
  );
  log(`[WHOP] Cutoff: only declines whose last_payment_attempt >= ${new Date(startOfTodayUTC * 1000).toISOString()}`);

  // Pull the newest N pages of payments. Whop returns newest first.
  const maxPages = parseInt(WHOP_DECLINE_PAGES, 10) || 5;
  const declines = [];
  let stoppedEarly = false;
  for (let page = 1; page <= maxPages; page++) {
    let resp;
    try {
      resp = await fetch(`${WHOP_API_URL}/v5/company/payments?per=100&page=${page}`, {
        headers: { Authorization: `Bearer ${WHOP_API_TOKEN}` },
        signal: AbortSignal.timeout(15000),
      });
    } catch (err) {
      log(`[WHOP] Page ${page} fetch failed: ${err.message}`);
      break;
    }
    if (!resp.ok) {
      log(`[WHOP] Page ${page} returned ${resp.status}`);
      break;
    }
    const data = await resp.json();
    const payments = data.data || [];
    if (payments.length === 0) break;
    // Whop returns newest first — once we hit a payment whose attempt is
    // before today's cutoff, every subsequent page is also old. Short-circuit.
    let pageHadAnyRecent = false;
    for (const p of payments) {
      // "Failed" in the Whop UI = status=open AND payments_failed >= 1.
      // status=paid + payments_failed>=1 means they declined then succeeded — skip those.
      if (p.status === 'paid') continue;
      if ((p.payments_failed || 0) < 1) continue;
      if (!p.user_email) continue;
      const lastAttempt = p.last_payment_attempt || p.created_at || 0;
      if (lastAttempt < startOfTodayUTC) continue;          // older than today's cutoff
      pageHadAnyRecent = true;
      declines.push(p);
    }
    if (!pageHadAnyRecent && page > 1) {
      stoppedEarly = true;
      break;  // every payment on this page is before today → no need to keep paging
    }
  }

  log(`[WHOP] Found ${declines.length} declined payments today${stoppedEarly ? ' (stopped paging — older payments encountered)' : ''}`);

  // Group by email — keep latest attempt + sum amounts
  const byEmail = new Map();
  for (const p of declines) {
    const email = sanitizeEmail(p.user_email);
    if (!isValidEmail(email)) continue;
    const lastAttempt = p.last_payment_attempt || p.created_at || 0;
    const amount = parseFloat(p.final_amount || 0);
    const cur = byEmail.get(email) || {
      email,
      last_attempt: 0,
      last_amount: 0,
      last_payment_id: '',
      total_declined: 0,
      decline_count: 0,
      lasso_session_id: '',
      firstname: '',
      lastname: '',
      phone: '',
    };
    cur.total_declined += amount;
    cur.decline_count += (p.payments_failed || 1);
    if (lastAttempt > cur.last_attempt) {
      cur.last_attempt = lastAttempt;
      cur.last_amount = amount;
      cur.last_payment_id = p.id;
      if (p.membership_metadata?.lasso_session_id) cur.lasso_session_id = p.membership_metadata.lasso_session_id;
      if (p.billing_address?.name) {
        const { firstname, lastname } = splitName(p.billing_address.name);
        cur.firstname = firstname;
        cur.lastname = lastname;
      }
    }
    byEmail.set(email, cur);
  }

  log(`[WHOP] ${byEmail.size} unique decliners by email`);
  if (byEmail.size === 0) return { synced: 0 };

  // Look up which of these emails already exist in HubSpot so we don't clobber
  // existing owners (we only assign via round-robin for net-new contacts).
  const decliners = [...byEmail.values()];
  const emails = decliners.map(d => d.email);
  const existingMap = new Map();
  for (const batch of chunk(emails, 100)) {
    try {
      const r = await hub('POST', '/crm/v3/objects/contacts/batch/read', {
        idProperty: 'email',
        properties: ['email', 'hubspot_owner_id', 'last_whop_payment_id'],
        inputs: batch.map(e => ({ id: e })),
      });
      for (const c of (r.results || [])) {
        const e = (c.properties?.email || '').toLowerCase();
        if (e) existingMap.set(e, {
          id: c.id,
          ownerId: c.properties?.hubspot_owner_id,
          lastPaymentId: c.properties?.last_whop_payment_id,
        });
      }
    } catch (e) {
      // 207 = some not found, which is expected — read still returns the ones it found
      if (e.status !== 207) log(`[WHOP] batch read failed: ${e.status} ${e.data?.message || ''}`);
    }
  }

  // Build upsert payload
  const inputs = [];
  let skipped = 0;
  for (const d of decliners) {
    const existing = existingMap.get(d.email);
    // Idempotency — if we've already seen this exact payment ID, skip
    if (existing?.lastPaymentId === d.last_payment_id) {
      skipped++;
      continue;
    }
    const properties = {
      email: d.email,
      last_decline_amount: d.last_amount,
      last_decline_at: toHubSpotDatetime(new Date(d.last_attempt * 1000).toISOString()),
      decline_count: d.decline_count,
      total_declined: d.total_declined,
      last_whop_payment_id: d.last_payment_id,
      hs_lead_status: 'DECLINE',
      ...(d.firstname ? { firstname: d.firstname } : {}),
      ...(d.lastname  ? { lastname:  d.lastname  } : {}),
      ...(d.lasso_session_id ? { lasso_session_id: d.lasso_session_id } : {}),
    };
    // Net-new contact → round-robin assignment
    if (!existing) {
      const agent = OWNER_POOL.length > 0 ? assignAgent(d.last_amount || 0) : null;
      if (agent) {
        properties.hubspot_owner_id = agent.id;
        properties.agent = agent.name;
      }
    }
    inputs.push({ idProperty: 'email', id: d.email, properties });
  }

  if (inputs.length === 0) {
    log(`[WHOP] Nothing to update (skipped ${skipped} unchanged decliners)`);
    return { synced: 0, skipped };
  }

  // Batch upsert
  let synced = 0, failed = 0;
  for (const batch of chunk(inputs, 100)) {
    try {
      const r = await hub('POST', '/crm/v3/objects/contacts/batch/upsert', { inputs: batch });
      synced += (r.results || []).length;
    } catch (e) {
      log(`[WHOP] batch upsert failed: ${e.status} ${e.data?.message || ''}`);
      for (const input of batch) {
        try {
          const r2 = await hub('POST', '/crm/v3/objects/contacts/batch/upsert', { inputs: [input] });
          synced += (r2.results || []).length;
        } catch (e2) {
          failed++;
          log(`  decliner ${input.id} failed: ${e2.status} ${e2.data?.message || ''}`);
        }
      }
    }
  }

  log(`[WHOP] ✅ Synced ${synced} decliners to HubSpot (${skipped} unchanged, ${failed} failed)`);
  return { synced, skipped, failed, total: decliners.length };
}

// ─── Step 4: Sync orchestrator ─────────────────────────────────────────────
async function syncToHubSpot(csvText) {
  const records = parse(csvText, { columns: true, skip_empty_lines: true, trim: true });
  log(`Parsed ${records.length} rows from Lasso CSV`);

  // Filter: must have phone
  const withPhone = records.filter((r) => r['Phone'] && r['Phone'].trim());
  const noPhoneCount = records.length - withPhone.length;
  if (noPhoneCount > 0) log(`Skipped ${noPhoneCount} records with no phone number`);

  // Filter: must have valid Session ID AND a structurally valid email.
  // Invalid emails (e.g. hotmail.cim typos) are dropped here — no point
  // sending them to HubSpot since they can never be upserted by email.
  const valid = withPhone.filter((r) => {
    if (!r['Session ID']) return false;
    const email = sanitizeEmail(r['Email']);
    return isValidEmail(email);
  });
  const noIdOrEmail = withPhone.length - valid.length;
  if (noIdOrEmail > 0) log(`Skipped ${noIdOrEmail} records (missing Session ID or invalid email)`);

  if (DRY_RUN) {
    log(`DRY RUN — would push ${valid.length} contacts to HubSpot`);
    return { added: 0, total: 0, noPhone: noPhoneCount, dryRun: valid.length };
  }

  log('Fetching existing Lasso contact emails from HubSpot...');
  const existingEmails = await getExistingLassoEmails();
  log(`HubSpot already has ${existingEmails.size} Lasso contacts`);

  // Deduplicate by email: skip already-in-HubSpot contacts AND deduplicate
  // within this batch (same person who abandoned twice has two session IDs
  // both appearing as "new" — keep only the first occurrence per email).
  const seenEmails = new Set();
  const newRecords = [];
  const existingInCsv = [];
  for (const r of valid) {
    const email = sanitizeEmail(r['Email']);
    if (existingEmails.has(email)) {
      if (!seenEmails.has(email)) existingInCsv.push(r); // refresh timestamps
      seenEmails.add(email);
      continue;
    }
    if (seenEmails.has(email)) continue;        // duplicate in this CSV batch
    seenEmails.add(email);
    newRecords.push(r);
  }
  log(`New unique leads to create: ${newRecords.length}`);

  // Refresh cart_abandoned_at for existing contacts in this CSV window.
  // ONLY updates cart_abandoned_at — does NOT touch Lead Status, Notes, or Recovered Amount.
  if (existingInCsv.length > 0) {
    log(`Refreshing cart_abandoned_at for ${existingInCsv.length} existing contacts...`);
    for (const batch of chunk(existingInCsv, 100)) {
      const inputs = batch
        .map((r) => {
          const ts = toHubSpotDatetime(r['Updated At']);
          if (!ts) return null;
          return { idProperty: 'email', id: sanitizeEmail(r['Email']), properties: { cart_abandoned_at: ts } };
        })
        .filter(Boolean);
      if (inputs.length > 0) {
        try {
          await hub('POST', '/crm/v3/objects/contacts/batch/upsert', { inputs });
        } catch (e) {
          log(`  cart_abandoned_at refresh failed: ${e.status}`);
        }
      }
    }
  }

  if (newRecords.length === 0) {
    return { added: 0, total: existingEmails.size, noPhone: noPhoneCount, skipped: valid.length };
  }

  if (OWNER_POOL.length > 0) {
    log(`Round-robin assignment: ${newRecords.length} leads → ${OWNER_POOL.length} agents (${OWNER_POOL.map(a => a.name).join(', ')})`);
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
    total: existingEmails.size + result.createdContacts,
    noPhone: noPhoneCount,
    skipped: valid.length - newRecords.length,
  };
}

// ─── Main ──────────────────────────────────────────────────────────────────
(async () => {
  const startTime = Date.now();
  try {
    log('=== Lasso → HubSpot sync starting ===');

    // Debug: dump our recognised env-var values at startup so we can see if
    // the cron service has them at all.
    log(`[env] DUMP_OWNERS=${JSON.stringify(process.env.DUMP_OWNERS)} FORCE_ASSIGN_TO=${JSON.stringify(process.env.FORCE_ASSIGN_TO)} HUBSPOT_AGENTS=${JSON.stringify(process.env.HUBSPOT_AGENTS)} DUMP_PROPS=${JSON.stringify(process.env.DUMP_PROPS)}`);

    // Diagnostic: dump all custom contact properties so we can find which
    // internal property the user's "SALES AGENT" column is actually reading.
    if (process.env.DUMP_PROPS === '1') {
      try {
        const props = await hub('GET', '/crm/v3/properties/contacts?archived=false');
        const custom = (props.results || []).filter(p => !p.hubspotDefined);
        const lines = custom.map(p => `${p.name}\t${p.label}\t${p.type}/${p.fieldType}`);
        log(`[DUMP_PROPS] ${lines.length} custom contact properties:\n${lines.join('\n')}`);
        // Also fetch ONE sample contact with all known agent-like properties to see actual stored values
        const sample = await hub('POST', '/crm/v3/objects/contacts/search', {
          filterGroups: [{ filters: [{ propertyName: 'lasso_session_id', operator: 'HAS_PROPERTY' }] }],
          properties: [...custom.map(p => p.name), 'hubspot_owner_id'],
          limit: 1,
        });
        if (sample.results?.[0]) {
          const c = sample.results[0];
          const interesting = Object.entries(c.properties || {})
            .filter(([k, v]) => v && (typeof v === 'string' && /christian|tyrone|joshua/i.test(v)))
            .map(([k, v]) => `  ${k} = ${v}`);
          if (interesting.length) log(`[DUMP_PROPS] sample contact ${c.id} has agent-like values:\n${interesting.join('\n')}`);
          else log(`[DUMP_PROPS] sample contact ${c.id} has no agent-like values in custom props`);
        }
      } catch (e) {
        log(`[DUMP_PROPS] failed: ${e.status} ${e.data?.message || e.message}`);
      }
    }

    // One-shot owners-list diagnostic — set DUMP_OWNERS=1 on the cron and the
    // next run will log every HubSpot owner (id, name, email, archived) and
    // post to Slack. Used to verify agent owner-IDs.
    if (process.env.DUMP_OWNERS === '1') {
      try {
        const ownersResp = await hub('GET', '/crm/v3/owners?limit=100');
        const lines = (ownersResp.results || []).map(o => `${o.id}\t${o.firstName || ''} ${o.lastName || ''}\t${o.email}${o.archived ? ' [ARCHIVED]' : ''}`);
        log(`[DUMP_OWNERS] ${lines.length} owners:\n${lines.join('\n')}`);
        await notifySlack(`📋 HubSpot owners list (${lines.length}):\n\`\`\`\n${lines.join('\n')}\n\`\`\``, 'good');
      } catch (e) {
        log(`[DUMP_OWNERS] failed: ${e.status} ${e.data?.message || e.message}`);
      }
    }

    // One-shot bulk owner reassignment. Set FORCE_ASSIGN_TO=<ownerId> on the
    // cron service to push every HubSpot contact onto that owner (used when
    // agents change). Idempotent — once everyone is on the target it's a
    // no-op. Unset the env var when done.
    const FORCE_ASSIGN_TO = (process.env.FORCE_ASSIGN_TO || '').trim();
    if (FORCE_ASSIGN_TO) {
      const fa = await forceAssignAllContacts(FORCE_ASSIGN_TO);
      if (fa.reassigned > 0) {
        await notifySlack(`🔁 Lasso sync — bulk reassigned ${fa.reassigned}/${fa.scanned} contacts to owner ${FORCE_ASSIGN_TO}`, 'good');
      }
    }

    // One-shot bulk SPLIT: divide existing contacts across N owners (round-robin
    // by contact-ID hash, stable across runs). Set SPLIT_BETWEEN=id1,id2[,id3...]
    // on the cron. Idempotent — once split it's a no-op. Unset when done.
    const SPLIT_BETWEEN = (process.env.SPLIT_BETWEEN || '').trim();
    if (SPLIT_BETWEEN) {
      const ids = SPLIT_BETWEEN.split(',').map(s => s.trim()).filter(Boolean);
      if (ids.length >= 2) {
        const sp = await splitContactsBetweenOwners(ids);
        if (sp.reassigned > 0) {
          await notifySlack(`🔀 Lasso sync — split ${sp.reassigned}/${sp.scanned} contacts across ${ids.length} owners`, 'good');
        }
      }
    }

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

    // Diagnostic: check Whop ↔ HubSpot overlap (% of Whop decliners with phone)
    if (process.env.DIAG_WHOP_OVERLAP === '1') {
      try { await diagnoseWhopOverlap(); } catch (e) { log(`[DIAG] error: ${e.message}`); }
    }

    // One-shot cleanup of historical decline imports — triggered by
    // CLEANUP_HISTORICAL_DECLINES=1. Reverts the pre-today-filter mistake
    // where 186 old declines got pushed into HubSpot. Set back to empty
    // when satisfied.
    if (process.env.CLEANUP_HISTORICAL_DECLINES === '1') {
      try {
        const c = await cleanupHistoricalDeclines();
        if (c.cleaned > 0) {
          await notifySlack(`🧹 Cleanup — reverted ${c.cleaned} historical decline contacts`, 'good');
        }
      } catch (e) {
        log(`[CLEANUP] error: ${e.message}`);
      }
    }

    // Whop decline sync — run after Lasso so HubSpot already has fresh
    // Lasso contacts we may want to enrich. Best-effort: a failure here
    // shouldn't block the Lasso run from succeeding.
    try {
      const whop = await syncWhopDeclines();
      if (whop?.synced > 0) {
        await notifySlack(
          `💳 Whop declines → HubSpot — ${whop.synced} new/updated decliners (${whop.skipped || 0} unchanged${whop.failed ? `, ${whop.failed} failed` : ''})`,
          'good'
        );
      }
    } catch (whopErr) {
      log(`[WHOP] sync threw: ${whopErr.message}`);
      await notifySlack(`⚠️ Whop decline sync failed: ${whopErr.message.slice(0, 200)}`, 'warning').catch(() => {});
    }

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
