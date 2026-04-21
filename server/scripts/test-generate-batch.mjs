#!/usr/bin/env node
/**
 * Batch-test the statics-generation pipeline. Runs N generations sequentially
 * (to respect Gemini rate limits) and prints a summary table of pass/fail +
 * every validator error per template.
 *
 * Usage: node server/scripts/test-generate-batch.mjs [N] [startIndex]
 *   N           — how many templates to test (default 5)
 *   startIndex  — which template in the Offer/Sale list to start from (default 0)
 */

import fs from 'fs';

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
const N = parseInt(process.argv[2] || '5', 10);
const START = parseInt(process.argv[3] || '0', 10);

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

async function login() {
  const r = await fetch(`${BASE}/api/v1/auth/login`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ email: EMAIL, password: PASSWORD }),
  });
  if (!r.ok) throw new Error(`Login ${r.status}`);
  return (await r.json()).accessToken;
}

async function pickTemplates(token) {
  const r = await fetch(`${BASE}/api/v1/statics-templates?category=Offer%2FSale&limit=300`, {
    headers: { Authorization: `Bearer ${token}` },
  });
  const data = await r.json();
  const items = data.data || data.templates || data.items || [];
  // Skip test / obviously-synthetic rows
  const clean = items.filter(t =>
    t.name && t.name.length > 5 && !/generated|test|_test/i.test(t.name)
  );
  return clean.slice(START, START + N);
}

async function runOne(token, template) {
  const t0 = Date.now();
  const submitRes = await fetch(`${BASE}/api/v1/statics-generation/generate`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({
      reference_image_url: template.image_url,
      product: PRODUCT,
      angle: 'Offer',
      ratio: '4:5',
      template_id: template.id,
    }),
  });
  const submitData = await submitRes.json();
  const taskId = submitData.data?.taskId;
  if (!taskId) return { error: `no taskId: ${JSON.stringify(submitData)}`, elapsed: Date.now() - t0 };

  // Poll
  for (let i = 0; i < 180; i++) {
    await new Promise(r => setTimeout(r, 5000));
    const s = await fetch(`${BASE}/api/v1/statics-generation/status/${taskId}`, {
      headers: { Authorization: `Bearer ${token}` },
    });
    const sd = await s.json();
    const data = sd.data || {};
    if (data.status === 'completed' || data.status === 'failed') {
      return { ...data, taskId, elapsed: Date.now() - t0 };
    }
  }
  return { error: 'timeout', elapsed: Date.now() - t0 };
}

function formatErrors(v) {
  if (!v || !v.errors) return '(no payload)';
  const parts = [];
  for (const [k, arr] of Object.entries(v.errors)) {
    if (!Array.isArray(arr) || arr.length === 0) continue;
    parts.push(`    ${k}:`);
    for (const e of arr) parts.push(`      - ${typeof e === 'string' ? e : JSON.stringify(e)}`);
  }
  return parts.length > 0 ? parts.join('\n') : '    (none)';
}

async function main() {
  console.log(`\nBatch test: N=${N}, startIndex=${START}\n`);
  const token = await login();
  const templates = await pickTemplates(token);
  console.log(`Picked ${templates.length} templates:\n`);
  templates.forEach((t, i) => console.log(`  [${i}] ${t.id}  ${(t.name || '').slice(0, 70)}`));

  const results = [];
  for (let i = 0; i < templates.length; i++) {
    const tpl = templates[i];
    console.log(`\n${'═'.repeat(78)}\n[${i + 1}/${templates.length}] ${tpl.name?.slice(0, 65)}\n${'═'.repeat(78)}`);
    try {
      const r = await runOne(token, tpl);
      const elapsedSec = (r.elapsed / 1000).toFixed(1);

      if (r.error) {
        console.log(`  ❌ ERROR: ${r.error}  (${elapsedSec}s)`);
        results.push({ tpl, error: r.error, elapsed: r.elapsed });
        continue;
      }

      const v = r.textValidation;
      const status = v?.severity === 'clean' ? '✅ CLEAN'
                   : v?.severity === 'soft'  ? '⚠️  SOFT'
                   : v?.severity === 'hard'  ? '❌ HARD'
                   : '❓ no-v';
      const attempts = v?.attempts ?? '?';
      console.log(`  ${status}  attempts=${attempts}  elapsed=${elapsedSec}s  taskId=${r.taskId}`);
      if (v && (v.severity === 'hard' || v.severity === 'soft')) {
        console.log(formatErrors(v));
      }

      // Download image for later inspection
      if (r.resultImageUrl) {
        try {
          const img = await fetch(r.resultImageUrl);
          if (img.ok) {
            const buf = Buffer.from(await img.arrayBuffer());
            const outPath = `/tmp/batch-${String(i).padStart(2, '0')}-${r.taskId}.png`;
            fs.writeFileSync(outPath, buf);
            console.log(`  saved: ${outPath}`);
          }
        } catch {}
      }

      results.push({ tpl, ...r });
    } catch (err) {
      console.log(`  ❌ EXCEPTION: ${err.message}`);
      results.push({ tpl, error: err.message });
    }
  }

  // Summary
  console.log(`\n${'═'.repeat(78)}\n SUMMARY\n${'═'.repeat(78)}`);
  const clean = results.filter(r => r.textValidation?.severity === 'clean').length;
  const soft  = results.filter(r => r.textValidation?.severity === 'soft').length;
  const hard  = results.filter(r => r.textValidation?.severity === 'hard').length;
  const errs  = results.filter(r => r.error).length;
  console.log(`  Clean:  ${clean} / ${templates.length}`);
  console.log(`  Soft:   ${soft}`);
  console.log(`  Hard:   ${hard}`);
  console.log(`  Errors: ${errs}`);
  console.log();

  // Aggregate error categories across all runs
  const agg = {};
  for (const r of results) {
    const e = r.textValidation?.errors;
    if (!e) continue;
    for (const [k, arr] of Object.entries(e)) {
      if (!Array.isArray(arr) || arr.length === 0) continue;
      agg[k] = (agg[k] || 0) + arr.length;
    }
  }
  if (Object.keys(agg).length > 0) {
    console.log('  Top validator hits across the batch:');
    for (const [k, n] of Object.entries(agg).sort((a, b) => b[1] - a[1])) {
      console.log(`    ${n}×  ${k}`);
    }
  }
}

main().catch(err => { console.error('FATAL:', err.stack || err.message); process.exit(1); });
