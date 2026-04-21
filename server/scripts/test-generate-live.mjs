#!/usr/bin/env node
/**
 * Drive the /api/v1/statics-generation/generate endpoint end-to-end against
 * production so we can observe the P0.4 text-quality validator in action.
 *
 * Usage:
 *   node server/scripts/test-generate-live.mjs [templateIdOrUrl]
 *
 * With no arg: picks the first Offer/Sale template from the library.
 * Prints: submit → poll → final status → textValidation payload → download image to /tmp.
 */

import fs from 'fs';
import path from 'path';

// Load .env
try {
  const content = fs.readFileSync('.env', 'utf8');
  for (const line of content.split('\n')) {
    const t = line.trim();
    if (!t || t.startsWith('#')) continue;
    const eq = t.indexOf('=');
    if (eq < 0) continue;
    const k = t.slice(0, eq).trim();
    const v = t.slice(eq + 1).trim().replace(/^["']|["']$/g, '');
    if (!process.env[k]) process.env[k] = v;
  }
} catch {}

const BASE = process.env.API_BASE || 'https://mineblock-dashboard.onrender.com';
const EMAIL = process.env.SUPERADMIN_EMAIL;
const PASSWORD = process.env.SUPERADMIN_PASSWORD;
if (!EMAIL || !PASSWORD) { console.error('Missing SUPERADMIN_EMAIL / SUPERADMIN_PASSWORD'); process.exit(1); }

const PRODUCT = {
  id: 3,
  name: 'MineBlock Solo Miner',
  price: '$249',
  product_image_url: 'https://images.unsplash.com/photo-1621761191319-c6fb62004040?w=1080',
  profile: {
    shortName: 'MineBlock',
    category: 'Bitcoin solo mining device',
    targetAudience: 'Crypto hobbyists, passive-income seekers, retail miners',
    keyBenefits: [
      'Plug-and-play — no technical setup required',
      'Silent operation — runs in any home office',
      'Low power draw — ~30W from a standard wall outlet',
      'Solo mining — keep 100% of any block reward you find',
    ].join('\n'),
    uniqueSellingPoints: 'Only consumer device that lets you solo-mine Bitcoin without joining a pool',
    painPoints: 'Mining pools take fees; industrial miners are loud/expensive; cloud mining is a scam',
    offerDetails: 'FREE shipping worldwide + 2-year warranty + 30-day money-back guarantee',
    guarantee: '30-day money-back — return it if it doesn\'t mine',
    discountCodes: 'BITCOIN10',
    maxDiscount: '10% off',
    complianceRestrictions: 'Do not guarantee profits; do not claim specific BTC earnings; do not promise "passive income"',
    bundleVariants: '1 unit: $249 | 2-pack: $449 (save $49) | 3-pack: $629 (save $118)',
  },
};

function banner(msg) { console.log('\n' + '═'.repeat(78) + '\n ' + msg + '\n' + '═'.repeat(78)); }

async function main() {
  const explicit = process.argv[2];

  banner('Login');
  const loginRes = await fetch(`${BASE}/api/v1/auth/login`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ email: EMAIL, password: PASSWORD }),
  });
  if (!loginRes.ok) throw new Error(`Login ${loginRes.status}: ${await loginRes.text()}`);
  const { accessToken } = await loginRes.json();
  const AUTH = { Authorization: `Bearer ${accessToken}` };
  console.log('Logged in ✔');

  // Pick a template
  let templateId = null;
  let referenceImageUrl;
  if (explicit?.startsWith('http') || explicit?.startsWith('/')) {
    referenceImageUrl = explicit;
  } else if (explicit) {
    templateId = explicit;
  }

  if (!referenceImageUrl) {
    banner('Pick Offer/Sale template');
    const tplRes = await fetch(`${BASE}/api/v1/statics-templates?category=Offer%2FSale&limit=5`, { headers: AUTH });
    const tplData = await tplRes.json();
    const items = tplData.data || tplData.templates || tplData.items || [];
    if (!items.length) throw new Error('No Offer/Sale templates found');
    // Prefer a mid-complexity one — avoid the generated/aspect-ratio test artifacts
    const pick = items.find(t => t.name && t.name.length > 5) || items[0];
    templateId = pick.id;
    referenceImageUrl = pick.image_url;
    console.log(`Template: ${pick.name} (${pick.id})`);
    console.log(`Image:    ${pick.image_url?.slice(0, 120)}`);
  }

  banner('Submit /generate');
  const t0 = Date.now();
  const submitRes = await fetch(`${BASE}/api/v1/statics-generation/generate`, {
    method: 'POST',
    headers: { ...AUTH, 'Content-Type': 'application/json' },
    body: JSON.stringify({
      reference_image_url: referenceImageUrl,
      product: PRODUCT,
      angle: 'Offer',
      ratio: '4:5',
      template_id: templateId,
    }),
  });
  if (!submitRes.ok) throw new Error(`Submit ${submitRes.status}: ${await submitRes.text()}`);
  const submitData = await submitRes.json();
  const taskId = submitData.data?.taskId;
  if (!taskId) throw new Error(`No taskId in submit response: ${JSON.stringify(submitData)}`);
  console.log(`Submitted ✔  taskId=${taskId}`);

  banner('Poll /status');
  let final = null;
  for (let i = 0; i < 180; i++) { // up to 15 min (5s intervals)
    await new Promise(r => setTimeout(r, 5000));
    const s = await fetch(`${BASE}/api/v1/statics-generation/status/${taskId}`, { headers: AUTH });
    const sd = await s.json();
    const data = sd.data || {};
    const status = data.status;
    const prog = data.progress ? ` — ${data.progress}` : '';
    console.log(`  [${String(i).padStart(3, '0')}  t+${Math.round((Date.now() - t0) / 1000)}s]  ${status}${prog}`);
    if (status === 'completed' || status === 'failed') { final = data; break; }
  }

  if (!final) throw new Error('Timed out waiting for generation');

  banner('Final status');
  console.log(JSON.stringify(final, null, 2));

  if (final.textValidation) {
    banner('Text-QC payload');
    const v = final.textValidation;
    console.log(`  passed:          ${v.passed}`);
    console.log(`  severity:        ${v.severity}`);
    console.log(`  totalErrors:     ${v.totalErrors}`);
    console.log(`  hardErrorCount:  ${v.hardErrorCount}`);
    console.log(`  attempts:        ${v.attempts}`);
    if (v.errors) {
      for (const [k, arr] of Object.entries(v.errors)) {
        if (Array.isArray(arr) && arr.length > 0) {
          console.log(`  ${k}:`);
          for (const e of arr) console.log(`    - ${typeof e === 'string' ? e : JSON.stringify(e)}`);
        }
      }
    }
  } else {
    console.log('\n⚠️  No textValidation payload in response — check status endpoint is forwarding it.');
  }

  if (final.resultImageUrl) {
    banner('Download result to /tmp for inspection');
    const imgRes = await fetch(final.resultImageUrl);
    if (imgRes.ok) {
      const buf = Buffer.from(await imgRes.arrayBuffer());
      const outPath = `/tmp/test-generate-live-${taskId}.png`;
      fs.writeFileSync(outPath, buf);
      console.log(`Saved:  ${outPath}  (${buf.length} bytes)`);
      console.log(`View:   open ${outPath}`);
    }
  }
}

main().catch(err => { console.error('\nFATAL:', err.stack || err.message); process.exit(1); });
